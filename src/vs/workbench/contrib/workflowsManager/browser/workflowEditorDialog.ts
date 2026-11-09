/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEntityPersistenceService, ICustomModule, IActionButton } from '../../entityPersistence/common/entityPersistence.js';
import { IWorkspacesExplorerService } from '../../workspacesExplorer/common/workspacesExplorer.js';
import { IWorkflowsManagerService } from '../common/workflowsManager.js';
import { ICustomModulesService } from '../../customModules/common/customModules.js';
import { stringifyYaml } from '../../customModules/browser/customModulesService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { WORKSPACE_PANE_VIEW_ID } from '../../workspacesExplorer/common/workspacesExplorer.js';
import { WorkspacesExplorerPane } from '../../workspacesExplorer/browser/workspacesExplorerPane.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname } from '../../../../base/common/resources.js';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { WorkflowEditorInput } from './workflowEditorInput.js';

const DEFAULT_WORKFLOWS_DIR = '/Users/aimery/Documents/workflows';

interface IWorkflowProbeResult {
	isExisting: boolean;
	name?: string;
	description?: string;
}

async function probeWorkflowDirectory(fileService: IFileService, dirUri: URI): Promise<IWorkflowProbeResult> {
	try {
		const exists = await fileService.exists(dirUri);
		if (!exists) {
			return { isExisting: false };
		}

		const mainWorkflowMd = URI.joinPath(dirUri, '.agents', 'workflow.md');
		const flowchartJson = URI.joinPath(dirUri, '.agents', 'workflow_flowchart.json');
		const legacyWorkflowMd = URI.joinPath(dirUri, 'workflow.md');

		const hasMainMd = await fileService.exists(mainWorkflowMd);
		const hasFlowchart = await fileService.exists(flowchartJson);
		const hasLegacyMd = await fileService.exists(legacyWorkflowMd);

		if (hasMainMd || hasFlowchart || hasLegacyMd) {
			let name = dirUri.path.split('/').filter(Boolean).pop() || 'workflow';
			let description = '';

			if (hasMainMd) {
				try {
					const content = (await fileService.readFile(mainWorkflowMd)).value.toString();
					const titleMatch = content.match(/^#\s+(.+?)(?:\s+\(WORKFLOW\))?$/m);
					if (titleMatch && titleMatch[1]) {
						name = titleMatch[1].trim();
					}
					const descMatch = content.match(/## Description\s*\n+([\s\S]*?)(?=\n##|$)/);
					if (descMatch && descMatch[1]) {
						description = descMatch[1].trim();
					}
				} catch { }
			} else if (hasLegacyMd) {
				try {
					const content = (await fileService.readFile(legacyWorkflowMd)).value.toString();
					const titleMatch = content.match(/^#\s+(.+)$/m);
					if (titleMatch && titleMatch[1]) {
						name = titleMatch[1].trim();
					}
				} catch { }
			}

			return { isExisting: true, name, description };
		}
	} catch { }

	return { isExisting: false };
}

let activeWorkflowModalOverlay: HTMLElement | undefined = undefined;

export async function createWorkflowDialog(
	accessor: ServicesAccessor,
	defaultTargetFolderUri?: URI
): Promise<void> {
	const fileService = accessor.get(IFileService);
	const viewsService = accessor.get(IViewsService);

	// Unify new Workflow creation into the single unified Ticket creation modal in WorkspacesExplorerPane.
	// Only use legacy import flow when defaultTargetFolderUri points to an existing workflow folder on disk.
	const isImportingExisting = defaultTargetFolderUri ? (await probeWorkflowDirectory(fileService, defaultTargetFolderUri)).isExisting : false;
	if (!isImportingExisting) {
		let view = viewsService.getViewWithId(WORKSPACE_PANE_VIEW_ID) as WorkspacesExplorerPane | null;
		if (!view) {
			view = await viewsService.openView(WORKSPACE_PANE_VIEW_ID, false) as WorkspacesExplorerPane | null;
		}
		if (view && typeof view.showCreateResourceModal === 'function') {
			view.showCreateResourceModal(defaultTargetFolderUri, undefined, undefined, 'workflow');
			return;
		}
	}

	const notificationService = accessor.get(INotificationService);
	const workspacesExplorerService = accessor.get(IWorkspacesExplorerService);
	const editorService = accessor.get(IEditorService);
	const fileDialogService = accessor.get(IFileDialogService);
	const entityPersistenceService = accessor.get(IEntityPersistenceService);
	const workflowsManagerService = accessor.get(IWorkflowsManagerService);
	const customModulesService = accessor.get(ICustomModulesService);

	const managedWorkspaces = await workspacesExplorerService.getWorkspaces();
	let workspaces = [...managedWorkspaces].reverse();

	return new Promise<void>((resolve) => {
		// 1. Remove any existing modal
		if (activeWorkflowModalOverlay) {
			activeWorkflowModalOverlay.remove();
			activeWorkflowModalOverlay = undefined;
		}

		// 2. Create Modal Overlay (Blur backdrop)
		const overlay = append(mainWindow.document.body, $('.create-workflow-modal-overlay'));
		activeWorkflowModalOverlay = overlay;
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
		const modal = append(overlay, $('.create-workflow-modal-box'));
		modal.style.width = '100%';
		modal.style.maxWidth = '580px';
		modal.style.maxHeight = '90vh';
		modal.style.backgroundColor = 'var(--vscode-editorWidget-background, #1e1e1e)';
		modal.style.color = 'var(--vscode-foreground, #cccccc)';
		modal.style.border = '1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.15))';
		modal.style.borderRadius = '10px';
		modal.style.padding = '24px 28px';
		modal.style.boxShadow = '0 20px 48px rgba(0, 0, 0, 0.65)';
		modal.style.display = 'flex';
		modal.style.flexDirection = 'column';
		modal.style.gap = '16px';
		modal.style.fontFamily = 'var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif)';
		modal.style.fontSize = '12px';
		modal.style.boxSizing = 'border-box';
		modal.style.position = 'relative';
		modal.style.overflowY = 'auto';

		let keydownListener: ((e: KeyboardEvent) => void) | undefined;
		let workspacesListener: { dispose(): void } | undefined;
		let modulesListener: { dispose(): void } | undefined;
		const closeModal = () => {
			if (keydownListener) {
				mainWindow.document.removeEventListener('keydown', keydownListener);
			}
			if (workspacesListener) {
				workspacesListener.dispose();
				workspacesListener = undefined;
			}
			if (modulesListener) {
				modulesListener.dispose();
				modulesListener = undefined;
			}
			overlay.remove();
			resolve();
		};

		keydownListener = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				closeModal();
			}
		};
		mainWindow.document.addEventListener('keydown', keydownListener);

		overlay.onclick = (e) => {
			if (e.target === overlay) {
				closeModal();
			}
		};

		// 4. Modal Header
		const modalHeader = append(modal, $('.modal-header'));
		modalHeader.style.display = 'flex';
		modalHeader.style.alignItems = 'center';
		modalHeader.style.justifyContent = 'space-between';
		modalHeader.style.paddingBottom = '4px';

		const modalTitle = append(modalHeader, $('div', {
			style: 'font-weight: 600; font-size: 15px; color: var(--vscode-foreground, #ffffff); display: flex; align-items: center; gap: 8px; font-family: inherit;'
		}));
		const flowIcon = append(modalTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.githubAction)));
		flowIcon.style.color = 'var(--vscode-charts-blue, #38bdf8)';
		flowIcon.style.fontSize = '16px';
		const titleTextEl = append(modalTitle, $('span', {}, 'Create New Workflow'));

		const closeBtn = append(modalHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
		closeBtn.style.cursor = 'pointer';
		closeBtn.style.opacity = '0.7';
		closeBtn.style.fontSize = '14px';
		closeBtn.style.transition = 'opacity 0.15s ease';
		closeBtn.onmouseenter = () => closeBtn.style.opacity = '1';
		closeBtn.onmouseleave = () => closeBtn.style.opacity = '0.7';
		closeBtn.onclick = closeModal;

		// Helper function for uniform form labels matching project standards
		const createFormLabel = (text: string) => {
			return $('label', {
				style: 'display: block; font-size: 11.5px; font-weight: 500; margin-bottom: 6px; color: var(--vscode-foreground, #cccccc); opacity: 0.85; font-family: inherit;'
			}, text);
		};

		// Helper function for uniform input / select controls
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

		// 5. Workflow Scope Selection
		const destGroup = append(modal, $('.form-group'));
		append(destGroup, createFormLabel('Workflow Scope:'));

		const selectDest = append(destGroup, $('select.monaco-select', {
			style: 'cursor: pointer;'
		})) as HTMLSelectElement;
		applyControlStyle(selectDest);

		const populateWorkspaceOptions = (selectedValue?: string) => {
			while (selectDest.options.length > 0) {
				selectDest.remove(0);
			}

			const rootOpt = append(selectDest, $('option', {}, 'Independent Flow (Global Workflows Directory)')) as HTMLOptionElement;
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
				} else if (defaultTargetFolderUri) {
					if (
						defaultTargetFolderUri.toString() === ws.uri.toString() ||
						defaultTargetFolderUri.path === ws.uri.path ||
						defaultTargetFolderUri.path.startsWith(ws.uri.path + '/')
					) {
						opt.selected = true;
						matchedOption = true;
					}
				} else if (idx === 0) {
					opt.selected = true;
					matchedOption = true;
				}
			});

			if (!matchedOption) {
				rootOpt.selected = true;
			}
		};

		populateWorkspaceOptions();

		workspacesListener = workspacesExplorerService.onDidChangeWorkspaces(async () => {
			const prevValue = selectDest.value;
			const updated = await workspacesExplorerService.getWorkspaces();
			workspaces = [...updated].reverse();
			populateWorkspaceOptions(prevValue);
		});

		// 6. Workflow Storage Location (Browse / Path input)
		let initialPath = DEFAULT_WORKFLOWS_DIR;
		if (defaultTargetFolderUri) {
			initialPath = defaultTargetFolderUri.fsPath;
		} else if (selectDest.value !== 'independent') {
			const selectedWs = workspaces.find(w => w.uri.toString() === selectDest.value);
			if (selectedWs) {
				initialPath = selectedWs.uri.fsPath;
			}
		}

		const locationGroup = append(modal, $('.form-group'));
		append(locationGroup, createFormLabel('Workflow Directory / Storage Location:'));

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

		// 6.5 Live Ticket ID Preview Badge
		const badgeGroup = append(modal, $('.form-group'));
		const previewBadge = append(badgeGroup, $('div', {
			style: 'font-size: 11.5px; font-weight: 600; color: #38bdf8; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.35); border-radius: 6px; padding: 8px 12px; text-align: center;'
		}));
		previewBadge.innerText = 'Generated Ticket ID: calculating...';

		// 7. Workflow Name / Title
		const nameGroup = append(modal, $('.form-group'));
		append(nameGroup, createFormLabel('Workflow Title:'));
		const nameInput = append(nameGroup, $('input.monaco-inputbox')) as HTMLInputElement;
		applyControlStyle(nameInput);
		nameInput.placeholder = 'e.g. Initial, Daily Deployment, Voice STT Pipeline';

		// 8. Workflow Description
		const descGroup = append(modal, $('.form-group'));
		append(descGroup, createFormLabel('Description:'));
		const descInput = append(descGroup, $('input.monaco-inputbox')) as HTMLInputElement;
		applyControlStyle(descInput);
		descInput.placeholder = 'e.g. Automates end-to-end voice transcription and AI processing pipeline.';

		// 8.5 Git Configuration Section (Only displayed when workflow module schema contains a 'git' primitive field)
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

		// 8.6 Dynamic Custom Fields from 'workflow' Module Template
		const customFieldsBox = append(modal, $('.custom-fields-box', {
			style: 'display: none; flex-direction: column; gap: 10px; margin-top: 4px;'
		}));

		// 9. Bottom Button Actions
		const btnRow = append(modal, $('div', {
			style: 'display: flex; gap: 12px; justify-content: flex-end; margin-top: 8px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,0.08);'
		}));

		const cancelBtn = append(btnRow, $('button.monaco-button', {
			style: 'padding: 8px 20px; border-radius: 6px; font-weight: 500; font-size: 12px; font-family: inherit; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.08); color: var(--vscode-foreground, #cccccc); cursor: pointer; transition: background 0.15s ease;'
		}));
		cancelBtn.innerText = 'Cancel';
		cancelBtn.onmouseenter = () => cancelBtn.style.background = 'rgba(255, 255, 255, 0.14)';
		cancelBtn.onmouseleave = () => cancelBtn.style.background = 'rgba(255, 255, 255, 0.08)';
		cancelBtn.onclick = closeModal;

		const submitBtn = append(btnRow, $('button.monaco-button', {
			style: 'padding: 8px 22px; border-radius: 6px; font-weight: 600; font-size: 12px; font-family: inherit; border: none; background: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, #ffffff); cursor: pointer; transition: filter 0.15s ease; box-shadow: 0 2px 8px rgba(0, 122, 204, 0.3);'
		}));
		submitBtn.innerText = 'Create Workflow';
		submitBtn.onmouseenter = () => submitBtn.style.filter = 'brightness(1.1)';
		submitBtn.onmouseleave = () => submitBtn.style.filter = 'none';

		let isExistingWorkflowDetected = false;
		let activeWorkflowModule: ICustomModule | undefined = undefined;

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

		const renderWorkflowTemplateFields = async () => {
			try {
				const rawPath = locationInput.value.trim();
				const locUri = rawPath ? URI.file(rawPath) : URI.file(DEFAULT_WORKFLOWS_DIR);
				const matchedWs = resolveTargetWorkspace(locUri);
				const modules = await customModulesService.getCustomModules(matchedWs?.uri);
				const matchingModule = modules.find(m => m.id.toLowerCase() === 'workflow' && !m.isDeprecated);
				activeWorkflowModule = matchingModule;

				if (isExistingWorkflowDetected) {
					customFieldsBox.style.display = 'none';
					gitBox.style.display = 'none';
					descGroup.style.display = 'block';
					return;
				}

				const hasDescField = !!(matchingModule && Array.isArray(matchingModule.fields) && matchingModule.fields.some(f => f.id?.toLowerCase() === 'description' || f.label?.toLowerCase() === 'description'));
				descGroup.style.display = hasDescField ? 'block' : 'none';
				if (!hasDescField) {
					descInput.value = '';
				}

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
					let renderedCount = 0;

					for (const field of matchingModule.fields) {
						if (field.id === 'title' || field.label?.toLowerCase() === 'title' || field.id === 'description' || field.label?.toLowerCase() === 'description' || field.type === 'git' || field.type === 'output') {
							continue;
						}
						renderedCount++;
						const fieldGroup = append(customFieldsBox, $('.form-group', { style: 'display: flex; flex-direction: column; gap: 6px; margin-bottom: 4px;' }));
						append(fieldGroup, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; font-weight: 600;' }, `${field.label}:`));

						if (field.type === 'textarea') {
							append(fieldGroup, $('textarea.monaco-inputbox.custom-field-input', {
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'width: 100%; padding: 8px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; resize: vertical; min-height: 52px; font-family: inherit;'
							}));
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
						} else if (field.type === 'multiselect') {
							const container = append(fieldGroup, $('.multiselect-container.custom-field-input', {
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'display: flex; flex-direction: column; gap: 4px; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 8px; background: rgba(0,0,0,0.15);'
							}));
							(field.options || []).forEach((opt: string) => {
								const row = append(container, $('label', { style: 'display: flex; align-items: center; gap: 6px; font-size: 11.5px; cursor: pointer;' }));
								append(row, $('input', { type: 'checkbox', value: opt, style: 'cursor: pointer;' }));
								append(row, $('span', {}, opt));
							});
						} else if (field.type === 'switch') {
							const row = append(fieldGroup, $('label', { style: 'display: flex; align-items: center; gap: 8px; font-size: 11.5px; cursor: pointer; padding: 4px 0;' }));
							append(row, $('input.custom-field-input', {
								type: 'checkbox',
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'cursor: pointer;'
							}));
							append(row, $('span', {}, 'Enabled'));
						} else if (field.type === 'date' || field.type === 'time' || field.type === 'datetime') {
							const inputType = field.type === 'date' ? 'date' : field.type === 'time' ? 'time' : 'datetime-local';
							append(fieldGroup, $('input.monaco-inputbox.custom-field-input', {
								type: inputType,
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
							}));
						} else if (field.type === 'date_range' || field.type === 'time_range' || field.type === 'datetime_range') {
							const rangeContainer = append(fieldGroup, $('.range-container.custom-field-input', {
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'display: flex; align-items: center; gap: 8px;'
							}));
							const inputType = field.type === 'date_range' ? 'date' : field.type === 'time_range' ? 'time' : 'datetime-local';
							append(rangeContainer, $('input.monaco-inputbox.range-start', {
								type: inputType,
								placeholder: 'Start',
								style: 'flex: 1; padding: 7px 10px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit;'
							}));
							append(rangeContainer, $('span', { style: 'opacity: 0.6; font-size: 12px;' }, '->'));
							append(rangeContainer, $('input.monaco-inputbox.range-end', {
								type: inputType,
								placeholder: 'End',
								style: 'flex: 1; padding: 7px 10px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit;'
							}));
						} else if (field.type === 'dynamic_list') {
							const listContainer = append(fieldGroup, $('.dynamic-list-container.custom-field-input', {
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'display: flex; flex-direction: column; gap: 10px; border: 1px solid rgba(56, 189, 248, 0.2); background: rgba(56, 189, 248, 0.03); border-radius: 8px; padding: 12px;'
							}));
							const itemsWrapper = append(listContainer, $('.dynamic-items-wrapper', { style: 'display: flex; flex-direction: column; gap: 10px;' }));
							const renderItemCard = (itemData?: any) => {
								const currentCount = itemsWrapper.querySelectorAll('.dynamic-item-card').length;
								const idx = currentCount + 1;
								const itemCard = append(itemsWrapper, $('.dynamic-item-card', {
									style: 'background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;'
								}));
								const itemHeader = append(itemCard, $('.item-card-header', { style: 'display: flex; justify-content: space-between; align-items: center;' }));
								const headerLeft = append(itemHeader, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex: 1;' }));
								append(headerLeft, $('span', { style: 'font-size: 10px; font-weight: 700; background: rgba(56, 189, 248, 0.2); color: #38bdf8; padding: 2px 6px; border-radius: 4px;' }, `#${idx}`));
								append(headerLeft, $('input.monaco-inputbox.item-title-input', {
									placeholder: 'Entry Title...',
									value: itemData?._title || '',
									style: 'flex: 1; padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.25); color: #fff;'
								}));
								const delItemBtn = append(itemHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), {
									style: 'color: #ef4444; cursor: pointer; padding: 4px; font-size: 12px; opacity: 0.8;'
								}));
								delItemBtn.onclick = () => {
									itemCard.remove();
									const remaining = itemsWrapper.querySelectorAll('.dynamic-item-card');
									remaining.forEach((card, rIdx) => {
										const badge = card.querySelector('span');
										if (badge) badge.innerText = `#${rIdx + 1}`;
									});
								};
								const subFieldsList = field.itemFields || [];
								if (subFieldsList.length > 0) {
									const subGrid = append(itemCard, $('.subfields-grid', { style: 'display: flex; flex-direction: column; gap: 6px;' }));
									for (const subF of subFieldsList) {
										const subRow = append(subGrid, $('.subfield-row', { style: 'display: flex; flex-direction: column; gap: 3px;' }));
										append(subRow, $('label', { style: 'font-size: 10.5px; opacity: 0.75; font-weight: 500;' }, `${subF.label}:`));
										if (subF.type === 'textarea') {
											append(subRow, $('textarea.monaco-inputbox.sub-field-input', {
												'data-subfield-id': subF.id,
												'data-subfield-label': subF.label,
												'data-subfield-type': subF.type,
												rows: '3',
												style: 'width: 100%; padding: 6px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.2); color: #fff; resize: vertical;'
											}));
										} else if (subF.type === 'select') {
											const sSelect = append(subRow, $('select.monaco-select.sub-field-input', {
												'data-subfield-id': subF.id,
												'data-subfield-label': subF.label,
												'data-subfield-type': subF.type,
												style: 'width: 100%; padding: 5px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.25); color: #fff;'
											})) as HTMLSelectElement;
											(subF.options || []).forEach(o => append(sSelect, $('option', { value: o }, o)));
										} else {
											append(subRow, $('input.monaco-inputbox.sub-field-input', {
												type: subF.type === 'number' ? 'number' : 'text',
												'data-subfield-id': subF.id,
												'data-subfield-label': subF.label,
												'data-subfield-type': subF.type,
												placeholder: `Enter ${subF.label}...`,
												style: 'width: 100%; padding: 5px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.2); color: #fff;'
											}));
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
							const attachedFiles: Array<{ name: string; size: number; dataUrl?: string }> = [];
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
								if (!files) return;
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
							(attachContainer as any).__getAttachedFiles = () => attachedFiles;
						} else if (field.type === 'button_group' || field.type === 'button') {
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
							(btnGroupContainer as any).__getSelectedAction = () => selectedActionLabel;
							(btnGroupContainer as any).__getSelectedTargetStatus = () => selectedTargetStatus;
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
							append(numWrapper, $('input.monaco-inputbox.custom-field-input', {
								type: 'number',
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								step: (field.precision !== undefined && field.precision > 0) ? (1 / Math.pow(10, field.precision)).toString() : 'any',
								placeholder: field.precision !== undefined && field.precision > 0 ? (0).toFixed(field.precision) : '0',
								style: 'flex: 1; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
							}));
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
							(browserBox as any).__getBrowserData = () => ({
								url: urlInput.value.trim(),
								credentials: creds,
								content: field.defaultContent || '',
								lastFetched: field.defaultContent ? 'Initialized from Schema' : ''
							});
						} else if (field.type === 'prompt') {
							const promptBox = append(fieldGroup, $('.prompt-field-container.custom-field-input', {
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'display: flex; flex-direction: column; gap: 8px; border: 1px solid rgba(59, 130, 246, 0.25); background: rgba(59, 130, 246, 0.04); border-radius: 8px; padding: 10px 12px;'
							}));
							const targetDesc = field.targetMode === 'agent'
								? `Agent: ${field.targetAgentName || field.targetAgentId || 'Default'}`
								: `Model: ${field.targetModel || 'gemini-1.5-flash'}`;
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

							(promptBox as any).__getPromptData = () => {
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
									targetProvider: field.targetProvider || '',
									targetModel: field.targetModel || 'gemini-1.5-flash',
									targetAgentId: field.targetAgentId || '',
									targetAgentName: field.targetAgentName || '',
									output: '',
									lastExecuted: ''
								};
							};
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
							(ttsBox as any).__getTtsData = () => ({
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
							(pyBox as any).__getPythonData = () => ({
								code: pyTextarea.value,
								pythonInterpreter: field.pythonInterpreter || '',
								externalScripts: field.externalScripts || [],
								output: '',
								logs: '',
								lastExecuted: ''
							});
						} else {
							append(fieldGroup, $('input.monaco-inputbox.custom-field-input', {
								type: 'text',
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
							}));
						}
					}

					customFieldsBox.style.display = renderedCount > 0 ? 'flex' : 'none';
				} else {
					clearNode(customFieldsBox);
					customFieldsBox.style.display = 'none';
				}
			} catch {
				// ignore
			}
		};

		modulesListener = customModulesService.onDidChangeModules(() => {
			renderWorkflowTemplateFields();
		});

		const refreshTicketIdPreview = async () => {
			try {
				const rawPath = locationInput.value.trim();
				const locUri = rawPath ? URI.file(rawPath) : URI.file(DEFAULT_WORKFLOWS_DIR);
				const matchedWs = resolveTargetWorkspace(locUri);
				if (matchedWs) {
					const seq = await workspacesExplorerService.generateNextSequentialName(matchedWs.uri, 'workflow');
					previewBadge.innerText = `Generated Ticket ID: ${seq.name} (Workspace Code: ${seq.code})`;
				} else {
					const seq = await workspacesExplorerService.generateNextSequentialName(locUri, 'workflow', 'GFLOW');
					previewBadge.innerText = `Generated Ticket ID: ${seq.name} (Independent Flow)`;
				}
			} catch {
				previewBadge.innerText = 'Generated Ticket ID: AUTO';
			}
		};

		// Directory probe handler
		const updateProbeState = async () => {
			await refreshTicketIdPreview();
			const rawPath = locationInput.value.trim();
			if (!rawPath) {
				await renderWorkflowTemplateFields();
				return;
			}
			const targetUri = URI.file(rawPath);
			const probe = await probeWorkflowDirectory(fileService, targetUri);

			if (probe.isExisting) {
				isExistingWorkflowDetected = true;
				titleTextEl.textContent = 'Open Existing Workflow';
				submitBtn.textContent = 'Open Workflow';
				badgeGroup.style.display = 'none';

				if (probe.name && !nameInput.value.trim()) {
					nameInput.value = probe.name;
				} else if (probe.name && isExistingWorkflowDetected) {
					nameInput.value = probe.name;
				}

				if (probe.description && !descInput.value.trim()) {
					descInput.value = probe.description;
				}
			} else {
				isExistingWorkflowDetected = false;
				titleTextEl.textContent = 'Create New Workflow';
				submitBtn.textContent = 'Create Workflow';
				badgeGroup.style.display = 'block';
			}
			await renderWorkflowTemplateFields();
		};

		// Scope change listener
		selectDest.onchange = () => {
			if (selectDest.value === 'independent') {
				locationInput.value = DEFAULT_WORKFLOWS_DIR;
			} else {
				const wsUri = URI.parse(selectDest.value);
				locationInput.value = wsUri.fsPath;
			}
			updateProbeState();
		};

		// Browse button click listener
		browseBtn.onclick = async () => {
			const res = await fileDialogService.showOpenDialog({
				canSelectFolders: true,
				canSelectFiles: false,
				canSelectMany: false,
				defaultUri: locationInput.value.trim() ? URI.file(locationInput.value.trim()) : URI.file(DEFAULT_WORKFLOWS_DIR),
				title: 'Select Workflow Storage Location or Existing Workflow Folder'
			});
			if (res && res.length > 0) {
				locationInput.value = res[0].fsPath;
				await updateProbeState();
			}
		};

		locationInput.oninput = () => {
			updateProbeState();
		};

		// Initial probe
		updateProbeState();

		// Submit action
		submitBtn.onclick = async () => {
			const rawPath = locationInput.value.trim();
			if (!rawPath) {
				notificationService.warn('Please select or specify a storage location.');
				locationInput.focus();
				return;
			}

			const locationUri = URI.file(rawPath);

			// 1. If opening an existing workflow folder
			if (isExistingWorkflowDetected) {
				const workflowName = nameInput.value.trim() || locationUri.path.split('/').filter(Boolean).pop() || 'Workflow';
				const workflowDesc = descInput.value.trim() || `Workflow: ${workflowName}`;

				let belongsToWsUri: string | undefined = undefined;
				let scopeName = 'Independent';
				if (selectDest.value !== 'independent') {
					belongsToWsUri = selectDest.value;
					const wsFolder = workspaces.find(f => f.uri.toString() === selectDest.value);
					if (wsFolder) {
						scopeName = wsFolder.name;
					}
				}

				const activeOwner = workspacesExplorerService.getActiveUserEmail() || 'unauthenticated';

				try {
					await entityPersistenceService.saveSnapshot({
						entityUri: locationUri.toString(),
						entityName: workflowName,
						entityType: 'workflow',
						description: workflowDesc,
						ownerAccount: activeOwner,
						createdAt: new Date().toISOString(),
						belongsToWorkspaceUri: belongsToWsUri,
						scopeName: scopeName
					});

					await workflowsManagerService.saveWorkflow({
						uri: locationUri.toString(),
						name: workflowName,
						description: workflowDesc,
						belongsToWorkspaceUri: belongsToWsUri,
						belongsToWorkspaceName: scopeName,
						createdAt: new Date().toISOString()
					});

					notificationService.info(`Workflow '${workflowName}' opened and registered successfully!`);
					closeModal();
					await editorService.openEditor(new WorkflowEditorInput(locationUri, workflowName), { pinned: true });
				} catch (err) {
					notificationService.error(`Failed to open workflow: ${err}`);
				}
				return;
			}

			// 2. If creating a new workflow
			const name = nameInput.value.trim();
			if (!name) {
				notificationService.warn('Please enter a Workflow Title.');
				nameInput.focus();
				return;
			}

			const description = descInput.value.trim();
			const matchedWs = resolveTargetWorkspace(locationUri);

			let initialStatusOverride = '';
			const customMetadata: { [key: string]: string } = {};
			const allPendingFieldAttachments: Array<{ name: string; size: number; dataUrl?: string }> = [];
			const customInputs = customFieldsBox.querySelectorAll('.custom-field-input');
			customInputs.forEach(inputEl => {
				const fieldLabel = inputEl.getAttribute('data-field-label');
				if (fieldLabel) {
					if (inputEl instanceof HTMLInputElement && inputEl.type === 'checkbox') {
						customMetadata[fieldLabel] = inputEl.checked ? 'true' : 'false';
					} else if (inputEl.classList.contains('multiselect-container')) {
						const checked = Array.from(inputEl.querySelectorAll('input[type="checkbox"]:checked')).map((cb: any) => cb.value);
						customMetadata[fieldLabel] = checked.join(', ');
					} else if (inputEl.classList.contains('range-container')) {
						const startVal = (inputEl.querySelector('.range-start') as HTMLInputElement)?.value || '';
						const endVal = (inputEl.querySelector('.range-end') as HTMLInputElement)?.value || '';
						customMetadata[fieldLabel] = (startVal || endVal) ? `${startVal} ~ ${endVal}` : '';
					} else if (inputEl.classList.contains('dynamic-list-container')) {
						const itemCards = inputEl.querySelectorAll('.dynamic-item-card');
						const items: any[] = [];
						itemCards.forEach((cardEl, idx) => {
							const itemObj: any = { _index: idx + 1 };
							const titleInputEl = cardEl.querySelector('.item-title-input') as HTMLInputElement;
							if (titleInputEl && titleInputEl.value.trim()) {
								itemObj._title = titleInputEl.value.trim();
							}
							const subInputs = cardEl.querySelectorAll('.sub-field-input');
							subInputs.forEach(subEl => {
								const subLabel = subEl.getAttribute('data-subfield-label');
								if (subLabel) {
									if (subEl instanceof HTMLInputElement && subEl.type === 'checkbox') {
										itemObj[subLabel] = subEl.checked ? 'true' : 'false';
									} else if (subEl.classList.contains('range-container')) {
										const startVal = (subEl.querySelector('.range-start') as HTMLInputElement)?.value || '';
										const endVal = (subEl.querySelector('.range-end') as HTMLInputElement)?.value || '';
										itemObj[subLabel] = (startVal || endVal) ? `${startVal} ~ ${endVal}` : '';
									} else {
										itemObj[subLabel] = (subEl as any).value || '';
									}
								}
							});
							items.push(itemObj);
						});
						customMetadata[fieldLabel] = JSON.stringify(items);
					} else if (inputEl.classList.contains('attachment-field-container')) {
						const getFiles = (inputEl as any).__getAttachedFiles;
						const filesList: Array<{ name: string; size: number; dataUrl?: string }> = getFiles ? getFiles() : [];
						customMetadata[fieldLabel] = filesList.length > 0 ? JSON.stringify(filesList.map(f => ({ name: f.name, size: f.size }))) : '';
						filesList.forEach(f => {
							allPendingFieldAttachments.push(f);
						});
					} else if (inputEl.classList.contains('action-buttons-group-row')) {
						const getAction = (inputEl as any).__getSelectedAction;
						const chosenAction = getAction ? getAction() : '';
						customMetadata[fieldLabel] = chosenAction;
						const getTargetStatus = (inputEl as any).__getSelectedTargetStatus;
						const targetSt = getTargetStatus ? getTargetStatus() : '';
						if (targetSt) {
							initialStatusOverride = targetSt;
						}
					} else if (inputEl.classList.contains('browser-field-container')) {
						const getBData = (inputEl as any).__getBrowserData;
						const bData = getBData ? getBData() : { url: '', credentials: [] };
						customMetadata[fieldLabel] = JSON.stringify(bData);
					} else if (inputEl.classList.contains('prompt-field-container')) {
						const getPData = (inputEl as any).__getPromptData;
						const pData = getPData ? getPData() : { prompt: '', targetMode: 'model' };
						customMetadata[fieldLabel] = JSON.stringify(pData);
					} else if (inputEl.classList.contains('tts-field-container')) {
						const getTData = (inputEl as any).__getTtsData;
						const tData = getTData ? getTData() : { text: '', ttsFormat: 'mp3' };
						customMetadata[fieldLabel] = JSON.stringify(tData);
					} else if (inputEl.classList.contains('python-field-container')) {
						const getPyData = (inputEl as any).__getPythonData;
						const pyData = getPyData ? getPyData() : { code: '', pythonInterpreter: '' };
						customMetadata[fieldLabel] = JSON.stringify(pyData);
					} else {
						customMetadata[fieldLabel] = (inputEl as any).value || '';
					}
				}
			});

			const gitRepoUrl = gitRemoteInput.value.trim() || undefined;
			const gitBranch = gitBranchInput.value.trim() || undefined;
			const hasCustomSchema = !!(activeWorkflowModule && activeWorkflowModule.fields && activeWorkflowModule.fields.length > 0);
			const defFile = (activeWorkflowModule as any)?.definitionFile;
			const modDesc = typeof activeWorkflowModule?.description === 'string' ? activeWorkflowModule.description.trim() : '';
			const resolvedTypeDef = hasCustomSchema ? (defFile || '.agents/entity_type/workflow.yaml') : (defFile || modDesc || undefined);
			const resolvedTypePrompt = (typeof activeWorkflowModule?.prompt === 'string' && activeWorkflowModule.prompt.trim())
				? activeWorkflowModule.prompt.trim()
				: 'A workflow executes automated nodes, transitions, and AI pipelines.';

			try {
				let targetFolderUri: URI;
				let belongsToWsUri: string | undefined = undefined;
				let scopeName = 'Independent';

				if (matchedWs) {
					const wsRootUri = matchedWs.uri;
					belongsToWsUri = wsRootUri.toString();
					scopeName = matchedWs.name;

					if (activeWorkflowModule && hasCustomSchema) {
						const localYamlUri = URI.joinPath(wsRootUri, '.agents', 'entity_type', 'workflow.yaml');
						const yamlContent = stringifyYaml({ ...activeWorkflowModule, storageScope: 'workspace' });
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
						type: 'workflow',
						name: 'AUTO',
						title: name,
						status: initialStatus,
						description: description || `Workflow: ${name}`,
						typeDefinition: resolvedTypeDef,
						typePrompt: resolvedTypePrompt,
						gitRepoUrl,
						gitBranch,
						customMetadata: Object.keys(customMetadata).length > 0 ? customMetadata : undefined
					});

					targetFolderUri = createRes.uri.path.endsWith('/.agents/ticket.md')
						? dirname(dirname(createRes.uri))
						: createRes.uri;
				} else {
					if (activeWorkflowModule && hasCustomSchema) {
						const localYamlUri = URI.joinPath(locationUri, '.agents', 'entity_type', 'workflow.yaml');
						const yamlContent = stringifyYaml({ ...activeWorkflowModule, storageScope: 'workspace' });
						await fileService.writeFile(localYamlUri, VSBuffer.fromString(yamlContent));
					}

					const seq = await workspacesExplorerService.generateNextSequentialName(locationUri, 'workflow', 'GFLOW');
					const createRes = await workspacesExplorerService.createResourceUnderWorkspace({
						workspaceUri: locationUri,
						targetParentUri: locationUri,
						type: 'workflow',
						name: seq.name,
						code: seq.code,
						title: name,
						status: initialStatusOverride || 'Todo',
						description: description || `Workflow: ${name}`,
						typeDefinition: resolvedTypeDef,
						typePrompt: resolvedTypePrompt,
						gitRepoUrl,
						gitBranch,
						customMetadata: Object.keys(customMetadata).length > 0 ? customMetadata : undefined
					});

					targetFolderUri = createRes.uri.path.endsWith('/.agents/ticket.md')
						? dirname(dirname(createRes.uri))
						: createRes.uri;
				}

				// Write any uploaded field attachments to targetFolderUri/attachments/
				if (allPendingFieldAttachments.length > 0) {
					const attachmentsDirUri = URI.joinPath(targetFolderUri, 'attachments');
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

				// Ensure workflow_flowchart.json is present
				const flowchartJsonUri = URI.joinPath(targetFolderUri, '.agents', 'workflow_flowchart.json');
				if (!await fileService.exists(flowchartJsonUri)) {
					const initialData = {
						nodes: [
							{ id: 'start_node', type: 'circle', x: 120, y: 150, width: 60, height: 60, label: 'Start' },
							{ id: 'step_1', type: 'round-rect', x: 260, y: 145, width: 140, height: 60, label: 'Process Step 1' }
						],
						edges: [
							{ id: 'edge_1', from: 'start_node', to: 'step_1', fromPort: 'right', toPort: 'left' }
						],
						routingMode: 'orthogonal',
						viewport: { x: 0, y: 0, zoom: 1 }
					};
					await fileService.writeFile(flowchartJsonUri, VSBuffer.fromString(JSON.stringify(initialData, null, 2)));
				}

				await workflowsManagerService.saveWorkflow({
					uri: targetFolderUri.toString(),
					name: name,
					description: description || `Workflow: ${name}`,
					belongsToWorkspaceUri: belongsToWsUri,
					belongsToWorkspaceName: scopeName,
					createdAt: new Date().toISOString()
				});

				notificationService.info(`Workflow '${name}' created successfully!`);
				workflowsManagerService.notifyPaneExpanded(
					matchedWs ? 'workbench.view.workflowsManager.workspace' : 'workbench.view.workflowsManager.independent'
				);
				closeModal();
				await editorService.openEditor(new WorkflowEditorInput(targetFolderUri, name), { pinned: true });
			} catch (err) {
				notificationService.error(`Failed to create workflow: ${err}`);
			}
		};

		setTimeout(() => nameInput.focus(), 50);
	});
}
