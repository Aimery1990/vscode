/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IExtractFrame,
	IExtractLinkLike,
	IExtractNodeLike,
	SUB_WORKFLOW_CALL_NODE_HEIGHT,
	SUB_WORKFLOW_CALL_NODE_WIDTH,
	SUB_WORKFLOW_CANVAS_ORIGIN,
	buildExtractInputBindings,
	buildSubWorkflowCallNode,
	collectCanvasVariableNames,
	extractSubWorkflowFromCanvas,
	findVariablesUsedOutsideSelection
} from '../../common/subWorkflowExtract.js';

function node(id: string, x: number, y: number, pipeline?: unknown[]): IExtractNodeLike {
	return { id, x, y, width: 100, height: 50, label: id, pipeline };
}

function link(id: string, from: string, to: string, extra?: Partial<IExtractLinkLike>): IExtractLinkLike {
	return { id, from, to, ...extra };
}

const makeCall = (frame: IExtractFrame): IExtractNodeLike => ({ id: 'call', ...frame, label: 'Call' });

suite('subWorkflowExtract', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// start -> a -> b -> end, with a and b extracted
	const nodes = [node('start', 0, 0), node('a', 200, 100), node('b', 400, 100), node('end', 600, 0)];
	const links = [
		link('l1', 'start', 'a', { toPort: 'left', waypoints: [{ x: 150, y: 50 }] }),
		link('l2', 'a', 'b', { waypoints: [{ x: 350, y: 120 }] }),
		link('l3', 'b', 'end', { fromPort: 'right' })
	];

	test('moves the selection into the sub-workflow and replaces it with one call node', () => {
		const result = extractSubWorkflowFromCanvas(nodes, links, ['a', 'b'], makeCall);
		if (result.error !== undefined) {
			assert.fail(result.error);
		}
		assert.deepStrictEqual(result.subNodes.map(n => [n.id, n.x, n.y]), [['a', SUB_WORKFLOW_CANVAS_ORIGIN.x, SUB_WORKFLOW_CANVAS_ORIGIN.y], ['b', SUB_WORKFLOW_CANVAS_ORIGIN.x + 200, SUB_WORKFLOW_CANVAS_ORIGIN.y]]);
		assert.deepStrictEqual(result.subLinks.map(l => [l.id, l.from, l.to]), [['l2', 'a', 'b']]);
		assert.deepStrictEqual(result.subLinks[0].waypoints, [{ x: 350 - 200 + SUB_WORKFLOW_CANVAS_ORIGIN.x, y: 120 - 100 + SUB_WORKFLOW_CANVAS_ORIGIN.y }]);
		// Parent: no duplicates, the call node sits where the first moved node was (z-order) and in the selection center
		assert.deepStrictEqual(result.parentNodes.map(n => n.id), ['start', 'call', 'end']);
		assert.strictEqual(result.callNode.width, SUB_WORKFLOW_CALL_NODE_WIDTH);
		assert.strictEqual(result.callNode.x, Math.round(200 + 300 / 2 - SUB_WORKFLOW_CALL_NODE_WIDTH / 2));
		assert.strictEqual(result.callNode.y, Math.round(100 + 50 / 2 - SUB_WORKFLOW_CALL_NODE_HEIGHT / 2));
		// Border links rewired; the touching end loses its port and waypoints, the other end keeps its own
		assert.deepStrictEqual(result.parentLinks, [link('l1', 'start', 'call'), link('l3', 'call', 'end')]);
		assert.strictEqual(result.incomingLinkCount, 1);
		assert.strictEqual(result.outgoingLinkCount, 1);
		assert.deepStrictEqual(result.warnings, []);
		// Inputs are never mutated
		assert.strictEqual(nodes[1].x, 200);
		assert.strictEqual(links[0].to, 'a');
	});

	test('keeps labelled branches, merges plain duplicates and warns about several entries and conditional exits', () => {
		const n = [node('d', 0, 0), node('x', 200, 0), node('y', 200, 100), node('z', 400, 0), node('w', 400, 100)];
		const l = [
			link('yes', 'd', 'x', { label: 'Yes' }),
			link('no', 'd', 'y', { label: 'No' }),
			link('p1', 'x', 'z'),
			link('p2', 'y', 'z'),
			link('c', 'y', 'w', { condition: 'ok == False' })
		];
		const result = extractSubWorkflowFromCanvas(n, l, ['x', 'y'], makeCall);
		if (result.error !== undefined) {
			assert.fail(result.error);
		}
		assert.deepStrictEqual(result.parentLinks.map(k => [k.id, k.from, k.to]), [['yes', 'd', 'call'], ['no', 'd', 'call'], ['p1', 'call', 'z'], ['c', 'call', 'w']]);
		assert.strictEqual(result.warnings.length, 2);
		assert.ok(result.warnings[0].includes('2 different selected nodes'));
		assert.ok(result.warnings[1].includes('label / condition'));
	});

	test('a selection without border links and errors', () => {
		const result = extractSubWorkflowFromCanvas([node('a', 0, 0)], [], ['a'], makeCall);
		if (result.error !== undefined) {
			assert.fail(result.error);
		}
		assert.deepStrictEqual(result.parentNodes.map(n => n.id), ['call']);
		assert.deepStrictEqual(result.parentLinks, []);
		assert.ok(extractSubWorkflowFromCanvas(nodes, links, ['missing'], makeCall).error);
		assert.ok(extractSubWorkflowFromCanvas(nodes, links, ['a'], f => ({ ...makeCall(f), id: 'start' })).error);
	});

	test('binds inputs to parent variables of the same name only when the parent sets them', () => {
		const parent = [
			{ id: 'p', pipeline: [{ targetVariable: '@query', component: { type: 'python', outputVariableName: 'rows' } }, { component: { type: 'parameters', parameters: [{ name: 'limit' }] } }] },
			{ id: 'q', outputVariables: [{ name: 'count' }] }
		];
		const vars = collectCanvasVariableNames(parent);
		assert.deepStrictEqual([...vars].sort(), ['count', 'limit', 'query', 'rows']);
		assert.deepStrictEqual(buildExtractInputBindings([{ name: 'query' }, { name: 'other' }, { name: 'limit' }], vars), { query: '{query}', other: '', limit: '{limit}' });
	});

	test('finds variables set inside the selection that the parent still uses', () => {
		const moved = [{ id: 'a', pipeline: [{ targetVariable: 'summary', component: { type: 'prompt' } }, { component: { type: 'parameters', parameters: [{ name: 'topic' }] } }, { targetVariable: 'ok' }] }];
		const remaining = [{ id: 'b', pipeline: [{ expression: 'print({summary}) and topic and ok' }] }, { id: 'c', pipeline: [{ expression: 'summary_count = 1' }] }];
		assert.deepStrictEqual(findVariablesUsedOutsideSelection(moved, remaining), ['summary']);
		assert.deepStrictEqual(findVariablesUsedOutsideSelection([], remaining), []);
	});

	test('builds the call node with one Call Sub-Workflow step', () => {
		const callNode = buildSubWorkflowCallNode({
			nodeId: 'n1',
			stepId: 's1',
			componentId: 'c1',
			frame: { x: 10, y: 20, width: 220, height: 90 },
			subWorkflow: { id: 'FINDJ-0042', name: 'Lead Search', sourceWorkflowUri: 'file:///w', inputs: [{ name: 'query', defaultValue: 'AI' }], outputs: [{ label: 'Rows', varName: 'rows', defaultFormat: 'table' }] },
			inputBindings: { query: '{query}' }
		});
		assert.strictEqual(callNode.pipeline.length, 1);
		const comp = callNode.pipeline[0].component;
		assert.strictEqual(comp.type, 'sub_workflow');
		assert.strictEqual(comp.subWorkflowId, 'FINDJ-0042');
		assert.deepStrictEqual(comp.subWorkflowInputs, { query: '{query}' });
		assert.deepStrictEqual(comp.subWorkflowInputDefs, [{ name: 'query', label: undefined, defaultValue: 'AI' }]);
		assert.deepStrictEqual(comp.subWorkflowOutputDefs, [{ label: 'Rows', varName: 'rows', defaultFormat: 'table' }]);
		assert.strictEqual(callNode.label, 'Lead Search');
		assert.deepStrictEqual([callNode.x, callNode.y, callNode.width, callNode.height], [10, 20, 220, 90]);
	});
});
