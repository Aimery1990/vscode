/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Any Agent / Google Deepmind. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { getActiveDocument } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';

export class AccountSignInModal extends Disposable {
	private container: HTMLElement | undefined;

	constructor(
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

	public async show(): Promise<void> {
		this.createModal();
	}

	private createModal(): void {
		const targetDocument = getActiveDocument() || window.document || mainWindow.document;

		// Remove any existing modal
		const existing = targetDocument.querySelector('.anyagent-signin-modal-overlay');
		if (existing) {
			existing.remove();
		}

		// Fullscreen Overlay with dark glassmorphism
		const overlay = targetDocument.createElement('div');
		overlay.className = 'anyagent-signin-modal-overlay';
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

		// Modal Card (Exact layout matching VS Code sign-in screenshot)
		const modal = targetDocument.createElement('div');
		modal.className = 'anyagent-signin-modal';
		modal.style.cssText = `
			width: 460px;
			background: #18181b;
			border: 1px solid #27272a;
			border-radius: 16px;
			box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.75);
			padding: 36px 32px;
			display: flex;
			flex-direction: column;
			align-items: center;
			position: relative;
			color: #f4f4f5;
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
		`;

		// Close Button
		const closeBtn = targetDocument.createElement('button');
		closeBtn.innerHTML = '✕';
		closeBtn.style.cssText = `
			position: absolute;
			top: 18px;
			right: 20px;
			background: transparent;
			border: none;
			color: #71717a;
			font-size: 18px;
			cursor: pointer;
			padding: 4px 8px;
			border-radius: 6px;
			transition: all 0.15s ease;
		`;
		closeBtn.onmouseenter = () => { closeBtn.style.color = '#ffffff'; closeBtn.style.background = '#27272a'; };
		closeBtn.onmouseleave = () => { closeBtn.style.color = '#71717a'; closeBtn.style.background = 'transparent'; };
		closeBtn.onclick = () => this.close();
		modal.appendChild(closeBtn);

		// Brand Icon Header (Any Agent / Google AI Icon)
		const iconContainer = targetDocument.createElement('div');
		iconContainer.style.cssText = `
			width: 64px;
			height: 64px;
			border-radius: 16px;
			background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
			display: flex;
			align-items: center;
			justify-content: center;
			margin-bottom: 20px;
			box-shadow: 0 8px 24px rgba(59, 130, 246, 0.3);
		`;
		iconContainer.innerHTML = `
			<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z"/>
				<circle cx="12" cy="12" r="3" fill="#ffffff"/>
			</svg>
		`;
		modal.appendChild(iconContainer);

		// Title
		const title = targetDocument.createElement('h2');
		title.style.cssText = `
			margin: 0 0 24px 0;
			font-size: 20px;
			font-weight: 600;
			color: #ffffff;
			text-align: center;
			letter-spacing: -0.2px;
		`;
		title.textContent = 'Sign in to use Any Agent';
		modal.appendChild(title);

		// Provider Action Buttons Stack
		const buttonsStack = targetDocument.createElement('div');
		buttonsStack.style.cssText = `
			width: 100%;
			display: flex;
			flex-direction: column;
			gap: 12px;
			margin-bottom: 28px;
		`;

		// 1. Continue with Google (Primary Auth)
		buttonsStack.appendChild(this.createProviderButton(
			targetDocument,
			'Continue with Google',
			`
				<svg width="18" height="18" viewBox="0 0 24 24">
					<path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
					<path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
					<path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
					<path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
				</svg>
			`,
			'#27272a',
			'#ffffff',
			async () => {
				this.close();
				this.notificationService.info('Launching Google OAuth login via browser...');
				await this.commandService.executeCommand('anyagent.google.login');
			}
		));

		// 2. Continue with GitHub
		buttonsStack.appendChild(this.createProviderButton(
			targetDocument,
			'Continue with GitHub',
			`
				<svg width="18" height="18" viewBox="0 0 24 24" fill="#ffffff">
					<path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
				</svg>
			`,
			'#2563eb',
			'#ffffff',
			() => {
				this.notificationService.info('GitHub Authentication configuration is ready in resources/auth.');
			}
		));

		// 3. Continue with Microsoft
		buttonsStack.appendChild(this.createProviderButton(
			targetDocument,
			'Continue with Microsoft',
			`
				<svg width="18" height="18" viewBox="0 0 23 23">
					<path fill="#f35325" d="M1 1h10v10H1z"/>
					<path fill="#81bc06" d="M12 1h10v10H1z"/>
					<path fill="#05a6f0" d="M1 12h10v10H1z"/>
					<path fill="#ffba08" d="M12 12h10v10H1z"/>
				</svg>
			`,
			'#27272a',
			'#ffffff',
			() => {
				this.notificationService.info('Microsoft Authentication configuration is ready in resources/auth.');
			}
		));

		// 4. Continue with Apple
		buttonsStack.appendChild(this.createProviderButton(
			targetDocument,
			'Continue with Apple',
			`
				<svg width="18" height="18" viewBox="0 0 24 24" fill="#ffffff">
					<path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.32c.67-.82 1.13-1.97.99-3.12-1 .04-2.19.67-2.88 1.47-.61.71-1.15 1.88-.99 3.01 1.11.08 2.22-.54 2.88-1.36z"/>
				</svg>
			`,
			'#27272a',
			'#ffffff',
			() => {
				this.notificationService.info('Apple Authentication configuration is ready in resources/auth.');
			}
		));

		modal.appendChild(buttonsStack);

		// Legal Terms Footer
		const footer = targetDocument.createElement('div');
		footer.style.cssText = `
			font-size: 11px;
			color: #71717a;
			text-align: center;
			line-height: 1.5;
			padding: 0 10px;
		`;
		footer.innerHTML = `
			By continuing, you agree to Any Agent's <span style="color:#a1a1aa;text-decoration:underline;cursor:pointer;">Terms</span> and <span style="color:#a1a1aa;text-decoration:underline;cursor:pointer;">Privacy Statement</span>. Any Agent may process data to improve services.
		`;
		modal.appendChild(footer);

		overlay.appendChild(modal);

		// Close on clicking outside modal
		overlay.onclick = (e) => {
			if (e.target === overlay) {
				this.close();
			}
		};

		// Synchronously append overlay to DOM
		targetDocument.body.appendChild(overlay);
		if (window.document && window.document.body && window.document !== targetDocument) {
			window.document.body.appendChild(overlay.cloneNode(true));
		}
		this.container = overlay;
	}

	private createProviderButton(
		targetDocument: Document,
		label: string,
		iconSvgHtml: string,
		bgColor: string,
		textColor: string,
		onClick: () => void
	): HTMLElement {
		const btn = targetDocument.createElement('button');
		btn.style.cssText = `
			width: 100%;
			height: 44px;
			background: ${bgColor};
			color: ${textColor};
			border: 1px solid #3f3f46;
			border-radius: 8px;
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 12px;
			font-size: 14px;
			font-weight: 500;
			cursor: pointer;
			transition: all 0.15s ease;
		`;

		btn.innerHTML = `${iconSvgHtml} <span>${label}</span>`;

		btn.onmouseenter = () => {
			btn.style.borderColor = '#52525b';
			btn.style.filter = 'brightness(1.15)';
		};
		btn.onmouseleave = () => {
			btn.style.borderColor = '#3f3f46';
			btn.style.filter = 'brightness(1)';
		};
		btn.onclick = onClick;

		return btn;
	}
}
