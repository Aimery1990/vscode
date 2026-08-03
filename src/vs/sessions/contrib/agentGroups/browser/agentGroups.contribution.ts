/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IViewDescriptor, IViewsRegistry, Extensions as ViewContainerExtensions, WindowEnablement, ViewContainer, IViewContainersRegistry, ViewContainerLocation } from '../../../../workbench/common/views.js';
import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { AgentGroupsView, AgentGroupsViewId } from './agentGroupsView.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { createOrEditAgentDialog } from '../../../../workbench/contrib/agentsManager/browser/agentEditorDialog.js';

const agentGroupsViewIcon = registerIcon('agent-groups-icon', Codicon.organization, localize('agentGroupsViewIcon', 'Icon for Agent Groups View'));
const AGENT_GROUPS_VIEW_TITLE = localize2('agentGroups.view.label', "Agent Groups");
const AgentGroupsContainerId = 'agentic.workbench.view.agentGroupsContainer';

const agentGroupsViewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: AgentGroupsContainerId,
	title: AGENT_GROUPS_VIEW_TITLE,
	icon: agentGroupsViewIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [AgentGroupsContainerId, { mergeViewWithContainerWhenSingleView: true, }]),
	storageId: AgentGroupsContainerId,
	hideIfEmpty: false,
	order: 7, // Mount underneath Sessions (order 6)
	openCommandActionDescriptor: {
		id: AgentGroupsContainerId,
		mnemonicTitle: localize({ key: 'miAgentGroups', comment: ['&& denotes a mnemonic'] }, "&&Agent Groups"),
		keybindings: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyY },
		order: 0
	},
	windowEnablement: WindowEnablement.Both
}, ViewContainerLocation.Sidebar, { isDefault: true });

const agentGroupsViewPaneDescriptor: IViewDescriptor = {
	id: AgentGroupsViewId,
	containerIcon: agentGroupsViewIcon,
	containerTitle: AGENT_GROUPS_VIEW_TITLE.value,
	singleViewPaneContainerTitle: AGENT_GROUPS_VIEW_TITLE.value,
	name: AGENT_GROUPS_VIEW_TITLE,
	canToggleVisibility: true,
	canMoveView: false,
	ctorDescriptor: new SyncDescriptor(AgentGroupsView),
	windowEnablement: WindowEnablement.Both
};

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([agentGroupsViewPaneDescriptor], agentGroupsViewContainer);

// Header Title Action (Plus button)
registerAction2(class AddAgentGroupAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.agentGroups.addAgent',
			title: localize2('addAgentGroup', "New Agent / Group"),
			icon: Codicon.plus,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', AgentGroupsViewId),
				group: 'navigation',
				order: 1
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await createOrEditAgentDialog(accessor);
	}
});
