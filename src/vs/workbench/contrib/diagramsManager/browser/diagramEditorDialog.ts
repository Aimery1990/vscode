/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';

export interface IDiagramDialogResult {
	name: string;
	description?: string;
	targetFolderUri?: URI;
}

export async function createDiagramDialog(
	workspaceContextService: IWorkspaceContextService,
	fileDialogService: IFileDialogService,
	pathService: IPathService,
	onConfirm: (result: IDiagramDialogResult) => void
): Promise<void> {
	// Remove any existing dialog
	const existing = document.getElementById('create-diagram-dialog-overlay');
	if (existing) {
		existing.remove();
	}

	const overlay = document.createElement('div');
	overlay.id = 'create-diagram-dialog-overlay';
	overlay.style.position = 'fixed';
	overlay.style.top = '0';
	overlay.style.left = '0';
	overlay.style.width = '100vw';
	overlay.style.height = '100vh';
	overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.55)';
	overlay.style.display = 'flex';
	overlay.style.alignItems = 'center';
	overlay.style.justifyContent = 'center';
	overlay.style.zIndex = '100000';
	overlay.style.backdropFilter = 'blur(4px)';

	const modal = append(overlay, $('.create-diagram-modal'));
	modal.style.width = '480px';
	modal.style.backgroundColor = 'var(--vscode-sideBar-background, #1e1e1e)';
	modal.style.border = '1px solid var(--vscode-widget-border, #333)';
	modal.style.borderRadius = '8px';
	modal.style.boxShadow = '0 12px 32px rgba(0, 0, 0, 0.5)';
	modal.style.display = 'flex';
	modal.style.flexDirection = 'column';
	modal.style.overflow = 'hidden';
	modal.style.fontFamily = 'var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif)';
	modal.style.animation = 'workflowModalFadeIn 0.15s ease-out';

	// Header
	const header = append(modal, $('.modal-header'));
	header.style.padding = '14px 18px';
	header.style.borderBottom = '1px solid var(--vscode-panel-border, rgba(255,255,255,0.08))';
	header.style.display = 'flex';
	header.style.alignItems = 'center';
	header.style.justifyContent = 'space-between';
	header.style.fontFamily = 'inherit';

	const titleRow = append(header, $('.title-row'));
	titleRow.style.display = 'flex';
	titleRow.style.alignItems = 'center';
	titleRow.style.gap = '8px';

	const iconSpan = append(titleRow, $('span' + ThemeIcon.asCSSSelector(Codicon.graph)));
	iconSpan.style.color = 'var(--vscode-charts-purple, #a855f7)';
	iconSpan.style.fontSize = '16px';

	const titleText = append(titleRow, $('span'));
	titleText.textContent = 'Create New Diagram';
	titleText.style.fontWeight = '600';
	titleText.style.fontSize = '14px';
	titleText.style.color = 'var(--vscode-foreground, #fff)';
	titleText.style.fontFamily = 'inherit';

	const closeBtn = append(header, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
	closeBtn.style.cursor = 'pointer';
	closeBtn.style.opacity = '0.7';
	closeBtn.onclick = () => overlay.remove();

	// Body
	const body = append(modal, $('.modal-body'));
	body.style.padding = '18px';
	body.style.display = 'flex';
	body.style.flexDirection = 'column';
	body.style.gap = '14px';

	// 1. Diagram Name Input
	const nameGroup = append(body, $('.form-group'));
	const nameLabel = append(nameGroup, $('label'));
	nameLabel.textContent = 'Diagram Name *';
	nameLabel.style.fontSize = '12px';
	nameLabel.style.fontWeight = '500';
	nameLabel.style.color = 'var(--vscode-descriptionForeground, #999)';
	nameLabel.style.marginBottom = '6px';
	nameLabel.style.display = 'block';

	const nameInput = append(nameGroup, $('input.vscode-input')) as HTMLInputElement;
	nameInput.type = 'text';
	nameInput.placeholder = 'e.g. System Architecture, Auth Flow, Order Pipeline';
	nameInput.style.width = '100%';
	nameInput.style.padding = '8px 10px';
	nameInput.style.borderRadius = '4px';
	nameInput.style.border = '1px solid var(--vscode-input-border, #3c3c3c)';
	nameInput.style.backgroundColor = 'var(--vscode-input-background, #252526)';
	nameInput.style.color = 'var(--vscode-input-foreground, #fff)';
	nameInput.style.fontFamily = 'inherit';
	nameInput.style.fontSize = '12px';
	nameInput.style.outline = 'none';
	nameInput.style.boxSizing = 'border-box';

	// 2. Storage Directory (Clean Single Location Row)
	const folders = workspaceContextService.getWorkspace().folders;
	const userHome = await pathService.userHome();
	let initialFolder = joinPath(userHome, 'diagrams').fsPath;
	if (folders.length > 0) {
		initialFolder = folders[0].uri.fsPath;
	}

	const locGroup = append(body, $('.form-group'));
	const locLabel = append(locGroup, $('label'));
	locLabel.textContent = 'Save Directory';
	locLabel.style.fontSize = '12px';
	locLabel.style.fontWeight = '500';
	locLabel.style.color = 'var(--vscode-descriptionForeground, #999)';
	locLabel.style.marginBottom = '6px';
	locLabel.style.display = 'block';

	const locRow = append(locGroup, $('.location-input-row'));
	locRow.style.display = 'flex';
	locRow.style.gap = '8px';
	locRow.style.alignItems = 'center';

	const locInput = append(locRow, $('input.vscode-input')) as HTMLInputElement;
	locInput.type = 'text';
	locInput.value = initialFolder;
	locInput.placeholder = 'Select any folder on your computer...';
	locInput.style.flex = '1';
	locInput.style.padding = '8px 10px';
	locInput.style.borderRadius = '4px';
	locInput.style.border = '1px solid var(--vscode-input-border, #3c3c3c)';
	locInput.style.backgroundColor = 'var(--vscode-input-background, #252526)';
	locInput.style.color = 'var(--vscode-input-foreground, #fff)';
	locInput.style.fontFamily = 'inherit';
	locInput.style.fontSize = '12px';
	locInput.style.outline = 'none';
	locInput.style.boxSizing = 'border-box';

	const browseBtn = append(locRow, $('button.vscode-button.secondary'));
	browseBtn.textContent = 'Browse...';
	browseBtn.style.padding = '7px 12px';
	browseBtn.style.borderRadius = '4px';
	browseBtn.style.border = '1px solid var(--vscode-button-secondaryBorder, #444)';
	browseBtn.style.backgroundColor = 'var(--vscode-button-secondaryBackground, #3a3d41)';
	browseBtn.style.color = 'var(--vscode-button-secondaryForeground, #fff)';
	browseBtn.style.fontFamily = 'inherit';
	browseBtn.style.fontSize = '12px';
	browseBtn.style.cursor = 'pointer';
	browseBtn.style.whiteSpace = 'nowrap';

	browseBtn.onclick = async () => {
		const res = await fileDialogService.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			defaultUri: URI.file(locInput.value.trim() || initialFolder),
			title: 'Select Folder for Diagram'
		});
		if (res && res.length > 0) {
			locInput.value = res[0].fsPath;
		}
	};

	// 3. Description Input
	const descGroup = append(body, $('.form-group'));
	const descLabel = append(descGroup, $('label'));
	descLabel.textContent = 'Description (Optional)';
	descLabel.style.fontSize = '12px';
	descLabel.style.fontWeight = '500';
	descLabel.style.color = 'var(--vscode-descriptionForeground, #999)';
	descLabel.style.marginBottom = '6px';
	descLabel.style.display = 'block';

	const descInput = append(descGroup, $('textarea.vscode-input')) as HTMLTextAreaElement;
	descInput.placeholder = 'Brief description of this flowchart or diagram...';
	descInput.rows = 2;
	descInput.style.width = '100%';
	descInput.style.padding = '8px 10px';
	descInput.style.borderRadius = '4px';
	descInput.style.border = '1px solid var(--vscode-input-border, #3c3c3c)';
	descInput.style.backgroundColor = 'var(--vscode-input-background, #252526)';
	descInput.style.color = 'var(--vscode-input-foreground, #fff)';
	descInput.style.fontFamily = 'inherit';
	descInput.style.fontSize = '12px';
	descInput.style.outline = 'none';
	descInput.style.resize = 'vertical';
	descInput.style.boxSizing = 'border-box';

	// Footer
	const footer = append(modal, $('.modal-footer'));
	footer.style.padding = '12px 18px';
	footer.style.borderTop = '1px solid var(--vscode-panel-border, rgba(255,255,255,0.08))';
	footer.style.display = 'flex';
	footer.style.justifyContent = 'flex-end';
	footer.style.gap = '10px';

	const cancelBtn = append(footer, $('button.vscode-button.secondary'));
	cancelBtn.textContent = 'Cancel';
	cancelBtn.style.padding = '6px 14px';
	cancelBtn.style.borderRadius = '4px';
	cancelBtn.style.border = '1px solid var(--vscode-button-secondaryBorder, #444)';
	cancelBtn.style.backgroundColor = 'var(--vscode-button-secondaryBackground, #3a3d41)';
	cancelBtn.style.color = 'var(--vscode-button-secondaryForeground, #fff)';
	cancelBtn.style.fontFamily = 'inherit';
	cancelBtn.style.fontSize = '12px';
	cancelBtn.style.cursor = 'pointer';
	cancelBtn.onclick = () => overlay.remove();

	const createBtn = append(footer, $('button.vscode-button'));
	createBtn.textContent = 'Create Diagram';
	createBtn.style.padding = '6px 16px';
	createBtn.style.borderRadius = '4px';
	createBtn.style.border = 'none';
	createBtn.style.backgroundColor = 'var(--vscode-button-background, #007acc)';
	createBtn.style.color = 'var(--vscode-button-foreground, #fff)';
	createBtn.style.fontFamily = 'inherit';
	createBtn.style.fontSize = '12px';
	createBtn.style.fontWeight = '600';
	createBtn.style.cursor = 'pointer';

	const doSubmit = () => {
		const name = nameInput.value.trim();
		if (!name) {
			nameInput.focus();
			nameInput.style.borderColor = 'var(--vscode-inputValidation-errorBorder, #f43f5e)';
			return;
		}
		const folderPath = locInput.value.trim();
		if (!folderPath) {
			locInput.focus();
			locInput.style.borderColor = 'var(--vscode-inputValidation-errorBorder, #f43f5e)';
			return;
		}

		overlay.remove();
		onConfirm({
			name,
			description: descInput.value.trim() || undefined,
			targetFolderUri: URI.file(folderPath)
		});
	};

	createBtn.onclick = doSubmit;
	nameInput.onkeydown = (e) => {
		if (e.key === 'Enter') doSubmit();
		if (e.key === 'Escape') overlay.remove();
	};

	document.body.appendChild(overlay);
	setTimeout(() => nameInput.focus(), 50);
}
