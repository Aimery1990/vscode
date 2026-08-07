/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Any Agent / Google Deepmind. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';

import { AccountManagementDialog } from './accountManagementDialog.js';
import { AccountSignInModal } from './accountSignInModal.js';

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
		const modal = instantiationService.createInstance(AccountSignInModal);
		modal.show();
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
	const modal = instantiationService.createInstance(AccountSignInModal);
	modal.show();
});

CommandsRegistry.registerCommand('anyagent.accountPreferences', (accessor: ServicesAccessor) => {
	const instantiationService = accessor.get(IInstantiationService);
	const dialog = instantiationService.createInstance(AccountManagementDialog);
	dialog.show('Account');
});

export class AccountManagementContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.accountManagement';

	private activeModal: AccountSignInModal | undefined;

	constructor(
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();

		this._register(this.authenticationService.onDidChangeSessions(() => this.checkAuthenticationState()));
		this._register(this.authenticationService.onDidRegisterAuthenticationProvider(() => this.checkAuthenticationState()));

		// Check initial authentication state
		this.checkAuthenticationState();
	}

	private async checkAuthenticationState(): Promise<void> {
		try {
			const providers = ['google', 'github', 'microsoft', 'apple', ...this.authenticationService.declaredProviders.map(p => p.id)];
			const uniqueProviders = Array.from(new Set(providers));
			let hasActiveSession = false;

			for (const providerId of uniqueProviders) {
				try {
					const sessions = await this.authenticationService.getSessions(providerId);
					if (sessions && sessions.length > 0) {
						hasActiveSession = true;
						break;
					}
				} catch {
					// Ignore unsupported/unregistered providers
				}
			}

			if (!hasActiveSession) {
				if (!this.activeModal) {
					this.activeModal = this.instantiationService.createInstance(AccountSignInModal);
					this.activeModal.show(true); // force = true
				}
			} else {
				if (this.activeModal) {
					this.activeModal.close();
					this.activeModal = undefined;
				}
			}
		} catch (err) {
			console.error('Failed to check authentication state in AccountManagementContribution:', err);
		}
	}
}

registerWorkbenchContribution2(
	AccountManagementContribution.ID,
	AccountManagementContribution,
	WorkbenchPhase.AfterRestored
);
