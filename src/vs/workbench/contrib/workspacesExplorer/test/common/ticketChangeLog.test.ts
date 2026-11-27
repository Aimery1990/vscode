/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	computeTicketLineDiff, diffTicketFieldMaps, extractTicketFields, ITicketChangeRecord, normalizeTicketFieldValue, parseTicketChangeRecords,
	planTicketFieldChange, renderTicketChangeEntry, replaceWorklogMdSummaryBlock, sanitizeTicketMedia, stripTicketUiState, summarizeTicketListChange,
	TICKET_CHANGE_DIFF_MAX_LINES, TicketChangeCoalescer, ticketChangeRecordMatchesField, ticketFieldSourceOf,
	ticketFieldValuesEqual, ticketTextStats, toTicketChangeActor
} from '../../common/ticketChangeLog.js';
import {
	findTicketFieldVersionByHash, isTicketFieldVersionRelativePath, parseTicketFieldVersionFileName, sanitizeTicketFieldKey,
	ticketFieldCurrentValueUri, ticketFieldVersionFileName, ticketFieldVersionRelativePath, ticketFieldVersionsDir
} from '../../common/ticketFieldStore.js';

const TICKET_MD = [
	'# T-1',
	'',
	'## Overview',
	'',
	'- **Workspace ID**: WS-0000',
	'- **Ticket ID**: WS-0001',
	'',
	'### Profile Data',
	'- **Created By**: User',
	'- **Last Updated At**: 2026-11-27 10:00',
	'',
	'### Self Defined Data (If any)',
	'- **Self Defined Data Structure**: .agents/entity_type/task.yaml',
	'- **Self Defined Data Value**:',
	'  - **Notes**: first line',
	'second line',
	'  - **Education**: [{"key":"LU","degree":"BSc"}]',
	'  - **Card**:',
	'    - **school**: LU',
	'',
	'- **Current AI Agent**: Coder',
	'- **Status**: Todo',
	'- **Priority**: Medium',
	'- **Labels**: bug, ui',
	'- **Parent Path**: .',
	'',
	'### Link',
	'- **Link To**: WS-0002,WS-0003',
	'- **Linked By**: None',
	''
].join('\n');

const AT = new Date('2026-11-27T15:00:00Z');

suite('ticketChangeLog', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('extracts standard and custom fields of ticket.md', () => {
		const f = extractTicketFields('ticket.md', TICKET_MD);
		assert.strictEqual(f.get('status')?.value, 'Todo');
		assert.strictEqual(f.get('priority')?.value, 'Medium');
		assert.strictEqual(f.get('labels')?.value, 'bug, ui');
		assert.strictEqual(f.get('current_ai_agent')?.value, 'Coder');
		assert.strictEqual(f.get('link_to')?.value, 'WS-0002,WS-0003');
		assert.strictEqual(f.get('custom:Notes')?.value, 'first line\nsecond line');
		assert.strictEqual(f.get('custom:Notes')?.label, 'Notes');
		assert.strictEqual(f.get('custom:Education')?.value, '[{"key":"LU","degree":"BSc"}]');
		assert.strictEqual(f.get('custom:Card')?.value, '- **school**: LU');
		// metadata that is not a tracked field
		assert.strictEqual(f.has('custom:Self Defined Data Structure'), false);
		assert.strictEqual([...f.keys()].some(k => k.includes('Created By') || k.includes('Linked By')), false);
	});

	test('extracts README and instruction fields, with multi-line values', () => {
		const readme = '# T\n\n- **Title**: Hello\n- **Description**: line 1\nline 2\n- **Parent Path**: .\n';
		const r = extractTicketFields('README.md', readme);
		assert.strictEqual(r.get('title')?.value, 'Hello');
		assert.strictEqual(r.get('description')?.value, 'line 1\nline 2');
		const inst = extractTicketFields('instruction.md', '# I\n\n- **Ticket Type Prompt**: x\n- **Ticket Prompt**: Be brief.\n- **Parent Path**: .\n');
		assert.deepStrictEqual([...inst.values()].map(v => [v.id, v.value]), [['ticket_prompt', 'Be brief.']]);
		assert.strictEqual(ticketFieldSourceOf('readme.md'), 'README.md');
		assert.strictEqual(ticketFieldSourceOf('worklog.md'), undefined);
	});

	test('re-serialization noise is not a change', () => {
		assert.ok(ticketFieldValuesEqual('description', 'a\r\nb  c', 'a b c'));
		assert.ok(ticketFieldValuesEqual('ticket_prompt', 'None', ''));
		assert.ok(ticketFieldValuesEqual('custom:X', '{"a": 1, "b": [1, 2]}', '{"b":[1,2],"a":1}'));
		assert.ok(ticketFieldValuesEqual('labels', 'bug,  ui', 'bug, ui'));
		assert.ok(ticketFieldValuesEqual('link_to', 'A,B', 'A, B'));
		assert.ok(!ticketFieldValuesEqual('status', 'Todo', 'Done'));
		assert.strictEqual(normalizeTicketFieldValue('title', ' `Hi` '), 'Hi');

		const reserialized = TICKET_MD.replace('  - **Notes**: first line\nsecond line', '  - **Notes**: first line second line').replace('[{"key":"LU","degree":"BSc"}]', '[{"degree": "BSc", "key": "LU"}]');
		assert.deepStrictEqual(diffTicketFieldMaps(extractTicketFields('ticket.md', TICKET_MD), extractTicketFields('ticket.md', reserialized)), []);
	});

	test('diff of field maps: changed, added and removed fields', () => {
		const next = TICKET_MD.replace('- **Status**: Todo', '- **Status**: Done').replace('  - **Notes**: first line\nsecond line\n', '').replace('- **Labels**: bug, ui', '- **Labels**: bug');
		const changes = diffTicketFieldMaps(extractTicketFields('ticket.md', TICKET_MD), extractTicketFields('ticket.md', next));
		assert.deepStrictEqual(changes.map(c => [c.field, c.oldValue, c.newValue]).sort((a, b) => a[0].localeCompare(b[0])), [
			['custom:Notes', 'first line\nsecond line', ''],
			['labels', 'bug, ui', 'bug'],
			['status', 'Todo', 'Done'],
		]);
	});

	test('pure UI state of media player / TTS / voice note values is not a change', () => {
		const fields = (value: string) => new Map([['custom:Player', { id: 'custom:Player', value, label: 'Player', source: 'ticket.md' as const }]]);
		const media = (extra: Record<string, unknown>) => JSON.stringify({
			mediaFilePath: 'attachments/a.mp3', mediaFileName: 'a.mp3', mediaKind: 'audio', mediaMimeType: 'audio/mpeg', mediaPlaybackRate: 1, mediaAutoPlay: false,
			subtitlesFile: 'attachments/subtitles_player.json', subtitleDisplayMode: 'single', dictationUnit: 'segment', dictationAutoPause: true,
			dictation: { s1: { text: 'hello', correct: 1, total: 2, score: 0.5, at: 1000 } },
			...extra
		});

		// Speed menu, display mode toggle and re-checking the same answer: no change at all.
		const onlyUi = media({ mediaPlaybackRate: 1.5, subtitleDisplayMode: 'dictation', dictation: { s1: { text: 'hello', correct: 1, total: 2, score: 0.5, at: 2000 } } });
		assert.deepStrictEqual(diffTicketFieldMaps(fields(media({})), fields(onlyUi)), []);
		assert.ok(ticketFieldValuesEqual('custom:Player', media({}), onlyUi));

		// A real change together with UI state: recorded, without the UI state keys.
		const real = media({ mediaPlaybackRate: 2, dictation: { s1: { text: 'hello world', correct: 2, total: 2, score: 1, at: 3000 } } });
		const changes = diffTicketFieldMaps(fields(media({})), fields(real));
		assert.strictEqual(changes.length, 1);
		for (const v of [changes[0].oldValue, changes[0].newValue]) {
			const o = JSON.parse(v);
			assert.strictEqual(o.mediaPlaybackRate, undefined);
			assert.strictEqual(o.subtitleDisplayMode, undefined);
			assert.strictEqual(o.dictation.s1.at, undefined);
			assert.strictEqual(o.mediaFilePath, 'attachments/a.mp3');
			assert.strictEqual(o.dictationAutoPause, true);
		}
		assert.strictEqual(JSON.parse(changes[0].newValue).dictation.s1.text, 'hello world');

		// User settings of the player stay logged.
		assert.strictEqual(diffTicketFieldMaps(fields(media({})), fields(media({ mediaAutoPlay: true }))).length, 1);
		assert.strictEqual(diffTicketFieldMaps(fields(media({})), fields(media({ dictationAutoPause: false }))).length, 1);

		// TTS: speed and the "Show AI Section" expand state are UI state; the voice is not.
		const tts = (extra: Record<string, unknown>) => JSON.stringify({ text: 'Hi', ttsFormat: 'mp3', ttsVoice: 'Kore', ttsPlaybackRate: 1, ttsShowSpeechTextInTicket: false, ...extra });
		assert.deepStrictEqual(diffTicketFieldMaps(fields(tts({})), fields(tts({ ttsPlaybackRate: 1.25, ttsShowSpeechTextInTicket: true }))), []);
		assert.strictEqual(diffTicketFieldMaps(fields(tts({})), fields(tts({ ttsVoice: 'Puck' }))).length, 1);

		// Voice note: playback speed only.
		const voice = (extra: Record<string, unknown>) => JSON.stringify({ voiceClips: [], voiceTranscript: 't', voicePlaybackRate: 1, ...extra });
		assert.deepStrictEqual(diffTicketFieldMaps(fields(voice({})), fields(voice({ voicePlaybackRate: 2 }))), []);
		assert.strictEqual(diffTicketFieldMaps(fields(voice({})), fields(voice({ voiceTranscript: 'u' }))).length, 1);

		// Other values (no component signature, plain text) are left alone.
		const other = JSON.stringify({ mediaPlaybackRate: 1, note: 'x' });
		assert.strictEqual(stripTicketUiState(other), other);
		assert.strictEqual(stripTicketUiState('plain text'), 'plain text');
		assert.ok(!ticketFieldValuesEqual('custom:X', other, JSON.stringify({ mediaPlaybackRate: 2, note: 'x' })));
	});

	test('small values are recorded inline', () => {
		const p = planTicketFieldChange({ field: 'status', label: 'Status', source: 'ticket.md', oldValue: 'Todo', newValue: 'Done' }, { kind: 'User' }, AT);
		assert.strictEqual(p.record.kind, 'inline');
		assert.strictEqual(p.record.old, 'Todo');
		assert.strictEqual(p.record.new, 'Done');
		assert.strictEqual(p.record.actor, 'User');
		assert.strictEqual(p.record.at, AT.toISOString());
		assert.deepStrictEqual(p.blobs, {});
	});

	test('large text: stats, truncated diff and full versions', () => {
		const oldText = Array.from({ length: 200 }, (_, i) => `Line ${i} of the old text.`).join('\n');
		const newText = Array.from({ length: 200 }, (_, i) => i % 2 ? `Line ${i} rewritten.` : `Line ${i} of the old text.`).join('\n');
		const p = planTicketFieldChange({ field: 'description', label: 'Description', source: 'README.md', oldValue: oldText, newValue: newText }, { kind: 'AI Agent', name: 'Coder' }, AT);
		assert.strictEqual(p.record.kind, 'diff');
		assert.strictEqual(p.record.actorName, 'Coder');
		assert.strictEqual(p.record.diffTruncated, true);
		assert.ok(p.record.diff!.includes('… truncated'));
		assert.ok(p.record.diff!.split('\n').length <= TICKET_CHANGE_DIFF_MAX_LINES + 1);
		assert.strictEqual(p.record.linesAdded, 100);
		assert.strictEqual(p.record.linesRemoved, 100);
		assert.strictEqual(p.record.stats!.old.lines, 200);
		assert.strictEqual(p.blobs.old, oldText);
		assert.strictEqual(p.blobs.new, newText);
		assert.strictEqual(p.record.old, undefined);
	});

	test('empty to a long text: counts, preview and only the new version', () => {
		const big = Array.from({ length: 10000 }, (_, i) => `word${i}`).join(' ');
		const p = planTicketFieldChange({ field: 'description', label: 'Description', source: 'README.md', oldValue: 'None', newValue: big }, { kind: 'User' }, AT);
		assert.strictEqual(p.record.kind, 'blob');
		assert.strictEqual(p.record.stats!.new.words, 10000);
		assert.ok(p.record.new!.length <= 301);
		assert.strictEqual(p.blobs.old, undefined);
		assert.strictEqual(p.blobs.new, big);
	});

	test('media is never inlined: type, size and hash only', () => {
		const payload = 'A'.repeat(4000);
		const value = JSON.stringify({ audio: `data:audio/webm;codecs=opus;base64,${payload}`, name: 'memo' });
		const s = sanitizeTicketMedia(value);
		assert.strictEqual(s.media.length, 1);
		assert.strictEqual(s.media[0].mime, 'audio/webm');
		assert.strictEqual(s.media[0].bytes, 3000);
		assert.ok(!s.text.includes(payload));
		const p = planTicketFieldChange({ field: 'custom:Voice', label: 'Voice', source: 'ticket.md', oldValue: '', newValue: value }, { kind: 'User' }, AT);
		assert.strictEqual(p.record.kind, 'binary');
		assert.deepStrictEqual(p.blobs, {});
		assert.ok(!JSON.stringify(p.record).includes(payload));
		// a short data url stays as is
		assert.strictEqual(sanitizeTicketMedia('data:image/png;base64,AAAA').media.length, 0);
	});

	test('dynamic lists: item level add / remove / change', () => {
		const before = JSON.stringify([{ key: 'LU', degree: 'BSc' }, { key: 'HNU', degree: 'MSc' }]);
		const after = JSON.stringify([{ key: 'LU', degree: 'PhD' }, { key: 'Stanford', degree: 'PhD' }]);
		const s = summarizeTicketListChange(before, after)!;
		assert.deepStrictEqual([s.added, s.removed, s.changed], [1, 1, 1]);
		assert.ok(s.details.includes('+ Stanford'));
		assert.ok(s.details.includes('- HNU'));
		assert.ok(s.details.some(d => d.startsWith('~ LU: degree: BSc → PhD')));
		// table rows without ids: by position
		const t = summarizeTicketListChange(JSON.stringify({ columns: [{ name: 'a' }], rows: [{ a: 1 }] }), JSON.stringify({ columns: [{ name: 'a' }], rows: [{ a: 2 }, { a: 3 }] }))!;
		assert.deepStrictEqual([t.added, t.removed, t.changed], [1, 0, 1]);
		assert.strictEqual(summarizeTicketListChange('plain', '[]'), undefined);

		const p = planTicketFieldChange({ field: 'custom:Education', label: 'Education', source: 'ticket.md', oldValue: before, newValue: after }, { kind: 'User' }, AT);
		assert.strictEqual(p.record.kind, 'list');
		assert.strictEqual(p.record.old, before);
	});

	test('line diff of a long single-line text is split by sentences', () => {
		const a = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
		const b = a.replace('Sentence number 30 is here.', 'Sentence number 30 was changed.');
		const d = computeTicketLineDiff(a, b);
		assert.strictEqual(d.added, 1);
		assert.strictEqual(d.removed, 1);
		assert.ok(d.text.includes('- Sentence number 30 is here.'));
		assert.ok(d.text.includes('+ Sentence number 30 was changed.'));
		assert.strictEqual(d.truncated, false);
		assert.ok(a.length > 500);
	});

	test('text stats count CJK characters as words', () => {
		assert.deepStrictEqual(ticketTextStats('你好 world\nfoo'), { chars: 12, words: 4, lines: 2 });
		assert.deepStrictEqual(ticketTextStats(''), { chars: 0, words: 0, lines: 0 });
	});

	test('entry rendering round trips through the JSON block (backticks included)', () => {
		const records: ITicketChangeRecord[] = [
			planTicketFieldChange({ field: 'status', label: 'Status', source: 'ticket.md', oldValue: 'Todo', newValue: 'Done' }, { kind: 'Workflow', name: 'Daily' }, AT).record,
			planTicketFieldChange({ field: 'ticket_prompt', label: 'Ticket Prompt', source: 'instruction.md', oldValue: 'use ```code```', newValue: '`x`' }, { kind: 'Workflow', name: 'Daily' }, AT).record,
		];
		const text = renderTicketChangeEntry(records, toTicketChangeActor({ kind: 'Workflow', name: 'Daily' }), '2026-11-27 10:00:00 -05:00');
		assert.ok(text.markdown.startsWith('## 2026-11-27 10:00:00 -05:00 · Field changes'));
		assert.ok(text.markdown.includes('- **Update By**: Workflow'));
		assert.ok(text.markdown.includes('- **Actor Name**: Daily'));
		assert.ok(text.markdown.includes('- **Status**: `Todo` → `Done`'));
		assert.strictEqual(text.summary, 'Status: Todo → Done; Ticket Prompt: use ```code``` → `x`');
		const parsed = parseTicketChangeRecords(`---\nupdate_by: Workflow\n---\n${text.markdown}`);
		assert.deepStrictEqual(parsed, JSON.parse(JSON.stringify(records)));
		assert.deepStrictEqual(parseTicketChangeRecords('## no records'), []);
		assert.ok(ticketChangeRecordMatchesField(parsed[1], 'ticket prompt'));
		assert.ok(ticketChangeRecordMatchesField(parsed[0], '/Status'));
		assert.ok(!ticketChangeRecordMatchesField(parsed[0], 'priority'));
	});

	test('worklog.md summary block replace / remove', () => {
		const md = '# Work Log\n\n---\n\n## A\n\n- **Log File**: [a.log](.agents/Worklogs/a.log)\n- **Summary**: one\n\n## B\n\n- **Log File**: [b.log](.agents/Worklogs/b.log)\n- **Summary**: two\n';
		const replaced = replaceWorklogMdSummaryBlock(md, 'a.log', '## A\n\n- **Log File**: [a.log](.agents/Worklogs/a.log)\n- **Summary**: changed\n');
		assert.ok(replaced.includes('- **Summary**: changed'));
		assert.ok(!replaced.includes('- **Summary**: one'));
		assert.ok(replaced.includes('## B'));
		const removed = replaceWorklogMdSummaryBlock(md, 'b.log', undefined);
		assert.ok(!removed.includes('b.log'));
		assert.ok(removed.includes('a.log'));
		assert.strictEqual(replaceWorklogMdSummaryBlock(md, 'zzz.log', undefined), md);
	});

	test('coalescer: same actor within the window merges, revert drops, other actor / expiry starts new', () => {
		const c = new TicketChangeCoalescer(1000, 5000);
		const user = { kind: 'User' as const };
		assert.strictEqual(c.mergeTarget('t', user, 0), undefined);
		c.start('t', { filename: 'f.log', timestamp: 'ts' }, user, [{ field: 'status', label: 'Status', source: 'ticket.md', oldValue: 'Todo', newValue: 'Doing' }], 0);
		const target = c.mergeTarget('t', user, 500)!;
		assert.ok(target);
		TicketChangeCoalescer.merge(target, [
			{ field: 'status', label: 'Status', source: 'ticket.md', oldValue: 'Doing', newValue: 'Done' },
			{ field: 'priority', label: 'Priority', source: 'ticket.md', oldValue: 'Low', newValue: 'High' }
		], 500);
		assert.deepStrictEqual([...target.fields.values()].map(f => [f.field, f.oldValue, f.newValue]), [['status', 'Todo', 'Done'], ['priority', 'Low', 'High']]);
		TicketChangeCoalescer.merge(target, [{ field: 'priority', label: 'Priority', source: 'ticket.md', oldValue: 'High', newValue: 'Low' }], 900);
		assert.deepStrictEqual([...target.fields.keys()], ['status']);
		assert.strictEqual(c.mergeTarget('t', { kind: 'AI Agent' }, 950), undefined, 'other actor');
		c.start('t', { filename: 'g.log', timestamp: 'ts' }, user, [], 1000);
		assert.strictEqual(c.mergeTarget('t', user, 2500), undefined, 'window expired');
		c.start('t', { filename: 'h.log', timestamp: 'ts' }, user, [], 0);
		for (let now = 900; now < 5000; now += 900) {
			assert.ok(c.mergeTarget('t', user, now));
			TicketChangeCoalescer.merge(c.mergeTarget('t', user, now)!, [], now);
		}
		assert.strictEqual(c.mergeTarget('t', user, 5400), undefined, 'max age');
		c.start('t', { filename: 'i.log', timestamp: 'ts' }, user, [], 0);
		c.invalidate('t');
		assert.strictEqual(c.mergeTarget('t', user, 1), undefined);
	});

	test('field store naming', () => {
		assert.strictEqual(sanitizeTicketFieldKey('description'), 'description');
		assert.strictEqual(sanitizeTicketFieldKey('ticket_prompt'), 'ticket_prompt');
		assert.strictEqual(sanitizeTicketFieldKey('custom:Expected Salary (USD)'), 'expected_salary_usd');
		assert.strictEqual(sanitizeTicketFieldKey('custom:', 'My Notes'), 'my_notes');
		assert.match(sanitizeTicketFieldKey('custom:备注', '备注'), /^field_[0-9a-f]{8}$/);
		assert.strictEqual(sanitizeTicketFieldKey('custom:备注', '备注'), sanitizeTicketFieldKey('custom:备注', '备注'));

		const sha = 'abcdef0123456789'.repeat(4);
		const name = ticketFieldVersionFileName(new Date(2026, 10, 27, 9, 5, 7), sha);
		assert.strictEqual(name, '20261127-090507_abcdef012345.txt.gz');
		assert.deepStrictEqual(parseTicketFieldVersionFileName(name), { stamp: '20261127-090507', hashPrefix: 'abcdef012345', gzip: true });
		assert.strictEqual(parseTicketFieldVersionFileName('other.txt'), undefined);
		assert.strictEqual(findTicketFieldVersionByHash(['x.txt', name], sha), name);
		assert.strictEqual(findTicketFieldVersionByHash([name], '0'.repeat(64)), undefined);

		const agents = URI.file('/w/T-1/.agents');
		assert.strictEqual(ticketFieldVersionsDir(agents, 'description').path, '/w/T-1/.agents/fields/description.versions');
		assert.strictEqual(ticketFieldCurrentValueUri(agents, 'description').path, '/w/T-1/.agents/fields/description.txt');
		const rel = ticketFieldVersionRelativePath('description', name);
		assert.strictEqual(rel, '.agents/fields/description.versions/20261127-090507_abcdef012345.txt.gz');
		assert.ok(isTicketFieldVersionRelativePath(rel));
		assert.ok(!isTicketFieldVersionRelativePath('.agents/fields/../../etc/passwd'));
	});
});
