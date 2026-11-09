/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';

export type EntityType = 'workspace' | 'job' | 'project' | 'task' | 'workflow' | 'case' | 'agent' | 'issue' | 'analysis' | 'folder' | 'file' | string;

export interface IEntityGitSnapshot {
	remoteUrl?: string;
	branch?: string;
	lastCommitHash?: string;
	lastCommitMsg?: string;
	hasUncommittedChanges?: boolean;
	stashCount?: number;
}

export type CustomFieldType =
	| 'text'
	| 'number'
	| 'textarea'
	| 'select'
	| 'multiselect'
	| 'switch'
	| 'date'
	| 'time'
	| 'datetime'
	| 'date_range'
	| 'time_range'
	| 'datetime_range'
	| 'dynamic_list'
	| 'attachment'
	| 'button_group'
	| 'button'
	| 'browser'
	| 'git'
	| 'parameters'
	| 'prompt'
	| 'result'
	| 'output'
	| 'python'
	| 'tts'
	| 'media_player'
	| 'table'
	| 'create_tickets'
	| 'run_tickets'
	| 'get_tickets'
	| 'get_outputs'
	| 'display';

export type TableColumnDataType =
	| 'TEXT'
	| 'VARCHAR(255)'
	| 'INTEGER'
	| 'REAL'
	| 'NUMERIC'
	| 'BOOLEAN'
	| 'DATE'
	| 'DATETIME'
	| 'JSON'
	| 'BLOB'
	| string;

export interface ITableColumnDefinition {
	id: string;
	name: string;
	label?: string;
	dataType: TableColumnDataType;
	primaryKey?: boolean;
	nullable?: boolean;
	defaultValue?: string;
}

export interface IActionButton {
	id: string;
	label: string;
	color?: string;
	targetStatus?: string;
}

export interface ICredentialPair {
	id: string;
	key: string;
	value: string;
}

export interface IParameterDefinition {
	id: string;
	name: string;
	label?: string;
	defaultValue?: string;
	options?: string[];
	description?: string;
}

export interface IOutputSpec {
	fieldKey: string;
	label: string;
	enabled: boolean;
	defaultFormat?: string;
}

export interface ICustomField {
	id: string;
	label: string;
	type: CustomFieldType;
	options?: string[];
	itemFields?: ICustomField[];
	componentRef?: string;
	buttons?: IActionButton[];
	unit?: string;
	precision?: number;
	min?: number;
	max?: number;
	step?: number;
	required?: boolean;
	defaultUrl?: string;
	defaultContent?: string;
	credentials?: ICredentialPair[];
	gitRemoteUrl?: string;
	gitBranch?: string;
	parameters?: IParameterDefinition[];
	targetMode?: 'model' | 'agent';
	targetModel?: string;
	targetProvider?: string;
	targetCredentialId?: string;
	targetAgentId?: string;
	targetAgentName?: string;
	promptPreInjectedVisible?: boolean;
	promptUserInputVisible?: boolean;
	defaultUserPrompt?: string;
	defaultUserPrompts?: string[];
	defaultFormat?: string;
	outputSpecs?: IOutputSpec[];
	debugPromptOutput?: string;
	pythonPath?: string;
	pythonEnvMode?: 'existing' | 'create';
	pythonCode?: string;
	pythonOutput?: string;
	pythonResult?: any;
	externalScripts?: string[];
	ttsFormat?: 'mp3' | 'wav' | 'opus' | 'aac' | string;
	ttsVoice?: string;
	ttsAutoPlay?: boolean;
	ttsPlaybackRate?: number;
	ttsDisplayText?: string;
	ttsShowSpeechTextInTicket?: boolean;
	ttsAudioFile?: string;
	ttsAudioDataUrl?: string;
	mediaFilePath?: string;
	mediaFileName?: string;
	mediaKind?: 'audio' | 'video' | string;
	mediaMimeType?: string;
	mediaPlaybackRate?: number;
	mediaAutoPlay?: boolean;
	tableColumns?: ITableColumnDefinition[];
	tableRows?: Array<Record<string, any>>;
	tableDbEngine?: 'sqlite' | string;
	tableDbPath?: string;
	tableDbTableName?: string;
	tableAutoSyncDb?: boolean;
	tableSqlQuery?: string;
	tablePageSize?: number;
	debugSqlOutput?: string;
	wfTicketType?: string;
	wfTicketTitle?: string;
	wfTicketPath?: string;
	wfTicketTarget?: string;
	wfTicketStatus?: string;
	wfTicketParams?: Record<string, string>;
	wfDisplayValue?: string;
	outputVariableName?: string;
	outputVariableManual?: boolean;
}

const PYTHON_RESERVED_KEYWORDS = new Set([
	'false', 'none', 'true', 'and', 'as', 'assert', 'async', 'await', 'break',
	'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
	'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
	'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
]);

const SMART_VAR_STOPWORDS = new Set([
	'the', 'a', 'an', 'to', 'be', 'by', 'with', 'from', 'for', 'of', 'in', 'on',
	'at', 'and', 'or', 'is', 'are', 'was', 'were', 'been', 'being', 'this', 'that',
	'these', 'those', 'into', 'over', 'via', 'using', 'based', 'upon', 'per', 'as',
	'about', 'between', 'through', 'during', 'before', 'after', 'above', 'below'
]);

const SMART_VAR_LOW_INFO_MODIFIERS = new Set([
	'overall', 'general', 'current', 'basic', 'simple', 'standard', 'default',
	'custom', 'raw', 'new', 'my', 'our', 'all', 'each', 'every', 'single'
]);

const SMART_VAR_LEADING_VERBS = new Set([
	'fetch', 'get', 'load', 'read', 'extract', 'generate', 'create', 'build',
	'calculate', 'compute', 'analyze', 'evaluate', 'process', 'parse', 'find',
	'search', 'check', 'verify', 'run', 'execute', 'retrieve', 'collect', 'obtain',
	'determine', 'make', 'do', 'perform', 'handle'
]);

const SMART_VAR_ABBREVIATIONS: Record<string, string> = {
	description: 'desc',
	descriptions: 'descs',
	information: 'info',
	configuration: 'cfg',
	configurations: 'cfgs',
	config: 'cfg',
	parameters: 'params',
	parameter: 'param',
	application: 'app',
	applications: 'apps',
	database: 'db',
	databases: 'dbs',
	document: 'doc',
	documents: 'docs',
	documentation: 'docs',
	experience: 'exp',
	experiences: 'exp',
	formula: 'fmt',
	position: 'pos',
	positions: 'pos',
	number: 'num',
	numbers: 'nums',
	count: 'cnt',
	index: 'idx',
	temporary: 'tmp',
	message: 'msg',
	messages: 'msgs',
	response: 'resp',
	responses: 'resps',
	request: 'req',
	requests: 'reqs',
	result: 'res',
	results: 'res',
	output: 'out',
	outputs: 'out',
	value: 'val',
	values: 'vals',
	calculate: 'calc',
	calculation: 'calc',
	compute: 'calc',
	qualification: 'qual',
	qualifications: 'quals',
	qualified: 'qual',
	evaluation: 'eval',
	classification: 'cls',
	category: 'cat',
	categories: 'cats',
	candidate: 'cand',
	candidates: 'cands',
	summary: 'sum',
	summaries: 'sums',
	dictionary: 'dict',
	directory: 'dir',
	repository: 'repo',
	environment: 'env',
	credential: 'cred',
	credentials: 'creds',
	attribute: 'attr',
	attributes: 'attrs',
	property: 'prop',
	properties: 'props',
	reference: 'ref',
	references: 'refs',
	context: 'ctx',
	command: 'cmd',
	commands: 'cmds',
	text: 'txt',
	string: 'str',
	object: 'obj',
	objects: 'objs',
	function: 'fn',
	python: 'py'
};

/**
 * Generates a concise, intuitive programmer-style Python variable name from a component Field Label.
 * Avoids naively joining long sentences with underscores: strips stopwords/filler modifiers,
 * applies idiomatic developer abbreviations, and caps at 2-3 core semantic tokens.
 */
export function generateSmartPythonVarName(label?: string, fallbackType?: string): string {
	const raw = (label || '').trim().replace(/^@+/, '');
	if (!raw) {
		return sanitizePythonVarName(fallbackType || 'var');
	}

	// If already a compact valid snake_case or camelCase identifier (<= 20 chars, <= 3 parts), normalize it cleanly
	if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(raw) && raw.length <= 20 && raw.split('_').filter(Boolean).length <= 3) {
		const splitCamel = raw
			.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
			.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
			.toLowerCase()
			.replace(/_+/g, '_')
			.replace(/^_|_$/g, '');
		if (splitCamel.split('_').length <= 3 && splitCamel.length <= 22) {
			return sanitizePythonVarName(splitCamel, fallbackType);
		}
	}

	// Split CamelCase, acronyms, and non-alphanumeric boundaries into lowercase tokens
	const normalized = raw
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[^a-zA-Z0-9]+/g, ' ')
		.trim()
		.toLowerCase();

	let tokens = normalized.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return sanitizePythonVarName(fallbackType || 'res');
	}

	// Step 1: Strip filler stopwords (unless all tokens are stopwords)
	const nonStop = tokens.filter(t => !SMART_VAR_STOPWORDS.has(t));
	if (nonStop.length > 0) {
		tokens = nonStop;
	}

	// Step 2: If > 2 tokens, strip low-information modifiers (e.g. "overall", "current", "raw")
	if (tokens.length > 2) {
		const withoutLowInfo = tokens.filter((t, idx) => idx === tokens.length - 1 || !SMART_VAR_LOW_INFO_MODIFIERS.has(t));
		if (withoutLowInfo.length >= 2) {
			tokens = withoutLowInfo;
		}
	}

	// Step 3: If >= 3 tokens and starts with a generic action verb (e.g. "fetch", "get", "calculate"), drop the leading verb
	if (tokens.length >= 3 && SMART_VAR_LEADING_VERBS.has(tokens[0])) {
		tokens = tokens.slice(1);
	}

	// Step 4: Apply programmer abbreviations when multi-word or long token
	const totalRawLen = tokens.join('_').length;
	tokens = tokens.map(t => {
		if ((tokens.length >= 2 || totalRawLen > 14 || t.length > 9) && SMART_VAR_ABBREVIATIONS[t]) {
			return SMART_VAR_ABBREVIATIONS[t];
		}
		return t;
	});

	// Step 5: Deduplicate adjacent or repeated tokens while preserving order
	const deduped: string[] = [];
	for (const t of tokens) {
		if (!deduped.includes(t)) {
			deduped.push(t);
		}
	}
	tokens = deduped;

	// Step 6: Cap to at most 3 core tokens (first 2 key qualifier tokens + final head noun token)
	if (tokens.length > 3) {
		tokens = [tokens[0], tokens[1], tokens[tokens.length - 1]];
	}

	// Step 7: If still overly long (> 22 chars) with 3 tokens, keep first + last token
	let candidate = tokens.join('_');
	if (candidate.length > 22 && tokens.length === 3) {
		candidate = `${tokens[0]}_${tokens[2]}`;
	}

	return sanitizePythonVarName(candidate, fallbackType);
}

export function sanitizePythonVarName(name?: string, fallbackType?: string): string {
	let cleaned = (name || '')
		.trim()
		.replace(/^@+/, '')
		.replace(/[^a-zA-Z0-9_]+/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '');
	if (!cleaned) {
		const fb = (fallbackType || 'res').toLowerCase().replace(/[^a-z0-9_]/g, '_');
		cleaned = fb || 'res';
	}
	if (/^[0-9]/.test(cleaned)) {
		cleaned = `v_${cleaned}`;
	}
	if (PYTHON_RESERVED_KEYWORDS.has(cleaned.toLowerCase())) {
		cleaned = `${cleaned}_var`;
	}
	return cleaned;
}

export interface ICompositeComponent {
	id: string;
	name: string;
	description?: string;
	itemFields: ICustomField[];
	storageScope?: 'global' | 'workspace';
}

export interface IStatusDefinition {
	id: string;
	label: string;
	color: string;
	category: 'Todo' | 'In Progress' | 'Done' | 'Blocked' | 'Removed';
	description?: string;
}

export const DEFAULT_STATUS_DEFINITIONS: IStatusDefinition[] = [
	{ id: 'todo', label: 'Todo', color: '#818cf8', category: 'Todo', description: 'Initial backlog / pending' },
	{ id: 'in_progress', label: 'In Progress', color: '#fbbf24', category: 'In Progress', description: 'Active development' },
	{ id: 'done', label: 'Done', color: '#34d399', category: 'Done', description: 'Completed & delivered' },
	{ id: 'blocked', label: 'Blocked', color: '#f43f5e', category: 'Blocked', description: 'Waiting / on hold' },
	{ id: 'removed', label: 'Removed', color: '#94a3b8', category: 'Removed', description: 'Archived / purged' }
];

export interface ICustomModule {
	id: string;
	name: string;
	description?: string;
	prompt?: string;
	isDeprecated?: boolean;
	icon?: string;
	color: string;
	storageScope?: 'global' | 'workspace';
	updatedAt?: number;
	fields?: ICustomField[];
	statuses?: IStatusDefinition[];
}

export const DEFAULT_CUSTOM_MODULE_ICON_ID = 'package';

export interface ICustomModuleIconOption {
	id: string;
	label: string;
	icon: ThemeIcon;
}

export const CUSTOM_MODULE_ICON_LIBRARY: ICustomModuleIconOption[] = [
	{ id: 'package', label: 'Package', icon: Codicon.package },
	{ id: 'briefcase', label: 'Briefcase / Job', icon: Codicon.briefcase },
	{ id: 'rocket', label: 'Rocket', icon: Codicon.rocket },
	{ id: 'project', label: 'Project', icon: Codicon.project },
	{ id: 'checklist', label: 'Checklist / Task', icon: Codicon.checklist },
	{ id: 'tasklist', label: 'Tasklist', icon: Codicon.tasklist },
	{ id: 'github-action', label: 'Workflow', icon: Codicon.githubAction },
	{ id: 'robot', label: 'AI Agent', icon: Codicon.robot },
	{ id: 'beaker', label: 'Beaker / Case', icon: Codicon.beaker },
	{ id: 'bug', label: 'Bug / Issue', icon: Codicon.bug },
	{ id: 'graph', label: 'Graph / Analysis', icon: Codicon.graph },
	{ id: 'book', label: 'Book / Note', icon: Codicon.book },
	{ id: 'globe', label: 'Globe / Web', icon: Codicon.globe },
	{ id: 'database', label: 'Database', icon: Codicon.database },
	{ id: 'compass', label: 'Compass', icon: Codicon.compass },
	{ id: 'layers', label: 'Layers', icon: Codicon.layers },
	{ id: 'extensions', label: 'Extensions', icon: Codicon.extensions },
	{ id: 'symbol-namespace', label: 'Namespace', icon: Codicon.symbolNamespace },
	{ id: 'sparkle', label: 'Sparkle / AI', icon: Codicon.sparkle },
	{ id: 'bookmark', label: 'Bookmark', icon: Codicon.bookmark },
	{ id: 'archive', label: 'Archive', icon: Codicon.archive },
	{ id: 'organization', label: 'Organization / Team', icon: Codicon.organization },
	{ id: 'milestone', label: 'Milestone', icon: Codicon.milestone },
	{ id: 'shield', label: 'Shield / Security', icon: Codicon.shield },
	{ id: 'plug', label: 'Plug / Integration', icon: Codicon.plug },
	{ id: 'tools', label: 'Tools', icon: Codicon.tools },
	{ id: 'terminal', label: 'Terminal', icon: Codicon.terminal },
	{ id: 'tag', label: 'Tag', icon: Codicon.tag },
	{ id: 'file-text', label: 'Document', icon: Codicon.fileText },
	{ id: 'file-code', label: 'Code File', icon: Codicon.fileCode },
	{ id: 'file-media', label: 'Media', icon: Codicon.fileMedia },
	{ id: 'file-pdf', label: 'PDF / Resume', icon: Codicon.filePdf },
	{ id: 'person', label: 'Person / Profile', icon: Codicon.person },
	{ id: 'account', label: 'Account', icon: Codicon.account },
	{ id: 'mortar-board', label: 'Education', icon: Codicon.mortarBoard },
	{ id: 'calendar', label: 'Calendar', icon: Codicon.calendar },
	{ id: 'clock', label: 'Clock / Time', icon: Codicon.clock },
	{ id: 'mail', label: 'Mail', icon: Codicon.mail },
	{ id: 'comment-discussion', label: 'Discussion', icon: Codicon.commentDiscussion },
	{ id: 'megaphone', label: 'Megaphone', icon: Codicon.megaphone },
	{ id: 'lightbulb', label: 'Lightbulb / Idea', icon: Codicon.lightbulb },
	{ id: 'flame', label: 'Flame / Hot', icon: Codicon.flame },
	{ id: 'star-full', label: 'Star', icon: Codicon.starFull },
	{ id: 'heart', label: 'Heart', icon: Codicon.heart },
	{ id: 'key', label: 'Key', icon: Codicon.key },
	{ id: 'lock', label: 'Lock', icon: Codicon.lock },
	{ id: 'cloud', label: 'Cloud', icon: Codicon.cloud },
	{ id: 'server', label: 'Server', icon: Codicon.server },
	{ id: 'code', label: 'Code', icon: Codicon.code },
	{ id: 'json', label: 'JSON', icon: Codicon.json },
	{ id: 'table', label: 'Table', icon: Codicon.table },
	{ id: 'wand', label: 'Magic Wand', icon: Codicon.wand },
	{ id: 'law', label: 'Law / Policy', icon: Codicon.law },
	{ id: 'credit-card', label: 'Finance / Payment', icon: Codicon.creditCard },
	{ id: 'pulse', label: 'Pulse / Monitor', icon: Codicon.pulse },
	{ id: 'target', label: 'Target / Goal', icon: Codicon.target }
];

export const CUSTOM_MODULE_COLOR_PALETTE: string[] = [
	'#38bdf8', // Sky Blue
	'#f59e0b', // Amber
	'#ec4899', // Pink
	'#10b981', // Emerald
	'#a855f7', // Purple
	'#3b82f6', // Blue
	'#0d9488', // Teal
	'#ef4444', // Red
	'#eab308', // Yellow
	'#06b6d4', // Cyan
	'#818cf8', // Indigo
	'#fb923c', // Orange
	'#84cc16', // Lime
	'#f43f5e'  // Rose
];

const SYSTEM_MODULE_DEFAULT_ICONS: Record<string, ThemeIcon> = {
	'job': Codicon.rocket,
	'project': Codicon.project,
	'task': Codicon.checklist,
	'workflow': Codicon.githubAction,
	'case': Codicon.beaker,
	'agent': Codicon.robot,
	'issue': Codicon.bug,
	'analysis': Codicon.graph,
	'note': Codicon.book
};

export function getDefaultCustomModuleIconId(typeId?: string): string {
	const lower = (typeId || '').trim().toLowerCase();
	if (lower && SYSTEM_MODULE_DEFAULT_ICONS[lower]) {
		return SYSTEM_MODULE_DEFAULT_ICONS[lower].id;
	}
	return DEFAULT_CUSTOM_MODULE_ICON_ID;
}

export function resolveCustomModuleIcon(iconId?: string, fallbackTypeId?: string): ThemeIcon {
	const cleaned = (iconId || '').trim();
	if (cleaned) {
		const found = CUSTOM_MODULE_ICON_LIBRARY.find(item => item.id.toLowerCase() === cleaned.toLowerCase());
		if (found) {
			return found.icon;
		}
		return ThemeIcon.fromId(cleaned);
	}
	const lowerType = (fallbackTypeId || '').trim().toLowerCase();
	if (lowerType && SYSTEM_MODULE_DEFAULT_ICONS[lowerType]) {
		return SYSTEM_MODULE_DEFAULT_ICONS[lowerType];
	}
	const defaultEntry = CUSTOM_MODULE_ICON_LIBRARY.find(item => item.id === DEFAULT_CUSTOM_MODULE_ICON_ID);
	return defaultEntry ? defaultEntry.icon : Codicon.package;
}

export function getDefaultCustomModuleColor(nameOrId?: string, usedColors?: Set<string>): string {
	if (usedColors && usedColors.size > 0) {
		const unused = CUSTOM_MODULE_COLOR_PALETTE.find(c => !usedColors.has(c.toLowerCase()));
		if (unused) {
			return unused;
		}
	}
	if (!nameOrId) {
		return CUSTOM_MODULE_COLOR_PALETTE[0];
	}
	let hash = 0;
	const str = String(nameOrId).trim().toLowerCase();
	for (let i = 0; i < str.length; i++) {
		hash = str.charCodeAt(i) + ((hash << 5) - hash);
	}
	const index = Math.abs(hash) % CUSTOM_MODULE_COLOR_PALETTE.length;
	return CUSTOM_MODULE_COLOR_PALETTE[index];
}

export interface IBaseEntitySnapshot {
	entityUri: string;
	entityName: string;
	title?: string;
	ticketId?: string;
	workspaceId?: string;
	entityType: EntityType;
	entityCode?: string;
	ownerAccount?: string;
	createdAt?: string;
	description?: string;
	status?: string;
	priority?: string;
	assignedAgentId?: string;
	assignedAgentName?: string;
	agentRulePrompt?: string;
	typeDefinition?: string;
	typePrompt?: string;
	ticketPrompt?: string;
	linkTo?: string;
	linkedBy?: string;
	attachments?: string[];
	belongsToWorkspaceUri?: string;

	// Specialized properties for AI Agent
	systemPrompt?: string;
	role?: string;
	modelName?: string;
	avatarIcon?: string;
	scopeType?: string;
	scopeId?: string;
	scopeName?: string;

	// Git metadata snapshot
	git?: IEntityGitSnapshot;
	customMetadata?: { [key: string]: string };
}

export const IEntityPersistenceService = createDecorator<IEntityPersistenceService>('entityPersistenceService');

export interface IEntityPersistenceService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSnapshots: Event<void>;

	saveSnapshot(snapshot: IBaseEntitySnapshot): Promise<void>;
	getSnapshot(uri: URI | string): IBaseEntitySnapshot | undefined;
	getAllSnapshots(): IBaseEntitySnapshot[];
	removeSnapshot(uri: URI | string): Promise<void>;

	writeEntity4MDFiles(snapshot: IBaseEntitySnapshot, targetFolderUri: URI, isNewFolder?: boolean): Promise<URI>;
}

/**
 * Playback speeds required for MP3 / MP4 Player (and Audio/Video components):
 * 0.25x, 0.5x, 0.75x, 1.0x, 1.25x, 1.5x, 1.75x, 2.0x
 */
export const MEDIA_PLAYER_SPEED_OPTIONS: ReadonlyArray<{ rate: number; label: string; desc: string }> = [
	{ rate: 0.25, label: '0.25x', desc: '0.25x (Quarter Speed)' },
	{ rate: 0.5, label: '0.5x', desc: '0.5x (Half Speed)' },
	{ rate: 0.75, label: '0.75x', desc: '0.75x (Slow)' },
	{ rate: 1.0, label: '1.0x', desc: '1.0x (Normal Speed)' },
	{ rate: 1.25, label: '1.25x', desc: '1.25x (Fast)' },
	{ rate: 1.5, label: '1.5x', desc: '1.5x (Fast)' },
	{ rate: 1.75, label: '1.75x', desc: '1.75x (Fast)' },
	{ rate: 2.0, label: '2.0x', desc: '2.0x (Double Speed)' }
];

export const MEDIA_PLAYER_AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'wma', 'opus', 'weba'] as const;
export const MEDIA_PLAYER_VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv', 'avi'] as const;
export const MEDIA_PLAYER_ALL_EXTENSIONS = [...MEDIA_PLAYER_AUDIO_EXTENSIONS, ...MEDIA_PLAYER_VIDEO_EXTENSIONS] as const;

const AUDIO_EXT_SET = new Set<string>(MEDIA_PLAYER_AUDIO_EXTENSIONS);
const VIDEO_EXT_SET = new Set<string>(MEDIA_PLAYER_VIDEO_EXTENSIONS);

const EXT_TO_MIME_MAP: Record<string, string> = {
	// Audio
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	m4a: 'audio/mp4',
	aac: 'audio/aac',
	ogg: 'audio/ogg',
	oga: 'audio/ogg',
	flac: 'audio/flac',
	wma: 'audio/x-ms-wma',
	opus: 'audio/opus',
	weba: 'audio/webm',
	// Video
	mp4: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime',
	m4v: 'video/mp4',
	ogv: 'video/ogg',
	mkv: 'video/x-matroska',
	avi: 'video/x-msvideo'
};

/**
 * Automatically detects whether a media file is 'audio' or 'video', resolves its extension and MIME type,
 * and checks if it matches supported audio/video formats.
 */
export function detectMediaFileInfo(fileNameOrPath: string, explicitMime?: string): {
	kind: 'audio' | 'video';
	ext: string;
	mimeType: string;
	isRecognizedMedia: boolean;
} {
	const rawName = (fileNameOrPath || '').trim();
	const dotIdx = rawName.lastIndexOf('.');
	const ext = dotIdx >= 0 ? rawName.substring(dotIdx + 1).toLowerCase().trim() : '';
	const cleanMime = (explicitMime || '').trim().toLowerCase();

	if (VIDEO_EXT_SET.has(ext)) {
		return {
			kind: 'video',
			ext,
			mimeType: cleanMime.startsWith('video/') ? cleanMime : (EXT_TO_MIME_MAP[ext] || 'video/mp4'),
			isRecognizedMedia: true
		};
	}
	if (AUDIO_EXT_SET.has(ext)) {
		return {
			kind: 'audio',
			ext,
			mimeType: cleanMime.startsWith('audio/') ? cleanMime : (EXT_TO_MIME_MAP[ext] || 'audio/mpeg'),
			isRecognizedMedia: true
		};
	}
	if (cleanMime.startsWith('video/')) {
		return {
			kind: 'video',
			ext: ext || 'mp4',
			mimeType: cleanMime,
			isRecognizedMedia: true
		};
	}
	if (cleanMime.startsWith('audio/')) {
		return {
			kind: 'audio',
			ext: ext || 'mp3',
			mimeType: cleanMime,
			isRecognizedMedia: true
		};
	}
	return {
		kind: 'audio',
		ext: ext || 'unknown',
		mimeType: cleanMime || 'application/octet-stream',
		isRecognizedMedia: false
	};
}

