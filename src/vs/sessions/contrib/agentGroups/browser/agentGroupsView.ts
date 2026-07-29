/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All implementation rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentGroups.css';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { append, $ } from '../../../../base/browser/dom.js';

export const AgentGroupsViewId = 'agentic.workbench.view.agentGroups';

export class AgentGroupsView extends ViewPane {

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);

		parent.classList.add('agent-groups-viewpane');

		// Create a premium placeholder container
		const container = append(parent, $('.agent-groups-container'));

		const icon = append(container, $('.agent-groups-placeholder-icon'));
		icon.className = 'codicon codicon-organization';

		const title = append(container, $('.agent-groups-placeholder-title'));
		title.textContent = 'Agent Groups Coordination';

		const desc = append(container, $('.agent-groups-placeholder-desc'));
		desc.textContent = 'Manage, collaborate, and orchestrate multiple AI agents in structured organization structures here.';
	}
}
