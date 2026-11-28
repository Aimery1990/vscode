/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IActionButton } from '../../entityPersistence/common/entityPersistence.js';

/*
 * Human decisions (CI-25): a Button Group component is a human approval gate. When a ticket run or a workflow node
 * run reaches it, the run waits until a person clicks one of its buttons (on the ticket page, on the workflow canvas,
 * from the notification, or through resumeWorkflow). The clicked button becomes the component's output.
 *
 * This file holds the pure logic (button matching, output mapping, stored value) and the service contract; the
 * service itself lives in browser/humanDecisionService.ts.
 */

export interface IDecisionButton {
	readonly id: string;
	readonly label: string;
	readonly targetStatus?: string;
	readonly color?: string;
}

/** A person's choice. Stored as the Button Group's ticket value and published as its output. */
export interface IHumanDecision {
	readonly buttonId: string;
	readonly label: string;
	/** ISO time of the click. */
	readonly at: string;
	/** Who decided: 'User' for a click in the app, or the caller's name (e.g. 'AI'). */
	readonly by: string;
	readonly targetStatus?: string;
}

export interface IHumanDecisionRequest {
	readonly fieldId: string;
	readonly fieldLabel: string;
	readonly buttons: readonly IDecisionButton[];
	/** Ticket the gate belongs to (absent for a component directly in a workflow node). */
	readonly ticketUri?: string;
	readonly ticketId?: string;
	readonly ticketTitle?: string;
	/** Workflow run / node waiting for the decision, when the gate runs inside a workflow. */
	readonly workflowRunId?: string;
	readonly workflowNodeId?: string;
	readonly workflowNodeLabel?: string;
	/** The component's Waiting Prompt, already resolved (default {@link DEFAULT_WAITING_PROMPT}). */
	readonly waitingPrompt?: string;
}

export interface IPendingHumanDecision extends IHumanDecisionRequest {
	readonly id: string;
	readonly createdAt: number;
	/** Full notification text: where it waits, the waiting prompt and the buttons. */
	readonly prompt: string;
	/** Short text shown on the card and the canvas node (the Waiting Prompt). */
	readonly waitingText: string;
}

/** Default Waiting Prompt of a Button Group (CI-25). */
export const DEFAULT_WAITING_PROMPT = 'Waiting for your decision';

/** The Waiting Prompt to show: the configured text with {variables} resolved, or the default when empty. */
export function resolveWaitingPrompt(raw: string | undefined, resolve: (text: string) => string = text => text): string {
	const text = String(raw ?? '').trim();
	if (!text) {
		return DEFAULT_WAITING_PROMPT;
	}
	const resolved = resolve(text).trim();
	return resolved || DEFAULT_WAITING_PROMPT;
}

/** Where a workflow run waits for a decision (passed down to ticket runs and node components). */
export interface IHumanDecisionContext {
	readonly workflowRunId: string;
	readonly workflowNodeId: string;
	readonly workflowNodeLabel?: string;
}

export const IHumanDecisionService = createDecorator<IHumanDecisionService>('humanDecisionService');

export interface IHumanDecisionService {
	readonly _serviceBrand: undefined;
	/** Fires when a decision starts or stops waiting. */
	readonly onDidChange: Event<void>;
	getPending(): readonly IPendingHumanDecision[];
	/** Pending decision of a Button Group on a ticket (matched by ticket id or ticket folder). */
	findForTicketField(ticket: { readonly uri?: string; readonly ticketId?: string }, field: { readonly id?: string; readonly label?: string }): IPendingHumanDecision | undefined;
	findForWorkflowRun(runId: string): IPendingHumanDecision | undefined;
	/**
	 * Waits for a person's choice. Resolves undefined when the wait is cancelled (Stop) or `isCancelled` turns true.
	 */
	request(request: IHumanDecisionRequest, isCancelled?: () => boolean, stopRun?: () => void): Promise<IHumanDecision | undefined>;
	/** Resolves a pending decision with a button (id, label or an input object, see matchDecisionButton). */
	resolve(id: string, input: unknown, by?: string): IHumanDecision | undefined;
	/** "Stop this run": ends the whole run that waits (its own Stop), then cancels the wait. */
	stopRun(id: string): void;
	cancel(id: string): void;
	cancelForWorkflowRun(runId: string): void;
	cancelAll(): void;
}

/** Buttons of a Button Group; the same Approve / Reject defaults as the ticket card when none are defined. */
export function normalizeDecisionButtons(buttons: readonly IActionButton[] | undefined): IDecisionButton[] {
	const list = Array.isArray(buttons) ? buttons.filter(b => b && String(b.label ?? '').trim()) : [];
	if (list.length === 0) {
		return [
			{ id: 'btn_1', label: 'Approve', color: '#10b981', targetStatus: 'Done' },
			{ id: 'btn_2', label: 'Reject', color: '#ef4444', targetStatus: 'Blocked' }
		];
	}
	return list.map((b, idx) => ({
		id: String(b.id || `btn_${idx + 1}`),
		label: String(b.label).trim(),
		...(b.targetStatus ? { targetStatus: String(b.targetStatus) } : {}),
		...(b.color ? { color: String(b.color) } : {})
	}));
}

function matchText(buttons: readonly IDecisionButton[], text: string): IDecisionButton | undefined {
	const key = text.trim().toLowerCase();
	if (!key) {
		return undefined;
	}
	return buttons.find(b => b.id.toLowerCase() === key) ?? buttons.find(b => b.label.toLowerCase() === key);
}

/**
 * The button an input designates: a button id or label (case-insensitive), or an object with buttonId / id / label /
 * button / choice / option / action. `{ approved: true }` (the generic Approve of the canvas / AI tool) picks the
 * first button, `{ approved: false }` the last one. Anything else: undefined.
 */
export function matchDecisionButton(buttons: readonly IDecisionButton[], input: unknown): IDecisionButton | undefined {
	if (input === undefined || input === null) {
		return undefined;
	}
	if (typeof input === 'string' || typeof input === 'number') {
		return matchText(buttons, String(input));
	}
	if (typeof input === 'object' && !Array.isArray(input)) {
		const obj = input as Record<string, unknown>;
		for (const key of ['buttonId', 'id', 'label', 'button', 'choice', 'option', 'action', 'decision']) {
			const value = obj[key];
			if (typeof value === 'string' || typeof value === 'number') {
				const match = matchText(buttons, String(value));
				if (match) {
					return match;
				}
			}
		}
		if (obj.approved === true) {
			return buttons[0];
		}
		if (obj.approved === false && buttons.length > 1) {
			return buttons[buttons.length - 1];
		}
	}
	return undefined;
}

export function buildHumanDecision(button: IDecisionButton, by: string, now: Date = new Date()): IHumanDecision {
	return { buttonId: button.id, label: button.label, at: now.toISOString(), by: by || 'User', ...(button.targetStatus ? { targetStatus: button.targetStatus } : {}) };
}

/** Structured output fields of a Button Group: `{Label.id}`, `{Label.label}`, `{Label.at}`, `{Label.by}`. */
export const BUTTON_GROUP_OUTPUT_FIELDS = ['id', 'label', 'at', 'by'] as const;

export function buttonGroupOutputFields(decision: IHumanDecision): Record<typeof BUTTON_GROUP_OUTPUT_FIELDS[number], string> {
	return { id: decision.buttonId, label: decision.label, at: decision.at, by: decision.by };
}

function cleanKey(key: string): string {
	return key.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
}

/**
 * Publishes a decision into run context variables: `{Label}` / label_key = the clicked button's label, `{Label.id}`,
 * `{Label.label}`, `{Label.at}`, `{Label.by}` and `{Label}_result` / `{label_key}_result` (dict), also under each of
 * `aliases` (the output variable, UI-27). Returns the label.
 */
export function publishButtonGroupOutputs(context: Record<string, unknown>, label: string, decision: IHumanDecision, aliases: readonly (string | undefined)[] = []): string {
	const fields = buttonGroupOutputFields(decision);
	for (const name of new Set([label, cleanKey(label), ...aliases.filter((a): a is string => !!a)])) {
		context[name] = decision.label;
		context[`${name}_result`] = fields;
		for (const [field, value] of Object.entries(fields)) {
			context[`${name}.${field}`] = value;
		}
	}
	return decision.label;
}

/** The parts of a ticket step result needed to find its gate decisions. */
export interface IDecisionStepResultLike {
	readonly fieldLabel: string;
	readonly fieldType: string;
	readonly status: string;
	readonly details?: unknown;
}

/** Identifier-safe prefix of a ticket's decision aliases: 'ANYAG-0121' -> 'ANYAG_0121_'. */
export function ticketDecisionAliasPrefix(ticketId: string): string {
	const safe = ticketId.replace(/[^a-zA-Z0-9_]/g, '_');
	return `${/^[0-9]/.test(safe) ? '_' : ''}${safe}_`;
}

/**
 * Publishes the gate decisions of a ticket run inside a workflow node into the workflow context, so a link right after
 * the node can branch on them (@review == 'Approve'). For each Button Group the ticket run decided, in run order:
 * - unprefixed, exactly like a Button Group directly in a node: `{Label}` / label_key = clicked label, `{Label.id}`
 *   ... and `{Label}_result` / `{label_key}_result` (dict). An existing variable of the same name is overwritten:
 *   the latest decision wins.
 * - with an identifier-safe ticket alias (when ticketId is given): `ANYAG_0121_review` = clicked label and
 *   `ANYAG_0121_review_result` (dict), usable in link conditions and Python where `ANYAG-0121.review` is not.
 * Returns the labels of the published gates.
 */
export function publishTicketDecisionsToWorkflow(context: Record<string, unknown>, ticketId: string | undefined, stepResults: readonly IDecisionStepResultLike[] | undefined): string[] {
	const published: string[] = [];
	for (const step of stepResults ?? []) {
		if (step.fieldType !== 'button_group' || step.status !== 'success' || !step.fieldLabel) {
			continue;
		}
		const decision = parseButtonGroupValue(step.details);
		if (!decision) {
			continue;
		}
		publishButtonGroupOutputs(context, step.fieldLabel, decision);
		if (ticketId) {
			const alias = `${ticketDecisionAliasPrefix(ticketId)}${cleanKey(step.fieldLabel)}`;
			context[alias] = decision.label;
			context[`${alias}_result`] = buttonGroupOutputFields(decision);
		}
		published.push(step.fieldLabel);
	}
	return published;
}

/** The stored decision of a Button Group ticket value (object or JSON text), or undefined. */
export function parseButtonGroupValue(raw: unknown): IHumanDecision | undefined {
	let value = raw;
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed.startsWith('{')) {
			return undefined;
		}
		try {
			value = JSON.parse(trimmed);
		} catch {
			return undefined;
		}
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const obj = value as Record<string, unknown>;
	if (typeof obj.buttonId !== 'string' || typeof obj.label !== 'string') {
		return undefined;
	}
	return {
		buttonId: obj.buttonId,
		label: obj.label,
		at: typeof obj.at === 'string' ? obj.at : '',
		by: typeof obj.by === 'string' ? obj.by : '',
		...(typeof obj.targetStatus === 'string' && obj.targetStatus ? { targetStatus: obj.targetStatus } : {})
	};
}

/** Text shown while a gate waits. */
export function describeDecisionPrompt(request: IHumanDecisionRequest): string {
	const where = request.ticketId || request.ticketTitle
		? `Ticket ${request.ticketId || request.ticketTitle}`
		: (request.workflowNodeLabel ? `Workflow node '${request.workflowNodeLabel}'` : 'A run');
	return `${where} - ${request.fieldLabel}: ${resolveWaitingPrompt(request.waitingPrompt)} (${request.buttons.map(b => b.label).join(' / ')})`;
}

/** Normalized path of a ticket (its folder), so a folder URI and a ticket.md URI of the same ticket compare equal. */
export function ticketKeyOf(uri: string | undefined): string {
	if (!uri) {
		return '';
	}
	return uri.replace(/\/+$/, '').replace(/\/(?:\.agents\/)?ticket\.md$/i, '').replace(/\/\.agents$/i, '').toLowerCase();
}

/** In-memory registry of pending decisions (the service delegates to it; testable without services). */
export class PendingHumanDecisions {
	private readonly _pending = new Map<string, { readonly entry: IPendingHumanDecision; readonly resolve: (decision: IHumanDecision | undefined) => void; readonly stopRun?: () => void }>();
	private _counter = 0;

	constructor(private readonly _onChange: () => void = () => { }) { }

	list(): IPendingHumanDecision[] {
		return Array.from(this._pending.values()).map(p => p.entry);
	}

	get(id: string): IPendingHumanDecision | undefined {
		return this._pending.get(id)?.entry;
	}

	add(request: IHumanDecisionRequest, now = Date.now(), stopRun?: () => void): { readonly entry: IPendingHumanDecision; readonly promise: Promise<IHumanDecision | undefined> } {
		const id = `decision_${now}_${++this._counter}`;
		const entry: IPendingHumanDecision = {
			...request,
			id,
			createdAt: now,
			prompt: describeDecisionPrompt(request),
			waitingText: resolveWaitingPrompt(request.waitingPrompt)
		};
		let resolveFn: (decision: IHumanDecision | undefined) => void = () => { };
		const promise = new Promise<IHumanDecision | undefined>(resolve => { resolveFn = resolve; });
		this._pending.set(id, { entry, resolve: resolveFn, stopRun });
		this._onChange();
		return { entry, promise };
	}

	resolve(id: string, input: unknown, by = 'User', now = new Date()): IHumanDecision | undefined {
		const pending = this._pending.get(id);
		if (!pending) {
			return undefined;
		}
		const button = matchDecisionButton(pending.entry.buttons, input);
		if (!button) {
			return undefined;
		}
		const decision = buildHumanDecision(button, by, now);
		this._pending.delete(id);
		pending.resolve(decision);
		this._onChange();
		return decision;
	}

	/** Ends the waiting run (its stop callback, if any) and cancels the wait: the step fails as stopped. */
	stopRun(id: string): void {
		const pending = this._pending.get(id);
		if (!pending) {
			return;
		}
		try {
			pending.stopRun?.();
		} finally {
			this.cancel(id);
		}
	}

	cancel(id: string): void {
		const pending = this._pending.get(id);
		if (pending) {
			this._pending.delete(id);
			pending.resolve(undefined);
			this._onChange();
		}
	}

	findForTicketField(ticket: { readonly uri?: string; readonly ticketId?: string }, field: { readonly id?: string; readonly label?: string }): IPendingHumanDecision | undefined {
		const key = ticketKeyOf(ticket.uri);
		return this.list().find(p => {
			const sameTicket = (!!ticket.ticketId && !!p.ticketId && p.ticketId.toLowerCase() === ticket.ticketId.toLowerCase()) || (!!key && ticketKeyOf(p.ticketUri) === key);
			const sameField = (!!field.id && p.fieldId === field.id) || (!!field.label && p.fieldLabel.toLowerCase() === field.label.toLowerCase());
			return sameTicket && sameField;
		});
	}

	findForWorkflowRun(runId: string): IPendingHumanDecision | undefined {
		return this.list().find(p => p.workflowRunId === runId);
	}
}
