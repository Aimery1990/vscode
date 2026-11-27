/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ISubWorkflowDefinition, IWorkflowEngineOptions, IWorkflowExecutionRun, IWorkflowIOContract, IWorkflowLogEntry } from './workflowExecutionModel.js';
import { ISubWorkflowCallChain, SubWorkflowCallGraphRoot } from './subWorkflowCallGraph.js';

export const IWorkflowExecutionService = createDecorator<IWorkflowExecutionService>('workflowExecutionService');

export interface IWorkflowDisplayOutputItem {
	label: string;
	format?: string;
	content: string;
	status?: 'ready' | 'pending' | 'empty';
}

export interface ITicketHandleInfo {
	ticketId: string;
	ticketName: string;
	ticketType: string;
	title?: string;
	status?: string;
	createdAt?: string;
	targetFolder?: string;
	parameters?: Record<string, unknown>;
	isCreated?: boolean;
}

export interface IWorkflowDisplayCard {
	id: string;
	workflowUri?: string;
	runId?: string;
	nodeId: string;
	nodeTitle: string;
	expression: string;
	value: unknown;
	formattedText: string;
	timestamp: string;
	ticketTitle?: string;
	ticketId?: string;
	ticketType?: string;
	outputItems?: IWorkflowDisplayOutputItem[];
	ticketHandle?: ITicketHandleInfo;
	isTruncated?: boolean;
	displayPreviewText?: string;
	totalCount?: number;
}

export interface INotebookCellExecutionResult {
	ok: boolean;
	value?: unknown;
	stdout?: string;
	error?: string;
	variables: Record<string, unknown>;
	displayCards: IWorkflowDisplayCard[];
	durationMs: number;
	executionCount: number;
}

/** A Call Sub-Workflow made outside a workflow node, e.g. by a ticket's Call Sub-Workflow card (CI-38). */
export interface ISubWorkflowInvocationRequest {
	/** Sub-Workflow ticket ID or legacy `subwf_...` id. */
	reference: string;
	/** Input bindings {inputName: value or {var}}, resolved against `variables`. */
	inputBindings?: Record<string, string>;
	variables: Record<string, unknown>;
	/** Where to search the Sub-Workflow ticket on disk (e.g. the ticket folder). */
	contextUri?: string;
	/** Name of the caller for logs (e.g. the card label). */
	callerLabel?: string;
	/** The chain of the run that started the caller, when it runs inside a workflow / Sub-Workflow run. */
	callChain?: ISubWorkflowCallChain;
}

export interface ISubWorkflowInvocationResult {
	success: boolean;
	subWorkflowId?: string;
	subWorkflowName?: string;
	resolvedInputs?: Record<string, unknown>;
	/** The single output value, a dict of several outputs, or null. */
	output?: unknown;
	durationMs: number;
	error?: string;
	/** Set when a recursion / depth guard stopped the call: the whole calling run must stop too. */
	callChainError?: string;
}

export interface IWorkflowExecutionService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeRunState: Event<IWorkflowExecutionRun>;
	readonly onDidEmitLog: Event<{ runId: string; log: IWorkflowLogEntry }>;
	readonly onDidDisplayVariable: Event<IWorkflowDisplayCard>;
	readonly onDidUpdateNodeComponents: Event<{ workflowUri: string; nodeId: string; node: { pipeline?: unknown } }>;
	readonly onDidChangeSubWorkflows: Event<void>;
	/** Fires whenever a running Sub-Workflow run changes (start, node progress, completion / failure). */
	readonly onDidChangeSubWorkflowRun: Event<IWorkflowExecutionRun>;

	executeWorkflow(workflowUri: URI | string, options?: IWorkflowEngineOptions): Promise<IWorkflowExecutionRun>;
	resolveWorkflowIOContract(data: unknown): IWorkflowIOContract;
	getWorkflowIOContract(workflowUri: URI | string): Promise<IWorkflowIOContract>;
	/** All known Sub-Workflows: Sub-Workflow tickets (CI-23) plus legacy definitions that could not be migrated. */
	getSubWorkflows(): ISubWorkflowDefinition[];
	/** By ticket ID, or by the legacy `subwf_...` id of a migrated Sub-Workflow. */
	getSubWorkflowById(id: string): ISubWorkflowDefinition | undefined;
	/** Resolves once the Sub-Workflow tickets are loaded (and legacy definitions migrated). Never rejects. */
	whenSubWorkflowsReady(): Promise<void>;
	/**
	 * Resolves a Call Sub-Workflow reference (ticket ID or legacy id): the loaded Sub-Workflows first, then the ticket
	 * with that ID on disk (searched from `contextUri`, e.g. the calling workflow), when it is a `sub_workflow` ticket.
	 * A ticket-backed Sub-Workflow is re-read from its definition file, so callers always get the latest saved version.
	 */
	resolveSubWorkflow(reference: string, contextUri?: string): Promise<ISubWorkflowDefinition | undefined>;
	/**
	 * Encapsulation: creates the Sub-Workflow ticket for `draft` inside its source workflow folder (normal ticket
	 * numbering) and stores the definition in the ticket folder, through the same createResourceUnderWorkspace path that
	 * programs and AI use. Returns the definition with its ticket ID as `id`.
	 */
	createSubWorkflowTicket(draft: ISubWorkflowDefinition): Promise<ISubWorkflowDefinition>;
	/**
	 * Runs a Sub-Workflow for a caller that is not a workflow node (a ticket's Call Sub-Workflow card), through the
	 * same execution path as the node step, including the recursion / depth guard. Never rejects.
	 */
	invokeSubWorkflow(request: ISubWorkflowInvocationRequest): Promise<ISubWorkflowInvocationResult>;
	/**
	 * Up-front recursion check (CI-38): walks who calls whom from `root` (workflow nodes, Sub-Workflow definitions,
	 * template Call Sub-Workflow cards, run-ticket steps whose template is known) and returns an error naming the
	 * first cycle (e.g. `A -> B -> A`), or `undefined`. `workspaceUri` is used to find templates.
	 */
	checkSubWorkflowCallCycle(root: SubWorkflowCallGraphRoot, contextUri?: string, workspaceUri?: URI): Promise<string | undefined>;
	getLatestSubWorkflowRun(subWorkflowId: string): IWorkflowExecutionRun | undefined;
	/** The currently executing run of this Sub-Workflow if any, otherwise its latest finished snapshot. */
	getActiveSubWorkflowRun(subWorkflowId: string): IWorkflowExecutionRun | undefined;
	saveSubWorkflow(def: ISubWorkflowDefinition): void;
	/**
	 * Loads the Sub-Workflow ticket in `folderUri` (its latest saved definition) and keeps it in the known list; used by
	 * the Sub-Workflow's own canvas. `undefined` when the folder has no valid definition file.
	 */
	loadSubWorkflowTicket(folderUri: URI): Promise<ISubWorkflowDefinition | undefined>;
	/**
	 * Saves the Sub-Workflow's own canvas as its definition: nodes and links, and the inputs / outputs contract derived
	 * from them. Writes `.agents/sub_workflow.json` and the ticket.md summary; every caller runs this version from now on.
	 * Returns the saved definition, or `undefined` for an unknown (or not ticket-backed) Sub-Workflow.
	 */
	saveSubWorkflowCanvas(subWorkflowId: string, canvas: { nodes: unknown[]; links: unknown[] }): ISubWorkflowDefinition | undefined;
	/**
	 * Runs the one-time migration of legacy (profile-storage) Sub-Workflows to tickets now, at startup. Idempotent;
	 * failed migrations are retried later. Never rejects.
	 */
	migrateLegacySubWorkflows(): Promise<void>;
	deleteSubWorkflow(id: string): void;
	/**
	 * Registers an open Workflow Editor as the exclusive writer of `<workflow>/.agents/workflow_flowchart.json`.
	 * While registered, the execution service never writes that file itself (prevents read-modify-write races that
	 * revert the user's latest edits); it only fires `onDidUpdateNodeComponents` and lets the editor merge & save.
	 */
	registerFlowchartOwner(workflowUri: URI | string): { dispose(): void };
	stepWorkflow(workflowUri: URI | string, options?: IWorkflowEngineOptions, runId?: string): Promise<IWorkflowExecutionRun>;
	pauseWorkflow(runId: string): Promise<void>;
	resumeWorkflow(runId: string, userInput?: unknown): Promise<void>;
	stopWorkflow(runId: string): Promise<void>;

	getActiveRun(workflowUri: URI | string): IWorkflowExecutionRun | undefined;
	getRun(runId: string): IWorkflowExecutionRun | undefined;
	getRunsForWorkflow(workflowUri: URI | string): IWorkflowExecutionRun[];
	loadRunsForWorkflow(workflowUri: URI | string): Promise<IWorkflowExecutionRun[]>;
	persistRunsForWorkflow(workflowUri: URI | string): Promise<void>;
	/**
	 * Returns a shallow copy of `vars` in which every large-variable reference (`__anyagentVarRef__`, values > 16 KB
	 * spilled to `<workflow>/.agents/workflow_vars/`) is replaced by its real value. `vars` itself is not modified.
	 */
	hydrateContextVariables(workflowUri: URI | string, vars: Record<string, unknown>): Promise<Record<string, unknown>>;
	deleteRun(runId: string): void;
	clearRuns(workflowUri?: URI | string): void;
	resetWorkflow(workflowUri: URI | string): void;
	resetNodes(workflowUri: URI | string, nodeIds: string[], variableNamesToClear?: string[]): void;

	getDisplayCards(workflowUri: URI | string): IWorkflowDisplayCard[];
	clearDisplayCards(workflowUri: URI | string): void;
	removeDisplayCard(workflowUri: URI | string, cardId: string): void;

	executeNotebookCell(
		workflowUri: URI | string,
		code: string,
		options?: { nodeId?: string; nodeLabel?: string; pythonPath?: string; mode?: 'exec' | 'eval' }
	): Promise<INotebookCellExecutionResult>;
	restartNotebookKernel(workflowUri: URI | string): Promise<void>;
}
