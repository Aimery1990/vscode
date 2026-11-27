/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { matchSubtitleDocument, normalizeMediaPath, parseSubtitleDocument } from '../../common/subtitles.js';
import { DICTATION_MODE_LABEL, dictationModeCheckboxText, dictationModeDescription, dictationModeToggleTitle, mediaSubtitlesFileName, SUBTITLE_DISPLAY_MODES } from '../../common/subtitleConfig.js';

suite('Media subtitles - stored subtitles vs the current file (CI-46)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const doc = { mediaName: 'Lesson 1.mp3', mediaPath: '/Users/me/media/Lesson 1.mp3', mediaSize: 1000 };

	test('normalizeMediaPath compares file URIs, Windows and doubled separators as plain paths', () => {
		assert.strictEqual(normalizeMediaPath('file:///Users/me/a%20b.mp3'), '/Users/me/a b.mp3');
		assert.strictEqual(normalizeMediaPath('file:///C:/media/a.mp3'), 'C:/media/a.mp3');
		assert.strictEqual(normalizeMediaPath('C:\\media\\a.mp3'), 'C:/media/a.mp3');
		assert.strictEqual(normalizeMediaPath('/a//b/'), '/a/b');
		assert.strictEqual(normalizeMediaPath('  '), '');
		assert.strictEqual(normalizeMediaPath(undefined), '');
		assert.strictEqual(normalizeMediaPath('file:///bad%E0'), '/bad%E0');
	});

	test('same path and size is current, whatever the display name', () => {
		assert.strictEqual(matchSubtitleDocument(doc, { name: 'Renamed label', path: 'file:///Users/me/media/Lesson%201.mp3', sizeBytes: 1000 }), 'current');
	});

	test('same file name (case-insensitive) is current, also from another folder (copied file)', () => {
		assert.strictEqual(matchSubtitleDocument(doc, { name: 'lesson 1.MP3', path: '/Volumes/usb/Lesson 1.mp3', sizeBytes: 1000 }), 'current');
		assert.strictEqual(matchSubtitleDocument(doc, { path: '/Volumes/usb/Lesson 1.mp3' }), 'current', 'name taken from the path');
	});

	test('unknown sizes do not make subtitles stale', () => {
		assert.strictEqual(matchSubtitleDocument(doc, { name: 'Lesson 1.mp3' }), 'current');
		assert.strictEqual(matchSubtitleDocument({ mediaName: 'Lesson 1.mp3' }, { name: 'Lesson 1.mp3', sizeBytes: 5 }), 'current');
	});

	test('same name or path with another size means the file changed', () => {
		assert.strictEqual(matchSubtitleDocument(doc, { name: 'Lesson 1.mp3', sizeBytes: 2000 }), 'changed');
		assert.strictEqual(matchSubtitleDocument(doc, { path: '/Users/me/media/Lesson 1.mp3', sizeBytes: 999 }), 'changed');
	});

	test('another file is stale', () => {
		assert.strictEqual(matchSubtitleDocument(doc, { name: 'Lesson 2.mp3', path: '/Users/me/media/Lesson 2.mp3', sizeBytes: 1000 }), 'other-file');
		assert.strictEqual(matchSubtitleDocument(doc, {}), 'other-file', 'no file loaded');
		assert.strictEqual(matchSubtitleDocument({ mediaName: '', mediaPath: '/x/a.mp3' }, { name: 'b.mp3' }), 'other-file');
	});

	test('a document without name and path cannot be checked and is trusted', () => {
		assert.strictEqual(matchSubtitleDocument({ mediaName: '' }, { name: 'any.mp3', sizeBytes: 10 }), 'current');
	});

	test('parseSubtitleDocument keeps the media path; older documents have none', () => {
		const withPath = parseSubtitleDocument(JSON.stringify({ version: 1, mediaName: 'a.mp3', mediaPath: '/m/a.mp3', mediaSize: 3, provider: 'openai', model: 'whisper-1', createdAt: 1, segments: [{ start: 0, end: 1, text: 'Hi' }] }));
		assert.strictEqual(withPath?.mediaPath, '/m/a.mp3');
		const legacy = parseSubtitleDocument(JSON.stringify({ version: 1, mediaName: 'a.mp3', provider: 'openai', model: 'whisper-1', createdAt: 1, segments: [] }));
		assert.strictEqual(legacy?.mediaPath, undefined);
	});
});

suite('Media subtitles - Dictation mode wording (CI-46)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the checkbox text names the dictation unit', () => {
		assert.strictEqual(DICTATION_MODE_LABEL, 'Dictation mode');
		assert.strictEqual(dictationModeCheckboxText('segment', 5), 'Stop after each sentence so I can type what I hear');
		assert.strictEqual(dictationModeCheckboxText('seconds', 8), 'Stop after each 8-second part so I can type what I hear');
		assert.strictEqual(dictationModeCheckboxText('seconds', 0), 'Stop after each 1-second part so I can type what I hear');
	});

	test('tooltips explain both states', () => {
		assert.ok(dictationModeDescription('segment', 5).includes('Dictation practice'));
		assert.ok(dictationModeToggleTitle(true, 'segment', 5).startsWith('Dictation mode is on'));
		assert.ok(dictationModeToggleTitle(false, 'seconds', 4).includes('stop after each 4-second part'));
	});

	test('the display option is "Dictation practice", distinct from the "Dictation mode" option', () => {
		assert.deepStrictEqual(SUBTITLE_DISPLAY_MODES.map(m => m.label), ['Single line', 'Scrolling list', 'Dictation practice']);
	});

	test('mediaSubtitlesFileName is the card file name of a field', () => {
		assert.strictEqual(mediaSubtitlesFileName('MP3 / MP4 Player 1'), 'attachments/subtitles_mp3___mp4_player_1.json');
		assert.strictEqual(mediaSubtitlesFileName(''), 'attachments/subtitles_media.json');
	});
});
