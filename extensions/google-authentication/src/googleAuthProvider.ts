import * as vscode from 'vscode';
import { GoogleOAuthService, GoogleOAuthSession } from './googleOAuthService';

export class GoogleAuthenticationProvider implements vscode.AuthenticationProvider, vscode.Disposable {
	private readonly _onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this._onDidChangeSessions.event;

	constructor(
		private readonly oauthService: GoogleOAuthService
	) {}

	public async getSessions(_scopes?: readonly string[]): Promise<vscode.AuthenticationSession[]> {
		const storedSessions = await this.oauthService.getStoredSessions();
		return storedSessions.map(session => this.convertToVscodeSession(session));
	}

	public async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
		try {
			const session = await this.oauthService.login(scopes ? [...scopes] : undefined);
			await this.oauthService.storeSession(session);

			this._onDidChangeSessions.fire({
				added: [this.convertToVscodeSession(session)],
				removed: [],
				changed: []
			});

			return this.convertToVscodeSession(session);
		} catch (err: any) {
			vscode.window.showErrorMessage(`Google Sign-In failed: ${err.message}`);
			throw err;
		}
	}

	public async removeSession(sessionId: string): Promise<void> {
		const storedSessions = await this.oauthService.getStoredSessions();
		const targetSession = storedSessions.find(s => s.id === sessionId);
		if (targetSession) {
			await this.oauthService.removeSession(sessionId);
			this._onDidChangeSessions.fire({
				added: [],
				removed: [this.convertToVscodeSession(targetSession)],
				changed: []
			});
		}
	}

	private convertToVscodeSession(session: GoogleOAuthSession): vscode.AuthenticationSession {
		return {
			id: session.id,
			accessToken: session.accessToken,
			account: {
				id: session.account.id,
				label: `${session.account.name} (${session.account.email})`
			},
			scopes: session.scopes
		};
	}

	public dispose(): void {
		this._onDidChangeSessions.dispose();
	}
}
