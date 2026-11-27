/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ISubWorkflowCallFrame,
	ISubWorkflowCallGraphResolver,
	ISubWorkflowGraphDefinition,
	ITemplateGraphDefinition,
	MAX_SUB_WORKFLOW_CALL_DEPTH,
	SubWorkflowCallGraph,
	buildSubWorkflowAliasMap,
	checkSubWorkflowCall,
	collectRunTicketTypesFromFields,
	collectRunTicketTypesFromNodes,
	collectSubWorkflowRefsFromFields,
	collectSubWorkflowRefsFromNodes,
	createSubWorkflowCallChain,
	extendSubWorkflowCallChain,
	findSubWorkflowCallCycle,
	findTemplateByTicketType,
	formatCallChain,
	formatSubWorkflowCycleError,
	getSubWorkflowCallDepth,
	normalizeSubWorkflowReference,
	subWorkflowCallFrame
} from '../../common/subWorkflowCallGraph.js';

function callNode(id: string, subWorkflowId: string, extra?: Record<string, unknown>): Record<string, unknown> {
	return { id, pipeline: [{ id: `s_${id}`, type: 'component', component: { id: `c_${id}`, label: 'Call', type: 'sub_workflow', subWorkflowId, ...extra } }] };
}

function runTicketNode(id: string, ticketType: string): Record<string, unknown> {
	return { id, pipeline: [{ id: `s_${id}`, type: 'run_ticket', ticketName: 'T-1', ticketType }] };
}

function sub(id: string, nodes: unknown[], extra?: Partial<ISubWorkflowGraphDefinition>): ISubWorkflowGraphDefinition {
	return { id, name: `Sub ${id}`, nodes, ...extra };
}

function resolverOf(subs: ISubWorkflowGraphDefinition[], templates: ITemplateGraphDefinition[] = []): ISubWorkflowCallGraphResolver {
	return {
		resolveSubWorkflow: async ref => subs.find(s => s.id === ref || s.legacyId === ref),
		resolveTemplate: async type => findTemplateByTicketType(templates, type)
	};
}

suite('subWorkflowCallGraph (CI-38)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('collects Sub-Workflow references of enabled steps and cards only', () => {
		const nodes = [
			callNode('a', 'SW-1'),
			callNode('b', 'SW-2', { disabled: true }),
			{ id: 'c', pipeline: [{ id: 's', disabled: true, component: { type: 'sub_workflow', subWorkflowId: 'SW-3' } }] },
			callNode('d', 'SW-1'),
			callNode('e', '  subwf_old  '),
			{ id: 'f' }
		];
		assert.deepStrictEqual(collectSubWorkflowRefsFromNodes(nodes), ['SW-1', 'subwf_old']);
		assert.deepStrictEqual(collectSubWorkflowRefsFromNodes(undefined), []);
		const fields = [
			{ id: 'title', type: 'text' },
			{ id: 'call', type: 'sub_workflow', subWorkflowId: 'SW-9' },
			{ id: 'off', type: 'sub_workflow', subWorkflowId: 'SW-8', disabled: true },
			{ id: 'empty', type: 'sub_workflow', subWorkflowId: '' }
		];
		assert.deepStrictEqual(collectSubWorkflowRefsFromFields(fields), ['SW-9']);
	});

	test('collects run-ticket types from nodes and Run Tickets cards', () => {
		const nodes = [
			runTicketNode('a', 'job_report'),
			{ id: 'b', pipeline: [{ id: 's', type: 'component', component: { type: 'run_tickets', wfTicketType: 'digest' } }] },
			{ id: 'c', pipeline: [{ id: 's', type: 'run_ticket', ticketName: 'X' }] }
		];
		assert.deepStrictEqual(collectRunTicketTypesFromNodes(nodes), ['job_report', 'digest']);
		assert.deepStrictEqual(collectRunTicketTypesFromFields([{ type: 'run_tickets', wfTicketType: 'digest' }, { type: 'run_tickets', wfTicketTarget: '{x}' }]), ['digest']);
	});

	test('legacy ids normalise to the ticket ID', () => {
		const aliases = buildSubWorkflowAliasMap([{ id: 'SW-1', legacyId: 'subwf_abc' }, { id: 'subwf_unmigrated' }]);
		assert.strictEqual(normalizeSubWorkflowReference('subwf_abc', aliases), 'SW-1');
		assert.strictEqual(normalizeSubWorkflowReference(' SW-1 ', aliases), 'SW-1');
		assert.strictEqual(normalizeSubWorkflowReference('subwf_unmigrated', aliases), 'subwf_unmigrated');
		assert.strictEqual(normalizeSubWorkflowReference('SW-404', aliases), 'SW-404');
		assert.strictEqual(normalizeSubWorkflowReference(undefined, aliases), '');
	});

	test('graph cycle detection reports the chain, including self-recursion', () => {
		const g = new SubWorkflowCallGraph();
		const a = g.addNode({ kind: 'workflow', key: 'file:///w', label: 'A' });
		const b = g.addNode({ kind: 'sub_workflow', key: 'SW-1', label: 'B' });
		const c = g.addNode({ kind: 'sub_workflow', key: 'SW-2', label: 'C' });
		g.addEdge(a, b);
		g.addEdge(b, c);
		assert.strictEqual(g.findCycle(a), undefined);
		g.addEdge(c, b);
		assert.strictEqual(formatCallChain(g.findCycle(a)!), 'B -> C -> B');
		const self = new SubWorkflowCallGraph();
		const s = self.addNode({ kind: 'sub_workflow', key: 'SW-1', label: 'S' });
		self.addEdge(s, s);
		assert.strictEqual(formatCallChain(self.findCycle()!), 'S -> S');
	});

	test('no cycle for a normal workflow calling Sub-Workflows', async () => {
		const resolver = resolverOf([sub('SW-1', [callNode('n1', 'SW-2')]), sub('SW-2', [{ id: 'leaf' }])]);
		const cycle = await findSubWorkflowCallCycle({ kind: 'workflow', key: 'file:///main', label: 'Main', nodes: [callNode('x', 'SW-1'), callNode('y', 'SW-2')] }, resolver);
		assert.strictEqual(cycle, undefined);
	});

	test('direct self-recursion of a Sub-Workflow is a cycle', async () => {
		const resolver = resolverOf([sub('SW-1', [callNode('n1', 'SW-1')])]);
		const cycle = await findSubWorkflowCallCycle({ kind: 'workflow', key: 'file:///main', label: 'Main', nodes: [callNode('x', 'SW-1')] }, resolver);
		assert.strictEqual(formatCallChain(cycle!), 'Sub SW-1 (SW-1) -> Sub SW-1 (SW-1)');
		assert.ok(formatSubWorkflowCycleError(cycle!).includes('Sub SW-1 (SW-1) -> Sub SW-1 (SW-1)'));
	});

	test('indirect cycle through a legacy id is found', async () => {
		const resolver = resolverOf([
			sub('SW-1', [callNode('n1', 'SW-2')], { legacyId: 'subwf_one' }),
			sub('SW-2', [callNode('n2', 'subwf_one')])
		]);
		const cycle = await findSubWorkflowCallCycle({ kind: 'sub_workflow', key: 'SW-2' }, resolver);
		assert.strictEqual(formatCallChain(cycle!), 'Sub SW-2 (SW-2) -> Sub SW-1 (SW-1) -> Sub SW-2 (SW-2)');
	});

	test('template -> sub-workflow -> run ticket of the same template is a cycle', async () => {
		const templates: ITemplateGraphDefinition[] = [{ id: 'job_report', name: 'Job Report', fields: [{ id: 'call', type: 'sub_workflow', subWorkflowId: 'SW-1' }] }];
		const resolver = resolverOf([sub('SW-1', [runTicketNode('n1', 'Job Report')])], templates);
		const cycle = await findSubWorkflowCallCycle({ kind: 'template', key: 'job_report', label: 'Job Report', fields: templates[0].fields }, resolver);
		assert.strictEqual(formatCallChain(cycle!), 'Template \'Job Report\' -> Sub SW-1 (SW-1) -> Template \'Job Report\'');
	});

	test('a Sub-Workflow is walked from its own definition, never from the canvas it was extracted from', async () => {
		// Legacy nodes left on the parent canvas (same ids) call the Sub-Workflow, but its own definition is clean
		const resolver = resolverOf([sub('SW-1', [{ id: 'inner' }], { nodeIds: ['inner'], sourceWorkflowUri: 'file:///main' })]);
		const parentNodes = [callNode('capsule', 'SW-1'), callNode('inner', 'SW-1')];
		assert.strictEqual(await findSubWorkflowCallCycle({ kind: 'workflow', key: 'file:///main', label: 'Main', nodes: parentNodes }, resolver), undefined);
		// A self call saved on the Sub-Workflow's own canvas is a cycle
		const selfCalling = resolverOf([sub('SW-1', [callNode('inner', 'SW-1')])]);
		const cycle = await findSubWorkflowCallCycle({ kind: 'sub_workflow', key: 'SW-1' }, selfCalling);
		assert.strictEqual(formatCallChain(cycle!), 'Sub SW-1 (SW-1) -> Sub SW-1 (SW-1)');
	});

	test('unknown references and failing resolvers are leaves', async () => {
		const resolver: ISubWorkflowCallGraphResolver = {
			resolveSubWorkflow: async ref => { if (ref === 'boom') { throw new Error('x'); } return undefined; }
		};
		assert.strictEqual(await findSubWorkflowCallCycle({ kind: 'workflow', key: 'w', label: 'W', nodes: [callNode('a', 'boom'), callNode('b', 'SW-404')] }, resolver), undefined);
		assert.strictEqual(await findSubWorkflowCallCycle({ kind: 'sub_workflow', key: 'SW-404' }, resolver), undefined);
	});

	test('runtime guard: recursion by id, by legacy id and by workflow', () => {
		const root: ISubWorkflowCallFrame = { kind: 'workflow', key: 'file:///main', label: 'Main' };
		const s1 = subWorkflowCallFrame({ id: 'SW-1', legacyId: 'subwf_one', name: 'Fetch' });
		const chain = extendSubWorkflowCallChain(createSubWorkflowCallChain(root), s1);
		assert.strictEqual(checkSubWorkflowCall(chain.frames, subWorkflowCallFrame({ id: 'SW-2', name: 'Parse' })), undefined);
		assert.strictEqual(
			checkSubWorkflowCall(chain.frames, subWorkflowCallFrame({ id: 'SW-1', name: 'Fetch' })),
			'Sub-workflow recursion is not allowed: Fetch (SW-1) -> Fetch (SW-1) (call chain: Main -> Fetch (SW-1) -> Fetch (SW-1)). The run was stopped.'
		);
		assert.ok(checkSubWorkflowCall(chain.frames, subWorkflowCallFrame({ id: 'subwf_one', name: 'Fetch' }))?.includes('recursion'));
		assert.ok(checkSubWorkflowCall(chain.frames, { kind: 'workflow', key: 'file:///main', label: 'Main' })?.startsWith('Sub-workflow recursion is not allowed: Main -> Fetch (SW-1) -> Main'));
		// Tickets on the chain are informational only
		const withTicket = extendSubWorkflowCallChain(chain, { kind: 'ticket', key: 'JOB-1', label: 'Ticket JOB-1' });
		assert.strictEqual(checkSubWorkflowCall(withTicket.frames, { kind: 'ticket', key: 'JOB-1', label: 'Ticket JOB-1' }), undefined);
		assert.ok(checkSubWorkflowCall(withTicket.frames, s1)?.includes('Main -> Fetch (SW-1) -> Ticket JOB-1 -> Fetch (SW-1)'));
	});

	test('runtime guard: depth 5 is allowed, 6 stops the run', () => {
		assert.strictEqual(MAX_SUB_WORKFLOW_CALL_DEPTH, 5);
		let chain = createSubWorkflowCallChain({ kind: 'workflow', key: 'w', label: 'W' });
		for (let i = 1; i <= 5; i++) {
			const frame = subWorkflowCallFrame({ id: `SW-${i}`, name: `S${i}` });
			assert.strictEqual(checkSubWorkflowCall(chain.frames, frame), undefined, `level ${i}`);
			chain = extendSubWorkflowCallChain(chain, frame);
		}
		assert.strictEqual(getSubWorkflowCallDepth(chain.frames), 5);
		assert.strictEqual(
			checkSubWorkflowCall(chain.frames, subWorkflowCallFrame({ id: 'SW-6', name: 'S6' })),
			'Sub-workflow nesting is too deep (more than 5 levels): W -> S1 (SW-1) -> S2 (SW-2) -> S3 (SW-3) -> S4 (SW-4) -> S5 (SW-5) -> S6 (SW-6). The run was stopped.'
		);
	});

	test('extended chains share the abort state', () => {
		const chain = createSubWorkflowCallChain(undefined, 'run_1');
		const child = extendSubWorkflowCallChain(chain, subWorkflowCallFrame({ id: 'SW-1', name: 'S' }), 'subrun_1');
		child.abort.error = 'stop';
		assert.strictEqual(chain.abort.error, 'stop');
		assert.strictEqual(child.parentRunId, 'subrun_1');
		assert.strictEqual(chain.frames.length, 0);
	});

	test('template lookup by ticket type matches id, name and separators', () => {
		const templates = [{ id: 'job_report', name: 'Job Report' }];
		assert.strictEqual(findTemplateByTicketType(templates, 'JOB_REPORT')?.id, 'job_report');
		assert.strictEqual(findTemplateByTicketType(templates, 'job-report')?.id, 'job_report');
		assert.strictEqual(findTemplateByTicketType(templates, 'Job Report')?.id, 'job_report');
		assert.strictEqual(findTemplateByTicketType(templates, ''), undefined);
	});
});
