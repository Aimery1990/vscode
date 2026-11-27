/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { locateTicketFieldSpans, replaceTicketFieldValues, TicketFieldSource } from './ticketChangeLog.js';
import { ITicketFieldReference, mayContainTicketFieldReference, parseTicketFieldReference, sanitizeTicketFieldKey, shouldExternalizeTicketField } from './ticketFieldStore.js';

/*
 * CI-51: field references inside ticket.md / README.md / instruction.md (pure logic). The reference format and the
 * long-text threshold are defined in `ticketFieldStore.ts`.
 */

/** A field value that refers to its current value file. */
export interface ITicketFieldReferenceUse {
	readonly fieldId: string;
	readonly label: string;
	readonly ref: ITicketFieldReference;
}

/** The references among the field values of one ticket file (raw, unresolved content). */
export function collectTicketFieldReferences(source: TicketFieldSource, content: string): ITicketFieldReferenceUse[] {
	if (!mayContainTicketFieldReference(content)) {
		return [];
	}
	const result: ITicketFieldReferenceUse[] = [];
	for (const span of locateTicketFieldSpans(source, content)) {
		const ref = parseTicketFieldReference(span.value);
		if (ref) {
			result.push({ fieldId: span.id, label: span.label, ref });
		}
	}
	return result;
}

/** Replaces every reference whose file content is known (`values` by relative path) by that content. */
export function resolveTicketFieldReferencesInContent(source: TicketFieldSource, content: string, values: ReadonlyMap<string, string>): string {
	if (!mayContainTicketFieldReference(content)) {
		return content;
	}
	return replaceTicketFieldValues(source, content, span => {
		const ref = parseTicketFieldReference(span.value);
		return ref ? values.get(ref.path) : undefined;
	});
}

export interface ITicketFieldExternalization {
	readonly fieldId: string;
	readonly label: string;
	readonly fieldKey: string;
	/** The full value (the content of `fields/<fieldKey>.txt`). */
	readonly value: string;
}

/**
 * The values of a resolved ticket file that must be stored in their own file, with the file key of each:
 * the key the field used before (`previousKeys`, by field id), else {@link sanitizeTicketFieldKey}; a key claimed by
 * another field of the ticket (`claimed`: key → `<source>:<field id>`) gets a `_2`, `_3`, ... suffix. Claims are added
 * to `claimed`.
 */
export function planTicketFieldExternalization(source: TicketFieldSource, resolvedContent: string, claimed: Map<string, string>, previousKeys?: ReadonlyMap<string, string>): ITicketFieldExternalization[] {
	const result: ITicketFieldExternalization[] = [];
	for (const span of locateTicketFieldSpans(source, resolvedContent)) {
		if (!shouldExternalizeTicketField(span.id, span.value)) {
			continue;
		}
		const owner = `${source}:${span.id}`;
		const base = previousKeys?.get(span.id) ?? sanitizeTicketFieldKey(span.id, span.label);
		let key = base;
		for (let n = 2; claimed.has(key) && claimed.get(key) !== owner; n++) {
			key = `${base}_${n}`;
		}
		claimed.set(key, owner);
		result.push({ fieldId: span.id, label: span.label, fieldKey: key, value: span.value });
	}
	return result;
}

/** Replaces the values of the given fields (`references` by field id) by their reference line. */
export function applyTicketFieldReferences(source: TicketFieldSource, resolvedContent: string, references: ReadonlyMap<string, string>): string {
	if (references.size === 0) {
		return resolvedContent;
	}
	return replaceTicketFieldValues(source, resolvedContent, span => references.get(span.id));
}
