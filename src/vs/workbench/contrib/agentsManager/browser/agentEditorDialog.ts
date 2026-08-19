/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServicesAccessor, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IAgentsManagerService, IAgentItem, AgentScopeType, IAgentCredentialService, IAgentModelReference, IAgentCredential } from '../common/agentsManager.js';
import { AccountManagementDialog } from '../../accountManagement/browser/accountManagementDialog.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';

export async function createOrEditAgentDialog(
	accessor: ServicesAccessor,
	existingAgent?: IAgentItem,
	defaultScopeType: AgentScopeType = 'workspace',
	defaultScopeName: string = 'Workspace Global',
	targetFolderUri?: URI
): Promise<IAgentItem | undefined> {
	const agentsService = accessor.get(IAgentsManagerService);
	const credentialService = accessor.get(IAgentCredentialService);
	const languageModelsService = accessor.get(ILanguageModelsService);
	const notificationService = accessor.get(INotificationService);
	const fileDialogService = accessor.get(IFileDialogService);
	const openerService = accessor.get(IOpenerService);
	const commandService = accessor.get(ICommandService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);

	const savedCredentials = await credentialService.getCredentials();



	return new Promise<IAgentItem | undefined>(async (resolve) => {
		// 1. Remove any existing modal
		const existingModal = document.querySelector('.create-agent-modal-overlay');
		if (existingModal) {
			existingModal.remove();
		}

		// 2. Create Modal Overlay (Blur backdrop)
		const overlay = append(document.body, $('.create-agent-modal-overlay'));
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
		let docClickListener: (e: MouseEvent) => void;
		let credsListener: { dispose(): void } | undefined = undefined;
		const closeModal = (result?: IAgentItem) => {
			if (credsListener) {
				credsListener.dispose();
			}
			if (docClickListener) {
				document.removeEventListener('click', docClickListener);
			}
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
				style: 'display: block; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; color: var(--vscode-sideBarTitle-foreground, #cccccc); opacity: 0.9;'
			}, text);
		};

		// 5. Agent Title / Name
		const nameGroup = append(modal, $('.form-group'));
		append(nameGroup, createFormLabel('Agent Title:'));
		const nameInput = append(nameGroup, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 8px 12px; font-size: 12px; font-family: inherit; border-radius: 6px; border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15)); background: var(--vscode-input-background, #121212); color: inherit; box-sizing: border-box; outline: none;'
		})) as HTMLInputElement;
		nameInput.placeholder = 'e.g. System Architect Agent, UI Developer';
		nameInput.value = existingAgent?.name || '';

		// 6. Role & Description
		const roleGroup = append(modal, $('.form-group'));
		append(roleGroup, createFormLabel('Role & Description:'));
		const roleInput = append(roleGroup, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 8px 12px; font-size: 12px; font-family: inherit; border-radius: 6px; border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15)); background: var(--vscode-input-background, #121212); color: inherit; box-sizing: border-box; outline: none;'
		})) as HTMLInputElement;
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
			for (let i = 0; i < savedCredentials.length; i++) {
				const cred = savedCredentials[i];
				const displayName = cred.isEnabled !== false ? `${cred.name} (${cred.providerId})` : `${cred.name} (${cred.providerId}) [Disabled]`;
				const opt = append(credSelect, $('option', { value: cred.id }, displayName)) as HTMLOptionElement;
				if (cred.isEnabled === false) {
					opt.disabled = true;
				}
				if (existingAgent?.model?.credentialId === cred.id) {
					opt.selected = true;
				} else if (!existingAgent && i === 0 && cred.isEnabled !== false) {
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
			if (models.length === 0) return '';

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
				if (found) return found.id;
			}

			const chatKeywords = ['gpt', 'claude', 'gemini', 'chat', 'llama', 'mistral', 'deepseek', 'qwen', 'command-r'];
			const nonChatKeywords = ['embedding', 'whisper', 'tts', 'moderation', 'edit'];

			const chatModels = activeList.filter(m => {
				const idLower = m.id.toLowerCase();
				const isNonChat = nonChatKeywords.some(kw => idLower.includes(kw));
				if (isNonChat) return false;
				return chatKeywords.some(kw => idLower.includes(kw));
			});

			if (chatModels.length > 0) return chatModels[0].id;

			const generalCandidates = activeList.filter(m => {
				const idLower = m.id.toLowerCase();
				return !nonChatKeywords.some(kw => idLower.includes(kw));
			});

			if (generalCandidates.length > 0) return generalCandidates[0].id;
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
				modelInput.value = getSmartDefaultModel(availableModels, activeProv);
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

		docClickListener = (e: MouseEvent) => {
			if (e.target !== modelInput && !modelDropdown.contains(e.target as Node)) {
				modelDropdown.style.display = 'none';
			}
		};
		document.addEventListener('click', docClickListener);

		credSelect.onchange = () => {
			isFiltering = false;
			updateModelsList();
			renderFilteredDropdown();
		};
		updateModelsList();
		// 8. Agent Storage Location
		let selectedParentUri = targetFolderUri;

		// Default initial path
		const activeFolders = workspaceContextService.getWorkspace().folders;
		const defaultWorkspaceUri = activeFolders[0]?.uri;
		if (!selectedParentUri && defaultWorkspaceUri) {
			selectedParentUri = defaultWorkspaceUri;
		}

		const locationGroup = append(modal, $('.form-group'));
		append(locationGroup, createFormLabel('Agent Storage Location:'));

		const locationRow = append(locationGroup, $('.location-row'));
		locationRow.style.display = 'flex';
		locationRow.style.gap = '8px';

		const locationInput = append(locationRow, $('input.monaco-inputbox', {
			style: 'flex: 1; padding: 8px 12px; font-size: 12px; font-family: inherit; border-radius: 6px; border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15)); background: var(--vscode-input-background, #121212); color: inherit; box-sizing: border-box; outline: none;'
		})) as HTMLInputElement;

		if (existingAgent?.folderPath) {
			locationInput.value = existingAgent.folderPath;
		} else if (selectedParentUri) {
			locationInput.value = selectedParentUri.fsPath;
		}

		const browseBtn = append(locationRow, $('button.monaco-button', {
			style: 'padding: 8px 14px; font-size: 12px; font-family: inherit; border-radius: 6px; cursor: pointer; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: inherit; white-space: nowrap;'
		}));
		browseBtn.innerText = 'Browse...';
		browseBtn.onclick = async () => {
			const res = await fileDialogService.showOpenDialog({
				canSelectFolders: true,
				canSelectFiles: false,
				canSelectMany: false,
				title: 'Select Storage Location for AI Agent'
			});
			if (res && res.length > 0) {
				selectedParentUri = res[0];
				locationInput.value = res[0].fsPath;
			}
		};

		// 11. System Prompt Textarea (Large, Roomy Textarea)
		const promptGroup = append(modal, $('.form-group'));
		append(promptGroup, createFormLabel('System Prompt / Core Instructions:'));
		const promptInput = append(promptGroup, $('textarea.monaco-inputbox', {
			style: 'width: 100%; min-height: 140px; padding: 10px 12px; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); border-radius: 6px; border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15)); background: var(--vscode-input-background, #121212); color: inherit; box-sizing: border-box; outline: none; resize: vertical;'
		})) as HTMLTextAreaElement;
		promptInput.placeholder = 'e.g. You are the Lead Architect. Maintain modular design, clear contracts, and update instruction.md files...';
		promptInput.value = existingAgent?.systemPrompt || '';

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
			const paneScopeMap: Record<AgentScopeType, string> = {
				workspace: 'workbench.view.agentsManager.workspace',
				project: 'workbench.view.agentsManager.project',
				job: 'workbench.view.agentsManager.job',
				workflow: 'workbench.view.agentsManager.workflow',
				none: 'workbench.view.agentsManager.standalone'
			};
			const targetPaneId = paneScopeMap[scopeType] || 'workbench.view.agentsManager.all';
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

			const scopeVal = existingAgent ? existingAgent.scopeType : 'none';
			const scopeNameVal = existingAgent ? existingAgent.scopeName : 'Standalone';
			const scopeIdVal = existingAgent ? existingAgent.scopeId : 'none';

			// Sync locationInput value if custom
			if (locationInput.value.trim()) {
				selectedParentUri = URI.file(locationInput.value.trim());
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
					role: roleVal,
					systemPrompt: promptVal,
					model: modelRef,
					scopeType: scopeVal,
					scopeId: scopeIdVal,
					scopeName: scopeNameVal,
					updatedAt: Date.now()
				};

				await agentsService.updateAgent(updatedAgent);
				notificationService.info(`AI Agent '${nameVal}' updated successfully!`);

				// 1. Auto-expand target view pane
				focusTargetPane(scopeVal);

				// 2. Open Markdown rendered preview
				if (updatedAgent.folderPath) {
					await openInstructionPreview(updatedAgent.folderPath);
				}
				closeModal(updatedAgent);
			} else {
				const createdAgent = await agentsService.addAgent({
					name: nameVal,
					role: roleVal,
					systemPrompt: promptVal,
					model: modelRef,
					scopeType: scopeVal,
					scopeId: scopeIdVal,
					scopeName: scopeNameVal,
					avatarIcon: 'robot',
					status: 'idle',
					description: `${roleVal} - Powered by ${modelIdVal} (${scopeNameVal})`
				}, selectedParentUri);

				notificationService.info(`AI Agent '${nameVal}' created successfully!`);

				// 1. Auto-expand target view pane
				focusTargetPane(scopeVal);

				// 2. Open Markdown rendered preview
				if (createdAgent.folderPath) {
					await openInstructionPreview(createdAgent.folderPath);
				}
				closeModal(createdAgent);
			}
		};

		// Focus title input on modal open
		setTimeout(() => nameInput.focus(), 50);
	});
}
