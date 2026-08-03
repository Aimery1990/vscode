/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AnyAgent / Google Deepmind. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';

export class GoogleSignInAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.anyagent.googleSignIn',
			title: localize2('googleSignIn', "Sign in with Google (AnyAgent)"),
			category: localize2('accounts', "Accounts"),
			f1: true,
			menu: {
				id: MenuId.AccountsContext,
				group: '1_anyagent_auth',
				order: 1
			}
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		const notificationService = accessor.get(INotificationService);
		const authenticationService = accessor.get(IAuthenticationService);

		try {
			// Trigger authentication command or provider session request
			const sessions = await authenticationService.getSessions('google');
			if (sessions.length > 0) {
				notificationService.info(localize('alreadySignedIn', "Already signed in to Google as {0}", sessions[0].account.label));
			} else {
				await commandService.executeCommand('anyagent.google.login');
			}
		} catch (err: any) {
			// Fallback execute command if provider registered via extension
			try {
				await commandService.executeCommand('anyagent.google.login');
			} catch (e: any) {
				notificationService.notify({
					severity: Severity.Error,
					message: localize('googleSignInError', "Failed to launch Google Sign-In: {0}", err.message || e.message)
				});
			}
		}
	}
}

export class GoogleSignOutAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.anyagent.googleSignOut',
			title: localize2('googleSignOut', "Sign out of Google (AnyAgent)"),
			category: localize2('accounts', "Accounts"),
			f1: true
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		await commandService.executeCommand('anyagent.google.logout');
	}
}

export class GoogleAuthenticationContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.googleAuthentication';

	constructor() {
		super();
		this._registerActions();
	}

	private _registerActions(): void {
		this._register(registerAction2(GoogleSignInAction));
		this._register(registerAction2(GoogleSignOutAction));
	}
}

registerWorkbenchContribution2(
	GoogleAuthenticationContribution.ID,
	GoogleAuthenticationContribution,
	WorkbenchPhase.AfterRestored
);
