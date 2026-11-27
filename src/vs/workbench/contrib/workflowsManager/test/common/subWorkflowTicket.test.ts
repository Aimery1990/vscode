/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISubWorkflowDefinition } from '../../common/workflowExecutionModel.js';
import {
	SUB_WORKFLOW_DEFINITION_REL_PATH,
	applySubWorkflowMetadataToTicketMd,
	buildSubWorkflowDraftFromInput,
	findEnclosingWorkflowFolder,
	getSubWorkflowParentError,
	buildSubWorkflowContract,
	buildSubWorkflowLookup,
	buildSubWorkflowTicketIndex,
	buildSubWorkflowTicketMetadata,
	buildSubWorkflowTicketSummary,
	getSubWorkflowDefinitionUri,
	getSubWorkflowMigrationRetryDelay,
	SUB_WORKFLOW_MIGRATION_RETRY_DELAYS_MS,
	getSubWorkflowSourceFolder,
	getUncoveredLegacySubWorkflows,
	isLegacySubWorkflowId,
	needsSourceCanvasCleanup,
	parseLegacySubWorkflowLibrary,
	parseMigratedLegacyIds,
	parseSubWorkflowDefinition,
	parseSubWorkflowTicketIndex,
	planSubWorkflowMigration,
	removeMigratedSubWorkflowNodesFromCanvas,
	resolveSubWorkflowReference,
	serializeSubWorkflowDefinition,
	stripHeavyMediaFromSubWorkflow,
	subWorkflowSummaryFromMetadata,
	toMigratedSubWorkflowDefinition
} from '../../common/subWorkflowTicket.js';

function makeDef(overrides: Partial<ISubWorkflowDefinition> = {}): ISubWorkflowDefinition {
	return {
		id: 'FINDJ-0042',
		name: 'Lead Search',
		namespace: 'lead_search',
		sourceWorkflowUri: 'file:///ws/FINDJ-0003',
		sourceWorkflowName: 'Find Leads',
		nodeIds: ['n1', 'n2'],
		nodes: [{ id: 'n1', label: 'A' }, { id: 'n2', label: 'B' }],
		links: [{ from: 'n1', to: 'n2' }],
		inputs: [
			{ name: 'query', label: 'Query', defaultValue: 'AI', componentId: 'c1', componentLabel: 'Inputs' },
			{ name: 'limit', label: 'limit', defaultValue: '', componentId: 'c1', componentLabel: 'Inputs' }
		],
		outputs: [{ label: 'Leads', varName: 'leads', fieldKey: 'leads', defaultFormat: 'json', componentId: 'c2', componentLabel: 'Output' }],
		isHiddenInSource: false,
		createdAt: 1000,
		updatedAt: 2000,
		...overrides
	};
}

suite('subWorkflowTicket', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the definition lives in the ticket folder', () => {
		assert.strictEqual(getSubWorkflowDefinitionUri(URI.file('/ws/FINDJ-0003/FINDJ-0042')).path, '/ws/FINDJ-0003/FINDJ-0042/.agents/sub_workflow.json');
		assert.strictEqual(SUB_WORKFLOW_DEFINITION_REL_PATH, '.agents/sub_workflow.json');
	});

	test('legacy ids are recognized', () => {
		assert.strictEqual(isLegacySubWorkflowId('subwf_1700000000000_ab12'), true);
		assert.strictEqual(isLegacySubWorkflowId('FINDJ-0042'), false);
		assert.strictEqual(isLegacySubWorkflowId(undefined), false);
	});

	test('source folder: workflow folder, parent of a workflow file, never the .agents folder', () => {
		assert.strictEqual(getSubWorkflowSourceFolder('file:///ws/FINDJ-0003')?.path, '/ws/FINDJ-0003');
		assert.strictEqual(getSubWorkflowSourceFolder('file:///ws/FINDJ-0003/')?.path, '/ws/FINDJ-0003');
		assert.strictEqual(getSubWorkflowSourceFolder('file:///ws/FINDJ-0003/.agents')?.path, '/ws/FINDJ-0003');
		assert.strictEqual(getSubWorkflowSourceFolder('file:///ws/flows/my.workflow')?.path, '/ws/flows');
		assert.strictEqual(getSubWorkflowSourceFolder('/ws/flows/flow.json')?.path, '/ws/flows');
		assert.strictEqual(getSubWorkflowSourceFolder('file:///ws/flows/flow.json')?.scheme, 'file');
		assert.strictEqual(getSubWorkflowSourceFolder(''), undefined);
		assert.strictEqual(getSubWorkflowSourceFolder(undefined), undefined);
		assert.strictEqual(getSubWorkflowSourceFolder('file:///'), undefined);
	});

	test('serialization round-trips and drops runtime-only state and heavy media', () => {
		const def = makeDef({
			ticketFolderUri: 'file:///ws/FINDJ-0003/FINDJ-0042',
			nodes: [{ id: 'n1', pipeline: [{ component: { type: 'voice_note', voiceClips: [{ id: 'v', audioDataUrl: 'data:audio/webm;base64,AAAA' }] } }] }]
		});
		const text = serializeSubWorkflowDefinition(def);
		assert.ok(!text.includes('ticketFolderUri'));
		assert.ok(!text.includes('audioDataUrl'));
		assert.ok(!text.includes('legacyId'));
		const parsed = parseSubWorkflowDefinition(text)!;
		assert.strictEqual(parsed.id, 'FINDJ-0042');
		assert.strictEqual(parsed.name, 'Lead Search');
		assert.deepStrictEqual(parsed.nodeIds, ['n1', 'n2']);
		assert.strictEqual(parsed.inputs.length, 2);
		assert.strictEqual(parsed.outputs[0].varName, 'leads');
		assert.strictEqual(parsed.sourceWorkflowUri, 'file:///ws/FINDJ-0003');
		assert.strictEqual(parsed.isHiddenInSource, false);
		// The original is untouched
		assert.ok(JSON.stringify(def).includes('audioDataUrl'));
	});

	test('stripping heavy media reports whether anything changed', () => {
		assert.strictEqual(stripHeavyMediaFromSubWorkflow(makeDef()).changed, false);
		const withAudio = makeDef({ nodes: [{ id: 'n1', pipeline: [{ component: { voiceClips: [{ audioDataUrl: 'data:x' }] } }] }] });
		assert.strictEqual(stripHeavyMediaFromSubWorkflow(withAudio).changed, true);
	});

	test('parsing untrusted JSON', () => {
		assert.strictEqual(parseSubWorkflowDefinition('not json'), undefined);
		assert.strictEqual(parseSubWorkflowDefinition('[]'), undefined);
		assert.strictEqual(parseSubWorkflowDefinition('{"id":"X"}'), undefined, 'no nodes');
		assert.strictEqual(parseSubWorkflowDefinition('{"nodes":[]}'), undefined, 'no id and no fallback');
		const fromFolder = parseSubWorkflowDefinition('{"nodes":[{"id":"a"}],"inputs":[{"name":"q","defaultValue":3},{"label":"no name"}],"outputs":[{"label":"Out"}]}', 'GFLOW-0007')!;
		assert.strictEqual(fromFolder.id, 'GFLOW-0007');
		assert.strictEqual(fromFolder.name, 'GFLOW-0007');
		assert.deepStrictEqual(fromFolder.nodeIds, ['a']);
		assert.strictEqual(fromFolder.inputs.length, 1);
		assert.strictEqual(fromFolder.inputs[0].defaultValue, '3');
		assert.strictEqual(fromFolder.outputs[0].varName, 'Out');
		assert.deepStrictEqual(fromFolder.links, []);
		const withLegacy = parseSubWorkflowDefinition(JSON.stringify(makeDef({ legacyId: 'subwf_1_a' })))!;
		assert.strictEqual(withLegacy.legacyId, 'subwf_1_a');
	});

	test('ticket metadata and summaries describe name, source and the inputs / outputs contract', () => {
		const meta = buildSubWorkflowTicketMetadata(makeDef());
		assert.strictEqual(meta['Sub-Workflow'], 'Lead Search');
		assert.strictEqual(meta['Source Workflow'], 'Find Leads (file:///ws/FINDJ-0003)');
		assert.strictEqual(meta['Inputs'], 'query (default: "AI"), limit');
		assert.strictEqual(meta['Outputs'], 'leads (json)');
		assert.strictEqual(meta['Definition File'], '.agents/sub_workflow.json');
		assert.strictEqual(meta['Legacy ID'], undefined);
		assert.strictEqual(buildSubWorkflowTicketMetadata(makeDef({ legacyId: 'subwf_1_a' }))['Legacy ID'], 'subwf_1_a');
		assert.strictEqual(buildSubWorkflowTicketMetadata(makeDef({ inputs: [], outputs: [] }))['Inputs'], 'none');
		assert.strictEqual(buildSubWorkflowTicketMetadata(makeDef({ name: 'two\nlines' }))['Sub-Workflow'], 'two lines');

		const summary = buildSubWorkflowTicketSummary(makeDef());
		assert.deepStrictEqual(summary, { name: 'Lead Search', inputs: 'query (default: "AI"), limit', outputs: 'leads (json)', sourceWorkflow: 'Find Leads (file:///ws/FINDJ-0003)' });
		assert.deepStrictEqual(subWorkflowSummaryFromMetadata(meta), summary);
		assert.strictEqual(subWorkflowSummaryFromMetadata({ Title: 'x' }), undefined);
		assert.strictEqual(subWorkflowSummaryFromMetadata(undefined), undefined);
	});

	test('GET_TICKET contract carries the full inputs / outputs and how to call it', () => {
		const contract = buildSubWorkflowContract(makeDef({ legacyId: 'subwf_1_a' }));
		assert.strictEqual(contract.ticketId, 'FINDJ-0042');
		assert.strictEqual(contract.legacyId, 'subwf_1_a');
		assert.strictEqual(contract.nodeCount, 2);
		assert.deepStrictEqual(contract.inputs[0], { name: 'query', label: 'Query', defaultValue: 'AI' });
		assert.deepStrictEqual(contract.outputs, [{ name: 'leads', label: 'Leads', format: 'json' }]);
		assert.ok(contract.usage.includes('subWorkflowId "FINDJ-0042"'));
		assert.strictEqual(contract.sourceWorkflowName, 'Find Leads');
	});

	test('ticket.md summary lines are replaced in place or added', () => {
		const ticketMd = [
			'# FINDJ-0042',
			'',
			'### Self Defined Data (If any)',
			'- **Self Defined Data Structure**: .agents/entity_type/sub_workflow.yaml',
			'- **Self Defined Data Value**:',
			'  - **Sub-Workflow**: Old',
			'  - **Inputs**: none',
			'',
			'- **Status**: Todo',
			''
		].join('\n');
		const updated = applySubWorkflowMetadataToTicketMd(ticketMd, { 'Sub-Workflow': 'Lead Search', 'Inputs': 'query', 'Outputs': 'leads' });
		const lines = updated.split('\n');
		assert.ok(lines.includes('  - **Sub-Workflow**: Lead Search'));
		assert.ok(lines.includes('  - **Inputs**: query'));
		assert.strictEqual(lines.indexOf('  - **Outputs**: leads'), lines.indexOf('  - **Inputs**: query') + 1, 'appended to the value list');
		assert.ok(lines.includes('- **Status**: Todo'));
		assert.ok(!updated.includes('Old'));
		// Idempotent
		assert.strictEqual(applySubWorkflowMetadataToTicketMd(updated, { 'Sub-Workflow': 'Lead Search', 'Inputs': 'query', 'Outputs': 'leads' }), updated);

		const noValues = applySubWorkflowMetadataToTicketMd('### Self Defined Data (If any)\n- **Self Defined Data Value**: None\n\n- **Status**: Todo\n', { 'Inputs': 'q' });
		assert.ok(noValues.includes('- **Self Defined Data Value**:\n  - **Inputs**: q\n'));
		const noSection = applySubWorkflowMetadataToTicketMd('# T\n- **Status**: Todo\n', { 'Inputs': 'q' });
		assert.ok(noSection.includes('### Self Defined Data (If any)\n- **Self Defined Data Value**:\n  - **Inputs**: q'));
	});

	test('ticket index parsing and building', () => {
		assert.deepStrictEqual(parseSubWorkflowTicketIndex(undefined), []);
		assert.deepStrictEqual(parseSubWorkflowTicketIndex('{'), []);
		assert.deepStrictEqual(parseSubWorkflowTicketIndex(JSON.stringify([
			{ id: 'A-0001', folderUri: 'file:///a', legacyId: 'subwf_1' },
			{ id: 'A-0001', folderUri: 'file:///dup' },
			{ id: 'A-0002' },
			'junk',
			{ id: 'A-0003', folderUri: 'file:///c', legacyId: 7 }
		])), [
			{ id: 'A-0001', folderUri: 'file:///a', legacyId: 'subwf_1' },
			{ id: 'A-0003', folderUri: 'file:///c' }
		]);
		const index = buildSubWorkflowTicketIndex([
			makeDef({ ticketFolderUri: 'file:///ws/FINDJ-0003/FINDJ-0042', legacyId: 'subwf_1' }),
			makeDef({ id: 'subwf_2' })
		]);
		assert.deepStrictEqual(index, [{ id: 'FINDJ-0042', folderUri: 'file:///ws/FINDJ-0003/FINDJ-0042', legacyId: 'subwf_1' }]);
	});

	test('Call Sub-Workflow references resolve by ticket ID and by legacy id', () => {
		const migrated = makeDef({ id: 'FINDJ-0042', legacyId: 'subwf_1_a', ticketFolderUri: 'file:///f' });
		const other = makeDef({ id: 'GFLOW-0007', name: 'Other' });
		const defs = [migrated, other];
		assert.strictEqual(resolveSubWorkflowReference(defs, 'FINDJ-0042'), migrated);
		assert.strictEqual(resolveSubWorkflowReference(defs, 'subwf_1_a'), migrated);
		assert.strictEqual(resolveSubWorkflowReference(defs, ' GFLOW-0007 '), other);
		assert.strictEqual(resolveSubWorkflowReference(defs, 'subwf_unknown'), undefined);
		assert.strictEqual(resolveSubWorkflowReference(defs, ''), undefined);
		// A real id wins over another definition's legacy alias
		const clash = makeDef({ id: 'subwf_1_a', name: 'Unmigrated' });
		assert.strictEqual(buildSubWorkflowLookup([migrated, clash]).get('subwf_1_a'), clash);
	});

	test('migration plan: once per legacy id, skipping covered, migrated and duplicate ids', () => {
		const legacy = parseLegacySubWorkflowLibrary(JSON.stringify([
			makeDef({ id: 'subwf_1' }),
			makeDef({ id: 'subwf_2' }),
			makeDef({ id: 'subwf_3' }),
			makeDef({ id: 'subwf_1', name: 'duplicate' }),
			{ id: 'subwf_bad' }
		]));
		assert.deepStrictEqual(legacy.map(d => d.id), ['subwf_1', 'subwf_2', 'subwf_3', 'subwf_1']);
		const tickets = [makeDef({ id: 'FINDJ-0042', legacyId: 'subwf_1', ticketFolderUri: 'file:///f' })];
		const plan = planSubWorkflowMigration(legacy, tickets, new Set(['subwf_3']));
		assert.deepStrictEqual(plan.map(d => d.id), ['subwf_2']);
		assert.deepStrictEqual(planSubWorkflowMigration(legacy, [], new Set()).map(d => d.id), ['subwf_1', 'subwf_2', 'subwf_3']);
		assert.deepStrictEqual(parseLegacySubWorkflowLibrary('nope'), []);
		assert.deepStrictEqual(Array.from(parseMigratedLegacyIds('["subwf_1", 3, ""]')), ['subwf_1']);
		assert.deepStrictEqual(Array.from(parseMigratedLegacyIds('x')), []);
	});

	test('migrated definitions take the ticket ID and keep the legacy id', () => {
		const legacy = makeDef({ id: 'subwf_9_zz' });
		const migrated = toMigratedSubWorkflowDefinition(legacy, 'FINDJ-0050', 'file:///ws/FINDJ-0003/FINDJ-0050');
		assert.strictEqual(migrated.id, 'FINDJ-0050');
		assert.strictEqual(migrated.legacyId, 'subwf_9_zz');
		assert.strictEqual(migrated.ticketFolderUri, 'file:///ws/FINDJ-0003/FINDJ-0050');
		assert.deepStrictEqual(migrated.nodes, legacy.nodes);
		assert.strictEqual(legacy.id, 'subwf_9_zz', 'the legacy definition is not modified');
		assert.ok(serializeSubWorkflowDefinition(migrated).includes('"legacyId": "subwf_9_zz"'));
	});

	test('creates a valid sub_workflow ticket definition from a program / AI definition', () => {
		const defaults = { name: 'From Title', sourceWorkflowUri: 'file:///ws/FINDJ-0003', sourceWorkflowName: 'Find Leads', now: 5 };
		// No definition: a valid empty one (no nodes, empty contract)
		const empty = buildSubWorkflowDraftFromInput(undefined, defaults);
		assert.strictEqual(empty.error, undefined);
		assert.deepStrictEqual({ ...empty.draft }, {
			id: '', name: 'From Title', nodeIds: [], nodes: [], links: [], inputs: [], outputs: [], createdAt: 5, updatedAt: 5,
			sourceWorkflowUri: 'file:///ws/FINDJ-0003', sourceWorkflowName: 'Find Leads', isHiddenInSource: false
		});
		assert.strictEqual(buildSubWorkflowDraftFromInput('  ', defaults).draft?.nodes.length, 0);
		assert.strictEqual(buildSubWorkflowDraftFromInput(null, defaults).draft?.name, 'From Title');

		const full = {
			name: 'Lead Search',
			nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
			links: [{ from: 'a', to: 'b' }],
			inputs: [{ name: 'query', defaultValue: 'AI' }],
			outputs: [{ varName: 'leads', defaultFormat: 'json' }],
			sourceWorkflowUri: 'file:///elsewhere'
		};
		const draft = buildSubWorkflowDraftFromInput(full, defaults).draft!;
		assert.strictEqual(draft.name, 'Lead Search');
		assert.deepStrictEqual(draft.nodeIds, ['a', 'b']);
		assert.strictEqual(draft.links.length, 1);
		assert.strictEqual(draft.inputs[0].name, 'query');
		assert.strictEqual(draft.outputs[0].varName, 'leads');
		assert.strictEqual(draft.sourceWorkflowUri, 'file:///ws/FINDJ-0003', 'the source is always the parent workflow');
		// JSON text works too and the result serializes like any other definition
		const fromJson = buildSubWorkflowDraftFromInput(JSON.stringify(full), defaults).draft!;
		assert.deepStrictEqual(fromJson.nodeIds, ['a', 'b']);
		const stored = parseSubWorkflowDefinition(serializeSubWorkflowDefinition({ ...fromJson, id: 'FINDJ-0050' }))!;
		assert.strictEqual(stored.id, 'FINDJ-0050');
		assert.strictEqual(buildSubWorkflowTicketMetadata(stored)['Inputs'], 'query (default: "AI")');
	});

	test('invalid sub_workflow definitions are rejected with a clear message', () => {
		const defaults = { name: 'X', sourceWorkflowUri: 'file:///ws/W' };
		const errorOf = (raw: unknown) => buildSubWorkflowDraftFromInput(raw, defaults).error || '';
		assert.ok(errorOf('{bad').includes('not valid JSON'));
		assert.ok(errorOf(42).includes('expected an object'));
		assert.ok(errorOf([]).includes('expected an object'));
		assert.ok(errorOf({ nodes: {} }).includes('"nodes" must be a list'));
		assert.ok(errorOf({ nodes: [{ label: 'no id' }] }).includes('nodes[0]'));
		assert.ok(errorOf({ nodes: [{ id: 'a' }, { id: 'a' }] }).includes('used twice'));
		assert.ok(errorOf({ nodes: [{ id: 'a' }], links: [{ from: 'a', to: 'zz' }] }).includes('links[0]'));
		assert.ok(errorOf({ links: [{ from: 'a' }] }).includes('links[0]'));
		assert.ok(errorOf({ inputs: [{ label: 'x' }] }).includes('inputs[0]'));
		assert.ok(errorOf({ outputs: [{ defaultFormat: 'json' }] }).includes('outputs[0]'));
		assert.ok(errorOf({ name: 3 }).includes('"name"'));
		assert.ok(errorOf({ nodes: 'x' }).startsWith('Invalid sub_workflow definition'));
	});

	test('creation fails outside a workflow folder and uses the nearest enclosing workflow', async () => {
		const workflows = new Set(['/ws/FINDJ-0003']);
		const isWorkflow = async (folder: URI) => workflows.has(folder.path);
		assert.strictEqual((await findEnclosingWorkflowFolder(URI.file('/ws/FINDJ-0003'), isWorkflow))?.path, '/ws/FINDJ-0003');
		assert.strictEqual((await findEnclosingWorkflowFolder(URI.file('/ws/FINDJ-0003/FINDJ-0042/notes'), isWorkflow))?.path, '/ws/FINDJ-0003');
		assert.strictEqual(await findEnclosingWorkflowFolder(URI.file('/ws/FINDJ-0001'), isWorkflow), undefined);
		assert.strictEqual(await findEnclosingWorkflowFolder(URI.file('/'), isWorkflow), undefined);
		const message = getSubWorkflowParentError('/ws/FINDJ-0001');
		assert.ok(message.includes('must be created inside a workflow folder'));
		assert.ok(message.includes('/ws/FINDJ-0001'));
	});

	test('legacy definitions without a loaded ticket stay usable', () => {
		const legacy = [makeDef({ id: 'subwf_1' }), makeDef({ id: 'subwf_2' }), makeDef({ id: 'subwf_2' })];
		const tickets = [makeDef({ id: 'FINDJ-0042', legacyId: 'subwf_1', ticketFolderUri: 'file:///f' })];
		assert.deepStrictEqual(getUncoveredLegacySubWorkflows(legacy, tickets).map(d => d.id), ['subwf_2']);
	});

	test('failed migrations are retried a few times in the same session, then on the next start', () => {
		assert.strictEqual(getSubWorkflowMigrationRetryDelay(0), SUB_WORKFLOW_MIGRATION_RETRY_DELAYS_MS[0]);
		assert.ok(getSubWorkflowMigrationRetryDelay(1)! > getSubWorkflowMigrationRetryDelay(0)!);
		assert.strictEqual(getSubWorkflowMigrationRetryDelay(SUB_WORKFLOW_MIGRATION_RETRY_DELAYS_MS.length), undefined);
		assert.strictEqual(getSubWorkflowMigrationRetryDelay(-1), undefined);
	});

	test('a migrated Sub-Workflow that was hidden in its source still has to be removed from the source canvas', () => {
		assert.strictEqual(needsSourceCanvasCleanup(makeDef({ legacyId: 'subwf_1', isHiddenInSource: true })), true);
		assert.strictEqual(needsSourceCanvasCleanup(makeDef({ legacyId: 'subwf_1', isHiddenInSource: false })), false);
		assert.strictEqual(needsSourceCanvasCleanup(makeDef({ isHiddenInSource: true })), false);
		assert.strictEqual(needsSourceCanvasCleanup(makeDef({ legacyId: 'subwf_1', isHiddenInSource: true, sourceWorkflowUri: '' })), false);
	});

	test('the source canvas drops the migrated nodes and their links, and keeps everything else', () => {
		const canvas = {
			nodes: [{ id: 'call', label: 'Call' }, { id: 'n1', label: 'A' }, { id: 'n2', label: 'B' }, { id: 'n3', label: 'C' }, { id: 'main', label: 'Main' }],
			links: [
				{ id: 'l1', from: 'n1', to: 'n2' },
				{ id: 'l2', from: 'n2', to: 'n3' },
				{ id: 'l3', from: 'call', to: 'main' },
				{ id: 'l4', from: 'main', to: 'n1' }
			],
			routingMode: 'orthogonal'
		};
		const before = JSON.stringify(canvas);
		// n3 is listed but not held by the ticket: no evidence, so it stays
		const def = makeDef({ nodeIds: ['n1', 'n2', 'n3'], nodes: [{ id: 'n1' }, { id: 'n2' }] });
		const result = removeMigratedSubWorkflowNodesFromCanvas(canvas, [def])!;
		assert.deepStrictEqual(result.removedNodeIds, ['n1', 'n2']);
		assert.strictEqual(result.removedLinkCount, 3);
		assert.deepStrictEqual(result.canvas.nodes, [{ id: 'call', label: 'Call' }, { id: 'n3', label: 'C' }, { id: 'main', label: 'Main' }]);
		assert.deepStrictEqual(result.canvas.links, [{ id: 'l3', from: 'call', to: 'main' }]);
		assert.strictEqual(result.canvas.routingMode, 'orthogonal');
		assert.strictEqual(JSON.stringify(canvas), before, 'the input is not modified');
		// Already clean: nothing to write
		assert.strictEqual(removeMigratedSubWorkflowNodesFromCanvas(result.canvas, [def]), undefined);
		assert.strictEqual(removeMigratedSubWorkflowNodesFromCanvas({}, [def]), undefined);
	});
});
