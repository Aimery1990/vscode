/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Any Agent / Google Deepmind. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { getActiveWindow } from '../../../../base/browser/dom.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';

export type AccountPanelTab = 'Account' | 'General' | 'Permissions' | 'Appearance' | 'Models' | 'Customizations';

export class AccountManagementDialog extends Disposable {
	private container: HTMLElement | undefined;
	private activeTab: AccountPanelTab = 'Account';

	constructor(
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService
	) {
		super();
	}

	public close(): void {
		if (this.container) {
			this.container.remove();
			this.container = undefined;
		}
	}

	public async show(initialTab: AccountPanelTab = 'Account'): Promise<void> {
		this.activeTab = initialTab;
		this.createModal();
	}

	private async createModal(): Promise<void> {
		const targetDocument = getActiveWindow().document;

		// Remove any existing modal
		const existing = targetDocument.querySelector('.anyagent-account-modal-overlay');
		if (existing) {
			existing.remove();
		}

		// Overlay
		const overlay = targetDocument.createElement('div');
		overlay.className = 'anyagent-account-modal-overlay';
		overlay.style.cssText = `
			position: fixed;
			top: 0;
			left: 0;
			width: 100vw;
			height: 100vh;
			background: rgba(0, 0, 0, 0.75);
			backdrop-filter: blur(12px);
			-webkit-backdrop-filter: blur(12px);
			z-index: 999999;
			display: flex;
			align-items: center;
			justify-content: center;
			animation: anyagentFadeIn 0.15s ease-out;
		`;

		// Keyframe style if not injected
		if (!targetDocument.getElementById('anyagent-modal-styles')) {
			const style = targetDocument.createElement('style');
			style.id = 'anyagent-modal-styles';
			style.textContent = `
				@keyframes anyagentFadeIn {
					from { opacity: 0; transform: scale(0.98); }
					to { opacity: 1; transform: scale(1); }
				}
			`;
			targetDocument.head.appendChild(style);
		}

		// Main Panel Container (Antigravity IDE Layout)
		const modal = targetDocument.createElement('div');
		modal.className = 'anyagent-account-modal';
		modal.style.cssText = `
			width: 900px;
			height: 620px;
			background: #141414;
			border: 1px solid #2d2d2d;
			border-radius: 12px;
			box-shadow: 0 24px 64px rgba(0, 0, 0, 0.7);
			display: flex;
			flex-direction: column;
			overflow: hidden;
			color: #e1e1e1;
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
		`;

		// Header Bar
		const header = targetDocument.createElement('div');
		header.style.cssText = `
			padding: 14px 24px;
			background: #1a1a1a;
			border-bottom: 1px solid #2a2a2a;
			display: flex;
			align-items: center;
			justify-content: space-between;
		`;

		const title = targetDocument.createElement('div');
		title.style.cssText = `
			font-size: 14px;
			font-weight: 600;
			color: #888888;
			letter-spacing: 0.3px;
		`;
		title.innerHTML = `Settings <span style="color:#555555;margin:0 6px;">—</span> <span style="color:#ffffff;" id="anyagent-panel-tab-title">${this.activeTab}</span>`;

		const closeBtn = targetDocument.createElement('button');
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
		closeBtn.onmouseenter = () => { closeBtn.style.color = '#ffffff'; closeBtn.style.background = '#2a2a2a'; };
		closeBtn.onmouseleave = () => { closeBtn.style.color = '#888888'; closeBtn.style.background = 'transparent'; };
		closeBtn.onclick = () => overlay.remove();

		header.appendChild(title);
		header.appendChild(closeBtn);
		modal.appendChild(header);

		// Split Body Area
		const body = targetDocument.createElement('div');
		body.style.cssText = `
			flex: 1;
			display: flex;
			overflow: hidden;
		`;

		// Left Navigation Sidebar (Antigravity Style)
		const sidebar = targetDocument.createElement('div');
		sidebar.style.cssText = `
			width: 210px;
			background: #111111;
			border-right: 1px solid #262626;
			padding: 16px 10px;
			display: flex;
			flex-direction: column;
			gap: 4px;
			overflow-y: auto;
		`;

		const navGroups: { section: string; items: { id: AccountPanelTab; label: string }[] }[] = [
			{
				section: 'Settings',
				items: [
					{ id: 'General', label: 'General' },
					{ id: 'Account', label: 'Account' },
					{ id: 'Permissions', label: 'Permissions' },
					{ id: 'Appearance', label: 'Appearance' },
					{ id: 'Models', label: 'Models' },
					{ id: 'Customizations', label: 'Customizations' }
				]
			}
		];

		const contentArea = targetDocument.createElement('div');
		contentArea.style.cssText = `
			flex: 1;
			padding: 28px 36px;
			overflow-y: auto;
			background: #141414;
		`;

		const renderNav = () => {
			sidebar.innerHTML = '';
			navGroups.forEach(group => {
				const groupTitle = targetDocument.createElement('div');
				groupTitle.style.cssText = `font-size: 11px; text-transform: uppercase; color: #555555; font-weight: 600; padding: 6px 12px; margin-top: 4px;`;
				groupTitle.textContent = group.section;
				sidebar.appendChild(groupTitle);

				group.items.forEach(item => {
					const btn = targetDocument.createElement('button');
					const isActive = this.activeTab === item.id;
					btn.style.cssText = `
						display: block;
						width: 100%;
						padding: 8px 12px;
						border: none;
						border-radius: 6px;
						background: ${isActive ? '#242424' : 'transparent'};
						color: ${isActive ? '#ffffff' : '#999999'};
						font-weight: ${isActive ? '600' : '400'};
						font-size: 13px;
						cursor: pointer;
						text-align: left;
						transition: all 0.15s ease;
					`;
					btn.textContent = item.label;
					btn.onclick = () => {
						this.activeTab = item.id;
						const tabTitleEl = targetDocument.getElementById('anyagent-panel-tab-title');
						if (tabTitleEl) tabTitleEl.textContent = item.label;
						renderNav();
						this.renderContent(contentArea, targetDocument);
					};
					sidebar.appendChild(btn);
				});
			});
		};

		renderNav();
		await this.renderContent(contentArea, targetDocument);

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

		targetDocument.body.appendChild(overlay);
	}

	private async renderContent(container: HTMLElement, targetDocument: Document): Promise<void> {
		container.innerHTML = '';

		if (this.activeTab === 'Account') {
			await this.renderAccountTab(container, targetDocument);
		} else if (this.activeTab === 'Permissions') {
			await this.renderPermissionsTab(container, targetDocument);
		} else if (this.activeTab === 'Models') {
			await this.renderModelsTab(container, targetDocument);
		} else {
			await this.renderGenericTab(container, targetDocument, this.activeTab);
		}
	}

	private async renderAccountTab(container: HTMLElement, targetDocument: Document): Promise<void> {
		// Section Title
		const mainTitle = targetDocument.createElement('h2');
		mainTitle.style.cssText = `margin: 0 0 6px 0; font-size: 20px; color: #ffffff; font-weight: 600;`;
		mainTitle.textContent = 'Account & Authentication';

		const mainDesc = targetDocument.createElement('p');
		mainDesc.style.cssText = `margin: 0 0 24px 0; font-size: 13px; color: #888888;`;
		mainDesc.textContent = 'Manage identity providers, active sessions, and account credentials for Any Agent IDE.';

		container.appendChild(mainTitle);
		container.appendChild(mainDesc);

		// Check Active Sessions
		const googleSessions = await this.authenticationService.getSessions('google');
		const isGoogleConnected = googleSessions.length > 0;
		const googleAccount = isGoogleConnected ? googleSessions[0].account.label : undefined;

		// Plan Card (Antigravity Style)
		const planCard = targetDocument.createElement('div');
		planCard.style.cssText = `
			background: #1c1c1c;
			border: 1px solid #2a2a2a;
			border-radius: 8px;
			padding: 16px 20px;
			margin-bottom: 24px;
			display: flex;
			align-items: center;
			justify-content: space-between;
		`;

		const planLeft = targetDocument.createElement('div');
		planLeft.innerHTML = `
			<div style="font-size:12px;color:#888888;margin-bottom:4px;">Active Plan</div>
			<div style="font-size:15px;font-weight:600;color:#ffffff;">Any Agent AI Pro Plan</div>
		`;

		const planBtn = targetDocument.createElement('button');
		planBtn.style.cssText = `
			background: #38bdf8;
			color: #0f172a;
			border: none;
			border-radius: 6px;
			padding: 8px 16px;
			font-size: 12px;
			font-weight: 600;
			cursor: pointer;
		`;
		planBtn.textContent = 'Upgrade Plan';
		planBtn.onclick = () => {
			this.notificationService.info('Any Agent Pro Plan is active.');
		};

		planCard.appendChild(planLeft);
		planCard.appendChild(planBtn);
		container.appendChild(planCard);

		// Identity Providers Section
		const providerTitle = targetDocument.createElement('div');
		providerTitle.style.cssText = `font-size: 14px; font-weight: 600; color: #ffffff; margin-bottom: 12px;`;
		providerTitle.textContent = 'Connected Identity Providers';
		container.appendChild(providerTitle);

		const grid = targetDocument.createElement('div');
		grid.style.cssText = `display: flex; flex-direction: column; gap: 12px;`;

		// Google Provider Card
		grid.appendChild(this.createProviderCard(
			targetDocument,
			'Google',
			'Google Cloud & Any Agent AI OAuth Authentication.',
			isGoogleConnected,
			googleAccount,
			isGoogleConnected ? 'Sign Out' : 'Sign in with Google',
			async () => {
				if (isGoogleConnected) {
					await this.commandService.executeCommand('anyagent.google.logout');
				} else {
					await this.commandService.executeCommand('anyagent.google.login');
				}
				this.renderAccountTab(container, targetDocument);
			}
		));

		// GitHub Provider Card
		grid.appendChild(this.createProviderCard(
			targetDocument,
			'GitHub',
			'GitHub repository synchronization & OAuth access.',
			false,
			undefined,
			'Connect GitHub',
			async () => {
				this.notificationService.info('GitHub Authentication configuration is ready in resources/auth.');
			}
		));

		// Microsoft Provider Card
		grid.appendChild(this.createProviderCard(
			targetDocument,
			'Microsoft',
			'Microsoft Azure & Office 365 Enterprise Identity.',
			false,
			undefined,
			'Connect Microsoft',
			async () => {
				this.notificationService.info('Microsoft Authentication configuration is ready in resources/auth.');
			}
		));

		container.appendChild(grid);
	}

	private createProviderCard(
		targetDocument: Document,
		name: string,
		desc: string,
		isConnected: boolean,
		accountLabel: string | undefined,
		actionText: string,
		onAction: () => void
	): HTMLElement {
		const card = targetDocument.createElement('div');
		card.style.cssText = `
			background: #1c1c1c;
			border: 1px solid #2a2a2a;
			border-radius: 8px;
			padding: 16px 20px;
			display: flex;
			align-items: center;
			justify-content: space-between;
		`;

		const left = targetDocument.createElement('div');
		left.style.cssText = `display: flex; flex-direction: column; gap: 4px;`;

		const headerRow = targetDocument.createElement('div');
		headerRow.style.cssText = `display: flex; align-items: center; gap: 10px;`;

		const nameEl = targetDocument.createElement('span');
		nameEl.style.cssText = `font-size: 14px; font-weight: 600; color: #ffffff;`;
		nameEl.textContent = name;

		const badge = targetDocument.createElement('span');
		badge.style.cssText = `
			font-size: 11px;
			padding: 2px 8px;
			border-radius: 12px;
			background: ${isConnected ? 'rgba(34, 197, 94, 0.15)' : 'rgba(255, 255, 255, 0.06)'};
			color: ${isConnected ? '#4ade80' : '#888888'};
			border: 1px solid ${isConnected ? 'rgba(34, 197, 94, 0.3)' : 'rgba(255, 255, 255, 0.08)'};
		`;
		badge.textContent = isConnected ? 'Connected' : 'Not Connected';

		headerRow.appendChild(nameEl);
		headerRow.appendChild(badge);
		left.appendChild(headerRow);

		const descEl = targetDocument.createElement('span');
		descEl.style.cssText = `font-size: 12px; color: #888888;`;
		descEl.textContent = isConnected && accountLabel ? `Active Account: ${accountLabel}` : desc;
		left.appendChild(descEl);

		const actionBtn = targetDocument.createElement('button');
		actionBtn.style.cssText = `
			background: ${isConnected ? '#2a2a2a' : '#0284c7'};
			color: #ffffff;
			border: none;
			border-radius: 6px;
			padding: 8px 16px;
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

	private async renderPermissionsTab(container: HTMLElement, targetDocument: Document): Promise<void> {
		const mainTitle = targetDocument.createElement('h2');
		mainTitle.style.cssText = `margin: 0 0 6px 0; font-size: 20px; color: #ffffff; font-weight: 600;`;
		mainTitle.textContent = 'Extension Permissions & Security';

		const mainDesc = targetDocument.createElement('p');
		mainDesc.style.cssText = `margin: 0 0 24px 0; font-size: 13px; color: #888888;`;
		mainDesc.textContent = 'Configure account access and security credentials for installed IDE extensions.';

		container.appendChild(mainTitle);
		container.appendChild(mainDesc);

		const card = targetDocument.createElement('div');
		card.style.cssText = `background: #1c1c1c; border: 1px solid #2a2a2a; border-radius: 8px; padding: 20px;`;

		const btn = targetDocument.createElement('button');
		btn.style.cssText = `background: #0284c7; color: #ffffff; border: none; border-radius: 6px; padding: 10px 18px; font-size: 13px; cursor: pointer;`;
		btn.textContent = '⚙ Configure Extension Account Access...';
		btn.onclick = async () => {
			await this.commandService.executeCommand('workbench.action.manageAccountPreferencesForExtension');
		};

		card.appendChild(btn);
		container.appendChild(card);
	}

	private async renderModelsTab(container: HTMLElement, targetDocument: Document): Promise<void> {
		const mainTitle = targetDocument.createElement('h2');
		mainTitle.style.cssText = `margin: 0 0 6px 0; font-size: 20px; color: #ffffff; font-weight: 600;`;
		mainTitle.textContent = 'Language Models & Quota Access';

		const mainDesc = targetDocument.createElement('p');
		mainDesc.style.cssText = `margin: 0 0 24px 0; font-size: 13px; color: #888888;`;
		mainDesc.textContent = 'Control Language Model access tokens and rate limits across extensions.';

		container.appendChild(mainTitle);
		container.appendChild(mainDesc);

		const card = targetDocument.createElement('div');
		card.style.cssText = `background: #1c1c1c; border: 1px solid #2a2a2a; border-radius: 8px; padding: 20px;`;

		const btn = targetDocument.createElement('button');
		btn.style.cssText = `background: #0284c7; color: #ffffff; border: none; border-radius: 6px; padding: 10px 18px; font-size: 13px; cursor: pointer;`;
		btn.textContent = '🛡 Manage Language Model Access Permissions...';
		btn.onclick = async () => {
			await this.commandService.executeCommand('workbench.action.manageTrustedExtensionsForAccount');
		};

		card.appendChild(btn);
		container.appendChild(card);
	}

	private async renderGenericTab(container: HTMLElement, targetDocument: Document, tabName: string): Promise<void> {
		const mainTitle = targetDocument.createElement('h2');
		mainTitle.style.cssText = `margin: 0 0 6px 0; font-size: 20px; color: #ffffff; font-weight: 600;`;
		mainTitle.textContent = tabName;

		const mainDesc = targetDocument.createElement('p');
		mainDesc.style.cssText = `margin: 0 0 24px 0; font-size: 13px; color: #888888;`;
		mainDesc.textContent = `Configure ${tabName} preferences for Any Agent Desktop.`;

		container.appendChild(mainTitle);
		container.appendChild(mainDesc);

		const card = targetDocument.createElement('div');
		card.style.cssText = `background: #1c1c1c; border: 1px solid #2a2a2a; border-radius: 8px; padding: 20px;`;

		const btn = targetDocument.createElement('button');
		btn.style.cssText = `background: #2a2a2a; color: #ffffff; border: 1px solid #3c3c3c; border-radius: 6px; padding: 10px 18px; font-size: 13px; cursor: pointer;`;
		btn.textContent = `Open Full ${tabName} Settings...`;
		btn.onclick = async () => {
			await this.commandService.executeCommand('workbench.action.openSettings');
		};

		card.appendChild(btn);
		container.appendChild(card);
	}
}
