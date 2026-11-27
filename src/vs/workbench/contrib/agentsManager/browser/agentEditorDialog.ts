/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ServicesAccessor, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { $, append, clearNode, isHTMLInputElement } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IAgentsManagerService, IAgentItem, AgentScopeType, IAgentCredentialService, IAgentModelReference, IAgentCredential, getGlobalDefaultModel, resolveDefaultModelId } from '../common/agentsManager.js';
import { IWorkspacesExplorerService, WORKSPACE_PANE_VIEW_ID } from '../../workspacesExplorer/common/workspacesExplorer.js';
import { WorkspacesExplorerPane } from '../../workspacesExplorer/browser/workspacesExplorerPane.js';
import { ICustomModulesService } from '../../customModules/common/customModules.js';
import { stringifyYaml } from '../../customModules/browser/customModulesService.js';
import { ICustomModule, IActionButton, normalizeNumberFieldValue, numberFieldRulesFromAttributes } from '../../entityPersistence/common/entityPersistence.js';
import { EntityDetailEditorInput } from '../../workspacesExplorer/browser/entityDetailEditorInput.js';
import { AccountManagementDialog } from '../../accountManagement/browser/accountManagementDialog.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { isCommentKeybinding, togglePythonComment } from '../../customModules/browser/pythonSyntaxHighlighter.js';


interface IPendingFieldAttachment {
	name: string;
	size: number;
	dataUrl?: string;
}

/** Direct references to one rendered item card of a `dynamic_list` custom field. */
interface IDynamicItemCardRefs {
	readonly card: HTMLElement;
	readonly badge: HTMLElement;
	readonly titleInput: HTMLInputElement;
	readonly subInputs: Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
}

/**
 * Direct references to one rendered `.custom-field-input` element plus the
 * accessors needed to read its value when the agent is created.
 */
interface ICustomFieldInputRefs {
	readonly element: HTMLElement;
	readonly valueInput?: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
	readonly checkboxes?: HTMLInputElement[];
	readonly rangeStart?: HTMLInputElement;
	readonly rangeEnd?: HTMLInputElement;
	readonly itemCards?: IDynamicItemCardRefs[];
	readonly getAttachedFiles?: () => IPendingFieldAttachment[];
	readonly getSelectedAction?: () => string;
	readonly getSelectedTargetStatus?: () => string;
	readonly getBrowserData?: () => object;
	readonly getPromptData?: () => object;
	readonly getTtsData?: () => object;
	readonly getPythonData?: () => object;
}

/** The overlay of the currently open agent dialog (only one is shown at a time). */
let activeAgentModalOverlay: HTMLElement | undefined;

export async function createOrEditAgentDialog(
	accessor: ServicesAccessor,
	existingAgent?: IAgentItem,
	defaultScopeType: AgentScopeType = 'workspace',
	defaultScopeName: string = 'Workspace Global',
	targetFolderUri?: URI
): Promise<IAgentItem | undefined> {
	// Resolve all services synchronously: the accessor is invalid after the first await.
	const agentsService = accessor.get(IAgentsManagerService);
	const credentialService = accessor.get(IAgentCredentialService);
	const languageModelsService = accessor.get(ILanguageModelsService);
	const notificationService = accessor.get(INotificationService);
	const fileDialogService = accessor.get(IFileDialogService);
	const fileService = accessor.get(IFileService);
	const openerService = accessor.get(IOpenerService);
	const commandService = accessor.get(ICommandService);
	const editorService = accessor.get(IEditorService);
	const workspacesExplorerService = accessor.get(IWorkspacesExplorerService);
	const customModulesService = accessor.get(ICustomModulesService);
	const viewsService = accessor.get(IViewsService);

	// Unify new AI Agent creation into the single unified Ticket creation modal in WorkspacesExplorerPane.
	if (!existingAgent) {
		let view = viewsService.getViewWithId(WORKSPACE_PANE_VIEW_ID) as WorkspacesExplorerPane | null;
		if (!view) {
			view = await viewsService.openView(WORKSPACE_PANE_VIEW_ID, false) as WorkspacesExplorerPane | null;
		}
		if (view && typeof view.showCreateResourceModal === 'function') {
			view.showCreateResourceModal(targetFolderUri, undefined, undefined, 'agent');
			return undefined;
		}
	}

	const savedCredentials = await credentialService.getCredentials();
	const managedWorkspaces = await workspacesExplorerService.getWorkspaces();
	let workspaces = [...managedWorkspaces].reverse();

	return new Promise<IAgentItem | undefined>((resolve) => {
		// 1. Remove any existing modal
		if (activeAgentModalOverlay) {
			activeAgentModalOverlay.remove();
		}

		// 2. Create Modal Overlay (Blur backdrop)
		const targetDocument = mainWindow.document;
		const overlay = append(targetDocument.body, $('.create-agent-modal-overlay'));
		activeAgentModalOverlay = overlay;
		overlay.style.position = 'fixed';
		overlay.style.top = '0';
		overlay.style.left = '0';
		overlay.style.width = '100vw';
		overlay.style.height = '100vh';
		overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.65)';
		overlay.style.backdropFilter = 'blur(6px)';
		overlay.style.display = 'flex';
		overlay.style.alignItems = 'center';
		overlay.style.justifyContent = 'center';
		overlay.style.zIndex = '100000';
		overlay.style.padding = '20px';
		overlay.style.boxSizing = 'border-box';

		// 3. Modal Main Dialog Box (Spacious, Roomy, VS Code System Font)
		const modal = append(overlay, $('.create-agent-modal-box'));
		modal.style.width = '100%';
		modal.style.maxWidth = '600px';
		modal.style.backgroundColor = 'var(--vscode-editorWidget-background, #1e1e1e)';
		modal.style.border = '1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.15))';
		modal.style.borderRadius = '10px';
		modal.style.padding = '24px 28px';
		modal.style.boxShadow = '0 20px 48px rgba(0, 0, 0, 0.65)';
		modal.style.display = 'flex';
		modal.style.flexDirection = 'column';
		modal.style.gap = '16px';
		modal.style.color = 'var(--vscode-foreground, #cccccc)';
		modal.style.fontFamily = 'var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif)';
		modal.style.fontSize = '12px';
		modal.style.maxHeight = '92vh';
		modal.style.overflowY = 'auto';

		// Close handler
		const docClickListener = (e: MouseEvent) => {
			if (e.target !== modelInput && !modelDropdown.contains(e.target as Node)) {
				modelDropdown.style.display = 'none';
			}
		};
		let credsListener: { dispose(): void } | undefined = undefined;
		let workspacesListener: { dispose(): void } | undefined = undefined;
		let modulesListener: { dispose(): void } | undefined = undefined;
		const closeModal = (result?: IAgentItem) => {
			if (credsListener) {
				credsListener.dispose();
			}
			if (workspacesListener) {
				workspacesListener.dispose();
				workspacesListener = undefined;
			}
			if (modulesListener) {
				modulesListener.dispose();
				modulesListener = undefined;
			}
			targetDocument.removeEventListener('click', docClickListener);
			overlay.remove();
			resolve(result);
		};

		// 4. Modal Header
		const modalHeader = append(modal, $('.modal-header'));
		modalHeader.style.display = 'flex';
		modalHeader.style.alignItems = 'center';
		modalHeader.style.justifyContent = 'space-between';
		modalHeader.style.paddingBottom = '4px';

		const modalTitle = append(modalHeader, $('div', {
			style: 'font-weight: 600; font-size: 15px; color: var(--vscode-foreground, #ffffff); display: flex; align-items: center; gap: 8px;'
		}));
		const robotIcon = append(modalTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.robot)));
		robotIcon.style.color = 'var(--vscode-charts-blue, #38bdf8)';
		append(modalTitle, $('span', {}, existingAgent ? 'Edit AI Agent' : 'Create New AI Agent'));

		const closeBtn = append(modalHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
		closeBtn.style.cursor = 'pointer';
		closeBtn.style.opacity = '0.7';
		closeBtn.style.fontSize = '15px';
		closeBtn.onclick = () => closeModal(undefined);

		// Helper function for uniform form labels
		const createFormLabel = (text: string) => {
			return $('label', {
				style: 'display: block; font-size: 11.5px; font-weight: 500; margin-bottom: 6px; color: var(--vscode-foreground, #cccccc); opacity: 0.85; font-family: inherit;'
			}, text);
		};

		const applyControlStyle = (el: HTMLElement) => {
			el.style.width = '100%';
			el.style.padding = '8px 12px';
			el.style.fontSize = '12px';
			el.style.fontFamily = 'inherit';
			el.style.borderRadius = '6px';
			el.style.border = '1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.15))';
			el.style.background = 'var(--vscode-input-background, #121212)';
			el.style.color = 'var(--vscode-input-foreground, #cccccc)';
			el.style.boxSizing = 'border-box';
			el.style.outline = 'none';
			el.style.transition = 'border-color 0.15s ease';

			el.onfocus = () => el.style.borderColor = 'var(--vscode-focusBorder, #38bdf8)';
			el.onblur = () => el.style.borderColor = 'var(--vscode-input-border, rgba(255, 255, 255, 0.15))';
		};

		// 4.5 Agent Scope Selection & Storage Location (aligned with Create New Workflow)
		const destGroup = append(modal, $('.form-group'));
		append(destGroup, createFormLabel('Agent Scope:'));

		const selectDest = append(destGroup, $('select.monaco-select', {
			style: 'cursor: pointer;'
		})) as HTMLSelectElement;
		applyControlStyle(selectDest);

		const populateWorkspaceOptions = (selectedValue?: string) => {
			while (selectDest.options.length > 0) {
				selectDest.remove(0);
			}

			const rootOpt = append(selectDest, $('option', {}, 'No workspace (choose a workspace to create an agent)')) as HTMLOptionElement;
			rootOpt.value = 'independent';

			let matchedOption = false;
			workspaces.forEach((ws, idx) => {
				const opt = append(selectDest, $('option', {}, `Workspace: ${ws.name}`)) as HTMLOptionElement;
				opt.value = ws.uri.toString();
				if (selectedValue) {
					if (selectedValue === ws.uri.toString()) {
						opt.selected = true;
						matchedOption = true;
					}
				} else if (existingAgent?.folderPath) {
					const normExisting = existingAgent.folderPath.replace(/\/+$/, '');
					const normWs = ws.uri.fsPath.replace(/\/+$/, '');
					if (normExisting === normWs || normExisting.startsWith(normWs + '/')) {
						opt.selected = true;
						matchedOption = true;
					}
				} else if (targetFolderUri) {
					if (
						targetFolderUri.toString() === ws.uri.toString() ||
						targetFolderUri.path === ws.uri.path ||
						targetFolderUri.path.startsWith(ws.uri.path + '/')
					) {
						opt.selected = true;
						matchedOption = true;
					}
				} else if (defaultScopeType !== 'none' && idx === 0) {
					opt.selected = true;
					matchedOption = true;
				}
			});

			if (!matchedOption) {
				rootOpt.selected = true;
			}
		};

		populateWorkspaceOptions();
		if (existingAgent) {
			selectDest.disabled = true;
			selectDest.style.opacity = '0.7';
			selectDest.style.cursor = 'not-allowed';
		}

		workspacesListener = workspacesExplorerService.onDidChangeWorkspaces(async () => {
			const prevValue = selectDest.value;
			const updated = await workspacesExplorerService.getWorkspaces();
			workspaces = [...updated].reverse();
			populateWorkspaceOptions(prevValue);
		});

		let initialPath = '';
		if (existingAgent?.folderPath) {
			initialPath = existingAgent.folderPath;
		} else if (targetFolderUri) {
			initialPath = targetFolderUri.fsPath;
		} else if (selectDest.value !== 'independent') {
			const selectedWs = workspaces.find(w => w.uri.toString() === selectDest.value);
			if (selectedWs) {
				initialPath = selectedWs.uri.fsPath;
			}
		}

		const locationGroup = append(modal, $('.form-group'));
		append(locationGroup, createFormLabel('Agent Directory / Storage Location:'));

		const locationRow = append(locationGroup, $('.location-row'));
		locationRow.style.display = 'flex';
		locationRow.style.gap = '8px';
		locationRow.style.alignItems = 'center';

		const locationInput = append(locationRow, $('input.monaco-inputbox', {
			style: 'flex: 1;'
		})) as HTMLInputElement;
		applyControlStyle(locationInput);
		locationInput.value = initialPath;

		const browseBtn = append(locationRow, $('button.monaco-button', {
			style: 'padding: 8px 16px; font-size: 12px; font-family: inherit; font-weight: 500; border-radius: 6px; cursor: pointer; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: var(--vscode-foreground, #cccccc); white-space: nowrap; transition: background 0.15s ease;'
		}));
		browseBtn.innerText = 'Browse...';
		browseBtn.onmouseenter = () => browseBtn.style.background = 'rgba(255, 255, 255, 0.14)';
		browseBtn.onmouseleave = () => browseBtn.style.background = 'rgba(255, 255, 255, 0.08)';
		if (existingAgent) {
			locationInput.readOnly = true;
			locationInput.style.opacity = '0.7';
			browseBtn.style.display = 'none';
		}

		// Live Ticket ID Preview Badge
		const badgeGroup = append(modal, $('.form-group'));
		const previewBadge = append(badgeGroup, $('div', {
			style: 'font-size: 11.5px; font-weight: 600; color: #38bdf8; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.35); border-radius: 6px; padding: 8px 12px; text-align: center;'
		}));
		previewBadge.innerText = existingAgent
			? `Ticket ID: ${existingAgent.ticketId || existingAgent.folderPath?.split('/').filter(Boolean).pop() || existingAgent.name} (${existingAgent.scopeName})`
			: 'Generated Ticket ID: calculating...';

		// 5. Agent Title / Name
		const nameGroup = append(modal, $('.form-group'));
		append(nameGroup, createFormLabel('Agent Title:'));
		const nameInput = append(nameGroup, $('input.monaco-inputbox')) as HTMLInputElement;
		applyControlStyle(nameInput);
		nameInput.placeholder = 'e.g. System Architect Agent, UI Developer';
		nameInput.value = existingAgent ? (existingAgent.title || existingAgent.name) : '';

		// 6. Role & Description
		const roleGroup = append(modal, $('.form-group'));
		append(roleGroup, createFormLabel('Role & Description:'));
		const roleInput = append(roleGroup, $('input.monaco-inputbox')) as HTMLInputElement;
		applyControlStyle(roleInput);
		roleInput.placeholder = 'e.g. NestJS Backend Specialist, Monaco UI Refactoring Architect';
		roleInput.value = existingAgent?.role || '';
		// 7. API Credential / Connection Provider
		const credGroup = append(modal, $('.form-group'));
		append(credGroup, createFormLabel('API Connection Credential:'));
		const credSelect = append(credGroup, $('select.monaco-select', {
			style: 'width: 100%; padding: 8px 12px; font-size: 12px; font-family: inherit; border-radius: 6px; border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15)); background: var(--vscode-input-background, #121212); color: inherit; box-sizing: border-box; outline: none; cursor: pointer;'
		})) as HTMLSelectElement;

		const credHelp = append(credGroup, $('div', {
			style: 'font-size: 11px; color: var(--vscode-descriptionForeground, #888888); margin-top: 4px; line-height: 1.4;'
		}));
		credHelp.appendChild(document.createTextNode('To connect custom providers (Ollama, DeepSeek, OpenAI, Claude), configure keys in '));
		const helpLink = append(credHelp, $('span', {
			style: 'color:var(--vscode-textLink-foreground,#38bdf8);cursor:pointer;text-decoration:underline;'
		}));
		helpLink.textContent = 'Account & Security Preferences -> AI LLM Providers';
		credHelp.appendChild(document.createTextNode('.'));

		helpLink.onclick = () => {
			closeModal(undefined);
			const instantiationService = accessor.get(IInstantiationService);
			const dialog = instantiationService.createInstance(AccountManagementDialog);
			dialog.show('Models');
		};

		// Populate credentials

		if (savedCredentials.length === 0) {
			const opt = append(credSelect, $('option', { value: 'none' }, 'No Credentials Configured (click link below to configure)')) as HTMLOptionElement;
			opt.disabled = true;
			opt.selected = true;
		} else {
			// New agent: preselect the credential of the user's Default Model (if any), else the first enabled one
			const initialDefaultModel = getGlobalDefaultModel();
			const initialDefaultCredId = initialDefaultModel
				? (savedCredentials.find(c => c.isEnabled !== false && c.id === initialDefaultModel.credentialId) || savedCredentials.find(c => c.isEnabled !== false && c.providerId === initialDefaultModel.providerId))?.id
				: undefined;
			for (let i = 0; i < savedCredentials.length; i++) {
				const cred = savedCredentials[i];
				const displayName = cred.isEnabled !== false ? `${cred.name} (${cred.providerId})` : `${cred.name} (${cred.providerId}) [Disabled]`;
				const opt = append(credSelect, $('option', { value: cred.id }, displayName)) as HTMLOptionElement;
				if (cred.isEnabled === false) {
					opt.disabled = true;
				}
				if (existingAgent?.model?.credentialId === cred.id) {
					opt.selected = true;
				} else if (!existingAgent && (initialDefaultCredId ? cred.id === initialDefaultCredId : (i === 0 && cred.isEnabled !== false))) {
					opt.selected = true;
				}
			}
		}

		credsListener = credentialService.onDidChangeCredentials(async () => {
			const creds = await credentialService.getCredentials();
			savedCredentials.length = 0;
			savedCredentials.push(...creds);

			const currentSelection = credSelect.value;
			clearNode(credSelect);

			if (savedCredentials.length === 0) {
				const opt = append(credSelect, $('option', { value: 'none' }, 'No Credentials Configured (click link below to configure)')) as HTMLOptionElement;
				opt.disabled = true;
				opt.selected = true;
			} else {
				for (let i = 0; i < savedCredentials.length; i++) {
					const cred = savedCredentials[i];
					const displayName = cred.isEnabled !== false ? `${cred.name} (${cred.providerId})` : `${cred.name} (${cred.providerId}) [Disabled]`;
					const opt = append(credSelect, $('option', { value: cred.id }, displayName)) as HTMLOptionElement;
					if (cred.isEnabled === false) {
						opt.disabled = true;
					}
					if (currentSelection === cred.id) {
						opt.selected = true;
					} else if (currentSelection === 'none' && i === 0 && cred.isEnabled !== false) {
						opt.selected = true;
					}
				}
			}
			updateModelsList();
			renderFilteredDropdown();
		});

		// 7.5 AI Model Selection Dropdown with Fuzzy Search & Free Typing
		const modelGroup = append(modal, $('.form-group', { style: 'position: relative;' }));
		append(modelGroup, createFormLabel('AI Model:'));
		const modelInputContainer = append(modelGroup, $('.model-input-container', {
			style: 'position: relative; width: 100%;'
		}));
		const modelInput = append(modelInputContainer, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 8px 30px 8px 12px; font-size: 12px; font-family: inherit; border-radius: 6px; border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15)); background: var(--vscode-input-background, #121212); color: inherit; box-sizing: border-box; outline: none;'
		})) as HTMLInputElement;
		modelInput.placeholder = 'Search model or type custom ID...';

		const modelArrow = append(modelInputContainer, $('div', {
			style: 'position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 8px; color: var(--vscode-descriptionForeground, #888888); cursor: pointer; pointer-events: none;'
		}));
		modelArrow.textContent = '▼';

		const modelDropdown = append(modelGroup, $('.model-search-dropdown', {
			style: 'position: absolute; top: 100%; left: 0; width: 100%; max-height: 200px; overflow-y: auto; background: var(--vscode-editorWidget-background, #1e1e1e); border: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.15)); border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); z-index: 100001; display: none; margin-top: 4px; box-sizing: border-box;'
		}));

		interface ISearchableModel {
			id: string;
			label: string;
		}
		let availableModels: ISearchableModel[] = [];
		let isFiltering = false;

		const renderFilteredDropdown = () => {
			clearNode(modelDropdown);
			const query = isFiltering ? modelInput.value.toLowerCase().trim() : '';

			const filtered = availableModels.filter(m => {
				if (!query) { return true; }
				// Simple subsequence matching
				const matchString = `${m.id} ${m.label}`.toLowerCase();
				let queryIndex = 0;
				for (let i = 0; i < matchString.length; i++) {
					if (matchString[i] === query[queryIndex]) {
						queryIndex++;
						if (queryIndex === query.length) {
							return true;
						}
					}
				}
				return false;
			});

			if (filtered.length === 0) {
				const noMatch = append(modelDropdown, $('.model-dropdown-item', {
					style: 'padding: 8px 12px; color: #888888; font-style: italic; font-size: 11px;'
				}));
				noMatch.textContent = 'No matching models. Type to use custom ID.';
				return;
			}

			filtered.forEach(m => {
				const item = append(modelDropdown, $('.model-dropdown-item', {
					style: 'padding: 8px 12px; cursor: pointer; transition: background 80ms ease; font-size: 11.5px; border-bottom: 1px solid rgba(255,255,255,0.02); color: var(--vscode-editorWidget-foreground, inherit); line-height: 1.4;'
				}));
				item.textContent = m.label;
				item.onmouseenter = () => { item.style.background = 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.08))'; };
				item.onmouseleave = () => { item.style.background = 'transparent'; };
				item.onclick = (e) => {
					e.stopPropagation();
					modelInput.value = m.id;
					modelDropdown.style.display = 'none';
				};
			});
		};

		const activeFetchIds = new Set<string>();

		const triggerDynamicFetch = async (cred: IAgentCredential) => {
			if (activeFetchIds.has(cred.id)) {
				return;
			}
			activeFetchIds.add(cred.id);

			try {
				const apiKey = await credentialService.getApiKey(cred.id);
				if (apiKey) {
					const models = await credentialService.fetchModels(cred.providerId, apiKey, cred.customUrl);
					if (models && models.length > 0) {
						const updated = {
							...cred,
							cachedModels: models,
							connectionStatus: 'connected' as const,
							lastVerifiedAt: Date.now()
						};
						await credentialService.updateCredential(updated);

						if (credSelect.value === cred.id) {
							updateModelsList();
							renderFilteredDropdown();
						}
					}
				}
			} catch (e) {
				console.error('Failed to dynamically fetch models in dialog:', e);
			} finally {
				activeFetchIds.delete(cred.id);
			}
		};

		const getSmartDefaultModel = (models: ISearchableModel[], providerId: string): string => {
			if (models.length === 0) { return ''; }

			const candidates = models.filter(m => {
				const idLower = m.id.toLowerCase();
				if (idLower.includes('/')) {
					const prefix = idLower.split('/')[0];
					const cleanProv = providerId.toLowerCase();
					return cleanProv.includes(prefix) || prefix.includes(cleanProv);
				}
				return true;
			});

			const activeList = candidates.length > 0 ? candidates : models;

			const priorities = [
				'gpt-4o-mini',
				'gpt-4o',
				'gpt-4-turbo',
				'gpt-3.5-turbo',
				'claude-3-5-sonnet',
				'claude-3-5-haiku',
				'gemini-2.0-flash',
				'gemini-1.5-flash',
				'gemini-1.5-pro'
			];

			for (const p of priorities) {
				const found = activeList.find(m => m.id.toLowerCase().includes(p));
				if (found) { return found.id; }
			}

			const chatKeywords = ['gpt', 'claude', 'gemini', 'chat', 'llama', 'mistral', 'deepseek', 'qwen', 'command-r'];
			const nonChatKeywords = ['embedding', 'whisper', 'tts', 'moderation', 'edit'];

			const chatModels = activeList.filter(m => {
				const idLower = m.id.toLowerCase();
				const isNonChat = nonChatKeywords.some(kw => idLower.includes(kw));
				if (isNonChat) { return false; }
				return chatKeywords.some(kw => idLower.includes(kw));
			});

			if (chatModels.length > 0) { return chatModels[0].id; }

			const generalCandidates = activeList.filter(m => {
				const idLower = m.id.toLowerCase();
				return !nonChatKeywords.some(kw => idLower.includes(kw));
			});

			if (generalCandidates.length > 0) { return generalCandidates[0].id; }
			return activeList[0].id;
		};

		const updateModelsList = () => {
			availableModels = [];
			const selectedCredId = credSelect.value;

			if (selectedCredId === 'default' || selectedCredId === 'none') {
				const modelIds = languageModelsService.getLanguageModelIds();
				const selectableModels = new Map<string, string>();

				selectableModels.set('gemini/gemini-2.0-flash', 'Gemini 2.0 Flash (Google)');
				selectableModels.set('gemini/gemini-1.5-flash', 'Gemini 1.5 Flash (Google)');
				selectableModels.set('openai/gpt-4o', 'GPT-4o (OpenAI)');
				selectableModels.set('anthropic/claude-3-5-sonnet', 'Claude 3.5 Sonnet (Anthropic)');

				for (const id of modelIds) {
					const meta = languageModelsService.lookupLanguageModel(id);
					if (meta) {
						selectableModels.set(id, `${meta.name} (${meta.vendor})`);
					} else {
						selectableModels.set(id, id);
					}
				}

				for (const [id, label] of selectableModels.entries()) {
					availableModels.push({ id, label });
				}
			} else {
				const cred = savedCredentials.find(c => c.id === selectedCredId);
				if (cred) {
					const cached = cred.cachedModels || [];
					if (cached.length === 0) {
						// Dynamically fetch and populate list in the background
						triggerDynamicFetch(cred);
					} else {
						for (const m of cached) {
							availableModels.push({ id: m, label: m });
						}
					}
				}
			}

			if (existingAgent?.model && (existingAgent.model.credentialId === selectedCredId || (!existingAgent.model.credentialId && (selectedCredId === 'default' || selectedCredId === 'none')))) {
				const targetModelVal = existingAgent.model.modelId;
				const targetProviderVal = existingAgent.model.providerId;
				const matched = availableModels.find(m => m.id === targetModelVal || m.id === `${targetProviderVal}/${targetModelVal}`);
				if (matched) {
					modelInput.value = matched.id;
				} else {
					modelInput.value = targetModelVal;
				}
			} else {
				const activeProv = selectedCredId === 'default' || selectedCredId === 'none'
					? 'gemini'
					: (savedCredentials.find(c => c.id === selectedCredId)?.providerId || 'gemini');
				const dialogDefaultModel = getGlobalDefaultModel();
				const selectedCredForDefault = savedCredentials.find(c => c.id === selectedCredId);
				if (dialogDefaultModel && selectedCredForDefault && (dialogDefaultModel.credentialId ? dialogDefaultModel.credentialId === selectedCredId : selectedCredForDefault.providerId === dialogDefaultModel.providerId)) {
					// Nothing chosen yet for this credential: use the user's Default Model
					modelInput.value = dialogDefaultModel.modelId;
				} else {
					modelInput.value = getSmartDefaultModel(availableModels, activeProv);
				}
			}
		};

		modelInput.onfocus = () => {
			isFiltering = false;
			modelDropdown.style.display = 'block';
			renderFilteredDropdown();
		};

		modelInput.oninput = () => {
			isFiltering = true;
			modelDropdown.style.display = 'block';
			renderFilteredDropdown();
		};

		modelInput.onclick = (e) => {
			e.stopPropagation();
			isFiltering = false;
			modelDropdown.style.display = 'block';
			renderFilteredDropdown();
		};

		targetDocument.addEventListener('click', docClickListener);

		credSelect.onchange = () => {
			isFiltering = false;
			updateModelsList();
			renderFilteredDropdown();
		};
		updateModelsList();
		// 11. System Prompt Textarea (Large, Roomy Textarea)
		const promptGroup = append(modal, $('.form-group'));
		append(promptGroup, createFormLabel('System Prompt / Core Instructions:'));
		const promptInput = append(promptGroup, $('textarea.monaco-inputbox', {
			style: 'width: 100%; min-height: 140px; padding: 10px 12px; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); border-radius: 6px; border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15)); background: var(--vscode-input-background, #121212); color: inherit; box-sizing: border-box; outline: none; resize: vertical;'
		})) as HTMLTextAreaElement;
		promptInput.placeholder = 'e.g. You are the Lead Architect. Maintain modular design, clear contracts, and update instruction.md files...';
		promptInput.value = existingAgent?.systemPrompt || '';

		// 11.5 Git Configuration Section (Only displayed when 'agent' module schema contains a 'git' primitive field)
		const gitBox = append(modal, $('.form-group', {
			style: 'background: rgba(0,0,0,0.18); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 14px; display: none; flex-direction: column; gap: 8px;'
		}));
		const gitHeaderRow = append(gitBox, $('div', { style: 'display: flex; justify-content: space-between; align-items: center;' }));
		const gitTitle = append(gitHeaderRow, $('div', { style: 'font-size: 11.5px; opacity: 0.9; font-weight: 600; display: flex; align-items: center; gap: 6px;' }));
		append(gitTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.sourceControl)));
		append(gitTitle, $('span', {}, 'Git Repository & Branch Binding (Optional)'));
		const gitRemoteRow = append(gitBox, $('div'));
		append(gitRemoteRow, $('label', { style: 'display: block; font-size: 10.5px; opacity: 0.7; margin-bottom: 3px;' }, 'Git Remote URL:'));
		const gitRemoteInput = append(gitRemoteRow, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 6px 10px; font-size: 11px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;
		gitRemoteInput.placeholder = 'e.g. git@github.com:org/repo.git or https://github.com/org/repo.git';
		const gitBranchRow = append(gitBox, $('div'));
		append(gitBranchRow, $('label', { style: 'display: block; font-size: 10.5px; opacity: 0.7; margin-bottom: 3px;' }, 'Target Branch:'));
		const gitBranchInput = append(gitBranchRow, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 6px 10px; font-size: 11px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;
		gitBranchInput.placeholder = 'e.g. main, master (leave blank for default)';

		// 11.6 Dynamic Custom Fields from 'agent' Module Template
		const customFieldsBox = append(modal, $('.custom-fields-box', {
			style: 'display: none; flex-direction: column; gap: 10px; margin-top: 4px;'
		}));

		let activeAgentModule: (ICustomModule & { readonly definitionFile?: string }) | undefined = undefined;
		// Direct references to the rendered custom field inputs, in DOM order; rebuilt whenever customFieldsBox is cleared.
		let customFieldInputs: ICustomFieldInputRefs[] = [];

		const resolveTargetWorkspace = (targetLocationUri?: URI) => {
			if (selectDest.value !== 'independent') {
				const bySelect = workspaces.find(f => f.uri.toString() === selectDest.value);
				if (bySelect) {
					return bySelect;
				}
			}
			if (targetLocationUri) {
				const normPath = targetLocationUri.path.replace(/\/+$/, '');
				return workspaces.find(w => {
					const wsPath = w.uri.path.replace(/\/+$/, '');
					return normPath === wsPath || normPath.startsWith(wsPath + '/');
				});
			}
			return undefined;
		};

		const renderAgentTemplateFields = async () => {
			try {
				if (existingAgent) {
					customFieldsBox.style.display = 'none';
					gitBox.style.display = 'none';
					return;
				}
				const rawPath = locationInput.value.trim();
				const matchedWs = resolveTargetWorkspace(rawPath ? URI.file(rawPath) : undefined);
				const modules = await customModulesService.getCustomModules(matchedWs?.uri);
				const matchingModule = modules.find(m => m.id.toLowerCase() === 'agent' && !m.isDeprecated);
				activeAgentModule = matchingModule;

				const hasGitField = !!(matchingModule && matchingModule.fields && matchingModule.fields.some(f => f.type === 'git'));
				gitBox.style.display = hasGitField ? 'flex' : 'none';
				if (hasGitField) {
					const gitField = matchingModule!.fields!.find(f => f.type === 'git');
					if (gitField?.gitRemoteUrl && !gitRemoteInput.value) {
						gitRemoteInput.value = gitField.gitRemoteUrl;
					}
					if (gitField?.gitBranch && !gitBranchInput.value) {
						gitBranchInput.value = gitField.gitBranch;
					}
				} else {
					gitRemoteInput.value = '';
					gitBranchInput.value = '';
				}

				if (matchingModule && matchingModule.fields && matchingModule.fields.length > 0) {
					clearNode(customFieldsBox);
					customFieldInputs = [];
					let renderedCount = 0;

					for (const field of matchingModule.fields) {
						const fid = (field.id || '').toLowerCase();
						const flabel = (field.label || '').toLowerCase();
						if (
							fid === 'title' || flabel === 'title' ||
							fid === 'description' || flabel === 'description' ||
							fid === 'role' || flabel === 'role' ||
							fid === 'model' || flabel === 'model' ||
							fid === 'system_prompt' || fid === 'systemprompt' || flabel === 'system prompt' ||
							field.type === 'git' || field.type === 'output'
						) {
							continue;
						}
						renderedCount++;
						const fieldGroup = append(customFieldsBox, $('.form-group', { style: 'display: flex; flex-direction: column; gap: 6px; margin-bottom: 4px;' }));
						append(fieldGroup, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; font-weight: 600;' }, `${field.label}:`));

						if (field.type === 'textarea') {
							const textareaEl = append(fieldGroup, $<HTMLTextAreaElement>('textarea.monaco-inputbox.custom-field-input', {
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'width: 100%; padding: 8px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; resize: vertical; min-height: 52px; font-family: inherit;'
							}));
							customFieldInputs.push({ element: textareaEl, valueInput: textareaEl });
						} else if (field.type === 'select') {
							const select = append(fieldGroup, $('select.monaco-select.custom-field-input', {
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.3); color: inherit; cursor: pointer;'
							})) as HTMLSelectElement;
							(field.options || []).forEach((opt: string) => {
								append(select, $('option', { value: opt }, opt));
							});
							customFieldInputs.push({ element: select, valueInput: select });
						} else if (field.type === 'multiselect') {
							const container = append(fieldGroup, $('.multiselect-container.custom-field-input', {
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'display: flex; flex-direction: column; gap: 4px; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 8px; background: rgba(0,0,0,0.15);'
							}));
							const checkboxes: HTMLInputElement[] = [];
							(field.options || []).forEach((opt: string) => {
								const row = append(container, $('label', { style: 'display: flex; align-items: center; gap: 6px; font-size: 11.5px; cursor: pointer;' }));
								checkboxes.push(append(row, $<HTMLInputElement>('input', { type: 'checkbox', value: opt, style: 'cursor: pointer;' })));
								append(row, $('span', {}, opt));
							});
							customFieldInputs.push({ element: container, checkboxes });
						} else if (field.type === 'switch') {
							const row = append(fieldGroup, $('label', { style: 'display: flex; align-items: center; gap: 8px; font-size: 11.5px; cursor: pointer; padding: 4px 0;' }));
							const switchInput = append(row, $<HTMLInputElement>('input.custom-field-input', {
								type: 'checkbox',
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'cursor: pointer;'
							}));
							customFieldInputs.push({ element: switchInput, valueInput: switchInput });
							append(row, $('span', {}, 'Enabled'));
						} else if (field.type === 'date' || field.type === 'time' || field.type === 'datetime') {
							const inputType = field.type === 'date' ? 'date' : field.type === 'time' ? 'time' : 'datetime-local';
							const dateInput = append(fieldGroup, $<HTMLInputElement>('input.monaco-inputbox.custom-field-input', {
								type: inputType,
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
							}));
							customFieldInputs.push({ element: dateInput, valueInput: dateInput });
						} else if (field.type === 'date_range' || field.type === 'time_range' || field.type === 'datetime_range') {
							const rangeContainer = append(fieldGroup, $('.range-container.custom-field-input', {
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'display: flex; align-items: center; gap: 8px;'
							}));
							const inputType = field.type === 'date_range' ? 'date' : field.type === 'time_range' ? 'time' : 'datetime-local';
							const rangeStart = append(rangeContainer, $<HTMLInputElement>('input.monaco-inputbox.range-start', {
								type: inputType,
								placeholder: 'Start',
								style: 'flex: 1; padding: 7px 10px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit;'
							}));
							append(rangeContainer, $('span', { style: 'opacity: 0.6; font-size: 12px;' }, '->'));
							const rangeEnd = append(rangeContainer, $<HTMLInputElement>('input.monaco-inputbox.range-end', {
								type: inputType,
								placeholder: 'End',
								style: 'flex: 1; padding: 7px 10px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit;'
							}));
							customFieldInputs.push({ element: rangeContainer, rangeStart, rangeEnd });
						} else if (field.type === 'dynamic_list') {
							const listContainer = append(fieldGroup, $('.dynamic-list-container.custom-field-input', {
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'display: flex; flex-direction: column; gap: 10px; border: 1px solid rgba(56, 189, 248, 0.2); background: rgba(56, 189, 248, 0.03); border-radius: 8px; padding: 12px;'
							}));
							const itemsWrapper = append(listContainer, $('.dynamic-items-wrapper', { style: 'display: flex; flex-direction: column; gap: 10px;' }));
							const itemCards: IDynamicItemCardRefs[] = [];
							customFieldInputs.push({ element: listContainer, itemCards });
							const renderItemCard = (itemData?: { _title?: string }) => {
								const currentCount = itemCards.length;
								const idx = currentCount + 1;
								const itemCard = append(itemsWrapper, $('.dynamic-item-card', {
									style: 'background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;'
								}));
								const itemHeader = append(itemCard, $('.item-card-header', { style: 'display: flex; justify-content: space-between; align-items: center;' }));
								const headerLeft = append(itemHeader, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex: 1;' }));
								const badge = append(headerLeft, $('span', { style: 'font-size: 10px; font-weight: 700; background: rgba(56, 189, 248, 0.2); color: #38bdf8; padding: 2px 6px; border-radius: 4px;' }, `#${idx}`));
								const titleInput = append(headerLeft, $<HTMLInputElement>('input.monaco-inputbox.item-title-input', {
									placeholder: 'Entry Title...',
									value: itemData?._title || '',
									style: 'flex: 1; padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.25); color: #fff;'
								}));
								const delItemBtn = append(itemHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), {
									style: 'color: #ef4444; cursor: pointer; padding: 4px; font-size: 12px; opacity: 0.8;'
								}));
								const cardRefs: IDynamicItemCardRefs = { card: itemCard, badge, titleInput, subInputs: [] };
								itemCards.push(cardRefs);
								delItemBtn.onclick = () => {
									itemCard.remove();
									const removedIdx = itemCards.indexOf(cardRefs);
									if (removedIdx !== -1) {
										itemCards.splice(removedIdx, 1);
									}
									itemCards.forEach((remaining, rIdx) => {
										remaining.badge.innerText = `#${rIdx + 1}`;
									});
								};
								const subFieldsList = field.itemFields || [];
								if (subFieldsList.length > 0) {
									const subGrid = append(itemCard, $('.subfields-grid', { style: 'display: flex; flex-direction: column; gap: 6px;' }));
									for (const subF of subFieldsList) {
										const subRow = append(subGrid, $('.subfield-row', { style: 'display: flex; flex-direction: column; gap: 3px;' }));
										append(subRow, $('label', { style: 'font-size: 10.5px; opacity: 0.75; font-weight: 500;' }, `${subF.label}:`));
										if (subF.type === 'textarea') {
											cardRefs.subInputs.push(append(subRow, $<HTMLTextAreaElement>('textarea.monaco-inputbox.sub-field-input', {
												'data-subfield-id': subF.id,
												'data-subfield-label': subF.label,
												'data-subfield-type': subF.type,
												rows: '3',
												style: 'width: 100%; padding: 6px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.2); color: #fff; resize: vertical;'
											})));
										} else if (subF.type === 'select') {
											const sSelect = append(subRow, $('select.monaco-select.sub-field-input', {
												'data-subfield-id': subF.id,
												'data-subfield-label': subF.label,
												'data-subfield-type': subF.type,
												style: 'width: 100%; padding: 5px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.25); color: #fff;'
											})) as HTMLSelectElement;
											(subF.options || []).forEach(o => append(sSelect, $('option', { value: o }, o)));
											cardRefs.subInputs.push(sSelect);
										} else {
											cardRefs.subInputs.push(append(subRow, $<HTMLInputElement>('input.monaco-inputbox.sub-field-input', {
												type: subF.type === 'number' ? 'number' : 'text',
												'data-subfield-id': subF.id,
												'data-subfield-label': subF.label,
												'data-subfield-type': subF.type,
												placeholder: `Enter ${subF.label}...`,
												style: 'width: 100%; padding: 5px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.2); color: #fff;'
											})));
										}
									}
								}
							};
							renderItemCard();
							const addEntryBtn = append(listContainer, $('button.monaco-button', {
								style: 'padding: 5px 12px; font-size: 11px; border-radius: 5px; background: rgba(56, 189, 248, 0.12); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); cursor: pointer; align-self: flex-start; font-weight: 500;'
							}));
							addEntryBtn.innerText = `+ Add ${field.label} Entry`;
							addEntryBtn.onclick = (e) => {
								e.preventDefault();
								renderItemCard();
							};
						} else if (field.type === 'attachment') {
							const attachContainer = append(fieldGroup, $('.attachment-field-container.custom-field-input', {
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'display: flex; flex-direction: column; gap: 8px; border: 1.5px dashed rgba(16, 185, 129, 0.35); background: rgba(16, 185, 129, 0.03); border-radius: 8px; padding: 12px;'
							}));
							const fileListWrapper = append(attachContainer, $('.attachment-file-list', {
								style: 'display: flex; flex-wrap: wrap; gap: 8px;'
							}));
							const attachedFiles: IPendingFieldAttachment[] = [];
							customFieldInputs.push({ element: attachContainer, getAttachedFiles: () => attachedFiles });
							const fileInput = append(attachContainer, $('input', {
								type: 'file',
								multiple: 'multiple',
								style: 'display: none;'
							})) as HTMLInputElement;
							const renderFileList = () => {
								clearNode(fileListWrapper);
								if (attachedFiles.length === 0) {
									append(fileListWrapper, $('div', {
										style: 'font-size: 11px; opacity: 0.5; font-style: italic;'
									}, 'No attachments uploaded yet. Click or drop files below.'));
								} else {
									attachedFiles.forEach((f, idx) => {
										const pill = append(fileListWrapper, $('.attachment-pill', {
											style: 'display: flex; align-items: center; gap: 6px; padding: 4px 10px; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 14px; font-size: 11px;'
										}));
										append(pill, $('span' + ThemeIcon.asCSSSelector(Codicon.file), { style: 'font-size: 12px; color: #10b981;' }));
										append(pill, $('span', { style: 'max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }, f.name));
										const removeBtn = append(pill, $('span' + ThemeIcon.asCSSSelector(Codicon.close), { style: 'cursor: pointer; opacity: 0.6; font-size: 11px; margin-left: 2px;' }));
										removeBtn.onclick = (ev) => {
											ev.stopPropagation();
											attachedFiles.splice(idx, 1);
											renderFileList();
										};
									});
								}
							};
							renderFileList();
							const dropZone = append(attachContainer, $('.attachment-drop-target', {
								style: 'display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px; border-radius: 6px; background: rgba(0, 0, 0, 0.2); cursor: pointer; transition: all 0.2s;'
							}));
							append(dropZone, $('span' + ThemeIcon.asCSSSelector(Codicon.cloudUpload), { style: 'font-size: 16px; color: #10b981;' }));
							append(dropZone, $('span', { style: 'font-size: 11px; opacity: 0.8;' }, 'Click to browse or drop files here'));
							const handleFiles = (files: FileList | null) => {
								if (!files) { return; }
								for (let i = 0; i < files.length; i++) {
									const file = files[i];
									const reader = new FileReader();
									reader.onload = () => {
										attachedFiles.push({
											name: file.name,
											size: file.size,
											dataUrl: reader.result as string
										});
										renderFileList();
									};
									reader.readAsDataURL(file);
								}
							};
							fileInput.onchange = () => {
								handleFiles(fileInput.files);
								fileInput.value = '';
							};
							dropZone.onclick = () => fileInput.click();
						} else if (field.type === 'button_group') {
							const buttonsList: IActionButton[] = (field.buttons && Array.isArray(field.buttons) && field.buttons.length > 0)
								? field.buttons
								: [
									{ id: 'btn_1', label: 'Approve', color: '#10b981', targetStatus: 'Done' },
									{ id: 'btn_2', label: 'Reject', color: '#ef4444', targetStatus: 'Blocked' }
								];
							const btnGroupContainer = append(fieldGroup, $('.action-buttons-group-row.custom-field-input', {
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 4px 0;'
							}));
							let selectedActionLabel = '';
							let selectedTargetStatus = '';
							customFieldInputs.push({
								element: btnGroupContainer,
								getSelectedAction: () => selectedActionLabel,
								getSelectedTargetStatus: () => selectedTargetStatus
							});
							const renderButtons = () => {
								clearNode(btnGroupContainer);
								buttonsList.forEach(btn => {
									const btnColor = btn.color || '#3b82f6';
									const isSelected = selectedActionLabel === btn.label;
									const b = append(btnGroupContainer, $('button.ticket-action-transition-btn', {
										type: 'button',
										style: `--btn-accent-color: ${btnColor}; padding: 5px 12px; border-radius: 5px; font-size: 11px; cursor: pointer; border: 1px solid ${btnColor}; background: ${isSelected ? btnColor : 'transparent'}; color: ${isSelected ? '#ffffff' : btnColor};`
									}));
									append(b, $('span.action-btn-text', {}, btn.label));
									b.onclick = (e) => {
										e.preventDefault();
										e.stopPropagation();
										if (selectedActionLabel === btn.label) {
											selectedActionLabel = '';
											selectedTargetStatus = '';
										} else {
											selectedActionLabel = btn.label;
											selectedTargetStatus = btn.targetStatus || '';
										}
										renderButtons();
									};
								});
							};
							renderButtons();
						} else if (field.type === 'number') {
							const numWrapper = append(fieldGroup, $('div', {
								style: 'display: flex; align-items: center; gap: 8px;'
							}));
							const numberInput = append(numWrapper, $<HTMLInputElement>('input.monaco-inputbox.custom-field-input', {
								type: 'number',
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								...(typeof field.min === 'number' ? { min: String(field.min), 'data-min': String(field.min) } : {}),
								...(typeof field.max === 'number' ? { max: String(field.max), 'data-max': String(field.max) } : {}),
								...(typeof field.precision === 'number' ? { 'data-precision': String(field.precision) } : {}),
								step: (field.precision !== undefined && field.precision > 0) ? (1 / Math.pow(10, field.precision)).toString() : 'any',
								placeholder: field.precision !== undefined && field.precision > 0 ? (0).toFixed(field.precision) : '0',
								style: 'flex: 1; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
							}));
							customFieldInputs.push({ element: numberInput, valueInput: numberInput });
							if (field.unit) {
								append(numWrapper, $('span.number-unit-badge', {
									style: 'font-size: 11px; padding: 5px 8px; border-radius: 4px; background: rgba(234, 179, 8, 0.15); color: #facc15; border: 1px solid rgba(234, 179, 8, 0.3); font-weight: 600;'
								}, field.unit));
							}
						} else if (field.type === 'browser') {
							const browserBox = append(fieldGroup, $('.browser-field-container.custom-field-input', {
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'display: flex; flex-direction: column; gap: 8px; border: 1px solid rgba(56, 189, 248, 0.25); background: rgba(56, 189, 248, 0.03); border-radius: 8px; padding: 10px 12px;'
							}));
							const urlRow = append(browserBox, $('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }));
							append(urlRow, $('label', { style: 'font-size: 10.5px; opacity: 0.8; font-weight: 500;' }, 'Target URL:'));
							const urlInput = append(urlRow, $('input.monaco-inputbox.browser-url-input', {
								placeholder: 'https://example.com...',
								value: field.defaultUrl || '',
								style: 'width: 100%; padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color: #fff; box-sizing: border-box;'
							})) as HTMLInputElement;
							const creds = field.credentials || [];
							const getBrowserData = () => ({
								url: urlInput.value.trim(),
								credentials: creds,
								content: field.defaultContent || '',
								lastFetched: field.defaultContent ? 'Initialized from Schema' : ''
							});
							customFieldInputs.push({ element: browserBox, getBrowserData });
						} else if (field.type === 'prompt') {
							const promptBox = append(fieldGroup, $('.prompt-field-container.custom-field-input', {
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'display: flex; flex-direction: column; gap: 8px; border: 1px solid rgba(59, 130, 246, 0.25); background: rgba(59, 130, 246, 0.04); border-radius: 8px; padding: 10px 12px;'
							}));
							const targetDesc = field.targetMode === 'agent'
								? `Agent: ${field.targetAgentName || field.targetAgentId || 'Default'}`
								: `Model: ${field.targetModel || resolveDefaultModelId(field.targetProvider, 'gemini-2.5-flash')}`;
							const topRow = append(promptBox, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px;' }));
							append(topRow, $('span', { style: 'font-size: 10.5px; opacity: 0.85; font-weight: 600; color: #60a5fa;' }, `AI Instruction (${targetDesc})`));

							const preInjectedText = field.defaultContent || '';
							const isPreInjectedVisible = Boolean(field.promptPreInjectedVisible);

							if (isPreInjectedVisible) {
								const preInjectedContainer = append(promptBox, $('div', {
									style: 'display: flex; flex-direction: column; gap: 5px; padding: 8px 10px; border-radius: 6px; background: rgba(59, 130, 246, 0.05); border: 1px solid rgba(59, 130, 246, 0.22);'
								}));
								const preHeader = append(preInjectedContainer, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 6px;' }));
								append(preHeader, $('span', { style: 'font-size: 10.5px; font-weight: 600; color: #60a5fa;' }, 'Pre-Injected Prompt (Template Instruction):'));
								const preTextarea = append(preInjectedContainer, $('textarea.monaco-inputbox', {
									readonly: 'readonly',
									rows: 5,
									style: 'width: 100%; min-height: 118px; padding: 8px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color: #cbd5e1; box-sizing: border-box; line-height: 1.45; resize: vertical; opacity: 0.9;'
								})) as HTMLTextAreaElement;
								preTextarea.value = preInjectedText;
							}

							const userInputContainer = append(promptBox, $('div', {
								style: 'display: flex; flex-direction: column; gap: 4px;'
							}));
							append(userInputContainer, $('span', { style: 'font-size: 10.5px; font-weight: 600; color: #60a5fa;' }, 'User Prompt / Instructions:'));
							const promptTextarea = append(userInputContainer, $('textarea.monaco-inputbox.prompt-text-input', {
								placeholder: 'Enter your prompt or custom instructions here...',
								rows: 5,
								style: 'width: 100%; min-height: 118px; padding: 8px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: #fff; box-sizing: border-box; line-height: 1.45; resize: vertical;'
							})) as HTMLTextAreaElement;
							promptTextarea.value = field.defaultUserPrompt || '';

							const getPromptData = () => {
								const userPromptVal = promptTextarea.value.trim();
								const preTrimmed = preInjectedText.trim();
								const combinedPrompt = (preTrimmed && userPromptVal)
									? `${preTrimmed}\n\n--- User Prompt / Instructions ---\n${userPromptVal}`
									: (preTrimmed || userPromptVal);
								return {
									userPrompt: userPromptVal,
									preInjectedPrompt: preInjectedText,
									prompt: combinedPrompt,
									targetMode: field.targetMode || 'model',
									targetProvider: field.targetProvider || (field.targetModel ? '' : (getGlobalDefaultModel()?.providerId || '')),
									targetModel: field.targetModel || resolveDefaultModelId(field.targetProvider, 'gemini-2.5-flash'),
									targetAgentId: field.targetAgentId || '',
									targetAgentName: field.targetAgentName || '',
									output: '',
									lastExecuted: ''
								};
							};
							customFieldInputs.push({ element: promptBox, getPromptData });
						} else if (field.type === 'tts') {
							const ttsBox = append(fieldGroup, $('.tts-field-container.custom-field-input', {
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'display: flex; flex-direction: column; gap: 8px; border: 1px solid rgba(236, 72, 153, 0.25); background: rgba(236, 72, 153, 0.04); border-radius: 8px; padding: 10px 12px;'
							}));
							const topRow = append(ttsBox, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px;' }));
							append(topRow, $('span', { style: 'font-size: 10.5px; opacity: 0.9; font-weight: 600; color: #f472b6;' }, `1. AI Model & Speech Synthesis Script (${field.targetModel || 'gemini-2.5-flash-preview-tts'} · ${(field.ttsFormat || 'mp3').toUpperCase()})`));
							const ttsTextarea = append(ttsBox, $('textarea.monaco-inputbox.tts-text-input', {
								placeholder: 'Pure speech synthesis script sent to the TTS model...',
								rows: 2,
								style: 'width: 100%; padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(236, 72, 153, 0.3); background: rgba(0,0,0,0.25); color: #fff; box-sizing: border-box; line-height: 1.4;'
							})) as HTMLTextAreaElement;
							ttsTextarea.value = field.defaultContent || '';
							const displayRow = append(ttsBox, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 2px;' }));
							append(displayRow, $('span', { style: 'font-size: 10.5px; opacity: 0.9; font-weight: 600; color: #38bdf8;' }, '2. Reading Content & Study Notes'));
							const ttsDisplayTextarea = append(ttsBox, $('textarea.monaco-inputbox.tts-display-text-input', {
								placeholder: 'Reading content & study notes shown in the ticket...',
								rows: 3,
								style: 'width: 100%; padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.3); background: rgba(0,0,0,0.25); color: #fff; box-sizing: border-box; line-height: 1.4;'
							})) as HTMLTextAreaElement;
							ttsDisplayTextarea.value = field.ttsDisplayText || '';
							const getTtsData = () => ({
								text: ttsTextarea.value.trim(),
								displayText: ttsDisplayTextarea.value.trim(),
								ttsShowSpeechTextInTicket: Boolean(field.ttsShowSpeechTextInTicket),
								targetCredentialId: field.targetCredentialId || '',
								targetProvider: field.targetProvider || 'gemini',
								targetModel: field.targetModel || 'gemini-2.5-flash-preview-tts',
								ttsFormat: field.ttsFormat || 'mp3',
								ttsVoice: field.ttsVoice || 'Kore',
								ttsAutoPlay: Boolean(field.ttsAutoPlay),
								audioFileName: '',
								audioRelativePath: '',
								lastGenerated: '',
								lastSynthesizedText: ''
							});
							customFieldInputs.push({ element: ttsBox, getTtsData });
						} else if (field.type === 'python') {
							const pyBox = append(fieldGroup, $('.python-field-container.custom-field-input', {
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'display: flex; flex-direction: column; gap: 8px; border: 1px solid rgba(234, 179, 8, 0.25); background: rgba(234, 179, 8, 0.04); border-radius: 8px; padding: 10px 12px;'
							}));
							const pyTextarea = append(pyBox, $('textarea.monaco-inputbox.python-code-input', {
								placeholder: '# Python source code...',
								rows: 3,
								style: 'width: 100%; padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color: #fff; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace); line-height: 1.4;'
							})) as HTMLTextAreaElement;
							pyTextarea.value = field.defaultContent || '';
							pyTextarea.onkeydown = (e) => {
								if (isCommentKeybinding(e)) {
									e.preventDefault();
									e.stopPropagation();
									togglePythonComment(pyTextarea);
								}
							};
							const getPythonData = () => ({
								code: pyTextarea.value,
								pythonPath: field.pythonPath || '',
								externalScripts: field.externalScripts || [],
								output: '',
								logs: '',
								lastExecuted: ''
							});
							customFieldInputs.push({ element: pyBox, getPythonData });
						} else {
							const textInput = append(fieldGroup, $<HTMLInputElement>('input.monaco-inputbox.custom-field-input', {
								type: 'text',
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
							}));
							customFieldInputs.push({ element: textInput, valueInput: textInput });
						}
					}

					customFieldsBox.style.display = renderedCount > 0 ? 'flex' : 'none';
				} else {
					clearNode(customFieldsBox);
					customFieldInputs = [];
					customFieldsBox.style.display = 'none';
				}
			} catch {
				// ignore
			}
		};

		modulesListener = customModulesService.onDidChangeModules(() => {
			renderAgentTemplateFields();
		});

		const refreshTicketIdPreview = async () => {
			if (existingAgent) {
				const resolvedId = existingAgent.ticketId || existingAgent.folderPath?.split('/').filter(Boolean).pop() || existingAgent.name;
				previewBadge.innerText = `Ticket ID: ${resolvedId} (${existingAgent.scopeName})`;
				return;
			}
			try {
				const rawPath = locationInput.value.trim();
				const matchedWs = resolveTargetWorkspace(rawPath ? URI.file(rawPath) : undefined);
				if (matchedWs) {
					const seq = await workspacesExplorerService.generateNextSequentialName(matchedWs.uri, 'agent');
					previewBadge.innerText = `Generated Ticket ID: ${seq.name} (Workspace Code: ${seq.code})`;
				} else {
					previewBadge.innerText = 'No Ticket ID: choose a folder inside a workspace to create an agent';
				}
			} catch {
				previewBadge.innerText = 'Generated Ticket ID: AUTO';
			}
		};

		const updateLocationAndPreview = async () => {
			await refreshTicketIdPreview();
			await renderAgentTemplateFields();
		};

		selectDest.onchange = () => {
			if (selectDest.value === 'independent') {
				locationInput.value = '';
			} else {
				const wsUri = URI.parse(selectDest.value);
				locationInput.value = wsUri.fsPath;
			}
			updateLocationAndPreview();
		};

		browseBtn.onclick = async () => {
			const res = await fileDialogService.showOpenDialog({
				canSelectFolders: true,
				canSelectFiles: false,
				canSelectMany: false,
				defaultUri: locationInput.value.trim() ? URI.file(locationInput.value.trim()) : await fileDialogService.defaultFolderPath(),
				title: 'Select Storage Location for AI Agent'
			});
			if (res && res.length > 0) {
				locationInput.value = res[0].fsPath;
				await updateLocationAndPreview();
			}
		};

		locationInput.oninput = () => {
			updateLocationAndPreview();
		};

		updateLocationAndPreview();

		// 12. Modal Footer Actions
		const footerRow = append(modal, $('.modal-footer'));
		footerRow.style.display = 'flex';
		footerRow.style.justifyContent = 'flex-end';
		footerRow.style.gap = '12px';
		footerRow.style.marginTop = '10px';

		const cancelBtn = append(footerRow, $('button.monaco-button', {
			style: 'padding: 8px 18px; font-size: 12px; font-family: inherit; border-radius: 6px; cursor: pointer; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: inherit;'
		}));
		cancelBtn.innerText = 'Cancel';
		cancelBtn.onclick = () => closeModal(undefined);

		const submitBtn = append(footerRow, $('button.monaco-button', {
			style: 'padding: 8px 22px; font-size: 12px; font-family: inherit; font-weight: 600; border-radius: 6px; cursor: pointer; background: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, #ffffff); border: none;'
		}));
		submitBtn.innerText = existingAgent ? 'Save Changes' : 'Create AI Agent';

		const openInstructionPreview = async (folderPath: string) => {
			const instructionUri = URI.file(`${folderPath}/.agents/instruction.md`);
			try {
				await commandService.executeCommand('markdown.showPreview', instructionUri);
			} catch {
				await openerService.open(instructionUri);
			}
		};

		const focusTargetPane = (scopeType: AgentScopeType) => {
			const targetPaneId = scopeType === 'none'
				? 'workbench.view.agentsManager.standalone'
				: 'workbench.view.agentsManager.workspace';
			agentsService.notifyPaneExpanded(targetPaneId);
		};

		submitBtn.onclick = async () => {
			const nameVal = nameInput.value.trim();
			const roleVal = roleInput.value.trim();
			const promptVal = promptInput.value.trim();

			if (!nameVal) {
				notificationService.warn('Please enter an Agent Title.');
				nameInput.focus();
				return;
			}
			if (!roleVal) {
				notificationService.warn('Please enter a Role Description.');
				roleInput.focus();
				return;
			}
			if (!promptVal) {
				notificationService.warn('Please enter System Prompt instructions.');
				promptInput.focus();
				return;
			}

			// 1. Resolve Model Reference (providerId, modelId, credentialId)
			let selectedModel = modelInput.value.trim();
			// Normalize any Unicode non-standard dashes to standard ASCII hyphen
			selectedModel = selectedModel.replace(/[\u2013\u2014\u2015\u2212\uFF0D]/g, '-');
			if (!selectedModel) {
				notificationService.warn('Please enter an AI Model ID.');
				modelInput.focus();
				return;
			}

			let providerIdVal = 'gemini';
			let modelIdVal = selectedModel;
			let credentialIdVal: string | undefined = undefined;

			if (credSelect.value === 'none') {
				notificationService.warn('Please configure and select an API Connection Credential first.');
				credSelect.focus();
				return;
			}

			if (credSelect.value !== 'default' && credSelect.value !== 'none') {
				credentialIdVal = credSelect.value;
				const cred = savedCredentials.find(c => c.id === credentialIdVal);
				if (cred) {
					providerIdVal = cred.providerId;
				}
			}

			if (selectedModel.includes('/')) {
				const parts = selectedModel.split('/');
				providerIdVal = parts[0];
				modelIdVal = parts[1];
			} else {
				if (credSelect.value === 'default' || credSelect.value === 'none') {
					providerIdVal = selectedModel.startsWith('gpt') ? 'openai' : selectedModel.startsWith('claude') ? 'anthropic' : 'gemini';
				}
			}

			const modelRef: IAgentModelReference = {
				providerId: providerIdVal,
				modelId: modelIdVal,
				credentialId: credentialIdVal
			};

			if (existingAgent) {
				const updatedAgent: IAgentItem = {
					...existingAgent,
					name: nameVal,
					title: nameVal,
					role: roleVal,
					systemPrompt: promptVal,
					model: modelRef,
					updatedAt: Date.now()
				};

				await agentsService.updateAgent(updatedAgent);
				notificationService.info(`AI Agent '${nameVal}' updated successfully!`);

				focusTargetPane(existingAgent.scopeType);

				if (updatedAgent.folderPath) {
					try {
						await editorService.openEditor(new EntityDetailEditorInput(URI.file(updatedAgent.folderPath), nameVal), { pinned: true });
					} catch {
						await openInstructionPreview(updatedAgent.folderPath);
					}
				}
				closeModal(updatedAgent);
				return;
			}

			// Creating a new AI Agent using the unified Ticket ID / sequence / 4-MD pipeline
			const rawPath = locationInput.value.trim();
			const locationUri = rawPath ? URI.file(rawPath) : undefined;
			const matchedWs = resolveTargetWorkspace(locationUri);
			if (!locationUri || !matchedWs) {
				// No global agents (CI-26): a new agent always lives inside a workspace
				notificationService.warn('A new AI Agent must be created inside a workspace. Choose a workspace, or a folder inside one, as the storage location.');
				return;
			}

			let initialStatusOverride = '';
			const customMetadata: { [key: string]: string } = {};
			const allPendingFieldAttachments: IPendingFieldAttachment[] = [];
			const numberErrors: string[] = [];
			customFieldInputs.forEach(fieldRefs => {
				const inputEl = fieldRefs.element;
				const fieldLabel = inputEl.getAttribute('data-field-label');
				if (fieldLabel) {
					if (isHTMLInputElement(inputEl) && inputEl.getAttribute('data-field-type') === 'number') {
						const numCheck = normalizeNumberFieldValue(numberFieldRulesFromAttributes(n => inputEl.getAttribute(n), fieldLabel), inputEl.value);
						if (!numCheck.ok) {
							numberErrors.push(numCheck.error!);
							return;
						}
						customMetadata[fieldLabel] = numCheck.value;
						return;
					}
					if (isHTMLInputElement(inputEl) && inputEl.type === 'checkbox') {
						customMetadata[fieldLabel] = inputEl.checked ? 'true' : 'false';
					} else if (inputEl.classList.contains('multiselect-container')) {
						const checked = (fieldRefs.checkboxes ?? []).filter(cb => cb.checked).map(cb => cb.value);
						customMetadata[fieldLabel] = checked.join(', ');
					} else if (inputEl.classList.contains('range-container')) {
						const startVal = fieldRefs.rangeStart?.value || '';
						const endVal = fieldRefs.rangeEnd?.value || '';
						customMetadata[fieldLabel] = (startVal || endVal) ? `${startVal} ~ ${endVal}` : '';
					} else if (inputEl.classList.contains('dynamic-list-container')) {
						const items: Array<Record<string, string | number>> = [];
						(fieldRefs.itemCards ?? []).forEach((cardRefs, idx) => {
							const itemObj: Record<string, string | number> = { _index: idx + 1 };
							const titleInputEl = cardRefs.titleInput;
							if (titleInputEl && titleInputEl.value.trim()) {
								itemObj._title = titleInputEl.value.trim();
							}
							cardRefs.subInputs.forEach(subEl => {
								const subLabel = subEl.getAttribute('data-subfield-label');
								if (subLabel) {
									if (isHTMLInputElement(subEl) && subEl.type === 'checkbox') {
										itemObj[subLabel] = subEl.checked ? 'true' : 'false';
									} else {
										itemObj[subLabel] = subEl.value || '';
									}
								}
							});
							items.push(itemObj);
						});
						customMetadata[fieldLabel] = JSON.stringify(items);
					} else if (inputEl.classList.contains('attachment-field-container')) {
						const getFiles = fieldRefs.getAttachedFiles;
						const filesList: IPendingFieldAttachment[] = getFiles ? getFiles() : [];
						customMetadata[fieldLabel] = filesList.length > 0 ? JSON.stringify(filesList.map(f => ({ name: f.name, size: f.size }))) : '';
						filesList.forEach(f => {
							allPendingFieldAttachments.push(f);
						});
					} else if (inputEl.classList.contains('action-buttons-group-row')) {
						const getAction = fieldRefs.getSelectedAction;
						const chosenAction = getAction ? getAction() : '';
						customMetadata[fieldLabel] = chosenAction;
						const getTargetStatus = fieldRefs.getSelectedTargetStatus;
						const targetSt = getTargetStatus ? getTargetStatus() : '';
						if (targetSt) {
							initialStatusOverride = targetSt;
						}
					} else if (inputEl.classList.contains('browser-field-container')) {
						const getBData = fieldRefs.getBrowserData;
						const bData = getBData ? getBData() : { url: '', credentials: [] };
						customMetadata[fieldLabel] = JSON.stringify(bData);
					} else if (inputEl.classList.contains('prompt-field-container')) {
						const getPData = fieldRefs.getPromptData;
						const pData = getPData ? getPData() : { prompt: '', targetMode: 'model' };
						customMetadata[fieldLabel] = JSON.stringify(pData);
					} else if (inputEl.classList.contains('tts-field-container')) {
						const getTData = fieldRefs.getTtsData;
						const tData = getTData ? getTData() : { text: '', ttsFormat: 'mp3' };
						customMetadata[fieldLabel] = JSON.stringify(tData);
					} else if (inputEl.classList.contains('python-field-container')) {
						const getPyData = fieldRefs.getPythonData;
						const pyData = getPyData ? getPyData() : { code: '', pythonPath: '' };
						customMetadata[fieldLabel] = JSON.stringify(pyData);
					} else {
						customMetadata[fieldLabel] = fieldRefs.valueInput?.value || '';
					}
				}
			});
			if (numberErrors.length > 0) {
				notificationService.warn(numberErrors.join(' '));
				return;
			}

			const gitRepoUrl = gitRemoteInput.value.trim() || undefined;
			const gitBranch = gitBranchInput.value.trim() || undefined;
			const hasCustomSchema = !!(activeAgentModule && activeAgentModule.fields && activeAgentModule.fields.length > 0);
			const defFile = activeAgentModule?.definitionFile;
			const modDesc = typeof activeAgentModule?.description === 'string' ? activeAgentModule.description.trim() : '';
			const resolvedTypeDef = hasCustomSchema ? (defFile || '.agents/entity_type/agent.yaml') : (defFile || modDesc || undefined);
			const resolvedTypePrompt = (typeof activeAgentModule?.prompt === 'string' && activeAgentModule.prompt.trim())
				? activeAgentModule.prompt.trim()
				: 'An AI Agent is a specialized autonomous assistant with a dedicated role, LLM model, and system prompt.';

			try {
				const wsRootUri = matchedWs.uri;
				if (activeAgentModule && hasCustomSchema) {
					const localYamlUri = URI.joinPath(wsRootUri, '.agents', 'entity_type', 'agent.yaml');
					const yamlContent = stringifyYaml({ ...activeAgentModule, storageScope: 'workspace' });
					await fileService.writeFile(localYamlUri, VSBuffer.fromString(yamlContent));
				}

				const normLoc = locationUri.path.replace(/\/+$/, '');
				const normWs = wsRootUri.path.replace(/\/+$/, '');
				const isSubFolder = normLoc !== normWs && normLoc.startsWith(normWs + '/');

				const wsStatuses = await workspacesExplorerService.getWorkspaceStatuses(wsRootUri);
				const initialStatus = initialStatusOverride || (wsStatuses.statuses[0] || 'Todo');

				const createRes = await workspacesExplorerService.createResourceUnderWorkspace({
					workspaceUri: wsRootUri,
					targetParentUri: isSubFolder ? locationUri : undefined,
					type: 'agent',
					name: 'AUTO',
					title: nameVal,
					status: initialStatus,
					description: roleVal,
					agentModel: modelRef,
					agentSystemPrompt: promptVal,
					typeDefinition: resolvedTypeDef,
					typePrompt: resolvedTypePrompt,
					gitRepoUrl,
					gitBranch,
					customMetadata: Object.keys(customMetadata).length > 0 ? customMetadata : undefined
				});

				const createdFolderUri = createRes.uri.path.endsWith('/.agents/ticket.md')
					? dirname(dirname(createRes.uri))
					: createRes.uri;
				const resolvedTicketId = createdFolderUri.path.split('/').filter(Boolean).pop() || nameVal;

				if (allPendingFieldAttachments.length > 0) {
					const attachmentsDirUri = URI.joinPath(createdFolderUri, 'attachments');
					for (const fileObj of allPendingFieldAttachments) {
						if (fileObj.dataUrl) {
							try {
								const base64Idx = fileObj.dataUrl.indexOf(';base64,');
								if (base64Idx !== -1) {
									const base64Data = fileObj.dataUrl.substring(base64Idx + 8);
									const binaryStr = atob(base64Data);
									const bytes = new Uint8Array(binaryStr.length);
									for (let b = 0; b < binaryStr.length; b++) {
										bytes[b] = binaryStr.charCodeAt(b);
									}
									const destFileUri = URI.joinPath(attachmentsDirUri, fileObj.name);
									await fileService.writeFile(destFileUri, VSBuffer.wrap(bytes));
								}
							} catch {
								// ignore attachment write error
							}
						}
					}
				}

				const allAgents = await agentsService.getAgents();
				const createdAgent = allAgents.find(a => a.folderPath === createdFolderUri.fsPath) || allAgents.find(a => a.ticketId === resolvedTicketId);
				const finalScopeType: AgentScopeType = createdAgent ? createdAgent.scopeType : 'workspace';

				notificationService.info(`AI Agent '${nameVal}' (${resolvedTicketId}) created successfully!`);
				focusTargetPane(finalScopeType);
				closeModal(createdAgent);

				await editorService.openEditor(new EntityDetailEditorInput(createdFolderUri, nameVal), { pinned: true });
			} catch (err) {
				notificationService.error(`Failed to create AI Agent: ${err}`);
			}
		};

		// Focus title input on modal open
		setTimeout(() => nameInput.focus(), 50);
	});
}
