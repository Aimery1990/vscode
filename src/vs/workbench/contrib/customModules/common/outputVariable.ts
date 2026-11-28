/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ICustomField, generateSmartPythonVarName, sanitizePythonVarName } from '../../entityPersistence/common/entityPersistence.js';
import { getComponentSpec } from './componentRegistry.js';
import { isTitleComponent } from './componentSchemaEdits.js';

/**
 * The output variable of a component (UI-27): the name later steps use to read its result, `{name}` in prompts,
 * commands, URLs and conditions, `TICKET_CONTEXT["name"]` (or the global `name`) in Python. Shared by every place
 * that arranges components (Freestyle ticket, template designer, workflow node editor), so they show, validate and
 * rename it the same way as the component settings ("Output Var").
 */

/** Types that never publish an output variable, whatever the registry says (same rule as the settings dialog). */
const NO_OUTPUT_VARIABLE_TYPES = new Set(['parameters', 'output', 'display']);

export interface IOutputVariableInfo {
	/** Effective name: `outputVariableName`, or the name generated from the label. */
	readonly name: string;
	/** True when the name follows the label (not typed by hand). */
	readonly isAuto: boolean;
}

/** True when the component publishes an output variable (`{var}` in its registry outputs). The Title never does. */
export function hasOutputVariable(field: Pick<ICustomField, 'id' | 'label' | 'type'>): boolean {
	const type = (field.type || '').toLowerCase();
	if (!type || NO_OUTPUT_VARIABLE_TYPES.has(type) || isTitleComponent(field)) {
		return false;
	}
	const spec = getComponentSpec(type);
	// Unknown / unregistered types (e.g. containers): the settings dialog still gives them a name
	return spec ? spec.outputs.some(o => o.name === '{var}') : true;
}

/** Name the component gets when none was typed (what the runtime falls back to). */
export function defaultOutputVariableName(field: Pick<ICustomField, 'id' | 'label' | 'type'>): string {
	return generateSmartPythonVarName(field.label || field.id, field.type);
}

/** The output variable of a component, or undefined when it has none. */
export function getOutputVariableInfo(field: ICustomField): IOutputVariableInfo | undefined {
	if (!hasOutputVariable(field)) {
		return undefined;
	}
	const typed = (field.outputVariableName || '').trim();
	return { name: typed || defaultOutputVariableName(field), isAuto: !field.outputVariableManual };
}

/** Reference text other components use for the variable: `{name}`. */
export function formatOutputVariableReference(name: string): string {
	return `{${name}}`;
}

/** Cleaned label key the runtime also publishes values under (lowercase, other characters -> `_`). */
export function outputLabelKey(label: string): string {
	return label.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
}

export interface IOutputVariableHoverEntry {
	/** Reference as written in other components, e.g. `{git_1}` or `{git_1.stdout}`. */
	readonly reference: string;
	readonly type: string;
	readonly description: string;
}

/**
 * What the component publishes, from its registry outputs, with the placeholders filled in: `{var}` -> the variable,
 * `{Label…}` -> the label, `{label_key}` -> the cleaned label. Sub-fields such as git / shell `.stdout` are published
 * under the label (and its key), so they are shown that way.
 */
export function getOutputVariableHoverEntries(field: ICustomField, varName: string): IOutputVariableHoverEntry[] {
	const spec = getComponentSpec(field.type);
	if (!spec) {
		return [{ reference: formatOutputVariableReference(varName), type: 'any', description: 'result of the component' }];
	}
	const label = (field.label || field.id || '').trim();
	const key = outputLabelKey(label);
	return spec.outputs
		.filter(o => o.name.includes('{'))
		.map(o => ({
			reference: o.name
				.replace(/\{var\}/g, `{${varName}}`)
				.replace(/\{label_key\}/g, key)
				.replace(/\{Label(?=[.}\s])/g, `{${label}`)
				// `{name}_status` / `{name}.rows` / `key_output` are written `{name_status}` / `{name.rows}` / `{key_output}`
				.replace(/^\{([^{}]+)\}([._][A-Za-z0-9_]+)$/, '{$1$2}')
				.replace(/^([A-Za-z0-9_]+_[A-Za-z0-9_]+)$/, '{$1}'),
			type: o.type,
			description: o.description
		}));
}

/** Names of the dotted sub-fields a component publishes (e.g. git: `ok`, `exitCode`, `stdout`, ...). */
export function getOutputSubFields(type: string): string[] {
	const spec = getComponentSpec(type);
	if (!spec) {
		return [];
	}
	const names: string[] = [];
	for (const o of spec.outputs) {
		const m = /^\{Label(?:\.([A-Za-z0-9_]+)\}|\}\.([A-Za-z0-9_]+))$/.exec(o.name);
		const name = m ? (m[1] ?? m[2]) : undefined;
		if (name && !names.includes(name)) {
			names.push(name);
		}
	}
	return names;
}

/**
 * Why `name` cannot be the output variable of component `selfId` among `fields` (undefined when it can): it must be a
 * Python identifier that the settings dialog keeps as typed (letters, digits, `_`, no leading digit, no keyword), and
 * no other component may use the same variable (case-insensitive).
 */
export function validateOutputVariableName(name: string, fields: readonly ICustomField[], selfId: string): string | undefined {
	const value = name.trim();
	if (!value) {
		return 'The variable name cannot be empty.';
	}
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
		return 'Use letters, digits and _ only, not starting with a digit.';
	}
	if (sanitizePythonVarName(value) !== value) {
		return `"${value}" is a reserved word. Please choose a different name.`;
	}
	const self = selfId.toLowerCase();
	const clash = fields.find(f => f && (f.id || '').toLowerCase() !== self && getOutputVariableInfo(f)?.name.toLowerCase() === value.toLowerCase());
	if (clash) {
		return `"${clash.label || clash.id}" already uses the variable "${value}".`;
	}
	return undefined;
}

/**
 * Sets the output variable of `field` as the settings dialog does when a name is typed: the name is stored and marked
 * manual unless it equals the generated one (then it follows the label again). Mutates `field`.
 */
export function applyOutputVariableName(field: ICustomField, name: string): void {
	const value = name.trim();
	const auto = defaultOutputVariableName(field);
	field.outputVariableName = value || auto;
	field.outputVariableManual = !!value && value !== auto;
}

export interface IOutputVariableReference {
	readonly fieldId: string;
	readonly fieldLabel: string;
	/** Property path inside the component, e.g. `pythonCode` or `gitSteps.0.args`. */
	readonly path: string;
	readonly count: number;
}

/** Properties that are never references: identity, the variable itself, and results / logs of past runs. */
const SKIPPED_KEYS = new Set([
	'id', 'type', 'label', 'outputVariableName', 'outputVariableManual', 'previousLabels', 'componentRef',
	'pythonOutput', 'pythonResult', 'pythonStructuredData', 'structuredData',
	'sshOutput', 'sshLastOutput', 'sshLastRawOutput', 'sshLastRawEntries'
]);

function isSkippedKey(key: string): boolean {
	return SKIPPED_KEYS.has(key) || key.startsWith('last') || key.startsWith('debug');
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces the references to variable `oldName` in one text: `{old}`, `{{old}}`, `@{old}`, `{old.stdout}`,
 * `["old"]` / `['old']`, `.get("old"` and, in Python code, the global `old`. Returns the new text and the count.
 */
export function replaceOutputVariableInText(text: string, oldName: string, newName: string, isPythonCode: boolean): { text: string; count: number } {
	const old = escapeRegExp(oldName);
	let count = 0;
	const patterns: RegExp[] = [
		new RegExp(`(\\{\\{?\\s*)${old}((?:[.\\[][^{}\\s]*)?\\s*\\}\\}?)`, 'g'),
		new RegExp(`(\\[\\s*["'])${old}(["']\\s*\\])`, 'g'),
		new RegExp(`(\\.get\\(\\s*["'])${old}(["'])`, 'g')
	];
	if (isPythonCode) {
		patterns.push(new RegExp(`(^|[^\\w.'"{@])${old}(?![\\w'"]|\\s*\\})`, 'gm'));
	}
	let result = text;
	for (const re of patterns) {
		result = result.replace(re, (_m, before: string, after: string | undefined) => {
			count++;
			return `${before}${newName}${typeof after === 'string' ? after : ''}`;
		});
	}
	return { text: result, count };
}

/** Walks the string properties of a component (skipping identity and run results), replacing in place when asked. */
function walkComponentText(field: ICustomField, visit: (text: string, path: string, isPythonCode: boolean) => string | undefined): void {
	const isPython = (field.type || '').toLowerCase() === 'python';
	const walk = (value: unknown, path: string, key: string, depth: number): unknown => {
		if (depth > 8) {
			return value;
		}
		if (typeof value === 'string') {
			const next = visit(value, path, key === 'pythonCode' || (isPython && key === 'defaultContent'));
			return next === undefined ? value : next;
		}
		if (Array.isArray(value)) {
			for (let i = 0; i < value.length; i++) {
				value[i] = walk(value[i], `${path}.${i}`, key, depth + 1);
			}
			return value;
		}
		if (value && typeof value === 'object') {
			const obj = value as Record<string, unknown>;
			for (const k of Object.keys(obj)) {
				if (!isSkippedKey(k)) {
					obj[k] = walk(obj[k], path ? `${path}.${k}` : k, k, depth + 1);
				}
			}
		}
		return value;
	};
	walk(field, '', '', 0);
}

/** Where the other components of `fields` use variable `name` (component `selfId` itself is skipped). */
export function findOutputVariableReferences(fields: readonly ICustomField[], selfId: string, name: string): IOutputVariableReference[] {
	const refs: IOutputVariableReference[] = [];
	if (!name) {
		return refs;
	}
	const self = selfId.toLowerCase();
	for (const field of fields) {
		if (!field || (field.id || '').toLowerCase() === self) {
			continue;
		}
		// Read-only walk on a copy: the visitor returns undefined, so nothing changes
		const copy = JSON.parse(JSON.stringify(field)) as ICustomField;
		walkComponentText(copy, (text, path, isPythonCode) => {
			const { count } = replaceOutputVariableInText(text, name, name, isPythonCode);
			if (count > 0) {
				refs.push({ fieldId: field.id, fieldLabel: field.label || field.id, path, count });
			}
			return undefined;
		});
	}
	return refs;
}

/** Replaces the references to `oldName` with `newName` in the other components of `fields` (mutates them). Returns the count. */
export function replaceOutputVariableReferences(fields: readonly ICustomField[], selfId: string, oldName: string, newName: string): number {
	if (!oldName || !newName || oldName === newName) {
		return 0;
	}
	const self = selfId.toLowerCase();
	let total = 0;
	for (const field of fields) {
		if (!field || (field.id || '').toLowerCase() === self) {
			continue;
		}
		walkComponentText(field, (text, _path, isPythonCode) => {
			const { text: next, count } = replaceOutputVariableInText(text, oldName, newName, isPythonCode);
			total += count;
			return count > 0 ? next : undefined;
		});
	}
	return total;
}

/** Total number of references in a list (what "Also update N references?" counts). */
export function countOutputVariableReferences(refs: readonly IOutputVariableReference[]): number {
	return refs.reduce((n, r) => n + r.count, 0);
}
