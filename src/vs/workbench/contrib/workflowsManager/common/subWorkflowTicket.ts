/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ISubWorkflowDefinition, IWorkflowInputParamDef, IWorkflowOutputDef } from './workflowExecutionModel.js';

/**
 * Sub-Workflow tickets (CI-23): encapsulating nodes on a workflow canvas, or a program / AI creating a ticket of type
 * `sub_workflow` inside a workflow folder, creates a Sub-Workflow ticket inside that workflow folder. Its definition is stored in `<ticket folder>/.agents/sub_workflow.json`; ticket.md
 * carries the name, the source workflow and an inputs / outputs summary. This file holds the pure logic
 * (definition (de)serialization, summaries, legacy-id resolution and the migration plan).
 */
export const SUB_WORKFLOW_DEFINITION_FILE_NAME = 'sub_workflow.json';
/** Path of the definition file relative to the ticket folder. */
export const SUB_WORKFLOW_DEFINITION_REL_PATH = `.agents/${SUB_WORKFLOW_DEFINITION_FILE_NAME}`;
/** Profile storage (machine): where the known Sub-Workflow tickets live, `ISubWorkflowTicketIndexEntry[]`. */
export const SUB_WORKFLOW_TICKET_INDEX_STORAGE_KEY = 'anyagent.subWorkflows.ticketIndex.v1';
/** Profile storage (machine): legacy `subwf_...` ids that were already migrated to tickets (never migrated twice). */
export const SUB_WORKFLOW_MIGRATED_IDS_STORAGE_KEY = 'anyagent.subWorkflows.migratedLegacyIds.v1';
/** Prefix of the random ids Sub-Workflows had before they became tickets. */
export const LEGACY_SUB_WORKFLOW_ID_PREFIX = 'subwf_';

/** Ticket metadata keys written to ticket.md ("Self Defined Data Value") of a Sub-Workflow ticket. */
export const SUB_WORKFLOW_META_NAME = 'Sub-Workflow';
export const SUB_WORKFLOW_META_SOURCE = 'Source Workflow';
export const SUB_WORKFLOW_META_INPUTS = 'Inputs';
export const SUB_WORKFLOW_META_OUTPUTS = 'Outputs';
export const SUB_WORKFLOW_META_DEFINITION = 'Definition File';
export const SUB_WORKFLOW_META_LEGACY_ID = 'Legacy ID';

export interface ISubWorkflowTicketIndexEntry {
	id: string;
	folderUri: string;
	legacyId?: string;
}

/** Short inputs / outputs summary of a Sub-Workflow ticket, added to every GET_TICKETS result item. */
export interface ISubWorkflowTicketSummary {
	name: string;
	inputs: string;
	outputs: string;
	sourceWorkflow: string;
}

/** The full calling contract of a Sub-Workflow ticket, returned by GET_TICKET. */
export interface ISubWorkflowContract {
	ticketId: string;
	legacyId?: string;
	name: string;
	namespace?: string;
	sourceWorkflowUri?: string;
	sourceWorkflowName?: string;
	nodeCount: number;
	inputs: Array<{ name: string; label: string; defaultValue: string; options?: string[]; description?: string }>;
	outputs: Array<{ name: string; label: string; format: string }>;
	usage: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Where a Sub-Workflow ticket stores its definition: `<ticket folder>/.agents/sub_workflow.json`. */
export function getSubWorkflowDefinitionUri(ticketFolderUri: URI): URI {
	return URI.joinPath(ticketFolderUri, '.agents', SUB_WORKFLOW_DEFINITION_FILE_NAME);
}

/** True for the random `subwf_...` id of a Sub-Workflow created before CI-23. */
export function isLegacySubWorkflowId(id: string | undefined | null): boolean {
	return typeof id === 'string' && id.startsWith(LEGACY_SUB_WORKFLOW_ID_PREFIX);
}

/**
 * The folder that holds the source workflow: the workflow folder itself, or the parent folder of a workflow stored as a
 * single `.json` / `.workflow` file. `undefined` when the URI is missing or unparsable.
 */
export function getSubWorkflowSourceFolder(sourceWorkflowUri: string | undefined): URI | undefined {
	const raw = (sourceWorkflowUri || '').trim();
	if (!raw) {
		return undefined;
	}
	let uri: URI;
	try {
		uri = raw.includes('://') ? URI.parse(raw) : URI.file(raw);
	} catch {
		return undefined;
	}
	let path = uri.path.replace(/\/+$/, '');
	if (path.endsWith('/.agents')) {
		path = path.slice(0, -'/.agents'.length);
	}
	if (/\.(json|workflow)$/i.test(path)) {
		path = path.slice(0, path.lastIndexOf('/'));
	}
	if (!path || path === '/') {
		return undefined;
	}
	return uri.with({ path });
}

/**
 * Removes heavy media that is never needed to run a Sub-Workflow (Voice Note `audioDataUrl`) from a copy of the
 * definition. `changed` tells whether anything was removed.
 */
export function stripHeavyMediaFromSubWorkflow(def: ISubWorkflowDefinition): { cleaned: ISubWorkflowDefinition; changed: boolean } {
	let changed = false;
	const cloned: ISubWorkflowDefinition = JSON.parse(JSON.stringify(def));
	for (const node of Array.isArray(cloned.nodes) ? cloned.nodes : []) {
		const pipeline = isRecord(node) && Array.isArray(node.pipeline) ? node.pipeline : [];
		for (const step of pipeline) {
			const comp = isRecord(step) && isRecord(step.component) ? step.component : undefined;
			const clips = comp && Array.isArray(comp.voiceClips) ? comp.voiceClips : [];
			for (const clip of clips) {
				if (isRecord(clip) && typeof clip.audioDataUrl === 'string' && clip.audioDataUrl.length > 0) {
					Reflect.deleteProperty(clip, 'audioDataUrl');
					changed = true;
				}
			}
		}
	}
	return { cleaned: cloned, changed };
}

function normalizeInputs(raw: unknown): IWorkflowInputParamDef[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const result: IWorkflowInputParamDef[] = [];
	for (const item of raw) {
		if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim()) {
			continue;
		}
		result.push({
			...(item as unknown as IWorkflowInputParamDef),
			name: item.name,
			label: asString(item.label) ?? item.name,
			defaultValue: typeof item.defaultValue === 'string' ? item.defaultValue : (item.defaultValue === undefined || item.defaultValue === null ? '' : String(item.defaultValue)),
			componentId: asString(item.componentId) ?? '',
			componentLabel: asString(item.componentLabel) ?? ''
		});
	}
	return result;
}

function normalizeOutputs(raw: unknown): IWorkflowOutputDef[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const result: IWorkflowOutputDef[] = [];
	for (const item of raw) {
		if (!isRecord(item)) {
			continue;
		}
		const varName = asString(item.varName) ?? asString(item.fieldKey) ?? asString(item.label) ?? '';
		const label = asString(item.label) ?? varName;
		if (!varName && !label) {
			continue;
		}
		result.push({
			...(item as unknown as IWorkflowOutputDef),
			label,
			varName,
			fieldKey: asString(item.fieldKey) ?? varName,
			defaultFormat: asString(item.defaultFormat) ?? 'text',
			componentId: asString(item.componentId) ?? '',
			componentLabel: asString(item.componentLabel) ?? ''
		});
	}
	return result;
}

/**
 * Turns untrusted parsed JSON into a Sub-Workflow definition. `fallbackId` (the ticket ID from the folder) is used when
 * the file has no id. Returns `undefined` when the value is not a definition (no nodes array, no id, no name).
 */
export function normalizeSubWorkflowDefinition(raw: unknown, fallbackId?: string): ISubWorkflowDefinition | undefined {
	if (!isRecord(raw) || !Array.isArray(raw.nodes)) {
		return undefined;
	}
	const id = (asString(raw.id) || fallbackId || '').trim();
	if (!id) {
		return undefined;
	}
	const name = (asString(raw.name) || '').trim() || id;
	const nodes: unknown[] = raw.nodes;
	const nodeIdsRaw = Array.isArray(raw.nodeIds) ? raw.nodeIds : nodes.map(n => isRecord(n) ? n.id : undefined);
	const nodeIds = nodeIdsRaw.filter((n): n is string => typeof n === 'string' && n.length > 0);
	const now = Date.now();
	const def: ISubWorkflowDefinition = {
		id,
		name,
		nodeIds,
		nodes,
		links: Array.isArray(raw.links) ? raw.links : [],
		inputs: normalizeInputs(raw.inputs),
		outputs: normalizeOutputs(raw.outputs),
		createdAt: asNumber(raw.createdAt, now),
		updatedAt: asNumber(raw.updatedAt, asNumber(raw.createdAt, now))
	};
	const legacyId = asString(raw.legacyId);
	if (legacyId && legacyId !== id) {
		def.legacyId = legacyId;
	}
	const optionalStrings: Array<'namespace' | 'description' | 'sourceWorkflowUri' | 'sourceWorkflowName'> = ['namespace', 'description', 'sourceWorkflowUri', 'sourceWorkflowName'];
	for (const key of optionalStrings) {
		const value = asString(raw[key]);
		if (value !== undefined) {
			def[key] = value;
		}
	}
	if (typeof raw.isHiddenInSource === 'boolean') {
		def.isHiddenInSource = raw.isHiddenInSource;
	}
	return def;
}

/** Parses the text of a definition file; `undefined` when it is not valid JSON or not a definition. */
export function parseSubWorkflowDefinition(text: string, fallbackId?: string): ISubWorkflowDefinition | undefined {
	try {
		return normalizeSubWorkflowDefinition(JSON.parse(text), fallbackId);
	} catch {
		return undefined;
	}
}

/** Serializes a definition for its ticket file: pretty JSON, without runtime-only state and heavy media. */
export function serializeSubWorkflowDefinition(def: ISubWorkflowDefinition): string {
	const { cleaned } = stripHeavyMediaFromSubWorkflow(def);
	delete cleaned.ticketFolderUri;
	if (!cleaned.legacyId) {
		delete cleaned.legacyId;
	}
	return JSON.stringify(cleaned, null, '\t') + '\n';
}

function oneLine(value: string, max = 120): string {
	const flat = value.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** `query (default: "AI"), limit` or `none`. */
export function summarizeSubWorkflowInputs(def: Pick<ISubWorkflowDefinition, 'inputs'>): string {
	const inputs = Array.isArray(def.inputs) ? def.inputs : [];
	if (inputs.length === 0) {
		return 'none';
	}
	return oneLine(inputs.map(i => i.defaultValue ? `${i.name} (default: ${JSON.stringify(i.defaultValue)})` : i.name).join(', '), 300);
}

/** `summary (markdown), rows (table)` or `none`. */
export function summarizeSubWorkflowOutputs(def: Pick<ISubWorkflowDefinition, 'outputs'>): string {
	const outputs = Array.isArray(def.outputs) ? def.outputs : [];
	if (outputs.length === 0) {
		return 'none';
	}
	return oneLine(outputs.map(o => `${o.varName || o.label}${o.defaultFormat ? ` (${o.defaultFormat})` : ''}`).join(', '), 300);
}

/** `Lead Search (file:///.../FINDJ-0003)`, the name alone, or the URI alone. */
export function describeSubWorkflowSource(def: Pick<ISubWorkflowDefinition, 'sourceWorkflowName' | 'sourceWorkflowUri'>): string {
	const name = (def.sourceWorkflowName || '').trim();
	const uri = (def.sourceWorkflowUri || '').trim();
	if (name && uri) {
		return oneLine(`${name} (${uri})`, 300);
	}
	return oneLine(name || uri || 'unknown', 300);
}

/** Metadata written into ticket.md ("Self Defined Data Value"): name, source workflow, inputs / outputs summary. */
export function buildSubWorkflowTicketMetadata(def: ISubWorkflowDefinition): Record<string, string> {
	const meta: Record<string, string> = {
		[SUB_WORKFLOW_META_NAME]: oneLine(def.name, 200),
		[SUB_WORKFLOW_META_SOURCE]: describeSubWorkflowSource(def),
		[SUB_WORKFLOW_META_INPUTS]: summarizeSubWorkflowInputs(def),
		[SUB_WORKFLOW_META_OUTPUTS]: summarizeSubWorkflowOutputs(def),
		[SUB_WORKFLOW_META_DEFINITION]: SUB_WORKFLOW_DEFINITION_REL_PATH
	};
	if (def.legacyId) {
		meta[SUB_WORKFLOW_META_LEGACY_ID] = def.legacyId;
	}
	return meta;
}

/** One-line ticket description of a Sub-Workflow ticket. */
export function buildSubWorkflowTicketDescription(def: ISubWorkflowDefinition): string {
	return oneLine(`Sub-Workflow '${def.name}' encapsulated from workflow ${describeSubWorkflowSource(def)}. Inputs: ${summarizeSubWorkflowInputs(def)}. Outputs: ${summarizeSubWorkflowOutputs(def)}.`, 600);
}

/** The short summary added to GET_TICKETS result items. */
export function buildSubWorkflowTicketSummary(def: ISubWorkflowDefinition): ISubWorkflowTicketSummary {
	return {
		name: def.name,
		inputs: summarizeSubWorkflowInputs(def),
		outputs: summarizeSubWorkflowOutputs(def),
		sourceWorkflow: describeSubWorkflowSource(def)
	};
}

/** The summary of a GET_TICKETS item read back from the ticket metadata (when the definition file was not read). */
export function subWorkflowSummaryFromMetadata(meta: Record<string, string> | undefined): ISubWorkflowTicketSummary | undefined {
	if (!meta || (meta[SUB_WORKFLOW_META_INPUTS] === undefined && meta[SUB_WORKFLOW_META_OUTPUTS] === undefined)) {
		return undefined;
	}
	return {
		name: meta[SUB_WORKFLOW_META_NAME] || '',
		inputs: meta[SUB_WORKFLOW_META_INPUTS] || 'none',
		outputs: meta[SUB_WORKFLOW_META_OUTPUTS] || 'none',
		sourceWorkflow: meta[SUB_WORKFLOW_META_SOURCE] || ''
	};
}

/** The full calling contract returned by GET_TICKET for a Sub-Workflow ticket. */
export function buildSubWorkflowContract(def: ISubWorkflowDefinition): ISubWorkflowContract {
	const contract: ISubWorkflowContract = {
		ticketId: def.id,
		name: def.name,
		nodeCount: Array.isArray(def.nodeIds) && def.nodeIds.length > 0 ? def.nodeIds.length : (Array.isArray(def.nodes) ? def.nodes.length : 0),
		inputs: (def.inputs || []).map(i => {
			const input: ISubWorkflowContract['inputs'][number] = { name: i.name, label: i.label || i.name, defaultValue: i.defaultValue ?? '' };
			if (Array.isArray(i.options) && i.options.length > 0) {
				input.options = [...i.options];
			}
			if (i.description) {
				input.description = i.description;
			}
			return input;
		}),
		outputs: (def.outputs || []).map(o => ({ name: o.varName || o.label, label: o.label || o.varName, format: o.defaultFormat || 'text' })),
		usage: `Add a Call Sub-Workflow step with subWorkflowId "${def.id}" and bind subWorkflowInputs by input name. It returns the raw value when there is one output, otherwise a dictionary keyed by output name.`
	};
	if (def.legacyId) {
		contract.legacyId = def.legacyId;
	}
	if (def.namespace) {
		contract.namespace = def.namespace;
	}
	if (def.sourceWorkflowUri) {
		contract.sourceWorkflowUri = def.sourceWorkflowUri;
	}
	if (def.sourceWorkflowName) {
		contract.sourceWorkflowName = def.sourceWorkflowName;
	}
	return contract;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Writes `metadata` into the "Self Defined Data Value" list of a ticket.md: existing `  - **Key**: value` lines are
 * replaced, missing keys are appended to the list (which is created when the file has none). Other lines stay as is.
 */
export function applySubWorkflowMetadataToTicketMd(content: string, metadata: Record<string, string>): string {
	const lines = content.split('\n');
	const remaining = new Map(Object.entries(metadata).map(([k, v]) => [k, oneLine(v, 600)] as const));
	for (let i = 0; i < lines.length; i++) {
		for (const [key, value] of remaining) {
			if (new RegExp(`^\\s+-\\s+\\*\\*${escapeRegExp(key)}\\*\\*:`).test(lines[i])) {
				lines[i] = `  - **${key}**: ${value}`;
				remaining.delete(key);
				break;
			}
		}
	}
	if (remaining.size === 0) {
		return lines.join('\n');
	}
	const additions = Array.from(remaining, ([k, v]) => `  - **${k}**: ${v}`);
	let valueIdx = lines.findIndex(l => /^-\s+\*\*Self Defined Data Value\*\*:/.test(l));
	if (valueIdx < 0) {
		const sectionIdx = lines.findIndex(l => l.startsWith('### Self Defined Data'));
		if (sectionIdx < 0) {
			const tail = lines.length > 0 && lines[lines.length - 1] === '' ? [] : [''];
			return [...lines, ...tail, '### Self Defined Data (If any)', '- **Self Defined Data Value**:', ...additions, ''].join('\n');
		}
		lines.splice(sectionIdx + 1, 0, '- **Self Defined Data Value**:');
		valueIdx = sectionIdx + 1;
	}
	lines[valueIdx] = '- **Self Defined Data Value**:';
	let insertAt = valueIdx + 1;
	while (insertAt < lines.length && /^\s+-\s+\*\*/.test(lines[insertAt])) {
		insertAt++;
	}
	lines.splice(insertAt, 0, ...additions);
	return lines.join('\n');
}

/** Parses the stored ticket index; invalid entries are dropped, duplicates (same id) keep the first one. */
export function parseSubWorkflowTicketIndex(raw: string | undefined): ISubWorkflowTicketIndexEntry[] {
	if (!raw) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	const seen = new Set<string>();
	const result: ISubWorkflowTicketIndexEntry[] = [];
	for (const item of parsed) {
		if (!isRecord(item) || typeof item.id !== 'string' || !item.id || typeof item.folderUri !== 'string' || !item.folderUri) {
			continue;
		}
		if (seen.has(item.id)) {
			continue;
		}
		seen.add(item.id);
		const entry: ISubWorkflowTicketIndexEntry = { id: item.id, folderUri: item.folderUri };
		if (typeof item.legacyId === 'string' && item.legacyId) {
			entry.legacyId = item.legacyId;
		}
		result.push(entry);
	}
	return result;
}

/** The ticket index of the given ticket-backed definitions (legacy definitions without a folder are left out). */
export function buildSubWorkflowTicketIndex(defs: readonly ISubWorkflowDefinition[]): ISubWorkflowTicketIndexEntry[] {
	const result: ISubWorkflowTicketIndexEntry[] = [];
	for (const def of defs) {
		if (!def.ticketFolderUri) {
			continue;
		}
		const entry: ISubWorkflowTicketIndexEntry = { id: def.id, folderUri: def.ticketFolderUri };
		if (def.legacyId) {
			entry.legacyId = def.legacyId;
		}
		result.push(entry);
	}
	return result;
}

/**
 * Lookup map for Call Sub-Workflow references: every definition by its id (the ticket ID) and, for migrated ones, by
 * its legacy `subwf_...` id. A real id always wins over a legacy alias; among duplicates the first definition wins.
 */
export function buildSubWorkflowLookup(defs: readonly ISubWorkflowDefinition[]): Map<string, ISubWorkflowDefinition> {
	const map = new Map<string, ISubWorkflowDefinition>();
	for (const def of defs) {
		if (def && def.id && !map.has(def.id)) {
			map.set(def.id, def);
		}
	}
	for (const def of defs) {
		if (def && def.legacyId && !map.has(def.legacyId)) {
			map.set(def.legacyId, def);
		}
	}
	return map;
}

/** Resolves a Call Sub-Workflow reference (ticket ID, or the legacy `subwf_...` id of a migrated Sub-Workflow). */
export function resolveSubWorkflowReference(defs: readonly ISubWorkflowDefinition[], reference: string | undefined | null): ISubWorkflowDefinition | undefined {
	const ref = (reference || '').trim();
	if (!ref) {
		return undefined;
	}
	return buildSubWorkflowLookup(defs).get(ref);
}

/** Parses the legacy profile-storage library (`SUB_WORKFLOWS_STORAGE_KEY`); invalid entries are dropped. */
export function parseLegacySubWorkflowLibrary(raw: string | undefined): ISubWorkflowDefinition[] {
	if (!raw) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	const result: ISubWorkflowDefinition[] = [];
	for (const item of parsed) {
		const def = normalizeSubWorkflowDefinition(item);
		if (def) {
			result.push(def);
		}
	}
	return result;
}

/**
 * One-time migration plan: the legacy profile-storage definitions that still need a Sub-Workflow ticket. A legacy
 * definition is skipped when a ticket already carries its id as `legacyId` (or as its id), when it was migrated before
 * (`migratedLegacyIds`, so a deleted ticket is not recreated), or when its id appears twice (first one wins).
 */
export function planSubWorkflowMigration(
	legacyDefs: readonly ISubWorkflowDefinition[],
	ticketDefs: readonly ISubWorkflowDefinition[],
	migratedLegacyIds: ReadonlySet<string>
): ISubWorkflowDefinition[] {
	const covered = new Set<string>();
	for (const def of ticketDefs) {
		covered.add(def.id);
		if (def.legacyId) {
			covered.add(def.legacyId);
		}
	}
	const plan: ISubWorkflowDefinition[] = [];
	for (const def of legacyDefs) {
		if (!def.id || covered.has(def.id) || migratedLegacyIds.has(def.id)) {
			continue;
		}
		covered.add(def.id);
		plan.push(def);
	}
	return plan;
}

/** Parses the stored list of migrated legacy ids. */
export function parseMigratedLegacyIds(raw: string | undefined): Set<string> {
	if (!raw) {
		return new Set();
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string' && v.length > 0) : []);
	} catch {
		return new Set();
	}
}

/**
 * The migrated copy of a legacy definition: the new ticket ID becomes the id and the old `subwf_...` id is kept as
 * `legacyId`. Nodes, links and the contract are unchanged.
 */
export function toMigratedSubWorkflowDefinition(legacy: ISubWorkflowDefinition, ticketId: string, ticketFolderUri: string): ISubWorkflowDefinition {
	const copy: ISubWorkflowDefinition = JSON.parse(JSON.stringify(legacy));
	copy.legacyId = legacy.legacyId || legacy.id;
	copy.id = ticketId;
	copy.ticketFolderUri = ticketFolderUri;
	return copy;
}

/**
 * Legacy definitions that no loaded Sub-Workflow ticket covers (their migration failed, or the migrated ticket folder
 * was not found). They stay usable under their legacy id; duplicates keep the first one.
 */
export function getUncoveredLegacySubWorkflows(legacyDefs: readonly ISubWorkflowDefinition[], ticketDefs: readonly ISubWorkflowDefinition[]): ISubWorkflowDefinition[] {
	const lookup = buildSubWorkflowLookup(ticketDefs);
	const seen = new Set<string>();
	const result: ISubWorkflowDefinition[] = [];
	for (const def of legacyDefs) {
		if (!def.id || lookup.has(def.id) || seen.has(def.id)) {
			continue;
		}
		seen.add(def.id);
		result.push(def);
	}
	return result;
}

/** Error when a Sub-Workflow ticket would be created outside a workflow folder. */
export function getSubWorkflowParentError(targetPath: string): string {
	return `A sub_workflow ticket must be created inside a workflow folder (the parent workflow): set the target path / parent to that workflow ticket (e.g. path="FINDJ-0003"). '${targetPath}' is not inside a workflow folder.`;
}

/** What a program / AI may pass as the definition of a new Sub-Workflow ticket (all optional). */
export interface ISubWorkflowDefinitionInputDefaults {
	name: string;
	sourceWorkflowUri: string;
	sourceWorkflowName?: string;
	now?: number;
}

function inputError(message: string): { error: string } {
	return { error: `Invalid sub_workflow definition: ${message}` };
}

/**
 * Validates the optional definition given when a program or AI creates a Sub-Workflow ticket and turns it into a
 * draft (id still empty; the ticket ID is assigned on creation). `raw` may be undefined (an empty definition: no
 * nodes, empty contract), a JSON string, or an object with optional `name`, `nodes`, `links`, `inputs`, `outputs`,
 * `description`, `namespace`. Nodes need unique string ids; links need `from` / `to` naming those nodes; inputs need
 * a `name`; outputs need a `varName` or `label`. The source workflow is always the parent workflow folder.
 */
export function buildSubWorkflowDraftFromInput(raw: unknown, defaults: ISubWorkflowDefinitionInputDefaults): { draft: ISubWorkflowDefinition; error?: undefined } | { draft?: undefined; error: string } {
	let value: unknown = raw;
	if (typeof value === 'string') {
		const text = value.trim();
		if (!text) {
			value = undefined;
		} else {
			try {
				value = JSON.parse(text);
			} catch {
				return inputError('it is not valid JSON.');
			}
		}
	}
	if (value === undefined || value === null) {
		value = {};
	}
	if (!isRecord(value)) {
		return inputError('expected an object with optional name, nodes, links, inputs and outputs.');
	}
	const rec: Record<string, unknown> = value;

	const listOf = (key: string): unknown[] | { error: string } => {
		const v = rec[key];
		if (v === undefined || v === null) {
			return [];
		}
		return Array.isArray(v) ? v : inputError(`"${key}" must be a list.`);
	};
	const nodes = listOf('nodes');
	const links = listOf('links');
	const inputs = listOf('inputs');
	const outputs = listOf('outputs');
	for (const list of [nodes, links, inputs, outputs]) {
		if (!Array.isArray(list)) {
			return list;
		}
	}
	const nodeList = nodes as unknown[];
	const nodeIds: string[] = [];
	for (let i = 0; i < nodeList.length; i++) {
		const node = nodeList[i];
		if (!isRecord(node) || typeof node.id !== 'string' || !node.id.trim()) {
			return inputError(`nodes[${i}] must be an object with a string "id".`);
		}
		if (nodeIds.includes(node.id)) {
			return inputError(`node id "${node.id}" is used twice.`);
		}
		nodeIds.push(node.id);
	}
	const linkList = links as unknown[];
	for (let i = 0; i < linkList.length; i++) {
		const link = linkList[i];
		if (!isRecord(link) || typeof link.from !== 'string' || typeof link.to !== 'string') {
			return inputError(`links[${i}] must be an object with string "from" and "to".`);
		}
		if (!nodeIds.includes(link.from) || !nodeIds.includes(link.to)) {
			return inputError(`links[${i}] connects "${link.from}" -> "${link.to}", but both must be ids of the given nodes.`);
		}
	}
	const inputList = inputs as unknown[];
	for (let i = 0; i < inputList.length; i++) {
		const input = inputList[i];
		if (!isRecord(input) || typeof input.name !== 'string' || !input.name.trim()) {
			return inputError(`inputs[${i}] must be an object with a string "name".`);
		}
	}
	const outputList = outputs as unknown[];
	for (let i = 0; i < outputList.length; i++) {
		const output = outputList[i];
		if (!isRecord(output) || !((typeof output.varName === 'string' && output.varName.trim()) || (typeof output.label === 'string' && output.label.trim()))) {
			return inputError(`outputs[${i}] must be an object with a string "varName" or "label".`);
		}
	}
	if (rec.name !== undefined && typeof rec.name !== 'string') {
		return inputError('"name" must be a string.');
	}
	const now = defaults.now ?? Date.now();
	const normalized = normalizeSubWorkflowDefinition({
		name: (typeof rec.name === 'string' && rec.name.trim()) ? rec.name.trim() : defaults.name,
		description: rec.description,
		namespace: rec.namespace,
		id: 'pending',
		nodes: nodeList,
		nodeIds,
		links: linkList,
		inputs: inputList,
		outputs: outputList,
		createdAt: now,
		updatedAt: now
	});
	if (!normalized) {
		return inputError('it could not be read.');
	}
	normalized.id = '';
	normalized.sourceWorkflowUri = defaults.sourceWorkflowUri;
	if (defaults.sourceWorkflowName) {
		normalized.sourceWorkflowName = defaults.sourceWorkflowName;
	}
	normalized.isHiddenInSource = false;
	return { draft: normalized };
}

/**
 * The parent workflow of a new Sub-Workflow ticket: the nearest folder, `start` itself or one of its ancestors, that
 * `isWorkflowFolder` accepts. `undefined` when there is none (the ticket must not be created there).
 */
export async function findEnclosingWorkflowFolder(start: URI, isWorkflowFolder: (folder: URI) => Promise<boolean>, maxDepth = 12): Promise<URI | undefined> {
	let curr = start;
	for (let depth = 0; depth < maxDepth; depth++) {
		if (await isWorkflowFolder(curr)) {
			return curr;
		}
		const parentPath = curr.path.replace(/\/+$/, '').replace(/\/[^/]*$/, '');
		if (parentPath === curr.path.replace(/\/+$/, '')) {
			break;
		}
		const next = curr.with({ path: parentPath || '/' });
		if (next.path === curr.path) {
			break;
		}
		curr = next;
	}
	return undefined;
}
