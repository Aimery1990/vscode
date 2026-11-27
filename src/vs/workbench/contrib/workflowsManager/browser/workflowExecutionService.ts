/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ICustomField, ICustomModule, IEntityPersistenceService, generateSmartPythonVarName, normalizeLegacyFieldTypes, normalizeHttpTicketValue, isHttpTicketValue, isSshTicketValue, sshTicketValueOutputText } from '../../entityPersistence/common/entityPersistence.js';
import { IWorkflowExecutionService, IWorkflowDisplayCard, IWorkflowDisplayOutputItem, ITicketHandleInfo, INotebookCellExecutionResult, ISubWorkflowInvocationRequest, ISubWorkflowInvocationResult } from '../common/workflowExecutionService.js';
import { ISubWorkflowCallChain, SubWorkflowCallGraphRoot, checkSubWorkflowCall, createSubWorkflowCallChain, describeCallGraphNode, extendSubWorkflowCallChain, findSubWorkflowCallCycle, findTemplateByTicketType, formatSubWorkflowCycleError, subWorkflowCallFrame, withSubWorkflowCallParentRun } from '../common/subWorkflowCallGraph.js';
import { ICustomModulesService } from '../../customModules/common/customModules.js';
import { ITicketCreateOptions, ITicketGetResult, ITicketRunResult, ITicketWorkflowRuntimeService } from './ticketWorkflowRuntime.js';
import { IHumanDecisionService } from '../common/humanDecision.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { IWorkspacesExplorerService } from '../../workspacesExplorer/common/workspacesExplorer.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { getAnyAgentGlobalFolders, IAnyAgentGlobalFolders, toFolderAccessError } from '../../customModules/common/anyagentGlobalPaths.js';
import { Sequencer } from '../../../../base/common/async.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { SUB_WORKFLOW_TICKET_TYPE, isSubWorkflowTicketType } from '../../customModules/common/subWorkflowType.js';
import {
	SUB_WORKFLOW_MIGRATED_IDS_STORAGE_KEY,
	SUB_WORKFLOW_TICKET_INDEX_STORAGE_KEY,
	applySubWorkflowMetadataToTicketMd,
	buildSubWorkflowLookup,
	buildSubWorkflowTicketDescription,
	buildSubWorkflowTicketIndex,
	buildSubWorkflowTicketMetadata,
	getSubWorkflowDefinitionUri,
	getSubWorkflowMigrationRetryDelay,
	getSubWorkflowSourceFolder,
	getUncoveredLegacySubWorkflows,
	isLegacySubWorkflowId,
	needsSourceCanvasCleanup,
	parseLegacySubWorkflowLibrary,
	parseMigratedLegacyIds,
	parseSubWorkflowDefinition,
	parseSubWorkflowTicketIndex,
	planSubWorkflowMigration,
	removeMigratedSubWorkflowNodesFromCanvas,
	serializeSubWorkflowDefinition,
	stripHeavyMediaFromSubWorkflow
} from '../common/subWorkflowTicket.js';
import {
	ISubWorkflowDefinition,
	SUB_WORKFLOWS_STORAGE_KEY,
	IWorkflowEngineOptions,
	IWorkflowExecutionRun,
	IWorkflowIOContract,
	IWorkflowInputParamDef,
	IWorkflowOutputDef,
	IWorkflowLogEntry,
	IWorkflowNodeExecutionState,
	IWorkflowPathStep,
	IWorkflowNodeOperation,
	IWorkflowStepTransition,
	IPrimitiveExecutionStepResult,
	IExecutedTicketRecord,
	IWorkflowLinkExecutionState,
	IWorkflowRecord,
	isWorkflowRecord,
	hasWorkflowProperty
} from '../common/workflowExecutionModel.js';
import { writeTicketFile } from '../../workspacesExplorer/browser/ticketChangeRecorder.js';

/** A component step of a node pipeline, plus runtime-only bookkeeping the engine writes onto it. */
type IWorkflowStepComponent = ICustomField & {
	lastExecutionOutput?: unknown;
	lastExecutionInputs?: unknown;
	lastExecutionLog?: string;
};

/**
 * Engine-internal bookkeeping stored on a run object next to the serializable {@link IWorkflowExecutionRun} fields.
 */
interface IInternalWorkflowRun extends IWorkflowExecutionRun {
	_liveFlowchartData?: IFlowchartData;
	_displayRunId?: string;
	_displayWorkflowUri?: string;
	_totalStepsCounter?: number;
	_executedTicketIdsWindow?: string[];
	/** Who called whom down to this run (CI-38 recursion / depth guard). */
	_callChain?: ISubWorkflowCallChain;
	/** A Sub-Workflow run: the ticket folder whose own canvas shows its nodes (node component updates go there). */
	_canvasUri?: string;
}

/** Callers (the Workflow editor, Sub-Workflow runs) pass the in-memory flowchart as `initialData`. */
function initialFlowchartData(options: IWorkflowEngineOptions | undefined): Partial<IFlowchartData> | undefined {
	return options?.initialData as Partial<IFlowchartData> | undefined;
}

/** A command response written by the embedded Python kernel (`cmd_res.json`). */
interface IPythonKernelResponse {
	id?: string;
	ok?: boolean;
	error?: string;
	stdout?: unknown;
	variables?: unknown;
	value?: unknown;
}

/** An RPC request written by the embedded Python kernel (`rpc_req_*.json`). */
interface IPythonRpcRequest {
	id: string;
	fn: string;
	args: unknown[];
	kwargs: Record<string, unknown>;
	cmd_id?: string;
	/** Source text of the Python call (used as the Live Display expression). */
	call_expr?: unknown;
}

/**
 * CREATE_TICKETS options assembled from Python call arguments. They are passed through to the ticket runtime,
 * which validates them; unknown extra keys (e.g. `auto_run`) are tolerated.
 */
type IRpcTicketCreateOptions = Partial<ITicketCreateOptions> & IWorkflowRecord;

/** Non-enumerable `__ticketMetadata` that GET_OUTPUTS attaches to its result object (see `_handlePythonRpcCall`). */
interface ITicketDisplayMetadata {
	ticketId?: string;
	ticketName?: string;
	title?: string;
	ticketType?: string;
}

/** Extra result fields some ticket runs report in addition to {@link ITicketRunResult}. */
interface ITicketRunResultExtras {
	outputSpecs?: unknown[];
}

/** In-flight marker for a ticket record that is still running (replaced once the ticket finishes). */
const RUNNING_TICKET_RECORD_STATUS: IExecutedTicketRecord['status'] = 'running';

interface INodePipelineStep {
	id: string;
	type: 'run_ticket' | 'set_variable' | 'custom_code' | 'call_function' | 'component';
	ticketName?: string;
	ticketType?: string;
	ticketUri?: string;
	targetVariable?: string;
	expression?: string;
	functionName?: string;
	label?: string;
	parameters?: string;
	disabled?: boolean;
	component?: IWorkflowStepComponent;
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
	outputVariable?: { name: string; initialValue?: string; expression?: string; currentValue?: unknown };
	outputVariables?: { name: string; initialValue?: string; expression?: string; currentValue?: unknown }[];
	pipeline?: INodePipelineStep[];
	/** UI-only: last time the node was clicked in the editor (used to pick a default entry node). */
	_lastClickTime?: number;
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

/** `value[key]` with plain JS property-access semantics (primitives are auto-boxed, the key is coerced). */
function getPyAttr(value: NonNullable<unknown>, key: PropertyKey): unknown {
	return (value as Record<PropertyKey, unknown>)[key];
}

/**
 * `typeof target[name] === 'function' ? target[name](...args) : fallback`, i.e. calls a native method of a
 * runtime value (with `this === target`) when it exists.
 */
function invokePyMethod(target: NonNullable<unknown>, name: string, args: unknown[], fallback: unknown): unknown {
	const method = getPyAttr(target, name);
	return typeof method === 'function' ? method.apply(target, args) : fallback;
}

/** `value?.[key]`: `undefined` for `null` / `undefined`, otherwise plain JS property access. */
function optionalProp(value: unknown, key: PropertyKey): unknown {
	return value === null || value === undefined ? undefined : getPyAttr(value, key);
}

class PythonExpressionEvaluator {
	private pos = 0;
	private tokens: string[] = [];
	private context: Record<string, unknown>;
	private rawExpr: string;

	constructor(expr: string, context: Record<string, unknown>) {
		this.rawExpr = expr || '';
		this.context = context || {};
		this.tokens = this.tokenize(expr);
		this.pos = 0;
	}

	public static interpolateString(raw: string, context: Record<string, unknown>): string {
		if (!raw || !context) { return raw; }
		let result = raw;

		// 1. Interpolate {{expr}}, ${expr}, or {expr}
		if (result.includes('{')) {
			result = result.replace(/\{\{([^{}]+)\}\}|\$\{([^{}]+)\}|\{([^{}]+)\}/g, (match, g1, g2, g3) => {
				const expr = (g1 ?? g2 ?? g3 ?? '').trim();
				if (!expr) { return match; }
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
			if ((ch === 'f' || ch === 'F') && i + 1 < s.length && (s[i + 1] === '\'' || s[i + 1] === '"')) {
				i++; // consume 'f' prefix and fall through to quoted string
			}
			// Quoted strings: '...' or "..."
			if (s[i] === '\'' || s[i] === '"') {
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
				if (i < s.length) { i++; } // consume closing quote
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

	public evaluate(): unknown {
		if (this.tokens.length === 0) { return undefined; }
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
	private parseOr(): unknown {
		let left = this.parseAnd();
		while (this.peek() === 'or') {
			this.consume('or');
			const right = this.parseAnd();
			left = Boolean(left) ? left : right;
		}
		return left;
	}

	// Level 2: and
	private parseAnd(): unknown {
		let left = this.parseNot();
		while (this.peek() === 'and') {
			this.consume('and');
			const right = this.parseNot();
			left = Boolean(left) ? right : left;
		}
		return left;
	}

	// Level 3: not
	private parseNot(): unknown {
		if (this.peek() === 'not') {
			this.consume('not');
			return !this.parseNot();
		}
		return this.parseComparison();
	}

	// Level 4: comparisons (==, !=, <, <=, >, >=, is, is not, in)
	private parseComparison(): unknown {
		const left = this.parseAddSub();

		const op = this.peek();
		if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
			this.consume();
			const right = this.parseAddSub();
			if (op === '==') { return left === right; }
			if (op === '!=') { return left !== right; }
			// Relational operators keep plain JS semantics (incl. coercion of mixed operand types); the casts are type-only
			if (op === '<') { return (left as number) < (right as number); }
			if (op === '<=') { return (left as number) <= (right as number); }
			if (op === '>') { return (left as number) > (right as number); }
			if (op === '>=') { return (left as number) >= (right as number); }
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
			if (typeof right === 'string') {
				return right.includes(left as string); // String.prototype.includes coerces its argument to string
			}
			if (Array.isArray(right)) {
				return right.includes(left);
			}
			if (right && typeof right === 'object') {
				return hasWorkflowProperty(right, left as PropertyKey); // `left in right`: the key is coerced to a property key
			}
			return false;
		}

		return left;
	}

	// Level 5: +, -
	private parseAddSub(): unknown {
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
					// Any other operand mix keeps plain JS `+` semantics; the casts are type-only
					left = (left as number) + (right as number);
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
	private parseMulDiv(): unknown {
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
					const repeated: unknown[] = [];
					for (let c = 0; c < count; c++) { repeated.push(...left); }
					left = repeated;
				} else if (typeof left === 'number' && Array.isArray(right)) {
					const count = Math.max(0, Math.floor(left));
					const repeated: unknown[] = [];
					for (let c = 0; c < count; c++) { repeated.push(...right); }
					left = repeated;
				} else {
					throw new Error(`TypeError: unsupported operand type(s) for *: '${typeof left}' and '${typeof right}'`);
				}
			} else if (op === '/') {
				if (typeof left === 'number' && typeof right === 'number') {
					if (right === 0) { throw new Error('ZeroDivisionError: division by zero'); }
					left = left / right;
				} else {
					throw new Error(`TypeError: unsupported operand type(s) for /: '${typeof left}' and '${typeof right}'`);
				}
			} else if (op === '//') {
				if (typeof left === 'number' && typeof right === 'number') {
					if (right === 0) { throw new Error('ZeroDivisionError: integer division by zero'); }
					left = Math.floor(left / right);
				} else {
					throw new Error(`TypeError: unsupported operand type(s) for //: '${typeof left}' and '${typeof right}'`);
				}
			} else if (op === '%') {
				if (typeof left === 'number' && typeof right === 'number') {
					if (right === 0) { throw new Error('ZeroDivisionError: integer modulo by zero'); }
					left = left % right;
				} else {
					throw new Error(`TypeError: unsupported operand type(s) for %: '${typeof left}' and '${typeof right}'`);
				}
			}
		}
		return left;
	}

	// Level 7: **
	private parsePower(): unknown {
		const left = this.parseUnary();
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
	private parseUnary(): unknown {
		if (this.peek() === '+') {
			this.consume('+');
			const val = this.parseUnary();
			return +(val as number); // unary plus: JS ToNumber of any value
		}
		if (this.peek() === '-') {
			this.consume('-');
			const val = this.parseUnary();
			return -(val as number); // unary minus: JS numeric negation of any value
		}
		return this.parsePostfix();
	}

	// Level 8.5: Postfix subscript a["b"] / a[0] / a[1:3] and dot access / method call a.b / a.get("b")
	private parsePostfix(): unknown {
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
								const obj = val as IWorkflowRecord;
								if (hasWorkflowProperty(obj, idxKey)) {
									val = obj[idxKey];
								} else {
									const normKey = idxKey.trim().toLowerCase().replace(/_/g, ' ');
									const keys = Object.keys(obj);
									const exactNorm = keys.find(k => k.trim().toLowerCase().replace(/_/g, ' ') === normKey);
									if (exactNorm !== undefined) {
										val = obj[exactNorm];
									} else if (normKey.length >= 4) {
										const prefixMatches = keys.filter(k => {
											const kn = k.trim().toLowerCase().replace(/_/g, ' ');
											return kn.startsWith(normKey) || normKey.startsWith(kn);
										});
										val = prefixMatches.length === 1 ? obj[prefixMatches[0]] : undefined;
									} else {
										val = undefined;
									}
								}
							} else {
								val = getPyAttr(val, idxKey as PropertyKey);
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
					const mArgs: unknown[] = [];
					if (this.peek() !== ')') {
						mArgs.push(this.parseOr());
						while (this.peek() === ',') {
							this.consume(',');
							if (this.peek() === ')') { break; }
							mArgs.push(this.parseOr());
						}
					}
					this.consume(')');
					if (val !== undefined && val !== null && prop) {
						if (Array.isArray(val)) {
							if (prop === 'append') { val.push(mArgs[0]); }
							else if (prop === 'extend') { if (Array.isArray(mArgs[0])) { val.push(...mArgs[0]); } else if (mArgs[0] !== undefined) { val.push(mArgs[0]); } }
							else if (prop === 'pop') { val = mArgs.length > 0 ? val.splice(Number(mArgs[0]), 1)[0] : val.pop(); }
							else if (prop === 'index') { val = val.indexOf(mArgs[0]); }
							else if (prop === 'count') { val = val.filter(x => x === mArgs[0]).length; }
							else if (prop === 'copy') { val = [...val]; }
							else if (prop === 'clear') { val.length = 0; }
							else { val = invokePyMethod(val, prop, mArgs, val); }
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
							else { val = invokePyMethod(val, prop, mArgs, val); }
						} else if (typeof val === 'object') {
							const obj = val as IWorkflowRecord;
							if (prop === 'get') {
								const k = String(mArgs[0] ?? '');
								val = Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : (mArgs.length > 1 ? mArgs[1] : null);
							}
							else if (prop === 'keys') { val = Object.keys(val); }
							else if (prop === 'values') { val = Object.values(val); }
							else if (prop === 'items') { val = Object.entries(val); }
							else if (prop === 'update') { if (mArgs[0] && typeof mArgs[0] === 'object') { Object.assign(val, mArgs[0]); } }
							else if (prop === 'pop') {
								const k = String(mArgs[0] ?? '');
								const out = Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : (mArgs.length > 1 ? mArgs[1] : null);
								delete obj[k];
								val = out;
							}
							else if (prop === 'copy') { val = { ...val }; }
							else if (prop === 'clear') { for (const k of Object.keys(obj)) { delete obj[k]; } }
							else { val = invokePyMethod(val, prop, mArgs, val); }
						}
					} else {
						val = undefined;
					}
				} else if (val !== undefined && val !== null && prop) {
					val = getPyAttr(val, prop);
				} else {
					val = undefined;
				}
			}
		}
		return val;
	}

	// Level 9: Primary (literal, list, dict, tuple, variable lookup, parentheses)
	private parsePrimary(): unknown {
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
				const tuple: unknown[] = [first];
				while (this.peek() === ',') {
					this.consume(',');
					if (this.peek() === ')') { break; }
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
			const arr: unknown[] = [];
			if (this.peek() !== ']') {
				arr.push(this.parseOr());
				while (this.peek() === ',') {
					this.consume(',');
					if (this.peek() === ']') { break; } // support trailing comma
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
			const obj: Record<string, unknown> = {};
			const setItems: unknown[] = [];
			let isDict: boolean | null = null;
			while (this.peek() && this.peek() !== '}') {
				let firstKeyOrVal: unknown;
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
					if (this.peek() === '}') { break; } // support trailing comma
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
		if (token === 'None' || token === 'null') { return null; }
		if (token === 'True' || token === 'true') { return true; }
		if (token === 'False' || token === 'false') { return false; }

		// Number literal
		if (/^-?\d+(\.\d+)?$/.test(token)) {
			return Number(token);
		}

		// Quoted string literal (with automatic variable/expression interpolation)
		if ((token.startsWith('\'') && token.endsWith('\'')) || (token.startsWith('"') && token.endsWith('"'))) {
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
			const fnArgs: unknown[] = [];
			if (this.peek() !== ')') {
				fnArgs.push(this.parseOr());
				while (this.peek() === ',') {
					this.consume(',');
					if (this.peek() === ')') { break; }
					fnArgs.push(this.parseOr());
				}
			}
			this.consume(')');
			const a0 = fnArgs[0];
			if (lowerFnName === 'list' || lowerFnName === 'tuple') {
				if (fnArgs.length === 0) { return []; }
				if (Array.isArray(a0)) { return [...a0]; }
				if (typeof a0 === 'string') { return Array.from(a0); }
				if (a0 && typeof a0 === 'object') { return Object.keys(a0); }
				return [a0];
			}
			if (lowerFnName === 'dict') {
				if (fnArgs.length === 0) { return {}; }
				if (a0 && typeof a0 === 'object' && !Array.isArray(a0)) { return { ...a0 }; }
				return {};
			}
			if (lowerFnName === 'set') {
				if (fnArgs.length === 0) { return []; }
				if (Array.isArray(a0)) { return Array.from(new Set(a0)); }
				if (typeof a0 === 'string') { return Array.from(new Set(Array.from(a0))); }
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
			if (lowerFnName === 'str') { return a0 === undefined || a0 === null ? '' : (typeof a0 === 'object' ? JSON.stringify(a0) : String(a0)); }
			if (lowerFnName === 'int') { return parseInt(String(a0 ?? 0), 10) || 0; }
			if (lowerFnName === 'float') { return parseFloat(String(a0 ?? 0)) || 0; }
			if (lowerFnName === 'bool') { return Boolean(a0); }
			if (lowerFnName === 'len') {
				if (typeof a0 === 'string' || Array.isArray(a0)) { return a0.length; }
				if (a0 && typeof a0 === 'object') { return Object.keys(a0).length; }
				return 0;
			}
			if (lowerFnName === 'abs') { return Math.abs(Number(a0 ?? 0)); }
			if (lowerFnName === 'min') { return Math.min(...fnArgs.map(Number)); }
			if (lowerFnName === 'max') { return Math.max(...fnArgs.map(Number)); }
			if (lowerFnName === 'round') { return Math.round(Number(a0 ?? 0)); }
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

	private static readonly SUB_WORKFLOW_LATEST_RUNS_STORAGE_KEY = 'anyagent.workflow.latestSubWorkflowRuns.v1';
	private readonly _latestSubWorkflowRuns = new Map<string, IWorkflowExecutionRun>();
	private _latestSubWorkflowRunsLoaded = false;
	private readonly _flowchartOwnerCounts = new Map<string, number>();

	public registerFlowchartOwner(workflowUri: URI | string): { dispose(): void } {
		const key = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		this._flowchartOwnerCounts.set(key, (this._flowchartOwnerCounts.get(key) || 0) + 1);
		let disposed = false;
		return {
			dispose: () => {
				if (disposed) {
					return;
				}
				disposed = true;
				const next = (this._flowchartOwnerCounts.get(key) || 1) - 1;
				if (next <= 0) {
					this._flowchartOwnerCounts.delete(key);
					this._scheduleMigratedSourceCanvasCleanup(3000);
				} else {
					this._flowchartOwnerCounts.set(key, next);
				}
			}
		};
	}
	private _subWorkflowsCache: ISubWorkflowDefinition[] | null = null;
	/** By ticket ID and, for migrated Sub-Workflows, by legacy subwf_... id (see buildSubWorkflowLookup). */
	private _subWorkflowByIdCache = new Map<string, ISubWorkflowDefinition>();
	private _subWorkflowsReady: Promise<void> | undefined;
	/** Serializes Sub-Workflow ticket loading, migration and creation (ticket numbering is not atomic). */
	private readonly _subWorkflowTicketSequencer = new Sequencer();
	private readonly _subWorkflowTicketWrites = new Map<string, Promise<void>>();
	private readonly _lastWrittenSubWorkflowJson = new Map<string, string>();
	private readonly _lastWrittenSubWorkflowMeta = new Map<string, string>();
	private _subWorkflowDiscoveryTimer: ReturnType<typeof setTimeout> | undefined;
	private _subWorkflowSnapshotListener: IDisposable | undefined;

	private readonly _runs = new Map<string, IWorkflowExecutionRun>();
	private readonly _activeRunsByWorkflow = new Map<string, string>();
	private readonly _humanWaiters = new Map<string, (input: unknown) => void>();
	private readonly _stepWaiters = new Map<string, () => void>();
	private readonly _cancelledRuns = new Set<string>();
	private readonly _persistDebounceMap = new Map<string, ReturnType<typeof setTimeout>>();

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

	private readonly _onDidChangeSubWorkflows = new Emitter<void>();
	public readonly onDidChangeSubWorkflows: Event<void> = this._onDidChangeSubWorkflows.event;

	private readonly _onDidChangeSubWorkflowRun = new Emitter<IWorkflowExecutionRun>();
	public readonly onDidChangeSubWorkflowRun: Event<IWorkflowExecutionRun> = this._onDidChangeSubWorkflowRun.event;
	/** Sub-Workflow library id -> runId of its currently executing child run. */
	private readonly _activeSubWorkflowRunIds = new Map<string, string>();

	constructor(
		@IEntityPersistenceService private readonly entityPersistenceService: IEntityPersistenceService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ITicketWorkflowRuntimeService private readonly ticketRuntimeService: ITicketWorkflowRuntimeService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspacesExplorerService private readonly workspacesExplorerService: IWorkspacesExplorerService,
		@IPathService private readonly pathService: IPathService,
		@ICustomModulesService private readonly customModulesService: ICustomModulesService,
		@IHumanDecisionService private readonly humanDecisionService: IHumanDecisionService
	) {
		this._cleanupStaleKernelDirsOnStartup().catch(() => { });
		// Button Group gates (CI-25): mirror pending decisions as the existing waiting_human run / node state
		this.humanDecisionService.onDidChange(() => this._syncHumanDecisionStates());
		this.workspacesExplorerService.onDidCreateSubWorkflowTicket(folderUri => {
			this._onSubWorkflowTicketCreated(folderUri).catch(err => this.logService.warn('[WorkflowExecution] Could not load the new Sub-Workflow ticket:', err));
		});
	}

	private _coerceInputLiteral(val: unknown): unknown {
		if (typeof val !== 'string') {
			return val;
		}
		const trimmed = val.trim();
		if (!trimmed) {
			return val;
		}
		// 1. Explicit quoted string literal (Python-style "..." or '...') -> always keep as string (e.g. '2' or "2" -> "2")
		if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
			try {
				const parsed = JSON.parse(trimmed);
				if (typeof parsed === 'string') {
					return parsed;
				}
			} catch {
				// Keep original if not a valid single quoted string literal
			}
		}
		if (trimmed.length >= 2 && trimmed.startsWith('\'') && trimmed.endsWith('\'')) {
			const inner = trimmed.slice(1, -1);
			if (!/(^|[^\\])'/.test(inner)) {
				return inner.replace(/\\'/g, '\'').replace(/\\\\/g, '\\');
			}
		}
		// 2. Unquoted numeric literal (int / float) -> number (e.g. 2 -> 2, 3.14 -> 3.14)
		if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
			const num = Number(trimmed);
			if (Number.isFinite(num)) {
				return num;
			}
		}
		// 3. Unquoted boolean / None literals
		if (trimmed === 'true' || trimmed === 'True') {
			return true;
		}
		if (trimmed === 'false' || trimmed === 'False') {
			return false;
		}
		if (trimmed === 'null' || trimmed === 'None') {
			return null;
		}
		// 4. Unquoted JSON list / dict literals
		if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
			try {
				return JSON.parse(trimmed);
			} catch {
				return val;
			}
		}
		return val;
	}

	private async _executeSubWorkflow(
		parentRun: IWorkflowExecutionRun,
		subDef: ISubWorkflowDefinition,
		resolvedInputs: Record<string, unknown>,
		callerNode?: { id: string; label?: string },
		callChain?: ISubWorkflowCallChain
	): Promise<IWorkflowExecutionRun> {
		// Runtime recursion / depth guard (CI-38): never run a Sub-Workflow that is already on the call chain
		const parentChain = callChain ?? this._callChainOf(parentRun);
		const frame = subWorkflowCallFrame(subDef);
		const guardError = checkSubWorkflowCall(parentChain.frames, frame);
		if (guardError) {
			parentChain.abort.error = parentChain.abort.error || guardError;
			this._emitLog(parentRun, 'error', guardError, callerNode ? { nodeId: callerNode.id } : undefined);
			throw new Error(guardError);
		}

		// A Sub-Workflow is an independent workflow: its ticket definition (its own canvas) is what runs. The workflow it
		// was extracted from is never read here (resolveSubWorkflow already returned the latest saved definition).
		const liveNodes: IFlowchartNode[] = JSON.parse(JSON.stringify(subDef.nodes || []));
		const liveLinks: IFlowchartLink[] = JSON.parse(JSON.stringify(subDef.links || []));

		const childFlowchartData: IFlowchartData = {
			nodes: liveNodes,
			links: liveLinks
		};
		if (!childFlowchartData.nodes || childFlowchartData.nodes.length === 0) {
			throw new Error(`Sub-Workflow '${subDef.name}' contains no nodes.`);
		}

		const childRunId = `subrun_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
		const childWorkflowUri = subDef.sourceWorkflowUri || parentRun.workflowUri;
		const childRun: IWorkflowExecutionRun = {
			runId: childRunId,
			workflowUri: childWorkflowUri,
			workflowName: subDef.name,
			status: 'running',
			mode: 'standard',
			fullSpeed: parentRun.fullSpeed,
			trigger: 'manual',
			currentNodeId: undefined,
			visitedNodeIds: [],
			startedAt: Date.now(),
			updatedAt: Date.now(),
			contextVariables: { ...resolvedInputs, __callerInputKeys__: Object.keys(resolvedInputs) },
			nodeStates: {},
			linkStates: {},
			executionPath: [],
			isSubWorkflowRun: true,
			subWorkflowNamespace: subDef.namespace || generateSmartPythonVarName(subDef.name, 'sub_workflow'),
			subWorkflowId: subDef.id,
			parentRunId: parentRun.runId,
			parentWorkflowUri: parentRun.workflowUri,
			callerNodeId: callerNode?.id,
			callerNodeLabel: callerNode?.label,
			logs: []
		};
		(childRun as IInternalWorkflowRun)._callChain = extendSubWorkflowCallChain(parentChain, frame, childRunId);
		const childCanvasUri = subDef.ticketFolderUri || childWorkflowUri;
		(childRun as IInternalWorkflowRun)._canvasUri = childCanvasUri;
		(childRun as IInternalWorkflowRun)._displayRunId = (parentRun as IInternalWorkflowRun)._displayRunId || parentRun.runId;
		(childRun as IInternalWorkflowRun)._displayWorkflowUri = (parentRun as IInternalWorkflowRun)._displayWorkflowUri || parentRun.workflowUri;

		for (const n of childFlowchartData.nodes) {
			childRun.nodeStates[n.id] = {
				nodeId: n.id,
				nodeLabel: n.label,
				nodeType: n.type,
				status: 'pending',
				executedTickets: []
			};
		}

		this._runs.set(childRunId, childRun);
		this._activeSubWorkflowRunIds.set(subDef.id, childRunId);
		this._onDidChangeSubWorkflowRun.fire(childRun);

		// Stream all child Sub-Workflow logs live into parent run's Execution Logs for full visibility
		const logForwarder = this.onDidEmitLog(({ runId: emittedRunId, log }) => {
			if (emittedRunId === childRunId) {
				this._emitLog(
					parentRun,
					log.level,
					`  [Sub-Workflow: ${subDef.name}] ${log.message}`,
					{ nodeId: log.nodeId }
				);
			}
		});

		try {
			await this._runWorkflowAsync(childRun, childFlowchartData, {
				mode: 'standard',
				fullSpeed: parentRun.fullSpeed,
				initialInputs: resolvedInputs,
				initialData: childFlowchartData
			});
			return childRun;
		} finally {
			logForwarder.dispose();
			if (childRun.status === 'running' || childRun.status === 'paused' || childRun.status === 'waiting_human') {
				// Execution left the engine without a final status (e.g. the parent run was stopped)
				childRun.status = 'stopped';
				childRun.completedAt = childRun.completedAt || Date.now();
			}
			if (this._activeSubWorkflowRunIds.get(subDef.id) === childRunId) {
				this._activeSubWorkflowRunIds.delete(subDef.id);
			}
			this._saveLatestSubWorkflowRun(subDef, childRun);
			this._onDidChangeSubWorkflowRun.fire(childRun);
			// Show the executed node component outputs / logs / inputs on the Sub-Workflow's own canvas (if it is open)
			for (const childNode of childFlowchartData.nodes) {
				try {
					this._onDidUpdateNodeComponents.fire({ workflowUri: childCanvasUri, nodeId: childNode.id, node: childNode });
				} catch { }
			}
			this._runs.delete(childRunId);
		}
	}

	public async invokeSubWorkflow(request: ISubWorkflowInvocationRequest): Promise<ISubWorkflowInvocationResult> {
		const startedAt = Date.now();
		const reference = (request.reference || '').trim();
		const chain = request.callChain ?? createSubWorkflowCallChain();
		let subDef: ISubWorkflowDefinition | undefined;
		let resolvedInputs: Record<string, unknown> | undefined;
		try {
			if (!reference) {
				throw new Error('No sub-workflow selected: set subWorkflowId to a sub_workflow ticket ID (find one with GET_TICKETS(ticket_type="sub_workflow")).');
			}
			subDef = await this.resolveSubWorkflow(reference, request.contextUri);
			if (!subDef) {
				throw new Error(`Sub-Workflow '${reference}' not found: no sub_workflow ticket with ID '${reference}'. Find sub-workflows with GET_TICKETS(ticket_type="sub_workflow") and use the ticket ID.`);
			}
			resolvedInputs = this._bindSubWorkflowInputs(subDef, request.inputBindings, request.variables);
			// Inside a workflow run the calling run receives the Sub-Workflow logs; otherwise a detached caller run is used
			const liveParent = chain.parentRunId ? this._runs.get(chain.parentRunId) : undefined;
			const parentRun = liveParent ?? this._createDetachedCallerRun(subDef, request);
			const childRun = await this._executeSubWorkflow(parentRun, subDef, resolvedInputs, undefined, chain);
			if (childRun.status === 'failed' || childRun.status === 'stopped') {
				const failedNode = Object.values(childRun.nodeStates || {}).find(ns => ns.status === 'failed');
				const failedNodeInfo = failedNode ? ` at node '${failedNode.nodeLabel}'` : '';
				throw new Error(chain.abort.error || `Sub-Workflow '${subDef.name}' ${childRun.status === 'stopped' ? 'was stopped' : 'failed'}${failedNodeInfo}: ${childRun.error || 'Unknown error'}`);
			}
			return {
				success: true,
				subWorkflowId: subDef.id,
				subWorkflowName: subDef.name,
				resolvedInputs,
				output: this._extractSubWorkflowOutput(childRun),
				durationMs: Date.now() - startedAt
			};
		} catch (err) {
			const message = chain.abort.error || (err instanceof Error ? err.message : String(err));
			return {
				success: false,
				subWorkflowId: subDef?.id,
				subWorkflowName: subDef?.name,
				resolvedInputs,
				durationMs: Date.now() - startedAt,
				error: message,
				callChainError: chain.abort.error
			};
		}
	}

	/** A caller run for a Sub-Workflow called outside any workflow run (a ticket run): never registered or persisted. */
	private _createDetachedCallerRun(subDef: ISubWorkflowDefinition, request: ISubWorkflowInvocationRequest): IWorkflowExecutionRun {
		const now = Date.now();
		return {
			runId: `subcall_${now}_${Math.random().toString(36).substring(2, 7)}`,
			workflowUri: subDef.sourceWorkflowUri || request.contextUri || '',
			workflowName: request.callerLabel || subDef.name,
			status: 'running',
			mode: 'standard',
			fullSpeed: true,
			trigger: 'manual',
			visitedNodeIds: [],
			startedAt: now,
			updatedAt: now,
			contextVariables: {},
			nodeStates: {},
			executionPath: [],
			logs: []
		};
	}

	public async checkSubWorkflowCallCycle(root: SubWorkflowCallGraphRoot, contextUri?: string, workspaceUri?: URI): Promise<string | undefined> {
		try {
			await this.whenSubWorkflowsReady();
			let templates: ICustomModule[] | undefined;
			const loadTemplates = async (): Promise<ICustomModule[]> => {
				if (!templates) {
					let wsUri = workspaceUri;
					if (!wsUri && contextUri) {
						try {
							wsUri = await this.workspacesExplorerService.findWorkspaceRootUri(URI.parse(contextUri));
						} catch {
							wsUri = undefined;
						}
					}
					try {
						templates = await this.customModulesService.getCustomModules(wsUri);
					} catch {
						templates = [];
					}
				}
				return templates;
			};
			const cycle = await findSubWorkflowCallCycle(root, {
				resolveSubWorkflow: ref => this.resolveSubWorkflow(ref, contextUri),
				resolveTemplate: async type => {
					const tpl = findTemplateByTicketType(await loadTemplates(), type);
					return tpl ? { id: tpl.id, name: tpl.name, fields: tpl.fields || [] } : undefined;
				}
			});
			return cycle ? formatSubWorkflowCycleError(cycle) : undefined;
		} catch (err) {
			this.logService.warn('[WorkflowExecution] Sub-workflow cycle check failed:', err);
			return undefined;
		}
	}

	/** The call chain of a run (CI-38); a top-level run starts one with its own workflow. */
	private _callChainOf(run: IWorkflowExecutionRun): ISubWorkflowCallChain {
		const internal = run as IInternalWorkflowRun;
		if (!internal._callChain) {
			internal._callChain = createSubWorkflowCallChain({ kind: 'workflow', key: run.workflowUri, label: describeCallGraphNode('workflow', run.workflowName, run.workflowUri) }, run.runId);
		}
		return internal._callChain;
	}

	/** The call chain a ticket run started by `run` carries (its parent run is `run`). */
	private _ticketCallChainOf(run: IWorkflowExecutionRun): ISubWorkflowCallChain {
		return withSubWorkflowCallParentRun(this._callChainOf(run), run.runId);
	}

	/**
	 * Resolves the inputs of a Sub-Workflow call: the Sub-Workflow defaults, overridden by the caller's bindings
	 * ({var} references and interpolation against `variables`). Shared by workflow nodes and ticket runs (CI-38).
	 */
	private _bindSubWorkflowInputs(subDef: ISubWorkflowDefinition, bindings: unknown, variables: Record<string, unknown>): Record<string, unknown> {
		const resolvedInputs: Record<string, unknown> = {};
		for (const inpDef of (subDef.inputs || [])) {
			resolvedInputs[inpDef.name] = this._coerceInputLiteral(inpDef.defaultValue ?? '');
		}
		const customBindings: Record<string, unknown> = (isWorkflowRecord(bindings) && !Array.isArray(bindings)) ? bindings : {};
		for (const [k, rawExpr] of Object.entries(customBindings)) {
			const expr = String(rawExpr ?? '').trim();
			if (!expr) {
				continue;
			}
			const directMatch = expr.match(/^(?:\{\{\s*([^{}]+?)\s*\}\}|\{\s*([^{}]+?)\s*\}|@?([a-zA-Z_][a-zA-Z0-9_]*))$/);
			if (directMatch) {
				const isExplicitBrace = Boolean(directMatch[1] || directMatch[2]);
				const refKey = (directMatch[1] || directMatch[2] || directMatch[3] || '').trim();
				if (refKey && Object.prototype.hasOwnProperty.call(variables, refKey) && variables[refKey] !== undefined) {
					resolvedInputs[k] = variables[refKey];
					continue;
				}
				if (isExplicitBrace && refKey) {
					const avail = Object.keys(variables || {})
						.filter(ck => ck && !ck.startsWith('@') && !ck.startsWith('__') && !ck.startsWith('comp_'))
						.slice(0, 20)
						.join(', ');
					throw new Error(`Sub-Workflow '${subDef.name}' input '${k}' references undefined variable '${expr}'.${avail ? ` Available variables: ${avail}` : ''}`);
				}
			}
			const unresolvedSubRefs: string[] = [];
			const interpolated = expr.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}|\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}/g, (m, g1, g2) => {
				const rk = (g1 || g2 || '').trim();
				if (rk && Object.prototype.hasOwnProperty.call(variables, rk) && variables[rk] !== undefined) {
					const v = variables[rk];
					return typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
				}
				if (rk && !unresolvedSubRefs.includes(rk)) {
					unresolvedSubRefs.push(rk);
				}
				return m;
			});
			if (unresolvedSubRefs.length > 0) {
				throw new Error(`Sub-Workflow '${subDef.name}' input '${k}' references undefined variable(s): ${unresolvedSubRefs.map(r => `{${r}}`).join(', ')}.`);
			}
			resolvedInputs[k] = this._coerceInputLiteral(interpolated);
		}
		return resolvedInputs;
	}

	/** The result of a finished Sub-Workflow run: the single output value, a dict of several outputs, or null. */
	private _extractSubWorkflowOutput(childRun: IWorkflowExecutionRun): unknown {
		const rawWorkflowOutputs = childRun.workflowOutputs ?? childRun.contextVariables['WORKFLOW_OUTPUTS'];
		let childOutput: unknown;
		if (isWorkflowRecord(rawWorkflowOutputs) && !Array.isArray(rawWorkflowOutputs)) {
			const outputKeys = Object.keys(rawWorkflowOutputs);
			if (outputKeys.length === 1) {
				// Single exported output: pass through the raw value directly (list, string, number, object, etc.) without extra dict wrapping
				childOutput = rawWorkflowOutputs[outputKeys[0]];
			} else if (outputKeys.length > 1) {
				// Multiple exported outputs: return a dict keyed by variable name (falling back to label)
				childOutput = (childRun.workflowOutputsByVarName && Object.keys(childRun.workflowOutputsByVarName).length === outputKeys.length)
					? childRun.workflowOutputsByVarName
					: rawWorkflowOutputs;
			} else {
				childOutput = childRun.contextVariables['OUTPUT'];
			}
		} else {
			childOutput = rawWorkflowOutputs ?? childRun.contextVariables['OUTPUT'];
		}
		// Like a Python function with no return value, an empty/void Sub-Workflow returns null (Python None)
		if (childOutput === undefined) {
			childOutput = null;
		}
		return childOutput;
	}

	private _ensureLatestSubWorkflowRunsLoaded(): void {
		if (this._latestSubWorkflowRunsLoaded) {
			return;
		}
		this._latestSubWorkflowRunsLoaded = true;
		try {
			const raw = this.storageService.get(WorkflowExecutionService.SUB_WORKFLOW_LATEST_RUNS_STORAGE_KEY, StorageScope.PROFILE);
			if (!raw) {
				return;
			}
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object') {
				for (const [subId, runSnapshot] of Object.entries(parsed)) {
					if (subId && runSnapshot && typeof runSnapshot === 'object') {
						this._latestSubWorkflowRuns.set(subId, runSnapshot as IWorkflowExecutionRun);
					}
				}
			}
		} catch { }
	}

	private _saveLatestSubWorkflowRun(subDef: ISubWorkflowDefinition, childRun: IWorkflowExecutionRun): void {
		this._ensureLatestSubWorkflowRunsLoaded();
		const cleanContext: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(childRun.contextVariables || {})) {
			if (k === '__callerInputKeys__') {
				continue;
			}
			cleanContext[k] = v;
		}
		const now = Date.now();
		const fullSnapshot: IWorkflowExecutionRun = {
			runId: childRun.runId,
			workflowUri: childRun.workflowUri,
			workflowName: childRun.workflowName,
			status: childRun.status,
			mode: childRun.mode,
			trigger: childRun.trigger,
			currentNodeId: childRun.currentNodeId,
			visitedNodeIds: [...(childRun.visitedNodeIds || [])],
			startedAt: childRun.startedAt,
			updatedAt: Math.max(childRun.updatedAt || 0, now),
			completedAt: childRun.completedAt || now,
			error: childRun.error,
			contextVariables: cleanContext,
			nodeStates: JSON.parse(JSON.stringify(childRun.nodeStates || {})),
			linkStates: JSON.parse(JSON.stringify(childRun.linkStates || {})),
			executionPath: [],
			isSubWorkflowRun: true,
			subWorkflowNamespace: childRun.subWorkflowNamespace,
			subWorkflowId: childRun.subWorkflowId,
			parentRunId: childRun.parentRunId,
			parentWorkflowUri: childRun.parentWorkflowUri,
			callerNodeId: childRun.callerNodeId,
			callerNodeLabel: childRun.callerNodeLabel,
			workflowOutputs: childRun.workflowOutputs,
			workflowOutputsByVarName: childRun.workflowOutputsByVarName,
			logs: []
		};
		this._latestSubWorkflowRuns.set(subDef.id, fullSnapshot);

		// Persist compact snapshots so expanding the Sub-Workflow after Cmd+R still shows its latest invoked state
		try {
			const persistObj: Record<string, unknown> = {};
			for (const [sid, snap] of this._latestSubWorkflowRuns.entries()) {
				const compactCtx: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(snap.contextVariables || {})) {
					try {
						const s = typeof v === 'string' ? v : JSON.stringify(v);
						if (s && s.length > 256 * 1024) {
							compactCtx[k] = s.substring(0, 256 * 1024) + ' ... (truncated)';
						} else {
							compactCtx[k] = v;
						}
					} catch {
						compactCtx[k] = String(v);
					}
				}
				const compactNodeStates: Record<string, unknown> = {};
				for (const [nid, nState] of Object.entries(snap.nodeStates || {})) {
					if (!nState || typeof nState !== 'object') { continue; }
					const { output: rawNodeOut, executedTickets: rawTkts, ...restState } = nState;
					compactNodeStates[nid] = {
						...restState,
						...(rawNodeOut !== undefined ? { output: this._safeCompactNodeOutput(rawNodeOut) } : {}),
						...(Array.isArray(rawTkts) ? {
							executedTickets: rawTkts.slice(-20).map((t: IExecutedTicketRecord) => ({
								ticketId: t?.ticketId,
								ticketName: t?.ticketName,
								ticketType: t?.ticketType,
								status: t?.status,
								durationMs: t?.durationMs
							}))
						} : {})
					};
				}
				persistObj[sid] = {
					...snap,
					nodeStates: compactNodeStates,
					contextVariables: compactCtx
				};
			}
			this.storageService.store(
				WorkflowExecutionService.SUB_WORKFLOW_LATEST_RUNS_STORAGE_KEY,
				JSON.stringify(persistObj),
				StorageScope.PROFILE,
				StorageTarget.USER
			);
		} catch { }
	}

	public getLatestSubWorkflowRun(subWorkflowId: string): IWorkflowExecutionRun | undefined {
		if (!subWorkflowId) {
			return undefined;
		}
		this._ensureLatestSubWorkflowRunsLoaded();
		const direct = this._latestSubWorkflowRuns.get(subWorkflowId);
		if (direct) {
			return direct;
		}
		// A migrated Sub-Workflow: its runs may be stored under the ticket ID or under its legacy subwf_... id
		const def = this.getSubWorkflowById(subWorkflowId);
		if (!def) {
			return undefined;
		}
		return this._latestSubWorkflowRuns.get(def.id) || (def.legacyId ? this._latestSubWorkflowRuns.get(def.legacyId) : undefined);
	}

	private _rebuildSubWorkflowIndexes(list: ISubWorkflowDefinition[]): void {
		this._subWorkflowsCache = list;
		this._subWorkflowByIdCache = buildSubWorkflowLookup(list);
	}

	public getActiveSubWorkflowRun(subWorkflowId: string): IWorkflowExecutionRun | undefined {
		const runKey = this.getSubWorkflowById(subWorkflowId)?.id || subWorkflowId;
		const activeRunId = this._activeSubWorkflowRunIds.get(runKey);
		const live = activeRunId ? this._runs.get(activeRunId) : undefined;
		return live || this.getLatestSubWorkflowRun(subWorkflowId);
	}

	public getSubWorkflows(): ISubWorkflowDefinition[] {
		if (this._subWorkflowsCache !== null) {
			return this._subWorkflowsCache;
		}
		// Until the Sub-Workflow tickets are loaded, serve the legacy profile-storage library so nothing disappears
		this._rebuildSubWorkflowIndexes(this._readLegacySubWorkflowLibrary());
		this._ensureSubWorkflowTicketsLoading();
		return this._subWorkflowsCache!;
	}

	public getSubWorkflowById(id: string): ISubWorkflowDefinition | undefined {
		if (!id) {
			return undefined;
		}
		if (this._subWorkflowsCache === null) {
			this.getSubWorkflows();
		}
		return this._subWorkflowByIdCache.get(id);
	}

	public whenSubWorkflowsReady(): Promise<void> {
		return this._ensureSubWorkflowTicketsLoading();
	}

	public async resolveSubWorkflow(reference: string, contextUri?: string): Promise<ISubWorkflowDefinition | undefined> {
		const ref = (reference || '').trim();
		if (!ref) {
			return undefined;
		}
		await this.whenSubWorkflowsReady();
		const known = this.getSubWorkflowById(ref);
		if (known?.ticketFolderUri) {
			return this._reloadSubWorkflowTicket(known);
		}
		if (known || isLegacySubWorkflowId(ref)) {
			return known;
		}
		// Not loaded yet (e.g. a Sub-Workflow ticket of another workspace): look the ticket up on disk by its ID
		try {
			const ticket = await this.ticketRuntimeService.getTicket(contextUri || '', ref);
			if (!ticket.success || !ticket.entityUri || !isSubWorkflowTicketType(ticket.ticketType)) {
				return undefined;
			}
			const def = await this._readSubWorkflowTicket(URI.parse(ticket.entityUri), ticket.ticketId || ref);
			if (def) {
				this._upsertSubWorkflowTicket(def);
			}
			return def;
		} catch (err) {
			this.logService.warn(`[WorkflowExecution] Could not look up Sub-Workflow ticket '${ref}':`, err);
			return undefined;
		}
	}

	/**
	 * Callers always run the latest saved version: waits for pending writes of this ticket, then re-reads its definition
	 * file (cheap) so an edit saved from its canvas, by another window or by AI is picked up. Keeps the cached copy when
	 * the file is unchanged or unreadable.
	 */
	private async _reloadSubWorkflowTicket(known: ISubWorkflowDefinition): Promise<ISubWorkflowDefinition> {
		await this._subWorkflowTicketWrites.get(known.id);
		if (!known.ticketFolderUri) {
			return known;
		}
		const fileUri = getSubWorkflowDefinitionUri(URI.parse(known.ticketFolderUri));
		try {
			const text = (await this.fileService.readFile(fileUri)).value.toString();
			if (text === this._lastWrittenSubWorkflowJson.get(known.id)) {
				return this.getSubWorkflowById(known.id) || known;
			}
			const fresh = parseSubWorkflowDefinition(text, known.id);
			if (!fresh) {
				return known;
			}
			fresh.ticketFolderUri = known.ticketFolderUri;
			this._lastWrittenSubWorkflowJson.set(fresh.id, text);
			this._upsertSubWorkflowTicket(fresh);
			return fresh;
		} catch {
			return known;
		}
	}

	public async loadSubWorkflowTicket(folderUri: URI): Promise<ISubWorkflowDefinition | undefined> {
		await this.whenSubWorkflowsReady();
		const folder = folderUri.toString();
		const known = (this._subWorkflowsCache || []).find(d => d.ticketFolderUri === folder);
		if (known) {
			return this._reloadSubWorkflowTicket(known);
		}
		const fallbackId = this.entityPersistenceService.getSnapshot(folderUri)?.ticketId || folderUri.path.split('/').filter(Boolean).pop() || '';
		const def = await this._readSubWorkflowTicket(folderUri, fallbackId);
		if (def) {
			this._upsertSubWorkflowTicket(def);
		}
		return def;
	}

	public saveSubWorkflowCanvas(subWorkflowId: string, canvas: { nodes: unknown[]; links: unknown[] }): ISubWorkflowDefinition | undefined {
		const def = this.getSubWorkflowById(subWorkflowId);
		if (!def || !def.ticketFolderUri) {
			return undefined;
		}
		const nodes: IFlowchartNode[] = JSON.parse(JSON.stringify(canvas.nodes || []));
		const links: IFlowchartLink[] = JSON.parse(JSON.stringify(canvas.links || []));
		const contract = this.resolveWorkflowIOContract({ nodes, links });
		const next: ISubWorkflowDefinition = {
			...def,
			nodes,
			links,
			nodeIds: nodes.map(n => n.id),
			inputs: contract.inputs,
			outputs: contract.outputs,
			updatedAt: Date.now()
		};
		this.saveSubWorkflow(next);
		return this.getSubWorkflowById(def.id) || next;
	}

	public async createSubWorkflowTicket(draft: ISubWorkflowDefinition): Promise<ISubWorkflowDefinition> {
		await this.whenSubWorkflowsReady();
		const def = await this._subWorkflowTicketSequencer.queue(() => this._createSubWorkflowTicketNow(draft, false));
		this._upsertSubWorkflowTicket(def);
		return def;
	}

	public saveSubWorkflow(def: ISubWorkflowDefinition): void {
		const { cleaned } = stripHeavyMediaFromSubWorkflow(def);
		const list = [...this.getSubWorkflows()];
		const idx = list.findIndex(s => s.id === cleaned.id);
		if (idx >= 0) {
			// Keep where the ticket lives even when the caller passes a copy without the runtime-only folder
			cleaned.ticketFolderUri = cleaned.ticketFolderUri || list[idx].ticketFolderUri;
			cleaned.legacyId = cleaned.legacyId || list[idx].legacyId;
			if (!cleaned.legacyId) {
				delete cleaned.legacyId;
			}
			list[idx] = cleaned;
		} else {
			list.unshift(cleaned);
		}
		this._rebuildSubWorkflowIndexes(list);
		if (cleaned.ticketFolderUri) {
			// The ticket file is the definition: every save of its canvas is written there (and ticket.md is updated)
			this._queueSubWorkflowTicketWrite(cleaned);
		} else {
			this._storeLegacySubWorkflow(cleaned);
		}
		this._onDidChangeSubWorkflows.fire();
	}

	public deleteSubWorkflow(id: string): void {
		const def = this.getSubWorkflowById(id);
		if (!def) {
			return;
		}
		const list = this.getSubWorkflows().filter(s => s !== def);
		this._rebuildSubWorkflowIndexes(list);
		if (def.ticketFolderUri) {
			this._storeSubWorkflowTicketIndex();
			if (def.legacyId) {
				// Deleted by the user: its legacy backup entry goes too, so it is neither migrated again nor used as a fallback
				this._removeLegacySubWorkflow(def.legacyId);
			}
			const folderUri = URI.parse(def.ticketFolderUri);
			this._lastWrittenSubWorkflowJson.delete(def.id);
			this.fileService.del(folderUri, { recursive: true, useTrash: true })
				.then(() => this.entityPersistenceService.removeSnapshot(folderUri))
				.catch(err => {
					this.logService.error(`[WorkflowExecution] Failed to move Sub-Workflow ticket '${def.id}' to the trash:`, err);
					this.notificationService.error(`Could not delete Sub-Workflow ticket '${def.id}': ${err instanceof Error ? err.message : String(err)}`);
				});
		} else {
			this._removeLegacySubWorkflow(def.id);
		}
		this._onDidChangeSubWorkflows.fire();
	}

	// ---------------------------------------------------------------------------------------------
	// Sub-Workflow tickets (CI-23): storage on disk, ticket index, one-time migration of legacy definitions
	// ---------------------------------------------------------------------------------------------

	private _ensureSubWorkflowTicketsLoading(): Promise<void> {
		if (!this._subWorkflowsReady) {
			this._subWorkflowsReady = this._subWorkflowTicketSequencer.queue(() => this._loadSubWorkflowTickets())
				.catch(err => this.logService.error('[WorkflowExecution] Failed to load Sub-Workflow tickets:', err));
			this._subWorkflowSnapshotListener ??= this.entityPersistenceService.onDidChangeSnapshots(() => this._scheduleSubWorkflowSnapshotDiscovery());
		}
		return this._subWorkflowsReady;
	}

	private _readLegacySubWorkflowLibrary(): ISubWorkflowDefinition[] {
		let raw: string | undefined;
		try {
			raw = this.storageService.get(SUB_WORKFLOWS_STORAGE_KEY, StorageScope.PROFILE);
		} catch {
			raw = undefined;
		}
		return parseLegacySubWorkflowLibrary(raw).map(def => stripHeavyMediaFromSubWorkflow(def).cleaned);
	}

	/** Writes one legacy (not migrated) definition back into the profile-storage library, keeping every other entry. */
	private _storeLegacySubWorkflow(def: ISubWorkflowDefinition): void {
		try {
			const parsed: unknown = JSON.parse(this.storageService.get(SUB_WORKFLOWS_STORAGE_KEY, StorageScope.PROFILE) || '[]');
			const list: unknown[] = Array.isArray(parsed) ? parsed : [];
			const idx = list.findIndex(item => !!item && typeof item === 'object' && (item as { id?: unknown }).id === def.id);
			const stored: ISubWorkflowDefinition = JSON.parse(JSON.stringify(def));
			delete stored.ticketFolderUri;
			if (idx >= 0) {
				list[idx] = stored;
			} else {
				list.unshift(stored);
			}
			this.storageService.store(SUB_WORKFLOWS_STORAGE_KEY, JSON.stringify(list), StorageScope.PROFILE, StorageTarget.USER);
		} catch { }
	}

	private _removeLegacySubWorkflow(id: string): void {
		try {
			const parsed: unknown = JSON.parse(this.storageService.get(SUB_WORKFLOWS_STORAGE_KEY, StorageScope.PROFILE) || '[]');
			const list: unknown[] = Array.isArray(parsed) ? parsed : [];
			const next = list.filter(item => !(item && typeof item === 'object' && (item as { id?: unknown }).id === id));
			this.storageService.store(SUB_WORKFLOWS_STORAGE_KEY, JSON.stringify(next), StorageScope.PROFILE, StorageTarget.USER);
		} catch { }
	}

	private _markLegacySubWorkflowsMigrated(legacyIds: string[]): void {
		const migrated = parseMigratedLegacyIds(this.storageService.get(SUB_WORKFLOW_MIGRATED_IDS_STORAGE_KEY, StorageScope.PROFILE));
		for (const id of legacyIds) {
			migrated.add(id);
		}
		this.storageService.store(SUB_WORKFLOW_MIGRATED_IDS_STORAGE_KEY, JSON.stringify(Array.from(migrated)), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private _storeSubWorkflowTicketIndex(): void {
		try {
			const index = buildSubWorkflowTicketIndex(this._subWorkflowsCache || []);
			this.storageService.store(SUB_WORKFLOW_TICKET_INDEX_STORAGE_KEY, JSON.stringify(index), StorageScope.PROFILE, StorageTarget.MACHINE);
		} catch { }
	}

	/** Reads a Sub-Workflow ticket's definition file; `undefined` when the folder has none or it is unreadable. */
	private async _readSubWorkflowTicket(folderUri: URI, fallbackId: string): Promise<ISubWorkflowDefinition | undefined> {
		const fileUri = getSubWorkflowDefinitionUri(folderUri);
		try {
			if (!await this.fileService.exists(fileUri)) {
				return undefined;
			}
			const text = (await this.fileService.readFile(fileUri)).value.toString();
			const def = parseSubWorkflowDefinition(text, fallbackId);
			if (!def) {
				this.logService.warn(`[WorkflowExecution] Ignoring invalid Sub-Workflow definition ${fileUri.toString()}`);
				return undefined;
			}
			def.ticketFolderUri = folderUri.toString();
			this._lastWrittenSubWorkflowJson.set(def.id, serializeSubWorkflowDefinition(def));
			return def;
		} catch (err) {
			this.logService.warn(`[WorkflowExecution] Could not read Sub-Workflow definition ${fileUri.toString()}:`, err);
			return undefined;
		}
	}

	private async _loadSubWorkflowTickets(): Promise<void> {
		const ticketDefs: ISubWorkflowDefinition[] = [];
		const seenFolders = new Set<string>();
		const addTicketDef = (def: ISubWorkflowDefinition | undefined) => {
			if (def && def.ticketFolderUri && !seenFolders.has(def.ticketFolderUri) && !ticketDefs.some(d => d.id === def.id)) {
				seenFolders.add(def.ticketFolderUri);
				ticketDefs.push(def);
			}
		};

		// 1. Known Sub-Workflow tickets (index), then any sub_workflow ticket the explorer already knows
		const index = parseSubWorkflowTicketIndex(this.storageService.get(SUB_WORKFLOW_TICKET_INDEX_STORAGE_KEY, StorageScope.PROFILE));
		for (const entry of index) {
			addTicketDef(await this._readSubWorkflowTicket(URI.parse(entry.folderUri), entry.id));
		}
		for (const snap of this.entityPersistenceService.getAllSnapshots()) {
			if (isSubWorkflowTicketType(snap.entityType) && snap.entityUri && !seenFolders.has(snap.entityUri)) {
				addTicketDef(await this._readSubWorkflowTicket(URI.parse(snap.entityUri), snap.ticketId || snap.entityName));
			}
		}

		// 2. One-time migration of the legacy profile-storage library (the stored data is kept as a backup)
		const { migrated, failed } = await this._migrateLegacySubWorkflowsNow(ticketDefs);
		for (const def of migrated) {
			addTicketDef(def);
		}
		if (failed > 0) {
			this._scheduleSubWorkflowMigrationRetry();
		}

		// Legacy definitions without a loaded ticket (migration failed, or the migrated ticket folder was not found)
		// stay usable under their legacy id
		this._rebuildSubWorkflowIndexes([...ticketDefs, ...getUncoveredLegacySubWorkflows(this._readLegacySubWorkflowLibrary(), ticketDefs)]);
		this._storeSubWorkflowTicketIndex();
		for (const def of ticketDefs) {
			await this._ensureSubWorkflowTicketSnapshot(def);
		}
		this._onDidChangeSubWorkflows.fire();
		this._scheduleMigratedSourceCanvasCleanup(0);
	}

	public async migrateLegacySubWorkflows(): Promise<void> {
		// Loading the Sub-Workflow tickets runs the migration (once per legacy id; failures are retried later)
		await this.whenSubWorkflowsReady();
	}

	/**
	 * Migrates the legacy definitions that still need a ticket (see planSubWorkflowMigration): each gets a Sub-Workflow
	 * ticket and is marked migrated; the profile-storage library is never changed (it stays as the backup).
	 */
	private async _migrateLegacySubWorkflowsNow(ticketDefs: readonly ISubWorkflowDefinition[]): Promise<{ migrated: ISubWorkflowDefinition[]; failed: number }> {
		const legacyDefs = this._readLegacySubWorkflowLibrary();
		const migratedIds = parseMigratedLegacyIds(this.storageService.get(SUB_WORKFLOW_MIGRATED_IDS_STORAGE_KEY, StorageScope.PROFILE));
		const plan = planSubWorkflowMigration(legacyDefs, ticketDefs, migratedIds);
		const migrated: ISubWorkflowDefinition[] = [];
		let failed = 0;
		for (const legacy of plan) {
			try {
				const def = await this._createSubWorkflowTicketNow(legacy, true);
				migrated.push(def);
				this._markLegacySubWorkflowsMigrated([legacy.id]);
				this.logService.info(`[WorkflowExecution] Migrated Sub-Workflow '${legacy.name}' (${legacy.id}) to ticket ${def.id} at ${def.ticketFolderUri}`);
			} catch (err) {
				// Stays usable from the legacy library under its legacy id; the migration is retried
				failed++;
				this.logService.error(`[WorkflowExecution] Failed to migrate Sub-Workflow '${legacy.name}' (${legacy.id}) to a ticket:`, err);
			}
		}
		return { migrated, failed };
	}

	private _subWorkflowMigrationAttempt = 0;
	private _subWorkflowMigrationRetryTimer: ReturnType<typeof setTimeout> | undefined;

	private _scheduleSubWorkflowMigrationRetry(): void {
		if (this._subWorkflowMigrationRetryTimer) {
			return;
		}
		const delay = getSubWorkflowMigrationRetryDelay(this._subWorkflowMigrationAttempt++);
		if (delay === undefined) {
			this.logService.warn('[WorkflowExecution] Sub-Workflow migration: some legacy Sub-Workflows could not be migrated; retrying on the next start.');
			return;
		}
		this.logService.info(`[WorkflowExecution] Sub-Workflow migration: retrying the failed ones in ${Math.round(delay / 1000)}s.`);
		this._subWorkflowMigrationRetryTimer = setTimeout(() => {
			this._subWorkflowMigrationRetryTimer = undefined;
			this._subWorkflowTicketSequencer.queue(async () => {
				const ticketDefs = (this._subWorkflowsCache || []).filter(d => !!d.ticketFolderUri);
				const { migrated, failed } = await this._migrateLegacySubWorkflowsNow(ticketDefs);
				if (migrated.length > 0) {
					const all = [...ticketDefs, ...migrated];
					this._rebuildSubWorkflowIndexes([...all, ...getUncoveredLegacySubWorkflows(this._readLegacySubWorkflowLibrary(), all)]);
					this._storeSubWorkflowTicketIndex();
					for (const def of migrated) {
						await this._ensureSubWorkflowTicketSnapshot(def);
					}
					this._onDidChangeSubWorkflows.fire();
					this._scheduleMigratedSourceCanvasCleanup(0);
				}
				if (failed > 0) {
					this._scheduleSubWorkflowMigrationRetry();
				}
			}).catch(err => this.logService.error('[WorkflowExecution] Sub-Workflow migration retry failed:', err));
		}, delay);
	}

	private _sourceCanvasCleanupTimer: ReturnType<typeof setTimeout> | undefined;

	/** Runs _cleanupMigratedSourceCanvases after `delayMs` (serialized with loading / migration) when a cleanup is pending. */
	private _scheduleMigratedSourceCanvasCleanup(delayMs: number): void {
		if (this._sourceCanvasCleanupTimer || !(this._subWorkflowsCache || []).some(d => !!d.ticketFolderUri && needsSourceCanvasCleanup(d))) {
			return;
		}
		this._sourceCanvasCleanupTimer = setTimeout(() => {
			this._sourceCanvasCleanupTimer = undefined;
			this._subWorkflowTicketSequencer.queue(() => this._cleanupMigratedSourceCanvases())
				.catch(err => this.logService.error('[WorkflowExecution] Sub-Workflow migration: source canvas cleanup failed:', err));
		}, delayMs);
	}

	/**
	 * Migrated Sub-Workflows whose nodes still sit (formerly hidden) on their source workflow's canvas: drops those nodes
	 * and every link touching them from `<source folder>/.agents/workflow_flowchart.json` (the canvas before the first
	 * cleanup is kept as `workflow_flowchart.json.bak-subworkflow-migration`), then clears `isHiddenInSource` on the
	 * ticket. A canvas open in an editor is left alone (the editor would write its copy back); it is cleaned once its
	 * last editor closes, or on the next start.
	 */
	private async _cleanupMigratedSourceCanvases(): Promise<void> {
		const byFolder = new Map<string, { folder: URI; defs: ISubWorkflowDefinition[] }>();
		for (const def of this._subWorkflowsCache || []) {
			const folder = def.ticketFolderUri && needsSourceCanvasCleanup(def) ? getSubWorkflowSourceFolder(def.sourceWorkflowUri) : undefined;
			// A workflow stored as a single file has no workflow_flowchart.json of its own: never touch its parent folder
			if (!folder || /\.(json|workflow)\/*$/i.test((def.sourceWorkflowUri || '').trim())) {
				continue;
			}
			const entry = byFolder.get(folder.toString()) || { folder, defs: [] };
			entry.defs.push(def);
			byFolder.set(folder.toString(), entry);
		}
		for (const [key, { folder, defs }] of byFolder) {
			if ((this._flowchartOwnerCounts.get(key) || 0) > 0 || defs.some(d => (this._flowchartOwnerCounts.get(d.sourceWorkflowUri || '') || 0) > 0)) {
				continue;
			}
			const fileUri = URI.joinPath(folder, '.agents', 'workflow_flowchart.json');
			try {
				if (await this.fileService.exists(fileUri)) {
					const text = (await this.fileService.readFile(fileUri)).value.toString();
					const parsed: unknown = JSON.parse(text);
					if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
						throw new Error('not a workflow canvas');
					}
					const result = removeMigratedSubWorkflowNodesFromCanvas(parsed as { nodes?: unknown; links?: unknown }, defs);
					if (result) {
						const backupUri = URI.joinPath(folder, '.agents', 'workflow_flowchart.json.bak-subworkflow-migration');
						if (!await this.fileService.exists(backupUri)) {
							await this.fileService.writeFile(backupUri, VSBuffer.fromString(text));
						}
						await this.fileService.writeFile(fileUri, VSBuffer.fromString(JSON.stringify(result.canvas)));
						this.logService.info(`[WorkflowExecution] Sub-Workflow migration: removed ${result.removedNodeIds.length} node(s) and ${result.removedLinkCount} link(s) now held by ${defs.map(d => d.id).join(', ')} from ${fileUri.toString()}`);
					}
				}
			} catch (err) {
				this.logService.warn(`[WorkflowExecution] Sub-Workflow migration: could not clean the source canvas ${fileUri.toString()}; retrying on the next start:`, err);
				continue;
			}
			for (const def of defs) {
				this.saveSubWorkflow({ ...def, isHiddenInSource: false });
			}
		}
	}

	private _scheduleSubWorkflowSnapshotDiscovery(): void {
		if (this._subWorkflowDiscoveryTimer) {
			return;
		}
		this._subWorkflowDiscoveryTimer = setTimeout(() => {
			this._subWorkflowDiscoveryTimer = undefined;
			this._subWorkflowTicketSequencer.queue(() => this._discoverSubWorkflowTicketsFromSnapshots())
				.catch(err => this.logService.warn('[WorkflowExecution] Sub-Workflow ticket discovery failed:', err));
		}, 1500);
	}

	/** Picks up sub_workflow tickets the explorer found on disk that are not loaded yet (e.g. copied or cloned in). */
	private async _discoverSubWorkflowTicketsFromSnapshots(): Promise<void> {
		const knownFolders = new Set((this._subWorkflowsCache || []).map(d => d.ticketFolderUri).filter((u): u is string => !!u));
		let added = false;
		for (const snap of this.entityPersistenceService.getAllSnapshots()) {
			if (!isSubWorkflowTicketType(snap.entityType) || !snap.entityUri || knownFolders.has(snap.entityUri)) {
				continue;
			}
			knownFolders.add(snap.entityUri);
			const def = await this._readSubWorkflowTicket(URI.parse(snap.entityUri), snap.ticketId || snap.entityName);
			if (def && !this._subWorkflowByIdCache.has(def.id)) {
				this._rebuildSubWorkflowIndexes([...(this._subWorkflowsCache || []), def]);
				added = true;
			}
		}
		if (added) {
			this._storeSubWorkflowTicketIndex();
			this._onDidChangeSubWorkflows.fire();
		}
	}

	private _upsertSubWorkflowTicket(def: ISubWorkflowDefinition): void {
		const list = [...this.getSubWorkflows()];
		const idx = list.findIndex(s => s.id === def.id || (def.legacyId !== undefined && s.id === def.legacyId));
		if (idx >= 0) {
			list[idx] = def;
		} else {
			list.unshift(def);
		}
		this._rebuildSubWorkflowIndexes(list);
		this._storeSubWorkflowTicketIndex();
		this._ensureSubWorkflowTicketSnapshot(def).catch(() => { });
		this._onDidChangeSubWorkflows.fire();
	}

	/** The folder for Sub-Workflow tickets whose source workflow no longer exists: `<AnyAgent global folder>/workflows` (CI-26). */
	private async _getGlobalSubWorkflowParentFolder(): Promise<URI> {
		const folder = this._getAnyAgentGlobalFolders().workflows;
		if (!await this.fileService.exists(folder)) {
			try {
				await this.fileService.createFolder(folder);
			} catch (err) {
				throw toFolderAccessError(err, folder);
			}
		}
		return folder;
	}

	/** The user's AnyAgent global folder and its subfolders (Settings > Agent Customizations). */
	private _getAnyAgentGlobalFolders(): IAnyAgentGlobalFolders {
		return getAnyAgentGlobalFolders(this.storageService, this.pathService.userHome({ preferLocal: true }));
	}

	/**
	 * Creates the Sub-Workflow ticket for `draft` with the normal ticket numbering of its parent folder: the source
	 * workflow folder or, for a migrated legacy definition whose workflow is gone, `<AnyAgent global folder>/workflows`.
	 * Writes the definition file and returns the definition with the ticket ID as `id` (a legacy id is kept as `legacyId`).
	 */
	private async _createSubWorkflowTicketNow(draft: ISubWorkflowDefinition, isMigration: boolean): Promise<ISubWorkflowDefinition> {
		let parentUri: URI | undefined;
		const sourceFolder = getSubWorkflowSourceFolder(draft.sourceWorkflowUri);
		if (sourceFolder) {
			try {
				const stat = await this.fileService.stat(sourceFolder);
				parentUri = stat.isDirectory ? sourceFolder : undefined;
			} catch {
				parentUri = undefined;
			}
		}
		if (!parentUri) {
			if (!isMigration) {
				throw new Error('The workflow folder was not found. Save the workflow first, then encapsulate the nodes again.');
			}
			parentUri = await this._getGlobalSubWorkflowParentFolder();
		}
		const legacyId = isMigration ? (draft.legacyId || draft.id) : draft.legacyId;
		// The same creation path as programs / AI: createResourceUnderWorkspace writes the ticket, ticket.md summary and
		// the definition file; the source workflow is known here, so the parent folder check is skipped
		const known: ISubWorkflowDefinition = { ...draft, id: '', legacyId };
		if (!known.legacyId) {
			delete known.legacyId;
		}
		const result = await this.workspacesExplorerService.createResourceUnderWorkspace({
			type: SUB_WORKFLOW_TICKET_TYPE,
			targetParentUri: parentUri,
			name: '',
			title: draft.name,
			subWorkflowDefinition: known,
			subWorkflowSourceKnown: true
		});
		if (result.alreadyExists) {
			throw new Error(`A ticket folder already exists at ${result.uri.toString()}; the Sub-Workflow ticket was not created.`);
		}
		const folderUri = result.uri;
		const fallbackId = this.entityPersistenceService.getSnapshot(folderUri)?.ticketId || folderUri.path.split('/').filter(Boolean).pop() || '';
		const def = await this._readSubWorkflowTicket(folderUri, fallbackId);
		if (!def) {
			throw new Error(`The Sub-Workflow ticket was created at ${folderUri.toString()}, but its definition file could not be read.`);
		}
		this._lastWrittenSubWorkflowMeta.set(def.id, JSON.stringify(buildSubWorkflowTicketMetadata(def)));
		return def;
	}

	/** A sub_workflow ticket created by any path (programs, AI, encapsulation): load it so Call Sub-Workflow finds it at once. */
	private async _onSubWorkflowTicketCreated(folderUri: URI): Promise<void> {
		await this.whenSubWorkflowsReady();
		const folder = folderUri.toString();
		if ((this._subWorkflowsCache || []).some(d => d.ticketFolderUri === folder)) {
			return;
		}
		const def = await this._readSubWorkflowTicket(folderUri, folderUri.path.split('/').filter(Boolean).pop() || '');
		if (def && !(this._subWorkflowsCache || []).some(d => d.ticketFolderUri === folder)) {
			this._upsertSubWorkflowTicket(def);
		}
	}

	/** Makes sure GET_TICKETS sees the Sub-Workflow ticket (and its inputs / outputs summary) even before the explorer scanned it. */
	private async _ensureSubWorkflowTicketSnapshot(def: ISubWorkflowDefinition): Promise<void> {
		if (!def.ticketFolderUri) {
			return;
		}
		const meta = buildSubWorkflowTicketMetadata(def);
		const existing = this.entityPersistenceService.getSnapshot(def.ticketFolderUri);
		if (existing) {
			const merged = { ...(existing.customMetadata || {}), ...meta };
			if (JSON.stringify(merged) !== JSON.stringify(existing.customMetadata || {}) || existing.title !== def.name) {
				await this.entityPersistenceService.saveSnapshot({ ...existing, title: def.name, customMetadata: merged });
			}
			return;
		}
		await this.entityPersistenceService.saveSnapshot({
			entityUri: def.ticketFolderUri,
			entityName: def.id,
			ticketId: def.id,
			title: def.name,
			entityType: SUB_WORKFLOW_TICKET_TYPE,
			status: 'Todo',
			description: buildSubWorkflowTicketDescription(def),
			customMetadata: meta
		});
	}

	/** Writes a Sub-Workflow ticket's definition (and its ticket.md summary when that changed), in order per ticket. */
	private _queueSubWorkflowTicketWrite(def: ISubWorkflowDefinition): void {
		const snapshot: ISubWorkflowDefinition = JSON.parse(JSON.stringify(def));
		const previous = this._subWorkflowTicketWrites.get(def.id) || Promise.resolve();
		const next = previous.then(() => this._writeSubWorkflowTicket(snapshot)).catch(err => {
			this.logService.error(`[WorkflowExecution] Failed to write Sub-Workflow ticket '${def.id}':`, err);
		});
		this._subWorkflowTicketWrites.set(def.id, next);
		next.finally(() => {
			if (this._subWorkflowTicketWrites.get(def.id) === next) {
				this._subWorkflowTicketWrites.delete(def.id);
			}
		});
	}

	private async _writeSubWorkflowTicket(def: ISubWorkflowDefinition): Promise<void> {
		if (!def.ticketFolderUri) {
			return;
		}
		const folderUri = URI.parse(def.ticketFolderUri);
		const text = serializeSubWorkflowDefinition(def);
		if (this._lastWrittenSubWorkflowJson.get(def.id) !== text) {
			await this.fileService.writeFile(getSubWorkflowDefinitionUri(folderUri), VSBuffer.fromString(text));
			this._lastWrittenSubWorkflowJson.set(def.id, text);
		}
		const meta = buildSubWorkflowTicketMetadata(def);
		const metaKey = JSON.stringify(meta);
		if (this._lastWrittenSubWorkflowMeta.get(def.id) === metaKey) {
			return;
		}
		const ticketMdUri = URI.joinPath(folderUri, '.agents', 'ticket.md');
		if (await this.fileService.exists(ticketMdUri)) {
			const content = (await this.fileService.readFile(ticketMdUri)).value.toString();
			const updated = applySubWorkflowMetadataToTicketMd(content, meta);
			if (updated !== content) {
				// Derived from the definition the user saved in the canvas: recorded as a User change (CI-50)
				await writeTicketFile(this.fileService, ticketMdUri, updated, 'User');
			}
		}
		this._lastWrittenSubWorkflowMeta.set(def.id, metaKey);
		await this._ensureSubWorkflowTicketSnapshot(def);
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
					if (!stat.children) { continue; }
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
		terminal?: ITerminalInstance;
		reqCounter: number;
		stopped: boolean;
		handledRpcIds: Set<string>;
		lastSyncedVars: Map<string, unknown>;
	}>();

	private readonly _displayCardsByWorkflow = new Map<string, IWorkflowDisplayCard[]>();

	private _getWorkflowRunsFileUri(workflowUriStr: string): URI {
		try {
			const uri = URI.parse(workflowUriStr);
			const isFile = uri.path.endsWith('.json') || uri.path.endsWith('.workflow');
			const dirUri = isFile ? URI.joinPath(uri, '..') : uri;
			return URI.joinPath(dirUri, '.agents', 'workflow_runs.json');
		} catch {
			return URI.joinPath(this._getAnyAgentGlobalFolders().workflowHistory, 'default_runs.json');
		}
	}

	private _getGlobalBackupRunsFileUri(workflowUriStr: string): URI {
		const safeKey = workflowUriStr.replace(/[^a-zA-Z0-9_-]/g, '_');
		return URI.joinPath(this._getAnyAgentGlobalFolders().workflowHistory, `${safeKey}_runs.json`);
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
					if (!r.nodeStates || typeof r.nodeStates !== 'object') {
						r.nodeStates = {};
					}
					if (Array.isArray(r.logs)) {
						if (r.logs.length > 1500) {
							r.logs = r.logs.slice(-1500);
							needsPersistCleanup = true;
						}
						for (const l of r.logs) {
							if (l && typeof l.message === 'string' && l.message.length > 1200) {
								l.message = l.message.substring(0, 1200) + ' ... [truncated]';
							}
						}
					}
					if (Array.isArray(r.executionPath) && r.executionPath.length > 250) {
						r.executionPath = r.executionPath.slice(-250);
						needsPersistCleanup = true;
					}
					if (r.contextVariables && typeof r.contextVariables === 'object') {
						for (const rk of WorkflowExecutionService.RESERVED_CONTEXT_ALIAS_KEYS) {
							if (hasWorkflowProperty(r.contextVariables, rk)) {
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
			// Hydrate any archived large variables for the active/latest run so native types are ready after restart
			const activeIdAfterLoad = this._activeRunsByWorkflow.get(uriStr);
			const activeRunAfterLoad = activeIdAfterLoad ? this._runs.get(activeIdAfterLoad) : undefined;
			if (activeRunAfterLoad?.contextVariables) {
				await this._hydrateContextVariables(uriStr, activeRunAfterLoad.contextVariables);
			}
			if (needsPersistCleanup) {
				this._schedulePersist(uriStr);
			}
		}

		return this.getRunsForWorkflow(uriStr);
	}

	private _summarizeValueForHistory(val: unknown, depth: number = 0, seen: WeakSet<object> = new WeakSet()): unknown {
		if (val === null || val === undefined || typeof val === 'number' || typeof val === 'boolean' || typeof val === 'string') {
			return val;
		}
		if (typeof val === 'object') {
			if (seen.has(val) || depth >= 12) {
				return Array.isArray(val) ? [] : {};
			}
			seen.add(val);
			if (Array.isArray(val)) {
				return val.map(item => this._summarizeValueForHistory(item, depth + 1, seen));
			}
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(val)) {
				if (k === 'lastSentPayload' || k === 'pythonOutput' || k === 'lastExecutionLog' || k === 'debugSqlOutput' || k === '__omittedKeys__') {
					continue;
				}
				out[k] = this._summarizeValueForHistory(v, depth + 1, seen);
			}
			return out;
		}
		return String(val);
	}

	private _sanitizeStepResultsForHistory(stepResults?: IPrimitiveExecutionStepResult[]): IPrimitiveExecutionStepResult[] {
		if (!Array.isArray(stepResults)) {
			return [];
		}
		return stepResults.map(s => {
			let cleanDetails: Record<string, unknown> | undefined = undefined;
			if (s.details && typeof s.details === 'object') {
				cleanDetails = {};
				for (const [dk, dv] of Object.entries(s.details)) {
					if (dk === 'sqliteSync' && dv && typeof dv === 'object') {
						cleanDetails[dk] = {
							success: (dv as IWorkflowRecord).success,
							message: (dv as IWorkflowRecord).message,
							rowsAffected: (dv as IWorkflowRecord).rowsAffected,
							error: (dv as IWorkflowRecord).error
						};
					} else if (typeof dv === 'object' && dv !== null) {
						cleanDetails[dk] = this._summarizeValueForHistory(dv, 0);
					} else {
						cleanDetails[dk] = dv;
					}
				}
			}
			return {
				fieldId: s.fieldId,
				fieldLabel: s.fieldLabel,
				fieldType: s.fieldType,
				status: s.status,
				durationMs: s.durationMs,
				error: s.error,
				output: typeof s.output === 'object' && s.output !== null ? this._summarizeValueForHistory(s.output, 0) : s.output,
				details: cleanDetails
			};
		});
	}

	private _safeCompactNodeOutput(val: unknown): unknown {
		if (val === undefined || val === null || typeof val !== 'object') {
			return val;
		}
		if (Array.isArray(val)) {
			return val.map(item => this._safeCompactNodeOutput(item));
		}
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(val)) {
			if (k === '__omittedKeys__') {
				continue;
			}
			if (k === 'tickets' && Array.isArray(v)) {
				out[k] = v.map(t => ({
					ticketId: t?.ticketId,
					ticketName: t?.ticketName,
					ticketType: t?.ticketType,
					status: t?.status,
					durationMs: t?.durationMs
				}));
			} else if (typeof v === 'object' && v !== null) {
				out[k] = this._summarizeValueForHistory(v, 0);
			} else {
				out[k] = v;
			}
		}
		return out;
	}

	private static readonly LARGE_VAR_SPILL_THRESHOLD_BYTES = 16 * 1024; // 16 KB
	private readonly _spilledVarSignatures = new Map<string, string>();

	private _getWorkflowVarsDirUri(workflowUriStr: string): URI {
		const runsFileUri = this._getWorkflowRunsFileUri(workflowUriStr);
		return URI.joinPath(dirname(runsFileUri), 'workflow_vars');
	}

	private _isSpilledVarRef(val: unknown): val is { __anyagentVarRef__: true; file: string; varName: string; type: string; sizeBytes: number } {
		return isWorkflowRecord(val) && !Array.isArray(val) && val.__anyagentVarRef__ === true && typeof val.file === 'string';
	}

	private _makeSafeVarArchiveFileName(runId: string, varName: string): string {
		const safeRun = (runId || 'run').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
		const safeVar = (varName || 'var').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
		// Short deterministic hash suffix to avoid collisions between similar variable names
		let h = 2166136261;
		for (let i = 0; i < varName.length; i++) {
			h ^= varName.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
		const hashHex = (h >>> 0).toString(16).padStart(8, '0');
		return `${safeRun}__${safeVar}_${hashHex}.json`;
	}

	private async _spillVariableIfLarge(
		varsDirUri: URI,
		runId: string,
		varName: string,
		val: unknown,
		referencedFiles: Set<string>
	): Promise<unknown> {
		if (val === null || val === undefined || typeof val === 'boolean' || typeof val === 'number') {
			return val;
		}
		if (this._isSpilledVarRef(val)) {
			referencedFiles.add(val.file);
			return val;
		}
		let serializedVal = '';
		try {
			serializedVal = JSON.stringify(val);
		} catch {
			// Fallback to safe compacted structure if circular/non-serializable
			try {
				serializedVal = JSON.stringify(this._safeCompactNodeOutput(val));
			} catch {
				serializedVal = JSON.stringify(String(val));
			}
		}
		if (!serializedVal || serializedVal.length <= WorkflowExecutionService.LARGE_VAR_SPILL_THRESHOLD_BYTES) {
			return val;
		}

		const fileName = this._makeSafeVarArchiveFileName(runId, varName);
		referencedFiles.add(fileName);
		const fileUri = URI.joinPath(varsDirUri, fileName);
		const sig = `${serializedVal.length}:${serializedVal.slice(0, 48)}:${serializedVal.slice(-48)}`;
		const cacheKey = fileUri.toString();

		if (this._spilledVarSignatures.get(cacheKey) !== sig) {
			const archiveEnvelope = `{"__anyagentVarArchive__":true,"varName":${JSON.stringify(varName)},"runId":${JSON.stringify(runId)},"savedAt":${Date.now()},"value":${serializedVal}}`;
			try {
				await this.fileService.createFolder(varsDirUri);
			} catch { }
			await this.fileService.writeFile(fileUri, VSBuffer.fromString(archiveEnvelope));
			this._spilledVarSignatures.set(cacheKey, sig);
		}

		const valType = Array.isArray(val) ? 'array' : typeof val;
		return {
			__anyagentVarRef__: true,
			file: fileName,
			varName,
			type: valType,
			sizeBytes: serializedVal.length
		};
	}

	async hydrateContextVariables(workflowUri: URI | string, vars: Record<string, unknown>): Promise<Record<string, unknown>> {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		const copy: Record<string, unknown> = { ...(vars || {}) };
		await this._hydrateContextVariables(uriStr, copy);
		return copy;
	}

	private async _hydrateContextVariables(workflowUriStr: string, vars: Record<string, unknown> | undefined): Promise<void> {
		if (!vars || typeof vars !== 'object') {
			return;
		}
		const varsDirUri = this._getWorkflowVarsDirUri(workflowUriStr);
		const entries = Object.entries(vars);
		for (const [k, v] of entries) {
			if (!this._isSpilledVarRef(v)) {
				continue;
			}
			const fileUri = URI.joinPath(varsDirUri, v.file);
			try {
				if (await this.fileService.exists(fileUri)) {
					const raw = (await this.fileService.readFile(fileUri)).value.toString();
					const parsed = JSON.parse(raw);
					if (parsed && parsed.__anyagentVarArchive__ === true && Object.prototype.hasOwnProperty.call(parsed, 'value')) {
						vars[k] = parsed.value;
					} else {
						vars[k] = parsed;
					}
				}
			} catch (err) {
				this.logService.warn(`[WorkflowExecution] Failed to hydrate archived variable '${k}' from ${v.file}:`, err);
			}
		}
	}

	private async _cleanupOrphanedVarArchives(varsDirUri: URI, referencedFiles: Set<string>): Promise<void> {
		try {
			if (!(await this.fileService.exists(varsDirUri))) {
				return;
			}
			const dirStat = await this.fileService.resolve(varsDirUri);
			for (const child of (dirStat.children || [])) {
				if (!child.isDirectory && child.name.endsWith('.json') && !referencedFiles.has(child.name)) {
					try {
						await this.fileService.del(child.resource);
						this._spilledVarSignatures.delete(child.resource.toString());
					} catch { }
				}
			}
		} catch { }
	}

	private async _clearWorkflowVarsDir(workflowUriStr: string): Promise<void> {
		try {
			const varsDirUri = this._getWorkflowVarsDirUri(workflowUriStr);
			if (await this.fileService.exists(varsDirUri)) {
				await this.fileService.del(varsDirUri, { recursive: true });
			}
			const prefix = varsDirUri.toString();
			for (const key of Array.from(this._spilledVarSignatures.keys())) {
				if (key.startsWith(prefix)) {
					this._spilledVarSignatures.delete(key);
				}
			}
		} catch { }
	}

	async persistRunsForWorkflow(workflowUri: URI | string): Promise<void> {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		const allRuns = this.getRunsForWorkflow(uriStr);
		if (allRuns.length > 8) {
			for (const oldRun of allRuns.slice(8)) {
				this._runs.delete(oldRun.runId);
			}
		}
		const varsDirUri = this._getWorkflowVarsDirUri(uriStr);
		const referencedVarFiles = new Set<string>();

		const runs = await Promise.all(allRuns.slice(0, 8).map(async (r, runIdx) => {
			const cleanVars: Record<string, unknown> = {};
			if (r.contextVariables) {
				for (const [k, v] of Object.entries(r.contextVariables)) {
					if (WorkflowExecutionService.RESERVED_CONTEXT_ALIAS_KEYS.has(k)) {
						continue;
					}
					if (k.startsWith('@') && hasWorkflowProperty(r.contextVariables, k.substring(1))) {
						continue;
					}
					// Spill large variables (> 16 KB) to dedicated typed JSON files in .agents/workflow_vars/
					// so workflow_runs.json stays tiny & fast while NEVER dropping or truncating data!
					try {
						cleanVars[k] = await this._spillVariableIfLarge(varsDirUri, r.runId, k, v, referencedVarFiles);
					} catch {
						cleanVars[k] = typeof v === 'string' ? v.slice(0, 2000) : String(v);
					}
				}
			}
			const cleanNodeStates: Record<string, unknown> = {};
			if (r.nodeStates && typeof r.nodeStates === 'object') {
				for (const [nId, nState] of Object.entries(r.nodeStates)) {
					if (!nState) { continue; }
					cleanNodeStates[nId] = {
						nodeId: nState.nodeId,
						nodeLabel: nState.nodeLabel,
						nodeType: nState.nodeType,
						status: nState.status,
						startedAt: nState.startedAt,
						completedAt: nState.completedAt,
						durationMs: nState.durationMs,
						error: nState.error,
						output: this._safeCompactNodeOutput(nState.output),
						executedTickets: Array.isArray(nState.executedTickets) ? nState.executedTickets.map(t => ({
							ticketId: t.ticketId,
							ticketName: t.ticketName,
							ticketType: t.ticketType,
							status: t.status,
							output: (runIdx === 0)
								? (typeof t.output === 'object' && t.output !== null ? this._fastPreviewString(t.output, 2000) : t.output)
								: (typeof t.output === 'object' && t.output !== null ? this._fastPreviewString(t.output, 200) : t.output),
							outputSpecs: t.outputSpecs,
							stepResults: Array.isArray(t.stepResults) ? t.stepResults.map(s => ({
								fieldId: s.fieldId,
								fieldLabel: s.fieldLabel,
								fieldType: s.fieldType,
								status: s.status,
								durationMs: s.durationMs,
								error: s.error
							})) : [],
							durationMs: t.durationMs
						})) : []
					};
				}
			}
			const cleanExecutionPath = Array.isArray(r.executionPath)
				? r.executionPath.slice(-50).map(step => ({
					...step,
					operations: Array.isArray(step.operations) ? step.operations.map(op => {
						if (op && op.executedTicket) {
							const et = op.executedTicket;
							return {
								...op,
								executedTicket: {
									ticketId: et.ticketId,
									ticketName: et.ticketName,
									ticketType: et.ticketType,
									status: et.status,
									durationMs: et.durationMs
								}
							};
						}
						return op;
					}) : []
				}))
				: [];
			const cleanLogs = (r.logs || []).slice(-500).map(l => ({
				...l,
				message: typeof l.message === 'string' && l.message.length > 2000
					? l.message.substring(0, 2000) + ' ... [truncated]'
					: l.message
			}));
			return {
				...r,
				contextVariables: cleanVars,
				nodeStates: cleanNodeStates,
				executionPath: cleanExecutionPath,
				logs: cleanLogs
			};
		}));

		let jsonStr = '';
		try {
			jsonStr = JSON.stringify(runs);
		} catch (strErr) {
			this.logService.warn(`[WorkflowExecution] JSON.stringify failed on ${runs.length} runs, attempting safe fallback while preserving contextVariables:`, strErr);
			try {
				const minimalRuns = runs.slice(0, 3).map(r => ({
					runId: r.runId,
					runNumber: r.runNumber,
					workflowUri: r.workflowUri,
					workflowName: r.workflowName,
					status: r.status,
					startedAt: r.startedAt,
					completedAt: r.completedAt,
					durationMs: r.durationMs,
					error: r.error,
					contextVariables: r.contextVariables || {},
					nodeStates: r.nodeStates || {},
					linkStates: r.linkStates || {},
					logs: (r.logs || []).slice(-100)
				}));
				jsonStr = JSON.stringify(minimalRuns);
			} catch (fallbackErr) {
				this.logService.error(`[WorkflowExecution] Failed to serialize workflow runs even after compacting:`, fallbackErr);
				return;
			}
		}

		// Enforce safety ceiling (max 6 MB) while ALWAYS preserving contextVariables (already spilled as tiny refs) & linkStates
		if (jsonStr.length > 6 * 1024 * 1024) {
			this.logService.warn(`[WorkflowExecution] Serialized runs size is ${(jsonStr.length / 1024 / 1024).toFixed(2)} MB, trimming heavy logs/history while preserving contextVariables.`);
			const minimalRuns = runs.slice(0, 3).map(r => ({
				runId: r.runId,
				runNumber: r.runNumber,
				workflowUri: r.workflowUri,
				workflowName: r.workflowName,
				status: r.status,
				startedAt: r.startedAt,
				completedAt: r.completedAt,
				durationMs: r.durationMs,
				error: r.error,
				contextVariables: r.contextVariables || {},
				nodeStates: r.nodeStates || {},
				linkStates: r.linkStates || {},
				logs: (r.logs || []).slice(-50)
			}));
			jsonStr = JSON.stringify(minimalRuns);
		}

		// Garbage-collect orphaned variable archive files no longer referenced by any retained run
		void this._cleanupOrphanedVarArchives(varsDirUri, referencedVarFiles);

		const buffer = VSBuffer.fromString(jsonStr);

		// 1. Primary location (.agents/workflow_runs.json)
		const primaryFileUri = this._getWorkflowRunsFileUri(uriStr);
		try {
			const parentDir = URI.joinPath(primaryFileUri, '..');
			if (!(await this.fileService.exists(parentDir))) {
				await this.fileService.createFolder(parentDir);
			}
			await this.fileService.writeFile(primaryFileUri, buffer);
			this.logService.info(`[WorkflowExecution] Persisted ${runs.length} runs (${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB) to ${primaryFileUri.toString()}`);
		} catch (err) {
			this.logService.warn(`[WorkflowExecution] Failed to write runs to ${primaryFileUri.toString()}:`, err);
		}

		// 2. Global backup location (<AnyAgent global folder>/workflow_history/<safeKey>_runs.json)
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

	private _fastPreviewString(val: unknown, maxLen: number = 180): string {
		if (val === undefined) { return 'undefined'; }
		if (val === null) { return 'null'; }
		if (typeof val === 'string') {
			return val.length > maxLen ? val.substring(0, maxLen) + '...' : val;
		}
		if (typeof val === 'number' || typeof val === 'boolean') {
			return String(val);
		}
		if (Array.isArray(val)) {
			if (val.length === 0) { return '[]'; }
			try {
				const firstStr = JSON.stringify(this._summarizeValueForHistory(val[0], 2));
				const preview = val.length === 1 ? `[${firstStr}]` : `[${firstStr}, ... (${val.length} items)]`;
				return preview.length > maxLen ? preview.substring(0, maxLen) + '...' : preview;
			} catch {
				return `[Array(${val.length})]`;
			}
		}
		if (typeof val === 'object') {
			try {
				const s = JSON.stringify(this._summarizeValueForHistory(val, 2));
				return s.length > maxLen ? s.substring(0, maxLen) + '...' : s;
			} catch {
				return '[Object]';
			}
		}
		return String(val).substring(0, maxLen);
	}

	private _schedulePersist(workflowUriStr: string): void {
		if (this._persistDebounceMap.has(workflowUriStr)) {
			clearTimeout(this._persistDebounceMap.get(workflowUriStr));
		}
		const activeRun = this.getActiveRun(workflowUriStr);
		const delayMs = activeRun && activeRun.status === 'running' ? 5000 : 800;
		const timeout = setTimeout(() => {
			this._persistDebounceMap.delete(workflowUriStr);
			this.persistRunsForWorkflow(workflowUriStr);
		}, delayMs);
		this._persistDebounceMap.set(workflowUriStr, timeout);
	}

	getActiveRun(workflowUri: URI | string): IWorkflowExecutionRun | undefined {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		const runId = this._activeRunsByWorkflow.get(uriStr);
		const run = runId ? this._runs.get(runId) : undefined;
		if (run && (!run.nodeStates || typeof run.nodeStates !== 'object')) {
			run.nodeStates = {};
		}
		return run;
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
		void this._clearWorkflowVarsDir(uriStr);
		void this.persistRunsForWorkflow(uriStr);

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

	resetNodes(workflowUri: URI | string, nodeIds: string[], variableNamesToClear?: string[]): void {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
			return;
		}
		const targetSet = new Set(nodeIds.filter(Boolean));
		if (targetSet.size === 0) {
			return;
		}
		const activeRunId = this._activeRunsByWorkflow.get(uriStr);
		let targetRun = activeRunId ? this._runs.get(activeRunId) : undefined;
		if (!targetRun) {
			const runs = this.getRunsForWorkflow(uriStr);
			if (runs.length > 0) {
				targetRun = runs[0];
				this._activeRunsByWorkflow.set(uriStr, targetRun.runId);
			}
		}
		if (!targetRun) {
			return;
		}

		// Reset only selected node states and their outgoing link states
		if (targetRun.nodeStates && typeof targetRun.nodeStates === 'object') {
			for (const nid of targetSet) {
				const prev = targetRun.nodeStates[nid];
				if (prev) {
					targetRun.nodeStates[nid] = {
						nodeId: nid,
						nodeLabel: prev.nodeLabel,
						nodeType: prev.nodeType,
						status: 'pending',
						executedTickets: []
					};
				}
			}
		}
		if (targetRun.linkStates && typeof targetRun.linkStates === 'object') {
			for (const lk of Object.keys(targetRun.linkStates)) {
				for (const nid of targetSet) {
					if (lk.startsWith(`${nid}->`)) {
						delete targetRun.linkStates[lk];
						break;
					}
				}
			}
		}
		if (Array.isArray(targetRun.visitedNodeIds)) {
			targetRun.visitedNodeIds = targetRun.visitedNodeIds.filter(id => !targetSet.has(id));
		}
		if (targetRun.contextVariables && Array.isArray(variableNamesToClear)) {
			for (const rawName of variableNamesToClear) {
				const clean = (rawName || '').trim().replace(/^@/, '');
				if (!clean) { continue; }
				delete targetRun.contextVariables[clean];
				delete targetRun.contextVariables[`@${clean}`];
			}
		}
		targetRun.updatedAt = Date.now();
		this._notifyRunChanged(targetRun);
		void this.persistRunsForWorkflow(uriStr);
	}

	async executeWorkflow(workflowUri: URI | string, options?: IWorkflowEngineOptions): Promise<IWorkflowExecutionRun> {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		// Ensure persisted runs from before app restart are loaded so prior node data is never lost
		if (this.getRunsForWorkflow(uriStr).length === 0) {
			try {
				await this.loadRunsForWorkflow(uriStr);
			} catch { }
		}
		const isPartialRun = Boolean((options?.selectedNodeIds && options.selectedNodeIds.length > 0) || options?.entryNodeId);
		const existingRunId = this._activeRunsByWorkflow.get(uriStr);
		const inheritedContextVariables: Record<string, unknown> = {};
		let priorStateSource: IWorkflowExecutionRun | undefined;
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
			if (existing) {
				priorStateSource = existing;
				if (existing.contextVariables && isPartialRun) {
					for (const [k, v] of Object.entries(existing.contextVariables)) {
						if (v !== undefined && !WorkflowExecutionService.RESERVED_CONTEXT_ALIAS_KEYS.has(k)) {
							inheritedContextVariables[k] = v;
						}
					}
				}
			}
		}

		// If running a selective node/subset or from a mid-workflow node and no variables found in active run, inherit from latest prior run that has data
		if (isPartialRun) {
			const priorRunsList = this.getRunsForWorkflow(uriStr);
			if (!priorStateSource && priorRunsList.length > 0) {
				priorStateSource = priorRunsList[0];
			}
			if (Object.keys(inheritedContextVariables).length === 0) {
				for (const pr of priorRunsList) {
					if (pr?.contextVariables && Object.keys(pr.contextVariables).length > 0) {
						for (const [k, v] of Object.entries(pr.contextVariables)) {
							if (v !== undefined && !WorkflowExecutionService.RESERVED_CONTEXT_ALIAS_KEYS.has(k)) {
								inheritedContextVariables[k] = v;
							}
						}
						if (!priorStateSource || Object.keys(priorStateSource.nodeStates || {}).length === 0) {
							priorStateSource = pr;
						}
						if (Object.keys(inheritedContextVariables).length > 0) {
							break;
						}
					}
				}
			}
		}

		// A partial / selective run on a Sub-Workflow ticket's own canvas inherits the variables of that Sub-Workflow's
		// latest call (e.g. jd_data_list, job_view_idx), so a node in the middle has what it needs
		if (isPartialRun && !options?.isSubWorkflowRun) {
			const ownSubWorkflow = (this._subWorkflowsCache || []).find(d => d.ticketFolderUri === uriStr);
			if (ownSubWorkflow) {
				const subRun = this.getActiveSubWorkflowRun(ownSubWorkflow.id);
				if (subRun?.contextVariables) {
					for (const [k, v] of Object.entries(subRun.contextVariables)) {
						if (v !== undefined && !WorkflowExecutionService.RESERVED_CONTEXT_ALIAS_KEYS.has(k)) {
							inheritedContextVariables[k] = v;
						}
					}
				}
			}
		}

		// Hydrate any archived large variables inherited from prior runs so native types (dict/list/str) are restored before execution
		if (Object.keys(inheritedContextVariables).length > 0) {
			await this._hydrateContextVariables(uriStr, inheritedContextVariables);
		}

		// Only clear previous Display cards when starting a fresh full workflow run from Start
		if (!isPartialRun) {
			this.clearDisplayCards(uriStr);
		}

		const flowchartData = await this._loadFlowchartData(uriStr, options);
		if (!flowchartData || !flowchartData.nodes || flowchartData.nodes.length === 0) {
			throw new Error(`Cannot execute workflow: No flowchart nodes found for ${uriStr}`);
		}

		// Recursion protection (CI-38): a run never starts when its call graph has a cycle, and a workflow started from
		// inside another run (nested workflow import) must not already be on that run's call chain
		const workflowFrame = { kind: 'workflow' as const, key: uriStr, label: describeCallGraphNode('workflow', this._resolveWorkflowName(uriStr), uriStr) };
		if (options?.callChain) {
			const nestedError = checkSubWorkflowCall(options.callChain.frames, workflowFrame);
			if (nestedError) {
				options.callChain.abort.error = options.callChain.abort.error || nestedError;
				throw new Error(nestedError);
			}
		} else {
			const cycleError = await this.checkSubWorkflowCallCycle({ kind: 'workflow', key: uriStr, label: this._resolveWorkflowName(uriStr), nodes: flowchartData.nodes }, uriStr);
			if (cycleError) {
				this.notificationService.error(cycleError);
				throw new Error(cycleError);
			}
		}

		// Unified History-to-Runtime Inheritance for Partial/Selective Runs:
		// If any visible upstream node already has a persisted `lastExecutionOutput` (the exact value shown in UI "Last Runtime Value")
		// that is missing from `inheritedContextVariables` (e.g. from older runs before sidecar archiving), backfill it here so
		// downstream nodes can immediately consume it without re-running upstream nodes.
		if (isPartialRun && !options?.isSubWorkflowRun) {
			const selectedSet = new Set(options?.selectedNodeIds || []);
			for (const n of flowchartData.nodes) {
				if (!n || selectedSet.has(n.id)) {
					continue;
				}
				for (const st of (n.pipeline || [])) {
					const comp = st?.component;
					if (!comp || comp.type === 'parameters' || comp.type === 'output' || comp.type === 'display') {
						continue;
					}
					const savedVal = (comp.type === 'python' && comp.pythonResult !== undefined)
						? comp.pythonResult
						: comp.lastExecutionOutput;
					if (savedVal === undefined) {
						continue;
					}
					const varName = (comp.outputVariableName || st.targetVariable || '').trim().replace(/^@/, '');
					if (varName && !WorkflowExecutionService.RESERVED_CONTEXT_ALIAS_KEYS.has(varName) && inheritedContextVariables[varName] === undefined) {
						inheritedContextVariables[varName] = savedVal;
					}
				}
			}
		}

		const runId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
		const workflowName = this._resolveWorkflowName(uriStr);

		const priorRuns = this.getRunsForWorkflow(uriStr);
		const maxRunNumber = priorRuns.reduce((max, r) => Math.max(max, r.runNumber || 0), 0);
		const runNumber = maxRunNumber + 1;

		const isFullSpeed = Boolean(options?.fullSpeed);
		const preservedLinkStates: Record<string, IWorkflowLinkExecutionState> = (isPartialRun && priorStateSource?.linkStates)
			? JSON.parse(JSON.stringify(priorStateSource.linkStates))
			: {};
		const preservedVisited: string[] = (isPartialRun && Array.isArray(priorStateSource?.visitedNodeIds))
			? [...priorStateSource!.visitedNodeIds]
			: [];

		const run: IWorkflowExecutionRun = {
			runId,
			runNumber,
			workflowUri: uriStr,
			workflowName,
			status: 'running',
			mode: options?.mode || 'standard',
			fullSpeed: isFullSpeed,
			trigger: 'manual',
			currentNodeId: undefined,
			visitedNodeIds: preservedVisited,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			contextVariables: { ...inheritedContextVariables, ...(options?.initialInputs || {}) },
			nodeStates: {},
			linkStates: preservedLinkStates,
			executionPath: [],
			logs: []
		};
		(run as IInternalWorkflowRun)._callChain = options?.callChain
			? extendSubWorkflowCallChain(options.callChain, workflowFrame, runId)
			: createSubWorkflowCallChain(workflowFrame, runId);

		// Initialize node states: on partial runs, preserve previous nodeStates for all unselected nodes so prior results remain intact
		const selectiveResetSet = new Set<string>(
			Array.isArray(options?.selectedNodeIds) && options!.selectedNodeIds!.length > 0
				? options!.selectedNodeIds!
				: (options?.entryNodeId ? [options.entryNodeId] : [])
		);
		for (const node of flowchartData.nodes) {
			const priorNodeState = isPartialRun ? priorStateSource?.nodeStates?.[node.id] : undefined;
			if (isPartialRun && priorNodeState && !selectiveResetSet.has(node.id)) {
				run.nodeStates[node.id] = JSON.parse(JSON.stringify(priorNodeState));
			} else {
				run.nodeStates[node.id] = {
					nodeId: node.id,
					nodeLabel: node.label,
					nodeType: node.type,
					status: 'pending',
					executedTickets: []
				};
			}
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

		this._emitLog(run, 'info', `Workflow execution initiated: '${workflowName}' (${isFullSpeed ? 'full-speed' : run.mode} mode)`);
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
			try {
				await this.persistRunsForWorkflow(run.workflowUri);
			} catch (persistErr) {
				this.logService.warn(`[WorkflowExecution] Failed to persist fatal run state:`, persistErr);
			}
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
			initialFlowchartData(options)?.links
		) {
			const incomingLinks = (initialFlowchartData(options)?.links || []).filter(l => l.to === options.entryNodeId);
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

	async resumeWorkflow(runId: string, userInput?: unknown): Promise<void> {
		const run = this._runs.get(runId);
		if (!run) {
			return;
		}

		if (run.status === 'waiting_human') {
			// A Button Group gate (CI-25): the input names the clicked button (label, id, or { approved })
			const pendingDecision = this.humanDecisionService.findForWorkflowRun(runId);
			if (pendingDecision) {
				const by = userInput && typeof userInput === 'object' && typeof (userInput as { by?: unknown }).by === 'string' ? (userInput as { by: string }).by : 'User';
				const decision = this.humanDecisionService.resolve(pendingDecision.id, userInput, by);
				if (decision) {
					this._emitLog(run, 'info', `Decision for '${pendingDecision.fieldLabel}': '${decision.label}' (by ${decision.by})`, { nodeId: pendingDecision.workflowNodeId });
				} else {
					this._emitLog(run, 'warn', `'${pendingDecision.fieldLabel}' is still waiting: the input does not name one of its buttons (${pendingDecision.buttons.map(b => b.label).join(', ')}).`, { nodeId: pendingDecision.workflowNodeId });
				}
				return;
			}
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
		this.humanDecisionService.cancelForWorkflowRun(runId);
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
		(run as IInternalWorkflowRun)._liveFlowchartData = data;
		let isDaemonLoop = run.mode === 'daemon';
		await this._startPythonKernel(run, data.pythonPath);

		try {
			const selectiveNodeIds = Array.isArray(options?.selectedNodeIds)
				? options!.selectedNodeIds!.filter(id => data.nodes.some(n => n.id === id))
				: [];
			const selectedNodeSet = selectiveNodeIds.length > 0 ? new Set(selectiveNodeIds) : undefined;

			// Resolve Workflow-level Input / Output Contract
			const ioContract = this.resolveWorkflowIOContract(data);
			run.ioContract = ioContract;
			if (ioContract.inputs.length > 0) {
				for (const inp of ioContract.inputs) {
					if (inp.name && !Object.prototype.hasOwnProperty.call(run.contextVariables, inp.name)) {
						run.contextVariables[inp.name] = this._coerceInputLiteral(inp.defaultValue ?? '');
					}
				}
			}
			if (selectiveNodeIds.length === 0 && !options?.entryNodeId && !ioContract.isValid && ioContract.errors.length > 0) {
				for (const errMsg of ioContract.errors) {
					this._emitLog(run, 'error', `[Workflow I/O Contract Error] ${errMsg}`);
				}
				const hasAnyIOComp = data.nodes.some(n => (n.pipeline || []).some(s => {
					const t = s?.component?.type;
					return t === 'parameters' || t === 'output';
				}));
				if (hasAnyIOComp) {
					throw new Error(ioContract.errors.join(' | '));
				}
			}

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
				} else if (options?.entryNodeId && data.links.some(l => l.to === entryNode.id)) {
					this._emitLog(run, 'info', `[Run From Node] Starting execution from selected node '${entryNode.label}' and continuing through remaining workflow...`);
				}

				let stepCount = 0;
				const maxSteps = options?.maxSteps || 100000;

				if (selectiveNodeIds.length > 0) {
					// Selective Multi-Node Sequential Execution
					let activeNodeIds: string[] = [entryNode.id];
					while (activeNodeIds.length > 0 && !this._cancelledRuns.has(run.runId)) {
						stepCount++;
						if (stepCount > maxSteps) {
							throw new Error(`Maximum step limit (${maxSteps}) reached. Possible infinite loop detected.`);
						}
						await new Promise(resolve => setTimeout(resolve, run.fullSpeed ? 0 : 80));
						if (run.status === 'paused') {
							await new Promise<void>(resolve => {
								this._stepWaiters.set(run.runId, resolve);
							});
						}
						if (this._cancelledRuns.has(run.runId)) {
							break;
						}
						const currentNodes = activeNodeIds
							.map(id => data.nodes.find(n => n.id === id))
							.filter((n): n is IFlowchartNode => !!n);
						if (currentNodes.length === 0) {
							break;
						}
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
							nodeState.error = undefined;
							nodeState.failedStepIndex = undefined;
							nodeState.failedStepId = undefined;
							nodeState.failedStepError = undefined;
							nodeState.failedStage = undefined;
							run.nodeStates[node.id] = nodeState;
						}
						this._notifyRunChanged(run);

						const nextNodesNested = await Promise.all(
							currentNodes.map(async (node) => {
								const nodeState = run.nodeStates[node.id];
								const nextStepSeq = ((run as IInternalWorkflowRun)._totalStepsCounter || (run.executionPath?.length || 0)) + 1;
								(run as IInternalWorkflowRun)._totalStepsCounter = nextStepSeq;
								const pathStep: IWorkflowPathStep = {
									stepIndex: nextStepSeq,
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
								if (run.executionPath.length > 250) {
									run.executionPath.splice(0, run.executionPath.length - 250);
								}
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
									this._syncNodeVariablesAfterExecution(run, node, nodeState);
								} catch (err) {
									if (this._cancelledRuns.has(run.runId) || run.status === 'stopped') {
										nodeState.status = 'pending';
										pathStep.status = 'failed';
										pathStep.error = 'Stopped by user';
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

								if (this._isEndNode(node)) {
									return [];
								}
								const selectedOutgoingLinks = data.links.filter(l => l.from === node.id && selectedNodeSet!.has(l.to));
								if (selectedOutgoingLinks.length === 0) {
									return [];
								}
								return await this._resolveNextNodes(run, node, { ...data, links: selectedOutgoingLinks }, pathStep, true);
							})
						);

						const nextActiveIds: string[] = [];
						for (const list of nextNodesNested) {
							for (const nextNode of list) {
								if (!nextActiveIds.includes(nextNode.id)) {
									nextActiveIds.push(nextNode.id);
								}
							}
						}
						if (nextActiveIds.length === 0) {
							const nextUnvisitedId = selectiveNodeIds.find(id => !run.visitedNodeIds.includes(id));
							const nextTarget = nextUnvisitedId ? data.nodes.find(n => n.id === nextUnvisitedId) : undefined;
							if (nextTarget) {
								nextActiveIds.push(nextTarget.id);
							}
						}
						activeNodeIds = nextActiveIds;
					}
				} else {
					// True DAG Parallel & Multi-Branch Convergence (Fork & Join) Engine
					const getReachableFrom = (startId: string): Set<string> => {
						const reachable = new Set<string>([startId]);
						const queue = [startId];
						while (queue.length > 0) {
							const curr = queue.shift()!;
							for (const l of data.links) {
								if (l.from === curr && !reachable.has(l.to)) {
									reachable.add(l.to);
									queue.push(l.to);
								}
							}
						}
						return reachable;
					};
					const reachableFromEntry = getReachableFrom(entryNode.id);

					// 1. Detect Back-Edges (cycles / loops) using standard DFS recursion stack
					const backEdges = new Set<string>();
					const dfsVisiting = new Set<string>();
					const dfsVisited = new Set<string>();

					const detectBackEdges = (u: string) => {
						dfsVisiting.add(u);
						for (const l of data.links) {
							if (l.from === u) {
								const v = l.to;
								if (dfsVisiting.has(v)) {
									// v is an active ancestor on the recursion stack -> Back-Edge!
									backEdges.add(l.id || `${u}->${v}`);
									backEdges.add(`${u}->${v}`);
								} else if (!dfsVisited.has(v)) {
									detectBackEdges(v);
								}
							}
						}
						dfsVisiting.delete(u);
						dfsVisited.add(u);
					};
					detectBackEdges(entryNode.id);

					for (const n of data.nodes) {
						if (!dfsVisited.has(n.id) && reachableFromEntry.has(n.id)) {
							detectBackEdges(n.id);
						}
					}

					const isBackEdgeLink = (l: { id?: string; from: string; to: string }): boolean => {
						const key = l.id || `${l.from}->${l.to}`;
						return backEdges.has(key) || backEdges.has(`${l.from}->${l.to}`);
					};

					interface IEdgeStateInfo {
						status: 'activated' | 'skipped';
						generation: number;
						preserveUntilConsumed?: boolean;
					}

					const edgeStates = new Map<string, IEdgeStateInfo>();
					const nodeGenerations = new Map<string, number>();
					nodeGenerations.set(entryNode.id, 1);
					const readyQueue: string[] = [entryNode.id];
					const runningTasks = new Map<string, Promise<void>>();
					let currentDrainedGeneration = 1;

					const getEdgeState = (l: { id?: string; from: string; to: string }): IEdgeStateInfo | undefined => {
						const key = l.id || `${l.from}->${l.to}`;
						return edgeStates.get(key) || edgeStates.get(`${l.from}->${l.to}`);
					};

					// A forward edge whose source sits inside a loop (cycle) that does NOT contain the target is a "loop exit".
					// Intra-loop branch nodes never mark their exit edges 'skipped' while the loop continues, so once the loop
					// terminates through a DIFFERENT exit, such an edge stays unresolved forever. If no node of that loop is
					// queued or still running, the edge can never fire again and must not block the downstream join.
					const isDeadLoopExitEdge = (l: { from: string; to: string }, targetNodeId: string, currentFinishingNodeId?: string): boolean => {
						const srcReach = getReachableFrom(l.from);
						const srcIsInCycle = data.links.some(x => x.from === l.from && getReachableFrom(x.to).has(l.from));
						if (!srcIsInCycle) {
							return false;
						}
						const cycleNodeIds = data.nodes
							.map(n => n.id)
							.filter(id => srcReach.has(id) && getReachableFrom(id).has(l.from));
						if (cycleNodeIds.includes(targetNodeId)) {
							return false;
						}
						return !cycleNodeIds.some(id =>
							id !== currentFinishingNodeId && (readyQueue.includes(id) || runningTasks.has(id))
						);
					};

					const isNodeReadyToExecute = (targetNodeId: string, currentFinishingNodeId?: string): { ready: boolean; shouldSkip: boolean; generation: number } => {
						const incoming = data.links.filter(l => l.to === targetNodeId && reachableFromEntry.has(l.from));
						if (incoming.length === 0) {
							return { ready: true, shouldSkip: false, generation: nodeGenerations.get(targetNodeId) || 1 };
						}

						// Partition incoming links into loop-back edges vs forward convergence edges
						const forwardIncoming = incoming.filter(l => !isBackEdgeLink(l));
						const loopIncoming = incoming.filter(l => isBackEdgeLink(l));

						// 1. Loop Re-trigger Check:
						// If any loop-back incoming edge is activated, this node is triggered by a loop completion!
						const activeLoopEdge = loopIncoming.find(l => getEdgeState(l)?.status === 'activated');
						if (activeLoopEdge) {
							const loopGen = getEdgeState(activeLoopEdge)!.generation;
							return { ready: true, shouldSkip: false, generation: loopGen };
						}

						// 2. Forward Convergence / Join Check:
						// If there are no forward incoming edges (pure loop target), it's only triggered by loops
						if (forwardIncoming.length === 0) {
							return { ready: false, shouldSkip: false, generation: 0 };
						}

						// Determine the expected generation for this forward join / target node.
						// The target generation is the maximum generation among all incoming edges.
						let targetGen = 0;
						for (const l of forwardIncoming) {
							const s = getEdgeState(l);
							if (s && s.generation > targetGen) {
								targetGen = s.generation;
							}
						}
						if (targetGen === 0) {
							targetGen = nodeGenerations.get(targetNodeId) || 1;
						}

						// Check resolution status of ALL forward incoming edges:
						// If targetNodeId is NOT inside a cycle (e.g. a Join node after a parallel branch + a loop branch),
						// one branch may have incremented its generation via internal loop iterations (e.g. gen=10)
						// while a non-looping sibling branch arrived at gen=1. Both are valid resolved arrivals!
						const targetIsInCycle = data.links.some(l => l.from === targetNodeId && getReachableFrom(l.to).has(targetNodeId));
						let allForwardResolved = true;
						let anyForwardActivated = false;
						let allForwardSkipped = true;

						for (const l of forwardIncoming) {
							const state = getEdgeState(l);
							const isResolvedInGen = state && (targetIsInCycle ? state.generation === targetGen : state.generation <= targetGen);
							if (isResolvedInGen) {
								if (state.status === 'activated') {
									anyForwardActivated = true;
									allForwardSkipped = false;
								} else if (state.status === 'skipped') {
									// Resolved as skipped
								}
							} else if (!targetIsInCycle && isDeadLoopExitEdge(l, targetNodeId, currentFinishingNodeId)) {
								// Loop-exit edge from a loop that has already terminated (no loop node queued or running):
								// it can never fire anymore, so treat it as resolved-skipped instead of blocking the join forever.
							} else {
								// undefined / pending or from an older generation (< targetGen for cyclic targets):
								// upstream branch has not yet arrived / completed!
								allForwardResolved = false;
								allForwardSkipped = false;
							}
						}

						// If all forward paths were skipped in targetGen, cascade skip
						if (allForwardResolved && allForwardSkipped) {
							return { ready: false, shouldSkip: true, generation: targetGen };
						}

						// A Join node is ONLY ready when ALL forward incoming paths have finished in targetGen,
						// and at least one path arrived with 'activated' status!
						if (allForwardResolved && anyForwardActivated) {
							return { ready: true, shouldSkip: false, generation: targetGen };
						}

						// Otherwise, at least one forward path is still pending -> MUST WAIT!
						return { ready: false, shouldSkip: false, generation: targetGen };
					};

					const cascadeSkip = (skippedNodeId: string, generation: number, visitedSkipped: Set<string> = new Set()) => {
						if (visitedSkipped.has(skippedNodeId)) {
							return;
						}
						visitedSkipped.add(skippedNodeId);
						const outgoing = data.links.filter(l => l.from === skippedNodeId);
						for (const outL of outgoing) {
							const isBack = isBackEdgeLink(outL);
							if (isBack) {
								// Never cascade-skip across loop back-edges (prevents infinite generation recursion in skipped cycles)
								continue;
							}
							const lKey = outL.id || `${outL.from}->${outL.to}`;
							const targetIsInCycle = data.links.some(l => l.from === outL.to && getReachableFrom(l.to).has(outL.to));
							const edgeInfo: IEdgeStateInfo = { status: 'skipped', generation, preserveUntilConsumed: !targetIsInCycle };
							edgeStates.set(lKey, edgeInfo);
							edgeStates.set(`${outL.from}->${outL.to}`, edgeInfo);
							if (visitedSkipped.has(outL.to)) {
								continue;
							}
							const check = isNodeReadyToExecute(outL.to, skippedNodeId);
							if (check.shouldSkip) {
								cascadeSkip(outL.to, check.generation, visitedSkipped);
							} else if (check.ready && !readyQueue.includes(outL.to) && !runningTasks.has(outL.to)) {
								nodeGenerations.set(outL.to, check.generation);
								const incLinks = data.links.filter(l => l.to === outL.to);
								for (const inc of incLinks) {
									edgeStates.delete(inc.id || `${inc.from}->${inc.to}`);
									edgeStates.delete(`${inc.from}->${inc.to}`);
								}
								readyQueue.push(outL.to);
							}
						}
					};

					const executeSingleNode = async (node: IFlowchartNode) => {
						const nodeState = run.nodeStates[node.id];
						const nextStepSeq = ((run as IInternalWorkflowRun)._totalStepsCounter || (run.executionPath?.length || 0)) + 1;
						(run as IInternalWorkflowRun)._totalStepsCounter = nextStepSeq;
						const pathStep: IWorkflowPathStep = {
							stepIndex: nextStepSeq,
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
						if (run.executionPath.length > 250) {
							run.executionPath.splice(0, run.executionPath.length - 250);
						}

						this._emitLog(run, 'info', `Executing node: '${node.label}' (${node.type})`, { nodeId: node.id });
						try {
							await this._executeNode(run, node, nodeState, pathStep);
							if (this._cancelledRuns.has(run.runId) || run.status === 'stopped') {
								nodeState.status = 'pending';
								nodeState.completedAt = Date.now();
								nodeState.durationMs = nodeState.completedAt - (nodeState.startedAt || nodeState.completedAt);
								pathStep.completedAt = nodeState.completedAt;
								pathStep.durationMs = nodeState.durationMs;
								return;
							}
							nodeState.status = 'success';
							nodeState.completedAt = Date.now();
							nodeState.durationMs = nodeState.completedAt - (nodeState.startedAt || nodeState.completedAt);
							pathStep.status = 'success';
							pathStep.completedAt = nodeState.completedAt;
							pathStep.durationMs = nodeState.durationMs;
							this._emitLog(run, 'info', `Completed node: '${node.label}' in ${nodeState.durationMs}ms`, { nodeId: node.id });
							this._syncNodeVariablesAfterExecution(run, node, nodeState);
						} catch (err) {
							if (this._cancelledRuns.has(run.runId) || run.status === 'stopped') {
								nodeState.status = 'pending';
								pathStep.status = 'failed';
								pathStep.error = 'Stopped by user';
								return;
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
							run.status = 'failed';
							run.error = nodeState.error;
							this._cancelledRuns.add(run.runId);
							throw err;
						} finally {
							this._notifyRunChanged(run);
						}

						if (this._cancelledRuns.has(run.runId) || run.status === 'stopped') {
							return;
						}

						// Check if end node
						if (this._isEndNode(node)) {
							this._emitLog(run, 'info', `Reached end node: '${node.label}'. Execution branch completed.`);
							pathStep.operations.push({
								type: 'general',
								label: `End: Completed branch at '${node.label}'`,
								details: { message: 'Reached workflow termination node' }
							});
							return;
						}

						// Resolve next nodes from this node
						const myGeneration = nodeGenerations.get(node.id) || 1;
						const nextNodes = await this._resolveNextNodes(run, node, data, pathStep);
						const outgoingLinks = data.links.filter(l => l.from === node.id);
						const nextNodeIdSet = new Set(nextNodes.map(n => n.id));

						// Detect if this node is continuing a loop (any activated outgoing edge can reach back to this node)
						const isContinuingLoop = outgoingLinks.some(outL =>
							nextNodeIdSet.has(outL.to) && getReachableFrom(outL.to).has(node.id)
						);

						for (const outL of outgoingLinks) {
							const lKey = outL.id || `${outL.from}->${outL.to}`;
							const isBack = isBackEdgeLink(outL);
							const edgeGen = isBack ? myGeneration + 1 : myGeneration;
							const isActivated = nextNodeIdSet.has(outL.to);

							// CRITICAL: While a loop node is still looping (taking a loop-continuation edge),
							// DO NOT mark its loop-exit edges as 'skipped' — they are still pending a future iteration!
							// Marking them 'skipped' would prematurely release downstream fan-in Join barriers!
							if (!isActivated && isContinuingLoop && !getReachableFrom(outL.to).has(node.id)) {
								continue;
							}

							const targetIsInCycle = data.links.some(l => l.from === outL.to && getReachableFrom(l.to).has(outL.to));
							const edgeInfo: IEdgeStateInfo = {
								status: isActivated ? 'activated' : 'skipped',
								generation: edgeGen,
								preserveUntilConsumed: !targetIsInCycle
							};
							edgeStates.set(lKey, edgeInfo);
							edgeStates.set(`${outL.from}->${outL.to}`, edgeInfo);
						}

						// Check downstream nodes for join readiness or activation
						for (const outL of outgoingLinks) {
							const targetId = outL.to;
							const isActivated = nextNodeIdSet.has(targetId);
							if (!isActivated && isContinuingLoop && !getReachableFrom(targetId).has(node.id)) {
								continue;
							}
							const check = isNodeReadyToExecute(targetId, node.id);
							if (check.ready) {
								if (!readyQueue.includes(targetId) && !runningTasks.has(targetId)) {
									nodeGenerations.set(targetId, check.generation);
									// Consume edge states for this join node so loops can re-evaluate
									const incoming = data.links.filter(l => l.to === targetId);
									for (const inc of incoming) {
										edgeStates.delete(inc.id || `${inc.from}->${inc.to}`);
										edgeStates.delete(`${inc.from}->${inc.to}`);
									}
									readyQueue.push(targetId);
								}
							} else if (check.shouldSkip) {
								cascadeSkip(targetId, check.generation);
							}
						}
					};

					while ((readyQueue.length > 0 || runningTasks.size > 0) && !this._cancelledRuns.has(run.runId)) {
						stepCount++;
						if (stepCount > maxSteps) {
							throw new Error(`Maximum step limit (${maxSteps}) reached. Possible infinite loop detected.`);
						}

						await new Promise(resolve => setTimeout(resolve, run.fullSpeed ? 0 : 25));

						if (run.status === 'paused') {
							await new Promise<void>(resolve => {
								this._stepWaiters.set(run.runId, resolve);
							});
						}
						if (this._cancelledRuns.has(run.runId)) {
							break;
						}

						if (run.mode === 'step' && readyQueue.length > 0 && runningTasks.size === 0) {
							run.status = 'paused';
							this._notifyRunChanged(run);
							await new Promise<void>(resolve => {
								this._stepWaiters.set(run.runId, resolve);
							});
							if (this._cancelledRuns.has(run.runId)) {
								break;
							}
						}

						while (readyQueue.length > 0 && !this._cancelledRuns.has(run.runId)) {
							// Prioritize any node belonging to currentDrainedGeneration first
							const currentGenIndex = readyQueue.findIndex(id => {
								const gen = nodeGenerations.get(id) || 1;
								const isLoopTarget = data.links.some(l => isBackEdgeLink(l) && l.to === id);
								return gen <= currentDrainedGeneration && !isLoopTarget;
							});

							let nextId: string;
							if (currentGenIndex !== -1) {
								nextId = readyQueue.splice(currentGenIndex, 1)[0];
							} else {
								// Only next-generation / loop-back nodes remain in readyQueue
								nextId = readyQueue[0];
								const targetNodeGen = nodeGenerations.get(nextId) || 1;
								const isLoopBackTarget = data.links.some(l => isBackEdgeLink(l) && l.to === nextId);

								// Iteration Draining Barrier:
								// If this node represents a transition to a new loop iteration / generation,
								// we MUST ensure all in-flight asynchronous tasks from previous generation(s) are completely drained
								// before allowing the new iteration to begin!
								if ((isLoopBackTarget || targetNodeGen > currentDrainedGeneration) && runningTasks.size > 0) {
									await Promise.race(runningTasks.values());
									continue;
								}
								readyQueue.shift();
							}

							if (runningTasks.has(nextId)) {
								continue;
							}

							const targetGen = nodeGenerations.get(nextId) || 1;
							if (targetGen > currentDrainedGeneration) {
								currentDrainedGeneration = targetGen;
								// Prune stale edgeStates for generations older than currentDrainedGeneration - 1,
								// while preserving unconsumed arrival tokens waiting at non-cyclic Join nodes!
								for (const [k, v] of edgeStates.entries()) {
									if (v.generation < currentDrainedGeneration - 1 && !v.preserveUntilConsumed) {
										edgeStates.delete(k);
									}
								}
							}
							if (runningTasks.has(nextId)) {
								continue;
							}
							const node = data.nodes.find(n => n.id === nextId);
							if (!node) { continue; }

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
							nodeState.error = undefined;
							nodeState.failedStepIndex = undefined;
							nodeState.failedStepId = undefined;
							nodeState.failedStepError = undefined;
							nodeState.failedStage = undefined;
							run.nodeStates[node.id] = nodeState;
							run.currentNodeId = node.id;
							this._notifyRunChanged(run);

							const taskPromise = (async () => {
								try {
									await executeSingleNode(node);
								} finally {
									runningTasks.delete(node.id);
								}
							})();

							runningTasks.set(node.id, taskPromise);

							if (run.mode === 'step') {
								break;
							}
						}

						if (runningTasks.size === 0 && readyQueue.length === 0) {
							break;
						}

						if (runningTasks.size > 0) {
							await Promise.race(runningTasks.values());
						}
					}
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
					// Guard: never claim outputs were exported when the Workflow Output node was never actually executed
					// (e.g. a scheduler stall). Fail loudly instead of silently returning null/undefined to the caller.
					const outNodeId = run.ioContract?.outputNodeId;
					const isFullOrSubRun = run.isSubWorkflowRun || !(options?.selectedNodeIds && options.selectedNodeIds.length > 0) && !options?.entryNodeId;
					if (outNodeId && (run.ioContract?.outputs.length || 0) > 0 && isFullOrSubRun) {
						const outState = run.nodeStates[outNodeId];
						if (!outState || outState.status !== 'success') {
							const outLabel = run.ioContract?.outputNodeLabel || outNodeId;
							run.status = 'failed';
							run.error = `Workflow '${run.workflowName}' finished without executing its output node '${outLabel}' (status: ${outState?.status || 'not reached'}). Outputs were NOT exported.`;
							if (outState) {
								outState.status = 'failed';
								outState.error = run.error;
								outState.failedStage = 'Output node never reached (execution stalled before this node)';
							}
						}
					}
				}
				if (run.status !== 'failed') {
					// Aggregate all outputs from the unique Workflow Output Node (across all output components in order)
					if (run.ioContract?.outputNodeId && run.ioContract.outputs.length > 0) {
						const aggregatedOutputs: Record<string, unknown> = {};
						const aggregatedByVar: Record<string, unknown> = {};
						for (const outDef of run.ioContract.outputs) {
							const outVal = run.contextVariables[outDef.label]
								?? run.contextVariables[outDef.varName]
								?? run.contextVariables[outDef.fieldKey];
							aggregatedOutputs[outDef.label] = outVal;
							if (outDef.varName) {
								aggregatedByVar[outDef.varName] = outVal;
							}
						}
						run.workflowOutputs = aggregatedOutputs;
						run.workflowOutputsByVarName = aggregatedByVar;
						run.contextVariables['WORKFLOW_OUTPUTS'] = aggregatedOutputs;
						this._emitLog(
							run,
							'info',
							`[Workflow Outputs] Exported ${run.ioContract.outputs.length} output(s) from '${run.ioContract.outputNodeLabel || run.ioContract.outputNodeId}': ${run.ioContract.outputs.map(o => `${o.label} [${(o.defaultFormat || 'json').toUpperCase()}]`).join(', ')}`
						);
					}
					run.status = 'completed';
					this._emitLog(run, 'info', `Workflow '${run.workflowName}' executed successfully to completion in ${(run.durationMs / 1000).toFixed(1)}s!`);
					if (!run.isSubWorkflowRun) {
						this.notificationService.info(`Workflow '${run.workflowName}' completed successfully (${(run.durationMs / 1000).toFixed(1)}s).`);
					}
				} else {
					this._emitLog(run, 'error', `Workflow '${run.workflowName}' stopped with errors in ${(run.durationMs / 1000).toFixed(1)}s: ${run.error || 'Execution blocked'}`);
					if (!run.isSubWorkflowRun) {
						this.notificationService.error(`Workflow '${run.workflowName}' execution failed: ${run.error || 'Blocked'}`);
					}
				}
				if (!run.isSubWorkflowRun) {
					if (this._persistDebounceMap.has(run.workflowUri)) {
						clearTimeout(this._persistDebounceMap.get(run.workflowUri));
						this._persistDebounceMap.delete(run.workflowUri);
					}
					this._notifyRunChanged(run);
					try {
						await this.persistRunsForWorkflow(run.workflowUri);
					} catch (persistErr) {
						this.logService.warn(`[WorkflowExecution] Non-fatal error while persisting runs for '${run.workflowName}':`, persistErr);
					}
				}
			}
		} finally {
			await this._shutdownPythonKernel(run.runId);
		}
	}

	private _syncNodeVariablesAfterExecution(
		run: IWorkflowExecutionRun,
		node: IFlowchartNode,
		nodeState: IWorkflowNodeExecutionState
	): void {
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
							if (m[1]) { pipelineAssignedVars.add(m[1]); }
						}
					}
				}
			}

			const nodeVars = this._getNodeVars(node);
			for (const v of nodeVars) {
				if (v.name) {
					const cleanVarName = v.name.replace(/^@/, '').trim();
					if (pipelineAssignedVars.has(cleanVarName)) {
						v.currentValue = run.contextVariables[cleanVarName];
						continue;
					}

					let assignedVal: unknown;
					const oldVal = run.contextVariables[cleanVarName];

					if (v.expression) {
						let expr = v.expression.trim();
						const isFunctionCall = this._isFunctionCallExpression(expr) ||
							this._isFunctionCallExpression(v.name) ||
							(node.pipeline && node.pipeline.some(p => p.type === 'call_function' && (p.targetVariable?.replace(/^@/, '') === cleanVarName || (p.expression && p.expression.includes(cleanVarName)))));

						if (isFunctionCall && run.contextVariables[cleanVarName] !== undefined) {
							assignedVal = run.contextVariables[cleanVarName];
						} else {
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
								assignedVal = lastTicket?.output ?? optionalProp(nodeState.output, 'result') ?? optionalProp(nodeState.output, 'output') ?? 'success';
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
								} catch (evalErr) {
									this._emitLog(run, 'error', `[Expression Error] '${v.name}' in '${node.label}': ${evalErr.message}`, { nodeId: node.id });
									throw evalErr;
								}
							} else if (isFunctionCall && run.contextVariables[cleanVarName] !== undefined) {
								assignedVal = run.contextVariables[cleanVarName];
							} else {
								try {
									assignedVal = this._evaluateExpressionOrLiteral(expr, run.contextVariables);
								} catch (evalErr) {
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
						assignedVal = optionalProp(nodeState.output, v.name) ?? (nodeVars.length === 1 ? (optionalProp(nodeState.output, 'value') ?? optionalProp(nodeState.output, 'returnValue')) : undefined);
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

			const userInput = await new Promise<unknown>(resolve => {
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
				initialInputs: { ...run.contextVariables },
				callChain: this._callChainOf(run)
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
				const inputParams: Record<string, unknown> = {};
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
				const inFlightTicketRecord: IExecutedTicketRecord = {
					ticketId: ticketUri || ticketName,
					ticketName: ticketName,
					ticketType: ticketType || 'task',
					status: RUNNING_TICKET_RECORD_STATUS,
					durationMs: 0,
					stepResults: []
				};
				const inFlightOp: IWorkflowNodeOperation = {
					type: 'run_ticket',
					label: `Run Ticket: '${ticketName}' [${ticketType || 'task'}]`,
					executedTicket: inFlightTicketRecord,
					durationMs: 0
				};
				pathStep?.operations.push(inFlightOp);
				this._notifyRunChanged(run);

				const execResult = await this.ticketRuntimeService.runTicket({
					workspaceUri: wsUri,
					ticketIdOrPath: ticketUri || ticketName,
					inputParams: { ...run.contextVariables, ...inputParams },
					isCancelled: () => this._cancelledRuns.has(run.runId) || run.status === 'stopped',
					callChain: this._ticketCallChainOf(run),
					humanDecisionContext: { workflowRunId: run.runId, workflowNodeId: node.id, workflowNodeLabel: node.label },
					onStepStart: (info) => {
						this._emitLog(run, 'info', `  \u25B6 [${ticketName}] Step ${info.stepIndex}/${info.totalSteps}: [${info.fieldType.toUpperCase()}] '${info.fieldLabel}' started...`, { nodeId: node.id });
						this._notifyRunChanged(run);
					},
					onStepProgress: (stepRes, idx, total) => {
						inFlightTicketRecord.stepResults = inFlightTicketRecord.stepResults || [];
						const existingIdx = inFlightTicketRecord.stepResults.findIndex(s => s.fieldId === stepRes.fieldId);
						if (existingIdx >= 0) {
							inFlightTicketRecord.stepResults[existingIdx] = stepRes;
						} else {
							inFlightTicketRecord.stepResults.push(stepRes);
						}
						this._emitLog(
							run,
							stepRes.status === 'success' ? 'info' : 'warn',
							`  ✔ [${ticketName}] Step ${idx}/${total}: [${stepRes.fieldType.toUpperCase()}] '${stepRes.fieldLabel}' -> ${stepRes.status} (${stepRes.durationMs}ms)`,
							{ nodeId: node.id }
						);
						this._notifyRunChanged(run);
					}
				});
				if (this._cancelledRuns.has(run.runId) || run.status === 'stopped') {
					throw new Error('Workflow execution was stopped');
				}
				// A recursion / depth guard inside the ticket stops this whole run (CI-38)
				const ticketChainAbort = this._callChainOf(run).abort.error;
				if (ticketChainAbort) {
					throw new Error(ticketChainAbort);
				}

				const ticketRecord: IExecutedTicketRecord = {
					ticketId: execResult.ticketId || ticketUri || ticketName,
					ticketName: execResult.ticketName || ticketName,
					ticketType: execResult.ticketType || ticketType || 'task',
					status: (execResult.success ? 'success' : 'failed') as 'success' | 'failed',
					output: this._summarizeValueForHistory(execResult.output),
					stepResults: this._sanitizeStepResultsForHistory(execResult.stepResults),
					outputSpecs: (execResult as ITicketRunResult & ITicketRunResultExtras).outputSpecs,
					durationMs: Date.now() - ticketStart
				};
				// Update in-flight references
				inFlightOp.executedTicket = ticketRecord;
				inFlightOp.durationMs = ticketRecord.durationMs;

				state.executedTickets.push(ticketRecord);
				if (state.executedTickets.length > 50) {
					state.executedTickets.splice(0, state.executedTickets.length - 50);
				}

				// Register primary outputs into contextVariables
				if (ticketRecord.ticketId) {
					run.contextVariables[ticketRecord.ticketId] = execResult.output;
				}

				// Keep a bounded sliding window of executed ticket IDs in contextVariables (max 10)
				// Pruning old tickets avoids multi-hundred-megabyte context variable bloat in long loops
				const ticketHistoryWindow: string[] = (run as IInternalWorkflowRun)._executedTicketIdsWindow || ((run as IInternalWorkflowRun)._executedTicketIdsWindow = []);
				if (ticketRecord.ticketId) {
					ticketHistoryWindow.push(ticketRecord.ticketId);
					if (ticketHistoryWindow.length > 10) {
						const staleTicketId = ticketHistoryWindow.shift();
						if (staleTicketId) {
							delete run.contextVariables[staleTicketId];
							for (const ck of Object.keys(run.contextVariables)) {
								if (ck.startsWith(`${staleTicketId}.`)) {
									delete run.contextVariables[ck];
								}
							}
							const liveKernel = this._pythonKernels.get(run.runId);
							if (liveKernel) {
								liveKernel.lastSyncedVars.delete(staleTicketId);
							}
						}
					}
				}

				// Merge granular field outputs from ticket execution into workflow context for the active ticket
				if (execResult.contextVariables && ticketRecord.ticketId) {
					for (const [k, v] of Object.entries(execResult.contextVariables)) {
						run.contextVariables[`${ticketRecord.ticketId}.${k}`] = v;
					}
				}

				for (const stepRes of execResult.stepResults) {
					this._emitLog(run, stepRes.status === 'success' ? 'info' : 'warn', `  - [${stepRes.fieldType.toUpperCase()}] ${stepRes.fieldLabel}: ${stepRes.status} (${stepRes.durationMs}ms)`);
				}

				this._emitLog(run, execResult.success ? 'info' : 'error', `Ticket '${ticketName}' finished with status: ${execResult.status} in ${ticketRecord.durationMs}ms`);
				this._notifyRunChanged(run);
				if (!execResult.success || ticketRecord.status === 'failed') {
					throw new Error(execResult.error || `Ticket '${ticketName}' execution failed`);
				}
				return ticketRecord;
			};

			for (let i = 0; i < node.pipeline.length; i++) {
				if (this._cancelledRuns.has(run.runId) || run.status === 'stopped') {
					throw new Error('Workflow execution was stopped');
				}
				const step = node.pipeline[i];
				const stepComp = step.component;
				if (step.disabled || (stepComp && stepComp.disabled)) {
					const stepTitle = stepComp?.label || step.label || step.expression || 'Step';
					this._emitLog(run, 'info', `[Step #${i + 1} Skipped] Step '${stepTitle}' is disabled / commented out, skipping execution.`, { nodeId: node.id });
					continue;
				}
				if (stepComp?.type === 'voice_note' && !stepComp.voiceRunInFlow) {
					continue;
				}
				const isDirectComponentStep = stepComp && (
					step.type === 'component' ||
					['parameters', 'output', 'prompt', 'table', 'browser', 'tts', 'media_player', 'voice_note', 'ssh', 'git', 'python', 'http_request'].includes(stepComp.type)
				);
				const isRunTicketStep = step.type === 'run_ticket' || step.type === 'run_tickets' || step.type === 'RUN_TICKETS' || step.type === 'runTickets';
				const isCallFnStep = step.type === 'call_function' || step.type === 'custom_code' || (step.expression && this._isFunctionCallExpression(step.expression));

				const isSubWorkflowStep = stepComp?.type === 'sub_workflow';
				// A git command (commit, push, clone ...) or a human decision (CI-25) is never retried automatically
				const isTicketSideEffectStep = isSubWorkflowStep || stepComp?.type === 'git' || stepComp?.type === 'button_group' || isRunTicketStep || /\b(CREATE_TICKETS|RUN_TICKETS|create_tickets|run_tickets)\s*\(/.test(step.expression || '');
				const maxStepAttempts = isTicketSideEffectStep ? 1 : 3;
				let stepAttempt = 0;

				while (stepAttempt < maxStepAttempts) {
					if (this._cancelledRuns.has(run.runId) || run.status === 'stopped') {
						throw new Error('Workflow execution was stopped');
					}
					stepAttempt++;
					const stepStartMs = Date.now();
					try {
						if (isSubWorkflowStep) {
							// subWorkflowId is the Sub-Workflow ticket ID (or the legacy subwf_... id of a migrated one)
							const subDef = await this.resolveSubWorkflow(stepComp.subWorkflowId || '', run.workflowUri);
							if (!subDef) {
								throw new Error(`Sub-Workflow '${stepComp.subWorkflowName || stepComp.subWorkflowId || stepComp.label}' not found: no sub_workflow ticket with ID '${stepComp.subWorkflowId || ''}'. Find sub-workflows with GET_TICKETS(ticket_type="sub_workflow") and use the ticket ID.`);
							}
							const resolvedInputs = this._bindSubWorkflowInputs(subDef, stepComp.subWorkflowInputs, run.contextVariables);

							try {
								stepComp.lastExecutionInputs = JSON.parse(JSON.stringify(resolvedInputs));
							} catch {
								stepComp.lastExecutionInputs = { ...resolvedInputs };
							}
							this._emitLog(run, 'info', `[Step #${i + 1}] Invoking Sub-Workflow '${subDef.name}' (${subDef.nodes.length} nodes) with inputs: ${JSON.stringify(resolvedInputs)}`, { nodeId: node.id });
							const childRun = await this._executeSubWorkflow(run, subDef, resolvedInputs, { id: node.id, label: node.label });

							if (childRun.status === 'failed') {
								const failedNode = Object.values(childRun.nodeStates || {}).find(ns => ns.status === 'failed');
								const failedNodeInfo = failedNode ? ` at node '${failedNode.nodeLabel}'` : '';
								// A recursion / depth guard stops the whole run with its own message naming the call chain (CI-38)
								const detailMsg = this._callChainOf(run).abort.error || `Sub-Workflow '${subDef.name}' failed${failedNodeInfo}: ${childRun.error || 'Unknown error'}`;
								stepComp.lastExecutionStatus = 'failed';
								stepComp.lastExecutionDurationMs = Date.now() - stepStartMs;
								stepComp.lastExecutedAt = new Date().toISOString();
								stepComp.lastExecutionLog = `>>> ${detailMsg}\nInputs: ${JSON.stringify(resolvedInputs, null, 2)}`;
								this._onDidUpdateNodeComponents.fire({ workflowUri: this._canvasUriOf(run), nodeId: node.id, node });
								throw new Error(detailMsg);
							}

							const childOutput = this._extractSubWorkflowOutput(childRun);
							const outVarName = (stepComp.outputVariableName || '').trim() || generateSmartPythonVarName(stepComp.label || subDef.name, 'sub_workflow');
							if (outVarName) {
								run.contextVariables[outVarName] = childOutput;
							}
							if (stepComp.label) {
								run.contextVariables[stepComp.label] = childOutput;
							}
							const childOutPreview = childOutput === null ? 'None' : String(JSON.stringify(childOutput) ?? 'None').substring(0, 300);
							stepComp.lastExecutionOutput = childOutput;
							stepComp.lastExecutionStatus = 'success';
							stepComp.lastExecutionDurationMs = Date.now() - stepStartMs;
							stepComp.lastExecutedAt = new Date().toISOString();
							stepComp.lastExecutionLog = `>>> Sub-Workflow '${subDef.name}' completed in ${stepComp.lastExecutionDurationMs}ms\nInputs: ${JSON.stringify(resolvedInputs)}\nOutputs: ${childOutput === null ? 'None' : JSON.stringify(childOutput, null, 2)}`;
							this._onDidUpdateNodeComponents.fire({ workflowUri: this._canvasUriOf(run), nodeId: node.id, node });
							this._emitLog(run, 'info', `[Step #${i + 1}] Sub-Workflow '${subDef.name}' completed (${stepComp.lastExecutionDurationMs}ms) -> ${outVarName} = ${childOutPreview}`, { nodeId: node.id });
							break;
						}
						if (isDirectComponentStep) {
							const wsUri = URI.parse(run.workflowUri);
							this._emitLog(run, 'info', `[Step #${i + 1}] Component [${stepComp.type.toUpperCase()}] '${stepComp.label || step.label || stepComp.type}'`);
							const compRes = await this.ticketRuntimeService.executeNodeComponent(
								wsUri,
								wsUri,
								stepComp,
								run.contextVariables,
								{ workflowRunId: run.runId, workflowNodeId: node.id, workflowNodeLabel: node.label }
							);
							if (this._cancelledRuns.has(run.runId) || run.status === 'stopped') {
								throw new Error('Workflow execution was stopped');
							}
							if (step.targetVariable && compRes.output !== undefined && stepComp.type !== 'parameters' && stepComp.type !== 'output' && stepComp.type !== 'display') {
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
								value: this._summarizeValueForHistory(compRes.output),
								durationMs: compRes.durationMs
							});
							if (stepComp.type === 'browser' && compRes.details?.resolvedUrl) {
								stepComp.lastResolvedUrl = compRes.details.resolvedUrl;
								this._emitLog(run, 'info', `[Step #${i + 1} Browser URL] Visited Target: ${compRes.details.resolvedUrl}`, { nodeId: node.id });
							}
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
							if (!run.fullSpeed) {
								await this._persistAndNotifyNodeComponents(run, node);
							}
							this._notifyRunChanged(run);
							if (compRes.status === 'failed') {
								throw new Error(compRes.error || `Component '${stepComp.label || stepComp.type}' execution failed`);
							}
						} else if (isRunTicketStep && step.ticketName) {
							this._emitLog(run, 'info', `[Step #${i + 1}] Run Ticket: '${step.ticketName}'${step.parameters ? ` (PARAM: ${step.parameters})` : ''}`);
							const ticketRecord = await runTicket(step.ticketName, step.ticketType, step.ticketUri, step.parameters);
							// Note: runTicket has already pushed ticketRecord into pathStep.operations during execution!
							if (step.targetVariable) {
								const varKey = step.targetVariable.trim().replace(/^@/, '');
								run.contextVariables[varKey] = ticketRecord.output;
								this._emitLog(run, 'info', `[Step #${i + 1}] Output stored in variable: ${varKey}`);
							}
						} else if (this._pythonKernels.has(run.runId) && (isCallFnStep || step.type === 'set_variable')) {
							let pyCode = (step.expression || '').trim();
							if (stepComp?.type === 'get_outputs' && stepComp.wfTicketField && stepComp.wfTicketField.trim()) {
								const trimmedField = stepComp.wfTicketField.trim();
								if (!/\bfield\s*=/i.test(pyCode) && /\b(?:GET_OUTPUTS|get_outputs)\s*\(/i.test(pyCode)) {
									pyCode = pyCode.replace(
										/\b(GET_OUTPUTS|get_outputs)\s*\(([^)]*)\)/,
										(_match, fn, inner) => {
											const innerTrimmed = inner.trim();
											const fieldArg = `field=${JSON.stringify(trimmedField)}`;
											return innerTrimmed ? `${fn}(${innerTrimmed}, ${fieldArg})` : `${fn}(${fieldArg})`;
										}
									);
									step.expression = pyCode;
								}
							}
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
							let val: unknown = undefined;
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
								} catch (evalErr) {
									this._emitLog(run, 'error', `[Syntax Error] Step #${i + 1} variable '${varKey}' failed to evaluate '${expr}': ${evalErr.message}`, { nodeId: node.id });
									throw new Error(`[Syntax Error] Step #${i + 1} ('${expr}'): ${evalErr.message}`);
								}
							} else if (expr) {
								try {
									const evaluator = new PythonExpressionEvaluator(expr, run.contextVariables);
									val = evaluator.evaluate();
								} catch (evalErr) {
									this._emitLog(run, 'error', `[Syntax Error] Step #${i + 1} variable '${varKey}' failed to evaluate '${expr}': ${evalErr.message}`, { nodeId: node.id });
									throw new Error(`[Syntax Error] Step #${i + 1} ('${expr}'): ${evalErr.message}`);
								}
							}
							run.contextVariables[varKey] = val;
							delete run.contextVariables[`@${varKey}`];
							const valPreview = this._fastPreviewString(val, 180);
							this._emitLog(run, 'info', `[Step #${i + 1}] Variable assigned: @${varKey} = ${valPreview}`);
							pathStep?.operations.push({
								type: 'set_variable',
								label: `Set Variable: @${varKey} = ${valPreview}`,
								details: {
									variable: varKey,
									expression: expr,
									oldValue: this._summarizeValueForHistory(oldVal),
									newValue: this._summarizeValueForHistory(val)
								}
							});
						}
						if (!isDirectComponentStep && stepComp) {
							const dur = Date.now() - stepStartMs;
							const ts = new Date().toLocaleTimeString();
							let outVal: unknown = undefined;
							let formattedDisplayLog: string | undefined = undefined;
							if (stepComp.type === 'display') {
								const wfCards = this._displayCardsByWorkflow.get(run.workflowUri) || [];
								let matchedCard = wfCards.find(c => c.nodeId === node.id);
								if (!matchedCard) {
									for (const cards of this._displayCardsByWorkflow.values()) {
										const cand = cards.find(c => c.nodeId === node.id && c.runId === run.runId);
										if (cand) {
											matchedCard = cand;
											break;
										}
									}
								}
								if (matchedCard) {
									outVal = matchedCard.value;
									const typeTag = outVal === null ? 'null'
										: Array.isArray(outVal) ? `list (${outVal.length} items)`
											: typeof outVal === 'object' ? `dict (${Object.keys(outVal).length} keys)`
												: typeof outVal;
									const bodyText = matchedCard.formattedText || matchedCard.displayPreviewText
										|| (typeof outVal === 'object' && outVal !== null ? JSON.stringify(outVal, null, 2) : String(outVal));
									formattedDisplayLog = `>>> DISPLAY (${stepComp.wfDisplayValue || matchedCard.expression || ''}) [Type: ${typeTag}]\n${bodyText}`;
								} else {
									const rawDispVar = (stepComp.wfDisplayValue || '').trim().replace(/^\{|\}$/g, '').trim();
									if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(rawDispVar) && Object.prototype.hasOwnProperty.call(run.contextVariables, rawDispVar)) {
										outVal = run.contextVariables[rawDispVar];
										const typeTag = outVal === null ? 'null'
											: Array.isArray(outVal) ? `list (${outVal.length} items)`
												: typeof outVal === 'object' ? `dict (${Object.keys(outVal).length} keys)`
													: typeof outVal;
										const bodyText = typeof outVal === 'object' && outVal !== null ? JSON.stringify(outVal, null, 2) : String(outVal);
										formattedDisplayLog = `>>> DISPLAY (${stepComp.wfDisplayValue || rawDispVar}) [Type: ${typeTag}]\n${bodyText}`;
									}
								}
							} else {
								const targetKey = (step.targetVariable || stepComp.label || '').trim().replace(/^@/, '');
								outVal = targetKey && run.contextVariables[targetKey] !== undefined
									? run.contextVariables[targetKey]
									: undefined;
							}
							stepComp.lastExecutionStatus = 'success';
							stepComp.lastExecutionDurationMs = dur;
							stepComp.lastExecutedAt = ts;
							stepComp.lastExecutionOutput = outVal;
							const rawOutStr = formattedDisplayLog !== undefined
								? formattedDisplayLog
								: (outVal !== undefined
									? (typeof outVal === 'object' && outVal !== null ? JSON.stringify(outVal, null, 2) : String(outVal))
									: 'Executed successfully');
							stepComp.lastExecutionLog = rawOutStr;
							if (!run.fullSpeed) {
								await this._persistAndNotifyNodeComponents(run, node);
							}
						}
						break;
					} catch (stepErr) {
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
							await new Promise(r => setTimeout(r, run.fullSpeed ? 20 : 250));
							continue;
						}
						if (maxStepAttempts > 1) {
							this._emitLog(run, 'error', `[Step #${i + 1} Halted] Stopping execution after ${stepAttempt} failed attempts: ${stepErr?.message || stepErr}`, { nodeId: node.id });
						}
						state.failedStepIndex = i;
						state.failedStepId = step.id;
						state.failedStepError = stepErr?.message || String(stepErr);
						state.failedStage = `Step #${i + 1}: ${(step.label || step.expression || step.type || '').split('\n')[0].trim().slice(0, 60)}`;
						throw stepErr;
					}
				}
			}

			if (run.fullSpeed) {
				await this._persistAndNotifyNodeComponents(run, node);
			}
			state.output = {
				executedSteps: node.pipeline.length,
				tickets: state.executedTickets.map(t => ({
					ticketId: t.ticketId,
					ticketName: t.ticketName,
					ticketType: t.ticketType,
					status: t.status,
					durationMs: t.durationMs
				}))
			};
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
				if (!run.fullSpeed) {
					await new Promise(r => setTimeout(r, 600));
				}

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
				if (!ref) { return undefined; }
				let clean = ref.trim().replace(/^@/, '');
				if (clean.startsWith('=')) { clean = clean.substring(1).trim(); }
				const eqIdx = clean.indexOf('=');
				if (eqIdx !== -1) { clean = clean.substring(eqIdx + 1).trim(); }
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

			state.output = {
				executedCount: ticketImports.length,
				tickets: state.executedTickets.map(t => ({
					ticketId: t.ticketId,
					ticketName: t.ticketName,
					ticketType: t.ticketType,
					status: t.status,
					durationMs: t.durationMs
				}))
			};
			return;
		}

		// 5. General Diagram Node Execution
		if (!run.fullSpeed) {
			await new Promise(r => setTimeout(r, 500));
		}
		state.output = { message: `Node '${node.label}' successfully executed` };
	}

	private _isFunctionCallExpression(expr?: string): boolean {
		if (!expr) { return false; }
		const trimmed = expr.trim();
		const m = trimmed.match(/^(?:@?[a-zA-Z0-9_\u4e00-\u9fa5]+\s*=\s*)?([a-zA-Z0-9_]+)\s*\([\s\S]*\)$/);
		if (!m) { return false; }
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
			if (match[1]) { targetVar = match[1].replace(/^@/, ''); }
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

		let result: unknown = undefined;
		const startMs = Date.now();

		try {
			if (upperFn === 'RUN_TICKETS' || upperFn === 'RUNTICKETS' || upperFn === 'RUNTICKET') {
				let ticketIdOrPath = '';
				let inputParams: Record<string, unknown> = {};

				const firstArg = args[0];
				if (args.length > 0 && isWorkflowRecord(firstArg) && !Array.isArray(firstArg)) {
					// Ticket references coming from Python are strings; the casts are type-only
					ticketIdOrPath = (firstArg.ticketId || firstArg.ticketName || firstArg.ticketIdOrPath || firstArg.ticket_name || firstArg.id || '') as string;
					inputParams = (firstArg.parameters || firstArg.inputParams || firstArg.params || {}) as IWorkflowRecord;
				} else {
					const rawTicketArg = kwargs.ticket ?? kwargs.tickets ?? kwargs.ticket_name ?? kwargs.ticket_id ?? kwargs.ticketIdOrPath ?? args[0] ?? '';
					if (Array.isArray(rawTicketArg) && rawTicketArg.length > 0) {
						const first: unknown = rawTicketArg[0];
						if (isWorkflowRecord(first)) {
							ticketIdOrPath = (first.ticketId || first.ticketName || first.ticketIdOrPath || first.id || '') as string;
							if (first.parameters && typeof first.parameters === 'object') {
								inputParams = { ...first.parameters };
							}
						} else {
							ticketIdOrPath = String(first).trim();
						}
					} else if (isWorkflowRecord(rawTicketArg)) {
						ticketIdOrPath = (rawTicketArg.ticketId || rawTicketArg.ticketName || rawTicketArg.ticketIdOrPath || rawTicketArg.id || '') as string;
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
					if (isWorkflowRecord(ctxVal) && ctxVal.ticketId) {
						ticketIdOrPath = ctxVal.ticketId as string;
					}
				}
				// Also check if any ticket was created in this run whose title or name matches ticketIdOrPath
				if (ticketIdOrPath) {
					for (const ctxVal of Object.values(run.contextVariables)) {
						if (isWorkflowRecord(ctxVal) && ctxVal.ticketId && (ctxVal.title === ticketIdOrPath || ctxVal.ticketName === ticketIdOrPath)) {
							ticketIdOrPath = ctxVal.ticketId as string;
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

				const paramKeys = Object.keys(inputParams);
				const paramSummary = paramKeys.length > 0
					? paramKeys.map(k => `${k}=${JSON.stringify(inputParams[k])}`).join(', ')
					: 'none';
				this._emitLog(run, 'info', `[RUN_TICKETS] Executing ticket '${ticketIdOrPath}' with ${paramKeys.length} parameter(s): ${paramSummary}`, { nodeId: node.id });

				const inFlightTicketRecord: IExecutedTicketRecord = {
					ticketId: ticketIdOrPath,
					ticketName: ticketIdOrPath,
					ticketType: 'task',
					status: RUNNING_TICKET_RECORD_STATUS,
					durationMs: 0,
					stepResults: []
				};
				const inFlightOp: IWorkflowNodeOperation = {
					type: 'run_ticket',
					label: `RUN_TICKETS: '${ticketIdOrPath}'`,
					executedTicket: inFlightTicketRecord,
					durationMs: 0
				};
				pathStep?.operations.push(inFlightOp);
				this._notifyRunChanged(run);

				const execRes = await this.ticketRuntimeService.RUN_TICKETS({
					workspaceUri: workflowDir,
					ticketIdOrPath,
					inputParams: inputParams,
					isCancelled: () => this._cancelledRuns.has(run.runId) || run.status === 'stopped',
					callChain: this._ticketCallChainOf(run),
					humanDecisionContext: { workflowRunId: run.runId, workflowNodeId: node.id, workflowNodeLabel: node.label },
					onStepStart: (info) => {
						this._emitLog(run, 'info', `  \u25B6 [${ticketIdOrPath}] Step ${info.stepIndex}/${info.totalSteps}: [${info.fieldType.toUpperCase()}] '${info.fieldLabel}' started...`, { nodeId: node.id });
						this._notifyRunChanged(run);
					},
					onStepProgress: (stepRes, idx, total) => {
						inFlightTicketRecord.stepResults = inFlightTicketRecord.stepResults || [];
						const existingIdx = inFlightTicketRecord.stepResults.findIndex(s => s.fieldId === stepRes.fieldId);
						if (existingIdx >= 0) {
							inFlightTicketRecord.stepResults[existingIdx] = stepRes;
						} else {
							inFlightTicketRecord.stepResults.push(stepRes);
						}
						this._emitLog(
							run,
							stepRes.status === 'success' ? 'info' : 'warn',
							`  ✔ [${ticketIdOrPath}] Step ${idx}/${total}: [${stepRes.fieldType.toUpperCase()}] '${stepRes.fieldLabel}' -> ${stepRes.status} (${stepRes.durationMs}ms)`,
							{ nodeId: node.id }
						);
						this._notifyRunChanged(run);
					}
				});

				// A recursion / depth guard inside the ticket stops this whole run (CI-38)
				const ticketChainAbort = this._callChainOf(run).abort.error;
				if (ticketChainAbort) {
					throw new Error(ticketChainAbort);
				}
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
								outputSpecs: (execRes as ITicketRunResult & ITicketRunResultExtras).outputSpecs || []
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
					output: this._summarizeValueForHistory(execRes.output),
					outputSpecs: (execRes as ITicketRunResult & ITicketRunResultExtras).outputSpecs,
					stepResults: this._sanitizeStepResultsForHistory(execRes.stepResults),
					durationMs: Date.now() - startMs
				};
				inFlightOp.executedTicket = ticketRecord;
				inFlightOp.label = `RUN_TICKETS: '${ticketRecord.ticketName || ticketRecord.ticketId}' [${ticketRecord.ticketType || 'task'}]`;
				inFlightOp.durationMs = ticketRecord.durationMs;

				state.executedTickets.push(ticketRecord);
				if (state.executedTickets.length > 50) {
					state.executedTickets.splice(0, state.executedTickets.length - 50);
				}
			} else if (upperFn === 'CREATE_TICKETS' || upperFn === 'CREATETICKETS' || upperFn === 'CREATETICKET') {
				let opts: IRpcTicketCreateOptions = {};
				const createArg = args[0];
				if (args.length === 1 && isWorkflowRecord(createArg)) {
					opts = { ...createArg };
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
					const initialFields: IWorkflowRecord = typeof rawParams === 'object' && rawParams !== null ? { ...rawParams } : {};

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
					? createParamKeys.map(k => `${k}=${this._fastPreviewString(opts.parameters?.[k], 80)}`).join(', ')
					: 'none';
				this._emitLog(run, 'info', `[CREATE_TICKETS] Creating ticket '${opts.title}' (type: ${opts.ticketType}) with ${createParamKeys.length} parameter(s): ${createParamSummary}`, { nodeId: node.id });
				const createRes = await this.ticketRuntimeService.CREATE_TICKETS(opts as ITicketCreateOptions);
				if (!createRes.success) {
					throw new Error(createRes.error || `Failed to create ticket '${opts.title}'`);
				}
				const { fields: _omitFields, ...lightCreateRes } = createRes;
				result = lightCreateRes;
				pathStep?.operations.push({
					type: 'create_ticket',
					label: `CREATE_TICKETS: '${opts.title}' [${opts.ticketType}]`,
					details: {
						ticketType: opts.ticketType,
						title: opts.title,
						ticketId: createRes.ticketId,
						ticketName: createRes.ticketName,
						targetFolder: createRes.targetFolder,
						parameters: this._summarizeValueForHistory(opts.parameters)
					},
					durationMs: Date.now() - startMs
				});
			} else if (upperFn === 'GET_TICKET' || upperFn === 'GETTICKET') {
				const rawTarget = kwargs.ticket_id ?? kwargs.ticket ?? kwargs.tickets ?? kwargs.ticket_name ?? kwargs.ticketId ?? kwargs.id ?? args[0] ?? '';
				const field = kwargs.field ?? kwargs.key ?? kwargs.name ?? args[1];
				const getRes = await this.ticketRuntimeService.getTicket(workflowDir, rawTarget, field as string | undefined);
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
			} else if (upperFn === 'GET_TICKETS' || upperFn === 'GETTICKETS') {
				const hasQueryFilters = kwargs.ticket_type !== undefined || kwargs.status !== undefined || kwargs.title !== undefined || kwargs.field !== undefined || kwargs.ticketType !== undefined || kwargs.path !== undefined || kwargs.limit !== undefined;
				if (hasQueryFilters) {
					result = await this.ticketRuntimeService.getTickets(workflowDir, kwargs, kwargs.field as string | undefined);
				} else {
					const rawTarget = kwargs.ticket ?? kwargs.tickets ?? kwargs.ticket_name ?? kwargs.ticket_id ?? kwargs.ticketIdOrPath ?? kwargs.id ?? args[0] ?? '';
					const getRes = await this.ticketRuntimeService.getTickets(workflowDir, rawTarget, kwargs.field as string | undefined);
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
				}
			} else if (upperFn === 'GET_OUTPUTS' || upperFn === 'GETOUTPUTS' || upperFn === 'GET_OUTPUT' || upperFn === 'GETOUTPUT') {
				const rawTarget = kwargs.ticket_id ?? kwargs.ticket ?? kwargs.tickets ?? kwargs.ticket_name ?? kwargs.ticketId ?? kwargs.ticketIdOrPath ?? kwargs.id ?? args[0] ?? '';
				const requestedField = kwargs.field ?? kwargs.key ?? kwargs.name ?? kwargs.output ?? args[1];
				const targetField = (requestedField !== undefined && requestedField !== null && String(requestedField).trim() !== '') ? String(requestedField).trim() : undefined;
				const outRes = await this.ticketRuntimeService.GET_OUTPUTS(workflowDir, rawTarget, targetField);
				if (targetField !== undefined) {
					result = outRes;
				} else {
					if (outRes && typeof outRes === 'object' && !Array.isArray(outRes)) {
						try {
							// A ticket target (id / name / handle) resolves to a single ticket; any other result has none of these fields.
							const tRes = await this.ticketRuntimeService.GET_TICKETS(workflowDir, rawTarget) as Partial<ITicketGetResult> | null | undefined;
							const outputField = tRes?.schema?.fields?.find(f => f.type === 'output');
							Object.defineProperty(outRes, '__ticketMetadata', {
								value: {
									ticketId: tRes?.ticketId || (typeof rawTarget === 'string' ? rawTarget : optionalProp(rawTarget, 'ticketId')),
									ticketName: tRes?.ticketName || (typeof rawTarget === 'string' ? rawTarget : optionalProp(rawTarget, 'ticketName')),
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
				let displayVal: unknown;
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

				const { formattedText, summaryType, cleanValue, ticketTitle, ticketId, ticketType, outputItems, ticketHandle, isTruncated, displayPreviewText, totalCount } = this._formatDisplayOutput(displayVal);

				const nodeLabelName = (node.label && node.label.trim()) ? node.label.trim() : (node.id || 'Node');
				const logDisplayPreview = formattedText.length > 500
					? formattedText.substring(0, 500) + ' ... [see Live Display]'
					: formattedText;
				this._emitLog(run, 'info', `[DISPLAY] [${nodeLabelName}] (${summaryType})\n${logDisplayPreview}`, { nodeId: node.id });

				const exprKey = rawExpr || `DISPLAY(${rawArgsStr})`;
				const displayWfUri = (run as IInternalWorkflowRun)._displayWorkflowUri || run.workflowUri;
				const displayRunId = (run as IInternalWorkflowRun)._displayRunId || run.runId;
				let cardList = this._displayCardsByWorkflow.get(displayWfUri);
				if (!cardList) {
					cardList = [];
					this._displayCardsByWorkflow.set(displayWfUri, cardList);
				}
				const existingIdx = cardList.findIndex(c => c.runId === displayRunId && c.nodeId === node.id && c.expression === exprKey);
				const reusedId = existingIdx !== -1 ? cardList.splice(existingIdx, 1)[0].id : `display_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

				const displayCard: IWorkflowDisplayCard = {
					id: reusedId,
					workflowUri: displayWfUri,
					runId: displayRunId,
					nodeId: node.id,
					nodeTitle: nodeLabelName,
					expression: exprKey,
					value: cleanValue,
					formattedText,
					timestamp: new Date().toLocaleTimeString(),
					ticketTitle,
					ticketId,
					ticketType,
					outputItems,
					ticketHandle,
					isTruncated,
					displayPreviewText,
					totalCount
				};

				cardList.unshift(displayCard);
				if (cardList.length > 30) {
					cardList.length = 30;
				}

				this._onDidDisplayVariable.fire(displayCard);
				pathStep?.operations.push({
					type: 'display',
					label: `DISPLAY [${nodeLabelName}]`,
					details: {
						summaryType,
						preview: logDisplayPreview,
						ticketTitle,
						ticketId,
						ticketType
					}
				});
			} else {
				// Fallback evaluation for general expressions (e.g. `positions = out["Position List"]`)
				const exprToEval = rhsGeneralExpr || rawExpr;
				try {
					const evaluator = new PythonExpressionEvaluator(exprToEval, run.contextVariables);
					result = evaluator.evaluate();
				} catch (err) {
					throw new Error(`Unsupported function or expression '${fnName || exprToEval}': ${err.message}`);
				}
			}

			if (targetVar) {
				run.contextVariables[targetVar] = result;
				delete run.contextVariables[`@${targetVar}`];
				const preview = this._fastPreviewString(result, 150);
				this._emitLog(run, 'info', `[Step #${stepIndex + 1} FX] Output stored in @${targetVar}: ${preview}`, { nodeId: node.id });
			} else {
				this._emitLog(run, 'info', `[Step #${stepIndex + 1} FX] Execution completed successfully in ${Date.now() - startMs}ms`, { nodeId: node.id });
			}
		} catch (err) {
			this._emitLog(run, 'error', `[Step #${stepIndex + 1} FX Error] Function call '${fnName}' failed: ${err.message}`, { nodeId: node.id });
			throw err;
		}
	}

	private _parseFunctionArgs(argsStr: string, context: Record<string, unknown>): { args: unknown[]; kwargs: Record<string, unknown> } {
		const trimmed = argsStr.trim();
		if (!trimmed) { return { args: [], kwargs: {} }; }

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
				if (ch === '"' || ch === '\'') {
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

		const args: unknown[] = [];
		const kwargs: Record<string, unknown> = {};

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

	private _evaluateArgument(arg: string, context: Record<string, unknown>): unknown {
		const s = arg.trim();
		if (!s) { return undefined; }

		// Single string literals (including Python f-strings like f"Task {start}")
		const isFStr = (s.startsWith('f"') || s.startsWith('F"') || s.startsWith('f\'') || s.startsWith('F\'')) && s.length >= 3;
		const strCand = isFStr ? s.substring(1) : s;
		if ((strCand.startsWith('"') && strCand.endsWith('"')) || (strCand.startsWith('\'') && strCand.endsWith('\''))) {
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
		if (s === 'true') { return true; }
		if (s === 'false') { return false; }
		if (s === 'null' || s === 'None') { return null; }

		// Direct variable reference (with or without @) or property path
		const cleanRef = s.startsWith('@') ? s.substring(1).trim() : s;

		// Check property path (e.g. new_ticket.outputs, @new_ticket.fields)
		if (cleanRef.includes('.')) {
			const parts = cleanRef.split('.');
			const rootVar = parts[0];
			let val = context[rootVar] !== undefined ? context[rootVar] : context[`@${rootVar}`];
			if (val !== undefined) {
				for (let i = 1; i < parts.length; i++) {
					if (val === undefined || val === null) { break; }
					val = getPyAttr(val, parts[i]);
				}
				if (val !== undefined) { return val; }
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

	private _stripInternalDisplayMeta(val: unknown): unknown {
		if (val === null || val === undefined || typeof val !== 'object') {
			return val;
		}
		if (Array.isArray(val)) {
			return val.map(item => this._stripInternalDisplayMeta(item));
		}
		const cleaned: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(val)) {
			if (k.startsWith('__') || k === 'outputSpecs' || k === 'output_specs') {
				continue;
			}
			cleaned[k] = this._stripInternalDisplayMeta(v);
		}
		return cleaned;
	}

	private _formatDisplayOutput(displayVal: unknown): {
		formattedText: string;
		summaryType: string;
		cleanValue: unknown;
		ticketTitle?: string;
		ticketId?: string;
		ticketType?: string;
		outputItems?: IWorkflowDisplayOutputItem[];
		ticketHandle?: ITicketHandleInfo;
		isTruncated?: boolean;
		displayPreviewText?: string;
		totalCount?: number;
	} {
		if (displayVal === undefined) {
			return { formattedText: 'None', summaryType: 'NoneType', cleanValue: null };
		}
		if (displayVal === null) {
			return { formattedText: 'None', summaryType: 'NoneType', cleanValue: null };
		}

		// 1. Check if displayVal is a newly created Ticket Handle (descriptor from CREATE_TICKETS)
		const handle = isWorkflowRecord(displayVal) && !Array.isArray(displayVal) && displayVal.isHandle === true ? displayVal : undefined;

		if (handle) {
			const ticketId = String(handle.ticketId || '');
			const ticketName = String(handle.ticketName || ticketId);
			const ticketType = String(handle.ticketType || 'ticket');
			const title = String(handle.title || ticketName || ticketId);
			const status = String(handle.status || 'Todo');
			const createdAt = String(handle.createdAt || new Date().toLocaleString());
			const targetFolder = String(handle.targetFolder || '');
			const parameters = (handle.parameters && typeof handle.parameters === 'object') ? handle.parameters as IWorkflowRecord : {};

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
			if (targetFolder) { lines.push(`Path: ${targetFolder}`); }
			if (Object.keys(parameters).length > 0) {
				lines.push(`Inputs: ${JSON.stringify(parameters, null, 2)}`);
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
					const fullFormatted = JSON.stringify(cleanParsed, null, 2);
					const isArray = Array.isArray(cleanParsed);
					let isTruncated = false;
					let displayPreviewText: string | undefined = undefined;
					let totalCount: number | undefined = undefined;

					if (isArray && cleanParsed.length > 50) {
						isTruncated = true;
						totalCount = cleanParsed.length;
						displayPreviewText = JSON.stringify(cleanParsed.slice(0, 50), null, 2);
					} else if (fullFormatted.length > 30000) {
						isTruncated = true;
						totalCount = fullFormatted.length;
						displayPreviewText = fullFormatted.substring(0, 30000);
					}

					return {
						formattedText: fullFormatted,
						summaryType: isArray
							? `json array [${cleanParsed.length}]`
							: (typeof cleanParsed === 'object' && cleanParsed !== null ? `json object {${Object.keys(cleanParsed).length} keys}` : `string (${displayVal.length} chars)`),
						cleanValue: cleanParsed,
						isTruncated,
						displayPreviewText,
						totalCount
					};
				} catch {
					// Not valid JSON, fall through to plain string
				}
			}

			let isTruncated = false;
			let displayPreviewText: string | undefined = undefined;
			let totalCount: number | undefined = undefined;
			if (displayVal.length > 30000) {
				isTruncated = true;
				totalCount = displayVal.length;
				displayPreviewText = displayVal.substring(0, 30000);
			}
			return { formattedText: displayVal, summaryType: `string (${displayVal.length} chars)`, cleanValue: displayVal, isTruncated, displayPreviewText, totalCount };
		}

		if (typeof displayVal === 'number' || typeof displayVal === 'boolean') {
			return { formattedText: String(displayVal), summaryType: typeof displayVal, cleanValue: displayVal };
		}

		// 3. Python Dictionary / JSON Object or List / Array -> always render as a single complete formatted JSON block
		const ticketMeta = optionalProp(displayVal, '__ticketMetadata') as ITicketDisplayMetadata | null | undefined;
		const ticketId = ticketMeta?.ticketId || '';
		const ticketTitle = ticketMeta?.title || ticketMeta?.ticketName || '';
		const ticketType = ticketMeta?.ticketType || '';
		const cleanVal = this._stripInternalDisplayMeta(displayVal);
		const isArray = Array.isArray(cleanVal);
		const totalArrayLen = isArray ? cleanVal.length : 0;
		let rawJsonText = '';
		try {
			rawJsonText = JSON.stringify(cleanVal, null, 2) || '';
		} catch {
			rawJsonText = String(cleanVal);
		}

		let isTruncated = false;
		let displayPreviewText: string | undefined = undefined;
		let totalCount: number | undefined = undefined;

		if (isArray && cleanVal.length > 50) {
			isTruncated = true;
			totalCount = cleanVal.length;
			displayPreviewText = JSON.stringify(cleanVal.slice(0, 50), null, 2);
		} else if (rawJsonText.length > 30000) {
			isTruncated = true;
			totalCount = rawJsonText.length;
			displayPreviewText = rawJsonText.substring(0, 30000);
		}

		return {
			formattedText: rawJsonText,
			summaryType: isArray
				? `array [${totalArrayLen}]`
				: `object {${Object.keys(cleanVal || {}).length} keys}`,
			cleanValue: cleanVal,
			ticketTitle: ticketTitle || undefined,
			ticketId: ticketId || undefined,
			ticketType: ticketType || undefined,
			isTruncated,
			displayPreviewText,
			totalCount
		};
	}

	private _extractPrimitiveCleanValue(rawMeta: unknown, defaultFormat?: string): unknown {
		if (rawMeta === undefined || rawMeta === null) { return undefined; }
		if (typeof rawMeta === 'string') {
			const trimmed = rawMeta.trim();
			if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
				try {
					const parsed = JSON.parse(trimmed);
					// Data Table primitive
					if (Array.isArray(parsed.rows) || hasWorkflowProperty(parsed, 'sqlOutput') || (hasWorkflowProperty(parsed, 'columns') && hasWorkflowProperty(parsed, 'dbEngine'))) {
						if (Array.isArray(parsed.rows) && (parsed.rows.length > 0 || !/^Status:\s*FAILED\b/i.test(String(parsed.sqlOutput || '').trim()))) {
							return parsed.rows;
						}
						return parsed.sqlOutput || parsed.rows || [];
					}
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
					// HTTP Request / SSH primitives (ticket value uses the template config names; old short names are migrated)
					if (isHttpTicketValue(parsed)) {
						const httpVal = normalizeHttpTicketValue(parsed) ?? {};
						return httpVal.httpResponseData ?? httpVal.httpResponseBody ?? '';
					}
					if (isSshTicketValue(parsed)) {
						return sshTicketValueOutputText(parsed) || '{}';
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
			if (!run.linkStates) { run.linkStates = {}; }

			for (const link of outgoingLinks) {
				const linkKey = link.id || `${link.from}->${link.to}`;
				const rawLabel = (link.label || '').trim();
				if (!rawLabel) { continue; }

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
						condResult = Boolean(ns && (ns.status === 'failed' || optionalProp(ns.output, 'approved') === false || optionalProp(ns.output, 'action') === 'rejected'));
					} else if (this._pythonKernels.has(run.runId)) {
						const pyRes = await this._executeInPythonKernel(run, currentNode, -1, run.nodeStates[currentNode.id], pathStep, rawLabel, 'eval');
						condResult = Boolean(pyRes);
					} else {
						condResult = this._evaluateCondition(rawLabel, run.contextVariables, run.nodeStates[currentNode.id], run);
					}
				} catch (err) {
					conditionError = err.message || String(err);
					if (!firstConditionError) { firstConditionError = conditionError; }
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
					if (link.id) { run.linkStates[`${link.from}->${link.to}`] = run.linkStates[linkKey]; }
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
					if (link.id) { run.linkStates[`${link.from}->${link.to}`] = run.linkStates[linkKey]; }

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
					if (link.id) { run.linkStates[`${link.from}->${link.to}`] = run.linkStates[linkKey]; }
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
					if (l.id) { run.linkStates[`${l.from}->${l.to}`] = run.linkStates[key]; }
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
			if (!run.linkStates) { run.linkStates = {}; }
			const lKey = outgoingLinks[0].id || `${outgoingLinks[0].from}->${outgoingLinks[0].to}`;
			run.linkStates[lKey] = {
				linkId: outgoingLinks[0].id,
				fromNodeId: outgoingLinks[0].from,
				toNodeId: outgoingLinks[0].to,
				status: 'passed',
				evaluationResult: true
			};
			if (outgoingLinks[0].id) { run.linkStates[`${outgoingLinks[0].from}->${outgoingLinks[0].to}`] = run.linkStates[lKey]; }
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

	private _explainCondition(expr: string, context: Record<string, unknown>, result: boolean): string {
		const varMatches = expr.match(/@?[a-zA-Z0-9_]+/g);
		const varVals: Record<string, unknown> = {};
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
		context: Record<string, unknown>,
		nodeState?: IWorkflowNodeExecutionState,
		run?: IWorkflowExecutionRun
	): boolean | null {
		const raw = expr.trim();
		if (!raw) { return null; }

		// 1. Check standard boolean and status keywords
		const lower = raw.toLowerCase();
		const positiveKeywords = new Set(['true', 'yes', 'success', 'pass', 'continue', 'ok', 'always']);
		if (positiveKeywords.has(lower)) {
			return true;
		}
		const negativeKeywords = new Set(['false', 'no', 'fail', 'reject']);
		if (negativeKeywords.has(lower)) {
			if (nodeState && (nodeState.status === 'failed' || optionalProp(nodeState.output, 'approved') === false || optionalProp(nodeState.output, 'action') === 'rejected')) {
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
		} catch (err) {
			if (run) {
				this._emitLog(run, 'error', `[Condition Syntax Error] Failed to evaluate condition '${raw}': ${err.message}`);
			}
			throw err;
		}

		return null;
	}

	private _evaluateExpressionOrLiteral(expr: string, context: Record<string, unknown>): unknown {
		const evaluator = new PythonExpressionEvaluator(expr, context);
		return evaluator.evaluate();
	}

	private _resolveValue(token: string, context: Record<string, unknown>): unknown {
		try {
			const trimmed = (token || '').trim();
			if (!trimmed || trimmed === 'None' || trimmed === 'null') { return undefined; }
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

	private _getNodeVars(node: IFlowchartNode): { name: string; initialValue?: string; expression?: string; currentValue?: unknown }[] {
		const rawVars: { name: string; initialValue?: string; expression?: string; currentValue?: unknown }[] = [];
		if (Array.isArray(node.outputVariables) && node.outputVariables.length > 0) {
			rawVars.push(...node.outputVariables);
		} else if (node.outputVariable && node.outputVariable.name) {
			rawVars.push(node.outputVariable);
		}

		// Deduplicate by name, preserving valid initialValue and expression
		const map = new Map<string, { name: string; initialValue?: string; expression?: string; currentValue?: unknown }>();
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

	public resolveWorkflowIOContract(data: IFlowchartData): IWorkflowIOContract {
		const errors: string[] = [];
		const inputs: IWorkflowInputParamDef[] = [];
		const outputs: IWorkflowOutputDef[] = [];

		if (!data || !Array.isArray(data.nodes) || data.nodes.length === 0) {
			const msg = 'Workflow has no nodes; cannot determine unique Input or Output node.';
			return {
				isValid: false,
				inputError: msg,
				outputError: msg,
				inputs,
				outputs,
				errors: [msg]
			};
		}

		const nodes = data.nodes;
		const links = Array.isArray(data.links) ? data.links : [];
		const nodeById = new Map<string, IFlowchartNode>();
		for (const n of nodes) {
			nodeById.set(n.id, n);
		}

		const isPureStartCircle = (n: IFlowchartNode): boolean => {
			const hasParamComp = (n.pipeline || []).some(s => s?.component?.type === 'parameters');
			return !hasParamComp && n.type === 'circle' && /^\s*(start|begin|entry)\s*$/i.test(n.label || '');
		};
		const isPureEndCircle = (n: IFlowchartNode): boolean => {
			const hasOutputComp = (n.pipeline || []).some(s => {
				const t = s?.component?.type;
				return t === 'output';
			});
			return !hasOutputComp && this._isEndNode(n);
		};

		// 1. Resolve Unique Input Node (first execution node of the workflow)
		let inputNode: IFlowchartNode | undefined;
		let inputError: string | undefined;

		const incomingTargetIds = new Set(links.map(l => l.to));
		const rootCandidates = nodes.filter(n => !incomingTargetIds.has(n.id) && n.type !== 'diamond' && !this._isEndNode(n));

		let rootNode: IFlowchartNode | undefined;
		if (rootCandidates.length === 1) {
			rootNode = rootCandidates[0];
		} else if (rootCandidates.length > 1) {
			const explicitStarts = rootCandidates.filter(isPureStartCircle);
			if (explicitStarts.length === 1) {
				rootNode = explicitStarts[0];
			} else {
				const names = rootCandidates.map(n => `'${n.label || n.id}'`).join(', ');
				inputError = `Ambiguous Workflow Input node: found ${rootCandidates.length} entry nodes (${names}). Ensure there is a single unique starting node.`;
				errors.push(inputError);
			}
		} else {
			inputError = 'Cannot uniquely determine Workflow Input node (no root entry node with 0 incoming links found).';
			errors.push(inputError);
		}

		if (rootNode && !inputError) {
			if (isPureStartCircle(rootNode)) {
				const firstTargets = Array.from(new Set(
					links.filter(l => l.from === rootNode!.id).map(l => l.to)
				))
					.map(id => nodeById.get(id))
					.filter((n): n is IFlowchartNode => !!n && !isPureEndCircle(n));

				if (firstTargets.length === 1) {
					inputNode = firstTargets[0];
				} else if (firstTargets.length > 1) {
					const withInputs = firstTargets.filter(n => (n.pipeline || []).some(s => s?.component?.type === 'parameters'));
					if (withInputs.length === 1) {
						inputNode = withInputs[0];
					} else {
						const names = firstTargets.map(n => `'${n.label || n.id}'`).join(', ');
						inputError = `Ambiguous Workflow Input node: Start node branches into ${firstTargets.length} nodes (${names}).`;
						errors.push(inputError);
					}
				} else {
					inputNode = rootNode;
				}
			} else {
				inputNode = rootNode;
			}
		}

		// Accumulate ALL parameters from ALL Inputs ('parameters') components inside the unique Input Node in order
		if (inputNode) {
			for (const step of (inputNode.pipeline || [])) {
				const comp = step?.component;
				if (comp && comp.type === 'parameters' && Array.isArray(comp.parameters)) {
					for (const p of comp.parameters) {
						const pName = (p?.name || '').trim();
						if (!pName) {
							continue;
						}
						inputs.push({
							name: pName,
							label: (p?.label || pName).trim(),
							defaultValue: p?.defaultValue !== undefined && p?.defaultValue !== null ? String(p.defaultValue) : '',
							options: Array.isArray(p?.options) ? [...p.options] : undefined,
							description: p?.description || undefined,
							componentId: comp.id || step.id,
							componentLabel: comp.label || 'Inputs'
						});
					}
				}
			}
		}

		// 2. Resolve Unique Output Node (last executable node of the workflow; anything placed AFTER End is ignored)
		let outputNode: IFlowchartNode | undefined;
		let outputError: string | undefined;

		// Compute reachable executable subgraph starting from root(s), strictly stopping at End nodes
		const executableNodeIds = new Set<string>();
		const bfsQueue: string[] = rootNode ? [rootNode.id] : rootCandidates.map(n => n.id);
		for (const seedId of bfsQueue) {
			executableNodeIds.add(seedId);
		}
		while (bfsQueue.length > 0) {
			const currId = bfsQueue.shift()!;
			const currNode = nodeById.get(currId);
			if (!currNode || this._isEndNode(currNode)) {
				// Stop traversal at End node — nodes placed after End are never executed
				continue;
			}
			for (const l of links) {
				if (l.from === currId && !executableNodeIds.has(l.to)) {
					executableNodeIds.add(l.to);
					bfsQueue.push(l.to);
				}
			}
		}

		const activeNodes = executableNodeIds.size > 0
			? nodes.filter(n => executableNodeIds.has(n.id))
			: nodes;
		const activeOutgoingSourceIds = new Set(
			links.filter(l => executableNodeIds.has(l.from) && executableNodeIds.has(l.to)).map(l => l.from)
		);
		const terminalSet = new Map<string, IFlowchartNode>();
		for (const n of activeNodes) {
			if (isPureEndCircle(n)) {
				// Trace executable predecessors of End circle as terminal execution nodes
				for (const l of links) {
					if (l.to === n.id && executableNodeIds.has(l.from)) {
						const pred = nodeById.get(l.from);
						if (pred && !isPureStartCircle(pred) && !isPureEndCircle(pred)) {
							terminalSet.set(pred.id, pred);
						}
					}
				}
			} else if (!activeOutgoingSourceIds.has(n.id) && n.type !== 'diamond' && !isPureStartCircle(n)) {
				terminalSet.set(n.id, n);
			}
		}
		const pureEndNodes = activeNodes.filter(isPureEndCircle);
		const terminalNodes = Array.from(terminalSet.values());
		const nodesWithOutputComp = activeNodes.filter(n => !isPureEndCircle(n) && (n.pipeline || []).some(s => {
			const t = s?.component?.type;
			return t === 'output';
		}));

		if (terminalNodes.length === 1) {
			outputNode = terminalNodes[0];
		} else if (terminalNodes.length > 1) {
			const terminalsWithOutput = terminalNodes.filter(n => (n.pipeline || []).some(s => {
				const t = s?.component?.type;
				return t === 'output';
			}));
			if (terminalsWithOutput.length === 1) {
				outputNode = terminalsWithOutput[0];
			} else if (nodesWithOutputComp.length === 1) {
				outputNode = nodesWithOutputComp[0];
			} else if (nodesWithOutputComp.length === 0) {
				// Void workflow/sub-workflow (no Output components): multiple branches converging on End is completely valid
				outputNode = pureEndNodes.length === 1 ? pureEndNodes[0] : undefined;
			} else {
				const names = (terminalsWithOutput.length > 1 ? terminalsWithOutput : nodesWithOutputComp)
					.map(n => `'${n.label || n.id}'`)
					.join(', ');
				outputError = `Ambiguous Workflow Output node: found ${nodesWithOutputComp.length} output nodes (${names}). Ensure there is a single unique final Output node.`;
				errors.push(outputError);
			}
		} else {
			if (nodesWithOutputComp.length === 1) {
				outputNode = nodesWithOutputComp[0];
			} else if (nodesWithOutputComp.length > 1) {
				const names = nodesWithOutputComp.map(n => `'${n.label || n.id}'`).join(', ');
				outputError = `Ambiguous Workflow Output node: found ${nodesWithOutputComp.length} nodes with Output components (${names}).`;
				errors.push(outputError);
			} else if (pureEndNodes.length === 1) {
				outputNode = pureEndNodes[0];
			}
		}

		// Accumulate ALL enabled output specs from ALL Output ('output') components inside the unique Output Node in order
		if (outputNode) {
			for (const step of (outputNode.pipeline || [])) {
				const comp = step?.component;
				if (comp && (comp.type === 'output') && Array.isArray(comp.outputSpecs)) {
					for (const spec of comp.outputSpecs) {
						if (!spec || spec.enabled === false) {
							continue;
						}
						const label = (spec.label || spec.varName || spec.fieldKey || '').trim();
						if (!label) {
							continue;
						}
						const varName = (spec.varName || '').trim() || generateSmartPythonVarName(label);
						outputs.push({
							label,
							fieldKey: spec.fieldKey || label,
							varName,
							defaultFormat: spec.defaultFormat || (spec.isCustom ? 'json' : 'table'),
							sourceExpression: spec.sourceExpression || undefined,
							isCustom: Boolean(spec.isCustom),
							componentId: comp.id || step.id,
							componentLabel: comp.label || 'Output'
						});
					}
				}
			}
		}

		return {
			isValid: errors.length === 0,
			inputNodeId: inputNode?.id,
			inputNodeLabel: inputNode?.label || inputNode?.id,
			inputError,
			inputs,
			outputNodeId: outputNode?.id,
			outputNodeLabel: outputNode?.label || outputNode?.id,
			outputError,
			outputs,
			errors
		};
	}

	public async getWorkflowIOContract(workflowUri: URI | string): Promise<IWorkflowIOContract> {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		const data = await this._loadFlowchartData(uriStr);
		if (!data) {
			const msg = `Unable to load workflow data for '${uriStr}'.`;
			return {
				isValid: false,
				inputError: msg,
				outputError: msg,
				inputs: [],
				outputs: [],
				errors: [msg]
			};
		}
		return this.resolveWorkflowIOContract(data);
	}

	private _findEntryNode(data: IFlowchartData, entryNodeId?: string): IFlowchartNode | undefined {
		if (entryNodeId) {
			const node = data.nodes.find(n => n.id === entryNodeId);
			if (node) { return node; }
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
				.filter(n => typeof n._lastClickTime === 'number' && n._lastClickTime > 0)
				.sort((a, b) => (b._lastClickTime || 0) - (a._lastClickTime || 0));
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
		if (startCircle) { return startCircle; }

		return data.nodes[0];
	}

	private _isEndNode(node: IFlowchartNode): boolean {
		const label = (node.label || '').trim().toLowerCase();
		return (node.type === 'circle' && (label === 'end' || label === 'stop' || label === 'exit' || label === 'finish')) ||
			label === 'end' || label === 'stop' || label === 'finish' || label === 'exit' || label === 'quit';
	}

	private async _loadFlowchartData(uriStr: string, options?: IWorkflowEngineOptions): Promise<IFlowchartData | undefined> {
		const data = await this._loadFlowchartDataRaw(uriStr, options);
		// Migrate renamed component types (e.g. legacy 'result' -> 'output') so the engine only sees current ids
		return data ? normalizeLegacyFieldTypes(data) : data;
	}

	private async _loadFlowchartDataRaw(uriStr: string, options?: IWorkflowEngineOptions): Promise<IFlowchartData | undefined> {
		// 1. Direct in-memory data passed from options (e.g. from active editor canvas)
		const initialData = initialFlowchartData(options);
		if (initialData && Array.isArray(initialData.nodes) && initialData.nodes.length > 0) {
			return initialData as IFlowchartData;
		}

		// 2. Load directly from authoritative .agents/workflow_flowchart.json (or direct .json/.workflow file) on disk
		try {
			const uri = URI.parse(uriStr);
			const isDirectFile = uri.path.endsWith('.json') || uri.path.endsWith('.workflow');
			const candidateUris: URI[] = isDirectFile
				? [uri]
				: [URI.joinPath(uri, '.agents', 'workflow_flowchart.json'), getSubWorkflowDefinitionUri(uri)];
			for (const candidateUri of candidateUris) {
				if (await this.fileService.exists(candidateUri)) {
					const fileContent = await this.fileService.readFile(candidateUri);
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
			}
		} catch (e) {
			this.logService.error('[WorkflowExecution] Failed to load flowchart from file:', e);
		}

		// 3. Fallback: Load from Entity Persistence Snapshot
		const snapshot = this.entityPersistenceService.getSnapshot(uriStr);
		if (snapshot?.customMetadata?.['flowchartJson']) {
			try {
				const parsed = JSON.parse(snapshot.customMetadata['flowchartJson']);
				if (Array.isArray(parsed.nodes)) { return parsed; }
			} catch (e) {
				this.logService.error('[WorkflowExecution] Failed to parse flowchartJson from snapshot:', e);
			}
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

	private _emitLog(run: IWorkflowExecutionRun, level: IWorkflowLogEntry['level'], message: string, data?: unknown): void {
		const safeMessage = typeof message === 'string' && message.length > 1200
			? message.substring(0, 1200) + ' ... [truncated]'
			: message;
		const dataRecord = isWorkflowRecord(data) ? data : undefined;
		const safeData = dataRecord
			? (Object.keys(dataRecord).length <= 2 && (Reflect.has(dataRecord, 'nodeId') || Reflect.has(dataRecord, 'ticketId')) ? { nodeId: dataRecord.nodeId, ticketId: dataRecord.ticketId } : this._summarizeValueForHistory(dataRecord, 1))
			: data;
		const log: IWorkflowLogEntry = {
			id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
			timestamp: Date.now(),
			level,
			nodeId: (dataRecord?.nodeId || run.currentNodeId) as string | undefined,
			ticketId: dataRecord?.ticketId as string | undefined,
			message: safeMessage,
			data: safeData
		};
		run.logs.push(log);
		if (run.logs.length > 1500) {
			run.logs.splice(0, run.logs.length - 1500);
		}
		run.updatedAt = Date.now();
		this._onDidEmitLog.fire({ runId: run.runId, log });
	}

	/**
	 * A Button Group gate waiting inside a run shows as the existing human-in-the-loop state: the run and the node are
	 * `waiting_human` and the node's prompt lists the gate's buttons (CI-25). When the decision is made (or cancelled)
	 * the run and node return to `running`.
	 */
	private _syncHumanDecisionStates(): void {
		for (const run of this._runs.values()) {
			if (run.status !== 'running' && run.status !== 'waiting_human' && run.status !== 'paused') {
				continue;
			}
			const pending = this.humanDecisionService.findForWorkflowRun(run.runId);
			let changed = false;
			for (const state of Object.values(run.nodeStates || {})) {
				if (!state) {
					continue;
				}
				const isGateNode = !!pending && state.nodeId === pending.workflowNodeId;
				if (isGateNode && pending && state.waitingHumanPrompt?.decisionId !== pending.id) {
					state.status = 'waiting_human';
					state.waitingHumanPrompt = {
						nodeId: state.nodeId,
						prompt: pending.prompt,
						options: pending.buttons.map(b => b.label),
						decisionId: pending.id,
						ticketId: pending.ticketId,
						ticketUri: pending.ticketUri
					};
					run.status = 'waiting_human';
					changed = true;
					this._emitLog(run, 'warn', `[Human Decision] ${pending.prompt}`, { nodeId: state.nodeId });
				} else if (!isGateNode && state.waitingHumanPrompt?.decisionId) {
					state.waitingHumanPrompt = undefined;
					if (state.status === 'waiting_human') {
						state.status = 'running';
					}
					if (run.status === 'waiting_human' && !this._humanWaiters.has(run.runId)) {
						run.status = 'running';
					}
					changed = true;
				}
			}
			if (changed) {
				run.updatedAt = Date.now();
				this._notifyRunChanged(run);
			}
		}
	}

	private _notifyRunChanged(run: IWorkflowExecutionRun): void {
		run.updatedAt = Date.now();
		if (run.isSubWorkflowRun) {
			// Sub-Workflow runs are not persisted as top-level runs, but live views follow their progress
			this._onDidChangeSubWorkflowRun.fire(run);
			return;
		}
		this._onDidChangeRunState.fire(run);
		this._schedulePersist(run.workflowUri);
	}

	private readonly _nodeComponentPersistDebounceMap = new Map<string, ReturnType<typeof setTimeout>>();

	/** The canvas showing a run's nodes: the workflow itself, or the Sub-Workflow ticket folder for a Sub-Workflow run. */
	private _canvasUriOf(run: IWorkflowExecutionRun): string {
		return (run as IInternalWorkflowRun)._canvasUri || run.workflowUri;
	}

	private async _persistAndNotifyNodeComponents(run: IWorkflowExecutionRun, node: IFlowchartNode): Promise<void> {
		const canvasUri = this._canvasUriOf(run);
		this._onDidUpdateNodeComponents.fire({
			workflowUri: canvasUri,
			nodeId: node.id,
			node
		});
		if (canvasUri !== run.workflowUri) {
			// A Sub-Workflow run: an open canvas of the ticket merges the telemetry itself; its definition file is never
			// rewritten from here (and the parent workflow's file is never touched)
			return;
		}

		// If an open Workflow Editor owns this workflow's flowchart file, it merges runtime telemetry from the event above
		// and saves the file itself. Never write the file from here, otherwise a read-modify-write race can revert the
		// user's latest saved edits (e.g. Output variable names) with stale on-disk content.
		if ((this._flowchartOwnerCounts.get(run.workflowUri) || 0) > 0) {
			return;
		}

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
						const targetNode = parsed.nodes.find((n: IFlowchartNode | null) => n && n.id === node.id);
						if (targetNode && Array.isArray(targetNode.pipeline) && Array.isArray(node.pipeline)) {
							for (const srcStep of node.pipeline) {
								const srcComp = srcStep.component;
								if (!srcComp) { continue; }
								const dstStep = targetNode.pipeline.find((s: INodePipelineStep | null) =>
									(s && s.id && s.id === srcStep.id) ||
									(s && s.component && s.component.id && s.component.id === srcComp.id)
								);
								if (dstStep && dstStep.component) {
									// Merge ONLY runtime execution telemetry into the on-disk component —
									// NEVER overwrite user-edited configuration (outputSpecs, parameters, wfDisplayValue, pythonCode, etc.)!
									const persistedLog = typeof srcComp.lastExecutionLog === 'string' && srcComp.lastExecutionLog.length > 50000
										? srcComp.lastExecutionLog.substring(0, 50000)
										: srcComp.lastExecutionLog;
									const runtimeOnlyKeys = [
										'lastExecutionStatus', 'lastExecutionDurationMs', 'lastExecutedAt',
										'lastExecutionOutput', 'lastExecutionInputs',
										'pythonResult', 'pythonOutput', 'lastResolvedUrl', 'lastExecutedUrl',
										'httpResponseStatus', 'httpResponseStatusText', 'httpResponseHeaders',
										'httpResponseBody', 'httpResponseData', 'httpLastExecutionTime', 'httpLastDurationMs',
										'tableLastExecutionTime', 'tableLastDurationMs', 'tableLastSqlOutput'
									];
									for (const rk of runtimeOnlyKeys) {
										if (Reflect.get(srcComp, rk) !== undefined) {
											Reflect.set(dstStep.component, rk, Reflect.get(srcComp, rk));
										}
									}
									if (persistedLog !== undefined) {
										dstStep.component.lastExecutionLog = persistedLog;
									}
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
			const initVars: Record<string, unknown> = {};
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
FULL_SPEED = "--full-speed" in sys.argv
POLL_SLEEP = 0.002 if FULL_SPEED else 0.025
CMD_SLEEP = 0.002 if FULL_SPEED else 0.03
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

_orig_json_loads = json.loads
def _safe_json_loads(s, *args, **kwargs):
    if isinstance(s, (dict, list)):
        return s
    return _orig_json_loads(s, *args, **kwargs)
json.loads = _safe_json_loads

def _wrap_val(v):
    if isinstance(v, str):
        s = v.strip()
        if (s.startswith("{") and s.endswith("}")) or (s.startswith("[") and s.endswith("]")):
            try:
                parsed = _orig_json_loads(s)
                if isinstance(parsed, (dict, list)):
                    return _wrap_val(parsed)
            except Exception:
                pass
        return v
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
    active_cmd_id = getattr(_tls, "current_cmd_id", current_cmd_id)
    payload = {"id": req_id, "cmd_id": active_cmd_id, "fn": fn_name, "args": resolved_args, "kwargs": resolved_kwargs, "call_expr": call_expr}
    req_file = os.path.join(KERNEL_DIR, f"rpc_req_{req_id}.json")
    res_file = os.path.join(KERNEL_DIR, f"rpc_res_{req_id}.json")
    try:
        if os.path.exists(res_file):
            os.remove(res_file)
    except OSError:
        pass
    tmp_req = req_file + ".tmp"
    with open(tmp_req, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, default=str)
    os.replace(tmp_req, req_file)

    while True:
        last_active_ts = time.time()
        if not os.path.exists(KERNEL_DIR):
            sys.exit(0)
        if os.path.exists(res_file):
            try:
                with open(res_file, "r", encoding="utf-8") as f:
                    res = json.load(f)
                if res.get("id") == req_id:
                    last_active_ts = time.time()
                    try:
                        os.remove(res_file)
                    except OSError:
                        pass
                    if res.get("error"):
                        raise RuntimeError(res["error"])
                    return _wrap_val(res.get("result"))
            except (json.JSONDecodeError, OSError):
                pass
        time.sleep(POLL_SLEEP)

def RUN_TICKETS(*args, **kwargs):
    return _rpc_call("RUN_TICKETS", args, kwargs)

def CREATE_TICKETS(*args, **kwargs):
    return _rpc_call("CREATE_TICKETS", args, kwargs)

def GET_TICKET(*args, **kwargs):
    return _rpc_call("GET_TICKET", args, kwargs)

get_ticket = GET_TICKET

def GET_TICKETS(*args, **kwargs):
    return _rpc_call("GET_TICKETS", args, kwargs)

get_tickets = GET_TICKETS

def GET_OUTPUTS(*args, **kwargs):
    return _rpc_call("GET_OUTPUTS", args, kwargs)

def GET_PRIMITIVES_CATALOG(*args, **kwargs):
    return _rpc_call("GET_PRIMITIVES_CATALOG", args, kwargs)

def DISPLAY(*args, **kwargs):
    _rpc_call("DISPLAY", args, kwargs)
    if len(args) == 1:
        return args[0]
    elif len(args) > 1:
        return list(args)
    return kwargs

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
    "GET_TICKET": GET_TICKET,
    "get_ticket": GET_TICKET,
    "GET_OUTPUTS": GET_OUTPUTS,
    "get_outputs": GET_OUTPUTS,
    "GET_PRIMITIVES_CATALOG": GET_PRIMITIVES_CATALOG,
    "get_primitives_catalog": GET_PRIMITIVES_CATALOG,
    "DISPLAY": DISPLAY,
    "display": DISPLAY,
    "title": "",
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

_exported_var_snapshots = {}

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
                try:
                    _exported_var_snapshots[k] = json.dumps(v, ensure_ascii=False, default=str)
                except Exception:
                    pass
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
        r"\b(GET_OUTPUTS|get_outputs)\s*\(\s*((?:ticket_id|ticket|tickets|ticket_name)\s*=\s*[^,)=]+?)\s*,\s*(?!\s*[a-zA-Z_][a-zA-Z0-9_]*\s*=)([^)=]+)\)",
        r"\1(\2, field=\3)",
        res
    )
    # Normalize RUN_TICKETS(ticket=..., {...}) -> RUN_TICKETS(ticket=..., params={...})
    res = re.sub(
        r"\b(RUN_TICKETS|run_tickets)\s*\(\s*((?:ticket_id|ticket|tickets|ticket_name)\s*=\s*[^,)=]+?)\s*,\s*(?!\s*[a-zA-Z_][a-zA-Z0-9_]*\s*=)(\{[\s\S]*?\})\s*\)",
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
            s = json.dumps(v, ensure_ascii=False, default=str)
            if _exported_var_snapshots.get(k) != s:
                _exported_var_snapshots[k] = s
                exported[k] = v
        except Exception:
            r = repr(v)
            if _exported_var_snapshots.get(k) != r:
                _exported_var_snapshots[k] = r
                exported[k] = r
    return exported

with open(READY_FILE, "w", encoding="utf-8") as f:
    f.write("ready")

last_cmd_id = None
INITIAL_PPID = os.getppid()
last_active_ts = time.time()

import concurrent.futures, threading

executor = concurrent.futures.ThreadPoolExecutor(max_workers=32)
running_cmds = set()
completed_cmds = set()
running_cmds_lock = threading.Lock()

class _ThreadLocalStdout(object):
    def __init__(self, original):
        self._orig = original
        self._local = threading.local()
    def set_buffer(self, buf):
        self._local.buf = buf
    def get_buffer(self):
        return getattr(self._local, "buf", None)
    def write(self, s):
        buf = self.get_buffer()
        if buf is not None:
            buf.write(s)
        else:
            self._orig.write(s)
    def flush(self):
        buf = self.get_buffer()
        if buf is not None:
            buf.flush()
        else:
            self._orig.flush()

_tls = threading.local()
_orig_stdout = sys.stdout
_tls_stdout = _ThreadLocalStdout(_orig_stdout)
sys.stdout = _tls_stdout

def _run_single_command(cmd_path, cmd_res_path, cmd):
    global last_active_ts
    cmd_id = cmd.get("id")
    _tls.current_cmd_id = cmd_id
    last_active_ts = time.time()
    action = cmd.get("action", "exec")
    code = cmd.get("code", "")
    sync_vars = cmd.get("sync_vars")
    if isinstance(sync_vars, dict):
        for sk, sv in sync_vars.items():
            if sk in ("TICKET_CONTEXT", "CONTEXT", "ANY_AGENT_CONTEXT") or sk.startswith("@"):
                continue
            wf_globals[sk] = _wrap_val(sv)
            try:
                _exported_var_snapshots[sk] = json.dumps(sv, ensure_ascii=False, default=str)
            except Exception:
                pass
    wf_globals["TICKET_CONTEXT"] = wf_globals
    wf_globals["CONTEXT"] = wf_globals
    wf_globals["ANY_AGENT_CONTEXT"] = wf_globals

    sanitized = _sanitize_legacy_syntax(code)
    stdout_buf = io.StringIO()
    _tls_stdout.set_buffer(stdout_buf)
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
        _tls_stdout.set_buffer(None)
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
        "variables": _export_vars()
    }
    if err_msg:
        res_payload["error"] = err_msg

    tmp_res = cmd_res_path + ".tmp"
    with open(tmp_res, "w", encoding="utf-8") as f:
        json.dump(res_payload, f, ensure_ascii=False, default=str)
    os.replace(tmp_res, cmd_res_path)
    with running_cmds_lock:
        running_cmds.discard(cmd_id)
        completed_cmds.add(cmd_id)
        if len(completed_cmds) > 2000:
            completed_cmds.clear()

try:
    while True:
        if not os.path.exists(KERNEL_DIR):
            break
        if os.getppid() != INITIAL_PPID or os.getppid() <= 1:
            break
        if time.time() - last_active_ts > 604800:
            break

        dispatched = False
        try:
            entries = os.listdir(KERNEL_DIR)
        except OSError:
            break

        for fname in entries:
            if fname.startswith("cmd_") and fname.endswith(".json") and not fname.startswith("cmd_res_") and not fname.endswith(".tmp"):
                cmd_path = os.path.join(KERNEL_DIR, fname)
                try:
                    with open(cmd_path, "r", encoding="utf-8") as f:
                        cmd = json.load(f)
                    cmd_id = cmd.get("id")
                    if not cmd_id:
                        continue
                    if cmd.get("action") == "shutdown":
                        sys.exit(0)
                    with running_cmds_lock:
                        if cmd_id in running_cmds or cmd_id in completed_cmds:
                            continue
                        running_cmds.add(cmd_id)
                    cmd_res_path = os.path.join(KERNEL_DIR, f"cmd_res_{cmd_id}.json")
                    executor.submit(_run_single_command, cmd_path, cmd_res_path, cmd)
                    dispatched = True
                except (json.JSONDecodeError, OSError):
                    pass

        # Also support legacy single cmd.json
        if os.path.exists(CMD_FILE):
            try:
                with open(CMD_FILE, "r", encoding="utf-8") as f:
                    cmd = json.load(f)
                cmd_id = cmd.get("id")
                if cmd_id and cmd_id != last_cmd_id:
                    last_cmd_id = cmd_id
                    if cmd.get("action") == "shutdown":
                        break
                    with running_cmds_lock:
                        if cmd_id not in running_cmds:
                            running_cmds.add(cmd_id)
                            executor.submit(_run_single_command, CMD_FILE, CMD_RES_FILE, cmd)
                            dispatched = True
            except (json.JSONDecodeError, OSError):
                pass

        time.sleep(POLL_SLEEP if dispatched else CMD_SLEEP)
finally:
    try:
        executor.shutdown(wait=False)
    except Exception:
        pass
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

			const cmdLine = `"${pythonPath}" "${kernelPyUri.fsPath}" "${kernelDir.fsPath}"${run.fullSpeed ? ' "--full-speed"' : ''}`;
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
				await new Promise(r => setTimeout(r, run.fullSpeed ? 10 : 60));
			}

			if (isReady) {
				const prevKernel = this._pythonKernels.get(run.runId);
				const initialSyncedVars = new Map<string, unknown>();
				for (const [ik, iv] of Object.entries(initVars)) {
					initialSyncedVars.set(ik, iv);
				}
				this._pythonKernels.set(run.runId, {
					kernelDir,
					pythonPath,
					terminal,
					reqCounter: prevKernel ? prevKernel.reqCounter : 0,
					stopped: false,
					handledRpcIds: prevKernel ? prevKernel.handledRpcIds : new Set<string>(),
					lastSyncedVars: initialSyncedVars
				});
				this._emitLog(run, 'info', `[Python Kernel] Started persistent Python runtime (${pythonPath})`);
			} else {
				try { terminal.dispose(); } catch { }
				this._emitLog(run, 'warn', `[Python Kernel] Timed out waiting for Python interpreter (${pythonPath}), falling back to built-in evaluator.`);
			}
		} catch (err) {
			this.logService.warn('[WorkflowExecution] Failed to start Python kernel:', err);
		}
	}

	private async _shutdownPythonKernel(runId: string): Promise<void> {
		const kernel = this._pythonKernels.get(runId);
		if (!kernel) { return; }
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
	): Promise<unknown> {
		let kernel = this._pythonKernels.get(run.runId);
		if (!kernel || kernel.stopped) {
			throw new Error('Python kernel is not running');
		}

		const trimmedCode = (code || '').trim();
		if (!trimmedCode) { return undefined; }

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
			const singleLinePreview = trimmedCode.replace(/\r?\n/g, ' \u21B5 ');
			this._emitLog(run, 'info', `[Step #${stepIndex + 1} PY] Executing Python: ${singleLinePreview}`, { nodeId: node.id });
		}

		kernel.reqCounter++;
		const cmdId = `cmd_${kernel.reqCounter}_${Date.now()}`;
		const cmdUri = URI.joinPath(kernel.kernelDir, `cmd_${cmdId}.json`);
		const cmdResUri = URI.joinPath(kernel.kernelDir, `cmd_res_${cmdId}.json`);
		const legacyRpcReqUri = URI.joinPath(kernel.kernelDir, 'rpc_req.json');
		const legacyRpcResUri = URI.joinPath(kernel.kernelDir, 'rpc_res.json');

		// Sync ONLY externally updated contextVariables (delta-sync) so we do not re-serialize multi-megabyte unchanged variables on every Python step.
		const syncVars: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(run.contextVariables || {})) {
			if (!k.startsWith('@') && !WorkflowExecutionService.RESERVED_CONTEXT_ALIAS_KEYS.has(k)) {
				if (!kernel.lastSyncedVars.has(k) || kernel.lastSyncedVars.get(k) !== v) {
					syncVars[k] = v;
					kernel.lastSyncedVars.set(k, v);
				}
			}
		}

		// Clean up any stale response file with this specific cmdId before dispatching
		try {
			if (await this.fileService.exists(cmdResUri)) {
				await this.fileService.del(cmdResUri);
			}
		} catch { }

		try {
			await this.fileService.writeFile(
				cmdUri,
				VSBuffer.fromString(JSON.stringify({
					id: cmdId,
					action: mode,
					code: trimmedCode,
					sync_vars: syncVars
				}))
			);
		} catch (writeErr) {
			const writeErrMsg = String(writeErr?.message || writeErr || '');
			if (!writeErrMsg.includes('Unable to resolve nonexistent file')) {
				throw writeErr;
			}
		}

		const handledRpcIds = kernel.handledRpcIds;
		const startMs = Date.now();
		let cmdResParseFailures = 0;
		const maxCmdResParseFailures = 5;
		while (!kernel.stopped && !this._cancelledRuns.has(run.runId)) {
			// 1. Check if Python kernel requested a built-in RPC function call
			try {
				const dirStat = await this.fileService.resolve(kernel.kernelDir);
				if (dirStat && dirStat.children) {
					for (const child of dirStat.children) {
						const cName = child.name;
						if (cName.startsWith('rpc_req_') && cName.endsWith('.json') && !cName.endsWith('.tmp')) {
							let reqObj: IPythonRpcRequest | undefined = undefined;
							try {
								const rawReq = await this.fileService.readFile(child.resource);
								reqObj = JSON.parse(rawReq.value.toString());
							} catch { }

							if (reqObj && reqObj.id && !handledRpcIds.has(reqObj.id) && (!reqObj.cmd_id || reqObj.cmd_id === cmdId)) {
								handledRpcIds.add(reqObj.id);
								try { await this.fileService.del(child.resource); } catch { }
								const rpcResponse = await this._handlePythonRpcCall(run, node, stepIndex, state, pathStep, reqObj, trimmedCode);
								const rpcResUri = URI.joinPath(kernel.kernelDir, `rpc_res_${reqObj.id}.json`);
								try {
									await this.fileService.writeFile(rpcResUri, VSBuffer.fromString(JSON.stringify(rpcResponse)));
								} catch (writeErr) {
									const writeErrMsg = String(writeErr?.message || writeErr || '');
									if (!writeErrMsg.includes('Unable to resolve nonexistent file')) {
										throw writeErr;
									}
								}
							}
						}
					}
				}
			} catch { }

			// Fallback check legacy rpc_req.json
			if (await this.fileService.exists(legacyRpcReqUri)) {
				let reqObj: IPythonRpcRequest | undefined = undefined;
				try {
					const rawReq = await this.fileService.readFile(legacyRpcReqUri);
					reqObj = JSON.parse(rawReq.value.toString());
				} catch { }
				if (reqObj && reqObj.id && !handledRpcIds.has(reqObj.id) && (!reqObj.cmd_id || reqObj.cmd_id === cmdId)) {
					handledRpcIds.add(reqObj.id);
					try { await this.fileService.del(legacyRpcReqUri); } catch { }
					const rpcResponse = await this._handlePythonRpcCall(run, node, stepIndex, state, pathStep, reqObj, trimmedCode);
					try {
						await this.fileService.writeFile(legacyRpcResUri, VSBuffer.fromString(JSON.stringify(rpcResponse)));
					} catch { }
				}
			}

			// 2. Check if Python command finished
			if (await this.fileService.exists(cmdResUri)) {
				let resObj: IPythonKernelResponse | undefined = undefined;
				try {
					const rawRes = await this.fileService.readFile(cmdResUri);
					resObj = JSON.parse(rawRes.value.toString());
					cmdResParseFailures = 0;
				} catch (parseErr) {
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
					try {
						if (await this.fileService.exists(cmdUri)) {
							await this.fileService.del(cmdUri);
						}
					} catch { }

					// Sync back changed exported Python variables into run.contextVariables
					if (resObj.variables && typeof resObj.variables === 'object') {
						for (const [vk, vv] of Object.entries(resObj.variables)) {
							if (WorkflowExecutionService.RESERVED_CONTEXT_ALIAS_KEYS.has(vk) || vk.startsWith('@')) {
								continue;
							}
							run.contextVariables[vk] = vv;
							delete run.contextVariables[`@${vk}`];
							kernel.lastSyncedVars.set(vk, vv);
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
							const preview = this._fastPreviewString(newVal, 180);
							this._emitLog(run, 'info', `[Step #${stepIndex + 1} PY] ${assignedVar} = ${preview}`, { nodeId: node.id });
							pathStep?.operations.push({
								type: 'set_variable',
								label: `Python: ${assignedVar} = ${preview.substring(0, 120)}`,
								details: {
									variable: assignedVar,
									expression: trimmedCode,
									newValue: this._summarizeValueForHistory(newVal)
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

			await new Promise(r => setTimeout(r, run.fullSpeed ? 2 : 35));
		}

		throw new Error('Workflow execution was stopped');
	}

	private async _handlePythonRpcCall(
		run: IWorkflowExecutionRun,
		node: IFlowchartNode,
		stepIndex: number,
		state: IWorkflowNodeExecutionState | undefined,
		pathStep: IWorkflowPathStep | undefined,
		reqObj: IPythonRpcRequest,
		stepExpression?: string
	): Promise<{ id: string; result?: unknown; error?: string }> {
		const { id, fn, args = [], kwargs = {} } = reqObj;
		const upperFn = (fn || '').toUpperCase();
		const rawWsUri = URI.parse(run.workflowUri);
		const workflowDir = rawWsUri.path.endsWith('.workflow.json') || rawWsUri.path.endsWith('.json') || rawWsUri.path.endsWith('.workflow')
			? URI.joinPath(rawWsUri, '..')
			: rawWsUri;
		const startMs = Date.now();

		try {
			let result: unknown = undefined;

			if (upperFn === 'RUN_TICKETS') {
				let ticketIdOrPath = '';
				let inputParams: Record<string, unknown> = {};

				const firstArg = args[0];
				if (args.length > 0 && isWorkflowRecord(firstArg) && !Array.isArray(firstArg)) {
					// Ticket references coming from Python are strings; the casts are type-only
					ticketIdOrPath = (firstArg.ticketId || firstArg.ticketName || firstArg.ticketIdOrPath || firstArg.ticket_name || firstArg.id || '') as string;
					inputParams = (firstArg.parameters || firstArg.inputParams || firstArg.params || {}) as IWorkflowRecord;
				} else {
					const rawTicketArg = kwargs.ticket ?? kwargs.tickets ?? kwargs.ticket_name ?? kwargs.ticket_id ?? kwargs.ticketIdOrPath ?? args[0] ?? '';
					if (Array.isArray(rawTicketArg) && rawTicketArg.length > 0) {
						const first: unknown = rawTicketArg[0];
						if (isWorkflowRecord(first)) {
							ticketIdOrPath = (first.ticketId || first.ticketName || first.ticketIdOrPath || first.id || '') as string;
							if (first.parameters && typeof first.parameters === 'object') {
								inputParams = { ...first.parameters };
							}
						} else {
							ticketIdOrPath = String(first).trim();
						}
					} else if (isWorkflowRecord(rawTicketArg)) {
						ticketIdOrPath = (rawTicketArg.ticketId || rawTicketArg.ticketName || rawTicketArg.ticketIdOrPath || rawTicketArg.id || '') as string;
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

				const cleanCtxParams: Record<string, unknown> = {};
				for (const [ck, cv] of Object.entries(run.contextVariables || {})) {
					if (ck.startsWith('@')) { continue; }
					if (cv && typeof cv === 'object' && (hasWorkflowProperty(cv, 'contextVariables') || hasWorkflowProperty(cv, 'stepResults'))) { continue; }
					if (cv !== undefined && cv !== null && (typeof cv !== 'string' || cv.trim() !== '')) {
						cleanCtxParams[ck] = cv;
					}
				}
				this._emitLog(run, 'info', `[RUN_TICKETS] Executing ticket '${ticketIdOrPath}'...`, { nodeId: node.id });

				const inFlightTicketRecord: IExecutedTicketRecord = {
					ticketId: ticketIdOrPath,
					ticketName: ticketIdOrPath,
					ticketType: 'task',
					status: RUNNING_TICKET_RECORD_STATUS,
					durationMs: 0,
					stepResults: []
				};
				const inFlightOp: IWorkflowNodeOperation = {
					type: 'run_ticket',
					label: `RUN_TICKETS: '${ticketIdOrPath}'`,
					executedTicket: inFlightTicketRecord,
					durationMs: 0
				};
				pathStep?.operations.push(inFlightOp);
				this._notifyRunChanged(run);

				const execRes = await this.ticketRuntimeService.RUN_TICKETS({
					workspaceUri: workflowDir,
					ticketIdOrPath,
					inputParams: { ...cleanCtxParams, ...inputParams },
					isCancelled: () => this._cancelledRuns.has(run.runId) || run.status === 'stopped',
					callChain: this._ticketCallChainOf(run),
					humanDecisionContext: { workflowRunId: run.runId, workflowNodeId: node.id, workflowNodeLabel: node.label },
					onStepStart: (info) => {
						this._emitLog(run, 'info', `  \u25B6 [${ticketIdOrPath}] Step ${info.stepIndex}/${info.totalSteps}: [${info.fieldType.toUpperCase()}] '${info.fieldLabel}' started...`, { nodeId: node.id });
						this._notifyRunChanged(run);
					},
					onStepProgress: (stepRes, idx, total) => {
						inFlightTicketRecord.stepResults = inFlightTicketRecord.stepResults || [];
						const existingIdx = inFlightTicketRecord.stepResults.findIndex(s => s.fieldId === stepRes.fieldId);
						if (existingIdx >= 0) {
							inFlightTicketRecord.stepResults[existingIdx] = stepRes;
						} else {
							inFlightTicketRecord.stepResults.push(stepRes);
						}
						this._emitLog(
							run,
							stepRes.status === 'success' ? 'info' : 'warn',
							`  ✔ [${ticketIdOrPath}] Step ${idx}/${total}: [${stepRes.fieldType.toUpperCase()}] '${stepRes.fieldLabel}' -> ${stepRes.status} (${stepRes.durationMs}ms)`,
							{ nodeId: node.id }
						);
						this._notifyRunChanged(run);
					}
				});
				if (this._cancelledRuns.has(run.runId) || run.status === 'stopped') {
					throw new Error('Workflow execution was stopped');
				}
				// A recursion / depth guard inside the ticket stops this whole run (CI-38)
				const ticketChainAbort = this._callChainOf(run).abort.error;
				if (ticketChainAbort) {
					throw new Error(ticketChainAbort);
				}
				if (!execRes.success) {
					throw new Error(execRes.error || `Ticket '${ticketIdOrPath}' execution failed`);
				}
				const ticketRecord: IExecutedTicketRecord = {
					ticketId: execRes.ticketId || ticketIdOrPath,
					ticketName: execRes.ticketName || ticketIdOrPath,
					ticketType: execRes.ticketType || 'task',
					status: 'success' as const,
					output: this._summarizeValueForHistory(execRes.output),
					outputSpecs: (execRes as ITicketRunResult & ITicketRunResultExtras).outputSpecs,
					stepResults: this._sanitizeStepResultsForHistory(execRes.stepResults),
					durationMs: Date.now() - startMs
				};
				inFlightOp.executedTicket = ticketRecord;
				inFlightOp.label = `RUN_TICKETS: '${ticketRecord.ticketName}' [${ticketRecord.ticketType}]`;
				inFlightOp.durationMs = ticketRecord.durationMs;

				if (state) {
					state.executedTickets.push(ticketRecord);
					if (state.executedTickets.length > 50) {
						state.executedTickets.splice(0, state.executedTickets.length - 50);
					}
				}
				const { contextVariables: _omitCtx, stepResults: _omitSteps, ...lightExecRes } = execRes;
				result = lightExecRes;
			} else if (upperFn === 'CREATE_TICKETS') {
				let opts: IRpcTicketCreateOptions = {};
				const createArg = args[0];
				if (args.length === 1 && isWorkflowRecord(createArg)) {
					opts = { ...createArg };
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
					const initialFields: IWorkflowRecord = typeof rawParams === 'object' && rawParams !== null ? { ...rawParams } : {};
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
						if (varKey === 'job_position' && opts.parameters?.current_job && isWorkflowRecord(opts.parameters.current_job)) {
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
					? createParamKeys.map(k => `${k}=${this._fastPreviewString(opts.parameters?.[k], 80)}`).join(', ')
					: 'none';
				this._emitLog(run, 'info', `[CREATE_TICKETS] Creating ticket '${opts.title}' (type: ${opts.ticketType}) with ${createParamKeys.length} parameter(s): ${createParamSummary}`, { nodeId: node.id });
				const createRes = await this.ticketRuntimeService.CREATE_TICKETS(opts as ITicketCreateOptions);
				if (!createRes.success) {
					throw new Error(createRes.error || `Failed to create ticket '${opts.title}'`);
				}
				const { fields: _omitFields, ...lightCreateRes } = createRes;
				result = lightCreateRes;
			} else if (upperFn === 'GET_TICKET' || upperFn === 'GETTICKET') {
				const rawTarget = kwargs.ticket_id ?? kwargs.ticket ?? kwargs.tickets ?? kwargs.ticket_name ?? kwargs.ticketId ?? kwargs.id ?? args[0] ?? '';
				const field = kwargs.field ?? kwargs.key ?? kwargs.name ?? args[1];
				result = await this.ticketRuntimeService.getTicket(workflowDir, rawTarget, field as string | undefined);
			} else if (upperFn === 'GET_TICKETS' || upperFn === 'GETTICKETS') {
				const hasQueryFilters = kwargs.ticket_type !== undefined || kwargs.status !== undefined || kwargs.title !== undefined || kwargs.field !== undefined || kwargs.ticketType !== undefined || kwargs.path !== undefined || kwargs.limit !== undefined;
				if (hasQueryFilters) {
					result = await this.ticketRuntimeService.getTickets(workflowDir, kwargs, kwargs.field as string | undefined);
				} else {
					const rawTarget = kwargs.ticket ?? kwargs.tickets ?? kwargs.ticket_name ?? kwargs.ticket_id ?? kwargs.ticketIdOrPath ?? kwargs.id ?? args[0] ?? '';
					result = await this.ticketRuntimeService.getTickets(workflowDir, rawTarget, kwargs.field as string | undefined);
				}
			} else if (upperFn === 'GET_OUTPUTS') {
				const rawTarget = kwargs.ticket_id ?? kwargs.ticket ?? kwargs.tickets ?? kwargs.ticket_name ?? kwargs.ticketId ?? kwargs.ticketIdOrPath ?? kwargs.id ?? args[0] ?? '';
				const requestedField = kwargs.field ?? kwargs.key ?? kwargs.name ?? kwargs.output ?? args[1];
				const targetField = (requestedField !== undefined && requestedField !== null && String(requestedField).trim() !== '') ? String(requestedField).trim() : undefined;
				result = await this.ticketRuntimeService.GET_OUTPUTS(workflowDir, rawTarget, targetField);
			} else if (upperFn === 'GET_PRIMITIVES_CATALOG') {
				result = await this.ticketRuntimeService.GET_PRIMITIVES_CATALOG(workflowDir);
			} else if (upperFn === 'DISPLAY') {
				let displayVal: unknown;
				if (args.length === 1) {
					displayVal = args[0];
				} else if (args.length > 1) {
					displayVal = args;
				} else if (Object.keys(kwargs).length > 0) {
					displayVal = kwargs;
				} else {
					displayVal = run.contextVariables;
				}
				result = true;

				const { formattedText, summaryType, cleanValue, ticketTitle, ticketId, ticketType, outputItems, ticketHandle, isTruncated, displayPreviewText, totalCount } = this._formatDisplayOutput(displayVal);
				const nodeLabelName = (node.label && node.label.trim()) ? node.label.trim() : (node.id || 'Node');
				const logDisplayPreview = formattedText.length > 500
					? formattedText.substring(0, 500) + ' ... [see Live Display]'
					: formattedText;
				this._emitLog(run, 'info', `[DISPLAY] [${nodeLabelName}] (${summaryType})\n${logDisplayPreview}`, { nodeId: node.id });

				const callExprFromPython = typeof reqObj.call_expr === 'string' && reqObj.call_expr.trim()
					? reqObj.call_expr.trim()
					: (stepExpression && !stepExpression.includes('\n') ? stepExpression.trim() : 'DISPLAY(...)');

				const displayWfUri = (run as IInternalWorkflowRun)._displayWorkflowUri || run.workflowUri;
				const displayRunId = (run as IInternalWorkflowRun)._displayRunId || run.runId;
				let cardList = this._displayCardsByWorkflow.get(displayWfUri);
				if (!cardList) {
					cardList = [];
					this._displayCardsByWorkflow.set(displayWfUri, cardList);
				}
				const existingIdx = cardList.findIndex(c => c.runId === displayRunId && c.nodeId === node.id && c.expression === callExprFromPython);
				const reusedId = existingIdx !== -1 ? cardList.splice(existingIdx, 1)[0].id : `display_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

				const displayCard: IWorkflowDisplayCard = {
					id: reusedId,
					workflowUri: displayWfUri,
					runId: displayRunId,
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
					ticketHandle,
					isTruncated,
					displayPreviewText,
					totalCount
				};

				cardList.unshift(displayCard);
				if (cardList.length > 30) {
					cardList.length = 30;
				}
				this._onDidDisplayVariable.fire(displayCard);
			} else {
				throw new Error(`Unknown RPC function: ${fn}`);
			}

			return { id, result };
		} catch (err) {
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

			const cleanVars: Record<string, unknown> = {};
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
		} catch (err) {
			const cleanVars: Record<string, unknown> = {};
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
