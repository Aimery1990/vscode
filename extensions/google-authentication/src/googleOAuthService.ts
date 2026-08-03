import * as http from 'http';
import * as url from 'url';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface GoogleUserProfile {
	id: string;
	email: string;
	verified_email: boolean;
	name: string;
	given_name?: string;
	family_name?: string;
	picture?: string;
}

export interface GoogleOAuthSession {
	id: string;
	accessToken: string;
	refreshToken?: string;
	idToken?: string;
	expiresAt: number;
	account: {
		id: string;
		label: string;
		email: string;
		name: string;
		picture?: string;
	};
	scopes: string[];
}

export interface GoogleOAuthConfig {
	clientId: string;
	clientSecret: string;
	authUri: string;
	tokenUri: string;
	userInfoUri: string;
	redirectUri: string;
	scopes: string[];
}

export class GoogleOAuthService {
	private static DEFAULT_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
	private static DEFAULT_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
	private static DEFAULT_AUTH_URI = 'https://accounts.google.com/o/oauth2/auth';
	private static DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
	private static DEFAULT_USER_INFO_URI = 'https://www.googleapis.com/oauth2/v2/userinfo';
	private static DEFAULT_SCOPES = ['openid', 'profile', 'email'];

	private config: GoogleOAuthConfig;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.config = this.loadConfig();
	}

	private loadConfig(): GoogleOAuthConfig {
		try {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			const rootPath = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : undefined;
			
			const possiblePaths = [
				path.join(__dirname, '..', '..', '..', 'resources', 'auth', 'auth_providers.json'),
				path.join(__dirname, '..', '..', 'resources', 'auth', 'auth_providers.json'),
				rootPath ? path.join(rootPath, 'resources', 'auth', 'auth_providers.json') : ''
			];

			for (const p of possiblePaths) {
				if (p && fs.existsSync(p)) {
					const content = fs.readFileSync(p, 'utf8');
					const json = JSON.parse(content);
					if (json.providers && json.providers.google) {
						const g = json.providers.google;
						return {
							clientId: g.clientId || GoogleOAuthService.DEFAULT_CLIENT_ID,
							clientSecret: g.clientSecret || GoogleOAuthService.DEFAULT_CLIENT_SECRET,
							authUri: g.authUri || GoogleOAuthService.DEFAULT_AUTH_URI,
							tokenUri: g.tokenUri || GoogleOAuthService.DEFAULT_TOKEN_URI,
							userInfoUri: g.userInfoUri || GoogleOAuthService.DEFAULT_USER_INFO_URI,
							redirectUri: g.redirectUri || 'http://localhost:54321/callback',
							scopes: g.scopes || GoogleOAuthService.DEFAULT_SCOPES
						};
					}
				}
			}
		} catch (err) {
			console.warn('[GoogleOAuthService] Failed to load custom config, using defaults:', err);
		}

		return {
			clientId: GoogleOAuthService.DEFAULT_CLIENT_ID,
			clientSecret: GoogleOAuthService.DEFAULT_CLIENT_SECRET,
			authUri: GoogleOAuthService.DEFAULT_AUTH_URI,
			tokenUri: GoogleOAuthService.DEFAULT_TOKEN_URI,
			userInfoUri: GoogleOAuthService.DEFAULT_USER_INFO_URI,
			redirectUri: 'http://localhost:54321/callback',
			scopes: GoogleOAuthService.DEFAULT_SCOPES
		};
	}

	public async login(scopes: string[] = this.config.scopes): Promise<GoogleOAuthSession> {
		const port = 54321;
		const redirectUri = `http://localhost:${port}/callback`;

		return new Promise<GoogleOAuthSession>((resolve, reject) => {
			const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
				try {
					const reqUrl = url.parse(req.url || '', true);
					if (reqUrl.pathname === '/callback') {
						const code = reqUrl.query.code as string;
						const error = reqUrl.query.error as string;

						if (error) {
							res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
							res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:50px;"><h2>Google Authentication Failed</h2><p>${error}</p></body></html>`);
							server.close();
							reject(new Error(`Authentication failed: ${error}`));
							return;
						}

						if (code) {
							res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
							res.end(`
								<html>
									<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;text-align:center;padding:50px;background:#1e1e1e;color:#ffffff;">
										<h2 style="color:#4ec9b0;">✓ AnyAgent Google Authentication Successful</h2>
										<p style="color:#cccccc;">You can close this tab and return to AnyAgent Desktop.</p>
										<script>setTimeout(() => window.close(), 3000);</script>
									</body>
								</html>
							`);
							server.close();

							try {
								const session = await this.exchangeCodeForToken(code, redirectUri, scopes);
								resolve(session);
							} catch (tokenErr) {
								reject(tokenErr);
							}
						}
					}
				} catch (e) {
					server.close();
					reject(e);
				}
			});

			server.listen(port, async () => {
				const authUrl = `${this.config.authUri}?client_id=${encodeURIComponent(this.config.clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes.join(' '))}&access_type=offline&prompt=consent`;
				await vscode.env.openExternal(vscode.Uri.parse(authUrl));
			});

			server.on('error', (err: any) => {
				reject(new Error(`Failed to start auth callback server: ${err.message}`));
			});
		});
	}

	private async exchangeCodeForToken(code: string, redirectUri: string, scopes: string[]): Promise<GoogleOAuthSession> {
		const params = new URLSearchParams();
		params.append('code', code);
		params.append('client_id', this.config.clientId);
		params.append('client_secret', this.config.clientSecret);
		params.append('redirect_uri', redirectUri);
		params.append('grant_type', 'authorization_code');

		const response = await fetch(this.config.tokenUri, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: params.toString()
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Token exchange failed (${response.status}): ${text}`);
		}

		const tokenData: any = await response.json();
		const accessToken = tokenData.access_token;
		const refreshToken = tokenData.refresh_token;
		const idToken = tokenData.id_token;
		const expiresIn = tokenData.expires_in || 3600;

		const profile = await this.fetchUserProfile(accessToken);

		const session: GoogleOAuthSession = {
			id: `google-${profile.id}`,
			accessToken,
			refreshToken,
			idToken,
			expiresAt: Date.now() + expiresIn * 1000,
			account: {
				id: profile.id,
				label: profile.name || profile.email,
				email: profile.email,
				name: profile.name,
				picture: profile.picture
			},
			scopes
		};

		return session;
	}

	public async fetchUserProfile(accessToken: string): Promise<GoogleUserProfile> {
		const response = await fetch(this.config.userInfoUri, {
			headers: { Authorization: `Bearer ${accessToken}` }
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Failed to fetch Google profile (${response.status}): ${text}`);
		}

		return (await response.json()) as GoogleUserProfile;
	}

	public async storeSession(session: GoogleOAuthSession): Promise<void> {
		const existingSessions = await this.getStoredSessions();
		const filtered = existingSessions.filter(s => s.id !== session.id);
		filtered.push(session);
		await this.context.secrets.store('anyagent_google_sessions', JSON.stringify(filtered));
	}

	public async getStoredSessions(): Promise<GoogleOAuthSession[]> {
		try {
			const raw = await this.context.secrets.get('anyagent_google_sessions');
			if (raw) {
				return JSON.parse(raw) as GoogleOAuthSession[];
			}
		} catch (e) {
			console.error('[GoogleOAuthService] Error reading stored sessions:', e);
		}
		return [];
	}

	public async removeSession(sessionId: string): Promise<void> {
		const existingSessions = await this.getStoredSessions();
		const filtered = existingSessions.filter(s => s.id !== sessionId);
		await this.context.secrets.store('anyagent_google_sessions', JSON.stringify(filtered));
	}
}
