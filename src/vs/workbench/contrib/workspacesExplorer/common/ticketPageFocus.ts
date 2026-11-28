/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/*
 * Ticket page focus safety (UI-28): pure logic.
 *
 * The ticket page re-renders itself completely (new DOM) when its files change. The element the user was typing in
 * is then gone and keyboard focus falls back to the document, so further key presses no longer go where the user
 * thinks. Two helpers deal with that:
 *
 * - Focus keys: before a re-render the focused field is described by where it lives (its component / field), what
 *   kind of field it is, and its position among the fields of that kind there; after the re-render the same field is
 *   looked up again and gets focus and caret back.
 * - Stray keyboard clicks: Space / Enter on a focused button "clicks" it (`detail === 0`). For buttons that remove
 *   things, such a click only counts when the user moved focus onto the button with Tab on purpose.
 */

/** Where a focusable field lives on the page and what kind of field it is. */
export interface IFocusTargetInfo {
	/** The component id (Freestyle frame) or field key of the card that holds the field; '' when none. */
	readonly scope: string;
	/** See {@link focusKindOf}. */
	readonly kind: string;
}

/** A focused field remembered across a re-render. */
export interface IEditableFocusKey extends IFocusTargetInfo {
	/** 0-based position among the fields with the same scope and kind, in document order. */
	readonly ordinal: number;
	readonly selectionStart?: number;
	readonly selectionEnd?: number;
	readonly selectionDirection?: 'forward' | 'backward' | 'none';
	readonly scrollTop?: number;
}

export interface IFocusKindAttributes {
	readonly type?: string | null;
	readonly name?: string | null;
	readonly ariaLabel?: string | null;
	readonly inputIndex?: string | null;
}

/**
 * A stable description of a field's kind: tag, first CSS class and the identifying attributes. State classes that
 * come and go (focus, invalid, ...) are not used, only the first class, which the page always sets first.
 */
export function focusKindOf(tagName: string, classNames: readonly string[], attrs: IFocusKindAttributes = {}): string {
	const parts = [tagName.toLowerCase(), classNames.find(c => !!c) ?? ''];
	for (const value of [attrs.type, attrs.name, attrs.ariaLabel, attrs.inputIndex]) {
		parts.push(value ?? '');
	}
	return parts.join('|');
}

/** The position of `candidates[index]` among the earlier candidates with the same scope and kind. */
export function focusOrdinalOf(candidates: readonly IFocusTargetInfo[], index: number): number {
	const target = candidates[index];
	if (!target) {
		return -1;
	}
	let ordinal = 0;
	for (let i = 0; i < index; i++) {
		if (candidates[i].scope === target.scope && candidates[i].kind === target.kind) {
			ordinal++;
		}
	}
	return ordinal;
}

/** The index of the candidate that matches `key` (same scope, kind and ordinal), or -1. */
export function findFocusRestoreIndex(candidates: readonly IFocusTargetInfo[], key: IEditableFocusKey): number {
	let seen = 0;
	for (let i = 0; i < candidates.length; i++) {
		if (candidates[i].scope === key.scope && candidates[i].kind === key.kind) {
			if (seen === key.ordinal) {
				return i;
			}
			seen++;
		}
	}
	return -1;
}

/** The remembered caret / selection, kept inside a value of length `valueLength` (the value may have changed). */
export function clampFocusSelection(key: IEditableFocusKey, valueLength: number): { start: number; end: number } | undefined {
	if (typeof key.selectionStart !== 'number' || typeof key.selectionEnd !== 'number') {
		return undefined;
	}
	const clamp = (n: number) => Math.max(0, Math.min(valueLength, n));
	const start = clamp(key.selectionStart);
	return { start, end: Math.max(start, clamp(key.selectionEnd)) };
}

/** Focus that arrived within this time after a Tab key press counts as moved there with Tab. */
export const TAB_FOCUS_WINDOW_MS = 1000;

/** True when an element got focus (`focusAt`) right after a Tab key press (`lastTabKeyAt`), both `Date.now()` values. */
export function wasFocusedByTab(lastTabKeyAt: number | undefined, focusAt: number, windowMs: number = TAB_FOCUS_WINDOW_MS): boolean {
	return typeof lastTabKeyAt === 'number' && lastTabKeyAt > 0 && focusAt >= lastTabKeyAt && focusAt - lastTabKeyAt <= windowMs;
}

/**
 * True for a click on a destructive button that must be ignored: not a pointer click (`detail === 0`: Space / Enter
 * on the focused button, or a script's `click()`), on a button the user did not move to with Tab.
 */
export function isStrayKeyboardClick(detail: number, focusedByTab: boolean): boolean {
	return detail === 0 && !focusedByTab;
}

/**
 * Buttons on the ticket page that remove or clear something. Keyboard clicks on them only count after a deliberate
 * Tab onto the button (see {@link isStrayKeyboardClick}).
 */
export const TICKET_PAGE_DESTRUCTIVE_BUTTON_SELECTOR = [
	'[data-destructive]',
	'.freestyle-component-btn.danger',
	'.prompt-remove-user-input-btn',
	'.tts-delete-audio-btn'
].join(', ');
