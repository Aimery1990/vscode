/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ICustomModulesService } from '../../customModules/common/customModules.js';
import { IEntityPersistenceService } from '../../entityPersistence/common/entityPersistence.js';
import { ITicketWorkflowRuntimeService } from './ticketWorkflowRuntime.js';
import { WorkflowEditorInput } from './workflowEditorInput.js';
import { WorkflowNotebookEditorInput } from './workflowNotebookEditor.js';
import { INodePipelineStep, INodeVariable, WorkflowEditor } from './workflowEditor.js';

export interface ISyncFlowchartNode {
	id: string;
	groupId?: string;
	type: 'rect' | 'round-rect' | 'diamond' | 'circle';
	x: number;
	y: number;
	width: number;
	height: number;
	label: string;
	imports?: { type: string; name: string; uri?: string; parameters?: string }[];
	outputVariable?: INodeVariable;
	outputVariables?: INodeVariable[];
	pipeline?: INodePipelineStep[];
	color?: string;
	textColor?: string;
	textAlign?: 'left' | 'center' | 'right';
	verticalAlign?: 'top' | 'center' | 'bottom';
	titleTextAlign?: 'left' | 'center' | 'right';
	titleVerticalAlign?: 'top' | 'center' | 'bottom';
	isBold?: boolean;
	isItalic?: boolean;
	isUnderline?: boolean;
	isStrikethrough?: boolean;
}

export interface ISyncFlowchartLink {
	id: string;
	from: string;
	fromPort?: 'top' | 'right' | 'bottom' | 'left';
	to: string;
	toPort?: 'top' | 'right' | 'bottom' | 'left';
	style: 'arrow-single' | 'arrow-double' | 'arrow-none' | 'dashed';
	routing?: 'orthogonal' | 'curved';
	color?: string;
	label?: string;
	condition?: string;
	labelPosition?: number;
	labelWidth?: number;
	labelHeight?: number;
	waypoints?: { x: number; y: number }[];
}

export interface ISyncFlowchartData {
	nodes: ISyncFlowchartNode[];
	links: ISyncFlowchartLink[];
	routingMode?: 'orthogonal' | 'curved';
	pythonPath?: string;
}

export interface IParsedNodeSection {
	nodeId: string;
	title: string;
	shape: string;
	code: string;
	headerStartLine: number; // 1-based line number in file
	codeStartLine: number;   // 1-based line number where editable code area starts
}

export interface IParsedConnectionSection {
	connectionId: string;
	title: string;
	sourceNodeId: string;
	targetNodeId: string;
	headerCondition: string;
	code: string;
	condition: string;
	connectionStyle: string;
	headerStartLine: number; // 1-based line number in file
	codeStartLine: number;   // 1-based line number where editable condition code area starts
}

export interface IParsedWorkflowPythonFile {
	workflowId?: string;
	workflowName?: string;
	workflowUri?: string;
	nodes: IParsedNodeSection[];
	connections: IParsedConnectionSection[];
	errors: { message: string; line: number }[];
}

export interface ISyncValidationError {
	message: string;
	line?: number;
	nodeId?: string;
	connectionId?: string;
}

export interface IWorkflowPythonSyncResult {
	success: boolean;
	errors: ISyncValidationError[];
	warnings: string[];
	updatedNodesCount: number;
	updatedConnectionsCount: number;
	missingNodeIds: string[];
	missingConnectionIds: string[];
}

export interface IAstStatementSpan {
	lineno: number;     // 1-based relative to node code block
	end_lineno: number; // 1-based relative to node code block
}

export const SECTION_DIVIDER = '# ============================================================';
export const NODE_CODE_INSTRUCTION = '# >>> WRITE NODE CODE BELOW <<<';
export const CONNECTION_CODE_INSTRUCTION = '# >>> WRITE CONNECTION CONDITION CODE BELOW <<<';
export const STEP_SEPARATOR = '###';

const PYTHON_KEYWORDS = new Set([
	'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
	'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
	'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
	'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
	'try', 'while', 'with', 'yield', 'match', 'case'
]);

/**
 * Checks whether a comment line is a system-generated metadata or instructional comment
 * (Section 1.3: must never become executable Python Steps or user comments).
 */
export function isSystemMetadataOrInstructionLine(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.startsWith('#')) {
		return false;
	}
	if (/^#\s*={15,}\s*$/.test(trimmed)) {
		return true;
	}
	if (/^#\s*>>>\s*WRITE NODE CODE BELOW\s*<<<\s*$/i.test(trimmed)) {
		return true;
	}
	if (/^#\s*>>>\s*WRITE CONNECTION CONDITION CODE BELOW\s*<<<\s*$/i.test(trimmed)) {
		return true;
	}
	if (/^#\s*(?:NODE|NODE_ID|SHAPE|CONNECTION|CONNECTION_ID|SOURCE_NODE_ID|TARGET_NODE_ID|CONDITION|CONNECTION_STYLE|WORKFLOW_ID|WORKFLOW_NAME|WORKFLOW_URI|WORKFLOW_PYTHON_SYNC_V1)\s*:/i.test(trimmed)) {
		return true;
	}
	return false;
}

/**
 * Maps internal node shape type <-> human-readable SHAPE metadata
 */
export function nodeTypeToShapeName(type: ISyncFlowchartNode['type']): string {
	switch (type) {
		case 'circle':
			return 'Circle Node';
		case 'diamond':
			return 'Decision';
		case 'rect':
			return 'Rectangle';
		case 'round-rect':
		default:
			return 'Round Rect';
	}
}

export function shapeNameToNodeType(shape: string, fallback: ISyncFlowchartNode['type'] = 'round-rect'): ISyncFlowchartNode['type'] {
	const norm = (shape || '').trim().toLowerCase();
	if (norm === 'circle node' || norm === 'circle' || norm === 'start') {
		return 'circle';
	}
	if (norm === 'decision' || norm === 'diamond') {
		return 'diamond';
	}
	if (norm === 'rectangle' || norm === 'rect') {
		return 'rect';
	}
	if (norm === 'round rect' || norm === 'round-rect' || norm === 'round_rect') {
		return 'round-rect';
	}
	return fallback;
}

/**
 * Maps internal connection style <-> human-readable CONNECTION_STYLE metadata
 */
export function linkStyleToConnectionStyleName(style: ISyncFlowchartLink['style']): string {
	switch (style) {
		case 'arrow-double':
			return 'Double Arrow';
		case 'arrow-none':
			return 'No Arrow';
		case 'dashed':
			return 'Dashed Line';
		case 'arrow-single':
		default:
			return 'Single Arrow';
	}
}

export function connectionStyleNameToLinkStyle(styleName: string, fallback: ISyncFlowchartLink['style'] = 'arrow-single'): ISyncFlowchartLink['style'] {
	const norm = (styleName || '').trim().toLowerCase();
	if (norm === 'double arrow' || norm === 'arrow-double') {
		return 'arrow-double';
	}
	if (norm === 'no arrow' || norm === 'arrow-none' || norm === 'none') {
		return 'arrow-none';
	}
	if (norm === 'dashed line' || norm === 'dashed') {
		return 'dashed';
	}
	if (norm === 'single arrow' || norm === 'arrow-single') {
		return 'arrow-single';
	}
	return fallback;
}

/**
 * Safely encodes single-line metadata values so newlines or carriage returns cannot break comment headers
 */
export function encodeMetadataText(raw: string | undefined): string {
	if (!raw) return '';
	return String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\\n');
}

export function decodeMetadataText(encoded: string | undefined): string {
	if (!encoded) return '';
	return String(encoded).replace(/\\n/g, '\n');
}

/**
 * Determines whether a pipeline step is a non-PythonStep component (e.g. AI Prompt, Data Table, Inputs, Output, Python Script component, etc.)
 * that is managed by the Workflow and displayed as a positional comment in `.workflow.py`.
 */
export function isComponentPipelineStep(step: INodePipelineStep): boolean {
	if (!step) {
		return false;
	}
	return step.type === 'run_ticket' || step.type === 'component' || Boolean((step as any).component);
}

/**
 * Formats a non-PythonStep component into a structured single-line Python comment indicating
 * its 1-based step position in the node, component type, component name / output variable, and component ID anchor.
 */
export function formatComponentStepComment(step: INodePipelineStep, stepNumber: number): string {
	const comp: any = (step as any).component;
	if (comp) {
		const rawType = String(comp.type || 'component');
		const typeLabels: Record<string, string> = {
			parameters: 'Inputs',
			output: 'Output',
			result: 'Output',
			prompt: 'AI Prompt',
			python: 'Python Script',
			table: 'Data Table',
			browser: 'Browser',
			tts: 'O2 TTS',
			ssh: 'SSH Terminal',
			http_request: 'HTTP Request',
			git: 'Git Branch',
			create_tickets: 'Create Tickets',
			run_tickets: 'Run Tickets',
			get_outputs: 'Get Outputs',
			get_tickets: 'Get Tickets',
			display: 'Display'
		};
		const compTypeLabel = typeLabels[rawType] || rawType;
		const compId = String(comp.id || step.id || `step_${stepNumber}`).replace(/[\r\n\]]/g, '').trim();
		const varName = (rawType !== 'parameters' && rawType !== 'output' && rawType !== 'result' && rawType !== 'display')
			? String(comp.outputVariableName || step.targetVariable || '').replace(/^@/, '').trim()
			: '';
		const rawLabel = String(comp.label || step.label || compTypeLabel).replace(/\r?\n/g, ' ').trim();

		let summary = '';
		if (rawType === 'parameters') {
			const params = Array.isArray(comp.parameters) ? comp.parameters : [];
			const pairs = params.map((p: any) => `${p.name}=${p.defaultValue !== undefined && p.defaultValue !== '' ? p.defaultValue : '""'}`);
			summary = params.length > 0 ? `Inputs (${params.length}): ${pairs.join(', ')}` : 'Inputs';
		} else if (rawType === 'output' || rawType === 'result') {
			const specs = Array.isArray(comp.outputSpecs) ? comp.outputSpecs : [];
			const pairs = specs.map((s: any) => `${s.name || s.label || s.fieldKey}=${s.value || '""'}`);
			summary = specs.length > 0 ? `Output (${specs.length}): ${pairs.join(', ')}` : 'Output';
		} else if (rawType === 'table') {
			const tblName = String(comp.tableDbTableName || comp.tableName || comp.label || 'Data Table').replace(/\r?\n/g, ' ').trim() || 'Data Table';
			const displayName = (rawLabel && rawLabel !== tblName && rawLabel !== 'Data Table')
				? `${tblName} [Label: ${rawLabel}]`
				: tblName;
			summary = varName ? `${varName} = ${displayName} (${compTypeLabel})` : `${displayName} (${compTypeLabel})`;
		} else {
			summary = varName ? `${varName} = ${rawLabel} (${compTypeLabel})` : `${rawLabel} (${compTypeLabel})`;
		}

		return `# [Step #${stepNumber} | Component: ${compTypeLabel}] ${summary} [COMPONENT_ID: ${compId}]`;
	}

	if (step.type === 'run_ticket') {
		const ticketName = (step.ticketName || 'Ticket').replace(/\r?\n/g, ' ').trim();
		const paramSuffix = step.parameters ? ` (${String(step.parameters).replace(/\r?\n/g, ' ').trim()})` : '';
		const stepId = String(step.id || `step_${stepNumber}`).replace(/[\r\n\]]/g, '').trim();
		return `# [Step #${stepNumber} | Component: Run Ticket] ${ticketName}${paramSuffix} [COMPONENT_ID: ${stepId}]`;
	}

	const fallbackId = String(step.id || `step_${stepNumber}`).replace(/[\r\n\]]/g, '').trim();
	const fallbackLabel = String(step.label || step.expression || 'Component').replace(/\r?\n/g, ' ').trim();
	return `# [Step #${stepNumber} | Component] ${fallbackLabel} [COMPONENT_ID: ${fallbackId}]`;
}

/**
 * Parses a single line to check if it is a system-generated Component Comment anchor line.
 */
export function parseComponentCommentAnchor(line: string): { componentId?: string; stepNumber?: number } | null {
	const trimmed = (line || '').trim();
	if (!trimmed.startsWith('#')) {
		return null;
	}
	const stepHeaderMatch = trimmed.match(/^#\s*\[(?:Component\s+)?Step\s*#(\d+)(?:\/\d+)?\s*\|\s*Component(?:\s*:\s*[^\]]+)?\]/i);
	const compIdMatch = trimmed.match(/\[COMPONENT_ID:\s*([^\]]+)\]/i);
	if (!stepHeaderMatch && !compIdMatch) {
		return null;
	}
	return {
		componentId: compIdMatch ? compIdMatch[1].trim() : undefined,
		stepNumber: stepHeaderMatch ? parseInt(stepHeaderMatch[1], 10) : undefined
	};
}

/**
 * Extracts executable Python code strings from a node's existing pipeline / outputVariables
 */
export function extractNodePythonStepStrings(node: ISyncFlowchartNode): string[] {
	const steps: string[] = [];

	if (Array.isArray(node.pipeline) && node.pipeline.length > 0) {
		const callFnExprs = new Set<string>();
		const callFnTargets = new Set<string>();
		for (const s of node.pipeline) {
			if (!isComponentPipelineStep(s) && s.type === 'call_function') {
				const cleanE = (s.expression || '').replace(/(^|[^a-zA-Z0-9_])@([a-zA-Z_][a-zA-Z0-9_]*)/g, '$1$2').trim();
				if (cleanE) {
					callFnExprs.add(cleanE);
				}
				const cleanT = (s.targetVariable || '').replace(/^@/, '').trim();
				if (cleanT) {
					callFnTargets.add(cleanT);
				}
			}
		}

		for (const step of node.pipeline) {
			if (isComponentPipelineStep(step)) {
				continue;
			}
			if (step.type === 'set_variable') {
				const cleanVar = (step.targetVariable || '').replace(/^@/, '').trim();
				const rawExpr = (step.expression ?? 'None').replace(/(^|[^a-zA-Z0-9_])@([a-zA-Z_][a-zA-Z0-9_]*)/g, '$1$2').trim();
				if (!cleanVar && !rawExpr) continue;
				// Skip legacy duplicate set_variable steps that were auto-generated from call_function outputVariables
				if (rawExpr && callFnExprs.has(rawExpr)) {
					continue;
				}
				if (cleanVar && callFnTargets.has(cleanVar) && rawExpr.includes('(')) {
					continue;
				}
				if (cleanVar) {
					const startsWithVarAssign = new RegExp(`^${cleanVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:\\+|-|\\*|\\/)?=(?!=)`).test(rawExpr);
					steps.push(startsWithVarAssign ? rawExpr : `${cleanVar} = ${rawExpr || 'None'}`);
				} else if (rawExpr) {
					steps.push(rawExpr);
				}
			} else {
				// call_function or custom_code
				const rawExpr = (step.expression || '').replace(/(^|[^a-zA-Z0-9_])@([a-zA-Z_][a-zA-Z0-9_]*)/g, '$1$2').trim();
				if (rawExpr) {
					steps.push(rawExpr);
				}
			}
		}
		return steps;
	}

	// Fallback if node has legacy outputVariables but no pipeline yet
	const vars = Array.isArray(node.outputVariables) && node.outputVariables.length > 0
		? node.outputVariables
		: (node.outputVariable ? [node.outputVariable] : []);

	for (const v of vars) {
		const cleanVar = (v.name || '').replace(/^@/, '').trim();
		const rawExpr = (v.expression || v.initialValue || 'None').replace(/(^|[^a-zA-Z0-9_])@([a-zA-Z_][a-zA-Z0-9_]*)/g, '$1$2').trim();
		if (!cleanVar) continue;
		const startsWithVarAssign = new RegExp(`^${cleanVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:\\+|-|\\*|\\/)?=(?!=)`).test(rawExpr);
		steps.push(startsWithVarAssign ? rawExpr : `${cleanVar} = ${rawExpr}`);
	}

	return steps;
}

/**
 * Extracts all node steps in exact pipeline order for Workflow -> Python synchronization:
 * - Python Steps emit actual executable Python code.
 * - Non-PythonStep components emit a structured `# [Step #k | Component: ...]` comment indicating type, name, and position.
 */
export function extractNodeStepAndComponentStrings(node: ISyncFlowchartNode): string[] {
	if (Array.isArray(node.pipeline) && node.pipeline.length > 0) {
		const callFnExprs = new Set<string>();
		const callFnTargets = new Set<string>();
		for (const s of node.pipeline) {
			if (!isComponentPipelineStep(s) && s.type === 'call_function') {
				const cleanE = (s.expression || '').replace(/(^|[^a-zA-Z0-9_])@([a-zA-Z_][a-zA-Z0-9_]*)/g, '$1$2').trim();
				if (cleanE) {
					callFnExprs.add(cleanE);
				}
				const cleanT = (s.targetVariable || '').replace(/^@/, '').trim();
				if (cleanT) {
					callFnTargets.add(cleanT);
				}
			}
		}

		const items: string[] = [];
		let visibleStepIdx = 0;
		for (const step of node.pipeline) {
			if (isComponentPipelineStep(step)) {
				visibleStepIdx++;
				items.push(formatComponentStepComment(step, visibleStepIdx));
				continue;
			}
			if (step.type === 'set_variable') {
				const cleanVar = (step.targetVariable || '').replace(/^@/, '').trim();
				const rawExpr = (step.expression ?? 'None').replace(/(^|[^a-zA-Z0-9_])@([a-zA-Z_][a-zA-Z0-9_]*)/g, '$1$2').trim();
				if (!cleanVar && !rawExpr) continue;
				if (rawExpr && callFnExprs.has(rawExpr)) {
					continue;
				}
				if (cleanVar && callFnTargets.has(cleanVar) && rawExpr.includes('(')) {
					continue;
				}
				visibleStepIdx++;
				if (cleanVar) {
					const startsWithVarAssign = new RegExp(`^${cleanVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:\\+|-|\\*|\\/)?=(?!=)`).test(rawExpr);
					items.push(startsWithVarAssign ? rawExpr : `${cleanVar} = ${rawExpr || 'None'}`);
				} else if (rawExpr) {
					items.push(rawExpr);
				}
			} else {
				const rawExpr = (step.expression || '').replace(/(^|[^a-zA-Z0-9_])@([a-zA-Z_][a-zA-Z0-9_]*)/g, '$1$2').trim();
				if (rawExpr) {
					visibleStepIdx++;
					items.push(rawExpr);
				}
			}
		}
		return items;
	}

	return extractNodePythonStepStrings(node);
}

/**
 * 1. WorkflowToPythonConverter
 * Converts a Workflow graph into a structured, human-editable Python file with spacious Node and Connection code areas.
 */
export class WorkflowToPythonConverter {
	/**
	 * Orders nodes following Section 5:
	 * 1. Top-to-bottom (y), then Left-to-right (x)
	 * 2. Respects workflow connection relationships (Start / root nodes -> connected paths -> parallel branches)
	 * 3. Cycle-safe: every node and every connection appears exactly once
	 */
	public static computeOrderedNodesAndConnections(
		data: ISyncFlowchartData
	): Array<{ kind: 'node'; node: ISyncFlowchartNode } | { kind: 'connection'; link: ISyncFlowchartLink }> {
		const nodes = Array.isArray(data.nodes) ? [...data.nodes] : [];
		const links = Array.isArray(data.links) ? [...data.links] : [];

		const nodeById = new Map<string, ISyncFlowchartNode>();
		for (const n of nodes) {
			nodeById.set(n.id, n);
		}

		// Visual comparator: top-to-bottom (with 35px row band tolerance), then left-to-right
		const visualCompareNodes = (a: ISyncFlowchartNode, b: ISyncFlowchartNode): number => {
			const dy = (a.y || 0) - (b.y || 0);
			if (Math.abs(dy) > 35) {
				return dy;
			}
			const dx = (a.x || 0) - (b.x || 0);
			if (dx !== 0) {
				return dx;
			}
			return dy;
		};

		const outgoingByNode = new Map<string, ISyncFlowchartLink[]>();
		const inDegree = new Map<string, number>();
		for (const n of nodes) {
			outgoingByNode.set(n.id, []);
			inDegree.set(n.id, 0);
		}

		const orphanLinks: ISyncFlowchartLink[] = [];
		for (const l of links) {
			if (nodeById.has(l.from) && nodeById.has(l.to)) {
				outgoingByNode.get(l.from)!.push(l);
				if (l.from !== l.to) {
					inDegree.set(l.to, (inDegree.get(l.to) || 0) + 1);
				}
			} else {
				orphanLinks.push(l);
			}
		}

		// Sort outgoing links from each node by target node visual position
		for (const [, outList] of outgoingByNode.entries()) {
			outList.sort((la, lb) => {
				const ta = nodeById.get(la.to);
				const tb = nodeById.get(lb.to);
				if (ta && tb) {
					return visualCompareNodes(ta, tb);
				}
				return la.id.localeCompare(lb.id);
			});
		}

		const visitedNodes = new Set<string>();
		const emittedLinks = new Set<string>();
		const currentInDegree = new Map<string, number>(inDegree);
		const sequence: Array<{ kind: 'node'; node: ISyncFlowchartNode } | { kind: 'connection'; link: ISyncFlowchartLink }> = [];

		const isStartNode = (n: ISyncFlowchartNode): boolean =>
			n.type === 'circle' && n.label.trim().toLowerCase() === 'start';
		const isConnected = (n: ISyncFlowchartNode): boolean =>
			(outgoingByNode.get(n.id)?.length || 0) > 0 || (inDegree.get(n.id) || 0) > 0;

		const rootCandidates = [...nodes].sort((a, b) => {
			const aConn = isConnected(a) ? 0 : 1;
			const bConn = isConnected(b) ? 0 : 1;
			if (aConn !== bConn) return aConn - bConn;
			const aStart = isStartNode(a) ? 0 : 1;
			const bStart = isStartNode(b) ? 0 : 1;
			if (aStart !== bStart) return aStart - bStart;
			return visualCompareNodes(a, b);
		});

		const visitFrom = (startNode: ISyncFlowchartNode) => {
			const queue: ISyncFlowchartNode[] = [startNode];
			while (queue.length > 0) {
				queue.sort(visualCompareNodes);
				const curr = queue.shift()!;
				if (visitedNodes.has(curr.id)) {
					continue;
				}
				visitedNodes.add(curr.id);
				sequence.push({ kind: 'node', node: curr });

				const outLinks = outgoingByNode.get(curr.id) || [];
				const newlyReadyTargets: ISyncFlowchartNode[] = [];

				for (const link of outLinks) {
					if (!emittedLinks.has(link.id)) {
						emittedLinks.add(link.id);
						sequence.push({ kind: 'connection', link });
					}
					const target = nodeById.get(link.to);
					if (target && !visitedNodes.has(target.id)) {
						const rem = (currentInDegree.get(target.id) || 1) - 1;
						currentInDegree.set(target.id, rem);
						if (rem <= 0) {
							newlyReadyTargets.push(target);
						}
					}
				}

				newlyReadyTargets.sort(visualCompareNodes);
				for (const t of newlyReadyTargets) {
					if (!visitedNodes.has(t.id) && !queue.includes(t)) {
						queue.push(t);
					}
				}
			}
		};

		// First pass: start from all in-degree 0 nodes
		for (const candidate of rootCandidates) {
			if (!visitedNodes.has(candidate.id) && (inDegree.get(candidate.id) || 0) === 0) {
				visitFrom(candidate);
			}
		}

		// Second pass: handle any remaining nodes (e.g. in cycles) in visual order
		for (const candidate of rootCandidates) {
			if (!visitedNodes.has(candidate.id)) {
				visitFrom(candidate);
			}
		}

		// Ensure no link was left behind
		for (const l of [...links, ...orphanLinks]) {
			if (!emittedLinks.has(l.id)) {
				emittedLinks.add(l.id);
				sequence.push({ kind: 'connection', link: l });
			}
		}

		return sequence;
	}

	public static convertWorkflowToPython(
		data: ISyncFlowchartData,
		metadata?: { workflowId?: string; workflowName?: string; workflowUri?: string }
	): string {
		const lines: string[] = [];

		lines.push(SECTION_DIVIDER);
		lines.push('# WORKFLOW_PYTHON_SYNC_V1');
		if (metadata?.workflowId) {
			lines.push(`# WORKFLOW_ID: ${encodeMetadataText(metadata.workflowId)}`);
		}
		if (metadata?.workflowName) {
			lines.push(`# WORKFLOW_NAME: ${encodeMetadataText(metadata.workflowName)}`);
		}
		if (metadata?.workflowUri) {
			lines.push(`# WORKFLOW_URI: ${encodeMetadataText(metadata.workflowUri)}`);
		}
		lines.push('# Instructions:');
		lines.push('# - Write node Python code in the editable area of each # NODE section.');
		lines.push('# - Separate multiple independent Python Steps within a node using a standalone "###" line.');
		lines.push('# - Non-Python components are shown as "# [Step #... | Component: ...]" comments to indicate their position (read-only in Python; managed in Workflow).');
		lines.push('# - Write connection condition code in the editable area of each # CONNECTION section.');
		lines.push('# - Click "Sync to Workflow" in the editor toolbar to apply changes back to the visual workflow.');
		lines.push(SECTION_DIVIDER);
		lines.push('');
		lines.push('');

		const nodeById = new Map<string, ISyncFlowchartNode>();
		for (const n of data.nodes || []) {
			nodeById.set(n.id, n);
		}

		const orderedItems = this.computeOrderedNodesAndConnections(data);

		for (const item of orderedItems) {
			if (item.kind === 'node') {
				const node = item.node;
				const shapeStr = nodeTypeToShapeName(node.type);
				lines.push(SECTION_DIVIDER);
				lines.push(`# NODE: ${encodeMetadataText(node.label || node.id)}`);
				lines.push(`# NODE_ID: ${encodeMetadataText(node.id)}`);
				lines.push(`# SHAPE: ${shapeStr}`);
				lines.push(SECTION_DIVIDER);
				lines.push(NODE_CODE_INSTRUCTION);

				const stepStrings = extractNodeStepAndComponentStrings(node);
				if (stepStrings.length > 0) {
					// Separate multiple independent steps / component position markers with standalone `###` lines
					lines.push(stepStrings.join(`\n${STEP_SEPARATOR}\n`));
				}
				// Provide spacious vertical editing room at the bottom of every node code area
				lines.push('');
				lines.push('');
				lines.push('');
			} else {
				const link = item.link;
				const srcNode = nodeById.get(link.from);
				const tgtNode = nodeById.get(link.to);
				const srcTitle = encodeMetadataText(srcNode?.label || link.from);
				const tgtTitle = encodeMetadataText(tgtNode?.label || link.to);
				const condCode = (link.condition ?? link.label ?? '').replace(/\r\n/g, '\n').trim();
				const styleStr = linkStyleToConnectionStyleName(link.style);

				lines.push(SECTION_DIVIDER);
				lines.push(`# CONNECTION: ${srcTitle} -> ${tgtTitle}`);
				lines.push(`# CONNECTION_ID: ${encodeMetadataText(link.id)}`);
				lines.push(`# SOURCE_NODE_ID: ${encodeMetadataText(link.from)}`);
				lines.push(`# TARGET_NODE_ID: ${encodeMetadataText(link.to)}`);
				lines.push('# CONDITION:');
				lines.push(`# CONNECTION_STYLE: ${styleStr}`);
				lines.push(SECTION_DIVIDER);
				lines.push(CONNECTION_CODE_INSTRUCTION);

				if (condCode) {
					lines.push(condCode);
				}
				// Provide spacious vertical editing room at the bottom of every connection code area
				lines.push('');
				lines.push('');
				lines.push('');
			}
		}

		return lines.join('\n');
	}
}

/**
 * 2. PythonCodeBlockParser
 * Validates Python syntax and splits node code into independent Python Steps using:
 * - Top-level Python AST statement boundaries (never splitting inside loops, ifs, functions, classes, or multiline brackets/strings)
 * - Standalone `###` line at a valid top-level statement boundary as the step separator
 * - Excludes system metadata and instructional comments (`# >>> WRITE NODE CODE BELOW <<<`, etc.)
 */
export class PythonCodeBlockParser {
	/**
	 * Built-in structural Python lexer & top-level AST statement analyzer.
	 * Detects syntax errors (unclosed quotes, unclosed brackets/parens/braces, bad indentation, invalid compound headers)
	 * and returns top-level statement line spans (1-based).
	 */
	public static analyzePythonTopLevelStatements(
		code: string,
		baseFileLine: number = 1
	): { statements: IAstStatementSpan[]; syntaxError?: { message: string; line: number } } {
		const rawLines = code.replace(/\r\n/g, '\n').split('\n');
		const numLines = rawLines.length;

		const lineStartsInExpr: boolean[] = new Array(numLines).fill(false);
		const lineEndsInExpr: boolean[] = new Array(numLines).fill(false);
		const lineCodeWithoutComment: string[] = new Array(numLines).fill('');

		let inString: { quote: string; triple: boolean; startLine: number } | null = null;
		const bracketStack: { char: string; expected: string; line: number }[] = [];
		let prevLineEndedWithBackslash = false;

		for (let i = 0; i < numLines; i++) {
			const line = rawLines[i];
			const fileLineNo = baseFileLine + i;
			lineStartsInExpr[i] = Boolean(inString || bracketStack.length > 0 || prevLineEndedWithBackslash);

			let j = 0;
			let strippedCode = '';
			let endedWithBackslash = false;

			while (j < line.length) {
				if (inString) {
					if (inString.triple) {
						const idx = line.indexOf(inString.quote, j);
						if (idx !== -1) {
							let backslashes = 0;
							for (let k = idx - 1; k >= j && line[k] === '\\'; k--) backslashes++;
							if (backslashes % 2 === 0) {
								strippedCode += 'S';
								j = idx + 3;
								inString = null;
								continue;
							} else {
								j = idx + 1;
								continue;
							}
						} else {
							j = line.length;
							continue;
						}
					} else {
						let closed = false;
						while (j < line.length) {
							const ch = line[j];
							if (ch === '\\') {
								j += 2;
								continue;
							}
							if (ch === inString.quote) {
								inString = null;
								closed = true;
								strippedCode += 'S';
								j++;
								break;
							}
							j++;
						}
						if (!closed) {
							if (line.endsWith('\\')) {
								endedWithBackslash = true;
							} else {
								return {
									statements: [],
									syntaxError: {
										message: `SyntaxError: EOL while scanning string literal (${inString.quote})`,
										line: fileLineNo
									}
								};
							}
						}
						continue;
					}
				}

				const ch = line[j];
				if (ch === '#') {
					break;
				}
				if (ch === '"' || ch === "'") {
					const isTriple = line.substring(j, j + 3) === ch.repeat(3);
					inString = {
						quote: isTriple ? ch.repeat(3) : ch,
						triple: isTriple,
						startLine: fileLineNo
					};
					j += isTriple ? 3 : 1;
					continue;
				}
				if (ch === '(' || ch === '[' || ch === '{') {
					const expected = ch === '(' ? ')' : ch === '[' ? ']' : '}';
					bracketStack.push({ char: ch, expected, line: fileLineNo });
					strippedCode += ch;
					j++;
					continue;
				}
				if (ch === ')' || ch === ']' || ch === '}') {
					if (bracketStack.length === 0) {
						return {
							statements: [],
							syntaxError: {
								message: `SyntaxError: unmatched '${ch}'`,
								line: fileLineNo
							}
						};
					}
					const top = bracketStack.pop()!;
					if (top.expected !== ch) {
						return {
							statements: [],
							syntaxError: {
								message: `SyntaxError: closing parenthesis '${ch}' does not match opening parenthesis '${top.char}' on line ${top.line}`,
								line: fileLineNo
							}
						};
					}
					strippedCode += ch;
					j++;
					continue;
				}
				strippedCode += ch;
				j++;
			}

			const trimmedRight = strippedCode.replace(/\s+$/, '');
			if (trimmedRight.endsWith('\\')) {
				endedWithBackslash = true;
			}
			lineCodeWithoutComment[i] = trimmedRight;
			prevLineEndedWithBackslash = endedWithBackslash;
			lineEndsInExpr[i] = Boolean(inString || bracketStack.length > 0 || endedWithBackslash);
		}

		if (inString) {
			return {
				statements: [],
				syntaxError: {
					message: `SyntaxError: EOF while scanning triple-quoted string literal (started on line ${inString.startLine})`,
					line: inString.startLine
				}
			};
		}
		if (bracketStack.length > 0) {
			const unclosed = bracketStack[bracketStack.length - 1];
			return {
				statements: [],
				syntaxError: {
					message: `SyntaxError: '${unclosed.char}' was never closed`,
					line: unclosed.line
				}
			};
		}

		interface ILogicalStmt {
			startLine: number; // 1-based
			endLine: number;   // 1-based
			indent: number;
			firstWord: string;
			codeText: string;
			endsWithColon: boolean;
			isDecorator: boolean;
		}
		const logicalStmts: ILogicalStmt[] = [];

		let i = 0;
		while (i < numLines) {
			const codePart = lineCodeWithoutComment[i];
			if (!lineStartsInExpr[i] && codePart.trim() === '') {
				i++;
				continue;
			}
			const rawFirstLine = rawLines[i];
			const indentMatch = rawFirstLine.match(/^([ \t]*)/);
			const indentStr = indentMatch ? indentMatch[1] : '';
			let indent = 0;
			for (const c of indentStr) {
				indent += c === '\t' ? 4 : 1;
			}

			const startIdx = i;
			let combinedCode = codePart.trim();
			while (i < numLines && lineEndsInExpr[i]) {
				i++;
				if (i < numLines) {
					combinedCode += ' ' + lineCodeWithoutComment[i].trim();
				}
			}
			const endIdx = Math.min(i, numLines - 1);
			const firstWordMatch = combinedCode.match(/^(?:async\s+(?:def|for|with)\b|[a-zA-Z_][a-zA-Z0-9_]*)/);
			const firstWord = firstWordMatch ? firstWordMatch[0].replace(/\s+/g, ' ') : '';
			const endsWithColon = combinedCode.endsWith(':');
			const isDecorator = combinedCode.startsWith('@');

			const fileLineNo = baseFileLine + startIdx;
			const compoundKeywords = new Set([
				'if', 'elif', 'else', 'for', 'async for', 'while', 'def', 'async def',
				'class', 'try', 'except', 'finally', 'with', 'async with', 'match', 'case'
			]);
			if (compoundKeywords.has(firstWord) && !endsWithColon) {
				return {
					statements: [],
					syntaxError: {
						message: `SyntaxError: expected ':' after '${firstWord}' statement`,
						line: baseFileLine + endIdx
					}
				};
			}
			if (!compoundKeywords.has(firstWord) && endsWithColon) {
				const isTypeAnnotation = /^[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*[a-zA-Z_][a-zA-Z0-9_.\[\], ]*$/.test(combinedCode);
				if (!isTypeAnnotation) {
					return {
						statements: [],
						syntaxError: {
							message: `SyntaxError: invalid syntax near ':'`,
							line: baseFileLine + endIdx
						}
					};
				}
			}
			if (/(?:[=+\-*/%&|^<>]|\/\/|\*\*)\s*$/.test(combinedCode) && !combinedCode.endsWith('...')) {
				return {
					statements: [],
					syntaxError: {
						message: `SyntaxError: invalid syntax (incomplete expression)`,
						line: baseFileLine + endIdx
					}
				};
			}
			if (/^\d+\s*=[^=]/.test(combinedCode)) {
				return {
					statements: [],
					syntaxError: {
						message: `SyntaxError: cannot assign to literal`,
						line: fileLineNo
					}
				};
			}

			logicalStmts.push({
				startLine: startIdx + 1,
				endLine: endIdx + 1,
				indent,
				firstWord,
				codeText: combinedCode,
				endsWithColon: compoundKeywords.has(firstWord) && endsWithColon,
				isDecorator
			});
			i++;
		}

		const continuationHeaders = new Set(['elif', 'else', 'except', 'finally', 'case']);
		const indentStack: number[] = [0];
		let expectIndentedBlockAfter: ILogicalStmt | null = null;

		for (let idx = 0; idx < logicalStmts.length; idx++) {
			const st = logicalStmts[idx];
			const fileLineNo = baseFileLine + st.startLine - 1;

			if (expectIndentedBlockAfter) {
				if (st.indent <= expectIndentedBlockAfter.indent) {
					return {
						statements: [],
						syntaxError: {
							message: `IndentationError: expected an indented block after '${expectIndentedBlockAfter.firstWord}' statement on line ${baseFileLine + expectIndentedBlockAfter.startLine - 1}`,
							line: fileLineNo
						}
					};
				}
				indentStack.push(st.indent);
				expectIndentedBlockAfter = null;
			} else {
				const currentIndent = indentStack[indentStack.length - 1];
				if (st.indent > currentIndent) {
					return {
						statements: [],
						syntaxError: {
							message: `IndentationError: unexpected indent`,
							line: fileLineNo
						}
					};
				}
				while (indentStack.length > 1 && indentStack[indentStack.length - 1] > st.indent) {
					indentStack.pop();
				}
				if (indentStack[indentStack.length - 1] !== st.indent) {
					return {
						statements: [],
						syntaxError: {
							message: `IndentationError: unindent does not match any outer indentation level`,
							line: fileLineNo
						}
					};
				}
			}

			if (st.indent === 0 && continuationHeaders.has(st.firstWord)) {
				if (idx === 0) {
					return {
						statements: [],
						syntaxError: {
							message: `SyntaxError: invalid '${st.firstWord}' without matching compound statement`,
							line: fileLineNo
						}
					};
				}
			}

			if (st.endsWithColon) {
				const colonIdx = st.codeText.indexOf(':');
				const afterColon = colonIdx !== -1 ? st.codeText.substring(colonIdx + 1).trim() : '';
				if (!afterColon) {
					expectIndentedBlockAfter = st;
				}
			}
		}

		if (expectIndentedBlockAfter) {
			return {
				statements: [],
				syntaxError: {
					message: `IndentationError: expected an indented block after '${expectIndentedBlockAfter.firstWord}' statement on line ${baseFileLine + expectIndentedBlockAfter.startLine - 1}`,
					line: baseFileLine + expectIndentedBlockAfter.endLine - 1
				}
			};
		}

		const topLevelSpans: IAstStatementSpan[] = [];
		let k = 0;
		while (k < logicalStmts.length) {
			const first = logicalStmts[k];
			const spanStart = first.startLine;
			let spanEnd = first.endLine;

			while (k < logicalStmts.length && logicalStmts[k].indent === 0 && logicalStmts[k].isDecorator) {
				spanEnd = logicalStmts[k].endLine;
				k++;
			}
			if (k < logicalStmts.length && logicalStmts[k].indent === 0) {
				spanEnd = logicalStmts[k].endLine;
				k++;
			}

			while (k < logicalStmts.length) {
				const next = logicalStmts[k];
				if (next.indent > 0) {
					spanEnd = next.endLine;
					k++;
				} else if (next.indent === 0 && continuationHeaders.has(next.firstWord)) {
					spanEnd = next.endLine;
					k++;
				} else {
					break;
				}
			}

			topLevelSpans.push({
				lineno: spanStart,
				end_lineno: spanEnd
			});
		}

		return { statements: topLevelSpans };
	}

	/**
	 * Strips system instruction/metadata lines (replacing them with empty lines to preserve 1-to-1 line numbers).
	 */
	public static sanitizeSystemCommentsPreservingLineNumbers(code: string): string {
		return code
			.replace(/\r\n/g, '\n')
			.split('\n')
			.map(line => isSystemMetadataOrInstructionLine(line) ? '' : line)
			.join('\n');
	}

	/**
	 * Splits a node's Python source code into independent Python Steps.
	 * - Excludes system metadata and instructional comments (`# >>> WRITE NODE CODE BELOW <<<`, etc.).
	 * - Uses top-level AST statement spans (either from Python's `ast.parse` or `analyzePythonTopLevelStatements`).
	 * - Only an exact standalone `###` line at a valid top-level statement boundary (outside any top-level compound statement)
	 *   separates two independent Python Steps.
	 * - Blank editing space does NOT split steps, and empty sections produce 0 steps (`[]`).
	 */
	public static splitNodeCodeIntoSteps(
		code: string,
		baseFileLine: number = 1,
		externalAstSpans?: IAstStatementSpan[]
	): {
		steps: string[];
		orderedItems: Array<{ kind: 'python'; code: string } | { kind: 'component_anchor'; componentId?: string; stepNumber?: number }>;
		syntaxError?: { message: string; line: number };
	} {
		const sanitized = this.sanitizeSystemCommentsPreservingLineNumbers(code);
		if (!sanitized.trim()) {
			return { steps: [], orderedItems: [] };
		}

		const analysis = this.analyzePythonTopLevelStatements(sanitized, baseFileLine);
		if (analysis.syntaxError) {
			return { steps: [], orderedItems: [], syntaxError: analysis.syntaxError };
		}

		const spans = externalAstSpans && externalAstSpans.length > 0 ? externalAstSpans : analysis.statements;
		const lines = sanitized.split('\n');

		// A 1-based line number `lineNo` is strictly inside a top-level statement if `span.lineno <= lineNo <= span.end_lineno`.
		// Note: since `###` is a comment line, for top-level statements `span.lineno` and `span.end_lineno` are executable lines,
		// so a `###` line is inside a compound statement if and only if `span.lineno < lineNo < span.end_lineno`.
		const isInsideTopLevelStatement = (lineNo1Based: number): boolean => {
			for (const sp of spans) {
				if (lineNo1Based >= sp.lineno && lineNo1Based <= sp.end_lineno) {
					return true;
				}
			}
			return false;
		};

		const steps: string[] = [];
		const orderedItems: Array<{ kind: 'python'; code: string } | { kind: 'component_anchor'; componentId?: string; stepNumber?: number }> = [];
		let currentChunkLines: string[] = [];

		const pushPythonStep = (stepCode: string) => {
			steps.push(stepCode);
			orderedItems.push({ kind: 'python', code: stepCode });
		};

		const flushChunk = () => {
			const text = currentChunkLines.join('\n').trim();
			// Only emit a step if it contains non-empty content (never emit empty steps)
			if (text) {
				// If a single ###-delimited chunk contains multiple top-level statements and at least one
				// calls a workflow built-in (RUN_TICKETS, CREATE_TICKETS, GET_TICKETS, GET_OUTPUTS, DISPLAY, PRINT),
				// split each top-level statement into its own visual step so none of them are hidden on the node.
				const hasWorkflowBuiltin = /\b(RUN_TICKETS|CREATE_TICKETS|GET_TICKETS|GET_OUTPUTS|DISPLAY|PRINT|GET_PRIMITIVES_CATALOG)\s*\(/.test(text);
				if (hasWorkflowBuiltin) {
					const chunkAnalysis = this.analyzePythonTopLevelStatements(text, 1);
					if (!chunkAnalysis.syntaxError && chunkAnalysis.statements.length > 1) {
						const chunkLines = text.split('\n');
						for (const st of chunkAnalysis.statements) {
							const stmtSlice = chunkLines.slice(st.lineno - 1, st.end_lineno).join('\n').trim();
							if (stmtSlice) {
								pushPythonStep(stmtSlice);
							}
						}
						currentChunkLines = [];
						return;
					}
				}
				pushPythonStep(text);
			}
			currentChunkLines = [];
		};

		for (let idx = 0; idx < lines.length; idx++) {
			const line = lines[idx];
			const lineNo1Based = idx + 1;
			const compAnchor = !isInsideTopLevelStatement(lineNo1Based) ? parseComponentCommentAnchor(line) : null;
			if (compAnchor) {
				flushChunk();
				orderedItems.push({
					kind: 'component_anchor',
					componentId: compAnchor.componentId,
					stepNumber: compAnchor.stepNumber
				});
			} else if (line.trim() === STEP_SEPARATOR && !isInsideTopLevelStatement(lineNo1Based)) {
				flushChunk();
			} else {
				currentChunkLines.push(line);
			}
		}
		flushChunk();

		return { steps, orderedItems };
	}

	/**
	 * Extracts and validates connection condition code from a CONNECTION section.
	 */
	public static extractAndValidateConnectionCode(
		code: string,
		headerCondition: string,
		baseFileLine: number = 1
	): { condition: string; syntaxError?: { message: string; line: number } } {
		const sanitized = this.sanitizeSystemCommentsPreservingLineNumbers(code);
		const trimmedCode = sanitized.trim();
		const effectiveCode = trimmedCode || (headerCondition || '').trim();
		if (!effectiveCode) {
			return { condition: '' };
		}

		const analysis = this.analyzePythonTopLevelStatements(sanitized.trim() ? sanitized : effectiveCode, baseFileLine);
		if (analysis.syntaxError) {
			return { condition: '', syntaxError: analysis.syntaxError };
		}

		return { condition: effectiveCode };
	}
}

/**
 * 3. PythonToWorkflowParser
 * Parses the structured `.workflow.py` file into Node sections and Connection sections,
 * capturing each section's editable code area below `# >>> WRITE NODE CODE BELOW <<<` and `# >>> WRITE CONNECTION CONDITION CODE BELOW <<<`.
 */
export class PythonToWorkflowParser {
	public static parseWorkflowPythonFile(source: string): IParsedWorkflowPythonFile {
		const normalized = source.replace(/\r\n/g, '\n');
		const lines = normalized.split('\n');

		const result: IParsedWorkflowPythonFile = {
			nodes: [],
			connections: [],
			errors: []
		};

		const isDividerLine = (line: string): boolean => /^#\s*={15,}\s*$/.test(line.trim());

		let i = 0;
		let activeSection:
			| { kind: 'node'; section: IParsedNodeSection; codeLines: string[] }
			| { kind: 'connection'; section: IParsedConnectionSection; codeLines: string[] }
			| null = null;

		const flushActiveSection = () => {
			if (!activeSection) return;
			const rawCode = activeSection.codeLines.join('\n');
			if (activeSection.kind === 'node') {
				activeSection.section.code = rawCode;
				result.nodes.push(activeSection.section);
			} else {
				activeSection.section.code = rawCode;
				const cleanBody = PythonCodeBlockParser.sanitizeSystemCommentsPreservingLineNumbers(rawCode).trim();
				activeSection.section.condition = cleanBody || activeSection.section.headerCondition;
				result.connections.push(activeSection.section);
			}
			activeSection = null;
		};

		while (i < lines.length) {
			if (isDividerLine(lines[i])) {
				// Look ahead up to the next divider line to see if this is a metadata header block
				let j = i + 1;
				const headerLines: string[] = [];
				while (j < lines.length && !isDividerLine(lines[j]) && lines[j].trim().startsWith('#')) {
					headerLines.push(lines[j].trim());
					j++;
				}

				if (j < lines.length && isDividerLine(lines[j]) && headerLines.length > 0) {
					const kvMap = new Map<string, string>();
					for (const hl of headerLines) {
						const m = hl.match(/^#\s*([A-Z_]+)\s*:\s*(.*)$/);
						if (m) {
							kvMap.set(m[1], m[2].trim());
						}
					}

					if (kvMap.has('WORKFLOW_ID') || kvMap.has('WORKFLOW_URI') || headerLines.some(l => l.includes('WORKFLOW_PYTHON_SYNC'))) {
						if (kvMap.has('WORKFLOW_ID')) result.workflowId = decodeMetadataText(kvMap.get('WORKFLOW_ID'));
						if (kvMap.has('WORKFLOW_NAME')) result.workflowName = decodeMetadataText(kvMap.get('WORKFLOW_NAME'));
						if (kvMap.has('WORKFLOW_URI')) result.workflowUri = decodeMetadataText(kvMap.get('WORKFLOW_URI'));
						i = j + 1;
						continue;
					}

					if (kvMap.has('NODE') || kvMap.has('NODE_ID')) {
						flushActiveSection();
						const nodeId = decodeMetadataText(kvMap.get('NODE_ID') || '');
						const title = decodeMetadataText(kvMap.get('NODE') || '');
						const shape = decodeMetadataText(kvMap.get('SHAPE') || 'Round Rect');
						if (!nodeId) {
							result.errors.push({
								message: `Missing NODE_ID in node header '${title || 'unnamed'}'`,
								line: i + 1
							});
						}
						let nextLineIdx = j + 1;
						// If the immediately following line is `# >>> WRITE NODE CODE BELOW <<<`, consume it as part of the header
						if (nextLineIdx < lines.length && /^#\s*>>>\s*WRITE NODE CODE BELOW\s*<<<\s*$/i.test(lines[nextLineIdx].trim())) {
							nextLineIdx++;
						}
						activeSection = {
							kind: 'node',
							section: {
								nodeId,
								title,
								shape,
								code: '',
								headerStartLine: i + 1,
								codeStartLine: nextLineIdx + 1
							},
							codeLines: []
						};
						i = nextLineIdx;
						continue;
					}

					if (kvMap.has('CONNECTION') || kvMap.has('CONNECTION_ID')) {
						flushActiveSection();
						const connectionId = decodeMetadataText(kvMap.get('CONNECTION_ID') || '');
						const title = decodeMetadataText(kvMap.get('CONNECTION') || '');
						const sourceNodeId = decodeMetadataText(kvMap.get('SOURCE_NODE_ID') || '');
						const targetNodeId = decodeMetadataText(kvMap.get('TARGET_NODE_ID') || '');
						const headerCondition = decodeMetadataText(kvMap.get('CONDITION') || '');
						const connectionStyle = decodeMetadataText(kvMap.get('CONNECTION_STYLE') || 'Single Arrow');
						if (!connectionId) {
							result.errors.push({
								message: `Missing CONNECTION_ID in connection header '${title || 'unnamed'}'`,
								line: i + 1
							});
						}
						let nextLineIdx = j + 1;
						// If the immediately following line is `# >>> WRITE CONNECTION CONDITION CODE BELOW <<<`, consume it as part of the header
						if (nextLineIdx < lines.length && /^#\s*>>>\s*WRITE CONNECTION CONDITION CODE BELOW\s*<<<\s*$/i.test(lines[nextLineIdx].trim())) {
							nextLineIdx++;
						}
						activeSection = {
							kind: 'connection',
							section: {
								connectionId,
								title,
								sourceNodeId,
								targetNodeId,
								headerCondition,
								code: '',
								condition: headerCondition,
								connectionStyle,
								headerStartLine: i + 1,
								codeStartLine: nextLineIdx + 1
							},
							codeLines: []
						};
						i = nextLineIdx;
						continue;
					}
				}
			}

			if (activeSection) {
				activeSection.codeLines.push(lines[i]);
			} else if (lines[i].trim() !== '' && !lines[i].trim().startsWith('#')) {
				result.errors.push({
					message: `Executable Python statement found outside any # NODE or # CONNECTION section`,
					line: i + 1
				});
			}
			i++;
		}

		flushActiveSection();
		return result;
	}
}

/**
 * Helper to extract targetVariable and functionName from a Python Step code block
 */
export function buildPipelineStepFromPythonCode(
	codeBlock: string,
	existingStep?: INodePipelineStep
): { step: INodePipelineStep; assignedVars: string[] } {
	const rawExpr = codeBlock.replace(/\r\n/g, '\n').trim();
	const assignedVars: string[] = [];

	// Only extract assignments at bracketDepth === 0 so keyword arguments inside multiline function calls
	// (e.g. ticket_type="...", title="...", path=".", params={...}) are never mistaken for variable assignments!
	let bracketDepth = 0;
	for (const rawLine of rawExpr.split('\n')) {
		const trimmed = rawLine.trim();
		if (trimmed && !trimmed.startsWith('#') && bracketDepth === 0) {
			const cleanLine = trimmed.replace(/\s+#.*$/, '');
			const assignMatch = cleanLine.match(/^@?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::\s*[^=]+)?(?:\+|-|\*|\/)?=(?!=)/);
			if (assignMatch) {
				const vName = assignMatch[1];
				if (vName && !PYTHON_KEYWORDS.has(vName) && !assignedVars.includes(vName)) {
					assignedVars.push(vName);
				}
			}
			const defMatch = cleanLine.match(/^(?:async\s+)?(?:def|class)\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
			if (defMatch) {
				const dName = defMatch[1];
				if (dName && !PYTHON_KEYWORDS.has(dName) && !assignedVars.includes(dName)) {
					assignedVars.push(dName);
				}
			}
		}
		// Update bracketDepth for next line (ignoring strings and comments)
		let inStr: string | null = null;
		for (let i = 0; i < trimmed.length; i++) {
			const ch = trimmed[i];
			if (inStr) {
				if (ch === '\\') {
					i++;
					continue;
				}
				if (ch === inStr) {
					inStr = null;
				}
				continue;
			}
			if (ch === '#') {
				break;
			}
			if (ch === '"' || ch === '\'') {
				inStr = ch;
				continue;
			}
			if (ch === '(' || ch === '[' || ch === '{') {
				bracketDepth++;
			} else if (ch === ')' || ch === ']' || ch === '}') {
				bracketDepth = Math.max(0, bracketDepth - 1);
			}
		}
	}

	const targetVar = assignedVars[0];
	let fnName = 'PYTHON';
	const singleLineCallMatch = rawExpr.match(/^(?:@?[a-zA-Z0-9_\u4e00-\u9fa5]+\s*=\s*)?([a-zA-Z0-9_]+)\s*\([\s\S]*\)$/);
	if (singleLineCallMatch && !rawExpr.includes('\n')) {
		fnName = singleLineCallMatch[1];
	}

	const stepId = existingStep?.id || `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

	return {
		step: {
			id: stepId,
			type: 'call_function',
			targetVariable: targetVar,
			functionName: fnName,
			expression: rawExpr
		},
		assignedVars
	};
}

/**
 * 4. WorkflowSyncManager
 * Performs transactional validation and synchronization of `.workflow.py` back to `ISyncFlowchartData`.
 */
export class WorkflowSyncManager {
	public static synchronizePythonToWorkflow(
		pythonSource: string,
		flowchartData: ISyncFlowchartData,
		externalAstSpansByNodeId?: Map<string, IAstStatementSpan[]>
	): IWorkflowPythonSyncResult {
		const parsed = PythonToWorkflowParser.parseWorkflowPythonFile(pythonSource);
		const errors: ISyncValidationError[] = [];
		const warnings: string[] = [];

		for (const err of parsed.errors) {
			errors.push({ message: err.message, line: err.line });
		}

		if (parsed.nodes.length === 0 && flowchartData.nodes.length > 0) {
			errors.push({
				message: 'No valid # NODE sections were found in the Python file.',
				line: 1
			});
		}

		const existingNodeById = new Map<string, ISyncFlowchartNode>();
		for (const n of flowchartData.nodes) {
			existingNodeById.set(n.id, n);
		}

		const existingLinkById = new Map<string, ISyncFlowchartLink>();
		for (const l of flowchartData.links) {
			existingLinkById.set(l.id, l);
		}

		// Check 1: Duplicate or unknown NODE_IDs
		const seenNodeIds = new Set<string>();
		for (const pn of parsed.nodes) {
			if (!pn.nodeId) continue;
			if (seenNodeIds.has(pn.nodeId)) {
				errors.push({
					message: `Duplicate NODE_ID '${pn.nodeId}' detected on line ${pn.headerStartLine}.`,
					line: pn.headerStartLine,
					nodeId: pn.nodeId
				});
				continue;
			}
			seenNodeIds.add(pn.nodeId);

			if (!existingNodeById.has(pn.nodeId)) {
				errors.push({
					message: `Unknown NODE_ID '${pn.nodeId}' (Node '${pn.title}') on line ${pn.headerStartLine}. Original node not found in workflow.`,
					line: pn.headerStartLine,
					nodeId: pn.nodeId
				});
			}
		}

		// Check 2: Duplicate or unknown CONNECTION_IDs
		const seenConnectionIds = new Set<string>();
		for (const pc of parsed.connections) {
			if (!pc.connectionId) continue;
			if (seenConnectionIds.has(pc.connectionId)) {
				errors.push({
					message: `Duplicate CONNECTION_ID '${pc.connectionId}' detected on line ${pc.headerStartLine}.`,
					line: pc.headerStartLine,
					connectionId: pc.connectionId
				});
				continue;
			}
			seenConnectionIds.add(pc.connectionId);

			if (!existingLinkById.has(pc.connectionId)) {
				errors.push({
					message: `Unknown CONNECTION_ID '${pc.connectionId}' on line ${pc.headerStartLine}. Original connection not found in workflow.`,
					line: pc.headerStartLine,
					connectionId: pc.connectionId
				});
			}
		}

		// Check 3: Validate Python syntax and split code blocks for every node BEFORE committing any change
		const preparedNodeSteps = new Map<string, {
			steps: string[];
			orderedItems: Array<{ kind: 'python'; code: string } | { kind: 'component_anchor'; componentId?: string; stepNumber?: number }>;
			parsedNode: IParsedNodeSection;
		}>();
		for (const pn of parsed.nodes) {
			if (!pn.nodeId || !existingNodeById.has(pn.nodeId)) continue;
			const extSpans = externalAstSpansByNodeId?.get(pn.nodeId);
			const splitRes = PythonCodeBlockParser.splitNodeCodeIntoSteps(pn.code, pn.codeStartLine, extSpans);
			if (splitRes.syntaxError) {
				errors.push({
					message: `[Node '${pn.title || pn.nodeId}' (line ${splitRes.syntaxError.line})] ${splitRes.syntaxError.message}`,
					line: splitRes.syntaxError.line,
					nodeId: pn.nodeId
				});
			} else {
				preparedNodeSteps.set(pn.nodeId, {
					steps: splitRes.steps,
					orderedItems: splitRes.orderedItems,
					parsedNode: pn
				});
			}
		}

		// Check 4: Validate Python syntax and extract condition code for every connection BEFORE committing any change
		const preparedConnectionConditions = new Map<string, { condition: string; parsedConn: IParsedConnectionSection }>();
		for (const pc of parsed.connections) {
			if (!pc.connectionId || !existingLinkById.has(pc.connectionId)) continue;
			const connRes = PythonCodeBlockParser.extractAndValidateConnectionCode(pc.code, pc.headerCondition, pc.codeStartLine);
			if (connRes.syntaxError) {
				errors.push({
					message: `[Connection '${pc.title || pc.connectionId}' (line ${connRes.syntaxError.line})] ${connRes.syntaxError.message}`,
					line: connRes.syntaxError.line,
					connectionId: pc.connectionId
				});
			} else {
				preparedConnectionConditions.set(pc.connectionId, { condition: connRes.condition, parsedConn: pc });
			}
		}

		// Check for missing nodes / connections (do not delete original nodes/connections)
		const missingNodeIds: string[] = [];
		for (const n of flowchartData.nodes) {
			if (!seenNodeIds.has(n.id)) {
				missingNodeIds.push(n.id);
				warnings.push(`Node '${n.label}' (${n.id}) was missing from the Python file and was preserved untouched.`);
			}
		}

		const missingConnectionIds: string[] = [];
		for (const l of flowchartData.links) {
			if (!seenConnectionIds.has(l.id)) {
				missingConnectionIds.push(l.id);
				warnings.push(`Connection '${l.id}' was missing from the Python file and was preserved untouched.`);
			}
		}

		// Transactional abort if any validation error occurred
		if (errors.length > 0) {
			return {
				success: false,
				errors,
				warnings,
				updatedNodesCount: 0,
				updatedConnectionsCount: 0,
				missingNodeIds,
				missingConnectionIds
			};
		}

		// Step 5: Apply validated changes to nodes
		let updatedNodesCount = 0;
		for (const [nodeId, { steps: newCodeBlocks, orderedItems, parsedNode }] of preparedNodeSteps.entries()) {
			const node = existingNodeById.get(nodeId)!;

			if (parsedNode.title && parsedNode.title !== node.label) {
				node.label = parsedNode.title;
			}
			if (parsedNode.shape) {
				node.type = shapeNameToNodeType(parsedNode.shape, node.type);
			}

			const existingPipeline = Array.isArray(node.pipeline) ? node.pipeline : [];
			const existingComponentSteps = existingPipeline.filter(s => isComponentPipelineStep(s));
			const existingPythonSteps = existingPipeline.filter(s => !isComponentPipelineStep(s));

			const usedPrevStepIds = new Set<string>();
			const rebuiltPythonSteps: INodePipelineStep[] = [];
			const newOutputVars: INodeVariable[] = [];

			for (let idx = 0; idx < newCodeBlocks.length; idx++) {
				const block = newCodeBlocks[idx];
				const normalizedBlock = block.replace(/\r\n/g, '\n').trim();
				// Prefer matching existing Python step by identical expression to preserve step ID when inserting/reordering
				let prevStep = existingPythonSteps.find(
					s => !usedPrevStepIds.has(s.id) && (s.expression || '').replace(/\r\n/g, '\n').trim() === normalizedBlock
				);
				if (!prevStep && idx < existingPythonSteps.length && !usedPrevStepIds.has(existingPythonSteps[idx].id)) {
					prevStep = existingPythonSteps[idx];
				}
				if (prevStep?.id) {
					usedPrevStepIds.add(prevStep.id);
				}

				const { step, assignedVars } = buildPipelineStepFromPythonCode(block, prevStep);
				rebuiltPythonSteps.push(step);

				for (const vName of assignedVars) {
					if (!newOutputVars.some(v => v.name === vName)) {
						const prevVar = (node.outputVariables || []).find(v => v.name.replace(/^@/, '') === vName);
						newOutputVars.push({
							name: vName,
							initialValue: step.expression || prevVar?.initialValue || 'None',
							expression: step.expression
						});
					}
				}
			}

			// Reconstruct node.pipeline using K+1 slots around the K non-Python components in `existingComponentSteps`:
			// - All non-Python components are preserved 100% untouched from the Workflow (never modified or deleted by Python comments).
			// - Python steps are placed in the exact slot before/between/after the non-Python components based on the component comment anchors.
			const numComps = existingComponentSteps.length;
			const pythonSlots: INodePipelineStep[][] = Array.from({ length: numComps + 1 }, () => []);
			const hasAnyAnchorInPython = orderedItems.some(it => it.kind === 'component_anchor');

			if (numComps === 0) {
				pythonSlots[0].push(...rebuiltPythonSteps);
			} else if (hasAnyAnchorInPython) {
				let currentSlot = 0;
				let pyIdx = 0;
				let nextFallbackCompIdx = 0;

				for (const item of orderedItems) {
					if (item.kind === 'component_anchor') {
						let matchedCompIdx = -1;
						if (item.componentId) {
							matchedCompIdx = existingComponentSteps.findIndex((cs, cIdx) => {
								const cid = String((cs as any).component?.id || cs.id || '').trim();
								return cIdx >= currentSlot && cid === item.componentId;
							});
							if (matchedCompIdx === -1) {
								matchedCompIdx = existingComponentSteps.findIndex((cs) => {
									const cid = String((cs as any).component?.id || cs.id || '').trim();
									return cid === item.componentId;
								});
							}
						}
						if (matchedCompIdx === -1 && nextFallbackCompIdx < numComps) {
							matchedCompIdx = nextFallbackCompIdx;
						}
						if (matchedCompIdx !== -1) {
							currentSlot = Math.max(currentSlot, Math.min(numComps, matchedCompIdx + 1));
							nextFallbackCompIdx = Math.max(nextFallbackCompIdx, matchedCompIdx + 1);
						}
					} else if (item.kind === 'python') {
						if (pyIdx < rebuiltPythonSteps.length) {
							pythonSlots[currentSlot].push(rebuiltPythonSteps[pyIdx++]);
						}
					}
				}
				while (pyIdx < rebuiltPythonSteps.length) {
					pythonSlots[currentSlot].push(rebuiltPythonSteps[pyIdx++]);
				}
			} else {
				// Fallback for legacy .workflow.py files that do not yet have component comment anchors:
				// preserve original slot counts from `existingPipeline`, placing any newly added Python steps at the end.
				const originalSlotCounts = new Array(numComps + 1).fill(0);
				let slotCursor = 0;
				for (const st of existingPipeline) {
					if (isComponentPipelineStep(st)) {
						slotCursor = Math.min(numComps, slotCursor + 1);
					} else {
						originalSlotCounts[slotCursor]++;
					}
				}
				let pyIdx = 0;
				for (let sIdx = 0; sIdx <= numComps; sIdx++) {
					const countForSlot = originalSlotCounts[sIdx];
					for (let c = 0; c < countForSlot && pyIdx < rebuiltPythonSteps.length; c++) {
						pythonSlots[sIdx].push(rebuiltPythonSteps[pyIdx++]);
					}
				}
				while (pyIdx < rebuiltPythonSteps.length) {
					pythonSlots[numComps].push(rebuiltPythonSteps[pyIdx++]);
				}
			}

			const mergedPipeline: INodePipelineStep[] = [];
			for (let sIdx = 0; sIdx < numComps; sIdx++) {
				mergedPipeline.push(...pythonSlots[sIdx]);
				mergedPipeline.push(existingComponentSteps[sIdx]);
			}
			mergedPipeline.push(...pythonSlots[numComps]);

			// Check if the node's pipeline (both Python step expressions and relative order with components) is unchanged
			const currentStepStrings = extractNodePythonStepStrings(node);
			const hasLegacySetVariableSteps = existingPipeline.some(s => s.type === 'set_variable');
			const sameOrderAndIds =
				existingPipeline.length === mergedPipeline.length &&
				existingPipeline.every((st, idx) => st.id === mergedPipeline[idx].id && (st.expression || '').replace(/\r\n/g, '\n').trim() === (mergedPipeline[idx].expression || '').replace(/\r\n/g, '\n').trim());
			const isUnchanged =
				!hasLegacySetVariableSteps &&
				sameOrderAndIds &&
				currentStepStrings.length === newCodeBlocks.length &&
				currentStepStrings.every((codeStr, idx) => codeStr.replace(/\r\n/g, '\n').trim() === newCodeBlocks[idx].replace(/\r\n/g, '\n').trim());

			if (!isUnchanged) {
				node.pipeline = mergedPipeline;
				node.outputVariables = newOutputVars;
				if (node.outputVariable && newOutputVars.length === 0) {
					delete node.outputVariable;
				}
			}

			updatedNodesCount++;
		}

		// Step 6: Apply validated changes to connections
		let updatedConnectionsCount = 0;
		for (const [connectionId, { condition: newCond, parsedConn }] of preparedConnectionConditions.entries()) {
			const link = existingLinkById.get(connectionId);
			if (!link) continue;

			const trimmedCond = newCond.trim();
			if (trimmedCond) {
				link.condition = trimmedCond;
				link.label = trimmedCond;
			} else {
				delete link.condition;
				delete link.label;
			}

			if (parsedConn.connectionStyle) {
				link.style = connectionStyleNameToLinkStyle(parsedConn.connectionStyle, link.style);
			}

			updatedConnectionsCount++;
		}

		return {
			success: true,
			errors: [],
			warnings,
			updatedNodesCount,
			updatedConnectionsCount,
			missingNodeIds,
			missingConnectionIds
		};
	}
}


export class WorkflowPythonEditorBridge {
	private static readonly _PY_KEYWORDS = new Set([
		'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
		'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
		'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
		'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
		'try', 'while', 'with', 'yield',
		'RUN_TICKETS', 'CREATE_TICKETS', 'GET_TICKETS', 'GET_OUTPUTS', 'DISPLAY',
		'NOW', 'DATE', 'TIME'
	]);

	public static extractPythonVariablesFromSource(source: string): string[] {
		const found: string[] = [];
		const seen = new Set<string>();
		const addVar = (name: string) => {
			const trimmed = name.trim();
			if (!trimmed || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
				return;
			}
			if (WorkflowPythonEditorBridge._PY_KEYWORDS.has(trimmed)) {
				return;
			}
			if (!seen.has(trimmed)) {
				seen.add(trimmed);
				found.push(trimmed);
			}
		};

		const lines = (source || '').replace(/\r\n/g, '\n').split('\n');
		let bracketDepth = 0;
		for (const rawLine of lines) {
			const trimmed = rawLine.trim();
			if (!trimmed) {
				continue;
			}
			if (trimmed.startsWith('#')) {
				// Also extract component output variable names from `# [Step #... | Component: ...] var_name = ...` comments
				const compVarMatch = trimmed.match(/^#\s*\[(?:Component\s+)?Step\s*#\d+(?:\/\d+)?\s*\|\s*Component(?:\s*:[^\]]+)?\]\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=/i);
				if (compVarMatch) {
					addVar(compVarMatch[1]);
				}
				continue;
			}
			// Strip trailing comment (approximate for variable extraction)
			const line = trimmed.replace(/\s+#.*$/, '');

			// Only extract assignments at bracketDepth === 0 so keyword arguments inside multiline function calls
			// (e.g. ticket_type="...", title="...", path=".", params={...}) are never mistaken for variable definitions!
			if (bracketDepth === 0) {
				// 1. Simple or annotated assignment: var = ... or var: type = ...
				const singleAssign = line.match(/^@?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::\s*[^=]+)?(?:\+|-|\*|\/)?=(?!=)/);
				if (singleAssign) {
					addVar(singleAssign[1]);
				}

				// 2. Tuple / multi-target assignment: a, b = ...
				const tupleAssign = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)+)\s*=(?!=)/);
				if (tupleAssign) {
					for (const part of tupleAssign[1].split(',')) {
						addVar(part);
					}
				}

				// 3. For loop variables: for x in ... / for idx, item in ...
				const forMatch = line.match(/^for\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)*)\s+in\b/);
				if (forMatch) {
					for (const part of forMatch[1].split(',')) {
						addVar(part);
					}
				}

				// 4. Function / class definitions: def foo(a, b=1):
				const defMatch = line.match(/^(?:async\s+)?(?:def|class)\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
				if (defMatch) {
					addVar(defMatch[1]);
				}

				// 5. with ... as var / except ... as var
				const asMatch = line.match(/\bas\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:?$/);
				if (asMatch) {
					addVar(asMatch[1]);
				}
			}

			// Update bracketDepth for subsequent lines (ignoring strings and comments)
			let inStr: string | null = null;
			for (let i = 0; i < line.length; i++) {
				const ch = line[i];
				if (inStr) {
					if (ch === '\\') {
						i++;
						continue;
					}
					if (ch === inStr) {
						inStr = null;
					}
					continue;
				}
				if (ch === '#') {
					break;
				}
				if (ch === '"' || ch === '\'') {
					inStr = ch;
					continue;
				}
				if (ch === '(' || ch === '[' || ch === '{') {
					bracketDepth++;
				} else if (ch === ')' || ch === ']' || ch === '}') {
					bracketDepth = Math.max(0, bracketDepth - 1);
				}
			}
		}

		return found;
	}

	public static attachWorkflowPythonToolbox(
		codeEditor: any,
		fileService: IFileService,
		notificationService: INotificationService,
		entityPersistenceService: IEntityPersistenceService,
		ticketRuntimeService: ITicketWorkflowRuntimeService,
		editorService: IEditorService,
		customModulesService?: ICustomModulesService,
		initialPyFileUri?: URI,
		initialWorkflowId?: string,
		initialWorkflowName?: string,
		initialWorkflowUri?: URI
	): void {
		if (!codeEditor || typeof codeEditor.getDomNode !== 'function') {
			return;
		}

		// Clean up any legacy top-right overlay widget if present
		if (typeof codeEditor.removeOverlayWidget === 'function') {
			try {
				codeEditor.removeOverlayWidget({
					getId: () => 'workflow.python.sync.toolbar.overlay',
					getDomNode: () => document.createElement('div'),
					getPosition: () => null
				});
			} catch {}
		}

		const initialEditorDom = codeEditor.getDomNode() as HTMLElement | null;
		const parentEl: HTMLElement | null = (typeof codeEditor.getContainerDomNode === 'function' ? codeEditor.getContainerDomNode() : null)
			|| initialEditorDom?.parentElement
			|| null;
		if (!parentEl) {
			return;
		}

		// Check if already attached on this codeEditor instance
		if ((codeEditor as any).__wfPyToolboxController) {
			(codeEditor as any).__wfPyToolboxController.refreshContext(
				initialPyFileUri,
				initialWorkflowId,
				initialWorkflowName,
				initialWorkflowUri
			);
			return;
		}

		parentEl.style.position = 'relative';
		parentEl.classList.add('workflow-py-editor-host');

		const EXPANDED_WIDTH = 210;
		const COLLAPSED_WIDTH = 40;
		let isCollapsed = false;
		let currentPyUri: URI | undefined = initialPyFileUri;
		let currentWorkflowId: string = initialWorkflowId || '';
		let currentWorkflowName: string = initialWorkflowName || '';
		let currentWorkflowUri: URI | undefined = initialWorkflowUri;
		let lastFullWidth = parentEl.clientWidth || initialEditorDom?.clientWidth || 0;
		let lastFullHeight = parentEl.clientHeight || initialEditorDom?.clientHeight || 0;

		const isWorkflowPyModel = (): boolean => {
			const model = typeof codeEditor.getModel === 'function' ? codeEditor.getModel() : null;
			const uri: URI | undefined = model?.uri || currentPyUri;
			return !!uri && /\.workflow\.py$/i.test(uri.path);
		};

		// Remove any stale sidebar DOM inside parentEl
		const oldSidebar = parentEl.querySelector('.workflow-py-toolbox-sidebar');
		if (oldSidebar) {
			oldSidebar.remove();
		}

		const sidebarEl = document.createElement('div');
		sidebarEl.className = 'workflow-py-toolbox-sidebar';
		parentEl.prepend(sidebarEl);

		// Wrap codeEditor.layout so Monaco shifts right and shrinks width by toolbox width
		const origLayout = codeEditor.layout.bind(codeEditor);
		const applyEditorLayout = (dimension?: { width: number; height: number }) => {
			const liveEditorDom = codeEditor.getDomNode() as HTMLElement | null;
			if (dimension && dimension.width > 0 && dimension.height > 0) {
				lastFullWidth = dimension.width;
				lastFullHeight = dimension.height;
			}
			const totalWidth = dimension?.width || parentEl.clientWidth || lastFullWidth;
			const totalHeight = dimension?.height || parentEl.clientHeight || lastFullHeight || liveEditorDom?.clientHeight || 0;

			if (!isWorkflowPyModel()) {
				sidebarEl.style.display = 'none';
				parentEl.classList.remove('has-py-toolbox', 'py-toolbox-collapsed');
				if (liveEditorDom) {
					liveEditorDom.style.marginLeft = '0px';
				}
				if (totalWidth > 0 && totalHeight > 0) {
					origLayout({ width: totalWidth, height: totalHeight });
				} else if (dimension) {
					origLayout(dimension);
				}
				return;
			}

			sidebarEl.style.display = 'flex';
			parentEl.classList.add('has-py-toolbox');
			parentEl.classList.toggle('py-toolbox-collapsed', isCollapsed);
			const tbWidth = isCollapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH;
			if (liveEditorDom) {
				liveEditorDom.style.marginLeft = `${tbWidth}px`;
			}
			if (totalWidth > 0 && totalHeight > 0) {
				origLayout({
					width: Math.max(120, totalWidth - tbWidth),
					height: totalHeight
				});
			}
		};

		codeEditor.layout = (dimension?: { width: number; height: number }) => {
			applyEditorLayout(dimension);
		};

		// Helper: insert snippet at cursor in Monaco editor without losing focus
		const insertAtCursor = (
			rawText: string,
			options?: {
				isExpressionOrVar?: boolean;
				isStatement?: boolean;
				cursorInsideToken?: string;
			}
		) => {
			const model = typeof codeEditor.getModel === 'function' ? codeEditor.getModel() : null;
			if (!model) {
				return;
			}

			const selection = codeEditor.getSelection?.();
			const position = codeEditor.getPosition?.() || { lineNumber: 1, column: 1 };
			const lineContent: string = model.getLineContent(position.lineNumber) || '';
			const beforeCursor = lineContent.slice(0, Math.max(0, position.column - 1));

			// Check if cursor is inside a string literal
			const doubleQuotes = (beforeCursor.match(/(?<!\\)"/g) || []).length;
			const singleQuotes = (beforeCursor.match(/(?<!\\)'/g) || []).length;
			const insideString = (doubleQuotes % 2 === 1) || (singleQuotes % 2 === 1);

			let textToInsert = rawText;

			if (options?.isExpressionOrVar) {
				if (insideString) {
					textToInsert = `{${rawText}}`;
				}
			} else if (options?.isStatement) {
				if (/=\s*$/.test(beforeCursor)) {
					textToInsert = textToInsert.replace(/^[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*/, '');
				} else if (beforeCursor.trim().length > 0 && !beforeCursor.endsWith(' ')) {
					const indentMatch = lineContent.match(/^(\s*)/);
					const indent = indentMatch ? indentMatch[1] : '';
					textToInsert = `\n${indent}${textToInsert}`;
				}
			}

			const range = selection && !selection.isEmpty()
				? selection
				: {
					startLineNumber: position.lineNumber,
					startColumn: position.column,
					endLineNumber: position.lineNumber,
					endColumn: position.column
				};

			codeEditor.executeEdits('workflow-py-toolbox', [
				{
					range,
					text: textToInsert,
					forceMoveMarkers: true
				}
			]);

			if (options?.cursorInsideToken) {
				const tokenIdx = textToInsert.indexOf(options.cursorInsideToken);
				if (tokenIdx !== -1) {
					const prefix = textToInsert.slice(0, tokenIdx + options.cursorInsideToken.length);
					const prefixLines = prefix.split('\n');
					const targetLine = range.startLineNumber + prefixLines.length - 1;
					const targetCol = prefixLines.length === 1
						? range.startColumn + prefixLines[0].length
						: prefixLines[prefixLines.length - 1].length + 1;
					codeEditor.setPosition?.({ lineNumber: targetLine, column: targetCol });
				}
			}

			codeEditor.focus?.();
		};

		// Build Sidebar Header
		const headerEl = append(sidebarEl, $('div.workflow-py-toolbox-header'));
		const titleSpan = append(headerEl, $('span.workflow-py-toolbox-title', {}, 'TOOLBOX'));
		const toggleBtn = append(headerEl, $('div.workflow-py-toolbox-toggle' + ThemeIcon.asCSSSelector(Codicon.chevronLeft)));
		toggleBtn.title = 'Collapse Toolbox';
		toggleBtn.onmousedown = (e) => {
			e.preventDefault();
			e.stopPropagation();
			isCollapsed = !isCollapsed;
			sidebarEl.classList.toggle('collapsed', isCollapsed);
			titleSpan.style.display = isCollapsed ? 'none' : '';
			toggleBtn.className = 'workflow-py-toolbox-toggle ' + (isCollapsed ? 'codicon codicon-chevron-right' : 'codicon codicon-chevron-left');
			toggleBtn.title = isCollapsed ? 'Expand Toolbox' : 'Collapse Toolbox';
			applyEditorLayout();
		};

		// Top Sync & Navigation Actions Box
		const syncBox = append(sidebarEl, $('div.workflow-py-toolbox-sync-box'));

		const syncBtn = append(syncBox, $('div.workflow-py-toolbox-sync-btn'));
		syncBtn.title = 'Synchronize Python file back to Workflow';
		append(syncBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.sync)));
		const syncBtnLabel = append(syncBtn, $('span.sync-label', {}, 'Sync to Workflow'));
		syncBtn.onmousedown = (e) => e.preventDefault();
		syncBtn.onclick = async (e) => {
			e.stopPropagation();
			syncBtnLabel.textContent = 'Syncing...';
			syncBtn.style.opacity = '0.7';
			syncBtn.style.pointerEvents = 'none';
			try {
				const model = codeEditor.getModel?.();
				const targetPyUri = model?.uri || currentPyUri;
				await WorkflowPythonEditorBridge.syncPythonEditorToWorkflow(
					targetPyUri,
					codeEditor,
					fileService,
					notificationService,
					entityPersistenceService,
					ticketRuntimeService
				);
			} finally {
				syncBtnLabel.textContent = 'Sync to Workflow';
				syncBtn.style.opacity = '1';
				syncBtn.style.pointerEvents = '';
			}
		};

		const openWfBtn = append(syncBox, $('div.workflow-py-toolbox-open-wf-btn'));
		openWfBtn.title = 'Switch to Visual Workflow Editor';
		append(openWfBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.typeHierarchySub)));
		append(openWfBtn, $('span.sync-label', {}, 'Visual Workflow'));
		openWfBtn.onmousedown = (e) => e.preventDefault();
		openWfBtn.onclick = async (e) => {
			e.stopPropagation();
			if (currentWorkflowUri) {
				await editorService.openEditor(new WorkflowEditorInput(currentWorkflowUri, currentWorkflowName || currentWorkflowId), { pinned: true });
				return;
			}
			const model = codeEditor.getModel?.();
			const pySource: string = model?.getValue?.() || '';
			const uriMatch = pySource.match(/^#\s*WORKFLOW_URI:\s*(.+)$/m);
			const idMatch = pySource.match(/^#\s*WORKFLOW_ID:\s*(.+)$/m);
			const nameMatch = pySource.match(/^#\s*WORKFLOW_NAME:\s*(.+)$/m);
			const wfId = idMatch ? idMatch[1].trim() : currentWorkflowId;
			const wfName = nameMatch ? nameMatch[1].trim() : (currentWorkflowName || wfId);
			if (uriMatch && uriMatch[1].trim()) {
				try {
					const wfTargetUri = URI.parse(uriMatch[1].trim());
					await editorService.openEditor(new WorkflowEditorInput(wfTargetUri, wfName || 'Workflow'), { pinned: true });
					return;
				} catch {}
			}
			const pyUri: URI | undefined = model?.uri || currentPyUri;
			if (pyUri) {
				const wfDir = URI.joinPath(pyUri, '..', '..');
				await editorService.openEditor(new WorkflowEditorInput(wfDir, wfName || 'Workflow'), { pinned: true });
			}
		};

		const openNbBtn = append(syncBox, $('div.workflow-py-toolbox-open-wf-btn'));
		openNbBtn.title = 'Switch to Jupyter Notebook Editor';
		append(openNbBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.notebook)));
		append(openNbBtn, $('span.sync-label', {}, 'Jupyter Notebook'));
		openNbBtn.onmousedown = (e) => e.preventDefault();
		openNbBtn.onclick = async (e) => {
			e.stopPropagation();
			if (currentWorkflowUri) {
				await editorService.openEditor(new WorkflowNotebookEditorInput(currentWorkflowUri, currentWorkflowName || currentWorkflowId), { pinned: true });
				return;
			}
			const model = codeEditor.getModel?.();
			const pySource: string = model?.getValue?.() || '';
			const uriMatch = pySource.match(/^#\s*WORKFLOW_URI:\s*(.+)$/m);
			const idMatch = pySource.match(/^#\s*WORKFLOW_ID:\s*(.+)$/m);
			const nameMatch = pySource.match(/^#\s*WORKFLOW_NAME:\s*(.+)$/m);
			const wfId = idMatch ? idMatch[1].trim() : currentWorkflowId;
			const wfName = nameMatch ? nameMatch[1].trim() : (currentWorkflowName || wfId);
			if (uriMatch && uriMatch[1].trim()) {
				try {
					const wfTargetUri = URI.parse(uriMatch[1].trim());
					await editorService.openEditor(new WorkflowNotebookEditorInput(wfTargetUri, wfName || 'Workflow'), { pinned: true });
					return;
				} catch {}
			}
			const pyUri: URI | undefined = model?.uri || currentPyUri;
			if (pyUri) {
				const wfDir = URI.joinPath(pyUri, '..', '..');
				await editorService.openEditor(new WorkflowNotebookEditorInput(wfDir, wfName || 'Workflow'), { pinned: true });
			}
		};

		// Scrollable Body
		const bodyEl = append(sidebarEl, $('div.workflow-py-toolbox-body'));

		// Section 1: Insert (Built-in Functions, Time & Statement Templates - same style as Python Step Editor)
		const fnGroup = append(bodyEl, $('div.workflow-py-toolbox-group'));
		append(fnGroup, $('div.workflow-py-toolbox-group-title', {}, 'Insert:'));
		const fnChipsWrap = append(fnGroup, $('div.workflow-py-toolbox-chips'));

		const insertItems: Array<{
			label: string;
			snippet: string;
			isExpr?: boolean;
			cursorToken?: string;
		}> = [
			{
				label: 'RUN_TICKETS',
				snippet: 'res = RUN_TICKETS(ticket="", params={})',
				cursorToken: 'ticket="'
			},
			{
				label: 'CREATE_TICKETS',
				snippet: 'new_ticket = CREATE_TICKETS(ticket_type="Task", title="", path=".", params={})',
				cursorToken: 'title="'
			},
			{
				label: 'GET_TICKETS',
				snippet: 'tickets = GET_TICKETS(ticket="")',
				cursorToken: 'ticket="'
			},
			{
				label: 'GET_OUTPUTS',
				snippet: 'out = GET_OUTPUTS(ticket="")',
				cursorToken: 'ticket="'
			},
			{
				label: 'DISPLAY',
				snippet: 'DISPLAY()',
				cursorToken: 'DISPLAY('
			},
			{
				label: 'DATE()',
				snippet: 'DATE()',
				isExpr: true
			},
			{
				label: 'NOW()',
				snippet: 'NOW()',
				isExpr: true
			},
			{
				label: 'TIME()',
				snippet: 'TIME()',
				isExpr: true
			},
			{
				label: 'var = 0',
				snippet: 'start_offset = 0',
				cursorToken: 'start_offset'
			},
			{
				label: 'var = []',
				snippet: 'my_positions = []',
				cursorToken: 'my_positions'
			},
			{
				label: 'var = {}',
				snippet: 'data = {}',
				cursorToken: 'data'
			},
			{
				label: 'for ...:',
				snippet: 'for item in items:\n    pass',
				cursorToken: 'item'
			},
			{
				label: 'if ...:',
				snippet: 'if condition:\n    pass',
				cursorToken: 'condition'
			},
			{
				label: 'def ...:',
				snippet: 'def helper(x):\n    return x',
				cursorToken: 'helper'
			},
			{
				label: 'class ...:',
				snippet: 'class Record:\n    def __init__(self, name):\n        self.name = name',
				cursorToken: 'Record'
			},
			{
				label: '###',
				snippet: '###\n'
			}
		];

		for (const item of insertItems) {
			const chip = append(fnChipsWrap, $('div.node-function-template-chip'));
			chip.textContent = item.label;
			chip.title = `Insert ${item.label}`;
			chip.onmousedown = (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (item.isExpr) {
					insertAtCursor(item.snippet, { isExpressionOrVar: true });
				} else {
					insertAtCursor(item.snippet, {
						isStatement: true,
						cursorInsideToken: item.cursorToken
					});
				}
			};
		}

		// Section 2: Live Variables Auto-Extracted from the Python File
		const varGroup = append(bodyEl, $('div.workflow-py-toolbox-group'));
		append(varGroup, $('div.workflow-py-toolbox-group-title', {}, 'Variables:'));
		const varChipsWrap = append(varGroup, $('div.workflow-py-toolbox-chips'));

		const refreshLiveVariables = () => {
			clearNode(varChipsWrap);
			const model = codeEditor.getModel?.();
			const source: string = model?.getValue?.() || '';
			const vars = WorkflowPythonEditorBridge.extractPythonVariablesFromSource(source);

			const wfIdMatch = source.match(/^#\s*WORKFLOW_ID:\s*(.+)$/m);
			const wfNameMatch = source.match(/^#\s*WORKFLOW_NAME:\s*(.+)$/m);
			if (wfIdMatch) {
				currentWorkflowId = wfIdMatch[1].trim();
			}
			if (wfNameMatch) {
				currentWorkflowName = wfNameMatch[1].trim();
			}

			for (const vName of vars) {
				const chip = append(varChipsWrap, $('div.node-function-field-chip.standard'));
				chip.textContent = vName;
				chip.title = `Insert ${vName}`;
				chip.onmousedown = (e) => {
					e.preventDefault();
					e.stopPropagation();
					insertAtCursor(vName, { isExpressionOrVar: true });
				};
			}
		};

		// Listen to model content changes and model switches on this codeEditor
		let contentChangeListener: any = null;
		const bindModelListeners = () => {
			if (contentChangeListener && typeof contentChangeListener.dispose === 'function') {
				contentChangeListener.dispose();
				contentChangeListener = null;
			}
			const model = codeEditor.getModel?.();
			if (model && typeof model.onDidChangeContent === 'function') {
				contentChangeListener = model.onDidChangeContent(() => {
					if (isWorkflowPyModel()) {
						refreshLiveVariables();
					}
				});
			}
			// If the model is a .workflow.py file that is unexpectedly empty in memory (e.g. from an unsaved blank buffer), restore it from disk
			if (model && isWorkflowPyModel() && typeof model.getValue === 'function' && model.getValue().trim() === '' && model.uri) {
				fileService.readFile(model.uri).then(raw => {
					const diskText = raw.value.toString();
					if (diskText.trim().length > 0 && model.getValue().trim() === '') {
						model.setValue(diskText);
						refreshLiveVariables();
					}
				}).catch(() => {});
			}
			if (isWorkflowPyModel()) {
				refreshLiveVariables();
			}
			applyEditorLayout();
		};

		if (typeof codeEditor.onDidChangeModel === 'function') {
			codeEditor.onDidChangeModel(() => {
				bindModelListeners();
			});
		}

		const controller = {
			refreshContext: (
				pyUri?: URI,
				wfId?: string,
				wfName?: string,
				wfUri?: URI
			) => {
				if (pyUri) {
					currentPyUri = pyUri;
				}
				if (wfId) {
					currentWorkflowId = wfId;
				}
				if (wfName) {
					currentWorkflowName = wfName;
				}
				if (wfUri) {
					currentWorkflowUri = wfUri;
				}
				bindModelListeners();
			}
		};
		(codeEditor as any).__wfPyToolboxController = controller;

		bindModelListeners();
	}

	public static async syncPythonEditorToWorkflow(
		pyFileUri: URI | undefined,
		activeCodeEditor: any,
		fileService: IFileService,
		notificationService: INotificationService,
		entityPersistenceService: IEntityPersistenceService,
		ticketRuntimeService: ITicketWorkflowRuntimeService
	): Promise<boolean> {
		let pythonSource = '';
		if (activeCodeEditor && typeof activeCodeEditor.getModel === 'function') {
			const model = activeCodeEditor.getModel();
			if (model && typeof model.getValue === 'function') {
				pythonSource = model.getValue();
				if (!pyFileUri && model.uri) {
					pyFileUri = model.uri;
				}
			}
		}

		if (!pythonSource && pyFileUri) {
			try {
				const rawFile = await fileService.readFile(pyFileUri);
				pythonSource = rawFile.value.toString();
			} catch (err: any) {
				notificationService.error(`Unable to read Python workflow file: ${err?.message || err}`);
				return false;
			}
		}

		if (!pythonSource.trim()) {
			notificationService.warn('Python file is empty. Synchronization aborted to protect original workflow.');
			return false;
		}

		// Save current buffer to `.workflow.py` file on disk so editor is persisted
		if (pyFileUri) {
			try {
				await fileService.writeFile(pyFileUri, VSBuffer.fromString(pythonSource));
			} catch {}
		}

		const parsedFile = PythonToWorkflowParser.parseWorkflowPythonFile(pythonSource);

		// Locate target workflow URI from header metadata or from `.agents/<id>.workflow.py` parent path
		let targetWorkflowUri: URI | undefined;
		if (parsedFile.workflowUri) {
			try {
				targetWorkflowUri = parsedFile.workflowUri.startsWith('file://')
					? URI.parse(parsedFile.workflowUri)
					: URI.file(parsedFile.workflowUri);
			} catch {}
		}
		if (!targetWorkflowUri && pyFileUri) {
			const fsPath = pyFileUri.fsPath.replace(/\\/g, '/');
			const agentsIdx = fsPath.lastIndexOf('/.agents/');
			if (agentsIdx !== -1) {
				targetWorkflowUri = URI.file(fsPath.substring(0, agentsIdx));
			}
		}

		if (!targetWorkflowUri) {
			notificationService.error('Could not determine original Workflow URI from Python file metadata (# WORKFLOW_URI).');
			return false;
		}

		// Find matching open WorkflowEditor instance if open, or read workflow_flowchart.json from disk
		let openEditor: WorkflowEditor | undefined;
		for (const inst of (WorkflowEditor as any)._openWorkflowEditors) {
			const instUri = inst.getWorkflowUri();
			if (instUri && instUri.fsPath === targetWorkflowUri.fsPath) {
				openEditor = inst;
				break;
			}
		}

		const flowchartJsonUri = URI.joinPath(targetWorkflowUri, '.agents', 'workflow_flowchart.json');
		let workingData: IFlowchartData;

		if (openEditor) {
			workingData = JSON.parse(JSON.stringify(openEditor._data));
		} else if (await fileService.exists(flowchartJsonUri)) {
			try {
				const content = await fileService.readFile(flowchartJsonUri);
				workingData = JSON.parse(content.value.toString());
			} catch (err: any) {
				notificationService.error(`Failed to parse original workflow_flowchart.json: ${err?.message || err}`);
				return false;
			}
		} else {
			notificationService.error(`Original workflow file not found at ${flowchartJsonUri.fsPath}`);
			return false;
		}

		const revealLineInEditor = (lineNo?: number) => {
			if (lineNo && activeCodeEditor) {
				if (typeof activeCodeEditor.revealLineInCenter === 'function') {
					activeCodeEditor.revealLineInCenter(lineNo);
				}
				if (typeof activeCodeEditor.setPosition === 'function') {
					activeCodeEditor.setPosition({ lineNumber: lineNo, column: 1 });
				}
				if (typeof activeCodeEditor.focus === 'function') {
					activeCodeEditor.focus();
				}
			}
		};

		// Run real Python `ast.parse` on each node and connection section via ITicketWorkflowRuntimeService
		const astItems = [
			...parsedFile.nodes.map(n => ({
				nodeId: n.nodeId,
				title: n.title,
				code: PythonCodeBlockParser.sanitizeSystemCommentsPreservingLineNumbers(n.code),
				codeStartLine: n.codeStartLine
			})),
			...parsedFile.connections.map(c => ({
				nodeId: `__conn__:${c.connectionId}`,
				title: `Connection ${c.title || c.connectionId}`,
				code: PythonCodeBlockParser.sanitizeSystemCommentsPreservingLineNumbers(c.code),
				codeStartLine: c.codeStartLine
			}))
		];
		const astResult = await ticketRuntimeService.analyzeWorkflowPythonNodesWithAst(
			targetWorkflowUri,
			workingData.pythonPath,
			astItems
		);

		if (astResult.syntaxErrors.length > 0) {
			const firstErr = astResult.syntaxErrors[0];
			revealLineInEditor(firstErr.line);
			notificationService.error(
				`Synchronization aborted — Python Syntax Error in node '${firstErr.title || firstErr.nodeId}' (line ${firstErr.line}): ${firstErr.message}`
			);
			return false;
		}

		const syncResult = WorkflowSyncManager.synchronizePythonToWorkflow(
			pythonSource,
			workingData,
			astResult.invoked ? astResult.spansByNodeId : undefined
		);

		if (!syncResult.success) {
			const firstErr = syncResult.errors[0];
			revealLineInEditor(firstErr?.line);
			notificationService.error(
				`Synchronization aborted: ${firstErr?.message || 'Validation failed'}`
			);
			return false;
		}

		// Commit changes to open WorkflowEditor (if open) and persist to disk
		if (openEditor) {
			await openEditor.applySynchronizedFlowchartData(workingData);
		} else {
			await fileService.writeFile(flowchartJsonUri, VSBuffer.fromString(JSON.stringify(workingData, null, 2)));
			const snapshot = entityPersistenceService.getSnapshot(targetWorkflowUri);
			if (snapshot) {
				snapshot.customMetadata = {
					...(snapshot.customMetadata || {}),
					flowchartJson: JSON.stringify(workingData, null, 2)
				};
				await entityPersistenceService.saveSnapshot(snapshot);
			}
		}

		if (syncResult.warnings.length > 0) {
			notificationService.warn(syncResult.warnings.join(' '));
		}

		const wfDisplay = parsedFile.workflowName || parsedFile.workflowId || targetWorkflowUri.path.split('/').pop() || 'Workflow';
		notificationService.info(
			`Synced to Workflow '${wfDisplay}': ${syncResult.updatedNodesCount} node(s) and ${syncResult.updatedConnectionsCount} connection(s) synchronized.`
		);
		return true;
	}

	private static hexToRgba(hex?: string, alpha = 0.12): string {
		if (!hex || !hex.startsWith('#')) return `rgba(13, 148, 136, ${alpha})`;
		const clean = hex.replace('#', '');
		const r = parseInt(clean.length === 3 ? clean[0] + clean[0] : clean.substring(0, 2), 16);
		const g = parseInt(clean.length === 3 ? clean[1] + clean[1] : clean.substring(2, 4), 16);
		const b = parseInt(clean.length === 3 ? clean[2] + clean[2] : clean.substring(4, 6), 16);
		return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	}

	private static getEntityBadgeStyle(rawType: string): { color: string; bg: string } {
		const t = (rawType || '').toLowerCase();
		if (t.includes('job') && t.includes('url')) return { color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.16)' };
		if (t.includes('resume')) return { color: '#ec4899', bg: 'rgba(236, 72, 153, 0.16)' };
		if (t.includes('workflow')) return { color: '#14b8a6', bg: 'rgba(20, 184, 166, 0.16)' };
		return { color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.16)' };
	}

	public static escapeXml(str: string): string {
		return (str || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&apos;');
	}

	public static createPdfFromJpeg(jpegBytes: Uint8Array, imgWidth: number, imgHeight: number): Uint8Array {
		const ptWidth = Math.round(imgWidth * 0.75 * 100) / 100;
		const ptHeight = Math.round(imgHeight * 0.75 * 100) / 100;

		const chunks: Uint8Array[] = [];
		const offsets: number[] = [];
		let byteLength = 0;

		const encoder = new TextEncoder();
		function addText(str: string) {
			const arr = encoder.encode(str);
			chunks.push(arr);
			byteLength += arr.length;
		}

		function addBytes(arr: Uint8Array) {
			chunks.push(arr);
			byteLength += arr.length;
		}

		function markObject(objNum: number) {
			offsets[objNum] = byteLength;
			addText(`${objNum} 0 obj\n`);
		}

		addText('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

		// 1 0 obj: Catalog
		markObject(1);
		addText('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

		// 2 0 obj: Pages
		markObject(2);
		addText('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

		// 3 0 obj: Page
		markObject(3);
		addText(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ptWidth} ${ptHeight}] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>\nendobj\n`);

		// 4 0 obj: Contents Stream
		const contentStream = `q\n${ptWidth} 0 0 ${ptHeight} 0 0 cm\n/Im1 Do\nQ\n`;
		markObject(4);
		addText(`<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream\nendobj\n`);

		// 5 0 obj: Image XObject
		markObject(5);
		addText(`<< /Type /XObject /Subtype /Image /Width ${imgWidth} /Height ${imgHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
		addBytes(jpegBytes);
		addText('\nendstream\nendobj\n');

		// xref table
		const startXref = byteLength;
		addText('xref\n0 6\n0000000000 65535 f \n');
		for (let i = 1; i <= 5; i++) {
			const offStr = String(offsets[i]).padStart(10, '0');
			addText(`${offStr} 00000 n \n`);
		}

		// trailer
		addText(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`);

		const result = new Uint8Array(byteLength);
		let cur = 0;
		for (const chunk of chunks) {
			result.set(chunk, cur);
			cur += chunk.length;
		}
		return result;
	}

	public static generateSvgString(
		editor: any,
		nodesToExport: any[],
		linksToExport: any[],
		bounds: { minX: number; minY: number; width: number; height: number },
		format: 'png' | 'jpeg' | 'svg' | 'pdf'
	): string {
		const { minX, minY, width, height } = bounds;

		const usedColors = new Set<string>(['#0d9488', '#ffffff', '#38bdf8', '#7c3aed', '#facc15', '#f43f5e', '#a78bfa', '#fbbf24', '#f87171', '#34d399']);
		linksToExport.forEach(l => { if (l.color) usedColors.add(l.color); });
		nodesToExport.forEach(n => { if (n.color) usedColors.add(n.color); });

		let defs = '<defs>\n';
		usedColors.forEach(color => {
			const clean = color.replace('#', '');
			defs += `    <marker id="export-arrow-${clean}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
        <path d="M 0 1 L 10 5 L 0 9 z" fill="${color}" />
    </marker>
    <marker id="export-arrow-start-${clean}" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="6" markerHeight="6" orient="auto">
        <path d="M 10 1 L 0 5 L 10 9 z" fill="${color}" />
    </marker>\n`;
		});
		defs += '</defs>\n';

		const bgFill = (format === 'jpeg' || format === 'pdf') ? '#1e1e1e' : '#18181b';
		let body = `  <rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${bgFill}" rx="8"/>\n`;

		// Links
		for (const link of linksToExport) {
			const fromNode = nodesToExport.find(n => n.id === link.from);
			const toNode = nodesToExport.find(n => n.id === link.to);
			if (!fromNode || !toNode) continue;

			const closest = editor._getClosestPorts(fromNode, toNode);
			const fromPort = link.fromPort || closest.fromPort;
			const toPort = link.toPort || closest.toPort;

			const startCoords = editor._getPortCoords(fromNode, fromPort);
			const endCoords = editor._getPortCoords(toNode, toPort);

			let x1 = startCoords.x;
			let y1 = startCoords.y;
			let x2 = endCoords.x;
			let y2 = endCoords.y;

			if ((fromPort === 'right' && toPort === 'left') || (fromPort === 'left' && toPort === 'right')) {
				if (Math.abs(y1 - y2) <= 12) y2 = y1;
			}
			if ((fromPort === 'top' && toPort === 'bottom') || (fromPort === 'bottom' && toPort === 'top')) {
				if (Math.abs(x1 - x2) <= 12) x2 = x1;
			}

			const hasEndArrow = link.style === 'arrow-single' || link.style === 'arrow-double';
			const hasStartArrow = link.style === 'arrow-double';

			if (hasStartArrow) {
				if (fromPort === 'right') x1 += 8;
				else if (fromPort === 'left') x1 -= 8;
				else if (fromPort === 'bottom') y1 += 8;
				else if (fromPort === 'top') y1 -= 8;
			}
			if (hasEndArrow) {
				if (toPort === 'left') x2 -= 8;
				else if (toPort === 'right') x2 += 8;
				else if (toPort === 'top') y2 -= 8;
				else if (toPort === 'bottom') y2 -= 8;
			}

			const routingMode = link.routing || editor._activeRoutingMode || 'orthogonal';
			const d = editor._getLinkPathData(x1, y1, fromPort, x2, y2, toPort, routingMode, link.waypoints);

			const linkColor = link.color || '#0d9488';
			const cleanColor = linkColor.replace('#', '');
			const dashAttr = link.style === 'dashed' ? 'stroke-dasharray="6,4"' : '';
			const markerEnd = hasEndArrow ? `marker-end="url(#export-arrow-${cleanColor})"` : '';
			const markerStart = hasStartArrow ? `marker-start="url(#export-arrow-start-${cleanColor})"` : '';

			body += `  <path d="${d}" fill="none" stroke="${linkColor}" stroke-width="2" ${dashAttr} ${markerStart} ${markerEnd} />\n`;

			if (link.label) {
				const mid = editor._getLinkMidpoint(link);
				const escapedLabel = WorkflowPythonEditorBridge.escapeXml(link.label);
				const labelW = Math.max(40, link.label.length * 7 + 16);
				body += `  <rect x="${mid.x - labelW / 2}" y="${mid.y - 11}" width="${labelW}" height="22" rx="4" fill="#1e1e1e" stroke="${linkColor}" stroke-width="1"/>\n`;
				body += `  <text x="${mid.x}" y="${mid.y + 4}" fill="#ffffff" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="11" font-weight="500" text-anchor="middle">${escapedLabel}</text>\n`;
			}
		}

		// Nodes
		for (const node of nodesToExport) {
			const nodeColor = node.color || '#0d9488';
			const fillColor = WorkflowPythonEditorBridge.hexToRgba(nodeColor, 0.18);
			const strokeWidth = 2;

			if (node.type === 'round-rect') {
				body += `  <rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="12" ry="12" fill="${fillColor}" stroke="${nodeColor}" stroke-width="${strokeWidth}" />\n`;
			} else if (node.type === 'rect') {
				body += `  <rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="4" ry="4" fill="${fillColor}" stroke="${nodeColor}" stroke-width="${strokeWidth}" />\n`;
			} else if (node.type === 'circle') {
				const cx = node.x + node.width / 2;
				const cy = node.y + node.height / 2;
				body += `  <ellipse cx="${cx}" cy="${cy}" rx="${node.width / 2}" ry="${node.height / 2}" fill="${fillColor}" stroke="${nodeColor}" stroke-width="${strokeWidth}" />\n`;
			} else if (node.type === 'diamond') {
				const cx = node.x + node.width / 2;
				const cy = node.y + node.height / 2;
				const pts = `${cx},${node.y} ${node.x + node.width},${cy} ${cx},${node.y + node.height} ${node.x},${cy}`;
				body += `  <polygon points="${pts}" fill="${fillColor}" stroke="${nodeColor}" stroke-width="${strokeWidth}" />\n`;
			}

			const textColor = node.textColor || '#ffffff';
			const isBold = node.isBold ? 'font-weight="bold"' : 'font-weight="500"';
			const isItalic = node.isItalic ? 'font-style="italic"' : '';
			const textDec = (node.isUnderline && node.isStrikethrough) ? 'text-decoration="underline line-through"' : (node.isUnderline ? 'text-decoration="underline"' : (node.isStrikethrough ? 'text-decoration="line-through"' : ''));

			const maxTextWidth = (node.type === 'diamond') ? Math.max(20, Math.floor(node.width * 0.65)) : Math.max(20, node.width - 16);
			const lines = WorkflowPythonEditorBridge.wrapText(node.label || '', maxTextWidth, 11);
			const lineHeight = 15;
			const totalTextHeight = lines.length * lineHeight;

			let textAnchor = 'middle';
			let textX = node.x + node.width / 2;
			if (node.textAlign === 'left' && node.type !== 'diamond') {
				textAnchor = 'start';
				textX = node.x + 8;
			} else if (node.textAlign === 'right' && node.type !== 'diamond') {
				textAnchor = 'end';
				textX = node.x + node.width - 8;
			}

			let startY = node.y + (node.height - totalTextHeight) / 2 + 11;
			if (node.verticalAlign === 'top' && node.type !== 'diamond') {
				startY = node.y + 13;
			} else if (node.verticalAlign === 'bottom' && node.type !== 'diamond') {
				startY = node.y + node.height - totalTextHeight + 11;
			}

			body += `  <text x="${textX}" y="${startY}" fill="${textColor}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="11" ${isBold} ${isItalic} ${textDec} text-anchor="${textAnchor}">\n`;
			for (let i = 0; i < lines.length; i++) {
				const lineText = WorkflowPythonEditorBridge.escapeXml(lines[i]);
				const dy = i === 0 ? 0 : lineHeight;
				body += `    <tspan x="${textX}" dy="${dy}">${lineText}</tspan>\n`;
			}
			body += `  </text>\n`;
		}

		return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}">\n${defs}${body}</svg>`;
	}

	public static wrapText(text: string, maxWidth: number, fontSize: number = 11): string[] {
		const rawLines = (text || '').split('\n');
		const result: string[] = [];
		const avgCharWidth = fontSize * 0.56;
		const maxChars = Math.max(1, Math.floor(maxWidth / avgCharWidth));

		for (const raw of rawLines) {
			if (!raw) {
				result.push('');
				continue;
			}
			if (raw.length <= maxChars) {
				result.push(raw);
				continue;
			}
			const words = raw.split(' ');
			let cur = '';
			for (const w of words) {
				if (!cur) {
					cur = w;
				} else if ((cur + ' ' + w).length <= maxChars) {
					cur += ' ' + w;
				} else {
					result.push(cur);
					cur = w;
				}
			}
			if (cur) {
				result.push(cur);
			}
		}
		return result.length > 0 ? result : [''];
	}

	public static renderDisplayInspectorCardElement(editor: any, card: any): HTMLElement {
		// Create Card element
		const cardEl = document.createElement('div');
		cardEl.className = 'workflow-display-card';
		cardEl.setAttribute('data-card-id', card.id);

		// Card Header
		const cardHeader = append(cardEl, $('.workflow-display-card-header'));
		cardHeader.title = 'Click to toggle collapse / expand';

		const metaBox = append(cardHeader, $('.workflow-display-card-meta'));

		// Collapse/Expand chevron indicator
		let isCollapsed = Boolean(card._isCollapsed);
		const chevronIcon = append(metaBox, $('span.workflow-display-card-chevron' + ThemeIcon.asCSSSelector(isCollapsed ? Codicon.chevronRight : Codicon.chevronDown)));
		chevronIcon.title = 'Click to toggle collapse / expand';

		const nodeBadge = append(metaBox, $('.workflow-display-card-node'));

		// Friendly node label defined by user (standard neutral white text) + internal ID in parens
		const friendlyName = (card.nodeTitle && card.nodeTitle.trim()) ? card.nodeTitle.trim() : 'Node';
		const nodeTitleSpan = append(nodeBadge, $('span.node-title-main'));
		nodeTitleSpan.textContent = friendlyName;

		if (card.nodeId) {
			const rawNum = card.nodeId.replace(/^node_/, '');
			const nodeIdSpan = append(nodeBadge, $('span.node-id-sub'));
			nodeIdSpan.textContent = ` (${rawNum})`;
			nodeIdSpan.title = `Internal ID: ${card.nodeId}`;
		}

		if (card.expression) {
			const collapsedTag = append(metaBox, $('span.workflow-display-card-collapsed-tag'));
			editor._renderExpressionWithTicketBadges(collapsedTag, card.expression, false);
		}

		const timeEl = append(metaBox, $('.workflow-display-card-time'));
		timeEl.textContent = card.timestamp;

		const copyText = async (text: string): Promise<boolean> => {
			let ok = false;
			try {
				if (navigator?.clipboard?.writeText) {
					await navigator.clipboard.writeText(text);
					ok = true;
				}
			} catch { }
			if (!ok) {
				try {
					const ta = document.createElement('textarea');
					ta.value = text;
					ta.style.position = 'fixed';
					ta.style.left = '-9999px';
					ta.style.top = '-9999px';
					document.body.appendChild(ta);
					ta.focus();
					ta.select();
					ok = document.execCommand('copy');
					ta.remove();
				} catch { }
			}
			if (!ok) {
				try {
					await editor._clipboardService.writeText(text);
					ok = true;
				} catch { }
			}
			return ok;
		};

		const cardActions = append(cardHeader, $('.workflow-display-card-actions'));

		// Collapse / Expand toggle button
		const collapseBtn = append(cardActions, $('button.workflow-display-btn-action.workflow-display-btn-card-toggle'));
		collapseBtn.textContent = isCollapsed ? '+' : '–';
		collapseBtn.title = isCollapsed ? 'Expand card (展开)' : 'Collapse card (折叠)';

		const copyBtn = append(cardActions, $('button.workflow-display-btn-action'));
		copyBtn.textContent = 'Copy';
		copyBtn.title = 'Copy entire card value';
		copyBtn.onclick = async (e) => {
			e.stopPropagation();
			const ok = await copyText(card.formattedText);
			copyBtn.textContent = ok ? 'Copied!' : 'Failed';
			setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = 'Copy'; }, 1500);
		};

		const dismissBtn = append(cardActions, $('button.workflow-display-btn-action'));
		dismissBtn.textContent = '✕';
		dismissBtn.title = 'Dismiss card';
		dismissBtn.onclick = (e) => {
			e.stopPropagation();
			cardEl.remove();
			editor._displayInspectorCards = editor._displayInspectorCards.filter(c => c.id !== card.id);
			if (editor._workflowUri) {
				editor._workflowExecutionService.removeDisplayCard(editor._workflowUri, card.id);
			}
			if (editor._displayInspectorContainer) {
				const titleText = editor._displayInspectorContainer.querySelector('.inspector-title-text');
				if (titleText) {
					titleText.textContent = `Live Display (${editor._displayInspectorCards.length})`;
				}
				if (editor._displayInspectorCards.length === 0) {
					editor._displayInspectorContainer.remove();
					editor._displayInspectorContainer = null;
					editor._displayInspectorCardsContainer = null;
				}
			}
			editor._updateLiveDisplayToolbarBtn();
		};

		const applyCollapseState = (collapsed: boolean) => {
			cardEl.classList.toggle('collapsed', collapsed);
			collapseBtn.textContent = collapsed ? '+' : '–';
			collapseBtn.title = collapsed ? 'Expand card (展开)' : 'Collapse card (折叠)';
			chevronIcon.className = 'workflow-display-card-chevron ' + ThemeIcon.asCSSSelector(collapsed ? Codicon.chevronRight : Codicon.chevronDown);
		};

		if (isCollapsed) {
			applyCollapseState(true);
		}

		const toggleCollapse = (e?: Event) => {
			if (e) {
				e.stopPropagation();
			}
			isCollapsed = !isCollapsed;
			card._isCollapsed = isCollapsed;
			applyCollapseState(isCollapsed);
		};

		collapseBtn.onclick = (e) => {
			e.stopPropagation();
			toggleCollapse(e);
		};

		cardHeader.onclick = (e) => {
			const target = e.target as HTMLElement | null;
			if (target?.closest('.workflow-display-btn-action:not(.workflow-display-btn-card-toggle)')) {
				return;
			}
			toggleCollapse(e);
		};

		// Expression Pill
		const exprEl = append(cardEl, $('.workflow-display-card-expr'));
		editor._renderExpressionWithTicketBadges(exprEl, card.expression, false);

		// Card Body / Outputs Sections or Ticket Handle
		if (card.ticketHandle) {
			const th = card.ticketHandle;
			const handleEl = append(cardEl, $('.workflow-display-ticket-handle-card'));

			// Banner: Ticket Code & Type with Open in Tab button
			const bannerEl = append(handleEl, $('.workflow-display-ticket-banner'));
			bannerEl.title = 'Double-click to open in Editor Tab';
			bannerEl.ondblclick = (e) => {
				e.stopPropagation();
				editor._openModuleInEditor({ type: th.ticketType, name: th.ticketName || th.ticketId });
			};

			const leftGroup = append(bannerEl, $('.workflow-display-ticket-banner-left'));
			const ticketBadge = append(leftGroup, $('span.workflow-display-ticket-badge'));
			const rawType = th.ticketType || card.ticketType || 'Ticket';
			ticketBadge.textContent = rawType.toUpperCase();
			const badgeStyle = WorkflowPythonEditorBridge.getEntityBadgeStyle(rawType);
			ticketBadge.style.color = badgeStyle.color;
			ticketBadge.style.backgroundColor = badgeStyle.bg;
			ticketBadge.style.borderColor = WorkflowPythonEditorBridge.hexToRgba(badgeStyle.color, 0.4);

			const bannerTitle = append(leftGroup, $('span.workflow-display-ticket-title'));
			bannerTitle.textContent = `${th.ticketId}${th.title && th.title !== th.ticketId ? ` (${th.title})` : ''}`;

			const rightGroup = append(bannerEl, $('.workflow-display-ticket-banner-right'));
			const statusChip = append(rightGroup, $('span.workflow-display-handle-status'));
			statusChip.textContent = th.status || 'Todo';

			// Open in Tab Button
			const openTabBtn = append(rightGroup, $('button.workflow-display-btn-open-tab'));
			openTabBtn.textContent = '↗ Tab';
			openTabBtn.title = 'Open ticket in Editor Tab';
			openTabBtn.onclick = (e) => {
				e.stopPropagation();
				editor._openModuleInEditor({ type: th.ticketType, name: th.ticketName || th.ticketId });
			};

			// Metadata Grid
			const metaGrid = append(handleEl, $('.workflow-display-handle-meta-grid'));

			// Row 1: Created At
			if (th.createdAt) {
				const row = append(metaGrid, $('.workflow-display-handle-meta-row'));
				const label = append(row, $('.handle-meta-label'));
				label.textContent = 'Created:';
				const val = append(row, $('.handle-meta-val'));
				val.textContent = th.createdAt;
			}

			// Row 2: Target Path
			if (th.targetFolder) {
				const row = append(metaGrid, $('.workflow-display-handle-meta-row'));
				const label = append(row, $('.handle-meta-label'));
				label.textContent = 'Folder:';
				const val = append(row, $('.handle-meta-val.folder-path'));
				const displayFolder = th.targetFolder.length > 45 ? '...' + th.targetFolder.substring(th.targetFolder.length - 42) : th.targetFolder;
				val.textContent = displayFolder;
				val.title = th.targetFolder;
			}

			// Row 3: Parameters
			if (th.parameters && Object.keys(th.parameters).length > 0) {
				const paramsBox = append(handleEl, $('.workflow-display-handle-params-box'));
				const paramsHeader = append(paramsBox, $('.workflow-display-handle-params-header'));
				paramsHeader.textContent = `Parameters (${Object.keys(th.parameters).length})`;
				const paramsList = append(paramsBox, $('.workflow-display-handle-params-list'));
				for (const [pk, pv] of Object.entries(th.parameters)) {
					const chip = append(paramsList, $('.workflow-display-handle-param-chip'));
					const kSpan = append(chip, $('span.param-key'));
					kSpan.textContent = pk;
					const eqSpan = append(chip, $('span.param-sep'));
					eqSpan.textContent = '=';
					const vSpan = append(chip, $('span.param-val'));
					const rawValStr = typeof pv === 'object' ? JSON.stringify(pv) : String(pv);
					vSpan.textContent = rawValStr.length > 50 ? rawValStr.substring(0, 47) + '...' : rawValStr;
					vSpan.title = rawValStr;
				}
			}

			// Hint Bar: Ticket ready to run
			const hintEl = append(handleEl, $('.workflow-display-handle-hint'));
			hintEl.textContent = `Ticket ready. Use RUN_TICKETS(ticket="${th.ticketId || th.ticketName}") to execute.`;
		} else if (card.outputItems && card.outputItems.length > 0) {
			// Ticket Meta Banner if available
			if (card.ticketTitle || card.ticketId) {
				const bannerEl = append(cardEl, $('.workflow-display-ticket-banner'));
				const bannerTitle = append(bannerEl, $('span.workflow-display-ticket-title'));
				const hasTitle = Boolean(card.ticketTitle && card.ticketTitle.trim().length > 0);
				const hasId = Boolean(card.ticketId && card.ticketId.trim().length > 0);
				if (hasTitle && hasId && card.ticketTitle !== card.ticketId) {
					bannerTitle.textContent = `${card.ticketTitle} (${card.ticketId})`;
				} else {
					bannerTitle.textContent = card.ticketTitle || card.ticketId || 'Ticket';
				}
				if (card.ticketType) {
					const bannerType = append(bannerEl, $('span.workflow-display-ticket-type'));
					bannerType.textContent = card.ticketType;
				}
			}

			// Sections Toolbar (Expand All / Collapse All)
			const sectionsToolbar = append(cardEl, $('.workflow-display-sections-toolbar'));
			const countLabel = append(sectionsToolbar, $('span.workflow-display-sections-count'));
			countLabel.textContent = `Outputs (${card.outputItems.length})`;

			const toggleAllBtn = append(sectionsToolbar, $('button.workflow-display-btn-toggle-all'));
			toggleAllBtn.textContent = 'Expand All';

			const sectionsContainer = append(cardEl, $('.workflow-display-sections-container'));
			const sectionToggles: ((open: boolean) => void)[] = [];
			const itemStates: boolean[] = card.outputItems.map(() => false);
			let areAllExpanded = false;

			const updateToggleAllBtn = () => {
				const allExpanded = itemStates.every(Boolean);
				areAllExpanded = allExpanded;
				toggleAllBtn.textContent = allExpanded ? 'Collapse All' : 'Expand All';
			};

			card.outputItems.forEach((item, idx) => {
				const sectionEl = append(sectionsContainer, $('.workflow-output-section-strip'));

				// Strip Header
				const stripHeader = append(sectionEl, $('.workflow-output-section-header'));
				stripHeader.title = 'Click to expand / collapse';

				const leftGroup = append(stripHeader, $('.workflow-output-section-left'));
				const chevron = append(leftGroup, $('span.workflow-output-chevron'));
				chevron.textContent = '▶';

				const indexBadge = append(leftGroup, $('span.workflow-output-index-badge'));
				indexBadge.textContent = `#${idx + 1}`;

				const titleSpan = append(leftGroup, $('span.workflow-output-title'));
				titleSpan.textContent = item.label;

				if (item.format) {
					const formatBadge = append(leftGroup, $('span.workflow-output-format-badge'));
					formatBadge.textContent = item.format.toUpperCase();
				}

				if (item.status) {
					const statusBadge = append(leftGroup, $(`span.workflow-output-status-badge.${item.status}`));
					statusBadge.textContent = item.status === 'ready' ? 'Ready' : (item.status === 'pending' ? 'Pending' : (item.status === 'failed' ? 'Failed' : 'Empty'));
				}

				// Right Action: Item Copy
				const rightGroup = append(stripHeader, $('.workflow-output-section-right'));
				const itemCopyBtn = append(rightGroup, $('button.workflow-display-btn-action.output-item-copy'));
				itemCopyBtn.textContent = 'Copy';
				itemCopyBtn.title = 'Copy this output content';
				itemCopyBtn.onclick = async (e) => {
					e.stopPropagation();
					const ok = await copyText(item.content);
					itemCopyBtn.textContent = ok ? 'Copied!' : 'Failed';
					setTimeout(() => { if (itemCopyBtn.isConnected) itemCopyBtn.textContent = 'Copy'; }, 1500);
				};

				// Strip Content Body
				const stripBody = append(sectionEl, $('.workflow-output-section-body'));
				const preContent = append(stripBody, $('pre.workflow-output-pre'));
				preContent.textContent = item.content;

				// All items collapsed by default
				let isExpanded = false;
				const setExpanded = (expanded: boolean, scrollIntoView = false) => {
					isExpanded = expanded;
					itemStates[idx] = expanded;
					sectionEl.classList.toggle('expanded', isExpanded);
					chevron.textContent = isExpanded ? '▼' : '▶';
					stripBody.style.display = isExpanded ? 'block' : 'none';
					if (scrollIntoView && isExpanded) {
						setTimeout(() => {
							if (sectionEl.isConnected) {
								sectionEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
							}
						}, 60);
					}
				};
				setExpanded(false);

				stripHeader.onclick = (e) => {
					e.stopPropagation();
					setExpanded(!isExpanded, true);
					updateToggleAllBtn();
				};

				sectionToggles.push((open: boolean) => setExpanded(open, false));
			});

			toggleAllBtn.onclick = (e) => {
				e.stopPropagation();
				areAllExpanded = !areAllExpanded;
				sectionToggles.forEach(t => t(areAllExpanded));
				toggleAllBtn.textContent = areAllExpanded ? 'Collapse All' : 'Expand All';
			};
		} else {
			// Card Body Fallback
			const bodyEl = append(cardEl, $('.workflow-display-card-body'));
			bodyEl.textContent = card.formattedText;
		}

		// Card Footer
		const footerEl = append(cardEl, $('.workflow-display-card-footer'));
		const valType = typeof card.value;
		let typeDesc = valType;
		if (valType === 'object') {
			if (card.value === null) {
				typeDesc = 'null';
			} else if (Array.isArray(card.value)) {
				typeDesc = `array [${card.value.length}]`;
			} else {
				typeDesc = `object {${Object.keys(card.value).length} keys}`;
			}
		} else if (valType === 'string') {
			typeDesc = `string (${card.value.length} chars)`;
		}
		footerEl.textContent = `Type: ${typeDesc}`;

		return cardEl;
	}

	public static showPythonInterpreterMenu(editor: any, anchorEl: HTMLElement, onUpdated?: (newPath: string) => void): void {
		const existing = document.querySelector('.workflow-python-env-popover');
		if (existing) {
			existing.remove();
		}

		const wfDir = editor._workflowUri
			? (editor._workflowUri.path.endsWith('.json') || editor._workflowUri.path.endsWith('.workflow') ? URI.joinPath(editor._workflowUri, '..') : editor._workflowUri)
			: URI.file('/');

		const popover = document.createElement('div');
		popover.className = 'workflow-python-env-popover';
		popover.style.position = 'fixed';
		popover.style.zIndex = '100000';
		popover.style.width = '380px';
		popover.style.background = '#18181b';
		popover.style.border = '1px solid rgba(192, 132, 252, 0.35)';
		popover.style.borderRadius = '8px';
		popover.style.boxShadow = '0 12px 32px rgba(0, 0, 0, 0.65)';
		popover.style.padding = '12px';
		popover.style.color = '#e4e4e7';
		popover.style.fontSize = '12px';
		popover.style.fontFamily = 'var(--monaco-font-family, -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", sans-serif)';

		const rect = anchorEl.getBoundingClientRect();
		popover.style.top = `${Math.min(window.innerHeight - 280, rect.bottom + 6)}px`;
		popover.style.left = `${Math.max(12, Math.min(window.innerWidth - 380, rect.left - 80))}px`;

		popover.onmousedown = (e) => e.stopPropagation();
		popover.onclick = (e) => e.stopPropagation();

		const titleRow = append(popover, $('div'));
		titleRow.style.display = 'flex';
		titleRow.style.alignItems = 'center';
		titleRow.style.justifyContent = 'space-between';
		titleRow.style.marginBottom = '8px';
		const titleSpan = append(titleRow, $('span'));
		titleSpan.style.display = 'inline-flex';
		titleSpan.style.alignItems = 'center';
		titleSpan.style.gap = '6px';
		titleSpan.style.fontWeight = '600';
		titleSpan.style.color = '#d8b4fe';
		append(titleSpan, $('span' + ThemeIcon.asCSSSelector(Codicon.python)));
		append(titleSpan, $('span', {}, 'Workflow Python Interpreter'));
		const closeBtn = append(titleRow, $('span', {}, '✕'));
		closeBtn.style.cursor = 'pointer';
		closeBtn.style.opacity = '0.7';
		closeBtn.onclick = () => popover.remove();

		const desc = append(popover, $('div', {}, 'All Python steps, variables, functions, classes, and branch conditions in this workflow run in this Python interpreter:'));
		desc.style.fontSize = '11px';
		desc.style.color = '#a1a1aa';
		desc.style.marginBottom = '8px';
		desc.style.lineHeight = '1.4';

		const inputRow = append(popover, $('div'));
		inputRow.style.display = 'flex';
		inputRow.style.gap = '6px';
		inputRow.style.marginBottom = '8px';

		const pathInput = append(inputRow, $('input')) as HTMLInputElement;
		pathInput.type = 'text';
		pathInput.value = editor._data?.pythonPath || editor._detectedPythonPath || 'python3';
		pathInput.placeholder = 'e.g. .venv/bin/python or /usr/bin/python3';
		pathInput.style.flex = '1';
		pathInput.style.background = '#09090b';
		pathInput.style.color = '#ffffff';
		pathInput.style.border = '1px solid rgba(255,255,255,0.18)';
		pathInput.style.borderRadius = '4px';
		pathInput.style.padding = '5px 8px';
		pathInput.style.fontSize = '11.5px';
		pathInput.style.fontFamily = 'inherit';
		pathInput.style.outline = 'none';

		const browseBtn = append(inputRow, $('button', {}, 'Browse...'));
		browseBtn.style.background = 'rgba(255,255,255,0.08)';
		browseBtn.style.color = '#e4e4e7';
		browseBtn.style.border = '1px solid rgba(255,255,255,0.18)';
		browseBtn.style.borderRadius = '4px';
		browseBtn.style.padding = '4px 8px';
		browseBtn.style.cursor = 'pointer';
		browseBtn.style.fontSize = '11px';
		browseBtn.style.fontFamily = 'inherit';

		const targetVenvDir = URI.joinPath(wfDir, '.venv').fsPath;
		const statusBox = append(popover, $('div'));
		statusBox.style.fontSize = '11px';
		statusBox.style.padding = '6px 8px';
		statusBox.style.borderRadius = '4px';
		statusBox.style.background = 'rgba(255,255,255,0.04)';
		statusBox.style.marginBottom = '10px';
		statusBox.style.color = '#a1a1aa';
		statusBox.style.wordBreak = 'break-all';
		statusBox.textContent = `Current detected: ${editor._detectedPythonPath || 'python3'}`;

		const applyPath = async (newPath?: string) => {
			const clean = (newPath || '').trim();
			if (editor._data) {
				editor._data.pythonPath = clean || undefined;
				await editor._saveFlowchartData();
			}
			await editor._updatePythonEnvButtonLabel();
			const active = editor._data?.pythonPath || editor._detectedPythonPath || 'python3';
			pathInput.value = active;
			if (onUpdated) onUpdated(active);
		};

		browseBtn.onclick = async () => {
			const uris = await editor._fileDialogService.showOpenDialog({
				title: 'Select Python Interpreter Binary',
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				defaultUri: wfDir
			});
			if (uris && uris.length > 0) {
				const chosen = uris[0].fsPath;
				pathInput.value = chosen;
				await applyPath(chosen);
				statusBox.style.color = '#4ade80';
				statusBox.textContent = `✓ Selected Python interpreter: ${chosen}`;
			}
		};

		const btnRow = append(popover, $('div'));
		btnRow.style.display = 'flex';
		btnRow.style.gap = '6px';
		btnRow.style.flexWrap = 'wrap';
		btnRow.style.justifyContent = 'space-between';

		const makeBtn = (label: string, primary = false) => {
			const b = append(btnRow, $('button', {}, label));
			b.style.background = primary ? '#7c3aed' : 'rgba(255,255,255,0.08)';
			b.style.color = '#ffffff';
			b.style.border = primary ? '1px solid #9333ea' : '1px solid rgba(255,255,255,0.16)';
			b.style.borderRadius = '4px';
			b.style.padding = '4px 9px';
			b.style.cursor = 'pointer';
			b.style.fontSize = '11px';
			b.style.fontFamily = 'inherit';
			return b;
		};

		const autoBtn = makeBtn('Auto (.venv / python3)');
		autoBtn.onclick = async () => {
			await applyPath('');
			statusBox.style.color = '#38bdf8';
			statusBox.textContent = `✓ Auto-detected: ${editor._detectedPythonPath}`;
		};

		const testBtn = makeBtn('Test Env');
		testBtn.onclick = async () => {
			statusBox.style.color = '#facc15';
			statusBox.textContent = 'Testing Python interpreter...';
			const res = await editor._ticketRuntimeService.testPythonInterpreter(wfDir, pathInput.value.trim());
			if (res.success) {
				statusBox.style.color = '#4ade80';
				statusBox.textContent = `✓ ${res.version}`;
			} else {
				statusBox.style.color = '#f87171';
				statusBox.textContent = `✕ ${res.error || res.version}`;
			}
		};

		const venvBtn = makeBtn('Create .venv');
		venvBtn.title = `Create virtual environment at: ${targetVenvDir}`;
		venvBtn.onclick = async () => {
			statusBox.style.color = '#facc15';
			statusBox.textContent = `Creating .venv at ${targetVenvDir} ...`;
			const res = await editor._ticketRuntimeService.createVirtualEnv(wfDir, '.venv');
			if (res.success && res.pythonPath) {
				await applyPath(res.pythonPath);
				statusBox.style.color = '#4ade80';
				statusBox.textContent = `✓ Created & activated: ${res.pythonPath}`;
			} else {
				statusBox.style.color = '#f87171';
				statusBox.textContent = `✕ ${res.error || res.output || 'Failed to create .venv'}`;
			}
		};

		const saveBtn = makeBtn('Save', true);
		saveBtn.onclick = async () => {
			await applyPath(pathInput.value.trim());
			popover.remove();
		};

		(editor._container || document.body).appendChild(popover);

		const onDocMouseDown = (ev: MouseEvent) => {
			if (!popover.contains(ev.target as Node) && ev.target !== anchorEl) {
				popover.remove();
				document.removeEventListener('mousedown', onDocMouseDown, true);
			}
		};
		setTimeout(() => document.addEventListener('mousedown', onDocMouseDown, true), 50);
	}

	public static async openWorkflowAsNotebook(editor: any, focusNodeId?: string): Promise<void> {
		if (!editor._workflowUri) {
			editor._notificationService?.warn('Cannot open Jupyter Notebook editor: Workflow URI is not available.');
			return;
		}
		await editor._saveFlowchartData?.(true);
		const snapshot = editor._entityPersistenceService?.getSnapshot(editor._workflowUri);
		const workflowId = snapshot?.ticketId || editor.input?.workflowName || editor._workflowUri.path.split('/').pop() || 'workflow';
		const workflowName = snapshot?.entityName || editor.input?.workflowName || workflowId;
		const nbInput = new WorkflowNotebookEditorInput(editor._workflowUri, workflowName || workflowId, focusNodeId);
		const pane: any = await editor._editorService.openEditor(nbInput, { pinned: true, preserveFocus: false });
		if (focusNodeId && pane && typeof pane.focusNodeSection === 'function') {
			pane.focusNodeSection(focusNodeId);
		}
	}

}
