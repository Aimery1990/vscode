/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WorkbenchActionExecutedClassification, WorkbenchActionExecutedEvent } from '../../../../../base/common/actions.js';
import { raceTimeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Lazy } from '../../../../../base/common/lazy.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import product from '../../../../../platform/product/common/product.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import { CountTokensCallback, ILanguageModelToolsService, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource, ToolProgress } from '../../common/tools/languageModelToolsService.js';
import { IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentService } from '../../common/participants/chatAgents.js';
import { ChatEntitlementContext, IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';
import { ChatModel, ChatRequestModel, IChatRequestModel, IChatRequestVariableData } from '../../common/model/chatModel.js';
import { ChatMode } from '../../common/chatModes.js';
import { ChatRequestAgentPart, ChatRequestToolPart } from '../../common/requestParser/chatParserTypes.js';
import { IChatProgress, IChatService } from '../../common/chatService/chatService.js';
import { IChatRequestToolEntry } from '../../common/attachments/chatVariableEntries.js';
import { ChatAgentLocation, ChatConfiguration, ChatModeKind } from '../../common/constants.js';
import { ILanguageModelsService } from '../../common/languageModels.js';
import { CHAT_OPEN_ACTION_ID, CHAT_SETUP_ACTION_ID } from '../actions/chatActions.js';
import { IChatWidgetService } from '../chat.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { CodeAction, CodeActionList, Command, NewSymbolName, NewSymbolNameTriggerKind } from '../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IRange, Range } from '../../../../../editor/common/core/range.js';
import { ISelection, Selection } from '../../../../../editor/common/core/selection.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { CodeActionKind } from '../../../../../editor/contrib/codeAction/common/types.js';
import { ACTION_START as INLINE_CHAT_START } from '../../../inlineChat/common/inlineChat.js';
import { IPosition } from '../../../../../editor/common/core/position.js';
import { IMarker, IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { ChatSetupController } from './chatSetupController.js';
import { ChatSetupAnonymous, ChatSetupStep, IChatSetupResult } from './chatSetup.js';
import { ChatSetup } from './chatSetupRunner.js';
import { chatViewsWelcomeRegistry } from '../viewsWelcome/chatViewsWelcome.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IDefaultAccountService } from '../../../../../platform/defaultAccount/common/defaultAccount.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import { IExtensionsWorkbenchService } from '../../../extensions/common/extensions.js';
import { IAgentCredentialService } from '../../../agentsManager/common/agentsManager.js';
import { IWorkspacesExplorerService } from '../../../workspacesExplorer/common/workspacesExplorer.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { listenStream } from '../../../../../base/common/stream.js';

const defaultChat = {
	extensionId: product.defaultChatAgent?.extensionId ?? '',
	chatExtensionId: product.defaultChatAgent?.chatExtensionId ?? '',
	provider: product.defaultChatAgent?.provider ?? { default: { id: '', name: '' }, enterprise: { id: '', name: '' }, apple: { id: '', name: '' }, google: { id: '', name: '' } },
	outputChannelId: product.defaultChatAgent?.chatExtensionOutputId ?? '',
	outputExtensionStateCommand: product.defaultChatAgent?.chatExtensionOutputExtensionStateCommand ?? '',
};

const ToolsAgentContextKey = ContextKeyExpr.and(
	ContextKeyExpr.equals(`config.${ChatConfiguration.AgentEnabled}`, true),
	ContextKeyExpr.not(`previewFeaturesDisabled`) // Set by extension
);

interface IFallbackCredential {
	id: string;
	isEnabled?: boolean;
	providerId?: string;
	cachedModels?: string[];
	customUrl?: string;
}

export class SetupAgent extends Disposable implements IChatAgentImplementation {

	static registerDefaultAgents(instantiationService: IInstantiationService, location: ChatAgentLocation, mode: ChatModeKind, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): { agent: SetupAgent; disposable: IDisposable } {
		return instantiationService.invokeFunction(accessor => {
			const chatAgentService = accessor.get(IChatAgentService);

			let description;
			if (mode === ChatModeKind.Ask) {
				description = ChatMode.Ask.description.get();
			} else if (mode === ChatModeKind.Edit) {
				description = ChatMode.Edit.description.get();
			} else {
				description = ChatMode.Agent.description.get();
			}

			let id: string;
			switch (location) {
				case ChatAgentLocation.Chat:
					if (mode === ChatModeKind.Ask) {
						id = 'setup.chat';
					} else if (mode === ChatModeKind.Edit) {
						id = 'setup.edits';
					} else {
						id = 'setup.agent';
					}
					break;
				case ChatAgentLocation.Terminal:
					id = 'setup.terminal';
					break;
				case ChatAgentLocation.EditorInline:
					id = 'setup.editor';
					break;
				case ChatAgentLocation.Notebook:
					id = 'setup.notebook';
					break;
			}

			return SetupAgent.doRegisterAgent(instantiationService, chatAgentService, id, 'Any Agent', true, description, location, mode, context, controller);
		});
	}

	static registerBuiltInAgents(instantiationService: IInstantiationService, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const chatAgentService = accessor.get(IChatAgentService);

			const disposables = new DisposableStore();

			// Register VSCode agent
			const { disposable: vscodeDisposable } = SetupAgent.doRegisterAgent(instantiationService, chatAgentService, 'setup.vscode', 'vscode', false, localize2('vscodeAgentDescription', "Ask questions about VS Code").value, ChatAgentLocation.Chat, ChatModeKind.Agent, context, controller);
			disposables.add(vscodeDisposable);

			// Register workspace agent
			const { disposable: workspaceDisposable } = SetupAgent.doRegisterAgent(instantiationService, chatAgentService, 'setup.workspace', 'workspace', false, localize2('workspaceAgentDescription', "Ask about your workspace").value, ChatAgentLocation.Chat, ChatModeKind.Agent, context, controller);
			disposables.add(workspaceDisposable);

			// Register terminal agent
			const { disposable: terminalDisposable } = SetupAgent.doRegisterAgent(instantiationService, chatAgentService, 'setup.terminal.agent', 'terminal', false, localize2('terminalAgentDescription', "Ask how to do something in the terminal").value, ChatAgentLocation.Chat, ChatModeKind.Agent, context, controller);
			disposables.add(terminalDisposable);

			// Register tools
			disposables.add(SetupTool.registerTool(instantiationService, {
				id: 'setup_tools_createNewWorkspace',
				source: ToolDataSource.Internal,
				icon: Codicon.newFolder,
				displayName: localize('setupToolDisplayName', "New Workspace"),
				modelDescription: 'Scaffold a new workspace in VS Code',
				userDescription: localize('setupToolsDescription', "Scaffold a new workspace in VS Code"),
				canBeReferencedInPrompt: true,
				toolReferenceName: 'new',
				when: ContextKeyExpr.true(),
			}));

			return disposables;
		});
	}

	private static doRegisterAgent(instantiationService: IInstantiationService, chatAgentService: IChatAgentService, id: string, name: string, isDefault: boolean, description: string, location: ChatAgentLocation, mode: ChatModeKind, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): { agent: SetupAgent; disposable: IDisposable } {
		const disposables = new DisposableStore();
		disposables.add(chatAgentService.registerAgent(id, {
			id,
			name,
			isDefault,
			isCore: true,
			modes: [mode],
			when: mode === ChatModeKind.Agent ? ToolsAgentContextKey?.serialize() : undefined,
			slashCommands: [],
			disambiguation: [],
			locations: [location],
			metadata: { helpTextPrefix: SetupAgent.SETUP_NEEDED_MESSAGE },
			description,
			extensionId: nullExtensionDescription.identifier,
			extensionVersion: undefined,
			extensionDisplayName: nullExtensionDescription.name,
			extensionPublisherId: nullExtensionDescription.publisher
		}));

		const agent = disposables.add(instantiationService.createInstance(SetupAgent, context, controller, location));
		disposables.add(chatAgentService.registerAgentImplementation(id, agent));
		if (mode === ChatModeKind.Agent) {
			chatAgentService.updateAgent(id, { themeIcon: Codicon.tools });
		}

		return { agent, disposable: disposables };
	}

	private static readonly SETUP_NEEDED_MESSAGE = new MarkdownString(localize('settingUpCopilotNeeded', "You need to be signed in to use Any Agent."));
	private static readonly TRUST_NEEDED_MESSAGE = new MarkdownString(localize('trustNeeded', "You need to trust this workspace to use Chat."));

	private static readonly CHAT_RETRY_COMMAND_ID = 'workbench.action.chat.retrySetup';
	private static readonly CHAT_SHOW_OUTPUT_COMMAND_ID = 'workbench.action.chat.showOutput';

	private readonly _onUnresolvableError = this._register(new Emitter<void>());
	readonly onUnresolvableError = this._onUnresolvableError.event;

	private readonly pendingForwardedRequests = new ResourceMap<Promise<void>>();

	constructor(
		private readonly context: ChatEntitlementContext,
		private readonly controller: Lazy<ChatSetupController>,
		private readonly location: ChatAgentLocation,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IWorkbenchEnvironmentService _environmentService: IWorkbenchEnvironmentService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
		@IViewsService _viewsService: IViewsService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IOutputService _outputService: IOutputService,
		@IExtensionsWorkbenchService _extensionsWorkbenchService: IExtensionsWorkbenchService,
		@ICommandService _commandService: ICommandService,
	) {
		super();

		this.registerCommands();
	}

	private registerCommands(): void {

		// Retry chat command
		this._register(CommandsRegistry.registerCommand(SetupAgent.CHAT_RETRY_COMMAND_ID, async (accessor, sessionResource: URI) => {
			const hostService = accessor.get(IHostService);
			const chatWidgetService = accessor.get(IChatWidgetService);

			const widget = chatWidgetService.getWidgetBySessionResource(sessionResource);
			await widget?.clear();

			hostService.reload();
		}));

		// Show output command: execute extension state command if available, then show output channel
		this._register(CommandsRegistry.registerCommand(SetupAgent.CHAT_SHOW_OUTPUT_COMMAND_ID, async (accessor) => {
			const commandService = accessor.get(ICommandService);

			if (defaultChat.outputExtensionStateCommand) {
				// Command invocation may fail or is blocked by the extension activating
				// so we just don't wait and timeout after a certain time, logging the error if it fails or times out.
				raceTimeout(
					commandService.executeCommand(defaultChat.outputExtensionStateCommand),
					5000,
					() => this.logService.info('[chat setup] Timed out executing extension state command')
				).then(undefined, error => {
					this.logService.info('[chat setup] Failed to execute extension state command', error);
				});
			}

			if (defaultChat.outputChannelId) {
				await commandService.executeCommand(`workbench.action.output.show.${defaultChat.outputChannelId}`);
			}
		}));
	}

	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void): Promise<IChatAgentResult> {
		return this.instantiationService.invokeFunction(async accessor /* using accessor for lazy loading */ => {
			const chatService = accessor.get(IChatService);
			const languageModelsService = accessor.get(ILanguageModelsService);
			const chatWidgetService = accessor.get(IChatWidgetService);
			const chatAgentService = accessor.get(IChatAgentService);
			const languageModelToolsService = accessor.get(ILanguageModelToolsService);
			const defaultAccountService = accessor.get(IDefaultAccountService);

			return this.doInvoke(request, part => progress([part]), chatService, languageModelsService, chatWidgetService, chatAgentService, languageModelToolsService, defaultAccountService);
		});
	}

	private async doInvoke(request: IChatAgentRequest, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatWidgetService: IChatWidgetService, chatAgentService: IChatAgentService, languageModelToolsService: ILanguageModelToolsService, defaultAccountService: IDefaultAccountService): Promise<IChatAgentResult> {
		if (false as boolean) {
			return this.doInvokeWithSetup(request, progress, chatService, languageModelsService, chatWidgetService, chatAgentService, languageModelToolsService, defaultAccountService);
		}

		return this.doInvokeWithoutSetup(request, progress, chatService, languageModelsService, chatWidgetService, chatAgentService, languageModelToolsService);
	}

	private async doInvokeWithoutSetup(request: IChatAgentRequest, progress: (part: IChatProgress) => void, _chatService: IChatService, _languageModelsService: ILanguageModelsService, chatWidgetService: IChatWidgetService, _chatAgentService: IChatAgentService, languageModelToolsService: ILanguageModelToolsService): Promise<IChatAgentResult> {
		const requestModel = chatWidgetService.getWidgetBySessionResource(request.sessionResource)?.viewModel?.model.getRequests().at(-1);
		if (!requestModel) {
			this.logService.error('[chat setup] Request model not found, cannot dispatch request.');
			return {}; // this should not happen
		}

		await this.executeAnyAgentDirect(requestModel, progress, languageModelToolsService, chatWidgetService);
		return {};
	}

	private async forwardRequestToChat(requestModel: IChatRequestModel, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatAgentService: IChatAgentService, chatWidgetService: IChatWidgetService, languageModelToolsService: ILanguageModelToolsService): Promise<void> {
		try {
			await this.doForwardRequestToChat(requestModel, progress, chatService, languageModelsService, chatAgentService, chatWidgetService, languageModelToolsService);
		} catch (error) {
			this.logService.error('[chat setup] Failed to forward request to chat', error);

			progress({
				kind: 'warning',
				content: new MarkdownString(localize('copilotUnavailableWarning', "Failed to get a response. Please try again."))
			});
		}
	}

	private async doForwardRequestToChat(requestModel: IChatRequestModel, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatAgentService: IChatAgentService, chatWidgetService: IChatWidgetService, languageModelToolsService: ILanguageModelToolsService): Promise<void> {
		if (this.pendingForwardedRequests.has(requestModel.session.sessionResource)) {
			throw new Error('Request already in progress');
		}

		const forwardRequest = this.doForwardRequestToChatWhenReady(requestModel, progress, chatService, languageModelsService, chatAgentService, chatWidgetService, languageModelToolsService);
		this.pendingForwardedRequests.set(requestModel.session.sessionResource, forwardRequest);

		try {
			await forwardRequest;
		} finally {
			this.pendingForwardedRequests.delete(requestModel.session.sessionResource);
		}
	}

	private async doForwardRequestToChatWhenReady(requestModel: IChatRequestModel, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatAgentService: IChatAgentService, chatWidgetService: IChatWidgetService, languageModelToolsService: ILanguageModelToolsService): Promise<void> {
		if (false as boolean) {
			const widget = chatWidgetService.getWidgetBySessionResource(requestModel.session.sessionResource);
			const modeInfo = widget?.input.currentModeInfo;
			this.whenAgentActivated(chatService);
			this.whenAgentReady(chatAgentService, modeInfo?.kind);
			this.whenLanguageModelReady(languageModelsService, requestModel.modelId);
			this.whenToolsModelReady(languageModelToolsService, requestModel);
			const dummyStore = new DisposableStore();
			this.whenPanelAgentHasGuidance(dummyStore);
			dummyStore.dispose();
		}

		await this.executeAnyAgentDirect(requestModel, progress, languageModelToolsService, chatWidgetService);
	}

	private async executeAnyAgentDirect(
		requestModel: IChatRequestModel,
		progress: (part: IChatProgress) => void,
		languageModelToolsService: ILanguageModelToolsService,
		_chatWidgetService: IChatWidgetService
	): Promise<void> {
		const userPrompt = requestModel.message.text.trim();
		this.logService.info('[AnyAgent] Direct AnyAgent execution triggered for prompt:', userPrompt);

		progress({
			kind: 'progressMessage',
			content: new MarkdownString(localize('anyagentProcessing', "Any Agent is processing...")),
			shimmer: true,
		});

		// 1. Direct Ticket Creation / Tool Invocation heuristic
		const ticketMatch = userPrompt.match(/create\s+(?:a\s+(?:new\s+)?)?(task|ticket|job|note|resume)\s+(?:under|in)\s+(.+?)\s+(?:about|for|called|named|with\s+title)\s+(.+)/i)
			|| userPrompt.match(/create\s+(?:a\s+(?:new\s+)?)?(task|ticket|job|note|resume)\s+(?:under|in)\s+([^:]+?):\s*(.+)/i)
			|| userPrompt.match(/create\s+(?:a\s+(?:new\s+)?)?(task|ticket|job|note|resume)\s+(?:called|named|about|for)\s+(.+)/i)
			|| userPrompt.match(/create\s+(?:a\s+(?:new\s+)?)?(task|ticket|job|note|resume)\s+(?:under|in)\s+(\S+)\s+(.+)/i);

		if (ticketMatch) {
			const ticketType = ticketMatch[1].toLowerCase();
			let rawWorkspace = ticketMatch[2] ? ticketMatch[2].replace(/["']/g, '').trim() : '';
			let title = ticketMatch[3] ? ticketMatch[3].replace(/["']/g, '').trim() : '';

			// If matched the 3-element regex without workspace (e.g. create a task for demo)
			if (!title && rawWorkspace) {
				title = rawWorkspace;
				rawWorkspace = '';
			}

			let targetWorkspaceId = rawWorkspace;
			let displayWorkspaceName = rawWorkspace;
			try {
				const workspacesService = this.instantiationService.invokeFunction(accessor => {
					try {
						return accessor.get(IWorkspacesExplorerService);
					} catch {
						return undefined;
					}
				});
				if (workspacesService) {
					const workspaces = await workspacesService.getWorkspaces();
					if (workspaces && workspaces.length > 0) {
						if (rawWorkspace) {
							const clean = rawWorkspace.toLowerCase().replace(/[\s_-]+/g, '');
							const found = workspaces.find(w =>
								(w.id && w.id.toLowerCase().replace(/[\s_-]+/g, '') === clean) ||
								(w.code && w.code.toLowerCase().replace(/[\s_-]+/g, '') === clean) ||
								(w.name && w.name.toLowerCase().replace(/[\s_-]+/g, '') === clean) ||
								(w.code && `${w.code.toLowerCase()}0000` === clean)
							);
							if (found) {
								targetWorkspaceId = found.id;
								displayWorkspaceName = `${found.name} (${found.id})`;
							}
						}
						if (!targetWorkspaceId) {
							const current = workspaces.find(w => w.isCurrent) || workspaces[0];
							targetWorkspaceId = current.id;
							displayWorkspaceName = `${current.name} (${current.id})`;
						}
					}
				}
			} catch (e) {
				this.logService.warn('[AnyAgent] Failed to resolve workspace for ticket:', e);
			}

			try {
				const tool = languageModelToolsService.getTool('anyagent_create_ticket');
				if (tool) {
					const invocation: IToolInvocation = {
						callId: `anyagent_${Date.now()}`,
						toolId: 'anyagent_create_ticket',
						parameters: {
							workspace_id: targetWorkspaceId,
							parent_path: '/',
							ticket_type: ticketType,
							title: title,
							description: `Created via Any Agent Chat: ${title}`,
							priority: 'Medium',
							worklog_record: {
								user_request: userPrompt,
								update_summary: `Created ${ticketType} "${title}"`,
								update_details: [`Initialized standard 4-MD files for ${ticketType} under ${displayWorkspaceName}`],
								update_conclusion: `Successfully created ${ticketType}`
							}
						},
						context: undefined
					};
					const result = await languageModelToolsService.invokeTool(invocation, async () => 1, CancellationToken.None);
					const toolMessage = typeof result.toolResultMessage === 'string' ? result.toolResultMessage : result.toolResultMessage?.value;

					progress({
						kind: 'markdownContent',
						content: new MarkdownString(
							`### Task Created Successfully\n\n` +
							`- **Title**: ${title}\n` +
							`- **Type**: \`${ticketType}\`\n` +
							`- **Workspace**: \`${displayWorkspaceName}\`\n\n` +
							`${toolMessage ? `> ${toolMessage}\n\n` : ''}` +
							`*You can view and inspect this card in the Workspaces Explorer.*`
						)
					});
					return;
				}
			} catch (err: unknown) {
				this.logService.error('[AnyAgent] Direct ticket creation error:', err);
			}
		}

		// 2. Try streaming LLM if credentials exist
		try {
			const credentialService = this.instantiationService.invokeFunction(accessor => {
				try {
					return accessor.get(IAgentCredentialService);
				} catch {
					return undefined;
				}
			});

			if (credentialService) {
				const creds = await credentialService.getCredentials();
				const activeCred = creds.find(c => c.isEnabled) || creds[0];
				if (activeCred) {
					const apiKey = await credentialService.getApiKey(activeCred.id);
					if (apiKey || activeCred.providerId === 'ollama' || activeCred.providerId === 'custom') {
						const requestService = this.instantiationService.invokeFunction(accessor => accessor.get(IRequestService));
						await this.streamLlmDirect(activeCred as IFallbackCredential, apiKey || '', userPrompt, progress, languageModelToolsService, requestService);
						return;
					}
				}
			}
		} catch (llmErr) {
			this.logService.warn('[AnyAgent] LLM direct execution failed:', llmErr);
		}

		// 3. Fallback greeting & instruction
		progress({
			kind: 'markdownContent',
			content: new MarkdownString(
				`### Hello from **Any Agent**\n\n` +
				`I received your instruction:\n> \`${userPrompt}\`\n\n` +
				`To enable AI-powered chat and automated task execution:\n` +
				`1. Click the **Agent Central** icon in the top title bar or open **Settings**\n` +
				`2. Configure your **Google Gemini**, **Claude**, or **OpenAI** API key\n\n` +
				`*You can also directly execute ticket commands, e.g.:*\n` +
				`\`create a new task under <WORKSPACE_ID> about <Title>\``
			)
		});
	}

	private async streamLlmDirect(
		cred: IFallbackCredential,
		apiKey: string,
		prompt: string,
		progress: (part: IChatProgress) => void,
		languageModelToolsService: ILanguageModelToolsService,
		requestService: IRequestService
	): Promise<void> {
		const cleanModel = cred.cachedModels?.[0] || (cred.providerId === 'gemini' ? 'gemini-1.5-flash' : cred.providerId === 'openai' ? 'gpt-4o' : 'claude-3-5-sonnet-20241022');
		if (cred.providerId === 'gemini') {
			const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:streamGenerateContent?key=${apiKey}&alt=sse`;
			const response = await requestService.request({
				type: 'POST',
				url,
				headers: { 'Content-Type': 'application/json' },
				data: JSON.stringify({
					contents: [{ role: 'user', parts: [{ text: prompt }] }],
					system_instruction: { parts: [{ text: localize('anyagent.systemPrompt', "You are Any Agent Workspace AI assistant. Help users manage projects, code, and tickets concisely.") }] }
				}),
				callSite: 'anyagent.directChat'
			}, CancellationToken.None);

			if (response.res.statusCode && (response.res.statusCode < 200 || response.res.statusCode >= 300)) {
				throw new Error(`HTTP ${response.res.statusCode} Error from Gemini API`);
			}

			let buffer = '';
			await new Promise<void>((resolve, reject) => {
				listenStream(response.stream, {
					onData: (chunk: VSBuffer) => {
						buffer += chunk.toString();
						const lines = buffer.split('\n');
						buffer = lines.pop() || '';
						for (const line of lines) {
							const trimmed = line.trim();
							if (trimmed.startsWith('data: ')) {
								const dataStr = trimmed.slice(6).trim();
								if (dataStr === '[DONE]') {
									continue;
								}
								try {
									const json = JSON.parse(dataStr);
									const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
									if (text) {
										progress({ kind: 'markdownContent', content: new MarkdownString(text) });
									}
								} catch { }
							}
						}
					},
					onError: reject,
					onEnd: resolve
				});
			});
		} else if (cred.providerId === 'openai') {
			const url = (cred.customUrl || 'https://api.openai.com/v1') + '/chat/completions';
			const response = await requestService.request({
				type: 'POST',
				url,
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${apiKey}`
				},
				data: JSON.stringify({
					model: cleanModel,
					stream: true,
					messages: [
						{ role: 'system', content: localize('anyagent.systemPrompt', "You are Any Agent Workspace AI assistant. Help users manage projects, code, and tickets concisely.") },
						{ role: 'user', content: prompt }
					]
				}),
				callSite: 'anyagent.directChat'
			}, CancellationToken.None);

			if (response.res.statusCode && (response.res.statusCode < 200 || response.res.statusCode >= 300)) {
				throw new Error(`HTTP ${response.res.statusCode} Error from OpenAI API`);
			}

			let buffer = '';
			await new Promise<void>((resolve, reject) => {
				listenStream(response.stream, {
					onData: (chunk: VSBuffer) => {
						buffer += chunk.toString();
						const lines = buffer.split('\n');
						buffer = lines.pop() || '';
						for (const line of lines) {
							const trimmed = line.trim();
							if (trimmed.startsWith('data: ')) {
								const dataStr = trimmed.slice(6).trim();
								if (dataStr === '[DONE]') {
									continue;
								}
								try {
									const json = JSON.parse(dataStr);
									const delta = json.choices?.[0]?.delta?.content;
									if (delta) {
										progress({ kind: 'markdownContent', content: new MarkdownString(delta) });
									}
								} catch { }
							}
						}
					},
					onError: reject,
					onEnd: resolve
				});
			});
		}
	}

	private async whenPanelAgentHasGuidance(disposables: DisposableStore): Promise<void> {
		const panelAgentHasGuidance = () => chatViewsWelcomeRegistry.get().some(descriptor => this.contextKeyService.contextMatchesRules(descriptor.when));

		if (panelAgentHasGuidance()) {
			return;
		}

		return new Promise<void>(resolve => {
			let descriptorKeys: Set<string> = new Set();
			const updateDescriptorKeys = () => {
				const descriptors = chatViewsWelcomeRegistry.get();
				descriptorKeys = new Set(descriptors.flatMap(d => d.when.keys()));
			};
			updateDescriptorKeys();

			const onDidChangeRegistry = Event.map(chatViewsWelcomeRegistry.onDidChange, () => 'registry' as const);
			const onDidChangeRelevantContext = Event.map(
				Event.filter(this.contextKeyService.onDidChangeContext, e => e.affectsSome(descriptorKeys)),
				() => 'context' as const
			);

			disposables.add(Event.any(
				onDidChangeRegistry,
				onDidChangeRelevantContext
			)(source => {
				if (source === 'registry') {
					updateDescriptorKeys();
				}
				if (panelAgentHasGuidance()) {
					resolve();
				}
			}));
		});
	}

	private whenLanguageModelReady(languageModelsService: ILanguageModelsService, modelId: string | undefined): Promise<unknown> | void {
		const hasModelForRequest = () => {
			if (modelId) {
				return !!languageModelsService.lookupLanguageModel(modelId);
			}

			for (const id of languageModelsService.getLanguageModelIds()) {
				const model = languageModelsService.lookupLanguageModel(id);
				if (model?.isDefaultForLocation[ChatAgentLocation.Chat]) {
					return true;
				}
			}

			return false;
		};

		if (hasModelForRequest()) {
			return;
		}

		return Event.toPromise(Event.filter(languageModelsService.onDidChangeLanguageModels, () => hasModelForRequest()));
	}

	private whenToolsModelReady(languageModelToolsService: ILanguageModelToolsService, requestModel: IChatRequestModel): Promise<unknown> | void {
		const needsToolsModel = requestModel.message.parts.some(part => part instanceof ChatRequestToolPart);
		if (!needsToolsModel) {
			return; // No tools in this request, no need to check
		}

		// check that tools other than setup. and internal tools are registered.
		for (const tool of languageModelToolsService.getAllToolsIncludingDisabled()) {
			if (tool.id.startsWith('copilot_')) {
				return; // we have tools!
			}
		}

		return Event.toPromise(Event.filter(languageModelToolsService.onDidChangeTools, () => {
			for (const tool of languageModelToolsService.getAllToolsIncludingDisabled()) {
				if (tool.id.startsWith('copilot_')) {
					return true; // we have tools!
				}
			}

			return false; // no external tools found
		}));
	}

	private whenAgentReady(chatAgentService: IChatAgentService, mode: ChatModeKind | undefined): Promise<unknown> | void {
		const defaultAgent = chatAgentService.getDefaultAgent(this.location, mode);
		if (defaultAgent && !defaultAgent.isCore) {
			return; // we have a default agent from an extension!
		}

		return Event.toPromise(Event.filter(chatAgentService.onDidChangeAgents, () => {
			const defaultAgent = chatAgentService.getDefaultAgent(this.location, mode);
			return Boolean(defaultAgent && !defaultAgent.isCore);
		}));
	}

	private async whenAgentActivated(chatService: IChatService): Promise<void> {
		try {
			await chatService.activateDefaultAgent(this.location);
		} catch (error) {
			this.logService.error(error);
		}
	}



	private async doInvokeWithSetup(request: IChatAgentRequest, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatWidgetService: IChatWidgetService, chatAgentService: IChatAgentService, languageModelToolsService: ILanguageModelToolsService, defaultAccountService: IDefaultAccountService): Promise<IChatAgentResult> {
		this.telemetryService.publicLog2<WorkbenchActionExecutedEvent, WorkbenchActionExecutedClassification>('workbenchActionExecuted', { id: CHAT_SETUP_ACTION_ID, from: 'chat' });

		const widget = chatWidgetService.getWidgetBySessionResource(request.sessionResource);
		const requestModel = widget?.viewModel?.model.getRequests().at(-1);

		const setupListener = Event.runAndSubscribe(this.controller.value.onDidChange, (() => {
			switch (this.controller.value.step) {
				case ChatSetupStep.SigningIn:
					progress({
						kind: 'progressMessage',
						content: new MarkdownString(localize('setupChatSignIn2', "Signing in to {0}", defaultAccountService.getDefaultAccountAuthenticationProvider().name)),
						shimmer: true,
					});
					break;
				case ChatSetupStep.Installing:
					progress({
						kind: 'progressMessage',
						content: new MarkdownString(localize('installingChat', "Getting chat ready")),
						shimmer: true,
					});
					break;
			}
		}));

		let result: IChatSetupResult | undefined = undefined;
		try {
			result = await ChatSetup.getInstance(this.instantiationService, this.context, this.controller).run({
				disableChatViewReveal: true, 																				// we are already in a chat context
				forceAnonymous: this.chatEntitlementService.anonymous ? ChatSetupAnonymous.EnabledWithoutDialog : undefined	// only enable anonymous selectively
			});
		} catch (error) {
			this.logService.error(`[chat setup] Error during setup: ${toErrorMessage(error)}`);
		} finally {
			setupListener.dispose();
		}

		// User has agreed to run the setup
		if (typeof result?.success === 'boolean') {
			if (result.success) {
				if (result.dialogSkipped) {
					await widget?.clear(); // make room for the Chat welcome experience
				} else if (requestModel) {
					let newRequest = this.replaceAgentInRequestModel(requestModel, chatAgentService); 	// Replace agent part with the actual Chat agent...
					newRequest = this.replaceToolInRequestModel(newRequest); 							// ...then replace any tool parts with the actual Chat tools

					await this.forwardRequestToChat(newRequest, progress, chatService, languageModelsService, chatAgentService, chatWidgetService, languageModelToolsService);
				}
			} else {
				progress({
					kind: 'warning',
					content: new MarkdownString(localize('chatSetupError', "Chat setup failed."))
				});
			}
		}

		// User has cancelled the setup
		else {
			progress({
				kind: 'markdownContent',
				content: this.workspaceTrustManagementService.isWorkspaceTrusted() ? SetupAgent.SETUP_NEEDED_MESSAGE : SetupAgent.TRUST_NEEDED_MESSAGE
			});
		}

		return {};
	}

	private replaceAgentInRequestModel(requestModel: IChatRequestModel, chatAgentService: IChatAgentService): IChatRequestModel {
		const agentPart = requestModel.message.parts.find((r): r is ChatRequestAgentPart => r instanceof ChatRequestAgentPart);
		if (!agentPart) {
			return requestModel;
		}

		const agentId = agentPart.agent.id.replace(/setup\./, `${defaultChat.extensionId}.`.toLowerCase());
		const githubAgent = chatAgentService.getAgent(agentId);
		if (!githubAgent) {
			return requestModel;
		}

		const newAgentPart = new ChatRequestAgentPart(agentPart.range, agentPart.editorRange, githubAgent);

		return new ChatRequestModel({
			session: requestModel.session as ChatModel,
			message: {
				parts: requestModel.message.parts.map(part => {
					if (part instanceof ChatRequestAgentPart) {
						return newAgentPart;
					}
					return part;
				}),
				text: requestModel.message.text
			},
			variableData: requestModel.variableData,
			timestamp: Date.now(),
			attempt: requestModel.attempt,
			modeInfo: requestModel.modeInfo,
			confirmation: requestModel.confirmation,
			locationData: requestModel.locationData,
			attachedContext: requestModel.attachedContext,
			isCompleteAddedRequest: requestModel.isCompleteAddedRequest,
		});
	}

	private replaceToolInRequestModel(requestModel: IChatRequestModel): IChatRequestModel {
		const toolPart = requestModel.message.parts.find((r): r is ChatRequestToolPart => r instanceof ChatRequestToolPart);
		if (!toolPart) {
			return requestModel;
		}

		const toolId = toolPart.toolId.replace(/setup.tools\./, `copilot_`.toLowerCase());
		const newToolPart = new ChatRequestToolPart(
			toolPart.range,
			toolPart.editorRange,
			toolPart.toolName,
			toolId,
			toolPart.displayName,
			toolPart.icon
		);

		const chatRequestToolEntry: IChatRequestToolEntry = {
			id: toolId,
			name: 'new',
			range: toolPart.range,
			kind: 'tool',
			value: undefined
		};

		const variableData: IChatRequestVariableData = {
			variables: [chatRequestToolEntry]
		};

		return new ChatRequestModel({
			session: requestModel.session as ChatModel,
			message: {
				parts: requestModel.message.parts.map(part => {
					if (part instanceof ChatRequestToolPart) {
						return newToolPart;
					}
					return part;
				}),
				text: requestModel.message.text
			},
			variableData: variableData,
			timestamp: Date.now(),
			attempt: requestModel.attempt,
			modeInfo: requestModel.modeInfo,
			confirmation: requestModel.confirmation,
			locationData: requestModel.locationData,
			attachedContext: [chatRequestToolEntry],
			isCompleteAddedRequest: requestModel.isCompleteAddedRequest,
		});
	}
}

export class SetupTool implements IToolImpl {

	static registerTool(instantiationService: IInstantiationService, toolData: IToolData): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const toolService = accessor.get(ILanguageModelToolsService);

			const tool = instantiationService.createInstance(SetupTool);
			return toolService.registerTool(toolData, tool);
		});
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const result: IToolResult = {
			content: [
				{
					kind: 'text',
					value: ''
				}
			]
		};

		return result;
	}

	async prepareToolInvocation?(parameters: unknown, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return undefined;
	}
}

export class AINewSymbolNamesProvider {

	static registerProvider(instantiationService: IInstantiationService, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const languageFeaturesService = accessor.get(ILanguageFeaturesService);

			const provider = instantiationService.createInstance(AINewSymbolNamesProvider, context, controller);
			return languageFeaturesService.newSymbolNamesProvider.register('*', provider);
		});
	}

	constructor(
		private readonly context: ChatEntitlementContext,
		private readonly controller: Lazy<ChatSetupController>,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
	) {
	}

	async provideNewSymbolNames(model: ITextModel, range: IRange, triggerKind: NewSymbolNameTriggerKind, token: CancellationToken): Promise<NewSymbolName[] | undefined> {
		await this.instantiationService.invokeFunction(accessor => {
			return ChatSetup.getInstance(this.instantiationService, this.context, this.controller).run({
				forceAnonymous: this.chatEntitlementService.anonymous ? ChatSetupAnonymous.EnabledWithDialog : undefined
			});
		});

		return [];
	}
}

export class ChatCodeActionsProvider {

	static registerProvider(instantiationService: IInstantiationService): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const languageFeaturesService = accessor.get(ILanguageFeaturesService);

			const provider = instantiationService.createInstance(ChatCodeActionsProvider);
			return languageFeaturesService.codeActionProvider.register('*', provider);
		});
	}

	constructor(
		@IMarkerService private readonly markerService: IMarkerService,
	) {
	}

	async provideCodeActions(model: ITextModel, range: Range | Selection): Promise<CodeActionList | undefined> {
		const actions: CodeAction[] = [];

		// "Generate" if the line is whitespace only
		// "Modify" if there is a selection
		let generateOrModifyTitle: string | undefined;
		let generateOrModifyCommand: Command | undefined;
		if (range.isEmpty()) {
			const textAtLine = model.getLineContent(range.startLineNumber);
			if (/^\s*$/.test(textAtLine)) {
				generateOrModifyTitle = localize('generate', "Generate");
				generateOrModifyCommand = AICodeActionsHelper.generate(range);
			}
		} else {
			const textInSelection = model.getValueInRange(range);
			if (!/^\s*$/.test(textInSelection)) {
				generateOrModifyTitle = localize('modify', "Modify");
				generateOrModifyCommand = AICodeActionsHelper.modify(range);
			}
		}

		if (generateOrModifyTitle && generateOrModifyCommand) {
			actions.push({
				kind: CodeActionKind.RefactorRewrite.append('copilot').value,
				isAI: true,
				title: generateOrModifyTitle,
				command: generateOrModifyCommand,
			});
		}

		const markers = AICodeActionsHelper.warningOrErrorMarkersAtRange(this.markerService, model.uri, range);
		if (markers.length > 0) {

			// "Fix" if there are diagnostics in the range
			actions.push({
				kind: CodeActionKind.QuickFix.append('copilot').value,
				isAI: true,
				diagnostics: markers,
				title: localize('fix', "Fix"),
				command: AICodeActionsHelper.fixMarkers(markers, range)
			});

			// "Explain" if there are diagnostics in the range
			actions.push({
				kind: CodeActionKind.QuickFix.append('explain').append('copilot').value,
				isAI: true,
				diagnostics: markers,
				title: localize('explain', "Explain"),
				command: AICodeActionsHelper.explainMarkers(markers)
			});
		}

		return {
			actions,
			dispose() { }
		};
	}
}

export class AICodeActionsHelper {

	static warningOrErrorMarkersAtRange(markerService: IMarkerService, resource: URI, range: Range | Selection): IMarker[] {
		return markerService
			.read({ resource, severities: MarkerSeverity.Error | MarkerSeverity.Warning })
			.filter(marker => range.startLineNumber <= marker.endLineNumber && range.endLineNumber >= marker.startLineNumber);
	}

	static modify(range: Range): Command {
		return {
			id: INLINE_CHAT_START,
			title: localize('modify', "Modify"),
			arguments: [
				{
					initialSelection: this.rangeToSelection(range),
					initialRange: range,
					position: range.getStartPosition()
				} satisfies { initialSelection: ISelection; initialRange: IRange; position: IPosition }
			]
		};
	}

	static generate(range: Range): Command {
		return {
			id: INLINE_CHAT_START,
			title: localize('generate', "Generate"),
			arguments: [
				{
					initialSelection: this.rangeToSelection(range),
					initialRange: range,
					position: range.getStartPosition()
				} satisfies { initialSelection: ISelection; initialRange: IRange; position: IPosition }
			]
		};
	}

	private static rangeToSelection(range: Range): ISelection {
		return new Selection(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);
	}

	static explainMarkers(markers: IMarker[]): Command {
		return {
			id: CHAT_OPEN_ACTION_ID,
			title: localize('explain', "Explain"),
			arguments: [
				{
					query: `@workspace /explain ${markers.map(marker => marker.message).join(', ')}`,
					isPartialQuery: true
				} satisfies { query: string; isPartialQuery: boolean }
			]
		};
	}

	static fixMarkers(markers: IMarker[], range: Range): Command {
		return {
			id: INLINE_CHAT_START,
			title: localize('fix', "Fix"),
			arguments: [
				{
					message: `/fix ${markers.map(marker => marker.message).join(', ')}`,
					initialSelection: this.rangeToSelection(range),
					initialRange: range,
					position: range.getStartPosition()
				} satisfies { message: string; initialSelection: ISelection; initialRange: IRange; position: IPosition }
			]
		};
	}
}
