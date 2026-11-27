/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * The `sub_workflow` ticket type (CI-23). A Sub-Workflow ticket is an independent workflow: it has its own canvas
 * (opened in the normal Workflow Editor), its definition is stored in `<ticket folder>/.agents/sub_workflow.json`, and
 * workflows call it by its ticket ID with a Call Sub-Workflow step. It is created by extracting nodes from a workflow
 * canvas, or by programs / AI inside a workflow folder. Sub-Workflow tickets have no template; a template whose id or
 * name spells `sub_workflow` would clash with this built-in type (see `templateNameClash.ts`).
 */
export const SUB_WORKFLOW_TICKET_TYPE = 'sub_workflow';

export const SUB_WORKFLOW_TYPE_DEFINITION = 'A Sub-Workflow ticket is an independent workflow with its own canvas, kept inside the workflow folder it was extracted from (or created in by a program / AI). Its definition (nodes, links, inputs / outputs) is stored in .agents/sub_workflow.json inside the ticket folder; workflows call it by its ticket ID and always run its latest saved definition.';
export const SUB_WORKFLOW_TYPE_PROMPT = 'A Sub-Workflow ticket is called from workflows by its ticket ID (Call Sub-Workflow step). Open the ticket to edit its own canvas; every caller uses the latest saved version.';

/** Lowercase without whitespace, `-` and `_`, so `Sub Workflow`, `sub-workflow` and `SUBWORKFLOW` all match. */
function normalizeTypeName(value: string | undefined | null): string {
	return (value || '').toLowerCase().replace(/[\s_-]+/g, '');
}

const NORMALIZED_SUB_WORKFLOW_TYPE = normalizeTypeName(SUB_WORKFLOW_TICKET_TYPE);

/** True for the Sub-Workflow ticket type in any spelling (`sub_workflow`, `Sub Workflow`, `sub-workflow`, ...). */
export function isSubWorkflowTicketType(ticketType: string | undefined | null): boolean {
	return normalizeTypeName(ticketType) === NORMALIZED_SUB_WORKFLOW_TYPE;
}

/** True when a template's id or name spells the `sub_workflow` type: such a template would clash with it. */
export function clashesWithSubWorkflowType(template: { id?: string; name?: string } | undefined | null): boolean {
	return !!template && (isSubWorkflowTicketType(template.id) || isSubWorkflowTicketType(template.name));
}

/** Error for a template whose id or name clashes with the built-in `sub_workflow` ticket type. */
export function getSubWorkflowTemplateClashMessage(templateName: string): string {
	return `The template name "${templateName}" clashes with the built-in sub_workflow ticket type (Sub-Workflow tickets are created without a template). Please choose a different template name.`;
}
