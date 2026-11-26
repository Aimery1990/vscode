/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure math of the Workflow Outline "overscroll" (UI-07).
 *
 * Every list of the outline has one virtual scroll position `v` (pixels, content coordinates):
 * - `0 <= v <= nativeMax` is the list's native `scrollTop`;
 * - `v > nativeMax` scrolls further by moving the content up (translate) past the native end;
 * - `v < 0` moves the content down past the native start.
 * So a wheel gesture first uses the native scroll range and then continues seamlessly into the forced range.
 *
 * The forced range stops when only the last item (scrolling up) or only the first item (scrolling down) is still
 * inside the visible window of the list, so a list can never leave the view completely.
 */

export interface IOutlineOverscrollMetrics {
	/** Native scroll range of the list: `max(0, scrollHeight - clientHeight)` without any translate applied. */
	readonly nativeMax: number;
	/** Bottom edge of the first item, relative to the top of the list content. */
	readonly firstItemBottom: number;
	/** Top edge of the last item, relative to the top of the list content. */
	readonly lastItemTop: number;
	/**
	 * Visible window (the part of the list that is really on screen: list box intersected with every clipping ancestor), in content
	 * coordinates at `v = 0`. `windowTop` <= `windowBottom` is not required (a fully hidden list is allowed).
	 */
	readonly windowTop: number;
	readonly windowBottom: number;
}

export interface IOutlineOverscrollRange {
	/** Lowest virtual position (<= 0): content moved down until only the first item remains visible. */
	readonly min: number;
	/** Highest virtual position (>= nativeMax): content moved up until only the last item remains visible. */
	readonly max: number;
}

export interface IOutlineOverscrollPosition {
	/** Virtual position after clamping. */
	readonly position: number;
	/** Native `scrollTop` to apply (0 ... nativeMax). */
	readonly scrollTop: number;
	/** Extra forced offset beyond the native range: content is translated by `-extra` pixels. */
	readonly extra: number;
}

/** Allowed virtual scroll range of one list. The default position (0) and the whole native range are always allowed. */
export function computeOutlineOverscrollRange(m: IOutlineOverscrollMetrics): IOutlineOverscrollRange {
	const nativeMax = Math.max(0, finiteOr(m.nativeMax, 0));
	// Scrolling up: the window top reaches the last item's top -> only the last item is left
	const max = Math.max(finiteOr(m.lastItemTop - m.windowTop, 0), nativeMax, 0);
	// Scrolling down: the window bottom reaches the first item's bottom -> only the first item is left
	const min = Math.min(finiteOr(m.firstItemBottom - m.windowBottom, 0), 0);
	return { min, max };
}

/** Clamps a virtual position into `range` and splits it into native scroll + forced extra offset. */
export function resolveOutlineOverscroll(position: number, range: IOutlineOverscrollRange, nativeMax: number): IOutlineOverscrollPosition {
	const max = Math.max(0, finiteOr(nativeMax, 0));
	const clamped = clamp(finiteOr(position, 0), Math.min(range.min, 0), Math.max(range.max, max));
	const scrollTop = clamp(clamped, 0, max);
	return { position: clamped, scrollTop, extra: clamped - scrollTop };
}

/** Converts a wheel `deltaY` to pixels (`deltaMode`: 0 = pixels, 1 = lines, 2 = pages). */
export function outlineWheelDeltaToPixels(deltaY: number, deltaMode: number, lineHeight: number, pageHeight: number): number {
	if (!Number.isFinite(deltaY)) {
		return 0;
	}
	if (deltaMode === 1) {
		return deltaY * lineHeight;
	}
	if (deltaMode === 2) {
		return deltaY * pageHeight;
	}
	return deltaY;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function finiteOr(value: number, fallback: number): number {
	return Number.isFinite(value) ? value : fallback;
}
