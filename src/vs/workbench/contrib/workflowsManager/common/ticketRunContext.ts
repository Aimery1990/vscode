/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ICustomField } from '../../entityPersistence/common/entityPersistence.js';
import { gitMainOutput, gitOutputFields, normalizeGitTicketValue } from '../../customModules/common/gitComponent.js';
import { outputVariableNameOf } from '../../customModules/common/outputVariable.js';
import { publishResultOutputs } from '../../customModules/common/resultOutputs.js';
import { normalizeShellTicketValue, shellMainOutput, shellOutputFields } from '../../customModules/common/shellComponent.js';
import { buttonGroupOutputFields, parseButtonGroupValue } from './humanDecision.js';

/** What a ticket run knows about the ticket (TicketWorkflowRuntime.getTicket result). */
export interface ITicketRunIdentity {
	/** Ticket title (README.md `Title`). */
	readonly title?: string;
	/** Ticket description (README.md `Description`). */
	readonly description?: string;
	/** Folder name of the ticket, i.e. its ID (e.g. ANYAG-0118). */
	readonly ticketName?: string;
}

function firstText(...values: unknown[]): string {
	for (const v of values) {
		if (typeof v === 'string' && v !== '') {
			return v;
		}
	}
	return '';
}

/**
 * Value of the root Title field during a ticket run, published as `title` (so `{Title}` resolves to it): an input
 * override, then a stored `title` value, then the ticket's own title. The ticket ID (folder name) is only the last
 * fallback, for a ticket without a title.
 */
export function ticketRunTitle(inputOverrides: Record<string, unknown>, customMetadata: Record<string, unknown>, ticket: ITicketRunIdentity): string {
	return firstText(inputOverrides['title'], customMetadata['title'], ticket.title, ticket.ticketName);
}

/** Value of the root Description field during a ticket run, published as `description`: like the title, the ticket's own
 * description comes before the field's default content. */
export function ticketRunDescription(inputOverrides: Record<string, unknown>, customMetadata: Record<string, unknown>, ticket: ITicketRunIdentity, defaultContent?: string): string {
	return firstText(inputOverrides['description'], customMetadata['description'], ticket.description, defaultContent);
}

/**
 * Value of a root field (`title` / `description`) when {variables} are resolved outside a whole-ticket run, e.g. by a
 * card's own Run button on the ticket page (CI-63): the same values as a ticket run (ticketRunTitle /
 * ticketRunDescription, no input overrides), so `{Title}` is the ticket's README title there too. undefined for any
 * other field.
 */
export function ticketRootFieldValue(fieldId: string | undefined, customMetadata: Record<string, unknown>, ticket: ITicketRunIdentity, defaultContent?: string): string | undefined {
	if (fieldId === 'title') {
		return ticketRunTitle({}, customMetadata, ticket);
	}
	if (fieldId === 'description') {
		return ticketRunDescription({}, customMetadata, ticket, defaultContent);
	}
	return undefined;
}

/** The parts of a component needed to publish its last stored result. */
export type IStoredResultField = Pick<ICustomField, 'id' | 'label' | 'type' | 'outputVariableName' | 'gitLastResult' | 'shellLastResult'>;

/** The main output and fields of a component's last stored result, or undefined (not a result component / never run). */
export function storedComponentResult(field: IStoredResultField, rawValue: unknown): { main: string; fields: Record<string, unknown> } | undefined {
	switch (field.type) {
		case 'git': {
			const last = normalizeGitTicketValue(rawValue)?.gitLastResult ?? field.gitLastResult;
			return last ? { main: gitMainOutput(last), fields: gitOutputFields(last) } : undefined;
		}
		case 'shell': {
			const last = normalizeShellTicketValue(rawValue)?.shellLastResult ?? field.shellLastResult;
			return last ? { main: shellMainOutput(last), fields: shellOutputFields(last) } : undefined;
		}
		case 'button_group': {
			const decision = parseButtonGroupValue(rawValue);
			return decision ? { main: decision.label, fields: buttonGroupOutputFields(decision) } : undefined;
		}
		default:
			return undefined;
	}
}

/**
 * Publishes the LAST STORED results of the ticket's result components (git, shell, button_group: CI-24 / CI-55 /
 * CI-25 keep it in the ticket value) into `context`, with the same rule as when the component runs in a whole ticket
 * run (publishResultOutputs, CI-67): label / label_key / output variable = main text, `<name>_result` = dict,
 * `<name>.field` = each field; the component id = main text too. Used when a card
 * runs on its own (the ticket page's Run Script) and before a whole run starts (a card that has not run yet in this
 * run shows its last result in the same shape). Fields without a stored result are left alone.
 * `lookup` finds the stored value of a field (default: by label, then by id). Returns the labels published.
 */
export function publishStoredComponentResults(context: Record<string, unknown>, fields: readonly IStoredResultField[] | undefined, customMetadata: Record<string, unknown>, lookup?: (field: IStoredResultField) => unknown): string[] {
	const published: string[] = [];
	for (const field of fields ?? []) {
		if (!field || !field.type) {
			continue;
		}
		const label = field.label || field.id;
		if (!label) {
			continue;
		}
		const raw = lookup ? lookup(field) : (customMetadata[label] ?? (field.id ? customMetadata[field.id] : undefined));
		const result = storedComponentResult(field, raw);
		if (!result) {
			continue;
		}
		const varName = outputVariableNameOf(field, label);
		publishResultOutputs(context, label, result.main, result.fields, [varName]);
		if (field.id) {
			context[field.id] = result.main;
		}
		published.push(label);
	}
	return published;
}
