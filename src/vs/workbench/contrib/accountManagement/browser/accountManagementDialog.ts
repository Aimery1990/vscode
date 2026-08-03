/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Any Agent / Google Deepmind. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';

export type AccountPanelTab = 'auth' | 'extensions' | 'models';

export class AccountManagementDialog extends Disposable {
	private container: HTMLElement | undefined;
	private activeTab: AccountPanelTab = 'auth';

	constructor(
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService
	) {
		super();
	}

	public async show(initialTab: AccountPanelTab = 'auth'): Promise<void> {
		this.activeTab = initialTab;
		this.createModal();
	}

	private async createModal(): Promise<void> {
		if (this.container) {
			this.container.remove();
		}

		// Overlay
		const overlay = document.createElement('div');
		overlay.className = 'anyagent-account-modal-overlay';
		overlay.style.cssText = `
			position: fixed;
			top: 0;
			left: 0;
			width: 100vw;
			height: 100vh;
			background: rgba(0, 0, 0, 0.65);
			backdrop-filter: blur(8px);
			z-index: 10000;
			display: flex;
			align-items: center;
			justify-content: center;
			animation: fadeIn 0.2s ease-out;
		`;

		// Modal Container
		const modal = document.createElement('div');
		modal.className = 'anyagent-account-modal';
		modal.style.cssText = `
			width: 760px;
			height: 520px;
			background: #1e1e1e;
			border: 1px solid #333333;
			border-radius: 12px;
			box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
			display: flex;
			flex-direction: column;
			overflow: hidden;
			color: #cccccc;
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
		`;

		// Modal Header
		const header = document.createElement('div');
		header.style.cssText = `
			padding: 16px 24px;
			background: #252526;
			border-bottom: 1px solid #333333;
			display: flex;
			align-items: center;
			justify-content: space-between;
		`;

		const title = document.createElement('div');
		title.style.cssText = `
			font-size: 16px;
			font-weight: 600;
			color: #ffffff;
			display: flex;
			align-items: center;
			gap: 8px;
		`;
		title.innerHTML = `<span style="color:#38bdf8;">✦</span> Any Agent Account & Control Center`;

		const closeBtn = document.createElement('button');
		closeBtn.innerHTML = '✕';
		closeBtn.style.cssText = `
			background: transparent;
			border: none;
			color: #888888;
			font-size: 16px;
			cursor: pointer;
			padding: 4px 8px;
			border-radius: 4px;
			transition: all 0.15s ease;
		`;
		closeBtn.onmouseenter = () => closeBtn.style.color = '#ffffff';
		closeBtn.onmouseleave = () => closeBtn.style.color = '#888888';
		closeBtn.onclick = () => overlay.remove();

		header.appendChild(title);
		header.appendChild(closeBtn);
		modal.appendChild(header);

		// Modal Body (Split view)
		const body = document.createElement('div');
		body.style.cssText = `
			flex: 1;
			display: flex;
			overflow: hidden;
		`;

		// Sidebar Nav
		const sidebar = document.createElement('div');
		sidebar.style.cssText = `
			width: 220px;
			background: #181818;
			border-right: 1px solid #2d2d2d;
			padding: 16px 12px;
			display: flex;
			flex-direction: column;
			gap: 6px;
		`;

		const navItems: { id: AccountPanelTab; label: string; icon: string }[] = [
			{ id: 'auth', label: 'Auth Providers', icon: '🔑' },
			{ id: 'extensions', label: 'Extension Permissions', icon: '🧩' },
			{ id: 'models', label: 'Language Models', icon: '🤖' }
		];

		const contentArea = document.createElement('div');
		contentArea.style.cssText = `
			flex: 1;
			padding: 24px;
			overflow-y: auto;
			background: #1e1e1e;
		`;

		const renderNav = () => {
			sidebar.innerHTML = '';
			navItems.forEach(item => {
				const btn = document.createElement('button');
				const isActive = this.activeTab === item.id;
				btn.style.cssText = `
					display: flex;
					align-items: center;
					gap: 10px;
					padding: 10px 14px;
					border: none;
					border-radius: 6px;
					background: ${isActive ? '#2a2d2e' : 'transparent'};
					color: ${isActive ? '#ffffff' : '#aaaaaa'};
					font-weight: ${isActive ? '600' : '400'};
					font-size: 13px;
					cursor: pointer;
					text-align: left;
					transition: all 0.15s ease;
				`;
				btn.innerHTML = `<span>${item.icon}</span> <span>${item.label}</span>`;
				btn.onclick = () => {
					this.activeTab = item.id;
					renderNav();
					this.renderContent(contentArea);
				};
				sidebar.appendChild(btn);
			});
		};

		renderNav();
		this.renderContent(contentArea);

		body.appendChild(sidebar);
		body.appendChild(contentArea);
		modal.appendChild(body);
		overlay.appendChild(modal);

		// Close on clicking outside modal
		overlay.onclick = (e) => {
			if (e.target === overlay) {
				overlay.remove();
			}
		};

		document.body.appendChild(overlay);
		this.container = overlay;
	}

	private async renderContent(container: HTMLElement): Promise<void> {
		container.innerHTML = '';

		if (this.activeTab === 'auth') {
			await this.renderAuthTab(container);
		} else if (this.activeTab === 'extensions') {
			await this.renderExtensionsTab(container);
		} else if (this.activeTab === 'models') {
			await this.renderModelsTab(container);
		}
	}

	private async renderAuthTab(container: HTMLElement): Promise<void> {
		const title = document.createElement('h3');
		title.style.cssText = `margin: 0 0 8px 0; font-size: 16px; color: #ffffff; font-weight: 600;`;
		title.textContent = 'Authentication Providers';

		const subtitle = document.createElement('p');
		subtitle.style.cssText = `margin: 0 0 20px 0; font-size: 12px; color: #888888;`;
		subtitle.textContent = 'Manage connected identity providers for Any Agent services.';

		container.appendChild(title);
		container.appendChild(subtitle);

		// Check Google Session
		const googleSessions = await this.authenticationService.getSessions('google');
		const isGoogleConnected = googleSessions.length > 0;
		const googleAccount = isGoogleConnected ? googleSessions[0].account.label : undefined;

		// Cards Grid
		const grid = document.createElement('div');
		grid.style.cssText = `display: flex; flex-direction: column; gap: 12px;`;

		// Provider 1: Google
		grid.appendChild(this.createProviderCard(
			'Google',
			'Access Google Cloud & Any Agent services.',
			isGoogleConnected,
			googleAccount,
			'#ea4335',
			isGoogleConnected ? 'Sign Out' : 'Sign in with Google',
			async () => {
				if (isGoogleConnected) {
					await this.commandService.executeCommand('anyagent.google.logout');
				} else {
					await this.commandService.executeCommand('anyagent.google.login');
				}
				this.renderAuthTab(container);
			}
		));

		// Provider 2: GitHub
		grid.appendChild(this.createProviderCard(
			'GitHub',
			'Connect your GitHub repositories & workspace sync.',
			false,
			undefined,
			'#24292e',
			'Sign in with GitHub',
			async () => {
				this.notificationService.info('GitHub Authentication integration ready in config.');
			}
		));

		// Provider 3: Microsoft
		grid.appendChild(this.createProviderCard(
			'Microsoft',
			'Connect Azure & Microsoft 365 identity.',
			false,
			undefined,
			'#00a4ef',
			'Sign in with Microsoft',
			async () => {
				this.notificationService.info('Microsoft Authentication integration ready in config.');
			}
		));

		container.appendChild(grid);
	}

	private createProviderCard(
		name: string,
		desc: string,
		isConnected: boolean,
		accountLabel: string | undefined,
		_accentColor: string,
		actionText: string,
		onAction: () => void
	): HTMLElement {
		const card = document.createElement('div');
		card.style.cssText = `
			background: #252526;
			border: 1px solid #333333;
			border-radius: 8px;
			padding: 16px;
			display: flex;
			align-items: center;
			justify-content: space-between;
			transition: border-color 0.15s ease;
		`;

		const left = document.createElement('div');
		left.style.cssText = `display: flex; flex-direction: column; gap: 4px;`;

		const headerRow = document.createElement('div');
		headerRow.style.cssText = `display: flex; align-items: center; gap: 10px;`;

		const nameEl = document.createElement('span');
		nameEl.style.cssText = `font-size: 14px; font-weight: 600; color: #ffffff;`;
		nameEl.textContent = name;

		const badge = document.createElement('span');
		badge.style.cssText = `
			font-size: 11px;
			padding: 2px 8px;
			border-radius: 12px;
			background: ${isConnected ? 'rgba(34, 197, 94, 0.15)' : 'rgba(255, 255, 255, 0.08)'};
			color: ${isConnected ? '#4ade80' : '#888888'};
			border: 1px solid ${isConnected ? 'rgba(34, 197, 94, 0.3)' : 'rgba(255, 255, 255, 0.1)'};
		`;
		badge.textContent = isConnected ? 'Connected' : 'Not Connected';

		headerRow.appendChild(nameEl);
		headerRow.appendChild(badge);
		left.appendChild(headerRow);

		const descEl = document.createElement('span');
		descEl.style.cssText = `font-size: 12px; color: #aaaaaa;`;
		descEl.textContent = isConnected && accountLabel ? `Account: ${accountLabel}` : desc;
		left.appendChild(descEl);

		const actionBtn = document.createElement('button');
		actionBtn.style.cssText = `
			background: ${isConnected ? '#333333' : '#007acc'};
			color: #ffffff;
			border: none;
			border-radius: 4px;
			padding: 8px 14px;
			font-size: 12px;
			font-weight: 500;
			cursor: pointer;
			transition: opacity 0.15s ease;
		`;
		actionBtn.textContent = actionText;
		actionBtn.onclick = onAction;

		card.appendChild(left);
		card.appendChild(actionBtn);

		return card;
	}

	private async renderExtensionsTab(container: HTMLElement): Promise<void> {
		const title = document.createElement('h3');
		title.style.cssText = `margin: 0 0 8px 0; font-size: 16px; color: #ffffff; font-weight: 600;`;
		title.textContent = 'Extension Account Preferences';

		const subtitle = document.createElement('p');
		subtitle.style.cssText = `margin: 0 0 20px 0; font-size: 12px; color: #888888;`;
		subtitle.textContent = 'Configure account credentials used by individual installed extensions.';

		container.appendChild(title);
		container.appendChild(subtitle);

		const manageBtn = document.createElement('button');
		manageBtn.style.cssText = `
			background: #252526;
			border: 1px solid #3c3c3c;
			color: #ffffff;
			padding: 10px 16px;
			border-radius: 6px;
			font-size: 13px;
			cursor: pointer;
		`;
		manageBtn.textContent = '⚙ Manage Extension Account Preferences...';
		manageBtn.onclick = async () => {
			await this.commandService.executeCommand('workbench.action.manageAccountPreferencesForExtension');
		};

		container.appendChild(manageBtn);
	}

	private async renderModelsTab(container: HTMLElement): Promise<void> {
		const title = document.createElement('h3');
		title.style.cssText = `margin: 0 0 8px 0; font-size: 16px; color: #ffffff; font-weight: 600;`;
		title.textContent = 'Language Model Access Permissions';

		const subtitle = document.createElement('p');
		subtitle.style.cssText = `margin: 0 0 20px 0; font-size: 12px; color: #888888;`;
		subtitle.textContent = 'Control which extensions are granted access to language models & tokens.';

		container.appendChild(title);
		container.appendChild(subtitle);

		const manageBtn = document.createElement('button');
		manageBtn.style.cssText = `
			background: #252526;
			border: 1px solid #3c3c3c;
			color: #ffffff;
			padding: 10px 16px;
			border-radius: 6px;
			font-size: 13px;
			cursor: pointer;
		`;
		manageBtn.textContent = '🛡 Manage Language Model Access Permissions...';
		manageBtn.onclick = async () => {
			await this.commandService.executeCommand('workbench.action.manageTrustedExtensionsForAccount');
		};

		container.appendChild(manageBtn);
	}
}
