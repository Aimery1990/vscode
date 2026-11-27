/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ATTACHMENT_DETECTED_ACTOR, ATTACHMENT_HASH_MAX_FILE_BYTES, attachmentChangeRecord, attachmentTamperTooltip, emptyAttachmentManifest, IAttachmentManifest,
	IObservedAttachment, parseAttachmentManifest, reconcileAttachmentManifest, selectAttachmentsToHash, serializeAttachmentManifest
} from '../../common/ticketAttachmentIntegrity.js';
import { describeTicketAttachmentChange, formatTicketChangeActor, parseTicketChangeRecords, renderTicketChangeEntry } from '../../common/ticketChangeLog.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const NOW = '2026-11-27T10:00:00.000Z';

function manifestOf(...entries: Array<[string, string, number, number]>): IAttachmentManifest {
	const files: IAttachmentManifest['files'] = Object.fromEntries(entries.map(([name, sha256, size, mtime]) => [name, { name, sha256, size, mtime, recordedAt: NOW }]));
	return { version: 1, files };
}

suite('ticketAttachmentIntegrity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('manifest parse / serialize round trip, tolerant of bad data', () => {
		const m: IAttachmentManifest = {
			version: 1,
			files: {
				'resume.pdf': { name: 'resume.pdf', sha256: A, size: 182331, mtime: 5, recordedAt: NOW, tampered: { previousSha256: B, previousSize: 182331, detectedAt: NOW } },
				'big.mov': { name: 'big.mov', sha256: '', size: 2e9, mtime: 6, recordedAt: NOW }
			}
		};
		const text = serializeAttachmentManifest(m);
		assert.deepStrictEqual(parseAttachmentManifest(text), m);
		assert.strictEqual(text.indexOf('big.mov') < text.indexOf('resume.pdf'), true, 'sorted by name');
		assert.strictEqual(parseAttachmentManifest(''), undefined);
		assert.strictEqual(parseAttachmentManifest('not json'), undefined);
		assert.deepStrictEqual(parseAttachmentManifest(JSON.stringify({ files: { x: { sha256: 'zz', size: 1, mtime: 1 }, y: { sha256: A, size: -1, mtime: 1 }, z: { sha256: A, size: 1, mtime: 1 } } }))!.files, {
			z: { name: 'z', sha256: A, size: 1, mtime: 1, recordedAt: '' }
		});
	});

	test('only new files and files with a different (size, mtime) are hashed, within the budget', () => {
		const m = manifestOf(['same.txt', A, 10, 1], ['touched.txt', A, 10, 1]);
		const observed: IObservedAttachment[] = [
			{ name: 'same.txt', size: 10, mtime: 1 },
			{ name: 'touched.txt', size: 10, mtime: 2 },
			{ name: 'new1.bin', size: 100, mtime: 1 },
			{ name: 'new2.bin', size: 100, mtime: 1 },
			{ name: 'huge.iso', size: ATTACHMENT_HASH_MAX_FILE_BYTES + 1, mtime: 1 }
		];
		assert.deepStrictEqual(selectAttachmentsToHash(m, observed).map(f => f.name), ['new1.bin', 'new2.bin', 'touched.txt']);
		assert.deepStrictEqual(selectAttachmentsToHash(m, observed, 2).map(f => f.name), ['new1.bin', 'new2.bin']);
		assert.deepStrictEqual(selectAttachmentsToHash(m, observed, 10, 150).map(f => f.name), ['new1.bin'], 'byte budget');
		assert.deepStrictEqual(selectAttachmentsToHash(m, observed, 10, 50).map(f => f.name), ['new1.bin'], 'a first file over the budget is still hashed');
	});

	test('baseline: an existing ticket without a manifest records hashes silently', () => {
		const r = reconcileAttachmentManifest(emptyAttachmentManifest(), [{ name: 'a.pdf', size: 3, mtime: 1 }], new Map([['a.pdf', A]]), { now: NOW, mode: 'detected', baseline: true });
		assert.deepStrictEqual(r.changes, []);
		assert.strictEqual(r.manifest.files['a.pdf'].sha256, A);
		assert.strictEqual(r.manifestChanged, true);
	});

	test('app changes: added, removed and re-uploaded files', () => {
		const m = manifestOf(['old.docx', A, 1024, 1], ['resume.pdf', B, 100, 1]);
		const r = reconcileAttachmentManifest(m, [
			{ name: 'resume.pdf', size: 120, mtime: 2 },
			{ name: 'new.png', size: 182331, mtime: 2 }
		], new Map([['resume.pdf', C], ['new.png', A]]), { now: NOW, mode: 'app' });
		assert.deepStrictEqual(r.changes, [
			{ op: 'added', name: 'new.png', sha256: A, size: 182331 },
			{ op: 'changed', name: 'resume.pdf', sha256: C, size: 120, oldSha256: B, oldSize: 100 },
			{ op: 'removed', name: 'old.docx', sha256: A, size: 1024 }
		]);
		assert.strictEqual(r.manifest.files['resume.pdf'].tampered, undefined);
		assert.deepStrictEqual(Object.keys(r.manifest.files).sort(), ['new.png', 'resume.pdf']);
	});

	test('detection: same-size content change is flagged as tampered; touch without change is not', () => {
		const m = manifestOf(['resume.pdf', A, 100, 1], ['notes.txt', B, 5, 1]);
		const observed = [{ name: 'resume.pdf', size: 100, mtime: 9 }, { name: 'notes.txt', size: 5, mtime: 9 }];
		const r = reconcileAttachmentManifest(m, observed, new Map([['resume.pdf', C], ['notes.txt', B]]), { now: NOW, mode: 'detected' });
		assert.deepStrictEqual(r.changes, [{ op: 'changed', name: 'resume.pdf', sha256: C, size: 100, oldSha256: A, oldSize: 100, detected: true }]);
		assert.deepStrictEqual(r.manifest.files['resume.pdf'].tampered, { previousSha256: A, previousSize: 100, detectedAt: NOW });
		assert.strictEqual(r.manifest.files['notes.txt'].mtime, 9, 'stat refreshed');
		assert.strictEqual(r.manifest.files['notes.txt'].tampered, undefined);

		// The next pass with the same stat: nothing to hash, nothing reported, the flag stays.
		assert.deepStrictEqual(selectAttachmentsToHash(r.manifest, observed), []);
		const again = reconcileAttachmentManifest(r.manifest, observed, new Map(), { now: NOW, mode: 'detected' });
		assert.deepStrictEqual(again.changes, []);
		assert.strictEqual(again.manifestChanged, false);
		assert.ok(again.manifest.files['resume.pdf'].tampered);
		assert.match(attachmentTamperTooltip(again.manifest.files['resume.pdf'])!, new RegExp(`Recorded sha256: ${A}[\\s\\S]*Current sha256: ${C}`));
	});

	test('files deferred by the budget keep their entry and are not reported', () => {
		const m = manifestOf(['a.txt', A, 1, 1]);
		const r = reconcileAttachmentManifest(m, [{ name: 'a.txt', size: 2, mtime: 2 }, { name: 'b.txt', size: 1, mtime: 1 }], new Map(), { now: NOW, mode: 'detected' });
		assert.deepStrictEqual(r.changes, []);
		assert.strictEqual(r.manifestChanged, false);
		assert.deepStrictEqual(r.manifest.files, m.files);
	});

	test('change record rendering', () => {
		assert.strictEqual(describeTicketAttachmentChange({ op: 'added', name: 'resume.pdf', sha256: A, size: 182331 }), `+ \`resume.pdf\` (sha256:${A}, 182,331 bytes)`);
		assert.strictEqual(describeTicketAttachmentChange({ op: 'removed', name: 'old.docx', sha256: B, size: 1024 }), `- \`old.docx\` (sha256:${B}, 1,024 bytes)`);
		assert.strictEqual(describeTicketAttachmentChange({ op: 'changed', name: 'resume.pdf', sha256: C, size: 100, oldSha256: A, oldSize: 100, detected: true }), `~ \`resume.pdf\` content changed outside the app: sha256 ${A} → ${C}, 100 → 100 bytes`);

		const record = attachmentChangeRecord([{ op: 'added', name: 'resume.pdf', sha256: A, size: 182331 }, { op: 'changed', name: 'x.txt', sha256: C, size: 1, oldSha256: B, oldSize: 1, detected: true }], ATTACHMENT_DETECTED_ACTOR, new Date(NOW));
		assert.strictEqual(formatTicketChangeActor(ATTACHMENT_DETECTED_ACTOR), 'System (detected)');
		const text = renderTicketChangeEntry([record], ATTACHMENT_DETECTED_ACTOR, '2026-11-27 10:00:00');
		assert.strictEqual(text.summary, 'Attachments: 1 added, 1 content changed');
		assert.ok(text.markdown.includes('- **Update By**: System'));
		assert.ok(text.markdown.includes('- **Actor Name**: detected'));
		assert.ok(text.markdown.includes(`  - + \`resume.pdf\` (sha256:${A}, 182,331 bytes)`));
		assert.deepStrictEqual(parseTicketChangeRecords(text.markdown), [JSON.parse(JSON.stringify(record))]);
	});
});
