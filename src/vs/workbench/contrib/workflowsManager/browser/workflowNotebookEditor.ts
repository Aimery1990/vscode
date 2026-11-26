/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import './media/workflowEditor.css';
import { $, append, clearNode, Dimension, getWindow } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorInputCapabilities, IEditorOpenContext, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { WorkflowEditorInput } from './workflowEditorInput.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IEntityPersistenceService } from '../../entityPersistence/common/entityPersistence.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkflowExecutionService, INotebookCellExecutionResult } from '../common/workflowExecutionService.js';
import { isWorkflowRecord } from '../common/workflowExecutionModel.js';
import { ITicketWorkflowRuntimeService } from './ticketWorkflowRuntime.js';
import {
	WorkflowToPythonConverter,
	PythonToWorkflowParser,
	WorkflowPythonEditorBridge,
	parseComponentCommentAnchor,
	IFlowchartData
} from './workflowPythonSync.js';

interface IIpynbCell {
	cell_type: 'markdown' | 'code';
	execution_count?: number | null;
	metadata: Record<string, string | number>;
	outputs?: unknown[];
	source: string[];
}

const workflowNotebookEditorIcon = registerIcon(
	'workflow-notebook-editor-label-icon',
	Codicon.notebook,
	'Icon of the workflow Jupyter Notebook editor label.'
);

export class WorkflowNotebookEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.workflowNotebookEditor';

	private _resource: URI;
	private _name: string;

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton;
	}

	constructor(
		public readonly workflowUri: URI,
		public readonly workflowName: string,
		public focusNodeId?: string
	) {
		super();
		this._resource = URI.from({
			scheme: 'vscode-workflow-notebook',
			path: `/${encodeURIComponent(workflowUri.toString())}`,
		});
		this._name = `${workflowName} (Notebook)`;
	}

	override get typeId(): string {
		return WorkflowNotebookEditorInput.ID;
	}

	override get resource(): URI {
		return this._resource;
	}

	override getName(): string {
		return this._name;
	}

	override getIcon(): ThemeIcon {
		return workflowNotebookEditorIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (other instanceof WorkflowNotebookEditorInput) {
			return other.workflowUri.toString() === this.workflowUri.toString();
		}
		return false;
	}
}

interface INotebookStepCellModel {
	cellId: string;
	code: string;
	executionCount: number | null;
	isRunning: boolean;
	lastResult?: INotebookCellExecutionResult;
	textareaEl?: HTMLTextAreaElement;
	promptEl?: HTMLElement;
	outputContainerEl?: HTMLElement;
	cellRootEl?: HTMLElement;
}

interface INotebookNodeSectionModel {
	nodeId: string;
	orderIndex: number;
	title: string;
	nodeType: string;
	shape: string;
	cells: INotebookStepCellModel[];
	sectionEl?: HTMLElement;
	titleInputEl?: HTMLInputElement;
}

interface INotebookConnectionCellModel {
	connectionId: string;
	orderIndex: number;
	fromNodeId: string;
	toNodeId: string;
	title: string;
	connectionStyle: string;
	conditionCode: string;
	executionCount: number | null;
	isRunning: boolean;
	lastResult?: INotebookCellExecutionResult;
	textareaEl?: HTMLTextAreaElement;
	promptEl?: HTMLElement;
	outputContainerEl?: HTMLElement;
}

export class WorkflowNotebookEditor extends EditorPane {
	static readonly ID = 'workbench.editor.workflowNotebookEditor';
	private static readonly _savedScrollByUri = new Map<string, number>();

	private _rootContainer?: HTMLElement;
	private _sidebarEl?: HTMLElement;
	private _varChipsWrap?: HTMLElement;
	private _notebookScrollEl?: HTMLElement;
	/** The code cell that currently carries the `active` class (only one cell is active at a time). */
	private _activeCodeCellEl?: HTMLElement;
	private _kernelBadgeEl?: HTMLElement;
	private _kernelStatusDot?: HTMLElement;
	private _kernelStatusText?: HTMLElement;

	private _workflowUri?: URI;
	private _workflowId: string = '';
	private _workflowName: string = '';
	private _pythonPath?: string;
	private _detectedPythonPath: string = 'python3';
	private _currentScrollKey: string = '';
	private _isRestoringScroll: boolean = false;
	private _userHasScrolledSinceRender: boolean = false;

	private _nodeSections: INotebookNodeSectionModel[] = [];
	private _connectionCells: INotebookConnectionCellModel[] = [];
	private _activeTextarea: HTMLTextAreaElement | null = null;
	private _activeCellInfo: { section?: INotebookNodeSectionModel; cell?: INotebookStepCellModel; conn?: INotebookConnectionCellModel } | null = null;
	private _isToolboxCollapsed = false;
	private _isStoppingNotebook = false;
	private readonly _inputDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly _storageService: IStorageService,
		@IFileService private readonly _fileService: IFileService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IEntityPersistenceService private readonly _entityPersistenceService: IEntityPersistenceService,
		@ITicketWorkflowRuntimeService private readonly _ticketRuntimeService: ITicketWorkflowRuntimeService,
		@IWorkflowExecutionService private readonly _workflowExecutionService: IWorkflowExecutionService,
		@IEditorService private readonly _editorService: IEditorService
	) {
		super(WorkflowNotebookEditor.ID, group, telemetryService, themeService, _storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._rootContainer = append(parent, $('div.workflow-notebook-editor-root'));
		this._rootContainer.tabIndex = 0;

		this._rootContainer.addEventListener('keydown', (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
				e.preventDefault();
				e.stopPropagation();
				this._syncNotebookToWorkflow();
			}
		});
	}

	private _saveCurrentScrollPosition(): void {
		if (!this._notebookScrollEl || this._isRestoringScroll || !this._currentScrollKey || this._notebookScrollEl.clientHeight <= 0) {
			return;
		}
		const top = this._notebookScrollEl.scrollTop;
		WorkflowNotebookEditor._savedScrollByUri.set(this._currentScrollKey, top);
		try {
			this._storageService.store(`workflowNotebookEditor.scroll.${this._currentScrollKey}`, String(top), StorageScope.PROFILE, StorageTarget.MACHINE);
		} catch { }
	}

	private _getSavedScrollTop(key: string): number {
		if (!key) {
			return 0;
		}
		const cached = WorkflowNotebookEditor._savedScrollByUri.get(key);
		if (typeof cached === 'number') {
			return cached;
		}
		try {
			const raw = this._storageService.get(`workflowNotebookEditor.scroll.${key}`, StorageScope.PROFILE);
			if (raw !== undefined) {
				const parsed = Number(raw);
				if (!isNaN(parsed) && parsed >= 0) {
					WorkflowNotebookEditor._savedScrollByUri.set(key, parsed);
					return parsed;
				}
			}
		} catch { }
		return 0;
	}

	override clearInput(): void {
		this._saveCurrentScrollPosition();
		super.clearInput();
	}

	override async setInput(
		input: WorkflowNotebookEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken
	): Promise<void> {
		this._saveCurrentScrollPosition();
		await super.setInput(input, options, context, token);
		this._inputDisposables.clear();

		this._workflowUri = input.workflowUri;
		this._currentScrollKey = this._workflowUri.toString();
		const snapshot = this._entityPersistenceService.getSnapshot(this._workflowUri);
		this._workflowId = snapshot?.ticketId || input.workflowName || this._workflowUri.path.split('/').pop() || 'workflow';
		this._workflowName = snapshot?.entityName || input.workflowName || this._workflowId;

		const initialFocusNodeId = input.focusNodeId;
		input.focusNodeId = undefined;
		await this._loadFromWorkflowData(initialFocusNodeId);
	}

	public async focusNodeSection(nodeId?: string): Promise<void> {
		if (!nodeId) {
			return;
		}
		const targetSec = this._nodeSections.find(s => s.nodeId === nodeId);
		if (targetSec && targetSec.sectionEl) {
			targetSec.sectionEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
			targetSec.sectionEl.classList.add('nb-section-focus-pulse');
			setTimeout(() => targetSec.sectionEl?.classList.remove('nb-section-focus-pulse'), 1600);
			const editableCell = targetSec.cells.find(c => !parseComponentCommentAnchor(c.code)) || targetSec.cells[0];
			if (editableCell?.textareaEl) {
				editableCell.textareaEl.focus();
			}
		}
	}

	private async _loadFlowchartData(): Promise<IFlowchartData | null> {
		if (!this._workflowUri) {
			return null;
		}
		const flowchartJsonUri = URI.joinPath(this._workflowUri, '.agents', 'workflow_flowchart.json');
		if (await this._fileService.exists(flowchartJsonUri)) {
			try {
				const raw = await this._fileService.readFile(flowchartJsonUri);
				return JSON.parse(raw.value.toString());
			} catch {
				// fallback below
			}
		}
		const snapshot = this._entityPersistenceService.getSnapshot(this._workflowUri);
		if (snapshot?.customMetadata?.flowchartJson) {
			try {
				return JSON.parse(snapshot.customMetadata.flowchartJson);
			} catch {
				// ignore
			}
		}
		return null;
	}

	private async _loadFromWorkflowData(focusNodeId?: string): Promise<void> {
		const data = await this._loadFlowchartData();
		if (!data) {
			if (this._rootContainer) {
				clearNode(this._rootContainer);
				append(this._rootContainer, $('div.workflow-notebook-empty', {}, 'Unable to load workflow data.'));
			}
			return;
		}

		this._pythonPath = data.pythonPath;
		if (this._workflowUri) {
			try {
				const envInfo = await this._ticketRuntimeService.detectPythonEnvironment(this._workflowUri, this._pythonPath);
				this._detectedPythonPath = envInfo?.interpreterPath || this._pythonPath || 'python3';
			} catch {
				this._detectedPythonPath = this._pythonPath || 'python3';
			}
		}

		const pySource = WorkflowToPythonConverter.convertWorkflowToPython(data, {
			workflowId: this._workflowId,
			workflowName: this._workflowName,
			workflowUri: this._workflowUri?.toString() || ''
		});

		const parsed = PythonToWorkflowParser.parseWorkflowPythonFile(pySource);

		const nodeTypeById = new Map<string, string>();
		for (const rawNode of data.nodes || []) {
			if (rawNode?.id) {
				nodeTypeById.set(rawNode.id, rawNode.type || 'round-rect');
			}
		}

		this._nodeSections = parsed.nodes.map((n, idx) => {
			const rawCode = (n.code || '').trim();
			const stepBlocks = this._splitNodeCodeIntoStepCells(rawCode);
			const hasOnlyComponentComments = stepBlocks.length > 0 && stepBlocks.every(b => Boolean(parseComponentCommentAnchor(b)));
			const effectiveBlocks = stepBlocks.length > 0
				? (hasOnlyComponentComments ? [...stepBlocks, ''] : stepBlocks)
				: [''];
			const cells: INotebookStepCellModel[] = effectiveBlocks.map((stepCode, cIdx) => ({
				cellId: `${n.nodeId}_cell_${cIdx}_${Date.now()}`,
				code: stepCode,
				executionCount: null,
				isRunning: false
			}));
			return {
				nodeId: n.nodeId,
				orderIndex: n.orderIndex || (idx + 1),
				title: n.title || n.nodeId,
				nodeType: nodeTypeById.get(n.nodeId) || n.nodeType || 'round-rect',
				shape: n.shape || 'Round Rect',
				cells
			};
		});

		this._connectionCells = parsed.connections.map((c, idx) => {
			let cond = (c.condition ?? c.code ?? '').trim();
			if (cond === '# Unconditional connection') {
				cond = '';
			}
			const srcId = c.sourceNodeId || c.fromNodeId || '';
			const tgtId = c.targetNodeId || c.toNodeId || '';
			return {
				connectionId: c.connectionId,
				orderIndex: c.orderIndex || (idx + 1),
				fromNodeId: srcId,
				toNodeId: tgtId,
				title: c.title || `${srcId} -> ${tgtId}`,
				connectionStyle: c.connectionStyle || 'Single Arrow',
				conditionCode: cond,
				executionCount: null,
				isRunning: false
			};
		});

		this._userHasScrolledSinceRender = false;
		this._isRestoringScroll = true;
		this._renderNotebookUI();

		const scrollKey = this._currentScrollKey;
		if (focusNodeId) {
			this._isRestoringScroll = false;
			setTimeout(() => this.focusNodeSection(focusNodeId), 80);
		} else if (scrollKey) {
			const targetTop = this._getSavedScrollTop(scrollKey);
			const applyScroll = () => {
				if (!this._notebookScrollEl || this._userHasScrolledSinceRender || this._currentScrollKey !== scrollKey) {
					this._isRestoringScroll = false;
					return;
				}
				if (targetTop > 0) {
					this._isRestoringScroll = true;
					this._notebookScrollEl.scrollTop = targetTop;
				}
			};
			applyScroll();
			getWindow(this._notebookScrollEl).requestAnimationFrame(() => {
				applyScroll();
				setTimeout(() => {
					applyScroll();
					this._isRestoringScroll = false;
				}, 80);
			});
		} else {
			this._isRestoringScroll = false;
		}
	}

	private _splitNodeCodeIntoStepCells(rawCode: string): string[] {
		if (!rawCode) {
			return [];
		}
		const lines = rawCode.split(/\r?\n/);
		const cleanedLines = lines.filter(l => {
			const t = l.trim();
			if (t === '# No Python steps configured' || t === 'pass') {
				return false;
			}
			return true;
		});
		if (cleanedLines.length === 0) {
			return [];
		}

		// Check if separated by explicit `###` step dividers
		const joined = cleanedLines.join('\n');
		if (/^\s*###+\s*$/m.test(joined)) {
			return joined
				.split(/^\s*###+\s*$/m)
				.map(s => s.trim())
				.filter(Boolean);
		}

		// Otherwise split top-level statements into individual cells
		const blocks: string[] = [];
		let current: string[] = [];
		let bracketDepth = 0;

		const countBracketDelta = (line: string): number => {
			let delta = 0;
			let inSingle = false;
			let inDouble = false;
			for (let i = 0; i < line.length; i++) {
				const ch = line[i];
				const prev = i > 0 ? line[i - 1] : '';
				if (ch === '#' && !inSingle && !inDouble) {
					break;
				}
				if (ch === '\'' && !inDouble && prev !== '\\') {
					inSingle = !inSingle;
				} else if (ch === '"' && !inSingle && prev !== '\\') {
					inDouble = !inDouble;
				} else if (!inSingle && !inDouble) {
					if (ch === '(' || ch === '[' || ch === '{') {
						delta++;
					} else if (ch === ')' || ch === ']' || ch === '}') {
						delta--;
					}
				}
			}
			return delta;
		};

		for (let i = 0; i < cleanedLines.length; i++) {
			const line = cleanedLines[i];
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}
			const isIndented = /^\s+/.test(line);
			const isContinuationClause = /^(elif\b|else\s*:|except\b|finally\s*:)/.test(trimmed);

			if (current.length > 0 && bracketDepth <= 0 && !isIndented && !isContinuationClause) {
				blocks.push(current.join('\n').trim());
				current = [line];
				bracketDepth = Math.max(0, countBracketDelta(line));
			} else {
				current.push(line);
				bracketDepth = Math.max(0, bracketDepth + countBracketDelta(line));
			}
		}

		if (current.length > 0) {
			blocks.push(current.join('\n').trim());
		}

		return blocks.filter(Boolean);
	}

	private _buildPythonSourceFromNotebook(): string {
		const headerLines: string[] = [
			`# ================================================================================`,
			`# WORKFLOW_PYTHON_SYNC_V1`,
			`# WORKFLOW_ID: ${this._workflowId}`,
			`# WORKFLOW_NAME: ${this._workflowName}`,
		];
		if (this._workflowUri) {
			headerLines.push(`# WORKFLOW_URI: ${this._workflowUri.toString()}`);
		}
		headerLines.push(
			`# ================================================================================`,
			``
		);

		const bodyLines: string[] = [...headerLines];

		for (const sec of this._nodeSections) {
			const cleanTitle = (sec.titleInputEl?.value || sec.title || sec.nodeId).trim();
			sec.title = cleanTitle;
			bodyLines.push(`# ================================================================================`);
			bodyLines.push(`# NODE: ${cleanTitle}`);
			bodyLines.push(`# NODE_ID: ${sec.nodeId}`);
			bodyLines.push(`# SHAPE: ${sec.shape || 'Round Rect'}`);
			bodyLines.push(`# ================================================================================`);
			bodyLines.push(`# >>> WRITE NODE CODE BELOW <<<`);

			const nonEmptyCells = sec.cells
				.map(c => (c.textareaEl ? c.textareaEl.value : c.code).trim())
				.filter(c => Boolean(c) && c !== '# No Python steps configured' && c !== 'pass');

			if (nonEmptyCells.length > 0) {
				bodyLines.push(nonEmptyCells.join('\n###\n'));
			}
			bodyLines.push(``);
			bodyLines.push(``);
		}

		if (this._connectionCells.length > 0) {
			for (const conn of this._connectionCells) {
				const condVal = (conn.textareaEl ? conn.textareaEl.value : conn.conditionCode).trim();
				conn.conditionCode = condVal;
				bodyLines.push(`# ================================================================================`);
				bodyLines.push(`# CONNECTION: ${conn.title}`);
				bodyLines.push(`# CONNECTION_ID: ${conn.connectionId}`);
				bodyLines.push(`# SOURCE_NODE_ID: ${conn.fromNodeId}`);
				bodyLines.push(`# TARGET_NODE_ID: ${conn.toNodeId}`);
				bodyLines.push(`# CONDITION:`);
				bodyLines.push(`# CONNECTION_STYLE: ${conn.connectionStyle || 'Single Arrow'}`);
				bodyLines.push(`# ================================================================================`);
				bodyLines.push(`# >>> WRITE CONNECTION CONDITION CODE BELOW <<<`);
				if (condVal && condVal !== '# Unconditional connection') {
					bodyLines.push(condVal);
				}
				bodyLines.push(``);
				bodyLines.push(``);
			}
		}

		return bodyLines.join('\n');
	}

	private _buildIpynbJsonString(): string {
		const nbCells: IIpynbCell[] = [];

		nbCells.push({
			cell_type: 'markdown',
			metadata: {
				anyagent_workflow_id: this._workflowId,
				anyagent_workflow_name: this._workflowName,
				anyagent_workflow_uri: this._workflowUri?.toString() || ''
			},
			source: [
				`# \uD83D\uDCD3 ${this._workflowName} (${this._workflowId})\n`,
				`Interactive AnyAgent Workflow Jupyter Notebook`
			]
		});

		for (const sec of this._nodeSections) {
			nbCells.push({
				cell_type: 'markdown',
				metadata: {
					anyagent_role: 'node_header',
					node_id: sec.nodeId,
					node_title: sec.title,
					node_type: sec.nodeType,
					order_index: sec.orderIndex
				},
				source: [
					`## [Node #${sec.orderIndex}] ${sec.title} (\`${sec.nodeType}\`)`
				]
			});

			for (const cell of sec.cells) {
				const codeStr = (cell.textareaEl ? cell.textareaEl.value : cell.code) || '';
				const lines = codeStr.split('\n').map((l, i, arr) => i < arr.length - 1 ? `${l}\n` : l);
				nbCells.push({
					cell_type: 'code',
					execution_count: cell.executionCount,
					metadata: {
						anyagent_role: 'node_step',
						node_id: sec.nodeId,
						cell_id: cell.cellId
					},
					outputs: [],
					source: lines
				});
			}
		}

		for (const conn of this._connectionCells) {
			if (!conn.conditionCode && !conn.textareaEl?.value.trim()) {
				continue;
			}
			const condStr = (conn.textareaEl ? conn.textareaEl.value : conn.conditionCode) || '';
			nbCells.push({
				cell_type: 'code',
				execution_count: conn.executionCount,
				metadata: {
					anyagent_role: 'connection_condition',
					connection_id: conn.connectionId,
					from_node: conn.fromNodeId,
					to_node: conn.toNodeId
				},
				outputs: [],
				source: [condStr]
			});
		}

		return JSON.stringify({
			cells: nbCells,
			metadata: {
				kernelspec: {
					display_name: 'Python 3 (AnyAgent Workflow Kernel)',
					language: 'python',
					name: 'python3'
				},
				language_info: {
					name: 'python'
				}
			},
			nbformat: 4,
			nbformat_minor: 5
		}, null, 2);
	}

	private _renderNotebookUI(): void {
		if (!this._rootContainer) {
			return;
		}
		clearNode(this._rootContainer);

		// 1. Left Sidebar Toolbox (same style & capabilities as .workflow.py Toolbox)
		this._sidebarEl = append(this._rootContainer, $('div.workflow-py-toolbox-sidebar.notebook-toolbox-sidebar'));
		if (this._isToolboxCollapsed) {
			this._sidebarEl.classList.add('collapsed');
		}

		const headerEl = append(this._sidebarEl, $('div.workflow-py-toolbox-header'));
		const titleSpan = append(headerEl, $('span.workflow-py-toolbox-title', {}, 'TOOLBOX'));
		if (this._isToolboxCollapsed) {
			titleSpan.style.display = 'none';
		}
		const toggleBtn = append(headerEl, $('div.workflow-py-toolbox-toggle' + ThemeIcon.asCSSSelector(this._isToolboxCollapsed ? Codicon.chevronRight : Codicon.chevronLeft)));
		toggleBtn.title = this._isToolboxCollapsed ? 'Expand Toolbox' : 'Collapse Toolbox';
		toggleBtn.onclick = (e) => {
			e.stopPropagation();
			this._isToolboxCollapsed = !this._isToolboxCollapsed;
			this._sidebarEl?.classList.toggle('collapsed', this._isToolboxCollapsed);
			titleSpan.style.display = this._isToolboxCollapsed ? 'none' : '';
			toggleBtn.className = 'workflow-py-toolbox-toggle ' + (this._isToolboxCollapsed ? 'codicon codicon-chevron-right' : 'codicon codicon-chevron-left');
		};

		const syncBox = append(this._sidebarEl, $('div.workflow-py-toolbox-sync-box'));

		const syncBtn = append(syncBox, $('div.workflow-py-toolbox-sync-btn'));
		syncBtn.title = 'Synchronize Jupyter Notebook cells back to Workflow (Cmd/Ctrl+S)';
		append(syncBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.sync)));
		const syncLabel = append(syncBtn, $('span.sync-label', {}, 'Sync to Workflow'));
		syncBtn.onclick = async (e) => {
			e.stopPropagation();
			syncLabel.textContent = 'Syncing...';
			syncBtn.style.opacity = '0.7';
			try {
				await this._syncNotebookToWorkflow();
			} finally {
				syncLabel.textContent = 'Sync to Workflow';
				syncBtn.style.opacity = '1';
			}
		};

		const openWfBtn = append(syncBox, $('div.workflow-py-toolbox-open-wf-btn'));
		openWfBtn.title = 'Switch to Visual Workflow Editor';
		append(openWfBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.typeHierarchySub)));
		append(openWfBtn, $('span.sync-label', {}, 'Visual Workflow'));
		openWfBtn.onclick = async (e) => {
			e.stopPropagation();
			if (this._workflowUri) {
				await this._editorService.openEditor(new WorkflowEditorInput(this._workflowUri, this._workflowName || this._workflowId), { pinned: true });
			}
		};

		const openPyBtn = append(syncBox, $('div.workflow-py-toolbox-open-wf-btn'));
		openPyBtn.title = 'Open as Python File (.workflow.py)';
		append(openPyBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.python)));
		append(openPyBtn, $('span.sync-label', {}, 'Python File (.py)'));
		openPyBtn.onclick = async (e) => {
			e.stopPropagation();
			if (!this._workflowUri) {
				return;
			}
			const safeId = this._workflowId.replace(/[^a-zA-Z0-9_-]/g, '_');
			const pyFileUri = URI.joinPath(this._workflowUri, '.agents', `${safeId}.workflow.py`);
			const pySource = this._buildPythonSourceFromNotebook();
			try {
				await this._fileService.writeFile(pyFileUri, VSBuffer.fromString(pySource));
				await this._editorService.openEditor({ resource: pyFileUri, options: { pinned: true } });
			} catch (err) {
				this._notificationService.error(`Failed to open Python file: ${err?.message || err}`);
			}
		};

		const tbBody = append(this._sidebarEl, $('div.workflow-py-toolbox-body'));
		const fnGroup = append(tbBody, $('div.workflow-py-toolbox-group'));
		append(fnGroup, $('div.workflow-py-toolbox-group-title', {}, 'Insert:'));
		const fnChipsWrap = append(fnGroup, $('div.workflow-py-toolbox-chips'));

		const insertItems: Array<{ label: string; snippet: string; isExpr?: boolean; cursorToken?: string }> = [
			{ label: 'RUN_TICKETS', snippet: 'res = RUN_TICKETS(ticket="", params={})', cursorToken: 'ticket="' },
			{ label: 'CREATE_TICKETS', snippet: 'new_ticket = CREATE_TICKETS(ticket_type="Task", title="", path=".", params={})', cursorToken: 'title="' },
			{ label: 'GET_TICKETS', snippet: 'tickets = GET_TICKETS(ticket="")', cursorToken: 'ticket="' },
			{ label: 'GET_OUTPUTS', snippet: 'out = GET_OUTPUTS(ticket="")', cursorToken: 'ticket="' },
			{ label: 'DISPLAY', snippet: 'DISPLAY()', cursorToken: 'DISPLAY(' },
			{ label: 'DATE()', snippet: 'DATE()', isExpr: true },
			{ label: 'NOW()', snippet: 'NOW()', isExpr: true },
			{ label: 'TIME()', snippet: 'TIME()', isExpr: true },
			{ label: 'var = 0', snippet: 'start_offset = 0', cursorToken: 'start_offset' },
			{ label: 'var = []', snippet: 'my_positions = []', cursorToken: 'my_positions' },
			{ label: 'var = {}', snippet: 'data = {}', cursorToken: 'data' },
			{ label: 'for ...:', snippet: 'for item in items:\n    pass', cursorToken: 'item' },
			{ label: 'if ...:', snippet: 'if condition:\n    pass', cursorToken: 'condition' },
			{ label: 'def ...:', snippet: 'def helper(x):\n    return x', cursorToken: 'helper' },
			{ label: 'class ...:', snippet: 'class Record:\n    def __init__(self, name):\n        self.name = name', cursorToken: 'Record' }
		];

		for (const item of insertItems) {
			const chip = append(fnChipsWrap, $('div.node-function-template-chip'));
			chip.textContent = item.label;
			chip.title = `Insert ${item.label} into active cell`;
			chip.onmousedown = (e) => {
				e.preventDefault();
				e.stopPropagation();
				this._insertIntoActiveCell(item.snippet, item.isExpr, item.cursorToken);
			};
		}

		const varGroup = append(tbBody, $('div.workflow-py-toolbox-group'));
		append(varGroup, $('div.workflow-py-toolbox-group-title', {}, 'Variables:'));
		this._varChipsWrap = append(varGroup, $('div.workflow-py-toolbox-chips'));

		// 2. Main Notebook Content Area
		const mainArea = append(this._rootContainer, $('div.workflow-notebook-main'));

		// Top Sticky Jupyter Toolbar
		const topBar = append(mainArea, $('div.workflow-notebook-topbar'));
		const topBarLeft = append(topBar, $('div.workflow-notebook-topbar-left'));

		const nbBadge = append(topBarLeft, $('div.workflow-notebook-title-badge'));
		append(nbBadge, $('span' + ThemeIcon.asCSSSelector(Codicon.notebook)));
		append(nbBadge, $('span.nb-title-text', {}, `${this._workflowName}`));
		append(nbBadge, $('span.nb-sub-tag', {}, 'Jupyter Notebook'));

		// Action buttons in top bar
		const actionsWrap = append(topBarLeft, $('div.workflow-notebook-toolbar-actions'));

		const addCellTopBtn = append(actionsWrap, $('button.nb-toolbar-btn'));
		append(addCellTopBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.add)));
		append(addCellTopBtn, $('span', {}, 'Code'));
		addCellTopBtn.title = 'Add a new Python code cell to the active node';
		addCellTopBtn.onclick = () => {
			const targetSec = this._activeCellInfo?.section || this._nodeSections[0];
			if (targetSec) {
				const afterIdx = this._activeCellInfo?.cell ? targetSec.cells.indexOf(this._activeCellInfo.cell) : targetSec.cells.length - 1;
				this._addStepCell(targetSec, afterIdx);
			}
		};

		const runActiveBtn = append(actionsWrap, $('button.nb-toolbar-btn'));
		append(runActiveBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.play)));
		append(runActiveBtn, $('span', {}, 'Run'));
		runActiveBtn.title = 'Run selected cell (Shift+Enter)';
		runActiveBtn.onclick = () => {
			if (this._activeCellInfo?.section && this._activeCellInfo?.cell) {
				this._runSingleStepCell(this._activeCellInfo.section, this._activeCellInfo.cell, true);
			} else if (this._activeCellInfo?.conn) {
				this._runConnectionConditionCell(this._activeCellInfo.conn);
			} else if (this._nodeSections.length > 0 && this._nodeSections[0].cells.length > 0) {
				this._runSingleStepCell(this._nodeSections[0], this._nodeSections[0].cells[0], false);
			}
		};

		const runAllBtn = append(actionsWrap, $('button.nb-toolbar-btn.primary-run'));
		append(runAllBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.runAll)));
		append(runAllBtn, $('span', {}, 'Run All'));
		runAllBtn.title = 'Execute all cells in the notebook sequentially';
		runAllBtn.onclick = () => this._runAllCells();

		const stopBtn = append(actionsWrap, $('button.nb-toolbar-btn'));
		append(stopBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.debugStop)));
		append(stopBtn, $('span', {}, 'Stop'));
		stopBtn.title = 'Stop running cell / loop and terminate background tasks';
		stopBtn.onclick = async () => {
			this._isStoppingNotebook = true;
			this._setKernelBusy(true, 'Stopping...');
			try {
				if (this._workflowUri) {
					const activeRun = this._workflowExecutionService.getActiveRun(this._workflowUri);
					if (activeRun && (activeRun.status === 'running' || activeRun.status === 'waiting_human' || activeRun.status === 'paused')) {
						await this._workflowExecutionService.stopWorkflow(activeRun.runId);
					}
					await this._workflowExecutionService.restartNotebookKernel(this._workflowUri);
				} else {
					await this._ticketRuntimeService.cancelAllActiveOperations('Notebook execution stopped by user');
				}
			} finally {
				for (const sec of this._nodeSections) {
					for (const c of sec.cells) {
						c.isRunning = false;
						c.cellRootEl?.classList.remove('running');
						if (c.promptEl && c.promptEl.textContent === 'In [*]:') {
							c.promptEl.textContent = `In [${c.executionCount !== null ? c.executionCount : ' '}]:`;
						}
					}
				}
				this._setKernelBusy(false, 'Stopped');
			}
		};

		const restartBtn = append(actionsWrap, $('button.nb-toolbar-btn'));
		append(restartBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.debugRestart)));
		append(restartBtn, $('span', {}, 'Restart'));
		restartBtn.title = 'Restart persistent Python kernel and reset variables';
		restartBtn.onclick = async () => {
			if (!this._workflowUri) {
				return;
			}
			this._isStoppingNotebook = true;
			this._setKernelBusy(true, 'Restarting...');
			try {
				await this._workflowExecutionService.restartNotebookKernel(this._workflowUri);
				for (const sec of this._nodeSections) {
					for (const c of sec.cells) {
						c.executionCount = null;
						if (c.promptEl) {
							c.promptEl.textContent = 'In [ ]:';
						}
					}
				}
				this._notificationService.info('Notebook Python kernel restarted.');
			} finally {
				this._setKernelBusy(false, 'Idle');
			}
		};

		const clearOutBtn = append(actionsWrap, $('button.nb-toolbar-btn'));
		append(clearOutBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.clearAll)));
		append(clearOutBtn, $('span', {}, 'Clear All Outputs'));
		clearOutBtn.title = 'Clear all cell outputs';
		clearOutBtn.onclick = () => this._clearAllOutputs();

		const topBarRight = append(topBar, $('div.workflow-notebook-topbar-right'));

		const topSyncBtn = append(topBarRight, $('button.nb-toolbar-btn.accent-sync'));
		append(topSyncBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.sync)));
		append(topSyncBtn, $('span', {}, 'Sync to Workflow'));
		topSyncBtn.title = 'Synchronize all cells back to Workflow (Cmd/Ctrl+S)';
		topSyncBtn.onclick = () => this._syncNotebookToWorkflow();

		this._kernelBadgeEl = append(topBarRight, $('div.workflow-notebook-kernel-badge'));
		this._kernelStatusDot = append(this._kernelBadgeEl, $('span.nb-kernel-dot.idle'));
		this._kernelStatusText = append(this._kernelBadgeEl, $('span.nb-kernel-status', {}, 'Idle'));
		const isVenv = this._detectedPythonPath.includes('.venv') || this._detectedPythonPath.includes('venv');
		const shortPy = isVenv ? '.venv (Python)' : (this._detectedPythonPath.split('/').pop() || 'python3');
		append(this._kernelBadgeEl, $('span.nb-kernel-py', {}, `| ${shortPy}`));
		this._kernelBadgeEl.title = `Persistent Python Kernel: ${this._detectedPythonPath}`;

		// Scrollable Notebook Cells Canvas
		this._notebookScrollEl = append(mainArea, $('div.workflow-notebook-scroll-canvas'));
		const scrollEl = this._notebookScrollEl;
		const scrollKey = this._currentScrollKey;
		const markUserScroll = () => {
			this._userHasScrolledSinceRender = true;
			this._isRestoringScroll = false;
		};
		for (const evtName of ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const) {
			scrollEl.addEventListener(evtName, markUserScroll, { passive: true });
		}
		scrollEl.addEventListener('scroll', () => {
			if (this._isRestoringScroll || scrollEl.clientHeight <= 0 || !scrollKey) {
				return;
			}
			const top = scrollEl.scrollTop;
			WorkflowNotebookEditor._savedScrollByUri.set(scrollKey, top);
			try {
				this._storageService.store(`workflowNotebookEditor.scroll.${scrollKey}`, String(top), StorageScope.PROFILE, StorageTarget.MACHINE);
			} catch { }
		}, { passive: true });
		this._renderCellsList();
		this._refreshLiveVariables();
	}

	private _setKernelBusy(busy: boolean, label?: string): void {
		if (this._kernelStatusDot) {
			this._kernelStatusDot.className = `nb-kernel-dot ${busy ? 'busy' : 'idle'}`;
		}
		if (this._kernelStatusText) {
			this._kernelStatusText.textContent = label || (busy ? 'Busy' : 'Idle');
		}
	}

	private _renderCellsList(): void {
		if (!this._notebookScrollEl) {
			return;
		}
		clearNode(this._notebookScrollEl);

		const container = append(this._notebookScrollEl, $('div.workflow-notebook-cells-list'));

		// Render each Node Section and its Code Cells
		for (const sec of this._nodeSections) {
			const secEl = append(container, $('div.nb-node-section'));
			sec.sectionEl = secEl;

			// Node Section Header (Markdown-style banner)
			const secHeader = append(secEl, $('div.nb-node-section-header'));
			const leftMeta = append(secHeader, $('div.nb-node-header-left'));

			const idxBadge = append(leftMeta, $('span.nb-node-order-badge', {}, `Node #${sec.orderIndex}`));
			idxBadge.title = `Node ID: ${sec.nodeId}`;

			const titleInput = append(leftMeta, $('input.nb-node-title-input')) as HTMLInputElement;
			titleInput.type = 'text';
			titleInput.value = sec.title;
			titleInput.placeholder = 'Node Title';
			titleInput.title = 'Click to edit Node Title';
			titleInput.oninput = () => {
				sec.title = titleInput.value;
			};
			sec.titleInputEl = titleInput;

			const typeTag = append(leftMeta, $('span.nb-node-type-tag', {}, sec.nodeType));
			const countTag = append(leftMeta, $('span.nb-node-cell-count', {}, `${sec.cells.length} cell${sec.cells.length === 1 ? '' : 's'}`));

			const rightActions = append(secHeader, $('div.nb-node-header-actions'));

			const runNodeBtn = append(rightActions, $('button.nb-node-action-btn.run-node'));
			append(runNodeBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.runAll)));
			append(runNodeBtn, $('span', {}, 'Run Node'));
			runNodeBtn.title = `Execute all ${sec.cells.length} cell(s) in '${sec.title}'`;
			runNodeBtn.onclick = (e) => {
				e.stopPropagation();
				this._runNodeSection(sec);
			};

			const addStepBtn = append(rightActions, $('button.nb-node-action-btn'));
			append(addStepBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.add)));
			append(addStepBtn, $('span', {}, 'Add Cell'));
			addStepBtn.title = `Add a new Python step cell to '${sec.title}'`;
			addStepBtn.onclick = (e) => {
				e.stopPropagation();
				this._addStepCell(sec, sec.cells.length - 1);
				countTag.textContent = `${sec.cells.length} cell${sec.cells.length === 1 ? '' : 's'}`;
			};

			// Cells Container for this Node
			const cellsWrap = append(secEl, $('div.nb-node-cells-wrap'));
			sec.cells.forEach((cell, cellIdx) => {
				this._renderStepCellElement(cellsWrap, sec, cell, cellIdx);
			});
		}

		// Render Connection Branch Conditions Section
		if (this._connectionCells.length > 0) {
			const connSecEl = append(container, $('div.nb-node-section.nb-connections-section'));
			const connHeader = append(connSecEl, $('div.nb-node-section-header'));
			const leftMeta = append(connHeader, $('div.nb-node-header-left'));
			append(leftMeta, $('span.nb-node-order-badge.conn-badge', {}, 'Branch Conditions'));
			append(leftMeta, $('span.nb-conn-section-title', {}, 'Connection Routing & Decision Conditions'));
			append(leftMeta, $('span.nb-node-cell-count', {}, `${this._connectionCells.length} edge(s)`));

			const connCellsWrap = append(connSecEl, $('div.nb-node-cells-wrap'));
			for (const conn of this._connectionCells) {
				this._renderConnectionCellElement(connCellsWrap, conn);
			}
		}
	}

	private _renderStepCellElement(
		parent: HTMLElement,
		sec: INotebookNodeSectionModel,
		cell: INotebookStepCellModel,
		cellIdx: number
	): void {
		const isComponentComment = Boolean(parseComponentCommentAnchor(cell.code));
		const isBuiltinOrFlow = !isComponentComment && (
			/\b(RUN_TICKETS|CREATE_TICKETS|GET_TICKETS|GET_OUTPUTS|DISPLAY|PRINT|GET_PRIMITIVES_CATALOG)\s*\(/.test(cell.code)
			|| /^(?:for|while|if|elif|else|def|async\s+def|class|try|with|return|raise|import|from)\b/.test(cell.code.trim())
		);

		const cellEl = append(parent, $(`div.nb-code-cell.${isComponentComment ? 'cell-component-comment' : (isBuiltinOrFlow ? 'cell-fn' : 'cell-var')}`));
		if (isComponentComment) {
			cellEl.style.opacity = '0.88';
			cellEl.style.borderStyle = 'dashed';
		}
		cell.cellRootEl = cellEl;

		const inputRow = append(cellEl, $('div.nb-cell-input-row'));

		// Left Gutter: In [n]: + Run button
		const gutter = append(inputRow, $('div.nb-cell-gutter'));
		const runBtn = append(gutter, $('button.nb-cell-run-btn'));
		append(runBtn, $('span' + ThemeIcon.asCSSSelector(isComponentComment ? Codicon.lock : Codicon.play)));
		runBtn.title = isComponentComment
			? 'Non-Python Workflow Component (Read-Only reference in Notebook; managed in Workflow)'
			: 'Run Cell (Shift+Enter)';
		runBtn.disabled = isComponentComment;
		if (isComponentComment) {
			runBtn.style.opacity = '0.45';
			runBtn.style.cursor = 'default';
		}
		runBtn.onclick = (e) => {
			e.stopPropagation();
			if (!isComponentComment) {
				this._runSingleStepCell(sec, cell, false);
			}
		};

		const promptEl = append(gutter, $('span.nb-cell-prompt'));
		promptEl.textContent = isComponentComment
			? 'Comp:'
			: (cell.isRunning
				? 'In [*]:'
				: `In [${cell.executionCount !== null ? cell.executionCount : ' '}]:`);
		cell.promptEl = promptEl;

		// Editor Box
		const editorWrap = append(inputRow, $('div.nb-cell-editor-wrap'));

		// Floating cell action bar (top-right inside cell)
		const cellActions = append(editorWrap, $('div.nb-cell-action-bar'));

		const stepTag = append(
			cellActions,
			$('span.nb-cell-step-tag', {}, isComponentComment ? `Step #${cellIdx + 1} • Workflow Component (Read-Only)` : `Step #${cellIdx + 1}`)
		);

		const moveUpBtn = append(cellActions, $('button.nb-cell-icon-btn'));
		append(moveUpBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowUp)));
		moveUpBtn.title = isComponentComment ? 'Component position is managed in Workflow' : 'Move Cell Up';
		moveUpBtn.disabled = isComponentComment || cellIdx === 0;
		moveUpBtn.onclick = (e) => {
			e.stopPropagation();
			if (!isComponentComment && cellIdx > 0) {
				this._syncTextareaValuesToModel();
				const tmp = sec.cells[cellIdx - 1];
				sec.cells[cellIdx - 1] = sec.cells[cellIdx];
				sec.cells[cellIdx] = tmp;
				this._renderCellsList();
			}
		};

		const moveDownBtn = append(cellActions, $('button.nb-cell-icon-btn'));
		append(moveDownBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowDown)));
		moveDownBtn.title = isComponentComment ? 'Component position is managed in Workflow' : 'Move Cell Down';
		moveDownBtn.disabled = isComponentComment || cellIdx === sec.cells.length - 1;
		moveDownBtn.onclick = (e) => {
			e.stopPropagation();
			if (!isComponentComment && cellIdx < sec.cells.length - 1) {
				this._syncTextareaValuesToModel();
				const tmp = sec.cells[cellIdx + 1];
				sec.cells[cellIdx + 1] = sec.cells[cellIdx];
				sec.cells[cellIdx] = tmp;
				this._renderCellsList();
			}
		};

		const insertBelowBtn = append(cellActions, $('button.nb-cell-icon-btn'));
		append(insertBelowBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.add)));
		insertBelowBtn.title = 'Insert Python Code Cell Below';
		insertBelowBtn.onclick = (e) => {
			e.stopPropagation();
			this._addStepCell(sec, cellIdx);
		};

		if (!isComponentComment) {
			const deleteCellBtn = append(cellActions, $('button.nb-cell-icon-btn.danger'));
			append(deleteCellBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
			deleteCellBtn.title = 'Delete Cell';
			deleteCellBtn.onclick = (e) => {
				e.stopPropagation();
				this._syncTextareaValuesToModel();
				if (sec.cells.length <= 1) {
					sec.cells[0].code = '';
					sec.cells[0].lastResult = undefined;
					sec.cells[0].executionCount = null;
				} else {
					sec.cells.splice(cellIdx, 1);
				}
				this._renderCellsList();
				this._refreshLiveVariables();
			};
		}

		const textarea = append(editorWrap, $('textarea.nb-cell-textarea')) as HTMLTextAreaElement;
		textarea.value = cell.code;
		textarea.placeholder = '# Enter Python step code... (Shift+Enter to run, Cmd/Ctrl+S to sync)';
		textarea.spellcheck = false;
		if (isComponentComment) {
			textarea.readOnly = true;
			textarea.style.color = '#94a3b8';
			textarea.style.fontStyle = 'italic';
			textarea.style.cursor = 'default';
		}
		cell.textareaEl = textarea;

		const autoResize = () => {
			textarea.style.height = 'auto';
			const lineCount = (textarea.value.split('\n').length);
			const minH = Math.max(36, lineCount * 20 + 14);
			textarea.style.height = `${Math.max(minH, textarea.scrollHeight)}px`;
		};

		textarea.addEventListener('focus', () => {
			this._activeTextarea = textarea;
			this._activeCellInfo = { section: sec, cell };
			this._activeCodeCellEl?.classList.remove('active');
			this._activeCodeCellEl = cellEl;
			cellEl.classList.add('active');
		});

		textarea.addEventListener('input', () => {
			cell.code = textarea.value;
			const nowBuiltin = /\b(RUN_TICKETS|CREATE_TICKETS|GET_TICKETS|GET_OUTPUTS|DISPLAY|PRINT|GET_PRIMITIVES_CATALOG)\s*\(/.test(cell.code)
				|| /^(?:for|while|if|elif|else|def|async\s+def|class|try|with|return|raise|import|from)\b/.test(cell.code.trim());
			cellEl.classList.toggle('cell-fn', nowBuiltin);
			cellEl.classList.toggle('cell-var', !nowBuiltin);
			autoResize();
			this._refreshLiveVariables();
		});

		textarea.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && e.shiftKey) {
				e.preventDefault();
				e.stopPropagation();
				this._runSingleStepCell(sec, cell, true);
				return;
			}
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				e.stopPropagation();
				this._runSingleStepCell(sec, cell, false);
				return;
			}
			if (e.key === 'Tab') {
				e.preventDefault();
				const start = textarea.selectionStart;
				const end = textarea.selectionEnd;
				textarea.value = textarea.value.substring(0, start) + '    ' + textarea.value.substring(end);
				textarea.selectionStart = textarea.selectionEnd = start + 4;
				cell.code = textarea.value;
				autoResize();
			}
		});

		setTimeout(autoResize, 0);

		// Output Row (Out [n]:)
		const outputContainer = append(cellEl, $('div.nb-cell-output-container'));
		cell.outputContainerEl = outputContainer;
		if (cell.lastResult) {
			this._renderCellOutput(outputContainer, cell.lastResult);
		} else {
			outputContainer.style.display = 'none';
		}

		// Keep stepTag used
		void stepTag;
	}

	private _renderConnectionCellElement(parent: HTMLElement, conn: INotebookConnectionCellModel): void {
		const cellEl = append(parent, $('div.nb-code-cell.cell-conn'));
		const inputRow = append(cellEl, $('div.nb-cell-input-row'));

		const gutter = append(inputRow, $('div.nb-cell-gutter'));
		const runBtn = append(gutter, $('button.nb-cell-run-btn'));
		append(runBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.play)));
		runBtn.title = 'Evaluate Condition in Kernel (Shift+Enter)';
		runBtn.onclick = (e) => {
			e.stopPropagation();
			this._runConnectionConditionCell(conn);
		};

		const promptEl = append(gutter, $('span.nb-cell-prompt'));
		promptEl.textContent = conn.isRunning
			? 'If [*]:'
			: `If [${conn.executionCount !== null ? conn.executionCount : ' '}]:`;
		conn.promptEl = promptEl;

		const editorWrap = append(inputRow, $('div.nb-cell-editor-wrap'));
		const connBanner = append(editorWrap, $('div.nb-conn-cell-banner'));
		append(connBanner, $('span.nb-conn-route', {}, `${conn.title}`));
		append(connBanner, $('span.nb-conn-id', {}, `(${conn.fromNodeId} → ${conn.toNodeId})`));

		const textarea = append(editorWrap, $('textarea.nb-cell-textarea.conn-textarea')) as HTMLTextAreaElement;
		textarea.value = conn.conditionCode;
		textarea.placeholder = '# Unconditional connection (enter boolean expression e.g. start_offset < start_offset_max)';
		textarea.spellcheck = false;
		conn.textareaEl = textarea;

		const autoResize = () => {
			textarea.style.height = 'auto';
			const lineCount = textarea.value.split('\n').length;
			textarea.style.height = `${Math.max(34, lineCount * 20 + 12)}px`;
		};

		textarea.addEventListener('focus', () => {
			this._activeTextarea = textarea;
			this._activeCellInfo = { conn };
			this._activeCodeCellEl?.classList.remove('active');
			this._activeCodeCellEl = cellEl;
			cellEl.classList.add('active');
		});

		textarea.addEventListener('input', () => {
			conn.conditionCode = textarea.value;
			autoResize();
			this._refreshLiveVariables();
		});

		textarea.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && (e.shiftKey || e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				e.stopPropagation();
				this._runConnectionConditionCell(conn);
			}
		});

		setTimeout(autoResize, 0);

		const outputContainer = append(cellEl, $('div.nb-cell-output-container'));
		conn.outputContainerEl = outputContainer;
		if (conn.lastResult) {
			this._renderCellOutput(outputContainer, conn.lastResult);
		} else {
			outputContainer.style.display = 'none';
		}
	}

	private _renderCellOutput(container: HTMLElement, res: INotebookCellExecutionResult): void {
		clearNode(container);
		container.style.display = 'flex';

		const outGutter = append(container, $('div.nb-output-gutter'));
		const outPrompt = append(outGutter, $(`span.nb-output-prompt.${res.ok ? 'ok' : 'err'}`));
		outPrompt.textContent = `Out[${res.executionCount}]:`;

		const outBody = append(container, $('div.nb-output-body'));

		// Header meta row inside output
		const outMeta = append(outBody, $('div.nb-output-meta-bar'));
		const statusSpan = append(outMeta, $(`span.nb-output-status.${res.ok ? 'ok' : 'err'}`));
		statusSpan.textContent = res.ok ? `✓ Executed in ${res.durationMs}ms` : `\u2715 Error (${res.durationMs}ms)`;

		const outActions = append(outMeta, $('div.nb-output-actions'));
		const clearBtn = append(outActions, $('button.nb-output-action-btn', {}, '\u2715'));
		clearBtn.title = 'Clear this output';
		clearBtn.onclick = () => {
			clearNode(container);
			container.style.display = 'none';
		};

		if (!res.ok && res.error) {
			const errPre = append(outBody, $('pre.nb-output-pre.error'));
			errPre.textContent = res.error;
			return;
		}

		let hasRenderedBlock = false;

		if (res.stdout && res.stdout.trim()) {
			const stdPre = append(outBody, $('pre.nb-output-pre.stdout'));
			stdPre.textContent = res.stdout;
			hasRenderedBlock = true;
		}

		if (res.displayCards && res.displayCards.length > 0) {
			for (const card of res.displayCards) {
				const cardBox = append(outBody, $('div.nb-output-display-card'));
				const cardTitle = append(cardBox, $('div.nb-output-display-header', {}, `DISPLAY: ${card.expression}`));
				void cardTitle;
				const cardPre = append(cardBox, $('pre.nb-output-pre.display'));
				cardPre.textContent = card.formattedText;
				hasRenderedBlock = true;
			}
		}

		if (res.value !== undefined && res.value !== null) {
			const valPre = append(outBody, $('pre.nb-output-pre.value'));
			if (isWorkflowRecord(res.value) && res.value.__assignedVar) {
				const vName = res.value.__assignedVar;
				const vVal = res.value.value;
				const formatted = typeof vVal === 'object' ? JSON.stringify(vVal, null, 2) : String(vVal);
				valPre.textContent = `${vName} = ${formatted}`;
			} else {
				valPre.textContent = typeof res.value === 'object' ? JSON.stringify(res.value, null, 2) : String(res.value);
			}
			hasRenderedBlock = true;
		}

		if (!hasRenderedBlock) {
			const emptyHint = append(outBody, $('div.nb-output-empty-ok', {}, 'Statement completed with no return value.'));
			void emptyHint;
		}
	}

	private _syncTextareaValuesToModel(): void {
		for (const sec of this._nodeSections) {
			if (sec.titleInputEl) {
				sec.title = sec.titleInputEl.value;
			}
			for (const c of sec.cells) {
				if (c.textareaEl) {
					c.code = c.textareaEl.value;
				}
			}
		}
		for (const conn of this._connectionCells) {
			if (conn.textareaEl) {
				conn.conditionCode = conn.textareaEl.value;
			}
		}
	}

	private _addStepCell(sec: INotebookNodeSectionModel, afterIndex: number): void {
		this._syncTextareaValuesToModel();
		const newCell: INotebookStepCellModel = {
			cellId: `${sec.nodeId}_cell_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
			code: '',
			executionCount: null,
			isRunning: false
		};
		const insertPos = Math.max(0, Math.min(sec.cells.length, afterIndex + 1));
		sec.cells.splice(insertPos, 0, newCell);
		this._renderCellsList();
		setTimeout(() => {
			newCell.textareaEl?.focus();
		}, 30);
	}

	private async _runSingleStepCell(
		sec: INotebookNodeSectionModel,
		cell: INotebookStepCellModel,
		advanceFocus: boolean
	): Promise<void> {
		if (!this._workflowUri) {
			return;
		}
		this._syncTextareaValuesToModel();
		const code = (cell.code || '').trim();
		if (!code || parseComponentCommentAnchor(code)) {
			return;
		}

		cell.isRunning = true;
		if (cell.promptEl) {
			cell.promptEl.textContent = 'In [*]:';
		}
		cell.cellRootEl?.classList.add('running');
		this._setKernelBusy(true, `Running ${sec.title}...`);

		try {
			const res = await this._workflowExecutionService.executeNotebookCell(this._workflowUri, code, {
				nodeId: sec.nodeId,
				nodeLabel: sec.title,
				pythonPath: this._pythonPath || this._detectedPythonPath,
				mode: 'exec'
			});
			cell.isRunning = false;
			cell.executionCount = res.executionCount;
			cell.lastResult = res;
			if (cell.promptEl) {
				cell.promptEl.textContent = `In [${res.executionCount}]:`;
			}
			if (cell.outputContainerEl) {
				this._renderCellOutput(cell.outputContainerEl, res);
			}
		} finally {
			cell.isRunning = false;
			cell.cellRootEl?.classList.remove('running');
			this._setKernelBusy(false, 'Idle');
		}

		if (advanceFocus) {
			const idx = sec.cells.indexOf(cell);
			if (idx >= 0 && idx + 1 < sec.cells.length) {
				sec.cells[idx + 1].textareaEl?.focus();
			} else {
				const secIdx = this._nodeSections.indexOf(sec);
				if (secIdx >= 0 && secIdx + 1 < this._nodeSections.length) {
					const nextSec = this._nodeSections[secIdx + 1];
					if (nextSec.cells.length > 0) {
						nextSec.cells[0].textareaEl?.focus();
					}
				}
			}
		}
	}

	private async _runConnectionConditionCell(conn: INotebookConnectionCellModel): Promise<void> {
		if (!this._workflowUri) {
			return;
		}
		this._syncTextareaValuesToModel();
		const cond = (conn.conditionCode || '').trim();
		if (!cond || cond.startsWith('#')) {
			return;
		}

		conn.isRunning = true;
		if (conn.promptEl) {
			conn.promptEl.textContent = 'If [*]:';
		}
		this._setKernelBusy(true, 'Evaluating condition...');

		try {
			const res = await this._workflowExecutionService.executeNotebookCell(this._workflowUri, `bool(${cond})`, {
				nodeId: conn.connectionId,
				nodeLabel: conn.title,
				pythonPath: this._pythonPath || this._detectedPythonPath,
				mode: 'eval'
			});
			conn.isRunning = false;
			conn.executionCount = res.executionCount;
			conn.lastResult = res;
			if (conn.promptEl) {
				conn.promptEl.textContent = `If [${res.executionCount}]:`;
			}
			if (conn.outputContainerEl) {
				this._renderCellOutput(conn.outputContainerEl, res);
			}
		} finally {
			conn.isRunning = false;
			this._setKernelBusy(false, 'Idle');
		}
	}

	private async _runNodeSection(sec: INotebookNodeSectionModel): Promise<void> {
		this._isStoppingNotebook = false;
		for (const cell of sec.cells) {
			if (this._isStoppingNotebook) {
				break;
			}
			const code = (cell.textareaEl ? cell.textareaEl.value : cell.code).trim();
			if (!code || parseComponentCommentAnchor(code)) {
				continue;
			}
			await this._runSingleStepCell(sec, cell, false);
			if (this._isStoppingNotebook || (cell.lastResult && !cell.lastResult.ok)) {
				break;
			}
		}
	}

	private async _runAllCells(): Promise<void> {
		this._isStoppingNotebook = false;
		for (const sec of this._nodeSections) {
			if (this._isStoppingNotebook) {
				break;
			}
			await this._runNodeSection(sec);
			const failed = sec.cells.some(c => c.lastResult && !c.lastResult.ok);
			if (this._isStoppingNotebook || failed) {
				break;
			}
		}
	}

	private _clearAllOutputs(): void {
		for (const sec of this._nodeSections) {
			for (const cell of sec.cells) {
				cell.lastResult = undefined;
				if (cell.outputContainerEl) {
					clearNode(cell.outputContainerEl);
					cell.outputContainerEl.style.display = 'none';
				}
			}
		}
		for (const conn of this._connectionCells) {
			conn.lastResult = undefined;
			if (conn.outputContainerEl) {
				clearNode(conn.outputContainerEl);
				conn.outputContainerEl.style.display = 'none';
			}
		}
	}

	private _insertIntoActiveCell(rawText: string, isExpr?: boolean, cursorToken?: string): void {
		let ta = this._activeTextarea;
		if (!ta || !ta.isConnected) {
			if (this._nodeSections.length > 0 && this._nodeSections[0].cells.length > 0) {
				ta = this._nodeSections[0].cells[0].textareaEl || null;
			}
		}
		if (!ta) {
			return;
		}

		const start = ta.selectionStart ?? ta.value.length;
		const end = ta.selectionEnd ?? ta.value.length;
		const before = ta.value.substring(0, start);
		const after = ta.value.substring(end);

		const currentLineStart = before.lastIndexOf('\n') + 1;
		const beforeOnLine = before.substring(currentLineStart);
		const doubleQuotes = (beforeOnLine.match(/(?<!\\)"/g) || []).length;
		const singleQuotes = (beforeOnLine.match(/(?<!\\)'/g) || []).length;
		const insideString = (doubleQuotes % 2 === 1) || (singleQuotes % 2 === 1);

		let toInsert = rawText;
		if (isExpr && insideString) {
			toInsert = `{${rawText}}`;
		} else if (!isExpr) {
			if (/=\s*$/.test(beforeOnLine)) {
				toInsert = toInsert.replace(/^[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*/, '');
			} else if (beforeOnLine.trim().length > 0 && !beforeOnLine.endsWith(' ')) {
				toInsert = `\n${toInsert}`;
			}
		}

		ta.value = before + toInsert + after;
		ta.dispatchEvent(new Event('input'));

		let newCursorPos = start + toInsert.length;
		if (cursorToken) {
			const tokenIdx = toInsert.indexOf(cursorToken);
			if (tokenIdx !== -1) {
				newCursorPos = start + tokenIdx + cursorToken.length;
			}
		}
		ta.focus();
		ta.setSelectionRange(newCursorPos, newCursorPos);
	}

	private _refreshLiveVariables(): void {
		if (!this._varChipsWrap) {
			return;
		}
		clearNode(this._varChipsWrap);
		const fullSource = this._buildPythonSourceFromNotebook();
		const vars = WorkflowPythonEditorBridge.extractPythonVariablesFromSource(fullSource);
		for (const vName of vars) {
			const chip = append(this._varChipsWrap, $('div.node-function-field-chip.standard'));
			chip.textContent = vName;
			chip.title = `Insert variable '${vName}' into active cell`;
			chip.onmousedown = (e) => {
				e.preventDefault();
				e.stopPropagation();
				this._insertIntoActiveCell(vName, true);
			};
		}
	}

	private async _syncNotebookToWorkflow(): Promise<boolean> {
		if (!this._workflowUri) {
			return false;
		}
		this._syncTextareaValuesToModel();
		const pythonSource = this._buildPythonSourceFromNotebook();
		const safeId = this._workflowId.replace(/[^a-zA-Z0-9_-]/g, '_');
		const pyFileUri = URI.joinPath(this._workflowUri, '.agents', `${safeId}.workflow.py`);
		const ipynbFileUri = URI.joinPath(this._workflowUri, '.agents', `${safeId}.workflow.ipynb`);

		try {
			await this._fileService.writeFile(pyFileUri, VSBuffer.fromString(pythonSource));
			await this._fileService.writeFile(ipynbFileUri, VSBuffer.fromString(this._buildIpynbJsonString()));
		} catch {
			// ignore disk write warning
		}

		const fakeEditor = {
			getModel: () => ({
				uri: pyFileUri,
				getValue: () => pythonSource
			})
		};

		return WorkflowPythonEditorBridge.syncPythonEditorToWorkflow(
			pyFileUri,
			fakeEditor,
			this._fileService,
			this._notificationService,
			this._entityPersistenceService,
			this._ticketRuntimeService
		);
	}

	override layout(dimension: Dimension): void {
		if (this._rootContainer) {
			this._rootContainer.style.width = `${dimension.width}px`;
			this._rootContainer.style.height = `${dimension.height}px`;
		}
	}
}

