/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IAgentsManagerService, IAgentItem, AgentScopeType } from '../common/agentsManager.js';

export async function createOrEditAgentDialog(
	accessor: ServicesAccessor,
	existingAgent?: IAgentItem,
	defaultScopeType: AgentScopeType = 'workspace',
	defaultScopeName: string = 'Workspace Global',
	targetFolderUri?: URI
): Promise<IAgentItem | undefined> {
	const agentsService = accessor.get(IAgentsManagerService);
	const notificationService = accessor.get(INotificationService);
	const fileDialogService = accessor.get(IFileDialogService);
	const openerService = accessor.get(IOpenerService);
	const commandService = accessor.get(ICommandService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);

	return new Promise<IAgentItem | undefined>((resolve) => {
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
		const closeModal = (result?: IAgentItem) => {
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

		// 7. AI Model Platform Selection Dropdown
		const modelGroup = append(modal, $('.form-group'));
		append(modelGroup, createFormLabel('AI Model:'));
		const modelSelect = append(modelGroup, $('select.monaco-select', {
			style: 'width: 100%; padding: 8px 12px; font-size: 12px; font-family: inherit; border-radius: 6px; border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15)); background: var(--vscode-input-background, #121212); color: inherit; box-sizing: border-box; outline: none; cursor: pointer;'
		})) as HTMLSelectElement;

		const models = [
			{ id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (Recommended)' },
			{ id: 'gemini-2.0-pro-exp', label: 'Gemini 2.0 Pro Experimental' },
			{ id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
			{ id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
			{ id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' },
			{ id: 'gpt-4o', label: 'GPT-4o' }
		];

		for (const m of models) {
			const opt = append(modelSelect, $('option', { value: m.id }, m.label)) as HTMLOptionElement;
			if ((existingAgent?.modelName || 'gemini-2.0-flash') === m.id) {
				opt.selected = true;
			}
		}

		// 8. Work For (Scope Selection)
		const scopeGroup = append(modal, $('.form-group'));
		append(scopeGroup, createFormLabel('Work For:'));
		const scopeSelect = append(scopeGroup, $('select.monaco-select', {
			style: 'width: 100%; padding: 8px 12px; font-size: 12px; font-family: inherit; border-radius: 6px; border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15)); background: var(--vscode-input-background, #121212); color: inherit; box-sizing: border-box; outline: none; cursor: pointer;'
		})) as HTMLSelectElement;

		const scopes: { id: AgentScopeType; label: string }[] = [
			{ id: 'workspace', label: 'Workspace' },
			{ id: 'project', label: 'Project' },
			{ id: 'job', label: 'Job' },
			{ id: 'workflow', label: 'Workflow' },
			{ id: 'none', label: 'Standalone' }
		];

		for (const s of scopes) {
			const opt = append(scopeSelect, $('option', { value: s.id }, s.label)) as HTMLOptionElement;
			if ((existingAgent?.scopeType || defaultScopeType) === s.id) {
				opt.selected = true;
			}
		}

		// 9. Secondary Entity Selector Dropdown (Dynamic for Workspace, Project, Job, Workflow)
		const entityGroup = append(modal, $('.form-group'));
		const entityLabel = append(entityGroup, createFormLabel('Target Item:'));
		const entitySelect = append(entityGroup, $('select.monaco-select', {
			style: 'width: 100%; padding: 8px 12px; font-size: 12px; font-family: inherit; border-radius: 6px; border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15)); background: var(--vscode-input-background, #121212); color: inherit; box-sizing: border-box; outline: none; cursor: pointer;'
		})) as HTMLSelectElement;

		// 10. Target Directory Location Row
		let selectedParentUri = targetFolderUri;

		// Default initial path
		const activeFolders = workspaceContextService.getWorkspace().folders;
		const defaultWorkspaceUri = activeFolders[0]?.uri;
		if (!selectedParentUri && defaultWorkspaceUri) {
			selectedParentUri = defaultWorkspaceUri;
		}

		const locationGroup = append(modal, $('.form-group'));
		append(locationGroup, createFormLabel('Target Directory:'));

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
				title: 'Select Target Directory for AI Agent'
			});
			if (res && res.length > 0) {
				selectedParentUri = res[0];
				locationInput.value = res[0].fsPath;
			}
		};

		// Function to update Secondary Entity Options and Auto-Update Location
		const updateSecondarySelector = () => {
			clearNode(entitySelect);
			const selectedScope = scopeSelect.value as AgentScopeType;

			if (selectedScope === 'none') {
				entityGroup.style.display = 'none';
				return;
			}

			entityGroup.style.display = 'block';

			if (selectedScope === 'workspace') {
				entityLabel.textContent = 'Target Workspace:';
				const folders = workspaceContextService.getWorkspace().folders;
				if (folders.length === 0) {
					append(entitySelect, $('option', { value: 'Workspace Global' }, 'Workspace Global'));
				} else {
					for (const folder of folders) {
						const opt = append(entitySelect, $('option', { value: folder.name, 'data-path': folder.uri.fsPath }, folder.name)) as HTMLOptionElement;
						if (existingAgent?.scopeName === folder.name) {
							opt.selected = true;
						}
					}
				}
			} else if (selectedScope === 'project') {
				entityLabel.textContent = 'Target Project:';
				const projects = [
					{ name: 'Any-Agent Desktop', path: '/Users/aimery/repos/any_agent/desktop' },
					{ name: 'Celpip Backend', path: '/Users/aimery/repos/celpip/backend' },
					{ name: 'Fino3 Mobile', path: '/Users/aimery/repos/fino3/mobile' }
				];
				for (const p of projects) {
					const opt = append(entitySelect, $('option', { value: p.name, 'data-path': p.path }, p.name)) as HTMLOptionElement;
					if (existingAgent?.scopeName === p.name) {
						opt.selected = true;
					}
				}
			} else if (selectedScope === 'job') {
				entityLabel.textContent = 'Target Job:';
				const jobs = [
					{ name: 'any_agent_202607 Job', path: '/Users/aimery/repos/jobs/any_agent_202607' },
					{ name: 'celpip_study_202607 Job', path: '/Users/aimery/repos/jobs/celpip_english_learning' }
				];
				for (const j of jobs) {
					const opt = append(entitySelect, $('option', { value: j.name, 'data-path': j.path }, j.name)) as HTMLOptionElement;
					if (existingAgent?.scopeName === j.name) {
						opt.selected = true;
					}
				}
			} else if (selectedScope === 'workflow') {
				entityLabel.textContent = 'Target Workflow:';
				const workflows = ['CI/CD Build Pipeline', 'Post-Market Stock Sync', 'Daily Test Runner'];
				for (const wf of workflows) {
					const opt = append(entitySelect, $('option', { value: wf }, wf)) as HTMLOptionElement;
					if (existingAgent?.scopeName === wf) {
						opt.selected = true;
					}
				}
			}
		};

		scopeSelect.onchange = () => {
			updateSecondarySelector();
			// Auto update directory path if matching option selected
			const selectedOpt = entitySelect.options[entitySelect.selectedIndex];
			const path = selectedOpt?.getAttribute('data-path');
			if (path) {
				selectedParentUri = URI.file(path);
				locationInput.value = path;
			}
		};

		entitySelect.onchange = () => {
			const selectedOpt = entitySelect.options[entitySelect.selectedIndex];
			const path = selectedOpt?.getAttribute('data-path');
			if (path) {
				selectedParentUri = URI.file(path);
				locationInput.value = path;
			}
		};

		updateSecondarySelector();

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
			const instructionUri = URI.file(`${folderPath}/instruction.md`);
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

			const modelVal = modelSelect.value;
			const scopeVal = scopeSelect.value as AgentScopeType;
			let scopeNameVal = 'Standalone';
			if (scopeVal !== 'none' && entitySelect.value) {
				scopeNameVal = entitySelect.value;
			}

			const scopeIdVal = `${scopeVal}-${scopeNameVal.toLowerCase().replace(/\s+/g, '-')}`;

			// Sync locationInput value if custom
			if (locationInput.value.trim()) {
				selectedParentUri = URI.file(locationInput.value.trim());
			}

			if (existingAgent) {
				const updatedAgent: IAgentItem = {
					...existingAgent,
					name: nameVal,
					role: roleVal,
					systemPrompt: promptVal,
					modelName: modelVal,
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
					modelName: modelVal,
					scopeType: scopeVal,
					scopeId: scopeIdVal,
					scopeName: scopeNameVal,
					avatarIcon: 'robot',
					status: 'idle',
					description: `${roleVal} - Powered by ${modelVal} (${scopeNameVal})`
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
