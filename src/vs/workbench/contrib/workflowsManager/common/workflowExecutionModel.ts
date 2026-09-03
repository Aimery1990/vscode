/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type WorkflowRunStatus =
	| 'idle'
	| 'running'
	| 'paused'
	| 'waiting_human'
	| 'completed'
	| 'failed'
	| 'stopped';

export type WorkflowNodeStatus =
	| 'pending'
	| 'running'
	| 'waiting_human'
	| 'success'
	| 'failed'
	| 'skipped';

export interface IWorkflowLogEntry {
	id: string;
	timestamp: number;
	level: 'info' | 'warn' | 'error' | 'debug';
	nodeId?: string;
	ticketId?: string;
	message: string;
	data?: any;
}

export interface IExecutedTicketRecord {
	ticketId: string;
	ticketName: string;
	ticketType?: string;
	agentName?: string;
	status: 'success' | 'failed';
	output?: any;
	durationMs?: number;
}

export interface IWorkflowHumanPrompt {
	nodeId: string;
	prompt: string;
	options?: string[];
	defaultOption?: string;
	schema?: Record<string, 'string' | 'number' | 'boolean' | 'options'>;
}

export interface IWorkflowNodeExecutionState {
	nodeId: string;
	nodeLabel: string;
	nodeType?: string;
	status: WorkflowNodeStatus;
	startedAt?: number;
	completedAt?: number;
	durationMs?: number;
	input?: any;
	output?: any;
	error?: string;
	executedTickets: IExecutedTicketRecord[];
	waitingHumanPrompt?: IWorkflowHumanPrompt;
}

export interface IWorkflowExecutionRun {
	runId: string;
	workflowUri: string;
	workflowName: string;
	status: WorkflowRunStatus;
	mode: 'standard' | 'daemon' | 'step';
	currentNodeId?: string;
	visitedNodeIds: string[];
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
	contextVariables: Record<string, any>;
	nodeStates: Record<string, IWorkflowNodeExecutionState>;
	logs: IWorkflowLogEntry[];
	error?: string;
}

export interface IWorkflowEngineOptions {
	mode?: 'standard' | 'daemon' | 'step';
	initialInputs?: Record<string, any>;
	initialData?: any;
	entryNodeId?: string;
	daemonIntervalMs?: number;
	maxSteps?: number;
}
