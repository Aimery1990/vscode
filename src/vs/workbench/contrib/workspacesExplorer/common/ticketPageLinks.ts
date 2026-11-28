/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

/**
 * Links in the markdown rendered on the ticket page (UI-22).
 *
 * Worklog entries, README / `.agents/*.md` content and descriptions may contain relative links such as
 * `[run.log](.agents/Worklogs/run.log)`. Handed to the OS opener they fail ("No application found to open URL"), so
 * they are resolved against the ticket folder and opened in the app's editor instead. External links (http(s), mailto,
 * …) keep their default handling.
 */

/** Where a link of the ticket page points. */
export type TicketPageLinkTarget =
	/** A URL with a non-file scheme: left to the default (external) handling. */
	| { readonly kind: 'external' }
	/** A file: open the first existing candidate in the editor (candidates in lookup order). */
	| { readonly kind: 'file'; readonly candidates: readonly URI[] };

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE_RE = /^[a-z]:[\\/]/i;

/** The ticket folder of an entity URI (an entity opened through its `.agents` folder resolves to its parent). */
export function ticketFolderOf(entityUri: URI): URI {
	const path = entityUri.path.replace(/\/+$/, '');
	if (path.endsWith('/.agents')) {
		return entityUri.with({ path: path.slice(0, -'/.agents'.length) || '/' });
	}
	return entityUri;
}

function stripQueryAndFragment(href: string): string {
	const cut = href.search(/[?#]/);
	return cut >= 0 ? href.slice(0, cut) : href;
}

function safeDecode(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

/**
 * Resolves the `href` of a link on the ticket page of `entityUri`; undefined for links that point nowhere (empty or
 * an in-page `#anchor`). Relative paths are looked up in the ticket folder first, then in its `.agents` folder
 * (README / instruction files live there and may link to their neighbours).
 */
export function resolveTicketPageLink(href: string | null | undefined, entityUri: URI): TicketPageLinkTarget | undefined {
	const raw = (href || '').trim();
	if (!raw || raw.startsWith('#')) {
		return undefined;
	}
	const folder = ticketFolderOf(entityUri);
	if (WINDOWS_DRIVE_RE.test(raw)) {
		return { kind: 'file', candidates: [URI.file(safeDecode(stripQueryAndFragment(raw)))] };
	}
	if (SCHEME_RE.test(raw)) {
		if (/^file:/i.test(raw)) {
			try {
				return { kind: 'file', candidates: [URI.parse(raw).with({ query: '', fragment: '' })] };
			} catch {
				return undefined;
			}
		}
		return { kind: 'external' };
	}
	const path = safeDecode(stripQueryAndFragment(raw)).replace(/\\/g, '/');
	if (!path) {
		return undefined;
	}
	if (path.startsWith('/')) {
		return { kind: 'file', candidates: [folder.with({ path, query: '', fragment: '' })] };
	}
	const relative = path.replace(/^(\.\/)+/, '');
	const candidates = [URI.joinPath(folder, relative)];
	if (!/^\.agents(\/|$)/.test(relative)) {
		candidates.push(URI.joinPath(folder, '.agents', relative));
	}
	return { kind: 'file', candidates };
}
