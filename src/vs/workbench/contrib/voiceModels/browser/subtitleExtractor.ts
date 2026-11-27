/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { IResolvedTimedModel, ITimedTranscribeOptions, IVoiceModelService } from '../common/voiceModel.js';
import { distributeSentences, getTimedTranscriptionPlan, ISubtitleSegment, ITimeRange, normalizeSegments, offsetSegments, snapSegmentsToSpeech } from '../common/subtitles.js';
import { ASR_SAMPLE_RATE, detectSpeechRegions, encodeWav16, mixToMono, planChunks, planUtterances, resampleLinear, sliceSamples } from '../common/wavAudio.js';
import { mediaDurationLimitMessage } from '../common/subtitleConfig.js';

/**
 * Subtitle extraction pipeline (CI-45), all in the renderer:
 * media bytes -> Web Audio decode (resampled to 16 kHz mono, no ffmpeg) -> speech detection ->
 * chunks / utterances -> 16-bit WAV per request -> {@link IVoiceModelService.transcribeTimed} -> merged timeline.
 */

export type SubtitleExtractionPhase = 'decoding' | 'analyzing' | 'transcribing' | 'done';

export interface ISubtitleExtractionProgress {
	readonly phase: SubtitleExtractionPhase;
	readonly current?: number;
	readonly total?: number;
	readonly message: string;
}

export interface ISubtitleExtractionOptions extends ITimedTranscribeOptions {
	/** Reject audio longer than this (seconds); 0 / undefined = no limit. */
	readonly maxDurationSeconds?: number;
	/** File name used in messages. */
	readonly mediaName?: string;
}

export interface ISubtitleExtractionResult {
	readonly segments: ISubtitleSegment[];
	readonly duration: number;
	readonly model: IResolvedTimedModel;
}

/**
 * Decodes any media Chromium can play (MP3, AAC in MP4/M4A, WAV, OGG, ...) to 16 kHz mono samples.
 * `decodeAudioData` needs the whole file in memory and takes ownership of (detaches) `data`. Decoding runs off the
 * main thread (a 25 min MP4 decodes in about 2 s without blocking the UI), but Chromium decodes at the file's own
 * rate before resampling, so the peak memory grows with the duration (see `DECODE_PEAK_MB_PER_SECOND`).
 */
export async function decodeAudioTo16kMono(data: ArrayBuffer): Promise<Float32Array> {
	// decodeAudioData resamples to the context rate, so a 16 kHz offline context does the resampling for us.
	const ctx = new OfflineAudioContext(1, 1, ASR_SAMPLE_RATE);
	let buffer: AudioBuffer;
	try {
		buffer = await ctx.decodeAudioData(data);
	} catch (err) {
		throw new Error(`Could not decode the audio track (${(err as Error)?.message || 'unsupported codec'}). Try an MP3, M4A/AAC or MP4 file.`);
	}
	const channels: Float32Array[] = [];
	for (let c = 0; c < buffer.numberOfChannels; c++) {
		channels.push(buffer.getChannelData(c));
	}
	// Mono at 16 kHz is 3.7 MB per minute; the multi-channel buffer is released when this returns
	return resampleLinear(mixToMono(channels), buffer.sampleRate, ASR_SAMPLE_RATE);
}

function throwIfCancelled(token: CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
}

function shiftRanges(ranges: readonly ITimeRange[], window: ITimeRange): ITimeRange[] {
	return ranges
		.filter(r => r.end > window.start && r.start < window.end)
		.map(r => ({ start: Math.max(0, r.start - window.start), end: Math.min(window.end, r.end) - window.start }));
}

export async function extractSubtitles(
	voiceModelService: IVoiceModelService,
	media: Blob | ArrayBuffer,
	options: ISubtitleExtractionOptions,
	onProgress: (p: ISubtitleExtractionProgress) => void,
	token: CancellationToken
): Promise<ISubtitleExtractionResult> {
	const model = await voiceModelService.resolveTimedTranscriptionModel(options);
	if (!model) {
		throw new Error(options.provider ? `Unknown subtitle provider "${options.provider}".` : 'No voice model configured. Choose a provider and model in the component settings or add a voice model in Settings.');
	}
	const plan = getTimedTranscriptionPlan(model.provider, model.modelId);

	onProgress({ phase: 'decoding', message: 'Extracting the audio track (long files take a few seconds)...' });
	const pcm = await decodeAudioTo16kMono(media instanceof ArrayBuffer ? media : await media.arrayBuffer());
	throwIfCancelled(token);
	const duration = pcm.length / ASR_SAMPLE_RATE;
	if (duration <= 0) {
		throw new Error('The file has no audio.');
	}
	if (options.maxDurationSeconds && options.maxDurationSeconds > 0 && duration > options.maxDurationSeconds + 0.5) {
		throw new Error(mediaDurationLimitMessage(options.mediaName || 'The audio', duration, Math.round(options.maxDurationSeconds / 60)));
	}

	onProgress({ phase: 'analyzing', message: 'Detecting speech...' });
	const speech = detectSpeechRegions(pcm, ASR_SAMPLE_RATE);
	if (speech.length === 0) {
		throw new Error('No speech was detected in the audio.');
	}
	const pieces = plan.strategy === 'utterances'
		? planUtterances(speech, duration)
		: planChunks(duration, speech, plan.maxChunkSeconds);

	const all: ISubtitleSegment[] = [];
	for (let i = 0; i < pieces.length; i++) {
		throwIfCancelled(token);
		const piece = pieces[i];
		const label = plan.strategy === 'utterances' ? 'part' : 'chunk';
		onProgress({ phase: 'transcribing', current: i + 1, total: pieces.length, message: `Transcribing ${label} ${i + 1} of ${pieces.length} with ${model.name}...` });
		const wav = encodeWav16(sliceSamples(pcm, ASR_SAMPLE_RATE, piece), ASR_SAMPLE_RATE);
		const blob = new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' });
		const clipSeconds = piece.end - piece.start;
		let res = await voiceModelService.transcribeTimed(blob, clipSeconds, options, token);
		if (res.error) {
			// One retry for transient network / rate-limit errors.
			throwIfCancelled(token);
			res = await voiceModelService.transcribeTimed(blob, clipSeconds, options, token);
		}
		if (res.error) {
			throw new Error(`${label[0].toUpperCase()}${label.slice(1)} ${i + 1} of ${pieces.length} failed: ${res.error}`);
		}
		if (plan.strategy === 'utterances') {
			if (res.text.trim()) {
				all.push(...distributeSentences(res.text, piece, speech));
			}
			continue;
		}
		const localSpeech = shiftRanges(speech, piece);
		let segs = res.segments;
		if (plan.strategy === 'llm-json') {
			segs = snapSegmentsToSpeech(segs, localSpeech, clipSeconds);
		}
		// Long multi-sentence segments (some LLMs return one block) are split at pauses.
		segs = segs.flatMap(s => s.end - s.start > 10 ? distributeSentences(s.text, s, localSpeech) : [s]);
		all.push(...offsetSegments(segs, piece.start));
	}
	const segments = normalizeSegments(all, duration);
	onProgress({ phase: 'done', message: `${segments.length} subtitle lines extracted.` });
	return { segments, duration, model };
}
