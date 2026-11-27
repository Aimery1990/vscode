/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ThemeIcon } from '../../../../base/common/themables.js';
import { CustomFieldType, IActionButton, ICompositeComponent, ICustomField } from '../../entityPersistence/common/entityPersistence.js';
import { COMPONENT_SPECS, IComponentSpec, TEMPLATE_PALETTE_ORDER } from './componentRegistry.js';

/**
 * One entry of the component toolbox ("Base Primitives"): shown by the template designer's palette and by the
 * in-page toolbox of Freestyle tickets. {@link createComponentField} turns it into a new component.
 */
export interface IComponentPaletteItem {
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly type: CustomFieldType;
	/** Base of the new component's label (`<defaultName> 1`, `<defaultName> 2`, ...). */
	readonly defaultName: string;
	readonly defaultChoices?: readonly string[];
	/** Fresh default sub-fields of a Container (new ids on every call). */
	readonly createItemFields?: () => ICustomField[];
	/** Fresh default buttons of an Action Buttons component (new ids on every call). */
	readonly createButtons?: () => IActionButton[];
}

/** Fresh default sub-fields / buttons of the toolbox entries that need them (new ids on every call). */
const PALETTE_FACTORIES: Partial<Record<CustomFieldType, Pick<IComponentPaletteItem, 'createItemFields' | 'createButtons'>>> = {
	dynamic_list: {
		createItemFields: () => {
			const ts = Date.now();
			return [
				{ id: `sub_${ts}_1`, label: 'Item Name', type: 'text' },
				{ id: `sub_${ts}_2`, label: 'Description', type: 'textarea' }
			];
		}
	},
	button_group: {
		createButtons: () => {
			const ts = Date.now();
			return [
				{ id: `btn_${ts}_1`, label: 'Approve', color: '#22c55e', targetStatus: 'Done' },
				{ id: `btn_${ts}_2`, label: 'Reject', color: '#ef4444', targetStatus: 'Blocked' }
			];
		}
	}
};

/** The base components offered by every component toolbox, in display order (generated from the component registry). */
export const BASE_COMPONENT_PALETTE: readonly IComponentPaletteItem[] = TEMPLATE_PALETTE_ORDER.map(type => {
	const spec: IComponentSpec = COMPONENT_SPECS[type];
	const entry = spec.templatePalette;
	if (!entry) {
		throw new Error(`Component '${type}' is in TEMPLATE_PALETTE_ORDER but has no templatePalette entry.`);
	}
	return {
		label: spec.displayName,
		icon: spec.icon,
		type: spec.type,
		defaultName: entry.defaultName,
		...(entry.defaultChoices ? { defaultChoices: entry.defaultChoices } : {}),
		...PALETTE_FACTORIES[spec.type]
	};
});

/** Looks up a base component by its type (e.g. the payload of a toolbox drag). */
export function findPaletteItem(type: string): IComponentPaletteItem | undefined {
	return BASE_COMPONENT_PALETTE.find(item => item.type === type);
}

/** Context a new component needs from its host (defaults that depend on services / the workspace). */
export interface IComponentCreationContext {
	/** Provider / model a new AI Prompt starts with. */
	readonly defaultModel: { readonly providerId: string; readonly modelId: string };
	/** Ticket type a new Create Tickets component starts with ('' when none). */
	readonly defaultTicketType: string;
}

function toComponentId(label: string): string {
	return label.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

/**
 * Picks the first free `<baseName> <n>` label (n >= 1) whose label and derived id are not used by `fields`.
 * "Title" and "Description" are never chosen, as they are root fields.
 */
export function getUniqueComponentLabel(fields: readonly ICustomField[], baseName: string): { label: string; id: string } {
	let count = 1;
	let label = `${baseName} ${count}`;
	let id = toComponentId(label);
	while (
		label.toLowerCase() === 'title' ||
		label.toLowerCase() === 'description' ||
		fields.some(f => (f.label || '').toLowerCase() === label.toLowerCase() || (f.id || '').toLowerCase() === id)
	) {
		count++;
		label = `${baseName} ${count}`;
		id = toComponentId(label);
	}
	return { label, id };
}

/** Creates a new component of a toolbox entry with a unique label and the type's default configuration. */
export function createComponentField(item: IComponentPaletteItem, fields: readonly ICustomField[], context: IComponentCreationContext): ICustomField {
	const { label, id } = getUniqueComponentLabel(fields, item.defaultName);
	const field: ICustomField = { id, label, type: item.type };
	if (item.defaultChoices) {
		field.options = [...item.defaultChoices];
	}
	if (item.createItemFields) {
		field.itemFields = item.createItemFields();
	}
	if (item.createButtons) {
		field.buttons = item.createButtons();
	}
	switch (item.type) {
		case 'number':
			field.unit = '';
			field.precision = 2;
			break;
		case 'browser':
			field.defaultUrl = '';
			field.credentials = [];
			break;
		case 'git':
			field.gitCommand = 'status';
			field.gitRepoPath = '';
			break;
		case 'python':
			field.pythonPath = '';
			field.pythonEnvMode = 'existing';
			field.pythonCode = '# Write Python automation script here\nimport sys, os, json\n\n# Access upstream context via TICKET_CONTEXT (e.g. TICKET_CONTEXT.get("Field Name"))\n# Define the return value for Output Manifest and downstream steps:\nOUTPUT = {"status": "success", "message": "Hello from Python primitive"}\n';
			field.pythonOutput = '';
			break;
		case 'parameters':
			field.parameters = [{ id: `param_${Date.now()}_1`, name: 'param_1' }];
			break;
		case 'prompt':
			field.defaultContent = 'Please analyze the ticket details and execute instructions:';
			field.targetMode = 'model';
			field.targetProvider = context.defaultModel.providerId;
			field.targetModel = context.defaultModel.modelId;
			field.targetAgentId = '';
			break;
		case 'tts':
			field.defaultContent = '';
			field.ttsDisplayText = '';
			field.ttsShowSpeechTextInTicket = false;
			field.targetProvider = 'gemini';
			field.targetModel = 'gemini-2.5-flash-preview-tts';
			field.ttsFormat = 'mp3';
			field.ttsVoice = 'Kore';
			field.ttsAutoPlay = false;
			break;
		case 'media_player':
			field.mediaFilePath = '';
			field.mediaFileName = '';
			field.mediaKind = 'audio';
			field.mediaPlaybackRate = 1.0;
			field.mediaAutoPlay = false;
			// Subtitles + dictation (CI-45) are opt-in; these are the defaults once enabled.
			field.mediaSubtitlesEnabled = false;
			field.mediaSubtitleProvider = '';
			field.mediaSubtitleModel = '';
			field.mediaMaxUploadMb = 200;
			field.mediaSubtitleDisplayMode = 'single';
			field.mediaDictationUnit = 'segment';
			field.mediaDictationSeconds = 5;
			field.mediaDictationAutoPause = true;
			break;
		case 'voice_note':
			field.voiceClips = [];
			field.voiceTranscript = '';
			field.voiceAutoTranscribe = true;
			field.voicePlaybackRate = 1.0;
			field.voiceRunInFlow = false;
			break;
		case 'http_request':
			field.httpUrl = '';
			field.httpMethod = 'GET';
			field.httpAuthType = 'none';
			field.httpBodyType = 'none';
			field.httpBodyContent = '';
			field.httpHeaders = [{ key: 'Accept', value: 'application/json', enabled: true }];
			field.httpParams = [];
			field.httpTimeoutMs = 30000;
			break;
		case 'table': {
			const ts = Date.now();
			field.tableColumns = [
				{ id: `col_${ts}_1`, name: 'id', label: 'id', dataType: 'INTEGER', primaryKey: true, nullable: false },
				{ id: `col_${ts}_2`, name: 'name', label: 'name', dataType: 'TEXT', primaryKey: false, nullable: true },
				{ id: `col_${ts}_3`, name: 'status', label: 'status', dataType: 'TEXT', primaryKey: false, nullable: true },
				{ id: `col_${ts}_4`, name: 'created_at', label: 'created_at', dataType: 'DATETIME', primaryKey: false, nullable: true }
			];
			field.tableRows = [];
			field.tableDbEngine = 'sqlite';
			field.tableDbPath = '';
			field.tableDbTableName = label.toLowerCase().replace(/[^a-z0-9_]/g, '_');
			field.tableAutoSyncDb = false;
			break;
		}
		case 'output':
			// Collects every other value component (not Title / Description / other outputs)
			field.outputSpecs = fields
				.filter(f => f && f.type !== 'output' && f.type !== 'display'
					&& f.id !== 'title' && f.id !== 'description'
					&& f.label?.toLowerCase() !== 'title' && f.label?.toLowerCase() !== 'description')
				.map(f => ({ fieldKey: f.label || f.id, label: f.label || f.id, enabled: true, defaultFormat: 'table' }));
			break;
		case 'create_tickets':
			field.wfTicketType = context.defaultTicketType;
			field.wfTicketTitle = 'New Ticket {Title}';
			field.wfTicketPath = '.';
			field.wfTicketParams = {};
			break;
		case 'run_tickets':
			field.wfTicketTarget = '';
			field.wfTicketType = '';
			field.wfTicketParams = {};
			break;
		case 'get_outputs':
			field.wfTicketTarget = '';
			break;
		case 'display':
			field.wfDisplayValue = '';
			break;
		case 'sub_workflow':
			// The sub-workflow is picked on the card; its input / output definitions are filled from the ticket
			field.subWorkflowId = '';
			field.subWorkflowInputs = {};
			break;
	}
	return field;
}

/** Creates a Container component bound to a reusable class (composite component) with a unique label. */
export function createCompositeComponentField(component: ICompositeComponent, fields: readonly ICustomField[]): ICustomField {
	let count = 1;
	let label = `${component.name} ${count}`;
	while (label.toLowerCase() === 'title' || fields.some(f => (f.label || '').toLowerCase() === label.toLowerCase())) {
		count++;
		label = `${component.name} ${count}`;
	}
	return {
		id: `${toComponentId(component.name)}_${Date.now()}`,
		label,
		type: 'dynamic_list',
		componentRef: component.id,
		itemFields: JSON.parse(JSON.stringify(component.itemFields || []))
	};
}
