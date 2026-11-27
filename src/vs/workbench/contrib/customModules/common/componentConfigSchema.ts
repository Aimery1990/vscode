/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { findPlaintextBrowserCredentials, normalizeBrowserCredentials } from './browserCredentials.js';
import { ConfigPropRole, IComponentConfigProp, getComponentProps, getComponentSpec } from './componentRegistry.js';
import { IGitComponentConfig, validateGitConfig } from './gitComponent.js';

/*
 * Per-component configuration validation (CI-32), driven by the `props` schema of componentRegistry.ts.
 * Pure (no services), so the AI tools, the editors and tests can all use it. CI-31 will expose it as the
 * validate_component_config AI tool.
 */

export type ComponentConfigErrorCode = 'unknownType' | 'unknownProp' | 'notWritable' | 'type' | 'enum' | 'required' | 'plaintextSecret' | 'invalidValue';

export interface IComponentConfigError {
	readonly code: ComponentConfigErrorCode;
	/** Property name ('' for errors about the whole config). */
	readonly prop: string;
	readonly message: string;
}

export interface IValidateComponentConfigOptions {
	/** Roles that may be written (default: every role, i.e. only unknown properties are rejected). */
	readonly writableRoles?: readonly ConfigPropRole[];
	/** Report required properties that are missing (default true). */
	readonly checkRequired?: boolean;
	/** The config is written by the AI: secrets must be variable references (default false). */
	readonly aiWrite?: boolean;
	/** Label used in messages (default: the type). */
	readonly label?: string;
}

/** `{name}` / `{{name}}`: the value references a variable instead of containing a secret. */
const VARIABLE_REFERENCE = /\{[^{}]+\}/;

function roleOf(prop: IComponentConfigProp): ConfigPropRole {
	return prop.role ?? 'config';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Error message for a value that does not match `prop.kind`, or undefined when it matches (after the usual coercions). */
function checkKind(prop: IComponentConfigProp, value: unknown): string | undefined {
	switch (prop.kind) {
		case 'string':
			if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
				return undefined;
			}
			return prop.acceptsJson && typeof value === 'object' ? undefined : 'must be a string';
		case 'number':
			return Number.isFinite(typeof value === 'string' && value.trim() !== '' ? Number(value) : value) ? undefined : 'must be a number';
		case 'boolean':
			return typeof value === 'boolean' || value === 'true' || value === 'false' ? undefined : 'must be true or false';
		case 'stringArray':
			if (typeof value === 'string') {
				return undefined;
			}
			return Array.isArray(value) && value.every(v => v === null || typeof v !== 'object') ? undefined : 'must be an array of strings';
		case 'objectArray':
			return Array.isArray(value) ? undefined : 'must be an array';
		case 'object':
			return isPlainObject(value) ? undefined : 'must be an object';
		case 'credentialArray':
			return Array.isArray(value) ? undefined : 'must be an array of { key, value }';
		case 'unknown':
			return undefined;
	}
}

/**
 * Validates a component configuration (flat ICustomField-style properties) against the type's schema: unknown
 * properties, properties of a role that may not be written, wrong value types, values outside an enum, missing required
 * properties and (for AI writes) plain-text secrets. `id`, `label` and `type` are never required here (they identify
 * the component rather than configure it). Returns an empty array when the config is valid.
 */
export function validateComponentConfig(type: string, config: Readonly<Record<string, unknown>>, options: IValidateComponentConfigOptions = {}): IComponentConfigError[] {
	const spec = getComponentSpec(type);
	if (!spec) {
		return [{ code: 'unknownType', prop: '', message: `Unknown component type '${type}'.` }];
	}
	const label = options.label || spec.type;
	const props = getComponentProps(spec.type);
	const byName = new Map<string, IComponentConfigProp>(props.map(prop => [prop.name, prop]));
	const writable = options.writableRoles ? new Set<ConfigPropRole>(options.writableRoles) : undefined;
	const errors: IComponentConfigError[] = [];

	for (const [key, value] of Object.entries(config)) {
		const prop = byName.get(key);
		if (!prop) {
			const allowed = props.filter(p => !writable || writable.has(roleOf(p))).map(p => p.name).join(', ');
			errors.push({ code: 'unknownProp', prop: key, message: `'${label}.${key}' is not a setting of ${spec.type}. Allowed: ${allowed}.` });
			continue;
		}
		if (writable && !writable.has(roleOf(prop))) {
			const hint = roleOf(prop) === 'structured'
				? 'set it as a top-level property of the field, not inside config'
				: roleOf(prop) === 'state' ? 'it is written by the editor or by a run' : 'it can only be set in the designer';
			errors.push({ code: 'notWritable', prop: key, message: `'${label}.${key}' cannot be set here: ${hint}.` });
			continue;
		}
		if (value === undefined || value === null) {
			continue;
		}
		const kindError = checkKind(prop, value);
		if (kindError) {
			errors.push({ code: 'type', prop: key, message: `'${label}.${key}' ${kindError}.` });
			continue;
		}
		if (prop.enum && typeof value === 'string' && !VARIABLE_REFERENCE.test(value)) {
			const lower = value.toLowerCase();
			if (!prop.enum.some(e => e.toLowerCase() === lower)) {
				errors.push({ code: 'enum', prop: key, message: `'${label}.${key}' must be one of: ${prop.enum.map(e => e === '' ? '(empty)' : e).join(', ')}.` });
				continue;
			}
		}
		if (options.aiWrite && prop.secret) {
			if (prop.kind === 'credentialArray') {
				const plaintext = findPlaintextBrowserCredentials(value);
				if (plaintext.length > 0) {
					errors.push({ code: 'plaintextSecret', prop: key, message: `'${label}.${key}' value(s) for ${plaintext.join(', ')} must reference a variable such as {SITE_API_KEY}; plain-text secrets are not allowed.` });
				}
			} else if (String(value).trim() && !VARIABLE_REFERENCE.test(String(value))) {
				errors.push({ code: 'plaintextSecret', prop: key, message: `'${label}.${key}' must reference a variable such as {API_TOKEN}; plain-text secrets are not allowed.` });
			}
		}
	}

	if (spec.type === 'git') {
		// Which settings are needed depends on the selected git command (CI-24)
		for (const problem of validateGitConfig(config as IGitComponentConfig, options.checkRequired !== false)) {
			if (!errors.some(e => e.prop === problem.prop)) {
				errors.push({ code: problem.code, prop: problem.prop, message: `'${label}.${problem.prop}': ${problem.message}` });
			}
		}
	}

	if (options.checkRequired !== false) {
		for (const prop of spec.props) {
			if (prop.required && (!writable || writable.has(roleOf(prop))) && (config[prop.name] === undefined || config[prop.name] === null || config[prop.name] === '')) {
				errors.push({ code: 'required', prop: prop.name, message: `'${label}.${prop.name}' is required for ${spec.type}.` });
			}
		}
	}
	return errors;
}

/**
 * Converts one validated value to the stored form of its property (strings stay strings, numbers become numbers,
 * object arrays get `enabled: true` unless set, browser credentials become `{ id, key, value }` rows).
 */
export function coerceComponentConfigValue(prop: IComponentConfigProp, value: unknown): unknown {
	switch (prop.kind) {
		case 'string': return typeof value === 'string' ? value : JSON.stringify(value);
		case 'number': return Number(value);
		case 'boolean': return value === true || value === 'true';
		case 'stringArray': return (Array.isArray(value) ? value : [value]).map(v => String(v));
		case 'objectArray': return (Array.isArray(value) ? value : []).filter(v => v && typeof v === 'object').map(v => ({ enabled: true, ...(v as object) }));
		case 'object': return isPlainObject(value) ? { ...value } : {};
		case 'credentialArray': return Array.from(normalizeBrowserCredentials(value).entries()).map(([name, v], idx) => ({ id: `cred_${idx + 1}`, key: name, value: v }));
		case 'unknown': return value;
	}
}
