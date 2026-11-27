/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ticket labels (UI-13).
 *
 * - The workspace defines its labels in the root `ticket.md` as `- **Ticket Labels**: [{"name":"...","color":"#rrggbb"}]`
 *   (JSON, written in Profile Data and in "Self Defined Data Value", like `Status Mapping`).
 * - Each ticket stores its labels in its own `ticket.md` as `- **Labels**: a, b` (next to Status / Priority).
 *   No labels is written as `None`. Label names therefore never contain commas.
 * - A label used by a ticket but not defined by the workspace is still shown, with {@link NEUTRAL_LABEL_COLOR}.
 */

export interface ITicketLabelDefinition {
	readonly name: string;
	readonly color: string;
}

/** Metadata key of the workspace label definitions (workspace `ticket.md`). */
export const TICKET_LABELS_METADATA_KEY = 'Ticket Labels';
/** Metadata key of a ticket's labels (ticket `ticket.md`). */
export const TICKET_LABELS_FIELD_KEY = 'Labels';

/** Colors offered when defining a label. */
export const LABEL_COLOR_PALETTE: readonly string[] = [
	'#ef4444', '#f97316', '#f59e0b', '#eab308', '#22c55e',
	'#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#a855f7',
	'#ec4899', '#64748b'
];

/** Color of a label the workspace does not define. */
export const NEUTRAL_LABEL_COLOR = '#94a3b8';

export function isValidLabelColor(color: unknown): color is string {
	return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color.trim());
}

/** A storable label name: no list separators, line breaks or markdown emphasis; inner whitespace collapsed. */
export function sanitizeLabelName(name: unknown): string {
	if (typeof name !== 'string') {
		return '';
	}
	return name.replace(/[,;\uFF0C\uFF1B\r\n*]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function sameName(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

/** The first palette color not used yet (the palette repeats once all are used). */
export function nextLabelColor(defs: readonly ITicketLabelDefinition[]): string {
	const used = new Set(defs.map(d => d.color.toLowerCase()));
	return LABEL_COLOR_PALETTE.find(c => !used.has(c.toLowerCase())) ?? LABEL_COLOR_PALETTE[defs.length % LABEL_COLOR_PALETTE.length];
}

/**
 * Cleans a list of definitions: names are sanitized, empty names and duplicates (case-insensitive, first wins) are
 * dropped, an invalid color gets the next free palette color.
 */
export function normalizeLabelDefinitions(defs: readonly { name?: unknown; color?: unknown }[]): ITicketLabelDefinition[] {
	const result: ITicketLabelDefinition[] = [];
	for (const def of defs) {
		if (!def || typeof def !== 'object') {
			continue;
		}
		const name = sanitizeLabelName(def.name);
		if (!name || result.some(r => sameName(r.name, name))) {
			continue;
		}
		const color = isValidLabelColor(def.color) ? def.color.trim().toLowerCase() : nextLabelColor(result);
		result.push({ name, color });
	}
	return result;
}

/** Parses the `Ticket Labels` value: a JSON array of `{ name, color }`, or (hand-written) a comma separated list of names. */
export function parseLabelDefinitions(raw: string | undefined): ITicketLabelDefinition[] {
	const text = (raw ?? '').trim();
	if (!text || text.toLowerCase() === 'none') {
		return [];
	}
	if (text.startsWith('[')) {
		try {
			const data: unknown = JSON.parse(text);
			if (Array.isArray(data)) {
				return normalizeLabelDefinitions(data.map(d => typeof d === 'string' ? { name: d } : d));
			}
		} catch {
			// fall through to the plain list
		}
		return [];
	}
	return normalizeLabelDefinitions(text.split(/[,;\uFF0C\uFF1B]+/).map(name => ({ name })));
}

export function serializeLabelDefinitions(defs: readonly ITicketLabelDefinition[]): string {
	return JSON.stringify(normalizeLabelDefinitions(defs).map(d => ({ name: d.name, color: d.color })));
}

/** Parses a ticket's `Labels` value (`a, b`; `None` or empty means no labels). Duplicates are dropped. */
export function parseTicketLabels(raw: string | undefined): string[] {
	const text = (raw ?? '').trim();
	if (!text || text.toLowerCase() === 'none') {
		return [];
	}
	return normalizeTicketLabels(text.split(/[,;\uFF0C\uFF1B]+/));
}

export function serializeTicketLabels(labels: readonly string[]): string {
	const clean = normalizeTicketLabels(labels);
	return clean.length > 0 ? clean.join(', ') : 'None';
}

/** Sanitizes and de-duplicates (case-insensitive, first spelling wins) a list of label names. */
export function normalizeTicketLabels(labels: readonly unknown[]): string[] {
	const result: string[] = [];
	for (const label of labels) {
		const name = sanitizeLabelName(label);
		if (name && !result.some(r => sameName(r, name))) {
			result.push(name);
		}
	}
	return result;
}

/** Labels given by a tool or caller: an array of names or a comma separated string. Anything else is an error. */
export function coerceTicketLabelsInput(input: unknown): string[] {
	if (input === undefined || input === null) {
		return [];
	}
	if (typeof input === 'string') {
		return parseTicketLabels(input);
	}
	if (Array.isArray(input) && input.every(v => typeof v === 'string')) {
		return normalizeTicketLabels(input);
	}
	throw new Error('labels must be an array of label names (strings), e.g. ["bug", "urgent"].');
}

/** The color to show for a label: the workspace definition's color, else {@link NEUTRAL_LABEL_COLOR}. */
export function getLabelColor(defs: readonly ITicketLabelDefinition[] | undefined, name: string): string {
	return defs?.find(d => sameName(d.name, name))?.color ?? NEUTRAL_LABEL_COLOR;
}

/** Whether the workspace defines a label with this name (case-insensitive). */
export function isDefinedLabel(defs: readonly ITicketLabelDefinition[] | undefined, name: string): boolean {
	return !!defs?.some(d => sameName(d.name, name));
}

/** Whether a ticket's labels contain `name` (case-insensitive). */
export function hasTicketLabel(labels: readonly string[] | undefined, name: string): boolean {
	return !!labels?.some(l => sameName(l, name));
}

/** Adds or removes a label (case-insensitive) from a ticket's labels. */
export function toggleTicketLabel(labels: readonly string[], name: string): string[] {
	return hasTicketLabel(labels, name)
		? labels.filter(l => !sameName(l, name))
		: normalizeTicketLabels([...labels, name]);
}

/**
 * Applies label renames (old name -> new name, case-insensitive) to a ticket's labels.
 * Returns undefined when nothing changes.
 */
export function renameTicketLabels(labels: readonly string[], renames: Readonly<Record<string, string>>): string[] | undefined {
	const entries = Object.entries(renames);
	if (entries.length === 0 || labels.length === 0) {
		return undefined;
	}
	let changed = false;
	const next = labels.map(l => {
		const hit = entries.find(([from]) => sameName(from, l));
		if (hit && hit[1] !== l) {
			changed = true;
			return hit[1];
		}
		return l;
	});
	return changed ? normalizeTicketLabels(next) : undefined;
}
