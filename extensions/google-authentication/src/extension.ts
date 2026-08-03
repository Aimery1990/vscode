import * as vscode from 'vscode';
import { GoogleOAuthService } from './googleOAuthService';
import { GoogleAuthenticationProvider } from './googleAuthProvider';

export async function activate(context: vscode.ExtensionContext) {
	console.log('[Google Authentication] Extension activating...');

	const oauthService = new GoogleOAuthService(context);
	const provider = new GoogleAuthenticationProvider(oauthService);

	// Register with VS Code authentication service
	const providerDisposable = vscode.authentication.registerAuthenticationProvider(
		'google',
		'Google',
		provider,
		{ supportsMultipleAccounts: true }
	);
	context.subscriptions.push(providerDisposable, provider);

	// Create a sleek Status Bar Item for Google Account Profile / Login Status
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'anyagent.google.showProfile';
	context.subscriptions.push(statusBarItem);

	const updateStatusBar = async () => {
		const sessions = await provider.getSessions();
		if (sessions.length > 0) {
			const active = sessions[0];
			statusBarItem.text = `$(account) ${active.account.label.split(' ')[0]} (Google)`;
			statusBarItem.tooltip = `Logged in to Google as ${active.account.label}\nClick to manage account profile.`;
			statusBarItem.show();
		} else {
			statusBarItem.text = `$(account) Sign in with Google`;
			statusBarItem.tooltip = `Click to sign in with your Google Account`;
			statusBarItem.command = 'anyagent.google.login';
			statusBarItem.show();
		}
	};

	provider.onDidChangeSessions(() => updateStatusBar());
	await updateStatusBar();

	// Register Commands
	context.subscriptions.push(
		vscode.commands.registerCommand('anyagent.google.login', async () => {
			try {
				const session = await provider.createSession(['openid', 'profile', 'email']);
				vscode.window.showInformationMessage(`Successfully signed in to Google as ${session.account.label}`);
				await updateStatusBar();
			} catch (err: any) {
				vscode.window.showErrorMessage(`Google Sign-In Error: ${err.message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('anyagent.google.logout', async () => {
			const sessions = await provider.getSessions();
			if (sessions.length === 0) {
				vscode.window.showInformationMessage('No active Google sessions found.');
				return;
			}

			const items = sessions.map(s => ({
				label: s.account.label,
				id: s.id
			}));

			const selected = await vscode.window.showQuickPick(items, {
				placeHolder: 'Select Google Account to sign out'
			});

			if (selected) {
				await provider.removeSession(selected.id);
				vscode.window.showInformationMessage(`Signed out of Google account: ${selected.label}`);
				await updateStatusBar();
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('anyagent.google.showProfile', async () => {
			const sessions = await provider.getSessions();
			if (sessions.length === 0) {
				const answer = await vscode.window.showInformationMessage(
					'You are not currently signed in to Google.',
					'Sign In with Google'
				);
				if (answer === 'Sign In with Google') {
					await vscode.commands.executeCommand('anyagent.google.login');
				}
				return;
			}

			const active = sessions[0];
			const action = await vscode.window.showQuickPick([
				{ label: `$(account) Account: ${active.account.label}`, detail: 'Active Google Session', action: 'none' },
				{ label: '$(sign-out) Sign Out of Google', detail: 'Remove saved credentials', action: 'logout' }
			], { placeHolder: 'Google Account Settings' });

			if (action && action.action === 'logout') {
				await vscode.commands.executeCommand('anyagent.google.logout');
			}
		})
	);

	console.log('[Google Authentication] Extension activated successfully.');
}

export function deactivate() {}
