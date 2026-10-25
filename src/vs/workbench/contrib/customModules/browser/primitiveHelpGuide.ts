/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, $ } from '../../../../base/browser/dom.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';

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
	syntaxExamples: string[];
	tips: string[];
}

const PRIMITIVE_GUIDES: Record<string, IPrimitiveGuide> = {
	parameters: {
		type: 'parameters',
		title: 'Input Parameters (Runtime Variables)',
		icon: Codicon.symbolVariable,
		category: 'Input & Parameter Definition',
		summary: 'Defines dynamic input parameters, variable names, and default fallback values passed into the ticket during manual runs or automated workflow execution.',
		designerConfig: [
			{ name: 'Field Label / Name', desc: 'Display title for the parameter group.' },
			{ name: 'Parameter Keys & Defaults', desc: 'Declare key names and initial fallback values (e.g. query: "AI Search").' },
			{ name: 'Required Constraints', desc: 'Marks specific parameters as mandatory before execution.' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes Input Parameters',
			steps: [
				{
					step: '1. Inbound Arguments Ingestion',
					detail: 'runTickets inspects options.inputParams passed from the caller, workflow nodes, or user triggers.'
				},
				{
					step: '2. Default Value Merging',
					detail: 'If a declared parameter is missing from inbound arguments, the primitive automatically applies its configured defaultValue.'
				},
				{
					step: '3. Context Variable Registration',
					detail: 'Registers resolved parameters into contextVariables under both its key (e.g. "query") and sanitized label, enabling seamless variable interpolation downstream.'
				}
			],
			variableResolution: 'Available downstream as {param_name}, {{param_name}}, and {TicketName.param_name}.',
			downstreamPassing: 'Subsequent primitives (Browser, AI Prompt, Output) can immediately use these variables in URLs or prompts.'
		},
		syntaxExamples: [
			'{target_keyword}',
			'{{target_keyword:-DefaultValue}}',
			'{MyTicket.target_keyword}'
		],
		tips: [
			'Always provide sensible default values to ensure workflow test runs succeed without manual input.',
			'Use snake_case or camelCase keys for clean variable substitution in downstream prompts.'
		]
	},

	browser: {
		type: 'browser',
		title: 'Browser (Web Navigation & Data Extraction)',
		icon: Codicon.globe,
		category: 'Web Navigation & Data Scraping',
		summary: 'Automates URL navigation, headless DOM rendering, and readable text extraction to provide real-time external web data for AI reasoning.',
		designerConfig: [
			{ name: 'Target URL Template', desc: 'Target URL supporting dynamic variable interpolation (e.g. https://news.ycombinator.com?q={topic}).' },
			{ name: 'Credential Binding', desc: 'Optional authentication credentials or session tokens for protected endpoints.' },
			{ name: 'Selector & Mode', desc: 'CSS selector filter or extraction mode (Markdown, plain text, HTML).' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes Browser Primitive',
			steps: [
				{
					step: '1. Dynamic URL Interpolation',
					detail: 'Substitutes {variable} placeholders in the Target URL with values from preceding Parameters or earlier steps.'
				},
				{
					step: '2. Web Content Fetching & Headless Engine',
					detail: 'Calls IWebContentExtractorService for headless browser rendering. If headless is unavailable, falls back to direct HTTP fetch.'
				},
				{
					step: '3. Noise Reduction & Markdown Conversion',
					detail: 'Strips out script tags, ads, navigation bars, and converts core article body into clean, token-efficient Markdown text.'
				},
				{
					step: '4. Context & Field Output Storage',
					detail: 'Stores full text into contextVariables[FieldLabel] and sets {FieldLabel_url} to the resolved URL.'
				}
			],
			variableResolution: 'Access extracted content via {Field Label}, {{Field Label}}, or {{Field Label.content}}.',
			downstreamPassing: 'Subsequent AI Prompt primitives can reference {{Browser 1}} to summarize, analyze, or synthesize the web page.'
		},
		syntaxExamples: [
			'{Browser 1}',
			'{{Browser 1.content}}',
			'{{Browser 1_url}}'
		],
		tips: [
			'Use parameters to dynamically build the search query or target URL path.',
			'Keep URLs fully qualified (including https://).'
		]
	},

	prompt: {
		type: 'prompt',
		title: 'AI Prompt (Model / Agent Inference)',
		icon: Codicon.sparkle,
		category: 'AI Reasoning & Agent Execution',
		summary: 'Orchestrates LLM inference or dispatches tasks to autonomous agents. Supports multi-turn prompting, model selection, and automatic token telemetry.',
		designerConfig: [
			{ name: 'Target Model', desc: 'Selection of LLM engine (e.g. Gemini 2.5 Flash, Gemini 2.5 Pro, GPT-4o, Claude 3.5 Sonnet).' },
			{ name: 'System Prompt', desc: 'Core persona, behavioral boundaries, and system-level instructions.' },
			{ name: 'Prompt Template', desc: 'Main prompt text supporting rich multi-variable interpolation with preceding inputs and web content.' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes AI Prompt',
			steps: [
				{
					step: '1. Template Interpolation',
					detail: 'Replaces all {variable} and {{variable}} tags with extracted parameters, browser text, and form inputs.'
				},
				{
					step: '2. Credential & Model Resolution',
					detail: 'Checks IAgentCredentialService for configured API keys (Google Gemini, OpenAI, Anthropic Claude).'
				},
				{
					step: '3. Inference Dispatch & Streaming',
					detail: 'Executes executePrompt(...) against the selected model API synchronously and monitors execution latency.'
				},
				{
					step: '4. Output Capture & Audit Log',
					detail: 'Captures the generated response text, saves it into customMetadata and contextVariables, and prepares it for Output Manifest aggregation.'
				}
			],
			variableResolution: 'Access generated response via {Field Label}, {{AI Prompt 1}}, or {ticketId.AI Prompt 1}.',
			downstreamPassing: 'The Output primitive automatically detects and imports this text into the final ticket result manifest.'
		},
		syntaxExamples: [
			'{AI Prompt 1}',
			'{{AI Prompt 1}}',
			'{{AI Prompt 1.result}}'
		],
		tips: [
			'Structure prompts with explicit formatting rules (e.g. "Output as a Markdown table with 3 columns").',
			'Combine with Browser primitive for automated web research and intelligence summarization.'
		]
	},

	output: {
		type: 'output',
		title: 'Output (Manifest & Export Selection)',
		icon: Codicon.output,
		category: 'Aggregation & Downstream Export',
		summary: 'The central export hub of a ticket. Specifies which primitives to expose, their display format (Table, Markdown, JSON, Text), and provides the payload for downstream workflows.',
		designerConfig: [
			{ name: 'Output Manifest Primitives', desc: 'Select which upstream primitives (Browser, AI Prompt, Text) to include in the exported result.' },
			{ name: 'Default Display Format', desc: 'Choose between Table, Markdown, JSON, and Text representation.' },
			{ name: 'Export as Output Flags', desc: 'Toggle individual items on or off for downstream consumption.' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes Output Manifest',
			steps: [
				{
					step: '1. Upstream Primitive Collection',
					detail: 'Scans the enabled output specs list (outputSpecs) and retrieves the latest values from contextVariables.'
				},
				{
					step: '2. Format Normalization',
					detail: 'Transforms data into the chosen format (Markdown table parsing, JSON serialization, or clean text formatting).'
				},
				{
					step: '3. Persistence in metadata.json & work_log.md',
					detail: 'Updates the ticket snapshot with the aggregated result and appends an execution summary entry to work_log.md.'
				},
				{
					step: '4. Workflow Return Value Delivery',
					detail: 'Directly returned as ITicketRunResult.output. In Workflow DAGs, this binds to downstream variables (e.g. @summary = ticketOutput).'
				}
			],
			variableResolution: 'Referenced externally as {TicketName.output}, {TicketName.FieldLabel}, or @workflowVariable.',
			downstreamPassing: 'This is the primary payload handed off to the next node in the workflow graph.'
		},
		syntaxExamples: [
			'{TicketName.output}',
			'{output.FieldLabel}',
			'@workflowVar = ticketOutput'
		],
		tips: [
			'Use [Sync Primitives] in the card configuration to auto-detect and populate all canvas primitives.',
			'Table view automatically parses Markdown pipes (|) into interactive data grids.'
		]
	},

	git: {
		type: 'git',
		title: 'Git Repository & Branch Binding',
		icon: Codicon.sourceControl,
		category: 'Environment & Version Control',
		summary: 'Binds the ticket to a specific Git repository and branch, enabling contextual workspace operations and commit tracking.',
		designerConfig: [
			{ name: 'Repository URL', desc: 'Git clone / remote URL.' },
			{ name: 'Default Branch', desc: 'Target working branch (e.g. main, dev).' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes Git Binding',
			steps: [
				{ step: '1. Repository Verification', detail: 'Inspects configured Git URL and validates local checkout status.' },
				{ step: '2. Branch Metadata Extraction', detail: 'Reads current HEAD commit hash, branch name, and status.' },
				{ step: '3. Context Registration', detail: 'Registers {git_url} and {git_branch} into contextVariables.' }
			],
			variableResolution: '{git_url}, {git_branch}, {Field Label}',
			downstreamPassing: 'Available for commit scripts, CI/CD triggering, or repo-scoped AI coding subagents.'
		},
		syntaxExamples: ['{git_url}', '{git_branch}'],
		tips: ['Combine with automated task tickets to record exact commit hashes for reproducibility.']
	},

	text: {
		type: 'text',
		title: 'Single-line Input (Text)',
		icon: Codicon.symbolString,
		category: 'Standard Form Input',
		summary: 'Standard single-line text input for identifiers, titles, keywords, or short configuration strings.',
		designerConfig: [
			{ name: 'Default Value', desc: 'Initial text prepopulated in new tickets.' },
			{ name: 'Placeholder Text', desc: 'Help text shown when input is empty.' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes Text Field',
			steps: [
				{ step: '1. Value Extraction', detail: 'Reads value from input overrides or ticket metadata.' },
				{ step: '2. Whitespace Trimming', detail: 'Trims surrounding whitespace and validates presence.' },
				{ step: '3. Variable Registration', detail: 'Registers trimmed string into contextVariables[FieldLabel].' }
			],
			variableResolution: '{Field Label}',
			downstreamPassing: 'Available for URL interpolation, prompt placeholders, or workflow condition evaluation.'
		},
		syntaxExamples: ['{Field Label}', '{{Field Label}}'],
		tips: ['Use clear, concise labels so other primitives can easily reference the field by name.']
	},

	textarea: {
		type: 'textarea',
		title: 'Textarea (Multiline Text)',
		icon: Codicon.listFlat,
		category: 'Standard Form Input',
		summary: 'Multi-line text area supporting Markdown, logs, specifications, or free-form long inputs.',
		designerConfig: [
			{ name: 'Default Content', desc: 'Multiline text or Markdown template.' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes Textarea',
			steps: [
				{ step: '1. Multiline Retrieval', detail: 'Retrieves complete multiline string value.' },
				{ step: '2. Variable Context Insertion', detail: 'Inserts string verbatim into contextVariables.' }
			],
			variableResolution: '{Field Label}',
			downstreamPassing: 'Often fed into AI Prompt templates as background context or instruction bodies.'
		},
		syntaxExamples: ['{Field Label}'],
		tips: ['Supports standard Markdown formatting for structured descriptions.']
	},

	python: {
		type: 'python',
		title: 'Python (Code Automation & Scripting)',
		icon: Codicon.code,
		category: 'Execution & Automation',
		summary: 'Executes Python automation scripts within tickets using a specified local interpreter or virtual environment. Supports data transformation, API calls, file processing, and runtime context access.',
		designerConfig: [
			{ name: 'Field Label / Name', desc: 'Display title for the Python automation step.' },
			{ name: 'Python Interpreter / Virtualenv', desc: 'Specify path to Python binary (e.g. .venv/bin/python, /usr/bin/python3, or python3).' },
			{ name: 'Default Script Template', desc: 'Initial code template preloaded into new tickets of this type.' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes Python Primitive',
			steps: [
				{ step: '1. Interpreter Resolution', detail: 'Resolves specified Python binary or auto-detects active virtualenv (.venv/bin/python) / system python3.' },
				{ step: '2. Variable Interpolation & Context Injection', detail: 'Interpolates {{variables}} and injects ticket runtime variables into ANY_AGENT_CONTEXT environment variable.' },
				{ step: '3. Script Execution & Log Capture', detail: 'Runs script synchronously with timeout protection, capturing stdout, stderr, exit code, and runtime duration.' },
				{ step: '4. Context Registration & Metadata Update', detail: 'Stores captured stdout into contextVariables and updates ticket customMetadata.' }
			],
			variableResolution: '{Field Label} or {Field Label_output}',
			downstreamPassing: 'Captured output (stdout) can be passed directly to downstream AI Prompts, Browsers, or Output Manifests.'
		},
		syntaxExamples: [
			'import os, json\ncontext = json.loads(os.environ.get("ANY_AGENT_CONTEXT", "{}"))\nprint(f"Processing ticket: {context.get(\'title\')}")',
			'{Field Label}'
		],
		tips: [
			'Use the "Create venv" button in the ticket view to instantly initialize a local virtual environment for package dependencies.',
			'Any standard library or installed pip packages in your virtualenv are immediately available to your script.'
		]
	},

	number: {
		type: 'number',
		title: 'Number Input (Numeric)',
		icon: Codicon.symbolNumber,
		category: 'Numeric & Metrics',
		summary: 'Numeric input supporting integers and floating point values with boundary limits and step configurations.',
		designerConfig: [
			{ name: 'Default Number', desc: 'Initial numeric value.' },
			{ name: 'Min / Max Bounds', desc: 'Optional boundary constraints.' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes Number Primitive',
			steps: [
				{ step: '1. Numeric Parsing', detail: 'Converts input string into standard numeric float/integer.' },
				{ step: '2. Bounds Validation', detail: 'Checks min and max thresholds.' },
				{ step: '3. Context Registration', detail: 'Stores parsed number into contextVariables for mathematical expressions.' }
			],
			variableResolution: '{Field Label}',
			downstreamPassing: 'Used by workflow condition branches (e.g. if amount > 1000) or prompt evaluation.'
		},
		syntaxExamples: ['{Field Label}'],
		tips: ['Can be used in Python-like expressions within workflow condition routers.']
	},

	select: {
		type: 'select',
		title: 'Dropdown (Select)',
		icon: Codicon.chevronDown,
		category: 'Choice & Selection',
		summary: 'Single-choice dropdown menu selecting from a predefined list of discrete options.',
		designerConfig: [
			{ name: 'Options List', desc: 'List of selectable option strings.' },
			{ name: 'Default Option', desc: 'Option selected by default.' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes Dropdown',
			steps: [
				{ step: '1. Option Matching', detail: 'Validates that the selected value belongs to the configured options list.' },
				{ step: '2. Context Assignment', detail: 'Stores selected string into contextVariables[FieldLabel].' }
			],
			variableResolution: '{Field Label}',
			downstreamPassing: 'Ideal for workflow routing (e.g. if priority == "High").'
		},
		syntaxExamples: ['{Field Label}'],
		tips: ['Configure clear, mutually exclusive options for deterministic workflow decisions.']
	},

	multiselect: {
		type: 'multiselect',
		title: 'Checkboxes (Multiselect Tags)',
		icon: Codicon.checklist,
		category: 'Choice & Selection',
		summary: 'Multiple selection checkboxes allowing users to pick zero or more tags/options.',
		designerConfig: [
			{ name: 'Options List', desc: 'List of available tag options.' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes Multiselect',
			steps: [
				{ step: '1. Array Aggregation', detail: 'Gathers all checked options into a string array.' },
				{ step: '2. Serialization', detail: 'Exposes both as array and comma-separated string in contextVariables.' }
			],
			variableResolution: '{Field Label}',
			downstreamPassing: 'Useful for multi-tag categorization and filter matching.'
		},
		syntaxExamples: ['{Field Label}'],
		tips: ['Easily referenced in prompts as a comma-separated list of selected tags.']
	},

	switch: {
		type: 'switch',
		title: 'Switch (Boolean Toggle)',
		icon: Codicon.circleFilled,
		category: 'Control & State',
		summary: 'Boolean toggle switch representing true/false flags for feature gates or automation triggers.',
		designerConfig: [
			{ name: 'Default State', desc: 'Enabled (true) or Disabled (false).' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes Switch',
			steps: [
				{ step: '1. Boolean Normalization', detail: 'Normalizes input to strict boolean true or false.' },
				{ step: '2. Context Registration', detail: 'Registers boolean value into contextVariables.' }
			],
			variableResolution: '{Field Label}',
			downstreamPassing: 'Directly drives workflow conditional links (e.g. if is_urgent == true).'
		},
		syntaxExamples: ['{Field Label}'],
		tips: ['Combine with workflow condition branches to selectively skip or trigger expensive steps.']
	},

	dynamic_list: {
		type: 'dynamic_list',
		title: 'Container (Nested Dynamic Subfields)',
		icon: Codicon.layers,
		category: 'Composite Matrix Container',
		summary: 'A tabular dynamic matrix allowing users to add, remove, and reorder multiple rows with defined sub-column schemas.',
		designerConfig: [
			{ name: 'Subfield Column Definitions', desc: 'Define individual column types and titles (e.g. Item Name, Cost, Quantity).' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes Dynamic List Container',
			steps: [
				{ step: '1. Row Iteration', detail: 'Iterates through each row in the dynamic table.' },
				{ step: '2. Object Serialization', detail: 'Maps rows to an array of objects ({ col1: val1, col2: val2 }).' },
				{ step: '3. JSON & Table Export', detail: 'Registers structured array into contextVariables.' }
			],
			variableResolution: '{Field Label}',
			downstreamPassing: 'Prompts can parse this as a JSON list or render it directly into Markdown tables.'
		},
		syntaxExamples: ['{Field Label}'],
		tips: ['Ideal for order items, milestone matrices, test step checklists, or multi-item data grids.']
	},

	attachment: {
		type: 'attachment',
		title: 'Attachment (Files / Images / PDF)',
		icon: Codicon.files,
		category: 'Assets & Media',
		summary: 'Manages file attachments, documents, images, and workspace relative assets.',
		designerConfig: [
			{ name: 'File Constraints', desc: 'Accepted file extensions or size thresholds.' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes Attachment',
			steps: [
				{ step: '1. Path Resolution', detail: 'Resolves workspace relative file URIs.' },
				{ step: '2. Context Binding', detail: 'Registers file URI paths into contextVariables for file reading tools.' }
			],
			variableResolution: '{Field Label}',
			downstreamPassing: 'Passed to vision models or document summarization tools.'
		},
		syntaxExamples: ['{Field Label}'],
		tips: ['Keeps files versioned locally alongside the ticket folder.']
	},

	button_group: {
		type: 'button_group',
		title: 'Action Buttons (Horizontal)',
		icon: Codicon.run,
		category: 'Interactive Actions & Transitions',
		summary: 'Configures interactive action buttons that transition ticket lifecycle statuses (e.g. Approve, Reject, Restart).',
		designerConfig: [
			{ name: 'Button Definitions', desc: 'Button title, color theme, and target status to transition to.' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes Action Buttons',
			steps: [
				{ step: '1. Automated Step Handling', detail: 'In headless automated execution, action buttons represent checkpoints.' },
				{ step: '2. Human-in-the-Loop Integration', detail: 'Can pause execution in single-step workflows waiting for human resume/approval.' }
			],
			variableResolution: '{Field Label}',
			downstreamPassing: 'Workflow can inspect the chosen action or status transition.'
		},
		syntaxExamples: ['{status}'],
		tips: ['Use action buttons to establish clear, auditable human-in-the-loop review gates.']
	},

	reusable_class: {
		type: 'reusable_class',
		title: 'Reusable Class (Composite Component Group)',
		icon: Codicon.package,
		category: 'Modular Composite Class',
		summary: 'A reusable bundled collection of fields packaged as a cohesive component class and instantiated across multiple ticket schemas.',
		designerConfig: [
			{ name: 'Class Binding', desc: 'Reference to the defined composite class.' },
			{ name: 'Instance Label', desc: 'Unique namespace prefix for this instance on the canvas.' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes Reusable Classes',
			steps: [
				{ step: '1. Class Field Enumeration', detail: 'Recursively loads all subfields defined inside the reusable class.' },
				{ step: '2. Dot-Notation Namespacing', detail: 'Registers each child field using dot notation: {InstanceName.child_field}.' },
				{ step: '3. Full Object Delivery', detail: 'Also exports the entire bundle as a nested dictionary under {InstanceName}.' }
			],
			variableResolution: '{ClassName.subField}',
			downstreamPassing: 'Allows modular, encapsulated data passing across ticket steps and workflows.'
		},
		syntaxExamples: [
			'{SeoPack.meta_title}',
			'{SeoPack.keywords}',
			'{SeoPack}'
		],
		tips: ['Build reusable classes for domain-specific groups like "SEO Metadata", "Approval Block", or "Deployment Specs".']
	}
};

/**
 * Returns guide documentation for any primitive type or fallback generic info.
 */
export function getPrimitiveGuide(fieldType: string, customLabel?: string, componentRef?: string): IPrimitiveGuide {
	if (componentRef) {
		const base = PRIMITIVE_GUIDES['reusable_class'];
		return {
			...base,
			title: customLabel || base.title
		};
	}

	const normalized = (fieldType || '').toLowerCase().trim();
	if (PRIMITIVE_GUIDES[normalized]) {
		const base = PRIMITIVE_GUIDES[normalized];
		return {
			...base,
			title: customLabel || base.title
		};
	}

	// Generic date/time match
	if (normalized.includes('date') || normalized.includes('time')) {
		return {
			type: normalized,
			title: customLabel || `${fieldType.toUpperCase()} Picker`,
			icon: Codicon.calendar,
			category: 'Date & Time Dimension',
			summary: 'Captures ISO 8601 formatted date and time values for milestones and scheduling.',
			designerConfig: [{ name: 'Default Timestamp', desc: 'Initial date/time value.' }],
			runTicketsFlow: {
				headline: 'How RUN_TICKETS Executes Date/Time Primitive',
				steps: [
					{ step: '1. Date Normalization', detail: 'Formats date/time string to standard ISO 8601 representation.' },
					{ step: '2. Context Assignment', detail: 'Saves timestamp into contextVariables[FieldLabel].' }
				],
				variableResolution: '{Field Label}',
				downstreamPassing: 'Used for timeline logging and schedule comparisons in workflows.'
			},
			syntaxExamples: ['{Field Label}'],
			tips: ['Standard ISO timestamps allow accurate programmatic comparison in workflow condition links.']
		};
	}

	// Generic fallback
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
		syntaxExamples: ['{Field Label}'],
		tips: ['Configure descriptive field labels for seamless variable interpolation downstream.']
	};
}

/**
 * Displays a clean, modal flyout window explaining the primitive's usage and RUN_TICKETS execution behavior.
 */
export function showPrimitiveHelpModal(container: HTMLElement, fieldType: string, customLabel?: string, componentRef?: string): void {
	const guide = getPrimitiveGuide(fieldType, customLabel, componentRef);

	// Overlay backdrop
	const overlay = append(container, $('.primitive-help-modal-overlay', {
		style: 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0, 0, 0, 0.72); backdrop-filter: blur(6px); z-index: 999999; display: flex; align-items: center; justify-content: center; animation: anyagentFadeIn 0.15s ease-out;'
	}));

	// Modal Card
	const card = append(overlay, $('.primitive-help-modal-card', {
		style: 'width: 720px; max-width: 92vw; max-height: 86vh; background: var(--vscode-editorWidget-background, #1e1e1e); border: 1px solid rgba(56, 189, 248, 0.35); border-radius: 12px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.85); display: flex; flex-direction: column; overflow: hidden; color: var(--vscode-editor-foreground, #cccccc); font-family: var(--vscode-font-family, system-ui, sans-serif);'
	}));

	// Prevent click from propagating to overlay backdrop
	card.onclick = (e) => e.stopPropagation();

	// 1. Header
	const header = append(card, $('div', {
		style: 'display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); background: rgba(0, 0, 0, 0.25); flex-shrink: 0;'
	}));

	const titleLeft = append(header, $('div', { style: 'display: flex; align-items: center; gap: 10px;' }));
	append(titleLeft, $('span' + ThemeIcon.asCSSSelector(guide.icon), {
		style: 'font-size: 20px; color: #38bdf8;'
	}));

	const titleCol = append(titleLeft, $('div', { style: 'display: flex; flex-direction: column; gap: 2px;' }));
	const titleRow = append(titleCol, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
	append(titleRow, $('span', { style: 'font-size: 15px; font-weight: 600; color: #ffffff;' }, guide.title));
	append(titleRow, $('span.category-badge', {
		style: 'font-size: 9.5px; font-weight: 700; text-transform: uppercase; padding: 2px 7px; border-radius: 4px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); letter-spacing: 0.04em;'
	}, guide.category));

	const closeBtn = append(header, $('button', {
		style: 'background: transparent; border: none; font-size: 16px; color: rgba(255, 255, 255, 0.6); cursor: pointer; padding: 4px 8px; border-radius: 6px; transition: all 0.15s ease;'
	}, '✕'));
	closeBtn.onmouseenter = () => { closeBtn.style.color = '#ffffff'; closeBtn.style.background = 'rgba(255, 255, 255, 0.1)'; };
	closeBtn.onmouseleave = () => { closeBtn.style.color = 'rgba(255, 255, 255, 0.6)'; closeBtn.style.background = 'transparent'; };

	const closeModal = () => {
		overlay.remove();
		document.removeEventListener('keydown', onKeyDown);
	};

	closeBtn.onclick = closeModal;
	overlay.onclick = closeModal;

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			closeModal();
		}
	};
	document.addEventListener('keydown', onKeyDown);

	// 2. Scrollable Content Body
	const body = append(card, $('div', {
		style: 'flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 18px; font-size: 12.5px; line-height: 1.6;'
	}));

	// Summary Callout Box
	const summaryBox = append(body, $('div', {
		style: 'padding: 12px 16px; background: rgba(56, 189, 248, 0.06); border-left: 3px solid #38bdf8; border-radius: 0 6px 6px 0; font-size: 13px; color: #e2e8f0;'
	}));
	summaryBox.textContent = guide.summary;

	// SECTION A: RUN_TICKETS Runtime Execution Flow (Highlighted as Core)
	const runSection = append(body, $('div', {
		style: 'background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(56, 189, 248, 0.28); border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 12px;'
	}));

	const runHeader = append(runSection, $('div', { style: 'display: flex; align-items: center; justify-content: space-between;' }));
	const runTitle = append(runHeader, $('div', { style: 'display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13.5px; color: #38bdf8;' }));
	append(runTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.playCircle)));
	append(runTitle, $('span', {}, guide.runTicketsFlow.headline));

	append(runHeader, $('span', {
		style: 'font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 4px; background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3);'
	}, 'RUNTIME PIPELINE'));

	const stepsList = append(runSection, $('div', { style: 'display: flex; flex-direction: column; gap: 10px;' }));
	guide.runTicketsFlow.steps.forEach(st => {
		const row = append(stepsList, $('div', { style: 'display: flex; flex-direction: column; gap: 3px; padding: 8px 12px; background: rgba(255, 255, 255, 0.02); border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.05);' }));
		append(row, $('div', { style: 'font-weight: 600; color: #ffffff; font-size: 12px;' }, st.step));
		append(row, $('div', { style: 'opacity: 0.85; font-size: 11.5px; line-height: 1.5;' }, st.detail));
	});

	// Downstream Passing Highlight in RUN_TICKETS
	const flowFooter = append(runSection, $('div', {
		style: 'border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 10px; display: flex; flex-direction: column; gap: 4px; font-size: 11.5px;'
	}));
	const flowLabel = append(flowFooter, $('div', { style: 'font-weight: 600; color: #a78bfa;' }, 'Downstream Data Propagation:'));
	flowLabel.textContent = 'Downstream Workflow Propagation:';
	append(flowFooter, $('div', { style: 'opacity: 0.85;' }, guide.runTicketsFlow.downstreamPassing));

	// SECTION B: Designer Configuration Spec
	const configSection = append(body, $('div', { style: 'display: flex; flex-direction: column; gap: 8px;' }));
	append(configSection, $('div', { style: 'font-weight: 600; font-size: 13px; color: #ffffff; display: flex; align-items: center; gap: 6px;' }, [
		$('span' + ThemeIcon.asCSSSelector(Codicon.settings)),
		$('span', {}, 'Designer Configuration & Properties')
	]));

	const configTable = append(configSection, $('div', {
		style: 'display: flex; flex-direction: column; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; overflow: hidden;'
	}));
	guide.designerConfig.forEach((cfg, idx) => {
		const row = append(configTable, $('div', {
			style: `display: flex; padding: 8px 12px; gap: 14px; background: ${idx % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent'}; border-bottom: ${idx < guide.designerConfig.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none'}; font-size: 11.5px;`
		}));
		append(row, $('div', { style: 'font-weight: 600; width: 180px; flex-shrink: 0; color: #e2e8f0;' }, cfg.name));
		append(row, $('div', { style: 'flex: 1; opacity: 0.8;' }, cfg.desc));
	});

	// SECTION C: Variable Syntax & Interpolation
	const syntaxSection = append(body, $('div', { style: 'display: flex; flex-direction: column; gap: 8px;' }));
	append(syntaxSection, $('div', { style: 'font-weight: 600; font-size: 13px; color: #ffffff; display: flex; align-items: center; gap: 6px;' }, [
		$('span' + ThemeIcon.asCSSSelector(Codicon.code)),
		$('span', {}, 'Variable Reference & Interpolation Syntax')
	]));

	const syntaxList = append(syntaxSection, $('div', { style: 'display: flex; flex-wrap: wrap; gap: 8px;' }));
	guide.syntaxExamples.forEach(syn => {
		append(syntaxList, $('code', {
			style: 'padding: 4px 10px; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 4px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; color: #38bdf8;'
		}, syn));
	});

	// SECTION D: Best Practice Tips
	if (guide.tips.length > 0) {
		const tipsSection = append(body, $('div', { style: 'display: flex; flex-direction: column; gap: 6px;' }));
		guide.tips.forEach(tp => {
			const tipRow = append(tipsSection, $('div', { style: 'display: flex; align-items: flex-start; gap: 8px; font-size: 11.5px; opacity: 0.8;' }));
			append(tipRow, $('span' + ThemeIcon.asCSSSelector(Codicon.lightbulb), { style: 'color: #facc15; font-size: 13px; margin-top: 2px;' }));
			append(tipRow, $('span', {}, tp));
		});
	}

	// 3. Footer Bar
	const footer = append(card, $('div', {
		style: 'padding: 12px 20px; border-top: 1px solid rgba(255, 255, 255, 0.08); background: rgba(0, 0, 0, 0.25); display: flex; justify-content: flex-end; align-items: center; gap: 10px; flex-shrink: 0;'
	}));

	const okBtn = append(footer, $('button.monaco-button', {
		style: 'padding: 6px 18px; font-size: 12px; font-weight: 500; border-radius: 6px; cursor: pointer; background: #0284c7; color: #ffffff; border: 1px solid rgba(255, 255, 255, 0.2);'
	}, 'Close Guide'));
	okBtn.onclick = closeModal;
}
