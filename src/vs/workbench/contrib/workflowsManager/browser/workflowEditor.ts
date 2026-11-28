/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import './media/workflowEditor.css';
import { collectSubWorkflowRefsFromNodes, SubWorkflowCallGraphRoot } from '../common/subWorkflowCallGraph.js';
import { buildExtractInputBindings, buildSubWorkflowCallNode, collectCanvasVariableNames, extractSubWorkflowFromCanvas, findVariablesUsedOutsideSelection } from '../common/subWorkflowExtract.js';
import { getSubWorkflowDefinitionUri } from '../common/subWorkflowTicket.js';
import { $, append, clearNode, h, addDisposableListener, getWindow, isHTMLElement } from '../../../../base/browser/dom.js';
import { CodeWindow } from '../../../../base/browser/window.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { GroupDirection, IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { WorkflowEditorInput } from './workflowEditorInput.js';
import { openSubWorkflowLiveView, SubWorkflowCanvasEditorInput } from './subWorkflowLiveView.js';
import { isOutlineBlankClickTarget, OutlineListOverscroll } from './outlineListOverscroll.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IEntityPersistenceService, ICustomModule, ICustomField, IOutputSpec, CustomFieldType, IVoiceNoteClip, IParameterDefinition, generateSmartPythonVarName, sanitizePythonVarName, SSH_DEFAULT_QUICK_COMMANDS, normalizeSshCommandsList, normalizeLegacyFieldTypes } from '../../entityPersistence/common/entityPersistence.js';
import { ICustomModulesService } from '../../customModules/common/customModules.js';
import { getNodeComponentPalette } from '../../customModules/common/componentRegistry.js';
import { getSubWorkflowTicketVisual } from '../../customModules/common/subWorkflowType.js';
import { CustomModuleSchemaEditorInput } from '../../customModules/browser/customModuleSchemaEditorInput.js';
import { isCommentKeybinding, togglePythonComment } from '../../customModules/browser/pythonSyntaxHighlighter.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EntityDetailEditorInput } from '../../workspacesExplorer/browser/entityDetailEditorInput.js';
import { EntityDetailEditor } from '../../workspacesExplorer/browser/entityDetailEditor.js';
import { MainWorkspaceViewPane } from '../../workspacesExplorer/browser/workspacesExplorerPane.js';
import { IWorkflowExecutionService, IWorkflowDisplayCard } from '../common/workflowExecutionService.js';
import { ITicketWorkflowRuntimeService } from './ticketWorkflowRuntime.js';
import { resolveDefaultModelId } from '../../agentsManager/common/agentsManager.js';
import {
	WorkflowToPythonConverter,
	PythonToWorkflowParser,
	PythonCodeBlockParser,
	WorkflowSyncManager,
	WorkflowPythonEditorBridge
} from './workflowPythonSync.js';
import {
	ISubWorkflowDefinition,
	IWorkflowExecutionRun,
	IWorkflowLogEntry,
	IPrimitiveExecutionStepResult,
	IExecutedTicketRecord,
	IWorkflowPathStep,
	IWorkflowNodeOperation,
	IWorkflowStepTransition,
	hasWorkflowProperty,
	isWorkflowRecord,
	IWorkflowRecord
} from '../common/workflowExecutionModel.js';

export interface INodeVariable {
	name: string;
	initialValue: string; // e.g. "None", "True", "False", "0", "'admin'"
	expression?: string;  // e.g. "+ 1", "ticket.output", "monitor + 5", "'SUCCESS'"
	currentValue?: unknown;
}

export interface INodePipelineStep {
	id: string;
	type: 'run_ticket' | 'set_variable' | 'custom_code' | 'call_function' | 'component';
	ticketName?: string;
	ticketType?: string;
	ticketUri?: string;
	targetVariable?: string; // e.g. "task" or "monitor" or "news"
	expression?: string;     // e.g. "= ticket.output" or "@news = RUN_TICKETS(...)"
	functionName?: string;   // e.g. "RUN_TICKETS", "CREATE_TICKETS"
	label?: string;          // Human-readable title
	parameters?: string;     // Runtime parameters (e.g. "--fast", "param1")
	component?: ICustomField; // Component-driven node step (Inputs, Output, Create Tickets, Run Tickets, AI Prompt, Table, Browser, Python, etc.)
	disabled?: boolean;      // When true, this step is commented out / temporarily disabled and skipped during execution
	capsuleWidth?: number;   // Optional user-controlled width (px) for the capsule in the node canvas
}

interface IFlowchartNode {
	id: string;
	groupId?: string;
	type: 'rect' | 'round-rect' | 'diamond' | 'circle';
	x: number;
	y: number;
	width: number;
	height: number;
	label: string;
	imports?: { type: 'agent' | 'task' | 'job' | 'project' | 'case' | 'issue' | 'analysis' | 'workflow' | string; name: string; uri?: string; parameters?: string }[];
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
	/** Time of the last click on the node (double-click detection); not meaningful after reload. */
	_lastClickTime?: number;
}

interface IFlowchartLink {
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
	/** Time of the last click on the line / a line segment (double-click detection). */
	_lastLineClickTime?: number;
	/** Time of the last click on the label (double-click detection). */
	_lastLabelClickTime?: number;
}

interface IFlowchartData {
	nodes: IFlowchartNode[];
	links: IFlowchartLink[];
	routingMode?: 'orthogonal' | 'curved';
	pythonPath?: string;
}

/**
 * A node as read from `workflow_flowchart.json` before normalization. Older files use alternative keys
 * (`name`, `position`, `start` / `decision` types), so everything that gets validated is `unknown`.
 */
interface IRawFlowchartNode {
	id?: unknown;
	groupId?: unknown;
	type?: unknown;
	x?: unknown;
	y?: unknown;
	position?: { x?: unknown; y?: unknown };
	width?: unknown;
	height?: unknown;
	label?: unknown;
	name?: unknown;
	imports?: unknown;
	outputVariable?: INodeVariable;
	outputVariables?: unknown;
	pipeline?: unknown;
	color?: string;
	textColor?: string;
	textAlign?: IFlowchartNode['textAlign'];
	verticalAlign?: IFlowchartNode['verticalAlign'];
	isBold?: unknown;
	isItalic?: unknown;
	isUnderline?: unknown;
	isStrikethrough?: unknown;
}

/** A link as read from `workflow_flowchart.json` (or legacy `connections` / `edges`) before normalization. */
interface IRawFlowchartLink {
	id?: unknown;
	from?: unknown;
	fromNodeId?: unknown;
	source?: unknown;
	fromPort?: IFlowchartLink['fromPort'];
	to?: unknown;
	toNodeId?: unknown;
	target?: unknown;
	toPort?: IFlowchartLink['toPort'];
	style?: unknown;
	routing?: IFlowchartLink['routing'];
	color?: string;
	label?: string;
	condition?: string;
	labelPosition?: unknown;
	labelWidth?: unknown;
	labelHeight?: unknown;
	waypoints?: unknown;
}

interface IRawFlowchartFile {
	nodes?: unknown;
	links?: unknown;
	connections?: unknown;
	edges?: unknown;
	routingMode?: IFlowchartData['routingMode'];
	pythonPath?: string;
}

/**
 * Properties that are not part of `ICustomField` but may be present on a persisted component: runtime
 * results written back by the execution service, label history, and legacy property names.
 */
interface IWfComponent extends ICustomField {
	previousLabels?: unknown;
	lastExecutionInputs?: Record<string, unknown>;
	lastExecutionLog?: unknown;
	lastExecutionOutput?: unknown;
	lastExecutionStatus?: string;
	lastExecutionDurationMs?: unknown;
	lastExecutedAt?: unknown;
	lastExecutionExitCode?: unknown;
	lastSentPrompt?: unknown;
	pythonStructuredData?: unknown;
	structuredData?: unknown;
	debugOutput?: unknown;
	/** Legacy name of `tableDbTableName`. */
	tableName?: string;
	/** Legacy name of `defaultUrl`. */
	browserUrl?: string;
}

/** DOM of one rendered flowchart node, kept so that later updates do not have to query the canvas by selector. */
interface IWfNodeDom {
	readonly nodeId: string;
	readonly nodeEl: HTMLElement;
	contentWrapper?: HTMLElement;
	/** Top-right voice note speaker button (`.node-voice-speaker-btn`) with its icon and count badge. */
	speaker?: { readonly btn: HTMLElement; readonly icon: HTMLElement; readonly countBadge: HTMLElement };
	/** `.node-function-pill` / `.node-variable-pill` elements, in document order. */
	readonly pills: HTMLElement[];
	/** Pipeline capsules (the elements carrying `data-pipeline-step-idx`), in document order. */
	readonly capsules: HTMLElement[];
}

/** Rendered node DOM by node element, across all open workflow editors (drag & drop between split editors). */
const wfNodeDomByElement = new WeakMap<HTMLElement, IWfNodeDom>();

/** Parts of a rendered `.workflow-log-line` (a direct child of the log body), by line element. */
const wfLogLineParts = new WeakMap<Element, { readonly time: HTMLElement; readonly badge: HTMLElement; readonly node?: HTMLElement; readonly msg: HTMLElement }>();

/** The `.item-label` element of a toolbar button, by button. */
const wfToolbarItemLabels = new WeakMap<HTMLElement, HTMLElement>();
/** The Run / Full Speed buttons (`data-role` `workflow-run-btn` / `workflow-full-speed-run-btn`) rendered into a toolbar, by toolbar element. */
const wfToolbarRunButtons = new WeakMap<HTMLElement, { readonly runBtn: HTMLElement; readonly fullSpeedBtn: HTMLElement }>();

/** The open `.workflow-color-flyout-popover` of each document (at most one at a time). */
const wfColorFlyoutPopovers = new WeakMap<Document, HTMLElement>();
/** The open `.workflow-export-floating-menu` of each document (at most one at a time). */
const wfExportFloatingMenus = new WeakMap<Document, HTMLElement>();

/** Parts of the node pipeline panel last rendered into a panel element, by panel element. */
const wfPipelinePanelParts = new WeakMap<HTMLElement, { body?: HTMLElement; readonly ticketInputsByStepId: Map<string, HTMLInputElement> }>();

/**
 * The first element below `root` (document order) whose `data-field-id` attribute equals `fieldId`. Used to find a
 * component card in another editor (`EntityDetailEditor`), whose markup is produced from HTML strings.
 */
function findElementWithFieldId(root: HTMLElement, fieldId: string): HTMLElement | undefined {
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
	for (let current = walker.nextNode(); current; current = walker.nextNode()) {
		if (isHTMLElement(current) && current.getAttribute('data-field-id') === fieldId) {
			return current;
		}
	}
	return undefined;
}

/** The `.draft-drag-grip` inserted into a draft popup's header title, by title element. */
const wfDraftDragGrips = new WeakMap<HTMLElement, HTMLElement>();

/** Header parts of a Live Display inspector panel, by panel element. */
const wfDisplayInspectorParts = new WeakMap<HTMLElement, { header?: HTMLElement; titleText?: HTMLElement; minBtn?: HTMLElement }>();

/** When a capsule element was last dragged or resized (suppresses the click that ends the drag), by element. */
const wfCapsuleJustDraggedAt = new WeakMap<HTMLElement, number>();

/** A `call_function` operation of an execution path step, which may also carry its expression and result. */
interface IWorkflowNodeOperationWithResult extends IWorkflowNodeOperation {
	expression?: unknown;
	value?: unknown;
}

/** An entry of the `@` autocomplete dropdown of pipeline inputs; `raw` is the entity it was built from. */
interface IWfAutocompleteItem<TRaw = unknown> {
	label: string;
	detail?: string;
	icon?: ThemeIcon;
	insertText: string;
	isVariable?: boolean;
	raw?: TRaw;
}

/**
 * The interpreter path of a `pythonPath` setting. The setting comes from the flowchart JSON, where older files
 * may hold an interpreter object (`{ interpreterPath }`) instead of a path.
 */
function pythonPathSettingToPath(setting: string | { interpreterPath?: unknown } | undefined): string {
	return typeof setting === 'string' ? setting : String(setting?.interpreterPath || 'python3');
}

type IWfTicketRef = NonNullable<IFlowchartNode['imports']>[number] | INodePipelineStep;

/** Whether a ticket reference has the pipeline step property `key` (own or inherited, like `in`). */
function isStepTicketRef(ref: IWfTicketRef, key: 'ticketName' | 'ticketType'): ref is INodePipelineStep {
	return key in ref;
}

/** Name and type of a ticket referenced by a node, either as one of its imports or as a `run_ticket` pipeline step. */
function ticketRefNameAndType(ref: IWfTicketRef): { ticketName: string | undefined; ticketType: string | undefined } {
	return {
		ticketName: isStepTicketRef(ref, 'ticketName') ? ref.ticketName : ref.name,
		ticketType: isStepTicketRef(ref, 'ticketType') ? ref.ticketType : ref.type,
	};
}

/** A parameter declared by a ticket type's schema, with its default value (any JSON value). */
interface IWfSchemaParamSpec {
	name: string;
	defaultValue: unknown;
}

/**
 * The node snapshot stored with a Sub-Workflow definition. `ISubWorkflowDefinition` lives in `common/` and cannot
 * name the editor's node type; the snapshot is written from `IFlowchartNode`s by this editor.
 */
function subWorkflowSnapshotNodes(def: ISubWorkflowDefinition): (IFlowchartNode | null | undefined)[] {
	return (def.nodes || []) as (IFlowchartNode | null | undefined)[];
}

/** Legacy properties that older output specs may still carry. */
interface IWfOutputSpec extends IOutputSpec {
	name?: string;
	value?: string;
}

/** Views an output spec as `IWfOutputSpec` (type-only, no conversion). */
function wfOutputSpec(spec: IOutputSpec): IWfOutputSpec {
	return spec;
}

/** An editor input that may be a `DiagramEditorInput` (diagramsManager), checked structurally. */
interface IMaybeDiagramEditorInput extends EditorInput {
	readonly isPureDiagram?: boolean;
	readonly diagramUri?: URI;
}

/** Views a component as `IWfComponent` (type-only, no conversion). */
function wfComponent(comp: ICustomField): IWfComponent;
function wfComponent(comp: ICustomField | undefined): IWfComponent | undefined;
function wfComponent(comp: ICustomField | undefined): IWfComponent | undefined {
	return comp;
}

function hexToRgba(hex?: string, alpha = 0.12): string {
	if (!hex || !hex.startsWith('#')) { return `rgba(13, 148, 136, ${alpha})`; }
	const clean = hex.replace('#', '');
	if (clean.length === 3) {
		const r = parseInt(clean[0] + clean[0], 16);
		const g = parseInt(clean[1] + clean[1], 16);
		const b = parseInt(clean[2] + clean[2], 16);
		return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	}
	if (clean.length >= 6) {
		const r = parseInt(clean.slice(0, 2), 16);
		const g = parseInt(clean.slice(2, 4), 16);
		const b = parseInt(clean.slice(4, 6), 16);
		return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	}
	return `rgba(13, 148, 136, ${alpha})`;
}

function getColorForName(name: string | undefined): string {
	if (!name) { return '#38bdf8'; }
	const MODERN_PALETTE = [
		'#38bdf8', // Light Blue
		'#a78bfa', // Purple/Violet
		'#f472b6', // Pink
		'#34d399', // Emerald/Green
		'#fbbf24', // Amber/Yellow
		'#fb923c', // Orange
		'#2dd4bf', // Teal
		'#f87171', // Red
		'#818cf8', // Indigo
		'#c084fc', // Fuchsia
		'#22d3ee', // Cyan
		'#eab308'  // Yellow-gold
	];
	let hash = 0;
	const str = String(name).trim();
	for (let i = 0; i < str.length; i++) {
		hash = str.charCodeAt(i) + ((hash << 5) - hash);
	}
	const index = Math.abs(hash) % MODERN_PALETTE.length;
	return MODERN_PALETTE[index];
}

function getEntityBadgeStyle(type?: string): { color: string; bg: string; icon: ThemeIcon } {
	const t = (type || 'task').toLowerCase();
	const subWorkflowVisual = getSubWorkflowTicketVisual(t);
	if (subWorkflowVisual) {
		return { color: subWorkflowVisual.color, bg: hexToRgba(subWorkflowVisual.color, 0.18), icon: subWorkflowVisual.icon };
	}
	switch (t) {
		case 'job':
			return { color: '#fbbf24', bg: 'rgba(251, 191, 36, 0.18)', icon: Codicon.rocket };
		case 'task':
			return { color: '#a78bfa', bg: 'rgba(167, 139, 250, 0.18)', icon: Codicon.checklist };
		case 'project':
			return { color: '#60a5fa', bg: 'rgba(96, 165, 250, 0.18)', icon: Codicon.project };
		case 'workflow':
			return { color: '#0d9488', bg: 'rgba(13, 148, 136, 0.18)', icon: Codicon.githubAction };
		case 'agent':
			return { color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.18)', icon: Codicon.robot };
		case 'case':
			return { color: '#f472b6', bg: 'rgba(244, 114, 182, 0.18)', icon: Codicon.beaker };
		case 'issue':
			return { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.18)', icon: Codicon.bug };
		case 'analysis':
			return { color: '#34d399', bg: 'rgba(52, 211, 153, 0.18)', icon: Codicon.graph };
		case 'note':
			return { color: '#00b4d8', bg: 'rgba(0, 180, 216, 0.18)', icon: Codicon.package };
		case 'workspace':
			return { color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.18)', icon: Codicon.rootFolder };
		default: {
			const c = getColorForName(type || 'custom');
			const lower = (type || '').toLowerCase();
			let icon = Codicon.package;
			if (lower.includes('url') || lower.includes('web') || lower.includes('link') || lower.includes('site') || lower.includes('http')) {
				icon = Codicon.globe;
			} else if (lower.includes('data') || lower.includes('table') || lower.includes('db') || lower.includes('sql')) {
				icon = Codicon.database;
			} else if (lower.includes('jd') || lower.includes('position') || lower.includes('career') || lower.includes('hire')) {
				icon = Codicon.briefcase;
			}
			return { color: c, bg: hexToRgba(c, 0.18), icon };
		}
	}
}

/** Capsule look per component type (icon + colors), shared by node capsules on the canvas and the Workflow Outline menu. */
interface IWfCapsuleTheme { readonly icon: ThemeIcon; readonly color: string; readonly bg: string; readonly border: string; readonly textColor: string }
const WF_COMPONENT_CAPSULE_THEMES: Record<string, IWfCapsuleTheme> = {
	parameters: { icon: Codicon.symbolVariable, color: '#c084fc', bg: 'rgba(168, 85, 247, 0.16)', border: 'rgba(192, 132, 252, 0.5)', textColor: '#f3e8ff' },
	output: { icon: Codicon.output, color: '#34d399', bg: 'rgba(16, 185, 129, 0.16)', border: 'rgba(52, 211, 153, 0.5)', textColor: '#d1fae5' },
	create_tickets: { icon: Codicon.add, color: '#c084fc', bg: 'rgba(168, 85, 247, 0.16)', border: 'rgba(192, 132, 252, 0.5)', textColor: '#f3e8ff' },
	run_tickets: { icon: Codicon.playCircle, color: '#a855f7', bg: 'rgba(168, 85, 247, 0.16)', border: 'rgba(168, 85, 247, 0.5)', textColor: '#f3e8ff' },
	get_outputs: { icon: Codicon.signOut, color: '#818cf8', bg: 'rgba(99, 102, 241, 0.16)', border: 'rgba(129, 140, 248, 0.5)', textColor: '#e0e7ff' },
	get_ticket: { icon: Codicon.tag, color: '#60a5fa', bg: 'rgba(59, 130, 246, 0.16)', border: 'rgba(96, 165, 250, 0.5)', textColor: '#dbeafe' },
	get_tickets: { icon: Codicon.search, color: '#60a5fa', bg: 'rgba(59, 130, 246, 0.16)', border: 'rgba(96, 165, 250, 0.5)', textColor: '#dbeafe' },
	display: { icon: Codicon.eye, color: '#f472b6', bg: 'rgba(236, 72, 153, 0.16)', border: 'rgba(244, 114, 182, 0.5)', textColor: '#fce7f3' },
	prompt: { icon: Codicon.sparkle, color: '#2dd4bf', bg: 'rgba(20, 184, 166, 0.16)', border: 'rgba(45, 212, 191, 0.5)', textColor: '#ccfbf1' },
	table: { icon: Codicon.table, color: '#fb923c', bg: 'rgba(249, 115, 22, 0.16)', border: 'rgba(251, 146, 60, 0.5)', textColor: '#ffedd5' },
	browser: { icon: Codicon.globe, color: '#38bdf8', bg: 'rgba(14, 165, 233, 0.16)', border: 'rgba(56, 189, 248, 0.5)', textColor: '#e0f2fe' },
	tts: { icon: Codicon.unmute, color: '#f87171', bg: 'rgba(239, 68, 68, 0.16)', border: 'rgba(248, 113, 113, 0.5)', textColor: '#fee2e2' },
	media_player: { icon: Codicon.deviceCameraVideo, color: '#fbbf24', bg: 'rgba(245, 158, 11, 0.16)', border: 'rgba(251, 191, 36, 0.5)', textColor: '#fef3c7' },
	voice_note: { icon: Codicon.mic, color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.14)', border: 'rgba(148, 163, 184, 0.38)', textColor: '#e2e8f0' },
	sub_workflow: { icon: Codicon.layers, color: '#22d3ee', bg: 'rgba(6, 182, 212, 0.16)', border: 'rgba(34, 211, 238, 0.5)', textColor: '#cffafe' },
	ssh: { icon: Codicon.terminal, color: '#34d399', bg: 'rgba(16, 185, 129, 0.16)', border: 'rgba(52, 211, 153, 0.5)', textColor: '#d1fae5' },
	git: { icon: Codicon.gitMerge, color: '#a3e635', bg: 'rgba(132, 204, 22, 0.16)', border: 'rgba(163, 230, 53, 0.5)', textColor: '#ecfccb' },
	python: { icon: Codicon.python, color: '#38bdf8', bg: 'rgba(14, 165, 233, 0.14)', border: 'rgba(56, 189, 248, 0.45)', textColor: '#e0f2fe' }
};
/** Classic inline Python step capsule (no component): default purple function pill. */
const WF_PYTHON_STEP_CAPSULE_THEME: IWfCapsuleTheme = { icon: Codicon.python, color: '#c084fc', bg: 'rgba(192, 132, 252, 0.15)', border: 'rgba(192, 132, 252, 0.4)', textColor: '#f3e8ff' };
/** Flowchart node entry in the Workflow Outline. */
const WF_NODE_OUTLINE_THEME: IWfCapsuleTheme = { icon: Codicon.symbolClass, color: '#34d399', bg: 'rgba(16, 185, 129, 0.12)', border: 'rgba(52, 211, 153, 0.42)', textColor: '#ecfdf5' };

/** One entry of the Workflow Outline cascading menu (node, capsule, Sub-Workflow, ticket component, ...). */
interface IWfOutlineItem {
	/** Path-unique key (parent key + local id), so the same Sub-Workflow can appear under several callers. */
	readonly key: string;
	readonly label: string;
	readonly meta?: string;
	readonly icon: ThemeIcon;
	/** Colors of the capsule (same palette as the node capsules on the canvas). */
	readonly theme: IWfCapsuleTheme;
	/** Flowchart nodes: drawn as their own shape (like the shape toolbar) instead of a codicon. */
	readonly shape?: 'rect' | 'round-rect' | 'diamond' | 'circle';
	readonly disabled?: boolean;
	/** Next menu level; may be async (ticket templates are loaded on demand). */
	readonly children?: () => IWfOutlineItem[] | Promise<IWfOutlineItem[]>;
	/** Shows the item (lightbulb): workflows as a flowchart in a split below the canvas, everything else as a form on the right. */
	readonly open?: () => Promise<unknown> | unknown;
	/** Whether the item is currently shown in an editor; defaults to tracking the editor returned by `open`. */
	readonly isShown?: () => boolean;
	/** Hides (closes) the item; defaults to closing the tracked editor. */
	readonly hide?: () => Promise<void>;
	/** Items showing the same editor share this key (e.g. components of one ticket). */
	readonly showKey?: string;
	/** Where the item is on the flowchart (a node, or a capsule inside it). Clicking highlights it together with its ancestors. */
	readonly locateTarget?: IWfLocateTarget;
	/** Extra action when the item is clicked (e.g. a Sub-Workflow capsule also shows its flowchart below). */
	readonly onActivate?: () => void;
}

interface IWfLocateTarget {
	readonly nodeId: string;
	/** Index in `node.pipeline` when the target is a capsule. */
	readonly stepIndex?: number;
	/** Sub-Workflow containing the node (opened below the canvas when the node is not visible anywhere). */
	readonly ownerSubWorkflowId?: string;
}

/** Capsule types shown in a node's ticket-like view as read-only step cards (they have no ticket component card). */
const WF_NODE_TICKET_STEP_CARD_TYPES = new Set(['sub_workflow', 'display', 'create_tickets', 'run_tickets', 'get_outputs', 'get_ticket', 'get_tickets']);

type WfOutlineTicketRef = { readonly kind: 'type'; readonly name: string } | { readonly kind: 'id'; readonly id: string };

export class WorkflowEditor extends EditorPane {
	static readonly ID = 'workbench.editor.workflowEditor';
	private static readonly _openWorkflowEditors: Set<WorkflowEditor> = new Set();
	/** The shared `#workflow-existing-vars-list` datalist of each document (referenced by id from variable name inputs). */
	private static readonly _existingVarsDatalists = new WeakMap<Document, HTMLDataListElement>();
	/** Item last located from a Workflow Outline, per workflow: stays highlighted on every canvas until the next one is picked. */
	private static readonly _outlineLocated = new Map<string, { targets: IWfLocateTarget[]; owner: WorkflowEditor }>();
	/** Items of each outline column as last rendered (to find the ancestors of a clicked item). */
	private _outlineRenderedColumns: IWfOutlineItem[][] = [];
	/** Key of the outline item clicked last (highlighted with its ancestors until another item is clicked). */
	private _outlineSelectedKey: string | undefined;

	private _container: HTMLElement | undefined;
	/** Window that hosts this editor's DOM (the main window before the editor is created). */
	private get _targetWindow(): CodeWindow {
		return getWindow(this._container);
	}
	private readonly _contentDisposables = this._register(new DisposableStore());

	private _workflowUri: URI | undefined;
	private _flowchartOwnerRegistration: { dispose(): void } | undefined;
	private _flowchartJsonUri: URI | undefined;
	private _data: IFlowchartData = { nodes: [], links: [] };
	/**
	 * Set when this editor shows a Sub-Workflow ticket's own canvas (SubWorkflowCanvasEditorInput): `_workflowUri` is the
	 * ticket folder, the canvas is read from / saved to `.agents/sub_workflow.json` through the execution service.
	 */
	private _subWorkflowTicket: { id: string; legacyId?: string; sourceWorkflowUri?: string } | undefined;
	private _peerRenderTimer: ReturnType<typeof setTimeout> | undefined;

	// UI State
	private readonly _selectedNodeIds: Set<string> = new Set();
	private readonly _selectedLinkIds: Set<string> = new Set();
	private _activeLinkStyle: 'arrow-single' | 'arrow-double' | 'arrow-none' | 'dashed' = 'arrow-single';
	private _activeRoutingMode: 'orthogonal' | 'curved' = 'orthogonal';
	private _activeBranchDirection: 'right' | 'bottom' | 'left' | 'top' = 'right';
	private _activeNodeColor: string = '#0d9488';
	private _activeLineColor: string = '#0d9488';
	private _activeTextColor: string = '#ffffff';
	private _activeTextAlign: 'left' | 'center' | 'right' = 'center';
	private _activeVerticalAlign: 'top' | 'center' | 'bottom' = 'center';
	private _activeIsBold: boolean = false;
	private _activeIsItalic: boolean = false;
	private _activeIsUnderline: boolean = false;
	private _activeIsStrikethrough: boolean = false;

	// Selection Box State
	private _isSelectingBox = false;
	private _selectBoxStartX = 0;
	private _selectBoxStartY = 0;
	private _selectBoxBaseNodeIds: Set<string> = new Set();
	private _selectBoxBaseLinkIds: Set<string> = new Set();

	// Dragging State
	private _isDragging = false;
	private _dragNodeId: string | null = null;
	private _dragStartX = 0;
	private _dragStartY = 0;

	// Link Label Dragging & Resizing State
	private _isDraggingLinkLabel: string | null = null;
	private _dragLabelHasMoved = false;
	private _dragLabelStartX = 0;
	private _dragLabelStartY = 0;
	private _isResizingLinkLabel: string | null = null;
	private _resizeLinkLabelStartWidth = 0;
	private _resizeLinkLabelStartHeight = 0;
	private _resizeLinkLabelStartX = 0;
	private _resizeLinkLabelStartY = 0;

	// Link Orthogonal Segment Dragging State
	private _isDraggingLinkSegment: string | null = null;
	private _dragLinkSegmentIndex = -1;
	private _dragLinkSegmentIsVertical = true;
	private _dragLinkSegmentInitialIndex = -1;
	private _dragLinkSegmentPrepared = false;
	private _dragLinkSegmentWaypoints: { x: number; y: number }[] = [];
	private _dragLinkSegmentStartX = 0;
	private _dragLinkSegmentStartY = 0;
	private _dragLinkSegmentCanvasX = 0;
	private _dragLinkSegmentCanvasY = 0;
	private _dragLinkSegmentHasMoved = false;

	// Connecting State
	private _isConnecting = false;
	private _tempLinkStartX: number | null = null;
	private _tempLinkStartY: number | null = null;
	private _tempLinkFromNodeId: string | null = null;
	private _tempLinkFromPort: 'top' | 'right' | 'bottom' | 'left' | null = null;

	// Reconnecting State
	private _isReconnectingStart: string | null = null;
	private _isReconnectingEnd: string | null = null;
	private _tempLinkFixedX = 0;
	private _tempLinkFixedY = 0;

	// Resizing State
	private _isResizing = false;
	private _resizeNodeId: string | null = null;
	private _resizeStartWidth = 0;
	private _resizeStartHeight = 0;
	private _resizeStartX = 0;
	private _resizeStartY = 0;

	private _draggedNodesStartPos: Map<string, { x: number; y: number }> = new Map();
	private static _sharedCopiedNodes: IFlowchartNode[] = [];
	private static _sharedCopiedLinks: IFlowchartLink[] = [];
	private get _copiedNodes(): IFlowchartNode[] {
		return WorkflowEditor._sharedCopiedNodes;
	}
	private set _copiedNodes(nodes: IFlowchartNode[]) {
		WorkflowEditor._sharedCopiedNodes = nodes;
	}
	private get _copiedLinks(): IFlowchartLink[] {
		return WorkflowEditor._sharedCopiedLinks;
	}
	private set _copiedLinks(links: IFlowchartLink[]) {
		WorkflowEditor._sharedCopiedLinks = links;
	}
	private _collapseSelectionTargetNodeId: string | null = null;
	private _isPureDiagram: boolean = false;

	// Undo / Redo History Stack
	private _undoStack: string[] = [];
	private _redoStack: string[] = [];
	private _isUndoingOrRedoing: boolean = false;
	private _lastSavedStateJson: string = '';

	// Elements References
	private _canvas: HTMLElement | undefined;
	private _selectionBoxEl: HTMLElement | undefined;
	private _svgOverlay: SVGElement | undefined;
	/** The dashed preview path drawn while a new link is being dragged (`#workflow-temp-line`). */
	private _tempLinkLine: SVGPathElement | undefined;
	/** Paths in `_svgOverlay` with class `workflow-connection-line` / `workflow-connection-hit-area` (incl. the temp line). */
	private readonly _connectionLineEls = new Set<SVGElement>();
	/** Link labels (`.workflow-link-label`) drawn into `_linkDeletesContainer` by the last `_drawLinks()`, by link id. */
	private _linkLabelEls = new Map<string, HTMLElement>();
	/** The inline link label editor (`.workflow-link-label-editor-wrapper`) last opened in `_linkDeletesContainer`. */
	private _linkLabelEditorWrapper: HTMLElement | undefined;
	private _nodesContainer: HTMLElement | undefined;
	/** Nodes rendered into `_nodesContainer` by the last `_renderNodes()`, in document order. */
	private _nodeDoms: IWfNodeDom[] = [];
	private _linkDeletesContainer: HTMLElement | undefined;
	private _zoomLevel: number = 1.0;
	private _zoomSizerEl?: HTMLElement;
	private _floatingZoomBadgeEl?: HTMLElement;
	private _floatingLiveDisplayBtn?: HTMLElement;
	/** Width share of the side panel opened from the Workflow Outline (forms, tickets, node views). */
	private static readonly OUTLINE_SIDE_PANEL_RATIO = 0.36;
	private static readonly DEFAULT_CANVAS_WIDTH = 8000;
	private static readonly DEFAULT_CANVAS_HEIGHT = 6000;
	private _currentCanvasWidth: number = WorkflowEditor.DEFAULT_CANVAS_WIDTH;
	private _currentCanvasHeight: number = WorkflowEditor.DEFAULT_CANVAS_HEIGHT;
	private _isToolbarCompact: boolean = false;
	private _inspectorEl?: HTMLElement;
	private _isInspectorCompact: boolean = false;
	private _isInspectorCollapsed: boolean = false;
	private _inspectorTogglePill?: HTMLElement;
	private _toolbarEl?: HTMLElement;
	private _isLogDrawerOpen: boolean = false;
	private _activeDrawerTab: 'logs' | 'vars' | 'history' = 'logs';
	private _logDrawerEl?: HTMLElement;
	/** Elements of the drawer rendered into `_logDrawerEl` (tabs in order: logs, vars, history). */
	private _logDrawerParts?: { readonly tabs: HTMLElement[]; readonly clearBtn: HTMLElement; readonly copyLogsBtn: HTMLElement; readonly findReplaceToggleBtn: HTMLElement };
	private _logBodyEl?: HTMLElement;
	private _varsBodyEl?: HTMLElement;
	private _historyBodyEl?: HTMLElement;
	private _historyCountBadgeEl?: HTMLElement;
	private _selectedHistoryRunId?: string;
	private _varsCountBadgeEl?: HTMLElement;
	private _logCountBadgeEl?: HTMLElement;
	private _logStatusBadgeEl?: HTMLElement;
	private _autoScrollLogs: boolean = true;
	private _isVarsFindReplaceOpen: boolean = false;
	private _varsSearchQuery: string = '';
	private _varsFilterEvaluatedOnly: boolean = false;
	private _varsColWidths?: Record<string, number>;
	private _varsLastFindQuery: string = '';
	private _varsLastReplaceQuery: string = '';
	private _varsFindInputEl?: HTMLInputElement;
	private _varsFindCurrentIndex: number = 0;
	private _drawerHeight: number = 280;
	private _isDrawerResizing: boolean = false;
	private _drawerResizeStartY: number = 0;
	private _drawerResizeStartHeight: number = 280;
	private _canvasViewport?: HTMLElement;
	private _pipelinePanelEl?: HTMLElement;
	private _activePipelineNodeId?: string;
	private _pipelineDockSide: 'left' | 'right' = 'right';
	private _activePipelineDropdown: HTMLElement | null = null;
	private _ticketHoverPopoverEl: HTMLElement | null = null;
	private _ticketHoverTimeout: ReturnType<typeof setTimeout> | null = null;
	private _pythonStepHoverPopoverEl: HTMLElement | null = null;
	private _pythonStepHoverShowTimeout: ReturnType<typeof setTimeout> | null = null;
	private _pythonStepHoverHideTimeout: ReturnType<typeof setTimeout> | null = null;
	private _isPythonStepPopoverPinned: boolean = false;
	private _pythonStepPopoverOutsideClickHandler: ((e: MouseEvent) => void) | null = null;
	private _activePythonPopoverNode: IFlowchartNode | null = null;
	private _activePythonPopoverStep: INodePipelineStep | null = null;
	private _viewMode: 'flowchart' | 'fields' = 'flowchart';
	private _fieldsViewContainerEl?: HTMLElement;
	private _embeddedDetailEditor?: EntityDetailEditor;
	private _floatingFieldsToggleBtn?: HTMLElement;
	private _floatingZoomBarEl?: HTMLElement;
	private _floatingPythonEnvBtn?: HTMLElement;
	private _isFloatingToolbarExpanded: boolean = false;
	private _detectedPythonPath: string = 'python3';
	private _cachedCustomModules: ICustomModule[] = [];
	private _lastStepPillClick: { nodeId: string; stepId: string; time: number } | undefined;
	private _selectedCapsule: { nodeId: string; stepId: string } | null = null;
	private _selectedCapsules: { nodeId: string; stepIds: Set<string>; anchorIndex: number } | null = null;
	private _contextMenuDisposables: IDisposable[] = [];
	private static _copiedCapsule: {
		step: INodePipelineStep;
		sourceNodeLabel?: string;
		sourceVars?: Array<{ name: string; initialValue: string; expression?: string }>;
	} | null = null;
	private static _copiedCapsules: Array<{
		step: INodePipelineStep;
		sourceNodeLabel?: string;
		sourceVars?: Array<{ name: string; initialValue: string; expression?: string }>;
	}> = [];
	private static _lastCopyKind: 'node' | 'capsule' = 'node';

	// Node Voice Note Sequential Playback State
	private _activeVoicePlayNodeId: string | null = null;
	private _activeVoiceAudioEl: HTMLAudioElement | null = null;
	private _activeVoiceBlobUrl: string | null = null;
	private _activeVoiceClipIndex = 0;
	private _activeVoiceClipTotal = 0;

	// Sub-Workflow Encapsulation & Top-Left Dropdown State
	private _subWorkflowWidgetEl?: HTMLElement;
	/** The Workflow Outline panel last rendered into `_subWorkflowWidgetEl`. */
	private _outlinePanelEl?: HTMLElement;
	private _isSubWorkflowDropdownOpen = false;
	private _showEncapsulateForm = false;
	/** True while an encapsulation is creating its Sub-Workflow ticket. */
	private _isEncapsulating = false;
	/** Sub-Workflow ticket whose delete button was clicked once (a second click deletes it). */
	private _pendingSubWorkflowDeleteId: string | undefined;
	// Workflow Outline (layers button): keys of the expanded item per menu level, library section state, lit lightbulb
	private _outlinePath: string[] = [];
	private _outlineLibraryOpen = false;
	private readonly _outlineShownInputs = new Map<string, EditorInput>();
	private _outlineFlowGroupIds: number[] = [];
	private _outlineScroll: { left: number; tops: number[] } = { left: 0, tops: [] };
	private _outlineLastRenderedPath = '';
	/** UI-07: lists of the rendered outline that the wheel can pull past their native range, and their forced offsets by list key. */
	private readonly _outlineOverscrollDisposables = this._register(new DisposableStore());
	private _outlineOverscrollLists: OutlineListOverscroll[] = [];
	private _outlineOverscrollExtras = new Map<string, number>();
	/** Lightbulbs currently rendered in the outline / library, refreshed in place when editors open or close (no full re-render). */
	private _outlineBulbRefreshers: (() => void)[] = [];
	private _outlineRerenderScheduled = false;
	private readonly _outlineAsyncChildren = new Map<string, IWfOutlineItem[] | 'loading' | 'error'>();

	// Live Mouse Cursor Position in Canvas Coordinates (used as Top-Left Anchor for Paste & Sub-Workflow Expand)
	private _lastCanvasMouseX: number | null = null;
	private _lastCanvasMouseY: number | null = null;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly _storageService: IStorageService,
		@IFileService private readonly _fileService: IFileService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IViewsService private readonly _viewsService: IViewsService,
		@IEntityPersistenceService private readonly _entityPersistenceService: IEntityPersistenceService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupService: IEditorGroupsService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@IWorkflowExecutionService private readonly _workflowExecutionService: IWorkflowExecutionService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITicketWorkflowRuntimeService private readonly _ticketRuntimeService: ITicketWorkflowRuntimeService,
		@ICustomModulesService private readonly _customModulesService: ICustomModulesService,
		@IClipboardService private readonly _clipboardService: IClipboardService
	) {
		super(WorkflowEditor.ID, group, telemetryService, themeService, _storageService);
		this._register({ dispose: () => this._stopNodeVoicePlayback() });
		this._isToolbarCompact = this._storageService.getBoolean('workflowEditor.toolbarCompact', StorageScope.PROFILE, false);
		this._isInspectorCompact = this._storageService.getBoolean('workflowEditor.inspectorCompact', StorageScope.PROFILE, false);
		this._isInspectorCollapsed = this._storageService.getBoolean('workflowEditor.inspectorCollapsed', StorageScope.PROFILE, false);
		this._activeLinkStyle = (this._storageService.get('workflowEditor.linkStyle', StorageScope.PROFILE, 'arrow-single') as IFlowchartLink['style']) || 'arrow-single';
		this._activeRoutingMode = (this._storageService.get('workflowEditor.routingMode', StorageScope.PROFILE, 'orthogonal') as 'orthogonal' | 'curved') || 'orthogonal';
		this._activeBranchDirection = (this._storageService.get('workflowEditor.branchDirection', StorageScope.PROFILE, 'right') as 'right' | 'bottom' | 'left' | 'top') || 'right';
		this._activeNodeColor = this._storageService.get('workflowEditor.nodeColor', StorageScope.PROFILE, '#0d9488');
		this._activeLineColor = this._storageService.get('workflowEditor.lineColor', StorageScope.PROFILE, '#0d9488');
		this._activeTextColor = this._storageService.get('workflowEditor.textColor', StorageScope.PROFILE, '#ffffff');
		this._activeTextAlign = (this._storageService.get('workflowEditor.textAlign', StorageScope.PROFILE, 'center') as 'left' | 'center' | 'right') || 'center';
		this._activeVerticalAlign = (this._storageService.get('workflowEditor.verticalAlign', StorageScope.PROFILE, 'center') as 'top' | 'center' | 'bottom') || 'center';
		this._activeIsBold = this._storageService.getBoolean('workflowEditor.isBold', StorageScope.PROFILE, false);
		this._activeIsItalic = this._storageService.getBoolean('workflowEditor.isItalic', StorageScope.PROFILE, false);
		this._activeIsUnderline = this._storageService.getBoolean('workflowEditor.isUnderline', StorageScope.PROFILE, false);
		this._activeIsStrikethrough = this._storageService.getBoolean('workflowEditor.isStrikethrough', StorageScope.PROFILE, false);
		this._drawerHeight = this._storageService.getNumber('workflowEditor.drawerHeight', StorageScope.PROFILE, 280);
		this._pipelineDockSide = (this._storageService.get('workflowEditor.pipelineDockSide', StorageScope.PROFILE, 'right') as 'left' | 'right') || 'right';
		WorkflowEditor._openWorkflowEditors.add(this);
		this._register({ dispose: () => WorkflowEditor._openWorkflowEditors.delete(this) });
		this._register(this._customModulesService.onDidChangeModules(async () => {
			try {
				const modules = await this._customModulesService.getCustomModules(this._workflowUri);
				this._cachedCustomModules = modules;
				let changed = false;
				for (const mod of modules) {
					for (const f of mod.fields || []) {
						const newLbl = (f.label || '').trim();
						const previousLabels = wfComponent(f).previousLabels;
						const prevs: string[] = Array.isArray(previousLabels) ? previousLabels : [];
						if (!newLbl || prevs.length === 0) { continue; }
						for (const oldLbl of prevs) {
							if (!oldLbl || oldLbl === newLbl) { continue; }
							const escOld = oldLbl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
							const sqRe = new RegExp(`(\\[')${escOld}('\\])`, 'g');
							const dqRe = new RegExp(`(\\[")${escOld}("\\])`, 'g');
							for (const n of this._data.nodes || []) {
								if (n.pythonScript && (sqRe.test(n.pythonScript) || dqRe.test(n.pythonScript))) {
									n.pythonScript = n.pythonScript.replace(sqRe, `$1${newLbl}$2`).replace(dqRe, `$1${newLbl}$2`);
									changed = true;
								}
								for (const st of n.pipeline || []) {
									if (st.expression && (sqRe.test(st.expression) || dqRe.test(st.expression))) {
										st.expression = st.expression.replace(sqRe, `$1${newLbl}$2`).replace(dqRe, `$1${newLbl}$2`);
										changed = true;
									}
									if (st.componentField?.pythonCode && (sqRe.test(st.componentField.pythonCode) || dqRe.test(st.componentField.pythonCode))) {
										st.componentField.pythonCode = st.componentField.pythonCode.replace(sqRe, `$1${newLbl}$2`).replace(dqRe, `$1${newLbl}$2`);
										changed = true;
									}
								}
							}
						}
					}
				}
				if (changed) {
					await this._saveFlowchartData();
					this._renderNodesAndLinks();
					this._renderInspector();
				}
			} catch { }
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this._container = h('div.workflow-editor-container').root;
		parent.appendChild(this._container);
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		this._viewMode = 'flowchart';
		const maybeDiagramInput: IMaybeDiagramEditorInput = input;
		this._isPureDiagram = !!maybeDiagramInput.isPureDiagram || !!maybeDiagramInput.diagramUri;
		if (this._isPureDiagram) {
			this._workflowUri = maybeDiagramInput.diagramUri || maybeDiagramInput.resource || URI.file('');
			this._flowchartJsonUri = this._workflowUri;
		} else if (input instanceof SubWorkflowCanvasEditorInput) {
			this._workflowUri = input.ticketFolderUri;
			this._flowchartJsonUri = getSubWorkflowDefinitionUri(input.ticketFolderUri);
		} else {
			this._workflowUri = (input as WorkflowEditorInput).workflowUri;
			this._flowchartJsonUri = URI.joinPath(this._workflowUri, '.agents', 'workflow_flowchart.json');
		}
		this._subWorkflowTicket = undefined;
		if (input instanceof SubWorkflowCanvasEditorInput) {
			// Its latest saved definition (also makes sure the execution service knows the ticket, for saving)
			const def = await this._workflowExecutionService.loadSubWorkflowTicket(input.ticketFolderUri);
			const folderName = input.ticketFolderUri.path.split('/').filter(Boolean).pop() || '';
			this._subWorkflowTicket = { id: def?.id || folderName, legacyId: def?.legacyId, sourceWorkflowUri: def?.sourceWorkflowUri };
			if (!def) {
				this._notificationService.warn(`The Sub-Workflow definition ${this._flowchartJsonUri.toString()} is missing or invalid; changes on this canvas cannot be saved.`);
			}
		}

		// This editor is now the exclusive writer of workflow_flowchart.json (prevents background stale write-backs)
		this._flowchartOwnerRegistration?.dispose();
		this._flowchartOwnerRegistration = this._workflowUri
			? this._workflowExecutionService.registerFlowchartOwner(this._workflowUri)
			: undefined;

		await this._loadFlowchartData();
		const hasSavedViewport = WorkflowEditor._viewportStateByUri.has(this._getViewportKey());
		this._renderEditor();
		if (this._subWorkflowTicket && !hasSavedViewport) {
			// First time this Sub-Workflow canvas is shown: frame its nodes
			setTimeout(() => this._fitView(), 80);
		}
	}

	/** Other open editors showing the same workflow (e.g. the main canvas and a focused Sub-Workflow canvas). */
	private _getPeerEditors(): WorkflowEditor[] {
		const uri = this._workflowUri?.toString();
		if (!uri || this._isPureDiagram) {
			return [];
		}
		return Array.from(WorkflowEditor._openWorkflowEditors).filter(ed => ed !== this && !ed._isPureDiagram && ed._workflowUri?.toString() === uri);
	}

	/**
	 * Editors of the same workflow share ONE in-memory flowchart object, so an edit made in either is never
	 * overwritten by the other's next save. Call after replacing or saving `this._data`.
	 */
	private _syncPeerEditors(): void {
		for (const peer of this._getPeerEditors()) {
			peer._data = this._data;
			peer._scheduleCanvasRefresh();
		}
	}

	/** Coalesced canvas redraw (node states / structure changed elsewhere). */
	private _scheduleCanvasRefresh(): void {
		if (this._peerRenderTimer) {
			return;
		}
		this._peerRenderTimer = setTimeout(() => {
			this._peerRenderTimer = undefined;
			if (!this._canvas || this._hasActiveInlineNodeEditor()) {
				return;
			}
			this._renderNodes();
			this._drawLinks();
		}, 150);
	}

	private _getViewportKey(): string {
		return this._workflowUri?.toString() || '';
	}

	private async _loadFlowchartData(): Promise<void> {
		if (this._workflowUri) {
			try {
				await this._workflowExecutionService.loadRunsForWorkflow(this._workflowUri);
			} catch { }
			try {
				this._cachedCustomModules = await this._customModulesService.getCustomModules(this._workflowUri);
			} catch { }
		}
		if (!this._flowchartJsonUri) { return; }

		// Another editor already holds this workflow in memory: share its data instead of reading a second, diverging copy
		const loadedPeer = this._getPeerEditors().find(peer => Array.isArray(peer._data?.nodes) && peer._data.nodes.length > 0);
		if (loadedPeer) {
			this._data = loadedPeer._data;
			this._activeRoutingMode = this._data.routingMode || 'orthogonal';
			this._undoStack = [];
			this._redoStack = [];
			this._lastSavedStateJson = JSON.stringify(this._data);
			this._rebindOpenNodeSchemaEditors();
			return;
		}

		try {
			const exists = await this._fileService.exists(this._flowchartJsonUri);
			if (exists) {
				const content = await this._fileService.readFile(this._flowchartJsonUri);
				let parsed: IRawFlowchartFile | null | undefined;
				try {
					parsed = JSON.parse(content.value.toString());
				} catch {
					parsed = {};
				}

				// Normalize nodes
				const rawNodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
				const nodes: IFlowchartNode[] = rawNodes.map((n: IRawFlowchartNode, idx: number) => ({
					id: String(n.id || `node-${idx}`),
					groupId: n.groupId ? String(n.groupId) : undefined,
					type: (n.type === 'start' || n.type === 'circle') ? 'circle' : (n.type === 'decision' || n.type === 'diamond') ? 'diamond' : (n.type === 'rect') ? 'rect' : 'round-rect',
					x: typeof n.x === 'number' ? n.x : typeof n.position?.x === 'number' ? n.position.x : 80 + (idx * 150),
					y: typeof n.y === 'number' ? n.y : typeof n.position?.y === 'number' ? n.position.y : 150,
					width: typeof n.width === 'number' ? n.width : (n.type === 'circle' || n.type === 'start') ? 64 : (n.type === 'diamond' || n.type === 'decision') ? 120 : 180,
					height: typeof n.height === 'number' ? n.height : (n.type === 'circle' || n.type === 'start') ? 64 : (n.type === 'diamond' || n.type === 'decision') ? 120 : 80,
					label: String(n.label || n.name || n.id || 'Node'),
					imports: Array.isArray(n.imports) ? n.imports : undefined,
					outputVariable: n.outputVariable ? { ...n.outputVariable } : undefined,
					outputVariables: Array.isArray(n.outputVariables)
						? n.outputVariables.map((ov: INodeVariable) => ({ ...ov }))
						: (n.outputVariable ? [{ ...n.outputVariable }] : undefined),
					pipeline: Array.isArray(n.pipeline)
						? n.pipeline.map((p: INodePipelineStep) => ({ ...p }))
						: undefined,
					color: n.color || undefined,
					textColor: n.textColor || undefined,
					textAlign: n.textAlign || undefined,
					verticalAlign: n.verticalAlign || undefined,
					isBold: !!n.isBold,
					isItalic: !!n.isItalic,
					isUnderline: !!n.isUnderline,
					isStrikethrough: !!n.isStrikethrough
				}));

				// Normalize links / connections / edges
				const rawLinks = Array.isArray(parsed?.links) ? parsed.links : Array.isArray(parsed?.connections) ? parsed.connections : Array.isArray(parsed?.edges) ? parsed.edges : [];
				const links: IFlowchartLink[] = rawLinks.map((l: IRawFlowchartLink, idx: number) => ({
					id: String(l.id || `link-${idx}`),
					from: String(l.from || l.fromNodeId || l.source || ''),
					fromPort: l.fromPort,
					to: String(l.to || l.toNodeId || l.target || ''),
					toPort: l.toPort,
					style: (l.style === 'arrow-double' || l.style === 'arrow-none' || l.style === 'dashed') ? l.style : 'arrow-single',
					routing: l.routing,
					color: l.color,
					label: l.label ?? l.condition,
					condition: l.condition ?? l.label,
					labelPosition: typeof l.labelPosition === 'number' ? l.labelPosition : undefined,
					labelWidth: typeof l.labelWidth === 'number' ? l.labelWidth : undefined,
					labelHeight: typeof l.labelHeight === 'number' ? l.labelHeight : undefined,
					waypoints: Array.isArray(l.waypoints)
						? l.waypoints.filter((p: { x?: unknown; y?: unknown } | null | undefined) => p && typeof p.x === 'number' && typeof p.y === 'number').map((p: { x: number; y: number }) => ({ x: p.x, y: p.y }))
						: undefined
				}));

				this._data = {
					nodes,
					links,
					routingMode: parsed?.routingMode || 'orthogonal',
					pythonPath: parsed?.pythonPath || undefined
				};

				if (this._data.routingMode) {
					this._activeRoutingMode = this._data.routingMode;
				}

				// Initialize active styles from the most recently styled node in the loaded diagram if any
				for (let i = nodes.length - 1; i >= 0; i--) {
					const lastNode = nodes[i];
					if (lastNode.color || lastNode.textColor) {
						if (lastNode.color) { this._activeNodeColor = lastNode.color; }
						if (lastNode.textColor) { this._activeTextColor = lastNode.textColor; }
						if (lastNode.textAlign) { this._activeTextAlign = lastNode.textAlign; }
						if (lastNode.verticalAlign) { this._activeVerticalAlign = lastNode.verticalAlign; }
						if (typeof lastNode.isBold === 'boolean') { this._activeIsBold = lastNode.isBold; }
						if (typeof lastNode.isItalic === 'boolean') { this._activeIsItalic = lastNode.isItalic; }
						if (typeof lastNode.isUnderline === 'boolean') { this._activeIsUnderline = lastNode.isUnderline; }
						if (typeof lastNode.isStrikethrough === 'boolean') { this._activeIsStrikethrough = lastNode.isStrikethrough; }
						break;
					}
				}

				// Sync back to snapshot if missing in snapshot (a Sub-Workflow ticket keeps its definition file only)
				if (this._workflowUri && !this._subWorkflowTicket) {
					const snapshot = this._entityPersistenceService.getSnapshot(this._workflowUri);
					if (snapshot && (!snapshot.customMetadata || !snapshot.customMetadata['flowchartJson'])) {
						snapshot.customMetadata = {
							...(snapshot.customMetadata || {}),
							flowchartJson: JSON.stringify(this._data, null, 2)
						};
						await this._entityPersistenceService.saveSnapshot(snapshot);
					}
				}
			} else if (this._subWorkflowTicket) {
				// A Sub-Workflow ticket without a definition file: an empty canvas, written on the first edit
				this._data = { nodes: [], links: [], routingMode: 'orthogonal' };
				this._activeRoutingMode = 'orthogonal';
			} else {
				// Check if snapshot has flowchartJson backup first
				let restored = false;
				if (this._workflowUri) {
					const snapshot = this._entityPersistenceService.getSnapshot(this._workflowUri);
					if (snapshot?.customMetadata?.['flowchartJson']) {
						try {
							const parsed = JSON.parse(snapshot.customMetadata['flowchartJson']);
							if (Array.isArray(parsed.nodes) && Array.isArray(parsed.links)) {
								this._data = parsed;
								restored = true;
							}
						} catch {
							// ignore
						}
					}
				}

				if (!restored) {
					// No existing flowchart, create a standard ProcessOn templates structure!
					this._data = {
						nodes: [
							{ id: 'start', type: 'circle', x: 100, y: 150, width: 60, height: 60, label: 'Start' },
							{ id: 'task1', type: 'round-rect', x: 230, y: 145, width: 100, height: 50, label: 'Initialize' },
							{ id: 'decision', type: 'diamond', x: 400, y: 130, width: 80, height: 80, label: 'Is Approved?' },
							{ id: 'opt1', type: 'rect', x: 550, y: 80, width: 90, height: 45, label: 'Option 1' },
							{ id: 'opt2', type: 'rect', x: 550, y: 210, width: 90, height: 45, label: 'Option 2' },
							{ id: 'end', type: 'circle', x: 720, y: 150, width: 60, height: 60, label: 'End' }
						],
						links: [
							{ id: 'link1', from: 'start', to: 'task1', style: 'arrow-single' },
							{ id: 'link2', from: 'task1', to: 'decision', style: 'arrow-single' },
							{ id: 'link3', from: 'decision', to: 'opt1', style: 'arrow-single', label: 'Yes' },
							{ id: 'link4', from: 'decision', to: 'opt2', style: 'arrow-single', label: 'No' },
							{ id: 'link5', from: 'opt1', to: 'end', style: 'arrow-single' },
							{ id: 'link6', from: 'opt2', to: 'end', style: 'arrow-single' }
						],
						routingMode: 'orthogonal'
					};
				}
				this._activeRoutingMode = this._data.routingMode || 'orthogonal';
				await this._saveFlowchartData(true);
			}

			// Migrate renamed component types (e.g. legacy 'result' -> 'output') before anything reads the graph
			normalizeLegacyFieldTypes(this._data);

			// Initialize history baseline
			this._undoStack = [];
			this._redoStack = [];
			this._lastSavedStateJson = JSON.stringify(this._data);
			this._rebindOpenNodeSchemaEditors();
			this._syncPeerEditors();
		} catch (err) {
			this._notificationService.error(`Failed to load flowchart: ${err}`);
			this._data = { nodes: [], links: [] };
		}
	}

	private _saveFlowchartTimer: ReturnType<typeof setTimeout> | null = null;
	private _saveFlowchartPendingSkipHistory: boolean = true;
	/** True while this (Sub-Workflow) canvas saves its own definition: the change event it fires needs no redraw. */
	private _isSavingSubWorkflowCanvas = false;
	private _nodeComponentRenderRaf: number | null = null;

	private async _saveFlowchartData(skipHistory: boolean = false, immediate: boolean = false): Promise<void> {
		if (!this._flowchartJsonUri) { return; }
		if (!skipHistory) {
			this._saveFlowchartPendingSkipHistory = false;
		}
		if (immediate) {
			if (this._saveFlowchartTimer) {
				clearTimeout(this._saveFlowchartTimer);
				this._saveFlowchartTimer = null;
			}
			await this._flushSaveFlowchartData();
			return;
		}
		if (this._saveFlowchartTimer) {
			clearTimeout(this._saveFlowchartTimer);
		}
		this._saveFlowchartTimer = setTimeout(() => {
			this._saveFlowchartTimer = null;
			void this._flushSaveFlowchartData();
		}, 250);
	}

	private async _flushSaveFlowchartData(): Promise<void> {
		if (!this._flowchartJsonUri) { return; }
		const skipHistory = this._saveFlowchartPendingSkipHistory;
		this._saveFlowchartPendingSkipHistory = true;

		try {
			// Single JSON.stringify pass (avoids duplicating multi-MB serialization on every edit)
			const jsonStr = JSON.stringify(this._data);

			if (!skipHistory && !this._isUndoingOrRedoing) {
				if (this._lastSavedStateJson && this._lastSavedStateJson !== jsonStr) {
					this._undoStack.push(this._lastSavedStateJson);
					const maxUndoEntries = jsonStr.length > 2_000_000 ? 15 : 60;
					while (this._undoStack.length > maxUndoEntries) {
						this._undoStack.shift();
					}
					this._redoStack = [];
				}
				this._lastSavedStateJson = jsonStr;
			} else if (skipHistory) {
				this._lastSavedStateJson = jsonStr;
			}

			if (this._subWorkflowTicket) {
				// A Sub-Workflow's own canvas: saved as its ticket definition (sub_workflow.json + ticket.md summary); every
				// caller loads this latest version at run time
				let saved: ISubWorkflowDefinition | undefined;
				this._isSavingSubWorkflowCanvas = true;
				try {
					saved = this._workflowExecutionService.saveSubWorkflowCanvas(this._subWorkflowTicket.id, this._data);
				} finally {
					this._isSavingSubWorkflowCanvas = false;
				}
				if (!saved) {
					this._notificationService.error(`Sub-Workflow ${this._subWorkflowTicket.id} was not found; the canvas was not saved.`);
					return;
				}
				this._syncPeerEditors();
				void this._reportSubWorkflowCallCycle(this._workflowUri!);
				return;
			}

			await this._fileService.writeFile(this._flowchartJsonUri, VSBuffer.fromString(jsonStr));
			// Keep other open canvases of this workflow on the same data and redraw them
			this._syncPeerEditors();

			if (this._workflowUri) {
				// 2. Persist lightweight structural copy into Entity Persistence Snapshot (strip multi-MB voice audioDataUrl already saved in workflow_flowchart.json)
				const snapshot = this._entityPersistenceService.getSnapshot(this._workflowUri);
				if (snapshot) {
					const lightFlowchartJson = jsonStr.length > 500_000
						? JSON.stringify(this._data, (key, value) => key === 'audioDataUrl' ? undefined : value)
						: jsonStr;
					snapshot.customMetadata = {
						...(snapshot.customMetadata || {}),
						flowchartJson: lightFlowchartJson
					};
					await this._entityPersistenceService.saveSnapshot(snapshot);
				}
				void this._reportSubWorkflowCallCycle(this._workflowUri);
			}
		} catch (err) {
			this._notificationService.error(`Failed to save flowchart data: ${err}`);
		}
	}

	/** Last call-cycle error shown for this workflow (CI-38), so auto-save does not repeat it on every edit. */
	private _lastReportedCycleError: string | undefined;

	/**
	 * Recursion protection (CI-38): the workflow is always saved (auto-save keeps every edit) but marked invalid when
	 * its calls form a cycle: the error names the chain and a run refuses to start until it is fixed.
	 */
	private async _reportSubWorkflowCallCycle(workflowUri: URI): Promise<void> {
		const nodes = this._data?.nodes || [];
		// Only workflows that call Sub-Workflows are walked on save (a run start also checks run-ticket templates)
		if (collectSubWorkflowRefsFromNodes(nodes).length === 0) {
			this._lastReportedCycleError = undefined;
			return;
		}
		const uriStr = workflowUri.toString();
		const root: SubWorkflowCallGraphRoot = this._subWorkflowTicket
			? { kind: 'sub_workflow', key: this._subWorkflowTicket.id }
			: { kind: 'workflow', key: uriStr, label: this.input?.getName() || uriStr, nodes };
		const cycleError = await this._workflowExecutionService.checkSubWorkflowCallCycle(root, uriStr);
		if (cycleError && cycleError !== this._lastReportedCycleError) {
			this._notificationService.error(`This workflow is invalid: ${cycleError}`);
		}
		this._lastReportedCycleError = cycleError;
	}

	override clearInput(): void {
		if (this._saveFlowchartTimer) {
			clearTimeout(this._saveFlowchartTimer);
			this._saveFlowchartTimer = null;
			void this._flushSaveFlowchartData();
		}
		if (this._nodeComponentRenderRaf !== null) {
			this._targetWindow.cancelAnimationFrame(this._nodeComponentRenderRaf);
			this._nodeComponentRenderRaf = null;
		}
		if (this._displayInspectorContainer) {
			this._displayInspectorContainer.remove();
			this._displayInspectorContainer = null;
			this._displayInspectorTitleText = null;
			this._displayInspectorCardsContainer = null;
		}
		this._contentDisposables.clear();
		if (this._container) {
			clearNode(this._container);
		}
		this._flowchartOwnerRegistration?.dispose();
		this._flowchartOwnerRegistration = undefined;
		super.clearInput();
	}

	override layout(dimension: { width: number; height: number }): void {
		// Native layout override. A resized editor (e.g. a moved split) changes the outline's visible area: re-clamp its lists.
		for (const list of this._outlineOverscrollLists) {
			list.clamp();
		}
	}

	private static readonly _viewportStateByUri = new Map<string, { scrollLeft: number; scrollTop: number; zoomLevel: number }>();

	private _renderEditor(): void {
		if (!this._container) { return; }

		// Focused Sub-Workflow canvases remember their own zoom/scroll, separate from the main canvas
		const wfUriKey = this._getViewportKey();
		let savedViewport = wfUriKey ? WorkflowEditor._viewportStateByUri.get(wfUriKey) : undefined;
		if (!savedViewport && wfUriKey) {
			try {
				const raw = this._storageService.get(`workflowEditor.viewport.${wfUriKey}`, StorageScope.PROFILE);
				if (raw) {
					const parsed = JSON.parse(raw);
					if (parsed && typeof parsed.scrollLeft === 'number' && typeof parsed.scrollTop === 'number') {
						savedViewport = {
							scrollLeft: parsed.scrollLeft,
							scrollTop: parsed.scrollTop,
							zoomLevel: typeof parsed.zoomLevel === 'number' ? parsed.zoomLevel : this._zoomLevel
						};
						WorkflowEditor._viewportStateByUri.set(wfUriKey, savedViewport);
					}
				}
			} catch { }
		}
		if (savedViewport && typeof savedViewport.zoomLevel === 'number' && savedViewport.zoomLevel >= 0.25 && savedViewport.zoomLevel <= 2.0) {
			this._zoomLevel = savedViewport.zoomLevel;
		}

		if (this._pipelinePanelEl) {
			this._pipelinePanelEl.remove();
			this._pipelinePanelEl = undefined;
		}

		this._embeddedDetailEditor = undefined;
		this._contentDisposables.clear();
		clearNode(this._container);

		// 1. Toolbar Panel
		const toolbar = append(this._container, $('.workflow-editor-toolbar'));
		this._toolbarEl = toolbar;
		if (this._isToolbarCompact) {
			toolbar.classList.add('compact');
		}
		this._renderToolbar(toolbar);

		let renderPending = false;
		// Live Sub-Workflow progress: its nodes live on this canvas (shown via lightbulb or a focused Sub-Workflow tab)
		// Live progress of a call of this Sub-Workflow (shown on its own canvas)
		this._contentDisposables.add(this._workflowExecutionService.onDidChangeSubWorkflowRun(run => {
			const own = this._subWorkflowTicket;
			if (own && run.subWorkflowId && (run.subWorkflowId === own.id || run.subWorkflowId === own.legacyId)) {
				this._scheduleCanvasRefresh();
			}
		}));
		this._contentDisposables.add(this._workflowExecutionService.onDidChangeRunState(run => {
			if (run.isSubWorkflowRun) {
				return;
			}
			if (this._workflowUri && (run.workflowUri === this._workflowUri.toString() || run.workflowName === this._inputNameProperty())) {
				if (run.status === 'running' && this._activeDisplayRunId !== run.runId) {
					this._activeDisplayRunId = run.runId;
					this._clearDisplayInspectorCards();
				}

				// Always update status badge and event count immediately regardless of active drawer tab
				if (this._logStatusBadgeEl) {
					this._logStatusBadgeEl.textContent = run.status.toUpperCase();
					this._logStatusBadgeEl.className = `log-status-badge status-${run.status}`;
				}
				if (this._logCountBadgeEl) {
					this._logCountBadgeEl.textContent = `${run.logs?.length || 0} events`;
				}
				this._updateHistoryCountBadge();

				const isTerminalState = run.status === 'completed' || run.status === 'failed' || run.status === 'stopped' || run.status === 'idle';
				const syncCanvasAndToolbar = () => {
					if (!this._hasActiveInlineNodeEditor()) {
						this._renderNodes();
						this._drawLinks();
					}
					if (this._toolbarEl) {
						this._renderToolbar(this._toolbarEl);
					}
					if (this._pipelinePanelEl && this._activePipelineNodeId) {
						const activePipelineNode = this._nodes.find(n => n.id === this._activePipelineNodeId);
						if (activePipelineNode) {
							this._renderPipelinePanel(this._pipelinePanelEl, activePipelineNode);
						}
					}
				};

				if (isTerminalState) {
					renderPending = false;
					syncCanvasAndToolbar();
				} else if (!renderPending) {
					renderPending = true;
					this._targetWindow.requestAnimationFrame(() => {
						renderPending = false;
						syncCanvasAndToolbar();
					});
				}

				if (run.status === 'failed' && !this._isLogDrawerOpen) {
					this._openDrawerTab('logs');
				} else if (this._isLogDrawerOpen) {
					if (this._activeDrawerTab === 'logs' || isTerminalState) {
						this._refreshLogs(run);
					}
					if (this._activeDrawerTab === 'vars') {
						this._refreshVariablesDrawer();
					} else if (this._activeDrawerTab === 'history') {
						this._refreshHistoryDrawer();
					}
				}
			}
		}));

		this._contentDisposables.add(this._workflowExecutionService.onDidEmitLog(({ runId, log }) => {
			const activeRun = this._workflowUri ? this._workflowExecutionService.getActiveRun(this._workflowUri) : undefined;
			if (activeRun && activeRun.runId === runId) {
				if (this._logCountBadgeEl) {
					this._logCountBadgeEl.textContent = `${activeRun.logs?.length || 0} events`;
				}
				if (this._isLogDrawerOpen) {
					this._appendLogEntry(log, this._activeDrawerTab === 'logs');
				}
			}
		}));

		this._contentDisposables.add(this._workflowExecutionService.onDidDisplayVariable(card => {
			this._addDisplayInspectorCard(card);
		}));

		this._contentDisposables.add(this._workflowExecutionService.onDidUpdateNodeComponents(({ workflowUri, nodeId, node }) => {
			if (!this._workflowUri || workflowUri !== this._workflowUri.toString()) {
				return;
			}
			const localNode = this._data?.nodes?.find(n => n.id === nodeId);
			if (localNode && Array.isArray(localNode.pipeline) && Array.isArray(node?.pipeline)) {
				for (const srcStep of node.pipeline as (INodePipelineStep | undefined)[]) {
					const srcComp = srcStep?.component;
					if (!srcComp) { continue; }
					const dstStep = localNode.pipeline.find(s =>
						(s.id && s.id === srcStep?.id) ||
						(s.component?.id && s.component.id === srcComp.id)
					);
					if (dstStep) {
						if (srcComp.type === 'voice_note' || dstStep.component?.type === 'voice_note') {
							// Voice Note is commentary-only and never executed; preserve recorded audioDataUrl intact
							continue;
						}
						if (dstStep.component) {
							// Merge ONLY runtime execution telemetry — NEVER overwrite user-edited configuration (outputSpecs, parameters, wfDisplayValue, pythonCode, etc.)
							const runtimeOnlyKeys = [
								'lastExecutionStatus', 'lastExecutionDurationMs', 'lastExecutedAt',
								'lastExecutionOutput', 'lastExecutionLog', 'lastExecutionInputs',
								'pythonResult', 'pythonOutput', 'lastResolvedUrl', 'lastExecutedUrl',
								'httpResponseStatus', 'httpResponseStatusText', 'httpResponseHeaders',
								'httpResponseBody', 'httpResponseData', 'httpLastExecutionTime', 'httpLastDurationMs',
								'tableLastExecutionTime', 'tableLastDurationMs', 'tableLastSqlOutput', 'debugPromptOutput'
							];
							for (const rk of runtimeOnlyKeys) {
								const runtimeValue: unknown = Reflect.get(srcComp, rk);
								if (runtimeValue !== undefined) {
									Object.assign(dstStep.component, { [rk]: runtimeValue });
								}
							}
						} else {
							dstStep.component = { ...srcComp };
						}
						this._syncComponentStepMetadata(dstStep);
					}
				}
				this._ensureNodeFitsPipeline(localNode);
				this._syncToNode(localNode, true);
				this._saveFlowchartData(true);
				if (this._nodeComponentRenderRaf === null) {
					this._nodeComponentRenderRaf = this._targetWindow.requestAnimationFrame(() => {
						this._nodeComponentRenderRaf = null;
						if (!this._hasActiveInlineNodeEditor()) {
							this._renderNodes();
							this._drawLinks();
						}
						if (this._inspectorEl) {
							this._renderInspector(this._inspectorEl);
						}
					});
				}
				const schemaInput = this._nodeEditorInputsByNodeId.get(nodeId);
				if (schemaInput && !schemaInput.isDisposed() && schemaInput.draftModule) {
					const updatedNodeFields: ICustomField[] = localNode.pipeline
						.filter(st => !!st.component)
						.map(st => st.component!);
					schemaInput.draftModule.fields = [
						{ id: 'title', label: 'Title', type: 'text', required: true },
						...updatedNodeFields
					];
					schemaInput.notifyExternalDraftUpdated();
				}
			}
		}));

		// 2. Center Drawing Viewport (Fixed container for floating controls)
		const canvasViewport = append(this._container, $('.workflow-canvas-viewport'));
		this._canvasViewport = canvasViewport;

		// Top-Left Floating Sub-Workflows Dropdown Widget
		if (!this._isPureDiagram) {
			this._subWorkflowWidgetEl = append(canvasViewport, $('.wf-subworkflow-floating-widget'));
			this._renderSubWorkflowDropdown();
			const scheduleOutlineRerender = () => {
				if (!this._isSubWorkflowDropdownOpen || this._outlineRerenderScheduled) {
					return;
				}
				this._outlineRerenderScheduled = true;
				setTimeout(() => {
					this._outlineRerenderScheduled = false;
					if (this._isSubWorkflowDropdownOpen) {
						this._refreshOutlineBulbs(); // in place: re-rendering the whole panel makes it flicker
					}
				}, 50);
			};
			this._contentDisposables.add(this._editorService.onDidEditorsChange(scheduleOutlineRerender));
			this._contentDisposables.add(this._workflowExecutionService.onDidChangeSubWorkflows(() => {
				this._renderSubWorkflowDropdown();
				if (this._isSavingSubWorkflowCanvas || this._hasActiveInlineNodeEditor()) {
					return;
				}
				this._renderNodes();
				this._drawLinks();
			}));
		}

		// Restore Live Display inspector if cards exist
		this._restoreDisplayInspectorCards();

		// Canvas Scroll Wrapper inside Viewport
		const canvasWrapper = append(canvasViewport, $('.workflow-editor-canvas-wrapper'));

		let isRestoringViewport = true;
		const persistViewportState = () => {
			if (isRestoringViewport || !wfUriKey || canvasWrapper.clientWidth <= 0 || canvasWrapper.clientHeight <= 0) {
				return;
			}
			const state = {
				scrollLeft: Math.round(canvasWrapper.scrollLeft),
				scrollTop: Math.round(canvasWrapper.scrollTop),
				zoomLevel: this._zoomLevel
			};
			WorkflowEditor._viewportStateByUri.set(wfUriKey, state);
			this._storageService.store(`workflowEditor.viewport.${wfUriKey}`, JSON.stringify(state), StorageScope.PROFILE, StorageTarget.USER);
		};
		this._contentDisposables.add(addDisposableListener(canvasWrapper, 'scroll', () => persistViewportState()));
		this._contentDisposables.add(addDisposableListener(canvasViewport, 'mousemove', (e: MouseEvent) => {
			const pos = this._clientToCanvasCoords(e.clientX, e.clientY);
			if (pos) {
				this._lastCanvasMouseX = pos.x;
				this._lastCanvasMouseY = pos.y;
			}
		}));
		this._contentDisposables.add(addDisposableListener(canvasViewport, 'contextmenu', (e: MouseEvent) => {
			const pos = this._clientToCanvasCoords(e.clientX, e.clientY);
			if (pos) {
				this._lastCanvasMouseX = pos.x;
				this._lastCanvasMouseY = pos.y;
			}
		}));
		this._contentDisposables.add(addDisposableListener(this._container, 'wheel', () => setTimeout(persistViewportState, 20)));
		this._contentDisposables.add(addDisposableListener(this._container, 'click', () => setTimeout(persistViewportState, 20)));

		const applyRestoredScroll = () => {
			if (!canvasWrapper.isConnected) { return; }
			if (savedViewport) {
				canvasWrapper.scrollLeft = savedViewport.scrollLeft;
				canvasWrapper.scrollTop = savedViewport.scrollTop;
			} else if (this._data?.nodes && this._data.nodes.length > 0 && canvasWrapper.clientWidth > 0) {
				const topNode = this._data.nodes.reduce((best, n) => (n.y < best.y ? n : best), this._data.nodes[0]);
				const targetLeft = Math.max(0, Math.round((topNode.x + (topNode.width || 120) / 2) * this._zoomLevel - canvasWrapper.clientWidth / 2));
				const targetTop = Math.max(0, Math.round(topNode.y * this._zoomLevel - 60));
				canvasWrapper.scrollLeft = targetLeft;
				canvasWrapper.scrollTop = targetTop;
			}
		};
		queueMicrotask(() => {
			applyRestoredScroll();
			this._targetWindow.requestAnimationFrame(() => {
				applyRestoredScroll();
				isRestoringViewport = false;
				persistViewportState();
			});
		});

		// Sizer container to enforce scroll boundaries when zoomed
		this._zoomSizerEl = append(canvasWrapper, $('.workflow-canvas-sizer'));
		this._zoomSizerEl.style.position = 'relative';

		this._canvas = append(this._zoomSizerEl, $('.workflow-editor-canvas'));
		this._canvas.style.transform = `scale(${this._zoomLevel})`;
		this._canvas.style.transformOrigin = '0 0';

		this._updateCanvasDimensions();

		// SVG Overlay
		this._svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		this._svgOverlay?.classList.add('workflow-svg-overlay');
		this._canvas.appendChild(this._svgOverlay!);

		// Define Arrow markers for all theme colors
		const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
		const arrowColors = [
			{ id: 'arrow', color: '#0d9488' },
			{ id: 'arrow-ffffff', color: '#ffffff' },
			{ id: 'arrow-0d9488', color: '#0d9488' },
			{ id: 'arrow-38bdf8', color: '#38bdf8' },
			{ id: 'arrow-7c3aed', color: '#7c3aed' },
			{ id: 'arrow-facc15', color: '#facc15' },
			{ id: 'arrow-f43f5e', color: '#f43f5e' },
			{ id: 'arrow-selected', color: '#22d3ee' }
		];
		for (const ac of arrowColors) {
			const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
			marker.setAttribute('id', ac.id);
			marker.setAttribute('viewBox', '0 0 10 10');
			marker.setAttribute('refX', '8');
			marker.setAttribute('refY', '5');
			marker.setAttribute('markerWidth', '6');
			marker.setAttribute('markerHeight', '6');
			marker.setAttribute('orient', 'auto-start-reverse');
			const markerPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			markerPath.setAttribute('d', 'M 0 1 L 10 5 L 0 9 z');
			markerPath.setAttribute('fill', ac.color);
			marker.appendChild(markerPath);
			defs.appendChild(marker);
		}
		this._svgOverlay?.appendChild(defs);

		// Connection line delete handles layer
		this._linkDeletesContainer = append(this._canvas, $('.link-deletes-container'));

		// Nodes Container
		this._nodesContainer = append(this._canvas, $('.nodes-container'));
		this._nodeDoms = [];

		// Selection Box Overlay element
		this._selectionBoxEl = append(this._canvas, $('.workflow-selection-box'));

		// Permanent Floating Zoom Toolbar at top-center of editor container (collapsible capsule, collapsed by default to avoid overlapping panels)
		const floatingZoom = append(this._container, $(`.workflow-floating-zoom-control${this._isFloatingToolbarExpanded ? '' : '.collapsed'}`));
		this._floatingZoomBarEl = floatingZoom;

		const updateFloatingZoomCollapsedState = () => {
			const isCollapsed = !this._isFloatingToolbarExpanded;
			floatingZoom.classList.toggle('collapsed', isCollapsed);
			if (this._floatingZoomBadgeEl) {
				this._floatingZoomBadgeEl.title = isCollapsed
					? `Zoom: ${Math.round(this._zoomLevel * 100)}% (Click to expand toolbar)`
					: 'Reset Zoom to 100%';
			}
		};

		floatingZoom.onclick = (e) => {
			if (!this._isFloatingToolbarExpanded) {
				e.stopPropagation();
				this._isFloatingToolbarExpanded = true;
				updateFloatingZoomCollapsedState();
			}
		};

		// allow-any-unicode-next-line
		// −/+ stay visible in the collapsed capsule too, so zooming does not require expanding the toolbar
		const fZoomOut = append(floatingZoom, $('.floating-zoom-btn.canvas-only-item'));
		fZoomOut.textContent = '\u2212';
		fZoomOut.title = 'Zoom Out (\u221210%)';
		fZoomOut.onclick = (e) => { e.stopPropagation(); this._setZoom(this._zoomLevel - 0.1, this._zoomFocusAnchor()); };

		this._floatingZoomBadgeEl = append(floatingZoom, $('.floating-zoom-badge.canvas-only-item'));
		this._floatingZoomBadgeEl.textContent = `${Math.round(this._zoomLevel * 100)}%`;
		this._floatingZoomBadgeEl.onclick = (e) => {
			e.stopPropagation();
			if (!this._isFloatingToolbarExpanded) {
				this._isFloatingToolbarExpanded = true;
				updateFloatingZoomCollapsedState();
				return;
			}
			this._setZoom(1.0, this._zoomFocusAnchor());
		};

		const fZoomIn = append(floatingZoom, $('.floating-zoom-btn.canvas-only-item'));
		fZoomIn.textContent = '+';
		fZoomIn.title = 'Zoom In (+10%)';
		fZoomIn.onclick = (e) => { e.stopPropagation(); this._setZoom(this._zoomLevel + 0.1, this._zoomFocusAnchor()); };

		const fExpandHint = append(floatingZoom, $('.floating-zoom-expand-hint'));
		append(fExpandHint, $('span' + ThemeIcon.asCSSSelector(Codicon.chevronRight)));
		fExpandHint.title = 'Click to expand toolbar';

		const fDivider = append(floatingZoom, $('.floating-zoom-divider.canvas-only-item.floating-zoom-expandable'));
		fDivider.style.width = '1px';
		fDivider.style.height = '12px';
		fDivider.style.background = 'rgba(255, 255, 255, 0.15)';
		fDivider.style.margin = '0 2px';

		const fFitBtn = append(floatingZoom, $('.floating-zoom-btn.fit-btn.canvas-only-item.floating-zoom-expandable'));
		append(fFitBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.screenFull)));
		fFitBtn.title = 'Fit Content to Screen';
		fFitBtn.onclick = (e) => { e.stopPropagation(); this._fitView(); };

		const fExportDivider = append(floatingZoom, $('.floating-zoom-divider.canvas-only-item.floating-zoom-expandable'));
		fExportDivider.style.width = '1px';
		fExportDivider.style.height = '12px';
		fExportDivider.style.background = 'rgba(255, 255, 255, 0.15)';
		fExportDivider.style.margin = '0 2px';

		const fExportBtn = append(floatingZoom, $('.floating-zoom-btn.export-btn.canvas-only-item.floating-zoom-expandable'));
		append(fExportBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.desktopDownload)));
		fExportBtn.title = 'Export / Download Flowchart (PNG, JPEG, SVG, PDF)';
		fExportBtn.onclick = (e) => { e.stopPropagation(); this._showExportMenu(fExportBtn); };

		const fLiveDivider = append(floatingZoom, $('.floating-zoom-divider.canvas-only-item.floating-zoom-expandable'));
		fLiveDivider.style.width = '1px';
		fLiveDivider.style.height = '12px';
		fLiveDivider.style.background = 'rgba(255, 255, 255, 0.15)';
		fLiveDivider.style.margin = '0 2px';

		this._floatingLiveDisplayBtn = append(floatingZoom, $('.floating-zoom-btn.live-display-btn.canvas-only-item.floating-zoom-expandable'));
		this._floatingLiveDisplayBtn.onclick = (e) => {
			e.stopPropagation();
			if (!this._displayInspectorContainer || !this._displayInspectorContainer.isConnected) {
				this._restoreDisplayInspectorCards();
				if (!this._displayInspectorContainer) {
					this._ensureDisplayInspectorPanel();
				}
			} else {
				this._toggleDisplayInspectorMinimized();
			}
		};
		this._updateLiveDisplayToolbarBtn();

		// Python Interpreter Selector in Top Floating Toolbar (Icon only)
		const fPyDivider = append(floatingZoom, $('.floating-zoom-divider.canvas-only-item.floating-zoom-expandable'));
		fPyDivider.style.width = '1px';
		fPyDivider.style.height = '12px';
		fPyDivider.style.background = 'rgba(255, 255, 255, 0.15)';
		fPyDivider.style.margin = '0 2px';

		this._floatingPythonEnvBtn = append(floatingZoom, $('.floating-zoom-btn.python-env-btn.canvas-only-item.floating-zoom-expandable'));
		this._floatingPythonEnvBtn.style.color = '#c084fc';
		this._floatingPythonEnvBtn.onclick = (e) => {
			e.stopPropagation();
			if (this._floatingPythonEnvBtn) {
				this._showPythonInterpreterMenu(this._floatingPythonEnvBtn);
			}
		};
		this._updatePythonEnvButtonLabel();

		if (!this._isPureDiagram) {
			const fFieldsDivider = append(floatingZoom, $('.floating-zoom-divider.floating-zoom-expandable'));
			fFieldsDivider.style.width = '1px';
			fFieldsDivider.style.height = '12px';
			fFieldsDivider.style.background = 'rgba(255, 255, 255, 0.15)';
			fFieldsDivider.style.margin = '0 2px';

			this._floatingFieldsToggleBtn = append(floatingZoom, $('.floating-zoom-btn.fields-toggle-btn.floating-zoom-expandable'));
			append(this._floatingFieldsToggleBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.listSelection)));
			this._floatingFieldsToggleBtn.title = 'Switch to Ticket Fields View (Template & Metadata)';
			this._floatingFieldsToggleBtn.onclick = (e) => {
				e.stopPropagation();
				this._setViewMode(this._viewMode === 'flowchart' ? 'fields' : 'flowchart');
			};
		}

		const fCollapseDivider = append(floatingZoom, $('.floating-zoom-divider.floating-zoom-expandable'));
		fCollapseDivider.style.width = '1px';
		fCollapseDivider.style.height = '12px';
		fCollapseDivider.style.background = 'rgba(255, 255, 255, 0.15)';
		fCollapseDivider.style.margin = '0 2px';

		const fCollapseBtn = append(floatingZoom, $('.floating-zoom-btn.collapse-toolbar-btn.floating-zoom-expandable'));
		append(fCollapseBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.chevronLeft)));
		fCollapseBtn.title = 'Collapse Toolbar';
		fCollapseBtn.onclick = (e) => {
			e.stopPropagation();
			this._isFloatingToolbarExpanded = false;
			updateFloatingZoomCollapsedState();
		};

		updateFloatingZoomCollapsedState();

		// Permanent Floating Trigger Pill at top-right of drawing viewport when inspector is collapsed
		this._inspectorTogglePill = append(canvasViewport, $('.workflow-inspector-toggle-pill'));
		if (!this._isInspectorCollapsed) {
			this._inspectorTogglePill.classList.add('hidden');
		}
		append(this._inspectorTogglePill, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolColor)));
		append(this._inspectorTogglePill, $('span')).textContent = 'Properties & Styles';
		this._inspectorTogglePill.title = 'Open Properties & Styling Panel';
		this._inspectorTogglePill.onclick = (e) => {
			e.stopPropagation();
			this._isInspectorCollapsed = false;
			this._storageService.store('workflowEditor.inspectorCollapsed', false, StorageScope.PROFILE, StorageTarget.USER);
			this._inspectorEl?.classList.remove('collapsed');
			this._inspectorTogglePill?.classList.add('hidden');
			if (this._inspectorEl) { this._renderInspector(this._inspectorEl); }
		};

		// Floating Bottom Execution Log Drawer inside drawing viewport
		this._renderLogDrawer(canvasViewport);

		// 3. Right Property Inspector Panel
		const inspector = append(this._container, $('.workflow-editor-inspector'));
		if (this._isInspectorCollapsed) {
			inspector.classList.add('collapsed');
		}
		if (this._isInspectorCompact) {
			inspector.classList.add('compact');
		}
		this._inspectorEl = inspector;
		this._renderInspector(inspector);

		// 4. Ticket Fields / Template View Container (Shared within Workflow Editor)
		this._fieldsViewContainerEl = append(this._container, $('.workflow-fields-view-container'));

		// Wheel zoom with Ctrl/Cmd key
		this._contentDisposables.add(addDisposableListener(canvasWrapper, 'wheel', (e: WheelEvent) => {
			if (this._viewMode === 'fields') { return; }
			if (e.ctrlKey || e.metaKey) {
				e.preventDefault();
				e.stopPropagation();
				const delta = e.deltaY < 0 ? 0.05 : -0.05;
				// Zoom around the pointer, so what is under the mouse stays under the mouse
				const rect = canvasWrapper.getBoundingClientRect();
				this._setZoom(this._zoomLevel + delta, { viewportX: e.clientX - rect.left, viewportY: e.clientY - rect.top });
			}
		}, { passive: false }));

		// Mouse dragging handlers on canvas wrapper for dragging coordinates
		this._contentDisposables.add(addDisposableListener(this._targetWindow, 'mousemove', (e: MouseEvent) => this._onMouseMove(e)));
		this._contentDisposables.add(addDisposableListener(this._targetWindow, 'mouseup', (e: MouseEvent) => this._onMouseUp(e)));

		// Ensure clicking anywhere on the flowchart canvas (nodes, SVG links, background) moves DOM focus into _container
		// even when child handlers call e.stopPropagation()
		this._container.tabIndex = -1;
		this._container.style.outline = 'none';
		this._contentDisposables.add(addDisposableListener(this._container, 'mousedown', (e: MouseEvent) => {
			if (this._viewMode === 'fields') {
				return;
			}
			const target = e.target as HTMLElement | null;
			const tag = target?.tagName?.toLowerCase();
			if (
				tag !== 'input' &&
				tag !== 'textarea' &&
				tag !== 'select' &&
				!target?.isContentEditable &&
				!target?.closest('[contenteditable="true"], .monaco-editor, .node-inline-editor, .workflow-fields-view-container, .entity-detail-editor, .custom-module-schema-editor, .workflow-log-drawer, .workflow-display-inspector-panel')
			) {
				try {
					this._container?.focus({ preventScroll: true });
				} catch { }
			}
		}, true));

		// Global Keydown Delete and Copy/Paste handler
		this._contentDisposables.add(addDisposableListener(this._targetWindow, 'keydown', (e: KeyboardEvent) => {
			if (!this.isVisible() || !this._container || this._container.offsetParent === null || !this._targetWindow.document.hasFocus()) {
				return;
			}
			if (this._viewMode === 'fields' || this._targetWindow.document.activeElement?.closest('.workflow-fields-view-container')) {
				return;
			}
			const activeEl = this._targetWindow.document.activeElement as HTMLElement | null;
			const activeTag = activeEl?.tagName.toLowerCase();
			if (
				activeTag === 'input' ||
				activeTag === 'textarea' ||
				activeTag === 'select' ||
				activeTag === 'webview' ||
				activeTag === 'iframe' ||
				activeEl?.isContentEditable ||
				activeEl?.closest('[contenteditable="true"], [contenteditable="plaintext-only"]') ||
				activeEl?.closest('.monaco-editor') ||
				activeEl?.classList.contains('node-inline-editor') ||
				activeEl?.closest('.custom-module-schema-editor, .entity-detail-editor, .monaco-inputbox, .quick-input-widget, .browser-editor, .browser-url-container, .browser-url-display, .xterm')
			) {
				return;
			}
			if (activeEl && activeEl !== this._targetWindow.document.body && activeEl !== this._targetWindow.document.documentElement && !this._container.contains(activeEl)) {
				return;
			}
			const containerHasFocus = Boolean(activeEl && this._container.contains(activeEl));
			const isFlowchartFocusedOrActive = containerHasFocus
				? true
				: (this._editorService.activeEditorPane === this);
			if (!isFlowchartFocusedOrActive) {
				return;
			}

			// Do not intercept native copy / select-all if user is selecting text or focused inside log drawer / inspectors
			const selection = this._targetWindow.getSelection();
			const hasTextSelection = !!(selection && !selection.isCollapsed && selection.toString().length > 0);
			const isInsideTextPanel = !!(
				this._targetWindow.document.activeElement?.closest('.workflow-log-drawer') ||
				this._targetWindow.document.activeElement?.closest('.workflow-display-inspector-panel') ||
				this._targetWindow.document.activeElement?.closest('.workflow-editor-inspector')
			);

			if (hasTextSelection || isInsideTextPanel) {
				if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'a')) {
					return;
				}
			}

			if (e.key === 'Delete' || e.key === 'Backspace') {
				if (this._selectedNodeIds.size > 0 || this._selectedLinkIds.size > 0) {
					e.preventDefault();
					this._deleteSelectedItems();
				}
			} else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
				e.preventDefault();
				e.stopPropagation();
				if (e.shiftKey) {
					this._redo();
				} else {
					this._undo();
				}
			} else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
				e.preventDefault();
				e.stopPropagation();
				this._redo();
			} else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
				e.preventDefault();
				if (this._selectedCapsules && this._selectedCapsules.stepIds.size > 0 && this._data?.nodes) {
					const capNode = this._data.nodes.find(n => n.id === this._selectedCapsules!.nodeId);
					const capSteps = (capNode?.pipeline || []).filter(s => this._selectedCapsules!.stepIds.has(s.id));
					if (capNode && capSteps.length > 0) {
						this._copyCapsuleSteps(capNode, capSteps);
						return;
					}
				}
				if (this._selectedCapsule && this._data?.nodes) {
					const capNode = this._data.nodes.find(n => n.id === this._selectedCapsule!.nodeId);
					const capStep = capNode?.pipeline?.find(s => s.id === this._selectedCapsule!.stepId);
					if (capNode && capStep) {
						this._copyCapsuleStep(capNode, capStep);
						return;
					}
				}
				this._copySelectedNodes();
			} else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
				e.preventDefault();
				if (this._selectedNodeIds.size === 1 && this._data?.nodes) {
					const selId = Array.from(this._selectedNodeIds)[0];
					const selNode = this._data.nodes.find(n => n.id === selId);
					if (selNode) {
						if (WorkflowEditor._lastCopyKind === 'capsule' && (WorkflowEditor._copiedCapsules.length > 0 || WorkflowEditor._copiedCapsule)) {
							void this._pasteCapsuleIntoNode(selNode);
							return;
						}
						if (this._copiedNodes.length === 0) {
							// Cross-window fallback: check system clipboard for a copied capsule
							void this._clipboardService.readText().then(rawClip => {
								const trimmed = (rawClip || '').trim();
								if (trimmed.startsWith('{') && trimmed.includes('__anyagent_capsule_v1__')) {
									void this._pasteCapsuleIntoNode(selNode);
								} else {
									this._pasteNodes();
								}
							}).catch(() => this._pasteNodes());
							return;
						}
					}
				}
				this._pasteNodes();
			} else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
				e.preventDefault();
				e.stopPropagation();
				if (e.shiftKey) {
					this._ungroupSelectedNodes();
				} else {
					this._groupSelectedNodes();
				}
			} else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'f' || e.key.toLowerCase() === 'r')) {
				e.preventDefault();
				e.stopPropagation();
				this._openVarsFindReplaceBar();
			} else if (this._selectedNodeIds.size === 1) {
				const selId = Array.from(this._selectedNodeIds)[0];
				const selNode = this._data?.nodes?.find(n => n.id === selId);
				if (selNode) {
					if (e.key === 'Tab') {
						e.preventDefault();
						e.stopPropagation();
						this._createChildNode(selNode);
					} else if (e.key === 'Enter') {
						e.preventDefault();
						e.stopPropagation();
						this._createSiblingNode(selNode);
					}
				}
			}
		}));

		// HTML5 Drag and Drop listeners
		if (this._canvas) {
			this._canvas.oncontextmenu = (e) => {
				e.preventDefault();
				e.stopPropagation();
				this._showContextMenu(e.clientX, e.clientY, 'canvas', '');
			};

			this._canvas.onmousedown = (e: MouseEvent) => {
				const target = e.target as HTMLElement;
				if (target === this._canvas || target.classList.contains('workflow-editor-canvas') || target.tagName.toLowerCase() === 'svg') {
					e.preventDefault();
					e.stopPropagation();

					// Clear selection unless Shift/Ctrl is held
					if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
						this._selectedCapsule = null;
						this._selectedCapsules = null;
						this._updateCapsuleSelectionDom();
						this._selectedNodeIds.clear();
						this._selectedLinkIds.clear();
						this._renderNodes();
						this._drawLinks();
						if (this._inspectorEl) {
							this._renderInspector(this._inspectorEl);
						}
					}

					this._selectBoxBaseNodeIds = new Set(this._selectedNodeIds);
					this._selectBoxBaseLinkIds = new Set(this._selectedLinkIds);
					this._isSelectingBox = true;
					const rect = this._canvas!.getBoundingClientRect();
					this._selectBoxStartX = (e.clientX - rect.left) / this._zoomLevel;
					this._selectBoxStartY = (e.clientY - rect.top) / this._zoomLevel;

					if (this._selectionBoxEl) {
						this._selectionBoxEl.style.left = `${this._selectBoxStartX}px`;
						this._selectionBoxEl.style.top = `${this._selectBoxStartY}px`;
						this._selectionBoxEl.style.width = '0px';
						this._selectionBoxEl.style.height = '0px';
						this._selectionBoxEl.style.display = 'block';
					}
				}
			};

			this._canvas.ondragover = (e: DragEvent) => {
				e.preventDefault();
				if (e.dataTransfer) {
					e.dataTransfer.dropEffect = 'copy';
				}
			};

			this._canvas.ondrop = (e: DragEvent) => {
				e.preventDefault();
				const dataStr = e.dataTransfer?.getData('text/plain');
				if (dataStr) {
					if (dataStr.startsWith('any-agent-import:')) {
						const parts = dataStr.split(':');
						const type = parts[1];
						const name = parts[2];
						const rect = this._canvas!.getBoundingClientRect();
						const rawX = (e.clientX - rect.left) / this._zoomLevel;
						const rawY = (e.clientY - rect.top) / this._zoomLevel;
						const grid = 5;
						const x = Math.round(rawX / grid) * grid;
						const y = Math.round(rawY / grid) * grid;

						const id = `node_${Date.now()}`;
						const newNode: IFlowchartNode = {
							id,
							type: 'round-rect',
							x: Math.max(10, x - 50),
							y: Math.max(10, y - 25),
							width: 100,
							height: 50,
							label: name,
							imports: [{ type, name }],
							color: this._activeNodeColor,
							textColor: this._activeTextColor,
							textAlign: this._activeTextAlign,
							verticalAlign: this._activeVerticalAlign,
							isBold: this._activeIsBold,
							isItalic: this._activeIsItalic,
							isUnderline: this._activeIsUnderline,
							isStrikethrough: this._activeIsStrikethrough
						};
						this._data.nodes.push(newNode);
						this._selectedNodeIds.clear();
						this._selectedNodeIds.add(id);
						this._saveFlowchartData();
						this._renderNodes();
						this._drawLinks();
						this._notificationService.info(`Created new node for ${type} '${name}'`);
						return;
					}

					try {
						const parsed = JSON.parse(dataStr);
						const rect = this._canvas!.getBoundingClientRect();
						const rawX = (e.clientX - rect.left) / this._zoomLevel;
						const rawY = (e.clientY - rect.top) / this._zoomLevel;
						const grid = 5;
						const x = Math.round(rawX / grid) * grid;
						const y = Math.round(rawY / grid) * grid;

						if (parsed && (parsed.kind === 'variable' || parsed.kind === 'variable_widget' || parsed.kind === 'function' || parsed.kind === 'function_widget')) {
							const id = `node_${Date.now()}`;
							const initialStep: INodePipelineStep = {
								id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
								type: 'call_function',
								functionName: 'PYTHON',
								expression: ''
							};
							const newNode: IFlowchartNode = {
								id,
								type: 'round-rect',
								x: Math.max(10, x - 140),
								y: Math.max(10, y - 48),
								width: 280,
								height: 96,
								label: 'Python Step',
								outputVariables: [],
								pipeline: [initialStep],
								color: this._activeNodeColor,
								textColor: this._activeTextColor,
								textAlign: this._activeTextAlign,
								verticalAlign: this._activeVerticalAlign,
								isBold: this._activeIsBold,
								isItalic: this._activeIsItalic,
								isUnderline: this._activeIsUnderline,
								isStrikethrough: this._activeIsStrikethrough
							};
							this._data.nodes.push(newNode);
							this._selectedNodeIds.clear();
							this._selectedNodeIds.add(id);
							this._saveFlowchartData();
							this._renderNodes();
							this._drawLinks();
							if (this._inspectorEl) { this._renderInspector(this._inspectorEl); }
							this._refreshVariablesDrawer(id);
							setTimeout(() => {
								const pillEl = this._getNodeDom(id)?.pills[0];
								this._openNodeFunctionInlineEditor(newNode, initialStep, pillEl);
							}, 40);
							return;
						}

						this._addNewNodeAt(parsed.type, parsed.label, x, y);
					} catch { }
				}
			};
		}

		// Render Nodes and draw connections
		this._renderNodes();
		this._drawLinks();
		this._applyViewMode();
	}

	private _setViewMode(mode: 'flowchart' | 'fields'): void {
		if (this._isPureDiagram) {
			mode = 'flowchart';
		}
		if (this._viewMode === mode) {
			return;
		}
		this._viewMode = mode;
		this._applyViewMode();
	}

	private _applyViewMode(): void {
		const isFields = this._viewMode === 'fields' && !this._isPureDiagram;

		if (this._toolbarEl) {
			this._toolbarEl.style.display = isFields ? 'none' : '';
		}
		if (this._canvasViewport) {
			this._canvasViewport.style.display = isFields ? 'none' : '';
		}
		if (this._inspectorEl) {
			this._inspectorEl.style.display = isFields ? 'none' : '';
		}
		if (this._pipelinePanelEl && isFields) {
			this._pipelinePanelEl.style.display = 'none';
		}
		if (this._fieldsViewContainerEl) {
			this._fieldsViewContainerEl.style.display = isFields ? 'block' : 'none';
		}

		if (this._floatingZoomBarEl) {
			this._floatingZoomBarEl.classList.toggle('fields-mode-active', isFields);
		}

		if (this._floatingFieldsToggleBtn) {
			this._floatingFieldsToggleBtn.classList.toggle('active', isFields);
			this._floatingFieldsToggleBtn.title = isFields
				? 'Switch to Workflow Flowchart View (Drawing Canvas)'
				: 'Switch to Ticket Fields View (Template & Metadata)';
		}

		if (isFields && this._workflowUri && this._fieldsViewContainerEl) {
			const wfName = (this.input as WorkflowEditorInput)?.workflowName || this._workflowUri.path.split('/').filter(Boolean).pop() || 'Workflow';
			if (!this._embeddedDetailEditor) {
				this._embeddedDetailEditor = this._contentDisposables.add(
					this._instantiationService.createInstance(EntityDetailEditor, this.group)
				);
				this._embeddedDetailEditor.mountEmbeddedInWorkflow(
					this._fieldsViewContainerEl,
					this._workflowUri,
					wfName,
					() => this._setViewMode('flowchart')
				);
			} else {
				this._embeddedDetailEditor.updateEmbeddedEntity(this._workflowUri, wfName, true);
			}
		} else if (!isFields) {
			if (this._embeddedDetailEditor) {
				this._embeddedDetailEditor.setEmbeddedVisible(false);
			}
			this._renderNodes();
			this._drawLinks();
		}
	}

	private _openLogDrawer(): void {
		this._isLogDrawerOpen = true;
		if (this._logDrawerEl) {
			this._logDrawerEl.style.display = 'flex';
			this._logDrawerEl.style.height = `${this._drawerHeight}px`;
			if (this._activeDrawerTab === 'logs') {
				const activeRun = this._workflowUri ? this._workflowExecutionService.getActiveRun(this._workflowUri) : undefined;
				if (activeRun) {
					this._refreshLogs(activeRun);
				}
			} else if (this._activeDrawerTab === 'vars') {
				this._refreshVariablesDrawer();
			} else if (this._activeDrawerTab === 'history') {
				this._refreshHistoryDrawer();
			}
			this._updateHistoryCountBadge();
		}
		if (this._toolbarEl) {
			this._renderToolbar(this._toolbarEl);
		}
	}

	private _openDrawerTab(tab: 'logs' | 'vars' | 'history', targetNodeId?: string): void {
		this._activeDrawerTab = tab;
		this._isLogDrawerOpen = true;
		if (this._logDrawerEl) {
			this._logDrawerEl.style.display = 'flex';
			this._logDrawerEl.style.height = `${this._drawerHeight}px`;
			this._switchDrawerTab(tab, targetNodeId);
		}
		if (this._toolbarEl) {
			this._renderToolbar(this._toolbarEl);
		}
	}

	private _switchDrawerTab(tab: 'logs' | 'vars' | 'history', targetNodeId?: string): void {
		this._activeDrawerTab = tab;
		if (!this._logDrawerEl) { return; }

		const logDrawerParts = this._logDrawerParts;
		const tabs = logDrawerParts?.tabs || [];
		if (tabs.length >= 3) {
			tabs[0].classList.toggle('active', tab === 'logs');
			tabs[1].classList.toggle('active', tab === 'vars');
			tabs[2].classList.toggle('active', tab === 'history');
		} else if (tabs.length >= 2) {
			tabs[0].classList.toggle('active', tab === 'logs');
			tabs[1].classList.toggle('active', tab === 'vars');
		}

		const activeRun = this._workflowUri ? this._workflowExecutionService.getActiveRun(this._workflowUri) : undefined;

		if (this._logBodyEl) {
			this._logBodyEl.style.display = tab === 'logs' ? 'block' : 'none';
			if (tab === 'logs' && activeRun) {
				this._refreshLogs(activeRun);
			}
		}
		if (this._varsBodyEl) {
			this._varsBodyEl.style.display = tab === 'vars' ? 'flex' : 'none';
			if (tab === 'vars') {
				this._refreshVariablesDrawer(targetNodeId);
			}
		}
		if (this._historyBodyEl) {
			this._historyBodyEl.style.display = tab === 'history' ? 'flex' : 'none';
			if (tab === 'history') {
				this._refreshHistoryDrawer();
			}
		}

		this._updateHistoryCountBadge();

		if (activeRun) {
			if (this._logStatusBadgeEl) {
				this._logStatusBadgeEl.textContent = activeRun.status.toUpperCase();
				this._logStatusBadgeEl.className = `log-status-badge status-${activeRun.status}`;
			}
			if (this._logCountBadgeEl) {
				this._logCountBadgeEl.textContent = `${activeRun.logs?.length || 0} events`;
			}
		}

		// Only show clear log and copy logs buttons on Execution Logs tab
		const clearBtn = logDrawerParts?.clearBtn;
		if (clearBtn) {
			clearBtn.style.display = tab === 'logs' ? 'inline-flex' : 'none';
		}
		const copyLogsBtn = logDrawerParts?.copyLogsBtn;
		if (copyLogsBtn) {
			copyLogsBtn.style.display = tab === 'logs' ? 'inline-flex' : 'none';
		}

		// Only show Find & Replace toggle button on Context Variables tab
		const findReplaceToggleBtn = logDrawerParts?.findReplaceToggleBtn;
		if (findReplaceToggleBtn) {
			findReplaceToggleBtn.style.display = tab === 'vars' ? 'inline-flex' : 'none';
		}

		if (this._toolbarEl) {
			this._renderToolbar(this._toolbarEl);
		}
	}

	private _closeLogDrawer(): void {
		this._isLogDrawerOpen = false;
		if (this._logDrawerEl) {
			this._logDrawerEl.style.display = 'none';
		}
		if (this._toolbarEl) {
			this._renderToolbar(this._toolbarEl);
		}
	}

	private _refreshLogs(run: IWorkflowExecutionRun): void {
		if (this._logStatusBadgeEl) {
			this._logStatusBadgeEl.textContent = run.status.toUpperCase();
			this._logStatusBadgeEl.className = `log-status-badge status-${run.status}`;
		}
		if (this._logCountBadgeEl) {
			this._logCountBadgeEl.textContent = `${run.logs.length} events`;
		}
		if (!this._logBodyEl) { return; }
		clearNode(this._logBodyEl);
		const recentLogs = run.logs.length > 500 ? run.logs.slice(-500) : run.logs;
		for (const log of recentLogs) {
			this._appendLogEntry(log, false);
		}
		if (this._autoScrollLogs) {
			this._logBodyEl.scrollTop = this._logBodyEl.scrollHeight;
		}
	}

	private _getNodeVariables(node: IFlowchartNode): INodeVariable[] {
		const result: INodeVariable[] = [];
		const seen = new Set<string>();

		const sanitizeInitVal = (val?: string): string | undefined => {
			if (!val) { return undefined; }
			const trimmed = val.trim();
			if (/^(\+\=|\-\=|\*\=|\/\=|\+\+|\-\-)/.test(trimmed)) {
				return undefined;
			}
			return trimmed;
		};

		// 1. If pipeline exists, variables defined/set in pipeline take precedence in execution order!
		if (node.pipeline && node.pipeline.length > 0) {
			for (const step of node.pipeline) {
				if (step.type === 'set_variable' && step.targetVariable) {
					const cleanName = step.targetVariable.replace(/^@/, '').trim();
					if (!seen.has(cleanName)) {
						seen.add(cleanName);
						const existingVar = (node.outputVariables || []).find(v => v.name.replace(/^@/, '').trim() === cleanName);
						const expr = step.expression || existingVar?.expression || '';
						const isMutation = expr && /^(\+\=|\-\=|\*\=|\/\=|\+\+|\-\-|\+\s*\d+|\-\s*\d+)/.test(expr.trim());

						let initVal = sanitizeInitVal(existingVar?.initialValue);
						if (!initVal) {
							initVal = isMutation ? '0' : (sanitizeInitVal(step.expression) || 'None');
						}

						result.push({
							name: cleanName,
							initialValue: initVal,
							expression: expr
						});
					}
				}
			}
		}

		// 2. Any additional outputVariables not in pipeline
		if (Array.isArray(node.outputVariables) && node.outputVariables.length > 0) {
			for (const v of node.outputVariables) {
				const cleanName = v.name.replace(/^@/, '').trim();
				if (!seen.has(cleanName)) {
					seen.add(cleanName);
					const initVal = sanitizeInitVal(v.initialValue) || 'None';
					result.push({
						...v,
						name: cleanName,
						initialValue: initVal
					});
				}
			}
		} else if (node.outputVariable && node.outputVariable.name) {
			const cleanName = node.outputVariable.name.replace(/^@/, '').trim();
			if (!seen.has(cleanName)) {
				seen.add(cleanName);
				const initVal = sanitizeInitVal(node.outputVariable.initialValue) || 'None';
				result.push({
					...node.outputVariable,
					name: cleanName,
					initialValue: initVal
				});
			}
		}

		if (!node.outputVariables) {
			node.outputVariables = [...result];
		}
		return result;
	}

	private _unbindVariableFromNode(node: IFlowchartNode, targetVar: string | INodeVariable): void {
		const vars = this._getNodeVariables(node);
		const varName = typeof targetVar === 'string' ? targetVar : targetVar.name;
		const cleanName = varName.replace(/^@/, '').trim();

		if (node.pipeline) {
			const pipeIdx = node.pipeline.findIndex(s => s.type === 'set_variable' && s.targetVariable?.replace(/^@/, '').trim() === cleanName);
			if (pipeIdx !== -1) {
				node.pipeline.splice(pipeIdx, 1);
			}
		}

		let idx = -1;
		if (typeof targetVar === 'string') {
			idx = vars.findIndex(v => v.name === targetVar || v.name === cleanName);
		} else {
			idx = vars.indexOf(targetVar);
			if (idx === -1) {
				idx = vars.findIndex(v => v.name === targetVar.name || v.name === cleanName);
			}
		}
		if (idx !== -1) {
			vars.splice(idx, 1);
		}
		if (vars.length === 0) {
			delete node.outputVariable;
			delete node.outputVariables;
		} else {
			node.outputVariables = vars;
			node.outputVariable = vars[0];
		}
		this._saveFlowchartData();
		this._renderNodes();
		this._drawLinks();
		if (this._inspectorEl) { this._renderInspector(this._inspectorEl); }
		this._refreshVariablesDrawer();
	}

	private _updateExistingVarsDatalist(): void {
		const targetDocument = this._targetWindow.document;
		let dl = WorkflowEditor._existingVarsDatalists.get(targetDocument);
		if (!dl || !dl.isConnected) {
			dl = document.createElement('datalist');
			dl.id = 'workflow-existing-vars-list';
			targetDocument.body.appendChild(dl);
			WorkflowEditor._existingVarsDatalists.set(targetDocument, dl);
		}
		clearNode(dl);
		const seen = new Set<string>();
		for (const n of this._data?.nodes || []) {
			for (const v of this._getNodeVariables(n)) {
				if (!seen.has(v.name)) {
					seen.add(v.name);
					const opt = document.createElement('option');
					opt.value = v.name;
					opt.textContent = `(=${v.initialValue || 'None'}) [${n.label}]`;
					dl.appendChild(opt);
				}
			}
		}
	}

	private _refreshVariablesDrawer(targetNodeId?: string): void {
		const allVars: { node: IFlowchartNode; variable: INodeVariable }[] = [];
		const seenNodeVar = new Set<string>();
		for (const node of this._data?.nodes || []) {
			for (const v of this._getNodeVariables(node)) {
				const key = `${node.id}::${v.name}`;
				if (!seenNodeVar.has(key)) {
					seenNodeVar.add(key);
					allVars.push({ node, variable: v });
				}
			}
		}

		if (this._varsCountBadgeEl) {
			this._varsCountBadgeEl.textContent = `${allVars.length} vars`;
		}

		if (!this._varsBodyEl) { return; }
		clearNode(this._varsBodyEl);

		if (this._isVarsFindReplaceOpen) {
			this._renderVarsFindReplaceBar(this._varsBodyEl);
		}

		if (allVars.length === 0) {
			const empty = append(this._varsBodyEl, $('.workflow-vars-empty'));
			const emptyIcon = append(empty, $('.var-icon-badge'));
			emptyIcon.textContent = '[V]';
			emptyIcon.style.fontSize = '24px';
			emptyIcon.style.padding = '4px 8px';
			append(empty, $('div')).textContent = localize('noVarsMsg', 'No context variables defined in this workflow.');
			append(empty, $('div')).textContent = localize('noVarsSubMsg', 'Drag the Variable card from the toolbox onto any node or canvas space.');
			return;
		}

		// Load persisted column widths (or balanced defaults where Variable Name has ample room & Runtime Value is compact)
		const defaultColWidths: Record<string, number> = {
			name: 240,
			node: 210,
			init: 180,
			refs: 92,
			value: 260,
			action: 62
		};
		const colLimits: Record<string, { min: number; max: number }> = {
			name: { min: 130, max: 600 },
			node: { min: 110, max: 480 },
			init: { min: 100, max: 440 },
			refs: { min: 70, max: 160 },
			value: { min: 120, max: 800 },
			action: { min: 56, max: 80 }
		};
		if (!this._varsColWidths) {
			try {
				const raw = this._targetWindow.localStorage.getItem('anyagent.varsTableColWidths');
				if (raw) {
					const parsed = JSON.parse(raw);
					if (parsed && typeof parsed === 'object') {
						this._varsColWidths = { ...defaultColWidths };
						for (const k of Object.keys(defaultColWidths)) {
							const n = Number(parsed[k]);
							if (Number.isFinite(n) && n >= colLimits[k].min && n <= colLimits[k].max) {
								this._varsColWidths[k] = Math.round(n);
							}
						}
					}
				}
			} catch { }
			if (!this._varsColWidths) {
				this._varsColWidths = { ...defaultColWidths };
			}
		}
		const saveColWidths = () => {
			try {
				if (this._varsColWidths) {
					this._targetWindow.localStorage.setItem('anyagent.varsTableColWidths', JSON.stringify(this._varsColWidths));
				}
			} catch { }
		};

		const activeRun = this._workflowUri ? this._workflowExecutionService.getActiveRun(this._workflowUri) : undefined;
		const activeNodeId = targetNodeId || Array.from(this._selectedNodeIds)[0];

		// Sticky Search & Filter Toolbar
		const toolbar = append(this._varsBodyEl, $('.vars-search-toolbar'));
		const searchBox = append(toolbar, $('.vars-search-box'));
		append(searchBox, $('span.vars-search-icon' + ThemeIcon.asCSSSelector(Codicon.search)));
		const searchInput = append(searchBox, $('input.vars-search-input')) as HTMLInputElement;
		searchInput.type = 'text';
		searchInput.placeholder = localize('searchVarNamePlaceholder', 'Search by variable name...');
		searchInput.value = this._varsSearchQuery;
		searchInput.title = localize('searchVarNameTooltip', 'Filter context variables by Variable Name (Esc to clear)');

		const clearSearchBtn = append(searchBox, $('button.vars-search-clear-btn', { type: 'button', title: 'Clear search' })) as HTMLButtonElement;
		append(clearSearchBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
		clearSearchBtn.style.display = this._varsSearchQuery ? 'inline-flex' : 'none';

		const evalFilterBtn = append(toolbar, $(`button.vars-filter-pill${this._varsFilterEvaluatedOnly ? '.active' : ''}`, {
			type: 'button',
			title: 'Show only variables that have a runtime value'
		})) as HTMLButtonElement;
		append(evalFilterBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolVariable)));
		append(evalFilterBtn, $('span', {}, 'Evaluated'));

		const countEl = append(toolbar, $('span.vars-search-count'));

		const resetColsBtn = append(toolbar, $('button.vars-reset-cols-btn', {
			type: 'button',
			title: 'Reset column widths to default'
		})) as HTMLButtonElement;
		append(resetColsBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.layout)));
		append(resetColsBtn, $('span', {}, 'Reset Cols'));

		const tableWrap = append(this._varsBodyEl, $('.vars-table-wrap'));
		const table = append(tableWrap, $('table.workflow-vars-table'));
		const colgroup = append(table, $('colgroup'));
		const colEls: Record<string, HTMLElement> = {};
		const colDefs: Array<{ key: string; label: string; resizable: boolean; align?: string }> = [
			{ key: 'name', label: 'Variable Name', resizable: true },
			{ key: 'node', label: 'Bound Node', resizable: true },
			{ key: 'init', label: 'Initial Value', resizable: true },
			{ key: 'refs', label: 'References', resizable: true },
			{ key: 'value', label: 'Runtime Value', resizable: true },
			{ key: 'action', label: 'Action', resizable: false, align: 'center' }
		];

		for (const cd of colDefs) {
			const col = append(colgroup, $('col'));
			col.style.width = `${this._varsColWidths[cd.key] || defaultColWidths[cd.key]}px`;
			colEls[cd.key] = col;
		}

		const thead = append(table, $('thead'));
		const headerRow = append(thead, $('tr'));
		for (const cd of colDefs) {
			const th = append(headerRow, $(`th${cd.resizable ? '.vars-resizable-th' : ''}`));
			const labelSpan = append(th, $('span'));
			labelSpan.textContent = cd.label;
			if (cd.align) {
				th.style.textAlign = cd.align;
			}
			if (cd.resizable) {
				const resizer = append(th, $('.vars-col-resizer'));
				resizer.title = 'Drag to resize column (double-click to reset)';
				resizer.ondblclick = (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					const defW = defaultColWidths[cd.key];
					if (this._varsColWidths) {
						this._varsColWidths[cd.key] = defW;
					}
					colEls[cd.key].style.width = `${defW}px`;
					saveColWidths();
				};
				resizer.onmousedown = (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					const startX = ev.clientX;
					const startW = th.getBoundingClientRect().width || (this._varsColWidths?.[cd.key] ?? defaultColWidths[cd.key]);
					const limits = colLimits[cd.key];
					resizer.classList.add('resizing');
					this._targetWindow.document.body.style.cursor = 'col-resize';
					const onMove = (me: MouseEvent) => {
						const delta = me.clientX - startX;
						const nextW = Math.round(Math.max(limits.min, Math.min(limits.max, startW + delta)));
						if (this._varsColWidths) {
							this._varsColWidths[cd.key] = nextW;
						}
						colEls[cd.key].style.width = `${nextW}px`;
					};
					const onUp = () => {
						resizer.classList.remove('resizing');
						this._targetWindow.document.body.style.cursor = '';
						this._targetWindow.removeEventListener('mousemove', onMove);
						this._targetWindow.removeEventListener('mouseup', onUp);
						saveColWidths();
					};
					this._targetWindow.addEventListener('mousemove', onMove);
					this._targetWindow.addEventListener('mouseup', onUp);
				};
			}
		}

		resetColsBtn.onclick = () => {
			this._varsColWidths = { ...defaultColWidths };
			for (const cd of colDefs) {
				colEls[cd.key].style.width = `${defaultColWidths[cd.key]}px`;
			}
			saveColWidths();
		};

		const tbody = append(table, $('tbody'));

		const renderTableRows = (shouldScrollToTarget: boolean) => {
			clearNode(tbody);
			const q = this._varsSearchQuery.trim().toLowerCase();
			const filteredVars = allVars.filter(item => {
				if (q && !item.variable.name.toLowerCase().includes(q)) {
					return false;
				}
				if (this._varsFilterEvaluatedOnly) {
					const rt = activeRun?.contextVariables ? activeRun.contextVariables[item.variable.name] : undefined;
					if (rt === undefined) {
						return false;
					}
				}
				return true;
			});

			countEl.textContent = (q || this._varsFilterEvaluatedOnly)
				? `Showing ${filteredVars.length} / ${allVars.length} vars`
				: `${allVars.length} vars`;
			clearSearchBtn.style.display = this._varsSearchQuery ? 'inline-flex' : 'none';

			if (filteredVars.length === 0) {
				const emptyTr = append(tbody, $('tr'));
				const emptyTd = append(emptyTr, $('td'));
				emptyTd.setAttribute('colspan', '6');
				emptyTd.style.textAlign = 'center';
				emptyTd.style.padding = '22px 12px';
				emptyTd.style.color = '#64748b';
				emptyTd.textContent = q
					? `No variables matching "${this._varsSearchQuery.trim()}".`
					: 'No evaluated variables in the active run yet.';
				return;
			}

			for (const item of filteredVars) {
				const isTarget = item.node.id === activeNodeId;
				const row = append(tbody, $(`tr${isTarget ? '.highlighted-var-row' : ''}`));

				// 1. Variable Name
				const nameTd = append(row, $('td'));
				const nameInput = append(nameTd, $('input.vars-table-input')) as HTMLInputElement;
				nameInput.type = 'text';
				nameInput.value = item.variable.name;
				nameInput.title = item.variable.name;
				nameInput.placeholder = 'e.g. status, count';
				nameInput.onchange = () => {
					const cleaned = nameInput.value.trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_') || 'var_1';
					nameInput.value = cleaned;
					item.variable.name = cleaned;
					item.node.outputVariable = this._getNodeVariables(item.node)[0];
					this._saveFlowchartData();
					this._renderNodes();
					this._refreshVariablesDrawer();
				};

				// 2. Bound Node (single-line compact pill with full tooltip)
				const nodeTd = append(row, $('td'));
				const nodeLink = append(nodeTd, $('.vars-table-node-link'));
				append(nodeLink, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolEvent)));
				append(nodeLink, $('span.node-link-text')).textContent = item.node.label || item.node.id;
				nodeLink.title = `Bound Node: ${item.node.label || item.node.id}\nClick to locate & select on canvas`;
				nodeLink.onclick = () => {
					this._selectedNodeIds.clear();
					this._selectedNodeIds.add(item.node.id);
					this._renderNodes();
					if (this._inspectorEl) { this._renderInspector(this._inspectorEl); }
					this._centerOnNode(item.node);
					this._refreshVariablesDrawer(item.node.id);
				};

				// 3. Initial Value (fills column width cleanly)
				const initTd = append(row, $('td'));
				const initInput = append(initTd, $('input.vars-table-input')) as HTMLInputElement;
				initInput.type = 'text';
				initInput.value = item.variable.initialValue || 'None';
				initInput.title = item.variable.initialValue || 'None';
				initInput.placeholder = 'None, True, 0';
				initInput.onchange = () => {
					item.variable.initialValue = initInput.value.trim() || 'None';
					this._saveFlowchartData();
					this._renderNodes();
					this._drawLinks();
					if (this._inspectorEl) { this._renderInspector(this._inspectorEl); }
				};

				// 4. References Column (Writes and Reads tracing)
				const varName = item.variable.name;
				const escapedVarName = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				const regexAt = new RegExp(`@${escapedVarName}\\b`);
				const regexWord = new RegExp(`\\b${escapedVarName}\\b`);

				const writeNodes: string[] = [];
				for (const n of this._data?.nodes || []) {
					if (this._getNodeVariables(n).some(v => v.name === varName)) {
						writeNodes.push(n.label || n.id);
					}
				}

				const readLinks: { from: string; to: string; expr: string }[] = [];
				for (const l of this._data?.links || []) {
					const text = `${l.label || ''} ${l.condition || ''}`;
					if (regexAt.test(text) || regexWord.test(text)) {
						const fromNode = this._data?.nodes.find(n => n.id === l.from);
						const toNode = this._data?.nodes.find(n => n.id === l.to);
						readLinks.push({
							from: fromNode?.label || l.from,
							to: toNode?.label || l.to,
							expr: l.label || l.condition || ''
						});
					}
				}

				const refTd = append(row, $('td'));
				const refBadge = append(refTd, $('.vars-table-ref-badge'));
				const totalRefs = writeNodes.length + readLinks.length;
				refBadge.textContent = `${totalRefs} ref${totalRefs === 1 ? '' : 's'}`;

				const refTooltip = [
					`Defined (Written) in: ${writeNodes.join(', ')}`,
					readLinks.length > 0
						? `Referenced (Read) in: ${readLinks.map(rl => `${rl.from} → ${rl.to} [${rl.expr}]`).join('; ')}`
						: 'No connection conditions referencing this variable yet'
				].join('\n');
				refBadge.title = refTooltip;
				refBadge.onclick = () => {
					this._selectedNodeIds.clear();
					this._selectedNodeIds.add(item.node.id);
					this._renderNodes();
					if (this._inspectorEl) { this._renderInspector(this._inspectorEl); }
					this._centerOnNode(item.node);
					this._notificationService.info(`Variable '${varName}': ${writeNodes.length} write(s), ${readLinks.length} read(s).`);
				};

				// 5. Runtime Value (compact single-line preview with click-to-copy)
				const valTd = append(row, $('td'));
				const runtimeVal = activeRun?.contextVariables ? activeRun.contextVariables[item.variable.name] : undefined;
				const valBadge = append(valTd, $(`.vars-table-val-badge${runtimeVal === undefined ? '.not-run' : ''}`));
				const rawValStr = runtimeVal !== undefined ? (typeof runtimeVal === 'object' ? JSON.stringify(runtimeVal) : String(runtimeVal)) : '(not evaluated)';
				const displayValStr = rawValStr.length > 240 ? rawValStr.substring(0, 240) + ' ...' : rawValStr;
				const tooltipValStr = rawValStr.length > 800 ? rawValStr.substring(0, 800) + ' ...' : rawValStr;
				valBadge.textContent = displayValStr;
				valBadge.title = runtimeVal !== undefined ? `${tooltipValStr}\n\n(Click to copy full value)` : '(not evaluated)';
				if (runtimeVal !== undefined) {
					valBadge.onclick = () => {
						navigator.clipboard?.writeText(rawValStr).then(() => {
							this._notificationService.info(`Copied runtime value of '${item.variable.name}' (${rawValStr.length} chars).`);
						}).catch(() => { });
					};
				}

				// 6. Action (Unbind / Delete)
				const actionTd = append(row, $('td'));
				actionTd.style.textAlign = 'center';
				const unbindBtn = append(actionTd, $('.vars-table-action-btn'));
				unbindBtn.title = `Unbind variable '${item.variable.name}' from '${item.node.label}'`;
				append(unbindBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
				unbindBtn.onclick = () => {
					this._unbindVariableFromNode(item.node, item.variable.name);
				};

				if (shouldScrollToTarget && isTarget) {
					setTimeout(() => {
						row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
						if (!this._varsSearchQuery) {
							nameInput.focus();
						}
					}, 60);
				}
			}
		};

		searchInput.oninput = () => {
			this._varsSearchQuery = searchInput.value;
			renderTableRows(false);
		};
		searchInput.onkeydown = (ke) => {
			ke.stopPropagation();
			if (ke.key === 'Escape' && this._varsSearchQuery) {
				this._varsSearchQuery = '';
				searchInput.value = '';
				renderTableRows(false);
			}
		};
		clearSearchBtn.onclick = () => {
			this._varsSearchQuery = '';
			searchInput.value = '';
			renderTableRows(false);
			searchInput.focus();
		};
		evalFilterBtn.onclick = () => {
			this._varsFilterEvaluatedOnly = !this._varsFilterEvaluatedOnly;
			evalFilterBtn.classList.toggle('active', this._varsFilterEvaluatedOnly);
			renderTableRows(false);
		};

		renderTableRows(Boolean(targetNodeId));
	}

	private _collectVariableOccurrences(findName: string): {
		type: 'node-var-def' | 'node-var-expr' | 'link-condition' | 'link-label';
		node?: IFlowchartNode;
		varIndex?: number;
		link?: IFlowchartLink;
		targetVar?: INodeVariable;
		description: string;
	}[] {
		const results: {
			type: 'node-var-def' | 'node-var-expr' | 'link-condition' | 'link-label';
			node?: IFlowchartNode;
			varIndex?: number;
			link?: IFlowchartLink;
			targetVar?: INodeVariable;
			description: string;
		}[] = [];

		if (!this._data || !findName.trim()) { return results; }

		const query = findName.trim();
		const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const wordReg = new RegExp(`(?<=^|[^a-zA-Z0-9_\\u4e00-\\u9fa5])@?${escaped}(?=[^a-zA-Z0-9_\\u4e00-\\u9fa5]|$)`, 'g');

		// 1. Scan nodes
		for (const node of this._data.nodes) {
			const vars = this._getNodeVariables(node);
			for (let i = 0; i < vars.length; i++) {
				const v = vars[i];
				if (v.name === query) {
					results.push({
						type: 'node-var-def',
						node,
						varIndex: i,
						targetVar: v,
						description: localize('occNodeDef', "Node '{0}' definition: '{1}'", node.label, v.name)
					});
				}
				if (v.expression) {
					wordReg.lastIndex = 0;
					if (wordReg.test(v.expression)) {
						results.push({
							type: 'node-var-expr',
							node,
							varIndex: i,
							targetVar: v,
							description: localize('occNodeExpr', "Node '{0}' expression: '{1}'", node.label, v.expression)
						});
					}
				}
			}
		}

		// 2. Scan links
		for (const link of this._data.links) {
			if (link.condition) {
				wordReg.lastIndex = 0;
				if (wordReg.test(link.condition)) {
					results.push({
						type: 'link-condition',
						link,
						description: localize('occLinkCond', "Link condition: '{0}'", link.condition)
					});
				}
			}
			if (link.label) {
				wordReg.lastIndex = 0;
				if (wordReg.test(link.label)) {
					results.push({
						type: 'link-label',
						link,
						description: localize('occLinkLabel', "Link label: '{0}'", link.label)
					});
				}
			}
		}

		return results;
	}

	private _replaceNextVariableOccurrence(findName: string, replaceWith: string): void {
		const occs = this._collectVariableOccurrences(findName);
		if (occs.length === 0) {
			this._notificationService.info(localize('noMatchesFound', "No occurrences of variable '{0}' found.", findName));
			return;
		}

		if (this._varsFindCurrentIndex >= occs.length) {
			this._varsFindCurrentIndex = 0;
		}

		const occ = occs[this._varsFindCurrentIndex];
		const escaped = findName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const wordReg = new RegExp(`(?<=^|[^a-zA-Z0-9_\\u4e00-\\u9fa5])@?${escaped}(?=[^a-zA-Z0-9_\\u4e00-\\u9fa5]|$)`, 'g');

		if (occ.type === 'node-var-def' && occ.targetVar) {
			occ.targetVar.name = replaceWith;
			if (occ.node) {
				occ.node.outputVariable = this._getNodeVariables(occ.node)[0];
			}
		} else if (occ.type === 'node-var-expr' && occ.targetVar?.expression) {
			occ.targetVar.expression = occ.targetVar.expression.replace(wordReg, replaceWith);
		} else if (occ.type === 'link-condition' && occ.link?.condition) {
			occ.link.condition = occ.link.condition.replace(wordReg, replaceWith);
		} else if (occ.type === 'link-label' && occ.link?.label) {
			occ.link.label = occ.link.label.replace(wordReg, `@${replaceWith}`);
		}

		if (occ.node) {
			this._selectedNodeIds.clear();
			this._selectedNodeIds.add(occ.node.id);
			this._centerOnNode(occ.node);
		} else if (occ.link) {
			this._selectedLinkIds.clear();
			this._selectedLinkIds.add(occ.link.id);
		}

		this._saveFlowchartData();
		this._renderNodes();
		this._drawLinks();
		if (this._inspectorEl) { this._renderInspector(this._inspectorEl); }
		this._refreshVariablesDrawer();

		const remaining = this._collectVariableOccurrences(findName).length;
		this._notificationService.info(localize('replacedNextInfo', "Replaced occurrence in {0}. ({1} remaining)", occ.description, remaining));
	}

	private _replaceAllVariableOccurrences(findName: string, replaceWith: string): void {
		const occs = this._collectVariableOccurrences(findName);
		if (occs.length === 0) {
			this._notificationService.info(localize('noMatchesFound', "No occurrences of variable '{0}' found.", findName));
			return;
		}

		const escaped = findName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const wordReg = new RegExp(`(?<=^|[^a-zA-Z0-9_\\u4e00-\\u9fa5])@?${escaped}(?=[^a-zA-Z0-9_\\u4e00-\\u9fa5]|$)`, 'g');

		let count = 0;
		for (const occ of occs) {
			if (occ.type === 'node-var-def' && occ.targetVar) {
				occ.targetVar.name = replaceWith;
				if (occ.node) {
					occ.node.outputVariable = this._getNodeVariables(occ.node)[0];
				}
				count++;
			} else if (occ.type === 'node-var-expr' && occ.targetVar?.expression) {
				occ.targetVar.expression = occ.targetVar.expression.replace(wordReg, replaceWith);
				count++;
			} else if (occ.type === 'link-condition' && occ.link?.condition) {
				occ.link.condition = occ.link.condition.replace(wordReg, replaceWith);
				count++;
			} else if (occ.type === 'link-label' && occ.link?.label) {
				occ.link.label = occ.link.label.replace(wordReg, `@${replaceWith}`);
				count++;
			}
		}

		if (this._workflowUri) {
			const activeRun = this._workflowExecutionService.getActiveRun(this._workflowUri);
			if (activeRun?.contextVariables && Object.prototype.hasOwnProperty.call(activeRun.contextVariables, findName.trim())) {
				activeRun.contextVariables[replaceWith] = activeRun.contextVariables[findName.trim()];
				delete activeRun.contextVariables[findName.trim()];
			}
		}

		this._saveFlowchartData();
		this._renderNodes();
		this._drawLinks();
		if (this._inspectorEl) { this._renderInspector(this._inspectorEl); }
		this._refreshVariablesDrawer();

		this._notificationService.info(localize('replacedAllInfo', "Replaced all {0} occurrences of variable '{1}' with '{2}'.", count, findName, replaceWith));
	}

	private _openVarsFindReplaceBar(initialFindQuery?: string): void {
		this._isVarsFindReplaceOpen = true;
		if (initialFindQuery) {
			this._varsLastFindQuery = initialFindQuery;
		}
		this._openDrawerTab('vars');
		setTimeout(() => {
			if (this._varsFindInputEl) {
				this._varsFindInputEl.focus();
				this._varsFindInputEl.select();
			}
		}, 50);
	}

	private _closeVarsFindReplaceBar(): void {
		this._isVarsFindReplaceOpen = false;
		this._refreshVariablesDrawer();
	}

	private _toggleVarsFindReplaceBar(): void {
		if (this._isVarsFindReplaceOpen) {
			this._closeVarsFindReplaceBar();
		} else {
			this._openVarsFindReplaceBar();
		}
	}

	private _renderVarsFindReplaceBar(container: HTMLElement): void {
		const bar = append(container, $('.vars-find-replace-bar'));

		const findGroup = append(bar, $('.vars-find-input-group'));
		append(findGroup, $('span' + ThemeIcon.asCSSSelector(Codicon.search)));
		const findInput = append(findGroup, $('input.vars-find-input')) as HTMLInputElement;
		findInput.type = 'text';
		findInput.placeholder = localize('findVarPlaceholder', 'Find variable name...');
		this._varsFindInputEl = findInput;
		if (this._varsLastFindQuery) {
			findInput.value = this._varsLastFindQuery;
		}

		const arrowIcon = append(bar, $('.vars-replace-arrow'));
		arrowIcon.textContent = '\u2794';
		arrowIcon.style.color = '#38bdf8';
		arrowIcon.style.fontSize = '12px';

		const replaceGroup = append(bar, $('.vars-replace-input-group'));
		append(replaceGroup, $('span' + ThemeIcon.asCSSSelector(Codicon.replace)));
		const replaceInput = append(replaceGroup, $('input.vars-replace-input')) as HTMLInputElement;
		replaceInput.type = 'text';
		replaceInput.placeholder = localize('replaceVarPlaceholder', 'Replace with...');
		if (this._varsLastReplaceQuery) {
			replaceInput.value = this._varsLastReplaceQuery;
		}

		const actions = append(bar, $('.vars-find-actions'));
		const matchesBadge = append(actions, $('.vars-matches-badge'));

		const updateMatchesCount = () => {
			const query = findInput.value.trim();
			this._varsLastFindQuery = query;
			if (!query) {
				matchesBadge.textContent = '0 matches';
				return [];
			}
			const occs = this._collectVariableOccurrences(query);
			matchesBadge.textContent = `${occs.length} ${occs.length === 1 ? 'match' : 'matches'}`;
			return occs;
		};

		updateMatchesCount();

		findInput.oninput = () => {
			this._varsFindCurrentIndex = 0;
			updateMatchesCount();
		};

		replaceInput.oninput = () => {
			this._varsLastReplaceQuery = replaceInput.value.trim();
		};

		// Replace Next Button
		const replaceNextBtn = append(actions, $('button.vars-find-btn.btn-next'));
		replaceNextBtn.textContent = localize('replaceNextBtn', 'Replace');
		replaceNextBtn.title = 'Replace next occurrence of this variable (Enter)';
		replaceNextBtn.onclick = () => {
			const findName = findInput.value.trim();
			const replaceWith = replaceInput.value.trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_');
			if (!findName || !replaceWith) {
				this._notificationService.warn(localize('findReplaceMissing', 'Please provide both find and replace variable names.'));
				return;
			}
			this._replaceNextVariableOccurrence(findName, replaceWith);
		};

		// Replace All Button
		const replaceAllBtn = append(actions, $('button.vars-find-btn.btn-all'));
		replaceAllBtn.textContent = localize('replaceAllBtn', 'Replace All');
		replaceAllBtn.title = 'Replace all occurrences of this variable across nodes & links (Cmd/Ctrl+Enter)';
		replaceAllBtn.onclick = () => {
			const findName = findInput.value.trim();
			const replaceWith = replaceInput.value.trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_');
			if (!findName || !replaceWith) {
				this._notificationService.warn(localize('findReplaceMissing', 'Please provide both find and replace variable names.'));
				return;
			}
			this._replaceAllVariableOccurrences(findName, replaceWith);
		};

		// Close Button
		const closeBtn = append(actions, $('button.vars-find-close-btn'));
		closeBtn.textContent = '\u2715';
		closeBtn.title = 'Close Find & Replace (Esc)';
		closeBtn.onclick = () => {
			this._closeVarsFindReplaceBar();
		};

		findInput.onkeydown = (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				replaceInput.focus();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				this._closeVarsFindReplaceBar();
			}
		};

		replaceInput.onkeydown = (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				if (e.altKey || e.metaKey || e.ctrlKey) {
					replaceAllBtn.click();
				} else {
					replaceNextBtn.click();
				}
			} else if (e.key === 'Escape') {
				e.preventDefault();
				this._closeVarsFindReplaceBar();
			}
		};
	}

	private _updateHistoryCountBadge(): void {
		if (this._historyCountBadgeEl && this._workflowUri) {
			const runs = this._workflowExecutionService.getRunsForWorkflow(this._workflowUri);
			this._historyCountBadgeEl.textContent = `${runs.length} run${runs.length === 1 ? '' : 's'}`;
		}
	}

	private _refreshHistoryDrawer(): void {
		if (!this._historyBodyEl || !this._workflowUri) { return; }
		clearNode(this._historyBodyEl);

		const runs = this._workflowExecutionService.getRunsForWorkflow(this._workflowUri);
		this._updateHistoryCountBadge();

		if ((!this._selectedHistoryRunId || !runs.some(r => r.runId === this._selectedHistoryRunId)) && runs.length > 0) {
			this._selectedHistoryRunId = runs[0].runId;
		}

		// Left Sidebar: Runs List
		const sidebar = append(this._historyBodyEl, $('.workflow-history-sidebar'));
		const sidebarHeader = append(sidebar, $('.workflow-history-sidebar-header'));
		const headerTitle = append(sidebarHeader, $('span'));
		headerTitle.textContent = 'RUN HISTORY';

		if (runs.length > 0) {
			const clearAllBtn = append(sidebarHeader, $('.history-clear-all-btn'));
			clearAllBtn.title = 'Clear All Run History';
			append(clearAllBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.clearAll)));
			clearAllBtn.onclick = (e) => {
				e.stopPropagation();
				if (this._workflowUri) {
					this._workflowExecutionService.clearRuns(this._workflowUri);
					this._selectedHistoryRunId = undefined;
					this._refreshHistoryDrawer();
				}
			};
		}

		const listEl = append(sidebar, $('div.workflow-history-list'));
		if (runs.length === 0) {
			const emptyItem = append(listEl, $('.workflow-history-empty'));
			emptyItem.textContent = 'No execution runs recorded yet. Execute the workflow to capture run snapshots.';
		} else {
			for (const r of runs) {
				const isSelected = r.runId === this._selectedHistoryRunId;
				const item = append(listEl, $(`.workflow-history-item${isSelected ? '.selected' : ''}`));

				const topRow = append(item, $('.history-item-top'));
				const buildNumber = append(topRow, $('span.history-build-num'));
				buildNumber.textContent = `#${r.runNumber ?? r.runId.substring(4, 9)}`;

				const statusBadge = append(topRow, $(`span.history-status-badge.status-${r.status}`));
				statusBadge.textContent = r.status.toUpperCase();

				const delBtn = append(topRow, $('.history-item-del-btn'));
				delBtn.title = 'Delete run record';
				append(delBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
				delBtn.onclick = (e) => {
					e.stopPropagation();
					this._workflowExecutionService.deleteRun(r.runId);
					if (this._selectedHistoryRunId === r.runId) {
						this._selectedHistoryRunId = undefined;
					}
					this._refreshHistoryDrawer();
				};

				const botRow = append(item, $('.history-item-bottom'));
				const timeSpan = append(botRow, $('span.history-time'));
				const dateObj = new Date(r.startedAt);
				timeSpan.textContent = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

				const durSpan = append(botRow, $('span.history-duration'));
				const durMs = r.durationMs ?? (r.completedAt ? r.completedAt - r.startedAt : 0);
				durSpan.textContent = durMs > 0 ? `${(durMs / 1000).toFixed(1)}s` : (r.status === 'running' ? 'running...' : '0s');

				item.onclick = () => {
					this._selectedHistoryRunId = r.runId;
					this._refreshHistoryDrawer();
				};
			}
		}

		// Right Pane: Detail & Component Traces
		const detailEl = append(this._historyBodyEl, $('.workflow-history-detail'));
		const selectedRun = runs.find(r => r.runId === this._selectedHistoryRunId);

		if (!selectedRun) {
			const placeholder = append(detailEl, $('.workflow-history-placeholder'));
			append(placeholder, $('span' + ThemeIcon.asCSSSelector(Codicon.history)));
			const pText = append(placeholder, $('p'));
			pText.textContent = runs.length === 0
				? 'Workflow has not been executed yet. Run the workflow to inspect full component traces and execution logs.'
				: 'Select an execution run from the left history to view detailed primitive traces, logs, and outputs.';
			return;
		}

		this._renderRunDetail(detailEl, selectedRun);
	}

	private _renderRunDetail(parent: HTMLElement, run: IWorkflowExecutionRun): void {
		// 1. Top Detail Header
		const header = append(parent, $('.history-detail-header'));
		const titleArea = append(header, $('.history-detail-title-area'));
		const title = append(titleArea, $('h3.history-detail-title'));
		title.textContent = `Build #${run.runNumber ?? run.runId} (${run.workflowName})`;

		const tagsRow = append(titleArea, $('.history-detail-tags'));
		const statusTag = append(tagsRow, $(`span.history-status-badge.status-${run.status}`));
		statusTag.textContent = run.status.toUpperCase();

		const timeTag = append(tagsRow, $('span.history-tag'));
		const durMs = run.durationMs ?? (run.completedAt ? run.completedAt - run.startedAt : 0);
		timeTag.textContent = `Duration: ${(durMs / 1000).toFixed(2)}s`;

		const startTag = append(tagsRow, $('span.history-tag'));
		startTag.textContent = `Started: ${new Date(run.startedAt).toLocaleString()}`;

		const modeTag = append(tagsRow, $('span.history-tag'));
		modeTag.textContent = `Mode: ${run.mode}`;

		const actionsArea = append(header, $('.history-detail-actions'));

		// 1. One-Click Copy Complete Build Report (Human-readable plain text/markdown)
		const copyReportBtn = append(actionsArea, $('button.history-action-btn'));
		append(copyReportBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy)));
		append(copyReportBtn, $('span')).textContent = 'Copy Report';
		copyReportBtn.title = 'Copy complete human-readable build log, all component traces, and variable snapshots to clipboard';
		copyReportBtn.onclick = async () => {
			const report = this._generateBuildReport(run);
			let ok = false;
			try {
				await this._clipboardService.writeText(report);
				ok = true;
			} catch { }
			if (ok) {
				clearNode(copyReportBtn);
				append(copyReportBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.check)));
				append(copyReportBtn, $('span')).textContent = 'Copied Report!';
				copyReportBtn.style.color = '#10b981';
				this._notificationService.info('Full build report with all component traces copied to clipboard.');
				setTimeout(() => {
					if (copyReportBtn.isConnected) {
						clearNode(copyReportBtn);
						append(copyReportBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy)));
						append(copyReportBtn, $('span')).textContent = 'Copy Report';
						copyReportBtn.style.color = '';
					}
				}, 2000);
			} else {
				this._notificationService.error('Failed to copy report to clipboard.');
			}
		};

		// 2. Copy Run JSON
		const copyJsonBtn = append(actionsArea, $('button.history-action-btn'));
		append(copyJsonBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.json)));
		append(copyJsonBtn, $('span')).textContent = 'Copy JSON';
		copyJsonBtn.title = 'Copy structured JSON representation of this run';
		copyJsonBtn.onclick = async () => {
			const jsonStr = JSON.stringify(run, null, 2);
			await this._clipboardService.writeText(jsonStr);
			this._notificationService.info('Run snapshot JSON copied to clipboard.');
		};

		// 2. Sections Container
		const contentArea = append(parent, $('.history-detail-content'));

		// Collect all executed ticket records from all nodeStates
		const allTickets: { nodeLabel: string; ticket: IExecutedTicketRecord }[] = [];
		for (const [nodeId, nState] of Object.entries(run.nodeStates || {})) {
			if (nState.executedTickets && nState.executedTickets.length > 0) {
				for (const t of nState.executedTickets) {
					allTickets.push({ nodeLabel: nState.nodeLabel || nodeId, ticket: t });
				}
			}
		}

		// SECTION A: Chronological Execution Path & Node-by-Node Traces
		const traceSection = append(contentArea, $('.history-section'));
		const traceSecHeader = append(traceSection, $('.history-section-header.collapsible'));
		const traceSecChevron = append(traceSecHeader, $('span.history-chevron'));
		append(traceSecChevron, $('span' + ThemeIcon.asCSSSelector(Codicon.chevronDown)));
		append(traceSecHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.output)));
		const traceTitle = append(traceSecHeader, $('h4'));

		const traceContainer = append(traceSection, $('.history-trace-container'));

		const pathSteps = run.executionPath || [];
		traceTitle.textContent = pathSteps.length > 0
			? `Chronological Execution Path & Node Traces (${pathSteps.length} step${pathSteps.length === 1 ? '' : 's'})`
			: `Component & Primitive Execution Traces (${allTickets.length} ticket${allTickets.length === 1 ? '' : 's'})`;

		let isTraceSecExpanded = true;
		traceSecHeader.onclick = () => {
			isTraceSecExpanded = !isTraceSecExpanded;
			traceContainer.style.display = isTraceSecExpanded ? 'block' : 'none';
			clearNode(traceSecChevron);
			append(traceSecChevron, $('span' + ThemeIcon.asCSSSelector(isTraceSecExpanded ? Codicon.chevronDown : Codicon.chevronRight)));
		};

		if (pathSteps.length > 0) {
			for (const pStep of pathSteps) {
				this._renderPathStep(traceContainer, pStep);
			}
		} else if (allTickets.length === 0) {
			const noTrace = append(traceContainer, $('.history-empty-hint'));
			noTrace.textContent = 'No ticket primitives or nodes recorded in this run.';
		} else {
			// Fallback for older runs
			for (const { nodeLabel, ticket } of allTickets) {
				this._renderTicketCard(traceContainer, ticket, nodeLabel);
			}
		}

		// SECTION B: Run Logs (Collapsible)
		const logsSection = append(contentArea, $('.history-section'));
		const logsSecHeader = append(logsSection, $('.history-section-header.collapsible'));
		const logsSecChevron = append(logsSecHeader, $('span.history-chevron'));
		append(logsSecChevron, $('span' + ThemeIcon.asCSSSelector(Codicon.chevronDown)));
		append(logsSecHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.output)));
		append(logsSecHeader, $('h4')).textContent = `Execution Event Logs (${run.logs?.length || 0} events)`;

		const logsContainer = append(logsSection, $('.history-logs-container'));
		let isLogsSecExpanded = true;
		logsSecHeader.onclick = () => {
			isLogsSecExpanded = !isLogsSecExpanded;
			logsContainer.style.display = isLogsSecExpanded ? 'block' : 'none';
			clearNode(logsSecChevron);
			append(logsSecChevron, $('span' + ThemeIcon.asCSSSelector(isLogsSecExpanded ? Codicon.chevronDown : Codicon.chevronRight)));
		};

		if (!run.logs || run.logs.length === 0) {
			const emptyLog = append(logsContainer, $('.history-empty-hint'));
			emptyLog.textContent = 'No logs recorded for this run.';
		} else {
			for (const l of run.logs) {
				const lRow = append(logsContainer, $('.history-log-row'));
				const lTime = append(lRow, $('span.history-log-time'));
				lTime.textContent = new Date(l.timestamp).toLocaleTimeString();
				const lLevel = append(lRow, $(`span.history-log-level.level-${l.level}`));
				lLevel.textContent = l.level.toUpperCase();
				if (l.nodeId) {
					const lNode = append(lRow, $('span.history-log-node'));
					lNode.textContent = l.nodeId;
				}
				const lMsg = append(lRow, $('span.history-log-msg'));
				lMsg.textContent = l.message;
			}
		}

		// SECTION C: Context Variables Snapshot (Collapsible)
		if (run.contextVariables && Object.keys(run.contextVariables).length > 0) {
			const varsSection = append(contentArea, $('.history-section'));
			const varsSecHeader = append(varsSection, $('.history-section-header.collapsible'));
			const varsSecChevron = append(varsSecHeader, $('span.history-chevron'));
			append(varsSecChevron, $('span' + ThemeIcon.asCSSSelector(Codicon.chevronDown)));
			append(varsSecHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolVariable)));
			append(varsSecHeader, $('h4')).textContent = `Context Variables Snapshot (${Object.keys(run.contextVariables).length} variables)`;

			const varsContainer = append(varsSection, $('.history-vars-container'));
			let isVarsSecExpanded = true;
			varsSecHeader.onclick = () => {
				isVarsSecExpanded = !isVarsSecExpanded;
				varsContainer.style.display = isVarsSecExpanded ? 'block' : 'none';
				clearNode(varsSecChevron);
				append(varsSecChevron, $('span' + ThemeIcon.asCSSSelector(isVarsSecExpanded ? Codicon.chevronDown : Codicon.chevronRight)));
			};

			const varsTable = append(varsContainer, $('table.history-vars-table'));
			const thead = append(varsTable, $('thead'));
			const hRow = append(thead, $('tr'));
			append(hRow, $('th')).textContent = 'Variable';
			append(hRow, $('th')).textContent = 'Type';
			append(hRow, $('th')).textContent = 'Value';

			const tbody = append(varsTable, $('tbody'));
			for (const [vName, vVal] of Object.entries(run.contextVariables)) {
				if (vName.startsWith('@') && hasWorkflowProperty(run.contextVariables, vName.substring(1))) {
					continue;
				}
				const bRow = append(tbody, $('tr'));
				const nameTd = append(bRow, $('td.history-var-name'));
				nameTd.textContent = vName;
				const typeTd = append(bRow, $('td.history-var-type'));
				typeTd.textContent = Array.isArray(vVal) ? 'array' : typeof vVal;
				const valTd = append(bRow, $('td.history-var-val-cell'));
				const valBox = append(valTd, $('div.history-var-val'));
				const rawVStr = typeof vVal === 'object' && vVal !== null ? JSON.stringify(vVal) : String(vVal);
				valBox.textContent = rawVStr.length > 500 ? rawVStr.substring(0, 500) + ' ...' : rawVStr;
			}
		}
	}

	private _renderPathStep(parent: HTMLElement, pStep: IWorkflowPathStep): void {
		const stepCard = append(parent, $('.history-path-step-card'));
		const header = append(stepCard, $('.history-path-step-header'));

		const left = append(header, $('.history-path-step-left'));
		const stepChevron = append(left, $('span.history-chevron'));
		append(stepChevron, $('span' + ThemeIcon.asCSSSelector(Codicon.chevronDown)));

		const numBadge = append(left, $('span.history-step-num-badge'));
		numBadge.textContent = `Step #${pStep.stepIndex}`;

		const typeBadge = append(left, $('span.history-node-type-badge'));
		typeBadge.textContent = (pStep.nodeType || 'node').toUpperCase();

		const titleSpan = append(left, $('span.history-path-step-title'));
		titleSpan.textContent = pStep.nodeLabel;

		const right = append(header, $('.history-path-step-right'));
		if (pStep.operations && pStep.operations.length > 0) {
			const opBadge = append(right, $('span.history-count-tag'));
			opBadge.textContent = `${pStep.operations.length} action${pStep.operations.length === 1 ? '' : 's'}`;
		}

		const statusBadge = append(right, $(`span.history-status-badge.status-${pStep.status}`));
		statusBadge.textContent = pStep.status.toUpperCase();

		if (pStep.durationMs !== undefined && pStep.durationMs > 0) {
			const durSpan = append(right, $('span.history-ticket-dur'));
			durSpan.textContent = pStep.durationMs >= 1000 ? `${(pStep.durationMs / 1000).toFixed(2)}s` : `${pStep.durationMs}ms`;
		}

		const body = append(stepCard, $('.history-path-step-body'));
		let isExpanded = true;
		header.onclick = () => {
			isExpanded = !isExpanded;
			body.style.display = isExpanded ? 'flex' : 'none';
			clearNode(stepChevron);
			append(stepChevron, $('span' + ThemeIcon.asCSSSelector(isExpanded ? Codicon.chevronDown : Codicon.chevronRight)));
		};

		// 1. Render operations executed inside this node
		if (pStep.operations && pStep.operations.length > 0) {
			for (const op of pStep.operations) {
				if (op.type === 'run_ticket' && op.executedTicket) {
					this._renderTicketCard(body, op.executedTicket, pStep.nodeLabel);
				} else if (op.type === 'create_ticket') {
					const opCard = append(body, $('.history-op-card.create-ticket'));
					const opHeader = append(opCard, $('.history-op-header'));
					append(opHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.gitCommit)));
					append(opHeader, $('span.history-op-title')).textContent = op.label;

					const opBody = append(opCard, $('.history-op-body'));
					const d = op.details || {};
					if (d.ticketId) {
						const row = append(opBody, $('.history-op-row'));
						append(row, $('span.history-op-key')).textContent = 'Created Ticket:';
						append(row, $('span.history-op-val.highlight')).textContent = `${d.ticketId} (${d.title || ''})`;
					}
					if (d.targetFolder) {
						const row = append(opBody, $('.history-op-row'));
						append(row, $('span.history-op-key')).textContent = 'Target Folder:';
						append(row, $('span.history-op-val')).textContent = String(d.targetFolder);
					}
					if (d.parameters && Object.keys(d.parameters).length > 0) {
						const row = append(opBody, $('.history-op-row'));
						append(row, $('span.history-op-key')).textContent = 'Inputs:';
						const pPre = append(row, $('pre.workflow-trace-pre'));
						pPre.textContent = JSON.stringify(d.parameters, null, 2);
					}
				} else if (op.type === 'set_variable') {
					const opCard = append(body, $('.history-op-card.set-var'));
					const opHeader = append(opCard, $('.history-op-header'));
					append(opHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolVariable)));
					append(opHeader, $('span.history-op-title')).textContent = op.label;

					if (op.details?.expression) {
						const opBody = append(opCard, $('.history-op-body'));
						const row = append(opBody, $('.history-op-row'));
						append(row, $('span.history-op-key')).textContent = 'Expression:';
						append(row, $('span.history-op-val')).textContent = String(op.details.expression);
					}
				} else if (op.type === 'call_function') {
					const opCard = append(body, $('.history-op-card.call-function'));
					const opHeader = append(opCard, $('.history-op-header'));
					append(opHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolEvent)));
					append(opHeader, $('span.history-op-title')).textContent = op.label;

					const opRight = append(opHeader, $('div', { style: 'display: flex; align-items: center; gap: 6px; margin-left: auto;' }));
					if (op.durationMs !== undefined && op.durationMs > 0) {
						const durSpan = append(opRight, $('span.history-ticket-dur'));
						durSpan.textContent = op.durationMs >= 1000 ? `${(op.durationMs / 1000).toFixed(2)}s` : `${op.durationMs}ms`;
					}

					const opBody = append(opCard, $('.history-op-body'));
					const callOp: IWorkflowNodeOperationWithResult = op;
					if (callOp.expression) {
						const row = append(opBody, $('.history-op-row'));
						append(row, $('span.history-op-key')).textContent = 'Target / Expression:';
						append(row, $('span.history-op-val')).textContent = String(callOp.expression);
					}
					if (callOp.value !== undefined) {
						const row = append(opBody, $('.history-op-row'));
						append(row, $('span.history-op-key')).textContent = 'Output:';
						const vPre = append(row, $('pre.workflow-trace-pre'));
						vPre.textContent = typeof callOp.value === 'object' && callOp.value !== null
							? JSON.stringify(callOp.value, null, 2)
							: String(callOp.value);
					}
				} else if (op.type === 'display') {
					const opCard = append(body, $('.history-op-card.display'));
					const opHeader = append(opCard, $('.history-op-header'));
					append(opHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.preview)));
					append(opHeader, $('span.history-op-title')).textContent = op.label;

					if (op.details?.formattedText) {
						const opBody = append(opCard, $('.history-op-body'));
						const dPre = append(opBody, $('pre.workflow-trace-pre'));
						dPre.textContent = String(op.details.formattedText);
					}
				} else {
					const opCard = append(body, $('.history-op-card.general'));
					const opHeader = append(opCard, $('.history-op-header'));
					append(opHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.info)));
					append(opHeader, $('span.history-op-title')).textContent = op.label;
				}
			}
		}

		// 2. Render outgoing transition & condition evaluation
		if (pStep.transition) {
			const t = pStep.transition;
			const transRow = append(body, $('.history-step-transition'));
			const transIcon = append(transRow, $('span.history-trans-icon'));
			append(transIcon, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowRight)));

			const transLabel = append(transRow, $('span.history-trans-label'));
			transLabel.textContent = 'Transition:';

			const pill = append(transRow, $('span.history-transition-pill'));
			if (t.conditionLabel) {
				pill.classList.add('condition');
				pill.textContent = t.explanation || t.conditionLabel;
				if (t.toNodeLabel) {
					const destSpan = append(transRow, $('span.history-trans-dest'));
					destSpan.textContent = `\u2500\u2500\u25B6 Navigate to '${t.toNodeLabel}'`;
				}
			} else {
				pill.classList.add('unconditional');
				pill.textContent = t.explanation || `Proceed to '${t.toNodeLabel || 'Next Node'}'`;
			}
		}
	}

	private _renderTicketCard(parent: HTMLElement, ticket: IExecutedTicketRecord, nodeLabel: string): void {
		const ticketCard = append(parent, $('.history-ticket-card'));
		const tHeader = append(ticketCard, $('.history-ticket-header'));

		const tLeft = append(tHeader, $('.history-ticket-left'));
		const tChevron = append(tLeft, $('span.history-chevron'));
		append(tChevron, $('span' + ThemeIcon.asCSSSelector(Codicon.chevronDown)));

		const tTitle = append(tLeft, $('span.history-ticket-title'));
		tTitle.textContent = `${ticket.ticketName || ticket.ticketId} [${ticket.ticketType || 'task'}]`;
		const nodeBadge = append(tLeft, $('span.history-node-badge'));
		nodeBadge.textContent = nodeLabel;

		const steps = ticket.stepResults || [];

		const tRight = append(tHeader, $('.history-ticket-right'));
		const countBadge = append(tRight, $('span.history-count-tag'));
		countBadge.textContent = `${steps.length} components`;

		const tStatus = append(tRight, $(`span.history-status-badge.status-${ticket.status}`));
		tStatus.textContent = ticket.status.toUpperCase();
		if (ticket.durationMs) {
			const tDur = append(tRight, $('span.history-ticket-dur'));
			tDur.textContent = `${(ticket.durationMs / 1000).toFixed(1)}s`;
		}

		// Primitive steps inside this ticket (expandable container)
		const stepsContainer = append(ticketCard, $('.history-steps-container'));
		let isTicketExpanded = true;
		tHeader.onclick = () => {
			isTicketExpanded = !isTicketExpanded;
			stepsContainer.style.display = isTicketExpanded ? 'flex' : 'none';
			clearNode(tChevron);
			append(tChevron, $('span' + ThemeIcon.asCSSSelector(isTicketExpanded ? Codicon.chevronDown : Codicon.chevronRight)));
		};

		if (steps.length === 0) {
			const noSteps = append(stepsContainer, $('.history-step-empty'));
			noSteps.textContent = 'Ticket completed without sub-primitive steps.';
		} else {
			for (let sIdx = 0; sIdx < steps.length; sIdx++) {
				const step = steps[sIdx];
				this._renderPrimitiveStepTrace(stepsContainer, step, sIdx + 1);
			}
		}
	}

	private _renderPrimitiveStepTrace(parent: HTMLElement, step: IPrimitiveExecutionStepResult, index: number): void {
		const card = append(parent, $('.workflow-trace-card'));
		const header = append(card, $('.workflow-trace-header'));

		const left = append(header, $('.workflow-trace-left'));
		const stepChevron = append(left, $('span.history-chevron'));
		append(stepChevron, $('span' + ThemeIcon.asCSSSelector(Codicon.chevronDown)));

		const numBadge = append(left, $('span.workflow-trace-num'));
		numBadge.textContent = `#${index}`;

		const typeBadge = append(left, $('span.workflow-output-format-badge'));
		typeBadge.textContent = step.fieldType.toUpperCase();

		const titleSpan = append(left, $('span.workflow-trace-title'));
		titleSpan.textContent = step.fieldLabel;

		const right = append(header, $('.workflow-trace-right'));
		const statusBadge = append(right, $(`span.workflow-output-status-badge.${step.status}`));
		statusBadge.textContent = step.status === 'success' ? 'SUCCESS' : (step.status === 'failed' ? 'FAILED' : 'SKIPPED');

		if (step.durationMs !== undefined && step.durationMs > 0) {
			const durSpan = append(right, $('span.workflow-trace-dur'));
			durSpan.textContent = `${step.durationMs}ms`;
		}

		const body = append(card, $('.workflow-trace-body'));
		let isStepExpanded = true;
		header.onclick = (e) => {
			e.stopPropagation();
			isStepExpanded = !isStepExpanded;
			body.style.display = isStepExpanded ? 'flex' : 'none';
			clearNode(stepChevron);
			append(stepChevron, $('span' + ThemeIcon.asCSSSelector(isStepExpanded ? Codicon.chevronDown : Codicon.chevronRight)));
		};

		const d = step.details || {};

		const attachTraceCopyBtn = (titleRow: HTMLElement, btnLabel: string, getText: () => string, toastMsg: string) => {
			const copyBtn = append(titleRow, $('button.trace-mini-copy-btn', { type: 'button', title: `Copy full ${btnLabel.toLowerCase()}` })) as HTMLButtonElement;
			const copyIcon = append(copyBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy)));
			const copyTxt = append(copyBtn, $('span'));
			copyTxt.textContent = btnLabel;
			copyBtn.onclick = async (e) => {
				e.preventDefault();
				e.stopPropagation();
				const val = getText();
				if (!val) {
					this._notificationService.warn('No content to copy.');
					return;
				}
				await this._clipboardService.writeText(val);
				copyIcon.className = ThemeIcon.asClassName(Codicon.check);
				copyBtn.style.color = '#4ade80';
				copyTxt.textContent = 'Copied!';
				this._notificationService.info(toastMsg);
				setTimeout(() => {
					if (copyBtn.isConnected) {
						copyIcon.className = ThemeIcon.asClassName(Codicon.copy);
						copyBtn.style.color = '';
						copyTxt.textContent = btnLabel;
					}
				}, 1500);
			};
		};

		// 1. Python Primitive Trace
		if (step.fieldType === 'python') {
			if (d.pythonPath || d.exitCode !== undefined) {
				const metaRow = append(body, $('.trace-sub-section'));
				const metaText = append(metaRow, $('span.trace-sub-title'));
				metaText.textContent = `Interpreter: ${d.pythonPath || 'system default'} | Exit Code: ${d.exitCode ?? 0}`;
			}

			if (d.commandLogs) {
				const logSection = append(body, $('.trace-sub-section'));
				const logTitleRow = append(logSection, $('.trace-sub-title-row'));
				const logTitle = append(logTitleRow, $('span.trace-sub-title'));
				append(logTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.terminal)));
				append(logTitle, $('span')).textContent = 'Python Command Line Logs (stdout & stderr)';
				attachTraceCopyBtn(logTitleRow, 'Copy Logs', () => String(d.commandLogs), 'Command logs copied to clipboard.');

				const termBox = append(logSection, $('pre.workflow-trace-term'));
				termBox.textContent = String(d.commandLogs).trim();
			}

			if (d.result !== undefined) {
				const resSection = append(body, $('.trace-sub-section'));
				const resTitleRow = append(resSection, $('.trace-sub-title-row'));
				const resTitle = append(resTitleRow, $('span.trace-sub-title'));
				append(resTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.pass)));
				append(resTitle, $('span')).textContent = 'Pure Return Value (OUTPUT)';
				const fullResText = typeof d.result === 'object' && d.result !== null ? JSON.stringify(d.result, null, 2) : String(d.result);
				attachTraceCopyBtn(resTitleRow, 'Copy Output', () => fullResText, 'Pure Return Value (OUTPUT) copied to clipboard.');

				const resPre = append(resSection, $('pre.workflow-trace-pre'));
				resPre.textContent = fullResText;
			}

			if (d.executedCode) {
				const codeSection = append(body, $('.trace-sub-section'));
				const codeDetails = append(codeSection, $('details.trace-code-details'));
				const summary = append(codeDetails, $('summary.trace-code-summary'));
				summary.textContent = 'View Executed Python Code';
				const codeHeaderRow = append(codeDetails, $('.trace-sub-title-row'));
				append(codeHeaderRow, $('span.trace-sub-title')).textContent = 'Executed Python Code';
				attachTraceCopyBtn(codeHeaderRow, 'Copy Code', () => String(d.executedCode).trim(), 'Executed Python code copied to clipboard.');
				const codePre = append(codeDetails, $('pre.workflow-trace-code'));
				codePre.textContent = String(d.executedCode).trim();
			}
		}
		// 2. AI Prompt Primitive Trace
		else if (step.fieldType === 'prompt') {
			if (d.sentPrompt || d.rawPrompt) {
				const promptSec = append(body, $('.trace-sub-section'));
				const pTitleRow = append(promptSec, $('.trace-sub-title-row'));
				const pTitle = append(pTitleRow, $('span.trace-sub-title'));
				append(pTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.sparkle)));
				append(pTitle, $('span')).textContent = `Sent Prompt (Model: ${d.model || 'model'}, Provider: ${d.provider || 'auto'})`;
				const fullPrompt = String(d.sentPrompt || d.rawPrompt).trim();
				attachTraceCopyBtn(pTitleRow, 'Copy Prompt', () => fullPrompt, 'Sent prompt copied to clipboard.');
				const pPre = append(promptSec, $('pre.workflow-trace-pre'));
				pPre.textContent = fullPrompt;
			}
			if (d.response) {
				const respSec = append(body, $('.trace-sub-section'));
				const rTitleRow = append(respSec, $('.trace-sub-title-row'));
				const rTitle = append(rTitleRow, $('span.trace-sub-title'));
				append(rTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.commentDiscussion)));
				append(rTitle, $('span')).textContent = 'AI Model Response';
				const fullResp = String(d.response).trim();
				attachTraceCopyBtn(rTitleRow, 'Copy Response', () => fullResp, 'AI Model Response copied to clipboard.');
				const rPre = append(respSec, $('pre.workflow-trace-pre'));
				rPre.textContent = fullResp;
			}
		}
		// 3. Browser Primitive Trace
		else if (step.fieldType === 'browser') {
			if (d.requestedUrl || d.targetUrl) {
				const urlSec = append(body, $('.trace-sub-section'));
				const uTitle = append(urlSec, $('.trace-sub-title'));
				append(uTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.link)));
				append(uTitle, $('span')).textContent = 'Requested URL';
				const linkEl = append(urlSec, $('a.trace-url-link'));
				linkEl.href = String(d.requestedUrl || d.targetUrl);
				linkEl.target = '_blank';
				linkEl.textContent = String(d.requestedUrl || d.targetUrl);
			}
			if (d.content) {
				const cSec = append(body, $('.trace-sub-section'));
				const cTitleRow = append(cSec, $('.trace-sub-title-row'));
				const cTitle = append(cTitleRow, $('span.trace-sub-title'));
				append(cTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.globe)));
				append(cTitle, $('span')).textContent = `Fetched Web Content (${d.contentLength || String(d.content).length} chars)`;
				attachTraceCopyBtn(cTitleRow, 'Copy Content', () => String(d.content), 'Complete fetched web content copied to clipboard.');

				const cPre = append(cSec, $('pre.workflow-trace-pre'));
				cPre.textContent = String(d.content).substring(0, 3000) + (String(d.content).length > 3000 ? '\n... (truncated)' : '');
			}
		}
		// 4. Parameters Primitive Trace
		else if (step.fieldType === 'parameters') {
			if (d.parameters && Object.keys(d.parameters).length > 0) {
				const pSec = append(body, $('.trace-sub-section'));
				const pTitleRow = append(pSec, $('.trace-sub-title-row'));
				const pTitle = append(pTitleRow, $('span.trace-sub-title'));
				append(pTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.gear)));
				append(pTitle, $('span')).textContent = 'Resolved Inputs';
				const fullParams = JSON.stringify(d.parameters, null, 2);
				attachTraceCopyBtn(pTitleRow, 'Copy', () => fullParams, 'Resolved parameters copied to clipboard.');
				const pPre = append(pSec, $('pre.workflow-trace-pre'));
				pPre.textContent = fullParams;
			}
		}
		// 5. Output Manifest Primitive Trace
		else if (step.fieldType === 'output') {
			if (d.aggregatedOutputs && Object.keys(d.aggregatedOutputs).length > 0) {
				const oSec = append(body, $('.trace-sub-section'));
				const oTitleRow = append(oSec, $('.trace-sub-title-row'));
				const oTitle = append(oTitleRow, $('span.trace-sub-title'));
				append(oTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.layers)));
				append(oTitle, $('span')).textContent = 'Aggregated Output Manifest';
				const fullManifest = JSON.stringify(d.aggregatedOutputs, null, 2);
				attachTraceCopyBtn(oTitleRow, 'Copy JSON', () => fullManifest, 'Aggregated Output Manifest copied to clipboard.');
				const oPre = append(oSec, $('pre.workflow-trace-pre'));
				oPre.textContent = fullManifest;
			}
		}
		// 6. Text / Textarea / Description / Single-line Input
		else if (step.fieldType === 'text' || step.fieldType === 'textarea' || step.fieldType === 'string') {
			const tSec = append(body, $('.trace-sub-section'));
			const tTitleRow = append(tSec, $('.trace-sub-title-row'));
			const tTitle = append(tTitleRow, $('span.trace-sub-title'));
			append(tTitle, $('span')).textContent = 'Text Value';
			const fullText = String(d.runtimeValue ?? d.initialValue ?? step.output ?? '(empty)');
			attachTraceCopyBtn(tTitleRow, 'Copy', () => fullText, 'Text value copied to clipboard.');
			const tPre = append(tSec, $('pre.workflow-trace-pre'));
			tPre.textContent = fullText;
			if (d.initialValue && d.runtimeValue && d.initialValue !== d.runtimeValue) {
				const initSpan = append(tSec, $('span.trace-sub-title'));
				initSpan.textContent = `Template: ${d.initialValue}`;
			}
		}
		// 7. Select / Multiselect / Dropdown / Classes / Tags
		else if (step.fieldType === 'select' || step.fieldType === 'multiselect' || step.fieldType === 'options' || step.fieldType === 'classes') {
			const sSec = append(body, $('.trace-sub-section'));
			const sTitle = append(sSec, $('.trace-sub-title'));
			append(sTitle, $('span')).textContent = 'Selected Option(s)';
			const sPre = append(sSec, $('pre.workflow-trace-pre'));
			sPre.textContent = Array.isArray(step.output) ? step.output.join(', ') : String(step.output ?? '(none)');
			if (d.options && Array.isArray(d.options)) {
				const optSpan = append(sSec, $('span.trace-sub-title'));
				optSpan.textContent = `Available Options: ${d.options.map((o: string | { label?: string; value?: string }) => typeof o === 'object' ? (o.label || o.value) : o).join(', ')}`;
			}
		}
		// 8. Number
		else if (step.fieldType === 'number') {
			const nSec = append(body, $('.trace-sub-section'));
			const nTitle = append(nSec, $('.trace-sub-title'));
			append(nTitle, $('span')).textContent = 'Numeric Value';
			const nPre = append(nSec, $('pre.workflow-trace-pre'));
			nPre.textContent = String(step.output ?? 0);
		}
		// 9. Switch / Boolean
		else if (step.fieldType === 'switch' || step.fieldType === 'boolean') {
			const bSec = append(body, $('.trace-sub-section'));
			const bTitle = append(bSec, $('.trace-sub-title'));
			append(bTitle, $('span')).textContent = 'State';
			const bPre = append(bSec, $('pre.workflow-trace-pre'));
			bPre.textContent = Boolean(step.output) ? 'true (enabled)' : 'false (disabled)';
		}
		// 10. Date / Timestamp
		else if (step.fieldType === 'date' || step.fieldType === 'datetime' || step.fieldType === 'timestamp') {
			const dSec = append(body, $('.trace-sub-section'));
			const dTitle = append(dSec, $('.trace-sub-title'));
			append(dTitle, $('span')).textContent = 'Timestamp Value';
			const dPre = append(dSec, $('pre.workflow-trace-pre'));
			dPre.textContent = String(step.output ?? '');
		}
		// 11. Generic Default Fallback (DataTable, HTTP Request, etc.)
		else {
			const gSec = append(body, $('.trace-sub-section'));
			const gTitleRow = append(gSec, $('.trace-sub-title-row'));
			const gTitle = append(gTitleRow, $('span.trace-sub-title'));
			append(gTitle, $('span')).textContent = 'Value';
			const fullGeneric = typeof step.output === 'object' && step.output !== null ? JSON.stringify(step.output, null, 2) : String(step.output ?? '(empty)');
			attachTraceCopyBtn(gTitleRow, 'Copy', () => fullGeneric, 'Step output value copied to clipboard.');
			const gPre = append(gSec, $('pre.workflow-trace-pre'));
			gPre.textContent = fullGeneric;
		}

		if (step.error) {
			const errSec = append(body, $('.trace-sub-section.error'));
			const errTitleRow = append(errSec, $('.trace-sub-title-row'));
			const errTitle = append(errTitleRow, $('span.trace-sub-title.error'));
			append(errTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.error)));
			append(errTitle, $('span')).textContent = 'Step Error';
			attachTraceCopyBtn(errTitleRow, 'Copy Error', () => String(step.error), 'Step error copied to clipboard.');
			const errPre = append(errSec, $('pre.workflow-trace-err'));
			errPre.textContent = step.error;
		}
	}

	private _generateBuildReport(run: IWorkflowExecutionRun): string {
		const lines: string[] = [];
		const sep = '='.repeat(60);

		lines.push(sep);
		lines.push(`ANYAGENT WORKFLOW BUILD REPORT: #${run.runNumber ?? run.runId}`);
		lines.push(`Workflow: ${run.workflowName}`);
		lines.push(`Run ID: ${run.runId}`);
		lines.push(`Status: ${run.status.toUpperCase()}`);
		const durMs = run.durationMs ?? (run.completedAt ? run.completedAt - run.startedAt : 0);
		lines.push(`Duration: ${(durMs / 1000).toFixed(2)}s`);
		lines.push(`Started At: ${new Date(run.startedAt).toLocaleString()}`);
		lines.push(`Trigger: ${run.trigger || 'manual'} | Mode: ${run.mode}`);
		lines.push(sep);
		lines.push('');

		// 1. Chronological Node Execution Path (if present)
		if (run.executionPath && run.executionPath.length > 0) {
			lines.push('--- CHRONOLOGICAL EXECUTION PATH & NODE TRACES ---');
			for (const pStep of run.executionPath) {
				const sDur = pStep.durationMs ? `${(pStep.durationMs / 1000).toFixed(2)}s` : '0s';
				lines.push(`\n[Step #${pStep.stepIndex}] Node: '${pStep.nodeLabel}' (${pStep.nodeType}) | Status: ${pStep.status.toUpperCase()} | Duration: ${sDur}`);
				if (pStep.operations && pStep.operations.length > 0) {
					for (const op of pStep.operations) {
						lines.push(`  • Action: ${op.label}`);
						if (op.type === 'create_ticket' && op.details) {
							if (op.details.ticketId) { lines.push(`    Created Ticket ID: ${op.details.ticketId}`); }
							if (op.details.targetFolder) { lines.push(`    Target Folder: ${op.details.targetFolder}`); }
							if (op.details.parameters) { lines.push(`    Inputs: ${JSON.stringify(op.details.parameters)}`); }
						} else if (op.type === 'set_variable' && op.details) {
							if (op.details.expression) { lines.push(`    Expression: ${op.details.expression}`); }
						} else if (op.type === 'run_ticket' && op.executedTicket) {
							const t = op.executedTicket;
							lines.push(`    Ticket: ${t.ticketName} [${t.ticketType || 'task'}] (${t.status.toUpperCase()})`);
							for (const step of (t.stepResults || [])) {
								const d = step.details || {};
								lines.push(`      - Component: ${step.fieldLabel} [${step.fieldType.toUpperCase()}]`);
								if (step.fieldType === 'python') {
									if (d.commandLogs) { lines.push(`        Python Logs: ${String(d.commandLogs).trim().replace(/\n/g, '\n        ')}`); }
									if (d.result !== undefined) { lines.push(`        OUTPUT: ${JSON.stringify(d.result)}`); }
								} else if (step.fieldType === 'prompt') {
									if (d.sentPrompt) { lines.push(`        Prompt: ${String(d.sentPrompt).trim()}`); }
									if (d.response) { lines.push(`        Response: ${String(d.response).trim()}`); }
								} else if (step.fieldType === 'browser') {
									if (d.requestedUrl) { lines.push(`        URL: ${d.requestedUrl}`); }
								} else {
									lines.push(`        Value: ${typeof step.output === 'object' ? JSON.stringify(step.output) : String(step.output)}`);
								}
							}
						}
					}
				}
				if (pStep.transition) {
					lines.push(`  \u2500\u2500\u25B6 Transition: ${pStep.transition.explanation || pStep.transition.conditionLabel || 'Proceed'}`);
				}
			}
			lines.push('');
		}

		// 2. Executed Tickets & Components (Fallback or summary)
		lines.push('--- EXECUTED TICKETS & COMPONENT TRACES ---');
		const allTickets: { nodeLabel: string; ticket: IExecutedTicketRecord }[] = [];
		for (const [nodeId, nState] of Object.entries(run.nodeStates || {})) {
			if (nState.executedTickets && nState.executedTickets.length > 0) {
				for (const t of nState.executedTickets) {
					allTickets.push({ nodeLabel: nState.nodeLabel || nodeId, ticket: t });
				}
			}
		}

		if (allTickets.length === 0) {
			lines.push('No tickets executed in this build.');
		} else {
			for (let tIdx = 0; tIdx < allTickets.length; tIdx++) {
				const { nodeLabel, ticket } = allTickets[tIdx];
				const tDur = ticket.durationMs ? `${(ticket.durationMs / 1000).toFixed(2)}s` : '0s';
				lines.push(`\n[Ticket #${tIdx + 1}] ${ticket.ticketName || ticket.ticketId} [${ticket.ticketType || 'task'}]`);
				lines.push(`  Node: ${nodeLabel} | Status: ${ticket.status.toUpperCase()} | Duration: ${tDur}`);

				const steps = ticket.stepResults || [];
				if (steps.length === 0) {
					lines.push('  (No primitive component steps recorded)');
				} else {
					for (let sIdx = 0; sIdx < steps.length; sIdx++) {
						const step = steps[sIdx];
						const sDur = step.durationMs ? `${step.durationMs}ms` : '0ms';
						lines.push(`  • Step #${sIdx + 1}: ${step.fieldLabel} [${step.fieldType.toUpperCase()}] (${step.status.toUpperCase()}, ${sDur})`);

						const d = step.details || {};
						if (step.fieldType === 'python') {
							if (d.pythonPath) { lines.push(`    Interpreter: ${d.pythonPath}`); }
							if (d.exitCode !== undefined) { lines.push(`    Exit Code: ${d.exitCode}`); }
							if (d.commandLogs) {
								lines.push(`    --- Python Command Line Logs (stdout & stderr) ---`);
								const logLines = String(d.commandLogs).trim().split('\n');
								for (const ll of logLines) {
									lines.push(`      ${ll}`);
								}
								lines.push(`    --------------------------------------------------`);
							}
							if (d.result !== undefined) {
								const resStr = typeof d.result === 'object' && d.result !== null ? JSON.stringify(d.result, null, 2) : String(d.result);
								lines.push(`    Pure Return Value (OUTPUT):\n      ${resStr.replace(/\n/g, '\n      ')}`);
							}
							if (d.executedCode) {
								lines.push(`    Executed Script:\n      ${String(d.executedCode).trim().replace(/\n/g, '\n      ')}`);
							}
						} else if (step.fieldType === 'prompt') {
							if (d.model) { lines.push(`    Model: ${d.model} (${d.provider || 'auto'})`); }
							if (d.sentPrompt || d.rawPrompt) { lines.push(`    Sent Prompt:\n      ${String(d.sentPrompt || d.rawPrompt).trim().replace(/\n/g, '\n      ')}`); }
							if (d.response) { lines.push(`    AI Response:\n      ${String(d.response).trim().replace(/\n/g, '\n      ')}`); }
						} else if (step.fieldType === 'browser') {
							if (d.requestedUrl || d.targetUrl) { lines.push(`    Requested URL: ${d.requestedUrl || d.targetUrl}`); }
							if (d.content) {
								const preview = String(d.content).substring(0, 500);
								lines.push(`    Fetched Content (${d.contentLength || String(d.content).length} chars):\n      ${preview.replace(/\n/g, '\n      ')}${String(d.content).length > 500 ? '\n      ... (truncated)' : ''}`);
							}
						} else if (step.fieldType === 'parameters') {
							if (d.parameters) { lines.push(`    Resolved Inputs: ${JSON.stringify(d.parameters, null, 2).replace(/\n/g, '\n      ')}`); }
						} else if (step.fieldType === 'output') {
							if (d.aggregatedOutputs) { lines.push(`    Output Manifest: ${JSON.stringify(d.aggregatedOutputs, null, 2).replace(/\n/g, '\n      ')}`); }
						} else {
							const valStr = typeof step.output === 'object' && step.output !== null ? JSON.stringify(step.output, null, 2) : String(step.output ?? '(empty)');
							lines.push(`    Value: ${valStr.replace(/\n/g, '\n      ')}`);
						}

						if (step.error) {
							lines.push(`    ERROR: ${step.error}`);
						}
					}
				}
			}
		}

		// 2. Context Variables Snapshot
		lines.push('');
		lines.push('--- CONTEXT VARIABLES SNAPSHOT ---');
		if (run.contextVariables && Object.keys(run.contextVariables).length > 0) {
			for (const [k, v] of Object.entries(run.contextVariables)) {
				const valStr = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
				lines.push(`  • ${k}: ${valStr}`);
			}
		} else {
			lines.push('  (No context variables)');
		}

		// 3. Execution Event Logs
		lines.push('');
		lines.push('--- EXECUTION EVENT LOGS ---');
		if (run.logs && run.logs.length > 0) {
			for (const l of run.logs) {
				const timeStr = new Date(l.timestamp).toLocaleTimeString();
				const nodeStr = l.nodeId ? ` [${l.nodeId}]` : '';
				lines.push(`  [${timeStr}] [${l.level.toUpperCase()}]${nodeStr} ${l.message}`);
			}
		} else {
			lines.push('  (No execution logs)');
		}

		lines.push('');
		lines.push(sep);
		return lines.join('\n');
	}

	/** The scrolling viewport of the canvas (canvas → zoom sizer → wrapper). */
	private _canvasScroller(): HTMLElement | undefined {
		return (this._canvas?.closest('.workflow-editor-canvas-wrapper') as HTMLElement | null) ?? undefined;
	}

	private _centerOnNode(node: IFlowchartNode): void {
		const wrapper = this._canvasScroller();
		if (!wrapper) { return; }
		const targetX = (node.x + node.width / 2) * this._zoomLevel - wrapper.clientWidth / 2;
		const targetY = (node.y + node.height / 2) * this._zoomLevel - wrapper.clientHeight / 2;
		wrapper.scrollTo({
			left: Math.max(0, targetX),
			top: Math.max(0, targetY),
			behavior: 'smooth'
		});
	}

	private _appendLogEntry(log: IWorkflowLogEntry, shouldScroll = true): void {
		if (!this._logBodyEl) { return; }
		const line = append(this._logBodyEl, $(`.workflow-log-line.level-${log.level}`));
		const timeStr = new Date(log.timestamp).toLocaleTimeString();
		const timeEl = append(line, $('.log-time'));
		timeEl.textContent = `[${timeStr}]`;
		const levelBadge = append(line, $(`.log-badge.badge-${log.level}`));
		levelBadge.textContent = log.level.toUpperCase();
		let nodeBadge: HTMLElement | undefined;
		if (log.nodeId) {
			const node = this._data?.nodes.find(n => n.id === log.nodeId);
			nodeBadge = append(line, $('.log-node'));
			nodeBadge.textContent = `[${node?.label || log.nodeId}]`;
		}
		const rawMsg = log.message || '';
		const msgEl = append(line, $('.log-msg'));
		msgEl.textContent = rawMsg.length > 1200 ? rawMsg.substring(0, 1200) + ' ... [truncated]' : rawMsg;
		wfLogLineParts.set(line, { time: timeEl, badge: levelBadge, node: nodeBadge, msg: msgEl });

		if (this._logCountBadgeEl) {
			const count = this._logBodyEl.children.length;
			this._logCountBadgeEl.textContent = `${count} events`;
		}

		if (shouldScroll && this._autoScrollLogs) {
			this._logBodyEl.scrollTop = this._logBodyEl.scrollHeight;
		}
	}

	private _renderLogDrawer(parent: HTMLElement): void {
		const drawer = append(parent, $('.workflow-log-drawer'));
		this._logDrawerEl = drawer;
		this._logDrawerParts = undefined;
		drawer.style.height = `${this._drawerHeight}px`;
		if (!this._isLogDrawerOpen) {
			drawer.style.display = 'none';
		}

		// Top Resizer Bar (allows dragging up/down to resize bottom panel)
		const resizer = append(drawer, $('.workflow-log-resizer'));
		resizer.title = localize('resizeDrawerTooltip', 'Drag up or down to resize bottom panel');
		resizer.onmousedown = (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			this._isDrawerResizing = true;
			this._drawerResizeStartY = e.clientY;
			this._drawerResizeStartHeight = drawer.offsetHeight || this._drawerHeight;
			drawer.classList.add('resizing');
		};

		// Header Tabs (Logs vs Variables)
		const header = append(drawer, $('.workflow-log-header'));
		const left = append(header, $('.log-header-left'));

		const tabs = append(left, $('.drawer-tabs'));

		const logsTab = append(tabs, $(`.drawer-tab${this._activeDrawerTab === 'logs' ? '.active' : ''}`));
		append(logsTab, $('span' + ThemeIcon.asCSSSelector(Codicon.output)));
		append(logsTab, $('span')).textContent = localize('logConsole', 'Execution Logs');
		this._logStatusBadgeEl = append(logsTab, $('.log-status-badge.status-idle'));
		this._logStatusBadgeEl.textContent = 'IDLE';
		this._logCountBadgeEl = append(logsTab, $('.log-count-badge'));
		this._logCountBadgeEl.textContent = '0 events';

		const varsTab = append(tabs, $(`.drawer-tab${this._activeDrawerTab === 'vars' ? '.active' : ''}`));
		const vTabBadge = append(varsTab, $('.var-icon-badge'));
		vTabBadge.textContent = '[V]';
		append(varsTab, $('span')).textContent = localize('contextVarsTitle', 'Context Variables');
		this._varsCountBadgeEl = append(varsTab, $('.drawer-tab-badge'));
		const varCount = (this._data?.nodes || []).reduce((acc, n) => acc + this._getNodeVariables(n).length, 0);
		this._varsCountBadgeEl.textContent = `${varCount} vars`;

		const historyTab = append(tabs, $(`.drawer-tab${this._activeDrawerTab === 'history' ? '.active' : ''}`));
		append(historyTab, $('span' + ThemeIcon.asCSSSelector(Codicon.history)));
		append(historyTab, $('span')).textContent = localize('runHistoryTitle', 'History');
		this._historyCountBadgeEl = append(historyTab, $('.drawer-tab-badge'));
		const runsCount = this._workflowUri ? this._workflowExecutionService.getRunsForWorkflow(this._workflowUri).length : 0;
		this._historyCountBadgeEl.textContent = `${runsCount} run${runsCount === 1 ? '' : 's'}`;

		logsTab.onclick = () => {
			this._switchDrawerTab('logs');
		};
		varsTab.onclick = () => {
			this._switchDrawerTab('vars');
		};
		historyTab.onclick = () => {
			this._switchDrawerTab('history');
		};

		const right = append(header, $('.log-header-right'));
		// Reset Execution Button (Selected Nodes Only when nodes are selected, or Global Reset when none selected)
		const resetBtn = append(right, $('.log-btn-icon'));
		resetBtn.title = localize('resetExecutionTooltip', 'Reset Workflow Execution (Selected nodes only when selected, or full workflow when none selected)');
		append(resetBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.debugRestart)));
		resetBtn.onclick = () => {
			this._handleResetWorkflowExecution();
		};

		// Clear Logs Button (only visible in Execution Logs tab)
		const clearBtn = append(right, $('.log-btn-icon.log-clear-btn'));
		clearBtn.title = localize('clearLogsTooltip', 'Clear Execution Logs');
		append(clearBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.clearAll)));
		clearBtn.onclick = () => {
			if (this._logBodyEl) {
				clearNode(this._logBodyEl);
			}
			if (this._logCountBadgeEl) {
				this._logCountBadgeEl.textContent = '0 events';
			}
		};

		// Copy All Logs Button (only visible in Execution Logs tab)
		const copyLogsBtn = append(right, $('.log-btn-icon.log-copy-btn'));
		copyLogsBtn.title = localize('copyLogsTooltip', 'Copy All Execution Logs (Clipboard)');
		append(copyLogsBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy)));
		copyLogsBtn.onclick = async () => {
			if (!this._logBodyEl) { return; }
			const lines = Array.from(this._logBodyEl.children).flatMap(child => {
				const parts = wfLogLineParts.get(child);
				return parts ? [parts] : [];
			});
			if (lines.length === 0) {
				this._notificationService.info(localize('noLogsToCopy', 'No execution logs to copy.'));
				return;
			}
			const lineTexts: string[] = [];
			for (const line of lines) {
				const time = line.time.textContent?.trim() || '';
				const badge = line.badge.textContent?.trim() || '';
				const node = line.node?.textContent?.trim() || '';
				const msg = line.msg.textContent || '';
				const parts = [time, badge, node, msg].filter(Boolean);
				lineTexts.push(parts.join(' '));
			}
			const text = lineTexts.length > 0 ? lineTexts.join('\n') : (this._logBodyEl.innerText || this._logBodyEl.textContent || '');

			let ok = false;
			try {
				await this._clipboardService.writeText(text);
				ok = true;
			} catch { }
			if (!ok) {
				try {
					if (navigator?.clipboard?.writeText) {
						await navigator.clipboard.writeText(text);
						ok = true;
					}
				} catch { }
			}
			if (!ok) {
				try {
					const ta = document.createElement('textarea');
					ta.value = text;
					ta.style.position = 'fixed';
					ta.style.left = '-9999px';
					ta.style.top = '-9999px';
					this._targetWindow.document.body.appendChild(ta);
					ta.focus();
					ta.select();
					ok = this._targetWindow.document.execCommand('copy');
					ta.remove();
				} catch { }
			}

			if (ok) {
				clearNode(copyLogsBtn);
				append(copyLogsBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.check)));
				copyLogsBtn.style.color = '#10b981';
				this._notificationService.info(localize('logsCopied', 'All execution logs copied to clipboard.'));
				setTimeout(() => {
					if (copyLogsBtn.isConnected) {
						clearNode(copyLogsBtn);
						append(copyLogsBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy)));
						copyLogsBtn.style.color = '';
					}
				}, 1500);
			} else {
				this._notificationService.error(localize('copyFailed', 'Failed to copy logs to clipboard.'));
			}
		};

		// Find & Replace Button (only visible in Context Variables tab)
		const findReplaceBtn = append(right, $('.log-btn-icon.vars-find-replace-toggle-btn'));
		this._logDrawerParts = { tabs: [logsTab, varsTab, historyTab], clearBtn, copyLogsBtn, findReplaceToggleBtn: findReplaceBtn };
		findReplaceBtn.title = localize('findReplaceVarsTooltip', 'Find & Replace Variable Names (Ctrl/Cmd+R)');
		append(findReplaceBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.replace)));
		findReplaceBtn.onclick = () => {
			this._toggleVarsFindReplaceBar();
		};

		// Close Button
		const closeBtn = append(right, $('.log-btn-icon'));
		closeBtn.title = localize('closeDrawerTooltip', 'Close Bottom Panel');
		append(closeBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
		closeBtn.onclick = () => {
			this._closeLogDrawer();
		};

		// Body 1: Execution Logs
		this._logBodyEl = append(drawer, $('.workflow-log-body'));

		// Body 2: Context Variables Table
		this._varsBodyEl = append(drawer, $('.workflow-vars-body'));

		// Body 3: Run History & Trace Inspector
		this._historyBodyEl = append(drawer, $('.workflow-history-body'));

		this._switchDrawerTab(this._activeDrawerTab);
	}

	private _clearNodeComponentsExecutionData(node: IFlowchartNode): void {
		if (!Array.isArray(node.pipeline)) {
			return;
		}
		for (const step of node.pipeline) {
			const comp = wfComponent(step?.component);
			if (!comp) { continue; }
			delete comp.lastExecutionOutput;
			delete comp.lastExecutionLog;
			delete comp.lastExecutionStatus;
			delete comp.lastExecutionDurationMs;
			delete comp.lastExecutedAt;
			delete comp.lastExecutionExitCode;
			delete comp.lastExecutionInputs;
			delete comp.lastSentPrompt;
			delete comp.pythonOutput;
			delete comp.pythonResult;
			delete comp.pythonStructuredData;
			delete comp.structuredData;
			delete comp.debugPromptOutput;
			delete comp.debugSqlOutput;
			delete comp.debugOutput;
		}
		const schemaInput = this._nodeEditorInputsByNodeId.get(node.id);
		if (schemaInput && !schemaInput.isDisposed() && schemaInput.draftModule) {
			const updatedNodeFields: ICustomField[] = node.pipeline
				.filter(st => !!st.component)
				.map(st => st.component!);
			schemaInput.draftModule.fields = [
				{ id: 'title', label: 'Title', type: 'text', required: true },
				...updatedNodeFields
			];
			schemaInput.notifyExternalDraftUpdated();
		}
	}

	private _collectNodeProducedVariableNames(node: IFlowchartNode): string[] {
		const vars = new Set<string>();
		const add = (raw?: string) => {
			const clean = (raw || '').trim().replace(/^@/, '');
			if (clean) { vars.add(clean); }
		};
		for (const v of (node.outputVariables || [])) {
			add(v.name);
		}
		if (node.outputVariable?.name) {
			add(node.outputVariable.name);
		}
		for (const st of (node.pipeline || [])) {
			add(st.targetVariable);
			if (st.component) {
				if (st.component.type !== 'parameters') {
					add(st.component.outputVariableName);
					add(st.component.label);
				}
			}
			if (st.expression) {
				for (const rawLine of st.expression.split('\n')) {
					if (/^\s/.test(rawLine)) { continue; }
					const m = rawLine.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=(?!=)/);
					if (m && m[1]) { add(m[1]); }
				}
			}
		}
		return Array.from(vars);
	}

	private _handleResetWorkflowExecution(toolbarParent?: HTMLElement): void {
		if (!this._workflowUri) { return; }
		const selectedIds = Array.from(this._selectedNodeIds).filter(id =>
			(this._data?.nodes || []).some(n => n.id === id)
		);

		if (selectedIds.length > 0) {
			// Selective Node Reset: clear ONLY selected nodes' execution data & produced variables; keep all other nodes intact!
			const varsToClear = new Set<string>();
			for (const nid of selectedIds) {
				const node = this._data.nodes.find(n => n.id === nid);
				if (!node) { continue; }
				this._clearNodeComponentsExecutionData(node);
				for (const vn of this._collectNodeProducedVariableNames(node)) {
					varsToClear.add(vn);
				}
			}
			this._workflowExecutionService.resetNodes(this._workflowUri, selectedIds, Array.from(varsToClear));
			this._saveFlowchartData(true);
			const tb = toolbarParent || this._toolbarEl;
			if (tb) {
				this._renderToolbar(tb);
			}
			this._renderNodes();
			this._drawLinks();
			this._refreshVariablesDrawer();
			this._notificationService.info(
				localize('workflowSelectiveResetInfo', 'Reset execution data for {0} selected node(s). Other nodes preserved.', selectedIds.length)
			);
			return;
		}

		// Global Reset (no nodes selected): clear ALL nodes' execution data, context variables, highlights, and display cards
		for (const node of (this._data?.nodes || [])) {
			this._clearNodeComponentsExecutionData(node);
		}
		this._workflowExecutionService.resetWorkflow(this._workflowUri);
		this._saveFlowchartData(true);
		const tb = toolbarParent || this._toolbarEl;
		if (tb) {
			this._renderToolbar(tb);
		}
		this._renderNodes();
		this._drawLinks();
		if (this._logStatusBadgeEl) {
			this._logStatusBadgeEl.textContent = 'IDLE';
			this._logStatusBadgeEl.className = 'log-status-badge status-idle';
		}
		if (this._logCountBadgeEl) {
			this._logCountBadgeEl.textContent = '0 events';
		}
		if (this._logBodyEl) {
			clearNode(this._logBodyEl);
		}
		this._refreshVariablesDrawer();
		this._notificationService.info(localize('workflowResetInfo', 'All workflow execution data reset to IDLE.'));
	}

	private _renderToolbar(parent: HTMLElement): void {
		clearNode(parent);
		// Items that get the instant floating tooltip below (`.workflow-toolbar-item` / `.workflow-format-btn`), in document order.
		const toolbarTooltipItems: HTMLElement[] = [];

		// Header with Title & Mode Toggle Button
		const header = append(parent, $('.workflow-toolbar-header'));
		if (!this._isToolbarCompact) {
			const title = append(header, $('.workflow-toolbar-main-title'));
			title.textContent = 'TOOLBOX';
			title.title = 'Shapes & Drawing Toolbox';
		}

		const toggleBtn = append(header, $('.workflow-toolbar-toggle-btn'));
		append(toggleBtn, $('span' + ThemeIcon.asCSSSelector(this._isToolbarCompact ? Codicon.chevronRight : Codicon.chevronLeft)));
		toggleBtn.title = this._isToolbarCompact ? 'Expand Toolbox (Double Column)' : 'Compact Toolbox (Single Column)';
		toggleBtn.onclick = (e) => {
			e.stopPropagation();
			this._isToolbarCompact = !this._isToolbarCompact;
			this._storageService.store('workflowEditor.toolbarCompact', this._isToolbarCompact, StorageScope.PROFILE, StorageTarget.USER);
			if (this._isToolbarCompact) {
				parent.classList.add('compact');
			} else {
				parent.classList.remove('compact');
			}
			this._renderToolbar(parent);
		};

		// Section 0: Workflow Execution Controls
		const execSec = append(parent, $('.workflow-toolbar-section.execution-section'));
		if (!this._isToolbarCompact) {
			const execTitle = append(execSec, $('.workflow-toolbar-title'));
			execTitle.textContent = localize('execution', 'Workflow Execution');
		}

		const activeRun = this._workflowUri ? this._workflowExecutionService.getActiveRun(this._workflowUri) : undefined;
		const isRunning = activeRun && (activeRun.status === 'running' || activeRun.status === 'waiting_human' || activeRun.status === 'paused');

		const execGrid = append(execSec, $(`.workflow-shape-grid${this._isToolbarCompact ? '.compact-1col' : ''}`));

		// 1. Run Button (Standard Mode)
		const runBtn = append(execGrid, $(`.workflow-toolbar-item.exec-btn${this._isToolbarCompact ? '.compact-item' : ''}`));
		toolbarTooltipItems.push(runBtn);
		runBtn.setAttribute('data-role', 'workflow-run-btn');
		runBtn.title = isRunning ? 'Workflow executing...' : 'Run Workflow (Select 1 node to run from that node onward, or Cmd/Ctrl/Shift+Click multiple nodes to run only selected nodes)';
		append(runBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.play)));
		if (!this._isToolbarCompact) {
			const runLabel = append(runBtn, $('.item-label'));
			runLabel.textContent = (isRunning && !activeRun?.fullSpeed) ? 'Running' : 'Run';
			wfToolbarItemLabels.set(runBtn, runLabel);
		}
		if (isRunning && !activeRun?.fullSpeed) {
			runBtn.classList.add('active');
		}
		runBtn.onmousedown = (e) => {
			e.stopPropagation();
		};
		runBtn.onclick = async () => {
			if (!this._workflowUri) { return; }
			try {
				const { entryNodeId, selectedNodeIds } = this._resolveExecutionOptionsForRun(false);
				this._openLogDrawer();
				this._clearDisplayInspectorCards();
				await this._workflowExecutionService.executeWorkflow(this._workflowUri, {
					mode: 'standard',
					fullSpeed: false,
					initialData: this._data,
					entryNodeId,
					selectedNodeIds
				});
				this._renderToolbar(parent);
				this._renderNodes();
			} catch (e) {
				this._notificationService.error(e.message || String(e));
			}
		};

		// 1b. Run at Full Speed Button (Independent Full-Speed Mode)
		const fullSpeedBtn = append(execGrid, $(`.workflow-toolbar-item.exec-btn.full-speed-btn${this._isToolbarCompact ? '.compact-item' : ''}`));
		toolbarTooltipItems.push(fullSpeedBtn);
		fullSpeedBtn.setAttribute('data-role', 'workflow-full-speed-run-btn');
		fullSpeedBtn.title = isRunning ? 'Workflow executing...' : 'Run at Full Speed (Execute workflow at maximum speed without artificial delays)';
		append(fullSpeedBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.zap)));
		if (!this._isToolbarCompact) {
			const fullSpeedLabel = append(fullSpeedBtn, $('.item-label'));
			fullSpeedLabel.textContent = (isRunning && activeRun?.fullSpeed) ? 'Running' : 'Full Speed';
			wfToolbarItemLabels.set(fullSpeedBtn, fullSpeedLabel);
		}
		if (isRunning && activeRun?.fullSpeed) {
			fullSpeedBtn.classList.add('active');
		}
		wfToolbarRunButtons.set(parent, { runBtn, fullSpeedBtn });
		this._updateRunButtonSelectionBadge(runBtn, fullSpeedBtn);
		fullSpeedBtn.onmousedown = (e) => {
			e.stopPropagation();
		};
		fullSpeedBtn.onclick = async () => {
			if (!this._workflowUri) { return; }
			try {
				const { entryNodeId, selectedNodeIds } = this._resolveExecutionOptionsForRun(false);
				this._openLogDrawer();
				this._clearDisplayInspectorCards();
				await this._workflowExecutionService.executeWorkflow(this._workflowUri, {
					mode: 'standard',
					fullSpeed: true,
					initialData: this._data,
					entryNodeId,
					selectedNodeIds
				});
				this._renderToolbar(parent);
				this._renderNodes();
			} catch (e) {
				this._notificationService.error(e.message || String(e));
			}
		};

		// 2. Step Button
		const stepBtn = append(execGrid, $(`.workflow-toolbar-item.exec-btn${this._isToolbarCompact ? '.compact-item' : ''}`));
		toolbarTooltipItems.push(stepBtn);
		stepBtn.title = 'Step Next Node (starts from selected node when beginning a new run)';
		append(stepBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.debugStepOver)));
		if (!this._isToolbarCompact) {
			append(stepBtn, $('.item-label')).textContent = 'Step';
		}
		stepBtn.onmousedown = (e) => {
			e.stopPropagation();
		};
		stepBtn.onclick = async () => {
			if (!this._workflowUri) { return; }
			try {
				const { entryNodeId, selectedNodeIds } = this._resolveExecutionOptionsForRun(true);
				this._openLogDrawer();
				const activeRun = this._workflowExecutionService.getActiveRun(this._workflowUri);
				if (!activeRun || activeRun.status === 'completed' || activeRun.status === 'failed' || activeRun.status === 'stopped' || activeRun.status === 'idle') {
					this._clearDisplayInspectorCards();
				}
				await this._workflowExecutionService.stepWorkflow(this._workflowUri, {
					initialData: this._data,
					entryNodeId,
					selectedNodeIds
				});
				this._renderToolbar(parent);
				this._renderNodes();
			} catch (e) {
				this._notificationService.error(e.message || String(e));
			}
		};

		// 3. Pause / Resume Button
		if (isRunning) {
			const pauseBtn = append(execGrid, $(`.workflow-toolbar-item.exec-btn${this._isToolbarCompact ? '.compact-item' : ''}`));
			toolbarTooltipItems.push(pauseBtn);
			pauseBtn.title = activeRun.status === 'paused' ? 'Resume Workflow' : 'Pause Workflow';
			append(pauseBtn, $('span' + ThemeIcon.asCSSSelector(activeRun.status === 'paused' ? Codicon.debugContinue : Codicon.debugPause)));
			if (!this._isToolbarCompact) {
				append(pauseBtn, $('.item-label')).textContent = activeRun.status === 'paused' ? 'Resume' : 'Pause';
			}
			pauseBtn.onclick = async () => {
				if (activeRun.status === 'paused') {
					await this._workflowExecutionService.resumeWorkflow(activeRun.runId);
				} else {
					await this._workflowExecutionService.pauseWorkflow(activeRun.runId);
				}
				this._renderToolbar(parent);
				this._renderNodes();
			};

			// 4. Stop Button
			const stopBtn = append(execGrid, $(`.workflow-toolbar-item.exec-btn${this._isToolbarCompact ? '.compact-item' : ''}`));
			toolbarTooltipItems.push(stopBtn);
			stopBtn.title = 'Stop Workflow';
			append(stopBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.debugStop)));
			if (!this._isToolbarCompact) {
				append(stopBtn, $('.item-label')).textContent = 'Stop';
			}
			stopBtn.onclick = async () => {
				if (this._logStatusBadgeEl) {
					this._logStatusBadgeEl.textContent = 'STOPPING...';
					this._logStatusBadgeEl.className = 'log-status-badge status-stopped';
				}
				await this._workflowExecutionService.stopWorkflow(activeRun.runId);
				this._renderToolbar(parent);
				this._renderNodes();
				this._drawLinks();
			};
		}

		// 5. Execution Console & Variables Drawer Toggle Button
		const logsBtn = append(execGrid, $(`.workflow-toolbar-item.exec-btn${this._isToolbarCompact ? '.compact-item' : ''}`));
		toolbarTooltipItems.push(logsBtn);
		logsBtn.title = localize('logsConsoleTitle', 'Execution Console & Variables Drawer');
		append(logsBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.output)));
		if (!this._isToolbarCompact) {
			append(logsBtn, $('.item-label')).textContent = 'Logs';
		}
		if (this._isLogDrawerOpen) {
			logsBtn.classList.add('active');
		}
		logsBtn.onclick = () => {
			if (this._isLogDrawerOpen) {
				this._closeLogDrawer();
			} else {
				this._openDrawerTab('logs');
			}
		};

		// 6. Reset Execution Button (Selected Nodes Only when nodes are selected, or Global Reset when none selected)
		const resetBtn = append(execGrid, $(`.workflow-toolbar-item.exec-btn${this._isToolbarCompact ? '.compact-item' : ''}`));
		toolbarTooltipItems.push(resetBtn);
		const selCountForReset = this._selectedNodeIds.size;
		resetBtn.title = selCountForReset > 0
			? localize('resetSelectedNodesTitle', 'Reset Execution for {0} Selected Node(s) (keeps all other nodes intact)', selCountForReset)
			: localize('resetWorkflowTitle', 'Reset All Workflow Execution Data (select nodes first to reset only selected nodes)');
		append(resetBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.debugRestart)));
		if (!this._isToolbarCompact) {
			append(resetBtn, $('.item-label')).textContent = selCountForReset > 0 ? `Reset (${selCountForReset})` : 'Reset';
		}
		resetBtn.onclick = () => {
			this._handleResetWorkflowExecution(parent);
		};

		if (this._isToolbarCompact) {
			append(parent, $('.workflow-compact-divider'));
		}

		// Section A: Drag Shapes
		const shapeSec = append(parent, $('.workflow-toolbar-section'));
		if (!this._isToolbarCompact) {
			const shapeTitle = append(shapeSec, $('.workflow-toolbar-title'));
			shapeTitle.textContent = localize('shapes', 'Drag / Click Shapes');
		}

		const shapesGrid = append(shapeSec, $(`.workflow-shape-grid${this._isToolbarCompact ? '.compact-1col' : ''}`));
		const shapeTypes: { type: IFlowchartNode['type']; label: string; previewClass: string }[] = [
			{ type: 'round-rect', label: 'Round Rect', previewClass: 'round-rect' },
			{ type: 'rect', label: 'Rectangle', previewClass: 'rect' },
			{ type: 'diamond', label: 'Decision', previewClass: 'diamond' },
			{ type: 'circle', label: 'Circle Node', previewClass: 'circle' }
		];

		for (const st of shapeTypes) {
			const item = append(shapesGrid, $(`.workflow-toolbar-item${this._isToolbarCompact ? '.compact-item' : ''}`));
			toolbarTooltipItems.push(item);
			item.setAttribute('draggable', 'true');
			item.title = `${st.label} (Drag or Click to add)`;
			item.ondragstart = (e: DragEvent) => {
				e.dataTransfer?.setData('text/plain', JSON.stringify({ type: st.type, label: st.label }));
				if (e.dataTransfer) {
					e.dataTransfer.effectAllowed = 'copy';
				}
			};

			append(item, $(`.item-preview.${st.previewClass}`));
			if (!this._isToolbarCompact) {
				append(item, $('.item-label')).textContent = st.label;
			}

			item.onclick = () => {
				this._addNewNode(st.type, st.label);
			};
		}

		// Section: Python & Built-in Steps (Dedicated section for classic inline Python Step capsule)
		const pyStepSec = append(parent, $('.workflow-toolbar-section.variables-section'));
		if (!this._isToolbarCompact) {
			const pyStepTitle = append(pyStepSec, $('.workflow-toolbar-title'));
			pyStepTitle.textContent = localize('pythonCodingSteps', 'Python & Built-in Steps');
		}
		const pyStepGrid = append(pyStepSec, $('.workflow-shape-grid.compact-1col'));
		const pyStepItem = append(pyStepGrid, $(`.workflow-toolbar-item.function-toolbar-item${this._isToolbarCompact ? '.compact-item' : ''}`));
		toolbarTooltipItems.push(pyStepItem);
		pyStepItem.setAttribute('draggable', 'true');
		this._attachToolboxInstantTooltip(
			pyStepItem,
			localize('pyLabel', 'Python Step'),
			'Classic inline Python capsule (Variables, CREATE_TICKETS, RUN_TICKETS, GET_OUTPUTS, DISPLAY, expressions). Drag onto node to inject capsule.',
			'#38bdf8'
		);
		pyStepItem.ondragstart = (e: DragEvent) => {
			e.dataTransfer?.setData('text/plain', JSON.stringify({ kind: 'function_widget' }));
			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'copy';
			}
		};
		const pyStepBadge = append(pyStepItem, $('span.fn-icon-badge' + ThemeIcon.asCSSSelector(Codicon.python)));
		pyStepBadge.style.fontSize = '14px';
		if (!this._isToolbarCompact) {
			append(pyStepItem, $('.item-label')).textContent = localize('pyLabel', 'Python Step');
		}
		pyStepItem.onclick = () => {
			if (this._selectedNodeIds.size === 1) {
				const selectedId = Array.from(this._selectedNodeIds)[0];
				const targetNode = this._data.nodes.find(n => n.id === selectedId);
				if (targetNode) {
					if (!targetNode.pipeline || targetNode.pipeline.length === 0) {
						this._syncFromNode(targetNode, true);
					}
					if (!targetNode.pipeline) {
						targetNode.pipeline = [];
					}
					const newStep: INodePipelineStep = {
						id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
						type: 'call_function',
						functionName: 'PYTHON',
						expression: ''
					};
					targetNode.pipeline.push(newStep);
					this._ensureNodeFitsPipeline(targetNode);
					this._syncToNode(targetNode, true);
					this._saveFlowchartData();
					this._renderNodes();
					this._drawLinks();
					if (this._inspectorEl) { this._renderInspector(this._inspectorEl); }
					if (this._pipelinePanelEl && this._activePipelineNodeId === targetNode.id) {
						this._renderPipelinePanel(this._pipelinePanelEl, targetNode);
					}
					setTimeout(() => {
						const pills = this._getNodeDom(targetNode.id)?.pills;
						const lastPill = pills && pills.length > 0 ? pills[pills.length - 1] : undefined;
						this._openNodeFunctionInlineEditor(targetNode, newStep, lastPill);
					}, 50);
				}
			} else {
				this._notificationService.info(localize('dragPythonStepHint', 'Select a node first or drag "Python Step" onto any node in the flowchart.'));
			}
		};

		if (this._isToolbarCompact) {
			append(parent, $('.workflow-compact-divider'));
		}

		// Section: Node Components (Template & Built-in Components)
		const varSec = append(parent, $('.workflow-toolbar-section.variables-section'));
		if (!this._isToolbarCompact) {
			const varTitle = append(varSec, $('.workflow-toolbar-title'));
			varTitle.textContent = localize('nodeComponentsTitle', 'Node Components');
		}

		const varGrid = append(varSec, $(`.workflow-shape-grid${this._isToolbarCompact ? '.compact-1col' : ''}`));
		// Generated from the component registry (CI-30)
		const nodeComponentPalette = getNodeComponentPalette();

		for (const itemDef of nodeComponentPalette) {
			const fnItem = append(varGrid, $(`.workflow-toolbar-item.function-toolbar-item.node-component-palette-item${this._isToolbarCompact ? '.compact-item' : ''}`));
			toolbarTooltipItems.push(fnItem);
			fnItem.setAttribute('draggable', 'true');
			this._attachToolboxInstantTooltip(fnItem, itemDef.label, itemDef.desc, itemDef.accent);
			fnItem.ondragstart = (e: DragEvent) => {
				e.dataTransfer?.setData('text/plain', JSON.stringify({ kind: 'node_component', compType: itemDef.compType }));
				if (e.dataTransfer) {
					e.dataTransfer.effectAllowed = 'copy';
				}
			};

			const fnBoxBadge = append(fnItem, $('span.fn-icon-badge' + ThemeIcon.asCSSSelector(itemDef.icon)));
			fnBoxBadge.style.fontSize = itemDef.compType === 'python' ? '11px' : '14px';
			fnBoxBadge.style.color = itemDef.accent;
			if (itemDef.compType === 'python') {
				fnBoxBadge.style.border = '1.5px solid currentColor';
				fnBoxBadge.style.borderRadius = '3.5px';
				fnBoxBadge.style.padding = '2px 3px';
				fnBoxBadge.style.background = 'transparent';
				fnBoxBadge.style.lineHeight = '1';
			}
			if (!this._isToolbarCompact) {
				const lbl = append(fnItem, $('.item-label'));
				lbl.textContent = itemDef.label;
			}
			fnItem.onclick = () => {
				if (this._selectedNodeIds.size === 1) {
					const selectedId = Array.from(this._selectedNodeIds)[0];
					const targetNode = this._data.nodes.find(n => n.id === selectedId);
					if (targetNode) {
						this._addOrOpenComponentOnNode(targetNode, itemDef.compType);
					}
				} else {
					this._notificationService.info(localize('dragComponentHint', 'Select a node first or drag "{0}" onto any node in the flowchart.', itemDef.label));
				}
			};
		}

		// Divider for compact mode
		if (this._isToolbarCompact) {
			append(parent, $('.workflow-compact-divider'));
		}

		// Section B: Link Styling
		const linkSec = append(parent, $('.workflow-toolbar-section'));
		if (!this._isToolbarCompact) {
			const linkTitle = append(linkSec, $('.workflow-toolbar-title'));
			linkTitle.textContent = localize('linkStyle', 'Connection Styles');
		}

		const linksGrid = append(linkSec, $(`.workflow-shape-grid${this._isToolbarCompact ? '.compact-1col' : ''}`));
		const linkStyles: { style: IFlowchartLink['style']; label: string; previewClass: string }[] = [
			{ style: 'arrow-single', label: 'Single Arrow', previewClass: 'line-preview' },
			{ style: 'arrow-double', label: 'Double Arrow', previewClass: 'line-preview' },
			{ style: 'arrow-none', label: 'No Arrow', previewClass: 'line-preview' },
			{ style: 'dashed', label: 'Dashed Line', previewClass: 'dashed-preview' }
		];

		const linkItemBtns: HTMLElement[] = [];
		for (const ls of linkStyles) {
			const item = append(linksGrid, $(`.workflow-toolbar-item${this._isToolbarCompact ? '.compact-item' : ''}${ls.style === this._activeLinkStyle ? '.active' : ''}`));
			toolbarTooltipItems.push(item);
			item.title = ls.label;
			const line = append(item, $(`.item-preview.${ls.previewClass}`));
			if (ls.style === 'arrow-single' || ls.style === 'arrow-double') {
				line.style.borderRight = '3px solid var(--vscode-foreground, #cccccc)';
			}
			if (!this._isToolbarCompact) {
				append(item, $('.item-label')).textContent = ls.label;
			}

			linkItemBtns.push(item);
			item.onclick = () => {
				this._activeLinkStyle = ls.style;
				this._storageService.store('workflowEditor.linkStyle', this._activeLinkStyle, StorageScope.PROFILE, StorageTarget.USER);
				linkItemBtns.forEach(btn => btn.classList.remove('active'));
				item.classList.add('active');
			};
		}

		// Divider for compact mode
		if (this._isToolbarCompact) {
			append(parent, $('.workflow-compact-divider'));
		}

		// Section C: Line Routing Mode (Orthogonal / Curved)
		const routingSec = append(parent, $('.workflow-toolbar-section'));
		if (!this._isToolbarCompact) {
			const routingTitle = append(routingSec, $('.workflow-toolbar-title'));
			routingTitle.textContent = localize('routingMode', 'Routing Modes');
		}

		const routingGrid = append(routingSec, $(`.workflow-shape-grid${this._isToolbarCompact ? '.compact-1col' : ''}`));
		const routingModes: { mode: 'orthogonal' | 'curved'; label: string; previewClass: string }[] = [
			{ mode: 'orthogonal', label: localize('orthogonal', 'Orthogonal (Right-Angle)'), previewClass: 'orthogonal-preview' },
			{ mode: 'curved', label: localize('curved', 'Curved (Smooth)'), previewClass: 'curved-preview' }
		];

		const routingItemBtns: HTMLElement[] = [];
		for (const rm of routingModes) {
			const item = append(routingGrid, $(`.workflow-toolbar-item${this._isToolbarCompact ? '.compact-item' : ''}${rm.mode === this._activeRoutingMode ? '.active' : ''}`));
			toolbarTooltipItems.push(item);
			item.title = rm.label;
			append(item, $(`.item-preview.${rm.previewClass}`));
			if (!this._isToolbarCompact) {
				append(item, $('.item-label')).textContent = rm.label;
			}

			routingItemBtns.push(item);
			item.onclick = () => {
				this._activeRoutingMode = rm.mode;
				this._storageService.store('workflowEditor.routingMode', this._activeRoutingMode, StorageScope.PROFILE, StorageTarget.USER);
				this._data.routingMode = rm.mode;
				routingItemBtns.forEach(btn => btn.classList.remove('active'));
				item.classList.add('active');
				this._saveFlowchartData();
				this._drawLinks();
			};
		}

		// Divider for compact mode
		if (this._isToolbarCompact) {
			append(parent, $('.workflow-compact-divider'));
		}

		// Section D: Tab Extension / Branching Direction
		const branchSec = append(parent, $('.workflow-toolbar-section'));
		if (!this._isToolbarCompact) {
			const branchTitle = append(branchSec, $('.workflow-toolbar-title'));
			branchTitle.textContent = localize('branchDirection', 'Tab Branch Direction');
		}

		const directions: { dir: 'right' | 'bottom' | 'left' | 'top'; label: string; icon: ThemeIcon }[] = [
			{ dir: 'right', label: 'Right (→)', icon: Codicon.arrowRight },
			{ dir: 'bottom', label: 'Down (↓)', icon: Codicon.arrowDown },
			{ dir: 'left', label: 'Left (←)', icon: Codicon.arrowLeft },
			{ dir: 'top', label: 'Up (↑)', icon: Codicon.arrowUp }
		];

		const currentDirInfo = directions.find(d => d.dir === this._activeBranchDirection) || directions[0];

		if (this._isToolbarCompact) {
			// Single Cycle Button in Compact Mode
			const cycleBtn = append(branchSec, $('.workflow-toolbar-item.compact-item.active'));
			toolbarTooltipItems.push(cycleBtn);
			cycleBtn.title = `Tab Branch: ${currentDirInfo.label} (Click to cycle: Right → Down → Left → Up)`;
			append(cycleBtn, $('span' + ThemeIcon.asCSSSelector(currentDirInfo.icon)));

			cycleBtn.onclick = (e) => {
				e.stopPropagation();
				const curIdx = directions.findIndex(d => d.dir === this._activeBranchDirection);
				const nextIdx = (curIdx + 1) % directions.length;
				this._activeBranchDirection = directions[nextIdx].dir;
				this._storageService.store('workflowEditor.branchDirection', this._activeBranchDirection, StorageScope.PROFILE, StorageTarget.USER);
				this._renderToolbar(parent);
			};
		} else {
			// In Expanded Mode: 4-way Direction Button Row
			const branchRow = append(branchSec, $('.workflow-format-row'));
			for (const d of directions) {
				const btn = append(branchRow, $(`.workflow-format-btn${d.dir === this._activeBranchDirection ? '.active' : ''}`));
				toolbarTooltipItems.push(btn);
				append(btn, $('span' + ThemeIcon.asCSSSelector(d.icon)));
				btn.title = `Tab Branch: ${d.label}`;
				btn.onclick = () => {
					this._activeBranchDirection = d.dir;
					this._storageService.store('workflowEditor.branchDirection', this._activeBranchDirection, StorageScope.PROFILE, StorageTarget.USER);
					this._renderToolbar(parent);
				};
			}
		}

		// Upgrade any remaining toolbar items with native `title` to instant floating tooltips
		toolbarTooltipItems.filter(el => parent.contains(el)).forEach(htmlEl => {
			const rawTitle = htmlEl.getAttribute('title');
			if (rawTitle) {
				htmlEl.removeAttribute('title');
				const dashIdx = rawTitle.indexOf(' (');
				if (dashIdx !== -1) {
					this._attachToolboxInstantTooltip(htmlEl, rawTitle.substring(0, dashIdx).trim(), rawTitle.substring(dashIdx + 1).trim(), '#38bdf8');
				} else {
					this._attachToolboxInstantTooltip(htmlEl, rawTitle, undefined, '#38bdf8');
				}
			}
		});
	}

	private _activeToolboxTooltipEl: HTMLElement | null = null;
	private _activeToolboxTooltipTimer: ReturnType<typeof setTimeout> | null = null;

	private _hideToolboxInstantTooltip(): void {
		if (this._activeToolboxTooltipTimer) {
			clearTimeout(this._activeToolboxTooltipTimer);
			this._activeToolboxTooltipTimer = null;
		}
		if (this._activeToolboxTooltipEl) {
			this._activeToolboxTooltipEl.remove();
			this._activeToolboxTooltipEl = null;
		}
	}

	private _attachToolboxInstantTooltip(targetEl: HTMLElement, titleText: string, descText?: string, accentColor: string = '#38bdf8'): void {
		targetEl.removeAttribute('title');
		const showTooltip = () => {
			this._hideToolboxInstantTooltip();
			this._activeToolboxTooltipTimer = setTimeout(() => {
				if (!targetEl.isConnected) {
					return;
				}
				const rect = targetEl.getBoundingClientRect();
				const tip = append(this._targetWindow.document.body, $('div.workflow-toolbox-instant-tooltip', {
					style: `position: fixed; z-index: 100000; pointer-events: none; font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif); background: rgba(15, 23, 42, 0.96); border: 1px solid ${accentColor}; border-left: 3px solid ${accentColor}; border-radius: 7px; padding: 7px 11px; box-shadow: 0 10px 28px rgba(0, 0, 0, 0.75); max-width: 260px; display: flex; flex-direction: column; gap: 3px; backdrop-filter: blur(6px);`
				}));
				append(tip, $('div', {
					style: `font-size: 12px; font-weight: 700; color: ${accentColor}; line-height: 1.25; font-family: inherit;`
				}, titleText));
				if (descText) {
					append(tip, $('div', {
						style: 'font-size: 11px; color: #cbd5e1; line-height: 1.4; font-family: inherit;'
					}, descText));
				}
				const tipRect = tip.getBoundingClientRect();
				const left = Math.min(this._targetWindow.innerWidth - tipRect.width - 12, rect.right + 10);
				const top = Math.max(8, Math.min(this._targetWindow.innerHeight - tipRect.height - 8, rect.top + rect.height / 2 - tipRect.height / 2));
				tip.style.left = `${left}px`;
				tip.style.top = `${top}px`;
				this._activeToolboxTooltipEl = tip;
			}, 35);
		};
		targetEl.addEventListener('mouseenter', showTooltip);
		targetEl.addEventListener('mouseleave', () => this._hideToolboxInstantTooltip());
		targetEl.addEventListener('mousedown', () => this._hideToolboxInstantTooltip());
		targetEl.addEventListener('dragstart', () => this._hideToolboxInstantTooltip());
	}

	private _showColorPickerFlyout(anchorEl: HTMLElement, currentColor: string, colors: { name: string; hex: string }[], onSelect: (hex: string) => void): void {
		const targetDocument = this._targetWindow.document;
		const existing = wfColorFlyoutPopovers.get(targetDocument);
		if (existing && targetDocument.contains(existing)) { existing.remove(); }

		const popover = document.createElement('div');
		popover.className = 'workflow-color-flyout-popover';
		wfColorFlyoutPopovers.set(targetDocument, popover);
		const rect = anchorEl.getBoundingClientRect();
		popover.style.position = 'fixed';
		popover.style.right = `${this._targetWindow.innerWidth - rect.left + 8}px`;
		popover.style.top = `${Math.max(10, Math.min(this._targetWindow.innerHeight - 150, rect.top - 20))}px`;
		popover.style.zIndex = '10000';

		const grid = append(popover, $('.workflow-color-grid'));
		grid.style.display = 'grid';
		grid.style.gridTemplateColumns = 'repeat(3, 24px)';
		grid.style.gap = '6px';
		grid.style.padding = '8px';

		for (const c of colors) {
			const swatch = append(grid, $('.workflow-color-swatch-btn'));
			swatch.style.backgroundColor = c.hex;
			swatch.title = c.name;
			if (currentColor.toLowerCase() === c.hex.toLowerCase()) {
				swatch.classList.add('active');
			}
			swatch.onclick = (e) => {
				e.stopPropagation();
				onSelect(c.hex);
				popover.remove();
			};
		}

		this._targetWindow.document.body.appendChild(popover);

		const dismiss = (e: MouseEvent) => {
			if (!popover.contains(e.target as Node) && e.target !== anchorEl) {
				popover.remove();
				this._targetWindow.removeEventListener('mousedown', dismiss, true);
			}
		};
		setTimeout(() => this._targetWindow.addEventListener('mousedown', dismiss, true), 50);
	}

	private _openNodePipelinePanel(nodeId: string, highlightTicketName?: string): void {
		// Temporarily disabled (commented out per user request: use Python File / Jupyter Notebook mode instead)
		void nodeId;
		void highlightTicketName;
		return;
		/*
		if (this._activePipelineNodeId === nodeId && this._pipelinePanelEl && this._canvasViewport?.contains(this._pipelinePanelEl)) {
			if (highlightTicketName) {
				const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(highlightTicketName) : highlightTicketName;
				const targetCard = this._pipelinePanelEl.querySelector(`[data-ticket-name="${escaped}"]`) as HTMLElement;
				if (targetCard) {
					targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
					targetCard.classList.add('highlight-pulse');
					setTimeout(() => targetCard.classList.remove('highlight-pulse'), 1600);
				}
			}
			return;
		}

		const node = this._data.nodes.find(n => n.id === nodeId);
		if (!node) {
			this._notificationService.warn(`Node '${nodeId}' not found.`);
			return;
		}

		this._activePipelineNodeId = nodeId;

		// Select the node so user sees visual focus
		this._selectedNodeIds.clear();
		this._selectedLinkIds.clear();
		this._selectedNodeIds.add(nodeId);

		// Auto-align pipeline from node if empty or disordered (runners first, variables at end)
		if (this._pipelineNeedsAlignment(node)) {
			this._syncFromNode(node, true);
		}

		this._renderNodes();
		this._drawLinks();
		if (this._inspectorEl) {
			this._renderInspector(this._inspectorEl);
		}

		if (!this._canvasViewport) return;

		// Ensure panel element is cleanly attached to current canvas viewport
		if (this._pipelinePanelEl && !this._canvasViewport.contains(this._pipelinePanelEl)) {
			this._pipelinePanelEl.remove();
			this._pipelinePanelEl = undefined;
		}
		if (!this._pipelinePanelEl) {
			this._pipelinePanelEl = append(this._canvasViewport, $('.workflow-pipeline-panel'));
		}
		this._pipelinePanelEl.style.display = 'flex';
		this._pipelinePanelEl.className = `workflow-pipeline-panel dock-${this._pipelineDockSide}`;
		this._renderPipelinePanel(this._pipelinePanelEl, node);

		if (highlightTicketName) {
			setTimeout(() => {
				if (!this._pipelinePanelEl) return;
				const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(highlightTicketName) : highlightTicketName;
				const targetCard = this._pipelinePanelEl.querySelector(`[data-ticket-name="${escaped}"]`) as HTMLElement;
				if (targetCard) {
					targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
					targetCard.classList.add('highlight-pulse');
					setTimeout(() => targetCard.classList.remove('highlight-pulse'), 1600);
				}
			}, 80);
		}
		*/
	}

	private _closeNodePipelinePanel(): void {
		this._hideTicketPopover();
		if (this._activePipelineDropdown) {
			this._activePipelineDropdown.remove();
			this._activePipelineDropdown = null;
		}
		if (this._pipelinePanelEl) {
			this._pipelinePanelEl.remove();
			this._pipelinePanelEl = undefined;
		}
		this._activePipelineNodeId = undefined;
	}

	private _showTicketPopover(
		targetEl: HTMLElement,
		ticket: { type: string; name: string; uri?: string; parameters?: string },
		node: IFlowchartNode,
		explicitStepIndex?: number
	): void {
		if (this._ticketHoverTimeout) {
			clearTimeout(this._ticketHoverTimeout);
			this._ticketHoverTimeout = null;
		}

		if (!this._ticketHoverPopoverEl) {
			this._ticketHoverPopoverEl = document.createElement('div');
			this._ticketHoverPopoverEl.className = 'workflow-ticket-popover';
			this._targetWindow.document.body.appendChild(this._ticketHoverPopoverEl);

			this._ticketHoverPopoverEl.addEventListener('mouseenter', () => {
				if (this._ticketHoverTimeout) {
					clearTimeout(this._ticketHoverTimeout);
					this._ticketHoverTimeout = null;
				}
			});
			this._ticketHoverPopoverEl.addEventListener('mouseleave', () => {
				this._hideTicketPopover();
			});
		}

		const popover = this._ticketHoverPopoverEl;
		clearNode(popover);

		const matchingStep = explicitStepIndex !== undefined && node.pipeline
			? node.pipeline[explicitStepIndex - 1]
			: (node.pipeline?.find(s =>
				s.type === 'run_ticket' &&
				s.ticketName === ticket.name &&
				(ticket.parameters ? s.parameters === ticket.parameters : true)
			) || node.pipeline?.find(s => s.type === 'run_ticket' && s.ticketName === ticket.name));
		const stepIndex = explicitStepIndex !== undefined
			? explicitStepIndex
			: (matchingStep && node.pipeline ? (node.pipeline.indexOf(matchingStep) + 1) : undefined);
		const style = getEntityBadgeStyle(ticket.type);

		// 1. Header row
		const header = append(popover, $('.ticket-popover-header'));
		const badge = append(header, $('.ticket-popover-badge'));
		badge.style.backgroundColor = style.bg;
		badge.style.color = style.color;
		badge.style.border = `1px solid ${style.color}44`;
		append(badge, $('span' + ThemeIcon.asCSSSelector(style.icon)));
		append(badge, $('span', {}, (ticket.type || 'ticket').toUpperCase()));

		append(header, $('span.ticket-popover-name', {}, ticket.name));

		if (stepIndex !== undefined) {
			append(header, $('span.ticket-popover-seq', {}, `#${stepIndex} in Pipeline`));
		}

		const openTabBtn = append(header, $('.ticket-popover-open-tab-btn'));
		openTabBtn.title = `Open ${ticket.name} in Editor Tab`;
		openTabBtn.style.cursor = 'pointer';
		openTabBtn.style.marginLeft = 'auto';
		openTabBtn.style.padding = '1px 6px';
		openTabBtn.style.fontSize = '10px';
		openTabBtn.style.borderRadius = '3px';
		openTabBtn.style.background = 'rgba(56, 189, 248, 0.18)';
		openTabBtn.style.border = '1px solid rgba(56, 189, 248, 0.4)';
		openTabBtn.style.color = '#38bdf8';
		openTabBtn.style.display = 'inline-flex';
		openTabBtn.style.alignItems = 'center';
		openTabBtn.style.gap = '3px';
		append(openTabBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.linkExternal)));
		append(openTabBtn, $('span', {}, 'Open Tab'));
		openTabBtn.onclick = (e) => {
			e.stopPropagation();
			this._hideTicketPopover();
			this._openModuleInEditor({
				type: ticket.type || 'ticket',
				name: ticket.name,
				uri: ticket.uri
			});
		};

		// 2. Parameters row
		const effectiveParams = matchingStep?.parameters || ticket.parameters;
		const paramRow = append(popover, $('.ticket-popover-row'));
		append(paramRow, $('span.ticket-popover-label', {}, 'PARAM:'));
		const paramVal = append(paramRow, $('span.ticket-popover-param'));
		if (effectiveParams && effectiveParams.trim()) {
			paramVal.textContent = effectiveParams.trim();
			paramVal.classList.add('has-value');
		} else {
			paramVal.textContent = '(none)';
			paramVal.classList.add('is-empty');
		}

		// 3. Captured by variables row
		const capturingVars: string[] = [];
		if (node?.pipeline) {
			const myStepIdx = matchingStep ? node.pipeline.indexOf(matchingStep) : -1;
			for (let i = (myStepIdx >= 0 ? myStepIdx + 1 : 0); i < node.pipeline.length; i++) {
				const s = node.pipeline[i];
				if (s.type === 'run_ticket' && s.ticketName === ticket.name && myStepIdx >= 0) {
					break; // Subsequent execution of same ticket resets capture
				}
				if (s.type === 'set_variable' && s.targetVariable) {
					const expr = (s.expression || '').trim().replace(/^@/, '').replace(/^=\s*/, '');
					if (expr === ticket.name || expr === 'ticket' || expr === 'ticket.output') {
						const cv = s.targetVariable.replace(/^@/, '');
						if (!capturingVars.includes(cv)) { capturingVars.push(cv); }
					}
				}
			}
		} else if (node?.outputVariables) {
			for (const v of node.outputVariables) {
				const expr = (v.expression || v.initialValue || '').trim().replace(/^@/, '').replace(/^=\s*/, '');
				if (expr === ticket.name || expr === 'ticket' || expr === 'ticket.output') {
					const cv = v.name.replace(/^@/, '');
					if (!capturingVars.includes(cv)) { capturingVars.push(cv); }
				}
			}
		}

		const outRow = append(popover, $('.ticket-popover-row'));
		append(outRow, $('span.ticket-popover-label', {}, 'Captured by:'));
		const outVal = append(outRow, $('span.ticket-popover-out'));
		if (capturingVars.length > 0) {
			for (const cv of capturingVars) {
				const vBadge = append(outVal, $('span.var-tag-icon', {}, '[V] '));
				vBadge.style.fontFamily = 'monospace';
				vBadge.style.fontSize = '8.5px';
				vBadge.style.marginRight = '2px';
				append(outVal, $('span', {}, cv + ' '));
			}
		} else {
			outVal.textContent = '(none - standalone)';
			outVal.classList.add('is-empty');
		}

		// 4. Footer hint
		const footer = append(popover, $('.ticket-popover-footer'));
		append(footer, $('span' + ThemeIcon.asCSSSelector(Codicon.linkExternal)));
		append(footer, $('span', {}, 'Double-click to open in Editor Tab (Click to configure in Pipeline)'));

		popover.onclick = (e) => {
			e.stopPropagation();
			this._hideTicketPopover();
			this._openNodePipelinePanel(node.id, ticket.name);
		};

		popover.ondblclick = (e) => {
			e.stopPropagation();
			e.preventDefault();
			this._hideTicketPopover();
			this._openModuleInEditor({
				type: ticket.type || 'ticket',
				name: ticket.name,
				uri: ticket.uri
			});
		};

		// Position popover relative to targetEl
		const rect = targetEl.getBoundingClientRect();
		popover.style.display = 'flex';
		const popRect = popover.getBoundingClientRect();

		// Position above if space available, else below
		let top = rect.top - popRect.height - 8;
		if (top < 10) {
			top = rect.bottom + 8;
		}
		let left = rect.left + (rect.width / 2) - (popRect.width / 2);
		if (left < 10) { left = 10; }
		if (left + popRect.width > this._targetWindow.innerWidth - 10) {
			left = this._targetWindow.innerWidth - popRect.width - 10;
		}

		popover.style.top = `${top}px`;
		popover.style.left = `${left}px`;
	}

	private _isActionNodeForSelectiveRun(node: IFlowchartNode): boolean {
		const lbl = (node.label || '').trim().toLowerCase();
		if (lbl === 'end' || lbl === 'stop' || lbl === 'exit' || lbl === 'finish' || lbl === 'quit') {
			return false;
		}
		const hasPipeline = Boolean(node.pipeline && node.pipeline.length > 0);
		const hasImports = Boolean(node.imports && node.imports.length > 0);
		const hasVars = Boolean((node.outputVariables && node.outputVariables.length > 0) || node.outputVariable?.name);
		if (hasPipeline || hasImports || hasVars) {
			return true;
		}
		if (node.type === 'circle' || /^start(\s+debug)?$/i.test(lbl)) {
			return false;
		}
		return true;
	}

	private _resolveExecutionOptionsForRun(isStepMode: boolean = false): { entryNodeId?: string; selectedNodeIds?: string[] } {
		if (this._selectedNodeIds.size > 0 && this._data && Array.isArray(this._data.nodes)) {
			const selectedNodes = Array.from(this._selectedNodeIds)
				.map(id => this._data.nodes.find(n => n.id === id))
				.filter((n): n is IFlowchartNode => !!n);
			if (selectedNodes.length === 1) {
				return {
					entryNodeId: selectedNodes[0].id,
					selectedNodeIds: undefined
				};
			}
			const selectedActionNodes = selectedNodes.filter(n => this._isActionNodeForSelectiveRun(n));
			if (selectedActionNodes.length >= 2) {
				const selectedNodeIds = selectedActionNodes.map(n => n.id);
				return {
					entryNodeId: selectedNodeIds[0],
					selectedNodeIds
				};
			}
			if (selectedActionNodes.length === 1) {
				return {
					entryNodeId: selectedActionNodes[0].id,
					selectedNodeIds: undefined
				};
			}
		}
		return {
			entryNodeId: this._resolveStartNodeIdForExecution(isStepMode),
			selectedNodeIds: undefined
		};
	}

	private _updateRunButtonSelectionBadge(targetRunBtn?: HTMLElement, targetFullSpeedBtn?: HTMLElement): void {
		const toolbarEl = this._toolbarEl;
		const toolbarRunButtons = toolbarEl ? wfToolbarRunButtons.get(toolbarEl) : undefined;
		const runBtn = targetRunBtn || (toolbarEl && toolbarRunButtons && toolbarEl.contains(toolbarRunButtons.runBtn) ? toolbarRunButtons.runBtn : null);
		const fullSpeedBtn = targetFullSpeedBtn || (toolbarEl && toolbarRunButtons && toolbarEl.contains(toolbarRunButtons.fullSpeedBtn) ? toolbarRunButtons.fullSpeedBtn : null);
		if (!runBtn && !fullSpeedBtn) {
			return;
		}
		const activeRun = this._workflowUri ? this._workflowExecutionService.getActiveRun(this._workflowUri) : undefined;
		const isRunning = activeRun && (activeRun.status === 'running' || activeRun.status === 'waiting_human' || activeRun.status === 'paused');
		if (isRunning) {
			return;
		}
		const selectedNodes = Array.from(this._selectedNodeIds)
			.map(id => this._data?.nodes?.find(n => n.id === id))
			.filter((n): n is IFlowchartNode => !!n);
		const selectedActionNodes = selectedNodes.filter(n => this._isActionNodeForSelectiveRun(n));
		const runLabelEl = runBtn ? wfToolbarItemLabels.get(runBtn) : undefined;
		const fullSpeedLabelEl = fullSpeedBtn ? wfToolbarItemLabels.get(fullSpeedBtn) : undefined;
		if (selectedNodes.length >= 2 && selectedActionNodes.length >= 2) {
			if (runLabelEl) {
				runLabelEl.textContent = `Run (${selectedActionNodes.length})`;
			}
			if (fullSpeedLabelEl) {
				fullSpeedLabelEl.textContent = `Full Speed (${selectedActionNodes.length})`;
			}
			const names = selectedActionNodes.map((n, i) => `#${i + 1} ${n.label}`).join(' → ');
			if (runBtn) {
				runBtn.title = `Run Selected Nodes Only (${selectedActionNodes.length}): ${names}\n(Select 1 node to run from that node onward, or click empty canvas to run entire workflow)`;
			}
			if (fullSpeedBtn) {
				fullSpeedBtn.title = `Run Selected Nodes Only at Full Speed (${selectedActionNodes.length}): ${names}\n(Select 1 node to run from that node onward, or click empty canvas to run entire workflow)`;
			}
		} else if (selectedNodes.length === 1) {
			const singleNode = selectedNodes[0];
			if (runLabelEl) {
				runLabelEl.textContent = 'Run';
			}
			if (fullSpeedLabelEl) {
				fullSpeedLabelEl.textContent = 'Full Speed';
			}
			if (runBtn) {
				runBtn.title = `Run Workflow From '${singleNode.label}' Onward (Continues executing remaining downstream flow)`;
			}
			if (fullSpeedBtn) {
				fullSpeedBtn.title = `Run at Full Speed From '${singleNode.label}' Onward (Continues executing remaining downstream flow with minimal delay)`;
			}
		} else {
			if (runLabelEl) {
				runLabelEl.textContent = 'Run';
			}
			if (fullSpeedLabelEl) {
				fullSpeedLabelEl.textContent = 'Full Speed';
			}
			if (runBtn) {
				runBtn.title = 'Run Entire Workflow (Select 1 node to run from that node onward, or Cmd/Ctrl/Shift + Click multiple nodes to run only selected nodes)';
			}
			if (fullSpeedBtn) {
				fullSpeedBtn.title = 'Run at Full Speed (Execute entire workflow with minimal waiting and delay)';
			}
		}
	}

	private _resolveStartNodeIdForExecution(isStepMode: boolean = false): string | undefined {
		// 1. If the user explicitly selected a node on the canvas, always start from the selected node
		if (this._selectedNodeIds.size > 0) {
			const selectedIds = Array.from(this._selectedNodeIds);
			return selectedIds[selectedIds.length - 1];
		}

		if (!this._data || !Array.isArray(this._data.nodes) || this._data.nodes.length === 0) {
			return undefined;
		}

		// 2. Identify all entry node candidates (nodes with 0 incoming links that are not end nodes)
		const targetIds = new Set((this._data.links || []).map(l => l.to));
		const isEndLabel = (lbl: string) => {
			const t = (lbl || '').trim().toLowerCase();
			return t === 'end' || t === 'stop' || t === 'exit' || t === 'finish' || t === 'quit';
		};
		const entryCandidates = this._data.nodes.filter(n => !targetIds.has(n.id) && !isEndLabel(n.label));

		// If the page has only a single unique entry node, start from it automatically
		if (entryCandidates.length === 1) {
			return entryCandidates[0].id;
		}

		// If there are multiple entry nodes and none is currently selected, check if one was most recently clicked
		if (entryCandidates.length > 1) {
			const clickedCandidates = entryCandidates
				.filter(n => typeof n._lastClickTime === 'number' && n._lastClickTime > 0)
				.sort((a, b) => (b._lastClickTime || 0) - (a._lastClickTime || 0));
			if (clickedCandidates.length > 0) {
				return clickedCandidates[0].id;
			}
			if (!isStepMode) {
				throw new Error('Multiple entry nodes exist on the canvas. Please click/select the node you want to start from before clicking Run.');
			}
		}

		return undefined;
	}

	private _hideTicketPopover(immediate: boolean = false): void {
		if (this._ticketHoverTimeout) {
			clearTimeout(this._ticketHoverTimeout);
			this._ticketHoverTimeout = null;
		}
		if (immediate) {
			if (this._ticketHoverPopoverEl) {
				this._ticketHoverPopoverEl.remove();
				this._ticketHoverPopoverEl = null;
			}
			return;
		}
		this._ticketHoverTimeout = setTimeout(() => {
			if (this._ticketHoverPopoverEl) {
				this._ticketHoverPopoverEl.remove();
				this._ticketHoverPopoverEl = null;
			}
		}, 120);
	}

	private _schedulePythonStepPopover(
		targetEl: HTMLElement,
		node: IFlowchartNode,
		step: INodePipelineStep,
		stepIndex: number | undefined,
		fullCode: string,
		isVariableStep: boolean,
		runtimeValStr: string
	): void {
		if (this._isPythonStepPopoverPinned && this._activePythonPopoverStep === step && this._pythonStepHoverPopoverEl?.isConnected) {
			return;
		}
		if (this._pythonStepHoverShowTimeout) {
			clearTimeout(this._pythonStepHoverShowTimeout);
			this._pythonStepHoverShowTimeout = null;
		}
		if (this._pythonStepHoverHideTimeout) {
			clearTimeout(this._pythonStepHoverHideTimeout);
			this._pythonStepHoverHideTimeout = null;
		}
		// Standard IDE hover delay (350ms, matching VS Code editor.hover.delay)
		this._pythonStepHoverShowTimeout = setTimeout(() => {
			this._pythonStepHoverShowTimeout = null;
			if (!targetEl.isConnected) {
				return;
			}
			if (node.pipeline && !node.pipeline.includes(step)) {
				return;
			}
			this._showPythonStepPopover(targetEl, node, step, stepIndex, fullCode, isVariableStep, runtimeValStr);
		}, 350);
	}

	private _showPythonStepPopover(
		targetEl: HTMLElement,
		node: IFlowchartNode,
		step: INodePipelineStep,
		stepIndex: number | undefined,
		fullCode: string,
		isVariableStep: boolean,
		runtimeValStr: string
	): void {
		if (this._pythonStepHoverHideTimeout) {
			clearTimeout(this._pythonStepHoverHideTimeout);
			this._pythonStepHoverHideTimeout = null;
		}
		if (this._pythonStepPopoverOutsideClickHandler) {
			this._targetWindow.removeEventListener('mousedown', this._pythonStepPopoverOutsideClickHandler, true);
			this._pythonStepPopoverOutsideClickHandler = null;
		}
		this._isPythonStepPopoverPinned = false;
		this._activePythonPopoverNode = node;
		this._activePythonPopoverStep = step;

		if (!this._pythonStepHoverPopoverEl) {
			this._pythonStepHoverPopoverEl = document.createElement('div');
			this._pythonStepHoverPopoverEl.className = 'workflow-python-step-popover';
			this._targetWindow.document.body.appendChild(this._pythonStepHoverPopoverEl);

			this._pythonStepHoverPopoverEl.addEventListener('mouseenter', () => {
				if (this._pythonStepHoverHideTimeout) {
					clearTimeout(this._pythonStepHoverHideTimeout);
					this._pythonStepHoverHideTimeout = null;
				}
			});
			this._pythonStepHoverPopoverEl.addEventListener('mouseleave', () => {
				if (this._isPythonStepPopoverPinned) {
					return;
				}
				this._hidePythonStepPopover();
			});
			this._pythonStepHoverPopoverEl.addEventListener('mousedown', (e) => {
				e.stopPropagation();
			});
		}

		const popover = this._pythonStepHoverPopoverEl;
		clearNode(popover);

		const comp = step.component;
		const compMetaMap: Record<string, { label: string; icon: ThemeIcon; color: string; bg: string; border: string }> = {
			table: { label: 'DATA TABLE', icon: Codicon.table, color: '#fb923c', bg: 'rgba(249, 115, 22, 0.16)', border: 'rgba(251, 146, 60, 0.45)' },
			prompt: { label: 'AI PROMPT', icon: Codicon.sparkle, color: '#2dd4bf', bg: 'rgba(20, 184, 166, 0.16)', border: 'rgba(45, 212, 191, 0.45)' },
			python: { label: 'PYTHON SCRIPT', icon: Codicon.python, color: '#38bdf8', bg: 'rgba(14, 165, 233, 0.16)', border: 'rgba(56, 189, 248, 0.45)' },
			browser: { label: 'BROWSER', icon: Codicon.globe, color: '#38bdf8', bg: 'rgba(14, 165, 233, 0.16)', border: 'rgba(56, 189, 248, 0.45)' },
			tts: { label: 'O2 TTS', icon: Codicon.unmute, color: '#f87171', bg: 'rgba(239, 68, 68, 0.16)', border: 'rgba(248, 113, 113, 0.45)' },
			media_player: { label: 'MP3 / MP4 PLAYER', icon: Codicon.deviceCameraVideo, color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.16)', border: 'rgba(251, 191, 36, 0.45)' },
			voice_note: { label: 'VOICE NOTE', icon: Codicon.mic, color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.14)', border: 'rgba(148, 163, 184, 0.35)' },
			sub_workflow: { label: 'CALL SUB-WORKFLOW', icon: Codicon.layers, color: '#22d3ee', bg: 'rgba(6, 182, 212, 0.16)', border: 'rgba(34, 211, 238, 0.45)' },
			ssh: { label: 'SSH TERMINAL', icon: Codicon.terminal, color: '#34d399', bg: 'rgba(16, 185, 129, 0.16)', border: 'rgba(52, 211, 153, 0.45)' },
			git: { label: 'GIT BRANCH', icon: Codicon.gitMerge, color: '#a3e635', bg: 'rgba(132, 204, 22, 0.16)', border: 'rgba(163, 230, 53, 0.45)' },
			create_tickets: { label: 'CREATE TICKETS', icon: Codicon.add, color: '#c084fc', bg: 'rgba(168, 85, 247, 0.16)', border: 'rgba(192, 132, 252, 0.45)' },
			run_tickets: { label: 'RUN TICKETS', icon: Codicon.playCircle, color: '#a855f7', bg: 'rgba(168, 85, 247, 0.16)', border: 'rgba(168, 85, 247, 0.45)' },
			get_outputs: { label: 'GET OUTPUTS', icon: Codicon.signOut, color: '#818cf8', bg: 'rgba(99, 102, 241, 0.16)', border: 'rgba(129, 140, 248, 0.45)' },
			get_ticket: { label: 'GET TICKET', icon: Codicon.tag, color: '#60a5fa', bg: 'rgba(59, 130, 246, 0.16)', border: 'rgba(96, 165, 250, 0.45)' },
			get_tickets: { label: 'GET TICKETS', icon: Codicon.search, color: '#60a5fa', bg: 'rgba(59, 130, 246, 0.16)', border: 'rgba(96, 165, 250, 0.45)' },
			display: { label: 'DISPLAY', icon: Codicon.eye, color: '#f472b6', bg: 'rgba(236, 72, 153, 0.16)', border: 'rgba(244, 114, 182, 0.45)' },
			parameters: { label: 'INPUTS', icon: Codicon.symbolVariable, color: '#c084fc', bg: 'rgba(168, 85, 247, 0.16)', border: 'rgba(192, 132, 252, 0.45)' },
			output: { label: 'OUTPUT', icon: Codicon.output, color: '#34d399', bg: 'rgba(16, 185, 129, 0.16)', border: 'rgba(52, 211, 153, 0.45)' }
		};
		const compMeta = comp ? compMetaMap[comp.type] : undefined;

		const accentColor = compMeta ? compMeta.color : (isVariableStep ? '#38bdf8' : '#c084fc');
		const accentBg = compMeta ? compMeta.bg : (isVariableStep ? 'rgba(56, 189, 248, 0.16)' : 'rgba(192, 132, 252, 0.18)');
		const accentBorder = compMeta ? compMeta.border : (isVariableStep ? 'rgba(56, 189, 248, 0.4)' : 'rgba(192, 132, 252, 0.42)');

		const varName = comp
			? ((comp.type !== 'parameters' && comp.type !== 'output' && comp.type !== 'display')
				? this._getComponentOutputVarName(comp)
				: '')
			: (step.targetVariable || '').replace(/^@/, '').trim();

		// Determine whether this step renders Python code (1 line by default, expandable) or Component Metadata
		const isPythonCodeTooltip = !comp || comp.type === 'python' || comp.type === 'create_tickets' || comp.type === 'run_tickets' || comp.type === 'get_outputs' || comp.type === 'get_ticket' || comp.type === 'get_tickets' || comp.type === 'display';

		let effectiveCode = fullCode;
		if (comp?.type === 'python') {
			effectiveCode = (comp.pythonCode || comp.defaultValue || comp.defaultContent || '').replace(/\r\n/g, '\n').trim() || '# Empty Python script';
		} else if (comp && (comp.type === 'create_tickets' || comp.type === 'run_tickets' || comp.type === 'get_outputs' || comp.type === 'get_ticket' || comp.type === 'get_tickets' || comp.type === 'display')) {
			effectiveCode = this._buildBuiltinComponentPythonExpression(comp);
		}

		// Resolve metadata text for non-code component types (Table, AI Prompt, Browser, O2 TTS, Git Branch)
		let metadataLabel = '';
		let metadataValue = '';
		if (comp && !isPythonCodeTooltip) {
			switch (comp.type) {
				case 'table': {
					metadataLabel = 'Table Name';
					metadataValue = (comp.tableDbTableName || wfComponent(comp).tableName || '').trim();
					break;
				}
				case 'prompt': {
					metadataLabel = 'Model';
					metadataValue = comp.targetMode === 'agent'
						? (comp.targetAgentName || comp.targetAgentId || 'AI Agent')
						: (comp.targetModel || resolveDefaultModelId(comp.targetProvider, comp.targetProvider === 'gemini' ? 'gemini-2.5-flash' : comp.targetProvider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o'));
					break;
				}
				case 'browser': {
					metadataLabel = 'URL';
					metadataValue = (comp.defaultUrl || wfComponent(comp).browserUrl || '').trim();
					break;
				}
				case 'tts': {
					metadataLabel = 'Model';
					metadataValue = (comp.targetModel || (comp.targetProvider === 'openai' ? 'tts-1' : 'gemini-2.5-flash-preview-tts')).trim();
					break;
				}
				case 'media_player': {
					metadataLabel = 'Media File';
					metadataValue = (comp.mediaFileName || comp.mediaFilePath || '(no file selected)').trim();
					break;
				}
				case 'voice_note': {
					const clips = Array.isArray(comp.voiceClips) ? comp.voiceClips : [];
					metadataLabel = `Voice Clips (${clips.length})`;
					const previewText = (comp.voiceTranscript || clips.map(c => c.transcript || '').filter(Boolean).join(' ')).trim();
					metadataValue = previewText ? (previewText.length > 140 ? previewText.substring(0, 140) + '...' : previewText) : (clips.length > 0 ? `${clips.length} recorded audio clip(s)` : '(no recordings yet)');
					break;
				}
				case 'sub_workflow': {
					const inCount = Array.isArray(comp.subWorkflowInputDefs) ? comp.subWorkflowInputDefs.length : 0;
					const outCount = Array.isArray(comp.subWorkflowOutputDefs) ? comp.subWorkflowOutputDefs.length : 0;
					metadataLabel = 'Call Sub-Workflow';
					metadataValue = `${comp.subWorkflowName || comp.subWorkflowId || '(unlinked)'} (${inCount} in · ${outCount} out)`;
					break;
				}
				case 'ssh': {
					metadataLabel = 'SSH Target';
					const cmdsCount = normalizeSshCommandsList(comp.sshCommands, comp.sshCommand).filter(c => c.trim().length > 0).length;
					metadataValue = comp.sshHost
						? `${comp.sshUser || 'root'}@${comp.sshHost}:${comp.sshPort || 22}${cmdsCount > 0 ? ` (${cmdsCount} cmd${cmdsCount > 1 ? 's' : ''})` : ''}`
						: '(no host configured)';
					break;
				}
				case 'http_request': {
					metadataLabel = 'API Endpoint';
					metadataValue = comp.httpUrl ? `[${(comp.httpMethod || 'GET').toUpperCase()}] ${comp.httpUrl}` : '(no URL configured)';
					break;
				}
				case 'shell': {
					metadataLabel = 'Shell Script';
					metadataValue = `${comp.shellType || 'default shell'}${comp.shellCwd ? ` in ${comp.shellCwd}` : ''}: ${String(comp.shellScript || '(empty)').split('\n')[0]}`;
					break;
				}
				case 'git': {
					metadataLabel = 'Git Command';
					metadataValue = comp.gitCommand
						? `git ${comp.gitCommand}${comp.gitCommand === 'clone' ? ` ${comp.gitRemoteUrl || ''}` : (comp.gitRepoPath ? ` (in ${comp.gitRepoPath})` : '')}`
						: (comp.gitRemoteUrl || '').trim();
					break;
				}
				default: {
					metadataValue = fullCode;
					break;
				}
			}
		}

		const positionPopover = () => {
			const rect = targetEl.getBoundingClientRect();
			popover.style.display = 'flex';
			const popRect = popover.getBoundingClientRect();

			let top = rect.top - popRect.height - 8;
			if (top < 12) {
				top = rect.bottom + 8;
			}
			if (top + popRect.height > this._targetWindow.innerHeight - 12) {
				top = Math.max(12, this._targetWindow.innerHeight - popRect.height - 12);
			}
			let left = rect.left;
			if (left + popRect.width > this._targetWindow.innerWidth - 12) {
				left = Math.max(12, this._targetWindow.innerWidth - popRect.width - 12);
			}
			if (left < 12) {
				left = 12;
			}

			popover.style.top = `${top}px`;
			popover.style.left = `${left}px`;
		};

		// 1. Header bar
		const header = append(popover, $('.python-step-popover-header'));
		const badge = append(header, $('.python-step-popover-badge'));
		badge.style.background = accentBg;
		badge.style.color = accentColor;
		badge.style.border = `1px solid ${accentBorder}`;
		const badgeIcon = append(badge, $('span' + ThemeIcon.asCSSSelector(compMeta ? compMeta.icon : Codicon.python)));
		badgeIcon.style.color = accentColor;
		append(badge, $('span', {}, compMeta ? compMeta.label : (stepIndex !== undefined ? `STEP #${stepIndex}` : 'PYTHON')));

		if (varName) {
			append(header, $('span.python-step-popover-var-pill', {
				style: 'font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; font-weight: 600; color: #e2e8f0; padding: 1px 6px; border-radius: 4px; background: rgba(255, 255, 255, 0.07);'
			}, varName));
		}

		if (step.disabled) {
			const disabledBadge = append(header, $('span.python-step-popover-disabled-badge', {
				style: 'font-size: 9.5px; font-weight: 700; color: #94a3b8; padding: 1px 6px; border-radius: 3px; background: rgba(148, 163, 184, 0.16); border: 1px dashed rgba(148, 163, 184, 0.45); letter-spacing: 0.5px;'
			}, 'COMMENTED OUT'));
			disabledBadge.title = 'This step is commented out and will be skipped during workflow run';
		}

		const headerTitleText = comp
			? (comp.type === 'table'
				? ((comp.tableDbTableName || wfComponent(comp).tableName || comp.label || '').trim() || 'Data Table')
				: (comp.label || (node.label || node.id)))
			: (node.label || node.id);
		const nodeTitleSpan = append(header, $('span.python-step-popover-node-name', {}, headerTitleText));
		void nodeTitleSpan;

		const codeLines = effectiveCode.replace(/\r\n/g, '\n').split('\n');
		if (isPythonCodeTooltip) {
			append(header, $('span.python-step-popover-lines-meta', {}, `${codeLines.length} ${codeLines.length === 1 ? 'line' : 'lines'}`));
		}

		const actionsWrap = append(header, $('.python-step-popover-actions'));
		const textToCopy = isPythonCodeTooltip ? effectiveCode : (metadataValue || varName || fullCode);
		if (textToCopy) {
			const copyBtn = append(actionsWrap, $('button.python-step-popover-btn'));
			copyBtn.type = 'button';
			copyBtn.title = 'Copy to clipboard';
			append(copyBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy)));
			const copyLabel = append(copyBtn, $('span', {}, 'Copy'));
			copyBtn.onclick = (e) => {
				e.stopPropagation();
				navigator.clipboard?.writeText(textToCopy);
				copyLabel.textContent = 'Copied ✓';
				setTimeout(() => {
					copyLabel.textContent = 'Copy';
				}, 1200);
			};
		}

		const toggleCommentBtn = append(actionsWrap, $('button.python-step-popover-btn', {
			style: step.disabled
				? 'background: rgba(34, 197, 94, 0.16); border-color: rgba(34, 197, 94, 0.4); color: #4ade80;'
				: 'background: rgba(148, 163, 184, 0.15); border-color: rgba(148, 163, 184, 0.4); color: #cbd5e1;'
		}));
		toggleCommentBtn.type = 'button';
		toggleCommentBtn.title = step.disabled ? 'Re-enable this step (participate in execution)' : 'Comment out / disable this step (skip execution)';
		append(toggleCommentBtn, $('span' + ThemeIcon.asCSSSelector(step.disabled ? Codicon.check : Codicon.circleSlash)));
		append(toggleCommentBtn, $('span', {}, step.disabled ? 'Enable' : 'Disable'));
		toggleCommentBtn.onclick = (e) => {
			e.stopPropagation();
			step.disabled = !step.disabled;
			this._syncToNode(node, true);
			this._saveFlowchartData();
			this._renderNodes();
			this._showPythonStepPopover(targetEl, node, step, stepIndex, fullCode, isVariableStep, runtimeValStr);
		};

		const editBtn = append(actionsWrap, $('button.python-step-popover-btn.primary'));
		editBtn.type = 'button';
		editBtn.title = comp ? 'Open Component Editor' : 'Edit this Python step inline';
		append(editBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.edit)));
		append(editBtn, $('span', {}, 'Edit'));
		editBtn.onclick = (e) => {
			e.stopPropagation();
			this._hidePythonStepPopover(true);
			if (step.component) {
				this._openNodeComponentEditorModal(node, step);
			} else {
				this._openNodeFunctionInlineEditor(node, step, targetEl);
			}
		};

		const closePopBtn = append(actionsWrap, $('button.python-step-popover-btn', {
			type: 'button',
			title: 'Close popover',
			style: 'padding: 2px 5px; opacity: 0.75;'
		}, '\u2715'));
		closePopBtn.onclick = (e) => {
			e.stopPropagation();
			this._hidePythonStepPopover(true);
		};

		const pinPopoverOpen = () => {
			this._isPythonStepPopoverPinned = true;
			if (this._pythonStepHoverHideTimeout) {
				clearTimeout(this._pythonStepHoverHideTimeout);
				this._pythonStepHoverHideTimeout = null;
			}
			if (this._pythonStepPopoverOutsideClickHandler) {
				this._targetWindow.removeEventListener('mousedown', this._pythonStepPopoverOutsideClickHandler, true);
			}
			this._pythonStepPopoverOutsideClickHandler = (ev: MouseEvent) => {
				const tgt = ev.target as Node | null;
				if (tgt && popover.contains(tgt)) {
					return;
				}
				this._hidePythonStepPopover(true);
			};
			setTimeout(() => {
				if (this._isPythonStepPopoverPinned && this._pythonStepPopoverOutsideClickHandler) {
					this._targetWindow.addEventListener('mousedown', this._pythonStepPopoverOutsideClickHandler, true);
				}
			}, 20);
		};

		// 2. Body: Either Python Code (1 line by default, expandable) or Component-specific Metadata
		if (isPythonCodeTooltip) {
			const codeContainer = append(popover, $('.python-step-popover-code-box'));
			let isCodeExpanded = false;

			// Pick the first meaningful line for the 1-line collapsed preview
			let previewLineIdx = codeLines.findIndex(l => l.trim().length > 0 && !l.trim().startsWith('#'));
			if (previewLineIdx === -1) {
				previewLineIdx = 0;
			}

			const renderCodeLines = () => {
				clearNode(codeContainer);
				if (!isCodeExpanded && codeLines.length > 1) {
					const lineText = codeLines[previewLineIdx] || '';
					const row = append(codeContainer, $('.python-step-popover-code-line'));
					append(row, $('span.python-step-popover-lineno', {}, String(previewLineIdx + 1)));
					const codeTextSpan = append(row, $('span.python-step-popover-codetext'));
					this._renderExpressionWithTicketBadges(codeTextSpan, lineText, true, 0, true);

					const moreBtnRow = append(codeContainer, $('div', {
						style: 'display: flex; align-items: center; justify-content: flex-end; padding: 3px 8px 1px 8px; border-top: 1px dashed rgba(255, 255, 255, 0.08); margin-top: 3px;'
					}));
					const expandBtn = append(moreBtnRow, $('button.python-step-popover-btn', {
						type: 'button',
						style: 'font-size: 10.5px; padding: 1px 7px; color: #38bdf8; background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 3px; cursor: pointer;'
					}, `+${codeLines.length - 1} more ${codeLines.length - 1 === 1 ? 'line' : 'lines'} (Expand)`));
					expandBtn.onmousedown = (e) => {
						e.stopPropagation();
						e.preventDefault();
					};
					expandBtn.onclick = (e) => {
						e.stopPropagation();
						e.preventDefault();
						isCodeExpanded = true;
						pinPopoverOpen();
						renderCodeLines();
						positionPopover();
					};
				} else {
					let runningParenDepth = 0;
					codeLines.forEach((lineText, idx) => {
						const row = append(codeContainer, $('.python-step-popover-code-line'));
						append(row, $('span.python-step-popover-lineno', {}, String(idx + 1)));
						const codeTextSpan = append(row, $('span.python-step-popover-codetext'));
						if (lineText) {
							this._renderExpressionWithTicketBadges(codeTextSpan, lineText, true, runningParenDepth, true);
							let inQuote: string | null = null;
							for (let cIdx = 0; cIdx < lineText.length; cIdx++) {
								const ch = lineText[cIdx];
								if (inQuote) {
									if (ch === inQuote && lineText[cIdx - 1] !== '\\') {
										inQuote = null;
									}
								} else if (ch === '#') {
									break;
								} else if (ch === '"' || ch === '\'') {
									inQuote = ch;
								} else if (ch === '(') {
									runningParenDepth++;
								} else if (ch === ')') {
									runningParenDepth = Math.max(0, runningParenDepth - 1);
								}
							}
						} else {
							codeTextSpan.textContent = ' ';
						}
					});

					if (codeLines.length > 1) {
						const collapseRow = append(codeContainer, $('div', {
							style: 'display: flex; align-items: center; justify-content: flex-end; padding: 3px 8px 1px 8px; border-top: 1px dashed rgba(255, 255, 255, 0.08); margin-top: 3px;'
						}));
						const collapseBtn = append(collapseRow, $('button.python-step-popover-btn', {
							type: 'button',
							style: 'font-size: 10.5px; padding: 1px 7px; color: #94a3b8; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 3px; cursor: pointer;'
						}, 'Collapse to 1 line'));
						collapseBtn.onmousedown = (e) => {
							e.stopPropagation();
							e.preventDefault();
						};
						collapseBtn.onclick = (e) => {
							e.stopPropagation();
							e.preventDefault();
							isCodeExpanded = false;
							this._isPythonStepPopoverPinned = false;
							if (this._pythonStepPopoverOutsideClickHandler) {
								this._targetWindow.removeEventListener('mousedown', this._pythonStepPopoverOutsideClickHandler, true);
								this._pythonStepPopoverOutsideClickHandler = null;
							}
							renderCodeLines();
							positionPopover();
						};
					}
				}
			};
			renderCodeLines();
		} else if (metadataValue) {
			const metaContainer = append(popover, $('.python-step-popover-code-box'));
			const row = append(metaContainer, $('.python-step-popover-code-line', {
				style: 'display: flex; align-items: center; gap: 8px; padding: 4px 10px;'
			}));
			if (metadataLabel) {
				append(row, $('span', {
					style: 'font-size: 11px; font-weight: 600; color: #94a3b8; white-space: nowrap;'
				}, `${metadataLabel}:`));
			}
			append(row, $('span.python-step-popover-codetext', {
				style: 'font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; color: #f1f5f9; word-break: break-all;'
			}, metadataValue));
		}

		// 2.5. Sub-Workflow Last Runtime Inputs section
		if (comp?.type === 'sub_workflow') {
			let lastInputsObj: Record<string, unknown> | undefined = wfComponent(comp).lastExecutionInputs;
			if (lastInputsObj === undefined && typeof wfComponent(comp).lastExecutionLog === 'string') {
				const logStr = String(wfComponent(comp).lastExecutionLog);
				const inputsMatch = logStr.match(/(?:^|\n)Inputs:\s*(\{[\s\S]*?\})(?:\nOutputs:|$)/);
				if (inputsMatch && inputsMatch[1]) {
					try {
						lastInputsObj = JSON.parse(inputsMatch[1]);
					} catch { }
				}
			}
			if (lastInputsObj && typeof lastInputsObj === 'object') {
				const inputEntries = Object.entries(lastInputsObj);
				const inputsSection = append(popover, $('.python-step-popover-runtime'));
				const inputsTitle = append(inputsSection, $('div.python-step-popover-runtime-title', {
					style: 'color: #c084fc;'
				}, `Last Runtime Inputs (${inputEntries.length}):`));
				void inputsTitle;
				const inputsValBox = append(inputsSection, $('pre.python-step-popover-runtime-val', {
					style: 'max-height: 180px; overflow-y: auto; border-color: rgba(192, 132, 252, 0.28);'
				}));
				if (inputEntries.length === 0) {
					inputsValBox.textContent = '(no inputs)';
				} else {
					let formattedInputs = '';
					try {
						formattedInputs = JSON.stringify(lastInputsObj, null, 2);
					} catch {
						formattedInputs = inputEntries.map(([k, v]) => `${k}: ${String(v)}`).join('\n');
					}
					inputsValBox.textContent = formattedInputs.length > 1200 ? formattedInputs.substring(0, 1200) + '\n...' : formattedInputs;
				}
			}
		}

		// 2.5 Failed Step Error Banner (if this exact capsule failed in the effective run)
		const effRunForErr = this._getEffectiveRunForNode(node.id);
		const nodeRunStateForErr = effRunForErr?.nodeStates?.[node.id];
		const isThisFailedStep = Boolean(
			nodeRunStateForErr?.status === 'failed' && (
				nodeRunStateForErr.failedStepIndex !== undefined
					? nodeRunStateForErr.failedStepIndex === stepIndex
					: Boolean(nodeRunStateForErr.failedStepId && nodeRunStateForErr.failedStepId === step.id)
			)
		);
		if (isThisFailedStep) {
			const errSection = append(popover, $('.python-step-popover-error'));
			append(errSection, $('div.python-step-popover-error-title', {}, `\u2717 Execution Error (Step #${stepIndex + 1}):`));
			const errValBox = append(errSection, $('pre.python-step-popover-error-val'));
			errValBox.textContent = nodeRunStateForErr?.failedStepError || nodeRunStateForErr?.error || 'Step failed during execution.';
		}

		// 3. Runtime Output / Last Displayed Content section
		const isDisplayStep = Boolean(comp?.type === 'display' || /^DISPLAY\s*\(/i.test((fullCode || '').trim()));
		if (isDisplayStep) {
			const rtSection = append(popover, $('.python-step-popover-runtime'));
			append(rtSection, $('div.python-step-popover-runtime-title', {}, 'Last Displayed Content:'));
			const rtValBox = append(rtSection, $('pre.python-step-popover-runtime-val'));
			rtValBox.style.maxHeight = '240px';
			rtValBox.style.overflow = 'auto';
			rtValBox.style.whiteSpace = 'pre-wrap';
			rtValBox.style.wordBreak = 'break-word';
			if (runtimeValStr) {
				rtValBox.textContent = runtimeValStr.length > 1500 ? runtimeValStr.substring(0, 1500) + '\n... (truncated)' : runtimeValStr;
			} else {
				rtValBox.style.opacity = '0.6';
				rtValBox.style.fontStyle = 'italic';
				rtValBox.textContent = '(Not displayed yet — run node or click Test to preview)';
			}
		} else if (runtimeValStr) {
			const rtSection = append(popover, $('.python-step-popover-runtime'));
			const rtTitle = isThisFailedStep ? 'Previous Iteration Value (stale — before this error):' : 'Last Runtime Value:';
			append(rtSection, $('div.python-step-popover-runtime-title', {}, rtTitle));
			const rtValBox = append(rtSection, $('pre.python-step-popover-runtime-val'));
			rtValBox.textContent = runtimeValStr.length > 600 ? runtimeValStr.substring(0, 600) + '...' : runtimeValStr;
		}

		// Position popover relative to targetEl
		positionPopover();
	}

	private _hidePythonStepPopover(immediate: boolean = false): void {
		if (!immediate && this._isPythonStepPopoverPinned) {
			return;
		}
		if (this._pythonStepHoverShowTimeout) {
			clearTimeout(this._pythonStepHoverShowTimeout);
			this._pythonStepHoverShowTimeout = null;
		}
		if (this._pythonStepHoverHideTimeout) {
			clearTimeout(this._pythonStepHoverHideTimeout);
			this._pythonStepHoverHideTimeout = null;
		}
		if (immediate) {
			this._isPythonStepPopoverPinned = false;
			this._activePythonPopoverNode = null;
			this._activePythonPopoverStep = null;
			if (this._pythonStepPopoverOutsideClickHandler) {
				this._targetWindow.removeEventListener('mousedown', this._pythonStepPopoverOutsideClickHandler, true);
				this._pythonStepPopoverOutsideClickHandler = null;
			}
			if (this._pythonStepHoverPopoverEl) {
				this._pythonStepHoverPopoverEl.remove();
				this._pythonStepHoverPopoverEl = null;
			}
			return;
		}
		this._pythonStepHoverHideTimeout = setTimeout(() => {
			if (this._isPythonStepPopoverPinned) {
				return;
			}
			this._activePythonPopoverNode = null;
			this._activePythonPopoverStep = null;
			if (this._pythonStepHoverPopoverEl) {
				this._pythonStepHoverPopoverEl.remove();
				this._pythonStepHoverPopoverEl = null;
			}
		}, 140);
	}

	private _pipelineNeedsAlignment(node: IFlowchartNode): boolean {
		if (!node.pipeline || node.pipeline.length === 0) {
			const hasImports = Array.isArray(node.imports) && node.imports.length > 0;
			const hasVars = (Array.isArray(node.outputVariables) && node.outputVariables.length > 0) || Boolean(node.outputVariable?.name);
			return hasImports || hasVars;
		}

		// Check 1: Tickets present in node.imports but completely absent from pipeline
		const ticketImports = (node.imports || []).filter(i =>
			['task', 'job', 'project', 'case', 'issue', 'workflow', 'agent', 'ticket'].includes((i.type || '').toLowerCase()) || Boolean(i.name)
		);
		const seenRunners = new Set(node.pipeline.filter(s => s.type === 'run_ticket').map(s => s.ticketName).filter(Boolean));
		for (const imp of ticketImports) {
			if (imp.name && !seenRunners.has(imp.name)) {
				return true;
			}
		}

		// Check 2: Variables present in node.outputVariables but completely absent from pipeline
		const pipelineVars = new Set(
			node.pipeline
				.filter(s => s.type === 'set_variable' || s.type === 'call_function')
				.map(s => s.targetVariable?.replace(/^@/, ''))
				.filter(Boolean)
		);
		const pipelineExprs = new Set(
			node.pipeline
				.filter(s => s.type === 'set_variable' || s.type === 'call_function')
				.map(s => (s.expression || '').trim())
				.filter(Boolean)
		);
		const nodeVars = (node.outputVariables || []).filter(v => Boolean(v.name && v.name.replace(/^@/, '').trim()));
		for (const v of nodeVars) {
			const vName = v.name.replace(/^@/, '').trim();
			const vExpr = (v.expression || v.initialValue || '').trim();
			if (!pipelineVars.has(vName) && (!vExpr || !pipelineExprs.has(vExpr))) {
				return true;
			}
		}

		return false;
	}

	private _deduplicateNodePipeline(node: IFlowchartNode): boolean {
		if (!node.pipeline || node.pipeline.length === 0) {
			return false;
		}
		const callFnExprs = new Set<string>();
		const callFnVars = new Set<string>();
		for (const step of node.pipeline) {
			if (step.type === 'call_function') {
				const expr = (step.expression || '').replace(/\r\n/g, '\n').trim();
				if (expr) { callFnExprs.add(expr); }
				const tv = step.targetVariable?.replace(/^@/, '').trim();
				if (tv) { callFnVars.add(tv); }
			}
		}
		const beforeLen = node.pipeline.length;
		const seenSetVarExprs = new Set<string>();
		node.pipeline = node.pipeline.filter(step => {
			if (step.type !== 'set_variable') {
				return true;
			}
			const expr = (step.expression || '').replace(/\r\n/g, '\n').trim();
			const tv = step.targetVariable?.replace(/^@/, '').trim();
			const fullAssign = (tv && expr && !/^[a-zA-Z_][a-zA-Z0-9_]*\s*=/.test(expr)) ? `${tv} = ${expr}` : expr;
			if ((expr && callFnExprs.has(expr)) || (fullAssign && callFnExprs.has(fullAssign)) || (tv && callFnVars.has(tv))) {
				return false;
			}
			const dedupKey = fullAssign || tv || '';
			if (dedupKey && seenSetVarExprs.has(dedupKey)) {
				return false;
			}
			if (dedupKey) {
				seenSetVarExprs.add(dedupKey);
			}
			return true;
		});
		return node.pipeline.length !== beforeLen;
	}

	private _syncFromNode(node: IFlowchartNode, silent: boolean = false): void {
		if (!node.pipeline) { node.pipeline = []; }
		this._deduplicateNodePipeline(node);

		const ticketImports = (node.imports || []).filter(i =>
			['task', 'job', 'project', 'case', 'issue', 'workflow', 'agent', 'ticket'].includes((i.type || '').toLowerCase()) || Boolean(i.name)
		);
		const nodeVars = this._getNodeVariables(node);

		// Clean up any legacy targetVariable on run_ticket steps
		for (const step of node.pipeline) {
			if (step.type === 'run_ticket' && step.targetVariable) {
				delete step.targetVariable;
			}
		}

		if (node.pipeline.length === 0) {
			// Initialize pipeline from imports first, then variables
			for (const imp of ticketImports) {
				node.pipeline.push({
					id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
					type: 'run_ticket',
					ticketName: imp.name,
					ticketType: imp.type,
					ticketUri: imp.uri,
					parameters: imp.parameters
				});
			}
			for (const v of nodeVars) {
				const cleanVar = v.name.replace(/^@/, '').trim();
				if (cleanVar) {
					const rawVal = (v.expression || v.initialValue || 'None').trim();
					const fullExpr = /^[a-zA-Z_][a-zA-Z0-9_]*\s*=/.test(rawVal) ? rawVal : `${cleanVar} = ${rawVal}`;
					node.pipeline.push({
						id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
						type: 'call_function',
						targetVariable: cleanVar,
						functionName: 'PYTHON',
						expression: fullExpr
					});
				}
			}
		} else {
			// Pipeline already exists: only append any newly added imports missing from pipeline
			const existingRunners = new Set(node.pipeline.filter(s => s.type === 'run_ticket').map(s => s.ticketName).filter(Boolean));
			for (const imp of ticketImports) {
				if (imp.name && !existingRunners.has(imp.name)) {
					existingRunners.add(imp.name);
					node.pipeline.push({
						id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
						type: 'run_ticket',
						ticketName: imp.name,
						ticketType: imp.type,
						ticketUri: imp.uri,
						parameters: imp.parameters
					});
				}
			}
		}

		this._saveFlowchartData();
		this._renderNodes();
		if (this._pipelinePanelEl) {
			this._renderPipelinePanel(this._pipelinePanelEl, node);
		}
		if (!silent) {
			this._notificationService.info(`Synced from node '${node.label}': ${node.pipeline.length} step(s) aligned.`);
		}
	}

	private _syncToNode(node: IFlowchartNode, silent: boolean = false): void {
		if (!node.pipeline || node.pipeline.length === 0) {
			if (!silent) {
				this._notificationService.warn(`No execution steps in pipeline to sync to node '${node.label}'.`);
			}
			return;
		}

		if (!node.imports) { node.imports = []; }
		const newImports: typeof node.imports = [];
		const newVars: NonNullable<typeof node.outputVariables> = [];

		let updatedTickets = 0;
		let updatedVars = 0;

		// 1. Sync run_ticket steps into node.imports in pipeline order
		for (const step of node.pipeline) {
			if (step.type === 'run_ticket' && step.ticketName) {
				const existingImp = node.imports.find(imp => imp.name === step.ticketName);
				if (!newImports.some(i => i.name === step.ticketName)) {
					newImports.push({
						type: step.ticketType || existingImp?.type || 'ticket',
						name: step.ticketName,
						uri: step.ticketUri || existingImp?.uri,
						parameters: step.parameters
					});
					updatedTickets++;
				}
			} else if ((step.type === 'set_variable' || step.type === 'call_function' || step.type === 'component') && step.targetVariable) {
				const cleanVar = step.targetVariable.replace(/^@/, '');
				if (!newVars.some(v => v.name === cleanVar)) {
					const existingVar = (node.outputVariables || []).find(v => v.name.replace(/^@/, '') === cleanVar);
					newVars.push({
						name: cleanVar,
						initialValue: step.expression || existingVar?.initialValue || 'None',
						expression: step.expression
					});
					updatedVars++;
				}
			}
		}

		// Keep any original imports not in pipeline
		for (const imp of node.imports) {
			if (imp.name && !newImports.some(i => i.name === imp.name)) {
				newImports.push(imp);
			}
		}

		node.imports = newImports;
		if (newVars.length > 0 || node.outputVariables) {
			node.outputVariables = newVars;
		}
		this._ensureNodeFitsPipeline(node);

		this._saveFlowchartData();
		this._renderNodes();
		if (!silent) {
			this._notificationService.info(`Synced to node '${node.label}': ${updatedTickets} ticket(s) and ${updatedVars} variable(s) updated.`);
		}
	}

	private _ensureNodeFitsPipeline(node: IFlowchartNode): boolean {
		if (node.type === 'circle' || node.type === 'diamond') {
			return false;
		}
		let changed = false;
		if (node.label === 'Call Function' || node.label === 'State') {
			node.label = 'Python Step';
			changed = true;
		}
		return changed;
	}


	private _getAvailableTickets(currentNode?: IFlowchartNode): { label: string; detail: string; icon: ThemeIcon; insertText: string; raw: { type: string; name: string; uri?: string } }[] {
		const result: { label: string; detail: string; icon: ThemeIcon; insertText: string; raw: { type: string; name: string; uri?: string } }[] = [];
		const seen = new Set<string>();

		// 1. Current node imports
		if (currentNode?.imports) {
			for (const imp of currentNode.imports) {
				if (imp.name && !seen.has(imp.name)) {
					seen.add(imp.name);
					const style = getEntityBadgeStyle(imp.type);
					result.push({
						label: imp.name,
						detail: (imp.type || 'ticket').toUpperCase(),
						icon: style.icon,
						insertText: imp.name,
						raw: { type: imp.type || 'ticket', name: imp.name, uri: imp.uri }
					});
				}
			}
		}

		// 2. Other nodes in this workflow
		if (this._data?.nodes) {
			for (const n of this._data.nodes) {
				if (n.imports) {
					for (const imp of n.imports) {
						if (imp.name && !seen.has(imp.name)) {
							seen.add(imp.name);
							const style = getEntityBadgeStyle(imp.type);
							result.push({
								label: imp.name,
								detail: (imp.type || 'ticket').toUpperCase(),
								icon: style.icon,
								insertText: imp.name,
								raw: { type: imp.type || 'ticket', name: imp.name, uri: imp.uri }
							});
						}
					}
				}
			}
		}

		// 3. Registered entity snapshots
		try {
			const snapshots = this._entityPersistenceService.getAllSnapshots();
			for (const s of snapshots) {
				if (s.entityName && !seen.has(s.entityName)) {
					seen.add(s.entityName);
					const style = getEntityBadgeStyle(s.entityType);
					result.push({
						label: s.entityName,
						detail: (s.entityType || 'entity').toUpperCase(),
						icon: style.icon,
						insertText: s.entityName,
						raw: { type: s.entityType || 'ticket', name: s.entityName, uri: s.entityUri }
					});
				}
			}
		} catch { }

		return result;
	}

	private _getAvailableVariables(currentNode?: IFlowchartNode): { label: string; detail: string; icon?: ThemeIcon; insertText: string; isVariable?: boolean }[] {
		const result: { label: string; detail: string; icon?: ThemeIcon; insertText: string; isVariable?: boolean }[] = [];
		const seen = new Set<string>();

		// 1. Current node variables
		if (currentNode) {
			const nVars = this._getNodeVariables(currentNode);
			for (const v of nVars) {
				const cleanName = v.name.replace(/^@/, '');
				if (cleanName && !seen.has(cleanName)) {
					seen.add(cleanName);
					result.push({
						label: cleanName,
						detail: 'VARIABLE',
						insertText: cleanName,
						isVariable: true
					});
				}
			}
			if (currentNode.pipeline) {
				for (const s of currentNode.pipeline) {
					if (s.targetVariable) {
						const cleanName = s.targetVariable.replace(/^@/, '');
						if (cleanName && !seen.has(cleanName)) {
							seen.add(cleanName);
							result.push({
								label: cleanName,
								detail: 'OUTPUT VAR',
								insertText: cleanName,
								isVariable: true
							});
						}
					}
				}
			}
		}

		// 2. All nodes in workflow
		if (this._data?.nodes) {
			for (const n of this._data.nodes) {
				const nVars = this._getNodeVariables(n);
				for (const v of nVars) {
					const cleanName = v.name.replace(/^@/, '');
					if (cleanName && !seen.has(cleanName)) {
						seen.add(cleanName);
						result.push({
							label: cleanName,
							detail: 'VARIABLE',
							insertText: cleanName,
							isVariable: true
						});
					}
				}
				if (n.pipeline) {
					for (const s of n.pipeline) {
						if (s.targetVariable) {
							const cleanName = s.targetVariable.replace(/^@/, '');
							if (cleanName && !seen.has(cleanName)) {
								seen.add(cleanName);
								result.push({
									label: cleanName,
									detail: 'OUTPUT VAR',
									insertText: cleanName,
									isVariable: true
								});
							}
						}
					}
				}
			}
		}

		// 3. Ticket outputs & direct ticket names (e.g. FNDJ1-0008)
		const tickets = this._getAvailableTickets(currentNode);
		for (const t of tickets) {
			if (!seen.has(t.label)) {
				seen.add(t.label);
				result.push({
					label: t.label,
					detail: 'TICKET OUTPUT',
					icon: t.icon || Codicon.checklist,
					insertText: t.label,
					isVariable: false
				});
			}
			const ticketOut = `${t.label}.output`;
			if (!seen.has(ticketOut)) {
				seen.add(ticketOut);
				result.push({
					label: ticketOut,
					detail: 'TICKET OUT',
					icon: Codicon.output,
					insertText: ticketOut,
					isVariable: false
				});
			}
		}

		return result;
	}

	private _attachAutocomplete<TRaw = unknown>(
		input: HTMLInputElement,
		getItems: () => IWfAutocompleteItem<TRaw>[],
		onSelect: (insertText: string, rawItem?: IWfAutocompleteItem<TRaw>) => void,
		mode: 'ticket' | 'variable' | 'any' = 'any'
	): void {
		let dropdownEl: HTMLElement | null = null;
		let selectedIndex = 0;
		let filteredItems: IWfAutocompleteItem<TRaw>[] = [];

		const closeDropdown = () => {
			if (dropdownEl && dropdownEl.parentNode) {
				dropdownEl.remove();
			}
			if (this._activePipelineDropdown === dropdownEl) {
				this._activePipelineDropdown = null;
			}
			dropdownEl = null;
		};

		const renderDropdown = () => {
			const allItems = getItems();
			const val = input.value;
			let query = val.trim();
			if (query.startsWith('@')) {
				query = query.substring(1).trim();
			}
			const lowerQuery = query.toLowerCase();

			filteredItems = allItems.filter(item => {
				if (!lowerQuery) { return true; }
				return item.label.toLowerCase().includes(lowerQuery) ||
					(item.detail && item.detail.toLowerCase().includes(lowerQuery));
			});

			if (!dropdownEl) {
				if (this._activePipelineDropdown) {
					this._activePipelineDropdown.remove();
					this._activePipelineDropdown = null;
				}
				dropdownEl = document.createElement('div');
				dropdownEl.className = 'pipeline-autocomplete-dropdown';
				this._targetWindow.document.body.appendChild(dropdownEl);
				this._activePipelineDropdown = dropdownEl;
			}

			const rect = input.getBoundingClientRect();
			dropdownEl.style.left = `${Math.max(10, rect.left)}px`;
			dropdownEl.style.top = `${rect.bottom + 4}px`;
			dropdownEl.style.minWidth = `${Math.max(rect.width, 220)}px`;

			clearNode(dropdownEl);

			if (filteredItems.length === 0) {
				const empty = append(dropdownEl, $('.pipeline-autocomplete-empty'));
				empty.textContent = query ? 'No matches found' : 'No available items';
				return;
			}

			if (selectedIndex >= filteredItems.length) {
				selectedIndex = 0;
			}

			for (let idx = 0; idx < filteredItems.length; idx++) {
				const item = filteredItems[idx];
				const itemEl = append(dropdownEl, $('.pipeline-autocomplete-item'));
				if (idx === selectedIndex) {
					itemEl.classList.add('selected');
				}

				if (item.isVariable || item.detail === 'VARIABLE' || item.detail === 'OUTPUT VAR') {
					append(itemEl, $('span.item-icon.var-tag-icon', {}, '[V]'));
				} else if (item.icon) {
					append(itemEl, $('span.item-icon' + ThemeIcon.asCSSSelector(item.icon)));
				}
				append(itemEl, $('span.item-label', {}, item.label));
				if (item.detail) {
					append(itemEl, $('span.item-detail', {}, item.detail));
				}

				itemEl.onmousedown = (e) => {
					e.preventDefault();
					e.stopPropagation();
					const cur = input.value;
					if (cur.endsWith('@')) {
						input.value = cur.slice(0, -1);
					}
					onSelect(item.insertText, item);
					closeDropdown();
				};
			}
		};


		input.addEventListener('focus', () => {
			selectedIndex = 0;
			renderDropdown();
		});

		input.addEventListener('input', () => {
			selectedIndex = 0;
			renderDropdown();
		});

		input.addEventListener('keydown', (e: KeyboardEvent) => {
			if (!dropdownEl) { return; }
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				if (filteredItems.length > 0) {
					selectedIndex = (selectedIndex + 1) % filteredItems.length;
					renderDropdown();
				}
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				if (filteredItems.length > 0) {
					selectedIndex = (selectedIndex - 1 + filteredItems.length) % filteredItems.length;
					renderDropdown();
				}
			} else if (e.key === 'Enter') {
				if (filteredItems.length > 0 && selectedIndex >= 0 && selectedIndex < filteredItems.length) {
					e.preventDefault();
					e.stopPropagation();
					if (input.value.endsWith('@')) {
						input.value = input.value.slice(0, -1);
					}
					onSelect(filteredItems[selectedIndex].insertText, filteredItems[selectedIndex]);
					closeDropdown();
				}
			} else if (e.key === 'Escape') {
				closeDropdown();
			}
		});

		input.addEventListener('blur', () => {
			setTimeout(() => {
				closeDropdown();
			}, 200);
		});
	}

	/** The ticket name input of step `stepId` in the pipeline panel currently rendered into `panel`. */
	private static _getPipelinePanelTicketInput(panel: HTMLElement, stepId: string): HTMLInputElement | undefined {
		const input = wfPipelinePanelParts.get(panel)?.ticketInputsByStepId.get(stepId);
		return input && panel.contains(input) ? input : undefined;
	}

	private _renderPipelinePanel(panel: HTMLElement, node: IFlowchartNode): void {
		const previousParts = wfPipelinePanelParts.get(panel);
		const existingBody = previousParts?.body && panel.contains(previousParts.body) ? previousParts.body : undefined;
		const previousScrollTop = existingBody ? existingBody.scrollTop : 0;
		clearNode(panel);
		const panelParts: { body?: HTMLElement; readonly ticketInputsByStepId: Map<string, HTMLInputElement> } = { ticketInputsByStepId: new Map() };
		wfPipelinePanelParts.set(panel, panelParts);

		// Header
		const header = append(panel, $('.pipeline-panel-header'));
		const titleGroup = append(header, $('.pipeline-panel-title-group'));
		append(titleGroup, $('span' + ThemeIcon.asCSSSelector(Codicon.listOrdered) + '.pipeline-panel-title-icon'));
		append(titleGroup, $('span.pipeline-panel-title', {}, 'Node Pipeline'));

		const nodeTag = append(titleGroup, $('span.pipeline-node-tag'));
		nodeTag.textContent = node.label || 'Node';
		nodeTag.title = `Node: ${node.label || 'Node'}`;

		const actions = append(header, $('.pipeline-panel-actions'));

		// Dock Side Toggle Button
		const dockBtn = append(actions, $('.pipeline-action-btn'));
		const isLeft = this._pipelineDockSide === 'left';
		append(dockBtn, $('span' + ThemeIcon.asCSSSelector(isLeft ? Codicon.layoutSidebarRight : Codicon.layoutSidebarLeft)));
		dockBtn.title = isLeft ? 'Dock to Right' : 'Dock to Left (Next to Toolbox)';
		dockBtn.onclick = (e) => {
			e.stopPropagation();
			this._pipelineDockSide = isLeft ? 'right' : 'left';
			this._storageService.store('workflowEditor.pipelineDockSide', this._pipelineDockSide, StorageScope.PROFILE, StorageTarget.USER);
			panel.className = `workflow-pipeline-panel dock-${this._pipelineDockSide}`;
			this._renderPipelinePanel(panel, node);
		};

		// Close Button
		const closeBtn = append(actions, $('.pipeline-action-btn.close-btn'));
		append(closeBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
		closeBtn.title = 'Close Pipeline Panel';
		closeBtn.onclick = (e) => {
			e.stopPropagation();
			this._closeNodePipelinePanel();
		};

		// Panel Body
		const body = append(panel, $('.pipeline-panel-body'));
		panelParts.body = body;

		// --- UPPER SECTION: 1. Imports ---
		const importsSec = append(body, $('.pipeline-section'));
		const importsHeader = append(importsSec, $('.pipeline-section-header'));
		const importCount = node.imports?.length || 0;
		append(importsHeader, $('span.pipeline-section-title', {}, `1. IMPORTS (${importCount})`));

		// Drop zone & imports list
		const importsList = append(importsSec, $('.pipeline-imports-list'));

		const renderImportCards = () => {
			clearNode(importsList);
			if (!node.imports || node.imports.length === 0) {
				const emptyDrop = append(importsList, $('.pipeline-drop-zone'));
				emptyDrop.textContent = 'Drag & drop tickets here from explorer or canvas to import';
			} else {
				for (let impIdx = 0; impIdx < node.imports.length; impIdx++) {
					const imp = node.imports[impIdx];
					const card = append(importsList, $('.pipeline-import-card'));
					card.draggable = true;
					card.dataset.importIndex = String(impIdx);

					// HTML5 Drag & Drop reordering for imported tickets
					card.ondragstart = (e: DragEvent) => {
						e.dataTransfer?.setData('text/pipeline-import-idx', String(impIdx));
						card.classList.add('is-dragging');
					};
					card.ondragover = (e: DragEvent) => {
						e.preventDefault();
						const rect = card.getBoundingClientRect();
						const isAbove = e.clientY < (rect.top + rect.height / 2);
						card.classList.toggle('drag-over-above', isAbove);
						card.classList.toggle('drag-over-below', !isAbove);
					};
					card.ondragleave = () => {
						card.classList.remove('drag-over-above', 'drag-over-below');
					};
					card.ondrop = (e: DragEvent) => {
						e.preventDefault();
						e.stopPropagation();
						card.classList.remove('drag-over-above', 'drag-over-below');
						const rawFrom = e.dataTransfer?.getData('text/pipeline-import-idx');
						if (rawFrom !== undefined && rawFrom !== '') {
							const fromIdx = parseInt(rawFrom, 10);
							if (!isNaN(fromIdx) && fromIdx !== impIdx && node.imports) {
								const [moved] = node.imports.splice(fromIdx, 1);
								node.imports.splice(impIdx, 0, moved);
								this._saveFlowchartData();
								this._renderNodes();
								this._renderPipelinePanel(panel, node);
							}
						}
					};
					card.ondragend = () => {
						card.classList.remove('is-dragging', 'drag-over-above', 'drag-over-below');
					};

					card.ondblclick = (e) => {
						const target = e.target as HTMLElement;
						if (target.closest('.pipeline-import-add-btn') || target.closest('.pipeline-icon-btn') || target.closest('.pipeline-drag-handle')) {
							return;
						}
						e.stopPropagation();
						e.preventDefault();
						this._openModuleInEditor(imp);
					};

					// allow-any-unicode-next-line
					// Left: Drag handle ≡
					const dragHandle = append(card, $('.pipeline-drag-handle'));
					append(dragHandle, $('span' + ThemeIcon.asCSSSelector(Codicon.gripper)));
					dragHandle.title = 'Drag \u2261 to reorder import';

					const info = append(card, $('.pipeline-import-info'));
					const style = getEntityBadgeStyle(imp.type);

					// 1. Icon on the left (colored with system type color, aligned)
					const iconSpan = append(info, $('span.pipeline-import-type-icon' + ThemeIcon.asCSSSelector(style.icon)));
					iconSpan.style.color = style.color;

					// 2. Ticket ID / Name
					const nameSpan = append(info, $('span.pipeline-import-name', {}, imp.name));
					nameSpan.title = `${imp.type || 'ticket'}: ${imp.name}\n(Double-click to open in Editor Tab)`;

					// 3. Type Badge pill following the name (matching system tree badge)
					const typeBadge = append(info, $('span.pipeline-type-badge', {}, (imp.type || 'ticket').toUpperCase()));
					typeBadge.style.background = style.bg;
					typeBadge.style.color = style.color;
					typeBadge.title = `Entity Type: ${(imp.type || 'ticket').toUpperCase()}`;

					const actionsEl = append(card, $('.pipeline-import-actions'));

					// Open in Tab button
					const openInTabBtn = append(actionsEl, $('.pipeline-icon-btn'));
					append(openInTabBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.linkExternal)));
					openInTabBtn.title = `Open '${imp.name}' in Editor Tab`;
					openInTabBtn.onclick = (e) => {
						e.stopPropagation();
						this._openModuleInEditor(imp);
					};

					// "Add Step" button (standard button, no plus sign)
					const addStepBtn = append(actionsEl, $('.pipeline-import-add-btn'));
					append(addStepBtn, $('span', {}, 'Add Step'));
					addStepBtn.title = `Add '${imp.name}' execution step to pipeline below`;
					addStepBtn.onclick = (e) => {
						e.stopPropagation();
						if (!node.pipeline) { node.pipeline = []; }
						node.pipeline.push({
							id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
							type: 'run_ticket',
							ticketName: imp.name,
							ticketType: imp.type,
							ticketUri: imp.uri
						});
						this._saveFlowchartData();
						this._renderPipelinePanel(panel, node);
					};

					// Un-import button (trash can)
					const unimportBtn = append(actionsEl, $('.pipeline-icon-btn'));
					append(unimportBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
					unimportBtn.title = `Remove '${imp.name}' from imports`;
					unimportBtn.onclick = (e) => {
						e.stopPropagation();
						node.imports = (node.imports || []).filter(i => !(i.type === imp.type && i.name === imp.name));
						this._saveFlowchartData();
						this._renderNodes();
						this._renderPipelinePanel(panel, node);
					};
				}
			}
		};
		renderImportCards();

		// Handle drag & drop tickets directly onto imports section
		importsSec.ondragover = (e: DragEvent) => {
			e.preventDefault();
			importsSec.classList.add('drag-over');
		};
		importsSec.ondragleave = () => {
			importsSec.classList.remove('drag-over');
		};
		importsSec.ondrop = (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			importsSec.classList.remove('drag-over');
			const dataStr = e.dataTransfer?.getData('text/plain');
			if (!dataStr || !dataStr.startsWith('any-agent-import:')) { return; }

			const parts = dataStr.split(':');
			const type = parts[1];
			const name = parts[2];

			if (!node.imports) { node.imports = []; }
			if (!node.imports.some(imp => imp.type === type && imp.name === name)) {
				node.imports.push({ type, name });
				// Also auto-append step to pipeline
				if (!node.pipeline) { node.pipeline = []; }
				node.pipeline.push({
					id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
					type: 'run_ticket',
					ticketName: name,
					ticketType: type
				});
				this._saveFlowchartData();
				this._renderNodes();
				this._renderPipelinePanel(panel, node);
				this._notificationService.info(`Imported ${type} '${name}' and added execution step.`);
			}
		};

		// --- LOWER SECTION: 2. Execution Sequence Pipeline ---
		const pipelineSec = append(body, $('.pipeline-section'));
		const pipelineHeader = append(pipelineSec, $('.pipeline-section-header'));
		const stepCount = node.pipeline?.length || 0;
		append(pipelineHeader, $('span.pipeline-section-title', {}, `2. EXECUTION SEQUENCE (${stepCount} STEPS)`));

		const syncFromHeaderBtn = append(pipelineHeader, $('.pipeline-btn.pipeline-btn-outline'));
		syncFromHeaderBtn.style.padding = '2px 8px';
		syncFromHeaderBtn.style.fontSize = '10px';
		append(syncFromHeaderBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowDown)));
		append(syncFromHeaderBtn, $('span', {}, 'Sync From Node'));
		syncFromHeaderBtn.title = 'Sync imported tickets and variables from canvas node into execution sequence';
		syncFromHeaderBtn.onclick = () => {
			this._syncFromNode(node);
		};

		const stepsList = append(pipelineSec, $('.pipeline-steps-list'));

		if (!node.pipeline || node.pipeline.length === 0) {
			const emptyState = append(stepsList, $('.pipeline-empty-state'));
			append(emptyState, $('span' + ThemeIcon.asCSSSelector(Codicon.info)));
			append(emptyState, $('span', {}, 'No execution steps configured yet.'));
			const emptyActions = append(emptyState, $('.pipeline-toolbar-btns'));
			emptyActions.style.justifyContent = 'center';

			const syncFromEmptyBtn = append(emptyActions, $('.pipeline-btn.pipeline-btn-secondary'));
			append(syncFromEmptyBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowDown)));
			append(syncFromEmptyBtn, $('span', {}, 'Sync From Node'));
			syncFromEmptyBtn.onclick = () => {
				this._syncFromNode(node);
			};

			const addRunEmptyBtn = append(emptyActions, $('.pipeline-btn.pipeline-btn-run'));
			append(addRunEmptyBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.play)));
			append(addRunEmptyBtn, $('span', {}, 'Add Runner'));
			addRunEmptyBtn.onclick = () => {
				if (!node.pipeline) { node.pipeline = []; }
				const newStepId = `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
				node.pipeline.push({
					id: newStepId,
					type: 'run_ticket',
					ticketName: '',
					parameters: ''
				});
				this._saveFlowchartData();
				this._renderPipelinePanel(panel, node);
				setTimeout(() => {
					const input = WorkflowEditor._getPipelinePanelTicketInput(panel, newStepId);
					if (input) { input.focus(); }
				}, 50);
			};
		} else {
			const activeRun = this._getEffectiveRunForNode(node.id);
			const nodeRunState = activeRun?.nodeStates?.[node.id];
			for (let i = 0; i < node.pipeline.length; i++) {
				const step = node.pipeline[i];
				const isFailedStep = nodeRunState?.status === 'failed' && nodeRunState?.failedStepIndex === i;
				const stepCard = append(stepsList, $('.pipeline-step-card' + (isFailedStep ? '.step-failed' : '') + (step.disabled ? '.step-card-disabled' : '')));
				stepCard.draggable = true;
				stepCard.dataset.stepIndex = String(i);
				stepCard.dataset.stepId = step.id;
				if (step.type === 'run_ticket' && step.ticketName) {
					stepCard.dataset.ticketName = step.ticketName;
					stepCard.title = `Step #${i + 1} (${step.ticketName})\nDouble-click to open Ticket in Editor Tab`;
					stepCard.ondblclick = (e) => {
						const target = e.target as HTMLElement;
						if (target.tagName === 'INPUT' || target.closest('.pipeline-icon-btn') || target.closest('.pipeline-drag-handle')) {
							return;
						}
						e.stopPropagation();
						e.preventDefault();
						this._openModuleInEditor({
							type: step.ticketType || 'ticket',
							name: step.ticketName,
							uri: step.ticketUri
						});
					};
				}

				// HTML5 Drag & Drop Reordering Handlers
				stepCard.ondragstart = (e: DragEvent) => {
					e.dataTransfer?.setData('text/pipeline-step-idx', String(i));
					stepCard.classList.add('is-dragging');
				};

				stepCard.ondragover = (e: DragEvent) => {
					e.preventDefault();
					const rect = stepCard.getBoundingClientRect();
					const isAbove = e.clientY < (rect.top + rect.height / 2);
					stepCard.classList.toggle('drag-over-above', isAbove);
					stepCard.classList.toggle('drag-over-below', !isAbove);
				};

				stepCard.ondragleave = () => {
					stepCard.classList.remove('drag-over-above', 'drag-over-below');
				};

				stepCard.ondrop = (e: DragEvent) => {
					e.preventDefault();
					e.stopPropagation();
					stepCard.classList.remove('drag-over-above', 'drag-over-below');
					const rawFrom = e.dataTransfer?.getData('text/pipeline-step-idx');
					if (rawFrom !== undefined && rawFrom !== '') {
						const fromIdx = parseInt(rawFrom, 10);
						if (!isNaN(fromIdx) && fromIdx !== i && node.pipeline) {
							const [moved] = node.pipeline.splice(fromIdx, 1);
							node.pipeline.splice(i, 0, moved);
							this._syncToNode(node, true);
							this._saveFlowchartData();
							this._renderPipelinePanel(panel, node);
						}
					}
				};

				stepCard.ondragend = () => {
					stepCard.classList.remove('is-dragging', 'drag-over-above', 'drag-over-below');
				};

				// Left Column: #1 (top) and Drag Handle ::: (bottom)
				const leftCol = append(stepCard, $('.pipeline-step-left-col'));
				const stepNum = append(leftCol, $('.pipeline-step-number'));
				stepNum.textContent = `#${i + 1}`;

				const dragHandle = append(leftCol, $('.pipeline-drag-handle'));
				append(dragHandle, $('span' + ThemeIcon.asCSSSelector(Codicon.gripper)));
				dragHandle.title = 'Drag \u2261 to reorder step';

				// Center: Step Content
				const content = append(stepCard, $('.pipeline-step-content'));
				const topRow = append(content, $('.pipeline-step-top-row'));

				if (step.type === 'run_ticket') {
					// allow-any-unicode-next-line
					// 1. Badge: [▶ RUN]
					const badge = append(topRow, $('.pipeline-step-badge-run'));
					append(badge, $('span' + ThemeIcon.asCSSSelector(Codicon.play)));
					append(badge, $('span', {}, 'RUN'));

					// 2. Ticket selection input with autocomplete
					const ticketInput = append(topRow, $('input.pipeline-step-input.pipeline-ticket-input')) as HTMLInputElement;
					if (!panelParts.ticketInputsByStepId.has(step.id)) {
						panelParts.ticketInputsByStepId.set(step.id, ticketInput);
					}
					ticketInput.type = 'text';
					ticketInput.value = step.ticketName || '';
					ticketInput.placeholder = '@ Select or type ticket...';
					ticketInput.title = 'Ticket to execute (type @ or text to search)';

					this._attachAutocomplete(
						ticketInput,
						() => this._getAvailableTickets(node),
						(selectedText, rawItem) => {
							ticketInput.value = selectedText;
							step.ticketName = selectedText;
							if (rawItem?.raw?.type) { step.ticketType = rawItem.raw.type; }
							if (rawItem?.raw?.uri) { step.ticketUri = rawItem.raw.uri; }
							this._syncToNode(node, true);
							this._saveFlowchartData();
						},
						'ticket'
					);

					ticketInput.onchange = () => {
						const cleanVal = ticketInput.value.trim().replace(/^@/, '');
						step.ticketName = cleanVal;
						this._syncToNode(node, true);
						this._saveFlowchartData();
					};

					// Clean up legacy targetVariable on run_ticket
					delete step.targetVariable;

					// Line 2: Parameters row: PARAM: [input] (Moved from topRow to replace Output to)
					const cfgRow = append(content, $('.pipeline-step-config-row'));
					append(cfgRow, $('span.pipeline-cfg-label', {}, 'PARAM:'));
					const paramInput = append(cfgRow, $('input.pipeline-step-input.pipeline-param-input')) as HTMLInputElement;
					paramInput.type = 'text';
					paramInput.value = step.parameters || '';
					paramInput.placeholder = 'PARAM (e.g. 1,2,3,4,5 or --fast)';
					paramInput.title = 'Runtime PARAM for this ticket';
					paramInput.oninput = () => {
						step.parameters = paramInput.value.trim() || undefined;
						this._syncToNode(node, true);
						this._saveFlowchartData();
					};
					paramInput.onchange = () => {
						step.parameters = paramInput.value.trim() || undefined;
						this._syncToNode(node, true);
						this._saveFlowchartData();
					};
				} else if (step.type === 'set_variable') {
					// 1. Badge: [V] VAR
					const badge = append(topRow, $('.pipeline-step-badge-var'));
					const vTag = append(badge, $('span.var-icon-badge'));
					vTag.textContent = '[V]';
					vTag.style.color = '#38bdf8';
					vTag.style.marginRight = '2px';
					append(badge, $('span', {}, 'VAR'));

					// 2. Variable name input
					const varNameInput = append(topRow, $('input.pipeline-step-input.pipeline-var-name-input')) as HTMLInputElement;
					varNameInput.type = 'text';
					varNameInput.value = (step.targetVariable || '').replace(/^@/, '');
					varNameInput.placeholder = 'Variable name (e.g. current_user)';
					varNameInput.title = 'Define or assign Variable name';
					varNameInput.oninput = () => {
						step.targetVariable = varNameInput.value.trim().replace(/^@/, '') || undefined;
						this._syncToNode(node, true);
						this._saveFlowchartData();
					};
					varNameInput.onchange = () => {
						step.targetVariable = varNameInput.value.trim().replace(/^@/, '') || 'var';
						this._syncToNode(node, true);
						this._saveFlowchartData();
					};

					// Line 2: Value row: Value = [input]
					const cfgRow = append(content, $('.pipeline-step-config-row'));
					append(cfgRow, $('span.pipeline-cfg-label', {}, 'Value ='));
					const valInput = append(cfgRow, $('input.pipeline-step-input.pipeline-var-val-input')) as HTMLInputElement;
					valInput.type = 'text';
					valInput.value = step.expression || '';
					valInput.placeholder = 'e.g. \'initial_val\', ticket.output, or 0';
					valInput.title = 'Initial value or expression (type @ to autocomplete)';


					this._attachAutocomplete(
						valInput,
						() => this._getAvailableVariables(node),
						(selectedText) => {
							valInput.value = selectedText;
							step.expression = selectedText;
							this._syncToNode(node, true);
							this._saveFlowchartData();
						},
						'variable'
					);

					valInput.oninput = () => {
						step.expression = valInput.value.trim() || undefined;
						this._syncToNode(node, true);
						this._saveFlowchartData();
					};
					valInput.onchange = () => {
						step.expression = valInput.value.trim() || undefined;
						this._syncToNode(node, true);
						this._saveFlowchartData();
					};
				} else if (step.type === 'call_function' || step.type === 'custom_code') {
					// 1. Badge: PYTHON
					const badge = append(topRow, $('.pipeline-step-badge-fn'));
					const fnTag = append(badge, $('span.fn-icon-badge' + ThemeIcon.asCSSSelector(Codicon.python)));
					fnTag.style.color = '#c084fc';
					fnTag.style.marginRight = '3px';
					append(badge, $('span', {}, 'PYTHON'));

					// 2. Python expression input
					const fnInput = append(topRow, $('input.pipeline-step-input.pipeline-fn-input')) as HTMLInputElement;
					fnInput.type = 'text';
					const cleanVar = step.targetVariable?.replace(/^@/, '');
					const rawStepExpr = (step.expression ?? (cleanVar && step.functionName && step.functionName !== 'PYTHON' ? `${cleanVar} = ${step.functionName}()` : '')).replace(/(^|[^a-zA-Z0-9_])@([a-zA-Z_][a-zA-Z0-9_]*)/g, '$1$2');
					fnInput.value = /^(?:res\s*=\s*)?RUN_TICKETS\(\s*ticket\s*=\s*""\s*(?:,\s*params\s*=\s*\{\s*\}\s*)?\)$/i.test(rawStepExpr.trim()) ? '' : rawStepExpr;
					fnInput.placeholder = '';
					fnInput.title = 'Python Step Expression (Double-click pill on node for full multiline Python editor)';

					const commitFn = () => {
						const val = fnInput.value.trim();
						step.expression = val || undefined;
						const m = val.match(/^(?:@?([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*=\s*)?([a-zA-Z0-9_]+)\s*(?:\(([\s\S]*)\))?$/);
						if (m) {
							if (m[1]) { step.targetVariable = m[1].replace(/^@/, ''); }
							if (m[2]) { step.functionName = m[2]; }
						}
						this._syncToNode(node, true);
						this._saveFlowchartData();
					};

					fnInput.oninput = commitFn;
					fnInput.onchange = commitFn;

					// Quick helper chips row
					const cfgRow = append(content, $('.pipeline-step-config-row'));
					cfgRow.style.display = 'flex';
					cfgRow.style.gap = '4px';
					cfgRow.style.alignItems = 'center';
					cfgRow.style.flexWrap = 'wrap';

					const addPipelineChip = (label: string, snippet: string) => {
						const chip = append(cfgRow, $('.node-function-template-chip'));
						chip.textContent = label;
						chip.title = `Click to insert ${label} at cursor`;
						chip.onmousedown = (e) => {
							e.stopPropagation();
							e.preventDefault();
						};
						chip.onclick = (e) => {
							e.stopPropagation();
							const selStart = fnInput.selectionStart ?? fnInput.value.length;
							const selEnd = fnInput.selectionEnd ?? selStart;
							const before = fnInput.value.substring(0, selStart);
							const after = fnInput.value.substring(selEnd);
							fnInput.value = `${before}${snippet}${after}`;
							fnInput.focus();
							const quoteIdx = snippet.indexOf('""');
							if (quoteIdx !== -1) {
								fnInput.selectionStart = fnInput.selectionEnd = selStart + quoteIdx + 1;
							} else if (snippet.endsWith('()')) {
								fnInput.selectionStart = fnInput.selectionEnd = selStart + snippet.length - 1;
							} else {
								fnInput.selectionStart = fnInput.selectionEnd = selStart + snippet.length;
							}
							commitFn();
						};
					};
					addPipelineChip('RUN_TICKETS', 'RUN_TICKETS(ticket="")');
					addPipelineChip('CREATE_TICKETS', 'CREATE_TICKETS(ticket_type="Task", title="", path=".")');
					addPipelineChip('GET_TICKETS', 'GET_TICKETS(ticket="")');
					addPipelineChip('GET_OUTPUTS', 'GET_OUTPUTS(ticket="")');
					addPipelineChip('DISPLAY', 'DISPLAY()');
				}

				if (isFailedStep) {
					const failBadge = append(topRow, $('.pipeline-step-badge-error'));
					failBadge.textContent = 'FAILED';
					failBadge.title = nodeRunState?.error || 'Step execution failed';

					if (nodeRunState?.error) {
						const errBanner = append(content, $('.pipeline-step-error-banner'));
						errBanner.textContent = `Error: ${nodeRunState.error}`;
						errBanner.title = 'Click to open execution log';
						errBanner.onclick = (e) => {
							e.stopPropagation();
							this._openDrawerTab('logs', node.id);
						};
					}
				}

				// Right: Actions
				const stepActions = append(stepCard, $('.pipeline-step-actions'));

				if (step.type === 'run_ticket' && step.ticketName) {
					const openTabBtn = append(stepActions, $('.pipeline-icon-btn'));
					append(openTabBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.linkExternal)));
					openTabBtn.title = `Open '${step.ticketName}' in Editor Tab`;
					openTabBtn.onclick = (e) => {
						e.stopPropagation();
						this._openModuleInEditor({
							type: step.ticketType || 'ticket',
							name: step.ticketName,
							uri: step.ticketUri
						});
					};
				}

				// Enable/Disable (Comment Out) Toggle Button
				const toggleStepBtn = append(stepActions, $('.pipeline-icon-btn.pipeline-step-toggle-btn'));
				append(toggleStepBtn, $('span' + ThemeIcon.asCSSSelector(step.disabled ? Codicon.circleSlash : Codicon.check)));
				toggleStepBtn.title = step.disabled ? 'Step is commented out (disabled). Click to re-enable.' : 'Step is active. Click to comment out (disable).';
				toggleStepBtn.style.color = step.disabled ? '#94a3b8' : '#4ade80';
				toggleStepBtn.onclick = (e) => {
					e.stopPropagation();
					step.disabled = !step.disabled;
					this._syncToNode(node, true);
					this._saveFlowchartData();
					this._renderNodes();
					this._renderPipelinePanel(panel, node);
				};

				// Delete Step Button
				const delBtn = append(stepActions, $('.pipeline-icon-btn'));
				append(delBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
				delBtn.title = 'Delete this execution step';
				delBtn.onclick = (e) => {
					e.stopPropagation();
					if (node.pipeline) {
						node.pipeline.splice(i, 1);
						this._syncToNode(node, true);
						this._saveFlowchartData();
						this._renderPipelinePanel(panel, node);
					}
				};
			}
		}

		// Toolbar: Add Steps
		const toolbarRow = append(pipelineSec, $('.pipeline-toolbar-btns'));

		// 1. Add Runner Button
		const addRunBtn = append(toolbarRow, $('.pipeline-btn.pipeline-btn-run'));
		append(addRunBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.play)));
		append(addRunBtn, $('span', {}, 'Add Runner'));
		addRunBtn.title = 'Add ticket execution step to pipeline';
		addRunBtn.onclick = (e) => {
			e.stopPropagation();
			if (!node.pipeline) { node.pipeline = []; }
			const newStepId = `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
			const newStep: INodePipelineStep = {
				id: newStepId,
				type: 'run_ticket',
				ticketName: '',
				parameters: ''
			};
			node.pipeline.push(newStep);
			this._syncToNode(node, true);
			this._saveFlowchartData();
			this._renderPipelinePanel(panel, node);
			setTimeout(() => {
				const input = WorkflowEditor._getPipelinePanelTicketInput(panel, newStepId);
				if (input) { input.focus(); }
			}, 50);
		};

		// 2. Add Unified Python Step
		const addFnBtn = append(toolbarRow, $('.pipeline-btn.pipeline-btn-secondary'));
		const fnBtnTag = append(addFnBtn, $('span.fn-icon-badge' + ThemeIcon.asCSSSelector(Codicon.python)));
		fnBtnTag.style.color = '#c084fc';
		fnBtnTag.style.marginRight = '4px';
		append(addFnBtn, $('span', {}, 'Add Python Step'));
		addFnBtn.title = 'Add Python step (variables, expressions, loops, functions, or built-in ticket calls)';
		addFnBtn.onclick = (e) => {
			e.stopPropagation();
			if (!node.pipeline) { node.pipeline = []; }
			const newStepId = `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
			const newStep: INodePipelineStep = {
				id: newStepId,
				type: 'call_function',
				functionName: 'PYTHON',
				expression: ''
			};
			node.pipeline.push(newStep);
			this._syncToNode(node, true);
			this._saveFlowchartData();
			this._renderPipelinePanel(panel, node);
			this._openNodeFunctionInlineEditor(node, newStep);
		};

		// Divider line separating Add buttons from Sync To Node button
		append(pipelineSec, $('.pipeline-toolbar-divider'));

		// Toolbar Row 2: Sync To Node on the right
		const syncRow = append(pipelineSec, $('.pipeline-toolbar-sync-row'));
		const syncToBtn = append(syncRow, $('.pipeline-btn.pipeline-sync-to-btn'));
		append(syncToBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowUp)));
		append(syncToBtn, $('span', {}, 'Sync To Node'));
		syncToBtn.title = 'Sync execution sequence steps, runner order, and parameters to canvas node';
		syncToBtn.onclick = (e) => {
			e.stopPropagation();
			this._syncToNode(node, false);
		};

		if (previousScrollTop > 0) {
			setTimeout(() => {
				body.scrollTop = previousScrollTop;
			}, 0);
		}
	}

	private _renderInspector(parent: HTMLElement): void {
		clearNode(parent);
		if (!this._data || !Array.isArray(this._data.nodes)) {
			return;
		}

		// Header / Title
		const headerSec = append(parent, $('.workflow-inspector-header'));
		const headerTop = append(headerSec, $('.workflow-inspector-header-top'));
		if (!this._isInspectorCompact) {
			const title = append(headerTop, $('.workflow-inspector-title'));
			title.textContent = 'PROPERTIES & STYLING';
		}

		const headerActions = append(headerTop, $('.workflow-inspector-header-actions'));

		// Compact Toggle Button
		const compactBtn = append(headerActions, $('.workflow-inspector-collapse-btn'));
		append(compactBtn, $('span' + ThemeIcon.asCSSSelector(this._isInspectorCompact ? Codicon.chevronLeft : Codicon.chevronRight)));
		compactBtn.title = this._isInspectorCompact ? 'Expand Panel (Full Width)' : 'Compact Panel (Single Column)';
		compactBtn.onclick = (e) => {
			e.stopPropagation();
			this._isInspectorCompact = !this._isInspectorCompact;
			this._storageService.store('workflowEditor.inspectorCompact', this._isInspectorCompact, StorageScope.PROFILE, StorageTarget.USER);
			if (this._isInspectorCompact) {
				parent.classList.add('compact');
			} else {
				parent.classList.remove('compact');
			}
			this._renderInspector(parent);
		};

		// Close / Collapse Button
		const collapseBtn = append(headerActions, $('.workflow-inspector-collapse-btn'));
		append(collapseBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
		collapseBtn.title = 'Collapse / Hide Panel';
		collapseBtn.onclick = (e) => {
			e.stopPropagation();
			this._isInspectorCollapsed = true;
			this._storageService.store('workflowEditor.inspectorCollapsed', true, StorageScope.PROFILE, StorageTarget.USER);
			this._inspectorEl?.classList.add('collapsed');
			this._inspectorTogglePill?.classList.remove('hidden');
		};

		const selNodeCount = this._selectedNodeIds.size;
		const selLinkCount = this._selectedLinkIds.size;
		if (!this._isInspectorCompact) {
			const subtitle = append(headerSec, $('.workflow-inspector-subtitle'));
			if (selLinkCount > 0 && selNodeCount === 0) {
				if (selLinkCount === 1) {
					const selLinkId = Array.from(this._selectedLinkIds)[0];
					const link = this._data.links.find(l => l.id === selLinkId);
					subtitle.textContent = `Selected: ${link?.label ? `Line "${link.label}"` : 'Connection Line'}`;
				} else {
					subtitle.textContent = `${selLinkCount} Lines Selected`;
				}
			} else if (selNodeCount === 1) {
				const selId = Array.from(this._selectedNodeIds)[0];
				const node = this._data.nodes.find(n => n.id === selId);
				subtitle.textContent = `Selected: ${node?.label ? (node.label.length > 18 ? node.label.substring(0, 15) + '...' : node.label) : 'Node'}`;
			} else if (selNodeCount > 1) {
				subtitle.textContent = `${selNodeCount} Nodes Selected`;
			} else {
				subtitle.textContent = 'Default / Global Styles';
			}
		}

		const paletteColors = [
			{ name: 'White', hex: '#ffffff' },
			{ name: 'Teal (Default)', hex: '#0d9488' },
			{ name: 'Sky Blue', hex: '#38bdf8' },
			{ name: 'Violet Purple', hex: '#7c3aed' },
			{ name: 'Amber Gold', hex: '#facc15' },
			{ name: 'Rose Red', hex: '#f43f5e' }
		];

		// Case A: Connection Line(s) Selected
		if (selLinkCount > 0 && selNodeCount === 0) {
			let currentLineColor = this._activeLineColor || '#0d9488';
			if (selLinkCount === 1) {
				const selLinkId = Array.from(this._selectedLinkIds)[0];
				const link = this._data.links.find(l => l.id === selLinkId);
				currentLineColor = link?.color || this._activeLineColor || '#0d9488';
			}

			// Section 1: Line Color
			const colorSec = append(parent, $('.workflow-toolbar-section'));
			if (!this._isInspectorCompact) {
				const colorTitle = append(colorSec, $('.workflow-toolbar-title'));
				colorTitle.textContent = 'Line Color';
			}

			if (this._isInspectorCompact) {
				const compactColorBtn = append(colorSec, $('.workflow-compact-color-btn'));
				compactColorBtn.title = `Line Color (${currentLineColor}) - Click to pick`;
				const dot = append(compactColorBtn, $('.workflow-compact-color-dot'));
				dot.style.backgroundColor = currentLineColor;
				compactColorBtn.onclick = (e) => {
					e.stopPropagation();
					this._showColorPickerFlyout(compactColorBtn, currentLineColor, paletteColors, (hex) => {
						this._activeLineColor = hex;
						this._storageService.store('workflowEditor.lineColor', this._activeLineColor, StorageScope.PROFILE, StorageTarget.USER);
						if (this._selectedLinkIds.size > 0) {
							for (const id of this._selectedLinkIds) {
								const link = this._data.links.find(l => l.id === id);
								if (link) { link.color = hex; }
							}
							this._saveFlowchartData();
							this._drawLinks();
						}
						this._renderInspector(parent);
					});
				};
				append(parent, $('.workflow-compact-divider'));
			} else {
				const colorGrid = append(colorSec, $('.workflow-color-grid'));
				for (const c of paletteColors) {
					const swatch = append(colorGrid, $('.workflow-color-swatch-btn'));
					swatch.style.backgroundColor = c.hex;
					swatch.title = c.name;
					if (currentLineColor.toLowerCase() === c.hex.toLowerCase()) {
						swatch.classList.add('active');
					}
					swatch.onclick = () => {
						this._activeLineColor = c.hex;
						this._storageService.store('workflowEditor.lineColor', this._activeLineColor, StorageScope.PROFILE, StorageTarget.USER);
						if (this._selectedLinkIds.size > 0) {
							for (const id of this._selectedLinkIds) {
								const link = this._data.links.find(l => l.id === id);
								if (link) { link.color = c.hex; }
							}
							this._saveFlowchartData();
							this._drawLinks();
						}
						this._renderInspector(parent);
					};
				}
			}

			// Section 2: Routing Mode
			const routingSec = append(parent, $('.workflow-toolbar-section'));
			if (!this._isInspectorCompact) {
				const routingTitle = append(routingSec, $('.workflow-toolbar-title'));
				routingTitle.textContent = 'Routing Mode';
			}

			const routingRow = append(routingSec, $(`.workflow-format-row${this._isInspectorCompact ? '.compact-col' : ''}`));
			const routingModes: { mode: 'orthogonal' | 'curved'; label: string; shortLabel: string }[] = [
				{ mode: 'orthogonal', label: 'Orthogonal', shortLabel: 'Ortho' },
				{ mode: 'curved', label: 'Curved', shortLabel: 'Curve' }
			];
			let curRouting: 'orthogonal' | 'curved' = this._activeRoutingMode || 'orthogonal';
			if (selLinkCount === 1) {
				const selLinkId = Array.from(this._selectedLinkIds)[0];
				const link = this._data.links.find(l => l.id === selLinkId);
				curRouting = link?.routing || this._activeRoutingMode || 'orthogonal';
			}
			for (const rm of routingModes) {
				const btn = append(routingRow, $('.workflow-format-btn'));
				btn.textContent = this._isInspectorCompact ? rm.shortLabel : rm.label;
				btn.title = rm.label;
				if (curRouting === rm.mode) {
					btn.classList.add('active');
				}
				btn.onclick = () => {
					this._activeRoutingMode = rm.mode;
					this._storageService.store('workflowEditor.routingMode', this._activeRoutingMode, StorageScope.PROFILE, StorageTarget.USER);
					this._data.routingMode = rm.mode;
					if (this._selectedLinkIds.size > 0) {
						for (const id of this._selectedLinkIds) {
							const link = this._data.links.find(l => l.id === id);
							if (link) { link.routing = rm.mode; }
						}
						this._saveFlowchartData();
						this._drawLinks();
					}
					this._renderInspector(parent);
				};
			}

			if (this._isInspectorCompact) {
				append(parent, $('.workflow-compact-divider'));
			}

			// Section 3: Arrow Style
			const arrowSec = append(parent, $('.workflow-toolbar-section'));
			if (!this._isInspectorCompact) {
				const arrowTitle = append(arrowSec, $('.workflow-toolbar-title'));
				arrowTitle.textContent = 'Arrow Style';
			}

			const arrowRow = append(arrowSec, $(`.workflow-format-row${this._isInspectorCompact ? '.compact-col' : '.grid-2x2'}`));
			const arrowStyles: { style: IFlowchartLink['style']; label: string; shortLabel: string }[] = [
				{ style: 'arrow-single', label: 'Single (→)', shortLabel: '→' },
				{ style: 'arrow-double', label: 'Double (↔)', shortLabel: '↔' },
				{ style: 'arrow-none', label: 'None (—)', shortLabel: '—' },
				{ style: 'dashed', label: 'Dashed (\u254C)', shortLabel: '\u254C' }
			];
			let curArrowStyle: IFlowchartLink['style'] = this._activeLinkStyle || 'arrow-single';
			if (selLinkCount === 1) {
				const selLinkId = Array.from(this._selectedLinkIds)[0];
				const link = this._data.links.find(l => l.id === selLinkId);
				curArrowStyle = link?.style || this._activeLinkStyle || 'arrow-single';
			}
			for (const as of arrowStyles) {
				const btn = append(arrowRow, $('.workflow-format-btn'));
				btn.textContent = this._isInspectorCompact ? as.shortLabel : as.label;
				btn.title = as.label;
				if (curArrowStyle === as.style) {
					btn.classList.add('active');
				}
				btn.onclick = () => {
					this._activeLinkStyle = as.style;
					this._storageService.store('workflowEditor.linkStyle', this._activeLinkStyle, StorageScope.PROFILE, StorageTarget.USER);
					if (this._selectedLinkIds.size > 0) {
						for (const id of this._selectedLinkIds) {
							const link = this._data.links.find(l => l.id === id);
							if (link) { link.style = as.style; }
						}
						this._saveFlowchartData();
						this._drawLinks();
					}
					this._renderInspector(parent);
				};
			}

			return;
		}

		// Case B: Node(s) Selected or Default
		if (selNodeCount === 1) {
			const selId = Array.from(this._selectedNodeIds)[0];
			const node = this._data.nodes.find(n => n.id === selId);
			if (node) {
				if (node.color) {
					this._activeNodeColor = node.color;
					this._storageService.store('workflowEditor.nodeColor', this._activeNodeColor, StorageScope.PROFILE, StorageTarget.USER);
				}
				if (node.textColor) {
					this._activeTextColor = node.textColor;
					this._storageService.store('workflowEditor.textColor', this._activeTextColor, StorageScope.PROFILE, StorageTarget.USER);
				}
				if (node.textAlign) {
					this._activeTextAlign = node.textAlign;
					this._storageService.store('workflowEditor.textAlign', this._activeTextAlign, StorageScope.PROFILE, StorageTarget.USER);
				}
				if (node.verticalAlign) {
					this._activeVerticalAlign = node.verticalAlign;
					this._storageService.store('workflowEditor.verticalAlign', this._activeVerticalAlign, StorageScope.PROFILE, StorageTarget.USER);
				}
				if (typeof node.isBold === 'boolean') {
					this._activeIsBold = node.isBold;
					this._storageService.store('workflowEditor.isBold', this._activeIsBold, StorageScope.PROFILE, StorageTarget.USER);
				}
				if (typeof node.isItalic === 'boolean') {
					this._activeIsItalic = node.isItalic;
					this._storageService.store('workflowEditor.isItalic', this._activeIsItalic, StorageScope.PROFILE, StorageTarget.USER);
				}
				if (typeof node.isUnderline === 'boolean') {
					this._activeIsUnderline = node.isUnderline;
					this._storageService.store('workflowEditor.isUnderline', this._activeIsUnderline, StorageScope.PROFILE, StorageTarget.USER);
				}
				if (typeof node.isStrikethrough === 'boolean') {
					this._activeIsStrikethrough = node.isStrikethrough;
					this._storageService.store('workflowEditor.isStrikethrough', this._activeIsStrikethrough, StorageScope.PROFILE, StorageTarget.USER);
				}
			}
		}

		const currentColor = this._activeNodeColor || '#0d9488';
		const currentTextColor = this._activeTextColor || '#ffffff';
		const isBold = this._activeIsBold;
		const isItalic = this._activeIsItalic;
		const isUnderline = this._activeIsUnderline;
		const isStrikethrough = this._activeIsStrikethrough;
		const textAlign: 'left' | 'center' | 'right' = this._activeTextAlign || 'center';
		const verticalAlign: 'top' | 'center' | 'bottom' = this._activeVerticalAlign || 'center';

		// Section 1: Node Color
		const colorSec = append(parent, $('.workflow-toolbar-section'));
		if (!this._isInspectorCompact) {
			const colorTitle = append(colorSec, $('.workflow-toolbar-title'));
			colorTitle.textContent = 'Node Color';
		}

		if (this._isInspectorCompact) {
			const compactColorBtn = append(colorSec, $('.workflow-compact-color-btn'));
			compactColorBtn.title = `Node Fill Color (${currentColor}) - Click to pick`;
			const shape = append(compactColorBtn, $('.workflow-compact-color-shape'));
			shape.style.backgroundColor = currentColor;
			compactColorBtn.onclick = (e) => {
				e.stopPropagation();
				this._showColorPickerFlyout(compactColorBtn, currentColor, paletteColors, (hex) => {
					this._activeNodeColor = hex;
					this._storageService.store('workflowEditor.nodeColor', this._activeNodeColor, StorageScope.PROFILE, StorageTarget.USER);
					if (this._selectedNodeIds.size > 0) {
						for (const id of this._selectedNodeIds) {
							const node = this._data.nodes.find(n => n.id === id);
							if (node) { node.color = hex; }
						}
						this._saveFlowchartData();
						this._renderNodes();
						this._drawLinks();
					}
					this._renderInspector(parent);
				});
			};
			append(parent, $('.workflow-compact-divider'));
		} else {
			const colorGrid = append(colorSec, $('.workflow-color-grid'));
			for (const c of paletteColors) {
				const swatch = append(colorGrid, $('.workflow-color-swatch-btn'));
				swatch.style.backgroundColor = c.hex;
				swatch.title = c.name;
				if (currentColor.toLowerCase() === c.hex.toLowerCase()) {
					swatch.classList.add('active');
				}
				swatch.onclick = () => {
					this._activeNodeColor = c.hex;
					this._storageService.store('workflowEditor.nodeColor', this._activeNodeColor, StorageScope.PROFILE, StorageTarget.USER);
					if (this._selectedNodeIds.size > 0) {
						for (const id of this._selectedNodeIds) {
							const node = this._data.nodes.find(n => n.id === id);
							if (node) { node.color = c.hex; }
						}
						this._saveFlowchartData();
						this._renderNodes();
						this._drawLinks();
					}
					this._renderInspector(parent);
				};
			}
		}

		// Section 2: Text Formatting
		const textSec = append(parent, $('.workflow-toolbar-section'));
		if (!this._isInspectorCompact) {
			const textTitle = append(textSec, $('.workflow-toolbar-title'));
			textTitle.textContent = 'Text Formatting';
		}

		// Row 1: Font Styles (Bold, Italic, Underline, Strikethrough)
		const styleRow = append(textSec, $(`.workflow-format-row${this._isInspectorCompact ? '.compact-2x2' : ''}`));

		// Bold
		const boldBtn = append(styleRow, $(`.workflow-format-btn${isBold ? '.active' : ''}`));
		boldBtn.textContent = 'B';
		boldBtn.style.fontWeight = 'bold';
		boldBtn.title = 'Bold';
		boldBtn.onclick = () => {
			const nextVal = !isBold;
			this._activeIsBold = nextVal;
			this._storageService.store('workflowEditor.isBold', this._activeIsBold, StorageScope.PROFILE, StorageTarget.USER);
			if (this._selectedNodeIds.size > 0) {
				for (const id of this._selectedNodeIds) {
					const node = this._data.nodes.find(n => n.id === id);
					if (node) { node.isBold = nextVal; }
				}
				this._saveFlowchartData();
				this._renderNodes();
			}
			this._renderInspector(parent);
		};

		// Italic
		const italicBtn = append(styleRow, $(`.workflow-format-btn${isItalic ? '.active' : ''}`));
		italicBtn.textContent = 'I';
		italicBtn.style.fontStyle = 'italic';
		italicBtn.style.fontFamily = 'Georgia, serif, sans-serif';
		italicBtn.title = 'Italic';
		italicBtn.onclick = () => {
			const nextVal = !isItalic;
			this._activeIsItalic = nextVal;
			this._storageService.store('workflowEditor.isItalic', this._activeIsItalic, StorageScope.PROFILE, StorageTarget.USER);
			if (this._selectedNodeIds.size > 0) {
				for (const id of this._selectedNodeIds) {
					const node = this._data.nodes.find(n => n.id === id);
					if (node) { node.isItalic = nextVal; }
				}
				this._saveFlowchartData();
				this._renderNodes();
			}
			this._renderInspector(parent);
		};

		// Underline
		const underlineBtn = append(styleRow, $(`.workflow-format-btn${isUnderline ? '.active' : ''}`));
		underlineBtn.textContent = 'U';
		underlineBtn.style.textDecoration = 'underline';
		underlineBtn.title = 'Underline';
		underlineBtn.onclick = () => {
			const nextVal = !isUnderline;
			this._activeIsUnderline = nextVal;
			this._storageService.store('workflowEditor.isUnderline', this._activeIsUnderline, StorageScope.PROFILE, StorageTarget.USER);
			if (this._selectedNodeIds.size > 0) {
				for (const id of this._selectedNodeIds) {
					const node = this._data.nodes.find(n => n.id === id);
					if (node) { node.isUnderline = nextVal; }
				}
				this._saveFlowchartData();
				this._renderNodes();
			}
			this._renderInspector(parent);
		};

		// Strikethrough
		const strikeBtn = append(styleRow, $(`.workflow-format-btn${isStrikethrough ? '.active' : ''}`));
		strikeBtn.textContent = 'S';
		strikeBtn.style.textDecoration = 'line-through';
		strikeBtn.title = 'Strikethrough';
		strikeBtn.onclick = () => {
			const nextVal = !isStrikethrough;
			this._activeIsStrikethrough = nextVal;
			this._storageService.store('workflowEditor.isStrikethrough', this._activeIsStrikethrough, StorageScope.PROFILE, StorageTarget.USER);
			if (this._selectedNodeIds.size > 0) {
				for (const id of this._selectedNodeIds) {
					const node = this._data.nodes.find(n => n.id === id);
					if (node) { node.isStrikethrough = nextVal; }
				}
				this._saveFlowchartData();
				this._renderNodes();
			}
			this._renderInspector(parent);
		};

		// Row 2: Horizontal Alignment (Left, Center, Right)
		const alignRow = append(textSec, $(`.workflow-format-row${this._isInspectorCompact ? '.compact-col' : ''}`));
		const alignChoices: { align: 'left' | 'center' | 'right'; label: string; shortLabel: string; title: string }[] = [
			{ align: 'left', label: 'Left', shortLabel: 'L', title: 'Align Left (Click: content only; Double-click: all including title)' },
			{ align: 'center', label: 'Center', shortLabel: 'C', title: 'Align Center (Click: content only; Double-click: all including title)' },
			{ align: 'right', label: 'Right', shortLabel: 'R', title: 'Align Right (Click: content only; Double-click: all including title)' }
		];
		for (const ac of alignChoices) {
			const aBtn = append(alignRow, $(`.workflow-format-btn.text-btn${textAlign === ac.align ? '.active' : ''}`));
			aBtn.textContent = this._isInspectorCompact ? ac.shortLabel : ac.label;
			aBtn.title = ac.title;

			let clickTimer: ReturnType<typeof setTimeout> | null = null;

			const applyAlign = (includeTitle: boolean) => {
				this._activeTextAlign = ac.align;
				this._storageService.store('workflowEditor.textAlign', this._activeTextAlign, StorageScope.PROFILE, StorageTarget.USER);
				if (this._selectedNodeIds.size > 0) {
					for (const id of this._selectedNodeIds) {
						const node = this._data.nodes.find(n => n.id === id);
						if (node) {
							node.textAlign = ac.align;
							if (includeTitle) {
								node.titleTextAlign = ac.align;
							}
						}
					}
					this._saveFlowchartData();
					this._renderNodes();
				}
				this._renderInspector(parent);
				if (includeTitle) {
					this._notificationService.info(`Aligned all elements (including node title) to ${ac.label}.`);
				}
			};

			aBtn.onclick = (e) => {
				e.stopPropagation();
				if (clickTimer) {
					clearTimeout(clickTimer);
					clickTimer = null;
					applyAlign(true);
				} else {
					clickTimer = setTimeout(() => {
						clickTimer = null;
						applyAlign(false);
					}, 220);
				}
			};

			aBtn.ondblclick = (e) => {
				e.stopPropagation();
				e.preventDefault();
				if (clickTimer) {
					clearTimeout(clickTimer);
					clickTimer = null;
				}
				applyAlign(true);
			};
		}

		// Row 3: Vertical Alignments (Top, Middle, Bottom)
		const vAlignRow = append(textSec, $(`.workflow-format-row${this._isInspectorCompact ? '.compact-col' : ''}`));
		const vAlignChoices: { align: 'top' | 'center' | 'bottom'; label: string; shortLabel: string; title: string }[] = [
			{ align: 'top', label: 'Top', shortLabel: 'T', title: 'Align Top' },
			{ align: 'center', label: 'Middle', shortLabel: 'M', title: 'Align Middle' },
			{ align: 'bottom', label: 'Bottom', shortLabel: 'B', title: 'Align Bottom' }
		];
		for (const va of vAlignChoices) {
			const vaBtn = append(vAlignRow, $(`.workflow-format-btn${verticalAlign === va.align ? '.active' : ''}`));
			vaBtn.textContent = this._isInspectorCompact ? va.shortLabel : va.label;
			vaBtn.title = va.title;
			vaBtn.onclick = () => {
				this._activeVerticalAlign = va.align;
				this._storageService.store('workflowEditor.verticalAlign', this._activeVerticalAlign, StorageScope.PROFILE, StorageTarget.USER);
				if (this._selectedNodeIds.size > 0) {
					for (const id of this._selectedNodeIds) {
						const node = this._data.nodes.find(n => n.id === id);
						if (node) {
							node.verticalAlign = va.align;
						}
					}
					this._saveFlowchartData();
					this._renderNodes();
				}
				this._renderInspector(parent);
			};
		}

		if (this._isInspectorCompact) {
			append(parent, $('.workflow-compact-divider'));
		}

		// Section 3: Text Color
		const textColorSec = append(parent, $('.workflow-toolbar-section'));
		const textColors = [
			{ name: 'White', hex: '#ffffff' },
			{ name: 'Teal (Default)', hex: '#0d9488' },
			{ name: 'Sky Blue', hex: '#38bdf8' },
			{ name: 'Violet Purple', hex: '#7c3aed' },
			{ name: 'Amber Gold', hex: '#facc15' },
			{ name: 'Rose Red', hex: '#f43f5e' }
		];

		if (this._isInspectorCompact) {
			const compactTextColBtn = append(textColorSec, $('.workflow-compact-color-btn'));
			compactTextColBtn.title = `Text Font Color (${currentTextColor}) - Click to pick`;
			const textIconWrapper = append(compactTextColBtn, $('.workflow-compact-text-color-icon'));
			const letterA = append(textIconWrapper, $('.workflow-compact-text-letter'));
			letterA.textContent = 'A';
			const underlineBar = append(textIconWrapper, $('.workflow-compact-text-underline'));
			underlineBar.style.backgroundColor = currentTextColor;
			compactTextColBtn.onclick = (e) => {
				e.stopPropagation();
				this._showColorPickerFlyout(compactTextColBtn, currentTextColor, textColors, (hex) => {
					this._activeTextColor = hex;
					this._storageService.store('workflowEditor.textColor', this._activeTextColor, StorageScope.PROFILE, StorageTarget.USER);
					if (this._selectedNodeIds.size > 0) {
						for (const id of this._selectedNodeIds) {
							const node = this._data.nodes.find(n => n.id === id);
							if (node) { node.textColor = hex; }
						}
						this._saveFlowchartData();
						this._renderNodes();
					}
					this._renderInspector(parent);
				});
			};
			append(parent, $('.workflow-compact-divider'));
		} else {
			const textColorTitle = append(textColorSec, $('.workflow-sub-title'));
			textColorTitle.textContent = 'Text Color';

			const textColorGrid = append(textColorSec, $('.workflow-color-grid.small'));
			for (const tc of textColors) {
				const tcBtn = append(textColorGrid, $('.workflow-color-swatch-btn.small'));
				tcBtn.style.backgroundColor = tc.hex;
				tcBtn.title = tc.name;
				if (currentTextColor.toLowerCase() === tc.hex.toLowerCase()) {
					tcBtn.classList.add('active');
				}
				tcBtn.onclick = () => {
					this._activeTextColor = tc.hex;
					this._storageService.store('workflowEditor.textColor', this._activeTextColor, StorageScope.PROFILE, StorageTarget.USER);
					if (this._selectedNodeIds.size > 0) {
						for (const id of this._selectedNodeIds) {
							const node = this._data.nodes.find(n => n.id === id);
							if (node) { node.textColor = tc.hex; }
						}
						this._saveFlowchartData();
						this._renderNodes();
					}
					this._renderInspector(parent);
				};
			}
		}

		// Section: Output Context Variable (Only when 1 node selected)
		if (selNodeCount === 1) {
			const selId = Array.from(this._selectedNodeIds)[0];
			const selectedNode = this._data.nodes.find(n => n.id === selId);
			if (selectedNode) {
				const varSec = append(parent, $('.workflow-toolbar-section.variable-inspector-section'));
				if (!this._isInspectorCompact) {
					const varTitle = append(varSec, $('.workflow-toolbar-title'));
					varTitle.textContent = localize('nodeVariableTitle', 'Output Context Variable');
				}

				const nodeVars = this._getNodeVariables(selectedNode);
				if (this._isInspectorCompact) {
					if (nodeVars.length === 0) {
						const compactAddBtn = append(varSec, $('.workflow-compact-color-btn'));
						compactAddBtn.title = localize('bindVarTitle', 'Bind Context Variable to Node');
						const vTag = append(compactAddBtn, $('.var-icon-badge'));
						vTag.textContent = '[V]';
						compactAddBtn.onclick = (e) => {
							e.stopPropagation();
							this._bindVariableToNode(selectedNode);
						};
					} else {
						const compactVarBtn = append(varSec, $('.workflow-compact-color-btn.active'));
						compactVarBtn.title = `Variables: ${nodeVars.map(v => v.name).join(', ')} (Click to manage in Variables Table)`;
						const vTag = append(compactVarBtn, $('.var-icon-badge'));
						vTag.textContent = '[V]';
						compactVarBtn.onclick = (e) => {
							e.stopPropagation();
							this._openDrawerTab('vars', selectedNode.id);
						};
					}
					append(parent, $('.workflow-compact-divider'));
				} else {
					if (nodeVars.length === 0) {
						const addVarBtn = append(varSec, $('.workflow-format-btn.full-width'));
						const vTag = append(addVarBtn, $('.var-icon-badge'));
						vTag.textContent = '[V]';
						append(addVarBtn, $('span')).textContent = localize('addVar', ' Bind Output Variable');
						addVarBtn.title = localize('addVarTitle', 'Bind an output variable to this node for data flow and branching');
						addVarBtn.onclick = () => {
							this._openNodeVariableInlineEditor(selectedNode);
						};

						const openPipelineBtn = append(varSec, $('.workflow-format-btn.full-width'));
						openPipelineBtn.style.marginTop = '6px';
						openPipelineBtn.style.background = 'rgba(56, 189, 248, 0.15)';
						openPipelineBtn.style.borderColor = 'rgba(56, 189, 248, 0.4)';
						openPipelineBtn.style.color = '#38bdf8';
						append(openPipelineBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.listOrdered)));
						append(openPipelineBtn, $('span', {}, localize('openPipelineBtn', ' Execution Pipeline')));
						openPipelineBtn.title = localize('openPipelineTitle', 'Configure step-by-step execution order and variable mapping for this node');
						openPipelineBtn.onclick = () => {
							this._openNodePipelinePanel(selectedNode.id);
						};
					} else {
						const varForm = append(varSec, $('.workflow-var-form'));

						this._updateExistingVarsDatalist();

						for (let i = 0; i < nodeVars.length; i++) {
							const v = nodeVars[i];
							const varCard = append(varForm, $('.workflow-var-card'));
							varCard.style.padding = '8px 10px';
							varCard.style.marginBottom = '8px';
							varCard.style.borderRadius = '4px';
							varCard.style.border = '1px solid var(--vscode-widget-border, rgba(255,255,255,0.12))';
							varCard.style.background = 'var(--vscode-editor-background, rgba(0,0,0,0.2))';

							// Check if this variable was already defined in an earlier/other node
							const otherNodesWithVar = (this._data?.nodes || []).filter(n => n.id !== selectedNode.id && this._getNodeVariables(n).some(ov => ov.name === v.name));
							const isUpdatingExisting = otherNodesWithVar.length > 0;

							// Card Top Header: [V] badge on left, Trash Button on top-right!
							const cardHeader = append(varCard, $('.var-card-header'));
							const headerTitle = append(cardHeader, $('.var-card-title'));
							headerTitle.style.display = 'flex';
							headerTitle.style.alignItems = 'center';
							headerTitle.style.gap = '6px';
							const vBadge = append(headerTitle, $('.var-icon-badge'));
							vBadge.textContent = '[V]';
							const labelText = append(headerTitle, $('span'));
							labelText.textContent = isUpdatingExisting ? `Update @${v.name}` : `Variable ${nodeVars.length > 1 ? `#${i + 1}` : ''}`;
							labelText.style.fontSize = '11px';
							labelText.style.fontWeight = '600';
							labelText.style.color = isUpdatingExisting ? '#38bdf8' : 'var(--vscode-foreground, #cccccc)';

							const unbindBtn = append(cardHeader, $('.top-right-delete-btn'));
							unbindBtn.title = localize('unbindVar', 'Delete variable from node');
							append(unbindBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
							unbindBtn.onclick = () => {
								this._unbindVariableFromNode(selectedNode, v);
							};

							// Variable Name Row (with datalist for known variables!)
							const nameRow = append(varCard, $('.workflow-var-row'));
							const nameLabel = append(nameRow, $('.workflow-var-label'));
							nameLabel.textContent = localize('varName', 'Name:');
							const nameInput = append(nameRow, $('input.workflow-var-input')) as HTMLInputElement;
							nameInput.style.width = '100%';
							nameInput.style.boxSizing = 'border-box';
							nameInput.type = 'text';
							nameInput.value = v.name;
							nameInput.setAttribute('list', 'workflow-existing-vars-list');
							nameInput.placeholder = 'e.g. status, count, monitor1';
							nameInput.onchange = () => {
								const cleaned = nameInput.value.trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_') || `var_${i + 1}`;
								nameInput.value = cleaned;
								const oldName = v.name;
								v.name = cleaned;

								if (!Array.isArray(selectedNode.outputVariables)) {
									selectedNode.outputVariables = [];
								}
								const found = selectedNode.outputVariables.find(x => x.name === oldName || x.name === cleaned);
								if (found) {
									found.name = cleaned;
								} else {
									selectedNode.outputVariables.push({ name: cleaned, initialValue: v.initialValue || 'None', expression: v.expression });
								}

								if (selectedNode.outputVariable && (selectedNode.outputVariable.name === oldName || selectedNode.outputVariable.name === cleaned)) {
									selectedNode.outputVariable.name = cleaned;
								} else if (!selectedNode.outputVariable) {
									selectedNode.outputVariable = selectedNode.outputVariables[0];
								}

								if (selectedNode.pipeline) {
									const step = selectedNode.pipeline.find(s => s.type === 'set_variable' && (s.targetVariable === oldName || s.targetVariable === `@${oldName}`));
									if (step) {
										step.targetVariable = cleaned;
									}
								}

								this._saveFlowchartData();
								this._renderNodes();
								this._refreshVariablesDrawer();
							};
							const findInspectorTicket = (rawRef?: string) => {
								if (!rawRef) { return undefined; }
								const clean = rawRef.trim().replace(/^@/, '').replace(/^=\s*/, '');
								if (clean === 'ticket' || clean === 'ticket.output') { return selectedNode.imports?.[0]; }
								return (selectedNode.imports || []).find(imp =>
									imp.name === clean ||
									imp.name.replace(/[^a-zA-Z0-9_]/g, '_') === clean ||
									imp.name.toLowerCase() === clean.toLowerCase() ||
									imp.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase() === clean.toLowerCase()
								);
							};

							const boundTicket = findInspectorTicket(v.expression) || findInspectorTicket(v.initialValue);
							if (boundTicket) {
								const ticketBanner = append(varCard, $('.workflow-var-ticket-banner'));
								ticketBanner.style.display = 'flex';
								ticketBanner.style.alignItems = 'center';
								ticketBanner.style.gap = '5px';
								ticketBanner.style.marginTop = '6px';
								ticketBanner.style.padding = '3px 6px';
								ticketBanner.style.borderRadius = '4px';
								ticketBanner.style.background = 'rgba(168, 85, 247, 0.15)';
								ticketBanner.style.border = '1px solid rgba(168, 85, 247, 0.4)';
								ticketBanner.style.fontSize = '11px';
								ticketBanner.style.color = '#c084fc';
								append(ticketBanner, $('span' + ThemeIcon.asCSSSelector(Codicon.checklist)));
								append(ticketBanner, $('span', {}, `Captures Ticket Output: ${boundTicket.name}`));
							}

							if (isUpdatingExisting) {
								// This node is modifying an existing variable from an upstream node!
								const exprRow = append(varCard, $('.workflow-var-row'));
								exprRow.style.marginTop = '6px';
								const exprLabel = append(exprRow, $('.workflow-var-label'));
								exprLabel.textContent = localize('varOperation', 'Operation / Assignment:');
								const exprInput = append(exprRow, $('input.workflow-var-input')) as HTMLInputElement;
								exprInput.style.width = '100%';
								exprInput.style.boxSizing = 'border-box';
								exprInput.type = 'text';
								exprInput.value = v.expression || '';
								exprInput.placeholder = 'e.g. += 1, -= 1, = ticket.output, = \'DONE\'';
								exprInput.onchange = () => {
									const newExpr = exprInput.value.trim() || undefined;
									v.expression = newExpr;

									if (!Array.isArray(selectedNode.outputVariables)) {
										selectedNode.outputVariables = [];
									}
									const found = selectedNode.outputVariables.find(x => x.name === v.name);
									if (found) {
										found.expression = newExpr;
									}
									if (selectedNode.outputVariable && selectedNode.outputVariable.name === v.name) {
										selectedNode.outputVariable.expression = newExpr;
									}
									if (selectedNode.pipeline) {
										const step = selectedNode.pipeline.find(s => s.type === 'set_variable' && (s.targetVariable === v.name || s.targetVariable === `@${v.name}`));
										if (step) {
											step.expression = newExpr || v.initialValue || 'None';
										}
									}

									this._saveFlowchartData();
									this._renderNodes();
									this._drawLinks();
									this._refreshVariablesDrawer();
								};

								const noteRow = append(varCard, $('.workflow-var-note'));
								noteRow.style.fontSize = '10px';
								noteRow.style.color = '#94a3b8';
								noteRow.style.marginTop = '4px';
								noteRow.textContent = `Initial value defined in '${otherNodesWithVar[0].label}': ${otherNodesWithVar[0].outputVariables?.find(x => x.name === v.name)?.initialValue || 'None'}`;
							} else {
								// First definition node: Initial Value + optional operation
								const initRow = append(varCard, $('.workflow-var-row'));
								initRow.style.marginTop = '6px';
								const initLabel = append(initRow, $('.workflow-var-label'));
								initLabel.textContent = localize('varInit', 'Initial Value:');
								const initInput = append(initRow, $('input.workflow-var-input')) as HTMLInputElement;
								initInput.style.width = '100%';
								initInput.style.boxSizing = 'border-box';
								initInput.type = 'text';
								initInput.value = v.initialValue || 'None';
								initInput.placeholder = '0, None, True, \'admin\'';
								initInput.onchange = () => {
									const newVal = initInput.value.trim() || 'None';
									v.initialValue = newVal;

									if (!Array.isArray(selectedNode.outputVariables)) {
										selectedNode.outputVariables = [];
									}
									const found = selectedNode.outputVariables.find(x => x.name === v.name);
									if (found) {
										found.initialValue = newVal;
									} else {
										selectedNode.outputVariables.push({ name: v.name, initialValue: newVal, expression: v.expression });
									}
									if (selectedNode.outputVariable && selectedNode.outputVariable.name === v.name) {
										selectedNode.outputVariable.initialValue = newVal;
									} else if (!selectedNode.outputVariable) {
										selectedNode.outputVariable = selectedNode.outputVariables[0];
									}
									if (selectedNode.pipeline) {
										const step = selectedNode.pipeline.find(s => s.type === 'set_variable' && (s.targetVariable === v.name || s.targetVariable === `@${v.name}`));
										if (step) {
											step.expression = step.expression || newVal;
										}
									}

									this._saveFlowchartData();
									this._renderNodes();
									this._drawLinks();
									this._refreshVariablesDrawer();
								};

								const exprRow = append(varCard, $('.workflow-var-row'));
								exprRow.style.marginTop = '6px';
								const exprLabel = append(exprRow, $('.workflow-var-label'));
								exprLabel.textContent = localize('varExprOpt', 'Operation on this Node (Optional):');
								const exprInput = append(exprRow, $('input.workflow-var-input')) as HTMLInputElement;
								exprInput.style.width = '100%';
								exprInput.style.boxSizing = 'border-box';
								exprInput.type = 'text';
								exprInput.value = v.expression || '';
								exprInput.placeholder = 'e.g. += 1, = ticket.output (optional)';
								exprInput.onchange = () => {
									const newExpr = exprInput.value.trim() || undefined;
									v.expression = newExpr;

									if (!Array.isArray(selectedNode.outputVariables)) {
										selectedNode.outputVariables = [];
									}
									const found = selectedNode.outputVariables.find(x => x.name === v.name);
									if (found) {
										found.expression = newExpr;
									}
									if (selectedNode.outputVariable && selectedNode.outputVariable.name === v.name) {
										selectedNode.outputVariable.expression = newExpr;
									}
									if (selectedNode.pipeline) {
										const step = selectedNode.pipeline.find(s => s.type === 'set_variable' && (s.targetVariable === v.name || s.targetVariable === `@${v.name}`));
										if (step) {
											step.expression = newExpr || v.initialValue || 'None';
										}
									}

									this._saveFlowchartData();
									this._renderNodes();
									this._drawLinks();
									this._refreshVariablesDrawer();
								};
							}
						}

						// Actions: Add Variable to Node & Manage in Table
						const actRow = append(varForm, $('.workflow-var-actions-row'));
						actRow.style.marginTop = '6px';

						const addAnotherVarBtn = append(actRow, $('.workflow-format-btn.full-width'));
						addAnotherVarBtn.style.marginBottom = '6px';
						append(addAnotherVarBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.plus)));
						append(addAnotherVarBtn, $('span')).textContent = localize('addAnotherVar', ' Add Variable to Node');
						addAnotherVarBtn.onclick = () => {
							this._openNodeVariableInlineEditor(selectedNode);
						};

						const viewTableBtn = append(actRow, $('.workflow-format-btn.full-width'));
						append(viewTableBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.listUnordered)));
						append(viewTableBtn, $('span')).textContent = localize('manageInTable', ' Manage in Variables Table');
						viewTableBtn.title = localize('viewInTableTitle', 'Open and edit in bottom Context Variables table');
						viewTableBtn.onclick = () => {
							this._openDrawerTab('vars', selectedNode.id);
						};

						const openPipelineBtn = append(actRow, $('.workflow-format-btn.full-width'));
						openPipelineBtn.style.marginTop = '6px';
						openPipelineBtn.style.background = 'rgba(56, 189, 248, 0.15)';
						openPipelineBtn.style.borderColor = 'rgba(56, 189, 248, 0.4)';
						openPipelineBtn.style.color = '#38bdf8';
						append(openPipelineBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.listOrdered)));
						append(openPipelineBtn, $('span', {}, localize('openPipelineBtn', ' Execution Pipeline')));
						openPipelineBtn.title = localize('openPipelineTitle', 'Configure step-by-step execution order and variable mapping for this node');
						openPipelineBtn.onclick = () => {
							this._openNodePipelinePanel(selectedNode.id);
						};
					}
				}
			}
		}

		// Export & Download Section (Always available at the bottom of Inspector)
		const exportSec = append(parent, $('.workflow-toolbar-section'));
		const isSelection = this._selectedNodeIds.size > 0;
		if (!this._isInspectorCompact) {
			const exportTitle = isSelection ? `Export Selection (${this._selectedNodeIds.size})` : 'Export / Download';
			append(exportSec, $('.workflow-toolbar-title')).textContent = exportTitle;
		}

		if (this._isInspectorCompact) {
			const compactExpBtn = append(exportSec, $('.workflow-compact-color-btn'));
			append(compactExpBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.desktopDownload)));
			compactExpBtn.title = 'Export / Download Diagram';
			compactExpBtn.onclick = (e) => {
				e.stopPropagation();
				this._showExportMenu(compactExpBtn);
			};
		} else {
			const exportGrid = append(exportSec, $('.workflow-format-row.grid-2x2'));
			const exportOptions: { label: string; format: 'png' | 'jpeg' | 'svg' | 'pdf' }[] = [
				{ label: 'PNG Image', format: 'png' },
				{ label: 'JPEG Image', format: 'jpeg' },
				{ label: 'SVG Vector', format: 'svg' },
				{ label: 'PDF Doc', format: 'pdf' }
			];

			for (const opt of exportOptions) {
				const btn = append(exportGrid, $('.workflow-format-btn'));
				btn.textContent = opt.label;
				btn.title = `Export as ${opt.format.toUpperCase()} (${isSelection ? 'Selected Nodes' : 'Full Canvas'})`;
				btn.onclick = () => {
					this._exportDiagram(opt.format, isSelection);
				};
			}
		}

		// Workflow I/O Contract Summary (Unique Entry Input Node & Terminal Output Node)
		if (!this._isInspectorCompact && !this._isPureDiagram) {
			const ioContract = this._workflowExecutionService.resolveWorkflowIOContract(this._data);
			const ioSec = append(parent, $('.workflow-toolbar-section'));
			ioSec.style.marginTop = '10px';
			ioSec.style.borderTop = '1px solid rgba(255,255,255,0.08)';
			ioSec.style.paddingTop = '10px';

			const ioTitleRow = append(ioSec, $('div', {
				style: 'display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 6px;'
			}));
			append(ioTitleRow, $('.workflow-toolbar-title', { style: 'margin: 0;' }, 'WORKFLOW I/O CONTRACT'));
			append(ioTitleRow, $('span', {
				style: `font-size: 9.5px; font-weight: 700; padding: 1px 6px; border-radius: 999px; ${ioContract.isValid ? 'background: rgba(52, 211, 153, 0.16); color: #6ee7b7; border: 1px solid rgba(52, 211, 153, 0.35);' : 'background: rgba(239, 68, 68, 0.16); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.4);'}`
			}, ioContract.isValid ? 'VALID' : 'ERROR'));

			// Inputs Block
			const inCard = append(ioSec, $('div', {
				style: 'display: flex; flex-direction: column; gap: 4px; padding: 7px 8px; border-radius: 5px; background: rgba(168, 85, 247, 0.06); border: 1px solid rgba(192, 132, 252, 0.22); margin-bottom: 6px;'
			}));
			const inHeader = append(inCard, $('div', {
				style: 'display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 10.5px; font-weight: 600; color: #c084fc;'
			}));
			append(inHeader, $('span', {}, `Inputs (${ioContract.inputs.length})`));
			if (ioContract.inputNodeId) {
				const inNodeChip = append(inHeader, $('button', {
					type: 'button',
					style: 'font-size: 10px; padding: 1px 6px; border-radius: 3px; background: rgba(192, 132, 252, 0.14); border: 1px solid rgba(192, 132, 252, 0.35); color: #e9d5ff; cursor: pointer; max-width: 115px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
					title: `Entry Input Node: ${ioContract.inputNodeLabel} (click to open)`
				}, ioContract.inputNodeLabel || ioContract.inputNodeId)) as HTMLButtonElement;
				inNodeChip.onclick = () => {
					const targetNode = this._data.nodes.find(n => n.id === ioContract.inputNodeId);
					if (targetNode) {
						this._openNodeComponentsInSideEditor(targetNode);
					}
				};
			}

			if (ioContract.inputError) {
				append(inCard, $('div', {
					style: 'font-size: 10.5px; color: #fca5a5; line-height: 1.35;'
				}, ioContract.inputError));
			} else if (ioContract.inputs.length === 0) {
				append(inCard, $('div', {
					style: 'font-size: 10.5px; opacity: 0.55; font-style: italic;'
				}, 'No input parameters defined on entry node.'));
			} else {
				for (const inp of ioContract.inputs) {
					const row = append(inCard, $('div', {
						style: 'display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 10.5px; padding: 2px 4px; border-radius: 3px; background: rgba(0,0,0,0.2);'
					}));
					append(row, $('span', {
						style: 'font-family: var(--vscode-editor-font-family, monospace); color: #e9d5ff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;'
					}, inp.name));
					append(row, $('span', {
						style: 'font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 90px;',
						title: inp.defaultValue ? `Default: ${inp.defaultValue}` : 'No default value'
					}, inp.defaultValue ? `= ${inp.defaultValue}` : '(empty)'));
				}
			}

			// Outputs Block
			const outCard = append(ioSec, $('div', {
				style: 'display: flex; flex-direction: column; gap: 4px; padding: 7px 8px; border-radius: 5px; background: rgba(16, 185, 129, 0.06); border: 1px solid rgba(52, 211, 153, 0.22);'
			}));
			const outHeader = append(outCard, $('div', {
				style: 'display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 10.5px; font-weight: 600; color: #34d399;'
			}));
			append(outHeader, $('span', {}, `Outputs (${ioContract.outputs.length})`));
			if (ioContract.outputNodeId) {
				const outNodeChip = append(outHeader, $('button', {
					type: 'button',
					style: 'font-size: 10px; padding: 1px 6px; border-radius: 3px; background: rgba(52, 211, 153, 0.14); border: 1px solid rgba(52, 211, 153, 0.35); color: #d1fae5; cursor: pointer; max-width: 115px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
					title: `Final Output Node: ${ioContract.outputNodeLabel} (click to open)`
				}, ioContract.outputNodeLabel || ioContract.outputNodeId)) as HTMLButtonElement;
				outNodeChip.onclick = () => {
					const targetNode = this._data.nodes.find(n => n.id === ioContract.outputNodeId);
					if (targetNode) {
						this._openNodeComponentsInSideEditor(targetNode);
					}
				};
			}

			if (ioContract.outputError) {
				append(outCard, $('div', {
					style: 'font-size: 10.5px; color: #fca5a5; line-height: 1.35;'
				}, ioContract.outputError));
			} else if (ioContract.outputs.length === 0) {
				append(outCard, $('div', {
					style: 'font-size: 10.5px; opacity: 0.55; font-style: italic;'
				}, 'No outputs defined on final node.'));
			} else {
				for (const out of ioContract.outputs) {
					const row = append(outCard, $('div', {
						style: 'display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 10.5px; padding: 2px 4px; border-radius: 3px; background: rgba(0,0,0,0.2);'
					}));
					append(row, $('span', {
						style: 'color: #d1fae5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
						title: `${out.label} (var: ${out.varName})`
					}, out.label));
					append(row, $('span', {
						style: 'font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: rgba(56, 189, 248, 0.14); color: #7dd3fc; border: 1px solid rgba(56, 189, 248, 0.3); text-transform: uppercase; flex-shrink: 0;'
					}, (out.defaultFormat || 'json').toUpperCase()));
				}
			}
		}
	}

	private _updateCanvasDimensions(additionalX?: number, additionalY?: number): void {
		let maxRight = WorkflowEditor.DEFAULT_CANVAS_WIDTH;
		let maxBottom = WorkflowEditor.DEFAULT_CANVAS_HEIGHT;

		if (this._data && Array.isArray(this._data.nodes)) {
			for (const node of this._data.nodes) {
				const right = (node.x || 0) + (node.width || 120) + 1200;
				const bottom = (node.y || 0) + (node.height || 50) + 1000;
				if (right > maxRight) { maxRight = right; }
				if (bottom > maxBottom) { maxBottom = bottom; }
			}
		}

		if (additionalX !== undefined) {
			const candidateX = additionalX + 1200;
			if (candidateX > maxRight) { maxRight = candidateX; }
		}
		if (additionalY !== undefined) {
			const candidateY = additionalY + 1000;
			if (candidateY > maxBottom) { maxBottom = candidateY; }
		}

		this._currentCanvasWidth = Math.ceil(maxRight);
		this._currentCanvasHeight = Math.ceil(maxBottom);

		if (this._canvas) {
			this._canvas.style.width = `${this._currentCanvasWidth}px`;
			this._canvas.style.height = `${this._currentCanvasHeight}px`;
		}
		if (this._zoomSizerEl) {
			this._zoomSizerEl.style.width = `${this._currentCanvasWidth * this._zoomLevel}px`;
			this._zoomSizerEl.style.height = `${this._currentCanvasHeight * this._zoomLevel}px`;
		}
	}

	/**
	 * allow-any-unicode-next-line
	 * Zoom anchor for the −/+ buttons: the node located from the Workflow Outline, else the single selected node, else the
	 * middle of the view. A focus node that is off-screen is brought to the middle.
	 */
	private _zoomFocusAnchor(): { viewportX: number; viewportY: number; canvasX?: number; canvasY?: number } | undefined {
		const wrapper = this._canvasScroller();
		if (!wrapper) {
			return undefined;
		}
		const located = this._workflowUri ? WorkflowEditor._outlineLocated.get(this._workflowUri.toString()) : undefined;
		const locatedHere = [...(located?.targets || [])].reverse().find(t => this._getNodeDom(t.nodeId));
		const focusId = locatedHere ? locatedHere.nodeId
			: this._selectedNodeIds.size === 1 ? Array.from(this._selectedNodeIds)[0] : undefined;
		const node = focusId ? this._data?.nodes.find(n => n.id === focusId) : undefined;
		const centerX = wrapper.clientWidth / 2;
		const centerY = wrapper.clientHeight / 2;
		if (!node) {
			return { viewportX: centerX, viewportY: centerY };
		}
		const canvasX = node.x + node.width / 2;
		const canvasY = node.y + node.height / 2;
		const onScreenX = canvasX * this._zoomLevel - wrapper.scrollLeft;
		const onScreenY = canvasY * this._zoomLevel - wrapper.scrollTop;
		const isVisible = onScreenX >= 0 && onScreenX <= wrapper.clientWidth && onScreenY >= 0 && onScreenY <= wrapper.clientHeight;
		return isVisible ? { viewportX: onScreenX, viewportY: onScreenY, canvasX, canvasY } : { viewportX: centerX, viewportY: centerY, canvasX, canvasY };
	}

	/** Sets the zoom; with `anchor`, keeps that point (viewport px, optionally pinned to a canvas point) fixed on screen. */
	private _setZoom(level: number, anchor?: { viewportX: number; viewportY: number; canvasX?: number; canvasY?: number }): void {
		const wrapper = this._canvasScroller();
		const oldZoom = this._zoomLevel;
		const anchorCanvasX = anchor ? (anchor.canvasX ?? ((wrapper?.scrollLeft ?? 0) + anchor.viewportX) / oldZoom) : 0;
		const anchorCanvasY = anchor ? (anchor.canvasY ?? ((wrapper?.scrollTop ?? 0) + anchor.viewportY) / oldZoom) : 0;
		this._zoomLevel = Math.max(0.25, Math.min(2.0, Math.round(level * 100) / 100));
		if (this._canvas) {
			this._canvas.style.transform = `scale(${this._zoomLevel})`;
			this._canvas.style.transformOrigin = '0 0';
		}
		if (this._zoomSizerEl) {
			this._zoomSizerEl.style.width = `${this._currentCanvasWidth * this._zoomLevel}px`;
			this._zoomSizerEl.style.height = `${this._currentCanvasHeight * this._zoomLevel}px`;
		}
		if (anchor && wrapper) {
			wrapper.scrollLeft = Math.max(0, anchorCanvasX * this._zoomLevel - anchor.viewportX);
			wrapper.scrollTop = Math.max(0, anchorCanvasY * this._zoomLevel - anchor.viewportY);
		}
		const zoomText = `${Math.round(this._zoomLevel * 100)}%`;
		if (this._floatingZoomBadgeEl) {
			this._floatingZoomBadgeEl.textContent = zoomText;
			this._floatingZoomBadgeEl.title = !this._isFloatingToolbarExpanded
				? `Zoom: ${zoomText} (Click to expand toolbar)`
				: 'Reset Zoom to 100%';
		}
	}

	private _fitView(): void {
		const visibleNodes = this._data?.nodes || [];
		if (!visibleNodes.length || !this._canvas) {
			this._setZoom(1.0);
			return;
		}
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const node of visibleNodes) {
			minX = Math.min(minX, node.x);
			minY = Math.min(minY, node.y);
			maxX = Math.max(maxX, node.x + node.width);
			maxY = Math.max(maxY, node.y + node.height);
		}
		const padding = 80;
		const contentW = Math.max(200, (maxX - minX) + padding * 2);
		const contentH = Math.max(200, (maxY - minY) + padding * 2);
		const canvasWrapper = this._canvas.closest('.workflow-editor-canvas-wrapper') as HTMLElement;
		const wrapperW = canvasWrapper?.clientWidth || 800;
		const wrapperH = canvasWrapper?.clientHeight || 600;

		const scaleW = wrapperW / contentW;
		const scaleH = wrapperH / contentH;
		const optimalScale = Math.max(0.25, Math.min(1.5, Math.min(scaleW, scaleH)));

		this._setZoom(optimalScale);

		if (canvasWrapper) {
			const targetScrollLeft = Math.max(0, (minX - padding) * this._zoomLevel);
			const targetScrollTop = Math.max(0, (minY - padding) * this._zoomLevel);
			canvasWrapper.scrollTo({
				left: targetScrollLeft,
				top: targetScrollTop,
				behavior: 'smooth'
			});
		}
	}

	/** The latest call of this Sub-Workflow (live while it runs); only on a Sub-Workflow's own canvas. */
	private _getOwnSubWorkflowRun(): IWorkflowExecutionRun | undefined {
		return this._subWorkflowTicket ? this._workflowExecutionService.getActiveSubWorkflowRun(this._subWorkflowTicket.id) : undefined;
	}

	private _getEffectiveRunForNode(nodeId: string): IWorkflowExecutionRun | undefined {
		const mainRun = this._workflowUri ? this._workflowExecutionService.getActiveRun(this._workflowUri) : undefined;
		const subRun = this._getOwnSubWorkflowRun();
		if (!subRun || !subRun.nodeStates?.[nodeId]) {
			return mainRun;
		}
		if (!mainRun) {
			return subRun;
		}
		const mainState = mainRun.nodeStates?.[nodeId];
		const mainExecutedThisNode = Boolean(mainState && mainState.status && mainState.status !== 'pending');
		if (!mainExecutedThisNode) {
			return subRun;
		}
		const subTime = subRun.completedAt || subRun.updatedAt || subRun.startedAt || 0;
		const mainTime = mainState?.completedAt || mainState?.startedAt || mainRun.completedAt || mainRun.updatedAt || mainRun.startedAt || 0;
		return subTime >= mainTime ? subRun : mainRun;
	}

	private _getEffectiveRunForLink(link: IFlowchartLink): IWorkflowExecutionRun | undefined {
		const mainRun = this._workflowUri ? this._workflowExecutionService.getActiveRun(this._workflowUri) : undefined;
		const subRun = this._getOwnSubWorkflowRun();
		if (!subRun || (!subRun.nodeStates?.[link.from] && !subRun.nodeStates?.[link.to])) {
			return mainRun;
		}
		if (!mainRun) {
			return subRun;
		}
		const mainLinkState = mainRun.linkStates?.[link.id] || mainRun.linkStates?.[`${link.from}->${link.to}`];
		const mainNodeState = mainRun.nodeStates?.[link.from];
		const mainExecutedThisBranch = Boolean(mainLinkState || (mainNodeState && mainNodeState.status && mainNodeState.status !== 'pending'));
		if (!mainExecutedThisBranch) {
			return subRun;
		}
		const subTime = subRun.completedAt || subRun.updatedAt || subRun.startedAt || 0;
		const mainTime = mainNodeState?.completedAt || mainNodeState?.startedAt || mainRun.completedAt || mainRun.updatedAt || mainRun.startedAt || 0;
		return subTime >= mainTime ? subRun : mainRun;
	}

	private _renderVariablePill(
		container: HTMLElement,
		node: IFlowchartNode,
		v: INodeVariable,
		stepIndex?: number,
		pipelineStep?: INodePipelineStep
	): HTMLElement {
		const activeRun = this._getEffectiveRunForNode(node.id);
		const runtimeVal = activeRun?.contextVariables ? activeRun.contextVariables[v.name] : undefined;
		const displayVal = v.initialValue || 'None';
		const rawRtStr = runtimeVal !== undefined && runtimeVal !== null ? (typeof runtimeVal === 'object' ? JSON.stringify(runtimeVal) : String(runtimeVal)) : '';
		const runtimeTooltip = rawRtStr ? `\n(Latest Runtime Value: ${rawRtStr.length > 250 ? rawRtStr.substring(0, 250) + ' ...' : rawRtStr})` : '';

		const varPill = append(container, $('.node-variable-pill'));
		varPill.onmousedown = (e) => {
			e.stopPropagation();
		};
		varPill.onclick = (e) => {
			e.stopPropagation();
			if (!this._selectedNodeIds.has(node.id)) {
				this._selectedNodeIds.clear();
				this._selectedNodeIds.add(node.id);
				for (const d of this._renderedNodeDoms()) {
					d.nodeEl.classList.remove('selected');
				}
				this._getNodeDom(node.id)?.nodeEl.classList.add('selected');
				if (this._inspectorEl) {
					this._renderInspector(this._inspectorEl);
				}
			}
		};
		varPill.ondblclick = (e) => {
			e.stopPropagation();
			e.preventDefault();
			this._openNodeVariableInlineEditor(node, v, varPill, pipelineStep);
		};

		const vBadge = append(varPill, $('span.var-tag-icon' + ThemeIcon.asCSSSelector(Codicon.python)));
		vBadge.style.whiteSpace = 'nowrap';
		vBadge.style.flexShrink = '0';
		vBadge.style.color = '#38bdf8';

		// Check if this variable is bound to a ticket
		const findReferencedTicket = (rawRef?: string) => {
			if (!rawRef) { return undefined; }
			const clean = rawRef.trim().replace(/^@/, '').replace(/^=\s*/, '');
			if (clean === 'ticket' || clean === 'ticket.output') {
				// In pipeline, look backwards from stepIndex
				if (node.pipeline && stepIndex !== undefined) {
					for (let k = stepIndex - 2; k >= 0; k--) {
						const s = node.pipeline[k];
						if (s.type === 'run_ticket' && s.ticketName) {
							return { name: s.ticketName, type: s.ticketType, stepNumber: k + 1 };
						}
					}
				}
				return node.imports?.[0] ? { name: node.imports[0].name, type: node.imports[0].type } : undefined;
			}
			const m = clean.match(/^([a-zA-Z0-9_\-]+)(\[(\d+)\])?$/);
			const target = m ? m[1] : clean;

			// In pipeline, search backwards for the nearest prior run_ticket
			if (node.pipeline && stepIndex !== undefined) {
				for (let k = stepIndex - 2; k >= 0; k--) {
					const s = node.pipeline[k];
					if (s.type === 'run_ticket' && s.ticketName && (
						s.ticketName === target ||
						s.ticketName.replace(/[^a-zA-Z0-9_]/g, '_') === target ||
						s.ticketName.toLowerCase() === target.toLowerCase()
					)) {
						return { name: s.ticketName, type: s.ticketType, stepNumber: k + 1 };
					}
				}
			}
			// Search any step in pipeline
			if (node.pipeline) {
				for (let k = 0; k < node.pipeline.length; k++) {
					const s = node.pipeline[k];
					if (s.type === 'run_ticket' && s.ticketName && (
						s.ticketName === target ||
						s.ticketName.replace(/[^a-zA-Z0-9_]/g, '_') === target ||
						s.ticketName.toLowerCase() === target.toLowerCase()
					)) {
						return { name: s.ticketName, type: s.ticketType, stepNumber: k + 1 };
					}
				}
			}
			// Fallback to node.imports or workflow
			const imp = (node.imports || []).find(i =>
				i.name === target ||
				i.name.replace(/[^a-zA-Z0-9_]/g, '_') === target ||
				i.name.toLowerCase() === target.toLowerCase()
			);
			return imp ? { name: imp.name, type: imp.type } : undefined;
		};

		const boundTicket = findReferencedTicket(v.expression) || findReferencedTicket(v.initialValue);
		const pillContent = append(varPill, $('.var-pill-text'));

		if (boundTicket) {
			varPill.classList.add('has-ticket-ref');
			const namePart = append(pillContent, $('span'));
			namePart.textContent = `${v.name} ←`;

			const chip = append(pillContent, $('.var-pill-ticket-chip'));
			const fromStepText = boundTicket.stepNumber ? ` (from Step #${boundTicket.stepNumber})` : '';
			chip.title = `Bound to Ticket output: ${boundTicket.name}${fromStepText}\n(Double-click to open Ticket in Editor Tab)`;
			chip.style.cursor = 'pointer';
			append(chip, $('span' + ThemeIcon.asCSSSelector(Codicon.checklist)));
			let ticketDisplayName = boundTicket.name;
			if (ticketDisplayName.length > 35) {
				ticketDisplayName = ticketDisplayName.substring(0, 32) + '...';
			}
			append(chip, $('span', {}, ticketDisplayName));
			chip.ondblclick = (e) => {
				e.stopPropagation();
				e.preventDefault();
				this._openModuleInEditor({
					type: boundTicket.type || 'ticket',
					name: boundTicket.name
				});
			};

			varPill.title = stepIndex
				? `[Step #${stepIndex} VAR] ${v.name} ← Output of ${boundTicket.name}${fromStepText}${runtimeTooltip}\n(Double-click to inline edit, click to edit in Pipeline)`
				: `Context Variable: ${v.name} ← ${boundTicket.name}${runtimeTooltip}\n(Double-click to inline edit, click to select)`;
		} else {
			let pillText = `${v.name} = ${displayVal}`;
			if (v.expression) {
				let expr = v.expression.trim();
				if (expr.startsWith(`${v.name} =`)) {
					expr = expr.substring(`${v.name} =`.length).trim();
				} else if (expr.startsWith(`${v.name}=`)) {
					expr = expr.substring(`${v.name}=`.length).trim();
				}
				const cleanExpr = expr.replace(/@([a-zA-Z0-9_]+)/g, '$1');
				const unpackMatch = cleanExpr.match(/^([a-zA-Z0-9_]+)\[(\d+)\]$/);
				if (unpackMatch) {
					pillText = `${v.name} ← ${unpackMatch[1]}[${unpackMatch[2]}]`;
				} else if (cleanExpr === '+ 1' || cleanExpr === '++' || cleanExpr === '+= 1' || cleanExpr === '+=1') {
					pillText = `${v.name} += 1`;
				} else if (cleanExpr === '- 1' || cleanExpr === '--' || cleanExpr === '-= 1' || cleanExpr === '-=1') {
					pillText = `${v.name} -= 1`;
				} else if (cleanExpr.startsWith('+=') || cleanExpr.startsWith('-=') || cleanExpr.startsWith('*=') || cleanExpr.startsWith('/=')) {
					pillText = `${v.name} ${cleanExpr}`;
				} else if (cleanExpr === 'ticket.output' || cleanExpr === 'ticket') {
					pillText = `${v.name} ← Ticket`;
				} else if (cleanExpr === 'ticket.status') {
					pillText = `${v.name} ← Status`;
				} else if (cleanExpr.startsWith('=')) {
					pillText = `${v.name} = ${cleanExpr.substring(1).trim()}`;
				} else {
					pillText = `${v.name} = ${cleanExpr}`;
				}
			}
			if (pillText.length > 75) {
				pillText = pillText.substring(0, 72) + '...';
			}
			this._renderExpressionWithTicketBadges(pillContent, pillText, false);
			varPill.title = stepIndex
				? `[Step #${stepIndex} VAR] ${v.name} = ${displayVal}${runtimeTooltip}\n(Double-click to inline edit, click to edit in Pipeline)`
				: `Context Variable: ${v.name} = ${displayVal}${runtimeTooltip}\n(Double-click to inline edit, click to select)`;
		}

		const removeVarBtn = append(varPill, $('.var-pill-remove'));
		removeVarBtn.title = 'Remove variable';
		append(removeVarBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
		removeVarBtn.onmouseenter = () => {
			if (this._pythonStepHoverShowTimeout) {
				clearTimeout(this._pythonStepHoverShowTimeout);
				this._pythonStepHoverShowTimeout = null;
			}
		};
		removeVarBtn.onmousedown = (e) => {
			e.stopPropagation();
			this._hidePythonStepPopover(true);
			this._hideTicketPopover(true);
		};
		removeVarBtn.onclick = (e) => {
			e.stopPropagation();
			e.preventDefault();
			this._hidePythonStepPopover(true);
			this._hideTicketPopover(true);
			if (node.pipeline && pipelineStep) {
				const idx = node.pipeline.indexOf(pipelineStep);
				if (idx !== -1) {
					node.pipeline.splice(idx, 1);
				}
			}
			this._unbindVariableFromNode(node, v);
		};

		return varPill;
	}

	private static readonly _PYTHON_KEYWORDS = new Set([
		'def', 'class', 'for', 'in', 'if', 'elif', 'else', 'while', 'return', 'yield',
		'import', 'from', 'as', 'try', 'except', 'finally', 'raise', 'with', 'pass',
		'break', 'continue', 'lambda', 'and', 'or', 'not', 'is', 'global', 'nonlocal',
		'assert', 'del', 'async', 'await'
	]);

	private static readonly _PYTHON_CONSTANTS = new Set([
		'True', 'False', 'None', 'self', 'cls', 'true', 'false', 'null'
	]);

	private static readonly _WORKFLOW_BUILTINS = new Set([
		'RUN_TICKETS', 'CREATE_TICKETS', 'GET_TICKET', 'GET_TICKETS', 'GET_OUTPUTS', 'GET_PRIMITIVES_CATALOG', 'DISPLAY',
		'run_tickets', 'create_tickets', 'get_ticket', 'get_tickets', 'get_outputs', 'get_primitives_catalog', 'display',
		'NOW', 'DATE', 'TIME', 'TODAY', 'DATETIME', 'TIMESTAMP'
	]);

	private _isTicketTypeStringLiteral(innerStr: string, beforeText: string): boolean {
		const clean = (innerStr || '').trim();
		if (!clean || clean.includes('{') || clean.includes('}')) {
			return false;
		}
		if (/(?:\b(?:ticket_type|entity_type|module_type)\s*=\s*|\b(?:CREATE_TICKETS|create_tickets)\s*\(\s*)$/.test(beforeText)) {
			return true;
		}
		return false;
	}

	private _createTicketIdBadge(container: HTMLElement, ticketId: string, isTextareaBackdrop: boolean): HTMLElement {
		const upperId = ticketId.toUpperCase();
		if (isTextareaBackdrop) {
			const badge = append(container, $('span.workflow-ticket-id-badge.code-overlay-badge'));
			badge.textContent = upperId;
			return badge;
		}
		const badge = append(container, $('span.workflow-ticket-id-badge.interactive-badge'));
		badge.textContent = upperId;
		badge.title = `Ticket ID: ${upperId} (Click to open Ticket in new Editor Tab)`;
		badge.onmousedown = (e) => {
			e.stopPropagation();
		};
		badge.ondblclick = (e) => {
			e.stopPropagation();
			e.preventDefault();
		};
		badge.onclick = (e) => {
			e.stopPropagation();
			e.preventDefault();
			this._hidePythonStepPopover(true);
			this._openModuleInEditor({ type: 'ticket', name: upperId });
		};
		return badge;
	}

	private _createTicketTypeBadge(container: HTMLElement, typeName: string, isTextareaBackdrop: boolean): HTMLElement {
		const cleanName = typeName.trim();
		if (isTextareaBackdrop) {
			const badge = append(container, $('span.workflow-ticket-type-badge.code-overlay-badge'));
			badge.textContent = cleanName;
			return badge;
		}
		const badge = append(container, $('span.workflow-ticket-type-badge.interactive-badge'));
		badge.textContent = cleanName;
		badge.title = `Ticket Type: ${cleanName} (Click to preview Template in new Editor Tab)`;
		badge.onmousedown = (e) => {
			e.stopPropagation();
		};
		badge.ondblclick = (e) => {
			e.stopPropagation();
			e.preventDefault();
		};
		badge.onclick = (e) => {
			e.stopPropagation();
			e.preventDefault();
			this._openTicketTypePreviewInEditor(cleanName);
		};
		return badge;
	}

	/** Finds the Ticket Type template (custom module) by name or id, in the parent workspace first, then the workflow folder. */
	private async _findTicketTypeModule(typeNameOrId: string): Promise<{ module: ICustomModule; wsUri: URI | undefined } | undefined> {
		const cleanType = (typeNameOrId || '').trim().replace(/^["']|["']$/g, '').trim();
		if (!cleanType) {
			return undefined;
		}
		let wsUri: URI | undefined = this._workflowUri ? URI.joinPath(this._workflowUri, '..') : undefined;
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (!wsUri && folders.length > 0) {
			wsUri = folders[0].uri;
		}
		const targetLower = cleanType.toLowerCase();
		const targetSlug = targetLower.replace(/[\s_]+/g, '-');
		const matches = (m: ICustomModule) =>
			m.name.toLowerCase() === targetLower ||
			m.id.toLowerCase() === targetLower ||
			m.id.toLowerCase() === targetSlug ||
			m.name.toLowerCase().replace(/[\s_]+/g, '-') === targetSlug;

		const modules = await this._customModulesService.getCustomModules(wsUri);
		this._cachedCustomModules = modules;
		let matchedMod = modules.find(matches);
		if (!matchedMod && wsUri && this._workflowUri && wsUri.toString() !== this._workflowUri.toString()) {
			const wfModules = await this._customModulesService.getCustomModules(this._workflowUri);
			matchedMod = wfModules.find(matches);
		}
		return matchedMod ? { module: matchedMod, wsUri } : undefined;
	}

	private async _openTicketTypePreviewInEditor(typeNameOrId: string, group?: number | typeof SIDE_GROUP): Promise<EditorInput | undefined> {
		const cleanType = (typeNameOrId || '').trim().replace(/^["']|["']$/g, '').trim();
		if (!cleanType) {
			return undefined;
		}
		this._hidePythonStepPopover(true);

		try {
			const found = await this._findTicketTypeModule(cleanType);
			if (found) {
				const matchedMod = found.module;
				const previewTargetUri = found.wsUri || this._workflowUri || URI.file('/');
				const previewInput = new EntityDetailEditorInput(previewTargetUri, matchedMod.name || matchedMod.id, false, matchedMod);
				const pane = await this._editorService.openEditor(previewInput, { pinned: true, preserveFocus: group !== undefined }, group);
				return pane?.input ?? previewInput;
			}

			this._notificationService.warn(`Ticket Type template '${cleanType}' was not found in this workspace.`);
		} catch (err) {
			this._notificationService.error(`Failed to open template preview for '${cleanType}': ${err}`);
		}
		return undefined;
	}

	private _renderExpressionWithTicketBadges(
		container: HTMLElement,
		text: string,
		isCodeOverlay: boolean = false,
		initialParenDepth: number = 0,
		isInteractivePopover: boolean = false
	): boolean {
		clearNode(container);
		if (!text) {
			return false;
		}

		const isTextareaBackdrop = isCodeOverlay && !isInteractivePopover;

		if (isCodeOverlay) {
			const tokenRegex = /(#[^\n]*)|((?:[fFrRbBuU]{1,2})?(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?))|\b([A-Za-z][A-Za-z0-9_]{1,15}-\d{1,8})\b|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
			let lastIndex = 0;
			let match: RegExpExecArray | null;

			while ((match = tokenRegex.exec(text)) !== null) {
				if (match.index > lastIndex) {
					container.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
				}

				const fullToken = match[0];
				const beforeText = text.slice(0, match.index);
				if (match[1] !== undefined) {
					// 1. Comment (#...)
					append(container, $('span.py-tok-comment', {}, fullToken));
				} else if (match[2] !== undefined) {
					// 2. String literal (or quoted Ticket ID badge / Ticket Type badge)
					const ticketIdMatch = fullToken.match(/^(["'])([A-Za-z][A-Za-z0-9_]{1,15}-\d{1,8})\1$/);
					const stringInnerMatch = fullToken.match(/^(["'])([^"'\n]+)\1$/);
					if (ticketIdMatch) {
						this._createTicketIdBadge(container, ticketIdMatch[2], isTextareaBackdrop);
					} else if (stringInnerMatch && this._isTicketTypeStringLiteral(stringInnerMatch[2], beforeText)) {
						this._createTicketTypeBadge(container, stringInnerMatch[2], isTextareaBackdrop);
					} else if (fullToken.includes('{') && fullToken.includes('}')) {
						const strSpan = append(container, $('span.py-tok-string'));
						const parts = fullToken.split(/(\{[^{}\n]+\})/g);
						for (const part of parts) {
							if (!part) { continue; }
							if (part.startsWith('{') && part.endsWith('}')) {
								append(strSpan, $('span.py-tok-interp', {}, part));
							} else {
								strSpan.appendChild(document.createTextNode(part));
							}
						}
					} else {
						append(container, $('span.py-tok-string', {}, fullToken));
					}
				} else if (match[3] !== undefined) {
					// 3. Unquoted Ticket ID literal (e.g. FINDJ-0002)
					this._createTicketIdBadge(container, match[3], isTextareaBackdrop);
				} else if (match[4] !== undefined) {
					// 4. Number literal
					append(container, $('span.py-tok-number', {}, fullToken));
				} else if (match[5] !== undefined) {
					// 5. Identifier / Keyword / Built-in / Kwarg
					const ident = match[5];
					const afterText = text.slice(match.index + ident.length);

					if (WorkflowEditor._PYTHON_KEYWORDS.has(ident)) {
						append(container, $('span.py-tok-keyword', {}, ident));
					} else if (WorkflowEditor._PYTHON_CONSTANTS.has(ident)) {
						append(container, $('span.py-tok-constant', {}, ident));
					} else if (WorkflowEditor._WORKFLOW_BUILTINS.has(ident)) {
						append(container, $('span.py-tok-wf-builtin', {}, ident));
					} else if (/(?:def|class)\s+$/.test(beforeText)) {
						append(container, $('span.py-tok-defname', {}, ident));
					} else if (/^\s*\(/.test(afterText)) {
						append(container, $('span.py-tok-func', {}, ident));
					} else if (/^\s*=(?!=)/.test(afterText)) {
						// Check if inside parentheses (keyword argument) vs variable assignment
						let parenDepth = initialParenDepth;
						for (let k = 0; k < beforeText.length; k++) {
							if (beforeText[k] === '(') { parenDepth++; }
							else if (beforeText[k] === ')') { parenDepth = Math.max(0, parenDepth - 1); }
						}
						if (parenDepth > 0) {
							append(container, $('span.py-tok-kwarg', {}, ident));
						} else {
							append(container, $('span.py-tok-var-assign', {}, ident));
						}
					} else {
						append(container, $('span.py-tok-ident', {}, ident));
					}
				}

				lastIndex = match.index + fullToken.length;
			}

			if (lastIndex < text.length) {
				container.appendChild(document.createTextNode(text.substring(lastIndex)));
			}
			if (text.endsWith('\n')) {
				container.appendChild(document.createTextNode(' '));
			}
			return true;
		}

		// Non-overlay mode (node capsules & parameter chips): render clickable Ticket ID badges and Ticket Type badges
		const pillBadgeRegex = /((["'])([A-Za-z][A-Za-z0-9_]{1,15}-\d{1,8})\2|\b([A-Za-z][A-Za-z0-9_]{1,15}-\d{1,8})\b)|((["'])([^"'{}\n]+)\6)/g;
		let lastIndex = 0;
		let hasMatch = false;
		let match: RegExpExecArray | null;

		while ((match = pillBadgeRegex.exec(text)) !== null) {
			const fullMatch = match[0];
			const beforeText = text.slice(0, match.index);
			const ticketId = match[3] || match[4];
			const stringInner = match[7];

			if (ticketId) {
				hasMatch = true;
				if (match.index > lastIndex) {
					container.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
				}
				this._createTicketIdBadge(container, ticketId, false);
				lastIndex = match.index + fullMatch.length;
			} else if (stringInner !== undefined && this._isTicketTypeStringLiteral(stringInner, beforeText)) {
				hasMatch = true;
				if (match.index > lastIndex) {
					container.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
				}
				this._createTicketTypeBadge(container, stringInner, false);
				lastIndex = match.index + fullMatch.length;
			}
		}

		if (!hasMatch) {
			container.textContent = text;
			return false;
		}

		if (lastIndex < text.length) {
			container.appendChild(document.createTextNode(text.substring(lastIndex)));
		}
		return true;
	}

	private _isFunctionCallExpression(expr?: string): boolean {
		if (!expr) { return false; }
		const trimmed = expr.trim();
		const m = trimmed.match(/^(?:@?[a-zA-Z0-9_\u4e00-\u9fa5]+\s*=\s*)?([a-zA-Z0-9_]+)\s*\([\s\S]*\)$/);
		if (!m) { return false; }
		const fn = m[1].toLowerCase();
		const valueOperatorFns = new Set([
			'date', 'today', 'time', 'now', 'datetime', 'timestamp',
			'str', 'int', 'float', 'bool', 'len', 'abs', 'min', 'max', 'round'
		]);
		return !valueOperatorFns.has(fn);
	}

	/** Last runtime value of a capsule (current / last run variables, the component's own last output, Display cards). */
	private _resolveStepRuntimeValue(node: IFlowchartNode, step: INodePipelineStep): unknown {
		const activeRun = this._getEffectiveRunForNode(node.id);
		const cleanVar = step.targetVariable?.replace(/^@/, '');
		let runtimeVal: unknown = undefined;
		if (step.component?.type === 'parameters') {
			// Inputs component: NEVER look up by generic label "Inputs" (collides across multiple flows/sub-workflows!)
			// Prefer this component's own lastExecutionOutput, or build strictly from its own declared parameter names
			const ownOut = wfComponent(step.component).lastExecutionOutput;
			if (ownOut !== undefined && ownOut !== null) {
				runtimeVal = ownOut;
			} else if (activeRun?.contextVariables && Array.isArray(step.component.parameters)) {
				const scopedParams: IWorkflowRecord = {};
				let foundAny = false;
				for (const p of step.component.parameters) {
					const pName = (p.name || '').trim();
					if (pName && Object.prototype.hasOwnProperty.call(activeRun.contextVariables, pName)) {
						scopedParams[pName] = activeRun.contextVariables[pName];
						foundAny = true;
					}
				}
				if (foundAny) {
					runtimeVal = scopedParams;
				}
			}
		} else {
			const nodeStateInRun = activeRun?.nodeStates?.[node.id];
			const activeRunExecutedNode = Boolean(nodeStateInRun && nodeStateInRun.status && nodeStateInRun.status !== 'pending');
			if (activeRunExecutedNode && activeRun?.contextVariables) {
				runtimeVal = (cleanVar ? activeRun.contextVariables[cleanVar] : undefined)
					?? (step.component?.label ? activeRun.contextVariables[step.component.label] : undefined);
			}
			if (runtimeVal === undefined && step.component && wfComponent(step.component).lastExecutionOutput !== undefined) {
				runtimeVal = wfComponent(step.component).lastExecutionOutput;
			}
			if (runtimeVal === undefined && !step.component && activeRun?.contextVariables && cleanVar) {
				runtimeVal = activeRun.contextVariables[cleanVar];
			}
			// Special handling for DISPLAY steps: resolve actual last displayed value (from component output, Live Display Card, or referenced variable)
			const isDisplayPill = Boolean(step.component?.type === 'display' || (!step.component && /^DISPLAY\s*\(/i.test((step.expression || '').trim())));
			if (isDisplayPill && runtimeVal === undefined) {
				const wfCards = this._workflowUri ? this._workflowExecutionService.getDisplayCards(this._workflowUri) : [];
				const dispArgRaw = step.component?.type === 'display'
					? (step.component.wfDisplayValue || '').trim()
					: ((step.expression || '').trim().match(/^DISPLAY\s*\(([\s\S]*)\)$/i)?.[1] || '').trim();
				const matchedCard = wfCards.find(c => c.nodeId === node.id && (!dispArgRaw || c.expression?.includes(dispArgRaw.replace(/^\{|\}$/g, ''))))
					|| wfCards.find(c => c.nodeId === node.id);
				if (matchedCard) {
					runtimeVal = matchedCard.value !== undefined ? matchedCard.value : (matchedCard.formattedText || matchedCard.displayPreviewText);
				}
				if (runtimeVal === undefined && dispArgRaw) {
					const cleanArgVar = dispArgRaw.replace(/^\{|\}$/g, '').trim();
					if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(cleanArgVar) && activeRun?.contextVariables && Object.prototype.hasOwnProperty.call(activeRun.contextVariables, cleanArgVar)) {
						runtimeVal = activeRun.contextVariables[cleanArgVar];
					}
				}
			}
		}
		return runtimeVal;
	}

	private _renderFunctionPill(
		container: HTMLElement,
		node: IFlowchartNode,
		step: INodePipelineStep,
		stepIndex?: number
	): { pill: HTMLElement; textEl: HTMLElement } {
		if (step.component) {
			this._syncComponentStepMetadata(step);
		}
		const activeRun = this._getEffectiveRunForNode(node.id);
		const cleanVar = step.targetVariable?.replace(/^@/, '');
		const runtimeVal = this._resolveStepRuntimeValue(node, step);
		const isDisplayPillForFmt = Boolean(step.component?.type === 'display' || (!step.component && /^DISPLAY\s*\(/i.test((step.expression || '').trim())));
		let rawFnRtStr = '';
		if (runtimeVal !== undefined) {
			if (isDisplayPillForFmt) {
				const tTag = runtimeVal === null ? 'null'
					: Array.isArray(runtimeVal) ? `list (${runtimeVal.length} items)`
						: typeof runtimeVal === 'object' ? `dict (${Object.keys(runtimeVal).length} keys)`
							: typeof runtimeVal;
				const valBody = runtimeVal === null ? 'null'
					: (typeof runtimeVal === 'object' ? JSON.stringify(runtimeVal, null, 2) : String(runtimeVal));
				rawFnRtStr = `[${tTag}]\n${valBody}`;
			} else if (runtimeVal !== null) {
				rawFnRtStr = typeof runtimeVal === 'object' ? JSON.stringify(runtimeVal) : String(runtimeVal);
			}
		}
		const runtimeTooltip = rawFnRtStr ? `\n(Runtime Output: ${rawFnRtStr.length > 250 ? rawFnRtStr.substring(0, 250) + ' ...' : rawFnRtStr})` : '';

		const fnPill = append(container, $('.node-function-pill'));
		if (step.disabled) {
			fnPill.classList.add('step-disabled');
		}
		const nodeStateForPill = activeRun?.nodeStates?.[node.id];
		const isFailedCapsule = Boolean(
			nodeStateForPill?.status === 'failed' && (
				nodeStateForPill.failedStepIndex !== undefined
					? nodeStateForPill.failedStepIndex === stepIndex
					: Boolean(nodeStateForPill.failedStepId && nodeStateForPill.failedStepId === step.id)
			)
		);
		if (isFailedCapsule) {
			fnPill.classList.add('step-failed');
		}
		const openStepEditor = () => {
			if (step.component) {
				this._openNodeComponentEditorModal(node, step);
			} else {
				this._openNodeFunctionInlineEditor(node, step, fnPill);
			}
		};
		fnPill.onmousedown = (e) => {
			if (e.shiftKey || e.ctrlKey || e.metaKey) {
				return;
			}
			const targetEl = e.target as HTMLElement | null;
			if (targetEl?.closest('.var-pill-remove, .fn-pill-var-badge, .fn-pill-var-input, .capsule-resize-handle')) {
				e.stopPropagation();
				return;
			}
			e.stopPropagation();
			if (e.button !== 0) {
				return;
			}
			const now = Date.now();
			const stepKey = step.id || step.component?.id || `${stepIndex}`;
			if (
				this._lastStepPillClick &&
				this._lastStepPillClick.nodeId === node.id &&
				this._lastStepPillClick.stepId === stepKey &&
				now - this._lastStepPillClick.time < 400
			) {
				this._lastStepPillClick = undefined;
				e.preventDefault();
				openStepEditor();
				return;
			}
			this._lastStepPillClick = { nodeId: node.id, stepId: stepKey, time: now };
		};
		fnPill.onclick = (e) => {
			if (e.shiftKey || e.ctrlKey || e.metaKey) {
				return;
			}
			const targetEl = e.target as HTMLElement | null;
			if (targetEl?.closest('.var-pill-remove, .fn-pill-var-badge, .fn-pill-var-input, .capsule-resize-handle')) {
				e.stopPropagation();
				return;
			}
			e.stopPropagation();
			if (wfCapsuleJustDraggedAt.get(fnPill) && Date.now() - wfCapsuleJustDraggedAt.get(fnPill)! < 250) {
				return;
			}
			if (!this._selectedNodeIds.has(node.id) || this._selectedNodeIds.size > 1) {
				this._selectedNodeIds.clear();
				this._selectedNodeIds.add(node.id);
				this._renderNodes();
			}
			// If this is a component pill and a side group or node component editor is already open, sync/focus it on click as well
			if (step.component && this._editorGroupService.groups.some(g => g.id !== this.group.id)) {
				this._openNodeComponentEditorModal(node, step);
			}
		};
		fnPill.ondblclick = (e) => {
			const targetEl = e.target as HTMLElement | null;
			if (targetEl?.closest('.var-pill-remove, .fn-pill-var-badge, .fn-pill-var-input, .capsule-resize-handle')) {
				e.stopPropagation();
				return;
			}
			e.stopPropagation();
			e.preventDefault();
			this._lastStepPillClick = undefined;
			openStepEditor();
		};

		const compIconMap = WF_COMPONENT_CAPSULE_THEMES;
		const compTheme = step.component ? compIconMap[step.component.type] : undefined;

		const fnBadge = append(fnPill, $('span.fn-tag-icon' + ThemeIcon.asCSSSelector(compTheme ? compTheme.icon : Codicon.python)));
		fnBadge.style.whiteSpace = 'nowrap';
		fnBadge.style.flexShrink = '0';
		fnBadge.style.color = compTheme ? compTheme.color : '#c084fc';
		if (step.component?.type === 'python') {
			fnBadge.style.border = '1.2px solid currentColor';
			fnBadge.style.borderRadius = '3px';
			fnBadge.style.padding = '1px 2px';
			fnBadge.style.background = 'transparent';
			fnBadge.style.fontSize = '10px';
			fnBadge.style.lineHeight = '1';
		}

		const pillContent = append(fnPill, $('.fn-pill-text'));
		const isUntouchedDefault = step.expression && /^(?:res\s*=\s*)?RUN_TICKETS\(\s*ticket\s*=\s*""\s*(?:,\s*params\s*=\s*\{\s*\}\s*)?\)$/i.test(step.expression.trim());
		let rawExpr = step.component
			? this._formatNodeComponentSummary(step.component)
			: ((!isUntouchedDefault && step.expression)
				? step.expression
				: (cleanVar && !isUntouchedDefault && step.functionName && step.functionName !== 'PYTHON' ? `${cleanVar} = ${step.functionName}()` : 'Python Step'));
		if (!step.component && (rawExpr.startsWith('#') || rawExpr.startsWith('+ content') || rawExpr.includes('URL: https://'))) {
			rawExpr = cleanVar ? `${cleanVar} = ${step.functionName || 'PYTHON'}()` : 'Python Step';
		}
		rawExpr = rawExpr.replace(/(^|[^a-zA-Z0-9_])@([a-zA-Z_][a-zA-Z0-9_]*)/g, '$1$2');
		// If this step is a set_variable step whose expression doesn't yet include `var = `, prefix it
		if (!step.component && step.type === 'set_variable' && cleanVar && !/^[a-zA-Z_][a-zA-Z0-9_]*\s*(?::\s*[^=]+)?(?:\+|-|\*|\/)?=(?!=)/.test(rawExpr.trim())) {
			rawExpr = `${cleanVar} = ${rawExpr.trim()}`;
		}

		// Distinguish pure variable definition / value assignment (Blue pill) vs built-in function call / control flow (Purple pill) vs Component pill
		const callsWorkflowBuiltin = /\b(RUN_TICKETS|CREATE_TICKETS|GET_TICKET|GET_TICKETS|GET_OUTPUTS|DISPLAY|PRINT|GET_PRIMITIVES_CATALOG)\s*\(/.test(rawExpr);
		const isControlFlowOrDef = /^(?:for|while|if|elif|else|def|async\s+def|class|try|with|return|raise|import|from)\b/.test(rawExpr.trim());
		const isPureVariableStep = !step.component && !callsWorkflowBuiltin && !isControlFlowOrDef && (
			step.type === 'set_variable' ||
			/^[a-zA-Z_][a-zA-Z0-9_]*(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)*\s*(?::\s*[^=]+)?(?:\+|-|\*|\/)?=(?!=)/.test(rawExpr.trim())
		);
		if (compTheme) {
			fnPill.style.background = compTheme.bg;
			fnPill.style.borderColor = compTheme.border;
			fnPill.style.color = compTheme.textColor;
			fnBadge.style.color = compTheme.color;
			pillContent.style.color = compTheme.textColor;
		} else if (isPureVariableStep) {
			fnPill.style.background = 'rgba(14, 165, 233, 0.14)';
			fnPill.style.borderColor = 'rgba(56, 189, 248, 0.45)';
			fnPill.style.color = '#e0f2fe';
			fnBadge.style.color = '#38bdf8';
			pillContent.style.color = '#bae6fd';
		}

		const lines = rawExpr.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
		let displayExpr = lines[0] || rawExpr;
		if (lines.length > 1) {
			displayExpr = `${displayExpr} (+${lines.length - 1} lines)`;
		}
		const comp = step.component;
		const isStandardComponentCapsule = Boolean(
			comp && !['parameters', 'output', 'display', 'create_tickets', 'run_tickets', 'get_outputs', 'get_ticket', 'get_tickets'].includes(comp.type)
		);
		const maxCapsuleChars = typeof step.capsuleWidth === 'number' ? 400 : (isStandardComponentCapsule ? 240 : 180);
		if (displayExpr.length > maxCapsuleChars) {
			displayExpr = displayExpr.substring(0, maxCapsuleChars - 3) + '...';
		}

		const isEditableComponentVar = comp && comp.type !== 'parameters' && comp.type !== 'output' && comp.type !== 'display';
		const eqIdx = isEditableComponentVar ? displayExpr.indexOf(' = ') : -1;

		// Detect CREATE_TICKETS (both native create_tickets component & classic Python CREATE_TICKETS(...) step)
		let createTicketsInfo: { varName: string; ticketType: string } | undefined;
		if (comp?.type === 'create_tickets') {
			createTicketsInfo = {
				varName: this._getComponentOutputVarName(comp),
				ticketType: (comp.wfTicketType || '').trim()
			};
		} else if (!comp) {
			const ctMatch = rawExpr.trim().match(/^(?:([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*)?(?:CREATE_TICKETS|create_tickets)\s*\(([\s\S]*)\)$/);
			if (ctMatch) {
				const argsBody = ctMatch[2] || '';
				let extractedType = '';
				const kwMatch = argsBody.match(/\b(?:ticket_type|entity_type|module_type)\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
				if (kwMatch) {
					extractedType = (kwMatch[1] ?? kwMatch[2] ?? '').trim();
				} else {
					const posMatch = argsBody.match(/^\s*(?:"([^"]*)"|'([^']*)')/);
					if (posMatch) {
						extractedType = (posMatch[1] ?? posMatch[2] ?? '').trim();
					}
				}
				createTicketsInfo = {
					varName: (ctMatch[1] || cleanVar || '').trim(),
					ticketType: extractedType
				};
			}
		}

		if (isEditableComponentVar && comp && eqIdx > 0) {
			const varNameStr = displayExpr.substring(0, eqIdx).trim();
			const rhsExprStr = displayExpr.substring(eqIdx + 3);

			const varBadge = append(pillContent, $('span.fn-pill-var-badge', {
				style: 'display: inline; padding: 0; margin: 0; background: transparent; border: none; color: inherit; font-family: inherit; font-weight: inherit; cursor: pointer; transition: text-decoration-color 0.12s ease;'
			}, varNameStr));

			varBadge.onmouseenter = () => {
				varBadge.style.textDecoration = 'underline dashed rgba(255, 255, 255, 0.55)';
			};
			varBadge.onmouseleave = () => {
				varBadge.style.textDecoration = 'none';
			};

			varBadge.onclick = (e) => {
				e.stopPropagation();
				e.preventDefault();
				this._hidePythonStepPopover(true);

				const currentVar = this._getComponentOutputVarName(comp);
				const inlineInput = $('input.fn-pill-var-input', {
					type: 'text',
					value: currentVar,
					title: 'Enter Python variable name (press Enter to save, Esc to cancel, or clear to auto-derive)',
					style: `width: ${Math.max(76, currentVar.length * 7.5 + 16)}px; padding: 0px 4px; margin-right: 1px; font-size: 11px; font-weight: 600; font-family: var(--vscode-editor-font-family, monospace); color: inherit; background: rgba(15, 23, 42, 0.85); border: 1px solid rgba(56, 189, 248, 0.75); border-radius: 3px; outline: none;`
				}) as HTMLInputElement;

				varBadge.replaceWith(inlineInput);
				inlineInput.focus();
				inlineInput.select();

				let committed = false;
				const commitVarEdit = (cancel: boolean) => {
					if (committed) {
						return;
					}
					committed = true;
					if (!cancel) {
						const rawTyped = inlineInput.value.trim();
						const autoCandidate = generateSmartPythonVarName(comp.label || comp.id, comp.type);
						const nextVar = rawTyped ? sanitizePythonVarName(rawTyped, comp.type) : autoCandidate;
						comp.outputVariableManual = rawTyped.length > 0 && nextVar !== autoCandidate;
						comp.outputVariableName = nextVar;
						this._syncComponentStepMetadata(step);
						this._syncToNode(node, true);
						this._saveFlowchartData();
						const existingInput = this._nodeEditorInputsByNodeId.get(node.id);
						if (existingInput && !existingInput.isDisposed() && existingInput.draftModule) {
							const nodeFields = (node.pipeline || [])
								.filter(st => !!st.component)
								.map(st => st.component!);
							existingInput.draftModule.fields = [
								{ id: 'title', label: 'Title', type: 'text', required: true },
								...nodeFields
							];
							existingInput.notifyExternalDraftUpdated();
						}
					}
					this._renderNodes();
				};

				inlineInput.onkeydown = (ke) => {
					ke.stopPropagation();
					if (ke.key === 'Enter') {
						ke.preventDefault();
						commitVarEdit(false);
					} else if (ke.key === 'Escape') {
						ke.preventDefault();
						commitVarEdit(true);
					}
				};
				inlineInput.onblur = () => {
					commitVarEdit(false);
				};
			};

			append(pillContent, $('span', {}, ' = '));
			if (createTicketsInfo) {
				append(pillContent, $('span', {}, 'CREATE_TICKETS(ticket_type='));
				const typeLabel = createTicketsInfo.ticketType || 'Unspecified Type';
				const typeBadge = append(pillContent, $(`span.fn-pill-ticket-type-badge${createTicketsInfo.ticketType ? '' : '.empty'}`, {}, typeLabel));
				typeBadge.title = `Create Ticket Type: ${typeLabel}`;
				append(pillContent, $('span', {}, ', ...)'));
			} else {
				const rhsSpan = append(pillContent, $('span'));
				if (isStandardComponentCapsule) {
					rhsSpan.textContent = rhsExprStr;
				} else {
					this._renderExpressionWithTicketBadges(rhsSpan, rhsExprStr, false);
				}
			}
		} else if (createTicketsInfo) {
			if (createTicketsInfo.varName) {
				append(pillContent, $('span', {}, `${createTicketsInfo.varName} = CREATE_TICKETS(ticket_type=`));
			} else {
				append(pillContent, $('span', {}, 'CREATE_TICKETS(ticket_type='));
			}
			const typeLabel = createTicketsInfo.ticketType || 'Unspecified Type';
			const typeBadge = append(pillContent, $(`span.fn-pill-ticket-type-badge${createTicketsInfo.ticketType ? '' : '.empty'}`, {}, typeLabel));
			typeBadge.title = `Create Ticket Type: ${typeLabel}`;
			append(pillContent, $('span', {}, ', ...)'));
		} else {
			this._renderExpressionWithTicketBadges(pillContent, displayExpr, false);
		}
		if (isFailedCapsule) {
			const errBadgePill = append(fnPill, $('span.fn-pill-error-badge', {}, '\u2717 FAILED'));
			const errMsg = nodeStateForPill?.failedStepError || nodeStateForPill?.error || 'Execution failed';
			errBadgePill.title = `Step #${stepIndex + 1} Failed: ${errMsg}`;
			fnPill.title = `[FAILED at Step #${stepIndex + 1}]: ${errMsg}`;
		} else if (step.disabled) {
			fnPill.title = `[Commented Out / Disabled] ${displayExpr}\n(Skipped during workflow execution. Double-click to edit or re-enable)`;
		}
		void runtimeTooltip;

		fnPill.onmouseenter = () => {
			const latestRawExpr = step.component ? this._formatNodeComponentSummary(step.component) : rawExpr;
			this._schedulePythonStepPopover(fnPill, node, step, stepIndex, latestRawExpr, isPureVariableStep, rawFnRtStr);
		};
		fnPill.onmouseleave = () => {
			this._hidePythonStepPopover();
		};
		fnPill.addEventListener('mousedown', () => {
			this._hidePythonStepPopover(true);
		});

		const removeFnBtn = append(fnPill, $('.var-pill-remove'));
		removeFnBtn.title = 'Remove function step';
		append(removeFnBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
		removeFnBtn.onmouseenter = () => {
			if (this._pythonStepHoverShowTimeout) {
				clearTimeout(this._pythonStepHoverShowTimeout);
				this._pythonStepHoverShowTimeout = null;
			}
		};
		removeFnBtn.onmousedown = (e) => {
			e.stopPropagation();
			this._hidePythonStepPopover(true);
			this._hideTicketPopover(true);
		};
		removeFnBtn.onclick = (e) => {
			e.stopPropagation();
			e.preventDefault();
			this._hidePythonStepPopover(true);
			this._hideTicketPopover(true);
			if (node.pipeline) {
				const idx = node.pipeline.indexOf(step);
				if (idx !== -1) {
					node.pipeline.splice(idx, 1);
					this._syncToNode(node, true);
					this._saveFlowchartData();
					this._renderNodes();
					const existingInput = this._nodeEditorInputsByNodeId.get(node.id);
					if (existingInput && this._editorService.editors.some(ed => ed.matches(existingInput))) {
						this._openNodeComponentsInSideEditor(node);
					}
				}
			}
		};

		return { pill: fnPill, textEl: pillContent };
	}

	private _attachCapsuleDragReorder(
		pillEl: HTMLElement,
		badgesContainer: HTMLElement,
		node: IFlowchartNode,
		stepIndex: number,
		/** The capsule's label element (`.fn-pill-text` / `.badge-text`), used for the drag ghost. */
		labelEl: HTMLElement
	): void {
		pillEl.setAttribute('data-pipeline-step-idx', String(stepIndex));

		// Apply user-saved custom capsule width (overflow past node boundary is clipped by container)
		const initialStep = node.pipeline?.[stepIndex];
		if (initialStep && typeof initialStep.capsuleWidth === 'number' && initialStep.capsuleWidth > 0) {
			pillEl.classList.add('capsule-custom-width');
			pillEl.style.width = `${Math.round(initialStep.capsuleWidth)}px`;
		}

		// Right-edge resize handle for user-controlled capsule length
		const resizeHandle = append(pillEl, $('span.capsule-resize-handle', {
			title: 'Drag to resize capsule width · Double-click to reset'
		}));
		resizeHandle.addEventListener('click', (e: MouseEvent) => {
			e.stopPropagation();
			e.preventDefault();
		});
		resizeHandle.addEventListener('dblclick', (e: MouseEvent) => {
			e.stopPropagation();
			e.preventDefault();
			const curStep = node.pipeline?.[stepIndex];
			if (curStep && typeof curStep.capsuleWidth === 'number') {
				delete curStep.capsuleWidth;
				this._saveFlowchartData();
				this._renderNodes();
			}
		});
		resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
			if (e.button !== 0) {
				return;
			}
			e.stopPropagation();
			e.preventDefault();
			this._lastStepPillClick = undefined;
			this._hidePythonStepPopover(true);
			this._hideTicketPopover();

			const curStep = node.pipeline?.[stepIndex];
			if (!curStep) {
				return;
			}

			const zoom = this._zoomLevel || 1;
			const startX = e.clientX;
			const startWidth = typeof curStep.capsuleWidth === 'number' && curStep.capsuleWidth > 0
				? curStep.capsuleWidth
				: Math.round(pillEl.getBoundingClientRect().width / zoom);
			let nextWidth = startWidth;
			let didResize = false;

			pillEl.classList.add('capsule-custom-width', 'capsule-resizing');
			pillEl.style.width = `${startWidth}px`;
			this._targetWindow.document.body.style.cursor = 'ew-resize';

			const onResizeMove = (mvEvent: MouseEvent) => {
				const deltaX = (mvEvent.clientX - startX) / zoom;
				if (!didResize && Math.abs(deltaX) >= 2) {
					didResize = true;
				}
				nextWidth = Math.max(48, Math.round(startWidth + deltaX));
				pillEl.style.width = `${nextWidth}px`;
			};

			const onResizeUp = () => {
				this._targetWindow.removeEventListener('mousemove', onResizeMove);
				this._targetWindow.removeEventListener('mouseup', onResizeUp);
				pillEl.classList.remove('capsule-resizing');
				this._targetWindow.document.body.style.cursor = '';

				if (didResize) {
					curStep.capsuleWidth = nextWidth;
					wfCapsuleJustDraggedAt.set(pillEl, Date.now());
					this._saveFlowchartData();
				} else if (typeof curStep.capsuleWidth !== 'number') {
					pillEl.classList.remove('capsule-custom-width');
					pillEl.style.width = '';
				}
			};

			this._targetWindow.addEventListener('mousemove', onResizeMove);
			this._targetWindow.addEventListener('mouseup', onResizeUp);
		});

		const initStep = node.pipeline?.[stepIndex];
		if (initStep) {
			pillEl.setAttribute('data-pipeline-step-id', initStep.id);
			if (this._selectedCapsules?.nodeId === node.id && this._selectedCapsules.stepIds.has(initStep.id)) {
				pillEl.classList.add('capsule-multi-selected');
			}
		}

		pillEl.addEventListener('contextmenu', (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const curStep = node.pipeline?.[stepIndex];
			if (curStep) {
				this._selectedCapsule = { nodeId: node.id, stepId: curStep.id };
				this._showCapsuleContextMenu(e.clientX, e.clientY, node, stepIndex);
			}
		});
		pillEl.addEventListener('mousedown', (e: MouseEvent) => {
			const curStep = node.pipeline?.[stepIndex];
			const targetEl = e.target as HTMLElement | null;
			if (targetEl?.closest('.var-pill-remove, .fn-pill-var-badge, .fn-pill-var-input, .capsule-resize-handle')) {
				return;
			}
			if (e.button !== 0 || !curStep) {
				return;
			}

			// Cmd/Ctrl-click: toggle individual capsule in multi-selection within this node
			if (e.metaKey || e.ctrlKey) {
				e.preventDefault();
				e.stopPropagation();
				wfCapsuleJustDraggedAt.set(pillEl, Date.now());
				if (!this._selectedCapsules || this._selectedCapsules.nodeId !== node.id) {
					const initialIds = new Set<string>();
					if (this._selectedCapsule?.nodeId === node.id) {
						initialIds.add(this._selectedCapsule.stepId);
					}
					initialIds.add(curStep.id);
					this._selectedCapsules = { nodeId: node.id, stepIds: initialIds, anchorIndex: stepIndex };
				} else {
					if (this._selectedCapsules.stepIds.has(curStep.id)) {
						this._selectedCapsules.stepIds.delete(curStep.id);
					} else {
						this._selectedCapsules.stepIds.add(curStep.id);
					}
					this._selectedCapsules.anchorIndex = stepIndex;
					if (this._selectedCapsules.stepIds.size === 0) {
						this._selectedCapsules = null;
					}
				}
				this._selectedCapsule = { nodeId: node.id, stepId: curStep.id };
				this._updateCapsuleSelectionDom();
				return;
			}

			// Shift-click: range-select capsules from anchor to current index within this node
			if (e.shiftKey) {
				e.preventDefault();
				e.stopPropagation();
				wfCapsuleJustDraggedAt.set(pillEl, Date.now());
				const pipeline = node.pipeline || [];
				let anchor = stepIndex;
				if (this._selectedCapsules?.nodeId === node.id) {
					anchor = this._selectedCapsules.anchorIndex;
				} else if (this._selectedCapsule?.nodeId === node.id) {
					const prevIdx = pipeline.findIndex(s => s.id === this._selectedCapsule!.stepId);
					if (prevIdx >= 0) {
						anchor = prevIdx;
					}
				}
				const lo = Math.max(0, Math.min(anchor, stepIndex));
				const hi = Math.min(pipeline.length - 1, Math.max(anchor, stepIndex));
				const rangeIds = new Set<string>();
				for (let r = lo; r <= hi; r++) {
					if (pipeline[r]?.id) {
						rangeIds.add(pipeline[r].id);
					}
				}
				this._selectedCapsules = { nodeId: node.id, stepIds: rangeIds, anchorIndex: anchor };
				this._selectedCapsule = { nodeId: node.id, stepId: curStep.id };
				this._updateCapsuleSelectionDom();
				return;
			}

			// Plain left-click: if capsule is NOT in current multi-selection, reset multi-selection
			const isInCurrentMultiSelection = Boolean(
				this._selectedCapsules &&
				this._selectedCapsules.nodeId === node.id &&
				this._selectedCapsules.stepIds.has(curStep.id) &&
				this._selectedCapsules.stepIds.size > 1
			);
			if (!isInCurrentMultiSelection) {
				this._selectedCapsules = null;
				this._updateCapsuleSelectionDom();
			}
			this._selectedCapsule = { nodeId: node.id, stepId: curStep.id };
			e.stopPropagation();

			// Compute all indices participating in this drag (single or multi-selected batch)
			const draggedIndices: number[] = [];
			if (isInCurrentMultiSelection && this._selectedCapsules && node.pipeline) {
				for (let idx = 0; idx < node.pipeline.length; idx++) {
					if (this._selectedCapsules.stepIds.has(node.pipeline[idx].id)) {
						draggedIndices.push(idx);
					}
				}
			}
			if (draggedIndices.length === 0) {
				draggedIndices.push(stepIndex);
			}

			const startX = e.clientX;
			const startY = e.clientY;
			let isDragging = false;
			let targetInsertIdx = stepIndex;
			let hoveredTargetNode: IFlowchartNode | null = node;
			let hoveredTargetEditor: WorkflowEditor | null = this;
			let ghostEl: HTMLElement | null = null;
			let copyBadgeEl: HTMLElement | null = null;

			// 2-second dwell-to-copy (or Alt/Option instant copy) state when hovering over a different target node or split editor
			let copyHoverKey: string | null = null;
			let copyModeReady = false;
			let copyTimer: ReturnType<typeof setTimeout> | null = null;
			let copyCountdownInterval: number | null = null;

			// Node elements and capsules on every open editor's canvas: the only elements that receive drop / copy indicator classes.
			const getDropIndicatorElements = (): HTMLElement[] => {
				const els: HTMLElement[] = [];
				let hasRoot = false;
				for (const ed of WorkflowEditor._openWorkflowEditors) {
					const nodesContainer = ed._nodesContainer;
					if (nodesContainer) {
						hasRoot = true;
						for (const d of ed._nodeDoms) {
							if (nodesContainer.contains(d.nodeEl)) {
								els.push(d.nodeEl, ...d.capsules);
							}
						}
					}
				}
				if (!hasRoot && badgesContainer) {
					els.push(...(this._nodeDoms.find(d => d.nodeId === node.id)?.capsules || []).filter(c => badgesContainer.contains(c)));
				}
				return els;
			};

			const resetCopyTimer = () => {
				if (copyTimer) {
					clearTimeout(copyTimer);
					copyTimer = null;
				}
				if (copyCountdownInterval) {
					this._targetWindow.clearInterval(copyCountdownInterval);
					copyCountdownInterval = null;
				}
				copyHoverKey = null;
				copyModeReady = false;
				if (ghostEl) {
					ghostEl.classList.remove('copy-ready');
				}
				if (copyBadgeEl) {
					copyBadgeEl.style.display = 'none';
					copyBadgeEl.classList.remove('is-ready');
					copyBadgeEl.textContent = '';
				}
				for (const el of getDropIndicatorElements()) {
					el.classList.remove('capsule-copy-ready');
				}
			};

			const clearDropIndicators = () => {
				for (const el of getDropIndicatorElements()) {
					el.classList.remove('capsule-drop-before', 'capsule-drop-after');
					el.classList.remove('capsule-drop-target-node', 'capsule-copy-ready');
				}
			};

			const onMouseMove = (mvEvent: MouseEvent) => {
				const dist = Math.hypot(mvEvent.clientX - startX, mvEvent.clientY - startY);
				if (!isDragging && dist >= 4) {
					isDragging = true;
					this._lastStepPillClick = undefined;
					this._hidePythonStepPopover(true);
					this._hideTicketPopover();
					pillEl.classList.add('capsule-dragging');

					ghostEl = $('.workflow-capsule-drag-ghost');
					const baseLabel = (labelEl.textContent || pillEl.textContent || 'Step').trim();
					const labelSpan = append(ghostEl, $('span', {}, draggedIndices.length > 1 ? `${draggedIndices.length} capsules` : baseLabel));
					labelSpan.style.overflow = 'hidden';
					labelSpan.style.textOverflow = 'ellipsis';
					copyBadgeEl = append(ghostEl, $('span.workflow-capsule-copy-badge'));
					copyBadgeEl.style.display = 'none';
					const compStyle = this._targetWindow.getComputedStyle(pillEl);
					if (compStyle.borderColor) {
						ghostEl.style.borderColor = compStyle.borderColor;
					}
					if (compStyle.color) {
						ghostEl.style.color = compStyle.color;
					}
					this._targetWindow.document.body.appendChild(ghostEl);
				}

				if (!isDragging) {
					return;
				}
				mvEvent.preventDefault();
				mvEvent.stopPropagation();

				if (ghostEl) {
					ghostEl.style.left = `${mvEvent.clientX + 10}px`;
					ghostEl.style.top = `${mvEvent.clientY - 12}px`;
				}

				clearDropIndicators();

				// Detect which node the pointer is currently hovering over across ALL visible split WorkflowEditor instances
				const hit = WorkflowEditor._findHoveredNodeAcrossEditors(mvEvent.clientX, mvEvent.clientY);
				const hitEditor = hit?.editor || null;
				const hitNodeEl = hit?.nodeEl || null;
				const hitNode = hit?.node || null;

				hoveredTargetEditor = hitEditor;
				hoveredTargetNode = hitNode;
				if (!hitNode || !hitNodeEl || !hitEditor) {
					resetCopyTimer();
					return;
				}

				const isCrossNode = hitEditor !== this || hitNode.id !== node.id;
				const currentHoverKey = `${hitEditor._workflowUri?.toString() || 'ed'}:${hitNode.id}`;

				if (isCrossNode) {
					hitNodeEl.classList.add('capsule-drop-target-node');
					if (mvEvent.altKey) {
						if (copyHoverKey !== currentHoverKey || !copyModeReady) {
							resetCopyTimer();
							copyHoverKey = currentHoverKey;
							copyModeReady = true;
						}
						hitNodeEl.classList.add('capsule-copy-ready');
						if (ghostEl) {
							ghostEl.classList.add('copy-ready');
						}
						if (copyBadgeEl) {
							copyBadgeEl.style.display = 'inline-flex';
							copyBadgeEl.classList.add('is-ready');
							copyBadgeEl.textContent = '✓ COPY MODE';
						}
					} else if (copyHoverKey !== currentHoverKey) {
						resetCopyTimer();
						copyHoverKey = currentHoverKey;
						const enteredAt = Date.now();
						const targetElRef = hitNodeEl;
						if (copyBadgeEl) {
							copyBadgeEl.style.display = 'inline-flex';
							copyBadgeEl.classList.remove('is-ready');
							copyBadgeEl.textContent = 'Hold 2.0s / Alt to Copy';
						}
						copyCountdownInterval = this._targetWindow.setInterval(() => {
							const rem = Math.max(0, 2.0 - (Date.now() - enteredAt) / 1000);
							if (copyBadgeEl && !copyModeReady) {
								copyBadgeEl.textContent = `Hold ${rem.toFixed(1)}s / Alt to Copy`;
							}
						}, 100);
						copyTimer = setTimeout(() => {
							copyModeReady = true;
							if (copyCountdownInterval) {
								this._targetWindow.clearInterval(copyCountdownInterval);
								copyCountdownInterval = null;
							}
							targetElRef.classList.add('capsule-copy-ready');
							if (ghostEl) {
								ghostEl.classList.add('copy-ready');
							}
							if (copyBadgeEl) {
								copyBadgeEl.style.display = 'inline-flex';
								copyBadgeEl.classList.add('is-ready');
								copyBadgeEl.textContent = '✓ COPY MODE';
							}
						}, 2000);
					} else if (copyModeReady) {
						hitNodeEl.classList.add('capsule-copy-ready');
					}
				} else {
					resetCopyTimer();
				}

				const targetPills = [...(wfNodeDomByElement.get(hitNodeEl)?.capsules || [])];
				if (targetPills.length === 0) {
					targetInsertIdx = 0;
					return;
				}

				let foundBefore = false;
				for (let k = 0; k < targetPills.length; k++) {
					const r = targetPills[k].getBoundingClientRect();
					const midY = r.top + r.height / 2;
					if (mvEvent.clientY < midY) {
						targetInsertIdx = k;
						targetPills[k].classList.add('capsule-drop-before');
						foundBefore = true;
						break;
					}
				}
				if (!foundBefore) {
					targetInsertIdx = targetPills.length;
					targetPills[targetPills.length - 1].classList.add('capsule-drop-after');
				}
			};

			const onMouseUp = (upEvent: MouseEvent) => {
				this._targetWindow.removeEventListener('mousemove', onMouseMove, true);
				this._targetWindow.removeEventListener('mouseup', onMouseUp, true);

				const dropHoverKey = hoveredTargetEditor && hoveredTargetNode
					? `${hoveredTargetEditor._workflowUri?.toString() || 'ed'}:${hoveredTargetNode.id}`
					: null;
				const shouldCopy = upEvent.altKey || (copyModeReady && Boolean(dropHoverKey && dropHoverKey === copyHoverKey));
				resetCopyTimer();

				if (ghostEl) {
					ghostEl.remove();
					ghostEl = null;
					copyBadgeEl = null;
				}
				pillEl.classList.remove('capsule-dragging');
				clearDropIndicators();

				if (!isDragging) {
					// Plain click on a previously multi-selected capsule collapses selection to single capsule
					if (isInCurrentMultiSelection) {
						this._selectedCapsules = null;
						this._updateCapsuleSelectionDom();
					}
					return;
				}
				upEvent.preventDefault();
				upEvent.stopPropagation();
				wfCapsuleJustDraggedAt.set(pillEl, Date.now());

				if (!hoveredTargetNode) {
					return;
				}

				// Cross-node / Cross-split drag & drop: copy (if hovered >= 2s or Alt held) or move capsule(s)
				if (hoveredTargetEditor && (hoveredTargetEditor !== this || hoveredTargetNode.id !== node.id)) {
					this._transferCapsulesBetweenNodes(node, draggedIndices, hoveredTargetNode, targetInsertIdx, shouldCopy ? 'copy' : 'move', hoveredTargetEditor);
					return;
				}

				// Same-node drag & drop: reorder single or multi-selected capsule(s) within the node
				if (node.pipeline && node.pipeline.length > 1) {
					const sorted = Array.from(new Set(draggedIndices)).sort((a, b) => a - b);
					const selectedSet = new Set(sorted);
					const movingSteps = sorted.map(idx => node.pipeline![idx]);
					const remaining = node.pipeline.filter((_, idx) => !selectedSet.has(idx));
					const removedBeforeTarget = sorted.filter(idx => idx < targetInsertIdx).length;
					const adjustedIdx = Math.max(0, Math.min(remaining.length, targetInsertIdx - removedBeforeTarget));
					const nextPipeline = [...remaining.slice(0, adjustedIdx), ...movingSteps, ...remaining.slice(adjustedIdx)];
					const changed = nextPipeline.some((st, i) => st !== node.pipeline![i]);
					if (changed) {
						node.pipeline = nextPipeline;
						this._syncToNode(node, true);
						this._saveFlowchartData();
						this._renderNodes();
						this._drawLinks();
						if (this._inspectorEl) {
							this._renderInspector(this._inspectorEl);
						}
						if (this._pipelinePanelEl && this._activePipelineNodeId === node.id) {
							this._renderPipelinePanel(this._pipelinePanelEl, node);
						}
						const existingInput = this._nodeEditorInputsByNodeId.get(node.id);
						if (existingInput && !existingInput.isDisposed() && existingInput.draftModule) {
							const nodeFields = (node.pipeline || [])
								.filter(st => !!st.component)
								.map(st => st.component!);
							existingInput.draftModule.fields = [
								{ id: 'title', label: 'Title', type: 'text', required: true },
								...nodeFields
							];
							existingInput.notifyExternalDraftUpdated();
						}
					}
				}
			};

			this._targetWindow.addEventListener('mousemove', onMouseMove, true);
			this._targetWindow.addEventListener('mouseup', onMouseUp, true);
		});
	}

	private _updateCapsuleSelectionDom(): void {
		if (!this._nodesContainer) {
			return;
		}
		const allPills = this._renderedNodeDoms().flatMap(d => d.capsules.filter(el => el.hasAttribute('data-pipeline-step-id')).map(el => ({ el, nodeEl: d.nodeEl })));
		allPills.forEach(({ el, nodeEl }) => {
			const stepId = el.getAttribute('data-pipeline-step-id');
			const nodeId = nodeEl.getAttribute('data-node-id');
			const isSelected = Boolean(
				this._selectedCapsules &&
				nodeId &&
				stepId &&
				this._selectedCapsules.nodeId === nodeId &&
				this._selectedCapsules.stepIds.has(stepId)
			);
			el.classList.toggle('capsule-multi-selected', isSelected);
		});
	}

	private _getNodeVoiceNoteState(node: IFlowchartNode): {
		hasVoiceNoteComponent: boolean;
		firstVoiceNoteCompId?: string;
		clips: Array<{ clip: IVoiceNoteClip; compLabel: string; playbackRate: number }>;
	} {
		let hasVoiceNoteComponent = false;
		let firstVoiceNoteCompId: string | undefined = undefined;
		const clips: Array<{ clip: IVoiceNoteClip; compLabel: string; playbackRate: number }> = [];
		for (const step of (node.pipeline || [])) {
			const comp = step?.component;
			if (comp && comp.type === 'voice_note') {
				hasVoiceNoteComponent = true;
				if (!firstVoiceNoteCompId) {
					firstVoiceNoteCompId = comp.id;
				}
				const rate = typeof comp.voicePlaybackRate === 'number' && Number.isFinite(comp.voicePlaybackRate) ? comp.voicePlaybackRate : 1.0;
				const compClips = Array.isArray(comp.voiceClips) ? comp.voiceClips : [];
				for (const clip of compClips) {
					if (clip && clip.audioDataUrl) {
						clips.push({ clip, compLabel: comp.label || 'Voice Note', playbackRate: rate });
					}
				}
			}
		}
		return { hasVoiceNoteComponent, firstVoiceNoteCompId, clips };
	}

	private _voiceDataUrlToBlobUrl(dataUrl: string, fallbackMime?: string): string {
		if (!dataUrl.startsWith('data:')) {
			return dataUrl;
		}
		const commaIdx = dataUrl.indexOf(',');
		if (commaIdx === -1) {
			return dataUrl;
		}
		const header = dataUrl.substring(0, commaIdx);
		const b64 = dataUrl.substring(commaIdx + 1);
		const mimeMatch = header.match(/data:([^;]+)/i);
		const mime = (mimeMatch ? mimeMatch[1] : '') || fallbackMime || 'audio/webm';
		const bstr = atob(b64);
		const len = bstr.length;
		const u8arr = new Uint8Array(len);
		for (let i = 0; i < len; i++) {
			u8arr[i] = bstr.charCodeAt(i);
		}
		const blob = new Blob([u8arr], { type: mime });
		return URL.createObjectURL(blob);
	}

	private _stopNodeVoicePlayback(): void {
		const prevNodeId = this._activeVoicePlayNodeId;
		this._activeVoicePlayNodeId = null;
		this._activeVoiceClipIndex = 0;
		this._activeVoiceClipTotal = 0;
		if (this._activeVoiceAudioEl) {
			try {
				this._activeVoiceAudioEl.onended = null;
				this._activeVoiceAudioEl.onerror = null;
				this._activeVoiceAudioEl.pause();
				this._activeVoiceAudioEl.currentTime = 0;
			} catch { }
			this._activeVoiceAudioEl = null;
		}
		if (this._activeVoiceBlobUrl) {
			try {
				URL.revokeObjectURL(this._activeVoiceBlobUrl);
			} catch { }
			this._activeVoiceBlobUrl = null;
		}
		if (prevNodeId) {
			this._updateNodeVoiceSpeakerVisuals(prevNodeId);
		}
	}

	private _updateNodeVoiceSpeakerVisuals(nodeId: string): void {
		const nodeDom = this._getNodeDom(nodeId);
		if (!nodeDom) {
			return;
		}
		const speaker = nodeDom.speaker;
		if (!speaker) {
			return;
		}
		const speakerBtn = speaker.btn;
		const isPlayingThis = this._activeVoicePlayNodeId === nodeId;
		speakerBtn.classList.toggle('playing', isPlayingThis);
		const iconEl = speaker.icon;
		if (iconEl) {
			iconEl.className = 'codicon codicon-unmute';
		}
		const badgeEl = speaker.countBadge;
		const totalClips = Number(speakerBtn.getAttribute('data-clip-count') || '0');
		if (badgeEl) {
			if (isPlayingThis && this._activeVoiceClipTotal > 0) {
				badgeEl.textContent = `${this._activeVoiceClipIndex + 1}/${this._activeVoiceClipTotal}`;
				badgeEl.style.display = 'inline';
			} else if (totalClips > 1) {
				badgeEl.textContent = String(totalClips);
				badgeEl.style.display = 'inline';
			} else {
				badgeEl.textContent = '';
				badgeEl.style.display = 'none';
			}
		}
	}

	private _toggleNodeVoicePlayback(node: IFlowchartNode): void {
		const voiceState = this._getNodeVoiceNoteState(node);
		if (this._activeVoicePlayNodeId === node.id) {
			this._stopNodeVoicePlayback();
			return;
		}
		if (voiceState.clips.length === 0) {
			this._openNodeComponentsInSideEditor(node, voiceState.firstVoiceNoteCompId);
			return;
		}
		this._stopNodeVoicePlayback();
		this._activeVoicePlayNodeId = node.id;
		this._activeVoiceClipTotal = voiceState.clips.length;

		const playAtIndex = (idx: number) => {
			if (this._activeVoicePlayNodeId !== node.id || idx >= voiceState.clips.length) {
				this._stopNodeVoicePlayback();
				return;
			}
			this._activeVoiceClipIndex = idx;
			this._updateNodeVoiceSpeakerVisuals(node.id);
			const entry = voiceState.clips[idx];
			if (this._activeVoiceBlobUrl) {
				try {
					URL.revokeObjectURL(this._activeVoiceBlobUrl);
				} catch { }
				this._activeVoiceBlobUrl = null;
			}
			let audioSrc = entry.clip.audioDataUrl;
			try {
				audioSrc = this._voiceDataUrlToBlobUrl(entry.clip.audioDataUrl, entry.clip.mimeType);
				if (audioSrc.startsWith('blob:')) {
					this._activeVoiceBlobUrl = audioSrc;
				}
			} catch { }
			const audio = new Audio(audioSrc);
			audio.playbackRate = entry.playbackRate;
			this._activeVoiceAudioEl = audio;
			audio.onended = () => {
				if (this._activeVoicePlayNodeId === node.id) {
					playAtIndex(idx + 1);
				}
			};
			audio.onerror = () => {
				if (this._activeVoicePlayNodeId === node.id) {
					this._notificationService.warn(`Failed to play voice clip #${idx + 1}, skipping...`);
					playAtIndex(idx + 1);
				}
			};
			void audio.play().catch(err => {
				this._notificationService.error(`Voice playback error: ${err?.message || err}`);
				this._stopNodeVoicePlayback();
			});
		};

		playAtIndex(0);
	}

	private _clientToCanvasCoords(clientX: number, clientY: number): { x: number; y: number } | undefined {
		if (!this._canvas) {
			return undefined;
		}
		const rect = this._canvas.getBoundingClientRect();
		const zoom = this._zoomLevel || 1;
		return {
			x: Math.max(0, Math.round((clientX - rect.left) / zoom)),
			y: Math.max(0, Math.round((clientY - rect.top) / zoom))
		};
	}

	/**
	 * Encapsulates the selected nodes as a Sub-Workflow, as an "extract" refactor (CI-23): creates a `sub_workflow`
	 * ticket inside the workflow folder (normal ticket numbering, e.g. FINDJ-0042) holding the selected nodes and their
	 * internal links, then replaces them on this canvas with ONE node whose Call Sub-Workflow step references the new
	 * ticket ID (inputs bound to same-named variables). Links crossing the selection border are rewired to that node.
	 * The parent canvas is only changed after the ticket exists.
	 */
	private async _encapsulateNodesAsSubWorkflow(nodeIds: string[], rawName: string): Promise<ISubWorkflowDefinition | undefined> {
		const cleanName = rawName.trim();
		if (!cleanName) {
			this._notificationService.warn('Please enter a name for the Sub-Workflow.');
			return undefined;
		}
		const curUri = this._workflowUri?.toString() || '';
		if (!curUri) {
			this._notificationService.warn('Save the workflow first: a Sub-Workflow is stored as a ticket inside the workflow folder.');
			return undefined;
		}
		const newId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
		const callNodeId = newId('node');
		const placeholder = (frame: { x: number; y: number; width: number; height: number }): IFlowchartNode => ({ id: callNodeId, type: 'round-rect', ...frame, label: cleanName });
		const plan = extractSubWorkflowFromCanvas<IFlowchartNode, IFlowchartLink>(this._data.nodes || [], this._data.links || [], nodeIds, placeholder);
		if (plan.error !== undefined) {
			this._notificationService.warn(plan.error);
			return undefined;
		}
		const contract = this._workflowExecutionService.resolveWorkflowIOContract({ nodes: plan.subNodes, links: plan.subLinks });

		// On a Sub-Workflow's own canvas, the new ticket goes next to it (inside the same workflow folder)
		const sourceUri = this._subWorkflowTicket?.sourceWorkflowUri || curUri;
		const now = Date.now();
		const draft: ISubWorkflowDefinition = {
			id: '',
			name: cleanName,
			namespace: sanitizePythonVarName(cleanName) || `subwf_${now}`,
			sourceWorkflowUri: sourceUri,
			sourceWorkflowName: this._subWorkflowTicket ? undefined : (this.input?.getName() || 'Workflow'),
			nodeIds: plan.subNodes.map(n => n.id),
			nodes: JSON.parse(JSON.stringify(plan.subNodes)),
			links: JSON.parse(JSON.stringify(plan.subLinks)),
			inputs: contract.inputs,
			outputs: contract.outputs,
			createdAt: now,
			updatedAt: now
		};
		if (!draft.sourceWorkflowName) {
			delete draft.sourceWorkflowName;
		}

		let def: ISubWorkflowDefinition;
		try {
			def = await this._workflowExecutionService.createSubWorkflowTicket(draft);
		} catch (err) {
			this._notificationService.error(`Could not create the Sub-Workflow ticket for '${cleanName}': ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}

		// The canvas may have changed while the ticket was created: rewrite the current data, and only when every
		// extracted node is still there (otherwise the parent is left as is and the user is told)
		const currentIds = new Set((this._data.nodes || []).map(n => n.id));
		if (draft.nodeIds.some(id => !currentIds.has(id))) {
			this._notificationService.warn(`Sub-Workflow ticket ${def.id} '${cleanName}' was created, but the selected nodes changed meanwhile, so they were not replaced on this canvas. Add a Call Sub-Workflow step for ${def.id} where needed.`);
			return def;
		}
		const result = extractSubWorkflowFromCanvas<IFlowchartNode, IFlowchartLink>(this._data.nodes || [], this._data.links || [], draft.nodeIds, placeholder);
		if (result.error !== undefined) {
			this._notificationService.warn(`Sub-Workflow ticket ${def.id} was created, but this canvas could not be updated: ${result.error}`);
			return def;
		}
		const remainingNodes = result.parentNodes.filter(n => n.id !== callNodeId);
		const bindings = buildExtractInputBindings(def.inputs || [], collectCanvasVariableNames(remainingNodes));
		const callNode = buildSubWorkflowCallNode({
			nodeId: callNodeId,
			stepId: newId('step'),
			componentId: newId('comp'),
			frame: { x: result.callNode.x, y: result.callNode.y, width: result.callNode.width, height: result.callNode.height },
			subWorkflow: { id: def.id, name: def.name, sourceWorkflowUri: def.sourceWorkflowUri, inputs: def.inputs || [], outputs: def.outputs || [] },
			inputBindings: bindings
		}) as IFlowchartNode;
		for (const step of callNode.pipeline || []) {
			this._syncComponentStepMetadata(step);
		}
		this._ensureNodeFitsPipeline(callNode);
		this._data.nodes = result.parentNodes.map(n => n.id === callNodeId ? callNode : n);
		this._data.links = result.parentLinks;
		this._selectedNodeIds.clear();
		this._selectedNodeIds.add(callNodeId);
		this._selectedLinkIds.clear();
		await this._saveFlowchartData(false, true);
		this._renderNodes();
		this._drawLinks();
		if (this._inspectorEl) {
			this._renderInspector(this._inspectorEl);
		}

		const notes = [...result.warnings];
		const leaked = findVariablesUsedOutsideSelection(plan.subNodes, remainingNodes);
		if (leaked.length > 0) {
			notes.push(`Other nodes still use ${leaked.map(v => `'${v}'`).join(', ')}, set inside the extracted nodes: read them from the call step result '${callNode.pipeline?.[0]?.component?.outputVariableName || def.name}' instead.`);
		}
		const unbound = Object.entries(bindings).filter(([, v]) => !v).map(([k]) => k);
		if (unbound.length > 0) {
			notes.push(`Input(s) ${unbound.join(', ')} use their default value (no variable of the same name on this canvas).`);
		}
		this._notificationService.info(`Extracted ${draft.nodeIds.length} node(s) into Sub-Workflow ticket ${def.id} '${cleanName}' (${def.inputs.length} input(s), ${def.outputs.length} output(s)); one node calling it replaces them here.${notes.length > 0 ? ` ${notes.join(' ')}` : ''}`);
		return def;
	}

	private _addSubWorkflowCapsuleToNode(node: IFlowchartNode, subDef: ISubWorkflowDefinition, insertIndex?: number): void {
		if (!node.pipeline) {
			node.pipeline = [];
		}
		const existingLabels = new Set((node.pipeline || []).map(s => s.component?.label || s.targetVariable).filter(Boolean));
		let finalLabel = subDef.name;
		let counter = 2;
		while (existingLabels.has(finalLabel)) {
			finalLabel = `${subDef.name} ${counter++}`;
		}
		const initInputs: Record<string, string> = {};
		for (const inp of (subDef.inputs || [])) {
			initInputs[inp.name] = inp.defaultValue ?? '';
		}
		const ts = Date.now();
		const newComp: ICustomField = {
			id: `comp_${ts}_${Math.random().toString(36).substring(2, 6)}`,
			label: finalLabel,
			type: 'sub_workflow',
			required: false,
			outputVariableName: generateSmartPythonVarName(finalLabel, 'sub_workflow'),
			subWorkflowId: subDef.id,
			subWorkflowName: subDef.name,
			subWorkflowSourceUri: subDef.sourceWorkflowUri,
			subWorkflowInputs: initInputs,
			subWorkflowInputDefs: (subDef.inputs || []).map(i => ({ name: i.name, label: i.label, defaultValue: i.defaultValue })),
			subWorkflowOutputDefs: (subDef.outputs || []).map(o => ({ label: o.label, varName: o.varName, defaultFormat: o.defaultFormat }))
		};
		const newStep: INodePipelineStep = {
			id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
			type: 'component',
			label: finalLabel,
			component: newComp
		};
		this._syncComponentStepMetadata(newStep);
		if (typeof insertIndex === 'number' && insertIndex >= 0 && insertIndex <= node.pipeline.length) {
			node.pipeline.splice(insertIndex, 0, newStep);
		} else {
			node.pipeline.push(newStep);
		}
		this._ensureNodeFitsPipeline(node);
		this._syncToNode(node, true);
		this._selectedNodeIds.clear();
		this._selectedNodeIds.add(node.id);
		this._saveFlowchartData();
		this._renderNodes();
		this._drawLinks();
		if (this._inspectorEl) {
			this._renderInspector(this._inspectorEl);
		}
		this._openNodeComponentsInSideEditor(node, newComp.id);
	}

	private _renderSubWorkflowDropdown(): void {
		if (!this._subWorkflowWidgetEl) {
			return;
		}
		clearNode(this._subWorkflowWidgetEl);
		this._outlineOverscrollDisposables.clear();
		this._outlineOverscrollLists = [];
		const curUri = this._libraryHomeUri();
		const ownId = this._subWorkflowTicket?.id;
		const callable = this._workflowExecutionService.getSubWorkflows().filter(sw => sw.id !== ownId);
		const allSubs = curUri ? callable.filter(sw => sw.sourceWorkflowUri === curUri) : [];
		// Sub-Workflow tickets of other workflows: callable from here too (by ticket ID)
		const otherSubs = curUri ? callable.filter(sw => sw.sourceWorkflowUri !== curUri) : [];

		const triggerBtn = append(this._subWorkflowWidgetEl, $(`button.wf-subworkflow-trigger-btn${this._isSubWorkflowDropdownOpen ? '.is-open' : ''}`, {
			type: 'button',
			title: `Workflow Outline — nodes, capsules, Sub-Workflows (${allSubs.length}) and tickets`
		})) as HTMLButtonElement;
		append(triggerBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.layers)));

		triggerBtn.onmousedown = (e) => e.stopPropagation();
		triggerBtn.onclick = (e) => {
			e.stopPropagation();
			this._isSubWorkflowDropdownOpen = !this._isSubWorkflowDropdownOpen;
			if (!this._isSubWorkflowDropdownOpen) {
				this._showEncapsulateForm = false;
			} else {
				this._outlineAsyncChildren.clear(); // reload ticket templates each time the outline is opened
			}
			this._renderSubWorkflowDropdown();
		};

		if (!this._isSubWorkflowDropdownOpen) {
			this._clearOutlineLocate(); // closing the outline ends the highlight it started
			return;
		}

		this._outlineBulbRefreshers = [];
		const panel = append(this._subWorkflowWidgetEl, $('.wf-subworkflow-dropdown-panel.wf-outline-panel'));
		this._outlinePanelEl = panel;
		panel.onmousedown = (e) => e.stopPropagation();
		panel.onclick = (e) => e.stopPropagation();
		panel.onwheel = (e) => e.stopPropagation(); // scroll the menu, not the canvas
		// Clicking a blank area of the panel puts every list pulled past its native range back in place
		this._outlineOverscrollDisposables.add(addDisposableListener(panel, 'click', (e: MouseEvent) => {
			if (isOutlineBlankClickTarget(e.target, panel)) {
				this._resetOutlineOverscroll();
			}
		}));

		const header = append(panel, $('.wf-outline-header'));
		append(header, $('span' + ThemeIcon.asCSSSelector(Codicon.layers)));
		append(header, $('span', {}, 'Workflow Outline'));

		// Encapsulate Selection Bar
		const encapBar = append(panel, $('.wf-subworkflow-encap-bar'));
		if (this._showEncapsulateForm) {
			const nameInput = append(encapBar, $('input.wf-subworkflow-name-input', {
				type: 'text',
				placeholder: `Sub-Workflow name (${this._selectedNodeIds.size} node(s))...`
			})) as HTMLInputElement;
			const confirmBtn = append(encapBar, $('button.wf-subworkflow-encap-confirm', { type: 'button' }, 'Save')) as HTMLButtonElement;
			const cancelBtn = append(encapBar, $('button.wf-subworkflow-encap-cancel', { type: 'button', title: 'Cancel' }));
			append(cancelBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));

			confirmBtn.disabled = this._isEncapsulating;
			const doSave = async () => {
				if (this._isEncapsulating) {
					return;
				}
				const ids = Array.from(this._selectedNodeIds);
				this._isEncapsulating = true;
				confirmBtn.disabled = true;
				confirmBtn.textContent = 'Creating...';
				let created: ISubWorkflowDefinition | undefined;
				try {
					created = await this._encapsulateNodesAsSubWorkflow(ids, nameInput.value);
				} finally {
					this._isEncapsulating = false;
				}
				if (created) {
					this._showEncapsulateForm = false;
				}
				this._renderSubWorkflowDropdown();
			};
			confirmBtn.onclick = () => void doSave();
			cancelBtn.onclick = () => {
				this._showEncapsulateForm = false;
				this._renderSubWorkflowDropdown();
			};
			nameInput.onkeydown = (e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					void doSave();
				} else if (e.key === 'Escape') {
					e.preventDefault();
					this._showEncapsulateForm = false;
					this._renderSubWorkflowDropdown();
				}
			};
			setTimeout(() => nameInput.focus(), 0);
		} else {
			const startEncapBtn = append(encapBar, $('button.wf-subworkflow-encap-btn', {
				type: 'button',
				title: 'Encapsulate currently selected nodes into a reusable Sub-Workflow'
			})) as HTMLButtonElement;
			append(startEncapBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.add)));
			append(startEncapBtn, $('span', {}, this._selectedNodeIds.size > 0 ? `Encapsulate Selected (${this._selectedNodeIds.size})` : 'Encapsulate Selected Nodes'));
			startEncapBtn.onclick = () => {
				if (this._selectedNodeIds.size === 0) {
					this._notificationService.info('Select one or more nodes on the canvas first, then click Encapsulate.');
					return;
				}
				this._showEncapsulateForm = true;
				this._renderSubWorkflowDropdown();
			};
		}

		// Sub-Workflow library (insert / drag into nodes, show / hide its own canvas, delete): collapsed and compact
		const libToggle = append(panel, $(`button.wf-outline-section-toggle${this._outlineLibraryOpen ? '.is-open' : ''}`, {
			type: 'button',
			title: 'Sub-Workflow tickets (type sub_workflow): click a name to show / hide its own canvas (to view and edit it); drag it onto a node (or select a node and press +) to call it by its ticket ID'
		})) as HTMLButtonElement;
		append(libToggle, $('span' + ThemeIcon.asCSSSelector(this._outlineLibraryOpen ? Codicon.chevronDown : Codicon.chevronRight)));
		append(libToggle, $('span' + ThemeIcon.asCSSSelector(Codicon.layers)));
		append(libToggle, $('span', {}, `Sub-Workflow Library (${allSubs.length}${otherSubs.length > 0 ? ` + ${otherSubs.length} from other workflows` : ''})`));
		libToggle.onclick = () => {
			this._outlineLibraryOpen = !this._outlineLibraryOpen;
			this._renderSubWorkflowDropdown();
		};
		if (this._outlineLibraryOpen) {
			const listEl = append(panel, $('.wf-subworkflow-list.is-compact'));
			const listContentEl = append(listEl, $('.wf-outline-list-content'));
			if (allSubs.length === 0) {
				append(listContentEl, $('.wf-subworkflow-empty', {}, 'No Sub-Workflows in this workflow yet. Select nodes on canvas and encapsulate them here.'));
			} else {
				this._renderSubWorkflowLibraryItems(listContentEl, allSubs, curUri);
			}
			if (otherSubs.length > 0) {
				append(listContentEl, $('.wf-outline-section-label', {}, 'From other workflows'));
				this._renderSubWorkflowLibraryItems(listContentEl, otherSubs, curUri);
			}
			this._addOutlineOverscroll('library', listEl, listContentEl);
		}

		this._renderWorkflowOutline(panel);
	}

	private _renderSubWorkflowLibraryItems(listEl: HTMLElement, allSubs: ISubWorkflowDefinition[], curUri: string): void {
		for (const sw of allSubs) {
			const isFromCurrentCanvas = Boolean(curUri && sw.sourceWorkflowUri === curUri);
			const isTicket = Boolean(sw.ticketFolderUri);
			const row = append(listEl, $('.wf-subworkflow-item'));
			row.setAttribute('draggable', 'true');
			row.ondragstart = (e: DragEvent) => {
				e.dataTransfer?.setData('text/plain', JSON.stringify({ kind: 'sub_workflow_ref', subWorkflowId: sw.id }));
				if (e.dataTransfer) {
					e.dataTransfer.effectAllowed = 'copy';
				}
			};

			const swItem = this._outlineSubWorkflowItem(sw.id, sw.name, 'library', new Set<string>(), '');

			// Label: click only shows / hides it (never changes the canvas). Adding it to a node is explicit: drag it onto
			// a node, or select one node and press "+".
			const idText = isTicket ? `Ticket ${sw.id}` : `Legacy ${sw.id} (not migrated to a ticket yet)`;
			const sourceText = isFromCurrentCanvas ? '' : ` · from ${sw.sourceWorkflowName || 'another workflow'}`;
			const infoWrap = append(row, $('.wf-subworkflow-info'));
			infoWrap.title = `Click to show / hide the canvas of '${sw.name}' below this one (view and edit it there). To use it, drag it onto a node, or select a node and press +\n${idText}${sourceText}\n${sw.inputs.length} input(s) · ${sw.outputs.length} output(s)`;
			append(infoWrap, $('.wf-subworkflow-name', {}, sw.name));
			append(infoWrap, $('.wf-subworkflow-meta', {}, `${isTicket ? sw.id : 'legacy'} · ${sw.inputs.length} in · ${sw.outputs.length} out${sourceText}`));
			infoWrap.onclick = (e) => {
				e.stopPropagation();
				this._toggleOutlineItem(swItem);
			};

			const selectedNode = this._selectedNodeIds.size === 1 ? this._data.nodes.find(n => n.id === Array.from(this._selectedNodeIds)[0]) : undefined;
			const addBtn = append(row, $(`button.wf-subworkflow-add-btn${selectedNode ? '' : '.is-disabled'}`, {
				type: 'button',
				title: selectedNode ? `Add '${sw.name}' (${sw.id}) as a capsule to the selected node '${selectedNode.label || selectedNode.id}'` : 'Select exactly one node on the canvas first (or drag this Sub-Workflow onto a node)'
			})) as HTMLButtonElement;
			append(addBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.add)));
			addBtn.onclick = (e) => {
				e.stopPropagation();
				const target = this._selectedNodeIds.size === 1 ? this._data.nodes.find(n => n.id === Array.from(this._selectedNodeIds)[0]) : undefined;
				if (!target) {
					this._notificationService.info('Select one node on the canvas first, or drag the Sub-Workflow onto a node.');
					return;
				}
				this._addSubWorkflowCapsuleToNode(target, sw);
				this._renderSubWorkflowDropdown();
			};

			// Delete: only for the Sub-Workflows of this workflow; a ticket needs a second click (its folder goes to the trash)
			if (!isFromCurrentCanvas) {
				continue;
			}
			const isConfirming = this._pendingSubWorkflowDeleteId === sw.id;
			const delBtn = append(row, $(`button.wf-subworkflow-del-btn${isConfirming ? '.is-confirming' : ''}`, {
				type: 'button',
				title: isConfirming
					? `Click again to delete Sub-Workflow ticket ${sw.id} '${sw.name}' (its folder is moved to the trash)`
					: (isTicket ? `Delete Sub-Workflow ticket ${sw.id} '${sw.name}'` : `Remove Sub-Workflow '${sw.name}' from library`)
			})) as HTMLButtonElement;
			append(delBtn, $('span' + ThemeIcon.asCSSSelector(isConfirming ? Codicon.trash : Codicon.close)));
			delBtn.onclick = (e) => {
				e.stopPropagation();
				if (isTicket && !isConfirming) {
					this._pendingSubWorkflowDeleteId = sw.id;
					this._renderSubWorkflowDropdown();
					return;
				}
				this._pendingSubWorkflowDeleteId = undefined;
				this._workflowExecutionService.deleteSubWorkflow(sw.id);
			};
		}
	}

	// ---------------------------------------------------------------------------------------------
	// Workflow Outline: cascading menu node → capsule → (Sub-Workflow nodes | ticket components), lightbulb opens to the right
	// ---------------------------------------------------------------------------------------------

	private _renderWorkflowOutline(panel: HTMLElement): void {
		const ownDef = this._subWorkflowTicket ? this._workflowExecutionService.getSubWorkflowById(this._subWorkflowTicket.id) : undefined;
		const scopeText = this._subWorkflowTicket ? `Nodes of Sub-Workflow '${ownDef?.name || this._subWorkflowTicket.id}'` : 'Nodes on canvas';
		append(panel, $('.wf-outline-section-label', {}, `${scopeText} · click: locate on the flowchart, show details, expand`));

		const columnsEl = append(panel, $('.wf-outline-columns'));

		type Column = { items: IWfOutlineItem[]; state?: 'loading' | 'error' | 'empty' };
		const columns: Column[] = [{ items: this._buildOutlineRootItems() }];
		this._outlineRenderedColumns = [];
		const validPath: string[] = [];
		for (let level = 0; level < this._outlinePath.length; level++) {
			const selected = columns[level].items.find(it => it.key === this._outlinePath[level]);
			if (!selected || !selected.children) {
				break;
			}
			validPath.push(selected.key);
			const resolved = this._resolveOutlineChildren(selected);
			if (resolved === 'loading' || resolved === 'error') {
				columns.push({ items: [], state: resolved });
				break;
			}
			columns.push(resolved.length ? { items: resolved } : { items: [], state: 'empty' });
		}
		this._outlinePath = validPath;

		// Keep scroll positions across re-renders (the outline re-renders whenever an editor opens or closes)
		columnsEl.onscroll = () => {
			if (columnsEl.isConnected) {
				this._outlineScroll.left = columnsEl.scrollLeft;
			}
		};
		const columnEls: HTMLElement[] = [];
		const outlineRows: HTMLElement[] = [];
		columns.forEach((column, level) => {
			const colEl = append(columnsEl, $('.wf-outline-column'));
			columnEls.push(colEl);
			// Rows go into one content element, translated when the wheel pulls the level past its native range (UI-07).
			// The key includes the expanded path above this level: another branch starts without a forced offset.
			const listEl = append(colEl, $('.wf-outline-list-content'));
			this._addOutlineOverscroll(`col:${level}:${validPath.slice(0, level).join('\u0000')}`, colEl, listEl);
			colEl.onscroll = () => {
				if (colEl.isConnected) {
					this._outlineScroll.tops[level] = colEl.scrollTop;
				}
			};
			this._outlineRenderedColumns[level] = column.items;
			if (column.state === 'loading') {
				append(listEl, $('.wf-outline-empty', {}, 'Loading…'));
				return;
			}
			if (column.state === 'error') {
				append(listEl, $('.wf-outline-empty', {}, 'Could not load the ticket template.'));
				return;
			}
			if (column.state === 'empty' || column.items.length === 0) {
				append(listEl, $('.wf-outline-empty', {}, level === 0 ? 'No nodes on this canvas yet.' : 'Nothing inside.'));
				return;
			}
			for (const item of column.items) {
				this._renderOutlineItem(listEl, item, level, columnsEl, outlineRows);
			}
		});

		this._outlineScroll.tops.length = columns.length;
		// Restore scroll right away (the panel is already in the DOM). Never read or write the saved positions through a
		// panel that a newer render has already replaced: a detached element reports scroll 0 and would reset the menu.
		const restoreScroll = () => {
			if (!columnsEl.isConnected) {
				return;
			}
			columnEls.forEach((el, level) => { el.scrollTop = this._outlineScroll.tops[level] || 0; });
			// Whenever the expanded path changes, reveal the deepest level (the panel stays narrow; scroll back for earlier levels)
			const pathKey = this._outlinePath.join('\u0000');
			columnsEl.scrollLeft = pathKey !== this._outlineLastRenderedPath ? columnsEl.scrollWidth : this._outlineScroll.left;
			this._outlineLastRenderedPath = pathKey;
			this._outlineScroll.left = columnsEl.scrollLeft;
			// Forced offsets stay where the user left them, re-clamped to the new limits (rows expanded / collapsed)
			const previousExtras = this._outlineOverscrollExtras;
			this._outlineOverscrollExtras = new Map();
			for (const list of this._outlineOverscrollLists) {
				list.restore(previousExtras.get(list.key) ?? 0);
			}
		};
		if (columnsEl.isConnected) {
			restoreScroll();
		} else {
			setTimeout(restoreScroll, 0);
		}
	}

	private _addOutlineOverscroll(key: string, scrollEl: HTMLElement, contentEl: HTMLElement): void {
		const list = this._outlineOverscrollDisposables.add(new OutlineListOverscroll(key, scrollEl, contentEl, (k, extra) => {
			if (extra !== 0) {
				this._outlineOverscrollExtras.set(k, extra);
			} else {
				this._outlineOverscrollExtras.delete(k);
			}
		}));
		this._outlineOverscrollLists.push(list);
	}

	private _resetOutlineOverscroll(): void {
		for (const list of this._outlineOverscrollLists) {
			list.reset();
		}
		this._outlineOverscrollExtras.clear();
	}

	/**
	 * @param columnsEl the `.wf-outline-columns` element the column belongs to
	 * @param outlineRows all `.wf-outline-item` rows rendered into `columnsEl` (this row is added)
	 */
	private _renderOutlineItem(colEl: HTMLElement, item: IWfOutlineItem, level: number, columnsEl: HTMLElement, outlineRows: HTMLElement[]): void {
		const isExpanded = this._outlinePath[level] === item.key;
		// The clicked item and every level above it (its expanded ancestors) stay outlined
		const isOnPath = isExpanded || this._outlineSelectedKey === item.key;
		const row = append(colEl, $(`.wf-outline-item${isExpanded ? '.is-expanded' : ''}${isOnPath ? '.is-on-path' : ''}${item.disabled ? '.is-disabled' : ''}`));
		outlineRows.push(row);
		row.title = item.meta ? `${item.label}\n${item.meta}` : item.label;

		row.style.background = item.theme.bg;
		row.style.borderColor = item.theme.border;
		if (item.shape) {
			// Node: a small outline of its shape (rounded rectangle, rectangle, diamond, circle)
			const shapeWrap = append(row, $('span.wf-outline-shape'));
			append(shapeWrap, $(`span.wf-outline-shape-glyph.shape-${item.shape}`)).style.borderColor = item.theme.color;
		} else {
			// Same small icon as the node capsules on the canvas
			const iconEl = append(row, $('span.fn-tag-icon.wf-outline-icon' + ThemeIcon.asCSSSelector(item.icon)));
			iconEl.style.color = item.theme.color;
			if (item.icon === Codicon.python) {
				iconEl.classList.add('is-python');
			}
		}
		const textWrap = append(row, $('.wf-outline-text'));
		const labelEl = append(textWrap, $('.wf-outline-label', {}, item.label));
		labelEl.style.color = item.theme.textColor;
		if (item.meta) {
			const metaEl = append(textWrap, $('.wf-outline-meta', {}, item.meta));
			metaEl.style.color = item.theme.color;
		}
		if (item.children) {
			append(row, $('span.wf-outline-chevron' + ThemeIcon.asCSSSelector(Codicon.chevronRight)));
		}

		row.onclick = (e) => {
			e.stopPropagation();
			// Every item: 1) highlight it on the flowchart, 2) show its content on the right, 3) expand its next level
			this._outlineSelectedKey = item.key;
			if (!item.children) {
				if (this._outlinePath.length > level) {
					// A sibling branch was open deeper: close it, so only this item's real path stays outlined
					this._outlinePath = this._outlinePath.slice(0, level);
					this._renderSubWorkflowDropdown();
				} else {
					// No re-render follows: move the outline in place (ancestors are already outlined)
					if (columnsEl.contains(colEl)) {
						for (const el of outlineRows) {
							if (el.classList.contains('is-on-path') && !el.classList.contains('is-expanded')) {
								el.classList.remove('is-on-path');
							}
						}
					}
					row.classList.add('is-on-path');
				}
			}
			this._locateOutlineItemWithAncestors(item, level);
			item.onActivate?.();
			if (item.open) {
				this._toggleOutlineItem(item, true); // show / reveal (only the lightbulb hides)
			}
			if (item.children) {
				this._outlinePath = isExpanded ? this._outlinePath.slice(0, level) : [...this._outlinePath.slice(0, level), item.key];
				this._renderSubWorkflowDropdown();
			}
		};
	}

	private _isOutlineItemShown(item: IWfOutlineItem): boolean {
		if (item.isShown) {
			return item.isShown();
		}
		const input = this._outlineShownInputs.get(item.showKey || item.key);
		return !!input && !input.isDisposed() && this._editorGroupService.groups.some(g => g.contains(input));
	}

	private _refreshOutlineBulbs(): void {
		for (const refresh of this._outlineBulbRefreshers) {
			refresh();
		}
	}

	/** Lightbulb: show ↔ hide. With `showOnly` (clicking a leaf row) it always shows / re-reveals, never hides. */
	private _toggleOutlineItem(item: IWfOutlineItem, showOnly = false): void {
		if (!item.open) {
			this._notificationService.info(`'${item.label}' has nothing to show.`);
			return;
		}
		const run = async () => {
			if (!showOnly && this._isOutlineItemShown(item)) {
				if (item.hide) {
					await item.hide();
				} else {
					const input = this._outlineShownInputs.get(item.showKey || item.key);
					if (input) {
						await this._closeEditorsWhere(e => e === input);
					}
				}
				this._outlineShownInputs.delete(item.showKey || item.key);
			} else {
				const opened = await item.open!();
				if (opened instanceof EditorInput) {
					this._outlineShownInputs.set(item.showKey || item.key, opened);
				}
			}
		};
		run().catch(err => this._notificationService.error(`Could not show '${item.label}': ${err instanceof Error ? err.message : String(err)}`))
			.finally(() => {
				if (this._isSubWorkflowDropdownOpen) {
					this._refreshOutlineBulbs();
				}
			});
	}

	private async _closeEditorsWhere(predicate: (editor: EditorInput) => boolean): Promise<void> {
		for (const group of [...this._editorGroupService.groups]) {
			const matches = group.editors.filter(predicate);
			if (matches.length > 0) {
				await group.closeEditors(matches);
			}
		}
	}

	private _isEditorOpen(predicate: (editor: EditorInput) => boolean): boolean {
		return this._editorGroupService.groups.some(g => g.editors.some(predicate));
	}

	private _resolveOutlineChildren(item: IWfOutlineItem): IWfOutlineItem[] | 'loading' | 'error' {
		const cached = this._outlineAsyncChildren.get(item.key);
		if (cached) {
			return cached;
		}
		const result = item.children ? item.children() : [];
		if (Array.isArray(result)) {
			return result;
		}
		this._outlineAsyncChildren.set(item.key, 'loading');
		result.then(children => {
			this._outlineAsyncChildren.set(item.key, children);
		}, err => {
			console.error('[WorkflowOutline] Failed to load children:', err);
			this._outlineAsyncChildren.set(item.key, 'error');
		}).finally(() => {
			if (this._isSubWorkflowDropdownOpen) {
				this._renderSubWorkflowDropdown();
			}
		});
		return 'loading';
	}

	/** Editor group to the right of this workflow (an existing other group, else a new side group). */
	private _outlineSideGroup(): number | typeof SIDE_GROUP {
		const right = this._editorGroupService.findGroup({ direction: GroupDirection.RIGHT }, this.group);
		if (right) {
			return right.id;
		}
		const other = this._editorGroupService.groups.find(g => g.id !== this.group.id && !this._outlineFlowGroupIds.includes(g.id));
		if (other) {
			return other.id;
		}
		// New side panel: narrower than half — the flowchart stays the main area, the right side is reference only
		const side = this._editorGroupService.addGroup(this.group, GroupDirection.RIGHT);
		try {
			const total = this._editorGroupService.getSize(this.group).width + this._editorGroupService.getSize(side).width;
			if (total > 0) {
				this._editorGroupService.setSize(side, { width: Math.round(total * WorkflowEditor.OUTLINE_SIDE_PANEL_RATIO), height: this._editorGroupService.getSize(side).height });
			}
		} catch {
			// keep the default split
		}
		return side.id;
	}

	/** Flowcharts stack top-to-bottom below the canvas: each new one splits the lowest flow split opened from here. */
	private _outlineNewFlowGroup(): number {
		this._outlineFlowGroupIds = this._outlineFlowGroupIds.filter(id => !!this._editorGroupService.getGroup(id));
		const lastId = this._outlineFlowGroupIds[this._outlineFlowGroupIds.length - 1];
		const reference = (lastId !== undefined ? this._editorGroupService.getGroup(lastId) : undefined) || this.group;
		const newGroup = this._editorGroupService.addGroup(reference, GroupDirection.DOWN);
		this._outlineFlowGroupIds.push(newGroup.id);
		return newGroup.id;
	}

	/**
	 * The workflow whose Sub-Workflows the library lists first: this workflow, or for a Sub-Workflow's own canvas the
	 * workflow it belongs to (its siblings).
	 */
	private _libraryHomeUri(): string {
		return this._subWorkflowTicket?.sourceWorkflowUri || this._workflowUri?.toString() || '';
	}

	private _outlineSubWorkflowsOfCanvas(): ISubWorkflowDefinition[] {
		const curUri = this._libraryHomeUri();
		const ownId = this._subWorkflowTicket?.id;
		return curUri ? this._workflowExecutionService.getSubWorkflows().filter(sw => sw.sourceWorkflowUri === curUri && sw.id !== ownId) : [];
	}

	private _buildOutlineRootItems(): IWfOutlineItem[] {
		const subs = this._outlineSubWorkflowsOfCanvas();
		const topNodes = [...(this._data?.nodes || [])].sort((a, b) => (a.y - b.y) || (a.x - b.x));
		const items = topNodes.map(n => this._outlineNodeItem(n, 'root', true, new Set<string>(), undefined));

		const calledSubIds = new Set<string>();
		for (const n of this._data?.nodes || []) {
			for (const step of n.pipeline || []) {
				if (step?.component?.type === 'sub_workflow' && step.component.subWorkflowId) {
					calledSubIds.add(step.component.subWorkflowId);
				}
			}
		}
		for (const sw of subs) {
			if (!calledSubIds.has(sw.id)) {
				items.push(this._outlineSubWorkflowItem(sw.id, sw.name, 'root', new Set<string>(), 'Sub-Workflow · not used by any node'));
			}
		}
		return items;
	}

	private _outlineNodeItem(node: IFlowchartNode, parentKey: string, isLive: boolean, visitedSubs: Set<string>, ownerSubWorkflowId: string | undefined): IWfOutlineItem {
		const key = `${parentKey}/n:${node.id}`;
		const steps = (node.pipeline || []).filter((s): s is INodePipelineStep => !!s);
		const liveNode = isLive ? (this._data?.nodes || []).find(n => n.id === node.id) : undefined;
		const shapeName = node.type === 'diamond' ? 'Decision' : node.type === 'circle' ? 'Start / End' : 'Node';
		return {
			key,
			label: (node.label || '').trim() || shapeName,
			meta: steps.length > 0 ? `${shapeName} · ${steps.length} capsule${steps.length === 1 ? '' : 's'}` : shapeName,
			icon: node.type === 'diamond' ? Codicon.gitCompare : node.type === 'circle' ? Codicon.circleLargeOutline : Codicon.symbolClass,
			theme: WF_NODE_OUTLINE_THEME,
			shape: node.type,
			children: steps.length > 0 ? () => steps.map((step, index) => this._outlineStepItem(node, step, key, liveNode, visitedSubs, ownerSubWorkflowId, index)) : undefined,
			locateTarget: { nodeId: node.id, ownerSubWorkflowId },
			...this._outlineNodeEditorShowHide(liveNode, undefined, ownerSubWorkflowId)
		};
	}

	/** Show / hide for a node (form on the right), or for one of its components; nodes not on this canvas show their Sub-Workflow. */
	private _outlineNodeEditorShowHide(liveNode: IFlowchartNode | undefined, focusFieldId: string | undefined, ownerSubWorkflowId: string | undefined): Pick<IWfOutlineItem, 'open' | 'isShown' | 'hide'> {
		if (!liveNode) {
			return ownerSubWorkflowId ? this._outlineSubWorkflowShowHide(ownerSubWorkflowId) : {};
		}
		// A node is shown like a ticket: its capsules as component cards (focusFieldId scrolls to one of them)
		const moduleId = `wf_node_${liveNode.id}`;
		const isNodeTicket = (e: EditorInput) => e instanceof EntityDetailEditorInput && !e.isDisposed() && e.previewModule?.id === moduleId;
		return {
			open: () => this._openNodeVirtualTicket(liveNode, focusFieldId),
			isShown: () => this._isEditorOpen(isNodeTicket),
			hide: () => this._closeEditorsWhere(isNodeTicket)
		};
	}

	private _outlineSubWorkflowShowHide(subWorkflowId: string): Pick<IWfOutlineItem, 'open' | 'isShown' | 'hide'> {
		const isFlowEditor = (e: EditorInput) => {
			const folder = this._workflowExecutionService.getSubWorkflowById(subWorkflowId)?.ticketFolderUri;
			return e instanceof SubWorkflowCanvasEditorInput && !e.isDisposed() && !!folder && e.ticketFolderUri.toString() === folder;
		};
		return {
			open: () => this._openOutlineSubWorkflow(subWorkflowId),
			isShown: () => this._isEditorOpen(isFlowEditor),
			hide: () => this._closeEditorsWhere(isFlowEditor)
		};
	}

	private _outlineStepItem(node: IFlowchartNode, step: INodePipelineStep, parentKey: string, liveNode: IFlowchartNode | undefined, visitedSubs: Set<string>, ownerSubWorkflowId: string | undefined, index: number): IWfOutlineItem {
		const comp = step.component;
		// Must be stable across re-renders (the expanded path is matched by key): fall back to the capsule's position
		const key = `${parentKey}/s:${step.id || comp?.id || `#${index}`}`;
		const pipelineIndex = (node.pipeline || []).indexOf(step);
		const locateTarget: IWfLocateTarget = { nodeId: node.id, stepIndex: pipelineIndex >= 0 ? pipelineIndex : index, ownerSubWorkflowId };
		const cardShow = this._outlineNodeEditorShowHide(liveNode, this._nodeTicketFieldId(step, index), ownerSubWorkflowId);
		const disabled = Boolean(step.disabled || comp?.disabled);
		const firstExprLine = (step.expression || '').split('\n').map(l => l.trim()).find(l => l.length > 0) || '';
		const label = comp ? ((comp.label || '').trim() || this._outlineComponentTypeLabel(comp.type)) : ((step.label || '').trim() || firstExprLine || step.functionName || step.type);
		const baseMeta = comp ? this._outlineComponentTypeLabel(comp.type) : (step.functionName ? `${step.functionName} (Python step)` : step.type);

		// Capsule calling a Sub-Workflow → its nodes
		if (comp?.type === 'sub_workflow' && comp.subWorkflowId) {
			const subId = comp.subWorkflowId;
			const def = this._workflowExecutionService.getSubWorkflowById(subId);
			const subName = comp.subWorkflowName || def?.name || subId;
			const swItem = this._outlineSubWorkflowItem(subId, label || subName, parentKey, visitedSubs, `Call Sub-Workflow · ${subName}${disabled ? ' · disabled' : ''}`, key, disabled);
			// Clicking the capsule: highlight it, show its card (inputs / outputs) on the right, and its flowchart in a split below
			const showFlow = () => {
				this._openOutlineSubWorkflow(subId).catch(err => this._notificationService.error(`Could not show Sub-Workflow '${subName}': ${err instanceof Error ? err.message : String(err)}`));
			};
			return liveNode ? { ...swItem, locateTarget, onActivate: showFlow, ...cardShow, showKey: undefined } : { ...swItem, locateTarget, onActivate: showFlow };
		}

		// Capsule creating / running / reading a ticket → the ticket's (or its template's) components
		const ticketRef = this._outlineTicketRefOfStep(node, step);
		const stepTheme = comp ? this._outlineThemeOf(comp.type) : WF_PYTHON_STEP_CAPSULE_THEME;
		if (ticketRef) {
			const refText = ticketRef.kind === 'id' ? `Ticket ${ticketRef.id}` : `Ticket Type: ${ticketRef.name}`;
			return {
				key,
				label,
				meta: `${baseMeta} · ${refText}${disabled ? ' · disabled' : ''}`,
				icon: stepTheme.icon,
				theme: stepTheme,
				disabled,
				children: () => this._outlineTicketFieldItems(ticketRef, key, locateTarget),
				open: () => this._openOutlineTicket(ticketRef),
				showKey: key,
				locateTarget
			};
		}

		// Every capsule (components and inline Python steps alike) is a card in the node's ticket-like view
		return {
			key,
			label,
			meta: `${baseMeta}${disabled ? ' · disabled' : ''}`,
			icon: stepTheme.icon,
			theme: stepTheme,
			disabled,
			locateTarget,
			...cardShow
		};
	}

	private _outlineSubWorkflowItem(subWorkflowId: string, label: string, parentKey: string, visitedSubs: Set<string>, meta: string, key?: string, disabled?: boolean): IWfOutlineItem {
		const itemKey = key || `${parentKey}/sw:${subWorkflowId}`;
		const isRecursive = visitedSubs.has(subWorkflowId);
		return {
			key: itemKey,
			label,
			meta: isRecursive ? `${meta} · recursive call` : meta,
			icon: Codicon.layers,
			theme: this._outlineThemeOf('sub_workflow'),
			disabled,
			children: isRecursive ? undefined : () => {
				const def = this._workflowExecutionService.getSubWorkflowById(subWorkflowId);
				if (!def) {
					return [];
				}
				const nextVisited = new Set(visitedSubs).add(subWorkflowId);
				// Its own definition (its canvas), never nodes of the canvas it was extracted from
				const nodes: IFlowchartNode[] = subWorkflowSnapshotNodes(def).filter((n): n is IFlowchartNode => !!n);
				return [...nodes]
					.sort((a, b) => (a.y - b.y) || (a.x - b.x))
					.map(n => this._outlineNodeItem(n, itemKey, false, nextVisited, subWorkflowId));
			},
			...this._outlineSubWorkflowShowHide(subWorkflowId)
		};
	}

	private async _openOutlineSubWorkflow(subWorkflowId: string): Promise<EditorInput> {
		// Its own canvas, in a split below this one
		return openSubWorkflowLiveView(this._editorService, this._editorGroupService, this._workflowExecutionService, subWorkflowId, {
			parentWorkflowUri: this._workflowUri?.toString(),
			preserveFocus: true,
			group: () => this._outlineNewFlowGroup()
		});
	}

	/** Which ticket a capsule creates / runs / reads: a fixed ticket id, or a Ticket Type for tickets created at run time. */
	private _outlineTicketRefOfStep(node: IFlowchartNode, step: INodePipelineStep): WfOutlineTicketRef | undefined {
		const isTicketId = (v: string) => /^[A-Za-z][A-Za-z0-9_]{0,15}-\d{1,8}$/.test(v);
		const fromTarget = (rawTarget: string | undefined): WfOutlineTicketRef | undefined => {
			const target = (rawTarget || '').trim().replace(/^["']|["']$/g, '');
			if (!target) {
				return undefined;
			}
			if (isTicketId(target)) {
				return { kind: 'id', id: target };
			}
			const varMatch = /^\{?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}?$/.exec(target);
			const typeName = varMatch ? this._outlineTicketTypeOfVariable(varMatch[1], node) : undefined;
			return typeName ? { kind: 'type', name: typeName } : undefined;
		};

		const comp = step.component;
		if (comp) {
			switch (comp.type) {
				case 'create_tickets':
					return comp.wfTicketType ? { kind: 'type', name: comp.wfTicketType } : undefined;
				case 'run_tickets':
				case 'get_outputs':
				case 'get_ticket':
					return fromTarget(comp.wfTicketTarget) || (comp.wfTicketType ? { kind: 'type', name: comp.wfTicketType } : undefined);
				default:
					return undefined;
			}
		}

		const expr = step.expression || '';
		const createMatch = /\bCREATE_TICKETS?\s*\(([\s\S]*)/i.exec(expr);
		if (createMatch) {
			const typeMatch = /\bticket_type\s*=\s*["']([^"']+)["']/.exec(createMatch[1]);
			return typeMatch ? { kind: 'type', name: typeMatch[1] } : undefined;
		}
		const useMatch = /\b(?:RUN_TICKETS?|GET_OUTPUTS|GET_TICKETS?)\s*\(([\s\S]*)/i.exec(expr);
		if (useMatch) {
			const argMatch = /\bticket(?:_id)?\s*=\s*("[^"]*"|'[^']*'|[A-Za-z_][A-Za-z0-9_]*)/.exec(useMatch[1])
				|| /^\s*("[^"]*"|'[^']*'|[A-Za-z_][A-Za-z0-9_]*)/.exec(useMatch[1]);
			return argMatch ? fromTarget(argMatch[1]) : undefined;
		}
		return undefined;
	}

	/** Ticket Type of a variable holding a ticket created by CREATE_TICKETS (same node first, then the whole canvas). */
	private _outlineTicketTypeOfVariable(varName: string, preferNode: IFlowchartNode): string | undefined {
		const nodes = [preferNode, ...(this._data?.nodes || []).filter(n => n.id !== preferNode.id)];
		const assignRe = new RegExp(`(?:^|\\n)\\s*${varName}\\s*=\\s*CREATE_TICKETS?\\s*\\([\\s\\S]*?\\bticket_type\\s*=\\s*["']([^"']+)["']`, 'i');
		for (const n of nodes) {
			for (const step of n.pipeline || []) {
				const comp = step?.component;
				if (comp?.type === 'create_tickets' && comp.wfTicketType && (comp.outputVariableName === varName || this._getComponentOutputVarName(comp) === varName)) {
					return comp.wfTicketType;
				}
				const m = step?.expression ? assignRe.exec(step.expression) : null;
				if (m) {
					return m[1];
				}
			}
		}
		return undefined;
	}

	private async _outlineTicketFieldItems(ref: WfOutlineTicketRef, parentKey: string, locateTarget?: IWfLocateTarget): Promise<IWfOutlineItem[]> {
		let fields: ICustomField[] | undefined;
		if (ref.kind === 'type') {
			fields = (await this._findTicketTypeModule(ref.name))?.module.fields;
		} else if (this._workflowUri) {
			const ticket = await this._ticketRuntimeService.getTicket(this._workflowUri, ref.id);
			fields = ticket?.schema?.fields;
		}
		if (!fields) {
			throw new Error(ref.kind === 'type' ? `Ticket Type '${ref.name}' not found` : `Ticket '${ref.id}' not found`);
		}
		return fields
			.filter(f => f && f.id !== 'title')
			.map(f => ({
				key: `${parentKey}/f:${f.id}`,
				label: (f.label || f.id || '').trim(),
				meta: `${this._outlineComponentTypeLabel(f.type)}${f.disabled ? ' · disabled' : ''}`,
				icon: this._outlineThemeOf(f.type).icon,
				theme: this._outlineThemeOf(f.type),
				disabled: Boolean(f.disabled),
				open: () => this._openOutlineTicket(ref, f.id),
				showKey: parentKey,
				locateTarget
			}));
	}

	/** Card id of a capsule in the node's ticket-like view (also used to scroll to it). */
	private _nodeTicketFieldId(step: INodePipelineStep, index: number): string {
		return step.component?.id || step.id || `wf_step_${index}`;
	}

	/** A node presented like a ticket: one card per capsule, in pipeline order. Not a real ticket (nothing is saved). */
	private _buildNodeVirtualTicketModule(node: IFlowchartNode): ICustomModule {
		const steps = (node.pipeline || []).filter((s): s is INodePipelineStep => !!s);
		const nodeRunState = this._getEffectiveRunForNode(node.id)?.nodeStates?.[node.id];
		const fields = steps.map((step, index) => {
			const comp = step.component;
			const id = this._nodeTicketFieldId(step, index);
			const pipelineIndex = (node.pipeline || []).indexOf(step);
			const runtime = this._stepRuntimeForNodeView(node, step, pipelineIndex, nodeRunState);
			const firstExprLine = (step.expression || '').split('\n').map(l => l.trim()).find(l => l.length > 0) || '';
			const label = comp ? ((comp.label || '').trim() || this._outlineComponentTypeLabel(comp.type)) : ((step.label || '').trim() || step.functionName || firstExprLine.slice(0, 60) || `Python step ${index + 1}`);
			if (comp && !WF_NODE_TICKET_STEP_CARD_TYPES.has(comp.type)) {
				return { ...comp, id, label, __wfRuntime: runtime };
			}
			const kind = comp?.type || 'python_step';
			return {
				...(comp || {}),
				id,
				label,
				type: kind,
				__wfRuntime: runtime,
				__wfStep: {
					kind,
					kindLabel: comp ? this._outlineComponentTypeLabel(comp.type) : 'Python Step',
					code: comp ? (kind === 'sub_workflow' ? '' : this._buildBuiltinComponentPythonExpression(comp)) : (step.expression || ''),
					targetVariable: (step.targetVariable || '').replace(/^@/, '').trim(),
					disabled: Boolean(step.disabled || comp?.disabled),
					subWorkflow: kind === 'sub_workflow' ? {
						id: comp?.subWorkflowId,
						name: comp?.subWorkflowName || (comp?.subWorkflowId ? this._workflowExecutionService.getSubWorkflowById(comp.subWorkflowId)?.name : undefined) || comp?.subWorkflowId,
						inputs: comp?.subWorkflowInputs || {},
						inputDefs: comp?.subWorkflowInputDefs || [],
						outputDefs: comp?.subWorkflowOutputDefs || []
					} : undefined
				}
			};
		});
		const ownerSub = this._subWorkflowTicket ? this._workflowExecutionService.getSubWorkflowById(this._subWorkflowTicket.id) : undefined;
		const workflowName = this.input?.getName() || decodeURIComponent(this._workflowUri?.path.split('/').filter(Boolean).pop() || 'Workflow');
		const virtualModule = {
			id: `wf_node_${node.id}`,
			name: (node.label || '').trim() || 'Node',
			fields,
			__wfNode: {
				nodeId: node.id,
				nodeLabel: (node.label || '').trim() || 'Node',
				workflowName,
				workflowUri: this._workflowUri?.toString(),
				subWorkflowName: ownerSub?.name
			}
		};
		// Not a real module: it has no `color`, its cards may be of the virtual `python_step` kind and it carries the
		// `__wfNode` / `__wfStep` / `__wfRuntime` extras that EntityDetailEditor reads for node previews.
		return virtualModule as unknown as ICustomModule;
	}

	/** Last-run data of a capsule for the node view: its value, a Sub-Workflow's actual inputs, and the error if it failed. */
	private _stepRuntimeForNodeView(node: IFlowchartNode, step: INodePipelineStep, pipelineIndex: number, nodeRunState: { status?: string; failedStepIndex?: number; failedStepId?: string; failedStepError?: string; error?: string } | undefined): { value?: unknown; inputs?: Record<string, unknown>; error?: string } | undefined {
		const comp = step.component;
		let value: unknown;
		try {
			value = this._resolveStepRuntimeValue(node, step);
		} catch {
			value = undefined;
		}
		let inputs: Record<string, unknown> | undefined;
		if (comp?.type === 'sub_workflow') {
			inputs = wfComponent(comp).lastExecutionInputs;
			const log = wfComponent(comp).lastExecutionLog;
			if (inputs === undefined && typeof log === 'string') {
				const m = log.match(/(?:^|\n)Inputs:\s*(\{[\s\S]*?\})(?:\nOutputs:|$)/);
				try {
					inputs = m?.[1] ? JSON.parse(m[1]) : undefined;
				} catch {
					inputs = undefined;
				}
			}
		}
		const failedHere = nodeRunState?.status === 'failed' && (nodeRunState.failedStepIndex !== undefined ? nodeRunState.failedStepIndex === pipelineIndex : Boolean(nodeRunState.failedStepId && nodeRunState.failedStepId === step.id));
		const error = failedHere ? (nodeRunState?.failedStepError || nodeRunState?.error || 'Step failed during execution.') : undefined;
		return value === undefined && inputs === undefined && !error ? undefined : { value, inputs, error };
	}

	/** Opens (or refreshes) the node's ticket-like view on the right; with `fieldId`, scrolls to that capsule's card. */
	private async _openNodeVirtualTicket(node: IFlowchartNode, fieldId?: string): Promise<EditorInput | undefined> {
		const mod = this._buildNodeVirtualTicketModule(node);
		const existing = this._editorService.editors.find(e => e instanceof EntityDetailEditorInput && !e.isDisposed() && e.previewModule?.id === mod.id) as EntityDetailEditorInput | undefined;
		let input: EntityDetailEditorInput;
		if (existing) {
			existing.updatePreviewModule(mod);
			const existingGroup = this._editorGroupService.groups.find(g => g.contains(existing));
			const pane = await this._editorService.openEditor(existing, { pinned: true, preserveFocus: true }, existingGroup?.id ?? this._outlineSideGroup());
			if (pane instanceof EntityDetailEditor) {
				await pane.refreshPreviewModule(mod);
			}
			input = existing;
		} else {
			input = new EntityDetailEditorInput(this._workflowUri || URI.file('/'), mod.name, false, mod);
			await this._editorService.openEditor(input, { pinned: true, preserveFocus: true }, this._outlineSideGroup());
		}
		if (fieldId) {
			this._revealOutlineField(input, fieldId);
		}
		return input;
	}

	/** Highlights a clicked outline item together with everything above it in the menu (calling node, capsule, …). */
	private _locateOutlineItemWithAncestors(item: IWfOutlineItem, level: number): void {
		const chain: IWfLocateTarget[] = [];
		for (let l = 0; l < level; l++) {
			const ancestor = this._outlineRenderedColumns[l]?.find(it => it.key === this._outlinePath[l]);
			if (ancestor?.locateTarget) {
				chain.push(ancestor.locateTarget);
			}
		}
		if (item.locateTarget) {
			chain.push(item.locateTarget);
		}
		// A capsule target already highlights its node; drop duplicates
		const unique = chain.filter((t, i) => chain.findIndex(o => o.nodeId === t.nodeId && o.stepIndex === t.stepIndex) === i);
		if (unique.length > 0) {
			this._locateOnCanvas(unique);
		}
	}

	/**
	 * Highlights nodes / capsules (outermost first, the clicked item last) on every canvas of this workflow and keeps them
	 * highlighted until another item is picked (or the outline is closed). Opens the clicked node's Sub-Workflow if it is not
	 * visible anywhere.
	 */
	private _locateOnCanvas(targets: IWfLocateTarget[], allowOpen = true): void {
		const uri = this._workflowUri?.toString();
		const deepest = targets[targets.length - 1];
		if (!uri || !deepest) {
			return;
		}
		WorkflowEditor._outlineLocated.set(uri, { targets, owner: this });
		let deepestShown = false;
		for (const ed of WorkflowEditor._openWorkflowEditors) {
			if (!ed._isPureDiagram && ed._workflowUri?.toString() === uri && ed._applyOutlineLocateHighlight(true)) {
				deepestShown = true;
			}
		}
		if (!deepestShown && allowOpen && deepest.ownerSubWorkflowId) {
			// A node of a Sub-Workflow lives on that Sub-Workflow's own canvas: open it and highlight the node there
			const ownerId = deepest.ownerSubWorkflowId;
			this._openOutlineSubWorkflow(ownerId)
				.then(input => setTimeout(() => {
					if (!(input instanceof SubWorkflowCanvasEditorInput)) {
						return;
					}
					const subUri = input.ticketFolderUri.toString();
					WorkflowEditor._outlineLocated.set(subUri, { targets: targets.filter(t => t.ownerSubWorkflowId === ownerId), owner: this });
					for (const ed of WorkflowEditor._openWorkflowEditors) {
						if (!ed._isPureDiagram && ed._workflowUri?.toString() === subUri) {
							ed._applyOutlineLocateHighlight(true);
						}
					}
				}, 500))
				.catch(() => { /* nothing to highlight */ });
		}
	}

	private _clearOutlineLocate(): void {
		this._outlineSelectedKey = undefined;
		// This canvas and any Sub-Workflow canvas it highlighted nodes on
		for (const [uri, located] of Array.from(WorkflowEditor._outlineLocated)) {
			if (located.owner !== this) {
				continue;
			}
			WorkflowEditor._outlineLocated.delete(uri);
			for (const ed of WorkflowEditor._openWorkflowEditors) {
				if (ed._workflowUri?.toString() === uri) {
					ed._applyOutlineLocateHighlight(false);
				}
			}
		}
	}

	/**
	 * (Re)applies the persistent outline highlight on this canvas (every target rendered here); also called after every node
	 * re-render. With `reveal`, scrolls to the deepest target shown here. Returns whether the clicked (deepest) target is visible here.
	 */
	private _applyOutlineLocateHighlight(reveal: boolean): boolean {
		const container = this._nodesContainer;
		if (!container) {
			return false;
		}
		for (const d of this._renderedNodeDoms()) {
			for (const el of [d.nodeEl, ...d.capsules]) {
				el.classList.remove('wf-outline-locate-node', 'wf-outline-locate-capsule', 'is-pulsing');
			}
		}
		const located = this._workflowUri ? WorkflowEditor._outlineLocated.get(this._workflowUri.toString()) : undefined;
		if (!located) {
			return false;
		}
		let deepestHereEl: HTMLElement | undefined;
		let deepestHere: IWfLocateTarget | undefined;
		let clickedVisible = false;
		located.targets.forEach((target, i) => {
			const nodeDom = this._getNodeDom(target.nodeId);
			if (!nodeDom) {
				return; // not rendered here (e.g. a node of another Sub-Workflow's canvas)
			}
			const nodeEl = nodeDom.nodeEl;
			nodeEl.classList.add('wf-outline-locate-node');
			if (target.stepIndex !== undefined) {
				nodeDom.capsules.find(el => el.getAttribute('data-pipeline-step-idx') === String(target.stepIndex))?.classList.add('wf-outline-locate-capsule');
			}
			const visible = nodeEl.isConnected && nodeEl.getClientRects().length > 0;
			if (visible) {
				deepestHereEl = nodeEl;
				deepestHere = target;
				if (i === located.targets.length - 1) {
					clickedVisible = true;
				}
			}
		});
		if (reveal && deepestHereEl && deepestHere) {
			deepestHereEl.classList.add('is-pulsing'); // draws attention once; the outline itself stays
			this._revealElementInCanvas(deepestHereEl);
		}
		return clickedVisible;
	}

	/**
	 * Scrolls the canvas only if `el` is not fully visible in the free part of the view (the canvas minus the Workflow Outline
	 * panel); then centers it in that free part. Uses on-screen rectangles, so zoom / canvas offsets cannot throw it off.
	 */
	private _revealElementInCanvas(el: HTMLElement): void {
		const scroller = this._canvasScroller();
		if (!scroller) {
			return;
		}
		const view = scroller.getBoundingClientRect();
		let left = view.left;
		const panel = this._outlinePanelEl && this._subWorkflowWidgetEl?.contains(this._outlinePanelEl) ? this._outlinePanelEl : null;
		if (panel) {
			const p = panel.getBoundingClientRect();
			// The panel sits at the top-left: use the area to its right when that leaves a reasonable width
			if (p.width > 0 && p.right > view.left && p.right < view.right - 160) {
				left = p.right + 8;
			}
		}
		const region = { left, top: view.top, right: view.right, bottom: view.bottom };
		const r = el.getBoundingClientRect();
		const margin = 12;
		const fullyVisible = r.left >= region.left + margin && r.right <= region.right - margin && r.top >= region.top + margin && r.bottom <= region.bottom - margin;
		if (fullyVisible) {
			return;
		}
		const dx = (r.left + r.width / 2) - (region.left + region.right) / 2;
		const dy = (r.top + r.height / 2) - (region.top + region.bottom) / 2;
		scroller.scrollTo({ left: Math.max(0, scroller.scrollLeft + dx), top: Math.max(0, scroller.scrollTop + dy), behavior: 'smooth' });
	}

	/** Opens a ticket (or Ticket Type preview) on the right; with `fieldId`, scrolls to and highlights that component. */
	private async _openOutlineTicket(ref: WfOutlineTicketRef, fieldId?: string): Promise<EditorInput | undefined> {
		const group = this._outlineSideGroup();
		let opened: EditorInput | undefined;
		if (ref.kind === 'type') {
			opened = await this._openTicketTypePreviewInEditor(ref.name, group);
		} else {
			const uri = await this._resolveModuleUri({ type: 'ticket', name: ref.id });
			if (!uri) {
				this._notificationService.warn(`Could not locate ticket '${ref.id}'.`);
				return undefined;
			}
			const input = new EntityDetailEditorInput(uri, ref.id);
			const pane = await this._editorService.openEditor(input, { pinned: true, preserveFocus: true }, group);
			opened = pane?.input ?? input;
		}
		if (opened && fieldId) {
			this._revealOutlineField(opened, fieldId);
		}
		return opened;
	}

	/**
	 * Waits for the ticket editor to render the component card, scrolls it to the top and flashes it. Keeps watching for
	 * ~1.5s: the editor may re-render or restore its previous scroll position after loading, which would hide the card again.
	 */
	private _revealOutlineField(input: EditorInput, fieldId: string): void {
		let tries = 0;
		let flashed: HTMLElement | undefined;
		const tick = () => {
			const pane = this._editorService.visibleEditorPanes.find(p => p.input === input);
			const root = pane instanceof EditorPane ? pane.getContainer() : undefined;
			const card = root ? findElementWithFieldId(root, fieldId) : undefined;
			if (card && root) {
				const view = root.getBoundingClientRect();
				const r = card.getBoundingClientRect();
				const isInView = r.top >= view.top - 2 && r.top < view.bottom - 40;
				if (!isInView) {
					card.scrollIntoView({ behavior: 'auto', block: 'start' });
				}
				if (card !== flashed) {
					flashed = card;
					card.classList.add('wf-outline-reveal-flash');
					setTimeout(() => card.classList.remove('wf-outline-reveal-flash'), 1600);
				}
			}
			if (++tries < 16) {
				setTimeout(tick, 100);
			}
		};
		tick();
	}

	private _outlineComponentTypeLabel(type: string | undefined): string {
		const labels: Record<string, string> = {
			prompt: 'AI Prompt', python: 'Python Script', table: 'Data Table', browser: 'Browser', http_request: 'HTTP Request',
			parameters: 'Inputs', output: 'Output', create_tickets: 'Create Tickets', run_tickets: 'Run Tickets', get_outputs: 'Get Outputs',
			get_ticket: 'Get Ticket', get_tickets: 'Get Tickets', display: 'Display', sub_workflow: 'Call Sub-Workflow', voice_note: 'Voice Note',
			tts: 'Text to Speech', media_player: 'Media Player', ssh: 'SSH Terminal', git: 'Git', text: 'Text', select: 'Select'
		};
		return labels[type || ''] || (type || 'Component');
	}

	private _outlineThemeOf(type: string | undefined): IWfCapsuleTheme {
		return WF_COMPONENT_CAPSULE_THEMES[type || ''] || { icon: Codicon.symbolField, color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.12)', border: 'rgba(148, 163, 184, 0.38)', textColor: '#e2e8f0' };
	}

	private _renderNodes(): void {
		if (
			this._activePythonPopoverStep &&
			(!this._activePythonPopoverNode || !this._data?.nodes?.includes(this._activePythonPopoverNode) || !this._activePythonPopoverNode.pipeline?.includes(this._activePythonPopoverStep))
		) {
			this._hidePythonStepPopover(true);
		}
		this._updateCanvasDimensions();
		if (!this._nodesContainer) { return; }
		for (const el of this._inlineNodeEditorEls) {
			if (this._nodesContainer.contains(el)) {
				this._inlineNodeEditorEls.delete(el); // discarded together with the nodes below
			}
		}
		clearNode(this._nodesContainer);
		this._nodeDoms = [];

		if (!this._data || !Array.isArray(this._data.nodes)) {
			return;
		}

		const selectedActionOrderMap = new Map<string, number>();
		let selOrderIdx = 1;
		for (const selId of this._selectedNodeIds) {
			const selNode = this._data.nodes.find(n => n.id === selId);
			if (selNode && this._isActionNodeForSelectiveRun(selNode)) {
				selectedActionOrderMap.set(selId, selOrderIdx++);
			}
		}

		for (const node of this._data.nodes) {
			if (this._deduplicateNodePipeline(node)) {
				this._saveFlowchartData();
			}
			this._ensureNodeFitsPipeline(node);
			const nodeEl = append(this._nodesContainer, $(`.workflow-node.${node.type}${node.groupId ? '.grouped' : ''}`));
			nodeEl.setAttribute('data-node-id', node.id);
			const nodeDom: IWfNodeDom = { nodeId: node.id, nodeEl, pills: [], capsules: [] };
			this._nodeDoms.push(nodeDom);
			wfNodeDomByElement.set(nodeEl, nodeDom);
			if (node.groupId) {
				nodeEl.setAttribute('data-group-id', node.groupId);
			}
			nodeEl.style.left = `${node.x}px`;
			nodeEl.style.top = `${node.y}px`;
			nodeEl.style.width = `${node.width}px`;
			nodeEl.style.height = `${node.height}px`;

			// Custom Node Theme Color & Geometry
			if (node.type === 'diamond') {
				const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
				svg.setAttribute('class', 'diamond-svg-bg');
				svg.setAttribute('viewBox', '0 0 100 100');
				svg.setAttribute('preserveAspectRatio', 'none');

				const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
				polygon.setAttribute('class', 'diamond-svg-polygon');
				polygon.setAttribute('points', '50,0 100,50 50,100 0,50');
				polygon.setAttribute('vector-effect', 'non-scaling-stroke');
				polygon.setAttribute('fill', node.color ? hexToRgba(node.color, 0.12) : 'rgba(13, 148, 136, 0.12)');
				polygon.setAttribute('stroke', node.color || '#0d9488');
				polygon.setAttribute('stroke-width', '1.5');
				svg.appendChild(polygon);
				nodeEl.appendChild(svg);
			} else if (node.color) {
				nodeEl.style.borderColor = node.color;
				nodeEl.style.backgroundColor = hexToRgba(node.color, 0.12);
			}

			// Execution Status Visual Highlighting & Human Interaction
			const activeRun = this._getEffectiveRunForNode(node.id);
			const isActiveRunLive = Boolean(activeRun && (activeRun.status === 'running' || activeRun.status === 'waiting_human' || activeRun.status === 'paused'));
			const nodeRunState = activeRun?.nodeStates?.[node.id];
			if (nodeRunState) {
				if (nodeRunState.carriedOverFromRunId && nodeRunState.status !== 'running') {
					// CI-57: a partial run (run from a mid-workflow node / selected nodes) shows the earlier result of a node it did not run
					nodeEl.classList.add('status-carried-over');
					nodeEl.dataset.carriedOverFromRun = nodeRunState.carriedOverFromRunId;
				}
				if (nodeRunState.status === 'running') {
					if (isActiveRunLive) {
						nodeEl.classList.add('status-running');
					}
				} else if (nodeRunState.status === 'success') {
					nodeEl.classList.add('status-success');
				} else if (nodeRunState.status === 'failed') {
					nodeEl.classList.add('status-failed');

					// Failed Error Interactive Badge
					const errBadge = append(nodeEl, $('.node-error-badge'));
					const stepText = nodeRunState.failedStepIndex !== undefined
						? ` (Step #${nodeRunState.failedStepIndex + 1})`
						: (nodeRunState.failedStage ? ` (${nodeRunState.failedStage})` : '');
					const isConditionErr = nodeRunState.error && /condition/i.test(nodeRunState.error);
					errBadge.textContent = isConditionErr ? '[!] Condition Error [View Log]' : `[X] Failed${stepText} [View Log]`;
					errBadge.title = nodeRunState.error || 'Click to view execution error log';
					errBadge.onmousedown = (e) => e.stopPropagation();
					errBadge.onclick = (e) => {
						e.stopPropagation();
						this._openDrawerTab('logs', node.id);
					};
				} else if (nodeRunState.status === 'waiting_human' && isActiveRunLive) {
					nodeEl.classList.add('status-waiting-human');

					const humanPrompt = nodeRunState.waitingHumanPrompt;
					if (humanPrompt?.decisionId && humanPrompt.options?.length) {
						// Button Group gate (CI-25): offer the gate's own buttons
						const decisionCard = append(nodeEl, $('.node-human-approval-card.node-human-decision-card', { style: 'display: flex; flex-direction: column; gap: 4px; cursor: default;' }));
						decisionCard.title = humanPrompt.prompt;
						decisionCard.onmousedown = (e) => e.stopPropagation();
						append(decisionCard, $('span', undefined, `\u23F8 ${humanPrompt.waitingText || 'Waiting for your decision'}`));
						const btnRow = append(decisionCard, $('div', { style: 'display: flex; flex-wrap: wrap; align-items: center; gap: 4px;' }));
						for (const option of humanPrompt.options) {
							const optBtn = append(btnRow, $('button', { type: 'button', title: `Choose '${option}' and continue`, style: 'font-size: 10.5px; padding: 1px 8px; border-radius: 4px; border: 1px solid rgba(251, 191, 36, 0.6); background: rgba(251, 191, 36, 0.15); color: inherit; cursor: pointer;' }, option));
							optBtn.onmousedown = (e) => e.stopPropagation();
							optBtn.onclick = (e) => {
								e.stopPropagation();
								this._workflowExecutionService.resumeWorkflow(activeRun!.runId, { label: option, by: 'User' });
							};
						}
						const stopBtn = append(btnRow, $('button', {
							type: 'button',
							title: 'Stop this run: ends the whole workflow run without choosing a button',
							'aria-label': 'Stop this run',
							style: 'display: inline-flex; align-items: center; gap: 3px; font-size: 10.5px; padding: 1px 6px; border-radius: 4px; border: 1px solid rgba(239, 68, 68, 0.6); background: rgba(239, 68, 68, 0.12); color: #f87171; cursor: pointer; margin-left: auto;'
						}, $('span.codicon.codicon-debug-stop', { style: 'font-size: 11px;' }), 'Stop this run'));
						stopBtn.onmousedown = (e) => e.stopPropagation();
						stopBtn.onclick = (e) => {
							e.stopPropagation();
							this._workflowExecutionService.stopWorkflow(activeRun!.runId);
						};
					} else {
						// Human Approval Interactive Card
						const humanCard = append(nodeEl, $('.node-human-approval-card'));
						humanCard.textContent = '\u23F8 Waiting Approval [Approve]';
						humanCard.title = 'Click to approve and continue workflow execution';
						humanCard.onmousedown = (e) => e.stopPropagation();
						humanCard.onclick = (e) => {
							e.stopPropagation();
							this._workflowExecutionService.resumeWorkflow(activeRun!.runId, { approved: true, action: 'approved', timestamp: Date.now() });
						};
					}
				}
			}

			const isSelected = this._selectedNodeIds.has(node.id);
			if (isSelected) {
				nodeEl.classList.add('selected');

				const orderNum = selectedActionOrderMap.get(node.id);
				if (orderNum !== undefined && selectedActionOrderMap.size >= 1) {
					const orderBadge = append(nodeEl, $('.node-selection-order-badge'));
					orderBadge.textContent = selectedActionOrderMap.size > 1 ? `\u25B6 #${orderNum}` : '\u25B6 Selected';
					orderBadge.title = selectedActionOrderMap.size > 1
						? `Selected to run #${orderNum} of ${selectedActionOrderMap.size} (Hold Cmd/Ctrl/Shift + Click to toggle nodes)`
						: `Selected node: clicking Run executes this node (Hold Cmd/Ctrl/Shift + Click other nodes to run multiple non-contiguous nodes)`;
				}

				// Add resize handle at bottom-right corner (only if it's the single selected node)
				if (this._selectedNodeIds.size === 1) {
					const resizeHandle = append(nodeEl, $('.node-resize-handle'));
					resizeHandle.title = 'Drag to resize node';
					resizeHandle.onmousedown = (e) => {
						e.stopPropagation();
						e.preventDefault();
						this._isResizing = true;
						this._resizeNodeId = node.id;
						this._resizeStartWidth = node.width;
						this._resizeStartHeight = node.height;
						this._resizeStartX = e.clientX;
						this._resizeStartY = e.clientY;
					};
				}
			}

			// Add port handles (top, right, bottom, left)
			const edges = ['top', 'right', 'bottom', 'left'] as const;
			for (const edge of edges) {
				const port = append(nodeEl, $(`.node-port-handle.${edge}`));
				port.title = `Drag to connect from ${edge} edge`;
				if (node.color) {
					port.style.borderColor = node.color;
				}
				port.onmousedown = (e) => {
					e.stopPropagation();
					e.preventDefault();
					const startCoords = this._getPortCoords(node, edge);
					this._isConnecting = true;
					this._tempLinkStartX = startCoords.x;
					this._tempLinkStartY = startCoords.y;
					this._tempLinkFromNodeId = node.id;
					this._tempLinkFromPort = edge;
				};
			}

			// Right Click context menu
			nodeEl.oncontextmenu = (e) => {
				e.preventDefault();
				e.stopPropagation();
				this._showContextMenu(e.clientX, e.clientY, 'node', node.id);
			};

			// Drag over and Drop support on Node (Context Variables & Module Imports)
			const computeNodeCapsuleDropIndex = (clientY: number, showIndicator: boolean): number => {
				const allPills = [...nodeDom.capsules];
				for (const el of nodeDom.capsules) {
					el.classList.remove('capsule-drop-before', 'capsule-drop-after');
				}
				for (let k = 0; k < allPills.length; k++) {
					const r = allPills[k].getBoundingClientRect();
					const midY = r.top + r.height / 2;
					if (clientY < midY) {
						if (showIndicator) {
							allPills[k].classList.add('capsule-drop-before');
						}
						return k;
					}
				}
				if (showIndicator && allPills.length > 0) {
					allPills[allPills.length - 1].classList.add('capsule-drop-after');
				}
				return node.pipeline ? node.pipeline.length : 0;
			};

			nodeEl.ondragover = (e: DragEvent) => {
				e.preventDefault();
				e.stopPropagation();
				if (e.dataTransfer) {
					e.dataTransfer.dropEffect = 'copy';
				}
				nodeEl.classList.add('drag-hover');
				computeNodeCapsuleDropIndex(e.clientY, true);
			};

			nodeEl.ondragleave = (e: DragEvent) => {
				if (!nodeEl.contains(e.relatedTarget as Node)) {
					nodeEl.classList.remove('drag-hover');
					for (const el of nodeDom.capsules) {
						el.classList.remove('capsule-drop-before', 'capsule-drop-after');
					}
				}
			};

			nodeEl.ondrop = (e: DragEvent) => {
				e.preventDefault();
				e.stopPropagation();
				nodeEl.classList.remove('drag-hover');
				const dropInsertIdx = computeNodeCapsuleDropIndex(e.clientY, false);

				const dataStr = e.dataTransfer?.getData('text/plain');
				if (!dataStr) { return; }

				// 1. Python Step [py] / Component / Variable / Function dropped onto node
				try {
					const parsed = JSON.parse(dataStr);
					if (parsed && parsed.kind === 'sub_workflow_ref' && parsed.subWorkflowId) {
						const subDef = this._workflowExecutionService.getSubWorkflowById(parsed.subWorkflowId);
						if (subDef) {
							this._addSubWorkflowCapsuleToNode(node, subDef, dropInsertIdx);
						}
						return;
					}
					if (parsed && parsed.kind === 'node_component' && parsed.compType) {
						this._addOrOpenComponentOnNode(node, parsed.compType as CustomFieldType, dropInsertIdx);
						return;
					}
					if (parsed && (parsed.kind === 'variable' || parsed.kind === 'variable_widget' || parsed.kind === 'function' || parsed.kind === 'function_widget')) {
						if (!node.pipeline || node.pipeline.length === 0) {
							this._syncFromNode(node, true);
						}
						if (!node.pipeline) {
							node.pipeline = [];
						}
						const newStep: INodePipelineStep = {
							id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
							type: 'call_function',
							functionName: 'PYTHON',
							expression: ''
						};
						const safeIdx = Math.max(0, Math.min(node.pipeline.length, dropInsertIdx));
						node.pipeline.splice(safeIdx, 0, newStep);
						this._ensureNodeFitsPipeline(node);
						this._syncToNode(node, true);
						this._selectedNodeIds.clear();
						this._selectedNodeIds.add(node.id);
						this._saveFlowchartData();
						this._renderNodes();
						this._drawLinks();
						if (this._inspectorEl) { this._renderInspector(this._inspectorEl); }
						if (this._pipelinePanelEl && this._activePipelineNodeId === node.id) {
							this._renderPipelinePanel(this._pipelinePanelEl, node);
						}
						setTimeout(() => {
							const nodeDom = this._getNodeDom(node.id);
							const targetPill = nodeDom?.capsules.find(el => el.getAttribute('data-pipeline-step-idx') === String(safeIdx));
							const pills = nodeDom?.pills;
							const fallbackPill = pills && pills.length > 0 ? pills[pills.length - 1] : undefined;
							this._openNodeFunctionInlineEditor(node, newStep, targetPill || fallbackPill);
						}, 50);
						return;
					}
				} catch { }

				// 2. Resource/Module Import
				if (!this._isPureDiagram && dataStr.startsWith('any-agent-import:')) {
					const parts = dataStr.split(':');
					const type = parts[1]; // agent, task, job
					const name = parts[2]; // resource name

					if (!node.imports) {
						node.imports = [];
					}
					// Avoid duplicates
					if (!node.imports.some(imp => imp.type === type && imp.name === name)) {
						node.imports.push({ type, name });
						if (!node.pipeline) { node.pipeline = []; }
						const newStep: INodePipelineStep = {
							id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
							type: 'run_ticket',
							ticketName: name,
							ticketType: type
						};
						const safeIdx = Math.max(0, Math.min(node.pipeline.length, dropInsertIdx));
						node.pipeline.splice(safeIdx, 0, newStep);
						this._saveFlowchartData();
						this._renderNodes();
						this._drawLinks();
						if (this._pipelinePanelEl && this._activePipelineNodeId === node.id) {
							this._renderPipelinePanel(this._pipelinePanelEl, node);
						}
						this._notificationService.info(`Successfully imported ${type} '${name}' into '${node.label}'`);
					}
				}
			};

			const contentWrapper = append(nodeEl, $('.node-content-wrapper'));
			nodeDom.contentWrapper = contentWrapper;

			// Top-right Voice Note Speaker Icon (auto-shown whenever this node contains a voice_note component)
			const voiceState = this._getNodeVoiceNoteState(node);
			if (voiceState.hasVoiceNoteComponent) {
				const isPlayingThis = this._activeVoicePlayNodeId === node.id;
				const clipCount = voiceState.clips.length;
				const speakerBtn = append(nodeEl, $(`.node-voice-speaker-btn${clipCount === 0 ? '.empty' : ''}${isPlayingThis ? '.playing' : ''}`));
				speakerBtn.setAttribute('data-clip-count', String(clipCount));
				const speakerIcon = append(speakerBtn, $('span.codicon.codicon-unmute'));
				const countBadge = append(speakerBtn, $('span.voice-count-badge'));
				nodeDom.speaker = { btn: speakerBtn, icon: speakerIcon, countBadge };
				if (isPlayingThis && this._activeVoiceClipTotal > 0) {
					countBadge.textContent = `${this._activeVoiceClipIndex + 1}/${this._activeVoiceClipTotal}`;
					countBadge.style.display = 'inline';
				} else if (clipCount > 1) {
					countBadge.textContent = String(clipCount);
					countBadge.style.display = 'inline';
				} else {
					countBadge.style.display = 'none';
				}

				if (clipCount > 0) {
					const transcriptPreview = voiceState.clips
						.map((c, idx) => c.clip.transcript?.trim() ? `#${idx + 1}: ${c.clip.transcript.trim()}` : '')
						.filter(Boolean)
						.join('\n');
					const trimmedPreview = transcriptPreview.length > 260 ? transcriptPreview.substring(0, 260) + '...' : transcriptPreview;
					speakerBtn.title = isPlayingThis
						? `Playing voice note (${this._activeVoiceClipIndex + 1}/${this._activeVoiceClipTotal}) — Click to stop`
						: `Voice Note (${clipCount} clip${clipCount > 1 ? 's' : ''}) — Click to play all sequentially${trimmedPreview ? `\n\n${trimmedPreview}` : ''}`;
				} else {
					speakerBtn.title = 'Voice Note attached (no recordings yet) — Click to open & record';
				}

				speakerBtn.onmousedown = (e) => {
					e.stopPropagation();
				};
				speakerBtn.ondblclick = (e) => {
					e.stopPropagation();
					e.preventDefault();
				};
				speakerBtn.onclick = (e) => {
					e.stopPropagation();
					e.preventDefault();
					this._toggleNodeVoicePlayback(node);
				};
			}

			const labelWrapper = append(contentWrapper, $('.node-label'));
			let displayLabel = node.label || '';
			if (displayLabel.length > 80 || displayLabel.startsWith('#') || displayLabel.startsWith('+ content') || displayLabel.includes('URL: https://')) {
				displayLabel = displayLabel.substring(0, 77) + '...';
			}
			labelWrapper.textContent = displayLabel;

			// Determine text alignment
			const textAlign = node.textAlign || 'center';
			labelWrapper.style.textAlign = textAlign;

			// 1. Attached Modules & Execution Pipeline Steps
			const visiblePipelineEntries = (node.pipeline || [])
				.map((step, index) => ({ step, index }))
				.filter(({ step }) => !(step.component?.type === 'voice_note' && !step.component.voiceRunInFlow));
			const hasPipeline = visiblePipelineEntries.length > 0;
			const hasImports = Boolean(node.imports && node.imports.length > 0);

			if (!this._isPureDiagram && (hasImports || hasPipeline)) {
				const badgesContainer = append(contentWrapper, $('.node-imports-badges-container'));
				badgesContainer.style.justifyContent = 'flex-start';
				badgesContainer.style.width = '100%';
				badgesContainer.style.boxSizing = 'border-box';
				badgesContainer.style.padding = '0 8px';
				/*
				badgesContainer.style.cursor = 'pointer';
				badgesContainer.title = 'Click to open Pipeline';
				badgesContainer.onmousedown = (e) => {
					e.stopPropagation();
				};
				badgesContainer.onclick = (e) => {
					e.stopPropagation();
					this._hideTicketPopover();
					this._openNodePipelinePanel(node.id);
				};
				*/

				if (hasPipeline) {
					badgesContainer.style.flexDirection = 'column';
					badgesContainer.style.flexWrap = 'nowrap';
					badgesContainer.style.alignItems = 'flex-start';
					// Execution Pipeline Sequence: render each visible step in exact sequential order!
					const pipeBadge = append(badgesContainer, $('.node-import-badge'));
					pipeBadge.style.background = 'rgba(56, 189, 248, 0.18)';
					pipeBadge.style.color = '#38bdf8';
					pipeBadge.style.border = '1px solid rgba(56, 189, 248, 0.45)';
					pipeBadge.style.cursor = 'pointer';
					pipeBadge.title = `Pipeline: ${visiblePipelineEntries.length} step(s) configured — Click to open Node Component Editor on the right`;
					append(pipeBadge, $('span' + ThemeIcon.asCSSSelector(Codicon.threeBars)));
					append(pipeBadge, $('span.badge-text', {}, `${visiblePipelineEntries.length} steps`));
					pipeBadge.onmousedown = (e) => {
						if (e.shiftKey || e.ctrlKey || e.metaKey) {
							return;
						}
						e.stopPropagation();
					};
					pipeBadge.onclick = (e) => {
						if (e.shiftKey || e.ctrlKey || e.metaKey) {
							return;
						}
						e.stopPropagation();
						this._hideTicketPopover();
						if (node.pipeline?.some(s => !!s.component)) {
							this._openNodeComponentsInSideEditor(node);
						} else {
							this._openNodePipelinePanel(node.id);
						}
					};
					pipeBadge.ondblclick = (e) => {
						e.stopPropagation();
						e.preventDefault();
						this._hideTicketPopover();
						if (node.pipeline?.some(s => !!s.component)) {
							this._openNodeComponentsInSideEditor(node);
						} else {
							this._openNodePipelinePanel(node.id);
						}
					};

					for (let visibleIdx = 0; visibleIdx < visiblePipelineEntries.length; visibleIdx++) {
						const { step, index: i } = visiblePipelineEntries[visibleIdx];
						const stepNumber = visibleIdx + 1;

						if (step.type === 'run_ticket' && step.ticketName) {
							const badge = append(badgesContainer, $(`.node-import-badge.${step.ticketType || 'ticket'}`));
							const typeLabel = step.ticketType ? (step.ticketType.charAt(0).toUpperCase() + step.ticketType.slice(1)) : 'Ticket';
							const style = getEntityBadgeStyle(step.ticketType);

							badge.style.backgroundColor = style.bg;
							badge.style.color = style.color;
							badge.style.border = `1px solid ${style.color}44`;

							append(badge, $('span' + ThemeIcon.asCSSSelector(style.icon)));

							const badgeText = append(badge, $('span.badge-text'));
							append(badgeText, $('span.badge-name-text', {}, step.ticketName));

							const paramText = step.parameters?.trim();
							if (paramText) {
								append(badgeText, $('span.badge-param-text', {}, `(${paramText})`));
							}

							badge.title = `[Step #${stepNumber} RUN] ${typeLabel}: ${step.ticketName}${paramText ? `\nPARAM: ${paramText}` : ''}\n(Drag to reorder · Double-click to open in Tab · Click to edit in Pipeline)`;

							badge.onmouseenter = () => {
								this._showTicketPopover(badge, { name: step.ticketName || '', type: step.ticketType || 'ticket', uri: step.ticketUri, parameters: step.parameters }, node, stepNumber);
							};
							badge.onmouseleave = () => {
								this._hideTicketPopover();
							};
							badge.onclick = (e) => {
								if (e.shiftKey || e.ctrlKey || e.metaKey) {
									return;
								}
								if ((e.target as HTMLElement | null)?.closest('.capsule-resize-handle')) {
									e.stopPropagation();
									return;
								}
								e.stopPropagation();
								if (wfCapsuleJustDraggedAt.get(badge) && Date.now() - wfCapsuleJustDraggedAt.get(badge)! < 250) {
									return;
								}
								this._hideTicketPopover();
								this._openNodePipelinePanel(node.id, step.ticketName);
							};
							badge.ondblclick = (e) => {
								if ((e.target as HTMLElement | null)?.closest('.capsule-resize-handle')) {
									e.stopPropagation();
									return;
								}
								e.stopPropagation();
								e.preventDefault();
								this._hideTicketPopover();
								this._openModuleInEditor({
									type: step.ticketType || 'ticket',
									name: step.ticketName,
									uri: step.ticketUri
								});
							};
							nodeDom.capsules.push(badge);
							this._attachCapsuleDragReorder(badge, badgesContainer, node, i, badgeText);
						} else if (step.type === 'call_function' || step.type === 'set_variable' || step.type === 'component' || step.component || step.expression) {
							const { pill: fnPillEl, textEl: fnPillTextEl } = this._renderFunctionPill(badgesContainer, node, step, stepNumber);
							nodeDom.pills.push(fnPillEl);
							nodeDom.capsules.push(fnPillEl);
							this._attachCapsuleDragReorder(fnPillEl, badgesContainer, node, i, fnPillTextEl);
						}
					}
				} else {
					// Fallback: No pipeline configured yet (standard separate imports badges)
					const effectiveTickets = node.imports || [];
					for (const t of effectiveTickets) {
						if (!t.name) { continue; }
						const badge = append(badgesContainer, $(`.node-import-badge.${t.type || 'custom'}`));
						const typeLabel = t.type ? (t.type.charAt(0).toUpperCase() + t.type.slice(1)) : 'Module';
						const style = getEntityBadgeStyle(t.type);

						badge.style.backgroundColor = style.bg;
						badge.style.color = style.color;
						badge.style.border = `1px solid ${style.color}44`;

						append(badge, $('span' + ThemeIcon.asCSSSelector(style.icon)));

						const badgeText = append(badge, $('span.badge-text'));
						append(badgeText, $('span.badge-name-text', {}, t.name));

						const paramText = t.parameters?.trim();
						if (paramText) {
							append(badgeText, $('span.badge-param-text', {}, `(${paramText})`));
						}

						badge.title = paramText ? `${typeLabel}: ${t.name}\nPARAM: ${paramText}\n(Double-click to open in Tab, click to edit in Pipeline)` : `${typeLabel}: ${t.name}\n(Double-click to open in Tab, click to edit in Pipeline)`;

						badge.onmouseenter = () => {
							this._showTicketPopover(badge, t, node);
						};
						badge.onmouseleave = () => {
							this._hideTicketPopover();
						};
						badge.onclick = (e) => {
							e.stopPropagation();
							this._hideTicketPopover();
							this._openNodePipelinePanel(node.id, t.name);
						};
						badge.ondblclick = (e) => {
							e.stopPropagation();
							e.preventDefault();
							this._hideTicketPopover();
							this._openModuleInEditor({
								type: t.type || 'ticket',
								name: t.name,
								uri: t.uri
							});
						};
					}
				}
			}

			// 2. Output Context Variables (when no pipeline configured)
			if (!hasPipeline) {
				const nodeVars = this._getNodeVariables(node);
				if (nodeVars.length > 0) {
					const varsContainer = append(contentWrapper, $('.node-variables-container'));
					varsContainer.style.display = 'flex';
					varsContainer.style.flexWrap = 'wrap';
					varsContainer.style.gap = '4px';
					varsContainer.style.marginTop = '4px';
					varsContainer.style.justifyContent = 'flex-start';
					varsContainer.style.width = '100%';
					varsContainer.style.boxSizing = 'border-box';
					varsContainer.style.padding = '0 8px';

					for (const v of nodeVars) {
						nodeDom.pills.push(this._renderVariablePill(varsContainer, node, v));
					}
				}
			}

			// Multiline formatting & Alignment
			// Node title defaults to center-top; follows titleTextAlign if explicitly set
			const titleAlign = node.titleTextAlign || 'center';
			labelWrapper.style.textAlign = titleAlign;
			labelWrapper.style.width = '100%';
			labelWrapper.style.display = 'block';
			labelWrapper.style.flexShrink = '0';

			contentWrapper.style.alignItems = 'stretch';

			const verticalAlign = node.verticalAlign || (hasPipeline ? 'top' : 'center');
			if (verticalAlign === 'top') {
				contentWrapper.style.justifyContent = 'flex-start';
				contentWrapper.style.paddingTop = '6px';
				contentWrapper.style.paddingBottom = '6px';
			} else if (verticalAlign === 'bottom') {
				contentWrapper.style.justifyContent = 'flex-end';
				contentWrapper.style.paddingTop = '6px';
				contentWrapper.style.paddingBottom = '6px';
			} else {
				contentWrapper.style.justifyContent = 'center';
				contentWrapper.style.paddingTop = '0px';
				contentWrapper.style.paddingBottom = '0px';
			}

			if (node.isBold) {
				labelWrapper.style.fontWeight = '700';
			}
			if (node.isItalic) {
				labelWrapper.style.fontStyle = 'italic';
			}
			const textDecorations: string[] = [];
			if (node.isUnderline) { textDecorations.push('underline'); }
			if (node.isStrikethrough) { textDecorations.push('line-through'); }
			if (textDecorations.length > 0) {
				labelWrapper.style.textDecoration = textDecorations.join(' ');
			}
			if (node.textColor) {
				labelWrapper.style.color = node.textColor;
			}

			const handleNodeBlankDblClick = (e: MouseEvent) => {
				const target = e.target as HTMLElement;
				if (
					target.closest('.node-imports-badges-container') ||
					target.closest('.node-import-badge') ||
					target.closest('.node-variables-container') ||
					target.closest('.node-function-pill') ||
					target.closest('.node-variable-pill') ||
					target.closest('.node-function-draft-wrapper') ||
					target.closest('.node-variable-draft-wrapper') ||
					target.closest('.node-port-handle') ||
					target.closest('.node-resize-handle') ||
					target.closest('.node-voice-speaker-btn') ||
					nodeEl.classList.contains('editing-function') ||
					nodeEl.classList.contains('editing-variable')
				) {
					return;
				}
				const labelRect = labelWrapper.getBoundingClientRect();
				const clickedOnTitleArea = e.clientY <= labelRect.bottom + 4;
				if (!clickedOnTitleArea && !this._isPureDiagram) {
					this._openNodeComponentsInSideEditor(node);
					return;
				}
				this._showInlineEditor(nodeEl, node);
			};

			nodeEl.ondblclick = (e) => {
				e.stopPropagation();
				handleNodeBlankDblClick(e);
			};

			// Handle dragging & double-click inline editing
			nodeEl.onmousedown = (e) => {
				// Don't drag if clicking port, resize handle, speaker button, or editing inputs
				if (
					(e.target as HTMLElement).closest('.node-port-handle') ||
					(e.target as HTMLElement).closest('.node-resize-handle') ||
					(e.target as HTMLElement).closest('.node-voice-speaker-btn') ||
					(e.target as HTMLElement).closest('.node-function-draft-wrapper') ||
					(e.target as HTMLElement).closest('.node-variable-draft-wrapper') ||
					(e.target as HTMLElement).closest('.node-inline-editor') ||
					(e.target as HTMLElement).closest('.node-variable-ac-popover')
				) {
					return;
				}
				e.stopPropagation();

				// Detect double click manually (immune to DOM nodes recreation)
				const now = Date.now();
				const lastClickTime = node._lastClickTime || 0;
				node._lastClickTime = now;
				if (now - lastClickTime < 300) {
					const target = e.target as HTMLElement;
					if (
						target.closest('.node-imports-badges-container') ||
						target.closest('.node-import-badge') ||
						target.closest('.node-variables-container') ||
						target.closest('.node-function-pill') ||
						target.closest('.node-variable-pill') ||
						target.closest('.node-function-draft-wrapper') ||
						target.closest('.node-variable-draft-wrapper') ||
						target.closest('.node-port-handle') ||
						target.closest('.node-resize-handle') ||
						target.closest('.node-voice-speaker-btn') ||
						nodeEl.classList.contains('editing-function') ||
						nodeEl.classList.contains('editing-variable')
					) {
						return;
					}
					e.preventDefault();
					handleNodeBlankDblClick(e);
					return;
				}

				// Right click (button === 2): keep existing selection if right clicked node is already selected
				if (e.button === 2) {
					if (!this._selectedNodeIds.has(node.id)) {
						this._selectedNodeIds.clear();
						this._selectedLinkIds.clear();
						this._selectedNodeIds.add(node.id);
						this._renderNodes();
						this._drawLinks();
					}
					return;
				}

				const isMultiKey = e.shiftKey || e.ctrlKey || e.metaKey;
				this._selectedCapsule = null;
				this._selectedCapsules = null;
				this._updateCapsuleSelectionDom();
				this._collapseSelectionTargetNodeId = null;

				if (!isMultiKey) {
					if (node.groupId) {
						// Group Selection: select all nodes in this group
						const groupMemberIds = this._data.nodes.filter(n => n.groupId === node.groupId).map(n => n.id);
						this._selectedNodeIds.clear();
						this._selectedLinkIds.clear();
						for (const id of groupMemberIds) {
							this._selectedNodeIds.add(id);
						}
					} else {
						// If this node is ALREADY part of a multi-selection, preserve selection during potential drag; collapse on mouseup if no drag occurred
						if (this._selectedNodeIds.size > 1 && this._selectedNodeIds.has(node.id)) {
							this._collapseSelectionTargetNodeId = node.id;
						} else if (!this._selectedNodeIds.has(node.id)) {
							this._selectedNodeIds.clear();
							this._selectedLinkIds.clear();
							this._selectedNodeIds.add(node.id);
						}
					}
				} else {
					if (node.groupId) {
						const groupMemberIds = this._data.nodes.filter(n => n.groupId === node.groupId).map(n => n.id);
						const allSelected = groupMemberIds.every(id => this._selectedNodeIds.has(id));
						for (const id of groupMemberIds) {
							if (allSelected) {
								this._selectedNodeIds.delete(id);
							} else {
								this._selectedNodeIds.add(id);
							}
						}
					} else {
						if (this._selectedNodeIds.has(node.id)) {
							this._selectedNodeIds.delete(node.id);
						} else {
							this._selectedNodeIds.add(node.id);
						}
					}
				}

				// Auto expand inspector panel if collapsed when user selects a node
				if (this._isInspectorCollapsed) {
					this._isInspectorCollapsed = false;
					this._inspectorEl?.classList.remove('collapsed');
					this._inspectorTogglePill?.classList.add('hidden');
				}

				this._renderNodes();
				this._drawLinks();

				if (!isMultiKey && this._selectedNodeIds.size === 1) {
					const hasOpenNodeSideEditor = this._editorService.editors.some(
						ed => ed instanceof CustomModuleSchemaEditorInput && !ed.isDisposed() && (ed.isFlowchartNodeMode || ed.moduleId.startsWith('wf_node_'))
					);
					if (hasOpenNodeSideEditor) {
						this._openNodeComponentsInSideEditor(node);
					}
				}

				// Start drag logic for group dragging
				this._isDragging = true;
				this._dragNodeId = node.id;
				this._dragStartX = e.clientX;
				this._dragStartY = e.clientY;

				this._draggedNodesStartPos = new Map();
				for (const nid of this._selectedNodeIds) {
					const n = this._data.nodes.find(item => item.id === nid);
					if (n) {
						this._draggedNodesStartPos.set(nid, { x: n.x, y: n.y });
					}
				}
			};
		}

		if (this._inspectorEl) {
			this._renderInspector(this._inspectorEl);
		}
		this._updateRunButtonSelectionBadge();
		this._applyOutlineLocateHighlight(false);
	}

	/** The `name` property of the current editor input, if it has one. */
	private _inputNameProperty(): string | undefined {
		const input = this.input;
		if (input && hasWorkflowProperty(input, 'name')) {
			const name = input.name;
			return typeof name === 'string' ? name : undefined;
		}
		return undefined;
	}

	/** Rendered nodes that are currently attached to this editor's canvas, in document order. */
	private _renderedNodeDoms(): IWfNodeDom[] {
		const root = this._nodesContainer || this._canvas;
		return root ? this._nodeDoms.filter(d => root.contains(d.nodeEl)) : [];
	}

	/** The (first) rendered node element of `nodeId` on this editor's canvas. */
	private _getNodeDom(nodeId: string): IWfNodeDom | undefined {
		return this._renderedNodeDoms().find(d => d.nodeId === nodeId);
	}

	private _hasActiveInlineNodeEditor(): boolean {
		const container = this._nodesContainer;
		return !!container && [...this._inlineNodeEditorEls].some(el => container.contains(el));
	}

	private _showInlineEditor(nodeEl: HTMLElement, node: IFlowchartNode): void {
		if ([...this._inlineNodeEditorEls].some(el => el.classList.contains('node-inline-editor') && nodeEl.contains(el))) {
			return;
		}

		let curLabel = node.label || '';
		if (curLabel.length > 250 || curLabel.includes('\n') || curLabel.startsWith('#') || curLabel.startsWith('+ content') || curLabel.includes('URL: https://')) {
			curLabel = curLabel.substring(0, 50).trim() || 'Step';
		}

		const contentWrapper = wfNodeDomByElement.get(nodeEl)?.contentWrapper;
		if (contentWrapper) {
			contentWrapper.style.visibility = 'hidden';
		}

		const textarea = append(nodeEl, $('textarea.node-inline-editor')) as HTMLTextAreaElement;
		this._inlineNodeEditorEls.add(textarea);
		textarea.value = curLabel;

		textarea.style.position = 'absolute';
		textarea.style.left = '4px';
		textarea.style.top = '4px';
		textarea.style.width = 'calc(100% - 8px)';
		textarea.style.height = 'calc(100% - 8px)';
		textarea.style.boxSizing = 'border-box';
		textarea.style.fontSize = '11.5px';
		textarea.style.fontFamily = 'inherit';
		textarea.style.lineHeight = '1.35';
		textarea.style.textAlign = node.textAlign || 'center';
		textarea.style.fontWeight = node.isBold ? '700' : '500';
		textarea.style.fontStyle = node.isItalic ? 'italic' : 'normal';
		const editDecorations: string[] = [];
		if (node.isUnderline) { editDecorations.push('underline'); }
		if (node.isStrikethrough) { editDecorations.push('line-through'); }
		textarea.style.textDecoration = editDecorations.length > 0 ? editDecorations.join(' ') : 'none';
		textarea.style.background = 'var(--vscode-input-background, #1e1e1e)';
		textarea.style.color = node.textColor || 'var(--vscode-input-foreground, #ffffff)';
		textarea.style.border = '1px solid var(--vscode-focusBorder, #007fd4)';
		textarea.style.borderRadius = '4px';
		textarea.style.outline = 'none';
		textarea.style.zIndex = '1000';
		textarea.style.padding = '4px 6px';
		textarea.style.resize = 'none';
		textarea.style.whiteSpace = 'pre-wrap';
		textarea.style.wordBreak = 'break-word';

		// Stop propagation of all mouse events to prevent canvas selection and dragging
		textarea.onmousedown = (e) => e.stopPropagation();
		textarea.onmouseup = (e) => e.stopPropagation();
		textarea.onclick = (e) => e.stopPropagation();
		textarea.ondblclick = (e) => e.stopPropagation();

		let isFinished = false;
		let blurReady = false;

		const saveText = () => {
			if (isFinished) {
				return;
			}
			isFinished = true;
			const newText = textarea.value;
			if (newText !== node.label) {
				node.label = newText;
				this._saveFlowchartData();
			}
			this._renderNodes();
			this._drawLinks();
		};

		const cancelEdit = () => {
			if (isFinished) {
				return;
			}
			isFinished = true;
			this._renderNodes();
			this._drawLinks();
		};

		textarea.focus();
		textarea.select();
		this._targetWindow.requestAnimationFrame(() => {
			if (isFinished || !textarea.isConnected) {
				return;
			}
			textarea.focus();
			textarea.select();
			setTimeout(() => {
				blurReady = true;
			}, 60);
		});

		textarea.onkeydown = (e) => {
			if (e.isComposing || e.keyCode === 229) {
				e.stopPropagation();
				return;
			}
			if (e.key === 'Enter') {
				if (e.shiftKey) {
					// Shift+Enter creates a new line in textarea natively
					e.stopPropagation();
				} else {
					// Plain Enter only finishes text input and saves (does not spawn a new node)
					e.preventDefault();
					e.stopPropagation();
					saveText();
				}
			} else if (e.key === 'Tab') {
				// Tab saves and creates a child node
				e.preventDefault();
				e.stopPropagation();
				saveText();
				this._createChildNode(node);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				cancelEdit();
			}
		};

		textarea.onblur = () => {
			if (isFinished || !textarea.isConnected) {
				return;
			}
			if (!blurReady) {
				// Ignore transient blur caused by the trailing mouseup/click of the double-click gesture
				this._targetWindow.requestAnimationFrame(() => {
					if (!isFinished && textarea.isConnected) {
						textarea.focus();
					}
				});
				return;
			}
			saveText();
		};
	}

	/**
	 * Inline node label editors (`textarea.node-inline-editor`) and function draft popups (`.node-function-draft-wrapper`)
	 * created on the canvas; whether one is active is decided by whether it is still inside `_nodesContainer`.
	 */
	private readonly _inlineNodeEditorEls = new Set<HTMLElement>();
	private _activeVariableDraftInputEl: HTMLElement | null = null;
	private _activeFunctionDraftInputEl: HTMLElement | null = null;

	private _setupDraftPopupPositionAndDrag(
		nodeEl: HTMLElement,
		draftWrapper: HTMLElement,
		headerRow: HTMLElement,
		/** The `.node-function-header-title` element of `headerRow`. */
		titleEl: HTMLElement | undefined
	): () => void {
		// 1. Add visual drag grip icon to header title and set tooltip
		const existingGrip = titleEl ? wfDraftDragGrips.get(titleEl) : undefined;
		if (titleEl && !(existingGrip && titleEl.contains(existingGrip))) {
			const grip = document.createElement('span');
			wfDraftDragGrips.set(titleEl, grip);
			grip.className = 'draft-drag-grip';
			grip.textContent = '\u283F';
			grip.title = 'Drag header to move panel';
			titleEl.insertBefore(grip, titleEl.firstChild);
		}
		headerRow.title = 'Drag header to move panel';

		// 2. Compute non-obstructing initial position (default below node; flip above/beside if near bottom of viewport)
		const nodeW = nodeEl.offsetWidth || 240;
		const nodeH = nodeEl.offsetHeight || 110;
		const popupW = draftWrapper.offsetWidth || 500;
		const popupH = draftWrapper.offsetHeight || 250;

		let left = Math.round((nodeW - popupW) / 2);
		let top = nodeH + 14;

		const canvasEl = this._canvas || nodeEl.parentElement;
		if (canvasEl) {
			const canvasRect = canvasEl.getBoundingClientRect();
			const nodeRect = nodeEl.getBoundingClientRect();
			const zoom = this._zoomLevel || 1;

			const logDrawer = this._logDrawerEl && this._container?.contains(this._logDrawerEl) ? this._logDrawerEl : null;
			const logDrawerTop = (logDrawer && logDrawer.style.display !== 'none' && logDrawer.offsetHeight > 0)
				? logDrawer.getBoundingClientRect().top
				: canvasRect.bottom;

			const visibleBottom = Math.min(canvasRect.bottom, logDrawerTop) - 12;
			const visibleTop = canvasRect.top + 12;
			const visibleLeft = canvasRect.left + 12;
			const visibleRight = canvasRect.right - 12;

			const spaceBelow = visibleBottom - nodeRect.bottom;
			const spaceAbove = nodeRect.top - visibleTop;
			const spaceRight = visibleRight - nodeRect.right;
			const spaceLeft = nodeRect.left - visibleLeft;

			const neededH = popupH * zoom + 14;
			const neededW = popupW * zoom + 16;

			let placedBeside = false;
			if (spaceBelow >= neededH) {
				top = nodeH + 14;
			} else if (spaceAbove >= neededH) {
				top = -(popupH + 14);
			} else if (spaceRight >= neededW) {
				left = nodeW + 16;
				top = Math.max(-Math.round((nodeRect.top - visibleTop) / zoom), Math.round((nodeH - popupH) / 2));
				placedBeside = true;
			} else if (spaceLeft >= neededW) {
				left = -(popupW + 16);
				top = Math.max(-Math.round((nodeRect.top - visibleTop) / zoom), Math.round((nodeH - popupH) / 2));
				placedBeside = true;
			} else {
				top = spaceBelow >= spaceAbove ? (nodeH + 14) : -(popupH + 14);
			}

			if (!placedBeside) {
				const screenRight = nodeRect.left + (left + popupW) * zoom;
				if (screenRight > visibleRight) {
					left -= Math.ceil((screenRight - visibleRight) / zoom);
				}
				const screenLeft = nodeRect.left + left * zoom;
				if (screenLeft < visibleLeft) {
					left += Math.ceil((visibleLeft - screenLeft) / zoom);
				}
			}
		}

		draftWrapper.style.left = `${left}px`;
		draftWrapper.style.top = `${top}px`;
		draftWrapper.style.transform = 'none';

		// 3. Attach drag handler on headerRow
		let activeMoveHandler: ((ev: MouseEvent) => void) | null = null;
		let activeUpHandler: ((ev: MouseEvent) => void) | null = null;

		const cleanupDragListeners = () => {
			draftWrapper.classList.remove('is-dragging');
			if (activeMoveHandler) {
				this._targetWindow.removeEventListener('mousemove', activeMoveHandler, true);
				activeMoveHandler = null;
			}
			if (activeUpHandler) {
				this._targetWindow.removeEventListener('mouseup', activeUpHandler, true);
				activeUpHandler = null;
			}
		};

		headerRow.onmousedown = (e: MouseEvent) => {
			e.stopPropagation();
			const target = e.target as HTMLElement | null;
			if (target && target.closest('.var-draft-cancel-btn, .node-function-open-tab-btn, button')) {
				return;
			}
			e.preventDefault();
			cleanupDragListeners();

			const startClientX = e.clientX;
			const startClientY = e.clientY;
			const startLeft = parseFloat(draftWrapper.style.left || '0') || draftWrapper.offsetLeft;
			const startTop = parseFloat(draftWrapper.style.top || '0') || draftWrapper.offsetTop;

			draftWrapper.classList.add('is-dragging');

			activeMoveHandler = (moveEvent: MouseEvent) => {
				moveEvent.stopPropagation();
				const zoom = this._zoomLevel || 1;
				const dx = (moveEvent.clientX - startClientX) / zoom;
				const dy = (moveEvent.clientY - startClientY) / zoom;
				draftWrapper.style.left = `${Math.round(startLeft + dx)}px`;
				draftWrapper.style.top = `${Math.round(startTop + dy)}px`;
				draftWrapper.style.transform = 'none';
			};

			activeUpHandler = (upEvent: MouseEvent) => {
				upEvent.stopPropagation();
				cleanupDragListeners();
			};

			this._targetWindow.addEventListener('mousemove', activeMoveHandler, true);
			this._targetWindow.addEventListener('mouseup', activeUpHandler, true);
		};

		return cleanupDragListeners;
	}

	private _openNodeVariableInlineEditor(
		node: IFlowchartNode,
		targetVar?: INodeVariable,
		targetPillElement?: HTMLElement,
		pipelineStep?: INodePipelineStep
	): void {
		// Redirect all variable editing to the unified Python Step Editor [py]!
		if (pipelineStep) {
			this._openNodeFunctionInlineEditor(node, pipelineStep, targetPillElement);
			return;
		}
		if (targetVar) {
			let step = (node.pipeline || []).find(
				s => s.targetVariable?.replace(/^@/, '') === targetVar.name.replace(/^@/, '')
			);
			if (!step) {
				if (!node.pipeline) { node.pipeline = []; }
				const rawExpr = (targetVar.expression || targetVar.initialValue || 'None').trim();
				const cleanName = targetVar.name.replace(/^@/, '');
				const fullExpr = rawExpr.startsWith(cleanName) || rawExpr.startsWith(`@${cleanName}`)
					? rawExpr.replace(/^@/, '')
					: `${cleanName} = ${rawExpr.replace(/^=\s*/, '')}`;
				step = {
					id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
					type: 'call_function',
					targetVariable: cleanName,
					functionName: 'PYTHON',
					expression: fullExpr
				};
				node.pipeline.push(step);
			}
			this._openNodeFunctionInlineEditor(node, step, targetPillElement);
			return;
		}
		this._openNodeFunctionInlineEditor(node, undefined, targetPillElement);
	}

	private _openNodeFunctionInlineEditor(
		node: IFlowchartNode,
		existingStep?: INodePipelineStep,
		targetPillElement?: HTMLElement
	): void {
		if (this._activeFunctionDraftInputEl) {
			this._activeFunctionDraftInputEl.remove();
			this._activeFunctionDraftInputEl = null;
		}

		// 0. If existingStep is a component step, open the Component Editor Modal!
		if (existingStep && existingStep.component) {
			this._openNodeComponentEditorModal(node, existingStep);
			return;
		}

		// 1. If existingStep is explicitly a run_ticket step, open it in a VS Code editor tab!
		if (existingStep && existingStep.type === 'run_ticket') {
			const ticketType = existingStep.ticketType || 'ticket';
			const ticketName = existingStep.ticketName || existingStep.stepName || '';
			if (ticketName) {
				this._openModuleInEditor({ type: ticketType, name: ticketName, uri: existingStep.ticketUri });
				return;
			}
		}

		const nodeEl = this._getNodeDom(node.id)?.nodeEl;
		if (!nodeEl) {
			return;
		}
		nodeEl.classList.add('editing-function');

		if (targetPillElement) {
			targetPillElement.classList.add('editing-active-pill');
		}

		// Calculate current workflow relative folder path
		let defaultPath = '.';
		if (this._workflowUri) {
			const wsFolder = this._workspaceContextService.getWorkspaceFolder(this._workflowUri);
			if (wsFolder) {
				const wfDir = URI.joinPath(this._workflowUri, '..');
				const rel = wfDir.path.substring(wsFolder.uri.path.length).replace(/^\/+|\/+$/g, '');
				defaultPath = rel || '.';
			}
		}

		// Collect all canvas variables available across nodes & pipelines
		const availableVars = new Set<string>();
		for (const n of this._data?.nodes || []) {
			for (const v of this._getNodeVariables(n)) {
				if (v.name) { availableVars.add(v.name.replace(/^@/, '')); }
			}
			for (const p of n.pipeline || []) {
				if (p.component && p.component.type !== 'parameters' && p.component.type !== 'output' && p.component.type !== 'display') {
					availableVars.add(this._getComponentOutputVarName(p.component));
				}
				if (p.targetVariable) { availableVars.add(p.targetVariable.replace(/^@/, '')); }
			}
		}

		// Initial expression value (default empty so we never pre-fill code the user didn't ask for)
		let initialExpr = '';

		if (existingStep) {
			if (existingStep.expression) {
				let expr = existingStep.expression.trim();
				// If expression is the legacy untouched default placeholder `res = RUN_TICKETS(ticket="", params={})`, treat as empty
				if (/^(?:res\s*=\s*)?RUN_TICKETS\(\s*ticket\s*=\s*""\s*(?:,\s*params\s*=\s*\{\s*\}\s*)?\)$/i.test(expr)) {
					expr = '';
				}
				// If expression was polluted by raw markdown/scraped content, sanitize it back
				if (expr.startsWith('+ content') || expr.includes('URL: https://')) {
					expr = '';
				}
				if (expr && existingStep.type === 'set_variable' && existingStep.targetVariable) {
					const vName = existingStep.targetVariable.replace(/^@/, '');
					if (!expr.startsWith(vName) && !expr.startsWith(`@${vName}`)) {
						expr = `${vName} = ${expr.replace(/^=\s*/, '')}`;
					}
				}
				// Strip legacy @ prefixes before variable identifiers
				expr = expr.replace(/(^|[^a-zA-Z0-9_])@([a-zA-Z_][a-zA-Z0-9_]*)/g, '$1$2');
				// Unwrap accidental RUN_TICKETS(ticket="CREATE_TICKETS(...)", params={...}) if user clicked CREATE_TICKETS inside ticket=""
				const accidentalWrap = expr.match(/^(?:([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*)?RUN_TICKETS\(\s*ticket\s*=\s*"((?:CREATE_TICKETS|GET_TICKETS|GET_OUTPUTS)\([\s\S]+\))"\s*(?:,\s*(params\s*=\s*\{[\s\S]*\}))?\s*\)$/i);
				if (accidentalWrap) {
					const innerCall = accidentalWrap[2];
					const trailingParams = accidentalWrap[3];
					if (trailingParams && !/\bparams\s*=/.test(innerCall) && innerCall.endsWith(')')) {
						expr = `new_ticket = ${innerCall.slice(0, -1)}, ${trailingParams})`;
					} else {
						expr = `new_ticket = ${innerCall}`;
					}
				}
				initialExpr = expr;
			}
		}

		const draftWrapper = document.createElement('div');
		draftWrapper.className = 'node-function-draft-wrapper';
		this._inlineNodeEditorEls.add(draftWrapper);
		this._activeFunctionDraftInputEl = draftWrapper;

		// Stop mouse events from reaching canvas or node to prevent dragging/re-rendering
		draftWrapper.onmousedown = (e) => e.stopPropagation();
		draftWrapper.onmouseup = (e) => e.stopPropagation();
		draftWrapper.onclick = (e) => e.stopPropagation();
		draftWrapper.ondblclick = (e) => e.stopPropagation();

		// Row 1: Header + Interpreter Badge + Close Button
		const headerRow = append(draftWrapper, $('.node-function-header-row'));
		headerRow.onmousedown = (e) => e.stopPropagation();

		const titleDiv = append(headerRow, $('.node-function-header-title'));
		const fnTag = append(titleDiv, $('span.fn-tag-icon' + ThemeIcon.asCSSSelector(Codicon.python)));
		fnTag.style.fontSize = '14px';
		fnTag.style.color = '#c084fc';
		const titleText = append(titleDiv, $('.node-function-title-text'));
		titleText.textContent = 'Python Step Editor';

		const pyEnvChip = append(headerRow, $('span.node-function-py-env-chip'));
		const activePyPath = pythonPathSettingToPath(this._data?.pythonPath || this._detectedPythonPath || 'python3');
		const shortPyLabel = activePyPath.includes('.venv') ? '.venv (Python)' : (activePyPath.split('/').pop() || 'python3');
		const renderPyEnvChipContent = (labelStr: string) => {
			clearNode(pyEnvChip);
			const iconEl = append(pyEnvChip, $('span' + ThemeIcon.asCSSSelector(Codicon.python)));
			iconEl.style.fontSize = '11px';
			append(pyEnvChip, $('span', {}, labelStr));
		};
		renderPyEnvChipContent(shortPyLabel);
		pyEnvChip.title = `Active Python Interpreter: ${activePyPath}\n(Click to change Python interpreter)`;
		pyEnvChip.style.cursor = 'pointer';
		pyEnvChip.style.marginLeft = '8px';
		pyEnvChip.style.padding = '1px 7px';
		pyEnvChip.style.fontSize = '10px';
		pyEnvChip.style.borderRadius = '3px';
		pyEnvChip.style.background = 'rgba(56, 189, 248, 0.14)';
		pyEnvChip.style.border = '1px solid rgba(56, 189, 248, 0.35)';
		pyEnvChip.style.color = '#7dd3fc';
		pyEnvChip.style.display = 'inline-flex';
		pyEnvChip.style.alignItems = 'center';
		pyEnvChip.style.gap = '4px';
		pyEnvChip.onmousedown = (e) => { e.stopPropagation(); e.preventDefault(); };
		pyEnvChip.onclick = (e) => {
			e.stopPropagation();
			this._showPythonInterpreterMenu(pyEnvChip, (newPath) => {
				const lbl = newPath.includes('.venv') ? '.venv (Python)' : (newPath.split('/').pop() || 'python3');
				renderPyEnvChipContent(lbl);
				pyEnvChip.title = `Active Python Interpreter: ${newPath}`;
			});
		};

		// Step Execution Toggle: Enabled vs Commented Out (Disabled)
		const initialDisabled = Boolean(existingStep?.disabled);
		let isStepDisabled = initialDisabled;

		const toggleBtn = append(headerRow, $('button.node-function-toggle-btn'));
		toggleBtn.type = 'button';
		toggleBtn.style.cursor = 'pointer';
		toggleBtn.style.marginLeft = 'auto';
		toggleBtn.style.marginRight = '6px';
		toggleBtn.style.padding = '1px 8px';
		toggleBtn.style.fontSize = '10px';
		toggleBtn.style.borderRadius = '3px';
		toggleBtn.style.display = 'inline-flex';
		toggleBtn.style.alignItems = 'center';
		toggleBtn.style.gap = '4px';
		toggleBtn.style.userSelect = 'none';
		toggleBtn.style.transition = 'all 0.15s ease';

		const updateToggleBtnState = () => {
			clearNode(toggleBtn);
			if (isStepDisabled) {
				toggleBtn.classList.remove('is-active-step');
				toggleBtn.classList.add('is-disabled-step');
				toggleBtn.style.background = 'rgba(148, 163, 184, 0.16)';
				toggleBtn.style.border = '1px dashed rgba(148, 163, 184, 0.5)';
				toggleBtn.style.color = '#94a3b8';
				toggleBtn.title = localize('stepDisabledTip', 'Step is Commented Out (Disabled). It will be skipped during Workflow execution.\nClick to re-enable.');
				append(toggleBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.circleSlash)));
				append(toggleBtn, $('span', {}, localize('stepDisabledLabel', 'Commented Out')));
				draftWrapper.classList.add('step-commented-out');
			} else {
				toggleBtn.classList.remove('is-disabled-step');
				toggleBtn.classList.add('is-active-step');
				toggleBtn.style.background = 'rgba(34, 197, 94, 0.16)';
				toggleBtn.style.border = '1px solid rgba(34, 197, 94, 0.45)';
				toggleBtn.style.color = '#4ade80';
				toggleBtn.title = localize('stepEnabledTip', 'Step is Active (Enabled). It will execute normally during Workflow run.\nClick to comment out (disable).');
				append(toggleBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.check)));
				append(toggleBtn, $('span', {}, localize('stepEnabledLabel', 'Active')));
				draftWrapper.classList.remove('step-commented-out');
			}
		};
		updateToggleBtnState();

		toggleBtn.onmousedown = (e) => {
			e.stopPropagation();
			e.preventDefault();
		};
		toggleBtn.onclick = (e) => {
			e.stopPropagation();
			isStepDisabled = !isStepDisabled;
			if (existingStep) {
				existingStep.disabled = isStepDisabled ? true : undefined;
				this._syncToNode(node, true);
				this._saveFlowchartData();
				this._renderNodes();
			}
			updateToggleBtnState();
		};

		// Optional: Open referenced ticket in Editor Tab button
		const candidateTicket = (node.imports || [])[0] || (node.pipeline || []).find(s => s.type === 'run_ticket' && s.ticketName);
		if (candidateTicket) {
			const { ticketName, ticketType } = ticketRefNameAndType(candidateTicket);
			if (ticketName) {
				const openTabBtn = append(headerRow, $('.node-function-open-tab-btn'));
				openTabBtn.title = `Open Ticket '${ticketName}' in Editor Tab`;
				openTabBtn.style.cursor = 'pointer';
				openTabBtn.style.marginLeft = '0';
				openTabBtn.style.marginRight = '6px';
				openTabBtn.style.padding = '1px 7px';
				openTabBtn.style.fontSize = '10px';
				openTabBtn.style.borderRadius = '3px';
				openTabBtn.style.background = 'rgba(192, 132, 252, 0.15)';
				openTabBtn.style.border = '1px solid rgba(192, 132, 252, 0.4)';
				openTabBtn.style.color = '#d8b4fe';
				openTabBtn.style.display = 'inline-flex';
				openTabBtn.style.alignItems = 'center';
				openTabBtn.style.gap = '3px';
				append(openTabBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.linkExternal)));
				append(openTabBtn, $('span', {}, 'Open in Tab'));
				openTabBtn.onmousedown = (e) => {
					e.stopPropagation();
					e.preventDefault();
				};
				openTabBtn.onclick = (e) => {
					e.stopPropagation();
					this._openModuleInEditor({ type: ticketType || 'ticket', name: ticketName });
				};
			}
		}

		const cancelBtn = append(headerRow, $('.var-draft-cancel-btn'));
		cancelBtn.title = 'Cancel (Esc)';
		cancelBtn.textContent = '\u2715';
		cancelBtn.style.cursor = 'pointer';
		cancelBtn.onmousedown = (e) => {
			e.stopPropagation();
			e.preventDefault();
		};

		let disposeDrag: (() => void) | null = null;
		const cleanup = () => {
			if (disposeDrag) {
				disposeDrag();
				disposeDrag = null;
			}
			nodeEl.classList.remove('editing-function');
			if (popover) {
				popover.remove();
				popover = null;
			}
			if (targetPillElement) {
				targetPillElement.classList.remove('editing-active-pill');
				targetPillElement.style.display = '';
			}
			draftWrapper.remove();
			this._inlineNodeEditorEls.delete(draftWrapper);
			this._activeFunctionDraftInputEl = null;
		};

		const rollbackDisabledIfNeeded = () => {
			if (existingStep && existingStep.disabled !== initialDisabled) {
				existingStep.disabled = initialDisabled ? true : undefined;
				this._syncToNode(node, true);
				this._saveFlowchartData();
				this._renderNodes();
			}
		};

		cancelBtn.onclick = (e) => {
			e.stopPropagation();
			rollbackDisabledIfNeeded();
			cleanup();
		};

		// Row 2: Template Chips (insert at cursor position instead of overwriting editor)
		const chipsRow = append(draftWrapper, $('.node-function-templates-row'));
		chipsRow.onmousedown = (e) => e.stopPropagation();
		append(chipsRow, $('.node-function-templates-label', {}, 'Insert:'));

		const isDefaultPlaceholderLine = (lineStr: string): boolean => {
			const trimmed = lineStr.trim();
			return /^(?:res\s*=\s*)?RUN_TICKETS\(\s*ticket\s*=\s*""\s*(?:,\s*params\s*=\s*\{\s*\}\s*)?\)$/i.test(trimmed);
		};

		const insertSnippetAtCursor = (snippet: string, defaultAssignVar?: string) => {
			const val = codeArea.value;
			const selStart = codeArea.selectionStart ?? val.length;
			const selEnd = codeArea.selectionEnd ?? selStart;

			// If editor only contains the untouched default `res = RUN_TICKETS(ticket="", params={})`, replace it cleanly
			if (selStart === selEnd && isDefaultPlaceholderLine(val)) {
				const fullReplacement = defaultAssignVar ? `${defaultAssignVar} = ${snippet}` : snippet;
				codeArea.value = fullReplacement;
				codeArea.focus();
				const quoteIdx = fullReplacement.indexOf('""');
				if (quoteIdx !== -1) {
					codeArea.selectionStart = codeArea.selectionEnd = quoteIdx + 1;
				} else if (fullReplacement.endsWith('()')) {
					codeArea.selectionStart = codeArea.selectionEnd = fullReplacement.length - 1;
				} else {
					codeArea.selectionStart = codeArea.selectionEnd = fullReplacement.length;
				}
				updateFieldChips();
				return;
			}

			// Check if cursor is currently inside quotes "..." when inserting a statement/function that itself contains quotes
			let inQuoteChar: string | null = null;
			for (let i = 0; i < selStart; i++) {
				const ch = val[i];
				if (inQuoteChar) {
					if (ch === inQuoteChar && val[i - 1] !== '\\') {
						inQuoteChar = null;
					}
				} else if (ch === '"' || ch === '\'') {
					inQuoteChar = ch;
				}
			}

			// If cursor is inside a string literal and snippet has quotes/newlines, insert on a new line after the current line instead of breaking the string
			if (inQuoteChar && (snippet.includes('"') || snippet.includes('\n'))) {
				const lineEndIdx = val.indexOf('\n', selEnd);
				const insertPos = lineEndIdx === -1 ? val.length : lineEndIdx;
				const lineStartIdx = val.lastIndexOf('\n', selStart - 1) + 1;
				const indentMatch = val.substring(lineStartIdx, selStart).match(/^[ \t]*/);
				const indent = indentMatch ? indentMatch[0] : '';
				const lineText = defaultAssignVar ? `${defaultAssignVar} = ${snippet}` : snippet;
				const formatted = '\n' + lineText.split('\n').map(ln => indent + ln).join('\n');
				codeArea.value = val.substring(0, insertPos) + formatted + val.substring(insertPos);
				codeArea.focus();
				const quoteIdx = formatted.indexOf('""');
				if (quoteIdx !== -1) {
					codeArea.selectionStart = codeArea.selectionEnd = insertPos + quoteIdx + 1;
				} else {
					codeArea.selectionStart = codeArea.selectionEnd = insertPos + formatted.length;
				}
				updateFieldChips();
				return;
			}

			const before = val.substring(0, selStart);
			const after = val.substring(selEnd);

			let formattedSnippet = snippet;
			if (snippet.includes('\n')) {
				const lineStart = before.lastIndexOf('\n') + 1;
				const currentLineBefore = before.substring(lineStart);
				const indentMatch = currentLineBefore.match(/^[ \t]*/);
				const indent = indentMatch ? indentMatch[0] : '';
				if (indent) {
					const lines = snippet.split('\n');
					formattedSnippet = lines.map((ln, idx) => idx === 0 ? ln : indent + ln).join('\n');
				}
			}

			codeArea.value = `${before}${formattedSnippet}${after}`;
			codeArea.focus();
			const quoteIdx = formattedSnippet.indexOf('""');
			if (quoteIdx !== -1) {
				codeArea.selectionStart = codeArea.selectionEnd = selStart + quoteIdx + 1;
			} else if (formattedSnippet.endsWith('()')) {
				codeArea.selectionStart = codeArea.selectionEnd = selStart + formattedSnippet.length - 1;
			} else {
				codeArea.selectionStart = codeArea.selectionEnd = selStart + formattedSnippet.length;
			}
			updateFieldChips();
		};

		const addChip = (name: string, snippet: string, defaultAssignVar?: string) => {
			const chip = append(chipsRow, $('.node-function-template-chip'));
			chip.textContent = name;
			chip.title = `Click to insert ${name} at cursor position`;
			chip.onmousedown = (e) => {
				e.stopPropagation();
				e.preventDefault();
			};
			chip.onclick = (e) => {
				e.stopPropagation();
				insertSnippetAtCursor(snippet, defaultAssignVar);
			};
		};

		addChip('RUN_TICKETS', 'RUN_TICKETS(ticket="", params={})', 'res');
		addChip('CREATE_TICKETS', `CREATE_TICKETS(ticket_type="Task", title="", path="${defaultPath}", params={})`, 'new_ticket');
		addChip('GET_TICKETS', 'GET_TICKETS(ticket="")', 'ticket_data');
		addChip('GET_OUTPUTS', 'GET_OUTPUTS(ticket="")', 'out');
		addChip('DISPLAY', 'DISPLAY()');
		addChip('var = 0', 'start_offset = 0');
		addChip('var = []', 'my_positions = []');
		addChip('var = {}', 'data = {}');
		addChip('for ...:', 'for item in items:\n    pass');
		addChip('def ...:', 'def helper(x):\n    return x');
		addChip('class ...:', 'class Record:\n    def __init__(self, name):\n        self.name = name');

		// Row 3: Multiline Code Area (full Python code + built-in functions)
		const codeRow = append(draftWrapper, $('.node-function-code-row'));
		codeRow.onmousedown = (e) => e.stopPropagation();

		const codeBackdrop = append(codeRow, $('.node-function-code-backdrop'));
		const codeArea = append(codeRow, $('textarea.node-function-code-area')) as HTMLTextAreaElement;
		codeArea.rows = 5;
		codeArea.spellcheck = false;
		codeArea.value = initialExpr;
		codeArea.placeholder = '';
		codeArea.onmousedown = (e) => e.stopPropagation();
		codeArea.onclick = (e) => e.stopPropagation();

		const syncFnBackdrop = () => {
			const hasBadges = this._renderExpressionWithTicketBadges(codeBackdrop, codeArea.value, true);
			codeRow.classList.toggle('has-ticket-badges', hasBadges);
		};
		codeArea.onscroll = () => {
			codeBackdrop.scrollTop = codeArea.scrollTop;
		};
		syncFnBackdrop();

		// Row 4: Parameters Reference
		const fieldsRow = append(draftWrapper, $('.node-function-fields-row'));
		// Field chips, hints, "more" buttons and hidden-chip wraps created for the fields row (rebuilt on every update)
		let fieldsRowChipEls: HTMLElement[] = [];
		fieldsRow.onmousedown = (e) => e.stopPropagation();
		const fieldsLabel = append(fieldsRow, $('.node-function-fields-label', {}, 'Inputs:'));

		// Row 4b: Available Context Variables & Date/Time Symbols Reference Row
		const varsRefRow = append(draftWrapper, $('.node-function-templates-row'));
		varsRefRow.style.marginTop = '1px';
		varsRefRow.onmousedown = (e) => e.stopPropagation();

		const insertTokenAtCursor = (tokenInsideQuotes: string, tokenOutsideQuotes: string) => {
			const selStart = codeArea.selectionStart ?? codeArea.value.length;
			const selEnd = codeArea.selectionEnd ?? selStart;
			const val = codeArea.value;
			const before = val.substring(0, selStart);
			const after = val.substring(selEnd);
			let inStringQuote: string | null = null;
			for (let i = 0; i < before.length; i++) {
				const ch = before[i];
				if (inStringQuote) {
					if (ch === inStringQuote && before[i - 1] !== '\\') {
						inStringQuote = null;
					}
				} else if (ch === '"' || ch === '\'') {
					inStringQuote = ch;
				}
			}
			const insertText = inStringQuote ? tokenInsideQuotes : tokenOutsideQuotes;
			codeArea.value = `${before}${insertText}${after}`;
			codeArea.focus();
			codeArea.selectionStart = codeArea.selectionEnd = selStart + insertText.length;
			updateFieldChips();
		};

		let isVarsRefExpanded = false;
		const renderVarsRefChips = () => {
			clearNode(varsRefRow);
			append(varsRefRow, $('.node-function-templates-label', {}, 'Variables:'));
			const allVarNames = Array.from(availableVars);
			const maxInitialVars = 4;
			const visibleVarNames = allVarNames.slice(0, maxInitialVars);
			const hiddenVarNames = allVarNames.slice(maxInitialVars);

			const renderVarChip = (parentEl: HTMLElement, vName: string) => {
				const vChip = append(parentEl, $('.node-function-field-chip.standard'));
				vChip.textContent = vName;
				vChip.title = `Click to insert Python variable '${vName}' at cursor`;
				vChip.onmousedown = (e) => {
					e.stopPropagation();
					e.preventDefault();
				};
				vChip.onclick = (e) => {
					e.stopPropagation();
					insertTokenAtCursor(`{${vName}}`, vName);
				};
			};

			for (const vName of visibleVarNames) {
				renderVarChip(varsRefRow, vName);
			}

			if (hiddenVarNames.length > 0) {
				const hiddenWrap = append(varsRefRow, $('span', {
					style: isVarsRefExpanded ? 'display: contents;' : 'display: none;'
				}));
				for (const vName of hiddenVarNames) {
					renderVarChip(hiddenWrap, vName);
				}
				const moreChip = append(varsRefRow, $('button', {
					type: 'button',
					style: 'padding: 1px 7px; font-size: 9.5px; font-weight: 600; border-radius: 4px; border: 1px dashed rgba(56, 189, 248, 0.45); background: rgba(56, 189, 248, 0.08); color: #38bdf8; cursor: pointer; white-space: nowrap;',
					title: 'Show / hide more variables'
				}, isVarsRefExpanded ? 'Less' : `+${hiddenVarNames.length} More...`));
				moreChip.onmousedown = (e) => {
					e.stopPropagation();
					e.preventDefault();
				};
				moreChip.onclick = (e) => {
					e.stopPropagation();
					isVarsRefExpanded = !isVarsRefExpanded;
					hiddenWrap.style.display = isVarsRefExpanded ? 'contents' : 'none';
					moreChip.textContent = isVarsRefExpanded ? 'Less' : `+${hiddenVarNames.length} More...`;
				};
			}

			const dateTimeSymbols = [
				{ label: 'DATE()', tip: 'Insert current date YYYY-MM-DD (inserts {DATE()} inside quotes, or DATE() outside quotes)' },
				{ label: 'NOW()', tip: 'Insert current date & time YYYY-MM-DD HH:mm:ss (inserts {NOW()} inside quotes, or NOW() outside quotes)' },
				{ label: 'TIME()', tip: 'Insert current time HH:mm:ss (inserts {TIME()} inside quotes, or TIME() outside quotes)' }
			];
			for (const sym of dateTimeSymbols) {
				const sChip = append(varsRefRow, $('.node-function-template-chip'));
				sChip.textContent = sym.label;
				sChip.title = sym.tip;
				sChip.onmousedown = (e) => {
					e.stopPropagation();
					e.preventDefault();
				};
				sChip.onclick = (e) => {
					e.stopPropagation();
					insertTokenAtCursor(`{${sym.label}}`, sym.label);
				};
			}
		};

		const extractSchemaParamsForType = (typeName: string): IWfSchemaParamSpec[] => {
			return this._extractSchemaParamsForType(typeName);
		};

		let lastAutoPrefilledType = '';
		let lastAutoPrefilledDict = '';

		const buildParamsDictLiteral = (specs: IWfSchemaParamSpec[]): string => {
			if (specs.length === 0) { return '{}'; }
			const entries = specs.map(sp => {
				const defaultValue = sp.defaultValue;
				const isVarRef = typeof defaultValue === 'string' && defaultValue.startsWith('@');
				const valStr = typeof defaultValue === 'number' || typeof defaultValue === 'boolean'
					? String(defaultValue)
					: (isVarRef ? defaultValue.substring(1) : JSON.stringify(String(defaultValue ?? '')));
				return `"${sp.name}": ${valStr}`;
			});
			return `{${entries.join(', ')}}`;
		};

		const pruneNonSchemaParams = (code: string, schemaSpecs: IWfSchemaParamSpec[]): string => {
			if (!code) { return code; }
			const validNames = new Set(schemaSpecs.map(s => s.name.toLowerCase()));
			return code.replace(/\b(params|parameters)\s*=\s*\{([\s\S]*?)\}/, (match, paramKw, dictBody) => {
				const entryRegex = /(?:["']([^"']+)["']|([a-zA-Z_][a-zA-Z0-9_]*))\s*:\s*([^,\n}]+(?:\{[^{}]*\}[^,\n}]*)?)(?:,\s*|\s*|$)/g;
				const preservedEntries: string[] = [];
				const seenKeys = new Set<string>();
				let em: RegExpExecArray | null;
				while ((em = entryRegex.exec(dictBody)) !== null) {
					const key = (em[1] || em[2] || '').trim();
					let rawVal = (em[3] || '').trim();
					if (!key) { continue; }
					const lowerKey = key.toLowerCase();
					if (validNames.has(lowerKey) && !seenKeys.has(lowerKey)) {
						seenKeys.add(lowerKey);
						const spec = schemaSpecs.find(s => s.name.toLowerCase() === lowerKey);
						if ((rawVal === '""' || rawVal === '\'\'') && spec && spec.defaultValue !== undefined && spec.defaultValue !== '') {
							rawVal = typeof spec.defaultValue === 'number' || typeof spec.defaultValue === 'boolean'
								? String(spec.defaultValue)
								: JSON.stringify(String(spec.defaultValue));
						}
						preservedEntries.push(`"${spec ? spec.name : key}": ${rawVal}`);
					}
				}
				if (preservedEntries.length === 0 && schemaSpecs.length > 0) {
					return `${paramKw}=${buildParamsDictLiteral(schemaSpecs)}`;
				}
				if (preservedEntries.length > 1) {
					return `${paramKw}={\n        ${preservedEntries.join(',\n        ')}\n    }`;
				}
				return `${paramKw}={${preservedEntries.join(', ')}}`;
			});
		};

		const autoPrefillParamsInCode = (targetTypeKey: string, specs: IWfSchemaParamSpec[]) => {
			if (specs.length === 0) { return; }
			const dictLiteral = buildParamsDictLiteral(specs);
			const curVal = codeArea.value;
			const prevSelStart = codeArea.selectionStart ?? curVal.length;
			const prevSelEnd = codeArea.selectionEnd ?? prevSelStart;

			// 1. If `params={...}` or `parameters={...}` has non-schema parameters, prune them!
			if (/\b(params|parameters)\s*=\s*\{[\s\S]*?\}/.test(curVal)) {
				const pruned = pruneNonSchemaParams(curVal, specs);
				if (pruned !== curVal) {
					codeArea.value = pruned;
					lastAutoPrefilledType = targetTypeKey.toLowerCase();
					lastAutoPrefilledDict = dictLiteral;
					return;
				}
			}

			// 2. If `params={}` is currently empty, pre-fill it with `"key": defaultValue` pairs!
			const emptyParamsMatch = /\b(params|parameters)\s*=\s*\{\s*\}/.exec(curVal);
			if (emptyParamsMatch && emptyParamsMatch.index !== undefined) {
				const keyWord = emptyParamsMatch[1];
				const replacement = `${keyWord}=${dictLiteral}`;
				codeArea.value = curVal.substring(0, emptyParamsMatch.index) + replacement + curVal.substring(emptyParamsMatch.index + emptyParamsMatch[0].length);
				lastAutoPrefilledType = targetTypeKey.toLowerCase();
				lastAutoPrefilledDict = dictLiteral;
				if (prevSelStart <= emptyParamsMatch.index) {
					codeArea.selectionStart = prevSelStart;
					codeArea.selectionEnd = prevSelEnd;
				}
				return;
			}

			// 3. If user switched `ticket_type` and `params={...}` still equals the previous unmodified auto-prefilled dict, update it to the new type's keys!
			if (lastAutoPrefilledDict && lastAutoPrefilledType && lastAutoPrefilledType !== targetTypeKey.toLowerCase()) {
				const idx = curVal.indexOf(lastAutoPrefilledDict);
				if (idx !== -1) {
					codeArea.value = curVal.substring(0, idx) + dictLiteral + curVal.substring(idx + lastAutoPrefilledDict.length);
					lastAutoPrefilledType = targetTypeKey.toLowerCase();
					lastAutoPrefilledDict = dictLiteral;
					if (prevSelStart <= idx) {
						codeArea.selectionStart = prevSelStart;
						codeArea.selectionEnd = prevSelEnd;
					}
					return;
				}
			}

			// 4. If CREATE_TICKETS(...) does not have `params=` at all yet (and none of the input keys are passed yet), append `, params={...}` automatically!
			if (/CREATE_TICKETS\s*\(/i.test(curVal) && !/\b(params|parameters)\s*=/.test(curVal)) {
				const anyKeyAlreadyPassed = specs.some(sp => new RegExp(`(?:["']${sp.name}["']\\s*:|\\b${sp.name}\\s*=)`, 'i').test(curVal));
				if (!anyKeyAlreadyPassed) {
					const lastParen = curVal.lastIndexOf(')');
					if (lastParen !== -1) {
						let beforeClose = curVal.substring(0, lastParen).trimEnd();
						if (beforeClose.endsWith(',')) {
							beforeClose = beforeClose.slice(0, -1).trimEnd();
						}
						const sep = beforeClose.endsWith('(') ? '' : ', ';
						const insertion = `${sep}params=${dictLiteral}`;
						codeArea.value = beforeClose + insertion + curVal.substring(lastParen);
						lastAutoPrefilledType = targetTypeKey.toLowerCase();
						lastAutoPrefilledDict = dictLiteral;
						if (prevSelStart <= beforeClose.length) {
							codeArea.selectionStart = prevSelStart;
							codeArea.selectionEnd = prevSelEnd;
						}
					}
				}
			}
		};

		let isParamsChipsExpanded = false;
		const updateFieldChips = () => {
			// Auto-unwrap accidental `RUN_TICKETS(ticket="CREATE_TICKETS(...)", params={})` if present
			const rawCheck = codeArea.value.trim();
			const wrapMatch = rawCheck.match(/^(?:([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*)?RUN_TICKETS\(\s*ticket\s*=\s*"((?:CREATE_TICKETS|GET_TICKETS|GET_OUTPUTS)\([\s\S]+\))"\s*(?:,\s*(params\s*=\s*\{[\s\S]*\}))?\s*\)$/i);
			if (wrapMatch) {
				const innerCall = wrapMatch[2];
				const trailingParams = wrapMatch[3];
				if (trailingParams && !/\bparams\s*=/.test(innerCall) && innerCall.endsWith(')')) {
					codeArea.value = `new_ticket = ${innerCall.slice(0, -1)}, ${trailingParams})`;
				} else {
					codeArea.value = `new_ticket = ${innerCall}`;
				}
			}

			const typeMatch = codeArea.value.match(/ticket_type\s*=\s*["']([^"']+)["']/i);
			const curType = typeMatch ? typeMatch[1] : 'Task';

			// Pre-discover schema params for CREATE_TICKETS / RUN_TICKETS so we can auto-prefill `params={...}` before rendering backdrop
			if (/CREATE_TICKETS/i.test(codeArea.value)) {
				const schemaParams = extractSchemaParamsForType(curType);
				if (schemaParams.length > 0) {
					autoPrefillParamsInCode(curType, schemaParams);
				}
			} else if (/\b(RUN_TICKETS|run_tickets)\b/i.test(codeArea.value)) {
				const runTicketIdMatch = codeArea.value.match(/(?:ticket|ticket_id)\s*=\s*["']?([a-zA-Z0-9_\-]+)["']?/i);
				if (runTicketIdMatch && runTicketIdMatch[1]) {
					const targetIdentifier = runTicketIdMatch[1].trim();
					const schemaParams = extractSchemaParamsForType(targetIdentifier);
					if (schemaParams.length > 0) {
						autoPrefillParamsInCode(targetIdentifier, schemaParams);
					}
				}
			}

			syncFnBackdrop();
			const val = codeArea.value;

			const chipElsInFieldsRow = fieldsRowChipEls.filter(el => fieldsRow.contains(el));
			fieldsRowChipEls = fieldsRowChipEls.filter(el => !fieldsRow.contains(el));
			chipElsInFieldsRow.forEach(el => el.remove());

			// Collect all canvas variables available across nodes & pipelines + local editor variables
			availableVars.clear();
			for (const n of this._data?.nodes || []) {
				for (const v of this._getNodeVariables(n)) {
					if (v.name) { availableVars.add(v.name.replace(/^@/, '')); }
				}
				for (const p of n.pipeline || []) {
					if (p.targetVariable) { availableVars.add(p.targetVariable.replace(/^@/, '')); }
				}
			}
			// Also extract local variables & loop variables from current Python code
			const localAssignRe = /(?:^|\n)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\+|-|\*|\/)?=(?!=)/g;
			let lm: RegExpExecArray | null;
			while ((lm = localAssignRe.exec(val)) !== null) {
				if (lm[1] && !WorkflowEditor._PYTHON_KEYWORDS.has(lm[1])) {
					availableVars.add(lm[1]);
				}
			}
			const localForRe = /\bfor\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)*)\s+in\b/g;
			while ((lm = localForRe.exec(val)) !== null) {
				for (const part of lm[1].split(',')) {
					const cleanPart = part.trim();
					if (cleanPart && !WorkflowEditor._PYTHON_KEYWORDS.has(cleanPart)) {
						availableVars.add(cleanPart);
					}
				}
			}
			renderVarsRefChips();

			interface IParamSpec {
				name: string;
				defaultValue: unknown;
				isStandard?: boolean;
				isDictParam?: boolean;
			}
			const paramSpecs: IParamSpec[] = [];

			if (/CREATE_TICKETS/i.test(val)) {
				fieldsLabel.textContent = `Inputs (${curType}):`;

				// 1. Discover Inputs / Parameters strictly from Custom Module YAML schema (ICustomModulesService)
				const schemaParams = extractSchemaParamsForType(curType);
				for (const sp of schemaParams) {
					if (!paramSpecs.some(p => p.name.toLowerCase() === sp.name.toLowerCase())) {
						paramSpecs.push({ name: sp.name, defaultValue: sp.defaultValue, isDictParam: true });
					}
				}

				// 2. Standard options
				paramSpecs.push({ name: 'title', defaultValue: '', isStandard: true });
				paramSpecs.push({ name: 'path', defaultValue: defaultPath, isStandard: true });
			} else if (/\b(RUN_TICKETS|run_tickets)\b/i.test(val)) {
				fieldsLabel.textContent = 'Inputs (RUN_TICKETS):';
				const ticketVarCandidate = Array.from(availableVars).find(v => /ticket/i.test(v));
				const ticketDefault = ticketVarCandidate ? `@${ticketVarCandidate}` : '';
				paramSpecs.push({ name: 'ticket', defaultValue: ticketDefault, isStandard: true });

				// If ticket="TICKET-ID" or ticket_id="TICKET-ID" is specified, surface ONLY that ticket's Inputs / Parameters from its Template Schema
				const runTicketIdMatch = val.match(/(?:ticket|ticket_id)\s*=\s*["']?([a-zA-Z0-9_\-]+)["']?/i);
				if (runTicketIdMatch && runTicketIdMatch[1]) {
					const targetIdentifier = runTicketIdMatch[1].trim();
					for (const sp of extractSchemaParamsForType(targetIdentifier)) {
						if (!paramSpecs.some(p => p.name.toLowerCase() === sp.name.toLowerCase())) {
							paramSpecs.push({ name: sp.name, defaultValue: sp.defaultValue, isDictParam: true });
						}
					}
				}
			} else if (/GET_TICKETS/i.test(val)) {
				fieldsLabel.textContent = 'Inputs (GET_TICKETS):';
				const ticketVarCandidate = Array.from(availableVars).find(v => /ticket/i.test(v));
				paramSpecs.push({ name: 'ticket', defaultValue: ticketVarCandidate ? `@${ticketVarCandidate}` : '', isStandard: true });
			} else if (/GET_OUTPUTS/i.test(val)) {
				fieldsLabel.textContent = 'Inputs (GET_OUTPUTS):';
				const ticketVarCandidate = Array.from(availableVars).find(v => /ticket/i.test(v));
				paramSpecs.push({ name: 'ticket', defaultValue: ticketVarCandidate ? `@${ticketVarCandidate}` : '', isStandard: true });
				paramSpecs.push({ name: 'field', defaultValue: '' });
			} else {
				fieldsLabel.textContent = 'Inputs:';
			}

			if (paramSpecs.length === 0) {
				const hint = append(fieldsRow, $('.node-function-field-hint'));
				fieldsRowChipEls.push(hint);
				hint.textContent = 'Standard Python syntax enabled (variables, lists, dicts, loops, def, class)';
				hint.style.fontSize = '9.5px';
				hint.style.opacity = '0.5';
				hint.style.fontStyle = 'italic';
				return;
			}

			const maxInitialParams = 4;
			const visibleParamSpecs = paramSpecs.slice(0, maxInitialParams);
			const hiddenParamSpecs = paramSpecs.slice(maxInitialParams);

			const renderParamSpecChip = (parentEl: HTMLElement, p: IParamSpec) => {
				const dictEntryRegex = new RegExp(`(["']${p.name}["']\\s*:\\s*)(["'][^"']*["']|[^,\\}\\n]+)`, 'i');
				const kwargEntryRegex = new RegExp(`(\\b${p.name}\\s*=\\s*)(["'][^"']*["']|[^,\\)\\n]+)`, 'i');
				const dictMatch = dictEntryRegex.exec(val);
				const kwargMatch = kwargEntryRegex.exec(val);
				const isIncluded = Boolean(dictMatch || kwargMatch);

				const isVarRef = typeof p.defaultValue === 'string' && p.defaultValue.startsWith('@');
				const cleanVarRef = isVarRef ? String(p.defaultValue).substring(1) : '';
				const formattedVal = typeof p.defaultValue === 'number' || typeof p.defaultValue === 'boolean'
					? String(p.defaultValue)
					: (isVarRef ? cleanVarRef : `"${p.defaultValue}"`);
				const safeDisplayVal = formattedVal.length > 35 ? formattedVal.substring(0, 32) + '..."' : formattedVal;

				const chip = append(parentEl, $('.node-function-field-chip'));
				fieldsRowChipEls.push(chip);
				if (isIncluded) {
					chip.classList.add('included');
					const actualValRaw = dictMatch ? dictMatch[2].trim() : (kwargMatch ? kwargMatch[2].trim() : safeDisplayVal);
					const actualValDisplay = actualValRaw.length > 35 ? actualValRaw.substring(0, 32) + '..."' : actualValRaw;
					const chipText = dictMatch
						? `\u2713 "${p.name}": ${actualValDisplay}`
						: `\u2713 ${p.name} = ${actualValDisplay}`;
					this._renderExpressionWithTicketBadges(chip, chipText, false);
					chip.title = `${p.name} is configured (Click to select value and edit or replace with a variable)`;
				} else {
					if (p.isStandard) {
						chip.classList.add('standard');
					}
					const chipText = p.isDictParam
						? `+ "${p.name}": ${safeDisplayVal}`
						: `+ ${p.name} = ${safeDisplayVal}`;
					this._renderExpressionWithTicketBadges(chip, chipText, false);
					chip.title = p.isDictParam
						? `Click to insert "${p.name}": ${formattedVal} into params={...}`
						: `Click to insert ${p.name}=${formattedVal}`;
				}

				chip.onmousedown = (e) => {
					e.stopPropagation();
					e.preventDefault();
				};

				chip.onclick = (e) => {
					e.stopPropagation();
					if (isIncluded) {
						const curMatch = dictEntryRegex.exec(codeArea.value) || kwargEntryRegex.exec(codeArea.value);
						if (curMatch && curMatch.index !== undefined) {
							const valStart = curMatch.index + curMatch[1].length;
							const valEnd = valStart + curMatch[2].trimEnd().length;
							codeArea.focus();
							codeArea.setSelectionRange(valStart, valEnd);
						}
					} else if (p.isDictParam) {
						// Insert `"name": formattedVal` into `params={...}` dict if present, or create `params={"name": formattedVal}`
						const paramsDictRe = /\b(params|parameters)\s*=\s*\{([\s\S]*?)\}/;
						const pm = paramsDictRe.exec(codeArea.value);
						if (pm && pm.index !== undefined) {
							const closeBraceIdx = pm.index + pm[0].lastIndexOf('}');
							let beforeBrace = codeArea.value.substring(0, closeBraceIdx).trimEnd();
							if (beforeBrace.endsWith(',')) {
								beforeBrace = beforeBrace.slice(0, -1).trimEnd();
							}
							const sep = beforeBrace.endsWith('{') ? '' : ', ';
							const entryPrefix = `${sep}"${p.name}": `;
							const afterBrace = codeArea.value.substring(closeBraceIdx);
							codeArea.value = `${beforeBrace}${entryPrefix}${formattedVal}${afterBrace}`;
							const valStart = beforeBrace.length + entryPrefix.length;
							codeArea.focus();
							codeArea.setSelectionRange(valStart, valStart + formattedVal.length);
						} else {
							const lastParen = codeArea.value.lastIndexOf(')');
							if (lastParen !== -1) {
								let beforeClose = codeArea.value.substring(0, lastParen).trimEnd();
								if (beforeClose.endsWith(',')) {
									beforeClose = beforeClose.slice(0, -1).trimEnd();
								}
								const sep = beforeClose.endsWith('(') ? '' : ', ';
								const dictPrefix = `${sep}params={"${p.name}": `;
								const afterClose = codeArea.value.substring(lastParen);
								codeArea.value = `${beforeClose}${dictPrefix}${formattedVal}}${afterClose}`;
								const valStart = beforeClose.length + dictPrefix.length;
								codeArea.focus();
								codeArea.setSelectionRange(valStart, valStart + formattedVal.length);
							}
						}
						updateFieldChips();
					} else {
						// Standard kwarg (title=..., path=...)
						const lastParen = codeArea.value.lastIndexOf(')');
						if (lastParen !== -1) {
							let beforeClose = codeArea.value.substring(0, lastParen).trimEnd();
							if (beforeClose.endsWith(',')) {
								beforeClose = beforeClose.slice(0, -1).trimEnd();
							}
							const sep = beforeClose.endsWith('(') ? '' : ', ';
							const paramPrefix = `${sep}${p.name}=`;
							const afterClose = codeArea.value.substring(lastParen);
							codeArea.value = `${beforeClose}${paramPrefix}${formattedVal}${afterClose}`;
							const valStart = beforeClose.length + paramPrefix.length;
							const valEnd = valStart + formattedVal.length;
							codeArea.focus();
							codeArea.setSelectionRange(valStart, valEnd);
						}
						updateFieldChips();
					}
				};
			};

			for (const p of visibleParamSpecs) {
				renderParamSpecChip(fieldsRow, p);
			}

			if (hiddenParamSpecs.length > 0) {
				const hiddenWrap = append(fieldsRow, $('span.node-function-hidden-wrap', {
					style: isParamsChipsExpanded ? 'display: contents;' : 'display: none;'
				}));
				fieldsRowChipEls.push(hiddenWrap);
				for (const p of hiddenParamSpecs) {
					renderParamSpecChip(hiddenWrap, p);
				}
				const moreBtn = append(fieldsRow, $('button.node-function-more-btn', {
					type: 'button',
					style: 'padding: 1px 7px; font-size: 9.5px; font-weight: 600; border-radius: 4px; border: 1px dashed rgba(56, 189, 248, 0.45); background: rgba(56, 189, 248, 0.08); color: #38bdf8; cursor: pointer; white-space: nowrap;',
					title: 'Show / hide more parameters'
				}, isParamsChipsExpanded ? 'Less' : `+${hiddenParamSpecs.length} More...`));
				fieldsRowChipEls.push(moreBtn);
				moreBtn.onmousedown = (e) => {
					e.stopPropagation();
					e.preventDefault();
				};
				moreBtn.onclick = (e) => {
					e.stopPropagation();
					isParamsChipsExpanded = !isParamsChipsExpanded;
					hiddenWrap.style.display = isParamsChipsExpanded ? 'contents' : 'none';
					moreBtn.textContent = isParamsChipsExpanded ? 'Less' : `+${hiddenParamSpecs.length} More...`;
				};
			}
		};
		codeArea.oninput = () => updateFieldChips();
		updateFieldChips();
		if (this._workflowUri) {
			this._customModulesService.getCustomModules(this._workflowUri).then(mods => {
				if (Array.isArray(mods) && mods.length > 0) {
					this._cachedCustomModules = mods;
					updateFieldChips();
				}
			}).catch(() => { });
		}

		// Row 5: Action buttons
		const footerRow = append(draftWrapper, $('.node-function-footer-row'));
		footerRow.onmousedown = (e) => e.stopPropagation();
		append(footerRow, $('.node-function-footer-hint', {}, 'Enter for newline | Cmd/Ctrl+Enter to save | Esc to cancel'));

		const actionsDiv = append(footerRow, $('.node-function-footer-actions'));
		const btnCancel = append(actionsDiv, $('button.node-function-btn.node-function-btn-cancel', {}, 'Cancel'));
		btnCancel.onclick = (e) => {
			e.stopPropagation();
			rollbackDisabledIfNeeded();
			cleanup();
		};

		const btnSave = append(actionsDiv, $('button.node-function-btn.node-function-btn-save', {}, 'Save Step'));
		btnSave.onclick = (e) => {
			e.stopPropagation();
			commit();
		};

		// Autocomplete suggestions
		const collectSuggestions = () => {
			const suggestions: { name: string; type: string; badgeLabel: string; detail: string; snippet?: string }[] = [];
			const seen = new Set<string>();

			const fns = [
				{ name: 'RUN_TICKETS', detail: 'RUN_TICKETS(ticket="", params={})', snippet: 'RUN_TICKETS(ticket="", params={})' },
				{ name: 'CREATE_TICKETS', detail: `CREATE_TICKETS(ticket_type="Task", title="", path="${defaultPath}", params={})`, snippet: `CREATE_TICKETS(ticket_type="Task", title="", path="${defaultPath}", params={})` },
				{ name: 'GET_TICKETS', detail: 'GET_TICKETS(ticket="")', snippet: 'GET_TICKETS(ticket="")' },
				{ name: 'GET_OUTPUTS', detail: 'GET_OUTPUTS(ticket="", field="")', snippet: 'GET_OUTPUTS(ticket="", field="")' },
				{ name: 'GET_PRIMITIVES_CATALOG', detail: 'GET_PRIMITIVES_CATALOG()', snippet: 'GET_PRIMITIVES_CATALOG()' },
				{ name: 'DISPLAY', detail: 'DISPLAY(value)', snippet: 'DISPLAY()' }
			];
			for (const f of fns) {
				suggestions.push({
					name: f.name,
					type: 'func',
					badgeLabel: 'PY',
					detail: f.detail,
					snippet: f.snippet
				});
			}

			for (const n of this._data?.nodes || []) {
				for (const v of this._getNodeVariables(n)) {
					if (!seen.has(v.name)) {
						seen.add(v.name);
						const valDisplay = v.initialValue !== undefined && v.initialValue !== 'None' ? ` = ${v.initialValue}` : '';
						suggestions.push({
							name: v.name,
							type: 'var',
							badgeLabel: 'VAR',
							detail: `Variable [${n.label}]${valDisplay}`
						});
					}
				}
				for (const p of n.pipeline || []) {
					if (p.targetVariable) {
						const cleanV = p.targetVariable.replace(/^@/, '');
						if (!seen.has(cleanV)) {
							seen.add(cleanV);
							suggestions.push({
								name: cleanV,
								type: 'var',
								badgeLabel: 'VAR',
								detail: `Output Variable [${n.label}]`
							});
						}
					}
				}
				for (const imp of n.imports || []) {
					const tName = imp.name.replace(/[^a-zA-Z0-9_]/g, '_');
					if (!seen.has(tName)) {
						seen.add(tName);
						suggestions.push({
							name: tName,
							type: imp.type || 'ticket',
							badgeLabel: (imp.type || 'ticket').toUpperCase(),
							detail: `${imp.type || 'ticket'}: ${imp.name}`
						});
					}
				}
			}

			return suggestions;
		};

		let popover: HTMLElement | null = null;
		let activeAcIdx = 0;
		let currentMatches: { name: string; type: string; badgeLabel: string; detail: string; snippet?: string }[] = [];

		const closePopover = () => {
			if (popover) {
				popover.remove();
				popover = null;
			}
		};

		const insertAcItem = (item: { name: string; type: string; snippet?: string }) => {
			const selStart = codeArea.selectionStart || 0;
			const val = codeArea.value;
			const textBefore = val.slice(0, selStart);
			const textAfter = val.slice(selStart);
			const wordMatch = textBefore.match(/@?([a-zA-Z0-9_\u4e00-\u9fa5]*)$/);
			const replaceFrom = wordMatch ? selStart - wordMatch[0].length : selStart;
			const replacement = item.type === 'func' ? (item.snippet || `${item.name}()`) : item.name;
			codeArea.value = val.slice(0, replaceFrom) + replacement + textAfter;
			const newCursor = replaceFrom + replacement.length;
			codeArea.selectionStart = codeArea.selectionEnd = newCursor;
			closePopover();
			codeArea.focus();
			updateFieldChips();
		};

		const updateAc = () => {
			const selStart = codeArea.selectionStart || 0;
			const textBefore = codeArea.value.slice(0, selStart);
			const match = textBefore.match(/@?([a-zA-Z0-9_\u4e00-\u9fa5]{2,})$/);
			if (!match || !match[1]) {
				closePopover();
				return;
			}

			const query = match[1].toLowerCase();
			const all = collectSuggestions();
			currentMatches = all.filter(item => item.name.toLowerCase().includes(query) && item.name.toLowerCase() !== query);
			if (currentMatches.length === 0) {
				closePopover();
				return;
			}

			if (!popover) {
				popover = append(draftWrapper, $('.node-variable-ac-popover'));
				popover.onmousedown = (e) => {
					e.stopPropagation();
					e.preventDefault();
				};
			}
			clearNode(popover);
			currentMatches.slice(0, 8).forEach((item, idx) => {
				const row = append(popover!, $('.node-variable-ac-item'));
				if (idx === activeAcIdx) { row.classList.add('selected'); }
				const badge = append(row, $('.ac-item-badge'));
				badge.textContent = item.badgeLabel;
				const nameEl = append(row, $('.ac-item-name'));
				nameEl.textContent = item.name;
				const detailEl = append(row, $('.ac-item-detail'));
				detailEl.textContent = item.detail;
				row.onmousedown = (e) => {
					e.stopPropagation();
					e.preventDefault();
					insertAcItem(item);
				};
			});
		};

		let committed = false;
		const commit = () => {
			if (committed) { return; }
			committed = true;

			const rawExpr = codeArea.value.replace(/\r\n/g, '\n').trim();
			if (!rawExpr) {
				cleanup();
				return;
			}

			// Preserve multiline Python code while extracting top-level (depth-0) targetVariable and functionName
			const assignedVars = WorkflowEditor.extractPythonVariablesFromSource(rawExpr);

			const targetVar = assignedVars[0];
			let fnName = 'PYTHON';
			const singleLineCallMatch = rawExpr.match(/^(?:@?[a-zA-Z0-9_\u4e00-\u9fa5]+\s*=\s*)?([a-zA-Z0-9_]+)\s*\([\s\S]*\)$/);
			if (singleLineCallMatch && !rawExpr.includes('\n')) {
				fnName = singleLineCallMatch[1];
			}

			if (!node.pipeline) { node.pipeline = []; }

			if (existingStep) {
				existingStep.type = 'call_function';
				existingStep.expression = rawExpr;
				existingStep.targetVariable = targetVar;
				existingStep.functionName = fnName;
				existingStep.disabled = isStepDisabled ? true : undefined;
			} else {
				const newStep: INodePipelineStep = {
					id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
					type: 'call_function',
					targetVariable: targetVar,
					functionName: fnName,
					expression: rawExpr,
					disabled: isStepDisabled ? true : undefined
				};
				node.pipeline.push(newStep);
			}

			// Register any assigned variables in node.outputVariables so variable autocomplete & context tracking know about them
			if (assignedVars.length > 0) {
				if (!node.outputVariables) { node.outputVariables = []; }
				for (const vName of assignedVars) {
					const existingVar = node.outputVariables.find(v => v.name.replace(/^@/, '') === vName);
					if (existingVar) {
						existingVar.name = vName;
						existingVar.expression = rawExpr;
					} else {
						node.outputVariables.push({
							name: vName,
							initialValue: 'None',
							expression: rawExpr
						});
					}
				}
			}

			this._syncToNode(node, true);
			this._saveFlowchartData();
			cleanup();
			this._renderNodes();
			this._drawLinks();
			if (this._pipelinePanelEl && this._activePipelineNodeId === node.id) {
				this._renderPipelinePanel(this._pipelinePanelEl, node);
			}
		};

		codeArea.oninput = () => {
			updateAc();
			updateFieldChips();
		};

		const handleKeyDown = (e: KeyboardEvent) => {
			e.stopPropagation();
			if (popover && currentMatches.length > 0) {
				if (e.key === 'ArrowDown') {
					e.preventDefault();
					activeAcIdx = (activeAcIdx + 1) % currentMatches.length;
					updateAc();
					return;
				} else if (e.key === 'ArrowUp') {
					e.preventDefault();
					activeAcIdx = (activeAcIdx - 1 + currentMatches.length) % currentMatches.length;
					updateAc();
					return;
				} else if (e.key === 'Tab') {
					e.preventDefault();
					insertAcItem(currentMatches[activeAcIdx]);
					return;
				} else if (e.key === 'Escape') {
					e.preventDefault();
					closePopover();
					return;
				}
			}

			if (isCommentKeybinding(e)) {
				e.preventDefault();
				e.stopPropagation();
				togglePythonComment(codeArea);
				syncFnBackdrop();
				updateFieldChips();
				return;
			}

			if (e.key === 'Tab') {
				e.preventDefault();
				const start = codeArea.selectionStart ?? 0;
				const end = codeArea.selectionEnd ?? start;
				codeArea.value = codeArea.value.substring(0, start) + '    ' + codeArea.value.substring(end);
				codeArea.selectionStart = codeArea.selectionEnd = start + 4;
				updateFieldChips();
				return;
			}

			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				commit();
				return;
			}

			if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
				e.preventDefault();
				const start = codeArea.selectionStart ?? 0;
				const end = codeArea.selectionEnd ?? start;
				const before = codeArea.value.substring(0, start);
				const after = codeArea.value.substring(end);
				const currentLine = before.split('\n').pop() || '';
				const indentMatch = currentLine.match(/^(\s*)/);
				let indent = indentMatch ? indentMatch[1] : '';
				if (currentLine.trimEnd().endsWith(':')) {
					indent += '    ';
				}
				const ins = '\n' + indent;
				codeArea.value = before + ins + after;
				codeArea.selectionStart = codeArea.selectionEnd = start + ins.length;
				updateFieldChips();
				return;
			}

			if (e.key === 'Escape') {
				e.preventDefault();
				rollbackDisabledIfNeeded();
				cleanup();
			}
		};

		codeArea.onkeydown = handleKeyDown;

		nodeEl.appendChild(draftWrapper);
		disposeDrag = this._setupDraftPopupPositionAndDrag(nodeEl, draftWrapper, headerRow, titleDiv);
		codeArea.focus();
		const quoteIdx = codeArea.value.indexOf('""');
		if (quoteIdx !== -1) {
			codeArea.selectionStart = codeArea.selectionEnd = quoteIdx + 1;
		} else {
			codeArea.select();
		}
	}

	private _parseAndApplyVariableExpression(
		node: IFlowchartNode,
		rawText: string,
		targetVar?: INodeVariable,
		pipelineStep?: INodePipelineStep
	): void {
		const trimmed = rawText.trim();
		if (!trimmed) { return; }

		const vars = this._getNodeVariables(node);

		// Case A: Multiple return / Tuple unpacking: "var1, var2 = @script" or "a, b = expr"
		const unpackMatch = trimmed.match(/^([a-zA-Z0-9_,\s@\u4e00-\u9fa5]+)\s*=\s*(.+)$/);
		if (unpackMatch && unpackMatch[1].includes(',')) {
			const leftNames = unpackMatch[1].split(',').map(s => s.trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_')).filter(Boolean);
			const rightExpr = unpackMatch[2].trim();

			if (targetVar) {
				const idx = vars.indexOf(targetVar);
				if (idx !== -1) { vars.splice(idx, 1); }
			}

			for (let i = 0; i < leftNames.length; i++) {
				const name = leftNames[i];
				const expr = `${rightExpr}[${i}]`;
				vars.push({
					name,
					initialValue: 'None',
					expression: expr
				});
			}
		} else {
			// Case B & C: Single mutation or assignment
			let varName = '';
			let expression: string | undefined = undefined;
			let initialValue: string = 'None';

			const allKnownVars = new Set<string>();
			for (const n of this._data?.nodes || []) {
				for (const kv of this._getNodeVariables(n)) {
					allKnownVars.add(kv.name);
				}
			}
			for (const kv of vars) {
				allKnownVars.add(kv.name);
			}

			const incMatch = trimmed.match(/^@?([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*(\+\+|--)$/);
			const opMatch = trimmed.match(/^@?([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*(\+=|-=|\*=|\/=|%=)\s*([\s\S]+)$/);
			const assignMatch = trimmed.match(/^@?([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*=\s*([\s\S]+)$/);

			if (incMatch) {
				varName = incMatch[1];
				expression = incMatch[2] === '++' ? '+= 1' : '-= 1';
			} else if (opMatch) {
				varName = opMatch[1];
				expression = `${opMatch[2]} ${opMatch[3].trim()}`;
			} else if (assignMatch) {
				varName = assignMatch[1];
				const rhs = assignMatch[2].trim();
				const cleanRhs = rhs.replace(/@([a-zA-Z0-9_\u4e00-\u9fa5]+)/g, '$1');

				// Check if rhs matches an imported ticket on this node or workflow
				const matchingTicket = (node.imports || []).find(imp =>
					imp.name === rhs ||
					imp.name === cleanRhs ||
					imp.name.replace(/[^a-zA-Z0-9_]/g, '_') === cleanRhs ||
					imp.name.toLowerCase() === cleanRhs.toLowerCase() ||
					imp.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase() === cleanRhs.toLowerCase()
				) || (this._data?.nodes || []).flatMap(n => n.imports || []).find(imp =>
					imp.name === rhs ||
					imp.name === cleanRhs ||
					imp.name.replace(/[^a-zA-Z0-9_]/g, '_') === cleanRhs
				);

				const isBuiltinOperatorExpr = /\b(list|dict|set|tuple|date|today|now|datetime|time|timestamp|str|int|float|bool|len|abs|min|max|round)\s*\(/i.test(cleanRhs) ||
					/^(DATE|TODAY|NOW|DATETIME|TIME|TIMESTAMP)$/.test(cleanRhs);

				const isExpression = !!matchingTicket ||
					isBuiltinOperatorExpr ||
					rhs.startsWith('@') ||
					rhs.startsWith('ticket') ||
					rhs.includes('+') || rhs.includes('-') || rhs.includes('*') || rhs.includes('/') || rhs.includes('%') ||
					allKnownVars.has(cleanRhs) ||
					Array.from(allKnownVars).some(v => cleanRhs.includes(v));

				if (matchingTicket) {
					expression = matchingTicket.name;
					initialValue = 'None';
				} else if (isExpression) {
					expression = cleanRhs;
					initialValue = 'None';
				} else {
					const otherNodesWithVar = (this._data?.nodes || []).filter(n => n.id !== node.id && this._getNodeVariables(n).some(ov => ov.name === varName));
					if (otherNodesWithVar.length > 0) {
						expression = cleanRhs;
					} else {
						initialValue = cleanRhs;
						expression = undefined;
					}
				}
			} else if (/^(\+\+|--|\+=|-=|\*=|\/=|%=)/.test(trimmed)) {
				varName = targetVar ? targetVar.name : (vars[vars.length - 1]?.name || this._generateNextVarName());
				expression = trimmed.startsWith('++') ? '+= 1' : (trimmed.startsWith('--') ? '-= 1' : trimmed);
			} else {
				if (targetVar) {
					// User was editing an existing variable targetVar!
					const cleanRhs = trimmed.replace(/@([a-zA-Z0-9_\u4e00-\u9fa5]+)/g, '$1');
					// Check if user is purely renaming the variable (valid identifier without spaces or math operators)
					const isPureIdentifier = /^[a-zA-Z_][a-zA-Z0-9_\u4e00-\u9fa5]*$/.test(trimmed);
					if (isPureIdentifier && !allKnownVars.has(trimmed) && trimmed !== 'ticket' && trimmed !== 'None') {
						varName = trimmed;
						expression = targetVar.expression;
						initialValue = targetVar.initialValue || 'None';
					} else {
						// User provided a RHS value/expression for targetVar (e.g. "monitor1 + monitor2", "100", "@ticket", "DATE()")
						varName = targetVar.name;
						const isBuiltinOp = /\b(list|dict|set|tuple|date|today|now|datetime|time|timestamp|str|int|float|bool|len|abs|min|max|round)\s*\(/i.test(cleanRhs) ||
							/^(DATE|TODAY|NOW|DATETIME|TIME|TIMESTAMP)$/.test(cleanRhs);
						if (isBuiltinOp || trimmed.includes('+') || trimmed.includes('-') || trimmed.includes('*') || trimmed.includes('/') || trimmed.includes('%') ||
							trimmed.startsWith('@') || trimmed.startsWith('ticket') || allKnownVars.has(cleanRhs) || cleanRhs === 'None') {
							expression = cleanRhs;
							initialValue = 'None';
						} else {
							initialValue = cleanRhs;
							expression = undefined;
						}
					}
				} else {
					varName = trimmed.replace(/^@/, '').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_') || this._generateNextVarName();
					initialValue = 'None';
				}
			}

			if (!Array.isArray(node.outputVariables)) {
				node.outputVariables = [];
			}

			if (targetVar) {
				const oldName = targetVar.name.replace(/^@/, '');
				targetVar.name = varName;
				targetVar.expression = expression;
				targetVar.initialValue = initialValue;

				if (pipelineStep) {
					pipelineStep.targetVariable = varName;
					pipelineStep.expression = expression || initialValue;
				} else if (node.pipeline) {
					const step = node.pipeline.find(s => s.type === 'set_variable' && (s.targetVariable?.replace(/^@/, '') === oldName || s.targetVariable?.replace(/^@/, '') === varName));
					if (step) {
						step.targetVariable = varName;
						step.expression = expression || initialValue;
					}
				}

				const outVar = node.outputVariables.find(v => v.name.replace(/^@/, '') === oldName || v.name.replace(/^@/, '') === varName);
				if (outVar) {
					outVar.name = varName;
					outVar.expression = expression;
					outVar.initialValue = initialValue;
				} else {
					node.outputVariables.push({
						name: varName,
						expression,
						initialValue: initialValue || 'None'
					});
				}
			} else {
				// Dragged or added a new variable box into the node:
				const newVarObj: INodeVariable = {
					name: varName,
					initialValue: initialValue || 'None',
					expression
				};
				node.outputVariables.push(newVarObj);

				if (!node.pipeline) {
					node.pipeline = [];
				}
				node.pipeline.push({
					id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
					type: 'set_variable',
					targetVariable: varName,
					expression: expression || initialValue
				});
			}

			// Clear any stale runtime value from previous executions so the new definition displays cleanly
			const activeRun = this._workflowUri ? this._workflowExecutionService.getActiveRun(this._workflowUri) : undefined;
			if (activeRun?.contextVariables) {
				delete activeRun.contextVariables[varName];
			}
		}

		node.outputVariable = node.outputVariables?.[0];
		this._saveFlowchartData();
		this._renderNodes();
		this._drawLinks();
		if (this._inspectorEl) { this._renderInspector(this._inspectorEl); }
		this._refreshVariablesDrawer();
	}

	private _findNonOverlappingPosition(
		initialX: number,
		initialY: number,
		width: number,
		height: number,
		dir: 'right' | 'bottom' | 'left' | 'top',
		excludeNodeId?: string
	): { x: number; y: number } {
		if (!this._data?.nodes || this._data.nodes.length === 0) {
			return { x: initialX, y: initialY };
		}

		let curX = initialX;
		let curY = initialY;
		const margin = 20;
		const maxIterations = 60; // Safeguard against infinite loops

		const isColliding = (x: number, y: number, other: IFlowchartNode): boolean => {
			if (other.id === excludeNodeId) {
				return false;
			}
			const otherW = other.width || 120;
			const otherH = other.height || 50;
			return (
				x < other.x + otherW + margin &&
				x + width + margin > other.x &&
				y < other.y + otherH + margin &&
				y + height + margin > other.y
			);
		};

		for (let i = 0; i < maxIterations; i++) {
			const obstacle = this._data.nodes.find(n => isColliding(curX, curY, n));
			if (!obstacle) {
				break;
			}

			const obstacleW = obstacle.width || 120;
			const obstacleH = obstacle.height || 50;

			// Shift along orthogonal axis according to extension direction
			if (dir === 'right' || dir === 'left') {
				// Horizontal extension -> step down vertically
				curY = obstacle.y + obstacleH + margin;
			} else {
				// Vertical extension -> step right horizontally
				curX = obstacle.x + obstacleW + margin;
			}
		}

		return { x: curX, y: curY };
	}

	private _createChildNode(parent: IFlowchartNode): void {
		if (!this._data || !Array.isArray(this._data.nodes) || !Array.isArray(this._data.links)) {
			return;
		}

		const dir = this._activeBranchDirection || 'right';

		// Find existing direct child nodes connected from parent in this direction
		const childLinks = this._data.links.filter(l => l.from === parent.id);
		const existingChildren = childLinks
			.map(l => this._data.nodes.find(n => n.id === l.to))
			.filter(Boolean) as IFlowchartNode[];

		const horizontalGap = 80;
		const verticalGap = 40;
		const nodeW = parent.width || 120;
		const nodeH = parent.height || 50;

		let childX = parent.x;
		let childY = parent.y;
		let fromPort: 'right' | 'bottom' | 'left' | 'top' = 'right';
		let toPort: 'right' | 'bottom' | 'left' | 'top' = 'left';

		if (dir === 'right') {
			fromPort = 'right';
			toPort = 'left';
			childX = parent.x + nodeW + horizontalGap;
			const rightChildren = existingChildren.filter(c => c.x > parent.x);
			if (rightChildren.length > 0) {
				const maxBottom = Math.max(...rightChildren.map(c => c.y + (c.height || 50)));
				childY = maxBottom + 20;
			} else {
				childY = parent.y;
			}
		} else if (dir === 'bottom') {
			fromPort = 'bottom';
			toPort = 'top';
			childY = parent.y + nodeH + verticalGap;
			const bottomChildren = existingChildren.filter(c => c.y > parent.y);
			if (bottomChildren.length > 0) {
				const maxRight = Math.max(...bottomChildren.map(c => c.x + (c.width || 120)));
				childX = maxRight + 20;
			} else {
				childX = parent.x;
			}
		} else if (dir === 'left') {
			fromPort = 'left';
			toPort = 'right';
			childX = parent.x - nodeW - horizontalGap;
			const leftChildren = existingChildren.filter(c => c.x < parent.x);
			if (leftChildren.length > 0) {
				const maxBottom = Math.max(...leftChildren.map(c => c.y + (c.height || 50)));
				childY = maxBottom + 20;
			} else {
				childY = parent.y;
			}
		} else if (dir === 'top') {
			fromPort = 'top';
			toPort = 'bottom';
			childY = parent.y - nodeH - verticalGap;
			const topChildren = existingChildren.filter(c => c.y < parent.y);
			if (topChildren.length > 0) {
				const maxRight = Math.max(...topChildren.map(c => c.x + (c.width || 120)));
				childX = maxRight + 20;
			} else {
				childX = parent.x;
			}
		}

		// Smart collision avoidance against all existing canvas nodes
		const safePos = this._findNonOverlappingPosition(childX, childY, nodeW, nodeH, dir, parent.id);
		childX = safePos.x;
		childY = safePos.y;

		const newId = `node_${Date.now()}`;
		const newChild: IFlowchartNode = {
			id: newId,
			type: parent.type || 'round-rect',
			x: childX,
			y: childY,
			width: nodeW,
			height: nodeH,
			label: 'New Node',
			color: parent.color || this._activeNodeColor,
			textColor: parent.textColor || this._activeTextColor,
			textAlign: parent.textAlign || this._activeTextAlign,
			verticalAlign: parent.verticalAlign || this._activeVerticalAlign,
			isBold: typeof parent.isBold === 'boolean' ? parent.isBold : this._activeIsBold,
			isItalic: typeof parent.isItalic === 'boolean' ? parent.isItalic : this._activeIsItalic,
			isUnderline: typeof parent.isUnderline === 'boolean' ? parent.isUnderline : this._activeIsUnderline,
			isStrikethrough: typeof parent.isStrikethrough === 'boolean' ? parent.isStrikethrough : this._activeIsStrikethrough
		};

		const newLink: IFlowchartLink = {
			id: `link_${Date.now()}`,
			from: parent.id,
			fromPort: fromPort,
			to: newId,
			toPort: toPort,
			style: this._activeLinkStyle || 'arrow-single',
			routing: this._activeRoutingMode || 'orthogonal',
			color: parent.color || this._activeLineColor || '#0d9488'
		};

		this._data.nodes.push(newChild);
		this._data.links.push(newLink);
		this._saveFlowchartData();

		this._selectedNodeIds.clear();
		this._selectedLinkIds.clear();
		this._selectedNodeIds.add(newId);

		this._renderNodes();
		this._drawLinks();

		if (this._inspectorEl) {
			this._renderInspector(this._inspectorEl);
		}

		this._updateCanvasDimensions(childX + nodeW, childY + nodeH);

		setTimeout(() => {
			if (this._nodesContainer) {
				const newNodeEl = this._getNodeDom(newId)?.nodeEl;
				if (newNodeEl) {
					this._showInlineEditor(newNodeEl, newChild);
				}
			}
			const wrapper = this._canvas?.closest('.workflow-editor-canvas-wrapper') as HTMLElement;
			if (wrapper) {
				const nodeScreenLeft = childX * this._zoomLevel;
				const nodeScreenTop = childY * this._zoomLevel;
				const nodeScreenRight = (childX + nodeW) * this._zoomLevel;
				const nodeScreenBottom = (childY + nodeH) * this._zoomLevel;

				if (nodeScreenRight > wrapper.scrollLeft + wrapper.clientWidth - 40) {
					wrapper.scrollTo({ left: nodeScreenRight - wrapper.clientWidth + 120, behavior: 'smooth' });
				} else if (nodeScreenLeft < wrapper.scrollLeft + 40) {
					wrapper.scrollTo({ left: Math.max(0, nodeScreenLeft - 100), behavior: 'smooth' });
				}
				if (nodeScreenBottom > wrapper.scrollTop + wrapper.clientHeight - 40) {
					wrapper.scrollTo({ top: nodeScreenBottom - wrapper.clientHeight + 120, behavior: 'smooth' });
				} else if (nodeScreenTop < wrapper.scrollTop + 40) {
					wrapper.scrollTo({ top: Math.max(0, nodeScreenTop - 100), behavior: 'smooth' });
				}
			}
		}, 60);
	}

	private _createSiblingNode(current: IFlowchartNode): void {
		if (!this._data || !Array.isArray(this._data.nodes) || !Array.isArray(this._data.links)) {
			return;
		}

		const dir = this._activeBranchDirection || 'right';
		const verticalGap = 40;
		const horizontalGap = 40;
		const nodeW = current.width || 120;
		const nodeH = current.height || 50;

		let siblingX = current.x;
		let siblingY = current.y;

		if (dir === 'right') {
			siblingX = current.x + nodeW + horizontalGap;
			siblingY = current.y;
		} else if (dir === 'bottom') {
			siblingX = current.x;
			siblingY = current.y + nodeH + verticalGap;
		} else if (dir === 'left') {
			siblingX = Math.max(20, current.x - nodeW - horizontalGap);
			siblingY = current.y;
		} else if (dir === 'top') {
			siblingX = current.x;
			siblingY = Math.max(20, current.y - nodeH - verticalGap);
		}

		// Step along the active direction `dir` to avoid overlapping any existing node on canvas
		const margin = 20;
		for (let i = 0; i < 60; i++) {
			const obstacle = this._data.nodes.find(other => {
				if (other.id === current.id) {
					return false;
				}
				const otherW = other.width || 120;
				const otherH = other.height || 50;
				return (
					siblingX < other.x + otherW + margin &&
					siblingX + nodeW + margin > other.x &&
					siblingY < other.y + otherH + margin &&
					siblingY + nodeH + margin > other.y
				);
			});
			if (!obstacle) {
				break;
			}
			const obstacleW = obstacle.width || 120;
			const obstacleH = obstacle.height || 50;
			if (dir === 'right') {
				siblingX = obstacle.x + obstacleW + horizontalGap;
			} else if (dir === 'bottom') {
				siblingY = obstacle.y + obstacleH + verticalGap;
			} else if (dir === 'left') {
				if (obstacle.x - nodeW - horizontalGap >= 20) {
					siblingX = obstacle.x - nodeW - horizontalGap;
				} else {
					siblingY = obstacle.y + obstacleH + verticalGap;
				}
			} else if (dir === 'top') {
				if (obstacle.y - nodeH - verticalGap >= 20) {

					siblingY = obstacle.y - nodeH - verticalGap;
				} else {
					siblingX = obstacle.x + obstacleW + horizontalGap;
				}
			}
		}

		const newId = `node_${Date.now()}`;
		const newSibling: IFlowchartNode = {
			id: newId,
			type: current.type || 'round-rect',
			x: siblingX,
			y: siblingY,
			width: nodeW,
			height: nodeH,
			label: 'New Node',
			color: current.color || this._activeNodeColor,
			textColor: current.textColor || this._activeTextColor,
			textAlign: current.textAlign || this._activeTextAlign,
			verticalAlign: current.verticalAlign || this._activeVerticalAlign,
			isBold: typeof current.isBold === 'boolean' ? current.isBold : this._activeIsBold,
			isItalic: typeof current.isItalic === 'boolean' ? current.isItalic : this._activeIsItalic,
			isUnderline: typeof current.isUnderline === 'boolean' ? current.isUnderline : this._activeIsUnderline,
			isStrikethrough: typeof current.isStrikethrough === 'boolean' ? current.isStrikethrough : this._activeIsStrikethrough
		};

		this._data.nodes.push(newSibling);

		this._saveFlowchartData();

		this._selectedNodeIds.clear();
		this._selectedLinkIds.clear();
		this._selectedNodeIds.add(newId);

		this._renderNodes();
		this._drawLinks();

		if (this._inspectorEl) {
			this._renderInspector(this._inspectorEl);
		}

		this._updateCanvasDimensions(siblingX + (current.width || 120), siblingY + (current.height || 50));

		setTimeout(() => {
			if (this._nodesContainer) {
				const newNodeEl = this._getNodeDom(newId)?.nodeEl;
				if (newNodeEl) {
					this._showInlineEditor(newNodeEl, newSibling);
				}
			}
			const wrapper = this._canvas?.closest('.workflow-editor-canvas-wrapper') as HTMLElement;
			if (wrapper) {
				const nodeScreenLeft = siblingX * this._zoomLevel;
				const nodeScreenTop = siblingY * this._zoomLevel;
				const nodeScreenRight = (siblingX + (current.width || 120)) * this._zoomLevel;
				const nodeScreenBottom = (siblingY + (current.height || 50)) * this._zoomLevel;

				if (nodeScreenRight > wrapper.scrollLeft + wrapper.clientWidth - 40) {
					wrapper.scrollTo({ left: nodeScreenRight - wrapper.clientWidth + 120, behavior: 'smooth' });
				} else if (nodeScreenLeft < wrapper.scrollLeft + 40) {
					wrapper.scrollTo({ left: Math.max(0, nodeScreenLeft - 100), behavior: 'smooth' });
				}
				if (nodeScreenBottom > wrapper.scrollTop + wrapper.clientHeight - 40) {
					wrapper.scrollTo({ top: nodeScreenBottom - wrapper.clientHeight + 120, behavior: 'smooth' });
				} else if (nodeScreenTop < wrapper.scrollTop + 40) {
					wrapper.scrollTo({ top: Math.max(0, nodeScreenTop - 100), behavior: 'smooth' });
				}
			}
		}, 60);
	}

	private _addNewNode(type: IFlowchartNode['type'], label: string): void {
		// Calculate position in center of visible viewport
		let x = 300;
		let y = 200;
		if (this._canvas && this._canvas.parentElement) {
			const scrollLeft = this._canvas.parentElement.scrollLeft;
			const scrollTop = this._canvas.parentElement.scrollTop;
			x = scrollLeft + 150 + Math.random() * 50;
			y = scrollTop + 100 + Math.random() * 50;
		}

		const id = `node_${Date.now()}`;
		let width = 100;
		let height = 50;
		if (type === 'circle') {
			width = 60;
			height = 60;
		} else if (type === 'diamond') {
			width = 110;
			height = 80;
		}

		const newNode: IFlowchartNode = {
			id,
			type,
			x,
			y,
			width,
			height,
			label,
			color: this._activeNodeColor,
			textColor: this._activeTextColor,
			textAlign: this._activeTextAlign,
			verticalAlign: this._activeVerticalAlign,
			isBold: this._activeIsBold,
			isItalic: this._activeIsItalic,
			isUnderline: this._activeIsUnderline,
			isStrikethrough: this._activeIsStrikethrough
		};

		this._data.nodes.push(newNode);
		this._selectedNodeIds.clear();
		this._selectedNodeIds.add(id);
		this._saveFlowchartData();

		this._renderNodes();
		this._drawLinks();
	}

	private _addNewNodeAt(type: IFlowchartNode['type'], label: string, x: number, y: number): void {
		const id = `node_${Date.now()}`;
		let width = 100;
		let height = 50;
		if (type === 'circle') {
			width = 60;
			height = 60;
		} else if (type === 'diamond') {
			width = 110;
			height = 80;
		}

		const adjustedX = x - width / 2;
		const adjustedY = y - height / 2;

		const newNode: IFlowchartNode = {
			id,
			type,
			x: Math.max(10, adjustedX),
			y: Math.max(10, adjustedY),
			width,
			height,
			label,
			color: this._activeNodeColor,
			textColor: this._activeTextColor,
			textAlign: this._activeTextAlign,
			verticalAlign: this._activeVerticalAlign,
			isBold: this._activeIsBold,
			isItalic: this._activeIsItalic,
			isUnderline: this._activeIsUnderline,
			isStrikethrough: this._activeIsStrikethrough
		};

		this._data.nodes.push(newNode);
		this._selectedNodeIds.clear();
		this._selectedNodeIds.add(id);
		this._saveFlowchartData();

		this._renderNodes();
		this._drawLinks();
	}

	private _generateNextVarName(): string {
		const existingNames = new Set<string>();
		for (const node of this._data?.nodes || []) {
			for (const v of this._getNodeVariables(node)) {
				existingNames.add(v.name);
			}
		}
		let idx = 1;
		while (existingNames.has(`var_${idx}`) || existingNames.has(`result_${idx}`)) {
			idx++;
		}
		return `var_${idx}`;
	}

	private _bindVariableToNode(targetNode: IFlowchartNode, varName?: string, initialValue: string = 'None'): void {
		const vars = this._getNodeVariables(targetNode);
		const name = varName || this._generateNextVarName();
		const existing = vars.find(v => v.name === name);
		if (existing) {
			existing.initialValue = initialValue || 'None';
		} else {
			vars.push({
				name,
				initialValue: initialValue || 'None'
			});
		}
		targetNode.outputVariables = vars;
		targetNode.outputVariable = vars[0];
		this._saveFlowchartData();
		this._renderNodes();
		this._drawLinks();
		if (this._inspectorEl) {
			this._renderInspector(this._inspectorEl);
		}
		this._refreshVariablesDrawer();
		this._notificationService.info(localize('varBound', "Bound context variable '{0}' (initial: {1}) to node '{2}'.", name, initialValue, targetNode.label));
	}

	private _drawTempLink(
		x1: number,
		y1: number,
		x2: number,
		y2: number,
		fromPort: 'top' | 'right' | 'bottom' | 'left' = 'right',
		toPort?: 'top' | 'right' | 'bottom' | 'left'
	): void {
		if (!this._svgOverlay) { return; }
		let tempLine = this._getTempLinkLine();
		if (!tempLine) {
			tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			this._tempLinkLine = tempLine;
			tempLine.setAttribute('id', 'workflow-temp-line');
			tempLine.classList.add('workflow-connection-line');
			this._connectionLineEls.add(tempLine);
			tempLine.style.strokeDasharray = '5 4';
			tempLine.style.stroke = '#22d3ee';
			tempLine.style.strokeWidth = '2.5px';
			if (this._activeLinkStyle === 'arrow-single' || this._activeLinkStyle === 'arrow-double') {
				tempLine.setAttribute('marker-end', 'url(#arrow)');
			}
			this._svgOverlay.appendChild(tempLine);
		}

		if (!toPort) {
			if (fromPort === 'right') {
				toPort = x2 >= x1 ? 'left' : 'right';
			} else if (fromPort === 'left') {
				toPort = x2 <= x1 ? 'right' : 'left';
			} else if (fromPort === 'bottom') {
				toPort = y2 >= y1 ? 'top' : 'bottom';
			} else if (fromPort === 'top') {
				toPort = y2 <= y1 ? 'bottom' : 'top';
			} else {
				toPort = 'left';
			}
		}

		const d = this._getLinkPathData(x1, y1, fromPort, x2, y2, toPort, this._activeRoutingMode);
		tempLine.setAttribute('d', d);
	}

	/** The `#workflow-temp-line` path currently in `_svgOverlay`, if any. */
	private _getTempLinkLine(): SVGPathElement | undefined {
		return this._tempLinkLine && this._svgOverlay?.contains(this._tempLinkLine) ? this._tempLinkLine : undefined;
	}

	private _clearTempLink(): void {
		if (!this._svgOverlay) { return; }
		const tempLine = this._getTempLinkLine();
		if (tempLine) {
			tempLine.remove();
			this._connectionLineEls.delete(tempLine);
		}
	}

	private _onMouseMove(e: MouseEvent): void {
		if (this._isDrawerResizing && this._logDrawerEl) {
			const dy = this._drawerResizeStartY - e.clientY;
			const parentHeight = this._logDrawerEl.parentElement?.clientHeight || this._targetWindow.innerHeight;
			const maxHeight = Math.max(200, parentHeight - 60);
			const newHeight = Math.min(maxHeight, Math.max(100, this._drawerResizeStartHeight + dy));
			this._drawerHeight = newHeight;
			this._logDrawerEl.style.height = `${newHeight}px`;
			return;
		}

		if (this._isResizingLinkLabel) {
			const link = this._data.links.find(l => l.id === this._isResizingLinkLabel);
			if (link) {
				const dw = (e.clientX - this._resizeLinkLabelStartX) / this._zoomLevel;
				const dh = (e.clientY - this._resizeLinkLabelStartY) / this._zoomLevel;
				link.labelWidth = Math.max(36, Math.round(this._resizeLinkLabelStartWidth + dw));
				link.labelHeight = Math.max(20, Math.round(this._resizeLinkLabelStartHeight + dh));

				const labelEl = this._getLinkLabelEl(link.id);
				if (labelEl) {
					labelEl.style.width = `${link.labelWidth}px`;
					labelEl.style.maxWidth = 'none';
					labelEl.style.height = `${link.labelHeight}px`;
					labelEl.style.maxHeight = 'none';
				}
			}
			return;
		}

		if (this._isDraggingLinkLabel) {
			if (!this._dragLabelHasMoved && Math.hypot(e.clientX - this._dragLabelStartX, e.clientY - this._dragLabelStartY) > 3) {
				this._dragLabelHasMoved = true;
			}
			const link = this._data.links.find(l => l.id === this._isDraggingLinkLabel);
			if (link && this._canvas) {
				const rect = this._canvas.getBoundingClientRect();
				const mouseX = (e.clientX - rect.left) / this._zoomLevel;
				const mouseY = (e.clientY - rect.top) / this._zoomLevel;

				const t = this._findClosestTOnLink(link, mouseX, mouseY);
				link.labelPosition = t;

				const fromNode = this._data.nodes.find(n => n.id === link.from);
				const toNode = this._data.nodes.find(n => n.id === link.to);
				if (fromNode && toNode) {
					const closest = this._getClosestPorts(fromNode, toNode);
					const fromPort = link.fromPort || closest.fromPort;
					const toPort = link.toPort || closest.toPort;
					const startCoords = this._getPortCoords(fromNode, fromPort);
					const endCoords = this._getPortCoords(toNode, toPort);
					const routingMode = link.routing || this._activeRoutingMode || 'orthogonal';
					const pt = this._computePointFromCoords(startCoords.x, startCoords.y, fromPort, endCoords.x, endCoords.y, toPort, routingMode, t, link.waypoints);

					const labelEl = this._getLinkLabelEl(link.id);
					if (labelEl) {
						labelEl.style.left = `${pt.x}px`;
						labelEl.style.top = `${pt.y}px`;
					}
				}
			}
			return;
		}

		if (this._isDraggingLinkSegment) {
			const dxClient = e.clientX - this._dragLinkSegmentStartX;
			const dyClient = e.clientY - this._dragLinkSegmentStartY;
			if (!this._dragLinkSegmentHasMoved && Math.hypot(dxClient, dyClient) > 3) {
				this._dragLinkSegmentHasMoved = true;
			}
			if (!this._dragLinkSegmentHasMoved) {
				return;
			}

			const link = this._data.links.find(l => l.id === this._isDraggingLinkSegment);
			if (link && this._canvas) {
				const fromNode = this._data.nodes.find(n => n.id === link.from);
				const toNode = this._data.nodes.find(n => n.id === link.to);
				if (fromNode && toNode) {
					const closest = this._getClosestPorts(fromNode, toNode);
					const fromPort = link.fromPort || closest.fromPort;
					const toPort = link.toPort || closest.toPort;

					if (!this._dragLinkSegmentPrepared) {
						let chosenIdx = this._dragLinkSegmentInitialIndex;
						const basePts = this._dragLinkSegmentWaypoints;
						if (chosenIdx >= 0 && chosenIdx < basePts.length - 1) {
							const pA = basePts[chosenIdx];
							const pB = basePts[chosenIdx + 1];
							const segIsVert = Math.abs(pA.x - pB.x) <= Math.abs(pA.y - pB.y);
							const wantHorizontalMove = Math.abs(dxClient) >= Math.abs(dyClient);
							if (segIsVert !== wantHorizontalMove) {
								const candidates: { idx: number; dist: number }[] = [];
								if (chosenIdx - 1 >= 0) {
									const distPrev = Math.hypot(this._dragLinkSegmentCanvasX - pA.x, this._dragLinkSegmentCanvasY - pA.y);
									candidates.push({ idx: chosenIdx - 1, dist: distPrev });
								}
								if (chosenIdx + 1 < basePts.length - 1) {
									const distNext = Math.hypot(this._dragLinkSegmentCanvasX - pB.x, this._dragLinkSegmentCanvasY - pB.y);
									candidates.push({ idx: chosenIdx + 1, dist: distNext });
								}
								candidates.sort((a, b) => a.dist - b.dist);
								if (candidates.length > 0 && candidates[0].dist <= 80) {
									chosenIdx = candidates[0].idx;
								}
							}
						}
						const prep = this._prepareSegmentDragWaypoints(basePts, chosenIdx, fromPort, toPort);
						this._dragLinkSegmentWaypoints = prep.pts;
						this._dragLinkSegmentIndex = prep.segIdx;
						this._dragLinkSegmentIsVertical = prep.isVertical;
						this._dragLinkSegmentPrepared = true;
					}

					const rect = this._canvas.getBoundingClientRect();
					const mouseX = (e.clientX - rect.left) / this._zoomLevel;
					const mouseY = (e.clientY - rect.top) / this._zoomLevel;
					const grid = 5;
					const snappedX = Math.round(mouseX / grid) * grid;
					const snappedY = Math.round(mouseY / grid) * grid;

					const pts = this._dragLinkSegmentWaypoints.map(p => ({ x: p.x, y: p.y }));
					const idx = this._dragLinkSegmentIndex;
					if (idx >= 0 && idx < pts.length - 1) {
						if (this._dragLinkSegmentIsVertical) {
							pts[idx].x = snappedX;
							pts[idx + 1].x = snappedX;
						} else {
							pts[idx].y = snappedY;
							pts[idx + 1].y = snappedY;
						}
						link.waypoints = pts.slice(1, -1);
						this._drawLinks();
					}
				}
			}
			return;
		}

		if (this._isConnecting && this._tempLinkStartX !== null && this._tempLinkStartY !== null) {
			const rect = this._canvas!.getBoundingClientRect();
			const currentX = (e.clientX - rect.left) / this._zoomLevel;
			const currentY = (e.clientY - rect.top) / this._zoomLevel;
			const fromPort = this._tempLinkFromPort || 'right';

			// Check for target node snapping (ONLY visible nodes; prefer directly hovered DOM node first)
			let snapNode: IFlowchartNode | undefined;
			let directPort: 'top' | 'right' | 'bottom' | 'left' | undefined;
			const hoveredTarget = e.target as HTMLElement | null;
			const hoveredPortEl = hoveredTarget?.closest('.node-port-handle') as HTMLElement | null;
			const hoveredNodeEl = hoveredTarget?.closest('.workflow-node') as HTMLElement | null;
			if (hoveredNodeEl) {
				const hoveredNodeId = hoveredNodeEl.getAttribute('data-node-id');
				if (hoveredNodeId && hoveredNodeId !== this._tempLinkFromNodeId) {
					snapNode = this._data.nodes.find(n => n.id === hoveredNodeId);
					if (snapNode && hoveredPortEl) {
						const classes = Array.from(hoveredPortEl.classList);
						directPort = classes.find(c => ['top', 'right', 'bottom', 'left'].includes(c)) as IFlowchartLink['fromPort'];
					}
				}
			}

			if (!snapNode) {
				let bestNodeDist = Infinity;
				for (const node of this._data.nodes) {
					if (node.id === this._tempLinkFromNodeId) { continue; }
					// Detect if cursor is near or inside visible target node bounding box
					if (currentX >= node.x - 24 && currentX <= node.x + node.width + 24 &&
						currentY >= node.y - 24 && currentY <= node.y + node.height + 24) {
						const cx = node.x + node.width / 2;
						const cy = node.y + node.height / 2;
						const d = Math.hypot(currentX - cx, currentY - cy);
						if (d < bestNodeDist) {
							bestNodeDist = d;
							snapNode = node;
						}
					}
				}
			}

			if (snapNode) {
				let snapPort: 'top' | 'right' | 'bottom' | 'left' = directPort || 'left';
				if (!directPort) {
					const ports: ('top' | 'right' | 'bottom' | 'left')[] = ['left', 'right', 'top', 'bottom'];
					let minDistance = Infinity;
					for (const p of ports) {
						const coords = this._getPortCoords(snapNode, p);
						const dist = Math.hypot(currentX - coords.x, currentY - coords.y);
						if (dist < minDistance) {
							minDistance = dist;
							snapPort = p;
						}
					}
				}

				const endCoords = this._getPortCoords(snapNode, snapPort);
				this._drawTempLink(this._tempLinkStartX, this._tempLinkStartY, endCoords.x, endCoords.y, fromPort, snapPort);
			} else {
				let naturalToPort: 'top' | 'right' | 'bottom' | 'left' = 'left';
				if (fromPort === 'right') {
					naturalToPort = currentX >= this._tempLinkStartX ? 'left' : 'right';
				} else if (fromPort === 'left') {
					naturalToPort = currentX <= this._tempLinkStartX ? 'right' : 'left';
				} else if (fromPort === 'bottom') {
					naturalToPort = currentY >= this._tempLinkStartY ? 'top' : 'bottom';
				} else if (fromPort === 'top') {
					naturalToPort = currentY <= this._tempLinkStartY ? 'bottom' : 'top';
				}
				this._drawTempLink(this._tempLinkStartX, this._tempLinkStartY, currentX, currentY, fromPort, naturalToPort);
			}
			return;
		}

		if (this._isReconnectingStart && this._tempLinkFixedX !== null && this._tempLinkFixedY !== null) {
			const rect = this._canvas!.getBoundingClientRect();
			const currentX = (e.clientX - rect.left) / this._zoomLevel;
			const currentY = (e.clientY - rect.top) / this._zoomLevel;
			const reconnLink = this._data.links.find(l => l.id === this._isReconnectingStart);
			const fixedToPort = reconnLink?.toPort || 'left';
			const naturalFromPort: 'top' | 'right' | 'bottom' | 'left' =
				Math.abs(this._tempLinkFixedX - currentX) >= Math.abs(this._tempLinkFixedY - currentY)
					? (currentX <= this._tempLinkFixedX ? 'right' : 'left')
					: (currentY <= this._tempLinkFixedY ? 'bottom' : 'top');
			this._drawTempLink(currentX, currentY, this._tempLinkFixedX, this._tempLinkFixedY, naturalFromPort, fixedToPort);
			return;
		}

		if (this._isReconnectingEnd && this._tempLinkFixedX !== null && this._tempLinkFixedY !== null) {
			const rect = this._canvas!.getBoundingClientRect();
			const currentX = (e.clientX - rect.left) / this._zoomLevel;
			const currentY = (e.clientY - rect.top) / this._zoomLevel;
			const reconnLink = this._data.links.find(l => l.id === this._isReconnectingEnd);
			const fixedFromPort = reconnLink?.fromPort || 'right';
			let naturalToPort: 'top' | 'right' | 'bottom' | 'left' = 'left';
			if (fixedFromPort === 'right') {
				naturalToPort = currentX >= this._tempLinkFixedX ? 'left' : 'right';
			} else if (fixedFromPort === 'left') {
				naturalToPort = currentX <= this._tempLinkFixedX ? 'right' : 'left';
			} else if (fixedFromPort === 'bottom') {
				naturalToPort = currentY >= this._tempLinkFixedY ? 'top' : 'bottom';
			} else if (fixedFromPort === 'top') {
				naturalToPort = currentY <= this._tempLinkFixedY ? 'bottom' : 'top';
			}
			this._drawTempLink(this._tempLinkFixedX, this._tempLinkFixedY, currentX, currentY, fixedFromPort, naturalToPort);
			return;
		}

		if (this._isResizing && this._resizeNodeId) {
			const node = this._data.nodes.find(n => n.id === this._resizeNodeId);
			if (node) {
				const dw = (e.clientX - this._resizeStartX) / this._zoomLevel;
				const dh = (e.clientY - this._resizeStartY) / this._zoomLevel;
				const grid = 5;

				node.width = Math.max(40, Math.round((this._resizeStartWidth + dw) / grid) * grid);
				node.height = Math.max(30, Math.round((this._resizeStartHeight + dh) / grid) * grid);

				// Dynamically update size in DOM by data-node-id (safe even when Sub-Workflow nodes are hidden)
				const nodeEl = this._getNodeDom(node.id)?.nodeEl;
				if (nodeEl) {
					nodeEl.style.width = `${node.width}px`;
					nodeEl.style.height = `${node.height}px`;
				}

				this._drawLinks();
			}
			return;
		}

		if (this._isSelectingBox && this._selectionBoxEl) {
			const rect = this._canvas!.getBoundingClientRect();
			const currentX = (e.clientX - rect.left) / this._zoomLevel;
			const currentY = (e.clientY - rect.top) / this._zoomLevel;

			const x_start = Math.min(this._selectBoxStartX, currentX);
			const y_start = Math.min(this._selectBoxStartY, currentY);
			const width = Math.abs(this._selectBoxStartX - currentX);
			const height = Math.abs(this._selectBoxStartY - currentY);

			this._selectionBoxEl.style.left = `${x_start}px`;
			this._selectionBoxEl.style.top = `${y_start}px`;
			this._selectionBoxEl.style.width = `${width}px`;
			this._selectionBoxEl.style.height = `${height}px`;

			// Calculate overlapping nodes (preserve base selection when Shift/Ctrl/Cmd was held, and order newly boxed nodes top-to-bottom)
			this._selectedNodeIds.clear();
			for (const baseId of this._selectBoxBaseNodeIds) {
				this._selectedNodeIds.add(baseId);
			}
			const overlappingNodes = this._data.nodes.filter(node =>
				!(node.x + node.width < x_start ||
					node.x > x_start + width ||
					node.y + node.height < y_start ||
					node.y > y_start + height)
			).sort((a, b) => (a.y - b.y) || (a.x - b.x));
			for (const node of overlappingNodes) {
				this._selectedNodeIds.add(node.id);
			}

			// Calculate overlapping links (midpoint overlaps)
			this._selectedLinkIds.clear();
			for (const baseLinkId of this._selectBoxBaseLinkIds) {
				this._selectedLinkIds.add(baseLinkId);
			}
			for (const link of this._data.links) {
				const fromNode = this._data.nodes.find(n => n.id === link.from);
				const toNode = this._data.nodes.find(n => n.id === link.to);
				if (fromNode && toNode) {
					const midX = (fromNode.x + fromNode.width / 2 + toNode.x + toNode.width / 2) / 2;
					const midY = (fromNode.y + fromNode.height / 2 + toNode.y + toNode.height / 2) / 2;
					if (midX >= x_start && midX <= x_start + width && midY >= y_start && midY <= y_start + height) {
						this._selectedLinkIds.add(link.id);
					}
				}
			}

			this._renderNodes();
			this._drawLinks();
			return;
		}

		if (this._isDragging && this._dragNodeId) {
			const dx = (e.clientX - this._dragStartX) / this._zoomLevel;
			const dy = (e.clientY - this._dragStartY) / this._zoomLevel;
			const grid = 5;

			const deltaX = Math.round(dx / grid) * grid;
			const deltaY = Math.round(dy / grid) * grid;

			let needExpand = false;
			let maxNodeRight = 0;
			let maxNodeBottom = 0;

			// Update positions of all dragged nodes
			for (const [nid, startPos] of this._draggedNodesStartPos) {
				const node = this._data.nodes.find(item => item.id === nid);
				if (node) {
					node.x = Math.max(10, startPos.x + deltaX);
					node.y = Math.max(10, startPos.y + deltaY);

					const right = node.x + (node.width || 120);
					const bottom = node.y + (node.height || 50);
					if (right > this._currentCanvasWidth - 400) {
						needExpand = true;
						maxNodeRight = Math.max(maxNodeRight, right);
					}
					if (bottom > this._currentCanvasHeight - 400) {
						needExpand = true;
						maxNodeBottom = Math.max(maxNodeBottom, bottom);
					}

					// Dynamically update position in DOM by data-node-id (instant 1:1 tracking even when Sub-Workflow nodes are hidden)
					const nodeEl = this._getNodeDom(node.id)?.nodeEl;
					if (nodeEl) {
						nodeEl.style.left = `${node.x}px`;
						nodeEl.style.top = `${node.y}px`;
					}
				}
			}

			if (needExpand) {
				this._updateCanvasDimensions(maxNodeRight, maxNodeBottom);
			}

			this._drawLinks();
			return;
		}
	}

	private _onMouseUp(e: MouseEvent): void {
		if (this._isResizingLinkLabel) {
			this._isResizingLinkLabel = null;
			this._saveFlowchartData();
			this._drawLinks();
			return;
		}

		if (this._isDraggingLinkSegment) {
			const linkId = this._isDraggingLinkSegment;
			const hasMoved = this._dragLinkSegmentHasMoved;
			this._isDraggingLinkSegment = null;
			this._dragLinkSegmentHasMoved = false;
			this._dragLinkSegmentPrepared = false;
			this._dragLinkSegmentWaypoints = [];

			if (hasMoved) {
				this._saveFlowchartData();
				this._drawLinks();
			} else {
				const isMultiKey = e && (e.shiftKey || e.ctrlKey || e.metaKey);
				if (!isMultiKey) {
					this._selectedLinkIds.clear();
					this._selectedNodeIds.clear();
					this._selectedLinkIds.add(linkId);
				} else {
					if (this._selectedLinkIds.has(linkId)) {
						this._selectedLinkIds.delete(linkId);
					} else {
						this._selectedLinkIds.add(linkId);
					}
				}
				this._isInspectorCollapsed = false;
				this._inspectorEl?.classList.remove('collapsed');
				this._inspectorTogglePill?.classList.add('hidden');
				this._renderNodes();
				this._drawLinks();
				if (this._inspectorEl) {
					this._renderInspector(this._inspectorEl);
				}
			}
			return;
		}

		if (this._isDraggingLinkLabel) {
			const linkId = this._isDraggingLinkLabel;
			const hasMoved = this._dragLabelHasMoved;
			this._isDraggingLinkLabel = null;
			this._dragLabelHasMoved = false;

			const labelEl = this._getLinkLabelEl(linkId);
			if (labelEl) {
				labelEl.classList.remove('dragging');
			}

			if (hasMoved) {
				this._saveFlowchartData();
				this._drawLinks();
			}
			return;
		}

		if (this._isConnecting) {
			this._isConnecting = false;
			this._clearTempLink();

			if (e) {
				const targetPortEl = (e.target as HTMLElement).closest('.node-port-handle');
				const targetNodeEl = (e.target as HTMLElement).closest('.workflow-node');
				let targetNode: IFlowchartNode | undefined;
				let toPort: 'top' | 'right' | 'bottom' | 'left' | undefined;

				if (targetNodeEl) {
					const targetNodeId = targetNodeEl.getAttribute('data-node-id');
					if (targetNodeId) {
						targetNode = this._data.nodes.find(n => n.id === targetNodeId);
					}
				}

				// If not dropped directly on DOM node, check coordinate-based proximity snapping (within 24px, ONLY visible nodes)
				if (!targetNode && this._canvas) {
					const rect = this._canvas.getBoundingClientRect();
					const upX = (e.clientX - rect.left) / this._zoomLevel;
					const upY = (e.clientY - rect.top) / this._zoomLevel;
					let bestDist = Infinity;
					for (const n of this._data.nodes) {
						if (n.id === this._tempLinkFromNodeId) { continue; }
						if (upX >= n.x - 24 && upX <= n.x + n.width + 24 &&
							upY >= n.y - 24 && upY <= n.y + n.height + 24) {
							const d = Math.hypot(upX - (n.x + n.width / 2), upY - (n.y + n.height / 2));
							if (d < bestDist) {
								bestDist = d;
								targetNode = n;
							}
						}
					}
				}

				if (targetNode && targetNode.id !== this._tempLinkFromNodeId) {
					if (targetPortEl) {
						const classes = Array.from(targetPortEl.classList);
						toPort = classes.find(c => ['top', 'right', 'bottom', 'left'].includes(c)) as IFlowchartLink['fromPort'];
					}

					if (!toPort) {
						const rect = this._canvas!.getBoundingClientRect();
						const upX = (e.clientX - rect.left) / this._zoomLevel;
						const upY = (e.clientY - rect.top) / this._zoomLevel;
						const ports: ('top' | 'right' | 'bottom' | 'left')[] = ['left', 'right', 'top', 'bottom'];
						let minDistance = Infinity;
						for (const p of ports) {
							const coords = this._getPortCoords(targetNode, p);
							const dist = Math.hypot(upX - coords.x, upY - coords.y);
							if (dist < minDistance) {
								minDistance = dist;
								toPort = p;
							}
						}
					}

					// Create connection!
					const linkId = `link_${Date.now()}`;
					this._data.links.push({
						id: linkId,
						from: this._tempLinkFromNodeId!,
						fromPort: this._tempLinkFromPort || undefined,
						to: targetNode.id,
						toPort: toPort || undefined,
						style: this._activeLinkStyle || 'arrow-single',
						routing: this._activeRoutingMode || 'orthogonal',
						color: this._activeLineColor || '#0d9488'
					});
					this._saveFlowchartData();
					this._drawLinks();
				}
			}

			this._tempLinkStartX = null;
			this._tempLinkStartY = null;
			this._tempLinkFromNodeId = null;
			this._tempLinkFromPort = null;
			return;
		}

		if (this._isDrawerResizing) {
			this._isDrawerResizing = false;
			if (this._logDrawerEl) {
				this._logDrawerEl.classList.remove('resizing');
			}
			this._storageService.store('workflowEditor.drawerHeight', this._drawerHeight, StorageScope.PROFILE, StorageTarget.USER);
			return;
		}

		if (this._isReconnectingStart || this._isReconnectingEnd) {
			const linkId = this._isReconnectingStart || this._isReconnectingEnd;
			const isStart = !!this._isReconnectingStart;
			this._isReconnectingStart = null;
			this._isReconnectingEnd = null;
			this._clearTempLink();

			if (e) {
				const targetPortEl = (e.target as HTMLElement).closest('.node-port-handle');
				const targetNodeEl = (e.target as HTMLElement).closest('.workflow-node');
				let targetNode: IFlowchartNode | undefined;
				let port: 'top' | 'right' | 'bottom' | 'left' | undefined;

				if (targetNodeEl) {
					const targetNodeId = targetNodeEl.getAttribute('data-node-id');
					if (targetNodeId) {
						targetNode = this._data.nodes.find(n => n.id === targetNodeId);
					}
				}

				if (!targetNode && this._canvas) {
					const rect = this._canvas.getBoundingClientRect();
					const upX = (e.clientX - rect.left) / this._zoomLevel;
					const upY = (e.clientY - rect.top) / this._zoomLevel;
					let bestDist = Infinity;
					for (const n of this._data.nodes) {
						if (upX >= n.x - 24 && upX <= n.x + n.width + 24 &&
							upY >= n.y - 24 && upY <= n.y + n.height + 24) {
							const d = Math.hypot(upX - (n.x + n.width / 2), upY - (n.y + n.height / 2));
							if (d < bestDist) {
								bestDist = d;
								targetNode = n;
							}
						}
					}
				}

				if (targetNode) {
					if (targetPortEl) {
						const classes = Array.from(targetPortEl.classList);
						port = classes.find(c => ['top', 'right', 'bottom', 'left'].includes(c)) as IFlowchartLink['fromPort'];
					}

					const link = this._data.links.find(l => l.id === linkId);
					if (link) {
						if (isStart) {
							if (!port) {
								const toNode = this._data.nodes.find(n => n.id === link.to);
								if (toNode) {
									port = this._getClosestPorts(targetNode, toNode).fromPort;
								}
							}
							link.from = targetNode.id;
							link.fromPort = port || undefined;
						} else {
							if (!port) {
								const fromNode = this._data.nodes.find(n => n.id === link.from);
								if (fromNode) {
									port = this._getClosestPorts(fromNode, targetNode).toPort;
								}
							}
							link.to = targetNode.id;
							link.toPort = port || undefined;
						}
						this._saveFlowchartData();
					}
				}
			}

			this._tempLinkStartX = null;
			this._tempLinkStartY = null;
			this._tempLinkFixedX = 0;
			this._tempLinkFixedY = 0;
			this._drawLinks();
			return;
		}

		if (this._isSelectingBox) {
			this._isSelectingBox = false;
			if (this._selectionBoxEl) {
				this._selectionBoxEl.style.display = 'none';
			}
			this._renderNodes();
			this._drawLinks();
			if (this._inspectorEl) {
				this._renderInspector(this._inspectorEl);
			}
			return;
		}

		if (this._isResizing) {
			this._isResizing = false;
			this._resizeNodeId = null;
			this._saveFlowchartData();
			this._renderNodes();
			return;
		}

		if (this._isDragging) {
			const hasMoved = this._dragStartX !== undefined && (Math.abs(e.clientX - this._dragStartX) > 3 || Math.abs(e.clientY - this._dragStartY) > 3);
			if (hasMoved) {
				this._updateCanvasDimensions();
			}
			if (!hasMoved && this._collapseSelectionTargetNodeId) {
				this._selectedNodeIds.clear();
				this._selectedLinkIds.clear();
				this._selectedNodeIds.add(this._collapseSelectionTargetNodeId);
				this._renderNodes();
				this._drawLinks();
				if (this._inspectorEl) {
					this._renderInspector(this._inspectorEl);
				}
				const collapsedNode = this._data.nodes.find(n => n.id === this._collapseSelectionTargetNodeId);
				if (collapsedNode) {
					const hasOpenNodeSideEditor = this._editorService.editors.some(
						ed => ed instanceof CustomModuleSchemaEditorInput && !ed.isDisposed() && (ed.isFlowchartNodeMode || ed.moduleId.startsWith('wf_node_'))
					);
					if (hasOpenNodeSideEditor) {
						this._openNodeComponentsInSideEditor(collapsedNode);
					}
				}
			}
			this._collapseSelectionTargetNodeId = null;
			this._isDragging = false;
			this._dragNodeId = null;
			if (hasMoved) {
				this._saveFlowchartData();
			}
		}
	}

	private _getPortCoords(node: IFlowchartNode, port: 'top' | 'right' | 'bottom' | 'left'): { x: number; y: number } {
		const cx = node.x + node.width / 2;
		const cy = node.y + node.height / 2;

		switch (port) {
			case 'top': return { x: cx, y: node.y };
			case 'bottom': return { x: cx, y: node.y + node.height };
			case 'left': return { x: node.x, y: cy };
			case 'right': return { x: node.x + node.width, y: cy };
		}
	}

	private _getClosestPorts(fromNode: IFlowchartNode, toNode: IFlowchartNode): { fromPort: 'top' | 'right' | 'bottom' | 'left'; toPort: 'top' | 'right' | 'bottom' | 'left' } {
		const cx1 = fromNode.x + fromNode.width / 2;
		const cy1 = fromNode.y + fromNode.height / 2;
		const cx2 = toNode.x + toNode.width / 2;
		const cy2 = toNode.y + toNode.height / 2;

		const dx = cx2 - cx1;
		const dy = cy2 - cy1;

		if (Math.abs(dx) > Math.abs(dy)) {
			if (dx > 0) {
				return { fromPort: 'right', toPort: 'left' };
			} else {
				return { fromPort: 'left', toPort: 'right' };
			}
		} else {
			if (dy > 0) {
				return { fromPort: 'bottom', toPort: 'top' };
			} else {
				return { fromPort: 'top', toPort: 'bottom' };
			}
		}
	}

	private _deleteNode(id: string): void {
		this._data.nodes = this._data.nodes.filter(n => n.id !== id);
		this._data.links = this._data.links.filter(l => l.from !== id && l.to !== id);
		this._selectedNodeIds.delete(id);
		this._saveFlowchartData();

		this._renderNodes();
		this._drawLinks();
	}

	private _deleteSelectedItems(): void {
		this._data.nodes = this._data.nodes.filter(n => !this._selectedNodeIds.has(n.id));
		this._data.links = this._data.links.filter(l => !this._selectedLinkIds.has(l.id) && !this._selectedNodeIds.has(l.from) && !this._selectedNodeIds.has(l.to));
		this._selectedNodeIds.clear();
		this._selectedLinkIds.clear();
		this._saveFlowchartData();

		this._renderNodes();
		this._drawLinks();
	}

	private _computeOrthogonalWaypoints(
		x1: number,
		y1: number,
		fromPort: 'top' | 'right' | 'bottom' | 'left',
		x2: number,
		y2: number,
		toPort: 'top' | 'right' | 'bottom' | 'left',
		customWaypoints?: { x: number; y: number }[]
	): { x: number; y: number }[] {
		if (customWaypoints && customWaypoints.length >= 2) {
			const pts: { x: number; y: number }[] = [
				{ x: x1, y: y1 },
				...customWaypoints.map(p => ({ x: p.x, y: p.y })),
				{ x: x2, y: y2 }
			];
			if (fromPort === 'left' || fromPort === 'right') {
				pts[1].y = y1;
			} else {
				pts[1].x = x1;
			}
			const lastInteriorIdx = pts.length - 2;
			if (toPort === 'left' || toPort === 'right') {
				pts[lastInteriorIdx].y = y2;
			} else {
				pts[lastInteriorIdx].x = x2;
			}
			return pts;
		}

		const offset = 20;
		const alignSnapTolerance = 12;

		// 1. Right to Left
		if (fromPort === 'right' && toPort === 'left') {
			if (Math.abs(y1 - y2) <= alignSnapTolerance && x2 >= x1) {
				return [{ x: x1, y: y1 }, { x: x2, y: y1 }];
			}
			if (x2 >= x1 + 2 * offset) {
				const midX = (x1 + x2) / 2;
				return [{ x: x1, y: y1 }, { x: midX, y: y1 }, { x: midX, y: y2 }, { x: x2, y: y2 }];
			} else {
				const midY = (y1 + y2) / 2;
				return [{ x: x1, y: y1 }, { x: x1 + offset, y: y1 }, { x: x1 + offset, y: midY }, { x: x2 - offset, y: midY }, { x: x2 - offset, y: y2 }, { x: x2, y: y2 }];
			}
		}

		// 2. Left to Right
		if (fromPort === 'left' && toPort === 'right') {
			if (Math.abs(y1 - y2) <= alignSnapTolerance && x2 <= x1) {
				return [{ x: x1, y: y1 }, { x: x2, y: y1 }];
			}
			if (x2 <= x1 - 2 * offset) {
				const midX = (x1 + x2) / 2;
				return [{ x: x1, y: y1 }, { x: midX, y: y1 }, { x: midX, y: y2 }, { x: x2, y: y2 }];
			} else {
				const midY = (y1 + y2) / 2;
				return [{ x: x1, y: y1 }, { x: x1 - offset, y: y1 }, { x: x1 - offset, y: midY }, { x: x2 + offset, y: midY }, { x: x2 + offset, y: y2 }, { x: x2, y: y2 }];
			}
		}

		// 3. Bottom to Top
		if (fromPort === 'bottom' && toPort === 'top') {
			if (Math.abs(x1 - x2) <= alignSnapTolerance && y2 >= y1) {
				return [{ x: x1, y: y1 }, { x: x1, y: y2 }];
			}
			if (y2 >= y1 + 2 * offset) {
				const midY = (y1 + y2) / 2;
				return [{ x: x1, y: y1 }, { x: x1, y: midY }, { x: x2, y: midY }, { x: x2, y: y2 }];
			} else {
				const midX = (x1 + x2) / 2;
				return [{ x: x1, y: y1 }, { x: x1, y: y1 + offset }, { x: midX, y: y1 + offset }, { x: midX, y: y2 - offset }, { x: x2, y: y2 - offset }, { x: x2, y: y2 }];
			}
		}

		// 4. Top to Bottom
		if (fromPort === 'top' && toPort === 'bottom') {
			if (Math.abs(x1 - x2) <= alignSnapTolerance && y2 <= y1) {
				return [{ x: x1, y: y1 }, { x: x1, y: y2 }];
			}
			if (y2 <= y1 - 2 * offset) {
				const midY = (y1 + y2) / 2;
				return [{ x: x1, y: y1 }, { x: x1, y: midY }, { x: x2, y: midY }, { x: x2, y: y2 }];
			} else {
				const midX = (x1 + x2) / 2;
				return [{ x: x1, y: y1 }, { x: x1, y: y1 - offset }, { x: midX, y: y1 - offset }, { x: midX, y: y2 + offset }, { x: x2, y: y2 + offset }, { x: x2, y: y2 }];
			}
		}

		// 5. Same horizontal ports
		if (fromPort === 'right' && toPort === 'right') {
			const maxX = Math.max(x1, x2) + offset;
			return [{ x: x1, y: y1 }, { x: maxX, y: y1 }, { x: maxX, y: y2 }, { x: x2, y: y2 }];
		}
		if (fromPort === 'left' && toPort === 'left') {
			const minX = Math.min(x1, x2) - offset;
			return [{ x: x1, y: y1 }, { x: minX, y: y1 }, { x: minX, y: y2 }, { x: x2, y: y2 }];
		}

		// 6. Same vertical ports
		if (fromPort === 'bottom' && toPort === 'bottom') {
			const maxY = Math.max(y1, y2) + offset;
			return [{ x: x1, y: y1 }, { x: x1, y: maxY }, { x: x2, y: maxY }, { x: x2, y: y2 }];
		}
		if (fromPort === 'top' && toPort === 'top') {
			const minY = Math.min(y1, y2) - offset;
			return [{ x: x1, y: y1 }, { x: x1, y: minY }, { x: x2, y: minY }, { x: x2, y: y2 }];
		}

		// 7. Right to Top / Bottom
		if (fromPort === 'right' && toPort === 'top') {
			if (x2 >= x1 && y2 >= y1) {
				return [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }];
			}
			return [{ x: x1, y: y1 }, { x: x1 + offset, y: y1 }, { x: x1 + offset, y: y2 - offset }, { x: x2, y: y2 - offset }, { x: x2, y: y2 }];
		}
		if (fromPort === 'right' && toPort === 'bottom') {
			if (x2 >= x1 && y2 <= y1) {
				return [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }];
			}
			return [{ x: x1, y: y1 }, { x: x1 + offset, y: y1 }, { x: x1 + offset, y: y2 + offset }, { x: x2, y: y2 + offset }, { x: x2, y: y2 }];
		}

		// 8. Left to Top / Bottom
		if (fromPort === 'left' && toPort === 'top') {
			if (x2 <= x1 && y2 >= y1) {
				return [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }];
			}
			return [{ x: x1, y: y1 }, { x: x1 - offset, y: y1 }, { x: x1 - offset, y: y2 - offset }, { x: x2, y: y2 - offset }, { x: x2, y: y2 }];
		}
		if (fromPort === 'left' && toPort === 'bottom') {
			if (x2 <= x1 && y2 <= y1) {
				return [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }];
			}
			return [{ x: x1, y: y1 }, { x: x1 - offset, y: y1 }, { x: x1 - offset, y: y2 + offset }, { x: x2, y: y2 + offset }, { x: x2, y: y2 }];
		}

		// 9. Bottom to Left / Right
		if (fromPort === 'bottom' && toPort === 'left') {
			if (y2 >= y1 && x2 >= x1) {
				return [{ x: x1, y: y1 }, { x: x1, y: y2 }, { x: x2, y: y2 }];
			}
			return [{ x: x1, y: y1 }, { x: x1, y: y1 + offset }, { x: x2 - offset, y: y1 + offset }, { x: x2 - offset, y: y2 }, { x: x2, y: y2 }];
		}
		if (fromPort === 'bottom' && toPort === 'right') {
			if (y2 >= y1 && x2 <= x1) {
				return [{ x: x1, y: y1 }, { x: x1, y: y2 }, { x: x2, y: y2 }];
			}
			return [{ x: x1, y: y1 }, { x: x1, y: y1 + offset }, { x: x2 + offset, y: y1 + offset }, { x: x2 + offset, y: y2 }, { x: x2, y: y2 }];
		}

		// 10. Top to Left / Right
		if (fromPort === 'top' && toPort === 'left') {
			if (y2 <= y1 && x2 >= x1) {
				return [{ x: x1, y: y1 }, { x: x1, y: y2 }, { x: x2, y: y2 }];
			}
			return [{ x: x1, y: y1 }, { x: x1, y: y1 - offset }, { x: x2 - offset, y: y1 - offset }, { x: x2 - offset, y: y2 }, { x: x2, y: y2 }];
		}
		if (fromPort === 'top' && toPort === 'right') {
			if (y2 <= y1 && x2 <= x1) {
				return [{ x: x1, y: y1 }, { x: x1, y: y2 }, { x: x2, y: y2 }];
			}
			return [{ x: x1, y: y1 }, { x: x1, y: y1 - offset }, { x: x2 + offset, y: y1 - offset }, { x: x2 + offset, y: y2 }, { x: x2, y: y2 }];
		}

		// Fallback
		const midX = (x1 + x2) / 2;
		return [{ x: x1, y: y1 }, { x: midX, y: y1 }, { x: midX, y: y2 }, { x: x2, y: y2 }];
	}

	private _pointsToSvgPath(pts: { x: number; y: number }[], radius = 5): string {
		const clean: { x: number; y: number }[] = [];
		for (let i = 0; i < pts.length; i++) {
			if (clean.length >= 1) {
				const last = clean[clean.length - 1];
				if (Math.hypot(pts[i].x - last.x, pts[i].y - last.y) < 0.5) {
					continue;
				}
			}
			if (clean.length >= 2) {
				const pPrev = clean[clean.length - 2];
				const pLast = clean[clean.length - 1];
				const pCurr = pts[i];
				if (Math.abs(pPrev.y - pLast.y) < 0.5 && Math.abs(pLast.y - pCurr.y) < 0.5) {
					clean[clean.length - 1] = pCurr;
					continue;
				}
				if (Math.abs(pPrev.x - pLast.x) < 0.5 && Math.abs(pLast.x - pCurr.x) < 0.5) {
					clean[clean.length - 1] = pCurr;
					continue;
				}
			}
			clean.push(pts[i]);
		}

		if (clean.length === 0) { return 'M 0 0'; }
		if (clean.length === 1) { return `M ${clean[0].x} ${clean[0].y}`; }
		if (clean.length === 2 || radius <= 0) {
			return clean.map((p, idx) => (idx === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(' ');
		}

		let d = `M ${clean[0].x} ${clean[0].y}`;
		for (let i = 1; i < clean.length - 1; i++) {
			const prev = clean[i - 1];
			const curr = clean[i];
			const next = clean[i + 1];

			const dPrev = Math.hypot(curr.x - prev.x, curr.y - prev.y);
			const dNext = Math.hypot(next.x - curr.x, next.y - curr.y);
			const r = Math.min(radius, dPrev / 2, dNext / 2);

			if (r < 1) {
				d += ` L ${curr.x} ${curr.y}`;
			} else {
				const uxPrev = (curr.x - prev.x) / dPrev;
				const uyPrev = (curr.y - prev.y) / dPrev;
				const startX = curr.x - uxPrev * r;
				const startY = curr.y - uyPrev * r;

				const uxNext = (next.x - curr.x) / dNext;
				const uyNext = (next.y - curr.y) / dNext;
				const endX = curr.x + uxNext * r;
				const endY = curr.y + uyNext * r;

				d += ` L ${startX} ${startY} Q ${curr.x} ${curr.y} ${endX} ${endY}`;
			}
		}
		d += ` L ${clean[clean.length - 1].x} ${clean[clean.length - 1].y}`;
		return d;
	}

	private _getLinkPathData(
		x1: number,
		y1: number,
		fromPort: 'top' | 'right' | 'bottom' | 'left',
		x2: number,
		y2: number,
		toPort: 'top' | 'right' | 'bottom' | 'left',
		mode: 'orthogonal' | 'curved',
		customWaypoints?: { x: number; y: number }[]
	): string {
		if (mode === 'orthogonal') {
			const waypoints = this._computeOrthogonalWaypoints(x1, y1, fromPort, x2, y2, toPort, customWaypoints);
			return this._pointsToSvgPath(waypoints, 5);
		} else {
			const dx = x2 - x1;
			const controlDist = Math.max(30, Math.min(100, Math.abs(dx) * 0.5));
			let d = `M ${x1} ${y1}`;
			if (fromPort === 'left' || fromPort === 'right') {
				d += ` C ${x1 + (fromPort === 'right' ? controlDist : -controlDist)} ${y1}, ${x2 + (toPort === 'right' ? controlDist : -controlDist)} ${y2}, ${x2} ${y2}`;
			} else {
				d += ` C ${x1} ${y1 + (fromPort === 'bottom' ? controlDist : -controlDist)}, ${x2} ${y2 + (toPort === 'bottom' ? controlDist : -controlDist)}, ${x2} ${y2}`;
			}
			return d;
		}
	}

	private _getLinkMidpoint(link: IFlowchartLink): { x: number; y: number } {
		const fromNode = this._data.nodes.find(n => n.id === link.from);
		const toNode = this._data.nodes.find(n => n.id === link.to);
		if (!fromNode || !toNode) { return { x: 0, y: 0 }; }

		const closest = this._getClosestPorts(fromNode, toNode);
		const fromPort = link.fromPort || closest.fromPort;
		const toPort = link.toPort || closest.toPort;

		const startCoords = this._getPortCoords(fromNode, fromPort);
		const endCoords = this._getPortCoords(toNode, toPort);

		const routingMode = link.routing || this._activeRoutingMode || 'orthogonal';
		const t = typeof link.labelPosition === 'number' ? link.labelPosition : 0.5;
		return this._computePointFromCoords(startCoords.x, startCoords.y, fromPort, endCoords.x, endCoords.y, toPort, routingMode, t, link.waypoints);
	}

	private _computePointFromCoords(
		x1: number, y1: number, fromPort: 'top' | 'right' | 'bottom' | 'left',
		x2: number, y2: number, toPort: 'top' | 'right' | 'bottom' | 'left',
		routingMode: 'orthogonal' | 'curved',
		t: number = 0.5,
		customWaypoints?: { x: number; y: number }[]
	): { x: number; y: number } {
		t = Math.max(0, Math.min(1, t));
		if (routingMode === 'orthogonal') {
			const waypoints = this._computeOrthogonalWaypoints(x1, y1, fromPort, x2, y2, toPort, customWaypoints);
			return this._getOrthogonalPointAtT(waypoints, t);
		} else {
			const dx = x2 - x1;
			const controlDist = Math.max(30, Math.min(100, Math.abs(dx) * 0.5));
			let cx1 = x1, cy1 = y1, cx2 = x2, cy2 = y2;
			if (fromPort === 'left' || fromPort === 'right') {
				cx1 = x1 + (fromPort === 'right' ? controlDist : -controlDist);
				cx2 = x2 + (toPort === 'right' ? controlDist : -controlDist);
			} else {
				cy1 = y1 + (fromPort === 'bottom' ? controlDist : -controlDist);
				cy2 = y2 + (toPort === 'bottom' ? controlDist : -controlDist);
			}
			const u = 1 - t;
			const tt = t * t;
			const uu = u * u;
			const uuu = uu * u;
			const ttt = tt * t;
			return {
				x: Math.round(uuu * x1 + 3 * uu * t * cx1 + 3 * u * tt * cx2 + ttt * x2),
				y: Math.round(uuu * y1 + 3 * uu * t * cy1 + 3 * u * tt * cy2 + ttt * y2)
			};
		}
	}

	private _computeMidpointFromCoords(
		x1: number, y1: number, fromPort: 'top' | 'right' | 'bottom' | 'left',
		x2: number, y2: number, toPort: 'top' | 'right' | 'bottom' | 'left',
		routingMode: 'orthogonal' | 'curved',
		customWaypoints?: { x: number; y: number }[]
	): { x: number; y: number } {
		return this._computePointFromCoords(x1, y1, fromPort, x2, y2, toPort, routingMode, 0.5, customWaypoints);
	}

	private _getOrthogonalPointAtT(waypoints: { x: number; y: number }[], t: number): { x: number; y: number } {
		if (waypoints.length === 0) { return { x: 0, y: 0 }; }
		if (waypoints.length === 1) { return waypoints[0]; }

		let totalLen = 0;
		const segLens: number[] = [];
		for (let i = 0; i < waypoints.length - 1; i++) {
			const len = Math.hypot(waypoints[i + 1].x - waypoints[i].x, waypoints[i + 1].y - waypoints[i].y);
			segLens.push(len);
			totalLen += len;
		}

		if (totalLen === 0) { return waypoints[0]; }

		const targetDist = totalLen * t;
		let accumulated = 0;
		for (let i = 0; i < segLens.length; i++) {
			if (accumulated + segLens[i] >= targetDist || i === segLens.length - 1) {
				const segT = segLens[i] === 0 ? 0 : Math.max(0, Math.min(1, (targetDist - accumulated) / segLens[i]));
				return {
					x: Math.round(waypoints[i].x + (waypoints[i + 1].x - waypoints[i].x) * segT),
					y: Math.round(waypoints[i].y + (waypoints[i + 1].y - waypoints[i].y) * segT)
				};
			}
			accumulated += segLens[i];
		}
		return waypoints[waypoints.length - 1];
	}

	private _findClosestTOnLink(link: IFlowchartLink, px: number, py: number): number {
		const fromNode = this._data.nodes.find(n => n.id === link.from);
		const toNode = this._data.nodes.find(n => n.id === link.to);
		if (!fromNode || !toNode) { return 0.5; }

		const closest = this._getClosestPorts(fromNode, toNode);
		const fromPort = link.fromPort || closest.fromPort;
		const toPort = link.toPort || closest.toPort;

		const startCoords = this._getPortCoords(fromNode, fromPort);
		const endCoords = this._getPortCoords(toNode, toPort);
		const routingMode = link.routing || this._activeRoutingMode || 'orthogonal';

		if (routingMode === 'orthogonal') {
			const waypoints = this._computeOrthogonalWaypoints(startCoords.x, startCoords.y, fromPort, endCoords.x, endCoords.y, toPort, link.waypoints);
			if (waypoints.length < 2) { return 0.5; }

			let totalLen = 0;
			const segLens: number[] = [];
			for (let i = 0; i < waypoints.length - 1; i++) {
				const len = Math.hypot(waypoints[i + 1].x - waypoints[i].x, waypoints[i + 1].y - waypoints[i].y);
				segLens.push(len);
				totalLen += len;
			}
			if (totalLen <= 0) { return 0.5; }

			let bestDistSq = Infinity;
			let bestPathDist = 0;
			let acc = 0;

			for (let i = 0; i < waypoints.length - 1; i++) {
				const ax = waypoints[i].x;
				const ay = waypoints[i].y;
				const bx = waypoints[i + 1].x;
				const by = waypoints[i + 1].y;
				const segLen = segLens[i];

				const dx = bx - ax;
				const dy = by - ay;
				const lenSq = dx * dx + dy * dy;

				let u = 0;
				if (lenSq > 0) {
					u = ((px - ax) * dx + (py - ay) * dy) / lenSq;
					u = Math.max(0, Math.min(1, u));
				}
				const qx = ax + u * dx;
				const qy = ay + u * dy;
				const distSq = (px - qx) * (px - qx) + (py - qy) * (py - qy);

				if (distSq < bestDistSq) {
					bestDistSq = distSq;
					bestPathDist = acc + u * segLen;
				}
				acc += segLen;
			}

			const t = bestPathDist / totalLen;
			return Math.max(0.05, Math.min(0.95, Number(t.toFixed(3))));
		} else {
			let bestDistSq = Infinity;
			let bestT = 0.5;
			const samples = 100;
			for (let i = 0; i <= samples; i++) {
				const t = i / samples;
				const pt = this._computePointFromCoords(startCoords.x, startCoords.y, fromPort, endCoords.x, endCoords.y, toPort, routingMode, t, link.waypoints);
				const distSq = (px - pt.x) * (px - pt.x) + (py - pt.y) * (py - pt.y);
				if (distSq < bestDistSq) {
					bestDistSq = distSq;
					bestT = t;
				}
			}
			return Math.max(0.05, Math.min(0.95, Number(bestT.toFixed(3))));
		}
	}

	private _findClosestSegmentOnWaypoints(waypoints: { x: number; y: number }[], px: number, py: number): number {
		let bestIdx = 0;
		let bestDistSq = Infinity;
		for (let i = 0; i < waypoints.length - 1; i++) {
			const ax = waypoints[i].x;
			const ay = waypoints[i].y;
			const bx = waypoints[i + 1].x;
			const by = waypoints[i + 1].y;
			const dx = bx - ax;
			const dy = by - ay;
			const lenSq = dx * dx + dy * dy;
			if (lenSq < 1) { continue; }
			let u = ((px - ax) * dx + (py - ay) * dy) / lenSq;
			u = Math.max(0, Math.min(1, u));
			const qx = ax + u * dx;
			const qy = ay + u * dy;
			const distSq = (px - qx) * (px - qx) + (py - qy) * (py - qy);
			if (distSq < bestDistSq) {
				bestDistSq = distSq;
				bestIdx = i;
			}
		}
		return bestIdx;
	}

	private _prepareSegmentDragWaypoints(
		pts: { x: number; y: number }[],
		segIdx: number,
		fromPort: 'top' | 'right' | 'bottom' | 'left',
		toPort: 'top' | 'right' | 'bottom' | 'left'
	): { pts: { x: number; y: number }[]; segIdx: number; isVertical: boolean } {
		const copy = pts.map(p => ({ x: p.x, y: p.y }));
		let idx = Math.max(0, Math.min(copy.length - 2, segIdx));
		const pA = copy[idx];
		const pB = copy[idx + 1];
		const isVertical = Math.abs(pA.x - pB.x) <= Math.abs(pA.y - pB.y);

		if (idx === 0) {
			const stubDist = 20;
			let sx = copy[0].x;
			let sy = copy[0].y;
			if (fromPort === 'right') { sx += stubDist; }
			else if (fromPort === 'left') { sx -= stubDist; }
			else if (fromPort === 'bottom') { sy += stubDist; }
			else if (fromPort === 'top') { sy -= stubDist; }
			copy.splice(1, 0, { x: sx, y: sy }, { x: sx, y: sy });
			idx += 2;
		}
		if (idx === copy.length - 2) {
			const stubDist = 20;
			const last = copy[copy.length - 1];
			let ex = last.x;
			let ey = last.y;
			if (toPort === 'left') { ex -= stubDist; }
			else if (toPort === 'right') { ex += stubDist; }
			else if (toPort === 'top') { ey -= stubDist; }
			else if (toPort === 'bottom') { ey += stubDist; }
			copy.splice(copy.length - 1, 0, { x: ex, y: ey }, { x: ex, y: ey });
		}

		return { pts: copy, segIdx: idx, isVertical };
	}

	private _startLinkSegmentDrag(
		e: MouseEvent,
		link: IFlowchartLink,
		baseWaypoints: { x: number; y: number }[],
		segIdx: number,
		canvasX: number,
		canvasY: number,
		isExplicitHandle: boolean
	): void {
		if (e.button !== 0) { return; }
		e.stopPropagation();
		this._isDraggingLinkSegment = link.id;
		this._dragLinkSegmentInitialIndex = segIdx;
		this._dragLinkSegmentIndex = segIdx;
		this._dragLinkSegmentWaypoints = baseWaypoints.map(p => ({ x: p.x, y: p.y }));
		this._dragLinkSegmentStartX = e.clientX;
		this._dragLinkSegmentStartY = e.clientY;
		this._dragLinkSegmentCanvasX = canvasX;
		this._dragLinkSegmentCanvasY = canvasY;
		this._dragLinkSegmentHasMoved = false;
		this._dragLinkSegmentPrepared = false;

		if (isExplicitHandle) {
			const fromNode = this._data.nodes.find(n => n.id === link.from);
			const toNode = this._data.nodes.find(n => n.id === link.to);
			if (fromNode && toNode) {
				const closest = this._getClosestPorts(fromNode, toNode);
				const fromPort = link.fromPort || closest.fromPort;
				const toPort = link.toPort || closest.toPort;
				const prep = this._prepareSegmentDragWaypoints(this._dragLinkSegmentWaypoints, segIdx, fromPort, toPort);
				this._dragLinkSegmentWaypoints = prep.pts;
				this._dragLinkSegmentIndex = prep.segIdx;
				this._dragLinkSegmentIsVertical = prep.isVertical;
				this._dragLinkSegmentPrepared = true;
			}
		}
	}

	private _getLinkLabelEditorWrapper(): HTMLElement | undefined {
		const wrapper = this._linkLabelEditorWrapper;
		return wrapper && this._linkDeletesContainer?.contains(wrapper) ? wrapper : undefined;
	}

	/** The label element of link `linkId` currently drawn in `_linkDeletesContainer`. */
	private _getLinkLabelEl(linkId: string): HTMLElement | undefined {
		const labelEl = this._linkLabelEls.get(linkId);
		return labelEl && this._linkDeletesContainer?.contains(labelEl) ? labelEl : undefined;
	}

	private _showLinkInlineEditor(link: IFlowchartLink, x: number, y: number): void {
		if (!this._linkDeletesContainer) { return; }
		// Remove any existing editor
		const existing = this._getLinkLabelEditorWrapper();
		if (existing) { existing.remove(); }

		const wrapper = append(this._linkDeletesContainer, $('.workflow-link-label-editor-wrapper'));
		this._linkLabelEditorWrapper = wrapper;
		wrapper.style.position = 'absolute';
		wrapper.style.left = `${x}px`;
		wrapper.style.top = `${y}px`;
		wrapper.style.zIndex = '10000';

		const textarea = append(wrapper, $('textarea.workflow-link-label-editor')) as HTMLTextAreaElement;
		textarea.value = link.label || '';
		textarea.placeholder = 'Condition, e.g. @monitor != None';

		const adjustHeight = () => {
			textarea.style.height = 'auto';
			textarea.style.height = `${Math.min(90, Math.max(24, textarea.scrollHeight + 2))}px`;
		};

		let committed = false;
		let acMenu: HTMLElement | null = null;
		let activeAcIndex = 0;
		let currentMatches: { name: string; initialValue: string; nodeLabel?: string }[] = [];

		const availableVars: { name: string; initialValue: string; nodeLabel?: string }[] = [];
		for (const n of this._data?.nodes || []) {
			for (const v of this._getNodeVariables(n)) {
				availableVars.push({
					name: v.name,
					initialValue: v.initialValue || 'None',
					nodeLabel: n.label
				});
			}
			for (const imp of n.imports || []) {
				const ticketVar = imp.name.replace(/[^a-zA-Z0-9_]/g, '_');
				if (!availableVars.some(av => av.name === ticketVar)) {
					availableVars.push({
						name: ticketVar,
						initialValue: `${imp.type}`,
						nodeLabel: n.label
					});
				}
			}
		}

		const closeAc = () => {
			if (acMenu) {
				acMenu.remove();
				acMenu = null;
			}
		};

		const insertVar = (varName: string) => {
			const selStart = textarea.selectionStart;
			const textBefore = textarea.value.slice(0, selStart);
			const textAfter = textarea.value.slice(selStart);
			const atIdx = textBefore.lastIndexOf('@');
			if (atIdx !== -1) {
				textarea.value = textBefore.slice(0, atIdx) + `@${varName} ` + textAfter;
				textarea.selectionStart = textarea.selectionEnd = atIdx + varName.length + 2;
			}
			closeAc();
			adjustHeight();
			textarea.focus();
		};

		const updateAc = () => {
			const selStart = textarea.selectionStart;
			const textBefore = textarea.value.slice(0, selStart);
			const match = textBefore.match(/@([a-zA-Z0-9_]*)$/);
			if (!match) {
				closeAc();
				return;
			}

			const query = match[1].toLowerCase();
			currentMatches = availableVars.filter(v => v.name.toLowerCase().includes(query));
			if (currentMatches.length === 0) {
				closeAc();
				return;
			}

			if (!acMenu) {
				acMenu = append(wrapper, $('.workflow-link-ac-menu'));
			}
			clearNode(acMenu);
			activeAcIndex = Math.min(activeAcIndex, currentMatches.length - 1);

			currentMatches.forEach((v, idx) => {
				const item = append(acMenu!, $(`.workflow-link-ac-item${idx === activeAcIndex ? '.active' : ''}`));
				const vTag = append(item, $('.var-tag-icon'));
				vTag.textContent = '[V]';
				const nameSpan = append(item, $('.ac-var-name'));
				nameSpan.textContent = `@${v.name}`;
				const descSpan = append(item, $('.ac-var-desc'));
				descSpan.textContent = `(=${v.initialValue}) ${v.nodeLabel ? `[${v.nodeLabel}]` : ''}`;
				item.onmousedown = (e) => {
					e.preventDefault();
					e.stopPropagation();
					insertVar(v.name);
				};
			});
		};

		textarea.oninput = () => {
			adjustHeight();
			updateAc();
		};

		const commit = () => {
			if (committed) { return; }
			committed = true;
			closeAc();
			const val = textarea.value.trim();
			if (val) {
				link.label = val;
			} else {
				delete link.label;
			}
			wrapper.remove();
			this._saveFlowchartData();
			this._drawLinks();
		};

		textarea.onkeydown = (e) => {
			e.stopPropagation();
			if (acMenu && currentMatches.length > 0) {
				if (e.key === 'ArrowDown') {
					e.preventDefault();
					activeAcIndex = (activeAcIndex + 1) % currentMatches.length;
					updateAc();
					return;
				} else if (e.key === 'ArrowUp') {
					e.preventDefault();
					activeAcIndex = (activeAcIndex - 1 + currentMatches.length) % currentMatches.length;
					updateAc();
					return;
				} else if (e.key === 'Enter' || e.key === 'Tab') {
					e.preventDefault();
					insertVar(currentMatches[activeAcIndex].name);
					return;
				} else if (e.key === 'Escape') {
					e.preventDefault();
					closeAc();
					return;
				}
			}

			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				commit();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				committed = true;
				wrapper.remove();
				this._drawLinks();
			}
		};

		textarea.onblur = () => {
			setTimeout(() => {
				commit();
			}, 180);
		};

		textarea.onmousedown = (e) => e.stopPropagation();
		textarea.onclick = (e) => e.stopPropagation();
		textarea.ondblclick = (e) => e.stopPropagation();

		setTimeout(() => {
			adjustHeight();
			textarea.focus();
			textarea.select();
		}, 20);
	}

	private _renderLinkLabelContent(parent: HTMLElement, rawLabel: string, status?: string): void {
		clearNode(parent);
		if (!rawLabel) { return; }

		if (status === 'error') {
			const errTag = append(parent, $('span.link-condition-error-tag'));
			errTag.textContent = '[!] ';
			errTag.style.color = '#f87171';
			errTag.style.fontWeight = '700';
			errTag.style.marginRight = '3px';
		} else if (status === 'passed') {
			const okTag = append(parent, $('span.link-condition-passed-tag'));
			okTag.textContent = '✓ ';
			okTag.style.color = '#10b981';
			okTag.style.fontWeight = '700';
			okTag.style.marginRight = '3px';
		}

		const knownVars = new Set<string>();
		for (const n of this._data?.nodes || []) {
			for (const v of this._getNodeVariables(n)) {
				knownVars.add(v.name);
			}
			for (const imp of n.imports || []) {
				knownVars.add(imp.name.replace(/[^a-zA-Z0-9_]/g, '_'));
			}
		}

		const tokens = rawLabel.split(/(\s+|==|!=|<=|>=|<|>)/);
		for (const tok of tokens) {
			if (!tok) { continue; }
			let varName: string | null = null;
			let hasAt = false;
			if (tok.startsWith('@')) {
				varName = tok.slice(1);
				hasAt = true;
			} else if (knownVars.has(tok)) {
				varName = tok;
			}

			if (varName && (hasAt || knownVars.has(varName))) {
				const chip = append(parent, $('.link-var-chip'));
				const vBadge = append(chip, $('.var-tag-icon'));
				vBadge.textContent = '[V]';
				append(chip, $('.link-var-chip-name')).textContent = varName;
				if (!knownVars.has(varName)) {
					chip.classList.add('undefined-var');
					chip.title = localize('undefinedVarWarning', 'Variable @{0} is not defined in workflow!', varName);
				} else {
					chip.title = localize('definedVarTitle', 'Context Variable: {0}', varName);
				}
			} else {
				parent.appendChild(document.createTextNode(tok));
			}
		}
	}

	private _drawLinks(): void {
		if (!this._svgOverlay || !this._linkDeletesContainer) { return; }

		// Clear previous lines and handles (preserve any open inline link condition editor)
		const svgOverlay = this._svgOverlay;
		const lines = [...this._connectionLineEls].filter(l => svgOverlay.contains(l));
		lines.forEach(l => {
			l.remove();
			this._connectionLineEls.delete(l);
		});
		const activeLinkEditor = this._getLinkLabelEditorWrapper();
		clearNode(this._linkDeletesContainer);
		this._linkLabelEls = new Map();
		if (activeLinkEditor) {
			this._linkDeletesContainer.appendChild(activeLinkEditor);
		}

		if (!this._data || !Array.isArray(this._data.links) || !Array.isArray(this._data.nodes)) {
			return;
		}

		for (const link of this._data.links) {
			const fromNode = this._data.nodes.find(n => n.id === link.from);
			const toNode = this._data.nodes.find(n => n.id === link.to);

			if (!fromNode || !toNode) { continue; }

			// Use explicit ports or fall back to closest ports calculation
			const closest = this._getClosestPorts(fromNode, toNode);
			const fromPort = link.fromPort || closest.fromPort;
			const toPort = link.toPort || closest.toPort;

			const startCoords = this._getPortCoords(fromNode, fromPort);
			const endCoords = this._getPortCoords(toNode, toPort);

			let x1 = startCoords.x;
			let y1 = startCoords.y;
			let x2 = endCoords.x;
			let y2 = endCoords.y;

			// Horizontal micro-alignment snap (prevents tiny 1-5px steps when nodes are roughly horizontally aligned)
			if ((fromPort === 'right' && toPort === 'left') || (fromPort === 'left' && toPort === 'right')) {
				if (Math.abs(y1 - y2) <= 12) {
					y2 = y1;
				}
			}
			// Vertical micro-alignment snap
			if ((fromPort === 'top' && toPort === 'bottom') || (fromPort === 'bottom' && toPort === 'top')) {
				if (Math.abs(x1 - x2) <= 12) {
					x2 = x1;
				}
			}

			// Apply arrow offsets so arrows don't pierce into nodes
			const hasEndArrow = link.style === 'arrow-single' || link.style === 'arrow-double';
			const hasStartArrow = link.style === 'arrow-double';

			if (hasStartArrow) {
				if (fromPort === 'right') { x1 += 8; }
				else if (fromPort === 'left') { x1 -= 8; }
				else if (fromPort === 'bottom') { y1 += 8; }
				else if (fromPort === 'top') { y1 -= 8; }
			}
			if (hasEndArrow) {
				if (toPort === 'left') { x2 -= 8; }
				else if (toPort === 'right') { x2 += 8; }
				else if (toPort === 'top') { y2 -= 8; }
				else if (toPort === 'bottom') { y2 += 8; }
			}

			// Draw connection line
			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.classList.add('workflow-connection-line');
			this._connectionLineEls.add(path);

			const activeRun = this._getEffectiveRunForLink(link);
			const linkState = activeRun?.linkStates?.[link.id] || activeRun?.linkStates?.[`${link.from}->${link.to}`];

			// Custom Link Color or Default (match fromNode color / theme)
			let linkHex = (link.color || '#0d9488').toLowerCase();
			if (linkState?.status === 'error') {
				linkHex = '#ef4444';
			} else if (linkState?.status === 'passed') {
				linkHex = '#10b981';
			}
			path.style.stroke = linkHex;

			if (linkState?.status === 'error') {
				path.classList.add('status-error');
				path.style.stroke = '#ef4444';
				path.style.strokeWidth = '2.5px';
			} else if (linkState?.status === 'passed') {
				path.classList.add('status-passed');
				path.style.stroke = '#10b981';
				path.style.strokeWidth = '2px';
			} else if (linkState?.status === 'rejected') {
				path.classList.add('status-rejected');
			}

			// Highlight line if selected
			const isSelected = this._selectedLinkIds.has(link.id);
			if (isSelected) {
				path.classList.add('selected');
				path.style.stroke = '#22d3ee';
				path.style.strokeWidth = '3px';
			}

			// Use link-specific routing or fallback to active flowchart routing mode
			const routingMode = link.routing || this._activeRoutingMode || 'orthogonal';
			const d = this._getLinkPathData(x1, y1, fromPort, x2, y2, toPort, routingMode, link.waypoints);
			path.setAttribute('d', d);

			// Link Styles markers (Arrow marker endpoint)
			const validMarkerColors = new Set(['ffffff', '0d9488', '38bdf8', '7c3aed', 'facc15', 'f43f5e']);
			const hexClean = linkHex.replace('#', '');
			let markerColorId = isSelected ? 'arrow-selected' : (validMarkerColors.has(hexClean) ? `arrow-${hexClean}` : 'arrow');
			if (linkState?.status === 'error') {
				markerColorId = 'arrow-f43f5e';
			} else if (linkState?.status === 'passed') {
				markerColorId = 'arrow-0d9488';
			}

			if (link.style === 'dashed') {
				path.style.strokeDasharray = '6, 4';
				path.setAttribute('marker-end', `url(#${markerColorId})`);
			} else if (link.style === 'arrow-single') {
				path.setAttribute('marker-end', `url(#${markerColorId})`);
			} else if (link.style === 'arrow-double') {
				path.setAttribute('marker-start', `url(#${markerColorId})`);
				path.setAttribute('marker-end', `url(#${markerColorId})`);
			}

			// Wide transparent hit area so users can easily grab and drag any line segment
			const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			hitPath.classList.add('workflow-connection-hit-area');
			this._connectionLineEls.add(hitPath);
			hitPath.setAttribute('d', d);

			this._svgOverlay.appendChild(path);
			this._svgOverlay.appendChild(hitPath);

			// Calculate midpoint for labels and double click editor
			const midPoint = this._computeMidpointFromCoords(startCoords.x, startCoords.y, fromPort, endCoords.x, endCoords.y, toPort, routingMode, link.waypoints);

			const onLineDblClick = (e: MouseEvent) => {
				e.stopPropagation();
				e.preventDefault();
				this._showLinkInlineEditor(link, midPoint.x, midPoint.y);
			};
			path.ondblclick = onLineDblClick;
			hitPath.ondblclick = onLineDblClick;

			const onLineContextMenu = (e: MouseEvent) => {
				e.preventDefault();
				e.stopPropagation();
				this._showContextMenu(e.clientX, e.clientY, 'link', link.id);
			};
			path.oncontextmenu = onLineContextMenu;
			hitPath.oncontextmenu = onLineContextMenu;

			const onLineMouseDown = (e: MouseEvent) => {
				if (e.button !== 0) { return; }
				const now = Date.now();
				const lastLineClick = link._lastLineClickTime || 0;
				link._lastLineClickTime = now;
				if (now - lastLineClick < 350) {
					link._lastLineClickTime = 0;
					this._isDraggingLinkSegment = null;
					e.stopPropagation();
					e.preventDefault();
					const curMid = this._computeMidpointFromCoords(startCoords.x, startCoords.y, fromPort, endCoords.x, endCoords.y, toPort, routingMode, link.waypoints);
					this._showLinkInlineEditor(link, curMid.x, curMid.y);
					return;
				}
				if (routingMode === 'orthogonal' && this._canvas) {
					const rect = this._canvas.getBoundingClientRect();
					const mouseX = (e.clientX - rect.left) / this._zoomLevel;
					const mouseY = (e.clientY - rect.top) / this._zoomLevel;
					const orthoPts = this._computeOrthogonalWaypoints(x1, y1, fromPort, x2, y2, toPort, link.waypoints);
					const segIdx = this._findClosestSegmentOnWaypoints(orthoPts, mouseX, mouseY);
					this._startLinkSegmentDrag(e, link, orthoPts, segIdx, mouseX, mouseY, false);
				}
			};
			path.onmousedown = onLineMouseDown;
			hitPath.onmousedown = onLineMouseDown;

			const onLineClick = (e: MouseEvent) => {
				e.stopPropagation();
				if (routingMode === 'orthogonal') {
					// Handled in _onMouseUp when _isDraggingLinkSegment finishes without moving
					return;
				}
				const isMultiKey = e.shiftKey || e.ctrlKey || e.metaKey;
				if (!isMultiKey) {
					this._selectedLinkIds.clear();
					this._selectedNodeIds.clear();
					this._selectedLinkIds.add(link.id);
				} else {
					if (this._selectedLinkIds.has(link.id)) {
						this._selectedLinkIds.delete(link.id);
					} else {
						this._selectedLinkIds.add(link.id);
					}
				}
				this._isInspectorCollapsed = false;
				this._inspectorEl?.classList.remove('collapsed');
				this._inspectorTogglePill?.classList.add('hidden');
				this._renderNodes();
				this._drawLinks();
				if (this._inspectorEl) {
					this._renderInspector(this._inspectorEl);
				}
			};
			path.onclick = onLineClick;
			hitPath.onclick = onLineClick;

			// Render text label badge if present
			let renderedLabelPt: { x: number; y: number } | undefined;
			if (link.label) {
				const labelPos = typeof link.labelPosition === 'number' ? link.labelPosition : 0.5;
				const labelPt = this._computePointFromCoords(startCoords.x, startCoords.y, fromPort, endCoords.x, endCoords.y, toPort, routingMode, labelPos, link.waypoints);
				renderedLabelPt = labelPt;

				const dx = endCoords.x - startCoords.x;
				const dy = endCoords.y - startCoords.y;
				const linkDist = Math.hypot(dx, dy);
				// Generous default max width so condition expressions display more content without prematurely wrapping/truncating
				const maxLabelWidth = Math.max(220, Math.min(360, Math.round(linkDist * 0.9)));

				const labelEl = append(this._linkDeletesContainer, $('.workflow-link-label'));
				this._renderLinkLabelContent(labelEl, link.label, linkState?.status);
				labelEl.setAttribute('data-link-id', link.id);
				if (!this._linkLabelEls.has(link.id)) {
					this._linkLabelEls.set(link.id, labelEl);
				}
				labelEl.style.left = `${labelPt.x}px`;
				labelEl.style.top = `${labelPt.y}px`;
				if (typeof link.labelWidth === 'number') {
					labelEl.style.width = `${link.labelWidth}px`;
					labelEl.style.maxWidth = 'none';
				} else {
					labelEl.style.maxWidth = `${maxLabelWidth}px`;
				}
				if (typeof link.labelHeight === 'number') {
					labelEl.style.height = `${link.labelHeight}px`;
					labelEl.style.maxHeight = 'none';
				}
				labelEl.title = `${link.label}\n\n• Drag along line to reposition\n• Drag bottom-right corner to resize\n• Double-click to edit (Type @ to autocomplete variables)`;

				// Resize handle at bottom-right corner of the condition box
				const labelResizeHandle = append(labelEl, $('.link-label-resize-handle'));
				labelResizeHandle.title = 'Drag to resize condition box';
				labelResizeHandle.onmousedown = (e) => {
					e.stopPropagation();
					e.preventDefault();
					this._isResizingLinkLabel = link.id;
					this._resizeLinkLabelStartWidth = link.labelWidth ?? labelEl.offsetWidth;
					this._resizeLinkLabelStartHeight = link.labelHeight ?? labelEl.offsetHeight;
					this._resizeLinkLabelStartX = e.clientX;
					this._resizeLinkLabelStartY = e.clientY;
				};
				labelResizeHandle.onclick = (e) => {
					e.stopPropagation();
				};
				labelResizeHandle.ondblclick = (e) => {
					e.stopPropagation();
				};
				if (isSelected) {
					labelEl.classList.add('selected');
				}

				if (linkState?.status === 'error') {
					labelEl.classList.add('status-error');
					labelEl.title = `[!] Condition Error / Blocked\nCondition: ${link.label}\n${linkState.error ? `Error: ${linkState.error}\n` : ''}${linkState.explanation || 'Execution blocked at this condition.'}`;
				} else if (linkState?.status === 'passed') {
					labelEl.classList.add('status-passed');
					labelEl.title = `[✓] Condition Matched: ${link.label}\n${linkState.explanation || ''}`;
				} else if (linkState?.status === 'rejected') {
					labelEl.classList.add('status-rejected');
					labelEl.title = `[\u2717] Condition Rejected: ${link.label}\n${linkState.explanation || ''}`;
				}

				labelEl.onmousedown = (e) => {
					e.stopPropagation();
					if (e.button !== 0) { return; }
					const now = Date.now();
					const lastLabelClick = link._lastLabelClickTime || 0;
					link._lastLabelClickTime = now;
					if (now - lastLabelClick < 350) {
						link._lastLabelClickTime = 0;
						this._isDraggingLinkLabel = null;
						e.preventDefault();
						const currentPt = this._computePointFromCoords(startCoords.x, startCoords.y, fromPort, endCoords.x, endCoords.y, toPort, routingMode, typeof link.labelPosition === 'number' ? link.labelPosition : 0.5, link.waypoints);
						this._showLinkInlineEditor(link, currentPt.x, currentPt.y);
						return;
					}
					this._isDraggingLinkLabel = link.id;
					this._dragLabelHasMoved = false;
					this._dragLabelStartX = e.clientX;
					this._dragLabelStartY = e.clientY;
					labelEl.classList.add('dragging');
				};

				labelEl.onclick = (e) => {
					e.stopPropagation();
					if (this._dragLabelHasMoved) { return; }

					const isMultiKey = e.shiftKey || e.ctrlKey || e.metaKey;
					if (!isMultiKey) {
						this._selectedLinkIds.clear();
						this._selectedNodeIds.clear();
						this._selectedLinkIds.add(link.id);
					} else {
						if (this._selectedLinkIds.has(link.id)) {
							this._selectedLinkIds.delete(link.id);
						} else {
							this._selectedLinkIds.add(link.id);
						}
					}
					this._renderNodes();
					this._drawLinks();
				};

				labelEl.ondblclick = (e) => {
					e.stopPropagation();
					e.preventDefault();
					const currentPt = this._computePointFromCoords(startCoords.x, startCoords.y, fromPort, endCoords.x, endCoords.y, toPort, routingMode, typeof link.labelPosition === 'number' ? link.labelPosition : 0.5, link.waypoints);
					this._showLinkInlineEditor(link, currentPt.x, currentPt.y);
				};

				labelEl.oncontextmenu = (e) => {
					e.preventDefault();
					e.stopPropagation();
					this._showContextMenu(e.clientX, e.clientY, 'link', link.id);
				};
			}

			// Render orthogonal segment drag handles so users can grab and pull any segment outward/inward
			const segmentHandles: HTMLElement[] = [];
			if (routingMode === 'orthogonal') {
				const orthoPts = this._computeOrthogonalWaypoints(x1, y1, fromPort, x2, y2, toPort, link.waypoints);
				for (let segIdx = 0; segIdx < orthoPts.length - 1; segIdx++) {
					const pA = orthoPts[segIdx];
					const pB = orthoPts[segIdx + 1];
					const segLen = Math.hypot(pB.x - pA.x, pB.y - pA.y);
					const isInterior = segIdx > 0 && segIdx < orthoPts.length - 2;
					if (segLen < (isInterior ? 16 : 36)) { continue; }

					const isVert = Math.abs(pA.x - pB.x) <= Math.abs(pA.y - pB.y);
					let hx = Math.round((pA.x + pB.x) / 2);
					let hy = Math.round((pA.y + pB.y) / 2);

					// If condition label is sitting near the midpoint of this segment, shift the handle along the segment so it stays accessible
					if (renderedLabelPt && Math.abs(hx - renderedLabelPt.x) < 70 && Math.abs(hy - renderedLabelPt.y) < 32 && segLen >= 80) {
						hx = Math.round(pA.x + (pB.x - pA.x) * 0.22);
						hy = Math.round(pA.y + (pB.y - pA.y) * 0.22);
					}

					const segHandle = append(this._linkDeletesContainer, $(`.workflow-link-segment-handle.${isVert ? 'vertical' : 'horizontal'}`));
					segHandle.style.left = `${hx}px`;
					segHandle.style.top = `${hy}px`;
					segHandle.title = isVert
						? 'Drag left/right to adjust line path · Double-click to add/edit condition (Alt+Double-click to reset path)'
						: 'Drag up/down to adjust line path · Double-click to add/edit condition (Alt+Double-click to reset path)';
					if (isSelected || this._isDraggingLinkSegment === link.id) {
						segHandle.classList.add('selected');
					}
					segHandle.onmousedown = (e) => {
						if (e.button !== 0) { return; }
						const now = Date.now();
						const lastSegClick = link._lastLineClickTime || 0;
						link._lastLineClickTime = now;
						if (now - lastSegClick < 350) {
							link._lastLineClickTime = 0;
							this._isDraggingLinkSegment = null;
							e.stopPropagation();
							e.preventDefault();
							if (e.altKey || e.shiftKey) {
								delete link.waypoints;
								this._saveFlowchartData();
								this._drawLinks();
							} else {
								const curMid = this._computeMidpointFromCoords(startCoords.x, startCoords.y, fromPort, endCoords.x, endCoords.y, toPort, routingMode, link.waypoints);
								this._showLinkInlineEditor(link, curMid.x, curMid.y);
							}
							return;
						}
						if (!this._canvas) { return; }
						const rect = this._canvas.getBoundingClientRect();
						const mx = (e.clientX - rect.left) / this._zoomLevel;
						const my = (e.clientY - rect.top) / this._zoomLevel;
						this._startLinkSegmentDrag(e, link, orthoPts, segIdx, mx, my, true);
					};
					segHandle.ondblclick = (e) => {
						e.stopPropagation();
						e.preventDefault();
						if (e.altKey || e.shiftKey) {
							delete link.waypoints;
							this._saveFlowchartData();
							this._drawLinks();
						} else {
							const curMid = this._computeMidpointFromCoords(startCoords.x, startCoords.y, fromPort, endCoords.x, endCoords.y, toPort, routingMode, link.waypoints);
							this._showLinkInlineEditor(link, curMid.x, curMid.y);
						}
					};
					segHandle.oncontextmenu = onLineContextMenu;
					segmentHandles.push(segHandle);
				}
			}

			// Reconnection handles (rendered at x1, y1 and x2, y2)
			const handleStart = append(this._linkDeletesContainer, $(`.workflow-link-endpoint-handle.start.handle-${link.id}`));
			handleStart.style.left = `${x1}px`;
			handleStart.style.top = `${y1}px`;
			handleStart.title = 'Drag to reconnect start';
			if (isSelected) {
				handleStart.classList.add('selected');
			}

			const handleEnd = append(this._linkDeletesContainer, $(`.workflow-link-endpoint-handle.end.handle-${link.id}`));
			handleEnd.style.left = `${x2}px`;
			handleEnd.style.top = `${y2}px`;
			handleEnd.title = 'Drag to reconnect end';
			if (isSelected) {
				handleEnd.classList.add('selected');
			}

			// Add hover linking
			const onHoverEnter = () => {
				handleStart.classList.add('hovered');
				handleEnd.classList.add('hovered');
				segmentHandles.forEach(h => h.classList.add('hovered'));
			};
			const onHoverLeave = () => {
				handleStart.classList.remove('hovered');
				handleEnd.classList.remove('hovered');
				segmentHandles.forEach(h => h.classList.remove('hovered'));
			};
			path.onmouseenter = onHoverEnter;
			path.onmouseleave = onHoverLeave;
			hitPath.onmouseenter = onHoverEnter;
			hitPath.onmouseleave = onHoverLeave;

			handleStart.onmousedown = (e) => {
				e.stopPropagation();
				e.preventDefault();
				const rect = this._canvas!.getBoundingClientRect();
				this._isReconnectingStart = link.id;
				this._tempLinkStartX = (e.clientX - rect.left) / this._zoomLevel;
				this._tempLinkStartY = (e.clientY - rect.top) / this._zoomLevel;
				this._tempLinkFixedX = x2;
				this._tempLinkFixedY = y2;
			};

			handleEnd.onmousedown = (e) => {
				e.stopPropagation();
				e.preventDefault();
				const rect = this._canvas!.getBoundingClientRect();
				this._isReconnectingEnd = link.id;
				this._tempLinkStartX = (e.clientX - rect.left) / this._zoomLevel;
				this._tempLinkStartY = (e.clientY - rect.top) / this._zoomLevel;
				this._tempLinkFixedX = x1;
				this._tempLinkFixedY = y1;
			};
		}
	}

	override focus(): void {
		super.focus();
	}

	private _contextMenuEl: HTMLElement | undefined;

	private _showContextMenu(x: number, y: number, targetType: 'node' | 'link' | 'canvas', targetId: string): void {
		this._closeContextMenu();

		const menu = append(this._targetWindow.document.body, $('.workflow-context-menu'));
		this._contextMenuEl = menu;
		menu.style.position = 'fixed';
		menu.style.left = `${x}px`;
		menu.style.top = `${y}px`;
		menu.style.zIndex = '20000';

		const totalSelected = this._selectedNodeIds.size + this._selectedLinkIds.size;
		const isMulti = totalSelected > 1;

		if (targetType === 'node') {
			// Ensure targetNode is in the selection if we right click it
			if (!this._selectedNodeIds.has(targetId)) {
				this._selectedNodeIds.clear();
				this._selectedLinkIds.clear();
				this._selectedNodeIds.add(targetId);
				this._renderNodes();
				this._drawLinks();
			}

			if (!this._isPureDiagram) {
				const selectedActionNodes = Array.from(this._selectedNodeIds)
					.map(id => this._data.nodes.find(n => n.id === id))
					.filter((n): n is IFlowchartNode => !!n && this._isActionNodeForSelectiveRun(n));
				if (selectedActionNodes.length > 0) {
					const runSelectedItem = append(menu, $('.context-menu-item'));
					runSelectedItem.style.color = '#38bdf8';
					runSelectedItem.style.fontWeight = '600';
					runSelectedItem.textContent = selectedActionNodes.length > 1
						? `\u25B6 Run Selected Nodes Only (${selectedActionNodes.length})`
						: `\u25B6 Run This Node Only`;
					runSelectedItem.onclick = async () => {
						this._closeContextMenu();
						if (!this._workflowUri) { return; }
						try {
							const selectedNodeIds = selectedActionNodes.map(n => n.id);
							this._openLogDrawer();
							this._clearDisplayInspectorCards();
							await this._workflowExecutionService.executeWorkflow(this._workflowUri, {
								mode: 'standard',
								initialData: this._data,
								entryNodeId: selectedNodeIds[0],
								selectedNodeIds
							});
							if (this._toolbarEl) { this._renderToolbar(this._toolbarEl); }
							this._renderNodes();
						} catch (e) {
							this._notificationService.error(e.message || String(e));
						}
					};
				}

				const runFromHereItem = append(menu, $('.context-menu-item'));
				runFromHereItem.textContent = '\u25B6 Run Workflow From This Node';
				runFromHereItem.onclick = async () => {
					this._closeContextMenu();
					if (!this._workflowUri) { return; }
					try {
						this._openLogDrawer();
						this._clearDisplayInspectorCards();
						await this._workflowExecutionService.executeWorkflow(this._workflowUri, {
							mode: 'standard',
							initialData: this._data,
							entryNodeId: targetId
						});
						if (this._toolbarEl) { this._renderToolbar(this._toolbarEl); }
						this._renderNodes();
					} catch (e) {
						this._notificationService.error(e.message || String(e));
					}
				};

				// Caller nodes: open the own canvas (live view while it runs) of each Sub-Workflow this node invokes
				const targetNodeForSub = this._data.nodes.find(n => n.id === targetId);
				const calledSubWorkflows = new Map<string, string>();
				for (const step of (targetNodeForSub?.pipeline || [])) {
					const comp = step?.component;
					if (comp?.type === 'sub_workflow' && comp.subWorkflowId) {
						const def = this._workflowExecutionService.getSubWorkflowById(comp.subWorkflowId);
						calledSubWorkflows.set(comp.subWorkflowId, def?.name || comp.subWorkflowName || comp.label || comp.subWorkflowId);
					}
				}
				for (const [subWorkflowId, subWorkflowName] of calledSubWorkflows) {
					const liveViewItem = append(menu, $('.context-menu-item'));
					liveViewItem.textContent = calledSubWorkflows.size > 1
						? `\u29C9 Open Sub-Workflow: ${subWorkflowName}`
						: '\u29C9 Open Sub-Workflow';
					liveViewItem.onclick = () => {
						this._closeContextMenu();
						openSubWorkflowLiveView(this._editorService, this._editorGroupService, this._workflowExecutionService, subWorkflowId, {
							parentWorkflowUri: this._workflowUri?.toString(),
							preserveFocus: false
						}).catch(e => this._notificationService.error(e?.message || String(e)));
					};
				}

				/*
				const pipelineItem = append(menu, $('.context-menu-item'));
				pipelineItem.textContent = 'Pipeline...';
				pipelineItem.onclick = () => {
					this._closeContextMenu();
					this._openNodePipelinePanel(targetId);
				};
				*/

				const fnItem = append(menu, $('.context-menu-item'));
				fnItem.textContent = 'Call Function [fx]...';
				fnItem.onclick = () => {
					this._closeContextMenu();
					const targetNode = this._data.nodes.find(n => n.id === targetId);
					if (targetNode) {
						this._openNodeFunctionInlineEditor(targetNode);
					}
				};

				const varItem = append(menu, $('.context-menu-item'));
				varItem.textContent = 'Context Variable [V]...';
				varItem.onclick = () => {
					this._closeContextMenu();
					const targetNode = this._data.nodes.find(n => n.id === targetId);
					if (targetNode) {
						this._openNodeVariableInlineEditor(targetNode);
					}
				};

				const editAsPyItem = append(menu, $('.context-menu-item'));
				editAsPyItem.textContent = 'Edit as a Python File';
				editAsPyItem.onclick = () => {
					this._closeContextMenu();
					this._openWorkflowAsPythonFile(targetId);
				};

				const editAsNbItem = append(menu, $('.context-menu-item'));
				editAsNbItem.textContent = 'Edit as a Jupyter Notebook';
				editAsNbItem.onclick = () => {
					this._closeContextMenu();
					WorkflowPythonEditorBridge.openWorkflowAsNotebook(this, targetId);
				};

				const encapSubWfItem = append(menu, $('.context-menu-item'));
				const selCount = this._selectedNodeIds.has(targetId) ? this._selectedNodeIds.size : 1;
				encapSubWfItem.textContent = `Encapsulate as Sub-Workflow (${selCount} node${selCount > 1 ? 's' : ''})...`;
				encapSubWfItem.onclick = () => {
					this._closeContextMenu();
					if (!this._selectedNodeIds.has(targetId)) {
						this._selectedNodeIds.clear();
						this._selectedNodeIds.add(targetId);
					}
					this._isSubWorkflowDropdownOpen = true;
					this._showEncapsulateForm = true;
					this._renderSubWorkflowDropdown();
				};
			}
		}

		if (this._undoStack.length > 0) {
			const undoItem = append(menu, $('.context-menu-item'));
			undoItem.textContent = 'Undo (Ctrl+Z)';
			undoItem.onclick = () => {
				this._closeContextMenu();
				this._undo();
			};
		}

		if (this._redoStack.length > 0) {
			const redoItem = append(menu, $('.context-menu-item'));
			redoItem.textContent = 'Redo (Ctrl+Y)';
			redoItem.onclick = () => {
				this._closeContextMenu();
				this._redo();
			};
		}

		if (this._copiedNodes.length > 0) {
			const pasteItem = append(menu, $('.context-menu-item'));
			pasteItem.textContent = `Paste Node(s) (${this._copiedNodes.length}) (Ctrl+V)`;
			pasteItem.onclick = () => {
				this._closeContextMenu();
				this._pasteNodes(this._clientToCanvasCoords(x, y));
			};
		}

		if (targetType === 'node') {
			if (!this._isPureDiagram) {
				const importItem = append(menu, $('.context-menu-item'));
				importItem.textContent = 'Import';
				importItem.onclick = () => {
					this._closeContextMenu();
					this._importIntoNode(targetId);
				};

				const addSubModuleItem = append(menu, $('.context-menu-item'));
				addSubModuleItem.textContent = 'Create Sub-Module...';
				addSubModuleItem.onclick = () => {
					this._closeContextMenu();
					this._viewsService.openView<MainWorkspaceViewPane>('workbench.workspacesExplorer.mainPane', true).then(workspacesView => {
						if (workspacesView && typeof workspacesView.showCreateResourceModal === 'function') {
							workspacesView.showCreateResourceModal(this._workflowUri, this._inputNameProperty() || '', (type: string, name: string) => {
								const node = this._data.nodes.find(n => n.id === targetId);
								if (node) {
									if (!node.imports) {
										node.imports = [];
									}
									if (!node.imports.some(imp => imp.type === type && imp.name === name)) {
										node.imports.push({ type, name });
										if (!node.pipeline) { node.pipeline = []; }
										const newStep: INodePipelineStep = {
											id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
											type: 'run_ticket',
											ticketName: name,
											ticketType: type
										};
										node.pipeline.push(newStep);
										this._saveFlowchartData();
										this._renderNodes();
										this._drawLinks();
										if (this._pipelinePanelEl && this._activePipelineNodeId === node.id) {
											this._renderPipelinePanel(this._pipelinePanelEl, node);
										}
										this._notificationService.info(`Successfully created and imported ${type} '${name}' into '${node.label}'`);
									}
								}
							});
						}
					});
				};
			}

			const copyItem = append(menu, $('.context-menu-item'));
			copyItem.textContent = 'Copy Node (Ctrl+C)';
			copyItem.onclick = () => {
				this._closeContextMenu();
				this._copySelectedNodes();
			};

			if (!this._isPureDiagram) {
				const pasteCapItem = append(menu, $('.context-menu-item'));
				pasteCapItem.style.color = '#c084fc';
				const setPasteLabel = (step: INodePipelineStep) => {
					const capLabel = step.targetVariable
						|| step.label
						|| step.ticketName
						|| step.component?.label
						|| step.functionName
						|| 'Capsule';
					pasteCapItem.textContent = `Paste Capsule "${capLabel}"`;
					pasteCapItem.style.display = '';
				};
				if (WorkflowEditor._copiedCapsule) {
					setPasteLabel(WorkflowEditor._copiedCapsule.step);
				} else {
					pasteCapItem.style.display = 'none';
					void this._clipboardService.readText().then(rawClip => {
						const trimmed = (rawClip || '').trim();
						if (trimmed.startsWith('{') && trimmed.includes('__anyagent_capsule_v1__')) {
							try {
								const parsed = JSON.parse(trimmed);
								if (parsed?.__anyagent_capsule_v1__ && parsed.step) {
									WorkflowEditor._copiedCapsule = {
										step: parsed.step,
										sourceNodeLabel: parsed.sourceNodeLabel,
										sourceVars: Array.isArray(parsed.sourceVars) ? parsed.sourceVars : []
									};
									setPasteLabel(parsed.step);
								}
							} catch { }
						}
					}).catch(() => { });
				}
				pasteCapItem.onclick = () => {
					this._closeContextMenu();
					const targetNode = this._data.nodes.find(n => n.id === targetId);
					if (targetNode) {
						void this._pasteCapsuleIntoNode(targetNode);
					}
				};
			}

			// Group & Ungroup Menu Items
			if (this._selectedNodeIds.size >= 2) {
				const groupItem = append(menu, $('.context-menu-item'));
				groupItem.textContent = `Group (${this._selectedNodeIds.size}) (Ctrl+G)`;
				groupItem.onclick = () => {
					this._closeContextMenu();
					this._groupSelectedNodes();
				};
			}

			const anyGrouped = Array.from(this._selectedNodeIds).some(nid => {
				const n = this._data.nodes.find(node => node.id === nid);
				return !!n?.groupId;
			});
			if (anyGrouped) {
				const ungroupItem = append(menu, $('.context-menu-item'));
				ungroupItem.textContent = 'Ungroup (Shift+Ctrl+G)';
				ungroupItem.onclick = () => {
					this._closeContextMenu();
					this._ungroupSelectedNodes();
				};
			}

			const nodeObj = this._data.nodes.find(n => n.id === targetId);

			// Node Color Submenu
			const changeColorItem = append(menu, $('.context-menu-item.submenu-trigger'));
			changeColorItem.textContent = 'Node Color \u203A';
			changeColorItem.style.position = 'relative';

			const colorSubmenu = append(changeColorItem, $('.workflow-context-submenu'));
			colorSubmenu.style.position = 'absolute';
			colorSubmenu.style.left = '100%';
			colorSubmenu.style.top = '-4px';
			colorSubmenu.style.display = 'none';

			changeColorItem.onmouseenter = () => { colorSubmenu.style.display = 'flex'; };
			changeColorItem.onmouseleave = () => { colorSubmenu.style.display = 'none'; };

			const nodeColors = [
				{ name: 'White', hex: '#ffffff' },
				{ name: 'Teal (Default)', hex: '#0d9488' },
				{ name: 'Sky Blue', hex: '#38bdf8' },
				{ name: 'Violet Purple', hex: '#7c3aed' },
				{ name: 'Amber Gold', hex: '#facc15' },
				{ name: 'Rose Red', hex: '#f43f5e' }
			];

			const currentNodeColor = nodeObj?.color || '#0d9488';
			for (const c of nodeColors) {
				const cItem = append(colorSubmenu, $('.context-menu-item'));
				cItem.style.display = 'flex';
				cItem.style.alignItems = 'center';
				cItem.style.gap = '8px';

				const dot = append(cItem, $('span.color-dot'));
				dot.style.width = '10px';
				dot.style.height = '10px';
				dot.style.borderRadius = '50%';
				dot.style.backgroundColor = c.hex;
				dot.style.border = '1px solid rgba(255,255,255,0.4)';

				const labelSpan = append(cItem, $('span'));
				labelSpan.textContent = c.name + (currentNodeColor.toLowerCase() === c.hex.toLowerCase() ? ' ✓' : '');

				cItem.onclick = (e) => {
					e.stopPropagation();
					this._closeContextMenu();
					if (nodeObj) {
						nodeObj.color = c.hex;
						this._saveFlowchartData();
						this._renderNodes();
						this._drawLinks();
					}
				};
			}

			// Text Formatting & Alignment Submenu
			const textStyleItem = append(menu, $('.context-menu-item.submenu-trigger'));
			textStyleItem.textContent = 'Text Formatting \u203A';
			textStyleItem.style.position = 'relative';

			const textSubmenu = append(textStyleItem, $('.workflow-context-submenu'));
			textSubmenu.style.position = 'absolute';
			textSubmenu.style.left = '100%';
			textSubmenu.style.top = '-4px';
			textSubmenu.style.display = 'none';

			textStyleItem.onmouseenter = () => { textSubmenu.style.display = 'flex'; };
			textStyleItem.onmouseleave = () => { textSubmenu.style.display = 'none'; };

			// Style toggles
			const boldItem = append(textSubmenu, $('.context-menu-item'));
			boldItem.textContent = `Bold${nodeObj?.isBold ? ' ✓' : ''}`;
			boldItem.onclick = (e) => {
				e.stopPropagation();
				this._closeContextMenu();
				if (nodeObj) {
					nodeObj.isBold = !nodeObj.isBold;
					this._saveFlowchartData();
					this._renderNodes();
				}
			};

			const italicItem = append(textSubmenu, $('.context-menu-item'));
			italicItem.textContent = `Italic${nodeObj?.isItalic ? ' ✓' : ''}`;
			italicItem.onclick = (e) => {
				e.stopPropagation();
				this._closeContextMenu();
				if (nodeObj) {
					nodeObj.isItalic = !nodeObj.isItalic;
					this._saveFlowchartData();
					this._renderNodes();
				}
			};

			const underlineItem = append(textSubmenu, $('.context-menu-item'));
			underlineItem.textContent = `Underline${nodeObj?.isUnderline ? ' ✓' : ''}`;
			underlineItem.onclick = (e) => {
				e.stopPropagation();
				this._closeContextMenu();
				if (nodeObj) {
					nodeObj.isUnderline = !nodeObj.isUnderline;
					this._saveFlowchartData();
					this._renderNodes();
				}
			};

			const strikeItem = append(textSubmenu, $('.context-menu-item'));
			strikeItem.textContent = `Strikethrough${nodeObj?.isStrikethrough ? ' ✓' : ''}`;
			strikeItem.onclick = (e) => {
				e.stopPropagation();
				this._closeContextMenu();
				if (nodeObj) {
					nodeObj.isStrikethrough = !nodeObj.isStrikethrough;
					this._saveFlowchartData();
					this._renderNodes();
				}
			};

			append(textSubmenu, $('.context-menu-separator'));

			// Horizontal Alignments
			const textAligns: { align: 'left' | 'center' | 'right'; label: string }[] = [
				{ align: 'left', label: 'Align Left' },
				{ align: 'center', label: 'Align Center' },
				{ align: 'right', label: 'Align Right' }
			];
			const currentTextAlign = nodeObj?.textAlign || 'center';
			for (const ta of textAligns) {
				const taItem = append(textSubmenu, $('.context-menu-item'));
				taItem.textContent = ta.label + (currentTextAlign === ta.align ? ' ✓' : '');
				taItem.onclick = (e) => {
					e.stopPropagation();
					this._closeContextMenu();
					if (nodeObj) {
						nodeObj.textAlign = ta.align;
						this._saveFlowchartData();
						this._renderNodes();
					}
				};
			}

			append(textSubmenu, $('.context-menu-separator'));

			// Vertical Alignments
			const vAligns: { align: 'top' | 'center' | 'bottom'; label: string }[] = [
				{ align: 'top', label: 'Align Top' },
				{ align: 'center', label: 'Align Middle' },
				{ align: 'bottom', label: 'Align Bottom' }
			];
			const currentVAlign = nodeObj?.verticalAlign || 'center';
			for (const va of vAligns) {
				const vaItem = append(textSubmenu, $('.context-menu-item'));
				vaItem.textContent = va.label + (currentVAlign === va.align ? ' ✓' : '');
				vaItem.onclick = (e) => {
					e.stopPropagation();
					this._closeContextMenu();
					if (nodeObj) {
						nodeObj.verticalAlign = va.align;
						this._saveFlowchartData();
						this._renderNodes();
					}
				};
			}

			append(textSubmenu, $('.context-menu-separator'));

			// Text Colors
			const textColorTrigger = append(textSubmenu, $('.context-menu-item.submenu-trigger'));
			textColorTrigger.textContent = 'Text Color \u203A';
			textColorTrigger.style.position = 'relative';

			const textColorSubmenu = append(textColorTrigger, $('.workflow-context-submenu'));
			textColorSubmenu.style.position = 'absolute';
			textColorSubmenu.style.left = '100%';
			textColorSubmenu.style.top = '-4px';
			textColorSubmenu.style.display = 'none';

			textColorTrigger.onmouseenter = () => { textColorSubmenu.style.display = 'flex'; };
			textColorTrigger.onmouseleave = () => { textColorSubmenu.style.display = 'none'; };

			const textColors = [
				{ name: 'Pure White (Default)', hex: '#ffffff' },
				{ name: 'Muted Slate', hex: '#94a3b8' },
				{ name: 'Gold Yellow', hex: '#facc15' },
				{ name: 'Sky Blue', hex: '#38bdf8' },
				{ name: 'Rose Red', hex: '#f43f5e' },
				{ name: 'Emerald Green', hex: '#4ade80' },
				{ name: 'Match Border Color', hex: 'MATCH_BORDER' }
			];
			const currentTextColor = nodeObj?.textColor || '#ffffff';

			for (const tc of textColors) {
				const tcItem = append(textColorSubmenu, $('.context-menu-item'));
				tcItem.style.display = 'flex';
				tcItem.style.alignItems = 'center';
				tcItem.style.gap = '8px';

				const dot = append(tcItem, $('span.color-dot'));
				dot.style.width = '10px';
				dot.style.height = '10px';
				dot.style.borderRadius = '50%';
				dot.style.backgroundColor = tc.hex === 'MATCH_BORDER' ? (nodeObj?.color || '#0d9488') : tc.hex;
				dot.style.border = '1px solid rgba(255,255,255,0.4)';

				const labelSpan = append(tcItem, $('span'));
				labelSpan.textContent = tc.name + (currentTextColor === tc.hex ? ' ✓' : '');

				tcItem.onclick = (e) => {
					e.stopPropagation();
					this._closeContextMenu();
					if (nodeObj) {
						if (tc.hex === 'MATCH_BORDER') {
							nodeObj.textColor = nodeObj.color || '#0d9488';
						} else {
							nodeObj.textColor = tc.hex;
						}
						this._saveFlowchartData();
						this._renderNodes();
					}
				};
			}

			// Change Shape menu item with hover submenu
			const changeShapeItem = append(menu, $('.context-menu-item.submenu-trigger'));
			changeShapeItem.textContent = 'Change Shape \u203A';
			changeShapeItem.style.position = 'relative';

			const submenu = append(changeShapeItem, $('.workflow-context-submenu'));
			submenu.style.position = 'absolute';
			submenu.style.left = '100%';
			submenu.style.top = '-4px'; // align with parent padding
			submenu.style.display = 'none';

			changeShapeItem.onmouseenter = () => {
				submenu.style.display = 'flex';
			};
			changeShapeItem.onmouseleave = () => {
				submenu.style.display = 'none';
			};

			const shapes: { type: IFlowchartNode['type']; label: string }[] = [
				{ type: 'round-rect', label: 'Round Rect' },
				{ type: 'rect', label: 'Rectangle' },
				{ type: 'diamond', label: 'Decision' },
				{ type: 'circle', label: 'Circle' }
			];

			for (const sh of shapes) {
				const subItem = append(submenu, $('.context-menu-item'));
				subItem.textContent = sh.label;
				subItem.onclick = (e) => {
					e.stopPropagation();
					this._closeContextMenu();
					const node = this._data.nodes.find(n => n.id === targetId);
					if (node) {
						node.type = sh.type;
						this._saveFlowchartData();
						this._renderNodes();
						this._drawLinks();
					}
				};
			}

			const deleteItem = append(menu, $('.context-menu-item.danger'));
			deleteItem.textContent = isMulti ? `Delete Selected Items (${totalSelected})` : 'Delete Node';
			deleteItem.onclick = () => {
				this._closeContextMenu();
				if (isMulti) {
					this._deleteSelectedItems();
				} else {
					this._deleteNode(targetId);
				}
			};

			// Export Selection Submenu
			const exportSelItem = append(menu, $('.context-menu-item.submenu-trigger'));
			exportSelItem.textContent = isMulti ? `Export Selected (${totalSelected}) \u203A` : 'Export Node Image \u203A';
			exportSelItem.style.position = 'relative';

			const exportSelSubmenu = append(exportSelItem, $('.workflow-context-submenu'));
			exportSelSubmenu.style.position = 'absolute';
			exportSelSubmenu.style.left = '100%';
			exportSelSubmenu.style.top = '-4px';
			exportSelSubmenu.style.display = 'none';

			exportSelItem.onmouseenter = () => { exportSelSubmenu.style.display = 'flex'; };
			exportSelItem.onmouseleave = () => { exportSelSubmenu.style.display = 'none'; };

			const selFormats: { label: string; format: 'png' | 'jpeg' | 'svg' | 'pdf' }[] = [
				{ label: 'Export as PNG (.png)', format: 'png' },
				{ label: 'Export as JPEG (.jpg)', format: 'jpeg' },
				{ label: 'Export as SVG (.svg)', format: 'svg' },
				{ label: 'Export as PDF (.pdf)', format: 'pdf' }
			];

			for (const fmt of selFormats) {
				const fItem = append(exportSelSubmenu, $('.context-menu-item'));
				fItem.textContent = fmt.label;
				fItem.onclick = (e) => {
					e.stopPropagation();
					this._closeContextMenu();
					this._exportDiagram(fmt.format, true);
				};
			}

			// Separator before module inspection submenu
			append(menu, $('.context-menu-separator'));

			// View / Open Imported Modules Submenu (lists every imported module without deduplication/collapsing)
			if (!this._isPureDiagram && nodeObj && nodeObj.imports && nodeObj.imports.length > 0) {
				const openModulesItem = append(menu, $('.context-menu-item.submenu-trigger'));
				openModulesItem.textContent = `Open Module (${nodeObj.imports.length}) \u203A`;
				openModulesItem.style.position = 'relative';

				const modulesSubmenu = append(openModulesItem, $('.workflow-context-submenu'));
				modulesSubmenu.style.position = 'absolute';
				modulesSubmenu.style.left = '100%';
				modulesSubmenu.style.top = '-4px';
				modulesSubmenu.style.display = 'none';

				for (const imp of nodeObj.imports) {
					const item = append(modulesSubmenu, $('.context-menu-item.module-item'));
					item.style.display = 'flex';
					item.style.alignItems = 'center';
					item.style.gap = '8px';

					let codicon = Codicon.package;
					let color = '';
					const lower = (imp.type || '').toLowerCase();

					if (lower === 'agent') {
						codicon = Codicon.robot;
						color = '#38bdf8';
					} else if (lower === 'task') {
						codicon = Codicon.checklist;
						color = '#a78bfa';
					} else if (lower === 'job') {
						codicon = Codicon.rocket;
						color = '#fbbf24';
					} else if (lower === 'project') {
						codicon = Codicon.project;
						color = '#60a5fa';
					} else if (lower === 'case') {
						codicon = Codicon.beaker;
						color = '#f472b6';
					} else if (lower === 'issue') {
						codicon = Codicon.bug;
						color = '#ef4444';
					} else if (lower === 'analysis') {
						codicon = Codicon.graph;
						color = '#34d399';
					} else if (lower === 'workflow') {
						codicon = Codicon.githubAction;
						color = '#0d9488';
					} else {
						const v = getWorkflowEntityTypeVisual(imp.type);
						codicon = v.icon;
						color = v.color;
					}

					const iconEl = append(item, $('.module-icon'));
					iconEl.className = `${ThemeIcon.asClassName(codicon)} module-icon`;
					iconEl.style.color = color;

					const typeTag = append(item, $('span.module-type-tag'));
					typeTag.textContent = imp.type || 'module';
					typeTag.style.color = color;

					const nameSpan = append(item, $('span.module-name'));
					nameSpan.textContent = imp.name;
					nameSpan.title = `${imp.type}: ${imp.name}\nClick to open in editor tab`;

					item.onclick = (e) => {
						e.stopPropagation();
						this._closeContextMenu();
						this._openModuleInEditor(imp);
					};
				}

				openModulesItem.onmouseenter = () => {
					modulesSubmenu.style.display = 'flex';
				};
				openModulesItem.onmouseleave = () => {
					modulesSubmenu.style.display = 'none';
				};
			}
		} else if (targetType === 'canvas') {
			// Add Node submenu for quick creation
			const addNodeItem = append(menu, $('.context-menu-item.submenu-trigger'));
			addNodeItem.textContent = 'Add Node \u203A';
			addNodeItem.style.position = 'relative';

			const addNodeSubmenu = append(addNodeItem, $('.workflow-context-submenu'));
			addNodeSubmenu.style.position = 'absolute';
			addNodeSubmenu.style.left = '100%';
			addNodeSubmenu.style.top = '-4px';
			addNodeSubmenu.style.display = 'none';

			addNodeItem.onmouseenter = () => { addNodeSubmenu.style.display = 'flex'; };
			addNodeItem.onmouseleave = () => { addNodeSubmenu.style.display = 'none'; };

			const nodeTypes: { type: IFlowchartNode['type']; label: string; w: number; h: number }[] = [
				{ type: 'round-rect', label: 'Round Rect', w: 140, h: 48 },
				{ type: 'rect', label: 'Rectangle', w: 140, h: 48 },
				{ type: 'diamond', label: 'Decision (Diamond)', w: 100, h: 100 },
				{ type: 'circle', label: 'Circle Node', w: 70, h: 70 }
			];

			for (const nt of nodeTypes) {
				const ntItem = append(addNodeSubmenu, $('.context-menu-item'));
				ntItem.textContent = nt.label;
				ntItem.onclick = (e) => {
					e.stopPropagation();
					this._closeContextMenu();

					const rect = this._canvas!.getBoundingClientRect();
					const rawX = (x - rect.left) / this._zoomLevel;
					const rawY = (y - rect.top) / this._zoomLevel;
					const grid = 5;
					const nodeX = Math.round(rawX / grid) * grid;
					const nodeY = Math.round(rawY / grid) * grid;

					const id = `node_${Date.now()}`;
					const newNode: IFlowchartNode = {
						id,
						type: nt.type,
						x: Math.max(10, nodeX - Math.floor(nt.w / 2)),
						y: Math.max(10, nodeY - Math.floor(nt.h / 2)),
						width: nt.w,
						height: nt.h,
						label: nt.label.split(' ')[0],
						color: this._activeNodeColor,
						textColor: this._activeTextColor,
						textAlign: this._activeTextAlign,
						verticalAlign: this._activeVerticalAlign,
						isBold: this._activeIsBold,
						isItalic: this._activeIsItalic,
						isUnderline: this._activeIsUnderline,
						isStrikethrough: this._activeIsStrikethrough
					};
					this._data.nodes.push(newNode);
					this._selectedNodeIds.clear();
					this._selectedNodeIds.add(id);
					this._saveFlowchartData();
					this._renderNodes();
					this._drawLinks();
				};
			}

			if (!this._isPureDiagram) {
				const createModuleItem = append(menu, $('.context-menu-item'));
				createModuleItem.textContent = 'Create New Module...';
				createModuleItem.onclick = () => {
					this._closeContextMenu();
					this._viewsService.openView<MainWorkspaceViewPane>('workbench.workspacesExplorer.mainPane', true).then(workspacesView => {
						if (workspacesView && typeof workspacesView.showCreateResourceModal === 'function') {
							workspacesView.showCreateResourceModal(this._workflowUri, this._inputNameProperty() || '', (type: string, name: string) => {
								const rect = this._canvas!.getBoundingClientRect();
								const rawX = (x - rect.left) / this._zoomLevel;
								const rawY = (y - rect.top) / this._zoomLevel;
								const grid = 5;
								const nodeX = Math.round(rawX / grid) * grid;
								const nodeY = Math.round(rawY / grid) * grid;

								const id = `node_${Date.now()}`;
								const newNode: IFlowchartNode = {
									id,
									type: 'round-rect',
									x: Math.max(10, nodeX - 50),
									y: Math.max(10, nodeY - 25),
									width: 100,
									height: 50,
									label: name,
									imports: [{ type, name }],
									color: this._activeNodeColor,
									textColor: this._activeTextColor,
									textAlign: this._activeTextAlign,
									verticalAlign: this._activeVerticalAlign,
									isBold: this._activeIsBold,
									isItalic: this._activeIsItalic,
									isUnderline: this._activeIsUnderline,
									isStrikethrough: this._activeIsStrikethrough
								};
								this._data.nodes.push(newNode);
								this._selectedNodeIds.clear();
								this._selectedNodeIds.add(id);
								this._saveFlowchartData();
								this._renderNodes();
								this._drawLinks();
								this._notificationService.info(`Created new node for ${type} '${name}'`);
							});
						}
					});
				};

				const editCanvasAsPyItem = append(menu, $('.context-menu-item'));
				editCanvasAsPyItem.textContent = 'Edit as a Python File';
				editCanvasAsPyItem.onclick = () => {
					this._closeContextMenu();
					this._openWorkflowAsPythonFile();
				};

				const editCanvasAsNbItem = append(menu, $('.context-menu-item'));
				editCanvasAsNbItem.textContent = 'Edit as a Jupyter Notebook';
				editCanvasAsNbItem.onclick = () => {
					this._closeContextMenu();
					WorkflowPythonEditorBridge.openWorkflowAsNotebook(this);
				};
			}

			// Export Canvas Submenu
			const exportCanvasItem = append(menu, $('.context-menu-item.submenu-trigger'));
			exportCanvasItem.textContent = 'Export Canvas \u203A';
			exportCanvasItem.style.position = 'relative';

			const exportCanvasSubmenu = append(exportCanvasItem, $('.workflow-context-submenu'));
			exportCanvasSubmenu.style.position = 'absolute';
			exportCanvasSubmenu.style.left = '100%';
			exportCanvasSubmenu.style.top = '-4px';
			exportCanvasSubmenu.style.display = 'none';

			exportCanvasItem.onmouseenter = () => { exportCanvasSubmenu.style.display = 'flex'; };
			exportCanvasItem.onmouseleave = () => { exportCanvasSubmenu.style.display = 'none'; };

			const canvasFormats: { label: string; format: 'png' | 'jpeg' | 'svg' | 'pdf' }[] = [
				{ label: 'Export as PNG (.png)', format: 'png' },
				{ label: 'Export as JPEG (.jpg)', format: 'jpeg' },
				{ label: 'Export as SVG (.svg)', format: 'svg' },
				{ label: 'Export as PDF (.pdf)', format: 'pdf' }
			];

			for (const fmt of canvasFormats) {
				const fItem = append(exportCanvasSubmenu, $('.context-menu-item'));
				fItem.textContent = fmt.label;
				fItem.onclick = (e) => {
					e.stopPropagation();
					this._closeContextMenu();
					this._exportDiagram(fmt.format, false);
				};
			}
		} else {
			// Ensure targetLink is in the selection if we right click it
			if (!this._selectedLinkIds.has(targetId)) {
				this._selectedLinkIds.clear();
				this._selectedNodeIds.clear();
				this._selectedLinkIds.add(targetId);
				this._renderNodes();
				this._drawLinks();
			}

			const linkObj = this._data.links.find(l => l.id === targetId);
			const currentLinkRouting = linkObj?.routing || this._activeRoutingMode;

			// Edit / Add Label
			const editLabelItem = append(menu, $('.context-menu-item'));
			editLabelItem.textContent = linkObj?.label ? `Edit Label ("${linkObj.label}")` : 'Add Label...';
			editLabelItem.onclick = () => {
				this._closeContextMenu();
				if (linkObj) {
					const mid = this._getLinkMidpoint(linkObj);
					this._showLinkInlineEditor(linkObj, mid.x, mid.y);
				}
			};

			if (linkObj?.labelPosition !== undefined) {
				const resetLabelPosItem = append(menu, $('.context-menu-item'));
				resetLabelPosItem.textContent = 'Reset Label Position (Center)';
				resetLabelPosItem.onclick = () => {
					this._closeContextMenu();
					if (linkObj) {
						delete linkObj.labelPosition;
						this._saveFlowchartData();
						this._drawLinks();
					}
				};
			}

			if (linkObj?.waypoints && linkObj.waypoints.length > 0) {
				const resetWaypointsItem = append(menu, $('.context-menu-item'));
				resetWaypointsItem.textContent = 'Reset Line Path (Auto Route)';
				resetWaypointsItem.onclick = () => {
					this._closeContextMenu();
					if (linkObj) {
						delete linkObj.waypoints;
						this._saveFlowchartData();
						this._drawLinks();
					}
				};
			}

			// Line Color Submenu
			const lineColorItem = append(menu, $('.context-menu-item.submenu-trigger'));
			lineColorItem.textContent = 'Line Color \u203A';
			lineColorItem.style.position = 'relative';

			const lineColorSubmenu = append(lineColorItem, $('.workflow-context-submenu'));
			lineColorSubmenu.style.position = 'absolute';
			lineColorSubmenu.style.left = '100%';
			lineColorSubmenu.style.top = '-4px';
			lineColorSubmenu.style.display = 'none';

			lineColorItem.onmouseenter = () => { lineColorSubmenu.style.display = 'flex'; };
			lineColorItem.onmouseleave = () => { lineColorSubmenu.style.display = 'none'; };

			const lineColors = [
				{ name: 'White', hex: '#ffffff' },
				{ name: 'Teal (Default)', hex: '#0d9488' },
				{ name: 'Sky Blue', hex: '#38bdf8' },
				{ name: 'Violet Purple', hex: '#7c3aed' },
				{ name: 'Amber Gold', hex: '#facc15' },
				{ name: 'Rose Red', hex: '#f43f5e' }
			];
			const currentLineColor = linkObj?.color || '#0d9488';

			for (const lc of lineColors) {
				const lcItem = append(lineColorSubmenu, $('.context-menu-item'));
				lcItem.style.display = 'flex';
				lcItem.style.alignItems = 'center';
				lcItem.style.gap = '8px';

				const dot = append(lcItem, $('span.color-dot'));
				dot.style.width = '10px';
				dot.style.height = '10px';
				dot.style.borderRadius = '50%';
				dot.style.backgroundColor = lc.hex;
				dot.style.border = '1px solid rgba(255,255,255,0.4)';

				const labelSpan = append(lcItem, $('span'));
				labelSpan.textContent = lc.name + (currentLineColor.toLowerCase() === lc.hex.toLowerCase() ? ' ✓' : '');

				lcItem.onclick = (e) => {
					e.stopPropagation();
					this._closeContextMenu();
					if (linkObj) {
						linkObj.color = lc.hex;
						this._saveFlowchartData();
						this._drawLinks();
					}
				};
			}

			// Arrow Style Submenu
			const arrowStyleItem = append(menu, $('.context-menu-item.submenu-trigger'));
			arrowStyleItem.textContent = 'Arrow Style \u203A';
			arrowStyleItem.style.position = 'relative';

			const arrowSubmenu = append(arrowStyleItem, $('.workflow-context-submenu'));
			arrowSubmenu.style.position = 'absolute';
			arrowSubmenu.style.left = '100%';
			arrowSubmenu.style.top = '-4px';
			arrowSubmenu.style.display = 'none';

			arrowStyleItem.onmouseenter = () => { arrowSubmenu.style.display = 'flex'; };
			arrowStyleItem.onmouseleave = () => { arrowSubmenu.style.display = 'none'; };

			const arrowStyles: { style: IFlowchartLink['style']; label: string }[] = [
				{ style: 'arrow-single', label: 'Single Arrow (→)' },
				{ style: 'arrow-double', label: 'Double Arrow (↔)' },
				{ style: 'arrow-none', label: 'No Arrow (—)' },
				{ style: 'dashed', label: 'Dashed Line (\u254C)' }
			];
			const currentArrowStyle = linkObj?.style || 'arrow-single';

			for (const as of arrowStyles) {
				const asItem = append(arrowSubmenu, $('.context-menu-item'));
				asItem.textContent = as.label + (currentArrowStyle === as.style ? ' ✓' : '');
				asItem.onclick = (e) => {
					e.stopPropagation();
					this._closeContextMenu();
					if (linkObj) {
						linkObj.style = as.style;
						this._saveFlowchartData();
						this._drawLinks();
					}
				};
			}

			// Submenu to choose routing mode for this link
			const routingSubmenuTrigger = append(menu, $('.context-menu-item.submenu-trigger'));
			routingSubmenuTrigger.textContent = 'Routing Mode \u203A';
			routingSubmenuTrigger.style.position = 'relative';

			const routingSubmenu = append(routingSubmenuTrigger, $('.workflow-context-submenu'));
			routingSubmenu.style.position = 'absolute';
			routingSubmenu.style.left = '100%';
			routingSubmenu.style.top = '-4px';
			routingSubmenu.style.display = 'none';

			routingSubmenuTrigger.onmouseenter = () => { routingSubmenu.style.display = 'flex'; };
			routingSubmenuTrigger.onmouseleave = () => { routingSubmenu.style.display = 'none'; };

			const routingChoices: { mode: 'orthogonal' | 'curved'; label: string }[] = [
				{ mode: 'orthogonal', label: `Orthogonal (Right-Angle)${currentLinkRouting === 'orthogonal' ? ' ✓' : ''}` },
				{ mode: 'curved', label: `Curved (Smooth)${currentLinkRouting === 'curved' ? ' ✓' : ''}` }
			];

			for (const rc of routingChoices) {
				const rItem = append(routingSubmenu, $('.context-menu-item'));
				rItem.textContent = rc.label;
				rItem.onclick = (e) => {
					e.stopPropagation();
					this._closeContextMenu();
					if (linkObj) {
						linkObj.routing = rc.mode;
						this._saveFlowchartData();
						this._drawLinks();
					}
				};
			}

			const deleteItem = append(menu, $('.context-menu-item.danger'));
			deleteItem.textContent = isMulti ? `Delete Selected Items (${totalSelected})` : 'Delete Connection';
			deleteItem.onclick = () => {
				this._closeContextMenu();
				if (isMulti) {
					this._deleteSelectedItems();
				} else {
					this._data.links = this._data.links.filter(l => l.id !== targetId);
					this._saveFlowchartData();
					this._drawLinks();
				}
			};
		}

		// Close menu when clicking outside
		const clickListener = addDisposableListener(this._targetWindow, 'click', () => {
			this._closeContextMenu();
			clickListener.dispose();
		}, true);
	}

	private _closeContextMenu(): void {
		if (this._contextMenuEl) {
			this._contextMenuEl.remove();
			this._contextMenuEl = undefined;
		}
		while (this._contextMenuDisposables.length > 0) {
			try { this._contextMenuDisposables.pop()?.dispose(); } catch { }
		}
	}

	private _extractStepVariableNames(step: INodePipelineStep): string[] {
		const vars: string[] = [];
		const pushVar = (raw?: string) => {
			const clean = (raw || '').replace(/^@/, '').trim();
			if (clean && !vars.includes(clean)) {
				vars.push(clean);
			}
		};
		if (step.component) {
			const cType = step.component.type;
			if (cType !== 'parameters' && cType !== 'output' && cType !== 'display') {
				pushVar(step.component.outputVariableName || step.targetVariable || this._getComponentOutputVarName(step.component));
			}
		} else {
			if (step.targetVariable) {
				pushVar(step.targetVariable);
			}
			const expr = (step.expression || '').trim();
			const assignMatch = expr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=(?!=)/);
			if (assignMatch && assignMatch[1] && !WorkflowEditor._PYTHON_KEYWORDS.has(assignMatch[1])) {
				pushVar(assignMatch[1]);
			}
		}
		return vars;
	}

	private static _findHoveredNodeAcrossEditors(clientX: number, clientY: number): { editor: WorkflowEditor; nodeEl: HTMLElement; node: IFlowchartNode } | null {
		for (const ed of WorkflowEditor._openWorkflowEditors) {
			if (!ed.isVisible() || !ed._nodesContainer || ed._nodesContainer.offsetParent === null || !ed._data?.nodes) {
				continue;
			}
			// Ensure pointer is actually inside this split editor's canvas viewport
			const vpRect = (ed._canvasViewport || ed._container)?.getBoundingClientRect();
			if (vpRect && (clientX < vpRect.left || clientX > vpRect.right || clientY < vpRect.top || clientY > vpRect.bottom)) {
				continue;
			}
			const allNodeEls = ed._renderedNodeDoms().map(d => d.nodeEl);
			for (let idx = allNodeEls.length - 1; idx >= 0; idx--) {
				const candEl = allNodeEls[idx];
				const r = candEl.getBoundingClientRect();
				if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
					const candId = candEl.getAttribute('data-node-id');
					const candNode = candId ? ed._data.nodes.find(n => n.id === candId) || null : null;
					if (candNode) {
						return { editor: ed, nodeEl: candEl, node: candNode };
					}
				}
			}
		}
		return null;
	}

	private _cloneCapsulePayload(node: IFlowchartNode, step: INodePipelineStep): {
		step: INodePipelineStep;
		sourceNodeLabel?: string;
		sourceVars: Array<{ name: string; initialValue: string; expression?: string }>;
	} {
		const clonedStep: INodePipelineStep = JSON.parse(JSON.stringify(step));
		if (clonedStep.component) {
			const compAny = wfComponent(clonedStep.component);
			delete compAny.lastExecutionLog;
			delete compAny.lastExecutionOutput;
			delete compAny.lastExecutionStatus;
			delete compAny.lastExecutionDurationMs;
			delete compAny.lastExecutedAt;
			delete compAny.lastExecutionExitCode;
		}
		const varNames = this._extractStepVariableNames(clonedStep);
		const sourceVars: Array<{ name: string; initialValue: string; expression?: string }> = [];
		for (const vName of varNames) {
			const existing = (node.outputVariables || []).find(v => (v.name || '').replace(/^@/, '').trim() === vName);
			sourceVars.push({
				name: vName,
				initialValue: existing?.initialValue || clonedStep.expression || 'None',
				expression: existing?.expression || clonedStep.expression
			});
		}
		return {
			step: clonedStep,
			sourceNodeLabel: node.label,
			sourceVars
		};
	}

	private _copyCapsuleSteps(node: IFlowchartNode, steps: INodePipelineStep[]): void {
		if (!steps || steps.length === 0) {
			return;
		}
		if (steps.length === 1) {
			this._copyCapsuleStep(node, steps[0]);
			return;
		}
		const payloads = steps.map(st => this._cloneCapsulePayload(node, st));
		WorkflowEditor._copiedCapsules = payloads;
		WorkflowEditor._copiedCapsule = payloads[0];
		WorkflowEditor._lastCopyKind = 'capsule';
		try {
			void this._clipboardService.writeText(JSON.stringify({
				__anyagent_capsule_v1__: true,
				...payloads[0],
				capsules: payloads
			}));
		} catch { }
		this._notificationService.info(`Copied ${payloads.length} capsules. Select any node (including in split view) and press Cmd/Ctrl+V to paste.`);
	}

	private _insertCapsulePayloadIntoNode(
		targetNode: IFlowchartNode,
		payload: { step: INodePipelineStep; sourceNodeLabel?: string; sourceVars?: Array<{ name: string; initialValue: string; expression?: string }> },
		insertIndex?: number
	): { createdVarNames: string[]; capLabel: string } {
		if (!targetNode.pipeline) {
			targetNode.pipeline = [];
		}
		const clonedStep: INodePipelineStep = JSON.parse(JSON.stringify(payload.step));
		clonedStep.id = `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

		let mergedIntoExistingSingleInstance = false;
		if (clonedStep.component) {
			clonedStep.component.id = `comp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
			const compType = clonedStep.component.type;
			if (compType === 'parameters') {
				const existingInputsStep = targetNode.pipeline.find(s => s.component?.type === 'parameters');
				if (existingInputsStep?.component) {
					const existingParams = existingInputsStep.component.parameters || [];
					const incomingParams = clonedStep.component.parameters || [];
					for (const ip of incomingParams) {
						const ipName = (ip.name || '').trim().toLowerCase();
						if (ipName && !existingParams.some(ep => (ep.name || '').trim().toLowerCase() === ipName)) {
							existingParams.push({ ...ip, id: `param_${Date.now()}_${Math.random().toString(36).substring(2, 5)}` });
						}
					}
					existingInputsStep.component.parameters = existingParams;
					this._syncComponentStepMetadata(existingInputsStep);
					mergedIntoExistingSingleInstance = true;
				}
			} else if (compType === 'output') {
				const existingOutStep = targetNode.pipeline.find(s => s.component?.type === 'output');
				if (existingOutStep?.component) {
					const existingSpecs = existingOutStep.component.outputSpecs || [];
					const incomingSpecs = clonedStep.component.outputSpecs || [];
					for (const ispec of incomingSpecs) {
						const key = (ispec.fieldKey || ispec.label || '').trim().toLowerCase();
						if (key && !existingSpecs.some(es => (es.fieldKey || es.label || '').trim().toLowerCase() === key)) {
							existingSpecs.push({ ...ispec });
						}
					}
					existingOutStep.component.outputSpecs = existingSpecs;
					this._syncComponentStepMetadata(existingOutStep);
					mergedIntoExistingSingleInstance = true;
				}
			}
			if (!mergedIntoExistingSingleInstance) {
				if (compType !== 'parameters' && compType !== 'output' && compType !== 'display') {
					const resolvedVar = (clonedStep.component.outputVariableName || clonedStep.targetVariable || this._getComponentOutputVarName(clonedStep.component)).trim();
					if (resolvedVar) {
						clonedStep.component.outputVariableName = resolvedVar;
						clonedStep.targetVariable = resolvedVar;
					}
				}
				this._syncComponentStepMetadata(clonedStep);
			}
		} else {
			const expr = (clonedStep.expression || '').trim();
			const assignMatch = expr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=(?!=)/);
			if (!clonedStep.targetVariable && assignMatch && assignMatch[1] && !WorkflowEditor._PYTHON_KEYWORDS.has(assignMatch[1])) {
				clonedStep.targetVariable = assignMatch[1];
			}
		}

		if (!mergedIntoExistingSingleInstance) {
			if (typeof insertIndex === 'number' && insertIndex >= 0 && insertIndex <= targetNode.pipeline.length) {
				targetNode.pipeline.splice(insertIndex, 0, clonedStep);
			} else {
				targetNode.pipeline.push(clonedStep);
			}
		}

		const createdVarNames = this._extractStepVariableNames(clonedStep);
		if (!targetNode.outputVariables) {
			targetNode.outputVariables = [];
		}
		for (const vName of createdVarNames) {
			if (!targetNode.outputVariables.some(v => (v.name || '').replace(/^@/, '').trim() === vName)) {
				const srcMeta = payload.sourceVars?.find(sv => sv.name === vName);
				targetNode.outputVariables.push({
					name: vName,
					initialValue: srcMeta?.initialValue || clonedStep.expression || 'None',
					expression: srcMeta?.expression || clonedStep.expression
				});
			}
		}

		const capLabel = clonedStep.targetVariable || clonedStep.component?.label || clonedStep.ticketName || clonedStep.label || 'Capsule';
		return { createdVarNames, capLabel };
	}

	private _refreshNodeAfterPipelineMutation(targetNode: IFlowchartNode): void {
		this._ensureNodeFitsPipeline(targetNode);
		this._syncToNode(targetNode, true);
		this._saveFlowchartData();
		this._renderNodes();
		this._drawLinks();
		this._refreshVariablesDrawer(targetNode.id);
		if (this._inspectorEl) {
			this._renderInspector(this._inspectorEl);
		}
		if (this._pipelinePanelEl && this._activePipelineNodeId === targetNode.id) {
			this._renderPipelinePanel(this._pipelinePanelEl, targetNode);
		}
		const openSideEditor = this._editorService.editors.find(
			ed => ed instanceof CustomModuleSchemaEditorInput && !ed.isDisposed() && ed.isFlowchartNodeMode && ed.moduleId === `wf_node_${targetNode.id}`
		);
		if (openSideEditor) {
			this._openNodeComponentsInSideEditor(targetNode);
		}
	}

	private _transferCapsulesBetweenNodes(
		sourceNode: IFlowchartNode,
		sourceIndices: number[],
		targetNode: IFlowchartNode,
		insertIndex: number,
		mode: 'move' | 'copy',
		targetEditor: WorkflowEditor = this
	): void {
		if (!sourceNode.pipeline || sourceNode.pipeline.length === 0) {
			return;
		}
		if (targetEditor === this && sourceNode.id === targetNode.id) {
			return;
		}
		const sorted = Array.from(new Set(sourceIndices))
			.filter(idx => idx >= 0 && idx < sourceNode.pipeline!.length)
			.sort((a, b) => a - b);
		if (sorted.length === 0) {
			return;
		}

		const payloads = sorted.map(idx => this._cloneCapsulePayload(sourceNode, sourceNode.pipeline![idx]));
		let curInsertIdx = typeof insertIndex === 'number' ? Math.max(0, Math.min(insertIndex, (targetNode.pipeline || []).length)) : (targetNode.pipeline || []).length;

		for (const payload of payloads) {
			const prevLen = (targetNode.pipeline || []).length;
			targetEditor._insertCapsulePayloadIntoNode(targetNode, payload, curInsertIdx);
			if ((targetNode.pipeline || []).length > prevLen) {
				curInsertIdx++;
			}
		}

		if (mode === 'move') {
			const removeSet = new Set(sorted);
			const removedSteps = sorted.map(idx => sourceNode.pipeline![idx]);
			sourceNode.pipeline = sourceNode.pipeline.filter((_, idx) => !removeSet.has(idx));

			// Clean up orphaned outputVariables from sourceNode that are no longer produced by remaining steps
			const remainingVars = new Set<string>();
			for (const remStep of sourceNode.pipeline) {
				for (const vn of this._extractStepVariableNames(remStep)) {
					remainingVars.add(vn);
				}
			}
			const movedVars = new Set<string>();
			for (const ms of removedSteps) {
				for (const vn of this._extractStepVariableNames(ms)) {
					movedVars.add(vn);
				}
			}
			if (sourceNode.outputVariables && sourceNode.outputVariables.length > 0) {
				sourceNode.outputVariables = sourceNode.outputVariables.filter(v => {
					const clean = (v.name || '').replace(/^@/, '').trim();
					return !movedVars.has(clean) || remainingVars.has(clean);
				});
			}
			this._selectedCapsule = null;
			this._selectedCapsules = null;
		}

		targetEditor._refreshNodeAfterPipelineMutation(targetNode);
		if (mode === 'move') {
			this._refreshNodeAfterPipelineMutation(sourceNode);
		} else if (targetEditor !== this) {
			this._renderNodes();
		}

		const verb = mode === 'copy' ? 'Copied' : 'Moved';
		const countText = payloads.length === 1
			? `capsule '${payloads[0].step.targetVariable || payloads[0].step.component?.label || payloads[0].step.label || 'Capsule'}'`
			: `${payloads.length} capsules`;
		const splitNote = targetEditor !== this ? ' (across split view)' : '';
		targetEditor._notificationService.info(`${verb} ${countText} into '${targetNode.label || 'Node'}'${splitNote}.`);
	}

	private _copyCapsuleStep(node: IFlowchartNode, step: INodePipelineStep): void {
		const clonedStep: INodePipelineStep = JSON.parse(JSON.stringify(step));
		// Strip transient runtime execution logs/status from copied component while preserving all config & params
		if (clonedStep.component) {
			const compAny = wfComponent(clonedStep.component);
			delete compAny.lastExecutionLog;
			delete compAny.lastExecutionOutput;
			delete compAny.lastExecutionStatus;
			delete compAny.lastExecutionDurationMs;
			delete compAny.lastExecutedAt;
			delete compAny.lastExecutionExitCode;
		}

		const varNames = this._extractStepVariableNames(clonedStep);
		const sourceVars: Array<{ name: string; initialValue: string; expression?: string }> = [];
		for (const vName of varNames) {
			const existing = (node.outputVariables || []).find(v => (v.name || '').replace(/^@/, '').trim() === vName);
			sourceVars.push({
				name: vName,
				initialValue: existing?.initialValue || clonedStep.expression || 'None',
				expression: existing?.expression || clonedStep.expression
			});
		}

		const payload = {
			step: clonedStep,
			sourceNodeLabel: node.label,
			sourceVars
		};
		WorkflowEditor._copiedCapsule = payload;
		WorkflowEditor._copiedCapsules = [payload];
		WorkflowEditor._lastCopyKind = 'capsule';

		try {
			void this._clipboardService.writeText(JSON.stringify({
				__anyagent_capsule_v1__: true,
				...payload
			}));
		} catch { }

		const displayName = clonedStep.targetVariable
			|| clonedStep.component?.label
			|| clonedStep.ticketName
			|| clonedStep.label
			|| clonedStep.functionName
			|| 'Capsule';
		this._notificationService.info(`Copied capsule '${displayName}'. Right-click any node or press Cmd/Ctrl+V to paste.`);
	}

	private async _pasteCapsuleIntoNode(targetNode: IFlowchartNode, insertIndex?: number): Promise<void> {
		let payloads = WorkflowEditor._copiedCapsules.length > 0
			? WorkflowEditor._copiedCapsules
			: (WorkflowEditor._copiedCapsule ? [WorkflowEditor._copiedCapsule] : []);
		if (payloads.length === 0) {
			try {
				const rawClip = (await this._clipboardService.readText() || '').trim();
				if (rawClip.startsWith('{') && rawClip.includes('__anyagent_capsule_v1__')) {
					const parsed = JSON.parse(rawClip);
					if (parsed && parsed.__anyagent_capsule_v1__) {
						if (Array.isArray(parsed.capsules) && parsed.capsules.length > 0) {
							payloads = parsed.capsules.filter((c: { step?: INodePipelineStep } | null | undefined) => c && c.step);
						} else if (parsed.step) {
							payloads = [{
								step: parsed.step,
								sourceNodeLabel: parsed.sourceNodeLabel,
								sourceVars: Array.isArray(parsed.sourceVars) ? parsed.sourceVars : []
							}];
						}
						if (payloads.length > 0) {
							WorkflowEditor._copiedCapsules = payloads;
							WorkflowEditor._copiedCapsule = payloads[0];
						}
					}
				}
			} catch { }
		}
		if (payloads.length === 0) {
			this._notificationService.warn('No copied capsule available to paste.');
			return;
		}
		if (payloads.length > 1) {
			let curIdx = typeof insertIndex === 'number' ? Math.max(0, Math.min(insertIndex, (targetNode.pipeline || []).length)) : (targetNode.pipeline || []).length;
			for (const pItem of payloads) {
				const prevLen = (targetNode.pipeline || []).length;
				this._insertCapsulePayloadIntoNode(targetNode, pItem, curIdx);
				if ((targetNode.pipeline || []).length > prevLen) {
					curIdx++;
				}
			}
			this._refreshNodeAfterPipelineMutation(targetNode);
			this._notificationService.info(`Pasted ${payloads.length} capsules into '${targetNode.label || 'Node'}'.`);
			return;
		}
		const payload = payloads[0];

		if (!targetNode.pipeline) {
			targetNode.pipeline = [];
		}

		const clonedStep: INodePipelineStep = JSON.parse(JSON.stringify(payload.step));
		clonedStep.id = `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

		let mergedIntoExistingSingleInstance = false;
		if (clonedStep.component) {
			clonedStep.component.id = `comp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
			const compType = clonedStep.component.type;

			// Handle single-instance components cleanly: merge parameters/outputSpecs into existing instance if present
			if (compType === 'parameters') {
				const existingInputsStep = targetNode.pipeline.find(s => s.component?.type === 'parameters');
				if (existingInputsStep?.component) {
					const existingParams = existingInputsStep.component.parameters || [];
					const incomingParams = clonedStep.component.parameters || [];
					for (const ip of incomingParams) {
						const ipName = (ip.name || '').trim().toLowerCase();
						if (ipName && !existingParams.some(ep => (ep.name || '').trim().toLowerCase() === ipName)) {
							existingParams.push({ ...ip, id: `param_${Date.now()}_${Math.random().toString(36).substring(2, 5)}` });
						}
					}
					existingInputsStep.component.parameters = existingParams;
					this._syncComponentStepMetadata(existingInputsStep);
					mergedIntoExistingSingleInstance = true;
				}
			} else if (compType === 'output') {
				const existingOutStep = targetNode.pipeline.find(s => s.component?.type === 'output');
				if (existingOutStep?.component) {
					const existingSpecs = existingOutStep.component.outputSpecs || [];
					const incomingSpecs = clonedStep.component.outputSpecs || [];
					for (const ispec of incomingSpecs) {
						const key = (ispec.fieldKey || ispec.label || '').trim().toLowerCase();
						if (key && !existingSpecs.some(es => (es.fieldKey || es.label || '').trim().toLowerCase() === key)) {
							existingSpecs.push({ ...ispec });
						}
					}
					existingOutStep.component.outputSpecs = existingSpecs;
					this._syncComponentStepMetadata(existingOutStep);
					mergedIntoExistingSingleInstance = true;
				}
			}

			if (!mergedIntoExistingSingleInstance) {
				if (compType !== 'parameters' && compType !== 'output' && compType !== 'display') {
					const resolvedVar = (clonedStep.component.outputVariableName || clonedStep.targetVariable || this._getComponentOutputVarName(clonedStep.component)).trim();
					if (resolvedVar) {
						clonedStep.component.outputVariableName = resolvedVar;
						clonedStep.targetVariable = resolvedVar;
					}
				}
				this._syncComponentStepMetadata(clonedStep);
			}
		} else {
			// Ensure inline Python / set_variable / call_function capsules keep targetVariable aligned with LHS assignment
			const expr = (clonedStep.expression || '').trim();
			const assignMatch = expr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=(?!=)/);
			if (!clonedStep.targetVariable && assignMatch && assignMatch[1] && !WorkflowEditor._PYTHON_KEYWORDS.has(assignMatch[1])) {
				clonedStep.targetVariable = assignMatch[1];
			}
		}

		if (!mergedIntoExistingSingleInstance) {
			if (typeof insertIndex === 'number' && insertIndex >= 0 && insertIndex <= targetNode.pipeline.length) {
				targetNode.pipeline.splice(insertIndex, 0, clonedStep);
			} else {
				targetNode.pipeline.push(clonedStep);
			}
		}

		// Automatically create & synchronize associated variables in targetNode.outputVariables
		const createdVarNames = this._extractStepVariableNames(clonedStep);
		if (!targetNode.outputVariables) {
			targetNode.outputVariables = [];
		}
		for (const vName of createdVarNames) {
			if (!targetNode.outputVariables.some(v => (v.name || '').replace(/^@/, '').trim() === vName)) {
				const srcMeta = payload.sourceVars?.find(sv => sv.name === vName);
				targetNode.outputVariables.push({
					name: vName,
					initialValue: srcMeta?.initialValue || clonedStep.expression || 'None',
					expression: srcMeta?.expression || clonedStep.expression
				});
			}
		}

		this._ensureNodeFitsPipeline(targetNode);
		this._syncToNode(targetNode, true);
		this._saveFlowchartData();
		this._renderNodes();
		this._drawLinks();
		this._refreshVariablesDrawer(targetNode.id);

		// If the side editor is currently open for targetNode, refresh it immediately
		const openSideEditor = this._editorService.editors.find(
			ed => ed instanceof CustomModuleSchemaEditorInput && !ed.isDisposed() && ed.isFlowchartNodeMode && ed.moduleId === `wf_node_${targetNode.id}`
		);
		if (openSideEditor) {
			this._openNodeComponentsInSideEditor(targetNode);
		}

		const capLabel = clonedStep.targetVariable || clonedStep.component?.label || clonedStep.ticketName || clonedStep.label || 'Capsule';
		const varNote = createdVarNames.length > 0 ? ` (synced variable: ${createdVarNames.join(', ')})` : '';
		this._notificationService.info(`Pasted capsule '${capLabel}' into '${targetNode.label}'${varNote}.`);
	}

	private _moveCapsuleBetweenNodes(
		sourceNode: IFlowchartNode,
		sourceIndex: number,
		targetNode: IFlowchartNode,
		insertIndex?: number
	): void {
		if (sourceNode.id === targetNode.id) {
			return;
		}
		if (!sourceNode.pipeline || sourceIndex < 0 || sourceIndex >= sourceNode.pipeline.length) {
			return;
		}

		// Snapshot variable metadata from source node before removing
		const movingStep = sourceNode.pipeline[sourceIndex];
		const movedVarNames = this._extractStepVariableNames(movingStep);
		const movedVarMeta = new Map<string, { initialValue: string; expression?: string; currentValue?: unknown }>();
		for (const vName of movedVarNames) {
			const existing = (sourceNode.outputVariables || []).find(v => (v.name || '').replace(/^@/, '').trim() === vName);
			movedVarMeta.set(vName, {
				initialValue: existing?.initialValue || movingStep.expression || 'None',
				expression: existing?.expression || movingStep.expression,
				currentValue: existing?.currentValue
			});
		}

		// Snapshot ticket import metadata if run_ticket
		const movedImportRecord = (movingStep.type === 'run_ticket' && movingStep.ticketName && Array.isArray(sourceNode.imports))
			? sourceNode.imports.find(imp => imp.name === movingStep.ticketName)
			: undefined;

		// 1. Remove capsule from source node
		const [movedStep] = sourceNode.pipeline.splice(sourceIndex, 1);

		if (movedStep.type === 'run_ticket' && movedStep.ticketName && Array.isArray(sourceNode.imports)) {
			const stillUsedInSource = sourceNode.pipeline.some(s => s.type === 'run_ticket' && s.ticketName === movedStep.ticketName);
			if (!stillUsedInSource) {
				sourceNode.imports = sourceNode.imports.filter(imp => imp.name !== movedStep.ticketName);
			}
		}

		// Clean up orphaned variables from sourceNode.outputVariables
		if (movedVarNames.length > 0 && Array.isArray(sourceNode.outputVariables)) {
			const remainingSourceVars = new Set<string>();
			for (const remStep of sourceNode.pipeline) {
				for (const rv of this._extractStepVariableNames(remStep)) {
					remainingSourceVars.add(rv);
				}
			}
			sourceNode.outputVariables = sourceNode.outputVariables.filter(v => {
				const vn = (v.name || '').replace(/^@/, '').trim();
				return !movedVarNames.includes(vn) || remainingSourceVars.has(vn);
			});
		}

		// 2. Insert or merge capsule into target node
		if (!targetNode.pipeline) {
			targetNode.pipeline = [];
		}

		let mergedIntoExistingSingleInstance = false;
		if (movedStep.component) {
			const compType = movedStep.component.type;
			if (compType === 'parameters') {
				const existingInputsStep = targetNode.pipeline.find(s => s.component?.type === 'parameters');
				if (existingInputsStep?.component) {
					const existingParams = existingInputsStep.component.parameters || [];
					const incomingParams = movedStep.component.parameters || [];
					for (const ip of incomingParams) {
						const ipName = (ip.name || '').trim().toLowerCase();
						if (ipName && !existingParams.some(ep => (ep.name || '').trim().toLowerCase() === ipName)) {
							existingParams.push({ ...ip });
						}
					}
					existingInputsStep.component.parameters = existingParams;
					this._syncComponentStepMetadata(existingInputsStep);
					mergedIntoExistingSingleInstance = true;
				}
			} else if (compType === 'output') {
				const existingOutStep = targetNode.pipeline.find(s => s.component?.type === 'output');
				if (existingOutStep?.component) {
					const existingSpecs = existingOutStep.component.outputSpecs || [];
					const incomingSpecs = movedStep.component.outputSpecs || [];
					for (const ispec of incomingSpecs) {
						const key = (ispec.fieldKey || ispec.label || '').trim().toLowerCase();
						if (key && !existingSpecs.some(es => (es.fieldKey || es.label || '').trim().toLowerCase() === key)) {
							existingSpecs.push({ ...ispec });
						}
					}
					existingOutStep.component.outputSpecs = existingSpecs;
					this._syncComponentStepMetadata(existingOutStep);
					mergedIntoExistingSingleInstance = true;
				}
			}

			if (!mergedIntoExistingSingleInstance) {
				if (compType !== 'parameters' && compType !== 'output' && compType !== 'display') {
					const resolvedVar = (movedStep.component.outputVariableName || movedStep.targetVariable || this._getComponentOutputVarName(movedStep.component)).trim();
					if (resolvedVar) {
						movedStep.component.outputVariableName = resolvedVar;
						movedStep.targetVariable = resolvedVar;
					}
				}
				this._syncComponentStepMetadata(movedStep);
			}
		}

		if (!mergedIntoExistingSingleInstance) {
			if (typeof insertIndex === 'number' && insertIndex >= 0 && insertIndex <= targetNode.pipeline.length) {
				targetNode.pipeline.splice(insertIndex, 0, movedStep);
			} else {
				targetNode.pipeline.push(movedStep);
			}
		}

		if (movedImportRecord) {
			if (!targetNode.imports) {
				targetNode.imports = [];
			}
			if (!targetNode.imports.some(imp => imp.name === movedImportRecord.name)) {
				targetNode.imports.push({ ...movedImportRecord });
			}
		}

		// Sync associated variables into targetNode.outputVariables
		if (!targetNode.outputVariables) {
			targetNode.outputVariables = [];
		}
		for (const vName of movedVarNames) {
			if (!targetNode.outputVariables.some(v => (v.name || '').replace(/^@/, '').trim() === vName)) {
				const meta = movedVarMeta.get(vName);
				targetNode.outputVariables.push({
					name: vName,
					initialValue: meta?.initialValue || movedStep.expression || 'None',
					expression: meta?.expression || movedStep.expression,
					...(meta?.currentValue !== undefined ? { currentValue: meta.currentValue } : {})
				});
			}
		}

		// 3. Synchronize both source & target nodes, side editors, and canvas
		if (sourceNode.pipeline.length > 0) {
			this._syncToNode(sourceNode, true);
		}
		this._ensureNodeFitsPipeline(targetNode);
		this._syncToNode(targetNode, true);
		this._selectedCapsule = mergedIntoExistingSingleInstance ? null : { nodeId: targetNode.id, stepId: movedStep.id };

		const syncSideEditorForNode = (n: IFlowchartNode) => {
			const existingInput = this._nodeEditorInputsByNodeId.get(n.id);
			if (existingInput && !existingInput.isDisposed() && existingInput.draftModule) {
				const nodeFields = (n.pipeline || [])
					.filter(st => !!st.component)
					.map(st => st.component!);
				existingInput.draftModule.fields = [
					{ id: 'title', label: 'Title', type: 'text', required: true },
					...nodeFields
				];
				existingInput.notifyExternalDraftUpdated();
			}
		};
		syncSideEditorForNode(sourceNode);
		syncSideEditorForNode(targetNode);

		this._saveFlowchartData();
		this._renderNodes();
		this._drawLinks();
		if (this._inspectorEl) {
			this._renderInspector(this._inspectorEl);
		}
		if (this._pipelinePanelEl && (this._activePipelineNodeId === sourceNode.id || this._activePipelineNodeId === targetNode.id)) {
			const activeNode = this._activePipelineNodeId === sourceNode.id ? sourceNode : targetNode;
			this._renderPipelinePanel(this._pipelinePanelEl, activeNode);
		}
		this._refreshVariablesDrawer(targetNode.id);

		const capLabel = movedStep.targetVariable || movedStep.component?.label || movedStep.ticketName || movedStep.label || 'Capsule';
		const varNote = movedVarNames.length > 0 ? ` (moved variable: ${movedVarNames.join(', ')})` : '';
		this._notificationService.info(`Moved capsule '${capLabel}' from '${sourceNode.label}' to '${targetNode.label}'${varNote}.`);
	}

	private _showCapsuleContextMenu(x: number, y: number, node: IFlowchartNode, stepIndex: number): void {
		this._closeContextMenu();
		const step = node.pipeline?.[stepIndex];
		if (!step) {
			return;
		}

		const menu = append(this._targetWindow.document.body, $('.workflow-context-menu'));
		this._contextMenuEl = menu;
		menu.style.position = 'fixed';
		menu.style.left = `${x}px`;
		menu.style.top = `${y}px`;
		menu.style.zIndex = '20000';

		const copyItem = append(menu, $('.context-menu-item'));
		copyItem.textContent = 'Copy Capsule (Ctrl+C)';
		copyItem.onclick = (e) => {
			e.stopPropagation();
			this._closeContextMenu();
			this._copyCapsuleStep(node, step);
		};

		const dupItem = append(menu, $('.context-menu-item'));
		dupItem.textContent = 'Duplicate Capsule';
		dupItem.onclick = (e) => {
			e.stopPropagation();
			this._closeContextMenu();
			this._copyCapsuleStep(node, step);
			void this._pasteCapsuleIntoNode(node, stepIndex + 1);
		};

		if (WorkflowEditor._copiedCapsule) {
			const capLabel = WorkflowEditor._copiedCapsule.step.targetVariable
				|| WorkflowEditor._copiedCapsule.step.label
				|| WorkflowEditor._copiedCapsule.step.ticketName
				|| WorkflowEditor._copiedCapsule.step.component?.label
				|| 'Capsule';
			const pasteBelowItem = append(menu, $('.context-menu-item'));
			pasteBelowItem.style.color = '#c084fc';
			pasteBelowItem.textContent = `Paste Capsule "${capLabel}" Below`;
			pasteBelowItem.onclick = (e) => {
				e.stopPropagation();
				this._closeContextMenu();
				void this._pasteCapsuleIntoNode(node, stepIndex + 1);
			};
		}

		if (typeof step.capsuleWidth === 'number') {
			const resetWidthItem = append(menu, $('.context-menu-item'));
			resetWidthItem.textContent = 'Reset Capsule Width';
			resetWidthItem.onclick = (e) => {
				e.stopPropagation();
				this._closeContextMenu();
				delete step.capsuleWidth;
				this._saveFlowchartData();
				this._renderNodes();
			};
		}

		// Smart Convert / Merge selected step(s) into Cards (CREATE_TICKETS Card, RUN_TICKETS Card, and/or merged Python Card)
		const pipelineRef = node.pipeline || [];
		const isMultiSelectedOnThisNode = Boolean(
			this._selectedCapsules &&
			this._selectedCapsules.nodeId === node.id &&
			this._selectedCapsules.stepIds.has(step.id) &&
			this._selectedCapsules.stepIds.size > 1
		);
		const targetStepIndices: number[] = isMultiSelectedOnThisNode
			? pipelineRef
				.map((st, idx) => (this._selectedCapsules!.stepIds.has(st.id) ? idx : -1))
				.filter(idx => idx >= 0)
			: [stepIndex];
		const conversionChecks = targetStepIndices.map(idx => this._isConvertiblePythonStep(pipelineRef[idx]));
		const allConvertible = targetStepIndices.length > 0 && conversionChecks.every(c => c.ok);
		const anyConvertible = conversionChecks.some(c => c.ok);

		if (allConvertible) {
			const hasBuiltinAction = conversionChecks.some(c => c.kind && c.kind !== 'python');
			const singleKind = targetStepIndices.length === 1 ? conversionChecks[0].kind : undefined;
			const convertItem = append(menu, $('.context-menu-item'));
			convertItem.style.color = '#38bdf8';
			convertItem.style.fontWeight = '600';
			if (singleKind === 'create_tickets') {
				convertItem.textContent = 'Convert to CREATE_TICKETS Card';
			} else if (singleKind === 'run_tickets') {
				convertItem.textContent = 'Convert to RUN_TICKETS Card';
			} else if (singleKind === 'get_outputs') {
				convertItem.textContent = 'Convert to GET_OUTPUTS Card';
			} else if (singleKind === 'get_ticket') {
				convertItem.textContent = 'Convert to GET_TICKET Card';
			} else if (singleKind === 'display') {
				convertItem.textContent = 'Convert to DISPLAY Card';
			} else if (targetStepIndices.length === 1) {
				convertItem.textContent = 'Convert to Python Card';
			} else if (hasBuiltinAction) {
				convertItem.textContent = `Smart Convert ${targetStepIndices.length} Steps into Cards`;
			} else {
				convertItem.textContent = `Merge ${targetStepIndices.length} Python Steps into Python Card`;
			}
			convertItem.title = hasBuiltinAction
				? 'Convert built-in steps (CREATE_TICKETS, RUN_TICKETS, GET_OUTPUTS, GET_TICKET, DISPLAY) to dedicated cards and merge contiguous Python steps into Python Card(s)'
				: 'Merge selected Python step(s) into a Python Script Card with persistent logs and output capture';
			convertItem.onclick = (e) => {
				e.stopPropagation();
				this._closeContextMenu();
				this._convertPythonStepsToPythonCard(node, targetStepIndices);
			};
		} else if (isMultiSelectedOnThisNode && anyConvertible) {
			const firstReason = conversionChecks.find(c => !c.ok)?.reason || 'Selection includes already-converted card(s)';
			const disabledConvertItem = append(menu, $('.context-menu-item'));
			disabledConvertItem.style.opacity = '0.45';
			disabledConvertItem.style.cursor = 'not-allowed';
			disabledConvertItem.textContent = `Convert to Cards (unavailable)`;
			disabledConvertItem.title = firstReason;
			disabledConvertItem.onclick = (e) => {
				e.stopPropagation();
				this._notificationService.warn(`Cannot convert selection: ${firstReason}`);
			};
		}

		const delItem = append(menu, $('.context-menu-item.danger'));
		delItem.textContent = 'Delete Capsule';
		delItem.onclick = (e) => {
			e.stopPropagation();
			this._closeContextMenu();
			if (node.pipeline && stepIndex >= 0 && stepIndex < node.pipeline.length) {
				const removed = node.pipeline.splice(stepIndex, 1)[0];
				if (removed?.type === 'run_ticket' && removed.ticketName && Array.isArray(node.imports)) {
					node.imports = node.imports.filter(imp => imp.name !== removed.ticketName);
				}
				const removedVars = removed ? this._extractStepVariableNames(removed) : [];
				if (removedVars.length > 0 && Array.isArray(node.outputVariables)) {
					node.outputVariables = node.outputVariables.filter(v => !removedVars.includes((v.name || '').replace(/^@/, '').trim()));
				}
				if (node.pipeline.length > 0) {
					this._syncToNode(node, true);
				}
				this._saveFlowchartData();
				this._renderNodes();
				this._drawLinks();
				this._refreshVariablesDrawer(node.id);
				const openSideEditor = this._editorService.editors.find(
					ed => ed instanceof CustomModuleSchemaEditorInput && !ed.isDisposed() && ed.isFlowchartNodeMode && ed.moduleId === `wf_node_${node.id}`
				);
				if (openSideEditor) {
					this._openNodeComponentsInSideEditor(node);
				}
			}
		};

		// Keep menu inside viewport
		const rect = menu.getBoundingClientRect();
		if (rect.right > this._targetWindow.innerWidth - 8) {
			menu.style.left = `${Math.max(8, this._targetWindow.innerWidth - rect.width - 8)}px`;
		}
		if (rect.bottom > this._targetWindow.innerHeight - 8) {
			menu.style.top = `${Math.max(8, this._targetWindow.innerHeight - rect.height - 8)}px`;
		}

		// Auto-close on outside click / mousedown / Escape
		this._contextMenuDisposables.push(
			addDisposableListener(this._targetWindow, 'mousedown', (ev: MouseEvent) => {
				if (this._contextMenuEl && !this._contextMenuEl.contains(ev.target as Node)) {
					this._closeContextMenu();
				}
			}, true),
			addDisposableListener(this._targetWindow, 'keydown', (ev: KeyboardEvent) => {
				if (ev.key === 'Escape') {
					this._closeContextMenu();
				}
			}, true)
		);
	}

	private _isWholeSingleBuiltinCall(expr: string, fnNames: string[]): boolean {
		const trimmed = (expr || '').trim();
		if (!trimmed) {
			return false;
		}
		const pattern = new RegExp(`^(?:@?[a-zA-Z_][a-zA-Z0-9_]*\\s*=\\s*)?(?:${fnNames.join('|')})\\s*\\(`);
		const m = trimmed.match(pattern);
		if (!m) {
			return false;
		}
		const openIdx = trimmed.indexOf('(', m[0].length - 1);
		if (openIdx < 0) {
			return false;
		}
		let depth = 0;
		let inQuote: string | null = null;
		let closeIdx = -1;
		for (let i = openIdx; i < trimmed.length; i++) {
			const ch = trimmed[i];
			if (inQuote) {
				if (inQuote.length === 3) {
					if (trimmed.slice(i, i + 3) === inQuote) {
						inQuote = null;
						i += 2;
					}
				} else if (ch === inQuote && trimmed[i - 1] !== '\\') {
					inQuote = null;
				}
			} else if (ch === '#') {
				const nl = trimmed.indexOf('\n', i);
				if (nl < 0) { break; }
				i = nl;
			} else if (ch === '"' || ch === '\'') {
				if (trimmed.slice(i, i + 3) === ch + ch + ch) {
					inQuote = ch + ch + ch;
					i += 2;
				} else {
					inQuote = ch;
				}
			} else if (ch === '(' || ch === '[' || ch === '{') {
				depth++;
			} else if (ch === ')' || ch === ']' || ch === '}') {
				depth--;
				if (depth === 0 && ch === ')') {
					closeIdx = i;
					break;
				}
			}
		}
		if (closeIdx < 0) {
			return false;
		}
		// Ensure nothing meaningful follows the closing parenthesis (only whitespace, optional ';', or trailing comment)
		const rest = trimmed.slice(closeIdx + 1).replace(/#[^\n]*/g, '').replace(/;/g, '').trim();
		return rest.length === 0;
	}

	private _isConvertiblePythonStep(step: INodePipelineStep | undefined): { ok: boolean; kind?: 'python' | 'create_tickets' | 'run_tickets' | 'get_outputs' | 'get_ticket' | 'display'; reason?: string } {
		if (!step) {
			return { ok: false, reason: 'Step not found' };
		}
		if (step.component) {
			return { ok: false, reason: `"${step.component.label || step.component.type}" is already a component card` };
		}
		const t = String(step.type || '').toLowerCase();
		if (t === 'run_ticket' || t === 'run_tickets') {
			return { ok: true, kind: 'run_tickets' };
		}
		const expr = (step.expression || '').trim();
		if (this._isWholeSingleBuiltinCall(expr, ['CREATE_TICKETS', 'create_tickets'])) {
			return { ok: true, kind: 'create_tickets' };
		}
		if (this._isWholeSingleBuiltinCall(expr, ['RUN_TICKETS', 'run_tickets'])) {
			return { ok: true, kind: 'run_tickets' };
		}
		if (this._isWholeSingleBuiltinCall(expr, ['GET_OUTPUTS', 'get_outputs'])) {
			return { ok: true, kind: 'get_outputs' };
		}
		if (this._isWholeSingleBuiltinCall(expr, ['GET_TICKET', 'get_ticket'])) {
			return { ok: true, kind: 'get_ticket' };
		}
		if (this._isWholeSingleBuiltinCall(expr, ['DISPLAY', 'display'])) {
			return { ok: true, kind: 'display' };
		}
		return { ok: true, kind: 'python' };
	}

	private _parsePythonCallArgs(expr: string, fnRegex: RegExp): { positional: string[]; kwargs: Record<string, string> } {
		const positional: string[] = [];
		const kwargs: Record<string, string> = {};
		const match = expr.match(fnRegex);
		if (!match || match.index === undefined) {
			return { positional, kwargs };
		}
		const openParenIdx = expr.indexOf('(', match.index + match[0].length - 1);
		if (openParenIdx < 0) {
			return { positional, kwargs };
		}
		let depth = 0;
		let inQuote: string | null = null;
		let closeParenIdx = -1;
		for (let i = openParenIdx; i < expr.length; i++) {
			const ch = expr[i];
			if (inQuote) {
				if (ch === inQuote && expr[i - 1] !== '\\') {
					inQuote = null;
				}
			} else if (ch === '"' || ch === '\'') {
				inQuote = ch;
			} else if (ch === '(' || ch === '[' || ch === '{') {
				depth++;
			} else if (ch === ')' || ch === ']' || ch === '}') {
				depth--;
				if (depth === 0 && ch === ')') {
					closeParenIdx = i;
					break;
				}
			}
		}
		const inner = (closeParenIdx > openParenIdx ? expr.slice(openParenIdx + 1, closeParenIdx) : expr.slice(openParenIdx + 1)).trim();
		if (!inner) {
			return { positional, kwargs };
		}
		const parts: string[] = [];
		let cur = '';
		depth = 0;
		inQuote = null;
		for (let i = 0; i < inner.length; i++) {
			const ch = inner[i];
			if (inQuote) {
				cur += ch;
				if (ch === inQuote && inner[i - 1] !== '\\') {
					inQuote = null;
				}
			} else if (ch === '"' || ch === '\'') {
				inQuote = ch;
				cur += ch;
			} else if (ch === '(' || ch === '[' || ch === '{') {
				depth++;
				cur += ch;
			} else if (ch === ')' || ch === ']' || ch === '}') {
				depth--;
				cur += ch;
			} else if (ch === ',' && depth === 0) {
				if (cur.trim()) { parts.push(cur.trim()); }
				cur = '';
			} else {
				cur += ch;
			}
		}
		if (cur.trim()) { parts.push(cur.trim()); }

		for (const p of parts) {
			const eqIdx = p.indexOf('=');
			if (eqIdx > 0 && p[eqIdx + 1] !== '=' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p.slice(0, eqIdx).trim())) {
				const k = p.slice(0, eqIdx).trim();
				const v = p.slice(eqIdx + 1).trim();
				kwargs[k] = v;
			} else {
				positional.push(p);
			}
		}
		return { positional, kwargs };
	}

	private _pythonArgToTemplateValue(rawArg: string | undefined): string {
		if (!rawArg) {
			return '';
		}
		const s = rawArg.trim();
		if (!s || s === 'None') {
			return '';
		}
		// f-string: f"Hello {var}" -> Hello {var}
		if (/^[fF](["'])[\s\S]*\1$/.test(s)) {
			return s.slice(2, -1);
		}
		// Plain quoted string: "Jobs to Apply" or 'Jobs to Apply'
		if (/^(["'])[\s\S]*\1$/.test(s)) {
			return s.slice(1, -1);
		}
		// Bare Python identifier (variable reference): jbs_app_tkt -> {jbs_app_tkt}
		if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s !== 'True' && s !== 'False') {
			return `{${s}}`;
		}
		return s;
	}

	private _parsePythonDictArg(rawDict: string | undefined): Record<string, string> {
		const out: Record<string, string> = {};
		if (!rawDict) {
			return out;
		}
		const s = rawDict.trim();
		if (!s.startsWith('{') || !s.endsWith('}')) {
			return out;
		}
		const inner = s.slice(1, -1).trim();
		if (!inner) {
			return out;
		}
		const entries: string[] = [];
		let cur = '';
		let depth = 0;
		let inQuote: string | null = null;
		for (let i = 0; i < inner.length; i++) {
			const ch = inner[i];
			if (inQuote) {
				cur += ch;
				if (ch === inQuote && inner[i - 1] !== '\\') {
					inQuote = null;
				}
			} else if (ch === '"' || ch === '\'') {
				inQuote = ch;
				cur += ch;
			} else if (ch === '(' || ch === '[' || ch === '{') {
				depth++;
				cur += ch;
			} else if (ch === ')' || ch === ']' || ch === '}') {
				depth--;
				cur += ch;
			} else if (ch === ',' && depth === 0) {
				if (cur.trim()) { entries.push(cur.trim()); }
				cur = '';
			} else {
				cur += ch;
			}
		}
		if (cur.trim()) { entries.push(cur.trim()); }

		for (const entry of entries) {
			let colonIdx = -1;
			let q: string | null = null;
			let d = 0;
			for (let i = 0; i < entry.length; i++) {
				const ch = entry[i];
				if (q) {
					if (ch === q && entry[i - 1] !== '\\') { q = null; }
				} else if (ch === '"' || ch === '\'') {
					q = ch;
				} else if (ch === '(' || ch === '[' || ch === '{') {
					d++;
				} else if (ch === ')' || ch === ']' || ch === '}') {
					d--;
				} else if (ch === ':' && d === 0) {
					colonIdx = i;
					break;
				}
			}
			if (colonIdx > 0) {
				const rawK = entry.slice(0, colonIdx).trim();
				const rawV = entry.slice(colonIdx + 1).trim();
				const cleanK = (/^(["'])[\s\S]*\1$/.test(rawK) ? rawK.slice(1, -1) : rawK).trim();
				if (cleanK) {
					out[cleanK] = this._pythonArgToTemplateValue(rawV);
				}
			}
		}
		return out;
	}

	private _convertPythonStepsToPythonCard(node: IFlowchartNode, stepIndices: number[]): void {
		if (!node.pipeline || node.pipeline.length === 0) {
			return;
		}
		const sortedIndices = Array.from(new Set(stepIndices))
			.filter(idx => idx >= 0 && idx < node.pipeline!.length)
			.sort((a, b) => a - b);
		if (sortedIndices.length === 0) {
			return;
		}
		const classified: Array<{ idx: number; step: INodePipelineStep; kind: 'python' | 'create_tickets' | 'run_tickets' | 'get_outputs' | 'get_ticket' | 'display' }> = [];
		for (const idx of sortedIndices) {
			const st = node.pipeline[idx];
			const chk = this._isConvertiblePythonStep(st);
			if (!chk.ok || !chk.kind) {
				this._notificationService.warn(`Cannot convert to Card: ${chk.reason || 'Unsupported step'}`);
				return;
			}
			classified.push({ idx, step: st, kind: chk.kind });
		}

		const baseNodeName = (node.label || 'Node').trim() || 'Node';
		const existingLabels = new Set<string>(
			node.pipeline
				.map(st => (st.component?.label || st.label || '').trim().toLowerCase())
				.filter(Boolean)
		);
		const allocateLabel = (kindLabel: string): string => {
			let n = 0;
			let candidate = `${baseNodeName} ${kindLabel} ${n}`;
			while (existingLabels.has(candidate.toLowerCase())) {
				n++;
				candidate = `${baseNodeName} ${kindLabel} ${n}`;
			}
			existingLabels.add(candidate.toLowerCase());
			return candidate;
		};

		const buildMergedPythonStep = (pySteps: INodePipelineStep[]): INodePipelineStep => {
			const codeBlocks: string[] = [];
			const stepEntries: Array<{ step: INodePipelineStep; cleanVar: string; rawExpr: string; code: string; isDisplayOnly: boolean }> = [];

			for (const st of pySteps) {
				const cleanVar = (st.targetVariable || '').trim().replace(/^@/, '');
				const rawExpr = (st.expression || '').trim();
				let blockCode = '';
				if (cleanVar) {
					const alreadyAssignsVar = new RegExp(`^${cleanVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:=|\\+=|-=|\\*=|\\/=)(?!=)`).test(rawExpr);
					blockCode = alreadyAssignsVar
						? rawExpr
						: (rawExpr ? `${cleanVar} = ${rawExpr}` : `${cleanVar} = None`);
				} else {
					blockCode = rawExpr;
				}
				const isDisplayOnly = !cleanVar && /^(?:DISPLAY|display|print)\s*\(/.test(rawExpr);
				stepEntries.push({ step: st, cleanVar, rawExpr, code: blockCode, isDisplayOnly });

				if (blockCode) {
					if (st.disabled) {
						codeBlocks.push(blockCode.split('\n').map(line => `# ${line}`).join('\n'));
					} else {
						codeBlocks.push(blockCode);
					}
				}
			}

			let lastAssignedVar = '';
			for (let i = stepEntries.length - 1; i >= 0; i--) {
				const entry = stepEntries[i];
				if (entry.step.disabled || entry.isDisplayOnly) {
					continue;
				}
				if (entry.cleanVar && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(entry.cleanVar)) {
					lastAssignedVar = entry.cleanVar;
					break;
				}
				const lines = entry.code.split('\n');
				for (let li = lines.length - 1; li >= 0; li--) {
					const trimmed = lines[li].trim();
					if (!trimmed || trimmed.startsWith('#')) {
						continue;
					}
					const assignMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=|\+=|-=|\*=|\/=)(?!=)/);
					if (assignMatch && assignMatch[1] && !['if', 'elif', 'while', 'for', 'return', 'assert'].includes(assignMatch[1])) {
						lastAssignedVar = assignMatch[1];
						break;
					}
				}
				if (lastAssignedVar) {
					break;
				}
			}

			let mergedCode = codeBlocks.join('\n');
			const alreadySetsOutput = /(?:^|\n)\s*(?:output|OUTPUT)\s*=(?!=)|\b(?:set_output|return_output)\s*\(/.test(mergedCode);
			if (!alreadySetsOutput) {
				if (lastAssignedVar) {
					mergedCode = mergedCode ? `${mergedCode}\nOUTPUT = ${lastAssignedVar}` : `OUTPUT = ${lastAssignedVar}`;
				} else {
					const lastActive = [...stepEntries].reverse().find(e => !e.step.disabled && !e.isDisplayOnly && e.code.trim().length > 0);
					if (lastActive && !lastActive.code.includes('\n') && !/^(?:if|for|while|def|class|try|with|import|from|pass|break|continue|raise|del|assert)\b/.test(lastActive.code.trim())) {
						const lastBlockIdx = codeBlocks.lastIndexOf(lastActive.code);
						if (lastBlockIdx >= 0) {
							codeBlocks[lastBlockIdx] = `OUTPUT = ${lastActive.code}`;
							mergedCode = codeBlocks.join('\n');
						}
					}
				}
			}

			const fieldLabel = allocateLabel('Python');
			const outVar = lastAssignedVar || generateSmartPythonVarName(fieldLabel, 'python');
			const newComp: ICustomField = {
				id: `comp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
				label: fieldLabel,
				type: 'python',
				outputVariableName: outVar,
				pythonCode: mergedCode
			};
			const newStep: INodePipelineStep = {
				id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
				type: 'component',
				label: fieldLabel,
				targetVariable: outVar,
				component: newComp
			};
			this._syncComponentStepMetadata(newStep);
			return newStep;
		};

		const buildCreateTicketsStep = (st: INodePipelineStep): INodePipelineStep => {
			const expr = (st.expression || '').trim();
			const cleanVar = (st.targetVariable || '').trim().replace(/^@/, '')
				|| (expr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=(?!=)/)?.[1] || '');
			const { positional, kwargs } = this._parsePythonCallArgs(expr, /\b(?:CREATE_TICKETS|create_tickets)\s*\(/);
			const wfTicketType = this._pythonArgToTemplateValue(kwargs['ticket_type'] || kwargs['type'] || positional[0]) || 'Task';
			const wfTicketTitle = this._pythonArgToTemplateValue(kwargs['title'] || kwargs['name'] || positional[1]) || '';
			const wfTicketPath = this._pythonArgToTemplateValue(kwargs['path'] || kwargs['target_path'] || kwargs['folder'] || positional[2]) || '.';
			const wfTicketParams = this._parsePythonDictArg(kwargs['parameters'] || kwargs['params'] || kwargs['input_params']);
			const fieldLabel = allocateLabel('Create Tickets');
			const outVar = cleanVar || generateSmartPythonVarName(fieldLabel, 'create_tickets');
			const newComp: ICustomField = {
				id: `comp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
				label: fieldLabel,
				type: 'create_tickets',
				outputVariableName: outVar,
				wfTicketType,
				wfTicketTitle,
				wfTicketPath,
				wfTicketParams,
				disabled: Boolean(st.disabled)
			};
			const newStep: INodePipelineStep = {
				id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
				type: 'component',
				label: fieldLabel,
				targetVariable: outVar,
				component: newComp,
				disabled: Boolean(st.disabled)
			};
			this._syncComponentStepMetadata(newStep);
			return newStep;
		};

		const buildRunTicketsStep = (st: INodePipelineStep, priorGeneratedSteps: INodePipelineStep[]): INodePipelineStep => {
			const expr = (st.expression || '').trim();
			const cleanVar = (st.targetVariable || '').trim().replace(/^@/, '')
				|| (expr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=(?!=)/)?.[1] || '');
			let wfTicketTarget = '';
			let wfTicketParams: Record<string, string> = {};
			if (st.type === 'run_ticket' && st.ticketName) {
				wfTicketTarget = st.ticketName;
				if (st.parameters && typeof st.parameters === 'object') {
					for (const [k, v] of Object.entries(st.parameters)) {
						wfTicketParams[k] = String(v ?? '');
					}
				}
			} else {
				const { positional, kwargs } = this._parsePythonCallArgs(expr, /\b(?:RUN_TICKETS|run_tickets)\s*\(/);
				wfTicketTarget = this._pythonArgToTemplateValue(kwargs['ticket'] || kwargs['ticket_id'] || kwargs['tickets'] || kwargs['ticket_name'] || positional[0]);
				wfTicketParams = this._parsePythonDictArg(kwargs['parameters'] || kwargs['params'] || kwargs['input_params']);
			}
			// Auto-detect Ticket Type & inherit params from linked CREATE_TICKETS card (or existing ticket snapshot)
			let wfTicketType = '';
			const cleanTargetKey = wfTicketTarget.trim().replace(/^\{|\}$/g, '').trim().toLowerCase();
			if (cleanTargetKey) {
				const candidateSteps = [...priorGeneratedSteps, ...(node.pipeline || [])];
				const linkedCreate = candidateSteps.find(cand =>
					cand.component?.type === 'create_tickets' && (
						(cand.component.outputVariableName || '').trim().toLowerCase() === cleanTargetKey ||
						(cand.targetVariable || '').trim().replace(/^@/, '').toLowerCase() === cleanTargetKey ||
						(cand.component.label || '').trim().toLowerCase() === cleanTargetKey
					)
				);
				if (linkedCreate?.component?.wfTicketType) {
					wfTicketType = linkedCreate.component.wfTicketType;
					if (Object.keys(wfTicketParams).length === 0 && linkedCreate.component.wfTicketParams) {
						wfTicketParams = { ...linkedCreate.component.wfTicketParams };
					}
				} else {
					const snapshots = this._entityPersistenceService.getAllSnapshots() || [];
					const matchedSnap = snapshots.find(s =>
						s.ticketId?.toLowerCase() === cleanTargetKey ||
						s.entityName?.toLowerCase() === cleanTargetKey
					);
					if (matchedSnap?.entityType) {
						wfTicketType = matchedSnap.entityType;
					}
				}
			}
			const fieldLabel = allocateLabel('Run Tickets');
			const outVar = cleanVar || generateSmartPythonVarName(fieldLabel, 'run_tickets');
			const newComp: ICustomField = {
				id: `comp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
				label: fieldLabel,
				type: 'run_tickets',
				outputVariableName: outVar,
				wfTicketTarget,
				wfTicketType,
				wfTicketParams,
				disabled: Boolean(st.disabled)
			};
			const newStep: INodePipelineStep = {
				id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
				type: 'component',
				label: fieldLabel,
				targetVariable: outVar,
				component: newComp,
				disabled: Boolean(st.disabled)
			};
			this._syncComponentStepMetadata(newStep);
			return newStep;
		};

		const buildGetOutputsStep = (st: INodePipelineStep): INodePipelineStep => {
			const expr = (st.expression || '').trim();
			const cleanVar = (st.targetVariable || '').trim().replace(/^@/, '')
				|| (expr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=(?!=)/)?.[1] || '');
			const { positional, kwargs } = this._parsePythonCallArgs(expr, /\b(?:GET_OUTPUTS|get_outputs)\s*\(/);
			const wfTicketTarget = this._pythonArgToTemplateValue(kwargs['ticket'] || kwargs['ticket_id'] || kwargs['tickets'] || kwargs['ticket_name'] || positional[0]);
			const wfTicketField = this._pythonArgToTemplateValue(kwargs['field'] || kwargs['output_field'] || positional[1]);
			const fieldLabel = allocateLabel('Get Outputs');
			const outVar = cleanVar || generateSmartPythonVarName(fieldLabel, 'get_outputs');
			const newComp: ICustomField = {
				id: `comp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
				label: fieldLabel,
				type: 'get_outputs',
				outputVariableName: outVar,
				wfTicketTarget,
				wfTicketField,
				disabled: Boolean(st.disabled)
			};
			const newStep: INodePipelineStep = {
				id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
				type: 'component',
				label: fieldLabel,
				targetVariable: outVar,
				component: newComp,
				disabled: Boolean(st.disabled)
			};
			this._syncComponentStepMetadata(newStep);
			return newStep;
		};

		const buildGetTicketStep = (st: INodePipelineStep, priorGeneratedSteps: INodePipelineStep[]): INodePipelineStep => {
			const expr = (st.expression || '').trim();
			const cleanVar = (st.targetVariable || '').trim().replace(/^@/, '')
				|| (expr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=(?!=)/)?.[1] || '');
			const { positional, kwargs } = this._parsePythonCallArgs(expr, /\b(?:GET_TICKET|get_ticket)\s*\(/);
			const wfTicketTarget = this._pythonArgToTemplateValue(kwargs['ticket'] || kwargs['ticket_id'] || kwargs['ticket_name'] || positional[0]);
			const wfTicketField = this._pythonArgToTemplateValue(kwargs['field'] || positional[1]);
			let wfTicketType = this._pythonArgToTemplateValue(kwargs['ticket_type'] || kwargs['type']);
			if (!wfTicketType && wfTicketTarget) {
				const cleanTargetKey = wfTicketTarget.trim().replace(/^\{|\}$/g, '').trim().toLowerCase();
				const candidateSteps = [...priorGeneratedSteps, ...(node.pipeline || [])];
				const linkedCreate = candidateSteps.find(cand =>
					cand.component?.type === 'create_tickets' && (
						(cand.component.outputVariableName || '').trim().toLowerCase() === cleanTargetKey ||
						(cand.component.label || '').trim().toLowerCase() === cleanTargetKey
					)
				);
				if (linkedCreate?.component?.wfTicketType) {
					wfTicketType = linkedCreate.component.wfTicketType;
				}
			}
			const fieldLabel = allocateLabel('Get Ticket');
			const outVar = cleanVar || generateSmartPythonVarName(fieldLabel, 'get_ticket');
			const newComp: ICustomField = {
				id: `comp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
				label: fieldLabel,
				type: 'get_ticket',
				outputVariableName: outVar,
				wfTicketTarget,
				wfTicketField,
				wfTicketType,
				disabled: Boolean(st.disabled)
			};
			const newStep: INodePipelineStep = {
				id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
				type: 'component',
				label: fieldLabel,
				targetVariable: outVar,
				component: newComp,
				disabled: Boolean(st.disabled)
			};
			this._syncComponentStepMetadata(newStep);
			return newStep;
		};

		const buildDisplayStep = (st: INodePipelineStep): INodePipelineStep => {
			const expr = (st.expression || '').trim();
			const { positional, kwargs } = this._parsePythonCallArgs(expr, /\b(?:DISPLAY|display)\s*\(/);
			const wfDisplayValue = (kwargs['value'] || kwargs['data'] || positional[0] || '').trim();
			const fieldLabel = allocateLabel('Display');
			const outVar = generateSmartPythonVarName(fieldLabel, 'display');
			const newComp: ICustomField = {
				id: `comp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
				label: fieldLabel,
				type: 'display',
				outputVariableName: outVar,
				wfDisplayValue,
				disabled: Boolean(st.disabled)
			};
			const newStep: INodePipelineStep = {
				id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
				type: 'component',
				label: fieldLabel,
				targetVariable: outVar,
				component: newComp,
				disabled: Boolean(st.disabled)
			};
			this._syncComponentStepMetadata(newStep);
			return newStep;
		};

		// Group contiguous python steps while converting built-in steps into their dedicated cards in exact order
		const generatedSteps: INodePipelineStep[] = [];
		let pendingPyGroup: INodePipelineStep[] = [];
		const flushPendingPy = () => {
			if (pendingPyGroup.length > 0) {
				generatedSteps.push(buildMergedPythonStep(pendingPyGroup));
				pendingPyGroup = [];
			}
		};
		for (const item of classified) {
			if (item.kind === 'create_tickets') {
				flushPendingPy();
				generatedSteps.push(buildCreateTicketsStep(item.step));
			} else if (item.kind === 'run_tickets') {
				flushPendingPy();
				generatedSteps.push(buildRunTicketsStep(item.step, generatedSteps));
			} else if (item.kind === 'get_outputs') {
				flushPendingPy();
				generatedSteps.push(buildGetOutputsStep(item.step));
			} else if (item.kind === 'get_ticket') {
				flushPendingPy();
				generatedSteps.push(buildGetTicketStep(item.step, generatedSteps));
			} else if (item.kind === 'display') {
				flushPendingPy();
				generatedSteps.push(buildDisplayStep(item.step));
			} else {
				pendingPyGroup.push(item.step);
			}
		}
		flushPendingPy();

		// Replace selected steps in-place at the first selected index
		const insertIdx = sortedIndices[0];
		const removeSet = new Set(sortedIndices);
		const nextPipeline: INodePipelineStep[] = [];
		for (let i = 0; i < node.pipeline.length; i++) {
			if (i === insertIdx) {
				nextPipeline.push(...generatedSteps);
			}
			if (!removeSet.has(i)) {
				nextPipeline.push(node.pipeline[i]);
			}
		}
		node.pipeline = nextPipeline;

		const firstNewStep = generatedSteps[0];
		this._selectedCapsules = null;
		if (firstNewStep) {
			this._selectedCapsule = { nodeId: node.id, stepId: firstNewStep.id };
		}
		this._ensureNodeFitsPipeline(node);
		this._syncToNode(node, true);
		this._saveFlowchartData(false);
		this._renderNodes();
		this._drawLinks();
		this._refreshVariablesDrawer(node.id);
		if (firstNewStep?.component?.id) {
			void this._openNodeComponentsInSideEditor(node, firstNewStep.component.id);
		}
		const summaryNames = generatedSteps.map(s => `"${s.component?.label || s.label}"`).join(', ');
		this._notificationService.info(
			generatedSteps.length === 1
				? `Converted ${sortedIndices.length} step(s) into ${summaryNames} (output → ${firstNewStep?.targetVariable || ''})`
				: `Smart-converted ${sortedIndices.length} steps into ${generatedSteps.length} cards: ${summaryNames}`
		);
	}

	private async _undo(): Promise<void> {
		if (this._undoStack.length === 0) {
			this._notificationService.info('Nothing to undo');
			return;
		}

		const prevStateJson = this._undoStack.pop()!;
		const currentStateJson = JSON.stringify(this._data);
		this._redoStack.push(currentStateJson);

		this._isUndoingOrRedoing = true;
		try {
			this._data = JSON.parse(prevStateJson);
			this._lastSavedStateJson = prevStateJson;

			// Clear multi-selection to avoid retaining stale group multi-selection
			if (this._selectedNodeIds.size > 1) {
				this._selectedNodeIds.clear();
			} else {
				const validNodeIds = new Set(this._data.nodes.map(n => n.id));
				for (const id of Array.from(this._selectedNodeIds)) {
					if (!validNodeIds.has(id)) {
						this._selectedNodeIds.delete(id);
					}
				}
			}
			const validLinkIds = new Set(this._data.links.map(l => l.id));
			for (const id of Array.from(this._selectedLinkIds)) {
				if (!validLinkIds.has(id)) {
					this._selectedLinkIds.delete(id);
				}
			}

			await this._saveFlowchartData(true);
			this._renderNodes();
			this._drawLinks();
			if (this._inspectorEl) {
				this._renderInspector(this._inspectorEl);
			}
			this._notificationService.info('Undo');
		} finally {
			this._isUndoingOrRedoing = false;
		}
	}

	private async _redo(): Promise<void> {
		if (this._redoStack.length === 0) {
			this._notificationService.info('Nothing to redo');
			return;
		}

		const nextStateJson = this._redoStack.pop()!;
		const currentStateJson = JSON.stringify(this._data);
		this._undoStack.push(currentStateJson);

		this._isUndoingOrRedoing = true;
		try {
			this._data = JSON.parse(nextStateJson);
			this._lastSavedStateJson = nextStateJson;

			// Clear multi-selection to avoid retaining stale group multi-selection
			if (this._selectedNodeIds.size > 1) {
				this._selectedNodeIds.clear();
			} else {
				const validNodeIds = new Set(this._data.nodes.map(n => n.id));
				for (const id of Array.from(this._selectedNodeIds)) {
					if (!validNodeIds.has(id)) {
						this._selectedNodeIds.delete(id);
					}
				}
			}
			const validLinkIds = new Set(this._data.links.map(l => l.id));
			for (const id of Array.from(this._selectedLinkIds)) {
				if (!validLinkIds.has(id)) {
					this._selectedLinkIds.delete(id);
				}
			}

			await this._saveFlowchartData(true);
			this._renderNodes();
			this._drawLinks();
			if (this._inspectorEl) {
				this._renderInspector(this._inspectorEl);
			}
			this._notificationService.info('Redo');
		} finally {
			this._isUndoingOrRedoing = false;
		}
	}

	private _copySelectedNodes(): void {
		if (this._selectedNodeIds.size === 0) { return; }
		WorkflowEditor._lastCopyKind = 'node';
		this._selectedCapsule = null;
		this._copiedNodes = [];
		this._copiedLinks = [];

		const selectedSet = new Set<string>();
		for (const nid of this._selectedNodeIds) {
			const node = this._data.nodes.find(n => n.id === nid);
			if (node) {
				selectedSet.add(node.id);
				this._copiedNodes.push(JSON.parse(JSON.stringify(node)));
			}
		}

		// Also copy any connecting links whose 'from' and 'to' are both in the selected nodes set
		for (const link of this._data.links) {
			if (selectedSet.has(link.from) && selectedSet.has(link.to)) {
				this._copiedLinks.push(JSON.parse(JSON.stringify(link)));
			}
		}

		const linkMsg = this._copiedLinks.length > 0 ? ` and ${this._copiedLinks.length} connection(s)` : '';
		this._notificationService.info(`Copied ${this._copiedNodes.length} node(s)${linkMsg}`);
	}

	private _groupSelectedNodes(): void {
		if (this._selectedNodeIds.size < 2) {
			return;
		}

		// Explicitly record history snapshot before grouping
		const beforeState = JSON.stringify(this._data);
		this._undoStack.push(beforeState);
		if (this._undoStack.length > 60) {
			this._undoStack.shift();
		}
		this._redoStack = [];

		const newGroupId = `group_${Date.now()}`;
		for (const nid of this._selectedNodeIds) {
			const node = this._data.nodes.find(n => n.id === nid);
			if (node) {
				node.groupId = newGroupId;
			}
		}

		this._lastSavedStateJson = JSON.stringify(this._data);
		this._saveFlowchartData(true);
		this._renderNodes();
		this._drawLinks();
		this._notificationService.info(`Grouped ${this._selectedNodeIds.size} nodes`);
	}

	private _ungroupSelectedNodes(): void {
		if (this._selectedNodeIds.size === 0) {
			return;
		}

		const groupIdsToRemove = new Set<string>();
		for (const nid of this._selectedNodeIds) {
			const node = this._data.nodes.find(n => n.id === nid);
			if (node?.groupId) {
				groupIdsToRemove.add(node.groupId);
			}
		}

		if (groupIdsToRemove.size === 0) {
			return;
		}

		// Explicitly record history snapshot before ungrouping
		const beforeState = JSON.stringify(this._data);
		this._undoStack.push(beforeState);
		if (this._undoStack.length > 60) {
			this._undoStack.shift();
		}
		this._redoStack = [];

		for (const node of this._data.nodes) {
			if (node.groupId && groupIdsToRemove.has(node.groupId)) {
				delete node.groupId;
			}
		}

		this._lastSavedStateJson = JSON.stringify(this._data);
		this._saveFlowchartData(true);
		this._renderNodes();
		this._drawLinks();
		this._notificationService.info(`Ungrouped nodes`);
	}

	private _pasteNodes(anchorCanvasPos?: { x: number; y: number }): void {
		if (this._copiedNodes.length === 0) { return; }

		// Record undo snapshot before paste
		const beforeState = JSON.stringify(this._data);
		this._undoStack.push(beforeState);
		if (this._undoStack.length > 60) {
			this._undoStack.shift();
		}
		this._redoStack = [];

		// Compute bounding-box top-left of copied selection and anchor it directly at the mouse cursor
		// so ALL pasted nodes appear to the right and below the mouse pointer!
		const minX = Math.min(...this._copiedNodes.map(n => n.x));
		const minY = Math.min(...this._copiedNodes.map(n => n.y));
		let anchor = anchorCanvasPos;
		if (!anchor && this._lastCanvasMouseX !== null && this._lastCanvasMouseY !== null) {
			anchor = { x: this._lastCanvasMouseX, y: this._lastCanvasMouseY };
		}
		if (!anchor) {
			const wrapper = this._canvas?.closest('.workflow-editor-canvas-wrapper') as HTMLElement | null;
			const zoom = this._zoomLevel || 1;
			anchor = wrapper
				? { x: Math.round((wrapper.scrollLeft + 40) / zoom), y: Math.round((wrapper.scrollTop + 40) / zoom) }
				: { x: minX + 35, y: minY + 35 };
		}
		const dx = Math.round(anchor.x - minX);
		const dy = Math.round(anchor.y - minY);

		const oldToNewGroupMap = new Map<string, string>();
		for (const copiedNode of this._copiedNodes) {
			if (copiedNode.groupId && !oldToNewGroupMap.has(copiedNode.groupId)) {
				oldToNewGroupMap.set(copiedNode.groupId, `group_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`);
			}
		}

		const oldToNewNodeIdMap = new Map<string, string>();
		const newPastedIds = new Set<string>();

		for (const copiedNode of this._copiedNodes) {
			const newId = `node_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
			oldToNewNodeIdMap.set(copiedNode.id, newId);

			const clonedNode: IFlowchartNode = JSON.parse(JSON.stringify(copiedNode));
			const pastedNode: IFlowchartNode = {
				...clonedNode,
				id: newId,
				groupId: copiedNode.groupId ? oldToNewGroupMap.get(copiedNode.groupId) : undefined,
				x: Math.max(0, copiedNode.x + dx),
				y: Math.max(0, copiedNode.y + dy)
			};

			this._data.nodes.push(pastedNode);
			newPastedIds.add(newId);
		}

		// Recreate internal connecting links between pasted nodes (shifting any custom waypoints by dx/dy)
		for (const copiedLink of this._copiedLinks) {
			const newFrom = oldToNewNodeIdMap.get(copiedLink.from);
			const newTo = oldToNewNodeIdMap.get(copiedLink.to);
			if (newFrom && newTo) {
				const newLinkId = `link_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
				const pastedLink: IFlowchartLink = {
					...JSON.parse(JSON.stringify(copiedLink)),
					id: newLinkId,
					from: newFrom,
					to: newTo,
					waypoints: Array.isArray(copiedLink.waypoints)
						? copiedLink.waypoints.map(wp => ({ x: Math.max(0, wp.x + dx), y: Math.max(0, wp.y + dy) }))
						: undefined
				};
				this._data.links.push(pastedLink);
			}
		}

		this._selectedNodeIds.clear();
		this._selectedLinkIds.clear();
		for (const nid of newPastedIds) {
			this._selectedNodeIds.add(nid);
		}

		this._saveFlowchartData();
		this._renderNodes();
		this._drawLinks();
		const linkMsg = this._copiedLinks.length > 0 ? ` and ${this._copiedLinks.length} connection(s)` : '';
		this._notificationService.info(`Pasted ${newPastedIds.size} node(s)${linkMsg}`);
	}

	private async _importIntoNode(nodeId: string): Promise<void> {
		const node = this._data.nodes.find(n => n.id === nodeId);
		if (!node) { return; }

		// Focus and expand the WORKSPACES side viewlet pane
		await this._viewsService.openView('workbench.workspacesExplorer.mainPane', true);
		this._notificationService.info(`Please drag any Agent, Task, or Job from the 'WORKSPACES' side panel and drop it onto node '${node.label}'.`);
	}

	private async _resolveModuleUri(imp: { type: string; name: string; uri?: string }): Promise<URI | undefined> {
		// 1. Direct URI if already set
		if (imp.uri) {
			try {
				const u = URI.parse(imp.uri);
				if (await this._fileService.exists(u)) {
					return u;
				}
			} catch { }
		}

		const cleanName = (imp.name || '').trim();
		if (!cleanName) { return undefined; }
		const lowerName = cleanName.toLowerCase();
		const lowerType = (imp.type || '').toLowerCase();

		// 2. Query EntityPersistenceService snapshots
		try {
			const snapshots = this._entityPersistenceService.getAllSnapshots();
			// Exact match by name & type
			const exactMatch = snapshots.find(s =>
				s.entityName.toLowerCase() === lowerName &&
				(!lowerType || s.entityType.toLowerCase() === lowerType)
			);
			if (exactMatch) {
				const u = URI.parse(exactMatch.entityUri);
				if (await this._fileService.exists(u)) {
					return u;
				}
			}

			// Substring / path match
			const nameMatch = snapshots.find(s =>
				s.entityName.toLowerCase() === lowerName ||
				s.entityUri.toLowerCase().endsWith('/' + lowerName)
			);
			if (nameMatch) {
				const u = URI.parse(nameMatch.entityUri);
				if (await this._fileService.exists(u)) {
					return u;
				}
			}
		} catch { }

		// 2.5 Check TicketRuntimeService for sibling or workspace tickets by ticket ID / title
		if (this._workflowUri) {
			try {
				const rtTicket = await this._ticketRuntimeService.getTicket(this._workflowUri, cleanName);
				// `entityUri` is the ticket's folder URI (same kind of value as a snapshot's `entityUri` in step 2).
				if (rtTicket.success && rtTicket.entityUri) {
					const rtUri = URI.parse(rtTicket.entityUri);
					if (await this._fileService.exists(rtUri)) {
						return rtUri;
					}
				}
			} catch { }
		}

		// 3. Build candidate workflow base directories (including parent workspace, ~ strip, hyphen/space variants)
		const candidateWorkflowBases: URI[] = [];
		if (this._workflowUri) {
			candidateWorkflowBases.push(this._workflowUri);
			candidateWorkflowBases.push(URI.joinPath(this._workflowUri, '..'));

			const wfPath = this._workflowUri.path;
			const lastSegment = wfPath.split('/').filter(Boolean).pop() || '';
			const parentPath = wfPath.substring(0, wfPath.lastIndexOf('/'));

			// If current workflow folder starts with ~ (e.g. ~User Voice STT...), also check real folder name without ~
			if (lastSegment.startsWith('~')) {
				const unTilde = lastSegment.substring(1).trim();
				candidateWorkflowBases.push(URI.file(`${parentPath}/${unTilde}`));
				candidateWorkflowBases.push(URI.file(`${parentPath}/${unTilde.replace(/\s+/g, '-')}`));
			}

			// Hyphen / space variations
			candidateWorkflowBases.push(URI.file(`${parentPath}/${lastSegment.replace(/-/g, ' ')}`));
			candidateWorkflowBases.push(URI.file(`${parentPath}/${lastSegment.replace(/\s+/g, '-')}`));
		}

		// Check all candidate workflow bases for sub-entities or sub-files
		for (const base of candidateWorkflowBases) {
			const candidateWorkflowPaths = [
				URI.joinPath(base, cleanName),
				URI.joinPath(base, `${cleanName}.md`),
				URI.joinPath(base, `${cleanName}.json`),
				URI.joinPath(base, '.agents', cleanName),
				URI.joinPath(base, '.agents', 'notes', cleanName),
				URI.joinPath(base, '.agents', 'skills', cleanName),
				URI.joinPath(base, '.agents', 'agents', `${cleanName}.json`),
				URI.joinPath(base, '.agents', 'workflows', cleanName),
				URI.joinPath(base, 'notes', cleanName),
				URI.joinPath(base, 'tasks', cleanName),
				URI.joinPath(base, 'agents', cleanName)
			];

			for (const cand of candidateWorkflowPaths) {
				try {
					if (await this._fileService.exists(cand)) {
						return cand;
					}
				} catch { }
			}
		}

		// 4. Check workspace folders
		const folders = this._workspaceContextService.getWorkspace().folders;
		for (const folder of folders) {
			const candidateFolderPaths = [
				URI.joinPath(folder.uri, cleanName),
				URI.joinPath(folder.uri, `${cleanName}.md`),
				URI.joinPath(folder.uri, '.agents', cleanName),
				URI.joinPath(folder.uri, '.agents', 'skills', cleanName),
				URI.joinPath(folder.uri, '.agents', 'agents', cleanName),
				URI.joinPath(folder.uri, '.agents', 'notes', cleanName),
				URI.joinPath(folder.uri, 'agents', cleanName),
				URI.joinPath(folder.uri, 'tasks', cleanName),
				URI.joinPath(folder.uri, 'jobs', cleanName),
				URI.joinPath(folder.uri, 'notes', cleanName),
				URI.joinPath(folder.uri, 'workflows', cleanName)
			];
			for (const cand of candidateFolderPaths) {
				try {
					if (await this._fileService.exists(cand)) {
						return cand;
					}
				} catch { }
			}
		}

		return undefined;
	}

	private async _openModuleInEditor(imp: { type: string; name: string; uri?: string }): Promise<void> {
		const targetUri = await this._resolveModuleUri(imp);
		if (!targetUri) {
			this._notificationService.error(`Could not find ${imp.type} '${imp.name}': it is not registered and is not next to this workflow or in an open workspace folder. Open its folder (or its workspace) first, then try again.`);
			return;
		}

		try {
			const stat = await this._fileService.resolve(targetUri);
			// If target is a standalone file (e.g. .md, .json, .yaml), open directly in text editor
			if (!stat.isDirectory) {
				await this._editorService.openEditor({ resource: targetUri, options: { pinned: true } });
				this._notificationService.info(`Opened ${imp.type} '${imp.name}' in editor.`);
				return;
			}

			const lowerType = (imp.type || '').toLowerCase();
			if (lowerType === 'workflow') {
				await this._editorService.openEditor(new WorkflowEditorInput(targetUri, imp.name), { pinned: true });
			} else {
				await this._editorService.openEditor(new EntityDetailEditorInput(targetUri, imp.name), { pinned: true });
			}
			this._notificationService.info(`Opened ${imp.type} '${imp.name}' in editor.`);
		} catch (err) {
			this._notificationService.error(`Failed to open ${imp.type} '${imp.name}': ${err}`);
		}
	}

	private _escapeXml(str: string): string {
		return (str || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&apos;');
	}

	private _showExportMenu(anchorEl: HTMLElement): void {
		const targetDocument = this._targetWindow.document;
		const existing = wfExportFloatingMenus.get(targetDocument);
		if (existing && targetDocument.contains(existing)) {
			existing.remove();
			return;
		}

		const rect = anchorEl.getBoundingClientRect();
		const menuEl = append(this._targetWindow.document.body, $('.workflow-export-floating-menu'));
		wfExportFloatingMenus.set(targetDocument, menuEl);
		menuEl.style.position = 'fixed';
		menuEl.style.top = `${rect.bottom + 6}px`;
		menuEl.style.left = `${Math.max(10, rect.left - 70)}px`;
		menuEl.style.zIndex = '99999';

		const isSel = this._selectedNodeIds.size > 0;
		const selCount = this._selectedNodeIds.size;

		// Section 1: Full Canvas
		const header1 = append(menuEl, $('.export-menu-header'));
		header1.textContent = 'EXPORT CANVAS';

		const items: { label: string; icon: ThemeIcon; format: 'png' | 'jpeg' | 'svg' | 'pdf' }[] = [
			{ label: 'PNG Image (.png)', icon: Codicon.fileMedia, format: 'png' },
			{ label: 'JPEG Image (.jpg)', icon: Codicon.fileMedia, format: 'jpeg' },
			{ label: 'SVG Vector (.svg)', icon: Codicon.fileCode, format: 'svg' },
			{ label: 'PDF Document (.pdf)', icon: Codicon.filePdf, format: 'pdf' }
		];

		for (const it of items) {
			const row = append(menuEl, $('.export-menu-item'));
			append(row, $('span' + ThemeIcon.asCSSSelector(it.icon)));
			append(row, $('span')).textContent = it.label;
			row.onclick = (e) => {
				e.stopPropagation();
				menuEl.remove();
				this._exportDiagram(it.format, false);
			};
		}

		// Section 2: Selected Elements
		if (isSel) {
			append(menuEl, $('.export-menu-divider'));
			const header2 = append(menuEl, $('.export-menu-header'));
			header2.textContent = `EXPORT SELECTION (${selCount})`;

			for (const it of items) {
				const row = append(menuEl, $('.export-menu-item'));
				append(row, $('span' + ThemeIcon.asCSSSelector(it.icon)));
				append(row, $('span')).textContent = `Selected as ${it.format.toUpperCase()}`;
				row.onclick = (e) => {
					e.stopPropagation();
					menuEl.remove();
					this._exportDiagram(it.format, true);
				};
			}
		}

		const closeListener = (e: MouseEvent) => {
			if (!menuEl.contains(e.target as Node)) {
				menuEl.remove();
				this._targetWindow.removeEventListener('click', closeListener);
			}
		};
		setTimeout(() => this._targetWindow.addEventListener('click', closeListener), 10);
	}

	private _createPdfFromJpeg(jpegBytes: Uint8Array, imgWidth: number, imgHeight: number): Uint8Array {
		return WorkflowPythonEditorBridge.createPdfFromJpeg(jpegBytes, imgWidth, imgHeight);
	}

	private _generateSvgString(
		nodesToExport: IFlowchartNode[],
		linksToExport: IFlowchartLink[],
		bounds: { minX: number; minY: number; width: number; height: number },
		format: 'png' | 'jpeg' | 'svg' | 'pdf'
	): string {
		return WorkflowPythonEditorBridge.generateSvgString(this, nodesToExport, linksToExport, bounds, format);
	}

	private _wrapText(text: string, maxWidth: number, fontSize: number = 11): string[] {
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

	private async _saveExportedFile(fileName: string, dataBuffer: Uint8Array | string, defaultExtension: string): Promise<void> {
		try {
			const defaultUri = this._workflowUri ? URI.joinPath(URI.file(this._workflowUri.fsPath.replace(/\.[^/.]+$/, '')), '..', fileName) : undefined;
			const targetUri = await this._fileDialogService.showSaveDialog({
				defaultUri,
				title: 'Export Diagram / Flowchart',
				filters: [
					{ name: defaultExtension.toUpperCase(), extensions: [defaultExtension] }
				]
			});

			if (targetUri) {
				const buffer = typeof dataBuffer === 'string' ? VSBuffer.fromString(dataBuffer) : VSBuffer.wrap(dataBuffer);
				await this._fileService.writeFile(targetUri, buffer);
				this._notificationService.info(`Successfully exported to '${targetUri.fsPath}'`);
			}
		} catch (err) {
			// Fallback to direct download via browser anchor
			try {
				const mime = defaultExtension === 'svg' ? 'image/svg+xml;charset=utf-8' : (defaultExtension === 'pdf' ? 'application/pdf' : `image/${defaultExtension}`);
				const blob = typeof dataBuffer === 'string' ? new Blob([dataBuffer], { type: mime }) : new Blob([dataBuffer as Uint8Array<ArrayBuffer>], { type: mime });
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = fileName;
				this._targetWindow.document.body.appendChild(a);
				a.click();
				this._targetWindow.document.body.removeChild(a);
				URL.revokeObjectURL(url);
				this._notificationService.info(`Exported diagram '${fileName}'`);
			} catch (downloadErr) {
				this._notificationService.error(`Failed to export diagram: ${err}`);
			}
		}
	}

	private async _exportDiagram(format: 'png' | 'jpeg' | 'svg' | 'pdf', selectionOnly: boolean = false): Promise<void> {
		if (!this._data || !Array.isArray(this._data.nodes) || this._data.nodes.length === 0) {
			this._notificationService.warn('Canvas is empty, nothing to export.');
			return;
		}

		const nodesToExport = selectionOnly ? this._data.nodes.filter(n => this._selectedNodeIds.has(n.id)) : this._data.nodes;
		if (nodesToExport.length === 0) {
			this._notificationService.warn(selectionOnly ? 'No nodes selected to export.' : 'Canvas is empty.');
			return;
		}

		const nodeIdsSet = new Set(nodesToExport.map(n => n.id));
		const linksToExport = (this._data.links || []).filter(l => nodeIdsSet.has(l.from) && nodeIdsSet.has(l.to));

		// Calculate bounding box
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const n of nodesToExport) {
			minX = Math.min(minX, n.x);
			minY = Math.min(minY, n.y);
			maxX = Math.max(maxX, n.x + n.width);
			maxY = Math.max(maxY, n.y + n.height);
		}

		const margin = 40;
		minX = Math.floor(minX - margin);
		minY = Math.floor(minY - margin);
		maxX = Math.ceil(maxX + margin);
		maxY = Math.ceil(maxY + margin);
		const width = Math.max(120, maxX - minX);
		const height = Math.max(80, maxY - minY);

		const defaultName = this._inputNameProperty() || this._workflowUri?.path.split('/').filter(Boolean).pop()?.replace(/\.diagram\.json$/, '').replace(/\.flowchart\.json$/, '') || 'diagram';
		const cleanBaseName = defaultName.replace(/[\\/:*?"<>|]/g, '_');
		const suffix = selectionOnly ? '_selection' : '';
		const fileName = `${cleanBaseName}${suffix}.${format === 'jpeg' ? 'jpg' : format}`;

		const svgString = this._generateSvgString(nodesToExport, linksToExport, { minX, minY, width, height }, format);

		if (format === 'svg') {
			await this._saveExportedFile(fileName, svgString, 'svg');
			return;
		}

		try {
			// Rasterize SVG on Canvas
			const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
			const blobUrl = URL.createObjectURL(svgBlob);
			const img = new Image();

			await new Promise<void>((resolve, reject) => {
				img.onload = () => resolve();
				img.onerror = (e) => reject(new Error('Failed to load SVG for rasterization'));
				img.src = blobUrl;
			});

			const scale = 2; // 2x Retina sharpness
			const canvas = document.createElement('canvas');
			canvas.width = width * scale;
			canvas.height = height * scale;
			const ctx = canvas.getContext('2d')!;
			ctx.scale(scale, scale);

			if (format === 'jpeg' || format === 'pdf') {
				ctx.fillStyle = '#1e1e1e';
				ctx.fillRect(0, 0, width, height);
			}

			ctx.drawImage(img, 0, 0, width, height);
			URL.revokeObjectURL(blobUrl);

			if (format === 'png') {
				const dataUrl = canvas.toDataURL('image/png');
				const raw = atob(dataUrl.replace(/^data:image\/png;base64,/, ''));
				const bytes = new Uint8Array(raw.length);
				for (let i = 0; i < raw.length; i++) { bytes[i] = raw.charCodeAt(i); }
				await this._saveExportedFile(fileName, bytes, 'png');
			} else if (format === 'jpeg') {
				const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
				const raw = atob(dataUrl.replace(/^data:image\/jpeg;base64,/, ''));
				const bytes = new Uint8Array(raw.length);
				for (let i = 0; i < raw.length; i++) { bytes[i] = raw.charCodeAt(i); }
				await this._saveExportedFile(fileName, bytes, 'jpg');
			} else if (format === 'pdf') {
				const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
				const raw = atob(dataUrl.replace(/^data:image\/jpeg;base64,/, ''));
				const jpegBytes = new Uint8Array(raw.length);
				for (let i = 0; i < raw.length; i++) { jpegBytes[i] = raw.charCodeAt(i); }
				const pdfBytes = this._createPdfFromJpeg(jpegBytes, canvas.width, canvas.height);
				await this._saveExportedFile(fileName, pdfBytes, 'pdf');
			}
		} catch (err) {
			this._notificationService.error(`Export failed: ${err}`);
		}
	}

	private _displayInspectorContainer: HTMLElement | null = null;
	/** The `.inspector-title-text` span of `_displayInspectorContainer` (null whenever the container is). */
	private _displayInspectorTitleText: HTMLElement | null = null;
	private _displayInspectorCardsContainer: HTMLElement | null = null;
	private _displayInspectorCards: IWorkflowDisplayCard[] = [];
	private _isDisplayInspectorMinimized = false;
	private _activeDisplayRunId: string | null = null;

	private _clearDisplayInspectorCards(): void {
		this._displayInspectorCards = [];
		if (this._workflowUri) {
			this._workflowExecutionService.clearDisplayCards(this._workflowUri);
		}
		if (this._displayInspectorCardsContainer) {
			clearNode(this._displayInspectorCardsContainer);
		}
		if (this._displayInspectorContainer) {
			this._displayInspectorContainer.remove();
			this._displayInspectorContainer = null;
			this._displayInspectorTitleText = null;
			this._displayInspectorCardsContainer = null;
		}
		this._updateLiveDisplayToolbarBtn();
	}

	private _getDisplayInspectorPart(part: 'header' | 'titleText' | 'minBtn'): HTMLElement | undefined {
		const panel = this._displayInspectorContainer;
		const el = panel ? wfDisplayInspectorParts.get(panel)?.[part] : undefined;
		return el && panel?.contains(el) ? el : undefined;
	}

	/** The (first) card element of `cardId` in the Live Display cards container. */
	private _getDisplayInspectorCardEl(cardId: string): HTMLElement | undefined {
		const container = this._displayInspectorCardsContainer;
		if (!container) {
			return undefined;
		}
		for (const child of Array.from(container.children)) {
			if (isHTMLElement(child) && child.getAttribute('data-card-id') === cardId) {
				return child;
			}
		}
		return undefined;
	}

	private _toggleDisplayInspectorMinimized(): void {
		if (!this._displayInspectorContainer) { return; }
		this._isDisplayInspectorMinimized = !this._isDisplayInspectorMinimized;
		this._displayInspectorContainer.classList.toggle('minimized', this._isDisplayInspectorMinimized);
		const header = this._getDisplayInspectorPart('header');
		if (header) {
			header.title = this._isDisplayInspectorMinimized
				? `Live Display (${this._displayInspectorCards.length}) — Click to expand`
				: 'Drag to reposition Live Display panel';
		}
		const minBtn = this._getDisplayInspectorPart('minBtn');
		if (minBtn) {
			minBtn.textContent = this._isDisplayInspectorMinimized ? '+' : '\u2013';
			minBtn.title = this._isDisplayInspectorMinimized ? 'Expand Live Display' : 'Collapse Live Display';
		}
		// Keep expanded panel within viewport bounds if previously dragged near the right edge
		if (!this._isDisplayInspectorMinimized && this._canvasViewport && this._displayInspectorContainer.style.left && this._displayInspectorContainer.style.left !== 'auto') {
			const parentRect = this._canvasViewport.getBoundingClientRect();
			const curLeft = parseFloat(this._displayInspectorContainer.style.left) || 0;
			const maxLeft = Math.max(0, parentRect.width - this._displayInspectorContainer.offsetWidth);
			if (curLeft > maxLeft) {
				this._displayInspectorContainer.style.left = `${maxLeft}px`;
			}
		}
		this._updateLiveDisplayToolbarBtn();
	}

	private _updateLiveDisplayToolbarBtn(): void {
		if (!this._floatingLiveDisplayBtn) { return; }
		const count = this._displayInspectorCards.length;
		clearNode(this._floatingLiveDisplayBtn);
		append(this._floatingLiveDisplayBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.terminal)));
		const label = append(this._floatingLiveDisplayBtn, $('span.floating-live-label'));
		if (count === 0) {
			label.textContent = 'Live';
			this._floatingLiveDisplayBtn.classList.remove('has-cards', 'active');
			this._floatingLiveDisplayBtn.title = 'Live Display Inspector (No output cards)';
		} else {
			label.textContent = `Live (${count})`;
			this._floatingLiveDisplayBtn.classList.add('has-cards');
			if (this._displayInspectorContainer && !this._isDisplayInspectorMinimized && this._displayInspectorContainer.isConnected) {
				this._floatingLiveDisplayBtn.classList.add('active');
			} else {
				this._floatingLiveDisplayBtn.classList.remove('active');
			}
			this._floatingLiveDisplayBtn.title = `Live Display Inspector (${count} output card${count > 1 ? 's' : ''})`;
		}
	}

	private _ensureDisplayInspectorPanel(): HTMLElement | null {
		if (!this._canvasViewport) { return null; }

		if (this._displayInspectorContainer && this._displayInspectorContainer.isConnected) {
			const titleText = this._displayInspectorTitleText;
			if (titleText) {
				titleText.textContent = `Live Display (${this._displayInspectorCards.length})`;
			}
			if (this._isDisplayInspectorMinimized) {
				const hdr = this._getDisplayInspectorPart('header');
				if (hdr) {
					hdr.title = `Live Display (${this._displayInspectorCards.length}) — Click to expand`;
				}
			}
			this._updateLiveDisplayToolbarBtn();
			return this._displayInspectorContainer;
		}

		const panel = document.createElement('div');
		panel.className = 'workflow-display-inspector-panel';
		if (this._isDisplayInspectorMinimized) {
			panel.classList.add('minimized');
		}
		const LIVE_DISPLAY_WIDTH_KEY = 'anyagent.liveDisplayPanelWidth';
		const DEFAULT_LIVE_DISPLAY_WIDTH = 440;
		const MIN_LIVE_DISPLAY_WIDTH = 260;
		const MAX_LIVE_DISPLAY_WIDTH = 1200;
		try {
			const savedWidthRaw = this._targetWindow.localStorage.getItem(LIVE_DISPLAY_WIDTH_KEY);
			if (savedWidthRaw) {
				const parsedW = parseInt(savedWidthRaw, 10);
				if (Number.isFinite(parsedW) && parsedW >= MIN_LIVE_DISPLAY_WIDTH && parsedW <= MAX_LIVE_DISPLAY_WIDTH) {
					panel.style.width = `${parsedW}px`;
				}
			}
		} catch { }
		this._displayInspectorContainer = panel;

		const attachResizeHandle = (side: 'left' | 'right') => {
			const handle = append(panel, $(`.workflow-display-resize-handle.${side}`));
			handle.title = 'Drag to resize width (double-click to reset)';
			handle.addEventListener('dblclick', (e: MouseEvent) => {
				e.preventDefault();
				e.stopPropagation();
				panel.style.width = `${DEFAULT_LIVE_DISPLAY_WIDTH}px`;
				try { this._targetWindow.localStorage.removeItem(LIVE_DISPLAY_WIDTH_KEY); } catch { }
			});
			handle.addEventListener('mousedown', (e: MouseEvent) => {
				if (panel.classList.contains('minimized')) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();

				const rect = panel.getBoundingClientRect();
				const parentRect = this._canvasViewport!.getBoundingClientRect();
				const startX = e.clientX;
				const startWidth = rect.width;
				const startLeft = rect.left - parentRect.left;
				const startRightGap = Math.max(0, parentRect.right - rect.right);
				const isLeftPositioned = panel.style.left !== '' && panel.style.left !== 'auto';

				panel.classList.add('is-resizing');
				handle.classList.add('active');
				this._targetWindow.document.body.style.cursor = 'ew-resize';

				const onMouseMove = (moveEvent: MouseEvent) => {
					const dx = moveEvent.clientX - startX;
					const viewportMaxW = Math.max(MIN_LIVE_DISPLAY_WIDTH, Math.min(MAX_LIVE_DISPLAY_WIDTH, parentRect.width - 24));

					if (side === 'left') {
						const maxAllowed = isLeftPositioned
							? Math.min(viewportMaxW, startLeft + startWidth)
							: Math.min(viewportMaxW, parentRect.width - startRightGap - 8);
						const newWidth = Math.round(Math.max(MIN_LIVE_DISPLAY_WIDTH, Math.min(maxAllowed, startWidth - dx)));
						panel.style.width = `${newWidth}px`;
						if (isLeftPositioned) {
							const newLeft = Math.max(0, startLeft + (startWidth - newWidth));
							panel.style.left = `${newLeft}px`;
						}
					} else {
						// Right handle: keep left edge anchored
						if (!isLeftPositioned) {
							panel.style.right = 'auto';
							panel.style.left = `${Math.max(0, startLeft)}px`;
						}
						const curLeft = parseFloat(panel.style.left) || startLeft;
						const maxAllowed = Math.min(viewportMaxW, parentRect.width - curLeft - 8);
						const newWidth = Math.round(Math.max(MIN_LIVE_DISPLAY_WIDTH, Math.min(maxAllowed, startWidth + dx)));
						panel.style.width = `${newWidth}px`;
					}
				};

				const onMouseUp = () => {
					panel.classList.remove('is-resizing');
					handle.classList.remove('active');
					this._targetWindow.document.body.style.cursor = '';
					this._targetWindow.removeEventListener('mousemove', onMouseMove);
					this._targetWindow.removeEventListener('mouseup', onMouseUp);
					const finalW = Math.round(panel.getBoundingClientRect().width);
					if (Number.isFinite(finalW) && finalW >= MIN_LIVE_DISPLAY_WIDTH) {
						try { this._targetWindow.localStorage.setItem(LIVE_DISPLAY_WIDTH_KEY, String(finalW)); } catch { }
					}
				};

				this._targetWindow.addEventListener('mousemove', onMouseMove);
				this._targetWindow.addEventListener('mouseup', onMouseUp);
			});
		};
		attachResizeHandle('left');
		attachResizeHandle('right');

		// Header (draggable across canvas viewport when expanded; compact icon button when minimized)
		const header = append(panel, $('.workflow-display-inspector-header'));
		const inspectorParts: { header?: HTMLElement; titleText?: HTMLElement; minBtn?: HTMLElement } = { header };
		wfDisplayInspectorParts.set(panel, inspectorParts);
		header.title = this._isDisplayInspectorMinimized
			? `Live Display (${this._displayInspectorCards.length}) — Click to expand`
			: 'Drag to reposition Live Display panel';

		let isDragging = false;
		let hasDragged = false;
		let startX = 0;
		let startY = 0;
		let initialLeft = 0;
		let initialTop = 0;

		header.addEventListener('mousedown', (e: MouseEvent) => {
			if ((e.target as HTMLElement).closest('.workflow-display-btn-action')) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			isDragging = true;
			hasDragged = false;
			startX = e.clientX;
			startY = e.clientY;

			const rect = panel.getBoundingClientRect();
			const parentRect = this._canvasViewport!.getBoundingClientRect();
			initialLeft = rect.left - parentRect.left;
			initialTop = rect.top - parentRect.top;

			const onMouseMove = (moveEvent: MouseEvent) => {
				if (!isDragging) { return; }
				const dx = moveEvent.clientX - startX;
				const dy = moveEvent.clientY - startY;
				if (!hasDragged && Math.hypot(dx, dy) > 4) {
					hasDragged = true;
					panel.style.right = 'auto';
					panel.style.bottom = 'auto';
					panel.style.left = `${initialLeft}px`;
					panel.style.top = `${initialTop}px`;
					panel.classList.add('is-dragging');
				}
				if (!hasDragged) { return; }

				let newLeft = initialLeft + dx;
				let newTop = initialTop + dy;

				const maxLeft = Math.max(0, parentRect.width - panel.offsetWidth);
				const maxTop = Math.max(0, parentRect.height - panel.offsetHeight);
				newLeft = Math.max(0, Math.min(newLeft, maxLeft));
				newTop = Math.max(0, Math.min(newTop, maxTop));

				panel.style.left = `${newLeft}px`;
				panel.style.top = `${newTop}px`;
			};

			const onMouseUp = () => {
				if (isDragging) {
					const didDrag = hasDragged;
					isDragging = false;
					hasDragged = false;
					panel.classList.remove('is-dragging');
					this._targetWindow.removeEventListener('mousemove', onMouseMove);
					this._targetWindow.removeEventListener('mouseup', onMouseUp);
					if (!didDrag && this._isDisplayInspectorMinimized) {
						this._toggleDisplayInspectorMinimized();
					}
				}
			};

			this._targetWindow.addEventListener('mousemove', onMouseMove);
			this._targetWindow.addEventListener('mouseup', onMouseUp);
		});

		const titleBox = append(header, $('.workflow-display-inspector-title'));
		const compactIcon = append(titleBox, $('span.workflow-display-compact-icon'));
		append(compactIcon, $('span' + ThemeIcon.asCSSSelector(Codicon.terminal)));
		const iconBadge = append(titleBox, $('span.workflow-display-header-badge'));
		iconBadge.textContent = 'OUTPUT';
		const titleText = append(titleBox, $('span.inspector-title-text'));
		inspectorParts.titleText = titleText;
		this._displayInspectorTitleText = titleText;
		titleText.textContent = `Live Display (${this._displayInspectorCards.length})`;

		const actionsBox = append(header, $('.workflow-display-inspector-actions'));

		// 1. Clear button
		const clearBtn = append(actionsBox, $('button.workflow-display-btn-action.workflow-display-btn-clear'));
		clearBtn.textContent = 'Clear';
		clearBtn.title = 'Clear all display cards';
		clearBtn.onclick = (e) => {
			e.stopPropagation();
			this._clearDisplayInspectorCards();
		};

		// 2. Minimize / Expand button (outermost on the right)
		const minBtn = append(actionsBox, $('button.workflow-display-btn-action.workflow-display-btn-toggle'));
		inspectorParts.minBtn = minBtn;
		minBtn.textContent = this._isDisplayInspectorMinimized ? '+' : '\u2013';
		minBtn.title = this._isDisplayInspectorMinimized ? 'Expand Inspector' : 'Minimize Inspector';
		minBtn.onclick = (e) => {
			e.stopPropagation();
			this._toggleDisplayInspectorMinimized();
		};

		// Cards Container
		this._displayInspectorCardsContainer = append(panel, $('.workflow-display-cards-container'));
		this._canvasViewport.appendChild(panel);
		this._updateLiveDisplayToolbarBtn();
		return panel;
	}

	private _restoreDisplayInspectorCards(): void {
		if (!this._canvasViewport || !this._workflowUri) { return; }
		const cards = this._workflowExecutionService.getDisplayCards(this._workflowUri);
		if (cards && cards.length > 0) {
			this._displayInspectorCards = cards.slice(0, 30);
		}

		if (this._displayInspectorCards.length === 0) { return; }

		this._ensureDisplayInspectorPanel();
		if (!this._displayInspectorCardsContainer) { return; }
		clearNode(this._displayInspectorCardsContainer);

		for (const card of this._displayInspectorCards) {
			const cardEl = this._renderDisplayInspectorCardElement(card);
			this._displayInspectorCardsContainer.appendChild(cardEl);
		}
		this._updateLiveDisplayToolbarBtn();
	}

	private _addDisplayInspectorCard(card: IWorkflowDisplayCard): void {
		if (!this._canvasViewport) { return; }

		// Automatically clear cards from previous workflow execution runs when a new run begins
		if (card.runId && this._activeDisplayRunId && card.runId !== this._activeDisplayRunId) {
			this._activeDisplayRunId = card.runId;
			this._clearDisplayInspectorCards();
		} else if (card.runId && !this._activeDisplayRunId) {
			this._activeDisplayRunId = card.runId;
		}

		const existingDupIdx = this._displayInspectorCards.findIndex(
			c => c.id === card.id || (c.runId === card.runId && c.nodeId === card.nodeId && c.expression === card.expression)
		);
		if (existingDupIdx !== -1) {
			const removed = this._displayInspectorCards.splice(existingDupIdx, 1)[0];
			if (removed && this._displayInspectorCardsContainer) {
				const existingEl = this._getDisplayInspectorCardEl(`${removed.id}`);
				existingEl?.remove();
			}
		}
		this._displayInspectorCards.unshift(card);
		while (this._displayInspectorCards.length > 30) {
			const oldest = this._displayInspectorCards.pop();
			if (oldest && this._displayInspectorCardsContainer) {
				const oldestEl = this._getDisplayInspectorCardEl(`${oldest.id}`);
				oldestEl?.remove();
			}
		}

		// Ensure panel exists and update card counter in the background,
		// but respect user's minimized state — never force-expand when minimized!
		this._ensureDisplayInspectorPanel();

		if (!this._displayInspectorCardsContainer) { return; }

		const cardEl = this._renderDisplayInspectorCardElement(card);
		this._displayInspectorCardsContainer.prepend(cardEl);
		this._updateLiveDisplayToolbarBtn();
	}

	private _renderDisplayInspectorCardElement(card: IWorkflowDisplayCard): HTMLElement {
		const el = WorkflowPythonEditorBridge.renderDisplayInspectorCardElement(this, card);
		if (card.id) {
			el.dataset.cardId = card.id;
		}
		return el;
	}

	private async _updatePythonEnvButtonLabel(): Promise<void> {
		if (!this._floatingPythonEnvBtn) { return; }
		const wfDir = this._workflowUri
			? (this._workflowUri.path.endsWith('.json') || this._workflowUri.path.endsWith('.workflow') ? URI.joinPath(this._workflowUri, '..') : this._workflowUri)
			: undefined;

		let resolvedPath = this._data?.pythonPath || '';
		if (wfDir) {
			try {
				const envInfo = await this._ticketRuntimeService.detectPythonEnvironment(wfDir, this._data?.pythonPath);
				resolvedPath = typeof envInfo === 'string'
					? envInfo
					: (envInfo?.interpreterPath || this._data?.pythonPath || 'python3');
				this._detectedPythonPath = String(resolvedPath || 'python3');
			} catch {
				resolvedPath = this._data?.pythonPath || 'python3';
			}
		} else {
			resolvedPath = this._data?.pythonPath || 'python3';
		}

		if (!this._floatingPythonEnvBtn.isConnected) { return; }
		const cleanResolved = String(resolvedPath || 'python3');
		const isVenv = cleanResolved.includes('.venv') || cleanResolved.includes('venv');
		const shortLabel = isVenv ? '.venv (Python)' : (cleanResolved.split('/').pop() || 'python3');
		clearNode(this._floatingPythonEnvBtn);
		append(this._floatingPythonEnvBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.python)));
		this._floatingPythonEnvBtn.title = `Python Environment: ${shortLabel}\nPath: ${cleanResolved}\n(Click to select Python interpreter, test environment, or create .venv)`;
	}

	private _showPythonInterpreterMenu(anchorEl: HTMLElement, onUpdated?: (newPath: string) => void): void {
		WorkflowPythonEditorBridge.showPythonInterpreterMenu(this, anchorEl, onUpdated);
	}

	public getWorkflowUri(): URI | undefined {
		return this._workflowUri;
	}

	private async _openWorkflowAsPythonFile(focusNodeId?: string, options?: { group?: number | typeof SIDE_GROUP; focusText?: string; preserveFocus?: boolean }): Promise<EditorInput | undefined> {
		if (!this._workflowUri) {
			this._notificationService.warn('Cannot open Python editor: Workflow URI is not available.');
			return undefined;
		}

		const snapshot = this._entityPersistenceService.getSnapshot(this._workflowUri);
		const workflowId = snapshot?.ticketId || (this.input as WorkflowEditorInput)?.workflowName || this._workflowUri.path.split('/').pop() || 'workflow';
		const workflowName = snapshot?.entityName || (this.input as WorkflowEditorInput)?.workflowName || workflowId;
		const safeId = workflowId.replace(/[^a-zA-Z0-9_-]/g, '_');

		const pyFileUri = this._isPureDiagram
			? URI.file(`${this._workflowUri.fsPath}.workflow.py`)
			: URI.joinPath(this._workflowUri, '.agents', `${safeId}.workflow.py`);

		const pyContent = WorkflowToPythonConverter.convertWorkflowToPython(this._data, {
			workflowId,
			workflowName,
			workflowUri: this._workflowUri.toString()
		});

		try {
			await this._fileService.writeFile(pyFileUri, VSBuffer.fromString(pyContent));
		} catch (err) {
			this._notificationService.error(`Failed to write workflow Python file: ${err?.message || err}`);
			return undefined;
		}

		const pane = await this._editorService.openEditor({
			resource: pyFileUri,
			options: { pinned: true, preserveFocus: options?.preserveFocus ?? false }
		}, options?.group);

		const control = pane?.getControl?.();
		if (isCodeEditor(control)) {
			const model = control.getModel();
			if (model && typeof model.getValue === 'function' && model.getValue() !== pyContent) {
				model.setValue(pyContent);
			}

			WorkflowEditor.attachWorkflowPythonToolbox(
				control,
				this._fileService,
				this._notificationService,
				this._entityPersistenceService,
				this._ticketRuntimeService,
				this._editorService,
				this._customModulesService,
				pyFileUri,
				workflowId,
				workflowName,
				this._workflowUri
			);

			if (focusNodeId) {
				const lines = pyContent.split('\n');
				const targetLineIdx = lines.findIndex(l => l.trim() === `# NODE_ID: ${focusNodeId}`);
				if (targetLineIdx !== -1) {
					let codeLineNo = Math.min(lines.length, targetLineIdx + 6);
					// Jump to a specific Python step of that node (first line of its code) when asked to
					const focusText = (options?.focusText || '').trim();
					if (focusText) {
						const nextNodeIdx = lines.findIndex((l, i) => i > targetLineIdx && l.trim().startsWith('# NODE_ID: '));
						const stepIdx = lines.findIndex((l, i) => i > targetLineIdx && (nextNodeIdx === -1 || i < nextNodeIdx) && l.includes(focusText));
						if (stepIdx !== -1) {
							codeLineNo = stepIdx + 1;
						}
					}
					if (typeof control.revealLineInCenter === 'function') {
						control.revealLineInCenter(codeLineNo);
					}
					if (typeof control.setPosition === 'function') {
						control.setPosition({ lineNumber: codeLineNo, column: 1 });
					}
					if (typeof control.focus === 'function' && !options?.preserveFocus) {
						control.focus();
					}
				}
			}
		}
		return pane?.input;
	}

	public static extractPythonVariablesFromSource(source: string): string[] {
		return WorkflowPythonEditorBridge.extractPythonVariablesFromSource(source);
	}

	public static attachWorkflowPythonToolbox(
		codeEditor: unknown,
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
		WorkflowPythonEditorBridge.attachWorkflowPythonToolbox(
			codeEditor,
			fileService,
			notificationService,
			entityPersistenceService,
			ticketRuntimeService,
			editorService,
			customModulesService,
			initialPyFileUri,
			initialWorkflowId,
			initialWorkflowName,
			initialWorkflowUri
		);
	}

	public async applySynchronizedFlowchartData(updatedData: IFlowchartData): Promise<void> {
		this._data = updatedData;
		for (const node of this._data.nodes) {
			if (this._deduplicateNodePipeline(node)) {
				this._saveFlowchartData();
			}
			this._ensureNodeFitsPipeline(node);
		}
		this._saveFlowchartData();
		this._renderNodes();
		this._drawLinks();
		if (this._inspectorEl) {
			this._renderInspector(this._inspectorEl);
		}
		if (this._pipelinePanelEl && this._activePipelineNodeId) {
			const activeNode = this._data.nodes.find(n => n.id === this._activePipelineNodeId);
			if (activeNode) {
				this._renderPipelinePanel(this._pipelinePanelEl, activeNode);
			}
		}
	}

	private _collectWorkflowAndNodeVariables(currentNode?: IFlowchartNode): { name: string; source: 'workflow' | 'node' | 'handle'; ticketType?: string }[] {
		const result: { name: string; source: 'workflow' | 'node' | 'handle'; ticketType?: string }[] = [];
		const seen = new Set<string>();
		const addVar = (name: string | undefined, source: 'workflow' | 'node' | 'handle', ticketType?: string) => {
			const clean = (name || '').trim().replace(/^@/, '');
			if (!clean || seen.has(clean)) {
				return;
			}
			seen.add(clean);
			result.push({ name: clean, source, ticketType });
		};

		// 1. Current node components (Inputs parameters, Create Tickets handles, other component output variables)
		if (currentNode?.pipeline) {
			for (const step of currentNode.pipeline) {
				if (step.component) {
					if (step.component.type === 'parameters' && Array.isArray(step.component.parameters)) {
						for (const p of step.component.parameters) {
							addVar(p.name, 'node');
						}
					} else if (step.component.type === 'create_tickets' || step.component.type === 'get_ticket') {
						addVar(this._getComponentOutputVarName(step.component), 'handle', step.component.wfTicketType);
						addVar(step.component.label, 'node');
					} else if (step.component.type !== 'output' && step.component.type !== 'display') {
						addVar(this._getComponentOutputVarName(step.component), 'node');
						addVar(step.component.label, 'node');
					}
				}
				if (step.targetVariable) {
					addVar(step.targetVariable, 'node');
				}
			}
		}

		// 2. Workflow-wide variables and handles: canvas nodes first, then live runtime context
		const collectFromNode = (n: IFlowchartNode) => {
			for (const v of (n.outputVariables || [])) {
				addVar(v.name, 'workflow');
			}
			if (n.outputVariable) {
				addVar(n.outputVariable.name, 'workflow');
			}
			for (const s of (n.pipeline || [])) {
				if ((s.component?.type === 'create_tickets' || s.component?.type === 'get_ticket') && s.component.label) {
					addVar(this._getComponentOutputVarName(s.component), 'handle', s.component.wfTicketType);
					addVar(s.component.label, 'workflow');
				} else if (s.component?.type === 'output' && Array.isArray(s.component.outputSpecs)) {
					for (const spec of s.component.outputSpecs) {
						if (spec.varName) {
							addVar(spec.varName, 'workflow');
						}
						addVar(wfOutputSpec(spec).name || spec.label || spec.fieldKey, 'workflow');
					}
				} else if (s.component?.type === 'parameters' && Array.isArray(s.component.parameters)) {
					for (const p of s.component.parameters) {
						addVar(p.name, 'workflow');
					}
				} else if (s.component?.label && s.component.type !== 'parameters' && s.component.type !== 'display') {
					addVar(this._getComponentOutputVarName(s.component), 'workflow');
					addVar(s.component.label, 'workflow');
				}
				if (s.targetVariable) {
					addVar(s.targetVariable, 'workflow');
				}
				const scanAssignments = (codeStr: string | undefined) => {
					if (!codeStr) { return; }
					for (const rawLine of codeStr.split('\n')) {
						// Skip indented lines so multi-line kwargs like `  ticket_type="..."` are never mistaken for top-level variables
						if (/^\s/.test(rawLine)) { continue; }
						const line = rawLine.trim();
						if (!line || line.startsWith('#')) { continue; }
						const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=(?!=)/);
						if (m && m[1] && !['OUTPUT', 'output', 'RESULT', 'result'].includes(m[1])) {
							const isCreateOrGet = /\b(?:CREATE_TICKETS|create_tickets|GET_TICKET|get_ticket)\s*\(/.test(line)
								&& !/\b(?:GET_TICKETS|get_tickets)\s*\(/.test(line);
							const createMatch = line.match(/CREATE_TICKETS\s*\([^)]*ticket_type\s*=\s*["']([^"']+)["']/i);
							addVar(m[1], isCreateOrGet ? 'handle' : 'workflow', createMatch ? createMatch[1] : undefined);
						}
					}
				};
				if (s.expression) {
					scanAssignments(s.expression);
				}
				if (s.component?.type === 'python' && typeof s.component.pythonCode === 'string') {
					scanAssignments(s.component.pythonCode);
				}
			}
		};

		for (const n of this._data.nodes) {
			collectFromNode(n);
		}
		// Overlay live runtime context variables from the effective run (if any)
		const effectiveRun = currentNode?.id
			? this._getEffectiveRunForNode(currentNode.id)
			: (this._workflowUri ? this._workflowExecutionService.getActiveRun(this._workflowUri) : undefined);
		if (effectiveRun?.contextVariables) {
			const skipCtxKeys = new Set(['__callerInputKeys__', 'OUTPUT', 'WORKFLOW_OUTPUTS', 'Parameters', 'Inputs', 'Title', 'title']);
			for (const k of Object.keys(effectiveRun.contextVariables)) {
				if (!k || k.startsWith('@') || k.startsWith('__') || skipCtxKeys.has(k)) { continue; }
				addVar(k, 'workflow');
			}
		}
		return result;
	}

	private _getComponentOutputVarName(comp: ICustomField): string {
		if (!comp.outputVariableName) {
			comp.outputVariableName = generateSmartPythonVarName(comp.label || comp.id, comp.type);
		}
		return comp.outputVariableName;
	}

	private _formatNodeComponentSummary(comp: ICustomField): string {
		const title = (comp.label || '').trim() || comp.type;
		const varName = (comp.type !== 'parameters' && comp.type !== 'output' && comp.type !== 'display')
			? this._getComponentOutputVarName(comp)
			: '';
		switch (comp.type) {
			case 'parameters': {
				const params = comp.parameters || [];
				if (params.length === 0) {
					return 'Inputs: (click to add parameters)';
				}
				const pairs = params.map(p => {
					const hasDef = p.defaultValue !== undefined && p.defaultValue !== null && String(p.defaultValue).trim() !== '';
					return hasDef ? `${p.name}=${p.defaultValue}` : `${p.name} (required)`;
				});
				return `Inputs (${params.length}): ${pairs.join(', ')}`;
			}
			case 'output': {
				const specs = (comp.outputSpecs || []).filter(s => s && s.enabled !== false);
				if (specs.length === 0) {
					return 'Output: (click to configure outputs)';
				}
				const pairs = specs.map(s => {
					const k = wfOutputSpec(s).name || s.label || s.varName || s.fieldKey;
					const v = s.sourceExpression || wfOutputSpec(s).value || '';
					return v ? `${k}=${v}` : k;
				});
				return `Output (${specs.length}): ${pairs.join(', ')}`;
			}
			case 'create_tickets':
			case 'run_tickets':
			case 'get_outputs':
			case 'get_ticket':
			case 'get_tickets':
			case 'display':
				return this._buildBuiltinComponentPythonExpression(comp);
			case 'prompt':
				return `${varName} = ${title} (AI Prompt)`;
			case 'table': {
				const tblDisplay = (comp.tableDbTableName || wfComponent(comp).tableName || comp.label || '').trim() || 'Data Table';
				return `${varName} = ${tblDisplay} (Data Table)`;
			}
			case 'browser':
				return `${varName} = ${title} (Browser)`;
			case 'tts':
				return `${varName} = ${title} (O2 TTS)`;
			case 'media_player':
				return `${varName} = ${comp.mediaFileName || title} (MP3 / MP4 Player)`;
			case 'voice_note': {
				const clipCount = Array.isArray(comp.voiceClips) ? comp.voiceClips.length : 0;
				return `${varName} = ${title} (${clipCount} Voice Clip${clipCount === 1 ? '' : 's'})`;
			}
			case 'sub_workflow':
				return `${varName} = ${comp.subWorkflowName || title} (Sub-Workflow)`;
			case 'ssh':
				return `${varName} = ${comp.sshHost ? `${comp.sshUser || 'root'}@${comp.sshHost}` : title} (SSH Terminal)`;
			case 'http_request':
				return `${varName} = [${comp.httpMethod || 'GET'}] ${comp.httpUrl || title} (HTTP Request)`;
			case 'git':
				return `${varName} = ${title} (git ${comp.gitCommand || 'status'})`;
			case 'shell':
				return `${varName} = ${title} (${comp.shellType || 'shell'} script)`;
			case 'python':
				return `${varName} = ${title} (Python Script)`;
			default:
				return varName ? `${varName} = ${title} (${comp.type})` : `${title} (${comp.type})`;
		}
	}

	private _extractSchemaParamsForType(typeNameOrId: string): IWfSchemaParamSpec[] {
		const extracted: IWfSchemaParamSpec[] = [];
		if (!typeNameOrId) { return extracted; }
		const clean = typeNameOrId.trim().replace(/^\{|\}$/g, '').trim();
		if (!clean) { return extracted; }
		const normTarget = clean.toLowerCase().replace(/[-_]/g, ' ');

		let matchedMod = (this._cachedCustomModules || []).find(m =>
			m.id?.trim().toLowerCase() === clean.toLowerCase() ||
			m.name?.trim().toLowerCase() === clean.toLowerCase() ||
			m.id?.trim().toLowerCase().replace(/[-_]/g, ' ') === normTarget ||
			m.name?.trim().toLowerCase().replace(/[-_]/g, ' ') === normTarget
		);

		if (!matchedMod) {
			const snapshots = this._entityPersistenceService.getAllSnapshots() || [];
			const snap = snapshots.find(s =>
				s.ticketId?.trim().toLowerCase() === clean.toLowerCase() ||
				s.entityName?.trim().toLowerCase() === clean.toLowerCase()
			);
			if (snap?.entityType) {
				const entityTypeNorm = snap.entityType.trim().toLowerCase().replace(/[-_]/g, ' ');
				matchedMod = (this._cachedCustomModules || []).find(m =>
					m.id?.trim().toLowerCase() === snap.entityType!.trim().toLowerCase() ||
					m.name?.trim().toLowerCase() === snap.entityType!.trim().toLowerCase() ||
					m.id?.trim().toLowerCase().replace(/[-_]/g, ' ') === entityTypeNorm ||
					m.name?.trim().toLowerCase().replace(/[-_]/g, ' ') === entityTypeNorm
				);
			}
		}

		if (matchedMod?.fields && Array.isArray(matchedMod.fields)) {
			for (const f of matchedMod.fields) {
				if (f.type === 'parameters' && Array.isArray(f.parameters)) {
					for (const p of f.parameters) {
						const pName = (p.name || p.id || '').trim();
						if (pName && !extracted.some(item => item.name.toLowerCase() === pName.toLowerCase())) {
							extracted.push({
								name: pName,
								defaultValue: p.defaultValue !== undefined && p.defaultValue !== null ? p.defaultValue : ''
							});
						}
					}
				}
			}
		}
		return extracted;
	}

	private _formatParamValueForPythonExpr(rawVal: string): string {
		const trimmed = (rawVal || '').trim();
		if (!trimmed) {
			return '""';
		}
		// Exact single variable reference {var_name} -> pass variable identifier directly if valid Python identifier
		const singleBrace = trimmed.match(/^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
		if (singleBrace) {
			return singleBrace[1];
		}
		if (/^-?\d+(\.\d+)?$/.test(trimmed) || trimmed === 'True' || trimmed === 'False' || trimmed === 'None') {
			return trimmed;
		}
		return JSON.stringify(trimmed);
	}

	private _buildBuiltinComponentPythonExpression(comp: ICustomField): string {
		const varName = comp.type === 'display' ? '' : (this._getComponentOutputVarName(comp) || 'res');
		if (comp.type === 'create_tickets') {
			const tType = comp.wfTicketType || '';
			const tTitle = comp.wfTicketTitle || '';
			const tPath = comp.wfTicketPath || '.';
			const schemaParams = this._extractSchemaParamsForType(tType);
			const validNames = new Set(schemaParams.map(p => p.name.toLowerCase()));
			const paramEntries = Object.entries(comp.wfTicketParams || {})
				.filter(([k]) => validNames.size === 0 || validNames.has(k.toLowerCase()));
			const paramsStr = paramEntries.map(([k, v]) => `${JSON.stringify(k)}: ${this._formatParamValueForPythonExpr(v)}`).join(', ');
			return `${varName} = CREATE_TICKETS(\n    ticket_type=${JSON.stringify(tType)},\n    title=${JSON.stringify(tTitle)},\n    path=${JSON.stringify(tPath)},\n    params={${paramsStr}}\n)`;
		}
		if (comp.type === 'run_tickets') {
			const rawTarget = (comp.wfTicketTarget || '').trim();
			const targetExpr = this._formatParamValueForPythonExpr(rawTarget);
			const schemaParams = this._extractSchemaParamsForType(comp.wfTicketType || rawTarget);
			const validNames = new Set(schemaParams.map(p => p.name.toLowerCase()));
			const paramEntries = Object.entries(comp.wfTicketParams || {})
				.filter(([k, v]) => (validNames.size === 0 || validNames.has(k.toLowerCase())) && k.trim().length > 0 && v !== undefined && v !== '');
			const paramsStr = paramEntries.map(([k, v]) => `${JSON.stringify(k)}: ${this._formatParamValueForPythonExpr(v)}`).join(', ');
			return `${varName} = RUN_TICKETS(ticket=${targetExpr}, params={${paramsStr}})`;
		}
		if (comp.type === 'get_outputs') {
			const rawTarget = (comp.wfTicketTarget || '').trim();
			const targetExpr = this._formatParamValueForPythonExpr(rawTarget);
			const args: string[] = [`ticket=${targetExpr}`];
			const rawField = (comp.wfTicketField || '').trim();
			if (rawField) {
				args.push(`field=${this._formatParamValueForPythonExpr(rawField)}`);
			}
			return `${varName} = GET_OUTPUTS(${args.join(', ')})`;
		}
		if (comp.type === 'get_ticket') {
			const rawTarget = (comp.wfTicketTarget || comp.wfTicketId || comp.wfTicketVariable || '').trim();
			const targetExpr = this._formatParamValueForPythonExpr(rawTarget);
			const args: string[] = [`ticket=${targetExpr}`];
			const rawField = (comp.wfTicketField || '').trim();
			if (rawField) {
				args.push(`field=${this._formatParamValueForPythonExpr(rawField)}`);
			}
			return `${varName} = GET_TICKET(${args.join(', ')})`;
		}
		if (comp.type === 'get_tickets') {
			const args: string[] = [];
			if (comp.wfTicketType) { args.push(`ticket_type=${JSON.stringify(comp.wfTicketType)}`); }
			if (comp.wfTicketStatus) { args.push(`status=${JSON.stringify(comp.wfTicketStatus)}`); }
			if (comp.wfTicketTitle) { args.push(`title=${JSON.stringify(comp.wfTicketTitle)}`); }
			if (comp.wfTicketPath) { args.push(`path=${JSON.stringify(comp.wfTicketPath)}`); }
			return `${varName} = GET_TICKETS(${args.join(', ')})`;
		}
		if (comp.type === 'display') {
			const rawVal = (comp.wfDisplayValue || '').trim();
			const valExpr = this._normalizeDisplayPythonExpr(rawVal);
			return `DISPLAY(${valExpr})`;
		}
		return this._formatNodeComponentSummary(comp);
	}

	private _normalizeDisplayPythonExpr(rawVal: string): string {
		const trimmed = (rawVal || '').trim();
		if (!trimmed) {
			return '';
		}
		const exactVar = trimmed.match(/^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
		if (exactVar) {
			return exactVar[1];
		}
		// Unwrap {var_name} outside string literals (e.g. len({items}) -> len(items)),
		// while preserving string literals ("...", '...', f"...") and all Python expressions verbatim (NEVER auto-quoting).
		let out = '';
		let inQuote: string | null = null;
		let i = 0;
		while (i < trimmed.length) {
			const ch = trimmed[i];
			if (inQuote) {
				out += ch;
				if (ch === '\\' && i + 1 < trimmed.length) {
					out += trimmed[i + 1];
					i += 2;
					continue;
				}
				if (ch === inQuote) {
					inQuote = null;
				}
				i++;
				continue;
			}
			if (ch === '"' || ch === '\'') {
				inQuote = ch;
				out += ch;
				i++;
				continue;
			}
			if (ch === '{') {
				const m = trimmed.slice(i).match(/^\{([a-zA-Z_][a-zA-Z0-9_]*)\}/);
				if (m) {
					out += m[1];
					i += m[0].length;
					continue;
				}
			}
			out += ch;
			i++;
		}
		return out;
	}

	private _syncComponentStepMetadata(step: INodePipelineStep): void {
		const comp = step.component;
		if (!comp) {
			return;
		}
		step.label = comp.label;
		const outVar = (comp.type === 'parameters' || comp.type === 'output' || comp.type === 'display')
			? undefined
			: this._getComponentOutputVarName(comp);
		if (comp.type === 'create_tickets' || comp.type === 'run_tickets' || comp.type === 'get_outputs' || comp.type === 'get_ticket' || comp.type === 'get_tickets' || comp.type === 'display') {
			step.type = 'call_function';
			step.functionName = comp.type.toUpperCase();
			step.targetVariable = outVar;
			step.expression = this._buildBuiltinComponentPythonExpression(comp);
		} else {
			step.type = 'component';
			step.functionName = comp.type.toUpperCase();
			step.targetVariable = outVar;
			step.expression = this._formatNodeComponentSummary(comp);
		}
	}

	private _addOrOpenComponentOnNode(node: IFlowchartNode, compType: CustomFieldType, insertIndex?: number): void {
		if (!node.pipeline) {
			node.pipeline = [];
		}

		// Multiple Inputs ('parameters') and Output ('output') components per node are supported;
		// they are accumulated in pipeline order for the Workflow I/O Contract.

		const defaultLabels: Record<string, string> = {
			parameters: 'Inputs',
			output: 'Output',
			create_tickets: 'new_ticket_handle',
			run_tickets: 'run_res',
			get_outputs: 'ticket_output',
			get_ticket: 'ticket_data',
			get_tickets: 'found_tickets',
			display: 'Display Result',
			prompt: 'AI Prompt',
			table: 'Data Table',
			browser: 'Web Scraper',
			tts: 'Voice Output',
			media_player: 'MP3 / MP4 Player',
			voice_note: 'Voice Note',
			ssh: 'SSH Terminal',
			http_request: 'API Request',
			git: 'Git',
			button_group: 'Review',
			python: 'Python Script'
		};

		const baseLabel = defaultLabels[compType] || compType;
		let finalLabel = baseLabel;
		if (compType !== 'parameters' && compType !== 'output' && compType !== 'display') {
			const existingLabels = new Set((node.pipeline || []).map(s => s.component?.label || s.targetVariable).filter(Boolean));
			let counter = 2;
			while (existingLabels.has(finalLabel)) {
				finalLabel = `${baseLabel} ${counter++}`;
			}
		}

		const ts = Date.now();
		const newComp: ICustomField = {
			id: `comp_${ts}_${Math.random().toString(36).substring(2, 6)}`,
			label: finalLabel,
			type: compType,
			required: false,
			defaultValue: compType === 'python'
				? '# Write Python automation script here\nimport sys, os, json\n\nOUTPUT = None\n'
				: '',
			parameters: compType === 'parameters'
				? [{ id: `param_${ts}_1`, name: 'param1', defaultValue: '', description: '' }]
				: undefined,
			outputSpecs: compType === 'output'
				? []
				: undefined,
			tableColumns: compType === 'table'
				? [
					{ id: `col_${ts}_1`, name: 'id', label: 'id', dataType: 'INTEGER', primaryKey: true, nullable: false },
					{ id: `col_${ts}_2`, name: 'name', label: 'name', dataType: 'TEXT', primaryKey: false, nullable: true }
				]
				: undefined,
			tableRows: compType === 'table' ? [] : undefined,
			tableDbEngine: compType === 'table' ? 'sqlite' : undefined,
			tableAutoSyncDb: compType === 'table' ? false : undefined,
			sshHost: compType === 'ssh' ? '' : undefined,
			sshPort: compType === 'ssh' ? 22 : undefined,
			sshUser: compType === 'ssh' ? 'root' : undefined,
			sshPassword: compType === 'ssh' ? '' : undefined,
			sshCwd: compType === 'ssh' ? '~' : undefined,
			sshCommand: compType === 'ssh' ? 'pwd' : undefined,
			sshCommands: compType === 'ssh' ? ['pwd'] : undefined,
			sshOutput: compType === 'ssh' ? '' : undefined,
			sshLastOutput: compType === 'ssh' ? '' : undefined,
			sshOutputLines: compType === 'ssh' ? 50 : undefined,
			sshQuickCommands: compType === 'ssh' ? SSH_DEFAULT_QUICK_COMMANDS.map(c => ({ ...c })) : undefined,
			gitCommand: compType === 'git' ? 'status' : undefined,
			buttons: compType === 'button_group' ? [{ id: `btn_${ts}_1`, label: 'Approve', color: '#10b981' }, { id: `btn_${ts}_2`, label: 'Reject', color: '#ef4444' }] : undefined,
			gitRepoPath: compType === 'git' ? '' : undefined,
			shellScript: compType === 'shell' ? '' : undefined,
			shellTimeoutSec: compType === 'shell' ? 120 : undefined,
			httpUrl: compType === 'http_request' ? '' : undefined,
			httpMethod: compType === 'http_request' ? 'GET' : undefined,
			httpAuthType: compType === 'http_request' ? 'none' : undefined,
			httpBodyType: compType === 'http_request' ? 'none' : undefined,
			httpBodyContent: compType === 'http_request' ? '' : undefined,
			httpHeaders: compType === 'http_request' ? [{ key: 'Accept', value: 'application/json', enabled: true }] : undefined,
			httpParams: compType === 'http_request' ? [] : undefined,
			httpTimeoutMs: compType === 'http_request' ? 30000 : undefined,
			voiceClips: compType === 'voice_note' ? [] : undefined,
			voiceTranscript: compType === 'voice_note' ? '' : undefined,
			voiceAutoTranscribe: compType === 'voice_note' ? true : undefined,
			voicePlaybackRate: compType === 'voice_note' ? 1.0 : undefined,
			voiceRunInFlow: compType === 'voice_note' ? false : undefined,
			wfTicketType: '',
			wfTicketTitle: compType === 'create_tickets' ? 'New Ticket' : '',
			wfTicketPath: compType === 'create_tickets' ? '.' : '',
			wfTicketTarget: '',
			wfTicketStatus: '',
			wfTicketParams: {},
			wfDisplayValue: ''
		};

		const newStep: INodePipelineStep = {
			id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
			type: 'component',
			label: finalLabel,
			component: newComp
		};
		this._syncComponentStepMetadata(newStep);

		// Insert at user's drop position or append at the end (no forced ordering restrictions)
		if (typeof insertIndex === 'number' && insertIndex >= 0 && insertIndex <= node.pipeline.length) {
			node.pipeline.splice(insertIndex, 0, newStep);
		} else {
			node.pipeline.push(newStep);
		}

		this._ensureNodeFitsPipeline(node);
		this._syncToNode(node, true);
		this._selectedNodeIds.clear();
		this._selectedNodeIds.add(node.id);
		this._saveFlowchartData();
		this._renderNodes();
		this._drawLinks();
		if (this._inspectorEl) {
			this._renderInspector(this._inspectorEl);
		}
		this._openNodeComponentsInSideEditor(node, newComp.id);
	}

	private _nodeEditorInputsByNodeId = new Map<string, CustomModuleSchemaEditorInput>();

	private _ensureStepHasComponent(step: INodePipelineStep, index: number): ICustomField {
		if (step.component) {
			return step.component;
		}
		const expr = (step.expression || '').trim();
		const id = `comp_${step.id || index}`;
		const label = (step.targetVariable || step.label || `Step ${index + 1}`).replace(/^@/, '');
		const createMatch = expr.match(/^(?:([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*)?CREATE_TICKETS\s*\(([\s\S]*)\)$/i);
		if (createMatch) {
			const typeMatch = createMatch[2].match(/ticket_type\s*=\s*["']([^"']*)["']/i);
			const titleMatch = createMatch[2].match(/title\s*=\s*["']([^"']*)["']/i);
			const pathMatch = createMatch[2].match(/path\s*=\s*["']([^"']*)["']/i);
			step.component = {
				id,
				label: createMatch[1] || label,
				type: 'create_tickets',
				wfTicketType: typeMatch ? typeMatch[1] : '',
				wfTicketTitle: titleMatch ? titleMatch[1] : '',
				wfTicketPath: pathMatch ? pathMatch[1] : '.',
				wfTicketParams: {}
			};
			return step.component;
		}
		const runMatch = expr.match(/^(?:([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*)?RUN_TICKETS\s*\(([\s\S]*)\)$/i);
		if (runMatch) {
			const tgtMatch = runMatch[2].match(/ticket\s*=\s*([^,)]+)/i);
			const rawTgt = tgtMatch ? tgtMatch[1].trim().replace(/^["']|["']$/g, '') : '';
			step.component = {
				id,
				label: runMatch[1] || label,
				type: 'run_tickets',
				wfTicketTarget: rawTgt && !/^[A-Z]+-\d+$/.test(rawTgt) ? `{${rawTgt}}` : rawTgt,
				wfTicketParams: {}
			};
			return step.component;
		}
		const outMatch = expr.match(/^(?:([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*)?GET_OUTPUTS\s*\(([\s\S]*)\)$/i);
		if (outMatch) {
			const tgtMatch = outMatch[2].match(/ticket\s*=\s*([^,)]+)/i);
			const rawTgt = tgtMatch ? tgtMatch[1].trim().replace(/^["']|["']$/g, '') : '';
			step.component = {
				id,
				label: outMatch[1] || label,
				type: 'get_outputs',
				wfTicketTarget: rawTgt && !/^[A-Z]+-\d+$/.test(rawTgt) ? `{${rawTgt}}` : rawTgt
			};
			return step.component;
		}
		const dispMatch = expr.match(/^DISPLAY\s*\(([\s\S]*)\)$/i);
		if (dispMatch) {
			const rawVal = dispMatch[1].trim();
			step.component = {
				id,
				label: 'Display',
				type: 'display',
				wfDisplayValue: rawVal
			};
			return step.component;
		}
		step.component = {
			id,
			label,
			type: 'python',
			defaultValue: expr || '# Write Python automation script here\nOUTPUT = None\n'
		};
		return step.component;
	}

	private async _openNodeComponentEditorModal(node: IFlowchartNode, step: INodePipelineStep): Promise<void> {
		const comp = this._ensureStepHasComponent(step, (node.pipeline || []).indexOf(step));
		await this._openNodeComponentsInSideEditor(node, comp.id);
	}

	private _rebindOpenNodeSchemaEditors(): void {
		if (!this._data?.nodes) {
			return;
		}
		for (const ed of this._editorService.editors) {
			if (ed instanceof CustomModuleSchemaEditorInput && !ed.isDisposed() && ed.moduleId.startsWith('wf_node_')) {
				const targetNodeId = ed.nodeId || ed.moduleId.slice('wf_node_'.length);
				const liveNode = this._data.nodes.find(n => n.id === targetNodeId);
				if (liveNode) {
					this._bindNodeSchemaEditorInput(liveNode, ed);
					ed.notifyExternalDraftUpdated();
				}
			}
		}
	}

	private _bindNodeSchemaEditorInput(node: IFlowchartNode, schemaInput: CustomModuleSchemaEditorInput, focusFieldId?: string): void {
		if (!node.pipeline) {
			node.pipeline = [];
		}
		const targetNodeId = node.id;
		const effRunForInspector = this._getEffectiveRunForNode(targetNodeId);
		const nodeRunStateForInspector = effRunForInspector?.nodeStates?.[targetNodeId];
		const nodeFields: ICustomField[] = node.pipeline
			.filter(st => !!st.component)
			.map(st => {
				const comp = st.component!;
				if (comp.type === 'output' && nodeRunStateForInspector && (nodeRunStateForInspector.status === 'success' || nodeRunStateForInspector.status === 'failed')) {
					const compAny = wfComponent(comp);
					if (!compAny.lastExecutionLog) {
						compAny.lastExecutionStatus = nodeRunStateForInspector.status;
						if (nodeRunStateForInspector.durationMs !== undefined) {
							compAny.lastExecutionDurationMs = nodeRunStateForInspector.durationMs;
						}
						if (nodeRunStateForInspector.status === 'failed') {
							compAny.lastExecutionLog = `[Execution Error]: ${nodeRunStateForInspector.failedStepError || nodeRunStateForInspector.error || 'Output node failed during execution.'}`;
						} else {
							const enabledSpecs = (comp.outputSpecs || []).filter(s => s && s.enabled !== false);
							const rawOut = nodeRunStateForInspector.output;
							const outObj = (rawOut && isWorkflowRecord(rawOut) && !Array.isArray(rawOut)) ? rawOut : undefined;
							const ctxVars = effRunForInspector?.contextVariables || {};
							const describeVal = (v: unknown): { typeTag: string; preview: string } => {
								if (v === null) { return { typeTag: 'null', preview: 'null' }; }
								if (v === undefined) { return { typeTag: 'undefined', preview: 'undefined' }; }
								if (Array.isArray(v)) {
									let p = '';
									try { p = JSON.stringify(v, null, 2); } catch { p = String(v); }
									if (p.length > 4000) { p = p.slice(0, 4000) + `\n... (truncated, ${p.length} chars total)`; }
									return { typeTag: `list (${v.length} items)`, preview: p };
								}
								if (typeof v === 'object') {
									let p = '';
									try { p = JSON.stringify(v, null, 2); } catch { p = String(v); }
									if (p.length > 4000) { p = p.slice(0, 4000) + `\n... (truncated, ${p.length} chars total)`; }
									return { typeTag: `dict (${Object.keys(v).length} keys)`, preview: p };
								}
								const s = String(v);
								return { typeTag: typeof v, preview: s.length > 4000 ? s.slice(0, 4000) + `\n... (truncated, ${s.length} chars total)` : s };
							};
							const lines: string[] = [`>>> Exported Outputs from "${node.label || 'End'}" (${enabledSpecs.length} field(s))`];
							for (const spec of enabledSpecs) {
								const k = (spec.label || spec.varName || spec.fieldKey || '').trim();
								if (!k) { continue; }
								const val = (outObj && hasWorkflowProperty(outObj, k)) ? outObj[k]
									: (outObj && spec.varName && hasWorkflowProperty(outObj, spec.varName)) ? outObj[spec.varName]
										: hasWorkflowProperty(ctxVars, k) ? ctxVars[k]
											: (spec.varName && hasWorkflowProperty(ctxVars, spec.varName)) ? ctxVars[spec.varName]
												: undefined;
								const desc = describeVal(val);
								const varTag = spec.varName ? ` [var: ${spec.varName}]` : '';
								const srcTag = spec.sourceExpression ? ` <- ${spec.sourceExpression}` : '';
								lines.push(`\n• ${k}${varTag}${srcTag} [Type: ${desc.typeTag}]`);
								lines.push(desc.preview);
							}
							compAny.lastExecutionLog = lines.join('\n');
							if (rawOut !== undefined) {
								compAny.lastExecutionOutput = rawOut;
							}
						}
					}
				}
				return comp;
			});
		const draftModule: ICustomModule = {
			id: `wf_node_${targetNodeId}`,
			name: node.label || 'Flowchart Node',
			slug: `wf-node-${targetNodeId}`,
			color: '#38bdf8',
			storageScope: 'workspace',
			description: `Flowchart Node Components for ${node.label || targetNodeId}`,
			prompt: '',
			fields: [
				{ id: 'title', label: 'Title', type: 'text', required: true },
				...nodeFields
			]
		};

		if (this._nodeEditorInputsByNodeId.get(targetNodeId) !== schemaInput) {
			schemaInput.onWillDispose(() => {
				if (this._nodeEditorInputsByNodeId.get(targetNodeId) === schemaInput) {
					this._nodeEditorInputsByNodeId.delete(targetNodeId);
				}
			});
			this._nodeEditorInputsByNodeId.set(targetNodeId, schemaInput);
		}

		schemaInput.moduleName = node.label || 'Flowchart Node';
		schemaInput.isFlowchartNodeMode = true;
		schemaInput.nodeId = targetNodeId;
		schemaInput.draftModule = draftModule;
		if (focusFieldId !== undefined) {
			schemaInput.focusFieldId = focusFieldId;
		}
		schemaInput.workflowVariablesProvider = () => {
			const liveNode = this._data?.nodes?.find(n => n.id === targetNodeId) || node;
			return this._collectWorkflowAndNodeVariables(liveNode).map(v => ({
				label: v.name,
				type: v.source === 'handle' ? 'HANDLE' : v.source === 'node' ? 'NODE' : 'WORKFLOW',
				ticketType: v.ticketType
			}));
		};
		schemaInput.workflowRuntimeContextProvider = () => {
			const ctx: IWorkflowRecord = {};
			if (this._workflowUri) {
				const activeRun = this._workflowExecutionService.getActiveRun(this._workflowUri);
				if (activeRun?.contextVariables) {
					Object.assign(ctx, activeRun.contextVariables);
				} else {
					const runs = this._workflowExecutionService.getRunsForWorkflow(this._workflowUri);
					if (runs && runs.length > 0 && runs[0]?.contextVariables) {
						Object.assign(ctx, runs[0].contextVariables);
					}
				}
			}
			return ctx;
		};
		schemaInput.hydratedWorkflowRuntimeContextProvider = async () => {
			const ctx = schemaInput.workflowRuntimeContextProvider?.() || {};
			return this._workflowUri ? this._workflowExecutionService.hydrateContextVariables(this._workflowUri, ctx) : ctx;
		};
		schemaInput.onNodeFieldsChange = (updatedFields: ICustomField[], immediate?: boolean) => {
			const liveNode = this._data?.nodes?.find(n => n.id === targetNodeId) || node;
			// Enforce single-instance rule & rebuild liveNode.pipeline in real time while preserving classic non-component [py] capsules
			let seenInputs = false;
			let seenOutput = false;
			const filteredFields: ICustomField[] = [];
			for (const f of updatedFields) {
				if (!f || f.id === 'title') {
					continue;
				}
				if (f.type === 'parameters') {
					if (seenInputs) { continue; }
					seenInputs = true;
				}
				if (f.type === 'output') {
					if (seenOutput) { continue; }
					seenOutput = true;
				}
				filteredFields.push(f);
			}
			const existingStepById = new Map<string, INodePipelineStep>();
			for (const st of (liveNode.pipeline || [])) {
				if (st.component?.id) {
					existingStepById.set(st.component.id, st);
				}
			}

			const mapFieldToStep = (f: ICustomField): INodePipelineStep => {
				const existing = existingStepById.get(f.id);
				const stepObj: INodePipelineStep = existing || {
					id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
					type: 'component',
					label: f.label,
					component: f,
					disabled: Boolean(f.disabled)
				};
				stepObj.component = f;
				stepObj.disabled = Boolean(f.disabled);
				this._syncComponentStepMetadata(stepObj);
				return stepObj;
			};

			const mappedComponentSteps = filteredFields.map(mapFieldToStep);
			const hasNonComponentSteps = (liveNode.pipeline || []).some(st => !st.component);
			if (!hasNonComponentSteps) {
				liveNode.pipeline = mappedComponentSteps;
			} else {
				const activeFieldIds = new Set(filteredFields.map(f => f.id));
				const mappedStepByFieldId = new Map(filteredFields.map(f => [f.id, mapFieldToStep(f)]));
				const rebuiltPipeline: INodePipelineStep[] = [];
				const processedFieldIds = new Set<string>();

				for (const st of (liveNode.pipeline || [])) {
					if (!st.component) {
						rebuiltPipeline.push(st);
					} else if (activeFieldIds.has(st.component.id)) {
						const mapped = mappedStepByFieldId.get(st.component.id);
						if (mapped && !processedFieldIds.has(st.component.id)) {
							rebuiltPipeline.push(mapped);
							processedFieldIds.add(st.component.id);
						}
					}
				}
				for (const f of filteredFields) {
					if (!processedFieldIds.has(f.id)) {
						const mapped = mappedStepByFieldId.get(f.id);
						if (mapped) {
							rebuiltPipeline.push(mapped);
							processedFieldIds.add(f.id);
						}
					}
				}
				liveNode.pipeline = rebuiltPipeline;
			}

			if (schemaInput.draftModule) {
				schemaInput.draftModule.fields = [
					{ id: 'title', label: 'Title', type: 'text', required: true },
					...filteredFields
				];
			}

			this._ensureNodeFitsPipeline(liveNode);
			this._syncToNode(liveNode, true);
			void this._saveFlowchartData(false, Boolean(immediate));
			this._renderNodes();
			this._drawLinks();
			if (this._inspectorEl) {
				this._renderInspector(this._inspectorEl);
			}
		};
	}

	private async _openNodeComponentsInSideEditor(node: IFlowchartNode, focusFieldId?: string): Promise<void> {
		if (!node.pipeline) {
			node.pipeline = [];
		}

		const targetNodeId = node.id;
		let schemaInput = this._nodeEditorInputsByNodeId.get(targetNodeId);
		if (!schemaInput || schemaInput.isDisposed()) {
			const existingOpenInput = this._editorService.editors.find(
				(ed): ed is CustomModuleSchemaEditorInput =>
					ed instanceof CustomModuleSchemaEditorInput &&
					!ed.isDisposed() &&
					ed.moduleId === `wf_node_${targetNodeId}`
			);
			schemaInput = existingOpenInput || new CustomModuleSchemaEditorInput(
				`wf_node_${targetNodeId}`,
				node.label || 'Flowchart Node',
				this._workflowUri
			);
		}
		this._bindNodeSchemaEditorInput(node, schemaInput, focusFieldId);

		// Target editor group: the group to the right of the canvas (not a flowchart split below it), else a new side group
		const targetGroup = this._outlineSideGroup();

		const wasAlreadyOpen = this._editorService.editors.some(
			ed => ed instanceof CustomModuleSchemaEditorInput && ed.matches(schemaInput!)
		);
		await this._editorService.openEditor(
			schemaInput,
			{ pinned: true, preserveFocus: true },
			targetGroup
		);
		if (wasAlreadyOpen) {
			schemaInput.notifyExternalDraftUpdated(focusFieldId);
		}
	}

	public static async syncPythonEditorToWorkflow(
		pyFileUri: URI | undefined,
		activeCodeEditor: unknown,
		fileService: IFileService,
		notificationService: INotificationService,
		entityPersistenceService: IEntityPersistenceService,
		ticketRuntimeService: ITicketWorkflowRuntimeService
	): Promise<boolean> {
		return WorkflowPythonEditorBridge.syncPythonEditorToWorkflow(
			pyFileUri,
			activeCodeEditor,
			fileService,
			notificationService,
			entityPersistenceService,
			ticketRuntimeService
		);
	}
}