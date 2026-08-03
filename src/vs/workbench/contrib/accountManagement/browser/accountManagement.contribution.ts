/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Any Agent / Google Deepmind. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
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
				order: 2
			}
		});
	}

	public override run(accessor: ServicesAccessor): void {
		const instantiationService = accessor.get(IInstantiationService);
		const dialog = instantiationService.createInstance(AccountManagementDialog);
		dialog.show('auth');
	}
}

export class SignInOrAccountStatusAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.anyagent.signInOrAccountStatus',
			title: localize2('signInOrAccountStatus', "Sign In / Account Status (Any Agent)"),
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
		dialog.show('auth');
	}
}

export class AccountManagementContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.accountManagement';

	constructor() {
		super();
		this._registerActions();
	}

	private _registerActions(): void {
		this._register(registerAction2(SignInOrAccountStatusAction));
		this._register(registerAction2(OpenAccountPanelAction));
	}
}

registerWorkbenchContribution2(
	AccountManagementContribution.ID,
	AccountManagementContribution,
	WorkbenchPhase.AfterRestored
);
