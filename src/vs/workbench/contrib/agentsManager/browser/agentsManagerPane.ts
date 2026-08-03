/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentsManager.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { URI } from '../../../../base/common/uri.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';

import { IAgentsManagerService, IAgentItem, AgentScopeType } from '../common/agentsManager.js';
import { createOrEditAgentDialog } from './agentEditorDialog.js';

export class AgentsManagerPane extends ViewPane {
	private containerEl?: HTMLElement;
	private renderVersion = 0;
	private filterText = '';

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@INotificationService private readonly notificationService: INotificationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ICommandService private readonly commandService: ICommandService,
		@IAgentsManagerService private readonly agentsManagerService: IAgentsManagerService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.agentsManagerService.onDidChangeAgents(() => this.renderContent()));

		// Accordion Exclusive Single Expansion: Notify service when this pane is expanded
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this.agentsManagerService.notifyPaneExpanded(this.id);
			}
		}));

		// Handle target pane expansion or collapse
		this._register(this.agentsManagerService.onDidExpandPane(expandedId => {
			if (expandedId === this.id) {
				if (!this.isExpanded()) {
					this.setExpanded(true);
				}
			} else if (this.isExpanded()) {
				this.setExpanded(false);
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('agents-manager-viewpane');

		this.containerEl = append(container, $('.agents-manager-main-container'));
		this.renderContent();
	}

	private getTargetScope(): 'all' | AgentScopeType {
		if (this.id.endsWith('.workspace')) {
			return 'workspace';
		}
		if (this.id.endsWith('.project')) {
			return 'project';
		}
		if (this.id.endsWith('.job')) {
			return 'job';
		}
		if (this.id.endsWith('.workflow')) {
			return 'workflow';
		}
		if (this.id.endsWith('.standalone')) {
			return 'none';
		}
		return 'all';
	}

	private async renderContent(): Promise<void> {
		if (!this.containerEl) {
			return;
		}

		const currentVersion = ++this.renderVersion;
		clearNode(this.containerEl);

		const allAgents = await this.agentsManagerService.getAgents();
		if (this.renderVersion !== currentVersion || !this.containerEl) {
			return;
		}

		const targetScope = this.getTargetScope();

		// Filter by View Pane Scope
		let scopedAgents = allAgents;
		if (targetScope !== 'all') {
			scopedAgents = allAgents.filter(a => a.scopeType === targetScope);
		}

		// Update Native View Pane Header Title with Dynamic Item Count
		const baseTitles: Record<string, string> = {
			all: 'All Agents',
			workspace: 'Workspace Agents',
			project: 'Project Agents',
			job: 'Job Agents',
			workflow: 'Workflow Agents',
			none: 'Standalone / Global Agents'
		};
		const baseName = baseTitles[targetScope] || 'Agents';
		this.updateTitle(`${baseName} (${scopedAgents.length})`);

		// Filter by Search Text
		const filteredAgents = scopedAgents.filter(a => {
			if (!this.filterText) {
				return true;
			}
			return a.name.toLowerCase().includes(this.filterText) ||
				a.role.toLowerCase().includes(this.filterText) ||
				(a.modelName && a.modelName.toLowerCase().includes(this.filterText)) ||
				a.scopeName.toLowerCase().includes(this.filterText);
		});

		// --- 1. Filter Bar ---
		const filterRow = append(this.containerEl, $('.agents-filter-row'));
		const filterInput = append(filterRow, $('input.filter-input')) as HTMLInputElement;
		filterInput.type = 'text';
		filterInput.placeholder = `Search ${targetScope === 'all' ? 'all' : targetScope} agents by title, role or model...`;
		filterInput.value = this.filterText;

		filterInput.oninput = () => {
			this.filterText = filterInput.value.toLowerCase().trim();
			this.renderContent();
		};

		// --- 2. Agent Cards List Body ---
		const listBody = append(this.containerEl, $('.agents-list-body'));

		if (filteredAgents.length === 0) {
			const emptyItem = append(listBody, $('.empty-agent-item'));
			emptyItem.style.display = 'flex';
			emptyItem.style.flexDirection = 'column';
			emptyItem.style.alignItems = 'center';
			emptyItem.style.justifyContent = 'center';
			emptyItem.style.padding = '18px 10px';
			emptyItem.style.color = '#777777';
			emptyItem.style.fontSize = '11.5px';
			emptyItem.style.gap = '8px';

			const emptyText = append(emptyItem, $('span'));
			emptyText.textContent = targetScope === 'all' ? 'No AI Agents created yet.' : `No ${targetScope} agents registered yet.`;

			const createBtn = append(emptyItem, $('button.monaco-button', {
				style: 'padding: 4px 10px; font-size: 11px; border-radius: 4px; cursor: pointer; background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.35); color: #38bdf8; font-weight: 600;'
			}));
			createBtn.innerText = '+ Create Agent';
			createBtn.onclick = () => {
				const defaultScope: AgentScopeType = targetScope === 'all' ? 'workspace' : targetScope;
				this.instantiationService.invokeFunction(accessor => createOrEditAgentDialog(accessor, undefined, defaultScope));
			};
			return;
		}

		const scopeAccentColors: Record<string, string> = {
			all: '#38bdf8',
			workspace: '#38bdf8',
			project: '#a78bfa',
			job: '#f43f5e',
			workflow: '#eab308',
			none: '#94a3b8'
		};

		for (const agent of filteredAgents) {
			const accentColor = scopeAccentColors[agent.scopeType] || '#38bdf8';
			this.renderAgentCard(listBody, agent, accentColor);
		}
	}

	private renderAgentCard(parent: HTMLElement, agent: IAgentItem, accentColor: string): void {
		const card = append(parent, $('.agent-item-card'));

		// Card Header: Icon + Name + Status + Actions
		const cardHeader = append(card, $('.card-header'));

		const cardLeft = append(cardHeader, $('.card-left'));

		const iconMap: Record<string, ThemeIcon> = {
			robot: Codicon.robot,
			sparkle: Codicon.sparkle,
			code: Codicon.code,
			beaker: Codicon.beaker,
			terminal: Codicon.terminal
		};

		const aIcon = append(cardLeft, $('span' + ThemeIcon.asCSSSelector(iconMap[agent.avatarIcon] || Codicon.robot)));
		aIcon.style.fontSize = '14px';
		aIcon.style.color = accentColor;
		aIcon.style.flexShrink = '0';

		const nameText = append(cardLeft, $('span.agent-name'));
		nameText.textContent = agent.name;

		// Status Badge
		const statusDot = append(cardLeft, $('span.status-dot'));
		statusDot.style.background = agent.status === 'busy' ? '#eab308' : agent.status === 'offline' ? '#6b7280' : '#22c55e';
		statusDot.title = `Status: ${agent.status}`;

		// Card Right Actions
		const cardActions = append(cardHeader, $('.card-actions'));

		// Assign Task Action
		const runBtn = append(cardActions, $('span' + ThemeIcon.asCSSSelector(Codicon.play)));
		runBtn.style.fontSize = '12px';
		runBtn.style.color = '#22c55e';
		runBtn.style.cursor = 'pointer';
		runBtn.style.opacity = '0.85';
		runBtn.title = 'Assign Task to Agent';
		runBtn.onclick = async () => {
			const taskTitle = await this.quickInputService.input({
				prompt: `Assign New Task to AI Agent '${agent.name}'`,
				placeHolder: 'e.g. Implement user authentication, Refactor API response handler',
				validateInput: async (val) => val.trim() ? null : 'Task title cannot be empty'
			});

			if (taskTitle) {
				const taskDescription = await this.quickInputService.input({
					prompt: 'Enter Task Details & Requirements (Optional)',
					placeHolder: 'e.g. Ensure unit tests pass and work_log is updated.'
				});

				await this.agentsManagerService.assignTaskToAgent(agent.id, taskTitle, taskDescription || '');
				this.notificationService.info(`Task '${taskTitle}' assigned to Agent '${agent.name}'! Logged in work_log.md.`);
			}
		};

		// Open Folder / Rendered Markdown Preview Action
		if (agent.folderPath) {
			const openFolderBtn = append(cardActions, $('span' + ThemeIcon.asCSSSelector(Codicon.folderOpened)));
			openFolderBtn.style.fontSize = '12px';
			openFolderBtn.style.color = '#a78bfa';
			openFolderBtn.style.cursor = 'pointer';
			openFolderBtn.style.opacity = '0.85';
			openFolderBtn.title = 'Open Agent Instruction Preview (markdown.showPreview)';
			openFolderBtn.onclick = async () => {
				const instructionUri = URI.file(`${agent.folderPath}/instruction.md`);
				try {
					await this.commandService.executeCommand('markdown.showPreview', instructionUri);
				} catch {
					await this.openerService.open(instructionUri);
				}
			};
		}

		// Edit Action
		const editBtn = append(cardActions, $('span' + ThemeIcon.asCSSSelector(Codicon.edit)));
		editBtn.style.fontSize = '12px';
		editBtn.style.color = '#38bdf8';
		editBtn.style.cursor = 'pointer';
		editBtn.style.opacity = '0.85';
		editBtn.title = 'Edit Agent Configuration';
		editBtn.onclick = () => {
			this.instantiationService.invokeFunction(accessor => createOrEditAgentDialog(accessor, agent));
		};

		// Delete Action
		const deleteBtn = append(cardActions, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
		deleteBtn.style.fontSize = '12px';
		deleteBtn.style.color = '#ef4444';
		deleteBtn.style.cursor = 'pointer';
		deleteBtn.style.opacity = '0.7';
		deleteBtn.title = 'Delete Agent';
		deleteBtn.onclick = async () => {
			await this.agentsManagerService.removeAgent(agent.id);
			this.notificationService.info(`Agent '${agent.name}' removed.`);
		};

		// Role Subtitle
		const roleRow = append(card, $('.role-row'));
		roleRow.textContent = agent.role;

		// Meta Row: Model Badge + Scope Badge
		const metaRow = append(card, $('.meta-row'));

		const modelBadge = append(metaRow, $('span.model-badge'));
		modelBadge.textContent = agent.modelName || 'gemini-2.0-flash';

		const scopeBadge = append(metaRow, $('span.scope-badge'));
		scopeBadge.textContent = agent.scopeName;
		scopeBadge.style.color = accentColor;
		scopeBadge.style.borderColor = `${accentColor}44`;

		// Prompt Preview
		const promptPreview = append(card, $('.prompt-preview'));
		promptPreview.textContent = `"${agent.systemPrompt}"`;
		promptPreview.title = agent.systemPrompt;
	}
}
