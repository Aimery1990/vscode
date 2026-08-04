/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Any Agent / Google Deepmind. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { AccountManagementDialog } from './accountManagementDialog.js';

export class OpenAccountPanelAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.anyagent.openAccountPanel',
			title: localize2('openAccountPanel', "Account & Security Preferences..."),
			category: localize2('accounts', "Accounts"),
			f1: true,
			menu: {
				id: MenuId.AccountsContext,
				group: '1_anyagent_auth',
				order: 1
			}
		});
	}

	public override run(accessor: ServicesAccessor): void {
		const instantiationService = accessor.get(IInstantiationService);
		const notificationService = accessor.get(INotificationService);
		notificationService.info("Opening Any Agent Account & Security Preferences...");

		const dialog = instantiationService.createInstance(AccountManagementDialog);
		dialog.show('Account');
	}
}

export class SignInOrLogInAction extends Action2 {
	constructor() {
		super({
			id: 'anyagent.signInOrLogIn',
			title: localize2('signInOrLogIn', "Sign In / Log In..."),
			category: localize2('accounts', "Accounts"),
			f1: true
		});
	}

	public override run(accessor: ServicesAccessor): void {
		const instantiationService = accessor.get(IInstantiationService);
		const notificationService = accessor.get(INotificationService);
		notificationService.info("Opening Any Agent Sign In & Account Control Center...");

		const dialog = instantiationService.createInstance(AccountManagementDialog);
		dialog.show('Account');
	}
}

export class AccountPreferencesAction extends Action2 {
	constructor() {
		super({
			id: 'anyagent.accountPreferences',
			title: localize2('accountPreferences', "Account & Security Preferences..."),
			category: localize2('accounts', "Accounts"),
			f1: true
		});
	}

	public override run(accessor: ServicesAccessor): void {
		const instantiationService = accessor.get(IInstantiationService);
		const notificationService = accessor.get(INotificationService);
		notificationService.info("Opening Any Agent Account & Security Preferences...");

		const dialog = instantiationService.createInstance(AccountManagementDialog);
		dialog.show('Account');
	}
}

// Register actions globally at module load time
registerAction2(OpenAccountPanelAction);
registerAction2(SignInOrLogInAction);
registerAction2(AccountPreferencesAction);

// Also register explicitly in CommandsRegistry
CommandsRegistry.registerCommand('anyagent.signInOrLogIn', (accessor: ServicesAccessor) => {
	const instantiationService = accessor.get(IInstantiationService);
	const notificationService = accessor.get(INotificationService);
	notificationService.info("Opening Any Agent Sign In & Account Control Center...");
	const dialog = instantiationService.createInstance(AccountManagementDialog);
	dialog.show('Account');
});

CommandsRegistry.registerCommand('anyagent.accountPreferences', (accessor: ServicesAccessor) => {
	const instantiationService = accessor.get(IInstantiationService);
	const notificationService = accessor.get(INotificationService);
	notificationService.info("Opening Any Agent Account & Security Preferences...");
	const dialog = instantiationService.createInstance(AccountManagementDialog);
	dialog.show('Account');
});

export class AccountManagementContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.accountManagement';

	constructor() {
		super();
	}
}

registerWorkbenchContribution2(
	AccountManagementContribution.ID,
	AccountManagementContribution,
	WorkbenchPhase.AfterRestored
);
