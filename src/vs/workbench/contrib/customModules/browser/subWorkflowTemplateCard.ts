/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ICustomField } from '../../entityPersistence/common/entityPersistence.js';
import { ISubWorkflowDefinition } from '../../workflowsManager/common/workflowExecutionModel.js';
import { IWorkflowExecutionService } from '../../workflowsManager/common/workflowExecutionService.js';
import { ISubWorkflowCardContract, applySubWorkflowContractToField, describeSelectedSubWorkflow } from '../common/subWorkflowField.js';

/**
 * Call Sub-Workflow card in the template designer (CI-38): the picker row that links the card to a sub_workflow
 * ticket. Inputs and the read-only outputs are rendered by the designer's existing Call Sub-Workflow box.
 */
export interface ISubWorkflowCardHost {
	readonly executionService: IWorkflowExecutionService;
	readonly quickInputService: IQuickInputService;
	readonly notificationService: INotificationService;
	/** The template being edited: checked for call cycles before a Sub-Workflow is linked. */
	readonly template: { readonly id: string; readonly name: string; readonly fields: readonly ICustomField[]; readonly workspaceUri?: URI };
	register(disposable: IDisposable): void;
	/** The field changed: sync, save and re-render. */
	onDidChangeField(): void;
}

interface ISubWorkflowPick extends IQuickPickItem {
	readonly def: ISubWorkflowDefinition;
}

function toContract(def: ISubWorkflowDefinition): ISubWorkflowCardContract {
	return { id: def.id, name: def.name, sourceWorkflowUri: def.sourceWorkflowUri, inputs: def.inputs || [], outputs: def.outputs || [] };
}

/** Quick pick over the known sub_workflow tickets (name + ticket ID). */
export async function pickSubWorkflow(executionService: IWorkflowExecutionService, quickInputService: IQuickInputService, currentId?: string): Promise<ISubWorkflowDefinition | undefined> {
	await executionService.whenSubWorkflowsReady();
	const defs = [...executionService.getSubWorkflows()].sort((a, b) => a.name.localeCompare(b.name));
	if (defs.length === 0) {
		return undefined;
	}
	const picks: ISubWorkflowPick[] = defs.map(def => ({
		def,
		label: def.name,
		description: def.id === currentId ? `${def.id} (current)` : def.id,
		detail: `${(def.inputs || []).length} input(s), ${(def.outputs || []).length} output(s)${def.sourceWorkflowName ? ` - from ${def.sourceWorkflowName}` : ''}`
	}));
	const picked = await quickInputService.pick(picks, { placeHolder: 'Select the sub-workflow to call (sub_workflow tickets)', matchOnDescription: true, matchOnDetail: true });
	return picked?.def;
}

/** The current calling contract of a linked Sub-Workflow (used by the card's Refresh button outside a workflow). */
export async function resolveSubWorkflowContract(executionService: IWorkflowExecutionService, reference: string, contextUri?: string): Promise<ISubWorkflowCardContract | undefined> {
	const def = await executionService.resolveSubWorkflow(reference, contextUri);
	return def ? toContract(def) : undefined;
}

/**
 * Links `field` to `def` unless that would make the template's calls a cycle; then shows the error naming the chain
 * and leaves the card unchanged. Returns true when the card was linked.
 */
export async function linkSubWorkflowToCard(field: ICustomField, def: ISubWorkflowDefinition, host: ISubWorkflowCardHost): Promise<boolean> {
	const candidateFields = host.template.fields.map(f => f === field ? { ...f, subWorkflowId: def.id } : f);
	const cycleError = await host.executionService.checkSubWorkflowCallCycle(
		{ kind: 'template', key: host.template.id, label: host.template.name, fields: candidateFields },
		def.ticketFolderUri,
		host.template.workspaceUri
	);
	if (cycleError) {
		host.notificationService.error(`Cannot call '${def.name}' (${def.id}) here. ${cycleError}`);
		return false;
	}
	applySubWorkflowContractToField(field, toContract(def));
	return true;
}

/** Up-front recursion check of a template being saved: the error naming the cycle, or undefined (also without cards). */
export async function checkTemplateCallCycle(executionService: IWorkflowExecutionService, template: { id: string; name: string; fields?: readonly ICustomField[] }, workspaceUri?: URI): Promise<string | undefined> {
	const fields = template.fields || [];
	if (!fields.some(f => f && f.type === 'sub_workflow' && !f.disabled)) {
		return undefined;
	}
	return executionService.checkSubWorkflowCallCycle({ kind: 'template', key: template.id, label: template.name, fields }, undefined, workspaceUri);
}

/**
 * Generate-template tool (CI-38): every Call Sub-Workflow card must name an existing sub_workflow ticket and bind only
 * its inputs; its name and input / output definitions are filled from the ticket. Then the template's calls must not
 * form a cycle. Returns the first error, or undefined. Mutates the cards of `template`.
 */
export async function prepareTemplateSubWorkflowCards(executionService: IWorkflowExecutionService, template: { id: string; name: string; fields?: ICustomField[] }, workspaceUri?: URI): Promise<string | undefined> {
	const cards = (template.fields || []).filter(f => f && f.type === 'sub_workflow');
	if (cards.length === 0) {
		return undefined;
	}
	await executionService.whenSubWorkflowsReady();
	for (const card of cards) {
		const reference = (card.subWorkflowId || '').trim();
		if (!reference) {
			return `Call Sub-Workflow '${card.label}' needs subWorkflowId: a sub_workflow ticket ID. Find one with GET_TICKETS(ticket_type="sub_workflow").`;
		}
		const def = await executionService.resolveSubWorkflow(reference);
		if (!def) {
			return `Call Sub-Workflow '${card.label}': no sub_workflow ticket with ID '${reference}'. Find sub-workflows with GET_TICKETS(ticket_type="sub_workflow") and use the ticket ID.`;
		}
		const known = new Set((def.inputs || []).map(i => i.name));
		const unknown = Object.keys(card.subWorkflowInputs || {}).filter(name => !known.has(name));
		if (unknown.length > 0) {
			return `Call Sub-Workflow '${card.label}': ${def.name} (${def.id}) has no input(s) ${unknown.join(', ')}. Its inputs are: ${[...known].join(', ') || '(none)'}.`;
		}
		// Re-linking the same id keeps the given bindings
		card.subWorkflowId = def.id;
		applySubWorkflowContractToField(card, toContract(def));
	}
	return checkTemplateCallCycle(executionService, template, workspaceUri);
}

/** Renders the "Sub-Workflow: Name (ID) [pick]" row of a template card. */
export function renderSubWorkflowPickerRow(container: HTMLElement, field: ICustomField, host: ISubWorkflowCardHost): void {
	const row = append(container, $('div', {
		style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px;'
	}));
	append(row, $('span', { style: 'font-weight: 600; color: #c084fc;' }, 'Sub-Workflow:'));
	const selected = describeSelectedSubWorkflow(field);
	append(row, $('span', {
		style: `font-family: var(--vscode-editor-font-family, monospace); ${selected ? 'color: #e2e8f0;' : 'opacity: 0.6; font-style: italic;'}`,
		title: selected ? `Ticket ID: ${field.subWorkflowId}` : 'No sub-workflow selected yet'
	}, selected ?? '(none selected)'));
	const pickBtn = append(row, $('button', {
		type: 'button',
		title: 'Choose the sub-workflow to call (lists sub_workflow tickets by name and ticket ID)',
		'aria-label': 'Choose sub-workflow',
		style: 'display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 20px; padding: 0; border-radius: 4px; cursor: pointer; background: rgba(34, 211, 238, 0.14); border: 1px solid rgba(34, 211, 238, 0.4); color: #67e8f9;'
	})) as HTMLButtonElement;
	append(pickBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.search)));
	host.register(addDisposableListener(pickBtn, 'click', async e => {
		e.stopPropagation();
		try {
			const def = await pickSubWorkflow(host.executionService, host.quickInputService, field.subWorkflowId);
			if (!def) {
				if (host.executionService.getSubWorkflows().length === 0) {
					host.notificationService.info('No sub-workflows found. Create one by encapsulating nodes on a workflow canvas, or with CREATE_TICKETS(ticket_type="sub_workflow", ...).');
				}
				return;
			}
			if (await linkSubWorkflowToCard(field, def, host)) {
				host.onDidChangeField();
			}
		} catch (err) {
			host.notificationService.error(`Could not select a sub-workflow: ${err instanceof Error ? err.message : String(err)}`);
		}
	}));
}
