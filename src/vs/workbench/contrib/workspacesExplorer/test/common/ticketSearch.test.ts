/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildPrunedTicketTree, canonicalTreeKey, describeSearchResult, describeTicketLocation, findExactIdMatch, flattenTicketSubtree, ITicketSearchEntry, matchTicketText, searchTickets, splitHighlight, TicketMatchRank } from '../../common/ticketSearch.js';
import { ITicketSubtreeNode, ITicketSubtreeSummary } from '../../common/ticketSubtreeCount.js';

const WS_ROOT = URI.file('/repo/any_agent');

function t(path: string, ticketId: string, title: string, children: ITicketSubtreeNode[] = [], removed = false): ITicketSubtreeNode {
	return { resource: URI.joinPath(WS_ROOT, path), ticketId, title, type: 'issue', status: removed ? 'Removed' : 'Todo', category: removed ? 'Removed' : 'Todo', removed, children };
}

/** Any Agent Development > ANYAG-0038 UX Issues > ANYAG-0110 Search > ANYAG-0111 Deep search (+ siblings). */
function sampleSummary(): ITicketSubtreeSummary {
	return {
		truncated: false,
		children: [
			t('a38', 'ANYAG-0038', 'UX Issues', [
				t('a38/a110', 'ANYAG-0110', 'Search', [
					t('a38/a110/a111', 'ANYAG-0111', 'Deep search in tree'),
					t('a38/a110/a112', 'ANYAG-0112', 'Go to ticket command')
				]),
				t('a38/a120', 'ANYAG-0120', 'Unrelated sibling')
			]),
			t('a40', 'ANYAG-0040', 'Backend', [
				t('a40/a1110', 'ANYAG-01110', 'Another ticket')
			]),
			t('a50', 'ANYAG-0050', 'Old stuff', [
				t('a50/a51', 'ANYAG-0051', 'Search archive')
			], true)
		]
	};
}

function sampleIndex(): ITicketSearchEntry[] {
	return flattenTicketSubtree(sampleSummary(), { key: canonicalTreeKey(WS_ROOT), name: 'Any Agent Development', resource: WS_ROOT });
}

function byId(entries: readonly ITicketSearchEntry[], id: string): ITicketSearchEntry {
	const found = entries.find(e => e.ticketId === id);
	assert.ok(found, id);
	return found;
}

suite('ticketSearch', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('flatten: every level, parent chain, removed propagates down', () => {
		const index = sampleIndex();
		assert.strictEqual(index.length, 9);
		const deep = byId(index, 'ANYAG-0111');
		assert.deepStrictEqual(deep.ancestors.map(a => a.label), ['ANYAG-0038 UX Issues', 'ANYAG-0110 Search']);
		assert.deepStrictEqual(deep.ancestors.map(a => a.key), [canonicalTreeKey(URI.joinPath(WS_ROOT, 'a38')), canonicalTreeKey(URI.joinPath(WS_ROOT, 'a38/a110'))]);
		assert.strictEqual(deep.key, canonicalTreeKey(URI.joinPath(WS_ROOT, 'a38/a110/a111')));
		assert.strictEqual(describeTicketLocation(deep), 'Any Agent Development \u203a ANYAG-0038 UX Issues \u203a ANYAG-0110 Search');
		assert.strictEqual(byId(index, 'ANYAG-0051').removed, false);
		assert.strictEqual(byId(index, 'ANYAG-0051').removedInPath, true);
	});

	test('canonical key matches the tree row key (lower-cased fsPath)', () => {
		assert.strictEqual(canonicalTreeKey(URI.file('/Repo/X').toString()), canonicalTreeKey(URI.file('/Repo/X')));
		assert.strictEqual(canonicalTreeKey('vscode-remote://Host/A'), 'vscode-remote://host/a');
	});

	test('match ranks: exact ID > ID prefix > ID contains > title contains', () => {
		assert.deepStrictEqual(matchTicketText('ANYAG-0111', 'X', 'anyag-0111'), { rank: TicketMatchRank.ExactId, idRange: [0, 10] });
		assert.deepStrictEqual(matchTicketText('ANYAG-0111', 'X', 'anyag-01'), { rank: TicketMatchRank.IdPrefix, idRange: [0, 8] });
		// a query starting a dash-separated part counts as a prefix ("0111" -> ANYAG-0111)
		assert.deepStrictEqual(matchTicketText('ANYAG-0111', 'X', '0111'), { rank: TicketMatchRank.IdPrefix, idRange: [6, 10] });
		assert.deepStrictEqual(matchTicketText('ANYAG-0111', 'X', '111'), { rank: TicketMatchRank.IdContains, idRange: [7, 10] });
		assert.deepStrictEqual(matchTicketText('ANYAG-0111', 'Deep Search', 'search'), { rank: TicketMatchRank.Title, titleRange: [5, 11] });
		assert.deepStrictEqual(matchTicketText('ANYAG-0111', 'anyag notes', 'anyag'), { rank: TicketMatchRank.IdPrefix, idRange: [0, 5], titleRange: [0, 5] });
		assert.strictEqual(matchTicketText('ANYAG-0111', 'Deep', 'zzz'), undefined);
	});

	test('search: ranking, removed tickets, minimum length', () => {
		const index = sampleIndex();
		const r = searchTickets(index, '  0111 ', { includeRemoved: false });
		assert.deepStrictEqual(r.matches.map(m => m.entry.ticketId), ['ANYAG-0111', 'ANYAG-01110']);
		assert.strictEqual(r.total, 2);
		assert.strictEqual(r.capped, false);

		const exactFirst = searchTickets(index, 'anyag-0111', { includeRemoved: false });
		assert.deepStrictEqual(exactFirst.matches.map(m => [m.entry.ticketId, m.rank]), [['ANYAG-0111', TicketMatchRank.ExactId], ['ANYAG-01110', TicketMatchRank.IdPrefix]]);

		// "search" matches titles; the ticket under a removed parent only with "show removed items"
		assert.deepStrictEqual(searchTickets(index, 'search', { includeRemoved: false }).matches.map(m => m.entry.ticketId), ['ANYAG-0110', 'ANYAG-0111']);
		assert.deepStrictEqual(searchTickets(index, 'search', { includeRemoved: true }).matches.map(m => m.entry.ticketId), ['ANYAG-0051', 'ANYAG-0110', 'ANYAG-0111']);

		assert.strictEqual(searchTickets(index, 'a', { includeRemoved: true }).matches.length, 0);
		assert.strictEqual(searchTickets(index, 'a', { includeRemoved: true, minLength: 1 }).total, 9);
	});

	test('search: cap with total', () => {
		const r = searchTickets(sampleIndex(), 'anyag', { includeRemoved: true, limit: 3 });
		assert.strictEqual(r.matches.length, 3);
		assert.strictEqual(r.total, 9);
		assert.strictEqual(r.capped, true);
		// natural order within a rank
		assert.deepStrictEqual(r.matches.map(m => m.entry.ticketId), ['ANYAG-0038', 'ANYAG-0040', 'ANYAG-0050']);
		assert.strictEqual(describeSearchResult(r, 'anyag', false), 'Showing first 3 of 9 matches');
		assert.strictEqual(describeSearchResult(searchTickets(sampleIndex(), 'zz', { includeRemoved: true }), ' zz ', false), 'No tickets match \u201czz\u201d');
		assert.strictEqual(describeSearchResult(searchTickets(sampleIndex(), '0112', { includeRemoved: true }), '0112', true), '1 match (very large workspaces are only partly indexed)');
	});

	test('exact ID lookup', () => {
		const index = sampleIndex();
		assert.strictEqual(findExactIdMatch(index, 'anyag-0111', false)?.title, 'Deep search in tree');
		assert.strictEqual(findExactIdMatch(index, '0111', false), undefined);
		assert.strictEqual(findExactIdMatch(index, 'ANYAG-0051', false), undefined);
		assert.strictEqual(findExactIdMatch(index, 'ANYAG-0051', true)?.ticketId, 'ANYAG-0051');
	});

	test('pruned tree: only paths to matches, shared ancestors, siblings hidden', () => {
		const index = sampleIndex();
		const tree = buildPrunedTicketTree(searchTickets(index, 'anyag-011', { includeRemoved: false }).matches);
		// matches: 0110, 0111, 0112, 01110 - 0110 is both a match and the ancestor of 0111 / 0112
		const key = (id: string) => byId(index, id).key;
		assert.strictEqual(tree.roots.length, 1);
		const ws = tree.roots[0];
		assert.strictEqual(ws.label, 'Any Agent Development');
		assert.deepStrictEqual(ws.children.map(c => c.label), ['ANYAG-0038 UX Issues', 'ANYAG-0040 Backend']);
		const a38 = ws.children[0];
		assert.strictEqual(a38.match, undefined);
		assert.deepStrictEqual(a38.children.map(c => c.label), ['ANYAG-0110 Search']); // ANYAG-0120 sibling hidden
		assert.ok(a38.children[0].match);
		assert.deepStrictEqual(a38.children[0].children.map(c => c.label), ['ANYAG-0111 Deep search in tree', 'ANYAG-0112 Go to ticket command']);
		assert.ok(tree.visible.has(key('ANYAG-0038')));
		assert.ok(!tree.visible.has(key('ANYAG-0120')));
		assert.ok(!tree.visible.has(key('ANYAG-0050')));
		assert.ok(tree.expanded.has(canonicalTreeKey(WS_ROOT)));
		assert.ok(tree.expanded.has(key('ANYAG-0038')));
		assert.ok(tree.expanded.has(key('ANYAG-0110')));
		assert.ok(!tree.expanded.has(key('ANYAG-0111')));
		assert.deepStrictEqual([...tree.workspaceKeys], [canonicalTreeKey(WS_ROOT)]);
		assert.strictEqual(tree.matchByKey.size, 4);
	});

	test('highlight segments', () => {
		assert.deepStrictEqual(splitHighlight('ANYAG-0111', [6, 10]), [{ text: 'ANYAG-', highlight: false }, { text: '0111', highlight: true }]);
		assert.deepStrictEqual(splitHighlight('Deep search', [5, 8]), [{ text: 'Deep ', highlight: false }, { text: 'sea', highlight: true }, { text: 'rch', highlight: false }]);
		assert.deepStrictEqual(splitHighlight('abc', undefined), [{ text: 'abc', highlight: false }]);
		assert.deepStrictEqual(splitHighlight('abc', [2, 9]), [{ text: 'abc', highlight: false }]);
	});
});
