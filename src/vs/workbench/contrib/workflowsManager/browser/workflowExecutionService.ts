/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEntityPersistenceService } from '../../entityPersistence/common/entityPersistence.js';
import { IWorkflowExecutionService } from '../common/workflowExecutionService.js';
import {
	IWorkflowEngineOptions,
	IWorkflowExecutionRun,
	IWorkflowLogEntry,
	IWorkflowNodeExecutionState,
	WorkflowNodeStatus
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
}

interface IFlowchartLink {
	id: string;
	from: string;
	to: string;
	label?: string;
	style?: string;
	routing?: string;
	color?: string;
}

interface IFlowchartData {
	nodes: IFlowchartNode[];
	links: IFlowchartLink[];
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

		const flowchartData = this._loadFlowchartData(uriStr);
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

		// Initialize all node states to pending
		for (const node of flowchartData.nodes) {
			run.nodeStates[node.id] = {
				nodeId: node.id,
				nodeLabel: node.label,
				nodeType: node.type,
				status: 'pending',
				executedTickets: []
			};
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

	async stepWorkflow(workflowUri: URI | string, runId?: string): Promise<IWorkflowExecutionRun> {
		const uriStr = typeof workflowUri === 'string' ? workflowUri : workflowUri.toString();
		let targetRun = runId ? this._runs.get(runId) : this.getActiveRun(uriStr);

		if (!targetRun || targetRun.status === 'completed' || targetRun.status === 'failed' || targetRun.status === 'stopped') {
			targetRun = await this.executeWorkflow(uriStr, { mode: 'step' });
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
			let currentNode = this._findEntryNode(data, options?.entryNodeId);
			if (!currentNode) {
				throw new Error('No valid start node found in workflow.');
			}

			let stepCount = 0;
			const maxSteps = options?.maxSteps || 500;

			while (currentNode && !this._cancelledRuns.has(run.runId)) {
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

				run.currentNodeId = currentNode.id;
				if (!run.visitedNodeIds.includes(currentNode.id)) {
					run.visitedNodeIds.push(currentNode.id);
				}

				const nodeState = run.nodeStates[currentNode.id] || {
					nodeId: currentNode.id,
					nodeLabel: currentNode.label,
					nodeType: currentNode.type,
					status: 'pending',
					executedTickets: []
				};
				nodeState.status = 'running';
				nodeState.startedAt = Date.now();
				this._notifyRunChanged(run);

				this._emitLog(run, 'info', `Executing node: '${currentNode.label}' (${currentNode.type})`, { nodeId: currentNode.id });

				// Execute node logic (Agent / Tickets / Decision / Human / Sub-workflow)
				try {
					await this._executeNode(run, currentNode, nodeState);
					nodeState.status = 'success';
					nodeState.completedAt = Date.now();
					nodeState.durationMs = nodeState.completedAt - (nodeState.startedAt || nodeState.completedAt);
					this._emitLog(run, 'info', `Completed node: '${currentNode.label}' in ${nodeState.durationMs}ms`, { nodeId: currentNode.id });
				} catch (err: any) {
					nodeState.status = 'failed';
					nodeState.error = err.message || String(err);
					nodeState.completedAt = Date.now();
					nodeState.durationMs = nodeState.completedAt - (nodeState.startedAt || nodeState.completedAt);
					this._emitLog(run, 'error', `Node '${currentNode.label}' failed: ${nodeState.error}`, { nodeId: currentNode.id });
					throw err;
				} finally {
					this._notifyRunChanged(run);
				}

				// Check if end node
				const isEndNode = this._isEndNode(currentNode);
				if (isEndNode) {
					this._emitLog(run, 'info', `Reached end node: '${currentNode.label}'. Execution branch completed.`);
					break;
				}

				// Step mode pause
				if (run.mode === 'step') {
					run.status = 'paused';
					this._notifyRunChanged(run);
					await new Promise<void>(resolve => {
						this._stepWaiters.set(run.runId, resolve);
					});
				}

				if (this._cancelledRuns.has(run.runId)) {
					break;
				}

				// Find next node via outgoing links
				const nextNode = await this._resolveNextNode(run, currentNode, data);
				if (!nextNode) {
					this._emitLog(run, 'info', `No further outgoing connections from '${currentNode.label}'. Finished graph path.`);
					break;
				}
				currentNode = nextNode;
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

		// 5. General Agent Node Execution
		await new Promise(r => setTimeout(r, 500));
		state.output = { result: `Node '${node.label}' successfully executed` };
	}

	private async _resolveNextNode(
		run: IWorkflowExecutionRun,
		currentNode: IFlowchartNode,
		data: IFlowchartData
	): Promise<IFlowchartNode | undefined> {
		const outgoingLinks = data.links.filter(l => l.from === currentNode.id);
		if (outgoingLinks.length === 0) {
			return undefined;
		}

		if (outgoingLinks.length === 1) {
			const targetId = outgoingLinks[0].to;
			return data.nodes.find(n => n.id === targetId);
		}

		// Decision Branching (Diamond or multiple branches)
		if (currentNode.type === 'diamond' || outgoingLinks.length > 1) {
			this._emitLog(run, 'info', `Evaluating ${outgoingLinks.length} decision branch(es) from '${currentNode.label}'`);

			// Evaluate links in order
			for (const link of outgoingLinks) {
				const label = (link.label || '').trim().toLowerCase();
				if (!label) continue;

				// 1. Simple expression matching
				if (label === 'yes' || label === 'true' || label === 'success' || label === 'pass' || label === '通过' || label === '是') {
					const target = data.nodes.find(n => n.id === link.to);
					if (target) {
						this._emitLog(run, 'info', `Branch matched: '${link.label}' -> navigating to '${target.label}'`);
						return target;
					}
				}
			}

			// Fallback to first available target branch
			const defaultLink = outgoingLinks[0];
			const fallbackTarget = data.nodes.find(n => n.id === defaultLink.to);
			this._emitLog(run, 'info', `Default branch taken: -> navigating to '${fallbackTarget?.label || defaultLink.to}'`);
			return fallbackTarget;
		}

		return undefined;
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
		const label = node.label.toLowerCase();
		return (node.type === 'circle' && (label === 'end' || label === 'stop' || label === '结束')) ||
			label === 'end' || label === 'stop' || label === 'finish' || label === '结束';
	}

	private _loadFlowchartData(uriStr: string): IFlowchartData | undefined {
		const snapshot = this.entityPersistenceService.getSnapshot(uriStr);
		if (snapshot?.customMetadata?.['flowchartJson']) {
			try {
				return JSON.parse(snapshot.customMetadata['flowchartJson']);
			} catch (e) {
				this.logService.error('[WorkflowExecution] Failed to parse flowchartJson:', e);
			}
		}
		return undefined;
	}

	private _resolveWorkflowName(uriStr: string): string {
		const snapshot = this.entityPersistenceService.getSnapshot(uriStr);
		if (snapshot?.name) {
			return snapshot.name;
		}
		try {
			const uri = URI.parse(uriStr);
			const base = uri.path.split('/').filter(Boolean).pop() || 'Workflow';
			return base.replace(/\.workflow$/, '');
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
