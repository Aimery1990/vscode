/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Any Agent / Google Deepmind. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { getActiveDocument } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { createTrustedTypesPolicy } from '../../../../base/browser/trustedTypes.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { AccountSignInModal } from './accountSignInModal.js';

export type AccountPanelTab = 'Account' | 'General' | 'Permissions' | 'Appearance' | 'Models' | 'Customizations';

const ttPolicy = createTrustedTypesPolicy('accountManagementDialog', { createHTML: value => value });

export class AccountManagementDialog extends Disposable {
	private container: HTMLElement | undefined;
	private activeTab: AccountPanelTab = 'Account';

	constructor(
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
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
		await this.createModal();
	}

	private setElementHTML(element: HTMLElement, html: string): void {
		if (ttPolicy) {
			element.innerHTML = ttPolicy.createHTML(html) as unknown as string;
		} else {
			element.innerHTML = html;
		}
	}

	private async createModal(): Promise<void> {
		const targetDocument = getActiveDocument() || window.document || mainWindow.document;

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
			z-index: 99999999;
			display: flex;
			align-items: center;
			justify-content: center;
			animation: anyagentFadeIn 0.15s ease-out;
		`;


		// Keyframe style if not injected
		if (!targetDocument.getElementById('anyagent-modal-styles')) {
			const style = targetDocument.createElement('style');
			style.id = 'anyagent-modal-styles';
			this.setElementHTML(style, `
				@keyframes anyagentFadeIn {
					from { opacity: 0; }
					to { opacity: 1; }
				}
				@keyframes anyagentSlideUp {
					from { transform: translateY(16px); opacity: 0; }
					to { transform: translateY(0); opacity: 1; }
				}
			`);
			targetDocument.head.appendChild(style);
		}

		// Dialog Container (Settings Panel layout matching AnyAgent Theme)
		const dialog = targetDocument.createElement('div');
		dialog.className = 'anyagent-account-dialog';
		dialog.style.cssText = `
			width: 960px;
			height: 640px;
			background: #1e1e1e;
			border: 1px solid #2a2a2a;
			border-radius: 12px;
			box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);
			display: flex;
			flex-direction: column;
			overflow: hidden;
			color: #cccccc;
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
			animation: anyagentSlideUp 0.2s ease-out;
		`;

		// Header Bar
		const header = targetDocument.createElement('div');
		header.style.cssText = `
			height: 52px;
			background: #181818;
			border-bottom: 1px solid #2a2a2a;
			padding: 0 20px;
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
		this.setElementHTML(title, `Settings <span style="color:#555555;margin:0 6px;">—</span> <span style="color:#ffffff;" id="anyagent-panel-tab-title">${this.activeTab}</span>`);

		const closeBtn = targetDocument.createElement('button');
		this.setElementHTML(closeBtn, '✕');
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
		closeBtn.onclick = () => this.close();

		header.appendChild(title);
		header.appendChild(closeBtn);
		dialog.appendChild(header);

		// Layout: Sidebar (Left) + Content (Right)
		const mainBody = targetDocument.createElement('div');
		mainBody.style.cssText = `
			flex: 1;
			display: flex;
			overflow: hidden;
		`;

		const sidebar = targetDocument.createElement('div');
		sidebar.style.cssText = `
			width: 240px;
			background: #181818;
			border-right: 1px solid #2a2a2a;
			padding: 16px 12px;
			overflow-y: auto;
			display: flex;
			flex-direction: column;
			gap: 4px;
		`;

		// Sidebar Navigation Configuration
		const navGroups = [
			{
				section: 'User & System',
				items: [
					{ id: 'Account', label: 'Account Profile' },
					{ id: 'General', label: 'General' },
					{ id: 'Permissions', label: 'Workspace Permissions' }
				]
			},
			{
				section: 'Environment',
				items: [
					{ id: 'Appearance', label: 'Appearance & Theme' },
					{ id: 'Models', label: 'AI LLM Providers' },
					{ id: 'Customizations', label: 'Agent Customizations' }
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
			sidebar.textContent = '';
			navGroups.forEach(group => {
				const groupTitle = targetDocument.createElement('div');
				groupTitle.style.cssText = `font-size: 11px; text-transform: uppercase; color: #555555; font-weight: 600; padding: 6px 12px; margin-top: 4px;`;
				groupTitle.textContent = group.section;
				sidebar.appendChild(groupTitle);

				group.items.forEach(item => {
					const btn = targetDocument.createElement('button');
					const isActive = this.activeTab === item.id;
					btn.style.cssText = `
						width: 100%;
						text-align: left;
						background: ${isActive ? '#2563eb' : 'transparent'};
						color: ${isActive ? '#ffffff' : '#aaaaaa'};
						border: none;
						border-radius: 6px;
						padding: 8px 12px;
						font-size: 13px;
						font-weight: ${isActive ? '600' : '500'};
						cursor: pointer;
						transition: all 0.15s ease;
					`;
					btn.textContent = item.label;
					btn.onmouseenter = () => {
						if (!isActive) {
							btn.style.background = '#222222';
							btn.style.color = '#ffffff';
						}
					};
					btn.onmouseleave = () => {
						if (!isActive) {
							btn.style.background = 'transparent';
							btn.style.color = '#aaaaaa';
						}
					};
					btn.onclick = async () => {
						this.activeTab = item.id as AccountPanelTab;
						const tabTitleSpan = targetDocument.getElementById('anyagent-panel-tab-title');
						if (tabTitleSpan) {
							tabTitleSpan.textContent = this.activeTab;
						}
						renderNav();
						await this.renderContent(contentArea, targetDocument);
					};
					sidebar.appendChild(btn);
				});
			});
		};

		renderNav();
		mainBody.appendChild(sidebar);
		mainBody.appendChild(contentArea);
		dialog.appendChild(mainBody);
		overlay.appendChild(dialog);

		// Synchronously append to target document body
		targetDocument.body.appendChild(overlay);
		this.container = overlay;

		// Asynchronously populate content safely
		try {
			await this.renderContent(contentArea, targetDocument);
		} catch (err) {
			console.error('Failed to populate Account Panel content:', err);
		}
	}

	private async renderContent(container: HTMLElement, targetDocument: Document): Promise<void> {
		container.textContent = '';

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
		// Header Description
		const header = targetDocument.createElement('div');
		header.style.marginBottom = '24px';
		this.setElementHTML(header, `
			<h3 style="margin:0 0 8px 0;font-size:18px;font-weight:600;color:#ffffff;">Account Profile</h3>
			<p style="margin:0;font-size:13px;color:#888888;line-height:1.5;">Manage your Any Agent brand accounts, single sign-on preferences, and subscription details.</p>
		`);
		container.appendChild(header);

		// Active Plan (Antigravity Style)
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
		this.setElementHTML(planLeft, `
			<div style="font-size:12px;color:#888888;margin-bottom:4px;">Active Plan</div>
			<div style="font-size:15px;font-weight:600;color:#ffffff;">Any Agent AI Pro Plan</div>
		`);

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
		const sectionTitle = targetDocument.createElement('h4');
		sectionTitle.style.cssText = `margin: 0 0 16px 0; font-size: 14px; font-weight: 600; color: #ffffff; border-bottom: 1px solid #2a2a2a; padding-bottom: 8px;`;
		sectionTitle.textContent = 'Connected Identity Providers';
		container.appendChild(sectionTitle);

		const grid = targetDocument.createElement('div');
		grid.style.cssText = `display: grid; grid-template-columns: 1fr; gap: 16px; margin-bottom: 24px;`;
		container.appendChild(grid);

		// Check session states
		let isGoogleConnected = false;
		let googleAccount = '';

		try {
			const sessions = await this.authenticationService.getSessions('google');
			if (sessions && sessions.length > 0) {
				isGoogleConnected = true;
				googleAccount = sessions[0].account.label;
			}
		} catch (e) {
			// ignore
		}

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
					this.close();
					const signInModal = this.instantiationService.createInstance(AccountSignInModal);
					signInModal.show(true);
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
			'Microsoft Azure AD & Enterprise SSO login.',
			false,
			undefined,
			'Connect Microsoft',
			async () => {
				this.notificationService.info('Microsoft Authentication configuration is ready in resources/auth.');
			}
		));

		// Apple Provider Card
		grid.appendChild(this.createProviderCard(
			targetDocument,
			'Apple',
			'Apple Account SSO integration.',
			false,
			undefined,
			'Connect Apple',
			async () => {
				this.notificationService.info('Apple Authentication configuration is ready in resources/auth.');
			}
		));
	}

	private createProviderCard(
		targetDocument: Document,
		providerName: string,
		desc: string,
		isConnected: boolean,
		accountLabel: string | undefined,
		actionText: string,
		onAction: () => void
	): HTMLElement {
		const card = targetDocument.createElement('div');
		card.style.cssText = `
			background: #181818;
			border: 1px solid #2a2a2a;
			border-radius: 8px;
			padding: 16px 20px;
			display: flex;
			align-items: center;
			justify-content: space-between;
			transition: all 0.15s ease;
		`;

		const left = targetDocument.createElement('div');
		left.style.cssText = `display:flex; flex-direction:column; gap:4px;`;

		const nameContainer = targetDocument.createElement('div');
		nameContainer.style.cssText = `display:flex; align-items:center; gap:8px;`;

		const name = targetDocument.createElement('span');
		name.style.cssText = `font-size: 14px; font-weight: 600; color: #ffffff;`;
		name.textContent = providerName;

		const badge = targetDocument.createElement('span');
		badge.style.cssText = `
			font-size: 10px;
			font-weight: 600;
			padding: 2px 6px;
			border-radius: 4px;
			background: ${isConnected ? '#15803d' : '#3f3f46'};
			color: #ffffff;
		`;
		badge.textContent = isConnected ? 'CONNECTED' : 'NOT CONNECTED';

		nameContainer.appendChild(name);
		nameContainer.appendChild(badge);

		const accountInfo = targetDocument.createElement('div');
		accountInfo.style.cssText = `font-size: 12px; color: ${isConnected ? '#4ade80' : '#888888'};`;
		accountInfo.textContent = isConnected && accountLabel ? `Account: ${accountLabel}` : desc;

		left.appendChild(nameContainer);
		left.appendChild(accountInfo);

		const actionBtn = targetDocument.createElement('button');
		actionBtn.style.cssText = `
			background: ${isConnected ? '#b91c1c' : '#27272a'};
			color: #ffffff;
			border: 1px solid #3f3f46;
			border-radius: 6px;
			padding: 6px 14px;
			font-size: 12px;
			font-weight: 500;
			cursor: pointer;
			transition: all 0.15s ease;
		`;
		actionBtn.textContent = actionText;
		actionBtn.onmouseenter = () => { actionBtn.style.borderColor = '#52525b'; };
		actionBtn.onmouseleave = () => { actionBtn.style.borderColor = '#3f3f46'; };
		actionBtn.onclick = onAction;

		card.appendChild(left);
		card.appendChild(actionBtn);

		return card;
	}

	private async renderPermissionsTab(container: HTMLElement, targetDocument: Document): Promise<void> {
		this.setElementHTML(container, `
			<h3 style="margin:0 0 8px 0;font-size:18px;font-weight:600;color:#ffffff;">Workspace Permissions</h3>
			<p style="margin:0 0 20px 0;font-size:13px;color:#888888;line-height:1.5;">Configure authorization scopes for local workspaces and directories.</p>
			
			<div style="background:#1c1c1c; border:1px solid #2a2a2a; border-radius:8px; padding:16px; margin-bottom:20px;">
				<div style="font-size:14px; font-weight:600; color:#ffffff; margin-bottom:6px;">Allow Filesystem Access</div>
				<div style="font-size:12px; color:#888888; line-height:1.4;">Allows Any Agent to read and write files under project folders for task execution.</div>
				<div style="margin-top:12px; display:flex; gap:8px;">
					<button style="background:#2563eb; color:#ffffff; border:none; padding:6px 12px; border-radius:4px; font-size:12px; cursor:pointer;">Granted</button>
				</div>
			</div>
			
			<div style="background:#1c1c1c; border:1px solid #2a2a2a; border-radius:8px; padding:16px;">
				<div style="font-size:14px; font-weight:600; color:#ffffff; margin-bottom:6px;">Terminal Command Execution</div>
				<div style="font-size:12px; color:#888888; line-height:1.4;">Allows agents to execute local commands and run server builders.</div>
				<div style="margin-top:12px; display:flex; gap:8px;">
					<button style="background:#2563eb; color:#ffffff; border:none; padding:6px 12px; border-radius:4px; font-size:12px; cursor:pointer;">Granted</button>
				</div>
			</div>
		`);
	}

	private async renderModelsTab(container: HTMLElement, targetDocument: Document): Promise<void> {
		this.setElementHTML(container, `
			<h3 style="margin:0 0 8px 0;font-size:18px;font-weight:600;color:#ffffff;">AI LLM Providers</h3>
			<p style="margin:0 0 20px 0;font-size:13px;color:#888888;line-height:1.5;">Choose the primary AI models and API credentials to power Any Agent.</p>
			
			<div style="display:grid; grid-template-columns:1fr; gap:16px;">
				<div style="background:#1c1c1c; border:1px solid #2a2a2a; border-radius:8px; padding:16px; display:flex; justify-content:space-between; align-items:center;">
					<div>
						<div style="font-size:14px; font-weight:600; color:#ffffff; margin-bottom:4px;">Gemini 1.5 Flash (Default)</div>
						<div style="font-size:12px; color:#888888;">Optimized speed and reasoning. Powered by Google Vertex AI.</div>
					</div>
					<span style="font-size:11px; font-weight:600; color:#22c55e; border:1px solid #22c55e; padding:3px 8px; border-radius:12px;">ACTIVE</span>
				</div>
				<div style="background:#1c1c1c; border:1px solid #2a2a2a; border-radius:8px; padding:16px; display:flex; justify-content:space-between; align-items:center;">
					<div>
						<div style="font-size:14px; font-weight:600; color:#ffffff; margin-bottom:4px;">Gemini 1.5 Pro</div>
						<div style="font-size:12px; color:#888888;">High precision reasoning and deep code generation capability.</div>
					</div>
					<button style="background:#27272a; color:#ffffff; border:1px solid #3f3f46; padding:4px 10px; border-radius:6px; font-size:11px; cursor:pointer;">Select</button>
				</div>
			</div>
		`);
	}

	private async renderGenericTab(container: HTMLElement, targetDocument: Document, tabId: string): Promise<void> {
		this.setElementHTML(container, `
			<h3 style="margin:0 0 8px 0;font-size:18px;font-weight:600;color:#ffffff;">${tabId} Settings</h3>
			<p style="margin:0 0 20px 0;font-size:13px;color:#888888;line-height:1.5;">Customize settings and configuration options for ${tabId}.</p>
			<div style="background:#1c1c1c; border:1px solid #2a2a2a; border-radius:8px; padding:24px; text-align:center; color:#888888; font-size:13px;">
				Any Agent ${tabId} settings framework is ready. Custom settings will be populated here.
			</div>
		`);
	}
}
