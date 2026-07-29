/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { CenteredChatWidget } from './centeredChatWidget.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IAction } from '../../../../base/common/actions.js';
import { $, append } from '../../../../base/browser/dom.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Emitter } from '../../../../base/common/event.js';

const chatIcon = registerIcon('centered-chat-icon', Codicon.sparkle, localize('chatIcon', 'Icon for centered AI chat central.'));
const TOGGLE_CENTERED_CHAT_COMMAND_ID = 'workbench.action.chat.toggleCenteredChatPopup';

// Decoupled communication event for title bar click triggers
const onToggleCenteredChat = new Emitter<void>();

class ToggleCenteredChatAction extends Action2 {
	constructor() {
		super({
			id: TOGGLE_CENTERED_CHAT_COMMAND_ID,
			title: localize2('toggleCenteredChatBtn', "Agent Central"),
			icon: chatIcon,
			f1: true,
			menu: {
				id: MenuId.TitleBarAdjacentCenter,
				order: -1001 // Left of Open in Agents (-1000)
			}
		});
	}

	run(accessor: ServicesAccessor): void {
		onToggleCenteredChat.fire();
	}
}

// Register action statically at module load time
registerAction2(ToggleCenteredChatAction);

class CenteredChatTitleBarWidget extends BaseActionViewItem {
	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		@IHoverService private readonly hoverService: IHoverService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);

		container.classList.add('centered-chat-titlebar-widget');
		container.setAttribute('role', 'button');

		const label = this.action.label;
		const hoverText = this.keybindingService.appendKeybinding(localize('centeredChatHover', "Agent Central"), TOGGLE_CENTERED_CHAT_COMMAND_ID);
		container.setAttribute('aria-label', hoverText);
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), container, hoverText));

		const icon = append(container, $('span.centered-chat-titlebar-widget-icon.codicon.codicon-sparkle'));
		icon.setAttribute('aria-hidden', 'true');

		const labelEl = append(container, $('span.centered-chat-titlebar-widget-label'));
		labelEl.textContent = label;
	}
}

export class CenteredChatContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.centeredChat';

	private readonly widget: CenteredChatWidget;

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();
		this.widget = this.instantiationService.createInstance(CenteredChatWidget);

		// Subscribe to the menu click event triggers
		this._register(onToggleCenteredChat.event(() => {
			this.widget.toggle();
		}));

		// Register the view item mapping
		this._register(actionViewItemService.register(MenuId.TitleBarAdjacentCenter, TOGGLE_CENTERED_CHAT_COMMAND_ID, (action, options) => {
			return this.instantiationService.createInstance(CenteredChatTitleBarWidget, action, options);
		}, undefined));
	}

	override dispose(): void {
		this.widget.dispose();
		super.dispose();
	}
}

// Register early in BlockRestore phase
registerWorkbenchContribution2(CenteredChatContribution.ID, CenteredChatContribution, WorkbenchPhase.BlockRestore);
