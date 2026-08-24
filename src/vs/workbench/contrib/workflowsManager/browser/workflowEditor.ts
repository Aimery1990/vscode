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
import { IStorageService } from '../../../../platform/storage/common/storage.js';
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
	private _inspectorEl?: HTMLElement;
	private _isInspectorCollapsed: boolean = false;
	private _inspectorTogglePill?: HTMLElement;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly _fileService: IFileService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IViewsService private readonly _viewsService: IViewsService,
		@IEntityPersistenceService private readonly _entityPersistenceService: IEntityPersistenceService,
		@IEditorService private readonly _editorService: IEditorService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService
	) {
		super(WorkflowEditor.ID, group, telemetryService, themeService, storageService);
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
		this._renderToolbar(toolbar);

		// 2. Center Drawing Viewport (Fixed container for floating controls)
		const canvasViewport = append(this._container, $('.workflow-canvas-viewport'));

		// Canvas Scroll Wrapper inside Viewport
		const canvasWrapper = append(canvasViewport, $('.workflow-editor-canvas-wrapper'));

		// Sizer container to enforce scroll boundaries when zoomed
		this._zoomSizerEl = append(canvasWrapper, $('.workflow-canvas-sizer'));
		this._zoomSizerEl.style.width = `${2400 * this._zoomLevel}px`;
		this._zoomSizerEl.style.height = `${2000 * this._zoomLevel}px`;
		this._zoomSizerEl.style.position = 'relative';

		this._canvas = append(this._zoomSizerEl, $('.workflow-editor-canvas'));
		this._canvas.style.transform = `scale(${this._zoomLevel})`;
		this._canvas.style.transformOrigin = '0 0';

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
			this._inspectorEl?.classList.remove('collapsed');
			this._inspectorTogglePill?.classList.add('hidden');
			if (this._inspectorEl) this._renderInspector(this._inspectorEl);
		};

		// 3. Right Property Inspector Panel
		const inspector = append(this._container, $('.workflow-editor-inspector'));
		if (this._isInspectorCollapsed) {
			inspector.classList.add('collapsed');
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
							imports: [{ type: type as any, name }]
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
						const { type, label } = JSON.parse(dataStr);
						const rect = this._canvas!.getBoundingClientRect();
						const rawX = (e.clientX - rect.left) / this._zoomLevel;
						const rawY = (e.clientY - rect.top) / this._zoomLevel;
						const grid = 5;
						const x = Math.round(rawX / grid) * grid;
						const y = Math.round(rawY / grid) * grid;
						this._addNewNodeAt(type, label, x, y);
					} catch { }
				}
			};
		}

		// Render Nodes and draw connections
		this._renderNodes();
		this._drawLinks();
	}

	private _renderToolbar(parent: HTMLElement): void {
		// Section A: Drag Shapes
		const shapeSec = append(parent, $('.workflow-toolbar-section'));
		append(shapeSec, $('.workflow-toolbar-title')).textContent = localize('shapes', 'Drag / Click Shapes');

		const shapesGrid = append(shapeSec, $('.workflow-shape-grid'));
		const shapeTypes: { type: IFlowchartNode['type']; label: string; previewClass: string }[] = [
			{ type: 'round-rect', label: 'Round Rect', previewClass: 'round-rect' },
			{ type: 'rect', label: 'Rectangle', previewClass: 'rect' },
			{ type: 'diamond', label: 'Decision', previewClass: 'diamond' },
			{ type: 'circle', label: 'Circle Node', previewClass: 'circle' }
		];

		for (const st of shapeTypes) {
			const item = append(shapesGrid, $('.workflow-toolbar-item'));
			item.setAttribute('draggable', 'true');
			item.ondragstart = (e: DragEvent) => {
				e.dataTransfer?.setData('text/plain', JSON.stringify({ type: st.type, label: st.label }));
				if (e.dataTransfer) {
					e.dataTransfer.effectAllowed = 'copy';
				}
			};

			append(item, $(`.item-preview.${st.previewClass}`));
			append(item, $('.item-label')).textContent = st.label;

			item.onclick = () => {
				this._addNewNode(st.type, st.label);
			};
		}

		// Section B: Link Styling
		const linkSec = append(parent, $('.workflow-toolbar-section'));
		append(linkSec, $('.workflow-toolbar-title')).textContent = localize('linkStyle', 'Connection Styles');

		const linksGrid = append(linkSec, $('.workflow-shape-grid'));
		const linkStyles: { style: IFlowchartLink['style']; label: string; previewClass: string }[] = [
			{ style: 'arrow-single', label: 'Single Arrow', previewClass: 'line-preview' },
			{ style: 'arrow-double', label: 'Double Arrow', previewClass: 'line-preview' },
			{ style: 'arrow-none', label: 'No Arrow', previewClass: 'line-preview' },
			{ style: 'dashed', label: 'Dashed Line', previewClass: 'dashed-preview' }
		];

		const linkItemBtns: HTMLElement[] = [];
		for (const ls of linkStyles) {
			const item = append(linksGrid, $(`.workflow-toolbar-item${ls.style === this._activeLinkStyle ? '.active' : ''}`));
			const line = append(item, $(`.item-preview.${ls.previewClass}`));
			if (ls.style === 'arrow-single' || ls.style === 'arrow-double') {
				line.style.borderRight = '3px solid var(--vscode-foreground, #cccccc)'; // dummy preview representation
			}
			append(item, $('.item-label')).textContent = ls.label;

			linkItemBtns.push(item);
			item.onclick = () => {
				this._activeLinkStyle = ls.style;
				linkItemBtns.forEach(btn => btn.classList.remove('active'));
				item.classList.add('active');
			};
		}

		// Section C: Line Routing Mode (Orthogonal / Curved)
		const routingSec = append(parent, $('.workflow-toolbar-section'));
		append(routingSec, $('.workflow-toolbar-title')).textContent = localize('routingMode', 'Routing Modes');

		const routingGrid = append(routingSec, $('.workflow-shape-grid'));
		const routingModes: { mode: 'orthogonal' | 'curved'; label: string; previewClass: string }[] = [
			{ mode: 'orthogonal', label: localize('orthogonal', 'Orthogonal (Right-Angle)'), previewClass: 'orthogonal-preview' },
			{ mode: 'curved', label: localize('curved', 'Curved (Smooth)'), previewClass: 'curved-preview' }
		];

		const routingItemBtns: HTMLElement[] = [];
		for (const rm of routingModes) {
			const item = append(routingGrid, $(`.workflow-toolbar-item${rm.mode === this._activeRoutingMode ? '.active' : ''}`));
			append(item, $(`.item-preview.${rm.previewClass}`));
			append(item, $('.item-label')).textContent = rm.label;

			routingItemBtns.push(item);
			item.onclick = () => {
				this._activeRoutingMode = rm.mode;
				this._data.routingMode = rm.mode;
				routingItemBtns.forEach(btn => btn.classList.remove('active'));
				item.classList.add('active');
				this._saveFlowchartData();
				this._drawLinks();
			};
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
		const title = append(headerTop, $('.workflow-inspector-title'));
		title.textContent = 'PROPERTIES & STYLING';

		const collapseBtn = append(headerTop, $('.workflow-inspector-collapse-btn'));
		append(collapseBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.chevronRight)));
		collapseBtn.title = 'Collapse Panel';
		collapseBtn.onclick = (e) => {
			e.stopPropagation();
			this._isInspectorCollapsed = true;
			this._inspectorEl?.classList.add('collapsed');
			this._inspectorTogglePill?.classList.remove('hidden');
		};

		const selNodeCount = this._selectedNodeIds.size;
		const selLinkCount = this._selectedLinkIds.size;
		const subtitle = append(headerSec, $('.workflow-inspector-subtitle'));

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
			if (selLinkCount === 1) {
				const selLinkId = Array.from(this._selectedLinkIds)[0];
				const link = this._data.links.find(l => l.id === selLinkId);
				subtitle.textContent = `Selected: ${link?.label ? `Line "${link.label}"` : 'Connection Line'}`;
			} else {
				subtitle.textContent = `${selLinkCount} Lines Selected`;
			}

			// Section 1: Line Color
			const colorSec = append(parent, $('.workflow-toolbar-section'));
			append(colorSec, $('.workflow-toolbar-title')).textContent = 'Line Color';

			const colorGrid = append(colorSec, $('.workflow-color-grid'));
			let currentLineColor = '#0d9488';
			if (selLinkCount === 1) {
				const selLinkId = Array.from(this._selectedLinkIds)[0];
				const link = this._data.links.find(l => l.id === selLinkId);
				currentLineColor = link?.color || '#0d9488';
			}

			for (const c of paletteColors) {
				const swatch = append(colorGrid, $('.workflow-color-swatch-btn'));
				swatch.style.backgroundColor = c.hex;
				swatch.title = c.name;
				if (currentLineColor.toLowerCase() === c.hex.toLowerCase()) {
					swatch.classList.add('active');
				}
				swatch.onclick = () => {
					for (const id of this._selectedLinkIds) {
						const link = this._data.links.find(l => l.id === id);
						if (link) {
							link.color = c.hex;
						}
					}
					this._saveFlowchartData();
					this._drawLinks();
					this._renderInspector(parent);
				};
			}

			// Section 2: Routing Mode
			const routingSec = append(parent, $('.workflow-toolbar-section'));
			append(routingSec, $('.workflow-toolbar-title')).textContent = 'Routing Mode';
			const routingRow = append(routingSec, $('.workflow-format-row'));
			const routingModes: { mode: 'orthogonal' | 'curved'; label: string }[] = [
				{ mode: 'orthogonal', label: 'Orthogonal' },
				{ mode: 'curved', label: 'Curved' }
			];
			let curRouting: 'orthogonal' | 'curved' = 'orthogonal';
			if (selLinkCount === 1) {
				const selLinkId = Array.from(this._selectedLinkIds)[0];
				const link = this._data.links.find(l => l.id === selLinkId);
				curRouting = link?.routing || this._activeRoutingMode || 'orthogonal';
			}
			for (const rm of routingModes) {
				const btn = append(routingRow, $('.workflow-format-btn'));
				btn.textContent = rm.label;
				if (curRouting === rm.mode) {
					btn.classList.add('active');
				}
				btn.onclick = () => {
					for (const id of this._selectedLinkIds) {
						const link = this._data.links.find(l => l.id === id);
						if (link) link.routing = rm.mode;
					}
					this._saveFlowchartData();
					this._drawLinks();
					this._renderInspector(parent);
				};
			}

			// Section 3: Arrow Style
			const arrowSec = append(parent, $('.workflow-toolbar-section'));
			append(arrowSec, $('.workflow-toolbar-title')).textContent = 'Arrow Style';
			const arrowRow = append(arrowSec, $('.workflow-format-row.grid-2x2'));
			const arrowStyles: { style: IFlowchartLink['style']; label: string }[] = [
				{ style: 'arrow-single', label: 'Single (→)' },
				{ style: 'arrow-double', label: 'Double (↔)' },
				{ style: 'arrow-none', label: 'None (—)' },
				{ style: 'dashed', label: 'Dashed (╌)' }
			];
			let curArrowStyle: IFlowchartLink['style'] = 'arrow-single';
			if (selLinkCount === 1) {
				const selLinkId = Array.from(this._selectedLinkIds)[0];
				const link = this._data.links.find(l => l.id === selLinkId);
				curArrowStyle = link?.style || 'arrow-single';
			}
			for (const as of arrowStyles) {
				const btn = append(arrowRow, $('.workflow-format-btn'));
				btn.textContent = as.label;
				if (curArrowStyle === as.style) {
					btn.classList.add('active');
				}
				btn.onclick = () => {
					for (const id of this._selectedLinkIds) {
						const link = this._data.links.find(l => l.id === id);
						if (link) link.style = as.style;
					}
					this._saveFlowchartData();
					this._drawLinks();
					this._renderInspector(parent);
				};
			}

			return;
		}

		// Case B: Node(s) Selected or Default
		if (selNodeCount === 1) {
			const selId = Array.from(this._selectedNodeIds)[0];
			const node = this._data.nodes.find(n => n.id === selId);
			subtitle.textContent = `Selected: ${node?.label ? (node.label.length > 18 ? node.label.substring(0, 15) + '...' : node.label) : 'Node'}`;
		} else if (selNodeCount > 1) {
			subtitle.textContent = `${selNodeCount} Nodes Selected`;
		} else {
			subtitle.textContent = 'Default / Global Styles';
		}

		// Section 1: Node Color & Theme
		const colorSec = append(parent, $('.workflow-toolbar-section'));
		append(colorSec, $('.workflow-toolbar-title')).textContent = 'Node Color';

		const colorGrid = append(colorSec, $('.workflow-color-grid'));

		let currentColor = '#0d9488';
		if (selNodeCount === 1) {
			const selId = Array.from(this._selectedNodeIds)[0];
			const node = this._data.nodes.find(n => n.id === selId);
			currentColor = node?.color || '#0d9488';
		}

		for (const c of paletteColors) {
			const swatch = append(colorGrid, $('.workflow-color-swatch-btn'));
			swatch.style.backgroundColor = c.hex;
			swatch.title = c.name;
			if (currentColor.toLowerCase() === c.hex.toLowerCase()) {
				swatch.classList.add('active');
			}

			swatch.onclick = () => {
				if (this._selectedNodeIds.size > 0) {
					for (const id of this._selectedNodeIds) {
						const node = this._data.nodes.find(n => n.id === id);
						if (node) {
							node.color = c.hex;
						}
					}
				}
				this._saveFlowchartData();
				this._renderNodes();
				this._drawLinks();
				this._renderInspector(parent);
			};
		}

		// Section 2: Text Formatting
		const textSec = append(parent, $('.workflow-toolbar-section'));
		append(textSec, $('.workflow-toolbar-title')).textContent = 'Text Formatting';

		let isBold = false;
		let isItalic = false;
		let isUnderline = false;
		let isStrikethrough = false;
		let textAlign: 'left' | 'center' | 'right' = 'center';
		let verticalAlign: 'top' | 'center' | 'bottom' = 'center';
		let currentTextColor = '#ffffff';

		if (selNodeCount === 1) {
			const selId = Array.from(this._selectedNodeIds)[0];
			const node = this._data.nodes.find(n => n.id === selId);
			isBold = !!node?.isBold;
			isItalic = !!node?.isItalic;
			isUnderline = !!node?.isUnderline;
			isStrikethrough = !!node?.isStrikethrough;
			textAlign = node?.textAlign || 'center';
			verticalAlign = node?.verticalAlign || 'center';
			currentTextColor = node?.textColor || '#ffffff';
		}

		// Row 1: Font Styles (Bold, Italic, Underline, Strikethrough)
		const styleRow = append(textSec, $('.workflow-format-row'));

		// Bold
		const boldBtn = append(styleRow, $(`.workflow-format-btn${isBold ? '.active' : ''}`));
		boldBtn.textContent = 'B';
		boldBtn.style.fontWeight = 'bold';
		boldBtn.title = 'Bold';
		boldBtn.onclick = () => {
			if (this._selectedNodeIds.size > 0) {
				const nextVal = !isBold;
				for (const id of this._selectedNodeIds) {
					const node = this._data.nodes.find(n => n.id === id);
					if (node) node.isBold = nextVal;
				}
				this._saveFlowchartData();
				this._renderNodes();
				this._renderInspector(parent);
			}
		};

		// Italic
		const italicBtn = append(styleRow, $(`.workflow-format-btn${isItalic ? '.active' : ''}`));
		italicBtn.textContent = 'I';
		italicBtn.style.fontStyle = 'italic';
		italicBtn.style.fontFamily = 'Georgia, serif, sans-serif';
		italicBtn.title = 'Italic';
		italicBtn.onclick = () => {
			if (this._selectedNodeIds.size > 0) {
				const nextVal = !isItalic;
				for (const id of this._selectedNodeIds) {
					const node = this._data.nodes.find(n => n.id === id);
					if (node) node.isItalic = nextVal;
				}
				this._saveFlowchartData();
				this._renderNodes();
				this._renderInspector(parent);
			}
		};

		// Underline
		const underlineBtn = append(styleRow, $(`.workflow-format-btn${isUnderline ? '.active' : ''}`));
		underlineBtn.textContent = 'U';
		underlineBtn.style.textDecoration = 'underline';
		underlineBtn.title = 'Underline';
		underlineBtn.onclick = () => {
			if (this._selectedNodeIds.size > 0) {
				const nextVal = !isUnderline;
				for (const id of this._selectedNodeIds) {
					const node = this._data.nodes.find(n => n.id === id);
					if (node) node.isUnderline = nextVal;
				}
				this._saveFlowchartData();
				this._renderNodes();
				this._renderInspector(parent);
			}
		};

		// Strikethrough
		const strikeBtn = append(styleRow, $(`.workflow-format-btn${isStrikethrough ? '.active' : ''}`));
		strikeBtn.textContent = 'S';
		strikeBtn.style.textDecoration = 'line-through';
		strikeBtn.title = 'Strikethrough';
		strikeBtn.onclick = () => {
			if (this._selectedNodeIds.size > 0) {
				const nextVal = !isStrikethrough;
				for (const id of this._selectedNodeIds) {
					const node = this._data.nodes.find(n => n.id === id);
					if (node) node.isStrikethrough = nextVal;
				}
				this._saveFlowchartData();
				this._renderNodes();
				this._renderInspector(parent);
			}
		};

		// Row 2: Horizontal Alignment (Left, Center, Right)
		const alignRow = append(textSec, $('.workflow-format-row'));
		const alignChoices: { align: 'left' | 'center' | 'right'; label: string; title: string }[] = [
			{ align: 'left', label: 'Left', title: 'Align Left' },
			{ align: 'center', label: 'Center', title: 'Align Center' },
			{ align: 'right', label: 'Right', title: 'Align Right' }
		];
		for (const ac of alignChoices) {
			const aBtn = append(alignRow, $(`.workflow-format-btn.text-btn${textAlign === ac.align ? '.active' : ''}`));
			aBtn.textContent = ac.label;
			aBtn.title = ac.title;
			aBtn.onclick = () => {
				if (this._selectedNodeIds.size > 0) {
					for (const id of this._selectedNodeIds) {
						const node = this._data.nodes.find(n => n.id === id);
						if (node) node.textAlign = ac.align;
					}
					this._saveFlowchartData();
					this._renderNodes();
					this._renderInspector(parent);
				}
			};
		}

		// Row 3: Vertical Alignments (Top, Middle, Bottom)
		const vAlignRow = append(textSec, $('.workflow-format-row'));
		const vAlignChoices: { align: 'top' | 'center' | 'bottom'; label: string; title: string }[] = [
			{ align: 'top', label: 'Top', title: 'Align Top' },
			{ align: 'center', label: 'Middle', title: 'Align Middle' },
			{ align: 'bottom', label: 'Bottom', title: 'Align Bottom' }
		];
		for (const va of vAlignChoices) {
			const vaBtn = append(vAlignRow, $(`.workflow-format-btn${verticalAlign === va.align ? '.active' : ''}`));
			vaBtn.textContent = va.label;
			vaBtn.title = va.title;
			vaBtn.onclick = () => {
				if (this._selectedNodeIds.size > 0) {
					for (const id of this._selectedNodeIds) {
						const node = this._data.nodes.find(n => n.id === id);
						if (node) node.verticalAlign = va.align;
					}
					this._saveFlowchartData();
					this._renderNodes();
					this._renderInspector(parent);
				}
			};
		}

		// Text Color Sub-section
		const textColorTitle = append(textSec, $('.workflow-sub-title'));
		textColorTitle.textContent = 'Text Color';

		const textColorGrid = append(textSec, $('.workflow-color-grid.small'));
		const textColors = [
			{ name: 'White', hex: '#ffffff' },
			{ name: 'Teal (Default)', hex: '#0d9488' },
			{ name: 'Sky Blue', hex: '#38bdf8' },
			{ name: 'Violet Purple', hex: '#7c3aed' },
			{ name: 'Amber Gold', hex: '#facc15' },
			{ name: 'Rose Red', hex: '#f43f5e' }
		];
		for (const tc of textColors) {
			const tcBtn = append(textColorGrid, $('.workflow-color-swatch-btn.small'));
			tcBtn.style.backgroundColor = tc.hex;
			tcBtn.title = tc.name;
			if (currentTextColor.toLowerCase() === tc.hex.toLowerCase()) {
				tcBtn.classList.add('active');
			}
			tcBtn.onclick = () => {
				if (this._selectedNodeIds.size > 0) {
					for (const id of this._selectedNodeIds) {
						const node = this._data.nodes.find(n => n.id === id);
						if (node) node.textColor = tc.hex;
					}
					this._saveFlowchartData();
					this._renderNodes();
					this._renderInspector(parent);
				}
			};
		}

		// Export & Download Section (Always available at the bottom of Inspector)
		const exportSec = append(parent, $('.workflow-toolbar-section'));
		const isSelection = this._selectedNodeIds.size > 0;
		const exportTitle = isSelection ? `Export Selection (${this._selectedNodeIds.size})` : 'Export / Download';
		append(exportSec, $('.workflow-toolbar-title')).textContent = exportTitle;

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

	private _setZoom(level: number): void {
		this._zoomLevel = Math.max(0.25, Math.min(2.0, Math.round(level * 100) / 100));
		if (this._canvas) {
			this._canvas.style.transform = `scale(${this._zoomLevel})`;
			this._canvas.style.transformOrigin = '0 0';
		}
		if (this._zoomSizerEl) {
			this._zoomSizerEl.style.width = `${2400 * this._zoomLevel}px`;
			this._zoomSizerEl.style.height = `${2000 * this._zoomLevel}px`;
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

			// Custom Node Theme Color
			if (node.color) {
				nodeEl.style.borderColor = node.color;
				nodeEl.style.backgroundColor = hexToRgba(node.color, 0.12);
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

			if (!this._isPureDiagram) {
				// Drag over and Drop support on Node to import modules
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
					if (dataStr && dataStr.startsWith('any-agent-import:')) {
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
			}

			const labelWrapper = append(nodeEl, $('.node-label'));
			labelWrapper.textContent = node.label || '';

			// Multiline formatting & Alignment
			const textAlign = node.textAlign || 'center';
			labelWrapper.style.textAlign = textAlign;
			if (textAlign === 'left') {
				labelWrapper.style.alignItems = 'flex-start';
			} else if (textAlign === 'right') {
				labelWrapper.style.alignItems = 'flex-end';
			} else {
				labelWrapper.style.alignItems = 'center';
			}

			const verticalAlign = node.verticalAlign || 'center';
			if (verticalAlign === 'top') {
				labelWrapper.style.justifyContent = 'flex-start';
				labelWrapper.style.paddingTop = '4px';
			} else if (verticalAlign === 'bottom') {
				labelWrapper.style.justifyContent = 'flex-end';
				labelWrapper.style.paddingBottom = '4px';
			} else {
				labelWrapper.style.justifyContent = 'center';
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
				const typeCounts = new Map<string, number>();
				for (const imp of node.imports) {
					const count = typeCounts.get(imp.type) || 0;
					typeCounts.set(imp.type, count + 1);
				}

				const badgesContainer = append(nodeEl, $('.node-imports-badges-container'));
				for (const [type, count] of typeCounts.entries()) {
					const badge = append(badgesContainer, $(`.node-import-badge.${type}`));

					// Dynamic Icon & Color mapping to match workspacesExplorerPane.ts exactly
					let codicon = Codicon.package; // default for custom types
					let color = '';
					const lower = type.toLowerCase();

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
						codicon = Codicon.package; // cube/package for all custom types
						color = getColorForName(type);
					}

					// Hex to RGBA background color
					const r = parseInt(color.slice(1, 3), 16);
					const g = parseInt(color.slice(3, 5), 16);
					const b = parseInt(color.slice(5, 7), 16);

					badge.style.backgroundColor = `rgba(${r}, ${g}, ${b}, 0.15)`;
					badge.style.color = color;

					append(badge, $('span' + ThemeIcon.asCSSSelector(codicon)));

					const displayType = type.charAt(0).toUpperCase() + type.slice(1);
					append(badge, $('span.badge-text', {}, `${displayType} (${count})`));
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

		const labelEl = nodeEl.querySelector('.node-label') as HTMLElement;
		if (labelEl) {
			labelEl.style.visibility = 'hidden';
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

	private _createChildNode(parent: IFlowchartNode): void {
		if (!this._data || !Array.isArray(this._data.nodes) || !Array.isArray(this._data.links)) {
			return;
		}

		// Find existing direct child nodes
		const childLinks = this._data.links.filter(l => l.from === parent.id);
		const existingChildren = childLinks
			.map(l => this._data.nodes.find(n => n.id === l.to))
			.filter(Boolean) as IFlowchartNode[];

		const horizontalGap = 80;
		const verticalGap = 20;

		const childX = parent.x + parent.width + horizontalGap;
		let childY = parent.y;

		if (existingChildren.length > 0) {
			const maxBottom = Math.max(...existingChildren.map(c => c.y + c.height));
			childY = maxBottom + verticalGap;
		}

		const newId = `node_${Date.now()}`;
		const newChild: IFlowchartNode = {
			id: newId,
			type: parent.type || 'round-rect',
			x: childX,
			y: childY,
			width: parent.width || 120,
			height: parent.height || 50,
			label: 'New Node',
			color: parent.color || '#0d9488',
			textColor: parent.textColor || '#ffffff',
			textAlign: parent.textAlign || 'center',
			verticalAlign: parent.verticalAlign || 'center',
			isBold: parent.isBold,
			isItalic: parent.isItalic,
			isUnderline: parent.isUnderline,
			isStrikethrough: parent.isStrikethrough
		};

		const newLink: IFlowchartLink = {
			id: `link_${Date.now()}`,
			from: parent.id,
			fromPort: 'right',
			to: newId,
			toPort: 'left',
			style: this._activeLinkStyle || 'arrow-single',
			routing: 'orthogonal',
			color: parent.color || '#0d9488'
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

		setTimeout(() => {
			if (this._nodesContainer) {
				const newNodeEl = this._nodesContainer.querySelector(`.workflow-node[data-node-id="${newId}"]`) as HTMLElement;
				if (newNodeEl) {
					this._showInlineEditor(newNodeEl, newChild);
				}
			}
		}, 60);
	}

	private _createSiblingNode(current: IFlowchartNode): void {
		if (!this._data || !Array.isArray(this._data.nodes) || !Array.isArray(this._data.links)) {
			return;
		}

		const verticalGap = 20;

		// Find parent link if current has a parent
		const parentLink = this._data.links.find(l => l.to === current.id);
		const parentNode = parentLink ? this._data.nodes.find(n => n.id === parentLink.from) : undefined;

		const siblingX = current.x;
		let siblingY = current.y + current.height + verticalGap;

		if (parentNode) {
			const siblingLinks = this._data.links.filter(l => l.from === parentNode.id);
			const allSiblings = siblingLinks
				.map(l => this._data.nodes.find(n => n.id === l.to))
				.filter(Boolean) as IFlowchartNode[];
			if (allSiblings.length > 0) {
				const maxBottom = Math.max(...allSiblings.map(s => s.y + s.height), current.y + current.height);
				siblingY = maxBottom + verticalGap;
			}
		} else {
			const roots = this._data.nodes.filter(n => !this._data.links.some(l => l.to === n.id));
			if (roots.length > 0) {
				const maxBottom = Math.max(...roots.map(r => r.y + r.height), current.y + current.height);
				siblingY = maxBottom + verticalGap;
			}
		}

		const newId = `node_${Date.now()}`;
		const newSibling: IFlowchartNode = {
			id: newId,
			type: current.type || 'round-rect',
			x: siblingX,
			y: siblingY,
			width: current.width || 120,
			height: current.height || 50,
			label: 'New Node',
			color: current.color || '#0d9488',
			textColor: current.textColor || '#ffffff',
			textAlign: current.textAlign || 'center',
			verticalAlign: current.verticalAlign || 'center',
			isBold: current.isBold,
			isItalic: current.isItalic,
			isUnderline: current.isUnderline,
			isStrikethrough: current.isStrikethrough
		};

		this._data.nodes.push(newSibling);

		if (parentNode) {
			const newLink: IFlowchartLink = {
				id: `link_${Date.now()}`,
				from: parentNode.id,
				fromPort: 'right',
				to: newId,
				toPort: 'left',
				style: parentLink?.style || this._activeLinkStyle || 'arrow-single',
				routing: 'orthogonal',
				color: parentNode.color || current.color || '#0d9488'
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

		setTimeout(() => {
			if (this._nodesContainer) {
				const newNodeEl = this._nodesContainer.querySelector(`.workflow-node[data-node-id="${newId}"]`) as HTMLElement;
				if (newNodeEl) {
					this._showInlineEditor(newNodeEl, newSibling);
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
			label
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
			label
		};

		this._data.nodes.push(newNode);
		this._selectedNodeIds.clear();
		this._selectedNodeIds.add(id);
		this._saveFlowchartData();

		this._renderNodes();
		this._drawLinks();
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

				// Force symmetric size for circle and diamond
				if (node.type === 'circle' || node.type === 'diamond') {
					const size = Math.max(node.width, node.height);
					node.width = size;
					node.height = size;
				}

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

			// Update positions of all dragged nodes
			for (const [nid, startPos] of this._draggedNodesStartPos) {
				const node = this._data.nodes.find(item => item.id === nid);
				if (node) {
					node.x = Math.max(10, startPos.x + deltaX);
					node.y = Math.max(10, startPos.y + deltaY);

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
						style: this._activeLinkStyle
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
			if (!hasMoved && this._collapseSelectionTargetNodeId) {
				this._selectedNodeIds.clear();
				this._selectedLinkIds.clear();
				this._selectedNodeIds.add(this._collapseSelectionTargetNodeId);
				this._renderNodes();
				this._drawLinks();
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

		if (node.type === 'diamond') {
			const halfDiagW = (node.width / 2) * Math.SQRT2;
			const halfDiagH = (node.height / 2) * Math.SQRT2;
			switch (port) {
				case 'top': return { x: cx, y: cy - halfDiagH };
				case 'bottom': return { x: cx, y: cy + halfDiagH };
				case 'left': return { x: cx - halfDiagW, y: cy };
				case 'right': return { x: cx + halfDiagW, y: cy };
			}
		}

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
		const existing = this._linkDeletesContainer.querySelector('.workflow-link-label-editor');
		if (existing) existing.remove();

		const textarea = append(this._linkDeletesContainer, $('textarea.workflow-link-label-editor')) as HTMLTextAreaElement;
		textarea.value = link.label || '';
		textarea.placeholder = 'Label... (Shift+Enter for newline)';
		textarea.style.left = `${x}px`;
		textarea.style.top = `${y}px`;

		const adjustHeight = () => {
			textarea.style.height = 'auto';
			textarea.style.height = `${Math.min(90, Math.max(24, textarea.scrollHeight + 2))}px`;
		};
		textarea.oninput = adjustHeight;

		let committed = false;
		const commit = () => {
			if (committed) return;
			committed = true;
			const val = textarea.value.trim();
			if (val) {
				link.label = val;
			} else {
				delete link.label;
			}
			textarea.remove();
			this._saveFlowchartData();
			this._drawLinks();
		};

		textarea.onkeydown = (e) => {
			e.stopPropagation();
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				commit();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				committed = true;
				textarea.remove();
				this._drawLinks();
			}
		};

		textarea.onblur = () => {
			commit();
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
				labelEl.textContent = link.label;
				labelEl.setAttribute('data-link-id', link.id);
				labelEl.style.left = `${labelPt.x}px`;
				labelEl.style.top = `${labelPt.y}px`;
				labelEl.style.maxWidth = `${maxLabelWidth}px`;
				labelEl.title = `${link.label}\n\n• Drag along line to reposition\n• Double-click to edit (Shift+Enter for newline)`;
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
						label: nt.label.split(' ')[0]
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
									imports: [{ type: type as any, name }]
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

