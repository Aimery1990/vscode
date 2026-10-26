/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEntityPersistenceService } from '../../entityPersistence/common/entityPersistence.js';
import { IWorkflowExecutionService, IWorkflowDisplayCard, IWorkflowDisplayOutputItem, ITicketHandleInfo } from '../common/workflowExecutionService.js';
import { ITicketWorkflowRuntimeService } from './ticketWorkflowRuntime.js';
import {
	IWorkflowEngineOptions,
	IWorkflowExecutionRun,
	IWorkflowLogEntry,
	IWorkflowNodeExecutionState
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

	private tokenize(expr: string): string[] {
		const tokens: string[] = [];
		let i = 0;
		let s = expr.trim();
		if (s.startsWith('=')) {
			s = s.substring(1).trim();
		}
		// Strip @ before variable names / tickets: e.g. "@monitor1" -> "monitor1", "@FNDJ1-0008" -> "FNDJ1-0008"
		s = s.replace(/@([a-zA-Z0-9_\-]+)/g, '$1');

		while (i < s.length) {
			const ch = s[i];
			if (/\s/.test(ch)) {
				i++;
				continue;
			}
			// Quoted strings: '...' or "..."
			if (ch === "'" || ch === '"') {
				const quote = ch;
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
			if (['+', '-', '*', '/', '%', '(', ')', '<', '>', '=', '!', ',', ':', '[', ']'].includes(ch)) {
				tokens.push(ch);
				i++;
				continue;
			}

			// Identifiers, numbers, or keywords
			let word = '';
			while (i < s.length && !/\s|[()+\-*/%<>=!,'":\[\]]/.test(s[i])) {
				word += s[i];
				i++;
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
				} else if (typeof left === 'string' && typeof right === 'string') {
					left = left + right;
				} else if (typeof left === 'string' || typeof right === 'string') {
					throw new Error(`TypeError: can only concatenate str (not "${typeof left === 'string' ? typeof right : typeof left}") to str`);
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
		return this.parsePrimary();
	}

	// Level 9: Primary (literal, variable lookup, parentheses)
	private parsePrimary(): any {
		const token = this.peek();
		if (!token) {
			throw new Error('SyntaxError: unexpected end of expression');
		}

		if (token === '(') {
			this.consume('(');
			const val = this.parseOr();
			this.consume(')');
			return val;
		}

		this.consume();

		// Assignment / mutation prefix fallback (e.g. "+= 1")
		if (token === '+=' || token === '-=') {
			const val = this.parseUnary();
			return token === '+=' ? +val : -val;
		}

		// Python literals
		if (token === 'None' || token === 'null') return null;
		if (token === 'True' || token === 'true') return true;
		if (token === 'False' || token === 'false') return false;

		// Number literal
		if (/^-?\d+(\.\d+)?$/.test(token)) {
			return Number(token);
		}

		// Quoted string literal
		if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) {
			return token.substring(1, token.length - 1);
		}

		// Identifier lookup in context (including ticket identifiers like FNDJ1-0008)
		if (/^[a-zA-Z0-9_]+(-[a-zA-Z0-9_]+)*$/.test(token) && !/^\d+$/.test(token)) {
			if (this.context && Object.prototype.hasOwnProperty.call(this.context, token)) {
				return this.context[token];
			}
			const withAt = `@${token}`;
			if (this.context && Object.prototype.hasOwnProperty.call(this.context, withAt)) {
				return this.context[withAt];
			}
			const normalizedToken = token.replace(/[^a-zA-Z0-9_]/g, '_');
			if (this.context && Object.prototype.hasOwnProperty.call(this.context, normalizedToken)) {
				return this.context[normalizedToken];
			}
			if (this.context && Object.prototype.hasOwnProperty.call(this.context, `@${normalizedToken}`)) {
				return this.context[`@${normalizedToken}`];
			}
			// If it has a hyphen, it's a ticket or slug entity; return the entity string instead of throwing NameError
			if (token.includes('-')) {
				return token;
			}
			throw new Error(`NameError: name '${token}' is not defined in workflow context`);
		}

		// If token is an unrecognized symbol or punctuation: fail fast with SyntaxError
		throw new Error(`SyntaxError: invalid or unrecognized syntax '${token}' in expression '${this.rawExpr}'`);
	}
}

export class WorkflowExecutionService implements IWorkflowExecutionService {
	readonly _serviceBrand: undefined;

	private readonly _runs = new Map<string, IWorkflowExecutionRun>();
	private readonly _activeRunsByWorkflow = new Map<string, string>();
	private readonly _humanWaiters = new Map<string, (input: any) => void>();
	private readonly _stepWaiters = new Map<string, () => void>();
	private readonly _cancelledRuns = new Set<string>();

	private readonly _onDidChangeRunState = new Emitter<IWorkflowExecutionRun>();
	readonly onDidChangeRunState: Event<IWorkflowExecutionRun> = this._onDidChangeRunState.event;

	private readonly _onDidEmitLog = new Emitter<{ runId: string; log: IWorkflowLogEntry }>();
	readonly onDidEmitLog: Event<{ runId: string; log: IWorkflowLogEntry }> = this._onDidEmitLog.event;

	private readonly _onDidDisplayVariable = new Emitter<IWorkflowDisplayCard>();
	readonly onDidDisplayVariable: Event<IWorkflowDisplayCard> = this._onDidDisplayVariable.event;

	constructor(
		@IEntityPersistenceService private readonly entityPersistenceService: IEntityPersistenceService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ITicketWorkflowRuntimeService private readonly ticketRuntimeService: ITicketWorkflowRuntimeService
	) { }

	private readonly _displayCardsByWorkflow = new Map<string, IWorkflowDisplayCard[]>();

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
		return Array.from(this._runs.values()).filter(r => r.workflowUri === uriStr);
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
			logs: []
		};
		this._notifyRunChanged(idleRun);
	}

	async executeWorkflow(workflowUri: URI | string, options?: IWorkflowEngineOptions): Promise<IWorkflowExecutionRun> {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		const existingRunId = this._activeRunsByWorkflow.get(uriStr);
		if (existingRunId) {
			const existing = this._runs.get(existingRunId);
			if (existing && (existing.status === 'running' || existing.status === 'waiting_human')) {
				this.logService.info(`[WorkflowExecution] Resuming already active run ${existingRunId} for ${uriStr}`);
				return existing;
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

		const run: IWorkflowExecutionRun = {
			runId,
			workflowUri: uriStr,
			workflowName,
			status: 'running',
			mode: options?.mode || 'standard',
			currentNodeId: undefined,
			visitedNodeIds: [],
			startedAt: Date.now(),
			updatedAt: Date.now(),
			contextVariables: { ...(options?.initialInputs || {}) },
			nodeStates: {},
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
		this._runWorkflowAsync(run, flowchartData, options).catch(err => {
			this.logService.error(`[WorkflowExecution] Fatal error in run ${runId}:`, err);
			run.status = 'failed';
			run.error = err.message || String(err);
			run.updatedAt = Date.now();
			run.completedAt = Date.now();
			this._emitLog(run, 'error', `Execution failed: ${run.error}`);
			this._notifyRunChanged(run);
		});

		return run;
	}

	async stepWorkflow(workflowUri: URI | string, options?: IWorkflowEngineOptions, runId?: string): Promise<IWorkflowExecutionRun> {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		let targetRun = runId ? this._runs.get(runId) : this.getActiveRun(uriStr);

		if (!targetRun || targetRun.status === 'completed' || targetRun.status === 'failed' || targetRun.status === 'stopped') {
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
		run.status = 'stopped';
		run.updatedAt = Date.now();
		run.completedAt = Date.now();
		this._emitLog(run, 'warn', 'Workflow execution manually stopped');
		this._notifyRunChanged(run);

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
	}

	private async _runWorkflowAsync(
		run: IWorkflowExecutionRun,
		data: IFlowchartData,
		options?: IWorkflowEngineOptions
	): Promise<void> {
		let isDaemonLoop = run.mode === 'daemon';

		do {
			// Find Start/Entry node
			const entryNode = this._findEntryNode(data, options?.entryNodeId);
			if (!entryNode) {
				throw new Error('No valid start node found in workflow.');
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
						this._emitLog(run, 'info', `Executing node: '${node.label}' (${node.type})`, { nodeId: node.id });
						try {
							await this._executeNode(run, node, nodeState);
							nodeState.status = 'success';
							nodeState.completedAt = Date.now();
							nodeState.durationMs = nodeState.completedAt - (nodeState.startedAt || nodeState.completedAt);
							this._emitLog(run, 'info', `Completed node: '${node.label}' in ${nodeState.durationMs}ms`, { nodeId: node.id });

							// Assign to bound context variables if present
							const pipelineAssignedVars = new Set<string>();
							if (node.pipeline && Array.isArray(node.pipeline)) {
								for (const step of node.pipeline) {
									if (step.type === 'set_variable' && step.targetVariable) {
										pipelineAssignedVars.add(step.targetVariable.replace(/^@/, '').trim());
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
									this._emitLog(run, 'info', `[Variable Updated] '${cleanVarName}' = ${typeof assignedVal === 'object' ? JSON.stringify(assignedVal) : assignedVal}${v.expression ? ` (${v.expression})` : ''}`, { nodeId: node.id });
								}
							}
						} catch (err: any) {
							nodeState.status = 'failed';
							nodeState.error = err.message || String(err);
							nodeState.completedAt = Date.now();
							nodeState.durationMs = nodeState.completedAt - (nodeState.startedAt || nodeState.completedAt);
							this._emitLog(run, 'error', `Node '${node.label}' failed: ${nodeState.error}`, { nodeId: node.id });
							throw err;
						} finally {
							this._notifyRunChanged(run);
						}

						// Check if end node
						if (this._isEndNode(node)) {
							this._emitLog(run, 'info', `Reached end node: '${node.label}'. Execution branch completed.`);
							return [];
						}

						// Resolve next nodes from this node
						return await this._resolveNextNodes(run, node, data);
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

		if (!this._cancelledRuns.has(run.runId)) {
			run.status = 'completed';
			run.completedAt = Date.now();
			run.updatedAt = Date.now();
			this._emitLog(run, 'info', `Workflow '${run.workflowName}' executed successfully to completion!`);
			this.notificationService.info(`Workflow '${run.workflowName}' completed successfully.`);
			this._notifyRunChanged(run);
		}
	}

	private async _executeNode(
		run: IWorkflowExecutionRun,
		node: IFlowchartNode,
		state: IWorkflowNodeExecutionState
	): Promise<void> {
		// 1. Start Node
		if (node.type === 'circle' && (node.label.toLowerCase() === 'start' || !node.label)) {
			state.output = { message: 'Workflow started' };
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
					inputParams: { ...run.contextVariables, ...inputParams }
				});

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
				const step = node.pipeline[i];
				const isRunTicketStep = step.type === 'run_ticket' || step.type === 'run_tickets' || step.type === 'RUN_TICKETS' || step.type === 'runTickets';
				const isCallFnStep = step.type === 'call_function' || (step.expression && this._isFunctionCallExpression(step.expression));

				if (isCallFnStep) {
					await this._executeFunctionStep(run, node, step, i, state);
				} else if (isRunTicketStep && step.ticketName) {
					this._emitLog(run, 'info', `[Step #${i + 1}] Run Ticket: '${step.ticketName}'${step.parameters ? ` (PARAM: ${step.parameters})` : ''}`);
					const ticketRecord = await runTicket(step.ticketName, step.ticketType, step.ticketUri, step.parameters);
					if (step.targetVariable) {
						const varKey = step.targetVariable.trim().replace(/^@/, '');
						run.contextVariables[varKey] = ticketRecord.output;
						this._emitLog(run, 'info', `[Step #${i + 1}] Output stored in variable: @${varKey}`);
					}
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
		return /^(?:@?[a-zA-Z0-9_\u4e00-\u9fa5]+\s*=\s*)?[a-zA-Z0-9_]+\s*\(.*?\)$/s.test(trimmed);
	}

	private async _executeFunctionStep(
		run: IWorkflowExecutionRun,
		node: IFlowchartNode,
		step: INodePipelineStep,
		stepIndex: number,
		state: IWorkflowNodeExecutionState
	): Promise<void> {
		const rawExpr = (step.expression || '').trim();
		const wsUri = URI.parse(run.workflowUri);

		this._emitLog(run, 'info', `[Step #${stepIndex + 1} FX] Invoking function call: ${rawExpr || step.functionName || 'unknown'}`, { nodeId: node.id });

		// Parse expression: e.g. "@news = RUN_TICKETS('jobs/news_digest', { 'target_keyword': 'AI' })"
		const match = rawExpr.match(/^(?:@?([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*=\s*)?([a-zA-Z0-9_]+)\s*\(([\s\S]*)\)$/);
		let targetVar = step.targetVariable?.replace(/^@/, '');
		let fnName = step.functionName || '';
		let rawArgsStr = '';

		if (match) {
			if (match[1]) targetVar = match[1].replace(/^@/, '');
			fnName = match[2];
			rawArgsStr = match[3] || '';
		} else if (!fnName && rawExpr) {
			fnName = rawExpr;
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
					const rawTicketArg = kwargs.ticket_name ?? kwargs.ticket_id ?? kwargs.ticketIdOrPath ?? kwargs.ticket ?? args[0] ?? '';
					if (typeof rawTicketArg === 'object' && rawTicketArg !== null) {
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

				// Merge any loose keyword arguments directly into inputParams (e.g. RUN_TICKETS("jobs/calc", start=@start))
				// Keyword arguments explicitly passed to the function call ALWAYS take precedence!
				const reservedKeys = new Set(['ticket_name', 'ticket_id', 'ticketIdOrPath', 'ticket', 'params', 'input_params', 'parameters', 'inputParams']);
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

				result = execRes.output !== undefined ? execRes.output : execRes;
				if (result && typeof result === 'object' && !Array.isArray(result)) {
					try {
						Object.defineProperty(result, '__ticketMetadata', {
							value: {
								ticketId: execRes.ticketId || ticketIdOrPath,
								ticketName: execRes.ticketName || ticketIdOrPath,
								ticketType: execRes.ticketType || 'ticket',
								outputSpecs: (execRes as any).outputSpecs || []
							},
							enumerable: false,
							configurable: true,
							writable: true
						});
					} catch {}
				}
				const ticketRecord = {
					ticketId: execRes.ticketId || ticketIdOrPath,
					ticketName: execRes.ticketName || ticketIdOrPath,
					ticketType: execRes.ticketType || 'task',
					status: (execRes.success ? 'success' : 'failed') as 'success' | 'failed',
					output: execRes.output,
					durationMs: Date.now() - startMs
				};
				state.executedTickets.push(ticketRecord);

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
					const reservedCreateKeys = new Set(['ticket_type', 'type', 'title', 'target_folder', 'target_path', 'folder', 'path', 'folder_name', 'folderName', 'name', 'parameters', 'params', 'fieldValues', 'auto_run', 'autoRun', 'run']);
					for (const [k, v] of Object.entries(kwargs)) {
						if (!reservedCreateKeys.has(k)) {
							initialFields[k] = v;
						}
					}
					opts.parameters = initialFields;
					opts.fieldValues = initialFields;
					opts.autoRun = kwargs.auto_run === true || kwargs.autoRun === true || kwargs.run === true;
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
			} else if (upperFn === 'GET_TICKETS' || upperFn === 'GETTICKETS' || upperFn === 'GETTICKET') {
				const ticketIdOrPath = String(kwargs.ticket_name ?? kwargs.ticket_id ?? kwargs.ticketIdOrPath ?? kwargs.ticket ?? args[0] ?? '').trim();
				const getRes = await this.ticketRuntimeService.GET_TICKETS(workflowDir, ticketIdOrPath);
				result = getRes.output !== undefined ? getRes.output : getRes;
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
				this._emitLog(run, 'info', `[DISPLAY] [${nodeLabelName}]\n${formattedText}`, { nodeId: node.id });

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
			} else {
				// Fallback evaluation for general expressions
				try {
					const evaluator = new PythonExpressionEvaluator(rawExpr, run.contextVariables);
					result = evaluator.evaluate();
				} catch (err: any) {
					throw new Error(`Unsupported function '${fnName}': ${err.message}`);
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

		// String literals
		if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
			return s.slice(1, -1);
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

		// 1. Check if displayVal is a newly created Ticket Handle (descriptor)
		const isTicketHandle = typeof displayVal === 'object' && displayVal !== null && !Array.isArray(displayVal) && (
			displayVal.isHandle === true ||
			(displayVal.ticketId && displayVal.ticketType && (!displayVal.outputs || Object.keys(displayVal.outputs).length === 0) && displayVal.output === undefined)
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

		// 2. Check if displayVal is an executed Ticket or contains Ticket Fields/Outputs
		let ticketId = displayVal?.ticketId || displayVal?.__ticketMetadata?.ticketId || '';
		let ticketName = displayVal?.ticketName || displayVal?.title || displayVal?.__ticketMetadata?.ticketName || '';
		let ticketType = displayVal?.ticketType || displayVal?.__ticketMetadata?.ticketType || '';

		let extractedOutputs: Record<string, any> = {};
		const outputFormats: Record<string, string> = {};

		// Extract candidate outputSpecs from direct metadata or properties
		const candidateSpecs: any[] = displayVal?.outputSpecs || displayVal?.__ticketMetadata?.outputSpecs || [];
		if (Array.isArray(candidateSpecs)) {
			for (const spec of candidateSpecs) {
				if (spec && spec.defaultFormat) {
					const k = spec.label || spec.fieldKey;
					outputFormats[k] = spec.defaultFormat;
					outputFormats[spec.fieldKey] = spec.defaultFormat;
					outputFormats[k.toLowerCase().replace(/[^a-z0-9]/g, '')] = spec.defaultFormat;
				}
			}
		}

		const isExplicitTicket = typeof displayVal === 'object' && displayVal !== null && !Array.isArray(displayVal) && (
			displayVal.ticketId !== undefined ||
			displayVal.ticketType !== undefined ||
			displayVal.fields !== undefined ||
			displayVal.outputs !== undefined ||
			displayVal.customMetadata !== undefined ||
			displayVal.__ticketMetadata !== undefined
		);

		if (isExplicitTicket) {
			const fields = displayVal.fields || displayVal.customMetadata || {};
			const rawSpecs = fields['outputSpecs'] || fields['output_specs'];
			if (rawSpecs && typeof rawSpecs === 'string' && rawSpecs.trim().startsWith('[')) {
				try {
					const parsed = JSON.parse(rawSpecs);
					if (Array.isArray(parsed)) {
						for (const spec of parsed) {
							if (spec && spec.defaultFormat) {
								const k = spec.label || spec.fieldKey;
								outputFormats[k] = spec.defaultFormat;
								outputFormats[spec.fieldKey] = spec.defaultFormat;
								outputFormats[k.toLowerCase().replace(/[^a-z0-9]/g, '')] = spec.defaultFormat;
							}
						}
					}
				} catch {}
			}

			if (displayVal.outputs && typeof displayVal.outputs === 'object' && Object.keys(displayVal.outputs).length > 0) {
				extractedOutputs = { ...displayVal.outputs };
			} else if (displayVal.fields || displayVal.customMetadata) {
				const outMeta = fields['Output'] || fields['output'] || fields['Result'] || fields['result'];
				if (outMeta && typeof outMeta === 'string' && outMeta.trim().startsWith('{')) {
					try {
						const parsed = JSON.parse(outMeta);
						if (Array.isArray(parsed.outputSpecs)) {
							for (const spec of parsed.outputSpecs) {
								if (spec.enabled !== false) {
									const key = spec.label || spec.fieldKey;
									const raw = fields[key] || fields[spec.fieldKey];
									extractedOutputs[key] = this._extractPrimitiveCleanValue(raw, spec.defaultFormat);
									if (spec.defaultFormat) {
										outputFormats[key] = spec.defaultFormat;
										outputFormats[spec.fieldKey] = spec.defaultFormat;
										outputFormats[key.toLowerCase().replace(/[^a-z0-9]/g, '')] = spec.defaultFormat;
									}
								}
							}
						}
					} catch {}
				}

				if (Object.keys(extractedOutputs).length === 0) {
					for (const [k, v] of Object.entries(fields)) {
						if (k.toLowerCase().startsWith('param') || k === 'parameters' || k === 'outputspecs' || k === 'output_specs') continue;
						const extracted = this._extractPrimitiveCleanValue(v);
						if (extracted !== undefined) {
							extractedOutputs[k] = extracted;
						}
					}
				}
			}
		}

		// Direct dictionary / map of outputs or array of outputs
		if (Object.keys(extractedOutputs).length === 0 && typeof displayVal === 'object' && displayVal !== null) {
			if (Array.isArray(displayVal)) {
				if (displayVal.length > 0) {
					displayVal.forEach((item, idx) => {
						const label = (item && typeof item === 'object' && (item.label || item.title || item.name))
							? String(item.label || item.title || item.name)
							: `Output #${idx + 1}`;
						extractedOutputs[label] = item;
					});
				}
			} else {
				for (const [k, v] of Object.entries(displayVal)) {
					if (k.startsWith('__') || k === 'outputSpecs' || k === 'output_specs') continue;
					extractedOutputs[k] = v;
				}
			}
		}

		if (Object.keys(extractedOutputs).length > 0) {
			const outputEntries = Object.entries(extractedOutputs);
			const lines: string[] = [];

			if (ticketName || ticketId || ticketType) {
				lines.push(`======================================================================`);
				lines.push(`Ticket Outputs: ${ticketName || 'Ticket'}${ticketId ? ` (${ticketId})` : ''}${ticketType ? ` [${ticketType}]` : ''}`);
				lines.push(`======================================================================`);
			}

			outputEntries.forEach(([key, val], idx) => {
				lines.push('');
				lines.push(`----------------------------------------------------------------------`);
				lines.push(`[OUTPUT ${idx + 1}] ${key}`);
				lines.push(`----------------------------------------------------------------------`);
				if (typeof val === 'object' && val !== null) {
					lines.push(JSON.stringify(val, null, 2));
				} else {
					lines.push(String(val).trim());
				}
			});

			// Build structured output items for accordion rendering
			const outputItems: IWorkflowDisplayOutputItem[] = [];
			for (const [key, val] of Object.entries(extractedOutputs)) {
				const cleanKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
				const configuredFormat = (outputFormats[key] || outputFormats[cleanKey])?.toLowerCase();
				let fmt = configuredFormat || 'text';
				let strVal = '';

				if (typeof val === 'object' && val !== null) {
					if (configuredFormat === 'text') {
						if (Array.isArray(val)) {
							const allPrimitive = val.every(item => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean');
							strVal = allPrimitive ? val.join('\n') : JSON.stringify(val, null, 2);
						} else {
							strVal = JSON.stringify(val, null, 2);
						}
						fmt = 'text';
					} else if (configuredFormat === 'table') {
						fmt = 'table';
						strVal = typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val);
					} else {
						fmt = configuredFormat || (Array.isArray(val) ? 'json' : 'json');
						strVal = JSON.stringify(val, null, 2);
					}
				} else if (typeof val === 'string') {
					strVal = val.trim();
					if (configuredFormat) {
						fmt = configuredFormat;
						if ((strVal.startsWith('{') && strVal.endsWith('}')) || (strVal.startsWith('[') && strVal.endsWith(']'))) {
							try {
								const parsed = JSON.parse(strVal);
								if (configuredFormat === 'text' && Array.isArray(parsed)) {
									const allPrimitive = parsed.every(item => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean');
									if (allPrimitive) strVal = parsed.join('\n');
								} else {
									strVal = JSON.stringify(parsed, null, 2);
								}
							} catch {}
						}
					} else {
						// Auto-inference fallback
						if ((strVal.startsWith('{') && strVal.endsWith('}')) || (strVal.startsWith('[') && strVal.endsWith(']'))) {
							try {
								const parsed = JSON.parse(strVal);
								fmt = 'json';
								strVal = JSON.stringify(parsed, null, 2);
							} catch {
								fmt = 'text';
							}
						} else {
							const jsonBlock = strVal.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
							if (jsonBlock && jsonBlock[1]) {
								try {
									const parsed = JSON.parse(jsonBlock[1].trim());
									fmt = 'json';
									strVal = JSON.stringify(parsed, null, 2);
								} catch {
									fmt = 'markdown';
								}
							} else if (strVal.startsWith('#') || strVal.includes('•') || strVal.includes('http')) {
								fmt = 'text';
							}
						}
					}
				} else {
					strVal = String(val);
					fmt = configuredFormat || typeof val;
				}

				const isPending = !strVal || strVal.includes('Pending AI Execution');
				const isFailed = strVal.startsWith('[Browser: Skipped') || strVal.startsWith('[Fetch Failed') || strVal.startsWith('HTTP Error');

				outputItems.push({
					label: key,
					format: fmt,
					content: strVal,
					status: isPending ? 'pending' : (isFailed ? 'failed' : (strVal.length > 0 ? 'ready' : 'empty'))
				});
			}

			return {
				formattedText: lines.join('\n').trim(),
				summaryType: `Outputs (${outputEntries.length} items)`,
				cleanValue: extractedOutputs,
				ticketTitle: ticketName || undefined,
				ticketId: ticketId || undefined,
				ticketType: ticketType || undefined,
				outputItems: outputItems
			};
		}

		if (typeof displayVal === 'string') {
			return { formattedText: displayVal, summaryType: `string (${displayVal.length} chars)`, cleanValue: displayVal };
		}
		if (typeof displayVal === 'number' || typeof displayVal === 'boolean') {
			return { formattedText: String(displayVal), summaryType: typeof displayVal, cleanValue: displayVal };
		}

		// General Array or Object
		return {
			formattedText: JSON.stringify(displayVal, null, 2),
			summaryType: Array.isArray(displayVal) ? `array [${displayVal.length}]` : `object {${Object.keys(displayVal).length} keys}`,
			cleanValue: displayVal
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
				} catch {}
			}
		}
		return rawMeta;
	}

	private async _resolveNextNodes(
		run: IWorkflowExecutionRun,
		currentNode: IFlowchartNode,
		data: IFlowchartData
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
			for (const link of outgoingLinks) {
				const rawLabel = (link.label || '').trim();
				if (!rawLabel) continue;

				const condResult = this._evaluateCondition(rawLabel, run.contextVariables, run.nodeStates[currentNode.id], run);
				if (condResult === true) {
					const target = data.nodes.find(n => n.id === link.to);
					if (target) {
						this._emitLog(run, 'info', `Condition MATCHED: '${link.label}' -> navigating to '${target.label}'`);
						matchedNodes.push(target);
					}
				} else if (condResult === false) {
					this._emitLog(run, 'info', `Condition REJECTED: '${link.label}' (context: ${JSON.stringify(run.contextVariables)})`);
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
				return fallbackNodes;
			}

			this._emitLog(run, 'warn', `No outgoing branch condition was satisfied from '${currentNode.label}'. Execution stopped.`);
			return [];
		}

		if (outgoingLinks.length === 1) {
			const targetId = outgoingLinks[0].to;
			const target = data.nodes.find(n => n.id === targetId);
			return target ? [target] : [];
		}

		// Parallel Fork (Unconditional / Fan-Out):
		// All outgoing branches are taken concurrently!
		const targetNodes = outgoingLinks
			.map(l => data.nodes.find(n => n.id === l.to))
			.filter((n): n is IFlowchartNode => !!n);

		this._emitLog(run, 'info', `Parallel fork: simultaneously executing ${targetNodes.length} branches -> [${targetNodes.map(n => `'${n.label}'`).join(', ')}]`);
		return targetNodes;
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
		if (lower === 'true' || lower === 'yes' || lower === 'success' || lower === 'pass') {
			return true;
		}
		if (lower === 'false' || lower === 'no' || lower === 'fail' || lower === 'reject') {
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
			return false;
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

		// 1. Look for circle Start node
		const startCircle = data.nodes.find(n =>
			n.type === 'circle' && n.label.toLowerCase() === 'start'
		);
		if (startCircle) return startCircle;

		// 2. Node with 0 incoming links
		const targetIds = new Set(data.links.map(l => l.to));
		const entryCandidate = data.nodes.find(n => !targetIds.has(n.id) && n.type !== 'diamond');
		if (entryCandidate) return entryCandidate;

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
						links: Array.isArray(parsed.links) ? parsed.links : Array.isArray(parsed.connections) ? parsed.connections : Array.isArray(parsed.edges) ? parsed.edges : []
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
		const log: IWorkflowLogEntry = {
			id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
			timestamp: Date.now(),
			level,
			nodeId: data?.nodeId || run.currentNodeId,
			ticketId: data?.ticketId,
			message,
			data
		};
		run.logs.push(log);
		run.updatedAt = Date.now();
		this._onDidEmitLog.fire({ runId: run.runId, log });
	}

	private _notifyRunChanged(run: IWorkflowExecutionRun): void {
		run.updatedAt = Date.now();
		this._onDidChangeRunState.fire(run);
	}
}
