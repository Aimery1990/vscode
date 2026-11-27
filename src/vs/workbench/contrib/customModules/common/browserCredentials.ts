/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Credentials of the `browser` component: any number of `name -> value` pairs set by the template author. The URL
 * references a credential as `{name}`; at run time the placeholder is replaced with the (URL-encoded) value. A credential
 * that the URL does not reference is sent as an HTTP request header named after it (e.g. `Authorization`). Values are
 * secrets: everything that is shown, logged or stored uses the masked URL, where each credential is `***`.
 */

/** Text that replaces a credential value wherever it would be shown, logged or stored. */
export const MASKED_SECRET = '***';

/** One credential as stored in the template config or in the ticket value (`id` is optional). */
export interface IBrowserCredentialLike {
	readonly id?: string;
	readonly key?: unknown;
	readonly value?: unknown;
}

export interface IBrowserCredentialUrl {
	/** URL to request: credential placeholders replaced by their encoded values, then context variables interpolated. */
	readonly url: string;
	/** Same URL with every credential value shown as `***`: the only form that may be logged, shown or stored. */
	readonly maskedUrl: string;
	/** Credential names that were found in the URL. */
	readonly usedNames: readonly string[];
	/** Every secret string (resolved values and their encoded forms) to hide with {@link maskSecrets}. */
	readonly secrets: readonly string[];
	/**
	 * Credentials that the URL does not reference, as request headers `name -> resolved value` (not URL-encoded). Rows
	 * with an empty value, a name that is not a valid header name or a value with line breaks are left out. Never log
	 * these values: use {@link maskBrowserCredentialHeaders}.
	 */
	readonly headers: Readonly<Record<string, string>>;
}

/** Characters allowed in an HTTP header name (RFC 9110 token). */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Characters that may not appear in an HTTP header value. */
const HEADER_VALUE_INVALID = /[\r\n\0]/;

/**
 * `{name}` and `{{name}}`. Unlike the runtime interpolation a leading `@` is not part of the placeholder, because in a
 * URL it separates the user info from the host (`https://{user}:{password}@{host}`).
 */
const PLACEHOLDER_PATTERN = /\{\{?([^{}]+)\}?\}/g;

/**
 * Turns the stored credentials into a name -> raw value map. Rows without a name are ignored, names are trimmed and a
 * later row with the same name wins. Accepts anything (stored JSON may be malformed).
 */
export function normalizeBrowserCredentials(raw: unknown): Map<string, string> {
	const result = new Map<string, string>();
	if (!Array.isArray(raw)) {
		return result;
	}
	for (const entry of raw) {
		if (!entry || typeof entry !== 'object') {
			continue;
		}
		const cred = entry as IBrowserCredentialLike;
		const name = typeof cred.key === 'string' ? cred.key.trim() : '';
		if (!name) {
			continue;
		}
		const value = typeof cred.value === 'string' ? cred.value : (cred.value === undefined || cred.value === null ? '' : String(cred.value));
		result.set(name, value);
	}
	return result;
}

/**
 * True when the placeholder at `index` sits in the scheme or the host/port part of the URL template. A value placed
 * there is inserted as is (it forms the address itself); everywhere else (user info, path, query, fragment) it is
 * URL-encoded.
 */
export function isPlaceholderInUrlHost(template: string, index: number): boolean {
	const schemeSep = template.indexOf('://');
	if (schemeSep < 0) {
		// No scheme: a placeholder at the very start forms the address (e.g. `{base_url}/path`)
		return index === 0;
	}
	const authorityStart = schemeSep + 3;
	if (index < authorityStart) {
		return true;
	}
	let authorityEnd = template.length;
	for (const sep of ['/', '?', '#']) {
		const pos = template.indexOf(sep, authorityStart);
		if (pos >= 0 && pos < authorityEnd) {
			authorityEnd = pos;
		}
	}
	if (index >= authorityEnd) {
		return false;
	}
	const at = template.lastIndexOf('@', authorityEnd - 1);
	const inUserInfo = at >= authorityStart && index < at;
	return !inUserInfo;
}

function findCredential(creds: Map<string, string>, name: string): [string, string] | undefined {
	const exact = creds.get(name);
	if (exact !== undefined) {
		return [name, exact];
	}
	const lower = name.toLowerCase();
	for (const [k, v] of creds) {
		if (k.toLowerCase() === lower) {
			return [k, v];
		}
	}
	return undefined;
}

/**
 * Resolves a browser URL template.
 *
 * 1. Each `{name}` that names a credential is replaced with that credential's value. A credential wins over a context
 *    variable with the same name. The value may itself reference variables (`{SSH_PASSWORD}`); they are resolved with
 *    `interpolate` first. Values are URL-encoded unless the placeholder is in the scheme or host.
 * 2. The rest of the template is passed to `interpolate` (context variables). Unknown `{x}` stay as they are, as the
 *    runtime interpolation leaves them.
 *
 * @param interpolate the caller's context-variable interpolation (identity when there is no context)
 */
export function resolveBrowserCredentialUrl(template: string, rawCredentials: unknown, interpolate: (text: string) => string = t => t): IBrowserCredentialUrl {
	const creds = normalizeBrowserCredentials(rawCredentials);
	const resolvedValues = new Map<string, string>();
	const secretSet = new Set<string>();
	for (const [name, value] of creds) {
		const resolved = value ? interpolate(value) : '';
		resolvedValues.set(name, resolved);
		if (resolved) {
			secretSet.add(resolved);
			secretSet.add(encodeURIComponent(resolved));
		}
	}

	const usedNames: string[] = [];
	let realTemplate = '';
	let maskedTemplate = '';
	let last = 0;
	const source = template || '';
	PLACEHOLDER_PATTERN.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = PLACEHOLDER_PATTERN.exec(source)) !== null) {
		const found = findCredential(resolvedValues, m[1].trim());
		if (!found) {
			continue;
		}
		const [name, value] = found;
		if (!usedNames.includes(name)) {
			usedNames.push(name);
		}
		const before = source.substring(last, m.index);
		realTemplate += before + (isPlaceholderInUrlHost(source, m.index) ? value : encodeURIComponent(value));
		maskedTemplate += before + MASKED_SECRET;
		last = m.index + m[0].length;
	}
	realTemplate += source.substring(last);
	maskedTemplate += source.substring(last);

	// Credentials not referenced in the URL go out as headers named after them (a null-prototype map: any name is safe)
	const headers: Record<string, string> = Object.create(null);
	for (const [name, value] of resolvedValues) {
		if (usedNames.includes(name) || !value || !HEADER_NAME_PATTERN.test(name) || HEADER_VALUE_INVALID.test(value)) {
			continue;
		}
		headers[name] = value;
	}

	return {
		url: interpolate(realTemplate),
		maskedUrl: interpolate(maskedTemplate),
		usedNames,
		secrets: Array.from(secretSet),
		headers
	};
}

/** True when the resolved credentials include at least one request header. */
export function hasBrowserCredentialHeaders(resolved: IBrowserCredentialUrl): boolean {
	return Object.keys(resolved.headers).length > 0;
}

/** Credential headers as they may be logged or shown: names kept, values replaced with `***`. */
export function maskBrowserCredentialHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
	const result: Record<string, string> = Object.create(null);
	for (const name of Object.keys(headers)) {
		result[name] = MASKED_SECRET;
	}
	return result;
}

/** Replaces every occurrence of each secret (longest first) with `***`. Use it on logs, errors and stored URLs. */
export function maskSecrets(text: string, secrets: readonly string[]): string {
	if (!text || secrets.length === 0) {
		return text;
	}
	let result = text;
	const ordered = secrets.filter(s => s.length > 0).sort((a, b) => b.length - a.length);
	for (const secret of ordered) {
		result = result.split(secret).join(MASKED_SECRET);
	}
	return result;
}

/** Credentials as they may be shown or put into run details: names kept, values replaced with `***`. */
export function maskBrowserCredentials(rawCredentials: unknown): { key: string; value: string }[] {
	return Array.from(normalizeBrowserCredentials(rawCredentials).keys()).map(key => ({ key, value: MASKED_SECRET }));
}

/**
 * Names of credentials whose value is written in plain text, i.e. contains no `{VAR}` reference. Used to reject
 * secrets written by the AI tool (the user may type plain values in the UI).
 */
export function findPlaintextBrowserCredentials(rawCredentials: unknown): string[] {
	const names: string[] = [];
	for (const [name, value] of normalizeBrowserCredentials(rawCredentials)) {
		if (value.trim() && !/\{[^{}]+\}/.test(value)) {
			names.push(name);
		}
	}
	return names;
}

/**
 * The credentials a run uses: always the template's (or the workflow node's). Only the template author knows how to
 * fill them. A credential list stored on a ticket (older tickets carry stale copies) is ignored; it is left on disk
 * untouched.
 */
export function pickBrowserCredentials<T>(_ticketCredentials: unknown, templateCredentials: T[] | undefined): T[] {
	return Array.isArray(templateCredentials) ? templateCredentials : [];
}
