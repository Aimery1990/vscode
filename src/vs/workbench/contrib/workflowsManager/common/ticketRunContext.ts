/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

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
