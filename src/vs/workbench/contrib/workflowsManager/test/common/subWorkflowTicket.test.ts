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
	buildSubWorkflowContract,
	buildSubWorkflowLookup,
	buildSubWorkflowTicketIndex,
	buildSubWorkflowTicketMetadata,
	buildSubWorkflowTicketSummary,
	getSubWorkflowDefinitionUri,
	getSubWorkflowSourceFolder,
	getUncoveredLegacySubWorkflows,
	isLegacySubWorkflowId,
	parseLegacySubWorkflowLibrary,
	parseMigratedLegacyIds,
	parseSubWorkflowDefinition,
	parseSubWorkflowTicketIndex,
	planSubWorkflowMigration,
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

	test('legacy definitions without a loaded ticket stay usable', () => {
		const legacy = [makeDef({ id: 'subwf_1' }), makeDef({ id: 'subwf_2' }), makeDef({ id: 'subwf_2' })];
		const tickets = [makeDef({ id: 'FINDJ-0042', legacyId: 'subwf_1', ticketFolderUri: 'file:///f' })];
		assert.deepStrictEqual(getUncoveredLegacySubWorkflows(legacy, tickets).map(d => d.id), ['subwf_2']);
	});
});
