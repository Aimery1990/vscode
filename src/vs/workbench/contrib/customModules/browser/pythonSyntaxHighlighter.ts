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
	string: 'color: #ce9178;',
	customVar: 'color: #38bdf8; font-weight: 700; background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 3px; padding: 0 4px;',
	keyword: 'color: #c586c0; font-weight: 600;',
	builtin: 'color: #4ec9b0;',
	boolean: 'color: #569cd6; font-weight: 600;',
	number: 'color: #b5cea8;',
	functionName: 'color: #dcdcaa; font-weight: 600;',
	decorator: 'color: #dcdcaa;'
};

export function highlightPythonToHTML(code: string, options: IPythonHighlightOptions = {}): string {
	if (!code) {
		return '<span style="color: rgba(255, 255, 255, 0.3); font-style: italic;"># No Python code specified</span>';
	}

	// Master regular expression covering Python tokens in priority order
	const masterRegex = new RegExp([
		// 1. Comments
		'(#.*$)',
		// 2. Triple-quoted strings (multiline)
		'((?:[frbFRB]{0,2})"""[\\s\\S]*?"""|(?:[frbFRB]{0,2})\'\'\'[\\s\\S]*?\'\'\')',
		// 3. Single-line strings
		'((?:[frbFRB]{0,2})"(?:\\\\.|[^"\\r\\n])*"|(?:[frbFRB]{0,2})\'(?:\\\\.|[^\'\\r\\n])*\')',
		// 4. Custom AnyAgent primitives
		'(\\b(?:TICKET_CONTEXT|OUTPUT|RESULT|RETURN_VALUE|set_output)\\b)',
		// 5. Python keywords
		'(\\b(?:def|class|return|if|elif|else|for|while|try|except|finally|with|as|import|from|in|is|not|and|or|lambda|yield|pass|break|continue|raise|global|nonlocal|async|await|del|assert)\\b)',
		// 6. Python booleans and None
		'(\\b(?:True|False|None)\\b)',
		// 7. Built-in functions and standard libraries
		'(\\b(?:print|len|range|str|int|dict|list|set|tuple|bool|float|open|type|dir|enumerate|zip|isinstance|issubclass|Exception|BaseException|ValueError|TypeError|KeyError|IndexError|exit|sys|os|json|time|math|re)\\b)',
		// 8. Numbers
		'(\\b0[xX][0-9a-fA-F]+\\b|\\b0[bB][01]+\\b|\\b0[oO][0-7]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)',
		// 9. Decorators
		'(@[a-zA-Z_]\\w*)'
	].join('|'), 'gm');

	let html = '';
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = masterRegex.exec(code)) !== null) {
		const matchStart = match.index;
		const matchEnd = masterRegex.lastIndex;

		// Text before match
		if (matchStart > lastIndex) {
			html += escapeHtml(code.substring(lastIndex, matchStart));
		}

		if (match[1]) {
			// Comment
			html += `<span style="${TOKEN_STYLES.comment}">${escapeHtml(match[1])}</span>`;
		} else if (match[2]) {
			// Triple-quoted string
			html += `<span style="${TOKEN_STYLES.string}">${escapeHtml(match[2])}</span>`;
		} else if (match[3]) {
			// Single-line string
			html += `<span style="${TOKEN_STYLES.string}">${escapeHtml(match[3])}</span>`;
		} else if (match[4]) {
			// Custom AnyAgent Primitive
			html += `<span style="${TOKEN_STYLES.customVar}">${escapeHtml(match[4])}</span>`;
		} else if (match[5]) {
			// Python keyword
			html += `<span style="${TOKEN_STYLES.keyword}">${escapeHtml(match[5])}</span>`;
		} else if (match[6]) {
			// Boolean / None
			html += `<span style="${TOKEN_STYLES.boolean}">${escapeHtml(match[6])}</span>`;
		} else if (match[7]) {
			// Builtin
			html += `<span style="${TOKEN_STYLES.builtin}">${escapeHtml(match[7])}</span>`;
		} else if (match[8]) {
			// Number
			html += `<span style="${TOKEN_STYLES.number}">${escapeHtml(match[8])}</span>`;
		} else if (match[9]) {
			// Decorator
			html += `<span style="${TOKEN_STYLES.decorator}">${escapeHtml(match[9])}</span>`;
		}

		lastIndex = matchEnd;
	}

	// Remaining text
	if (lastIndex < code.length) {
		html += escapeHtml(code.substring(lastIndex));
	}

	if (options.showLineNumbers) {
		const lines = code.split('\n');
		const lineCount = lines.length;
		const lineNumbersHtml = Array.from({ length: lineCount }, (_, i) => `${i + 1}`).join('<br>');
		return `
<div style="display: flex; gap: 0; min-height: 100%;">
	<div style="user-select: none; opacity: 0.35; text-align: right; padding: 0 10px 0 0; border-right: 1px solid rgba(255, 255, 255, 0.08); margin-right: 10px; font-variant-numeric: tabular-nums; line-height: 1.5; font-size: 11px;">${lineNumbersHtml}</div>
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
	container.textContent = '';

	if (!code) {
		const emptySpan = document.createElement('span');
		emptySpan.style.cssText = 'color: rgba(255, 255, 255, 0.3); font-style: italic;';
		emptySpan.textContent = '# No Python code specified';
		container.appendChild(emptySpan);
		return;
	}

	const rootDiv = document.createElement('div');
	rootDiv.style.cssText = 'display: flex; gap: 0; min-height: 100%;';

	let targetContent: HTMLElement = rootDiv;

	if (options.showLineNumbers) {
		const lines = code.split('\n');
		const gutter = document.createElement('div');
		gutter.style.cssText = 'user-select: none; opacity: 0.35; text-align: right; padding: 0 10px 0 0; border-right: 1px solid rgba(255, 255, 255, 0.08); margin-right: 10px; font-variant-numeric: tabular-nums; line-height: 1.5; font-size: 11px; white-space: pre;';
		gutter.textContent = Array.from({ length: lines.length }, (_, i) => `${i + 1}`).join('\n');
		rootDiv.appendChild(gutter);

		const contentDiv = document.createElement('div');
		contentDiv.style.cssText = 'flex: 1; overflow-x: auto; line-height: 1.5; white-space: pre-wrap; word-break: break-word;';
		rootDiv.appendChild(contentDiv);
		targetContent = contentDiv;
	}

	const masterRegex = new RegExp([
		'(#.*$)',
		'((?:[frbFRB]{0,2})"""[\\s\\S]*?"""|(?:[frbFRB]{0,2})\'\'\'[\\s\\S]*?\'\'\')',
		'((?:[frbFRB]{0,2})"(?:\\\\.|[^"\\r\\n])*"|(?:[frbFRB]{0,2})\'(?:\\\\.|[^\'\\r\\n])*\')',
		'(\\b(?:TICKET_CONTEXT|OUTPUT|RESULT|RETURN_VALUE|set_output)\\b)',
		'(\\b(?:def|class|return|if|elif|else|for|while|try|except|finally|with|as|import|from|in|is|not|and|or|lambda|yield|pass|break|continue|raise|global|nonlocal|async|await|del|assert)\\b)',
		'(\\b(?:True|False|None)\\b)',
		'(\\b(?:print|len|range|str|int|dict|list|set|tuple|bool|float|open|type|dir|enumerate|zip|isinstance|issubclass|Exception|BaseException|ValueError|TypeError|KeyError|IndexError|exit|sys|os|json|time|math|re)\\b)',
		'(\\b0[xX][0-9a-fA-F]+\\b|\\b0[bB][01]+\\b|\\b0[oO][0-7]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)',
		'(@[a-zA-Z_]\\w*)'
	].join('|'), 'gm');

	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = masterRegex.exec(code)) !== null) {
		const matchStart = match.index;
		const matchEnd = masterRegex.lastIndex;

		if (matchStart > lastIndex) {
			targetContent.appendChild(document.createTextNode(code.substring(lastIndex, matchStart)));
		}

		let style = '';
		let val = '';
		if (match[1]) {
			style = TOKEN_STYLES.comment;
			val = match[1];
		} else if (match[2]) {
			style = TOKEN_STYLES.string;
			val = match[2];
		} else if (match[3]) {
			style = TOKEN_STYLES.string;
			val = match[3];
		} else if (match[4]) {
			style = TOKEN_STYLES.customVar;
			val = match[4];
		} else if (match[5]) {
			style = TOKEN_STYLES.keyword;
			val = match[5];
		} else if (match[6]) {
			style = TOKEN_STYLES.boolean;
			val = match[6];
		} else if (match[7]) {
			style = TOKEN_STYLES.builtin;
			val = match[7];
		} else if (match[8]) {
			style = TOKEN_STYLES.number;
			val = match[8];
		} else if (match[9]) {
			style = TOKEN_STYLES.decorator;
			val = match[9];
		}

		if (style && val) {
			const span = document.createElement('span');
			span.style.cssText = style;
			span.textContent = val;
			targetContent.appendChild(span);
		}

		lastIndex = matchEnd;
	}

	if (lastIndex < code.length) {
		targetContent.appendChild(document.createTextNode(code.substring(lastIndex)));
	}

	container.appendChild(rootDiv);
}
