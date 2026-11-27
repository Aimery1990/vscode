/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import './media/anyagentUiFont.css';
import { getWindow } from '../../../../base/browser/dom.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

/**
 * Makes the workbench UI font available outside of `.monaco-workbench`.
 *
 * The workbench font (platform + UI language specific, see `browser/media/style.css`) is only
 * set on the workbench container, so AnyAgent overlays, popovers, menus and tooltips appended to
 * `document.body` fell back to the browser default (serif) font. This copies the resolved font
 * onto `<body>` as `--vscode-font-family` (the same variable VS Code defines inside webviews) and
 * applies it to body itself. AnyAgent styles reference `var(--vscode-font-family)` for UI text.
 * The body attributes are mirrored into auxiliary windows by the auxiliary window service.
 */
export class AnyAgentUiFontContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.anyagentUiFont';

	constructor(@ILayoutService layoutService: ILayoutService) {
		const container = layoutService.mainContainer;
		const fontFamily = getWindow(container).getComputedStyle(container).fontFamily;
		if (!fontFamily) {
			return;
		}
		const body = container.ownerDocument.body;
		body.style.setProperty('--vscode-font-family', fontFamily);
		body.classList.add('anyagent-ui-font');
	}
}

// After restore: the workbench container has its platform classes and styles by then.
registerWorkbenchContribution2(AnyAgentUiFontContribution.ID, AnyAgentUiFontContribution, WorkbenchPhase.AfterRestored);
