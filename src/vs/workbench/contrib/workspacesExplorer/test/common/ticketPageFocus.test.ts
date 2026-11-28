/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { clampFocusSelection, findFocusRestoreIndex, focusKindOf, focusOrdinalOf, IFocusTargetInfo, isStrayKeyboardClick, TAB_FOCUS_WINDOW_MS, wasFocusedByTab } from '../../common/ticketPageFocus.js';

suite('ticketPageFocus', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const script = focusKindOf('TEXTAREA', ['shell-script-input'], {});
	const env = focusKindOf('TEXTAREA', ['shell-env-input'], {});
	const cwd = focusKindOf('INPUT', [], { type: 'text' });

	test('focus kind: tag, first class and identifying attributes only', () => {
		assert.strictEqual(focusKindOf('TEXTAREA', ['shell-script-input', 'focused'], {}), 'textarea|shell-script-input||||');
		assert.strictEqual(focusKindOf('textarea', ['shell-script-input'], {}), focusKindOf('TEXTAREA', ['shell-script-input', 'other-state'], {}));
		assert.strictEqual(focusKindOf('textarea', ['prompt-user-textarea'], { inputIndex: '2' }), 'textarea|prompt-user-textarea||||2');
		assert.notStrictEqual(focusKindOf('input', [], { type: 'text' }), focusKindOf('input', [], { type: 'number' }));
	});

	test('the same field is found again after a re-render (component + kind + ordinal)', () => {
		const before: IFocusTargetInfo[] = [
			{ scope: 'description', kind: 'textarea|description||||' },
			{ scope: 'hello_pwd', kind: script },
			{ scope: 'hello_pwd', kind: cwd },
			{ scope: 'hello_pwd', kind: env },
			{ scope: 'make_file', kind: script },
		];
		const index = 4;
		const key = { ...before[index], ordinal: focusOrdinalOf(before, index), selectionStart: 3, selectionEnd: 3 };
		assert.strictEqual(key.ordinal, 0);
		// the re-render added a card in front: the Make File script is found at its new position
		const after: IFocusTargetInfo[] = [{ scope: 'new_card', kind: script }, ...before];
		assert.strictEqual(findFocusRestoreIndex(after, key), 5);
		// the component was removed meanwhile: nothing gets focus
		assert.strictEqual(findFocusRestoreIndex(before.slice(0, 4), key), -1);
	});

	test('ordinals tell apart fields of the same kind in one card', () => {
		const fields: IFocusTargetInfo[] = [
			{ scope: 'prompt', kind: 'textarea|p||||' },
			{ scope: 'prompt', kind: 'textarea|p||||' },
			{ scope: 'prompt', kind: 'textarea|p||||' },
		];
		assert.strictEqual(focusOrdinalOf(fields, 2), 2);
		assert.strictEqual(focusOrdinalOf(fields, 5), -1);
		assert.strictEqual(findFocusRestoreIndex(fields, { ...fields[0], ordinal: 1 }), 1);
		assert.strictEqual(findFocusRestoreIndex(fields, { ...fields[0], ordinal: 3 }), -1);
	});

	test('caret is clamped to the new value', () => {
		const key = { scope: 's', kind: script, ordinal: 0, selectionStart: 4, selectionEnd: 9 };
		assert.deepStrictEqual(clampFocusSelection(key, 20), { start: 4, end: 9 });
		assert.deepStrictEqual(clampFocusSelection(key, 6), { start: 4, end: 6 });
		assert.deepStrictEqual(clampFocusSelection(key, 2), { start: 2, end: 2 });
		assert.strictEqual(clampFocusSelection({ scope: 's', kind: cwd, ordinal: 0 }, 5), undefined);
	});

	test('focus counts as "moved there with Tab" only right after a Tab key press', () => {
		assert.strictEqual(wasFocusedByTab(1000, 1010), true);
		assert.strictEqual(wasFocusedByTab(1000, 1000 + TAB_FOCUS_WINDOW_MS + 1), false);
		assert.strictEqual(wasFocusedByTab(1000, 900), false);
		assert.strictEqual(wasFocusedByTab(0, 10), false);
		assert.strictEqual(wasFocusedByTab(undefined, 10), false);
	});

	test('keyboard clicks on destructive buttons count only after a deliberate Tab', () => {
		assert.strictEqual(isStrayKeyboardClick(1, false), false, 'mouse click always counts');
		assert.strictEqual(isStrayKeyboardClick(2, false), false);
		assert.strictEqual(isStrayKeyboardClick(0, false), true, 'Space / Enter on a button focused by a re-render or a script');
		assert.strictEqual(isStrayKeyboardClick(0, true), false, 'Tab to the button, then Enter');
	});
});
