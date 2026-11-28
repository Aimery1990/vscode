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
 * 1. Last ticket run failed. Every ticket run writes `.agents/last_run.json` ({@link ITicketLastRunRecord}: outcome,
 *    time, failed component); since CI-58 a run no longer writes its result into the Status, so the record is the
 *    signal. The red mark follows the latest run outcome (UI-20 rework, ANYAG-0110): a record saying `Failed` keeps the
 *    ticket failing whatever its Status is (a manual change to Done or anything else does not clear it); only a later
 *    successful run (a `Completed` record) or "Clear Failure Mark" ({@link dismissTicketRunFailure}: `dismissedAt` /
 *    `dismissedBy` in the record) clears it, and the next failed run writes a fresh record that shows red again.
 *    A run stopped by the user (`Stopped`) is not a failure. A legacy Status `Failed` (runs before CI-58) still counts
 *    unless a newer record says the last run completed or the failure was dismissed.
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
	/** `Stopped`: a person stopped the run (CI-25 "Stop this run" at a gate); neither a failure nor a success. */
	readonly status: 'Completed' | 'Failed' | 'Stopped';
	/** ISO time the run finished. */
	readonly at: string;
	/** Label of the first failed component. */
	readonly failedStep?: string;
	readonly error?: string;
	/** ISO time the failure mark was cleared by hand ("Clear Failure Mark"); a later run writes a record without it. */
	readonly dismissedAt?: string;
	/** Who cleared it (`User`). */
	readonly dismissedBy?: string;
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
	/** The failure comes from the ticket's last run, so "Clear Failure Mark" applies (UI-20 rework). */
	readonly runFailure?: boolean;
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
		if (!raw || typeof raw !== 'object' || (raw.status !== 'Completed' && raw.status !== 'Failed' && raw.status !== 'Stopped') || typeof raw.at !== 'string') {
			return undefined;
		}
		const str = (key: string) => typeof raw[key] === 'string' && raw[key] ? raw[key] as string : undefined;
		const record: { -readonly [K in keyof ITicketLastRunRecord]: ITicketLastRunRecord[K] } = { status: raw.status, at: raw.at };
		const failedStep = str('failedStep');
		const error = str('error');
		const dismissedAt = str('dismissedAt');
		const dismissedBy = str('dismissedBy');
		if (failedStep) {
			record.failedStep = failedStep;
		}
		if (error) {
			record.error = error;
		}
		if (dismissedAt) {
			record.dismissedAt = dismissedAt;
		}
		if (dismissedBy) {
			record.dismissedBy = dismissedBy;
		}
		return record;
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
 * `stoppedByUser`: a person stopped the run at a gate; the step it stopped at "failed", but the run is `Stopped`
 * (not red, not a failure for dependents).
 */
export function ticketLastRunRecordFromSteps(steps: readonly { readonly status: string; readonly fieldLabel?: string; readonly error?: string }[] | undefined, at: Date, stoppedByUser = false): ITicketLastRunRecord {
	if (stoppedByUser) {
		return { status: 'Stopped', at: at.toISOString() };
	}
	const failed = (steps || []).find(s => s.status === 'failed');
	return failed
		? { status: 'Failed', at: at.toISOString(), failedStep: failed.fieldLabel || undefined, error: failed.error ? truncate(failed.error, 500) : undefined }
		: { status: 'Completed', at: at.toISOString() };
}

/**
 * The run outcome of a record for dependents (CI-59): `Completed` → success, `Failed` → failed (a dismissed mark only
 * hides the red in the tree), `Stopped` (a person stopped the run) → no outcome.
 */
export function lastRunOutcome(record: ITicketLastRunRecord | undefined): 'success' | 'failed' | undefined {
	switch (record?.status) {
		case 'Completed': return 'success';
		case 'Failed': return 'failed';
		default: return undefined;
	}
}

/**
 * The record after "Clear Failure Mark": the failed record with `dismissedAt` / `dismissedBy`. Without a record (a
 * Status `Failed` from a run before UI-20) a failed record is created at `now`, so the dismissal has something to
 * cover. A later run overwrites the whole record, so a new failure shows red again.
 */
export function dismissTicketRunFailure(record: ITicketLastRunRecord | undefined, now: Date, by = 'User'): ITicketLastRunRecord {
	const base: ITicketLastRunRecord = record?.status === 'Failed' ? record : { status: 'Failed', at: now.toISOString() };
	return { ...base, dismissedAt: now.toISOString(), dismissedBy: by };
}

/** Whether `record` is a failed run whose mark was cleared by hand. */
export function isDismissedRunFailure(record: ITicketLastRunRecord | undefined): boolean {
	return record?.status === 'Failed' && !!record.dismissedAt;
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
	const run = describeRunFailure(input.status, input.lastRun);
	if (run) {
		reasons.push(run.reason);
	}
	if (input.workflowRun && input.workflowRun.status.toLowerCase() === 'failed') {
		const when = formatFailureTime(input.workflowRun.at);
		const num = input.workflowRun.runNumber !== undefined ? ` #${input.workflowRun.runNumber}` : '';
		reasons.push(`Last workflow run${num} failed${when ? ` ${when}` : ''}`);
	}
	if (input.resultField && isFailingResultValue(input.resultField.value)) {
		reasons.push(`Test ${input.resultField.label.toLowerCase()}: ${input.resultField.value}`);
	}
	if (reasons.length === 0) {
		return undefined;
	}
	return run?.clearable ? { reasons, runFailure: true } : { reasons };
}

/**
 * The reason of a run failure, or undefined (see the rules at the top): a failed, not dismissed record fails whatever
 * the Status; a dismissed record covers the Status `Failed` its run wrote; without a failed record Status `Failed`
 * fails on its own. `clearable`: "Clear Failure Mark" applies (not to a Status `Failed` set by hand after a successful
 * run: changing the Status clears that one).
 */
function describeRunFailure(status: string | undefined, lastRun: ITicketLastRunRecord | undefined): { reason: string; clearable: boolean } | undefined {
	if (lastRun?.status === 'Failed') {
		if (lastRun.dismissedAt) {
			return undefined;
		}
		const when = formatFailureTime(lastRun.at);
		let reason = when ? `Last run failed (${when})` : 'Last run failed';
		if (lastRun.failedStep) {
			reason += ` — component '${lastRun.failedStep}' failed`;
		}
		if (lastRun.error) {
			reason += `: ${truncate(lastRun.error, 120)}`;
		}
		if (status && !isFailedRunStatus(status)) {
			reason += ` — the status (${status.trim()}) does not clear it; run again or Clear Failure Mark`;
		}
		return { reason, clearable: true };
	}
	// a legacy Status `Failed` (runs before CI-58) counts until a run completes; a stopped run says nothing about it
	if (isFailedRunStatus(status) && lastRun?.status !== 'Completed') {
		return { reason: 'Last run failed (Status: Failed)', clearable: true };
	}
	return undefined;
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
