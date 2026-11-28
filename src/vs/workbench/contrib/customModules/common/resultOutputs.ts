/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Publishing of components with a structured result (git, shell, button_group), CI-67, used by every run path (whole
 * ticket run, workflow node, single card run on the ticket page). What users and the AI are told is only the card
 * rules (CI-69, CARD_OUTPUT_RULES): `name` = the card's output (git / shell: stdout, or stderr on failure;
 * button_group: clicked label) under the title (TICKET_CONTEXT["<Title>"]) and the card's variable ({var}, and the
 * plain variable in Python). For each name in [label, label_key, ...aliases]:
 * - `name`          = the card's output (the documented value)
 * - `name_result` and `name.field` = INTERNAL compatibility names for tickets written before CI-69; they still work
 *   but are never documented, displayed or suggested.
 * The component id and the cleaned output variable get the main text from the caller.
 */
export function publishResultOutputs(context: Record<string, unknown>, label: string, main: unknown, fields: Readonly<Record<string, unknown>>, aliases: readonly (string | undefined)[] = []): void {
	for (const name of resultOutputNames(label, aliases)) {
		context[name] = main;
		context[`${name}_result`] = { ...fields };
		for (const [field, value] of Object.entries(fields)) {
			context[`${name}.${field}`] = value;
		}
	}
}

/** Names a result is published under: the label, its cleaned key (lowercase, other characters -> `_`), the aliases. */
export function resultOutputNames(label: string, aliases: readonly (string | undefined)[] = []): string[] {
	return [...new Set([label, resultLabelKey(label), ...aliases.filter((a): a is string => !!a && !!a.trim()).map(a => a.trim())])].filter(n => !!n);
}

/** Cleaned label key (same as outputLabelKey / the runtime's _cleanKey). */
export function resultLabelKey(label: string): string {
	return label.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
}
