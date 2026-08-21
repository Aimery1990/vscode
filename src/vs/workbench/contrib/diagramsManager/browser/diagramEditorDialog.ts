/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';

export interface IDiagramDialogResult {
	name: string;
	description?: string;
	targetWorkspaceUri?: URI;
}

export function createDiagramDialog(
	workspaceContextService: IWorkspaceContextService,
	onConfirm: (result: IDiagramDialogResult) => void
): void {
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
	modal.style.width = '460px';
	modal.style.backgroundColor = 'var(--vscode-sideBar-background, #1e1e1e)';
	modal.style.border = '1px solid var(--vscode-widget-border, #333)';
	modal.style.borderRadius = '8px';
	modal.style.boxShadow = '0 12px 32px rgba(0, 0, 0, 0.5)';
	modal.style.display = 'flex';
	modal.style.flexDirection = 'column';
	modal.style.overflow = 'hidden';
	modal.style.animation = 'workflowModalFadeIn 0.15s ease-out';

	// Header
	const header = append(modal, $('.modal-header'));
	header.style.padding = '14px 18px';
	header.style.borderBottom = '1px solid var(--vscode-panel-border, rgba(255,255,255,0.08))';
	header.style.display = 'flex';
	header.style.alignItems = 'center';
	header.style.justifyContent = 'space-between';

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

	// Name Input
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
	nameInput.style.outline = 'none';
	nameInput.style.boxSizing = 'border-box';

	// Description Input
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
	descInput.style.outline = 'none';
	descInput.style.resize = 'vertical';
	descInput.style.boxSizing = 'border-box';

	// Workspace selector if multiple
	const folders = workspaceContextService.getWorkspace().folders;
	let selectedWorkspaceUri = folders.length > 0 ? folders[0].uri : undefined;
	if (folders.length > 1) {
		const wsGroup = append(body, $('.form-group'));
		const wsLabel = append(wsGroup, $('label'));
		wsLabel.textContent = 'Save To Workspace';
		wsLabel.style.fontSize = '12px';
		wsLabel.style.fontWeight = '500';
		wsLabel.style.color = 'var(--vscode-descriptionForeground, #999)';
		wsLabel.style.marginBottom = '6px';
		wsLabel.style.display = 'block';

		const select = append(wsGroup, $('select.vscode-select')) as HTMLSelectElement;
		select.style.width = '100%';
		select.style.padding = '6px 10px';
		select.style.borderRadius = '4px';
		select.style.border = '1px solid var(--vscode-input-border, #3c3c3c)';
		select.style.backgroundColor = 'var(--vscode-input-background, #252526)';
		select.style.color = 'var(--vscode-input-foreground, #fff)';
		select.style.boxSizing = 'border-box';

		for (const f of folders) {
			const opt = append(select, $('option')) as HTMLOptionElement;
			opt.value = f.uri.toString();
			opt.textContent = f.name;
		}
		select.onchange = () => {
			selectedWorkspaceUri = URI.parse(select.value);
		};
	}

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
	cancelBtn.style.cursor = 'pointer';
	cancelBtn.onclick = () => overlay.remove();

	const createBtn = append(footer, $('button.vscode-button'));
	createBtn.textContent = 'Create Diagram';
	createBtn.style.padding = '6px 16px';
	createBtn.style.borderRadius = '4px';
	createBtn.style.border = 'none';
	createBtn.style.backgroundColor = 'var(--vscode-button-background, #007acc)';
	createBtn.style.color = 'var(--vscode-button-foreground, #fff)';
	createBtn.style.fontWeight = '600';
	createBtn.style.cursor = 'pointer';

	const doSubmit = () => {
		const name = nameInput.value.trim();
		if (!name) {
			nameInput.focus();
			nameInput.style.borderColor = 'var(--vscode-inputValidation-errorBorder, #f43f5e)';
			return;
		}
		overlay.remove();
		onConfirm({
			name,
			description: descInput.value.trim() || undefined,
			targetWorkspaceUri: selectedWorkspaceUri
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
