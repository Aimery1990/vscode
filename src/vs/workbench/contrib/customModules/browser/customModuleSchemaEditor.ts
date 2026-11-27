/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, Dimension, getWindow, isHTMLElement } from '../../../../base/browser/dom.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { WorkflowEditorInput } from '../../workflowsManager/browser/workflowEditorInput.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEntityPersistenceService, ICustomModule, ICustomField, CustomFieldType, IVoiceNoteClip, ICompositeComponent, IStatusDefinition, DEFAULT_STATUS_DEFINITIONS, IOutputSpec, TableColumnDataType, ITableColumnDefinition, generateSmartPythonVarName, sanitizePythonVarName, CUSTOM_MODULE_ICON_LIBRARY, CUSTOM_MODULE_COLOR_PALETTE, getDefaultCustomModuleIconId, getDefaultCustomModuleColor, resolveCustomModuleIcon, MEDIA_PLAYER_SPEED_OPTIONS, MEDIA_PLAYER_ALL_EXTENSIONS, detectMediaFileInfo } from '../../entityPersistence/common/entityPersistence.js';
import { getPathForFile } from '../../../../platform/dnd/browser/dnd.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ICustomModulesService } from '../common/customModules.js';
import { CustomModuleSchemaEditorInput } from './customModuleSchemaEditorInput.js';
import { IRequestService, asText } from '../../../../platform/request/common/request.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { RequestChannelClient } from '../../../../platform/request/common/requestIpc.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';
import { FileAccess } from '../../../../base/common/network.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { isWindows } from '../../../../base/common/platform.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IWebContentExtractorService, WebContentExtractResult } from '../../../../platform/webContentExtractor/common/webContentExtractor.js';
import { maskSecrets, resolveBrowserCredentialUrl } from '../common/browserCredentials.js';
import { IAgentsManagerService, IAgentCredentialService, IAgentItem, IAgentCredential, isOpenAICompatibleProvider, getGlobalDefaultModel, resolveDefaultModel, resolveDefaultModelId } from '../../agentsManager/common/agentsManager.js';
import { showPrimitiveHelpModal } from './primitiveHelpGuide.js';
import { ITicketWorkflowRuntimeService, findUnresolvedTemplateVariables } from '../../workflowsManager/browser/ticketWorkflowRuntime.js';
import { renderHighlightedPythonToDOM, buildPythonLineNumbersText, isCommentKeybinding, togglePythonComment } from './pythonSyntaxHighlighter.js';
import { IVoiceModelService } from '../../voiceModels/common/voiceModel.js';
import { IMediaSubtitleSettingsWidget, renderMediaSubtitleSettings } from './mediaSubtitleSettings.js';
import { IMediaFileFacts } from '../../voiceModels/common/subtitleConfig.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { CodeWindow } from '../../../../base/browser/window.js';
import { clashesWithBuiltInTicketType } from '../common/templateNameClash.js';
import { checkTemplateCallCycle, renderSubWorkflowPickerRow, resolveSubWorkflowContract } from './subWorkflowTemplateCard.js';
import { IWorkflowExecutionService } from '../../workflowsManager/common/workflowExecutionService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { BASE_COMPONENT_PALETTE, IComponentPaletteItem, createComponentField, createCompositeComponentField } from '../common/componentPalette.js';
import { propagateComponentLabelRename } from '../common/componentSchemaEdits.js';


/**
 * Transient, in-memory execution state that the editor / workflow runtime attaches to a field.
 * It is not part of the persisted schema (it is stripped before saving).
 */
interface ICustomFieldRuntimeState {
	lastSentPrompt?: string;
	lastExecutionLog?: string;
	lastExecutionOutput?: unknown;
	lastExecutionInputs?: Record<string, unknown>;
	lastExecutionStatus?: string;
	lastExecutionDurationMs?: number;
	lastExecutionExitCode?: number;
	lastExecutedAt?: string;
	lastQueryRows?: Record<string, unknown>[];
	previousLabels?: string[];
	pythonLocked?: boolean;
	pythonStructuredData?: unknown;
	structuredData?: unknown;
	debugOutput?: string;
}

type IRuntimeCustomField = ICustomField & ICustomFieldRuntimeState;

/** A table column as returned by the SQLite inspection APIs or stored in (possibly legacy) YAML. */
interface ILooseTableColumn {
	id?: string;
	name?: string;
	label?: string;
	dataType?: string;
	primaryKey?: boolean;
	nullable?: boolean;
	defaultValue?: unknown;
}

/** Electron (older versions) exposes the absolute file system path on dropped/picked `File` objects. */
type IFileWithLegacyPath = File & { path?: string };

interface ICopiedSchemaComponentEntry {
	field: ICustomField;
	sourceModuleName?: string;
	copiedAt: number;
}

/**
 * Maps a `.prompt-tokenized-display` element to the raw-text textarea that sits next to it in the same
 * wrapper. Used to copy the raw (token-preserving) text of a selection inside the display.
 */
const tokenizedDisplayTextareas = new WeakMap<HTMLElement, HTMLTextAreaElement>();

/** Instant tooltips currently shown by `CustomModuleSchemaEditor._attachInstantTooltip` (appended to the document body). */
const liveInstantTooltips = new Set<HTMLElement>();

/** Removes every instant tooltip created by this editor (also orphans whose target element was re-rendered while hovered). */
function removeAllInstantTooltips(): void {
	for (const el of liveInstantTooltips) {
		el.remove();
	}
	liveInstantTooltips.clear();
}

/** The "Sent Prompt Inspector" overlay currently shown (at most one at a time, shared by all editors). */
let activeSentPromptModalOverlay: HTMLElement | undefined;

let copiedSchemaComponentClipboard: ICopiedSchemaComponentEntry | null = null;
const copiedComponentListeners = new Set<() => void>();
let lastInteractedSchemaEditor: CustomModuleSchemaEditor | null = null;
let lastKeyboardPasteTimestamp = 0;
const savedSchemaScrollStateByKey = new Map<string, { mainScrollTop: number; toolboxScrollTop: number }>();

/** Large workflow variables are spilled out of the runtime context and replaced by a `{ __anyagentVarRef__: true, ... }` marker. */
function isSpilledVarRef(value: unknown): boolean {
	return !!value && typeof value === 'object' && (value as { __anyagentVarRef__?: unknown }).__anyagentVarRef__ === true;
}

/** Same as `key in obj`: also true for inherited properties. */
function hasPropertyIncludingInherited<K extends string>(obj: object, key: K): obj is Record<K, unknown> {
	return key in obj;
}

function notifyCopiedComponentChanged(): void {
	copiedComponentListeners.forEach(listener => {
		try {
			listener();
		} catch { }
	});
}

export class CustomModuleSchemaEditor extends EditorPane {
	static readonly ID = 'workbench.editor.customModuleSchema';

	private _container?: HTMLElement;
	private _activeModule?: ICustomModule;
	private _isToolboxCompact: boolean = false;
	private _workspaceUri?: URI;
	/** Last call-cycle error shown for this template (CI-38), so auto-save does not repeat it on every edit. */
	private _lastReportedCycleError: string | undefined;
	private _isSelfPersisting: boolean = false;
	private _renderCleanupFns: Array<() => void> = [];
	private _inputDraftSub?: { dispose(): void };
	private _currentScrollKey: string = '';
	private _isRestoringScroll: boolean = false;
	private _userHasScrolledSinceRender: boolean = false;
	/** Main scrollable viewport / left toolbox created by the last render (see `_getRenderedViewport`). */
	private _mainViewportEl?: HTMLElement;
	private _toolboxEl?: HTMLElement;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly _storageService: IStorageService,
		@ICustomModulesService private readonly customModulesService: ICustomModulesService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IRequestService private readonly _requestService: IRequestService,
		@ICommandService private readonly _commandService: ICommandService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@IEntityPersistenceService private readonly _entityPersistenceService: IEntityPersistenceService,
		@ITicketWorkflowRuntimeService private readonly _ticketWorkflowRuntimeService: ITicketWorkflowRuntimeService,
		@ILayoutService private readonly _layoutService: ILayoutService
	) {
		super(CustomModuleSchemaEditor.ID, group, telemetryService, themeService, _storageService);

		this._register(this.customModulesService.onDidChangeModules(async () => {
			if (this._isSelfPersisting || !this._activeModule || !this._container) {
				return;
			}
			if (this.input instanceof CustomModuleSchemaEditorInput && (this.input.isFlowchartNodeMode || this.input.embeddedFieldId)) {
				return;
			}
			try {
				const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);
				const allMods = await this.customModulesService.getCustomModules(wsUri);
				const updated = allMods.find(m => m.id.toLowerCase() === this._activeModule!.id.toLowerCase());
				if (updated && this.input instanceof CustomModuleSchemaEditorInput) {
					const prevViewport = this._getRenderedViewport(this._mainViewportEl);
					const prevScrollTop = prevViewport ? prevViewport.scrollTop : 0;
					this._activeModule = JSON.parse(JSON.stringify(updated));
					this.input.draftModule = this._activeModule;
					await this._loadAndRender(this.input);
					const nextViewport = this._getRenderedViewport(this._mainViewportEl);
					if (nextViewport) {
						nextViewport.scrollTop = prevScrollTop;
					}
				}
			} catch (err) {
				console.warn('[CustomModuleSchemaEditor] Failed to refresh on external module update:', err);
			}
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this._container = append(parent, $('.custom-module-schema-editor'));
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.overflow = 'hidden';
		this._container.style.boxSizing = 'border-box';
		this._container.style.background = 'var(--vscode-editor-background, #181818)';
		this._container.style.color = 'var(--vscode-editor-foreground, #e0e0e0)';
		this._container.style.fontFamily = 'var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif)';
		this._container.style.padding = '0';
		this._container.style.display = 'flex';
		this._container.style.flexDirection = 'row';
		this._container.style.userSelect = 'none';
		this._container.style.webkitUserSelect = 'none';

		const extractSelectedTextPreservingTokens = (): string => {
			const sel = getWindow(this._container).getSelection();
			if (!sel || sel.rangeCount === 0) {
				return '';
			}
			const range = sel.getRangeAt(0);
			const commonEl = (isHTMLElement(range.commonAncestorContainer)
				? range.commonAncestorContainer
				: range.commonAncestorContainer.parentElement) as HTMLElement | null;
			const displayEl = commonEl?.closest('.prompt-tokenized-display') as HTMLElement | null;
			if (displayEl && this._container && this._container.contains(displayEl)) {
				const ta = tokenizedDisplayTextareas.get(displayEl) ?? null;
				if (ta && typeof ta.value === 'string' && ta.value.length > 0) {
					const resolveRawOffset = (container: Node, offset: number, isEnd: boolean): number | undefined => {
						if (container === displayEl) {
							if (offset <= 0) {
								return 0;
							}
							if (offset >= displayEl.childNodes.length) {
								return ta.value.length;
							}
							const child = displayEl.childNodes[isEnd ? offset - 1 : offset] as HTMLElement | undefined;
							if (child && isHTMLElement(child)) {
								const attr = isEnd ? child.getAttribute('data-raw-end') : child.getAttribute('data-raw-start');
								if (attr !== null && !isNaN(Number(attr))) {
									return Number(attr);
								}
							}
							return undefined;
						}
						let node: Node | null = container;
						while (node && node !== displayEl) {
							if (isHTMLElement(node)) {
								if (node.classList.contains('prompt-token-pill')) {
									const rawPos = Number(node.getAttribute(isEnd ? 'data-raw-end' : 'data-raw-start'));
									return !isNaN(rawPos) ? rawPos : undefined;
								}
								if (node.classList.contains('prompt-raw-segment')) {
									const segStart = Number(node.getAttribute('data-raw-start'));
									if (!isNaN(segStart)) {
										return segStart + offset;
									}
								}
							}
							node = node.parentNode;
						}
						return undefined;
					};
					const rawStart = resolveRawOffset(range.startContainer, range.startOffset, false);
					const rawEnd = resolveRawOffset(range.endContainer, range.endOffset, true);
					if (typeof rawStart === 'number' && typeof rawEnd === 'number' && rawEnd > rawStart) {
						return ta.value.substring(rawStart, rawEnd);
					}
				}
			}
			return sel.toString();
		};

		this._container.addEventListener('keydown', (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c') {
				const activeEl = getWindow(this._container).document.activeElement as HTMLElement | null;
				if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
					const inputEl = activeEl as HTMLInputElement | HTMLTextAreaElement;
					if (typeof inputEl.selectionStart === 'number' && typeof inputEl.selectionEnd === 'number' && inputEl.selectionStart !== inputEl.selectionEnd) {
						return;
					}
				}
				const sel = getWindow(this._container).getSelection();
				const selectedText = extractSelectedTextPreservingTokens();
				if (selectedText && this._container && sel?.anchorNode && this._container.contains(sel.anchorNode)) {
					e.stopPropagation();
					this._clipboardService.writeText(selectedText);
				}
			}
		});

		this._container.addEventListener('copy', (e: ClipboardEvent) => {
			const activeEl = getWindow(this._container).document.activeElement as HTMLElement | null;
			if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
				return;
			}
			const sel = getWindow(this._container).getSelection();
			const selectedText = extractSelectedTextPreservingTokens();
			if (selectedText && this._container && sel?.anchorNode && this._container.contains(sel.anchorNode)) {
				if (e.clipboardData) {
					e.clipboardData.setData('text/plain', selectedText);
					e.preventDefault();
				}
				this._clipboardService.writeText(selectedText);
			}
		});
	}

	override layout(dimension: Dimension): void {
		// Native layout in _container automatically fills dimension
	}

	override async setInput(input: CustomModuleSchemaEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		this._inputDraftSub?.dispose();
		this._inputDraftSub = undefined;
		await super.setInput(input, options, context, token);
		this._inputDraftSub = input.onDidUpdateExternalDraft(async (focusFieldId) => {
			if (input.draftModule) {
				this._activeModule = input.draftModule;
			}
			await this._loadAndRender(input, focusFieldId);
		});
		await this._loadAndRender(input, input.focusFieldId);
	}

	private _disposeRenderCleanupFns(): void {
		while (this._renderCleanupFns.length > 0) {
			const fn = this._renderCleanupFns.pop();
			try {
				fn?.();
			} catch { }
		}
	}

	private _getScrollStateKey(input?: CustomModuleSchemaEditorInput): string {
		const targetInput = input || (this.input instanceof CustomModuleSchemaEditorInput ? this.input : undefined);
		if (targetInput?.embeddedFieldId) {
			// An embedded component editor is short-lived: its scroll position is not remembered
			return '';
		}
		const modId = (targetInput?.moduleId || this._activeModule?.id || '').trim().toLowerCase();
		const wsKey = targetInput?.workspaceUri?.toString() || this._workspaceUri?.toString() || 'global';
		return modId ? `${wsKey}::${modId}` : '';
	}

	private _saveCurrentScrollPosition(): void {
		if (!this._container || this._isRestoringScroll || !this._currentScrollKey) {
			return;
		}
		const mainViewport = this._getRenderedViewport(this._mainViewportEl);
		const leftLibrary = this._getRenderedViewport(this._toolboxEl);
		if (!mainViewport || mainViewport.clientHeight <= 0) {
			return;
		}
		const prev = savedSchemaScrollStateByKey.get(this._currentScrollKey) || { mainScrollTop: 0, toolboxScrollTop: 0 };
		const nextState = {
			mainScrollTop: mainViewport.scrollTop,
			toolboxScrollTop: leftLibrary && leftLibrary.clientHeight > 0 ? leftLibrary.scrollTop : prev.toolboxScrollTop
		};
		savedSchemaScrollStateByKey.set(this._currentScrollKey, nextState);
		try {
			this._storageService.store(`customModuleSchemaEditor.scroll.${this._currentScrollKey}`, JSON.stringify(nextState), StorageScope.PROFILE, StorageTarget.MACHINE);
		} catch { }
	}

	/**
	 * Returns the given element created by the last render if it is still attached inside the editor container
	 * (i.e. it has not been removed by a subsequent `clearNode`), otherwise `null`.
	 */
	private _getRenderedViewport(el: HTMLElement | undefined): HTMLElement | null {
		return el && this._container && this._container !== el && this._container.contains(el) ? el : null;
	}

	private _getSavedScrollState(scrollKey: string): { mainScrollTop: number; toolboxScrollTop: number } | undefined {
		if (!scrollKey) {
			return undefined;
		}
		const cached = savedSchemaScrollStateByKey.get(scrollKey);
		if (cached) {
			return cached;
		}
		try {
			const raw = this._storageService.get(`customModuleSchemaEditor.scroll.${scrollKey}`, StorageScope.PROFILE);
			if (raw) {
				const parsed = JSON.parse(raw);
				if (typeof parsed?.mainScrollTop === 'number') {
					const loaded = {
						mainScrollTop: Math.max(0, parsed.mainScrollTop),
						toolboxScrollTop: Math.max(0, Number(parsed.toolboxScrollTop) || 0)
					};
					savedSchemaScrollStateByKey.set(scrollKey, loaded);
					return loaded;
				}
			}
		} catch { }
		return undefined;
	}

	override clearInput(): void {
		this._inputDraftSub?.dispose();
		this._inputDraftSub = undefined;
		this._saveCurrentScrollPosition();
		this._disposeRenderCleanupFns();
		if (lastInteractedSchemaEditor === this) {
			lastInteractedSchemaEditor = null;
		}
		this._syncDraft();
		if (this._container) {
			clearNode(this._container);
		}
		this._activeModule = undefined;
		super.clearInput();
	}

	override dispose(): void {
		this._inputDraftSub?.dispose();
		this._inputDraftSub = undefined;
		this._disposeRenderCleanupFns();
		if (lastInteractedSchemaEditor === this) {
			lastInteractedSchemaEditor = null;
		}
		if (this._container) {
			clearNode(this._container);
			this._container = undefined;
		}
		super.dispose();
	}

	private _parseInputStringLiteral(val: unknown): unknown {
		if (typeof val !== 'string') {
			return val;
		}
		const trimmed = val.trim();
		if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
			try {
				const parsed = JSON.parse(trimmed);
				if (typeof parsed === 'string') {
					return parsed;
				}
			} catch {
				// Keep original if not a valid single quoted string literal
			}
		}
		if (trimmed.length >= 2 && trimmed.startsWith('\'') && trimmed.endsWith('\'')) {
			const inner = trimmed.slice(1, -1);
			if (!/(^|[^\\])'/.test(inner)) {
				return inner.replace(/\\'/g, '\'').replace(/\\\\/g, '\\');
			}
		}
		return val;
	}

	private _syncDraft(immediate: boolean = false): void {
		if (this.input instanceof CustomModuleSchemaEditorInput && this._activeModule) {
			this.input.draftModule = this._activeModule;
			if (this.input.isFlowchartNodeMode && this.input.onNodeFieldsChange) {
				const nodeFields = (this._activeModule.fields || []).filter(f => f && f.id !== 'title');
				this.input.onNodeFieldsChange(nodeFields, immediate);
			}
		}
	}

	private async _persistCurrentModule(): Promise<void> {
		if (!this._activeModule) {
			return;
		}
		this._syncDraft();
		if (this.input instanceof CustomModuleSchemaEditorInput && (this.input.isFlowchartNodeMode || this.input.embeddedFieldId)) {
			// Node components are written back by the workflow; an embedded component editor's host saves `draftModule`
			return;
		}
		const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);
		try {
			this._isSelfPersisting = true;
			const moduleToSave: ICustomModule = JSON.parse(JSON.stringify(this._activeModule));
			if (Array.isArray(moduleToSave.fields)) {
				moduleToSave.fields = moduleToSave.fields.filter(f => f && typeof f === 'object' && !Array.isArray(f));
				for (const f of moduleToSave.fields) {
					delete (f as IRuntimeCustomField).lastSentPrompt;
					delete (f as IRuntimeCustomField).lastExecutionLog;
					delete (f as IRuntimeCustomField).lastExecutionOutput;
					delete (f as IRuntimeCustomField).lastExecutionStatus;
					delete (f as IRuntimeCustomField).lastExecutionDurationMs;
					delete (f as IRuntimeCustomField).lastExecutedAt;
					delete (f as IRuntimeCustomField).lastExecutionExitCode;
					delete f.pythonOutput;
					delete f.pythonResult;
					delete (f as IRuntimeCustomField).pythonStructuredData;
					delete (f as IRuntimeCustomField).structuredData;
					delete f.debugPromptOutput;
					delete f.debugSqlOutput;
					delete (f as IRuntimeCustomField).debugOutput;
					if (f.type === 'table' && (f.tableDbEngine || 'sqlite') === 'sqlite' && f.tableDbPath && f.tableDbPath.trim()) {
						// Never persist transient SQLite database rows or partial SELECT results into template .yaml files
						f.tableRows = [];
					}
				}
			}
			const currentModules = await this.customModulesService.getCustomModules(wsUri);
			const existingIndex = currentModules.findIndex(m => m.id.toLowerCase() === moduleToSave.id.toLowerCase());
			if (existingIndex !== -1) {
				currentModules[existingIndex] = moduleToSave;
			} else {
				currentModules.push(moduleToSave);
			}
			await this.customModulesService.saveCustomModules(currentModules, wsUri);
			// Recursion protection (CI-38): the template is saved (auto-save keeps every edit) but marked invalid: the
			// error names the call cycle and a ticket run of this template refuses to start until it is fixed
			const cycleError = await this._instantiationService.invokeFunction(accessor => checkTemplateCallCycle(accessor.get(IWorkflowExecutionService), moduleToSave, wsUri));
			if (cycleError && cycleError !== this._lastReportedCycleError) {
				this.notificationService.error(`Template '${moduleToSave.name}' is invalid: ${cycleError}`);
			}
			this._lastReportedCycleError = cycleError;
		} catch (e) {
			console.warn('[CustomModuleSchemaEditor] Failed to auto-persist schema module:', e);
		} finally {
			this._isSelfPersisting = false;
		}
	}

	private _renderSeq = 0;

	/**
	 * A workflow-node editor (`wf_node_*`) restored on start-up is only usable once its workflow canvas has loaded
	 * and re-bound it (the canvas supplies the node data and the write-back channel). Until then, show a placeholder
	 * instead of the generic module editor, so edits can neither get lost nor be saved as a stray custom module.
	 * Returns true when the placeholder was rendered.
	 */
	private _renderDetachedNodePlaceholder(input: CustomModuleSchemaEditorInput): boolean {
		if (!this._container || input.isFlowchartNodeMode || !input.moduleId.startsWith('wf_node_')) {
			return false;
		}
		this._disposeRenderCleanupFns();
		clearNode(this._container);
		const box = append(this._container, $('div', {
			style: 'display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; height: 100%; padding: 24px; box-sizing: border-box; text-align: center; color: var(--vscode-descriptionForeground);'
		}));
		append(box, $('div', { style: 'font-size: 14px; font-weight: 600; color: var(--vscode-foreground);' }, `Node: ${input.moduleName || input.moduleId}`));
		append(box, $('div', { style: 'font-size: 12px; max-width: 420px; line-height: 1.5;' },
			'This node editor reconnects automatically once its workflow canvas is open.'));
		const workflowUri = input.workspaceUri;
		if (workflowUri) {
			const btn = append(box, $('button', {
				style: 'padding: 6px 14px; border-radius: 6px; border: 1px solid rgba(45, 212, 191, 0.5); background: rgba(45, 212, 191, 0.12); color: #2dd4bf; cursor: pointer; font-size: 12px;'
			}, 'Open Workflow Canvas'));
			btn.onclick = async () => {
				const editorService = this._instantiationService.invokeFunction(accessor => accessor.get(IEditorService));
				const editorGroupsService = this._instantiationService.invokeFunction(accessor => accessor.get(IEditorGroupsService));
				const otherGroup = editorGroupsService.groups.find(g => g.id !== this.group.id);
				const workflowName = decodeURIComponent(workflowUri.path.replace(/\/+$/, '').split('/').pop() || 'Workflow');
				await editorService.openEditor(new WorkflowEditorInput(workflowUri, workflowName), { pinned: true }, otherGroup ? otherGroup.id : SIDE_GROUP);
			};
		}
		return true;
	}

	private async _loadAndRender(input: CustomModuleSchemaEditorInput, focusFieldId?: string): Promise<void> {
		if (!this._container) {
			return;
		}
		const seq = ++this._renderSeq;
		if (this._renderDetachedNodePlaceholder(input)) {
			return;
		}
		const isFlowchartNodeMode = Boolean(input.isFlowchartNodeMode);
		// Embedded single-component mode: only this component's configuration is shown (see `embeddedFieldId`)
		const embeddedFieldId = input.embeddedFieldId?.toLowerCase();
		const isEmbeddedFieldMode = Boolean(embeddedFieldId);
		this._saveCurrentScrollPosition();
		this._workspaceUri = input.workspaceUri;
		const allWorkspaceModules = await this.customModulesService.getCustomModules(input.workspaceUri);
		if (seq !== this._renderSeq || !this._container) {
			return;
		}
		this._disposeRenderCleanupFns();
		const scrollKey = this._getScrollStateKey(input);
		this._currentScrollKey = scrollKey;
		this._userHasScrolledSinceRender = false;
		this._isRestoringScroll = true;
		clearNode(this._container);

		if (input.draftModule) {
			this._activeModule = input.draftModule;
		} else {
			const found = allWorkspaceModules.find(m => m.id.toLowerCase() === input.moduleId.toLowerCase());

			if (found) {
				this._activeModule = JSON.parse(JSON.stringify(found));
			} else {
				const usedColors = new Set(allWorkspaceModules.map(m => (m.color || '').toLowerCase()).filter(Boolean));
				this._activeModule = {
					id: input.moduleId,
					name: input.moduleName || input.moduleId,
					icon: getDefaultCustomModuleIconId(input.moduleId),
					color: getDefaultCustomModuleColor(input.moduleName || input.moduleId, usedColors),
					storageScope: 'global',
					description: '',
					prompt: '',
					fields: []
				};
			}
			input.draftModule = this._activeModule;
		}

		const activeMod = this._activeModule!;
		if (typeof activeMod.description !== 'string') {
			activeMod.description = '';
		}
		if (typeof activeMod.prompt !== 'string') {
			activeMod.prompt = '';
		}
		if (!activeMod.icon) {
			activeMod.icon = getDefaultCustomModuleIconId(activeMod.id);
		}
		if (!activeMod.color) {
			activeMod.color = getDefaultCustomModuleColor(activeMod.name || activeMod.id);
		}
		const rawFields: ICustomField[] = (activeMod.fields ?? (activeMod.fields = [])).filter(
			(f): f is ICustomField => Boolean(f && typeof f === 'object' && !Array.isArray(f))
		);

		// Enforce only Title as mandatory root field at index 0 (Description is optional)
		let titleField = rawFields.find(f => f.id === 'title' || f.label?.toLowerCase() === 'title');
		if (!titleField) {
			titleField = { id: 'title', label: 'Title', type: 'text', required: true };
		} else {
			titleField.id = 'title';
			titleField.label = 'Title';
			titleField.type = 'text';
			titleField.required = true;
		}

		const otherFields = rawFields.filter(f =>
			f !== titleField &&
			f.id.toLowerCase() !== 'title' &&
			f.label?.toLowerCase() !== 'title'
		);

		const fields: ICustomField[] = [titleField, ...otherFields];
		const seenFieldIds = new Set<string>();
		fields.forEach((f, idx) => {
			if (!f) {
				return;
			}
			const rawId = (f.id || '').trim();
			const rawLower = rawId.toLowerCase();
			if (rawId && !seenFieldIds.has(rawLower)) {
				seenFieldIds.add(rawLower);
				return;
			}
			const baseSlug = ((f.label || f.type || `field_${idx + 1}`).toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/^_+|_+$/g, '')) || `field_${idx + 1}`;
			let candidateId = baseSlug;
			let suffix = 2;
			while (seenFieldIds.has(candidateId.toLowerCase())) {
				candidateId = `${baseSlug}_${suffix}`;
				suffix++;
			}
			f.id = candidateId;
			seenFieldIds.add(candidateId.toLowerCase());
		});
		activeMod.fields = fields;

		const currentStatuses: IStatusDefinition[] = (activeMod.statuses && Array.isArray(activeMod.statuses) && activeMod.statuses.length > 0)
			? JSON.parse(JSON.stringify(activeMod.statuses))
			: JSON.parse(JSON.stringify(DEFAULT_STATUS_DEFINITIONS));
		activeMod.statuses = currentStatuses;

		const compositeClasses = await this.customModulesService.getCompositeComponents(input.workspaceUri);

		// 1. Left Dedicated Toolbox Sidebar (Full-height, pinned, independent scroll, like Workflow Toolbox)
		const leftLibrary = this._toolboxEl = append(this._container, $('.schema-editor-toolbox', {
			style: `width: ${this._isToolboxCompact ? '56px' : '260px'}; min-width: ${this._isToolboxCompact ? '56px' : '260px'}; height: 100%; border-right: 1px solid var(--vscode-sideBar-border, rgba(255, 255, 255, 0.08)); background: var(--vscode-sideBar-background, #181818); display: ${isFlowchartNodeMode || isEmbeddedFieldMode ? 'none' : 'flex'}; flex-direction: column; padding: ${this._isToolboxCompact ? '12px 6px' : '16px 14px'}; gap: 14px; box-sizing: border-box; flex-shrink: 0; overflow-y: auto; overflow-x: hidden; transition: width 0.2s cubic-bezier(0.16, 1, 0.3, 1), min-width 0.2s cubic-bezier(0.16, 1, 0.3, 1);`
		}));

		// 2. Right Main Scrollable Viewport (Contains Header, Config Card, Canvas & Footer. Scrolls smoothly as a unified document!)
		const mainViewport = this._mainViewportEl = append(this._container, $('.schema-editor-main-viewport', {
			style: `flex: 1; height: 100%; min-width: 0; overflow-y: auto; overflow-x: hidden; padding: ${isEmbeddedFieldMode ? '16px 20px' : '24px 36px'}; box-sizing: border-box;`
		}));

		const targetScrollState = this._getSavedScrollState(scrollKey);
		const markUserManualScroll = () => {
			this._userHasScrolledSinceRender = true;
			this._isRestoringScroll = false;
		};
		for (const evtName of ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const) {
			mainViewport.addEventListener(evtName, markUserManualScroll, { passive: true });
			leftLibrary.addEventListener(evtName, markUserManualScroll, { passive: true });
		}
		mainViewport.addEventListener('scroll', () => {
			if (this._isRestoringScroll || mainViewport.clientHeight <= 0 || !scrollKey) {
				return;
			}
			const prev = savedSchemaScrollStateByKey.get(scrollKey) || { mainScrollTop: 0, toolboxScrollTop: 0 };
			const nextState = {
				mainScrollTop: mainViewport.scrollTop,
				toolboxScrollTop: leftLibrary.clientHeight > 0 ? leftLibrary.scrollTop : prev.toolboxScrollTop
			};
			savedSchemaScrollStateByKey.set(scrollKey, nextState);
			try {
				this._storageService.store(`customModuleSchemaEditor.scroll.${scrollKey}`, JSON.stringify(nextState), StorageScope.PROFILE, StorageTarget.MACHINE);
			} catch { }
		}, { passive: true });
		leftLibrary.addEventListener('scroll', () => {
			if (this._isRestoringScroll || leftLibrary.clientHeight <= 0 || !scrollKey) {
				return;
			}
			const prev = savedSchemaScrollStateByKey.get(scrollKey) || { mainScrollTop: 0, toolboxScrollTop: 0 };
			const nextState = {
				mainScrollTop: mainViewport.clientHeight > 0 ? mainViewport.scrollTop : prev.mainScrollTop,
				toolboxScrollTop: leftLibrary.scrollTop
			};
			savedSchemaScrollStateByKey.set(scrollKey, nextState);
			try {
				this._storageService.store(`customModuleSchemaEditor.scroll.${scrollKey}`, JSON.stringify(nextState), StorageScope.PROFILE, StorageTarget.MACHINE);
			} catch { }
		}, { passive: true });

		const applySavedScrollPosition = () => {
			if (this._userHasScrolledSinceRender || this._currentScrollKey !== scrollKey) {
				this._isRestoringScroll = false;
				return;
			}
			if (targetScrollState) {
				this._isRestoringScroll = true;
				if (targetScrollState.mainScrollTop > 0) {
					mainViewport.scrollTop = targetScrollState.mainScrollTop;
				}
				if (targetScrollState.toolboxScrollTop > 0) {
					leftLibrary.scrollTop = targetScrollState.toolboxScrollTop;
				}
				getWindow(mainViewport).requestAnimationFrame(() => {
					if (this._currentScrollKey === scrollKey) {
						this._isRestoringScroll = false;
					}
				});
			} else {
				this._isRestoringScroll = false;
			}
		};

		const wrapper = append(mainViewport, $('.schema-editor-wrapper', {
			style: 'max-width: 1080px; width: 100%; margin: 0 auto; display: flex; flex-direction: column; gap: 18px;'
		}));

		activeMod.isDeprecated = !!activeMod.isDeprecated;

		// Header Bar
		const header = append(wrapper, $('.schema-editor-header', {
			style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; flex-shrink: 0;'
		}));
		const titleEl = append(header, $('h2', {
			style: `margin: 0; font-size: 18px; font-weight: 600; color: ${activeMod.color || '#38bdf8'}; display: flex; align-items: center; gap: 10px;`
		}));
		const headerModuleIconEl = append(titleEl, $('span' + ThemeIcon.asCSSSelector(resolveCustomModuleIcon(activeMod.icon, activeMod.id)), {
			style: `font-size: 18px; color: ${activeMod.color || '#38bdf8'};`
		}));
		append(titleEl, $('span', {}, isFlowchartNodeMode ? `Flowchart Node: ${activeMod.name}` : `Edit Module Schema: ${activeMod.name}`));
		if (isEmbeddedFieldMode) {
			// The host (e.g. a ticket page dialog) shows its own title and actions
			header.style.display = 'none';
		}

		// Header Right Actions (Status Pill + Compact Icon Buttons: Preview, Copy Template, Toggle Status, Delete)
		const headerActions = append(header, $('.schema-editor-header-actions', {
			style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;'
		}));

		const statusBadge = append(headerActions, $('span.schema-status-pill', {
			style: 'font-size: 11px; padding: 4px 10px; border-radius: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; margin-right: 2px;'
		}));

		const previewHeaderBtn = append(headerActions, $('button.monaco-button.schema-preview-btn', {
			type: 'button',
			style: 'width: 28px; height: 26px; padding: 0; border-radius: 6px; cursor: pointer; background: rgba(56, 189, 248, 0.14); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;'
		}));
		append(previewHeaderBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.eye), { style: 'font-size: 14px;' }));
		this._attachInstantTooltip(previewHeaderBtn, 'Preview Ticket: Open a new tab to preview a ticket generated from this template', '#38bdf8');

		const copyModuleBtn = append(headerActions, $('button.monaco-button.schema-copy-btn', {
			type: 'button',
			style: 'width: 28px; height: 26px; padding: 0; border-radius: 6px; cursor: pointer; background: rgba(168, 85, 247, 0.14); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.35); display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;'
		}));
		const copyModuleIcon = append(copyModuleBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy), { style: 'font-size: 13px;' }));
		this._attachInstantTooltip(copyModuleBtn, 'Copy Template: Copy LLM-ready template blueprint & schema to clipboard', '#c084fc');
		copyModuleBtn.onclick = async (e) => {
			e.stopPropagation();
			this._syncDraft();
			const formattedText = this._formatModuleForLlmCopy(activeMod);
			try {
				await this._clipboardService.writeText(formattedText);
				copyModuleIcon.className = ThemeIcon.asClassName(Codicon.check);
				copyModuleBtn.style.color = '#34d399';
				copyModuleBtn.style.borderColor = 'rgba(52, 211, 153, 0.45)';
				copyModuleBtn.style.background = 'rgba(52, 211, 153, 0.14)';
				this.notificationService.info(`Copied template "${activeMod.name}" (LLM-ready blueprint & schema) to clipboard.`);
				setTimeout(() => {
					copyModuleIcon.className = ThemeIcon.asClassName(Codicon.copy);
					copyModuleBtn.style.color = '#c084fc';
					copyModuleBtn.style.borderColor = 'rgba(168, 85, 247, 0.35)';
					copyModuleBtn.style.background = 'rgba(168, 85, 247, 0.14)';
				}, 1500);
			} catch (err) {
				this.notificationService.error(`Failed to copy template: ${err}`);
			}
		};

		const toggleStatusBtn = append(headerActions, $('button.monaco-button.schema-header-btn', {
			type: 'button',
			style: 'width: 28px; height: 26px; padding: 0; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;'
		}));
		const toggleStatusIcon = append(toggleStatusBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.circleSlash), { style: 'font-size: 13px;' }));
		this._attachInstantTooltip(toggleStatusBtn, () => activeMod.isDeprecated
			? 'Enable Module: Make this template active for creating new tickets'
			: 'Disable Module: Hide this template from new ticket creation options', '#fbbf24');

		const deleteBtn = append(headerActions, $('button.monaco-button.schema-delete-btn', {
			type: 'button',
			style: 'width: 28px; height: 26px; padding: 0; border-radius: 6px; cursor: pointer; background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.35); display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;'
		}));
		append(deleteBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), { style: 'font-size: 13px;' }));
		this._attachInstantTooltip(deleteBtn, 'Delete Module: Permanently remove this module template', '#f87171');

		// Top Configuration Card (Scope, Type Definition, Color, Status)
		const configCard = append(wrapper, $('.config-meta-container', {
			style: `display: ${isFlowchartNodeMode || isEmbeddedFieldMode ? 'none' : 'flex'}; flex-direction: column; gap: 8px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); padding: 10px 14px; border-radius: 8px; flex-shrink: 0;`
		}));
		if (isFlowchartNodeMode) {
			statusBadge.style.display = 'none';
			previewHeaderBtn.style.display = 'none';
			toggleStatusBtn.style.display = 'none';
			deleteBtn.style.display = 'none';
		}

		// Status Row in Configuration Card
		const statusRow = append(configCard, $('.config-status-row', {
			style: 'display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 10px 14px; border-radius: 6px; background: rgba(0,0,0,0.22); border: 1px solid rgba(255,255,255,0.06);'
		}));
		const statusLeft = append(statusRow, $('div', { style: 'display: flex; flex-direction: column; gap: 3px;' }));
		const statusTitle = append(statusLeft, $('div', { style: 'font-size: 11.5px; font-weight: 600; display: flex; align-items: center; gap: 8px;' }));
		append(statusTitle, $('span', {}, 'Module Status:'));
		const statusLabel = append(statusTitle, $('span.status-text', { style: 'font-weight: 700;' }));

		append(statusLeft, $('div', {
			style: 'font-size: 11px; opacity: 0.65;'
		}, 'When disabled, this module will not appear in the new ticket type options. Existing tickets remain preserved.'));

		// Toggle Switch in config row
		const switchWrapper = append(statusRow, $('label.schema-status-switch', {
			style: 'position: relative; display: inline-block; width: 44px; height: 22px; cursor: pointer; flex-shrink: 0;'
		}));
		const switchInput = append(switchWrapper, $('input', {
			type: 'checkbox',
			style: 'opacity: 0; width: 0; height: 0;'
		})) as HTMLInputElement;
		switchInput.checked = !activeMod.isDeprecated;
		const switchSlider = append(switchWrapper, $('span.switch-slider'));

		const updateStatusVisuals = () => {
			const isDep = !!activeMod.isDeprecated;
			if (!isDep) {
				statusBadge.className = 'schema-status-pill active-status';
				statusBadge.textContent = '● Active';
				statusBadge.style.color = '#34d399';
				statusBadge.style.background = 'rgba(16, 185, 129, 0.15)';
				statusBadge.style.border = '1px solid rgba(16, 185, 129, 0.3)';

				toggleStatusBtn.className = 'monaco-button schema-header-btn deactivate';
				toggleStatusIcon.className = ThemeIcon.asClassName(Codicon.circleSlash);
				toggleStatusBtn.style.color = '#fbbf24';
				toggleStatusBtn.style.background = 'rgba(245, 158, 11, 0.12)';
				toggleStatusBtn.style.border = '1px solid rgba(245, 158, 11, 0.3)';

				statusLabel.textContent = 'Active';
				statusLabel.style.color = '#34d399';
				switchInput.checked = true;
				switchSlider.style.backgroundColor = '#10b981';
			} else {
				statusBadge.className = 'schema-status-pill deprecated';
				statusBadge.textContent = '● Disabled';
				statusBadge.style.color = '#f59e0b';
				statusBadge.style.background = 'rgba(245, 158, 11, 0.15)';
				statusBadge.style.border = '1px solid rgba(245, 158, 11, 0.3)';

				toggleStatusBtn.className = 'monaco-button schema-header-btn restore';
				toggleStatusIcon.className = ThemeIcon.asClassName(Codicon.pass);
				toggleStatusBtn.style.color = '#34d399';
				toggleStatusBtn.style.background = 'rgba(16, 185, 129, 0.12)';
				toggleStatusBtn.style.border = '1px solid rgba(16, 185, 129, 0.3)';

				statusLabel.textContent = 'Disabled';
				statusLabel.style.color = '#f59e0b';
				switchInput.checked = false;
				switchSlider.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
			}
		};

		const handleToggleStatus = async () => {
			activeMod.isDeprecated = !activeMod.isDeprecated;
			activeMod.updatedAt = Date.now();
			updateStatusVisuals();
			try {
				const currentModules = await this.customModulesService.getCustomModules(input.workspaceUri);
				const existingIndex = currentModules.findIndex(m => m.id.toLowerCase() === activeMod.id.toLowerCase());
				if (existingIndex !== -1) {
					currentModules[existingIndex] = activeMod;
				} else {
					currentModules.push(activeMod);
				}
				await this.customModulesService.saveCustomModules(currentModules, input.workspaceUri);
				this.notificationService.info(`Module "${activeMod.name}" is now ${activeMod.isDeprecated ? 'Disabled' : 'Active'}`);
			} catch (e) {
				this.notificationService.error(`Failed to update module status: ${e}`);
			}
		};

		toggleStatusBtn.onclick = handleToggleStatus;
		switchInput.onchange = handleToggleStatus;
		updateStatusVisuals();

		const handleDeleteModule = async () => {
			const res = await this.dialogService.confirm({
				message: `Delete module "${activeMod.name}"?`,
				detail: `This will permanently remove the schema YAML file (${activeMod.id}.yaml). Existing tickets of this type will preserve their data.`,
				primaryButton: 'Delete'
			});
			if (res.confirmed) {
				try {
					if (this.input instanceof CustomModuleSchemaEditorInput) {
						this.input.draftModule = undefined;
					}
					await this.customModulesService.deleteCustomModule(activeMod.id, input.workspaceUri);
					this.notificationService.info(`Module "${activeMod.name}" has been deleted.`);
					this.group.closeEditor(this.input!);
				} catch (e) {
					this.notificationService.error(`Failed to delete module: ${e}`);
				}
			}
		};
		deleteBtn.onclick = handleDeleteModule;

		const configTopRow = append(configCard, $('.config-top-row', {
			style: 'display: flex; gap: 20px; align-items: center; justify-content: space-between; flex-wrap: wrap;'
		}));
		const topLeftGroup = append(configTopRow, $('.top-left-group', {
			style: 'display: flex; gap: 16px; align-items: center; flex: 1; min-width: 220px; flex-wrap: wrap;'
		}));

		activeMod.storageScope = 'global';

		const createSingleStarIcon = (): SVGSVGElement => {
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('width', '13');
			svg.setAttribute('height', '13');
			svg.setAttribute('viewBox', '0 0 16 16');
			svg.setAttribute('fill', 'currentColor');
			svg.style.display = 'block';
			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.setAttribute('d', 'M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z');
			svg.appendChild(path);
			return svg;
		};

		// Type Definition Input (with single-star AI button at the tail end of the input box)
		const defGroup = append(topLeftGroup, $('.form-group', { style: 'display: flex; align-items: center; gap: 8px; flex: 1;' }));
		append(defGroup, $('label', { style: 'font-size: 11px; opacity: 0.85; font-weight: 600; text-transform: uppercase; color: #888888; white-space: nowrap;' }, 'Type Definition:'));
		const defInputWrapper = append(defGroup, $('div', {
			style: 'position: relative; display: flex; align-items: center; flex: 1; min-width: 0;'
		}));
		const defInput = append(defInputWrapper, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 5px 32px 5px 10px; font-size: 12px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.15); background: #1a1a1a; color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;
		defInput.placeholder = 'e.g. Explains purpose of this module entity...';
		defInput.value = activeMod.description || '';
		defInput.oninput = () => {
			activeMod.description = defInput.value;
		};
		defInput.onchange = async () => {
			activeMod.description = defInput.value;
			await this._persistCurrentModule();
		};

		const defAiBtn = append(defInputWrapper, $('button.schema-ai-star-btn', {
			type: 'button',
			style: 'position: absolute; right: 4px; padding: 3px 5px; border-radius: 4px; border: 1px solid transparent; background: transparent; color: var(--vscode-icon-foreground, rgba(255, 255, 255, 0.45)); opacity: 0.55; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; line-height: 1; user-select: none; transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease, border-color 0.15s ease;'
		}));
		defAiBtn.appendChild(createSingleStarIcon());
		this._attachInstantTooltip(defAiBtn, 'Edit Type Definition in Agent Central: Open Agent Central with template context injected', '#38bdf8');
		defAiBtn.onmouseenter = () => {
			defAiBtn.style.opacity = '1';
			defAiBtn.style.color = 'var(--vscode-editor-foreground, #ffffff)';
			defAiBtn.style.background = 'rgba(255, 255, 255, 0.08)';
			defAiBtn.style.borderColor = 'rgba(255, 255, 255, 0.18)';
		};
		defAiBtn.onmouseleave = () => {
			defAiBtn.style.opacity = '0.55';
			defAiBtn.style.color = 'var(--vscode-icon-foreground, rgba(255, 255, 255, 0.45))';
			defAiBtn.style.background = 'transparent';
			defAiBtn.style.borderColor = 'transparent';
		};
		defAiBtn.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			this._openTemplateFieldInAgentCentral('definition', activeMod);
		};

		// Module Icon Picker
		const iconContainer = append(configTopRow, $('div', {
			style: 'display: flex; align-items: center; gap: 8px; position: relative;'
		}));
		append(iconContainer, $('span', {
			style: 'font-size: 11px; font-weight: 600; text-transform: uppercase; color: #888888; white-space: nowrap;'
		}, 'Module Icon:'));

		const iconTriggerBtn = append(iconContainer, $('button.monaco-button', {
			type: 'button',
			style: 'display: inline-flex; align-items: center; gap: 7px; padding: 4px 10px; height: 28px; border-radius: 6px; cursor: pointer; background: #1a1a1a; color: inherit; border: 1px solid rgba(255, 255, 255, 0.16); font-size: 11.5px; width: auto; box-sizing: border-box;'
		}));
		const iconTriggerGlyph = append(iconTriggerBtn, $('span'));
		const iconTriggerLabel = append(iconTriggerBtn, $('span', { style: 'font-weight: 500;' }));
		append(iconTriggerBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.chevronDown), { style: 'font-size: 11px; opacity: 0.65;' }));

		// Module Color Picker
		const colorContainer = append(configTopRow, $('div', { style: 'display: flex; align-items: center; gap: 10px; flex-wrap: wrap;' }));
		append(colorContainer, $('span', { style: 'font-size: 11px; font-weight: 600; text-transform: uppercase; color: #888888; white-space: nowrap;' }, 'Module Color:'));
		const colorPalette = append(colorContainer, $('.palette-dots', { style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;' }));
		const availableColors = CUSTOM_MODULE_COLOR_PALETTE;
		let activeColor = activeMod.color || availableColors[0];
		const colorElements: { color: string; el: HTMLElement }[] = [];

		const syncHeaderAndIconVisuals = () => {
			const resolvedThemeIcon = resolveCustomModuleIcon(activeMod.icon, activeMod.id);
			const matchedOpt = CUSTOM_MODULE_ICON_LIBRARY.find(o => o.id.toLowerCase() === (activeMod.icon || '').toLowerCase());
			const currentColor = activeMod.color || '#38bdf8';

			headerModuleIconEl.className = ThemeIcon.asClassName(resolvedThemeIcon);
			headerModuleIconEl.style.color = currentColor;
			titleEl.style.color = currentColor;

			iconTriggerGlyph.className = ThemeIcon.asClassName(resolvedThemeIcon);
			iconTriggerGlyph.style.color = currentColor;
			iconTriggerGlyph.style.fontSize = '14px';
			iconTriggerLabel.textContent = matchedOpt ? matchedOpt.label : (activeMod.icon || 'Package');

			colorElements.forEach(item => {
				const isSelected = item.color.toLowerCase() === currentColor.toLowerCase();
				item.el.style.transform = isSelected ? 'scale(1.25)' : 'none';
				item.el.style.boxShadow = isSelected ? '0 0 0 2px #fff' : 'none';
			});
		};

		let activeIconPopover: HTMLElement | null = null;
		let closePopoverHandler: ((ev: MouseEvent) => void) | null = null;
		const closeIconPopover = () => {
			if (activeIconPopover) {
				activeIconPopover.remove();
				activeIconPopover = null;
			}
			if (closePopoverHandler) {
				iconTriggerBtn.ownerDocument.removeEventListener('mousedown', closePopoverHandler, true);
				closePopoverHandler = null;
			}
		};
		this._renderCleanupFns.push(closeIconPopover);

		iconTriggerBtn.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (activeIconPopover) {
				closeIconPopover();
				return;
			}

			const rect = iconTriggerBtn.getBoundingClientRect();
			const targetWindow = getWindow(iconTriggerBtn);
			const hostRoot = this._layoutService.getContainer(targetWindow) || targetWindow.document.body;
			const popover = append(hostRoot, $('.custom-module-icon-popover', {
				style: `position: fixed; top: ${Math.min(targetWindow.innerHeight - 340, rect.bottom + 6)}px; left: ${Math.max(12, Math.min(targetWindow.innerWidth - 380, rect.left))}px; width: 360px; max-height: 320px; background: var(--vscode-editorWidget-background, #1e1e1e); color: var(--vscode-foreground, #cccccc); font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif); border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 10px; padding: 10px; box-shadow: 0 14px 36px rgba(0, 0, 0, 0.75); z-index: 100000; display: flex; flex-direction: column; gap: 8px; box-sizing: border-box; overflow: hidden;`
			}));
			activeIconPopover = popover;
			popover.onmousedown = ev => ev.stopPropagation();

			const searchInput = append(popover, $('input.monaco-inputbox', {
				type: 'text',
				placeholder: 'Search icon (e.g. globe, briefcase, file, database)...',
				style: 'width: 100%; padding: 6px 9px; font-size: 11.5px; font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif); border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.16); background: #141414; color: inherit; box-sizing: border-box; outline: none; flex-shrink: 0;'
			})) as HTMLInputElement;

			const gridScrollWrapper = append(popover, $('div', {
				style: 'overflow-y: auto; overflow-x: hidden; flex: 1; min-height: 0; padding: 2px;'
			}));
			const grid = append(gridScrollWrapper, $('div', {
				style: 'display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px;'
			}));

			const renderGrid = (query: string) => {
				clearNode(grid);
				const q = query.trim().toLowerCase();
				const items = q
					? CUSTOM_MODULE_ICON_LIBRARY.filter(it => it.id.toLowerCase().includes(q) || it.label.toLowerCase().includes(q))
					: CUSTOM_MODULE_ICON_LIBRARY;
				const curIcon = (activeMod.icon || getDefaultCustomModuleIconId(activeMod.id)).toLowerCase();
				const curColor = activeMod.color || '#38bdf8';

				for (const item of items) {
					const isSel = item.id.toLowerCase() === curIcon;
					const cell = append(grid, $('div', {
						style: `display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 7px 4px; border-radius: 6px; cursor: pointer; border: 1px solid ${isSel ? curColor : 'rgba(255,255,255,0.06)'}; background: ${isSel ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.02)'}; transition: all 0.12s ease; font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);`,
						title: `${item.label} (${item.id})`
					}));
					append(cell, $('span' + ThemeIcon.asCSSSelector(item.icon), {
						style: `font-size: 16px; color: ${isSel ? curColor : 'inherit'};`
					}));
					append(cell, $('span', {
						style: 'font-size: 10px; font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif); opacity: 0.82; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 74px; text-align: center;'
					}, item.label));

					cell.onclick = async () => {
						activeMod.icon = item.id;
						syncHeaderAndIconVisuals();
						closeIconPopover();
						await this._persistCurrentModule();
						this.notificationService.info(`Updated icon for "${activeMod.name}" to ${item.label}.`);
					};
				}
			};

			searchInput.oninput = () => renderGrid(searchInput.value);
			renderGrid('');
			setTimeout(() => searchInput.focus(), 10);

			closePopoverHandler = (ev: MouseEvent) => {
				if (activeIconPopover && !activeIconPopover.contains(ev.target as Node) && !iconTriggerBtn.contains(ev.target as Node)) {
					closeIconPopover();
				}
			};
			iconTriggerBtn.ownerDocument.addEventListener('mousedown', closePopoverHandler, true);
		};

		availableColors.forEach(c => {
			const dot = append(colorPalette, $('div', {
				style: `width: 18px; height: 18px; border-radius: 50%; background: ${c}; cursor: pointer; transition: all 0.15s ease; box-sizing: border-box;`,
				title: c
			}));
			dot.onclick = async () => {
				activeColor = c;
				activeMod.color = c;
				syncHeaderAndIconVisuals();
				await this._persistCurrentModule();
			};
			colorElements.push({ color: c, el: dot });
		});

		const customColorPicker = append(colorPalette, $('input', {
			type: 'color',
			value: /^#[0-9a-fA-F]{6}$/.test(activeColor) ? activeColor : '#38bdf8',
			title: 'Pick Custom Color',
			style: 'width: 20px; height: 20px; padding: 0; border: 1px solid rgba(255,255,255,0.28); border-radius: 50%; background: transparent; cursor: pointer;'
		})) as HTMLInputElement;
		customColorPicker.onchange = async () => {
			activeColor = customColorPicker.value;
			activeMod.color = activeColor;
			syncHeaderAndIconVisuals();
			await this._persistCurrentModule();
		};

		syncHeaderAndIconVisuals();

		// Type Prompt Section (AI Instructions, with single-star AI button right next to the title)
		const promptBox = append(configCard, $('.type-prompt-box', { style: 'display: flex; flex-direction: column; gap: 6px; margin-top: 4px;' }));
		const promptHeader = append(promptBox, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;' }));
		const promptTitleLeft = append(promptHeader, $('div', { style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;' }));
		append(promptTitleLeft, $('span', { style: 'font-size: 11px; font-weight: 700; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.05em;' }, 'Type Prompt (AI System Instructions for this Module):'));
		const promptAiBtn = append(promptTitleLeft, $('button.schema-ai-star-btn', {
			type: 'button',
			style: 'padding: 3px 5px; border-radius: 4px; border: 1px solid transparent; background: transparent; color: var(--vscode-icon-foreground, rgba(255, 255, 255, 0.45)); opacity: 0.55; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; line-height: 1; user-select: none; transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease, border-color 0.15s ease;'
		}));
		promptAiBtn.appendChild(createSingleStarIcon());
		this._attachInstantTooltip(promptAiBtn, 'Edit Type Prompt in Agent Central: Open Agent Central with template context injected', '#38bdf8');
		promptAiBtn.onmouseenter = () => {
			promptAiBtn.style.opacity = '1';
			promptAiBtn.style.color = 'var(--vscode-editor-foreground, #ffffff)';
			promptAiBtn.style.background = 'rgba(255, 255, 255, 0.08)';
			promptAiBtn.style.borderColor = 'rgba(255, 255, 255, 0.18)';
		};
		promptAiBtn.onmouseleave = () => {
			promptAiBtn.style.opacity = '0.55';
			promptAiBtn.style.color = 'var(--vscode-icon-foreground, rgba(255, 255, 255, 0.45))';
			promptAiBtn.style.background = 'transparent';
			promptAiBtn.style.borderColor = 'transparent';
		};
		append(promptHeader, $('span', { style: 'font-size: 10.5px; opacity: 0.6;' }, 'Multi-line AI instructions when tickets of this type are processed'));

		const promptInput = append(promptBox, $('textarea.monaco-inputbox', {
			style: 'width: 100%; height: 50px; padding: 6px 10px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.15); background: #141414; color: inherit; box-sizing: border-box; resize: vertical; line-height: 1.4;'
		})) as HTMLTextAreaElement;
		promptInput.placeholder = 'Provide specific guidelines for AI agents handling this module entity...';
		promptInput.value = activeMod.prompt || '';
		promptInput.oninput = () => {
			activeMod.prompt = promptInput.value;
		};
		promptInput.onchange = async () => {
			activeMod.prompt = promptInput.value;
			await this._persistCurrentModule();
		};
		promptAiBtn.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			this._openTemplateFieldInAgentCentral('prompt', activeMod);
		};

		// Configure Left Toolbox (Full-height Sidebar)
		const toolboxHeader = append(leftLibrary, $('.workflow-toolbar-header', {
			style: 'display: flex; align-items: center; justify-content: space-between; width: 100%; padding-bottom: 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.08);'
		}));
		if (!this._isToolboxCompact) {
			const tbTitle = append(toolboxHeader, $('div', {
				style: 'font-size: 11px; font-weight: 700; color: #38bdf8; letter-spacing: 0.6px; text-transform: uppercase;'
			}, 'TOOLBOX'));
			tbTitle.title = 'Primitives & Components Toolbox';
		}
		const toggleBtn = append(toolboxHeader, $('button.monaco-button.workflow-toolbar-toggle-btn', {
			type: 'button',
			title: this._isToolboxCompact ? 'Expand Toolbox' : 'Collapse Toolbox',
			style: 'width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.03); color: #888888; cursor: pointer; padding: 0;'
		}));
		append(toggleBtn, $('span' + ThemeIcon.asCSSSelector(this._isToolboxCompact ? Codicon.chevronRight : Codicon.chevronLeft)));
		toggleBtn.onclick = (e) => {
			e.stopPropagation();
			this._isToolboxCompact = !this._isToolboxCompact;
			this._loadAndRender(input);
		};

		if (!this._isToolboxCompact) {
			append(leftLibrary, $('div', { style: 'font-size: 10.5px; opacity: 0.65; line-height: 1.4;' }, 'Drag & drop components anywhere to canvas on the right, or click to append.'));
			append(leftLibrary, $('div', { style: 'font-size: 10.5px; font-weight: 700; text-transform: uppercase; color: #38bdf8; margin-top: 4px;' }, 'Base Primitives'));
		}

		const primitivesList = append(leftLibrary, $('.primitives-list', {
			style: `display: flex; flex-direction: column; gap: 6px; ${this._isToolboxCompact ? 'align-items: center;' : ''}`
		}));

		const baseComponents = BASE_COMPONENT_PALETTE;

		// Right Main Area: Canvas appended inside scrollable wrapper
		const rightCanvas = append(wrapper, $('.designer-canvas', {
			style: 'display: flex; flex-direction: column; gap: 14px; min-height: 400px; transition: all 0.2s ease;'
		}));

		let currentDraggingItem: {
			source: 'palette' | 'canvas';
			type?: CustomFieldType;
			isClass?: boolean;
			classId?: string;
			name?: string;
			fromIndex?: number;
		} | null = null;

		const addFieldFromDef = (bc: IComponentPaletteItem, insertIndex?: number) => {
			const newField = createComponentField(bc, fields, {
				defaultModel: resolveDefaultModel({ providerId: 'gemini', modelId: 'gemini-2.5-flash' }),
				// Freestyle tickets can only be created manually in the UI: never default to a reserved-name template
				defaultTicketType: allWorkspaceModules.find(m => !clashesWithBuiltInTicketType(m))?.name || ''
			});
			if (typeof insertIndex === 'number' && insertIndex >= 0 && insertIndex <= fields.length) {
				const safeInsertIndex = Math.max(1, insertIndex);
				fields.splice(safeInsertIndex, 0, newField);
			} else {
				fields.push(newField);
			}
			this._syncDraft();
			const savedScroll = mainViewport ? mainViewport.scrollTop : 0;
			renderCanvas();
			if (mainViewport) {
				mainViewport.scrollTop = savedScroll;
			}
			if (insertIndex === undefined) {
				setTimeout(() => {
					if (mainViewport) {
						mainViewport.scrollTop = mainViewport.scrollHeight;
					}
				}, 40);
			}
			if (!isFlowchartNodeMode) {
				this._persistCurrentModule().catch(() => { });
			}
		};

		const addCompositeClass = (cc: ICompositeComponent, insertIndex?: number) => {
			const newField = createCompositeComponentField(cc, fields);
			if (typeof insertIndex === 'number' && insertIndex >= 0 && insertIndex <= fields.length) {
				const safeInsertIndex = Math.max(1, insertIndex);
				fields.splice(safeInsertIndex, 0, newField);
			} else {
				fields.push(newField);
			}
			this._syncDraft();
			const savedScroll = mainViewport ? mainViewport.scrollTop : 0;
			renderCanvas();
			if (mainViewport) {
				mainViewport.scrollTop = savedScroll;
			}
			if (insertIndex === undefined) {
				setTimeout(() => {
					if (mainViewport) {
						mainViewport.scrollTop = mainViewport.scrollHeight;
					}
				}, 40);
			}
			if (!isFlowchartNodeMode) {
				this._persistCurrentModule().catch(() => { });
			}
		};

		const handleItemDrop = (targetIndex?: number, position: 'before' | 'after' = 'before', e?: DragEvent) => {
			if (currentDraggingItem) {
				if (currentDraggingItem.source === 'palette') {
					let insertPos: number | undefined = undefined;
					if (typeof targetIndex === 'number') {
						insertPos = Math.max(1, position === 'after' ? targetIndex + 1 : targetIndex);
					}
					if (currentDraggingItem.isClass && currentDraggingItem.classId) {
						const cc = compositeClasses.find(c => c.id === currentDraggingItem!.classId);
						if (cc) {
							addCompositeClass(cc, insertPos);
						}
					} else if (currentDraggingItem.type) {
						const bc = baseComponents.find(c => c.type === currentDraggingItem!.type);
						if (bc) {
							addFieldFromDef(bc, insertPos);
						}
					}
				} else if (currentDraggingItem.source === 'canvas') {
					const from = currentDraggingItem.fromIndex;
					if (from !== undefined && from >= 1) {
						if (targetIndex !== undefined) {
							const effectiveTarget = Math.max(1, targetIndex);
							if (from !== effectiveTarget) {
								const [moved] = fields.splice(from, 1);
								let adjustedTarget = effectiveTarget;
								if (from < effectiveTarget) {
									adjustedTarget = effectiveTarget - 1;
								}
								const finalPos = Math.max(1, position === 'after' ? adjustedTarget + 1 : adjustedTarget);
								fields.splice(finalPos, 0, moved);
								this._syncDraft();
								const savedScroll = mainViewport ? mainViewport.scrollTop : 0;
								renderCanvas();
								if (mainViewport) {
									mainViewport.scrollTop = savedScroll;
								}
								if (!isFlowchartNodeMode) {
									this._persistCurrentModule().catch(() => { });
								}
							}
						} else {
							// Dropped below all cards -> move to the end
							if (from !== fields.length - 1) {
								const [moved] = fields.splice(from, 1);
								fields.push(moved);
								renderCanvas();
							}
						}
					}
				}
				currentDraggingItem = null;
				return;
			}

			if (e?.dataTransfer) {
				const plainText = e.dataTransfer.getData('text/plain');
				if (plainText.startsWith('field:')) {
					const from = parseInt(plainText.replace('field:', ''), 10);
					if (!isNaN(from) && from >= 1 && from < fields.length) {
						if (targetIndex !== undefined) {
							const effectiveTarget = Math.max(1, targetIndex);
							if (from !== effectiveTarget) {
								const [moved] = fields.splice(from, 1);
								let adjustedTarget = effectiveTarget;
								if (from < effectiveTarget) {
									adjustedTarget = effectiveTarget - 1;
								}
								const finalPos = Math.max(1, position === 'after' ? adjustedTarget + 1 : adjustedTarget);
								fields.splice(finalPos, 0, moved);
								this._syncDraft();
								const savedScroll = mainViewport ? mainViewport.scrollTop : 0;
								renderCanvas();
								if (mainViewport) {
									mainViewport.scrollTop = savedScroll;
								}
								if (!isFlowchartNodeMode) {
									this._persistCurrentModule().catch(() => { });
								}
								return;
							}
						} else if (targetIndex === undefined && from !== fields.length - 1) {
							const [moved] = fields.splice(from, 1);
							fields.push(moved);
							renderCanvas();
							return;
						}
					}
				} else if (plainText.startsWith('composite:')) {
					let insertPos: number | undefined = undefined;
					if (typeof targetIndex === 'number') {
						insertPos = Math.max(1, position === 'after' ? targetIndex + 1 : targetIndex);
					}
					const cId = plainText.replace('composite:', '');
					const cc = compositeClasses.find(c => c.id === cId);
					if (cc) {
						addCompositeClass(cc, insertPos);
						return;
					}
				} else {
					let insertPos: number | undefined = undefined;
					if (typeof targetIndex === 'number') {
						insertPos = Math.max(1, position === 'after' ? targetIndex + 1 : targetIndex);
					}
					let resolvedType = plainText;
					try {
						if (plainText.startsWith('{')) {
							const parsed = JSON.parse(plainText);
							if (parsed?.kind === 'node_component' && parsed.compType) {
								resolvedType = parsed.compType === 'python_step' ? 'python' : parsed.compType;
							} else if (parsed?.kind === 'function_widget' || parsed?.kind === 'function' || parsed?.kind === 'variable_widget') {
								resolvedType = 'python';
							}
						}
					} catch { }
					const bc = baseComponents.find(c => c.type === resolvedType);
					if (bc) {
						addFieldFromDef(bc, insertPos);
						return;
					}
				}
			}
		};

		rightCanvas.ondragover = (e) => {
			e.preventDefault();
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = currentDraggingItem?.source === 'canvas' ? 'move' : 'copy';
			}
		};
		rightCanvas.ondrop = (e) => {
			e.preventDefault();
			handleItemDrop(undefined, 'after', e);
		};
		rightCanvas.tabIndex = -1;
		rightCanvas.style.outline = 'none';

		let hoveredFieldIndex: number | null = null;
		let lastInteractedFieldIndex: number | null = null;
		let newlyPastedFieldId: string | null = null;
		let reorderedFieldId: string | null = null;
		const pasteUiRefreshers: Array<() => void> = [];

		const refreshAllPasteUi = () => {
			pasteUiRefreshers.forEach(fn => {
				try { fn(); } catch { }
			});
		};

		copiedComponentListeners.add(refreshAllPasteUi);
		this._renderCleanupFns.push(() => {
			copiedComponentListeners.delete(refreshAllPasteUi);
		});

		// The window hosting this editor (the main window unless the editor lives in an auxiliary window).
		const editorWindow = getWindow(this._container);
		const onContainerMouseEnter = () => {
			// Only mark as last interacted on hover if no other editor/input outside this container holds active focus
			const activeEl = editorWindow.document.activeElement as HTMLElement | null;
			if (!activeEl || activeEl === editorWindow.document.body || activeEl === editorWindow.document.documentElement || this._container?.contains(activeEl)) {
				lastInteractedSchemaEditor = this;
			}
		};
		const onContainerMouseDown = (ev: MouseEvent) => {
			lastInteractedSchemaEditor = this;
			const target = ev.target as HTMLElement | null;
			if (target && !target.closest('input, textarea, select, button, [role="button"], .codicon, .param-copy-tag, .action-delete-btn, [contenteditable="true"], [contenteditable="plaintext-only"], .prompt-tokenized-display, .prompt-output-display, .python-debug-logs-display, .python-debug-result-display, .sql-output-box, [data-selectable-box="true"], pre, code')) {
				const activeEl = editorWindow.document.activeElement as HTMLElement | null;
				if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) {
					activeEl.blur();
				}
				rightCanvas.focus({ preventScroll: true });
			}
		};
		const onGlobalInteractionOutside = (ev: Event) => {
			const target = ev.target as Node | null;
			if (target && this._container && !this._container.contains(target)) {
				if (lastInteractedSchemaEditor === this) {
					lastInteractedSchemaEditor = null;
				}
			}
		};
		const onGlobalCopyEvent = (ev: ClipboardEvent) => {
			// If the user copies text anywhere outside the component copy button, clear in-memory component clipboard
			// so subsequent Cmd+V pastes normal text/URLs instead of an old copied component.
			const target = ev.target as HTMLElement | null;
			if (target && !this._container?.contains(target)) {
				copiedSchemaComponentClipboard = null;
				notifyCopiedComponentChanged();
			}
		};
		this._container.addEventListener('mouseenter', onContainerMouseEnter);
		this._container.addEventListener('mousedown', onContainerMouseDown, true);
		editorWindow.addEventListener('mousedown', onGlobalInteractionOutside, true);
		editorWindow.addEventListener('focusin', onGlobalInteractionOutside, true);
		editorWindow.addEventListener('copy', onGlobalCopyEvent, true);
		this._renderCleanupFns.push(() => {
			this._container?.removeEventListener('mouseenter', onContainerMouseEnter);
			this._container?.removeEventListener('mousedown', onContainerMouseDown, true);
			editorWindow.removeEventListener('mousedown', onGlobalInteractionOutside, true);
			editorWindow.removeEventListener('focusin', onGlobalInteractionOutside, true);
			editorWindow.removeEventListener('copy', onGlobalCopyEvent, true);
		});

		const copyFieldComponent = async (fieldToCopy: ICustomField, badgeLabel: string, btnIconEl?: HTMLElement) => {
			const clonedField: ICustomField = JSON.parse(JSON.stringify(fieldToCopy));
			delete clonedField.debugPromptOutput;
			delete clonedField.debugSqlOutput;
			delete clonedField.pythonOutput;
			delete clonedField.pythonResult;
			delete clonedField.ttsAudioDataUrl;
			delete (clonedField as IRuntimeCustomField).lastSentPrompt;
			delete (clonedField as IRuntimeCustomField).lastExecutionLog;
			delete (clonedField as IRuntimeCustomField).lastExecutionOutput;
			delete (clonedField as IRuntimeCustomField).lastExecutionStatus;
			delete (clonedField as IRuntimeCustomField).lastExecutionDurationMs;
			delete (clonedField as IRuntimeCustomField).lastExecutedAt;
			delete (clonedField as IRuntimeCustomField).lastExecutionExitCode;
			if (clonedField.type === 'table' && (clonedField.tableDbEngine || 'sqlite') === 'sqlite' && clonedField.tableDbPath && clonedField.tableDbPath.trim()) {
				clonedField.tableRows = [];
			}

			copiedSchemaComponentClipboard = {
				field: clonedField,
				sourceModuleName: activeMod.name,
				copiedAt: Date.now()
			};
			notifyCopiedComponentChanged();

			try {
				await this._clipboardService.writeText(JSON.stringify({
					__anyagent_schema_field__: true,
					sourceModuleName: activeMod.name,
					field: clonedField
				}, null, 2));
			} catch { }

			if (btnIconEl) {
				btnIconEl.className = ThemeIcon.asClassName(Codicon.check);
				btnIconEl.style.color = '#34d399';
				setTimeout(() => {
					btnIconEl.className = ThemeIcon.asClassName(Codicon.copy);
					btnIconEl.style.color = '#38bdf8';
				}, 1500);
			}

			this.notificationService.info(
				`Copied component "${clonedField.label || clonedField.id}" (${badgeLabel}). Press Cmd+V / Ctrl+V or click Paste in any template to insert it.`
			);
		};

		const pasteCopiedComponent = async (explicitInsertAfterIndex?: number) => {
			let sourceEntry = copiedSchemaComponentClipboard;
			if (!sourceEntry) {
				try {
					const rawClip = (await this._clipboardService.readText() || '').trim();
					if (rawClip.startsWith('{') && rawClip.includes('"__anyagent_schema_field__"')) {
						const parsed = JSON.parse(rawClip);
						if (parsed && parsed.__anyagent_schema_field__ && parsed.field && parsed.field.type) {
							sourceEntry = {
								field: parsed.field as ICustomField,
								sourceModuleName: parsed.sourceModuleName,
								copiedAt: Date.now()
							};
							copiedSchemaComponentClipboard = sourceEntry;
							notifyCopiedComponentChanged();
						}
					}
				} catch { }
			}

			if (!sourceEntry || !sourceEntry.field) {
				this.notificationService.warn('No copied component in clipboard. Click the copy icon on any field component first.');
				return;
			}

			const newField: ICustomField = JSON.parse(JSON.stringify(sourceEntry.field));
			delete newField.required;
			delete (newField as IRuntimeCustomField).lastSentPrompt;
			delete (newField as IRuntimeCustomField).lastExecutionLog;
			delete (newField as IRuntimeCustomField).lastExecutionOutput;
			delete (newField as IRuntimeCustomField).lastExecutionStatus;
			delete (newField as IRuntimeCustomField).lastExecutionDurationMs;
			delete (newField as IRuntimeCustomField).lastExecutedAt;
			delete (newField as IRuntimeCustomField).lastExecutionExitCode;
			if (newField.type === 'table' && (newField.tableDbEngine || 'sqlite') === 'sqlite' && newField.tableDbPath && newField.tableDbPath.trim()) {
				newField.tableRows = [];
			}

			const existingIdsLower = new Set(fields.map(f => (f.id || '').toLowerCase()));
			const rawBaseId = ((newField.id && newField.id.toLowerCase() !== 'title') ? newField.id : (newField.label || newField.type || 'field'))
				.toLowerCase()
				.replace(/[^a-z0-9_-]/g, '_')
				.replace(/^_+|_+$/g, '') || 'field';

			let candidateId = rawBaseId;
			let suffix = 2;
			while (existingIdsLower.has(candidateId.toLowerCase()) || candidateId.toLowerCase() === 'title') {
				candidateId = `${rawBaseId}_${suffix}`;
				suffix++;
			}
			newField.id = candidateId;

			if (!newField.label || newField.label.toLowerCase() === 'title') {
				newField.label = sourceEntry.field.label && sourceEntry.field.label.toLowerCase() !== 'title'
					? sourceEntry.field.label
					: candidateId;
			}

			// Determine target insertion index (always insert AFTER the target card, never overwriting any existing card)
			const anchorIdx = explicitInsertAfterIndex !== undefined
				? explicitInsertAfterIndex
				: (hoveredFieldIndex !== null
					? hoveredFieldIndex
					: (lastInteractedFieldIndex !== null ? lastInteractedFieldIndex : fields.length - 1));

			const insertPos = Math.max(1, Math.min(fields.length, anchorIdx + 1));
			fields.splice(insertPos, 0, newField);
			lastInteractedFieldIndex = insertPos;
			newlyPastedFieldId = newField.id;

			this._syncDraft();
			const prevScroll = mainViewport.scrollTop;
			renderCanvas();
			mainViewport.scrollTop = prevScroll;

			await this._persistCurrentModule();
		};

		const isEditableOrExternalElement = (el: HTMLElement | null): boolean => {
			if (!el) {
				return false;
			}
			const tag = el.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'WEBVIEW' || tag === 'IFRAME' || el.isContentEditable) {
				return true;
			}
			if (el.closest('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"], .monaco-editor, .monaco-inputbox, .quick-input-widget, .browser-editor, .browser-url-container, .browser-url-display, .xterm')) {
				return true;
			}
			return false;
		};

		const isTargetEditorForKeyboardPaste = (evt?: Event): boolean => {
			if (!this._container || !this._container.isConnected || !this.isVisible()) {
				return false;
			}
			// When a native WebContentsView (built-in browser webpage) has focus, document.hasFocus() is false
			// or activeEditorPane is the BrowserEditor — never intercept paste!
			if (!editorWindow.document.hasFocus()) {
				return false;
			}
			if (this.group && this.group.activeEditorPane !== this) {
				return false;
			}
			const evtTarget = isHTMLElement(evt?.target) ? evt.target : null;
			const activeEl = editorWindow.document.activeElement as HTMLElement | null;

			// Never intercept paste if ANY input, textarea, contenteditable, or browser element anywhere in the workbench has focus
			if (isEditableOrExternalElement(evtTarget) || isEditableOrExternalElement(activeEl)) {
				return false;
			}
			// If focus is inside a specific element outside this editor container, do not intercept
			if (evtTarget && evtTarget !== editorWindow.document.body && evtTarget !== editorWindow.document.documentElement && !this._container.contains(evtTarget)) {
				return false;
			}
			if (activeEl && activeEl !== editorWindow.document.body && activeEl !== editorWindow.document.documentElement && !this._container.contains(activeEl)) {
				return false;
			}
			// Priority 1: active focus is directly inside this editor container
			if (activeEl && this._container.contains(activeEl)) {
				return true;
			}
			// Priority 2: mouse is hovering over this editor AND this editor was the last interacted schema editor
			if (this._container.matches(':hover') && lastInteractedSchemaEditor === this) {
				return true;
			}
			return false;
		};

		const onWindowKeyDown = (e: KeyboardEvent) => {
			if (!copiedSchemaComponentClipboard) {
				return;
			}
			const isPasteCombo = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v';
			if (!isPasteCombo) {
				return;
			}
			if (!isTargetEditorForKeyboardPaste(e)) {
				return;
			}
			const now = Date.now();
			if (now - lastKeyboardPasteTimestamp < 150) {
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			lastKeyboardPasteTimestamp = now;
			e.preventDefault();
			e.stopPropagation();
			pasteCopiedComponent().catch(() => { });
		};

		const onWindowPaste = (e: ClipboardEvent) => {
			if (!copiedSchemaComponentClipboard) {
				return;
			}
			if (!isTargetEditorForKeyboardPaste(e)) {
				return;
			}
			// If the system clipboard now holds plain text (such as a copied URL) rather than a schema field,
			// only paste component if the user is pasting on the non-input canvas
			const now = Date.now();
			if (now - lastKeyboardPasteTimestamp < 150) {
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			lastKeyboardPasteTimestamp = now;
			e.preventDefault();
			e.stopPropagation();
			pasteCopiedComponent().catch(() => { });
		};

		editorWindow.addEventListener('keydown', onWindowKeyDown, true);
		editorWindow.addEventListener('paste', onWindowPaste, true);
		this._renderCleanupFns.push(() => {
			editorWindow.removeEventListener('keydown', onWindowKeyDown, true);
			editorWindow.removeEventListener('paste', onWindowPaste, true);
		});

		// Field cards currently rendered in `rightCanvas` (reset whenever the canvas is re-rendered).
		const canvasFieldCards: HTMLElement[] = [];
		const renderCanvas = () => {
			removeAllInstantTooltips();
			this._syncDraft();
			const savedScrollTop = mainViewport ? mainViewport.scrollTop : 0;
			let didScrollToReorderedCard = false;
			clearNode(rightCanvas);
			canvasFieldCards.length = 0;
			pasteUiRefreshers.length = 0;

			if (fields.length === 0) {
				const emptyCanvas = append(rightCanvas, $('.empty-canvas', {
					style: 'flex: 1; min-height: 420px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px 24px; border: 2px dashed rgba(255, 255, 255, 0.12); border-radius: 8px; text-align: center; gap: 12px; background: rgba(0, 0, 0, 0.12); transition: all 0.2s ease;'
				}));
				emptyCanvas.ondragover = (e) => {
					e.preventDefault();
					e.stopPropagation();
					if (e.dataTransfer) { e.dataTransfer.dropEffect = 'copy'; }
					emptyCanvas.style.borderColor = '#38bdf8';
					emptyCanvas.style.background = 'rgba(56, 189, 248, 0.06)';
				};
				emptyCanvas.ondragleave = () => {
					emptyCanvas.style.borderColor = 'rgba(255, 255, 255, 0.12)';
					emptyCanvas.style.background = 'rgba(0, 0, 0, 0.12)';
				};
				emptyCanvas.ondrop = (e) => {
					e.preventDefault();
					e.stopPropagation();
					emptyCanvas.style.borderColor = 'rgba(255, 255, 255, 0.12)';
					emptyCanvas.style.background = 'rgba(0, 0, 0, 0.12)';
					handleItemDrop(undefined, 'after', e);
				};

				append(emptyCanvas, $('span' + ThemeIcon.asCSSSelector(Codicon.layout), { style: 'font-size: 36px; color: #38bdf8; opacity: 0.6;' }));
				append(emptyCanvas, $('div', { style: 'font-size: 13.5px; font-weight: 500;' }, 'Canvas is Empty'));
				append(emptyCanvas, $('div', { style: 'font-size: 11.5px; opacity: 0.65; max-width: 320px; line-height: 1.5;' }, 'Drag & drop components or reusable classes anywhere into this canvas, or click them in the library on the left.'));
				return;
			}

			// Reactive registry to refresh all Insert Output / Insert Context chip bars when any Field Label or Parameter name is edited
			const referenceChipRefreshers: Array<() => void> = [];
			const refreshAllReferenceChipBars = () => {
				referenceChipRefreshers.forEach(fn => {
					try { fn(); } catch { }
				});
			};

			const getReferenceTokensForField = (currentField: ICustomField | string): Array<{ label: string; type: string }> => {
				const allSchemaFields = fields;
				const tokens: Array<{ label: string; type: string }> = [];
				const seen = new Set<string>(['title']);
				if (isFlowchartNodeMode && input.workflowVariablesProvider) {
					try {
						const wfVars = input.workflowVariablesProvider() || [];
						wfVars.forEach(wv => {
							const wLabel = (wv.label || '').trim();
							if (wLabel && wLabel.toLowerCase() !== 'title' && !seen.has(wLabel.toLowerCase())) {
								seen.add(wLabel.toLowerCase());
								tokens.push({ label: wLabel, type: wv.type || 'WORKFLOW' });
							}
						});
					} catch { }
				}
				allSchemaFields.forEach(rf => {
					if (!rf) { return; }
					if (typeof currentField === 'object' ? rf === currentField : rf.id === currentField) { return; }
					const ft = (rf.type || '').toLowerCase();
					const fl = (rf.label || rf.id || '').trim();
					const flLower = fl.toLowerCase();
					if (!fl || ft === 'output' || ft === 'display' || flLower === 'output' || rf.id === 'title' || flLower === 'title') {
						return;
					}
					if (ft === 'parameters' && Array.isArray(rf.parameters)) {
						rf.parameters.forEach(p => {
							const pName = (p.name || '').trim();
							if (pName && pName.toLowerCase() !== 'title' && !seen.has(pName.toLowerCase())) {
								seen.add(pName.toLowerCase());
								tokens.push({ label: pName, type: 'PARAM' });
							}
						});
					}
					if (ft !== 'parameters') {
						const outVar = (rf.outputVariableName || '').trim() || generateSmartPythonVarName(fl, rf.type);
						if (outVar && outVar.toLowerCase() !== 'title' && !seen.has(outVar.toLowerCase())) {
							seen.add(outVar.toLowerCase());
							tokens.push({ label: outVar, type: ft.toUpperCase() });
						}
					}
					if (flLower !== 'title' && !seen.has(flLower)) {
						seen.add(flLower);
						tokens.push({ label: fl, type: ft.toUpperCase() });
					}
				});
				return tokens;
			};

			// Render Field Cards
			fields.forEach((field, fIdx) => {
				if (isFlowchartNodeMode && (fIdx === 0 || field.id === 'title')) {
					return;
				}
				if (isEmbeddedFieldMode && (field.id || '').toLowerCase() !== embeddedFieldId) {
					return;
				}
				const isContainer = field.type === 'dynamic_list';
				const isAttachment = field.type === 'attachment';
				const isNumber = field.type === 'number';
				const defaultBorderColor = isContainer
					? 'rgba(6, 182, 212, 0.28)'
					: (isAttachment
						? 'rgba(16, 185, 129, 0.28)'
						: (isNumber
							? 'rgba(234, 179, 8, 0.28)'
							: 'rgba(255, 255, 255, 0.12)'));
				const fieldCard = append(rightCanvas, $('.canvas-field-card', {
					style: isContainer
						? `background: rgba(6, 182, 212, 0.04); border: 1px solid ${defaultBorderColor}; border-radius: 8px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25); transition: border-color 0.15s ease, box-shadow 0.15s ease; position: relative;`
						: (isAttachment
							? `background: rgba(16, 185, 129, 0.04); border: 1px solid ${defaultBorderColor}; border-radius: 8px; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25); transition: border-color 0.15s ease, box-shadow 0.15s ease; position: relative;`
							: (isNumber
								? `background: rgba(234, 179, 8, 0.03); border: 1px solid ${defaultBorderColor}; border-radius: 8px; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25); transition: border-color 0.15s ease, box-shadow 0.15s ease; position: relative;`
								: `background: var(--vscode-editor-background, #1e1e1e); border: 1px solid ${defaultBorderColor}; border-radius: 8px; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25); transition: border-color 0.15s ease, box-shadow 0.15s ease; position: relative;`))
				}));
				canvasFieldCards.push(fieldCard);

				const isFieldDisabled = Boolean(field.disabled);
				if (isFieldDisabled) {
					fieldCard.style.opacity = '0.55';
					fieldCard.style.filter = 'grayscale(0.65)';
					fieldCard.style.borderStyle = 'dashed';
					fieldCard.style.borderColor = 'rgba(148, 163, 184, 0.35)';
				}

				fieldCard.addEventListener('mouseenter', () => {
					hoveredFieldIndex = fIdx;
				});
				fieldCard.addEventListener('mouseleave', () => {
					if (hoveredFieldIndex === fIdx) {
						hoveredFieldIndex = null;
					}
				});
				fieldCard.addEventListener('mousedown', () => {
					lastInteractedFieldIndex = fIdx;
				});

				if ((newlyPastedFieldId && field.id === newlyPastedFieldId) || (reorderedFieldId && field.id === reorderedFieldId) || (focusFieldId && field.id === focusFieldId)) {
					const isReorderedTarget = Boolean(reorderedFieldId && field.id === reorderedFieldId);
					if (newlyPastedFieldId === field.id) {
						newlyPastedFieldId = null;
					}
					if (isReorderedTarget) {
						reorderedFieldId = null;
						didScrollToReorderedCard = true;
					}
					if (focusFieldId === field.id || isReorderedTarget) {
						if (focusFieldId === field.id) {
							focusFieldId = undefined;
							input.focusFieldId = undefined;
						}
						getWindow(fieldCard).requestAnimationFrame(() => {
							try {
								if (mainViewport && fieldCard.isConnected) {
									const vpRect = mainViewport.getBoundingClientRect();
									const cardRect = fieldCard.getBoundingClientRect();
									if (cardRect.top < vpRect.top + 12 || cardRect.bottom > vpRect.bottom - 12) {
										const targetTop = Math.max(0, mainViewport.scrollTop + (cardRect.top - vpRect.top) - 24);
										mainViewport.scrollTo({ top: targetTop, behavior: 'smooth' });
									}
								}
							} catch { }
						});
					}
					fieldCard.style.borderColor = '#34d399';
					fieldCard.style.boxShadow = '0 0 0 1px rgba(52, 211, 153, 0.45), 0 4px 12px rgba(16, 185, 129, 0.2)';
					setTimeout(() => {
						if (fieldCard.isConnected) {
							fieldCard.style.borderColor = defaultBorderColor;
							fieldCard.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.25)';
						}
					}, isReorderedTarget ? 900 : 1400);
				}

				// Support dropping onto a card with precise before/after detection
				fieldCard.ondragover = (e) => {
					e.preventDefault();
					e.stopPropagation();
					if (e.dataTransfer) {
						e.dataTransfer.dropEffect = currentDraggingItem?.source === 'canvas' ? 'move' : 'copy';
					}
					const rect = fieldCard.getBoundingClientRect();
					const isTop = e.clientY < rect.top + rect.height / 2;
					if (isTop) {
						fieldCard.style.boxShadow = '0 -3px 0 0 #38bdf8, 0 2px 6px rgba(0, 0, 0, 0.25)';
						fieldCard.style.borderColor = '#38bdf8';
					} else {
						fieldCard.style.boxShadow = '0 3px 0 0 #38bdf8, 0 2px 6px rgba(0, 0, 0, 0.25)';
						fieldCard.style.borderColor = '#38bdf8';
					}
				};
				fieldCard.ondragleave = () => {
					fieldCard.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.25)';
					fieldCard.style.borderColor = defaultBorderColor;
				};
				fieldCard.ondrop = (e) => {
					e.preventDefault();
					e.stopPropagation();
					fieldCard.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.25)';
					fieldCard.style.borderColor = defaultBorderColor;
					const rect = fieldCard.getBoundingClientRect();
					const isTop = e.clientY < rect.top + rect.height / 2;
					handleItemDrop(fIdx, isTop ? 'before' : 'after', e);
				};

				const isMandatory = fIdx === 0 || field.id === 'title';

				// Card Header
				const cardHeader = append(fieldCard, $('.card-header', {
					style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;'
				}));
				const headerLeft = append(cardHeader, $('.header-left', {
					style: 'display: flex; align-items: center; gap: 10px; flex-wrap: wrap;'
				}));

				if (isMandatory) {
					const lockIcon = append(headerLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.lock), {
						style: 'font-size: 13px; color: #38bdf8; opacity: 0.85; padding: 2px 4px;'
					}));
					lockIcon.title = 'Mandatory root field (fixed position)';
				} else {
					const gripper = append(headerLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.gripper), {
						style: 'font-size: 13px; opacity: 0.55; cursor: grab; user-select: none; padding: 2px 4px;'
					}));
					gripper.title = 'Drag to reorder field';
					if (isEmbeddedFieldMode) {
						gripper.style.display = 'none';
					}
					gripper.onmousedown = () => { fieldCard.setAttribute('draggable', 'true'); };
					gripper.onmouseup = () => {
						if (!currentDraggingItem) { fieldCard.setAttribute('draggable', 'false'); }
					};
					gripper.onmouseleave = () => {
						if (!currentDraggingItem) { fieldCard.setAttribute('draggable', 'false'); }
					};
				}

				fieldCard.ondragstart = (e) => {
					const activeEl = fieldCard.ownerDocument.activeElement as HTMLElement | null;
					if (isMandatory || (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) || this._container?.classList.contains('is-selecting-input') || this._container?.classList.contains('is-selecting-box')) {
						e.preventDefault();
						fieldCard.setAttribute('draggable', 'false');
						return;
					}
					currentDraggingItem = { source: 'canvas', fromIndex: fIdx };
					e.dataTransfer?.setData('text/plain', `field:${fIdx}`);
					if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; }
					fieldCard.style.opacity = '0.4';
				};
				fieldCard.ondragend = () => {
					fieldCard.setAttribute('draggable', 'false');
					fieldCard.style.opacity = '1';
					currentDraggingItem = null;
					canvasFieldCards.forEach((card) => {
						card.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.25)';
						card.style.borderColor = defaultBorderColor;
					});
				};

				// Mandatory Badge
				if (isMandatory) {
					append(headerLeft, $('span.type-badge', {
						style: 'font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 2px 8px; border-radius: 4px; background: rgba(56, 189, 248, 0.18); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); letter-spacing: 0.04em;'
					}, 'MANDATORY ROOT'));
				}

				// Badge
				const isBrowser = field.type === 'browser';
				const isGit = field.type === 'git';
				const isPython = field.type === 'python';
				const isTable = field.type === 'table';
				const isParameters = field.type === 'parameters';
				const isPrompt = field.type === 'prompt';
				const isTts = field.type === 'tts';
				const isMediaPlayer = field.type === 'media_player';
				const isVoiceNote = field.type === 'voice_note';
				const isSubWorkflow = field.type === 'sub_workflow';
				const isHttpRequest = field.type === 'http_request';
				const isOutput = field.type === 'output';
				const isWfBuiltin = field.type === 'create_tickets' || field.type === 'run_tickets' || field.type === 'get_outputs' || field.type === 'get_ticket' || field.type === 'display';
				const wfBadgeLabels: Record<string, string> = {
					create_tickets: 'CREATE TICKETS',
					run_tickets: 'RUN TICKETS',
					get_outputs: 'GET OUTPUTS',
					get_ticket: 'GET TICKET',
					display: 'DISPLAY'
				};
				const badgeText = isContainer ? 'CONTAINER' : (isAttachment ? 'ATTACHMENT' : (isNumber ? 'NUMBER' : (isBrowser ? 'BROWSER' : (isGit ? 'GIT REPO' : (isPython ? 'PYTHON' : (isTable ? 'DATA TABLE' : (isParameters ? 'INPUTS' : (isPrompt ? 'AI PROMPT' : (isTts ? 'AUDIO / TTS' : (isMediaPlayer ? 'MP3 / MP4 PLAYER' : (isVoiceNote ? 'VOICE NOTE' : (isSubWorkflow ? 'CALL SUB-WORKFLOW' : (isHttpRequest ? 'HTTP REQUEST' : (isOutput ? 'OUTPUT' : (wfBadgeLabels[field.type] || field.type.toUpperCase())))))))))))))));
				const badgeBg = isContainer ? 'rgba(6, 182, 212, 0.18)' : (isAttachment ? 'rgba(16, 185, 129, 0.18)' : (isNumber ? 'rgba(234, 179, 8, 0.18)' : (isBrowser ? 'rgba(56, 189, 248, 0.18)' : (isGit ? 'rgba(249, 115, 22, 0.18)' : (isPython ? 'rgba(56, 189, 248, 0.15)' : (isTable ? 'rgba(20, 184, 166, 0.18)' : (isParameters ? 'rgba(168, 85, 247, 0.18)' : (isPrompt ? 'rgba(59, 130, 246, 0.18)' : (isTts ? 'rgba(236, 72, 153, 0.18)' : (isMediaPlayer ? 'rgba(245, 158, 11, 0.18)' : (isVoiceNote ? 'rgba(148, 163, 184, 0.16)' : (isSubWorkflow ? 'rgba(6, 182, 212, 0.18)' : (isHttpRequest ? 'rgba(6, 182, 212, 0.18)' : (isOutput ? 'rgba(129, 140, 248, 0.18)' : (isWfBuiltin ? 'rgba(168, 85, 247, 0.22)' : 'rgba(99, 102, 241, 0.18)')))))))))))))));
				const badgeColor = isContainer ? '#06b6d4' : (isAttachment ? '#10b981' : (isNumber ? '#facc15' : (isBrowser ? '#38bdf8' : (isGit ? '#f97316' : (isPython ? '#38bdf8' : (isTable ? '#2dd4bf' : (isParameters ? '#c084fc' : (isPrompt ? '#60a5fa' : (isTts ? '#f472b6' : (isMediaPlayer ? '#fbbf24' : (isVoiceNote ? '#cbd5e1' : (isSubWorkflow ? '#22d3ee' : (isHttpRequest ? '#06b6d4' : (isOutput ? '#818cf8' : (isWfBuiltin ? '#d8b4fe' : '#818cf8')))))))))))))));
				const badgeBorder = isContainer ? 'rgba(6, 182, 212, 0.35)' : (isAttachment ? 'rgba(16, 185, 129, 0.35)' : (isNumber ? 'rgba(234, 179, 8, 0.35)' : (isBrowser ? 'rgba(56, 189, 248, 0.35)' : (isGit ? 'rgba(249, 115, 22, 0.35)' : (isPython ? 'rgba(56, 189, 248, 0.35)' : (isTable ? 'rgba(20, 184, 166, 0.4)' : (isParameters ? 'rgba(168, 85, 247, 0.35)' : (isPrompt ? 'rgba(59, 130, 246, 0.35)' : (isTts ? 'rgba(236, 72, 153, 0.35)' : (isMediaPlayer ? 'rgba(251, 191, 36, 0.35)' : (isVoiceNote ? 'rgba(148, 163, 184, 0.34)' : (isSubWorkflow ? 'rgba(34, 211, 238, 0.42)' : (isHttpRequest ? 'rgba(6, 182, 212, 0.4)' : (isOutput ? 'rgba(129, 140, 248, 0.35)' : (isWfBuiltin ? 'rgba(168, 85, 247, 0.45)' : 'rgba(99, 102, 241, 0.35)')))))))))))))));

				append(headerLeft, $('span.type-badge', {
					style: `font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 2px 8px; border-radius: 4px; background: ${badgeBg}; color: ${badgeColor}; border: 1px solid ${badgeBorder}; letter-spacing: 0.04em;`
				}, badgeText));

				if (field.componentRef) {
					append(headerLeft, $('span.class-badge', {
						style: 'font-size: 9.5px; font-weight: 600; padding: 2px 7px; border-radius: 4px; background: rgba(6, 182, 212, 0.12); color: #22d3ee; border: 1px solid rgba(6, 182, 212, 0.25);'
					}, `CLASS: ${field.label}`));
				}

				// Info button (circle with 'i') opening primitive usage guide & RUN_TICKETS execution behavior
				const infoCircleBtn = append(headerLeft, $('span.primitive-info-circle-btn', {
					style: 'display: inline-flex; align-items: center; justify-content: center; width: 19px; height: 19px; border-radius: 50%; border: 1px solid rgba(56, 189, 248, 0.45); color: #38bdf8; background: rgba(56, 189, 248, 0.08); font-size: 11px; cursor: pointer; transition: all 0.15s ease; user-select: none; margin-left: 2px;',
					title: `View ${field.label || field.type} usage guide & RUN_TICKETS execution behavior`
				}));
				append(infoCircleBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.info)));
				infoCircleBtn.onmouseenter = () => {
					infoCircleBtn.style.background = 'rgba(56, 189, 248, 0.22)';
					infoCircleBtn.style.borderColor = '#38bdf8';
					infoCircleBtn.style.transform = 'scale(1.12)';
				};
				infoCircleBtn.onmouseleave = () => {
					infoCircleBtn.style.background = 'rgba(56, 189, 248, 0.08)';
					infoCircleBtn.style.borderColor = 'rgba(56, 189, 248, 0.45)';
					infoCircleBtn.style.transform = 'scale(1)';
				};
				infoCircleBtn.onclick = (e) => {
					e.stopPropagation();
					e.preventDefault();
					showPrimitiveHelpModal(this._container!, field.type, field.label || field.id, field.componentRef);
				};

				const disabledBadge = append(headerLeft, $('span.field-disabled-status-badge', {
					style: `font-size: 9.5px; font-weight: 700; padding: 2px 7px; border-radius: 4px; background: rgba(148, 163, 184, 0.16); color: #94a3b8; border: 1px dashed rgba(148, 163, 184, 0.45); letter-spacing: 0.04em; margin-left: 2px; display: ${isFieldDisabled ? 'inline-block' : 'none'};`
				}, 'DISABLED (SKIPPED)'));

				let propagateLabelRenameInModule: (oldLbl: string, newLbl: string) => void = () => { };

				const headerRight = append(cardHeader, $('.header-right', {
					style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-left: auto;'
				}));

				// Paste Component Below button (available on every card including Root Title whenever a component is copied)
				const pasteBelowBtn = append(headerRight, $('span' + ThemeIcon.asCSSSelector(Codicon.clippy), {
					style: `cursor: pointer; font-size: 12px; color: #c084fc; opacity: 0.85; padding: 2px 4px; border-radius: 4px; background: rgba(192, 132, 252, 0.12); border: 1px solid rgba(192, 132, 252, 0.3); display: ${copiedSchemaComponentClipboard ? 'inline-flex' : 'none'}; align-items: center; justify-content: center; transition: all 0.15s ease;`
				}));
				this._attachInstantTooltip(
					pasteBelowBtn,
					() => copiedSchemaComponentClipboard
						? `Paste Below: Insert copied "${copiedSchemaComponentClipboard.field.label || copiedSchemaComponentClipboard.field.id}" below this field (⌘V)`
						: 'Paste Component Below',
					'#c084fc'
				);
				pasteBelowBtn.onmouseenter = () => {
					pasteBelowBtn.style.opacity = '1';
					pasteBelowBtn.style.background = 'rgba(192, 132, 252, 0.22)';
				};
				pasteBelowBtn.onmouseleave = () => {
					pasteBelowBtn.style.opacity = '0.85';
					pasteBelowBtn.style.background = 'rgba(192, 132, 252, 0.12)';
				};
				pasteBelowBtn.onclick = (e) => {
					e.stopPropagation();
					pasteCopiedComponent(fIdx).catch(() => { });
				};
				pasteUiRefreshers.push(() => {
					pasteBelowBtn.style.display = copiedSchemaComponentClipboard ? 'inline-flex' : 'none';
				});

				if (isMandatory) {
					append(headerRight, $('span', {
						style: 'font-size: 11px; color: rgba(255, 255, 255, 0.45); font-style: italic;'
					}, 'Required Root Field'));
				} else {
					// 1. Move Up / Down
					const canMoveUp = fIdx > 1;
					const upBtn = append(headerRight, $('button.field-reorder-up-btn', {
						style: `cursor: ${canMoveUp ? 'pointer' : 'default'}; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none; color: inherit; font-size: 12px; opacity: ${canMoveUp ? '0.75' : '0.2'}; padding: 0; border-radius: 4px; transition: all 0.15s ease; outline: none; flex-shrink: 0;`
					}));
					upBtn.type = 'button';
					upBtn.disabled = !canMoveUp;
					upBtn.title = 'Move Up';
					append(upBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowUp), { style: 'font-size: 12px; pointer-events: none;' }));
					upBtn.onmouseenter = () => { if (canMoveUp) { upBtn.style.opacity = '1'; upBtn.style.background = 'rgba(255, 255, 255, 0.12)'; } };
					upBtn.onmouseleave = () => { if (canMoveUp) { upBtn.style.opacity = '0.75'; upBtn.style.background = 'transparent'; } };
					upBtn.onmousedown = (e) => {
						e.preventDefault();
						e.stopPropagation();
					};
					upBtn.onclick = (e) => {
						e.preventDefault();
						e.stopPropagation();
						const curIdx = fields.indexOf(field);
						if (curIdx > 1) {
							const temp = fields[curIdx];
							fields[curIdx] = fields[curIdx - 1];
							fields[curIdx - 1] = temp;
							activeMod.fields = fields;
							reorderedFieldId = field.id;
							renderCanvas();
							if (!isFlowchartNodeMode) {
								this._persistCurrentModule().catch(() => { });
							}
						}
					};

					const canMoveDown = fIdx < fields.length - 1;
					const downBtn = append(headerRight, $('button.field-reorder-down-btn', {
						style: `cursor: ${canMoveDown ? 'pointer' : 'default'}; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none; color: inherit; font-size: 12px; opacity: ${canMoveDown ? '0.75' : '0.2'}; padding: 0; border-radius: 4px; transition: all 0.15s ease; outline: none; flex-shrink: 0;`
					}));
					downBtn.type = 'button';
					downBtn.disabled = !canMoveDown;
					downBtn.title = 'Move Down';
					append(downBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowDown), { style: 'font-size: 12px; pointer-events: none;' }));
					downBtn.onmouseenter = () => { if (canMoveDown) { downBtn.style.opacity = '1'; downBtn.style.background = 'rgba(255, 255, 255, 0.12)'; } };
					downBtn.onmouseleave = () => { if (canMoveDown) { downBtn.style.opacity = '0.75'; downBtn.style.background = 'transparent'; } };
					downBtn.onmousedown = (e) => {
						e.preventDefault();
						e.stopPropagation();
					};
					downBtn.onclick = (e) => {
						e.preventDefault();
						e.stopPropagation();
						const curIdx = fields.indexOf(field);
						if (curIdx >= 1 && curIdx < fields.length - 1) {
							const temp = fields[curIdx];
							fields[curIdx] = fields[curIdx + 1];
							fields[curIdx + 1] = temp;
							activeMod.fields = fields;
							reorderedFieldId = field.id;
							renderCanvas();
							if (!isFlowchartNodeMode) {
								this._persistCurrentModule().catch(() => { });
							}
						}
					};

					// 2. Enable / Disable Component Toggle Pill
					const toggleEnableBtn = append(headerRight, $('button.field-enable-toggle-btn', {
						style: `cursor: pointer; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px; border: 1px solid; transition: all 0.15s ease; outline: none; margin: 0 2px; user-select: none; ` +
							(isFieldDisabled
								? 'background: rgba(148, 163, 184, 0.12); color: #94a3b8; border-color: rgba(148, 163, 184, 0.35);'
								: 'background: rgba(34, 197, 94, 0.15); color: #4ade80; border-color: rgba(34, 197, 94, 0.4);')
					}));
					toggleEnableBtn.type = 'button';
					toggleEnableBtn.title = isFieldDisabled
						? 'Component is Disabled (Skipped during execution). Click to Enable.'
						: 'Component is Enabled (Active during execution). Click to Disable.';
					const toggleIconSpan = append(toggleEnableBtn, $('span' + ThemeIcon.asCSSSelector(isFieldDisabled ? Codicon.circleSlash : Codicon.check), {
						style: 'font-size: 11px;'
					}));
					const toggleTextSpan = append(toggleEnableBtn, $('span', {}, isFieldDisabled ? 'Disabled' : 'Enabled'));

					toggleEnableBtn.onmouseenter = () => {
						toggleEnableBtn.style.opacity = '1';
						if (field.disabled) {
							toggleEnableBtn.style.background = 'rgba(148, 163, 184, 0.22)';
						} else {
							toggleEnableBtn.style.background = 'rgba(34, 197, 94, 0.25)';
						}
					};
					toggleEnableBtn.onmouseleave = () => {
						toggleEnableBtn.style.opacity = '0.9';
						if (field.disabled) {
							toggleEnableBtn.style.background = 'rgba(148, 163, 184, 0.12)';
						} else {
							toggleEnableBtn.style.background = 'rgba(34, 197, 94, 0.15)';
						}
					};
					toggleEnableBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						field.disabled = !field.disabled;
						const nowDisabled = Boolean(field.disabled);

						fieldCard.style.opacity = nowDisabled ? '0.55' : '1';
						fieldCard.style.filter = nowDisabled ? 'grayscale(0.65)' : 'none';
						fieldCard.style.borderStyle = nowDisabled ? 'dashed' : 'solid';
						fieldCard.style.borderColor = nowDisabled ? 'rgba(148, 163, 184, 0.35)' : defaultBorderColor;

						disabledBadge.style.display = nowDisabled ? 'inline-block' : 'none';

						toggleEnableBtn.title = nowDisabled
							? 'Component is Disabled (Skipped during execution). Click to Enable.'
							: 'Component is Enabled (Active during execution). Click to Disable.';
						toggleEnableBtn.style.background = nowDisabled ? 'rgba(148, 163, 184, 0.12)' : 'rgba(34, 197, 94, 0.15)';
						toggleEnableBtn.style.color = nowDisabled ? '#94a3b8' : '#4ade80';
						toggleEnableBtn.style.borderColor = nowDisabled ? 'rgba(148, 163, 184, 0.35)' : 'rgba(34, 197, 94, 0.4)';

						toggleIconSpan.className = ThemeIcon.asClassName(nowDisabled ? Codicon.circleSlash : Codicon.check);
						toggleTextSpan.textContent = nowDisabled ? 'Disabled' : 'Enabled';

						this._syncDraft();
						if (!isFlowchartNodeMode) {
							await this._persistCurrentModule();
						}
					};

					// 3. Duplicate / Copy Component button
					const copyFieldBtn = append(headerRight, $('button.field-copy-btn', {
						type: 'button',
						style: 'cursor: pointer; font-size: 13px; color: #38bdf8; background: transparent; border: 1px solid transparent; opacity: 0.85; padding: 3px 5px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; transition: all 0.15s ease;'
					}));
					const copyIcon = append(copyFieldBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy)));
					this._attachInstantTooltip(
						copyFieldBtn,
						`Duplicate Component: Clone "${field.label || field.id}" directly below (⌘C / ⌘V)`,
						'#38bdf8'
					);
					copyFieldBtn.onmouseenter = () => {
						copyFieldBtn.style.opacity = '1';
						copyFieldBtn.style.background = 'rgba(56, 189, 248, 0.18)';
						copyFieldBtn.style.borderColor = 'rgba(56, 189, 248, 0.35)';
					};
					copyFieldBtn.onmouseleave = () => {
						copyFieldBtn.style.opacity = '0.85';
						copyFieldBtn.style.background = 'transparent';
						copyFieldBtn.style.borderColor = 'transparent';
					};
					copyFieldBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						try {
							const clonedField: ICustomField = JSON.parse(JSON.stringify(field));
							clonedField.id = 'f_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
							if (clonedField.label) {
								clonedField.label = `${clonedField.label} (Copy)`;
							}
							if (clonedField.outputVariableName) {
								clonedField.outputVariableName = generateSmartPythonVarName(clonedField.label || clonedField.id, clonedField.type);
							}
							delete (clonedField as IRuntimeCustomField).lastSentPrompt;
							delete (clonedField as IRuntimeCustomField).lastExecutionLog;
							delete (clonedField as IRuntimeCustomField).lastExecutionOutput;
							delete (clonedField as IRuntimeCustomField).lastExecutionStatus;
							delete (clonedField as IRuntimeCustomField).lastExecutionDurationMs;
							delete (clonedField as IRuntimeCustomField).lastExecutedAt;
							delete (clonedField as IRuntimeCustomField).lastExecutionExitCode;
							delete clonedField.pythonOutput;
							delete clonedField.pythonResult;

							const realIdx = fields.indexOf(field);
							const insertIdx = realIdx !== -1 ? realIdx + 1 : fields.length;
							fields.splice(insertIdx, 0, clonedField);
							copyFieldComponent(field, badgeText, copyIcon).catch(() => { });
							this._syncDraft();
							const savedScroll = mainViewport ? mainViewport.scrollTop : 0;
							renderCanvas();
							if (mainViewport) {
								mainViewport.scrollTop = savedScroll;
							}
							if (!isFlowchartNodeMode) {
								await this._persistCurrentModule();
							}
						} catch (err) {
							console.error('[CustomModuleSchemaEditor] Failed to duplicate component:', err);
						}
					};

					// 4. Delete button
					const delBtn = append(headerRight, $('button.field-delete-btn', {
						type: 'button',
						style: 'cursor: pointer; font-size: 13px; color: #ef4444; background: transparent; border: 1px solid transparent; opacity: 0.85; padding: 3px 5px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; transition: all 0.15s ease;'
					}));
					append(delBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
					delBtn.title = isFlowchartNodeMode ? 'Remove Component from Node' : 'Remove Component (Requires Confirmation)';
					if (isEmbeddedFieldMode) {
						// Only this component is shown: moving, duplicating and removing it is done by the host page
						for (const structureBtn of [upBtn, downBtn, copyFieldBtn, delBtn]) {
							structureBtn.style.display = 'none';
						}
					}
					delBtn.onmouseenter = () => {
						delBtn.style.opacity = '1';
						delBtn.style.background = 'rgba(239, 68, 68, 0.18)';
						delBtn.style.borderColor = 'rgba(239, 68, 68, 0.35)';
					};
					delBtn.onmouseleave = () => {
						delBtn.style.opacity = '0.85';
						delBtn.style.background = 'transparent';
						delBtn.style.borderColor = 'transparent';
					};
					delBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						const fieldName = field.label || field.id || `Component`;
						if (!isFlowchartNodeMode) {
							try {
								const confirmRes = await this.dialogService.confirm({
									type: 'warning',
									title: 'Confirm Delete Component',
									message: `Are you sure you want to delete the [${badgeText}] component "${fieldName}"?`,
									detail: `This will remove "${fieldName}" and its configuration from template "${activeMod.name}".`,
									primaryButton: 'Delete Component',
									cancelButton: 'Cancel'
								});
								if (!confirmRes.confirmed) {
									return;
								}
							} catch (err) {
								console.warn('[CustomModuleSchemaEditor] Dialog confirmation bypassed or failed:', err);
							}
						}
						const realIdx = fields.indexOf(field);
						if (realIdx !== -1) {
							fields.splice(realIdx, 1);
						}
						this._syncDraft();
						const savedScroll = mainViewport ? mainViewport.scrollTop : 0;
						renderCanvas();
						if (mainViewport) {
							mainViewport.scrollTop = savedScroll;
						}
						if (!isFlowchartNodeMode) {
							await this._persistCurrentModule();
						}
					};
				}

				// Field Label Input Row
				const labelRow = append(fieldCard, $('.field-label-row', {
					style: 'display: flex; align-items: center; gap: 10px; flex-wrap: wrap;'
				}));
				append(labelRow, $('span', { style: 'font-size: 11.5px; opacity: 0.8; font-weight: 500; min-width: 75px;' }, 'Field Label:'));
				const labelInput = append(labelRow, $('input.monaco-inputbox', {
					style: 'flex: 1; min-width: 140px; padding: 6px 10px; font-size: 12px; font-weight: 500; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.25); color: inherit;'
				})) as HTMLInputElement;
				labelInput.value = field.label || field.id;

				const hasOutputVariable = !isMandatory && field.type !== 'parameters' && field.type !== 'output' && field.type !== 'display';
				if (hasOutputVariable && !field.outputVariableName) {
					field.outputVariableName = generateSmartPythonVarName(field.label || field.id, field.type);
				}

				let outputVarInput: HTMLInputElement | undefined;
				let outputVarAutoBadge: HTMLElement | undefined;

				if (isMandatory) {
					labelInput.readOnly = true;
					labelInput.style.opacity = '0.7';
					labelInput.style.cursor = 'not-allowed';
					labelInput.title = 'Mandatory field name is fixed';
				} else {
					let lastCommittedLabel = (field.label || field.id || '').trim();
					let lastCommittedOutVar = (field.outputVariableName || '').trim();
					propagateLabelRenameInModule = (oldLbl: string, newLbl: string) => {
						if (this._activeModule) {
							propagateComponentLabelRename(this._activeModule.fields || [], field, oldLbl, newLbl);
						}
					};
					labelInput.oninput = () => {
						field.label = labelInput.value.trim() || `Field_${fIdx + 1}`;
						cardTitleText.textContent = field.label;
						if (hasOutputVariable && !field.outputVariableManual) {
							const nextAutoVar = generateSmartPythonVarName(field.label, field.type);
							field.outputVariableName = nextAutoVar;
							if (outputVarInput) {
								outputVarInput.value = nextAutoVar;
							}
						}
						this._syncDraft();
						refreshAllReferenceChipBars();
					};
					labelInput.onblur = () => {
						const newLabel = labelInput.value.trim() || `Field_${fIdx + 1}`;
						field.label = newLabel;
						cardTitleText.textContent = newLabel;
						if (hasOutputVariable && !field.outputVariableManual) {
							const nextAutoVar = generateSmartPythonVarName(newLabel, field.type);
							field.outputVariableName = nextAutoVar;
							if (outputVarInput) {
								outputVarInput.value = nextAutoVar;
							}
							if (lastCommittedOutVar && lastCommittedOutVar !== nextAutoVar) {
								propagateLabelRenameInModule(lastCommittedOutVar, nextAutoVar);
								lastCommittedOutVar = nextAutoVar;
							}
						}
						if (lastCommittedLabel && lastCommittedLabel !== newLabel) {
							propagateLabelRenameInModule(lastCommittedLabel, newLabel);
							lastCommittedLabel = newLabel;
						}
						this._syncDraft();
						refreshAllReferenceChipBars();
						this._persistCurrentModule().catch(() => { });
					};

					// Output Variable Name Row (Right below Field Label)
					if (hasOutputVariable) {
						const outVarRow = append(fieldCard, $('.field-output-var-row', {
							style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: -2px;'
						}));
						const outVarLabelWrap = append(outVarRow, $('span', {
							style: 'font-size: 11px; color: #38bdf8; opacity: 0.9; font-weight: 600; min-width: 75px; display: inline-flex; align-items: center; gap: 4px;',
							title: 'Python variable name that stores the execution result of this component'
						}));
						append(outVarLabelWrap, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolVariable), { style: 'font-size: 12px;' }));
						append(outVarLabelWrap, $('span', {}, 'Output Var:'));

						const outVarInputWrap = append(outVarRow, $('div', {
							style: 'flex: 1; min-width: 150px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;'
						}));
						outputVarInput = append(outVarInputWrap, $('input.monaco-inputbox', {
							placeholder: generateSmartPythonVarName(field.label || field.id, field.type),
							title: 'Edit Python output variable name (or click Auto to smart-derive from Field Label)',
							style: 'flex: 1; min-width: 120px; padding: 4px 9px; font-size: 11.5px; font-weight: 600; font-family: var(--vscode-editor-font-family, monospace); border-radius: 5px; border: 1px solid rgba(56, 189, 248, 0.35); background: rgba(14, 165, 233, 0.08); color: #7dd3fc;'
						})) as HTMLInputElement;
						outputVarInput.value = field.outputVariableName || generateSmartPythonVarName(field.label || field.id, field.type);

						outputVarAutoBadge = append(outVarInputWrap, $('button', {
							type: 'button',
							style: `padding: 3px 8px; font-size: 10px; font-weight: 600; border-radius: 4px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; transition: all 0.15s ease; ${field.outputVariableManual ? 'border: 1px solid rgba(255, 255, 255, 0.18); background: rgba(255, 255, 255, 0.06); color: #94a3b8;' : 'border: 1px solid rgba(52, 211, 153, 0.4); background: rgba(52, 211, 153, 0.12); color: #34d399;'}`,
							title: 'Click to auto-generate a concise programmer-style variable name from Field Label'
						}));
						append(outputVarAutoBadge, $('span' + ThemeIcon.asCSSSelector(Codicon.sparkle), { style: 'font-size: 10px;' }));
						const autoBadgeText = append(outputVarAutoBadge, $('span', {}, field.outputVariableManual ? 'Auto' : 'Auto ✓'));

						const copyVarBtn = append(outVarInputWrap, $('button', {
							type: 'button',
							style: 'padding: 3px 7px; font-size: 10px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.14); background: rgba(255, 255, 255, 0.05); color: #cbd5e1; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;',
							title: 'Copy variable name to clipboard for use in Python steps or Prompts'
						}));
						append(copyVarBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy), { style: 'font-size: 10px;' }));
						append(copyVarBtn, $('span', {}, 'Copy'));

						const updateAutoBadgeStyle = () => {
							if (!outputVarAutoBadge) { return; }
							if (field.outputVariableManual) {
								outputVarAutoBadge.style.border = '1px solid rgba(255, 255, 255, 0.18)';
								outputVarAutoBadge.style.background = 'rgba(255, 255, 255, 0.06)';
								outputVarAutoBadge.style.color = '#94a3b8';
								autoBadgeText.textContent = 'Auto';
							} else {
								outputVarAutoBadge.style.border = '1px solid rgba(52, 211, 153, 0.4)';
								outputVarAutoBadge.style.background = 'rgba(52, 211, 153, 0.12)';
								outputVarAutoBadge.style.color = '#34d399';
								autoBadgeText.textContent = 'Auto ✓';
							}
						};

						outputVarInput.oninput = () => {
							if (!outputVarInput) { return; }
							const rawTyped = outputVarInput.value.trim();
							const autoCandidate = generateSmartPythonVarName(field.label || field.id, field.type);
							field.outputVariableManual = rawTyped.length > 0 && rawTyped !== autoCandidate;
							field.outputVariableName = rawTyped ? sanitizePythonVarName(rawTyped, field.type) : autoCandidate;
							updateAutoBadgeStyle();
							this._syncDraft();
							refreshAllReferenceChipBars();
						};

						outputVarInput.onblur = () => {
							if (!outputVarInput) { return; }
							const rawTyped = outputVarInput.value.trim();
							const autoCandidate = generateSmartPythonVarName(field.label || field.id, field.type);
							const finalVar = rawTyped ? sanitizePythonVarName(rawTyped, field.type) : autoCandidate;
							field.outputVariableManual = rawTyped.length > 0 && finalVar !== autoCandidate;
							field.outputVariableName = finalVar;
							outputVarInput.value = finalVar;
							if (lastCommittedOutVar && lastCommittedOutVar !== finalVar) {
								propagateLabelRenameInModule(lastCommittedOutVar, finalVar);
								lastCommittedOutVar = finalVar;
							}
							updateAutoBadgeStyle();
							this._syncDraft();
							refreshAllReferenceChipBars();
							this._persistCurrentModule().catch(() => { });
						};

						outputVarAutoBadge.onclick = (e) => {
							e.preventDefault();
							e.stopPropagation();
							field.outputVariableManual = false;
							const nextAuto = generateSmartPythonVarName(field.label || field.id, field.type);
							if (lastCommittedOutVar && lastCommittedOutVar !== nextAuto) {
								propagateLabelRenameInModule(lastCommittedOutVar, nextAuto);
								lastCommittedOutVar = nextAuto;
							}
							field.outputVariableName = nextAuto;
							if (outputVarInput) {
								outputVarInput.value = nextAuto;
							}
							updateAutoBadgeStyle();
							this._syncDraft();
							refreshAllReferenceChipBars();
							this._persistCurrentModule().catch(() => { });
						};

						copyVarBtn.onclick = (e) => {
							e.preventDefault();
							e.stopPropagation();
							const varToCopy = field.outputVariableName || generateSmartPythonVarName(field.label || field.id, field.type);
							this._clipboardService.writeText(varToCopy);
							this.notificationService.info(`Copied output variable: ${varToCopy}`);
						};
					}
				}

				// Number Input Settings (Unit & Precision)
				if (isNumber) {
					if (field.precision === undefined) {
						field.precision = 2;
					}
					const numConfigBox = append(fieldCard, $('.number-config-box', {
						style: 'display: flex; flex-direction: column; gap: 8px; background: rgba(0, 0, 0, 0.2); padding: 10px 12px; border-radius: 6px; border: 1px solid rgba(234, 179, 8, 0.2);'
					}));

					const numTop = append(numConfigBox, $('div', {
						style: 'display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;'
					}));
					const numTitle = append(numTop, $('div', {
						style: 'font-size: 10.5px; font-weight: 700; text-transform: uppercase; color: #facc15; letter-spacing: 0.05em; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;'
					}));
					append(numTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolNumber)));
					append(numTitle, $('span', {}, 'Numeric Settings (Unit & Precision):'));

					const previewBadge = append(numTop, $('div.number-preview-badge', {
						style: 'font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; background: rgba(234, 179, 8, 0.15); color: #facc15; border: 1px solid rgba(234, 179, 8, 0.3); font-variant-numeric: tabular-nums;'
					}));

					const updatePreview = () => {
						const prec = field.precision !== undefined ? field.precision : 2;
						const sampleVal = (1250.5).toLocaleString('en-US', {
							minimumFractionDigits: prec,
							maximumFractionDigits: prec
						});
						const unit = (field.unit || '').trim();
						if (unit) {
							if (/^[$\u20AC\u00A5\u00A3\u20B9\u20BD\u20BF]/.test(unit)) {
								previewBadge.textContent = `Preview: ${unit}${sampleVal}`;
							} else {
								previewBadge.textContent = `Preview: ${sampleVal} ${unit}`;
							}
						} else {
							previewBadge.textContent = `Preview: ${sampleVal}`;
						}
					};
					updatePreview();

					const inputsRow = append(numConfigBox, $('div', {
						style: 'display: flex; align-items: center; gap: 14px; flex-wrap: wrap;'
					}));

					// Unit / Suffix input
					const unitWrap = append(inputsRow, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
					append(unitWrap, $('label', { style: 'font-size: 11px; opacity: 0.75;' }, 'Unit / Suffix:'));
					const unitInput = append(unitWrap, $('input.monaco-inputbox', {
						placeholder: 'e.g. $, kg, %, USD',
						style: 'width: 130px; padding: 4px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.3); color: inherit;'
					})) as HTMLInputElement;
					unitInput.value = field.unit || '';
					unitInput.oninput = () => {
						field.unit = unitInput.value;
						updatePreview();
					};

					// Decimal Precision select
					const precWrap = append(inputsRow, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
					append(precWrap, $('label', { style: 'font-size: 11px; opacity: 0.75;' }, 'Decimals:'));
					const precSelect = append(precWrap, $('select.monaco-select', {
						style: 'padding: 4px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.15); background: #1a1a1a; color: inherit; cursor: pointer;'
					})) as HTMLSelectElement;

					const precOptions = [
						{ val: 0, text: '0 (Integer, e.g. 1,251)' },
						{ val: 1, text: '1 Decimal (e.g. 1,250.5)' },
						{ val: 2, text: '2 Decimals (e.g. 1,250.50) [Default]' },
						{ val: 3, text: '3 Decimals (e.g. 1,250.500)' },
						{ val: 4, text: '4 Decimals (e.g. 1,250.5000)' }
					];
					precOptions.forEach(opt => {
						const o = append(precSelect, $('option', { value: String(opt.val) }, opt.text)) as HTMLOptionElement;
						if (opt.val === (field.precision !== undefined ? field.precision : 2)) {
							o.selected = true;
						}
					});
					precSelect.onchange = () => {
						field.precision = parseInt(precSelect.value, 10);
						updatePreview();
					};
				}

				// Select / Multiselect Options Management
				if (field.type === 'select' || field.type === 'multiselect') {
					const optContainer = append(fieldCard, $('.options-manager', {
						style: 'display: flex; flex-direction: column; gap: 6px; background: rgba(0, 0, 0, 0.2); padding: 10px; border-radius: 6px;'
					}));
					append(optContainer, $('div', { style: 'font-size: 10.5px; font-weight: 600; opacity: 0.7; text-transform: uppercase;' }, 'CHOICES / OPTIONS:'));

					if (!field.options) {
						field.options = ['Option 1', 'Option 2'];
					}

					const chipsBox = append(optContainer, $('.chips-box', {
						style: 'display: flex; flex-wrap: wrap; gap: 6px; align-items: center;'
					}));

					const renderChips = () => {
						clearNode(chipsBox);
						field.options!.forEach((opt, oIdx) => {
							const chip = append(chipsBox, $('.option-chip', {
								style: 'background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 12px; padding: 3px 10px; font-size: 11px; display: flex; align-items: center; gap: 6px;'
							}));
							append(chip, $('span', {}, opt));
							const removeX = append(chip, $('span', { style: 'cursor: pointer; opacity: 0.6; font-size: 11px;' }, '\u2715'));
							removeX.onclick = () => {
								field.options!.splice(oIdx, 1);
								renderChips();
							};
						});

						// Add option inline
						const addInput = append(chipsBox, $('input.monaco-inputbox', {
							placeholder: '+ Add Option',
							style: 'width: 100px; padding: 3px 8px; font-size: 11px; border-radius: 12px; border: 1px dashed rgba(255, 255, 255, 0.2); background: transparent; color: inherit;'
						})) as HTMLInputElement;
						addInput.onkeydown = (e) => {
							if (e.key === 'Enter' && addInput.value.trim()) {
								field.options!.push(addInput.value.trim());
								addInput.value = '';
								renderChips();
							}
						};
					};
					renderChips();
				}

				// Attachment Upload Preview Box
				if (isAttachment) {
					const attachPreview = append(fieldCard, $('.attachment-schema-preview', {
						style: 'display: flex; flex-direction: column; gap: 8px; background: rgba(0, 0, 0, 0.2); padding: 12px 14px; border-radius: 6px; border: 1.5px dashed rgba(16, 185, 129, 0.3);'
					}));
					const previewTop = append(attachPreview, $('div', { style: 'display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;' }));
					const previewLeft = append(previewTop, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: #10b981; font-size: 11px; font-weight: 600; text-transform: uppercase;' }));
					append(previewLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.files)));
					append(previewLeft, $('span', {}, 'Attachment Upload Zone (Single / Multi Files)'));
					append(previewTop, $('span', { style: 'font-size: 10px; opacity: 0.6;' }, 'PNG, JPG, PDF, Documents'));

					const mockDrop = append(attachPreview, $('div', {
						style: 'display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px; background: rgba(16, 185, 129, 0.04); border-radius: 4px; font-size: 11px; opacity: 0.8;'
					}));
					append(mockDrop, $('span' + ThemeIcon.asCSSSelector(Codicon.cloudUpload), { style: 'font-size: 15px; color: #10b981;' }));
					append(mockDrop, $('span', {}, 'Allows users to upload one or multiple files/images/PDFs when creating or editing entities'));
				}

				// Dynamic Container (List) Sub-fields Canvas
				if (isContainer) {
					const subCanvas = append(fieldCard, $('.subfields-canvas', {
						style: 'padding: 12px 14px; background: rgba(0, 0, 0, 0.25); border: 1.5px dashed rgba(6, 182, 212, 0.3); border-radius: 6px; display: flex; flex-direction: column; gap: 8px;'
					}));

					const renderSubFieldsList = () => {
						clearNode(subCanvas);
						const subHeader = append(subCanvas, $('div', {
							style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 2px;'
						}));
						append(subHeader, $('div', {
							style: 'font-size: 10.5px; font-weight: 700; text-transform: uppercase; color: #06b6d4; letter-spacing: 0.05em;'
						}, 'Composite Item Template (Sub-Fields):'));

						if (!field.itemFields) {
							field.itemFields = [];
						}

						if (field.itemFields.length === 0) {
							append(subCanvas, $('div', {
								style: 'font-size: 11px; opacity: 0.5; font-style: italic; padding: 6px 0;'
							}, 'No sub-fields defined. Click "+ Add Sub-Field" below to configure template items.'));
						}

						field.itemFields.forEach((subF, sIdx) => {
							const subCard = append(subCanvas, $('.subfield-card', {
								style: 'padding: 8px 10px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; display: flex; flex-direction: column; gap: 6px;'
							}));

							const subTop = append(subCard, $('.sub-top', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 6px; flex-wrap: wrap;' }));
							append(subTop, $('span', {
								style: 'font-size: 9.5px; font-weight: 700; text-transform: uppercase; padding: 2px 6px; border-radius: 4px; background: rgba(56, 189, 248, 0.15); color: #38bdf8;'
							}, subF.type.replace(/_/g, ' ')));

							const subActs = append(subTop, $('.sub-actions', { style: 'display: flex; gap: 6px; align-items: center; margin-left: auto;' }));
							if (sIdx > 0) {
								const uB = append(subActs, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowUp), { style: 'cursor: pointer; opacity: 0.6; font-size: 11px;' }));
								uB.title = 'Move Sub-Field Up';
								uB.onclick = () => {
									const [sf] = field.itemFields!.splice(sIdx, 1);
									field.itemFields!.splice(sIdx - 1, 0, sf);
									renderSubFieldsList();
								};
							}
							if (sIdx < field.itemFields!.length - 1) {
								const dB = append(subActs, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowDown), { style: 'cursor: pointer; opacity: 0.6; font-size: 11px;' }));
								dB.title = 'Move Sub-Field Down';
								dB.onclick = () => {
									const [sf] = field.itemFields!.splice(sIdx, 1);
									field.itemFields!.splice(sIdx + 1, 0, sf);
									renderSubFieldsList();
								};
							}
							const dBtn = append(subActs, $('button', {
								type: 'button',
								title: isFlowchartNodeMode ? 'Delete Sub-Field' : 'Delete Sub-Field (Requires Confirmation)',
								style: 'cursor: pointer; opacity: 0.72; font-size: 11px; color: #ef4444; background: transparent; border: none; padding: 2px 4px; display: inline-flex; align-items: center; justify-content: center;'
							})) as HTMLButtonElement;
							append(dBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
							dBtn.onmousedown = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
							dBtn.onclick = async (e: MouseEvent) => {
								e.preventDefault();
								e.stopPropagation();
								if (!isFlowchartNodeMode) {
									try {
										const confirmRes = await this.dialogService.confirm({
											type: 'warning',
											title: 'Confirm Delete Sub-Field',
											message: `Are you sure you want to delete sub-field "${subF.label || subF.id}" (${subF.type.toUpperCase()})?`,
											detail: `This will remove "${subF.label || subF.id}" from the "${field.label || field.id}" container component.`,
											primaryButton: 'Delete',
											cancelButton: 'Cancel'
										});
										if (!confirmRes.confirmed) {
											return;
										}
									} catch { }
								}
								field.itemFields?.splice(sIdx, 1);
								this._syncDraft();
								renderSubFieldsList();
								this._persistCurrentModule().catch(() => { });
							};

							const subInpRow = append(subCard, $('div', { style: 'display: flex; gap: 8px; align-items: center; flex-wrap: wrap;' }));
							append(subInpRow, $('label', { style: 'font-size: 10.5px; opacity: 0.8; min-width: 65px;' }, 'Sub-Label:'));
							const subInp = append(subInpRow, $('input.monaco-inputbox', {
								style: 'flex: 1; min-width: 120px; padding: 4px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.25); color: inherit;'
							})) as HTMLInputElement;
							subInp.value = subF.label;
							subInp.oninput = () => {
								subF.label = subInp.value;
							};

							const subTypeSelect = append(subInpRow, $('select.monaco-select', {
								style: 'padding: 4px 6px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: #1a1a1a; color: inherit; cursor: pointer;'
							})) as HTMLSelectElement;
							const availableSubTypes: Array<{ type: CustomFieldType; label: string }> = [
								{ type: 'text', label: 'Text' },
								{ type: 'number', label: 'Number' },
								{ type: 'textarea', label: 'Textarea' },
								{ type: 'select', label: 'Select' },
								{ type: 'multiselect', label: 'Multiselect' },
								{ type: 'switch', label: 'Switch' },
								{ type: 'date', label: 'Date' },
								{ type: 'time', label: 'Time' },
								{ type: 'datetime', label: 'DateTime' },
								{ type: 'date_range', label: 'Date Range' },
								{ type: 'time_range', label: 'Time Range' },
								{ type: 'datetime_range', label: 'DateTime Range' },
								{ type: 'attachment', label: 'Attachment' },
								{ type: 'prompt', label: 'AI Prompt' }
							];
							availableSubTypes.forEach(st => {
								append(subTypeSelect, $('option', { value: st.type }, st.label));
							});
							subTypeSelect.value = subF.type;
							subTypeSelect.onchange = () => {
								subF.type = subTypeSelect.value as CustomFieldType;
								if ((subF.type === 'select' || subF.type === 'multiselect') && !subF.options) {
									subF.options = ['Option 1', 'Option 2'];
								}
								renderSubFieldsList();
							};
						});

						// Add Sub-Field & Save as Class Action Row
						const addSubRow = append(subCanvas, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(255, 255, 255, 0.06);' }));
						const addSubBtn = append(addSubRow, $('button.monaco-button', {
							style: 'padding: 4px 12px; font-size: 11px; border-radius: 4px; cursor: pointer; background: rgba(6, 182, 212, 0.12); border: 1px solid rgba(6, 182, 212, 0.3); color: #06b6d4; font-weight: 500;'
						}));
						addSubBtn.innerText = '+ Add Sub-Field';
						addSubBtn.onclick = () => {
							field.itemFields?.push({
								id: `sub_${Date.now()}_${field.itemFields.length + 1}`,
								label: `New Sub-Field`,
								type: 'text'
							});
							renderSubFieldsList();
						};

						const saveClassBtn = append(addSubRow, $('button.monaco-button', {
							style: 'padding: 4px 12px; font-size: 11px; border-radius: 4px; cursor: pointer; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.15); color: #e0e0e0;'
						}));
						saveClassBtn.innerText = 'Save as Class Asset';
						saveClassBtn.onclick = async () => {
							const className = field.label || 'My Composite Class';
							const newClass: ICompositeComponent = {
								id: `comp_${Date.now()}`,
								name: className,
								itemFields: JSON.parse(JSON.stringify(field.itemFields || [])),
								storageScope: activeMod.storageScope
							};
							await this.customModulesService.saveCompositeComponent(newClass, input.workspaceUri);
							this.notificationService.info(`Saved composite class "${className}" to Component Library!`);
							await this._loadAndRender(input);
						};
					};
					renderSubFieldsList();
				}

				const isButtonGroup = field.type === 'button_group';
				if (isButtonGroup) {
					if (!field.buttons || !Array.isArray(field.buttons) || field.buttons.length === 0) {
						field.buttons = [
							{ id: `btn_${Date.now()}_1`, label: 'Approve', color: '#22c55e', targetStatus: 'Done' },
							{ id: `btn_${Date.now()}_2`, label: 'Reject', color: '#ef4444', targetStatus: 'Blocked' }
						];
					}

					const btnGroupCanvas = append(fieldCard, $('.buttongroup-schema-canvas', {
						style: 'padding: 12px 14px; background: rgba(0, 0, 0, 0.25); border: 1.5px dashed rgba(56, 189, 248, 0.35); border-radius: 6px; display: flex; flex-direction: column; gap: 10px;'
					}));

					const renderButtonItems = () => {
						clearNode(btnGroupCanvas);
						const bgHeader = append(btnGroupCanvas, $('div', {
							style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 2px;'
						}));
						const bgTitle = append(bgHeader, $('div', {
							style: 'font-size: 10.5px; font-weight: 700; text-transform: uppercase; color: #38bdf8; letter-spacing: 0.05em; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;'
						}));
						append(bgTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.run)));
						append(bgTitle, $('span', {}, 'Action Buttons & Status Transitions (Horizontal):'));

						append(bgHeader, $('span', {
							style: 'font-size: 10px; opacity: 0.65;'
						}, `${field.buttons!.length} button${field.buttons!.length === 1 ? '' : 's'}`));

						// Horizontal Button Preview & Configuration Grid
						const buttonsContainer = append(btnGroupCanvas, $('.buttons-config-container', {
							style: 'display: flex; flex-direction: column; gap: 8px;'
						}));

						let draggingButtonIndex: number | null = null;
						// Button cards rendered in `buttonsContainer` (which is re-created on every re-render).
						const buttonCards: HTMLElement[] = [];

						field.buttons!.forEach((btn, bIdx) => {
							const btnCard = append(buttonsContainer, $('.button-config-card', {
								style: 'padding: 8px 12px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;'
							}));
							buttonCards.push(btnCard);

							// Drag Grip Handle (6-dots gripper)
							const dragHandle = append(btnCard, $('.button-row-drag-handle'));
							dragHandle.title = 'Drag to reorder button';
							append(dragHandle, $('span' + ThemeIcon.asCSSSelector(Codicon.gripper)));
							dragHandle.onmousedown = () => { btnCard.setAttribute('draggable', 'true'); };
							dragHandle.onmouseup = () => {
								if (draggingButtonIndex === null) {
									btnCard.setAttribute('draggable', 'false');
								}
							};
							dragHandle.onmouseleave = () => {
								if (draggingButtonIndex === null) {
									btnCard.setAttribute('draggable', 'false');
								}
							};

							btnCard.ondragstart = (e) => {
								draggingButtonIndex = bIdx;
								e.dataTransfer?.setData('text/plain', `button:${bIdx}`);
								if (e.dataTransfer) {
									e.dataTransfer.effectAllowed = 'move';
								}
								btnCard.style.opacity = '0.35';
								btnCard.style.background = 'rgba(255, 255, 255, 0.08)';
							};

							btnCard.ondragend = () => {
								btnCard.setAttribute('draggable', 'false');
								btnCard.style.opacity = '1';
								btnCard.style.background = 'rgba(255, 255, 255, 0.03)';
								btnCard.style.boxShadow = 'none';
								btnCard.style.borderColor = 'rgba(255, 255, 255, 0.08)';
								draggingButtonIndex = null;
								buttonCards.forEach(c => {
									c.style.boxShadow = 'none';
									c.style.borderColor = 'rgba(255, 255, 255, 0.08)';
								});
							};

							btnCard.ondragover = (e) => {
								e.preventDefault();
								if (e.dataTransfer) {
									e.dataTransfer.dropEffect = 'move';
								}
								const rect = btnCard.getBoundingClientRect();
								const isTop = e.clientY < rect.top + rect.height / 2;
								if (isTop) {
									btnCard.style.boxShadow = '0 -2px 0 0 #38bdf8';
									btnCard.style.borderColor = '#38bdf8';
								} else {
									btnCard.style.boxShadow = '0 2px 0 0 #38bdf8';
									btnCard.style.borderColor = '#38bdf8';
								}
							};

							btnCard.ondragleave = () => {
								btnCard.style.boxShadow = 'none';
								btnCard.style.borderColor = 'rgba(255, 255, 255, 0.08)';
							};

							btnCard.ondrop = (e) => {
								e.preventDefault();
								e.stopPropagation();
								btnCard.style.boxShadow = 'none';
								btnCard.style.borderColor = 'rgba(255, 255, 255, 0.08)';
								if (draggingButtonIndex === null || draggingButtonIndex === bIdx) {
									return;
								}
								const rect = btnCard.getBoundingClientRect();
								const isTop = e.clientY < rect.top + rect.height / 2;
								let targetIdx = isTop ? bIdx : bIdx + 1;
								const [movedItem] = field.buttons!.splice(draggingButtonIndex, 1);
								if (draggingButtonIndex < targetIdx) {
									targetIdx--;
								}
								field.buttons!.splice(targetIdx, 0, movedItem);
								draggingButtonIndex = null;
								renderButtonItems();
							};

							// Left: Label Input
							const btnLeft = append(btnCard, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex: 1; min-width: 180px; flex-wrap: wrap;' }));
							append(btnLeft, $('label', { style: 'font-size: 10.5px; opacity: 0.7; min-width: 36px;' }, 'Label:'));
							const labelInp = append(btnLeft, $('input.monaco-inputbox', {
								style: 'width: 110px; padding: 4px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.25); color: inherit;'
							})) as HTMLInputElement;
							labelInp.value = btn.label;
							labelInp.oninput = () => {
								btn.label = labelInp.value;
							};

							// Color Palette Dots
							const colorContainer = append(btnLeft, $('div', { style: 'display: flex; align-items: center; gap: 4px;' }));
							const presetColors = ['#22c55e', '#ef4444', '#38bdf8', '#f59e0b', '#a855f7', '#64748b'];
							presetColors.forEach(c => {
								const dot = append(colorContainer, $('div', {
									style: `width: 14px; height: 14px; border-radius: 50%; background: ${c}; cursor: pointer; border: 2px solid ${btn.color === c ? '#ffffff' : 'transparent'}; box-sizing: border-box; transition: transform 0.1s ease;`
								}));
								dot.title = `Color: ${c}`;
								dot.onclick = () => {
									btn.color = c;
									renderButtonItems();
								};
							});

							// Target Status Transition Dropdown
							const statusWrap = append(btnCard, $('div', { style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;' }));
							append(statusWrap, $('label', { style: 'font-size: 10.5px; opacity: 0.7;' }, 'Transitions to:'));
							const statusSel = append(statusWrap, $('select.monaco-select', {
								style: 'padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: #1a1a1a; color: inherit; cursor: pointer;'
							})) as HTMLSelectElement;

							append(statusSel, $('option', { value: '' }, 'None (No Status Change)'));
							currentStatuses.forEach(st => {
								const opt = append(statusSel, $('option', { value: st.label }, `→ ${st.label} (${st.category})`)) as HTMLOptionElement;
								if (btn.targetStatus === st.label) {
									opt.selected = true;
								}
							});
							statusSel.value = btn.targetStatus || '';
							statusSel.onchange = () => {
								btn.targetStatus = statusSel.value;
							};

							// Right Actions: Remove Button (left/right arrows removed per user request)
							const btnActs = append(btnCard, $('div', { style: 'display: flex; align-items: center; gap: 6px;' }));
							const delB = append(btnActs, $('button', {
								type: 'button',
								title: isFlowchartNodeMode ? 'Remove Button' : 'Remove Button (Requires Confirmation)',
								style: 'cursor: pointer; opacity: 0.72; font-size: 12px; color: #ef4444; background: transparent; border: none; padding: 2px 4px; display: inline-flex; align-items: center; justify-content: center;'
							})) as HTMLButtonElement;
							append(delB, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
							delB.onmousedown = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
							delB.onclick = async (e: MouseEvent) => {
								e.preventDefault();
								e.stopPropagation();
								if (!isFlowchartNodeMode) {
									try {
										const confirmRes = await this.dialogService.confirm({
											type: 'warning',
											title: 'Confirm Delete Action Button',
											message: `Are you sure you want to delete action button "${btn.label || btn.id}"?`,
											detail: `This will remove the "${btn.label || btn.id}" button from "${field.label || field.id}".`,
											primaryButton: 'Delete',
											cancelButton: 'Cancel'
										});
										if (!confirmRes.confirmed) {
											return;
										}
									} catch { }
								}
								field.buttons!.splice(bIdx, 1);
								this._syncDraft();
								renderButtonItems();
								this._persistCurrentModule().catch(() => { });
							};
						});

						// Footer: Add button row
						const addBtnRow = append(btnGroupCanvas, $('div', {
							style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; padding-top: 6px; border-top: 1px solid rgba(255, 255, 255, 0.06);'
						}));
						const addBtn = append(addBtnRow, $('button.monaco-button', {
							style: 'padding: 4px 12px; font-size: 11px; border-radius: 4px; cursor: pointer; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.3); color: #38bdf8; font-weight: 500;'
						}));
						addBtn.innerText = '+ Add Button';
						addBtn.onclick = () => {
							field.buttons!.push({
								id: `btn_${Date.now()}_${field.buttons!.length + 1}`,
								label: `Action ${field.buttons!.length + 1}`,
								color: '#38bdf8',
								targetStatus: ''
							});
							renderButtonItems();
						};
					};
					renderButtonItems();
				}

				// Browser Primitive Configuration Box
				if (field.type === 'browser') {
					const browserBox = append(fieldCard, $('.browser-schema-config', {
						style: 'display: flex; flex-direction: column; gap: 10px; background: rgba(0, 0, 0, 0.2); padding: 12px 14px; border-radius: 6px; border: 1px solid rgba(56, 189, 248, 0.25);'
					}));

					// Default URL Row
					const urlRow = append(browserBox, $('div', { style: 'display: flex; flex-direction: column; gap: 6px;' }));
					const urlTop = append(urlRow, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;' }));
					append(urlTop, $('label', { style: 'font-size: 11px; font-weight: 600; opacity: 0.85; color: #38bdf8;' }, 'Default Target URL / Site (Optional):'));
					const urlTopRight = append(urlTop, $('div', { style: 'display: flex; align-items: center; gap: 10px; flex-wrap: wrap;' }));
					append(urlTopRight, $('span', { style: 'font-size: 10px; color: #38bdf8;' }, 'Supports {Field Label} or {param} references'));
					append(urlTopRight, $('span', { style: 'font-size: 10px; opacity: 0.55;' }, 'Preloaded in ticket browser and silent automation'));
					const urlInputWrapper = append(urlRow, $('div.prompt-input-container', {
						style: 'position: relative; width: 100%;'
					}));

					const urlDisplayEl = append(urlInputWrapper, $('div.prompt-tokenized-display', {
						style: 'display: flex; align-items: center; min-height: 29px; padding: 5px 10px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.25); color: inherit; cursor: text; white-space: pre; overflow-x: auto; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace);'
					}));

					const urlInput = append(urlInputWrapper, $('input.monaco-inputbox.browser-url-input', {
						placeholder: 'e.g. https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords={Python Script}&start={start}',
						style: 'display: none; width: 100%; min-height: 29px; padding: 6px 10px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(56, 189, 248, 0.65); background: rgba(0, 0, 0, 0.35); color: inherit; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace); outline: none;'
					})) as HTMLInputElement;
					urlInput.value = field.defaultUrl || '';

					const urlAutocompleteMenu = append(urlInputWrapper, $('div.prompt-autocomplete-menu', {
						style: 'display: none; position: absolute; left: 8px; top: 100%; margin-top: 4px; z-index: 2500; min-width: 240px; max-height: 220px; overflow-y: auto; background: var(--vscode-editorWidget-background, #1e1e1e); border: 1px solid var(--vscode-editorWidget-border, #454545); border-radius: 6px; box-shadow: 0 6px 20px rgba(0,0,0,0.45); padding: 4px;'
					}));

					let lastUrlSelectionStart: number | undefined = undefined;
					let lastUrlSelectionEnd: number | undefined = undefined;
					let urlBlurTimer: ReturnType<typeof setTimeout> | null = null;
					const recordUrlSelection = () => {
						if (typeof urlInput.selectionStart === 'number') {
							lastUrlSelectionStart = urlInput.selectionStart;
						}
						if (typeof urlInput.selectionEnd === 'number') {
							lastUrlSelectionEnd = urlInput.selectionEnd;
						}
					};
					urlInput.addEventListener('keyup', recordUrlSelection);
					urlInput.addEventListener('click', recordUrlSelection);
					urlInput.addEventListener('mouseup', recordUrlSelection);
					urlInput.addEventListener('select', recordUrlSelection);
					urlInput.addEventListener('input', recordUrlSelection);

					const resolveClickOffsetInUrlDisplay = (ev?: MouseEvent): number | undefined => {
						const content = urlInput.value || '';
						if (!content || !ev) {
							return undefined;
						}
						const targetNode = ev.target as HTMLElement | null;
						const clickedPill = targetNode?.closest('.prompt-token-pill') as HTMLElement | null;
						if (clickedPill) {
							const s = parseInt(clickedPill.getAttribute('data-raw-start') || '', 10);
							const e = parseInt(clickedPill.getAttribute('data-raw-end') || '', 10);
							if (Number.isFinite(s) && Number.isFinite(e)) {
								const rect = clickedPill.getBoundingClientRect();
								return (ev.clientX - rect.left) < rect.width / 2 ? s : e;
							}
						}
						const caretDoc = getWindow(ev).document;
						let hitNode: Node | null = null;
						let hitOffset = 0;
						if (typeof caretDoc.caretRangeFromPoint === 'function') {
							const range = caretDoc.caretRangeFromPoint(ev.clientX, ev.clientY);
							if (range) {
								hitNode = range.startContainer;
								hitOffset = range.startOffset;
							}
						} else if (typeof caretDoc.caretPositionFromPoint === 'function') {
							const pos = caretDoc.caretPositionFromPoint(ev.clientX, ev.clientY);
							if (pos) {
								hitNode = pos.offsetNode;
								hitOffset = pos.offset;
							}
						}
						if (hitNode && urlDisplayEl.contains(hitNode)) {
							for (let i = 0; i < urlDisplayEl.childNodes.length; i++) {
								const child = urlDisplayEl.childNodes[i];
								if (child === hitNode || child.contains(hitNode)) {
									const el = child as HTMLElement;
									const rawStart = parseInt(el.getAttribute?.('data-raw-start') || '', 10);
									const rawEnd = parseInt(el.getAttribute?.('data-raw-end') || '', 10);
									if (Number.isFinite(rawStart) && Number.isFinite(rawEnd)) {
										if (el.classList?.contains('prompt-token-pill')) {
											const rect = el.getBoundingClientRect();
											return (ev.clientX - rect.left) < rect.width / 2 ? rawStart : rawEnd;
										}
										if (hitNode.nodeType === Node.TEXT_NODE) {
											return Math.min(rawEnd, rawStart + hitOffset);
										}
										return rawStart;
									}
								}
							}
						}
						return undefined;
					};

					const renderUrlTokenized = (rawVal?: string) => {
						const text = (rawVal ?? urlInput.value) || '';
						clearNode(urlDisplayEl);
						if (!text) {
							append(urlDisplayEl, $('span', {
								style: 'opacity: 0.45; font-style: italic;'
							}, urlInput.placeholder));
							return;
						}
						const appendUrlRawSpan = (startIdx: number, endIdx: number) => {
							if (endIdx <= startIdx) {
								return;
							}
							const spanEl = append(urlDisplayEl, $('span.prompt-raw-segment', {
								'data-raw-start': String(startIdx),
								'data-raw-end': String(endIdx)
							}));
							spanEl.textContent = text.slice(startIdx, endIdx);
						};
						const refTokens = getReferenceTokensForField(field);
						const tokenRegex = /(\{[^{}\n]+\}|@[a-zA-Z0-9_\-\u4e00-\u9fa5]+)/g;
						let lastIdx = 0;
						let match: RegExpExecArray | null;
						while ((match = tokenRegex.exec(text)) !== null) {
							if (match.index > lastIdx) {
								appendUrlRawSpan(lastIdx, match.index);
							}
							const fullMatch = match[0];
							const matchEnd = tokenRegex.lastIndex;
							const cleanTokenName = fullMatch.startsWith('{') && fullMatch.endsWith('}')
								? fullMatch.slice(1, -1).trim()
								: fullMatch.slice(1).trim();
							const matchedRef = refTokens.find(rt => rt.label.toLowerCase() === cleanTokenName.toLowerCase());
							const pillLabel = matchedRef ? matchedRef.label : (fullMatch.startsWith('{') && fullMatch.endsWith('}') ? cleanTokenName : '');
							if (pillLabel) {
								const pill = append(urlDisplayEl, $('span.prompt-token-pill', {
									'data-raw-start': String(match.index),
									'data-raw-end': String(matchEnd),
									style: 'display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; margin: 0 1px; border-radius: 4px; font-size: 11px; font-weight: 600; background: rgba(14, 99, 156, 0.28); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); vertical-align: baseline; user-select: none;'
								}));
								this._attachInstantTooltip(pill, `${matchedRef ? matchedRef.badge : 'Parameter'} reference: ${pillLabel}`, '#38bdf8');
								append(pill, $('span' + ThemeIcon.asCSSSelector(Codicon.link), { style: 'font-size: 10px;' }));
								append(pill, $('span', {}, pillLabel));
							} else {
								appendUrlRawSpan(match.index, matchEnd);
							}
							lastIdx = matchEnd;
						}
						if (lastIdx < text.length) {
							appendUrlRawSpan(lastIdx, text.length);
						}
					};

					const switchToUrlEdit = (ev?: MouseEvent, explicitCaretOffset?: number) => {
						const clickOffset = typeof explicitCaretOffset === 'number'
							? explicitCaretOffset
							: resolveClickOffsetInUrlDisplay(ev);
						urlDisplayEl.style.display = 'none';
						urlInput.style.display = 'block';
						const textLen = urlInput.value.length;
						const targetPos = typeof clickOffset === 'number'
							? Math.max(0, Math.min(textLen, clickOffset))
							: (typeof lastUrlSelectionStart === 'number' ? Math.max(0, Math.min(textLen, lastUrlSelectionStart)) : textLen);
						const targetEnd = typeof clickOffset === 'number'
							? targetPos
							: (typeof lastUrlSelectionEnd === 'number' ? Math.max(targetPos, Math.min(textLen, lastUrlSelectionEnd)) : targetPos);
						lastUrlSelectionStart = targetPos;
						lastUrlSelectionEnd = targetEnd;
						urlInput.focus({ preventScroll: true });
						urlInput.setSelectionRange(targetPos, targetEnd);
					};

					const switchToUrlDisplay = () => {
						recordUrlSelection();
						if (urlBlurTimer) {
							clearTimeout(urlBlurTimer);
						}
						urlBlurTimer = setTimeout(() => {
							urlAutocompleteMenu.style.display = 'none';
							urlInput.style.display = 'none';
							urlDisplayEl.style.display = 'flex';
							field.defaultUrl = urlInput.value.trim();
							renderUrlTokenized();
							this._syncDraft();
							this._persistCurrentModule().catch(() => { });
						}, 160);
					};

					urlDisplayEl.onclick = (ev: MouseEvent) => switchToUrlEdit(ev);
					urlInput.onblur = () => switchToUrlDisplay();

					let urlTriggerStartIdx = -1;
					const updateUrlAutocomplete = () => {
						const pos = urlInput.selectionStart || 0;
						const val = urlInput.value;
						const textBefore = val.slice(0, pos);
						const match = textBefore.match(/([\{@])([a-zA-Z0-9_\-\s\u4e00-\u9fa5]*)$/);
						if (!match) {
							urlAutocompleteMenu.style.display = 'none';
							urlTriggerStartIdx = -1;
							return;
						}
						urlTriggerStartIdx = pos - match[0].length;
						const query = match[2].toLowerCase().trim();
						const candidates = getReferenceTokensForField(field).filter(c => !query || c.label.toLowerCase().includes(query));
						if (candidates.length === 0) {
							urlAutocompleteMenu.style.display = 'none';
							return;
						}
						clearNode(urlAutocompleteMenu);
						urlAutocompleteMenu.style.display = 'block';
						candidates.forEach(cand => {
							const item = append(urlAutocompleteMenu, $('div', {
								style: 'display: flex; align-items: center; justify-content: space-between; padding: 5px 8px; border-radius: 4px; cursor: pointer; font-size: 11.5px;'
							}));
							item.onmouseenter = () => { item.style.background = 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.08))'; };
							item.onmouseleave = () => { item.style.background = 'transparent'; };
							const left = append(item, $('div', { style: 'display: flex; align-items: center; gap: 6px;' }));
							append(left, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolVariable), { style: 'color: #38bdf8; font-size: 12px;' }));
							append(left, $('span', { style: 'font-weight: 500;' }, cand.label));
							append(item, $('span', {
								style: 'font-size: 10px; opacity: 0.6; padding: 1px 5px; border-radius: 3px; background: rgba(255,255,255,0.06);'
							}, cand.badge));
							item.onmousedown = (ev) => {
								ev.preventDefault();
								const currentVal = urlInput.value;
								const currentPos = urlInput.selectionStart || 0;
								const replacement = `{${cand.label}}`;
								const nextVal = currentVal.slice(0, urlTriggerStartIdx) + replacement + currentVal.slice(currentPos);
								urlInput.value = nextVal;
								field.defaultUrl = nextVal.trim();
								urlAutocompleteMenu.style.display = 'none';
								this._syncDraft();
								const nextCursor = urlTriggerStartIdx + replacement.length;
								urlInput.focus();
								urlInput.setSelectionRange(nextCursor, nextCursor);
							};
						});
					};

					urlInput.oninput = () => {
						field.defaultUrl = urlInput.value.trim();
						this._syncDraft();
						updateUrlAutocomplete();
					};
					urlInput.onkeydown = (ev) => {
						if (ev.key === 'Escape' && urlAutocompleteMenu.style.display !== 'none') {
							ev.stopPropagation();
							urlAutocompleteMenu.style.display = 'none';
						} else if (ev.key === 'Enter') {
							ev.preventDefault();
							urlInput.blur();
						}
					};

					renderUrlTokenized();

					// Quick Reference Insert Toolbar (Clickable Chips) for Browser URL Bar
					const insertUrlTokenAtCursor = (token: string) => {
						if (urlBlurTimer) {
							clearTimeout(urlBlurTimer);
							urlBlurTimer = null;
						}
						const isUrlEditing = urlInput.style.display !== 'none';
						const current = urlInput.value || '';
						const start = isUrlEditing && typeof urlInput.selectionStart === 'number'
							? urlInput.selectionStart
							: (typeof lastUrlSelectionStart === 'number' ? Math.min(current.length, Math.max(0, lastUrlSelectionStart)) : current.length);
						const end = isUrlEditing && typeof urlInput.selectionEnd === 'number'
							? urlInput.selectionEnd
							: (typeof lastUrlSelectionEnd === 'number' ? Math.min(current.length, Math.max(start, lastUrlSelectionEnd)) : start);
						if (!isUrlEditing) {
							switchToUrlEdit(undefined, start);
						}
						urlInput.value = current.substring(0, start) + token + current.substring(end);
						const newPos = start + token.length;
						lastUrlSelectionStart = newPos;
						lastUrlSelectionEnd = newPos;
						urlInput.focus({ preventScroll: true });
						urlInput.setSelectionRange(newPos, newPos);
						field.defaultUrl = urlInput.value.trim();
						renderUrlTokenized();
						this._syncDraft();
						this._persistCurrentModule().catch(() => { });
					};

					const urlChipBar = append(urlRow, $('div', {
						style: 'display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-top: 2px;'
					}));
					let isBrowserChipsExpanded = false;

					const renderBrowserUrlChips = () => {
						if (urlInput.style.display === 'none') {
							renderUrlTokenized();
						}
						clearNode(urlChipBar);
						const browserRefTokens = getReferenceTokensForField(field);
						if (browserRefTokens.length === 0) {
							urlChipBar.style.display = 'none';
							return;
						}
						urlChipBar.style.display = 'flex';
						append(urlChipBar, $('span', { style: 'font-size: 10.5px; opacity: 0.65;' }, 'Insert Output:'));
						const urlChipStyle = 'padding: 2px 7px; font-size: 10.5px; font-weight: 500; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.3); background: rgba(56, 189, 248, 0.1); color: #38bdf8; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap; transition: all 0.15s ease;';

						const maxInitialVisible = 4;
						const visibleTokens = browserRefTokens.slice(0, maxInitialVisible);
						const hiddenTokens = browserRefTokens.slice(maxInitialVisible);

						visibleTokens.forEach(rt => {
							const chip = append(urlChipBar, $('button.browser-url-insert-chip', {
								type: 'button',
								style: urlChipStyle,
								title: `Click to insert {${rt.label}} (${rt.type}) into URL`
							}));
							chip.textContent = `+ {${rt.label}}`;
							chip.onmousedown = (e) => {
								e.preventDefault();
								e.stopPropagation();
								recordUrlSelection();
							};
							chip.onclick = (e) => {
								e.preventDefault();
								e.stopPropagation();
								insertUrlTokenAtCursor(`{${rt.label}}`);
							};
						});

						if (hiddenTokens.length > 0) {
							const hiddenContainer = append(urlChipBar, $('span', {
								style: isBrowserChipsExpanded ? 'display: contents;' : 'display: none;'
							}));
							hiddenTokens.forEach(rt => {
								const chip = append(hiddenContainer, $('button.browser-url-insert-chip', {
									type: 'button',
									style: urlChipStyle,
									title: `Click to insert {${rt.label}} (${rt.type}) into URL`
								}));
								chip.textContent = `+ {${rt.label}}`;
								chip.onmousedown = (e) => {
									e.preventDefault();
									e.stopPropagation();
									recordUrlSelection();
								};
								chip.onclick = (e) => {
									e.preventDefault();
									e.stopPropagation();
									insertUrlTokenAtCursor(`{${rt.label}}`);
								};
							});

							const moreBtn = append(urlChipBar, $('button', {
								type: 'button',
								style: 'padding: 2px 8px; font-size: 10px; font-weight: 600; border-radius: 4px; border: 1px dashed rgba(56, 189, 248, 0.4); background: rgba(56, 189, 248, 0.06); color: #38bdf8; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; white-space: nowrap;',
								title: 'Toggle more referenceable outputs'
							}, isBrowserChipsExpanded ? 'Less' : `+${hiddenTokens.length} More...`));

							moreBtn.onmousedown = (e) => {
								e.preventDefault();
								e.stopPropagation();
								recordUrlSelection();
							};
							moreBtn.onclick = (e) => {
								e.preventDefault();
								e.stopPropagation();
								isBrowserChipsExpanded = !isBrowserChipsExpanded;
								hiddenContainer.style.display = isBrowserChipsExpanded ? 'contents' : 'none';
								moreBtn.textContent = isBrowserChipsExpanded ? 'Less' : `+${hiddenTokens.length} More...`;
							};
						}
					};

					renderBrowserUrlChips();
					referenceChipRefreshers.push(renderBrowserUrlChips);

					// URL Action & Test Buttons Row
					const actionsRow = append(urlRow, $('div', { style: 'display: flex; gap: 8px; margin-top: 4px; align-items: center; flex-wrap: wrap;' }));

					const silentBtn = append(actionsRow, $('button.monaco-button.browser-silent-fetch-btn', {
						style: 'display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); transition: all 0.15s ease;'
					})) as HTMLButtonElement;
					append(silentBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.cloudDownload)));
					append(silentBtn, $('span', {}, 'Fetch (Silent)'));
					silentBtn.title = 'Test Fetch: Fetch webpage in background and extract text/HTML into preview below';

					const openTabBtn = append(actionsRow, $('button.monaco-button.browser-open-tab-btn', {
						style: 'display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; background: rgba(167, 139, 250, 0.15); color: #a78bfa; border: 1px solid rgba(167, 139, 250, 0.35); transition: all 0.15s ease;'
					})) as HTMLButtonElement;
					append(openTabBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.linkExternal)));
					append(openTabBtn, $('span', {}, 'Open in Tab'));

					// Auto Retry Configuration (default: 3 retries, 1s interval)
					const retryCfgWrap = append(actionsRow, $('div', {
						style: 'display: inline-flex; align-items: center; gap: 6px; margin-left: auto; padding: 3px 8px; border-radius: 5px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.1); font-size: 10.5px; color: #cbd5e1;',
						title: 'Auto-retry when Browser fetch fails (default: 3 retries, 1s interval)'
					}));
					append(retryCfgWrap, $('span' + ThemeIcon.asCSSSelector(Codicon.refresh), { style: 'font-size: 11px; color: #38bdf8;' }));
					append(retryCfgWrap, $('span', { style: 'opacity: 0.8;' }, 'Auto Retry:'));
					const retryCountInp = append(retryCfgWrap, $('input', {
						type: 'number',
						min: '0',
						max: '10',
						step: '1',
						title: 'Max retry attempts on failure (0 = disabled, default = 3)',
						style: 'width: 38px; padding: 1px 4px; font-size: 11px; text-align: center; border-radius: 3px; border: 1px solid rgba(255,255,255,0.16); background: rgba(0,0,0,0.3); color: #f1f5f9; outline: none;'
					})) as HTMLInputElement;
					retryCountInp.value = String(typeof field.browserMaxRetries === 'number' && Number.isFinite(field.browserMaxRetries) ? field.browserMaxRetries : 3);
					retryCountInp.onchange = () => {
						const parsed = parseInt(retryCountInp.value, 10);
						const clamped = Number.isFinite(parsed) ? Math.max(0, Math.min(10, parsed)) : 3;
						retryCountInp.value = String(clamped);
						field.browserMaxRetries = clamped;
						this._syncDraft();
						this._persistCurrentModule().catch(() => { });
					};
					append(retryCfgWrap, $('span', { style: 'opacity: 0.65;' }, '×'));
					const retryDelayInp = append(retryCfgWrap, $('input', {
						type: 'number',
						min: '0',
						max: '60',
						step: '0.5',
						title: 'Delay between retries in seconds (default = 1s)',
						style: 'width: 42px; padding: 1px 4px; font-size: 11px; text-align: center; border-radius: 3px; border: 1px solid rgba(255,255,255,0.16); background: rgba(0,0,0,0.3); color: #f1f5f9; outline: none;'
					})) as HTMLInputElement;
					const initDelaySec = typeof field.browserRetryDelayMs === 'number' && Number.isFinite(field.browserRetryDelayMs) ? field.browserRetryDelayMs / 1000 : 1;
					retryDelayInp.value = String(initDelaySec);
					retryDelayInp.onchange = () => {
						const parsed = parseFloat(retryDelayInp.value);
						const clampedSec = Number.isFinite(parsed) ? Math.max(0, Math.min(60, parsed)) : 1;
						retryDelayInp.value = String(clampedSec);
						field.browserRetryDelayMs = Math.round(clampedSec * 1000);
						this._syncDraft();
						this._persistCurrentModule().catch(() => { });
					};
					append(retryCfgWrap, $('span', { style: 'opacity: 0.65;' }, 's'));
					openTabBtn.title = 'Test in Browser: Open URL in a new VS Code browser tab beside and extract content into preview below';

					const newTabBtn = append(actionsRow, $('button.monaco-button.browser-new-tab-btn', {
						style: 'display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; background: rgba(52, 211, 153, 0.15); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.35); transition: all 0.15s ease;'
					})) as HTMLButtonElement;
					append(newTabBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.add)));
					append(newTabBtn, $('span', {}, 'New Tab'));
					newTabBtn.title = 'Open a new independent browser tab to freely navigate, sign in, or test cookies';
					newTabBtn.onclick = async () => {
						this._syncDraft();
						const rawUrl = urlInput.value.trim() || 'https://www.google.com';
						const newTabCtx = await this._getHydratedWorkflowRuntimeContext();
						let targetUrl = resolveBrowserCredentialUrl(rawUrl, field.credentials, t => this._interpolateSchemaReferences(t, field, allBrowserSchemaFields, newTabCtx)).url;
						if (!/^https?:\/\//i.test(targetUrl)) {
							targetUrl = 'https://' + targetUrl;
						}
						try {
							const uri = URI.parse(targetUrl);
							await this._commandService.executeCommand('simpleBrowser.api.open', uri, {
								viewColumn: -2, // ViewColumn.Beside
								preserveFocus: false
							});
						} catch {
							await this._commandService.executeCommand('simpleBrowser.show', targetUrl);
						}
					};

					// Credentials Section
					const credsBox = append(browserBox, $('.browser-creds-container', {
						style: 'display: flex; flex-direction: column; gap: 8px; margin-top: 4px; padding-top: 8px; border-top: 1px solid rgba(255, 255, 255, 0.06);'
					}));

					const credsTop = append(credsBox, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;' }));
					append(credsTop, $('div', { style: 'font-size: 11px; font-weight: 600; opacity: 0.85; color: #a78bfa;' }, 'Credentials (name = value):'));
					append(credsTop, $('span', { style: 'font-size: 10px; opacity: 0.55; flex: 1;' }, 'Use {name} in the URL (URL-encoded at run time); a credential not in the URL is sent as a request header named after it (e.g. Authorization). Values are hidden in logs and outputs; ticket users see names only.'));

					if (!field.credentials) {
						field.credentials = [];
					}

					const credsListContainer = append(credsBox, $('.creds-list', { style: 'display: flex; flex-direction: column; gap: 6px;' }));

					const renderCredRows = () => {
						clearNode(credsListContainer);
						if (!field.credentials || field.credentials.length === 0) {
							append(credsListContainer, $('div', {
								style: 'font-size: 11px; opacity: 0.5; font-style: italic; padding: 4px 0;'
							}, 'No credentials. Add one and reference it in the URL as {name}.'));
						} else {
							field.credentials.forEach((c, cIdx) => {
								const row = append(credsListContainer, $('.cred-row', {
									style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap; background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 5px; padding: 6px 8px;'
								}));

								append(row, $('span', {
									style: 'font-size: 10px; font-weight: 700; color: #a78bfa; padding: 2px 6px; background: rgba(167, 139, 250, 0.12); border-radius: 3px; min-width: 24px; text-align: center;'
								}, `#${cIdx + 1}`));

								// Name input (referenced in the URL as {name})
								const keyInp = append(row, $('input.monaco-inputbox', {
									placeholder: 'name, e.g. user',
									'aria-label': 'Credential name',
									style: 'width: 140px; padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.25); color: inherit;'
								})) as HTMLInputElement;
								keyInp.value = c.key;
								keyInp.oninput = () => { c.key = keyInp.value; this._syncDraft(); };
								keyInp.onchange = () => { this._persistCurrentModule().catch(() => { }); };

								append(row, $('span', { style: 'opacity: 0.5; font-size: 12px;' }, '='));

								// Value input (hidden by default)
								const valInp = append(row, $('input.monaco-inputbox', {
									placeholder: 'value or {VARIABLE}',
									'aria-label': 'Credential value',
									type: 'password',
									style: 'flex: 1; min-width: 120px; padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.25); color: inherit;'
								})) as HTMLInputElement;
								valInp.value = c.value;
								valInp.oninput = () => { c.value = valInp.value; this._syncDraft(); };
								valInp.onchange = () => { this._persistCurrentModule().catch(() => { }); };

								const eyeBtn = append(row, $('button', {
									type: 'button',
									title: 'Show / hide value',
									'aria-label': 'Show / hide value',
									style: 'cursor: pointer; opacity: 0.65; color: inherit; background: transparent; border: none; padding: 3px 5px; display: inline-flex; align-items: center; justify-content: center;'
								})) as HTMLButtonElement;
								const eyeIcon = append(eyeBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.eye)));
								eyeBtn.onclick = (e: MouseEvent) => {
									e.preventDefault();
									e.stopPropagation();
									const show = valInp.type === 'password';
									valInp.type = show ? 'text' : 'password';
									eyeIcon.className = ThemeIcon.asClassName(show ? Codicon.eyeClosed : Codicon.eye);
								};

								// Delete row button
								const delBtn = append(row, $('button', {
									type: 'button',
									title: 'Remove credential',
									style: 'cursor: pointer; opacity: 0.72; font-size: 11.5px; color: #ef4444; background: transparent; border: none; padding: 3px 5px; display: inline-flex; align-items: center; justify-content: center;'
								})) as HTMLButtonElement;
								append(delBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
								delBtn.onmousedown = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
								delBtn.onclick = (e: MouseEvent) => {
									e.preventDefault();
									e.stopPropagation();
									field.credentials!.splice(cIdx, 1);
									this._syncDraft();
									renderCredRows();
									this._persistCurrentModule().catch(() => { });
								};
							});
						}
					};

					renderCredRows();

					// Add credential button (icon)
					const addRowBtn = append(credsTop, $('button', {
						type: 'button',
						title: 'Add credential',
						'aria-label': 'Add credential',
						style: 'cursor: pointer; padding: 2px 5px; border-radius: 4px; background: rgba(167, 139, 250, 0.12); border: 1px solid rgba(167, 139, 250, 0.3); color: #a78bfa; display: inline-flex; align-items: center;'
					})) as HTMLButtonElement;
					append(addRowBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.add)));
					addRowBtn.onclick = (e: MouseEvent) => {
						e.preventDefault();
						e.stopPropagation();
						if (!field.credentials) { field.credentials = []; }
						field.credentials.push({
							id: `cred_${Date.now()}_${field.credentials.length + 1}`,
							key: '',
							value: ''
						});
						this._syncDraft();
						renderCredRows();
					};

					// Extracted Web Content Area (AI-Ready Preview)
					const contentArea = append(browserBox, $('.browser-content-container', {
						style: 'display: flex; flex-direction: column; gap: 6px; margin-top: 6px; padding-top: 8px; border-top: 1px solid rgba(255, 255, 255, 0.06);'
					}));

					const contentHeader = append(contentArea, $('div', {
						style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;'
					}));
					const contentHeaderLeft = append(contentHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;'
					}));
					append(contentHeaderLeft, $('span', {
						style: 'font-size: 11px; font-weight: 600; opacity: 0.9; text-transform: uppercase; color: #94a3b8; white-space: nowrap;'
					}, this._isFlowchartNodeMode ? 'Execution Output: Extracted Web Content:' : 'Debug: Extracted Web Content (Test Preview):'));

					append(contentHeaderLeft, $('span.browser-debug-badge', {
						style: this._isFlowchartNodeMode
							? 'font-size: 9.5px; padding: 2px 6px; border-radius: 3px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); font-weight: 600; white-space: nowrap;'
							: 'font-size: 9.5px; padding: 2px 6px; border-radius: 3px; background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); font-weight: 600; white-space: nowrap;'
					}, this._isFlowchartNodeMode ? 'Node Runtime & Test' : 'Template Debug Only'));

					const statusBadge = append(contentHeaderLeft, $('span.browser-fetch-status', {
						style: 'font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(255, 255, 255, 0.06); opacity: 0.9; display: none; white-space: nowrap;'
					}));
					if ((field as IRuntimeCustomField).lastExecutionStatus) {
						statusBadge.style.display = 'inline-block';
						const st = (field as IRuntimeCustomField).lastExecutionStatus;
						if (st === 'success') {
							statusBadge.textContent = `Completed in ${(field as IRuntimeCustomField).lastExecutionDurationMs ?? 0}ms${(field as IRuntimeCustomField).lastExecutedAt ? ` · ${(field as IRuntimeCustomField).lastExecutedAt}` : ''}`;
							statusBadge.style.color = '#4ade80';
						} else if (st === 'failed') {
							statusBadge.textContent = `Failed (${(field as IRuntimeCustomField).lastExecutionDurationMs ?? 0}ms)${(field as IRuntimeCustomField).lastExecutedAt ? ` · ${(field as IRuntimeCustomField).lastExecutedAt}` : ''}`;
							statusBadge.style.color = '#f87171';
						} else if (st === 'skipped') {
							statusBadge.textContent = 'Skipped (Disabled)';
							statusBadge.style.color = '#94a3b8';
						}
					}

					const contentHeaderRight = append(contentHeader, $('div', {
						style: 'display: flex; gap: 5px; align-items: center; flex-wrap: wrap; margin-left: auto;'
					}));

					const copyBtn = append(contentHeaderRight, $('button.monaco-button', {
						style: 'background: transparent; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 4px; padding: 2px 8px; font-size: 10.5px; opacity: 0.8; cursor: pointer; color: inherit; white-space: nowrap;'
					}));
					copyBtn.innerText = 'Copy';

					const clearBtn = append(contentHeaderRight, $('button.monaco-button', {
						style: 'background: transparent; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 4px; padding: 2px 8px; font-size: 10.5px; opacity: 0.8; cursor: pointer; color: inherit; white-space: nowrap;'
					}));
					clearBtn.innerText = 'Clear';

					const contentDisplay = append(contentArea, $('.browser-content-display', {
						style: 'min-height: 110px; max-height: 240px; overflow-y: auto; padding: 10px 12px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 6px; color: #e2e8f0;'
					}));

					const resetPlaceholder = () => {
						clearNode(contentDisplay);
						append(contentDisplay, $('span', { style: 'opacity: 0.4; font-style: italic;' }, 'No webpage content extracted yet. Enter a URL above and click "Fetch (Silent)" or "Open in Tab" to test webpage extraction during template design. (This is debug preview only, not saved to ticket instances)'));
					};

					if (field.defaultContent) {
						contentDisplay.textContent = field.defaultContent;
					} else {
						resetPlaceholder();
					}

					copyBtn.onclick = () => {
						const text = contentDisplay.textContent || '';
						if (text && !text.startsWith('No webpage content')) {
							this._clipboardService.writeText(text);
							this.notificationService.info('Web content copied to clipboard.');
						}
					};

					clearBtn.onclick = async () => {
						resetPlaceholder();
						statusBadge.textContent = '';
						statusBadge.style.display = 'none';
						field.defaultContent = '';
						this._syncDraft();
						await this._persistCurrentModule();
					};

					const executeFetch = async (openTab: boolean) => {
						await this._executeBrowserFetch(urlInput, statusBadge, contentDisplay, field, openTab, fields);
					};

					silentBtn.onclick = () => executeFetch(false);
					openTabBtn.onclick = () => executeFetch(true);

					urlInput.onkeydown = (e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							executeFetch(false);
						}
					};
				}

				// Git Primitive Configuration Box
				if (field.type === 'git') {
					const gitSchemaBox = append(fieldCard, $('.git-schema-config', {
						style: 'display: flex; flex-direction: column; gap: 10px; background: rgba(0, 0, 0, 0.2); padding: 12px 14px; border-radius: 6px; border: 1px solid rgba(249, 115, 22, 0.25);'
					}));

					const gitNote = append(gitSchemaBox, $('div', { style: 'font-size: 11px; opacity: 0.8; line-height: 1.4; color: #fb923c;' }));
					append(gitNote, $('span' + ThemeIcon.asCSSSelector(Codicon.sourceControl), { style: 'margin-right: 6px;' }));
					append(gitNote, $('span', {}, 'When included in schema, tickets of this type will enable Git repository and branch binding.'));

					// Default Remote URL
					const remoteRow = append(gitSchemaBox, $('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }));
					append(remoteRow, $('label', { style: 'font-size: 11px; font-weight: 600; opacity: 0.85;' }, 'Default Git Remote URL (Optional):'));
					const remoteInput = append(remoteRow, $('input.monaco-inputbox', {
						placeholder: 'e.g. git@github.com:org/repo.git or https://github.com/org/repo.git',
						style: 'width: 100%; padding: 6px 10px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.25); color: inherit; box-sizing: border-box;'
					})) as HTMLInputElement;
					remoteInput.value = field.gitRemoteUrl || '';
					remoteInput.oninput = () => {
						field.gitRemoteUrl = remoteInput.value.trim();
					};

					// Default Target Branch
					const branchRow = append(gitSchemaBox, $('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }));
					append(branchRow, $('label', { style: 'font-size: 11px; font-weight: 600; opacity: 0.85;' }, 'Default Target Branch (Optional):'));
					const branchInput = append(branchRow, $('input.monaco-inputbox', {
						placeholder: 'e.g. main, master, feature/base',
						style: 'width: 100%; padding: 6px 10px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.25); color: inherit; box-sizing: border-box;'
					})) as HTMLInputElement;
					branchInput.value = field.gitBranch || '';
					branchInput.oninput = () => {
						field.gitBranch = branchInput.value.trim();
					};
				}

				// Parameters Primitive Configuration Box
				if (field.type === 'parameters') {
					if (!field.parameters) {
						field.parameters = [];
					}
					const paramSchemaBox = append(fieldCard, $('.parameters-schema-config', {
						style: 'display: flex; flex-direction: column; gap: 12px; background: rgba(0, 0, 0, 0.2); padding: 12px 14px; border-radius: 6px; border: 1px solid rgba(168, 85, 247, 0.25);'
					}));

					const paramNotice = append(paramSchemaBox, $('div', { style: 'font-size: 11px; opacity: 0.85; line-height: 1.4; color: #c084fc; display: flex; align-items: center; gap: 6px;' }));
					append(paramNotice, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolVariable)));
					append(paramNotice, $('span', {}, 'Define runtime inputs for tickets. Reference these parameters in URLs and prompts using {{param_name}}.'));

					// Parameters List Container
					const paramListContainer = append(paramSchemaBox, $('.params-list', { style: 'display: flex; flex-direction: column; gap: 8px;' }));

					const renderParamList = () => {
						clearNode(paramListContainer);

						if (!field.parameters || field.parameters.length === 0) {
							append(paramListContainer, $('div', {
								style: 'font-size: 11px; font-style: italic; opacity: 0.5; padding: 6px 0;'
							}, 'No parameters defined yet. Click "+ Add Parameter" below.'));
							return;
						}

						field.parameters.forEach((param, pIdx) => {
							// Strip legacy hardcoded 'Start Offset' / 'Zero-based pagination start index' metadata
							if (param.label) {
								delete param.label;
							}
							if (param.description === 'Zero-based pagination start index') {
								delete param.description;
							}
							const row = append(paramListContainer, $('.param-row-card', {
								style: 'display: flex; flex-direction: column; gap: 6px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; padding: 8px 10px;'
							}));

							// Top line: Name, copy tag, and delete
							const topLine = append(row, $('.param-row-top', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;' }));

							const nameInput = append(topLine, $('input.monaco-inputbox', {
								placeholder: 'Variable Name (e.g. start, env)',
								style: 'flex: 1; min-width: 120px; padding: 5px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.25); color: inherit; font-family: var(--vscode-editor-font-family, monospace);'
							})) as HTMLInputElement;
							nameInput.value = param.name || '';

							const copyTag = append(topLine, $('span.param-copy-tag', {
								title: 'Click to copy reference token',
								style: 'font-size: 10px; font-family: var(--vscode-editor-font-family, monospace); font-weight: 700; color: #c084fc; background: rgba(168, 85, 247, 0.15); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 4px; padding: 3px 7px; cursor: pointer; user-select: none; white-space: nowrap;'
							}, `{{${param.name || 'param'}}}`));
							copyTag.onclick = () => {
								const token = `{{${param.name || 'param'}}}`;
								this._clipboardService.writeText(token);
								this.notificationService.info(`Copied '${token}' to clipboard.`);
							};

							nameInput.oninput = () => {
								param.name = nameInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
								nameInput.value = param.name;
								copyTag.textContent = `{{${param.name || 'param'}}}`;
								this._syncDraft();
								refreshAllReferenceChipBars();
							};
							nameInput.onblur = () => {
								this._syncDraft();
								refreshAllReferenceChipBars();
								this._persistCurrentModule().catch(() => { });
							};

							const delBtn = append(topLine, $('button.param-delete-btn', {
								type: 'button',
								title: isFlowchartNodeMode ? 'Delete Parameter' : 'Delete Parameter (Requires Confirmation)',
								style: 'cursor: pointer; opacity: 0.72; font-size: 12px; padding: 3px 5px; border-radius: 4px; border: 1px solid transparent; background: transparent; color: #f87171; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all 0.12s ease;'
							})) as HTMLButtonElement;
							append(delBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), { style: 'font-size: 12px;' }));
							delBtn.onmouseenter = () => {
								delBtn.style.opacity = '1';
								delBtn.style.background = 'rgba(239, 68, 68, 0.16)';
								delBtn.style.borderColor = 'rgba(239, 68, 68, 0.35)';
							};
							delBtn.onmouseleave = () => {
								delBtn.style.opacity = '0.72';
								delBtn.style.background = 'transparent';
								delBtn.style.borderColor = 'transparent';
							};
							delBtn.onmousedown = (e: MouseEvent) => {
								e.preventDefault();
								e.stopPropagation();
							};
							delBtn.onclick = async (e: MouseEvent) => {
								e.preventDefault();
								e.stopPropagation();
								if (!isFlowchartNodeMode) {
									try {
										const confirmRes = await this.dialogService.confirm({
											type: 'warning',
											title: 'Confirm Delete Parameter',
											message: `Are you sure you want to delete parameter "{{${param.name || 'param'}}}"?`,
											detail: `This will remove the parameter from "${field.label || field.id}".`,
											primaryButton: 'Delete',
											cancelButton: 'Cancel'
										});
										if (!confirmRes.confirmed) {
											return;
										}
									} catch (err) {
										console.warn('[CustomModuleSchemaEditor] Parameter delete dialog bypassed:', err);
									}
								}
								if (Array.isArray(field.parameters)) {
									const realIdx = field.parameters.indexOf(param);
									field.parameters.splice(realIdx !== -1 ? realIdx : pIdx, 1);
								}
								this._syncDraft();
								renderParamList();
								refreshAllReferenceChipBars();
								this._persistCurrentModule().catch(() => { });
							};

							// Default Value
							const defCol = append(row, $('div', { style: 'display: flex; flex-direction: column; gap: 4px; margin-top: 2px;' }));
							append(defCol, $('label', { style: 'font-size: 10.5px; opacity: 0.75;' }, this._isFlowchartNodeMode ? 'Default Value / Workflow Global Variable (e.g. {var_name}):' : 'Default Value:'));
							const defInput = append(defCol, $('input.monaco-inputbox', {
								placeholder: this._isFlowchartNodeMode ? 'Leave blank for required (no default), or enter value / "" / {var}' : 'Leave blank for required (no default), or e.g. 0 / ""',
								style: 'width: 100%; padding: 5px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.2); color: inherit; box-sizing: border-box;'
							})) as HTMLInputElement;
							defInput.value = param.defaultValue !== undefined && param.defaultValue !== null ? String(param.defaultValue) : '';
							defInput.oninput = () => {
								if (defInput.value.trim() === '') {
									delete param.defaultValue;
								} else {
									param.defaultValue = defInput.value;
								}
								this._syncDraft();
							};

							if (this.input instanceof CustomModuleSchemaEditorInput && typeof this.input.workflowVariablesProvider === 'function') {
								const wfVars = this.input.workflowVariablesProvider();
								const uniqueVarNames: string[] = [];
								if (Array.isArray(wfVars)) {
									for (const wv of wfVars) {
										if (wv.type === 'NODE') { continue; }
										const vName = (wv.label || '').trim();
										if (vName && !uniqueVarNames.includes(vName)) {
											uniqueVarNames.push(vName);
										}
									}
								}
								if (uniqueVarNames.length > 0) {
									const wfVarRow = append(defCol, $('div', {
										style: 'display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 3px;'
									}));
									append(wfVarRow, $('span', { style: 'font-size: 10px; opacity: 0.65;' }, 'Bind Workflow Var:'));

									const maxVisibleWfVars = 4;
									const visibleWfVars = uniqueVarNames.slice(0, maxVisibleWfVars);
									const hiddenWfVars = uniqueVarNames.slice(maxVisibleWfVars);
									let isWfVarsExpanded = false;

									const renderWfVarChip = (parentEl: HTMLElement, vName: string) => {
										const vChip = append(parentEl, $('button', {
											type: 'button',
											style: 'padding: 1px 6px; font-size: 10px; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.35); background: rgba(56, 189, 248, 0.1); color: #38bdf8; cursor: pointer; font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap;',
											title: `Click to bind Workflow variable {${vName}} into parameter "${param.name || ''}"`
										}, `+ {${vName}}`));
										vChip.onmousedown = (ev) => {
											ev.preventDefault();
											ev.stopPropagation();
										};
										vChip.onclick = (ev) => {
											ev.preventDefault();
											ev.stopPropagation();
											const token = `{${vName}}`;
											const curVal = defInput.value || '';
											if (
												defInput.ownerDocument.activeElement === defInput &&
												typeof defInput.selectionStart === 'number' &&
												typeof defInput.selectionEnd === 'number' &&
												defInput.selectionStart !== defInput.selectionEnd
											) {
												const start = defInput.selectionStart;
												const end = defInput.selectionEnd;
												defInput.value = curVal.substring(0, start) + token + curVal.substring(end);
												const newPos = start + token.length;
												defInput.focus({ preventScroll: true });
												defInput.setSelectionRange(newPos, newPos);
											} else {
												defInput.value = token;
											}
											param.defaultValue = defInput.value;
											if (!param.name || param.name === 'param1') {
												param.name = vName;
												nameInput.value = vName;
												copyTag.textContent = `{{${vName}}}`;
												refreshAllReferenceChipBars();
											}
											this._syncDraft();
										};
									};

									for (const vName of visibleWfVars) {
										renderWfVarChip(wfVarRow, vName);
									}

									if (hiddenWfVars.length > 0) {
										const hiddenContainer = append(wfVarRow, $('span', {
											style: 'display: none;'
										}));
										for (const vName of hiddenWfVars) {
											renderWfVarChip(hiddenContainer, vName);
										}
										const moreBtn = append(wfVarRow, $('button', {
											type: 'button',
											style: 'padding: 1px 7px; font-size: 10px; font-weight: 600; border-radius: 4px; border: 1px dashed rgba(56, 189, 248, 0.4); background: rgba(56, 189, 248, 0.06); color: #38bdf8; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; white-space: nowrap;',
											title: 'Show / hide more workflow variables'
										}, `+${hiddenWfVars.length} More...`));
										moreBtn.onclick = (ev) => {
											ev.preventDefault();
											ev.stopPropagation();
											isWfVarsExpanded = !isWfVarsExpanded;
											hiddenContainer.style.display = isWfVarsExpanded ? 'contents' : 'none';
											moreBtn.textContent = isWfVarsExpanded ? 'Less' : `+${hiddenWfVars.length} More...`;
										};
									}
								}
							}

							// Choices / Options (Interactive Chips / Dropdown Menu Options Builder)
							const optContainer = append(row, $('.options-manager', {
								style: 'display: flex; flex-direction: column; gap: 6px; background: rgba(0, 0, 0, 0.2); padding: 8px 10px; border-radius: 6px; margin-top: 2px;'
							}));
							append(optContainer, $('div', { style: 'font-size: 10px; font-weight: 600; opacity: 0.7; text-transform: uppercase;' }, 'CHOICES / OPTIONS:'));

							const chipsBox = append(optContainer, $('.chips-box', {
								style: 'display: flex; flex-wrap: wrap; gap: 6px; align-items: center;'
							}));

							const renderParamChips = () => {
								clearNode(chipsBox);
								const currentOpts = param.options || [];
								currentOpts.forEach((opt, oIdx) => {
									const chip = append(chipsBox, $('.option-chip', {
										style: 'background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 12px; padding: 3px 10px; font-size: 11px; display: flex; align-items: center; gap: 6px;'
									}));
									append(chip, $('span', {}, opt));
									const removeX = append(chip, $('span', { style: 'cursor: pointer; opacity: 0.6; font-size: 11px;' }, '\u2715'));
									removeX.onclick = () => {
										if (param.options) {
											param.options.splice(oIdx, 1);
											if (param.options.length === 0) {
												param.options = undefined;
											}
										}
										this._syncDraft();
										renderParamChips();
									};
								});

								const addInput = append(chipsBox, $('input.monaco-inputbox', {
									placeholder: '+ Add Option',
									style: 'width: 110px; padding: 3px 8px; font-size: 11px; border-radius: 12px; border: 1px dashed rgba(255, 255, 255, 0.2); background: transparent; color: inherit;'
								})) as HTMLInputElement;

								const commitNewOption = () => {
									const rawVal = addInput.value.trim();
									if (!rawVal) {
										return;
									}
									if (!param.options) {
										param.options = [];
									}
									const parts = rawVal.split(',').map(s => s.trim()).filter(Boolean);
									for (const part of parts) {
										if (!param.options.includes(part)) {
											param.options.push(part);
										}
									}
									addInput.value = '';
									this._syncDraft();
									renderParamChips();
								};

								addInput.onkeydown = (e) => {
									if (e.key === 'Enter') {
										e.preventDefault();
										commitNewOption();
									}
								};
								addInput.onblur = () => {
									if (addInput.value.trim()) {
										commitNewOption();
									}
								};
							};
							renderParamChips();
						});
					};

					renderParamList();

					// Add Parameter Button
					const addParamBtn = append(paramSchemaBox, $('button', {
						style: 'align-self: flex-start; display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 4px; background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.35); cursor: pointer; transition: all 0.15s ease;'
					}));
					append(addParamBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.plus)));
					append(addParamBtn, $('span', {}, 'Add Parameter'));
					addParamBtn.onclick = () => {
						const count = (field.parameters?.length || 0) + 1;
						field.parameters!.push({
							id: `param_${Date.now()}_${count}`,
							name: `param_${count}`,
							defaultValue: ''
						});
						this._syncDraft();
						renderParamList();
						refreshAllReferenceChipBars();
						this._persistCurrentModule().catch(() => { });
					};

					// Last Execution Trace & Resolved Values Box (Inputs Component)
					const paramExecCard = append(paramSchemaBox, $('div.component-exec-logs-card', {
						style: 'display: flex; flex-direction: column; gap: 4px; margin-top: 4px; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(168, 85, 247, 0.25); border-radius: 5px; padding: 6px 8px;'
					}));
					const paramExecHeader = append(paramExecCard, $('div', {
						style: 'display: flex; justify-content: space-between; align-items: center; font-size: 10.5px; gap: 8px; flex-wrap: wrap;'
					}));
					const paramExecTitle = append(paramExecHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; font-weight: 600; color: #c084fc;'
					}));
					append(paramExecTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.terminal)));
					append(paramExecTitle, $('span', {}, 'LAST EXECUTION RESOLVED INPUTS & TRACE'));
					const paramExecRight = append(paramExecHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-left: auto;'
					}));
					const paramExecStatus = append(paramExecRight, $('span', {
						style: 'font-size: 10px; font-family: var(--vscode-editor-font-family, monospace);'
					}));
					const updateParamExecStatus = () => {
						const st = (field as IRuntimeCustomField).lastExecutionStatus;
						if (st === 'success') {
							paramExecStatus.textContent = `Completed in ${(field as IRuntimeCustomField).lastExecutionDurationMs ?? 0}ms${(field as IRuntimeCustomField).lastExecutedAt ? ` · ${(field as IRuntimeCustomField).lastExecutedAt}` : ''}`;
							paramExecStatus.style.color = '#4ade80';
						} else if (st === 'failed') {
							paramExecStatus.textContent = `Failed (${(field as IRuntimeCustomField).lastExecutionDurationMs ?? 0}ms)${(field as IRuntimeCustomField).lastExecutedAt ? ` · ${(field as IRuntimeCustomField).lastExecutedAt}` : ''}`;
							paramExecStatus.style.color = '#f87171';
						} else if (st === 'skipped') {
							paramExecStatus.textContent = 'Skipped (Disabled)';
							paramExecStatus.style.color = '#94a3b8';
						} else {
							paramExecStatus.textContent = '[Ready to execute]';
							paramExecStatus.style.color = '#94a3b8';
						}
					};
					updateParamExecStatus();
					const paramExecCopyBtn = append(paramExecRight, $('button', {
						type: 'button',
						style: 'padding: 1px 6px; font-size: 10px; border-radius: 3px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05); color: inherit; cursor: pointer;'
					}, 'Copy'));
					const paramExecClearBtn = append(paramExecRight, $('button', {
						type: 'button',
						style: 'padding: 1px 6px; font-size: 10px; border-radius: 3px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05); color: inherit; cursor: pointer;'
					}, 'Clear'));
					const paramExecPre = append(paramExecCard, $('pre', {
						style: 'margin: 0; padding: 4px 6px; font-size: 11px; line-height: 1.45; font-family: var(--vscode-editor-font-family, monospace); color: #cbd5e1; min-height: 40px; max-height: 180px; overflow-y: auto; white-space: pre-wrap; word-break: break-word;'
					}));
					paramExecPre.textContent = (field as IRuntimeCustomField).lastExecutionLog || '[Ready to execute] Resolved input parameter values and types will be recorded here when the workflow or node runs.';
					paramExecCopyBtn.onclick = () => {
						const txt = (field as IRuntimeCustomField).lastExecutionLog || paramExecPre.textContent || '';
						if (txt) {
							this._clipboardService.writeText(txt);
							this.notificationService.info('Inputs execution log copied to clipboard.');
						}
					};
					paramExecClearBtn.onclick = async () => {
						delete (field as IRuntimeCustomField).lastExecutionLog;
						delete (field as IRuntimeCustomField).lastExecutionOutput;
						delete (field as IRuntimeCustomField).lastExecutionStatus;
						delete (field as IRuntimeCustomField).lastExecutionDurationMs;
						delete (field as IRuntimeCustomField).lastExecutedAt;
						updateParamExecStatus();
						paramExecPre.textContent = '[Ready to execute] Resolved input parameter values and types will be recorded here when the workflow or node runs.';
						this._syncDraft();
						await this._persistCurrentModule();
					};
				}

				// Prompt Primitive Configuration Box
				if (field.type === 'prompt') {
					if (!field.targetMode) {
						field.targetMode = 'model';
					}
					if (!field.targetModel) {
						field.targetModel = resolveDefaultModelId(field.targetProvider, 'gemini-2.5-flash');
						if (!field.targetProvider) {
							field.targetProvider = getGlobalDefaultModel()?.providerId;
						}
					}
					const promptSchemaBox = append(fieldCard, $('.prompt-schema-config', {
						style: 'display: flex; flex-direction: column; gap: 12px; background: rgba(0, 0, 0, 0.2); padding: 12px 14px; border-radius: 6px; border: 1px solid rgba(59, 130, 246, 0.25);'
					}));

					// Top Description
					const promptNotice = append(promptSchemaBox, $('div', { style: 'font-size: 11px; opacity: 0.85; line-height: 1.4; color: #60a5fa; display: flex; align-items: center; gap: 6px;' }));
					append(promptNotice, $('span' + ThemeIcon.asCSSSelector(Codicon.sparkle)));
					append(promptNotice, $('span', {}, 'AI Prompt Primitive: configure instruction prompt and choose whether it is processed by an AI Model or an autonomous AI Agent.'));

					// Target Mode Switcher (Model vs Agent)
					const modeRow = append(promptSchemaBox, $('div', { style: 'display: flex; flex-direction: column; gap: 6px;' }));
					append(modeRow, $('label', { style: 'font-size: 11px; font-weight: 600; opacity: 0.85;' }, 'Processing Target Mode:'));
					const modeButtons = append(modeRow, $('div', { style: 'display: flex; gap: 8px; flex-wrap: wrap;' }));

					const modelModeBtn = append(modeButtons, $('button.monaco-button', {
						type: 'button',
						style: `padding: 6px 14px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; ${field.targetMode !== 'agent' ? 'background: rgba(59, 130, 246, 0.18); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.5);' : 'background: rgba(255, 255, 255, 0.05); color: #ccc; border: 1px solid rgba(255, 255, 255, 0.15);'}`
					})) as HTMLButtonElement;
					append(modelModeBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.zap)));
					append(modelModeBtn, $('span', {}, 'Large Language Model (Direct)'));

					const agentModeBtn = append(modeButtons, $('button.monaco-button', {
						type: 'button',
						style: `padding: 6px 14px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; ${field.targetMode === 'agent' ? 'background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.5);' : 'background: rgba(255, 255, 255, 0.05); color: #ccc; border: 1px solid rgba(255, 255, 255, 0.15);'}`
					})) as HTMLButtonElement;
					append(agentModeBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.robot)));
					append(agentModeBtn, $('span', {}, 'AI Agent (Role-based Autonomous)'));

					// Target Selector Container
					const targetSelectContainer = append(promptSchemaBox, $('div', { style: 'display: flex; flex-direction: column; gap: 6px;' }));

					const renderTargetSelector = async () => {
						clearNode(targetSelectContainer);
						if (field.targetMode === 'agent') {
							append(targetSelectContainer, $('label', { style: 'font-size: 11px; font-weight: 600; color: #38bdf8;' }, 'Target AI Agent:'));
							const agentSelect = append(targetSelectContainer, $('select.monaco-select-box', {
								style: 'width: 100%; padding: 6px 10px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.35); background: rgba(0, 0, 0, 0.25); color: inherit;'
							})) as HTMLSelectElement;

							let agentsList: IAgentItem[] = [];
							try {
								const agentsMgr = this._instantiationService.invokeFunction(accessor => {
									try { return accessor.get(IAgentsManagerService); } catch { return undefined; }
								});
								if (agentsMgr) {
									agentsList = await agentsMgr.getAgents();
								}
							} catch { }

							if (agentsList.length === 0) {
								const opt = append(agentSelect, $('option', { value: '' }, '-- No AI Agents configured yet --')) as HTMLOptionElement;
								opt.selected = true;
							} else {
								const defaultOpt = append(agentSelect, $('option', { value: '' }, '-- Select AI Agent --')) as HTMLOptionElement;
								if (!field.targetAgentId) { defaultOpt.selected = true; }

								agentsList.forEach(ag => {
									const opt = append(agentSelect, $('option', { value: ag.id }, `${ag.name} (${ag.role || 'Agent'})`)) as HTMLOptionElement;
									if (field.targetAgentId === ag.id) {
										opt.selected = true;
									}
								});
							}

							agentSelect.onchange = () => {
								field.targetAgentId = agentSelect.value;
								const selAgent = agentsList.find(a => a.id === agentSelect.value);
								field.targetAgentName = selAgent?.name || '';
								this._syncDraft();
								this._persistCurrentModule().catch(() => { });
							};
						} else {
							append(targetSelectContainer, $('label', { style: 'font-size: 11px; font-weight: 600; color: #60a5fa;' }, 'Target AI Model:'));
							const modelRow = append(targetSelectContainer, $('div', { style: 'display: flex; gap: 8px; align-items: center; flex-wrap: wrap; position: relative;' }));

							// Provider / Credential Selector (consistent with Agent Central & Settings)
							const providerSelect = append(modelRow, $('select.monaco-select-box', {
								style: 'min-width: 170px; padding: 6px 8px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(59, 130, 246, 0.35); background: rgba(0, 0, 0, 0.3); color: inherit; cursor: pointer;',
								title: 'Select AI Provider / Configured Credential'
							})) as HTMLSelectElement;

							// Searchable Model Picker Button + Floating Dropdown (matches Agent Central)
							const modelPickerWrapper = append(modelRow, $('div', {
								style: 'flex: 1; min-width: 220px; position: relative;'
							}));

							const modelPickerBtn = append(modelPickerWrapper, $('button.monaco-button', {
								type: 'button',
								style: 'width: 100%; padding: 6px 10px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(59, 130, 246, 0.35); background: rgba(0, 0, 0, 0.3); color: inherit; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 6px; text-align: left;',
								title: 'Select or search AI model from your configured provider credentials'
							})) as HTMLButtonElement;

							const modelBtnLeft = append(modelPickerBtn, $('span', { style: 'display: inline-flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }));
							append(modelBtnLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.sparkle), { style: 'color: #60a5fa; font-size: 12px;' }));
							if (field.targetModel === 'o1-mini' || field.targetModel === 'o1-preview') {
								field.targetModel = 'gpt-4o';
							}
							const modelBtnLabel = append(modelBtnLeft, $('span', { style: 'font-weight: 600; font-family: var(--vscode-editor-font-family, monospace);' }, field.targetModel || resolveDefaultModelId(field.targetProvider, 'gpt-4o')));
							append(modelPickerBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.chevronDown), { style: 'font-size: 11px; opacity: 0.7;' }));

							const modelDropdown = append(modelPickerWrapper, $('div.prompt-schema-model-dropdown', {
								style: 'display: none; position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 1200; background: var(--vscode-editorWidget-background, #1e1e1e); border: 1px solid rgba(59, 130, 246, 0.45); border-radius: 6px; box-shadow: 0 10px 28px rgba(0,0,0,0.68); padding: 6px; flex-direction: column; gap: 6px;'
							}));

							const searchHeader = append(modelDropdown, $('div', {
								style: 'display: flex; align-items: center; gap: 6px; padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,0.08);'
							}));
							append(searchHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.search), { style: 'font-size: 12px; opacity: 0.6;' }));
							const modelSearchInput = append(searchHeader, $('input', {
								type: 'text',
								placeholder: 'Search models (e.g. flash, sonnet, 4o, gpt-5) or enter ID...',
								style: 'flex: 1; background: transparent; border: none; outline: none; color: inherit; font-size: 11.5px; padding: 4px 2px;'
							})) as HTMLInputElement;
							const providerBadgeEl = append(searchHeader, $('span', {
								style: 'font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: rgba(59, 130, 246, 0.2); color: #60a5fa; text-transform: uppercase;'
							}, (field.targetProvider || 'openai').toUpperCase()));

							const modelListContainer = append(modelDropdown, $('div', {
								style: 'max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;'
							}));

							const fallbackModelsMap: Record<string, string[]> = {
								openai: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
								gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
								anthropic: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
								ollama: ['llama3.1', 'qwen2.5-coder', 'mistral', 'deepseek-r1'],
								'custom-openai': ['gpt-4o'],
								aliyun: ['qwen-flash', 'qwen-plus', 'qwen4-max', 'deepseek-v4.1-flash']
							};

							let configuredCreds: IAgentCredential[] = [];

							const isModelFromAnotherProvider = (modelId: string | undefined, providerId: string): boolean => {
								if (!modelId || modelId === 'custom') {
									return false;
								}
								const m = modelId.toLowerCase();
								if (providerId !== 'gemini' && (m.startsWith('gemini') || m.startsWith('gemma') || m.startsWith('learnlm'))) {
									return true;
								}
								if (providerId !== 'openai' && (m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('chatgpt-'))) {
									return true;
								}
								if (providerId !== 'anthropic' && m.startsWith('claude')) {
									return true;
								}
								if (providerId !== 'ollama' && !isOpenAICompatibleProvider(providerId) && (m.startsWith('llama') || m.startsWith('qwen') || m.startsWith('mistral') || m.startsWith('deepseek-r1'))) {
									return true;
								}
								return false;
							};

							const getModelsForProvider = (provId: string): Array<{ id: string; badge?: string }> => {
								const matchingCreds = configuredCreds.filter(c => c && c.isEnabled !== false && c.providerId === provId);
								const combined: Array<{ id: string; badge?: string }> = [];
								const seen = new Set<string>();

								// 1. All cachedModels from user's configured credentials first
								for (const c of matchingCreds) {
									if (Array.isArray(c.cachedModels)) {
										for (const cm of c.cachedModels) {
											if (cm && !seen.has(cm)) {
												seen.add(cm);
												combined.push({ id: cm, badge: provId.toUpperCase() });
											}
										}
									}
								}

								// 2. Fallback defaults if not already present
								const fallbacks = fallbackModelsMap[provId] || fallbackModelsMap['openai'] || [];
								for (const fb of fallbacks) {
									if (fb && !seen.has(fb)) {
										seen.add(fb);
										combined.push({ id: fb, badge: provId.toUpperCase() });
									}
								}

								return combined;
							};

							const renderModelDropdownItems = (filterText: string = '') => {
								clearNode(modelListContainer);
								const provId = field.targetProvider || providerSelect.value || 'openai';
								providerBadgeEl.textContent = provId.toUpperCase();

								const allModels = getModelsForProvider(provId);
								const q = filterText.trim().toLowerCase();
								const filtered = q
									? allModels.filter(m => m.id.toLowerCase().includes(q))
									: allModels;

								if (q && !filtered.some(m => m.id.toLowerCase() === q)) {
									filtered.unshift({ id: filterText.trim(), badge: 'Custom ID' });
								}

								filtered.forEach(m => {
									const isSel = field.targetModel === m.id;
									const item = append(modelListContainer, $('div', {
										style: `padding: 6px 8px; font-size: 11.5px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 8px; background: ${isSel ? 'rgba(59, 130, 246, 0.22)' : 'transparent'}; color: ${isSel ? '#60a5fa' : 'inherit'};`
									}));
									item.onmouseenter = () => {
										if (field.targetModel !== m.id) { item.style.background = 'rgba(255,255,255,0.06)'; }
									};
									item.onmouseleave = () => {
										item.style.background = field.targetModel === m.id ? 'rgba(59, 130, 246, 0.22)' : 'transparent';
									};

									const leftWrap = append(item, $('span', {
										style: 'display: inline-flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;'
									}));
									if (m.badge) {
										append(leftWrap, $('span', {
											style: 'font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: rgba(59, 130, 246, 0.16); color: #93c5fd; flex-shrink: 0;'
										}, m.badge));
									}
									append(leftWrap, $('span', {
										style: 'font-weight: 500; font-family: var(--vscode-editor-font-family, monospace); overflow: hidden; text-overflow: ellipsis;'
									}, m.id));

									item.onmousedown = (e) => {
										e.preventDefault();
										e.stopPropagation();
										field.targetModel = m.id;
										modelBtnLabel.textContent = m.id;
										modelDropdown.style.display = 'none';
										this._syncDraft();
										this._persistCurrentModule().catch(() => { });
									};
								});
							};

							const populateProviders = async () => {
								clearNode(providerSelect);
								try {
									const credService = this._instantiationService.invokeFunction(accessor => {
										try { return accessor.get(IAgentCredentialService); } catch { return undefined; }
									});
									if (credService) {
										configuredCreds = await credService.getCredentials();
									}
								} catch { }

								const standardProviders = [
									{ id: 'openai', label: 'OpenAI' },
									{ id: 'gemini', label: 'Google Gemini' },
									{ id: 'anthropic', label: 'Anthropic Claude' },
									{ id: 'aliyun', label: 'Alibaba Cloud Model Studio' },
									{ id: 'ollama', label: 'Ollama Local' },
									{ id: 'custom-openai', label: 'Custom Endpoint' }
								];

								let activeProv = field.targetProvider || 'openai';
								if (!field.targetProvider && field.targetModel) {
									if (field.targetModel.startsWith('gemini')) { activeProv = 'gemini'; }
									else if (field.targetModel.startsWith('claude')) { activeProv = 'anthropic'; }
									else if (field.targetModel.startsWith('gpt') || field.targetModel.startsWith('o1') || field.targetModel.startsWith('o3')) { activeProv = 'openai'; }
									else if (field.targetModel.startsWith('llama') || field.targetModel.startsWith('qwen') || field.targetModel.startsWith('mistral') || field.targetModel.startsWith('deepseek-r1')) { activeProv = 'ollama'; }
								}

								standardProviders.forEach(p => {
									const matchingCred = configuredCreds.find(c => c && c.isEnabled !== false && c.providerId === p.id);
									const countSuffix = (matchingCred && Array.isArray(matchingCred.cachedModels) && matchingCred.cachedModels.length > 0)
										? ` (${matchingCred.cachedModels.length} models)`
										: '';
									const displayLabel = matchingCred
										? `${matchingCred.name} (${p.id.toUpperCase()})${countSuffix}`
										: p.label;
									const opt = append(providerSelect, $('option', { value: p.id }, displayLabel)) as HTMLOptionElement;
									if (p.id === activeProv) { opt.selected = true; }
								});
								providerSelect.value = activeProv;
								field.targetProvider = providerSelect.value;

								const models = getModelsForProvider(field.targetProvider);
								if (!field.targetModel || field.targetModel === 'custom' || isModelFromAnotherProvider(field.targetModel, field.targetProvider)) {
									field.targetModel = models[0]?.id || 'gpt-4o';
								}
								modelBtnLabel.textContent = field.targetModel;
								providerBadgeEl.textContent = field.targetProvider.toUpperCase();
								renderModelDropdownItems('');
							};

							populateProviders();

							providerSelect.onchange = () => {
								field.targetProvider = providerSelect.value;
								const models = getModelsForProvider(field.targetProvider);
								const preferred = field.targetProvider === 'gemini'
									? ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-flash']
									: field.targetProvider === 'anthropic'
										? ['claude-sonnet-4-5', 'claude-3-5-sonnet-20241022', 'claude-3-5-sonnet']
										: ['gpt-4o', 'gpt-4o-mini', 'gpt-5'];
								const foundPref = preferred.map(p => models.find(m => m.id === p || m.id.includes(p))).find(Boolean);
								field.targetModel = foundPref ? foundPref.id : (models[0]?.id || 'gpt-4o');
								modelBtnLabel.textContent = field.targetModel;
								providerBadgeEl.textContent = field.targetProvider.toUpperCase();
								renderModelDropdownItems(modelSearchInput.value);
								this._syncDraft();
								this._persistCurrentModule().catch(() => { });
							};

							modelPickerBtn.onclick = (e) => {
								e.preventDefault();
								e.stopPropagation();
								const isOpen = modelDropdown.style.display === 'flex';
								modelDropdown.style.display = isOpen ? 'none' : 'flex';
								if (!isOpen) {
									modelSearchInput.value = '';
									renderModelDropdownItems('');
									setTimeout(() => modelSearchInput.focus(), 20);
								}
							};

							modelSearchInput.oninput = () => {
								renderModelDropdownItems(modelSearchInput.value);
							};

							modelSearchInput.onkeydown = (e) => {
								if (e.key === 'Enter' && modelSearchInput.value.trim()) {
									e.preventDefault();
									e.stopPropagation();
									const q = modelSearchInput.value.trim().toLowerCase();
									const allModels = getModelsForProvider(field.targetProvider || 'openai');
									const firstMatch = allModels.find(m => m.id.toLowerCase().includes(q));
									field.targetModel = firstMatch ? firstMatch.id : modelSearchInput.value.trim();
									modelBtnLabel.textContent = field.targetModel;
									modelDropdown.style.display = 'none';
									this._syncDraft();
									this._persistCurrentModule().catch(() => { });
								} else if (e.key === 'Escape') {
									modelDropdown.style.display = 'none';
								}
							};

							modelSearchInput.onblur = () => {
								setTimeout(() => {
									modelDropdown.style.display = 'none';
								}, 180);
							};
						}
					};

					modelModeBtn.onclick = () => {
						field.targetMode = 'model';
						modelModeBtn.style.background = 'rgba(59, 130, 246, 0.18)';
						modelModeBtn.style.color = '#60a5fa';
						modelModeBtn.style.borderColor = 'rgba(59, 130, 246, 0.5)';
						agentModeBtn.style.background = 'rgba(255, 255, 255, 0.05)';
						agentModeBtn.style.color = '#ccc';
						agentModeBtn.style.borderColor = 'rgba(255, 255, 255, 0.15)';
						renderTargetSelector();
						this._syncDraft();
						this._persistCurrentModule().catch(() => { });
					};

					agentModeBtn.onclick = () => {
						field.targetMode = 'agent';
						agentModeBtn.style.background = 'rgba(56, 189, 248, 0.2)';
						agentModeBtn.style.color = '#38bdf8';
						agentModeBtn.style.borderColor = 'rgba(56, 189, 248, 0.5)';
						modelModeBtn.style.background = 'rgba(255, 255, 255, 0.05)';
						modelModeBtn.style.color = '#ccc';
						modelModeBtn.style.borderColor = 'rgba(255, 255, 255, 0.15)';
						renderTargetSelector();
						this._syncDraft();
						this._persistCurrentModule().catch(() => { });
					};

					renderTargetSelector();

					// Collect available referenceable fields (primitives from the schema, excluding Output/Result manifest)
					const allSchemaFields = (this._activeModule?.fields && this._activeModule.fields.length > 0) ? this._activeModule.fields : fields;
					const referenceableFields = allSchemaFields.filter(f => {
						if (!f || f === field) { return false; }
						const ft = (f.type || '').toLowerCase();
						const fl = (f.label || f.id || '').toLowerCase().trim();
						return ft !== 'output' && fl !== 'output';
					});

					if (field.promptPreInjectedVisible === undefined) {
						field.promptPreInjectedVisible = false;
					}

					// Pre-Injected Prompt / System Template Section
					const promptTextRow = append(promptSchemaBox, $('div', {
						style: 'display: flex; flex-direction: column; gap: 6px; position: relative; padding: 10px 12px; border-radius: 6px; background: rgba(59, 130, 246, 0.04); border: 1px solid rgba(59, 130, 246, 0.22);'
					}));
					const promptTop = append(promptTextRow, $('div', {
						style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;'
					}));
					const promptTopLeft = append(promptTop, $('div', {
						style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;'
					}));
					append(promptTopLeft, $('label', {
						style: 'font-size: 11px; font-weight: 600; color: #60a5fa;'
					}, 'Pre-Injected Prompt (Template Instruction):'));

					const promptTopRight = append(promptTop, $('div', {
						style: 'display: flex; align-items: center; gap: 10px; flex-wrap: wrap;'
					}));
					append(promptTopRight, $('span', {
						style: 'font-size: 10px; color: #38bdf8;'
					}, 'Supports {Field Label} or @Field references'));

					// Visible / Invisible Toggle Switch Button for Ticket Instances
					const visibilityToggleBtn = append(promptTopRight, $('button.monaco-button', {
						type: 'button',
						style: 'display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; font-size: 10.5px; font-weight: 600; border-radius: 14px; cursor: pointer; transition: all 0.15s ease; user-select: none;',
						title: 'Toggle whether this Pre-Injected Prompt panel is visible or completely hidden (invisible) inside actual Ticket instances'
					})) as HTMLButtonElement;
					const visIcon = append(visibilityToggleBtn, $('span'));
					const visLabel = append(visibilityToggleBtn, $('span'));
					const visSwitchTrack = append(visibilityToggleBtn, $('span', {
						style: 'width: 24px; height: 13px; border-radius: 10px; position: relative; display: inline-flex; align-items: center; padding: 1px; transition: background 0.15s ease;'
					}));
					const visSwitchThumb = append(visSwitchTrack, $('span', {
						style: 'width: 11px; height: 11px; border-radius: 50%; background: #ffffff; transition: transform 0.15s ease;'
					}));

					const updatePreInjectedVisibilityUI = () => {
						const isVis = Boolean(field.promptPreInjectedVisible);
						visIcon.className = isVis
							? ThemeIcon.asClassName(Codicon.eye)
							: ThemeIcon.asClassName(Codicon.eyeClosed);
						visLabel.textContent = isVis ? 'Visible in Ticket' : 'Invisible in Ticket';
						if (isVis) {
							visibilityToggleBtn.style.background = 'rgba(59, 130, 246, 0.2)';
							visibilityToggleBtn.style.border = '1px solid rgba(59, 130, 246, 0.55)';
							visibilityToggleBtn.style.color = '#60a5fa';
							visSwitchTrack.style.background = '#3b82f6';
							visSwitchThumb.style.transform = 'translateX(11px)';
						} else {
							visibilityToggleBtn.style.background = 'rgba(59, 130, 246, 0.08)';
							visibilityToggleBtn.style.border = '1px solid rgba(59, 130, 246, 0.28)';
							visibilityToggleBtn.style.color = '#93c5fd';
							visSwitchTrack.style.background = 'rgba(148, 163, 184, 0.35)';
							visSwitchThumb.style.transform = 'translateX(0px)';
						}
					};
					updatePreInjectedVisibilityUI();

					visibilityToggleBtn.onclick = (e) => {
						e.preventDefault();
						e.stopPropagation();
						field.promptPreInjectedVisible = !field.promptPreInjectedVisible;
						updatePreInjectedVisibilityUI();
						this._syncDraft();
						this._persistCurrentModule().catch(() => { });
					};

					const buildVarMap = () => {
						const map = new Map<string, { label: string; type: string }>();
						const registerVar = (keyRaw: string, info: { label: string; type: string }, overwrite = true) => {
							const k = keyRaw.toLowerCase().trim();
							if (!k) { return; }
							if (overwrite || !map.has(k)) {
								map.set(k, info);
							}
							const kUnderscore = k.replace(/[\s_]+/g, '_');
							if (!map.has(kUnderscore)) {
								map.set(kUnderscore, info);
							}
							const kSpace = k.replace(/[\s_]+/g, ' ');
							if (!map.has(kSpace)) {
								map.set(kSpace, info);
							}
						};
						getReferenceTokensForField(field).forEach(rt => {
							registerVar(rt.label, { label: rt.label, type: rt.type }, true);
						});
						fields.forEach(rf => {
							if (!rf || rf === field) { return; }
							const ft = (rf.type || '').toLowerCase();
							if (ft === 'output') { return; }
							const l = (rf.label || rf.id || '').trim();
							if (l) {
								registerVar(l, { label: l, type: (rf.type || 'PRIMITIVE').toUpperCase() }, true);
							}
							if (rf.id && rf.id !== l) {
								registerVar(rf.id, { label: l || rf.id, type: (rf.type || 'PRIMITIVE').toUpperCase() }, false);
							}
						});
						return map;
					};

					const mountPromptEditorBox = (
						sectionContainer: HTMLElement,
						initialText: string,
						placeholderText: string,
						onValueChange: (val: string, persistNow: boolean) => void,
						boxOptions?: {
							onRemove?: () => void;
							onMoveUp?: () => void;
							onMoveDown?: () => void;
							onMoveToPosition?: () => void;
							canMoveUp?: boolean;
							canMoveDown?: boolean;
							indexLabel?: string;
							removeTooltip?: string;
						}
					): HTMLTextAreaElement => {
						const wrapperEl = append(sectionContainer, $('div.prompt-template-wrapper', {
							style: 'position: relative; width: 100%;',
							'data-expanded': 'false'
						}));

						const DEFAULT_BOX_MAX_HEIGHT = 156;
						let isBoxExpanded = false;
						let isBoxLocked = Boolean((initialText || '').trim().length > 0);
						const hasReorderBtns = Boolean(boxOptions?.indexLabel);
						const rightPadPx = hasReorderBtns ? 106 : 48;

						const topActionsWrap = append(wrapperEl, $('div.prompt-box-top-actions', {
							style: 'position: absolute; top: 4px; right: 6px; z-index: 15; display: inline-flex; align-items: center; gap: 2px;'
						}));
						if (boxOptions?.indexLabel) {
							const idxBadge = append(topActionsWrap, $('span', {
								style: `font-size: 9.5px; font-weight: 700; color: #38bdf8; background: transparent; border: none; padding: 0 3px; line-height: 1; user-select: none; opacity: 0.85; cursor: ${boxOptions.onMoveToPosition ? 'pointer' : 'default'};`,
								title: boxOptions.onMoveToPosition ? `Click to jump / move ${boxOptions.indexLabel} to any position` : boxOptions.indexLabel
							}, boxOptions.indexLabel));
							if (boxOptions.onMoveToPosition) {
								idxBadge.onmousedown = (e: MouseEvent) => {
									e.preventDefault();
									e.stopPropagation();
								};
								idxBadge.onclick = (e: MouseEvent) => {
									e.preventDefault();
									e.stopPropagation();
									boxOptions.onMoveToPosition?.();
								};
							}
						}

						const lockIconBtn = append(topActionsWrap, $('button.prompt-lock-box-btn', {
							type: 'button',
							style: `display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 3px; cursor: pointer; color: ${isBoxLocked ? '#fbbf24' : '#34d399'}; background: transparent; border: none; opacity: 0.9; padding: 0; transition: all 120ms ease;`,
							title: isBoxLocked
								? 'Locked (Read-Only) — Click to Unlock for editing'
								: 'Unlocked (Editable) — Click to Lock and protect from accidental edits'
						})) as HTMLButtonElement;
						const lockIconSpan = append(lockIconBtn, $('span' + ThemeIcon.asCSSSelector(isBoxLocked ? Codicon.lock : Codicon.unlock), { style: 'font-size: 12px;' }));

						if (boxOptions?.indexLabel) {
							const canUp = Boolean(boxOptions.canMoveUp);
							const moveUpBtn = append(topActionsWrap, $('button.prompt-move-up-box-btn', {
								type: 'button',
								style: `display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 3px; cursor: ${canUp ? 'pointer' : 'default'}; color: #cbd5e1; background: transparent; border: none; opacity: ${canUp ? '0.8' : '0.22'}; pointer-events: ${canUp ? 'auto' : 'none'}; padding: 0; transition: all 120ms ease;`,
								title: canUp ? `Move ${boxOptions.indexLabel} Up` : 'Already at the top (#1)'
							})) as HTMLButtonElement;
							append(moveUpBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowUp), { style: 'font-size: 12px;' }));
							moveUpBtn.onmousedown = (e: MouseEvent) => {
								e.preventDefault();
								e.stopPropagation();
							};
							moveUpBtn.onclick = (e: MouseEvent) => {
								e.preventDefault();
								e.stopPropagation();
								boxOptions.onMoveUp?.();
							};

							const canDown = Boolean(boxOptions.canMoveDown);
							const moveDownBtn = append(topActionsWrap, $('button.prompt-move-down-box-btn', {
								type: 'button',
								style: `display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 3px; cursor: ${canDown ? 'pointer' : 'default'}; color: #cbd5e1; background: transparent; border: none; opacity: ${canDown ? '0.8' : '0.22'}; pointer-events: ${canDown ? 'auto' : 'none'}; padding: 0; transition: all 120ms ease;`,
								title: canDown ? `Move ${boxOptions.indexLabel} Down` : 'Already at the bottom'
							})) as HTMLButtonElement;
							append(moveDownBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowDown), { style: 'font-size: 12px;' }));
							moveDownBtn.onmousedown = (e: MouseEvent) => {
								e.preventDefault();
								e.stopPropagation();
							};
							moveDownBtn.onclick = (e: MouseEvent) => {
								e.preventDefault();
								e.stopPropagation();
								boxOptions.onMoveDown?.();
							};
						}

						const expandIconBtn = append(topActionsWrap, $('button.prompt-expand-box-btn', {
							type: 'button',
							style: 'display: none; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 3px; cursor: pointer; color: #38bdf8; background: transparent; border: none; opacity: 0.9; padding: 0; transition: all 120ms ease;',
							title: 'Expand input box to show full content'
						})) as HTMLButtonElement;
						const expandIconSpan = append(expandIconBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.chevronDown), { style: 'font-size: 13px;' }));

						if (boxOptions?.onRemove) {
							const removeIconBtn = append(topActionsWrap, $('button.prompt-remove-box-icon-btn', {
								type: 'button',
								style: 'display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 3px; cursor: pointer; color: #f87171; background: transparent; border: none; opacity: 0.72; padding: 0; transition: all 120ms ease;',
								title: boxOptions.removeTooltip || 'Delete this user prompt input box (Requires Confirmation)'
							})) as HTMLButtonElement;
							append(removeIconBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), { style: 'font-size: 12px;' }));
							removeIconBtn.onmouseenter = () => {
								removeIconBtn.style.opacity = '1';
							};
							removeIconBtn.onmouseleave = () => {
								removeIconBtn.style.opacity = '0.72';
							};
							removeIconBtn.onmousedown = (e: MouseEvent) => {
								e.preventDefault();
								e.stopPropagation();
							};
							removeIconBtn.onclick = async (e: MouseEvent) => {
								e.preventDefault();
								e.stopPropagation();
								const rawTxt = (textareaEl.value || '').trim();
								const previewSnippet = rawTxt
									? (rawTxt.length > 120 ? `${rawTxt.slice(0, 120)}...` : rawTxt)
									: '';
								const targetLabel = boxOptions.indexLabel
									? `User Prompt Input ${boxOptions.indexLabel}`
									: 'this User Prompt Input Box';
								const confirmRes = await this.dialogService.confirm({
									type: 'warning',
									title: 'Confirm Delete Prompt Input Box',
									message: `Are you sure you want to delete ${targetLabel}?`,
									detail: previewSnippet
										? `Content preview:\n"${previewSnippet}"\n\nThis segment will be removed from the prompt list.`
										: `This will remove ${targetLabel} from the prompt list.`,
									primaryButton: 'Delete',
									cancelButton: 'Cancel'
								});
								if (confirmRes.confirmed) {
									boxOptions.onRemove?.();
								}
							};
						}

						// Tokenized Display View (Cursor-style pills for referenced outputs) - capped at default max height unless expanded
						const displayEl = append(wrapperEl, $('div.prompt-tokenized-display', {
							style: `width: 100%; min-height: 118px; max-height: ${DEFAULT_BOX_MAX_HEIGHT}px; overflow-y: auto; padding: 8px ${rightPadPx}px 18px 10px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.25); color: inherit; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace); line-height: 1.5; white-space: pre-wrap; word-break: break-word; cursor: text; user-select: text; -webkit-user-select: text; transition: all 0.15s ease;`,
							title: 'Click to edit prompt'
						}));
						displayEl.onmouseenter = () => {
							displayEl.style.borderColor = 'rgba(56, 189, 248, 0.35)';
						};
						displayEl.onmouseleave = () => {
							displayEl.style.borderColor = 'rgba(255, 255, 255, 0.15)';
						};

						const textareaEl = append(wrapperEl, $('textarea.monaco-inputbox', {
							rows: 5,
							placeholder: placeholderText,
							style: `width: 100%; height: 140px; min-height: 118px; max-height: ${DEFAULT_BOX_MAX_HEIGHT}px; overflow-y: auto; padding: 8px ${rightPadPx}px 18px 10px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(56, 189, 248, 0.5); background: rgba(0, 0, 0, 0.35); color: inherit; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace); line-height: 1.5; display: none; resize: vertical;`
						})) as HTMLTextAreaElement;
						textareaEl.value = initialText;
						tokenizedDisplayTextareas.set(displayEl, textareaEl);

						const bottomExpandPill = append(wrapperEl, $('button.prompt-expand-bottom-pill', {
							type: 'button',
							style: 'display: none;'
						})) as HTMLButtonElement;
						const bottomExpandIcon = append(bottomExpandPill, $('span' + ThemeIcon.asCSSSelector(Codicon.chevronDown), { style: 'font-size: 11px;' }));
						const bottomExpandLabel = append(bottomExpandPill, $('span', {}, 'Expand'));

						const syncExpandStateUI = () => {
							const txt = textareaEl.value || '';
							const isLong = isBoxExpanded
								|| txt.length > 240
								|| txt.split(/\r?\n/).length > 5
								|| displayEl.scrollHeight > (DEFAULT_BOX_MAX_HEIGHT + 6)
								|| textareaEl.scrollHeight > (DEFAULT_BOX_MAX_HEIGHT + 6);

							if (isBoxExpanded) {
								displayEl.style.maxHeight = 'none';
								displayEl.style.height = 'auto';
								textareaEl.style.maxHeight = 'none';
								if (textareaEl.style.display !== 'none') {
									textareaEl.style.height = `${Math.max(200, textareaEl.scrollHeight + 12)}px`;
								}
							} else {
								displayEl.style.maxHeight = `${DEFAULT_BOX_MAX_HEIGHT}px`;
								displayEl.style.height = 'auto';
								textareaEl.style.maxHeight = `${DEFAULT_BOX_MAX_HEIGHT}px`;
								textareaEl.style.height = '140px';
							}

							expandIconBtn.style.display = isLong ? 'inline-flex' : 'none';
							expandIconBtn.title = isBoxExpanded
								? 'Collapse input box to default compact height'
								: 'Expand input box to show full content';
							expandIconBtn.style.background = 'transparent';
							expandIconBtn.style.border = 'none';
							expandIconSpan.className = ThemeIcon.asClassName(isBoxExpanded ? Codicon.chevronUp : Codicon.chevronDown);

							bottomExpandPill.style.display = 'none';
							bottomExpandIcon.className = ThemeIcon.asClassName(isBoxExpanded ? Codicon.chevronUp : Codicon.chevronDown);
							bottomExpandLabel.textContent = isBoxExpanded ? 'Collapse' : 'Expand';
						};

						const toggleBoxExpand = (e: MouseEvent) => {
							e.preventDefault();
							e.stopPropagation();
							isBoxExpanded = !isBoxExpanded;
							wrapperEl.setAttribute('data-expanded', isBoxExpanded ? 'true' : 'false');
							syncExpandStateUI();
						};

						expandIconBtn.onmousedown = (e: MouseEvent) => {
							e.preventDefault();
							e.stopPropagation();
						};
						expandIconBtn.onclick = toggleBoxExpand;

						bottomExpandPill.onmousedown = (e: MouseEvent) => {
							e.preventDefault();
							e.stopPropagation();
						};
						bottomExpandPill.onclick = toggleBoxExpand;

						let lastSelectionStart: number | undefined = undefined;
						let lastSelectionEnd: number | undefined = undefined;
						const recordSelection = () => {
							if (typeof textareaEl.selectionStart === 'number') {
								lastSelectionStart = textareaEl.selectionStart;
							}
							if (typeof textareaEl.selectionEnd === 'number') {
								lastSelectionEnd = textareaEl.selectionEnd;
							}
						};
						textareaEl.addEventListener('keyup', recordSelection);
						textareaEl.addEventListener('click', recordSelection);
						textareaEl.addEventListener('mouseup', recordSelection);
						textareaEl.addEventListener('select', recordSelection);
						textareaEl.addEventListener('input', () => {
							recordSelection();
							syncExpandStateUI();
						});

						const resolveClickOffsetInDisplay = (ev?: MouseEvent): number | undefined => {
							const content = textareaEl.value || '';
							if (!content || !ev) {
								return undefined;
							}
							const targetNode = ev.target as HTMLElement | null;
							const clickedPill = targetNode?.closest('.prompt-token-pill') as HTMLElement | null;
							if (clickedPill) {
								const s = parseInt(clickedPill.getAttribute('data-raw-start') || '', 10);
								const e = parseInt(clickedPill.getAttribute('data-raw-end') || '', 10);
								if (Number.isFinite(s) && Number.isFinite(e)) {
									const rect = clickedPill.getBoundingClientRect();
									return (ev.clientX - rect.left) < rect.width / 2 ? s : e;
								}
							}
							const caretDoc = getWindow(ev).document;
							let hitNode: Node | null = null;
							let hitOffset = 0;
							if (typeof caretDoc.caretRangeFromPoint === 'function') {
								const range = caretDoc.caretRangeFromPoint(ev.clientX, ev.clientY);
								if (range) {
									hitNode = range.startContainer;
									hitOffset = range.startOffset;
								}
							} else if (typeof caretDoc.caretPositionFromPoint === 'function') {
								const pos = caretDoc.caretPositionFromPoint(ev.clientX, ev.clientY);
								if (pos) {
									hitNode = pos.offsetNode;
									hitOffset = pos.offset;
								}
							}
							if (hitNode && displayEl.contains(hitNode)) {
								for (let i = 0; i < displayEl.childNodes.length; i++) {
									const child = displayEl.childNodes[i];
									if (child === hitNode || child.contains(hitNode)) {
										const el = child as HTMLElement;
										const rawStart = parseInt(el.getAttribute?.('data-raw-start') || '', 10);
										const rawEnd = parseInt(el.getAttribute?.('data-raw-end') || '', 10);
										if (Number.isFinite(rawStart) && Number.isFinite(rawEnd)) {
											if (el.classList?.contains('prompt-token-pill')) {
												const rect = el.getBoundingClientRect();
												return (ev.clientX - rect.left) < rect.width / 2 ? rawStart : rawEnd;
											}
											if (hitNode.nodeType === Node.TEXT_NODE) {
												return Math.min(rawEnd, rawStart + hitOffset);
											}
											return rawStart;
										}
									}
								}
							}
							return undefined;
						};

						// Voice Input (Speech-to-Text) Control - Consistent with Agent Central
						const voiceControlWrap = append(wrapperEl, $('div.prompt-voice-input-controls', {
							style: 'position: absolute; bottom: 4px; right: 6px; z-index: 15; display: inline-flex; align-items: center; gap: 4px;'
						}));
						const recordingIndicator = append(voiceControlWrap, $('div.prompt-voice-recording-indicator', {
							style: 'display: none; align-items: center; gap: 6px; font-size: 11px; color: #ff3b30; font-weight: 500; background: rgba(15, 23, 42, 0.92); border: 1px solid rgba(255, 59, 48, 0.35); padding: 2px 8px; border-radius: 12px; user-select: none;'
						}));
						append(recordingIndicator, $('span.prompt-voice-recording-dot', {
							style: 'width: 8px; height: 8px; border-radius: 50%; background-color: #ff3b30; display: inline-block;'
						}));
						const recordingTimeSpan = append(recordingIndicator, $('span'));
						recordingTimeSpan.textContent = '0:00 / 5:00';

						const micBtn = append(voiceControlWrap, $('button.prompt-voice-mic-btn', {
							type: 'button',
							style: 'display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 3px; cursor: pointer; color: var(--vscode-foreground); background: transparent; border: none; opacity: 0.65; padding: 0; transition: all 120ms ease;',
							title: 'Record voice input (Speech-to-Text)'
						})) as HTMLButtonElement;
						append(micBtn, $('span.codicon.codicon-mic', { style: 'font-size: 12.5px;' }));

						let isRecordingVoice = false;
						let isTranscribingVoice = false;
						let mediaRecorder: MediaRecorder | null = null;
						let audioChunks: BlobPart[] = [];
						let recordingTimer: number | undefined = undefined;
						let recordingSeconds = 0;
						let activeStream: MediaStream | undefined = undefined;

						const applyMicVisualState = (hovered = false) => {
							if (isRecordingVoice) {
								micBtn.style.color = '#ff3b30';
								micBtn.style.opacity = '1';
								micBtn.style.background = 'rgba(255, 59, 48, 0.14)';
								micBtn.style.border = 'none';
								micBtn.style.boxShadow = 'none';
								micBtn.title = 'Stop recording and transcribe';
							} else {
								micBtn.style.color = hovered ? '#38bdf8' : 'var(--vscode-foreground)';
								micBtn.style.opacity = (hovered || isTranscribingVoice) ? '1' : (isBoxLocked ? '0.28' : '0.65');
								micBtn.style.background = 'transparent';
								micBtn.style.border = 'none';
								micBtn.style.boxShadow = 'none';
								micBtn.title = isBoxLocked
									? 'Locked — Unlock this prompt box first to record voice input'
									: 'Record voice input (Speech-to-Text)';
							}
						};

						micBtn.onmouseenter = () => applyMicVisualState(true);
						micBtn.onmouseleave = () => applyMicVisualState(false);
						micBtn.onmousedown = (e: MouseEvent) => {
							e.preventDefault();
							e.stopPropagation();
							recordSelection();
						};

						const stopVoiceRecording = () => {
							if (recordingTimer) {
								getWindow(micBtn).clearInterval(recordingTimer);
								recordingTimer = undefined;
							}
							if (mediaRecorder && isRecordingVoice) {
								try {
									mediaRecorder.stop();
								} catch { }
								isRecordingVoice = false;
							} else {
								isRecordingVoice = false;
								if (!isTranscribingVoice) {
									recordingIndicator.style.display = 'none';
								}
							}
							micBtn.classList.remove('recording');
							applyMicVisualState(false);
						};

						const startVoiceRecording = async () => {
							if (isTranscribingVoice) {
								return;
							}
							recordSelection();
							try {
								const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
								activeStream = stream;
								audioChunks = [];
								mediaRecorder = new (getWindow(micBtn).MediaRecorder)(stream);

								mediaRecorder.ondataavailable = (e: BlobEvent) => {
									if (e.data && e.data.size > 0) {
										audioChunks.push(e.data);
									}
								};

								mediaRecorder.onstop = async () => {
									isTranscribingVoice = true;
									applyMicVisualState(false);
									stream.getTracks().forEach(track => track.stop());
									activeStream = undefined;

									const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
									recordingIndicator.style.display = 'inline-flex';
									recordingTimeSpan.textContent = 'Transcribing voice...';

									try {
										const voiceModelService = this._instantiationService.invokeFunction(accessor => accessor.get(IVoiceModelService));
										const result = await voiceModelService.transcribeAudio(audioBlob);
										if (result.text && result.text.trim()) {
											const transcribed = result.text.trim();
											const existing = textareaEl.value || '';
											let start = typeof lastSelectionStart === 'number'
												? lastSelectionStart
												: (isEditMode && typeof textareaEl.selectionStart === 'number' ? textareaEl.selectionStart : existing.length);
											let end = typeof lastSelectionEnd === 'number'
												? lastSelectionEnd
												: (isEditMode && typeof textareaEl.selectionEnd === 'number' ? textareaEl.selectionEnd : existing.length);

											if (start < 0 || start > existing.length) { start = existing.length; }
											if (end < 0 || end > existing.length) { end = existing.length; }
											if (start > end) { const tmp = start; start = end; end = tmp; }

											const beforeText = existing.substring(0, start);
											const afterText = existing.substring(end);
											let insertText = transcribed;
											if (start > 0 && !/\s$/.test(beforeText) && !/^\s/.test(insertText)) {
												insertText = ' ' + insertText;
											}
											if (end < existing.length && !/^\s/.test(afterText) && !/\s$/.test(insertText)) {
												insertText = insertText + ' ';
											}

											textareaEl.value = beforeText + insertText + afterText;
											const newCursorPos = start + insertText.length;
											lastSelectionStart = newCursorPos;
											lastSelectionEnd = newCursorPos;
											textareaEl.selectionStart = newCursorPos;
											textareaEl.selectionEnd = newCursorPos;

											onValueChange(textareaEl.value, true);
											renderTokenized();
											if (isEditMode) {
												textareaEl.focus();
											}
										} else if (result.error) {
											this.notificationService.warn(`Voice Transcription: ${result.error}`);
										}
									} catch (err) {
										console.error('Failed to transcribe voice input:', err);
										this.notificationService.error(`Voice transcription error: ${(err as Error | undefined)?.message || err}`);
									} finally {
										isTranscribingVoice = false;
										recordingIndicator.style.display = 'none';
										applyMicVisualState(false);
									}
								};

								mediaRecorder.start();
								isRecordingVoice = true;
								recordingSeconds = 0;
								recordingIndicator.style.display = 'inline-flex';
								recordingTimeSpan.textContent = '0:00 / 5:00';
								micBtn.classList.add('recording');
								applyMicVisualState(false);

								recordingTimer = getWindow(micBtn).setInterval(() => {
									recordingSeconds++;
									const mins = Math.floor(recordingSeconds / 60);
									const secs = recordingSeconds % 60;
									recordingTimeSpan.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs} / 5:00`;
									if (recordingSeconds >= 300) {
										stopVoiceRecording();
									}
								}, 1000);
							} catch (err) {
								console.error('Error accessing microphone:', err);
								this.notificationService.error(`Microphone access error: ${(err as Error | undefined)?.message || err}`);
							}
						};

						const pulseLockBtn = () => {
							const prevShadow = lockIconBtn.style.boxShadow;
							const prevTransform = lockIconBtn.style.transform;
							lockIconBtn.style.boxShadow = '0 0 0 3px rgba(245, 158, 11, 0.45)';
							lockIconBtn.style.transform = 'scale(1.12)';
							displayEl.style.borderColor = 'rgba(245, 158, 11, 0.55)';
							setTimeout(() => {
								lockIconBtn.style.boxShadow = prevShadow || '';
								lockIconBtn.style.transform = prevTransform || '';
								displayEl.style.borderColor = 'rgba(255, 255, 255, 0.15)';
							}, 450);
						};

						const syncLockStateUI = () => {
							wrapperEl.setAttribute('data-locked', isBoxLocked ? 'true' : 'false');
							lockIconBtn.style.color = isBoxLocked ? '#fbbf24' : '#34d399';
							lockIconBtn.style.background = 'transparent';
							lockIconBtn.style.border = 'none';
							lockIconBtn.title = isBoxLocked
								? 'Locked (Read-Only) — Click to Unlock for editing'
								: 'Unlocked (Editable) — Click to Lock and protect from accidental edits';
							lockIconSpan.className = ThemeIcon.asClassName(isBoxLocked ? Codicon.lock : Codicon.unlock);
							displayEl.style.cursor = 'text';
							displayEl.title = isBoxLocked
								? 'Locked (Read-Only, text can be selected & copied) — Click the lock icon in the top-right to unlock and edit'
								: 'Click to edit prompt';
							micBtn.style.opacity = isBoxLocked ? '0.28' : '0.65';
						};

						lockIconBtn.onmousedown = (e: MouseEvent) => {
							e.preventDefault();
							e.stopPropagation();
						};
						lockIconBtn.onclick = (e: MouseEvent) => {
							e.preventDefault();
							e.stopPropagation();
							isBoxLocked = !isBoxLocked;
							if (isBoxLocked && isEditMode) {
								recordSelection();
								isEditMode = false;
								textareaEl.style.display = 'none';
								displayEl.style.display = 'block';
								onValueChange(textareaEl.value, true);
								renderTokenized();
								textareaEl.blur();
							}
							syncLockStateUI();
						};

						micBtn.onclick = (e: MouseEvent) => {
							e.preventDefault();
							e.stopPropagation();
							if (isBoxLocked) {
								pulseLockBtn();
								this.notificationService.info('This prompt box is locked. Click the lock icon in the top-right to unlock before recording voice input.');
								return;
							}
							if (isRecordingVoice) {
								stopVoiceRecording();
							} else {
								startVoiceRecording();
							}
						};

						this._renderCleanupFns.push(() => {
							if (recordingTimer) {
								getWindow(micBtn).clearInterval(recordingTimer);
								recordingTimer = undefined;
							}
							if (activeStream) {
								activeStream.getTracks().forEach(t => t.stop());
								activeStream = undefined;
							}
						});

						const autoMenu = append(wrapperEl, $('div.prompt-autocomplete-menu', {
							style: 'display: none; position: absolute; z-index: 50; max-height: 160px; overflow-y: auto; background: #1e293b; border: 1px solid #38bdf8; border-radius: 5px; box-shadow: 0 4px 16px rgba(0,0,0,0.5); width: 280px; padding: 4px;'
						}));

						const renderTokenized = () => {
							clearNode(displayEl);
							const content = textareaEl.value;
							if (!content) {
								append(displayEl, $('span', {
									style: 'color: rgba(255, 255, 255, 0.35); font-style: italic;'
								}, placeholderText));
								syncExpandStateUI();
								return;
							}

							const varMap = buildVarMap();
							const regex = /\{([^{}\n]+)\}/g;
							let lastIndex = 0;
							let match: RegExpExecArray | null;

							const appendRawTextSpan = (startIdx: number, endIdx: number) => {
								if (endIdx <= startIdx) {
									return;
								}
								const spanEl = append(displayEl, $('span.prompt-raw-segment', {
									'data-raw-start': String(startIdx),
									'data-raw-end': String(endIdx)
								}));
								spanEl.textContent = content.substring(startIdx, endIdx);
							};

							while ((match = regex.exec(content)) !== null) {
								const matchStart = match.index;
								const matchEnd = regex.lastIndex;
								const varRawName = match[1].trim();
								const varInfo = varMap.get(varRawName.toLowerCase());

								if (matchStart > lastIndex) {
									appendRawTextSpan(lastIndex, matchStart);
								}

								if (varInfo) {
									const rawTokenStr = content.substring(matchStart, matchEnd);
									const pill = append(displayEl, $('span.prompt-token-pill', {
										'data-raw-start': String(matchStart),
										'data-raw-end': String(matchEnd),
										'data-raw-token': rawTokenStr,
										style: 'display: inline; white-space: nowrap; padding: 1px 6px; font-size: 11px; font-weight: 500; border-radius: 3.5px; background: rgba(56, 189, 248, 0.12); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.28); vertical-align: baseline; font-family: var(--vscode-editor-font-family, monospace); user-select: text; -webkit-user-select: text; margin: 0 1.5px; line-height: 1.35; cursor: text; transition: all 0.15s ease;'
									}));
									this._attachInstantTooltip(pill, `Referenced Output: ${varInfo.label} [${varInfo.type}] (Click to edit)`, '#38bdf8');
									pill.onmouseenter = () => {
										pill.style.background = 'rgba(56, 189, 248, 0.22)';
										pill.style.borderColor = 'rgba(56, 189, 248, 0.45)';
									};
									pill.onmouseleave = () => {
										pill.style.background = 'rgba(56, 189, 248, 0.12)';
										pill.style.borderColor = 'rgba(56, 189, 248, 0.28)';
									};
									append(pill, $('span' + ThemeIcon.asCSSSelector(Codicon.link), { style: 'font-size: 10px; opacity: 0.85; margin-right: 3.5px; vertical-align: -1px; user-select: none; -webkit-user-select: none;' }));
									append(pill, $('span', { style: 'font-size: 0; line-height: 0; opacity: 0;' }, '{'));
									append(pill, $('span', { style: 'font-weight: 600;' }, varInfo.label));
									append(pill, $('span', { style: 'font-size: 0; line-height: 0; opacity: 0;' }, '}'));
								} else {
									appendRawTextSpan(matchStart, matchEnd);
								}

								lastIndex = matchEnd;
							}

							if (lastIndex < content.length) {
								appendRawTextSpan(lastIndex, content.length);
							}
							syncExpandStateUI();
						};

						let isEditMode = false;
						syncLockStateUI();

						const switchToEdit = (ev?: MouseEvent, explicitCaretOffset?: number) => {
							if (isBoxLocked) {
								pulseLockBtn();
								return;
							}
							const clickOffset = typeof explicitCaretOffset === 'number'
								? explicitCaretOffset
								: resolveClickOffsetInDisplay(ev);
							const savedScrollTop = displayEl.scrollTop;
							if (!isEditMode) {
								isEditMode = true;
								displayEl.style.display = 'none';
								textareaEl.style.display = 'block';
								const h = displayEl.getBoundingClientRect().height;
								if (isBoxExpanded) {
									textareaEl.style.maxHeight = 'none';
									textareaEl.style.height = `${Math.max(200, Math.round(h), textareaEl.scrollHeight + 12)}px`;
								} else {
									textareaEl.style.maxHeight = `${DEFAULT_BOX_MAX_HEIGHT}px`;
									textareaEl.style.height = `${Math.min(DEFAULT_BOX_MAX_HEIGHT, Math.max(118, Math.round(h || 140)))}px`;
								}
								syncExpandStateUI();
							}
							const textLen = textareaEl.value.length;
							const targetPos = typeof clickOffset === 'number'
								? Math.max(0, Math.min(textLen, clickOffset))
								: (typeof lastSelectionStart === 'number' ? Math.max(0, Math.min(textLen, lastSelectionStart)) : textLen);
							const targetEnd = typeof clickOffset === 'number'
								? targetPos
								: (typeof lastSelectionEnd === 'number' ? Math.max(targetPos, Math.min(textLen, lastSelectionEnd)) : targetPos);
							lastSelectionStart = targetPos;
							lastSelectionEnd = targetEnd;
							textareaEl.focus({ preventScroll: true });
							textareaEl.setSelectionRange(targetPos, targetEnd);
							if (savedScrollTop > 0) {
								textareaEl.scrollTop = savedScrollTop;
							}
						};

						const switchToDisplay = () => {
							if (!isEditMode) { return; }
							recordSelection();
							const savedScrollTop = textareaEl.scrollTop;
							isEditMode = false;
							onValueChange(textareaEl.value, true);
							renderTokenized();
							textareaEl.style.display = 'none';
							displayEl.style.display = 'block';
							if (savedScrollTop > 0) {
								displayEl.scrollTop = savedScrollTop;
							}
						};

						displayEl.onclick = (ev: MouseEvent) => {
							const sel = getWindow(displayEl).getSelection()?.toString() || '';
							if (sel.length > 0) {
								return;
							}
							switchToEdit(ev);
						};

						let blurTimer: ReturnType<typeof setTimeout> | null = null;
						textareaEl.onblur = () => {
							recordSelection();
							if (blurTimer) { clearTimeout(blurTimer); }
							blurTimer = setTimeout(() => {
								if (autoMenu.style.display === 'block') {
									return;
								}
								switchToDisplay();
							}, 200);
						};

						const insertTextAtCursor = (insertText: string) => {
							if (isBoxLocked) {
								pulseLockBtn();
								this.notificationService.info('This prompt box is locked. Click the lock icon in the top-right to unlock before inserting fields.');
								return;
							}
							if (blurTimer) {
								clearTimeout(blurTimer);
								blurTimer = null;
							}
							const current = textareaEl.value || '';
							const start = isEditMode && typeof textareaEl.selectionStart === 'number'
								? textareaEl.selectionStart
								: (typeof lastSelectionStart === 'number' ? Math.min(current.length, Math.max(0, lastSelectionStart)) : current.length);
							const end = isEditMode && typeof textareaEl.selectionEnd === 'number'
								? textareaEl.selectionEnd
								: (typeof lastSelectionEnd === 'number' ? Math.min(current.length, Math.max(start, lastSelectionEnd)) : start);
							const savedScrollTop = isEditMode ? textareaEl.scrollTop : displayEl.scrollTop;
							textareaEl.value = current.substring(0, start) + insertText + current.substring(end);
							const newPos = start + insertText.length;
							lastSelectionStart = newPos;
							lastSelectionEnd = newPos;
							textareaEl.selectionStart = newPos;
							textareaEl.selectionEnd = newPos;
							onValueChange(textareaEl.value, true);
							renderTokenized();
							autoMenu.style.display = 'none';
							if (isEditMode) {
								isEditMode = false;
								textareaEl.style.display = 'none';
								displayEl.style.display = 'block';
							}
							if (savedScrollTop > 0) {
								displayEl.scrollTop = savedScrollTop;
							}
						};

						renderTokenized();

						// Quick Reference Insert Toolbar (Clickable Chips) - Placed below the textarea
						const chipBar = append(sectionContainer, $('div', {
							style: 'display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-top: 2px;'
						}));
						let isPromptChipsExpanded = false;

						const renderPromptChips = () => {
							clearNode(chipBar);
							const promptRefTokens = getReferenceTokensForField(field).filter(
								rt => rt.label.toLowerCase() !== 'title' && rt.label.toLowerCase() !== 'description'
							);
							const allPromptTokens = promptRefTokens.length > 0 ? promptRefTokens : getReferenceTokensForField(field);
							if (allPromptTokens.length === 0) {
								chipBar.style.display = 'none';
								return;
							}
							chipBar.style.display = 'flex';
							append(chipBar, $('span', { style: 'font-size: 10.5px; opacity: 0.65;' }, 'Insert Output:'));
							const chipStyle = 'padding: 2px 7px; font-size: 10.5px; font-weight: 500; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.3); background: rgba(56, 189, 248, 0.1); color: #38bdf8; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap; transition: all 0.15s ease;';

							const maxInitialVisible = 4;
							const visibleTokens = allPromptTokens.slice(0, maxInitialVisible);
							const hiddenTokens = allPromptTokens.slice(maxInitialVisible);

							visibleTokens.forEach(rt => {
								const chip = append(chipBar, $('button.prompt-insert-chip', {
									type: 'button',
									style: chipStyle,
									title: `Click to insert reference {${rt.label}} (${rt.type})`
								}));
								chip.textContent = `+ {${rt.label}}`;
								chip.onmousedown = (e) => {
									e.preventDefault();
									e.stopPropagation();
									recordSelection();
								};
								chip.onclick = (e) => {
									e.preventDefault();
									e.stopPropagation();
									insertTextAtCursor(`{${rt.label}}`);
								};
							});

							if (hiddenTokens.length > 0) {
								const hiddenContainer = append(chipBar, $('span', {
									style: isPromptChipsExpanded ? 'display: contents;' : 'display: none;'
								}));
								hiddenTokens.forEach(rt => {
									const chip = append(hiddenContainer, $('button.prompt-insert-chip', {
										type: 'button',
										style: chipStyle,
										title: `Click to insert reference {${rt.label}} (${rt.type})`
									}));
									chip.textContent = `+ {${rt.label}}`;
									chip.onmousedown = (e) => {
										e.preventDefault();
										e.stopPropagation();
										recordSelection();
									};
									chip.onclick = (e) => {
										e.preventDefault();
										e.stopPropagation();
										insertTextAtCursor(`{${rt.label}}`);
									};
								});

								const moreBtn = append(chipBar, $('button', {
									type: 'button',
									style: 'padding: 2px 8px; font-size: 10px; font-weight: 600; border-radius: 4px; border: 1px dashed rgba(56, 189, 248, 0.4); background: rgba(56, 189, 248, 0.06); color: #38bdf8; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; white-space: nowrap;',
									title: 'Toggle more referenceable outputs'
								}, isPromptChipsExpanded ? 'Less' : `+${hiddenTokens.length} More...`));

								moreBtn.onmousedown = (e) => {
									e.preventDefault();
									e.stopPropagation();
									recordSelection();
								};
								moreBtn.onclick = (e) => {
									e.preventDefault();
									e.stopPropagation();
									isPromptChipsExpanded = !isPromptChipsExpanded;
									hiddenContainer.style.display = isPromptChipsExpanded ? 'contents' : 'none';
									moreBtn.textContent = isPromptChipsExpanded ? 'Less' : `+${hiddenTokens.length} More...`;
								};
							}
						};

						renderPromptChips();
						referenceChipRefreshers.push(() => {
							renderPromptChips();
							renderTokenized();
						});

						const showAutocomplete = (prefix: string) => {
							clearNode(autoMenu);
							const query = prefix.toLowerCase();
							const filtered = getReferenceTokensForField(field).filter(rt =>
								rt.label.toLowerCase().includes(query) ||
								rt.type.toLowerCase().includes(query)
							);
							if (filtered.length === 0) {
								autoMenu.style.display = 'none';
								return;
							}
							filtered.forEach(rt => {
								const rfLabel = rt.label;
								const itemEl = append(autoMenu, $('div.prompt-autocomplete-item', {
									style: 'padding: 5px 8px; font-size: 11px; cursor: pointer; display: flex; align-items: center; justify-content: space-between; border-radius: 3px; transition: background 0.1s ease;'
								}));
								itemEl.onmouseenter = () => itemEl.style.background = 'rgba(56, 189, 248, 0.2)';
								itemEl.onmouseleave = () => itemEl.style.background = 'transparent';
								append(itemEl, $('span', { style: 'font-weight: 600; color: #f1f5f9;' }, rfLabel));
								append(itemEl, $('span', { style: 'font-size: 9px; color: #38bdf8; background: rgba(56,189,248,0.15); padding: 1px 4px; border-radius: 2px;' }, rt.type));

								itemEl.onmousedown = (e) => {
									e.preventDefault();
									e.stopPropagation();
									const start = textareaEl.selectionStart || 0;
									const textBefore = textareaEl.value.substring(0, start);
									const lastTriggerIdx = Math.max(textBefore.lastIndexOf('@'), textBefore.lastIndexOf('{'));
									if (lastTriggerIdx >= 0) {
										textareaEl.value = textareaEl.value.substring(0, lastTriggerIdx) + `{${rfLabel}}` + textareaEl.value.substring(start);
										textareaEl.selectionStart = textareaEl.selectionEnd = lastTriggerIdx + rfLabel.length + 2;
									} else {
										insertTextAtCursor(`{${rfLabel}}`);
									}
									onValueChange(textareaEl.value, true);
									renderTokenized();
									autoMenu.style.display = 'none';
								};
							});

							autoMenu.style.display = 'block';
							autoMenu.style.bottom = '30px';
							autoMenu.style.left = '10px';
						};

						textareaEl.oninput = () => {
							onValueChange(textareaEl.value, false);

							const cursor = textareaEl.selectionStart || 0;
							const before = textareaEl.value.substring(0, cursor);
							const lastAt = before.lastIndexOf('@');
							const lastBrace = before.lastIndexOf('{');
							const triggerIdx = Math.max(lastAt, lastBrace);

							if (triggerIdx >= 0 && triggerIdx >= cursor - 25) {
								const query = before.substring(triggerIdx + 1);
								if (!/[\s\n}]/.test(query)) {
									showAutocomplete(query);
									return;
								}
							}
							autoMenu.style.display = 'none';
						};

						textareaEl.onkeydown = (e) => {
							if (e.key === 'Escape') {
								if (autoMenu.style.display === 'block') {
									autoMenu.style.display = 'none';
								} else {
									switchToDisplay();
								}
							}
						};

						return textareaEl;
					};

					const promptTextarea = mountPromptEditorBox(
						promptTextRow,
						field.defaultContent || '',
						'e.g. Please analyze the ticket details:\nGet the result of {Linkedin Product Manager AI Software} above and extract each job as json...',
						(val, persistNow) => {
							field.defaultContent = val;
							this._syncDraft();
							if (persistNow) {
								this._persistCurrentModule().catch(() => { });
							}
						}
					);

					// User Prompt Input Space (Ticket User Input Box - Supports 1 or Multiple Sequential Input Boxes, Visible by Default, Can be Hidden or Deleted)
					if (field.promptUserInputVisible === undefined) {
						field.promptUserInputVisible = true;
					}

					const userPromptSection = append(promptSchemaBox, $('div', {
						style: 'display: flex; flex-direction: column; gap: 8px; position: relative; padding: 10px 12px; border-radius: 6px; background: rgba(59, 130, 246, 0.04); border: 1px solid rgba(59, 130, 246, 0.22);'
					}));
					const userPromptHeader = append(userPromptSection, $('div', {
						style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;'
					}));
					const userPromptHeaderLeft = append(userPromptHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;'
					}));
					append(userPromptHeaderLeft, $('label', {
						style: 'font-size: 11px; font-weight: 600; color: #60a5fa;'
					}, 'User Prompt Input Space (Ticket User Textbox):'));
					const userPromptCountBadge = append(userPromptHeaderLeft, $('span', {
						style: 'font-size: 9.5px; padding: 1px 6px; border-radius: 10px; background: rgba(56, 189, 248, 0.16); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); font-weight: 600; display: none;'
					}));

					const userPromptHeaderRight = append(userPromptHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 10px; flex-wrap: wrap;'
					}));
					append(userPromptHeaderRight, $('span', {
						style: 'font-size: 10px; color: #38bdf8;'
					}, 'Combined in order when sent to AI'));

					// Visible / Invisible Toggle Switch Button for User Prompt Input Space in Ticket Instances (Default: Visible)
					const userInputVisToggleBtn = append(userPromptHeaderRight, $('button.monaco-button', {
						type: 'button',
						style: 'display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; font-size: 10.5px; font-weight: 600; border-radius: 14px; cursor: pointer; transition: all 0.15s ease; user-select: none;',
						title: 'Toggle whether this User Prompt Input Space is visible (expanded by default) or hidden inside Ticket instances'
					})) as HTMLButtonElement;
					const userVisIcon = append(userInputVisToggleBtn, $('span'));
					const userVisLabel = append(userInputVisToggleBtn, $('span'));
					const userVisSwitchTrack = append(userInputVisToggleBtn, $('span', {
						style: 'width: 24px; height: 13px; border-radius: 10px; position: relative; display: inline-flex; align-items: center; padding: 1px; transition: background 0.15s ease;'
					}));
					const userVisSwitchThumb = append(userVisSwitchTrack, $('span', {
						style: 'width: 11px; height: 11px; border-radius: 50%; background: #ffffff; transition: transform 0.15s ease;'
					}));

					const userPromptsList: string[] = Array.isArray(field.defaultUserPrompts)
						? [...field.defaultUserPrompts]
						: (field.promptUserInputVisible === false ? [] : [field.defaultUserPrompt || '']);

					const userPromptBoxesContainer = append(userPromptSection, $('div.user-prompt-boxes-list', {
						style: 'display: flex; flex-direction: column; gap: 10px;'
					}));

					const updateUserPromptVisibilityUI = () => {
						const isVis = field.promptUserInputVisible !== false;
						userVisIcon.className = isVis
							? ThemeIcon.asClassName(Codicon.eye)
							: ThemeIcon.asClassName(Codicon.eyeClosed);
						userVisLabel.textContent = isVis ? 'Visible in Ticket' : 'Invisible in Ticket';
						if (isVis) {
							userInputVisToggleBtn.style.background = 'rgba(59, 130, 246, 0.2)';
							userInputVisToggleBtn.style.border = '1px solid rgba(59, 130, 246, 0.55)';
							userInputVisToggleBtn.style.color = '#60a5fa';
							userVisSwitchTrack.style.background = '#3b82f6';
							userVisSwitchThumb.style.transform = 'translateX(11px)';
							userPromptBoxesContainer.style.display = userPromptsList.length > 0 ? 'flex' : 'none';
						} else {
							userInputVisToggleBtn.style.background = 'rgba(59, 130, 246, 0.08)';
							userInputVisToggleBtn.style.border = '1px solid rgba(59, 130, 246, 0.28)';
							userInputVisToggleBtn.style.color = '#93c5fd';
							userVisSwitchTrack.style.background = 'rgba(148, 163, 184, 0.35)';
							userVisSwitchThumb.style.transform = 'translateX(0px)';
							userPromptBoxesContainer.style.display = 'none';
						}
					};

					const syncUserPromptsToField = (persistNow: boolean) => {
						field.defaultUserPrompts = [...userPromptsList];
						const nonEmpty = userPromptsList.map(s => (s || '').trim()).filter(s => s.length > 0);
						if (userPromptsList.length === 0) {
							field.defaultUserPrompt = '';
						} else if (userPromptsList.length === 1) {
							field.defaultUserPrompt = userPromptsList[0] || '';
						} else if (nonEmpty.length > 0) {
							field.defaultUserPrompt = nonEmpty.map((s, i) => `[User Input #${i + 1}]:\n${s}`).join('\n\n');
						} else {
							field.defaultUserPrompt = '';
						}
						this._syncDraft();
						if (persistNow) {
							this._persistCurrentModule().catch(() => { });
						}
					};

					const renderUserPromptBoxes = () => {
						clearNode(userPromptBoxesContainer);
						const totalBoxes = userPromptsList.length;
						if (totalBoxes > 1 && field.promptUserInputVisible !== false) {
							userPromptCountBadge.style.display = 'inline-block';
							userPromptCountBadge.textContent = `${totalBoxes} Inputs`;
						} else {
							userPromptCountBadge.style.display = 'none';
						}
						updateUserPromptVisibilityUI();

						userPromptsList.forEach((boxVal, boxIdx) => {
							const itemBox = append(userPromptBoxesContainer, $('div.user-prompt-box-item', {
								style: 'display: flex; flex-direction: column; gap: 6px;'
							}));

							mountPromptEditorBox(
								itemBox,
								boxVal || '',
								totalBoxes > 1
									? `Enter or voice-dictate User Input #${boxIdx + 1} (e.g. experience / item #${boxIdx + 1})...`
									: 'Optional default user prompt (or leave blank for users to enter their own prompt instructions inside the ticket)...',
								(val, persistNow) => {
									userPromptsList[boxIdx] = val;
									syncUserPromptsToField(persistNow);
								},
								{
									indexLabel: totalBoxes > 1 ? `#${boxIdx + 1}` : undefined,
									canMoveUp: totalBoxes > 1 && boxIdx > 0,
									canMoveDown: totalBoxes > 1 && boxIdx < totalBoxes - 1,
									onMoveUp: () => {
										if (boxIdx > 0) {
											const [moved] = userPromptsList.splice(boxIdx, 1);
											userPromptsList.splice(boxIdx - 1, 0, moved);
											syncUserPromptsToField(true);
											renderUserPromptBoxes();
										}
									},
									onMoveDown: () => {
										if (boxIdx < userPromptsList.length - 1) {
											const [moved] = userPromptsList.splice(boxIdx, 1);
											userPromptsList.splice(boxIdx + 1, 0, moved);
											syncUserPromptsToField(true);
											renderUserPromptBoxes();
										}
									},
									onMoveToPosition: async () => {
										const res = await this.dialogService.input({
											type: 'question',
											title: `Move User Input #${boxIdx + 1}`,
											message: `Enter target position (1 ~ ${totalBoxes}) to move User Input #${boxIdx + 1} to:`,
											inputs: [{ value: String(boxIdx + 1), placeholder: `1 ~ ${totalBoxes}` }],
											primaryButton: 'Move'
										});
										if (res.confirmed && res.values && res.values[0]) {
											const targetPos = parseInt(res.values[0].trim(), 10);
											if (Number.isFinite(targetPos) && targetPos >= 1 && targetPos <= totalBoxes && (targetPos - 1) !== boxIdx) {
												const [moved] = userPromptsList.splice(boxIdx, 1);
												userPromptsList.splice(targetPos - 1, 0, moved);
												syncUserPromptsToField(true);
												renderUserPromptBoxes();
											}
										}
									},
									removeTooltip: totalBoxes > 1
										? `Delete User Input #${boxIdx + 1} (Requires Confirmation)`
										: 'Delete User Prompt Input Box (Requires Confirmation)',
									onRemove: () => {
										userPromptsList.splice(boxIdx, 1);
										if (userPromptsList.length === 0) {
											field.promptUserInputVisible = false;
										}
										syncUserPromptsToField(true);
										renderUserPromptBoxes();
									}
								}
							);
						});
					};

					userInputVisToggleBtn.onclick = (e) => {
						e.preventDefault();
						e.stopPropagation();
						const nextVis = field.promptUserInputVisible === false;
						field.promptUserInputVisible = nextVis;
						if (nextVis && userPromptsList.length === 0) {
							userPromptsList.push('');
						}
						syncUserPromptsToField(true);
						renderUserPromptBoxes();
					};

					renderUserPromptBoxes();

					const addUserPromptBtnRow = append(userPromptSection, $('div', {
						style: 'display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 4px;'
					}));
					const addUserPromptBoxBtn = append(addUserPromptBtnRow, $('button.monaco-button', {
						type: 'button',
						style: 'width: auto; display: inline-flex; align-items: center; gap: 6px; padding: 5px 14px; font-size: 11px; font-weight: 600; border-radius: 6px; cursor: pointer; background: linear-gradient(135deg, #059669, #10b981); color: #ffffff; border: 1px solid #34d399; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3); transition: all 0.15s ease;',
						title: 'Add a user prompt input box below so users can enter or voice-dictate input segments'
					}));
					append(addUserPromptBoxBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.add), { style: 'font-size: 12px;' }));
					append(addUserPromptBoxBtn, $('span', {}, 'Add User Prompt Input Box'));
					addUserPromptBoxBtn.onmouseenter = () => {
						addUserPromptBoxBtn.style.background = 'linear-gradient(135deg, #10b981, #059669)';
						addUserPromptBoxBtn.style.borderColor = '#6ee7b7';
						addUserPromptBoxBtn.style.boxShadow = '0 3px 8px rgba(16, 185, 129, 0.35)';
					};
					addUserPromptBoxBtn.onmouseleave = () => {
						addUserPromptBoxBtn.style.background = 'linear-gradient(135deg, #059669, #10b981)';
						addUserPromptBoxBtn.style.borderColor = '#34d399';
						addUserPromptBoxBtn.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.3)';
					};
					addUserPromptBoxBtn.onclick = (e) => {
						e.preventDefault();
						e.stopPropagation();
						field.promptUserInputVisible = true;
						userPromptsList.push('');
						syncUserPromptsToField(true);
						renderUserPromptBoxes();
					};

					// Debug: AI Prompt Test Execution Area (Template Preview)
					const promptDebugArea = append(promptSchemaBox, $('.prompt-debug-container', {
						style: 'display: flex; flex-direction: column; gap: 8px; margin-top: 6px; padding-top: 10px; border-top: 1px solid rgba(255, 255, 255, 0.08);'
					}));

					const debugHeader = append(promptDebugArea, $('div', {
						style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;'
					}));

					const debugHeaderLeft = append(debugHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;'
					}));

					append(debugHeaderLeft, $('span', {
						style: 'font-size: 11px; font-weight: 600; opacity: 0.9; text-transform: uppercase; color: #94a3b8; white-space: nowrap;'
					}, this._isFlowchartNodeMode ? 'Execution Output: AI Response & Logs:' : 'Debug: AI Execution Output (Test Preview):'));

					append(debugHeaderLeft, $('span.prompt-debug-badge', {
						style: this._isFlowchartNodeMode
							? 'font-size: 9.5px; padding: 2px 6px; border-radius: 3px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); font-weight: 600; white-space: nowrap;'
							: 'font-size: 9.5px; padding: 2px 6px; border-radius: 3px; background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); font-weight: 600; white-space: nowrap;'
					}, this._isFlowchartNodeMode ? 'Node Runtime & Test' : 'Template Debug Only'));

					const promptStatusBadge = append(debugHeaderLeft, $('span.prompt-test-status', {
						style: 'font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(255, 255, 255, 0.06); opacity: 0.9; display: none; white-space: nowrap;'
					}));

					const debugHeaderRight = append(debugHeader, $('div', {
						style: 'display: flex; gap: 5px; align-items: center; flex-wrap: wrap; margin-left: auto;'
					}));

					// Test Prompt Button
					const testPromptBtn = append(debugHeaderRight, $('button.monaco-button', {
						style: 'display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; font-size: 10.5px; font-weight: 600; border-radius: 4px; cursor: pointer; background: rgba(59, 130, 246, 0.22); border: 1px solid rgba(59, 130, 246, 0.5); color: #60a5fa; transition: all 0.15s ease; white-space: nowrap;'
					})) as HTMLButtonElement;
					append(testPromptBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.play)));
					append(testPromptBtn, $('span', {}, 'Test'));

					const viewSentPromptBtn = append(debugHeaderRight, $('button.monaco-button', {
						style: 'display: inline-flex; align-items: center; gap: 4px; background: rgba(56, 189, 248, 0.14); border: 1px solid rgba(56, 189, 248, 0.35); border-radius: 4px; padding: 2px 8px; font-size: 10.5px; font-weight: 600; cursor: pointer; color: #38bdf8; white-space: nowrap;',
						title: 'Inspect the complete prompt sent to AI (Structured breakdown + Full verbatim prompt)'
					})) as HTMLButtonElement;
					append(viewSentPromptBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.eye), { style: 'font-size: 11px;' }));
					append(viewSentPromptBtn, $('span', {}, 'View Sent Prompt'));

					const copyPromptOutBtn = append(debugHeaderRight, $('button.monaco-button', {
						style: 'background: transparent; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 4px; padding: 2px 8px; font-size: 10.5px; opacity: 0.8; cursor: pointer; color: inherit; white-space: nowrap;'
					}));
					copyPromptOutBtn.innerText = 'Copy';

					const clearPromptOutBtn = append(debugHeaderRight, $('button.monaco-button', {
						style: 'background: transparent; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 4px; padding: 2px 8px; font-size: 10.5px; opacity: 0.8; cursor: pointer; color: inherit; white-space: nowrap;'
					}));
					clearPromptOutBtn.innerText = 'Clear';

					const promptOutputDisplay = append(promptDebugArea, $('.prompt-output-display', {
						style: 'min-height: 110px; max-height: 260px; overflow-y: auto; padding: 10px 12px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 6px; color: #e2e8f0; user-select: text; -webkit-user-select: text; cursor: text;'
					}));

					const resetPromptOutputPlaceholder = () => {
						clearNode(promptOutputDisplay);
						append(promptOutputDisplay, $('span', { style: 'opacity: 0.4; font-style: italic;' }, 'No test response yet. Click "Test" to test your instruction with the configured AI model/agent during template design. (This is debug preview only, not saved to ticket instances)'));
					};

					if (field.debugPromptOutput) {
						promptOutputDisplay.textContent = field.debugPromptOutput;
						if ((field as IRuntimeCustomField).lastExecutionStatus === 'success') {
							promptStatusBadge.textContent = `Completed in ${(field as IRuntimeCustomField).lastExecutionDurationMs ?? 0}ms${(field as IRuntimeCustomField).lastExecutedAt ? ` · ${(field as IRuntimeCustomField).lastExecutedAt}` : ''}`;
							promptStatusBadge.style.color = '#4ade80';
						} else if ((field as IRuntimeCustomField).lastExecutionStatus === 'failed') {
							promptStatusBadge.textContent = `Failed (${(field as IRuntimeCustomField).lastExecutionDurationMs ?? 0}ms)${(field as IRuntimeCustomField).lastExecutedAt ? ` · ${(field as IRuntimeCustomField).lastExecutedAt}` : ''}`;
							promptStatusBadge.style.color = '#f87171';
						} else {
							promptStatusBadge.textContent = 'Saved Preview';
							promptStatusBadge.style.color = '#34d399';
						}
						promptStatusBadge.style.display = 'inline-block';
					} else {
						resetPromptOutputPlaceholder();
					}

					viewSentPromptBtn.onclick = () => {
						this._openSchemaSentPromptModal(promptTextarea, field, allSchemaFields);
					};

					copyPromptOutBtn.onclick = () => {
						const text = promptOutputDisplay.textContent || '';
						if (text && !text.startsWith('No test response')) {
							this._clipboardService.writeText(text);
							this.notificationService.info('Prompt output copied to clipboard.');
						}
					};

					clearPromptOutBtn.onclick = async () => {
						resetPromptOutputPlaceholder();
						promptStatusBadge.textContent = '';
						promptStatusBadge.style.display = 'none';
						field.debugPromptOutput = '';
						this._syncDraft();
						await this._persistCurrentModule();
					};

					testPromptBtn.onclick = async () => {
						testPromptBtn.disabled = true;
						testPromptBtn.style.opacity = '0.5';
						try {
							await this._executePromptTest(promptTextarea, promptStatusBadge, promptOutputDisplay, field, allSchemaFields);
						} finally {
							testPromptBtn.disabled = false;
							testPromptBtn.style.opacity = '1';
						}
					};
				}

				if (field.type === 'tts') {
					if (!field.ttsFormat) {
						field.ttsFormat = 'mp3';
					}
					if (!field.targetProvider) {
						field.targetProvider = 'gemini';
					}
					if (!field.targetModel) {
						field.targetModel = field.targetProvider === 'openai' ? 'tts-1' : 'gemini-2.5-flash-preview-tts';
					}
					if (!field.ttsVoice) {
						field.ttsVoice = field.targetProvider === 'openai' ? 'alloy' : 'Kore';
					}

					const ttsSchemaBox = append(fieldCard, $('.tts-schema-config', {
						style: 'display: flex; flex-direction: column; gap: 10px; padding: 12px; background: rgba(236, 72, 153, 0.05); border: 1px solid rgba(236, 72, 153, 0.25); border-radius: 6px; margin-top: 4px;'
					}));

					const ttsNotice = append(ttsSchemaBox, $('div', {
						style: 'font-size: 11px; color: #f472b6; display: flex; align-items: center; gap: 6px; font-weight: 500;'
					}));
					append(ttsNotice, $('span' + ThemeIcon.asCSSSelector(Codicon.unmute)));
					append(ttsNotice, $('span', {}, 'Audio / TTS Primitive: Paste multilingual text (English, Chinese, French, etc.), select an AI model (consistent with Agent Central), and generate persistent MP3 audio.'));

					// =========================================================================
					// ZONE 1: Collapsible AI Model Config + Speech Synthesis Source + Send/Delete
					// =========================================================================
					const speechZoneBox = append(ttsSchemaBox, $('div', {
						style: 'display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 6px; background: rgba(236, 72, 153, 0.05); border: 1px solid rgba(236, 72, 153, 0.24); margin-top: 2px;'
					}));

					const zone1TopHeader = append(speechZoneBox, $('div', {
						style: 'display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;'
					}));
					const llmLabelWrap = append(zone1TopHeader, $('div', { style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;' }));
					append(llmLabelWrap, $('label', {
						style: 'font-size: 11px; font-weight: 600; opacity: 0.95; color: #f472b6;'
					}, 'AI Model & Speech Synthesis Script:'));
					const visibilityBadgeEl = append(llmLabelWrap, $('span', {
						style: 'font-size: 9.5px; padding: 1px 6px; border-radius: 3px; background: rgba(236, 72, 153, 0.15); color: #f9a8d4; border: 1px solid rgba(236, 72, 153, 0.3); font-weight: 600;'
					}, field.ttsShowSpeechTextInTicket ? 'Sent to TTS API · Expanded by Default in Ticket' : 'Sent to TTS API · Collapsed by Default in Ticket'));

					const llmHeaderActions = append(zone1TopHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;'
					}));

					const showSpeechInTicketLabel = append(llmHeaderActions, $('label', {
						style: 'display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; cursor: pointer; user-select: none; padding: 2px 8px; border-radius: 4px; background: rgba(236, 72, 153, 0.1); border: 1px solid rgba(236, 72, 153, 0.3); color: #f9a8d4;',
						title: 'Choose whether the AI Model, Format/Voice settings, Speech Synthesis Text, and Send/Delete Audio buttons are expanded or collapsed by default in the Ticket.'
					}));
					const showSpeechInTicketCheckbox = append(showSpeechInTicketLabel, $('input', {
						type: 'checkbox',
						style: 'cursor: pointer; margin: 0;'
					})) as HTMLInputElement;
					showSpeechInTicketCheckbox.checked = Boolean(field.ttsShowSpeechTextInTicket);
					append(showSpeechInTicketLabel, $('span', {}, 'Expand by default in Ticket'));

					showSpeechInTicketCheckbox.onchange = () => {
						field.ttsShowSpeechTextInTicket = showSpeechInTicketCheckbox.checked;
						visibilityBadgeEl.textContent = field.ttsShowSpeechTextInTicket
							? 'Sent to TTS API · Expanded by Default in Ticket'
							: 'Sent to TTS API · Collapsed by Default in Ticket';
						this._syncDraft();
					};

					const toggleSchemaZone1Btn = append(llmHeaderActions, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 2px 9px; font-size: 10px; font-weight: 600; border-radius: 4px; background: rgba(236, 72, 153, 0.15); border: 1px solid rgba(236, 72, 153, 0.35); color: #f9a8d4; cursor: pointer;',
						title: 'Collapse or expand AI Model settings and Speech Synthesis Text in template designer'
					}, 'Collapse AI Section'));

					// Collapsible body inside Zone 1 (contains Model/Format/Voice/AutoPlay + Speech Textarea + Send/Delete buttons)
					const speechZoneBody = append(speechZoneBox, $('div', {
						style: 'display: flex; flex-direction: column; gap: 8px;'
					}));

					toggleSchemaZone1Btn.onclick = () => {
						const isVisible = speechZoneBody.style.display !== 'none';
						speechZoneBody.style.display = isVisible ? 'none' : 'flex';
						toggleSchemaZone1Btn.textContent = isVisible ? 'Show AI Section' : 'Collapse AI Section';
					};

					// Row 1 inside Zone 1: Agent Central-style Credential / Provider + Searchable Model Picker + Format/Voice/Auto-Play
					const modelSettingsCard = append(speechZoneBody, $('div', {
						style: 'display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; border-radius: 6px; background: rgba(0, 0, 0, 0.22); border: 1px solid rgba(236, 72, 153, 0.2);'
					}));

					const selectorBar = append(modelSettingsCard, $('div', {
						style: 'display: flex; gap: 8px; align-items: center; flex-wrap: wrap; position: relative;'
					}));
					append(selectorBar, $('span', {
						style: 'font-size: 11px; font-weight: 600; color: #f472b6; min-width: 65px;'
					}, 'AI Model:'));

					// 1A. Provider / Credential Select (matches Agent Central)
					const credSelect = append(selectorBar, $('select.monaco-select-box', {
						style: 'min-width: 170px; padding: 5px 8px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(236, 72, 153, 0.35); background: rgba(0, 0, 0, 0.3); color: inherit; cursor: pointer;',
						title: 'Select AI Provider / Configured Credential (consistent with Agent Central)'
					})) as HTMLSelectElement;

					// 1B. Searchable Model Picker Button + Floating Dropdown (matches Agent Central)
					const modelPickerWrapper = append(selectorBar, $('div', {
						style: 'flex: 1; min-width: 210px; position: relative;'
					}));

					const modelPickerBtn = append(modelPickerWrapper, $('button.monaco-button', {
						type: 'button',
						style: 'width: 100%; padding: 5px 10px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(236, 72, 153, 0.35); background: rgba(0, 0, 0, 0.3); color: inherit; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 6px; text-align: left;',
						title: 'Select or search TTS / AI Model'
					})) as HTMLButtonElement;

					const modelBtnLeft = append(modelPickerBtn, $('span', { style: 'display: inline-flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }));
					append(modelBtnLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.sparkle), { style: 'color: #f472b6; font-size: 12px;' }));
					const modelBtnLabel = append(modelBtnLeft, $('span', { style: 'font-weight: 600;' }, field.targetModel || 'gemini-2.5-flash-preview-tts'));
					append(modelPickerBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.chevronDown), { style: 'font-size: 11px; opacity: 0.7;' }));

					const modelDropdown = append(modelPickerWrapper, $('div.tts-model-dropdown', {
						style: 'display: none; position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 1000; background: var(--vscode-editorWidget-background, #1e1e1e); border: 1px solid rgba(236, 72, 153, 0.45); border-radius: 6px; box-shadow: 0 10px 28px rgba(0,0,0,0.65); padding: 6px; flex-direction: column; gap: 6px;'
					}));

					const searchHeader = append(modelDropdown, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,0.08);'
					}));
					append(searchHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.search), { style: 'font-size: 12px; opacity: 0.6;' }));
					const modelSearchInput = append(searchHeader, $('input', {
						type: 'text',
						placeholder: 'Search or enter custom model ID...',
						style: 'flex: 1; background: transparent; border: none; outline: none; color: inherit; font-size: 11.5px; padding: 4px 2px;'
					})) as HTMLInputElement;
					const providerBadgeEl = append(searchHeader, $('span', {
						style: 'font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: rgba(236, 72, 153, 0.2); color: #f472b6; text-transform: uppercase;'
					}, (field.targetProvider || 'gemini').toUpperCase()));

					const modelListContainer = append(modelDropdown, $('div', {
						style: 'max-height: 210px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;'
					}));

					// Row 2 inside modelSettingsCard: Output Format (default MP3), Voice Profile, Auto-Play Toggle
					const audioOptionsRow = append(modelSettingsCard, $('div', {
						style: 'display: flex; gap: 12px; align-items: center; flex-wrap: wrap; padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.05);'
					}));

					// Audio Format Select (default mp3)
					const formatGroup = append(audioOptionsRow, $('div', { style: 'display: flex; align-items: center; gap: 6px;' }));
					append(formatGroup, $('label', { style: 'font-size: 11px; font-weight: 600; opacity: 0.85;' }, 'Audio Format:'));
					const formatSelect = append(formatGroup, $('select.monaco-select-box', {
						style: 'padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit;'
					})) as HTMLSelectElement;
					[
						{ value: 'mp3', label: 'MP3 (Default)' },
						{ value: 'wav', label: 'WAV' },
						{ value: 'opus', label: 'OPUS' },
						{ value: 'aac', label: 'AAC' }
					].forEach(fmt => {
						const opt = append(formatSelect, $('option', { value: fmt.value }, fmt.label)) as HTMLOptionElement;
						if ((field.ttsFormat || 'mp3') === fmt.value) {
							opt.selected = true;
						}
					});
					formatSelect.onchange = () => {
						field.ttsFormat = formatSelect.value || 'mp3';
						this._syncDraft();
					};

					// Voice Select
					const voiceGroup = append(audioOptionsRow, $('div', { style: 'display: flex; align-items: center; gap: 6px;' }));
					append(voiceGroup, $('label', { style: 'font-size: 11px; font-weight: 600; opacity: 0.85;' }, 'Voice:'));
					const voiceSelect = append(voiceGroup, $('select.monaco-select-box', {
						style: 'padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit;'
					})) as HTMLSelectElement;

					// Auto-Play Checkbox
					const autoPlayLabel = append(audioOptionsRow, $('label', {
						style: 'display: inline-flex; align-items: center; gap: 6px; font-size: 11px; cursor: pointer; user-select: none; margin-left: auto; padding: 3px 8px; border-radius: 4px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1);',
						title: 'Automatically play the saved MP3 audio when viewing this module in a ticket'
					}));
					const autoPlayCheckbox = append(autoPlayLabel, $('input', {
						type: 'checkbox',
						style: 'cursor: pointer; margin: 0;'
					})) as HTMLInputElement;
					autoPlayCheckbox.checked = Boolean(field.ttsAutoPlay);
					append(autoPlayLabel, $('span', {}, 'Auto-play when viewing module'));
					autoPlayCheckbox.onchange = () => {
						field.ttsAutoPlay = autoPlayCheckbox.checked;
						this._syncDraft();
					};

					const builtInTtsModels: Record<string, Array<{ id: string; badge: string }>> = {
						gemini: [
							{ id: 'gemini-2.5-flash-preview-tts', badge: 'TTS Voice' },
							{ id: 'gemini-2.5-pro-preview-tts', badge: 'TTS HD' },
							{ id: 'gemini-2.0-flash', badge: 'Audio Output' },
							{ id: 'gemini-2.5-flash', badge: 'Multimodal' }
						],
						openai: [
							{ id: 'tts-1', badge: 'TTS Standard' },
							{ id: 'tts-1-hd', badge: 'TTS HD' },
							{ id: 'gpt-4o-mini-tts', badge: 'GPT-4o TTS' },
							{ id: 'gpt-4o-audio-preview', badge: 'Audio' }
						],
						'custom-openai': [
							{ id: 'tts-1', badge: 'TTS' },
							{ id: 'gpt-4o-mini-tts', badge: 'TTS' }
						]
					};

					const providerVoices: Record<string, string[]> = {
						gemini: ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Zephyr', 'Leda', 'Orus'],
						openai: ['alloy', 'nova', 'shimmer', 'echo', 'onyx', 'fable', 'coral', 'sage', 'ash', 'ballad', 'verse'],
						'custom-openai': ['alloy', 'nova', 'shimmer', 'echo', 'onyx', 'fable', 'Kore', 'Puck']
					};

					let loadedCredentials: IAgentCredential[] = [];

					const populateVoiceOptions = (providerId: string) => {
						clearNode(voiceSelect);
						const voices = providerVoices[providerId] || providerVoices.gemini;
						if (!field.ttsVoice || !voices.includes(field.ttsVoice)) {
							field.ttsVoice = voices[0];
						}
						voices.forEach(v => {
							const opt = append(voiceSelect, $('option', { value: v }, v)) as HTMLOptionElement;
							if (v === field.ttsVoice) {
								opt.selected = true;
							}
						});
					};

					voiceSelect.onchange = () => {
						field.ttsVoice = voiceSelect.value;
						this._syncDraft();
					};

					const getActiveProviderId = (): string => {
						const selectedCred = loadedCredentials.find(c => c.id === credSelect.value);
						if (selectedCred) {
							return selectedCred.providerId;
						}
						return credSelect.value || field.targetProvider || 'gemini';
					};

					const renderModelDropdownItems = (filterText: string = '') => {
						clearNode(modelListContainer);
						const provId = getActiveProviderId();
						providerBadgeEl.textContent = provId.toUpperCase();

						const selectedCred = loadedCredentials.find(c => c.id === credSelect.value);
						const cachedModels: string[] = Array.isArray(selectedCred?.cachedModels) ? selectedCred.cachedModels : [];
						const recommended = builtInTtsModels[provId] || builtInTtsModels.gemini;

						const combined: Array<{ id: string; badge?: string }> = [...recommended];
						cachedModels.forEach(cm => {
							if (!combined.some(item => item.id === cm)) {
								combined.push({ id: cm, badge: cm.toLowerCase().includes('tts') || cm.toLowerCase().includes('audio') ? 'Voice' : 'Model' });
							}
						});

						const q = filterText.trim().toLowerCase();
						const filtered = q ? combined.filter(m => m.id.toLowerCase().includes(q)) : combined;

						if (q && !filtered.some(m => m.id.toLowerCase() === q)) {
							filtered.unshift({ id: filterText.trim(), badge: 'Custom ID' });
						}

						filtered.forEach(m => {
							const item = append(modelListContainer, $('div', {
								style: `padding: 6px 8px; font-size: 11.5px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: space-between; background: ${field.targetModel === m.id ? 'rgba(236, 72, 153, 0.2)' : 'transparent'}; color: ${field.targetModel === m.id ? '#f472b6' : 'inherit'};`
							}));
							item.onmouseenter = () => {
								if (field.targetModel !== m.id) { item.style.background = 'rgba(255,255,255,0.06)'; }
							};
							item.onmouseleave = () => {
								item.style.background = field.targetModel === m.id ? 'rgba(236, 72, 153, 0.2)' : 'transparent';
							};
							append(item, $('span', { style: 'font-weight: 500;' }, m.id));
							if (m.badge) {
								append(item, $('span', {
									style: 'font-size: 9px; padding: 1px 5px; border-radius: 3px; background: rgba(255,255,255,0.08); opacity: 0.8;'
								}, m.badge));
							}
							item.onmousedown = (e) => {
								e.preventDefault();
								e.stopPropagation();
								field.targetModel = m.id;
								modelBtnLabel.textContent = m.id;
								modelDropdown.style.display = 'none';
								this._syncDraft();
							};
						});
					};

					const loadTtsCredentials = async () => {
						clearNode(credSelect);
						try {
							const credService = this._instantiationService.invokeFunction(accessor => {
								try { return accessor.get(IAgentCredentialService); } catch { return undefined; }
							});
							if (credService) {
								const allCreds = await credService.getCredentials();
								loadedCredentials = allCreds.filter(c => c.isEnabled !== false);
							}
						} catch { }

						if (loadedCredentials.length > 0) {
							loadedCredentials.forEach(c => {
								const opt = append(credSelect, $('option', { value: c.id }, `${c.name} (${c.providerId.toUpperCase()})`)) as HTMLOptionElement;
								if (field.targetCredentialId === c.id || (!field.targetCredentialId && field.targetProvider === c.providerId)) {
									opt.selected = true;
								}
							});
						} else {
							[
								{ id: 'gemini', label: 'Google Gemini (GEMINI)' },
								{ id: 'openai', label: 'OpenAI (OPENAI)' },
								{ id: 'custom-openai', label: 'Custom OpenAI Endpoint' }
							].forEach(p => {
								const opt = append(credSelect, $('option', { value: p.id }, p.label)) as HTMLOptionElement;
								if (field.targetProvider === p.id) { opt.selected = true; }
							});
						}

						const selCred = loadedCredentials.find(c => c.id === credSelect.value);
						if (selCred) {
							field.targetCredentialId = selCred.id;
							field.targetProvider = selCred.providerId;
						} else {
							field.targetProvider = credSelect.value || 'gemini';
						}

						populateVoiceOptions(field.targetProvider || 'gemini');
						renderModelDropdownItems();
					};

					credSelect.onchange = () => {
						const selCred = loadedCredentials.find(c => c.id === credSelect.value);
						if (selCred) {
							field.targetCredentialId = selCred.id;
							field.targetProvider = selCred.providerId;
						} else {
							field.targetCredentialId = undefined;
							field.targetProvider = credSelect.value;
						}
						const rec = builtInTtsModels[field.targetProvider || 'gemini'] || builtInTtsModels.gemini;
						field.targetModel = rec[0].id;
						modelBtnLabel.textContent = field.targetModel;
						populateVoiceOptions(field.targetProvider || 'gemini');
						renderModelDropdownItems(modelSearchInput.value);
						this._syncDraft();
					};

					modelPickerBtn.onclick = (e) => {
						e.preventDefault();
						e.stopPropagation();
						const isOpen = modelDropdown.style.display === 'flex';
						modelDropdown.style.display = isOpen ? 'none' : 'flex';
						if (!isOpen) {
							modelSearchInput.value = '';
							renderModelDropdownItems('');
							setTimeout(() => modelSearchInput.focus(), 20);
						}
					};

					modelSearchInput.oninput = () => {
						renderModelDropdownItems(modelSearchInput.value);
					};

					modelSearchInput.onblur = () => {
						setTimeout(() => {
							modelDropdown.style.display = 'none';
						}, 180);
					};

					loadTtsCredentials();

					const speechSubHeaderRow = append(speechZoneBody, $('div', {
						style: 'display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;'
					}));
					append(speechSubHeaderRow, $('span', {
						style: 'font-size: 10.5px; font-weight: 600; opacity: 0.85; color: #f9a8d4;'
					}, 'Speech Synthesis Source Text (Pure text sent to AI model):'));

					const clearTextBtn = append(speechSubHeaderRow, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 2px 8px; font-size: 10px; border-radius: 4px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); color: inherit; cursor: pointer;',
						title: 'Clear speech synthesis text'
					}, 'Clear Speech Text'));

					const ttsTextarea = append(speechZoneBody, $('textarea.monaco-inputbox', {
						rows: 3,
						placeholder: 'Paste pure listening text sent to the AI model to generate MP3 audio (without native-language notes; supports {Field} variables)...',
						style: 'width: 100%; padding: 8px 10px; font-size: 12px; line-height: 1.5; border-radius: 6px; border: 1px solid rgba(236, 72, 153, 0.3); background: rgba(0, 0, 0, 0.25); color: inherit; resize: vertical; box-sizing: border-box; font-family: inherit;'
					})) as HTMLTextAreaElement;
					ttsTextarea.value = field.defaultContent || '';

					// Action Footer directly below Speech Synthesis Textarea:
					// Left: Insert Field chips + Status | Right: [Send & Generate Audio] + [Delete Audio]
					const speechActionFooter = append(speechZoneBody, $('div', {
						style: 'display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding-top: 2px;'
					}));

					const speechFooterLeft = append(speechActionFooter, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap; flex: 1;'
					}));

					let lastFocusedTtsInput: 'speech' | 'display' = 'speech';
					ttsTextarea.onfocus = () => { lastFocusedTtsInput = 'speech'; };

					const ttsChipsContainer = append(speechFooterLeft, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;'
					}));

					let isTtsChipsExpanded = false;
					const renderTtsRefChips = () => {
						clearNode(ttsChipsContainer);
						const ttsRefTokens = getReferenceTokensForField(field);
						if (ttsRefTokens.length === 0) {
							ttsChipsContainer.style.display = 'none';
							return;
						}
						ttsChipsContainer.style.display = 'flex';
						append(ttsChipsContainer, $('span', { style: 'font-size: 10px; opacity: 0.65;' }, 'Insert Field:'));

						const maxVisibleTtsChips = 4;
						const visibleTokens = ttsRefTokens.slice(0, maxVisibleTtsChips);
						const hiddenTokens = ttsRefTokens.slice(maxVisibleTtsChips);

						const renderTtsChip = (parentEl: HTMLElement, rfLabel: string) => {
							const chip = append(parentEl, $('button', {
								type: 'button',
								style: 'padding: 2px 7px; font-size: 10px; border-radius: 4px; border: 1px solid rgba(236, 72, 153, 0.35); background: rgba(236, 72, 153, 0.1); color: #f472b6; cursor: pointer; font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap;'
							}, `+ {${rfLabel}}`));
							chip.onmousedown = (e) => {
								e.preventDefault();
								e.stopPropagation();
							};
							chip.onclick = (e) => {
								e.preventDefault();
								e.stopPropagation();
								const targetArea = lastFocusedTtsInput === 'display' ? ttsDisplayTextarea : ttsTextarea;
								const start = typeof targetArea.selectionStart === 'number' ? targetArea.selectionStart : targetArea.value.length;
								const end = typeof targetArea.selectionEnd === 'number' ? targetArea.selectionEnd : start;
								const token = `{${rfLabel}}`;
								targetArea.value = targetArea.value.substring(0, start) + token + targetArea.value.substring(end);
								const newPos = start + token.length;
								targetArea.focus({ preventScroll: true });
								targetArea.setSelectionRange(newPos, newPos);
								if (lastFocusedTtsInput === 'display') {
									field.ttsDisplayText = ttsDisplayTextarea.value;
								} else {
									field.defaultContent = ttsTextarea.value;
								}
								this._syncDraft();
							};
						};

						visibleTokens.forEach(rt => renderTtsChip(ttsChipsContainer, rt.label));

						if (hiddenTokens.length > 0) {
							const hiddenContainer = append(ttsChipsContainer, $('span', {
								style: isTtsChipsExpanded ? 'display: contents;' : 'display: none;'
							}));
							hiddenTokens.forEach(rt => renderTtsChip(hiddenContainer, rt.label));

							const moreBtn = append(ttsChipsContainer, $('button', {
								type: 'button',
								style: 'padding: 2px 7px; font-size: 10px; font-weight: 600; border-radius: 4px; border: 1px dashed rgba(236, 72, 153, 0.45); background: rgba(236, 72, 153, 0.08); color: #f472b6; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; white-space: nowrap;',
								title: 'Show / hide more fields'
							}, isTtsChipsExpanded ? 'Less' : `+${hiddenTokens.length} More...`));
							moreBtn.onmousedown = (e) => {
								e.preventDefault();
								e.stopPropagation();
							};
							moreBtn.onclick = (e) => {
								e.preventDefault();
								e.stopPropagation();
								isTtsChipsExpanded = !isTtsChipsExpanded;
								hiddenContainer.style.display = isTtsChipsExpanded ? 'contents' : 'none';
								moreBtn.textContent = isTtsChipsExpanded ? 'Less' : `+${hiddenTokens.length} More...`;
							};
						}
					};

					renderTtsRefChips();
					referenceChipRefreshers.push(renderTtsRefChips);

					const statusTextEl = append(speechFooterLeft, $('span', {
						style: 'font-size: 10.5px; opacity: 0.78; color: #cbd5e1; margin-left: 4px;'
					}, field.ttsAudioDataUrl ? `Saved (${(field.ttsFormat || 'mp3').toUpperCase()})` : 'No audio generated yet.'));

					const speechFooterRight = append(speechActionFooter, $('div', {
						style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-left: auto;'
					}));

					const sendTtsBtn = append(speechFooterRight, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; background: rgba(236, 72, 153, 0.22); border: 1px solid rgba(236, 72, 153, 0.55); color: #f472b6; display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0;',
						title: 'Send Speech Synthesis Text to AI model API to generate MP3 audio (consumes model tokens)'
					})) as HTMLButtonElement;
					append(sendTtsBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.send), { style: 'font-size: 11px;' }));
					const sendTtsBtnLabel = append(sendTtsBtn, $('span', {}, 'Send & Generate Audio'));

					const deleteAudioBtn = append(speechFooterRight, $('button.monaco-button', {
						type: 'button',
						style: `padding: 4px 9px; font-size: 10.5px; border-radius: 5px; cursor: pointer; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171; display: ${field.ttsAudioDataUrl ? 'inline-flex' : 'none'}; align-items: center; gap: 4px; flex-shrink: 0;`,
						title: 'Delete / Clear saved audio file'
					})) as HTMLButtonElement;
					append(deleteAudioBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), { style: 'font-size: 11px;' }));
					append(deleteAudioBtn, $('span', {}, 'Delete Audio'));

					// =========================================================================
					// ZONE 2: Reading Content & Study Notes + Dedicated Audio Player Bar (Isolated Below)
					// =========================================================================
					const displayZoneBox = append(ttsSchemaBox, $('div', {
						style: 'display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 6px; background: rgba(56, 189, 248, 0.04); border: 1px solid rgba(56, 189, 248, 0.24); margin-top: 4px;'
					}));

					const displayHeaderRow = append(displayZoneBox, $('div', {
						style: 'display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;'
					}));
					const humanLabelWrap = append(displayHeaderRow, $('div', { style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;' }));
					append(humanLabelWrap, $('label', {
						style: 'font-size: 11px; font-weight: 600; opacity: 0.95; color: #38bdf8;'
					}, 'Reading Content & Study Notes:'));
					append(humanLabelWrap, $('span', {
						style: 'font-size: 9.5px; padding: 1px 6px; border-radius: 3px; background: rgba(56, 189, 248, 0.15); color: #7dd3fc; border: 1px solid rgba(56, 189, 248, 0.3); font-weight: 600;'
					}, 'Shown in Ticket · Notes & Annotations'));

					const displayHeaderActions = append(displayHeaderRow, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-left: auto;'
					}));

					const copyDisplayTextBtn = append(displayHeaderActions, $('button.monaco-button', {
						type: 'button',
						style: 'display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; font-size: 10px; border-radius: 4px; background: rgba(0, 122, 204, 0.16); border: 1px solid rgba(56, 189, 248, 0.35); color: #7dd3fc; cursor: pointer;',
						title: 'Copy all reading content to clipboard'
					})) as HTMLButtonElement;
					const copyDisplayIcon = append(copyDisplayTextBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy), { style: 'font-size: 11px;' }));
					const copyDisplayLabel = append(copyDisplayTextBtn, $('span', {}, 'Copy'));

					let isSchemaDisplayUnlocked = !field.ttsDisplayText;

					const editDisplayTextBtn = append(displayHeaderActions, $('button.monaco-button', {
						type: 'button',
						style: isSchemaDisplayUnlocked
							? 'display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; font-size: 10px; border-radius: 4px; background: rgba(0, 122, 204, 0.25); border: 1px solid rgba(56, 189, 248, 0.5); color: #7dd3fc; cursor: pointer;'
							: 'display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; font-size: 10px; border-radius: 4px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.18); color: inherit; cursor: pointer;',
						title: 'Click Edit to unlock and modify or clear reading content (auto-saves changes)'
					})) as HTMLButtonElement;
					const editDisplayIcon = append(editDisplayTextBtn, $('span' + ThemeIcon.asCSSSelector(isSchemaDisplayUnlocked ? Codicon.lock : Codicon.edit), { style: 'font-size: 11px;' }));
					const editDisplayLabel = append(editDisplayTextBtn, $('span', {}, isSchemaDisplayUnlocked ? 'Lock' : 'Edit'));

					const clearDisplayTextBtn = append(displayHeaderActions, $('button.monaco-button', {
						type: 'button',
						style: `display: ${isSchemaDisplayUnlocked ? 'inline-flex' : 'none'}; align-items: center; gap: 4px; padding: 2px 8px; font-size: 10px; border-radius: 4px; background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.35); color: #f87171; cursor: pointer;`,
						title: 'Clear reading content'
					})) as HTMLButtonElement;
					append(clearDisplayTextBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.clearAll), { style: 'font-size: 11px;' }));
					append(clearDisplayTextBtn, $('span', {}, 'Clear'));

					const ttsDisplayTextarea = append(displayZoneBox, $('textarea.monaco-inputbox', {
						rows: 3,
						placeholder: 'Reading passage with vocabulary notes and translations...',
						style: `width: 100%; padding: 8px 10px; font-size: 12px; line-height: 1.5; border-radius: 6px; border: 1px solid ${isSchemaDisplayUnlocked ? 'rgba(56, 189, 248, 0.7)' : 'rgba(56, 189, 248, 0.3)'}; background: ${isSchemaDisplayUnlocked ? 'rgba(0, 0, 0, 0.4)' : 'rgba(0, 0, 0, 0.25)'}; color: inherit; resize: vertical; box-sizing: border-box; font-family: inherit;`
					})) as HTMLTextAreaElement;
					ttsDisplayTextarea.value = field.ttsDisplayText || '';
					ttsDisplayTextarea.readOnly = !isSchemaDisplayUnlocked;
					ttsDisplayTextarea.onfocus = () => { lastFocusedTtsInput = 'display'; };

					copyDisplayTextBtn.onclick = async () => {
						await this._clipboardService.writeText(ttsDisplayTextarea.value || '');
						copyDisplayLabel.textContent = 'Copied!';
						copyDisplayIcon.className = ThemeIcon.asClassName(Codicon.check);
						copyDisplayTextBtn.style.color = '#4ade80';
						copyDisplayTextBtn.style.borderColor = 'rgba(74, 222, 128, 0.5)';
						setTimeout(() => {
							copyDisplayLabel.textContent = 'Copy';
							copyDisplayIcon.className = ThemeIcon.asClassName(Codicon.copy);
							copyDisplayTextBtn.style.color = '#7dd3fc';
							copyDisplayTextBtn.style.borderColor = 'rgba(56, 189, 248, 0.35)';
						}, 1500);
					};

					editDisplayTextBtn.onclick = async () => {
						isSchemaDisplayUnlocked = !isSchemaDisplayUnlocked;
						ttsDisplayTextarea.readOnly = !isSchemaDisplayUnlocked;
						if (isSchemaDisplayUnlocked) {
							ttsDisplayTextarea.style.borderColor = 'rgba(56, 189, 248, 0.7)';
							ttsDisplayTextarea.style.background = 'rgba(0, 0, 0, 0.4)';
							clearDisplayTextBtn.style.display = 'inline-flex';
							editDisplayIcon.className = ThemeIcon.asClassName(Codicon.lock);
							editDisplayLabel.textContent = 'Lock';
							editDisplayTextBtn.style.background = 'rgba(0, 122, 204, 0.25)';
							editDisplayTextBtn.style.borderColor = 'rgba(56, 189, 248, 0.5)';
							editDisplayTextBtn.style.color = '#7dd3fc';
							ttsDisplayTextarea.focus();
						} else {
							ttsDisplayTextarea.style.borderColor = 'rgba(56, 189, 248, 0.3)';
							ttsDisplayTextarea.style.background = 'rgba(0, 0, 0, 0.25)';
							clearDisplayTextBtn.style.display = 'none';
							editDisplayIcon.className = ThemeIcon.asClassName(Codicon.edit);
							editDisplayLabel.textContent = 'Edit';
							editDisplayTextBtn.style.background = 'rgba(255,255,255,0.06)';
							editDisplayTextBtn.style.borderColor = 'rgba(255,255,255,0.18)';
							editDisplayTextBtn.style.color = 'inherit';
							this._syncDraft();
							await this._persistCurrentModule();
						}
					};

					// Hidden native <audio> element driven by Blob URL (required by CSP media-src 'self' blob:)
					const audioPlayerEl = append(displayZoneBox, $('audio', {
						preload: 'metadata',
						style: 'display: none;'
					})) as HTMLAudioElement;

					// Dedicated Dark-Themed Audio Player Bar below Display Text (Canonical System Blue Theme)
					const customPlayerWrap = append(displayZoneBox, $('div', {
						style: `display: ${field.ttsAudioDataUrl ? 'flex' : 'none'}; align-items: center; gap: 10px; flex-wrap: wrap; width: 100%; box-sizing: border-box; padding: 6px 12px; border-radius: 20px; background: rgba(0, 0, 0, 0.45); border: 1px solid rgba(56, 189, 248, 0.35); box-shadow: inset 0 1px 3px rgba(0,0,0,0.5);`
					}));

					const playPauseBtn = append(customPlayerWrap, $('button', {
						type: 'button',
						style: 'width: 26px; height: 26px; border-radius: 50%; border: 1px solid rgba(56, 189, 248, 0.6); background: rgba(0, 122, 204, 0.28); color: #38bdf8; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; padding: 0; transition: all 0.15s ease;',
						title: 'Play / Pause Audio'
					})) as HTMLButtonElement;
					const playIconEl = append(playPauseBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.play), { style: 'font-size: 13px;' }));

					const timeLabelEl = append(customPlayerWrap, $('span', {
						style: 'font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); color: #7dd3fc; font-weight: 600; min-width: 74px; text-align: center; flex-shrink: 0; user-select: none;'
					}, '0:00 / 0:00'));

					const progressTrack = append(customPlayerWrap, $('div', {
						style: 'flex: 1; height: 6px; border-radius: 3px; background: rgba(255, 255, 255, 0.12); position: relative; cursor: pointer; overflow: hidden; min-width: 80px;',
						title: 'Click to seek audio position'
					}));
					const progressFill = append(progressTrack, $('div', {
						style: 'width: 0%; height: 100%; border-radius: 3px; background: linear-gradient(90deg, #007acc, #38bdf8); transition: width 0.08s linear;'
					}));

					// Playback Speed Selector (0.25x ~ 2.5x)
					let currentPlaybackRate = (typeof field.ttsPlaybackRate === 'number' && field.ttsPlaybackRate >= 0.25 && field.ttsPlaybackRate <= 2.5)
						? field.ttsPlaybackRate
						: 1.0;
					const speedSelect = append(customPlayerWrap, $('select', {
						style: 'background: rgba(0, 122, 204, 0.22); color: #7dd3fc; border: 1px solid rgba(56, 189, 248, 0.4); border-radius: 10px; padding: 2px 6px; font-size: 10.5px; font-weight: 600; font-family: var(--vscode-editor-font-family, monospace); cursor: pointer; outline: none; flex-shrink: 0;',
						title: 'Playback Speed (0.25x - 2.5x)'
					})) as HTMLSelectElement;
					const speedOptions = [0.25, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5];
					for (const spd of speedOptions) {
						const opt = append(speedSelect, $('option', {
							value: String(spd),
							style: 'background: #1e1e2e; color: #f8fafc;'
						}, `${spd}x`)) as HTMLOptionElement;
						if (Math.abs(spd - currentPlaybackRate) < 0.01) {
							opt.selected = true;
						}
					}
					speedSelect.onclick = (e) => e.stopPropagation();
					speedSelect.onmousedown = (e) => e.stopPropagation();
					speedSelect.onchange = (e) => {
						e.stopPropagation();
						const nextRate = parseFloat(speedSelect.value);
						currentPlaybackRate = Number.isFinite(nextRate) ? Math.min(2.5, Math.max(0.25, nextRate)) : 1.0;
						field.ttsPlaybackRate = currentPlaybackRate;
						audioPlayerEl.defaultPlaybackRate = currentPlaybackRate;
						audioPlayerEl.playbackRate = currentPlaybackRate;
						this._syncDraft();
					};

					const muteBtn = append(customPlayerWrap, $('button', {
						type: 'button',
						style: 'background: transparent; border: none; color: #cbd5e1; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; padding: 2px; opacity: 0.8; flex-shrink: 0;',
						title: 'Mute / Unmute'
					})) as HTMLButtonElement;
					const muteIconEl = append(muteBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.unmute), { style: 'font-size: 14px;' }));

					const downloadAudioBtn = append(customPlayerWrap, $('button', {
						type: 'button',
						style: 'background: rgba(0, 122, 204, 0.2); border: 1px solid rgba(56, 189, 248, 0.4); border-radius: 50%; width: 24px; height: 24px; color: #7dd3fc; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; padding: 0; opacity: 0.95; flex-shrink: 0; transition: all 0.15s ease;',
						title: 'Download Audio File'
					})) as HTMLButtonElement;
					append(downloadAudioBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowDown), { style: 'font-size: 13px;' }));

					let currentBlobUrl: string | undefined;
					let currentAudioBytes: Uint8Array | undefined;
					let currentAudioMime: string = 'audio/mpeg';
					let knownDurationSec = 0;

					const formatAudioTime = (sec: number): string => {
						if (!Number.isFinite(sec) || sec < 0) {
							return '0:00';
						}
						const totalSeconds = Math.round(sec);
						const mins = Math.floor(totalSeconds / 60);
						const secs = totalSeconds % 60;
						return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
					};

					const updateTimeUi = () => {
						const cur = Number.isFinite(audioPlayerEl.currentTime) ? audioPlayerEl.currentTime : 0;
						const rawDur = (Number.isFinite(audioPlayerEl.duration) && audioPlayerEl.duration > 0) ? audioPlayerEl.duration : knownDurationSec;
						const dur = rawDur > 0 ? rawDur : 0;
						timeLabelEl.textContent = `${formatAudioTime(cur)} / ${formatAudioTime(dur)}`;
						const pct = dur > 0 ? Math.min(100, Math.max(0, (cur / dur) * 100)) : 0;
						progressFill.style.width = `${pct}%`;
					};

					const loadAudioBytesIntoPlayer = async (bytes: Uint8Array, mimeType: string, autoPlayAfterLoad: boolean) => {
						if (currentBlobUrl) {
							URL.revokeObjectURL(currentBlobUrl);
							currentBlobUrl = undefined;
						}
						// Inspect RIFF WAV header in case Gemini returned WAV bytes
						let effectiveMime = mimeType || 'audio/mpeg';
						if (bytes.byteLength > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
							effectiveMime = 'audio/wav';
						}
						currentAudioBytes = bytes;
						currentAudioMime = effectiveMime;
						const blob = new Blob([bytes.slice(0)], { type: effectiveMime });
						currentBlobUrl = URL.createObjectURL(blob);
						audioPlayerEl.src = currentBlobUrl;
						audioPlayerEl.defaultPlaybackRate = currentPlaybackRate;
						audioPlayerEl.playbackRate = currentPlaybackRate;
						customPlayerWrap.style.display = 'flex';

						// Decode exact duration immediately via Web Audio API so duration is never 0:00
						try {
							const audioWindow: CodeWindow & { webkitAudioContext?: typeof AudioContext } = getWindow(audioPlayerEl);
							const AudioCtx = audioWindow.AudioContext || audioWindow.webkitAudioContext;
							if (AudioCtx) {
								const actx = new AudioCtx();
								// `bytes` is backed by a regular (non-shared) ArrayBuffer, so the slice is an ArrayBuffer too.
								const arrayBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
								const decoded = await actx.decodeAudioData(arrayBuf);
								if (decoded && Number.isFinite(decoded.duration) && decoded.duration > 0) {
									knownDurationSec = decoded.duration;
									updateTimeUi();
								}
								actx.close().catch(() => { });
							}
						} catch {
							// Fallback for WAV header byteRate calculation if decodeAudioData fails
							if (effectiveMime === 'audio/wav' && bytes.byteLength > 44) {
								const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
								const byteRate = view.getUint32(28, true);
								if (byteRate > 0) {
									knownDurationSec = (bytes.byteLength - 44) / byteRate;
									updateTimeUi();
								}
							}
						}

						if (autoPlayAfterLoad) {
							audioPlayerEl.play().catch(() => { });
						}
					};

					const loadDataUrlIntoPlayer = (dataUrl: string) => {
						try {
							const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
							if (!match) {
								return;
							}
							const mime = match[1] || 'audio/mpeg';
							const b64 = match[2];
							const binStr = atob(b64);
							const bytes = new Uint8Array(binStr.length);
							for (let i = 0; i < binStr.length; i++) {
								bytes[i] = binStr.charCodeAt(i);
							}
							loadAudioBytesIntoPlayer(bytes, mime, false);
						} catch (e) {
							console.error('Failed to decode saved TTS data URL:', e);
						}
					};

					playPauseBtn.onclick = () => {
						if (!audioPlayerEl.src) {
							return;
						}
						if (audioPlayerEl.paused) {
							audioPlayerEl.playbackRate = currentPlaybackRate;
							audioPlayerEl.play().catch(err => {
								this.notificationService.warn(`Audio playback error: ${err.message || err}`);
							});
						} else {
							audioPlayerEl.pause();
						}
					};

					audioPlayerEl.onplay = () => {
						audioPlayerEl.playbackRate = currentPlaybackRate;
						playIconEl.className = ThemeIcon.asClassName(Codicon.debugPause);
						playPauseBtn.style.background = 'rgba(0, 122, 204, 0.52)';
					};
					audioPlayerEl.onpause = () => {
						playIconEl.className = ThemeIcon.asClassName(Codicon.play);
						playPauseBtn.style.background = 'rgba(0, 122, 204, 0.28)';
					};
					audioPlayerEl.onended = () => {
						playIconEl.className = ThemeIcon.asClassName(Codicon.play);
						playPauseBtn.style.background = 'rgba(0, 122, 204, 0.28)';
						progressFill.style.width = '100%';
						updateTimeUi();
					};
					audioPlayerEl.onloadedmetadata = () => {
						audioPlayerEl.defaultPlaybackRate = currentPlaybackRate;
						audioPlayerEl.playbackRate = currentPlaybackRate;
						if (Number.isFinite(audioPlayerEl.duration) && audioPlayerEl.duration > 0) {
							knownDurationSec = audioPlayerEl.duration;
						}
						updateTimeUi();
					};
					audioPlayerEl.ondurationchange = () => {
						if (Number.isFinite(audioPlayerEl.duration) && audioPlayerEl.duration > 0) {
							knownDurationSec = audioPlayerEl.duration;
						}
						updateTimeUi();
					};
					audioPlayerEl.ontimeupdate = () => {
						updateTimeUi();
					};

					progressTrack.onclick = (e: MouseEvent) => {
						const dur = (Number.isFinite(audioPlayerEl.duration) && audioPlayerEl.duration > 0) ? audioPlayerEl.duration : knownDurationSec;
						if (dur <= 0) {
							return;
						}
						const rect = progressTrack.getBoundingClientRect();
						const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
						audioPlayerEl.currentTime = ratio * dur;
						updateTimeUi();
					};

					muteBtn.onclick = () => {
						audioPlayerEl.muted = !audioPlayerEl.muted;
						muteIconEl.className = ThemeIcon.asClassName(audioPlayerEl.muted ? Codicon.mute : Codicon.unmute);
						muteBtn.style.color = audioPlayerEl.muted ? '#f87171' : '#cbd5e1';
					};

					downloadAudioBtn.onclick = async () => {
						if (!currentAudioBytes || currentAudioBytes.byteLength === 0) {
							this.notificationService.warn('No audio available to download.');
							return;
						}
						const ext = currentAudioMime.includes('wav')
							? 'wav'
							: (currentAudioMime.includes('opus') ? 'opus' : (currentAudioMime.includes('aac') ? 'aac' : (field.ttsFormat || 'mp3').toLowerCase()));
						const safeFieldSlug = (field.label || field.id || 'tts_audio').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
						const defaultFileName = `tts_${safeFieldSlug}.${ext}`;
						try {
							const fileService = this._instantiationService.invokeFunction(accessor => accessor.get(IFileService));
							const pathService = this._instantiationService.invokeFunction(accessor => {
								try { return accessor.get(IPathService); } catch { return undefined; }
							});
							let defaultDirUri = this._workspaceUri;
							if (pathService) {
								try {
									const userHomeUri = await pathService.userHome();
									if (isWindows) {
										const winDownloadsUri = URI.joinPath(userHomeUri, 'Downloads');
										if (await fileService.exists(winDownloadsUri)) {
											defaultDirUri = winDownloadsUri;
										} else {
											defaultDirUri = userHomeUri;
										}
									} else {
										// macOS / Linux: default directly to the logged-in user's home directory (/Users/<username>)
										defaultDirUri = userHomeUri;
									}
								} catch {
									// Fallback to workspaceUri if userHome resolution fails
								}
							}
							const defaultUri = defaultDirUri
								? URI.joinPath(defaultDirUri, defaultFileName)
								: URI.file(defaultFileName);
							const saveUri = await this._fileDialogService.showSaveDialog({
								defaultUri,
								title: 'Download Audio File',
								filters: [{ name: `${ext.toUpperCase()} Audio`, extensions: [ext] }]
							});
							if (saveUri) {
								await fileService.writeFile(saveUri, VSBuffer.wrap(currentAudioBytes));
								this.notificationService.info(`Audio downloaded to ${saveUri.fsPath}`);
							}
						} catch {
							if (currentBlobUrl) {
								const a = document.createElement('a');
								a.href = currentBlobUrl;
								a.download = defaultFileName;
								a.ownerDocument.body.appendChild(a);
								a.click();
								a.ownerDocument.body.removeChild(a);
							}
						}
					};

					if (field.ttsAudioDataUrl) {
						loadDataUrlIntoPlayer(field.ttsAudioDataUrl);
					}

					const resetSchemaPlayerUi = (msg: string) => {
						field.ttsAudioDataUrl = undefined;
						currentAudioBytes = undefined;
						knownDurationSec = 0;
						audioPlayerEl.pause();
						audioPlayerEl.removeAttribute('src');
						if (currentBlobUrl) {
							URL.revokeObjectURL(currentBlobUrl);
							currentBlobUrl = undefined;
						}
						customPlayerWrap.style.display = 'none';
						deleteAudioBtn.style.display = 'none';
						progressFill.style.width = '0%';
						timeLabelEl.textContent = '0:00 / 0:00';
						statusTextEl.textContent = msg;
					};

					ttsTextarea.oninput = () => {
						field.defaultContent = ttsTextarea.value;
						if (!ttsTextarea.value.trim() && field.ttsAudioDataUrl) {
							resetSchemaPlayerUi('Text cleared - audio reset.');
						}
						this._syncDraft();
					};

					ttsDisplayTextarea.oninput = () => {
						if (ttsDisplayTextarea.readOnly) {
							return;
						}
						field.ttsDisplayText = ttsDisplayTextarea.value;
						this._syncDraft();
					};
					ttsDisplayTextarea.onblur = () => {
						if (!ttsDisplayTextarea.readOnly) {
							field.ttsDisplayText = ttsDisplayTextarea.value;
							this._syncDraft();
							this._persistCurrentModule().catch(() => { });
						}
					};

					clearDisplayTextBtn.onclick = async () => {
						if (ttsDisplayTextarea.readOnly) {
							return;
						}
						ttsDisplayTextarea.value = '';
						field.ttsDisplayText = '';
						this._syncDraft();
						await this._persistCurrentModule();
						ttsDisplayTextarea.focus();
					};

					clearTextBtn.onclick = async () => {
						ttsTextarea.value = '';
						field.defaultContent = '';
						resetSchemaPlayerUi('Text and audio cleared.');
						this._syncDraft();
						await this._persistCurrentModule();
					};

					deleteAudioBtn.onclick = async () => {
						resetSchemaPlayerUi('Audio file deleted.');
						this._syncDraft();
						await this._persistCurrentModule();
					};

					sendTtsBtn.onclick = async () => {
						const rawText = ttsTextarea.value.trim() || ttsDisplayTextarea.value.trim();
						if (!rawText) {
							this.notificationService.warn('Please enter or paste text in Speech Synthesis Text to convert to speech.');
							return;
						}
						sendTtsBtn.disabled = true;
						sendTtsBtnLabel.textContent = 'Synthesizing...';
						statusTextEl.textContent = `Sending to ${field.targetModel || 'TTS model'}...`;
						try {
							const credService = this._instantiationService.invokeFunction(accessor => {
								try { return accessor.get(IAgentCredentialService); } catch { return undefined; }
							});
							if (!credService) {
								throw new Error('Credential service unavailable.');
							}
							const res = await credService.synthesizeSpeech({
								text: rawText,
								modelId: field.targetModel,
								credentialId: field.targetCredentialId,
								providerId: field.targetProvider,
								format: field.ttsFormat || 'mp3',
								voice: field.ttsVoice
							});
							if (!res.success || !res.audioBuffer) {
								throw new Error(res.error || 'Failed to synthesize audio.');
							}
							let binary = '';
							const bytes = res.audioBuffer;
							const chunkSize = 8192;
							for (let i = 0; i < bytes.length; i += chunkSize) {
								binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
							}
							const base64Audio = btoa(binary);
							const dataUrl = `data:${res.mimeType || 'audio/mpeg'};base64,${base64Audio}`;
							field.ttsAudioDataUrl = dataUrl;
							await loadAudioBytesIntoPlayer(bytes, res.mimeType || 'audio/mpeg', true);
							deleteAudioBtn.style.display = 'inline-flex';
							statusTextEl.textContent = `Audio ready (${(field.ttsFormat || 'mp3').toUpperCase()})`;
							this._syncDraft();
							await this._persistCurrentModule();
						} catch (err) {
							statusTextEl.textContent = `Error: ${(err as Error).message || err}`;
							this.notificationService.error(`TTS Error: ${(err as Error).message || err}`);
						} finally {
							sendTtsBtn.disabled = false;
							sendTtsBtnLabel.textContent = 'Send & Generate Audio';
						}
					};
				}

				if (field.type === 'sub_workflow') {
					if (!field.subWorkflowInputs || typeof field.subWorkflowInputs !== 'object') {
						field.subWorkflowInputs = {};
					}
					const subBox = append(fieldCard, $('.primitive-config-box', {
						style: 'margin-top: 8px; padding: 10px 12px; background: rgba(6, 182, 212, 0.06); border: 1px solid rgba(34, 211, 238, 0.28); border-radius: 6px; display: flex; flex-direction: column; gap: 8px;'
					}));
					const subHeader = append(subBox, $('div', {
						style: 'display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap;'
					}));
					const subTitle = append(subHeader, $('div', {
						style: 'font-size: 11.5px; font-weight: 600; color: #22d3ee; display: inline-flex; align-items: center; gap: 6px;'
					}));
					append(subTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.layers)));
					append(subTitle, $('span', {}, `Sub-Workflow: ${field.subWorkflowName || field.subWorkflowId || '(unlinked)'}`));
					// Template designer (CI-38): pick the sub_workflow ticket on the card; outputs below stay read-only
					const isTemplateCard = !(this.input instanceof CustomModuleSchemaEditorInput && this.input.isFlowchartNodeMode);
					if (isTemplateCard && this._activeModule) {
						const activeModule = this._activeModule;
						this._instantiationService.invokeFunction(accessor => renderSubWorkflowPickerRow(subBox, field, {
							executionService: accessor.get(IWorkflowExecutionService),
							quickInputService: accessor.get(IQuickInputService),
							notificationService: this.notificationService,
							template: { id: activeModule.id, name: activeModule.name, fields: activeModule.fields || [], workspaceUri: this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined) },
							register: d => this._renderCleanupFns.push(() => d.dispose()),
							onDidChangeField: () => {
								this._syncDraft();
								renderCanvas();
								void this._persistCurrentModule();
							}
						}));
					}

					if (field.subWorkflowId) {
						// A Sub-Workflow is an independent workflow: open its own canvas to view / edit it
						const openSubBtn = append(subHeader, $('button', {
							type: 'button',
							title: `Open the canvas of Sub-Workflow ${field.subWorkflowId}`,
							'aria-label': `Open the canvas of Sub-Workflow ${field.subWorkflowId}`,
							style: 'display: inline-flex; align-items: center; padding: 2px 6px; border-radius: 4px; cursor: pointer; background: rgba(6, 182, 212, 0.16); border: 1px solid rgba(34, 211, 238, 0.42); color: #67e8f9; flex-shrink: 0;'
						})) as HTMLButtonElement;
						append(openSubBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.linkExternal)));
						const openSubListener = addDisposableListener(openSubBtn, 'click', (e: MouseEvent) => {
							e.stopPropagation();
							void this._commandService.executeCommand('workbench.action.workflowsManager.openSubWorkflow', field.subWorkflowId);
						});
						this._renderCleanupFns.push(() => openSubListener.dispose());
					}

					const refreshSubBtn = append(subHeader, $('button', {
						type: 'button',
						title: 'Refresh latest Inputs & Outputs from the Sub-Workflow ticket (clears previous execution output)',
						style: 'display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; font-size: 10.5px; font-weight: 600; border-radius: 4px; cursor: pointer; background: rgba(16, 185, 129, 0.16); border: 1px solid rgba(52, 211, 153, 0.42); color: #6ee7b7; flex-shrink: 0;'
					})) as HTMLButtonElement;
					append(refreshSubBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.refresh)));
					append(refreshSubBtn, $('span', {}, 'Refresh'));
					refreshSubBtn.onclick = async (e) => {
						e.stopPropagation();
						const subId = field.subWorkflowId;
						if (!subId) {
							this.notificationService.warn('This Sub-Workflow card is not linked to a Sub-Workflow ID.');
							return;
						}
						const refreshProvider = ((this.input instanceof CustomModuleSchemaEditorInput) ? this.input.subWorkflowRefreshProvider : undefined)
							?? (id => this._instantiationService.invokeFunction(accessor => resolveSubWorkflowContract(accessor.get(IWorkflowExecutionService), id)));
						if (!refreshProvider) {
							this.notificationService.warn('Open this node from its Workflow editor to refresh its Sub-Workflow definition.');
							return;
						}
						try {
							const fresh = await refreshProvider(subId);
							if (!fresh) {
								this.notificationService.warn('Original Sub-Workflow definition was not found. It may have been removed.');
								return;
							}
							field.subWorkflowName = fresh.name;
							field.subWorkflowInputDefs = fresh.inputs.map(i => ({ name: i.name, defaultValue: i.defaultValue, description: i.description }));
							field.subWorkflowOutputDefs = fresh.outputs.map(o => ({ label: o.label, varName: o.varName, defaultFormat: o.defaultFormat }));
							const prevInputs = (field.subWorkflowInputs && typeof field.subWorkflowInputs === 'object') ? field.subWorkflowInputs : {};
							const nextInputs: Record<string, string> = {};
							for (const inp of fresh.inputs) {
								nextInputs[inp.name] = Object.prototype.hasOwnProperty.call(prevInputs, inp.name) ? prevInputs[inp.name] : (inp.defaultValue ?? '');
							}
							field.subWorkflowInputs = nextInputs;
							// Clear stale execution output/logs after refreshing schema
							delete (field as IRuntimeCustomField).lastExecutionInputs;
							delete (field as IRuntimeCustomField).lastExecutionOutput;
							delete (field as IRuntimeCustomField).lastExecutionLog;
							delete (field as IRuntimeCustomField).lastExecutionStatus;
							delete (field as IRuntimeCustomField).lastExecutionDurationMs;
							delete (field as IRuntimeCustomField).lastExecutedAt;
							this._syncDraft();
							renderCanvas();
							this.notificationService.info(`Refreshed Sub-Workflow '${fresh.name}' (${fresh.inputs.length} in · ${fresh.outputs.length} out).`);
						} catch (err) {
							this.notificationService.error(`Failed to refresh Sub-Workflow: ${(err as Error | undefined)?.message || err}`);
						}
					};

					const inputDefs = Array.isArray(field.subWorkflowInputDefs) ? field.subWorkflowInputDefs : [];
					if (inputDefs.length > 0) {
						append(subBox, $('div', { style: 'font-size: 10.5px; font-weight: 600; color: #c084fc; margin-top: 2px;' }, `Input Bindings (${inputDefs.length})`));
						for (const inp of inputDefs) {
							const row = append(subBox, $('div', {
								style: 'display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; width: 100%; min-width: 0;'
							}));
							append(row, $('span', {
								style: 'font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); color: #e9d5ff; flex-shrink: 0;'
							}, `${inp.name}:`));
							const inpEl = append(row, $('input.monaco-inputbox', {
								type: 'text',
								placeholder: inp.defaultValue ? `Default: ${inp.defaultValue}` : `Bind {var} or value`,
								value: field.subWorkflowInputs[inp.name] ?? '',
								style: 'flex: 1 1 120px; min-width: 0; width: 100%; padding: 3px 8px; font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); border-radius: 4px; border: 1px solid rgba(255,255,255,0.16); background: rgba(0,0,0,0.3); color: var(--vscode-input-foreground); outline: none;'
							})) as HTMLInputElement;
							inpEl.oninput = () => {
								field.subWorkflowInputs![inp.name] = inpEl.value;
								this._syncDraft();
							};
						}
					} else {
						append(subBox, $('div', { style: 'font-size: 10.5px; opacity: 0.6; font-style: italic;' }, 'No input parameters defined on this Sub-Workflow.'));
					}

					const outputDefs = Array.isArray(field.subWorkflowOutputDefs) ? field.subWorkflowOutputDefs : [];
					if (outputDefs.length > 0) {
						append(subBox, $('div', { style: 'font-size: 10.5px; font-weight: 600; color: #34d399; margin-top: 2px;' }, `Exposed Outputs (${outputDefs.length})`));
						const outList = append(subBox, $('div', { style: 'display: flex; flex-wrap: wrap; gap: 4px;' }));
						for (const out of outputDefs) {
							append(outList, $('span', {
								style: 'font-size: 10px; padding: 2px 6px; border-radius: 4px; background: rgba(16, 185, 129, 0.14); border: 1px solid rgba(52, 211, 153, 0.32); color: #d1fae5;',
								title: `Index: ${out.label} · Var: ${out.varName} · Format: ${(out.defaultFormat || 'json').toUpperCase()}`
							}, `${out.label} [${(out.defaultFormat || 'json').toUpperCase()}]`));
						}
					}

					// Last Execution Inputs Box
					let lastInObj: Record<string, unknown> | undefined = (field as IRuntimeCustomField).lastExecutionInputs;
					if (lastInObj === undefined && typeof (field as IRuntimeCustomField).lastExecutionLog === 'string') {
						const logStr = String((field as IRuntimeCustomField).lastExecutionLog);
						const inputsMatch = logStr.match(/(?:^|\n)Inputs:\s*(\{[\s\S]*?\})(?:\nOutputs:|$)/);
						if (inputsMatch && inputsMatch[1]) {
							try {
								lastInObj = JSON.parse(inputsMatch[1]);
							} catch { }
						}
					}
					const hasLastIn = lastInObj !== undefined && lastInObj !== null && typeof lastInObj === 'object';
					const lastInCount = hasLastIn ? Object.keys(lastInObj!).length : 0;
					const lastInCard = append(subBox, $('div.component-exec-logs-card', {
						style: 'display: flex; flex-direction: column; gap: 4px; margin-top: 4px; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(192, 132, 252, 0.28); border-radius: 5px; padding: 6px 8px;'
					}));
					const lastInHeader = append(lastInCard, $('div', {
						style: 'display: flex; justify-content: space-between; align-items: center; font-size: 10.5px; gap: 6px; flex-wrap: wrap;'
					}));
					const lastInTitle = append(lastInHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 5px; font-weight: 600; color: #c084fc;'
					}));
					append(lastInTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolParameter)));
					append(lastInTitle, $('span', {}, hasLastIn ? `LAST EXECUTION INPUTS (${lastInCount})` : 'LAST EXECUTION INPUTS'));
					const lastInText = hasLastIn
						? (lastInCount === 0 ? '(no inputs)' : JSON.stringify(lastInObj, null, 2))
						: '[Ready to execute] Resolved Sub-Workflow inputs will appear here after execution.';
					if (hasLastIn) {
						const copyInBtn = append(lastInHeader, $('button', {
							type: 'button',
							style: 'padding: 1px 7px; font-size: 10px; border-radius: 3px; cursor: pointer; background: rgba(192, 132, 252, 0.14); border: 1px solid rgba(192, 132, 252, 0.35); color: #f3e8ff;'
						}, 'Copy')) as HTMLButtonElement;
						copyInBtn.onclick = async () => {
							await this._clipboardService.writeText(lastInText);
							copyInBtn.textContent = 'Copied';
							setTimeout(() => { copyInBtn.textContent = 'Copy'; }, 1200);
						};
					}
					append(lastInCard, $('pre', {
						style: 'margin: 0; font-size: 11px; line-height: 1.45; max-height: 180px; overflow: auto; white-space: pre-wrap; word-break: break-word; color: #e2e8f0; font-family: var(--vscode-editor-font-family, monospace);'
					}, lastInText.length > 8000 ? lastInText.substring(0, 8000) + '\n... (use Copy for full inputs)' : lastInText));

					// Last Execution Output Box
					const lastOutVal = (field as IRuntimeCustomField).lastExecutionOutput;
					const lastExecCard = append(subBox, $('div.component-exec-logs-card', {
						style: 'display: flex; flex-direction: column; gap: 4px; margin-top: 4px; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(34, 211, 238, 0.25); border-radius: 5px; padding: 6px 8px;'
					}));
					const lastExecHeader = append(lastExecCard, $('div', {
						style: 'display: flex; justify-content: space-between; align-items: center; font-size: 10.5px; gap: 6px; flex-wrap: wrap;'
					}));
					const lastExecTitle = append(lastExecHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 5px; font-weight: 600; color: #22d3ee;'
					}));
					append(lastExecTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.terminal)));
					append(lastExecTitle, $('span', {}, 'LAST EXECUTION OUTPUT'));
					const lastExecText = lastOutVal !== undefined
						? (lastOutVal === null ? 'None' : (typeof lastOutVal === 'string' ? lastOutVal : JSON.stringify(lastOutVal, null, 2)))
						: ((field as IRuntimeCustomField).lastExecutionLog || '[Ready to execute] Sub-Workflow output will appear here after execution.');
					if (lastOutVal !== undefined) {
						const copyOutBtn = append(lastExecHeader, $('button', {
							type: 'button',
							style: 'padding: 1px 7px; font-size: 10px; border-radius: 3px; cursor: pointer; background: rgba(34, 211, 238, 0.14); border: 1px solid rgba(34, 211, 238, 0.35); color: #cffafe;'
						}, 'Copy')) as HTMLButtonElement;
						copyOutBtn.onclick = async () => {
							await this._clipboardService.writeText(lastExecText);
							copyOutBtn.textContent = 'Copied';
							setTimeout(() => { copyOutBtn.textContent = 'Copy'; }, 1200);
						};
					}
					append(lastExecCard, $('pre', {
						style: 'margin: 0; font-size: 11px; line-height: 1.45; max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-word; color: #e2e8f0; font-family: var(--vscode-editor-font-family, monospace);'
					}, lastExecText.length > 8000 ? lastExecText.substring(0, 8000) + '\n... (use Copy for full output)' : lastExecText));
				}

				if (field.type === 'voice_note') {
					if (!Array.isArray(field.voiceClips)) {
						field.voiceClips = [];
					}
					if (field.voiceAutoTranscribe === undefined) {
						field.voiceAutoTranscribe = true;
					}
					if (typeof field.voicePlaybackRate !== 'number' || !Number.isFinite(field.voicePlaybackRate)) {
						field.voicePlaybackRate = 1.0;
					}

					const syncCombinedVoiceTranscript = () => {
						const clips = Array.isArray(field.voiceClips) ? field.voiceClips : [];
						field.voiceTranscript = clips
							.map(c => (c.transcript || '').trim())
							.filter(Boolean)
							.join('\n\n');
					};

					const formatVoiceDuration = (sec?: number): string => {
						const safe = typeof sec === 'number' && Number.isFinite(sec) && sec >= 0 ? Math.floor(sec) : 0;
						const m = Math.floor(safe / 60);
						const s = safe % 60;
						return `${m}:${s < 10 ? '0' : ''}${s}`;
					};

					const dataUrlToBlob = (dataUrl: string): Blob => {
						const parts = dataUrl.split(',');
						const mimeMatch = parts[0].match(/:(.*?);/);
						const mime = mimeMatch ? mimeMatch[1] : 'audio/webm';
						const bstr = atob(parts[1] || '');
						let n = bstr.length;
						const u8arr = new Uint8Array(n);
						while (n--) {
							u8arr[n] = bstr.charCodeAt(n);
						}
						return new Blob([u8arr], { type: mime });
					};

					const blobToDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
						const reader = new FileReader();
						reader.onloadend = () => resolve(String(reader.result || ''));
						reader.onerror = () => reject(reader.error || new Error('Failed to read audio blob'));
						reader.readAsDataURL(blob);
					});

					const voiceBox = append(fieldCard, $('.voice-note-schema-config', {
						style: 'display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; background: rgba(148, 163, 184, 0.04); border: 1px solid rgba(148, 163, 184, 0.22); border-radius: 6px; margin-top: 4px;'
					}));

					// Header notice
					const voiceNotice = append(voiceBox, $('div', {
						style: 'font-size: 11px; color: rgba(203, 213, 225, 0.78); display: flex; align-items: center; gap: 6px; font-weight: 500;'
					}));
					append(voiceNotice, $('span' + ThemeIcon.asCSSSelector(Codicon.mic)));
					append(voiceNotice, $('span', {}, 'Voice Note (Commentary Only): Record one or more voice memos with automatic Speech-to-Text transcription. Skipped during workflow execution; displays a top-right speaker icon on the node to play all clips sequentially.'));

					// Top Control Bar
					const controlBar = append(voiceBox, $('div', {
						style: 'display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 8px 10px; border-radius: 6px; background: rgba(0, 0, 0, 0.24); border: 1px solid rgba(148, 163, 184, 0.18);'
					}));

					const leftControls = append(controlBar, $('div', {
						style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;'
					}));

					const recordBtn = append(leftControls, $('button.monaco-button', {
						type: 'button',
						style: 'display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; font-size: 11.5px; font-weight: 600; border-radius: 5px; cursor: pointer; background: rgba(148, 163, 184, 0.16); border: 1px solid rgba(148, 163, 184, 0.36); color: var(--vscode-foreground, #e2e8f0); transition: all 120ms ease;',
						title: 'Click to record a new voice clip (Speech-to-Text)'
					})) as HTMLButtonElement;
					const recordBtnIcon = append(recordBtn, $('span.codicon.codicon-mic', { style: 'font-size: 13px;' }));
					const recordBtnLabel = append(recordBtn, $('span', {}, 'Record Voice'));

					const recordingIndicator = append(leftControls, $('div', {
						style: 'display: none; align-items: center; gap: 6px; font-size: 11px; color: #ff3b30; font-weight: 600; background: rgba(15, 23, 42, 0.92); border: 1px solid rgba(255, 59, 48, 0.4); padding: 3px 9px; border-radius: 12px; user-select: none;'
					}));
					append(recordingIndicator, $('span', {
						style: 'width: 8px; height: 8px; border-radius: 50%; background-color: #ff3b30; display: inline-block;'
					}));
					const recordingStatusSpan = append(recordingIndicator, $('span', {}, '0:00 / 5:00'));

					const playAllBtn = append(leftControls, $('button.monaco-button', {
						type: 'button',
						style: 'display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; background: rgba(56, 189, 248, 0.14); border: 1px solid rgba(56, 189, 248, 0.4); color: #7dd3fc;',
						title: 'Play all recorded voice clips sequentially'
					})) as HTMLButtonElement;
					const playAllIcon = append(playAllBtn, $('span.codicon.codicon-unmute', { style: 'font-size: 12.5px;' }));
					const playAllLabel = append(playAllBtn, $('span', {}, 'Play All'));

					const rightControls = append(controlBar, $('div', {
						style: 'display: flex; align-items: center; gap: 10px; flex-wrap: wrap;'
					}));

					// Speed selector
					const speedWrap = append(rightControls, $('label', {
						style: 'display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: rgba(255,255,255,0.72);'
					}));
					append(speedWrap, $('span', {}, 'Speed:'));
					const speedSelect = append(speedWrap, $('select', {
						style: 'font-size: 11px; padding: 2px 6px; border-radius: 4px; background: rgba(0,0,0,0.4); color: inherit; border: 1px solid rgba(255,255,255,0.18); cursor: pointer;'
					})) as HTMLSelectElement;
					for (const spd of [0.75, 1.0, 1.25, 1.5, 2.0]) {
						const opt = append(speedSelect, $('option', { value: String(spd) }, `${spd}x`)) as HTMLOptionElement;
						if (Math.abs((field.voicePlaybackRate || 1.0) - spd) < 0.01) {
							opt.selected = true;
						}
					}

					// Auto-transcribe checkbox
					const autoTranscribeWrap = append(rightControls, $('label', {
						style: 'display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: rgba(255,255,255,0.78); cursor: pointer; user-select: none;'
					}));
					const autoTranscribeCb = append(autoTranscribeWrap, $('input', { type: 'checkbox' })) as HTMLInputElement;
					autoTranscribeCb.checked = field.voiceAutoTranscribe !== false;
					append(autoTranscribeWrap, $('span', {}, 'Auto-Transcribe'));
					autoTranscribeCb.onchange = () => {
						field.voiceAutoTranscribe = autoTranscribeCb.checked;
						this._syncDraft();
					};

					// Show & Play in Flow checkbox (default unchecked: commentary-only, hidden from node capsules & skipped on run)
					const runInFlowWrap = append(rightControls, $('label', {
						style: 'display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: rgba(255,255,255,0.78); cursor: pointer; user-select: none;',
						title: 'When unchecked (default), this Voice Note is hidden from node capsules (accessible via top-right speaker & side panel) and skipped during workflow execution. Check to display as a capsule and play audio during execution.'
					}));
					const runInFlowCb = append(runInFlowWrap, $('input', { type: 'checkbox' })) as HTMLInputElement;
					runInFlowCb.checked = Boolean(field.voiceRunInFlow);
					append(runInFlowWrap, $('span', {}, 'Show & Play in Flow'));
					runInFlowCb.onchange = () => {
						field.voiceRunInFlow = runInFlowCb.checked;
						this._syncDraft();
						void this._persistCurrentModule();
					};

					// Clips list container
					const clipsListContainer = append(voiceBox, $('.voice-note-clips-list', {
						style: 'display: flex; flex-direction: column; gap: 8px;'
					}));

					// Local playback & recording state
					let isRecordingVoice = false;
					let isTranscribingVoice = false;
					let mediaRecorder: MediaRecorder | null = null;
					let activeStream: MediaStream | undefined = undefined;
					let audioChunks: BlobPart[] = [];
					let recordingTimer: number | undefined = undefined;
					let recordingSeconds = 0;

					let activeAudio: HTMLAudioElement | undefined = undefined;
					let activeAudioBlobUrl: string | undefined = undefined;
					let activePlayingClipId: string | undefined = undefined;
					let isPlayingAllSequence = false;

					const revokeActiveBlobUrl = () => {
						if (activeAudioBlobUrl) {
							try {
								URL.revokeObjectURL(activeAudioBlobUrl);
							} catch { }
							activeAudioBlobUrl = undefined;
						}
					};

					const stopAllAudio = () => {
						isPlayingAllSequence = false;
						activePlayingClipId = undefined;
						if (activeAudio) {
							try {
								activeAudio.onended = null;
								activeAudio.onerror = null;
								activeAudio.pause();
								activeAudio.currentTime = 0;
							} catch { }
							activeAudio = undefined;
						}
						revokeActiveBlobUrl();
						playAllIcon.className = 'codicon codicon-unmute';
						playAllLabel.textContent = 'Play All';
						updateClipRowVisualStates();
					};

					const updatePlayAllBtnState = () => {
						const clips = Array.isArray(field.voiceClips) ? field.voiceClips.filter(c => !!c.audioDataUrl) : [];
						playAllBtn.disabled = clips.length === 0;
						playAllBtn.style.opacity = clips.length === 0 ? '0.4' : '1';
						playAllBtn.style.cursor = clips.length === 0 ? 'not-allowed' : 'pointer';
						if (!isPlayingAllSequence) {
							playAllIcon.className = 'codicon codicon-unmute';
							playAllLabel.textContent = clips.length > 0 ? `Play All (${clips.length})` : 'Play All';
						}
					};

					const clipRowRefs = new Map<string, {
						playIcon: HTMLElement;
						playBtn: HTMLButtonElement;
						progressFill: HTMLElement;
						timeLabel: HTMLElement;
						cardEl: HTMLElement;
					}>();

					const updateClipRowVisualStates = () => {
						for (const [cid, refs] of clipRowRefs.entries()) {
							const isCurrent = activePlayingClipId === cid && activeAudio && !activeAudio.paused;
							refs.playIcon.className = isCurrent ? 'codicon codicon-debug-pause' : 'codicon codicon-play';
							refs.cardEl.style.borderColor = isCurrent ? 'rgba(203, 213, 225, 0.55)' : 'rgba(255, 255, 255, 0.1)';
							refs.cardEl.style.background = isCurrent ? 'rgba(148, 163, 184, 0.12)' : 'rgba(0, 0, 0, 0.24)';
							if (activePlayingClipId !== cid) {
								refs.progressFill.style.width = '0%';
							}
						}
					};

					speedSelect.onchange = () => {
						const val = parseFloat(speedSelect.value);
						field.voicePlaybackRate = Number.isFinite(val) ? val : 1.0;
						if (activeAudio) {
							activeAudio.playbackRate = field.voicePlaybackRate;
						}
						this._syncDraft();
					};

					const playSingleClip = (clip: IVoiceNoteClip, onSequenceEnded?: () => void) => {
						if (!clip.audioDataUrl) {
							onSequenceEnded?.();
							return;
						}
						if (activePlayingClipId === clip.id && activeAudio && !onSequenceEnded) {
							if (activeAudio.paused) {
								activeAudio.playbackRate = field.voicePlaybackRate || 1.0;
								void activeAudio.play();
							} else {
								activeAudio.pause();
							}
							updateClipRowVisualStates();
							return;
						}

						if (activeAudio) {
							try {
								activeAudio.onended = null;
								activeAudio.onerror = null;
								activeAudio.pause();
							} catch { }
						}
						revokeActiveBlobUrl();
						let audioSrc = clip.audioDataUrl;
						if (audioSrc.startsWith('data:')) {
							try {
								const blob = dataUrlToBlob(audioSrc);
								audioSrc = URL.createObjectURL(blob);
								activeAudioBlobUrl = audioSrc;
							} catch { }
						}
						const audio = new Audio(audioSrc);
						audio.playbackRate = field.voicePlaybackRate || 1.0;
						activeAudio = audio;
						activePlayingClipId = clip.id;

						audio.ontimeupdate = () => {
							const refs = clipRowRefs.get(clip.id);
							if (refs) {
								const total = Number.isFinite(audio.duration) && audio.duration > 0
									? audio.duration
									: (clip.durationSeconds || 0);
								const pct = total > 0 ? Math.min(100, (audio.currentTime / total) * 100) : 0;
								refs.progressFill.style.width = `${pct}%`;
								refs.timeLabel.textContent = `${formatVoiceDuration(audio.currentTime)} / ${formatVoiceDuration(total)}`;
							}
						};

						audio.onended = () => {
							const refs = clipRowRefs.get(clip.id);
							if (refs) {
								refs.progressFill.style.width = '0%';
								refs.timeLabel.textContent = formatVoiceDuration(clip.durationSeconds);
							}
							if (onSequenceEnded) {
								onSequenceEnded();
							} else {
								activePlayingClipId = undefined;
								activeAudio = undefined;
								updateClipRowVisualStates();
							}
						};

						audio.onerror = () => {
							this.notificationService.error('Failed to play recorded audio clip.');
							if (onSequenceEnded) {
								onSequenceEnded();
							} else {
								stopAllAudio();
							}
						};

						void audio.play().catch(err => {
							this.notificationService.error(`Audio playback error: ${err?.message || err}`);
							stopAllAudio();
						});
						updateClipRowVisualStates();
					};

					playAllBtn.onclick = () => {
						if (isPlayingAllSequence) {
							stopAllAudio();
							return;
						}
						const clips = (field.voiceClips || []).filter(c => !!c.audioDataUrl);
						if (clips.length === 0) {
							return;
						}
						isPlayingAllSequence = true;
						playAllIcon.className = 'codicon codicon-debug-pause';
						let idx = 0;
						const playNext = () => {
							if (!isPlayingAllSequence || idx >= clips.length) {
								stopAllAudio();
								updatePlayAllBtnState();
								return;
							}
							const currentClip = clips[idx];
							playAllLabel.textContent = `Stop (${idx + 1}/${clips.length})`;
							idx++;
							playSingleClip(currentClip, playNext);
						};
						playNext();
					};

					const renderClipsList = () => {
						clearNode(clipsListContainer);
						clipRowRefs.clear();
						const clips = Array.isArray(field.voiceClips) ? field.voiceClips : [];
						updatePlayAllBtnState();

						if (clips.length === 0) {
							const emptyHint = append(clipsListContainer, $('div', {
								style: 'padding: 14px 12px; text-align: center; font-size: 11.5px; color: rgba(255,255,255,0.48); border: 1px dashed rgba(148, 163, 184, 0.25); border-radius: 6px; background: rgba(0,0,0,0.16);'
							}, 'No voice recordings yet. Click "Record Voice" above to record an audio note & auto-transcribe it.'));
							void emptyHint;
							return;
						}

						clips.forEach((clip, clipIdx) => {
							const clipCard = append(clipsListContainer, $('.voice-note-clip-card', {
								style: 'display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 6px; background: rgba(0, 0, 0, 0.24); border: 1px solid rgba(255, 255, 255, 0.1); transition: all 120ms ease;'
							}));

							const clipHeader = append(clipCard, $('div', {
								style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;'
							}));

							const clipPlayBtn = append(clipHeader, $('button', {
								type: 'button',
								style: 'display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; cursor: pointer; background: rgba(148, 163, 184, 0.18); border: 1px solid rgba(148, 163, 184, 0.42); color: var(--vscode-foreground, #e2e8f0); padding: 0; flex-shrink: 0;',
								title: 'Play / Pause this clip'
							})) as HTMLButtonElement;
							const clipPlayIcon = append(clipPlayBtn, $('span.codicon.codicon-play', { style: 'font-size: 12px;' }));

							append(clipHeader, $('span', {
								style: 'font-size: 10.5px; font-weight: 700; color: #cbd5e1; background: rgba(148, 163, 184, 0.16); padding: 1px 6px; border-radius: 4px; flex-shrink: 0;'
							}, `#${clipIdx + 1}`));

							const progressTrack = append(clipHeader, $('div', {
								style: 'flex: 1; min-width: 80px; height: 6px; border-radius: 3px; background: rgba(255,255,255,0.12); overflow: hidden; cursor: pointer; position: relative;'
							}));
							const progressFill = append(progressTrack, $('div', {
								style: 'width: 0%; height: 100%; background: #94a3b8; transition: width 80ms linear;'
							}));

							progressTrack.onclick = (e: MouseEvent) => {
								if (activePlayingClipId === clip.id && activeAudio && Number.isFinite(activeAudio.duration) && activeAudio.duration > 0) {
									const rect = progressTrack.getBoundingClientRect();
									const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
									activeAudio.currentTime = ratio * activeAudio.duration;
								} else {
									playSingleClip(clip);
								}
							};

							const timeLabel = append(clipHeader, $('span', {
								style: 'font-size: 10.5px; font-family: var(--vscode-editor-font-family, monospace); color: rgba(255,255,255,0.65); flex-shrink: 0;'
							}, formatVoiceDuration(clip.durationSeconds)));

							const reTranscribeBtn = append(clipHeader, $('button', {
								type: 'button',
								style: 'display: inline-flex; align-items: center; gap: 3px; padding: 2px 7px; font-size: 10.5px; border-radius: 4px; cursor: pointer; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.32); color: #7dd3fc;',
								title: 'Transcribe / Re-transcribe this audio clip using Voice Model'
							})) as HTMLButtonElement;
							append(reTranscribeBtn, $('span.codicon.codicon-sparkle', { style: 'font-size: 11px;' }));
							const reTranscribeLabel = append(reTranscribeBtn, $('span', {}, 'Transcribe'));

							const deleteClipBtn = append(clipHeader, $('button', {
								type: 'button',
								style: 'display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 4px; cursor: pointer; background: transparent; border: 1px solid transparent; color: rgba(248, 113, 113, 0.8); padding: 0;',
								title: 'Delete this voice clip'
							})) as HTMLButtonElement;
							append(deleteClipBtn, $('span.codicon.codicon-trash', { style: 'font-size: 12px;' }));

							const transcriptArea = append(clipCard, $('textarea.monaco-inputbox', {
								rows: '2',
								placeholder: 'Transcribed text will appear here (you can also edit or organize notes directly)...',
								style: 'width: 100%; box-sizing: border-box; padding: 6px 8px; font-size: 11.5px; line-height: 1.45; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.28); color: var(--vscode-input-foreground); resize: vertical; font-family: inherit;'
							})) as HTMLTextAreaElement;
							transcriptArea.value = clip.transcript || '';
							transcriptArea.oninput = () => {
								clip.transcript = transcriptArea.value;
								syncCombinedVoiceTranscript();
								this._syncDraft();
							};

							clipPlayBtn.onclick = () => {
								isPlayingAllSequence = false;
								playAllIcon.className = 'codicon codicon-unmute';
								updatePlayAllBtnState();
								playSingleClip(clip);
							};

							reTranscribeBtn.onclick = async () => {
								if (!clip.audioDataUrl) {
									return;
								}
								reTranscribeBtn.disabled = true;
								reTranscribeLabel.textContent = 'Transcribing...';
								try {
									const blob = dataUrlToBlob(clip.audioDataUrl);
									const voiceModelService = this._instantiationService.invokeFunction(accessor => accessor.get(IVoiceModelService));
									const res = await voiceModelService.transcribeAudio(blob);
									if (res.text && res.text.trim()) {
										clip.transcript = res.text.trim();
										transcriptArea.value = clip.transcript;
										syncCombinedVoiceTranscript();
										this._syncDraft();
										void this._persistCurrentModule();
									} else if (res.error) {
										this.notificationService.warn(`Voice Transcription: ${res.error}`);
									}
								} catch (err) {
									this.notificationService.error(`Voice Transcription Error: ${(err as Error | undefined)?.message || err}`);
								} finally {
									reTranscribeBtn.disabled = false;
									reTranscribeLabel.textContent = 'Transcribe';
								}
							};

							deleteClipBtn.onclick = () => {
								if (activePlayingClipId === clip.id) {
									stopAllAudio();
								}
								const idxToDel = field.voiceClips!.findIndex(c => c.id === clip.id);
								if (idxToDel !== -1) {
									field.voiceClips!.splice(idxToDel, 1);
									syncCombinedVoiceTranscript();
									this._syncDraft();
									void this._persistCurrentModule();
									renderClipsList();
								}
							};

							clipRowRefs.set(clip.id, {
								playIcon: clipPlayIcon,
								playBtn: clipPlayBtn,
								progressFill,
								timeLabel,
								cardEl: clipCard
							});
						});

						updateClipRowVisualStates();
					};

					const stopVoiceRecording = () => {
						if (recordingTimer) {
							getWindow(voiceBox).clearInterval(recordingTimer);
							recordingTimer = undefined;
						}
						if (mediaRecorder && isRecordingVoice) {
							try {
								mediaRecorder.stop();
							} catch { }
							isRecordingVoice = false;
						} else {
							isRecordingVoice = false;
							if (!isTranscribingVoice) {
								recordingIndicator.style.display = 'none';
							}
						}
						recordBtnIcon.className = 'codicon codicon-mic';
						recordBtnLabel.textContent = 'Record Voice';
						recordBtn.style.background = 'rgba(148, 163, 184, 0.16)';
						recordBtn.style.borderColor = 'rgba(148, 163, 184, 0.36)';
						recordBtn.style.color = 'var(--vscode-foreground, #e2e8f0)';
					};

					const startVoiceRecording = async () => {
						if (isTranscribingVoice) {
							return;
						}
						stopAllAudio();
						try {
							const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
							activeStream = stream;
							audioChunks = [];
							mediaRecorder = new (getWindow(voiceBox).MediaRecorder)(stream);

							mediaRecorder.ondataavailable = (e: BlobEvent) => {
								if (e.data && e.data.size > 0) {
									audioChunks.push(e.data);
								}
							};

							mediaRecorder.onstop = async () => {
								const recordedSecs = Math.max(1, recordingSeconds);
								stream.getTracks().forEach(track => track.stop());
								activeStream = undefined;

								const actualMime = (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm';
								const audioBlob = new Blob(audioChunks, { type: actualMime });
								let audioDataUrl = '';
								try {
									audioDataUrl = await blobToDataUrl(audioBlob);
								} catch (err) {
									this.notificationService.error(`Failed to save recorded audio: ${(err as Error | undefined)?.message || err}`);
									recordingIndicator.style.display = 'none';
									return;
								}

								const newClip: IVoiceNoteClip = {
									id: `vclip_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
									audioDataUrl,
									mimeType: actualMime,
									durationSeconds: recordedSecs,
									transcript: '',
									createdAt: Date.now()
								};
								field.voiceClips!.push(newClip);
								syncCombinedVoiceTranscript();
								this._syncDraft();
								void this._persistCurrentModule();
								renderClipsList();

								if (field.voiceAutoTranscribe !== false) {
									isTranscribingVoice = true;
									recordingIndicator.style.display = 'inline-flex';
									recordingStatusSpan.textContent = 'Transcribing voice...';
									try {
										const voiceModelService = this._instantiationService.invokeFunction(accessor => accessor.get(IVoiceModelService));
										const result = await voiceModelService.transcribeAudio(audioBlob);
										if (result.text && result.text.trim()) {
											newClip.transcript = result.text.trim();
											syncCombinedVoiceTranscript();
											this._syncDraft();
											void this._persistCurrentModule();
											renderClipsList();
										} else if (result.error) {
											this.notificationService.warn(`Audio saved, but Voice Transcription failed: ${result.error}`);
										}
									} catch (err) {
										this.notificationService.warn(`Audio saved, but Voice Transcription error: ${(err as Error | undefined)?.message || err}`);
									} finally {
										isTranscribingVoice = false;
										recordingIndicator.style.display = 'none';
									}
								} else {
									recordingIndicator.style.display = 'none';
								}
							};

							mediaRecorder.start();
							isRecordingVoice = true;
							recordingSeconds = 0;
							recordingIndicator.style.display = 'inline-flex';
							recordingStatusSpan.textContent = '0:00 / 5:00';
							recordBtnIcon.className = 'codicon codicon-primitive-square';
							recordBtnLabel.textContent = 'Stop Recording';
							recordBtn.style.background = 'rgba(255, 59, 48, 0.25)';
							recordBtn.style.borderColor = '#ff3b30';
							recordBtn.style.color = '#ffffff';

							recordingTimer = getWindow(voiceBox).setInterval(() => {
								recordingSeconds++;
								recordingStatusSpan.textContent = `${formatVoiceDuration(recordingSeconds)} / 5:00`;
								if (recordingSeconds >= 300) {
									stopVoiceRecording();
								}
							}, 1000);
						} catch (err) {
							this.notificationService.error(`Microphone access error: ${(err as Error | undefined)?.message || err}`);
						}
					};

					recordBtn.onclick = () => {
						if (isRecordingVoice) {
							stopVoiceRecording();
						} else {
							void startVoiceRecording();
						}
					};

					this._register(toDisposable(() => {
						stopAllAudio();
						if (recordingTimer) {
							getWindow(voiceBox).clearInterval(recordingTimer);
							recordingTimer = undefined;
						}
						if (activeStream) {
							activeStream.getTracks().forEach(t => t.stop());
							activeStream = undefined;
						}
					}));

					renderClipsList();
				}

				if (field.type === 'media_player') {
					const mediaBox = append(fieldCard, $('.media-player-schema-config', {
						style: 'display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; background: rgba(245, 158, 11, 0.05); border: 1px solid rgba(251, 191, 36, 0.25); border-radius: 6px; margin-top: 4px;'
					}));

					const mediaNotice = append(mediaBox, $('div', {
						style: 'font-size: 11px; color: #fbbf24; display: flex; align-items: center; gap: 6px; font-weight: 500;'
					}));
					append(mediaNotice, $('span' + ThemeIcon.asCSSSelector(Codicon.deviceCameraVideo)));
					append(mediaNotice, $('span', {}, 'MP3 / MP4 Player: Select or drag & drop a local audio/video file (MP3, MP4, WAV, M4A, AAC, OGG, FLAC, WebM, MOV, etc.) for native HTML5 playback with 0.25x\u20132.0x speed control.'));
					if (isEmbeddedFieldMode && input.embeddedTicketMedia) {
						append(mediaBox, $('div.media-player-ticket-media-note', {
							style: 'font-size: 10.5px; color: rgba(255, 255, 255, 0.6); line-height: 1.4;'
						}, 'This is the media file of this ticket. Changing or clearing it here applies to the ticket when you click Save; Cancel keeps the ticket\'s file.'));
					}

					// Hidden <input type="file"> fallback
					const hiddenFileInput = append(mediaBox, $('input', {
						type: 'file',
						accept: `audio/*,video/*,${MEDIA_PLAYER_ALL_EXTENSIONS.map(e => `.${e}`).join(',')}`,
						style: 'display: none;'
					})) as HTMLInputElement;

					// Drop Zone & File Picker Card
					const dropZone = append(mediaBox, $('.media-player-dropzone', {
						style: 'display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 6px; border: 1.5px dashed rgba(251, 191, 36, 0.4); background: rgba(0, 0, 0, 0.26); transition: all 0.15s ease;'
					}));

					const topPickerRow = append(dropZone, $('div', {
						style: 'display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;'
					}));

					const fileInfoLeft = append(topPickerRow, $('div', {
						style: 'display: flex; align-items: center; gap: 8px; flex: 1; min-width: 180px; flex-wrap: wrap;'
					}));

					const mediaKindBadge = append(fileInfoLeft, $('span', {
						style: 'font-size: 9.5px; font-weight: 700; padding: 2px 7px; border-radius: 4px; background: rgba(56, 189, 248, 0.18); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); text-transform: uppercase; letter-spacing: 0.04em; display: none;'
					}, 'AUDIO · MP3'));

					const fileNameLabel = append(fileInfoLeft, $('span', {
						style: 'font-size: 12px; font-weight: 600; color: #f8fafc; word-break: break-all;'
					}, field.mediaFileName || 'No media file selected'));

					const dropHintSub = append(dropZone, $('div', {
						style: 'font-size: 11px; color: rgba(255, 255, 255, 0.55); display: flex; align-items: center; gap: 6px;'
					}));
					append(dropHintSub, $('span' + ThemeIcon.asCSSSelector(Codicon.cloudUpload), { style: 'font-size: 12px; color: #fbbf24;' }));
					const filePathSubText = append(dropHintSub, $('span', {
						style: 'font-family: var(--vscode-editor-font-family, monospace); font-size: 10.5px; word-break: break-all;'
					}, field.mediaFilePath || 'Drag & drop a local MP3 / MP4 (or WAV, M4A, AAC, OGG, FLAC, WebM, MOV) file here, or click "Select File".'));

					const pickerBtnGroup = append(topPickerRow, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-shrink: 0;'
					}));

					const selectFileBtn = append(pickerBtnGroup, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 4px 11px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; background: rgba(245, 158, 11, 0.2); border: 1px solid rgba(251, 191, 36, 0.55); color: #fbbf24; display: inline-flex; align-items: center; gap: 5px;',
						title: 'Select local MP3 / MP4 or audio/video file'
					})) as HTMLButtonElement;
					append(selectFileBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.folderOpened), { style: 'font-size: 12px;' }));
					const selectFileBtnLabel = append(selectFileBtn, $('span', {}, field.mediaFileName ? 'Change File' : 'Select File'));

					const clearFileBtn = append(pickerBtnGroup, $('button.monaco-button', {
						type: 'button',
						style: `padding: 4px 9px; font-size: 10.5px; font-weight: 600; border-radius: 5px; cursor: pointer; background: rgba(239, 68, 68, 0.14); border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171; display: ${(field.mediaFileName || field.mediaFilePath) ? 'inline-flex' : 'none'}; align-items: center; gap: 4px;`,
						title: 'Clear imported media file'
					})) as HTMLButtonElement;
					append(clearFileBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), { style: 'font-size: 11px;' }));
					append(clearFileBtn, $('span', {}, 'Clear'));

					// Error Banner for Unsupported Formats / Codec Errors
					const errorBanner = append(mediaBox, $('div', {
						style: 'display: none; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 6px; background: rgba(239, 68, 68, 0.14); border: 1px solid rgba(239, 68, 68, 0.45); color: #fca5a5; font-size: 11.5px; line-height: 1.4;'
					}));
					append(errorBanner, $('span' + ThemeIcon.asCSSSelector(Codicon.warning), { style: 'font-size: 14px; color: #f87171; flex-shrink: 0;' }));
					const errorBannerText = append(errorBanner, $('span', {}));

					// Video Stage (auto-shown when mediaKind === 'video')
					const videoStageWrap = append(mediaBox, $('div', {
						style: 'display: none; flex-direction: column; align-items: center; justify-content: center; width: 100%; background: #000000; border-radius: 8px; border: 1px solid rgba(56, 189, 248, 0.35); overflow: hidden; position: relative; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);'
					}));
					const videoPlayerEl = append(videoStageWrap, $('video', {
						preload: 'metadata',
						playsinline: 'true',
						style: 'width: 100%; max-height: 360px; display: block; background: #000000; cursor: pointer; outline: none;'
					})) as HTMLVideoElement;

					// Hidden Audio Element (used when mediaKind === 'audio')
					const audioPlayerEl = append(mediaBox, $('audio', {
						preload: 'metadata',
						style: 'display: none;'
					})) as HTMLAudioElement;

					// Unified Transport Control Bar (Matches TTS Component Player Bar)
					const customPlayerWrap = append(mediaBox, $('div', {
						style: 'display: none; align-items: center; gap: 10px; flex-wrap: wrap; width: 100%; box-sizing: border-box; padding: 6px 12px; border-radius: 20px; background: rgba(0, 0, 0, 0.45); border: 1px solid rgba(56, 189, 248, 0.35); box-shadow: inset 0 1px 3px rgba(0,0,0,0.5); user-select: none;'
					}));

					const playPauseBtn = append(customPlayerWrap, $('button', {
						type: 'button',
						style: 'width: 26px; height: 26px; border-radius: 50%; border: 1px solid rgba(56, 189, 248, 0.6); background: rgba(0, 122, 204, 0.28); color: #38bdf8; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; padding: 0; transition: all 0.15s ease;',
						title: 'Play / Pause Media'
					})) as HTMLButtonElement;
					const playIconEl = append(playPauseBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.play), { style: 'font-size: 13px;' }));

					const timeLabelEl = append(customPlayerWrap, $('span', {
						style: 'font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); color: #7dd3fc; font-weight: 600; min-width: 78px; text-align: center; flex-shrink: 0; user-select: none;'
					}, '0:00 / 0:00'));

					const progressTrack = append(customPlayerWrap, $('div', {
						style: 'flex: 1; height: 6px; border-radius: 3px; background: rgba(255, 255, 255, 0.14); position: relative; cursor: pointer; min-width: 80px; display: flex; align-items: center;',
						title: 'Click or drag to seek playback position'
					}));
					const progressFill = append(progressTrack, $('div', {
						style: 'width: 0%; height: 100%; border-radius: 3px; background: linear-gradient(90deg, #007acc, #38bdf8); pointer-events: none;'
					}));
					const progressThumb = append(progressTrack, $('div', {
						style: 'width: 10px; height: 10px; border-radius: 50%; background: #38bdf8; border: 1.5px solid #ffffff; position: absolute; left: 0%; transform: translate(-50%, 0); box-shadow: 0 1px 4px rgba(0,0,0,0.6); pointer-events: none;'
					}));

					// Playback Speed Selector (0.25x, 0.5x, 0.75x, 1.0x, 1.25x, 1.5x, 1.75x, 2.0x)
					let currentPlaybackRate = (typeof field.mediaPlaybackRate === 'number' && field.mediaPlaybackRate >= 0.25 && field.mediaPlaybackRate <= 2.0)
						? field.mediaPlaybackRate
						: 1.0;
					const speedSelect = append(customPlayerWrap, $('select', {
						style: 'background: rgba(0, 122, 204, 0.22); color: #7dd3fc; border: 1px solid rgba(56, 189, 248, 0.4); border-radius: 10px; padding: 2px 6px; font-size: 10.5px; font-weight: 600; font-family: var(--vscode-editor-font-family, monospace); cursor: pointer; outline: none; flex-shrink: 0;',
						title: 'Playback Speed (0.25x - 2.0x)'
					})) as HTMLSelectElement;
					for (const spd of MEDIA_PLAYER_SPEED_OPTIONS) {
						const opt = append(speedSelect, $('option', {
							value: String(spd.rate),
							title: spd.desc,
							style: 'background: #1e1e2e; color: #f8fafc;'
						}, spd.label)) as HTMLOptionElement;
						if (Math.abs(spd.rate - currentPlaybackRate) < 0.01) {
							opt.selected = true;
						}
					}

					const muteBtn = append(customPlayerWrap, $('button', {
						type: 'button',
						style: 'background: transparent; border: none; color: #cbd5e1; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; padding: 2px; opacity: 0.85; flex-shrink: 0;',
						title: 'Mute / Unmute'
					})) as HTMLButtonElement;
					const muteIconEl = append(muteBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.unmute), { style: 'font-size: 14px;' }));

					const fullscreenBtn = append(customPlayerWrap, $('button', {
						type: 'button',
						style: 'background: transparent; border: none; color: #cbd5e1; cursor: pointer; display: none; align-items: center; justify-content: center; padding: 2px; opacity: 0.85; flex-shrink: 0;',
						title: 'Fullscreen Video'
					})) as HTMLButtonElement;
					const fullscreenIconEl = append(fullscreenBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.screenFull), { style: 'font-size: 13px;' }));

					let activeKind: 'audio' | 'video' = field.mediaKind === 'video' ? 'video' : 'audio';
					let currentBlobUrl: string | undefined;
					// Size / duration of the loaded file, shown next to the subtitle limits (CI-45)
					let currentMediaFacts: IMediaFileFacts | undefined;
					const subtitleSettings: { widget?: IMediaSubtitleSettingsWidget } = {};
					const reportMediaFacts = (facts: IMediaFileFacts | undefined) => {
						currentMediaFacts = facts;
						subtitleSettings.widget?.setCurrentMedia(facts);
					};
					let currentLocalFileUri: URI | undefined;
					let triedProtocolFallback = false;
					let knownDurationSec = 0;
					let isScrubbing = false;
					let isVideoFullscreen = false;
					let fullscreenOverlayEl: HTMLElement | undefined;

					const onFullscreenKeyDown = (ev: KeyboardEvent) => {
						if (!isVideoFullscreen) {
							return;
						}
						if (ev.key === 'Escape') {
							ev.stopPropagation();
							ev.preventDefault();
							exitVideoFullscreen();
						}
					};

					const exitVideoFullscreen = () => {
						if (!isVideoFullscreen) {
							return;
						}
						isVideoFullscreen = false;
						const mediaWindow = getWindow(mediaBox);
						mediaWindow.removeEventListener('keydown', onFullscreenKeyDown, true);
						if (mediaWindow.document.fullscreenElement) {
							mediaWindow.document.exitFullscreen().catch(() => { });
						}
						const wasPlaying = !videoPlayerEl.paused && !videoPlayerEl.ended;
						videoStageWrap.style.flex = '';
						videoStageWrap.style.minHeight = '';
						videoStageWrap.style.height = '';
						videoPlayerEl.style.maxHeight = '360px';
						videoPlayerEl.style.height = '';
						videoPlayerEl.style.objectFit = '';
						try {
							mediaBox.insertBefore(videoStageWrap, audioPlayerEl);
							mediaBox.appendChild(customPlayerWrap);
						} catch { }
						if (fullscreenOverlayEl && fullscreenOverlayEl.parentElement) {
							fullscreenOverlayEl.parentElement.removeChild(fullscreenOverlayEl);
						}
						fullscreenOverlayEl = undefined;
						fullscreenIconEl.className = ThemeIcon.asClassName(Codicon.screenFull);
						fullscreenBtn.title = 'Fullscreen Video';
						fullscreenBtn.style.color = '#cbd5e1';
						if (wasPlaying && videoPlayerEl.paused) {
							videoPlayerEl.play().catch(() => { });
						}
					};

					const enterVideoFullscreen = () => {
						if (isVideoFullscreen || activeKind !== 'video') {
							return;
						}
						isVideoFullscreen = true;
						const wasPlaying = !videoPlayerEl.paused && !videoPlayerEl.ended;
						const mediaWindow = getWindow(mediaBox);
						const hostRoot = this._layoutService.getContainer(mediaWindow) || mediaWindow.document.body;
						const overlay = append(hostRoot, $('div.media-player-fullscreen-overlay', {
							style: 'position: fixed; inset: 0; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 2147483647; background: rgba(5, 8, 15, 0.96); backdrop-filter: blur(8px); display: flex; flex-direction: column; justify-content: space-between; padding: 16px 24px 20px 24px; box-sizing: border-box; gap: 12px;'
						}));
						fullscreenOverlayEl = overlay;

						const topBar = append(overlay, $('div', {
							style: 'display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-shrink: 0;'
						}));
						const titleWrap = append(topBar, $('div', {
							style: 'display: flex; align-items: center; gap: 8px; min-width: 0;'
						}));
						append(titleWrap, $('span', {
							style: 'font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 2px 7px; border-radius: 4px; background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.45);'
						}, mediaKindBadge.textContent || 'VIDEO'));
						append(titleWrap, $('span', {
							style: 'font-size: 13px; font-weight: 600; color: #f8fafc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;'
						}, field.mediaFileName || fileNameLabel.textContent || 'Video Player'));

						const closeFsBtn = append(topBar, $('button.monaco-button', {
							type: 'button',
							style: 'padding: 4px 12px; font-size: 11px; font-weight: 600; border-radius: 6px; cursor: pointer; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.22); color: #f8fafc; display: inline-flex; align-items: center; gap: 6px;',
							title: 'Exit Fullscreen (Esc)'
						})) as HTMLButtonElement;
						append(closeFsBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.screenNormal), { style: 'font-size: 12px;' }));
						append(closeFsBtn, $('span', {}, 'Exit Fullscreen (Esc)'));
						closeFsBtn.onclick = (ev) => {
							ev.stopPropagation();
							exitVideoFullscreen();
						};

						videoStageWrap.style.flex = '1';
						videoStageWrap.style.minHeight = '0';
						videoStageWrap.style.height = '100%';
						videoPlayerEl.style.maxHeight = 'calc(100vh - 130px)';
						videoPlayerEl.style.height = '100%';
						videoPlayerEl.style.objectFit = 'contain';

						overlay.appendChild(videoStageWrap);
						overlay.appendChild(customPlayerWrap);

						fullscreenIconEl.className = ThemeIcon.asClassName(Codicon.screenNormal);
						fullscreenBtn.title = 'Exit Fullscreen (Esc)';
						fullscreenBtn.style.color = '#38bdf8';

						mediaWindow.addEventListener('keydown', onFullscreenKeyDown, true);
						if (wasPlaying && videoPlayerEl.paused) {
							videoPlayerEl.play().catch(() => { });
						}
					};

					const toggleVideoFullscreen = () => {
						if (isVideoFullscreen) {
							exitVideoFullscreen();
						} else {
							enterVideoFullscreen();
						}
					};

					const getActiveMediaEl = (): HTMLMediaElement => {
						return activeKind === 'video' ? videoPlayerEl : audioPlayerEl;
					};

					const formatMediaTime = (sec: number): string => {
						if (!Number.isFinite(sec) || sec < 0) {
							return '0:00';
						}
						const totalSeconds = Math.floor(sec);
						const hrs = Math.floor(totalSeconds / 3600);
						const mins = Math.floor((totalSeconds % 3600) / 60);
						const secs = totalSeconds % 60;
						if (hrs > 0) {
							return `${hrs}:${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
						}
						return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
					};

					const updateMediaTimeUi = () => {
						const mediaEl = getActiveMediaEl();
						const cur = Number.isFinite(mediaEl.currentTime) ? mediaEl.currentTime : 0;
						const rawDur = (Number.isFinite(mediaEl.duration) && mediaEl.duration > 0) ? mediaEl.duration : knownDurationSec;
						const dur = rawDur > 0 ? rawDur : 0;
						timeLabelEl.textContent = `${formatMediaTime(cur)} / ${formatMediaTime(dur)}`;
						const pct = dur > 0 ? Math.min(100, Math.max(0, (cur / dur) * 100)) : 0;
						progressFill.style.width = `${pct}%`;
						progressThumb.style.left = `${pct}%`;
					};

					const cleanupMediaResources = () => {
						exitVideoFullscreen();
						for (const el of [audioPlayerEl, videoPlayerEl]) {
							try {
								el.pause();
								el.removeAttribute('src');
								el.load();
							} catch { }
						}
						if (currentBlobUrl) {
							try {
								URL.revokeObjectURL(currentBlobUrl);
							} catch { }
							currentBlobUrl = undefined;
						}
						knownDurationSec = 0;
						playIconEl.className = ThemeIcon.asClassName(Codicon.play);
						playPauseBtn.style.background = 'rgba(0, 122, 204, 0.28)';
						progressFill.style.width = '0%';
						progressThumb.style.left = '0%';
						timeLabelEl.textContent = '0:00 / 0:00';
					};

					this._renderCleanupFns.push(cleanupMediaResources);

					const showMediaError = (msg: string) => {
						errorBannerText.textContent = msg;
						errorBanner.style.display = 'flex';
					};

					const hideMediaError = () => {
						errorBannerText.textContent = '';
						errorBanner.style.display = 'none';
					};

					const updateHeaderBadges = (fileName: string, filePath: string, kind: 'audio' | 'video', ext: string) => {
						if (fileName || filePath) {
							const displayName = fileName || (filePath.split(/[\\/]/).pop() || filePath);
							fileNameLabel.textContent = displayName;
							filePathSubText.textContent = filePath || displayName;
							mediaKindBadge.style.display = 'inline-block';
							mediaKindBadge.textContent = `${kind.toUpperCase()} · ${(ext || kind).toUpperCase()}`;
							if (kind === 'video') {
								mediaKindBadge.style.background = 'rgba(245, 158, 11, 0.2)';
								mediaKindBadge.style.color = '#fbbf24';
								mediaKindBadge.style.borderColor = 'rgba(251, 191, 36, 0.45)';
							} else {
								mediaKindBadge.style.background = 'rgba(56, 189, 248, 0.18)';
								mediaKindBadge.style.color = '#38bdf8';
								mediaKindBadge.style.borderColor = 'rgba(56, 189, 248, 0.35)';
							}
							selectFileBtnLabel.textContent = 'Change File';
							clearFileBtn.style.display = 'inline-flex';
						} else {
							fileNameLabel.textContent = 'No media file selected';
							filePathSubText.textContent = 'Drag & drop a local MP3 / MP4 (or WAV, M4A, AAC, OGG, FLAC, WebM, MOV) file here, or click "Select File".';
							mediaKindBadge.style.display = 'none';
							selectFileBtnLabel.textContent = 'Select File';
							clearFileBtn.style.display = 'none';
						}
					};

					const mountBlobIntoPlayer = (blob: Blob, fileName: string, filePath: string, explicitMime?: string, shouldSyncDraft: boolean = true) => {
						cleanupMediaResources();
						hideMediaError();
						triedProtocolFallback = false;
						currentLocalFileUri = filePath ? (filePath.startsWith('file://') ? URI.parse(filePath) : URI.file(filePath)) : undefined;

						const info = detectMediaFileInfo(fileName || filePath, explicitMime || blob.type);
						activeKind = info.kind;
						field.mediaFileName = fileName || (filePath.split(/[\\/]/).pop() || 'media');
						if (filePath) {
							field.mediaFilePath = filePath;
						}
						field.mediaKind = info.kind;
						field.mediaMimeType = info.mimeType;
						reportMediaFacts({ sizeBytes: blob.size });

						updateHeaderBadges(field.mediaFileName, field.mediaFilePath || '', info.kind, info.ext);

						if (!info.isRecognizedMedia) {
							videoStageWrap.style.display = 'none';
							customPlayerWrap.style.display = 'none';
							showMediaError(`Unsupported file "${field.mediaFileName}": Please select a supported audio or video format (MP3, MP4, WAV, M4A, AAC, OGG, FLAC, WebM, MOV, etc.).`);
							if (shouldSyncDraft) {
								this._syncDraft();
							}
							return;
						}

						const typedBlob = blob.type ? blob : new Blob([blob], { type: info.mimeType });
						currentBlobUrl = URL.createObjectURL(typedBlob);

						const targetEl = getActiveMediaEl();
						if (activeKind === 'video') {
							videoStageWrap.style.display = 'flex';
							fullscreenBtn.style.display = 'inline-flex';
						} else {
							videoStageWrap.style.display = 'none';
							fullscreenBtn.style.display = 'none';
						}
						customPlayerWrap.style.display = 'flex';

						targetEl.src = currentBlobUrl;
						targetEl.defaultPlaybackRate = currentPlaybackRate;
						targetEl.playbackRate = currentPlaybackRate;
						targetEl.load();
						if (shouldSyncDraft) {
							this._syncDraft();
						}
					};

					const loadFromLocalPath = async (localPath: string, displayFileName?: string, persistAfterLoad: boolean = true) => {
						const cleanPath = (localPath || '').trim();
						if (!cleanPath) {
							return;
						}
						const resolvedName = displayFileName || cleanPath.split(/[\\/]/).pop() || cleanPath;
						const info = detectMediaFileInfo(resolvedName || cleanPath, field.mediaMimeType);
						updateHeaderBadges(resolvedName, cleanPath, info.kind, info.ext);
						try {
							const fileService = this._instantiationService.invokeFunction(accessor => accessor.get(IFileService));
							const fileUri = cleanPath.startsWith('file://') ? URI.parse(cleanPath) : URI.file(cleanPath);
							if (!(await fileService.exists(fileUri))) {
								showMediaError(`Media file not found at "${cleanPath}". Please re-select the local file.`);
								return;
							}
							const content = await fileService.readFile(fileUri);
							const rawBytes = content.value.buffer;
							const safeBytes = new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
							const blob = new Blob([safeBytes.slice(0)], { type: info.mimeType });
							mountBlobIntoPlayer(blob, resolvedName, fileUri.fsPath, info.mimeType, persistAfterLoad);
							if (persistAfterLoad) {
								await this._persistCurrentModule();
							}
						} catch (err) {
							showMediaError(`Failed to read local media file "${resolvedName}": ${(err as Error | undefined)?.message || err}`);
						}
					};

					const handleDroppedOrInputFile = async (file: File) => {
						let localPath = '';
						try {
							localPath = getPathForFile(file) || (file as IFileWithLegacyPath).path || '';
						} catch {
							localPath = (file as IFileWithLegacyPath).path || '';
						}
						mountBlobIntoPlayer(file, file.name, localPath, file.type);
						await this._persistCurrentModule();
					};

					const wireMediaElementEvents = (el: HTMLMediaElement, kind: 'audio' | 'video') => {
						el.onplay = () => {
							if (activeKind !== kind) {
								return;
							}
							el.playbackRate = currentPlaybackRate;
							playIconEl.className = ThemeIcon.asClassName(Codicon.debugPause);
							playPauseBtn.style.background = 'rgba(0, 122, 204, 0.52)';
						};
						el.onpause = () => {
							if (activeKind !== kind) {
								return;
							}
							playIconEl.className = ThemeIcon.asClassName(Codicon.play);
							playPauseBtn.style.background = 'rgba(0, 122, 204, 0.28)';
						};
						el.onended = () => {
							if (activeKind !== kind) {
								return;
							}
							playIconEl.className = ThemeIcon.asClassName(Codicon.play);
							playPauseBtn.style.background = 'rgba(0, 122, 204, 0.28)';
							progressFill.style.width = '100%';
							progressThumb.style.left = '100%';
							updateMediaTimeUi();
						};
						el.onloadedmetadata = () => {
							if (activeKind !== kind) {
								return;
							}
							hideMediaError();
							el.defaultPlaybackRate = currentPlaybackRate;
							el.playbackRate = currentPlaybackRate;
							if (Number.isFinite(el.duration) && el.duration > 0) {
								knownDurationSec = el.duration;
								reportMediaFacts({ ...currentMediaFacts, durationSec: el.duration });
							}
							updateMediaTimeUi();
						};
						el.ondurationchange = () => {
							if (activeKind !== kind) {
								return;
							}
							if (Number.isFinite(el.duration) && el.duration > 0) {
								knownDurationSec = el.duration;
								reportMediaFacts({ ...currentMediaFacts, durationSec: el.duration });
							}
							updateMediaTimeUi();
						};
						el.ontimeupdate = () => {
							if (activeKind !== kind || isScrubbing) {
								return;
							}
							updateMediaTimeUi();
						};
						el.onerror = () => {
							if (activeKind !== kind || !el.getAttribute('src')) {
								return;
							}
							if (!triedProtocolFallback && currentLocalFileUri) {
								triedProtocolFallback = true;
								try {
									const browserUriStr = FileAccess.uriToBrowserUri(currentLocalFileUri).toString(true);
									el.src = browserUriStr;
									el.defaultPlaybackRate = currentPlaybackRate;
									el.playbackRate = currentPlaybackRate;
									el.load();
									return;
								} catch { }
							}
							showMediaError(`Unable to play "${field.mediaFileName || 'media file'}": This format or codec is not supported by the browser's native HTML5 ${kind} decoder.`);
						};
					};

					wireMediaElementEvents(audioPlayerEl, 'audio');
					wireMediaElementEvents(videoPlayerEl, 'video');

					const togglePlayPause = () => {
						const mediaEl = getActiveMediaEl();
						if (!mediaEl.src) {
							return;
						}
						if (mediaEl.paused || mediaEl.ended) {
							if (mediaEl.ended) {
								mediaEl.currentTime = 0;
							}
							mediaEl.playbackRate = currentPlaybackRate;
							mediaEl.play().catch(err => {
								showMediaError(`Playback error: ${err?.message || err}`);
							});
						} else {
							mediaEl.pause();
						}
					};

					playPauseBtn.onclick = (e) => {
						e.stopPropagation();
						togglePlayPause();
					};
					videoPlayerEl.onclick = (e) => {
						e.stopPropagation();
						togglePlayPause();
					};
					videoPlayerEl.ondblclick = (e) => {
						e.stopPropagation();
						toggleVideoFullscreen();
					};

					fullscreenBtn.onclick = (e) => {
						e.stopPropagation();
						toggleVideoFullscreen();
					};

					// Interactive Seek & Scrubbing on Progress Track
					const seekToClientX = (clientX: number) => {
						const mediaEl = getActiveMediaEl();
						const dur = (Number.isFinite(mediaEl.duration) && mediaEl.duration > 0) ? mediaEl.duration : knownDurationSec;
						if (dur <= 0) {
							return;
						}
						const rect = progressTrack.getBoundingClientRect();
						if (rect.width <= 0) {
							return;
						}
						const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
						mediaEl.currentTime = ratio * dur;
						const pct = ratio * 100;
						progressFill.style.width = `${pct}%`;
						progressThumb.style.left = `${pct}%`;
						timeLabelEl.textContent = `${formatMediaTime(ratio * dur)} / ${formatMediaTime(dur)}`;
					};

					progressTrack.onmousedown = (e: MouseEvent) => {
						e.stopPropagation();
						e.preventDefault();
						isScrubbing = true;
						seekToClientX(e.clientX);
						const scrubWindow = getWindow(progressTrack);

						const onMouseMove = (moveEv: MouseEvent) => {
							if (!isScrubbing) {
								return;
							}
							seekToClientX(moveEv.clientX);
						};
						const onMouseUp = (upEv: MouseEvent) => {
							if (isScrubbing) {
								seekToClientX(upEv.clientX);
								isScrubbing = false;
							}
							scrubWindow.removeEventListener('mousemove', onMouseMove, true);
							scrubWindow.removeEventListener('mouseup', onMouseUp, true);
						};
						scrubWindow.addEventListener('mousemove', onMouseMove, true);
						scrubWindow.addEventListener('mouseup', onMouseUp, true);
					};

					speedSelect.onclick = (e) => e.stopPropagation();
					speedSelect.onmousedown = (e) => e.stopPropagation();
					speedSelect.onchange = async (e) => {
						e.stopPropagation();
						const nextRate = parseFloat(speedSelect.value);
						currentPlaybackRate = Number.isFinite(nextRate) ? Math.min(2.0, Math.max(0.25, nextRate)) : 1.0;
						field.mediaPlaybackRate = currentPlaybackRate;
						for (const el of [audioPlayerEl, videoPlayerEl]) {
							el.defaultPlaybackRate = currentPlaybackRate;
							el.playbackRate = currentPlaybackRate;
						}
						this._syncDraft();
						await this._persistCurrentModule();
					};

					muteBtn.onclick = (e) => {
						e.stopPropagation();
						const mediaEl = getActiveMediaEl();
						const nextMuted = !mediaEl.muted;
						audioPlayerEl.muted = nextMuted;
						videoPlayerEl.muted = nextMuted;
						muteIconEl.className = ThemeIcon.asClassName(nextMuted ? Codicon.mute : Codicon.unmute);
						muteBtn.style.color = nextMuted ? '#f87171' : '#cbd5e1';
					};

					selectFileBtn.onclick = async (e) => {
						e.stopPropagation();
						try {
							const picked = await this._fileDialogService.showOpenDialog({
								canSelectFiles: true,
								canSelectFolders: false,
								canSelectMany: false,
								title: 'Select Audio or Video File (MP3 / MP4...)',
								filters: [
									{ name: 'Audio & Video Media', extensions: [...MEDIA_PLAYER_ALL_EXTENSIONS] },
									{ name: 'All Files', extensions: ['*'] }
								]
							});
							if (picked && picked.length > 0) {
								const fileUri = picked[0];
								const fName = fileUri.fsPath.split(/[\\/]/).pop() || 'media';
								await loadFromLocalPath(fileUri.fsPath, fName, true);
							}
						} catch {
							hiddenFileInput.value = '';
							hiddenFileInput.click();
						}
					};

					hiddenFileInput.onchange = async () => {
						const file = hiddenFileInput.files?.[0];
						if (file) {
							await handleDroppedOrInputFile(file);
						}
					};

					clearFileBtn.onclick = async (e) => {
						e.stopPropagation();
						cleanupMediaResources();
						hideMediaError();
						field.mediaFilePath = '';
						field.mediaFileName = '';
						field.mediaKind = 'audio';
						field.mediaMimeType = '';
						reportMediaFacts(undefined);
						videoStageWrap.style.display = 'none';
						customPlayerWrap.style.display = 'none';
						updateHeaderBadges('', '', 'audio', '');
						this._syncDraft();
						await this._persistCurrentModule();
					};

					// Drag & Drop File Support on DropZone & MediaBox
					const handleDragOver = (e: DragEvent) => {
						e.preventDefault();
						e.stopPropagation();
						if (e.dataTransfer) {
							e.dataTransfer.dropEffect = 'copy';
						}
						dropZone.style.borderColor = '#38bdf8';
						dropZone.style.background = 'rgba(56, 189, 248, 0.12)';
					};

					const handleDragLeave = (e: DragEvent) => {
						e.preventDefault();
						e.stopPropagation();
						dropZone.style.borderColor = 'rgba(251, 191, 36, 0.4)';
						dropZone.style.background = 'rgba(0, 0, 0, 0.26)';
					};

					const handleDrop = async (e: DragEvent) => {
						e.preventDefault();
						e.stopPropagation();
						dropZone.style.borderColor = 'rgba(251, 191, 36, 0.4)';
						dropZone.style.background = 'rgba(0, 0, 0, 0.26)';

						const droppedFiles = e.dataTransfer?.files;
						if (droppedFiles && droppedFiles.length > 0) {
							await handleDroppedOrInputFile(droppedFiles[0]);
							return;
						}

						// Fallback if dragged from VS Code Explorer tree (ResourceURLs / text/uri-list)
						const uriListRaw = e.dataTransfer?.getData('ResourceURLs') || e.dataTransfer?.getData('text/uri-list') || '';
						if (uriListRaw) {
							try {
								let firstUriStr = '';
								if (uriListRaw.trim().startsWith('[')) {
									const arr = JSON.parse(uriListRaw);
									if (Array.isArray(arr) && arr.length > 0) {
										firstUriStr = String(arr[0]);
									}
								} else {
									firstUriStr = uriListRaw.split(/\r?\n/)[0].trim();
								}
								if (firstUriStr) {
									const parsedUri = URI.parse(firstUriStr);
									if (parsedUri.fsPath) {
										const fName = parsedUri.fsPath.split(/[\\/]/).pop() || 'media';
										await loadFromLocalPath(parsedUri.fsPath, fName, true);
									}
								}
							} catch { }
						}
					};

					dropZone.ondragenter = handleDragOver;
					dropZone.ondragover = handleDragOver;
					dropZone.ondragleave = handleDragLeave;
					dropZone.ondrop = handleDrop;

					// Auto-load persisted local media file if present
					if (field.mediaFilePath) {
						loadFromLocalPath(field.mediaFilePath, field.mediaFileName, false).catch(() => { });
					}

					// Subtitles + dictation settings (CI-45, opt-in)
					const subtitleVoiceModels = this._instantiationService.invokeFunction(accessor => {
						try { return accessor.get(IVoiceModelService); } catch { return undefined; }
					});
					// Extract button (CI-46): results are saved only when the dialog was opened from a ticket
					const subtitleServices = this._instantiationService.invokeFunction(accessor => ({ fileService: accessor.get(IFileService), dialogService: accessor.get(IDialogService) }));
					const isTicketField = isEmbeddedFieldMode && (input.embeddedFieldId || '').toLowerCase() === (field.id || '').toLowerCase();
					subtitleSettings.widget = this._register(renderMediaSubtitleSettings(mediaBox, field, subtitleVoiceModels, () => {
						this._syncDraft();
						this._persistCurrentModule().catch(() => { });
					}, currentMediaFacts, {
						...subtitleServices,
						store: isTicketField ? input.embeddedSubtitleStore : undefined,
						baseFolder: isTicketField ? input.embeddedTicketFolder : undefined,
						getMediaSource: () => {
							const path = currentLocalFileUri ? currentLocalFileUri.toString() : (currentBlobUrl ? undefined : field.mediaFilePath || undefined);
							const name = field.mediaFileName || (field.mediaFilePath || '').split(/[\\/]/).pop() || '';
							if (!name || (!path && !currentBlobUrl)) {
								return undefined;
							}
							return { name, path, blobUrl: currentBlobUrl, durationSec: knownDurationSec > 0 ? knownDurationSec : undefined };
						}
					}));
				}

				if (field.type === 'output') {
					if (!Array.isArray(field.outputSpecs)) {
						field.outputSpecs = [];
					}

					const outputBox = append(fieldCard, $('.primitive-config-box', {
						style: 'margin-top: 10px; padding: 12px 14px; background: rgba(129, 140, 248, 0.05); border: 1px solid rgba(129, 140, 248, 0.2); border-radius: 6px; display: flex; flex-direction: column; gap: 10px;'
					}));

					const headerRow = append(outputBox, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;' }));
					const titleEl = append(headerRow, $('div', { style: 'font-size: 11.5px; font-weight: 600; color: #818cf8; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;' }));
					append(titleEl, $('span' + ThemeIcon.asCSSSelector(Codicon.output)));
					append(titleEl, $('span', {}, 'Output Manifest & Export Selection'));

					const headerBtns = append(headerRow, $('div', { style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;' }));

					const addOutputBtn = append(headerBtns, $('button.add-custom-output-btn', {
						type: 'button',
						style: 'display: inline-flex; align-items: center; gap: 5px; padding: 4px 12px; font-size: 11px; font-weight: 600; border-radius: 6px; background: rgba(52, 211, 153, 0.14); color: #6ee7b7; border: 1px solid rgba(52, 211, 153, 0.4); cursor: pointer; transition: all 0.15s ease;',
						title: 'Add a custom output index with auto-generated variable name and bound workflow/node variable'
					})) as HTMLButtonElement;
					addOutputBtn.onmouseenter = () => {
						addOutputBtn.style.background = 'rgba(52, 211, 153, 0.25)';
						addOutputBtn.style.borderColor = 'rgba(52, 211, 153, 0.65)';
						addOutputBtn.style.color = '#ffffff';
					};
					addOutputBtn.onmouseleave = () => {
						addOutputBtn.style.background = 'rgba(52, 211, 153, 0.14)';
						addOutputBtn.style.borderColor = 'rgba(52, 211, 153, 0.4)';
						addOutputBtn.style.color = '#6ee7b7';
					};
					append(addOutputBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.add)));
					append(addOutputBtn, $('span', {}, 'Add Output'));

					const syncBtn = append(headerBtns, $('button.sync-primitives-btn', {
						type: 'button',
						style: 'display: inline-flex; align-items: center; gap: 5px; padding: 4px 12px; font-size: 11px; font-weight: 600; border-radius: 6px; background: rgba(129, 140, 248, 0.12); color: #a5b4fc; border: 1px solid rgba(129, 140, 248, 0.35); cursor: pointer; transition: all 0.15s ease;'
					})) as HTMLButtonElement;
					syncBtn.onmouseenter = () => {
						syncBtn.style.background = 'rgba(129, 140, 248, 0.22)';
						syncBtn.style.borderColor = 'rgba(129, 140, 248, 0.6)';
						syncBtn.style.color = '#ffffff';
						syncBtn.style.boxShadow = '0 0 10px rgba(129, 140, 248, 0.25)';
					};
					syncBtn.onmouseleave = () => {
						syncBtn.style.background = 'rgba(129, 140, 248, 0.12)';
						syncBtn.style.borderColor = 'rgba(129, 140, 248, 0.35)';
						syncBtn.style.color = '#a5b4fc';
						syncBtn.style.boxShadow = 'none';
					};
					append(syncBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.refresh)));
					append(syncBtn, $('span', {}, 'Sync Primitives'));

					append(outputBox, $('div', { style: 'font-size: 11px; color: rgba(255, 255, 255, 0.65); line-height: 1.4;' },
						'Define custom output keys (bound to any workflow/node variable) or sync sibling primitives to expose structured JSON/dictionary results.'
					));

					const specsContainer = append(outputBox, $('.output-specs-container', {
						style: 'display: flex; flex-direction: column; gap: 8px;'
					}));

					const getAvailableOutputSourceVars = (): string[] => {
						const varNames: string[] = [];
						const seen = new Set<string>();
						const pushVar = (name?: string) => {
							const clean = (name || '').trim().replace(/^@/, '');
							if (clean && !seen.has(clean)) {
								seen.add(clean);
								varNames.push(clean);
							}
						};
						if (this.input instanceof CustomModuleSchemaEditorInput && typeof this.input.workflowVariablesProvider === 'function') {
							try {
								for (const wv of (this.input.workflowVariablesProvider() || [])) {
									pushVar(typeof wv === 'string' ? wv : (wv as { name?: string } | null | undefined)?.name);
								}
							} catch { }
						}
						const allFields = (this._activeModule?.fields && this._activeModule.fields.length > 0) ? this._activeModule.fields : fields;
						for (const f of allFields) {
							if (!f || f.id === field.id || f.type === 'output' || f.type === 'voice_note' || f.id === 'title' || f.id === 'description') {
								continue;
							}
							if (f.type === 'parameters' && Array.isArray(f.parameters)) {
								for (const p of f.parameters) {
									pushVar(p?.name);
								}
							} else {
								const outVar = (f.outputVariableName || '').trim() || generateSmartPythonVarName(f.label || f.id, f.type);
								pushVar(outVar);
								if (f.label && f.label !== outVar) {
									pushVar(f.label);
								}
							}
						}
						return varNames;
					};

					const syncSpecsWithCanvas = () => {
						try {
							const allFields = (this._activeModule?.fields && this._activeModule.fields.length > 0) ? this._activeModule.fields : fields;
							const currentCanvasFields = allFields.filter(f =>
								f &&
								f.id !== field.id &&
								f.type !== 'output' &&
								f.type !== 'voice_note' &&
								f.id !== 'title' &&
								f.id !== 'description' &&
								f.label?.toLowerCase() !== 'title' &&
								f.label?.toLowerCase() !== 'description'
							);

							if (!Array.isArray(field.outputSpecs)) {
								field.outputSpecs = [];
							}

							// Always preserve user-defined custom outputs
							const preservedCustomSpecs: IOutputSpec[] = [];
							const existingMap = new Map<string, IOutputSpec>();
							for (const s of field.outputSpecs) {
								if (s && typeof s === 'object') {
									if (s.isCustom) {
										preservedCustomSpecs.push(s);
									} else {
										if (s.fieldKey) { existingMap.set(s.fieldKey, s); }
										if (s.label) { existingMap.set(s.label, s); }
									}
								}
							}

							const updated: IOutputSpec[] = [...preservedCustomSpecs];
							for (const f of currentCanvasFields) {
								const fKey = f.label || f.id || 'Primitive';
								const autoVar = (f.outputVariableName || '').trim() || generateSmartPythonVarName(f.label || f.id, f.type);
								const existing = existingMap.get(fKey) || (f.id ? existingMap.get(f.id) : undefined);
								if (existing) {
									updated.push({
										fieldKey: fKey,
										label: f.label || f.id || fKey,
										varName: existing.varName || autoVar,
										enabled: existing.enabled ?? true,
										defaultFormat: existing.defaultFormat || 'table'
									});
								} else {
									updated.push({
										fieldKey: fKey,
										label: f.label || f.id || fKey,
										varName: autoVar,
										enabled: true,
										defaultFormat: 'table'
									});
								}
							}
							field.outputSpecs = updated;
						} catch (err) {
							console.error('[OutputPrimitive] syncSpecsWithCanvas error:', err);
							this.notificationService.error(`Sync error: ${err}`);
						}
					};

					const renderSpecsList = () => {
						try {
							clearNode(specsContainer);
							if (!Array.isArray(field.outputSpecs) || field.outputSpecs.length === 0) {
								append(specsContainer, $('div', {
									style: 'padding: 10px 14px; font-size: 11px; font-style: italic; color: rgba(255, 255, 255, 0.45); text-align: center; border: 1px dashed rgba(255, 255, 255, 0.15); border-radius: 4px; background: rgba(0, 0, 0, 0.15);'
								}, 'No outputs defined yet. Click "+ Add Output" to create a custom output index, or "Sync Primitives" to import sibling components.'));
								return;
							}

							const availableSourceVars = getAvailableOutputSourceVars();

							field.outputSpecs.forEach((spec, specIdx) => {
								if (!spec) {
									return;
								}
								const isEnabled = spec.enabled ?? true;
								const row = append(specsContainer, $('.output-spec-row', {
									style: `display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; width: 100%; min-width: 0; box-sizing: border-box; overflow: hidden; background: ${isEnabled ? 'rgba(0, 122, 204, 0.08)' : 'rgba(255, 255, 255, 0.02)'}; border: 1px solid ${isEnabled ? 'rgba(0, 122, 204, 0.4)' : 'rgba(255, 255, 255, 0.08)'}; border-radius: 5px; transition: all 0.15s ease;`
								}));

								const topRow = append(row, $('div', {
									style: 'display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px 8px; width: 100%; min-width: 0; box-sizing: border-box;'
								}));

								const leftPart = append(topRow, $('div.custom-checkbox-wrapper', {
									style: 'display: flex; align-items: center; gap: 6px; flex: 1 1 160px; min-width: 0; max-width: 100%; flex-wrap: wrap; box-sizing: border-box;'
								}));

								// Custom checkbox box with system blue and balanced proportions
								const checkSquare = append(leftPart, $('div.custom-check-square', {
									style: `width: 14px; height: 14px; min-width: 14px; min-height: 14px; border-radius: 2.5px; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; cursor: pointer; transition: all 0.15s ease; ${isEnabled ? 'background: #007acc; border: 1px solid #007acc;' : 'background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.3);'}`
								}));

								const checkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
								checkSvg.setAttribute('width', '10');
								checkSvg.setAttribute('height', '10');
								checkSvg.setAttribute('viewBox', '0 0 16 16');
								checkSvg.setAttribute('fill', 'none');
								checkSvg.style.display = isEnabled ? 'block' : 'none';
								const checkPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
								checkPath.setAttribute('d', 'M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z');
								checkPath.setAttribute('fill', '#ffffff');
								checkSvg.appendChild(checkPath);
								checkSquare.appendChild(checkSvg);

								let labelSpan: HTMLElement | undefined;

								if (spec.isCustom) {
									// Editable Index Name (Field Label)
									const labelInput = append(leftPart, $('input.monaco-inputbox', {
										type: 'text',
										placeholder: 'Output Index Name (e.g. Matched Jobs)',
										value: spec.label || '',
										style: 'flex: 1 1 110px; min-width: 0; width: 100%; max-width: 100%; box-sizing: border-box; padding: 3px 8px; font-size: 12px; font-weight: 600; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.18); background: rgba(0, 0, 0, 0.32); color: var(--vscode-input-foreground); outline: none;'
									})) as HTMLInputElement;

									// Auto-generated / editable Python variable name pill
									const varWrap = append(leftPart, $('div', {
										style: 'display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 4px; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.32); flex: 1 1 95px; min-width: 0; max-width: 100%; box-sizing: border-box;',
										title: 'Auto-generated Python variable name (editable). Accessible both by Index Name and by this variable name.'
									}));
									append(varWrap, $('span', { style: 'font-size: 10px; font-weight: 700; color: #38bdf8; flex-shrink: 0;' }, '[V]'));
									const varInput = append(varWrap, $('input', {
										type: 'text',
										placeholder: 'var_name',
										value: spec.varName || generateSmartPythonVarName(spec.label || `output_${specIdx + 1}`),
										style: 'flex: 1; min-width: 0; width: 100%; font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); color: #bae6fd; background: transparent; border: none; outline: none; padding: 0;'
									})) as HTMLInputElement;

									labelInput.oninput = () => {
										spec.label = labelInput.value;
										if (!spec.varNameManual) {
											const autoVar = generateSmartPythonVarName(spec.label || `output_${specIdx + 1}`);
											spec.varName = autoVar;
											varInput.value = autoVar;
										}
										spec.fieldKey = spec.label.trim() || spec.varName || `output_${specIdx + 1}`;
										this._syncDraft();
									};

									varInput.oninput = () => {
										const cleaned = sanitizePythonVarName(varInput.value);
										if (!varInput.value.trim()) {
											spec.varNameManual = false;
											spec.varName = generateSmartPythonVarName(spec.label || `output_${specIdx + 1}`);
										} else {
											spec.varNameManual = true;
											spec.varName = cleaned;
										}
										if (!spec.label?.trim()) {
											spec.fieldKey = spec.varName || `output_${specIdx + 1}`;
										}
										this._syncDraft();
									};
								} else {
									labelSpan = append(leftPart, $('span', {
										style: `font-size: 12px; font-weight: ${isEnabled ? '600' : '500'}; color: ${isEnabled ? '#f8fafc' : '#94a3b8'}; cursor: pointer; user-select: none; transition: color 0.15s ease;`
									}, spec.label || spec.fieldKey || `Output ${specIdx + 1}`));
									const syncedVar = spec.varName || generateSmartPythonVarName(spec.label || spec.fieldKey);
									if (syncedVar) {
										append(leftPart, $('span', {
											style: 'font-size: 10.5px; font-family: var(--vscode-editor-font-family, monospace); color: #7dd3fc; background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.25); padding: 1px 6px; border-radius: 4px;'
										}, `[V] ${syncedVar}`));
									}
								}

								const updateCheckboxState = (checked: boolean) => {
									spec.enabled = checked;
									this._syncDraft();
									if (checked) {
										row.style.background = 'rgba(0, 122, 204, 0.08)';
										row.style.borderColor = 'rgba(0, 122, 204, 0.4)';
										checkSquare.style.background = '#007acc';
										checkSquare.style.borderColor = '#007acc';
										checkSvg.style.display = 'block';
										if (labelSpan) {
											labelSpan.style.color = '#f8fafc';
											labelSpan.style.fontWeight = '600';
										}
									} else {
										row.style.background = 'rgba(255, 255, 255, 0.02)';
										row.style.borderColor = 'rgba(255, 255, 255, 0.08)';
										checkSquare.style.background = 'rgba(0, 0, 0, 0.35)';
										checkSquare.style.borderColor = 'rgba(255, 255, 255, 0.3)';
										checkSvg.style.display = 'none';
										if (labelSpan) {
											labelSpan.style.color = '#94a3b8';
											labelSpan.style.fontWeight = '500';
										}
									}
								};

								const toggleCheck = (e: MouseEvent) => {
									e.preventDefault();
									e.stopPropagation();
									updateCheckboxState(!(spec.enabled ?? true));
								};
								checkSquare.onclick = toggleCheck;
								if (labelSpan) {
									labelSpan.onclick = toggleCheck;
								}

								checkSquare.onmouseenter = () => {
									if (!spec.enabled) {
										checkSquare.style.borderColor = '#007acc';
									}
								};
								checkSquare.onmouseleave = () => {
									if (!spec.enabled) {
										checkSquare.style.borderColor = 'rgba(255, 255, 255, 0.3)';
									}
								};

								const rightPart = append(topRow, $('div', { style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; max-width: 100%;' }));
								append(rightPart, $('span', { style: 'font-size: 10.5px; opacity: 0.65; white-space: nowrap;' }, 'Default View:'));
								const formatSelect = append(rightPart, $('select', {
									style: 'padding: 3px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.3); color: inherit; outline: none; cursor: pointer; transition: border-color 0.15s ease;'
								})) as HTMLSelectElement;

								formatSelect.onfocus = () => { formatSelect.style.borderColor = '#007acc'; };
								formatSelect.onblur = () => { formatSelect.style.borderColor = 'rgba(255, 255, 255, 0.15)'; };

								const formatOptions = [
									{ value: 'json', label: 'JSON' },
									{ value: 'table', label: 'Table' },
									{ value: 'markdown', label: 'Markdown' },
									{ value: 'text', label: 'Plain Text' }
								];

								const defaultFmt = spec.defaultFormat || (spec.isCustom ? 'json' : 'table');
								formatOptions.forEach(opt => {
									const optEl = document.createElement('option');
									optEl.value = opt.value;
									optEl.textContent = opt.label;
									if (defaultFmt === opt.value) {
										optEl.selected = true;
									}
									formatSelect.appendChild(optEl);
								});

								formatSelect.onchange = () => {
									spec.defaultFormat = formatSelect.value;
									this._syncDraft();
								};

								if (spec.isCustom) {
									const deleteSpecBtn = append(rightPart, $('button', {
										type: 'button',
										style: 'display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 4px; cursor: pointer; background: transparent; border: none; color: rgba(248, 113, 113, 0.8); padding: 0;',
										title: 'Remove this custom output'
									})) as HTMLButtonElement;
									append(deleteSpecBtn, $('span.codicon.codicon-trash', { style: 'font-size: 12px;' }));
									deleteSpecBtn.onclick = (e) => {
										e.preventDefault();
										e.stopPropagation();
										field.outputSpecs!.splice(specIdx, 1);
										this._syncDraft();
										void this._persistCurrentModule();
										renderSpecsList();
									};

									// Row 2: Source Variable / Value Binding Input + Quick-Pick Workflow Variable Chips
									const sourceRow = append(row, $('div', {
										style: 'display: flex; flex-direction: column; gap: 5px; width: 100%; min-width: 0; box-sizing: border-box;'
									}));

									const sourceInputWrap = append(sourceRow, $('div', {
										style: 'display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; width: 100%; min-width: 0; box-sizing: border-box;'
									}));
									append(sourceInputWrap, $('span', {
										style: 'font-size: 10.5px; color: rgba(255,255,255,0.62); white-space: nowrap; flex-shrink: 0;'
									}, 'Value / Variable:'));
									const sourceInput = append(sourceInputWrap, $('input.monaco-inputbox', {
										type: 'text',
										placeholder: 'Enter workflow variable (e.g. {existing_job_ds})',
										value: spec.sourceExpression || '',
										style: 'flex: 1 1 120px; min-width: 0; width: 100%; max-width: 100%; box-sizing: border-box; padding: 3px 8px; font-size: 11.5px; font-family: var(--vscode-editor-font-family, monospace); border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(0, 0, 0, 0.32); color: #e2e8f0; outline: none;'
									})) as HTMLInputElement;
									sourceInput.oninput = () => {
										spec.sourceExpression = sourceInput.value;
										this._syncDraft();
									};

									if (availableSourceVars.length > 0) {
										const chipsWrap = append(sourceRow, $('div', {
											style: 'display: flex; align-items: center; gap: 4px; flex-wrap: wrap;'
										}));
										append(chipsWrap, $('span', { style: 'font-size: 10px; opacity: 0.55; margin-right: 2px;' }, 'Bind var:'));
										for (const vName of availableSourceVars.slice(0, 16)) {
											const chipBtn = append(chipsWrap, $('button', {
												type: 'button',
												style: 'padding: 1px 6px; font-size: 10px; font-family: var(--vscode-editor-font-family, monospace); border-radius: 3px; cursor: pointer; background: rgba(129, 140, 248, 0.14); border: 1px solid rgba(129, 140, 248, 0.32); color: #c7d2fe;',
												title: `Bind {${vName}} as the exported value for this output`
											}, `{${vName}}`)) as HTMLButtonElement;
											chipBtn.onclick = (e) => {
												e.preventDefault();
												e.stopPropagation();
												spec.sourceExpression = `{${vName}}`;
												sourceInput.value = spec.sourceExpression;
												this._syncDraft();
											};
										}
									}
								}
							});
						} catch (err) {
							console.error('[OutputPrimitive] renderSpecsList error:', err);
							this.notificationService.error(`Render error: ${err}`);
						}
					};

					addOutputBtn.onclick = (e) => {
						e.preventDefault();
						e.stopPropagation();
						if (!Array.isArray(field.outputSpecs)) {
							field.outputSpecs = [];
						}
						const nextIdx = field.outputSpecs.filter(s => s?.isCustom).length + 1;
						const defaultLabel = `Output ${nextIdx}`;
						const defaultVar = generateSmartPythonVarName(defaultLabel);
						field.outputSpecs.push({
							fieldKey: defaultLabel,
							label: defaultLabel,
							varName: defaultVar,
							varNameManual: false,
							sourceExpression: '',
							enabled: true,
							defaultFormat: 'json',
							isCustom: true
						});
						renderSpecsList();
						this._syncDraft();
						void this._persistCurrentModule();
					};

					syncSpecsWithCanvas();
					renderSpecsList();
					referenceChipRefreshers.push(() => {
						syncSpecsWithCanvas();
						renderSpecsList();
					});

					syncBtn.onclick = (e) => {
						e.preventDefault();
						e.stopPropagation();
						syncSpecsWithCanvas();
						renderSpecsList();
						this._syncDraft();
						const count = field.outputSpecs?.length || 0;
						this.notificationService.info(`Synced ${count} output item(s) into Output Manifest.`);
					};

					// Last Execution Exported Outputs Box (Output Component)
					const outExecCard = append(outputBox, $('div.component-exec-logs-card', {
						style: 'display: flex; flex-direction: column; gap: 4px; margin-top: 4px; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(129, 140, 248, 0.25); border-radius: 5px; padding: 6px 8px;'
					}));
					const outExecHeader = append(outExecCard, $('div', {
						style: 'display: flex; justify-content: space-between; align-items: center; font-size: 10.5px; gap: 8px; flex-wrap: wrap;'
					}));
					const outExecTitle = append(outExecHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; font-weight: 600; color: #818cf8;'
					}));
					append(outExecTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.terminal)));
					append(outExecTitle, $('span', {}, 'LAST EXECUTION EXPORTED OUTPUTS'));
					const outExecRight = append(outExecHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-left: auto;'
					}));
					const outExecStatus = append(outExecRight, $('span', {
						style: 'font-size: 10px; font-family: var(--vscode-editor-font-family, monospace);'
					}));
					const updateOutExecStatus = () => {
						const st = (field as IRuntimeCustomField).lastExecutionStatus;
						if (st === 'success') {
							outExecStatus.textContent = `Completed in ${(field as IRuntimeCustomField).lastExecutionDurationMs ?? 0}ms${(field as IRuntimeCustomField).lastExecutedAt ? ` · ${(field as IRuntimeCustomField).lastExecutedAt}` : ''}`;
							outExecStatus.style.color = '#4ade80';
						} else if (st === 'failed') {
							outExecStatus.textContent = `Failed (${(field as IRuntimeCustomField).lastExecutionDurationMs ?? 0}ms)${(field as IRuntimeCustomField).lastExecutedAt ? ` · ${(field as IRuntimeCustomField).lastExecutedAt}` : ''}`;
							outExecStatus.style.color = '#f87171';
						} else {
							outExecStatus.textContent = '[Ready to execute]';
							outExecStatus.style.color = '#94a3b8';
						}
					};
					updateOutExecStatus();
					const outExecCopyBtn = append(outExecRight, $('button', {
						type: 'button',
						style: 'padding: 1px 6px; font-size: 10px; border-radius: 3px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05); color: inherit; cursor: pointer;'
					}, 'Copy'));
					const outExecClearBtn = append(outExecRight, $('button', {
						type: 'button',
						style: 'padding: 1px 6px; font-size: 10px; border-radius: 3px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05); color: inherit; cursor: pointer;'
					}, 'Clear'));
					const outExecPre = append(outExecCard, $('pre', {
						style: 'margin: 0; padding: 4px 6px; font-size: 11px; line-height: 1.45; font-family: var(--vscode-editor-font-family, monospace); color: #cbd5e1; min-height: 40px; max-height: 180px; overflow-y: auto; white-space: pre-wrap; word-break: break-word;'
					}));
					outExecPre.textContent = (field as IRuntimeCustomField).lastExecutionLog || '[Ready to execute] Exported output values will be recorded here when the workflow or node runs.';
					outExecCopyBtn.onclick = () => {
						const txt = (field as IRuntimeCustomField).lastExecutionLog || outExecPre.textContent || '';
						if (txt) {
							this._clipboardService.writeText(txt);
							this.notificationService.info('Output execution log copied to clipboard.');
						}
					};
					outExecClearBtn.onclick = async () => {
						delete (field as IRuntimeCustomField).lastExecutionLog;
						delete (field as IRuntimeCustomField).lastExecutionOutput;
						delete (field as IRuntimeCustomField).lastExecutionStatus;
						delete (field as IRuntimeCustomField).lastExecutionDurationMs;
						delete (field as IRuntimeCustomField).lastExecutedAt;
						updateOutExecStatus();
						outExecPre.textContent = '[Ready to execute] Exported output values will be recorded here when the workflow or node runs.';
						this._syncDraft();
						await this._persistCurrentModule();
					};
				}

				// Python Primitive Configuration Box
				if (field.type === 'python') {
					const pythonBox = append(fieldCard, $('.python-schema-config', {
						style: 'display: flex; flex-direction: column; gap: 12px; background: rgba(0, 0, 0, 0.2); padding: 12px 14px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.08);'
					}));

					const pythonNote = append(pythonBox, $('div', { style: 'font-size: 11px; opacity: 0.8; line-height: 1.4; color: inherit; display: flex; align-items: center; gap: 6px;' }));
					append(pythonNote, $('span' + ThemeIcon.asCSSSelector(Codicon.code)));
					append(pythonNote, $('span', {}, 'Python Code Automation & Scripting Primitive. Run local scripts with custom Python interpreters or virtual environments.'));

					// Python Interpreter / Virtualenv Row
					const interpRow = append(pythonBox, $('div', { style: 'display: flex; flex-direction: column; gap: 5px;' }));
					const interpTop = append(interpRow, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;' }));
					append(interpTop, $('label', { style: 'font-size: 11px; font-weight: 600; opacity: 0.85; color: inherit;' }, 'Python Interpreter / Virtualenv:'));
					append(interpTop, $('span', { style: 'font-size: 10px; opacity: 0.55;' }, 'Leave empty for auto-detection (.venv or python3)'));

					let initialPyPath = '';
					if (typeof field.pythonPath === 'string') {
						initialPyPath = field.pythonPath.trim();
					} else if (field.pythonPath && typeof field.pythonPath === 'object') {
						// Legacy YAML may store the interpreter as an object
						const legacyPyPath = field.pythonPath as { interpreterPath?: unknown; pythonPath?: unknown };
						initialPyPath = String(legacyPyPath.interpreterPath || legacyPyPath.pythonPath || '').trim();
					}
					if (initialPyPath === '[object Object]' || initialPyPath === 'undefined' || initialPyPath === 'null') {
						initialPyPath = '';
					}
					field.pythonPath = initialPyPath;

					const interpInputBar = append(interpRow, $('div', { style: 'display: flex; gap: 6px; align-items: center; flex-wrap: wrap;' }));
					const interpInput = append(interpInputBar, $('input.monaco-inputbox', {
						placeholder: 'Auto-detect (.venv or system python3) — or click Browse to select',
						style: 'flex: 1; min-width: 160px; padding: 6px 10px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.25); color: inherit; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace);'
					})) as HTMLInputElement;
					interpInput.value = initialPyPath;

					const browseBtn = append(interpInputBar, $('button', {
						style: 'padding: 5px 12px; font-size: 11px; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(255, 255, 255, 0.08); color: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;',
						title: 'Select Python Interpreter or Virtualenv Folder'
					}));
					append(browseBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.folder)));
					append(browseBtn, $('span', {}, 'Browse'));

					// Detection feedback & Actions row (Tier 2)
					const statusRow = append(interpRow, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 3px;' }));
					const statusBadge = append(statusRow, $('div', {
						style: 'font-size: 10.5px; display: inline-flex; align-items: center; gap: 6px; padding: 2.5px 8px; border-radius: 4px; background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.7); word-break: break-all;'
					}));

					const interpActions = append(statusRow, $('div', { style: 'display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-left: auto;' }));

					const testInterpBtn = append(interpActions, $('button', {
						style: 'padding: 3.5px 12px; font-size: 11px; font-weight: 500; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(255, 255, 255, 0.08); color: inherit; cursor: pointer; white-space: nowrap;',
						title: 'Test Python Interpreter and Verify Version'
					}, 'Test'));

					const venvCreateBtn = append(interpActions, $('button', {
						style: 'display: none; padding: 3.5px 12px; font-size: 11px; font-weight: 600; border-radius: 4px; border: 1px solid rgba(0, 122, 204, 0.4); background: rgba(0, 122, 204, 0.15); color: #38bdf8; cursor: pointer; white-space: nowrap;',
						title: 'Create a new virtual environment at this path via python3 -m venv'
					}, '+ Create Virtualenv'));

					const updateDetectionStatus = async () => {
						let currentVal = interpInput.value.trim();
						if (currentVal === '[object Object]' || currentVal === 'undefined' || currentVal === 'null') {
							currentVal = '';
							interpInput.value = '';
						}
						field.pythonPath = currentVal;
						this._syncDraft();

						const runtime = this._instantiationService.invokeFunction(accessor => {
							try { return accessor.get(ITicketWorkflowRuntimeService); } catch { return undefined; }
						});
						const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);

						if (!runtime || !wsUri) {
							statusBadge.textContent = currentVal ? `Path: ${currentVal}` : 'Default: System / Active .venv';
							statusBadge.style.color = 'rgba(255, 255, 255, 0.7)';
							statusBadge.style.background = 'rgba(255, 255, 255, 0.05)';
							statusBadge.style.border = 'none';
							venvCreateBtn.style.display = 'none';
							return;
						}

						try {
							const det = await runtime.detectPythonEnvironment(wsUri, currentVal);
							if (det.isValid) {
								venvCreateBtn.style.display = 'none';
								if (det.isVenv) {
									statusBadge.textContent = `✓ Virtualenv (${det.venvRoot || det.interpreterPath})`;
									statusBadge.style.color = '#4ade80';
									statusBadge.style.background = 'rgba(74, 222, 128, 0.12)';
									statusBadge.style.border = '1px solid rgba(74, 222, 128, 0.3)';
								} else {
									statusBadge.textContent = `✓ Interpreter (${det.interpreterPath})`;
									statusBadge.style.color = '#38bdf8';
									statusBadge.style.background = 'rgba(56, 189, 248, 0.12)';
									statusBadge.style.border = '1px solid rgba(56, 189, 248, 0.3)';
								}
							} else {
								statusBadge.textContent = `⚠ ${det.error || 'Virtual environment not found'}`;
								statusBadge.style.color = '#f87171';
								statusBadge.style.background = 'rgba(248, 113, 113, 0.12)';
								statusBadge.style.border = '1px solid rgba(248, 113, 113, 0.3)';
								venvCreateBtn.style.display = 'inline-block';
							}
						} catch {
							statusBadge.textContent = currentVal || 'Default: System / Active .venv';
							statusBadge.style.color = 'rgba(255, 255, 255, 0.7)';
							statusBadge.style.background = 'rgba(255, 255, 255, 0.05)';
							statusBadge.style.border = 'none';
							venvCreateBtn.style.display = 'none';
						}
					};

					interpInput.oninput = () => {
						updateDetectionStatus();
					};

					browseBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						try {
							const uris = await this._fileDialogService.showOpenDialog({
								canSelectFiles: true,
								canSelectFolders: true,
								canSelectMany: false,
								title: 'Select Python Interpreter or Virtualenv Folder'
							});
							if (uris && uris.length > 0) {
								const pickedUri = uris[0];
								const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);
								let finalPath = pickedUri.fsPath;
								if (wsUri && finalPath.startsWith(wsUri.fsPath)) {
									finalPath = finalPath.substring(wsUri.fsPath.length).replace(/^[/\\]+/, '');
								}
								interpInput.value = finalPath;
								await updateDetectionStatus();
							}
						} catch (err) {
							this.notificationService.error(`Failed to pick folder: ${(err as Error).message || err}`);
						}
					};

					testInterpBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						const runtime = this._instantiationService.invokeFunction(accessor => {
							try { return accessor.get(ITicketWorkflowRuntimeService); } catch { return undefined; }
						});
						const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);
						if (!runtime || !wsUri) {
							this.notificationService.warn('Workspace runtime not available for testing.');
							return;
						}
						testInterpBtn.setAttribute('disabled', 'true');
						testInterpBtn.textContent = 'Testing...';
						try {
							const res = await runtime.testPythonInterpreter(wsUri, interpInput.value.trim());
							if (res.success) {
								statusBadge.textContent = `${res.version} ✓`;
								statusBadge.style.color = '#4ade80';
								statusBadge.style.background = 'rgba(74, 222, 128, 0.12)';
								statusBadge.style.border = '1px solid rgba(74, 222, 128, 0.3)';
								this.notificationService.info(`Python interpreter verified: ${res.version}`);
							} else {
								statusBadge.textContent = 'Interpreter test failed \u2717';
								statusBadge.style.color = '#f87171';
								statusBadge.style.background = 'rgba(248, 113, 113, 0.12)';
								statusBadge.style.border = '1px solid rgba(248, 113, 113, 0.3)';
								this.notificationService.warn(`Test failed: ${res.error}`);
							}
						} catch (err) {
							this.notificationService.error(`Test error: ${(err as Error).message || err}`);
						} finally {
							testInterpBtn.removeAttribute('disabled');
							testInterpBtn.textContent = 'Test';
						}
					};

					venvCreateBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						const runtime = this._instantiationService.invokeFunction(accessor => {
							try { return accessor.get(ITicketWorkflowRuntimeService); } catch { return undefined; }
						});
						const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);
						if (!runtime || !wsUri) {
							this.notificationService.warn('Workspace runtime not available.');
							return;
						}
						venvCreateBtn.setAttribute('disabled', 'true');
						venvCreateBtn.textContent = 'Creating venv...';
						statusBadge.textContent = 'Initializing virtualenv via python3 -m venv... \u23F3';
						try {
							const targetName = interpInput.value.trim() || '.venv';
							const res = await runtime.createVirtualEnv(wsUri, targetName);
							if (res.success) {
								this.notificationService.info(`Virtualenv created at ${res.venvPath}`);
								if (!interpInput.value.trim()) {
									interpInput.value = '.venv';
								}
								await updateDetectionStatus();
							} else {
								this.notificationService.error(`Failed to create virtualenv: ${res.error}`);
							}
						} catch (err) {
							this.notificationService.error(`Creation error: ${(err as Error).message || err}`);
						} finally {
							venvCreateBtn.removeAttribute('disabled');
							venvCreateBtn.textContent = '+ Create Virtualenv';
						}
					};

					updateDetectionStatus();

					// External Scripts Pipeline Row
					if (!Array.isArray(field.externalScripts)) {
						field.externalScripts = [];
					}
					const scriptsRow = append(pythonBox, $('div', {
						style: 'display: flex; flex-direction: column; gap: 6px; background: rgba(0, 0, 0, 0.16); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; padding: 8px 10px;'
					}));
					const scriptsTop = append(scriptsRow, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;' }));
					const scriptsTitle = append(scriptsTop, $('div', { style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;' }));
					append(scriptsTitle, $('span', { style: 'font-size: 11px; font-weight: 600; opacity: 0.85;' }, 'External Python Scripts (Executed sequentially prior to inline code):'));

					const addScriptBtn = append(scriptsTop, $('button', {
						style: 'padding: 3px 10px; font-size: 10.5px; font-weight: 500; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(255, 255, 255, 0.08); color: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;',
						title: 'Select an external Python script file (.py) to execute in order'
					}));
					append(addScriptBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.add)));
					append(addScriptBtn, $('span', {}, 'Add Script File...'));

					const scriptsList = append(scriptsRow, $('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }));

					const renderScriptsList = () => {
						clearNode(scriptsList);
						const exts: string[] = field.externalScripts || [];
						if (exts.length === 0) {
							append(scriptsList, $('div', {
								style: 'font-size: 10.5px; opacity: 0.5; padding: 3px 4px; font-style: italic;'
							}, 'No external scripts configured. Executes inline source code only.'));
							return;
						}

						exts.forEach((scriptPath, idx) => {
							const item = append(scriptsList, $('div', {
								style: 'display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 4px 8px; border-radius: 4px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); font-size: 11px; font-family: var(--vscode-editor-font-family, monospace);'
							}));

							const left = append(item, $('div', { style: 'display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }));
							append(left, $('span', { style: 'opacity: 0.5; font-size: 10px; font-weight: 600;' }, `#${idx + 1}`));
							append(left, $('span' + ThemeIcon.asCSSSelector(Codicon.fileCode)));
							append(left, $('span', { style: 'color: inherit;', title: scriptPath }, scriptPath));

							const removeBtn = append(item, $('button', {
								style: 'padding: 2px 6px; font-size: 10px; border-radius: 3px; border: 1px solid rgba(255, 255, 255, 0.12); background: transparent; color: rgba(255, 255, 255, 0.6); cursor: pointer; display: inline-flex; align-items: center;',
								title: 'Remove this script from pipeline'
							}));
							append(removeBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
							removeBtn.onclick = (e) => {
								e.preventDefault();
								e.stopPropagation();
								field.externalScripts.splice(idx, 1);
								this._syncDraft();
								renderScriptsList();
							};
						});
					};

					addScriptBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						try {
							const uris = await this._fileDialogService.showOpenDialog({
								canSelectFiles: true,
								canSelectFolders: false,
								canSelectMany: true,
								filters: [{ name: 'Python Scripts', extensions: ['py'] }],
								title: 'Select External Python Script (.py)'
							});
							if (uris && uris.length > 0) {
								if (!Array.isArray(field.externalScripts)) {
									field.externalScripts = [];
								}
								const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);
								for (const u of uris) {
									let p = u.fsPath;
									if (wsUri && p.startsWith(wsUri.fsPath)) {
										p = p.substring(wsUri.fsPath.length).replace(/^[/\\]+/, '');
									}
									if (!field.externalScripts.includes(p)) {
										field.externalScripts.push(p);
									}
								}
								this._syncDraft();
								renderScriptsList();
							}
						} catch (err) {
							this.notificationService.error(`Failed to pick script: ${(err as Error).message || err}`);
						}
					};

					renderScriptsList();

					// Source Code Row
					const codeRow = append(pythonBox, $('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }));
					const codeTop = append(codeRow, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;' }));
					append(codeTop, $('label', { style: 'font-size: 11px; font-weight: 600; opacity: 0.85;' }, 'Source Code:'));
					const codeTopRight = append(codeTop, $('div', { style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;' }));
					append(codeTopRight, $('span', { style: 'font-size: 10px; opacity: 0.55; margin-right: 2px;' }, 'Supports {{variable}} interpolation'));

					const iconBtnStyle = 'display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 22px; padding: 0; border-radius: 4px; cursor: pointer; background: rgba(255, 255, 255, 0.07); color: inherit; border: 1px solid rgba(255, 255, 255, 0.16); user-select: none; -webkit-user-select: none; transition: all 0.15s ease;';

					const copyCodeBtn = append(codeTopRight, $('button.python-copy-code-btn', {
						type: 'button',
						style: iconBtnStyle,
						title: 'Copy entire Python Source Code'
					})) as HTMLButtonElement;
					const copyCodeIcon = append(copyCodeBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy), { style: 'font-size: 12px;' }));

					const pasteCodeBtn = append(codeTopRight, $('button.python-paste-code-btn', {
						type: 'button',
						style: iconBtnStyle,
						title: 'Paste clipboard content into Python Source Code'
					})) as HTMLButtonElement;
					const pasteCodeIcon = append(pasteCodeBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.clippy), { style: 'font-size: 12px;' }));

					const lockCodeBtn = append(codeTopRight, $('button.python-lock-code-btn', {
						type: 'button',
						style: iconBtnStyle,
						title: 'Lock / Unlock Python Source Code editor'
					})) as HTMLButtonElement;
					const lockCodeIcon = append(lockCodeBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.unlock), { style: 'font-size: 12px;' }));

					const codeWrapper = append(codeRow, $('div.python-code-wrapper', {
						style: 'display: flex; align-items: stretch; position: relative; width: 100%; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.28); box-sizing: border-box; overflow: hidden; transition: border-color 0.15s ease; user-select: none; -webkit-user-select: none;'
					}));

					const lineNumbersGutter = append(codeWrapper, $('div.python-line-numbers-gutter', {
						style: 'user-select: none !important; -webkit-user-select: none !important; pointer-events: none !important; color: rgba(255, 255, 255, 0.28); text-align: right; padding: 8px 8px 26px 6px; border-right: 1px solid rgba(255, 255, 255, 0.08); background: rgba(0, 0, 0, 0.18); font-size: 11px; font-family: var(--monaco-monospace-font, "SF Mono", Menlo, Monaco, Consolas, "Courier New", monospace); line-height: 18px; flex-shrink: 0; min-width: 32px; white-space: pre; overflow: hidden; box-sizing: border-box;'
					}));

					const codeStage = append(codeWrapper, $('div.python-code-stage', {
						style: 'position: relative; flex: 1; min-width: 0; min-height: 140px; display: block;'
					}));

					// Syntax Highlighted Backdrop Overlay (sizes the stage naturally; transparent textarea overlays 100% of it)
					const codeDisplay = append(codeStage, $('div.python-code-display', {
						style: 'position: relative; width: 100%; min-height: 140px; pointer-events: none !important; user-select: none !important; -webkit-user-select: none !important; overflow: hidden; padding: 8px 10px 26px 10px; margin: 0; border: none; font-size: 12px; font-family: var(--monaco-monospace-font, "SF Mono", Menlo, Monaco, Consolas, "Courier New", monospace); font-weight: 400; font-style: normal; font-variant-ligatures: none; letter-spacing: 0px; word-spacing: 0px; line-height: 18px; tab-size: 4; white-space: pre-wrap; word-break: break-all; overflow-wrap: break-word; color: #d4d4d4; box-sizing: border-box; z-index: 1;'
					}));

					const codeTextarea = append(codeStage, $('textarea.python-live-code-textarea', {
						rows: '6',
						spellcheck: 'false',
						autocapitalize: 'off',
						autocomplete: 'off',
						style: 'position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 2; display: block; width: 100%; height: 100%; min-height: 140px; max-height: none !important; overflow: hidden !important; padding: 8px 10px 26px 10px; margin: 0; font-size: 12px; font-family: var(--monaco-monospace-font, "SF Mono", Menlo, Monaco, Consolas, "Courier New", monospace); font-weight: 400; font-style: normal; font-variant-ligatures: none; letter-spacing: 0px; word-spacing: 0px; line-height: 18px; tab-size: 4; white-space: pre-wrap; word-break: break-all; overflow-wrap: break-word; border: none; outline: none; background: transparent !important; color: transparent !important; -webkit-text-fill-color: transparent !important; caret-color: #38bdf8 !important; resize: none !important; box-sizing: border-box; user-select: text !important; -webkit-user-select: text !important; pointer-events: auto !important; cursor: text;'
					})) as HTMLTextAreaElement;
					codeTextarea.value = (field.pythonCode || '').replace(/\r\n?/g, '\n');

					codeTextarea.addEventListener('mousedown', (e) => {
						fieldCard.setAttribute('draggable', 'false');
						e.stopPropagation();
					});
					codeTextarea.addEventListener('mouseup', (e) => {
						e.stopPropagation();
					});
					codeTextarea.addEventListener('click', (e) => {
						e.stopPropagation();
					});

					let isCodeLocked = Boolean((field as IRuntimeCustomField).pythonLocked);
					let isCodeEditing = false;

					const applyLockState = (locked: boolean) => {
						isCodeLocked = locked;
						(field as IRuntimeCustomField).pythonLocked = locked;
						codeTextarea.readOnly = locked;
						codeTextarea.style.cursor = locked ? 'default' : 'text';
						lockCodeIcon.className = ThemeIcon.asClassName(locked ? Codicon.lock : Codicon.unlock);
						lockCodeBtn.title = locked ? 'Editor is locked (Read-only) — click to unlock' : 'Editor is unlocked (Editable) — click to lock';
						if (locked) {
							lockCodeBtn.style.color = '#f59e0b';
							lockCodeBtn.style.borderColor = 'rgba(245, 158, 11, 0.45)';
							lockCodeBtn.style.background = 'rgba(245, 158, 11, 0.14)';
							codeWrapper.style.borderColor = 'rgba(245, 158, 11, 0.28)';
						} else {
							lockCodeBtn.style.color = 'inherit';
							lockCodeBtn.style.borderColor = 'rgba(255, 255, 255, 0.16)';
							lockCodeBtn.style.background = 'rgba(255, 255, 255, 0.07)';
							codeWrapper.style.borderColor = isCodeEditing ? 'rgba(56, 189, 248, 0.55)' : 'rgba(255, 255, 255, 0.15)';
						}
					};
					applyLockState(isCodeLocked);

					copyCodeBtn.onmousedown = (e) => {
						e.preventDefault();
						e.stopPropagation();
					};
					copyCodeBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						const rawCode = codeTextarea.value ?? '';
						await this._clipboardService.writeText(rawCode);
						copyCodeIcon.className = ThemeIcon.asClassName(Codicon.check);
						copyCodeBtn.style.color = '#34d399';
						copyCodeBtn.style.borderColor = 'rgba(52, 211, 153, 0.45)';
						copyCodeBtn.style.background = 'rgba(52, 211, 153, 0.14)';
						setTimeout(() => {
							copyCodeIcon.className = ThemeIcon.asClassName(Codicon.copy);
							copyCodeBtn.style.color = 'inherit';
							copyCodeBtn.style.borderColor = 'rgba(255, 255, 255, 0.16)';
							copyCodeBtn.style.background = 'rgba(255, 255, 255, 0.07)';
						}, 1400);
						this.notificationService.info('Copied Python source code to clipboard.');
					};

					const syncScrollPositions = () => {
						if (codeTextarea.scrollTop !== 0) {
							codeTextarea.scrollTop = 0;
						}
						if (codeTextarea.scrollLeft !== 0) {
							codeTextarea.scrollLeft = 0;
						}
						codeDisplay.scrollTop = 0;
						codeDisplay.scrollLeft = 0;
						lineNumbersGutter.scrollTop = 0;
					};

					const renderHighlightedCode = () => {
						const val = codeTextarea.value || '';
						lineNumbersGutter.textContent = buildPythonLineNumbersText(val);
						renderHighlightedPythonToDOM(codeDisplay, val, {
							showLineNumbers: false,
							isLiveBackdrop: true,
							placeholder: '# Enter Python automation script...'
						});
						syncScrollPositions();
					};

					let lastCodeSelectionStart: number | undefined = undefined;
					let lastCodeSelectionEnd: number | undefined = undefined;
					const recordCodeSelection = () => {
						if (typeof codeTextarea.selectionStart === 'number') {
							lastCodeSelectionStart = codeTextarea.selectionStart;
						}
						if (typeof codeTextarea.selectionEnd === 'number') {
							lastCodeSelectionEnd = codeTextarea.selectionEnd;
						}
					};
					codeTextarea.addEventListener('keyup', recordCodeSelection);
					codeTextarea.addEventListener('click', recordCodeSelection);
					codeTextarea.addEventListener('mouseup', recordCodeSelection);
					codeTextarea.addEventListener('select', recordCodeSelection);
					codeTextarea.addEventListener('input', recordCodeSelection);
					codeTextarea.addEventListener('scroll', syncScrollPositions);

					pasteCodeBtn.onmousedown = (e) => {
						e.preventDefault();
						e.stopPropagation();
						recordCodeSelection();
					};
					pasteCodeBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						if (isCodeLocked) {
							this.notificationService.warn('Python Source Code editor is locked. Unlock it first to paste.');
							return;
						}
						let clipText = '';
						try {
							clipText = await this._clipboardService.readText();
						} catch {
							clipText = '';
						}
						const normalizedClip = (clipText || '').replace(/\r\n?/g, '\n');
						const current = codeTextarea.value || '';
						const hasSelection = typeof lastCodeSelectionStart === 'number' && typeof lastCodeSelectionEnd === 'number' && lastCodeSelectionEnd > lastCodeSelectionStart;
						if (hasSelection) {
							const start = Math.min(current.length, Math.max(0, lastCodeSelectionStart!));
							const end = Math.min(current.length, Math.max(start, lastCodeSelectionEnd!));
							codeTextarea.value = current.substring(0, start) + normalizedClip + current.substring(end);
							const newCursor = start + normalizedClip.length;
							lastCodeSelectionStart = newCursor;
							lastCodeSelectionEnd = newCursor;
							codeTextarea.focus({ preventScroll: true });
							codeTextarea.setSelectionRange(newCursor, newCursor);
						} else {
							codeTextarea.value = normalizedClip;
							const newCursor = normalizedClip.length;
							lastCodeSelectionStart = newCursor;
							lastCodeSelectionEnd = newCursor;
							codeTextarea.focus({ preventScroll: true });
							codeTextarea.setSelectionRange(newCursor, newCursor);
						}
						field.pythonCode = codeTextarea.value;
						this._syncDraft();
						renderHighlightedCode();

						pasteCodeIcon.className = ThemeIcon.asClassName(Codicon.check);
						pasteCodeBtn.style.color = '#34d399';
						pasteCodeBtn.style.borderColor = 'rgba(52, 211, 153, 0.45)';
						pasteCodeBtn.style.background = 'rgba(52, 211, 153, 0.14)';
						setTimeout(() => {
							pasteCodeIcon.className = ThemeIcon.asClassName(Codicon.clippy);
							pasteCodeBtn.style.color = 'inherit';
							pasteCodeBtn.style.borderColor = 'rgba(255, 255, 255, 0.16)';
							pasteCodeBtn.style.background = 'rgba(255, 255, 255, 0.07)';
						}, 1400);
					};

					lockCodeBtn.onmousedown = (e) => {
						e.preventDefault();
						e.stopPropagation();
					};
					lockCodeBtn.onclick = (e) => {
						e.preventDefault();
						e.stopPropagation();
						applyLockState(!isCodeLocked);
						this._syncDraft();
					};

					codeWrapper.onmouseenter = () => {
						if (!isCodeEditing && !isCodeLocked) {
							codeWrapper.style.borderColor = 'rgba(56, 189, 248, 0.35)';
						}
					};
					codeWrapper.onmouseleave = () => {
						if (!isCodeEditing && !isCodeLocked) {
							codeWrapper.style.borderColor = 'rgba(255, 255, 255, 0.15)';
						}
					};

					codeTextarea.onfocus = () => {
						isCodeEditing = true;
						if (!isCodeLocked) {
							codeWrapper.style.borderColor = 'rgba(56, 189, 248, 0.55)';
						}
					};

					codeTextarea.onblur = () => {
						recordCodeSelection();
						isCodeEditing = false;
						codeWrapper.style.borderColor = isCodeLocked ? 'rgba(245, 158, 11, 0.28)' : 'rgba(255, 255, 255, 0.15)';
						field.pythonCode = codeTextarea.value;
						this._syncDraft();
						renderHighlightedCode();
					};

					codeTextarea.onkeydown = (e) => {
						if (isCodeLocked) {
							if (e.key === 'Escape') {
								codeTextarea.blur();
							}
							return;
						}
						if (isCommentKeybinding(e)) {
							e.preventDefault();
							e.stopPropagation();
							togglePythonComment(codeTextarea);
							recordCodeSelection();
							field.pythonCode = codeTextarea.value;
							this._syncDraft();
							renderHighlightedCode();
							return;
						}
						if (e.key === 'Tab') {
							e.preventDefault();
							const start = codeTextarea.selectionStart;
							const end = codeTextarea.selectionEnd;
							codeTextarea.value = codeTextarea.value.substring(0, start) + '    ' + codeTextarea.value.substring(end);
							codeTextarea.selectionStart = codeTextarea.selectionEnd = start + 4;
							recordCodeSelection();
							field.pythonCode = codeTextarea.value;
							this._syncDraft();
							renderHighlightedCode();
						} else if (e.key === 'Enter') {
							const start = codeTextarea.selectionStart;
							const end = codeTextarea.selectionEnd;
							const before = codeTextarea.value.substring(0, start);
							const lastNewline = before.lastIndexOf('\n');
							const currentLine = before.substring(lastNewline + 1);
							const indentMatch = currentLine.match(/^[ \t]*/);
							let indent = indentMatch ? indentMatch[0] : '';
							if (currentLine.trimEnd().endsWith(':')) {
								indent += '    ';
							}
							if (indent.length > 0) {
								e.preventDefault();
								const insertStr = '\n' + indent;
								codeTextarea.value = before + insertStr + codeTextarea.value.substring(end);
								codeTextarea.selectionStart = codeTextarea.selectionEnd = start + insertStr.length;
								recordCodeSelection();
								field.pythonCode = codeTextarea.value;
								this._syncDraft();
								renderHighlightedCode();
							}
						} else if (e.key === 'Escape') {
							codeTextarea.blur();
						}
					};
					codeTextarea.oninput = () => {
						field.pythonCode = codeTextarea.value;
						this._syncDraft();
						renderHighlightedCode();
					};

					renderHighlightedCode();

					// Context Variable Insert Bar under Source Code
					const varBar = append(codeRow, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 4px;'
					}));

					const insertTextAtCursor = (textToInsert: string, cursorOffsetFromEnd: number = 0) => {
						if (isCodeLocked) {
							this.notificationService.warn('Python Source Code editor is locked. Unlock it first to insert variables.');
							return;
						}
						const current = codeTextarea.value || '';
						const start = isCodeEditing && typeof codeTextarea.selectionStart === 'number'
							? codeTextarea.selectionStart
							: (typeof lastCodeSelectionStart === 'number' ? Math.min(current.length, Math.max(0, lastCodeSelectionStart)) : current.length);
						const end = isCodeEditing && typeof codeTextarea.selectionEnd === 'number'
							? codeTextarea.selectionEnd
							: (typeof lastCodeSelectionEnd === 'number' ? Math.min(current.length, Math.max(start, lastCodeSelectionEnd)) : start);
						const before = current.substring(0, start);
						const after = current.substring(end);
						codeTextarea.value = before + textToInsert + after;
						const newCursor = start + textToInsert.length + cursorOffsetFromEnd;
						lastCodeSelectionStart = newCursor;
						lastCodeSelectionEnd = newCursor;
						codeTextarea.focus({ preventScroll: true });
						codeTextarea.setSelectionRange(newCursor, newCursor);
						field.pythonCode = codeTextarea.value;
						this._syncDraft();
						renderHighlightedCode();
					};

					const chipStyle = 'padding: 2px 7px; font-size: 10.5px; font-weight: 500; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.3); background: rgba(56, 189, 248, 0.1); color: #38bdf8; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap;';
					let isPythonChipsExpanded = false;

					const renderPythonContextChips = () => {
						clearNode(varBar);
						append(varBar, $('span', { style: 'font-size: 10.5px; opacity: 0.65;' }, 'Insert Context:'));

						const baseChip = append(varBar, $('button', {
							type: 'button',
							style: chipStyle + ' font-weight: 600;',
							title: 'Insert TICKET_CONTEXT[\'\'] into script'
						}, '+ TICKET_CONTEXT[\'\']'));
						baseChip.onmousedown = (e) => {
							e.preventDefault();
							e.stopPropagation();
							recordCodeSelection();
						};
						baseChip.onclick = (e) => {
							e.preventDefault();
							e.stopPropagation();
							insertTextAtCursor('TICKET_CONTEXT[\'\']', -2);
						};

						const outputChip = append(varBar, $('button', {
							type: 'button',
							style: chipStyle + ' font-weight: 600; border-color: rgba(52, 211, 153, 0.4); background: rgba(52, 211, 153, 0.1); color: #34d399;',
							title: 'Insert return value assignment OUTPUT = ... (consumed by downstream primitives & Output Manifest)'
						}, '+ OUTPUT = '));
						outputChip.onmousedown = (e) => {
							e.preventDefault();
							e.stopPropagation();
							recordCodeSelection();
						};
						outputChip.onclick = (e) => {
							e.preventDefault();
							e.stopPropagation();
							insertTextAtCursor('\nOUTPUT = ');
						};

						const otherFields = fields.filter(f => f && f !== field && (!this._isFlowchartNodeMode || f.id !== 'title') && f.type !== 'output' && (f.label || f.id || '').toLowerCase() !== 'output' && (f.label || f.id || '').toLowerCase() !== 'result');
						const contextExpressions: string[] = [];
						otherFields.forEach(of => {
							const ofLabel = (of.label || of.id || '').trim();
							if (of.type === 'parameters' && Array.isArray(of.parameters)) {
								const paramGroupKey = ofLabel || 'Inputs';
								of.parameters.forEach(p => {
									const pName = (p.name || '').trim();
									if (pName) {
										if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(pName) && !contextExpressions.includes(pName)) {
											contextExpressions.push(pName);
										}
										const expr = `TICKET_CONTEXT['${paramGroupKey}']['${pName}']`;
										if (!contextExpressions.includes(expr)) {
											contextExpressions.push(expr);
										}
									}
								});
							}
							if (ofLabel && of.type !== 'parameters') {
								const outVar = (of.outputVariableName || '').trim() || generateSmartPythonVarName(ofLabel, of.type);
								if (outVar && !contextExpressions.includes(outVar)) {
									contextExpressions.push(outVar);
								}
								const expr = `TICKET_CONTEXT['${ofLabel}']`;
								if (!contextExpressions.includes(expr)) {
									contextExpressions.push(expr);
								}
							}
						});
						if (this.input instanceof CustomModuleSchemaEditorInput && typeof this.input.workflowVariablesProvider === 'function') {
							for (const wv of this.input.workflowVariablesProvider()) {
								if (wv.type === 'NODE') { continue; }
								const vName = (wv.label || '').trim();
								if (vName && vName !== (field.label || '').trim() && vName !== (field.outputVariableName || '').trim()) {
									if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(vName) && !contextExpressions.includes(vName)) {
										contextExpressions.push(vName);
									} else {
										const expr = `TICKET_CONTEXT['${vName}']`;
										if (!contextExpressions.includes(expr)) {
											contextExpressions.push(expr);
										}
									}
								}
							}
						}

						const maxInitialVisible = 2;
						const visibleExprs = contextExpressions.slice(0, maxInitialVisible);
						const hiddenExprs = contextExpressions.slice(maxInitialVisible);

						visibleExprs.forEach(expr => {
							const fieldChip = append(varBar, $('button', {
								type: 'button',
								style: chipStyle,
								title: `Insert ${expr}`
							}, `+ ${expr}`));
							fieldChip.onmousedown = (e) => {
								e.preventDefault();
								e.stopPropagation();
								recordCodeSelection();
							};
							fieldChip.onclick = (e) => {
								e.preventDefault();
								e.stopPropagation();
								insertTextAtCursor(expr);
							};
						});

						if (hiddenExprs.length > 0) {
							const hiddenContainer = append(varBar, $('span', {
								style: isPythonChipsExpanded ? 'display: contents;' : 'display: none;'
							}));

							hiddenExprs.forEach(expr => {
								const fieldChip = append(hiddenContainer, $('button', {
									type: 'button',
									style: chipStyle,
									title: `Insert ${expr}`
								}, `+ ${expr}`));
								fieldChip.onmousedown = (e) => {
									e.preventDefault();
									e.stopPropagation();
									recordCodeSelection();
								};
								fieldChip.onclick = (e) => {
									e.preventDefault();
									e.stopPropagation();
									insertTextAtCursor(expr);
								};
							});

							const moreBtn = append(varBar, $('button', {
								type: 'button',
								style: 'padding: 2px 8px; font-size: 10px; font-weight: 600; border-radius: 4px; border: 1px dashed rgba(56, 189, 248, 0.4); background: rgba(56, 189, 248, 0.06); color: #38bdf8; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; white-space: nowrap;',
								title: 'Toggle more context fields'
							}, isPythonChipsExpanded ? 'Less' : `+${hiddenExprs.length} More...`));

							moreBtn.onmousedown = (e) => {
								e.preventDefault();
								e.stopPropagation();
								recordCodeSelection();
							};
							moreBtn.onclick = (e) => {
								e.preventDefault();
								e.stopPropagation();
								isPythonChipsExpanded = !isPythonChipsExpanded;
								if (isPythonChipsExpanded) {
									hiddenContainer.style.display = 'contents';
									moreBtn.textContent = 'Less';
								} else {
									hiddenContainer.style.display = 'none';
									moreBtn.textContent = `+${hiddenExprs.length} More...`;
								}
							};
						}
					};

					renderPythonContextChips();
					referenceChipRefreshers.push(renderPythonContextChips);

					// DEBUG: Execution Output & Logs Preview Row
					const previewRow = append(pythonBox, $('div', { style: 'display: flex; flex-direction: column; gap: 6px;' }));
					const previewHeader = append(previewRow, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;' }));

					const previewHeaderLeft = append(previewHeader, $('div', { style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;' }));
					append(previewHeaderLeft, $('span', {
						style: 'font-size: 11px; font-weight: 600; opacity: 0.9; text-transform: uppercase; color: #94a3b8; white-space: nowrap;'
					}, this._isFlowchartNodeMode ? 'EXECUTION OUTPUT & LOGS:' : 'DEBUG: Execution Output & Logs Preview:'));
					append(previewHeaderLeft, $('span.python-debug-badge', {
						style: this._isFlowchartNodeMode
							? 'font-size: 9.5px; padding: 2px 6px; border-radius: 3px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); font-weight: 600; white-space: nowrap;'
							: 'font-size: 9.5px; padding: 2px 6px; border-radius: 3px; background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); font-weight: 600; white-space: nowrap;'
					}, this._isFlowchartNodeMode ? 'Node Runtime & Test' : 'Template Debug Only'));

					const previewActions = append(previewHeader, $('div', { style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-left: auto;' }));

					// View mode toggle pills
					let currentViewMode: 'all' | 'logs' | 'result' = 'all';
					const viewModePillGroup = append(previewActions, $('div', {
						style: 'display: inline-flex; align-items: center; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.25); padding: 1px;'
					}));
					const btnViewAll = append(viewModePillGroup, $('button', {
						type: 'button',
						style: 'padding: 2px 7px; font-size: 10px; border-radius: 3px; border: none; background: rgba(255, 255, 255, 0.14); color: #ffffff; cursor: pointer;',
						title: 'Show both Logs & Return Value'
					}, 'All'));
					const btnViewLogs = append(viewModePillGroup, $('button', {
						type: 'button',
						style: 'padding: 2px 7px; font-size: 10px; border-radius: 3px; border: none; background: transparent; color: rgba(255, 255, 255, 0.6); cursor: pointer;',
						title: 'Show only Console Logs & Execution Trace'
					}, 'Logs'));
					const btnViewResult = append(viewModePillGroup, $('button', {
						type: 'button',
						style: 'padding: 2px 7px; font-size: 10px; border-radius: 3px; border: none; background: transparent; color: rgba(255, 255, 255, 0.6); cursor: pointer;',
						title: 'Show only Return Value (OUTPUT)'
					}, 'Return Value'));

					const testRunBtn = append(previewActions, $('button', {
						style: 'padding: 3px 10px; font-size: 11px; font-weight: 600; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.35); background: rgba(56, 189, 248, 0.12); color: #38bdf8; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;',
						title: 'Run pipeline & script with current interpreter to test output'
					}));
					append(testRunBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.play)));
					append(testRunBtn, $('span', {}, 'Test'));

					const copyBtn = append(previewActions, $('button', {
						style: 'padding: 3px 8px; font-size: 10.5px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(255, 255, 255, 0.05); color: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;',
						title: 'Copy output to clipboard'
					}));
					append(copyBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy)));
					append(copyBtn, $('span', {}, 'Copy'));

					const clearBtn = append(previewActions, $('button', {
						style: 'padding: 3px 8px; font-size: 10.5px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(255, 255, 255, 0.05); color: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;',
						title: 'Clear output preview'
					}));
					append(clearBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.clearAll)));
					append(clearBtn, $('span', {}, 'Clear'));

					// Main preview container housing both Sections
					const previewContainer = append(previewRow, $('div', {
						style: 'display: flex; flex-direction: column; gap: 6px;'
					}));

					// 1. Pipeline & Console Logs Section
					const logsCard = append(previewContainer, $('div.python-debug-logs-card', {
						style: 'display: flex; flex-direction: column; gap: 4px; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 5px; padding: 6px 8px;'
					}));
					const logsHeader = append(logsCard, $('div', {
						style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 10.5px;'
					}));
					const logsTitle = append(logsHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; font-weight: 600; color: #94a3b8;'
					}));
					append(logsTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.terminal)));
					append(logsTitle, $('span', {}, 'CONSOLE LOGS & EXECUTION TRACE'));
					const logsHeaderRight = append(logsHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 8px; margin-left: auto;'
					}));
					const logsStatusBadge = append(logsHeaderRight, $('span.python-logs-status-badge', {
						style: 'font-size: 10px; opacity: 0.9; font-family: var(--vscode-editor-font-family, monospace);'
					}, '[Ready to execute]'));
					const copyLogsCardBtn = append(logsHeaderRight, $('button', {
						type: 'button',
						title: 'Copy complete Console Logs',
						style: 'display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; font-size: 10.5px; font-weight: 500; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.06); color: #cbd5e1; cursor: pointer;'
					})) as HTMLButtonElement;
					const copyLogsCardIcon = append(copyLogsCardBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy), { style: 'font-size: 11px;' }));
					const copyLogsCardLabel = append(copyLogsCardBtn, $('span', {}, 'Copy Logs'));
					if ((field as IRuntimeCustomField).lastExecutionStatus === 'success') {
						logsStatusBadge.textContent = `Completed in ${(field as IRuntimeCustomField).lastExecutionDurationMs ?? 0}ms (exit ${(field as IRuntimeCustomField).lastExecutionExitCode ?? 0})${(field as IRuntimeCustomField).lastExecutedAt ? ` · ${(field as IRuntimeCustomField).lastExecutedAt}` : ''}`;
						logsStatusBadge.style.color = '#4ade80';
					} else if ((field as IRuntimeCustomField).lastExecutionStatus === 'failed') {
						logsStatusBadge.textContent = `Failed (Exit code: ${(field as IRuntimeCustomField).lastExecutionExitCode ?? 1} | ${(field as IRuntimeCustomField).lastExecutionDurationMs ?? 0}ms)${(field as IRuntimeCustomField).lastExecutedAt ? ` · ${(field as IRuntimeCustomField).lastExecutedAt}` : ''}`;
						logsStatusBadge.style.color = '#f87171';
					} else if ((field as IRuntimeCustomField).lastExecutionStatus === 'skipped') {
						logsStatusBadge.textContent = 'Skipped (Disabled)';
						logsStatusBadge.style.color = '#94a3b8';
					} else if (field.pythonOutput) {
						logsStatusBadge.textContent = 'Recorded Output';
						logsStatusBadge.style.color = '#4ade80';
					}
					const logsDisplayBox = append(logsCard, $('pre.python-debug-logs-display', {
						'data-selectable-box': 'true',
						style: 'margin: 0; padding: 4px 6px; font-size: 11px; line-height: 1.45; font-family: var(--vscode-editor-font-family, monospace); color: #cbd5e1; min-height: 48px; max-height: 200px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; user-select: text; -webkit-user-select: text; cursor: text;'
					}));
					logsDisplayBox.textContent = field.pythonOutput || (field as IRuntimeCustomField).lastExecutionLog || '[Ready to execute] Output, stdout/stderr, and pipeline steps will appear here when run.';
					copyLogsCardBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						const rawLogs = field.pythonOutput || (field as IRuntimeCustomField).lastExecutionLog || logsDisplayBox.textContent || '';
						if (!rawLogs || rawLogs.startsWith('[Ready to execute]')) {
							this.notificationService.warn('No console logs to copy.');
							return;
						}
						await this._clipboardService.writeText(String(rawLogs));
						copyLogsCardIcon.className = ThemeIcon.asClassName(Codicon.check);
						copyLogsCardBtn.style.color = '#4ade80';
						copyLogsCardLabel.textContent = 'Copied!';
						this.notificationService.info('Complete Console Logs copied to clipboard.');
						setTimeout(() => {
							if (copyLogsCardBtn.isConnected) {
								copyLogsCardIcon.className = ThemeIcon.asClassName(Codicon.copy);
								copyLogsCardBtn.style.color = '#cbd5e1';
								copyLogsCardLabel.textContent = 'Copy Logs';
							}
						}, 1500);
					};

					// 2. Return Value (OUTPUT) Section
					const resultCard = append(previewContainer, $('div.python-debug-result-card', {
						style: 'display: none; flex-direction: column; gap: 4px; background: rgba(56, 189, 248, 0.04); border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 5px; padding: 6px 8px;'
					}));
					const resultHeader = append(resultCard, $('div', {
						style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 10.5px;'
					}));
					const resultTitle = append(resultHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; font-weight: 700; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.5px;'
					}));
					append(resultTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.output)));
					append(resultTitle, $('span', {}, 'RETURN VALUE (OUTPUT)'));
					const resultHeaderRight = append(resultHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 8px; margin-left: auto;'
					}));
					append(resultHeaderRight, $('span', {
						style: 'font-size: 9.5px; opacity: 0.7; color: #38bdf8;'
					}, 'Payload for Output Manifest & Downstream Primitives'));
					const copyResultCardBtn = append(resultHeaderRight, $('button.python-copy-result-card-btn', {
						type: 'button',
						title: 'Copy pure Return Value (OUTPUT) raw data only',
						style: 'display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; font-size: 10.5px; font-weight: 600; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.45); background: rgba(56, 189, 248, 0.14); color: #7dd3fc; cursor: pointer;'
					})) as HTMLButtonElement;
					const copyResultCardIcon = append(copyResultCardBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy), { style: 'font-size: 11px;' }));
					const copyResultCardLabel = append(copyResultCardBtn, $('span', {}, 'Copy Output'));
					const resultDisplayBox = append(resultCard, $('pre.python-debug-result-display', {
						'data-selectable-box': 'true',
						style: 'margin: 0; padding: 4px 6px; font-size: 11px; line-height: 1.45; font-family: var(--vscode-editor-font-family, monospace); color: #e0f2fe; min-height: 40px; max-height: 180px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; user-select: text; -webkit-user-select: text; cursor: text;'
					}));
					copyResultCardBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						const rawResult = field.pythonResult !== undefined
							? (typeof field.pythonResult === 'object' && field.pythonResult !== null
								? JSON.stringify(field.pythonResult, null, 2)
								: String(field.pythonResult))
							: (resultDisplayBox.textContent || '');
						if (!rawResult) {
							this.notificationService.warn('No Python Output to copy.');
							return;
						}
						await this._clipboardService.writeText(rawResult);
						copyResultCardIcon.className = ThemeIcon.asClassName(Codicon.check);
						copyResultCardBtn.style.color = '#4ade80';
						copyResultCardBtn.style.borderColor = 'rgba(74, 222, 128, 0.5)';
						copyResultCardLabel.textContent = 'Copied!';
						this.notificationService.info('Complete Python Output copied to clipboard.');
						setTimeout(() => {
							if (copyResultCardBtn.isConnected) {
								copyResultCardIcon.className = ThemeIcon.asClassName(Codicon.copy);
								copyResultCardBtn.style.color = '#7dd3fc';
								copyResultCardBtn.style.borderColor = 'rgba(56, 189, 248, 0.45)';
								copyResultCardLabel.textContent = 'Copy Output';
							}
						}, 1500);
					};

					const updateViewMode = (mode: 'all' | 'logs' | 'result') => {
						currentViewMode = mode;
						const activeBg = 'rgba(255, 255, 255, 0.14)';
						const activeColor = '#ffffff';
						const inactiveBg = 'transparent';
						const inactiveColor = 'rgba(255, 255, 255, 0.6)';

						btnViewAll.style.background = mode === 'all' ? activeBg : inactiveBg;
						btnViewAll.style.color = mode === 'all' ? activeColor : inactiveColor;
						btnViewLogs.style.background = mode === 'logs' ? activeBg : inactiveBg;
						btnViewLogs.style.color = mode === 'logs' ? activeColor : inactiveColor;
						btnViewResult.style.background = mode === 'result' ? activeBg : inactiveBg;
						btnViewResult.style.color = mode === 'result' ? activeColor : inactiveColor;

						const hasResult = field.pythonResult !== undefined;
						if (mode === 'all') {
							logsCard.style.display = 'flex';
							resultCard.style.display = hasResult ? 'flex' : 'none';
						} else if (mode === 'logs') {
							logsCard.style.display = 'flex';
							resultCard.style.display = 'none';
						} else if (mode === 'result') {
							logsCard.style.display = 'none';
							resultCard.style.display = hasResult ? 'flex' : 'none';
						}
					};

					btnViewAll.onclick = (e) => { e.preventDefault(); e.stopPropagation(); updateViewMode('all'); };
					btnViewLogs.onclick = (e) => { e.preventDefault(); e.stopPropagation(); updateViewMode('logs'); };
					btnViewResult.onclick = (e) => { e.preventDefault(); e.stopPropagation(); updateViewMode('result'); };

					if (field.pythonResult !== undefined) {
						resultDisplayBox.textContent = typeof field.pythonResult === 'object'
							? JSON.stringify(field.pythonResult, null, 2)
							: String(field.pythonResult);
						resultCard.style.display = 'flex';
					}

					testRunBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						const runtime = this._instantiationService.invokeFunction(accessor => {
							try { return accessor.get(ITicketWorkflowRuntimeService); } catch { return undefined; }
						});
						const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);
						if (!runtime || !wsUri) {
							this.notificationService.warn('Workspace runtime not available for execution.');
							return;
						}
						testRunBtn.setAttribute('disabled', 'true');
						testRunBtn.style.opacity = '0.6';
						logsStatusBadge.textContent = 'Running...';
						logsStatusBadge.style.color = '#38bdf8';
						logsDisplayBox.textContent = '[Executing script pipeline...] Running external scripts and inline code in background terminal...';
						resultCard.style.display = 'none';
						try {
							const scriptCode = codeTextarea.value;

							// Gather full schema context from workflow runtime variables + preceding and static fields
							const schemaContext: Record<string, unknown> = { ...(await this._getHydratedWorkflowRuntimeContext()) };
							const allFieldsToGather = fields || this._activeModule?.fields || [];
							for (const f of allFieldsToGather) {
								if (!f || f === field) { continue; }
								const fKey = f.label || f.id;
								const hasRecordedOutput = (f as IRuntimeCustomField).lastExecutionOutput !== undefined;
								let val: unknown = undefined;
								if (f.type === 'parameters' && f.parameters) {
									const pMap: Record<string, unknown> = {};
									f.parameters.forEach(p => {
										if (p.name) {
											const rawDef = p.defaultValue ?? '';
											const singleBrace = typeof rawDef === 'string' ? rawDef.trim().match(/^\{\{?([^{}]+)\}?\}$/) : null;
											if (singleBrace && schemaContext[singleBrace[1].trim()] !== undefined) {
												pMap[p.name] = schemaContext[singleBrace[1].trim()];
											} else if (rawDef === '' && schemaContext[p.name] !== undefined) {
												pMap[p.name] = schemaContext[p.name];
											} else {
												pMap[p.name] = this._parseInputStringLiteral(rawDef);
											}
											schemaContext[p.name] = pMap[p.name];
										}
									});
									val = pMap;
									schemaContext['Parameters'] = pMap;
									schemaContext['Inputs'] = pMap;
								} else if (hasRecordedOutput && f.type !== 'table') {
									// Preserve exact native data type (dict, list, number, bool, null, string) from lastExecutionOutput
									val = (f as IRuntimeCustomField).lastExecutionOutput;
								} else if (f.type === 'browser') {
									val = f.defaultContent || f.defaultUrl || '';
								} else if (f.type === 'http_request') {
									val = f.httpResponseData || f.httpResponseBody || '';
								} else if (f.type === 'prompt') {
									val = f.debugPromptOutput || f.defaultContent || '';
								} else if (f.type === 'python') {
									val = f.pythonResult !== undefined ? f.pythonResult : (f.pythonOutput || f.pythonCode || '');
								} else if (f.type === 'table') {
									val = {
										output: f.debugSqlOutput || '',
										sqlOutput: f.debugSqlOutput || '',
										columns: f.tableColumns || [],
										rows: f.tableRows || [],
										dbPath: f.tableDbPath || '',
										tableName: f.tableDbTableName || ''
									};
								} else if (f.type === 'git') {
									val = f.gitRemoteUrl || '';
								} else if (['create_tickets', 'run_tickets', 'get_outputs', 'get_ticket', 'get_tickets', 'display', 'sub_workflow'].includes(f.type)) {
									// Do not clobber existing live runtime value in schemaContext with '' if this card hasn't recorded lastExecutionOutput yet
									val = undefined;
								} else {
									val = f.defaultContent || f.defaultValue || '';
								}
								if (val !== undefined) {
									schemaContext[fKey] = val;
									if (f.outputVariableName) {
										schemaContext[f.outputVariableName] = val;
									}
									if (f.id && f.id !== fKey) {
										schemaContext[f.id] = val;
									}
									if (f.label && f.label !== fKey) {
										schemaContext[f.label] = val;
									}
								}
							}
							if (this._activeModule?.name) {
								schemaContext['Title'] = this._activeModule.name;
							}

							const extScripts = Array.isArray(field.externalScripts) ? [...field.externalScripts] : [];
							const res = await runtime.executePythonScript(wsUri, wsUri, interpInput.value.trim(), scriptCode, schemaContext, extScripts);
							const durationStr = `${res.durationMs}ms`;
							const exitCodeStr = `Exit code: ${res.exitCode}`;

							const nowStr = new Date().toLocaleTimeString();
							(field as IRuntimeCustomField).lastExecutionStatus = res.success ? 'success' : 'failed';
							(field as IRuntimeCustomField).lastExecutionDurationMs = res.durationMs;
							(field as IRuntimeCustomField).lastExecutionExitCode = res.exitCode;
							(field as IRuntimeCustomField).lastExecutedAt = nowStr;

							logsStatusBadge.textContent = res.success
								? `Completed in ${durationStr} (exit 0) · ${nowStr}`
								: `Failed (${exitCodeStr} | ${durationStr}) · ${nowStr}`;
							logsStatusBadge.style.color = res.success ? '#4ade80' : '#f87171';

							logsDisplayBox.textContent = res.output ? res.output : '(Script pipeline completed with no stdout/stderr output)';

							if (res.result !== undefined) {
								resultDisplayBox.textContent = typeof res.result === 'object'
									? JSON.stringify(res.result, null, 2)
									: String(res.result);
								field.pythonResult = res.result;
							} else {
								field.pythonResult = undefined;
							}

							field.pythonOutput = res.output;
							(field as IRuntimeCustomField).lastExecutionLog = field.pythonOutput;
							if (res.success) {
								(field as IRuntimeCustomField).lastExecutionOutput = res.result !== undefined ? res.result : res.output;
							}
							updateViewMode(currentViewMode);

							refreshAllReferenceChipBars();
							this._syncDraft();
							await this._persistCurrentModule();
							if (res.success) {
								this.notificationService.info(`Script pipeline executed successfully (${durationStr})`);
							} else {
								this.notificationService.warn(`Script pipeline finished with exit code ${res.exitCode}`);
							}
						} catch (err) {
							logsStatusBadge.textContent = 'Error';
							logsStatusBadge.style.color = '#f87171';
							logsDisplayBox.textContent = `[Execution error]: ${(err as Error).message || err}`;
							this.notificationService.error(`Execution error: ${(err as Error).message || err}`);
						} finally {
							testRunBtn.removeAttribute('disabled');
							testRunBtn.style.opacity = '1';
						}
					};

					copyBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						let textToCopy = '';
						if (currentViewMode === 'result') {
							textToCopy = resultDisplayBox.textContent || '';
						} else if (currentViewMode === 'logs') {
							textToCopy = logsDisplayBox.textContent || '';
						} else {
							const logs = logsDisplayBox.textContent || '';
							const result = field.pythonResult !== undefined ? (resultDisplayBox.textContent || '') : '';
							textToCopy = result
								? `=== CONSOLE LOGS & EXECUTION TRACE ===\n${logs}\n\n=== RETURN VALUE (OUTPUT) ===\n${result}`
								: logs;
						}
						if (!textToCopy) { return; }
						try {
							await this._clipboardService.writeText(textToCopy);
							this.notificationService.info('Output copied to clipboard.');
						} catch {
							this.notificationService.warn('Could not copy output to clipboard.');
						}
					};

					clearBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						logsDisplayBox.textContent = '[Ready to execute] Output, stdout/stderr, and pipeline steps will appear here when run.';
						logsStatusBadge.textContent = '[Cleared]';
						logsStatusBadge.style.color = '';
						resultDisplayBox.textContent = '';
						field.pythonOutput = '';
						field.pythonResult = undefined;
						delete (field as IRuntimeCustomField).lastExecutionLog;
						delete (field as IRuntimeCustomField).lastExecutionOutput;
						delete (field as IRuntimeCustomField).lastExecutionStatus;
						delete (field as IRuntimeCustomField).lastExecutionDurationMs;
						delete (field as IRuntimeCustomField).lastExecutionExitCode;
						delete (field as IRuntimeCustomField).lastExecutedAt;
						resultCard.style.display = 'none';
						this._syncDraft();
						await this._persistCurrentModule();
					};
				}

				if (field.type === 'http_request') {
					field.httpMethod = (field.httpMethod || 'GET').toUpperCase();
					field.httpUrl = field.httpUrl || '';
					field.httpAuthType = field.httpAuthType || 'none';
					field.httpBodyType = field.httpBodyType || 'none';
					field.httpBodyContent = field.httpBodyContent || '';
					field.httpHeaders = Array.isArray(field.httpHeaders) ? field.httpHeaders : [{ key: 'Accept', value: 'application/json', enabled: true }];
					field.httpParams = Array.isArray(field.httpParams) ? field.httpParams : [];
					field.httpTimeoutMs = typeof field.httpTimeoutMs === 'number' && field.httpTimeoutMs > 0 ? field.httpTimeoutMs : 30000;

					const httpBox = append(fieldCard, $('.http-request-schema-config', {
						style: 'display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; background: rgba(6, 182, 212, 0.04); border: 1px solid rgba(6, 182, 212, 0.28); border-radius: 6px; margin-top: 4px; width: 100%; box-sizing: border-box;'
					}));

					// Method color helper
					const getMethodColor = (m: string) => {
						const norm = (m || 'GET').toUpperCase();
						if (norm === 'GET') { return '#10b981'; }
						if (norm === 'POST') { return '#3b82f6'; }
						if (norm === 'PUT') { return '#f59e0b'; }
						if (norm === 'PATCH') { return '#f97316'; }
						if (norm === 'DELETE') { return '#ef4444'; }
						return '#8b5cf6';
					};

					// 1. Top URL & Method & Test Action Bar
					const topRow = append(httpBox, $('div', {
						style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap; width: 100%;'
					}));

					// Method Selector Dropdown
					const methodSelect = append(topRow, $('select.monaco-select-box', {
						style: `padding: 5px 8px; font-size: 11.5px; font-weight: 700; border-radius: 4px; border: 1px solid rgba(6, 182, 212, 0.5); background: rgba(0, 0, 0, 0.3); color: ${getMethodColor(field.httpMethod)}; cursor: pointer; outline: none; font-family: var(--vscode-editor-font-family, monospace); min-width: 90px;`
					})) as HTMLSelectElement;

					const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
					methods.forEach(m => {
						const opt = append(methodSelect, $('option', { value: m }, m)) as HTMLOptionElement;
						if (m === field.httpMethod) { opt.selected = true; }
					});

					// URL Input
					const urlWrapper = append(topRow, $('div', {
						style: 'flex: 1 1 280px; display: flex; align-items: center; position: relative; min-width: 200px;'
					}));

					const urlInput = append(urlWrapper, $('input.monaco-inputbox', {
						type: 'text',
						placeholder: 'e.g. https://api.example.com/v1/items or {api_url}',
						value: field.httpUrl || '',
						style: 'width: 100%; padding: 5px 9px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(0, 0, 0, 0.25); color: inherit; font-family: var(--vscode-editor-font-family, monospace); outline: none;'
					})) as HTMLInputElement;

					urlInput.oninput = () => {
						field.httpUrl = urlInput.value;
						this._syncDraft();
					};

					// Test / Send Request Button
					const sendBtn = append(topRow, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 5px 12px; font-size: 11px; font-weight: 600; border-radius: 4px; cursor: pointer; background: rgba(6, 182, 212, 0.18); border: 1px solid rgba(6, 182, 212, 0.45); color: #06b6d4; display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;',
						title: 'Send test HTTP request and inspect live response'
					})) as HTMLButtonElement;
					const sendIcon = append(sendBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.play), { style: 'font-size: 11px;' }));
					const sendBtnLabel = append(sendBtn, $('span', {}, 'Send Request'));

					// Status pill in header
					const statusPill = append(topRow, $('span', {
						style: 'font-size: 10.5px; font-weight: 600; padding: 3px 8px; border-radius: 10px; background: rgba(255, 255, 255, 0.06); color: #94a3b8; border: 1px solid rgba(255, 255, 255, 0.12); font-family: var(--vscode-editor-font-family, monospace); display: none;'
					}));

					const updateStatusPill = () => {
						if (field.httpResponseStatus !== undefined && field.httpResponseStatus > 0) {
							statusPill.style.display = 'inline-block';
							const ok = field.httpResponseStatus >= 200 && field.httpResponseStatus < 300;
							statusPill.textContent = `${field.httpResponseStatus} ${field.httpResponseStatusText || ''}${field.httpLastDurationMs ? ` · ${field.httpLastDurationMs}ms` : ''}`;
							statusPill.style.color = ok ? '#10b981' : (field.httpResponseStatus >= 400 && field.httpResponseStatus < 500 ? '#f59e0b' : '#ef4444');
							statusPill.style.background = ok ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)';
							statusPill.style.borderColor = ok ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)';
						}
					};
					updateStatusPill();

					// 2. Sub-Tabs Bar (Params, Headers, Auth, Body, Response)
					let activeTab = (field.httpMethod === 'POST' || field.httpMethod === 'PUT' || field.httpMethod === 'PATCH') ? 'body' : 'params';

					const tabsRow = append(httpBox, $('div', {
						style: 'display: flex; gap: 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.12); padding-bottom: 2px; margin-top: 4px; flex-wrap: wrap;'
					}));

					const tabPanelsContainer = append(httpBox, $('div', {
						style: 'display: flex; flex-direction: column; gap: 8px;'
					}));

					const paramsPanel = append(tabPanelsContainer, $('div'));
					const headersPanel = append(tabPanelsContainer, $('div'));
					const authPanel = append(tabPanelsContainer, $('div'));
					const bodyPanel = append(tabPanelsContainer, $('div'));
					const responsePanel = append(tabPanelsContainer, $('div'));

					const tabBtns: Record<string, HTMLElement> = {};

					const renderTabNav = () => {
						clearNode(tabsRow);
						const tabs = [
							{ id: 'params', label: `Params (${field.httpParams?.filter(p => p.enabled !== false && p.key).length || 0})` },
							{ id: 'headers', label: `Headers (${field.httpHeaders?.filter(h => h.enabled !== false && h.key).length || 0})` },
							{ id: 'auth', label: `Auth: ${(field.httpAuthType || 'none').toUpperCase()}` },
							{ id: 'body', label: `Body: ${(field.httpBodyType || 'none').toUpperCase()}` },
							{ id: 'response', label: field.httpResponseStatus ? `Response (${field.httpResponseStatus})` : 'Response' }
						];

						tabs.forEach(t => {
							const isActive = activeTab === t.id;
							const btn = append(tabsRow, $('button.tab-nav-btn', {
								type: 'button',
								style: `padding: 4px 10px; font-size: 11px; font-weight: ${isActive ? '700' : '500'}; border-radius: 4px; cursor: pointer; border: 1px solid ${isActive ? 'rgba(6, 182, 212, 0.45)' : 'transparent'}; background: ${isActive ? 'rgba(6, 182, 212, 0.15)' : 'transparent'}; color: ${isActive ? '#06b6d4' : '#94a3b8'}; transition: all 0.15s ease;`
							}, t.label));
							tabBtns[t.id] = btn;
							btn.onclick = () => {
								activeTab = t.id;
								updateTabVisibility();
								renderTabNav();
							};
						});
					};

					const updateTabVisibility = () => {
						paramsPanel.style.display = activeTab === 'params' ? 'flex' : 'none';
						headersPanel.style.display = activeTab === 'headers' ? 'flex' : 'none';
						authPanel.style.display = activeTab === 'auth' ? 'flex' : 'none';
						bodyPanel.style.display = activeTab === 'body' ? 'flex' : 'none';
						responsePanel.style.display = activeTab === 'response' ? 'flex' : 'none';
					};

					methodSelect.onchange = () => {
						field.httpMethod = methodSelect.value;
						methodSelect.style.color = getMethodColor(field.httpMethod);
						if (['POST', 'PUT', 'PATCH'].includes(field.httpMethod) && (!field.httpBodyType || field.httpBodyType === 'none')) {
							field.httpBodyType = 'json';
							activeTab = 'body';
						}
						renderTabNav();
						updateTabVisibility();
						renderBodyPanel();
						this._syncDraft();
					};

					// 2.1 Params Panel Rendering
					const renderParamsPanel = () => {
						clearNode(paramsPanel);
						paramsPanel.style.flexDirection = 'column';
						paramsPanel.style.gap = '6px';

						const pHeader = append(paramsPanel, $('div', {
							style: 'display: flex; justify-content: space-between; align-items: center;'
						}));
						append(pHeader, $('div', { style: 'font-size: 10.5px; opacity: 0.7;' }, 'URL Query Parameters (supports dynamic {variables}):'));

						const addPBtn = append(pHeader, $('button.monaco-button', {
							type: 'button',
							style: 'padding: 2px 7px; font-size: 10.5px; cursor: pointer; background: transparent; border: 1px solid rgba(6, 182, 212, 0.35); color: #06b6d4; border-radius: 3px;'
						}, '+ Add Param'));

						addPBtn.onclick = () => {
							field.httpParams = field.httpParams || [];
							field.httpParams.push({ id: `p_${Date.now()}`, key: '', value: '', enabled: true });
							renderParamsPanel();
							renderTabNav();
							this._syncDraft();
						};

						const pList = field.httpParams || [];
						if (pList.length === 0) {
							append(paramsPanel, $('div', {
								style: 'font-size: 11px; opacity: 0.5; padding: 6px 0; font-style: italic;'
							}, 'No query parameters configured.'));
						} else {
							pList.forEach((param, pIdx) => {
								const row = append(paramsPanel, $('div', {
									style: 'display: flex; align-items: center; gap: 6px; width: 100%;'
								}));
								const chk = append(row, $('input', {
									type: 'checkbox',
									style: 'cursor: pointer;',
									title: 'Enable or disable this parameter'
								})) as HTMLInputElement;
								chk.checked = param.enabled !== false;
								chk.onchange = () => {
									param.enabled = chk.checked;
									renderTabNav();
									this._syncDraft();
								};

								const kIn = append(row, $('input.monaco-inputbox', {
									placeholder: 'Parameter Key',
									value: param.key || '',
									style: 'flex: 1 1 120px; padding: 3px 6px; font-size: 11px; border-radius: 3px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.2); color: inherit; font-family: var(--vscode-editor-font-family, monospace);'
								})) as HTMLInputElement;
								kIn.oninput = () => {
									param.key = kIn.value;
									renderTabNav();
									this._syncDraft();
								};

								const vIn = append(row, $('input.monaco-inputbox', {
									placeholder: 'Parameter Value (e.g. {search})',
									value: param.value || '',
									style: 'flex: 2 1 180px; padding: 3px 6px; font-size: 11px; border-radius: 3px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.2); color: inherit; font-family: var(--vscode-editor-font-family, monospace);'
								})) as HTMLInputElement;
								vIn.oninput = () => {
									param.value = vIn.value;
									this._syncDraft();
								};

								const delBtn = append(row, $('button.action-delete-btn', {
									type: 'button',
									style: 'cursor: pointer; opacity: 0.72; font-size: 12px; padding: 3px 5px; border: none; background: transparent; color: #f87171; display: inline-flex; align-items: center; justify-content: center; transition: opacity 0.15s;',
									title: 'Delete parameter'
								})) as HTMLButtonElement;
								append(delBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
								delBtn.onmousedown = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
								delBtn.onclick = (e: MouseEvent) => {
									e.preventDefault();
									e.stopPropagation();
									field.httpParams!.splice(pIdx, 1);
									renderParamsPanel();
									renderTabNav();
									this._syncDraft();
									this._persistCurrentModule().catch(() => { });
								};
							});
						}
					};

					// 2.2 Headers Panel Rendering
					const renderHeadersPanel = () => {
						clearNode(headersPanel);
						headersPanel.style.flexDirection = 'column';
						headersPanel.style.gap = '6px';

						const hHeader = append(headersPanel, $('div', {
							style: 'display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;'
						}));
						append(hHeader, $('div', { style: 'font-size: 10.5px; opacity: 0.7;' }, 'HTTP Request Headers:'));

						const hBtns = append(hHeader, $('div', { style: 'display: flex; gap: 6px;' }));
						const addPresetJson = append(hBtns, $('button.monaco-button', {
							type: 'button',
							style: 'padding: 2px 7px; font-size: 10px; cursor: pointer; background: transparent; border: 1px solid rgba(255, 255, 255, 0.2); color: #94a3b8; border-radius: 3px;'
						}, '+ Content-Type: JSON'));
						addPresetJson.onclick = () => {
							field.httpHeaders = field.httpHeaders || [];
							if (!field.httpHeaders.some(h => h.key.toLowerCase() === 'content-type')) {
								field.httpHeaders.push({ id: `h_${Date.now()}`, key: 'Content-Type', value: 'application/json; charset=utf-8', enabled: true });
								renderHeadersPanel();
								renderTabNav();
								this._syncDraft();
							}
						};

						const addHBtn = append(hBtns, $('button.monaco-button', {
							type: 'button',
							style: 'padding: 2px 7px; font-size: 10.5px; cursor: pointer; background: transparent; border: 1px solid rgba(6, 182, 212, 0.35); color: #06b6d4; border-radius: 3px;'
						}, '+ Add Header'));

						addHBtn.onclick = () => {
							field.httpHeaders = field.httpHeaders || [];
							field.httpHeaders.push({ id: `h_${Date.now()}`, key: '', value: '', enabled: true });
							renderHeadersPanel();
							renderTabNav();
							this._syncDraft();
						};

						const hList = field.httpHeaders || [];
						if (hList.length === 0) {
							append(headersPanel, $('div', {
								style: 'font-size: 11px; opacity: 0.5; padding: 6px 0; font-style: italic;'
							}, 'No custom headers configured.'));
						} else {
							hList.forEach((hdr, hIdx) => {
								const row = append(headersPanel, $('div', {
									style: 'display: flex; align-items: center; gap: 6px; width: 100%;'
								}));
								const chk = append(row, $('input', {
									type: 'checkbox',
									style: 'cursor: pointer;',
									title: 'Enable or disable this header'
								})) as HTMLInputElement;
								chk.checked = hdr.enabled !== false;
								chk.onchange = () => {
									hdr.enabled = chk.checked;
									renderTabNav();
									this._syncDraft();
								};

								const kIn = append(row, $('input.monaco-inputbox', {
									placeholder: 'Header Name',
									value: hdr.key || '',
									style: 'flex: 1 1 120px; padding: 3px 6px; font-size: 11px; border-radius: 3px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.2); color: inherit; font-family: var(--vscode-editor-font-family, monospace);'
								})) as HTMLInputElement;
								kIn.oninput = () => {
									hdr.key = kIn.value;
									renderTabNav();
									this._syncDraft();
								};

								const vIn = append(row, $('input.monaco-inputbox', {
									placeholder: 'Header Value (e.g. Bearer {token})',
									value: hdr.value || '',
									style: 'flex: 2 1 180px; padding: 3px 6px; font-size: 11px; border-radius: 3px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.2); color: inherit; font-family: var(--vscode-editor-font-family, monospace);'
								})) as HTMLInputElement;
								vIn.oninput = () => {
									hdr.value = vIn.value;
									this._syncDraft();
								};

								const delBtn = append(row, $('button.action-delete-btn', {
									type: 'button',
									style: 'cursor: pointer; opacity: 0.72; font-size: 12px; padding: 3px 5px; border: none; background: transparent; color: #f87171; display: inline-flex; align-items: center; justify-content: center; transition: opacity 0.15s;',
									title: 'Delete header'
								})) as HTMLButtonElement;
								append(delBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
								delBtn.onmousedown = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
								delBtn.onclick = (e: MouseEvent) => {
									e.preventDefault();
									e.stopPropagation();
									field.httpHeaders!.splice(hIdx, 1);
									renderHeadersPanel();
									renderTabNav();
									this._syncDraft();
									this._persistCurrentModule().catch(() => { });
								};
							});
						}
					};

					// 2.3 Auth Panel Rendering
					const renderAuthPanel = () => {
						clearNode(authPanel);
						authPanel.style.flexDirection = 'column';
						authPanel.style.gap = '8px';

						const authTypeRow = append(authPanel, $('div', {
							style: 'display: flex; align-items: center; gap: 8px;'
						}));
						append(authTypeRow, $('label', { style: 'font-size: 11px; font-weight: 600; min-width: 90px;' }, 'Auth Type:'));
						const authSelect = append(authTypeRow, $('select.monaco-select-box', {
							style: 'padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.25); color: inherit; outline: none;'
						})) as HTMLSelectElement;

						const authTypes = [
							{ id: 'none', label: 'No Auth' },
							{ id: 'bearer', label: 'Bearer Token (Authorization: Bearer <token>)' },
							{ id: 'api_key', label: 'API Key (Custom Header / Query Param)' },
							{ id: 'basic', label: 'Basic Auth (Username + Password)' }
						];
						authTypes.forEach(at => {
							const opt = append(authSelect, $('option', { value: at.id }, at.label)) as HTMLOptionElement;
							if (at.id === (field.httpAuthType || 'none')) { opt.selected = true; }
						});

						const authConfigContainer = append(authPanel, $('div', {
							style: 'display: flex; flex-direction: column; gap: 6px; padding-left: 98px;'
						}));

						const renderAuthConfig = () => {
							clearNode(authConfigContainer);
							const at = field.httpAuthType || 'none';
							if (at === 'bearer') {
								const tokenRow = append(authConfigContainer, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
								append(tokenRow, $('span', { style: 'font-size: 10.5px; opacity: 0.7; min-width: 50px;' }, 'Token:'));
								const tokenIn = append(tokenRow, $('input.monaco-inputbox', {
									type: 'text',
									placeholder: 'e.g. {admin_password} or Bearer token secret',
									value: field.httpAuthToken || '',
									style: 'flex: 1; padding: 4px 8px; font-size: 11px; border-radius: 3px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.2); color: inherit; font-family: var(--vscode-editor-font-family, monospace);'
								})) as HTMLInputElement;
								tokenIn.oninput = () => {
									field.httpAuthToken = tokenIn.value;
									this._syncDraft();
								};
							} else if (at === 'api_key') {
								const keyRow1 = append(authConfigContainer, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
								append(keyRow1, $('span', { style: 'font-size: 10.5px; opacity: 0.7; min-width: 50px;' }, 'Key:'));
								const keyNameIn = append(keyRow1, $('input.monaco-inputbox', {
									placeholder: 'Key Name (default: X-API-Key)',
									value: field.httpApiKeyName || 'X-API-Key',
									style: 'flex: 1; padding: 4px 8px; font-size: 11px; border-radius: 3px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.2); color: inherit; font-family: var(--vscode-editor-font-family, monospace);'
								})) as HTMLInputElement;
								keyNameIn.oninput = () => {
									field.httpApiKeyName = keyNameIn.value;
									this._syncDraft();
								};

								const keyRow2 = append(authConfigContainer, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
								append(keyRow2, $('span', { style: 'font-size: 10.5px; opacity: 0.7; min-width: 50px;' }, 'Value:'));
								const keyValIn = append(keyRow2, $('input.monaco-inputbox', {
									placeholder: 'API Key Value or {api_key}',
									value: field.httpApiKeyValue || '',
									style: 'flex: 1; padding: 4px 8px; font-size: 11px; border-radius: 3px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.2); color: inherit; font-family: var(--vscode-editor-font-family, monospace);'
								})) as HTMLInputElement;
								keyValIn.oninput = () => {
									field.httpApiKeyValue = keyValIn.value;
									this._syncDraft();
								};

								const keyRow3 = append(authConfigContainer, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
								append(keyRow3, $('span', { style: 'font-size: 10.5px; opacity: 0.7; min-width: 50px;' }, 'Add to:'));
								const locSelect = append(keyRow3, $('select.monaco-select-box', {
									style: 'padding: 3px 6px; font-size: 10.5px; border-radius: 3px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.2); color: inherit;'
								})) as HTMLSelectElement;
								const optH = append(locSelect, $('option', { value: 'header' }, 'Header')) as HTMLOptionElement;
								const optQ = append(locSelect, $('option', { value: 'query' }, 'Query Param')) as HTMLOptionElement;
								if (field.httpApiKeyLocation === 'query') { optQ.selected = true; } else { optH.selected = true; }
								locSelect.onchange = () => {
									field.httpApiKeyLocation = locSelect.value as ICustomField['httpApiKeyLocation'];
									this._syncDraft();
								};
							} else if (at === 'basic') {
								const uRow = append(authConfigContainer, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
								append(uRow, $('span', { style: 'font-size: 10.5px; opacity: 0.7; min-width: 50px;' }, 'User:'));
								const uIn = append(uRow, $('input.monaco-inputbox', {
									placeholder: 'Username or {username}',
									value: field.httpAuthUsername || '',
									style: 'flex: 1; padding: 4px 8px; font-size: 11px; border-radius: 3px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.2); color: inherit;'
								})) as HTMLInputElement;
								uIn.oninput = () => {
									field.httpAuthUsername = uIn.value;
									this._syncDraft();
								};

								const pRow = append(authConfigContainer, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
								append(pRow, $('span', { style: 'font-size: 10.5px; opacity: 0.7; min-width: 50px;' }, 'Password:'));
								const pIn = append(pRow, $('input.monaco-inputbox', {
									type: 'password',
									placeholder: 'Password or {password}',
									value: field.httpAuthPassword || '',
									style: 'flex: 1; padding: 4px 8px; font-size: 11px; border-radius: 3px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.2); color: inherit;'
								})) as HTMLInputElement;
								pIn.oninput = () => {
									field.httpAuthPassword = pIn.value;
									this._syncDraft();
								};
							}
						};
						renderAuthConfig();

						authSelect.onchange = () => {
							field.httpAuthType = authSelect.value;
							renderAuthConfig();
							renderTabNav();
							this._syncDraft();
						};
					};

					// 2.4 Body Panel Rendering
					const renderBodyPanel = () => {
						clearNode(bodyPanel);
						bodyPanel.style.flexDirection = 'column';
						bodyPanel.style.gap = '8px';

						const bodyTop = append(bodyPanel, $('div', {
							style: 'display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;'
						}));

						const bodyTypeRow = append(bodyTop, $('div', { style: 'display: flex; align-items: center; gap: 6px;' }));
						append(bodyTypeRow, $('label', { style: 'font-size: 11px; font-weight: 600;' }, 'Body Type:'));
						const bodyTypeSelect = append(bodyTypeRow, $('select.monaco-select-box', {
							style: 'padding: 3px 6px; font-size: 11px; border-radius: 3px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.25); color: inherit;'
						})) as HTMLSelectElement;

						const bTypes = [
							{ id: 'none', label: 'none (no body)' },
							{ id: 'json', label: 'JSON (application/json)' },
							{ id: 'raw', label: 'Raw / Text' },
							{ id: 'x-www-form-urlencoded', label: 'x-www-form-urlencoded' }
						];
						bTypes.forEach(bt => {
							const opt = append(bodyTypeSelect, $('option', { value: bt.id }, bt.label)) as HTMLOptionElement;
							if (bt.id === (field.httpBodyType || 'none')) { opt.selected = true; }
						});

						const bodyActions = append(bodyTop, $('div', { style: 'display: flex; gap: 6px;' }));
						const formatJsonBtn = append(bodyActions, $('button.monaco-button', {
							type: 'button',
							style: 'padding: 2px 7px; font-size: 10.5px; cursor: pointer; background: transparent; border: 1px solid rgba(255, 255, 255, 0.2); color: #94a3b8; border-radius: 3px;',
							title: 'Format JSON template'
						}, 'Format JSON'));

						const bodyContentContainer = append(bodyPanel, $('div', {
							style: 'display: flex; flex-direction: column; gap: 4px;'
						}));

						const bodyTextarea = append(bodyContentContainer, $('textarea.monaco-inputbox', {
							placeholder: '{\n  "job_id": "{job_id}",\n  "company": "Stripe",\n  "status": "published",\n  "resume_content": {ai_resume_json}\n}',
							style: 'width: 100%; min-height: 140px; padding: 6px 8px; font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); line-height: 1.45; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.35); color: inherit; box-sizing: border-box; resize: vertical;'
						})) as HTMLTextAreaElement;
						bodyTextarea.value = field.httpBodyContent || '';

						bodyTextarea.oninput = () => {
							field.httpBodyContent = bodyTextarea.value;
							this._syncDraft();
						};

						formatJsonBtn.onclick = () => {
							const raw = bodyTextarea.value.trim();
							if (!raw) { return; }
							try {
								const parsed = JSON.parse(raw);
								bodyTextarea.value = JSON.stringify(parsed, null, 2);
								field.httpBodyContent = bodyTextarea.value;
								this.notificationService.info('JSON formatted successfully.');
								this._syncDraft();
							} catch (err) {
								this.notificationService.warn(`JSON Format Warning: ${(err as Error | undefined)?.message || 'Invalid JSON syntax. Note that variable placeholders like {var} may make JSON temporarily non-standard until interpolated.'}`);
							}
						};

						bodyTypeSelect.onchange = () => {
							field.httpBodyType = bodyTypeSelect.value;
							bodyContentContainer.style.display = field.httpBodyType === 'none' ? 'none' : 'flex';
							formatJsonBtn.style.display = field.httpBodyType === 'json' ? 'inline-block' : 'none';
							renderTabNav();
							this._syncDraft();
						};
						bodyContentContainer.style.display = field.httpBodyType === 'none' ? 'none' : 'flex';
						formatJsonBtn.style.display = field.httpBodyType === 'json' ? 'inline-block' : 'none';
					};

					// 2.5 Response Panel Rendering
					const renderResponsePanel = () => {
						clearNode(responsePanel);
						responsePanel.style.flexDirection = 'column';
						responsePanel.style.gap = '8px';

						const hasResponse = field.httpResponseStatus !== undefined && field.httpResponseStatus > 0;
						if (!hasResponse && !field.httpResponseBody && !field.httpResponseData) {
							append(responsePanel, $('div', {
								style: 'font-size: 11px; opacity: 0.6; padding: 12px; text-align: center; border: 1px dashed rgba(255, 255, 255, 0.15); border-radius: 4px;'
							}, 'No response recorded yet. Click "Send Request" above to test this API endpoint and inspect response headers, body, and status.'));
							return;
						}

						// Response header bar
						const respHeaderBar = append(responsePanel, $('div', {
							style: 'display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 4px 6px; background: rgba(0, 0, 0, 0.2); border-radius: 4px;'
						}));

						const respHeaderLeft = append(respHeaderBar, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
						const isOk = (field.httpResponseStatus || 0) >= 200 && (field.httpResponseStatus || 0) < 300;
						append(respHeaderLeft, $('span', {
							style: `font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 4px; background: ${isOk ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)'}; color: ${isOk ? '#10b981' : '#ef4444'}; border: 1px solid ${isOk ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)'};`
						}, `${field.httpResponseStatus} ${field.httpResponseStatusText || ''}`));

						if (field.httpLastDurationMs) {
							append(respHeaderLeft, $('span', { style: 'font-size: 10.5px; opacity: 0.7;' }, `${field.httpLastDurationMs}ms`));
						}
						if (field.httpLastExecutionTime) {
							append(respHeaderLeft, $('span', { style: 'font-size: 10px; opacity: 0.5;' }, `${field.httpLastExecutionTime}`));
						}

						// Response sub-views selector: Body | Headers | Downstream Variables + Top-Right Copy Button
						let respSubTab: 'body' | 'headers' | 'guide' = 'body';
						const subTabRow = append(responsePanel, $('div', { style: 'display: flex; align-items: center; justify-content: space-between; gap: 4px; flex-wrap: wrap;' }));
						const subTabLeft = append(subTabRow, $('div', { style: 'display: flex; gap: 4px;' }));
						const subBodyBtn = append(subTabLeft, $('button', {
							type: 'button',
							style: 'padding: 2px 8px; font-size: 10px; cursor: pointer; border-radius: 3px; border: 1px solid rgba(6, 182, 212, 0.4); background: rgba(6, 182, 212, 0.15); color: #06b6d4;'
						}, 'Response Body')) as HTMLButtonElement;
						const subHdrsBtn = append(subTabLeft, $('button', {
							type: 'button',
							style: 'padding: 2px 8px; font-size: 10px; cursor: pointer; border-radius: 3px; border: 1px solid transparent; background: transparent; color: #94a3b8;'
						}, 'Headers')) as HTMLButtonElement;
						const subGuideBtn = append(subTabLeft, $('button', {
							type: 'button',
							style: 'padding: 2px 8px; font-size: 10px; cursor: pointer; border-radius: 3px; border: 1px solid transparent; background: transparent; color: #94a3b8;'
						}, 'Downstream Variables Guide')) as HTMLButtonElement;

						const copyHttpRespBtn = append(subTabRow, $('button', {
							type: 'button',
							title: 'Copy complete HTTP response to clipboard',
							style: 'display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; font-size: 10.5px; font-weight: 500; border-radius: 4px; border: 1px solid rgba(6, 182, 212, 0.35); background: rgba(6, 182, 212, 0.1); color: #22d3ee; cursor: pointer; margin-left: auto;'
						})) as HTMLButtonElement;
						const copyHttpRespIcon = append(copyHttpRespBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy), { style: 'font-size: 11px;' }));
						const copyHttpRespLabel = append(copyHttpRespBtn, $('span', {}, 'Copy'));
						copyHttpRespBtn.onclick = async (e) => {
							e.preventDefault();
							e.stopPropagation();
							let textToCopy = '';
							if (respSubTab === 'headers') {
								textToCopy = JSON.stringify(field.httpResponseHeaders || {}, null, 2);
							} else {
								textToCopy = field.httpResponseData !== undefined && field.httpResponseData !== null
									? JSON.stringify(field.httpResponseData, null, 2)
									: (field.httpResponseBody || '');
							}
							if (!textToCopy) {
								this.notificationService.warn('No HTTP response content to copy.');
								return;
							}
							await this._clipboardService.writeText(textToCopy);
							copyHttpRespIcon.className = ThemeIcon.asClassName(Codicon.check);
							copyHttpRespBtn.style.color = '#4ade80';
							copyHttpRespLabel.textContent = 'Copied!';
							this.notificationService.info(respSubTab === 'headers' ? 'HTTP response headers copied to clipboard.' : 'Complete HTTP response copied to clipboard.');
							setTimeout(() => {
								if (copyHttpRespBtn.isConnected) {
									copyHttpRespIcon.className = ThemeIcon.asClassName(Codicon.copy);
									copyHttpRespBtn.style.color = '#22d3ee';
									copyHttpRespLabel.textContent = 'Copy';
								}
							}, 1500);
						};

						const subContentBox = append(responsePanel, $('div', {
							style: 'display: flex; flex-direction: column; width: 100%;'
						}));

						const renderRespSubView = () => {
							clearNode(subContentBox);
							subBodyBtn.style.background = respSubTab === 'body' ? 'rgba(6, 182, 212, 0.15)' : 'transparent';
							subBodyBtn.style.color = respSubTab === 'body' ? '#06b6d4' : '#94a3b8';
							subBodyBtn.style.borderColor = respSubTab === 'body' ? 'rgba(6, 182, 212, 0.4)' : 'transparent';

							subHdrsBtn.style.background = respSubTab === 'headers' ? 'rgba(6, 182, 212, 0.15)' : 'transparent';
							subHdrsBtn.style.color = respSubTab === 'headers' ? '#06b6d4' : '#94a3b8';
							subHdrsBtn.style.borderColor = respSubTab === 'headers' ? 'rgba(6, 182, 212, 0.4)' : 'transparent';

							subGuideBtn.style.background = respSubTab === 'guide' ? 'rgba(6, 182, 212, 0.15)' : 'transparent';
							subGuideBtn.style.color = respSubTab === 'guide' ? '#06b6d4' : '#94a3b8';
							subGuideBtn.style.borderColor = respSubTab === 'guide' ? 'rgba(6, 182, 212, 0.4)' : 'transparent';

							copyHttpRespBtn.style.display = respSubTab === 'guide' ? 'none' : 'inline-flex';

							if (respSubTab === 'body') {
								const formattedText = field.httpResponseData
									? JSON.stringify(field.httpResponseData, null, 2)
									: (field.httpResponseBody || '(empty response)');
								append(subContentBox, $('pre', {
									'data-selectable-box': 'true',
									style: 'margin: 0; padding: 8px 10px; font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); background: rgba(0, 0, 0, 0.35); border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.1); max-height: 240px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; color: inherit; user-select: text; -webkit-user-select: text; cursor: text;'
								}, formattedText));
							} else if (respSubTab === 'headers') {
								const hdrs = field.httpResponseHeaders || {};
								const hKeys = Object.keys(hdrs);
								if (hKeys.length === 0) {
									append(subContentBox, $('div', { style: 'font-size: 11px; opacity: 0.5; font-style: italic; padding: 6px 0;' }, 'No response headers available.'));
								} else {
									const tbl = append(subContentBox, $('table', {
										style: 'width: 100%; border-collapse: collapse; font-size: 10.5px; font-family: var(--vscode-editor-font-family, monospace);'
									}));
									hKeys.forEach(hk => {
										const tr = append(tbl, $('tr', { style: 'border-bottom: 1px solid rgba(255, 255, 255, 0.06);' }));
										append(tr, $('td', { style: 'padding: 4px 6px; color: #06b6d4; font-weight: 600; width: 35%;' }, hk));
										append(tr, $('td', { style: 'padding: 4px 6px; opacity: 0.85;' }, hdrs[hk]));
									});
								}
							} else if (respSubTab === 'guide') {
								const gBox = append(subContentBox, $('div', {
									style: 'display: flex; flex-direction: column; gap: 6px; font-size: 11px; padding: 6px 0;'
								}));
								append(gBox, $('div', { style: 'font-weight: 600; color: #06b6d4;' }, 'Downstream Node Syntax Guide:'));
								append(gBox, $('div', {}, `• Entire Response Body: \`{${field.label || 'API Request'}}\``));
								append(gBox, $('div', {}, `• HTTP Status Code: \`{${field.label || 'API Request'}.status}\` (e.g. ${field.httpResponseStatus || 200})`));
								append(gBox, $('div', {}, `• Success Boolean: \`{${field.label || 'API Request'}.ok}\` (true / false)`));
								append(gBox, $('div', {}, `• Parsed JSON Object: \`{${field.label || 'API Request'}.data}\``));
								if (field.httpResponseData && typeof field.httpResponseData === 'object' && !Array.isArray(field.httpResponseData)) {
									const sampleKeys = Object.keys(field.httpResponseData).slice(0, 3);
									sampleKeys.forEach(sk => {
										append(gBox, $('div', {}, `• JSON Field: \`{${field.label || 'API Request'}.${sk}}\` or \`{${field.label || 'API Request'}.data.${sk}}\``));
									});
								}
								append(gBox, $('div', { style: 'opacity: 0.7; margin-top: 4px;' }, `• In Python scripts: \`TICKET_CONTEXT['${field.label || 'API Request'}']['data']\``));
							}
						};

						subBodyBtn.onclick = () => { respSubTab = 'body'; renderRespSubView(); };
						subHdrsBtn.onclick = () => { respSubTab = 'headers'; renderRespSubView(); };
						subGuideBtn.onclick = () => { respSubTab = 'guide'; renderRespSubView(); };
						renderRespSubView();
					};

					// Send Button Click Handler
					sendBtn.onclick = async () => {
						sendBtn.disabled = true;
						sendBtnLabel.textContent = 'Sending...';
						clearNode(sendIcon);
						append(sendIcon, $('span' + ThemeIcon.asCSSSelector(Codicon.loading)), { style: 'font-size: 11px;' });
						sendIcon.classList.add('codicon-modifier-spin');

						try {
							// Gather live workflow context, with large spilled variables (__anyagentVarRef__) loaded back
							const liveContext: Record<string, unknown> = { ...(await this._getHydratedWorkflowRuntimeContext()) };

							const allFields = fields || this._activeModule?.fields || [];
							for (const f of allFields) {
								if (!f || f === field) { continue; }
								const fKey = f.label || f.id;
								let fieldVal: unknown = undefined;
								if (f.type === 'parameters' && f.parameters) {
									const pMap: Record<string, unknown> = {};
									f.parameters.forEach(p => { if (p.name) { pMap[p.name] = this._parseInputStringLiteral(p.defaultValue ?? ''); } });
									fieldVal = pMap;
									if (liveContext['Parameters'] === undefined) { liveContext['Parameters'] = pMap; }
									if (liveContext['Inputs'] === undefined) { liveContext['Inputs'] = pMap; }
								} else if (f.type === 'http_request') {
									fieldVal = f.httpResponseData ?? f.httpResponseBody ?? undefined;
								} else {
									const fAny: IRuntimeCustomField = f;
									fieldVal = fAny.lastExecutionOutput ?? fAny.pythonOutput ?? f.defaultContent ?? f.defaultValue ?? undefined;
								}
								// Never clobber hydrated runtime context values with empty fallback strings
								const hasMeaningfulVal = fieldVal !== undefined && fieldVal !== null && fieldVal !== '';
								if (hasMeaningfulVal || liveContext[fKey] === undefined) {
									liveContext[fKey] = fieldVal ?? '';
								}
								if (f.outputVariableName && (hasMeaningfulVal || liveContext[f.outputVariableName] === undefined)) {
									liveContext[f.outputVariableName] = hasMeaningfulVal ? fieldVal : '';
								}
								if (f.id && f.id !== fKey && (hasMeaningfulVal || liveContext[f.id] === undefined)) {
									liveContext[f.id] = hasMeaningfulVal ? fieldVal : '';
								}
								if (f.label && f.label !== fKey && (hasMeaningfulVal || liveContext[f.label] === undefined)) {
									liveContext[f.label] = hasMeaningfulVal ? fieldVal : '';
								}
							}

							const res = await this._ticketWorkflowRuntimeService.executeHttpRequest(field, liveContext);

							field.httpResponseStatus = res.status;
							field.httpResponseStatusText = res.statusText;
							field.httpResponseHeaders = res.headers;
							field.httpResponseBody = res.rawText;
							field.httpResponseData = res.data;
							field.httpLastExecutionTime = new Date().toLocaleTimeString();
							field.httpLastDurationMs = res.durationMs;

							updateStatusPill();
							activeTab = 'response';
							renderTabNav();
							updateTabVisibility();
							renderResponsePanel();

							this._syncDraft();
							await this._persistCurrentModule();

							if (res.ok) {
								this.notificationService.info(`HTTP Request Success: ${res.status} ${res.statusText} (${res.durationMs}ms)`);
							} else {
								this.notificationService.warn(`HTTP Request: ${res.status || 'Error'} ${res.statusText || res.error || ''} (${res.durationMs}ms)`);
							}
						} catch (err) {
							this.notificationService.error(`HTTP Request Failed: ${(err as Error | undefined)?.message || String(err)}`);
						} finally {
							sendBtn.disabled = false;
							sendBtnLabel.textContent = 'Send Request';
							clearNode(sendIcon);
							append(sendIcon, $('span' + ThemeIcon.asCSSSelector(Codicon.play)), { style: 'font-size: 11px;' });
							sendIcon.classList.remove('codicon-modifier-spin');
						}
					};

					// Initial tab rendering
					renderTabNav();
					renderParamsPanel();
					renderHeadersPanel();
					renderAuthPanel();
					renderBodyPanel();
					renderResponsePanel();
					updateTabVisibility();
				}

				if (field.type === 'table') {
					if (!Array.isArray(field.tableColumns) || field.tableColumns.length === 0) {
						const ts = Date.now();
						field.tableColumns = [
							{ id: `col_${ts}_1`, name: 'id', label: 'id', dataType: 'INTEGER', primaryKey: true, nullable: false },
							{ id: `col_${ts}_2`, name: 'name', label: 'name', dataType: 'TEXT', primaryKey: false, nullable: true },
							{ id: `col_${ts}_3`, name: 'status', label: 'status', dataType: 'TEXT', primaryKey: false, nullable: true },
							{ id: `col_${ts}_4`, name: 'created_at', label: 'created_at', dataType: 'DATETIME', primaryKey: false, nullable: true }
						];
					}
					if (!Array.isArray(field.tableRows)) {
						field.tableRows = [];
					}
					if (!field.tableDbEngine) {
						field.tableDbEngine = 'sqlite';
					}
					if (!field.tableDbTableName) {
						field.tableDbTableName = (field.label || field.id || 'ticket_table').toLowerCase().replace(/[^a-z0-9_]/g, '_') || 'ticket_table';
					}
					if (field.tableAutoSyncDb === undefined) {
						field.tableAutoSyncDb = false;
					}

					const tableBox = append(fieldCard, $('.table-schema-config', {
						style: 'display: flex; flex-direction: column; gap: 12px; background: rgba(20, 184, 166, 0.04); padding: 12px 14px; border-radius: 6px; border: 1px solid rgba(20, 184, 166, 0.25); margin-top: 4px;'
					}));

					const topInfoRow = append(tableBox, $('div', {
						style: 'display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;'
					}));
					const topInfoLeft = append(topInfoRow, $('div', {
						style: 'font-size: 11px; color: #2dd4bf; display: flex; align-items: center; gap: 6px; font-weight: 600;'
					}));
					append(topInfoLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.table)));
					append(topInfoLeft, $('span', {}, 'Data Table Primitive: Define typed columns, input/paste tabular rows, and store/sync with SQLite.'));

					const statsBadge = append(topInfoRow, $('span', {
						style: 'font-size: 10px; padding: 2px 8px; border-radius: 4px; background: rgba(20, 184, 166, 0.14); color: #5eead4; border: 1px solid rgba(20, 184, 166, 0.35); font-weight: 600;'
					}));

					const updateStatsBadge = () => {
						const cCount = (field.tableColumns || []).length;
						const rCount = (field.tableRows || []).length;
						const dbLabel = field.tableDbPath ? ` · SQLite: ${field.tableDbPath.split(/[/\\]/).pop()}` : '';
						statsBadge.textContent = `${cCount} col${cCount === 1 ? '' : 's'} · ${rCount} row${rCount === 1 ? '' : 's'}${dbLabel}`;
					};
					updateStatsBadge();

					// Create the 4 section containers in top-to-bottom visual order:
					// 1) Database Storage Binding (SQLite)
					// 2) SQL Statement & Table Query Execution
					// 3) Table Header Columns & SQLite Data Types
					// 4) Table Data Grid (Manual Edit / Paste / Paginated Query)
					const dbSection = append(tableBox, $('div', {
						style: 'display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 6px; background: rgba(15, 23, 42, 0.55); border: 1px solid rgba(20, 184, 166, 0.3);'
					}));
					const sqlSection = append(tableBox, $('div', {
						style: 'display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 6px; background: rgba(15, 23, 42, 0.55); border: 1px solid rgba(56, 189, 248, 0.3);'
					}));
					const colSection = append(tableBox, $('div', {
						style: 'display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 6px; background: rgba(0, 0, 0, 0.22); border: 1px solid rgba(255, 255, 255, 0.08);'
					}));
					const gridSection = append(tableBox, $('div', {
						style: 'display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 6px; background: rgba(0, 0, 0, 0.22); border: 1px solid rgba(255, 255, 255, 0.08);'
					}));

					let currentPage = 1;
					let pageSize = field.tablePageSize && field.tablePageSize > 0 ? field.tablePageSize : 10;
					let totalDbRowCount: number | undefined = undefined;

					// =========================================================================
					// Column Headers & SQLite Data Types Builder
					// =========================================================================
					const colHeaderBar = append(colSection, $('div', {
						style: 'display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;'
					}));
					const colTitleToggleBtn = append(colHeaderBar, $('button', {
						type: 'button',
						style: 'background: transparent; border: none; padding: 2px 4px; margin: -2px -4px; border-radius: 4px; color: #99f6e4; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;',
						title: 'Click to expand or collapse Table Columns'
					}));
					const colToggleChevron = append(colTitleToggleBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.chevronRight), {
						style: 'font-size: 12px; color: #2dd4bf;'
					}));
					append(colTitleToggleBtn, $('span', {}, 'Table Columns'));
					const colCountBadge = append(colTitleToggleBtn, $('span', {
						style: 'font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 10px; background: rgba(20, 184, 166, 0.16); color: #5eead4; border: 1px solid rgba(20, 184, 166, 0.3); text-transform: none;'
					}, `${(field.tableColumns || []).length}`));

					const colHeaderBtns = append(colHeaderBar, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;'
					}));

					const queryColsBtn = append(colHeaderBtns, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 4px 7px; font-size: 11px; font-weight: 600; border-radius: 4px; background: rgba(56, 189, 248, 0.16); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); cursor: pointer; display: inline-flex; align-items: center; justify-content: center;'
					}));
					append(queryColsBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.sync), { style: 'font-size: 12px;' }));
					this._attachInstantTooltip(queryColsBtn, 'Query Table Columns: Inspect & sync columns and data types from SQLite table', '#38bdf8');

					const updateHeaderBtn = append(colHeaderBtns, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 4px 7px; font-size: 11px; font-weight: 600; border-radius: 4px; background: rgba(245, 158, 11, 0.18); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.45); cursor: pointer; display: inline-flex; align-items: center; justify-content: center;'
					}));
					append(updateHeaderBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.cloudUpload), { style: 'font-size: 12px;' }));
					this._attachInstantTooltip(updateHeaderBtn, 'Update Header: Create table or update SQLite table header columns', '#fbbf24');

					const copyColsBtn = append(colHeaderBtns, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 4px 7px; font-size: 11px; font-weight: 600; border-radius: 4px; background: rgba(168, 85, 247, 0.16); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.4); cursor: pointer; display: inline-flex; align-items: center; justify-content: center;'
					}));
					append(copyColsBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy), { style: 'font-size: 12px;' }));
					this._attachInstantTooltip(copyColsBtn, 'Copy Columns: Copy all column names, SQLite data types & Primary Keys', '#c084fc');
					copyColsBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						const cols = field.tableColumns || [];
						if (cols.length === 0) {
							this.notificationService.warn('No columns defined to copy.');
							return;
						}
						const lines = cols.map(c => {
							const rawDt = (c.dataType || 'TEXT').toUpperCase();
							const matchedType = sqliteDataTypes.find(dt => dt.value === rawDt);
							const typeDesc = matchedType ? matchedType.label : rawDt;
							const pkDesc = c.primaryKey ? ' | PK (Primary Key)' : '';
							return `${c.name} | Type: ${typeDesc}${pkDesc}`;
						});
						await this._clipboardService.writeText(lines.join('\n'));
						this.notificationService.info(`Copied ${cols.length} column(s) and their attributes to clipboard.`);
					};

					const addColBtn = append(colHeaderBtns, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 3px 10px; font-size: 10.5px; font-weight: 600; border-radius: 4px; background: rgba(20, 184, 166, 0.16); color: #2dd4bf; border: 1px solid rgba(20, 184, 166, 0.4); cursor: pointer; display: inline-flex; align-items: center; gap: 4px;'
					}));
					append(addColBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.add), { style: 'font-size: 11px;' }));
					append(addColBtn, $('span', {}, 'Add Column'));

					const schemaDiffBanner = append(colSection, $('div', {
						style: 'display: none; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 6px 10px; border-radius: 5px; background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.4); color: #fcd34d; font-size: 11px;'
					}));

					const colCollapsedSummary = append(colSection, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 4px 8px; border-radius: 4px; background: rgba(255, 255, 255, 0.03); border: 1px dashed rgba(255, 255, 255, 0.1); font-size: 11px; color: #94a3b8; cursor: pointer;',
						title: 'Click to expand Table Columns'
					}));

					const colListContainer = append(colSection, $('div', {
						style: 'display: none; flex-direction: column; gap: 6px;'
					}));

					let isColsCollapsed = true;
					const applyColsCollapsedState = (collapsed: boolean) => {
						isColsCollapsed = collapsed;
						colListContainer.style.display = isColsCollapsed ? 'none' : 'flex';
						colCollapsedSummary.style.display = isColsCollapsed ? 'flex' : 'none';
						colToggleChevron.className = ThemeIcon.asClassName(isColsCollapsed ? Codicon.chevronRight : Codicon.chevronDown);
					};
					colTitleToggleBtn.onclick = () => applyColsCollapsedState(!isColsCollapsed);
					colCollapsedSummary.onclick = () => applyColsCollapsedState(false);

					const sqliteDataTypes: Array<{ value: TableColumnDataType; label: string }> = [
						{ value: 'TEXT', label: 'TEXT (String / UTF-8 Text)' },
						{ value: 'VARCHAR(255)', label: 'VARCHAR(255) (Bounded String)' },
						{ value: 'INTEGER', label: 'INTEGER (64-bit Signed Int)' },
						{ value: 'REAL', label: 'REAL (Floating Point)' },
						{ value: 'NUMERIC', label: 'NUMERIC (Decimal / Exact)' },
						{ value: 'BOOLEAN', label: 'BOOLEAN (0 / 1 Flag)' },
						{ value: 'DATE', label: 'DATE (YYYY-MM-DD)' },
						{ value: 'DATETIME', label: 'DATETIME (Timestamp)' },
						{ value: 'JSON', label: 'JSON (Structured Object/Array)' },
						{ value: 'BLOB', label: 'BLOB (Binary Data)' }
					];

					// =========================================================================
					// Interactive Data Grid (Manual Input, Inline Edit, Paste & Paginated Query)
					// =========================================================================
					const gridToolbar = append(gridSection, $('div', {
						style: 'display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;'
					}));
					append(gridToolbar, $('span', {
						style: 'font-size: 11px; font-weight: 600; color: #99f6e4; text-transform: uppercase; letter-spacing: 0.04em;'
					}, 'Table Data Grid (Manual Edit / Paste / Paginated Query)'));

					const gridActions = append(gridToolbar, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;'
					}));

					const addRowBtn = append(gridActions, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 3px 9px; font-size: 10.5px; font-weight: 600; border-radius: 4px; background: rgba(20, 184, 166, 0.16); color: #2dd4bf; border: 1px solid rgba(20, 184, 166, 0.4); cursor: pointer; display: inline-flex; align-items: center; gap: 4px;'
					}));
					append(addRowBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.add), { style: 'font-size: 11px;' }));
					append(addRowBtn, $('span', {}, 'Add Row'));

					const pasteToggleBtn = append(gridActions, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 3px 9px; font-size: 10.5px; font-weight: 600; border-radius: 4px; background: rgba(56, 189, 248, 0.14); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); cursor: pointer; display: inline-flex; align-items: center; gap: 4px;',
						title: 'Paste tabular rows from Excel, Google Sheets, CSV, Markdown table, or JSON array'
					}));
					append(pasteToggleBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.clippy), { style: 'font-size: 11px;' }));
					append(pasteToggleBtn, $('span', {}, 'Paste Data'));

					const copyTableMdBtn = append(gridActions, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 3px 8px; font-size: 10.5px; border-radius: 4px; background: rgba(255, 255, 255, 0.06); color: inherit; border: 1px solid rgba(255, 255, 255, 0.15); cursor: pointer; display: inline-flex; align-items: center; gap: 4px;',
						title: 'Copy table as Markdown'
					}));
					append(copyTableMdBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy), { style: 'font-size: 11px;' }));
					append(copyTableMdBtn, $('span', {}, 'Copy MD'));

					const clearRowsBtn = append(gridActions, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 3px 8px; font-size: 10.5px; border-radius: 4px; background: rgba(239, 68, 68, 0.12); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.35); cursor: pointer; display: inline-flex; align-items: center; gap: 4px;',
						title: 'Clear all rows in current grid'
					}));
					append(clearRowsBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.clearAll), { style: 'font-size: 11px;' }));
					append(clearRowsBtn, $('span', {}, 'Clear Rows'));

					// Paginated Query Toolbar inside Grid Section
					const paginationBar = append(gridSection, $('div', {
						style: 'display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 6px 10px; border-radius: 5px; background: rgba(15, 23, 42, 0.45); border: 1px solid rgba(255, 255, 255, 0.07);'
					}));
					const pageLeftWrap = append(paginationBar, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;'
					}));
					append(pageLeftWrap, $('span', { style: 'font-size: 11px; opacity: 0.8;' }, 'Page Size:'));
					const pageSizeSelect = append(pageLeftWrap, $('select.monaco-select', {
						style: 'padding: 3px 7px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(20, 184, 166, 0.35); background: #141c24; color: #5eead4; font-weight: 600; cursor: pointer;'
					})) as HTMLSelectElement;
					[10, 20, 50, 100, 200, 500].forEach(sz => {
						const opt = append(pageSizeSelect, $('option', { value: String(sz) }, `${sz} rows / page`)) as HTMLOptionElement;
						if (sz === pageSize) {
							opt.selected = true;
						}
					});

					const queryPageBtn = append(pageLeftWrap, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 3px 10px; font-size: 10.5px; font-weight: 600; border-radius: 4px; background: rgba(168, 85, 247, 0.18); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.45); cursor: pointer; display: inline-flex; align-items: center; gap: 4px;',
						title: 'Query rows from SQLite database with current page size and page number'
					}));
					append(queryPageBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.search), { style: 'font-size: 11px;' }));
					append(queryPageBtn, $('span', {}, 'Query Data'));

					const pageRightWrap = append(paginationBar, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;'
					}));
					const prevPageBtn = append(pageRightWrap, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 2px 8px; font-size: 10.5px; border-radius: 4px; background: rgba(255, 255, 255, 0.06); color: inherit; border: 1px solid rgba(255, 255, 255, 0.15); cursor: pointer;'
					}, '< Prev')) as HTMLButtonElement;
					const pageInfoLabel = append(pageRightWrap, $('span', {
						style: 'font-size: 10.5px; color: #cbd5e1; font-family: var(--vscode-editor-font-family, monospace); min-width: 110px; text-align: center;'
					}, 'Page 1 / 1'));
					const nextPageBtn = append(pageRightWrap, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 2px 8px; font-size: 10.5px; border-radius: 4px; background: rgba(255, 255, 255, 0.06); color: inherit; border: 1px solid rgba(255, 255, 255, 0.15); cursor: pointer;'
					}, 'Next >')) as HTMLButtonElement;

					// Collapsible Paste Drawer
					const pasteDrawer = append(gridSection, $('div', {
						style: 'display: none; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 5px; background: rgba(15, 23, 42, 0.65); border: 1px dashed rgba(56, 189, 248, 0.4);'
					}));
					append(pasteDrawer, $('div', {
						style: 'font-size: 10.5px; color: #7dd3fc;'
					}, 'Paste Excel/Sheets (TSV), CSV, Markdown table, or JSON array below. First row can be headers matching column names:'));
					const pasteTextarea = append(pasteDrawer, $('textarea.monaco-inputbox', {
						rows: 4,
						placeholder: 'id\tname\tstatus\n1\tAlice\tActive\n2\tBob\tPending',
						style: 'width: 100%; padding: 6px 8px; font-size: 11.5px; font-family: var(--vscode-editor-font-family, monospace); border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.35); color: inherit; box-sizing: border-box; resize: vertical;'
					})) as HTMLTextAreaElement;
					const pasteDrawerActions = append(pasteDrawer, $('div', {
						style: 'display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;'
					}));
					const hasHeaderCheckWrap = append(pasteDrawerActions, $('label', {
						style: 'display: inline-flex; align-items: center; gap: 5px; font-size: 11px; cursor: pointer; opacity: 0.85;'
					}));
					const hasHeaderCheckbox = append(hasHeaderCheckWrap, $('input', { type: 'checkbox' })) as HTMLInputElement;
					hasHeaderCheckbox.checked = true;
					append(hasHeaderCheckWrap, $('span', {}, 'First line contains column headers'));

					const pasteDrawerBtns = append(pasteDrawerActions, $('div', { style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;' }));
					const applyAppendPasteBtn = append(pasteDrawerBtns, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 3px 10px; font-size: 10.5px; font-weight: 600; border-radius: 4px; background: rgba(20, 184, 166, 0.2); color: #2dd4bf; border: 1px solid rgba(20, 184, 166, 0.45); cursor: pointer;'
					}, 'Append Pasted Rows'));
					const applyReplacePasteBtn = append(pasteDrawerBtns, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 3px 10px; font-size: 10.5px; font-weight: 600; border-radius: 4px; background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.45); cursor: pointer;'
					}, 'Replace All Rows'));
					const closePasteBtn = append(pasteDrawerBtns, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 3px 8px; font-size: 10.5px; border-radius: 4px; background: transparent; color: rgba(255,255,255,0.65); border: 1px solid rgba(255,255,255,0.15); cursor: pointer;'
					}, 'Cancel'));

					const gridTableWrap = append(gridSection, $('div', {
						style: 'width: 100%; overflow-x: auto; max-height: 320px; overflow-y: auto; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(0, 0, 0, 0.25);'
					}));

					const parsePastedTabularText = (rawText: string, treatFirstRowAsHeader: boolean, replaceExisting: boolean) => {
						const trimmed = rawText.trim();
						if (!trimmed) { return; }
						const cols = field.tableColumns || [];
						const newRows: Record<string, unknown>[] = [];

						// Case 1: JSON Array
						if (trimmed.startsWith('[')) {
							try {
								const parsed = JSON.parse(trimmed);
								if (Array.isArray(parsed)) {
									for (const item of parsed) {
										if (item && typeof item === 'object' && !Array.isArray(item)) {
											for (const k of Object.keys(item)) {
												if (!cols.some(c => c.name.toLowerCase() === k.toLowerCase())) {
													cols.push({
														id: `col_${Date.now()}_${cols.length + 1}`,
														name: k,
														label: k,
														dataType: 'TEXT',
														primaryKey: false,
														nullable: true
													});
												}
											}
											newRows.push({ ...item });
										}
									}
								}
							} catch { }
						}

						if (newRows.length === 0) {
							const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
							if (lines.length === 0) { return; }

							// Detect Markdown Table
							const isMarkdown = lines[0].includes('|') && lines.length >= 2 && /^\|?[\s:-]+\|/.test(lines[1]);
							let matrix: string[][] = [];
							if (isMarkdown) {
								const dataLines = lines.filter((_, idx) => idx !== 1);
								matrix = dataLines.map(line => {
									const clean = line.replace(/^\|/, '').replace(/\|$/, '');
									return clean.split('|').map(c => c.trim());
								});
							} else {
								const delimiter = lines[0].includes('\t') ? '\t' : ',';
								matrix = lines.map(line => line.split(delimiter).map(c => c.trim().replace(/^"|"$/g, '')));
							}

							if (matrix.length > 0) {
								let headerNames: string[] = [];
								let startRowIdx = 0;
								if (treatFirstRowAsHeader || isMarkdown) {
									headerNames = matrix[0].map((h, i) => h || `col_${i + 1}`);
									startRowIdx = 1;
									for (const hName of headerNames) {
										if (!cols.some(c => c.name.toLowerCase() === hName.toLowerCase())) {
											cols.push({
												id: `col_${Date.now()}_${cols.length + 1}`,
												name: hName,
												label: hName,
												dataType: 'TEXT',
												primaryKey: false,
												nullable: true
											});
										}
									}
								} else {
									headerNames = cols.map(c => c.name);
								}

								for (let rIdx = startRowIdx; rIdx < matrix.length; rIdx++) {
									const cells = matrix[rIdx];
									const rowObj: Record<string, unknown> = {};
									for (let cIdx = 0; cIdx < headerNames.length; cIdx++) {
										const targetHeader = headerNames[cIdx];
										const matchedCol = cols.find(c => c.name.toLowerCase() === targetHeader.toLowerCase());
										const colKey = matchedCol ? matchedCol.name : targetHeader;
										if (colKey) {
											rowObj[colKey] = cells[cIdx] !== undefined ? cells[cIdx] : '';
										}
									}
									newRows.push(rowObj);
								}
							}
						}

						if (newRows.length > 0) {
							field.tableColumns = cols;
							if (replaceExisting) {
								field.tableRows = newRows;
							} else {
								field.tableRows = [...(field.tableRows || []), ...newRows];
							}
							this._syncDraft();
							renderColumnsBuilder();
							renderGridTable();
							updateStatsBadge();
							updateSchemaDiffBanner();
							this.notificationService.info(`Imported ${newRows.length} row(s) into table '${field.label || field.id}'.`);
						}
					};

					const updatePaginationControls = () => {
						const rows = field.tableRows || [];
						const effectiveTotal = totalDbRowCount !== undefined ? Math.max(totalDbRowCount, rows.length) : rows.length;
						const totalPages = Math.max(1, Math.ceil(effectiveTotal / pageSize));
						if (currentPage > totalPages) {
							currentPage = totalPages;
						}
						if (currentPage < 1) {
							currentPage = 1;
						}
						pageInfoLabel.textContent = `Page ${currentPage} / ${totalPages} (Total: ${effectiveTotal})`;
						prevPageBtn.disabled = currentPage <= 1;
						nextPageBtn.disabled = currentPage >= totalPages;
						prevPageBtn.style.opacity = prevPageBtn.disabled ? '0.4' : '1';
						nextPageBtn.style.opacity = nextPageBtn.disabled ? '0.4' : '1';
					};

					const renderGridTable = () => {
						clearNode(gridTableWrap);
						const cols = field.tableColumns || [];
						const rows = field.tableRows || [];
						updatePaginationControls();

						if (cols.length === 0) {
							append(gridTableWrap, $('div', {
								style: 'padding: 16px; text-align: center; font-size: 11px; opacity: 0.6; font-style: italic;'
							}, 'No columns defined. Click "Query Table Columns" or "+ Add Column" above to define table columns.'));
							return;
						}

						const tbl = append(gridTableWrap, $('table', {
							style: 'width: 100%; border-collapse: collapse; font-size: 11.5px; text-align: left;'
						}));
						const thead = append(tbl, $('thead'));
						const trHead = append(thead, $('tr', {
							style: 'background: rgba(20, 184, 166, 0.12); border-bottom: 1px solid rgba(20, 184, 166, 0.3);'
						}));
						append(trHead, $('th', {
							style: 'padding: 6px 8px; width: 34px; text-align: center; font-size: 10px; opacity: 0.65; border-right: 1px solid rgba(255,255,255,0.06);'
						}, '#'));
						cols.forEach(c => {
							const th = append(trHead, $('th', {
								style: 'padding: 6px 8px; font-weight: 600; color: #e2e8f0; border-right: 1px solid rgba(255,255,255,0.06); white-space: nowrap;'
							}));
							const thInner = append(th, $('div', { style: 'display: flex; align-items: center; gap: 5px;' }));
							append(thInner, $('span', {}, c.name));
							append(thInner, $('span', {
								style: 'font-size: 9px; padding: 1px 4px; border-radius: 3px; background: rgba(20, 184, 166, 0.2); color: #5eead4; font-weight: 700;'
							}, c.dataType));
							if (c.primaryKey) {
								append(thInner, $('span', {
									style: 'font-size: 8.5px; padding: 1px 4px; border-radius: 3px; background: rgba(245, 158, 11, 0.2); color: #fbbf24; font-weight: 700;'
								}, 'PK'));
							}
						});
						append(trHead, $('th', {
							style: 'padding: 6px 8px; width: 36px; text-align: center; font-size: 10px; opacity: 0.65;'
						}, 'Del'));

						const tbody = append(tbl, $('tbody'));
						if (rows.length === 0) {
							const trEmpty = append(tbody, $('tr'));
							const tdEmpty = append(trEmpty, $('td', {
								colSpan: cols.length + 2,
								style: 'padding: 14px; text-align: center; font-size: 11px; opacity: 0.55; font-style: italic;'
							}, 'No rows yet. Click "Query Data", "+ Add Row", or "Paste Data" above.'));
							tdEmpty.ondblclick = () => {
								addRowBtn.click();
							};
						} else {
							const isLocalMultiPage = rows.length > pageSize;
							const visibleRows = isLocalMultiPage
								? rows.slice((currentPage - 1) * pageSize, currentPage * pageSize)
								: rows;
							const baseRowNumber = (currentPage - 1) * pageSize;

							visibleRows.forEach((rowObj, vIdx) => {
								const actualRowIdx = isLocalMultiPage ? (baseRowNumber + vIdx) : vIdx;
								const displayRowNum = baseRowNumber + vIdx + 1;
								const tr = append(tbody, $('tr', {
									style: 'border-bottom: 1px solid rgba(255, 255, 255, 0.05);'
								}));
								append(tr, $('td', {
									style: 'padding: 4px 6px; text-align: center; font-size: 10.5px; opacity: 0.5; border-right: 1px solid rgba(255,255,255,0.06);'
								}, String(displayRowNum)));

								cols.forEach(c => {
									const td = append(tr, $('td', {
										style: 'padding: 2px 4px; border-right: 1px solid rgba(255,255,255,0.06); min-width: 90px;'
									}));
									const cellInp = append(td, $('input.monaco-inputbox', {
										type: 'text',
										placeholder: c.dataType,
										style: 'width: 100%; padding: 4px 6px; font-size: 11.5px; border: 1px solid transparent; border-radius: 3px; background: transparent; color: inherit; box-sizing: border-box;'
									})) as HTMLInputElement;
									const rawCellVal = rowObj[c.name];
									cellInp.value = rawCellVal === undefined || rawCellVal === null ? '' : (typeof rawCellVal === 'object' ? JSON.stringify(rawCellVal) : String(rawCellVal));
									cellInp.onfocus = () => {
										cellInp.style.borderColor = 'rgba(20, 184, 166, 0.5)';
										cellInp.style.background = 'rgba(0, 0, 0, 0.35)';
									};
									cellInp.onblur = () => {
										cellInp.style.borderColor = 'transparent';
										cellInp.style.background = 'transparent';
									};
									cellInp.oninput = () => {
										rowObj[c.name] = cellInp.value;
										this._syncDraft();
									};
									cellInp.onpaste = (ev) => {
										const clipText = ev.clipboardData?.getData('text/plain') || '';
										if (clipText.includes('\n') || clipText.includes('\t')) {
											ev.preventDefault();
											parsePastedTabularText(clipText, false, false);
										}
									};
								});

								const tdAct = append(tr, $('td', {
									style: 'padding: 2px 4px; text-align: center;'
								}));
								const delRowB = append(tdAct, $('button', {
									type: 'button',
									style: 'cursor: pointer; font-size: 11.5px; color: #f87171; opacity: 0.75; background: transparent; border: none; padding: 2px 4px; display: inline-flex; align-items: center; justify-content: center;',
									title: 'Delete Row'
								})) as HTMLButtonElement;
								append(delRowB, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
								delRowB.onmousedown = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
								delRowB.onclick = (e: MouseEvent) => {
									e.preventDefault();
									e.stopPropagation();
									field.tableRows!.splice(actualRowIdx, 1);
									this._syncDraft();
									renderGridTable();
									updateStatsBadge();
									this._persistCurrentModule().catch(() => { });
								};
							});
						}
					};

					let updateSchemaDiffBanner = () => { };
					let hasLocalColumnEdits = false;
					let lastKnownDbColumns: ITableColumnDefinition[] | undefined = undefined;
					let lastKnownTableExists = false;
					let schemaLoadSeq = 0;
					let lastConfirmedDbPath = (field.tableDbPath || '').trim();
					let lastConfirmedTableExpr = (field.tableDbTableName || '').trim();

					const normalizeColDataType = (dt?: string): TableColumnDataType => {
						const raw = (dt || 'TEXT').trim().toUpperCase();
						if (raw.includes('INT')) {
							return 'INTEGER';
						}
						if (raw.includes('CHAR') || raw.includes('CLOB') || raw.includes('TEXT')) {
							return raw.startsWith('VARCHAR') ? 'VARCHAR(255)' : 'TEXT';
						}
						if (raw.includes('BLOB')) {
							return 'BLOB';
						}
						if (raw.includes('REAL') || raw.includes('FLOA') || raw.includes('DOUB')) {
							return 'REAL';
						}
						if (raw.includes('BOOL')) {
							return 'BOOLEAN';
						}
						if (raw.includes('DATETIME') || raw.includes('TIMESTAMP')) {
							return 'DATETIME';
						}
						if (raw.includes('DATE')) {
							return 'DATE';
						}
						if (raw.includes('JSON')) {
							return 'JSON';
						}
						if (raw.includes('NUM') || raw.includes('DEC')) {
							return 'NUMERIC';
						}
						return 'TEXT';
					};

					const cloneColumnDef = (c: ILooseTableColumn | null | undefined, idx: number): ITableColumnDefinition => ({
						id: c?.id || `col_${Date.now()}_${idx + 1}`,
						name: String(c?.name || c?.label || `col_${idx + 1}`).trim(),
						label: String(c?.label || c?.name || `col_${idx + 1}`).trim(),
						dataType: normalizeColDataType(c?.dataType),
						primaryKey: Boolean(c?.primaryKey),
						nullable: c?.nullable !== false,
						defaultValue: c?.defaultValue !== undefined && c?.defaultValue !== null ? String(c.defaultValue) : ''
					});

					const cloneColumnsList = (cols: ReadonlyArray<ILooseTableColumn | null | undefined> | undefined): ITableColumnDefinition[] =>
						Array.isArray(cols) ? cols.map((c, idx) => cloneColumnDef(c, idx)) : [];

					const areSchemasEqual = (
						colsA: Array<{ name?: string; dataType?: string; primaryKey?: boolean; nullable?: boolean; defaultValue?: string }> | undefined,
						colsB: Array<{ name?: string; dataType?: string; primaryKey?: boolean; nullable?: boolean; defaultValue?: string }> | undefined
					): boolean => {
						const a = colsA || [];
						const b = colsB || [];
						if (a.length !== b.length) {
							return false;
						}
						for (let i = 0; i < a.length; i++) {
							const ca = a[i];
							const cb = b[i];
							const nameA = (ca?.name || '').trim();
							const nameB = (cb?.name || '').trim();
							if (nameA !== nameB) {
								return false;
							}
							if (normalizeColDataType(ca?.dataType) !== normalizeColDataType(cb?.dataType)) {
								return false;
							}
							if (Boolean(ca?.primaryKey) !== Boolean(cb?.primaryKey)) {
								return false;
							}
							if (ca?.nullable !== undefined && cb?.nullable !== undefined && Boolean(ca.nullable) !== Boolean(cb.nullable)) {
								return false;
							}
							const dfltA = ca?.defaultValue !== undefined && ca?.defaultValue !== null ? String(ca.defaultValue) : '';
							const dfltB = cb?.defaultValue !== undefined && cb?.defaultValue !== null ? String(cb.defaultValue) : '';
							if (ca?.defaultValue !== undefined && cb?.defaultValue !== undefined && dfltA !== dfltB) {
								return false;
							}
						}
						return true;
					};

					const isSchemaDirty = (): boolean => {
						if (!hasLocalColumnEdits) {
							return false;
						}
						if (lastKnownDbColumns === undefined) {
							return true;
						}
						return !areSchemasEqual(field.tableColumns, lastKnownDbColumns);
					};

					const renderColumnsBuilder = () => {
						clearNode(colListContainer);
						clearNode(colCollapsedSummary);
						const cols = field.tableColumns || [];
						colCountBadge.textContent = `${cols.length}`;
						if (cols.length === 0) {
							append(colCollapsedSummary, $('span', { style: 'font-style: italic; opacity: 0.7;' }, 'No columns defined (click to expand)'));
						} else {
							cols.forEach(c => {
								const chip = append(colCollapsedSummary, $('span', {
									style: 'display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 4px; background: rgba(20, 184, 166, 0.12); color: #cbd5e1; border: 1px solid rgba(20, 184, 166, 0.28); font-size: 10.5px; font-family: var(--vscode-editor-font-family, monospace);'
								}));
								append(chip, $('span', { style: 'font-weight: 600; color: #f1f5f9;' }, c.name || 'col'));
								append(chip, $('span', { style: 'font-size: 9.5px; color: #5eead4; opacity: 0.85;' }, (c.dataType || 'TEXT').toUpperCase()));
								if (c.primaryKey) {
									append(chip, $('span', { style: 'font-size: 9px; font-weight: 700; color: #fbbf24;' }, 'PK'));
								}
							});
						}
						cols.forEach((col, cIdx) => {
							const cRow = append(colListContainer, $('div', {
								style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 4px 6px; border-radius: 4px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.06);'
							}));
							append(cRow, $('span', {
								style: 'font-size: 10px; opacity: 0.55; min-width: 44px; font-family: var(--vscode-editor-font-family, monospace);'
							}, `Col #${cIdx + 1}`));

							const nameInp = append(cRow, $('input.monaco-inputbox', {
								type: 'text',
								placeholder: 'Column Header Name (e.g. user_id)',
								style: 'flex: 1; min-width: 120px; padding: 4px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.14); background: rgba(0, 0, 0, 0.3); color: inherit;'
							})) as HTMLInputElement;
							nameInp.value = col.name || '';
							nameInp.oninput = () => {
								const oldName = col.name;
								const nextName = nameInp.value.trim() || `col_${cIdx + 1}`;
								col.name = nextName;
								col.label = nextName;
								hasLocalColumnEdits = true;
								if (oldName && oldName !== nextName && Array.isArray(field.tableRows)) {
									field.tableRows.forEach(r => {
										if (r && Object.prototype.hasOwnProperty.call(r, oldName)) {
											r[nextName] = r[oldName];
											delete r[oldName];
										}
									});
								}
								this._syncDraft();
								renderGridTable();
								updateSchemaDiffBanner();
							};

							append(cRow, $('span', { style: 'font-size: 10.5px; opacity: 0.7;' }, 'Type:'));
							const typeSel = append(cRow, $('select.monaco-select', {
								style: 'padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(20, 184, 166, 0.35); background: #141c24; color: #5eead4; font-weight: 600; cursor: pointer;'
							})) as HTMLSelectElement;
							sqliteDataTypes.forEach(dt => {
								const opt = append(typeSel, $('option', { value: dt.value }, dt.label)) as HTMLOptionElement;
								if ((col.dataType || 'TEXT').toUpperCase() === dt.value) {
									opt.selected = true;
								}
							});
							typeSel.onchange = () => {
								col.dataType = typeSel.value as TableColumnDataType;
								hasLocalColumnEdits = true;
								this._syncDraft();
								renderGridTable();
								updateSchemaDiffBanner();
							};

							const pkBtn = append(cRow, $('button', {
								type: 'button',
								style: col.primaryKey
									? 'padding: 3px 7px; font-size: 10px; font-weight: 700; border-radius: 4px; background: rgba(245, 158, 11, 0.22); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.5); cursor: pointer;'
									: 'padding: 3px 7px; font-size: 10px; font-weight: 600; border-radius: 4px; background: rgba(255, 255, 255, 0.04); color: rgba(255, 255, 255, 0.5); border: 1px solid rgba(255, 255, 255, 0.12); cursor: pointer;',
								title: 'Toggle Primary Key constraint for SQLite table'
							}, 'PK'));
							pkBtn.onclick = () => {
								col.primaryKey = !col.primaryKey;
								hasLocalColumnEdits = true;
								this._syncDraft();
								renderColumnsBuilder();
								renderGridTable();
								updateSchemaDiffBanner();
							};

							const delColBtn = append(cRow, $('button', {
								type: 'button',
								style: 'cursor: pointer; font-size: 12px; color: #ef4444; opacity: 0.75; padding: 2px 4px; background: transparent; border: none; display: inline-flex; align-items: center; justify-content: center;',
								title: 'Remove Column'
							})) as HTMLButtonElement;
							append(delColBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
							delColBtn.onmousedown = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
							delColBtn.onclick = (e: MouseEvent) => {
								e.preventDefault();
								e.stopPropagation();
								if (cols.length <= 1) {
									this.notificationService.warn('Table must have at least one column.');
									return;
								}
								const removed = cols.splice(cIdx, 1)[0];
								hasLocalColumnEdits = true;
								if (removed && Array.isArray(field.tableRows)) {
									field.tableRows.forEach(r => {
										if (r) { delete r[removed.name]; }
									});
								}
								this._syncDraft();
								renderColumnsBuilder();
								renderGridTable();
								updateStatsBadge();
								updateSchemaDiffBanner();
								this._persistCurrentModule().catch(() => { });
							};
						});
					};

					addColBtn.onclick = () => {
						if (isColsCollapsed) {
							applyColsCollapsedState(false);
						}
						if (!Array.isArray(field.tableColumns)) {
							field.tableColumns = [];
						}
						const nextIdx = field.tableColumns.length + 1;
						let colName = `column_${nextIdx}`;
						while (field.tableColumns.some(c => c.name.toLowerCase() === colName.toLowerCase())) {
							colName = `column_${nextIdx}_${Math.floor(Math.random() * 100)}`;
						}
						field.tableColumns.push({
							id: `col_${Date.now()}_${nextIdx}`,
							name: colName,
							label: colName,
							dataType: 'TEXT',
							primaryKey: false,
							nullable: true
						});
						hasLocalColumnEdits = true;
						this._syncDraft();
						renderColumnsBuilder();
						renderGridTable();
						updateStatsBadge();
						updateSchemaDiffBanner();
					};

					addRowBtn.onclick = () => {
						if (!Array.isArray(field.tableRows)) {
							field.tableRows = [];
						}
						const newRow: Record<string, unknown> = {};
						(field.tableColumns || []).forEach(c => {
							if (c.primaryKey && c.dataType === 'INTEGER') {
								newRow[c.name] = field.tableRows!.length + 1;
							} else {
								newRow[c.name] = c.defaultValue ?? '';
							}
						});
						field.tableRows.push(newRow);
						this._syncDraft();
						renderGridTable();
						updateStatsBadge();
					};

					pasteToggleBtn.onclick = () => {
						const isHidden = pasteDrawer.style.display === 'none';
						pasteDrawer.style.display = isHidden ? 'flex' : 'none';
						if (isHidden) {
							setTimeout(() => pasteTextarea.focus(), 20);
						}
					};
					closePasteBtn.onclick = () => {
						pasteDrawer.style.display = 'none';
					};
					applyAppendPasteBtn.onclick = () => {
						parsePastedTabularText(pasteTextarea.value, hasHeaderCheckbox.checked, false);
						pasteTextarea.value = '';
						pasteDrawer.style.display = 'none';
					};
					applyReplacePasteBtn.onclick = () => {
						parsePastedTabularText(pasteTextarea.value, hasHeaderCheckbox.checked, true);
						pasteTextarea.value = '';
						pasteDrawer.style.display = 'none';
					};

					copyTableMdBtn.onclick = async () => {
						const cols = field.tableColumns || [];
						const rows = field.tableRows || [];
						const colNames = cols.map(c => c.name);
						const header = `| ${colNames.join(' | ')} |`;
						const sep = `| ${colNames.map(() => '---').join(' | ')} |`;
						const body = rows.map(r => `| ${colNames.map(cn => String(r[cn] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`);
						await this._clipboardService.writeText([header, sep, ...body].join('\n'));
						this.notificationService.info('Table Markdown copied to clipboard.');
					};

					clearRowsBtn.onclick = () => {
						field.tableRows = [];
						this._syncDraft();
						renderGridTable();
						updateStatsBadge();
					};

					renderColumnsBuilder();
					renderGridTable();

					// =========================================================================
					// SQLite Database Storage & Operations Section
					// =========================================================================
					const dbHeaderRow = append(dbSection, $('div', {
						style: 'display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;'
					}));
					const dbTitleLeft = append(dbHeaderRow, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; color: #2dd4bf; text-transform: uppercase; letter-spacing: 0.04em;'
					}));
					append(dbTitleLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.database)));
					append(dbTitleLeft, $('span', {}, 'Database Storage Binding (SQLite)'));

					const autoSyncLabel = append(dbHeaderRow, $('label', {
						style: 'display: inline-flex; align-items: center; gap: 5px; font-size: 11px; cursor: pointer; color: #cbd5e1;'
					}));
					const autoSyncCheck = append(autoSyncLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
					autoSyncCheck.checked = Boolean(field.tableAutoSyncDb);
					autoSyncCheck.onchange = () => {
						field.tableAutoSyncDb = autoSyncCheck.checked;
						this._syncDraft();
					};
					append(autoSyncLabel, $('span', {}, 'Create empty table if missing'));
					autoSyncLabel.title = 'When the workflow runs and the target table does not exist yet, create it (empty) from this card\'s columns. Never writes any rows.';

					// Step 1: DB Engine + SQLite File Path + Select / Create New SQLite File
					const dbPathRow = append(dbSection, $('div', {
						style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;'
					}));
					append(dbPathRow, $('span', { style: 'font-size: 11px; opacity: 0.8; min-width: 72px;' }, 'SQLite File:'));
					const engineSelect = append(dbPathRow, $('select.monaco-select', {
						style: 'padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.15); background: #141c24; color: #5eead4; font-weight: 600; cursor: pointer;'
					})) as HTMLSelectElement;
					[
						{ value: 'sqlite', label: 'SQLite (.sqlite / .db)' },
						{ value: 'none', label: 'In-Ticket JSON Only' }
					].forEach(eng => {
						const opt = append(engineSelect, $('option', { value: eng.value }, eng.label)) as HTMLOptionElement;
						if ((field.tableDbEngine || 'sqlite') === eng.value) { opt.selected = true; }
					});
					engineSelect.onchange = () => {
						field.tableDbEngine = engineSelect.value as 'sqlite' | 'none';
						this._syncDraft();
					};

					const dbPathInp = append(dbPathRow, $('input.monaco-inputbox', {
						type: 'text',
						placeholder: 'Enter SQLite file path (e.g. Jobs.sqlite) or click Select / + New SQLite...',
						style: 'flex: 1; min-width: 210px; padding: 5px 8px; font-size: 11.5px; font-family: var(--vscode-editor-font-family, monospace); border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.3); color: inherit;'
					})) as HTMLInputElement;
					dbPathInp.value = field.tableDbPath || '';
					dbPathInp.oninput = () => {
						field.tableDbPath = dbPathInp.value.trim();
						updateStatsBadge();
						this._syncDraft();
					};

					const browseSqliteBtn = append(dbPathRow, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 4px 10px; font-size: 11px; border-radius: 4px; background: rgba(255, 255, 255, 0.08); color: inherit; border: 1px solid rgba(255, 255, 255, 0.18); cursor: pointer; display: inline-flex; align-items: center; gap: 5px;',
						title: 'Select an existing SQLite database file (.sqlite, .db, .sqlite3)'
					}));
					append(browseSqliteBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.folderOpened)));
					append(browseSqliteBtn, $('span', {}, 'Select SQLite...'));

					const newSqliteBtn = append(dbPathRow, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 4px; background: rgba(20, 184, 166, 0.18); color: #2dd4bf; border: 1px solid rgba(20, 184, 166, 0.45); cursor: pointer; display: inline-flex; align-items: center; gap: 5px;',
						title: 'Create a new empty SQLite database file with your chosen filename'
					}));
					append(newSqliteBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.newFile)));
					append(newSqliteBtn, $('span', {}, '+ New SQLite...'));

					// Step 2: Target Table Selection (Existing DB Tables Dropdown OR New Table Name OR INPUTS Parameter) + Confirm Button
					const dbTableRow = append(dbSection, $('div', {
						style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;'
					}));
					append(dbTableRow, $('span', { style: 'font-size: 11px; opacity: 0.8; min-width: 72px;' }, 'Target Table:'));

					const tblSelect = append(dbTableRow, $('select.monaco-select', {
						style: 'padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.35); background: #141c24; color: #7dd3fc; font-weight: 600; cursor: pointer; min-width: 185px;',
						title: 'Choose an existing table in this SQLite database, select "+ Create New Table", or select "Use or create by INPUTS parameter" (e.g. {table name})'
					})) as HTMLSelectElement;

					const tblNameWrapper = append(dbTableRow, $('div.prompt-input-container', {
						style: 'flex: 1; min-width: 150px; position: relative;'
					}));

					const tblNameDisplayEl = append(tblNameWrapper, $('div.prompt-tokenized-display', {
						style: 'display: flex; align-items: center; min-height: 27px; padding: 3px 8px; font-size: 11.5px; font-family: var(--vscode-editor-font-family, monospace); border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.3); color: inherit; cursor: text; white-space: pre; overflow-x: auto; box-sizing: border-box;'
					}));

					const tblNameInp = append(tblNameWrapper, $('input.monaco-inputbox', {
						type: 'text',
						placeholder: 'Enter table name or INPUTS variable (e.g. {table name})',
						style: 'display: none; width: 100%; min-height: 27px; padding: 4px 8px; font-size: 11.5px; font-family: var(--vscode-editor-font-family, monospace); border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.65); background: rgba(0, 0, 0, 0.45); color: inherit; box-sizing: border-box; outline: none;'
					})) as HTMLInputElement;
					tblNameInp.value = field.tableDbTableName || '';

					const tblNameAutocompleteMenu = append(tblNameWrapper, $('div.prompt-autocomplete-menu', {
						style: 'display: none; position: absolute; left: 0; top: 100%; margin-top: 4px; z-index: 2500; min-width: 220px; max-height: 200px; overflow-y: auto; background: var(--vscode-editorWidget-background, #1e1e1e); border: 1px solid var(--vscode-editorWidget-border, #454545); border-radius: 6px; box-shadow: 0 6px 20px rgba(0,0,0,0.45); padding: 4px;'
					}));

					const renderTblNameTokenized = (rawVal?: string) => {
						const text = (rawVal ?? tblNameInp.value) || '';
						clearNode(tblNameDisplayEl);
						if (!text) {
							append(tblNameDisplayEl, $('span', {
								style: 'opacity: 0.45; font-style: italic;'
							}, tblNameInp.placeholder || 'Enter table name or {table name}'));
							return;
						}
						const refTokens = getReferenceTokensForField(field);
						const tokenRegex = /(\{[^{}\n]+\}|@[a-zA-Z0-9_\-\u4e00-\u9fa5]+)/g;
						let lastIdx = 0;
						let match: RegExpExecArray | null;
						while ((match = tokenRegex.exec(text)) !== null) {
							if (match.index > lastIdx) {
								append(tblNameDisplayEl, document.createTextNode(text.slice(lastIdx, match.index)));
							}
							const fullMatch = match[0];
							const cleanTokenName = fullMatch.startsWith('{') && fullMatch.endsWith('}')
								? fullMatch.slice(1, -1).trim()
								: fullMatch.slice(1).trim();
							const matchedRef = refTokens.find(rt => rt.label.toLowerCase() === cleanTokenName.toLowerCase());
							const pillLabel = matchedRef ? matchedRef.label : (fullMatch.startsWith('{') && fullMatch.endsWith('}') ? cleanTokenName : '');
							if (pillLabel) {
								const pill = append(tblNameDisplayEl, $('span.prompt-token-pill', {
									style: 'display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; margin: 0 1px; border-radius: 4px; font-size: 11px; font-weight: 600; background: rgba(14, 99, 156, 0.28); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); vertical-align: baseline; user-select: none;'
								}));
								this._attachInstantTooltip(pill, `${matchedRef ? matchedRef.badge : 'INPUTS'} reference: ${pillLabel}`, '#38bdf8');
								append(pill, $('span' + ThemeIcon.asCSSSelector(Codicon.link), { style: 'font-size: 10px;' }));
								append(pill, $('span', {}, pillLabel));
							} else {
								append(tblNameDisplayEl, document.createTextNode(fullMatch));
							}
							lastIdx = tokenRegex.lastIndex;
						}
						if (lastIdx < text.length) {
							append(tblNameDisplayEl, document.createTextNode(text.slice(lastIdx)));
						}
					};

					const switchToTblNameEdit = (selectAll: boolean = false) => {
						tblNameDisplayEl.style.display = 'none';
						tblNameInp.style.display = 'block';
						tblNameInp.focus();
						if (selectAll) {
							tblNameInp.select();
						}
					};

					const switchToTblNameDisplay = () => {
						setTimeout(() => {
							tblNameAutocompleteMenu.style.display = 'none';
							tblNameInp.style.display = 'none';
							tblNameDisplayEl.style.display = 'flex';
							const rawVal = tblNameInp.value.trim();
							if (rawVal) {
								if (tblSelect.value === '__param__' || /\{[^{}]+\}/.test(rawVal)) {
									field.tableDbTableName = rawVal;
								} else {
									field.tableDbTableName = rawVal.replace(/[^a-zA-Z0-9_]/g, '_');
								}
							}
							renderTblNameTokenized();
							this._syncDraft();
							this._persistCurrentModule().catch(() => { });
						}, 160);
					};

					tblNameDisplayEl.onclick = () => switchToTblNameEdit(false);
					tblNameInp.onblur = () => switchToTblNameDisplay();

					let tblNameTriggerStartIdx = -1;
					const updateTblNameAutocomplete = () => {
						const pos = tblNameInp.selectionStart || 0;
						const val = tblNameInp.value;
						const textBefore = val.slice(0, pos);
						const match = textBefore.match(/([\{@])([a-zA-Z0-9_\-\s\u4e00-\u9fa5]*)$/);
						if (!match) {
							tblNameAutocompleteMenu.style.display = 'none';
							tblNameTriggerStartIdx = -1;
							return;
						}
						tblNameTriggerStartIdx = pos - match[0].length;
						const query = match[2].toLowerCase().trim();
						const candidates = getReferenceTokensForField(field).filter(c => !query || c.label.toLowerCase().includes(query));
						if (candidates.length === 0) {
							tblNameAutocompleteMenu.style.display = 'none';
							return;
						}
						clearNode(tblNameAutocompleteMenu);
						tblNameAutocompleteMenu.style.display = 'block';
						candidates.forEach(cand => {
							const item = append(tblNameAutocompleteMenu, $('div', {
								style: 'display: flex; align-items: center; justify-content: space-between; padding: 5px 8px; border-radius: 4px; cursor: pointer; font-size: 11.5px;'
							}));
							item.onmouseenter = () => { item.style.background = 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.08))'; };
							item.onmouseleave = () => { item.style.background = 'transparent'; };
							const left = append(item, $('div', { style: 'display: flex; align-items: center; gap: 6px;' }));
							append(left, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolVariable), { style: 'color: #38bdf8; font-size: 12px;' }));
							append(left, $('span', { style: 'font-weight: 500;' }, cand.label));
							append(item, $('span', {
								style: 'font-size: 10px; opacity: 0.6; padding: 1px 5px; border-radius: 3px; background: rgba(255,255,255,0.06);'
							}, cand.badge));
							item.onmousedown = (ev) => {
								ev.preventDefault();
								const currentVal = tblNameInp.value;
								const currentPos = tblNameInp.selectionStart || 0;
								const replacement = `{${cand.label}}`;
								const nextVal = currentVal.slice(0, tblNameTriggerStartIdx) + replacement + currentVal.slice(currentPos);
								tblNameInp.value = nextVal;
								field.tableDbTableName = nextVal.trim();
								tblSelect.value = '__param__';
								tblNameAutocompleteMenu.style.display = 'none';
								renderTableParamChips();
								this._syncDraft();
								switchToTblNameDisplay();
							};
						});
					};

					renderTblNameTokenized();

					const confirmTableBtn = append(dbTableRow, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 4px 11px; font-size: 11px; font-weight: 600; border-radius: 4px; background: rgba(56, 189, 248, 0.22); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.5); cursor: pointer; display: inline-flex; align-items: center; gap: 5px;',
						title: 'Confirm target table: selects and loads existing table as query scope, or reserves new / INPUTS parameter table name'
					}));
					append(confirmTableBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.check)));
					append(confirmTableBtn, $('span', {}, 'Confirm Table'));

					const refreshTablesBtn = append(dbTableRow, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 4px 8px; font-size: 11px; border-radius: 4px; background: rgba(255, 255, 255, 0.06); color: inherit; border: 1px solid rgba(255, 255, 255, 0.15); cursor: pointer; display: inline-flex; align-items: center; gap: 4px;',
						title: 'Refresh list of tables in the SQLite database'
					}));
					append(refreshTablesBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.refresh)));

					// Quick-insert INPUTS parameter chips row for "Use or create by INPUTS parameter"
					const tblParamChipsRow = append(dbSection, $('div', {
						style: 'display: none; align-items: center; gap: 6px; flex-wrap: wrap; padding-left: 80px;'
					}));
					let isTblParamChipsExpanded = false;
					const renderTableParamChips = () => {
						if (tblNameInp.style.display === 'none') {
							renderTblNameTokenized();
						}
						clearNode(tblParamChipsRow);
						const isParamSelected = tblSelect.value === '__param__' || /\{[^{}]+\}/.test(tblNameInp.value);
						if (!isParamSelected) {
							tblParamChipsRow.style.display = 'none';
							return;
						}
						tblParamChipsRow.style.display = 'flex';
						append(tblParamChipsRow, $('span', {
							style: 'font-size: 10.5px; color: #c084fc; opacity: 0.9;'
						}, 'INPUTS Table Variable:'));

						const paramTokens: string[] = [];
						for (const f of fields) {
							if (f.type === 'parameters' && Array.isArray(f.parameters)) {
								for (const p of f.parameters) {
									const pName = (p.name || '').trim();
									if (pName && !paramTokens.includes(pName)) {
										paramTokens.push(pName);
									}
								}
							}
						}
						if (paramTokens.length === 0) {
							paramTokens.push('table name');
						}
						const maxVisibleTblParams = 4;
						const visibleTokens = paramTokens.slice(0, maxVisibleTblParams);
						const hiddenTokens = paramTokens.slice(maxVisibleTblParams);

						const renderTblParamChip = (parentEl: HTMLElement, token: string) => {
							const chip = append(parentEl, $('button', {
								type: 'button',
								title: `Set Target Table variable to {${token}}`,
								style: 'padding: 1px 7px; font-size: 10px; font-family: var(--vscode-editor-font-family, monospace); border-radius: 10px; border: 1px solid rgba(168, 85, 247, 0.45); background: rgba(168, 85, 247, 0.14); color: #d8b4fe; cursor: pointer; white-space: nowrap;'
							}, `+ {${token}}`));
							chip.onclick = () => {
								tblNameInp.value = `{${token}}`;
								field.tableDbTableName = `{${token}}`;
								tblSelect.value = '__param__';
								renderTblNameTokenized(`{${token}}`);
								this._syncDraft();
								this._persistCurrentModule().catch(() => { });
							};
						};

						visibleTokens.forEach(token => renderTblParamChip(tblParamChipsRow, token));

						if (hiddenTokens.length > 0) {
							const hiddenContainer = append(tblParamChipsRow, $('span', {
								style: isTblParamChipsExpanded ? 'display: contents;' : 'display: none;'
							}));
							hiddenTokens.forEach(token => renderTblParamChip(hiddenContainer, token));

							const moreBtn = append(tblParamChipsRow, $('button', {
								type: 'button',
								style: 'padding: 1px 7px; font-size: 10px; font-weight: 600; border-radius: 10px; border: 1px dashed rgba(168, 85, 247, 0.5); background: rgba(168, 85, 247, 0.08); color: #d8b4fe; cursor: pointer; white-space: nowrap;'
							}, isTblParamChipsExpanded ? 'Less' : `+${hiddenTokens.length} More...`));
							moreBtn.onclick = () => {
								isTblParamChipsExpanded = !isTblParamChipsExpanded;
								hiddenContainer.style.display = isTblParamChipsExpanded ? 'contents' : 'none';
								moreBtn.textContent = isTblParamChipsExpanded ? 'Less' : `+${hiddenTokens.length} More...`;
							};
						}
					};
					referenceChipRefreshers.push(renderTableParamChips);

					// Step 3: SQLite Direct Operation Bar (Save / Update / Load / Delete Data)
					const dbOpsBar = append(dbSection, $('div', {
						style: 'display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding-top: 4px; border-top: 1px solid rgba(255, 255, 255, 0.06);'
					}));
					const dbOpsButtons = append(dbOpsBar, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;'
					}));

					const saveToDbBtn = append(dbOpsButtons, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 4px; background: rgba(20, 184, 166, 0.22); color: #2dd4bf; border: 1px solid rgba(20, 184, 166, 0.5); cursor: pointer; display: inline-flex; align-items: center; gap: 5px;',
						title: 'Create table if needed and store (overwrite) current grid rows into SQLite'
					}));
					append(saveToDbBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.cloudUpload)));
					append(saveToDbBtn, $('span', {}, 'Save to SQLite'));

					const updateInDbBtn = append(dbOpsButtons, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 4px; background: rgba(56, 189, 248, 0.18); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.45); cursor: pointer; display: inline-flex; align-items: center; gap: 5px;',
						title: 'Update / Upsert current table schema and rows in SQLite'
					}));
					append(updateInDbBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.sync)));
					append(updateInDbBtn, $('span', {}, 'Update in SQLite'));

					const loadFromDbBtn = append(dbOpsButtons, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 4px; background: rgba(168, 85, 247, 0.16); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.4); cursor: pointer; display: inline-flex; align-items: center; gap: 5px;',
						title: 'Load table schema and rows from SQLite into this grid'
					}));
					append(loadFromDbBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.cloudDownload)));
					append(loadFromDbBtn, $('span', {}, 'Load from SQLite'));

					const deleteDbDataBtn = append(dbOpsButtons, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 4px; background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); cursor: pointer; display: inline-flex; align-items: center; gap: 5px;',
						title: 'Delete all rows of this table inside the SQLite database'
					}));
					append(deleteDbDataBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
					append(deleteDbDataBtn, $('span', {}, 'Delete Data in SQLite'));

					const dbOpStatusEl = append(dbOpsBar, $('span', {
						style: 'font-size: 10.5px; color: #94a3b8; font-family: var(--vscode-editor-font-family, monospace);'
					}, field.tableDbPath ? `Bound: ${field.tableDbTableName || 'unconfirmed'}` : 'Step 1: Select or create a SQLite file above.'));

					let knownDbTables: string[] = [];

					const computeColumnDiff = (uiCols: Array<{ name: string; dataType?: string; primaryKey?: boolean }>, dbCols: Array<{ name: string; dataType?: string; primaryKey?: boolean }>) => {
						const uiMap = new Map<string, { name: string; dataType: string; primaryKey: boolean }>();
						uiCols.forEach(c => {
							const n = (c.name || '').trim();
							if (n) {
								uiMap.set(n.toLowerCase(), { name: n, dataType: normalizeColDataType(c.dataType), primaryKey: Boolean(c.primaryKey) });
							}
						});
						const dbMap = new Map<string, { name: string; dataType: string; primaryKey: boolean }>();
						dbCols.forEach(c => {
							const n = (c.name || '').trim();
							if (n) {
								dbMap.set(n.toLowerCase(), { name: n, dataType: normalizeColDataType(c.dataType), primaryKey: Boolean(c.primaryKey) });
							}
						});

						const added: string[] = [];
						const removed: string[] = [];
						const modified: string[] = [];

						uiMap.forEach((uCol, key) => {
							const dCol = dbMap.get(key);
							if (!dCol) {
								added.push(`${uCol.name} (${uCol.dataType}${uCol.primaryKey ? ', PK' : ''})`);
							} else if (uCol.dataType !== dCol.dataType || uCol.primaryKey !== dCol.primaryKey || uCol.name !== dCol.name) {
								modified.push(`${uCol.name} (DB: ${dCol.name} ${dCol.dataType}${dCol.primaryKey ? ' PK' : ''} -> UI: ${uCol.name} ${uCol.dataType}${uCol.primaryKey ? ' PK' : ''})`);
							}
						});
						dbMap.forEach((dCol, key) => {
							if (!uiMap.has(key)) {
								removed.push(`${dCol.name} (${dCol.dataType}${dCol.primaryKey ? ', PK' : ''})`);
							}
						});

						return { added, removed, modified, hasDiff: added.length > 0 || removed.length > 0 || modified.length > 0 };
					};

					updateSchemaDiffBanner = () => {
						clearNode(schemaDiffBanner);
						if (!lastKnownDbColumns) {
							if (hasLocalColumnEdits) {
								schemaDiffBanner.style.display = 'flex';
								append(schemaDiffBanner, $('span', {}, `Unsaved local column edits for '${tblNameInp.value.trim() || field.tableDbTableName || ''}'. Click "Update Header" to write to SQLite.`));
							} else {
								schemaDiffBanner.style.display = 'none';
							}
							return;
						}
						const diff = computeColumnDiff(field.tableColumns || [], lastKnownDbColumns);
						const exactEqual = areSchemasEqual(field.tableColumns || [], lastKnownDbColumns);
						if (!diff.hasDiff && exactEqual) {
							schemaDiffBanner.style.display = 'none';
							return;
						}
						schemaDiffBanner.style.display = 'flex';
						const parts: string[] = [];
						if (diff.added.length > 0) { parts.push(`Added (+): ${diff.added.join(', ')}`); }
						if (diff.removed.length > 0) { parts.push(`Removed (-): ${diff.removed.join(', ')}`); }
						if (diff.modified.length > 0) { parts.push(`Modified (~): ${diff.modified.join(', ')}`); }
						if (parts.length === 0 && !exactEqual) {
							parts.push('Column order or attribute changed');
						}
						append(schemaDiffBanner, $('span', {}, `Unsaved column changes vs SQLite table '${tblNameInp.value.trim() || field.tableDbTableName || ''}': ${parts.join(' | ')}. Click "Update Header" to write to DB or "Query Table Columns" to reload from DB.`));
					};

					const reconcileSchemaChanges = async (
						tblLabel: string,
						prevDbCols: ITableColumnDefinition[],
						localCols: ITableColumnDefinition[],
						newDbCols: ITableColumnDefinition[],
						newTableExists: boolean
					): Promise<{ nextCols: ITableColumnDefinition[]; nextDirty: boolean }> => {
						if (!newTableExists) {
							const confirmRes = await this.dialogService.confirm({
								type: 'warning',
								message: `Table '${tblLabel}' Was Dropped in SQLite`,
								detail: `The SQL execution dropped table '${tblLabel}', while you have unsaved local column edits in Table Columns.\n\nWould you like to clear Table Columns to match the dropped table, or keep your local column definitions?`,
								primaryButton: 'Clear Table Columns',
								cancelButton: 'Keep Local Edits'
							});
							if (confirmRes.confirmed) {
								return { nextCols: [], nextDirty: false };
							}
							return { nextCols: cloneColumnsList(localCols), nextDirty: true };
						}

						const prevMap = new Map<string, ITableColumnDefinition>();
						prevDbCols.forEach(c => prevMap.set(c.name.toLowerCase(), c));
						const localMap = new Map<string, ITableColumnDefinition>();
						localCols.forEach(c => localMap.set(c.name.toLowerCase(), c));
						const newDbMap = new Map<string, ITableColumnDefinition>();
						newDbCols.forEach(c => newDbMap.set(c.name.toLowerCase(), c));

						const localAdded = localCols.filter(c => !prevMap.has(c.name.toLowerCase()));
						const localRemovedKeys = new Set<string>();
						prevDbCols.forEach(c => {
							if (!localMap.has(c.name.toLowerCase())) {
								localRemovedKeys.add(c.name.toLowerCase());
							}
						});
						const localModifiedMap = new Map<string, ITableColumnDefinition>();
						localCols.forEach(c => {
							const p = prevMap.get(c.name.toLowerCase());
							if (p && !areSchemasEqual([p], [c])) {
								localModifiedMap.set(c.name.toLowerCase(), c);
							}
						});

						let hasConflict = false;
						for (const la of localAdded) {
							const dbMatch = newDbMap.get(la.name.toLowerCase());
							if (dbMatch && !areSchemasEqual([la], [dbMatch])) {
								hasConflict = true;
							}
						}
						localModifiedMap.forEach((locCol, key) => {
							const prevCol = prevMap.get(key);
							const nextDbCol = newDbMap.get(key);
							if (!nextDbCol || (prevCol && !areSchemasEqual([prevCol], [nextDbCol]))) {
								hasConflict = true;
							}
						});

						const mergedCols: ITableColumnDefinition[] = [];
						for (const dbCol of newDbCols) {
							const key = dbCol.name.toLowerCase();
							const prevCol = prevMap.get(key);
							if (localRemovedKeys.has(key) && prevCol && areSchemasEqual([prevCol], [dbCol])) {
								continue;
							}
							const locMod = localModifiedMap.get(key);
							if (locMod && prevCol && areSchemasEqual([prevCol], [dbCol])) {
								mergedCols.push(cloneColumnDef(locMod, mergedCols.length));
							} else {
								mergedCols.push(cloneColumnDef(dbCol, mergedCols.length));
							}
						}
						for (const la of localAdded) {
							if (!newDbMap.has(la.name.toLowerCase())) {
								mergedCols.push(cloneColumnDef(la, mergedCols.length));
							}
						}

						if (hasConflict) {
							const confirmRes = await this.dialogService.confirm({
								type: 'warning',
								message: `Database Schema Changed for '${tblLabel}'`,
								detail: `The SQL execution modified the schema of '${tblLabel}' in SQLite, which conflicts with your unsaved local edits in Table Columns.\n\nChoose "Keep Reconciled Local Edits" to merge your local changes with the new DB schema, or "Use Database Schema" to adopt the exact SQLite schema.`,
								primaryButton: 'Keep Reconciled Local Edits',
								cancelButton: 'Use Database Schema'
							});
							if (!confirmRes.confirmed) {
								return { nextCols: cloneColumnsList(newDbCols), nextDirty: false };
							}
						} else {
							this.notificationService.info(`Synchronized SQLite schema changes for '${tblLabel}' while preserving your unsaved local column edits.`);
						}

						const stillDirty = !areSchemasEqual(mergedCols, newDbCols);
						return { nextCols: mergedCols, nextDirty: stillDirty };
					};

					const isParamTableExpr = (val: string): boolean => /\{[^{}]+\}/.test(val.trim());

					const resolveTargetTableName = (rawInput?: string): { rawExpr: string; resolvedTable: string; isParamExpr: boolean } => {
						const rawExpr = (rawInput ?? tblNameInp.value).trim();
						if (!rawExpr) {
							return { rawExpr: '', resolvedTable: '', isParamExpr: false };
						}
						const isParam = isParamTableExpr(rawExpr) || tblSelect.value === '__param__';
						if (!isParam) {
							const cleaned = rawExpr.replace(/[^a-zA-Z0-9_]/g, '_');
							return { rawExpr: cleaned, resolvedTable: cleaned, isParamExpr: false };
						}
						const normalizedExpr = isParamTableExpr(rawExpr) ? rawExpr : `{${rawExpr}}`;
						const allFields = (this._activeModule?.fields && this._activeModule.fields.length > 0) ? this._activeModule.fields : fields;
						const interpolated = this._interpolateSchemaReferences(normalizedExpr, field, allFields).trim();
						// If parameter has a default/resolved value, use it; otherwise derive a safe SQLite identifier from the variable name
						const candidate = (!interpolated || isParamTableExpr(interpolated))
							? normalizedExpr.replace(/\{|\}/g, '').trim()
							: interpolated;
						const resolvedTable = candidate.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'param_table';
						return { rawExpr: normalizedExpr, resolvedTable, isParamExpr: true };
					};

					const populateTableSelectDropdown = (tables: string[], currentTarget?: string) => {
						knownDbTables = tables;
						clearNode(tblSelect);
						const target = (currentTarget ?? tblNameInp.value.trim()).trim();
						const targetIsParam = isParamTableExpr(target);

						if (tables.length > 0) {
							tables.forEach(tName => {
								const opt = append(tblSelect, $('option', { value: tName }, `Existing Table: ${tName}`)) as HTMLOptionElement;
								if (!targetIsParam && target && tName.toLowerCase() === target.toLowerCase()) {
									opt.selected = true;
								}
							});
						}
						const newOpt = append(tblSelect, $('option', { value: '__new__' }, tables.length > 0 ? '+ Create New Table (Enter Name)...' : '+ Create New Table (No tables in DB yet)')) as HTMLOptionElement;
						const paramOpt = append(tblSelect, $('option', { value: '__param__' }, 'Use or create by INPUTS parameter')) as HTMLOptionElement;

						const matchedExisting = !targetIsParam ? tables.find(t => target && t.toLowerCase() === target.toLowerCase()) : undefined;
						if (targetIsParam) {
							paramOpt.selected = true;
							tblNameInp.placeholder = 'Enter INPUTS table variable, e.g. {table name}';
						} else if (!matchedExisting) {
							newOpt.selected = true;
							tblNameInp.placeholder = 'Enter new or target table name (e.g. Job_Data)';
						} else {
							tblNameInp.value = matchedExisting;
							if (field.tableDbTableName !== matchedExisting) {
								field.tableDbTableName = matchedExisting;
								this._syncDraft();
							}
							tblNameInp.placeholder = 'Enter new or target table name (e.g. Job_Data)';
						}
						renderTableParamChips();
					};

					const syncTableSchemaFromSqlite = async (opts?: { isInitialLoad?: boolean; loadFirstPageRows?: boolean }) => {
						const dbPath = dbPathInp.value.trim();
						if (!dbPath || (field.tableDbEngine || 'sqlite') === 'none') {
							return;
						}
						const { rawExpr, resolvedTable, isParamExpr } = resolveTargetTableName();
						if (!resolvedTable) {
							return;
						}
						const runtime = this._instantiationService.invokeFunction(accessor => {
							try { return accessor.get(ITicketWorkflowRuntimeService); } catch { return undefined; }
						});
						if (!runtime) {
							return;
						}
						const reqSeq = ++schemaLoadSeq;
						const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);
						const inspectRes = await runtime.executeSqliteTableOperation({
							workspaceUri: wsUri,
							dbPath,
							tableName: resolvedTable,
							action: 'inspect_schema'
						});
						if (reqSeq !== schemaLoadSeq) {
							return;
						}
						if (inspectRes.success && Array.isArray(inspectRes.tables)) {
							populateTableSelectDropdown(inspectRes.tables, rawExpr);
						}
						if (inspectRes.success && inspectRes.tableExists && Array.isArray(inspectRes.columns)) {
							const actualCols = cloneColumnsList(inspectRes.columns);
							lastKnownTableExists = true;
							lastKnownDbColumns = cloneColumnsList(actualCols);
							if (typeof inspectRes.rowCount === 'number') {
								totalDbRowCount = inspectRes.rowCount;
							}
							const hadDiffFromSaved = !areSchemasEqual(field.tableColumns, actualCols);
							if (!hasLocalColumnEdits) {
								field.tableColumns = cloneColumnsList(actualCols);
								hasLocalColumnEdits = false;
							}
							if (opts?.loadFirstPageRows) {
								const loadRes = await runtime.executeSqliteTableOperation({
									workspaceUri: wsUri,
									dbPath,
									tableName: resolvedTable,
									action: 'load',
									limit: pageSize,
									offset: 0
								});
								if (reqSeq !== schemaLoadSeq) {
									return;
								}
								if (loadRes.success && Array.isArray(loadRes.rows)) {
									field.tableRows = loadRes.rows;
									currentPage = 1;
								}
							}
							lastConfirmedDbPath = dbPath;
							lastConfirmedTableExpr = rawExpr;
							field.tableDbPath = dbPath;
							field.tableDbTableName = rawExpr;
							const prevViewportScroll = mainViewport.scrollTop;
							renderColumnsBuilder();
							renderGridTable();
							updateSchemaDiffBanner();
							updateStatsBadge();
							if (opts?.isInitialLoad && !this._userHasScrolledSinceRender) {
								applySavedScrollPosition();
							} else if (prevViewportScroll > 0) {
								mainViewport.scrollTop = prevViewportScroll;
							}
							this._syncDraft();
							if (hadDiffFromSaved || !opts?.isInitialLoad) {
								await this._persistCurrentModule();
							}
							const labelDesc = isParamExpr ? `${rawExpr} -> '${inspectRes.tableName || resolvedTable}'` : `'${inspectRes.tableName || resolvedTable}'`;
							dbOpStatusEl.textContent = `Loaded schema from SQLite table ${labelDesc} (${actualCols.length} col(s), ${inspectRes.rowCount ?? 0} row(s)).`;
							dbOpStatusEl.style.color = '#34d399';
						} else if (inspectRes.success && !inspectRes.tableExists) {
							lastKnownTableExists = false;
							lastKnownDbColumns = [];
							lastConfirmedDbPath = dbPath;
							lastConfirmedTableExpr = rawExpr;
							field.tableDbPath = dbPath;
							field.tableDbTableName = rawExpr;
							updateSchemaDiffBanner();
							updateStatsBadge();
							this._syncDraft();
							const tblCount = Array.isArray(inspectRes.tables) ? inspectRes.tables.length : 0;
							dbOpStatusEl.textContent = tblCount > 0
								? `Found ${tblCount} table(s) in DB. Table '${resolvedTable}' not created yet.`
								: `Database has 0 tables. Enter a new table name and click "Confirm Table".`;
							dbOpStatusEl.style.color = '#5eead4';
						}
					};

					tblSelect.onchange = async () => {
						if (tblSelect.value === '__param__') {
							tblNameInp.placeholder = 'Enter INPUTS table variable, e.g. {table name}';
							const currentVal = tblNameInp.value.trim();
							if (!currentVal || knownDbTables.some(t => t.toLowerCase() === currentVal.toLowerCase())) {
								let defaultParamToken = 'table name';
								for (const f of fields) {
									if (f.type === 'parameters' && Array.isArray(f.parameters) && f.parameters.length > 0) {
										const firstParam = (f.parameters[0].name || '').trim();
										if (firstParam) {
											defaultParamToken = firstParam;
											break;
										}
									}
								}
								tblNameInp.value = `{${defaultParamToken}}`;
							} else if (!isParamTableExpr(currentVal)) {
								tblNameInp.value = `{${currentVal}}`;
							}
							field.tableDbTableName = tblNameInp.value.trim();
							renderTblNameTokenized();
							renderTableParamChips();
							this._syncDraft();
						} else if (tblSelect.value !== '__new__') {
							const nextTableVal = tblSelect.value;
							if (nextTableVal.toLowerCase() !== (lastConfirmedTableExpr || '').toLowerCase() && isSchemaDirty()) {
								const confirmSwitch = await this.dialogService.confirm({
									type: 'warning',
									message: `Discard Unsaved Column Edits?`,
									detail: `You have unsaved local modifications in Table Columns. Switching to table '${nextTableVal}' will load its schema from SQLite and discard your unsaved local changes.`,
									primaryButton: 'Switch Table & Load Schema',
									cancelButton: 'Cancel'
								});
								if (!confirmSwitch.confirmed) {
									populateTableSelectDropdown(knownDbTables, lastConfirmedTableExpr);
									return;
								}
							}
							hasLocalColumnEdits = false;
							tblNameInp.placeholder = 'Enter new or target table name (e.g. Job_Data)';
							tblNameInp.value = nextTableVal;
							field.tableDbTableName = nextTableVal;
							renderTblNameTokenized();
							renderTableParamChips();
							this._syncDraft();
							await syncTableSchemaFromSqlite({ isInitialLoad: false, loadFirstPageRows: true });
						} else {
							tblNameInp.placeholder = 'Enter new or target table name (e.g. Job_Data)';
							if (isParamTableExpr(tblNameInp.value)) {
								tblNameInp.value = tblNameInp.value.replace(/\{|\}/g, '').trim().replace(/[^a-zA-Z0-9_]/g, '_');
								field.tableDbTableName = tblNameInp.value;
							}
							renderTblNameTokenized();
							renderTableParamChips();
							this._syncDraft();
							switchToTblNameEdit(true);
						}
					};

					tblNameInp.oninput = () => {
						const rawVal = tblNameInp.value.trim();
						if (tblSelect.value === '__param__' || isParamTableExpr(rawVal)) {
							field.tableDbTableName = rawVal;
							tblSelect.value = '__param__';
							tblNameInp.placeholder = 'Enter INPUTS table variable, e.g. {table name}';
						} else {
							const cleaned = rawVal.replace(/[^a-zA-Z0-9_]/g, '_');
							field.tableDbTableName = cleaned;
							const matched = knownDbTables.find(t => t.toLowerCase() === cleaned.toLowerCase());
							tblSelect.value = matched ? matched : '__new__';
						}
						updateTblNameAutocomplete();
						renderTableParamChips();
						this._syncDraft();
					};
					tblNameInp.onkeydown = (ev) => {
						if (ev.key === 'Escape' && tblNameAutocompleteMenu.style.display !== 'none') {
							ev.stopPropagation();
							tblNameAutocompleteMenu.style.display = 'none';
						} else if (ev.key === 'Enter') {
							ev.preventDefault();
							tblNameInp.blur();
						}
					};

					const refreshDbTablesList = async (autoSelectFirstIfEmpty: boolean = false) => {
						const dbPath = dbPathInp.value.trim();
						if (!dbPath) {
							populateTableSelectDropdown([], tblNameInp.value.trim());
							return;
						}
						const runtime = this._instantiationService.invokeFunction(accessor => {
							try { return accessor.get(ITicketWorkflowRuntimeService); } catch { return undefined; }
						});
						if (!runtime) { return; }
						const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);
						const { resolvedTable } = resolveTargetTableName();
						const res = await runtime.executeSqliteTableOperation({
							workspaceUri: wsUri,
							dbPath,
							tableName: resolvedTable || 'ticket_table',
							action: 'list_tables'
						});
						if (res.success && Array.isArray(res.tables)) {
							if (autoSelectFirstIfEmpty && !tblNameInp.value.trim() && res.tables.length > 0) {
								tblNameInp.value = res.tables[0];
								field.tableDbTableName = res.tables[0];
								this._syncDraft();
							}
							populateTableSelectDropdown(res.tables, tblNameInp.value.trim());
							dbOpStatusEl.textContent = res.tables.length > 0
								? `Found ${res.tables.length} table(s) in DB. Select or enter table name and click "Confirm Table".`
								: `Database has 0 tables. Enter a new table name and click "Confirm Table".`;
							dbOpStatusEl.style.color = '#5eead4';
						} else {
							populateTableSelectDropdown([], tblNameInp.value.trim());
						}
					};

					populateTableSelectDropdown([], field.tableDbTableName || '');
					if (field.tableDbPath) {
						// Requirement 1: On initialization, read the selected database and table,
						// retrieve the actual column definitions directly from SQLite, and populate Table Columns.
						syncTableSchemaFromSqlite({ isInitialLoad: true }).catch(() => { });
					}

					refreshTablesBtn.onclick = () => {
						refreshDbTablesList(false);
					};

					dbPathInp.onblur = async () => {
						const nextDbPath = dbPathInp.value.trim();
						if (!nextDbPath) {
							return;
						}
						if (nextDbPath !== lastConfirmedDbPath && isSchemaDirty()) {
							const confirmDbSwitch = await this.dialogService.confirm({
								type: 'warning',
								message: 'Discard Unsaved Column Edits?',
								detail: `You have unsaved local modifications in Table Columns. Switching the SQLite database to '${nextDbPath}' will load the schema from the selected database and discard your unsaved local changes.`,
								primaryButton: 'Switch Database & Load Schema',
								cancelButton: 'Cancel'
							});
							if (!confirmDbSwitch.confirmed) {
								dbPathInp.value = lastConfirmedDbPath;
								field.tableDbPath = lastConfirmedDbPath;
								updateStatsBadge();
								this._syncDraft();
								return;
							}
						}
						if (nextDbPath !== lastConfirmedDbPath) {
							hasLocalColumnEdits = false;
						}
						await refreshDbTablesList(true);
						await syncTableSchemaFromSqlite({ isInitialLoad: false, loadFirstPageRows: false });
					};

					confirmTableBtn.onclick = async () => {
						const dbPath = dbPathInp.value.trim();
						if (!dbPath) {
							this.notificationService.warn('Please specify, select, or create a SQLite database file first.');
							return;
						}
						const rawSelection = (tblSelect.value !== '__new__' && tblSelect.value !== '__param__')
							? tblSelect.value
							: tblNameInp.value.trim();
						const { rawExpr, resolvedTable, isParamExpr } = resolveTargetTableName(rawSelection);
						if (!resolvedTable) {
							this.notificationService.warn('Please select an existing table, enter a new table name, or enter an INPUTS variable (e.g. {table name}) before confirming.');
							tblNameInp.focus();
							return;
						}

						const runtime = this._instantiationService.invokeFunction(accessor => {
							try { return accessor.get(ITicketWorkflowRuntimeService); } catch { return undefined; }
						});
						if (!runtime) { return; }
						const reqSeq = ++schemaLoadSeq;
						const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);

						const inspectRes = await runtime.executeSqliteTableOperation({
							workspaceUri: wsUri,
							dbPath,
							tableName: resolvedTable,
							action: 'inspect_schema'
						});
						if (reqSeq !== schemaLoadSeq) {
							return;
						}

						if (inspectRes.success && inspectRes.tableExists && isSchemaDirty()) {
							const confirmOverwrite = await this.dialogService.confirm({
								type: 'warning',
								message: `Load Columns from Existing Table '${resolvedTable}'?`,
								detail: `You have unsaved local modifications in Table Columns. Confirming existing table '${resolvedTable}' will load its actual schema from SQLite and replace your unsaved local column edits.`,
								primaryButton: 'Load Table Schema from SQLite',
								cancelButton: 'Cancel'
							});
							if (!confirmOverwrite.confirmed) {
								return;
							}
						}

						tblNameInp.value = rawExpr;
						field.tableDbPath = dbPath;
						field.tableDbTableName = rawExpr;
						lastConfirmedDbPath = dbPath;
						lastConfirmedTableExpr = rawExpr;
						updateStatsBadge();
						this._syncDraft();

						if (inspectRes.success && Array.isArray(inspectRes.tables)) {
							populateTableSelectDropdown(inspectRes.tables, rawExpr);
						}

						if (inspectRes.success && inspectRes.tableExists) {
							// Existing table selected -> load schema and first page as active query scope
							const actualCols = cloneColumnsList(inspectRes.columns);
							lastKnownTableExists = true;
							lastKnownDbColumns = cloneColumnsList(actualCols);
							field.tableColumns = cloneColumnsList(actualCols);
							hasLocalColumnEdits = false;
							await runSqliteOp('load', 1, pageSize, true);
							updateSchemaDiffBanner();
							const labelDesc = isParamExpr ? `${rawExpr} -> '${resolvedTable}'` : `'${resolvedTable}'`;
							dbOpStatusEl.textContent = `Confirmed existing table ${labelDesc} (${actualCols.length} cols, ${inspectRes.rowCount ?? 0} rows) as active query scope.`;
							dbOpStatusEl.style.color = '#34d399';
							this.notificationService.info(`Selected existing table ${labelDesc} (${actualCols.length} columns, ${inspectRes.rowCount ?? 0} rows).`);
						} else if (isParamExpr) {
							// Use or create by INPUTS parameter: create table immediately with current header columns if not existing yet
							const createRes = await runtime.executeSqliteTableOperation({
								workspaceUri: wsUri,
								dbPath,
								tableName: resolvedTable,
								action: 'update_header',
								columns: field.tableColumns || [],
								rows: field.tableRows || []
							});
							if (reqSeq !== schemaLoadSeq) {
								return;
							}
							if (createRes.success) {
								if (Array.isArray(createRes.tables)) {
									populateTableSelectDropdown(createRes.tables, rawExpr);
								}
								const createdCols = cloneColumnsList(createRes.columns || field.tableColumns || []);
								lastKnownTableExists = true;
								lastKnownDbColumns = cloneColumnsList(createdCols);
								field.tableColumns = cloneColumnsList(createdCols);
								hasLocalColumnEdits = false;
								renderColumnsBuilder();
								renderGridTable();
								updateSchemaDiffBanner();
								await this._persistCurrentModule();
								dbOpStatusEl.textContent = `Bound INPUTS parameter ${rawExpr} -> created/verified table '${resolvedTable}' in SQLite.`;
								dbOpStatusEl.style.color = '#34d399';
								this.notificationService.info(`Confirmed INPUTS parameter ${rawExpr}: table '${resolvedTable}' is ready in SQLite.`);
							} else {
								await this._persistCurrentModule();
								dbOpStatusEl.textContent = `Bound INPUTS parameter ${rawExpr} (resolved: '${resolvedTable}').`;
								dbOpStatusEl.style.color = '#fbbf24';
							}
						} else {
							// New table name -> reserve table name for SQL creation or "Update Header" without creating prematurely
							lastKnownTableExists = false;
							lastKnownDbColumns = [];
							updateSchemaDiffBanner();
							await this._persistCurrentModule();
							dbOpStatusEl.textContent = `Confirmed new table '${resolvedTable}' (not created in DB yet — create via SQL or click "Update Header" below).`;
							dbOpStatusEl.style.color = '#fbbf24';
							this.notificationService.info(`Confirmed new table name '${resolvedTable}'. You can now create it via SQL or by clicking "Update Header" in the Table Header Columns section.`);
						}
					};

					const runSqliteOp = async (
						action: 'save' | 'update' | 'load' | 'load_schema' | 'delete_data',
						pageOverride?: number,
						pageSizeOverride?: number,
						skipDirtyConfirm: boolean = false,
						preserveDirtyColumnsOnPageLoad: boolean = false
					) => {
						const runtime = this._instantiationService.invokeFunction(accessor => {
							try { return accessor.get(ITicketWorkflowRuntimeService); } catch { return undefined; }
						});
						const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);
						if (!runtime) {
							this.notificationService.warn('Workflow runtime service is unavailable.');
							return;
						}
						const dbPath = dbPathInp.value.trim();
						const { rawExpr, resolvedTable: tblName } = resolveTargetTableName();
						if (!dbPath) {
							this.notificationService.warn('Please select or create a SQLite database file first.');
							return;
						}
						if (!tblName) {
							this.notificationService.warn('Please select or enter a Target Table name and click "Confirm Table" first.');
							tblNameInp.focus();
							return;
						}

						if ((action === 'load_schema' || (action === 'load' && !preserveDirtyColumnsOnPageLoad)) && !skipDirtyConfirm && isSchemaDirty()) {
							const confirmDiscard = await this.dialogService.confirm({
								type: 'warning',
								message: `Overwrite Unsaved Column Edits for '${tblName}'?`,
								detail: `You have unsaved local modifications in Table Columns. Reloading from SQLite will overwrite Table Columns with the actual database schema of '${tblName}'.`,
								primaryButton: 'Reload from SQLite',
								cancelButton: 'Cancel'
							});
							if (!confirmDiscard.confirmed) {
								return;
							}
						}

						const reqSeq = ++schemaLoadSeq;
						field.tableDbPath = dbPath;
						field.tableDbTableName = rawExpr;
						const reqPage = pageOverride && pageOverride > 0 ? pageOverride : currentPage;
						const reqSize = pageSizeOverride && pageSizeOverride > 0 ? pageSizeOverride : pageSize;
						dbOpStatusEl.textContent = `Running '${action}' on ${tblName}...`;
						dbOpStatusEl.style.color = '#38bdf8';

						if (action === 'load_schema') {
							const prevUiCols = cloneColumnsList(field.tableColumns);
							const res = await runtime.executeSqliteTableOperation({
								workspaceUri: wsUri,
								dbPath,
								tableName: tblName,
								action: 'load_schema',
								columns: field.tableColumns || []
							});
							if (reqSeq !== schemaLoadSeq) {
								return;
							}
							if (res.success) {
								if (typeof res.rowCount === 'number') {
									totalDbRowCount = res.rowCount;
								}
								const loadedCols = cloneColumnsList(res.columns);
								lastKnownTableExists = true;
								lastKnownDbColumns = cloneColumnsList(loadedCols);
								field.tableColumns = cloneColumnsList(loadedCols);
								hasLocalColumnEdits = false;
								const diff = computeColumnDiff(prevUiCols, loadedCols);
								if (diff.hasDiff || !areSchemasEqual(prevUiCols, loadedCols)) {
									const diffNotes: string[] = [];
									if (diff.removed.length > 0) { diffNotes.push(`In DB (+loaded): ${diff.removed.join(', ')}`); }
									if (diff.added.length > 0) { diffNotes.push(`Local only (-replaced): ${diff.added.join(', ')}`); }
									if (diff.modified.length > 0) { diffNotes.push(`Type/PK changes: ${diff.modified.join(', ')}`); }
									this.notificationService.info(`Synced ${loadedCols.length} column(s) from '${tblName}'${diffNotes.length > 0 ? ` — ${diffNotes.join(' | ')}` : ''}.`);
								} else {
									this.notificationService.info(res.message || `Queried ${loadedCols.length} column(s) from '${tblName}' (matches current header).`);
								}
								renderColumnsBuilder();
								renderGridTable();
								updateSchemaDiffBanner();
								updateStatsBadge();
								this._syncDraft();
								await this._persistCurrentModule();
								dbOpStatusEl.textContent = res.message || `Loaded schema for '${tblName}'.`;
								dbOpStatusEl.style.color = '#34d399';
							} else {
								if (res.tableExists === false) {
									lastKnownTableExists = false;
									lastKnownDbColumns = [];
									updateSchemaDiffBanner();
								}
								dbOpStatusEl.textContent = `Error: ${res.error || 'Operation failed'}`;
								dbOpStatusEl.style.color = '#f87171';
								this.notificationService.error(`SQLite Error: ${res.error || 'Operation failed'}`);
							}
							return;
						}

						const res = await runtime.executeSqliteTableOperation({
							workspaceUri: wsUri,
							dbPath,
							tableName: tblName,
							action,
							columns: field.tableColumns || [],
							rows: field.tableRows || [],
							limit: reqSize,
							offset: (reqPage - 1) * reqSize
						});
						if (reqSeq !== schemaLoadSeq) {
							return;
						}

						if (res.success) {
							if (typeof res.rowCount === 'number') {
								totalDbRowCount = res.rowCount;
							}
							if (Array.isArray(res.tables)) {
								populateTableSelectDropdown(res.tables, rawExpr);
							}
							if (action === 'load') {
								currentPage = reqPage;
								pageSize = reqSize;
								if (Array.isArray(res.columns) && res.columns.length > 0) {
									const loadedCols = cloneColumnsList(res.columns);
									lastKnownTableExists = true;
									lastKnownDbColumns = cloneColumnsList(loadedCols);
									if (!preserveDirtyColumnsOnPageLoad || !isSchemaDirty()) {
										field.tableColumns = cloneColumnsList(loadedCols);
										hasLocalColumnEdits = false;
									}
								}
								if (Array.isArray(res.rows)) {
									field.tableRows = res.rows;
								}
								renderColumnsBuilder();
								renderGridTable();
								updateSchemaDiffBanner();
								updateStatsBadge();
							} else if (action === 'delete_data') {
								totalDbRowCount = 0;
								currentPage = 1;
								field.tableRows = [];
								renderGridTable();
								updateStatsBadge();
							} else {
								if (Array.isArray(res.columns) && res.columns.length > 0) {
									const syncedCols = cloneColumnsList(res.columns);
									lastKnownTableExists = true;
									lastKnownDbColumns = cloneColumnsList(syncedCols);
									field.tableColumns = cloneColumnsList(syncedCols);
									hasLocalColumnEdits = false;
								}
								if (Array.isArray(res.rows)) {
									field.tableRows = res.rows;
								}
								renderColumnsBuilder();
								renderGridTable();
								updateSchemaDiffBanner();
								updateStatsBadge();
							}
							this._syncDraft();
							await this._persistCurrentModule();
							dbOpStatusEl.textContent = res.message || `SQLite ${action} completed (${new Date().toLocaleTimeString()}).`;
							dbOpStatusEl.style.color = '#34d399';
							this.notificationService.info(res.message || `SQLite ${action} completed.`);
						} else {
							dbOpStatusEl.textContent = `Error: ${res.error || 'Operation failed'}`;
							dbOpStatusEl.style.color = '#f87171';
							this.notificationService.error(`SQLite Error: ${res.error || 'Operation failed'}`);
						}
					};

					queryColsBtn.onclick = () => runSqliteOp('load_schema');

					updateHeaderBtn.onclick = async () => {
						const dbPath = dbPathInp.value.trim();
						const { rawExpr, resolvedTable: tblName } = resolveTargetTableName();
						if (!dbPath) {
							this.notificationService.warn('Please select or create a SQLite database file first.');
							return;
						}
						if (!tblName) {
							this.notificationService.warn('Please select or enter a Target Table name and click "Confirm Table" first.');
							tblNameInp.focus();
							return;
						}
						field.tableDbTableName = rawExpr;
						this._syncDraft();
						const runtime = this._instantiationService.invokeFunction(accessor => {
							try { return accessor.get(ITicketWorkflowRuntimeService); } catch { return undefined; }
						});
						if (!runtime) { return; }
						const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);

						const inspectRes = await runtime.executeSqliteTableOperation({
							workspaceUri: wsUri,
							dbPath,
							tableName: tblName,
							action: 'inspect_schema'
						});

						if (!inspectRes.success) {
							this.notificationService.error(`Failed to inspect SQLite database: ${inspectRes.error || 'Unknown error'}`);
							return;
						}

						const uiCols = field.tableColumns || [];
						if (inspectRes.tableExists && Array.isArray(inspectRes.columns)) {
							const diff = computeColumnDiff(uiCols, inspectRes.columns);
							const exactMatch = areSchemasEqual(uiCols, inspectRes.columns);
							if (!diff.hasDiff && exactMatch) {
								lastKnownTableExists = true;
								lastKnownDbColumns = cloneColumnsList(inspectRes.columns);
								hasLocalColumnEdits = false;
								updateSchemaDiffBanner();
								this.notificationService.info(`Table header for '${tblName}' is already in sync with the SQLite database (${uiCols.length} columns).`);
								return;
							}

							const detailLines: string[] = [
								`The columns defined in Table Header Columns differ from existing SQLite table '${tblName}':`,
								''
							];
							if (diff.added.length > 0) {
								detailLines.push(`• Columns to ADD (+): ${diff.added.join(', ')}`);
							}
							if (diff.removed.length > 0) {
								detailLines.push(`• Columns to REMOVE (-): ${diff.removed.join(', ')}`);
							}
							if (diff.modified.length > 0) {
								detailLines.push(`• Columns with Type / PK changes (~): ${diff.modified.join(', ')}`);
							}
							if (!diff.hasDiff && !exactMatch) {
								detailLines.push(`• Column order or default/nullable attributes modified.`);
							}
							detailLines.push('', 'Existing rows for matching columns will be preserved. Apply these header changes to the SQLite table?');

							const confirmRes = await this.dialogService.confirm({
								type: 'warning',
								message: `Update Table Header for '${tblName}'?`,
								detail: detailLines.join('\n'),
								primaryButton: 'Update Table Header',
								cancelButton: 'Cancel'
							});
							if (!confirmRes.confirmed) {
								return;
							}
						}

						const reqSeq = ++schemaLoadSeq;
						const updateRes = await runtime.executeSqliteTableOperation({
							workspaceUri: wsUri,
							dbPath,
							tableName: tblName,
							action: 'update_header',
							columns: uiCols,
							rows: field.tableRows || [],
							limit: pageSize,
							offset: (currentPage - 1) * pageSize
						});
						if (reqSeq !== schemaLoadSeq) {
							return;
						}

						if (updateRes.success) {
							if (Array.isArray(updateRes.columns) && updateRes.columns.length > 0) {
								const updatedCols = cloneColumnsList(updateRes.columns);
								field.tableColumns = cloneColumnsList(updatedCols);
								lastKnownTableExists = true;
								lastKnownDbColumns = cloneColumnsList(updatedCols);
								hasLocalColumnEdits = false;
							}
							if (Array.isArray(updateRes.tables)) {
								populateTableSelectDropdown(updateRes.tables, rawExpr);
							}
							renderColumnsBuilder();
							renderGridTable();
							updateSchemaDiffBanner();
							updateStatsBadge();
							this._syncDraft();
							await this._persistCurrentModule();
							dbOpStatusEl.textContent = updateRes.message || `Updated header for '${tblName}'.`;
							dbOpStatusEl.style.color = '#34d399';
							this.notificationService.info(updateRes.message || `Updated table header for '${tblName}'.`);
						} else {
							dbOpStatusEl.textContent = `Error: ${updateRes.error || 'Header update failed'}`;
							dbOpStatusEl.style.color = '#f87171';
							this.notificationService.error(`SQLite Error: ${updateRes.error || 'Header update failed'}`);
						}
					};

					pageSizeSelect.onchange = () => {
						const nextSize = parseInt(pageSizeSelect.value, 10);
						if (!isNaN(nextSize) && nextSize > 0) {
							pageSize = nextSize;
							field.tablePageSize = nextSize;
							currentPage = 1;
							this._syncDraft();
							if (dbPathInp.value.trim() && tblNameInp.value.trim()) {
								runSqliteOp('load', 1, pageSize, true, true);
							} else {
								renderGridTable();
							}
						}
					};

					queryPageBtn.onclick = () => {
						if (dbPathInp.value.trim() && tblNameInp.value.trim()) {
							runSqliteOp('load', currentPage, pageSize, true, true);
						} else {
							renderGridTable();
							this.notificationService.info(`Showing page ${currentPage} (${pageSize} rows/page) of local table data.`);
						}
					};

					prevPageBtn.onclick = () => {
						if (currentPage > 1) {
							currentPage--;
							if (dbPathInp.value.trim() && tblNameInp.value.trim() && (field.tableRows || []).length <= pageSize) {
								runSqliteOp('load', currentPage, pageSize, true, true);
							} else {
								renderGridTable();
							}
						}
					};

					nextPageBtn.onclick = () => {
						const rows = field.tableRows || [];
						const effectiveTotal = totalDbRowCount !== undefined ? Math.max(totalDbRowCount, rows.length) : rows.length;
						const totalPages = Math.max(1, Math.ceil(effectiveTotal / pageSize));
						if (currentPage < totalPages) {
							currentPage++;
							if (dbPathInp.value.trim() && tblNameInp.value.trim() && rows.length <= pageSize) {
								runSqliteOp('load', currentPage, pageSize, true, true);
							} else {
								renderGridTable();
							}
						}
					};

					browseSqliteBtn.onclick = async () => {
						const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);
						const uris = await this._fileDialogService.showOpenDialog({
							canSelectFiles: true,
							canSelectFolders: false,
							canSelectMany: false,
							defaultUri: wsUri,
							title: 'Select SQLite Database File',
							filters: [{ name: 'SQLite Database', extensions: ['sqlite', 'db', 'sqlite3'] }, { name: 'All Files', extensions: ['*'] }]
						});
						if (uris && uris.length > 0) {
							let chosen = uris[0].fsPath;
							if (wsUri && chosen.startsWith(wsUri.fsPath)) {
								chosen = chosen.substring(wsUri.fsPath.length).replace(/^[/\\]+/, '');
							}
							if (chosen !== lastConfirmedDbPath && isSchemaDirty()) {
								const confirmSwitch = await this.dialogService.confirm({
									type: 'warning',
									message: 'Discard Unsaved Column Edits?',
									detail: `You have unsaved local modifications in Table Columns. Selecting database '${chosen}' will load the schema from the selected database and discard your unsaved local changes.`,
									primaryButton: 'Select Database & Load Schema',
									cancelButton: 'Cancel'
								});
								if (!confirmSwitch.confirmed) {
									return;
								}
							}
							hasLocalColumnEdits = false;
							dbPathInp.value = chosen;
							field.tableDbPath = chosen;
							lastConfirmedDbPath = chosen;
							updateStatsBadge();
							this._syncDraft();
							await refreshDbTablesList(true);
							await syncTableSchemaFromSqlite({ isInitialLoad: false, loadFirstPageRows: true });
						}
					};

					newSqliteBtn.onclick = async () => {
						const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);
						const typedPath = dbPathInp.value.trim();
						let suggestedName = typedPath ? (typedPath.split(/[/\\]/).pop() || '') : '';
						if (!suggestedName) {
							suggestedName = 'new_database.sqlite';
						} else if (!/\.(sqlite|db|sqlite3)$/i.test(suggestedName)) {
							suggestedName = `${suggestedName}.sqlite`;
						}
						const defaultUri = wsUri ? URI.joinPath(wsUri, suggestedName) : URI.file(suggestedName);
						const saveUri = await this._fileDialogService.showSaveDialog({
							defaultUri,
							title: 'Create New SQLite Database File (Specify Filename)',
							filters: [{ name: 'SQLite Database', extensions: ['sqlite', 'db', 'sqlite3'] }]
						});
						if (saveUri) {
							let chosen = saveUri.fsPath;
							if (wsUri && chosen.startsWith(wsUri.fsPath)) {
								chosen = chosen.substring(wsUri.fsPath.length).replace(/^[/\\]+/, '');
							}
							dbPathInp.value = chosen;
							field.tableDbPath = chosen;
							updateStatsBadge();
							this._syncDraft();

							// Initialize empty SQLite file ONLY (do NOT auto-create a table yet)
							const runtime = this._instantiationService.invokeFunction(accessor => {
								try { return accessor.get(ITicketWorkflowRuntimeService); } catch { return undefined; }
							});
							if (runtime) {
								const initRes = await runtime.executeSqliteTableOperation({
									workspaceUri: wsUri,
									dbPath: chosen,
									tableName: tblNameInp.value.trim() || 'ticket_table',
									action: 'init_db'
								});
								if (initRes.success) {
									populateTableSelectDropdown(initRes.tables || [], tblNameInp.value.trim());
									dbOpStatusEl.textContent = `Created SQLite file '${chosen.split(/[/\\]/).pop()}'. Now enter/select a Target Table name and click "Confirm Table".`;
									dbOpStatusEl.style.color = '#34d399';
									this.notificationService.info(`Created empty SQLite database '${chosen.split(/[/\\]/).pop()}'. Please specify a Target Table name and click "Confirm Table".`);
								}
							}
							await this._persistCurrentModule();
						}
					};

					saveToDbBtn.onclick = () => runSqliteOp('save');
					updateInDbBtn.onclick = () => runSqliteOp('update');
					loadFromDbBtn.onclick = () => runSqliteOp('load', currentPage, pageSize);
					deleteDbDataBtn.onclick = async () => {
						const { resolvedTable: tblName } = resolveTargetTableName();
						const confirmDel = await this.dialogService.confirm({
							type: 'warning',
							message: `Delete All Rows in SQLite Table '${tblName || 'table'}'?`,
							detail: `This will permanently delete all rows from table '${tblName || 'table'}' in '${dbPathInp.value.trim()}'. This action cannot be undone.`,
							primaryButton: 'Delete All Data in SQLite',
							cancelButton: 'Cancel'
						});
						if (confirmDel.confirmed) {
							await runSqliteOp('delete_data');
						}
					};

					// =========================================================================
					// SQL Statement & Table Query Execution Section
					// =========================================================================
					const sqlHeaderRow = append(sqlSection, $('div', {
						style: 'display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;'
					}));
					const sqlTitleLeft = append(sqlHeaderRow, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.04em;'
					}));
					append(sqlTitleLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.terminal)));
					append(sqlTitleLeft, $('span', {}, 'SQL Statement & Table Query Execution'));
					append(sqlTitleLeft, $('span', {
						style: 'font-size: 10px; font-weight: 500; text-transform: none; letter-spacing: normal; opacity: 0.72; color: #cbd5e1; margin-left: 4px;'
					}, '(Supports {Field Label} output references)'));

					const sqlHeaderBtns = append(sqlHeaderRow, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;'
					}));

					const runSqlBtn = append(sqlHeaderBtns, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 4px 11px; font-size: 11px; font-weight: 600; border-radius: 4px; background: rgba(56, 189, 248, 0.22); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.5); cursor: pointer; display: inline-flex; align-items: center; gap: 5px;',
						title: 'Execute SQL statement(s) against the table and SQLite database'
					})) as HTMLButtonElement;
					append(runSqlBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.play), { style: 'font-size: 11px;' }));
					const runSqlBtnLabel = append(runSqlBtn, $('span', {}, 'Run SQL'));

					const clearSqlBtn = append(sqlHeaderBtns, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 4px 8px; font-size: 10.5px; border-radius: 4px; background: rgba(255, 255, 255, 0.06); color: inherit; border: 1px solid rgba(255, 255, 255, 0.15); cursor: pointer; display: inline-flex; align-items: center; gap: 4px;',
						title: 'Clear SQL editor and output'
					}));
					append(clearSqlBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.clearAll), { style: 'font-size: 11px;' }));
					append(clearSqlBtn, $('span', {}, 'Clear'));

					// Quick SQL Template Snippets Bar
					const sqlSnippetsBar = append(sqlSection, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;'
					}));
					append(sqlSnippetsBar, $('span', { style: 'font-size: 10.5px; opacity: 0.7;' }, 'SQL Templates:'));

					const sqlEditorWrapper = append(sqlSection, $('div.prompt-input-container', {
						style: 'position: relative; width: 100%;'
					}));

					const sqlDisplayEl = append(sqlEditorWrapper, $('div.prompt-tokenized-display', {
						style: 'min-height: 84px; padding: 8px 10px; font-size: 11.5px; line-height: 1.6; font-family: var(--vscode-editor-font-family, monospace); border-radius: 5px; border: 1px solid rgba(56, 189, 248, 0.3); background: rgba(0, 0, 0, 0.35); color: #e2e8f0; cursor: text; white-space: pre-wrap; word-break: break-word; box-sizing: border-box;'
					}));

					const sqlTextarea = append(sqlEditorWrapper, $('textarea.monaco-inputbox', {
						rows: 4,
						placeholder: 'Write SQL statements to query or modify this table. Use {Field Label} to reference outputs from other primitives (e.g. {SQL Generation} or INSERT INTO table_name (job_title) VALUES (\'{JD_Data}\');)...',
						style: 'display: none; width: 100%; min-height: 84px; padding: 8px 10px; font-size: 11.5px; line-height: 1.6; font-family: var(--vscode-editor-font-family, monospace); border-radius: 5px; border: 1px solid rgba(56, 189, 248, 0.65); background: rgba(0, 0, 0, 0.45); color: #e2e8f0; box-sizing: border-box; resize: vertical; outline: none;'
					})) as HTMLTextAreaElement;
					sqlTextarea.value = field.tableSqlQuery || '';
					tokenizedDisplayTextareas.set(sqlDisplayEl, sqlTextarea);

					const sqlAutocompleteMenu = append(sqlEditorWrapper, $('div.prompt-autocomplete-menu', {
						style: 'display: none; position: absolute; left: 8px; top: 100%; margin-top: 4px; z-index: 2500; min-width: 240px; max-height: 220px; overflow-y: auto; background: var(--vscode-editorWidget-background, #1e1e1e); border: 1px solid var(--vscode-editorWidget-border, #454545); border-radius: 6px; box-shadow: 0 6px 20px rgba(0,0,0,0.45); padding: 4px;'
					}));

					const renderSqlTokenized = (rawText: string) => {
						clearNode(sqlDisplayEl);
						if (!rawText) {
							append(sqlDisplayEl, $('span', {
								style: 'opacity: 0.45; font-style: italic;'
							}, 'Click to edit SQL statement... (Type { or @ to insert field/input references like {SQL Generation})'));
							return;
						}
						const refTokens = getReferenceTokensForField(field);
						const tokenRegex = /(\{[^{}\n]+\}|@[a-zA-Z0-9_\-\u4e00-\u9fa5]+)/g;
						let lastIdx = 0;
						let match: RegExpExecArray | null;
						while ((match = tokenRegex.exec(rawText)) !== null) {
							if (match.index > lastIdx) {
								append(sqlDisplayEl, document.createTextNode(rawText.slice(lastIdx, match.index)));
							}
							const fullMatch = match[0];
							const cleanTokenName = fullMatch.startsWith('{') && fullMatch.endsWith('}')
								? fullMatch.slice(1, -1).trim()
								: fullMatch.slice(1).trim();

							const matchedRef = refTokens.find(rt => rt.label.toLowerCase() === cleanTokenName.toLowerCase());
							if (matchedRef) {
								const pill = append(sqlDisplayEl, $('span.prompt-token-pill', {
									style: 'display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; margin: 0 2px; border-radius: 4px; font-size: 11px; font-weight: 600; background: rgba(14, 99, 156, 0.28); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); vertical-align: baseline; user-select: none;'
								}));
								this._attachInstantTooltip(pill, `${matchedRef.badge} reference: ${matchedRef.label}`, '#38bdf8');
								append(pill, $('span' + ThemeIcon.asCSSSelector(Codicon.link), { style: 'font-size: 10px;' }));
								append(pill, $('span', {}, matchedRef.label));
							} else {
								append(sqlDisplayEl, document.createTextNode(fullMatch));
							}
							lastIdx = tokenRegex.lastIndex;
						}
						if (lastIdx < rawText.length) {
							append(sqlDisplayEl, document.createTextNode(rawText.slice(lastIdx)));
						}
					};

					const switchToSqlEdit = () => {
						sqlDisplayEl.style.display = 'none';
						sqlTextarea.style.display = 'block';
						sqlTextarea.focus();
					};

					const switchToSqlDisplay = () => {
						setTimeout(() => {
							sqlAutocompleteMenu.style.display = 'none';
							sqlTextarea.style.display = 'none';
							sqlDisplayEl.style.display = 'block';
							field.tableSqlQuery = sqlTextarea.value;
							renderSqlTokenized(sqlTextarea.value);
							this._syncDraft();
							this._persistCurrentModule().catch(() => { });
						}, 180);
					};

					sqlDisplayEl.onclick = () => switchToSqlEdit();
					sqlTextarea.onblur = () => switchToSqlDisplay();

					let sqlTriggerStartIdx = -1;
					const updateSqlAutocomplete = () => {
						const pos = sqlTextarea.selectionStart || 0;
						const val = sqlTextarea.value;
						const textBefore = val.slice(0, pos);
						const match = textBefore.match(/([\{@])([a-zA-Z0-9_\-\s\u4e00-\u9fa5]*)$/);
						if (!match) {
							sqlAutocompleteMenu.style.display = 'none';
							sqlTriggerStartIdx = -1;
							return;
						}
						sqlTriggerStartIdx = pos - match[0].length;
						const query = match[2].toLowerCase().trim();
						const candidates = getReferenceTokensForField(field).filter(c => !query || c.label.toLowerCase().includes(query));
						if (candidates.length === 0) {
							sqlAutocompleteMenu.style.display = 'none';
							return;
						}
						clearNode(sqlAutocompleteMenu);
						sqlAutocompleteMenu.style.display = 'block';
						append(sqlAutocompleteMenu, $('div', {
							style: 'padding: 4px 8px; font-size: 10px; font-weight: 600; text-transform: uppercase; opacity: 0.6; border-bottom: 1px solid rgba(255,255,255,0.06); margin-bottom: 2px;'
						}, 'Insert Field / Parameter Reference'));

						candidates.forEach(cand => {
							const item = append(sqlAutocompleteMenu, $('div', {
								style: 'display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; border-radius: 4px; cursor: pointer; font-size: 12px;'
							}));
							item.onmouseenter = () => { item.style.background = 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.08))'; };
							item.onmouseleave = () => { item.style.background = 'transparent'; };

							const left = append(item, $('div', { style: 'display: flex; align-items: center; gap: 6px;' }));
							append(left, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolVariable), { style: 'color: #38bdf8; font-size: 12px;' }));
							append(left, $('span', { style: 'font-weight: 500;' }, cand.label));

							append(item, $('span', {
								style: 'font-size: 10px; opacity: 0.6; padding: 1px 5px; border-radius: 3px; background: rgba(255,255,255,0.06);'
							}, cand.badge));

							item.onmousedown = (ev) => {
								ev.preventDefault();
								const currentVal = sqlTextarea.value;
								const currentPos = sqlTextarea.selectionStart || 0;
								const replacement = `{${cand.label}}`;
								const nextVal = currentVal.slice(0, sqlTriggerStartIdx) + replacement + currentVal.slice(currentPos);
								sqlTextarea.value = nextVal;
								field.tableSqlQuery = nextVal;
								sqlAutocompleteMenu.style.display = 'none';
								this._syncDraft();
								const nextCursor = sqlTriggerStartIdx + replacement.length;
								sqlTextarea.focus();
								sqlTextarea.setSelectionRange(nextCursor, nextCursor);
							};
						});
					};

					sqlTextarea.oninput = () => {
						field.tableSqlQuery = sqlTextarea.value;
						this._syncDraft();
						updateSqlAutocomplete();
					};
					sqlTextarea.onkeydown = (ev) => {
						if (ev.key === 'Escape' && sqlAutocompleteMenu.style.display !== 'none') {
							ev.stopPropagation();
							sqlAutocompleteMenu.style.display = 'none';
						}
					};

					renderSqlTokenized(sqlTextarea.value);

					// Quick-insert reference chips for other fields / outputs ({Field Label})
					const sqlRefBar = append(sqlSection, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;'
					}));
					let sqlChipsExpanded = false;

					const renderSqlRefChips = () => {
						if (sqlTextarea.style.display === 'none') {
							renderSqlTokenized(sqlTextarea.value);
						}
						clearNode(sqlRefBar);
						const sqlRefTokens = getReferenceTokensForField(field).map(rt => rt.label);
						if (sqlRefTokens.length === 0) {
							sqlRefBar.style.display = 'none';
							return;
						}
						sqlRefBar.style.display = 'flex';
						append(sqlRefBar, $('span', {
							style: 'font-size: 10.5px; opacity: 0.65;'
						}, 'Insert Output:'));

						const MAX_VISIBLE_SQL_CHIPS = 4;
						const sqlChipEls: HTMLElement[] = [];

						sqlRefTokens.forEach((token, idx) => {
							const chip = append(sqlRefBar, $('button', {
								type: 'button',
								style: 'padding: 1px 7px; font-size: 10px; font-family: var(--vscode-editor-font-family, monospace); border-radius: 10px; border: 1px solid rgba(56, 189, 248, 0.35); background: rgba(56, 189, 248, 0.12); color: #38bdf8; cursor: pointer;',
								title: `Insert {${token}} output reference into SQL statement`
							}, `+ {${token}}`));
							if (idx >= MAX_VISIBLE_SQL_CHIPS && !sqlChipsExpanded) {
								chip.style.display = 'none';
							}
							sqlChipEls.push(chip);
							chip.onmousedown = (e) => {
								e.preventDefault();
								e.stopPropagation();
							};
							chip.onclick = (e) => {
								e.preventDefault();
								e.stopPropagation();
								const insertStr = `{${token}}`;
								if (sqlTextarea.style.display === 'none') {
									sqlTextarea.value = sqlTextarea.value ? `${sqlTextarea.value} ${insertStr}` : insertStr;
									field.tableSqlQuery = sqlTextarea.value;
									renderSqlTokenized(sqlTextarea.value);
									this._syncDraft();
									this._persistCurrentModule().catch(() => { });
								} else {
									const start = sqlTextarea.selectionStart ?? sqlTextarea.value.length;
									const end = sqlTextarea.selectionEnd ?? sqlTextarea.value.length;
									sqlTextarea.value = sqlTextarea.value.slice(0, start) + insertStr + sqlTextarea.value.slice(end);
									field.tableSqlQuery = sqlTextarea.value;
									this._syncDraft();
									sqlTextarea.focus();
									const nextPos = start + insertStr.length;
									sqlTextarea.setSelectionRange(nextPos, nextPos);
								}
							};
						});

						if (sqlRefTokens.length > MAX_VISIBLE_SQL_CHIPS) {
							const hiddenCount = sqlRefTokens.length - MAX_VISIBLE_SQL_CHIPS;
							const moreBtn = append(sqlRefBar, $('button', {
								type: 'button',
								style: 'padding: 1px 8px; font-size: 10px; font-weight: 600; border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.2); background: rgba(255, 255, 255, 0.06); color: inherit; cursor: pointer;'
							}, sqlChipsExpanded ? 'Show Less' : `+${hiddenCount} More...`));
							moreBtn.onmousedown = (e) => {
								e.preventDefault();
								e.stopPropagation();
							};
							moreBtn.onclick = (e) => {
								e.preventDefault();
								e.stopPropagation();
								sqlChipsExpanded = !sqlChipsExpanded;
								sqlChipEls.forEach((el, i) => {
									if (i >= MAX_VISIBLE_SQL_CHIPS) {
										el.style.display = sqlChipsExpanded ? 'inline-block' : 'none';
									}
								});
								moreBtn.textContent = sqlChipsExpanded ? 'Show Less' : `+${hiddenCount} More...`;
							};
						}
					};

					renderSqlRefChips();
					referenceChipRefreshers.push(renderSqlRefChips);

					const getActiveTableName = () => tblNameInp.value.trim() || (field.label || field.id || 'ticket_table').toLowerCase().replace(/[^a-z0-9_]/g, '_');
					const sqlTemplates = [
						{
							label: 'CREATE TABLE',
							build: () => {
								const cols = field.tableColumns || [];
								const pkCols = cols.filter(c => c.primaryKey).map(c => `"${c.name}"`);
								const colDefs = cols.map(c => {
									const singlePk = pkCols.length === 1 && c.primaryKey ? ' PRIMARY KEY' : '';
									return `"${c.name}" ${c.dataType || 'TEXT'}${singlePk}`;
								});
								if (pkCols.length > 1) {
									colDefs.push(`PRIMARY KEY (${pkCols.join(', ')})`);
								}
								return `CREATE TABLE IF NOT EXISTS "${getActiveTableName()}" (${colDefs.join(', ') || '"id" INTEGER PRIMARY KEY, "name" TEXT'});`;
							}
						},
						{
							label: 'SELECT *',
							build: () => `SELECT * FROM "${getActiveTableName()}" LIMIT 100;`
						},
						{
							label: 'INSERT INTO',
							build: () => {
								const cols = (field.tableColumns || []).map(c => `"${c.name}"`).join(', ') || '"id", "name"';
								const vals = (field.tableColumns || []).map(c => c.dataType === 'INTEGER' ? '1' : `'value'`).join(', ') || `1, 'sample'`;
								return `INSERT INTO "${getActiveTableName()}" (${cols}) VALUES (${vals});`;
							}
						},
						{
							label: 'UPDATE SET',
							build: () => {
								const cols = field.tableColumns || [];
								const pkCol = cols.find(c => c.primaryKey)?.name || cols[0]?.name || 'id';
								const targetCol = cols.find(c => !c.primaryKey)?.name || cols[1]?.name || 'name';
								return `UPDATE "${getActiveTableName()}" SET "${targetCol}" = 'updated_value' WHERE "${pkCol}" = 1;`;
							}
						},
						{
							label: 'DELETE WHERE',
							build: () => {
								const cols = field.tableColumns || [];
								const pkCol = cols.find(c => c.primaryKey)?.name || cols[0]?.name || 'id';
								return `DELETE FROM "${getActiveTableName()}" WHERE "${pkCol}" = 1;`;
							}
						},
						{
							label: 'ALTER ADD COLUMN',
							build: () => `ALTER TABLE "${getActiveTableName()}" ADD COLUMN "new_column" TEXT;`
						}
					];

					sqlTemplates.forEach(tpl => {
						const chip = append(sqlSnippetsBar, $('button', {
							type: 'button',
							style: 'padding: 2px 7px; font-size: 10px; font-family: var(--vscode-editor-font-family, monospace); border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.35); background: rgba(56, 189, 248, 0.1); color: #7dd3fc; cursor: pointer;'
						}, `+ ${tpl.label}`));
						chip.onclick = () => {
							const snippet = tpl.build();
							sqlTextarea.value = sqlTextarea.value.trim() ? `${sqlTextarea.value.trim()}\n${snippet}` : snippet;
							field.tableSqlQuery = sqlTextarea.value;
							renderSqlTokenized(sqlTextarea.value);
							this._syncDraft();
							this._persistCurrentModule().catch(() => { });
						};
					});

					// =========================================================================
					// Debug: SQL Execution Output (Test Preview) Section
					// =========================================================================
					const sqlOutputSection = append(sqlSection, $('div.sql-output-section', {
						style: 'display: flex; flex-direction: column; gap: 6px; margin-top: 6px; padding-top: 10px; border-top: 1px dashed rgba(255, 255, 255, 0.1);'
					}));

					const sqlOutputHeader = append(sqlOutputSection, $('div', {
						style: 'display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;'
					}));
					const sqlOutputHeaderLeft = append(sqlOutputHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;'
					}));
					append(sqlOutputHeaderLeft, $('span', {
						style: 'font-size: 11px; font-weight: 600; opacity: 0.75; text-transform: uppercase; letter-spacing: 0.04em;'
					}, this._isFlowchartNodeMode ? 'Execution Output: SQL Statement & Query Result:' : 'Debug: SQL Execution Output (Test Preview):'));
					append(sqlOutputHeaderLeft, $('span', {
						style: this._isFlowchartNodeMode
							? 'font-size: 10px; padding: 1px 6px; border-radius: 4px; background: rgba(56, 189, 248, 0.14); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); font-weight: 600;'
							: 'font-size: 10px; padding: 1px 6px; border-radius: 4px; background: rgba(245, 158, 11, 0.14); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); font-weight: 600;',
						title: 'Template-level test preview for debugging your SQL statement and {Field Label} references'
					}, this._isFlowchartNodeMode ? 'Node Runtime & Test' : 'Template Debug Only'));

					const sqlStatusBadge = append(sqlOutputHeaderLeft, $('span', {
						style: 'font-size: 10.5px; padding: 1px 7px; border-radius: 4px; background: rgba(255,255,255,0.06); opacity: 0.7; display: none;'
					}));

					const sqlOutputActions = append(sqlOutputHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-left: auto;'
					}));

					const testSqlBtn = append(sqlOutputActions, $('button.monaco-button', {
						type: 'button',
						title: 'Test execute this SQL statement (resolves {Field Label} references and executes against SQLite)',
						style: 'padding: 3px 10px; width: auto; font-size: 11px; font-weight: 600; border-radius: 4px; background: rgba(14, 99, 156, 0.25); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); cursor: pointer; display: inline-flex; align-items: center; gap: 5px;'
					})) as HTMLButtonElement;
					const testSqlBtnIcon = append(testSqlBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.play), { style: 'font-size: 11px;' }));
					const testSqlBtnText = append(testSqlBtn, $('span', {}, 'Test'));

					const copySqlOutputBtn = append(sqlOutputActions, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 3px 8px; width: auto; font-size: 11px; border-radius: 4px; background: rgba(255,255,255,0.06); color: var(--vscode-foreground); border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.12)); cursor: pointer;'
					}, 'Copy'));

					const clearSqlOutputBtn = append(sqlOutputActions, $('button.monaco-button', {
						type: 'button',
						style: 'padding: 3px 8px; width: auto; font-size: 11px; border-radius: 4px; background: rgba(255,255,255,0.06); color: var(--vscode-foreground); border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.12)); cursor: pointer;'
					}, 'Clear'));

					const savedSqlPreviewOutput = field.debugSqlOutput || '';
					const sqlOutputDisplay = append(sqlOutputSection, $('div.sql-output-box', {
						style: 'min-height: 96px; max-height: 240px; overflow-y: auto; padding: 10px 12px; font-size: 12px; line-height: 1.55; border-radius: 5px; border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.1)); background: rgba(0, 0, 0, 0.25); color: var(--vscode-editor-foreground); white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family, monospace); user-select: text;'
					}));

					const setSqlOutputDisplayContent = (text: string) => {
						if (text && text.trim()) {
							sqlOutputDisplay.textContent = text;
							sqlOutputDisplay.style.opacity = '1';
							sqlOutputDisplay.style.fontStyle = 'normal';
						} else {
							sqlOutputDisplay.textContent = 'No SQL debug output yet. Click "\u25B7 Test" (or "\u25B7 Run SQL") to interpolate {Field Label} references, execute the SQL statement against SQLite, and inspect the resolved SQL & query result here.';
							sqlOutputDisplay.style.opacity = '0.5';
							sqlOutputDisplay.style.fontStyle = 'italic';
						}
					};
					setSqlOutputDisplayContent(savedSqlPreviewOutput);
					if (savedSqlPreviewOutput.trim()) {
						sqlStatusBadge.style.display = 'inline-block';
						if ((field as IRuntimeCustomField).lastExecutionStatus === 'success') {
							sqlStatusBadge.textContent = `Completed in ${(field as IRuntimeCustomField).lastExecutionDurationMs ?? 0}ms${(field as IRuntimeCustomField).lastExecutedAt ? ` · ${(field as IRuntimeCustomField).lastExecutedAt}` : ''}`;
							sqlStatusBadge.style.color = '#10b981';
						} else if ((field as IRuntimeCustomField).lastExecutionStatus === 'failed') {
							sqlStatusBadge.textContent = `Failed (${(field as IRuntimeCustomField).lastExecutionDurationMs ?? 0}ms)${(field as IRuntimeCustomField).lastExecutedAt ? ` · ${(field as IRuntimeCustomField).lastExecutedAt}` : ''}`;
							sqlStatusBadge.style.color = '#f87171';
						} else if ((field as IRuntimeCustomField).lastExecutionStatus === 'skipped') {
							sqlStatusBadge.textContent = 'Skipped (Disabled)';
							sqlStatusBadge.style.color = '#94a3b8';
						} else {
							sqlStatusBadge.textContent = 'Saved Preview';
							sqlStatusBadge.style.color = '#10b981';
						}
					}

					const sqlResultBox = append(sqlOutputSection, $('div', {
						style: 'display: none; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 5px; background: rgba(0, 0, 0, 0.32); border: 1px solid rgba(56, 189, 248, 0.25); max-height: 240px; overflow: auto;'
					}));

					copySqlOutputBtn.onclick = async () => {
						const currentOut = (field.debugSqlOutput || '').trim() || (sqlOutputDisplay.style.fontStyle !== 'italic' ? (sqlOutputDisplay.textContent || '').trim() : '');
						if (!currentOut) {
							this.notificationService.warn('Nothing to copy from SQL Execution Output.');
							return;
						}
						await this._clipboardService.writeText(currentOut);
						this.notificationService.info('SQL execution output copied to clipboard.');
					};

					clearSqlOutputBtn.onclick = async () => {
						field.debugSqlOutput = '';
						setSqlOutputDisplayContent('');
						sqlStatusBadge.style.display = 'none';
						sqlResultBox.style.display = 'none';
						clearNode(sqlResultBox);
						this._syncDraft();
						await this._persistCurrentModule();
					};

					clearSqlBtn.onclick = async () => {
						sqlTextarea.value = '';
						field.tableSqlQuery = '';
						field.debugSqlOutput = '';
						renderSqlTokenized('');
						setSqlOutputDisplayContent('');
						sqlStatusBadge.style.display = 'none';
						sqlResultBox.style.display = 'none';
						clearNode(sqlResultBox);
						this._syncDraft();
						await this._persistCurrentModule();
					};

					const executeSqlTestAndRun = async () => {
						const rawSql = sqlTextarea.value.trim();
						if (!rawSql) {
							this.notificationService.warn('Please enter a SQL statement to execute.');
							return;
						}
						const runtime = this._instantiationService.invokeFunction(accessor => {
							try { return accessor.get(ITicketWorkflowRuntimeService); } catch { return undefined; }
						});
						const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);
						if (!runtime) {
							this.notificationService.warn('Workflow runtime service is unavailable.');
							return;
						}
						const allFields = (this._activeModule?.fields && this._activeModule.fields.length > 0) ? this._activeModule.fields : fields;
						const { rawExpr, resolvedTable } = resolveTargetTableName();
						const tblName = resolvedTable || getActiveTableName();
						let interpolatedSql = this._interpolateSchemaReferences(rawSql, field, allFields, await this._getHydratedWorkflowRuntimeContext());
						if (rawExpr && isParamTableExpr(rawExpr) && interpolatedSql.includes(rawExpr)) {
							interpolatedSql = interpolatedSql.split(rawExpr).join(tblName);
						}
						// Strip markdown code fences if an upstream AI prompt returned ```sql ... ```
						const cleanedInterpolatedSql = interpolatedSql
							.replace(/^```(?:sql|sqlite|sqlite3)?\s*\n?/i, '')
							.replace(/\n?```\s*$/i, '')
							.trim();
						const dbPath = dbPathInp.value.trim();

						runSqlBtn.disabled = true;
						runSqlBtnLabel.textContent = 'Running...';
						testSqlBtn.disabled = true;
						testSqlBtnIcon.className = ThemeIcon.asCSSSelector(Codicon.loading) + ' codicon-modifier-spin';
						testSqlBtnText.textContent = 'Running...';

						sqlStatusBadge.style.display = 'inline-block';
						sqlStatusBadge.textContent = `Running on '${tblName}'...`;
						sqlStatusBadge.style.color = '#38bdf8';
						setSqlOutputDisplayContent(
							`Executing SQL statement against table '${tblName}'${dbPath ? ` (${dbPath})` : ' (in-memory)'}...\n\n--- [Resolved SQL Statement] ---\n${cleanedInterpolatedSql || interpolatedSql}`
						);

						const reqSeq = ++schemaLoadSeq;
						const prevDbCols = lastKnownDbColumns ? cloneColumnsList(lastKnownDbColumns) : [];
						const prevTableExisted = lastKnownTableExists;
						const wasDirty = isSchemaDirty();
						const localColsSnapshot = cloneColumnsList(field.tableColumns);

						const startMs = Date.now();
						try {
							const res = await runtime.executeSqliteTableOperation({
								workspaceUri: wsUri,
								dbPath,
								tableName: tblName,
								action: 'query',
								columns: field.tableColumns || [],
								rows: field.tableRows || [],
								sqlQuery: cleanedInterpolatedSql || interpolatedSql
							});
							if (reqSeq !== schemaLoadSeq) {
								return;
							}
							const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);

							if (res.success) {
								if (Array.isArray(res.tables)) {
									populateTableSelectDropdown(res.tables, rawExpr || tblName);
								}

								// Requirement 2 & 3: Inspect the actual SQLite schema of the selected table after SQL execution.
								// Never use res.queryColumns (from SELECT or PRAGMA) to populate Table Columns.
								const newTableExists = Boolean(res.tableExists);
								const newDbCols = newTableExists && Array.isArray(res.columns) ? cloneColumnsList(res.columns) : [];
								const actualDbSchemaChanged =
									(prevTableExisted !== newTableExists) ||
									!areSchemasEqual(prevDbCols, newDbCols);

								lastKnownTableExists = newTableExists;
								lastKnownDbColumns = cloneColumnsList(newDbCols);

								if (actualDbSchemaChanged) {
									if (!wasDirty) {
										// Clean local state: automatically synchronize Table Columns to the updated SQLite schema
										// (or [] if the selected table was dropped).
										field.tableColumns = cloneColumnsList(newDbCols);
										hasLocalColumnEdits = false;
									} else {
										// Dirty local state: protect unsaved local column edits by reconciling or prompting the user.
										const reconciled = await reconcileSchemaChanges(
											tblName,
											prevDbCols,
											localColsSnapshot,
											newDbCols,
											newTableExists
										);
										field.tableColumns = reconciled.nextCols;
										hasLocalColumnEdits = reconciled.nextDirty;
									}
								} else if (prevDbCols.length === 0 && !wasDirty && newTableExists && newDbCols.length > 0) {
									// Initial baseline if table schema had not yet been loaded prior to running SQL
									field.tableColumns = cloneColumnsList(newDbCols);
									hasLocalColumnEdits = false;
								}

								if (!res.isSelectQuery && !res.isPragmaQuery) {
									if (Array.isArray(res.rows)) {
										field.tableRows = res.rows;
									}
									if (typeof res.rowCount === 'number') {
										totalDbRowCount = res.rowCount;
									}
								} else if (res.isSelectQuery && Array.isArray(res.queryRows)) {
									(field as IRuntimeCustomField).lastQueryRows = res.queryRows;
									if (!res.isPragmaQuery) {
										field.tableRows = res.queryRows;
									}
								}

								sqlStatusBadge.textContent = `Done (${elapsedSec}s)`;
								sqlStatusBadge.style.color = '#10b981';

								const summaryLines: string[] = [
									`Status: SUCCESS (${elapsedSec}s)`,
									`Database: ${dbPath || ':memory:'}`,
									`Target Table: ${tblName}${rawExpr && rawExpr !== tblName ? ` (resolved from ${rawExpr})` : ''}`,
									`Result: ${res.message || 'SQL statement executed successfully.'}`,
									'',
									'--- [Resolved SQL Statement] ---',
									cleanedInterpolatedSql || interpolatedSql
								];
								if (res.isSelectQuery && Array.isArray(res.queryRows)) {
									if (!res.isPragmaQuery && res.queryRows.length > 10) {
										const previewSlice = res.queryRows.slice(0, 10);
										const omittedCount = res.queryRows.length - previewSlice.length;
										summaryLines.push('', `--- [Query Rows Preview (Showing first ${previewSlice.length} of ${res.queryRows.length} row(s))] ---`);
										summaryLines.push(JSON.stringify(previewSlice, null, 2));
										summaryLines.push(`... (${omittedCount} more row(s) omitted in text preview; all ${res.queryRows.length} rows are preserved in runtime data)`);
									} else {
										summaryLines.push('', `--- [Query Rows Preview (${res.queryRows.length} row(s))] ---`);
										summaryLines.push(JSON.stringify(res.queryRows, null, 2));
									}
								}
								const finalDebugText = summaryLines.join('\n');
								field.debugSqlOutput = finalDebugText;
								setSqlOutputDisplayContent(finalDebugText);

								renderColumnsBuilder();
								renderGridTable();
								updateSchemaDiffBanner();
								updateStatsBadge();
								this._syncDraft();
								await this._persistCurrentModule();

								clearNode(sqlResultBox);
								if (res.isSelectQuery && Array.isArray(res.queryRows)) {
									sqlResultBox.style.display = 'flex';
									const allQueryRows = res.queryRows;
									const qCols = Array.isArray(res.queryColumns) && res.queryColumns.length > 0
										? res.queryColumns
										: (allQueryRows[0] ? Object.keys(allQueryRows[0]).map((k, idx) => ({ id: `c_${idx}`, name: k, dataType: 'TEXT' as TableColumnDataType })) : []);

									let qrPage = 1;
									const qrPageSize = 10;
									const qrTotalPages = Math.max(1, Math.ceil(allQueryRows.length / qrPageSize));

									const qTopBar = append(sqlResultBox, $('div', {
										style: 'display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;'
									}));
									const qInfoLabel = append(qTopBar, $('span', {
										style: 'font-size: 10.5px; font-weight: 600; color: #7dd3fc;'
									}));

									const qControlsRight = append(qTopBar, $('div', {
										style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;'
									}));

									const qrPrevBtn = append(qControlsRight, $('button.monaco-button', {
										type: 'button',
										style: 'padding: 2px 7px; font-size: 10px; border-radius: 4px; background: rgba(255,255,255,0.06); color: inherit; border: 1px solid rgba(255,255,255,0.14); cursor: pointer;'
									}, '\u2039 Prev')) as HTMLButtonElement;
									const qrPageBadge = append(qControlsRight, $('span', {
										style: 'font-size: 10px; opacity: 0.8; font-family: var(--vscode-editor-font-family, monospace);'
									}));
									const qrNextBtn = append(qControlsRight, $('button.monaco-button', {
										type: 'button',
										style: 'padding: 2px 7px; font-size: 10px; border-radius: 4px; background: rgba(255,255,255,0.06); color: inherit; border: 1px solid rgba(255,255,255,0.14); cursor: pointer;'
									}, 'Next \u203A')) as HTMLButtonElement;

									const copyQueryJsonBtn = append(qControlsRight, $('button.monaco-button', {
										type: 'button',
										title: 'Copy all query result rows as JSON',
										style: 'display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; font-size: 10px; font-weight: 500; border-radius: 4px; background: rgba(56, 189, 248, 0.14); color: #7dd3fc; border: 1px solid rgba(56, 189, 248, 0.35); cursor: pointer;'
									})) as HTMLButtonElement;
									const copyQueryJsonIcon = append(copyQueryJsonBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy), { style: 'font-size: 10.5px;' }));
									const copyQueryJsonLabel = append(copyQueryJsonBtn, $('span', {}, 'Copy JSON'));
									copyQueryJsonBtn.onclick = async (e) => {
										e.preventDefault();
										e.stopPropagation();
										await this._clipboardService.writeText(JSON.stringify(allQueryRows || [], null, 2));
										copyQueryJsonIcon.className = ThemeIcon.asClassName(Codicon.check);
										copyQueryJsonBtn.style.color = '#4ade80';
										copyQueryJsonLabel.textContent = 'Copied!';
										this.notificationService.info(`Copied all ${(allQueryRows || []).length} query result row(s) as JSON.`);
										setTimeout(() => {
											if (copyQueryJsonBtn.isConnected) {
												copyQueryJsonIcon.className = ThemeIcon.asClassName(Codicon.copy);
												copyQueryJsonBtn.style.color = '#7dd3fc';
												copyQueryJsonLabel.textContent = 'Copy JSON';
											}
										}, 1500);
									};

									const applyQueryToGridBtn = append(qControlsRight, $('button.monaco-button', {
										type: 'button',
										style: 'padding: 2px 8px; font-size: 10px; font-weight: 600; border-radius: 4px; background: rgba(20, 184, 166, 0.2); color: #2dd4bf; border: 1px solid rgba(20, 184, 166, 0.45); cursor: pointer;'
									}, 'Replace Grid with Query Result'));
									applyQueryToGridBtn.onclick = async () => {
										// Only replace grid rows; never overwrite Table Columns with arbitrary query result columns.
										field.tableRows = allQueryRows || [];
										renderGridTable();
										updateStatsBadge();
										this._syncDraft();
										await this._persistCurrentModule();
										this.notificationService.info('Applied query result rows to table grid.');
									};

									if (allQueryRows.length === 0) {
										qInfoLabel.textContent = 'Query Result (0 row(s))';
										qrPrevBtn.style.display = 'none';
										qrPageBadge.style.display = 'none';
										qrNextBtn.style.display = 'none';
										append(sqlResultBox, $('div', { style: 'font-size: 11px; opacity: 0.6; font-style: italic;' }, 'Query returned 0 rows.'));
									} else {
										const qTbl = append(sqlResultBox, $('table', { style: 'width: 100%; border-collapse: collapse; font-size: 11px; text-align: left;' }));
										const qThead = append(qTbl, $('thead'));
										const qTrH = append(qThead, $('tr', { style: 'background: rgba(56, 189, 248, 0.14); border-bottom: 1px solid rgba(56, 189, 248, 0.3);' }));
										append(qTrH, $('th', { style: 'padding: 4px 8px; font-weight: 600; color: #94a3b8; border-right: 1px solid rgba(255,255,255,0.06); width: 36px;' }, '#'));
										qCols.forEach(qc => {
											append(qTrH, $('th', { style: 'padding: 4px 8px; font-weight: 600; color: #bae6fd; border-right: 1px solid rgba(255,255,255,0.06);' }, qc.name));
										});
										const qTbody = append(qTbl, $('tbody'));

										const renderQueryResultPage = () => {
											clearNode(qTbody);
											const safePage = Math.max(1, Math.min(qrPage, qrTotalPages));
											qrPage = safePage;
											const startIdx = (safePage - 1) * qrPageSize;
											const endIdx = Math.min(startIdx + qrPageSize, allQueryRows.length);
											qInfoLabel.textContent = `Query Result (${allQueryRows.length} row(s) total · showing ${startIdx + 1}\u2013${endIdx})`;
											qrPageBadge.textContent = `Page ${safePage} / ${qrTotalPages}`;
											qrPrevBtn.disabled = safePage <= 1;
											qrPrevBtn.style.opacity = safePage <= 1 ? '0.4' : '1';
											qrNextBtn.disabled = safePage >= qrTotalPages;
											qrNextBtn.style.opacity = safePage >= qrTotalPages ? '0.4' : '1';

											allQueryRows.slice(startIdx, endIdx).forEach((qr, idx) => {
												const qTr = append(qTbody, $('tr', { style: 'border-bottom: 1px solid rgba(255,255,255,0.05);' }));
												append(qTr, $('td', { style: 'padding: 4px 8px; border-right: 1px solid rgba(255,255,255,0.06); color: #64748b; font-family: var(--vscode-editor-font-family, monospace);' }, String(startIdx + idx + 1)));
												qCols.forEach(qc => {
													const v = qr[qc.name];
													append(qTr, $('td', { style: 'padding: 4px 8px; border-right: 1px solid rgba(255,255,255,0.06); font-family: var(--vscode-editor-font-family, monospace);' }, v === null || v === undefined ? 'NULL' : String(v)));
												});
											});
										};

										qrPrevBtn.onclick = () => {
											if (qrPage > 1) {
												qrPage--;
												renderQueryResultPage();
											}
										};
										qrNextBtn.onclick = () => {
											if (qrPage < qrTotalPages) {
												qrPage++;
												renderQueryResultPage();
											}
										};

										renderQueryResultPage();
									}
								} else {
									sqlResultBox.style.display = 'none';
								}
							} else {
								sqlStatusBadge.textContent = `Failed (${elapsedSec}s)`;
								sqlStatusBadge.style.color = '#f87171';
								const errOut = [
									`Status: FAILED (${elapsedSec}s)`,
									`Database: ${dbPath || ':memory:'}`,
									`Target Table: ${tblName}`,
									`SQL Error: ${res.error || 'Execution failed'}`,
									'',
									'--- [Resolved SQL Statement] ---',
									cleanedInterpolatedSql || interpolatedSql
								].join('\n');
								field.debugSqlOutput = errOut;
								setSqlOutputDisplayContent(errOut);
								this._syncDraft();
								await this._persistCurrentModule();
								this.notificationService.error(`SQL Error: ${res.error || 'Execution failed'}`);
							}
						} finally {
							runSqlBtn.disabled = false;
							runSqlBtnLabel.textContent = 'Run SQL';
							testSqlBtn.disabled = false;
							testSqlBtnIcon.className = ThemeIcon.asCSSSelector(Codicon.play);
							testSqlBtnText.textContent = 'Test';
						}
					};

					runSqlBtn.onclick = executeSqlTestAndRun;
					testSqlBtn.onclick = executeSqlTestAndRun;
				}

				if (field.type === 'create_tickets' || field.type === 'run_tickets' || field.type === 'get_outputs' || field.type === 'get_ticket' || field.type === 'get_tickets' || field.type === 'display') {
					const wfBox = append(fieldCard, $('.wf-builtin-config-box', {
						style: 'display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 6px; background: rgba(168, 85, 247, 0.06); border: 1px solid rgba(168, 85, 247, 0.25); margin-top: 4px;'
					}));

					const formatParamValueForPythonExpr = (rawVal: string): string => {
						const trimmed = (rawVal || '').trim();
						if (!trimmed) { return '""'; }
						const singleBrace = trimmed.match(/^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
						if (singleBrace) { return singleBrace[1]; }
						if (/^-?\d+(\.\d+)?$/.test(trimmed) || trimmed === 'True' || trimmed === 'False' || trimmed === 'None') { return trimmed; }
						return JSON.stringify(trimmed);
					};

					const refreshPythonPreview: () => void = () => { };
					const buildCurrentPythonExpression = (): string => {
						const varName = field.outputVariableName || generateSmartPythonVarName(field.label || field.id, field.type);
						if (field.type === 'get_ticket') {
							const rawTarget = (field.wfTicketTarget || field.wfTicketId || field.wfTicketVariable || '').trim();
							const args: string[] = [];
							if (rawTarget) { args.push(`ticket=${formatParamValueForPythonExpr(rawTarget)}`); }
							if (field.wfTicketField && field.wfTicketField.trim()) { args.push(`field=${formatParamValueForPythonExpr(field.wfTicketField)}`); }
							if (field.wfTicketType && field.wfTicketType.trim()) { args.push(`ticket_type=${JSON.stringify(field.wfTicketType)}`); }
							return `${varName} = get_ticket(${args.join(', ')})`;
						}
						if (field.type === 'create_tickets') {
							const tType = field.wfTicketType || '';
							const tTitle = field.wfTicketTitle || '';
							const tPath = field.wfTicketPath || '.';
							const schemaParams = resolveModuleParameters(tType);
							const validNames = new Set(schemaParams.map(p => p.name.toLowerCase()));
							const paramEntries = Object.entries(field.wfTicketParams || {})
								.filter(([k]) => validNames.size === 0 || validNames.has(k.toLowerCase()));
							const paramsStr = paramEntries.map(([k, v]) => `${JSON.stringify(k)}: ${formatParamValueForPythonExpr(v)}`).join(', ');
							return `${varName} = CREATE_TICKETS(\n    ticket_type=${JSON.stringify(tType)},\n    title=${JSON.stringify(tTitle)},\n    path=${JSON.stringify(tPath)},\n    params={${paramsStr}}\n)`;
						}
						if (field.type === 'run_tickets') {
							const rawTarget = (field.wfTicketTarget || '').trim();
							const targetExpr = formatParamValueForPythonExpr(rawTarget);
							const effectiveType = resolveRunTargetTicketType();
							const schemaParams = resolveModuleParameters(effectiveType || rawTarget);
							const validNames = new Set(schemaParams.map(p => p.name.toLowerCase()));
							const paramEntries = Object.entries(field.wfTicketParams || {})
								.filter(([k, v]) => (validNames.size === 0 || validNames.has(k.toLowerCase())) && k.trim().length > 0 && v !== undefined && v !== '');
							const paramsStr = paramEntries.map(([k, v]) => `${JSON.stringify(k)}: ${formatParamValueForPythonExpr(v)}`).join(', ');
							return `${varName} = RUN_TICKETS(ticket=${targetExpr}, params={${paramsStr}})`;
						}
						if (field.type === 'get_outputs') {
							const rawTarget = (field.wfTicketTarget || '').trim();
							const targetExpr = formatParamValueForPythonExpr(rawTarget);
							const args: string[] = [`ticket=${targetExpr}`];
							if (field.wfTicketField && field.wfTicketField.trim()) {
								args.push(`field=${formatParamValueForPythonExpr(field.wfTicketField)}`);
							}
							return `${varName} = GET_OUTPUTS(${args.join(', ')})`;
						}
						if (field.type === 'display') {
							const rawVal = (field.wfDisplayValue || '').trim();
							if (!rawVal) {
								return 'DISPLAY()';
							}
							const exactVar = rawVal.match(/^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
							if (exactVar) {
								return `DISPLAY(${exactVar[1]})`;
							}
							// Unwrap {var_name} outside quotes without ever auto-quoting expressions
							let normExpr = '';
							let inQ: string | null = null;
							let idx = 0;
							while (idx < rawVal.length) {
								const ch = rawVal[idx];
								if (inQ) {
									normExpr += ch;
									if (ch === '\\' && idx + 1 < rawVal.length) {
										normExpr += rawVal[idx + 1];
										idx += 2;
										continue;
									}
									if (ch === inQ) {
										inQ = null;
									}
									idx++;
									continue;
								}
								if (ch === '"' || ch === '\'') {
									inQ = ch;
									normExpr += ch;
									idx++;
									continue;
								}
								if (ch === '{') {
									const m = rawVal.slice(idx).match(/^\{([a-zA-Z_][a-zA-Z0-9_]*)\}/);
									if (m) {
										normExpr += m[1];
										idx += m[0].length;
										continue;
									}
								}
								normExpr += ch;
								idx++;
							}
							return `DISPLAY(${normExpr})`;
						}
						return '';
					};

					const resolveModuleParameters = (typeName: string): IParameterDefinition[] => {
						const clean = (typeName || '').trim().replace(/^\{|\}$/g, '').trim().toLowerCase();
						if (!clean) {
							return [];
						}
						let matchedMod = allWorkspaceModules.find(m =>
							(m.name || '').trim().toLowerCase() === clean ||
							(m.id || '').trim().toLowerCase() === clean
						);
						if (!matchedMod) {
							const snapshots = this._entityPersistenceService.getAllSnapshots() || [];
							const snap = snapshots.find(s =>
								s.ticketId?.toLowerCase() === clean ||
								s.entityName?.toLowerCase() === clean
							);
							if (snap?.entityType) {
								matchedMod = allWorkspaceModules.find(m =>
									(m.name || '').trim().toLowerCase() === snap.entityType!.trim().toLowerCase() ||
									(m.id || '').trim().toLowerCase() === snap.entityType!.trim().toLowerCase()
								);
							}
						}
						if (!matchedMod || !Array.isArray(matchedMod.fields)) {
							return [];
						}
						const params: IParameterDefinition[] = [];
						matchedMod.fields.forEach(f => {
							if (f && f.type === 'parameters' && Array.isArray(f.parameters)) {
								f.parameters.forEach(p => {
									if (p && p.name) {
										params.push(p);
									}
								});
							}
						});
						return params;
					};

					const renderQuickInsertChipsForInput = (_containerEl: HTMLElement, targetInp: HTMLInputElement, onUpdated: () => void) => {
						// Clean `{` autocomplete dropdown menu (replaces bulky static `Insert:` chip rows)
						let popupEl: HTMLElement | null = null;
						let activeIndex = 0;
						let currentMatches: Array<{ label: string; type: string }> = [];
						let openBraceIdx = -1;

						const closePopup = () => {
							if (popupEl) {
								popupEl.remove();
								popupEl = null;
							}
							activeIndex = 0;
							currentMatches = [];
							openBraceIdx = -1;
						};

						const applySelection = (selectedLabel: string) => {
							const cur = targetInp.value || '';
							const cursor = typeof targetInp.selectionStart === 'number' ? targetInp.selectionStart : cur.length;
							if (openBraceIdx < 0 || openBraceIdx > cursor) {
								closePopup();
								return;
							}
							const afterCursor = cur.substring(cursor);
							const alreadyHasClosingBrace = afterCursor.startsWith('}');
							const replacement = alreadyHasClosingBrace ? `{${selectedLabel}` : `{${selectedLabel}}`;
							targetInp.value = cur.substring(0, openBraceIdx) + replacement + afterCursor;
							const nextPos = openBraceIdx + selectedLabel.length + 2;
							targetInp.focus({ preventScroll: true });
							targetInp.setSelectionRange(nextPos, nextPos);
							closePopup();
							onUpdated();
						};

						const renderPopupItems = () => {
							if (!popupEl) {
								return;
							}
							clearNode(popupEl);
							if (currentMatches.length === 0) {
								append(popupEl, $('div', {
									style: 'padding: 6px 10px; font-size: 11px; color: #94a3b8; font-style: italic;'
								}, 'No matching variables'));
								return;
							}
							currentMatches.forEach((tok, idx) => {
								const isAct = idx === activeIndex;
								const row = append(popupEl!, $('div', {
									style: `display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 5px 10px; cursor: pointer; font-size: 11.5px; font-family: var(--vscode-editor-font-family, monospace); border-radius: 4px; ${isAct ? 'background: rgba(56, 189, 248, 0.22); color: #f8fafc;' : 'color: #cbd5e1;'}`
								}));
								append(row, $('span', {
									style: 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;'
								}, `{${tok.label}}`));
								if (tok.type) {
									append(row, $('span', {
										style: 'font-size: 9.5px; font-weight: 600; padding: 1px 5px; border-radius: 3px; background: rgba(148, 163, 184, 0.14); color: #94a3b8; flex-shrink: 0; font-family: var(--vscode-font-family, sans-serif);'
									}, tok.type));
								}
								row.onmouseenter = () => {
									activeIndex = idx;
									renderPopupItems();
								};
								row.onmousedown = (ev) => {
									ev.preventDefault();
									ev.stopPropagation();
									applySelection(tok.label);
								};
							});
						};

						const updateAutocomplete = () => {
							const cur = targetInp.value || '';
							const cursor = typeof targetInp.selectionStart === 'number' ? targetInp.selectionStart : cur.length;
							const textBefore = cur.substring(0, cursor);
							const lastOpen = textBefore.lastIndexOf('{');
							const lastClose = textBefore.lastIndexOf('}');
							if (lastOpen < 0 || lastOpen < lastClose) {
								closePopup();
								return;
							}
							const query = textBefore.substring(lastOpen + 1);
							if (query.includes('{') || query.includes('}') || query.includes('\n')) {
								closePopup();
								return;
							}
							openBraceIdx = lastOpen;
							const qLower = query.trim().toLowerCase();
							const allTokens = getReferenceTokensForField(field);
							const isCleanIdent = (s: string) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s);

							const scored: Array<{ tok: { label: string; type: string }; rank: number }> = [];
							for (const tok of allTokens) {
								const lLower = tok.label.toLowerCase();
								const clean = isCleanIdent(tok.label);
								if (!qLower) {
									scored.push({ tok, rank: clean ? 0 : 2 });
								} else if (lLower === qLower) {
									scored.push({ tok, rank: clean ? 0 : 1 });
								} else if (lLower.startsWith(qLower)) {
									scored.push({ tok, rank: clean ? 1 : 3 });
								} else if (lLower.includes(qLower)) {
									scored.push({ tok, rank: clean ? 2 : 4 });
								}
							}
							scored.sort((a, b) => a.rank - b.rank || a.tok.label.localeCompare(b.tok.label));
							currentMatches = scored.slice(0, 30).map(s => s.tok);
							activeIndex = 0;

							const popupWindow = getWindow(targetInp);
							if (!popupEl) {
								popupEl = append(popupWindow.document.body, $('div.anyagent-var-autocomplete-popup', {
									style: 'position: fixed; z-index: 25000; min-width: 240px; max-width: 420px; max-height: 230px; overflow-y: auto; background: #141925; border: 1px solid rgba(56, 189, 248, 0.45); border-radius: 6px; padding: 4px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65); display: flex; flex-direction: column; gap: 2px;'
								}));
							}
							const rect = targetInp.getBoundingClientRect();
							const estHeight = Math.min(230, Math.max(36, currentMatches.length * 28 + 10));
							const spaceBelow = popupWindow.innerHeight - rect.bottom - 12;
							const topPos = spaceBelow >= estHeight ? rect.bottom + 4 : Math.max(8, rect.top - estHeight - 4);
							const leftPos = Math.min(Math.max(8, rect.left), Math.max(8, popupWindow.innerWidth - 320));
							popupEl.style.top = `${topPos}px`;
							popupEl.style.left = `${leftPos}px`;
							popupEl.style.width = `${Math.max(240, Math.min(420, rect.width))}px`;
							renderPopupItems();
						};

						targetInp.addEventListener('input', updateAutocomplete);
						targetInp.addEventListener('click', updateAutocomplete);
						targetInp.addEventListener('keydown', (ev: KeyboardEvent) => {
							if (!popupEl) {
								return;
							}
							if (ev.key === 'ArrowDown') {
								ev.preventDefault();
								ev.stopPropagation();
								if (currentMatches.length > 0) {
									activeIndex = (activeIndex + 1) % currentMatches.length;
									renderPopupItems();
									const actEl = popupEl.children[activeIndex] as HTMLElement | undefined;
									actEl?.scrollIntoView({ block: 'nearest' });
								}
							} else if (ev.key === 'ArrowUp') {
								ev.preventDefault();
								ev.stopPropagation();
								if (currentMatches.length > 0) {
									activeIndex = (activeIndex - 1 + currentMatches.length) % currentMatches.length;
									renderPopupItems();
									const actEl = popupEl.children[activeIndex] as HTMLElement | undefined;
									actEl?.scrollIntoView({ block: 'nearest' });
								}
							} else if (ev.key === 'Enter' || ev.key === 'Tab') {
								if (currentMatches.length > 0 && currentMatches[activeIndex]) {
									ev.preventDefault();
									ev.stopPropagation();
									applySelection(currentMatches[activeIndex].label);
								}
							} else if (ev.key === 'Escape') {
								ev.preventDefault();
								ev.stopPropagation();
								closePopup();
							}
						});
						targetInp.addEventListener('blur', () => {
							setTimeout(closePopup, 120);
						});
						this._renderCleanupFns.push(closePopup);
					};

					const renderWorkflowTicketVariableChips = (containerEl: HTMLElement, targetInp: HTMLInputElement, onUpdated: () => void) => {
						const isCleanVarName = (s: string) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s);
						const collectTicketHandleVars = (): Array<{ name: string; desc?: string }> => {
							const ticketVars: Array<{ name: string; desc?: string }> = [];
							const seenVars = new Set<string>();
							const currentOutVar = (field.outputVariableName || '').trim().toLowerCase();
							const currentFieldLabel = (field.label || '').trim().toLowerCase();

							const addHandle = (rawName: string | undefined, desc?: string) => {
								const clean = (rawName || '').trim().replace(/^@/, '');
								if (!clean || !isCleanVarName(clean)) { return; }
								const lower = clean.toLowerCase();
								if (lower === currentOutVar || lower === currentFieldLabel || seenVars.has(lower)) { return; }
								seenVars.add(lower);
								ticketVars.push({ name: clean, desc });
							};

							// 1. Current node cards: ONLY genuine ticket handle producers (create_tickets, get_ticket, or python returning a ticket handle)
							fields.forEach(f => {
								if (!f || f === field) { return; }
								if (f.type === 'create_tickets' || f.type === 'get_ticket') {
									const vName = (f.outputVariableName || '').trim() || generateSmartPythonVarName(f.label || f.id, f.type);
									addHandle(vName, f.wfTicketType || f.label || f.type);
								} else if (f.type === 'python') {
									const outObj = f.pythonResult ?? (f as IRuntimeCustomField).lastExecutionOutput;
									const outRec = (outObj && typeof outObj === 'object' && !Array.isArray(outObj)) ? outObj as { ticketId?: unknown; entityUri?: unknown; ticketType?: unknown } : undefined;
									const hasTicketHandleOut = Boolean(outRec && (outRec.ticketId || outRec.entityUri));
									const hasCreateInCode = typeof f.pythonCode === 'string' && /\b(?:CREATE_TICKETS|create_tickets|GET_TICKET|get_ticket)\s*\(/.test(f.pythonCode);
									if (hasTicketHandleOut || hasCreateInCode) {
										const vName = (f.outputVariableName || '').trim();
										addHandle(vName, outRec?.ticketType ? String(outRec.ticketType) : (f.label || 'Ticket Handle'));
									}
								}
							});

							// 2. Flowchart variables provider: ONLY explicitly tagged HANDLE variables (from CREATE_TICKETS / GET_TICKET)
							if (isFlowchartNodeMode && input.workflowVariablesProvider) {
								try {
									const wfVars = input.workflowVariablesProvider() || [];
									wfVars.forEach(wv => {
										const wLabel = (wv.label || '').trim();
										if (!wLabel || !isCleanVarName(wLabel)) { return; }
										const isGenuineHandle = wv.type === 'HANDLE' ||
											Boolean(wv.ticketType) ||
											wv.sourceType === 'create_tickets' ||
											wv.sourceType === 'get_ticket';
										if (isGenuineHandle) {
											addHandle(wLabel, wv.ticketType || 'Ticket Handle');
										}
									});
								} catch { }
							}
							return ticketVars;
						};

						const ticketVars = collectTicketHandleVars();
						if (ticketVars.length > 0) {
							const chipRow = append(containerEl, $('div', {
								style: 'display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-top: 3px;'
							}));
							append(chipRow, $('span', { style: 'font-size: 10px; opacity: 0.75; color: #c084fc; font-weight: 600;' }, 'Ticket Handle:'));

							ticketVars.forEach(tv => {
								const chip = append(chipRow, $('button', {
									type: 'button',
									title: `Use ticket handle {${tv.name}}${tv.desc ? ` (${tv.desc})` : ''}`,
									style: 'padding: 2px 7px; font-size: 10px; border-radius: 4px; border: 1px solid rgba(192, 132, 252, 0.45); background: rgba(192, 132, 252, 0.12); color: #e9d5ff; cursor: pointer; font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap; transition: all 0.15s ease;'
								}, `+ {${tv.name}}`));
								chip.onmouseenter = () => { chip.style.background = 'rgba(192, 132, 252, 0.28)'; };
								chip.onmouseleave = () => { chip.style.background = 'rgba(192, 132, 252, 0.12)'; };
								chip.onclick = () => {
									targetInp.value = `{${tv.name}}`;
									onUpdated();
								};
							});
						}

						// 3. Attach `{` autocomplete menu strictly filtered to genuine Ticket Handles
						let handlePopupEl: HTMLElement | null = null;
						let handleActiveIdx = 0;
						let handleMatches: Array<{ name: string; desc?: string }> = [];
						let handleOpenBraceIdx = -1;

						const closeHandlePopup = () => {
							if (handlePopupEl) {
								handlePopupEl.remove();
								handlePopupEl = null;
							}
							handleActiveIdx = 0;
							handleMatches = [];
							handleOpenBraceIdx = -1;
						};

						const applyHandleSelection = (selectedName: string) => {
							targetInp.value = `{${selectedName}}`;
							const nextPos = targetInp.value.length;
							targetInp.focus({ preventScroll: true });
							targetInp.setSelectionRange(nextPos, nextPos);
							closeHandlePopup();
							onUpdated();
						};

						const renderHandlePopupItems = () => {
							if (!handlePopupEl) { return; }
							clearNode(handlePopupEl);
							if (handleMatches.length === 0) {
								append(handlePopupEl, $('div', {
									style: 'padding: 6px 10px; font-size: 11px; color: #94a3b8; font-style: italic;'
								}, 'No matching ticket handles'));
								return;
							}
							handleMatches.forEach((tv, idx) => {
								const isAct = idx === handleActiveIdx;
								const row = append(handlePopupEl!, $('div', {
									style: `display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 5px 10px; cursor: pointer; font-size: 11.5px; font-family: var(--vscode-editor-font-family, monospace); border-radius: 4px; ${isAct ? 'background: rgba(192, 132, 252, 0.25); color: #f8fafc;' : 'color: #e9d5ff;'}`
								}));
								append(row, $('span', {
									style: 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;'
								}, `{${tv.name}}`));
								if (tv.desc) {
									append(row, $('span', {
										style: 'font-size: 9.5px; font-weight: 600; padding: 1px 6px; border-radius: 3px; background: rgba(192, 132, 252, 0.16); color: #d8b4fe; flex-shrink: 0; font-family: var(--vscode-font-family, sans-serif);'
									}, tv.desc));
								}
								row.onmouseenter = () => {
									handleActiveIdx = idx;
									renderHandlePopupItems();
								};
								row.onmousedown = (ev) => {
									ev.preventDefault();
									ev.stopPropagation();
									applyHandleSelection(tv.name);
								};
							});
						};

						const updateHandleAutocomplete = () => {
							const cur = targetInp.value || '';
							const cursor = typeof targetInp.selectionStart === 'number' ? targetInp.selectionStart : cur.length;
							const textBefore = cur.substring(0, cursor);
							const lastOpen = textBefore.lastIndexOf('{');
							const lastClose = textBefore.lastIndexOf('}');
							if (lastOpen < 0 || lastOpen < lastClose) {
								closeHandlePopup();
								return;
							}
							const query = textBefore.substring(lastOpen + 1);
							if (query.includes('{') || query.includes('}') || query.includes('\n')) {
								closeHandlePopup();
								return;
							}
							handleOpenBraceIdx = lastOpen;
							const qLower = query.trim().toLowerCase();
							const allHandles = collectTicketHandleVars();
							const scored: Array<{ tv: { name: string; desc?: string }; rank: number }> = [];
							for (const tv of allHandles) {
								const nLower = tv.name.toLowerCase();
								const dLower = (tv.desc || '').toLowerCase();
								if (!qLower) {
									scored.push({ tv, rank: 0 });
								} else if (nLower.startsWith(qLower)) {
									scored.push({ tv, rank: 0 });
								} else if (nLower.includes(qLower)) {
									scored.push({ tv, rank: 1 });
								} else if (dLower.includes(qLower)) {
									scored.push({ tv, rank: 2 });
								}
							}
							scored.sort((a, b) => a.rank - b.rank || a.tv.name.localeCompare(b.tv.name));
							handleMatches = scored.map(s => s.tv);
							handleActiveIdx = 0;

							const popupWindow = getWindow(targetInp);
							if (!handlePopupEl) {
								handlePopupEl = append(popupWindow.document.body, $('div.anyagent-handle-autocomplete-popup', {
									style: 'position: fixed; z-index: 25000; min-width: 240px; max-width: 420px; max-height: 220px; overflow-y: auto; background: #171424; border: 1px solid rgba(192, 132, 252, 0.55); border-radius: 6px; padding: 4px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65); display: flex; flex-direction: column; gap: 2px;'
								}));
							}
							const rect = targetInp.getBoundingClientRect();
							const estHeight = Math.min(220, Math.max(36, handleMatches.length * 28 + 10));
							const spaceBelow = popupWindow.innerHeight - rect.bottom - 12;
							const topPos = spaceBelow >= estHeight ? rect.bottom + 4 : Math.max(8, rect.top - estHeight - 4);
							const leftPos = Math.min(Math.max(8, rect.left), Math.max(8, popupWindow.innerWidth - 320));
							handlePopupEl.style.top = `${topPos}px`;
							handlePopupEl.style.left = `${leftPos}px`;
							handlePopupEl.style.width = `${Math.max(240, Math.min(420, rect.width))}px`;
							renderHandlePopupItems();
						};

						targetInp.addEventListener('input', updateHandleAutocomplete);
						targetInp.addEventListener('click', updateHandleAutocomplete);
						targetInp.addEventListener('keydown', (ev: KeyboardEvent) => {
							if (!handlePopupEl) { return; }
							if (ev.key === 'ArrowDown') {
								ev.preventDefault();
								ev.stopPropagation();
								if (handleMatches.length > 0) {
									handleActiveIdx = (handleActiveIdx + 1) % handleMatches.length;
									renderHandlePopupItems();
								}
							} else if (ev.key === 'ArrowUp') {
								ev.preventDefault();
								ev.stopPropagation();
								if (handleMatches.length > 0) {
									handleActiveIdx = (handleActiveIdx - 1 + handleMatches.length) % handleMatches.length;
									renderHandlePopupItems();
								}
							} else if (ev.key === 'Enter' || ev.key === 'Tab') {
								if (handleMatches.length > 0 && handleMatches[handleActiveIdx]) {
									ev.preventDefault();
									ev.stopPropagation();
									applyHandleSelection(handleMatches[handleActiveIdx].name);
								}
							} else if (ev.key === 'Escape') {
								ev.preventDefault();
								ev.stopPropagation();
								closeHandlePopup();
							}
						});
						targetInp.addEventListener('blur', () => {
							setTimeout(closeHandlePopup, 120);
						});
						this._renderCleanupFns.push(closeHandlePopup);
					};

					const attachTicketSearchDropdown = (inputEl: HTMLInputElement, onSelected: (ticketId: string) => void) => {
						const container = inputEl.parentElement;
						if (!container) { return; }
						container.style.position = 'relative';

						const menu = append(container, $('div.ticket-search-autocomplete-menu', {
							style: 'display: none; position: absolute; left: 0; right: 0; top: calc(100% + 3px); background: #161622; border: 1px solid rgba(168, 85, 247, 0.5); border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.65); max-height: 220px; overflow-y: auto; z-index: 10000; padding: 4px;'
						}));

						let activeIndex = -1;
						let currentCandidates: Array<{ id: string; title: string; type: string }> = [];

						const hideMenu = () => {
							menu.style.display = 'none';
							activeIndex = -1;
						};

						const renderCandidates = (candidates: Array<{ id: string; title: string; type: string }>) => {
							currentCandidates = candidates;
							clearNode(menu);
							if (candidates.length === 0) {
								hideMenu();
								return;
							}
							menu.style.display = 'block';
							candidates.forEach((cand, idx) => {
								const item = append(menu, $('div', {
									style: `display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; transition: background 0.1s ease; border-bottom: 1px solid rgba(255,255,255,0.05); ${idx === activeIndex ? 'background: rgba(168, 85, 247, 0.25);' : ''}`
								}));
								const topRow = append(item, $('div', { style: 'display: flex; align-items: center; justify-content: space-between; gap: 6px;' }));
								append(topRow, $('span', { style: 'font-weight: 700; color: #38bdf8; font-family: var(--vscode-editor-font-family, monospace);' }, cand.id));
								if (cand.type) {
									append(topRow, $('span', { style: 'font-size: 9.5px; padding: 1px 5px; border-radius: 3px; background: rgba(168, 85, 247, 0.25); color: #e9d5ff;' }, cand.type));
								}
								if (cand.title && cand.title !== cand.id) {
									append(item, $('span', { style: 'font-size: 10px; opacity: 0.75; color: #cbd5e1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }, cand.title));
								}
								item.onmouseenter = () => {
									Array.from(menu.children).forEach((ch, cIdx) => {
										(ch as HTMLElement).style.background = cIdx === idx ? 'rgba(168, 85, 247, 0.25)' : 'transparent';
									});
									activeIndex = idx;
								};
								item.onmousedown = (e) => {
									e.preventDefault();
									e.stopPropagation();
									inputEl.value = cand.id;
									hideMenu();
									onSelected(cand.id);
								};
							});
						};

						const doSearch = () => {
							const q = (inputEl.value || '').trim().toLowerCase();
							try {
								const snapshots = this._entityPersistenceService.getAllSnapshots() || [];
								const matched: Array<{ id: string; title: string; type: string }> = [];
								for (const s of snapshots) {
									const tid = (s.ticketId || s.entityName || '').trim();
									const title = (s.title || s.entityName || '').trim();
									const type = (s.entityType || '').trim();
									if (!tid) { continue; }
									if (!q || tid.toLowerCase().includes(q) || title.toLowerCase().includes(q) || type.toLowerCase().includes(q)) {
										matched.push({ id: tid, title, type });
										if (matched.length >= 8) { break; }
									}
								}
								renderCandidates(matched);
							} catch {
								hideMenu();
							}
						};

						inputEl.addEventListener('input', doSearch);
						inputEl.addEventListener('focus', () => {
							if (inputEl.value.trim().length > 0) {
								doSearch();
							}
						});
						inputEl.addEventListener('blur', () => {
							setTimeout(() => hideMenu(), 200);
						});
						inputEl.addEventListener('keydown', (e) => {
							if (menu.style.display === 'none') { return; }
							if (e.key === 'ArrowDown') {
								e.preventDefault();
								activeIndex = (activeIndex + 1) % currentCandidates.length;
								renderCandidates(currentCandidates);
							} else if (e.key === 'ArrowUp') {
								e.preventDefault();
								activeIndex = (activeIndex - 1 + currentCandidates.length) % currentCandidates.length;
								renderCandidates(currentCandidates);
							} else if (e.key === 'Enter' && activeIndex >= 0 && activeIndex < currentCandidates.length) {
								e.preventDefault();
								const selected = currentCandidates[activeIndex];
								inputEl.value = selected.id;
								hideMenu();
								onSelected(selected.id);
							} else if (e.key === 'Escape') {
								hideMenu();
							}
						});
					};

					const normalizeTypeSlug = (s: string): string => (s || '').trim().toLowerCase().replace(/[-_\s]+/g, ' ');
					const resolvedTicketInfoCache = new Map<string, { ticketType?: string; schema?: ICustomModule }>();
					const pendingTicketInfoFetches = new Set<string>();

					const ensureTicketSchemaLoadedAsync = (rawTarget: string, onLoaded: () => void) => {
						const trimmed = (rawTarget || '').trim();
						if (!trimmed || /^\{[^{}]+\}$/.test(trimmed)) {
							return;
						}
						const key = trimmed.toLowerCase();
						if (resolvedTicketInfoCache.has(key) || pendingTicketInfoFetches.has(key)) {
							return;
						}
						const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);
						if (!wsUri || !this._ticketWorkflowRuntimeService) {
							return;
						}
						pendingTicketInfoFetches.add(key);
						this._ticketWorkflowRuntimeService.getTicket(wsUri, trimmed).then(res => {
							pendingTicketInfoFetches.delete(key);
							if (res && res.success) {
								resolvedTicketInfoCache.set(key, {
									ticketType: res.ticketType || res.schema?.name || res.schema?.id || '',
									schema: res.schema
								});
								onLoaded();
							} else {
								resolvedTicketInfoCache.set(key, {});
							}
						}).catch(() => {
							pendingTicketInfoFetches.delete(key);
							resolvedTicketInfoCache.set(key, {});
						});
					};

					const findModuleByType = (typeName: string): ICustomModule | undefined => {
						const clean = (typeName || '').trim();
						if (!clean) {
							return undefined;
						}
						const lower = clean.toLowerCase();
						const norm = normalizeTypeSlug(clean);
						return allWorkspaceModules.find(m =>
							(m.name || '').trim().toLowerCase() === lower ||
							(m.id || '').trim().toLowerCase() === lower ||
							normalizeTypeSlug(m.name || '') === norm ||
							normalizeTypeSlug(m.id || '') === norm
						);
					};

					const detectTicketType = (rawTarget: string): string => {
						const trimmed = (rawTarget || '').trim();
						if (!trimmed) {
							return '';
						}
						// 0. Cached runtime disk lookup
						const cached = resolvedTicketInfoCache.get(trimmed.toLowerCase());
						if (cached?.ticketType) {
							return cached.ticketType;
						}
						// 1. Snapshot match
						try {
							const snapshots = this._entityPersistenceService.getAllSnapshots() || [];
							const found = snapshots.find(s =>
								(s.ticketId || '').toLowerCase() === trimmed.toLowerCase() ||
								(s.entityName || '').toLowerCase() === trimmed.toLowerCase() ||
								(s.title || '').toLowerCase() === trimmed.toLowerCase()
							);
							if (found && found.entityType) {
								return found.entityType;
							}
						} catch { }

						// 1.5 Sibling component in the same node targeting the same ticket ID with known wfTicketType
						const siblingWithType = fields.find(f =>
							f && f.wfTicketType &&
							((f.wfTicketTarget || '').trim().toLowerCase() === trimmed.toLowerCase() ||
								(f.wfTicketId || '').trim().toLowerCase() === trimmed.toLowerCase())
						);
						if (siblingWithType?.wfTicketType) {
							return siblingWithType.wfTicketType;
						}

						// 2. Variable match {created_ticket_1} or created_ticket_1
						const varMatch = trimmed.match(/^\{([^{}]+)\}$/);
						const varName = (varMatch ? varMatch[1] : trimmed).trim().toLowerCase();
						const upstreamField = fields.find(f => f && (f.outputVariableName || '').toLowerCase() === varName);
						if (upstreamField && upstreamField.wfTicketType) {
							return upstreamField.wfTicketType;
						} else if (isFlowchartNodeMode && input.workflowVariablesProvider) {
							try {
								const wfVars = input.workflowVariablesProvider() || [];
								const matchingWfVar = wfVars.find(v => (v.label || '').toLowerCase() === varName);
								if (matchingWfVar && matchingWfVar.ticketType) {
									return matchingWfVar.ticketType;
								}
							} catch { }
						}

						// 3. Direct match with module name / id / normalized slug
						const directMod = findModuleByType(trimmed);
						if (directMod) {
							return directMod.name;
						}

						return '';
					};

					const resolveTargetTicketOutputs = (
						rawTarget: string,
						explicitType?: string,
						includeTicketAttributes: boolean = false,
						strictOutputsOnly: boolean = false
					): Array<{ fieldKey: string; label: string; group: string; varName?: string; fieldName?: string }> => {
						const options: Array<{ fieldKey: string; label: string; group: string; varName?: string; fieldName?: string }> = [];
						const trimmed = (rawTarget || '').trim();
						let targetType = (explicitType || '').trim();

						if (!targetType && trimmed) {
							targetType = detectTicketType(trimmed) || trimmed;
						}

						if (includeTicketAttributes && !strictOutputsOnly) {
							options.push(
								{ fieldKey: 'status', label: 'Ticket Status (status)', group: 'Standard Ticket Properties', varName: 'status', fieldName: 'Ticket Status' },
								{ fieldKey: 'ticketId', label: 'Ticket ID (ticketId)', group: 'Standard Ticket Properties', varName: 'ticketId', fieldName: 'Ticket ID' },
								{ fieldKey: 'description', label: 'Description (description)', group: 'Standard Ticket Properties', varName: 'description', fieldName: 'Description' },
								{ fieldKey: 'outputs', label: 'Outputs Object (outputs)', group: 'Standard Ticket Properties', varName: 'outputs', fieldName: 'Outputs Object' }
							);
						}

						// Look up module schema (supports normalized slug match + cached disk schema fallback)
						const cachedDiskSchema = trimmed ? resolvedTicketInfoCache.get(trimmed.toLowerCase())?.schema : undefined;
						const targetMod = findModuleByType(targetType) || cachedDiskSchema;
						if (targetMod && Array.isArray(targetMod.fields)) {
							// 1. Output/Result component outputSpecs
							const outputFields = targetMod.fields.filter(f => f.type === 'output');
							outputFields.forEach(f => {
								if (Array.isArray(f.outputSpecs)) {
									f.outputSpecs.forEach(spec => {
										// Strictly only include enabled output specs
										if (spec && spec.enabled !== false) {
											const specKey = (spec.fieldKey || spec.label || '').trim();
											const specLabel = (spec.label || spec.fieldKey || '').trim();
											if (!specKey && !specLabel) { return; }

											const matchedComp = targetMod.fields.find(cf =>
												cf.type !== 'output' && (
													cf.id === specKey ||
													cf.label === specLabel ||
													cf.label === specKey ||
													cf.id === specLabel ||
													(cf.outputVariableName && (cf.outputVariableName === specKey || cf.outputVariableName === specLabel))
												)
											);

											const compTypeRaw = matchedComp?.type || 'output';
											const fieldName = (matchedComp?.label || specLabel || specKey).trim();
											const varName = (matchedComp?.outputVariableName || generateSmartPythonVarName(fieldName, compTypeRaw)).trim();

											const primaryKey = fieldName || specKey || varName;

											if (!options.some(o => o.fieldKey === primaryKey || o.fieldKey === specKey || o.varName === varName)) {
												options.push({
													fieldKey: primaryKey,
													label: fieldName,
													fieldName: fieldName,
													group: 'Enabled Template Outputs',
													varName: varName
												});
											}
										}
									});
								}
							});

							// 2. Only if NOT strictOutputsOnly, include other component outputs
							if (!strictOutputsOnly) {
								targetMod.fields.forEach(f => {
									if (f.type !== 'output' && f.type !== 'parameters') {
										const outVar = (f.outputVariableName || '').trim();
										const compLabel = (f.label || f.id || '').trim();
										const key = outVar || compLabel;
										if (key && !options.some(o => o.fieldKey === key || o.fieldName === compLabel)) {
											const compTypeDisplay = f.type.charAt(0).toUpperCase() + f.type.slice(1);
											options.push({
												fieldKey: key,
												label: `${compLabel} (${compTypeDisplay})`,
												fieldName: compLabel,
												group: 'Component Outputs',
												varName: outVar || key
											});
										}
									}
								});
							}
						}

						return options;
					};

					if (field.type === 'create_tickets') {
						if (!field.wfTicketParams) {
							field.wfTicketParams = {};
						}
						// Row 1: Ticket Type
						const typeRow = append(wfBox, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;' }));
						append(typeRow, $('label', { style: 'font-size: 11px; font-weight: 600; min-width: 95px; opacity: 0.85;' }, 'Ticket Type:'));
						const typeSelect = append(typeRow, $('select.monaco-select', {
							style: 'padding: 4px 10px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(168, 85, 247, 0.4); background: #14141d; color: #e9d5ff; min-width: 200px; cursor: pointer;'
						})) as HTMLSelectElement;
						append(typeSelect, $('option', { value: '' }, '-- Select Ticket Type --'));
						// Freestyle tickets can only be created manually in the UI: not offered here
						allWorkspaceModules.filter(m => !clashesWithBuiltInTicketType(m)).forEach(m => {
							const opt = append(typeSelect, $('option', { value: m.name }, m.name)) as HTMLOptionElement;
							if ((field.wfTicketType || '').toLowerCase() === (m.name || '').toLowerCase()) {
								opt.selected = true;
							}
						});

						// Row 2: Ticket Title
						const titleRow = append(wfBox, $('div', { style: 'display: flex; flex-direction: column; gap: 3px;' }));
						const titleTop = append(titleRow, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;' }));
						append(titleTop, $('label', { style: 'font-size: 11px; font-weight: 600; min-width: 95px; opacity: 0.85;' }, 'Ticket Title:'));
						const titleInp = append(titleTop, $('input.monaco-inputbox', {
							type: 'text',
							placeholder: 'e.g. URL {job_position} {start_offset}',
							style: 'flex: 1; min-width: 140px; padding: 5px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.3); color: inherit; font-family: var(--vscode-editor-font-family, monospace);'
						})) as HTMLInputElement;
						titleInp.value = field.wfTicketTitle || '';
						titleInp.oninput = () => {
							field.wfTicketTitle = titleInp.value;
							this._syncDraft();
							this._persistCurrentModule().catch(() => { });
						};
						renderQuickInsertChipsForInput(titleRow, titleInp, () => {
							field.wfTicketTitle = titleInp.value;
							this._syncDraft();
							this._persistCurrentModule().catch(() => { });
						});

						// Row 3: Path
						const pathRow = append(wfBox, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;' }));
						append(pathRow, $('label', { style: 'font-size: 11px; font-weight: 600; min-width: 95px; opacity: 0.85;' }, 'Ticket Path:'));
						const pathInp = append(pathRow, $('input.monaco-inputbox', {
							type: 'text',
							placeholder: '.',
							style: 'width: 180px; padding: 4px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.3); color: inherit; font-family: var(--vscode-editor-font-family, monospace);'
						})) as HTMLInputElement;
						pathInp.value = field.wfTicketPath ?? '.';
						pathInp.oninput = () => {
							field.wfTicketPath = pathInp.value;
							this._syncDraft();
							this._persistCurrentModule().catch(() => { });
						};

						// Row 4: Dynamic Schema-Driven Inputs Parameters
						const paramsContainer = append(wfBox, $('div', {
							style: 'display: flex; flex-direction: column; gap: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.08);'
						}));

						const renderDynamicParams = () => {
							clearNode(paramsContainer);
							const selectedType = field.wfTicketType || '';
							const schemaParams = resolveModuleParameters(selectedType);
							append(paramsContainer, $('div', {
								style: 'font-size: 10.5px; font-weight: 700; text-transform: uppercase; color: #c084fc; letter-spacing: 0.04em;'
							}, selectedType
								? `Inputs of "${selectedType}" (${schemaParams.length})`
								: 'Inputs (Select a Ticket Type above to load its Inputs schema)'));

							if (schemaParams.length === 0) {
								append(paramsContainer, $('div', {
									style: 'font-size: 11px; opacity: 0.6; font-style: italic;'
								}, selectedType ? `Ticket type "${selectedType}" has no Inputs parameters defined.` : 'No Ticket Type selected.'));
								return;
							}

							schemaParams.forEach(p => {
								const hasDefault = p.defaultValue !== undefined && String(p.defaultValue).trim() !== '';
								const pWrap = append(paramsContainer, $('div', {
									style: 'display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; border-radius: 5px; background: rgba(0,0,0,0.22); border: 1px solid rgba(255,255,255,0.07);'
								}));
								const pRow = append(pWrap, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: nowrap;' }));
								append(pRow, $('span', {
									style: 'font-size: 11.5px; font-weight: 600; font-family: var(--vscode-editor-font-family, monospace); min-width: 110px; color: #f8fafc; flex-shrink: 0;'
								}, p.name));
								const pInp = append(pRow, $('input.monaco-inputbox', {
									type: 'text',
									placeholder: hasDefault ? `Default: ${p.defaultValue}` : `Enter value or {var} for ${p.name}`,
									style: 'flex: 1; min-width: 120px; padding: 4px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.35); color: inherit; font-family: var(--vscode-editor-font-family, monospace);'
								})) as HTMLInputElement;
								const existingVal = field.wfTicketParams && Object.prototype.hasOwnProperty.call(field.wfTicketParams, p.name)
									? field.wfTicketParams[p.name]
									: undefined;
								if (existingVal !== undefined && String(existingVal) !== '') {
									pInp.value = String(existingVal);
								} else if (hasDefault) {
									pInp.value = String(p.defaultValue);
									if (!field.wfTicketParams) {
										field.wfTicketParams = {};
									}
									field.wfTicketParams[p.name] = pInp.value;
								} else {
									pInp.value = '';
								}
								append(pRow, $('span', {
									title: hasDefault ? `Optional parameter (schema default: ${p.defaultValue})` : 'Required parameter',
									style: `font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 4px; white-space: nowrap; flex-shrink: 0; ${hasDefault ? 'background: rgba(56, 189, 248, 0.12); color: #7dd3fc; border: 1px solid rgba(56, 189, 248, 0.28);' : 'background: rgba(245, 158, 11, 0.16); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.35);'}`
								}, hasDefault ? 'Optional' : 'Required'));
								const saveParamVal = () => {
									if (!field.wfTicketParams) {
										field.wfTicketParams = {};
									}
									field.wfTicketParams[p.name] = pInp.value;
									this._syncDraft();
									this._persistCurrentModule().catch(() => { });
								};
								pInp.oninput = saveParamVal;
								renderQuickInsertChipsForInput(pWrap, pInp, saveParamVal);
							});
						};

						typeSelect.onchange = () => {
							field.wfTicketType = typeSelect.value;
							renderDynamicParams();
							this._syncDraft();
							this._persistCurrentModule().catch(() => { });
						};
						renderDynamicParams();
					} else if (field.type === 'run_tickets') {
						if (!field.wfTicketParams) {
							field.wfTicketParams = {};
						}
						const targetRow = append(wfBox, $('div', { style: 'display: flex; flex-direction: column; gap: 3px;' }));
						const targetTop = append(targetRow, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;' }));
						append(targetTop, $('label', { style: 'font-size: 11px; font-weight: 600; min-width: 95px; opacity: 0.85;' }, 'Target Ticket:'));
						const targetInp = append(targetTop, $('input.monaco-inputbox', {
							type: 'text',
							placeholder: 'Ticket handle (e.g. {created_ticket_1}) or Ticket ID (e.g. FINDJ-0002)',
							style: 'flex: 1; min-width: 200px; padding: 5px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.3); color: inherit; font-family: var(--vscode-editor-font-family, monospace);'
						})) as HTMLInputElement;
						targetInp.value = field.wfTicketTarget || '';

						// Optional Ticket Type selector to resolve Inputs parameters
						const schemaRow = append(wfBox, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;' }));
						append(schemaRow, $('label', { style: 'font-size: 11px; font-weight: 600; min-width: 95px; opacity: 0.85;' }, 'Ticket Type:'));
						const schemaSelect = append(schemaRow, $('select.monaco-select', {
							style: 'padding: 4px 10px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(168, 85, 247, 0.4); background: #14141d; color: #e9d5ff; min-width: 200px; cursor: pointer;'
						})) as HTMLSelectElement;
						append(schemaSelect, $('option', { value: '' }, '-- Auto-detect from Create Tickets / Select Type --'));
						allWorkspaceModules.forEach(m => {
							const opt = append(schemaSelect, $('option', { value: m.name }, m.name)) as HTMLOptionElement;
							if ((field.wfTicketType || '').toLowerCase() === (m.name || '').toLowerCase()) {
								opt.selected = true;
							}
						});

						const paramsContainer = append(wfBox, $('div', {
							style: 'display: flex; flex-direction: column; gap: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.08);'
						}));

						const findUpstreamCreateField = (): ICustomField | undefined => {
							const rawTarget = (field.wfTicketTarget || '').trim().replace(/^\{|\}$/g, '').trim().toLowerCase();
							if (!rawTarget) {
								return undefined;
							}
							return fields.find(f =>
								f.type === 'create_tickets' && (
									(f.outputVariableName || '').trim().toLowerCase() === rawTarget ||
									(f.label || '').trim().toLowerCase() === rawTarget ||
									(f.id || '').trim().toLowerCase() === rawTarget
								)
							);
						};

						const detectRunTargetTicketType = (): string => {
							const rawTarget = (field.wfTicketTarget || '').trim().replace(/^\{|\}$/g, '').trim().toLowerCase();
							if (!rawTarget) {
								return '';
							}
							const upstreamCreate = findUpstreamCreateField();
							if (upstreamCreate?.wfTicketType) {
								return upstreamCreate.wfTicketType;
							}
							if (isFlowchartNodeMode && input.workflowVariablesProvider) {
								try {
									const wfVars = input.workflowVariablesProvider() || [];
									const matchedVar = wfVars.find(v => (v.label || '').trim().toLowerCase() === rawTarget && v.ticketType);
									if (matchedVar?.ticketType) {
										return matchedVar.ticketType;
									}
								} catch { }
							}
							const snapshots = this._entityPersistenceService.getAllSnapshots() || [];
							const matchedSnap = snapshots.find(s =>
								s.ticketId?.toLowerCase() === rawTarget ||
								s.entityName?.toLowerCase() === rawTarget
							);
							return matchedSnap?.entityType || '';
						};

						const resolveRunTargetTicketType = (): string => {
							if (field.wfTicketType) {
								return field.wfTicketType;
							}
							return detectRunTargetTicketType();
						};

						const syncDetectedTypeToSelect = (detected: string) => {
							if (!detected) {
								return;
							}
							const matchedMod = allWorkspaceModules.find(m =>
								(m.name || '').toLowerCase() === detected.toLowerCase() ||
								(m.id || '').toLowerCase() === detected.toLowerCase()
							);
							const canonical = matchedMod ? matchedMod.name : detected;
							field.wfTicketType = canonical;
							schemaSelect.value = canonical;
						};

						const renderRunParams = () => {
							clearNode(paramsContainer);
							if (!field.wfTicketType) {
								const detected = detectRunTargetTicketType();
								if (detected) {
									syncDetectedTypeToSelect(detected);
								}
							}
							const effectiveType = resolveRunTargetTicketType();
							const upstreamCreate = findUpstreamCreateField();
							const schemaParams = resolveModuleParameters(effectiveType || field.wfTicketTarget || '');
							if (field.wfTicketParams && schemaParams.length > 0) {
								const validParamNames = new Set(schemaParams.map(p => p.name.toLowerCase()));
								for (const k of Object.keys(field.wfTicketParams)) {
									if (!validParamNames.has(k.toLowerCase())) {
										delete field.wfTicketParams[k];
									}
								}
							}
							append(paramsContainer, $('div', {
								style: 'font-size: 10.5px; font-weight: 700; text-transform: uppercase; color: #c084fc;'
							}, effectiveType
								? `Inputs of "${effectiveType}" (${schemaParams.length})`
								: 'Inputs (Select Ticket Type or link a Create Tickets handle)'));
							schemaParams.forEach(p => {
								const hasDefault = p.defaultValue !== undefined && String(p.defaultValue).trim() !== '';
								const pWrap = append(paramsContainer, $('div', {
									style: 'display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; border-radius: 5px; background: rgba(0,0,0,0.22); border: 1px solid rgba(255,255,255,0.07);'
								}));
								const pRow = append(pWrap, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: nowrap;' }));
								append(pRow, $('span', {
									style: 'font-size: 11.5px; font-weight: 600; font-family: var(--vscode-editor-font-family, monospace); min-width: 110px; color: #f8fafc; flex-shrink: 0;'
								}, p.name));
								const pInp = append(pRow, $('input.monaco-inputbox', {
									type: 'text',
									placeholder: hasDefault ? `Default: ${p.defaultValue}` : `Enter value or {var} for ${p.name}`,
									style: 'flex: 1; min-width: 120px; padding: 4px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.35); color: inherit; font-family: var(--vscode-editor-font-family, monospace);'
								})) as HTMLInputElement;
								const ownVal = field.wfTicketParams && Object.prototype.hasOwnProperty.call(field.wfTicketParams, p.name)
									? field.wfTicketParams[p.name]
									: undefined;
								const inheritedVal = upstreamCreate?.wfTicketParams?.[p.name];
								if (ownVal !== undefined && String(ownVal) !== '') {
									pInp.value = String(ownVal);
								} else if (inheritedVal !== undefined && String(inheritedVal) !== '') {
									pInp.value = String(inheritedVal);
									if (!field.wfTicketParams) {
										field.wfTicketParams = {};
									}
									field.wfTicketParams[p.name] = pInp.value;
								} else if (hasDefault) {
									pInp.value = String(p.defaultValue);
									if (!field.wfTicketParams) {
										field.wfTicketParams = {};
									}
									field.wfTicketParams[p.name] = pInp.value;
								} else {
									pInp.value = '';
								}
								append(pRow, $('span', {
									title: hasDefault ? `Optional parameter (schema default: ${p.defaultValue})` : 'Required parameter',
									style: `font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 4px; white-space: nowrap; flex-shrink: 0; ${hasDefault ? 'background: rgba(56, 189, 248, 0.12); color: #7dd3fc; border: 1px solid rgba(56, 189, 248, 0.28);' : 'background: rgba(245, 158, 11, 0.16); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.35);'}`
								}, hasDefault ? 'Optional' : 'Required'));
								const saveParamVal = () => {
									if (!field.wfTicketParams) {
										field.wfTicketParams = {};
									}
									field.wfTicketParams[p.name] = pInp.value;
									this._syncDraft();
									this._persistCurrentModule().catch(() => { });
								};
								pInp.oninput = saveParamVal;
								renderQuickInsertChipsForInput(pWrap, pInp, saveParamVal);
							});
						};

						const onTargetUpdated = () => {
							field.wfTicketTarget = targetInp.value;
							const detected = detectRunTargetTicketType();
							if (detected) {
								syncDetectedTypeToSelect(detected);
							}
							renderRunParams();
							refreshPythonPreview();
							this._syncDraft();
							this._persistCurrentModule().catch(() => { });
						};
						targetInp.oninput = onTargetUpdated;
						attachTicketSearchDropdown(targetInp, (selectedId) => {
							field.wfTicketTarget = selectedId;
							const detected = detectRunTargetTicketType();
							if (detected) {
								syncDetectedTypeToSelect(detected);
							}
							renderRunParams();
							refreshPythonPreview();
							this._syncDraft();
							this._persistCurrentModule().catch(() => { });
						});
						renderWorkflowTicketVariableChips(targetRow, targetInp, onTargetUpdated);
						schemaSelect.onchange = () => {
							field.wfTicketType = schemaSelect.value;
							renderRunParams();
							refreshPythonPreview();
							this._syncDraft();
							this._persistCurrentModule().catch(() => { });
						};
						renderRunParams();
					} else if (field.type === 'get_outputs') {
						const targetRow = append(wfBox, $('div', { style: 'display: flex; flex-direction: column; gap: 3px;' }));
						const targetTop = append(targetRow, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;' }));
						append(targetTop, $('label', { style: 'font-size: 11px; font-weight: 600; min-width: 95px; opacity: 0.85;' }, 'Target Ticket:'));
						const targetInp = append(targetTop, $('input.monaco-inputbox', {
							type: 'text',
							placeholder: 'Search ticket (e.g. FINDJ-3437) or enter handle {created_ticket}',
							style: 'flex: 1; min-width: 140px; padding: 5px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.3); color: inherit; font-family: var(--vscode-editor-font-family, monospace);'
						})) as HTMLInputElement;
						targetInp.value = field.wfTicketTarget || '';

						const fieldSection = append(wfBox, $('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }));

						let refreshFieldSelector: () => void = () => { };

						const onTargetChange = () => {
							field.wfTicketTarget = targetInp.value;
							refreshFieldSelector();
							refreshPythonPreview();
							this._syncDraft();
							this._persistCurrentModule().catch(() => { });
						};
						targetInp.oninput = onTargetChange;
						attachTicketSearchDropdown(targetInp, (selectedId) => {
							field.wfTicketTarget = selectedId;
							refreshFieldSelector();
							refreshPythonPreview();
							this._syncDraft();
							this._persistCurrentModule().catch(() => { });
						});
						renderWorkflowTicketVariableChips(targetRow, targetInp, onTargetChange);

						refreshFieldSelector = () => {
							clearNode(fieldSection);
							const rawTgt = (field.wfTicketTarget || '').trim();
							if (!rawTgt) {
								append(fieldSection, $('div', {
									style: 'font-size: 11px; color: #94a3b8; font-style: italic; padding: 7px 12px; background: rgba(255,255,255,0.03); border: 1px dashed rgba(255,255,255,0.12); border-radius: 4px; margin-left: 103px;'
								}, 'Specify a Target Ticket above to view enabled template outputs.'));
								return;
							}

							const candidateOutputs = resolveTargetTicketOutputs(rawTgt, undefined, false, true);
							if (candidateOutputs.length === 0) {
								ensureTicketSchemaLoadedAsync(rawTgt, () => {
									if (fieldSection.isConnected) {
										refreshFieldSelector();
									}
								});
							}

							const fTop = append(fieldSection, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; width: 100%;' }));
							append(fTop, $('label', {
								style: 'font-size: 11px; font-weight: 600; min-width: 95px; flex-shrink: 0; opacity: 0.9; color: #a855f7;',
								title: 'Extract a specific property/component output. Leave as All Outputs to get the entire output dictionary.'
							}, 'Field (Optional):'));

							const fSelect = append(fTop, $('select.monaco-select', {
								style: 'flex: 1 1 0; min-width: 0; padding: 4px 8px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(168, 85, 247, 0.4); background: #14141d; color: #e9d5ff; text-overflow: ellipsis;'
							})) as HTMLSelectElement;

							append(fSelect, $('option', { value: '' }, '-- All Outputs (Entire Dict) --'));

							let matchedCandidate: { fieldKey: string; label: string; group: string; varName?: string; fieldName?: string } | undefined;
							const curFieldLower = (field.wfTicketField || '').trim().toLowerCase();
							candidateOutputs.forEach(o => {
								const opt = append(fSelect, $('option', { value: o.fieldKey }, o.label)) as HTMLOptionElement;
								if (
									curFieldLower && (
										curFieldLower === o.fieldKey.toLowerCase() ||
										(o.varName && curFieldLower === o.varName.toLowerCase()) ||
										(o.fieldName && curFieldLower === o.fieldName.toLowerCase())
									)
								) {
									opt.selected = true;
									matchedCandidate = o;
								}
							});

							const customOpt = append(fSelect, $('option', { value: '__custom__' }, '-- Custom Field Name --')) as HTMLOptionElement;

							const fInp = append(fTop, $('input.monaco-inputbox', {
								type: 'text',
								placeholder: 'Variable name (e.g. job_status)',
								title: 'Output Variable Name defined in the Ticket Template',
								style: 'flex: 1 1 0; min-width: 0; padding: 4px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.3); color: inherit; font-family: var(--vscode-editor-font-family, monospace);'
							})) as HTMLInputElement;
							fInp.value = matchedCandidate?.varName || field.wfTicketField || '';

							if (!matchedCandidate && curFieldLower) {
								customOpt.selected = true;
							}

							fSelect.onchange = () => {
								if (fSelect.value === '__custom__') {
									fInp.focus();
								} else if (!fSelect.value) {
									field.wfTicketField = '';
									fInp.value = '';
									refreshPythonPreview();
									this._syncDraft();
									this._persistCurrentModule().catch(() => { });
								} else {
									const chosen = candidateOutputs.find(o => o.fieldKey === fSelect.value);
									const resolvedVarName = (chosen?.varName || fSelect.value).trim();
									field.wfTicketField = resolvedVarName;
									fInp.value = resolvedVarName;
									refreshPythonPreview();
									this._syncDraft();
									this._persistCurrentModule().catch(() => { });
								}
							};

							fInp.oninput = () => {
								field.wfTicketField = fInp.value.trim();
								const valLower = (field.wfTicketField || '').toLowerCase();
								const matchedOpt = Array.from(fSelect.options).find(opt => {
									if (opt.value.toLowerCase() === valLower) { return true; }
									const co = candidateOutputs.find(c => c.fieldKey.toLowerCase() === opt.value.toLowerCase());
									return !!(co && co.varName && co.varName.toLowerCase() === valLower);
								});
								if (matchedOpt) {
									matchedOpt.selected = true;
								} else if (field.wfTicketField) {
									customOpt.selected = true;
								} else {
									fSelect.value = '';
								}
								refreshPythonPreview();
								this._syncDraft();
								this._persistCurrentModule().catch(() => { });
							};

							append(fieldSection, $('span', { style: 'font-size: 10px; color: #94a3b8; margin-left: 103px;' }, 'Select an enabled Output Field from the ticket template to auto-fill its Variable Name, or leave blank to retrieve all outputs.'));
						};

						refreshFieldSelector();
					} else if (field.type === 'get_ticket') {
						if (!field.wfTicketTarget) {
							field.wfTicketTarget = field.wfTicketId || field.wfTicketVariable || '';
						}

						// 1. Ticket (Target Ticket ID or Ticket Variable)
						const targetRow = append(wfBox, $('div', { style: 'display: flex; flex-direction: column; gap: 3px;' }));
						const targetTop = append(targetRow, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;' }));
						append(targetTop, $('label', {
							style: 'font-size: 11px; font-weight: 600; min-width: 105px; opacity: 0.9; color: #38bdf8;',
							title: 'Target Ticket ID (e.g. FINDJ-3437) or Ticket Variable handle (e.g. {created_ticket_1})'
						}, 'Ticket:'));
						const targetInp = append(targetTop, $('input.monaco-inputbox', {
							type: 'text',
							placeholder: 'Search ticket (e.g. FINDJ-3437) or enter handle {created_ticket}',
							style: 'flex: 1; min-width: 140px; padding: 5px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.35); background: rgba(0,0,0,0.3); color: inherit; font-family: var(--vscode-editor-font-family, monospace);'
						})) as HTMLInputElement;
						targetInp.value = field.wfTicketTarget || '';

						// 2. Ticket Type (Auto-detected or Manual Confirmation)
						const typeRow = append(wfBox, $('div', { style: 'display: flex; flex-direction: column; gap: 3px;' }));
						const typeTop = append(typeRow, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;' }));
						append(typeTop, $('label', {
							style: 'font-size: 11px; font-weight: 600; min-width: 105px; opacity: 0.9; color: #a855f7;',
							title: 'Ticket Type schema definition. Automatically detected from Ticket/Variable, or manually confirmed.'
						}, 'Ticket Type:'));
						const typeSelect = append(typeTop, $('select.monaco-select', {
							style: 'padding: 4px 10px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(168, 85, 247, 0.4); background: #14141d; color: #e9d5ff; min-width: 200px;'
						})) as HTMLSelectElement;
						append(typeSelect, $('option', { value: '' }, '-- Auto-detect from Ticket --'));
						allWorkspaceModules.forEach(m => {
							const opt = append(typeSelect, $('option', { value: m.name }, m.name)) as HTMLOptionElement;
							if ((field.wfTicketType || '').toLowerCase() === (m.name || '').toLowerCase()) {
								opt.selected = true;
							}
						});
						const typeBadge = append(typeTop, $('span', { style: 'display: inline-flex; align-items: center; margin-left: 4px;' })) as HTMLElement;
						append(typeRow, $('span', { style: 'font-size: 10px; color: #94a3b8; margin-left: 113px;' }, 'Auto-detected from selected Ticket/Variable, or manually select to enforce the schema.'));

						// 3. Field (Visual Output Property Selector)
						const fieldSection = append(wfBox, $('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }));

						let refreshFieldSelector: () => void = () => { };

						const syncLegacyProperties = (val: string) => {
							field.wfTicketTarget = val;
							const varMatch = val.match(/^\{([^{}]+)\}$/);
							if (varMatch) {
								field.wfTicketVariable = val;
								field.wfTicketId = '';
							} else {
								field.wfTicketId = val;
								field.wfTicketVariable = '';
							}
						};

						const updateTypeBadgeAndInference = (isTargetChange: boolean = false) => {
							clearNode(typeBadge);
							const detected = detectTicketType(field.wfTicketTarget || '');
							if (isTargetChange && detected) {
								if (!field.wfTicketType || allWorkspaceModules.some(m => m.name.toLowerCase() === (field.wfTicketType || '').toLowerCase())) {
									field.wfTicketType = detected;
									typeSelect.value = detected;
								}
							}
							if (field.wfTicketType && detected && field.wfTicketType.toLowerCase() === detected.toLowerCase()) {
								append(typeBadge, $('span', {
									style: 'font-size: 10.5px; color: #38bdf8; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.3); padding: 1px 7px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px;'
								}, `\u26A1 Auto-detected: ${detected}`));
							} else if (field.wfTicketType && detected && field.wfTicketType.toLowerCase() !== detected.toLowerCase()) {
								append(typeBadge, $('span', {
									style: 'font-size: 10.5px; color: #e9d5ff; background: rgba(168, 85, 247, 0.15); border: 1px solid rgba(168, 85, 247, 0.35); padding: 1px 7px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px;'
								}, `Override: ${field.wfTicketType} (Detected: ${detected})`));
							} else if (detected) {
								append(typeBadge, $('span', {
									style: 'font-size: 10.5px; color: #38bdf8; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.3); padding: 1px 7px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px;'
								}, `\u26A1 Detected: ${detected}`));
							} else if (field.wfTicketType) {
								append(typeBadge, $('span', {
									style: 'font-size: 10.5px; color: #a78bfa; background: rgba(167, 139, 250, 0.12); border: 1px solid rgba(167, 139, 250, 0.3); padding: 1px 7px; border-radius: 4px;'
								}, `Schema: ${field.wfTicketType}`));
							}
						};

						const onTargetChange = () => {
							syncLegacyProperties(targetInp.value.trim());
							updateTypeBadgeAndInference(true);
							refreshFieldSelector();
							refreshPythonPreview();
							this._syncDraft();
							this._persistCurrentModule().catch(() => { });
						};
						targetInp.oninput = onTargetChange;
						attachTicketSearchDropdown(targetInp, (selectedId) => {
							targetInp.value = selectedId;
							syncLegacyProperties(selectedId);
							updateTypeBadgeAndInference(true);
							refreshFieldSelector();
							refreshPythonPreview();
							this._syncDraft();
							this._persistCurrentModule().catch(() => { });
						});
						renderWorkflowTicketVariableChips(targetRow, targetInp, onTargetChange);
						append(targetRow, $('span', { style: 'font-size: 10px; color: #94a3b8; margin-left: 113px;' }, 'Direct ticket ID (e.g. FINDJ-3437) or upstream Ticket variable reference (e.g. {created_ticket_1}).'));

						typeSelect.onchange = () => {
							field.wfTicketType = typeSelect.value;
							updateTypeBadgeAndInference(false);
							refreshFieldSelector();
							refreshPythonPreview();
							this._syncDraft();
							this._persistCurrentModule().catch(() => { });
						};

						refreshFieldSelector = () => {
							clearNode(fieldSection);
							const effectiveTarget = (field.wfTicketTarget || '').trim();
							const effectiveType = (field.wfTicketType || '').trim();

							if (!effectiveTarget && !effectiveType) {
								append(fieldSection, $('div', {
									style: 'font-size: 11px; color: #94a3b8; font-style: italic; padding: 7px 12px; background: rgba(255,255,255,0.03); border: 1px dashed rgba(255,255,255,0.12); border-radius: 4px; margin-left: 113px;'
								}, 'Select a Ticket or Ticket Type above to view and choose available Output fields.'));
								return;
							}

							const candidateOutputs = resolveTargetTicketOutputs(effectiveTarget, effectiveType, true);
							if (effectiveTarget && !effectiveType && candidateOutputs.length <= 4) {
								ensureTicketSchemaLoadedAsync(effectiveTarget, () => {
									if (fieldSection.isConnected) {
										updateTypeBadgeAndInference(true);
										refreshFieldSelector();
									}
								});
							}

							const fTop = append(fieldSection, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; width: 100%;' }));
							append(fTop, $('label', {
								style: 'font-size: 11px; font-weight: 600; min-width: 105px; flex-shrink: 0; opacity: 0.9; color: #a855f7;',
								title: 'Extract a specific property/component output (e.g. status, title, job_status). Leave as Full Ticket to return the entire ticket object.'
							}, 'Field (Optional):'));

							const fSelect = append(fTop, $('select.monaco-select', {
								style: 'flex: 1 1 0; min-width: 0; padding: 4px 8px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(168, 85, 247, 0.4); background: #14141d; color: #e9d5ff; text-overflow: ellipsis;'
							})) as HTMLSelectElement;

							append(fSelect, $('option', { value: '' }, '-- Full Ticket Object (Default) --'));

							const curFieldLower = (field.wfTicketField || '').trim().toLowerCase();
							let matchedCandidate: { fieldKey: string; label: string; group: string; varName?: string; fieldName?: string } | undefined;
							const matchesCurField = (o: { fieldKey: string; label: string; varName?: string; fieldName?: string }): boolean => {
								if (!curFieldLower) { return false; }
								return curFieldLower === o.fieldKey.toLowerCase()
									|| curFieldLower === o.label.toLowerCase()
									|| Boolean(o.varName && curFieldLower === o.varName.toLowerCase())
									|| Boolean(o.fieldName && curFieldLower === o.fieldName.toLowerCase());
							};

							const stdProps = candidateOutputs.filter(o => o.group === 'Standard Ticket Properties');
							if (stdProps.length > 0) {
								const optGroup = append(fSelect, $('optgroup', { label: 'Standard Ticket Properties' }));
								stdProps.forEach(o => {
									const opt = append(optGroup, $('option', { value: o.fieldKey }, o.label)) as HTMLOptionElement;
									if (matchesCurField(o)) {
										opt.selected = true;
										matchedCandidate = o;
									}
								});
							}

							const specOutputs = candidateOutputs.filter(o => o.group === 'Enabled Template Outputs' || o.group === 'Output Component Specs');
							if (specOutputs.length > 0) {
								const optGroup = append(fSelect, $('optgroup', { label: 'Enabled Template Outputs' }));
								specOutputs.forEach(o => {
									const opt = append(optGroup, $('option', { value: o.fieldKey }, o.label || o.fieldKey)) as HTMLOptionElement;
									if (matchesCurField(o)) {
										opt.selected = true;
										matchedCandidate = o;
									}
								});
							}

							const compOutputs = candidateOutputs.filter(o => o.group === 'Component Outputs');
							if (compOutputs.length > 0) {
								const optGroup = append(fSelect, $('optgroup', { label: 'Component Outputs' }));
								compOutputs.forEach(o => {
									const opt = append(optGroup, $('option', { value: o.fieldKey }, o.label)) as HTMLOptionElement;
									if (matchesCurField(o)) {
										opt.selected = true;
										matchedCandidate = o;
									}
								});
							}

							const customOpt = append(fSelect, $('option', { value: '__custom__' }, '-- Custom Field Name --')) as HTMLOptionElement;

							const fInp = append(fTop, $('input.monaco-inputbox', {
								type: 'text',
								placeholder: 'Variable / field name',
								title: 'Output Variable Name defined in the Ticket Template',
								style: 'flex: 1 1 0; min-width: 0; padding: 4px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.3); color: inherit; font-family: var(--vscode-editor-font-family, monospace);'
							})) as HTMLInputElement;
							fInp.value = matchedCandidate?.varName || field.wfTicketField || '';

							if (!matchedCandidate && curFieldLower) {
								customOpt.selected = true;
							}

							fSelect.onchange = () => {
								if (fSelect.value === '__custom__') {
									fInp.focus();
								} else if (!fSelect.value) {
									field.wfTicketField = '';
									fInp.value = '';
									refreshPythonPreview();
									this._syncDraft();
									this._persistCurrentModule().catch(() => { });
								} else {
									const chosen = candidateOutputs.find(o => o.fieldKey === fSelect.value);
									const resolvedVarName = (chosen?.varName || fSelect.value).trim();
									field.wfTicketField = resolvedVarName;
									fInp.value = resolvedVarName;
									refreshPythonPreview();
									this._syncDraft();
									this._persistCurrentModule().catch(() => { });
								}
							};

							fInp.oninput = () => {
								field.wfTicketField = fInp.value.trim();
								const valLower = (field.wfTicketField || '').toLowerCase();
								const matchedOpt = Array.from(fSelect.options).find(opt => {
									if (opt.value.toLowerCase() === valLower) { return true; }
									const co = candidateOutputs.find(c => c.fieldKey.toLowerCase() === opt.value.toLowerCase());
									return !!(co && co.varName && co.varName.toLowerCase() === valLower);
								});
								if (matchedOpt) {
									matchedOpt.selected = true;
								} else if (field.wfTicketField) {
									customOpt.selected = true;
								} else {
									fSelect.value = '';
								}
								refreshPythonPreview();
								this._syncDraft();
								this._persistCurrentModule().catch(() => { });
							};

							// Quick Selection Chips
							const chipBar = append(fieldSection, $('div', {
								style: 'display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: 2px; margin-left: 113px;'
							}));
							append(chipBar, $('span', { style: 'font-size: 10px; opacity: 0.7; color: #94a3b8;' }, 'Quick Select:'));

							const allChip = append(chipBar, $('button', {
								type: 'button',
								style: `padding: 1px 7px; font-size: 10px; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.4); cursor: pointer; font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap; ${!field.wfTicketField ? 'background: rgba(56, 189, 248, 0.3); color: #38bdf8; font-weight: 700;' : 'background: rgba(56, 189, 248, 0.08); color: #7dd3fc;'}`
							}, '[Full Ticket]'));
							allChip.onclick = () => {
								field.wfTicketField = '';
								fSelect.value = '';
								fInp.value = '';
								refreshPythonPreview();
								refreshFieldSelector();
								this._syncDraft();
								this._persistCurrentModule().catch(() => { });
							};

							const chipsToShow = candidateOutputs.slice(0, 8);
							chipsToShow.forEach(cand => {
								const isSelected = (field.wfTicketField || '').toLowerCase() === cand.fieldKey.toLowerCase();
								const chip = append(chipBar, $('button', {
									type: 'button',
									title: `Extract ${cand.label}`,
									style: `padding: 1px 7px; font-size: 10px; border-radius: 4px; border: 1px solid rgba(168, 85, 247, 0.4); cursor: pointer; font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap; ${isSelected ? 'background: rgba(168, 85, 247, 0.35); color: #e9d5ff; font-weight: 700;' : 'background: rgba(168, 85, 247, 0.08); color: #d8b4fe;'}`
								}, `+ ${cand.fieldKey}`));
								chip.onclick = () => {
									field.wfTicketField = cand.fieldKey;
									fSelect.value = cand.fieldKey;
									fInp.value = cand.fieldKey;
									refreshPythonPreview();
									refreshFieldSelector();
									this._syncDraft();
									this._persistCurrentModule().catch(() => { });
								};
							});

							append(fieldSection, $('span', { style: 'font-size: 10px; color: #94a3b8; margin-left: 113px;' }, 'Choose a specific property or component output, or leave blank to retrieve the full Ticket dictionary.'));
						};

						updateTypeBadgeAndInference(false);
						refreshFieldSelector();
					} else if (field.type === 'display') {
						const dispRow = append(wfBox, $('div', { style: 'display: flex; flex-direction: column; gap: 3px;' }));
						const dispTop = append(dispRow, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;' }));
						append(dispTop, $('label', { style: 'font-size: 11px; font-weight: 600; min-width: 95px; opacity: 0.85;' }, 'Display Value:'));
						const dispInp = append(dispTop, $('input.monaco-inputbox', {
							type: 'text',
							placeholder: 'Python expression or variable (e.g. len(items), {jbs_app_jsons}, "hello", 42)',
							style: 'flex: 1; min-width: 140px; padding: 5px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.3); color: inherit; font-family: var(--vscode-editor-font-family, monospace);'
						})) as HTMLInputElement;
						if (field.wfDisplayValue === '{title}' || field.wfDisplayValue === '{Title}' || field.wfDisplayValue === 'title') {
							field.wfDisplayValue = '';
						}
						dispInp.value = field.wfDisplayValue || '';
						const onDispChange = () => {
							field.wfDisplayValue = dispInp.value;
							refreshPythonPreview();
							this._syncDraft();
							this._persistCurrentModule().catch(() => { });
						};
						dispInp.oninput = onDispChange;
						renderQuickInsertChipsForInput(dispRow, dispInp, onDispChange);
					}

					// Last Execution Trace & Return Value Box for Built-in Workflow Components
					const wfExecCard = append(wfBox, $('div.component-exec-logs-card', {
						style: 'display: flex; flex-direction: column; gap: 4px; margin-top: 6px; background: rgba(0, 0, 0, 0.32); border: 1px solid rgba(168, 85, 247, 0.25); border-radius: 5px; padding: 6px 8px;'
					}));
					const wfExecHeader = append(wfExecCard, $('div', {
						style: 'display: flex; justify-content: space-between; align-items: center; font-size: 10.5px; gap: 8px; flex-wrap: wrap;'
					}));
					const wfExecTitle = append(wfExecHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; font-weight: 600; color: #d8b4fe;'
					}));
					append(wfExecTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.terminal)));
					append(wfExecTitle, $('span', {}, 'CONSOLE LOGS & EXECUTION RESULT'));
					const wfExecRight = append(wfExecHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-left: auto;'
					}));
					const wfExecStatus = append(wfExecRight, $('span', {
						style: 'font-size: 10px; font-family: var(--vscode-editor-font-family, monospace);'
					}));
					const updateWfExecStatus = () => {
						const st = (field as IRuntimeCustomField).lastExecutionStatus;
						if (st === 'success') {
							wfExecStatus.textContent = `Completed in ${(field as IRuntimeCustomField).lastExecutionDurationMs ?? 0}ms${(field as IRuntimeCustomField).lastExecutedAt ? ` · ${(field as IRuntimeCustomField).lastExecutedAt}` : ''}`;
							wfExecStatus.style.color = '#4ade80';
						} else if (st === 'failed') {
							wfExecStatus.textContent = `Failed (${(field as IRuntimeCustomField).lastExecutionDurationMs ?? 0}ms)${(field as IRuntimeCustomField).lastExecutedAt ? ` · ${(field as IRuntimeCustomField).lastExecutedAt}` : ''}`;
							wfExecStatus.style.color = '#f87171';
						} else if (st === 'skipped') {
							wfExecStatus.textContent = 'Skipped (Disabled)';
							wfExecStatus.style.color = '#94a3b8';
						} else {
							wfExecStatus.textContent = '[Ready to execute]';
							wfExecStatus.style.color = '#94a3b8';
						}
					};
					updateWfExecStatus();
					{
						const isActionBuiltin = field.type === 'create_tickets' || field.type === 'run_tickets';
						const wfExecTestBtn = append(wfExecRight, $('button', {
							type: 'button',
							title: `Run ${field.type.toUpperCase()} using current runtime variables`,
							style: 'display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; font-size: 10px; font-weight: 600; border-radius: 3px; border: 1px solid rgba(56, 189, 248, 0.45); background: rgba(56, 189, 248, 0.16); color: #7dd3fc; cursor: pointer;'
						})) as HTMLButtonElement;
						append(wfExecTestBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.play), { style: 'font-size: 10px;' }));
						const btnDefaultLabel = isActionBuiltin ? 'Run' : 'Test';
						const wfExecTestLabel = append(wfExecTestBtn, $('span', {}, btnDefaultLabel));
						wfExecTestBtn.onclick = async (e) => {
							e.stopPropagation();
							const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);
							if (!wsUri || !this._ticketWorkflowRuntimeService) {
								this.notificationService.warn('Workspace runtime is unavailable for running this component.');
								return;
							}
							wfExecTestBtn.disabled = true;
							wfExecTestLabel.textContent = 'Running...';
							try {
								const liveCtx: Record<string, unknown> = isFlowchartNodeMode
									? { ...(await this._getHydratedWorkflowRuntimeContext()) }
									: {};
								// Overlay sibling cards' latest outputs so freshly run/tested cards (e.g. {r2j_tkt}, {jbs_app_tkt}) always override stale run context
								for (const sf of fields) {
									if (!sf || sf === field) { continue; }
									const sOut = (sf.type === 'python' && sf.pythonResult !== undefined)
										? sf.pythonResult
										: (sf as IRuntimeCustomField).lastExecutionOutput;
									if (sOut !== undefined) {
										const sVar = (sf.outputVariableName || '').trim();
										if (sVar) {
											liveCtx[sVar] = sOut;
										}
										if (sf.label) {
											liveCtx[sf.label] = sOut;
										}
									}
								}
								await this._ticketWorkflowRuntimeService.executeNodeComponent(wsUri, wsUri, field, liveCtx);
								updateWfExecStatus();
								renderWfExecPreview();
								this._syncDraft();
							} catch (err) {
								(field as IRuntimeCustomField).lastExecutionStatus = 'failed';
								(field as IRuntimeCustomField).lastExecutionLog = `[Run Error]: ${(err as Error | undefined)?.message || err}`;
								updateWfExecStatus();
								renderWfExecPreview();
							} finally {
								wfExecTestBtn.disabled = false;
								wfExecTestLabel.textContent = btnDefaultLabel;
							}
						};
					}
					const wfExecCopyBtn = append(wfExecRight, $('button', {
						type: 'button',
						title: 'Copy complete execution result',
						style: 'display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; font-size: 10px; border-radius: 3px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05); color: inherit; cursor: pointer;'
					})) as HTMLButtonElement;
					const wfExecCopyIcon = append(wfExecCopyBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy), { style: 'font-size: 10.5px;' }));
					const wfExecCopyLabel = append(wfExecCopyBtn, $('span', {}, 'Copy'));
					const wfExecClearBtn = append(wfExecRight, $('button', {
						type: 'button',
						style: 'padding: 1px 6px; font-size: 10px; border-radius: 3px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05); color: inherit; cursor: pointer;'
					}, 'Clear'));
					const wfExecPre = append(wfExecCard, $('pre', {
						'data-selectable-box': 'true',
						style: 'margin: 0; padding: 4px 6px; font-size: 11px; line-height: 1.45; font-family: var(--vscode-editor-font-family, monospace); color: #cbd5e1; min-height: 40px; max-height: 180px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; user-select: text; -webkit-user-select: text; cursor: text;'
					}));
					const wfExecTruncNotice = append(wfExecCard, $('div', {
						style: 'display: none; font-size: 10px; color: #94a3b8; background: rgba(148, 163, 184, 0.08); border: 1px dashed rgba(148, 163, 184, 0.28); border-radius: 4px; padding: 3px 8px;'
					}));
					const getFullWfExecText = (): string => {
						const out = (field as IRuntimeCustomField).lastExecutionOutput;
						if (out !== undefined) {
							return typeof out === 'object' && out !== null ? JSON.stringify(out, null, 2) : String(out);
						}
						return String((field as IRuntimeCustomField).lastExecutionLog || '');
					};
					const renderWfExecPreview = () => {
						const fullText = getFullWfExecText();
						if (!fullText) {
							wfExecPre.textContent = '[Ready to execute] Execution trace and return values will be recorded here when the workflow or node runs.';
							wfExecTruncNotice.style.display = 'none';
							return;
						}
						const uiPreviewLimit = 8000;
						if (fullText.length > uiPreviewLimit) {
							wfExecPre.textContent = fullText.substring(0, uiPreviewLimit);
							wfExecTruncNotice.textContent = `UI preview truncated (showing ${uiPreviewLimit.toLocaleString()} of ${fullText.length.toLocaleString()} chars). Full original data is preserved in runtime and Copy.`;
							wfExecTruncNotice.style.display = 'block';
						} else {
							wfExecPre.textContent = fullText;
							wfExecTruncNotice.style.display = 'none';
						}
					};
					renderWfExecPreview();
					wfExecCopyBtn.onclick = async () => {
						const txt = getFullWfExecText();
						if (!txt || txt.startsWith('[Ready to execute]')) {
							this.notificationService.warn('No execution result to copy.');
							return;
						}
						await this._clipboardService.writeText(txt);
						wfExecCopyIcon.className = ThemeIcon.asClassName(Codicon.check);
						wfExecCopyBtn.style.color = '#4ade80';
						wfExecCopyLabel.textContent = 'Copied!';
						this.notificationService.info('Complete execution result copied to clipboard.');
						setTimeout(() => {
							if (wfExecCopyBtn.isConnected) {
								wfExecCopyIcon.className = ThemeIcon.asClassName(Codicon.copy);
								wfExecCopyBtn.style.color = '';
								wfExecCopyLabel.textContent = 'Copy';
							}
						}, 1500);
					};
					wfExecClearBtn.onclick = async () => {
						delete (field as IRuntimeCustomField).lastExecutionLog;
						delete (field as IRuntimeCustomField).lastExecutionOutput;
						delete (field as IRuntimeCustomField).lastExecutionStatus;
						delete (field as IRuntimeCustomField).lastExecutionDurationMs;
						delete (field as IRuntimeCustomField).lastExecutedAt;
						updateWfExecStatus();
						renderWfExecPreview();
						this._syncDraft();
						await this._persistCurrentModule();
					};
				}
			});

			// Persistent Drop Zone at the bottom of the right canvas!
			const bottomDropZone = append(rightCanvas, $('.canvas-drop-zone', {
				style: 'flex: 1; min-height: 120px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; border: 2px dashed rgba(255, 255, 255, 0.12); border-radius: 8px; background: rgba(255, 255, 255, 0.015); color: rgba(255, 255, 255, 0.45); font-size: 11.5px; transition: all 0.2s ease;'
			}));
			if (isEmbeddedFieldMode) {
				bottomDropZone.style.display = 'none';
			}
			bottomDropZone.ondragover = (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (e.dataTransfer) { e.dataTransfer.dropEffect = currentDraggingItem?.source === 'canvas' ? 'move' : 'copy'; }
				bottomDropZone.style.borderColor = '#38bdf8';
				bottomDropZone.style.background = 'rgba(56, 189, 248, 0.08)';
				bottomDropZone.style.color = '#38bdf8';
			};
			bottomDropZone.ondragleave = () => {
				bottomDropZone.style.borderColor = 'rgba(255, 255, 255, 0.12)';
				bottomDropZone.style.background = 'rgba(255, 255, 255, 0.015)';
				bottomDropZone.style.color = 'rgba(255, 255, 255, 0.45)';
			};
			bottomDropZone.ondrop = (e) => {
				e.preventDefault();
				e.stopPropagation();
				bottomDropZone.style.borderColor = 'rgba(255, 255, 255, 0.12)';
				bottomDropZone.style.background = 'rgba(255, 255, 255, 0.015)';
				bottomDropZone.style.color = 'rgba(255, 255, 255, 0.45)';
				handleItemDrop(undefined, 'after', e);
			};

			append(bottomDropZone, $('span' + ThemeIcon.asCSSSelector(Codicon.plus), { style: 'font-size: 20px; opacity: 0.6;' }));
			append(bottomDropZone, $('span', { style: 'font-weight: 500;' }, 'Drop components here to append to schema (or click on the left)'));

			bottomDropZone.addEventListener('mouseenter', () => {
				hoveredFieldIndex = fields.length - 1;
			});
			bottomDropZone.addEventListener('mousedown', () => {
				lastInteractedFieldIndex = fields.length - 1;
			});

			const dropZonePasteSlot = append(bottomDropZone, $('div', {
				style: 'display: flex; align-items: center; justify-content: center; margin-top: 4px;'
			}));
			const renderDropZonePasteButton = () => {
				clearNode(dropZonePasteSlot);
				if (!copiedSchemaComponentClipboard) {
					dropZonePasteSlot.style.display = 'none';
					return;
				}
				dropZonePasteSlot.style.display = 'flex';
				const cpField = copiedSchemaComponentClipboard.field;
				const cpLabel = cpField.label || cpField.id;
				const cpType = (cpField.type || 'text').toUpperCase();
				const pasteZoneBtn = append(dropZonePasteSlot, $('button.monaco-button', {
					type: 'button',
					style: 'padding: 5px 14px; font-size: 11.5px; font-weight: 600; border-radius: 6px; cursor: pointer; background: rgba(192, 132, 252, 0.14); color: #d8b4fe; border: 1px solid rgba(192, 132, 252, 0.4); display: inline-flex; align-items: center; gap: 6px; transition: all 0.15s ease;'
				}));
				append(pasteZoneBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.clippy), { style: 'font-size: 12px;' }));
				append(pasteZoneBtn, $('span', {}, `Paste Copied Component: "${cpLabel}" (${cpType}) · Cmd+V`));
				pasteZoneBtn.onmouseenter = () => {
					pasteZoneBtn.style.background = 'rgba(192, 132, 252, 0.24)';
					pasteZoneBtn.style.borderColor = '#c084fc';
				};
				pasteZoneBtn.onmouseleave = () => {
					pasteZoneBtn.style.background = 'rgba(192, 132, 252, 0.14)';
					pasteZoneBtn.style.borderColor = 'rgba(192, 132, 252, 0.4)';
				};
				pasteZoneBtn.onclick = (e) => {
					e.stopPropagation();
					pasteCopiedComponent(fields.length - 1).catch(() => { });
				};
			};
			renderDropZonePasteButton();
			pasteUiRefreshers.push(renderDropZonePasteButton);

			if (mainViewport && savedScrollTop > 0 && !didScrollToReorderedCard) {
				mainViewport.scrollTop = savedScrollTop;
				getWindow(mainViewport).requestAnimationFrame(() => {
					if (mainViewport && !didScrollToReorderedCard) {
						mainViewport.scrollTop = savedScrollTop;
					}
				});
			}
		};

		// Populate Base Components in Library
		baseComponents.forEach(bc => {
			const item = append(primitivesList, $('.primitive-item', {
				style: this._isToolboxCompact
					? 'width: 38px; height: 38px; border-radius: 6px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); cursor: grab; display: flex; align-items: center; justify-content: center; transition: all 0.15s ease;'
					: 'padding: 7px 10px; border-radius: 6px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); cursor: grab; display: flex; align-items: center; gap: 8px; transition: all 0.15s ease;'
			}));
			this._attachInstantTooltip(item, `${bc.label}: Drag or Click to Add`, '#38bdf8');
			item.setAttribute('draggable', 'true');
			item.ondragstart = (e) => {
				currentDraggingItem = { source: 'palette', type: bc.type };
				e.dataTransfer?.setData('text/plain', bc.type);
				if (e.dataTransfer) {
					e.dataTransfer.effectAllowed = 'copy';
				}
			};
			item.ondragend = () => {
				currentDraggingItem = null;
			};
			item.onmouseenter = () => {
				item.style.background = 'rgba(56, 189, 248, 0.12)';
				item.style.borderColor = 'rgba(56, 189, 248, 0.3)';
			};
			item.onmouseleave = () => {
				item.style.background = 'rgba(255, 255, 255, 0.04)';
				item.style.borderColor = 'rgba(255, 255, 255, 0.08)';
			};

			append(item, $('span' + ThemeIcon.asCSSSelector(bc.icon), { style: 'font-size: 14px; opacity: 0.85; min-width: 16px; text-align: center;' }));
			if (!this._isToolboxCompact) {
				append(item, $('span', { style: 'font-size: 11.5px; flex: 1;' }, bc.label));
				const toolboxInfoBtn = append(item, $('span.toolbox-item-info-btn', {
					style: 'display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; color: rgba(56, 189, 248, 0.7); font-size: 11px; cursor: pointer; transition: all 0.15s ease;',
					title: `View ${bc.label} documentation & RUN_TICKETS guide`
				}));
				append(toolboxInfoBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.info)));
				toolboxInfoBtn.onmouseenter = () => {
					toolboxInfoBtn.style.color = '#38bdf8';
					toolboxInfoBtn.style.background = 'rgba(56, 189, 248, 0.18)';
				};
				toolboxInfoBtn.onmouseleave = () => {
					toolboxInfoBtn.style.color = 'rgba(56, 189, 248, 0.7)';
					toolboxInfoBtn.style.background = 'transparent';
				};
				toolboxInfoBtn.onclick = (e) => {
					e.stopPropagation();
					e.preventDefault();
					showPrimitiveHelpModal(this._container!, bc.type, bc.label);
				};
			}

			item.onclick = () => {
				addFieldFromDef(bc);
			};
		});

		// Reusable Classes in Library
		const reusableSection = append(leftLibrary, $('.reusable-classes-section', {
			style: `display: flex; flex-direction: column; gap: 6px; margin-top: 10px; border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 10px; ${this._isToolboxCompact ? 'align-items: center;' : ''}`
		}));
		if (!this._isToolboxCompact) {
			append(reusableSection, $('div', {
				style: 'font-size: 10.5px; font-weight: 700; text-transform: uppercase; color: #06b6d4;'
			}, `Reusable Classes (${compositeClasses.length})`));
		}

		if (compositeClasses.length === 0) {
			if (!this._isToolboxCompact) {
				append(reusableSection, $('div', {
					style: 'font-size: 10.5px; opacity: 0.45; font-style: italic; padding: 4px 0;'
				}, 'No classes saved yet. Add a Container to canvas and click "Save as Class Asset".'));
			}
		} else {
			const compList = append(reusableSection, $('.composite-classes-list', {
				style: `display: flex; flex-direction: column; gap: 6px; ${this._isToolboxCompact ? 'align-items: center;' : ''}`
			}));
			compositeClasses.forEach(cc => {
				const ccItem = append(compList, $('.primitive-item', {
					title: `Class: ${cc.name} (Drag or Click to Add)`,
					style: this._isToolboxCompact
						? 'width: 38px; height: 38px; border-radius: 6px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); cursor: grab; display: flex; align-items: center; justify-content: center; transition: all 0.15s ease;'
						: 'padding: 7px 10px; border-radius: 6px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); cursor: grab; display: flex; align-items: center; gap: 8px; transition: all 0.15s ease;'
				}));
				ccItem.setAttribute('draggable', 'true');
				ccItem.ondragstart = (e) => {
					currentDraggingItem = { source: 'palette', isClass: true, classId: cc.id, name: cc.name };
					e.dataTransfer?.setData('text/plain', `composite:${cc.id}`);
					e.dataTransfer?.setData('application/json', JSON.stringify({ isComposite: true, id: cc.id, name: cc.name }));
					if (e.dataTransfer) {
						e.dataTransfer.effectAllowed = 'copy';
					}
				};
				ccItem.ondragend = () => {
					currentDraggingItem = null;
				};
				ccItem.onmouseenter = () => {
					ccItem.style.background = 'rgba(6, 182, 212, 0.12)';
					ccItem.style.borderColor = 'rgba(6, 182, 212, 0.35)';
				};
				ccItem.onmouseleave = () => {
					ccItem.style.background = 'rgba(255, 255, 255, 0.04)';
					ccItem.style.borderColor = 'rgba(255, 255, 255, 0.08)';
				};

				append(ccItem, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolClass), { style: 'color: #06b6d4; font-size: 13px; min-width: 16px; text-align: center;' }));
				if (!this._isToolboxCompact) {
					append(ccItem, $('span', { style: 'font-size: 11.5px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }, cc.name));
					const ccInfoBtn = append(ccItem, $('span.toolbox-item-info-btn', {
						style: 'display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; color: rgba(6, 182, 212, 0.7); font-size: 11px; cursor: pointer; transition: all 0.15s ease;',
						title: `View Class ${cc.name} documentation & RUN_TICKETS guide`
					}));
					append(ccInfoBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.info)));
					ccInfoBtn.onmouseenter = () => {
						ccInfoBtn.style.color = '#06b6d4';
						ccInfoBtn.style.background = 'rgba(6, 182, 212, 0.18)';
					};
					ccInfoBtn.onmouseleave = () => {
						ccInfoBtn.style.color = 'rgba(6, 182, 212, 0.7)';
						ccInfoBtn.style.background = 'transparent';
					};
					ccInfoBtn.onclick = (e) => {
						e.stopPropagation();
						e.preventDefault();
						showPrimitiveHelpModal(this._container!, 'reusable_class', cc.name, cc.id);
					};
				}

				ccItem.onclick = () => {
					addCompositeClass(cc);
				};
			});
		}

		// 3. Status Lifecycle Definitions Section in Left Library
		const statusSection = append(leftLibrary, $('.status-lifecycle-section', {
			style: 'display: flex; flex-direction: column; gap: 8px; margin-top: 10px; border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 10px;'
		}));
		const statusHeader = append(statusSection, $('div', {
			style: 'display: flex; justify-content: space-between; align-items: center;'
		}));
		append(statusHeader, $('div', {
			style: 'font-size: 10.5px; font-weight: 700; text-transform: uppercase; color: #a78bfa; display: flex; align-items: center; gap: 6px;'
		}, 'Status Lifecycle'));
		const statusCountBadge = append(statusHeader, $('span', {
			style: 'font-size: 10px; opacity: 0.75; background: rgba(167, 139, 250, 0.15); color: #a78bfa; padding: 1px 6px; border-radius: 4px; font-weight: 600;'
		}, `${currentStatuses.length} stages`));

		append(statusSection, $('div', {
			style: 'font-size: 10.5px; opacity: 0.65; line-height: 1.4;'
		}, 'Define workflow stages for this ticket type. Action buttons can transition tickets between these statuses.'));

		// Status Pills Preview Container
		const statusPillsBox = append(statusSection, $('div', {
			style: 'display: flex; flex-wrap: wrap; gap: 4px; padding: 2px 0;'
		}));
		const renderStatusPills = () => {
			clearNode(statusPillsBox);
			statusCountBadge.textContent = `${currentStatuses.length} stages`;
			currentStatuses.forEach(st => {
				const pill = append(statusPillsBox, $('div', {
					style: `font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 4px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); color: ${st.color || '#cccccc'}; display: inline-flex; align-items: center; gap: 5px;`
				}));
				append(pill, $('span', { style: `width: 6px; height: 6px; border-radius: 50%; background: ${st.color || '#cccccc'};` }));
				append(pill, $('span', {}, st.label));
			});
		};
		renderStatusPills();

		const configStatusBtn = append(statusSection, $('button.monaco-button', {
			style: 'padding: 6px 12px; font-size: 11px; border-radius: 6px; cursor: pointer; background: rgba(167, 139, 250, 0.15); border: 1px solid rgba(167, 139, 250, 0.35); color: #c4b5fd; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 6px; transition: all 0.15s ease;'
		}));
		append(configStatusBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.settingsGear)));
		append(configStatusBtn, $('span', {}, 'Configure Status Lifecycle'));

		const openStatusLifecycleModal = () => {
			const overlay = append(this._container!, $('.status-lifecycle-modal-overlay'));
			const modal = append(overlay, $('.status-lifecycle-modal-card', {
				style: 'padding: 20px; display: flex; flex-direction: column; gap: 14px;'
			}));

			// Modal Header
			const mHeader = append(modal, $('div', {
				style: 'display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 10px;'
			}));
			const mTitleWrap = append(mHeader, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
			append(mTitleWrap, $('span' + ThemeIcon.asCSSSelector(Codicon.pulse), { style: 'color: #a78bfa; font-size: 16px;' }));
			append(mTitleWrap, $('span', { style: 'font-size: 15px; font-weight: 600; color: #ffffff;' }, 'Status Lifecycle & Workflow Stages'));

			const closeBtn = append(mHeader, $('button', {
				style: 'background: transparent; border: none; font-size: 16px; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 2px 6px; border-radius: 4px;'
			}, '\u2715'));
			closeBtn.onclick = () => {
				overlay.remove();
			};

			append(modal, $('div', {
				style: 'font-size: 11.5px; opacity: 0.75; line-height: 1.5;'
			}, 'Define operational statuses for this ticket type. Action buttons on tickets can transition them between these statuses. Each status maps to a standard category bucket for search and reporting.'));

			// Scrollable list of statuses
			const listContainer = append(modal, $('.status-rows-container', {
				style: 'flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; max-height: 380px; padding-right: 4px;'
			}));

			let draggingStatusIndex: number | null = null;

			// Status rows currently rendered in `listContainer` (reset whenever the rows are re-rendered).
			const statusRows: HTMLElement[] = [];

			const renderModalRows = () => {
				clearNode(listContainer);
				statusRows.length = 0;
				currentStatuses.forEach((st, sIdx) => {
					const row = append(listContainer, $('.status-modal-row', {
						style: 'display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;'
					}));
					statusRows.push(row);

					// Drag Grip Handle (dots icon)
					const dragHandle = append(row, $('.status-row-drag-handle'));
					dragHandle.title = 'Drag to reorder';
					append(dragHandle, $('span' + ThemeIcon.asCSSSelector(Codicon.gripper)));
					dragHandle.onmousedown = () => { row.setAttribute('draggable', 'true'); };
					dragHandle.onmouseup = () => {
						if (draggingStatusIndex === null) {
							row.setAttribute('draggable', 'false');
						}
					};
					dragHandle.onmouseleave = () => {
						if (draggingStatusIndex === null) {
							row.setAttribute('draggable', 'false');
						}
					};

					row.ondragstart = (e) => {
						draggingStatusIndex = sIdx;
						e.dataTransfer?.setData('text/plain', `status:${sIdx}`);
						if (e.dataTransfer) {
							e.dataTransfer.effectAllowed = 'move';
						}
						row.style.opacity = '0.35';
						row.style.background = 'rgba(255, 255, 255, 0.08)';
					};

					row.ondragend = () => {
						row.setAttribute('draggable', 'false');
						row.style.opacity = '1';
						row.style.background = 'rgba(255, 255, 255, 0.03)';
						row.style.boxShadow = 'none';
						row.style.borderColor = 'rgba(255, 255, 255, 0.08)';
						draggingStatusIndex = null;
						statusRows.forEach(r => {
							r.style.boxShadow = 'none';
							r.style.borderColor = 'rgba(255, 255, 255, 0.08)';
						});
					};

					row.ondragover = (e) => {
						e.preventDefault();
						if (e.dataTransfer) {
							e.dataTransfer.dropEffect = 'move';
						}
						const rect = row.getBoundingClientRect();
						const isTop = e.clientY < rect.top + rect.height / 2;
						if (isTop) {
							row.style.boxShadow = '0 -2px 0 0 #38bdf8';
							row.style.borderColor = '#38bdf8';
						} else {
							row.style.boxShadow = '0 2px 0 0 #38bdf8';
							row.style.borderColor = '#38bdf8';
						}
					};

					row.ondragleave = () => {
						row.style.boxShadow = 'none';
						row.style.borderColor = 'rgba(255, 255, 255, 0.08)';
					};

					row.ondrop = (e) => {
						e.preventDefault();
						e.stopPropagation();
						row.style.boxShadow = 'none';
						row.style.borderColor = 'rgba(255, 255, 255, 0.08)';
						if (draggingStatusIndex === null || draggingStatusIndex === sIdx) {
							return;
						}
						const rect = row.getBoundingClientRect();
						const isTop = e.clientY < rect.top + rect.height / 2;
						let targetIdx = isTop ? sIdx : sIdx + 1;
						const [movedItem] = currentStatuses.splice(draggingStatusIndex, 1);
						if (draggingStatusIndex < targetIdx) {
							targetIdx--;
						}
						currentStatuses.splice(targetIdx, 0, movedItem);
						draggingStatusIndex = null;
						renderModalRows();
					};

					// Color Dot
					const colorDot = append(row, $('div', {
						style: `width: 18px; height: 18px; border-radius: 50%; background: ${st.color}; cursor: pointer; flex-shrink: 0; box-shadow: 0 0 6px ${st.color}55; border: 1.5px solid rgba(255,255,255,0.4);`
					}));
					colorDot.title = 'Click to cycle color';
					colorDot.onclick = () => {
						const colors = ['#818cf8', '#fbbf24', '#34d399', '#f43f5e', '#94a3b8', '#38bdf8', '#a855f7', '#06b6d4', '#ec4899'];
						const currIdx = colors.indexOf(st.color);
						st.color = colors[(currIdx + 1) % colors.length];
						renderModalRows();
					};

					// Status Label Input
					const labelInp = append(row, $('input.monaco-inputbox', {
						placeholder: 'Status Name',
						style: 'flex: 1; padding: 4px 8px; font-size: 12px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.25); color: inherit;'
					})) as HTMLInputElement;
					labelInp.value = st.label;
					labelInp.oninput = () => {
						st.label = labelInp.value;
						st.id = labelInp.value.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
					};

					// Canonical Category Mapping Select
					append(row, $('span', { style: 'font-size: 11px; opacity: 0.65; white-space: nowrap;' }, 'Category:'));
					const catSel = append(row, $('select.monaco-select', {
						style: 'padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: #1a1a1a; color: inherit; cursor: pointer;'
					})) as HTMLSelectElement;
					['Todo', 'In Progress', 'Done', 'Blocked', 'Removed'].forEach(cat => {
						const opt = append(catSel, $('option', { value: cat }, cat)) as HTMLOptionElement;
						if (st.category === cat) {
							opt.selected = true;
						}
					});
					catSel.value = st.category;
					catSel.onchange = () => {
						st.category = catSel.value as IStatusDefinition['category'];
					};

					// Row Actions: Move Up, Move Down, Delete
					const rowActs = append(row, $('div', { style: 'display: flex; align-items: center; gap: 6px;' }));
					if (sIdx > 0) {
						const upB = append(rowActs, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowUp), { style: 'cursor: pointer; opacity: 0.6; font-size: 12px;' }));
						upB.title = 'Move Up';
						upB.onclick = () => {
							const [item] = currentStatuses.splice(sIdx, 1);
							currentStatuses.splice(sIdx - 1, 0, item);
							renderModalRows();
						};
					}
					if (sIdx < currentStatuses.length - 1) {
						const dnB = append(rowActs, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowDown), { style: 'cursor: pointer; opacity: 0.6; font-size: 12px;' }));
						dnB.title = 'Move Down';
						dnB.onclick = () => {
							const [item] = currentStatuses.splice(sIdx, 1);
							currentStatuses.splice(sIdx + 1, 0, item);
							renderModalRows();
						};
					}
					const delB = append(rowActs, $('button', {
						type: 'button',
						title: 'Delete Status',
						style: 'cursor: pointer; opacity: 0.72; font-size: 12px; color: #ef4444; background: transparent; border: none; padding: 2px 4px; display: inline-flex; align-items: center; justify-content: center;'
					})) as HTMLButtonElement;
					append(delB, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
					delB.onmousedown = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
					delB.onclick = (e: MouseEvent) => {
						e.preventDefault();
						e.stopPropagation();
						if (currentStatuses.length <= 1) {
							this.notificationService.warn('At least one status stage must be preserved.');
							return;
						}
						currentStatuses.splice(sIdx, 1);
						renderModalRows();
					};
				});
			};
			renderModalRows();

			// Modal Footer
			const mFooter = append(modal, $('div', {
				style: 'display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 12px; margin-top: 6px;'
			}));

			const mFooterLeft = append(mFooter, $('div', { style: 'display: flex; gap: 8px;' }));
			const addStageBtn = append(mFooterLeft, $('button.monaco-button', {
				style: 'padding: 5px 12px; font-size: 11px; border-radius: 4px; cursor: pointer; background: rgba(167, 139, 250, 0.15); border: 1px solid rgba(167, 139, 250, 0.35); color: #c4b5fd;'
			}));
			addStageBtn.innerText = '+ Add Status Stage';
			addStageBtn.onclick = () => {
				currentStatuses.push({
					id: `status_${Date.now()}`,
					label: `New Stage`,
					color: '#38bdf8',
					category: 'In Progress'
				});
				renderModalRows();
			};

			const resetBtn = append(mFooterLeft, $('button.monaco-button', {
				style: 'padding: 5px 12px; font-size: 11px; border-radius: 4px; cursor: pointer; background: transparent; border: 1px solid rgba(255, 255, 255, 0.15); color: var(--vscode-descriptionForeground);'
			}));
			resetBtn.innerText = 'Reset to Defaults';
			resetBtn.onclick = () => {
				currentStatuses.length = 0;
				currentStatuses.push(...JSON.parse(JSON.stringify(DEFAULT_STATUS_DEFINITIONS)));
				renderModalRows();
			};

			const applyBtn = append(mFooter, $('button.monaco-button', {
				style: 'padding: 6px 18px; font-size: 12px; border-radius: 6px; cursor: pointer; background: #007acc; color: #ffffff; border: none; font-weight: 600;'
			}));
			applyBtn.innerText = 'Apply & Close';
			applyBtn.onclick = () => {
				activeMod.statuses = currentStatuses;
				renderStatusPills();
				renderCanvas();
				overlay.remove();
			};
		};
		configStatusBtn.onclick = () => {
			openStatusLifecycleModal();
		};

		renderCanvas();

		// Footer Action Bar (Delete on left, Cancel & Save on right)
		const footer = append(wrapper, $('.schema-editor-footer', {
			style: 'display: flex; justify-content: space-between; align-items: center; margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(255, 255, 255, 0.08);'
		}));

		const footerLeft = append(footer, $('.schema-editor-footer-left'));
		const footerDelBtn = append(footerLeft, $('button.monaco-button.schema-delete-btn', {
			style: 'padding: 6px 14px; font-size: 12px; border-radius: 6px; cursor: pointer; background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.35); font-weight: 500; display: flex; align-items: center; gap: 6px;'
		}));
		append(footerDelBtn, $('span.codicon.codicon-trash'));
		append(footerDelBtn, $('span', {}, 'Delete Module'));
		footerDelBtn.onclick = handleDeleteModule;

		const footerRight = append(footer, $('.schema-editor-footer-right', {
			style: 'display: flex; align-items: center; gap: 12px;'
		}));

		const handlePreviewTicket = async () => {
			activeMod.statuses = currentStatuses;
			this._syncDraft();
			await this.customModulesService.openModuleTicketPreview(activeMod, input.workspaceUri);
		};
		previewHeaderBtn.onclick = handlePreviewTicket;

		const previewFooterBtn = append(footerRight, $('button.monaco-button.schema-preview-btn', {
			style: 'padding: 6px 16px; font-size: 12px; border-radius: 6px; cursor: pointer; background: rgba(56, 189, 248, 0.14); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); font-weight: 600; display: flex; align-items: center; gap: 6px;'
		}));
		previewFooterBtn.title = 'Open a new tab to preview what a ticket generated from this template looks like';
		append(previewFooterBtn, $('span.codicon.codicon-eye'));
		append(previewFooterBtn, $('span', {}, 'Preview Ticket'));
		previewFooterBtn.onclick = handlePreviewTicket;

		const cancelBtn = append(footerRight, $('button.monaco-button', {
			style: 'padding: 6px 16px; font-size: 12px; border-radius: 6px; cursor: pointer; background: rgba(255, 255, 255, 0.08); color: #e0e0e0; border: 1px solid rgba(255, 255, 255, 0.15);'
		}));
		cancelBtn.innerText = 'Cancel';
		cancelBtn.onclick = () => {
			if (this.input instanceof CustomModuleSchemaEditorInput) {
				this.input.draftModule = undefined;
			}
			this.group.closeEditor(this.input!);
		};

		const saveBtn = append(footerRight, $('button.monaco-button', {
			style: 'padding: 6px 20px; font-size: 12px; border-radius: 6px; cursor: pointer; background: #007acc; color: #ffffff; border: none; font-weight: 600;'
		}));
		const saveBtnLabel = isFlowchartNodeMode ? 'Save Node Components' : 'Save Module Schema';
		saveBtn.innerText = saveBtnLabel;
		if (isEmbeddedFieldMode) {
			footer.style.display = 'none';
		}
		if (isFlowchartNodeMode) {
			footerDelBtn.style.display = 'none';
			previewFooterBtn.style.display = 'none';
		}
		saveBtn.onclick = async () => {
			if (isFlowchartNodeMode) {
				if (!(this.input instanceof CustomModuleSchemaEditorInput) || !this.input.onNodeFieldsChange) {
					this.notificationService.warn('Workflow editor connection is not active. Please re-open this node from the Workflow canvas to save.');
					return;
				}
				this._syncDraft(true);
				saveBtn.innerText = '✓ Node Saved';
				saveBtn.style.background = '#10b981';
				setTimeout(() => {
					if (saveBtn.isConnected) {
						saveBtn.innerText = 'Save Node Components';
						saveBtn.style.background = '#007acc';
					}
				}, 1800);
				this.notificationService.info(`Saved components for Flowchart Node "${activeMod.name}"`);
				return;
			}
			try {
				activeMod.statuses = currentStatuses;
				activeMod.updatedAt = Date.now();
				await this._persistCurrentModule();
				saveBtn.innerText = '✓ Schema Saved';
				saveBtn.style.background = '#10b981';
				setTimeout(() => {
					if (saveBtn.isConnected) {
						saveBtn.innerText = saveBtnLabel;
						saveBtn.style.background = '#007acc';
					}
				}, 1800);
				this.notificationService.info(`Successfully saved schema for module "${activeMod.name}"`);
			} catch (e) {
				this.notificationService.error(`Failed to save schema: ${e}`);
			}
		};

		applySavedScrollPosition();
		getWindow(mainViewport).requestAnimationFrame(() => {
			applySavedScrollPosition();
			setTimeout(() => {
				applySavedScrollPosition();
				if (!this._userHasScrolledSinceRender && this._currentScrollKey === scrollKey) {
					this._isRestoringScroll = false;
				}
			}, 120);
		});
	}

	/**
	 * Fetches `rawUrl` and returns its readable text. `credentialHeaders` (secret values, never logged) are sent with the
	 * request; the built-in extractor (IWebContentExtractorService) cannot send request headers, so when there are any
	 * it is skipped and the direct HTTP request is used.
	 */
	private async _fetchUrlContent(
		rawUrl: string,
		maskText: (text: string) => string = text => text,
		credentialHeaders: Readonly<Record<string, string>> = {}
	): Promise<{ title: string; content: string; isAuthRequired?: boolean; rawError?: string }> {
		let targetUrl = rawUrl.trim();
		if (!/^https?:\/\//i.test(targetUrl)) {
			targetUrl = 'https://' + targetUrl;
		}
		// `targetUrl` may carry credential values: everything returned shows the masked URL and masked errors
		const shownUrl = maskText(targetUrl);

		// 1. Try headless extraction via IWebContentExtractorService first
		// This uses the integrated browser's session partition ('persist:vscode-browser'),
		// so logged-in cookies and JavaScript dynamic single-page applications (SPA) are executed seamlessly!
		try {
			const hasCredentialHeaders = Object.keys(credentialHeaders).length > 0;
			const extractorService = hasCredentialHeaders ? undefined : this._instantiationService.invokeFunction(accessor => accessor.get(IWebContentExtractorService));
			if (extractorService) {
				const uri = URI.parse(targetUrl);
				const extractResults = await Promise.race([
					extractorService.extract([uri], { followRedirects: true, bypassCache: true }),
					new Promise<WebContentExtractResult[]>((_, reject) => setTimeout(() => reject(new Error('Extraction timed out')), 25000))
				]);
				if (extractResults && extractResults.length > 0) {
					const first = extractResults[0];
					if (first.status === 'ok' && first.result && first.result.length > 30) {
						const title = maskText(first.title || targetUrl);
						const formatted = `# ${title}\nURL: ${shownUrl}\nFetched At: ${new Date().toLocaleString()}\n\n${first.result}`;
						return { title, content: formatted };
					} else if (first.status === 'error' && /auth|401|403|login|session|verification/i.test(first.error)) {
						return {
							title: shownUrl,
							content: first.result || maskText(first.error),
							isAuthRequired: true,
							rawError: maskText(first.error)
						};
					}
				}
			}
		} catch {
			// Fallback to HTTP request
		}

		// 2. Fallback to direct HTTP request with bridged browser cookies & user credentials
		let html = '';
		let statusCode = 200;
		try {
			let reqService: IRequestService = this._requestService;
			try {
				const mainProcessService = this._instantiationService.invokeFunction(accessor => accessor.get(IMainProcessService));
				if (mainProcessService) {
					reqService = new RequestChannelClient(mainProcessService.getChannel('request'));
				}
			} catch {
				// Fallback to renderer requestService
			}

			// Credentials not referenced in the URL are sent as headers named after them (values are never logged)
			const requestOptions = {
				type: 'GET',
				url: targetUrl,
				headers: {
					'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
					'Accept-Language': 'en-US,en;q=0.9',
					'Sec-Fetch-Dest': 'document',
					'Sec-Fetch-Mode': 'navigate',
					'Sec-Fetch-Site': 'none',
					...credentialHeaders
				},
				timeout: 20000,
				callSite: 'customModuleSchemaEditor'
			};
			const context = await reqService.request(requestOptions, CancellationToken.None);
			statusCode = context.res.statusCode || 200;
			const text = await asText(context);
			html = text || '';
		} catch (err) {
			const rawErr = maskText((err as Error | undefined)?.message || String(err));
			return {
				title: shownUrl,
				content: `Failed to fetch URL (${shownUrl}): ${rawErr}`,
				rawError: rawErr
			};
		}

		if (!html) {
			return { title: shownUrl, content: `Empty response received from ${shownUrl}`, rawError: 'Empty response body' };
		}

		// Detect true authentication walls (redirects to login, 401, 403, or authwall pages)
		const isAuthPage = statusCode === 401 || statusCode === 403 ||
			(html.includes('/uas/login') && !targetUrl.includes('/login') && !targetUrl.includes('/signup')) ||
			(html.includes('authwall') && !targetUrl.includes('authwall'));

		if (isAuthPage) {
			return {
				title: shownUrl,
				content: html,
				isAuthRequired: true,
				rawError: `HTTP ${statusCode}: Authentication or Session Verification Required`
			};
		}

		try {
			let title = shownUrl;
			const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
			if (titleMatch && titleMatch[1]) {
				title = titleMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
			}

			const cleanedText = this._cleanHtmlToText(html);
			const maxChars = 25000;
			const displayContent = cleanedText.length > maxChars
				? cleanedText.slice(0, maxChars) + '\n\n... [Content truncated for display and AI context]'
				: cleanedText;

			const formatted = `# ${title}\nURL: ${shownUrl}\nFetched At: ${new Date().toLocaleString()}\n\n${displayContent}`;
			return { title, content: formatted };
		} catch (parseErr) {
			const cleaned = this._cleanHtmlToText(html);
			return { title: shownUrl, content: cleaned };
		}
	}

	private _extractJobsFromHtml(html: string): string {
		try {
			const seenIds = new Set<string>();
			const jobs: Array<{ jobId: string; title: string; company: string; location: string; link: string }> = [];

			// 1. Regex search for Voyager JobPosting entities in embedded JSON
			const entityRegex = /"entityUrn":"urn:li:(?:fsd_)?jobPosting:([0-9]+)"/g;
			let match: RegExpExecArray | null;
			while ((match = entityRegex.exec(html)) !== null) {
				const jobId = match[1];
				if (seenIds.has(jobId)) { continue; }
				seenIds.add(jobId);

				const contextStart = Math.max(0, match.index - 500);
				const contextEnd = Math.min(html.length, match.index + 1500);
				const snippet = html.slice(contextStart, contextEnd);

				let title = '';
				const titleMatch = snippet.match(/"title":\{"text":"([^"]+)"\}|"title":"([^"]+)"/);
				if (titleMatch) {
					title = titleMatch[1] || titleMatch[2] || '';
				}

				let company = '';
				const compMatch = snippet.match(/"companyName":"([^"]+)"|"primaryDescription":\{"text":"([^"]+)"\}/);
				if (compMatch) {
					company = compMatch[1] || compMatch[2] || '';
				}

				let location = '';
				const locMatch = snippet.match(/"formattedLocation":"([^"]+)"|"secondaryDescription":\{"text":"([^"]+)"\}/);
				if (locMatch) {
					location = locMatch[1] || locMatch[2] || '';
				}

				jobs.push({
					jobId,
					title: title || 'Job Posting',
					company: company || 'Unknown Company',
					location: location || '',
					link: `https://www.linkedin.com/jobs/view/${jobId}/`
				});
			}

			// 2. Regex search for currentJobId or /jobs/view/ in HTML attributes
			const hrefRegex = /(?:currentJobId=|\/jobs\/view\/)([0-9]+)/g;
			while ((match = hrefRegex.exec(html)) !== null) {
				const jobId = match[1];
				if (seenIds.has(jobId)) { continue; }
				seenIds.add(jobId);
				jobs.push({
					jobId,
					title: 'Job Posting',
					company: 'Unknown Company',
					location: '',
					link: `https://www.linkedin.com/jobs/view/${jobId}/`
				});
			}

			if (jobs.length === 0) {
				return '';
			}

			let md = `## Extracted Job Listings (${jobs.length} Jobs Found)\n\n`;
			md += `| # | Job ID | Job Title | Company | Location | Direct Link |\n`;
			md += `|---|---|---|---|---|---|\n`;
			for (let i = 0; i < jobs.length; i++) {
				const j = jobs[i];
				md += `| ${i + 1} | ${j.jobId} | ${j.title} | ${j.company} | ${j.location || '-'} | [${j.title}](${j.link}) |\n`;
			}
			md += `\n---\n\n`;
			return md;
		} catch {
			return '';
		}
	}

	private _cleanHtmlToText(html: string): string {
		try {
			const jobTable = this._extractJobsFromHtml(html);

			// 1. Remove non-content tags including script, style, svg, iframe, noscript, etc.
			let clean = html.replace(/<(script|style|svg|noscript|iframe|canvas|video|audio|nav|footer)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
			// 2. Convert block-level tags and line-breaks to newlines
			clean = clean.replace(/<\/?(p|div|li|h[1-6]|tr|article|section|header|footer|br|blockquote|table|ol|ul)[^>]*>/gi, '\n');
			// 3. Strip all remaining HTML tags
			clean = clean.replace(/<[^>]+>/g, ' ');
			// 4. Decode common HTML entities
			clean = clean
				.replace(/&nbsp;/gi, ' ')
				.replace(/&amp;/gi, '&')
				.replace(/&lt;/gi, '<')
				.replace(/&gt;/gi, '>')
				.replace(/&quot;/gi, '"')
				.replace(/&#39;/gi, '\'')
				.replace(/&middot;/gi, '·');
			// 5. Clean up multiple spaces and empty lines
			const lines = clean.split('\n')
				.map(l => l.replace(/[ \t]+/g, ' ').trim())
				.filter(l => l.length > 0);

			const mainText = lines.join('\n');
			return jobTable ? (jobTable + mainText) : mainText;
		} catch {
			return html.replace(/<[^>]+>/g, ' ').slice(0, 10000);
		}
	}

	/** Last result of `_getHydratedWorkflowRuntimeContext()`; lets synchronous interpolation resolve large spilled variables too. */
	private _lastHydratedRuntimeCtx: Record<string, unknown> | undefined;

	private async _getHydratedWorkflowRuntimeContext(): Promise<Record<string, unknown>> {
		let ctx: Record<string, unknown> = {};
		if (this.input instanceof CustomModuleSchemaEditorInput) {
			try {
				if (typeof this.input.hydratedWorkflowRuntimeContextProvider === 'function') {
					ctx = await this.input.hydratedWorkflowRuntimeContextProvider();
				} else if (typeof this.input.workflowRuntimeContextProvider === 'function') {
					ctx = this.input.workflowRuntimeContextProvider() || {};
				}
			} catch (err) {
				console.warn('[CustomModuleSchemaEditor] Failed to load workflow runtime variables:', err);
			}
		}
		this._lastHydratedRuntimeCtx = ctx;
		return ctx;
	}

	private _interpolateSchemaReferences(
		rawText: string,
		currentField: ICustomField,
		allFields?: ICustomField[],
		runtimeContext?: Record<string, unknown>
	): string {
		if (!rawText) {
			return '';
		}
		const fieldsList = (allFields && allFields.length > 0)
			? allFields
			: (this._activeModule?.fields || []);

		const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const replaceToken = (input: string, key: string, value: string): string => {
			if (!key) {
				return input;
			}
			const escaped = escapeRegExp(key);
			const reDouble = new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`, 'gi');
			const reSingle = new RegExp(`\\{\\s*${escaped}\\s*\\}`, 'gi');
			const reAt = new RegExp(`@${escaped}(?![a-zA-Z0-9_-])`, 'gi');
			return input.replace(reDouble, () => value).replace(reSingle, () => value).replace(reAt, () => value);
		};

		let result = rawText;
		if (this._activeModule?.name) {
			result = replaceToken(result, 'Title', this._activeModule.name);
		}
		if (this._activeModule?.description) {
			result = replaceToken(result, 'Description', this._activeModule.description);
		}

		for (const f of fieldsList) {
			if (!f || f === currentField) {
				continue;
			}
			const fLabel = (f.label || f.id || '').trim();
			const fId = (f.id || '').trim();

			if (f.type === 'parameters' && Array.isArray(f.parameters)) {
				const paramMap: Record<string, string> = {};
				for (const p of f.parameters) {
					const pName = (p.name || '').trim();
					if (pName) {
						const pVal = String(p.defaultValue ?? '');
						paramMap[pName] = pVal;
						result = replaceToken(result, pName, pVal);
						if (fLabel) {
							result = replaceToken(result, `${fLabel}.${pName}`, pVal);
						}
						if (fId && fId !== fLabel) {
							result = replaceToken(result, `${fId}.${pName}`, pVal);
						}
					}
				}
				const jsonParams = JSON.stringify(paramMap);
				if (fLabel) {
					result = replaceToken(result, fLabel, jsonParams);
				}
				if (fId && fId !== fLabel) {
					result = replaceToken(result, fId, jsonParams);
				}
				continue;
			}

			let valToInsert = '';
			const subProps: Record<string, string> = {};

			if (f.type === 'python') {
				const pyRes = f.pythonResult !== undefined && f.pythonResult !== null && String(f.pythonResult).trim() !== ''
					? (typeof f.pythonResult === 'object' ? JSON.stringify(f.pythonResult) : String(f.pythonResult).trim())
					: '';
				const pyOut = (f.pythonOutput || '').trim();
				valToInsert = pyRes !== '' ? pyRes : pyOut;
				subProps['result'] = pyRes || pyOut;
				subProps['output'] = pyOut || pyRes;
			} else if (f.type === 'browser') {
				const bUrl = (f.defaultUrl || '').trim();
				const bContent = (f.defaultContent || '').trim();
				valToInsert = bContent || bUrl;
				subProps['url'] = bUrl;
				subProps['content'] = bContent;
			} else if (f.type === 'http_request') {
				const jsonBody = f.httpResponseData ? JSON.stringify(f.httpResponseData, null, 2) : (f.httpResponseBody || '');
				valToInsert = jsonBody;
				subProps['status'] = f.httpResponseStatus !== undefined ? String(f.httpResponseStatus) : '';
				subProps['ok'] = f.httpResponseStatus !== undefined ? String(f.httpResponseStatus >= 200 && f.httpResponseStatus < 300) : '';
				subProps['data'] = jsonBody;
				subProps['body'] = jsonBody;
				subProps['url'] = f.httpUrl || '';
				subProps['method'] = (f.httpMethod || 'GET').toUpperCase();
				if (f.httpResponseData && typeof f.httpResponseData === 'object' && !Array.isArray(f.httpResponseData)) {
					for (const [k, v] of Object.entries(f.httpResponseData)) {
						if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
							subProps[k] = String(v);
						} else if (v && typeof v === 'object') {
							subProps[k] = JSON.stringify(v);
						}
					}
				}
			} else if (f.type === 'prompt') {
				const pOut = (f.debugPromptOutput || '').trim();
				const pUserPrompts = f.promptUserInputVisible === false
					? []
					: ((Array.isArray(f.defaultUserPrompts) && f.defaultUserPrompts.length > 0)
						? f.defaultUserPrompts
						: (f.defaultUserPrompt ? [f.defaultUserPrompt] : []));
				const pPrompt = this._formatCombinedPromptForLlm(f.defaultContent || '', pUserPrompts).trim();
				valToInsert = pOut || pPrompt;
				subProps['output'] = pOut;
				subProps['prompt'] = pPrompt;
			} else if (f.type === 'table') {
				const sqlOut = (f.debugSqlOutput || '').trim();
				const cols = f.tableColumns || [];
				const rows = f.tableRows || [];
				const colNames = cols.map(c => c.name);
				const mdTable = colNames.length > 0
					? [
						`| ${colNames.join(' | ')} |`,
						`| ${colNames.map(() => '---').join(' | ')} |`,
						...rows.map(r => `| ${colNames.map(cn => String(r[cn] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`)
					].join('\n')
					: JSON.stringify(rows);
				valToInsert = sqlOut || mdTable;
				subProps['output'] = sqlOut || mdTable;
				subProps['sqlOutput'] = sqlOut;
				subProps['table'] = mdTable;
				subProps['json'] = JSON.stringify(rows);
				subProps['rows'] = JSON.stringify(rows);
				subProps['dbPath'] = f.tableDbPath || '';
				subProps['tableName'] = f.tableDbTableName || '';
			} else if (f.type === 'git') {
				valToInsert = (f.gitRemoteUrl || '').trim();
			} else {
				valToInsert = String(f.defaultContent ?? f.defaultValue ?? '').trim();
			}

			if (valToInsert !== '') {
				if (fLabel) {
					result = replaceToken(result, fLabel, valToInsert);
					result = replaceToken(result, `output.${fLabel}`, valToInsert);
					result = replaceToken(result, `result.${fLabel}`, valToInsert);
					for (const [sKey, sVal] of Object.entries(subProps)) {
						if (sVal !== '') {
							result = replaceToken(result, `${fLabel}.${sKey}`, sVal);
						}
					}
				}
				if (fId && fId !== fLabel) {
					result = replaceToken(result, fId, valToInsert);
					result = replaceToken(result, `output.${fId}`, valToInsert);
					result = replaceToken(result, `result.${fId}`, valToInsert);
					for (const [sKey, sVal] of Object.entries(subProps)) {
						if (sVal !== '') {
							result = replaceToken(result, `${fId}.${sKey}`, sVal);
						}
					}
				}
			}
		}

		// Also resolve Workflow / Sub-Workflow runtime context variables (e.g. {current_filtered_job}, {raw_working_exp}, {raw_project_exp})
		let effectiveRuntimeCtx = runtimeContext;
		if (!effectiveRuntimeCtx && this.input instanceof CustomModuleSchemaEditorInput && typeof this.input.workflowRuntimeContextProvider === 'function') {
			try {
				const rawCtx = this.input.workflowRuntimeContextProvider();
				if (rawCtx && typeof rawCtx === 'object') {
					effectiveRuntimeCtx = rawCtx;
				}
			} catch { }
		}
		if (effectiveRuntimeCtx && typeof effectiveRuntimeCtx === 'object') {
			for (const [ctxKey, rawCtxVal] of Object.entries(effectiveRuntimeCtx)) {
				let ctxVal = rawCtxVal;
				if (isSpilledVarRef(ctxVal)) {
					// Large spilled variable: use the value loaded by the last _getHydratedWorkflowRuntimeContext() call
					const cached = this._lastHydratedRuntimeCtx?.[ctxKey];
					ctxVal = isSpilledVarRef(cached) ? undefined : cached;
				}
				if (!ctxKey || ctxVal === undefined || ctxVal === null) {
					continue;
				}
				let strVal = '';
				if (typeof ctxVal === 'string') {
					strVal = ctxVal;
				} else if (typeof ctxVal === 'number' || typeof ctxVal === 'boolean') {
					strVal = String(ctxVal);
				} else {
					try {
						strVal = JSON.stringify(ctxVal, null, 2);
					} catch {
						strVal = String(ctxVal);
					}
				}
				result = replaceToken(result, ctxKey, strVal);
			}
		}

		return result;
	}

	private async _executeBrowserFetch(
		urlInput: HTMLInputElement,
		statusEl: HTMLElement,
		contentEl: HTMLElement,
		field: ICustomField,
		openTab: boolean,
		allFields?: ICustomField[]
	): Promise<void> {
		let url = urlInput.value.trim();
		if (!url) {
			this.notificationService.warn('Please enter a target URL before testing.');
			urlInput.focus();
			return;
		}

		if (!url.startsWith('{') && !url.startsWith('@') && !/^https?:\/\//i.test(url)) {
			url = 'https://' + url;
			urlInput.value = url;
			field.defaultUrl = url;
		}

		// {name} of a credential -> its encoded value, the other credentials are request headers; only the masked URL is
		// shown or stored
		const runtimeCtx = await this._getHydratedWorkflowRuntimeContext();
		const resolved = resolveBrowserCredentialUrl(url, field.credentials, t => this._interpolateSchemaReferences(t, field, allFields, runtimeCtx));
		let finalUrl = resolved.url;
		let shownUrl = resolved.maskedUrl;
		if (!/^https?:\/\//i.test(finalUrl)) {
			finalUrl = 'https://' + finalUrl;
			shownUrl = 'https://' + shownUrl;
		}
		const mask = (text: string) => maskSecrets(text, resolved.secrets);

		if (openTab) {
			this._syncDraft();
			try {
				const uri = URI.parse(finalUrl);
				await this._commandService.executeCommand('simpleBrowser.api.open', uri, {
					viewColumn: -2, // ViewColumn.Beside (split editor beside)
					preserveFocus: false
				});
			} catch (e) {
				try {
					await this._commandService.executeCommand('simpleBrowser.show', finalUrl);
				} catch (err) {
					console.error('Failed to open simpleBrowser:', err);
				}
			}
		}

		statusEl.style.display = 'inline-block';
		statusEl.textContent = 'Fetching...';
		statusEl.style.color = '#38bdf8';

		try {
			const result = await this._fetchUrlContent(finalUrl, mask, resolved.headers);
			if (result.isAuthRequired) {
				throw new Error(result.rawError || 'Authentication Required');
			}
			if (result.content.startsWith('Failed to fetch URL')) {
				throw new Error(result.rawError || result.content);
			}
			contentEl.textContent = result.content;
			field.defaultContent = result.content;
			this._syncDraft();
			await this._persistCurrentModule();
			const charCount = result.content.length;
			statusEl.textContent = `Fetched (${charCount} chars)`;
			statusEl.style.color = '#34d399';
			// Suppress notificationService.info toast to prevent webview "Paused due to Notification" overlay
		} catch (err) {
			const rawErr = mask((err as Error | undefined)?.message || String(err));
			const isAuthOrCors = /auth|401|403|login|session|verification/i.test(rawErr);
			const timestamp = new Date().toLocaleString();
			if (isAuthOrCors) {
				statusEl.textContent = 'Auth Required / Protected Page (Raw Error Logged)';
				statusEl.style.color = '#fbbf24';
				const formattedNotice = `[AUTH REQUIRED / PROTECTED PAGE]
Target URL: ${shownUrl}
Timestamp: ${timestamp}
Status: Authentication Required / Access Restricted

--- [RAW SERVER & NETWORK RESPONSE] ---
${rawErr}

--- [AUTOMATION & TROUBLESHOOTING GUIDANCE] ---
1. Why this happened:
   The destination endpoint (${shownUrl}) requires an active authenticated session or blocks unauthenticated automated background crawlers (CORS / Anti-Scraping / 307 Redirect to Login).

2. Interactive Login:
   Click the "Open in Tab" or "+ New Tab" button directly above this card to open a browser tab beside and log in.

3. Credentials:
   Add a token or key under "Credentials" above. Reference it in the URL as {name}, or leave it out of the URL to send it
   as a request header named after it (e.g. Authorization, Cookie or X-Api-Key; headers are safer than the URL).`;

				contentEl.textContent = formattedNotice;
				field.defaultContent = formattedNotice;
				this._syncDraft();
				// Avoid notificationService.warn toast to prevent webview "Paused due to Notification" overlay
			} else {
				statusEl.textContent = `Fetch failed: ${rawErr.slice(0, 30)}`;
				statusEl.style.color = '#f87171';
				const formattedErr = `[HTTP / NETWORK FETCH ERROR]
Target URL: ${shownUrl}
Timestamp: ${timestamp}

--- [RAW SERVER & NETWORK ERROR] ---
${rawErr}

--- [SUGGESTED ACTION] ---
Check the network connection or click "Open in Tab" / "+ New Tab" to inspect the page interactively.`;

				contentEl.textContent = formattedErr;
				field.defaultContent = formattedErr;
				this._syncDraft();
			}
		}
	}

	private _formatCombinedPromptForLlm(rawPreInjected: string, userPromptsList: string[]): string {
		const pre = (rawPreInjected || '').trim();
		const nonEmptyInputs = (userPromptsList || []).map(s => (s || '').trim()).filter(s => s.length > 0);
		if (nonEmptyInputs.length === 0) {
			return pre;
		}
		if (nonEmptyInputs.length === 1 && (userPromptsList || []).length <= 1) {
			const singleUser = nonEmptyInputs[0];
			return pre
				? `${pre}\n\n--- [USER PROMPT / INSTRUCTIONS] ---\n${singleUser}`
				: singleUser;
		}
		const multiBody = [
			`The user has provided ${nonEmptyInputs.length} separate input segment(s) in sequential order below. Please process all ${nonEmptyInputs.length} user input(s) together according to the instructions:`,
			'',
			...nonEmptyInputs.map((seg, idx) => `[User Input #${idx + 1} of ${nonEmptyInputs.length}]:\n${seg}`)
		].join('\n\n');
		return pre
			? `${pre}\n\n--- [USER PROMPT INPUTS (${nonEmptyInputs.length} SEPARATE USER INPUTS IN ORDER)] ---\n${multiBody}`
			: `--- [USER PROMPT INPUTS (${nonEmptyInputs.length} SEPARATE USER INPUTS IN ORDER)] ---\n${multiBody}`;
	}

	private async _openSchemaSentPromptModal(
		promptTextarea: HTMLTextAreaElement,
		field: ICustomField,
		allFields?: ICustomField[]
	): Promise<void> {
		const runtimeCtx = await this._getHydratedWorkflowRuntimeContext();
		const rawPreInjected = promptTextarea.value.trim();
		const userPromptsList = field.promptUserInputVisible === false
			? []
			: ((Array.isArray(field.defaultUserPrompts) && field.defaultUserPrompts.length > 0)
				? field.defaultUserPrompts
				: (field.defaultUserPrompt ? [field.defaultUserPrompt] : []));
		const nonEmptySegments = userPromptsList.map(s => (s || '').trim()).filter(s => s.length > 0);
		const rawCombined = this._formatCombinedPromptForLlm(rawPreInjected, userPromptsList);
		const fullInterpolated = this._interpolateSchemaReferences(rawCombined, field, allFields, runtimeCtx);
		const preInterpolated = this._interpolateSchemaReferences(rawPreInjected, field, allFields, runtimeCtx);
		const segsInterpolated = nonEmptySegments.map(seg => this._interpolateSchemaReferences(seg, field, allFields, runtimeCtx));

		const existing = activeSentPromptModalOverlay;
		if (existing) {
			existing.remove();
		}

		const overlay = append(getWindow(promptTextarea).document.body, $('div.schema-sent-prompt-modal-overlay', {
			style: 'position: fixed; inset: 0; background: rgba(0, 0, 0, 0.72); z-index: 10000; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(3px); padding: 24px; box-sizing: border-box;'
		}));
		activeSentPromptModalOverlay = overlay;

		const dialog = append(overlay, $('div', {
			style: 'background: var(--vscode-editorWidget-background, #18181b); color: var(--vscode-editorWidget-foreground, #e4e4e7); border: 1px solid rgba(56, 189, 248, 0.38); border-radius: 10px; width: min(1020px, 94vw); height: min(820px, 90vh); box-shadow: 0 20px 60px rgba(0, 0, 0, 0.78); display: flex; flex-direction: column; overflow: hidden; font-family: var(--vscode-font-family, sans-serif);'
		}));

		const closeDialog = () => {
			overlay.remove();
			if (activeSentPromptModalOverlay === overlay) {
				activeSentPromptModalOverlay = undefined;
			}
		};

		const header = append(dialog, $('div', {
			style: 'display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; background: rgba(15, 23, 42, 0.75); border-bottom: 1px solid rgba(255, 255, 255, 0.1); flex-wrap: wrap;'
		}));
		const headerLeft = append(header, $('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }));
		const titleRow = append(headerLeft, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
		append(titleRow, $('span' + ThemeIcon.asCSSSelector(Codicon.eye), { style: 'font-size: 15px; color: #38bdf8;' }));
		append(titleRow, $('span', { style: 'font-size: 14px; font-weight: 700; color: #f8fafc;' }, `Sent Prompt Inspector (Template Preview) — ${field.label || field.id}`));
		append(headerLeft, $('div', { style: 'font-size: 11px; opacity: 0.72;' },
			`Target: ${field.targetMode === 'agent' ? (field.targetAgentName || 'AI Agent') : (field.targetModel || resolveDefaultModelId(field.targetProvider, 'gemini-2.5-flash'))} · Total: ${fullInterpolated.length.toLocaleString()} chars · User Segments: ${segsInterpolated.length}`
		));

		const headerRight = append(header, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
		const copyAllBtn = append(headerRight, $('button.monaco-button', {
			type: 'button',
			style: 'display: inline-flex; align-items: center; gap: 5px; padding: 5px 11px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.4); transition: all 0.15s ease;'
		}));
		const copyIconEl = append(copyAllBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy), { style: 'font-size: 12px;' }));
		const copyLabelEl = append(copyAllBtn, $('span', {}, 'Copy Full Prompt'));
		let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
		let activeCopyToast: HTMLElement | undefined;
		const showModalCopyToast = (msg: string, isError: boolean = false) => {
			activeCopyToast?.remove();
			const toast = activeCopyToast = append(overlay, $('div.schema-modal-copy-toast', {
				style: `position: fixed; top: 24px; left: 50%; transform: translateX(-50%); z-index: 10002; padding: 8px 16px; border-radius: 8px; font-size: 12px; font-weight: 600; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.6); pointer-events: none; background: ${isError ? 'rgba(127, 29, 29, 0.96)' : 'rgba(6, 78, 59, 0.96)'}; color: ${isError ? '#fecaca' : '#a7f3d0'}; border: 1px solid ${isError ? 'rgba(248, 113, 113, 0.55)' : 'rgba(52, 211, 153, 0.55)'};`
			}, msg));
			setTimeout(() => { toast.remove(); }, isError ? 3500 : 2200);
		};
		copyAllBtn.onclick = async () => {
			if (copyResetTimer) {
				clearTimeout(copyResetTimer);
				copyResetTimer = null;
			}
			try {
				if (this._clipboardService) {
					await this._clipboardService.writeText(fullInterpolated);
				} else if (navigator?.clipboard?.writeText) {
					await navigator.clipboard.writeText(fullInterpolated);
				} else {
					throw new Error('Clipboard API is unavailable');
				}
				copyIconEl.className = ThemeIcon.asClassName(Codicon.check);
				copyLabelEl.textContent = 'Copied!';
				copyAllBtn.style.background = 'rgba(16, 185, 129, 0.25)';
				copyAllBtn.style.color = '#34d399';
				copyAllBtn.style.borderColor = 'rgba(52, 211, 153, 0.55)';
				showModalCopyToast(`✓ Copied full prompt (${fullInterpolated.length.toLocaleString()} chars)`, false);
				this.notificationService.info(`Copied full prompt (${fullInterpolated.length.toLocaleString()} chars).`);
			} catch (err) {
				const reason = (err as Error | undefined)?.message || String(err || 'Unknown clipboard error');
				copyIconEl.className = ThemeIcon.asClassName(Codicon.error);
				copyLabelEl.textContent = 'Copy Failed';
				copyAllBtn.style.background = 'rgba(239, 68, 68, 0.25)';
				copyAllBtn.style.color = '#f87171';
				copyAllBtn.style.borderColor = 'rgba(248, 113, 113, 0.55)';
				showModalCopyToast(`\u2717 Copy failed: ${reason}`, true);
				this.notificationService.error(`Failed to copy full prompt: ${reason}`);
			} finally {
				copyResetTimer = setTimeout(() => {
					copyIconEl.className = ThemeIcon.asClassName(Codicon.copy);
					copyLabelEl.textContent = 'Copy Full Prompt';
					copyAllBtn.style.background = 'rgba(59, 130, 246, 0.2)';
					copyAllBtn.style.color = '#60a5fa';
					copyAllBtn.style.borderColor = 'rgba(59, 130, 246, 0.4)';
					copyResetTimer = null;
				}, 2200);
			}
		};

		const closeBtn = append(headerRight, $('button.monaco-button', {
			type: 'button',
			style: 'display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 6px; cursor: pointer; background: rgba(255, 255, 255, 0.06); color: inherit; border: 1px solid rgba(255, 255, 255, 0.14);'
		}));
		append(closeBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.close), { style: 'font-size: 14px;' }));
		closeBtn.onclick = () => closeDialog();

		const body = append(dialog, $('div', {
			style: 'flex: 1; padding: 16px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;'
		}));

		// 1. Pre-Injected
		const sec1 = append(body, $('div', { style: 'border: 1px solid rgba(96, 165, 250, 0.3); border-radius: 8px; background: rgba(30, 41, 59, 0.35); overflow: hidden;' }));
		append(sec1, $('div', { style: 'padding: 8px 14px; background: rgba(59, 130, 246, 0.14); border-bottom: 1px solid rgba(96, 165, 250, 0.22); font-size: 12px; font-weight: 600; color: #93c5fd;' },
			`1. Pre-Injected Prompt (Template System Instruction — ${preInterpolated.length.toLocaleString()} chars)`
		));
		append(sec1, $('pre', { style: 'margin: 0; padding: 12px 14px; max-height: 220px; overflow-y: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; color: #e2e8f0;' },
			preInterpolated || '(No Pre-Injected Prompt configured)'
		));

		// 2. User Prompt Segments
		const sec2 = append(body, $('div', { style: 'border: 1px solid rgba(52, 211, 153, 0.3); border-radius: 8px; background: rgba(30, 41, 59, 0.35); overflow: hidden;' }));
		append(sec2, $('div', { style: 'padding: 8px 14px; background: rgba(16, 185, 129, 0.12); border-bottom: 1px solid rgba(52, 211, 153, 0.22); font-size: 12px; font-weight: 600; color: #6ee7b7;' },
			`2. Default User Prompt Segments (${segsInterpolated.length})`
		));
		const sec2Body = append(sec2, $('div', { style: 'padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;' }));
		if (segsInterpolated.length > 0) {
			segsInterpolated.forEach((seg, idx) => {
				const segBox = append(sec2Body, $('div', { style: 'border: 1px solid rgba(52, 211, 153, 0.25); border-radius: 6px; background: rgba(15, 23, 42, 0.45); overflow: hidden;' }));
				append(segBox, $('div', { style: 'padding: 5px 10px; background: rgba(16, 185, 129, 0.1); font-size: 11px; font-weight: 700; color: #34d399;' },
					`User Input #${idx + 1} (${seg.length.toLocaleString()} chars)`
				));
				append(segBox, $('pre', { style: 'margin: 0; padding: 10px 12px; max-height: 180px; overflow-y: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; color: #e2e8f0;' }, seg));
			});
		} else {
			append(sec2Body, $('div', { style: 'font-size: 11.5px; opacity: 0.6; font-style: italic;' }, 'No default user prompt segments configured.'));
		}

		// 3. Complete Final Prompt
		const sec3 = append(body, $('div', { style: 'border: 1px solid rgba(192, 132, 252, 0.35); border-radius: 8px; background: rgba(30, 41, 59, 0.45); overflow: hidden;' }));
		append(sec3, $('div', { style: 'padding: 8px 14px; background: rgba(168, 85, 247, 0.15); border-bottom: 1px solid rgba(192, 132, 252, 0.25); font-size: 12px; font-weight: 600; color: #d8b4fe;' },
			`3. Complete Final Verbatim Prompt Sent to AI (${fullInterpolated.length.toLocaleString()} chars)`
		));
		append(sec3, $('pre', { style: 'margin: 0; padding: 12px 14px; max-height: 340px; overflow-y: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; color: #f1f5f9;' },
			fullInterpolated || '(Empty prompt)'
		));

		overlay.onclick = (ev) => {
			if (ev.target === overlay) {
				closeDialog();
			}
		};
	}

	private _parseJsonOrPythonListValue(val: unknown): unknown[] {
		if (Array.isArray(val)) { return val; }
		if (val === null || val === undefined) { return []; }
		const s = String(val).trim();
		if (!s || s === '[]' || s.toLowerCase() === 'null' || s.toLowerCase() === 'none') { return []; }
		try {
			const parsed = JSON.parse(s);
			if (Array.isArray(parsed)) { return parsed; }
		} catch { }
		if (s.startsWith('[') && s.endsWith(']')) {
			const inner = s.slice(1, -1).trim();
			if (!inner) { return []; }
			const items: string[] = [];
			let i = 0;
			while (i < inner.length) {
				while (i < inner.length && (inner[i] === ' ' || inner[i] === '\t' || inner[i] === '\n' || inner[i] === '\r' || inner[i] === ',')) {
					i++;
				}
				if (i >= inner.length) { break; }
				const quote = inner[i];
				if (quote === '\'' || quote === '"') {
					i++;
					let buf = '';
					while (i < inner.length) {
						if (inner[i] === '\\' && i + 1 < inner.length) {
							const nextCh = inner[i + 1];
							if (nextCh === 'n') { buf += '\n'; }
							else if (nextCh === 't') { buf += '\t'; }
							else if (nextCh === 'r') { buf += '\r'; }
							else { buf += nextCh; }
							i += 2;
						} else if (inner[i] === quote) {
							i++;
							break;
						} else {
							buf += inner[i];
							i++;
						}
					}
					items.push(buf);
				} else {
					let end = i;
					while (end < inner.length && inner[end] !== ',') { end++; }
					const token = inner.slice(i, end).trim();
					if (token) { items.push(token); }
					i = end + 1;
				}
			}
			return items;
		}
		return [s];
	}

	private _tryExtractJsonRecordsFromSchemaTable(
		rawPrompt: string,
		currentField: ICustomField,
		allFields?: ICustomField[],
		forceFallback: boolean = false
	): string | undefined {
		if (!rawPrompt) { return undefined; }
		const isDbResultJsonArrayParser =
			/(?:parse|extract)[\s\S]*?(?:database\s+query\s+result|query\s+result|returned\s+[\w\s]*records?|table\s+rows?)[\s\S]*?json\s+array/i.test(rawPrompt) ||
			(/(?:extract\s+all\s+returned|into\s+a\s+json\s+array)/i.test(rawPrompt) && /(?:do\s+not\s+omit\s+records|output\s+only\s+valid\s+json)/i.test(rawPrompt));
		if (!isDbResultJsonArrayParser && !forceFallback) {
			return undefined;
		}

		const candidateFields = (this._activeModule?.fields && this._activeModule.fields.length > 0)
			? this._activeModule.fields
			: (allFields || []);
		const tokenRegex = /@?\{\{?([^{}]+)\}?\}/g;
		let match: RegExpExecArray | null;
		let matchedTableField: ICustomField | undefined;
		while ((match = tokenRegex.exec(rawPrompt)) !== null) {
			const refName = match[1].trim().toLowerCase();
			const found = candidateFields.find(f =>
				f && f !== currentField && f.type === 'table' && (
					(f.label && f.label.trim().toLowerCase() === refName) ||
					(f.id && f.id.trim().toLowerCase() === refName)
				)
			);
			if (found) {
				matchedTableField = found;
				break;
			}
		}

		if (!matchedTableField) { return undefined; }
		const sqlOut = (matchedTableField.debugSqlOutput || '').trim();
		if (/^Status:\s*FAILED\b/i.test(sqlOut)) {
			return '[]';
		}

		let tableRows: unknown[] = [];
		const matchedTableRuntimeField: IRuntimeCustomField = matchedTableField;
		if (Array.isArray(matchedTableRuntimeField.lastQueryRows) && matchedTableRuntimeField.lastQueryRows.length > 0) {
			tableRows = matchedTableRuntimeField.lastQueryRows;
		} else if (Array.isArray(matchedTableField.tableRows) && matchedTableField.tableRows.length > 0) {
			tableRows = matchedTableField.tableRows;
		} else if (sqlOut.includes('--- [Query Rows Preview')) {
			const afterHdr = sqlOut.split('--- [Query Rows Preview')[1] || '';
			const nlIdx = afterHdr.indexOf('\n');
			if (nlIdx !== -1) {
				let jsonPart = afterHdr.slice(nlIdx + 1).trim();
				const omitIdx = jsonPart.lastIndexOf('\n... (');
				if (omitIdx !== -1) {
					jsonPart = jsonPart.slice(0, omitIdx).trim();
				}
				if (jsonPart.startsWith('[') && jsonPart.endsWith(']')) {
					try {
						const parsed = JSON.parse(jsonPart);
						if (Array.isArray(parsed)) { tableRows = parsed; }
					} catch { }
				}
			}
		}

		if (tableRows.length === 0) {
			return '[]';
		}

		let templateObj: Record<string, unknown> | undefined;
		const structMatch = rawPrompt.match(/\[\s*(\{\s*"[^"]+"\s*:[\s\S]*?\})\s*\]/);
		if (structMatch && structMatch[1]) {
			try {
				const parsed = JSON.parse(structMatch[1]);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					templateObj = parsed;
				}
			} catch { }
		}

		const arrayFields = new Set<string>(['what_to_do', 'require_base', 'require_bonus', 'keywords']);
		if (templateObj) {
			for (const [tk, tv] of Object.entries(templateObj)) {
				if (Array.isArray(tv)) { arrayFields.add(tk); }
			}
		}

		const firstRow = tableRows[0];
		const sampleRow: object = firstRow && typeof firstRow === 'object' ? firstRow : {};
		const templateKeys = templateObj ? Object.keys(templateObj) : [];
		const matchingTemplateKeys = templateKeys.filter(k => hasPropertyIncludingInherited(sampleRow, k));
		const useTemplateKeys = templateKeys.length >= 2 && matchingTemplateKeys.length >= 2;

		const normalizedRows = tableRows.map(row => {
			if (!row || typeof row !== 'object') { return row; }
			const rowRecord = row as Record<string, unknown>;
			const outRow: Record<string, unknown> = {};
			const keysToCopy = useTemplateKeys ? templateKeys : Object.keys(rowRecord).filter(k => !(k === 'id' && rowRecord.id === null));
			for (const k of keysToCopy) {
				const rawV = rowRecord[k];
				if (arrayFields.has(k)) {
					outRow[k] = this._parseJsonOrPythonListValue(rawV);
				} else {
					outRow[k] = (rawV !== undefined && rawV !== null) ? rawV : null;
				}
			}
			return outRow;
		});

		return JSON.stringify(normalizedRows, null, 2);
	}

	private _formatPromptDisplayPreview(fullText: string): string {
		if (!fullText || fullText.length <= 8000) { return fullText; }
		const trimmed = fullText.trim();
		if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
			try {
				const arr = JSON.parse(trimmed);
				if (Array.isArray(arr) && arr.length > 10) {
					const previewItems = arr.slice(0, 10);
					const omitted = arr.length - previewItems.length;
					return `${JSON.stringify(previewItems, null, 2)}\n... (${omitted} more record(s) omitted in UI preview; all ${arr.length} records are preserved in runtime data)`;
				}
			} catch { }
		}
		return fullText;
	}

	private async _executePromptTest(
		promptTextarea: HTMLTextAreaElement,
		statusEl: HTMLElement,
		outputEl: HTMLElement,
		field: ICustomField,
		allFields?: ICustomField[]
	): Promise<void> {
		const rawPreInjected = promptTextarea.value.trim();
		const userPromptsList = field.promptUserInputVisible === false
			? []
			: ((Array.isArray(field.defaultUserPrompts) && field.defaultUserPrompts.length > 0)
				? field.defaultUserPrompts
				: (field.defaultUserPrompt ? [field.defaultUserPrompt] : []));
		const rawPrompt = this._formatCombinedPromptForLlm(rawPreInjected, userPromptsList);
		if (!rawPrompt) {
			this.notificationService.warn('Please enter a pre-injected prompt or user prompt before testing.');
			promptTextarea.focus();
			return;
		}

		// Interpolate referenced primitives ({Field Label}, {{Field Label}}, or @FieldLabel)
		const hydratedPromptCtx = await this._getHydratedWorkflowRuntimeContext();
		const interpolatedPrompt = this._interpolateSchemaReferences(rawPrompt, field, allFields, hydratedPromptCtx);

		statusEl.style.display = 'inline-block';
		statusEl.textContent = 'Running...';
		statusEl.style.color = '#38bdf8';
		outputEl.textContent = 'Waiting for AI response...';

		const startTime = Date.now();
		try {
			const directTableJson = this._tryExtractJsonRecordsFromSchemaTable(rawPrompt, field, allFields, false);
			if (directTableJson !== undefined) {
				const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
				field.debugPromptOutput = directTableJson;
				outputEl.textContent = this._formatPromptDisplayPreview(directTableJson);
				this._syncDraft();
				statusEl.textContent = `Done (${elapsedSec}s)`;
				statusEl.style.color = '#34d399';
				await this._persistCurrentModule();
				return;
			}

			const credService = this._instantiationService.invokeFunction(accessor => {
				try { return accessor.get(IAgentCredentialService); } catch { return undefined; }
			});

			if (!credService || !credService.executePrompt) {
				throw new Error('AI Credential Service is not available');
			}

			const missingVars = findUnresolvedTemplateVariables(rawPrompt, interpolatedPrompt);
			if (missingVars.length > 0) {
				throw new Error(`Prompt was not sent: no value found for ${missingVars.map(v => `{${v}}`).join(', ')}. Run the upstream node that produces ${missingVars.length > 1 ? 'these variables' : 'this variable'} first, or fix the variable name.`);
			}

			let targetModel = field.targetModel || resolveDefaultModelId(field.targetProvider, 'gemini-2.5-flash');
			let systemPrompt: string | undefined = undefined;

			if (field.targetMode === 'agent' && field.targetAgentId) {
				try {
					const agentsMgr = this._instantiationService.invokeFunction(accessor => {
						try { return accessor.get(IAgentsManagerService); } catch { return undefined; }
					});
					if (agentsMgr) {
						const ag = await agentsMgr.getAgent(field.targetAgentId);
						if (ag) {
							if (ag.modelName) { targetModel = ag.modelName; }
							systemPrompt = ag.systemPrompt || (ag.role ? `You are a helpful ${ag.role}.` : undefined);
						}
					}
				} catch { }
			}

			const promptDefaultModel = getGlobalDefaultModel();
			const res = await credService.executePrompt(targetModel, interpolatedPrompt, systemPrompt, field.targetProvider || (promptDefaultModel && targetModel === promptDefaultModel.modelId ? promptDefaultModel.providerId : undefined));
			const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

			if (res.success && res.text) {
				let finalOutText = res.text;
				if (/"error"\s*:\s*"[^"]*(?:rows|records|preview|omitted|batches)/i.test(finalOutText)) {
					const fallbackJson = this._tryExtractJsonRecordsFromSchemaTable(rawPrompt, field, allFields, true);
					if (fallbackJson !== undefined) {
						finalOutText = fallbackJson;
					}
				}
				field.debugPromptOutput = finalOutText;
				outputEl.textContent = this._formatPromptDisplayPreview(finalOutText);
				this._syncDraft();
				statusEl.textContent = `Done (${elapsedSec}s)`;
				statusEl.style.color = '#34d399';
				await this._persistCurrentModule();
			} else {
				const fallbackJson = this._tryExtractJsonRecordsFromSchemaTable(rawPrompt, field, allFields, true);
				if (fallbackJson !== undefined) {
					field.debugPromptOutput = fallbackJson;
					outputEl.textContent = this._formatPromptDisplayPreview(fallbackJson);
					this._syncDraft();
					statusEl.textContent = `Done (${elapsedSec}s)`;
					statusEl.style.color = '#34d399';
					await this._persistCurrentModule();
					return;
				}
				const errMsg = res.error || 'Unknown AI response error';
				outputEl.textContent = `[AI Execution Error]\n${errMsg}`;
				statusEl.textContent = `Failed (${elapsedSec}s)`;
				statusEl.style.color = '#f87171';
			}
		} catch (err) {
			const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
			const errMsg = (err as Error | undefined)?.message || String(err);
			outputEl.textContent = `[Prompt Test Failed]\n${errMsg}`;
			statusEl.textContent = `Error (${elapsedSec}s)`;
			statusEl.style.color = '#f87171';
		}
	}

	private _formatModuleForLlmCopy(mod: ICustomModule): string {
		const lines: string[] = [];
		const fields = mod.fields || [];
		const statuses = mod.statuses && mod.statuses.length > 0 ? mod.statuses : DEFAULT_STATUS_DEFINITIONS;

		const extractRefs = (texts: Array<string | undefined>): string[] => {
			const found = new Set<string>();
			const regex = /\{\{?\s*([a-zA-Z0-9_\-\s.]+?)\s*\}?\}/g;
			for (const t of texts) {
				if (!t) { continue; }
				let m: RegExpExecArray | null;
				while ((m = regex.exec(t)) !== null) {
					const token = m[1].trim();
					if (token && token.length <= 64 && !token.includes('\n') && !token.includes(':')) {
						found.add(`{${token}}`);
					}
				}
			}
			return Array.from(found);
		};

		lines.push(`# MODULE TEMPLATE SPECIFICATION: ${mod.name}`);
		lines.push(`> This document describes an automated workflow and ticket entity template in AnyAgent.`);
		lines.push(`> Workflow components execute sequentially from top to bottom. Components reference upstream parameters or step outputs using \`{Field Label}\` or \`{Parameter Name}\` interpolation tokens.`);
		lines.push('');

		// Section 1: Metadata & Lifecycle
		lines.push('## 1. Template Metadata & Lifecycle');
		lines.push(`- **Template Name**: ${mod.name}`);
		lines.push(`- **Module ID**: \`${mod.id}\``);
		lines.push(`- **Status**: ${mod.isDeprecated ? 'Disabled' : 'Active'}`);
		lines.push(`- **Storage Scope**: ${mod.storageScope || 'global'}`);
		lines.push(`- **Module Icon**: \`${mod.icon || getDefaultCustomModuleIconId(mod.id)}\``);
		lines.push(`- **Theme Color**: \`${mod.color || '#38bdf8'}\``);
		if (mod.description) {
			lines.push(`- **Type Definition**: ${mod.description}`);
		}
		if (mod.prompt) {
			lines.push(`- **Module System Prompt**:`);
			lines.push('  ```text');
			for (const pLine of mod.prompt.split('\n')) {
				lines.push(`  ${pLine}`);
			}
			lines.push('  ```');
		}
		lines.push(`- **Lifecycle Statuses**: ${statuses.map(s => `\`${s.label}\` (${s.category})`).join(' -> ')}`);
		lines.push('');

		// Section 2: Execution Pipeline & Data Flow Summary
		lines.push('## 2. Execution Pipeline & Data Flow Topology');
		lines.push('| Step | Component Type | Field Label (Output Token) | Field ID | Referenced Upstream Tokens |');
		lines.push('| :--- | :--- | :--- | :--- | :--- |');
		fields.forEach((f, idx) => {
			const stepNum = idx + 1;
			const typeBadge = (f.type || 'text').toUpperCase();
			const tokenLabel = f.label ? `\`{${f.label}}\`` : `\`{${f.id}}\``;
			let refs: string[] = [];
			if (f.type === 'browser') {
				refs = extractRefs([f.defaultUrl]);
			} else if (f.type === 'prompt') {
				refs = extractRefs([f.defaultContent, f.defaultUserPrompt]);
			} else if (f.type === 'table') {
				refs = extractRefs([f.tableDbTableName, f.tableSqlQuery]);
			} else if (f.type === 'python') {
				refs = extractRefs([f.pythonCode]);
			} else if (f.type === 'tts') {
				refs = extractRefs([f.defaultContent, f.ttsDisplayText]);
			} else if (f.type === 'media_player') {
				refs = extractRefs([f.mediaFilePath]);
			} else if (f.type === 'voice_note') {
				refs = extractRefs([f.voiceTranscript, ...(f.voiceClips || []).map(c => c.transcript)]);
			} else if (f.type === 'git') {
				refs = extractRefs([f.gitRemoteUrl, f.gitBranch]);
			} else if (f.type === 'http_request') {
				const paramVals = (f.httpParams || []).map(p => p.value);
				const headerVals = (f.httpHeaders || []).map(h => h.value);
				refs = extractRefs([f.httpUrl, f.httpAuthToken, f.httpApiKeyValue, f.httpAuthUsername, f.httpAuthPassword, f.httpBodyContent, ...paramVals, ...headerVals]);
			} else {
				refs = extractRefs([f.defaultContent]);
			}
			const refsDisplay = refs.length > 0 ? refs.map(r => `\`${r}\``).join(', ') : '-';
			lines.push(`| Step ${stepNum} | **${typeBadge}** | ${tokenLabel} | \`${f.id}\` | ${refsDisplay} |`);
		});
		lines.push('');

		// Section 3: Detailed Component Configurations
		lines.push('## 3. Detailed Component Specifications');
		fields.forEach((f, idx) => {
			const stepNum = idx + 1;
			const typeUpper = (f.type || 'text').toUpperCase();
			lines.push(`### Step ${stepNum}: [${typeUpper}] ${f.label || f.id}`);
			lines.push(`- **Field ID**: \`${f.id}\``);
			lines.push(`- **Output Reference Token**: \`{${f.label || f.id}}\``);
			lines.push(`- **Component Type**: \`${f.type}\``);
			if (f.required) {
				lines.push(`- **Required**: \`true\``);
			}

			if (f.type === 'parameters') {
				const params = f.parameters || [];
				lines.push(`- **Inputs (${params.length})**:`);
				if (params.length === 0) {
					lines.push('  - *(No parameters defined)*');
				} else {
					lines.push('');
					lines.push('  | # | Parameter Name | Token Reference | Default Value | Allowed Options |');
					lines.push('  | :--- | :--- | :--- | :--- | :--- |');
					params.forEach((p, pIdx) => {
						const pName = p.name || p.label || `param_${pIdx + 1}`;
						const pDef = (p.defaultValue !== undefined && String(p.defaultValue).trim() !== '') ? `\`${p.defaultValue}\`` : '*(required — no default)*';
						const pOpts = p.options && p.options.length > 0 ? p.options.map(o => `\`${o}\``).join(', ') : '-';
						lines.push(`  | ${pIdx + 1} | **${pName}** | \`{${pName}}\` | ${pDef} | ${pOpts} |`);
					});
				}
			} else if (f.type === 'browser') {
				lines.push(`- **Default Target URL / Site**: \`${f.defaultUrl || '(not set)'}\``);
				const creds = (f.credentials || []).filter(c => c.key && c.key.trim());
				if (creds.length > 0) {
					lines.push(`- **Configured Credential Keys**: ${creds.map(c => `\`${c.key}\``).join(', ')}`);
				}
			} else if (f.type === 'prompt') {
				const mode = f.targetMode || 'model';
				lines.push(`- **Execution Target Mode**: \`${mode === 'agent' ? 'AI Agent' : 'Large Language Model (LLM)'}\``);
				if (mode === 'agent') {
					lines.push(`- **Target Agent**: \`${f.targetAgentName || f.targetAgentId || 'default'}\``);
				} else {
					lines.push(`- **Target Provider**: \`${f.targetProvider || 'default'}\``);
					lines.push(`- **Target Model**: \`${f.targetModel || resolveDefaultModelId(f.targetProvider, 'gemini-2.5-flash')}\``);
				}
				lines.push(`- **Pre-Injected Prompt Visible in Ticket**: \`${f.promptPreInjectedVisible !== false}\``);
				const promptText = (f.defaultContent || '').trim();
				if (promptText) {
					lines.push('- **Pre-Injected Prompt Template**:');
					lines.push('```markdown');
					lines.push(promptText);
					lines.push('```');
				}
				const userPromptText = (f.defaultUserPrompt || '').trim();
				if (userPromptText) {
					lines.push('- **Default User Prompt**:');
					lines.push('```markdown');
					lines.push(userPromptText);
					lines.push('```');
				}
			} else if (f.type === 'table') {
				lines.push(`- **Database Engine**: \`${f.tableDbEngine || 'sqlite'}\``);
				lines.push(`- **SQLite File Path**: \`${f.tableDbPath || '(default workspace database)'}\``);
				lines.push(`- **Target Table Name / Parameter**: \`${f.tableDbTableName || '(not set)'}\``);
				lines.push(`- **Create Empty Table If Missing**: \`${!!f.tableAutoSyncDb}\``);
				const cols = f.tableColumns || [];
				lines.push(`- **Table Columns Schema (${cols.length} columns)**:`);
				if (cols.length > 0) {
					lines.push('');
					lines.push('  | # | Column Name | Data Type | Primary Key |');
					lines.push('  | :--- | :--- | :--- | :--- |');
					cols.forEach((c, cIdx) => {
						const cName = c.name || c.label || `col_${cIdx + 1}`;
						const cType = c.dataType || 'TEXT';
						const cPk = c.primaryKey ? 'PRIMARY KEY' : '-';
						lines.push(`  | ${cIdx + 1} | \`${cName}\` | \`${cType}\` | ${cPk} |`);
					});
					const tblNameForDdl = (f.tableDbTableName || 'target_table').trim();
					const ddlCols = cols.map((c, cIdx) => {
						const cName = c.name || c.label || `col_${cIdx + 1}`;
						const cType = c.dataType || 'TEXT';
						const cPk = c.primaryKey ? ' PRIMARY KEY' : '';
						return `  "${cName}" ${cType}${cPk}`;
					}).join(',\n');
					lines.push('');
					lines.push('- **Equivalent SQLite Table DDL**:');
					lines.push('```sql');
					lines.push(`CREATE TABLE IF NOT EXISTS "${tblNameForDdl}" (\n${ddlCols}\n);`);
					lines.push('```');
				}
				const sqlQuery = (f.tableSqlQuery || '').trim();
				if (sqlQuery) {
					lines.push('- **Configured SQL Statement / Execution Query**:');
					lines.push('```sql');
					lines.push(sqlQuery);
					lines.push('```');
				}
			} else if (f.type === 'python') {
				lines.push(`- **Python Environment Mode**: \`${f.pythonEnvMode || 'existing'}\``);
				if (f.pythonPath) {
					lines.push(`- **Python Interpreter Path**: \`${f.pythonPath}\``);
				}
				if (f.externalScripts && f.externalScripts.length > 0) {
					lines.push(`- **External Scripts**: ${f.externalScripts.map(s => `\`${s}\``).join(', ')}`);
				}
				const pyCode = (f.pythonCode || '').trim();
				if (pyCode) {
					lines.push('- **Python Script Code**:');
					lines.push('```python');
					lines.push(pyCode);
					lines.push('```');
				}
			} else if (f.type === 'tts') {
				lines.push(`- **TTS Provider**: \`${f.targetProvider || 'openai'}\``);
				lines.push(`- **TTS Model**: \`${f.targetModel || 'tts-1'}\``);
				lines.push(`- **Voice**: \`${f.ttsVoice || 'alloy'}\``);
				lines.push(`- **Audio Format**: \`${f.ttsFormat || 'mp3'}\``);
				lines.push(`- **Auto-Play**: \`${!!f.ttsAutoPlay}\``);
				if (f.defaultContent) {
					lines.push(`- **Speech Synthesis Source Text**: \`${f.defaultContent}\``);
				}
				if (f.ttsDisplayText) {
					lines.push(`- **Reading Display Text**: \`${f.ttsDisplayText}\``);
				}
			} else if (f.type === 'media_player') {
				lines.push(`- **Media File Name**: \`${f.mediaFileName || '(none)'}\``);
				lines.push(`- **Media File Path**: \`${f.mediaFilePath || '(none)'}\``);
				lines.push(`- **Media Type**: \`${f.mediaKind || 'audio'}\``);
				lines.push(`- **Playback Speed**: \`${f.mediaPlaybackRate || 1.0}x\``);
				if (f.mediaSubtitlesEnabled) {
					lines.push(`- **Subtitles**: enabled (\`${f.mediaSubtitleProvider || 'active voice model'}\`${f.mediaSubtitleModel ? ` / \`${f.mediaSubtitleModel}\`` : ''}, display \`${f.mediaSubtitleDisplayMode || 'single'}\`, dictation unit \`${f.mediaDictationUnit === 'seconds' ? `${f.mediaDictationSeconds || 5}s` : 'sentence'}\`)`);
				}
			} else if (f.type === 'voice_note') {
				const clips = Array.isArray(f.voiceClips) ? f.voiceClips : [];
				lines.push(`- **Recorded Voice Clips**: \`${clips.length}\``);
				lines.push(`- **Auto-Transcribe**: \`${f.voiceAutoTranscribe !== false}\``);
				lines.push(`- **Playback Speed**: \`${f.voicePlaybackRate || 1.0}x\``);
				clips.forEach((c, ci) => {
					lines.push(`  - Clip #${ci + 1} (${c.durationSeconds ? `${c.durationSeconds}s` : 'audio'}): ${c.transcript ? c.transcript : '(no transcript)'}`);
				});
			} else if (f.type === 'git') {
				lines.push(`- **Git Remote URL**: \`${f.gitRemoteUrl || '(not set)'}\``);
				lines.push(`- **Git Branch**: \`${f.gitBranch || 'main'}\``);
			} else if (f.type === 'http_request') {
				lines.push(`- **HTTP Method**: \`${(f.httpMethod || 'GET').toUpperCase()}\``);
				lines.push(`- **Request URL**: \`${f.httpUrl || '(not set)'}\``);
				lines.push(`- **Authentication**: \`${f.httpAuthType || 'none'}\``);
				lines.push(`- **Body Type**: \`${f.httpBodyType || 'none'}\``);
				lines.push(`- **Timeout**: \`${f.httpTimeoutMs || 30000} ms\``);
			} else if (f.type === 'output') {
				const specs = f.outputSpecs || [];
				lines.push(`- **Exposed Output Specifications (${specs.length})**:`);
				specs.forEach(s => {
					lines.push(`  - \`${s.label || s.fieldKey}\` (Field Key: \`${s.fieldKey}\`, Enabled: \`${s.enabled}\`, Format: \`${s.defaultFormat || 'text'}\`)`);
				});
			} else {
				if (f.options && f.options.length > 0) {
					lines.push(`- **Options**: ${f.options.map(o => `\`${o}\``).join(', ')}`);
				}
				if (f.defaultContent) {
					lines.push(`- **Default Content**: \`${f.defaultContent}\``);
				}
			}
			lines.push('');
		});

		// Section 4: Sanitized Machine-Readable Schema (JSON)
		const sanitizedFields = fields.map(f => {
			const clone: Record<string, unknown> = { ...f };
			delete clone.debugPromptOutput;
			delete clone.debugSqlOutput;
			delete clone.pythonOutput;
			delete clone.pythonResult;
			delete clone.ttsAudioDataUrl;
			if (clone.type === 'voice_note' && Array.isArray(clone.voiceClips)) {
				clone.voiceClips = clone.voiceClips.map((c: IVoiceNoteClip) => ({
					id: c.id,
					title: c.title,
					mimeType: c.mimeType,
					durationSeconds: c.durationSeconds,
					transcript: c.transcript,
					createdAt: c.createdAt,
					hasAudio: Boolean(c.audioDataUrl)
				}));
			}
			delete clone.httpResponseData;
			delete clone.httpResponseBody;
			delete clone.httpResponseHeaders;
			if (clone.type === 'http_request') {
				if (clone.httpAuthToken) { clone.httpAuthToken = '***REDACTED***'; }
				if (clone.httpApiKeyValue) { clone.httpApiKeyValue = '***REDACTED***'; }
				if (clone.httpAuthPassword) { clone.httpAuthPassword = '***REDACTED***'; }
			}
			if (clone.type === 'browser' && typeof clone.defaultContent === 'string' && clone.defaultContent.length > 300) {
				clone.defaultContent = `[Fetched webpage preview omitted (${clone.defaultContent.length} chars)]`;
			}
			if (Array.isArray(clone.credentials)) {
				clone.credentials = clone.credentials.map((c: ICredentialPair) => ({
					id: c.id,
					key: c.key,
					value: c.value ? '***REDACTED***' : ''
				}));
			}
			return clone;
		});

		const cleanSchema = {
			id: mod.id,
			name: mod.name,
			description: mod.description || '',
			prompt: mod.prompt || '',
			isDeprecated: !!mod.isDeprecated,
			icon: mod.icon || getDefaultCustomModuleIconId(mod.id),
			color: mod.color,
			storageScope: mod.storageScope || 'global',
			statuses,
			fields: sanitizedFields
		};

		lines.push('## 4. Machine-Readable Template Schema (JSON)');
		lines.push('```json');
		lines.push(JSON.stringify(cleanSchema, null, 2));
		lines.push('```');

		return lines.join('\n');
	}

	private _attachInstantTooltip(targetEl: HTMLElement, textOrGetter: string | (() => string), accentColor: string = '#38bdf8'): void {
		let tipEl: HTMLElement | null = null;
		const hideTooltip = () => {
			if (tipEl) {
				tipEl.remove();
				tipEl = null;
			}
			removeAllInstantTooltips();
		};
		const showTooltip = () => {
			hideTooltip();
			if (!targetEl.isConnected) { return; }
			const rawText = typeof textOrGetter === 'function' ? textOrGetter() : textOrGetter;
			if (!rawText) { return; }
			tipEl = document.createElement('div');
			tipEl.className = 'anyagent-instant-tooltip';
			liveInstantTooltips.add(tipEl);
			tipEl.style.cssText = `position: fixed; z-index: 100000; pointer-events: none; background: #141417; color: #f4f4f5; border: 1px solid ${accentColor}; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.65); padding: 5px 10px; border-radius: 6px; font-size: 11px; font-weight: 500; white-space: nowrap; line-height: 1.35; letter-spacing: 0.01em;`;

			const colonIdx = rawText.indexOf(':');
			if (colonIdx > 0 && colonIdx < 28) {
				const titleSpan = document.createElement('span');
				titleSpan.style.cssText = `font-weight: 700; color: ${accentColor}; margin-right: 4px;`;
				titleSpan.textContent = rawText.slice(0, colonIdx + 1);
				const descSpan = document.createElement('span');
				descSpan.textContent = rawText.slice(colonIdx + 1).trim();
				tipEl.appendChild(titleSpan);
				tipEl.appendChild(descSpan);
			} else {
				tipEl.textContent = rawText;
			}

			const targetWindow = getWindow(targetEl);
			targetWindow.document.body.appendChild(tipEl);
			const rect = targetEl.getBoundingClientRect();
			const tipRect = tipEl.getBoundingClientRect();
			let left = rect.left + (rect.width / 2) - (tipRect.width / 2);
			const maxLeft = targetWindow.innerWidth - tipRect.width - 10;
			if (left > maxLeft) { left = maxLeft; }
			if (left < 10) { left = 10; }
			let top = rect.bottom + 7;
			if (top + tipRect.height > targetWindow.innerHeight - 8) {
				top = rect.top - tipRect.height - 7;
			}
			tipEl.style.left = `${Math.round(left)}px`;
			tipEl.style.top = `${Math.round(top)}px`;
		};
		targetEl.addEventListener('mouseenter', showTooltip);
		targetEl.addEventListener('mouseleave', hideTooltip);
		targetEl.addEventListener('mousedown', hideTooltip);
		targetEl.addEventListener('click', hideTooltip);
		targetEl.addEventListener('blur', hideTooltip);
	}

	private async _openTemplateFieldInAgentCentral(
		mode: 'definition' | 'prompt',
		activeMod: ICustomModule
	): Promise<void> {
		this._syncDraft();
		await this._persistCurrentModule();

		const isDefinition = mode === 'definition';
		const moduleId = activeMod.id || 'custom-module';
		const moduleName = activeMod.name || moduleId;
		const templateSpec = this._formatModuleForLlmCopy(activeMod);

		const defPreInjectedPrompt = [
			`=== CURRENT CUSTOM MODULE TEMPLATE CONTEXT ===`,
			`Target Module ID: ${moduleId}`,
			`Target Module Name: ${moduleName}`,
			`Target Field: /Type Definition (module.description)`,
			``,
			`[TASK & GUIDELINES FOR AI ASSISTANT]:`,
			`1. Your goal is to synthesize or update the 'type_definition' for Custom Module '${moduleName}' (module_id: '${moduleId}').`,
			`2. If the user manually edited the Proposed Value in the Context Locator editor box above and requested to apply it directly, use that proposed value.`,
			`3. Otherwise, based on the current template structure below, synthesize a concise, high-level Type Definition (1 to 2 short sentences) describing what this template is for.`,
			`4. CRITICAL RULE: Keep the description high-level and directional. DO NOT describe overly granular details such as listing specific field names, SQLite column names, or {Variable} placeholder tokens, because fields and variable bindings may later be added, removed, or adjusted.`,
			`5. Call the tool 'anyagent_generate_custom_module' with:`,
			`   - module_id: "${moduleId}"`,
			`   - module_name: "${moduleName}"`,
			`   - type_definition: "<your synthesized or updated Type Definition>"`,
			`   - auto_open: false`,
			`   (Omit 'fields' so all existing template fields and configurations are preserved intact!)`,
			``,
			`=== FULL TEMPLATE SPECIFICATION ===`,
			templateSpec
		].join('\n');

		const promptPreInjectedPrompt = [
			`=== CURRENT CUSTOM MODULE TEMPLATE CONTEXT ===`,
			`Target Module ID: ${moduleId}`,
			`Target Module Name: ${moduleName}`,
			`Target Field: /Type Prompt (module.prompt - AI System Instructions for this Module)`,
			``,
			`[TASK & GUIDELINES FOR AI ASSISTANT]:`,
			`1. Your goal is to synthesize or update the 'type_prompt' (AI System Instructions) for Custom Module '${moduleName}' (module_id: '${moduleId}').`,
			`2. The essence of 'type_prompt' is to tell future AI agents how to understand and use tickets generated from this template when inspecting or processing them.`,
			`3. If the user manually edited the Proposed Value in the Context Locator editor box above and requested to apply it directly, use that proposed value.`,
			`4. Otherwise, based on the current template structure below, synthesize high-level directional AI System Instructions explaining the overall workflow direction and what each major block or stage generally accomplishes.`,
			`5. CRITICAL RULE: Keep the instructions high-level and directional. DO NOT describe overly granular details such as hardcoding exact field lists, exact SQLite column names, or literal {Variable} placeholder tokens, because fields and variable bindings may later be added, removed, or adjusted.`,
			`6. Call the tool 'anyagent_generate_custom_module' with:`,
			`   - module_id: "${moduleId}"`,
			`   - module_name: "${moduleName}"`,
			`   - type_prompt: "<your synthesized or updated Type Prompt>"`,
			`   - auto_open: false`,
			`   (Omit 'fields' so all existing template fields and configurations are preserved intact!)`,
			``,
			`=== FULL TEMPLATE SPECIFICATION ===`,
			templateSpec
		].join('\n');

		const hierarchyTree = [
			{
				path: '/Type Definition',
				label: 'Type Definition',
				fieldType: 'text',
				currentValue: activeMod.description || '',
				preInjectedPrompt: defPreInjectedPrompt
			},
			{
				path: '/Type Prompt',
				label: 'Type Prompt (AI System Instructions)',
				fieldType: 'textarea',
				currentValue: activeMod.prompt || '',
				preInjectedPrompt: promptPreInjectedPrompt
			}
		];

		const defaultUserPrompt = isDefinition
			? `Based on the current template structure of '${moduleName}', please generate a concise, high-level Type Definition (1-2 sentences describing its overall purpose, without listing specific field or variable names) and update this template.`
			: `Based on the current template structure of '${moduleName}', please generate high-level directional AI System Instructions (Type Prompt) so AI agents understand the overall direction and what each major stage generally does (without hardcoding specific field or variable names) and update this template.`;

		try {
			await this._commandService.executeCommand('workbench.action.chat.toggleCenteredChatPopup', {
				ticketId: `Template: ${moduleName}`,
				field: isDefinition ? '/Type Definition' : '/Type Prompt',
				label: isDefinition ? 'Type Definition' : 'Type Prompt (AI System Instructions)',
				fieldType: isDefinition ? 'text' : 'textarea',
				currentValue: isDefinition ? (activeMod.description || '') : (activeMod.prompt || ''),
				preInjectedPrompt: isDefinition ? defPreInjectedPrompt : promptPreInjectedPrompt,
				prompt: defaultUserPrompt,
				hierarchyTree,
				autoSend: false
			});
		} catch (err) {
			console.error('Failed to open Agent Central for template field:', err);
		}
	}

}
