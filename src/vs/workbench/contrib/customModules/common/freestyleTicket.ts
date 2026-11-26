/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ICustomField, ICustomModule, normalizeLegacyFieldTypes } from '../../entityPersistence/common/entityPersistence.js';

/**
 * A "Freestyle" ticket is created without a template (Custom Module). Its component structure
 * (the same shape as a template's `fields`) belongs to that one ticket only and is stored in the
 * ticket folder at `.agents/freestyle_schema.json` (see {@link getFreestyleSchemaUri}).
 */
export const FREESTYLE_TICKET_TYPE = 'freestyle';
export const FREESTYLE_TICKET_LABEL = 'Freestyle';
export const FREESTYLE_TICKET_ICON = 'edit';
export const FREESTYLE_TICKET_COLOR = '#2dd4bf';
export const FREESTYLE_SCHEMA_FILE_NAME = 'freestyle_schema.json';
export const FREESTYLE_TYPE_DEFINITION = 'A Freestyle ticket has no template: its own component structure is stored in .agents/freestyle_schema.json inside the ticket folder.';
export const FREESTYLE_TYPE_PROMPT = 'A Freestyle ticket defines its own components (see .agents/freestyle_schema.json). Work with the components it has.';

/** Editor `moduleId` prefix used when the schema designer edits a Freestyle ticket's structure. */
const FREESTYLE_DESIGNER_MODULE_ID_PREFIX = 'freestyle-ticket::';

/**
 * Normalizes a template / ticket type name for the reserved-name check: lowercase, without whitespace,
 * `-` and `_` (so `Free Style`, `free-style`, `FREE_STYLE` all become `freestyle`).
 */
export function normalizeReservedTypeName(value: string | undefined | null): string {
	return (value || '').toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * "freestyle" is reserved for Freestyle tickets: no template (custom module) may use it as its id or name,
 * and a ticket type that matches it always means a Freestyle ticket.
 */
export function isReservedFreestyleName(value: string | undefined | null): boolean {
	return normalizeReservedTypeName(value) === FREESTYLE_TICKET_TYPE;
}

/** True when a template's id or name is the reserved Freestyle name. */
export function isReservedFreestyleTemplate(template: { id?: string; name?: string } | undefined | null): boolean {
	return !!template && (isReservedFreestyleName(template.id) || isReservedFreestyleName(template.name));
}

/** A ticket type is the Freestyle type when it matches the reserved name (see {@link isReservedFreestyleName}). */
export function isFreestyleTicketType(ticketType: string | undefined): boolean {
	return isReservedFreestyleName(ticketType);
}

/** Error shown when a template would be created or renamed to the reserved Freestyle name. */
export function getReservedFreestyleNameMessage(value: string): string {
	return `"${value}" is reserved for Freestyle tickets (tickets without a template). Please choose a different template name.`;
}

/** Error returned by every non-UI path that tries to create a Freestyle ticket. */
export const FREESTYLE_PROGRAMMATIC_CREATE_ERROR = 'Freestyle tickets can only be created manually in the UI; choose a template type.';

/**
 * Validates a template's identity against the reserved Freestyle name. Returns an error message when the
 * template would be created with, or renamed to, a reserved id or name; `undefined` when it is allowed.
 * A template that already existed with exactly the same id and name (legacy data) is left alone, so saving
 * unrelated changes keeps working; only creating or renaming into the reserved name is refused.
 */
export function getReservedTemplateNameError(template: { id?: string; name?: string }, existing?: { id?: string; name?: string }): string | undefined {
	if (!isReservedFreestyleTemplate(template)) {
		return undefined;
	}
	const sameIdentity = !!existing
		&& (existing.id || '').toLowerCase() === (template.id || '').toLowerCase()
		&& (existing.name || '') === (template.name || '');
	if (sameIdentity) {
		return undefined;
	}
	const offending = isReservedFreestyleName(template.name) ? (template.name || '') : (template.id || '');
	return getReservedFreestyleNameMessage(offending);
}

/**
 * Programmatic ticket creation (workflow components, the ticket runtime, AI tools) may not create Freestyle
 * tickets. Returns the error to report when `ticketType` is the reserved Freestyle type.
 */
export function getProgrammaticTicketTypeError(ticketType: string | undefined): string | undefined {
	return isReservedFreestyleName(ticketType) ? FREESTYLE_PROGRAMMATIC_CREATE_ERROR : undefined;
}

/** Where a Freestyle ticket's own structure is stored: `<ticket folder>/.agents/freestyle_schema.json`. */
export function getFreestyleSchemaUri(ticketFolderUri: URI): URI {
	return URI.joinPath(ticketFolderUri, '.agents', FREESTYLE_SCHEMA_FILE_NAME);
}

export function getFreestyleDesignerModuleId(ticketFolderUri: URI): string {
	return `${FREESTYLE_DESIGNER_MODULE_ID_PREFIX}${ticketFolderUri.toString()}`;
}

/** The structure a new Freestyle ticket starts with: a Title and a (removable) Description. */
export function createDefaultFreestyleSchema(): ICustomModule {
	return {
		id: FREESTYLE_TICKET_TYPE,
		name: FREESTYLE_TICKET_LABEL,
		icon: FREESTYLE_TICKET_ICON,
		color: FREESTYLE_TICKET_COLOR,
		description: FREESTYLE_TYPE_DEFINITION,
		prompt: '',
		fields: [
			{ id: 'title', label: 'Title', type: 'text', required: true },
			{ id: 'description', label: 'Description', type: 'textarea' }
		]
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Turns untrusted parsed JSON into a valid Freestyle structure: keeps the stored components (objects
 * with a string `type`), renames legacy component types, fixes the identity (id/name/icon/color) and
 * makes sure a Title component comes first. Returns `undefined` when the value is not a structure at all.
 */
export function normalizeFreestyleSchema(raw: unknown): ICustomModule | undefined {
	if (!isRecord(raw) || !Array.isArray(raw.fields)) {
		return undefined;
	}
	const normalized = normalizeLegacyFieldTypes<unknown>(JSON.parse(JSON.stringify(raw)));
	if (!isRecord(normalized) || !Array.isArray(normalized.fields)) {
		return undefined;
	}
	const fields: ICustomField[] = [];
	const usedIds = new Set<string>();
	for (const candidate of normalized.fields) {
		if (!isRecord(candidate) || typeof candidate.type !== 'string' || !candidate.type) {
			continue;
		}
		const field = candidate as unknown as ICustomField;
		const baseId = (typeof field.id === 'string' && field.id.trim()) ? field.id.trim() : (field.type || 'field');
		let id = baseId;
		let suffix = 2;
		while (usedIds.has(id.toLowerCase())) {
			id = `${baseId}_${suffix++}`;
		}
		usedIds.add(id.toLowerCase());
		field.id = id;
		if (typeof field.label !== 'string' || !field.label.trim()) {
			field.label = id;
		}
		fields.push(field);
	}

	const isTitle = (f: ICustomField) => f.id.toLowerCase() === 'title' || f.label.toLowerCase() === 'title';
	const titleField = fields.find(isTitle) ?? { id: 'title', label: 'Title', type: 'text', required: true };
	const otherFields = fields.filter(f => f !== titleField && !isTitle(f));

	const mod: ICustomModule = {
		...(normalized as unknown as ICustomModule),
		id: FREESTYLE_TICKET_TYPE,
		name: FREESTYLE_TICKET_LABEL,
		icon: FREESTYLE_TICKET_ICON,
		color: FREESTYLE_TICKET_COLOR,
		fields: [titleField, ...otherFields]
	};
	if (typeof mod.description !== 'string') {
		mod.description = FREESTYLE_TYPE_DEFINITION;
	}
	if (typeof mod.prompt !== 'string') {
		mod.prompt = '';
	}
	delete mod.storageScope;
	delete mod.isDeprecated;
	delete mod.category;
	return mod;
}

/** Runtime-only keys the designer / detail page put on components; they are never stored in the structure. */
const TRANSIENT_FIELD_KEYS = [
	'lastSentPrompt', 'lastExecutionLog', 'lastExecutionOutput', 'lastExecutionStatus', 'lastExecutionDurationMs',
	'lastExecutedAt', 'lastExecutionExitCode', 'pythonOutput', 'pythonResult', 'pythonStructuredData',
	'structuredData', 'debugPromptOutput', 'debugSqlOutput', 'debugOutput'
];

/** Serializes a Freestyle structure for disk (pretty JSON, without runtime-only component state). */
export function serializeFreestyleSchema(mod: ICustomModule): string {
	const normalized = normalizeFreestyleSchema(mod) ?? createDefaultFreestyleSchema();
	const clone = JSON.parse(JSON.stringify(normalized)) as ICustomModule;
	delete clone.updatedAt;
	for (const field of clone.fields ?? []) {
		const record = field as unknown as Record<string, unknown>;
		for (const key of TRANSIENT_FIELD_KEYS) {
			delete record[key];
		}
		if (field.type === 'table' && (field.tableDbEngine || 'sqlite') === 'sqlite' && field.tableDbPath && field.tableDbPath.trim()) {
			// Rows of a bound SQLite table live in the database, not in the structure
			field.tableRows = [];
		}
	}
	return JSON.stringify(clone, null, '\t') + '\n';
}

/** Parses stored structure text; `undefined` when it is not valid JSON or not a structure. */
export function parseFreestyleSchema(text: string): ICustomModule | undefined {
	try {
		return normalizeFreestyleSchema(JSON.parse(text));
	} catch {
		return undefined;
	}
}

/** Reads a ticket's Freestyle structure; `undefined` when the file is missing or unreadable. */
export async function readFreestyleSchema(fileService: IFileService, ticketFolderUri: URI): Promise<ICustomModule | undefined> {
	const schemaUri = getFreestyleSchemaUri(ticketFolderUri);
	try {
		if (!await fileService.exists(schemaUri)) {
			return undefined;
		}
		return parseFreestyleSchema((await fileService.readFile(schemaUri)).value.toString());
	} catch {
		return undefined;
	}
}

export async function writeFreestyleSchema(fileService: IFileService, ticketFolderUri: URI, mod: ICustomModule): Promise<void> {
	await fileService.writeFile(getFreestyleSchemaUri(ticketFolderUri), VSBuffer.fromString(serializeFreestyleSchema(mod)));
}

/** Writes the default structure for a new Freestyle ticket unless the ticket already has one. */
export async function ensureFreestyleSchema(fileService: IFileService, ticketFolderUri: URI): Promise<void> {
	if (!await fileService.exists(getFreestyleSchemaUri(ticketFolderUri))) {
		await writeFreestyleSchema(fileService, ticketFolderUri, createDefaultFreestyleSchema());
	}
}
