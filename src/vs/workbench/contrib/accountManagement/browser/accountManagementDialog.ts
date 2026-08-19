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
import { IAgentCredentialService } from '../../agentsManager/common/agentsManager.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export type AccountPanelTab = 'Account' | 'General' | 'Permissions' | 'Appearance' | 'Models' | 'Customizations';

const ttPolicy = createTrustedTypesPolicy('accountManagementDialog', { createHTML: value => value });

export class AccountManagementDialog extends Disposable {
	private container: HTMLElement | undefined;
	private activeTab: AccountPanelTab = 'Account';

	constructor(
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAgentCredentialService private readonly agentCredentialService: IAgentCredentialService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IStorageService private readonly _storageService: IStorageService
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
		} else if (this.activeTab === 'Customizations') {
			await this.renderCustomizationsTab(container, targetDocument);
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
		const header = targetDocument.createElement('div');
		header.style.marginBottom = '24px';
		this.setElementHTML(header, `
			<h3 style="margin:0 0 8px 0;font-size:18px;font-weight:600;color:#ffffff;">AI LLM Providers & Credentials</h3>
			<p style="margin:0;font-size:13px;color:#888888;line-height:1.5;">Configure and manage your API keys, custom endpoints, and secure credentials for Any Agent models.</p>
		`);
		container.appendChild(header);

		// Section 1: Active System Providers
		const sysTitle = targetDocument.createElement('h4');
		sysTitle.style.cssText = `margin: 0 0 14px 0; font-size: 13.5px; font-weight: 600; color: #ffffff; border-bottom: 1px solid #2a2a2a; padding-bottom: 6px;`;
		sysTitle.textContent = 'System Built-In Providers';
		container.appendChild(sysTitle);

		const sysGrid = targetDocument.createElement('div');
		sysGrid.style.cssText = `display:grid; grid-template-columns:1fr; gap:12px; margin-bottom: 24px;`;
		container.appendChild(sysGrid);

		this.setElementHTML(sysGrid, `
			<div style="background:#181818; border:1px solid #2a2a2a; border-radius:8px; padding:12px 16px; display:flex; justify-content:space-between; align-items:center;">
				<div>
					<div style="font-size:13.5px; font-weight:600; color:#ffffff; margin-bottom:2px;">Google Gemini (Default System Key)</div>
					<div style="font-size:11.5px; color:#888888;">Optimized speed, large context, and reasoning. Powered by Any Agent Cloud.</div>
				</div>
				<span style="font-size:10px; font-weight:600; color:#22c55e; border:1px solid #22c55e; padding:2px 8px; border-radius:12px;">ACTIVE</span>
			</div>
		`);

		// Section 2: User Configured Credentials (Secure OS Keychain)
		const userTitle = targetDocument.createElement('h4');
		userTitle.style.cssText = `margin: 0 0 14px 0; font-size: 13.5px; font-weight: 600; color: #ffffff; border-bottom: 1px solid #2a2a2a; padding-bottom: 6px;`;
		userTitle.textContent = 'Secure Custom Credentials (OS Keychain)';
		container.appendChild(userTitle);

		const credentials = await this.agentCredentialService.getCredentials();
		
		const credsListContainer = targetDocument.createElement('div');
		credsListContainer.style.cssText = `display: flex; flex-direction: column; gap: 12px; margin-bottom: 28px;`;
		container.appendChild(credsListContainer);

		if (credentials.length === 0) {
			const emptyCard = targetDocument.createElement('div');
			emptyCard.style.cssText = `background: #181818; border: 1px dashed #2a2a2a; border-radius: 8px; padding: 24px; text-align: center; color: #666666; font-size: 12.5px;`;
			emptyCard.textContent = 'No custom API credentials configured yet. Save keys securely using keychain storage below.';
			credsListContainer.appendChild(emptyCard);
		} else {
			for (const cred of credentials) {
				const credCard = targetDocument.createElement('div');
				credCard.style.cssText = `
					background: #181818;
					border: 1px solid #2a2a2a;
					border-radius: 8px;
					padding: 16px;
					display: flex;
					flex-direction: column;
					gap: 12px;
					transition: all 0.15s ease;
					opacity: ${cred.isEnabled !== false ? '1' : '0.55'};
				`;

				const topRow = targetDocument.createElement('div');
				topRow.style.cssText = `display: flex; align-items: flex-start; justify-content: space-between;`;

				const leftInfo = targetDocument.createElement('div');
				leftInfo.style.cssText = `display: flex; flex-direction: column; gap: 4px;`;
				
				const nameRow = targetDocument.createElement('div');
				nameRow.style.cssText = `display: flex; align-items: center; gap: 8px;`;
				
				const nameSpan = targetDocument.createElement('span');
				nameSpan.style.cssText = `font-size: 13.5px; font-weight: 600; color: #ffffff;`;
				nameSpan.textContent = cred.name;

				const providerBadge = targetDocument.createElement('span');
				providerBadge.style.cssText = `
					font-size: 9px;
					font-weight: 600;
					text-transform: uppercase;
					padding: 1px 5px;
					border-radius: 4px;
					background: #2563eb;
					color: #ffffff;
				`;
				providerBadge.textContent = cred.providerId;

				nameRow.appendChild(nameSpan);
				nameRow.appendChild(providerBadge);

				const statusBadge = targetDocument.createElement('span');
				const status = cred.connectionStatus || 'unverified';
				statusBadge.style.cssText = `
					font-size: 9px;
					font-weight: 600;
					text-transform: uppercase;
					padding: 1px 5px;
					border-radius: 4px;
					margin-left: 6px;
				`;
				if (cred.isEnabled === false) {
					statusBadge.style.background = '#4b5563';
					statusBadge.style.color = '#9ca3af';
					statusBadge.textContent = 'DISABLED';
				} else if (status === 'connected') {
					statusBadge.style.background = '#16a34a';
					statusBadge.style.color = '#ffffff';
					statusBadge.textContent = 'CONNECTED';
				} else if (status === 'error') {
					statusBadge.style.background = '#dc2626';
					statusBadge.style.color = '#ffffff';
					statusBadge.textContent = 'ERROR';
				} else {
					statusBadge.style.background = '#4b5563';
					statusBadge.style.color = '#ffffff';
					statusBadge.textContent = 'UNVERIFIED';
				}
				nameRow.appendChild(statusBadge);

				leftInfo.appendChild(nameRow);

				if (cred.customUrl) {
					const urlRow = targetDocument.createElement('div');
					urlRow.style.cssText = `font-size: 11px; color: #888888;`;
					urlRow.textContent = `Endpoint: ${cred.customUrl}`;
					leftInfo.appendChild(urlRow);
				}

				const keyRow = targetDocument.createElement('div');
				keyRow.style.cssText = `font-size: 11px; color: #555555; font-family: monospace;`;
				keyRow.textContent = '•••••••••••••••••••• (Stored Securely)';
				leftInfo.appendChild(keyRow);

				if (cred.lastVerifiedAt) {
					const verifiedRow = targetDocument.createElement('div');
					verifiedRow.style.cssText = `font-size: 11px; color: #888888;`;
					const dateStr = new Date(cred.lastVerifiedAt).toLocaleString();
					verifiedRow.textContent = `Last verified: ${dateStr}`;
					if (status === 'error' && cred.connectionMessage) {
						verifiedRow.textContent += ` (${cred.connectionMessage})`;
					}
					leftInfo.appendChild(verifiedRow);
				}

				topRow.appendChild(leftInfo);

				const actionsDiv = targetDocument.createElement('div');
				actionsDiv.style.cssText = `display: flex; align-items: center; gap: 8px;`;

				const toggleContainer = targetDocument.createElement('label');
				toggleContainer.style.cssText = `
					display: inline-flex;
					align-items: center;
					gap: 6px;
					font-size: 11px;
					color: #888888;
					cursor: pointer;
					margin-right: 8px;
					user-select: none;
				`;
				const toggleInput = targetDocument.createElement('input');
				toggleInput.type = 'checkbox';
				toggleInput.checked = cred.isEnabled !== false;
				toggleInput.style.cssText = `
					cursor: pointer;
					margin: 0;
					width: 13px;
					height: 13px;
				`;
				toggleInput.onchange = async () => {
					const updated = {
						...cred,
						isEnabled: toggleInput.checked
					};
					await this.agentCredentialService.updateCredential(updated);
					this.notificationService.info(`Credential '${cred.name}' is now ${toggleInput.checked ? 'Enabled' : 'Disabled'}.`);
					await this.renderContent(container, targetDocument);
				};
				const toggleText = targetDocument.createElement('span');
				toggleText.textContent = cred.isEnabled !== false ? 'Enabled' : 'Disabled';
				toggleText.style.color = cred.isEnabled !== false ? '#4ade80' : '#f43f5e';
				toggleText.style.fontWeight = 'bold';

				toggleContainer.appendChild(toggleInput);
				toggleContainer.appendChild(toggleText);
				actionsDiv.appendChild(toggleContainer);

				const refreshBtn = targetDocument.createElement('button');
				refreshBtn.style.cssText = `
					background: rgba(56, 189, 248, 0.1);
					color: #38bdf8;
					border: 1px solid rgba(56, 189, 248, 0.3);
					border-radius: 4px;
					padding: 5px 12px;
					font-size: 11px;
					cursor: pointer;
					transition: all 0.15s ease;
				`;
				refreshBtn.textContent = 'Refresh';
				refreshBtn.onclick = async () => {
					refreshBtn.textContent = 'Refreshing...';
					refreshBtn.disabled = true;
					try {
						await this.agentCredentialService.refreshCredential(cred.id);
						this.notificationService.info(`Credential '${cred.name}' verified successfully!`);
					} catch (err: any) {
						this.notificationService.error(`Verification failed: ${err.message || err}`);
					}
					await this.renderContent(container, targetDocument);
				};
				actionsDiv.appendChild(refreshBtn);

				const delBtn = targetDocument.createElement('button');
				delBtn.style.cssText = `
					background: #991b1b;
					color: #ffffff;
					border: none;
					border-radius: 4px;
					padding: 5px 12px;
					font-size: 11px;
					cursor: pointer;
					transition: all 0.15s ease;
				`;
				delBtn.textContent = 'Delete';
				delBtn.onmouseenter = () => { delBtn.style.background = '#7f1d1d'; };
				delBtn.onmouseleave = () => { delBtn.style.background = '#991b1b'; };
				delBtn.onclick = async () => {
					if (confirm(`Are you sure you want to delete the API key '${cred.name}'?`)) {
						await this.agentCredentialService.removeCredential(cred.id);
						this.notificationService.info(`Credential '${cred.name}' deleted successfully.`);
						await this.renderContent(container, targetDocument);
					}
				};
				actionsDiv.appendChild(delBtn);
				topRow.appendChild(actionsDiv);

				credCard.appendChild(topRow);

				const modelsBlock = targetDocument.createElement('div');
				modelsBlock.style.cssText = `
					border-top: 1px solid #222;
					padding-top: 10px;
					margin-top: 4px;
				`;
				const modelsLabel = targetDocument.createElement('div');
				modelsLabel.style.cssText = `font-size: 10px; font-weight: bold; text-transform: uppercase; color: #666; margin-bottom: 6px;`;
				modelsLabel.textContent = 'Available Models';
				modelsBlock.appendChild(modelsLabel);

				const modelsContainer = targetDocument.createElement('div');
				modelsContainer.style.cssText = `display: flex; flex-wrap: wrap; gap: 6px;`;

				const cached = cred.cachedModels || [];
				if (cached.length === 0) {
					const noModels = targetDocument.createElement('div');
					noModels.style.cssText = `font-size: 11.5px; color: #888888; font-style: italic;`;
					noModels.textContent = status === 'unverified' ? 'Not verified yet. Click Refresh to query models.' : 'No models retrieved from provider.';
					modelsContainer.appendChild(noModels);
				} else {
					const collapsedLimit = 8;
					const shouldCollapse = cached.length > collapsedLimit;
					let isExpanded = false;

					const renderModelsList = () => {
						modelsContainer.textContent = '';
						const visibleCount = isExpanded ? cached.length : Math.min(cached.length, collapsedLimit);
						
						for (let i = 0; i < visibleCount; i++) {
							const tag = targetDocument.createElement('span');
							tag.style.cssText = `
								font-size: 10.5px;
								background: #202020;
								border: 1px solid #2d2d2d;
								color: #cccccc;
								padding: 2px 6px;
								border-radius: 4px;
								font-family: monospace;
							`;
							tag.textContent = cached[i];
							modelsContainer.appendChild(tag);
						}

						if (shouldCollapse) {
							const toggleLink = targetDocument.createElement('a');
							toggleLink.style.cssText = `
								font-size: 10.5px;
								color: #38bdf8;
								cursor: pointer;
								text-decoration: none;
								display: inline-flex;
								align-items: center;
								align-self: center;
								margin-left: 4px;
								user-select: none;
								font-weight: 600;
							`;
							toggleLink.textContent = isExpanded ? 'Collapse ▲' : `Expand (+${cached.length - collapsedLimit} more) ▼`;
							toggleLink.onclick = (e) => {
								e.preventDefault();
								isExpanded = !isExpanded;
								renderModelsList();
							};
							modelsContainer.appendChild(toggleLink);
						}
					};

					renderModelsList();
				}
				modelsBlock.appendChild(modelsContainer);
				credCard.appendChild(modelsBlock);

				credsListContainer.appendChild(credCard);
			}
		}

		// Section 3: Add New API Key / Token Form
		const addTitle = targetDocument.createElement('h4');
		addTitle.style.cssText = `margin: 0 0 14px 0; font-size: 13.5px; font-weight: 600; color: #ffffff; border-bottom: 1px solid #2a2a2a; padding-bottom: 6px;`;
		addTitle.textContent = 'Configure New API Credential';
		container.appendChild(addTitle);

		const formCard = targetDocument.createElement('div');
		formCard.style.cssText = `
			background: #181818;
			border: 1px solid #2a2a2a;
			border-radius: 8px;
			padding: 20px;
			display: flex;
			flex-direction: column;
			gap: 12px;
		`;
		container.appendChild(formCard);

		const formLabelStyle = `display: block; font-size: 10px; font-weight: 600; text-transform: uppercase; color: #888888; margin-bottom: 5px;`;
		const formInputStyle = `width: 100%; padding: 8px 12px; font-size: 12px; background: #121212; border: 1px solid #2a2a2a; border-radius: 6px; color: #ffffff; outline: none; box-sizing: border-box;`;

		// Title Field
		const nameGroup = targetDocument.createElement('div');
		const nameLabel = targetDocument.createElement('label');
		nameLabel.style.cssText = formLabelStyle;
		nameLabel.textContent = 'Credential Custom Title:';
		const nameInput = targetDocument.createElement('input');
		nameInput.style.cssText = formInputStyle;
		nameInput.placeholder = 'e.g. Gemini Pro Production, Anthropic Team Key';
		nameGroup.appendChild(nameLabel);
		nameGroup.appendChild(nameInput);
		formCard.appendChild(nameGroup);

		// Provider Selector
		const provGroup = targetDocument.createElement('div');
		const provLabel = targetDocument.createElement('label');
		provLabel.style.cssText = formLabelStyle;
		provLabel.textContent = 'Model Provider:';
		const provSelect = targetDocument.createElement('select');
		provSelect.style.cssText = formInputStyle + '; cursor: pointer;';
		this.setElementHTML(provSelect, `
			<option value="gemini">Google Gemini</option>
			<option value="openai">OpenAI</option>
			<option value="anthropic">Anthropic Claude</option>
			<option value="custom-openai">Custom / Other Endpoint (OpenAI/Compatible)</option>
		`);
		provGroup.appendChild(provLabel);
		provGroup.appendChild(provSelect);
		formCard.appendChild(provGroup);

		const customEndpointGroup = targetDocument.createElement('div');
		customEndpointGroup.style.display = 'none';
		const endpointLabel = targetDocument.createElement('label');
		endpointLabel.style.cssText = formLabelStyle;
		endpointLabel.textContent = 'Custom Endpoint Base URL:';
		const endpointInput = targetDocument.createElement('input');
		endpointInput.style.cssText = formInputStyle;
		endpointInput.placeholder = 'e.g. https://api.deepseek.com/v1, http://localhost:11434/v1';

		const endpointHelp = targetDocument.createElement('div');
		endpointHelp.style.cssText = `font-size: 11px; color: #888888; margin-top: 4px; line-height: 1.4;`;
		endpointHelp.textContent = 'For DeepSeek, use: https://api.deepseek.com/v1. For SiliconFlow, use: https://api.siliconflow.cn/v1. For local Ollama, use: http://localhost:11434/v1';

		customEndpointGroup.appendChild(endpointLabel);
		customEndpointGroup.appendChild(endpointInput);
		customEndpointGroup.appendChild(endpointHelp);
		formCard.appendChild(customEndpointGroup);

		provSelect.onchange = () => {
			if (provSelect.value === 'custom-openai') {
				customEndpointGroup.style.display = 'block';
			} else {
				customEndpointGroup.style.display = 'none';
			}
		};

		// API Key Field
		const keyGroup = targetDocument.createElement('div');
		const keyLabel = targetDocument.createElement('label');
		keyLabel.style.cssText = formLabelStyle;
		keyLabel.textContent = 'API Key / Token String:';
		
		const inputWrapper = targetDocument.createElement('div');
		inputWrapper.style.cssText = 'position: relative; display: flex; align-items: center; width: 100%;';
		
		const keyInput = targetDocument.createElement('input');
		keyInput.style.cssText = formInputStyle + '; padding-right: 40px;';
		keyInput.type = 'password';
		keyInput.placeholder = 'Paste key value here...';
		
		const toggleBtn = targetDocument.createElement('button');
		toggleBtn.type = 'button';
		toggleBtn.style.cssText = 'position: absolute; right: 10px; background: none; border: none; color: #888888; cursor: pointer; font-size: 14px; outline: none; padding: 4px; display: flex; align-items: center; justify-content: center;';
		this.setElementHTML(toggleBtn, '<span class="codicon codicon-eye"></span>');
		
		toggleBtn.onclick = () => {
			if (keyInput.type === 'password') {
				keyInput.type = 'text';
				this.setElementHTML(toggleBtn, '<span class="codicon codicon-eye-closed"></span>');
			} else {
				keyInput.type = 'password';
				this.setElementHTML(toggleBtn, '<span class="codicon codicon-eye"></span>');
			}
		};
		
		inputWrapper.appendChild(keyInput);
		inputWrapper.appendChild(toggleBtn);
		
		keyGroup.appendChild(keyLabel);
		keyGroup.appendChild(inputWrapper);
		formCard.appendChild(keyGroup);
		let fetchedModelsList: string[] = [];

		// Fetch Models & Default Model Group
		const fetchModelsGroup = targetDocument.createElement('div');
		fetchModelsGroup.style.cssText = 'display: flex; flex-direction: column; gap: 8px; margin-top: 4px;';
		formCard.appendChild(fetchModelsGroup);

		// Default Model Label & Dropdown
		const modelSelectLabel = targetDocument.createElement('label');
		modelSelectLabel.style.cssText = formLabelStyle;
		modelSelectLabel.textContent = 'Default / Test Model:';
		
		const modelSelectWrapper = targetDocument.createElement('div');
		modelSelectWrapper.style.cssText = 'display: flex; gap: 10px; align-items: center; width: 100%;';
		
		const testModelSelect = targetDocument.createElement('select');
		testModelSelect.style.cssText = formInputStyle + '; flex: 1; cursor: pointer;';
		
		const updateTestModelDefaults = () => {
			testModelSelect.textContent = '';
			const prov = provSelect.value;
			let opts: { value: string; label: string }[] = [];
			if (prov === 'gemini') {
				opts = [
					{ value: 'gemini-1.5-flash', label: 'gemini-1.5-flash (Default)' },
					{ value: 'gemini-1.5-pro', label: 'gemini-1.5-pro' },
					{ value: 'gemini-2.0-flash', label: 'gemini-2.0-flash' }
				];
			} else if (prov === 'openai') {
				opts = [
					{ value: 'gpt-4o-mini', label: 'gpt-4o-mini (Default)' },
					{ value: 'gpt-4o', label: 'gpt-4o' },
					{ value: 'gpt-4-turbo', label: 'gpt-4-turbo' }
				];
			} else if (prov === 'anthropic') {
				opts = [
					{ value: 'claude-3-5-sonnet-20241022', label: 'claude-3-5-sonnet-20241022 (Default)' },
					{ value: 'claude-3-5-haiku-20241022', label: 'claude-3-5-haiku-20241022' }
				];
			} else {
				opts = [
					{ value: 'default-model', label: 'default-model (Default)' }
				];
			}
			for (const opt of opts) {
				const optionEl = targetDocument.createElement('option');
				optionEl.value = opt.value;
				optionEl.textContent = opt.label;
				testModelSelect.appendChild(optionEl);
			}
		};
		updateTestModelDefaults();
		provSelect.addEventListener('change', updateTestModelDefaults);

		const fetchBtn = targetDocument.createElement('button');
		fetchBtn.type = 'button';
		fetchBtn.style.cssText = `
			background: rgba(34, 197, 94, 0.1);
			color: #4ade80;
			border: 1px solid rgba(34, 197, 94, 0.3);
			border-radius: 6px;
			padding: 7px 14px;
			font-size: 11px;
			font-weight: 600;
			cursor: pointer;
			white-space: nowrap;
			transition: all 0.1s ease;
		`;
		fetchBtn.textContent = 'Fetch Models';
		fetchBtn.onmouseenter = () => { fetchBtn.style.background = 'rgba(34, 197, 94, 0.2)'; };
		fetchBtn.onmouseleave = () => { fetchBtn.style.background = 'rgba(34, 197, 94, 0.1)'; };

		modelSelectWrapper.appendChild(testModelSelect);
		modelSelectWrapper.appendChild(fetchBtn);
		fetchModelsGroup.appendChild(modelSelectLabel);
		fetchModelsGroup.appendChild(modelSelectWrapper);

		// Button Row
		const btnRow = targetDocument.createElement('div');
		btnRow.style.cssText = `display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin-top: 6px;`;
		formCard.appendChild(btnRow);

		// Test connection alerts
		const testResultContainer = targetDocument.createElement('div');
		testResultContainer.style.cssText = 'display: none; position: relative; width: 100%; margin-top: 10px;';
		formCard.appendChild(testResultContainer);

		const testResultBox = targetDocument.createElement('div');
		testResultBox.style.cssText = `font-size: 11.5px; padding: 10px 14px; padding-right: 60px; border-radius: 6px; line-height: 1.4; word-break: break-all; font-family: monospace; width: 100%; box-sizing: border-box; white-space: pre-wrap; user-select: text; -webkit-user-select: text;`;
		testResultContainer.appendChild(testResultBox);

		const copyBtn = targetDocument.createElement('button');
		copyBtn.style.cssText = 'position: absolute; right: 10px; top: 10px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); border-radius: 4px; color: #cccccc; cursor: pointer; font-size: 11px; padding: 4px 8px; font-weight: 500; outline: none; transition: all 0.1s ease;';
		copyBtn.textContent = 'Copy';
		copyBtn.onmouseenter = () => { copyBtn.style.background = 'rgba(255,255,255,0.15)'; };
		copyBtn.onmouseleave = () => { copyBtn.style.background = 'rgba(255,255,255,0.08)'; };
		
		let textToCopy = '';
		copyBtn.onclick = () => {
			this.clipboardService.writeText(textToCopy).then(() => {
				copyBtn.textContent = 'Copied!';
				setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
			}).catch(err => {
				console.error('Failed to copy text:', err);
			});
		};
		testResultContainer.appendChild(copyBtn);

		const testSpinner = targetDocument.createElement('span');
		testSpinner.style.cssText = `font-size:12px; color:#888888; display:none; margin-right:auto;`;
		testSpinner.textContent = 'Connecting to model API...';
		btnRow.appendChild(testSpinner);

		// Fetch Button click handler
		fetchBtn.onclick = async () => {
			testResultContainer.style.display = 'none';
			testResultBox.textContent = '';
			testSpinner.style.display = 'inline';
			testSpinner.textContent = 'Fetching models list...';
			fetchBtn.disabled = true;

			try {
				const apiKeyVal = keyInput.value.trim();
				const providerVal = provSelect.value;
				let customUrlVal: string | undefined = undefined;

				if (providerVal === 'custom-openai') {
					const endpointVal = endpointInput.value.trim();
					if (!endpointVal) {
						testSpinner.style.display = 'none';
						fetchBtn.disabled = false;
						testResultContainer.style.display = 'block';
						testResultBox.style.background = 'rgba(244, 63, 94, 0.1)';
						testResultBox.style.border = '1px solid rgba(244, 63, 94, 0.3)';
						testResultBox.style.color = '#f43f5e';
						testResultBox.textContent = 'Please enter a custom endpoint URL to fetch models.';
						textToCopy = testResultBox.textContent;
						return;
					}
					customUrlVal = endpointVal;
				}

				if (!apiKeyVal) {
					testSpinner.style.display = 'none';
					fetchBtn.disabled = false;
					testResultContainer.style.display = 'block';
					testResultBox.style.background = 'rgba(244, 63, 94, 0.1)';
					testResultBox.style.border = '1px solid rgba(244, 63, 94, 0.3)';
					testResultBox.style.color = '#f43f5e';
					testResultBox.textContent = 'Please enter an API Key to fetch models.';
					textToCopy = testResultBox.textContent;
					return;
				}

				const models = await this.agentCredentialService.fetchModels(providerVal, apiKeyVal, customUrlVal);
				testSpinner.style.display = 'none';
				fetchBtn.disabled = false;
				
				if (models && models.length > 0) {
					fetchedModelsList = models;
					testModelSelect.textContent = '';
					for (const m of models) {
						const opt = targetDocument.createElement('option');
						opt.value = m;
						opt.textContent = m;
						testModelSelect.appendChild(opt);
					}
					
					testResultContainer.style.display = 'block';
					testResultBox.style.background = 'rgba(34, 197, 94, 0.1)';
					testResultBox.style.border = '1px solid rgba(34, 197, 94, 0.3)';
					testResultBox.style.color = '#4ade80';
					testResultBox.textContent = `✓ Model list retrieved successfully! Found ${models.length} models.`;
				} else {
					testResultContainer.style.display = 'block';
					testResultBox.style.background = 'rgba(244, 63, 94, 0.1)';
					testResultBox.style.border = '1px solid rgba(244, 63, 94, 0.3)';
					testResultBox.style.color = '#f43f5e';
					testResultBox.textContent = `✗ Failed to retrieve models: No models returned by the endpoint.`;
				}
				textToCopy = testResultBox.textContent;
			} catch (err: any) {
				testSpinner.style.display = 'none';
				fetchBtn.disabled = false;
				testResultContainer.style.display = 'block';
				testResultBox.style.background = 'rgba(244, 63, 94, 0.1)';
				testResultBox.style.border = '1px solid rgba(244, 63, 94, 0.3)';
				testResultBox.style.color = '#f43f5e';
				testResultBox.textContent = `✗ Error fetching models: ${err.message || err}`;
				textToCopy = testResultBox.textContent;
			}
		};

		const testBtn = targetDocument.createElement('button');
		testBtn.style.cssText = `
			background: rgba(56, 189, 248, 0.1);
			color: #38bdf8;
			border: 1px solid rgba(56, 189, 248, 0.3);
			border-radius: 6px;
			padding: 7px 14px;
			font-size: 12px;
			font-weight: 600;
			cursor: pointer;
		`;
		testBtn.textContent = 'Test API';
		testBtn.onclick = async () => {
			testResultContainer.style.display = 'none';
			testResultBox.textContent = '';
			testSpinner.style.display = 'inline';
			testSpinner.textContent = 'Testing connection...';
			testBtn.disabled = true;

			try {
				const apiKeyVal = keyInput.value.trim();
				const providerVal = provSelect.value;
				const selectedModel = testModelSelect.value;
				let customUrlVal: string | undefined = undefined;

				if (providerVal === 'custom-openai') {
					const endpointVal = endpointInput.value.trim();
					if (!endpointVal) {
						testSpinner.style.display = 'none';
						testBtn.disabled = false;
						testResultContainer.style.display = 'block';
						testResultBox.style.background = 'rgba(244, 63, 94, 0.1)';
						testResultBox.style.border = '1px solid rgba(244, 63, 94, 0.3)';
						testResultBox.style.color = '#f43f5e';
						testResultBox.textContent = 'Please enter a custom endpoint URL to test.';
						textToCopy = testResultBox.textContent;
						return;
					}
					customUrlVal = endpointVal;
				}

				if (!apiKeyVal) {
					testSpinner.style.display = 'none';
					testBtn.disabled = false;
					testResultContainer.style.display = 'block';
					testResultBox.style.background = 'rgba(244, 63, 94, 0.1)';
					testResultBox.style.border = '1px solid rgba(244, 63, 94, 0.3)';
					testResultBox.style.color = '#f43f5e';
					testResultBox.textContent = 'Please enter an API Key to test connection.';
					textToCopy = testResultBox.textContent;
					return;
				}

				testSpinner.textContent = `Testing connection with model: ${selectedModel}...`;

				// Perform test connection
				const res = await this.agentCredentialService.testConnection(providerVal, apiKeyVal, selectedModel, customUrlVal);
				testSpinner.style.display = 'none';
				testBtn.disabled = false;
				testResultContainer.style.display = 'block';

				if (res.success) {
					testResultBox.style.background = 'rgba(34, 197, 94, 0.1)';
					testResultBox.style.border = '1px solid rgba(34, 197, 94, 0.3)';
					testResultBox.style.color = '#4ade80';
					testResultBox.textContent = `✓ Connection Successful!\n\nVerified with model: ${selectedModel}\nResponse:\n${res.message}`;
				} else {
					testResultBox.style.background = 'rgba(244, 63, 94, 0.1)';
					testResultBox.style.border = '1px solid rgba(244, 63, 94, 0.3)';
					testResultBox.style.color = '#f43f5e';
					testResultBox.textContent = `✗ Connection Failed using model ${selectedModel}:\n${res.message}`;
				}
				textToCopy = testResultBox.textContent;
			} catch (err: any) {
				testSpinner.style.display = 'none';
				testBtn.disabled = false;
				testResultContainer.style.display = 'block';
				testResultBox.style.background = 'rgba(244, 63, 94, 0.1)';
				testResultBox.style.border = '1px solid rgba(244, 63, 94, 0.3)';
				testResultBox.style.color = '#f43f5e';
				testResultBox.textContent = `✗ Error running connection test: ${err.message || err}`;
				textToCopy = testResultBox.textContent;
			}
		};
		btnRow.appendChild(testBtn);

		const saveBtn = targetDocument.createElement('button');
		saveBtn.style.cssText = `
			background: #2563eb;
			color: #ffffff;
			border: none;
			border-radius: 6px;
			padding: 7px 18px;
			font-size: 12px;
			font-weight: 600;
			cursor: pointer;
		`;
		saveBtn.textContent = 'Save Credential';
		saveBtn.onclick = async () => {
			const nameVal = nameInput.value.trim();
			const keyVal = keyInput.value.trim();
			const providerVal = provSelect.value;
			let customUrlVal: string | undefined = undefined;

			if (providerVal === 'custom-openai') {
				const endpointVal = endpointInput.value.trim();
				if (!endpointVal) {
					this.notificationService.warn('Please enter custom endpoint URL.');
					endpointInput.focus();
					return;
				}
				customUrlVal = endpointVal;
			}

			if (!keyVal) {
				this.notificationService.warn('Please enter API Key string.');
				keyInput.focus();
				return;
			}

			const finalName = nameVal || `${providerVal} Connection`;
			const createdCred = await this.agentCredentialService.addCredential(finalName, providerVal, keyVal, customUrlVal);

			if (fetchedModelsList.length > 0) {
				const updatedCred = {
					...createdCred,
					cachedModels: fetchedModelsList,
					connectionStatus: 'connected' as const,
					connectionMessage: `Connected successfully (retrieved model: ${testModelSelect.value})`,
					lastVerifiedAt: Date.now()
				};
				await this.agentCredentialService.updateCredential(updatedCred);
			}

			this.notificationService.info(`Credential '${finalName}' saved securely!`);
			await this.renderContent(container, targetDocument);
		};
		btnRow.appendChild(saveBtn);
	}

	private async renderCustomizationsTab(container: HTMLElement, targetDocument: Document): Promise<void> {
		const header = targetDocument.createElement('div');
		header.style.marginBottom = '24px';
		this.setElementHTML(header, `
			<h3 style="margin:0 0 8px 0;font-size:18px;font-weight:600;color:#ffffff;">Agent Customizations Settings</h3>
			<p style="margin:0;font-size:13px;color:#888888;line-height:1.5;">Customize settings and configuration options for Agent Customizations.</p>
		`);
		container.appendChild(header);

		const formCard = targetDocument.createElement('div');
		formCard.style.cssText = `
			background: #1c1c1c;
			border: 1px solid #2a2a2a;
			border-radius: 8px;
			padding: 20px;
			display: flex;
			flex-direction: column;
			gap: 16px;
			margin-bottom: 24px;
		`;
		container.appendChild(formCard);

		const pathGroup = targetDocument.createElement('div');
		const pathLabel = targetDocument.createElement('label');
		pathLabel.style.cssText = `display: block; font-size: 11px; opacity: 0.85; font-weight: 600; text-transform: uppercase; margin-bottom: 6px; letter-spacing: 0.05em; color: #888888;`;
		pathLabel.textContent = 'Global Custom Modules Storage Path:';
		
		const pathInput = targetDocument.createElement('input');
		pathInput.style.cssText = `width: 100%; padding: 8px 12px; font-size: 12px; background: #121212; border: 1px solid #2a2a2a; border-radius: 6px; color: #ffffff; outline: none; box-sizing: border-box;`;
		
		const savedPath = this._storageService.get('anyagent.globalEntityTypePath', StorageScope.PROFILE, '~/.anyagent/entity_type');
		pathInput.value = savedPath;
		pathInput.placeholder = 'e.g. ~/.anyagent/entity_type';

		pathGroup.appendChild(pathLabel);
		pathGroup.appendChild(pathInput);
		formCard.appendChild(pathGroup);

		const btnRow = targetDocument.createElement('div');
		btnRow.style.cssText = `display: flex; justify-content: flex-end; gap: 12px; margin-top: 10px;`;
		
		const saveBtn = targetDocument.createElement('button');
		saveBtn.style.cssText = `
			background: #38bdf8;
			color: #0f172a;
			border: none;
			border-radius: 6px;
			padding: 8px 16px;
			font-size: 12px;
			font-weight: 600;
			cursor: pointer;
		`;
		saveBtn.textContent = 'Save Changes';
		
		saveBtn.onclick = async () => {
			const newPath = pathInput.value.trim() || '~/.anyagent/entity_type';
			this._storageService.store('anyagent.globalEntityTypePath', newPath, StorageScope.PROFILE, StorageTarget.USER);
			this.notificationService.info('Global storage path updated successfully!');
		};

		btnRow.appendChild(saveBtn);
		formCard.appendChild(btnRow);
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

