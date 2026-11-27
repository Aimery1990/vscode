/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { listenStream } from '../../../../base/common/stream.js';
import { URI } from '../../../../base/common/uri.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IVoiceModelService } from '../common/voiceModel.js';
import { ISubtitleDocument, parseSubtitleDocument } from '../common/subtitles.js';
import { checkMediaLimits, describeMediaFacts, estimateDecodePeakMb, formatMediaDuration, formatMediaSize, IMediaSubtitlesConfig, LARGE_DECODE_WARN_SECONDS, MEDIA_BYTES_PER_MB, mediaDurationLimitMessage, mediaSizeLimitMessage, mediaSubtitlesFileName } from '../common/subtitleConfig.js';
import { extractSubtitles } from './subtitleExtractor.js';

/**
 * One subtitle extraction of a media file, shared by the card panel, the component settings dialog and the ticket
 * run (CI-46): read the file (size limit checked first), decode + transcribe with {@link extractSubtitles}, and
 * store the result as the ticket's `attachments/subtitles_<field>.json`.
 */

/** The media file to extract from. */
export interface IMediaSubtitleSource {
	/** File name shown in messages and stored in the document. */
	readonly name: string;
	/** Local path or `file://` URI; a relative path is resolved against `baseFolder` of the job. */
	readonly path?: string;
	/** In-memory copy (a file dropped without a path). */
	readonly blobUrl?: string;
	/** Duration known from a player, so a too long file is refused before it is read. */
	readonly durationSec?: number;
}

/** Progress of a job: percent 0..100 and a sentence for the user. */
export type MediaSubtitleProgress = (percent: number, message: string) => void;

/** Where a settings dialog stores the subtitles it extracts (the ticket of the card); see `mediaSubtitleSettings`. */
export interface IMediaSubtitleStore {
	/** The subtitles currently stored for this field, if any. */
	load(): Promise<ISubtitleDocument | undefined>;
	/** Saves a new extraction (file + field value) so the ticket card shows it at once. */
	save(doc: ISubtitleDocument): Promise<void>;
	/** Number of saved dictation answers (for the re-extract confirmation). */
	answerCount(): number;
	/** True while the card itself is extracting. */
	isBusy(): boolean;
}

/** `file://...` -> URI; absolute path -> file URI; relative path -> under `baseFolder` (else undefined). */
export function resolveMediaUri(path: string | undefined, baseFolder: URI | undefined): URI | undefined {
	const p = (path || '').trim();
	if (!p) {
		return undefined;
	}
	if (/^file:\/\//i.test(p)) {
		return URI.parse(p);
	}
	if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')) {
		return URI.file(p);
	}
	return baseFolder ? URI.joinPath(baseFolder, ...p.split(/[\\/]+/).filter(Boolean)) : undefined;
}

async function readFileWithProgress(fileService: IFileService, uri: URI, size: number, onProgress: MediaSubtitleProgress, token: CancellationToken): Promise<ArrayBuffer> {
	const target = new Uint8Array(size);
	const total = formatMediaSize(size);
	let offset = 0;
	let shownPercent = -1;
	const stream = await fileService.readFileStream(uri, undefined, token);
	const cancelled = new DisposableStore();
	try {
		await new Promise<void>((resolve, reject) => {
			cancelled.add(token.onCancellationRequested(() => reject(new CancellationError())));
			listenStream(stream.value, {
				onData: chunk => {
					if (offset + chunk.byteLength > target.byteLength) {
						reject(new Error(`"${uri.path.split('/').pop()}" changed while it was being read. Try again.`));
						return;
					}
					target.set(chunk.buffer, offset);
					offset += chunk.byteLength;
					const percent = size > 0 ? Math.floor(offset * 100 / size) : 100;
					if (percent !== shownPercent) {
						shownPercent = percent;
						// Reading is the first 5 % of the bar
						onProgress(percent * 0.05, `Reading the media file: ${formatMediaSize(offset)} of ${total}...`);
					}
				},
				onError: reject,
				onEnd: () => resolve()
			}, token);
		});
	} finally {
		cancelled.dispose();
	}
	return offset === size ? target.buffer : target.slice(0, offset).buffer;
}

/**
 * Reads the media bytes into one buffer (handed to the decoder without another copy). The size comes from the
 * file's stat, so a file over the limit is refused before anything is read.
 */
export async function readMediaForSubtitles(fileService: IFileService, src: IMediaSubtitleSource, maxUploadMb: number, baseFolder: URI | undefined, onProgress: MediaSubtitleProgress, token: CancellationToken): Promise<{ data: ArrayBuffer; size: number; uri?: URI }> {
	const maxMb = Math.max(1, maxUploadMb);
	const uri = resolveMediaUri(src.path, baseFolder);
	if (uri && await fileService.exists(uri)) {
		const stat = await fileService.stat(uri);
		if (stat.size > maxMb * MEDIA_BYTES_PER_MB) {
			throw new Error(mediaSizeLimitMessage(src.name, stat.size, maxMb));
		}
		return { data: await readFileWithProgress(fileService, uri, stat.size, onProgress, token), size: stat.size, uri };
	}
	if (src.blobUrl) {
		const blob = await (await fetch(src.blobUrl)).blob();
		if (blob.size > maxMb * MEDIA_BYTES_PER_MB) {
			throw new Error(mediaSizeLimitMessage(src.name, blob.size, maxMb));
		}
		return { data: await blob.arrayBuffer(), size: blob.size };
	}
	throw new Error(src.path ? `Cannot read "${src.name}": the file was not found at ${src.path}. Select the file again.` : `Cannot read "${src.name}". Select the file again.`);
}

/**
 * Extracts the subtitles of `src` with `config` (provider, model, language, limits) and returns the document to store.
 * Throws a user-facing error on a refused limit, a model error or no speech; a `CancellationError` when cancelled.
 */
export async function extractMediaSubtitleDocument(
	voiceModelService: IVoiceModelService,
	fileService: IFileService,
	src: IMediaSubtitleSource,
	config: IMediaSubtitlesConfig,
	baseFolder: URI | undefined,
	onProgress: MediaSubtitleProgress,
	token: CancellationToken
): Promise<ISubtitleDocument> {
	// The player may already know the duration: refuse too long media before reading and decoding it
	if (src.durationSec && checkMediaLimits(config, { durationSec: src.durationSec }).durationExceeded) {
		throw new Error(mediaDurationLimitMessage(src.name, src.durationSec, config.maxDurationMin));
	}
	onProgress(0, 'Reading the media file...');
	const { data, size, uri } = await readMediaForSubtitles(fileService, src, config.maxUploadMb, baseFolder, onProgress, token);
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
	onProgress(5, `Extracting the audio track of ${describeMediaFacts({ sizeBytes: size, durationSec: src.durationSec }) || src.name} (long files take a few seconds)...`);
	const result = await extractSubtitles(voiceModelService, data, {
		provider: config.provider || undefined,
		modelId: config.model || undefined,
		language: config.language || undefined,
		maxDurationSeconds: config.maxDurationMin > 0 ? config.maxDurationMin * 60 : undefined,
		mediaName: src.name
	}, p => {
		if (p.phase === 'decoding') {
			return;
		}
		const pct = p.phase === 'analyzing' ? 10 : p.phase === 'done' ? 100 : 10 + 90 * ((p.current ?? 1) - 1) / Math.max(1, p.total ?? 1);
		onProgress(pct, p.message);
	}, token);
	if (result.segments.length === 0) {
		throw new Error('The model returned no subtitles for this audio.');
	}
	return {
		version: 1,
		mediaName: src.name,
		mediaPath: uri ? uri.fsPath : undefined,
		mediaSize: size,
		duration: Math.round(result.duration * 1000) / 1000,
		provider: result.model.provider,
		model: result.model.modelId,
		language: config.language || undefined,
		createdAt: Date.now(),
		segments: result.segments
	};
}

/** Writes the document as the field's `attachments/subtitles_<field>.json` in the ticket and returns that relative path. */
export async function writeMediaSubtitleDocument(fileService: IFileService, ticketFolder: URI, fieldKey: string, doc: ISubtitleDocument): Promise<string> {
	const rel = mediaSubtitlesFileName(fieldKey);
	await fileService.writeFile(URI.joinPath(ticketFolder, rel), VSBuffer.fromString(JSON.stringify(doc, undefined, '\t')));
	return rel;
}

/** Reads a stored subtitles document; undefined when the file is missing or not a subtitles document. */
export async function readMediaSubtitleDocument(fileService: IFileService, ticketFolder: URI, rel: string | undefined): Promise<ISubtitleDocument | undefined> {
	if (!rel) {
		return undefined;
	}
	const uri = URI.joinPath(ticketFolder, rel);
	if (!(await fileService.exists(uri))) {
		return undefined;
	}
	const content = await fileService.readFile(uri);
	return parseSubtitleDocument(content.value.toString());
}

/** The card's confirmation before replacing existing subtitles (dictation answers are kept). */
export async function confirmSubtitleReextract(dialogService: IDialogService, answerCount: number): Promise<boolean> {
	const { confirmed } = await dialogService.confirm({
		type: answerCount > 0 ? 'warning' : 'question',
		message: 'Extract the subtitles again?',
		detail: answerCount > 0
			? `The current subtitles will be replaced. You have ${answerCount} saved dictation answer(s); they are kept, but they are keyed by the old timings and may no longer line up with the new subtitles.`
			: 'The current subtitles will be replaced.',
		primaryButton: 'Extract Again'
	});
	return confirmed;
}

/** Asks before decoding very long audio (high peak memory); true when it is short enough or the user agrees. */
export async function confirmLargeMediaDecode(dialogService: IDialogService, durationSec: number | undefined, config: IMediaSubtitlesConfig): Promise<boolean> {
	if (!durationSec || durationSec <= LARGE_DECODE_WARN_SECONDS || checkMediaLimits(config, { durationSec }).durationExceeded) {
		return true;
	}
	const peakGb = (estimateDecodePeakMb(durationSec) / 1024).toFixed(1);
	const { confirmed } = await dialogService.confirm({
		type: 'warning',
		message: `Extract subtitles from ${formatMediaDuration(durationSec)} of audio?`,
		detail: `The audio track is decoded in the app, which for a long file temporarily needs up to about ${peakGb} GB of memory (48 kHz stereo; less for mono or lower quality audio). If the computer runs low on memory the window can become slow or close. A shorter part, or the audio exported as a mono 16 kHz M4A / MP3, needs much less.`,
		primaryButton: 'Extract'
	});
	return confirmed;
}
