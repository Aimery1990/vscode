/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEntityPersistenceService } from '../../entityPersistence/common/entityPersistence.js';
import { IWorkflowsManagerService } from '../common/workflowsManager.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';
import { $, append } from '../../../../base/browser/dom.js';
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
	const notificationService = accessor.get(INotificationService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	const editorService = accessor.get(IEditorService);
	const fileDialogService = accessor.get(IFileDialogService);
	const fileService = accessor.get(IFileService);
	const entityPersistenceService = accessor.get(IEntityPersistenceService);
	const workflowsManagerService = accessor.get(IWorkflowsManagerService);

	const folders = workspaceContextService.getWorkspace().folders;

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

		// 3. Modal Main Dialog Box
		const modal = append(overlay, $('.create-workflow-modal-box'));
		modal.style.width = '520px';
		modal.style.maxWidth = '92vw';
		modal.style.maxHeight = '90vh';
		modal.style.backgroundColor = 'var(--vscode-editor-background, #1e1e1e)';
		modal.style.color = 'var(--vscode-editor-foreground, #cccccc)';
		modal.style.border = '1px solid rgba(255, 255, 255, 0.15)';
		modal.style.borderRadius = '12px';
		modal.style.boxShadow = '0 20px 50px rgba(0, 0, 0, 0.6)';
		modal.style.display = 'flex';
		modal.style.flexDirection = 'column';
		modal.style.overflow = 'hidden';
		modal.style.position = 'relative';
		modal.style.overflowY = 'auto';

		const closeModal = () => {
			overlay.remove();
			resolve();
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
		const flowIcon = append(modalTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.githubAction)));
		flowIcon.style.color = '#14b8a6';
		const titleTextEl = append(modalTitle, $('span', {}, 'Create or Open Workflow'));

		const closeBtn = append(modalHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
		closeBtn.style.cursor = 'pointer';
		closeBtn.style.opacity = '0.7';
		closeBtn.style.fontSize = '15px';
		closeBtn.onclick = closeModal;

		// Helper function for uniform form labels
		const createFormLabel = (text: string) => {
			return $('label', {
				style: 'display: block; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; color: var(--vscode-sideBarTitle-foreground, #cccccc); opacity: 0.9;'
			}, text);
		};

		// 5. Workflow Scope Selection
		const destGroup = append(modal, $('.form-group'));
		append(destGroup, createFormLabel('Workflow Scope:'));

		const selectDest = append(destGroup, $('select', {
			style: 'width: 100%; padding: 8px 12px; font-size: 12px; font-family: inherit; border-radius: 6px; border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15)); background: var(--vscode-input-background, #121212); color: inherit; box-sizing: border-box; outline: none; cursor: pointer;'
		})) as HTMLSelectElement;

		const rootOpt = append(selectDest, $('option', {}, 'Independent Flow (Global Workflows Directory)')) as HTMLOptionElement;
		rootOpt.value = 'independent';

		folders.forEach(f => {
			const opt = append(selectDest, $('option', {}, `Workspace: ${f.name}`)) as HTMLOptionElement;
			opt.value = f.uri.toString();
			if (defaultTargetFolderUri && defaultTargetFolderUri.toString() === f.uri.toString()) {
				opt.selected = true;
			}
		});

		// 6. Workflow Storage Location (Browse / Path input)
		let initialPath = DEFAULT_WORKFLOWS_DIR;
		if (defaultTargetFolderUri) {
			initialPath = defaultTargetFolderUri.fsPath;
		}

		const locationGroup = append(modal, $('.form-group'));
		append(locationGroup, createFormLabel('Workflow Directory / Storage Location:'));

		const locationRow = append(locationGroup, $('.location-row'));
		locationRow.style.display = 'flex';
		locationRow.style.gap = '8px';

		const locationInput = append(locationRow, $('input.monaco-inputbox', {
			style: 'flex: 1; padding: 8px 12px; font-size: 12px; font-family: inherit; border-radius: 6px; border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15)); background: var(--vscode-input-background, #121212); color: inherit; box-sizing: border-box; outline: none;'
		})) as HTMLInputElement;
		locationInput.value = initialPath;

		const browseBtn = append(locationRow, $('button.monaco-button', {
			style: 'padding: 8px 14px; font-size: 12px; font-family: inherit; border-radius: 6px; cursor: pointer; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: inherit; white-space: nowrap;'
		}));
		browseBtn.innerText = 'Browse...';

		// 7. Workflow Name / Title
		const nameGroup = append(modal, $('.form-group'));
		append(nameGroup, createFormLabel('Workflow Name:'));
		const nameInput = append(nameGroup, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 8px 12px; font-size: 12px; font-family: inherit; border-radius: 6px; border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15)); background: var(--vscode-input-background, #121212); color: inherit; box-sizing: border-box; outline: none;'
		})) as HTMLInputElement;
		nameInput.placeholder = 'e.g. daily-deployment, user-voice-stt-pipeline';

		// 8. Workflow Description
		const descGroup = append(modal, $('.form-group'));
		append(descGroup, createFormLabel('Description:'));
		const descInput = append(descGroup, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 8px 12px; font-size: 12px; font-family: inherit; border-radius: 6px; border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15)); background: var(--vscode-input-background, #121212); color: inherit; box-sizing: border-box; outline: none;'
		})) as HTMLInputElement;
		descInput.placeholder = 'e.g. Automates end-to-end voice transcription and AI processing pipeline.';

		// 9. Bottom Button Actions
		const btnRow = append(modal, $('div', {
			style: 'display: flex; gap: 12px; justify-content: flex-end; margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.05);'
		}));

		const cancelBtn = append(btnRow, $('button', {
			style: 'padding: 8px 18px; border-radius: 6px; font-weight: 500; font-size: 12px; border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.15)); background: transparent; color: inherit; cursor: pointer; transition: background 0.15s ease;'
		}, 'Cancel'));
		cancelBtn.onmouseenter = () => cancelBtn.style.background = 'rgba(255, 255, 255, 0.05)';
		cancelBtn.onmouseleave = () => cancelBtn.style.background = 'transparent';
		cancelBtn.onclick = closeModal;

		const submitBtn = append(btnRow, $('button', {
			style: 'padding: 8px 18px; border-radius: 6px; font-weight: 600; font-size: 12px; border: none; background: #14b8a6; color: #ffffff; cursor: pointer; transition: filter 0.15s ease;'
		}, 'Create Workflow'));
		submitBtn.onmouseenter = () => submitBtn.style.filter = 'brightness(1.1)';
		submitBtn.onmouseleave = () => submitBtn.style.filter = 'none';

		let isExistingWorkflowDetected = false;

		// Directory probe handler
		const updateProbeState = async () => {
			const rawPath = locationInput.value.trim();
			if (!rawPath) {
				return;
			}
			const targetUri = URI.file(rawPath);
			const probe = await probeWorkflowDirectory(fileService, targetUri);

			if (probe.isExisting) {
				isExistingWorkflowDetected = true;
				titleTextEl.textContent = 'Open Existing Workflow';
				submitBtn.textContent = 'Open Workflow';

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
			}
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
					const wsFolder = folders.find(f => f.uri.toString() === selectDest.value);
					if (wsFolder) {
						scopeName = wsFolder.name;
					}
				}

				try {
					await entityPersistenceService.saveSnapshot({
						entityUri: locationUri.toString(),
						entityName: workflowName,
						entityType: 'workflow',
						description: workflowDesc,
						ownerAccount: 'unauthenticated',
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
				notificationService.warn('Please enter a Workflow Name.');
				nameInput.focus();
				return;
			}

			const sanitizedName = name.replace(/[^a-zA-Z0-9_-]/g, '-');
			const description = descInput.value.trim();

			// If the user picked a directory that already matches the name, use it; otherwise create a subfolder
			const locationFolderName = locationUri.path.split('/').filter(Boolean).pop();
			const targetFolderUri = (locationFolderName && locationFolderName.toLowerCase() === sanitizedName.toLowerCase())
				? locationUri
				: URI.joinPath(locationUri, sanitizedName);

			let belongsToWsUri: string | undefined = undefined;
			let scopeName = 'Independent';
			if (selectDest.value !== 'independent') {
				belongsToWsUri = selectDest.value;
				const wsFolder = folders.find(f => f.uri.toString() === selectDest.value);
				if (wsFolder) {
					scopeName = wsFolder.name;
				}
			}

			try {
				if (!await fileService.exists(targetFolderUri)) {
					await fileService.createFolder(targetFolderUri);
				}

				await entityPersistenceService.writeEntity4MDFiles({
					entityUri: targetFolderUri.toString(),
					entityName: name,
					entityType: 'workflow',
					description: description || `Workflow: ${name}`,
					ownerAccount: 'unauthenticated',
					createdAt: new Date().toISOString(),
					belongsToWorkspaceUri: belongsToWsUri,
					scopeName: scopeName
				}, targetFolderUri, false);

				// Create initial workflow_flowchart.json if not present
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

				await entityPersistenceService.saveSnapshot({
					entityUri: targetFolderUri.toString(),
					entityName: name,
					entityType: 'workflow',
					description: description || `Workflow: ${name}`,
					ownerAccount: 'unauthenticated',
					createdAt: new Date().toISOString(),
					belongsToWorkspaceUri: belongsToWsUri,
					scopeName: scopeName
				});

				await workflowsManagerService.saveWorkflow({
					uri: targetFolderUri.toString(),
					name: name,
					description: description || `Workflow: ${name}`,
					belongsToWorkspaceUri: belongsToWsUri,
					belongsToWorkspaceName: scopeName,
					createdAt: new Date().toISOString()
				});

				notificationService.info(`Workflow '${name}' created successfully!`);
				closeModal();
				await editorService.openEditor(new WorkflowEditorInput(targetFolderUri, name), { pinned: true });
			} catch (err) {
				notificationService.error(`Failed to create workflow: ${err}`);
			}
		};

		setTimeout(() => nameInput.focus(), 50);
	});
}
