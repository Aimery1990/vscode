/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
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

const chatIcon = registerIcon('centered-chat-icon', Codicon.sparkleFilled, localize('chatIcon', 'Icon for centered AI chat central.'));
const TOGGLE_CENTERED_CHAT_COMMAND_ID = 'workbench.action.chat.toggleCenteredChatPopup';
const OPEN_DEFAULT_BROWSER_TAB_COMMAND_ID = 'workbench.action.browser.openDefaultTab';

// Decoupled communication event for title bar click triggers
const onToggleCenteredChat = new Emitter<any>();

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

	run(accessor: ServicesAccessor, ...args: any[]): void {
		onToggleCenteredChat.fire(args[0]);
	}
}

class OpenDefaultBrowserTabAction extends Action2 {
	constructor() {
		super({
			id: OPEN_DEFAULT_BROWSER_TAB_COMMAND_ID,
			title: localize2('openDefaultBrowserTabBtn', "New Tab"),
			icon: Codicon.globe,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyB,
				weight: KeybindingWeight.WorkbenchContrib
			},
			menu: {
				id: MenuId.TitleBarAdjacentCenter,
				order: -1000 // Right next to Agent Central (-1001)
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		const defaultUrl = 'https://www.google.com';
		try {
			await commandService.executeCommand('workbench.action.browser.open', defaultUrl);
		} catch {
			try {
				await commandService.executeCommand('simpleBrowser.api.open', URI.parse(defaultUrl));
			} catch {
				await commandService.executeCommand('simpleBrowser.show', defaultUrl);
			}
		}
	}
}

// Register action statically at module load time
registerAction2(ToggleCenteredChatAction);
registerAction2(OpenDefaultBrowserTabAction);

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

		const icon = append(container, $('span.centered-chat-titlebar-widget-icon'));
		icon.setAttribute('aria-hidden', 'true');

		const labelEl = append(container, $('span.centered-chat-titlebar-widget-label'));
		labelEl.textContent = label;
	}
}

class NewBrowserTabTitleBarWidget extends BaseActionViewItem {
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

		container.classList.add('new-browser-tab-titlebar-widget');
		container.setAttribute('role', 'button');

		const hoverText = this.keybindingService.appendKeybinding(localize('newBrowserTabHover', "New Browser Tab (Google)"), OPEN_DEFAULT_BROWSER_TAB_COMMAND_ID);
		container.setAttribute('aria-label', hoverText);
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), container, hoverText));

		const icon = append(container, $('span.new-browser-tab-titlebar-widget-icon' + ThemeIcon.asCSSSelector(Codicon.globe)));
		icon.setAttribute('aria-hidden', 'true');

		const labelEl = append(container, $('span.new-browser-tab-titlebar-widget-label'));
		labelEl.textContent = 'New Tab';
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
		this._register(onToggleCenteredChat.event((context) => {
			this.widget.toggle(context);
		}));

		// Register the view item mapping
		this._register(actionViewItemService.register(MenuId.TitleBarAdjacentCenter, TOGGLE_CENTERED_CHAT_COMMAND_ID, (action, options) => {
			return this.instantiationService.createInstance(CenteredChatTitleBarWidget, action, options);
		}, undefined));

		// Register Browser New Tab view item mapping
		this._register(actionViewItemService.register(MenuId.TitleBarAdjacentCenter, OPEN_DEFAULT_BROWSER_TAB_COMMAND_ID, (action, options) => {
			return this.instantiationService.createInstance(NewBrowserTabTitleBarWidget, action, options);
		}, undefined));
	}

	override dispose(): void {
		this.widget.dispose();
		super.dispose();
	}
}

// Register early in BlockRestore phase
registerWorkbenchContribution2(CenteredChatContribution.ID, CenteredChatContribution, WorkbenchPhase.BlockRestore);
