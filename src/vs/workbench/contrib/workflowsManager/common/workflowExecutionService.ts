/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ISubWorkflowDefinition, IWorkflowEngineOptions, IWorkflowExecutionRun, IWorkflowIOContract, IWorkflowLogEntry } from './workflowExecutionModel.js';

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
	parameters?: Record<string, any>;
	isCreated?: boolean;
}

export interface IWorkflowDisplayCard {
	id: string;
	workflowUri?: string;
	runId?: string;
	nodeId: string;
	nodeTitle: string;
	expression: string;
	value: any;
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
	value?: any;
	stdout?: string;
	error?: string;
	variables: Record<string, any>;
	displayCards: IWorkflowDisplayCard[];
	durationMs: number;
	executionCount: number;
}

export interface IWorkflowExecutionService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeRunState: Event<IWorkflowExecutionRun>;
	readonly onDidEmitLog: Event<{ runId: string; log: IWorkflowLogEntry }>;
	readonly onDidDisplayVariable: Event<IWorkflowDisplayCard>;
	readonly onDidUpdateNodeComponents: Event<{ workflowUri: string; nodeId: string; node: any }>;
	readonly onDidChangeSubWorkflows: Event<void>;
	/** Fires whenever a running Sub-Workflow run changes (start, node progress, completion / failure). */
	readonly onDidChangeSubWorkflowRun: Event<IWorkflowExecutionRun>;

	executeWorkflow(workflowUri: URI | string, options?: IWorkflowEngineOptions): Promise<IWorkflowExecutionRun>;
	resolveWorkflowIOContract(data: any): IWorkflowIOContract;
	getWorkflowIOContract(workflowUri: URI | string): Promise<IWorkflowIOContract>;
	getSubWorkflows(): ISubWorkflowDefinition[];
	getSubWorkflowById(id: string): ISubWorkflowDefinition | undefined;
	getLatestSubWorkflowRun(subWorkflowId: string): IWorkflowExecutionRun | undefined;
	/** The currently executing run of this Sub-Workflow if any, otherwise its latest finished snapshot. */
	getActiveSubWorkflowRun(subWorkflowId: string): IWorkflowExecutionRun | undefined;
	getLatestSubWorkflowRunForNode(nodeId: string, workflowUri?: URI | string): IWorkflowExecutionRun | undefined;
	saveSubWorkflow(def: ISubWorkflowDefinition): void;
	deleteSubWorkflow(id: string): void;
	/**
	 * Registers an open Workflow Editor as the exclusive writer of `<workflow>/.agents/workflow_flowchart.json`.
	 * While registered, the execution service never writes that file itself (prevents read-modify-write races that
	 * revert the user's latest edits); it only fires `onDidUpdateNodeComponents` and lets the editor merge & save.
	 */
	registerFlowchartOwner(workflowUri: URI | string): { dispose(): void };
	stepWorkflow(workflowUri: URI | string, options?: IWorkflowEngineOptions, runId?: string): Promise<IWorkflowExecutionRun>;
	pauseWorkflow(runId: string): Promise<void>;
	resumeWorkflow(runId: string, userInput?: any): Promise<void>;
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
	hydrateContextVariables(workflowUri: URI | string, vars: Record<string, any>): Promise<Record<string, any>>;
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
