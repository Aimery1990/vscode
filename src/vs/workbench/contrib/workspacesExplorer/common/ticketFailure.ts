/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { CanonicalStatusCategory } from './workspacesExplorer.js';
import { isSubtreeNodeVisible, ITicketSubtreeNode, ITicketSubtreeSummary } from './ticketSubtreeCount.js';

/**
 * Failing tickets in the Workspaces tree (UI-20).
 *
 * A ticket is "failing" when at least one of these holds (data read during the UI-17 sub-tree scan):
 * 1. Last ticket run failed: a ticket run writes its outcome into ticket.md's Status (`Failed` / `Completed`, see
 *    `TicketWorkflowRuntime._persistExecutionState`), so Status `Failed` means the most recent run failed and the next
 *    successful run (Status `Completed`) clears it. The run also writes `.agents/last_run.json`
 *    ({@link ITicketLastRunRecord}) with the time and the failed component, read only to explain the failure.
 * 2. Test result: a custom field whose label is one of {@link TEST_RESULT_FIELD_LABELS} (the Test Case template's
 *    "Result" select) has one of the {@link FAILING_RESULT_VALUES} (case-insensitive).
 * 3. Workflow tickets: the latest run in `.agents/workflow_runs.json` (newest first) has status `failed`.
 *
 * Tickets whose status counts as removed never fail. Done tickets still do (a Done task with a failed test is a problem).
 * Failures propagate to every ancestor regardless of the status filter; failures hidden by the filter are marked so.
 */

/** Labels of the custom fields holding a test result (case-insensitive). */
export const TEST_RESULT_FIELD_LABELS: readonly string[] = ['Result', 'Test Result'];
/** Values of a result field that mean failure (case-insensitive). */
export const FAILING_RESULT_VALUES: readonly string[] = ['fail', 'failed', 'failure'];
/** Ticket statuses written by a failed ticket run (case-insensitive). */
export const FAILED_RUN_STATUSES: readonly string[] = ['failed'];

export const TICKET_LAST_RUN_FILE_NAME = 'last_run.json';
/** How many failing descendants a tooltip names before "…". */
export const FAILING_TOOLTIP_CAP = 5;

/** `.agents/last_run.json`: the outcome of the ticket's most recent run. */
export interface ITicketLastRunRecord {
	readonly status: 'Completed' | 'Failed';
	/** ISO time the run finished. */
	readonly at: string;
	/** Label of the first failed component. */
	readonly failedStep?: string;
	readonly error?: string;
}

/** The latest workflow run, read from the head of workflow_runs.json. */
export interface IWorkflowRunHead {
	readonly status: string;
	readonly runNumber?: number;
	/** Epoch ms (completedAt / updatedAt / startedAt, whichever is found first in that order). */
	readonly at?: number;
}

/** Per ticket input of {@link detectTicketFailure}. */
export interface ITicketFailureInput {
	readonly status?: string;
	readonly removed: boolean;
	/** Value of the first result field found ({@link readTestResultField}). */
	readonly resultField?: { readonly label: string; readonly value: string };
	readonly lastRun?: ITicketLastRunRecord;
	readonly workflowRun?: IWorkflowRunHead;
}

/** Why a ticket fails; `reasons` are short human readable sentences. */
export interface ITicketFailure {
	readonly reasons: readonly string[];
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripQuotes(value: string): string {
	return value.trim().replace(/^[`'"]+|[`'"]+$/g, '').trim();
}

/**
 * The first result field (`  - **Result**: Fail`, an entry of "Self Defined Data Value") of a ticket.md text, or
 * undefined. Only indented entries count, so a top-level line never matches.
 */
export function readTestResultField(ticketMd: string): { label: string; value: string } | undefined {
	for (const label of TEST_RESULT_FIELD_LABELS) {
		const match = ticketMd.match(new RegExp(`^[ \\t]+-\\s+\\*\\*${escapeRegExp(label)}\\*\\*:[ \\t]*([^\\r\\n]*)$`, 'im'));
		if (match) {
			return { label, value: stripQuotes(match[1]) };
		}
	}
	return undefined;
}

export function isFailingResultValue(value: string | undefined): boolean {
	return !!value && FAILING_RESULT_VALUES.includes(stripQuotes(value).toLowerCase());
}

export function isFailedRunStatus(status: string | undefined): boolean {
	return !!status && FAILED_RUN_STATUSES.includes(status.trim().toLowerCase());
}

export function parseTicketLastRunRecord(text: string | undefined): ITicketLastRunRecord | undefined {
	if (!text) {
		return undefined;
	}
	try {
		const raw = JSON.parse(text) as Record<string, unknown>;
		if (!raw || typeof raw !== 'object' || (raw.status !== 'Completed' && raw.status !== 'Failed') || typeof raw.at !== 'string') {
			return undefined;
		}
		return {
			status: raw.status,
			at: raw.at,
			failedStep: typeof raw.failedStep === 'string' && raw.failedStep ? raw.failedStep : undefined,
			error: typeof raw.error === 'string' && raw.error ? raw.error : undefined
		};
	} catch {
		return undefined;
	}
}

export function formatTicketLastRunRecord(record: ITicketLastRunRecord): string {
	return JSON.stringify(record, undefined, '\t') + '\n';
}

/**
 * The record of a finished ticket run from its step results (first failed step names the failure). Written by the
 * ticket runtime BEFORE ticket.md, so the tree's rescan triggered by the ticket.md change already sees it.
 */
export function ticketLastRunRecordFromSteps(steps: readonly { readonly status: string; readonly fieldLabel?: string; readonly error?: string }[] | undefined, at: Date): ITicketLastRunRecord {
	const failed = (steps || []).find(s => s.status === 'failed');
	return failed
		? { status: 'Failed', at: at.toISOString(), failedStep: failed.fieldLabel || undefined, error: failed.error ? truncate(failed.error, 500) : undefined }
		: { status: 'Completed', at: at.toISOString() };
}

/** Writes `<ticket>/.agents/last_run.json`; never throws (the record only explains a failure). */
export async function writeTicketLastRunRecord(fileService: IFileService, ticketFolder: URI, record: ITicketLastRunRecord): Promise<void> {
	try {
		await fileService.writeFile(URI.joinPath(ticketFolder, '.agents', TICKET_LAST_RUN_FILE_NAME), VSBuffer.fromString(formatTicketLastRunRecord(record)));
	} catch {
		// best effort
	}
}

/**
 * The latest run (the first object: runs are saved newest first) from the head of workflow_runs.json. Only the head
 * is read, so the top-level keys written before the large ones (status, runNumber, startedAt, updatedAt) are used.
 */
export function parseWorkflowRunsHead(head: string | undefined): IWorkflowRunHead | undefined {
	if (!head) {
		return undefined;
	}
	const start = head.indexOf('{');
	if (start < 0 || !/^\s*\[/.test(head)) {
		return undefined;
	}
	// top-level keys of the first run only: stop at the first nested object / array
	const body = head.slice(start + 1);
	const nested = body.search(/:\s*[{[]/);
	const top = nested >= 0 ? body.slice(0, nested) : body;
	const status = top.match(/"status"\s*:\s*"([a-z_]+)"/i)?.[1];
	if (!status) {
		return undefined;
	}
	const num = (key: string) => {
		const m = top.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
		return m ? Number(m[1]) : undefined;
	};
	return { status, runNumber: num('runNumber'), at: num('completedAt') ?? num('updatedAt') ?? num('startedAt') };
}

function pad(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** Local `YYYY-MM-DD HH:mm`, or '' for an invalid time. */
export function formatFailureTime(time: string | number | undefined): string {
	if (time === undefined) {
		return '';
	}
	const d = new Date(time);
	if (isNaN(d.getTime())) {
		return '';
	}
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Whether (and why) a ticket fails; undefined when it does not. */
export function detectTicketFailure(input: ITicketFailureInput): ITicketFailure | undefined {
	if (input.removed) {
		return undefined;
	}
	const reasons: string[] = [];
	if (isFailedRunStatus(input.status)) {
		const run = input.lastRun?.status === 'Failed' ? input.lastRun : undefined;
		const when = formatFailureTime(run?.at);
		let reason = when ? `Last run failed ${when}` : 'Last run failed (Status: Failed)';
		if (run?.failedStep) {
			reason += ` — component '${run.failedStep}' failed`;
		}
		if (run?.error) {
			reason += `: ${truncate(run.error, 120)}`;
		}
		reasons.push(reason);
	}
	if (input.workflowRun && input.workflowRun.status.toLowerCase() === 'failed') {
		const when = formatFailureTime(input.workflowRun.at);
		const num = input.workflowRun.runNumber !== undefined ? ` #${input.workflowRun.runNumber}` : '';
		reasons.push(`Last workflow run${num} failed${when ? ` ${when}` : ''}`);
	}
	if (input.resultField && isFailingResultValue(input.resultField.value)) {
		reasons.push(`Test ${input.resultField.label.toLowerCase()}: ${input.resultField.value}`);
	}
	return reasons.length > 0 ? { reasons } : undefined;
}

// --- propagation ---

/** A failing descendant as listed in an ancestor's tooltip. */
export interface IFailingDescendant {
	readonly label: string;
	readonly reasons: readonly string[];
	/** The ticket (or one of its ancestors below the summarized folder) is hidden by the status filter. */
	readonly hiddenByFilter: boolean;
}

export interface IFailingSummary {
	readonly failing: readonly IFailingDescendant[];
}

/**
 * Every failing descendant of a summarized folder, in tree order. Failures propagate regardless of the status filter
 * (flagged `hiddenByFilter`); removed tickets (unless "show removed items" is on) and their sub-trees are skipped,
 * like in the tree.
 */
export function collectFailingDescendants(summary: ITicketSubtreeSummary, hidden: ReadonlySet<CanonicalStatusCategory>, includeRemoved: boolean): IFailingSummary {
	const failing: IFailingDescendant[] = [];
	const visit = (nodes: readonly ITicketSubtreeNode[], hiddenAbove: boolean) => {
		for (const node of nodes) {
			if (node.removed && !includeRemoved) {
				continue;
			}
			const hiddenHere = hiddenAbove || !isSubtreeNodeVisible(node, hidden, includeRemoved);
			if (node.failure) {
				failing.push({ label: node.label || 'Untitled ticket', reasons: node.failure.reasons, hiddenByFilter: hiddenHere });
			}
			visit(node.children, hiddenHere);
		}
	};
	visit(summary.children, false);
	return { failing };
}

/** "N failing below: A, B, …" (at most `cap` names, each with its first reason), or undefined when none fail. */
export function describeFailingBelow(summary: IFailingSummary, cap = FAILING_TOOLTIP_CAP): string | undefined {
	const count = summary.failing.length;
	if (count === 0) {
		return undefined;
	}
	const lines = summary.failing.slice(0, cap).map(f => `• ${f.label}${f.reasons.length ? ` — ${f.reasons[0]}` : ''}${f.hiddenByFilter ? ' (hidden by status filter)' : ''}`);
	if (count > cap) {
		lines.push(`… and ${count - cap} more`);
	}
	return `${count} failing below:\n${lines.join('\n')}`;
}

/** Tooltip of a failing ticket's own marker. */
export function describeTicketFailure(failure: ITicketFailure): string {
	return `Failing:\n${failure.reasons.map(r => `• ${r}`).join('\n')}`;
}

// --- test result indicator (UI-23) ---

/** Values of a result field that mean the test passed (case-insensitive). */
export const PASSING_RESULT_VALUES: readonly string[] = ['pass', 'passed', 'success'];
/** Values of a result field that mean the test is blocked (case-insensitive). */
export const BLOCKED_RESULT_VALUES: readonly string[] = ['blocked'];

/** The single test-result indicator of a test-case ticket (a ticket with a result field). */
export type TestResultState = 'passed' | 'failed' | 'blocked' | 'notRun';

/** Classifies a result field value: Pass / Fail / Blocked; anything else (Not Run, empty, unknown) is not run. */
export function classifyTestResult(value: string | undefined): TestResultState {
	const v = stripQuotes(value || '').toLowerCase();
	if (FAILING_RESULT_VALUES.includes(v)) {
		return 'failed';
	}
	if (PASSING_RESULT_VALUES.includes(v)) {
		return 'passed';
	}
	if (BLOCKED_RESULT_VALUES.includes(v)) {
		return 'blocked';
	}
	return 'notRun';
}

/** Tooltip of the test-result indicator. */
export function describeTestResult(state: TestResultState): string {
	switch (state) {
		case 'passed': return 'Test result: Passed';
		case 'failed': return 'Test result: Failed';
		case 'blocked': return 'Test result: Blocked';
		default: return 'Test result: Not run';
	}
}
