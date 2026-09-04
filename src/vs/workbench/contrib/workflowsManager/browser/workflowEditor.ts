/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/workflowEditor.css';
import { $, append, clearNode, h, addDisposableListener } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { WorkflowEditorInput } from './workflowEditorInput.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IEntityPersistenceService } from '../../entityPersistence/common/entityPersistence.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { EntityDetailEditorInput } from '../../workspacesExplorer/browser/entityDetailEditorInput.js';
import { IWorkflowExecutionService } from '../common/workflowExecutionService.js';
import { IWorkflowExecutionRun, IWorkflowLogEntry } from '../common/workflowExecutionModel.js';

export interface INodeVariable {
	name: string;
	initialValue: string; // e.g. "None", "True", "False", "0", "'admin'"
	expression?: string;  // e.g. "+ 1", "ticket.output", "monitor + 5", "'SUCCESS'"
	currentValue?: any;
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
	imports?: { type: 'agent' | 'task' | 'job' | 'project' | 'case' | 'issue' | 'analysis' | 'workflow' | string; name: string; uri?: string }[];
	outputVariable?: INodeVariable;
	outputVariables?: INodeVariable[];
	color?: string;
	textColor?: string;
	textAlign?: 'left' | 'center' | 'right';
	verticalAlign?: 'top' | 'center' | 'bottom';
	isBold?: boolean;
	isItalic?: boolean;
	isUnderline?: boolean;
	isStrikethrough?: boolean;
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
}

interface IFlowchartData {
	nodes: IFlowchartNode[];
	links: IFlowchartLink[];
	routingMode?: 'orthogonal' | 'curved';
}

function hexToRgba(hex?: string, alpha = 0.12): string {
	if (!hex || !hex.startsWith('#')) return `rgba(13, 148, 136, ${alpha})`;
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
	if (!name) return '#38bdf8';
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

export class WorkflowEditor extends EditorPane {
	static readonly ID = 'workbench.editor.workflowEditor';

	private _container: HTMLElement | undefined;
	private readonly _contentDisposables = this._register(new DisposableStore());

	private _workflowUri: URI | undefined;
	private _flowchartJsonUri: URI | undefined;
	private _data: IFlowchartData = { nodes: [], links: [] };

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

	// Dragging State
	private _isDragging = false;
	private _dragNodeId: string | null = null;
	private _dragStartX = 0;
	private _dragStartY = 0;

	// Link Label Dragging State
	private _isDraggingLinkLabel: string | null = null;
	private _dragLabelHasMoved = false;
	private _dragLabelStartX = 0;
	private _dragLabelStartY = 0;

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
	private _nodesContainer: HTMLElement | undefined;
	private _linkDeletesContainer: HTMLElement | undefined;
	private _zoomLevel: number = 1.0;
	private _zoomSizerEl?: HTMLElement;
	private _floatingZoomBadgeEl?: HTMLElement;
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
	private _activeDrawerTab: 'logs' | 'vars' = 'logs';
	private _logDrawerEl?: HTMLElement;
	private _logBodyEl?: HTMLElement;
	private _varsBodyEl?: HTMLElement;
	private _varsCountBadgeEl?: HTMLElement;
	private _logCountBadgeEl?: HTMLElement;
	private _logStatusBadgeEl?: HTMLElement;
	private _autoScrollLogs: boolean = true;
	private _isVarsFindReplaceOpen: boolean = false;
	private _varsLastFindQuery: string = '';
	private _varsLastReplaceQuery: string = '';
	private _varsFindInputEl?: HTMLInputElement;
	private _varsFindCurrentIndex: number = 0;

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
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@IWorkflowExecutionService private readonly _workflowExecutionService: IWorkflowExecutionService
	) {
		super(WorkflowEditor.ID, group, telemetryService, themeService, _storageService);
		this._isToolbarCompact = this._storageService.getBoolean('workflowEditor.toolbarCompact', StorageScope.PROFILE, false);
		this._isInspectorCompact = this._storageService.getBoolean('workflowEditor.inspectorCompact', StorageScope.PROFILE, false);
		this._isInspectorCollapsed = this._storageService.getBoolean('workflowEditor.inspectorCollapsed', StorageScope.PROFILE, false);
		this._activeLinkStyle = (this._storageService.get('workflowEditor.linkStyle', StorageScope.PROFILE, 'arrow-single') as any) || 'arrow-single';
		this._activeRoutingMode = (this._storageService.get('workflowEditor.routingMode', StorageScope.PROFILE, 'orthogonal') as any) || 'orthogonal';
		this._activeBranchDirection = (this._storageService.get('workflowEditor.branchDirection', StorageScope.PROFILE, 'right') as any) || 'right';
		this._activeNodeColor = this._storageService.get('workflowEditor.nodeColor', StorageScope.PROFILE, '#0d9488');
		this._activeLineColor = this._storageService.get('workflowEditor.lineColor', StorageScope.PROFILE, '#0d9488');
		this._activeTextColor = this._storageService.get('workflowEditor.textColor', StorageScope.PROFILE, '#ffffff');
		this._activeTextAlign = (this._storageService.get('workflowEditor.textAlign', StorageScope.PROFILE, 'center') as any) || 'center';
		this._activeVerticalAlign = (this._storageService.get('workflowEditor.verticalAlign', StorageScope.PROFILE, 'center') as any) || 'center';
		this._activeIsBold = this._storageService.getBoolean('workflowEditor.isBold', StorageScope.PROFILE, false);
		this._activeIsItalic = this._storageService.getBoolean('workflowEditor.isItalic', StorageScope.PROFILE, false);
		this._activeIsUnderline = this._storageService.getBoolean('workflowEditor.isUnderline', StorageScope.PROFILE, false);
		this._activeIsStrikethrough = this._storageService.getBoolean('workflowEditor.isStrikethrough', StorageScope.PROFILE, false);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._container = h('div.workflow-editor-container').root;
		parent.appendChild(this._container);
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		this._isPureDiagram = !!(input as any).isPureDiagram || !!(input as any).diagramUri;
		if (this._isPureDiagram) {
			this._workflowUri = (input as any).diagramUri || (input as any).resource || URI.file('');
			this._flowchartJsonUri = this._workflowUri;
		} else {
			this._workflowUri = (input as WorkflowEditorInput).workflowUri;
			this._flowchartJsonUri = URI.joinPath(this._workflowUri, '.agents', 'workflow_flowchart.json');
		}

		await this._loadFlowchartData();
		this._renderEditor();
	}

	private async _loadFlowchartData(): Promise<void> {
		if (!this._flowchartJsonUri) return;

		try {
			const exists = await this._fileService.exists(this._flowchartJsonUri);
			if (exists) {
				const content = await this._fileService.readFile(this._flowchartJsonUri);
				let parsed: any;
				try {
					parsed = JSON.parse(content.value.toString());
				} catch {
					parsed = {};
				}

				// Normalize nodes
				const rawNodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
				const nodes: IFlowchartNode[] = rawNodes.map((n: any, idx: number) => ({
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
						? n.outputVariables.map((ov: any) => ({ ...ov }))
						: (n.outputVariable ? [{ ...n.outputVariable }] : undefined),
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
				const links: IFlowchartLink[] = rawLinks.map((l: any, idx: number) => ({
					id: String(l.id || `link-${idx}`),
					from: String(l.from || l.fromNodeId || l.source || ''),
					fromPort: l.fromPort,
					to: String(l.to || l.toNodeId || l.target || ''),
					toPort: l.toPort,
					style: (l.style === 'arrow-double' || l.style === 'arrow-none' || l.style === 'dashed') ? l.style : 'arrow-single',
					routing: l.routing,
					color: l.color,
					label: l.label,
					labelPosition: typeof l.labelPosition === 'number' ? l.labelPosition : undefined
				}));

				this._data = {
					nodes,
					links,
					routingMode: parsed?.routingMode || 'orthogonal'
				};

				if (this._data.routingMode) {
					this._activeRoutingMode = this._data.routingMode;
				}

				// Initialize active styles from the most recently styled node in the loaded diagram if any
				for (let i = nodes.length - 1; i >= 0; i--) {
					const lastNode = nodes[i];
					if (lastNode.color || lastNode.textColor) {
						if (lastNode.color) this._activeNodeColor = lastNode.color;
						if (lastNode.textColor) this._activeTextColor = lastNode.textColor;
						if (lastNode.textAlign) this._activeTextAlign = lastNode.textAlign;
						if (lastNode.verticalAlign) this._activeVerticalAlign = lastNode.verticalAlign;
						if (typeof lastNode.isBold === 'boolean') this._activeIsBold = lastNode.isBold;
						if (typeof lastNode.isItalic === 'boolean') this._activeIsItalic = lastNode.isItalic;
						if (typeof lastNode.isUnderline === 'boolean') this._activeIsUnderline = lastNode.isUnderline;
						if (typeof lastNode.isStrikethrough === 'boolean') this._activeIsStrikethrough = lastNode.isStrikethrough;
						break;
					}
				}

				// Sync back to snapshot if missing in snapshot
				if (this._workflowUri) {
					const snapshot = this._entityPersistenceService.getSnapshot(this._workflowUri);
					if (snapshot && (!snapshot.customMetadata || !snapshot.customMetadata['flowchartJson'])) {
						snapshot.customMetadata = {
							...(snapshot.customMetadata || {}),
							flowchartJson: JSON.stringify(this._data, null, 2)
						};
						await this._entityPersistenceService.saveSnapshot(snapshot);
					}
				}
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

			// Initialize history baseline
			this._undoStack = [];
			this._redoStack = [];
			this._lastSavedStateJson = JSON.stringify(this._data);
		} catch (err) {
			this._notificationService.error(`Failed to load flowchart: ${err}`);
			this._data = { nodes: [], links: [] };
		}
	}

	private async _saveFlowchartData(skipHistory: boolean = false): Promise<void> {
		if (!this._flowchartJsonUri) return;

		try {
			const jsonStr = JSON.stringify(this._data, null, 2);
			const compactStr = JSON.stringify(this._data);

			if (!skipHistory && !this._isUndoingOrRedoing) {
				if (this._lastSavedStateJson && this._lastSavedStateJson !== compactStr) {
					this._undoStack.push(this._lastSavedStateJson);
					if (this._undoStack.length > 60) {
						this._undoStack.shift();
					}
					this._redoStack = [];
				}
				this._lastSavedStateJson = compactStr;
			}

			await this._fileService.writeFile(this._flowchartJsonUri, VSBuffer.fromString(jsonStr));

			// Also persist into Entity Persistence Snapshot engine for disaster recovery!
			if (this._workflowUri) {
				const snapshot = this._entityPersistenceService.getSnapshot(this._workflowUri);
				if (snapshot) {
					snapshot.customMetadata = {
						...(snapshot.customMetadata || {}),
						flowchartJson: jsonStr
					};
					await this._entityPersistenceService.saveSnapshot(snapshot);
				}
			}
		} catch (err) {
			this._notificationService.error(`Failed to save flowchart data: ${err}`);
		}
	}

	override clearInput(): void {
		this._contentDisposables.clear();
		if (this._container) {
			clearNode(this._container);
		}
		super.clearInput();
	}

	override layout(dimension: { width: number; height: number }): void {
		// Native layout override
	}

	private _renderEditor(): void {
		if (!this._container) return;

		this._contentDisposables.clear();
		clearNode(this._container);

		// 1. Toolbar Panel
		const toolbar = append(this._container, $('.workflow-editor-toolbar'));
		this._toolbarEl = toolbar;
		if (this._isToolbarCompact) {
			toolbar.classList.add('compact');
		}
		this._renderToolbar(toolbar);

		this._contentDisposables.add(this._workflowExecutionService.onDidChangeRunState(run => {
			if (this._workflowUri && (run.workflowUri === this._workflowUri.toString() || run.workflowName === (this.input as any)?.name)) {
				this._renderNodes();
				if (this._toolbarEl) {
					this._renderToolbar(this._toolbarEl);
				}
				if (this._isLogDrawerOpen) {
					this._refreshLogs(run);
				}
			}
		}));

		this._contentDisposables.add(this._workflowExecutionService.onDidEmitLog(({ runId, log }) => {
			const activeRun = this._workflowUri ? this._workflowExecutionService.getActiveRun(this._workflowUri) : undefined;
			if (activeRun && activeRun.runId === runId && this._isLogDrawerOpen) {
				this._appendLogEntry(log, true);
			}
		}));

		// 2. Center Drawing Viewport (Fixed container for floating controls)
		const canvasViewport = append(this._container, $('.workflow-canvas-viewport'));

		// Canvas Scroll Wrapper inside Viewport
		const canvasWrapper = append(canvasViewport, $('.workflow-editor-canvas-wrapper'));

		// Sizer container to enforce scroll boundaries when zoomed
		this._zoomSizerEl = append(canvasWrapper, $('.workflow-canvas-sizer'));
		this._zoomSizerEl.style.position = 'relative';

		this._canvas = append(this._zoomSizerEl, $('.workflow-editor-canvas'));
		this._canvas.style.transform = `scale(${this._zoomLevel})`;
		this._canvas.style.transformOrigin = '0 0';

		this._updateCanvasDimensions();

		// SVG Overlay
		this._svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as any;
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

		// Selection Box Overlay element
		this._selectionBoxEl = append(this._canvas, $('.workflow-selection-box'));

		// Permanent Floating Zoom Toolbar at top-center of drawing viewport (never scrolls away)
		const floatingZoom = append(canvasViewport, $('.workflow-floating-zoom-control'));
		const fZoomOut = append(floatingZoom, $('.floating-zoom-btn'));
		fZoomOut.textContent = '−';
		fZoomOut.title = 'Zoom Out (−10%)';
		fZoomOut.onclick = (e) => { e.stopPropagation(); this._setZoom(this._zoomLevel - 0.1); };

		this._floatingZoomBadgeEl = append(floatingZoom, $('.floating-zoom-badge'));
		this._floatingZoomBadgeEl.textContent = `${Math.round(this._zoomLevel * 100)}%`;
		this._floatingZoomBadgeEl.title = 'Reset Zoom to 100%';
		this._floatingZoomBadgeEl.onclick = (e) => { e.stopPropagation(); this._setZoom(1.0); };

		const fZoomIn = append(floatingZoom, $('.floating-zoom-btn'));
		fZoomIn.textContent = '+';
		fZoomIn.title = 'Zoom In (+10%)';
		fZoomIn.onclick = (e) => { e.stopPropagation(); this._setZoom(this._zoomLevel + 0.1); };

		const fDivider = append(floatingZoom, $('.floating-zoom-divider'));
		fDivider.style.width = '1px';
		fDivider.style.height = '12px';
		fDivider.style.background = 'rgba(255, 255, 255, 0.15)';
		fDivider.style.margin = '0 2px';

		const fFitBtn = append(floatingZoom, $('.floating-zoom-btn.fit-btn'));
		append(fFitBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.screenFull)));
		fFitBtn.title = 'Fit Content to Screen';
		fFitBtn.onclick = (e) => { e.stopPropagation(); this._fitView(); };

		const fExportDivider = append(floatingZoom, $('.floating-zoom-divider'));
		fExportDivider.style.width = '1px';
		fExportDivider.style.height = '12px';
		fExportDivider.style.background = 'rgba(255, 255, 255, 0.15)';
		fExportDivider.style.margin = '0 2px';

		const fExportBtn = append(floatingZoom, $('.floating-zoom-btn.export-btn'));
		append(fExportBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.desktopDownload)));
		fExportBtn.title = 'Export / Download Flowchart (PNG, JPEG, SVG, PDF)';
		fExportBtn.onclick = (e) => { e.stopPropagation(); this._showExportMenu(fExportBtn); };

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
			if (this._inspectorEl) this._renderInspector(this._inspectorEl);
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

		// Wheel zoom with Ctrl/Cmd key
		this._contentDisposables.add(addDisposableListener(canvasWrapper, 'wheel', (e: WheelEvent) => {
			if (e.ctrlKey || e.metaKey) {
				e.preventDefault();
				e.stopPropagation();
				const delta = e.deltaY < 0 ? 0.05 : -0.05;
				this._setZoom(this._zoomLevel + delta);
			}
		}, { passive: false }));

		// Mouse dragging handlers on canvas wrapper for dragging coordinates
		this._contentDisposables.add(addDisposableListener(window, 'mousemove', (e: MouseEvent) => this._onMouseMove(e)));
		this._contentDisposables.add(addDisposableListener(window, 'mouseup', (e: MouseEvent) => this._onMouseUp(e)));

		// Global Keydown Delete and Copy/Paste handler
		this._contentDisposables.add(addDisposableListener(window, 'keydown', (e: KeyboardEvent) => {
			const activeTag = document.activeElement?.tagName.toLowerCase();
			if (activeTag === 'input' || activeTag === 'textarea' || document.activeElement?.classList.contains('node-inline-editor')) {
				return;
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
				this._copySelectedNodes();
			} else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
				e.preventDefault();
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
						this._selectedNodeIds.clear();
						this._selectedLinkIds.clear();
						this._renderNodes();
						this._drawLinks();
						if (this._inspectorEl) {
							this._renderInspector(this._inspectorEl);
						}
					}

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
							imports: [{ type: type as any, name }],
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

						if (parsed && (parsed.kind === 'variable' || parsed.kind === 'variable_widget')) {
							const id = `node_${Date.now()}`;
							const newNode: IFlowchartNode = {
								id,
								type: 'round-rect',
								x: Math.max(10, x - 50),
								y: Math.max(10, y - 25),
								width: 100,
								height: 50,
								label: 'State',
								outputVariables: [],
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
							if (this._inspectorEl) this._renderInspector(this._inspectorEl);
							this._refreshVariablesDrawer(id);
							setTimeout(() => {
								this._openNodeVariableInlineEditor(newNode);
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
	}

	private _openLogDrawer(): void {
		this._isLogDrawerOpen = true;
		if (this._logDrawerEl) {
			this._logDrawerEl.style.display = 'flex';
			if (this._activeDrawerTab === 'logs') {
				const activeRun = this._workflowUri ? this._workflowExecutionService.getActiveRun(this._workflowUri) : undefined;
				if (activeRun) {
					this._refreshLogs(activeRun);
				}
			} else {
				this._refreshVariablesDrawer();
			}
		}
		if (this._toolbarEl) {
			this._renderToolbar(this._toolbarEl);
		}
	}

	private _openDrawerTab(tab: 'logs' | 'vars', targetNodeId?: string): void {
		this._activeDrawerTab = tab;
		this._isLogDrawerOpen = true;
		if (this._logDrawerEl) {
			this._logDrawerEl.style.display = 'flex';
			this._switchDrawerTab(tab, targetNodeId);
		}
		if (this._toolbarEl) {
			this._renderToolbar(this._toolbarEl);
		}
	}

	private _switchDrawerTab(tab: 'logs' | 'vars', targetNodeId?: string): void {
		this._activeDrawerTab = tab;
		if (!this._logDrawerEl) return;

		const tabs = this._logDrawerEl.querySelectorAll('.drawer-tab');
		if (tabs.length >= 2) {
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
			this._varsBodyEl.style.display = tab === 'vars' ? 'block' : 'none';
			if (tab === 'vars') {
				this._refreshVariablesDrawer(targetNodeId);
			}
		}

		if (activeRun) {
			if (this._logStatusBadgeEl) {
				this._logStatusBadgeEl.textContent = activeRun.status.toUpperCase();
				this._logStatusBadgeEl.className = `log-status-badge status-${activeRun.status}`;
			}
			if (this._logCountBadgeEl) {
				this._logCountBadgeEl.textContent = `${activeRun.logs?.length || 0} events`;
			}
		}

		// Only show clear log button on Execution Logs tab
		const clearBtn = this._logDrawerEl.querySelector('.log-clear-btn') as HTMLElement | null;
		if (clearBtn) {
			clearBtn.style.display = tab === 'logs' ? 'inline-flex' : 'none';
		}

		// Only show Find & Replace toggle button on Context Variables tab
		const findReplaceToggleBtn = this._logDrawerEl.querySelector('.vars-find-replace-toggle-btn') as HTMLElement | null;
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
		if (!this._logBodyEl) return;
		clearNode(this._logBodyEl);
		for (const log of run.logs) {
			this._appendLogEntry(log, false);
		}
		if (this._autoScrollLogs) {
			this._logBodyEl.scrollTop = this._logBodyEl.scrollHeight;
		}
	}

	private _getNodeVariables(node: IFlowchartNode): INodeVariable[] {
		if (Array.isArray(node.outputVariables) && node.outputVariables.length > 0) {
			return node.outputVariables;
		}
		if (node.outputVariable && node.outputVariable.name) {
			node.outputVariables = [node.outputVariable];
			return node.outputVariables;
		}
		if (!node.outputVariables) {
			node.outputVariables = [];
		}
		return node.outputVariables;
	}

	private _unbindVariableFromNode(node: IFlowchartNode, targetVar: string | INodeVariable): void {
		const vars = this._getNodeVariables(node);
		let idx = -1;
		if (typeof targetVar === 'string') {
			idx = vars.findIndex(v => v.name === targetVar);
		} else {
			idx = vars.indexOf(targetVar);
			if (idx === -1) {
				idx = vars.findIndex(v => v.name === targetVar.name);
			}
		}
		if (idx !== -1) {
			vars.splice(idx, 1);
		}
		if (vars.length === 0) {
			delete node.outputVariable;
			delete node.outputVariables;
		} else {
			node.outputVariable = vars[0];
		}
		this._saveFlowchartData();
		this._renderNodes();
		this._drawLinks();
		if (this._inspectorEl) this._renderInspector(this._inspectorEl);
		this._refreshVariablesDrawer();
	}

	private _updateExistingVarsDatalist(): void {
		let dl = document.getElementById('workflow-existing-vars-list') as HTMLDataListElement;
		if (!dl) {
			dl = document.createElement('datalist');
			dl.id = 'workflow-existing-vars-list';
			document.body.appendChild(dl);
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
		for (const node of this._data?.nodes || []) {
			for (const v of this._getNodeVariables(node)) {
				allVars.push({ node, variable: v });
			}
		}

		if (this._varsCountBadgeEl) {
			this._varsCountBadgeEl.textContent = `${allVars.length} vars`;
		}

		if (!this._varsBodyEl) return;
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

		const table = append(this._varsBodyEl, $('table.workflow-vars-table'));
		const thead = append(table, $('thead'));
		const headerRow = append(thead, $('tr'));
		append(headerRow, $('th')).textContent = 'Variable Name';
		append(headerRow, $('th')).textContent = 'Bound Node';
		const initTh = append(headerRow, $('th'));
		initTh.textContent = 'Initial Value (Python)';
		initTh.style.width = '140px';
		append(headerRow, $('th')).textContent = 'References';
		append(headerRow, $('th')).textContent = 'Runtime Value';
		append(headerRow, $('th')).textContent = 'Action';

		const tbody = append(table, $('tbody'));
		const activeRun = this._workflowUri ? this._workflowExecutionService.getActiveRun(this._workflowUri) : undefined;
		const activeNodeId = targetNodeId || Array.from(this._selectedNodeIds)[0];

		for (const item of allVars) {
			const isTarget = item.node.id === activeNodeId;
			const row = append(tbody, $(`tr${isTarget ? '.highlighted-var-row' : ''}`));

			// 1. Variable Name
			const nameTd = append(row, $('td'));
			const nameInput = append(nameTd, $('input.vars-table-input')) as HTMLInputElement;
			nameInput.type = 'text';
			nameInput.value = item.variable.name;
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

			// 2. Bound Node
			const nodeTd = append(row, $('td'));
			const nodeLink = append(nodeTd, $('.vars-table-node-link'));
			append(nodeLink, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolEvent)));
			append(nodeLink, $('span.node-link-text')).textContent = item.node.label || item.node.id;
			nodeLink.title = `Click to locate & select node '${item.node.label}' on canvas`;
			nodeLink.onclick = () => {
				this._selectedNodeIds.clear();
				this._selectedNodeIds.add(item.node.id);
				this._renderNodes();
				if (this._inspectorEl) this._renderInspector(this._inspectorEl);
				this._centerOnNode(item.node);
				this._refreshVariablesDrawer(item.node.id);
			};

			// 3. Initial Value (Python literal, compact)
			const initTd = append(row, $('td'));
			initTd.style.width = '140px';
			initTd.style.maxWidth = '140px';
			const initInput = append(initTd, $('input.vars-table-input')) as HTMLInputElement;
			initInput.style.width = '120px';
			initInput.style.maxWidth = '120px';
			initInput.type = 'text';
			initInput.value = item.variable.initialValue || 'None';
			initInput.placeholder = "None, True, 0";
			initInput.onchange = () => {
				item.variable.initialValue = initInput.value.trim() || 'None';
				this._saveFlowchartData();
				this._renderNodes();
				this._drawLinks();
				if (this._inspectorEl) this._renderInspector(this._inspectorEl);
			};

			// 4. References Column (Writes and Reads tracing)
			const varName = item.variable.name;
			const regexAt = new RegExp(`@${varName}\\b`);
			const regexWord = new RegExp(`\\b${varName}\\b`);

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
				if (this._inspectorEl) this._renderInspector(this._inspectorEl);
				this._centerOnNode(item.node);
				this._notificationService.info(`Variable '${varName}': ${writeNodes.length} write(s), ${readLinks.length} read(s).`);
			};

			// 5. Runtime Value
			const valTd = append(row, $('td'));
			const runtimeVal = activeRun?.contextVariables ? activeRun.contextVariables[item.variable.name] : undefined;
			const valBadge = append(valTd, $(`.vars-table-val-badge${runtimeVal === undefined ? '.not-run' : ''}`));
			valBadge.textContent = runtimeVal !== undefined ? (typeof runtimeVal === 'object' ? JSON.stringify(runtimeVal) : String(runtimeVal)) : '(not evaluated)';

			// 6. Action (Unbind / Delete)
			const actionTd = append(row, $('td'));
			const unbindBtn = append(actionTd, $('.vars-table-action-btn'));
			unbindBtn.title = `Unbind variable '${item.variable.name}' from '${item.node.label}'`;
			append(unbindBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
			unbindBtn.onclick = () => {
				this._unbindVariableFromNode(item.node, item.variable.name);
			};

			if (isTarget) {
				setTimeout(() => {
					row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
					nameInput.focus();
				}, 60);
			}
		}
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

		if (!this._data || !findName.trim()) return results;

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
		if (this._inspectorEl) this._renderInspector(this._inspectorEl);
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
		if (this._inspectorEl) this._renderInspector(this._inspectorEl);
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
		findInput.placeholder = localize('findVarPlaceholder', 'Find variable name (查找变量名)...');
		this._varsFindInputEl = findInput;
		if (this._varsLastFindQuery) {
			findInput.value = this._varsLastFindQuery;
		}

		const arrowIcon = append(bar, $('.vars-replace-arrow'));
		arrowIcon.textContent = '➔';
		arrowIcon.style.color = '#38bdf8';
		arrowIcon.style.fontSize = '12px';

		const replaceGroup = append(bar, $('.vars-replace-input-group'));
		append(replaceGroup, $('span' + ThemeIcon.asCSSSelector(Codicon.replace)));
		const replaceInput = append(replaceGroup, $('input.vars-replace-input')) as HTMLInputElement;
		replaceInput.type = 'text';
		replaceInput.placeholder = localize('replaceVarPlaceholder', 'Replace with (替换为)...');
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

		// Replace Next (一个个换) Button
		const replaceNextBtn = append(actions, $('button.vars-find-btn.btn-next'));
		replaceNextBtn.textContent = localize('replaceNextBtn', 'Replace (换下一个)');
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

		// Replace All (一口气全换) Button
		const replaceAllBtn = append(actions, $('button.vars-find-btn.btn-all'));
		replaceAllBtn.textContent = localize('replaceAllBtn', 'Replace All (全部替换)');
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
		closeBtn.textContent = '✕';
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

	private _centerOnNode(node: IFlowchartNode): void {
		const wrapper = this._canvas?.parentElement;
		if (!wrapper) return;
		const targetX = (node.x + node.width / 2) * this._zoomLevel - wrapper.clientWidth / 2;
		const targetY = (node.y + node.height / 2) * this._zoomLevel - wrapper.clientHeight / 2;
		wrapper.scrollTo({
			left: Math.max(0, targetX),
			top: Math.max(0, targetY),
			behavior: 'smooth'
		});
	}

	private _appendLogEntry(log: IWorkflowLogEntry, shouldScroll = true): void {
		if (!this._logBodyEl) return;
		const line = append(this._logBodyEl, $(`.workflow-log-line.level-${log.level}`));
		const timeStr = new Date(log.timestamp).toLocaleTimeString();
		append(line, $('.log-time')).textContent = `[${timeStr}]`;
		const levelBadge = append(line, $(`.log-badge.badge-${log.level}`));
		levelBadge.textContent = log.level.toUpperCase();
		if (log.nodeId) {
			const node = this._data?.nodes.find(n => n.id === log.nodeId);
			const nodeBadge = append(line, $('.log-node'));
			nodeBadge.textContent = `[${node?.label || log.nodeId}]`;
		}
		append(line, $('.log-msg')).textContent = log.message;

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
		if (!this._isLogDrawerOpen) {
			drawer.style.display = 'none';
		}

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

		logsTab.onclick = () => {
			this._switchDrawerTab('logs');
		};
		varsTab.onclick = () => {
			this._switchDrawerTab('vars');
		};

		const right = append(header, $('.log-header-right'));
		// Reset Execution Button
		const resetBtn = append(right, $('.log-btn-icon'));
		resetBtn.title = localize('resetExecutionTooltip', 'Reset Workflow State to IDLE & Clear Highlights (复位执行状态)');
		append(resetBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.debugRestart)));
		resetBtn.onclick = () => {
			if (!this._workflowUri) return;
			this._workflowExecutionService.resetWorkflow(this._workflowUri);
			if (this._toolbarEl) {
				this._renderToolbar(this._toolbarEl);
			}
			this._renderNodes();
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
			this._notificationService.info(localize('workflowResetInfo', 'Workflow execution reset to IDLE.'));
		};

		// Clear Logs Button (only visible in Execution Logs tab)
		const clearBtn = append(right, $('.log-btn-icon.log-clear-btn'));
		clearBtn.title = localize('clearLogsTooltip', 'Clear Execution Logs (清空运行日志)');
		append(clearBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.clearAll)));
		clearBtn.onclick = () => {
			if (this._logBodyEl) {
				clearNode(this._logBodyEl);
			}
			if (this._logCountBadgeEl) {
				this._logCountBadgeEl.textContent = '0 events';
			}
		};

		// Find & Replace Button (only visible in Context Variables tab)
		const findReplaceBtn = append(right, $('.log-btn-icon.vars-find-replace-toggle-btn'));
		findReplaceBtn.title = localize('findReplaceVarsTooltip', 'Find & Replace Variable Names (查找与替换变量名 Ctrl/Cmd+R)');
		append(findReplaceBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.replace)));
		findReplaceBtn.onclick = () => {
			this._toggleVarsFindReplaceBar();
		};

		// Close Button
		const closeBtn = append(right, $('.log-btn-icon'));
		closeBtn.title = localize('closeDrawerTooltip', 'Close Bottom Panel (关闭底部面板)');
		append(closeBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
		closeBtn.onclick = () => {
			this._closeLogDrawer();
		};

		// Body 1: Execution Logs
		this._logBodyEl = append(drawer, $('.workflow-log-body'));

		// Body 2: Context Variables Table
		this._varsBodyEl = append(drawer, $('.workflow-vars-body'));

		this._switchDrawerTab(this._activeDrawerTab);
	}

	private _renderToolbar(parent: HTMLElement): void {
		clearNode(parent);

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
		const isRunning = activeRun && (activeRun.status === 'running' || activeRun.status === 'waiting_human');

		const execGrid = append(execSec, $(`.workflow-shape-grid${this._isToolbarCompact ? '.compact-1col' : ''}`));

		// 1. Run Button
		const runBtn = append(execGrid, $(`.workflow-toolbar-item.exec-btn${this._isToolbarCompact ? '.compact-item' : ''}`));
		runBtn.title = isRunning ? 'Workflow executing...' : 'Run Workflow';
		append(runBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.play)));
		if (!this._isToolbarCompact) {
			append(runBtn, $('.item-label')).textContent = isRunning ? 'Running' : 'Run';
		}
		if (isRunning) {
			runBtn.classList.add('active');
		}
		runBtn.onclick = async () => {
			if (!this._workflowUri) return;
			try {
				this._openLogDrawer();
				await this._workflowExecutionService.executeWorkflow(this._workflowUri, {
					mode: 'standard',
					initialData: this._data
				});
				this._renderToolbar(parent);
				this._renderNodes();
			} catch (e: any) {
				this._notificationService.error(e.message || String(e));
			}
		};

		// 2. Step Button
		const stepBtn = append(execGrid, $(`.workflow-toolbar-item.exec-btn${this._isToolbarCompact ? '.compact-item' : ''}`));
		stepBtn.title = 'Step Next Node';
		append(stepBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.debugStepOver)));
		if (!this._isToolbarCompact) {
			append(stepBtn, $('.item-label')).textContent = 'Step';
		}
		stepBtn.onclick = async () => {
			if (!this._workflowUri) return;
			try {
				this._openLogDrawer();
				await this._workflowExecutionService.stepWorkflow(this._workflowUri, {
					initialData: this._data
				});
				this._renderToolbar(parent);
				this._renderNodes();
			} catch (e: any) {
				this._notificationService.error(e.message || String(e));
			}
		};

		// 3. Pause / Resume Button
		if (isRunning) {
			const pauseBtn = append(execGrid, $(`.workflow-toolbar-item.exec-btn${this._isToolbarCompact ? '.compact-item' : ''}`));
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
			stopBtn.title = 'Stop Workflow';
			append(stopBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.debugStop)));
			if (!this._isToolbarCompact) {
				append(stopBtn, $('.item-label')).textContent = 'Stop';
			}
			stopBtn.onclick = async () => {
				await this._workflowExecutionService.stopWorkflow(activeRun.runId);
				this._renderToolbar(parent);
				this._renderNodes();
			};
		}

		// 5. Execution Console & Variables Drawer Toggle Button
		const logsBtn = append(execGrid, $(`.workflow-toolbar-item.exec-btn${this._isToolbarCompact ? '.compact-item' : ''}`));
		logsBtn.title = localize('logsConsoleTitle', 'Execution Console & Variables Drawer (运行控制台与上下文变量)');
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

		// 6. Reset Execution Button (复位)
		const resetBtn = append(execGrid, $(`.workflow-toolbar-item.exec-btn${this._isToolbarCompact ? '.compact-item' : ''}`));
		resetBtn.title = localize('resetWorkflowTitle', 'Reset Workflow Execution (Clear node highlights & status)');
		append(resetBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.debugRestart)));
		if (!this._isToolbarCompact) {
			append(resetBtn, $('.item-label')).textContent = 'Reset';
		}
		resetBtn.onclick = () => {
			if (!this._workflowUri) return;
			this._workflowExecutionService.resetWorkflow(this._workflowUri);
			this._renderToolbar(parent);
			this._renderNodes();
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
			this._notificationService.info(localize('workflowResetInfo', 'Workflow execution reset to IDLE.'));
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

		// Section: Context Variables
		const varSec = append(parent, $('.workflow-toolbar-section.variables-section'));
		if (!this._isToolbarCompact) {
			const varTitle = append(varSec, $('.workflow-toolbar-title'));
			varTitle.textContent = localize('contextVariables', 'Context Variables');
		}

		const varGrid = append(varSec, $(`.workflow-shape-grid${this._isToolbarCompact ? '.compact-1col' : ''}`));
		const varItem = append(varGrid, $(`.workflow-toolbar-item.variable-toolbar-item${this._isToolbarCompact ? '.compact-item' : ''}`));
		varItem.setAttribute('draggable', 'true');
		varItem.title = localize('dragVariableTitle', 'Context Variable (Drag into any node to bind output)');
		varItem.ondragstart = (e: DragEvent) => {
			e.dataTransfer?.setData('text/plain', JSON.stringify({ kind: 'variable_widget' }));
			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'copy';
			}
		};

		const vBoxBadge = append(varItem, $('.var-icon-badge'));
		vBoxBadge.textContent = '[V]';
		if (!this._isToolbarCompact) {
			append(varItem, $('.item-label')).textContent = localize('varLabel', 'Variable');
		}
		varItem.onclick = () => {
			if (this._selectedNodeIds.size === 1) {
				const selectedId = Array.from(this._selectedNodeIds)[0];
				const targetNode = this._data.nodes.find(n => n.id === selectedId);
				if (targetNode) {
					this._openNodeVariableInlineEditor(targetNode);
				}
			} else {
				this._notificationService.info(localize('dragVariableHint', 'Drag Variable onto any node to define, update, or capture ticket results.'));
			}
		};

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

		const directions: { dir: 'right' | 'bottom' | 'left' | 'top'; label: string; icon: any }[] = [
			{ dir: 'right', label: 'Right (→)', icon: Codicon.arrowRight },
			{ dir: 'bottom', label: 'Down (↓)', icon: Codicon.arrowDown },
			{ dir: 'left', label: 'Left (←)', icon: Codicon.arrowLeft },
			{ dir: 'top', label: 'Up (↑)', icon: Codicon.arrowUp }
		];

		const currentDirInfo = directions.find(d => d.dir === this._activeBranchDirection) || directions[0];

		if (this._isToolbarCompact) {
			// Single Cycle Button in Compact Mode
			const cycleBtn = append(branchSec, $('.workflow-toolbar-item.compact-item.active'));
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
				append(btn, $('span' + ThemeIcon.asCSSSelector(d.icon)));
				btn.title = `Tab Branch: ${d.label}`;
				btn.onclick = () => {
					this._activeBranchDirection = d.dir;
					this._storageService.store('workflowEditor.branchDirection', this._activeBranchDirection, StorageScope.PROFILE, StorageTarget.USER);
					this._renderToolbar(parent);
				};
			}
		}
	}

	private _showColorPickerFlyout(anchorEl: HTMLElement, currentColor: string, colors: { name: string; hex: string }[], onSelect: (hex: string) => void): void {
		const existing = document.querySelector('.workflow-color-flyout-popover');
		if (existing) existing.remove();

		const popover = document.createElement('div');
		popover.className = 'workflow-color-flyout-popover';
		const rect = anchorEl.getBoundingClientRect();
		popover.style.position = 'fixed';
		popover.style.right = `${window.innerWidth - rect.left + 8}px`;
		popover.style.top = `${Math.max(10, Math.min(window.innerHeight - 150, rect.top - 20))}px`;
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

		document.body.appendChild(popover);

		const dismiss = (e: MouseEvent) => {
			if (!popover.contains(e.target as Node) && e.target !== anchorEl) {
				popover.remove();
				window.removeEventListener('mousedown', dismiss, true);
			}
		};
		setTimeout(() => window.addEventListener('mousedown', dismiss, true), 50);
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
								if (link) link.color = hex;
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
								if (link) link.color = c.hex;
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
							if (link) link.routing = rm.mode;
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
				{ style: 'dashed', label: 'Dashed (╌)', shortLabel: '╌' }
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
							if (link) link.style = as.style;
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

		let currentColor = this._activeNodeColor || '#0d9488';
		let currentTextColor = this._activeTextColor || '#ffffff';
		let isBold = this._activeIsBold;
		let isItalic = this._activeIsItalic;
		let isUnderline = this._activeIsUnderline;
		let isStrikethrough = this._activeIsStrikethrough;
		let textAlign: 'left' | 'center' | 'right' = this._activeTextAlign || 'center';
		let verticalAlign: 'top' | 'center' | 'bottom' = this._activeVerticalAlign || 'center';

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
							if (node) node.color = hex;
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
							if (node) node.color = c.hex;
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
					if (node) node.isBold = nextVal;
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
					if (node) node.isItalic = nextVal;
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
					if (node) node.isUnderline = nextVal;
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
					if (node) node.isStrikethrough = nextVal;
				}
				this._saveFlowchartData();
				this._renderNodes();
			}
			this._renderInspector(parent);
		};

		// Row 2: Horizontal Alignment (Left, Center, Right)
		const alignRow = append(textSec, $(`.workflow-format-row${this._isInspectorCompact ? '.compact-col' : ''}`));
		const alignChoices: { align: 'left' | 'center' | 'right'; label: string; shortLabel: string; title: string }[] = [
			{ align: 'left', label: 'Left', shortLabel: 'L', title: 'Align Left' },
			{ align: 'center', label: 'Center', shortLabel: 'C', title: 'Align Center' },
			{ align: 'right', label: 'Right', shortLabel: 'R', title: 'Align Right' }
		];
		for (const ac of alignChoices) {
			const aBtn = append(alignRow, $(`.workflow-format-btn.text-btn${textAlign === ac.align ? '.active' : ''}`));
			aBtn.textContent = this._isInspectorCompact ? ac.shortLabel : ac.label;
			aBtn.title = ac.title;
			aBtn.onclick = () => {
				this._activeTextAlign = ac.align;
				this._storageService.store('workflowEditor.textAlign', this._activeTextAlign, StorageScope.PROFILE, StorageTarget.USER);
				if (this._selectedNodeIds.size > 0) {
					for (const id of this._selectedNodeIds) {
						const node = this._data.nodes.find(n => n.id === id);
						if (node) node.textAlign = ac.align;
					}
					this._saveFlowchartData();
					this._renderNodes();
				}
				this._renderInspector(parent);
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
						if (node) node.verticalAlign = va.align;
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
							if (node) node.textColor = hex;
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
							if (node) node.textColor = tc.hex;
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
								v.name = cleaned;
								selectedNode.outputVariable = nodeVars[0];
								this._saveFlowchartData();
								this._renderNodes();
								this._refreshVariablesDrawer();
							};

							if (isUpdatingExisting) {
								// This node is modifying an existing variable from an upstream node!
								const exprRow = append(varCard, $('.workflow-var-row'));
								exprRow.style.marginTop = '6px';
								const exprLabel = append(exprRow, $('.workflow-var-label'));
								exprLabel.textContent = localize('varOperation', 'Operation / Assignment (操作 / 赋值):');
								const exprInput = append(exprRow, $('input.workflow-var-input')) as HTMLInputElement;
								exprInput.style.width = '100%';
								exprInput.style.boxSizing = 'border-box';
								exprInput.type = 'text';
								exprInput.value = v.expression || '';
								exprInput.placeholder = "e.g. += 1, -= 1, = ticket.output, = 'DONE'";
								exprInput.onchange = () => {
									v.expression = exprInput.value.trim() || undefined;
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
								initLabel.textContent = localize('varInit', 'Initial Value (Python 初值):');
								const initInput = append(initRow, $('input.workflow-var-input')) as HTMLInputElement;
								initInput.style.width = '100%';
								initInput.style.boxSizing = 'border-box';
								initInput.type = 'text';
								initInput.value = v.initialValue || 'None';
								initInput.placeholder = "0, None, True, 'admin'";
								initInput.onchange = () => {
									v.initialValue = initInput.value.trim() || 'None';
									if (selectedNode.outputVariables) {
										const found = selectedNode.outputVariables.find(x => x.name === v.name);
										if (found) found.initialValue = v.initialValue;
									}
									if (selectedNode.outputVariable && selectedNode.outputVariable.name === v.name) {
										selectedNode.outputVariable.initialValue = v.initialValue;
									}
									this._saveFlowchartData();
									this._renderNodes();
									this._drawLinks();
									this._refreshVariablesDrawer();
								};

								const exprRow = append(varCard, $('.workflow-var-row'));
								exprRow.style.marginTop = '6px';
								const exprLabel = append(exprRow, $('.workflow-var-label'));
								exprLabel.textContent = localize('varExprOpt', 'Operation on this Node (本节点操作, 可选):');
								const exprInput = append(exprRow, $('input.workflow-var-input')) as HTMLInputElement;
								exprInput.style.width = '100%';
								exprInput.style.boxSizing = 'border-box';
								exprInput.type = 'text';
								exprInput.value = v.expression || '';
								exprInput.placeholder = "e.g. += 1, = ticket.output (optional)";
								exprInput.onchange = () => {
									v.expression = exprInput.value.trim() || undefined;
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
	}

	private _updateCanvasDimensions(additionalX?: number, additionalY?: number): void {
		let maxRight = WorkflowEditor.DEFAULT_CANVAS_WIDTH;
		let maxBottom = WorkflowEditor.DEFAULT_CANVAS_HEIGHT;

		if (this._data && Array.isArray(this._data.nodes)) {
			for (const node of this._data.nodes) {
				const right = (node.x || 0) + (node.width || 120) + 1200;
				const bottom = (node.y || 0) + (node.height || 50) + 1000;
				if (right > maxRight) maxRight = right;
				if (bottom > maxBottom) maxBottom = bottom;
			}
		}

		if (additionalX !== undefined) {
			const candidateX = additionalX + 1200;
			if (candidateX > maxRight) maxRight = candidateX;
		}
		if (additionalY !== undefined) {
			const candidateY = additionalY + 1000;
			if (candidateY > maxBottom) maxBottom = candidateY;
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

	private _setZoom(level: number): void {
		this._zoomLevel = Math.max(0.25, Math.min(2.0, Math.round(level * 100) / 100));
		if (this._canvas) {
			this._canvas.style.transform = `scale(${this._zoomLevel})`;
			this._canvas.style.transformOrigin = '0 0';
		}
		if (this._zoomSizerEl) {
			this._zoomSizerEl.style.width = `${this._currentCanvasWidth * this._zoomLevel}px`;
			this._zoomSizerEl.style.height = `${this._currentCanvasHeight * this._zoomLevel}px`;
		}
		const zoomText = `${Math.round(this._zoomLevel * 100)}%`;
		if (this._floatingZoomBadgeEl) {
			this._floatingZoomBadgeEl.textContent = zoomText;
		}
	}

	private _fitView(): void {
		if (!this._data.nodes.length || !this._canvas) {
			this._setZoom(1.0);
			return;
		}
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const node of this._data.nodes) {
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

	private _renderNodes(): void {
		this._updateCanvasDimensions();
		if (!this._nodesContainer) return;
		clearNode(this._nodesContainer);

		if (!this._data || !Array.isArray(this._data.nodes)) {
			return;
		}

		for (const node of this._data.nodes) {
			const nodeEl = append(this._nodesContainer, $(`.workflow-node.${node.type}${node.groupId ? '.grouped' : ''}`));
			nodeEl.setAttribute('data-node-id', node.id);
			if (node.groupId) {
				nodeEl.setAttribute('data-group-id', node.groupId);
			}
			nodeEl.style.left = `${node.x}px`;
			nodeEl.style.top = `${node.y}px`;
			nodeEl.style.width = `${node.width}px`;
			nodeEl.style.height = `${node.height}px`;

			// Custom Node Theme Color & Geometry
			if (node.type === 'diamond') {
				const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as any;
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
			const activeRun = this._workflowUri ? this._workflowExecutionService.getActiveRun(this._workflowUri) : undefined;
			const nodeRunState = activeRun?.nodeStates[node.id];
			if (nodeRunState) {
				if (nodeRunState.status === 'running') {
					nodeEl.classList.add('status-running');
				} else if (nodeRunState.status === 'success') {
					nodeEl.classList.add('status-success');
				} else if (nodeRunState.status === 'failed') {
					nodeEl.classList.add('status-failed');
				} else if (nodeRunState.status === 'waiting_human') {
					nodeEl.classList.add('status-waiting-human');

					// Human Approval Interactive Card
					const humanCard = append(nodeEl, $('.node-human-approval-card'));
					humanCard.textContent = '⏸ Waiting Approval [Approve]';
					humanCard.title = 'Click to approve and continue workflow execution';
					humanCard.onmousedown = (e) => e.stopPropagation();
					humanCard.onclick = (e) => {
						e.stopPropagation();
						this._workflowExecutionService.resumeWorkflow(activeRun!.runId, { approved: true, action: 'approved', timestamp: Date.now() });
					};
				}
			}

			const isSelected = this._selectedNodeIds.has(node.id);
			if (isSelected) {
				nodeEl.classList.add('selected');

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
					const rect = this._canvas!.getBoundingClientRect();
					this._isConnecting = true;
					this._tempLinkStartX = (e.clientX - rect.left) / this._zoomLevel;
					this._tempLinkStartY = (e.clientY - rect.top) / this._zoomLevel;
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
			nodeEl.ondragover = (e: DragEvent) => {
				e.preventDefault();
				e.stopPropagation();
				if (e.dataTransfer) {
					e.dataTransfer.dropEffect = 'copy';
				}
				nodeEl.classList.add('drag-hover');
			};

			nodeEl.ondragleave = () => {
				nodeEl.classList.remove('drag-hover');
			};

			nodeEl.ondrop = (e: DragEvent) => {
				e.preventDefault();
				e.stopPropagation();
				nodeEl.classList.remove('drag-hover');

				const dataStr = e.dataTransfer?.getData('text/plain');
				if (!dataStr) return;

				// 1. Context Variable dropped onto node
				try {
					const parsed = JSON.parse(dataStr);
					if (parsed && (parsed.kind === 'variable' || parsed.kind === 'variable_widget')) {
						this._selectedNodeIds.clear();
						this._selectedNodeIds.add(node.id);
						this._renderNodes();
						if (this._inspectorEl) this._renderInspector(this._inspectorEl);
						setTimeout(() => {
							this._openNodeVariableInlineEditor(node);
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
						node.imports.push({ type: type as any, name });
						this._saveFlowchartData();
						this._renderNodes();
						this._drawLinks();
						this._notificationService.info(`Successfully imported ${type} '${name}' into '${node.label}'`);
					}
				}
			};

			const contentWrapper = append(nodeEl, $('.node-content-wrapper'));

			const labelWrapper = append(contentWrapper, $('.node-label'));
			labelWrapper.textContent = node.label || '';

			// Render Output Context Variable Pills if bound
			const nodeVars = this._getNodeVariables(node);
			if (nodeVars.length > 0) {
				const activeRun = this._workflowUri ? this._workflowExecutionService.getActiveRun(this._workflowUri) : undefined;
				const varsContainer = append(contentWrapper, $('.node-variables-container'));
				varsContainer.style.display = 'flex';
				varsContainer.style.flexWrap = 'wrap';
				varsContainer.style.gap = '4px';
				varsContainer.style.marginTop = '4px';
				varsContainer.style.justifyContent = 'center';

				for (const v of nodeVars) {
					const runtimeVal = activeRun?.contextVariables ? activeRun.contextVariables[v.name] : undefined;
					const displayVal = runtimeVal !== undefined ? (typeof runtimeVal === 'object' ? JSON.stringify(runtimeVal) : String(runtimeVal)) : (v.initialValue || 'None');

					const varPill = append(varsContainer, $('.node-variable-pill'));
					varPill.title = `Context Variable: ${v.name} = ${displayVal} (Double-click to inline edit expression, click to select)`;
					varPill.onmousedown = (e) => {
						e.stopPropagation();
					};
					varPill.onclick = (e) => {
						e.stopPropagation();
						if (!this._selectedNodeIds.has(node.id)) {
							this._selectedNodeIds.clear();
							this._selectedNodeIds.add(node.id);
							this._renderNodes();
							if (this._inspectorEl) {
								this._renderInspector(this._inspectorEl);
							}
						}
					};
					varPill.ondblclick = (e) => {
						e.stopPropagation();
						e.preventDefault();
						this._openNodeVariableInlineEditor(node, v, varPill);
					};

					const vBadge = append(varPill, $('.var-tag-icon'));
					vBadge.textContent = '[V]';

					let pillText = `${v.name} = ${displayVal}`;
					if (v.expression) {
						let expr = v.expression.trim();
						if (expr.startsWith(`${v.name} =`)) {
							expr = expr.substring(`${v.name} =`.length).trim();
						} else if (expr.startsWith(`${v.name}=`)) {
							expr = expr.substring(`${v.name}=`.length).trim();
						}
						// Strip unnecessary @ prefix for clean human readability: e.g. "@monitor1" -> "monitor1"
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
					append(varPill, $('.var-pill-text')).textContent = pillText;

					const removeVarBtn = append(varPill, $('.var-pill-remove'));
					removeVarBtn.title = 'Remove variable';
					append(removeVarBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
					removeVarBtn.onmousedown = (e) => {
						e.stopPropagation();
					};
					removeVarBtn.onclick = (e) => {
						e.stopPropagation();
						e.preventDefault();
						this._unbindVariableFromNode(node, v);
					};
				}
			}

			// Multiline formatting & Alignment
			const textAlign = node.textAlign || 'center';
			labelWrapper.style.textAlign = textAlign;
			if (textAlign === 'left') {
				labelWrapper.style.textAlign = 'left';
				contentWrapper.style.alignItems = 'flex-start';
			} else if (textAlign === 'right') {
				labelWrapper.style.textAlign = 'right';
				contentWrapper.style.alignItems = 'flex-end';
			} else {
				labelWrapper.style.textAlign = 'center';
				contentWrapper.style.alignItems = 'center';
			}

			const verticalAlign = node.verticalAlign || 'center';
			if (verticalAlign === 'top') {
				contentWrapper.style.justifyContent = 'flex-start';
				contentWrapper.style.paddingTop = '6px';
			} else if (verticalAlign === 'bottom') {
				contentWrapper.style.justifyContent = 'flex-end';
				contentWrapper.style.paddingBottom = '6px';
			} else {
				contentWrapper.style.justifyContent = 'center';
			}

			if (node.isBold) {
				labelWrapper.style.fontWeight = '700';
			}
			if (node.isItalic) {
				labelWrapper.style.fontStyle = 'italic';
			}
			const textDecorations: string[] = [];
			if (node.isUnderline) textDecorations.push('underline');
			if (node.isStrikethrough) textDecorations.push('line-through');
			if (textDecorations.length > 0) {
				labelWrapper.style.textDecoration = textDecorations.join(' ');
			}
			if (node.textColor) {
				labelWrapper.style.color = node.textColor;
			}

			nodeEl.ondblclick = (e) => {
				e.stopPropagation();
				this._showInlineEditor(nodeEl, node);
			};

			if (!this._isPureDiagram && node.imports && node.imports.length > 0) {
				const badgesContainer = append(contentWrapper, $('.node-imports-badges-container'));
				const totalImports = node.imports.length;
				// Dynamic limit based on node width (at least 2, max 4 visible pills)
				const maxVisible = Math.max(1, Math.min(4, Math.floor(((node.width || 120) - 16) / 55)));
				const visibleImports = node.imports.slice(0, maxVisible);
				const overflowCount = totalImports - visibleImports.length;

				for (const imp of visibleImports) {
					const badge = append(badgesContainer, $(`.node-import-badge.${imp.type || 'custom'}`));
					const typeLabel = imp.type ? (imp.type.charAt(0).toUpperCase() + imp.type.slice(1)) : 'Module';
					badge.title = `${typeLabel}: ${imp.name}`;

					// Dynamic Icon & Color mapping to match workspacesExplorerPane.ts exactly
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
						codicon = Codicon.package;
						color = getColorForName(imp.type || 'custom');
					}

					// Hex to RGBA background color
					const r = parseInt(color.slice(1, 3), 16) || 13;
					const g = parseInt(color.slice(3, 5), 16) || 148;
					const b = parseInt(color.slice(5, 7), 16) || 136;

					badge.style.backgroundColor = `rgba(${r}, ${g}, ${b}, 0.16)`;
					badge.style.color = color;

					append(badge, $('span' + ThemeIcon.asCSSSelector(codicon)));
					append(badge, $('span.badge-text', {}, imp.name));
				}

				if (overflowCount > 0) {
					const moreBadge = append(badgesContainer, $('.node-import-badge.more-badge'));
					const remainingList = node.imports.slice(maxVisible).map(i => `• [${i.type || 'module'}] ${i.name}`).join('\n');
					moreBadge.title = `More attached tickets/modules (+${overflowCount}):\n${remainingList}`;
					moreBadge.style.backgroundColor = 'rgba(255, 255, 255, 0.12)';
					moreBadge.style.color = 'var(--vscode-descriptionForeground, #aaaaaa)';
					append(moreBadge, $('span.badge-text', {}, `+${overflowCount}`));
				}
			}

			// Handle dragging & double-click inline editing
			nodeEl.onmousedown = (e) => {
				// Don't drag if clicking port or resize handle
				if ((e.target as HTMLElement).closest('.node-port-handle') || (e.target as HTMLElement).closest('.node-resize-handle')) {
					return;
				}
				e.stopPropagation();

				// Detect double click manually (immune to DOM nodes recreation)
				const now = Date.now();
				const lastClickTime = (node as any)._lastClickTime || 0;
				(node as any)._lastClickTime = now;
				if (now - lastClickTime < 300) {
					e.preventDefault();
					this._showInlineEditor(nodeEl, node);
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

			// Handle double click inline editing
			nodeEl.ondblclick = (e) => {
				e.stopPropagation();
				this._showInlineEditor(nodeEl, node);
			};
		}

		if (this._inspectorEl) {
			this._renderInspector(this._inspectorEl);
		}
	}

	private _showInlineEditor(nodeEl: HTMLElement, node: IFlowchartNode): void {
		if (nodeEl.querySelector('.node-inline-editor')) {
			return;
		}

		const contentWrapper = nodeEl.querySelector('.node-content-wrapper') as HTMLElement;
		if (contentWrapper) {
			contentWrapper.style.visibility = 'hidden';
		}

		const textarea = append(nodeEl, $('textarea.node-inline-editor')) as HTMLTextAreaElement;
		textarea.value = node.label || '';

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
		if (node.isUnderline) editDecorations.push('underline');
		if (node.isStrikethrough) editDecorations.push('line-through');
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

		setTimeout(() => {
			textarea.focus();
			textarea.select();
		}, 50);

		const saveText = () => {
			const newText = textarea.value;
			if (newText !== node.label) {
				node.label = newText;
				this._saveFlowchartData();
			}
			this._renderNodes();
			this._drawLinks();
		};

		textarea.onkeydown = (e) => {
			if (e.key === 'Enter') {
				if (e.shiftKey) {
					// Shift+Enter creates a new line in textarea natively
					e.stopPropagation();
				} else {
					// Plain Enter saves and closes, then creates a sibling node
					e.preventDefault();
					e.stopPropagation();
					saveText();
					this._createSiblingNode(node);
				}
			} else if (e.key === 'Tab') {
				// Tab saves and creates a child node
				e.preventDefault();
				e.stopPropagation();
				saveText();
				this._createChildNode(node);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				this._renderNodes();
				this._drawLinks();
			}
		};

		textarea.onblur = () => {
			saveText();
		};
	}

	private _activeVariableDraftInputEl: HTMLElement | null = null;

	private _openNodeVariableInlineEditor(node: IFlowchartNode, targetVar?: INodeVariable, targetPillElement?: HTMLElement): void {
		if (this._activeVariableDraftInputEl) {
			this._activeVariableDraftInputEl.remove();
			this._activeVariableDraftInputEl = null;
		}

		const nodeEl = (this._nodesContainer || this._canvas)?.querySelector(`[data-node-id="${node.id}"]`) as HTMLElement;
		if (!nodeEl) {
			console.warn('[WorkflowEditor] Node element not found for id:', node.id);
			return;
		}
		nodeEl.classList.add('editing-variable');

		let varsContainer = nodeEl.querySelector('.node-variables-container') as HTMLElement;
		if (!varsContainer) {
			const contentWrapper = nodeEl.querySelector('.node-content-wrapper') as HTMLElement || nodeEl;
			varsContainer = append(contentWrapper, $('.node-variables-container'));
			varsContainer.style.display = 'flex';
			varsContainer.style.flexWrap = 'wrap';
			varsContainer.style.gap = '4px';
			varsContainer.style.marginTop = '4px';
			varsContainer.style.justifyContent = 'center';
		}

		let targetPillEl: HTMLElement | null = targetPillElement || null;
		if (targetVar && !targetPillEl) {
			const allPills = varsContainer.querySelectorAll('.node-variable-pill');
			for (const p of Array.from(allPills)) {
				const text = p.querySelector('.var-pill-text')?.textContent || '';
				if (text.startsWith(`${targetVar.name} `) || text === targetVar.name || text.startsWith(`${targetVar.name}=`)) {
					targetPillEl = p as HTMLElement;
					break;
				}
			}
		}
		if (targetPillEl) {
			targetPillEl.style.display = 'none';
		}

		const draftWrapper = document.createElement('div');
		draftWrapper.className = 'node-variable-draft-wrapper';
		this._activeVariableDraftInputEl = draftWrapper;

		const vBadge = append(draftWrapper, $('.var-tag-icon'));
		vBadge.textContent = '[V]';

		const input = append(draftWrapper, $('input.node-variable-draft-input')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = 'e.g. monitor = 0, @monitor++, res = @ticket';

		const cancelBtn = append(draftWrapper, $('.var-draft-cancel-btn'));
		cancelBtn.title = 'Cancel (Esc)';
		cancelBtn.textContent = '✕';
		cancelBtn.style.cursor = 'pointer';
		cancelBtn.style.padding = '0 3px';
		cancelBtn.style.color = '#94a3b8';
		cancelBtn.style.fontSize = '10px';
		cancelBtn.onmousedown = (e) => {
			e.stopPropagation();
			e.preventDefault();
		};
		cancelBtn.onclick = (e) => {
			e.stopPropagation();
			nodeEl.classList.remove('editing-variable');
			if (popover) {
				popover.remove();
				popover = null;
			}
			if (targetPillEl) targetPillEl.style.display = '';
			draftWrapper.remove();
			this._activeVariableDraftInputEl = null;
		};

		if (targetVar) {
			if (targetVar.expression) {
				const expr = targetVar.expression.trim();
				const cleanExpr = expr.replace(/@([a-zA-Z0-9_]+)/g, '$1');
				input.value = cleanExpr.startsWith(targetVar.name) ? cleanExpr : `${targetVar.name} ${cleanExpr.startsWith('=') || cleanExpr.startsWith('+') || cleanExpr.startsWith('-') ? cleanExpr : `= ${cleanExpr}`}`;
			} else {
				input.value = `${targetVar.name} = ${targetVar.initialValue || 'None'}`;
			}
		}

		const collectSuggestions = () => {
			const suggestions: { name: string; type: 'var' | 'ticket' | 'subwf'; detail: string }[] = [];
			const seen = new Set<string>();

			for (const n of this._data?.nodes || []) {
				for (const v of this._getNodeVariables(n)) {
					if (!seen.has(v.name)) {
						seen.add(v.name);
						suggestions.push({
							name: v.name,
							type: 'var',
							detail: `Variable (init: ${v.initialValue || 'None'}) [${n.label}]`
						});
					}
				}
			}

			for (const imp of node.imports || []) {
				const ticketName = imp.name.replace(/[^a-zA-Z0-9_]/g, '_');
				if (!seen.has(ticketName)) {
					seen.add(ticketName);
					suggestions.push({
						name: ticketName,
						type: imp.type === 'workflow' ? 'subwf' : 'ticket',
						detail: `${imp.type}: ${imp.name}`
					});
				}
			}

			for (const other of this._data?.nodes || []) {
				if (other.id === node.id) continue;
				for (const imp of other.imports || []) {
					const ticketName = imp.name.replace(/[^a-zA-Z0-9_]/g, '_');
					if (!seen.has(ticketName)) {
						seen.add(ticketName);
						suggestions.push({
							name: ticketName,
							type: imp.type === 'workflow' ? 'subwf' : 'ticket',
							detail: `${imp.type}: ${imp.name} [${other.label}]`
						});
					}
				}
			}

			return suggestions;
		};

		let popover: HTMLElement | null = null;
		let activeAcIdx = 0;
		let currentMatches: { name: string; type: 'var' | 'ticket' | 'subwf'; detail: string }[] = [];

		const closePopover = () => {
			if (popover) {
				popover.remove();
				popover = null;
			}
		};

		const insertAcItem = (name: string) => {
			const selStart = input.selectionStart || 0;
			const val = input.value;
			const textBefore = val.slice(0, selStart);
			const textAfter = val.slice(selStart);
			const atIdx = textBefore.lastIndexOf('@');
			if (atIdx !== -1) {
				input.value = textBefore.slice(0, atIdx) + `${name}` + (textAfter.startsWith(' ') ? textAfter : ` ${textAfter}`);
				const newCursor = atIdx + name.length + (textAfter.startsWith(' ') ? 0 : 1);
				input.selectionStart = input.selectionEnd = newCursor;
			} else {
				input.value = val + `${name} `;
			}
			closePopover();
			input.focus();
		};

		const updateAc = () => {
			const selStart = input.selectionStart || 0;
			const textBefore = input.value.slice(0, selStart);
			const match = textBefore.match(/@([a-zA-Z0-9_\u4e00-\u9fa5]*)$/);
			if (!match) {
				closePopover();
				return;
			}

			const query = match[1].toLowerCase();
			const all = collectSuggestions();
			currentMatches = all.filter(item => item.name.toLowerCase().includes(query));
			if (currentMatches.length === 0) {
				closePopover();
				return;
			}

			if (!popover) {
				popover = append(draftWrapper, $('.node-variable-ac-popover'));
			}
			const wrapperRect = draftWrapper.getBoundingClientRect();
			if (window.innerHeight - wrapperRect.bottom < 220 && wrapperRect.top > 220) {
				popover.style.top = 'auto';
				popover.style.bottom = 'calc(100% + 4px)';
			} else {
				popover.style.top = 'calc(100% + 4px)';
				popover.style.bottom = 'auto';
			}
			clearNode(popover);
			activeAcIdx = Math.max(0, Math.min(activeAcIdx, currentMatches.length - 1));

			currentMatches.forEach((item, idx) => {
				const row = append(popover!, $(`.node-variable-ac-item${idx === activeAcIdx ? '.active' : ''}`));
				const badge = append(row, $(`.node-variable-ac-badge.${item.type}`));
				badge.textContent = item.type === 'var' ? 'VAR' : (item.type === 'subwf' ? 'SUBWF' : 'TICKET');
				const nameEl = append(row, $('.node-variable-ac-name'));
				nameEl.textContent = `@${item.name}`;
				const detailEl = append(row, $('.node-variable-ac-detail'));
				detailEl.textContent = item.detail;

				row.onmousedown = (e) => {
					e.stopPropagation();
					e.preventDefault();
				};
				row.onclick = (e) => {
					e.stopPropagation();
					insertAcItem(item.name);
				};
			});
		};

		input.oninput = () => {
			updateAc();
		};

		let committed = false;
		const commit = () => {
			if (committed) return;
			committed = true;
			nodeEl.classList.remove('editing-variable');
			closePopover();
			const text = input.value.trim();
			if (text) {
				this._parseAndApplyVariableExpression(node, text, targetVar);
			} else {
				if (targetPillEl) targetPillEl.style.display = '';
				draftWrapper.remove();
				this._activeVariableDraftInputEl = null;
			}
		};

		input.onkeydown = (e) => {
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
				} else if (e.key === 'Enter' || e.key === 'Tab') {
					e.preventDefault();
					insertAcItem(currentMatches[activeAcIdx].name);
					return;
				} else if (e.key === 'Escape') {
					e.preventDefault();
					closePopover();
					return;
				}
			}

			if (e.key === 'Enter') {
				e.preventDefault();
				commit();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				committed = true;
				nodeEl.classList.remove('editing-variable');
				closePopover();
				if (targetPillEl) targetPillEl.style.display = '';
				draftWrapper.remove();
				this._activeVariableDraftInputEl = null;
			}
		};

		let canBlurCommit = false;
		setTimeout(() => { canBlurCommit = true; }, 400);

		input.onblur = () => {
			if (!canBlurCommit) return;
			setTimeout(() => {
				if (popover && popover.matches(':hover')) return;
				const text = input.value.trim();
				if (text) {
					commit();
				}
			}, 300);
		};

		varsContainer.appendChild(draftWrapper);
		input.focus();
		if (targetVar) {
			input.select();
		}
	}

	private _parseAndApplyVariableExpression(node: IFlowchartNode, rawText: string, targetVar?: INodeVariable): void {
		const trimmed = rawText.trim();
		if (!trimmed) return;

		const vars = this._getNodeVariables(node);

		// Case A: Multiple return / Tuple unpacking: "var1, var2 = @script" or "a, b = expr"
		const unpackMatch = trimmed.match(/^([a-zA-Z0-9_,\s@\u4e00-\u9fa5]+)\s*=\s*(.+)$/);
		if (unpackMatch && unpackMatch[1].includes(',')) {
			const leftNames = unpackMatch[1].split(',').map(s => s.trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_')).filter(Boolean);
			const rightExpr = unpackMatch[2].trim();

			if (targetVar) {
				const idx = vars.indexOf(targetVar);
				if (idx !== -1) vars.splice(idx, 1);
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

			const incMatch = trimmed.match(/^@?([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*(\+\+|--)$/);
			const opMatch = trimmed.match(/^@?([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*(\+=|-=|\*=|\/=|%=)\s*(.+)$/);
			const assignMatch = trimmed.match(/^@?([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*=\s*(.+)$/);

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

				const allKnownVars = new Set<string>();
				for (const n of this._data?.nodes || []) {
					for (const kv of this._getNodeVariables(n)) {
						allKnownVars.add(kv.name);
					}
				}
				for (const kv of vars) {
					allKnownVars.add(kv.name);
				}

				const isExpression = rhs.startsWith('@') ||
					rhs.startsWith('ticket') ||
					rhs.includes('+') || rhs.includes('-') || rhs.includes('*') || rhs.includes('/') || rhs.includes('%') ||
					allKnownVars.has(cleanRhs) ||
					Array.from(allKnownVars).some(v => cleanRhs.includes(v));

				if (isExpression) {
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
				varName = trimmed.replace(/^@/, '').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_') || this._generateNextVarName();
				initialValue = 'None';
			}

			if (targetVar) {
				targetVar.name = varName;
				targetVar.expression = expression;
				if (initialValue !== 'None') targetVar.initialValue = initialValue;
			} else {
				// Dragged or added a new variable box into the node:
				// ALWAYS ADD A NEW BOX! DO NOT OVERWRITE AN EXISTING BOX ON THE SAME NODE!
				vars.push({
					name: varName,
					initialValue: initialValue || 'None',
					expression
				});
			}
		}

		node.outputVariable = vars[0];
		this._saveFlowchartData();
		this._renderNodes();
		this._drawLinks();
		if (this._inspectorEl) this._renderInspector(this._inspectorEl);
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
				const newNodeEl = this._nodesContainer.querySelector(`.workflow-node[data-node-id="${newId}"]`) as HTMLElement;
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
		const verticalGap = 20;
		const horizontalGap = 20;

		// Find parent link if current has a parent
		const parentLink = this._data.links.find(l => l.to === current.id);
		const parentNode = parentLink ? this._data.nodes.find(n => n.id === parentLink.from) : undefined;

		let siblingX = current.x;
		let siblingY = current.y;

		if (dir === 'right' || dir === 'left') {
			// Sibling stacks vertically
			siblingX = current.x;
			siblingY = current.y + (current.height || 50) + verticalGap;
			if (parentNode) {
				const siblingLinks = this._data.links.filter(l => l.from === parentNode.id);
				const allSiblings = siblingLinks
					.map(l => this._data.nodes.find(n => n.id === l.to))
					.filter(Boolean) as IFlowchartNode[];
				if (allSiblings.length > 0) {
					const maxBottom = Math.max(...allSiblings.map(s => s.y + (s.height || 50)), current.y + (current.height || 50));
					siblingY = maxBottom + verticalGap;
				}
			}
		} else {
			// For vertical branching (down/up), sibling stacks horizontally
			siblingY = current.y;
			siblingX = current.x + (current.width || 120) + horizontalGap;
			if (parentNode) {
				const siblingLinks = this._data.links.filter(l => l.from === parentNode.id);
				const allSiblings = siblingLinks
					.map(l => this._data.nodes.find(n => n.id === l.to))
					.filter(Boolean) as IFlowchartNode[];
				if (allSiblings.length > 0) {
					const maxRight = Math.max(...allSiblings.map(s => s.x + (s.width || 120)), current.x + (current.width || 120));
					siblingX = maxRight + horizontalGap;
				}
			}
		}

		// Smart collision avoidance against all existing canvas nodes
		const safePos = this._findNonOverlappingPosition(siblingX, siblingY, current.width || 120, current.height || 50, dir, current.id);
		siblingX = safePos.x;
		siblingY = safePos.y;

		const newId = `node_${Date.now()}`;
		const newSibling: IFlowchartNode = {
			id: newId,
			type: current.type || 'round-rect',
			x: siblingX,
			y: siblingY,
			width: current.width || 120,
			height: current.height || 50,
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

		if (parentNode && parentLink) {
			const newLink: IFlowchartLink = {
				id: `link_${Date.now()}`,
				from: parentNode.id,
				fromPort: parentLink.fromPort || (dir === 'bottom' ? 'bottom' : (dir === 'top' ? 'top' : (dir === 'left' ? 'left' : 'right'))),
				to: newId,
				toPort: parentLink.toPort || (dir === 'bottom' ? 'top' : (dir === 'top' ? 'bottom' : (dir === 'left' ? 'right' : 'left'))),
				style: parentLink.style || this._activeLinkStyle || 'arrow-single',
				routing: parentLink.routing || this._activeRoutingMode || 'orthogonal',
				color: parentNode.color || current.color || this._activeLineColor || '#0d9488'
			};
			this._data.links.push(newLink);
		}

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
				const newNodeEl = this._nodesContainer.querySelector(`.workflow-node[data-node-id="${newId}"]`) as HTMLElement;
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
			width = 80;
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
			width = 80;
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
		if (!this._svgOverlay) return;
		let tempLine = this._svgOverlay.querySelector('#workflow-temp-line') as SVGPathElement;
		if (!tempLine) {
			tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'path') as any;
			tempLine.setAttribute('id', 'workflow-temp-line');
			tempLine.classList.add('workflow-connection-line');
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

	private _clearTempLink(): void {
		if (!this._svgOverlay) return;
		const tempLine = this._svgOverlay.querySelector('#workflow-temp-line');
		if (tempLine) {
			tempLine.remove();
		}
	}

	private _onMouseMove(e: MouseEvent): void {
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
					const pt = this._computePointFromCoords(startCoords.x, startCoords.y, fromPort, endCoords.x, endCoords.y, toPort, routingMode, t);

					const labelEl = this._linkDeletesContainer?.querySelector(`.workflow-link-label[data-link-id="${link.id}"]`) as HTMLElement;
					if (labelEl) {
						labelEl.style.left = `${pt.x}px`;
						labelEl.style.top = `${pt.y}px`;
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

			// Check for target node snapping
			let snapNode: IFlowchartNode | undefined;
			for (const node of this._data.nodes) {
				if (node.id === this._tempLinkFromNodeId) continue;
				// Detect if cursor is near or inside target node bounding box
				if (currentX >= node.x - 24 && currentX <= node.x + node.width + 24 &&
					currentY >= node.y - 24 && currentY <= node.y + node.height + 24) {
					snapNode = node;
					break;
				}
			}

			if (snapNode) {
				// Find which port on snapNode is CLOSEST to current mouse cursor (currentX, currentY)
				const ports: ('top' | 'right' | 'bottom' | 'left')[] = ['left', 'right', 'top', 'bottom'];
				let snapPort: 'top' | 'right' | 'bottom' | 'left' = 'left';
				let minDistance = Infinity;

				for (const p of ports) {
					const coords = this._getPortCoords(snapNode, p);
					const dist = Math.hypot(currentX - coords.x, currentY - coords.y);
					if (dist < minDistance) {
						minDistance = dist;
						snapPort = p;
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
			this._drawTempLink(currentX, currentY, this._tempLinkFixedX, this._tempLinkFixedY, 'right', 'left');
			return;
		}

		if (this._isReconnectingEnd && this._tempLinkFixedX !== null && this._tempLinkFixedY !== null) {
			const rect = this._canvas!.getBoundingClientRect();
			const currentX = (e.clientX - rect.left) / this._zoomLevel;
			const currentY = (e.clientY - rect.top) / this._zoomLevel;
			this._drawTempLink(this._tempLinkFixedX, this._tempLinkFixedY, currentX, currentY, 'right', 'left');
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

				// Dynamically update position in DOM
				const nodes = this._nodesContainer?.children;
				if (nodes) {
					const nodeIdx = this._data.nodes.indexOf(node);
					const nodeEl = nodes[nodeIdx] as HTMLElement;
					if (nodeEl) {
						nodeEl.style.width = `${node.width}px`;
						nodeEl.style.height = `${node.height}px`;
					}
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

			// Calculate overlapping nodes
			this._selectedNodeIds.clear();
			for (const node of this._data.nodes) {
				const overlap = !(node.x + node.width < x_start ||
					node.x > x_start + width ||
					node.y + node.height < y_start ||
					node.y > y_start + height);
				if (overlap) {
					this._selectedNodeIds.add(node.id);
				}
			}

			// Calculate overlapping links (midpoint overlaps)
			this._selectedLinkIds.clear();
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

					// Dynamically update position in DOM
					const nodes = this._nodesContainer?.children;
					if (nodes) {
						const nodeIdx = this._data.nodes.indexOf(node);
						const nodeEl = nodes[nodeIdx] as HTMLElement;
						if (nodeEl) {
							nodeEl.style.left = `${node.x}px`;
							nodeEl.style.top = `${node.y}px`;
						}
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
		if (this._isDraggingLinkLabel) {
			const linkId = this._isDraggingLinkLabel;
			const hasMoved = this._dragLabelHasMoved;
			this._isDraggingLinkLabel = null;
			this._dragLabelHasMoved = false;

			const labelEl = this._linkDeletesContainer?.querySelector(`.workflow-link-label[data-link-id="${linkId}"]`) as HTMLElement;
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
					const nodes = this._nodesContainer?.children;
					if (nodes) {
						const nodeIdx = Array.from(nodes).indexOf(targetNodeEl as any);
						targetNode = this._data.nodes[nodeIdx];
					}
				}

				// If not dropped directly on DOM node, check coordinate-based proximity snapping (within 24px)
				if (!targetNode && this._canvas) {
					const rect = this._canvas.getBoundingClientRect();
					const upX = (e.clientX - rect.left) / this._zoomLevel;
					const upY = (e.clientY - rect.top) / this._zoomLevel;
					for (const n of this._data.nodes) {
						if (n.id === this._tempLinkFromNodeId) continue;
						if (upX >= n.x - 24 && upX <= n.x + n.width + 24 &&
							upY >= n.y - 24 && upY <= n.y + n.height + 24) {
							targetNode = n;
							break;
						}
					}
				}

				if (targetNode && targetNode.id !== this._tempLinkFromNodeId) {
					if (targetPortEl) {
						const classes = Array.from(targetPortEl.classList);
						toPort = classes.find(c => ['top', 'right', 'bottom', 'left'].includes(c)) as any;
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
					const nodes = this._nodesContainer?.children;
					if (nodes) {
						const nodeIdx = Array.from(nodes).indexOf(targetNodeEl as any);
						targetNode = this._data.nodes[nodeIdx];
					}
				}

				if (!targetNode && this._canvas) {
					const rect = this._canvas.getBoundingClientRect();
					const upX = (e.clientX - rect.left) / this._zoomLevel;
					const upY = (e.clientY - rect.top) / this._zoomLevel;
					for (const n of this._data.nodes) {
						if (upX >= n.x - 24 && upX <= n.x + n.width + 24 &&
							upY >= n.y - 24 && upY <= n.y + n.height + 24) {
							targetNode = n;
							break;
						}
					}
				}

				if (targetNode) {
					if (targetPortEl) {
						const classes = Array.from(targetPortEl.classList);
						port = classes.find(c => ['top', 'right', 'bottom', 'left'].includes(c)) as any;
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
			}
			this._collapseSelectionTargetNodeId = null;
			this._isDragging = false;
			this._dragNodeId = null;
			this._saveFlowchartData();
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
		toPort: 'top' | 'right' | 'bottom' | 'left'
	): { x: number; y: number }[] {
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

		if (clean.length === 0) return 'M 0 0';
		if (clean.length === 1) return `M ${clean[0].x} ${clean[0].y}`;
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
		mode: 'orthogonal' | 'curved'
	): string {
		if (mode === 'orthogonal') {
			const waypoints = this._computeOrthogonalWaypoints(x1, y1, fromPort, x2, y2, toPort);
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
		if (!fromNode || !toNode) return { x: 0, y: 0 };

		const closest = this._getClosestPorts(fromNode, toNode);
		const fromPort = link.fromPort || closest.fromPort;
		const toPort = link.toPort || closest.toPort;

		const startCoords = this._getPortCoords(fromNode, fromPort);
		const endCoords = this._getPortCoords(toNode, toPort);

		const routingMode = link.routing || this._activeRoutingMode || 'orthogonal';
		const t = typeof link.labelPosition === 'number' ? link.labelPosition : 0.5;
		return this._computePointFromCoords(startCoords.x, startCoords.y, fromPort, endCoords.x, endCoords.y, toPort, routingMode, t);
	}

	private _computePointFromCoords(
		x1: number, y1: number, fromPort: 'top' | 'right' | 'bottom' | 'left',
		x2: number, y2: number, toPort: 'top' | 'right' | 'bottom' | 'left',
		routingMode: 'orthogonal' | 'curved',
		t: number = 0.5
	): { x: number; y: number } {
		t = Math.max(0, Math.min(1, t));
		if (routingMode === 'orthogonal') {
			const waypoints = this._computeOrthogonalWaypoints(x1, y1, fromPort, x2, y2, toPort);
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
		routingMode: 'orthogonal' | 'curved'
	): { x: number; y: number } {
		return this._computePointFromCoords(x1, y1, fromPort, x2, y2, toPort, routingMode, 0.5);
	}

	private _getOrthogonalPointAtT(waypoints: { x: number; y: number }[], t: number): { x: number; y: number } {
		if (waypoints.length === 0) return { x: 0, y: 0 };
		if (waypoints.length === 1) return waypoints[0];

		let totalLen = 0;
		const segLens: number[] = [];
		for (let i = 0; i < waypoints.length - 1; i++) {
			const len = Math.hypot(waypoints[i + 1].x - waypoints[i].x, waypoints[i + 1].y - waypoints[i].y);
			segLens.push(len);
			totalLen += len;
		}

		if (totalLen === 0) return waypoints[0];

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
		if (!fromNode || !toNode) return 0.5;

		const closest = this._getClosestPorts(fromNode, toNode);
		const fromPort = link.fromPort || closest.fromPort;
		const toPort = link.toPort || closest.toPort;

		const startCoords = this._getPortCoords(fromNode, fromPort);
		const endCoords = this._getPortCoords(toNode, toPort);
		const routingMode = link.routing || this._activeRoutingMode || 'orthogonal';

		if (routingMode === 'orthogonal') {
			const waypoints = this._computeOrthogonalWaypoints(startCoords.x, startCoords.y, fromPort, endCoords.x, endCoords.y, toPort);
			if (waypoints.length < 2) return 0.5;

			let totalLen = 0;
			const segLens: number[] = [];
			for (let i = 0; i < waypoints.length - 1; i++) {
				const len = Math.hypot(waypoints[i + 1].x - waypoints[i].x, waypoints[i + 1].y - waypoints[i].y);
				segLens.push(len);
				totalLen += len;
			}
			if (totalLen <= 0) return 0.5;

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
				const pt = this._computePointFromCoords(startCoords.x, startCoords.y, fromPort, endCoords.x, endCoords.y, toPort, routingMode, t);
				const distSq = (px - pt.x) * (px - pt.x) + (py - pt.y) * (py - pt.y);
				if (distSq < bestDistSq) {
					bestDistSq = distSq;
					bestT = t;
				}
			}
			return Math.max(0.05, Math.min(0.95, Number(bestT.toFixed(3))));
		}
	}

	private _showLinkInlineEditor(link: IFlowchartLink, x: number, y: number): void {
		if (!this._linkDeletesContainer) return;
		// Remove any existing editor
		const existing = this._linkDeletesContainer.querySelector('.workflow-link-label-editor-wrapper, .workflow-link-label-editor');
		if (existing) existing.remove();

		const wrapper = append(this._linkDeletesContainer, $('.workflow-link-label-editor-wrapper'));
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
			if (committed) return;
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

	private _renderLinkLabelContent(parent: HTMLElement, rawLabel: string): void {
		clearNode(parent);
		if (!rawLabel) return;

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
			if (!tok) continue;
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
		if (!this._svgOverlay || !this._linkDeletesContainer) return;

		// Clear previous lines and handles
		const lines = this._svgOverlay.querySelectorAll('.workflow-connection-line');
		lines.forEach(l => l.remove());
		clearNode(this._linkDeletesContainer);

		if (!this._data || !Array.isArray(this._data.links) || !Array.isArray(this._data.nodes)) {
			return;
		}

		for (const link of this._data.links) {
			const fromNode = this._data.nodes.find(n => n.id === link.from);
			const toNode = this._data.nodes.find(n => n.id === link.to);

			if (!fromNode || !toNode) continue;

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
				if (fromPort === 'right') x1 += 8;
				else if (fromPort === 'left') x1 -= 8;
				else if (fromPort === 'bottom') y1 += 8;
				else if (fromPort === 'top') y1 -= 8;
			}
			if (hasEndArrow) {
				if (toPort === 'left') x2 -= 8;
				else if (toPort === 'right') x2 += 8;
				else if (toPort === 'top') y2 -= 8;
				else if (toPort === 'bottom') y2 += 8;
			}

			// Draw connection line
			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.classList.add('workflow-connection-line');

			// Custom Link Color or Default (match fromNode color / theme)
			const linkHex = (link.color || '#0d9488').toLowerCase();
			path.style.stroke = linkHex;

			// Highlight line if selected
			const isSelected = this._selectedLinkIds.has(link.id);
			if (isSelected) {
				path.classList.add('selected');
				path.style.stroke = '#22d3ee';
				path.style.strokeWidth = '3px';
			}

			// Use link-specific routing or fallback to active flowchart routing mode
			const routingMode = link.routing || this._activeRoutingMode || 'orthogonal';
			const d = this._getLinkPathData(x1, y1, fromPort, x2, y2, toPort, routingMode);
			path.setAttribute('d', d);

			// Link Styles markers (Arrow marker endpoint)
			const validMarkerColors = new Set(['ffffff', '0d9488', '38bdf8', '7c3aed', 'facc15', 'f43f5e']);
			const hexClean = linkHex.replace('#', '');
			const markerColorId = isSelected ? 'arrow-selected' : (validMarkerColors.has(hexClean) ? `arrow-${hexClean}` : 'arrow');

			if (link.style === 'dashed') {
				path.style.strokeDasharray = '6, 4';
				path.setAttribute('marker-end', `url(#${markerColorId})`);
			} else if (link.style === 'arrow-single') {
				path.setAttribute('marker-end', `url(#${markerColorId})`);
			} else if (link.style === 'arrow-double') {
				path.setAttribute('marker-start', `url(#${markerColorId})`);
				path.setAttribute('marker-end', `url(#${markerColorId})`);
			}

			this._svgOverlay.appendChild(path);

			// Calculate midpoint for labels and double click editor
			const midPoint = this._computeMidpointFromCoords(startCoords.x, startCoords.y, fromPort, endCoords.x, endCoords.y, toPort, routingMode);

			// Double click connection line to edit/add text label
			path.ondblclick = (e) => {
				e.stopPropagation();
				e.preventDefault();
				this._showLinkInlineEditor(link, midPoint.x, midPoint.y);
			};

			// Right Click connection context menu
			path.oncontextmenu = (e) => {
				e.preventDefault();
				e.stopPropagation();
				this._showContextMenu(e.clientX, e.clientY, 'link', link.id);
			};

			// Connection line selection (click)
			path.onclick = (e) => {
				e.stopPropagation();
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

			// Render text label badge if present
			if (link.label) {
				const labelPos = typeof link.labelPosition === 'number' ? link.labelPosition : 0.5;
				const labelPt = this._computePointFromCoords(startCoords.x, startCoords.y, fromPort, endCoords.x, endCoords.y, toPort, routingMode, labelPos);

				const dx = endCoords.x - startCoords.x;
				const dy = endCoords.y - startCoords.y;
				const linkDist = Math.hypot(dx, dy);
				// Max width bound: bounded between 90px and 160px, up to ~65% of node-to-node distance
				const maxLabelWidth = Math.max(90, Math.min(160, Math.round(linkDist * 0.65)));

				const labelEl = append(this._linkDeletesContainer, $('.workflow-link-label'));
				this._renderLinkLabelContent(labelEl, link.label);
				labelEl.setAttribute('data-link-id', link.id);
				labelEl.style.left = `${labelPt.x}px`;
				labelEl.style.top = `${labelPt.y}px`;
				labelEl.style.maxWidth = `${maxLabelWidth}px`;
				labelEl.title = `${link.label}\n\n• Drag along line to reposition\n• Double-click to edit (Type @ to autocomplete variables)`;
				if (isSelected) {
					labelEl.classList.add('selected');
				}

				labelEl.onmousedown = (e) => {
					e.stopPropagation();
					if (e.button !== 0) return;
					this._isDraggingLinkLabel = link.id;
					this._dragLabelHasMoved = false;
					this._dragLabelStartX = e.clientX;
					this._dragLabelStartY = e.clientY;
					labelEl.classList.add('dragging');
				};

				labelEl.onclick = (e) => {
					e.stopPropagation();
					if (this._dragLabelHasMoved) return;

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
					const currentPt = this._computePointFromCoords(startCoords.x, startCoords.y, fromPort, endCoords.x, endCoords.y, toPort, routingMode, typeof link.labelPosition === 'number' ? link.labelPosition : 0.5);
					this._showLinkInlineEditor(link, currentPt.x, currentPt.y);
				};

				labelEl.oncontextmenu = (e) => {
					e.preventDefault();
					e.stopPropagation();
					this._showContextMenu(e.clientX, e.clientY, 'link', link.id);
				};
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
			path.onmouseenter = () => {
				handleStart.classList.add('hovered');
				handleEnd.classList.add('hovered');
			};
			path.onmouseleave = () => {
				handleStart.classList.remove('hovered');
				handleEnd.classList.remove('hovered');
			};

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

		const menu = append(document.body, $('.workflow-context-menu'));
		this._contextMenuEl = menu;
		menu.style.position = 'fixed';
		menu.style.left = `${x}px`;
		menu.style.top = `${y}px`;
		menu.style.zIndex = '20000';

		const totalSelected = this._selectedNodeIds.size + this._selectedLinkIds.size;
		const isMulti = totalSelected > 1;

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
				this._pasteNodes();
			};
		}

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
					this._viewsService.openView<any>('workbench.workspacesExplorer.mainPane', true).then(workspacesView => {
						if (workspacesView && typeof workspacesView.showCreateResourceModal === 'function') {
							workspacesView.showCreateResourceModal(this._workflowUri, (this.input as any)?.name || '', (type: string, name: string) => {
								const node = this._data.nodes.find(n => n.id === targetId);
								if (node) {
									if (!node.imports) {
										node.imports = [];
									}
									if (!node.imports.some(imp => imp.type === type && imp.name === name)) {
										node.imports.push({ type: type as any, name });
										this._saveFlowchartData();
										this._renderNodes();
										this._drawLinks();
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
			changeColorItem.textContent = 'Node Color ›';
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
			textStyleItem.textContent = 'Text Formatting ›';
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
			textColorTrigger.textContent = 'Text Color ›';
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
			changeShapeItem.textContent = 'Change Shape ›';
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
			exportSelItem.textContent = isMulti ? `Export Selected (${totalSelected}) ›` : 'Export Node Image ›';
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
				openModulesItem.textContent = `Open Module (${nodeObj.imports.length}) ›`;
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
						codicon = Codicon.package;
						color = getColorForName(imp.type);
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
			addNodeItem.textContent = 'Add Node ›';
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
					this._viewsService.openView<any>('workbench.workspacesExplorer.mainPane', true).then(workspacesView => {
						if (workspacesView && typeof workspacesView.showCreateResourceModal === 'function') {
							workspacesView.showCreateResourceModal(this._workflowUri, (this.input as any)?.name || '', (type: string, name: string) => {
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
									imports: [{ type: type as any, name }],
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
			}

			// Export Canvas Submenu
			const exportCanvasItem = append(menu, $('.context-menu-item.submenu-trigger'));
			exportCanvasItem.textContent = 'Export Canvas ›';
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

			// Line Color Submenu
			const lineColorItem = append(menu, $('.context-menu-item.submenu-trigger'));
			lineColorItem.textContent = 'Line Color ›';
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
			arrowStyleItem.textContent = 'Arrow Style ›';
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
				{ style: 'dashed', label: 'Dashed Line (╌)' }
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
			routingSubmenuTrigger.textContent = 'Routing Mode ›';
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
		const clickListener = addDisposableListener(window, 'click', () => {
			this._closeContextMenu();
			clickListener.dispose();
		}, true);
	}

	private _closeContextMenu(): void {
		if (this._contextMenuEl) {
			this._contextMenuEl.remove();
			this._contextMenuEl = undefined;
		}
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
		if (this._selectedNodeIds.size === 0) return;
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

	private _pasteNodes(): void {
		if (this._copiedNodes.length === 0) return;

		// Record undo snapshot before paste
		const beforeState = JSON.stringify(this._data);
		this._undoStack.push(beforeState);
		if (this._undoStack.length > 60) {
			this._undoStack.shift();
		}
		this._redoStack = [];

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

			const pastedNode: IFlowchartNode = {
				...copiedNode,
				id: newId,
				groupId: copiedNode.groupId ? oldToNewGroupMap.get(copiedNode.groupId) : undefined,
				x: copiedNode.x + 35,
				y: copiedNode.y + 35
			};

			this._data.nodes.push(pastedNode);
			newPastedIds.add(newId);
		}

		// Recreate internal connecting links between pasted nodes
		for (const copiedLink of this._copiedLinks) {
			const newFrom = oldToNewNodeIdMap.get(copiedLink.from);
			const newTo = oldToNewNodeIdMap.get(copiedLink.to);
			if (newFrom && newTo) {
				const newLinkId = `link_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
				const pastedLink: IFlowchartLink = {
					...copiedLink,
					id: newLinkId,
					from: newFrom,
					to: newTo
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
		if (!node) return;

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
		if (!cleanName) return undefined;
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

		// 3. Build candidate workflow base directories (including ~ strip, hyphen/space variants)
		const candidateWorkflowBases: URI[] = [];
		if (this._workflowUri) {
			candidateWorkflowBases.push(this._workflowUri);

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

		// Also discover all folders in /Users/aimery/Documents/workflows
		const rootWorkflowsDir = URI.file('/Users/aimery/Documents/workflows');
		try {
			if (await this._fileService.exists(rootWorkflowsDir)) {
				const res = await this._fileService.resolve(rootWorkflowsDir);
				if (res.children) {
					for (const child of res.children) {
						if (child.isDirectory) {
							candidateWorkflowBases.push(child.resource);
						}
					}
				}
			}
		} catch { }

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

		// 5. Common global directories
		const commonDirs = [
			URI.file(`/Users/aimery/Documents/workflows/${cleanName}`),
			URI.file(`/Users/aimery/Documents/workflows/${cleanName}.md`),
			URI.file(`/Users/aimery/repos/${cleanName}`),
			URI.file(`/Users/aimery/repos/jobs/${cleanName}`),
			URI.file(`/Users/aimery/repos/jobs/any_agent_202607/${cleanName}`)
		];
		for (const cand of commonDirs) {
			try {
				if (await this._fileService.exists(cand)) {
					return cand;
				}
			} catch { }
		}

		return undefined;
	}

	private async _openModuleInEditor(imp: { type: string; name: string; uri?: string }): Promise<void> {
		const targetUri = await this._resolveModuleUri(imp);
		if (!targetUri) {
			this._notificationService.warn(`Could not locate resource directory or file for ${imp.type} '${imp.name}'.`);
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
		const existing = document.querySelector('.workflow-export-floating-menu');
		if (existing) {
			existing.remove();
			return;
		}

		const rect = anchorEl.getBoundingClientRect();
		const menuEl = append(document.body, $('.workflow-export-floating-menu'));
		menuEl.style.position = 'fixed';
		menuEl.style.top = `${rect.bottom + 6}px`;
		menuEl.style.left = `${Math.max(10, rect.left - 70)}px`;
		menuEl.style.zIndex = '99999';

		const isSel = this._selectedNodeIds.size > 0;
		const selCount = this._selectedNodeIds.size;

		// Section 1: Full Canvas
		const header1 = append(menuEl, $('.export-menu-header'));
		header1.textContent = 'EXPORT CANVAS';

		const items: { label: string; icon: any; format: 'png' | 'jpeg' | 'svg' | 'pdf' }[] = [
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
				window.removeEventListener('click', closeListener);
			}
		};
		setTimeout(() => window.addEventListener('click', closeListener), 10);
	}

	private _createPdfFromJpeg(jpegBytes: Uint8Array, imgWidth: number, imgHeight: number): Uint8Array {
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

	private _generateSvgString(
		nodesToExport: IFlowchartNode[],
		linksToExport: IFlowchartLink[],
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

			const closest = this._getClosestPorts(fromNode, toNode);
			const fromPort = link.fromPort || closest.fromPort;
			const toPort = link.toPort || closest.toPort;

			const startCoords = this._getPortCoords(fromNode, fromPort);
			const endCoords = this._getPortCoords(toNode, toPort);

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

			const routingMode = link.routing || this._activeRoutingMode || 'orthogonal';
			const d = this._getLinkPathData(x1, y1, fromPort, x2, y2, toPort, routingMode);

			const linkColor = link.color || '#0d9488';
			const cleanColor = linkColor.replace('#', '');
			const dashAttr = link.style === 'dashed' ? 'stroke-dasharray="6,4"' : '';
			const markerEnd = hasEndArrow ? `marker-end="url(#export-arrow-${cleanColor})"` : '';
			const markerStart = hasStartArrow ? `marker-start="url(#export-arrow-start-${cleanColor})"` : '';

			body += `  <path d="${d}" fill="none" stroke="${linkColor}" stroke-width="2" ${dashAttr} ${markerStart} ${markerEnd} />\n`;

			if (link.label) {
				const mid = this._getLinkMidpoint(link);
				const escapedLabel = this._escapeXml(link.label);
				const labelW = Math.max(40, link.label.length * 7 + 16);
				body += `  <rect x="${mid.x - labelW / 2}" y="${mid.y - 11}" width="${labelW}" height="22" rx="4" fill="#1e1e1e" stroke="${linkColor}" stroke-width="1"/>\n`;
				body += `  <text x="${mid.x}" y="${mid.y + 4}" fill="#ffffff" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="11" font-weight="500" text-anchor="middle">${escapedLabel}</text>\n`;
			}
		}

		// Nodes
		for (const node of nodesToExport) {
			const nodeColor = node.color || '#0d9488';
			const fillColor = hexToRgba(nodeColor, 0.18);
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
			const lines = this._wrapText(node.label || '', maxTextWidth, 11);
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
				const lineText = this._escapeXml(lines[i]);
				const dy = i === 0 ? 0 : lineHeight;
				body += `    <tspan x="${textX}" dy="${dy}">${lineText}</tspan>\n`;
			}
			body += `  </text>\n`;
		}

		return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}">\n${defs}${body}</svg>`;
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
				const blob = typeof dataBuffer === 'string' ? new Blob([dataBuffer], { type: mime }) : new Blob([dataBuffer as any], { type: mime });
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = fileName;
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);
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

		const defaultName = (this.input as any)?.name || this._workflowUri?.path.split('/').filter(Boolean).pop()?.replace(/\.diagram\.json$/, '').replace(/\.flowchart\.json$/, '') || 'diagram';
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
				for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
				await this._saveExportedFile(fileName, bytes, 'png');
			} else if (format === 'jpeg') {
				const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
				const raw = atob(dataUrl.replace(/^data:image\/jpeg;base64,/, ''));
				const bytes = new Uint8Array(raw.length);
				for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
				await this._saveExportedFile(fileName, bytes, 'jpg');
			} else if (format === 'pdf') {
				const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
				const raw = atob(dataUrl.replace(/^data:image\/jpeg;base64,/, ''));
				const jpegBytes = new Uint8Array(raw.length);
				for (let i = 0; i < raw.length; i++) jpegBytes[i] = raw.charCodeAt(i);
				const pdfBytes = this._createPdfFromJpeg(jpegBytes, canvas.width, canvas.height);
				await this._saveExportedFile(fileName, pdfBytes, 'pdf');
			}
		} catch (err) {
			this._notificationService.error(`Export failed: ${err}`);
		}
	}
}

