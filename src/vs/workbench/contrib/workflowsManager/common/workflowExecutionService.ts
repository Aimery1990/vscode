/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkflowEngineOptions, IWorkflowExecutionRun, IWorkflowLogEntry } from './workflowExecutionModel.js';

export const IWorkflowExecutionService = createDecorator<IWorkflowExecutionService>('workflowExecutionService');

export interface IWorkflowExecutionService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeRunState: Event<IWorkflowExecutionRun>;
	readonly onDidEmitLog: Event<{ runId: string; log: IWorkflowLogEntry }>;

	executeWorkflow(workflowUri: URI | string, options?: IWorkflowEngineOptions): Promise<IWorkflowExecutionRun>;
	stepWorkflow(workflowUri: URI | string, runId?: string): Promise<IWorkflowExecutionRun>;
	pauseWorkflow(runId: string): Promise<void>;
	resumeWorkflow(runId: string, userInput?: any): Promise<void>;
	stopWorkflow(runId: string): Promise<void>;

	getActiveRun(workflowUri: URI | string): IWorkflowExecutionRun | undefined;
	getRun(runId: string): IWorkflowExecutionRun | undefined;
	getRunsForWorkflow(workflowUri: URI | string): IWorkflowExecutionRun[];
	clearRuns(workflowUri?: URI | string): void;
}
