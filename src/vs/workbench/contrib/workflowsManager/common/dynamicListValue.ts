/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * The run context value of a Dynamic List (`dynamic_list`) component, including Reusable Class lists
 * (`componentRef`, whose `itemFields` are a copy of the class's sub-fields).
 *
 * A ticket stores a Dynamic List as a JSON array of item records, for example
 * `[{"_index":1,"_title":"Trip A","Amount":"12"}]`: one key per sub-field label, plus the bookkeeping keys
 * `_index` (position, 1-based) and `_title` (optional item title). During a run the list publishes the
 * parsed array under its variable name, so later components read structured JSON instead of a string.
 */

/** The parts of a sub-field definition this module reads. */
export interface IDynamicListItemFieldLike {
	readonly id?: string;
	readonly label?: string;
}

export type DynamicListValueResult =
	| { readonly ok: true; readonly items: unknown[] }
	| { readonly ok: false; readonly error: string };

/** Stored placeholders that mean "no entries". */
const EMPTY_LIST_MARKERS = new Set(['', 'none', 'null', 'undefined', 'n/a']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Builds the value a Dynamic List publishes into the run context from its stored value.
 *
 * - Accepts the stored JSON text, an already parsed array, or a single item record (wrapped into a one-item array).
 *   Nothing stored, an empty string, or a placeholder such as `None` gives `[]`.
 * - Each record keeps its own keys, except `_index` (the position in the array already says it); `_title` is kept
 *   only when it has text. Every declared sub-field (`itemFields`) is present under its label, `''` when not filled.
 *   A value stored under the sub-field id instead of its label is moved to the label.
 * - Entries that are not records (strings, numbers) are kept as they are.
 * - Text that is not a JSON array or record is an error.
 */
export function buildDynamicListContextValue(raw: unknown, itemFields?: readonly IDynamicListItemFieldLike[]): DynamicListValueResult {
	let parsed: unknown = raw;
	if (raw === undefined || raw === null) {
		return { ok: true, items: [] };
	}
	if (typeof raw === 'string') {
		const text = raw.trim();
		if (EMPTY_LIST_MARKERS.has(text.toLowerCase())) {
			return { ok: true, items: [] };
		}
		if (!text.startsWith('[') && !text.startsWith('{')) {
			return { ok: false, error: 'the stored value is not a JSON array of items' };
		}
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			return { ok: false, error: `the stored value is not valid JSON (${err instanceof Error ? err.message : String(err)})` };
		}
	}

	let entries: unknown[];
	if (Array.isArray(parsed)) {
		entries = parsed;
	} else if (isPlainRecord(parsed)) {
		entries = [parsed];
	} else {
		return { ok: false, error: 'the stored value is not a JSON array of items' };
	}

	const declared = (itemFields ?? [])
		.map(sub => ({ label: (sub.label || sub.id || '').trim(), id: (sub.id || '').trim() }))
		.filter(sub => sub.label !== '');

	const items = entries.map(entry => {
		if (!isPlainRecord(entry)) {
			return entry;
		}
		const item: Record<string, unknown> = {};
		const title = entry._title;
		if (typeof title === 'string' ? title.trim() !== '' : (title !== undefined && title !== null)) {
			item._title = title;
		}
		const movedIds = new Set<string>();
		for (const sub of declared) {
			if (Object.prototype.hasOwnProperty.call(entry, sub.label)) {
				item[sub.label] = entry[sub.label];
			} else if (sub.id && sub.id !== sub.label && Object.prototype.hasOwnProperty.call(entry, sub.id)) {
				item[sub.label] = entry[sub.id];
				movedIds.add(sub.id);
			} else {
				item[sub.label] = '';
			}
		}
		for (const [key, value] of Object.entries(entry)) {
			if (key === '_index' || key === '_title' || movedIds.has(key) || Object.prototype.hasOwnProperty.call(item, key)) {
				continue;
			}
			item[key] = value;
		}
		return item;
	});
	return { ok: true, items };
}
