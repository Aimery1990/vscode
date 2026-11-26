/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { AccountManagementDialog } from './accountManagementDialog.js';
import { AccountSignInModal } from './accountSignInModal.js';

// Account commands for the Agents (sessions) window, whose global composite bar invokes
// `anyagent.signInOrLogIn` / `anyagent.accountPreferences` by id but which does not load
// accountManagement.contribution.ts. In the main workbench these ids are registered as Action2
// by that contribution, so this module must ONLY be imported from sessions.common.main.ts —
// importing it in the main workbench throws "Cannot register two commands with the same id".

CommandsRegistry.registerCommand('anyagent.signInOrLogIn', (accessor: ServicesAccessor) => {
	const instantiationService = accessor.get(IInstantiationService);
	const modal = instantiationService.createInstance(AccountSignInModal);
	modal.show();
});

CommandsRegistry.registerCommand('anyagent.accountPreferences', (accessor: ServicesAccessor) => {
	const instantiationService = accessor.get(IInstantiationService);
	const dialog = instantiationService.createInstance(AccountManagementDialog);
	dialog.show('Account');
});
