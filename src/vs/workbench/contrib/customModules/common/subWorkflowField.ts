/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ICustomField } from '../../entityPersistence/common/entityPersistence.js';

/** The part of a Sub-Workflow definition a Call Sub-Workflow card shows (its calling contract). */
export interface ISubWorkflowCardContract {
	readonly id: string;
	readonly name: string;
	readonly sourceWorkflowUri?: string;
	readonly inputs: readonly { readonly name: string; readonly label?: string; readonly defaultValue?: string; readonly description?: string }[];
	readonly outputs: readonly { readonly label: string; readonly varName: string; readonly defaultFormat?: string }[];
}

/**
 * Links a Call Sub-Workflow card (template or node) to a Sub-Workflow (CI-38): stores its ticket ID and name, copies
 * its input / output definitions (outputs are shown read-only, they are never user defined) and keeps the bindings of
 * inputs that still exist. New inputs start empty, so the Sub-Workflow default applies at run time.
 */
export function applySubWorkflowContractToField(field: ICustomField, contract: ISubWorkflowCardContract): void {
	// Bindings are only kept when the same Sub-Workflow is re-linked (refresh), never across Sub-Workflows
	const previous: Record<string, string> = (field.subWorkflowId === contract.id && field.subWorkflowInputs && typeof field.subWorkflowInputs === 'object') ? field.subWorkflowInputs : {};
	field.subWorkflowId = contract.id;
	field.subWorkflowName = contract.name;
	if (contract.sourceWorkflowUri) {
		field.subWorkflowSourceUri = contract.sourceWorkflowUri;
	}
	field.subWorkflowInputDefs = contract.inputs.map(i => ({ name: i.name, label: i.label, defaultValue: i.defaultValue }));
	field.subWorkflowOutputDefs = contract.outputs.map(o => ({ label: o.label, varName: o.varName, defaultFormat: o.defaultFormat }));
	const nextInputs: Record<string, string> = {};
	for (const input of contract.inputs) {
		nextInputs[input.name] = Object.prototype.hasOwnProperty.call(previous, input.name) ? previous[input.name] : '';
	}
	field.subWorkflowInputs = nextInputs;
}

/** `Name (ID)` of the card's Sub-Workflow, or undefined when none is selected. */
export function describeSelectedSubWorkflow(field: Pick<ICustomField, 'subWorkflowId' | 'subWorkflowName'>): string | undefined {
	const id = (field.subWorkflowId || '').trim();
	if (!id) {
		return undefined;
	}
	const name = (field.subWorkflowName || '').trim();
	return name && name !== id ? `${name} (${id})` : id;
}
