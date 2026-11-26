/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventType, getWindow, isHTMLElement } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { computeOutlineOverscrollRange, IOutlineOverscrollMetrics, outlineWheelDeltaToPixels, resolveOutlineOverscroll } from '../common/outlineOverscroll.js';

const RESET_DURATION_MS = 200;
const WHEEL_LINE_HEIGHT = 16;

/**
 * One list of the Workflow Outline (a menu level, or the Sub-Workflow library) that the mouse wheel can scroll past its
 * native range (UI-07): `scrollEl` is the list box (native `overflow-y: auto`), `contentEl` the single child holding the
 * rows, translated by the forced extra offset. See `../common/outlineOverscroll.ts` for the offset model and limits.
 */
export class OutlineListOverscroll extends Disposable {

	private _extra = 0;
	private _resetTimer: number | undefined;
	/** Ancestors that clip vertically (overflow not `visible`), found on first use: the panel never moves to another parent. */
	private _clipAncestors: HTMLElement[] | undefined;

	constructor(
		readonly key: string,
		private readonly _scrollEl: HTMLElement,
		private readonly _contentEl: HTMLElement,
		private readonly _onDidChangeExtra: (key: string, extra: number) => void
	) {
		super();
		this._register(addDisposableListener(this._scrollEl, EventType.MOUSE_WHEEL, (e: WheelEvent) => this._onWheel(e), { passive: false }));
		this._register({ dispose: () => this._cancelReset() });
	}

	/** Re-applies a stored extra offset on top of the current native `scrollTop`, clamped to the current limits. */
	restore(extra: number): void {
		if (extra === 0 && this._extra === 0) {
			return; // nothing forced: the native scroll position is always valid
		}
		this._extra = extra;
		this._scrollTo(this._scrollEl.scrollTop + extra);
	}

	/** Keeps the current position inside the (possibly changed) limits, e.g. after the editor was resized. */
	clamp(): void {
		if (this._extra !== 0 && this._resetTimer === undefined) {
			this._scrollTo(this._scrollEl.scrollTop + this._extra);
		}
	}

	/** Back to normal (no forced offset; the native scroll position is kept), with a short transition. */
	reset(): void {
		if (this._extra === 0) {
			return;
		}
		this._cancelReset();
		this._contentEl.classList.add('is-overscroll-resetting');
		this._setExtra(0);
		// `is-overscrolled-down` stays until the content is back, so no scrollbar flashes during the transition
		this._resetTimer = getWindow(this._scrollEl).setTimeout(() => {
			this._resetTimer = undefined;
			this._contentEl.classList.remove('is-overscroll-resetting');
			this._scrollEl.classList.remove('is-overscrolled-down');
		}, RESET_DURATION_MS);
	}

	private _onWheel(e: WheelEvent): void {
		if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
			return; // pinch zoom / horizontal scroll (between menu levels): unchanged
		}
		const delta = outlineWheelDeltaToPixels(e.deltaY, e.deltaMode, WHEEL_LINE_HEIGHT, this._scrollEl.clientHeight);
		if (delta === 0) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		this._cancelReset();
		this._scrollTo(this._scrollEl.scrollTop + this._extra + delta);
	}

	private _scrollTo(position: number): void {
		if (!this._scrollEl.isConnected) {
			return;
		}
		// Measure without the translate (a downward translate would also enlarge scrollHeight)
		this._contentEl.style.transform = '';
		const metrics = this._measure();
		const resolved = resolveOutlineOverscroll(position, computeOutlineOverscrollRange(metrics), metrics.nativeMax);
		this._scrollEl.scrollTop = resolved.scrollTop;
		this._setExtra(resolved.extra);
		this._scrollEl.classList.toggle('is-overscrolled-down', resolved.extra < 0);
	}

	private _setExtra(extra: number): void {
		this._contentEl.style.transform = extra !== 0 ? `translateY(${-extra}px)` : '';
		this._extra = extra;
		this._onDidChangeExtra(this.key, extra);
	}

	private _measure(): IOutlineOverscrollMetrics {
		const scrollEl = this._scrollEl;
		const nativeMax = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
		const contentRect = this._contentEl.getBoundingClientRect();
		const contentTopAtZero = contentRect.top + scrollEl.scrollTop;

		// Visible window: the list's padding box intersected with every clipping ancestor (e.g. the editor group above a lower split) intersected with window
		const listRect = scrollEl.getBoundingClientRect();
		let top = Math.max(listRect.top + scrollEl.clientTop, 0);
		let bottom = Math.min(listRect.top + scrollEl.clientTop + scrollEl.clientHeight, getWindow(scrollEl).innerHeight);
		for (const el of this._getClipAncestors()) {
			const r = el.getBoundingClientRect();
			top = Math.max(top, r.top + el.clientTop);
			bottom = Math.min(bottom, r.top + el.clientTop + el.clientHeight);
		}

		const first = this._contentEl.firstElementChild;
		const last = this._contentEl.lastElementChild;
		const windowTop = top - contentTopAtZero;
		const windowBottom = bottom - contentTopAtZero;
		if (!first || !last) {
			// Nothing to keep visible: only the native range
			return { nativeMax, firstItemBottom: windowBottom, lastItemTop: windowTop, windowTop, windowBottom };
		}
		return {
			nativeMax,
			firstItemBottom: first.getBoundingClientRect().bottom - contentRect.top,
			lastItemTop: last.getBoundingClientRect().top - contentRect.top,
			windowTop,
			windowBottom
		};
	}

	private _getClipAncestors(): HTMLElement[] {
		if (!this._clipAncestors) {
			const result: HTMLElement[] = [];
			const win = getWindow(this._scrollEl);
			const body = this._scrollEl.ownerDocument.body;
			for (let el = this._scrollEl.parentElement; el && el !== body; el = el.parentElement) {
				if (win.getComputedStyle(el).overflowY !== 'visible') {
					result.push(el);
				}
			}
			this._clipAncestors = result;
		}
		return this._clipAncestors;
	}

	private _cancelReset(): void {
		if (this._resetTimer !== undefined) {
			getWindow(this._scrollEl).clearTimeout(this._resetTimer);
			this._resetTimer = undefined;
			this._contentEl.classList.remove('is-overscroll-resetting');
			this._scrollEl.classList.toggle('is-overscrolled-down', this._extra < 0);
		}
	}
}

/**
 * True when a click inside the outline `panel` hit a blank area: not a row, a library entry, a button or an input.
 * Clicks whose target has already been removed by a re-render never count.
 */
export function isOutlineBlankClickTarget(target: EventTarget | null, panel: HTMLElement): boolean {
	let el: HTMLElement | null = isHTMLElement(target) ? target : null;
	while (el && el !== panel) {
		const tag = el.tagName;
		if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'A'
			|| el.classList.contains('wf-outline-item') || el.classList.contains('wf-subworkflow-item')) {
			return false;
		}
		el = el.parentElement;
	}
	return el === panel;
}
