/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainer, ViewContainerLocation, IViewDescriptor } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';

import { IAgentsManagerService } from '../common/agentsManager.js';
import { AgentsManagerService } from './agentsManagerService.js';
import { AgentsManagerPane } from './agentsManagerPane.js';
import { createOrEditAgentDialog } from './agentEditorDialog.js';

export const AGENTS_MANAGER_VIEWLET_ID = 'workbench.view.agentsManager';
export const AGENTS_MANAGER_PANE_VIEW_ID = 'workbench.view.agentsManagerPane';

// 1. Register Singleton Service
registerSingleton(IAgentsManagerService, AgentsManagerService, InstantiationType.Delayed);

// 2. Register Icon
const agentsManagerIcon = registerIcon(
	'agents-manager-view-icon',
	Codicon.robot,
	localize('agentsManagerIcon', 'View icon of the AI Agents Manager view.')
);

// 3. Register View Container (order: 2 places it right after Workspaces & Explorer)
const viewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: AGENTS_MANAGER_VIEWLET_ID,
	title: localize2('agentsManager', "AI Agents"),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [AGENTS_MANAGER_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: false }]),
	storageId: 'workbench.agentsManager.views.state',
	icon: agentsManagerIcon,
	hideIfEmpty: false,
	order: 2,
	openCommandActionDescriptor: {
		id: AGENTS_MANAGER_VIEWLET_ID,
		title: localize2('agentsManager', "AI Agents"),
		mnemonicTitle: localize({ key: 'miViewAgentsManager', comment: ['&& denotes a mnemonic'] }, "&&AI Agents"),
		keybindings: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA },
		order: 2
	}
}, ViewContainerLocation.Sidebar, { isDefault: true });

// 4. Register 6 Native View Panes under AI AGENTS Viewlet
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

const viewDescriptors: IViewDescriptor[] = [
	{
		id: 'workbench.view.agentsManager.all',
		name: localize2('agentsCentralAll', "All Agents"),
		ctorDescriptor: new SyncDescriptor(AgentsManagerPane),
		order: 1,
		canToggleVisibility: true,
		canMoveView: true,
		containerIcon: agentsManagerIcon
	},
	{
		id: 'workbench.view.agentsManager.workspace',
		name: localize2('agentsCentralWorkspace', "Workspace Agents"),
		ctorDescriptor: new SyncDescriptor(AgentsManagerPane),
		order: 2,
		canToggleVisibility: true,
		canMoveView: true,
		containerIcon: Codicon.globe
	},
	{
		id: 'workbench.view.agentsManager.project',
		name: localize2('agentsCentralProject', "Project Agents"),
		ctorDescriptor: new SyncDescriptor(AgentsManagerPane),
		order: 3,
		canToggleVisibility: true,
		canMoveView: true,
		containerIcon: Codicon.folder
	},
	{
		id: 'workbench.view.agentsManager.job',
		name: localize2('agentsCentralJob', "Job Agents"),
		ctorDescriptor: new SyncDescriptor(AgentsManagerPane),
		order: 4,
		canToggleVisibility: true,
		canMoveView: true,
		containerIcon: Codicon.target
	},
	{
		id: 'workbench.view.agentsManager.workflow',
		name: localize2('agentsCentralWorkflow', "Workflow Agents"),
		ctorDescriptor: new SyncDescriptor(AgentsManagerPane),
		order: 5,
		canToggleVisibility: true,
		canMoveView: true,
		containerIcon: Codicon.sync
	},
	{
		id: 'workbench.view.agentsManager.standalone',
		name: localize2('agentsCentralStandalone', "Standalone / Global Agents"),
		ctorDescriptor: new SyncDescriptor(AgentsManagerPane),
		order: 6,
		canToggleVisibility: true,
		canMoveView: true,
		containerIcon: Codicon.circleSlash
	}
];

viewsRegistry.registerViews(viewDescriptors, viewContainer);

// 5. Register Header Action Icons
for (const vd of viewDescriptors) {
	registerAction2(class AddAgentAction extends Action2 {
		constructor() {
			super({
				id: `workbench.action.agentsManager.addAgent.${vd.id}`,
				title: localize2('addAgent', "New AI Agent"),
				icon: Codicon.plus,
				menu: {
					id: MenuId.ViewTitle,
					when: ContextKeyExpr.equals('view', vd.id),
					group: 'navigation',
					order: 1
				}
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			await createOrEditAgentDialog(accessor);
		}
	});
}
