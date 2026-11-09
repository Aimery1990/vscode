/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEntityPersistenceService } from '../../entityPersistence/common/entityPersistence.js';
import { IWorkflowExecutionService, IWorkflowDisplayCard, IWorkflowDisplayOutputItem, ITicketHandleInfo, INotebookCellExecutionResult } from '../common/workflowExecutionService.js';
import { ITicketWorkflowRuntimeService } from './ticketWorkflowRuntime.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import {
	IWorkflowEngineOptions,
	IWorkflowExecutionRun,
	IWorkflowLogEntry,
	IWorkflowNodeExecutionState,
	IWorkflowPathStep,
	IWorkflowNodeOperation,
	IWorkflowStepTransition
} from '../common/workflowExecutionModel.js';

interface INodePipelineStep {
	id: string;
	type: 'run_ticket' | 'set_variable' | 'custom_code' | 'call_function';
	ticketName?: string;
	ticketType?: string;
	ticketUri?: string;
	targetVariable?: string;
	expression?: string;
	functionName?: string;
	label?: string;
	parameters?: string;
}

interface IFlowchartNode {
	id: string;
	groupId?: string;
	type: 'rect' | 'round-rect' | 'diamond' | 'circle';
	x: number;
	y: number;
	width: number;
	height: number;
	label: string;
	imports?: { type: string; name: string; uri?: string }[];
	outputVariable?: { name: string; initialValue?: string; expression?: string; currentValue?: any };
	outputVariables?: { name: string; initialValue?: string; expression?: string; currentValue?: any }[];
	pipeline?: INodePipelineStep[];
}

interface IFlowchartLink {
	id: string;
	from: string;
	to: string;
	label?: string;
	condition?: string;
	style?: string;
	routing?: string;
	color?: string;
}

interface IFlowchartData {
	nodes: IFlowchartNode[];
	links: IFlowchartLink[];
	pythonPath?: string;
}

class PythonExpressionEvaluator {
	private pos = 0;
	private tokens: string[] = [];
	private context: Record<string, any>;
	private rawExpr: string;

	constructor(expr: string, context: Record<string, any>) {
		this.rawExpr = expr || '';
		this.context = context || {};
		this.tokens = this.tokenize(expr);
		this.pos = 0;
	}

	public static interpolateString(raw: string, context: Record<string, any>): string {
		if (!raw || !context) return raw;
		let result = raw;

		// 1. Interpolate {{expr}}, ${expr}, or {expr}
		if (result.includes('{')) {
			result = result.replace(/\{\{([^{}]+)\}\}|\$\{([^{}]+)\}|\{([^{}]+)\}/g, (match, g1, g2, g3) => {
				const expr = (g1 ?? g2 ?? g3 ?? '').trim();
				if (!expr) return match;
				const cleanVar = expr.replace(/^@/, '').trim();
				if (Object.prototype.hasOwnProperty.call(context, cleanVar) && context[cleanVar] !== undefined) {
					const v = context[cleanVar];
					return v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
				}
				if (Object.prototype.hasOwnProperty.call(context, `@${cleanVar}`) && context[`@${cleanVar}`] !== undefined) {
					const v = context[`@${cleanVar}`];
					return v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
				}
				try {
					const evalr = new PythonExpressionEvaluator(expr, context);
					const val = evalr.evaluate();
					if (val !== undefined) {
						return val === null ? '' : (typeof val === 'object' ? JSON.stringify(val) : String(val));
					}
				} catch {
					// Keep original placeholder if not a valid expression/variable
				}
				return match;
			});
		}

		// 2. Interpolate @varName inside string literals when varName exists in context (e.g. "Task @start" or "Task_@start")
		if (result.includes('@')) {
			result = result.replace(/(^|[^a-zA-Z0-9_.])@([a-zA-Z_\u4e00-\u9fa5][a-zA-Z0-9_\u4e00-\u9fa5]*)/g, (match, prefix, varName) => {
				if (Object.prototype.hasOwnProperty.call(context, varName) && context[varName] !== undefined) {
					const v = context[varName];
					return `${prefix}${v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v))}`;
				}
				if (Object.prototype.hasOwnProperty.call(context, `@${varName}`) && context[`@${varName}`] !== undefined) {
					const v = context[`@${varName}`];
					return `${prefix}${v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v))}`;
				}
				return match;
			});
		}

		return result;
	}

	private tokenize(expr: string): string[] {
		const tokens: string[] = [];
		let i = 0;
		let s = expr.trim();
		if (s.startsWith('=')) {
			s = s.substring(1).trim();
		}

		while (i < s.length) {
			const ch = s[i];
			if (/\s/.test(ch)) {
				i++;
				continue;
			}
			// Python f-strings: f'...' or f"..."
			if ((ch === 'f' || ch === 'F') && i + 1 < s.length && (s[i + 1] === "'" || s[i + 1] === '"')) {
				i++; // consume 'f' prefix and fall through to quoted string
			}
			// Quoted strings: '...' or "..."
			if (s[i] === "'" || s[i] === '"') {
				const quote = s[i];
				let str = '';
				i++;
				while (i < s.length && s[i] !== quote) {
					if (s[i] === '\\' && i + 1 < s.length) {
						i++;
						str += s[i];
					} else {
						str += s[i];
					}
					i++;
				}
				if (i < s.length) i++; // consume closing quote
				tokens.push(quote + str + quote);
				continue;
			}

			// Strip leading @ outside strings before identifiers / ticket IDs
			if (ch === '@' && i + 1 < s.length && /[a-zA-Z0-9_\u4e00-\u9fa5]/.test(s[i + 1])) {
				i++;
				continue;
			}

			// Multi-char operators: ==, !=, <=, >=, //, **, +=, -=, *=, /=
			const two = s.slice(i, i + 2);
			if (['==', '!=', '<=', '>=', '//', '**', '+=', '-=', '*=', '/='].includes(two)) {
				tokens.push(two);
				i += 2;
				continue;
			}

			// Atomic ticket identifier: e.g. FNDJ1-0008, TASK-123 (alphanumeric with hyphen)
			// Checked BEFORE single '-' operator so hyphen is not treated as minus!
			const ticketMatch = s.slice(i).match(/^[a-zA-Z0-9_]+-[a-zA-Z0-9_\-]+/);
			if (ticketMatch) {
				tokens.push(ticketMatch[0]);
				i += ticketMatch[0].length;
				continue;
			}

			// Single-char operators and punctuation
			if (['+', '-', '*', '/', '%', '(', ')', '<', '>', '=', '!', ',', ':', '[', ']', '{', '}'].includes(ch)) {
				tokens.push(ch);
				i++;
				continue;
			}

			// Dot operator (when not part of a floating-point number like 3.14)
			if (ch === '.' && !(i > 0 && /\d/.test(s[i - 1]) && i + 1 < s.length && /\d/.test(s[i + 1]))) {
				tokens.push('.');
				i++;
				continue;
			}

			// Identifiers, numbers, or keywords
			let word = '';
			while (i < s.length && !/\s|[()+\-*/%<>=!,'":\[\]{}.]/.test(s[i])) {
				word += s[i];
				i++;
			}
			// Allow decimal numbers like 3.14
			if (word && /^\d+$/.test(word) && i < s.length && s[i] === '.' && i + 1 < s.length && /\d/.test(s[i + 1])) {
				word += '.';
				i++;
				while (i < s.length && /\d/.test(s[i])) {
					word += s[i];
					i++;
				}
			}
			if (word) {
				tokens.push(word);
			} else {
				// Guaranteed safety fallback: consume single character so i ALWAYS advances
				tokens.push(s[i]);
				i++;
			}
		}
		return tokens;
	}

	public evaluate(): any {
		if (this.tokens.length === 0) return undefined;
		const res = this.parseOr();
		if (this.pos < this.tokens.length) {
			throw new Error(`SyntaxError: invalid syntax near '${this.tokens[this.pos]}'`);
		}
		return res;
	}

	private peek(): string | undefined {
		return this.tokens[this.pos];
	}

	private consume(expected?: string): string {
		const token = this.tokens[this.pos];
		if (expected && token !== expected) {
			throw new Error(`SyntaxError: expected '${expected}', got '${token || 'EOF'}'`);
		}
		this.pos++;
		return token;
	}

	// Level 1: or
	private parseOr(): any {
		let left = this.parseAnd();
		while (this.peek() === 'or') {
			this.consume('or');
			const right = this.parseAnd();
			left = Boolean(left) ? left : right;
		}
		return left;
	}

	// Level 2: and
	private parseAnd(): any {
		let left = this.parseNot();
		while (this.peek() === 'and') {
			this.consume('and');
			const right = this.parseNot();
			left = Boolean(left) ? right : left;
		}
		return left;
	}

	// Level 3: not
	private parseNot(): any {
		if (this.peek() === 'not') {
			this.consume('not');
			return !this.parseNot();
		}
		return this.parseComparison();
	}

	// Level 4: comparisons (==, !=, <, <=, >, >=, is, is not, in)
	private parseComparison(): any {
		let left = this.parseAddSub();

		const op = this.peek();
		if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
			this.consume();
			const right = this.parseAddSub();
			if (op === '==') return left === right;
			if (op === '!=') return left !== right;
			if (op === '<') return left < right;
			if (op === '<=') return left <= right;
			if (op === '>') return left > right;
			if (op === '>=') return left >= right;
		} else if (op === 'is') {
			this.consume('is');
			if (this.peek() === 'not') {
				this.consume('not');
				const right = this.parseAddSub();
				return left !== right;
			} else {
				const right = this.parseAddSub();
				return left === right;
			}
		} else if (op === 'in') {
			this.consume('in');
			const right = this.parseAddSub();
			if (typeof right === 'string' || Array.isArray(right)) {
				return right.includes(left);
			}
			if (right && typeof right === 'object') {
				return left in right;
			}
			return false;
		}

		return left;
	}

	// Level 5: +, -
	private parseAddSub(): any {
		let left = this.parseMulDiv();
		while (this.peek() === '+' || this.peek() === '-') {
			const op = this.consume();
			const right = this.parseMulDiv();

			if (op === '+') {
				if (typeof left === 'number' && typeof right === 'number') {
					left = left + right;
				} else if (Array.isArray(left) && Array.isArray(right)) {
					left = [...left, ...right];
				} else if (typeof left === 'string' || typeof right === 'string') {
					left = String(left ?? '') + String(right ?? '');
				} else {
					left = (left as any) + (right as any);
				}
			} else if (op === '-') {
				if (typeof left === 'number' && typeof right === 'number') {
					left = left - right;
				} else {
					throw new Error(`TypeError: unsupported operand type(s) for -: '${typeof left}' and '${typeof right}'`);
				}
			}
		}
		return left;
	}

	// Level 6: *, /, //, %
	private parseMulDiv(): any {
		let left = this.parsePower();
		while (this.peek() === '*' || this.peek() === '/' || this.peek() === '//' || this.peek() === '%') {
			const op = this.consume();
			const right = this.parsePower();

			if (op === '*') {
				if (typeof left === 'number' && typeof right === 'number') {
					left = left * right;
				} else if (typeof left === 'string' && typeof right === 'number') {
					left = left.repeat(Math.max(0, Math.floor(right)));
				} else if (typeof left === 'number' && typeof right === 'string') {
					left = right.repeat(Math.max(0, Math.floor(left)));
				} else if (Array.isArray(left) && typeof right === 'number') {
					const count = Math.max(0, Math.floor(right));
					const repeated: any[] = [];
					for (let c = 0; c < count; c++) repeated.push(...left);
					left = repeated;
				} else if (typeof left === 'number' && Array.isArray(right)) {
					const count = Math.max(0, Math.floor(left));
					const repeated: any[] = [];
					for (let c = 0; c < count; c++) repeated.push(...right);
					left = repeated;
				} else {
					throw new Error(`TypeError: unsupported operand type(s) for *: '${typeof left}' and '${typeof right}'`);
				}
			} else if (op === '/') {
				if (typeof left === 'number' && typeof right === 'number') {
					if (right === 0) throw new Error('ZeroDivisionError: division by zero');
					left = left / right;
				} else {
					throw new Error(`TypeError: unsupported operand type(s) for /: '${typeof left}' and '${typeof right}'`);
				}
			} else if (op === '//') {
				if (typeof left === 'number' && typeof right === 'number') {
					if (right === 0) throw new Error('ZeroDivisionError: integer division by zero');
					left = Math.floor(left / right);
				} else {
					throw new Error(`TypeError: unsupported operand type(s) for //: '${typeof left}' and '${typeof right}'`);
				}
			} else if (op === '%') {
				if (typeof left === 'number' && typeof right === 'number') {
					if (right === 0) throw new Error('ZeroDivisionError: integer modulo by zero');
					left = left % right;
				} else {
					throw new Error(`TypeError: unsupported operand type(s) for %: '${typeof left}' and '${typeof right}'`);
				}
			}
		}
		return left;
	}

	// Level 7: **
	private parsePower(): any {
		let left = this.parseUnary();
		if (this.peek() === '**') {
			this.consume('**');
			const right = this.parsePower(); // right-associative in Python!
			if (typeof left === 'number' && typeof right === 'number') {
				return Math.pow(left, right);
			}
			throw new Error(`TypeError: unsupported operand type(s) for **: '${typeof left}' and '${typeof right}'`);
		}
		return left;
	}

	// Level 8: Unary +, -
	private parseUnary(): any {
		if (this.peek() === '+') {
			this.consume('+');
			const val = this.parseUnary();
			return +val;
		}
		if (this.peek() === '-') {
			this.consume('-');
			const val = this.parseUnary();
			return -val;
		}
		return this.parsePostfix();
	}

	// Level 8.5: Postfix subscript a["b"] / a[0] / a[1:3] and dot access / method call a.b / a.get("b")
	private parsePostfix(): any {
		let val = this.parsePrimary();
		while (this.peek() === '[' || this.peek() === '.') {
			if (this.peek() === '[') {
				this.consume('[');
				// Check for Python slice syntax: a[start:end] / a[:end] / a[start:]
				if (this.peek() === ':') {
					this.consume(':');
					const endIdx = this.peek() !== ']' ? Number(this.parseOr()) : undefined;
					this.consume(']');
					if (Array.isArray(val) || typeof val === 'string') {
						val = val.slice(0, endIdx);
					} else {
						val = undefined;
					}
				} else {
					const idxKey = this.parseOr();
					if (this.peek() === ':') {
						this.consume(':');
						const endIdx = this.peek() !== ']' ? Number(this.parseOr()) : undefined;
						this.consume(']');
						if (Array.isArray(val) || typeof val === 'string') {
							val = val.slice(Number(idxKey), endIdx);
						} else {
							val = undefined;
						}
					} else {
						this.consume(']');
						if (val !== undefined && val !== null) {
							if ((Array.isArray(val) || typeof val === 'string') && typeof idxKey === 'number' && idxKey < 0) {
								val = val[val.length + idxKey];
							} else if (typeof val === 'object' && !Array.isArray(val) && typeof idxKey === 'string') {
								if (idxKey in val) {
									val = val[idxKey];
								} else {
									const normKey = idxKey.trim().toLowerCase().replace(/_/g, ' ');
									const keys = Object.keys(val);
									const exactNorm = keys.find(k => k.trim().toLowerCase().replace(/_/g, ' ') === normKey);
									if (exactNorm !== undefined) {
										val = val[exactNorm];
									} else if (normKey.length >= 4) {
										const prefixMatches = keys.filter(k => {
											const kn = k.trim().toLowerCase().replace(/_/g, ' ');
											return kn.startsWith(normKey) || normKey.startsWith(kn);
										});
										val = prefixMatches.length === 1 ? val[prefixMatches[0]] : undefined;
									} else {
										val = undefined;
									}
								}
							} else {
								val = val[idxKey];
							}
						} else {
							val = undefined;
						}
					}
				}
			} else if (this.peek() === '.') {
				this.consume('.');
				const prop = this.consume();
				if (this.peek() === '(') {
					this.consume('(');
					const mArgs: any[] = [];
					if (this.peek() !== ')') {
						mArgs.push(this.parseOr());
						while (this.peek() === ',') {
							this.consume(',');
							if (this.peek() === ')') break;
							mArgs.push(this.parseOr());
						}
					}
					this.consume(')');
					if (val !== undefined && val !== null && prop) {
						if (Array.isArray(val)) {
							if (prop === 'append') { val.push(mArgs[0]); }
							else if (prop === 'extend') { if (Array.isArray(mArgs[0])) val.push(...mArgs[0]); else if (mArgs[0] !== undefined) val.push(mArgs[0]); }
							else if (prop === 'pop') { val = mArgs.length > 0 ? val.splice(Number(mArgs[0]), 1)[0] : val.pop(); }
							else if (prop === 'index') { val = val.indexOf(mArgs[0]); }
							else if (prop === 'count') { val = val.filter(x => x === mArgs[0]).length; }
							else if (prop === 'copy') { val = [...val]; }
							else if (prop === 'clear') { val.length = 0; }
							else if (typeof (val as any)[prop] === 'function') { val = (val as any)[prop](...mArgs); }
						} else if (typeof val === 'string') {
							if (prop === 'strip') { val = val.trim(); }
							else if (prop === 'lstrip') { val = val.trimStart(); }
							else if (prop === 'rstrip') { val = val.trimEnd(); }
							else if (prop === 'lower') { val = val.toLowerCase(); }
							else if (prop === 'upper') { val = val.toUpperCase(); }
							else if (prop === 'replace') { val = val.split(String(mArgs[0] ?? '')).join(String(mArgs[1] ?? '')); }
							else if (prop === 'split') { val = mArgs[0] !== undefined ? val.split(String(mArgs[0])) : val.trim().split(/\s+/); }
							else if (prop === 'startswith') { val = val.startsWith(String(mArgs[0] ?? '')); }
							else if (prop === 'endswith') { val = val.endsWith(String(mArgs[0] ?? '')); }
							else if (prop === 'join') { val = Array.isArray(mArgs[0]) ? mArgs[0].join(val) : String(mArgs[0] ?? ''); }
							else if (typeof (val as any)[prop] === 'function') { val = (val as any)[prop](...mArgs); }
						} else if (typeof val === 'object') {
							if (prop === 'get') {
								const k = String(mArgs[0] ?? '');
								val = Object.prototype.hasOwnProperty.call(val, k) ? val[k] : (mArgs.length > 1 ? mArgs[1] : null);
							}
							else if (prop === 'keys') { val = Object.keys(val); }
							else if (prop === 'values') { val = Object.values(val); }
							else if (prop === 'items') { val = Object.entries(val); }
							else if (prop === 'update') { if (mArgs[0] && typeof mArgs[0] === 'object') Object.assign(val, mArgs[0]); }
							else if (prop === 'pop') {
								const k = String(mArgs[0] ?? '');
								const out = Object.prototype.hasOwnProperty.call(val, k) ? val[k] : (mArgs.length > 1 ? mArgs[1] : null);
								delete val[k];
								val = out;
							}
							else if (prop === 'copy') { val = { ...val }; }
							else if (prop === 'clear') { for (const k of Object.keys(val)) delete val[k]; }
							else if (typeof (val as any)[prop] === 'function') { val = (val as any)[prop](...mArgs); }
						}
					} else {
						val = undefined;
					}
				} else if (val !== undefined && val !== null && prop) {
					val = val[prop];
				} else {
					val = undefined;
				}
			}
		}
		return val;
	}

	// Level 9: Primary (literal, list, dict, tuple, variable lookup, parentheses)
	private parsePrimary(): any {
		const token = this.peek();
		if (!token) {
			throw new Error('SyntaxError: unexpected end of expression');
		}

		// Parenthesized expression or Tuple literal: () or (a) or (a, b)
		if (token === '(') {
			this.consume('(');
			if (this.peek() === ')') {
				this.consume(')');
				return [];
			}
			const first = this.parseOr();
			if (this.peek() === ',') {
				const tuple: any[] = [first];
				while (this.peek() === ',') {
					this.consume(',');
					if (this.peek() === ')') break;
					tuple.push(this.parseOr());
				}
				this.consume(')');
				return tuple;
			}
			this.consume(')');
			return first;
		}

		// List literal: [] or [a, b, ...]
		if (token === '[') {
			this.consume('[');
			const arr: any[] = [];
			if (this.peek() !== ']') {
				arr.push(this.parseOr());
				while (this.peek() === ',') {
					this.consume(',');
					if (this.peek() === ']') break; // support trailing comma
					arr.push(this.parseOr());
				}
			}
			this.consume(']');
			return arr;
		}

		// Dict or Set literal: {} or {"k": v, ...} or {k: v} or {a, b}
		if (token === '{') {
			this.consume('{');
			if (this.peek() === '}') {
				this.consume('}');
				return {};
			}
			const obj: Record<string, any> = {};
			const setItems: any[] = [];
			let isDict: boolean | null = null;
			while (this.peek() && this.peek() !== '}') {
				let firstKeyOrVal: any;
				const nextTok = this.peek()!;
				if (
					this.tokens[this.pos + 1] === ':' &&
					/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(nextTok) &&
					!['True', 'False', 'None', 'true', 'false', 'null'].includes(nextTok) &&
					!(this.context && Object.prototype.hasOwnProperty.call(this.context, nextTok))
				) {
					firstKeyOrVal = this.consume();
				} else {
					firstKeyOrVal = this.parseOr();
				}

				if (this.peek() === ':') {
					isDict = true;
					this.consume(':');
					const val = this.parseOr();
					obj[String(firstKeyOrVal)] = val;
				} else {
					if (isDict === true) {
						throw new Error('SyntaxError: expected ":" in dictionary literal');
					}
					isDict = false;
					setItems.push(firstKeyOrVal);
				}

				if (this.peek() === ',') {
					this.consume(',');
					if (this.peek() === '}') break; // support trailing comma
				} else {
					break;
				}
			}
			this.consume('}');
			return isDict === false ? setItems : obj;
		}

		this.consume();

		// Assignment / mutation prefix fallback (e.g. "+= 1")
		if (token === '+=' || token === '-=') {
			const val = this.parseOr();
			return token === '+=' ? val : (typeof val === 'number' ? -val : val);
		}

		// Python literals
		if (token === 'None' || token === 'null') return null;
		if (token === 'True' || token === 'true') return true;
		if (token === 'False' || token === 'false') return false;

		// Number literal
		if (/^-?\d+(\.\d+)?$/.test(token)) {
			return Number(token);
		}

		// Quoted string literal (with automatic variable/expression interpolation)
		if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) {
			const rawContent = token.substring(1, token.length - 1);
			return PythonExpressionEvaluator.interpolateString(rawContent, this.context);
		}

		// Built-in Python helper & Date/Time operator functions:
		// list(), dict(), set(), tuple(), str(), int(), float(), bool(), len(), abs(), min(), max(), round(),
		// DATE() / TODAY(), TIME(), NOW() / DATETIME(), TIMESTAMP()
		const cleanFnName = token.replace(/^@/, '');
		const lowerFnName = cleanFnName.toLowerCase();
		if (this.peek() === '(' && [
			'list', 'dict', 'set', 'tuple',
			'str', 'int', 'float', 'bool', 'len', 'abs', 'min', 'max', 'round',
			'date', 'today', 'time', 'now', 'datetime', 'timestamp'
		].includes(lowerFnName)) {
			this.consume('(');
			const fnArgs: any[] = [];
			if (this.peek() !== ')') {
				fnArgs.push(this.parseOr());
				while (this.peek() === ',') {
					this.consume(',');
					if (this.peek() === ')') break;
					fnArgs.push(this.parseOr());
				}
			}
			this.consume(')');
			const a0 = fnArgs[0];
			if (lowerFnName === 'list' || lowerFnName === 'tuple') {
				if (fnArgs.length === 0) return [];
				if (Array.isArray(a0)) return [...a0];
				if (typeof a0 === 'string') return Array.from(a0);
				if (a0 && typeof a0 === 'object') return Object.keys(a0);
				return [a0];
			}
			if (lowerFnName === 'dict') {
				if (fnArgs.length === 0) return {};
				if (a0 && typeof a0 === 'object' && !Array.isArray(a0)) return { ...a0 };
				return {};
			}
			if (lowerFnName === 'set') {
				if (fnArgs.length === 0) return [];
				if (Array.isArray(a0)) return Array.from(new Set(a0));
				if (typeof a0 === 'string') return Array.from(new Set(Array.from(a0)));
				return [a0];
			}
			if (lowerFnName === 'date' || lowerFnName === 'today') {
				return PythonExpressionEvaluator.formatDateTime('date', typeof a0 === 'string' ? a0 : undefined);
			}
			if (lowerFnName === 'time') {
				return PythonExpressionEvaluator.formatDateTime('time', typeof a0 === 'string' ? a0 : undefined);
			}
			if (lowerFnName === 'now' || lowerFnName === 'datetime') {
				return PythonExpressionEvaluator.formatDateTime('now', typeof a0 === 'string' ? a0 : undefined);
			}
			if (lowerFnName === 'timestamp') {
				return PythonExpressionEvaluator.formatDateTime('timestamp', typeof a0 === 'string' ? a0 : undefined);
			}
			if (lowerFnName === 'str') return a0 === undefined || a0 === null ? '' : (typeof a0 === 'object' ? JSON.stringify(a0) : String(a0));
			if (lowerFnName === 'int') return parseInt(String(a0 ?? 0), 10) || 0;
			if (lowerFnName === 'float') return parseFloat(String(a0 ?? 0)) || 0;
			if (lowerFnName === 'bool') return Boolean(a0);
			if (lowerFnName === 'len') {
				if (typeof a0 === 'string' || Array.isArray(a0)) return a0.length;
				if (a0 && typeof a0 === 'object') return Object.keys(a0).length;
				return 0;
			}
			if (lowerFnName === 'abs') return Math.abs(Number(a0 ?? 0));
			if (lowerFnName === 'min') return Math.min(...fnArgs.map(Number));
			if (lowerFnName === 'max') return Math.max(...fnArgs.map(Number));
			if (lowerFnName === 'round') return Math.round(Number(a0 ?? 0));
		}

		// Identifier lookup in context (including ticket identifiers like FNDJ1-0008)
		if (/^@?[a-zA-Z0-9_]+(-[a-zA-Z0-9_]+)*$/.test(token) && !/^\d+$/.test(token)) {
			const cleanToken = token.replace(/^@/, '');
			if (this.context && Object.prototype.hasOwnProperty.call(this.context, cleanToken)) {
				return this.context[cleanToken];
			}
			const withAt = `@${cleanToken}`;
			if (this.context && Object.prototype.hasOwnProperty.call(this.context, withAt)) {
				return this.context[withAt];
			}
			const normalizedToken = cleanToken.replace(/[^a-zA-Z0-9_]/g, '_');
			if (this.context && Object.prototype.hasOwnProperty.call(this.context, normalizedToken)) {
				return this.context[normalizedToken];
			}
			if (this.context && Object.prototype.hasOwnProperty.call(this.context, `@${normalizedToken}`)) {
				return this.context[`@${normalizedToken}`];
			}
			// Built-in uppercase Date/Time constants if not shadowed by a user variable
			if (cleanToken === 'DATE' || cleanToken === 'TODAY') {
				return PythonExpressionEvaluator.formatDateTime('date');
			}
			if (cleanToken === 'TIME') {
				return PythonExpressionEvaluator.formatDateTime('time');
			}
			if (cleanToken === 'NOW' || cleanToken === 'DATETIME') {
				return PythonExpressionEvaluator.formatDateTime('now');
			}
			if (cleanToken === 'TIMESTAMP') {
				return PythonExpressionEvaluator.formatDateTime('timestamp');
			}
			// If it has a hyphen, it's a ticket or slug entity; return the entity string instead of throwing NameError
			if (cleanToken.includes('-')) {
				return cleanToken;
			}
			throw new Error(`NameError: name '${cleanToken}' is not defined in workflow context`);
		}

		// If token is an unrecognized symbol or punctuation: fail fast with SyntaxError
		throw new Error(`SyntaxError: invalid or unrecognized syntax '${token}' in expression '${this.rawExpr}'`);
	}

	public static formatDateTime(mode: 'date' | 'time' | 'now' | 'timestamp', customFormat?: string): string | number {
		const d = new Date();
		if (mode === 'timestamp') {
			return customFormat && customFormat.toLowerCase() === 'ms' ? d.getTime() : Math.floor(d.getTime() / 1000);
		}
		const YYYY = String(d.getFullYear());
		const MM = String(d.getMonth() + 1).padStart(2, '0');
		const DD = String(d.getDate()).padStart(2, '0');
		const HH = String(d.getHours()).padStart(2, '0');
		const mm = String(d.getMinutes()).padStart(2, '0');
		const ss = String(d.getSeconds()).padStart(2, '0');

		if (customFormat && customFormat.trim()) {
			return customFormat
				.replace(/%Y|YYYY/g, YYYY)
				.replace(/%m|MM/g, MM)
				.replace(/%d|DD/g, DD)
				.replace(/%H|HH/g, HH)
				.replace(/%M|mm/g, mm)
				.replace(/%S|ss/g, ss);
		}

		if (mode === 'date') {
			return `${YYYY}-${MM}-${DD}`;
		}
		if (mode === 'time') {
			return `${HH}:${mm}:${ss}`;
		}
		return `${YYYY}-${MM}-${DD} ${HH}:${mm}:${ss}`;
	}
}

export class WorkflowExecutionService implements IWorkflowExecutionService {
	readonly _serviceBrand: undefined;

	private readonly _runs = new Map<string, IWorkflowExecutionRun>();
	private readonly _activeRunsByWorkflow = new Map<string, string>();
	private readonly _humanWaiters = new Map<string, (input: any) => void>();
	private readonly _stepWaiters = new Map<string, () => void>();
	private readonly _cancelledRuns = new Set<string>();
	private readonly _persistDebounceMap = new Map<string, any>();

	private readonly _onDidChangeRunState = new Emitter<IWorkflowExecutionRun>();
	readonly onDidChangeRunState: Event<IWorkflowExecutionRun> = this._onDidChangeRunState.event;

	private readonly _onDidEmitLog = new Emitter<{ runId: string; log: IWorkflowLogEntry }>();
	readonly onDidEmitLog: Event<{ runId: string; log: IWorkflowLogEntry }> = this._onDidEmitLog.event;

	private readonly _onDidDisplayVariable = new Emitter<IWorkflowDisplayCard>();
	readonly onDidDisplayVariable: Event<IWorkflowDisplayCard> = this._onDidDisplayVariable.event;

	private readonly _onDidUpdateNodeComponents = new Emitter<{ workflowUri: string; nodeId: string; node: IFlowchartNode }>();
	readonly onDidUpdateNodeComponents: Event<{ workflowUri: string; nodeId: string; node: IFlowchartNode }> = this._onDidUpdateNodeComponents.event;

	private static readonly RESERVED_CONTEXT_ALIAS_KEYS = new Set([
		'CONTEXT',
		'@CONTEXT',
		'TICKET_CONTEXT',
		'@TICKET_CONTEXT',
		'ANY_AGENT_CONTEXT',
		'@ANY_AGENT_CONTEXT'
	]);

	constructor(
		@IEntityPersistenceService private readonly entityPersistenceService: IEntityPersistenceService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ITicketWorkflowRuntimeService private readonly ticketRuntimeService: ITicketWorkflowRuntimeService,
		@ITerminalService private readonly terminalService: ITerminalService
	) {
		this._cleanupStaleKernelDirsOnStartup().catch(() => { });
	}

	private async _cleanupStaleKernelDirsOnStartup(): Promise<void> {
		try {
			const tmpRoot = (typeof process !== 'undefined' && process.env && (process.env.TMPDIR || process.env.TEMP))
				? (process.env.TMPDIR || process.env.TEMP)!.replace(/\/+$/, '')
				: '/tmp';
			const candidateRoots = Array.from(new Set([tmpRoot, '/tmp']));
			for (const rootPath of candidateRoots) {
				try {
					const rootUri = URI.file(rootPath);
					const stat = await this.fileService.resolve(rootUri);
					if (!stat.children) continue;
					for (const child of stat.children) {
						if (child.isDirectory && child.name.startsWith('anyagent_wf_kernel_')) {
							const activeMatch = Array.from(this._pythonKernels.values()).some(
								k => k.kernelDir.fsPath === child.resource.fsPath
							);
							if (!activeMatch) {
								try {
									const cmdUri = URI.joinPath(child.resource, 'cmd.json');
									await this.fileService.writeFile(
										cmdUri,
										VSBuffer.fromString(JSON.stringify({ id: `shutdown_${Date.now()}`, action: 'shutdown' }))
									);
								} catch { }
								try {
									await this.fileService.del(child.resource, { recursive: true });
								} catch { }
							}
						}
					}
				} catch { }
			}
		} catch { }
	}

	private readonly _pythonKernels = new Map<string, {
		kernelDir: URI;
		pythonPath: string;
		terminal?: any;
		reqCounter: number;
		stopped: boolean;
		handledRpcIds: Set<string>;
	}>();

	private readonly _displayCardsByWorkflow = new Map<string, IWorkflowDisplayCard[]>();

	private _getWorkflowRunsFileUri(workflowUriStr: string): URI {
		try {
			const uri = URI.parse(workflowUriStr);
			const isFile = uri.path.endsWith('.json') || uri.path.endsWith('.workflow');
			const dirUri = isFile ? URI.joinPath(uri, '..') : uri;
			return URI.joinPath(dirUri, '.agents', 'workflow_runs.json');
		} catch {
			const homeDir = (typeof process !== 'undefined' && process.env?.HOME) ? process.env.HOME : '/Users/aimery';
			return URI.file(`${homeDir}/.anyagent/workflow_history/default_runs.json`);
		}
	}

	private _getGlobalBackupRunsFileUri(workflowUriStr: string): URI {
		const safeKey = workflowUriStr.replace(/[^a-zA-Z0-9_-]/g, '_');
		const homeDir = (typeof process !== 'undefined' && process.env?.HOME) ? process.env.HOME : '/Users/aimery';
		return URI.file(`${homeDir}/.anyagent/workflow_history/${safeKey}_runs.json`);
	}

	async loadRunsForWorkflow(workflowUri: URI | string): Promise<IWorkflowExecutionRun[]> {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		const primaryFileUri = this._getWorkflowRunsFileUri(uriStr);
		const backupFileUri = this._getGlobalBackupRunsFileUri(uriStr);

		let loadedRuns: IWorkflowExecutionRun[] = [];

		// 1. Try primary location (.agents/workflow_runs.json)
		try {
			if (await this.fileService.exists(primaryFileUri)) {
				const content = await this.fileService.readFile(primaryFileUri);
				const parsed = JSON.parse(content.value.toString());
				if (Array.isArray(parsed)) {
					loadedRuns = parsed;
				}
			}
		} catch (err) {
			this.logService.warn(`[WorkflowExecution] Failed to load runs from primary file ${primaryFileUri.toString()}:`, err);
		}

		// 2. Fallback to global backup if primary had nothing
		if (loadedRuns.length === 0) {
			try {
				if (await this.fileService.exists(backupFileUri)) {
					const content = await this.fileService.readFile(backupFileUri);
					const parsed = JSON.parse(content.value.toString());
					if (Array.isArray(parsed)) {
						loadedRuns = parsed;
					}
				}
			} catch (err) {
				// ignore backup read error
			}
		}

		if (loadedRuns.length > 0) {
			let needsPersistCleanup = false;
			for (const r of loadedRuns) {
				if (r && r.runId) {
					if (Array.isArray(r.logs)) {
						for (const l of r.logs) {
							if (l && typeof l.message === 'string' && l.message.length > 1200) {
								l.message = l.message.substring(0, 1200) + ' ... [truncated]';
							}
						}
					}
					if (r.contextVariables && typeof r.contextVariables === 'object') {
						for (const rk of WorkflowExecutionService.RESERVED_CONTEXT_ALIAS_KEYS) {
							if (rk in r.contextVariables) {
								delete r.contextVariables[rk];
								needsPersistCleanup = true;
							}
						}
					}
					const existing = this._runs.get(r.runId);
					if (!existing || existing.status !== 'running') {
						if (!existing && (r.status === 'running' || r.status === 'waiting_human' || r.status === 'paused')) {
							const lastLog = Array.isArray(r.logs) && r.logs.length > 0 ? r.logs[r.logs.length - 1] : undefined;
							if (lastLog?.message && lastLog.message.includes('executed successfully to completion')) {
								r.status = 'completed';
							} else {
								r.status = 'stopped';
							}
							r.completedAt = r.completedAt || r.updatedAt || Date.now();
							r.currentNodeId = undefined;
							needsPersistCleanup = true;
						}
						if (r.status !== 'running' && r.status !== 'waiting_human' && r.status !== 'paused') {
							if (r.currentNodeId !== undefined) {
								r.currentNodeId = undefined;
								needsPersistCleanup = true;
							}
							const targetNodeStatus = r.status === 'completed' ? 'success' : 'stopped';
							if (r.nodeStates && typeof r.nodeStates === 'object') {
								for (const ns of Object.values(r.nodeStates)) {
									if (ns && (ns.status === 'running' || ns.status === 'waiting_human')) {
										ns.status = targetNodeStatus;
										ns.completedAt = ns.completedAt || r.completedAt || r.updatedAt || Date.now();
										if (ns.startedAt && !ns.durationMs) {
											ns.durationMs = Math.max(0, ns.completedAt - ns.startedAt);
										}
										needsPersistCleanup = true;
									}
								}
							}
							if (Array.isArray(r.executionPath)) {
								for (const ps of r.executionPath) {
									if (ps && ps.status === 'running') {
										ps.status = targetNodeStatus;
										ps.completedAt = ps.completedAt || r.completedAt || r.updatedAt || Date.now();
										if (ps.startedAt && !ps.durationMs) {
											ps.durationMs = Math.max(0, ps.completedAt - ps.startedAt);
										}
										needsPersistCleanup = true;
									}
								}
							}
						}
						this._runs.set(r.runId, r);
					}
				}
			}
			if (!this._activeRunsByWorkflow.has(uriStr)) {
				const sorted = this.getRunsForWorkflow(uriStr);
				if (sorted.length > 0) {
					this._activeRunsByWorkflow.set(uriStr, sorted[0].runId);
				}
			}
			if (needsPersistCleanup) {
				this._schedulePersist(uriStr);
			}
		}

		return this.getRunsForWorkflow(uriStr);
	}

	private _summarizeValueForHistory(val: any, depth: number = 0): any {
		if (val === null || val === undefined || typeof val === 'number' || typeof val === 'boolean') {
			return val;
		}
		if (typeof val === 'string') {
			if (val.length > 1200) {
				return val.substring(0, 1200) + ` ... [truncated (${val.length} chars) in history]`;
			}
			return val;
		}
		if (Array.isArray(val)) {
			const maxItems = 3;
			if (val.length > maxItems) {
				const preview = val.slice(0, maxItems).map(item => this._summarizeValueForHistory(item, depth + 1));
				preview.push(`... (${val.length - maxItems} more items omitted in history; total ${val.length} items)`);
				return preview;
			}
			return val.map(item => this._summarizeValueForHistory(item, depth + 1));
		}
		if (typeof val === 'object') {
			if (depth >= 4) {
				return '[Object summarized in history]';
			}
			const out: Record<string, any> = {};
			const entries = Object.entries(val);
			const maxKeys = 25;
			let count = 0;
			for (const [k, v] of entries) {
				if (k === 'lastSentPayload' || k === 'pythonOutput' || k === 'lastExecutionLog' || k === 'debugSqlOutput') {
					continue;
				}
				if (count >= maxKeys) {
					out['__omittedKeys__'] = `... (${entries.length - maxKeys} more keys omitted in history)`;
					break;
				}
				out[k] = this._summarizeValueForHistory(v, depth + 1);
				count++;
			}
			return out;
		}
		return String(val);
	}

	async persistRunsForWorkflow(workflowUri: URI | string): Promise<void> {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		const runs = this.getRunsForWorkflow(uriStr).slice(0, 15).map(r => {
			const cleanVars: Record<string, any> = {};
			if (r.contextVariables) {
				for (const [k, v] of Object.entries(r.contextVariables)) {
					if (WorkflowExecutionService.RESERVED_CONTEXT_ALIAS_KEYS.has(k)) {
						continue;
					}
					if (k.startsWith('@') && k.substring(1) in r.contextVariables) {
						continue;
					}
					cleanVars[k] = this._summarizeValueForHistory(v, 0);
				}
			}
			const cleanNodeStates = r.nodeStates ? this._summarizeValueForHistory(r.nodeStates, 0) : {};
			const cleanExecutionPath = Array.isArray(r.executionPath)
				? r.executionPath.map(ps => this._summarizeValueForHistory(ps, 0))
				: [];
			const cleanLogs = (r.logs || []).map(l => ({
				...l,
				message: typeof l.message === 'string' && l.message.length > 1200
					? l.message.substring(0, 1200) + ' ... [truncated]'
					: l.message
			}));
			return {
				...r,
				contextVariables: cleanVars,
				nodeStates: cleanNodeStates,
				executionPath: cleanExecutionPath,
				logs: cleanLogs
			};
		});
		const jsonStr = JSON.stringify(runs, null, 2);
		const buffer = VSBuffer.fromString(jsonStr);

		// 1. Primary location (.agents/workflow_runs.json)
		const primaryFileUri = this._getWorkflowRunsFileUri(uriStr);
		try {
			const parentDir = URI.joinPath(primaryFileUri, '..');
			if (!(await this.fileService.exists(parentDir))) {
				await this.fileService.createFolder(parentDir);
			}
			await this.fileService.writeFile(primaryFileUri, buffer);
			this.logService.info(`[WorkflowExecution] Persisted ${runs.length} runs to ${primaryFileUri.toString()}`);
		} catch (err) {
			this.logService.warn(`[WorkflowExecution] Failed to write runs to ${primaryFileUri.toString()}:`, err);
		}

		// 2. Global backup location (~/.anyagent/workflow_history/<safeKey>_runs.json)
		const backupFileUri = this._getGlobalBackupRunsFileUri(uriStr);
		try {
			const backupParentDir = URI.joinPath(backupFileUri, '..');
			if (!(await this.fileService.exists(backupParentDir))) {
				await this.fileService.createFolder(backupParentDir);
			}
			await this.fileService.writeFile(backupFileUri, buffer);
		} catch {
			// ignore backup write failure
		}
	}

	private _schedulePersist(workflowUriStr: string): void {
		if (this._persistDebounceMap.has(workflowUriStr)) {
			clearTimeout(this._persistDebounceMap.get(workflowUriStr));
		}
		const timeout = setTimeout(() => {
			this._persistDebounceMap.delete(workflowUriStr);
			this.persistRunsForWorkflow(workflowUriStr);
		}, 600);
		this._persistDebounceMap.set(workflowUriStr, timeout);
	}

	getActiveRun(workflowUri: URI | string): IWorkflowExecutionRun | undefined {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		const runId = this._activeRunsByWorkflow.get(uriStr);
		return runId ? this._runs.get(runId) : undefined;
	}

	getRun(runId: string): IWorkflowExecutionRun | undefined {
		return this._runs.get(runId);
	}

	getRunsForWorkflow(workflowUri: URI | string): IWorkflowExecutionRun[] {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		return Array.from(this._runs.values())
			.filter(r => r.workflowUri === uriStr && r.runId)
			.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
	}

	deleteRun(runId: string): void {
		const run = this._runs.get(runId);
		this._runs.delete(runId);
		for (const [uri, id] of this._activeRunsByWorkflow.entries()) {
			if (id === runId) {
				this._activeRunsByWorkflow.delete(uri);
			}
		}
		if (run) {
			this.persistRunsForWorkflow(run.workflowUri);
			this._notifyRunChanged(run);
		}
	}

	clearRuns(workflowUri?: URI | string): void {
		if (workflowUri) {
			const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
			for (const [id, r] of this._runs.entries()) {
				if (r.workflowUri === uriStr) {
					this._runs.delete(id);
				}
			}
			this._activeRunsByWorkflow.delete(uriStr);
			this.persistRunsForWorkflow(uriStr);
		} else {
			this._runs.clear();
			this._activeRunsByWorkflow.clear();
		}
	}

	getDisplayCards(workflowUri: URI | string): IWorkflowDisplayCard[] {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		return this._displayCardsByWorkflow.get(uriStr) || [];
	}

	clearDisplayCards(workflowUri: URI | string): void {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		this._displayCardsByWorkflow.delete(uriStr);
	}

	removeDisplayCard(workflowUri: URI | string, cardId: string): void {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		const list = this._displayCardsByWorkflow.get(uriStr);
		if (list) {
			const filtered = list.filter(c => c.id !== cardId);
			if (filtered.length === 0) {
				this._displayCardsByWorkflow.delete(uriStr);
			} else {
				this._displayCardsByWorkflow.set(uriStr, filtered);
			}
		}
	}

	clearRuns(workflowUri?: URI | string): void {
		if (workflowUri) {
			const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
			for (const [id, run] of this._runs.entries()) {
				if (run.workflowUri === uriStr) {
					this._runs.delete(id);
				}
			}
			this._activeRunsByWorkflow.delete(uriStr);
		} else {
			this._runs.clear();
			this._activeRunsByWorkflow.clear();
		}
	}

	resetWorkflow(workflowUri: URI | string): void {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		const activeRunId = this._activeRunsByWorkflow.get(uriStr);
		if (activeRunId) {
			this._cancelledRuns.add(activeRunId);
			this.ticketRuntimeService.cancelAllActiveOperations('Workflow reset by user').catch(() => { });
			this._shutdownPythonKernel(activeRunId).catch(() => { });
			const stepResolve = this._stepWaiters.get(activeRunId);
			if (stepResolve) {
				this._stepWaiters.delete(activeRunId);
				stepResolve();
			}
			const humanResolve = this._humanWaiters.get(activeRunId);
			if (humanResolve) {
				this._humanWaiters.delete(activeRunId);
				humanResolve(undefined);
			}
		}
		this.clearRuns(uriStr);
		this.clearDisplayCards(uriStr);

		const idleRun: IWorkflowExecutionRun = {
			runId: '',
			workflowUri: uriStr,
			workflowName: this._resolveWorkflowName(uriStr),
			status: 'idle',
			mode: 'standard',
			currentNodeId: undefined,
			visitedNodeIds: [],
			startedAt: 0,
			updatedAt: Date.now(),
			contextVariables: {},
			nodeStates: {},
			linkStates: {},
			executionPath: [],
			logs: []
		};
		this._notifyRunChanged(idleRun);
	}

	async executeWorkflow(workflowUri: URI | string, options?: IWorkflowEngineOptions): Promise<IWorkflowExecutionRun> {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		const existingRunId = this._activeRunsByWorkflow.get(uriStr);
		const inheritedContextVariables: Record<string, any> = {};
		if (existingRunId) {
			const existing = this._runs.get(existingRunId);
			if (existing && (existing.status === 'running' || existing.status === 'waiting_human')) {
				this.logService.info(`[WorkflowExecution] Resuming already active run ${existingRunId} for ${uriStr}`);
				return existing;
			}
			if (existing && existing.status === 'paused') {
				this._cancelledRuns.add(existingRunId);
				const stepResolve = this._stepWaiters.get(existingRunId);
				if (stepResolve) {
					this._stepWaiters.delete(existingRunId);
					stepResolve();
				}
			}
			if (existing && existing.contextVariables && ((options?.selectedNodeIds && options.selectedNodeIds.length > 0) || options?.entryNodeId)) {
				for (const [k, v] of Object.entries(existing.contextVariables)) {
					if (v !== undefined && v !== 'None' && !WorkflowExecutionService.RESERVED_CONTEXT_ALIAS_KEYS.has(k)) {
						inheritedContextVariables[k] = v;
					}
				}
			}
		}

		// Clear previous execution cards when starting a fresh full workflow run
		this.clearDisplayCards(uriStr);

		const flowchartData = await this._loadFlowchartData(uriStr, options);
		if (!flowchartData || !flowchartData.nodes || flowchartData.nodes.length === 0) {
			throw new Error(`Cannot execute workflow: No flowchart nodes found for ${uriStr}`);
		}

		const runId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
		const workflowName = this._resolveWorkflowName(uriStr);

		const priorRuns = this.getRunsForWorkflow(uriStr);
		const maxRunNumber = priorRuns.reduce((max, r) => Math.max(max, r.runNumber || 0), 0);
		const runNumber = maxRunNumber + 1;

		const run: IWorkflowExecutionRun = {
			runId,
			runNumber,
			workflowUri: uriStr,
			workflowName,
			status: 'running',
			mode: options?.mode || 'standard',
			trigger: 'manual',
			currentNodeId: undefined,
			visitedNodeIds: [],
			startedAt: Date.now(),
			updatedAt: Date.now(),
			contextVariables: { ...inheritedContextVariables, ...(options?.initialInputs || {}) },
			nodeStates: {},
			linkStates: {},
			executionPath: [],
			logs: []
		};

		// Initialize all node states to pending and register output variables
		for (const node of flowchartData.nodes) {
			run.nodeStates[node.id] = {
				nodeId: node.id,
				nodeLabel: node.label,
				nodeType: node.type,
				status: 'pending',
				executedTickets: []
			};
			const nodeVars = this._getNodeVars(node);
			for (const v of nodeVars) {
				if (v.name) {
					const cleanName = v.name.replace(/^@/, '').trim();
					if (run.contextVariables[cleanName] === undefined) {
						let initStr = (v.initialValue || '').trim();
						if (/^(\+\=|\-\=|\*\=|\/\=|\+\+|\-\-)/.test(initStr)) {
							initStr = '0';
						}
						const initVal = this._resolveValue(initStr || 'None', {});
						run.contextVariables[cleanName] = initVal;
						v.currentValue = initVal;
					}
				}
			}
		}

		this._runs.set(runId, run);
		this._activeRunsByWorkflow.set(uriStr, runId);
		this._cancelledRuns.delete(runId);

		this._emitLog(run, 'info', `Workflow execution initiated: '${workflowName}' (${run.mode} mode)`);
		this._notifyRunChanged(run);

		// Execute asynchronously
		this._runWorkflowAsync(run, flowchartData, options).catch(async err => {
			if (this._cancelledRuns.has(runId) || run.status === 'stopped') {
				return;
			}
			this.logService.error(`[WorkflowExecution] Fatal error in run ${runId}:`, err);
			run.status = 'failed';
			run.error = err.message || String(err);
			run.updatedAt = Date.now();
			run.completedAt = Date.now();
			run.durationMs = run.completedAt - run.startedAt;
			if (this._persistDebounceMap.has(run.workflowUri)) {
				clearTimeout(this._persistDebounceMap.get(run.workflowUri));
				this._persistDebounceMap.delete(run.workflowUri);
			}
			this._emitLog(run, 'error', `Execution failed: ${run.error}`);
			this._notifyRunChanged(run);
			await this.persistRunsForWorkflow(run.workflowUri);
		});

		return run;
	}

	async stepWorkflow(workflowUri: URI | string, options?: IWorkflowEngineOptions, runId?: string): Promise<IWorkflowExecutionRun> {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		let targetRun = runId ? this._runs.get(runId) : this.getActiveRun(uriStr);

		// If the user explicitly selected a different unvisited entry node while a previous run was paused, start a fresh step run from that selected node
		if (
			targetRun &&
			targetRun.status === 'paused' &&
			options?.entryNodeId &&
			options.entryNodeId !== targetRun.currentNodeId &&
			!targetRun.visitedNodeIds.includes(options.entryNodeId) &&
			options?.initialData?.links
		) {
			const incomingLinks = (options.initialData.links as IFlowchartLink[]).filter(l => l.to === options.entryNodeId);
			if (incomingLinks.length === 0) {
				this._cancelledRuns.add(targetRun.runId);
				const oldWaiter = this._stepWaiters.get(targetRun.runId);
				if (oldWaiter) {
					this._stepWaiters.delete(targetRun.runId);
					oldWaiter();
				}
				targetRun = undefined;
			}
		}

		if (!targetRun || targetRun.status === 'completed' || targetRun.status === 'failed' || targetRun.status === 'stopped' || targetRun.status === 'idle') {
			targetRun = await this.executeWorkflow(uriStr, { ...options, mode: 'step' });
			return targetRun;
		}

		if (targetRun.status === 'paused') {
			targetRun.status = 'running';
			this._notifyRunChanged(targetRun);
			const stepResolve = this._stepWaiters.get(targetRun.runId);
			if (stepResolve) {
				this._stepWaiters.delete(targetRun.runId);
				stepResolve();
			}
		}

		return targetRun;
	}

	async pauseWorkflow(runId: string): Promise<void> {
		const run = this._runs.get(runId);
		if (!run || run.status !== 'running') {
			return;
		}
		run.status = 'paused';
		run.updatedAt = Date.now();
		this._emitLog(run, 'info', 'Workflow paused by user');
		this._notifyRunChanged(run);
	}

	async resumeWorkflow(runId: string, userInput?: any): Promise<void> {
		const run = this._runs.get(runId);
		if (!run) {
			return;
		}

		if (run.status === 'waiting_human') {
			const waiter = this._humanWaiters.get(runId);
			if (waiter) {
				this._humanWaiters.delete(runId);
				this._emitLog(run, 'info', `Human input received for node ${run.currentNodeId}`, userInput);
				waiter(userInput);
				return;
			}
		}

		if (run.status === 'paused') {
			run.status = 'running';
			run.updatedAt = Date.now();
			this._emitLog(run, 'info', 'Workflow resumed');
			this._notifyRunChanged(run);
			const stepResolve = this._stepWaiters.get(runId);
			if (stepResolve) {
				this._stepWaiters.delete(runId);
				stepResolve();
			}
		}
	}

	async stopWorkflow(runId: string): Promise<void> {
		const run = this._runs.get(runId);
		if (!run) {
			return;
		}
		this._cancelledRuns.add(runId);

		// Transition any running/waiting node states cleanly so canvas nodes stop pulsing immediately
		const now = Date.now();
		if (run.nodeStates) {
			for (const ns of Object.values(run.nodeStates)) {
				if (ns && (ns.status === 'running' || ns.status === 'waiting_human')) {
					ns.status = 'pending';
					ns.completedAt = now;
					ns.durationMs = now - (ns.startedAt || now);
					ns.waitingHumanPrompt = undefined;
				}
			}
		}
		if (Array.isArray(run.executionPath)) {
			for (const ps of run.executionPath) {
				if (ps && ps.status === 'running') {
					ps.status = 'failed';
					ps.error = 'Stopped by user';
					ps.completedAt = now;
					ps.durationMs = now - (ps.startedAt || now);
				}
			}
		}

		run.status = 'stopped';
		run.currentNodeId = undefined;
		run.updatedAt = now;
		run.completedAt = now;
		run.durationMs = now - run.startedAt;

		const humanWaiter = this._humanWaiters.get(runId);
		if (humanWaiter) {
			this._humanWaiters.delete(runId);
			humanWaiter(null);
		}
		const stepWaiter = this._stepWaiters.get(runId);
		if (stepWaiter) {
			this._stepWaiters.delete(runId);
			stepWaiter();
		}

		this._emitLog(run, 'warn', 'Stop requested — cancelling active tasks and cleaning up background processes...');
		this._notifyRunChanged(run);

		const [terminatedCount] = await Promise.all([
			this.ticketRuntimeService.cancelAllActiveOperations('Workflow stopped by user').catch(() => 0),
			this._shutdownPythonKernel(runId).catch(() => { })
		]);

		if (this._persistDebounceMap.has(run.workflowUri)) {
			clearTimeout(this._persistDebounceMap.get(run.workflowUri));
			this._persistDebounceMap.delete(run.workflowUri);
		}
		this._emitLog(
			run,
			'warn',
			`Workflow execution stopped cleanly${terminatedCount > 0 ? ` (${terminatedCount} active background task(s) terminated)` : ''}.`
		);
		this._notifyRunChanged(run);
		await this.persistRunsForWorkflow(run.workflowUri);
	}

	private async _runWorkflowAsync(
		run: IWorkflowExecutionRun,
		data: IFlowchartData,
		options?: IWorkflowEngineOptions
	): Promise<void> {
		let isDaemonLoop = run.mode === 'daemon';
		await this._startPythonKernel(run, data.pythonPath);

		try {
			const selectiveNodeIds = Array.isArray(options?.selectedNodeIds)
				? options!.selectedNodeIds!.filter(id => data.nodes.some(n => n.id === id))
				: [];
			const selectedNodeSet = selectiveNodeIds.length > 0 ? new Set(selectiveNodeIds) : undefined;

			do {
				// Find Start/Entry node
				const startNodeId = selectiveNodeIds.length > 0 ? selectiveNodeIds[0] : options?.entryNodeId;
				const entryNode = this._findEntryNode(data, startNodeId);
				if (!entryNode) {
					throw new Error('No valid start node found in workflow.');
				}

				if (selectiveNodeIds.length > 0) {
					const orderSummary = selectiveNodeIds
						.map((id, idx) => `#${idx + 1} '${data.nodes.find(n => n.id === id)?.label || id}'`)
						.join(' -> ');
					this._emitLog(run, 'info', `[Selective Run] Executing ${selectiveNodeIds.length} selected node(s) only: ${orderSummary}`);
				}

				let stepCount = 0;
				const maxSteps = options?.maxSteps || 500;
				let activeNodeIds: string[] = [entryNode.id];

				while (activeNodeIds.length > 0 && !this._cancelledRuns.has(run.runId)) {
					stepCount++;
					if (stepCount > maxSteps) {
						throw new Error(`Maximum step limit (${maxSteps}) reached. Possible infinite loop detected.`);
					}

					// Always yield to the UI event loop so the renderer thread never freezes
					await new Promise(resolve => setTimeout(resolve, 80));

					// Check paused state
					if (run.status === 'paused') {
						await new Promise<void>(resolve => {
							this._stepWaiters.set(run.runId, resolve);
						});
					}

					if (this._cancelledRuns.has(run.runId)) {
						break;
					}

					// Resolve current active nodes
					const currentNodes = activeNodeIds
						.map(id => data.nodes.find(n => n.id === id))
						.filter((n): n is IFlowchartNode => !!n);

					if (currentNodes.length === 0) {
						break;
					}

					// Mark visited and update node states to running
					run.currentNodeId = currentNodes[0].id;
					for (const node of currentNodes) {
						if (!run.visitedNodeIds.includes(node.id)) {
							run.visitedNodeIds.push(node.id);
						}
						const nodeState = run.nodeStates[node.id] || {
							nodeId: node.id,
							nodeLabel: node.label,
							nodeType: node.type,
							status: 'pending',
							executedTickets: []
						};
						nodeState.status = 'running';
						nodeState.startedAt = Date.now();
						run.nodeStates[node.id] = nodeState;
					}
					this._notifyRunChanged(run);

					// Execute all active nodes in parallel
					const nextNodesNested = await Promise.all(
						currentNodes.map(async (node) => {
							const nodeState = run.nodeStates[node.id];
							const pathStep: IWorkflowPathStep = {
								stepIndex: (run.executionPath?.length || 0) + 1,
								nodeId: node.id,
								nodeLabel: node.label || node.id,
								nodeType: node.type,
								startedAt: Date.now(),
								status: 'running',
								operations: []
							};
							if (!run.executionPath) {
								run.executionPath = [];
							}
							run.executionPath.push(pathStep);

							this._emitLog(run, 'info', `Executing node: '${node.label}' (${node.type})`, { nodeId: node.id });
							try {
								await this._executeNode(run, node, nodeState, pathStep);
								if (this._cancelledRuns.has(run.runId) || run.status === 'stopped') {
									nodeState.status = 'pending';
									nodeState.completedAt = Date.now();
									nodeState.durationMs = nodeState.completedAt - (nodeState.startedAt || nodeState.completedAt);
									pathStep.completedAt = nodeState.completedAt;
									pathStep.durationMs = nodeState.durationMs;
									return [];
								}
								nodeState.status = 'success';
								nodeState.completedAt = Date.now();
								nodeState.durationMs = nodeState.completedAt - (nodeState.startedAt || nodeState.completedAt);
								pathStep.status = 'success';
								pathStep.completedAt = nodeState.completedAt;
								pathStep.durationMs = nodeState.durationMs;
								this._emitLog(run, 'info', `Completed node: '${node.label}' in ${nodeState.durationMs}ms`, { nodeId: node.id });

								// Assign to bound context variables if present
								// Note: If node.pipeline was already executed, all pipeline steps have already updated run.contextVariables;
								// only sync v.currentValue from run.contextVariables and do NOT re-evaluate v.expression!
								if (node.pipeline && node.pipeline.length > 0) {
									const nodeVars = this._getNodeVars(node);
									for (const v of nodeVars) {
										if (v.name) {
											const cleanVarName = v.name.replace(/^@/, '').trim();
											if (run.contextVariables[cleanVarName] !== undefined) {
												v.currentValue = run.contextVariables[cleanVarName];
											}
										}
									}
								} else {
									const pipelineAssignedVars = new Set<string>();
									if (node.pipeline && Array.isArray(node.pipeline)) {
										for (const step of node.pipeline) {
											if (step.targetVariable) {
												pipelineAssignedVars.add(step.targetVariable.replace(/^@/, '').trim());
											}
											if (step.expression) {
												const assignMatches = step.expression.matchAll(/(?:^|\n)\s*@?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\+|-|\*|\/)?=(?!=)/g);
												for (const m of assignMatches) {
													if (m[1]) pipelineAssignedVars.add(m[1]);
												}
											}
										}
									}

									const nodeVars = this._getNodeVars(node);
									for (const v of nodeVars) {
										if (v.name) {
											const cleanVarName = v.name.replace(/^@/, '').trim();
											// If this variable was already assigned by pipeline steps in this node, do not re-evaluate to avoid double mutation!
											if (pipelineAssignedVars.has(cleanVarName)) {
												v.currentValue = run.contextVariables[cleanVarName];
												continue;
											}

											let assignedVal: any;
											const oldVal = run.contextVariables[cleanVarName];

											if (v.expression) {
												let expr = v.expression.trim();

												// Check if this variable was already assigned and populated by a pipeline step (e.g. call_function),
												// or if the expression represents a function call / assignment (e.g. @var = fn(...) or fn(...))
												const isFunctionCall = this._isFunctionCallExpression(expr) ||
													this._isFunctionCallExpression(v.name) ||
													(node.pipeline && node.pipeline.some(p => p.type === 'call_function' && (p.targetVariable?.replace(/^@/, '') === cleanVarName || (p.expression && p.expression.includes(cleanVarName)))));

												if (isFunctionCall && run.contextVariables[cleanVarName] !== undefined) {
													assignedVal = run.contextVariables[cleanVarName];
												} else {
													// Strip self-assignment prefix if present (e.g. "@monitor = ...", "monitor = monitor + 1" or "monitor += 1")
													const assignMatch = expr.match(/^@?[a-zA-Z0-9_\u4e00-\u9fa5]+\s*=\s*([\s\S]*)$/);
													if (assignMatch) {
														expr = assignMatch[1].trim();
													}
													if (expr.startsWith(`${cleanVarName} +=`)) {
														expr = `+=${expr.substring(`${cleanVarName} +=`.length).trim()}`;
													} else if (expr.startsWith(`${cleanVarName}+=`)) {
														expr = `+=${expr.substring(`${cleanVarName}+=`.length).trim()}`;
													} else if (expr.startsWith(`${cleanVarName} -=`)) {
														expr = `-=${expr.substring(`${cleanVarName} -=`.length).trim()}`;
													} else if (expr.startsWith(`${cleanVarName}-=`)) {
														expr = `-=${expr.substring(`${cleanVarName}-=`.length).trim()}`;
													}
													if (expr.startsWith('=')) {
														expr = expr.substring(1).trim();
													}

													// Check if expr references a ticket or unpack index: e.g. "@my_ticket", "@my_ticket[0]", "ticket.output[1]", "FNDJ1-0008"
													const ticketMatch = expr.match(/^@?([a-zA-Z0-9_\-]+)(\[(\d+)\])?$/);
													const cleanTarget = ticketMatch ? ticketMatch[1] : '';
													const unpackIdx = ticketMatch && ticketMatch[3] !== undefined ? parseInt(ticketMatch[3], 10) : undefined;

													const matchedTicket = nodeState.executedTickets?.find(t =>
														t.ticketName === cleanTarget ||
														t.ticketName.replace(/[^a-zA-Z0-9_]/g, '_') === cleanTarget ||
														t.ticketName.toLowerCase() === cleanTarget.toLowerCase() ||
														t.ticketName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase() === cleanTarget.toLowerCase() ||
														t.ticketId === cleanTarget ||
														t.ticketId.toLowerCase() === cleanTarget.toLowerCase()
													) || (cleanTarget === 'ticket' ? nodeState.executedTickets?.[nodeState.executedTickets.length - 1] : undefined);

													if (matchedTicket) {
														let outVal = matchedTicket.output;
														if (typeof outVal === 'string' && (outVal.startsWith('[') || outVal.startsWith('{'))) {
															try { outVal = JSON.parse(outVal); } catch { }
														}
														if (unpackIdx !== undefined) {
															if (Array.isArray(outVal)) {
																assignedVal = outVal[unpackIdx];
															} else if (typeof outVal === 'object' && outVal !== null) {
																assignedVal = Object.values(outVal)[unpackIdx];
															} else if (typeof outVal === 'string' && outVal.includes(',')) {
																const parts = outVal.split(',').map(s => s.trim());
																assignedVal = parts[unpackIdx];
															} else {
																assignedVal = outVal;
															}
														} else {
															assignedVal = outVal;
														}
													} else if (expr === 'ticket.output' || expr === 'ticket' || expr === '@ticket') {
														const lastTicket = nodeState.executedTickets?.[nodeState.executedTickets.length - 1];
														assignedVal = lastTicket?.output ?? nodeState.output?.result ?? nodeState.output?.output ?? 'success';
													} else if (expr === 'ticket.status' || expr === '@ticket.status') {
														const lastTicket = nodeState.executedTickets?.[nodeState.executedTickets.length - 1];
														assignedVal = lastTicket?.status ?? nodeState.status ?? 'success';
													} else if (expr === 'ticket.id' || expr === 'ticket.name') {
														const lastTicket = nodeState.executedTickets?.[nodeState.executedTickets.length - 1];
														assignedVal = lastTicket ? (expr === 'ticket.id' ? lastTicket.ticketId : lastTicket.ticketName) : '';
													} else if (expr === '+ 1' || expr === '++' || expr === '+= 1' || expr === '+=1') {
														const base = typeof oldVal === 'number' ? oldVal : (Number(oldVal) || 0);
														assignedVal = base + 1;
													} else if (expr === '- 1' || expr === '--' || expr === '-= 1' || expr === '-=1') {
														const base = typeof oldVal === 'number' ? oldVal : (Number(oldVal) || 0);
														assignedVal = base - 1;
													} else if (/^(\+\=|\+)\s*(\d+(\.\d+)?)$/.test(expr)) {
														const delta = Number(expr.replace(/^(\+\=|\+)/, '').trim());
														const base = typeof oldVal === 'number' ? oldVal : (Number(oldVal) || 0);
														assignedVal = base + delta;
													} else if (/^(-\=|-)\s*(\d+(\.\d+)?)$/.test(expr)) {
														const delta = Number(expr.replace(/^(-\=|-)/, '').trim());
														const base = typeof oldVal === 'number' ? oldVal : (Number(oldVal) || 0);
														assignedVal = base - delta;
													} else if (/^\*\=\s*(\d+(\.\d+)?)$/.test(expr)) {
														const mult = Number(expr.replace(/^\*\=/, '').trim());
														const base = typeof oldVal === 'number' ? oldVal : (Number(oldVal) || 0);
														assignedVal = base * mult;
													} else if (expr.startsWith('+=')) {
														try {
															const rhsExpr = expr.substring(2).trim();
															const rhsVal = this._evaluateExpressionOrLiteral(rhsExpr, run.contextVariables);
															if (Array.isArray(oldVal)) {
																assignedVal = Array.isArray(rhsVal) ? [...oldVal, ...rhsVal] : [...oldVal, rhsVal];
															} else if (typeof oldVal === 'number' && typeof rhsVal === 'number') {
																assignedVal = oldVal + rhsVal;
															} else if (typeof oldVal === 'string' || typeof rhsVal === 'string') {
																assignedVal = String(oldVal ?? '') + String(rhsVal ?? '');
															} else if (oldVal && typeof oldVal === 'object' && rhsVal && typeof rhsVal === 'object') {
																assignedVal = { ...oldVal, ...rhsVal };
															} else if (oldVal === undefined || oldVal === null) {
																assignedVal = rhsVal;
															} else {
																assignedVal = (Number(oldVal) || 0) + (Number(rhsVal) || 0);
															}
														} catch (evalErr: any) {
															this._emitLog(run, 'error', `[Expression Error] '${v.name}' in '${node.label}': ${evalErr.message}`, { nodeId: node.id });
															throw evalErr;
														}
													} else if (isFunctionCall && run.contextVariables[cleanVarName] !== undefined) {
														assignedVal = run.contextVariables[cleanVarName];
													} else {
														try {
															assignedVal = this._evaluateExpressionOrLiteral(expr, run.contextVariables);
														} catch (evalErr: any) {
															this._emitLog(run, 'error', `[Expression Error] '${v.name}' in '${node.label}': ${evalErr.message}`, { nodeId: node.id });
															throw evalErr;
														}
													}
												}
											} else if (nodeState.executedTickets && nodeState.executedTickets.length > 0) {
												const initClean = (v.initialValue || '').trim().replace(/^@/, '').replace(/^=\s*/, '');
												const matchedByInit = nodeState.executedTickets.find(t =>
													t.ticketName === initClean ||
													t.ticketName.replace(/[^a-zA-Z0-9_]/g, '_') === initClean ||
													t.ticketName.toLowerCase() === initClean.toLowerCase() ||
													t.ticketId === initClean
												);
												if (matchedByInit) {
													assignedVal = matchedByInit.output;
												} else {
													const lastTicket = nodeState.executedTickets[nodeState.executedTickets.length - 1];
													assignedVal = lastTicket?.output ?? 'success';
												}
											} else {
												assignedVal = nodeState.output?.[v.name] ?? (nodeVars.length === 1 ? (nodeState.output?.value ?? nodeState.output?.returnValue) : undefined);
												if (assignedVal === undefined) {
													if (oldVal !== undefined) {
														assignedVal = oldVal;
													} else {
														assignedVal = this._resolveValue(v.initialValue || 'None', run.contextVariables);
													}
												}
											}

											run.contextVariables[cleanVarName] = assignedVal;
											v.currentValue = assignedVal;
											const valPreviewStr = typeof assignedVal === 'object' && assignedVal !== null
												? JSON.stringify(assignedVal)
												: String(assignedVal);
											const shortPreview = valPreviewStr.length > 200 ? valPreviewStr.substring(0, 200) + ' ...' : valPreviewStr;
											this._emitLog(run, 'info', `[Variable Updated] '${cleanVarName}' = ${shortPreview}${v.expression ? ` (${v.expression})` : ''}`, { nodeId: node.id });
										}
									}
								}
							} catch (err: any) {
								if (this._cancelledRuns.has(run.runId) || run.status === 'stopped') {
									nodeState.status = 'pending';
									nodeState.completedAt = Date.now();
									nodeState.durationMs = nodeState.completedAt - (nodeState.startedAt || nodeState.completedAt);
									pathStep.status = 'failed';
									pathStep.error = 'Stopped by user';
									pathStep.completedAt = nodeState.completedAt;
									pathStep.durationMs = nodeState.durationMs;
									return [];
								}
								nodeState.status = 'failed';
								nodeState.error = err.message || String(err);
								nodeState.completedAt = Date.now();
								nodeState.durationMs = nodeState.completedAt - (nodeState.startedAt || nodeState.completedAt);
								pathStep.status = 'failed';
								pathStep.error = nodeState.error;
								pathStep.completedAt = nodeState.completedAt;
								pathStep.durationMs = nodeState.durationMs;
								this._emitLog(run, 'error', `Node '${node.label}' failed: ${nodeState.error}`, { nodeId: node.id });
								throw err;
							} finally {
								this._notifyRunChanged(run);
							}

							if (this._cancelledRuns.has(run.runId) || run.status === 'stopped') {
								return [];
							}

							// Check if end node
							if (this._isEndNode(node)) {
								this._emitLog(run, 'info', `Reached end node: '${node.label}'. Execution branch completed.`);
								pathStep.operations.push({
									type: 'general',
									label: `End: Completed branch at '${node.label}'`,
									details: { message: 'Reached workflow termination node' }
								});
								return [];
							}

							// Resolve next nodes from this node
							if (selectedNodeSet) {
								const selectedOutgoingLinks = data.links.filter(l => l.from === node.id && selectedNodeSet.has(l.to));
								if (selectedOutgoingLinks.length === 0) {
									return [];
								}
								return await this._resolveNextNodes(run, node, { ...data, links: selectedOutgoingLinks }, pathStep, true);
							}
							return await this._resolveNextNodes(run, node, data, pathStep);
						})
					);

					// Flatten and deduplicate next active nodes
					const nextActiveIds: string[] = [];
					for (const list of nextNodesNested) {
						for (const nextNode of list) {
							if (!nextActiveIds.includes(nextNode.id)) {
								nextActiveIds.push(nextNode.id);
							}
						}
					}

					// In selective multi-node execution mode, if no direct link between selected nodes was taken, jump to the next unvisited selected node
					if (selectedNodeSet && nextActiveIds.length === 0) {
						const nextUnvisitedId = selectiveNodeIds.find(id => !run.visitedNodeIds.includes(id));
						const nextTarget = nextUnvisitedId ? data.nodes.find(n => n.id === nextUnvisitedId) : undefined;
						if (nextTarget) {
							const lastNode = currentNodes[currentNodes.length - 1];
							this._emitLog(
								run,
								'info',
								`[Selective Run] Skipping unselected intermediate nodes -> jumping to next selected node: '${nextTarget.label}'`,
								{ nodeId: nextTarget.id }
							);
							const lastPathStep = run.executionPath && run.executionPath.length > 0
								? run.executionPath[run.executionPath.length - 1]
								: undefined;
							if (lastPathStep && !lastPathStep.transition && lastNode) {
								lastPathStep.transition = {
									fromNodeId: lastNode.id,
									fromNodeLabel: lastNode.label,
									toNodeId: nextTarget.id,
									toNodeLabel: nextTarget.label,
									conditionLabel: 'selective jump',
									conditionEvaluation: true,
									explanation: `Skipped unselected nodes -> jumped to '${nextTarget.label}'`
								};
							}
							nextActiveIds.push(nextTarget.id);
						}
					}

					// Step mode pause before moving to the next round of active nodes
					if (run.mode === 'step' && nextActiveIds.length > 0) {
						run.status = 'paused';
						this._notifyRunChanged(run);
						await new Promise<void>(resolve => {
							this._stepWaiters.set(run.runId, resolve);
						});
					}

					if (this._cancelledRuns.has(run.runId)) {
						break;
					}

					activeNodeIds = nextActiveIds;
				}

				if (isDaemonLoop && !this._cancelledRuns.has(run.runId)) {
					const interval = options?.daemonIntervalMs || 10000;
					this._emitLog(run, 'info', `Daemon cycle finished. Sleeping for ${interval / 1000}s before next execution cycle...`);
					await new Promise(r => setTimeout(r, interval));
				} else {
					isDaemonLoop = false;
				}

			} while (isDaemonLoop && !this._cancelledRuns.has(run.runId));

			if (!this._cancelledRuns.has(run.runId) && run.status !== 'stopped') {
				run.completedAt = Date.now();
				run.durationMs = run.completedAt - run.startedAt;
				run.updatedAt = Date.now();
				run.currentNodeId = undefined;
				if (run.status !== 'failed') {
					run.status = 'completed';
					this._emitLog(run, 'info', `Workflow '${run.workflowName}' executed successfully to completion in ${(run.durationMs / 1000).toFixed(1)}s!`);
					this.notificationService.info(`Workflow '${run.workflowName}' completed successfully (${(run.durationMs / 1000).toFixed(1)}s).`);
				} else {
					this._emitLog(run, 'error', `Workflow '${run.workflowName}' stopped with errors in ${(run.durationMs / 1000).toFixed(1)}s: ${run.error || 'Execution blocked'}`);
					this.notificationService.error(`Workflow '${run.workflowName}' execution failed: ${run.error || 'Blocked'}`);
				}
				if (this._persistDebounceMap.has(run.workflowUri)) {
					clearTimeout(this._persistDebounceMap.get(run.workflowUri));
					this._persistDebounceMap.delete(run.workflowUri);
				}
				this._notifyRunChanged(run);
				await this.persistRunsForWorkflow(run.workflowUri);
			}
		} finally {
			await this._shutdownPythonKernel(run.runId);
		}
	}

	private async _executeNode(
		run: IWorkflowExecutionRun,
		node: IFlowchartNode,
		state: IWorkflowNodeExecutionState,
		pathStep?: IWorkflowPathStep
	): Promise<void> {
		// 1. Start Node
		if (node.type === 'circle' && (node.label.toLowerCase() === 'start' || !node.label)) {
			state.output = { message: 'Workflow started' };
			pathStep?.operations.push({
				type: 'general',
				label: `Start Node: '${node.label || 'Start'}'`,
				details: { message: 'Workflow execution initiated' }
			});
			return;
		}

		// 2. Human-in-the-Loop Node check
		const isHuman = node.label.toLowerCase().includes('human') ||
			node.label.toLowerCase().includes('approval') ||
			node.label.toLowerCase().includes('review') ||
			node.label.toLowerCase().includes('manual');

		if (isHuman) {
			run.status = 'waiting_human';
			state.status = 'waiting_human';
			state.waitingHumanPrompt = {
				nodeId: node.id,
				prompt: `Approval or manual input required for step: '${node.label}'`,
				options: ['Approve', 'Reject', 'Proceed']
			};
			this._notifyRunChanged(run);
			this._emitLog(run, 'warn', `[Human-in-the-Loop] Waiting for human interaction on node '${node.label}'`);
			this.notificationService.info(`Workflow requires human interaction: ${node.label}`);

			const userInput = await new Promise<any>(resolve => {
				this._humanWaiters.set(run.runId, resolve);
			});

			if (this._cancelledRuns.has(run.runId)) {
				throw new Error('Workflow was stopped while waiting for human input.');
			}

			run.status = 'running';
			state.status = 'running';
			state.waitingHumanPrompt = undefined;
			state.output = { userInput, approved: true };
			run.contextVariables[`${node.id}_input`] = userInput;
			return;
		}

		// 3. Sub-workflow encapsulation check (Nested Workflow Execution)
		const subWorkflowImport = node.imports?.find(i => i.type === 'workflow');
		if (subWorkflowImport) {
			this._emitLog(run, 'info', `[Sub-Workflow] Invoking nested workflow: '${subWorkflowImport.name}'`);
			const childWorkflowUri = subWorkflowImport.uri || subWorkflowImport.name;
			const childRun = await this.executeWorkflow(childWorkflowUri, {
				mode: 'standard',
				initialInputs: { ...run.contextVariables }
			});
			state.output = { subWorkflowRunId: childRun.runId, childStatus: childRun.status };
			return;
		}

		// 4. Custom Execution Pipeline (Explicit user-ordered steps)
		if (node.pipeline && node.pipeline.length > 0) {
			this._emitLog(run, 'info', `[Pipeline] Node '${node.label}' executing explicit pipeline (${node.pipeline.length} step(s))...`);

			const runTicket = async (ticketName: string, ticketType?: string, ticketUri?: string, parameters?: string) => {
				const ticketStart = Date.now();
				this._emitLog(run, 'info', `Running Ticket: [${ticketType || 'task'}] '${ticketName}'${parameters ? ` (PARAM: ${parameters})` : ''}`);

				// Parse parameters string if provided (e.g. key1=val1, key2=val2 or JSON or variable references)
				const inputParams: Record<string, any> = {};
				if (parameters) {
					const trimmed = parameters.trim();
					if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
						try {
							Object.assign(inputParams, JSON.parse(trimmed));
						} catch {
							// fallback
						}
					} else {
						const parts = trimmed.split(',');
						for (const p of parts) {
							const eqIdx = p.indexOf('=');
							if (eqIdx !== -1) {
								const k = p.substring(0, eqIdx).trim();
								const v = p.substring(eqIdx + 1).trim();
								inputParams[k] = v;
							}
						}
					}
				}

				// Resolve target workspace URI
				const wsUri = URI.parse(run.workflowUri);

				// Real runtime execution through ticketRuntimeService
				const execResult = await this.ticketRuntimeService.runTicket({
					workspaceUri: wsUri,
					ticketIdOrPath: ticketUri || ticketName,
					inputParams: { ...run.contextVariables, ...inputParams },
					isCancelled: () => this._cancelledRuns.has(run.runId) || run.status === 'stopped'
				});
				if (this._cancelledRuns.has(run.runId) || run.status === 'stopped') {
					throw new Error('Workflow execution was stopped');
				}

				const ticketRecord = {
					ticketId: execResult.ticketId || ticketUri || ticketName,
					ticketName: execResult.ticketName || ticketName,
					ticketType: execResult.ticketType || ticketType || 'task',
					status: (execResult.success ? 'success' : 'failed') as 'success' | 'failed',
					output: execResult.output,
					durationMs: Date.now() - ticketStart
				};
				state.executedTickets.push(ticketRecord);

				// Register primary outputs into contextVariables
				run.contextVariables[ticketRecord.ticketName] = ticketRecord.output;
				run.contextVariables[ticketRecord.ticketName.replace(/[^a-zA-Z0-9_]/g, '_')] = ticketRecord.output;
				if (ticketRecord.ticketId) {
					run.contextVariables[ticketRecord.ticketId] = ticketRecord.output;
				}

				// Merge granular field outputs from ticket execution into workflow context
				if (execResult.contextVariables) {
					for (const [k, v] of Object.entries(execResult.contextVariables)) {
						run.contextVariables[`${ticketRecord.ticketName}.${k}`] = v;
						if (ticketRecord.ticketId) {
							run.contextVariables[`${ticketRecord.ticketId}.${k}`] = v;
						}
					}
				}

				for (const stepRes of execResult.stepResults) {
					this._emitLog(run, stepRes.status === 'success' ? 'info' : 'warn', `  - [${stepRes.fieldType.toUpperCase()}] ${stepRes.fieldLabel}: ${stepRes.status} (${stepRes.durationMs}ms)`);
				}

				this._emitLog(run, execResult.success ? 'info' : 'error', `Ticket '${ticketName}' finished with status: ${execResult.status} in ${ticketRecord.durationMs}ms`);
				this._notifyRunChanged(run);
				return ticketRecord;
			};

			for (let i = 0; i < node.pipeline.length; i++) {
				if (this._cancelledRuns.has(run.runId) || run.status === 'stopped') {
					throw new Error('Workflow execution was stopped');
				}
				const step = node.pipeline[i];
				const stepComp = (step as any).component;
				const isDirectComponentStep = stepComp && (
					step.type === 'component' ||
					['parameters', 'output', 'prompt', 'table', 'browser', 'tts', 'media_player', 'git', 'python'].includes(stepComp.type)
				);
				const isRunTicketStep = step.type === 'run_ticket' || step.type === 'run_tickets' || step.type === 'RUN_TICKETS' || step.type === 'runTickets';
				const isCallFnStep = step.type === 'call_function' || step.type === 'custom_code' || (step.expression && this._isFunctionCallExpression(step.expression));

				const isTicketSideEffectStep = isRunTicketStep || /\b(CREATE_TICKETS|RUN_TICKETS|create_tickets|run_tickets)\s*\(/.test(step.expression || '');
				const maxStepAttempts = isTicketSideEffectStep ? 1 : 3;
				let stepAttempt = 0;

				while (stepAttempt < maxStepAttempts) {
					if (this._cancelledRuns.has(run.runId) || run.status === 'stopped') {
						throw new Error('Workflow execution was stopped');
					}
					stepAttempt++;
					const stepStartMs = Date.now();
					try {
						if (isDirectComponentStep) {
							const wsUri = URI.parse(run.workflowUri);
							this._emitLog(run, 'info', `[Step #${i + 1}] Component [${stepComp.type.toUpperCase()}] '${stepComp.label || step.label || stepComp.type}'`);
							const compRes = await this.ticketRuntimeService.executeNodeComponent(
								wsUri,
								wsUri,
								stepComp,
								run.contextVariables
							);
							if (this._cancelledRuns.has(run.runId) || run.status === 'stopped') {
								throw new Error('Workflow execution was stopped');
							}
							if (step.targetVariable && compRes.output !== undefined && stepComp.type !== 'parameters' && stepComp.type !== 'output' && stepComp.type !== 'result' && stepComp.type !== 'display') {
								const cleanTargetVar = step.targetVariable.trim().replace(/^@/, '');
								if (cleanTargetVar) {
									run.contextVariables[cleanTargetVar] = compRes.output;
								}
							}
							pathStep?.operations.push({
								type: 'call_function',
								label: `[${stepComp.type.toUpperCase()}] ${stepComp.label || stepComp.type}`,
								functionName: stepComp.type.toUpperCase(),
								targetVariable: step.targetVariable || stepComp.label,
								expression: step.expression || stepComp.label,
								value: compRes.output,
								durationMs: compRes.durationMs
							});
							if (stepComp.type === 'python' && compRes.details?.output) {
								const cleanStdout = String(compRes.details.output)
									.replace(/^>>> Running Python Script\r?\n?/, '')
									.trim();
								if (cleanStdout) {
									this._emitLog(run, compRes.status === 'success' ? 'info' : 'error', `[Step #${i + 1} Python Output] (${stepComp.label || 'Python'}):\n${cleanStdout}`, { nodeId: node.id });
								}
							}
							this._emitLog(
								run,
								compRes.status === 'success' ? 'info' : 'error',
								`[Step #${i + 1}] [${stepComp.type.toUpperCase()}] '${stepComp.label}' -> ${compRes.status} (${compRes.durationMs}ms)`
							);
							await this._persistAndNotifyNodeComponents(run, node);
							this._notifyRunChanged(run);
							if (compRes.status === 'failed') {
								throw new Error(compRes.error || `Component '${stepComp.label || stepComp.type}' execution failed`);
							}
						} else if (isRunTicketStep && step.ticketName) {
							this._emitLog(run, 'info', `[Step #${i + 1}] Run Ticket: '${step.ticketName}'${step.parameters ? ` (PARAM: ${step.parameters})` : ''}`);
							const ticketRecord = await runTicket(step.ticketName, step.ticketType, step.ticketUri, step.parameters);
							pathStep?.operations.push({
								type: 'run_ticket',
								label: `Run Ticket: '${step.ticketName}' [${step.ticketType || 'task'}]`,
								executedTicket: ticketRecord,
								durationMs: ticketRecord.durationMs
							});
							if (step.targetVariable) {
								const varKey = step.targetVariable.trim().replace(/^@/, '');
								run.contextVariables[varKey] = ticketRecord.output;
								this._emitLog(run, 'info', `[Step #${i + 1}] Output stored in variable: ${varKey}`);
							}
						} else if (this._pythonKernels.has(run.runId) && (isCallFnStep || step.type === 'set_variable')) {
							let pyCode = (step.expression || '').trim();
							if (step.type === 'set_variable' && step.targetVariable) {
								const varKey = step.targetVariable.trim().replace(/^@/, '');
								if (!pyCode) {
									pyCode = `${varKey} = None`;
								} else if (pyCode === '++' || pyCode === '+ 1' || pyCode === '+= 1' || pyCode === '+=1') {
									pyCode = `${varKey} = (${varKey} if '${varKey}' in globals() and isinstance(${varKey}, (int, float)) else 0) + 1`;
								} else if (pyCode === '--' || pyCode === '- 1' || pyCode === '-= 1' || pyCode === '-=1') {
									pyCode = `${varKey} = (${varKey} if '${varKey}' in globals() and isinstance(${varKey}, (int, float)) else 0) - 1`;
								} else if (/^(\+=|-=|\*=|\/=)/.test(pyCode)) {
									pyCode = `${varKey} ${pyCode}`;
								} else if (!new RegExp(`^@?${varKey}\\s*(?:\\+|-|\\*|\\/)?=(?!=)`).test(pyCode)) {
									pyCode = `${varKey} = ${pyCode.replace(/^=\s*/, '')}`;
								}
							} else if (isCallFnStep && step.targetVariable && pyCode) {
								const varKey = step.targetVariable.trim().replace(/^@/, '');
								if (!pyCode.includes('\n') && !new RegExp(`^@?[a-zA-Z_][a-zA-Z0-9_]*\\s*(?:\\+|-|\\*|\\/)?=(?!=)`).test(pyCode)) {
									pyCode = `${varKey} = ${pyCode}`;
								}
							}
							await this._executeInPythonKernel(run, node, i, state, pathStep, pyCode, 'exec');
						} else if (isCallFnStep && !this._cancelledRuns.has(run.runId) && run.status !== 'stopped') {
							await this._executeFunctionStep(run, node, step, i, state, pathStep);
						} else if (step.type === 'set_variable' && step.targetVariable) {
							const varKey = step.targetVariable.trim().replace(/^@/, '');
							let val: any = undefined;
							let expr = (step.expression || '').trim();

							// Strip self-assignment prefix if present (e.g. "monitor = monitor + 1" or "monitor += 1")
							if (expr.startsWith(`${varKey} =`)) {
								expr = expr.substring(`${varKey} =`.length).trim();
							} else if (expr.startsWith(`${varKey}=`)) {
								expr = expr.substring(`${varKey}=`.length).trim();
							} else if (expr.startsWith(`${varKey} +=`)) {
								expr = `+=${expr.substring(`${varKey} +=`.length).trim()}`;
							} else if (expr.startsWith(`${varKey}+=`)) {
								expr = `+=${expr.substring(`${varKey}+=`.length).trim()}`;
							} else if (expr.startsWith(`${varKey} -=`)) {
								expr = `-=${expr.substring(`${varKey} -=`.length).trim()}`;
							} else if (expr.startsWith(`${varKey}-=`)) {
								expr = `-=${expr.substring(`${varKey}-=`.length).trim()}`;
							}
							if (expr.startsWith('=')) {
								expr = expr.substring(1).trim();
							}

							const oldVal = run.contextVariables[varKey];
							if (expr === '+ 1' || expr === '++' || expr === '+= 1' || expr === '+=1') {
								const base = typeof oldVal === 'number' ? oldVal : (Number(oldVal) || 0);
								val = base + 1;
							} else if (expr === '- 1' || expr === '--' || expr === '-= 1' || expr === '-=1') {
								const base = typeof oldVal === 'number' ? oldVal : (Number(oldVal) || 0);
								val = base - 1;
							} else if (/^(\+\=|\+)\s*(\d+(\.\d+)?)$/.test(expr)) {
								const delta = Number(expr.replace(/^(\+\=|\+)/, '').trim());
								const base = typeof oldVal === 'number' ? oldVal : (Number(oldVal) || 0);
								val = base + delta;
							} else if (/^(-\=|-)\s*(\d+(\.\d+)?)$/.test(expr)) {
								const delta = Number(expr.replace(/^(-\=|-)/, '').trim());
								const base = typeof oldVal === 'number' ? oldVal : (Number(oldVal) || 0);
								val = base - delta;
							} else if (expr.startsWith('+=')) {
								try {
									const rhsExpr = expr.substring(2).trim();
									const evaluator = new PythonExpressionEvaluator(rhsExpr, run.contextVariables);
									const rhsVal = evaluator.evaluate();
									if (Array.isArray(oldVal)) {
										val = Array.isArray(rhsVal) ? [...oldVal, ...rhsVal] : [...oldVal, rhsVal];
									} else if (typeof oldVal === 'number' && typeof rhsVal === 'number') {
										val = oldVal + rhsVal;
									} else if (typeof oldVal === 'string' || typeof rhsVal === 'string') {
										val = String(oldVal ?? '') + String(rhsVal ?? '');
									} else if (oldVal && typeof oldVal === 'object' && rhsVal && typeof rhsVal === 'object') {
										val = { ...oldVal, ...rhsVal };
									} else if (oldVal === undefined || oldVal === null) {
										val = rhsVal;
									} else {
										val = (Number(oldVal) || 0) + (Number(rhsVal) || 0);
									}
								} catch (evalErr: any) {
									this._emitLog(run, 'error', `[Syntax Error] Step #${i + 1} variable '${varKey}' failed to evaluate '${expr}': ${evalErr.message}`, { nodeId: node.id });
									throw new Error(`[Syntax Error] Step #${i + 1} ('${expr}'): ${evalErr.message}`);
								}
							} else if (expr) {
								try {
									const evaluator = new PythonExpressionEvaluator(expr, run.contextVariables);
									val = evaluator.evaluate();
								} catch (evalErr: any) {
									this._emitLog(run, 'error', `[Syntax Error] Step #${i + 1} variable '${varKey}' failed to evaluate '${expr}': ${evalErr.message}`, { nodeId: node.id });
									throw new Error(`[Syntax Error] Step #${i + 1} ('${expr}'): ${evalErr.message}`);
								}
							}
							run.contextVariables[varKey] = val;
							run.contextVariables[`@${varKey}`] = val;
							this._emitLog(run, 'info', `[Step #${i + 1}] Variable assigned: @${varKey} = ${JSON.stringify(val)}`);
							pathStep?.operations.push({
								type: 'set_variable',
								label: `Set Variable: @${varKey} = ${JSON.stringify(val)}`,
								details: {
									variable: varKey,
									expression: expr,
									oldValue: oldVal,
									newValue: val
								}
							});
						}
						if (!isDirectComponentStep && stepComp) {
							const dur = Date.now() - stepStartMs;
							const ts = new Date().toLocaleTimeString();
							const targetKey = (step.targetVariable || stepComp.label || '').trim().replace(/^@/, '');
							const outVal = targetKey && run.contextVariables[targetKey] !== undefined
								? run.contextVariables[targetKey]
								: undefined;
							stepComp.lastExecutionStatus = 'success';
							stepComp.lastExecutionDurationMs = dur;
							stepComp.lastExecutedAt = ts;
							stepComp.lastExecutionOutput = outVal;
							const previewStr = outVal !== undefined
								? (typeof outVal === 'object' ? JSON.stringify(outVal, null, 2) : String(outVal))
								: 'Executed successfully';
							stepComp.lastExecutionLog = `>>> ${step.expression || stepComp.label || stepComp.type}\nTimestamp: ${ts} (${dur}ms)\nResult:\n${previewStr.length > 4000 ? previewStr.substring(0, 4000) + '\n... [truncated]' : previewStr}`;
							await this._persistAndNotifyNodeComponents(run, node);
						}
						break;
					} catch (stepErr: any) {
						if (this._cancelledRuns.has(run.runId) || run.status === 'stopped') {
							throw stepErr;
						}
						if (stepComp) {
							stepComp.lastExecutionStatus = 'failed';
							stepComp.lastExecutionDurationMs = Date.now() - stepStartMs;
							stepComp.lastExecutedAt = new Date().toLocaleTimeString();
							if (!stepComp.lastExecutionLog || !String(stepComp.lastExecutionLog).includes(stepErr?.message || '')) {
								stepComp.lastExecutionLog = `[Execution Error]: ${stepErr?.message || stepErr}`;
							}
							await this._persistAndNotifyNodeComponents(run, node);
						}
						if (stepAttempt < maxStepAttempts && !this._cancelledRuns.has(run.runId)) {
							this._emitLog(run, 'warn', `[Step #${i + 1} Retry ${stepAttempt}/${maxStepAttempts}] Attempt ${stepAttempt} failed (${stepErr?.message || stepErr}). Retrying...`, { nodeId: node.id });
							await new Promise(r => setTimeout(r, 250));
							continue;
						}
						if (maxStepAttempts > 1) {
							this._emitLog(run, 'error', `[Step #${i + 1} Halted] Stopping execution after ${stepAttempt} failed attempts: ${stepErr?.message || stepErr}`, { nodeId: node.id });
						}
						state.failedStepIndex = i;
						throw stepErr;
					}
				}
			}

			state.output = { executedSteps: node.pipeline.length, tickets: state.executedTickets };
			return;
		}

		// 5. Fallback: Imported Tickets Execution (Variable-driven pipeline & natural ordering)
		const ticketImports = node.imports?.filter(i =>
			['task', 'job', 'project', 'case', 'issue'].includes(i.type.toLowerCase())
		) || [];

		if (ticketImports.length > 0) {
			this._emitLog(run, 'info', `Node '${node.label}' contains ${ticketImports.length} imported ticket(s). Processing execution pipeline...`);

			const executedTicketNames = new Set<string>();

			const runTicket = async (item: { type: string; name: string; uri?: string }) => {
				const ticketStart = Date.now();
				this._emitLog(run, 'info', `Running Ticket: [${item.type}] '${item.name}'`);

				// Simulated async ticket execution with snapshot integration
				await new Promise(r => setTimeout(r, 600));

				const ticketRecord = {
					ticketId: item.uri || item.name,
					ticketName: item.name,
					ticketType: item.type,
					status: 'success' as const,
					output: `Ticket '${item.name}' processed successfully.`,
					durationMs: Date.now() - ticketStart
				};
				state.executedTickets.push(ticketRecord);
				run.contextVariables[ticketRecord.ticketName] = ticketRecord.output;
				run.contextVariables[ticketRecord.ticketName.replace(/[^a-zA-Z0-9_]/g, '_')] = ticketRecord.output;
				if (ticketRecord.ticketId) {
					run.contextVariables[ticketRecord.ticketId] = ticketRecord.output;
				}
				this._emitLog(run, 'info', `Ticket '${item.name}' completed in ${ticketRecord.durationMs}ms`);
				this._notifyRunChanged(run);
				return ticketRecord;
			};

			// Helper to find imported ticket matching a variable reference
			const findMatchingImport = (ref?: string) => {
				if (!ref) return undefined;
				let clean = ref.trim().replace(/^@/, '');
				if (clean.startsWith('=')) clean = clean.substring(1).trim();
				const eqIdx = clean.indexOf('=');
				if (eqIdx !== -1) clean = clean.substring(eqIdx + 1).trim();
				clean = clean.replace(/^@/, '').trim();
				const m = clean.match(/^([a-zA-Z0-9_\-]+)(\[(\d+)\])?$/);
				const target = m ? m[1] : clean;

				if (target === 'ticket' || target === 'ticket.output') {
					return ticketImports[0];
				}

				return ticketImports.find(imp =>
					imp.name === target ||
					imp.name.replace(/[^a-zA-Z0-9_]/g, '_') === target ||
					imp.name.toLowerCase() === target.toLowerCase() ||
					(imp.uri && imp.uri === target)
				);
			};

			const nodeVars = this._getNodeVars(node);

			// First: Run tickets in the exact order requested by node's bound variables!
			for (const v of nodeVars) {
				const targetImport = findMatchingImport(v.expression) || findMatchingImport(v.initialValue);
				if (targetImport && !executedTicketNames.has(targetImport.name)) {
					executedTicketNames.add(targetImport.name);
					await runTicket(targetImport);
				}
			}

			// Second: Run any remaining imported tickets that were not bound to variables
			for (const item of ticketImports) {
				if (!executedTicketNames.has(item.name)) {
					executedTicketNames.add(item.name);
					await runTicket(item);
				}
			}

			state.output = { executedCount: ticketImports.length, tickets: state.executedTickets };
			return;
		}

		// 5. General Diagram Node Execution
		await new Promise(r => setTimeout(r, 500));
		state.output = { message: `Node '${node.label}' successfully executed` };
	}

	private _isFunctionCallExpression(expr?: string): boolean {
		if (!expr) return false;
		const trimmed = expr.trim();
		const m = trimmed.match(/^(?:@?[a-zA-Z0-9_\u4e00-\u9fa5]+\s*=\s*)?([a-zA-Z0-9_]+)\s*\([\s\S]*\)$/);
		if (!m) return false;
		const fn = m[1].toLowerCase();
		const valueOperatorFns = new Set([
			'list', 'dict', 'set', 'tuple',
			'date', 'today', 'time', 'now', 'datetime', 'timestamp',
			'str', 'int', 'float', 'bool', 'len', 'abs', 'min', 'max', 'round'
		]);
		return !valueOperatorFns.has(fn);
	}

	private async _executeFunctionStep(
		run: IWorkflowExecutionRun,
		node: IFlowchartNode,
		step: INodePipelineStep,
		stepIndex: number,
		state: IWorkflowNodeExecutionState,
		pathStep?: IWorkflowPathStep
	): Promise<void> {
		const rawExpr = (step.expression || '').trim();
		const wsUri = URI.parse(run.workflowUri);

		this._emitLog(run, 'info', `[Step #${stepIndex + 1} FX] Invoking function call: ${rawExpr || step.functionName || 'unknown'}`, { nodeId: node.id });

		// Parse expression: e.g. "@news = RUN_TICKETS('jobs/news_digest', { 'target_keyword': 'AI' })"
		const match = rawExpr.match(/^(?:@?([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*=\s*)?([a-zA-Z0-9_]+)\s*\(([\s\S]*)\)$/);
		let targetVar = step.targetVariable?.replace(/^@/, '');
		let fnName = step.functionName || '';
		let rawArgsStr = '';
		let rhsGeneralExpr = '';

		if (match) {
			if (match[1]) targetVar = match[1].replace(/^@/, '');
			fnName = match[2];
			rawArgsStr = match[3] || '';
		} else {
			// Check if rawExpr is a general assignment like `@positions = out["Position List"]` or `positions = out["Position List"]`
			const assignMatch = rawExpr.match(/^@?([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*=\s*(?!=)([\s\S]+)$/);
			if (assignMatch) {
				targetVar = assignMatch[1].replace(/^@/, '');
				rhsGeneralExpr = assignMatch[2].trim();
				fnName = '';
			} else if (!fnName && rawExpr) {
				fnName = rawExpr;
			}
		}

		const upperFn = (fnName || '').toUpperCase();
		const { args, kwargs } = this._parseFunctionArgs(rawArgsStr, run.contextVariables);

		// Resolve workflow directory from workflowUri (if file URI, take parent folder)
		const rawWsUri = URI.parse(run.workflowUri);
		const workflowDir = rawWsUri.path.endsWith('.workflow.json') || rawWsUri.path.endsWith('.json')
			? URI.joinPath(rawWsUri, '..')
			: rawWsUri;

		let result: any = undefined;
		const startMs = Date.now();

		try {
			if (upperFn === 'RUN_TICKETS' || upperFn === 'RUNTICKETS' || upperFn === 'RUNTICKET') {
				let ticketIdOrPath = '';
				let inputParams: Record<string, any> = {};

				if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
					ticketIdOrPath = args[0].ticketId || args[0].ticketName || args[0].ticketIdOrPath || args[0].ticket_name || args[0].id || '';
					inputParams = args[0].parameters || args[0].inputParams || args[0].params || {};
				} else {
					const rawTicketArg = kwargs.ticket ?? kwargs.tickets ?? kwargs.ticket_name ?? kwargs.ticket_id ?? kwargs.ticketIdOrPath ?? args[0] ?? '';
					if (Array.isArray(rawTicketArg) && rawTicketArg.length > 0) {
						const first = rawTicketArg[0];
						if (typeof first === 'object' && first !== null) {
							ticketIdOrPath = first.ticketId || first.ticketName || first.ticketIdOrPath || first.id || '';
							if (first.parameters && typeof first.parameters === 'object') {
								inputParams = { ...first.parameters };
							}
						} else {
							ticketIdOrPath = String(first).trim();
						}
					} else if (typeof rawTicketArg === 'object' && rawTicketArg !== null) {
						ticketIdOrPath = rawTicketArg.ticketId || rawTicketArg.ticketName || rawTicketArg.ticketIdOrPath || rawTicketArg.id || '';
						if (rawTicketArg.parameters && typeof rawTicketArg.parameters === 'object') {
							inputParams = { ...rawTicketArg.parameters };
						}
					} else {
						ticketIdOrPath = String(rawTicketArg).trim();
					}
					const explicitParams = kwargs.params ?? kwargs.input_params ?? kwargs.parameters ?? kwargs.inputParams ?? (typeof args[1] === 'object' ? args[1] : {});
					if (typeof explicitParams === 'object' && explicitParams !== null) {
						inputParams = { ...inputParams, ...explicitParams };
					}
				}

				// If ticketIdOrPath references a context variable name (e.g. RUN_TICKETS(new_ticket) or RUN_TICKETS("new_ticket"))
				if (ticketIdOrPath && run.contextVariables[ticketIdOrPath]) {
					const ctxVal = run.contextVariables[ticketIdOrPath];
					if (typeof ctxVal === 'object' && ctxVal !== null && ctxVal.ticketId) {
						ticketIdOrPath = ctxVal.ticketId;
					}
				}
				// Also check if any ticket was created in this run whose title or name matches ticketIdOrPath
				if (ticketIdOrPath) {
					for (const ctxVal of Object.values(run.contextVariables)) {
						if (ctxVal && typeof ctxVal === 'object' && ctxVal.ticketId && (ctxVal.title === ticketIdOrPath || ctxVal.ticketName === ticketIdOrPath)) {
							ticketIdOrPath = ctxVal.ticketId;
							break;
						}
					}
				}

				// Merge any loose keyword arguments directly into inputParams (e.g. RUN_TICKETS("jobs/calc", start=@start))
				// Keyword arguments explicitly passed to the function call ALWAYS take precedence!
				const reservedKeys = new Set(['ticket', 'tickets', 'ticket_name', 'ticket_id', 'ticketIdOrPath', 'params', 'input_params', 'parameters', 'inputParams']);
				for (const [k, v] of Object.entries(kwargs)) {
					if (!reservedKeys.has(k)) {
						inputParams[k] = v;
					}
				}

				const mergedInputs = { ...run.contextVariables, ...inputParams };
				const paramKeys = Object.keys(inputParams);
				const paramSummary = paramKeys.length > 0
					? paramKeys.map(k => `${k}=${JSON.stringify(inputParams[k])}`).join(', ')
					: 'none';
				this._emitLog(run, 'info', `[RUN_TICKETS] Executing ticket '${ticketIdOrPath}' with ${paramKeys.length} parameter(s): ${paramSummary}`, { nodeId: node.id });

				const execRes = await this.ticketRuntimeService.RUN_TICKETS({
					workspaceUri: workflowDir,
					ticketIdOrPath,
					inputParams: mergedInputs
				});

				if (!execRes.success) {
					throw new Error(execRes.error || `Execution of ticket '${ticketIdOrPath}' failed.`);
				}

				result = execRes.output !== undefined ? execRes.output : execRes;
				if (result && typeof result === 'object' && !Array.isArray(result)) {
					try {
						Object.defineProperty(result, '__ticketMetadata', {
							value: {
								ticketId: execRes.ticketId || ticketIdOrPath,
								ticketName: execRes.ticketName || ticketIdOrPath,
								title: execRes.title,
								ticketType: execRes.ticketType || 'ticket',
								outputSpecs: (execRes as any).outputSpecs || []
							},
							enumerable: false,
							configurable: true,
							writable: true
						});
					} catch { }
				}
				const ticketRecord: IExecutedTicketRecord = {
					ticketId: execRes.ticketId || ticketIdOrPath,
					ticketName: execRes.ticketName || ticketIdOrPath,
					ticketType: execRes.ticketType || 'task',
					status: (execRes.success ? 'success' : 'failed') as 'success' | 'failed',
					output: execRes.output,
					outputSpecs: (execRes as any).outputSpecs,
					stepResults: execRes.stepResults,
					contextVariables: execRes.contextVariables,
					durationMs: Date.now() - startMs
				};
				state.executedTickets.push(ticketRecord);
				pathStep?.operations.push({
					type: 'run_ticket',
					label: `RUN_TICKETS: '${ticketRecord.ticketName || ticketRecord.ticketId}' [${ticketRecord.ticketType || 'task'}]`,
					executedTicket: ticketRecord,
					durationMs: ticketRecord.durationMs
				});

				if (ticketRecord.ticketName) {
					run.contextVariables[ticketRecord.ticketName] = execRes.output;
				}
			} else if (upperFn === 'CREATE_TICKETS' || upperFn === 'CREATETICKETS' || upperFn === 'CREATETICKET') {
				let opts: any = {};
				if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
					opts = { ...args[0] };
				} else {
					opts.ticketType = String(kwargs.ticket_type ?? kwargs.type ?? args[0] ?? 'task');
					opts.title = String(kwargs.title ?? args[1] ?? 'New Ticket');

					const targetFolder = kwargs.target_folder ?? kwargs.target_path ?? kwargs.folder ?? kwargs.path ?? (typeof args[2] === 'string' ? args[2] : undefined);
					if (targetFolder && String(targetFolder).trim()) {
						opts.targetPath = String(targetFolder).trim();
					}

					const explicitFolderName = kwargs.folder_name ?? kwargs.folderName ?? kwargs.name;
					if (explicitFolderName && String(explicitFolderName).trim()) {
						opts.folderName = String(explicitFolderName).trim();
					}

					const rawParams = kwargs.parameters ?? kwargs.params ?? kwargs.fieldValues ?? (typeof args[2] === 'object' ? args[2] : (typeof args[3] === 'object' ? args[3] : {}));
					const initialFields = typeof rawParams === 'object' && rawParams !== null ? { ...rawParams } : {};

					// Merge any loose keyword arguments directly into initialFields (e.g. CREATE_TICKETS("xxx", start=0))
					// Explicit keyword arguments take precedence over dictionary parameters
					const reservedCreateKeys = new Set(['ticket_type', 'type', 'title', 'target_folder', 'target_path', 'folder', 'path', 'folder_name', 'folderName', 'name', 'parameters', 'params', 'fieldValues', 'auto_run', 'autoRun']);
					for (const [k, v] of Object.entries(kwargs)) {
						if (!reservedCreateKeys.has(k)) {
							initialFields[k] = v;
						}
					}
					opts.parameters = initialFields;
					opts.fieldValues = initialFields;
					opts.autoRun = kwargs.auto_run === true || kwargs.autoRun === true;
				}
				if (opts.auto_run !== undefined && opts.autoRun === undefined) {
					opts.autoRun = opts.auto_run === true;
				}
				opts.workspaceUri = workflowDir;

				const createParamKeys = Object.keys(opts.parameters || {});
				const createParamSummary = createParamKeys.length > 0
					? createParamKeys.map(k => `${k}=${JSON.stringify(opts.parameters[k])}`).join(', ')
					: 'none';
				this._emitLog(run, 'info', `[CREATE_TICKETS] Creating ticket '${opts.title}' (type: ${opts.ticketType}) with ${createParamKeys.length} parameter(s): ${createParamSummary}`, { nodeId: node.id });
				const createRes = await this.ticketRuntimeService.CREATE_TICKETS(opts);
				if (!createRes.success) {
					throw new Error(createRes.error || `Failed to create ticket '${opts.title}'`);
				}
				result = createRes;
				if (createRes.title) {
					run.contextVariables[createRes.title] = createRes;
					run.contextVariables[`@${createRes.title}`] = createRes;
				}
				if (createRes.ticketId) {
					run.contextVariables[createRes.ticketId] = createRes;
					run.contextVariables[`@${createRes.ticketId}`] = createRes;
				}
				pathStep?.operations.push({
					type: 'create_ticket',
					label: `CREATE_TICKETS: '${opts.title}' [${opts.ticketType}]`,
					details: {
						ticketType: opts.ticketType,
						title: opts.title,
						ticketId: createRes.ticketId,
						ticketName: createRes.ticketName,
						targetFolder: createRes.targetFolder,
						parameters: opts.parameters
					},
					durationMs: Date.now() - startMs
				});
			} else if (upperFn === 'GET_TICKETS' || upperFn === 'GETTICKETS' || upperFn === 'GETTICKET') {
				const rawTarget = kwargs.ticket ?? kwargs.tickets ?? kwargs.ticket_name ?? kwargs.ticket_id ?? kwargs.ticketIdOrPath ?? kwargs.id ?? args[0] ?? '';
				const getRes = await this.ticketRuntimeService.GET_TICKETS(workflowDir, rawTarget);
				if (getRes && typeof getRes === 'object') {
					try {
						Object.defineProperty(getRes, '__isTicketGetResult', {
							value: true,
							enumerable: false,
							configurable: true,
							writable: true
						});
					} catch { }
				}
				result = getRes;
			} else if (upperFn === 'GET_OUTPUTS' || upperFn === 'GETOUTPUTS' || upperFn === 'GET_OUTPUT' || upperFn === 'GETOUTPUT') {
				const rawTarget = kwargs.ticket_id ?? kwargs.ticket ?? kwargs.tickets ?? kwargs.ticket_name ?? kwargs.ticketId ?? kwargs.ticketIdOrPath ?? kwargs.id ?? args[0] ?? '';
				const outRes = await this.ticketRuntimeService.GET_OUTPUTS(workflowDir, rawTarget);
				const requestedField = kwargs.field ?? kwargs.key ?? kwargs.name ?? kwargs.output ?? args[1];
				if (requestedField && outRes && typeof outRes === 'object') {
					const targetKey = String(requestedField).trim();
					if (targetKey in outRes) {
						result = outRes[targetKey];
					} else {
						const normKey = targetKey.toLowerCase().replace(/_/g, ' ');
						let matched = Object.keys(outRes).find(k => !k.startsWith('__') && k.trim().toLowerCase().replace(/_/g, ' ') === normKey);
						if (matched === undefined && normKey.length >= 4) {
							const prefixMatches = Object.keys(outRes).filter(k => {
								if (k.startsWith('__')) { return false; }
								const kn = k.trim().toLowerCase().replace(/_/g, ' ');
								return kn.startsWith(normKey) || normKey.startsWith(kn);
							});
							if (prefixMatches.length === 1) {
								matched = prefixMatches[0];
							}
						}
						result = matched !== undefined ? outRes[matched] : undefined;
					}
				} else {
					if (outRes && typeof outRes === 'object' && !Array.isArray(outRes)) {
						try {
							const tRes = await this.ticketRuntimeService.GET_TICKETS(workflowDir, rawTarget);
							const outputField = tRes?.schema?.fields?.find(f => f.type === 'output' || f.type === 'result');
							Object.defineProperty(outRes, '__ticketMetadata', {
								value: {
									ticketId: tRes?.ticketId || (typeof rawTarget === 'string' ? rawTarget : rawTarget?.ticketId),
									ticketName: tRes?.ticketName || (typeof rawTarget === 'string' ? rawTarget : rawTarget?.ticketName),
									title: tRes?.title,
									ticketType: tRes?.ticketType || 'ticket',
									outputSpecs: outputField?.outputSpecs || []
								},
								enumerable: false,
								configurable: true,
								writable: true
							});
						} catch { }
					}
					result = outRes;
				}
			} else if (upperFn === 'GET_PRIMITIVES_CATALOG' || upperFn === 'GETPRIMITIVESCATALOG') {
				const catalog = await this.ticketRuntimeService.GET_PRIMITIVES_CATALOG(workflowDir);
				result = catalog;
			} else if (upperFn === 'DISPLAY' || upperFn === 'PRINT') {
				let displayVal: any;
				if (args.length === 1) {
					displayVal = args[0];
				} else if (args.length > 1) {
					displayVal = args;
				} else if (Object.keys(kwargs).length > 0) {
					displayVal = kwargs;
				} else {
					displayVal = run.contextVariables;
				}
				result = displayVal;

				const { formattedText, summaryType, cleanValue, ticketTitle, ticketId, ticketType, outputItems, ticketHandle } = this._formatDisplayOutput(displayVal);

				const nodeLabelName = (node.label && node.label.trim()) ? node.label.trim() : (node.id || 'Node');
				const logDisplayPreview = formattedText.length > 500
					? formattedText.substring(0, 500) + ' ... [see Live Display]'
					: formattedText;
				this._emitLog(run, 'info', `[DISPLAY] [${nodeLabelName}] (${summaryType})\n${logDisplayPreview}`, { nodeId: node.id });

				const displayCard: IWorkflowDisplayCard = {
					id: `display_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
					runId: run.runId,
					nodeId: node.id,
					nodeTitle: nodeLabelName,
					expression: rawExpr || `DISPLAY(${rawArgsStr})`,
					value: cleanValue,
					formattedText,
					timestamp: new Date().toLocaleTimeString(),
					ticketTitle,
					ticketId,
					ticketType,
					outputItems,
					ticketHandle
				};

				let cardList = this._displayCardsByWorkflow.get(run.workflowUri);
				if (!cardList) {
					cardList = [];
					this._displayCardsByWorkflow.set(run.workflowUri, cardList);
				}
				cardList.unshift(displayCard);

				this._onDidDisplayVariable.fire(displayCard);
				pathStep?.operations.push({
					type: 'display',
					label: `DISPLAY [${nodeLabelName}]`,
					details: { formattedText, cleanValue, ticketTitle, ticketId, ticketType }
				});
			} else {
				// Fallback evaluation for general expressions (e.g. `positions = out["Position List"]`)
				const exprToEval = rhsGeneralExpr || rawExpr;
				try {
					const evaluator = new PythonExpressionEvaluator(exprToEval, run.contextVariables);
					result = evaluator.evaluate();
				} catch (err: any) {
					throw new Error(`Unsupported function or expression '${fnName || exprToEval}': ${err.message}`);
				}
			}

			if (targetVar) {
				run.contextVariables[targetVar] = result;
				run.contextVariables[`@${targetVar}`] = result;
				const preview = typeof result === 'object' ? JSON.stringify(result) : String(result);
				this._emitLog(run, 'info', `[Step #${stepIndex + 1} FX] Output stored in @${targetVar}: ${preview.substring(0, 150)}`, { nodeId: node.id });
			} else {
				this._emitLog(run, 'info', `[Step #${stepIndex + 1} FX] Execution completed successfully in ${Date.now() - startMs}ms`, { nodeId: node.id });
			}
		} catch (err: any) {
			this._emitLog(run, 'error', `[Step #${stepIndex + 1} FX Error] Function call '${fnName}' failed: ${err.message}`, { nodeId: node.id });
			throw err;
		}
	}

	private _parseFunctionArgs(argsStr: string, context: Record<string, any>): { args: any[]; kwargs: Record<string, any> } {
		const trimmed = argsStr.trim();
		if (!trimmed) return { args: [], kwargs: {} };

		const rawParts: string[] = [];
		let current = '';
		let inQuote: string | null = null;
		let depthParen = 0;
		let depthBrace = 0;
		let depthBracket = 0;

		for (let i = 0; i < trimmed.length; i++) {
			const ch = trimmed[i];
			if (inQuote) {
				current += ch;
				if (ch === inQuote && trimmed[i - 1] !== '\\') {
					inQuote = null;
				}
			} else {
				if (ch === '"' || ch === "'") {
					inQuote = ch;
					current += ch;
				} else if (ch === '(') {
					depthParen++;
					current += ch;
				} else if (ch === ')') {
					depthParen--;
					current += ch;
				} else if (ch === '{') {
					depthBrace++;
					current += ch;
				} else if (ch === '}') {
					depthBrace--;
					current += ch;
				} else if (ch === '[') {
					depthBracket++;
					current += ch;
				} else if (ch === ']') {
					depthBracket--;
					current += ch;
				} else if (ch === ',' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
					rawParts.push(current.trim());
					current = '';
				} else {
					current += ch;
				}
			}
		}
		if (current.trim().length > 0) {
			rawParts.push(current.trim());
		}

		const args: any[] = [];
		const kwargs: Record<string, any> = {};

		for (const part of rawParts) {
			const s = part.trim();
			// Match keyword arg: key = value (not ==, !=, <=, >=)
			const kwMatch = s.match(/^([a-zA-Z0-9_]+)\s*=(?!=)\s*([\s\S]*)$/);
			if (kwMatch && !s.startsWith('==') && !s.startsWith('!=') && !s.startsWith('<=') && !s.startsWith('>=')) {
				const k = kwMatch[1];
				const v = this._evaluateArgument(kwMatch[2], context);
				kwargs[k] = v;
			} else {
				args.push(this._evaluateArgument(s, context));
			}
		}

		return { args, kwargs };
	}

	private _evaluateArgument(arg: string, context: Record<string, any>): any {
		const s = arg.trim();
		if (!s) return undefined;

		// Single string literals (including Python f-strings like f"Task {start}")
		const isFStr = (s.startsWith('f"') || s.startsWith('F"') || s.startsWith("f'") || s.startsWith("F'")) && s.length >= 3;
		const strCand = isFStr ? s.substring(1) : s;
		if ((strCand.startsWith('"') && strCand.endsWith('"')) || (strCand.startsWith("'") && strCand.endsWith("'"))) {
			const quote = strCand[0];
			let isSingleLiteral = true;
			for (let i = 1; i < strCand.length - 1; i++) {
				if (strCand[i] === '\\') {
					i++;
				} else if (strCand[i] === quote) {
					isSingleLiteral = false;
					break;
				}
			}
			if (isSingleLiteral) {
				const rawInner = strCand.slice(1, -1);
				return PythonExpressionEvaluator.interpolateString(rawInner, context);
			}
		}
		// Numbers
		if (/^-?\d+(?:\.\d+)?$/.test(s)) {
			return Number(s);
		}
		// Booleans & Null
		if (s === 'true') return true;
		if (s === 'false') return false;
		if (s === 'null' || s === 'None') return null;

		// Direct variable reference (with or without @) or property path
		const cleanRef = s.startsWith('@') ? s.substring(1).trim() : s;

		// Check property path (e.g. new_ticket.outputs, @new_ticket.fields)
		if (cleanRef.includes('.')) {
			const parts = cleanRef.split('.');
			const rootVar = parts[0];
			let val = context[rootVar] !== undefined ? context[rootVar] : context[`@${rootVar}`];
			if (val !== undefined) {
				for (let i = 1; i < parts.length; i++) {
					if (val === undefined || val === null) break;
					val = val[parts[i]];
				}
				if (val !== undefined) return val;
			}
		}

		// Direct variable lookup in context (with or without @)
		if (context[cleanRef] !== undefined) {
			return context[cleanRef];
		}
		if (context[`@${cleanRef}`] !== undefined) {
			return context[`@${cleanRef}`];
		}
		if (context[s] !== undefined) {
			return context[s];
		}

		// JSON Object / Array literal
		if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
			try {
				const replaced = s.replace(/@?([a-zA-Z0-9_\u4e00-\u9fa5]+)/g, (fullMatch, name) => {
					const val = context[name] !== undefined ? context[name] : context[`@${name}`];
					return val !== undefined ? JSON.stringify(val) : fullMatch;
				});
				const fixedJson = replaced.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
				return JSON.parse(fixedJson);
			} catch {
				// Fallback to python evaluator
			}
		}

		try {
			const evalr = new PythonExpressionEvaluator(s, context);
			return evalr.evaluate();
		} catch {
			return s;
		}
	}

	private _stripInternalDisplayMeta(val: any): any {
		if (val === null || val === undefined || typeof val !== 'object') {
			return val;
		}
		if (Array.isArray(val)) {
			return val.map(item => this._stripInternalDisplayMeta(item));
		}
		const cleaned: Record<string, any> = {};
		for (const [k, v] of Object.entries(val)) {
			if (k.startsWith('__') || k === 'outputSpecs' || k === 'output_specs') {
				continue;
			}
			cleaned[k] = this._stripInternalDisplayMeta(v);
		}
		return cleaned;
	}

	private _formatDisplayOutput(displayVal: any): {
		formattedText: string;
		summaryType: string;
		cleanValue: any;
		ticketTitle?: string;
		ticketId?: string;
		ticketType?: string;
		outputItems?: IWorkflowDisplayOutputItem[];
		ticketHandle?: ITicketHandleInfo;
	} {
		if (displayVal === undefined) {
			return { formattedText: 'undefined', summaryType: 'undefined', cleanValue: undefined };
		}
		if (displayVal === null) {
			return { formattedText: 'null', summaryType: 'null', cleanValue: null };
		}

		// 1. Check if displayVal is a newly created Ticket Handle (descriptor from CREATE_TICKETS)
		const isTicketHandle = typeof displayVal === 'object' && displayVal !== null && !Array.isArray(displayVal) && (
			displayVal.isHandle === true
		);

		if (isTicketHandle) {
			const ticketId = String(displayVal.ticketId || '');
			const ticketName = String(displayVal.ticketName || ticketId);
			const ticketType = String(displayVal.ticketType || 'ticket');
			const title = String(displayVal.title || ticketName || ticketId);
			const status = String(displayVal.status || 'Todo');
			const createdAt = String(displayVal.createdAt || new Date().toLocaleString());
			const targetFolder = String(displayVal.targetFolder || '');
			const parameters = (displayVal.parameters && typeof displayVal.parameters === 'object') ? displayVal.parameters : {};

			const ticketHandle: ITicketHandleInfo = {
				ticketId,
				ticketName,
				ticketType,
				title,
				status,
				createdAt,
				targetFolder,
				parameters,
				isCreated: true
			};

			const lines: string[] = [
				`[TICKET CREATED] ${ticketId} [${ticketType}]`,
				`Title: ${title}`,
				`Status: ${status}`,
				`Created: ${createdAt}`
			];
			if (targetFolder) lines.push(`Path: ${targetFolder}`);
			if (Object.keys(parameters).length > 0) {
				lines.push(`Parameters: ${JSON.stringify(parameters, null, 2)}`);
			}
			lines.push(`(Ticket ready. Call RUN_TICKETS to execute.)`);

			return {
				formattedText: lines.join('\n'),
				summaryType: `ticket_handle [${ticketType}]`,
				cleanValue: displayVal,
				ticketTitle: title,
				ticketId,
				ticketType,
				ticketHandle
			};
		}

		// 2. Every display() call renders its complete value as a single unified block (never splitting a dict/JSON into per-key sub-cards)
		if (typeof displayVal === 'string') {
			const trimmed = displayVal.trim();
			if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
				try {
					const parsed = JSON.parse(trimmed);
					const cleanParsed = this._stripInternalDisplayMeta(parsed);
					return {
						formattedText: JSON.stringify(cleanParsed, null, 2),
						summaryType: Array.isArray(cleanParsed)
							? `json array [${cleanParsed.length}]`
							: (typeof cleanParsed === 'object' && cleanParsed !== null ? `json object {${Object.keys(cleanParsed).length} keys}` : `string (${displayVal.length} chars)`),
						cleanValue: cleanParsed
					};
				} catch {
					// Not valid JSON, fall through to plain string
				}
			}
			return { formattedText: displayVal, summaryType: `string (${displayVal.length} chars)`, cleanValue: displayVal };
		}

		if (typeof displayVal === 'number' || typeof displayVal === 'boolean') {
			return { formattedText: String(displayVal), summaryType: typeof displayVal, cleanValue: displayVal };
		}

		// 3. Python Dictionary / JSON Object or List / Array -> always render as a single complete formatted JSON block
		const ticketId = displayVal?.__ticketMetadata?.ticketId || '';
		const ticketTitle = displayVal?.__ticketMetadata?.title || displayVal?.__ticketMetadata?.ticketName || '';
		const ticketType = displayVal?.__ticketMetadata?.ticketType || '';
		const cleanVal = this._stripInternalDisplayMeta(displayVal);

		return {
			formattedText: JSON.stringify(cleanVal, null, 2),
			summaryType: Array.isArray(cleanVal)
				? `array [${cleanVal.length}]`
				: `object {${Object.keys(cleanVal || {}).length} keys}`,
			cleanValue: cleanVal,
			ticketTitle: ticketTitle || undefined,
			ticketId: ticketId || undefined,
			ticketType: ticketType || undefined
		};
	}

	private _extractPrimitiveCleanValue(rawMeta: any, defaultFormat?: string): any {
		if (rawMeta === undefined || rawMeta === null) return undefined;
		if (typeof rawMeta === 'string') {
			const trimmed = rawMeta.trim();
			if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
				try {
					const parsed = JSON.parse(trimmed);
					// Python primitive
					if (parsed.pythonCode !== undefined || parsed.code !== undefined || parsed.pythonPath !== undefined) {
						if (parsed.result !== undefined) {
							return parsed.result;
						}
						return parsed.output && parsed.output.trim()
							? parsed.output
							: (parsed.code || '(Python script ready)');
					}
					// Browser primitive
					if (parsed.content !== undefined) {
						return parsed.content;
					}
					// Prompt primitive
					if (parsed.prompt !== undefined || parsed.output !== undefined) {
						return parsed.output && parsed.output.trim()
							? parsed.output
							: '(Pending AI Execution - Run ticket to generate output)';
					}
					// Output / Result primitive
					if (parsed.result !== undefined) {
						return parsed.result;
					}
					return parsed;
				} catch { }
			}
		}
		return rawMeta;
	}

	private async _resolveNextNodes(
		run: IWorkflowExecutionRun,
		currentNode: IFlowchartNode,
		data: IFlowchartData,
		pathStep?: IWorkflowPathStep,
		isSelectiveMode: boolean = false
	): Promise<IFlowchartNode[]> {
		const outgoingLinks = data.links.filter(l => l.from === currentNode.id);
		if (outgoingLinks.length === 0) {
			return [];
		}

		// Check if any outgoing link has explicit condition labels or expressions
		const conditionalLinks = outgoingLinks.filter(l => (l.label || '').trim().length > 0);

		if (conditionalLinks.length > 0) {
			this._emitLog(run, 'info', `Evaluating condition(s) on ${outgoingLinks.length} outgoing branch(es) from '${currentNode.label}'`);
			const matchedNodes: IFlowchartNode[] = [];
			let firstConditionError: string | undefined = undefined;
			if (!run.linkStates) run.linkStates = {};

			for (const link of outgoingLinks) {
				const linkKey = link.id || `${link.from}->${link.to}`;
				const rawLabel = (link.label || '').trim();
				if (!rawLabel) continue;

				let condResult: boolean | null = null;
				let conditionError: string | undefined = undefined;
				try {
					const lowerLabel = rawLabel.toLowerCase();
					const posKw = new Set(['true', 'yes', 'success', 'pass', 'continue', 'ok', 'always']);
					const negKw = new Set(['false', 'no', 'fail', 'reject']);
					if (posKw.has(lowerLabel)) {
						condResult = true;
					} else if (negKw.has(lowerLabel)) {
						const ns = run.nodeStates[currentNode.id];
						condResult = Boolean(ns && (ns.status === 'failed' || ns.output?.approved === false || ns.output?.action === 'rejected'));
					} else if (this._pythonKernels.has(run.runId)) {
						const pyRes = await this._executeInPythonKernel(run, currentNode, -1, run.nodeStates[currentNode.id], pathStep, rawLabel, 'eval');
						condResult = Boolean(pyRes);
					} else {
						condResult = this._evaluateCondition(rawLabel, run.contextVariables, run.nodeStates[currentNode.id], run);
					}
				} catch (err: any) {
					conditionError = err.message || String(err);
					if (!firstConditionError) firstConditionError = conditionError;
				}

				const target = data.nodes.find(n => n.id === link.to);
				const explanation = this._explainCondition(rawLabel, run.contextVariables, condResult);

				if (conditionError) {
					run.linkStates[linkKey] = {
						linkId: link.id,
						fromNodeId: link.from,
						toNodeId: link.to,
						status: 'error',
						conditionLabel: rawLabel,
						evaluationResult: false,
						error: conditionError,
						explanation: `Syntax/Evaluation Error: ${conditionError}`
					};
					if (link.id) run.linkStates[`${link.from}->${link.to}`] = run.linkStates[linkKey];
				} else if (condResult === true) {
					run.linkStates[linkKey] = {
						linkId: link.id,
						fromNodeId: link.from,
						toNodeId: link.to,
						status: 'passed',
						conditionLabel: rawLabel,
						evaluationResult: true,
						explanation: explanation
					};
					if (link.id) run.linkStates[`${link.from}->${link.to}`] = run.linkStates[linkKey];

					if (target) {
						this._emitLog(run, 'info', `Condition MATCHED: '${link.label}' -> navigating to '${target.label}' (${explanation})`);
						matchedNodes.push(target);
						if (pathStep && !pathStep.transition) {
							pathStep.transition = {
								fromNodeId: currentNode.id,
								fromNodeLabel: currentNode.label,
								toNodeId: target.id,
								toNodeLabel: target.label,
								conditionLabel: rawLabel,
								conditionEvaluation: true,
								explanation: explanation
							};
						}
					}
				} else if (condResult === false) {
					run.linkStates[linkKey] = {
						linkId: link.id,
						fromNodeId: link.from,
						toNodeId: link.to,
						status: 'rejected',
						conditionLabel: rawLabel,
						evaluationResult: false,
						explanation: explanation
					};
					if (link.id) run.linkStates[`${link.from}->${link.to}`] = run.linkStates[linkKey];
					this._emitLog(run, 'info', `Condition REJECTED: '${link.label}' (${explanation})`);
				}
			}

			if (matchedNodes.length > 0) {
				return matchedNodes;
			}

			// If no conditional link matched, check if there is an unlabelled / default fallback link
			const unlabelled = outgoingLinks.filter(l => !(l.label || '').trim());
			if (unlabelled.length > 0) {
				const fallbackNodes = unlabelled
					.map(l => data.nodes.find(n => n.id === l.to))
					.filter((n): n is IFlowchartNode => !!n);
				this._emitLog(run, 'info', `Fallback branch(es) taken -> navigating to ${fallbackNodes.map(n => `'${n.label}'`).join(', ')}`);
				if (fallbackNodes.length > 0 && pathStep && !pathStep.transition) {
					pathStep.transition = {
						fromNodeId: currentNode.id,
						fromNodeLabel: currentNode.label,
						toNodeId: fallbackNodes[0].id,
						toNodeLabel: fallbackNodes[0].label,
						conditionLabel: 'default fallback',
						conditionEvaluation: true,
						explanation: 'Fallback branch taken'
					};
				}
				return fallbackNodes;
			}

			if (isSelectiveMode && !firstConditionError) {
				return [];
			}

			// Execution BLOCKED: No outgoing branch condition was satisfied!
			const blockMsg = firstConditionError
				? `Condition error on branch from '${currentNode.label}': ${firstConditionError}`
				: `No outgoing branch condition was satisfied from '${currentNode.label}'. Execution stopped.`;

			if (run.nodeStates[currentNode.id]) {
				run.nodeStates[currentNode.id].status = 'failed';
				run.nodeStates[currentNode.id].error = blockMsg;
			}
			if (pathStep) {
				pathStep.status = 'failed';
				pathStep.error = blockMsg;
			}
			run.status = 'failed';
			run.error = blockMsg;

			// Highlight all unsatisfied outgoing links as error / blocked
			for (const l of outgoingLinks) {
				const key = l.id || `${l.from}->${l.to}`;
				if (run.linkStates[key]) {
					run.linkStates[key].status = 'error';
					if (!run.linkStates[key].error) {
						run.linkStates[key].error = `Condition '${l.label}' not satisfied, execution blocked here.`;
					}
					if (l.id) run.linkStates[`${l.from}->${l.to}`] = run.linkStates[key];
				}
			}

			this._emitLog(run, 'error', `Execution BLOCKED: ${blockMsg}`);
			this._notifyRunChanged(run);
			return [];
		}

		if (outgoingLinks.length === 1) {
			const targetId = outgoingLinks[0].to;
			const target = data.nodes.find(n => n.id === targetId);
			if (target && pathStep && !pathStep.transition) {
				pathStep.transition = {
					fromNodeId: currentNode.id,
					fromNodeLabel: currentNode.label,
					toNodeId: target.id,
					toNodeLabel: target.label,
					explanation: `Proceed to '${target.label}'`
				};
			}
			if (!run.linkStates) run.linkStates = {};
			const lKey = outgoingLinks[0].id || `${outgoingLinks[0].from}->${outgoingLinks[0].to}`;
			run.linkStates[lKey] = {
				linkId: outgoingLinks[0].id,
				fromNodeId: outgoingLinks[0].from,
				toNodeId: outgoingLinks[0].to,
				status: 'passed',
				evaluationResult: true
			};
			if (outgoingLinks[0].id) run.linkStates[`${outgoingLinks[0].from}->${outgoingLinks[0].to}`] = run.linkStates[lKey];
			return target ? [target] : [];
		}

		// Parallel Fork (Unconditional / Fan-Out):
		const targetNodes = outgoingLinks
			.map(l => data.nodes.find(n => n.id === l.to))
			.filter((n): n is IFlowchartNode => !!n);
		if (targetNodes.length > 0 && pathStep && !pathStep.transition) {
			pathStep.transition = {
				fromNodeId: currentNode.id,
				fromNodeLabel: currentNode.label,
				toNodeId: targetNodes[0].id,
				toNodeLabel: targetNodes.map(t => t.label).join(', '),
				explanation: `Parallel fan-out to ${targetNodes.length} nodes`
			};
		}
		return targetNodes;
	}

	private _explainCondition(expr: string, context: Record<string, any>, result: boolean): string {
		const varMatches = expr.match(/@?[a-zA-Z0-9_]+/g);
		const varVals: Record<string, any> = {};
		if (varMatches) {
			for (const rawVar of varMatches) {
				const clean = rawVar.replace(/^@/, '');
				if (context[clean] !== undefined && typeof context[clean] !== 'function') {
					varVals[clean] = context[clean];
				}
			}
		}
		const varInfo = Object.entries(varVals)
			.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
			.join(', ');
		const truthStr = result ? 'TRUE' : 'FALSE';
		return varInfo ? `${expr} (${varInfo}) => ${truthStr}` : `${expr} => ${truthStr}`;
	}

	private _evaluateCondition(
		expr: string,
		context: Record<string, any>,
		nodeState?: IWorkflowNodeExecutionState,
		run?: IWorkflowExecutionRun
	): boolean | null {
		const raw = expr.trim();
		if (!raw) return null;

		// 1. Check standard boolean and status keywords
		const lower = raw.toLowerCase();
		const positiveKeywords = new Set(['true', 'yes', 'success', 'pass', 'continue', 'ok', 'always']);
		if (positiveKeywords.has(lower)) {
			return true;
		}
		const negativeKeywords = new Set(['false', 'no', 'fail', 'reject']);
		if (negativeKeywords.has(lower)) {
			if (nodeState && (nodeState.status === 'failed' || nodeState.output?.approved === false || nodeState.output?.action === 'rejected')) {
				return true;
			}
			return false;
		}

		// 2. Evaluate using pure Python expression evaluator (no eval / new Function)
		try {
			const evaluator = new PythonExpressionEvaluator(raw, context);
			const res = evaluator.evaluate();
			if (typeof res === 'boolean') {
				return res;
			}
			if (res !== undefined && res !== null) {
				return Boolean(res);
			}
		} catch (err: any) {
			if (run) {
				this._emitLog(run, 'error', `[Condition Syntax Error] Failed to evaluate condition '${raw}': ${err.message}`);
			}
			throw err;
		}

		return null;
	}

	private _evaluateExpressionOrLiteral(expr: string, context: Record<string, any>): any {
		const evaluator = new PythonExpressionEvaluator(expr, context);
		return evaluator.evaluate();
	}

	private _resolveValue(token: string, context: Record<string, any>): any {
		try {
			const trimmed = (token || '').trim();
			if (!trimmed || trimmed === 'None' || trimmed === 'null') return undefined;
			if (trimmed.startsWith('+=') || trimmed.startsWith('-=')) {
				const num = Number(trimmed.substring(2).trim());
				return isNaN(num) ? 0 : num;
			}
			const evaluator = new PythonExpressionEvaluator(trimmed, context);
			return evaluator.evaluate();
		} catch {
			return undefined;
		}
	}

	private _getNodeVars(node: IFlowchartNode): { name: string; initialValue?: string; expression?: string; currentValue?: any }[] {
		const rawVars: { name: string; initialValue?: string; expression?: string; currentValue?: any }[] = [];
		if (Array.isArray(node.outputVariables) && node.outputVariables.length > 0) {
			rawVars.push(...node.outputVariables);
		} else if (node.outputVariable && node.outputVariable.name) {
			rawVars.push(node.outputVariable);
		}

		// Deduplicate by name, preserving valid initialValue and expression
		const map = new Map<string, { name: string; initialValue?: string; expression?: string; currentValue?: any }>();
		for (const v of rawVars) {
			if (v && v.name) {
				const clean = v.name.replace(/^@/, '').trim();
				const existing = map.get(clean);
				if (!existing) {
					map.set(clean, { ...v, name: clean });
				} else {
					map.set(clean, {
						...existing,
						...v,
						name: clean,
						initialValue: (v.initialValue && v.initialValue !== 'None' && !/^(\+\=|\-\=|\*\=|\/\=)/.test(v.initialValue)) ? v.initialValue : existing.initialValue,
						expression: v.expression || existing.expression
					});
				}
			}
		}
		return Array.from(map.values());
	}

	private _findEntryNode(data: IFlowchartData, entryNodeId?: string): IFlowchartNode | undefined {
		if (entryNodeId) {
			const node = data.nodes.find(n => n.id === entryNodeId);
			if (node) return node;
		}

		// Find all candidate entry nodes (0 incoming links and not an End/diamond node)
		const targetIds = new Set(data.links.map(l => l.to));
		const entryCandidates = data.nodes.filter(n => !targetIds.has(n.id) && n.type !== 'diamond' && !this._isEndNode(n));
		if (entryCandidates.length === 1) {
			return entryCandidates[0];
		}
		if (entryCandidates.length > 1) {
			// If multiple entry nodes exist and one was recently clicked/selected by the user, prefer that one
			const byClickTime = [...entryCandidates]
				.filter(n => typeof (n as any)._lastClickTime === 'number' && (n as any)._lastClickTime > 0)
				.sort((a, b) => ((b as any)._lastClickTime || 0) - ((a as any)._lastClickTime || 0));
			if (byClickTime.length > 0) {
				return byClickTime[0];
			}
			const startCircles = entryCandidates.filter(n => n.type === 'circle' && /start|debug/i.test(n.label || ''));
			if (startCircles.length === 1) {
				return startCircles[0];
			}
			return entryCandidates[0];
		}

		// Fallback: look for circle Start node
		const startCircle = data.nodes.find(n =>
			n.type === 'circle' && n.label.toLowerCase() === 'start'
		);
		if (startCircle) return startCircle;

		return data.nodes[0];
	}

	private _isEndNode(node: IFlowchartNode): boolean {
		const label = (node.label || '').trim().toLowerCase();
		return (node.type === 'circle' && (label === 'end' || label === 'stop' || label === 'exit' || label === 'finish')) ||
			label === 'end' || label === 'stop' || label === 'finish' || label === 'exit' || label === 'quit';
	}

	private async _loadFlowchartData(uriStr: string, options?: IWorkflowEngineOptions): Promise<IFlowchartData | undefined> {
		// 1. Direct in-memory data passed from options (e.g. from active editor canvas)
		if (options?.initialData && Array.isArray(options.initialData.nodes) && options.initialData.nodes.length > 0) {
			return options.initialData;
		}

		// 2. Load from Entity Persistence Snapshot
		const snapshot = this.entityPersistenceService.getSnapshot(uriStr);
		if (snapshot?.customMetadata?.['flowchartJson']) {
			try {
				const parsed = JSON.parse(snapshot.customMetadata['flowchartJson']);
				if (Array.isArray(parsed.nodes)) return parsed;
			} catch (e) {
				this.logService.error('[WorkflowExecution] Failed to parse flowchartJson from snapshot:', e);
			}
		}

		// 3. Load from File System (for .diagram.json, .workflow, or any file:// URI)
		try {
			const uri = URI.parse(uriStr);
			if (await this.fileService.exists(uri)) {
				const fileContent = await this.fileService.readFile(uri);
				const parsed = JSON.parse(fileContent.value.toString());
				if (Array.isArray(parsed.nodes)) {
					return {
						nodes: parsed.nodes,
						links: Array.isArray(parsed.links) ? parsed.links : Array.isArray(parsed.connections) ? parsed.connections : Array.isArray(parsed.edges) ? parsed.edges : [],
						pythonPath: parsed.pythonPath
					};
				}
				if (parsed?.customMetadata?.['flowchartJson']) {
					return JSON.parse(parsed.customMetadata['flowchartJson']);
				}
				if (parsed?.flowchartJson) {
					return typeof parsed.flowchartJson === 'string' ? JSON.parse(parsed.flowchartJson) : parsed.flowchartJson;
				}
			}
		} catch (e) {
			this.logService.error('[WorkflowExecution] Failed to load flowchart from file:', e);
		}

		return undefined;
	}

	private _resolveWorkflowName(uriStr: string): string {
		const snapshot = this.entityPersistenceService.getSnapshot(uriStr);
		if (snapshot?.entityName || snapshot?.title) {
			return snapshot.entityName || snapshot.title || 'Workflow';
		}
		try {
			const uri = URI.parse(uriStr);
			const base = uri.path.split('/').filter(Boolean).pop() || 'Workflow';
			return decodeURIComponent(base.replace(/\.diagram\.json$/, '').replace(/\.flowchart\.json$/, '').replace(/\.workflow$/, '').replace(/\.json$/, ''));
		} catch {
			return 'Workflow';
		}
	}

	private _emitLog(run: IWorkflowExecutionRun, level: IWorkflowLogEntry['level'], message: string, data?: any): void {
		const safeMessage = typeof message === 'string' && message.length > 1200
			? message.substring(0, 1200) + ' ... [truncated]'
			: message;
		const log: IWorkflowLogEntry = {
			id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
			timestamp: Date.now(),
			level,
			nodeId: data?.nodeId || run.currentNodeId,
			ticketId: data?.ticketId,
			message: safeMessage,
			data
		};
		run.logs.push(log);
		run.updatedAt = Date.now();
		this._onDidEmitLog.fire({ runId: run.runId, log });
	}

	private _notifyRunChanged(run: IWorkflowExecutionRun): void {
		run.updatedAt = Date.now();
		this._onDidChangeRunState.fire(run);
		this._schedulePersist(run.workflowUri);
	}

	private readonly _nodeComponentPersistDebounceMap = new Map<string, any>();

	private async _persistAndNotifyNodeComponents(run: IWorkflowExecutionRun, node: IFlowchartNode): Promise<void> {
		this._onDidUpdateNodeComponents.fire({
			workflowUri: run.workflowUri,
			nodeId: node.id,
			node
		});

		const debounceKey = `${run.workflowUri}::${node.id}`;
		if (this._nodeComponentPersistDebounceMap.has(debounceKey)) {
			clearTimeout(this._nodeComponentPersistDebounceMap.get(debounceKey));
		}
		const timer = setTimeout(async () => {
			this._nodeComponentPersistDebounceMap.delete(debounceKey);
			try {
				const rawWsUri = URI.parse(run.workflowUri);
				const isFile = rawWsUri.path.endsWith('.json') || rawWsUri.path.endsWith('.workflow');
				const workflowDir = isFile ? URI.joinPath(rawWsUri, '..') : rawWsUri;
				const flowchartFileUri = URI.joinPath(workflowDir, '.agents', 'workflow_flowchart.json');

				if (await this.fileService.exists(flowchartFileUri)) {
					const rawContent = await this.fileService.readFile(flowchartFileUri);
					const parsed = JSON.parse(rawContent.value.toString());
					if (parsed && Array.isArray(parsed.nodes)) {
						const targetNode = parsed.nodes.find((n: any) => n && n.id === node.id);
						if (targetNode && Array.isArray(targetNode.pipeline) && Array.isArray(node.pipeline)) {
							for (const srcStep of node.pipeline) {
								const srcComp = (srcStep as any).component;
								if (!srcComp) continue;
								const dstStep = targetNode.pipeline.find((s: any) =>
									(s && s.id && s.id === srcStep.id) ||
									(s && s.component && s.component.id && s.component.id === srcComp.id)
								);
								if (dstStep) {
									dstStep.component = { ...(dstStep.component || {}), ...srcComp };
								}
							}
							await this.fileService.writeFile(
								flowchartFileUri,
								VSBuffer.fromString(JSON.stringify(parsed, null, 2))
							);
						}
					}
				}
			} catch (err) {
				this.logService.warn('[WorkflowExecution] Failed to persist updated node components:', err);
			}
		}, 450);
		this._nodeComponentPersistDebounceMap.set(debounceKey, timer);
	}

	private async _startPythonKernel(run: IWorkflowExecutionRun, customPythonPath?: string): Promise<void> {
		try {
			const rawWsUri = URI.parse(run.workflowUri);
			const workflowDir = rawWsUri.path.endsWith('.workflow.json') || rawWsUri.path.endsWith('.json') || rawWsUri.path.endsWith('.workflow')
				? URI.joinPath(rawWsUri, '..')
				: rawWsUri;

			const envInfo = await this.ticketRuntimeService.detectPythonEnvironment(workflowDir, customPythonPath);
			const pythonPath = typeof envInfo === 'string'
				? envInfo
				: (envInfo?.interpreterPath || customPythonPath || 'python3');
			const tmpRoot = (typeof process !== 'undefined' && process.env && (process.env.TMPDIR || process.env.TEMP))
				? (process.env.TMPDIR || process.env.TEMP)!.replace(/\/+$/, '')
				: '/tmp';
			const kernelDir = URI.file(`${tmpRoot}/anyagent_wf_kernel_${run.runId}`);
			if (!(await this.fileService.exists(kernelDir))) {
				await this.fileService.createFolder(kernelDir);
			}

			// Prepare initial context variables
			const initVars: Record<string, any> = {};
			for (const [k, v] of Object.entries(run.contextVariables || {})) {
				if (!k.startsWith('@') && !WorkflowExecutionService.RESERVED_CONTEXT_ALIAS_KEYS.has(k)) {
					initVars[k] = v;
				}
			}
			await this.fileService.writeFile(
				URI.joinPath(kernelDir, 'init_context.json'),
				VSBuffer.fromString(JSON.stringify(initVars, null, 2))
			);

			const kernelPyContent = String.raw`# -*- coding: utf-8 -*-
import sys, os, json, time, traceback, datetime, re, io

KERNEL_DIR = sys.argv[1]
CMD_FILE = os.path.join(KERNEL_DIR, "cmd.json")
CMD_RES_FILE = os.path.join(KERNEL_DIR, "cmd_res.json")
RPC_REQ_FILE = os.path.join(KERNEL_DIR, "rpc_req.json")
RPC_RES_FILE = os.path.join(KERNEL_DIR, "rpc_res.json")
READY_FILE = os.path.join(KERNEL_DIR, "ready.flag")

class _AttrDict(dict):
    @staticmethod
    def _find_matching_key(d, key):
        if not isinstance(d, dict):
            return False, None
        if dict.__contains__(d, key):
            return True, dict.__getitem__(d, key)
        if isinstance(key, str):
            aliases = dict.get(d, "__field_aliases__")
            if isinstance(aliases, dict) and key in aliases:
                mapped_key = aliases[key]
                if dict.__contains__(d, mapped_key):
                    return True, dict.__getitem__(d, mapped_key)
            norm = key.strip().lower().replace("_", " ")
            for k, v in dict.items(d):
                if isinstance(k, str) and not k.startswith("__") and k.strip().lower().replace("_", " ") == norm:
                    return True, v
            if len(norm) >= 4:
                prefix_matches = [
                    k for k in dict.keys(d)
                    if isinstance(k, str) and not k.startswith("__") and (
                        k.strip().lower().replace("_", " ").startswith(norm) or
                        norm.startswith(k.strip().lower().replace("_", " "))
                    )
                ]
                if len(prefix_matches) == 1:
                    return True, dict.__getitem__(d, prefix_matches[0])
        return False, None

    def __getattr__(self, key):
        if isinstance(key, str) and key.startswith("__") and key.endswith("__"):
            raise AttributeError(key)
        found, val = _AttrDict._find_matching_key(self, key)
        if found:
            return val
        outputs = dict.get(self, "outputs")
        found, val = _AttrDict._find_matching_key(outputs, key)
        if found:
            return val
        fields = dict.get(self, "fields")
        found, val = _AttrDict._find_matching_key(fields, key)
        if found:
            return val
        raise AttributeError(f"Object has no attribute '{key}'")

    def __setattr__(self, key, value):
        dict.__setitem__(self, key, value)

    def __getitem__(self, key):
        found, val = _AttrDict._find_matching_key(self, key)
        if found:
            return val
        outputs = dict.get(self, "outputs")
        found, val = _AttrDict._find_matching_key(outputs, key)
        if found:
            return val
        fields = dict.get(self, "fields")
        found, val = _AttrDict._find_matching_key(fields, key)
        if found:
            return val
        raise KeyError(key)

def _wrap_val(v):
    if isinstance(v, dict):
        return _AttrDict({k: _wrap_val(val) for k, val in v.items()})
    elif isinstance(v, list):
        return [_wrap_val(x) for x in v]
    return v

def _resolve_template_val(val):
    if isinstance(val, str) and "{" in val and "}" in val:
        def _repl(m):
            expr = m.group(1).strip()
            if not expr:
                return m.group(0)
            if expr.startswith("@"):
                expr = expr[1:].strip()
            try:
                res = eval(expr, wf_globals)
                return "" if res is None else str(res)
            except Exception:
                return m.group(0)
        return re.sub(r"\{([^{}]+)\}", _repl, val)
    elif isinstance(val, dict):
        return {k: _resolve_template_val(v) for k, v in val.items()}
    elif isinstance(val, list):
        return [_resolve_template_val(x) for x in val]
    return val

current_cmd_id = None
current_step_lines = []
last_active_ts = time.time()

def _rpc_call(fn_name, args, kwargs):
    global last_active_ts
    last_active_ts = time.time()
    req_id = f"rpc_{int(time.time() * 1000)}_{os.urandom(3).hex()}"
    resolved_args = list(args) if fn_name == "DISPLAY" else [_resolve_template_val(a) for a in args]
    resolved_kwargs = dict(kwargs) if fn_name == "DISPLAY" else {k: _resolve_template_val(v) for k, v in kwargs.items()}
    call_expr = ""
    if fn_name == "DISPLAY":
        try:
            for frame in reversed(traceback.extract_stack()):
                if frame.filename == "<workflow_step>" and frame.lineno and 1 <= frame.lineno <= len(current_step_lines):
                    call_expr = current_step_lines[frame.lineno - 1].strip()
                    break
        except Exception:
            pass
    payload = {"id": req_id, "cmd_id": current_cmd_id, "fn": fn_name, "args": resolved_args, "kwargs": resolved_kwargs, "call_expr": call_expr}
    try:
        if os.path.exists(RPC_RES_FILE):
            os.remove(RPC_RES_FILE)
    except OSError:
        pass
    tmp_req = RPC_REQ_FILE + ".tmp"
    with open(tmp_req, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, default=str)
    os.replace(tmp_req, RPC_REQ_FILE)

    while True:
        last_active_ts = time.time()
        if not os.path.exists(KERNEL_DIR):
            sys.exit(0)
        if os.path.exists(RPC_RES_FILE):
            try:
                with open(RPC_RES_FILE, "r", encoding="utf-8") as f:
                    res = json.load(f)
                if res.get("id") == req_id:
                    last_active_ts = time.time()
                    try:
                        if os.path.exists(RPC_REQ_FILE):
                            os.remove(RPC_REQ_FILE)
                    except OSError:
                        pass
                    if res.get("error"):
                        raise RuntimeError(res["error"])
                    return _wrap_val(res.get("result"))
            except (json.JSONDecodeError, OSError):
                pass
        time.sleep(0.025)

def RUN_TICKETS(*args, **kwargs):
    return _rpc_call("RUN_TICKETS", args, kwargs)

def CREATE_TICKETS(*args, **kwargs):
    return _rpc_call("CREATE_TICKETS", args, kwargs)

def GET_TICKETS(*args, **kwargs):
    return _rpc_call("GET_TICKETS", args, kwargs)

def GET_OUTPUTS(*args, **kwargs):
    return _rpc_call("GET_OUTPUTS", args, kwargs)

def GET_PRIMITIVES_CATALOG(*args, **kwargs):
    return _rpc_call("GET_PRIMITIVES_CATALOG", args, kwargs)

def DISPLAY(*args, **kwargs):
    return _rpc_call("DISPLAY", args, kwargs)

def DATE():
    return datetime.date.today().strftime("%Y-%m-%d")

def TODAY():
    return datetime.date.today().strftime("%Y-%m-%d")

def TIME():
    return datetime.datetime.now().strftime("%H:%M:%S")

def NOW():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def DATETIME():
    return datetime.datetime.now().isoformat()

def TIMESTAMP():
    return int(time.time() * 1000)

wf_globals = {
    "__builtins__": __builtins__,
    "RUN_TICKETS": RUN_TICKETS,
    "run_tickets": RUN_TICKETS,
    "CREATE_TICKETS": CREATE_TICKETS,
    "create_tickets": CREATE_TICKETS,
    "GET_TICKETS": GET_TICKETS,
    "get_tickets": GET_TICKETS,
    "GET_OUTPUTS": GET_OUTPUTS,
    "get_outputs": GET_OUTPUTS,
    "GET_PRIMITIVES_CATALOG": GET_PRIMITIVES_CATALOG,
    "get_primitives_catalog": GET_PRIMITIVES_CATALOG,
    "DISPLAY": DISPLAY,
    "display": DISPLAY,
    "DATE": DATE,
    "TODAY": TODAY,
    "TIME": TIME,
    "NOW": NOW,
    "DATETIME": DATETIME,
    "TIMESTAMP": TIMESTAMP,
    "true": True,
    "false": False,
    "null": None,
}
wf_globals["TICKET_CONTEXT"] = wf_globals
wf_globals["CONTEXT"] = wf_globals
wf_globals["ANY_AGENT_CONTEXT"] = wf_globals

RESERVED_KEYS = set(wf_globals.keys()) | {"__builtins__", "__name__", "__doc__", "__package__", "__loader__", "__spec__", "TICKET_CONTEXT", "CONTEXT", "ANY_AGENT_CONTEXT"}

init_ctx_path = os.path.join(KERNEL_DIR, "init_context.json")
if os.path.exists(init_ctx_path):
    try:
        with open(init_ctx_path, "r", encoding="utf-8") as f:
            init_data = json.load(f)
        if isinstance(init_data, dict):
            for k, v in init_data.items():
                if k in ("TICKET_CONTEXT", "CONTEXT", "ANY_AGENT_CONTEXT") or k.startswith("@"):
                    continue
                wf_globals[k] = _wrap_val(v)
    except Exception:
        pass
wf_globals["TICKET_CONTEXT"] = wf_globals
wf_globals["CONTEXT"] = wf_globals
wf_globals["ANY_AGENT_CONTEXT"] = wf_globals

def _sanitize_legacy_syntax(code):
    out = []
    i = 0
    n = len(code)
    in_str = None
    while i < n:
        ch = code[i]
        if in_str:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(code[i + 1])
                i += 2
                continue
            if len(in_str) == 3:
                if code[i:i+3] == in_str:
                    out.append(code[i+1])
                    out.append(code[i+2])
                    i += 3
                    in_str = None
                    continue
            elif ch == in_str:
                in_str = None
            i += 1
        else:
            if code[i:i+3] in ('"""', "'''"):
                in_str = code[i:i+3]
                out.append(in_str)
                i += 3
                continue
            if ch in ('"', "'"):
                in_str = ch
                out.append(ch)
                i += 1
                continue
            if ch == "#" and (i == 0 or code[i-1] != "$"):
                nl = code.find("\n", i)
                if nl == -1:
                    break
                i = nl
                continue
            if ch == "@" and i + 1 < n and (code[i+1].isalpha() or code[i+1] == "_"):
                i += 1
                continue
            m_tid = re.match(r"^([A-Z][A-Z0-9_]{1,12}-\d{3,6})\b", code[i:])
            if m_tid:
                tid = m_tid.group(1)
                out.append(f'"{tid}"')
                i += len(tid)
                continue
            out.append(ch)
            i += 1
    res = "".join(out)
    res = re.sub(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\+\+", r"\1 += 1", res)
    res = re.sub(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\s*--", r"\1 -= 1", res)
    # Normalize GET_OUTPUTS(ticket=..., 'Field') -> GET_OUTPUTS(ticket=..., field='Field')
    res = re.sub(
        r"\b(GET_OUTPUTS|get_outputs)\s*\(\s*((?:ticket_id|ticket|tickets|ticket_name)\s*=\s*[^,)]+?)\s*,\s*(?![a-zA-Z_][a-zA-Z0-9_]*\s*=)([^)]+)\)",
        r"\1(\2, field=\3)",
        res
    )
    # Normalize RUN_TICKETS(ticket=..., {...}) -> RUN_TICKETS(ticket=..., params={...})
    res = re.sub(
        r"\b(RUN_TICKETS|run_tickets)\s*\(\s*((?:ticket_id|ticket|tickets|ticket_name)\s*=\s*[^,)]+?)\s*,\s*(?![a-zA-Z_][a-zA-Z0-9_]*\s*=)(\{[\s\S]*?\})\s*\)",
        r"\1(\2, params=\3)",
        res
    )
    # Unwrap accidental single-variable template braces inside dict entries: "key": {var_name} -> "key": var_name
    res = re.sub(
        r'(["\'][^"\']+["\']\s*:\s*)\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}(?=\s*[,}])',
        r"\1\2",
        res
    )
    return res

def _export_vars():
    exported = {}
    for k, v in wf_globals.items():
        if k in RESERVED_KEYS or k.startswith("_") or k.startswith("@") or v is wf_globals:
            continue
        if callable(v) or isinstance(v, type) or hasattr(v, "__spec__"):
            continue
        try:
            json.dumps(v)
            exported[k] = v
        except Exception:
            exported[k] = repr(v)
    return exported

with open(READY_FILE, "w", encoding="utf-8") as f:
    f.write("ready")

last_cmd_id = None
INITIAL_PPID = os.getppid()
last_active_ts = time.time()

try:
    while True:
        if not os.path.exists(KERNEL_DIR):
            break
        if os.getppid() != INITIAL_PPID or os.getppid() <= 1:
            break
        if time.time() - last_active_ts > 604800:
            break
        if os.path.exists(CMD_FILE):
            try:
                with open(CMD_FILE, "r", encoding="utf-8") as f:
                    cmd = json.load(f)
                cmd_id = cmd.get("id")
                if not cmd_id or cmd_id == last_cmd_id:
                    time.sleep(0.025)
                    continue
                last_cmd_id = cmd_id
                current_cmd_id = cmd_id
                last_active_ts = time.time()
                action = cmd.get("action", "exec")
                if action == "shutdown":
                    break
                code = cmd.get("code", "")
                sync_vars = cmd.get("sync_vars")
                if isinstance(sync_vars, dict):
                    for sk, sv in sync_vars.items():
                        if sk in ("TICKET_CONTEXT", "CONTEXT", "ANY_AGENT_CONTEXT") or sk.startswith("@"):
                            continue
                        wf_globals[sk] = _wrap_val(sv)
                wf_globals["TICKET_CONTEXT"] = wf_globals
                wf_globals["CONTEXT"] = wf_globals
                wf_globals["ANY_AGENT_CONTEXT"] = wf_globals

                sanitized = _sanitize_legacy_syntax(code)
                current_step_lines = sanitized.splitlines()
                stdout_buf = io.StringIO()
                old_stdout = sys.stdout
                sys.stdout = stdout_buf
                eval_val = None
                err_msg = None
                try:
                    if action == "eval":
                        eval_val = eval(sanitized, wf_globals)
                    else:
                        try:
                            compiled = compile(sanitized, "<workflow_step>", "eval")
                            eval_val = eval(compiled, wf_globals)
                        except SyntaxError:
                            compiled = compile(sanitized, "<workflow_step>", "exec")
                            exec(compiled, wf_globals)
                except Exception as ex:
                    err_msg = f"{type(ex).__name__}: {ex}"
                finally:
                    sys.stdout = old_stdout
                    last_active_ts = time.time()

                printed = stdout_buf.getvalue()
                try:
                    json.dumps(eval_val)
                    safe_eval_val = eval_val
                except Exception:
                    safe_eval_val = repr(eval_val)

                res_payload = {
                    "id": cmd_id,
                    "ok": err_msg is None,
                    "value": safe_eval_val,
                    "stdout": printed,
                    "error": err_msg,
                    "variables": _export_vars()
                }
                tmp_res = CMD_RES_FILE + ".tmp"
                with open(tmp_res, "w", encoding="utf-8") as f:
                    json.dump(res_payload, f, ensure_ascii=False, default=str)
                os.replace(tmp_res, CMD_RES_FILE)
                last_active_ts = time.time()
            except (json.JSONDecodeError, OSError):
                pass
        time.sleep(0.03)
finally:
    try:
        if os.path.exists(READY_FILE):
            os.remove(READY_FILE)
    except OSError:
        pass
`;

			const kernelPyUri = URI.joinPath(kernelDir, 'kernel.py');
			await this.fileService.writeFile(kernelPyUri, VSBuffer.fromString(kernelPyContent));

			const terminal = await this.terminalService.createTerminal({
				config: {
					name: `Workflow Python Kernel (${run.runId})`,
					cwd: workflowDir.fsPath,
					hideFromUser: true
				}
			});

			const cmdLine = `"${pythonPath}" "${kernelPyUri.fsPath}" "${kernelDir.fsPath}"`;
			await terminal.sendText(cmdLine, true);

			// Wait up to 6s for ready.flag
			const readyUri = URI.joinPath(kernelDir, 'ready.flag');
			const startWait = Date.now();
			let isReady = false;
			while (Date.now() - startWait < 6000) {
				if (await this.fileService.exists(readyUri)) {
					isReady = true;
					break;
				}
				await new Promise(r => setTimeout(r, 60));
			}

			if (isReady) {
				const prevKernel = this._pythonKernels.get(run.runId);
				this._pythonKernels.set(run.runId, {
					kernelDir,
					pythonPath,
					terminal,
					reqCounter: prevKernel ? prevKernel.reqCounter : 0,
					stopped: false,
					handledRpcIds: prevKernel ? prevKernel.handledRpcIds : new Set<string>()
				});
				this._emitLog(run, 'info', `[Python Kernel] Started persistent Python runtime (${pythonPath})`);
			} else {
				try { terminal.dispose(); } catch { }
				this._emitLog(run, 'warn', `[Python Kernel] Timed out waiting for Python interpreter (${pythonPath}), falling back to built-in evaluator.`);
			}
		} catch (err: any) {
			this.logService.warn('[WorkflowExecution] Failed to start Python kernel:', err);
		}
	}

	private async _shutdownPythonKernel(runId: string): Promise<void> {
		const kernel = this._pythonKernels.get(runId);
		if (!kernel) return;
		kernel.stopped = true;
		this._pythonKernels.delete(runId);
		try {
			const cmdUri = URI.joinPath(kernel.kernelDir, 'cmd.json');
			await this.fileService.writeFile(cmdUri, VSBuffer.fromString(JSON.stringify({ id: 'shutdown', action: 'shutdown' })));
		} catch { }
		try {
			if (kernel.terminal) {
				try {
					kernel.terminal.sendText?.('\x03', false);
				} catch { }
				kernel.terminal.dispose();
			}
		} catch { }
		try {
			if (await this.fileService.exists(kernel.kernelDir)) {
				await this.fileService.del(kernel.kernelDir, { recursive: true });
			}
		} catch { }
	}

	private async _executeInPythonKernel(
		run: IWorkflowExecutionRun,
		node: IFlowchartNode,
		stepIndex: number,
		state: IWorkflowNodeExecutionState | undefined,
		pathStep: IWorkflowPathStep | undefined,
		code: string,
		mode: 'exec' | 'eval' = 'exec'
	): Promise<any> {
		let kernel = this._pythonKernels.get(run.runId);
		if (!kernel || kernel.stopped) {
			throw new Error('Python kernel is not running');
		}

		const trimmedCode = (code || '').trim();
		if (!trimmedCode) return undefined;

		// If the Python kernel process exited prematurely (e.g. ready.flag missing), automatically restart it
		const initialReadyUri = URI.joinPath(kernel.kernelDir, 'ready.flag');
		if (!(await this.fileService.exists(initialReadyUri))) {
			this._emitLog(run, 'warn', `[Python Kernel] Kernel process not ready; automatically restarting Python runtime...`, { nodeId: node.id });
			try { kernel.terminal?.dispose?.(); } catch { }
			await this._startPythonKernel(run, kernel.pythonPath);
			kernel = this._pythonKernels.get(run.runId);
			if (!kernel || kernel.stopped) {
				throw new Error('Failed to restart Python kernel');
			}
		}

		if (mode === 'exec' && stepIndex >= 0) {
			const singleLinePreview = trimmedCode.replace(/\r?\n/g, ' ↵ ');
			this._emitLog(run, 'info', `[Step #${stepIndex + 1} PY] Executing Python: ${singleLinePreview}`, { nodeId: node.id });
		}

		kernel.reqCounter++;
		const cmdId = `cmd_${kernel.reqCounter}_${Date.now()}`;
		const cmdUri = URI.joinPath(kernel.kernelDir, 'cmd.json');
		const cmdResUri = URI.joinPath(kernel.kernelDir, 'cmd_res.json');
		const rpcReqUri = URI.joinPath(kernel.kernelDir, 'rpc_req.json');
		const rpcResUri = URI.joinPath(kernel.kernelDir, 'rpc_res.json');

		// Sync any externally updated contextVariables (e.g. from run_ticket or component steps).
		// Note: TICKET_CONTEXT, CONTEXT, and ANY_AGENT_CONTEXT are already bound directly to wf_globals inside kernel.py,
		// so we must NOT duplicate fullCtx into syncVars under those keys (which previously caused recursive self-nesting and 3x payload bloat).
		const syncVars: Record<string, any> = {};
		for (const [k, v] of Object.entries(run.contextVariables || {})) {
			if (!k.startsWith('@') && !WorkflowExecutionService.RESERVED_CONTEXT_ALIAS_KEYS.has(k)) {
				syncVars[k] = v;
			}
		}

		// Clean up any leftover RPC / command response files before dispatching new command
		for (const staleUri of [rpcReqUri, rpcResUri, cmdResUri]) {
			try {
				if (await this.fileService.exists(staleUri)) {
					await this.fileService.del(staleUri);
				}
			} catch { }
		}

		await this.fileService.writeFile(
			cmdUri,
			VSBuffer.fromString(JSON.stringify({
				id: cmdId,
				action: mode,
				code: trimmedCode,
				sync_vars: syncVars
			}))
		);

		const handledRpcIds = kernel.handledRpcIds;
		const startMs = Date.now();
		let cmdResParseFailures = 0;
		const maxCmdResParseFailures = 5;
		while (!kernel.stopped && !this._cancelledRuns.has(run.runId)) {
			// 1. Check if Python kernel requested a built-in RPC function call
			if (await this.fileService.exists(rpcReqUri)) {
				let reqObj: any = undefined;
				try {
					const rawReq = await this.fileService.readFile(rpcReqUri);
					reqObj = JSON.parse(rawReq.value.toString());
				} catch {
					// If file was mid-write, retry on next tick
				}
				if (reqObj && reqObj.id && !handledRpcIds.has(reqObj.id) && (!reqObj.cmd_id || reqObj.cmd_id === cmdId)) {
					handledRpcIds.add(reqObj.id);
					try {
						await this.fileService.del(rpcReqUri);
					} catch { }
					const rpcResponse = await this._handlePythonRpcCall(run, node, stepIndex, state, pathStep, reqObj, trimmedCode);
					try {
						await this.fileService.writeFile(
							rpcResUri,
							VSBuffer.fromString(JSON.stringify(rpcResponse))
						);
					} catch (writeErr: any) {
						const writeErrMsg = String(writeErr?.message || writeErr || '');
						if (!writeErrMsg.includes('Unable to resolve nonexistent file')) {
							throw writeErr;
						}
					}
				}
			}

			// 2. Check if Python command finished
			if (await this.fileService.exists(cmdResUri)) {
				let resObj: any = undefined;
				try {
					const rawRes = await this.fileService.readFile(cmdResUri);
					resObj = JSON.parse(rawRes.value.toString());
					cmdResParseFailures = 0;
				} catch (parseErr: any) {
					cmdResParseFailures++;
					if (cmdResParseFailures >= maxCmdResParseFailures) {
						try {
							await this.fileService.del(cmdResUri);
						} catch { }
						throw new Error(`Failed to parse Python kernel response after ${maxCmdResParseFailures} attempts: ${parseErr?.message || parseErr}`);
					}
				}

				if (resObj && resObj.id === cmdId) {
					try {
						await this.fileService.del(cmdResUri);
					} catch { }

					// Sync back all exported Python variables into run.contextVariables
					if (resObj.variables && typeof resObj.variables === 'object') {
						for (const [vk, vv] of Object.entries(resObj.variables)) {
							if (WorkflowExecutionService.RESERVED_CONTEXT_ALIAS_KEYS.has(vk) || vk.startsWith('@')) {
								continue;
							}
							run.contextVariables[vk] = vv;
							run.contextVariables[`@${vk}`] = vv;
						}
					}

					// Emit any print() stdout output to workflow execution logs
					if (resObj.stdout && typeof resObj.stdout === 'string' && resObj.stdout.trim()) {
						this._emitLog(run, 'info', `[Python stdout] ${resObj.stdout.trim()}`, { nodeId: node.id });
					}

					if (!resObj.ok) {
						const errMsg = resObj.error || 'Python execution error';
						if (stepIndex >= 0) {
							this._emitLog(run, 'error', `[Step #${stepIndex + 1} Python Error] ${errMsg}`, { nodeId: node.id });
						}
						throw new Error(errMsg);
					}

					if (mode === 'exec' && stepIndex >= 0) {
						const assignMatch = trimmedCode.match(/^@?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\+|-|\*|\/)?=(?!=)/);
						if (assignMatch && !trimmedCode.includes('\n')) {
							const assignedVar = assignMatch[1];
							const newVal = run.contextVariables[assignedVar];
							const preview = typeof newVal === 'object' ? JSON.stringify(newVal) : String(newVal);
							this._emitLog(run, 'info', `[Step #${stepIndex + 1} PY] ${assignedVar} = ${preview.substring(0, 180)}`, { nodeId: node.id });
							pathStep?.operations.push({
								type: 'set_variable',
								label: `Python: ${assignedVar} = ${preview.substring(0, 120)}`,
								details: {
									variable: assignedVar,
									expression: trimmedCode,
									newValue: newVal
								},
								durationMs: Date.now() - startMs
							});
						} else {
							pathStep?.operations.push({
								type: 'call_function',
								label: `Python Step #${stepIndex + 1}: ${trimmedCode.split(/\r?\n/)[0].substring(0, 80)}`,
								details: { expression: trimmedCode },
								durationMs: Date.now() - startMs
							});
						}
					}

					return resObj.value;
				}
			}

			await new Promise(r => setTimeout(r, 35));
		}

		throw new Error('Workflow execution was stopped');
	}

	private async _handlePythonRpcCall(
		run: IWorkflowExecutionRun,
		node: IFlowchartNode,
		stepIndex: number,
		state: IWorkflowNodeExecutionState | undefined,
		pathStep: IWorkflowPathStep | undefined,
		reqObj: { id: string; fn: string; args: any[]; kwargs: Record<string, any> },
		stepExpression?: string
	): Promise<{ id: string; result?: any; error?: string }> {
		const { id, fn, args = [], kwargs = {} } = reqObj;
		const upperFn = (fn || '').toUpperCase();
		const rawWsUri = URI.parse(run.workflowUri);
		const workflowDir = rawWsUri.path.endsWith('.workflow.json') || rawWsUri.path.endsWith('.json') || rawWsUri.path.endsWith('.workflow')
			? URI.joinPath(rawWsUri, '..')
			: rawWsUri;
		const startMs = Date.now();

		try {
			let result: any = undefined;

			if (upperFn === 'RUN_TICKETS') {
				let ticketIdOrPath = '';
				let inputParams: Record<string, any> = {};

				if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
					ticketIdOrPath = args[0].ticketId || args[0].ticketName || args[0].ticketIdOrPath || args[0].ticket_name || args[0].id || '';
					inputParams = args[0].parameters || args[0].inputParams || args[0].params || {};
				} else {
					const rawTicketArg = kwargs.ticket ?? kwargs.tickets ?? kwargs.ticket_name ?? kwargs.ticket_id ?? kwargs.ticketIdOrPath ?? args[0] ?? '';
					if (Array.isArray(rawTicketArg) && rawTicketArg.length > 0) {
						const first = rawTicketArg[0];
						if (typeof first === 'object' && first !== null) {
							ticketIdOrPath = first.ticketId || first.ticketName || first.ticketIdOrPath || first.id || '';
							if (first.parameters && typeof first.parameters === 'object') {
								inputParams = { ...first.parameters };
							}
						} else {
							ticketIdOrPath = String(first).trim();
						}
					} else if (typeof rawTicketArg === 'object' && rawTicketArg !== null) {
						ticketIdOrPath = rawTicketArg.ticketId || rawTicketArg.ticketName || rawTicketArg.ticketIdOrPath || rawTicketArg.id || '';
						if (rawTicketArg.parameters && typeof rawTicketArg.parameters === 'object') {
							inputParams = { ...rawTicketArg.parameters };
						}
					} else {
						ticketIdOrPath = String(rawTicketArg).trim();
					}
					const explicitParams = kwargs.parameters ?? kwargs.params ?? kwargs.inputParams ?? (typeof args[1] === 'object' ? args[1] : undefined);
					if (explicitParams && typeof explicitParams === 'object') {
						inputParams = { ...inputParams, ...explicitParams };
					}
					const reservedRunKeys = new Set(['ticket', 'tickets', 'ticket_name', 'ticket_id', 'ticketIdOrPath', 'parameters', 'params', 'inputParams']);
					for (const [k, v] of Object.entries(kwargs)) {
						if (!reservedRunKeys.has(k)) {
							inputParams[k] = v;
						}
					}
				}

				const cleanCtxParams: Record<string, any> = {};
				for (const [ck, cv] of Object.entries(run.contextVariables || {})) {
					if (ck.startsWith('@')) continue;
					if (cv && typeof cv === 'object' && ('contextVariables' in cv || 'stepResults' in cv)) continue;
					cleanCtxParams[ck] = cv;
				}
				this._emitLog(run, 'info', `[RUN_TICKETS] Executing ticket '${ticketIdOrPath}'...`, { nodeId: node.id });
				const execRes = await this.ticketRuntimeService.RUN_TICKETS({
					workspaceUri: workflowDir,
					ticketIdOrPath,
					inputParams: { ...cleanCtxParams, ...inputParams },
					isCancelled: () => this._cancelledRuns.has(run.runId) || run.status === 'stopped'
				});
				if (this._cancelledRuns.has(run.runId) || run.status === 'stopped') {
					throw new Error('Workflow execution was stopped');
				}
				if (!execRes.success) {
					throw new Error(execRes.error || `Ticket '${ticketIdOrPath}' execution failed`);
				}
				const ticketRecord = {
					ticketId: execRes.ticketId || ticketIdOrPath,
					ticketName: execRes.ticketName || ticketIdOrPath,
					ticketType: execRes.ticketType || 'task',
					status: 'success' as const,
					output: execRes.output,
					durationMs: Date.now() - startMs
				};
				state?.executedTickets.push(ticketRecord);
				pathStep?.operations.push({
					type: 'run_ticket',
					label: `RUN_TICKETS: '${ticketRecord.ticketName}' [${ticketRecord.ticketType}]`,
					executedTicket: ticketRecord,
					durationMs: ticketRecord.durationMs
				});
				const { contextVariables: _omitCtx, ...lightExecRes } = execRes;
				result = lightExecRes;
			} else if (upperFn === 'CREATE_TICKETS') {
				let opts: any = {};
				if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
					opts = { ...args[0] };
				} else {
					opts.ticketType = String(kwargs.ticket_type ?? kwargs.type ?? args[0] ?? 'task');
					opts.title = String(kwargs.title ?? args[1] ?? 'New Ticket');
					const targetFolder = kwargs.target_folder ?? kwargs.target_path ?? kwargs.folder ?? kwargs.path ?? (typeof args[2] === 'string' ? args[2] : undefined);
					if (targetFolder && String(targetFolder).trim()) {
						opts.targetPath = String(targetFolder).trim();
					}
					const explicitFolderName = kwargs.folder_name ?? kwargs.folderName ?? kwargs.name;
					if (explicitFolderName && String(explicitFolderName).trim()) {
						opts.folderName = String(explicitFolderName).trim();
					}
					const rawParams = kwargs.parameters ?? kwargs.params ?? kwargs.fieldValues ?? (typeof args[2] === 'object' ? args[2] : (typeof args[3] === 'object' ? args[3] : {}));
					const initialFields = typeof rawParams === 'object' && rawParams !== null ? { ...rawParams } : {};
					const reservedCreateKeys = new Set(['ticket_type', 'type', 'title', 'target_folder', 'target_path', 'folder', 'path', 'folder_name', 'folderName', 'name', 'parameters', 'params', 'fieldValues', 'auto_run', 'autoRun']);
					for (const [k, v] of Object.entries(kwargs)) {
						if (!reservedCreateKeys.has(k)) {
							initialFields[k] = v;
						}
					}
					opts.parameters = initialFields;
					opts.fieldValues = initialFields;
					opts.autoRun = kwargs.auto_run === true || kwargs.autoRun === true;
				}
				if (typeof opts.title === 'string' && opts.title.includes('{')) {
					opts.title = opts.title.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_match: string, varKey: string) => {
						const ctxVal = run.contextVariables?.[varKey];
						if (ctxVal !== undefined && ctxVal !== null && typeof ctxVal !== 'object') {
							return String(ctxVal);
						}
						if (varKey === 'time_now') {
							const d = new Date();
							const pad = (n: number) => String(n).padStart(2, '0');
							return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
						}
						if (varKey === 'job_position' && opts.parameters?.current_job && typeof opts.parameters.current_job === 'object') {
							const jName = opts.parameters.current_job.job_name || opts.parameters.current_job.title;
							if (jName) {
								return String(jName);
							}
						}
						return _match;
					});
				}
				opts.workspaceUri = workflowDir;
				const createParamKeys = Object.keys(opts.parameters || {});
				const createParamSummary = createParamKeys.length > 0
					? createParamKeys.map(k => `${k}=${JSON.stringify(opts.parameters[k])}`).join(', ')
					: 'none';
				this._emitLog(run, 'info', `[CREATE_TICKETS] Creating ticket '${opts.title}' (type: ${opts.ticketType}) with ${createParamKeys.length} parameter(s): ${createParamSummary}`, { nodeId: node.id });
				const createRes = await this.ticketRuntimeService.CREATE_TICKETS(opts);
				if (!createRes.success) {
					throw new Error(createRes.error || `Failed to create ticket '${opts.title}'`);
				}
				result = createRes;
			} else if (upperFn === 'GET_TICKETS') {
				const rawTarget = kwargs.ticket ?? kwargs.tickets ?? kwargs.ticket_name ?? kwargs.ticket_id ?? kwargs.ticketIdOrPath ?? kwargs.id ?? args[0] ?? '';
				result = await this.ticketRuntimeService.GET_TICKETS(workflowDir, rawTarget);
			} else if (upperFn === 'GET_OUTPUTS') {
				const rawTarget = kwargs.ticket_id ?? kwargs.ticket ?? kwargs.tickets ?? kwargs.ticket_name ?? kwargs.ticketId ?? kwargs.ticketIdOrPath ?? kwargs.id ?? args[0] ?? '';
				const allOutputs = await this.ticketRuntimeService.GET_OUTPUTS(workflowDir, rawTarget);
				const requestedField = kwargs.field ?? kwargs.key ?? kwargs.name ?? kwargs.output ?? args[1];
				if (requestedField && allOutputs && typeof allOutputs === 'object') {
					const targetKey = String(requestedField).trim();
					if (targetKey in allOutputs) {
						result = allOutputs[targetKey];
					} else {
						const normKey = targetKey.toLowerCase().replace(/_/g, ' ');
						let matched = Object.keys(allOutputs).find(k => !k.startsWith('__') && k.trim().toLowerCase().replace(/_/g, ' ') === normKey);
						if (matched === undefined && normKey.length >= 4) {
							const prefixMatches = Object.keys(allOutputs).filter(k => {
								if (k.startsWith('__')) { return false; }
								const kn = k.trim().toLowerCase().replace(/_/g, ' ');
								return kn.startsWith(normKey) || normKey.startsWith(kn);
							});
							if (prefixMatches.length === 1) {
								matched = prefixMatches[0];
							}
						}
						result = matched !== undefined ? allOutputs[matched] : undefined;
					}
				} else {
					result = allOutputs;
				}
			} else if (upperFn === 'GET_PRIMITIVES_CATALOG') {
				result = await this.ticketRuntimeService.GET_PRIMITIVES_CATALOG(workflowDir);
			} else if (upperFn === 'DISPLAY') {
				let displayVal: any;
				if (args.length === 1) {
					displayVal = args[0];
				} else if (args.length > 1) {
					displayVal = args;
				} else if (Object.keys(kwargs).length > 0) {
					displayVal = kwargs;
				} else {
					displayVal = run.contextVariables;
				}
				result = displayVal;

				const { formattedText, summaryType, cleanValue, ticketTitle, ticketId, ticketType, outputItems, ticketHandle } = this._formatDisplayOutput(displayVal);
				const nodeLabelName = (node.label && node.label.trim()) ? node.label.trim() : (node.id || 'Node');
				const logDisplayPreview = formattedText.length > 500
					? formattedText.substring(0, 500) + ' ... [see Live Display]'
					: formattedText;
				this._emitLog(run, 'info', `[DISPLAY] [${nodeLabelName}] (${summaryType})\n${logDisplayPreview}`, { nodeId: node.id });

				const callExprFromPython = typeof (reqObj as any).call_expr === 'string' && (reqObj as any).call_expr.trim()
					? (reqObj as any).call_expr.trim()
					: (stepExpression && !stepExpression.includes('\n') ? stepExpression.trim() : 'DISPLAY(...)');

				const displayCard: IWorkflowDisplayCard = {
					id: `display_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
					runId: run.runId,
					nodeId: node.id,
					nodeTitle: nodeLabelName,
					expression: callExprFromPython,
					value: cleanValue,
					formattedText,
					timestamp: new Date().toLocaleTimeString(),
					ticketTitle,
					ticketId,
					ticketType,
					outputItems,
					ticketHandle
				};

				let cardList = this._displayCardsByWorkflow.get(run.workflowUri);
				if (!cardList) {
					cardList = [];
					this._displayCardsByWorkflow.set(run.workflowUri, cardList);
				}
				cardList.unshift(displayCard);
				this._onDidDisplayVariable.fire(displayCard);
			} else {
				throw new Error(`Unknown RPC function: ${fn}`);
			}

			return { id, result };
		} catch (err: any) {
			return { id, error: err.message || String(err) };
		}
	}

	private readonly _notebookRunsByWorkflow = new Map<string, { run: IWorkflowExecutionRun; execCount: number }>();

	async restartNotebookKernel(workflowUri: URI | string): Promise<void> {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		await this.ticketRuntimeService.cancelAllActiveOperations('Notebook kernel restarted by user').catch(() => { });
		const entry = this._notebookRunsByWorkflow.get(uriStr);
		if (entry) {
			this._cancelledRuns.add(entry.run.runId);
			this._notebookRunsByWorkflow.delete(uriStr);
			await this._shutdownPythonKernel(entry.run.runId);
		}
	}

	async executeNotebookCell(
		workflowUri: URI | string,
		code: string,
		options?: { nodeId?: string; nodeLabel?: string; pythonPath?: string; mode?: 'exec' | 'eval' }
	): Promise<INotebookCellExecutionResult> {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		const startMs = Date.now();
		let entry = this._notebookRunsByWorkflow.get(uriStr);

		if (!entry || !this._pythonKernels.has(entry.run.runId) || this._pythonKernels.get(entry.run.runId)?.stopped) {
			const runId = `nb_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
			const run: IWorkflowExecutionRun = {
				runId,
				workflowUri: uriStr,
				workflowName: this._resolveWorkflowName(uriStr),
				status: 'running',
				mode: 'standard',
				startedAt: Date.now(),
				updatedAt: Date.now(),
				visitedNodeIds: [],
				contextVariables: {},
				nodeStates: {},
				linkStates: {},
				executionPath: [],
				logs: []
			};
			await this._startPythonKernel(run, options?.pythonPath);
			entry = { run, execCount: 0 };
			this._notebookRunsByWorkflow.set(uriStr, entry);
		}

		entry.execCount++;
		const executionCount = entry.execCount;
		const { run } = entry;

		const dummyNode: IFlowchartNode = {
			id: options?.nodeId || 'notebook_cell',
			type: 'round-rect',
			x: 0,
			y: 0,
			width: 140,
			height: 48,
			label: options?.nodeLabel || 'Notebook Cell'
		};

		const cardsBefore = new Set((this._displayCardsByWorkflow.get(uriStr) || []).map(c => c.id));
		const logsBeforeLen = run.logs.length;

		try {
			const evalVal = await this._executeInPythonKernel(
				run,
				dummyNode,
				0,
				undefined,
				undefined,
				code,
				options?.mode || 'exec'
			);

			const newLogs = run.logs.slice(logsBeforeLen);
			const stdoutLines: string[] = [];
			for (const l of newLogs) {
				if (l.message.startsWith('[Python stdout] ')) {
					stdoutLines.push(l.message.substring('[Python stdout] '.length));
				}
			}

			const allCards = this._displayCardsByWorkflow.get(uriStr) || [];
			const newCards = allCards.filter(c => !cardsBefore.has(c.id));

			let finalValue = evalVal;
			if (finalValue === null || finalValue === undefined) {
				const trimmed = (code || '').trim();
				const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
				const lastLine = lines[lines.length - 1] || '';
				const assignMatch = lastLine.match(/^@?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\+|-|\*|\/)?=(?!=)/);
				if (assignMatch) {
					const varName = assignMatch[1];
					if (Object.prototype.hasOwnProperty.call(run.contextVariables, varName)) {
						finalValue = { __assignedVar: varName, value: run.contextVariables[varName] };
					}
				}
			}

			const cleanVars: Record<string, any> = {};
			for (const [k, v] of Object.entries(run.contextVariables)) {
				if (!k.startsWith('@')) {
					cleanVars[k] = v;
				}
			}

			return {
				ok: true,
				value: finalValue,
				stdout: stdoutLines.join('\n'),
				variables: cleanVars,
				displayCards: newCards,
				durationMs: Date.now() - startMs,
				executionCount
			};
		} catch (err: any) {
			const cleanVars: Record<string, any> = {};
			for (const [k, v] of Object.entries(run.contextVariables)) {
				if (!k.startsWith('@')) {
					cleanVars[k] = v;
				}
			}
			return {
				ok: false,
				error: err?.message || String(err),
				variables: cleanVars,
				displayCards: [],
				durationMs: Date.now() - startMs,
				executionCount
			};
		}
	}
}
