/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { checkMediaLimits, describeMediaFacts, estimateDecodePeakMb, formatMediaDuration, formatMediaSize, MEDIA_BYTES_PER_MB, mediaDurationLimitMessage, mediaSizeLimitMessage, resolveMediaSubtitlesConfig } from '../../common/subtitleConfig.js';

suite('Media subtitles - file size and duration limits', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('formatMediaSize uses the MB of the limit', () => {
		assert.strictEqual(formatMediaSize(200694273), '191.4 MB');
		assert.strictEqual(formatMediaSize(200 * MEDIA_BYTES_PER_MB), '200.0 MB');
		assert.strictEqual(formatMediaSize(0.25 * MEDIA_BYTES_PER_MB), '0.3 MB');
		assert.strictEqual(formatMediaSize(2048), '2 KB');
		assert.strictEqual(formatMediaSize(1.5 * 1024 * MEDIA_BYTES_PER_MB), '1.50 GB');
		assert.strictEqual(formatMediaSize(0), '0.0 MB');
		assert.strictEqual(formatMediaSize(Number.NaN), '0 MB');
	});

	test('formatMediaDuration is a clock with hours when needed', () => {
		assert.strictEqual(formatMediaDuration(1506), '25:06');
		assert.strictEqual(formatMediaDuration(59.6), '1:00');
		assert.strictEqual(formatMediaDuration(3723), '1:02:03');
		assert.strictEqual(formatMediaDuration(5), '0:05');
		assert.strictEqual(formatMediaDuration(-3), '0:00');
		assert.strictEqual(formatMediaDuration(Number.POSITIVE_INFINITY), '0:00');
	});

	test('describeMediaFacts lists what is known', () => {
		assert.strictEqual(describeMediaFacts({ sizeBytes: 200694273, durationSec: 1506 }), '191.4 MB, 25:06');
		assert.strictEqual(describeMediaFacts({ sizeBytes: 200694273 }), '191.4 MB');
		assert.strictEqual(describeMediaFacts({ durationSec: 1506 }), '25:06');
		assert.strictEqual(describeMediaFacts({ durationSec: Number.NaN }), '');
		assert.strictEqual(describeMediaFacts(undefined), '');
	});

	test('checkMediaLimits compares size with MB and duration with minutes (0 = no limit)', () => {
		const defaults = resolveMediaSubtitlesConfig({});
		assert.strictEqual(defaults.maxUploadMb, 200);
		assert.strictEqual(defaults.maxDurationMin, 0);
		// A 25 min video of 191.4 MB fits the default limits
		assert.deepStrictEqual(checkMediaLimits(defaults, { sizeBytes: 200694273, durationSec: 1506 }), { sizeExceeded: false, durationExceeded: false });
		assert.deepStrictEqual(checkMediaLimits(defaults, { sizeBytes: 200 * MEDIA_BYTES_PER_MB + 1 }), { sizeExceeded: true, durationExceeded: false });
		assert.deepStrictEqual(checkMediaLimits(defaults, { sizeBytes: 200 * MEDIA_BYTES_PER_MB }), { sizeExceeded: false, durationExceeded: false });
		// Duration: limit in minutes with half a second of tolerance
		const limited = { maxUploadMb: 200, maxDurationMin: 20 };
		assert.strictEqual(checkMediaLimits(limited, { durationSec: 1506 }).durationExceeded, true);
		assert.strictEqual(checkMediaLimits(limited, { durationSec: 1200.4 }).durationExceeded, false);
		assert.strictEqual(checkMediaLimits(limited, { durationSec: 1201 }).durationExceeded, true);
		// Unknown facts never exceed
		assert.deepStrictEqual(checkMediaLimits(limited, undefined), { sizeExceeded: false, durationExceeded: false });
		assert.deepStrictEqual(checkMediaLimits(limited, { sizeBytes: Number.NaN, durationSec: 0 }), { sizeExceeded: false, durationExceeded: false });
	});

	test('limit messages state both values', () => {
		const size = mediaSizeLimitMessage('talk.mp4', 250 * MEDIA_BYTES_PER_MB, 200);
		assert.ok(size.includes('"talk.mp4" is 250.0 MB'), size);
		assert.ok(size.includes('200 MB limit'), size);
		const duration = mediaDurationLimitMessage('talk.mp4', 1506, 20);
		assert.ok(duration.includes('"talk.mp4" is 25:06 long'), duration);
		assert.ok(duration.includes('20 min (20:00) limit'), duration);
	});

	test('estimateDecodePeakMb uses the measured worst case', () => {
		// 25 min of 48 kHz stereo AAC peaked at about 3.4 GB in Electron
		assert.strictEqual(estimateDecodePeakMb(1506), 3464);
		assert.strictEqual(estimateDecodePeakMb(0), 0);
		assert.strictEqual(estimateDecodePeakMb(Number.NaN), 0);
	});
});
