/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Lightweight, high-performance Python syntax highlighter based on PrismJS and VS Code Dark+ theme tokens.
 * Supports standard Python grammar (keywords, builtins, strings, comments, numbers, booleans)
 * and custom AnyAgent primitives (TICKET_CONTEXT, OUTPUT, RESULT, RETURN_VALUE, set_output).
 */

export interface IPythonHighlightOptions {
	showLineNumbers?: boolean;
	isLiveBackdrop?: boolean;
	placeholder?: string;
}

export function buildPythonLineNumbersText(code: string): string {
	const normalized = (code || '').replace(/\r\n?/g, '\n');
	const lineCount = Math.max(1, normalized.split('\n').length);
	return Array.from({ length: lineCount }, (_, i) => `${i + 1}`).join('\n');
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

const TOKEN_STYLES = {
	comment: 'color: #6a9955; font-style: italic;',
	commentBackdrop: 'color: #6a9955;',
	string: 'color: #ce9178;',
	interpolation: 'color: #38bdf8; background: rgba(56, 189, 248, 0.16); border-radius: 2px;',
	customVar: 'color: #38bdf8; font-weight: 700; background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 3px; padding: 0 4px;',
	customVarBackdrop: 'color: #38bdf8; background: rgba(56, 189, 248, 0.18); border-radius: 2px;',
	keyword: 'color: #c586c0;',
	declKeyword: 'color: #569cd6;',
	builtinType: 'color: #4ec9b0;',
	functionName: 'color: #dcdcaa;',
	number: 'color: #b5cea8;',
	decorator: 'color: #dcdcaa;'
};

const PYTHON_MASTER_REGEX_SOURCE = [
	// 1. Comments
	'(#.*$)',
	// 2. Triple-quoted strings (multiline)
	'((?:[frbuFRBU]{0,2})"""[\\s\\S]*?"""|(?:[frbuFRBU]{0,2})\'\'\'[\\s\\S]*?\'\'\')',
	// 3. Single-line strings
	'((?:[frbuFRBU]{0,2})"(?:\\\\.|[^"\\r\\n])*"|(?:[frbuFRBU]{0,2})\'(?:\\\\.|[^\'\\r\\n])*\')',
	// 4. Template interpolation {{variable}}
	'(\\{\\{[^{}\\r\\n]+\\}\\})',
	// 5. Custom AnyAgent primitives
	'(\\b(?:TICKET_CONTEXT|ANY_AGENT_CONTEXT|OUTPUT|RESULT|RETURN_VALUE|set_output|CREATE_TICKETS|RUN_TICKETS|GET_OUTPUTS|GET_TICKETS|GET_PRIMITIVES_CATALOG|DISPLAY|PRINT)\\b)',
	// 6. Control-flow & module keywords (purple in VS Code Dark+)
	'(\\b(?:return|if|elif|else|for|while|try|except|finally|with|as|import|from|yield|pass|break|continue|raise|del|assert|match|case)\\b)',
	// 7. Declaration/operator keywords, booleans & self/cls (blue in VS Code Dark+)
	'(\\b(?:def|class|lambda|async|await|in|is|not|and|or|global|nonlocal|True|False|None|self|cls)\\b)',
	// 8. Built-in types, exceptions & standard library modules (teal in VS Code Dark+)
	'(\\b(?:int|str|float|bool|list|dict|set|tuple|bytes|bytearray|object|type|Exception|BaseException|ValueError|TypeError|KeyError|IndexError|RuntimeError|AttributeError|FileNotFoundError|ZeroDivisionError|StopIteration|sys|os|json|time|datetime|math|re|pathlib|sqlite3|subprocess|shutil|collections|itertools|functools|typing| traceback|urllib|requests)\\b)',
	// 9. Built-in functions & any function/method call identifier before '(' (yellow in VS Code Dark+)
	'(\\b(?:print|len|range|open|dir|enumerate|zip|map|filter|sorted|reversed|sum|min|max|abs|round|any|all|getattr|setattr|hasattr|isinstance|issubclass|super|repr|format|id|hash|next|iter|input|exit)\\b|\\b[a-zA-Z_]\\w*(?=\\s*\\())',
	// 10. Numbers
	'(\\b0[xX][0-9a-fA-F_]+\\b|\\b0[bB][01_]+\\b|\\b0[oO][0-7_]+\\b|\\b\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?[\\d_]+)?\\b)',
	// 11. Decorators
	'(@[a-zA-Z_]\\w*)'
].join('|');

function resolveTokenStyle(match: RegExpExecArray, isLiveBackdrop: boolean): { style: string; val: string } {
	if (match[1]) {
		return { style: isLiveBackdrop ? TOKEN_STYLES.commentBackdrop : TOKEN_STYLES.comment, val: match[1] };
	} else if (match[2]) {
		return { style: TOKEN_STYLES.string, val: match[2] };
	} else if (match[3]) {
		return { style: TOKEN_STYLES.string, val: match[3] };
	} else if (match[4]) {
		return { style: TOKEN_STYLES.interpolation, val: match[4] };
	} else if (match[5]) {
		return { style: isLiveBackdrop ? TOKEN_STYLES.customVarBackdrop : TOKEN_STYLES.customVar, val: match[5] };
	} else if (match[6]) {
		return { style: TOKEN_STYLES.keyword, val: match[6] };
	} else if (match[7]) {
		return { style: TOKEN_STYLES.declKeyword, val: match[7] };
	} else if (match[8]) {
		return { style: TOKEN_STYLES.builtinType, val: match[8] };
	} else if (match[9]) {
		return { style: TOKEN_STYLES.functionName, val: match[9] };
	} else if (match[10]) {
		return { style: TOKEN_STYLES.number, val: match[10] };
	} else if (match[11]) {
		return { style: TOKEN_STYLES.decorator, val: match[11] };
	}
	return { style: '', val: match[0] || '' };
}

export function highlightPythonToHTML(code: string, options: IPythonHighlightOptions = {}): string {
	const isLiveBackdrop = Boolean(options.isLiveBackdrop);
	const noSelectStyle = isLiveBackdrop ? ' user-select: none; -webkit-user-select: none; pointer-events: none;' : '';
	code = (code || '').replace(/\r\n?/g, '\n');
	if (!code) {
		const placeholderText = options.placeholder || '# Enter Python automation script...';
		return `<span style="color: rgba(255, 255, 255, 0.3); font-style: italic;${noSelectStyle}">${escapeHtml(placeholderText)}</span>`;
	}

	const masterRegex = new RegExp(PYTHON_MASTER_REGEX_SOURCE, 'gm');

	let html = '';
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = masterRegex.exec(code)) !== null) {
		const matchStart = match.index;
		const matchEnd = masterRegex.lastIndex;

		if (matchStart > lastIndex) {
			html += escapeHtml(code.substring(lastIndex, matchStart));
		}

		const { style, val } = resolveTokenStyle(match, isLiveBackdrop);
		if (style && val) {
			html += `<span style="${style}${noSelectStyle}">${escapeHtml(val)}</span>`;
		} else {
			html += escapeHtml(val);
		}

		lastIndex = matchEnd;
	}

	if (lastIndex < code.length) {
		html += escapeHtml(code.substring(lastIndex));
	}

	if (isLiveBackdrop && code.endsWith('\n')) {
		html += ' ';
	}

	if (options.showLineNumbers) {
		const lines = code.split('\n');
		const lineCount = lines.length;
		const lineNumbersHtml = Array.from({ length: lineCount }, (_, i) => `${i + 1}`).join('<br>');
		return `
<div style="display: flex; gap: 0; min-height: 100%;">
	<div style="user-select: none; -webkit-user-select: none; opacity: 0.35; text-align: right; padding: 0 10px 0 0; border-right: 1px solid rgba(255, 255, 255, 0.08); margin-right: 10px; font-variant-numeric: tabular-nums; line-height: 1.5; font-size: 11px;">${lineNumbersHtml}</div>
	<div style="flex: 1; overflow-x: auto; line-height: 1.5;">${html}</div>
</div>`;
	}

	return html;
}

/**
 * Pure DOM rendering method for Python syntax highlighting.
 * Directly appends text nodes and styled spans without using innerHTML,
 * completely immune to TrustedHTML policy restrictions and XSS risks.
 */
export function renderHighlightedPythonToDOM(container: HTMLElement, code: string, options: IPythonHighlightOptions = {}): void {
	const isLiveBackdrop = Boolean(options.isLiveBackdrop);
	if (isLiveBackdrop) {
		container.style.userSelect = 'none';
		(container.style as any).webkitUserSelect = 'none';
		container.style.pointerEvents = 'none';
	}
	code = (code || '').replace(/\r\n?/g, '\n');
	container.textContent = '';

	if (!code) {
		const emptySpan = document.createElement('span');
		emptySpan.style.cssText = 'color: rgba(255, 255, 255, 0.3); font-style: italic;' + (isLiveBackdrop ? ' user-select: none; -webkit-user-select: none; pointer-events: none;' : '');
		emptySpan.textContent = options.placeholder || '# Enter Python automation script...';
		container.appendChild(emptySpan);
		return;
	}

	let targetContent: HTMLElement = container;
	let rootDiv: HTMLElement | null = null;

	if (options.showLineNumbers) {
		rootDiv = document.createElement('div');
		rootDiv.style.cssText = 'display: flex; gap: 0; min-height: 100%;';

		const lines = code.split('\n');
		const gutter = document.createElement('div');
		gutter.style.cssText = 'user-select: none; -webkit-user-select: none; opacity: 0.35; text-align: right; padding: 0 10px 0 0; border-right: 1px solid rgba(255, 255, 255, 0.08); margin-right: 10px; font-variant-numeric: tabular-nums; line-height: 1.5; font-size: 11px; white-space: pre;';
		gutter.textContent = Array.from({ length: lines.length }, (_, i) => `${i + 1}`).join('\n');
		rootDiv.appendChild(gutter);

		const contentDiv = document.createElement('div');
		contentDiv.style.cssText = 'flex: 1; overflow-x: auto; line-height: 1.5; white-space: pre-wrap; word-break: break-word;';
		rootDiv.appendChild(contentDiv);
		targetContent = contentDiv;
	}

	const masterRegex = new RegExp(PYTHON_MASTER_REGEX_SOURCE, 'gm');

	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = masterRegex.exec(code)) !== null) {
		const matchStart = match.index;
		const matchEnd = masterRegex.lastIndex;

		if (matchStart > lastIndex) {
			targetContent.appendChild(document.createTextNode(code.substring(lastIndex, matchStart)));
		}

		const { style, val } = resolveTokenStyle(match, isLiveBackdrop);
		if (style && val) {
			const span = document.createElement('span');
			span.style.cssText = style + (isLiveBackdrop ? ' user-select: none; -webkit-user-select: none; pointer-events: none;' : '');
			span.textContent = val;
			targetContent.appendChild(span);
		} else if (val) {
			targetContent.appendChild(document.createTextNode(val));
		}

		lastIndex = matchEnd;
	}

	if (lastIndex < code.length) {
		targetContent.appendChild(document.createTextNode(code.substring(lastIndex)));
	}

	if (isLiveBackdrop && code.endsWith('\n')) {
		targetContent.appendChild(document.createTextNode(' '));
	}

	if (rootDiv) {
		container.appendChild(rootDiv);
	}
}
