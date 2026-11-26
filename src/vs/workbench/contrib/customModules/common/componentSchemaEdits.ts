/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ICustomField, ICustomModule } from '../../entityPersistence/common/entityPersistence.js';

/**
 * Pure edits of a component structure (`ICustomModule.fields`). Rules shared by every structure editor:
 * the Title component is a mandatory root field that always stays first and can be neither moved, renamed nor
 * removed; every other component (Description included) can. Each helper returns a new module and leaves its
 * input untouched.
 */

/** A component that is the mandatory Title root field. */
export function isTitleComponent(field: Pick<ICustomField, 'id' | 'label'>): boolean {
	return (field.id || '').toLowerCase() === 'title' || (field.label || '').toLowerCase() === 'title';
}

/** A component that is the Description root field (rendered as the page's Description card). */
export function isDescriptionComponent(field: Pick<ICustomField, 'id' | 'label'>): boolean {
	return (field.id || '').toLowerCase() === 'description' || (field.label || '').toLowerCase() === 'description';
}

function cloneModule(mod: ICustomModule): ICustomModule {
	return JSON.parse(JSON.stringify(mod));
}

function indexOfComponent(fields: readonly ICustomField[], fieldId: string): number {
	const target = fieldId.toLowerCase();
	return fields.findIndex(f => (f.id || '').toLowerCase() === target);
}

/** The first index a non-Title component may take: right after the Title (0 when there is none). */
function firstMovableIndex(fields: readonly ICustomField[]): number {
	return fields.length > 0 && isTitleComponent(fields[0]) ? 1 : 0;
}

/**
 * Inserts a component at `index` (clamped so it never goes before the Title); appends it when `index` is undefined.
 */
export function insertComponent(mod: ICustomModule, field: ICustomField, index?: number): ICustomModule {
	const next = cloneModule(mod);
	const fields = next.fields ?? (next.fields = []);
	const min = firstMovableIndex(fields);
	const at = typeof index === 'number' && Number.isFinite(index) ? Math.min(Math.max(min, Math.floor(index)), fields.length) : fields.length;
	fields.splice(at, 0, JSON.parse(JSON.stringify(field)));
	return next;
}

/**
 * Moves the component `fieldId` so it ends up at index `toIndex` of the resulting list (clamped to the movable range).
 * The Title cannot be moved; an unknown id leaves the structure unchanged.
 */
export function moveComponent(mod: ICustomModule, fieldId: string, toIndex: number): ICustomModule {
	const next = cloneModule(mod);
	const fields = next.fields ?? [];
	const from = indexOfComponent(fields, fieldId);
	if (from < 0 || isTitleComponent(fields[from])) {
		return next;
	}
	const [moved] = fields.splice(from, 1);
	const min = firstMovableIndex(fields);
	const at = Math.min(Math.max(min, Math.floor(toIndex)), fields.length);
	fields.splice(at, 0, moved);
	return next;
}

/** Moves the component `fieldId` one place up (`delta` -1) or down (`delta` 1). */
export function moveComponentBy(mod: ICustomModule, fieldId: string, delta: number): ICustomModule {
	const from = indexOfComponent(mod.fields ?? [], fieldId);
	return from < 0 ? cloneModule(mod) : moveComponent(mod, fieldId, from + delta);
}

/** Removes the component `fieldId`. The Title cannot be removed. */
export function removeComponent(mod: ICustomModule, fieldId: string): ICustomModule {
	const next = cloneModule(mod);
	const fields = next.fields ?? [];
	const index = indexOfComponent(fields, fieldId);
	if (index >= 0 && !isTitleComponent(fields[index])) {
		fields.splice(index, 1);
	}
	return next;
}

/**
 * Updates references to a component that was renamed from `oldLabel` to `newLabel` in the other components:
 * Output specs, `{label}` / `{{label}}` / `@{label}` tokens and `['label']` / `["label"]` lookups in prompts, Python
 * code, SQL, URLs and Display values. Also remembers `oldLabel` in the renamed component's `previousLabels`, so
 * workflows that still use the old name keep resolving it. Mutates `fields`.
 */
export function propagateComponentLabelRename(fields: readonly ICustomField[], renamed: ICustomField, oldLabel: string, newLabel: string): void {
	if (!oldLabel || !newLabel || oldLabel === newLabel) {
		return;
	}
	const runtimeField = renamed as ICustomField & { previousLabels?: string[] };
	if (!Array.isArray(runtimeField.previousLabels)) {
		runtimeField.previousLabels = [];
	}
	if (!runtimeField.previousLabels.includes(oldLabel)) {
		runtimeField.previousLabels.push(oldLabel);
	}
	const escOld = oldLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const tokenRe = new RegExp(`(@?\\{\\{?)${escOld}(\\}?\\})`, 'g');
	const sqBracketRe = new RegExp(`(\\[')${escOld}('\\])`, 'g');
	const dqBracketRe = new RegExp(`(\\[")${escOld}("\\])`, 'g');
	const replaceRefs = (s?: string): string | undefined => {
		if (!s || typeof s !== 'string') {
			return s;
		}
		return s
			.replace(tokenRe, `$1${newLabel}$2`)
			.replace(sqBracketRe, `$1${newLabel}$2`)
			.replace(dqBracketRe, `$1${newLabel}$2`);
	};
	for (const other of fields) {
		if (other === renamed) {
			continue;
		}
		if (Array.isArray(other.outputSpecs)) {
			for (const spec of other.outputSpecs) {
				if (spec.fieldKey === oldLabel) { spec.fieldKey = newLabel; }
				if (spec.label === oldLabel) { spec.label = newLabel; }
			}
		}
		if (other.defaultContent) { other.defaultContent = replaceRefs(other.defaultContent); }
		if (other.defaultUserPrompt) { other.defaultUserPrompt = replaceRefs(other.defaultUserPrompt); }
		if (Array.isArray(other.defaultUserPrompts)) {
			other.defaultUserPrompts = other.defaultUserPrompts.map((p: string) => replaceRefs(p) || p);
		}
		if (other.pythonCode) { other.pythonCode = replaceRefs(other.pythonCode); }
		if (other.tableSqlQuery) { other.tableSqlQuery = replaceRefs(other.tableSqlQuery); }
		if (other.defaultUrl) { other.defaultUrl = replaceRefs(other.defaultUrl); }
		if (other.wfDisplayValue) { other.wfDisplayValue = replaceRefs(other.wfDisplayValue); }
	}
}

export interface IComponentRenameResult {
	readonly module: ICustomModule;
	/** Label before the rename ('' when nothing was renamed). */
	readonly oldLabel: string;
	/** Why the rename was refused; `undefined` when it was applied (or was a no-op). */
	readonly error?: string;
}

/**
 * Renames the component `fieldId` to `newLabel` (trimmed) and updates references to it in the other components.
 * Refused for the Title and the Description root fields, for an empty label, for the reserved labels
 * "Title" / "Description" and for a label another component already uses (ticket values are stored by label).
 */
export function renameComponent(mod: ICustomModule, fieldId: string, newLabel: string): IComponentRenameResult {
	const next = cloneModule(mod);
	const fields = next.fields ?? [];
	const index = indexOfComponent(fields, fieldId);
	if (index < 0) {
		return { module: next, oldLabel: '', error: 'This component no longer exists.' };
	}
	const field = fields[index];
	const oldLabel = field.label || field.id;
	if (isTitleComponent(field) || isDescriptionComponent(field)) {
		return { module: next, oldLabel: '', error: `"${oldLabel}" is a root field and cannot be renamed.` };
	}
	const label = newLabel.trim();
	if (!label) {
		return { module: next, oldLabel: '', error: 'A component name cannot be empty.' };
	}
	if (label === oldLabel) {
		return { module: next, oldLabel: '' };
	}
	if (isTitleComponent({ id: '', label }) || isDescriptionComponent({ id: '', label })) {
		return { module: next, oldLabel: '', error: `"${label}" is reserved for a root field.` };
	}
	const clash = fields.some((f, i) => i !== index && ((f.label || '').toLowerCase() === label.toLowerCase() || (f.id || '').toLowerCase() === label.toLowerCase()));
	if (clash) {
		return { module: next, oldLabel: '', error: `Another component is already named "${label}".` };
	}
	field.label = label;
	propagateComponentLabelRename(fields, field, oldLabel, label);
	return { module: next, oldLabel };
}

/**
 * Moves a ticket value stored under a component's old label to its new label (ticket values are keyed by label;
 * matching ignores case and treats `_` like a space, as the ticket page does). Returns a new map; unchanged when
 * there is no value under the old label or the new label already has one.
 */
export function renameComponentValueKey(values: Readonly<Record<string, string>>, oldLabel: string, newLabel: string): Record<string, string> {
	const next: Record<string, string> = { ...values };
	const norm = (s: string) => s.toLowerCase().replace(/_/g, ' ').trim();
	const oldKey = Object.keys(next).find(k => norm(k) === norm(oldLabel));
	if (!oldKey || !newLabel || norm(oldLabel) === norm(newLabel)) {
		return next;
	}
	if (Object.keys(next).some(k => norm(k) === norm(newLabel))) {
		return next;
	}
	next[newLabel] = next[oldKey];
	delete next[oldKey];
	return next;
}
