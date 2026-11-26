/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Restore-tabs prompt
 *
 * Open tabs (workflow canvases, Sub-Workflow canvases, ticket details, ...) are restored on the next start-up by
 * default (`workbench.editor.restoreEditors`). When the user closes the window or quits, this asks once whether
 * the tabs should be reopened next time, with a "Don't ask me again" checkbox. The answer is stored in the
 * regular `workbench.editor.restoreEditors` setting, so it can be changed later in Settings.
 */

import Severity from '../../../../base/common/severity.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ILifecycleService, ShutdownReason } from '../../../services/lifecycle/common/lifecycle.js';

const RESTORE_EDITORS_SETTING = 'workbench.editor.restoreEditors';
const DONT_ASK_STORAGE_KEY = 'anyagent.restoreTabsPrompt.dontAsk';

class RestoreTabsPromptContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.anyAgentRestoreTabsPrompt';

	constructor(
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IStorageService private readonly _storageService: IStorageService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IEditorService private readonly _editorService: IEditorService
	) {
		super();
		this._register(this._lifecycleService.onBeforeShutdown(e => {
			// Only when the window is closed or the app quits; never on reload (Cmd+R) or window load
			if (e.reason !== ShutdownReason.CLOSE && e.reason !== ShutdownReason.QUIT) {
				return;
			}
			if (this._storageService.getBoolean(DONT_ASK_STORAGE_KEY, StorageScope.APPLICATION, false)) {
				return;
			}
			const restorableCount = this._countRestorableTabs();
			if (restorableCount === 0) {
				return;
			}
			e.veto(this._ask(restorableCount), 'anyagent.restoreTabsPrompt');
		}));
	}

	private _countRestorableTabs(): number {
		const factory = Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory);
		return this._editorService.editors.filter(editor => {
			if (editor.typeId === 'workbench.editors.gettingStartedInput') {
				return false;
			}
			return editor.resource?.scheme === 'file' || !!factory.getEditorSerializer(editor)?.canSerialize(editor);
		}).length;
	}

	/** Resolves to `true` to cancel the close (veto), `false` to continue closing. */
	private async _ask(tabCount: number): Promise<boolean> {
		const { result, checkboxChecked } = await this._dialogService.prompt<boolean | 'cancel'>({
			type: Severity.Info,
			message: localize('restoreTabsPrompt.message', "Reopen your tabs the next time Any Agent starts?"),
			detail: tabCount === 1
				? localize('restoreTabsPrompt.detailOne', "1 open tab (workflow, sub-workflow or ticket) will be restored with the same layout. You can change this later in Settings under 'Workbench \u203A Editor: Restore Editors'.")
				: localize('restoreTabsPrompt.detailMany', "{0} open tabs (workflows, sub-workflows and tickets) will be restored with the same layout. You can change this later in Settings under 'Workbench \u203A Editor: Restore Editors'.", tabCount),
			buttons: [
				{ label: localize({ key: 'restoreTabsPrompt.reopen', comment: ['&& denotes a mnemonic'] }, "&&Reopen Next Time"), run: () => true },
				{ label: localize({ key: 'restoreTabsPrompt.dontReopen', comment: ['&& denotes a mnemonic'] }, "Do&&n't Reopen"), run: () => false }
			],
			cancelButton: { label: localize('restoreTabsPrompt.cancel', "Cancel"), run: () => 'cancel' as const },
			checkbox: { label: localize('restoreTabsPrompt.dontAsk', "Don't ask me again"), checked: false }
		});

		if (result === 'cancel' || result === undefined) {
			return true; // keep the window open
		}

		try {
			if (this._configurationService.getValue<boolean>(RESTORE_EDITORS_SETTING) !== result) {
				await this._configurationService.updateValue(RESTORE_EDITORS_SETTING, result, ConfigurationTarget.USER);
			}
		} catch (err) {
			console.error('[RestoreTabsPrompt] Failed to update restore setting:', err);
		}
		if (checkboxChecked) {
			this._storageService.store(DONT_ASK_STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
		}
		return false;
	}
}

registerWorkbenchContribution2(RestoreTabsPromptContribution.ID, RestoreTabsPromptContribution, WorkbenchPhase.AfterRestored);
