/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
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
		title: 'Inputs (Runtime Variables)',
		icon: Codicon.symbolVariable,
		category: 'Input & Variable Definition',
		summary: 'Defines dynamic input parameters, variable names, and default fallback values passed into the ticket during manual runs or automated workflow execution.',
		designerConfig: [
			{ name: 'Field Label / Name', desc: 'Display title for the inputs group.' },
			{ name: 'Parameter Keys & Defaults', desc: 'Declare key names and initial fallback values (e.g. query: "AI Search").' },
			{ name: 'Required Constraints', desc: 'Marks specific parameters as mandatory before execution.' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes Inputs',
			steps: [
				{
					step: '1. Receive Inputs',
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
		title: 'Browser (Web Application)',
		icon: Codicon.globe,
		category: 'Web Application & Navigation',
		summary: 'Opens a URL and extracts the readable text of the page so later steps (e.g. an AI Prompt) can use it. Retries on failure and falls back to a plain HTTP GET.',
		designerConfig: [
			{ name: 'Target URL', desc: 'URL to open. Supports {variable} references to Inputs and earlier outputs (e.g. https://news.ycombinator.com/item?id={item_id}) and {name} references to Credentials.' },
			{ name: 'Credentials', desc: 'Any number of name = value pairs (names are yours, e.g. user, password, my_api_key). Write {name} in the URL; at run time it is replaced with the URL-encoded value. A value may itself be a variable reference such as {SITE_API_KEY}. Credentials are used only through {name} in the URL: they are not sent as headers, cookies or form logins. A ticket can keep its own credentials; when it has none, the template\'s are used.' },
			{ name: 'Retries', desc: 'Max retries (default 3, up to 10) and delay between retries (default 1000 ms).' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes Browser Primitive',
			steps: [
				{
					step: '1. URL Resolution',
					detail: 'Replaces each {name} of a credential with its URL-encoded value (a credential wins over a variable with the same name), then replaces other {variable} references with Inputs or earlier outputs. Unknown {x} stay as written.'
				},
				{
					step: '2. Fetch with Retries',
					detail: 'Extracts the page with the built-in web content extractor; if it fails, falls back to a plain HTTP GET with tags stripped. Failed attempts are retried with the configured delay.'
				},
				{
					step: '3. Secret Masking',
					detail: 'Credential values are shown as *** in the stored URL, {FieldLabel_url}, run details, logs and error messages. The fetched page text itself is not changed.'
				},
				{
					step: '4. Output',
					detail: 'Stores the page text as {FieldLabel} and the masked URL as {FieldLabel_url}.'
				}
			],
			variableResolution: 'Access the extracted text via {Field Label} or {{Field Label}}; the masked URL via {Field Label_url}.',
			downstreamPassing: 'Subsequent AI Prompt primitives can reference {{Browser 1}} to summarize or analyze the page.'
		},
		syntaxExamples: [
			'https://site/api?user={user}&key={my_api_key}',
			'{Browser 1}',
			'{Browser 1_url}'
		],
		tips: [
			'Put secrets in Credentials, not directly in the URL: only credential values are masked.',
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
		title: 'Output (Result)',
		icon: Codicon.output,
		category: 'Result & Downstream Export',
		summary: 'Defines the RESULT of a ticket, node, or workflow: a dictionary of named items. Whoever runs it (a person, another ticket, a parent workflow, or the AI) reads this result. Every template and every workflow should end with an Output, ideally including a success / status flag.',
		designerConfig: [
			{ name: 'Output Items', desc: 'Each item has a name (label) and a source: a variable or expression such as {summary}, True, or "Done: {count} rows", or another component of this ticket whose value is exported.' },
			{ name: 'Display Format', desc: 'Table, Markdown, JSON, or Text, applied to exported component values.' },
			{ name: 'Enable / Disable', desc: 'Toggle individual items on or off without deleting them.' }
		],
		runTicketsFlow: {
			headline: 'How the Output Is Produced and Used',
			steps: [
				{ step: '1. Evaluate items', detail: 'Each enabled item is evaluated in order. A reference to an undefined variable is an error (the run fails) rather than a silent empty value.' },
				{ step: '2. Store on the ticket', detail: 'The result dictionary is saved with the ticket and shown in its Output card.' },
				{ step: '3. Return to the caller', detail: 'RUN_TICKETS(...).output and GET_OUTPUTS(ticket) return the dictionary; GET_OUTPUTS(ticket, field="name") returns one item.' },
				{ step: '4. Workflow outputs', detail: 'The Output on the final node of a workflow (the node right before End) becomes the WORKFLOW OUTPUTS. When the workflow runs as a sub-workflow, the parent receives the raw value if there is one item, or a dictionary if there are several.' }
			],
			variableResolution: 'Each item is also available to later steps as {label} and as its Python variable name.',
			downstreamPassing: 'This is the payload handed to the next ticket, node, or parent workflow.'
		},
		syntaxExamples: [
			'GET_OUTPUTS(ticket)',
			'GET_OUTPUTS(ticket, field="summary")',
			'res = RUN_TICKETS(ticket=t); res["output"]["success"]'
		],
		tips: [
			'Add a "success" item (e.g. sourceExpression True, or an expression that checks the result) so callers can branch on it.',
			'Use [Sync Primitives] in the card configuration to auto-detect and populate all canvas primitives.'
		]
	},

	table: {
		type: 'table',
		title: 'Data Table (SQLite / Structured Grid)',
		icon: Codicon.table,
		category: 'Database & Structured Data Grid',
		summary: 'Defines a typed database table with customizable column headers, SQLite / SQL data types (TEXT, INTEGER, REAL, NUMERIC, BOOLEAN, DATE, DATETIME, JSON, VARCHAR(255), BLOB), manual and clipboard data entry, AI CRUD tool operations, and direct SQLite database persistence.',
		designerConfig: [
			{ name: 'Column Headers & Data Types', desc: 'Specify each column name, select its SQLite / SQL data type via dropdown, and optionally mark a Primary Key.' },
			{ name: 'Interactive Data Grid & Paste', desc: 'Manually type rows or paste CSV, TSV (Excel/Sheets), Markdown tables, or JSON arrays directly into the grid.' },
			{ name: 'SQLite Database Storage', desc: 'Create a new SQLite (.db) file or select an existing one to store, update (upsert), load, or delete the table data.' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS & AI Operate Data Table',
			steps: [
				{ step: '1. Schema & Row Resolution', detail: 'Loads defined tableColumns and tableRows from the ticket metadata or linked SQLite database.' },
				{ step: '2. AI & Script Manipulation', detail: 'AI agents can read, insert, update, delete rows, or run SQL queries via anyagent_operate_ticket_table.' },
				{ step: '3. SQLite Database Sync', detail: 'Automatically creates the SQLite table (CREATE TABLE IF NOT EXISTS) and persists/updates or deletes records in the bound .db file.' }
			],
			variableResolution: '{Field Label}, {Field Label.json}, {Field Label.dbPath}, {Field Label.tableName}',
			downstreamPassing: 'Downstream AI Prompts receive a formatted Markdown table, and Python scripts can access rows and dbPath via TICKET_CONTEXT.'
		},
		syntaxExamples: [
			'{Job Listings Table}',
			'{Job Listings Table.json}',
			'TICKET_CONTEXT[\'Job Listings Table\']'
		],
		tips: [
			'Mark a unique identifier column (such as id or job_id) as Primary Key (PK) so "Update in SQLite" performs clean upserts.',
			'Press Cmd+V / Ctrl+V directly inside the table or click "Paste Data" to bulk-import rows from spreadsheets or Markdown.'
		]
	},

	git: {
		type: 'git',
		title: 'Git Repository & Branch Binding',
		icon: Codicon.sourceControl,
		category: 'Environment & Version Control',
		summary: 'Records which Git repository and branch the ticket relates to. Reference information only: running the ticket does not clone, check out, or read the repository yet.',
		designerConfig: [
			{ name: 'Repository URL', desc: 'Git clone / remote URL.' },
			{ name: 'Default Branch', desc: 'Target working branch (e.g. main, dev).' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Handles Git Binding',
			steps: [
				{ step: '1. Pass-through only', detail: 'No git operation is performed. The component\'s stored text value is passed to the context under its label.' }
			],
			variableResolution: '{Field Label}',
			downstreamPassing: 'Downstream steps can read the stored value via {Field Label}. To run real git commands, use a Python or SSH component.'
		},
		syntaxExamples: ['{Git Repo}'],
		tips: ['Use a Python or SSH component for actual clone / pull / commit operations.']
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
				{ step: '2. Variable Interpolation & Context Injection', detail: 'Interpolates {{variables}} and automatically injects pre-parsed ticket variables into native TICKET_CONTEXT dictionary and ANY_AGENT_CONTEXT environment variable.' },
				{ step: '3. Script Execution & Return Value Capture', detail: 'Runs script synchronously with timeout protection, capturing stdout, stderr, exit code, runtime duration, and the explicit Return Value (OUTPUT = ..., set_output(...), or RESULT).' },
				{ step: '4. Output Manifest & Return Value Decoupling', detail: 'Distinguishes between Console Logs (stdout/stderr) and the actual Return Value (OUTPUT). Downstream primitives and Output Manifests receive the clean returned value (dict, list, number, boolean, or string) without terminal log banners.' }
			],
			variableResolution: 'TICKET_CONTEXT[\'Field Label\'] or {Field Label}',
			downstreamPassing: 'The Return Value (OUTPUT) is passed directly to Output Manifests and downstream primitives as structured data (dict, list, or text).'
		},
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

	ssh: {
		type: 'ssh',
		title: 'SSH Terminal (Remote Linux Connection & Console)',
		icon: Codicon.terminal,
		category: 'Execution & Automation',
		summary: 'Connects to remote Linux servers via SSH using IP/Host, Port, Username, and Password. Features a unified collapsible operation panel (Terminal Window + Quick Linux Commands + Dynamic Multi-Command Send Bars) and outputs a standard JSON object.',
		designerConfig: [
			{ name: 'SSH Credentials & Dynamic Variables', desc: 'Target Linux server IP/Host, Port (default 22), Username, Password, and Remote Dir (CWD) — all supporting {variable} interpolation from upstream Workflow nodes.' },
			{ name: 'Unified Collapsible Operation Panel', desc: 'Integrates the Terminal Display Window, Quick Linux Commands bar, and Dynamic Command Send Bars into a single panel (collapsed by default; click to expand or collapse as one unit).' },
			{ name: 'Dynamic Multi-Command Send Bars', desc: 'Add any number of command send bars (#1 → #2 → ...). Each bar can be executed individually ("Send") or all bars sequentially ("Run All"), and supports full-command or inline {variable} interpolation.' },
			{ name: 'Unified Standard JSON Output', desc: 'Outputs a clean JSON object { "<actual_command>": ["line 1", "line 2", ...] } retaining the last N lines (Output Lines) per command without mixing with previous runs.' }
		],
		runTicketsFlow: {
			headline: 'How Workflow & RUN_TICKETS Execute SSH Terminal Primitive',
			steps: [
				{ step: '1. Dynamic Connection & Command Resolution', detail: 'Resolves {variables} in Host, Port, Username, Password, CWD, and each Command Send Bar (supporting single commands, inline templates, or command arrays).' },
				{ step: '2. Automatic SSH Connection & Fail-Fast Check', detail: 'Establishes SSH session via PTY password auto-login. If connection/authentication fails, execution terminates immediately with an explicit SSH connection error.' },
				{ step: '3. Sequential Multi-Command Execution', detail: 'Executes all configured command send bars in addition order (#1 → #2 → ...), tracking working directory changes (e.g. cd /var/www) across commands.' },
				{ step: '4. Standard JSON Output Generation', detail: 'Builds a valid JSON object mapping each executed command string to an array of its last N output lines, replacing the component Output cleanly for downstream nodes.' }
			],
			variableResolution: '{Field Label} or {Field Label.output}',
			downstreamPassing: 'The complete JSON object { "pwd": ["/home/user/project"], "ls -la": ["total 128", ...] } is exposed to downstream AI Prompts, Python scripts, and Output Manifests.'
		},
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

	http_request: {
		type: 'http_request',
		title: 'HTTP Request (API / REST Client)',
		icon: Codicon.cloudUpload,
		category: 'Web API & Data Integration',
		summary: 'Universal HTTP / REST API communication component supporting GET, POST, PUT, PATCH, DELETE, HEAD, and OPTIONS. Configures dynamic URL, query parameters, request headers, Bearer/API-Key/Basic authentication, request body, and rich structured JSON output passed cleanly to downstream nodes.',
		designerConfig: [
			{ name: 'Method & Endpoint URL', desc: 'Select HTTP method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS) and declare URL supporting {variable} interpolation.' },
			{ name: 'Query Parameters & Headers', desc: 'Add key-value pairs with toggle checkboxes; automatically interpolated from upstream variables.' },
			{ name: 'Authentication', desc: 'Bearer Token, API Key (Header or Query), Basic Auth, or Custom Header with variable binding.' },
			{ name: 'Request Body', desc: 'JSON or raw payload editor supporting variable placeholders (e.g. {ai_generated_resume}) and JSON formatting.' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS & Workflow Execute HTTP Request Primitive',
			steps: [
				{ step: '1. Dynamic Interpolation', detail: 'Interpolates variables across URL, query parameters, headers, auth token, and request body.' },
				{ step: '2. HTTP Dispatch', detail: 'Sends HTTP request via native fetch with configurable timeout and abort protection.' },
				{ step: '3. Response Parsing', detail: 'Captures status code, status text, response headers, and auto-parses response body into structured JSON if valid.' },
				{ step: '4. Downstream Output Registration', detail: 'Registers structured response into contextVariables[FieldLabel], allowing downstream nodes to access {FieldLabel.data.share_path}, {FieldLabel.status}, etc.' }
			],
			variableResolution: '{Field Label}, {Field Label.status}, {Field Label.data.property}, {Field Label.data}',
			downstreamPassing: 'Subsequent AI Prompts, Python scripts (TICKET_CONTEXT), and Output Manifests receive full parsed JSON or response text.'
		},
		syntaxExamples: [
			'{Upload Resume.data.share_path}',
			'{Get Resume.resume_data.hero.headline}',
			'{API Request.status}',
			'TICKET_CONTEXT[\'Upload Resume\'][\'data\'][\'share_path\']'
		],
		tips: [
			'Use {param_name} or {{param_name}} inside the URL, headers, or body to dynamically bind upstream ticket inputs or AI outputs.',
			'Click "Test API" in the component card to send an immediate live request and preview status, latency, headers, and parsed response JSON.',
			'JSON responses automatically expose their fields to downstream nodes using dot notation (e.g. {API Request.data.share_path}).'
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
				{ step: '1. Item Records', detail: 'Reads the saved entries. Each entry becomes one object keyed by sub-field label, e.g. { "Item Name": "Taxi", "Amount": "12" }; an entry title is kept as "_title". Values stay as saved (text).' },
				{ step: '2. Publish as JSON Array', detail: 'Publishes the array under the output variable name (outputVariableName, or the name generated from the label, e.g. expense_items) and under the label. {name.json} holds the same array as JSON text.' },
				{ step: '3. Done Status', detail: 'The card is marked Done like any input. An empty list is Done too and publishes [].' }
			],
			variableResolution: '{expense_items} / {expense_items.0.Amount} / {Field Label.json}',
			downstreamPassing: 'Python reads it as a list of dicts (TICKET_CONTEXT["expense_items"] or the expense_items global); {expense_items} in a prompt inserts the JSON text; GET_OUTPUTS returns the array when an Output component lists it.'
		},
		syntaxExamples: ['{expense_items}', '{expense_items.0.Amount}', '{expense_items.json}'],
		tips: ['Ideal for order items, milestone matrices, test step checklists, or multi-item data grids.', 'Example value: [{"_title": "Trip A", "Item Name": "Taxi", "Amount": "12"}, {"Item Name": "Hotel", "Amount": "90"}]']
	},

	attachment: {
		type: 'attachment',
		title: 'Attachment (Files)',
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
			headline: 'How RUN_TICKETS Handles Action Buttons',
			steps: [
				{ step: '1. Manual use only', detail: 'Buttons act when a person clicks them in the ticket: the ticket status changes to the button\'s target status.' },
				{ step: '2. No pause during runs', detail: 'Running the ticket or a workflow does NOT stop and wait for a button click. For a human approval step in a workflow, use a node whose label contains "Human Review" / "Approval".' }
			],
			variableResolution: '{status}',
			downstreamPassing: 'Later steps can read the ticket status (e.g. via GET_TICKET) to see which button was clicked.'
		},
		syntaxExamples: ['{status}'],
		tips: ['Buttons are a quick way for people to move a ticket between statuses (e.g. Approve → Done, Reject → Blocked).']
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
				{ step: '1. Item Records', detail: 'A Reusable Class instance is a Dynamic List of the class sub-fields. Each entry becomes one object keyed by sub-field label (missing sub-fields are "").' },
				{ step: '2. Publish as JSON Array', detail: 'Publishes the array of entries under the instance variable name (outputVariableName, or the name generated from the label) and under the label; {name.json} holds the JSON text.' },
				{ step: '3. Done Status', detail: 'The card is marked Done like any input; an empty instance publishes [].' }
			],
			variableResolution: '{seo_pack_1} / {seo_pack_1.0.meta_title}',
			downstreamPassing: 'Python reads it as a list of dicts; {seo_pack_1} in a prompt inserts the JSON text; GET_OUTPUTS returns the array when an Output component lists it.'
		},
		syntaxExamples: [
			'{seo_pack_1}',
			'{seo_pack_1.0.meta_title}',
			'{seo_pack_1.json}'
		],
		tips: ['Build reusable classes for domain-specific groups like "SEO Metadata", "Approval Block", or "Deployment Specs".']
	},

	tts: {
		type: 'tts',
		title: 'Audio / TTS (Text-to-Speech)',
		icon: Codicon.unmute,
		category: 'AI Voice & Audio Synthesis',
		summary: 'Converts multilingual text (English, Chinese, French, etc.) into an audio file (default MP3) using AI models from Agent Central (Google Gemini, OpenAI, Custom OpenAI) and saves the audio file directly inside the ticket folder for persistent playback without repeating LLM calls.',
		designerConfig: [
			{ name: 'Provider & Model Selection', desc: 'Select configured AI Provider/Credential and TTS/Voice Model (same selector as Agent Central).' },
			{ name: 'Audio Format & Voice', desc: 'Choose output format (default MP3, or WAV, OPUS, AAC) and voice profile (e.g. Alloy, Nova, Kore, Puck).' },
			{ name: 'Auto-Play Toggle', desc: 'Configure whether saved audio automatically plays when viewing the module or plays manually on click.' },
			{ name: '1. Speech Synthesis Text (AI Model)', desc: 'Pure multilingual text sent to the TTS model API to synthesize speech (hidden in the Ticket page).' },
			{ name: '2. Display Text (Human View)', desc: 'Annotated text with native-language vocabulary notes or phonetic hints shown to the user in the Ticket page.' }
		],
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes Audio / TTS Primitive',
			steps: [
				{ step: '1. Cache & Persistence Check', detail: 'Checks if an audio file (e.g. .mp3) has already been generated for the current text and saved inside the ticket folder.' },
				{ step: '2. Variable Interpolation & Synthesis', detail: 'If not cached or if forced, interpolates {Field Label} variables and dispatches text to the selected AI model API to synthesize speech.' },
				{ step: '3. Local Ticket Storage', detail: 'Saves the returned audio binary (MP3/WAV) into the ticket attachments directory and records the file path in customMetadata.' }
			],
			variableResolution: 'Exposes the saved audio file path and text under {Field Label} in contextVariables.',
			downstreamPassing: 'Downstream steps or Output primitives can reference the generated audio file path.'
		},
		syntaxExamples: [
			'{Title}',
			'{AI Prompt 1}',
			'{TTS Audio 1}'
		],
		tips: [
			'Once generated, the MP3 file is saved locally inside the ticket folder so reopening the ticket never re-calls the LLM API unless you clear the audio file or change the text.',
			'Enable Auto-Play if you want the audio to play automatically when opening the ticket.'
		]
	},

	media_player: {
		type: 'media_player',
		title: 'MP3 / MP4 Player (Local Audio & Video)',
		icon: Codicon.deviceCameraVideo,
		category: 'Local Media Playback',
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
		runTicketsFlow: {
			headline: 'How RUN_TICKETS Executes MP3 / MP4 Player Primitive',
			steps: [
				{ step: '1. File Path Resolution', detail: 'Resolves the imported local media file path and auto-detects Audio vs. Video format.' },
				{ step: '2. Subtitles (when enabled)', detail: 'Uses the saved subtitles when they were extracted from this same file (name / path and size); otherwise extracts them now with the component settings (same limits and progress as the card) and saves them in the ticket. A failed or refused extraction (e.g. over the size limit) fails this step with the reason. In a workflow node (no ticket) subtitles are not extracted.' },
				{ step: '3. Context Export', detail: 'Exposes the local media file path, or the timed subtitles, to downstream steps in contextVariables.' }
			],
			variableResolution: 'Exposes the local media file path under {Field Label} in contextVariables. With subtitles enabled and extracted, {Field Label} is the timed subtitle text ("[0:01.2 - 0:03.4] line" per line), {Field Label Subtitles} the same text and {Field Label Path} the media path.',
			downstreamPassing: 'Downstream Python or AI Prompt steps can reference the imported media file path, or the timed subtitles when they were extracted.'
		},
		syntaxExamples: [
			'{MP3 / MP4 Player 1}'
		],
		tips: [
			'Supports both clicking to select a local file and dragging & dropping a file from Finder / Explorer.',
			'Scrub or click anywhere on the progress bar to jump to a specific timestamp.'
		]
	},
	voice_note: {
		type: 'voice_note',
		title: 'Voice Note (Audio Recorder & Transcript)',
		icon: Codicon.mic,
		category: 'Voice Notes & Documentation',
		summary: 'Records one or more voice memos directly via microphone with automatic Speech-to-Text transcription and editable text notes. When placed inside a Workflow Flowchart Node, the node automatically displays a speaker icon at its top-right corner to play all recorded voice clips sequentially.',
		designerConfig: [
			{ name: 'Microphone Recording', desc: 'Click the microphone button to record one or multiple audio clips (up to 5 minutes per clip). Audio is saved persistently inside the component.' },
			{ name: 'Auto-Transcribe & Edit', desc: 'Automatically transcribes each recorded clip using the configured Voice Model (IVoiceModelService) and allows manual editing or re-transcription.' },
			{ name: 'Node Top-Right Speaker Playback', desc: 'Any Workflow Flowchart Node containing a Voice Note component automatically displays a speaker icon in its top-right corner. Click it to play all recorded clips in order.' }
		],
		runTicketsFlow: {
			headline: 'How Workflows & Tickets Use Voice Note',
			steps: [
				{ step: '1. Transcript Aggregation', detail: 'Collects transcripts from all recorded clips inside the Voice Note component.' },
				{ step: '2. Context Export', detail: 'Exposes the combined transcript text under {Field Label} so downstream AI Prompt or Python steps can reference your spoken notes.' }
			],
			variableResolution: 'Exposes the combined voice transcript text under {Field Label} in contextVariables.',
			downstreamPassing: 'Downstream AI Prompt, Python, or Display steps can reference the transcribed notes directly.'
		},
		syntaxExamples: [
			'{Voice Note}'
		],
		tips: [
			'Drag Voice Note into any Flowchart Node to attach spoken design rationale or usage instructions.',
			'Click the top-right speaker icon on a Flowchart Node to play all recorded voice clips one by one without opening the side panel.'
		]
	},
	get_ticket: {
		type: 'get_ticket',
		title: 'Get Ticket (get_ticket)',
		icon: Codicon.search,
		category: 'Workflow Built-in Primitives',
		summary: 'Queries and fetches a single specific ticket by Ticket ID or Ticket Variable reference. Supports optional direct field extraction (e.g. status, title, outputs) into the output variable.',
		designerConfig: [
			{ name: 'Ticket ID', desc: 'Direct ticket identifier (e.g. FINDJ-0002 or variable expression {job_id}).' },
			{ name: 'Ticket Variable', desc: 'Reference to an existing upstream ticket variable or handle (e.g. {created_ticket_1}).' },
			{ name: 'Field (Optional)', desc: 'Extracts a specific property value directly (e.g. status, title, custom field) instead of the entire ticket dictionary.' },
			{ name: 'Output Variable', desc: 'Python variable name where the returned ticket data or extracted field is stored.' }
		],
		runTicketsFlow: {
			headline: 'How get_ticket Executes',
			steps: [
				{ step: '1. Target Resolution', detail: 'Resolves the Ticket ID or variable handle in the current workspace or registered repositories.' },
				{ step: '2. Metadata & Outputs Ingestion', detail: 'Loads the ticket markdown, snapshot data, custom metadata, and output components.' },
				{ step: '3. Field Extraction & Return', detail: 'If Field is specified, extracts only that attribute; otherwise returns the complete Ticket object.' }
			],
			variableResolution: 'Stores result in the designated Output Variable and exports to contextVariables.',
			downstreamPassing: 'Downstream Python scripts or Prompt steps can directly read the output variable.'
		},
		syntaxExamples: [
			'job_status = get_ticket(ticket_id="FINDJ-0002", field="status")',
			'ticket_data = get_ticket(ticket=created_ticket)'
		],
		tips: [
			'You can provide either Ticket ID or Ticket Variable to identify which ticket to fetch.',
			'Leave Field blank if you need all metadata and outputs for downstream processing.'
		]
	}
};

/** Help for the six date / time pickers. Values are stored as plain strings and passed through unchanged at run time. */
function dateTimeGuide(type: string, title: string, format: string, example: string, isRange: boolean): IPrimitiveGuide {
	const valueDesc = isRange ? `"start ~ end", each side formatted as ${format}` : format;
	return {
		type,
		title,
		icon: Codicon.calendar,
		category: 'Date & Time Dimension',
		summary: isRange
			? `Captures a ${title.toLowerCase().replace(' range', '')} range. Stored as one string: ${valueDesc} (e.g. "${example}").`
			: `Captures a single ${title.toLowerCase()} value. Stored as a string: ${valueDesc} (e.g. "${example}").`,
		designerConfig: [{ name: 'Default Value', desc: `Optional initial value in the stored format (${valueDesc}).` }],
		runTicketsFlow: {
			headline: `How RUN_TICKETS Handles ${title}`,
			steps: [
				{ step: '1. Read value', detail: 'Uses the run input override if given, otherwise the saved ticket value, otherwise the default value.' },
				{ step: '2. Pass-through', detail: 'The string is NOT reformatted or validated; {variables} inside it are interpolated, then it is stored in the context under the field label.' }
			],
			variableResolution: '{Field Label}',
			downstreamPassing: isRange
				? 'Downstream steps receive the whole "start ~ end" string. In Python, split it with value.split("~") and strip each side.'
				: 'Downstream steps receive the string as-is. Parse it in Python (e.g. datetime.fromisoformat) before comparing.'
		},
		syntaxExamples: ['{Field Label}'],
		tips: isRange
			? ['Always keep the " ~ " separator between start and end.', `Example value: ${example}`]
			: [`Example value: ${example}`]
	};
}

PRIMITIVE_GUIDES['date'] = dateTimeGuide('date', 'Date', 'YYYY-MM-DD', '2026-11-25', false);
PRIMITIVE_GUIDES['time'] = dateTimeGuide('time', 'Time', 'HH:MM (24-hour)', '09:30', false);
PRIMITIVE_GUIDES['datetime'] = dateTimeGuide('datetime', 'Date & Time', 'YYYY-MM-DDTHH:MM (the picker writes a "T"; older values may use a space instead)', '2026-11-25T09:30', false);
PRIMITIVE_GUIDES['date_range'] = dateTimeGuide('date_range', 'Date Range', 'YYYY-MM-DD', '2026-11-25 ~ 2026-11-30', true);
PRIMITIVE_GUIDES['time_range'] = dateTimeGuide('time_range', 'Time Range', 'HH:MM (24-hour)', '09:00 ~ 18:00', true);
PRIMITIVE_GUIDES['datetime_range'] = dateTimeGuide('datetime_range', 'Date & Time Range', 'YYYY-MM-DDTHH:MM', '2026-11-25T09:00 ~ 2026-11-25T18:00', true);

/** Help for the workflow built-ins (ticket orchestration, display, sub-workflow call). */
function builtinGuide(type: string, title: string, icon: ThemeIcon, summary: string, config: { name: string; desc: string }[], steps: { step: string; detail: string }[], output: string, examples: string[], tips: string[]): IPrimitiveGuide {
	return {
		type,
		title,
		icon,
		category: 'Workflow Built-in',
		summary,
		designerConfig: config,
		runTicketsFlow: { headline: `How ${title} Runs`, steps, variableResolution: '{Output Variable}', downstreamPassing: output },
		syntaxExamples: examples,
		tips
	};
}

PRIMITIVE_GUIDES['create_tickets'] = builtinGuide('create_tickets', 'Create Tickets', Codicon.newFile,
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
	['Create the ticket first, then run it with Run Tickets.']);

PRIMITIVE_GUIDES['run_tickets'] = builtinGuide('run_tickets', 'Run Tickets', Codicon.play,
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
	['Give the ticket template an Output component so the run returns a useful result.']);

PRIMITIVE_GUIDES['get_outputs'] = builtinGuide('get_outputs', 'Get Outputs', Codicon.signOut,
	'Reads the Output (result dictionary) of a ticket that has already run.',
	[
		{ name: 'Ticket', desc: 'Required. Ticket id or {variable} handle.' },
		{ name: 'Field', desc: 'Optional. Name of one output item; leave empty for the whole dictionary.' }
	],
	[{ step: '1. Read', detail: 'Returns the stored Output dictionary, one item of it, or nothing if the template has no Output component.' }],
	'Use the value directly in later steps.',
	['GET_OUTPUTS(ticket=new_ticket)', 'GET_OUTPUTS(ticket="TRAIN-0003", field="accuracy")'],
	['Run the ticket first; Get Outputs only reads what is already stored.']);

PRIMITIVE_GUIDES['get_tickets'] = builtinGuide('get_tickets', 'Get Tickets', Codicon.search,
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
	['For one known ticket use Get Ticket instead.']);

PRIMITIVE_GUIDES['display'] = builtinGuide('display', 'Display', Codicon.eye,
	'Shows an intermediate value in the Live Output panel while a workflow runs, for debugging or progress. It does not create a variable.',
	[{ name: 'Value', desc: 'Required. A Python expression using the current variables, e.g. train_log[-5:].' }],
	[{ step: '1. Evaluate and show', detail: 'Evaluates the expression and prints the result to Live Output.' }],
	'Nothing is passed on; it is display only.',
	['DISPLAY(train_log[-5:])'],
	['Remove or disable Display steps you no longer need.']);

PRIMITIVE_GUIDES['sub_workflow'] = builtinGuide('sub_workflow', 'Call Sub-Workflow', Codicon.layers,
	'Calls a reusable sub-workflow inside a node: passes inputs in, runs it, and hands its outputs to the next steps. Every sub-workflow is a ticket of type sub_workflow with its own ticket ID, so it can be called from the workflow it came from and from any other workflow.',
	[
		{ name: 'Sub-Workflow', desc: 'Required. The sub-workflow ticket ID (e.g. FINDJ-0042). In the editor: pick it from the Sub-Workflow Library ("+" button or drag onto a node). For AI / code: find it with GET_TICKETS(ticket_type="sub_workflow") (each result has a short inputs / outputs summary), read the full contract with GET_TICKET(id), then put the ticket ID into this step.' },
		{ name: 'Inputs', desc: 'Values for the sub-workflow Inputs, by input name; each can be an expression or a {variable}.' }
	],
	[
		{ step: '1. Resolve', detail: 'Finds the sub_workflow ticket by its ID and reads its definition (.agents/sub_workflow.json in the ticket folder). Steps saved before sub-workflows became tickets keep their old subwf_... id, which still resolves.' },
		{ step: '2. Run', detail: 'Runs the sub-workflow with the given Inputs. When the source workflow is available, its current canvas nodes are used (the source canvas is the source of truth).' },
		{ step: '3. Return outputs', detail: 'Returns the sub-workflow Output: the value itself if there is one output item, otherwise a dictionary keyed by output name.' }
	],
	'Later steps read the result from the output variable.',
	['{call_sub_workflow_result}'],
	['To create a new sub-workflow, select nodes on a workflow canvas and encapsulate them (Workflow Outline > Encapsulate Selected Nodes), or create a sub_workflow ticket from code / AI: CREATE_TICKETS(ticket_type="sub_workflow", path=<parent workflow folder>, params={"definition": {"name": ..., "nodes": [...], "links": [...], "inputs": [...], "outputs": [...]}}). It must be created inside a workflow folder; without a definition it starts empty. This component only calls existing ones.']);

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
	}, '\u2715'));
	closeBtn.onmouseenter = () => { closeBtn.style.color = '#ffffff'; closeBtn.style.background = 'rgba(255, 255, 255, 0.1)'; };
	closeBtn.onmouseleave = () => { closeBtn.style.color = 'rgba(255, 255, 255, 0.6)'; closeBtn.style.background = 'transparent'; };

	const targetDocument = container.ownerDocument;
	const closeModal = () => {
		overlay.remove();
		targetDocument.removeEventListener('keydown', onKeyDown);
	};

	closeBtn.onclick = closeModal;
	overlay.onclick = closeModal;

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			closeModal();
		}
	};
	targetDocument.addEventListener('keydown', onKeyDown);

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
