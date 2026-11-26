/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { distributeSentences, findLastStartedSegment, splitSentences, findSegmentAt, getTimedTranscriptionPlan, mergeChunkSegments, normalizeSegments, parseSubtitleDocument, parseSubtitleJson, parseTimestamp, snapSegmentsToSpeech, toSrt, toTimedText, toVtt } from '../../common/subtitles.js';
import { buildDictationUnits, diffWords, findUnitAt, normalizeWord } from '../../common/dictation.js';
import { decodeWav16, detectSpeechRegions, encodeWav16, mixToMono, planChunks, planUtterances, resampleLinear } from '../../common/wavAudio.js';

suite('Media subtitles - parsing and timing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parseTimestamp accepts numbers, numeric strings and clock strings', () => {
		assert.strictEqual(parseTimestamp(1.5), 1.5);
		assert.strictEqual(parseTimestamp('2.25'), 2.25);
		assert.strictEqual(parseTimestamp('3s'), 3);
		assert.strictEqual(parseTimestamp('01:02.5'), 62.5);
		assert.strictEqual(parseTimestamp('1:00:01,250'), 3601.25);
		assert.strictEqual(parseTimestamp('abc'), undefined);
		assert.strictEqual(parseTimestamp(-1), undefined);
	});

	test('normalizeSegments repairs order, missing ends, overlaps and variants', () => {
		const segs = normalizeSegments({
			segments: [
				{ start: 5, end: 7, text: ' second   line ' },
				{ begin_time: 0, end_time: 6000, sentence: 'first' },
				{ start: '00:08', text: 'third' },
				{ start: 9, end: 9.5, text: '' },
				{ text: 'no time' }
			]
		}, 10);
		assert.deepStrictEqual(segs, [
			{ start: 0, end: 5, text: 'first' },
			{ start: 5, end: 7, text: 'second line' },
			{ start: 8, end: 9, text: 'third' }
		]);
	});

	test('parseSubtitleJson handles code fences and trailing commas', () => {
		const text = 'Here you go:\n```json\n[{"start": 0.0, "end": 1.68, "text": "Hello."}, {"start": 1.84, "end": 3.5, "text": "Bye."},]\n```';
		assert.deepStrictEqual(parseSubtitleJson(text), [
			{ start: 0, end: 1.68, text: 'Hello.' },
			{ start: 1.84, end: 3.5, text: 'Bye.' }
		]);
		assert.strictEqual(parseSubtitleJson('sorry, no audio'), undefined);
	});

	test('mergeChunkSegments offsets chunks, clamps to chunk length and removes overlaps', () => {
		const merged = mergeChunkSegments([
			{ range: { start: 0, end: 10 }, segments: [{ start: 0, end: 4, text: 'a' }, { start: 8, end: 11, text: 'b' }] },
			{ range: { start: 10, end: 20 }, segments: [{ start: 0.5, end: 3, text: 'c' }] }
		]);
		assert.deepStrictEqual(merged, [
			{ start: 0, end: 4, text: 'a' },
			{ start: 8, end: 10, text: 'b' },
			{ start: 10.5, end: 13, text: 'c' }
		]);
	});

	test('snapSegmentsToSpeech rescales an over-long model timeline and snaps to pauses', () => {
		// Real speech (from ffmpeg silencedetect of a TTS clip) vs. what an omni model returned.
		const speech = [{ start: 0, end: 0.96 }, { start: 1.22, end: 2.85 }, { start: 3.1, end: 4.13 }, { start: 4.38, end: 6.23 }, { start: 6.48, end: 7.29 }, { start: 7.52, end: 8.8 }];
		const model = [{ start: 0, end: 1.68, text: 'A' }, { start: 1.84, end: 3.52, text: 'B' }, { start: 3.76, end: 7.52, text: 'C' }, { start: 7.68, end: 9.92, text: 'D' }];
		const snapped = snapSegmentsToSpeech(model, speech, 8.88);
		assert.deepStrictEqual(snapped.map(s => [s.start, s.end]), [[0, 0.96], [1.22, 2.85], [3.1, 6.23], [6.48, 8.8]]);
	});

	test('distributeSentences places sentence borders in the pauses', () => {
		const speech = [{ start: 0, end: 1.08 }, { start: 1.32, end: 2.01 }, { start: 2.22, end: 4.11 }, { start: 4.32, end: 7.92 }, { start: 8.13, end: 8.79 }];
		const text = 'Bonjour \u00E0 tous, aujourd\'hui nous allons parler de la ville de Paris. C\'est une ville magnifique, avec beaucoup de mus\u00E9es et de caf\u00E9s. Le matin,';
		const segs = distributeSentences(text, { start: 0, end: 8.94 }, speech);
		assert.deepStrictEqual(segs.map(s => [s.start, s.end]), [[0, 4.11], [4.32, 7.92], [8.13, 8.94]]);
		assert.strictEqual(segs[2].text, 'Le matin,');
		assert.deepStrictEqual(distributeSentences('One only', { start: 1, end: 2 }, speech), [{ start: 1, end: 2, text: 'One only' }]);
		assert.deepStrictEqual(splitSentences('Et vous ? Oui. "Bien!" Non'), ['Et vous ?', 'Oui.', '"Bien!"', 'Non']);
	});

	test('find helpers', () => {
		const segs = [{ start: 0, end: 1, text: 'a' }, { start: 2, end: 3, text: 'b' }];
		assert.strictEqual(findSegmentAt(segs, 0.5), 0);
		assert.strictEqual(findSegmentAt(segs, 1.5), -1);
		assert.strictEqual(findSegmentAt(segs, 2), 1);
		assert.strictEqual(findLastStartedSegment(segs, 1.5), 0);
		assert.strictEqual(findLastStartedSegment(segs, -1), -1);
	});

	test('SRT, VTT and timed text export', () => {
		const segs = [{ start: 1.5, end: 3661.042, text: 'Hi' }];
		assert.strictEqual(toSrt(segs), '1\n00:00:01,500 --> 01:01:01,042\nHi\n');
		assert.strictEqual(toVtt(segs), 'WEBVTT\n\n00:00:01.500 --> 01:01:01.042\nHi\n');
		assert.strictEqual(toTimedText([{ start: 61.25, end: 63, text: 'x' }]), '[1:01.2 - 1:03.0] x');
	});

	test('parseSubtitleDocument round-trips', () => {
		const doc = parseSubtitleDocument(JSON.stringify({ version: 1, mediaName: 'a.mp3', provider: 'aliyun', model: 'm', createdAt: 5, segments: [{ start: 0, end: 1, text: 'x' }] }));
		assert.strictEqual(doc?.mediaName, 'a.mp3');
		assert.deepStrictEqual(doc?.segments, [{ start: 0, end: 1, text: 'x' }]);
		assert.strictEqual(parseSubtitleDocument('nope'), undefined);
	});

	test('timed transcription plan per provider', () => {
		assert.strictEqual(getTimedTranscriptionPlan('openai', 'whisper-1').strategy, 'native');
		assert.strictEqual(getTimedTranscriptionPlan('openai', 'gpt-4o-transcribe').strategy, 'utterances');
		assert.strictEqual(getTimedTranscriptionPlan('aliyun', 'qwen3-asr-flash-us').strategy, 'utterances');
		assert.strictEqual(getTimedTranscriptionPlan('aliyun', 'qwen3.8-omni-flash').strategy, 'llm-json');
		assert.strictEqual(getTimedTranscriptionPlan('gemini', 'gemini-2.5-flash').strategy, 'llm-json');
		assert.strictEqual(getTimedTranscriptionPlan('custom', 'x').strategy, 'native');
	});
});

suite('Media subtitles - audio helpers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function tone(seconds: number, rate: number, amp: number): Float32Array {
		const out = new Float32Array(Math.round(seconds * rate));
		for (let i = 0; i < out.length; i++) {
			out[i] = amp * Math.sin(2 * Math.PI * 220 * i / rate);
		}
		return out;
	}

	function concat(...parts: Float32Array[]): Float32Array {
		const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
		let o = 0;
		for (const p of parts) {
			out.set(p, o);
			o += p.length;
		}
		return out;
	}

	test('WAV encode / decode round trip', () => {
		const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
		const wav = encodeWav16(samples, 16000);
		assert.strictEqual(wav.length, 44 + 10);
		assert.strictEqual(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF');
		const decoded = decodeWav16(wav);
		assert.strictEqual(decoded?.sampleRate, 16000);
		assert.deepStrictEqual(Array.from(decoded!.samples).map(v => Math.round(v * 100) / 100), [0, 0.5, -0.5, 1, -1]);
		assert.strictEqual(decodeWav16(new Uint8Array(10)), undefined);
	});

	test('mixToMono and resampleLinear', () => {
		assert.deepStrictEqual(Array.from(mixToMono([new Float32Array([1, 0]), new Float32Array([0, 0])])), [0.5, 0]);
		const r = resampleLinear(new Float32Array(48000), 48000, 16000);
		assert.strictEqual(r.length, 16000);
	});

	test('detectSpeechRegions finds tones separated by silence', () => {
		const rate = 16000;
		const s = concat(new Float32Array(rate / 2), tone(1, rate, 0.4), new Float32Array(rate), tone(0.5, rate, 0.4), new Float32Array(rate / 2));
		const regions = detectSpeechRegions(s, rate);
		assert.strictEqual(regions.length, 2);
		assert.ok(Math.abs(regions[0].start - 0.5) < 0.05 && Math.abs(regions[0].end - 1.5) < 0.05, JSON.stringify(regions));
		assert.ok(Math.abs(regions[1].start - 2.5) < 0.05 && Math.abs(regions[1].end - 3) < 0.05, JSON.stringify(regions));
		assert.deepStrictEqual(detectSpeechRegions(new Float32Array(rate), rate), []);
	});

	test('planChunks cuts in pauses and respects the maximum', () => {
		const speech = [{ start: 0, end: 50 }, { start: 52, end: 110 }, { start: 111, end: 200 }];
		const chunks = planChunks(200, speech, 120);
		assert.deepStrictEqual(chunks, [{ start: 0, end: 110.5 }, { start: 110.5, end: 200 }]);
		assert.deepStrictEqual(planChunks(30, [], 120), [{ start: 0, end: 30 }]);
		const hard = planChunks(250, [], 100);
		assert.deepStrictEqual(hard.map(c => c.end), [100, 200, 250]);
	});

	test('planUtterances groups short pauses and splits long speech', () => {
		const speech = [{ start: 1, end: 2 }, { start: 2.2, end: 3 }, { start: 4, end: 5 }, { start: 6, end: 31 }];
		const u = planUtterances(speech, 40, { paddingSeconds: 0, pauseSeconds: 0.45, maxSeconds: 12 });
		assert.deepStrictEqual(u, [{ start: 1, end: 3 }, { start: 4, end: 5 }, { start: 6, end: 14.333 }, { start: 14.333, end: 22.667 }, { start: 22.667, end: 31 }]);
	});
});

suite('Media subtitles - dictation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const segs = [{ start: 0, end: 2, text: 'Hello world.' }, { start: 2.5, end: 4, text: 'Bonjour l\u2019ami' }];

	test('segment units', () => {
		const units = buildDictationUnits(segs, 'segment', 0, 5);
		assert.deepStrictEqual(units.map(u => [u.key, u.reference]), [['seg@0.00', 'Hello world.'], ['seg@2.50', 'Bonjour l\u2019ami']]);
	});

	test('fixed seconds units cover the whole media, minimum 1 s', () => {
		const units = buildDictationUnits(segs, 'seconds', 0.2, 5);
		assert.strictEqual(units.length, 5);
		assert.strictEqual(units[0].key, 's1@0.00');
		assert.strictEqual(units.map(u => u.reference).join(' ').replace(/\s+/g, ' ').trim(), 'Hello world. Bonjour l\u2019ami');
		const two = buildDictationUnits(segs, 'seconds', 2, 5);
		assert.deepStrictEqual(two.map(u => [u.start, u.end]), [[0, 2], [2, 4], [4, 5]]);
		assert.strictEqual(two[0].reference, 'Hello world.');
		assert.strictEqual(findUnitAt(two, 2.1), 1);
		assert.strictEqual(findUnitAt(two, 99), 2);
	});

	test('normalizeWord keeps accents and unifies apostrophes', () => {
		assert.strictEqual(normalizeWord('L\u2019Ami,'), 'l\'ami');
		assert.strictEqual(normalizeWord('\u00C9t\u00E9!'), '\u00E9t\u00E9');
	});

	test('diffWords reports correct, wrong, missing and extra words', () => {
		const r = diffWords('The cat sat on the mat.', 'the dog sat on mat really');
		assert.deepStrictEqual(r.ops.map(o => o.kind), ['correct', 'wrong', 'correct', 'correct', 'missing', 'correct', 'extra']);
		assert.strictEqual(r.correct, 4);
		assert.strictEqual(r.total, 6);
		assert.strictEqual(r.score, 4 / 6);
		assert.strictEqual(diffWords('', '').score, 1);
		assert.strictEqual(diffWords('Bonjour l\u2019ami', 'bonjour l\'ami').score, 1);
	});
});
