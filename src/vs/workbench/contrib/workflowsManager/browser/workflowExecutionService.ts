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
import { IWorkflowExecutionService } from '../common/workflowExecutionService.js';
import {
	IWorkflowEngineOptions,
	IWorkflowExecutionRun,
	IWorkflowLogEntry,
	IWorkflowNodeExecutionState
} from '../common/workflowExecutionModel.js';

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

	constructor(expr: string, context: Record<string, any>) {
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
		// Strip @ before variable names: e.g. "@monitor1" -> "monitor1"
		s = s.replace(/@([a-zA-Z0-9_]+)/g, '$1');

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

			// Two-char operators: ==, !=, <=, >=, //, **
			const two = s.slice(i, i + 2);
			if (['==', '!=', '<=', '>=', '//', '**'].includes(two)) {
				tokens.push(two);
				i += 2;
				continue;
			}

			// Single-char operators and punctuation
			if (['+', '-', '*', '/', '%', '(', ')', '<', '>'].includes(ch)) {
				tokens.push(ch);
				i++;
				continue;
			}

			// Identifiers, numbers, or keywords
			let word = '';
			while (i < s.length && !/\s|[()+\-*/%<>=!,'"]/.test(s[i])) {
				word += s[i];
				i++;
			}
			if (word) {
				tokens.push(word);
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

		// Identifier lookup in context
		if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(token)) {
			if (this.context && Object.prototype.hasOwnProperty.call(this.context, token)) {
				return this.context[token];
			}
			throw new Error(`NameError: name '${token}' is not defined in workflow context`);
		}

		return token;
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

	constructor(
		@IEntityPersistenceService private readonly entityPersistenceService: IEntityPersistenceService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService
	) { }

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
					const initVal = this._resolveValue(v.initialValue || 'None', {});
					run.contextVariables[v.name] = initVal;
					v.currentValue = initVal;
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
							const nodeVars = this._getNodeVars(node);
							for (const v of nodeVars) {
								if (v.name) {
									let assignedVal: any;
									const oldVal = run.contextVariables[v.name];

									if (v.expression) {
										let expr = v.expression.trim();
										// Strip self-assignment prefix if present (e.g. "monitor = monitor + 1" or "monitor += 1")
										if (expr.startsWith(`${v.name} =`)) {
											expr = expr.substring(`${v.name} =`.length).trim();
										} else if (expr.startsWith(`${v.name}=`)) {
											expr = expr.substring(`${v.name}=`.length).trim();
										} else if (expr.startsWith(`${v.name} +=`)) {
											expr = `+=${expr.substring(`${v.name} +=`.length).trim()}`;
										} else if (expr.startsWith(`${v.name}+=`)) {
											expr = `+=${expr.substring(`${v.name}+=`.length).trim()}`;
										} else if (expr.startsWith(`${v.name} -=`)) {
											expr = `-=${expr.substring(`${v.name} -=`.length).trim()}`;
										} else if (expr.startsWith(`${v.name}-=`)) {
											expr = `-=${expr.substring(`${v.name}-=`.length).trim()}`;
										}
										if (expr.startsWith('=')) {
											expr = expr.substring(1).trim();
										}

										// Check if expr references a ticket or unpack index: e.g. "@my_ticket", "@my_ticket[0]", "ticket.output[1]"
										const ticketMatch = expr.match(/^@?([a-zA-Z0-9_]+)(\[(\d+)\])?$/);
										const cleanTarget = ticketMatch ? ticketMatch[1] : '';
										const unpackIdx = ticketMatch && ticketMatch[3] !== undefined ? parseInt(ticketMatch[3], 10) : undefined;

										const matchedTicket = nodeState.executedTickets?.find(t =>
											t.ticketName === cleanTarget ||
											t.ticketName.replace(/[^a-zA-Z0-9_]/g, '_') === cleanTarget ||
											t.ticketId === cleanTarget
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
										} else {
											try {
												assignedVal = this._evaluateExpressionOrLiteral(expr, run.contextVariables);
											} catch (evalErr: any) {
												this._emitLog(run, 'error', `[Expression Error] '${v.name}' in '${node.label}': ${evalErr.message}`, { nodeId: node.id });
												throw evalErr;
											}
										}
									} else if (nodeState.executedTickets && nodeState.executedTickets.length > 0) {
										const lastTicket = nodeState.executedTickets[nodeState.executedTickets.length - 1];
										assignedVal = lastTicket?.output ?? 'success';
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

									run.contextVariables[v.name] = assignedVal;
									v.currentValue = assignedVal;
									this._emitLog(run, 'info', `[Variable Updated] '${v.name}' = ${typeof assignedVal === 'object' ? JSON.stringify(assignedVal) : assignedVal}${v.expression ? ` (${v.expression})` : ''}`, { nodeId: node.id });
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
			node.label.includes('人工') ||
			node.label.includes('审批') ||
			node.label.includes('审核');

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

		// 4. Imported Tickets Sequential Execution
		const ticketImports = node.imports?.filter(i =>
			['task', 'job', 'project', 'case', 'issue'].includes(i.type.toLowerCase())
		) || [];

		if (ticketImports.length > 0) {
			this._emitLog(run, 'info', `Node '${node.label}' contains ${ticketImports.length} imported ticket(s). Executing sequentially...`);
			for (const item of ticketImports) {
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
				this._emitLog(run, 'info', `Ticket '${item.name}' completed in ${ticketRecord.durationMs}ms`);
				this._notifyRunChanged(run);
			}
			state.output = { executedCount: ticketImports.length, tickets: state.executedTickets };
			return;
		}

		// 5. General Diagram Node Execution
		await new Promise(r => setTimeout(r, 500));
		state.output = { message: `Node '${node.label}' successfully executed` };
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

				const condResult = this._evaluateCondition(rawLabel, run.contextVariables, run.nodeStates[currentNode.id]);
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
		nodeState?: IWorkflowNodeExecutionState
	): boolean | null {
		const raw = expr.trim();
		if (!raw) return null;

		// 1. Check standard boolean and status keywords
		const lower = raw.toLowerCase();
		if (lower === 'true' || lower === 'yes' || lower === 'success' || lower === 'pass' || lower === '通过' || lower === '是') {
			return true;
		}
		if (lower === 'false' || lower === 'no' || lower === 'fail' || lower === 'reject' || lower === '拒绝' || lower === '否') {
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
		} catch { }

		return null;
	}

	private _evaluateExpressionOrLiteral(expr: string, context: Record<string, any>): any {
		const evaluator = new PythonExpressionEvaluator(expr, context);
		return evaluator.evaluate();
	}

	private _resolveValue(token: string, context: Record<string, any>): any {
		try {
			const evaluator = new PythonExpressionEvaluator(token, context);
			return evaluator.evaluate();
		} catch {
			return undefined;
		}
	}

	private _getNodeVars(node: IFlowchartNode): { name: string; initialValue?: string; expression?: string; currentValue?: any }[] {
		if (Array.isArray(node.outputVariables) && node.outputVariables.length > 0) {
			return node.outputVariables;
		}
		if (node.outputVariable && node.outputVariable.name) {
			return [node.outputVariable];
		}
		return [];
	}

	private _findEntryNode(data: IFlowchartData, entryNodeId?: string): IFlowchartNode | undefined {
		if (entryNodeId) {
			const node = data.nodes.find(n => n.id === entryNodeId);
			if (node) return node;
		}

		// 1. Look for circle Start node
		const startCircle = data.nodes.find(n =>
			n.type === 'circle' && (n.label.toLowerCase() === 'start' || n.label === '开始')
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
		return (node.type === 'circle' && (label === 'end' || label === 'stop' || label === 'exit' || label === 'finish' || label === '结束' || label === '退出')) ||
			label === 'end' || label === 'stop' || label === 'finish' || label === 'exit' || label === 'quit' || label === '结束' || label === '退出';
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
