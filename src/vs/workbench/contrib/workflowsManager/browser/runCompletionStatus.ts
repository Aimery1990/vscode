/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ICustomModule } from '../../entityPersistence/common/entityPersistence.js';
import { ICustomModulesService } from '../../customModules/common/customModules.js';
import { IWorkspacesExplorerService, IWorkspaceStatusesInfo } from '../../workspacesExplorer/common/workspacesExplorer.js';
import { findTemplateForType } from '../../workspacesExplorer/common/ticketStatusPicker.js';
import { readTicketStatus, readTopLevelMetadata } from '../../workspacesExplorer/common/workspaceLifecycle.js';
import { readTicketFileResolvedIfExists } from '../../workspacesExplorer/browser/ticketFieldFiles.js';
import { TicketWorklogStorage } from '../../workspacesExplorer/browser/ticketWorklogStorage.js';
import { parseTicketChangeRecords, TICKET_CHANGE_RECORDS_HEADING } from '../../workspacesExplorer/common/ticketChangeLog.js';
import { decideStatusAfterRun, FAILED_RUN_STATUS_SETTING_KEY, hasStatusChangeSince, RUN_STATUS_SETTING_KEY, RunOutcome, RunStatusDecision } from '../common/runCompletionStatus.js';

/**
 * Status after a successful run (CI-58), the reading / writing side. The decision itself is the pure
 * `decideStatusAfterRun` (common/runCompletionStatus.ts).
 */

export interface IRunCompletionStatusDeps {
	readonly fileService: IFileService;
	readonly workspacesExplorerService: IWorkspacesExplorerService;
	readonly customModulesService: ICustomModulesService;
	readonly logService: ILogService;
}

/** The ticket folder's ticket.md text (`.agents/ticket.md`, else `ticket.md`), or undefined. */
async function readTicketMd(fileService: IFileService, ticketFolder: URI): Promise<string | undefined> {
	for (const uri of [URI.joinPath(ticketFolder, '.agents', 'ticket.md'), URI.joinPath(ticketFolder, 'ticket.md')]) {
		try {
			const text = await readTicketFileResolvedIfExists(fileService, uri);
			if (text !== undefined) {
				return text;
			}
		} catch {
			// try the next location
		}
	}
	return undefined;
}

async function workspaceLifecycleOf(deps: IRunCompletionStatusDeps, ticketFolder: URI): Promise<IWorkspaceStatusesInfo | undefined> {
	try {
		return await deps.workspacesExplorerService.getWorkspaceStatuses(ticketFolder);
	} catch {
		return undefined;
	}
}

async function templateOfType(deps: IRunCompletionStatusDeps, ticketFolder: URI, ticketType: string | undefined): Promise<ICustomModule | undefined> {
	if (!ticketType) {
		return undefined;
	}
	try {
		let wsRoot: URI | undefined;
		try {
			wsRoot = await deps.workspacesExplorerService.findWorkspaceRootUri(ticketFolder);
		} catch {
			wsRoot = undefined;
		}
		return findTemplateForType(await deps.customModulesService.getCustomModules(wsRoot), ticketType);
	} catch {
		return undefined;
	}
}

/** Whether the ticket's change log (CI-50) holds a status change from `sinceEpochMs` on (newest few entries only). */
async function statusChangedSince(fileService: IFileService, ticketFolder: URI, sinceEpochMs: number): Promise<boolean> {
	try {
		const storage = new TicketWorklogStorage(fileService);
		let read = 0;
		for (const meta of await storage.listWorklogMetas(ticketFolder)) {
			const entry = await storage.readWorklogEntry(ticketFolder, meta);
			if (!entry.fullContent.includes(TICKET_CHANGE_RECORDS_HEADING)) {
				continue;
			}
			if (hasStatusChangeSince(parseTicketChangeRecords(entry.fullContent), sinceEpochMs)) {
				return true;
			}
			if (++read >= 3) {
				break;
			}
		}
	} catch {
		// no readable change log: nothing was recorded during the run
	}
	return false;
}

/**
 * Decides the status a whole-ticket run leaves on its ticket. `schema` is the template / Freestyle structure the run
 * used (holds the setting and the template statuses); `statusAtStart` the status when the run began (a different
 * status now means something set it during the run); `explicitStatus` a status a step set (Button Group decision).
 */
export async function decideTicketRunStatus(deps: IRunCompletionStatusDeps, args: {
	readonly ticketFolder: URI;
	readonly schema: ICustomModule | undefined;
	readonly outcome: RunOutcome;
	readonly statusAtStart: string | undefined;
	readonly explicitStatus?: string;
}): Promise<RunStatusDecision & { readonly currentStatus?: string }> {
	const text = await readTicketMd(deps.fileService, args.ticketFolder);
	const currentStatus = text !== undefined ? readTicketStatus(text) : undefined;
	const changed = !!args.statusAtStart && !!currentStatus && args.statusAtStart.trim().toLowerCase() !== currentStatus.trim().toLowerCase();
	const decision = decideStatusAfterRun({
		outcome: args.outcome,
		setting: args.schema?.statusOnSuccessfulRun,
		failureSetting: args.schema?.statusOnFailedRun,
		explicitStatus: args.explicitStatus,
		statusChangedDuringRun: changed,
		currentStatus,
		templateStatuses: args.schema?.statuses,
		lifecycle: args.outcome === 'stopped' ? undefined : await workspaceLifecycleOf(deps, args.ticketFolder)
	});
	return { ...decision, currentStatus };
}

/**
 * The two settings of a workflow: `statusOnSuccessfulRun` / `statusOnFailedRun` of its `workflow_flowchart.json` when
 * present (any value; an empty one means the default), else the workflow template's setting (unset: the default).
 */
async function workflowSettings(fileService: IFileService, workflowFolder: URI, template: ICustomModule | undefined): Promise<{ success: unknown; failure: unknown }> {
	let raw: Record<string, unknown> | undefined;
	try {
		const parsed = JSON.parse((await fileService.readFile(URI.joinPath(workflowFolder, '.agents', 'workflow_flowchart.json'))).value.toString());
		raw = parsed && typeof parsed === 'object' ? parsed : undefined;
	} catch {
		// no flowchart file: the template decides
	}
	const pick = (key: string, fallback: unknown) => raw && Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : fallback;
	return { success: pick(RUN_STATUS_SETTING_KEY, template?.statusOnSuccessfulRun), failure: pick(FAILED_RUN_STATUS_SETTING_KEY, template?.statusOnFailedRun) };
}

/**
 * At the end of a workflow run: moves the workflow ticket to its "on successful run" status (Done by default) or "on
 * failed run" status (Blocked by default) through the normal status writer, recorded as the Workflow (CI-50). A
 * stopped run changes nothing; a status set during the run (from `startedAt` on) wins. Never throws; returns a
 * one-line description for the run log.
 */
export async function applyStatusAfterWorkflowRun(deps: IRunCompletionStatusDeps, workflowUri: string | URI, workflowName: string, startedAt: number, outcome: RunOutcome): Promise<string> {
	if (outcome === 'stopped') {
		return 'Status after run: not changed (the run was stopped).';
	}
	try {
		const folder = typeof workflowUri === 'string' ? URI.parse(workflowUri) : workflowUri;
		const text = await readTicketMd(deps.fileService, folder);
		if (text === undefined) {
			return 'Status after run: no ticket.md for this workflow, status not changed.';
		}
		const template = await templateOfType(deps, folder, readTopLevelMetadata(text, 'Ticket Type') || 'workflow');
		const settings = await workflowSettings(deps.fileService, folder, template);
		const decision = decideStatusAfterRun({
			outcome,
			setting: settings.success,
			failureSetting: settings.failure,
			statusChangedDuringRun: await statusChangedSince(deps.fileService, folder, startedAt),
			currentStatus: readTicketStatus(text),
			templateStatuses: template?.statuses,
			lifecycle: await workspaceLifecycleOf(deps, folder)
		});
		if (decision.action === 'keep') {
			return `Status after run: not changed (${decision.reason}).`;
		}
		await deps.workspacesExplorerService.setEntityStatus(folder, decision.status, { kind: 'Workflow', name: workflowName || 'Workflow Run' });
		return `Status after run: set to '${decision.status}' (${decision.reason}).`;
	} catch (err) {
		deps.logService.warn('[RunCompletionStatus] Failed to set the status after the workflow run:', err);
		return `Status after run: not changed (error: ${err?.message || String(err)}).`;
	}
}
