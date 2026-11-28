/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { CustomFieldType, ICustomField } from '../../entityPersistence/common/entityPersistence.js';

/*
 * Component registry (CI-30 / CI-32): the ONLY place where component types are described.
 *
 * Every consumer is generated from COMPONENT_SPECS:
 * - the help guide modal (customModules/browser/primitiveHelpGuide.ts);
 * - the component types the AI may use in templates and the per-type `config` allowlist (customModuleTools.ts);
 * - the `base_primitives` of listCustomModules and the GET_PRIMITIVES_CATALOG runtime catalog;
 * - the template / Freestyle toolbox (componentPalette.ts) and the workflow "Node Components" palette.
 *
 * The `props` of each spec are the component's configuration schema: exactly the ICustomField properties that the
 * runtime and the editors read for that type. They are used by validateComponentConfig (componentConfigSchema.ts)
 * and give typed per-component views (ComponentConfigView). The stored data format is NOT changed: fields stay flat
 * ICustomField objects on disk.
 *
 * Content rule: describe what the runtime really does (ticketWorkflowRuntime.ts / the node executor), not plans.
 *
 * RULE: when a component's behaviour changes (what it reads, what it does, what it publishes), update its spec entry
 * here (description + props + outputs + help) in the same commit. componentRegistry.test.ts enforces that every type
 * has all three, that the generated help / catalogs include the outputs, and (test/node) that every property the
 * runtime reads for a type is declared in that type's props.
 */

/** Where a component can be placed. */
export type ComponentUsage = 'ticket' | 'node';

/** Coarse group, also the `category` of the GET_PRIMITIVES_CATALOG entries. */
export type ComponentCategory = 'input' | 'processing' | 'output' | 'data' | 'composite';

/** Value type of one configuration property. */
export type ConfigPropKind = 'string' | 'number' | 'boolean' | 'stringArray' | 'objectArray' | 'object' | 'credentialArray' | 'unknown';

/**
 * Who writes a property:
 * - `config`: template setting the AI may write through the generic `config` object (the CI-20 allowlist);
 * - `structured`: template setting with its own shape, written by a dedicated property of the generate tool
 *   (options, itemFields, parameters, outputSpecs, tableColumns, buttons, number format ...);
 * - `editor`: template setting that only the designer UI writes today (the AI cannot set it yet);
 * - `state`: written by the editor or by a run (ticket value, last result, cached file); never configuration.
 */
export type ConfigPropRole = 'config' | 'structured' | 'editor' | 'state';

export interface IComponentConfigProp {
	readonly name: keyof ICustomField;
	readonly kind: ConfigPropKind;
	readonly description: string;
	/** Default `config`. */
	readonly role?: ConfigPropRole;
	/** Must be given for the component to do anything useful (checked by validateComponentConfig). */
	readonly required?: boolean;
	/** Value used when the property is omitted (what the runtime falls back to). */
	readonly default?: string | number | boolean | readonly string[];
	/** Allowed values (compared case-insensitively). */
	readonly enum?: readonly string[];
	/** Secret: the AI may only write a variable reference such as {API_TOKEN}, never the plain value. */
	readonly secret?: boolean;
	/** A ticket can keep its own value of this property, which wins over the template value at run time. */
	readonly ticketValue?: boolean;
	/** `string` kind only: objects / arrays are accepted and stored as JSON text. */
	readonly acceptsJson?: boolean;
}

/**
 * A variable a component publishes to the run context (CI-33). Name patterns:
 * - `{var}`: outputVariableName, or the name generated from the label (e.g. "AI Prompt" -> ai_prompt). Every
 *   component except Inputs / Output / Display also publishes its result under its id and its previous labels;
 * - `{Label}`: the component label; also published under the cleaned key (lowercase, other chars -> `_`);
 * - `{label_key}`: the cleaned label only.
 */
export interface IComponentOutputVar {
	readonly name: string;
	/** Type and shape of the value. */
	readonly type: string;
	/** Which run publishes it: a ticket run, a workflow node run, or both. */
	readonly when: 'both' | 'ticket' | 'node';
	readonly description: string;
	readonly example?: string;
}

/** Text of the help modal (user facing). */
export interface IComponentHelp {
	/** Category badge shown next to the title. */
	readonly badge: string;
	/** Defaults to the spec description. */
	readonly summary?: string;
	readonly designerConfig: readonly { readonly name: string; readonly desc: string }[];
	readonly headline: string;
	readonly steps: readonly { readonly step: string; readonly detail: string }[];
	readonly variableResolution: string;
	readonly downstreamPassing: string;
	readonly syntaxExamples: readonly string[];
	readonly tips: readonly string[];
}

/** Entry in the template designer / Freestyle toolbox. */
export interface ITemplatePaletteEntry {
	/** Base of the new component's label (`<defaultName> 1`, ...). */
	readonly defaultName: string;
	readonly defaultChoices?: readonly string[];
}

/** Entry in the workflow editor "Node Components" palette. */
export interface INodePaletteEntry {
	/** Short label shown in the palette. */
	readonly label: string;
	/** Accent color of the palette icon. */
	readonly accent: string;
	/** Icon override, to match the node capsule look on the canvas. Defaults to the spec icon. */
	readonly icon?: ThemeIcon;
	/** Tooltip; defaults to the spec purpose. */
	readonly tooltip?: string;
}

export interface IComponentSpec {
	readonly type: CustomFieldType;
	readonly displayName: string;
	readonly icon: ThemeIcon;
	readonly category: ComponentCategory;
	readonly usableIn: readonly ComponentUsage[];
	/** `hidden` types are never offered to the AI (template tool enum, catalogs). */
	readonly ai: 'exposed' | 'hidden';
	/** One line: what it is for. */
	readonly purpose: string;
	/** Full description for the AI catalogs (settings, values, outputs). */
	readonly description: string;
	/** What a run does with it (GET_PRIMITIVES_CATALOG executionBehavior). */
	readonly runtime: string;
	/** Configuration schema (besides COMMON_COMPONENT_PROPS). */
	readonly props: readonly IComponentConfigProp[];
	readonly outputs: readonly IComponentOutputVar[];
	/** Example component definition (as accepted by the generate-template tool). */
	readonly example: Readonly<Record<string, unknown>>;
	/** Limits, caveats and rules. */
	readonly notes: readonly string[];
	readonly help: IComponentHelp;
	readonly templatePalette?: ITemplatePaletteEntry;
	readonly nodePalette?: INodePaletteEntry;
}

/** Properties every component has. */
export const COMMON_COMPONENT_PROPS = [
	{ name: 'id', kind: 'string', role: 'structured', required: true, description: 'Stable component id (letters, digits, _ and -).' },
	{ name: 'label', kind: 'string', role: 'structured', required: true, description: 'Display name. Ticket values are stored under it, so do not rename components that already hold data.' },
	{ name: 'type', kind: 'string', role: 'structured', required: true, description: 'Component type id.' },
	{ name: 'outputVariableName', kind: 'string', description: 'Variable name later steps use. Default: generated from the label (e.g. "AI Prompt" -> ai_prompt).' },
	{ name: 'outputVariableManual', kind: 'boolean', role: 'state', description: 'True once the user typed outputVariableName by hand (it then no longer follows the label).' },
	{ name: 'disabled', kind: 'boolean', default: false, description: 'Skip this component when running.' },
	{ name: 'required', kind: 'boolean', default: false, description: 'Ticket form: the value must be filled in.' },
	{ name: 'defaultValue', kind: 'string', role: 'state', description: 'Seed value written when the component is created (e.g. the Python template); read only as a fallback.' }
] as const satisfies readonly IComponentConfigProp[];

const VAR_NOTE = 'Every value component also publishes its result under {var} (outputVariableName or the generated name), under its label and under its id. Sub-fields and suffixed outputs ({var.ok}, {var}_result, ...) are published under {var} and also under the label and its cleaned key ({Label.ok}, {label_key}_result).';

const DATE_PROPS = [
	{ name: 'defaultContent', kind: 'string', ticketValue: true, description: 'Initial value in the stored format.' }
] as const satisfies readonly IComponentConfigProp[];

function dateHelp(title: string, format: string, example: string, isRange: boolean): IComponentHelp {
	const valueDesc = isRange ? `"start ~ end", each side formatted as ${format}` : format;
	return {
		badge: 'Date & Time Dimension',
		summary: isRange
			? `Captures a ${title.toLowerCase().replace(' range', '')} range. Stored as one string: ${valueDesc} (e.g. "${example}").`
			: `Captures a single ${title.toLowerCase()} value. Stored as a string: ${valueDesc} (e.g. "${example}").`,
		designerConfig: [{ name: 'Default Value', desc: `Optional initial value in the stored format (${valueDesc}).` }],
		headline: `How RUN_TICKETS Handles ${title}`,
		steps: [
			{ step: '1. Read value', detail: 'Uses the run input override if given, otherwise the saved ticket value, otherwise the default value.' },
			{ step: '2. Pass-through', detail: 'The string is NOT reformatted or validated; {variables} inside it are interpolated, then it is stored in the context under the field label.' }
		],
		variableResolution: '{Field Label}',
		downstreamPassing: isRange
			? 'Downstream steps receive the whole "start ~ end" string. In Python, split it with value.split("~") and strip each side.'
			: 'Downstream steps receive the string as-is. Parse it in Python (e.g. datetime.fromisoformat) before comparing.',
		syntaxExamples: ['{Field Label}'],
		tips: isRange
			? ['Always keep the " ~ " separator between start and end.', `Example value: ${example}`]
			: [`Example value: ${example}`]
	};
}

function builtinHelp(title: string, summary: string, designerConfig: IComponentHelp['designerConfig'], steps: IComponentHelp['steps'], downstreamPassing: string, syntaxExamples: readonly string[], tips: readonly string[]): IComponentHelp {
	return {
		badge: 'Workflow Built-in',
		summary,
		designerConfig,
		headline: `How ${title} Runs`,
		steps,
		variableResolution: '{Output Variable}',
		downstreamPassing,
		syntaxExamples,
		tips
	};
}

const PASS_THROUGH_RUNTIME = 'Value = run input override, else the saved ticket value, else defaultContent; {variables} inside it are interpolated; the value is NOT trimmed, reformatted or validated.';

/**
 * All component specs, keyed by type, in toolbox order. `satisfies` checks every spec; `as const` keeps the property
 * names literal so ComponentConfigView can give typed per-component views.
 */
export const COMPONENT_SPECS = {
	parameters: {
		type: 'parameters',
		displayName: 'Inputs (Runtime Variables)',
		icon: Codicon.symbolVariable,
		category: 'input',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Declares the run inputs (named variables with defaults) of a ticket, node or workflow.',
		description: 'Runtime input parameters and variables for tickets with optional choices. Interpolated via {param_name} / {{param_name}} in URLs, prompts and other settings. In a ticket template the Inputs are what CREATE_TICKETS / RUN_TICKETS params fill; in the entry node of a workflow they are the WORKFLOW INPUTS (several Inputs components are accumulated in order).',
		runtime: 'For each input: value passed by the caller, else the saved ticket value, else a context variable with the same name, else defaultValue (which may itself reference {var}); each resolved value is registered as a variable under its name.',
		props: [
			{ name: 'parameters', kind: 'objectArray', role: 'structured', required: true, description: 'Inputs: [{name*, label?, defaultValue?, options?, description?}]. Each name becomes a variable {name}.' }
		],
		outputs: [
			{ name: '{name}', type: 'string', when: 'both', description: 'one variable per input (also under its label)', example: '"testing"' },
			{ name: '{Label}', type: 'object', when: 'both', description: '{name: value} of the resolved inputs of this component', example: '{"start": "0", "env": "testing"}' },
			{ name: 'Inputs', type: 'object', when: 'both', description: 'all resolved inputs of the run so far (merged)' },
			{ name: 'Parameters', type: 'object', when: 'both', description: 'same as Inputs (older name)' }
		],
		example: {
			id: 'runtime_params',
			label: 'Inputs',
			type: 'parameters',
			parameters: [
				{ id: 'param_1', name: 'start', defaultValue: '0' },
				{ id: 'param_2', name: 'env', defaultValue: 'testing', options: ['testing', 'developing', 'production'] }
			]
		},
		notes: ['Give every input a sensible default so test runs work without manual input.'],
		help: {
			badge: 'Input & Variable Definition',
			summary: 'Defines dynamic input parameters, variable names, and default fallback values passed into the ticket during manual runs or automated workflow execution.',
			designerConfig: [
				{ name: 'Field Label / Name', desc: 'Display title for the inputs group.' },
				{ name: 'Parameter Keys & Defaults', desc: 'Declare key names and initial fallback values (e.g. query: "AI Search").' },
				{ name: 'Options (optional)', desc: 'A list of allowed values; the input is then shown as a dropdown.' }
			],
			headline: 'How RUN_TICKETS Executes Inputs',
			steps: [
				{ step: '1. Receive Inputs', detail: 'runTickets inspects options.inputParams passed from the caller, workflow nodes, or user triggers.' },
				{ step: '2. Default Value Merging', detail: 'If a declared parameter is missing from inbound arguments, the primitive automatically applies its configured defaultValue.' },
				{ step: '3. Context Variable Registration', detail: 'Registers resolved parameters into contextVariables under both its key (e.g. "query") and sanitized label, enabling seamless variable interpolation downstream.' }
			],
			variableResolution: 'Available downstream as {param_name}, {{param_name}}, and {TicketName.param_name}.',
			downstreamPassing: 'Subsequent primitives (Browser, AI Prompt, Output) can immediately use these variables in URLs or prompts.',
			syntaxExamples: ['{target_keyword}', '{{target_keyword:-DefaultValue}}', '{MyTicket.target_keyword}'],
			tips: [
				'Always provide sensible default values to ensure workflow test runs succeed without manual input.',
				'Use snake_case or camelCase keys for clean variable substitution in downstream prompts.'
			]
		},
		templatePalette: { defaultName: 'Inputs' },
		nodePalette: { label: 'Inputs', accent: '#c084fc', tooltip: 'Node Inputs component. Multiple Inputs components in the entry node are accumulated in order as Workflow Inputs.' }
	},

	prompt: {
		type: 'prompt',
		displayName: 'AI Prompt (Model / Agent)',
		icon: Codicon.sparkle,
		category: 'processing',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Sends an instruction plus earlier values to a language model and publishes the reply.',
		description: 'Instruction prompt primitive. Sends a pre-injected instruction (defaultContent) plus one or more user prompts (defaultUserPrompt / defaultUserPrompts) to a Large Language Model (targetProvider / targetModel, default: the global default model). {var} / {{var}} / {{var:-default}} placeholders are interpolated; a JSON reply is parsed so later steps can read its fields.',
		runtime: 'Interpolates {variables} into the prompts, calls the selected model synchronously, captures the reply text (parsed when it is JSON) and records it on the ticket.',
		props: [
			{ name: 'defaultContent', kind: 'string', ticketValue: true, description: 'Pre-injected instruction (system-style prompt). Supports {var}.' },
			{ name: 'defaultUserPrompt', kind: 'string', ticketValue: true, description: 'User prompt. Supports {var}.' },
			{ name: 'defaultUserPrompts', kind: 'stringArray', ticketValue: true, description: 'Several user prompts, sent in order.' },
			{ name: 'targetProvider', kind: 'string', description: 'Model provider id (e.g. gemini, openai, anthropic). Default: provider of the global default model.' },
			{ name: 'targetModel', kind: 'string', description: 'Model id. Default: the global default model.' },
			{ name: 'targetCredentialId', kind: 'string', description: 'Credential to use. Default: matched automatically.' },
			{ name: 'targetMode', kind: 'string', role: 'editor', enum: ['model', 'agent'], default: 'model', description: 'model or agent. Agent mode is not implemented yet (CI-28): the model is called directly.' },
			{ name: 'targetAgentId', kind: 'string', role: 'editor', description: 'Agent id when targetMode is agent (not used at run time yet).' },
			{ name: 'targetAgentName', kind: 'string', role: 'editor', description: 'Agent display name when targetMode is agent.' },
			{ name: 'promptPreInjectedVisible', kind: 'boolean', role: 'editor', description: 'Show the pre-injected instruction on the ticket card.' },
			{ name: 'promptUserInputVisible', kind: 'boolean', role: 'editor', description: 'Show the user prompt box on the ticket card.' },
			{ name: 'debugPromptOutput', kind: 'string', role: 'state', description: 'Last reply of a node run (capped).' }
		],
		outputs: [
			{ name: '{var}', type: 'string | object', when: 'both', description: 'model reply; parsed into an object when the reply is JSON', example: '"Summary: ..."' },
			{ name: '{Label}', type: 'string | object', when: 'both', description: 'same value under the label' }
		],
		example: {
			id: 'analysis_prompt',
			label: 'AI Analysis Prompt',
			type: 'prompt',
			defaultContent: 'Please summarize the following ticket requirements and identify key risks.',
			defaultUserPrompt: 'Requirements: {requirements}',
			targetProvider: 'gemini',
			targetModel: 'gemini-2.5-flash'
		},
		notes: ['Agent mode (targetMode: agent) is not implemented yet: the run calls the model directly (CI-28).', 'An unresolved {variable} in the prompt is an error.'],
		help: {
			badge: 'AI Reasoning & Agent Execution',
			summary: 'Sends a prompt (pre-injected instruction plus user prompts, with {variables} filled in) to the selected language model and stores the reply. Agent mode can be selected but is not implemented yet: the run calls the model directly.',
			designerConfig: [
				{ name: 'Target Model', desc: 'Provider and model (e.g. Gemini 2.5 Flash, GPT-4o, Claude). Default: the global default model.' },
				{ name: 'Pre-injected Prompt', desc: 'Core persona, behavioral boundaries, and system-level instructions.' },
				{ name: 'User Prompt(s)', desc: 'Main prompt text supporting rich multi-variable interpolation with preceding inputs and web content.' }
			],
			headline: 'How RUN_TICKETS Executes AI Prompt',
			steps: [
				{ step: '1. Template Interpolation', detail: 'Replaces all {variable} and {{variable}} tags with extracted parameters, browser text, and form inputs.' },
				{ step: '2. Credential & Model Resolution', detail: 'Checks IAgentCredentialService for configured API keys (Google Gemini, OpenAI, Anthropic Claude).' },
				{ step: '3. Inference Dispatch', detail: 'Executes executePrompt(...) against the selected model API synchronously and monitors execution latency.' },
				{ step: '4. Output Capture & Audit Log', detail: 'Captures the generated response text, saves it into customMetadata and contextVariables, and prepares it for Output Manifest aggregation.' }
			],
			variableResolution: 'Access generated response via {Field Label}, {{AI Prompt 1}}, or {ticketId.AI Prompt 1}.',
			downstreamPassing: 'The Output primitive automatically detects and imports this text into the final ticket result manifest.',
			syntaxExamples: ['{AI Prompt 1}', '{{AI Prompt 1}}', '{{AI Prompt 1.result}}'],
			tips: [
				'Structure prompts with explicit formatting rules (e.g. "Output as a Markdown table with 3 columns").',
				'Combine with Browser primitive for automated web research and intelligence summarization.'
			]
		},
		templatePalette: { defaultName: 'AI Prompt' },
		nodePalette: { label: 'AI Prompt', accent: '#2dd4bf', tooltip: 'AI Prompt execution component. Supports {Component Title} and {workflow_var} interpolation.' }
	},

	tts: {
		type: 'tts',
		displayName: 'Audio / TTS (Text-to-Speech)',
		icon: Codicon.unmute,
		category: 'processing',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Turns text into an audio file (default MP3) with an AI voice model.',
		description: 'Multilingual text-to-speech audio generator using Agent Central AI models (targetProvider gemini (default) or openai). Synthesizes defaultContent into MP3 (default) or WAV/OPUS/AAC and saves the audio file persistently inside the ticket (in a workflow: the workflow attachments folder); unchanged text and settings reuse the saved file.',
		runtime: 'Reuses the saved audio when text and settings are unchanged; otherwise interpolates {variables}, synthesizes speech with the selected model and voice, saves the file under attachments/ and publishes its path. A failed synthesis fails the step.',
		props: [
			{ name: 'defaultContent', kind: 'string', required: true, ticketValue: true, description: 'Text sent to the TTS model. Supports {var}.' },
			{ name: 'ttsVoice', kind: 'string', description: 'Voice. Default: Kore (gemini) / alloy (openai).' },
			{ name: 'ttsFormat', kind: 'string', enum: ['mp3', 'wav', 'opus', 'aac'], default: 'mp3', description: 'Audio format.' },
			{ name: 'targetProvider', kind: 'string', default: 'gemini', description: 'gemini or openai.' },
			{ name: 'targetModel', kind: 'string', description: 'Default: gemini-2.5-flash-preview-tts (gemini) / tts-1 (openai).' },
			{ name: 'targetCredentialId', kind: 'string', description: 'Credential to use. Default: matched automatically.' },
			{ name: 'ttsAutoPlay', kind: 'boolean', default: false, description: 'Play the saved audio automatically when the ticket opens.' },
			{ name: 'ttsPlaybackRate', kind: 'number', default: 1, description: 'Playback speed (0.25 - 2).' },
			{ name: 'ttsDisplayText', kind: 'string', role: 'editor', description: 'Text shown to people on the ticket (e.g. with vocabulary notes) instead of the synthesized text.' },
			{ name: 'ttsShowSpeechTextInTicket', kind: 'boolean', role: 'editor', description: 'Also show the synthesized text on the ticket.' },
			{ name: 'ttsAudioFile', kind: 'string', role: 'state', description: 'Path of the last generated audio of a node run (written, never read).' },
			{ name: 'ttsAudioDataUrl', kind: 'string', role: 'state', description: 'Inline audio of the ticket card (not saved into templates).' }
		],
		outputs: [
			{ name: '{var}', type: 'string', when: 'both', description: 'path of the saved audio file', example: '"attachments/tts_audio.mp3"' },
			{ name: '{Label}', type: 'string', when: 'both', description: 'same path under the label' }
		],
		example: {
			id: 'tts_audio',
			label: 'TTS Audio',
			type: 'tts',
			defaultContent: 'Hello! Welcome to AnyAgent multilingual voice synthesis.',
			targetProvider: 'gemini',
			targetModel: 'gemini-2.5-flash-preview-tts',
			ttsFormat: 'mp3',
			ttsVoice: 'Kore',
			ttsAutoPlay: false
		},
		notes: ['Only Gemini and OpenAI TTS models are supported (CI-29).'],
		help: {
			badge: 'AI Voice & Audio Synthesis',
			summary: 'Converts multilingual text (English, Chinese, French, etc.) into an audio file (default MP3) using AI models from Agent Central (Google Gemini, OpenAI, Custom OpenAI) and saves the audio file directly inside the ticket folder for persistent playback without repeating LLM calls.',
			designerConfig: [
				{ name: 'Provider & Model Selection', desc: 'Select configured AI Provider/Credential and TTS/Voice Model (same selector as Agent Central).' },
				{ name: 'Audio Format & Voice', desc: 'Choose output format (default MP3, or WAV, OPUS, AAC) and voice profile (e.g. Alloy, Nova, Kore, Puck).' },
				{ name: 'Auto-Play Toggle', desc: 'Configure whether saved audio automatically plays when viewing the module or plays manually on click.' },
				{ name: '1. Speech Synthesis Text (AI Model)', desc: 'Pure multilingual text sent to the TTS model API to synthesize speech (hidden in the Ticket page).' },
				{ name: '2. Display Text (Human View)', desc: 'Annotated text with native-language vocabulary notes or phonetic hints shown to the user in the Ticket page.' }
			],
			headline: 'How RUN_TICKETS Executes Audio / TTS Primitive',
			steps: [
				{ step: '1. Cache & Persistence Check', detail: 'Checks if an audio file (e.g. .mp3) has already been generated for the current text and saved inside the ticket folder.' },
				{ step: '2. Variable Interpolation & Synthesis', detail: 'If not cached or if forced, interpolates {Field Label} variables and dispatches text to the selected AI model API to synthesize speech.' },
				{ step: '3. Local Ticket Storage', detail: 'Saves the returned audio binary (MP3/WAV) into the ticket attachments directory and records the file path in customMetadata.' }
			],
			variableResolution: 'Exposes the saved audio file path and text under {Field Label} in contextVariables.',
			downstreamPassing: 'Downstream steps or Output primitives can reference the generated audio file path.',
			syntaxExamples: ['{Title}', '{AI Prompt 1}', '{TTS Audio 1}'],
			tips: [
				'Once generated, the MP3 file is saved locally inside the ticket folder so reopening the ticket never re-calls the LLM API unless you clear the audio file or change the text.',
				'Enable Auto-Play if you want the audio to play automatically when opening the ticket.'
			]
		},
		templatePalette: { defaultName: 'TTS Audio' },
		nodePalette: { label: 'Audio / TTS', accent: '#f87171', tooltip: 'Text-to-Speech synthesis component.' }
	},

	media_player: {
		type: 'media_player',
		displayName: 'MP3 / MP4 Player',
		icon: Codicon.deviceCameraVideo,
		category: 'processing',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Plays a local audio / video file; optional timed subtitles and dictation practice.',
		description: 'Local HTML5 Audio & Video player supporting MP3, MP4, WAV, M4A, AAC, OGG, FLAC, WebM, MOV, etc. with drag-and-drop file import and 0.25x-2.0x playback speed control. Optional subtitles + dictation (mediaSubtitlesEnabled: true): extracts timed subtitles with a voice model (mediaSubtitleProvider openai|aliyun|gemini|custom or empty for the active voice model, mediaSubtitleModel e.g. whisper-1 / qwen3-asr-flash-us / gemini-2.5-flash, mediaSubtitleLanguage hint), limits mediaMaxUploadMb (default 200) and mediaMaxDurationMin (0 = none), mediaSubtitleDisplayMode single|scroll|dictation (dictation = Dictation practice), mediaDictationUnit segment|seconds with mediaDictationSeconds (>= 1), mediaDictationAutoPause = "Dictation mode" (default true: stop after each sentence / unit so the user can type what they hear; false: playback keeps going). A ticket run uses saved subtitles of the same file or extracts them during the run (a failed extraction fails the step).',
		runtime: 'Resolves the media file path and detects audio vs. video. With subtitles enabled (tickets only): uses the saved subtitles of the same file, otherwise extracts them now; a failed or refused extraction fails the step. Publishes the file path, or the timed subtitle text when subtitles exist.',
		props: [
			{ name: 'mediaFilePath', kind: 'string', required: true, ticketValue: true, description: 'Local media file path.' },
			{ name: 'mediaPlaybackRate', kind: 'number', default: 1, description: 'Playback speed (0.25 - 2).' },
			{ name: 'mediaAutoPlay', kind: 'boolean', default: false, description: 'Start playing when the card opens.' },
			{ name: 'mediaSubtitlesEnabled', kind: 'boolean', default: false, description: 'Enable subtitles + dictation.' },
			{ name: 'mediaSubtitleProvider', kind: 'string', enum: ['', 'openai', 'aliyun', 'gemini', 'custom'], default: '', description: 'Voice model provider; empty = the active voice model in Settings.' },
			{ name: 'mediaSubtitleModel', kind: 'string', description: 'e.g. whisper-1, qwen3-asr-flash-us, gemini-2.5-flash.' },
			{ name: 'mediaSubtitleLanguage', kind: 'string', description: 'Language hint (e.g. en, fr).' },
			{ name: 'mediaMaxUploadMb', kind: 'number', default: 200, description: 'Larger files are rejected before decoding.' },
			{ name: 'mediaMaxDurationMin', kind: 'number', default: 0, description: 'Longer files are rejected; 0 = no limit.' },
			{ name: 'mediaSubtitleDisplayMode', kind: 'string', enum: ['single', 'scroll', 'dictation'], default: 'single', description: 'single line, scrolling list, or dictation practice.' },
			{ name: 'mediaDictationUnit', kind: 'string', enum: ['segment', 'seconds'], default: 'segment', description: 'One subtitle sentence or a fixed window per dictation unit.' },
			{ name: 'mediaDictationSeconds', kind: 'number', default: 5, description: 'Window length when mediaDictationUnit is seconds (>= 1).' },
			{ name: 'mediaDictationAutoPause', kind: 'boolean', default: true, description: '"Dictation mode": stop after each unit so the user can type what they hear.' },
			{ name: 'defaultContent', kind: 'string', role: 'state', description: 'Older place of the file path (node runs); read when mediaFilePath is empty.' },
			{ name: 'mediaFileName', kind: 'string', role: 'state', ticketValue: true, description: 'File name of the imported media.' },
			{ name: 'mediaKind', kind: 'string', role: 'state', description: 'audio or video (detected).' },
			{ name: 'mediaMimeType', kind: 'string', role: 'state', description: 'Detected MIME type.' }
		],
		outputs: [
			{ name: '{var}', type: 'string', when: 'both', description: 'media file path; with subtitles extracted (ticket run): the timed subtitle text, one "[start - end] text" line per segment', example: '"[0:01.2 - 0:03.4] Hello there"' },
			{ name: '{Label}', type: 'string', when: 'both', description: 'same value under the label' },
			{ name: '{Label Subtitles}', type: 'string', when: 'ticket', description: 'timed subtitle text, when subtitles are enabled and extracted' },
			{ name: '{Label Path}', type: 'string', when: 'ticket', description: 'media file path, when subtitles are enabled and extracted' }
		],
		example: {
			id: 'media_player_1',
			label: 'MP3 / MP4 Player',
			type: 'media_player',
			mediaFilePath: '',
			mediaPlaybackRate: 1.0,
			mediaSubtitlesEnabled: true,
			mediaSubtitleDisplayMode: 'dictation',
			mediaDictationAutoPause: true
		},
		notes: ['In a workflow node (no ticket) subtitles are not extracted.', 'Subtitles are saved as attachments/subtitles_<field>.json in the ticket.'],
		help: {
			badge: 'Local Media Playback',
			summary: 'Plays local MP3 audio, MP4 video, and other browser-compatible audio/video formats (WAV, M4A, AAC, OGG, FLAC, WebM, MOV, M4V, etc.) directly inside the Workflow or Ticket using native HTML5 Audio / Video capabilities.',
			designerConfig: [
				{ name: 'File Import (Select or Drag & Drop)', desc: 'Click the file selection button or drag and drop a local audio/video file directly into the component.' },
				{ name: 'Auto-Switching Audio / Video Player', desc: 'Automatically detects whether the imported file is Audio (e.g. MP3) or Video (e.g. MP4) and displays the matching player UI.' },
				{ name: 'Playback Speed Control (0.25x - 2.0x)', desc: 'Adjust playback speed across 0.25x, 0.5x, 0.75x, 1.0x, 1.25x, 1.5x, 1.75x, and 2.0x for both audio and video.' },
				{ name: 'Subtitles & Dictation (optional, mediaSubtitlesEnabled)', desc: 'Off by default. When enabled, the sparkle button on the card (or "Extract subtitles" in the component settings opened from the gear on the ticket card, using the settings in that dialog) extracts timed subtitles: the audio track is decoded locally (no ffmpeg), resampled to 16 kHz mono WAV, split into chunks, and sent to the chosen voice model. Saved as attachments/subtitles_<field>.json in the ticket (with the media name, path and size); export to SRT / VTT. In the template designer there is no ticket to save into, so extraction is only offered from a ticket.' },
				{ name: 'Subtitle Model (mediaSubtitleProvider / mediaSubtitleModel / mediaSubtitleLanguage)', desc: 'openai whisper-1 returns native segment timestamps; aliyun qwen3-asr-flash-us (US keys) and other text-only models get timing from local pause detection; gemini / qwen omni models are asked for JSON timestamps (approximate). Empty provider = the active voice model in Settings.' },
				{ name: 'Limits (mediaMaxUploadMb / mediaMaxDurationMin)', desc: 'Files larger than the MB limit (default 200) or longer than the minute limit (0 = none) are rejected before decoding.' },
				{ name: 'Display Modes (mediaSubtitleDisplayMode)', desc: 'single = current line only; scroll = all lines with the current one centred and clickable; dictation (Dictation practice) = the current unit is hidden, the user types what they hear and gets a word-level diff (correct / wrong / missing / extra) and a reveal option.' },
				{ name: 'Dictation Unit and Dictation Mode (mediaDictationUnit / mediaDictationSeconds / mediaDictationAutoPause)', desc: 'segment = one subtitle sentence per unit; seconds = fixed windows of N seconds (minimum 1). Dictation mode (stored as mediaDictationAutoPause, default on): "Stop after each sentence so I can type what I hear" - playback stops at the end of each unit and waits for the answer; off = playback keeps going and the dictation box follows along. Keys: Enter check / continue, Ctrl+R replay, Ctrl+B / Ctrl+N previous / next, Ctrl+E reveal. Answers are saved in the ticket keyed by unit start time.' }
			],
			headline: 'How RUN_TICKETS Executes MP3 / MP4 Player Primitive',
			steps: [
				{ step: '1. File Path Resolution', detail: 'Resolves the imported local media file path and auto-detects Audio vs. Video format.' },
				{ step: '2. Subtitles (when enabled)', detail: 'Uses the saved subtitles when they were extracted from this same file (name / path and size); otherwise extracts them now with the component settings (same limits and progress as the card) and saves them in the ticket. A failed or refused extraction (e.g. over the size limit) fails this step with the reason. In a workflow node (no ticket) subtitles are not extracted.' },
				{ step: '3. Context Export', detail: 'Exposes the local media file path, or the timed subtitles, to downstream steps in contextVariables.' }
			],
			variableResolution: 'Exposes the local media file path under {Field Label} in contextVariables. With subtitles enabled and extracted, {Field Label} is the timed subtitle text ("[0:01.2 - 0:03.4] line" per line), {Field Label Subtitles} the same text and {Field Label Path} the media path.',
			downstreamPassing: 'Downstream Python or AI Prompt steps can reference the imported media file path, or the timed subtitles when they were extracted.',
			syntaxExamples: ['{MP3 / MP4 Player 1}'],
			tips: [
				'Supports both clicking to select a local file and dragging & dropping a file from Finder / Explorer.',
				'Scrub or click anywhere on the progress bar to jump to a specific timestamp.'
			]
		},
		templatePalette: { defaultName: 'MP3 / MP4 Player' },
		nodePalette: { label: 'MP3 / MP4 Player', accent: '#f59e0b', tooltip: 'Local MP3 / MP4 & multi-format Audio/Video Player component with 0.25x-2.0x speed control.' }
	},

	voice_note: {
		type: 'voice_note',
		displayName: 'Voice Note (Recorder & Transcript)',
		icon: Codicon.mic,
		category: 'processing',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Records voice clips and keeps their (editable) transcript.',
		description: 'Records voice clips via microphone with automatic Speech-to-Text transcription and editable text. Automatically surfaces a top-right speaker playback icon when placed in a Workflow Flowchart Node. Recording is done by a person; the AI normally only reads the transcript.',
		runtime: 'Publishes the combined transcript of all clips (the edited transcript when present). With voiceRunInFlow the node also plays the clips during a workflow run.',
		props: [
			{ name: 'voiceRunInFlow', kind: 'boolean', default: false, description: 'Play the recordings when the workflow runs this node.' },
			{ name: 'voiceAutoTranscribe', kind: 'boolean', default: true, description: 'Transcribe each new clip automatically.' },
			{ name: 'voicePlaybackRate', kind: 'number', role: 'editor', default: 1, description: 'Playback speed of the clips.' },
			{ name: 'voiceClips', kind: 'objectArray', role: 'state', description: 'Recorded clips (audio + transcript).' },
			{ name: 'voiceTranscript', kind: 'string', role: 'state', description: 'Combined / edited transcript.' }
		],
		outputs: [
			{ name: '{var}', type: 'string', when: 'both', description: 'combined (edited) transcript of all clips' },
			{ name: '{Label}', type: 'string', when: 'both', description: 'same text under the label' }
		],
		example: {
			id: 'voice_note_1',
			label: 'Voice Note',
			type: 'voice_note',
			voiceAutoTranscribe: true
		},
		notes: ['Clips are recorded by a person; there is nothing for the AI to configure besides the two flags.'],
		help: {
			badge: 'Voice Notes & Documentation',
			summary: 'Records one or more voice memos directly via microphone with automatic Speech-to-Text transcription and editable text notes. When placed inside a Workflow Flowchart Node, the node automatically displays a speaker icon at its top-right corner to play all recorded voice clips sequentially.',
			designerConfig: [
				{ name: 'Microphone Recording', desc: 'Click the microphone button to record one or multiple audio clips (up to 5 minutes per clip). Audio is saved persistently inside the component.' },
				{ name: 'Auto-Transcribe & Edit', desc: 'Automatically transcribes each recorded clip using the configured Voice Model (IVoiceModelService) and allows manual editing or re-transcription.' },
				{ name: 'Node Top-Right Speaker Playback', desc: 'Any Workflow Flowchart Node containing a Voice Note component automatically displays a speaker icon in its top-right corner. Click it to play all recorded clips in order.' }
			],
			headline: 'How Workflows & Tickets Use Voice Note',
			steps: [
				{ step: '1. Transcript Aggregation', detail: 'Collects transcripts from all recorded clips inside the Voice Note component.' },
				{ step: '2. Context Export', detail: 'Exposes the combined transcript text under {Field Label} so downstream AI Prompt or Python steps can reference your spoken notes.' }
			],
			variableResolution: 'Exposes the combined voice transcript text under {Field Label} in contextVariables.',
			downstreamPassing: 'Downstream AI Prompt, Python, or Display steps can reference the transcribed notes directly.',
			syntaxExamples: ['{Voice Note}'],
			tips: [
				'Drag Voice Note into any Flowchart Node to attach spoken design rationale or usage instructions.',
				'Click the top-right speaker icon on a Flowchart Node to play all recorded voice clips one by one without opening the side panel.'
			]
		},
		templatePalette: { defaultName: 'Voice Note' },
		nodePalette: { label: 'Voice Note', accent: '#94a3b8', tooltip: 'Record voice memos with automatic Speech-to-Text transcription. Automatically adds a top-right speaker icon on the node to play all recorded clips sequentially.' }
	},

	browser: {
		type: 'browser',
		displayName: 'Browser (Web Application)',
		icon: Codicon.globe,
		category: 'processing',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Opens a URL and extracts the readable page text.',
		description: 'Opens defaultUrl and extracts the readable page text (retries, then falls back to a plain HTTP GET). The URL supports {variable} references. credentials is a list of {key, value} pairs set in the template (tickets only see the names): write {key} in the URL and the run replaces it with the URL-encoded value (a credential wins over a variable with the same name); a credential not referenced in the URL is sent as an HTTP request header named after its key (e.g. Authorization, Cookie, X-Api-Key). Credential values are shown as *** in logs, outputs and the stored URL. Values written by the AI must be variable references like {SITE_API_KEY}, never plain text.',
		runtime: 'Uses the template\'s (or the node\'s) credentials, never a list stored on the ticket. Replaces {name} credentials and {variables} in the URL. Without header credentials it extracts the page with the built-in web content extractor and falls back to a plain HTTP GET with tags stripped; with header credentials it uses the plain HTTP GET only (the extractor cannot send request headers). Retries browserMaxRetries times, browserRetryDelayMs apart, and publishes the page text and the masked URL.',
		props: [
			{ name: 'defaultUrl', kind: 'string', required: true, ticketValue: true, description: 'URL to open. Supports {variable} and {credential} references.' },
			{ name: 'browserMaxRetries', kind: 'number', default: 3, description: 'Retries after a failed fetch (0 - 10).' },
			{ name: 'browserRetryDelayMs', kind: 'number', default: 1000, description: 'Delay between retries in ms.' },
			{ name: 'credentials', kind: 'credentialArray', secret: true, description: '[{key, value}] pairs set in the template. A {key} in the URL is replaced with the value; the others are sent as request headers named after the key. Values are secrets.' },
			{ name: 'lastResolvedUrl', kind: 'string', role: 'state', description: 'Masked URL of the last run.' }
		],
		outputs: [
			{ name: '{var}', type: 'string', when: 'both', description: 'extracted readable page text' },
			{ name: '{Label}', type: 'string', when: 'both', description: 'same text under the label' },
			{ name: '{var}_url', type: 'string', when: 'both', description: 'URL with credential values shown as ***', example: '"https://site/api?key=***"' },
			{ name: '{var}_resolved_url', type: 'string', when: 'both', description: 'same masked URL (older name)' },
			{ name: '{Label}_url', type: 'string', when: 'node', description: 'masked URL under the raw label (node runs only)' }
		],
		example: {
			id: 'web_browser',
			label: 'Browser',
			type: 'browser',
			defaultUrl: 'https://example.com/api?user={user}',
			credentials: [
				{ id: 'cred_1', key: 'user', value: '{SITE_USER}' },
				{ id: 'cred_2', key: 'Authorization', value: 'Bearer {SITE_API_TOKEN}' }
			]
		},
		notes: [
			'There are no CSS selectors or scraping modes: the whole readable text is returned.',
			'Credentials come from the template only. Ticket users see the names with the values masked and cannot change them; credential lists stored on older tickets are ignored.',
			'Prefer header credentials (Authorization, Cookie, API-key headers) to tokens in the URL: URLs end up in browser history, server and proxy logs.',
			'With header credentials the page is fetched with a plain HTTP GET (no JavaScript rendering, no integrated-browser cookies), because the built-in extractor cannot send request headers.',
			'Only credential values are masked; secrets typed directly into the URL are not.'
		],
		help: {
			badge: 'Web Application & Navigation',
			summary: 'Opens a URL and extracts the readable text of the page so later steps (e.g. an AI Prompt) can use it. Retries on failure and falls back to a plain HTTP GET.',
			designerConfig: [
				{ name: 'Target URL', desc: 'URL to open. Supports {variable} references to Inputs and earlier outputs (e.g. https://news.ycombinator.com/item?id={item_id}) and {name} references to Credentials.' },
				{ name: 'Credentials', desc: 'Any number of name = value pairs, set here by the template author (ticket users only see the names, with values masked). Write {name} in the URL to put the URL-encoded value there. A credential not referenced in the URL is sent as an HTTP request header named after it, e.g. Authorization = Bearer {SITE_API_TOKEN}, Cookie = sid={SITE_SESSION} or X-Api-Key = {SITE_API_KEY}. Headers are the normal, safer place for tokens: URLs end up in browser history, server and proxy logs. A value may itself be a variable reference such as {SITE_API_KEY}.' },
				{ name: 'Retries', desc: 'Max retries (default 3, up to 10) and delay between retries (default 1000 ms).' }
			],
			headline: 'How RUN_TICKETS Executes Browser Primitive',
			steps: [
				{ step: '1. URL Resolution', detail: 'Uses the template\'s credentials. Replaces each {name} of a credential with its URL-encoded value (a credential wins over a variable with the same name), then replaces other {variable} references with Inputs or earlier outputs. Unknown {x} stay as written. Credentials not referenced in the URL become request headers named after them.' },
				{ step: '2. Fetch with Retries', detail: 'Without header credentials, extracts the page with the built-in web content extractor and, if it fails, falls back to a plain HTTP GET with tags stripped. With header credentials, uses the plain HTTP GET with those headers directly (the extractor cannot send headers). Failed attempts are retried with the configured delay.' },
				{ step: '3. Secret Masking', detail: 'Credential values are shown as *** in the stored URL, {FieldLabel_url}, run details (header names only), logs and error messages. The fetched page text itself is not changed.' },
				{ step: '4. Output', detail: 'Stores the page text as {FieldLabel} and the masked URL as {FieldLabel_url}.' }
			],
			variableResolution: 'Access the extracted text via {Field Label} or {{Field Label}}; the masked URL via {Field Label_url}.',
			downstreamPassing: 'Subsequent AI Prompt primitives can reference {{Browser 1}} to summarize or analyze the page.',
			syntaxExamples: ['https://site/api?user={user}&key={my_api_key}', '{Browser 1}', '{Browser 1_url}'],
			tips: [
				'Put secrets in Credentials, not directly in the URL: only credential values are masked.',
				'Keep URLs fully qualified (including https://).'
			]
		},
		templatePalette: { defaultName: 'Browser' },
		nodePalette: { label: 'Browser', accent: '#38bdf8', tooltip: 'Headless Browser & Scraper component. Stores extracted content in Component Title variable.' }
	},

	git: {
		type: 'git',
		displayName: 'Git (Repository Command)',
		icon: Codicon.sourceControl,
		category: 'processing',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Runs one git command (status, clone, checkout, pull, fetch, add, commit, push, log, diff, branch or custom) in a repository.',
		description: 'Runs one real git command on this computer. gitCommand selects it: status | clone | checkout | pull | fetch | add | commit | push | log | diff | branch | custom (default status). gitRepoPath is the working directory for every command except clone (absolute, ~/..., or relative to the workspace folder). Parameters per command: clone = gitRemoteUrl (required), gitCloneDir (target directory; default: repo name in the workspace folder), gitBranch (optional); checkout = gitBranch (required), gitCreateBranch (-b); pull = gitRemote, gitBranch; fetch = gitRemote; add = gitPaths (default ".") or gitAll (git add -A, paths not used); commit = gitMessage (required; runs only git commit, it never stages: put an add card before it); push = gitRemote, gitBranch, gitSetUpstream (-u); log = gitLogCount (default 10); diff = gitDiffTarget (optional target / paths / options); branch = gitBranch (empty: list all branches, set: create it); custom = gitCustomArgs (the arguments after "git", required). Every text value supports {variable} references; a variable is always ONE argument (no word splitting). Arguments are run as an argv array without a shell. git never prompts (GIT_TERMINAL_PROMPT=0): authentication uses the user\'s existing credential helpers / SSH keys; never put credentials in the config. Each command is exactly ONE git invocation, the same as the native git command: commands are never combined (no add + commit in one card). Force push and reset --hard are not offered (only custom runs what the user explicitly wrote). A non-zero exit code fails the component.',
		runtime: 'Merges the ticket\'s own settings over the template, resolves {variables}, builds the argv of ONE git command (never a chain; the deprecated gitAddAll of older commit cards is ignored and only logged), runs git in gitRepoPath via the shared-process git service (timeout 120 s, non-interactive), captures stdout, stderr, exit code and duration, then reads the current branch (git rev-parse --abbrev-ref HEAD) and short HEAD commit. Publishes the main text and the structured fields; stores the result (stdout / stderr cut to 3072 bytes) in the ticket value under gitLastResult. Exit code != 0, a timeout or an invalid config fails the step (the run stops like for other components). A template with neither gitCommand nor gitRepoPath (pre CI-24 reference-only component) runs nothing and publishes gitRemoteUrl.',
		props: [
			{ name: 'gitCommand', kind: 'string', enum: ['status', 'clone', 'checkout', 'pull', 'fetch', 'add', 'commit', 'push', 'log', 'diff', 'branch', 'custom'], default: 'status', ticketValue: true, description: 'git command to run.' },
			{ name: 'gitRepoPath', kind: 'string', ticketValue: true, description: 'Repository path / working directory (all commands except clone). Supports {var}.' },
			{ name: 'gitRemoteUrl', kind: 'string', ticketValue: true, description: 'clone: repository URL. Supports {var}.' },
			{ name: 'gitCloneDir', kind: 'string', ticketValue: true, description: 'clone: target directory (default: repo name in the workspace folder).' },
			{ name: 'gitBranch', kind: 'string', ticketValue: true, description: 'Branch: checkout target (required), pull / push branch, clone --branch, or the branch to create with the branch command.' },
			{ name: 'gitRemote', kind: 'string', ticketValue: true, description: 'pull / fetch / push: remote (e.g. origin).' },
			{ name: 'gitCreateBranch', kind: 'boolean', default: false, ticketValue: true, description: 'checkout: create the branch (git checkout -b).' },
			{ name: 'gitPaths', kind: 'string', default: '.', ticketValue: true, description: 'add: paths, separated by spaces (quote paths that contain spaces).' },
			{ name: 'gitMessage', kind: 'string', ticketValue: true, description: 'commit: commit message (required). Supports {var}.' },
			{ name: 'gitAll', kind: 'boolean', default: false, ticketValue: true, description: 'add: stage all changes (git add -A); gitPaths is not used.' },
			{ name: 'gitAddAll', kind: 'boolean', role: 'state', ticketValue: true, description: 'Deprecated (CI-63), never run: older commit cards ran git add -A first. Kept so old data loads; the card shows a one-time notice. Use an add card (gitAll) before the commit card instead.' },
			{ name: 'gitLogCount', kind: 'number', default: 10, ticketValue: true, description: 'log: number of commits.' },
			{ name: 'gitDiffTarget', kind: 'string', ticketValue: true, description: 'diff: optional target / paths / options (e.g. HEAD~1, --stat, src/).' },
			{ name: 'gitSetUpstream', kind: 'boolean', default: false, ticketValue: true, description: 'push: set upstream (git push -u).' },
			{ name: 'gitCustomArgs', kind: 'string', ticketValue: true, description: 'custom: the arguments after "git" (required), e.g. stash list. Quotes group words.' },
			{ name: 'gitLastResult', kind: 'object', role: 'state', ticketValue: true, description: 'Result of the last run (stdout / stderr cut to 3072 bytes).' }
		],
		outputs: [
			{ name: '{var}', type: 'string', when: 'both', description: 'main text: stdout, or stderr when the command failed', example: '"On branch main\\nnothing to commit"' },
			{ name: '{Label}', type: 'string', when: 'both', description: 'same text under the label' },
			{ name: '{var.ok}', type: 'boolean', when: 'both', description: 'true when the git command exited with 0', example: 'true' },
			{ name: '{var.exitCode}', type: 'number', when: 'both', description: 'exit code (-1 when git could not start)', example: '0' },
			{ name: '{var.stdout}', type: 'string', when: 'both', description: 'standard output' },
			{ name: '{var.stderr}', type: 'string', when: 'both', description: 'standard error' },
			{ name: '{var.command}', type: 'string', when: 'both', description: 'command line that ran', example: '"git commit -m \'Fix\'"' },
			{ name: '{var.repoPath}', type: 'string', when: 'both', description: 'working directory (clone: the new folder)' },
			{ name: '{var.branch}', type: 'string', when: 'both', description: 'current branch after the command', example: '"main"' },
			{ name: '{var.commit}', type: 'string', when: 'both', description: 'short HEAD commit after the command', example: '"3f2a9c1"' },
			{ name: '{var}_result', type: 'object', when: 'both', description: 'all fields above as one dict (Python: TICKET_CONTEXT["git_1_result"]["exitCode"]); also under {label_key}_result' }
		],
		example: {
			id: 'git_commit',
			label: 'Commit Changes',
			type: 'git',
			gitCommand: 'commit',
			gitRepoPath: '{repo_path}',
			gitMessage: 'Update report for {ticketId}'
		},
		notes: [
			'Runs real git commands on the user\'s computer: commit / push / checkout change the repository.',
			'Credentials are never stored in the config: git uses the user\'s credential helper / SSH agent and never prompts; a missing login fails the step.',
			'Structured fields are read with a dot: {Commit Changes.exitCode}, {Commit Changes.branch}.',
			'One card runs one native git command. To stage and commit, use two cards: add (gitAll: true for git add -A) and then commit.'
		],
		help: {
			badge: 'Environment & Version Control',
			summary: 'Runs one git command in a local repository: status, clone, checkout, pull, fetch, add, commit, push, log, diff, branch, or any custom arguments. Shows the command, exit code, duration and output under the card, and passes the result to later steps.',
			designerConfig: [
				{ name: 'Command', desc: 'Pick the git command; only its parameters are shown.' },
				{ name: 'Repository path', desc: 'Working directory for every command except clone. Absolute, ~/..., or relative to the workspace folder; {variables} allowed.' },
				{ name: 'Parameters', desc: 'clone: URL, target directory, branch · checkout: branch, create new · pull: remote, branch · fetch: remote · add: paths or all changes (-A) · commit: message (stage first with an add card) · push: remote, branch, set upstream · log: count · diff: target / paths · branch: name (empty = list) · custom: arguments after "git".' }
			],
			headline: 'How RUN_TICKETS Executes Git',
			steps: [
				{ step: '1. Resolve', detail: 'Ticket settings win over the template. {variables} are resolved in every value; each variable stays one argument.' },
				{ step: '2. Run', detail: 'git runs with the argument list (no shell) in the repository path, non-interactively, timeout 120 s. One card is one git command, never a chain: commit only commits (stage with an add card before it).' },
				{ step: '3. Inspect', detail: 'Reads the current branch and short HEAD commit after the command.' },
				{ step: '4. Publish', detail: '{var} / {Label} = stdout (stderr on failure); {var.ok}, .exitCode, .stdout, .stderr, .command, .repoPath, .branch, .commit (also under the label: {Label.ok}, ...). A non-zero exit fails the step.' }
			],
			variableResolution: '{output_var} or {Field Label} for the output text, {output_var.exitCode} / {Field Label.branch} ... for the fields.',
			downstreamPassing: 'Later steps read {Field Label} and its fields; Python gets TICKET_CONTEXT["Field Label"] (text) and TICKET_CONTEXT["field_label_result"] (dict).',
			syntaxExamples: ['{Git Status}', '{Git Status.branch}', '{Commit Changes.commit}', 'TICKET_CONTEXT["commit_changes_result"]["exitCode"]'],
			tips: [
				'Log in once in a terminal (or set up an SSH key / credential helper): the component never asks for passwords.',
				'Use custom for anything else (e.g. stash list, tag v1.0); force push and reset --hard are deliberately not offered as options.'
			]
		},
		templatePalette: { defaultName: 'Git' },
		nodePalette: { label: 'Git', accent: '#a3e635', icon: Codicon.gitMerge, tooltip: 'Run a git command (status, clone, checkout, pull, fetch, add, commit, push, log, diff, branch, custom) and publish its output.' }
	},

	shell: {
		type: 'shell',
		displayName: 'Shell (Local Script)',
		icon: Codicon.terminal,
		category: 'processing',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Runs a command or multi-line script with zsh, bash or sh on this computer.',
		description: 'Runs shellScript (one command or a multi-line script) locally with shellType (zsh | bash | sh; default zsh on macOS, bash elsewhere) as `<shell> -c <script>`, in shellCwd (absolute, ~/..., or relative to the workspace / workflow folder; default the workspace folder). shellEnv adds environment variables, one KEY=VALUE per line (no secrets in plain text: a secret-looking name must reference a variable, e.g. API_TOKEN={API_TOKEN}; BASH_ENV, ENV, ZDOTDIR, IFS, LD_* / DYLD_* and ANYAGENT_VAR_* are refused). shellTimeoutSec (default 120, max 3600) kills the whole process group. {variables} in the script are NOT pasted into the script text: each is passed as an environment variable and the reference becomes "${ANYAGENT_VAR_name}", so a value can never inject shell syntax (it stays one word, also inside quotes). References with no value (e.g. awk \'{print $1}\') are left as written. Non-interactive: no stdin, no terminal; commands that prompt fail. SAFETY: a script written or changed by AI must be confirmed by a person (Confirm button on the card, which shows the full script, folder and shell) before its first run; scripts typed in the UI are confirmed implicitly. An unconfirmed script fails the step with "Shell script needs confirmation". A non-zero exit code, a timeout or an invalid config fails the component; it is never retried automatically.',
		runtime: 'Merges the ticket\'s own settings over the template, checks the confirmation marker (shellConfirmedHash = HMAC of shell + cwd + script + env with a local key; fails the step when it does not match), resolves {variables} into ANYAGENT_VAR_* environment variables, runs `<shell> -c <script>` in the working directory via the shared-process service (stdin closed, no TTY, process group killed on timeout / Stop), captures stdout / stderr (4 MB each), exit code and duration. Publishes the main text and the structured fields; stores the result (stdout / stderr cut to 3072 bytes) under shellLastResult. Exit code != 0, a timeout, an unconfirmed script or an invalid config fails the step (the run stops like for other components); never retried.',
		props: [
			{ name: 'shellScript', kind: 'string', required: true, ticketValue: true, description: 'Command or multi-line script. {var} references are passed as environment variables (never pasted as text).' },
			{ name: 'shellCwd', kind: 'string', ticketValue: true, description: 'Working directory: absolute, ~/..., or relative to the workspace / workflow folder (default: that folder). Supports {var}.' },
			{ name: 'shellType', kind: 'string', enum: ['zsh', 'bash', 'sh'], default: 'zsh', ticketValue: true, description: 'Shell: zsh (default on macOS), bash (default elsewhere) or sh.' },
			{ name: 'shellEnv', kind: 'string', ticketValue: true, description: 'Extra environment variables, one KEY=VALUE per line; values support {var}. Never plain-text secrets.' },
			{ name: 'shellTimeoutSec', kind: 'number', default: 120, ticketValue: true, description: 'Timeout in seconds (1-3600); the process group is killed after it.' },
			{ name: 'shellConfirmedHash', kind: 'string', role: 'state', ticketValue: true, description: 'Confirmation marker set by the UI (user edit or Confirm dialog). Never written by AI; a changed script invalidates it.' },
			{ name: 'shellLastResult', kind: 'object', role: 'state', ticketValue: true, description: 'Result of the last run (stdout / stderr cut to 3072 bytes).' }
		],
		outputs: [
			{ name: '{var}', type: 'string', when: 'both', description: 'main text: stdout, or stderr when the script failed', example: '"build ok\\n"' },
			{ name: '{Label}', type: 'string', when: 'both', description: 'same text under the label' },
			{ name: '{var.ok}', type: 'boolean', when: 'both', description: 'true when the script exited with 0', example: 'true' },
			{ name: '{var.exitCode}', type: 'number', when: 'both', description: 'exit code (-1 when it could not start, 124 on timeout)', example: '0' },
			{ name: '{var.stdout}', type: 'string', when: 'both', description: 'standard output' },
			{ name: '{var.stderr}', type: 'string', when: 'both', description: 'standard error' },
			{ name: '{var.command}', type: 'string', when: 'both', description: 'script as executed ({variables} shown as "${ANYAGENT_VAR_...}")', example: '"ls -la \\"${ANYAGENT_VAR_folder}\\""' },
			{ name: '{var.cwd}', type: 'string', when: 'both', description: 'working directory', example: '"/Users/me/project"' },
			{ name: '{var.durationMs}', type: 'number', when: 'both', description: 'duration in milliseconds', example: '42' },
			{ name: '{var}_result', type: 'object', when: 'both', description: 'all fields above as one dict (Python: TICKET_CONTEXT["shell_1_result"]["exitCode"]); also under {label_key}_result' }
		],
		example: {
			id: 'shell_build',
			label: 'Build Project',
			type: 'shell',
			shellScript: 'npm ci\nnpm run build -- --out "{out_dir}"',
			shellCwd: '{repo_path}',
			shellType: 'zsh',
			shellTimeoutSec: 600
		},
		notes: [
			'Runs real commands on the user\'s computer. A script written or changed by AI does not run until a person confirms it on the card.',
			'Do not put passwords or tokens into shellScript or shellEnv: reference a variable (e.g. TOKEN={API_TOKEN}).',
			'{variables} reach the script as environment variables ("${ANYAGENT_VAR_name}"); write them where a shell word is expected. Inside a quoted heredoc (<<\'EOF\') they are not replaced.',
			'Structured fields are read with a dot: {Build Project.exitCode}, {Build Project.stderr}.'
		],
		help: {
			badge: 'Execution & Automation',
			summary: 'Runs a command or a multi-line script with zsh, bash or sh on this computer. Shows the script, exit code, duration and output under the card, and passes the result to later steps.',
			designerConfig: [
				{ name: 'Script', desc: 'One command or several lines. {variables} are allowed and are passed safely as environment variables.' },
				{ name: 'Working directory', desc: 'Absolute, ~/..., or relative to the workspace / workflow folder. Empty: the workspace folder.' },
				{ name: 'Shell', desc: 'zsh (default on macOS), bash or sh.' },
				{ name: 'Environment', desc: 'Optional KEY=VALUE lines. No plain-text secrets: use KEY={variable}.' },
				{ name: 'Timeout', desc: 'Seconds before the script and its child processes are stopped (default 120, max 3600).' }
			],
			headline: 'How RUN_TICKETS Executes a Shell Script',
			steps: [
				{ step: '1. Confirm', detail: 'A script written or changed by AI needs a person\'s confirmation (the card shows the full script, folder and shell). Unconfirmed scripts fail with "Shell script needs confirmation".' },
				{ step: '2. Resolve', detail: 'Ticket settings win over the template. Each {variable} in the script becomes "${ANYAGENT_VAR_name}" and its value is passed in the environment, so values can never become shell code.' },
				{ step: '3. Run', detail: '<shell> -c <script> runs in the working directory without input or terminal; after the timeout (or Stop) the whole process group is killed.' },
				{ step: '4. Publish', detail: '{var} / {Label} = stdout (stderr on failure); {var.ok}, .exitCode, .stdout, .stderr, .command, .cwd, .durationMs (also under the label: {Label.ok}, ...). A non-zero exit fails the step; it is never retried automatically.' }
			],
			variableResolution: '{output_var} or {Field Label} for the output text, {output_var.exitCode} / {Field Label.stderr} ... for the fields.',
			downstreamPassing: 'Later steps read {Field Label} and its fields; Python gets TICKET_CONTEXT["Field Label"] (text) and TICKET_CONTEXT["field_label_result"] (dict).',
			syntaxExamples: ['ls -la {folder}', 'echo "Hello {name}" > out.txt', '{Build Project.exitCode}', 'TICKET_CONTEXT["build_project_result"]["stdout"]'],
			tips: [
				'Commands that ask for input (passwords, y/n) fail: there is no terminal. Use non-interactive flags (e.g. -y).',
				'For remote servers use the SSH component; for git use the Git component.'
			]
		},
		templatePalette: { defaultName: 'Shell' },
		nodePalette: { label: 'Shell', accent: '#f59e0b', icon: Codicon.terminal, tooltip: 'Run a local zsh / bash / sh script and publish its output (exit code, stdout, stderr).' }
	},

	python: {
		type: 'python',
		displayName: 'Python (Code Automation)',
		icon: Codicon.code,
		category: 'processing',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Runs a local Python script and publishes its return value.',
		description: 'Runs a local Python script. Read upstream values from TICKET_CONTEXT (dict) or directly as globals; return the result by assigning OUTPUT = ... (or calling set_output(value)). Built-ins available: CREATE_TICKETS, RUN_TICKETS, GET_TICKET, GET_TICKETS, GET_OUTPUTS, DISPLAY. Output is exposed downstream as the component variable plus <var>_output / <var>_logs.',
		runtime: 'Interpolates {variables}, runs pythonCode with pythonPath (default: system python3) with TICKET_CONTEXT injected, captures stdout / stderr, exit code and the return value (OUTPUT, set_output(...) or RESULT). A non-zero exit fails the step.',
		props: [
			{ name: 'pythonCode', kind: 'string', required: true, ticketValue: true, description: 'Script. Read TICKET_CONTEXT, assign OUTPUT.' },
			{ name: 'pythonPath', kind: 'string', description: 'Interpreter path (e.g. .venv/bin/python). Default: system python3.' },
			{ name: 'pythonEnvMode', kind: 'string', enum: ['existing', 'create'], default: 'existing', description: 'Use an existing interpreter or create a venv.' },
			{ name: 'externalScripts', kind: 'stringArray', default: [], description: 'Extra script files to run.' },
			{ name: 'defaultContent', kind: 'string', role: 'state', description: 'Older place of the script; read when pythonCode is empty.' },
			{ name: 'pythonOutput', kind: 'string', role: 'state', description: 'Console output of the last run.' },
			{ name: 'pythonResult', kind: 'unknown', role: 'state', description: 'Return value of the last node run.' }
		],
		outputs: [
			{ name: '{var}', type: 'any', when: 'both', description: 'return value (OUTPUT / set_output / RESULT): dict, list, number, boolean or text', example: '{"status": "success"}' },
			{ name: '{Label}', type: 'any', when: 'both', description: 'same value under the label' },
			{ name: '{var}_output', type: 'any', when: 'ticket', description: 'return value' },
			{ name: '{var}_result', type: 'any', when: 'ticket', description: 'raw result captured from the script' },
			{ name: '{var}_logs', type: 'string', when: 'ticket', description: 'console output (stdout / stderr)' },
			{ name: '{var}_code', type: 'string', when: 'ticket', description: 'the script that ran' }
		],
		example: {
			id: 'python_1',
			label: 'Clean Dataset',
			type: 'python',
			pythonCode: 'import json\nrows = json.loads(TICKET_CONTEXT.get("raw_rows", "[]"))\nOUTPUT = [r for r in rows if r.get("text")]\n'
		},
		notes: ['Upstream JSON / Markdown code blocks are parsed into Python objects inside TICKET_CONTEXT.'],
		help: {
			badge: 'Execution & Automation',
			summary: 'Executes Python automation scripts within tickets using a specified local interpreter or virtual environment. Supports data transformation, API calls, file processing, and runtime context access.',
			designerConfig: [
				{ name: 'Field Label / Name', desc: 'Display title for the Python automation step.' },
				{ name: 'Python Interpreter / Virtualenv', desc: 'Specify path to Python binary (e.g. .venv/bin/python, /usr/bin/python3, or python3).' },
				{ name: 'Default Script Template', desc: 'Initial code template preloaded into new tickets of this type.' }
			],
			headline: 'How RUN_TICKETS Executes Python Primitive',
			steps: [
				{ step: '1. Interpreter Resolution', detail: 'Resolves specified Python binary or auto-detects active virtualenv (.venv/bin/python) / system python3.' },
				{ step: '2. Variable Interpolation & Context Injection', detail: 'Interpolates {{variables}} and automatically injects pre-parsed ticket variables into native TICKET_CONTEXT dictionary and ANY_AGENT_CONTEXT environment variable.' },
				{ step: '3. Script Execution & Return Value Capture', detail: 'Runs script synchronously with timeout protection, capturing stdout, stderr, exit code, runtime duration, and the explicit Return Value (OUTPUT = ..., set_output(...), or RESULT).' },
				{ step: '4. Output Manifest & Return Value Decoupling', detail: 'Distinguishes between Console Logs (stdout/stderr) and the actual Return Value (OUTPUT). Downstream primitives and Output Manifests receive the clean returned value (dict, list, number, boolean, or string) without terminal log banners.' }
			],
			variableResolution: 'TICKET_CONTEXT[\'Field Label\'] or {Field Label}',
			downstreamPassing: 'The Return Value (OUTPUT) is passed directly to Output Manifests and downstream primitives as structured data (dict, list, or text).',
			syntaxExamples: [
				'# Directly access upstream data via TICKET_CONTEXT (auto-parsed from JSON / Markdown)\njob_data = TICKET_CONTEXT.get("Linkedin Job Info Summary", {})\n\n# Define clean return value consumed by Output Manifest:\nOUTPUT = {"status": "success", "processed_jobs": len(job_data)}',
				'set_output({"total": 100, "items": [...]})',
				'TICKET_CONTEXT[\'Field Label\']'
			],
			tips: [
				'Assign to OUTPUT (e.g. OUTPUT = my_result) or call set_output(data) to define the clean return value for Output Manifest and downstream steps.',
				'Use the "+ OUTPUT =" chip below the script editor to insert the return value assignment at cursor.',
				'Console prints (print(...)) and stderr logs are recorded in Execution Logs & Preview for debugging, kept separate from the Return Value.',
				'Use the "Insert Context" chips below the script box to insert TICKET_CONTEXT[\'...\'] for any field with one click.',
				'Upstream outputs (like JSON or markdown code blocks from AI Prompts) are automatically parsed into Python dictionaries or lists inside TICKET_CONTEXT.',
				'Use the "Create venv" button in the ticket view to instantly initialize a local virtual environment for package dependencies.',
				'Any standard library or installed pip packages in your virtualenv are immediately available to your script.'
			]
		},
		templatePalette: { defaultName: 'Python Script' },
		nodePalette: { label: 'Python Card', accent: '#38bdf8', icon: Codicon.python, tooltip: 'Full Python Script component card in side editor. Supports TICKET_CONTEXT, interpreter selection, test runner, and OUTPUT.' }
	},

	http_request: {
		type: 'http_request',
		displayName: 'HTTP Request (API / REST Client)',
		icon: Codicon.cloudUpload,
		category: 'processing',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Calls an HTTP / REST API and publishes the parsed response.',
		description: 'Universal HTTP / REST API client: GET, POST, PUT, PATCH, DELETE, HEAD and OPTIONS with {variable} URL, query parameters (httpParams), headers (httpHeaders), auth (httpAuthType none | bearer | api_key | basic | custom), request body (httpBodyType none | json | raw | x-www-form-urlencoded with httpBodyContent) and timeout (httpTimeoutMs, default 30000). A JSON response is parsed, so later steps read {var.field}. Secrets (httpAuthToken, httpApiKeyValue, httpAuthPassword) must be variable references such as {API_TOKEN}.',
		runtime: 'Interpolates {variables} in URL, params, headers, auth and body, sends the request (no body for GET / HEAD), parses a JSON response, and registers the parsed data plus <Label>_status / <Label>_ok in context. Request settings saved on the ticket win over the template.',
		props: [
			{ name: 'httpUrl', kind: 'string', required: true, ticketValue: true, description: 'Endpoint URL. Supports {var}.' },
			{ name: 'httpMethod', kind: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'], default: 'GET', ticketValue: true, description: 'HTTP method (unknown values fall back to GET).' },
			{ name: 'httpParams', kind: 'objectArray', default: [], ticketValue: true, description: 'Query parameters [{key, value, enabled}].' },
			{ name: 'httpHeaders', kind: 'objectArray', ticketValue: true, description: 'Headers [{key, value, enabled}]. New components start with Accept: application/json.' },
			{ name: 'httpAuthType', kind: 'string', enum: ['none', 'bearer', 'api_key', 'basic', 'custom'], default: 'none', ticketValue: true, description: 'Authentication.' },
			{ name: 'httpAuthToken', kind: 'string', secret: true, ticketValue: true, description: 'Bearer / custom token.' },
			{ name: 'httpApiKeyName', kind: 'string', ticketValue: true, description: 'API key header / query name.' },
			{ name: 'httpApiKeyValue', kind: 'string', secret: true, ticketValue: true, description: 'API key value.' },
			{ name: 'httpApiKeyLocation', kind: 'string', enum: ['header', 'query'], default: 'header', ticketValue: true, description: 'Where the API key goes.' },
			{ name: 'httpAuthUsername', kind: 'string', ticketValue: true, description: 'Basic auth user.' },
			{ name: 'httpAuthPassword', kind: 'string', secret: true, ticketValue: true, description: 'Basic auth password.' },
			{ name: 'httpBodyType', kind: 'string', enum: ['none', 'json', 'raw', 'x-www-form-urlencoded'], default: 'none', ticketValue: true, description: 'Body encoding.' },
			{ name: 'httpBodyContent', kind: 'string', acceptsJson: true, default: '', ticketValue: true, description: 'Body text; supports {var}.' },
			{ name: 'httpTimeoutMs', kind: 'number', default: 30000, ticketValue: true, description: 'Timeout in ms.' },
			{ name: 'defaultContent', kind: 'string', role: 'state', description: 'Text of the last response, written by a run.' },
			{ name: 'httpResponseStatus', kind: 'number', role: 'state', ticketValue: true, description: 'Last response status.' },
			{ name: 'httpResponseStatusText', kind: 'string', role: 'state', ticketValue: true, description: 'Last response status text.' },
			{ name: 'httpResponseHeaders', kind: 'object', role: 'state', ticketValue: true, description: 'Last response headers.' },
			{ name: 'httpResponseBody', kind: 'string', role: 'state', ticketValue: true, description: 'Last response body text.' },
			{ name: 'httpResponseData', kind: 'unknown', role: 'state', ticketValue: true, description: 'Last parsed response.' },
			{ name: 'httpLastExecutionTime', kind: 'string', role: 'state', ticketValue: true, description: 'Time of the last request.' },
			{ name: 'httpLastDurationMs', kind: 'number', role: 'state', ticketValue: true, description: 'Duration of the last request.' }
		],
		outputs: [
			{ name: '{var}', type: 'object | string', when: 'both', description: 'parsed response data (JSON) or response text; never the transport envelope', example: '{"id": 7, "name": "x"}' },
			{ name: '{Label}', type: 'object | string', when: 'both', description: 'same value under the label' },
			{ name: '{var}_status', type: 'number', when: 'both', description: 'HTTP status code', example: '200' },
			{ name: '{var}_ok', type: 'boolean', when: 'both', description: 'true for a 2xx status', example: 'true' },
			{ name: '{var}_data', type: 'object | string', when: 'both', description: 'parsed response data (only when not null)' },
			{ name: '{var}_body', type: 'string', when: 'both', description: 'response body' },
			{ name: '{var}_raw', type: 'string', when: 'both', description: 'raw response text' }
		],
		example: {
			id: 'api_request_1',
			label: 'Create Item',
			type: 'http_request',
			httpUrl: 'https://api.example.com/v1/items',
			httpMethod: 'POST',
			httpAuthType: 'bearer',
			httpAuthToken: '{API_TOKEN}',
			httpHeaders: [
				{ key: 'Content-Type', value: 'application/json; charset=utf-8', enabled: true },
				{ key: 'Accept', value: 'application/json', enabled: true }
			],
			httpParams: [],
			httpBodyType: 'json',
			httpBodyContent: '{\n  "name": "{item_name}",\n  "status": "published",\n  "payload": {ai_result_json}\n}'
		},
		notes: ['Secrets are stored in the component config; the AI must only write {VAR} references (CI-34).'],
		help: {
			badge: 'Web API & Data Integration',
			summary: 'Universal HTTP / REST API communication component supporting GET, POST, PUT, PATCH, DELETE, HEAD, and OPTIONS. Configures dynamic URL, query parameters, request headers, Bearer/API-Key/Basic authentication, request body, and rich structured JSON output passed cleanly to downstream nodes.',
			designerConfig: [
				{ name: 'Method & Endpoint URL', desc: 'Select HTTP method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS) and declare URL supporting {variable} interpolation.' },
				{ name: 'Query Parameters & Headers', desc: 'Add key-value pairs with toggle checkboxes; automatically interpolated from upstream variables.' },
				{ name: 'Authentication', desc: 'Bearer Token, API Key (Header or Query), Basic Auth, or Custom Header with variable binding.' },
				{ name: 'Request Body', desc: 'JSON, raw, or x-www-form-urlencoded payload supporting variable placeholders (e.g. {ai_generated_resume}).' }
			],
			headline: 'How RUN_TICKETS & Workflow Execute HTTP Request Primitive',
			steps: [
				{ step: '1. Dynamic Interpolation', detail: 'Interpolates variables across URL, query parameters, headers, auth token, and request body.' },
				{ step: '2. HTTP Dispatch', detail: 'Sends HTTP request via native fetch with configurable timeout and abort protection.' },
				{ step: '3. Response Parsing', detail: 'Captures status code, status text, response headers, and auto-parses response body into structured JSON if valid.' },
				{ step: '4. Downstream Output Registration', detail: 'Registers the parsed response under the component variable, plus {FieldLabel_status} and {FieldLabel_ok}.' }
			],
			variableResolution: '{Field Label}, {Field Label.data.property}, {Field Label_status}, {Field Label_ok}',
			downstreamPassing: 'Subsequent AI Prompts, Python scripts (TICKET_CONTEXT), and Output Manifests receive full parsed JSON or response text.',
			syntaxExamples: [
				'{Upload Resume.data.share_path}',
				'{Get Resume.resume_data.hero.headline}',
				'{API Request_status}',
				'TICKET_CONTEXT[\'Upload Resume\'][\'data\'][\'share_path\']'
			],
			tips: [
				'Use {param_name} or {{param_name}} inside the URL, headers, or body to dynamically bind upstream ticket inputs or AI outputs.',
				'Click "Test API" in the component card to send an immediate live request and preview status, latency, headers, and parsed response JSON.',
				'JSON responses automatically expose their fields to downstream nodes using dot notation (e.g. {API Request.data.share_path}).'
			]
		},
		templatePalette: { defaultName: 'API Request' },
		nodePalette: { label: 'HTTP Request', accent: '#06b6d4', tooltip: 'Universal HTTP / REST API client. Supports GET, POST, PUT, PATCH, DELETE, Bearer/API-Key auth, params, headers, body, and structured JSON output.' }
	},

	table: {
		type: 'table',
		displayName: 'Data Table (SQLite / Grid)',
		icon: Codicon.table,
		category: 'data',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'A typed table of rows, optionally stored in a SQLite database.',
		description: 'Structured database table primitive with typed columns (TEXT, INTEGER, REAL, NUMERIC, BOOLEAN, DATE, DATETIME, JSON, VARCHAR(255), BLOB), manual/clipboard data entry, AI data manipulation (anyagent_operate_ticket_table), and direct SQLite database storage/sync (tableDbPath / tableDbTableName). tableSqlQuery runs a query at run time.',
		runtime: 'Resolves typed columns and rows (or loads them from the bound SQLite file), optionally runs tableSqlQuery, and exposes the rows to downstream steps (prompts get a Markdown table).',
		props: [
			{ name: 'tableColumns', kind: 'objectArray', role: 'structured', required: true, description: 'Columns [{name*, dataType = TEXT, primaryKey = false, nullable = true}].' },
			{ name: 'tableRows', kind: 'objectArray', role: 'structured', default: [], ticketValue: true, description: 'Rows (objects keyed by column name).' },
			{ name: 'tableDbPath', kind: 'string', role: 'structured', description: 'SQLite file (.db / .sqlite).' },
			{ name: 'tableDbTableName', kind: 'string', role: 'structured', description: 'SQLite table name. Default: from the component id.' },
			{ name: 'tableSqlQuery', kind: 'string', description: 'SQL query run at run time.' },
			{ name: 'tableDbEngine', kind: 'string', role: 'editor', enum: ['sqlite'], default: 'sqlite', description: 'Database engine.' },
			{ name: 'tableAutoSyncDb', kind: 'boolean', role: 'editor', default: false, description: 'Write rows to SQLite automatically.' },
			{ name: 'tablePageSize', kind: 'number', role: 'editor', default: 10, description: 'Rows per page on the card.' },
			{ name: 'debugSqlOutput', kind: 'string', role: 'state', description: 'Summary of the last SQL run.' }
		],
		outputs: [
			{ name: '{var}', type: 'object[] | string', when: 'both', description: 'rows (array of objects keyed by column name); the SQL output text when there are no rows', example: '[{"job_id": 1, "title": "Engineer"}]' },
			{ name: '{Label}', type: 'object', when: 'both', description: 'table payload {columns, rows, dbPath, tableName, sqlOutput, output, ...}' },
			{ name: '{var.rows}', type: 'object[]', when: 'both', description: 'rows' },
			{ name: '{var.json}', type: 'string', when: 'both', description: 'rows as JSON text' },
			{ name: '{var.output}', type: 'string | object[]', when: 'both', description: 'SQL output text, else the rows' },
			{ name: '{var.sqlOutput}', type: 'string', when: 'both', description: 'SQL output text' },
			{ name: '{var.table}', type: 'string', when: 'ticket', description: 'rows as a Markdown table' },
			{ name: '{var.columns}', type: 'object[]', when: 'ticket', description: 'column definitions' },
			{ name: '{var.dbPath}', type: 'string', when: 'ticket', description: 'bound SQLite file' },
			{ name: '{var.tableName}', type: 'string', when: 'ticket', description: 'bound SQLite table' },
			{ name: '{var}_rows / _output / _payload', type: 'object[] / string / object', when: 'both', description: 'rows / SQL output text / payload under the cleaned label' },
			{ name: '{var}_columns / _db_path / _table_name', type: 'object[] / string / string', when: 'ticket', description: 'columns / SQLite file / table under the cleaned label' }
		],
		example: {
			id: 'job_listings_table',
			label: 'Job Listings Table',
			type: 'table',
			tableDbTableName: 'job_listings',
			tableColumns: [
				{ id: 'col_1', name: 'job_id', dataType: 'INTEGER', primaryKey: true },
				{ id: 'col_2', name: 'title', dataType: 'TEXT' },
				{ id: 'col_3', name: 'company', dataType: 'TEXT' },
				{ id: 'col_4', name: 'created_at', dataType: 'DATETIME' }
			],
			tableRows: []
		},
		notes: ['Rows at run time are edited with the anyagent_operate_ticket_table tool (13 operations).'],
		help: {
			badge: 'Database & Structured Data Grid',
			summary: 'Defines a typed database table with customizable column headers, SQLite / SQL data types (TEXT, INTEGER, REAL, NUMERIC, BOOLEAN, DATE, DATETIME, JSON, VARCHAR(255), BLOB), manual and clipboard data entry, AI CRUD tool operations, and direct SQLite database persistence.',
			designerConfig: [
				{ name: 'Column Headers & Data Types', desc: 'Specify each column name, select its SQLite / SQL data type via dropdown, and optionally mark a Primary Key.' },
				{ name: 'Interactive Data Grid & Paste', desc: 'Manually type rows or paste CSV, TSV (Excel/Sheets), Markdown tables, or JSON arrays directly into the grid.' },
				{ name: 'SQLite Database Storage', desc: 'Create a new SQLite (.db) file or select an existing one to store, update (upsert), load, or delete the table data.' }
			],
			headline: 'How RUN_TICKETS & AI Operate Data Table',
			steps: [
				{ step: '1. Schema & Row Resolution', detail: 'Loads defined tableColumns and tableRows from the ticket metadata or linked SQLite database.' },
				{ step: '2. AI & Script Manipulation', detail: 'AI agents can read, insert, update, delete rows, or run SQL queries via anyagent_operate_ticket_table.' },
				{ step: '3. SQLite Database Sync', detail: 'Automatically creates the SQLite table (CREATE TABLE IF NOT EXISTS) and persists/updates or deletes records in the bound .db file.' }
			],
			variableResolution: '{Field Label}, {Field Label.json}, {Field Label.dbPath}, {Field Label.tableName}',
			downstreamPassing: 'Downstream AI Prompts receive a formatted Markdown table, and Python scripts can access rows and dbPath via TICKET_CONTEXT.',
			syntaxExamples: ['{Job Listings Table}', '{Job Listings Table.json}', 'TICKET_CONTEXT[\'Job Listings Table\']'],
			tips: [
				'Mark a unique identifier column (such as id or job_id) as Primary Key (PK) so "Update in SQLite" performs clean upserts.',
				'Press Cmd+V / Ctrl+V directly inside the table or click "Paste Data" to bulk-import rows from spreadsheets or Markdown.'
			]
		},
		templatePalette: { defaultName: 'Data Table' },
		nodePalette: { label: 'Data Table', accent: '#fb923c', tooltip: 'SQLite Data Table & SQL query component. Stores query rows in Component Title variable.' }
	},

	output: {
		type: 'output',
		displayName: 'Output',
		icon: Codicon.output,
		category: 'output',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Defines the result dictionary of a ticket, node or workflow.',
		description: 'Defines the RESULT of a ticket, node, or workflow as a dictionary {label: value}. Each output item (outputSpecs) takes its value from a variable / expression (sourceExpression, e.g. {summary}, True, or "Done: {count} rows") or exports another component (fieldKey). Where the result goes: (1) in a ticket, RUN_TICKETS(...).output and GET_OUTPUTS(ticket) return it; (2) in a workflow, the Output component on the final node (the one right before End) becomes the WORKFLOW OUTPUTS, returned to the caller or to the parent workflow when used as a sub-workflow (one item -> the raw value, several -> a dict). Every ticket template and every workflow should end with an Output; include a success / status flag so callers can tell whether the run succeeded.',
		runtime: 'Evaluates each enabled output item (sourceExpression or exported component), stores the dictionary on the ticket, and returns it as the run result. A reference to an undefined variable fails the run. On the final node of a workflow it becomes WORKFLOW_OUTPUTS.',
		props: [
			{ name: 'outputSpecs', kind: 'objectArray', role: 'structured', required: true, description: 'Items [{label*, sourceExpression | fieldKey, varName?, defaultFormat = text|table, enabled = true}].' },
			{ name: 'defaultFormat', kind: 'string', role: 'editor', enum: ['text', 'markdown', 'json', 'table'], default: 'text', description: 'Display format of a single-result Output card.' }
		],
		outputs: [
			{ name: 'result dictionary', type: 'object', when: 'both', description: '{label: value}; returned by RUN_TICKETS(...).output and GET_OUTPUTS(ticket); on the final workflow node it becomes WORKFLOW_OUTPUTS', example: '{"success": true, "summary": "..."}' },
			{ name: '{label}', type: 'any', when: 'both', description: 'each item, also under its varName' },
			{ name: '{Label}', type: 'object', when: 'both', description: 'the result dictionary under the component label' },
			{ name: 'output', type: 'object', when: 'ticket', description: 'the result dictionary (ticket runs)' },
			{ name: 'OUTPUT', type: 'object', when: 'node', description: 'the result dictionary (node runs)' }
		],
		example: {
			id: 'pipeline_output',
			label: 'Output',
			type: 'output',
			outputSpecs: [
				{ label: 'success', sourceExpression: 'True' },
				{ label: 'summary', sourceExpression: '{ai_summary}' },
				{ label: 'row_count', sourceExpression: '{row_count}' }
			]
		},
		notes: ['Multiple Output components in the final node are accumulated in order as Workflow Outputs.', 'Old data may use the legacy type id "result"; it is migrated to "output" on load.'],
		help: {
			badge: 'Result & Downstream Export',
			summary: 'Defines the RESULT of a ticket, node, or workflow: a dictionary of named items. Whoever runs it (a person, another ticket, a parent workflow, or the AI) reads this result. Every template and every workflow should end with an Output, ideally including a success / status flag.',
			designerConfig: [
				{ name: 'Output Items', desc: 'Each item has a name (label) and a source: a variable or expression such as {summary}, True, or "Done: {count} rows", or another component of this ticket whose value is exported.' },
				{ name: 'Display Format', desc: 'Table, Markdown, JSON, or Text, applied to exported component values.' },
				{ name: 'Enable / Disable', desc: 'Toggle individual items on or off without deleting them.' }
			],
			headline: 'How the Output Is Produced and Used',
			steps: [
				{ step: '1. Evaluate items', detail: 'Each enabled item is evaluated in order. A reference to an undefined variable is an error (the run fails) rather than a silent empty value.' },
				{ step: '2. Store on the ticket', detail: 'The result dictionary is saved with the ticket and shown in its Output card.' },
				{ step: '3. Return to the caller', detail: 'RUN_TICKETS(...).output and GET_OUTPUTS(ticket) return the dictionary; GET_OUTPUTS(ticket, field="name") returns one item.' },
				{ step: '4. Workflow outputs', detail: 'The Output on the final node of a workflow (the node right before End) becomes the WORKFLOW OUTPUTS. When the workflow runs as a sub-workflow, the parent receives the raw value if there is one item, or a dictionary if there are several.' }
			],
			variableResolution: 'Each item is also available to later steps as {label} and as its Python variable name.',
			downstreamPassing: 'This is the payload handed to the next ticket, node, or parent workflow.',
			syntaxExamples: ['GET_OUTPUTS(ticket)', 'GET_OUTPUTS(ticket, field="summary")', 'res = RUN_TICKETS(ticket=t); res["output"]["success"]'],
			tips: [
				'Add a "success" item (e.g. sourceExpression True, or an expression that checks the result) so callers can branch on it.',
				'Use [Sync Primitives] in the card configuration to auto-detect and populate all canvas primitives.'
			]
		},
		templatePalette: { defaultName: 'Output' },
		nodePalette: { label: 'Output', accent: '#34d399', tooltip: 'Node Output component. Multiple Output components in the final node are accumulated in order as Workflow Outputs.' }
	},

	create_tickets: {
		type: 'create_tickets',
		displayName: 'Create Tickets (CREATE_TICKETS)',
		icon: Codicon.newFile,
		category: 'processing',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Creates a new ticket from a template and returns its handle.',
		description: 'Creates a new ticket from another template when this ticket runs. Settings: wfTicketType (template id, required), wfTicketTitle (supports {var}; default "New Ticket"), wfTicketPath (folder, default "."), wfTicketParams {inputName: value or {var}} matching the template Inputs. Output: a ticket handle {success, ticketId, ticketName, ticketType, entityUri, targetFolder, fields} usable by Run Tickets / Get Outputs as {var}. In workflow nodes it compiles to Python: v = CREATE_TICKETS(ticket_type=..., title=..., path=..., params={...}). Freestyle tickets cannot be created here. wfTicketType "sub_workflow" creates a reusable sub-workflow ticket: wfTicketPath must be the parent workflow folder (or inside it) and wfTicketParams.definition may hold {name, nodes, links, inputs, outputs} (validated; omitted = empty sub-workflow).',
		runtime: 'Creates the ticket folder and files from the template, filling the given Inputs, and stores the ticket handle in the output variable. Freestyle tickets cannot be created this way. wfTicketType "sub_workflow" creates a reusable sub-workflow ticket: wfTicketPath must be the parent workflow folder (or a folder inside it; "." when the workflow itself runs), and the optional wfTicketParams.definition {name, nodes, links, inputs, outputs} (object or JSON) is validated; without it the sub-workflow is empty (no nodes).',
		props: [
			{ name: 'wfTicketType', kind: 'string', required: true, description: 'Template id or name.' },
			{ name: 'wfTicketTitle', kind: 'string', default: 'New Ticket', description: 'Title; supports {var}.' },
			{ name: 'wfTicketPath', kind: 'string', default: '.', description: 'Folder to create the ticket in.' },
			{ name: 'wfTicketParams', kind: 'object', description: 'Template Inputs {name: value or {var}}.' }
		],
		outputs: [
			{ name: '{var}', type: 'object', when: 'both', description: 'ticket handle {success, ticketId, ticketName, ticketType, entityUri, targetFolder, fields}' },
			{ name: '{Label}', type: 'object', when: 'both', description: 'same handle under the label' }
		],
		example: { id: 'new_run', label: 'New Run', type: 'create_tickets', wfTicketType: 'training_run', wfTicketTitle: 'Run {run_no}', wfTicketParams: { lr: '{lr}' } },
		notes: [
			'Freestyle tickets cannot be created programmatically.',
			'sub_workflow: create it inside a workflow folder (wfTicketPath); wfTicketParams.definition = {name, nodes, links, inputs, outputs}; node ids must be unique and links must connect given nodes.'
		],
		help: builtinHelp('Create Tickets',
			'Creates a new ticket from a ticket template (type), for example one record per training run.',
			[
				{ name: 'Ticket Type', desc: 'Required. The template to create from.' },
				{ name: 'Title', desc: 'Ticket title; supports {variables}. Default "New Ticket".' },
				{ name: 'Path', desc: 'Folder to create it in. Default "." (the current workspace / folder).' },
				{ name: 'Inputs', desc: 'Values for the template Inputs; each can be a fixed value or a {variable}.' }
			],
			[
				{ step: '1. Create', detail: 'Creates the ticket folder and files from the template, filling the Inputs you gave.' },
				{ step: '2. Return a handle', detail: 'Returns a ticket handle (ticketId, entityUri, fields) stored in the output variable.' }
			],
			'Pass the handle to Run Tickets or Get Outputs as {variable}.',
			['new_ticket = CREATE_TICKETS(ticket_type="training_run", title="Run {run_no}", params={"lr": "{lr}"})'],
			['Create the ticket first, then run it with Run Tickets.', 'To create a reusable sub-workflow: CREATE_TICKETS(ticket_type="sub_workflow", path=<parent workflow folder>, params={"definition": {...}}).']),
		templatePalette: { defaultName: 'created_ticket' },
		nodePalette: { label: 'Create Tickets', accent: '#c084fc', icon: Codicon.add, tooltip: 'CREATE_TICKETS built-in component. Automatically loads target Ticket Type Inputs schema; stores ticket handle in Component Title.' }
	},

	run_tickets: {
		type: 'run_tickets',
		displayName: 'Run Tickets (RUN_TICKETS)',
		icon: Codicon.playCircle,
		category: 'processing',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Runs all components of another ticket and returns its result.',
		description: 'Runs another ticket. Settings: wfTicketTarget (ticket id or {var} handle from Create Tickets, required), wfTicketParams {inputName: value} to override the ticket Inputs. Output: {success, ticketId, status: "success" | "failed", output (the ticket Output dictionary), error, durationMs}.',
		runtime: 'Executes the target ticket components top to bottom with the given Inputs and stores {success, status, output, error} in the output variable.',
		props: [
			{ name: 'wfTicketTarget', kind: 'string', required: true, description: 'Ticket id, or {var} holding a handle.' },
			{ name: 'wfTicketParams', kind: 'object', description: 'Inputs overrides {name: value}.' }
		],
		outputs: [
			{ name: '{var}', type: 'object', when: 'both', description: 'run result {success, ticketId, status: "success" | "failed", output, error, durationMs}', example: '{"status": "success", "output": {"success": true}}' },
			{ name: '{Label}', type: 'object', when: 'both', description: 'same result under the label' }
		],
		example: { id: 'run_it', label: 'Run It', type: 'run_tickets', wfTicketTarget: '{new_run}' },
		notes: [],
		help: builtinHelp('Run Tickets',
			'Runs all components of an existing ticket and returns its result.',
			[
				{ name: 'Ticket', desc: 'Required. A ticket id, or a {variable} holding a handle from Create Tickets.' },
				{ name: 'Inputs', desc: 'Optional values that override the ticket Inputs for this run.' }
			],
			[
				{ step: '1. Run', detail: 'Executes the ticket components top to bottom with the given Inputs.' },
				{ step: '2. Return the result', detail: 'Returns success, status ("success" / "failed"), output (the ticket Output dictionary), and error.' }
			],
			'Read the ticket result from {output_variable}.output, or branch on .status.',
			['res = RUN_TICKETS(ticket=new_ticket)', 'res["output"]["success"]'],
			['Give the ticket template an Output component so the run returns a useful result.']),
		templatePalette: { defaultName: 'run_res' },
		nodePalette: { label: 'Run Tickets', accent: '#a855f7', tooltip: 'RUN_TICKETS built-in component. Automatically loads target Ticket Type Inputs schema; stores run result in Component Title.' }
	},

	get_outputs: {
		type: 'get_outputs',
		displayName: 'Get Outputs (GET_OUTPUTS)',
		icon: Codicon.signOut,
		category: 'data',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Reads the Output dictionary of a ticket that has already run.',
		description: 'Reads another ticket\'s Output dictionary. Settings: wfTicketTarget (ticket id or {var} handle, required), wfTicketField (optional item name). Returns the whole dictionary, one item, or null when the ticket template has no Output component.',
		runtime: 'Returns the stored Output dictionary, one item of it, or null when the template has no Output component.',
		props: [
			{ name: 'wfTicketTarget', kind: 'string', required: true, description: 'Ticket id or {var} handle.' },
			{ name: 'wfTicketField', kind: 'string', description: 'One output item; empty = the whole dictionary.' }
		],
		outputs: [
			{ name: '{var}', type: 'object | any | null', when: 'both', description: 'Output dictionary, one item, or null when the template has no Output component' },
			{ name: '{Label}', type: 'object | any | null', when: 'both', description: 'same value under the label' }
		],
		example: { id: 'run_result', label: 'Run Result', type: 'get_outputs', wfTicketTarget: '{new_run}', wfTicketField: 'accuracy' },
		notes: [],
		help: builtinHelp('Get Outputs',
			'Reads the Output (result dictionary) of a ticket that has already run.',
			[
				{ name: 'Ticket', desc: 'Required. Ticket id or {variable} handle.' },
				{ name: 'Field', desc: 'Optional. Name of one output item; leave empty for the whole dictionary.' }
			],
			[{ step: '1. Read', detail: 'Returns the stored Output dictionary, one item of it, or nothing if the template has no Output component.' }],
			'Use the value directly in later steps.',
			['GET_OUTPUTS(ticket=new_ticket)', 'GET_OUTPUTS(ticket="TRAIN-0003", field="accuracy")'],
			['Run the ticket first; Get Outputs only reads what is already stored.']),
		templatePalette: { defaultName: 'ticket_output' },
		nodePalette: { label: 'Get Outputs', accent: '#818cf8', tooltip: 'GET_OUTPUTS built-in component. Reads OUTPUT dictionary from target ticket into Component Title variable.' }
	},

	get_ticket: {
		type: 'get_ticket',
		displayName: 'Get Ticket (GET_TICKET)',
		icon: Codicon.search,
		category: 'data',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Reads one ticket (or one of its fields).',
		description: 'Reads ONE ticket: its fields, status, and outputs. Settings: wfTicketTarget (ticket id, name, path, or {var} handle, required), wfTicketField (optional: return just this field). Returns the ticket object or the field value. For a sub_workflow ticket the result has subWorkflow: its full calling contract (inputs with defaults, outputs, source workflow).',
		runtime: 'Resolves the ticket by id / name / path / handle and returns the ticket object, or only wfTicketField when given. For a sub_workflow ticket the result also has subWorkflow: the full calling contract {ticketId, name, sourceWorkflowName, inputs [{name, label, defaultValue}], outputs [{name, label, format}], usage}.',
		props: [
			{ name: 'wfTicketTarget', kind: 'string', required: true, description: 'Ticket id, name, path, or {var} handle.' },
			{ name: 'wfTicketField', kind: 'string', description: 'Return only this field.' },
			{ name: 'wfTicketId', kind: 'string', role: 'editor', description: 'Older form of the target (ticket id); read when wfTicketTarget is empty.' },
			{ name: 'wfTicketVariable', kind: 'string', role: 'editor', description: 'Older form of the target (handle variable); read when wfTicketTarget is empty.' }
		],
		outputs: [
			{ name: '{var}', type: 'object | any', when: 'both', description: 'ticket object (with subWorkflow, the calling contract, for a sub_workflow ticket), or the value of wfTicketField' },
			{ name: '{Label}', type: 'object | any', when: 'both', description: 'same value under the label' }
		],
		example: { id: 'parent', label: 'Parent', type: 'get_ticket', wfTicketTarget: 'JOB-0001' },
		notes: ['For several tickets use Get Tickets.'],
		help: {
			badge: 'Workflow Built-in Primitives',
			summary: 'Queries and fetches a single specific ticket by Ticket ID or Ticket Variable reference. Supports optional direct field extraction (e.g. status, title, outputs) into the output variable.',
			designerConfig: [
				{ name: 'Ticket ID', desc: 'Direct ticket identifier (e.g. FINDJ-0002 or variable expression {job_id}).' },
				{ name: 'Ticket Variable', desc: 'Reference to an existing upstream ticket variable or handle (e.g. {created_ticket_1}).' },
				{ name: 'Field (Optional)', desc: 'Extracts a specific property value directly (e.g. status, title, custom field) instead of the entire ticket dictionary.' },
				{ name: 'Output Variable', desc: 'Python variable name where the returned ticket data or extracted field is stored.' }
			],
			headline: 'How get_ticket Executes',
			steps: [
				{ step: '1. Target Resolution', detail: 'Resolves the Ticket ID or variable handle in the current workspace or registered repositories.' },
				{ step: '2. Metadata & Outputs Ingestion', detail: 'Loads the ticket markdown, snapshot data, custom metadata, and output components.' },
				{ step: '3. Field Extraction & Return', detail: 'If Field is specified, extracts only that attribute; otherwise returns the complete Ticket object.' }
			],
			variableResolution: 'Stores result in the designated Output Variable and exports to contextVariables.',
			downstreamPassing: 'Downstream Python scripts or Prompt steps can directly read the output variable.',
			syntaxExamples: ['job_status = get_ticket(ticket_id="FINDJ-0002", field="status")', 'ticket_data = get_ticket(ticket=created_ticket)'],
			tips: [
				'You can provide either Ticket ID or Ticket Variable to identify which ticket to fetch.',
				'Leave Field blank if you need all metadata and outputs for downstream processing.'
			]
		}
	},

	get_tickets: {
		type: 'get_tickets',
		displayName: 'Get Tickets (GET_TICKETS)',
		icon: Codicon.search,
		category: 'data',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Searches several tickets at once (AND of filters).',
		description: 'Searches SEVERAL tickets at once (AND of all filters; give at least one), e.g. all "Done" tickets of a template, to loop over them. Settings: wfTicketType (template id), wfTicketStatus, wfTicketTitle (substring), wfTicketPath (folder), wfTicketField (return only this field per ticket). Output: a list of {ticketId, ticketName, ticketType, title, status, priority, entityUri, customMetadata}. To discover reusable sub-workflows use wfTicketType "sub_workflow" (each item has subWorkflow {name, inputs, outputs, sourceWorkflow}); call one from a workflow node with a Call Sub-Workflow step whose subWorkflowId is that ticket ID.',
		runtime: 'Filters all tickets by the given settings (exact type and status, title substring, folder) and returns the list (or one field per ticket). wfTicketType "sub_workflow" lists the reusable sub-workflows; each item then also has subWorkflow {name, inputs, outputs, sourceWorkflow} (a short summary).',
		props: [
			{ name: 'wfTicketType', kind: 'string', description: 'Template id (exact match).' },
			{ name: 'wfTicketStatus', kind: 'string', description: 'Status (exact match).' },
			{ name: 'wfTicketTitle', kind: 'string', description: 'Part of the title or folder name.' },
			{ name: 'wfTicketPath', kind: 'string', description: 'Only tickets inside this folder.' },
			{ name: 'wfTicketField', kind: 'string', description: 'Return only this field per ticket.' }
		],
		outputs: [
			{ name: '{var}', type: 'object[] | any[]', when: 'both', description: 'list of {ticketId, ticketName, ticketType, title, status, priority, entityUri, customMetadata} (plus subWorkflow {name, inputs, outputs, sourceWorkflow} for sub_workflow tickets), or one field value per ticket' },
			{ name: '{Label}', type: 'object[] | any[]', when: 'both', description: 'same list under the label' }
		],
		example: { id: 'done_runs', label: 'Done Runs', type: 'get_tickets', wfTicketType: 'training_run', wfTicketStatus: 'Done' },
		notes: ['Give at least one filter.'],
		help: builtinHelp('Get Tickets',
			'Searches several tickets at once, for example all "Done" tickets of a template, so a workflow can loop over them.',
			[
				{ name: 'Ticket Type', desc: 'Optional. Template id (exact match).' },
				{ name: 'Status', desc: 'Optional. Status (exact match).' },
				{ name: 'Title', desc: 'Optional. Part of the title or folder name.' },
				{ name: 'Path', desc: 'Optional. Only tickets inside this folder.' }
			],
			[{ step: '1. Search', detail: 'All filters are combined (AND). Give at least one.' }, { step: '2. Return a list', detail: 'Returns a list of tickets (id, title, status, type, fields).' }],
			'Loop over the list in a Python step.',
			['done = GET_TICKETS(ticket_type="training_run", status="Done")'],
			['For one known ticket use Get Ticket instead.']),
		nodePalette: { label: 'Get Tickets', accent: '#60a5fa', tooltip: 'GET_TICKETS built-in component. Queries workspace tickets by Type, Status, or Title into Component Title variable.' }
	},

	display: {
		type: 'display',
		displayName: 'Display (DISPLAY)',
		icon: Codicon.eye,
		category: 'output',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Shows a value in the Live Output panel while running.',
		description: 'Shows a value in the Live Output panel while running (debugging / progress); no variable is produced. Settings: wfDisplayValue (Python expression evaluated with all current variables, e.g. train_log[-5:], required).',
		runtime: 'Evaluates wfDisplayValue as a Python expression with the current variables and prints the result to Live Output.',
		props: [
			{ name: 'wfDisplayValue', kind: 'string', required: true, description: 'Python expression to show.' }
		],
		outputs: [],
		example: { id: 'show_progress', label: 'Show Progress', type: 'display', wfDisplayValue: 'row_count' },
		notes: ['Produces no variable.'],
		help: builtinHelp('Display',
			'Shows an intermediate value in the Live Output panel while a workflow runs, for debugging or progress. It does not create a variable.',
			[{ name: 'Value', desc: 'Required. A Python expression using the current variables, e.g. train_log[-5:].' }],
			[{ step: '1. Evaluate and show', detail: 'Evaluates the expression and prints the result to Live Output.' }],
			'Nothing is passed on; it is display only.',
			['DISPLAY(train_log[-5:])'],
			['Remove or disable Display steps you no longer need.']),
		templatePalette: { defaultName: 'Display' },
		nodePalette: { label: 'Display', accent: '#f472b6', tooltip: 'DISPLAY built-in component. Renders variable or value to Live Output panel.' }
	},

	text: {
		type: 'text',
		displayName: 'Single-line Input (Text)',
		icon: Codicon.symbolString,
		category: 'input',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Short text value.',
		description: 'Short strings, titles, codes, currency amounts as string, invoice numbers, person names.',
		runtime: PASS_THROUGH_RUNTIME,
		props: [{ name: 'defaultContent', kind: 'string', ticketValue: true, description: 'Initial text.' }],
		outputs: [
			{ name: '{var}', type: 'string', when: 'both', description: 'the text as stored' },
			{ name: '{Label}', type: 'string', when: 'both', description: 'same value under the label' }
		],
		example: { id: 'expense_title', label: 'Title / Subject', type: 'text' },
		notes: [VAR_NOTE],
		help: {
			badge: 'Standard Form Input',
			summary: 'Standard single-line text input for identifiers, titles, keywords, or short configuration strings.',
			designerConfig: [{ name: 'Default Value', desc: 'Initial text prepopulated in new tickets.' }],
			headline: 'How RUN_TICKETS Executes Text Field',
			steps: [
				{ step: '1. Value Extraction', detail: 'Reads value from input overrides or ticket metadata, else the default value.' },
				{ step: '2. Variable Registration', detail: 'Interpolates {variables} and registers the string as-is (not trimmed) into contextVariables[FieldLabel].' }
			],
			variableResolution: '{Field Label}',
			downstreamPassing: 'Available for URL interpolation, prompt placeholders, or workflow condition evaluation.',
			syntaxExamples: ['{Field Label}', '{{Field Label}}'],
			tips: ['Use clear, concise labels so other primitives can easily reference the field by name.']
		},
		templatePalette: { defaultName: 'Text Field' }
	},

	textarea: {
		type: 'textarea',
		displayName: 'Textarea (Multiline)',
		icon: Codicon.listFlat,
		category: 'input',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Long, multi-line text (Markdown allowed).',
		description: 'Long descriptions, justifications, remarks, multiline comments, reasoning.',
		runtime: PASS_THROUGH_RUNTIME,
		props: [{ name: 'defaultContent', kind: 'string', ticketValue: true, description: 'Initial text or Markdown template.' }],
		outputs: [
			{ name: '{var}', type: 'string', when: 'both', description: 'the text as stored' },
			{ name: '{Label}', type: 'string', when: 'both', description: 'same value under the label' }
		],
		example: { id: 'business_reason', label: 'Business Justification', type: 'textarea' },
		notes: [VAR_NOTE],
		help: {
			badge: 'Standard Form Input',
			summary: 'Multi-line text area supporting Markdown, logs, specifications, or free-form long inputs.',
			designerConfig: [{ name: 'Default Content', desc: 'Multiline text or Markdown template.' }],
			headline: 'How RUN_TICKETS Executes Textarea',
			steps: [
				{ step: '1. Multiline Retrieval', detail: 'Retrieves complete multiline string value.' },
				{ step: '2. Variable Context Insertion', detail: 'Inserts string verbatim into contextVariables.' }
			],
			variableResolution: '{Field Label}',
			downstreamPassing: 'Often fed into AI Prompt templates as background context or instruction bodies.',
			syntaxExamples: ['{Field Label}'],
			tips: ['Supports standard Markdown formatting for structured descriptions.']
		},
		templatePalette: { defaultName: 'Description' }
	},

	number: {
		type: 'number',
		displayName: 'Number Input (Numeric)',
		icon: Codicon.symbolNumber,
		category: 'input',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Numeric value with optional unit, precision and range.',
		description: 'Numeric quantities, amounts, measurements, percentages, or rates. Supports custom unit (e.g. $, kg, %, hours) and defaults to 2 decimal places; min / max are enforced and the value is rounded to precision when saved and when run.',
		runtime: 'Value = run input override, else the saved ticket value, else defaultContent; after {variable} interpolation it is rounded to precision and checked against min / max (a non-number or out-of-range value fails the step).',
		props: [
			{ name: 'defaultContent', kind: 'string', ticketValue: true, description: 'Initial value.' },
			{ name: 'unit', kind: 'string', role: 'structured', description: 'Unit shown next to the value (e.g. $, kg, %).' },
			{ name: 'precision', kind: 'number', role: 'structured', default: 2, description: 'Decimal places.' },
			{ name: 'min', kind: 'number', role: 'structured', description: 'Minimum.' },
			{ name: 'max', kind: 'number', role: 'structured', description: 'Maximum.' },
			{ name: 'step', kind: 'number', role: 'structured', description: 'Input step.' }
		],
		outputs: [
			{ name: '{var}', type: 'number | string', when: 'both', description: 'the number, rounded to precision (empty stays "")', example: '12.5' },
			{ name: '{Label}', type: 'number | string', when: 'both', description: 'same value under the label' }
		],
		example: { id: 'budget_amount', label: 'Budget Amount', type: 'number', unit: '$', precision: 2 },
		notes: [VAR_NOTE, 'Empty values and {variable} values are allowed when saving; they are checked after interpolation at run time.'],
		help: {
			badge: 'Numeric & Metrics',
			summary: 'Numeric input supporting integers and floating point values with boundary limits and step configurations.',
			designerConfig: [
				{ name: 'Default Number', desc: 'Initial numeric value.' },
				{ name: 'Unit & Precision', desc: 'Unit symbol and number of decimal places (default 2).' },
				{ name: 'Min / Max Bounds', desc: 'Optional boundary constraints.' }
			],
			headline: 'How RUN_TICKETS Executes Number Primitive',
			steps: [
				{ step: '1. Numeric Parsing', detail: 'Converts input string into standard numeric float/integer, rounded to the precision.' },
				{ step: '2. Bounds Validation', detail: 'Checks min and max thresholds; an invalid or out-of-range value fails the step.' },
				{ step: '3. Context Registration', detail: 'Stores parsed number into contextVariables for mathematical expressions.' }
			],
			variableResolution: '{Field Label}',
			downstreamPassing: 'Used by workflow condition branches (e.g. if amount > 1000) or prompt evaluation.',
			syntaxExamples: ['{Field Label}'],
			tips: ['Can be used in Python-like expressions within workflow condition routers.']
		},
		templatePalette: { defaultName: 'Amount' }
	},

	select: {
		type: 'select',
		displayName: 'Dropdown (Select)',
		icon: Codicon.chevronDown,
		category: 'input',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'One choice from a fixed list of options.',
		description: 'Single-choice dropdown menu. MUST supply options array of strings.',
		runtime: PASS_THROUGH_RUNTIME,
		props: [
			{ name: 'options', kind: 'stringArray', role: 'structured', required: true, description: 'Choices.' },
			{ name: 'defaultContent', kind: 'string', ticketValue: true, description: 'Initially selected option.' }
		],
		outputs: [
			{ name: '{var}', type: 'string', when: 'both', description: 'the selected option', example: '"Travel"' },
			{ name: '{Label}', type: 'string', when: 'both', description: 'same value under the label' }
		],
		example: { id: 'category', label: 'Expense Category', type: 'select', options: ['Travel', 'Meals & Entertainment', 'Office Supplies', 'Software Subscriptions', 'Other'] },
		notes: [VAR_NOTE, 'The run does not check that the value is one of the options.'],
		help: {
			badge: 'Choice & Selection',
			summary: 'Single-choice dropdown menu selecting from a predefined list of discrete options.',
			designerConfig: [
				{ name: 'Options List', desc: 'List of selectable option strings.' },
				{ name: 'Default Option', desc: 'Option selected by default.' }
			],
			headline: 'How RUN_TICKETS Executes Dropdown',
			steps: [
				{ step: '1. Read value', detail: 'Uses the run input override, else the selected option, else the default option. The value is not checked against the options list.' },
				{ step: '2. Context Assignment', detail: 'Stores selected string into contextVariables[FieldLabel].' }
			],
			variableResolution: '{Field Label}',
			downstreamPassing: 'Ideal for workflow routing (e.g. if priority == "High").',
			syntaxExamples: ['{Field Label}'],
			tips: ['Configure clear, mutually exclusive options for deterministic workflow decisions.']
		},
		templatePalette: { defaultName: 'Select Option', defaultChoices: ['Option 1', 'Option 2', 'Option 3'] }
	},

	multiselect: {
		type: 'multiselect',
		displayName: 'Checkboxes (Multiselect)',
		icon: Codicon.checklist,
		category: 'input',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Zero or more choices from a fixed list of options.',
		description: 'Multi-choice tags or checkboxes. MUST supply options array of strings. The value is stored as a JSON array of the checked options and passed on as stored.',
		runtime: PASS_THROUGH_RUNTIME,
		props: [
			{ name: 'options', kind: 'stringArray', role: 'structured', required: true, description: 'Choices.' },
			{ name: 'defaultContent', kind: 'string', acceptsJson: true, ticketValue: true, description: 'Initially checked options (JSON array).' }
		],
		outputs: [
			{ name: '{var}', type: 'string', when: 'both', description: 'checked options as stored (JSON array text)', example: '["Urgent"]' },
			{ name: '{Label}', type: 'string', when: 'both', description: 'same value under the label' }
		],
		example: { id: 'tags', label: 'Compliance Tags', type: 'multiselect', options: ['Urgent', 'Over-Budget', 'Client-Rebillable', 'Receipt-Verified'] },
		notes: [VAR_NOTE],
		help: {
			badge: 'Choice & Selection',
			summary: 'Multiple selection checkboxes allowing users to pick zero or more tags/options.',
			designerConfig: [{ name: 'Options List', desc: 'List of available tag options.' }],
			headline: 'How RUN_TICKETS Executes Multiselect',
			steps: [
				{ step: '1. Read value', detail: 'Reads the checked options as stored with the ticket (a JSON array).' },
				{ step: '2. Context Assignment', detail: 'Stores the value as-is into contextVariables[FieldLabel].' }
			],
			variableResolution: '{Field Label}',
			downstreamPassing: 'Useful for multi-tag categorization and filter matching.',
			syntaxExamples: ['{Field Label}'],
			tips: ['Parse the JSON array in Python (json.loads) when you need individual tags.']
		},
		templatePalette: { defaultName: 'Tags', defaultChoices: ['Tag A', 'Tag B', 'Tag C'] }
	},

	switch: {
		type: 'switch',
		displayName: 'Switch (Toggle)',
		icon: Codicon.circleFilled,
		category: 'input',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'A true / false flag.',
		description: 'Boolean flag toggle (true/false). The value is passed on as stored ("true" / "false").',
		runtime: PASS_THROUGH_RUNTIME,
		props: [{ name: 'defaultContent', kind: 'string', enum: ['true', 'false'], default: 'false', ticketValue: true, description: 'Initial state.' }],
		outputs: [
			{ name: '{var}', type: 'string', when: 'both', description: '"true" / "false" as stored', example: '"true"' },
			{ name: '{Label}', type: 'string', when: 'both', description: 'same value under the label' }
		],
		example: { id: 'requires_cfo_approval', label: 'Requires CFO Sign-off', type: 'switch' },
		notes: [VAR_NOTE],
		help: {
			badge: 'Control & State',
			summary: 'Boolean toggle switch representing true/false flags for feature gates or automation triggers.',
			designerConfig: [{ name: 'Default State', desc: 'Enabled (true) or Disabled (false).' }],
			headline: 'How RUN_TICKETS Executes Switch',
			steps: [
				{ step: '1. Read value', detail: 'Reads the stored state ("true" / "false"), else the default state.' },
				{ step: '2. Context Registration', detail: 'Registers the value as stored into contextVariables (it is not converted to a boolean).' }
			],
			variableResolution: '{Field Label}',
			downstreamPassing: 'Directly drives workflow conditional links (e.g. if is_urgent == "true").',
			syntaxExamples: ['{Field Label}'],
			tips: ['Combine with workflow condition branches to selectively skip or trigger expensive steps.']
		},
		templatePalette: { defaultName: 'Enabled Flag' }
	},

	date: {
		type: 'date', displayName: 'Single Date Picker', icon: Codicon.calendar, category: 'input', usableIn: ['ticket', 'node'], ai: 'exposed',
		purpose: 'A calendar date (YYYY-MM-DD).',
		description: 'Calendar date. Value is a string "YYYY-MM-DD" (e.g. "2026-11-25"); passed through unchanged at run time.',
		runtime: PASS_THROUGH_RUNTIME, props: DATE_PROPS, outputs: [
			{ name: '{var}', type: 'string', when: 'both', description: 'date string YYYY-MM-DD', example: '"2026-11-25"' },
			{ name: '{Label}', type: 'string', when: 'both', description: 'same value under the label' }
		],
		example: { id: 'expense_date', label: 'Expense Date', type: 'date' }, notes: [VAR_NOTE],
		help: dateHelp('Date', 'YYYY-MM-DD', '2026-11-25', false),
		templatePalette: { defaultName: 'Due Date' }
	},
	time: {
		type: 'time', displayName: 'Single Time Picker', icon: Codicon.watch, category: 'input', usableIn: ['ticket', 'node'], ai: 'exposed',
		purpose: 'A time of day (HH:MM).',
		description: 'Time of day. Value is a string "HH:MM" in 24-hour format (e.g. "09:30").',
		runtime: PASS_THROUGH_RUNTIME, props: DATE_PROPS, outputs: [
			{ name: '{var}', type: 'string', when: 'both', description: 'time string HH:MM', example: '"09:30"' },
			{ name: '{Label}', type: 'string', when: 'both', description: 'same value under the label' }
		],
		example: { id: 'incident_time', label: 'Incident Time', type: 'time' }, notes: [VAR_NOTE],
		help: dateHelp('Time', 'HH:MM (24-hour)', '09:30', false),
		templatePalette: { defaultName: 'Time' }
	},
	datetime: {
		type: 'datetime', displayName: 'Single DateTime Picker', icon: Codicon.history, category: 'input', usableIn: ['ticket', 'node'], ai: 'exposed',
		purpose: 'A date and time (YYYY-MM-DDTHH:MM).',
		description: 'Date and time. Value is a string "YYYY-MM-DDTHH:MM" (e.g. "2026-11-25T09:30"); older values may use a space instead of "T".',
		runtime: PASS_THROUGH_RUNTIME, props: DATE_PROPS, outputs: [
			{ name: '{var}', type: 'string', when: 'both', description: 'date-time string YYYY-MM-DDTHH:MM', example: '"2026-11-25T09:30"' },
			{ name: '{Label}', type: 'string', when: 'both', description: 'same value under the label' }
		],
		example: { id: 'submission_time', label: 'Submission Timestamp', type: 'datetime' }, notes: [VAR_NOTE],
		help: dateHelp('Date & Time', 'YYYY-MM-DDTHH:MM (the picker writes a "T"; older values may use a space instead)', '2026-11-25T09:30', false),
		templatePalette: { defaultName: 'Timestamp' }
	},
	date_range: {
		type: 'date_range', displayName: 'Date Range (Start ~ End)', icon: Codicon.calendar, category: 'input', usableIn: ['ticket', 'node'], ai: 'exposed',
		purpose: 'A range of dates ("start ~ end").',
		description: 'Range of dates. Value is one string "start ~ end" with each side "YYYY-MM-DD" (e.g. "2026-11-25 ~ 2026-11-30").',
		runtime: PASS_THROUGH_RUNTIME, props: DATE_PROPS, outputs: [
			{ name: '{var}', type: 'string', when: 'both', description: 'one "start ~ end" string', example: '"2026-11-25 ~ 2026-11-30"' },
			{ name: '{Label}', type: 'string', when: 'both', description: 'same value under the label' }
		],
		example: { id: 'travel_period', label: 'Travel Dates', type: 'date_range' }, notes: [VAR_NOTE],
		help: dateHelp('Date Range', 'YYYY-MM-DD', '2026-11-25 ~ 2026-11-30', true),
		templatePalette: { defaultName: 'Date Range' }
	},
	time_range: {
		type: 'time_range', displayName: 'Time Range (Start ~ End)', icon: Codicon.watch, category: 'input', usableIn: ['ticket', 'node'], ai: 'exposed',
		purpose: 'A range of times ("start ~ end").',
		description: 'Range of times. Value is one string "start ~ end" with each side "HH:MM" (e.g. "09:00 ~ 18:00").',
		runtime: PASS_THROUGH_RUNTIME, props: DATE_PROPS, outputs: [
			{ name: '{var}', type: 'string', when: 'both', description: 'one "start ~ end" string', example: '"09:00 ~ 18:00"' },
			{ name: '{Label}', type: 'string', when: 'both', description: 'same value under the label' }
		],
		example: { id: 'working_hours', label: 'Shift Hours', type: 'time_range' }, notes: [VAR_NOTE],
		help: dateHelp('Time Range', 'HH:MM (24-hour)', '09:00 ~ 18:00', true),
		templatePalette: { defaultName: 'Time Range' }
	},
	datetime_range: {
		type: 'datetime_range', displayName: 'DateTime Range (Start ~ End)', icon: Codicon.history, category: 'input', usableIn: ['ticket', 'node'], ai: 'exposed',
		purpose: 'A range of date-times ("start ~ end").',
		description: 'Range of date-times. Value is one string "start ~ end" with each side "YYYY-MM-DDTHH:MM" (e.g. "2026-11-25T09:00 ~ 2026-11-25T18:00").',
		runtime: PASS_THROUGH_RUNTIME, props: DATE_PROPS, outputs: [
			{ name: '{var}', type: 'string', when: 'both', description: 'one "start ~ end" string', example: '"2026-11-25T09:00 ~ 2026-11-25T18:00"' },
			{ name: '{Label}', type: 'string', when: 'both', description: 'same value under the label' }
		],
		example: { id: 'booking_window', label: 'Booking Window', type: 'datetime_range' }, notes: [VAR_NOTE],
		help: dateHelp('Date & Time Range', 'YYYY-MM-DDTHH:MM', '2026-11-25T09:00 ~ 2026-11-25T18:00', true),
		templatePalette: { defaultName: 'Duration Range' }
	},

	dynamic_list: {
		type: 'dynamic_list',
		displayName: 'Container (Nested Subfields)',
		icon: Codicon.layers,
		category: 'data',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Repeating entries of sub-fields; publishes a JSON array.',
		description: 'Nested repeatable line items or sub-table. Supports itemFields (array of sub-fields) or componentRef (reusable class ID). Stored value: a JSON array of entries, one object per entry keyed by sub-field label, with optional "_index" and "_title". In a ticket run it publishes that array as structured JSON (without "_index"; every sub-field label present, "" when empty) under outputVariableName (or the name generated from the label, e.g. expense_items) and under its label, plus {name.json} with the JSON text; an empty list publishes []. Read it as {expense_items}, {expense_items.0.Date} or, in Python, as a list of dicts. Example: [{"_title": "Trip A", "Item Name": "Taxi", "Date": "2026-11-25", "Amount ($)": "12", "Notes": ""}].',
		runtime: 'Parses the stored entries (in a node: defaultContent) into an array of objects keyed by sub-field label and publishes it under {var}, the label and {var.json}; the card is marked Done, also when empty ([]).',
		props: [
			{ name: 'itemFields', kind: 'objectArray', role: 'structured', description: 'Sub-fields [{id, label, type, options?}]. Give itemFields or componentRef.' },
			{ name: 'componentRef', kind: 'string', role: 'structured', description: 'Reusable class id instead of itemFields.' },
			{ name: 'defaultContent', kind: 'string', acceptsJson: true, ticketValue: true, description: 'Initial entries (JSON array); in a workflow node these are the items.' }
		],
		outputs: [
			{ name: '{var}', type: 'object[]', when: 'both', description: 'entries, one object per entry keyed by sub-field label ("_title" kept, "_index" dropped, missing sub-fields ""); [] when empty', example: '[{"_title": "Trip A", "Item Name": "Taxi", "Amount ($)": "12"}]' },
			{ name: '{Label}', type: 'object[]', when: 'both', description: 'same array under the label' },
			{ name: '{var}.json / {Label}.json', type: 'string', when: 'both', description: 'the same array as JSON text' }
		],
		example: {
			id: 'expense_items',
			label: 'Expense Items',
			type: 'dynamic_list',
			itemFields: [
				{ id: 'item_name', label: 'Item Name', type: 'text' },
				{ id: 'item_date', label: 'Date', type: 'date' },
				{ id: 'item_amount', label: 'Amount ($)', type: 'text' },
				{ id: 'item_notes', label: 'Notes', type: 'textarea' }
			]
		},
		notes: ['Values inside entries stay text as saved.'],
		help: {
			badge: 'Composite Matrix Container',
			summary: 'A tabular dynamic matrix allowing users to add, remove, and reorder multiple rows with defined sub-column schemas.',
			designerConfig: [{ name: 'Subfield Column Definitions', desc: 'Define individual column types and titles (e.g. Item Name, Cost, Quantity).' }],
			headline: 'How RUN_TICKETS Executes Dynamic List Container',
			steps: [
				{ step: '1. Item Records', detail: 'Reads the saved entries. Each entry becomes one object keyed by sub-field label, e.g. { "Item Name": "Taxi", "Amount": "12" }; an entry title is kept as "_title". Values stay as saved (text).' },
				{ step: '2. Publish as JSON Array', detail: 'Publishes the array under the output variable name (outputVariableName, or the name generated from the label, e.g. expense_items) and under the label. {name.json} holds the same array as JSON text.' },
				{ step: '3. Done Status', detail: 'The card is marked Done like any input. An empty list is Done too and publishes [].' }
			],
			variableResolution: '{expense_items} / {expense_items.0.Amount} / {Field Label.json}',
			downstreamPassing: 'Python reads it as a list of dicts (TICKET_CONTEXT["expense_items"] or the expense_items global); {expense_items} in a prompt inserts the JSON text; GET_OUTPUTS returns the array when an Output component lists it.',
			syntaxExamples: ['{expense_items}', '{expense_items.0.Amount}', '{expense_items.json}'],
			tips: ['Ideal for order items, milestone matrices, test step checklists, or multi-item data grids.', 'Example value: [{"_title": "Trip A", "Item Name": "Taxi", "Amount": "12"}, {"Item Name": "Hotel", "Amount": "90"}]']
		},
		templatePalette: { defaultName: 'Container' }
	},

	attachment: {
		type: 'attachment',
		displayName: 'Attachment (Files)',
		icon: Codicon.files,
		category: 'data',
		usableIn: ['ticket'],
		ai: 'exposed',
		purpose: 'Files attached to the ticket (stored in its attachments/ folder).',
		description: 'File upload field for documents, files, proof receipts, or images. Files are copied into the ticket attachments/ folder. Ticket only.',
		runtime: 'Passes the stored attachment value (file references) to later steps.',
		props: [],
		outputs: [
			{ name: '{var}', type: 'string', when: 'both', description: 'the stored attachment value (file references)' },
			{ name: '{Label}', type: 'string', when: 'both', description: 'same value under the label' }
		],
		example: { id: 'receipt_files', label: 'Receipts & Invoices', type: 'attachment' },
		notes: ['Not available in workflow nodes.'],
		help: {
			badge: 'Assets & Media',
			summary: 'Manages file attachments, documents, images, and workspace relative assets.',
			designerConfig: [{ name: 'Files', desc: 'Files are added on the ticket and copied into its attachments/ folder.' }],
			headline: 'How RUN_TICKETS Executes Attachment',
			steps: [
				{ step: '1. Path Resolution', detail: 'Resolves workspace relative file URIs.' },
				{ step: '2. Context Binding', detail: 'Registers file URI paths into contextVariables for file reading tools.' }
			],
			variableResolution: '{Field Label}',
			downstreamPassing: 'Passed to vision models or document summarization tools.',
			syntaxExamples: ['{Field Label}'],
			tips: ['Keeps files versioned locally alongside the ticket folder.']
		},
		templatePalette: { defaultName: 'Attachment' }
	},

	button_group: {
		type: 'button_group',
		displayName: 'Action Buttons (Approval Gate)',
		icon: Codicon.run,
		category: 'input',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Human decision gate: a run waits until a person clicks one of the buttons; the clicked button is the output.',
		description: 'Row of buttons [{id, label, color?, targetStatus?}] that acts as a human approval gate. When a ticket run or a workflow run (also a ticket run inside a workflow node, or the component directly in a node) reaches it, the run PAUSES until a person clicks one of the buttons: on the ticket page (the card shows "Waiting for your decision"), on the workflow canvas (the node shows the buttons), from the notification, or via resumeWorkflow with { label: "<button>" }. The clicked button\'s label is the output; a button\'s targetStatus becomes the ticket status when the run ends successfully. The ticket opens to the right of the workflow so the person sees what they approve; waitingPrompt (default "Waiting for your decision", {variables} allowed) is the text shown while waiting; "Stop this run" ends the whole run (the step fails as stopped). Clicking a button outside a run changes the status (targetStatus) and records the choice as the component value.',
		runtime: 'Waits for a click (no timeout, never decided automatically). Publishes {Label} = clicked label and {Label.id} / {Label.label} / {Label.at} / {Label.by}; stores {buttonId, label, at, by, targetStatus} as the ticket value; the ticket status at the end of a successful run is the clicked button\'s targetStatus (instead of Completed). A stopped run cancels the wait and fails the step. Pending waits are kept in memory: reloading the window ends the waiting run.',
		props: [
			{ name: 'buttons', kind: 'objectArray', role: 'structured', required: true, description: 'Buttons [{id, label*, color?, targetStatus?}]. Without buttons the card shows Approve (-> Done) and Reject (-> Blocked).' },
			{ name: 'waitingPrompt', kind: 'string', default: 'Waiting for your decision', description: 'Waiting Prompt: text shown on the ticket card, the workflow node and the notification while a run waits. Supports {variables}.' }
		],
		outputs: [
			{ name: '{var}', type: 'string', when: 'both', description: 'label of the clicked button', example: '"Approve"' },
			{ name: '{Label}', type: 'string', when: 'both', description: 'same label under the component label and its label_key (link conditions: @review == \'Approve\'); a ticket run inside a workflow node also publishes it unprefixed in the workflow' },
			{ name: '{var.id}', type: 'string', when: 'both', description: 'id of the clicked button', example: '"btn_approve"' },
			{ name: '{var.label}', type: 'string', when: 'both', description: 'label of the clicked button' },
			{ name: '{var.at}', type: 'string', when: 'both', description: 'ISO time of the click', example: '"2026-11-27T15:04:05.000Z"' },
			{ name: '{var.by}', type: 'string', when: 'both', description: 'who decided ("User" for a click in the app)' },
			{ name: '{var}_result', type: 'object', when: 'both', description: '{id, label, at, by} as one dict (Python: TICKET_CONTEXT["review_result"]["label"]); also under {label_key}_result' }
		],
		example: {
			id: 'review_actions',
			label: 'Review',
			type: 'button_group',
			buttons: [
				{ id: 'btn_approve', label: 'Approve', color: '#10b981', targetStatus: 'Done' },
				{ id: 'btn_reject', label: 'Reject', color: '#ef4444', targetStatus: 'Blocked' }
			],
			waitingPrompt: 'Approve the release of {version}?'
		},
		notes: [
			'A run that reaches the buttons waits for a person: only add it where a human decision is wanted.',
			'Branch in a workflow with link conditions on the label key: @review == \'Approve\' / @review == \'Reject\' (label "Review" -> review). This works for the buttons directly in a node and for a node that runs a ticket containing them: the ticket\'s decisions are published unprefixed in the workflow (review, Review, review_result, Review.by ...; if a variable of that name already exists, the latest decision wins), besides the ticket-prefixed ANYAG-0121.review, and as the identifier-safe ANYAG_0121_review / ANYAG_0121_review_result for a specific ticket (@ANYAG_0121_review == \'Approve\').',
			'Old data may use the legacy type id "button"; it is migrated to "button_group" on load.'
		],
		help: {
			badge: 'Human Approval Gate',
			summary: 'Buttons such as Approve / Reject. A run that reaches them pauses until a person clicks one; the clicked button becomes the output and can set the ticket status.',
			designerConfig: [
				{ name: 'Button Definitions', desc: 'Button label, color, and optional target status (set when the run ends after this choice, or immediately for a click outside a run).' },
				{ name: 'Waiting Prompt', desc: 'Text shown while a run waits (default "Waiting for your decision"); supports {variables}.' }
			],
			headline: 'How Runs Handle Action Buttons',
			steps: [
				{ step: '1. Pause', detail: 'The run stops at the buttons. The ticket opens to the right of the workflow (or is revealed where it is already open) with the card highlighted and the Waiting Prompt (default "Waiting for your decision"); the workflow node shows the prompt and the buttons; a notification can reveal the ticket again. "Stop this run" on the card or the node ends the whole run.' },
				{ step: '2. Decide', detail: 'A person clicks a button (ticket page, canvas or notification); an agent can resume the workflow with the button label when told to. Stop ends the wait and the run.' },
				{ step: '3. Publish', detail: '{Label} = clicked label; {Label.id}, {Label.label}, {Label.at}, {Label.by}. The choice is stored on the ticket. When a workflow node runs the ticket, the decision is also published unprefixed in the workflow (latest decision wins) and as <TICKET_ID>_<label_key> (e.g. ANYAG_0121_review), so the next link can branch: @review == \'Approve\'.' },
				{ step: '4. Status', detail: 'The button\'s target status becomes the ticket status when the run finishes successfully.' }
			],
			variableResolution: '{Field Label} (clicked label), {Field Label.at}, {Field Label.by}',
			downstreamPassing: 'Later steps and link conditions read the decision, e.g. @review == \'Approve\' on the links after the node (also when the node runs a ticket containing the buttons).',
			syntaxExamples: ['{Review}', '{Review.by}', '@review == \'Approve\''],
			tips: ['Outside a run, clicking a button still changes the ticket status and records the choice.']
		},
		templatePalette: { defaultName: 'Action Buttons' },
		nodePalette: { label: 'Approval Buttons', accent: '#fbbf24', tooltip: 'Human approval gate: the workflow waits until a person clicks one of the buttons; the clicked label is the output.' }
	},

	ssh: {
		type: 'ssh',
		displayName: 'SSH Terminal (Remote Linux)',
		icon: Codicon.terminal,
		category: 'processing',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Runs shell commands on a remote Linux host over SSH.',
		description: 'Connects to a remote Linux host and runs the commands in order (stops at the first connection failure). Output is a JSON object mapping each command to its last N output lines. Commands support {var} interpolation. Never put a plain-text password in the config; reference a variable instead.',
		runtime: 'Resolves {variables} in host, port, user, password, cwd and each command, connects via SSH (fails immediately when the connection fails), runs the commands in order tracking cd, and outputs {"command": ["last N lines"]}. Settings saved on the ticket win over the template.',
		props: [
			{ name: 'sshHost', kind: 'string', required: true, ticketValue: true, description: 'Host or IP; supports {var}.' },
			{ name: 'sshPort', kind: 'number', default: 22, ticketValue: true, description: 'Port.' },
			{ name: 'sshUser', kind: 'string', default: 'root', ticketValue: true, description: 'User name.' },
			{ name: 'sshPassword', kind: 'string', secret: true, ticketValue: true, description: 'Password (variable reference only).' },
			{ name: 'sshCwd', kind: 'string', default: '~', ticketValue: true, description: 'Remote working directory.' },
			{ name: 'sshCommands', kind: 'stringArray', required: true, ticketValue: true, description: 'Commands, run in order; support {var}.' },
			{ name: 'sshOutputLines', kind: 'number', default: 50, ticketValue: true, description: 'Lines kept per command.' },
			{ name: 'sshCommand', kind: 'string', role: 'state', ticketValue: true, description: 'Older single-command form; read when sshCommands is empty.' },
			{ name: 'defaultContent', kind: 'string', role: 'state', description: 'Oldest command form; read when sshCommands and sshCommand are empty.' },
			{ name: 'sshQuickCommands', kind: 'objectArray', role: 'editor', ticketValue: true, description: 'Quick command buttons of the card.' },
			{ name: 'sshOutput', kind: 'string', role: 'state', ticketValue: true, description: 'Terminal text of the last run.' },
			{ name: 'sshLastOutput', kind: 'string', role: 'state', ticketValue: true, description: 'JSON output of the last run.' },
			{ name: 'sshLastRawOutput', kind: 'string', role: 'state', ticketValue: true, description: 'Raw output of the last run.' },
			{ name: 'sshLastRawEntries', kind: 'objectArray', role: 'state', ticketValue: true, description: 'Raw output per command of the last run.' }
		],
		outputs: [
			{ name: '{var}', type: 'object', when: 'both', description: '{"command": ["last N lines", ...]} per command', example: '{"df -h": ["Filesystem Size Used"]}' },
			{ name: '{Label}', type: 'object', when: 'both', description: 'same object under the label' },
			{ name: '{var}_output', type: 'object', when: 'ticket', description: 'same object' }
		],
		example: {
			id: 'ssh_1',
			label: 'Check GPU Server',
			type: 'ssh',
			sshHost: '{gpu_host}',
			sshPort: 22,
			sshUser: 'ubuntu',
			sshPassword: '{GPU_PASSWORD}',
			sshCwd: '~',
			sshCommands: ['nvidia-smi', 'df -h'],
			sshOutputLines: 50
		},
		notes: ['Runs remote commands: ask the user before running it.', 'Not offered in the template toolbox yet; it can be added by the AI or in workflow nodes.'],
		help: {
			badge: 'Execution & Automation',
			summary: 'Connects to remote Linux servers via SSH using IP/Host, Port, Username, and Password. Features a unified collapsible operation panel (Terminal Window + Quick Linux Commands + Dynamic Multi-Command Send Bars) and outputs a standard JSON object.',
			designerConfig: [
				{ name: 'SSH Credentials & Dynamic Variables', desc: 'Target Linux server IP/Host, Port (default 22), Username (default root), Password, and Remote Dir (CWD) — all supporting {variable} interpolation from upstream Workflow nodes.' },
				{ name: 'Unified Collapsible Operation Panel', desc: 'Integrates the Terminal Display Window, Quick Linux Commands bar, and Dynamic Command Send Bars into a single panel (collapsed by default; click to expand or collapse as one unit).' },
				{ name: 'Dynamic Multi-Command Send Bars', desc: 'Add any number of command send bars (#1 → #2 → ...). Each bar can be executed individually ("Send") or all bars sequentially ("Run All"), and supports full-command or inline {variable} interpolation.' },
				{ name: 'Unified Standard JSON Output', desc: 'Outputs a clean JSON object { "<actual_command>": ["line 1", "line 2", ...] } retaining the last N lines (Output Lines) per command without mixing with previous runs.' }
			],
			headline: 'How Workflow & RUN_TICKETS Execute SSH Terminal Primitive',
			steps: [
				{ step: '1. Dynamic Connection & Command Resolution', detail: 'Resolves {variables} in Host, Port, Username, Password, CWD, and each Command Send Bar (supporting single commands, inline templates, or command arrays).' },
				{ step: '2. Automatic SSH Connection & Fail-Fast Check', detail: 'Establishes SSH session via PTY password auto-login. If connection/authentication fails, execution terminates immediately with an explicit SSH connection error.' },
				{ step: '3. Sequential Multi-Command Execution', detail: 'Executes all configured command send bars in addition order (#1 → #2 → ...), tracking working directory changes (e.g. cd /var/www) across commands.' },
				{ step: '4. Standard JSON Output Generation', detail: 'Builds a valid JSON object mapping each executed command string to an array of its last N output lines, replacing the component Output cleanly for downstream nodes.' }
			],
			variableResolution: '{Field Label} or {Field Label_output}',
			downstreamPassing: 'The complete JSON object { "pwd": ["/home/user/project"], "ls -la": ["total 128", ...] } is exposed to downstream AI Prompts, Python scripts, and Output Manifests.',
			syntaxExamples: [
				'{\n  "pwd": ["/home/user/project"],\n  "docker ps": ["CONTAINER ID   IMAGE   STATUS"]\n}',
				'cd {project_dir} && git status',
				'{dynamic_ssh_command}'
			],
			tips: [
				'Click "SSH Terminal & Command Console" to expand or collapse the Terminal Window, Quick Linux Commands, and Command Send Bars together as a single unit.',
				'Click "+ Add Command" to add multiple command send bars; use each bar\'s "Send" button to run a single command or "Run All" to execute all bars sequentially.',
				'Adjust "Output Lines" in the JSON Output header to control how many trailing lines are retained per command array in the JSON output.',
				'Click "IDE Terminal" to open a full interactive PTY session directly in the IDE bottom terminal panel.'
			]
		},
		nodePalette: { label: 'SSH Terminal', accent: '#34d399', tooltip: 'SSH Remote Linux Terminal component (IP, Port, Account, Password, Quick Linux Commands & embedded terminal).' }
	},

	sub_workflow: {
		type: 'sub_workflow',
		displayName: 'Call Sub-Workflow',
		icon: Codicon.layers,
		category: 'composite',
		usableIn: ['ticket', 'node'],
		ai: 'exposed',
		purpose: 'Calls a reusable sub-workflow (a sub_workflow ticket) and returns its outputs.',
		description: 'Calls a reusable sub-workflow (a sub_workflow ticket) from a ticket template or a workflow node: passes inputs in, runs it, and hands its outputs to the next steps. Settings: subWorkflowId (required, the sub-workflow TICKET ID: find it with GET_TICKETS(ticket_type="sub_workflow")), subWorkflowInputs {inputName: value or {var}}. Outputs are not configured here: they are the sub-workflow\'s own outputs. Recursion is never allowed (a sub-workflow must not call itself, directly or through other sub-workflows / tickets) and calls nest at most 5 levels deep.',
		runtime: 'Config: subWorkflowId* (the sub-workflow TICKET ID, e.g. FINDJ-0042: find it with GET_TICKETS(ticket_type="sub_workflow"), read its inputs / outputs with GET_TICKET(id)), subWorkflowInputs {inputName: expression or {var}}. Inputs not bound use the sub-workflow defaults. Runs the sub-workflow with those inputs (the same execution path in a ticket run and in a node); the result is the sub-workflow Output: the raw value if it has exactly one output item, otherwise a dictionary keyed by output name. A failed sub-workflow fails the step. Recursion (the same sub-workflow or workflow twice on the call chain) or nesting deeper than 5 levels stops the whole run with an error naming the chain; saving or starting a run that contains such a cycle is reported up front. Runs the latest saved definition of the ticket (edit it by opening the ticket: it has its own canvas). Creating a new sub-workflow is a separate action, not done by this component: encapsulate selected nodes on a workflow canvas (they move into the new ticket and are replaced by one Call Sub-Workflow node), or CREATE_TICKETS(ticket_type="sub_workflow", path=<parent workflow folder>, params={"definition": {...}}).',
		props: [
			{ name: 'subWorkflowId', kind: 'string', required: true, description: 'The Sub-Workflow ticket ID (e.g. FINDJ-0042; find it with GET_TICKETS(ticket_type="sub_workflow")), or the legacy subwf_... id of a migrated Sub-Workflow.' },
			{ name: 'subWorkflowInputs', kind: 'object', description: 'Input bindings {inputName: value or {var}}, by the sub-workflow input names; unbound inputs use their defaults.' },
			{ name: 'subWorkflowName', kind: 'string', role: 'state', description: 'Name of the linked sub-workflow (filled from the ticket).' },
			{ name: 'subWorkflowSourceUri', kind: 'string', role: 'state', description: 'Workflow the sub-workflow was saved from (written, never read).' },
			{ name: 'subWorkflowInputDefs', kind: 'objectArray', role: 'state', description: 'Input definitions copied from the sub-workflow ticket.' },
			{ name: 'subWorkflowOutputDefs', kind: 'objectArray', role: 'state', description: 'Output definitions copied from the sub-workflow ticket (shown read-only on the card).' }
		],
		outputs: [
			{ name: '{var}', type: 'any | object', when: 'both', description: 'sub-workflow outputs: the raw value with one output item, else a dictionary keyed by output name' },
			{ name: '{Label}', type: 'any | object', when: 'both', description: 'same value under the label' }
		],
		example: { id: 'call_sub', label: 'Call Sub-Workflow', type: 'sub_workflow', subWorkflowId: 'FINDJ-0042', subWorkflowInputs: { query: '{keyword}' } },
		notes: [
			'In a template: pick the sub-workflow on the card (the picker lists sub_workflow tickets). In a workflow node: add it from the Sub-Workflow Library, not from the Node Components palette.',
			'Every sub-workflow is an independent workflow: a ticket of type sub_workflow with its own ticket ID and its own canvas (open the ticket to edit it). Its definition is .agents/sub_workflow.json in the ticket folder; every caller runs the latest saved version.',
			'No recursion: a template or workflow whose calls form a cycle (e.g. A -> B -> A) is reported when saved and refuses to run; at run time the call chain is checked and nesting is limited to 5 levels.',
			'To create one from code / AI: CREATE_TICKETS(ticket_type="sub_workflow", path=<parent workflow folder>, params={"definition": {"name": ..., "nodes": [...], "links": [...], "inputs": [...], "outputs": [...]}}). It must be created inside a workflow folder; node ids must be unique and links must connect given nodes; without a definition it starts empty.'
		],
		help: builtinHelp('Call Sub-Workflow',
			'Calls a reusable sub-workflow from a ticket or a workflow node: passes inputs in, runs it, and hands its outputs to the next steps. Every sub-workflow is a ticket of type sub_workflow with its own ticket ID, so it can be called from the workflow it came from, from any other workflow and from ticket templates.',
			[
				{ name: 'Sub-Workflow', desc: 'Required. The sub-workflow ticket ID (e.g. FINDJ-0042). In a template: pick it on the card (lists sub_workflow tickets, name + ID). In a workflow: pick it from the Sub-Workflow Library ("+" button or drag onto a node). For AI / code: find it with GET_TICKETS(ticket_type="sub_workflow") (each result has a short inputs / outputs summary), read the full contract with GET_TICKET(id), then put the ticket ID into this step.' },
				{ name: 'Inputs', desc: 'Values for the sub-workflow Inputs, by input name; each can be a value or a {variable}.' },
				{ name: 'Outputs', desc: 'Read-only: the sub-workflow\'s own outputs.' }
			],
			[
				{ step: '1. Resolve', detail: 'Finds the sub_workflow ticket by its ID and reads its definition (.agents/sub_workflow.json in the ticket folder). Steps saved before sub-workflows became tickets keep their old subwf_... id, which still resolves.' },
				{ step: '2. Check the call chain', detail: 'Stops the whole run if this sub-workflow (or workflow) is already running higher up the chain (recursion) or if calls would nest more than 5 levels; the error names the chain, e.g. A -> B -> A.' },
				{ step: '3. Run', detail: 'Runs the sub-workflow with the given Inputs, using the latest saved definition of the sub_workflow ticket (its own canvas). The workflow it was extracted from is not read.' },
				{ step: '4. Return outputs', detail: 'Returns the sub-workflow Output: the value itself if there is one output item, otherwise a dictionary keyed by output name. A failed sub-workflow marks the step Failed.' }
			],
			'Later steps read the result from the output variable.',
			['{call_sub_workflow_result}'],
			['To create a new sub-workflow, select nodes on a workflow canvas and encapsulate them (Workflow Outline > Encapsulate Selected Nodes): the nodes move into the new sub_workflow ticket and are replaced by one node calling it. Or create a sub_workflow ticket from code / AI: CREATE_TICKETS(ticket_type="sub_workflow", path=<parent workflow folder>, params={"definition": {"name": ..., "nodes": [...], "links": [...], "inputs": [...], "outputs": [...]}}). It must be created inside a workflow folder; without a definition it starts empty. This component only calls existing ones.', 'Recursion is never allowed: saving a template or workflow whose calls form a cycle shows an error naming the chain, and such a run refuses to start.']),
		templatePalette: { defaultName: 'Call Sub-Workflow' }
	}
} as const satisfies { readonly [T in CustomFieldType]: IComponentSpec & { readonly type: T } };

/** Component types with a spec (every CustomFieldType). */
export type ComponentType = keyof typeof COMPONENT_SPECS;

/** Order of the template designer / Freestyle toolbox ("Base Primitives"). Every entry needs `templatePalette`. */
export const TEMPLATE_PALETTE_ORDER: readonly ComponentType[] = [
	'parameters', 'prompt', 'tts', 'media_player', 'voice_note', 'browser', 'git', 'shell', 'python', 'http_request', 'table', 'output',
	'create_tickets', 'run_tickets', 'get_outputs', 'display', 'sub_workflow',
	'text', 'textarea', 'number', 'select', 'multiselect', 'switch', 'date', 'time', 'datetime', 'date_range', 'time_range', 'datetime_range',
	'dynamic_list', 'attachment', 'button_group'
];

/** Order of the workflow editor "Node Components" palette. Every entry needs `nodePalette`. */
export const NODE_PALETTE_ORDER: readonly ComponentType[] = [
	'parameters', 'output', 'python', 'create_tickets', 'run_tickets', 'get_outputs', 'get_tickets', 'display',
	'prompt', 'table', 'browser', 'tts', 'media_player', 'voice_note', 'ssh', 'shell', 'http_request', 'git', 'button_group'
];

/** Help of a Reusable Class instance (a Container bound to a composite class); not a component type of its own. */
export const REUSABLE_CLASS_HELP: IComponentHelp & { readonly title: string; readonly icon: ThemeIcon } = {
	title: 'Reusable Class (Composite Component Group)',
	icon: Codicon.package,
	badge: 'Modular Composite Class',
	summary: 'A reusable bundled collection of fields packaged as a cohesive component class and instantiated across multiple ticket schemas.',
	designerConfig: [
		{ name: 'Class Binding', desc: 'Reference to the defined composite class.' },
		{ name: 'Instance Label', desc: 'Unique namespace prefix for this instance on the canvas.' }
	],
	headline: 'How RUN_TICKETS Executes Reusable Classes',
	steps: [
		{ step: '1. Item Records', detail: 'A Reusable Class instance is a Dynamic List of the class sub-fields. Each entry becomes one object keyed by sub-field label (missing sub-fields are "").' },
		{ step: '2. Publish as JSON Array', detail: 'Publishes the array of entries under the instance variable name (outputVariableName, or the name generated from the label) and under the label; {name.json} holds the JSON text.' },
		{ step: '3. Done Status', detail: 'The card is marked Done like any input; an empty instance publishes [].' }
	],
	variableResolution: '{seo_pack_1} / {seo_pack_1.0.meta_title}',
	downstreamPassing: 'Python reads it as a list of dicts; {seo_pack_1} in a prompt inserts the JSON text; GET_OUTPUTS returns the array when an Output component lists it.',
	syntaxExamples: ['{seo_pack_1}', '{seo_pack_1.0.meta_title}', '{seo_pack_1.json}'],
	tips: ['Build reusable classes for domain-specific groups like "SEO Metadata", "Approval Block", or "Deployment Specs".']
};

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------

const SPEC_LIST: readonly IComponentSpec[] = Object.values(COMPONENT_SPECS);

/** All specs, in registry order. */
export function getAllComponentSpecs(): readonly IComponentSpec[] {
	return SPEC_LIST;
}

/** Spec of a component type, or undefined for unknown types (case-insensitive, trimmed). */
export function getComponentSpec(type: string | undefined): IComponentSpec | undefined {
	const key = (type || '').trim().toLowerCase();
	return SPEC_LIST.find(spec => spec.type === key);
}

/** Configuration schema of a type: the common properties followed by the type's own. */
export function getComponentProps(type: string): readonly IComponentConfigProp[] {
	const spec = getComponentSpec(type);
	return spec ? [...COMMON_COMPONENT_PROPS, ...spec.props] : [];
}

/** Types the AI may use in ticket templates (generate tool enum and validation). */
export function getAiTemplateComponentTypes(): CustomFieldType[] {
	return SPEC_LIST.filter(spec => spec.ai === 'exposed' && spec.usableIn.includes('ticket')).map(spec => spec.type);
}

/** Properties the AI may write through `config` for a type (role `config`), including the common ones. */
export function getAiConfigProps(type: string): readonly IComponentConfigProp[] {
	return getComponentProps(type).filter(prop => (prop.role ?? 'config') === 'config');
}

/** Names of the secret properties written as plain strings (browser credentials are checked separately). */
export function getSecretPropNames(): string[] {
	const names = new Set<string>();
	for (const spec of SPEC_LIST) {
		for (const prop of spec.props) {
			if (prop.secret && prop.kind === 'string') {
				names.add(prop.name);
			}
		}
	}
	return Array.from(names);
}

/** Typed view of one component's configuration (the common props plus the type's own props). */
export type ComponentConfigView<T extends ComponentType> = Pick<ICustomField,
	(typeof COMMON_COMPONENT_PROPS)[number]['name'] | (typeof COMPONENT_SPECS)[T]['props'][number]['name']>;

/** Returns the field as a typed view of `type`, or undefined when it is another type. */
export function getComponentConfig<T extends ComponentType>(field: ICustomField, type: T): ComponentConfigView<T> | undefined {
	return field.type === type ? field : undefined;
}

// ---------------------------------------------------------------------------------------------
// Generated catalogs
// ---------------------------------------------------------------------------------------------

/** One entry of GET_PRIMITIVES_CATALOG (structurally IPrimitiveCatalogItem of the workflow runtime). */
export interface IComponentCatalogEntry {
	type: string;
	label: string;
	icon: string;
	category: ComponentCategory;
	description: string;
	executionBehavior: string;
	supportedInputs?: string[];
	supportedOutputs?: string[];
	usableIn?: ComponentUsage[];
	notes?: string[];
}

/** One line for an output variable: `{var} (string, ticket run only): description, e.g. "x"`. */
export function describeOutput(out: IComponentOutputVar): string {
	const when = out.when === 'both' ? '' : `, ${out.when} run only`;
	return `${out.name} (${out.type}${when}): ${out.description}${out.example ? `, e.g. ${out.example}` : ''}`;
}

function describeProp(prop: IComponentConfigProp): string {
	return `${prop.name}${prop.required ? '*' : ''}: ${prop.description}`;
}

/** Base component entries of GET_PRIMITIVES_CATALOG (AI-exposed types only). */
export function buildPrimitivesCatalog(): IComponentCatalogEntry[] {
	return SPEC_LIST.filter(spec => spec.ai === 'exposed').map(spec => {
		const inputs = spec.props.filter(prop => prop.role !== 'state');
		const entry: IComponentCatalogEntry = {
			type: spec.type,
			label: spec.displayName,
			icon: spec.icon.id,
			category: spec.category,
			description: spec.description,
			executionBehavior: spec.runtime
		};
		if (inputs.length > 0) {
			entry.supportedInputs = inputs.map(describeProp);
		}
		if (spec.outputs.length > 0) {
			entry.supportedOutputs = spec.outputs.map(describeOutput);
		}
		if (spec.usableIn.length < 2) {
			entry.usableIn = [...spec.usableIn];
		}
		if (spec.notes.length > 0) {
			entry.notes = [...spec.notes];
		}
		return entry;
	});
}

/** One `base_primitives` entry of listCustomModules (component types the AI may put into ticket templates). */
export interface IAiBasePrimitive {
	type: string;
	label: string;
	description: string;
	requiresOptions: boolean;
	supportsItemFields: boolean;
	example: Record<string, unknown>;
	/** Variables the component publishes (see describeOutput). */
	outputs: string[];
	notes?: string[];
}

/** `base_primitives` of listCustomModules. */
export function buildAiBasePrimitives(): IAiBasePrimitive[] {
	const allowed = new Set<string>(getAiTemplateComponentTypes());
	return SPEC_LIST.filter(spec => allowed.has(spec.type)).map(spec => {
		const props: readonly IComponentConfigProp[] = spec.props;
		const entry: IAiBasePrimitive = {
			type: spec.type,
			label: spec.displayName,
			description: spec.description,
			requiresOptions: props.some(prop => prop.name === 'options' && prop.required),
			supportsItemFields: props.some(prop => prop.name === 'itemFields'),
			example: { ...spec.example },
			outputs: spec.outputs.map(describeOutput)
		};
		if (spec.notes.length > 0) {
			entry.notes = [...spec.notes];
		}
		return entry;
	});
}

/** `type: prop, prop; type: ...` list of the per-type `config` settings for the generate tool description. */
export function describeAiConfigProps(): string {
	return getAiTemplateComponentTypes()
		.map(type => ({ type, props: getAiConfigProps(type).filter(prop => !COMMON_COMPONENT_PROPS.some(common => common.name === prop.name)) }))
		.filter(entry => entry.props.length > 0)
		.map(entry => `${entry.type}: ${entry.props.map(prop => prop.name).join(', ')}`)
		.join('; ');
}

/** One entry of the workflow editor "Node Components" palette. */
export interface INodeComponentPaletteItem {
	readonly compType: CustomFieldType;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly accent: string;
	readonly desc: string;
}

/** The workflow "Node Components" palette, in display order. */
export function getNodeComponentPalette(): INodeComponentPaletteItem[] {
	return NODE_PALETTE_ORDER.map(type => {
		const spec: IComponentSpec = COMPONENT_SPECS[type];
		const entry = spec.nodePalette;
		if (!entry) {
			throw new Error(`Component '${type}' is in NODE_PALETTE_ORDER but has no nodePalette entry.`);
		}
		return { compType: spec.type, label: entry.label, icon: entry.icon ?? spec.icon, accent: entry.accent, desc: entry.tooltip ?? spec.purpose };
	});
}

// ---------------------------------------------------------------------------------------------
// Help guide (rendered by customModules/browser/primitiveHelpGuide.ts)
// ---------------------------------------------------------------------------------------------

export interface IPrimitiveGuide {
	type: string;
	title: string;
	icon: ThemeIcon;
	category: string;
	summary: string;
	designerConfig: { name: string; desc: string }[];
	runTicketsFlow: {
		headline: string;
		steps: { step: string; detail: string }[];
		variableResolution: string;
		downstreamPassing: string;
	};
	/** Published variables, one line each (see describeOutput). */
	outputs: string[];
	syntaxExamples: string[];
	tips: string[];
}

function toGuide(type: string, title: string, icon: ThemeIcon, help: IComponentHelp, fallbackSummary: string, outputs: readonly IComponentOutputVar[]): IPrimitiveGuide {
	return {
		type,
		title,
		icon,
		category: help.badge,
		summary: help.summary ?? fallbackSummary,
		designerConfig: help.designerConfig.map(c => ({ name: c.name, desc: c.desc })),
		runTicketsFlow: {
			headline: help.headline,
			steps: help.steps.map(st => ({ step: st.step, detail: st.detail })),
			variableResolution: help.variableResolution,
			downstreamPassing: help.downstreamPassing
		},
		outputs: outputs.map(describeOutput),
		syntaxExamples: [...help.syntaxExamples],
		tips: [...help.tips]
	};
}

/**
 * Returns the help guide of a component type, generated from the component registry (componentRegistry.ts), or a
 * generic guide for unknown types.
 */
export function getPrimitiveGuide(fieldType: string, customLabel?: string, componentRef?: string): IPrimitiveGuide {
	if (componentRef || (fieldType || '').trim().toLowerCase() === 'reusable_class') {
		const h = REUSABLE_CLASS_HELP;
		return toGuide('reusable_class', customLabel || h.title, h.icon, h, h.summary ?? '', COMPONENT_SPECS.dynamic_list.outputs);
	}

	const spec = getComponentSpec(fieldType);
	if (spec) {
		return toGuide(spec.type, customLabel || spec.displayName, spec.icon, spec.help, spec.description, spec.outputs);
	}

	// Generic fallback
	const normalized = (fieldType || '').toLowerCase().trim();
	return {
		type: normalized,
		title: customLabel || fieldType.toUpperCase(),
		icon: Codicon.symbolField,
		category: 'Custom Field Primitive',
		summary: `Custom field primitive of type "${fieldType}". Captures data in tickets and exposes values to workflow execution.`,
		designerConfig: [{ name: 'Field Configuration', desc: 'Standard schema label, defaults, and validation rules.' }],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes This Primitive',
			steps: [
				{ step: '1. Value Resolution', detail: 'Reads input or stored value from ticket metadata.' },
				{ step: '2. Context Insertion', detail: 'Registers field value into contextVariables under its label.' }
			],
			variableResolution: '{Field Label}',
			downstreamPassing: 'Available downstream via {Field Label} or {TicketName.Field Label}.'
		},
		outputs: [],
		syntaxExamples: ['{Field Label}'],
		tips: ['Configure descriptive field labels for seamless variable interpolation downstream.']
	};
}

