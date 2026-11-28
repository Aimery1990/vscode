/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * The ONE publishing rule for components with a structured result (git, shell, button_group), CI-67. Every run path
 * uses it: a whole ticket run, a workflow node, and a single card run on the ticket page (where the other cards'
 * last stored results are published with it). For each name in [label, label_key, ...aliases] (aliases = the output
 * variable, UI-27):
 * - `name`          = the main output text (git / shell: stdout, or stderr on failure; button_group: clicked label)
 * - `name_result`   = all fields as one dict (Python: `TICKET_CONTEXT["branch_list_result"]["branch"]`)
 * - `name.field`    = each field (`{Branch List.branch}`, `{branch_list.exitCode}`)
 * So `TICKET_CONTEXT["Branch List"]` is always the TEXT and `TICKET_CONTEXT["<var>_result"]` the dict. The component
 * id and the cleaned output variable get the main text from the caller (the runtime's generic step output block).
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
