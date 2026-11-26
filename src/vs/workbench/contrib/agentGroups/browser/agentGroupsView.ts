/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import './media/agentGroups.css';
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

import { IAgentsManagerService, IAgentItem, AgentScopeType } from '../../../contrib/agentsManager/common/agentsManager.js';
import { createOrEditAgentDialog } from '../../../contrib/agentsManager/browser/agentEditorDialog.js';

export const AgentGroupsViewId = 'agentic.workbench.view.agentGroups';

export class AgentGroupsView extends ViewPane {
	private containerEl?: HTMLElement;
	private renderVersion = 0;
	private filterText = '';
	private expandedGroups = new Set<AgentScopeType>(['workspace', 'project', 'job']);

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
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		parent.classList.add('agent-groups-viewpane');

		this.containerEl = append(parent, $('.agent-groups-main-container'));
		this.renderContent();
	}

	private async renderContent(): Promise<void> {
		if (!this.containerEl) {
			return;
		}

		const currentVersion = ++this.renderVersion;
		clearNode(this.containerEl);

		const agents = await this.agentsManagerService.getAgents();
		if (this.renderVersion !== currentVersion || !this.containerEl) {
			return;
		}

		// --- 1. Header Row ---
		const headerRow = append(this.containerEl, $('.agents-header-row'));

		const titleLeft = append(headerRow, $('.title-left'));
		const iconEl = append(titleLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.organization)));
		iconEl.style.fontSize = '15px';

		const titleText = append(titleLeft, $('span'));
		titleText.textContent = 'Agent Groups Coordination';

		const addAgentBtn = append(headerRow, $('.add-agent-btn'));
		const plusIcon = append(addAgentBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.plus)));
		plusIcon.style.fontSize = '12px';
		const addBtnText = append(addAgentBtn, $('span'));
		addBtnText.textContent = 'New Agent';

		addAgentBtn.onclick = () => {
			this.instantiationService.invokeFunction(accessor => createOrEditAgentDialog(accessor));
		};

		// --- 2. Filter Bar ---
		const filterRow = append(this.containerEl, $('.filter-row'));
		const filterInput = append(filterRow, $('input.filter-input')) as HTMLInputElement;
		filterInput.type = 'text';
		filterInput.placeholder = 'Filter agent groups by name, role or scope...';
		filterInput.value = this.filterText;

		filterInput.oninput = () => {
			this.filterText = filterInput.value.toLowerCase().trim();
			this.renderContent();
		};

		// --- 3. Filtered Agents ---
		const filteredAgents = agents.filter(a => {
			if (!this.filterText) {
				return true;
			}
			return a.name.toLowerCase().includes(this.filterText) ||
				a.role.toLowerCase().includes(this.filterText) ||
				a.scopeName.toLowerCase().includes(this.filterText);
		});

		// --- 4. Render Group Sections ---
		const groups: { type: AgentScopeType; title: string; icon: ThemeIcon; color: string }[] = [
			{ type: 'workspace', title: 'Workspace Agent Groups', icon: Codicon.globe, color: '#38bdf8' },
			{ type: 'project', title: 'Project Agent Groups', icon: Codicon.folder, color: '#a78bfa' },
			{ type: 'job', title: 'Job Agent Groups', icon: Codicon.target, color: '#f43f5e' }
		];

		const groupContainer = append(this.containerEl, $('.agent-groups-container'));

		for (const g of groups) {
			const groupAgents = filteredAgents.filter(a => a.scopeType === g.type);
			this.renderGroupSection(groupContainer, g, groupAgents);
		}
	}

	private renderGroupSection(
		parent: HTMLElement,
		group: { type: AgentScopeType; title: string; icon: ThemeIcon; color: string },
		agents: IAgentItem[]
	): void {
		const groupSection = append(parent, $('.agent-group-section'));

		// Group Header
		const groupHeader = append(groupSection, $('.group-header'));

		const headerLeft = append(groupHeader, $('.header-left'));
		headerLeft.style.display = 'flex';
		headerLeft.style.alignItems = 'center';
		headerLeft.style.gap = '6px';

		const isExpanded = this.expandedGroups.has(group.type);
		const chevronIcon = append(headerLeft, $('span' + ThemeIcon.asCSSSelector(isExpanded ? Codicon.chevronDown : Codicon.chevronRight)));
		chevronIcon.style.fontSize = '12px';
		chevronIcon.style.color = '#888888';

		const gIcon = append(headerLeft, $('span' + ThemeIcon.asCSSSelector(group.icon)));
		gIcon.style.fontSize = '13px';
		gIcon.style.color = group.color;

		const gTitle = append(headerLeft, $('span.group-title'));
		gTitle.textContent = group.title;
		gTitle.style.fontWeight = '600';
		gTitle.style.fontSize = '11px';
		gTitle.style.color = group.color;

		const headerRight = append(groupHeader, $('.header-right'));
		headerRight.style.display = 'flex';
		headerRight.style.alignItems = 'center';
		headerRight.style.gap = '6px';

		const countBadge = append(headerRight, $('span.count-badge'));
		countBadge.textContent = `${agents.length}`;
		countBadge.style.fontSize = '10px';
		countBadge.style.padding = '1px 6px';
		countBadge.style.borderRadius = '10px';
		countBadge.style.background = 'rgba(255, 255, 255, 0.1)';
		countBadge.style.color = '#cccccc';

		const addScopeBtn = append(headerRight, $('span' + ThemeIcon.asCSSSelector(Codicon.plus)));
		addScopeBtn.style.fontSize = '12px';
		addScopeBtn.style.color = group.color;
		addScopeBtn.style.cursor = 'pointer';
		addScopeBtn.title = `Add ${group.title} Agent`;
		addScopeBtn.onclick = (e) => {
			e.stopPropagation();
			this.instantiationService.invokeFunction(accessor =>
				createOrEditAgentDialog(accessor, undefined, group.type, `${group.type.toUpperCase()} Scoped`)
			);
		};

		groupHeader.onclick = () => {
			if (this.expandedGroups.has(group.type)) {
				this.expandedGroups.delete(group.type);
			} else {
				this.expandedGroups.add(group.type);
			}
			this.renderContent();
		};

		if (!isExpanded) {
			return;
		}

		// Agent List Body
		const listBody = append(groupSection, $('.group-list-body'));

		if (agents.length === 0) {
			const emptyItem = append(listBody, $('.empty-agent-item'));
			emptyItem.textContent = `No ${group.type} agents created yet.`;
			emptyItem.style.fontStyle = 'italic';
			emptyItem.style.color = '#777777';
			emptyItem.style.fontSize = '11px';
			emptyItem.style.padding = '4px 6px';
			return;
		}

		for (const agent of agents) {
			this.renderAgentCard(listBody, agent, group.color);
		}
	}

	private renderAgentCard(parent: HTMLElement, agent: IAgentItem, accentColor: string): void {
		const card = append(parent, $('.agent-card'));

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

		// Open Folder Action (Markdown Preview Mode)
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

		// Scope Tag & Prompt Preview
		const metaRow = append(card, $('.meta-row'));

		const scopeBadge = append(metaRow, $('span.scope-badge'));
		scopeBadge.textContent = agent.scopeName;
		scopeBadge.style.color = accentColor;
		scopeBadge.style.borderColor = `${accentColor}44`;

		const promptPreview = append(card, $('.prompt-preview'));
		promptPreview.textContent = `"${agent.systemPrompt}"`;
		promptPreview.title = agent.systemPrompt;
	}
}
