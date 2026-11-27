/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { FREESTYLE_PROGRAMMATIC_CREATE_ERROR, getReservedFreestyleNameMessage, getReservedFreestyleTemplateNameError, isReservedFreestyleName, isReservedFreestyleTemplate } from './freestyleTicket.js';
import { clashesWithSubWorkflowType, getSubWorkflowTemplateClashMessage, isSubWorkflowTicketType } from './subWorkflowType.js';

/**
 * Template names that clash with a built-in ticket type. Two built-in types have no template: Freestyle (its own rules,
 * see `freestyleTicket.ts`) and Sub-Workflow (see `subWorkflowType.ts`). A template may not be created with, or renamed
 * to, either name, and lists of templates leave such a (legacy) template out. The two types are otherwise unrelated.
 */

/** True for the name of a built-in ticket type without a template (Freestyle or Sub-Workflow, any spelling). */
export function isBuiltInTicketTypeName(value: string | undefined | null): boolean {
	return isReservedFreestyleName(value) || isSubWorkflowTicketType(value);
}

/** True when a template's id or name clashes with a built-in ticket type (Freestyle or Sub-Workflow). */
export function clashesWithBuiltInTicketType(template: { id?: string; name?: string } | undefined | null): boolean {
	return isReservedFreestyleTemplate(template) || clashesWithSubWorkflowType(template);
}

/** Error shown when a template would be created or renamed to a built-in ticket type name. */
export function getTemplateNameClashMessage(value: string): string {
	if (isSubWorkflowTicketType(value)) {
		return getSubWorkflowTemplateClashMessage(value);
	}
	return getReservedFreestyleNameMessage(value);
}

/**
 * Validates a template's identity: an error when it would be created with, or renamed to, a built-in ticket type name;
 * `undefined` when allowed. A template that already existed with exactly the same id and name (legacy data) is left
 * alone, so saving unrelated changes keeps working.
 */
export function getTemplateNameClashError(template: { id?: string; name?: string }, existing?: { id?: string; name?: string }): string | undefined {
	const freestyleError = getReservedFreestyleTemplateNameError(template, existing);
	if (freestyleError || isReservedFreestyleTemplate(template) || !clashesWithSubWorkflowType(template)) {
		return freestyleError;
	}
	const sameIdentity = !!existing
		&& (existing.id || '').toLowerCase() === (template.id || '').toLowerCase()
		&& (existing.name || '') === (template.name || '');
	if (sameIdentity) {
		return undefined;
	}
	return getSubWorkflowTemplateClashMessage(isSubWorkflowTicketType(template.name) ? (template.name || '') : (template.id || ''));
}

/**
 * Error to report when a program / AI creates a ticket from a matched template whose name clashes with a built-in
 * ticket type (the ticket would be read as that type). `undefined` when the template is fine.
 */
export function getTemplateCreateTypeError(template: { id?: string; name?: string } | undefined | null): string | undefined {
	if (!template) {
		return undefined;
	}
	if (isReservedFreestyleTemplate(template)) {
		return FREESTYLE_PROGRAMMATIC_CREATE_ERROR;
	}
	if (clashesWithSubWorkflowType(template)) {
		return getSubWorkflowTemplateClashMessage(template.name || template.id || '');
	}
	return undefined;
}
