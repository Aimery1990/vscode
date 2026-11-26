/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
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
	data?: unknown;
}

export interface IPrimitiveExecutionStepResult {
	fieldId: string;
	fieldLabel: string;
	fieldType: string;
	output?: unknown;
	status: 'success' | 'skipped' | 'failed';
	durationMs: number;
	error?: string;
	details?: Record<string, unknown>;
}

export interface IExecutedTicketRecord {
	ticketId: string;
	ticketName: string;
	ticketType?: string;
	agentName?: string;
	/** `running` marks an in-flight record shown in the live run view; it is replaced once the ticket finishes. */
	status: 'success' | 'failed' | 'running';
	output?: unknown;
	outputSpecs?: unknown[];
	stepResults?: IPrimitiveExecutionStepResult[];
	contextVariables?: Record<string, unknown>;
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
	input?: unknown;
	output?: unknown;
	error?: string;
	failedStepIndex?: number;
	failedStepId?: string;
	failedStepError?: string;
	failedStage?: string;
	executedTickets: IExecutedTicketRecord[];
	waitingHumanPrompt?: IWorkflowHumanPrompt;
}

export interface IWorkflowNodeOperation {
	type: 'create_ticket' | 'run_ticket' | 'set_variable' | 'call_function' | 'display' | 'general';
	label: string;
	details?: Record<string, unknown>;
	executedTicket?: IExecutedTicketRecord;
	durationMs?: number;
}

export interface IWorkflowStepTransition {
	fromNodeId: string;
	fromNodeLabel: string;
	toNodeId?: string;
	toNodeLabel?: string;
	conditionLabel?: string;
	conditionEvaluation?: boolean;
	explanation?: string;
}

export interface IWorkflowPathStep {
	stepIndex: number;
	nodeId: string;
	nodeLabel: string;
	nodeType: string;
	startedAt: number;
	completedAt?: number;
	durationMs?: number;
	status: 'success' | 'failed' | 'running';
	error?: string;
	operations: IWorkflowNodeOperation[];
	transition?: IWorkflowStepTransition;
}

export interface IWorkflowInputParamDef {
	name: string;
	label: string;
	defaultValue: string;
	options?: string[];
	description?: string;
	componentId: string;
	componentLabel: string;
}

export interface IWorkflowOutputDef {
	label: string;
	fieldKey: string;
	varName: string;
	defaultFormat: 'json' | 'table' | 'markdown' | 'text' | string;
	sourceExpression?: string;
	isCustom?: boolean;
	componentId: string;
	componentLabel: string;
}

export const SUB_WORKFLOWS_STORAGE_KEY = 'anyagent.subWorkflows.library';

export interface ISubWorkflowDefinition {
	id: string;
	name: string;
	namespace?: string;
	description?: string;
	sourceWorkflowUri?: string;
	sourceWorkflowName?: string;
	nodeIds: string[];
	nodes: unknown[];
	links: unknown[];
	inputs: IWorkflowInputParamDef[];
	outputs: IWorkflowOutputDef[];
	isHiddenInSource?: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface IWorkflowIOContract {
	isValid: boolean;
	inputNodeId?: string;
	inputNodeLabel?: string;
	inputError?: string;
	inputs: IWorkflowInputParamDef[];
	outputNodeId?: string;
	outputNodeLabel?: string;
	outputError?: string;
	outputs: IWorkflowOutputDef[];
	errors: string[];
}

export interface IWorkflowExecutionRun {
	runId: string;
	runNumber?: number;
	workflowUri: string;
	workflowName: string;
	status: WorkflowRunStatus;
	mode: 'standard' | 'daemon' | 'step';
	fullSpeed?: boolean;
	trigger?: 'manual' | 'schedule' | 'api' | 'button';
	currentNodeId?: string;
	visitedNodeIds: string[];
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
	durationMs?: number;
	contextVariables: Record<string, unknown>;
	nodeStates: Record<string, IWorkflowNodeExecutionState>;
	linkStates?: Record<string, IWorkflowLinkExecutionState>;
	executionPath?: IWorkflowPathStep[];
	ioContract?: IWorkflowIOContract;
	workflowOutputs?: Record<string, unknown>;
	workflowOutputsByVarName?: Record<string, unknown>;
	isSubWorkflowRun?: boolean;
	subWorkflowNamespace?: string;
	/** Sub-Workflow runs only: the Sub-Workflow library id this run executes. */
	subWorkflowId?: string;
	/** Sub-Workflow runs only: the run that invoked this Sub-Workflow. */
	parentRunId?: string;
	/** Sub-Workflow runs only: workflow URI of the invoking run. */
	parentWorkflowUri?: string;
	/** Sub-Workflow runs only: id / label of the invoking (caller) node in the parent workflow. */
	callerNodeId?: string;
	callerNodeLabel?: string;
	logs: IWorkflowLogEntry[];
	error?: string;
}

export type WorkflowLinkStatus = 'passed' | 'rejected' | 'error';

export interface IWorkflowLinkExecutionState {
	linkId?: string;
	fromNodeId: string;
	toNodeId: string;
	status: WorkflowLinkStatus;
	conditionLabel?: string;
	evaluationResult?: boolean;
	error?: string;
	explanation?: string;
}

export interface IWorkflowEngineOptions {
	mode?: 'standard' | 'daemon' | 'step';
	fullSpeed?: boolean;
	initialInputs?: Record<string, unknown>;
	initialData?: unknown;
	entryNodeId?: string;
	selectedNodeIds?: string[];
	daemonIntervalMs?: number;
	maxSteps?: number;
}

/**
 * A loosely-shaped JSON-like object (parsed JSON / YAML, workflow variables, tool arguments, ...).
 * Values are `unknown` and must be narrowed before use.
 */
export type IWorkflowRecord = Record<string, unknown>;

/**
 * `typeof value === 'object' && value !== null` as a type guard. Arrays are objects too, exactly
 * as with the plain `typeof` check, so callers that must exclude arrays still have to check that.
 */
export function isWorkflowRecord(value: unknown): value is IWorkflowRecord {
	return typeof value === 'object' && value !== null;
}

/**
 * Same semantics as `key in obj` (own or inherited property), usable as a type guard.
 */
export function hasWorkflowProperty<K extends PropertyKey>(obj: object, key: K): obj is Record<K, unknown> {
	return key in obj;
}
