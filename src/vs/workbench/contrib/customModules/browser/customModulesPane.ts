/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import './media/customModules.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IAction, Action, Separator, SubmenuAction } from '../../../../base/common/actions.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ICustomModule, resolveCustomModuleIcon } from '../../entityPersistence/common/entityPersistence.js';
import { ICustomModulesService } from '../common/customModules.js';

export const CustomModulesViewPaneId = 'workbench.view.customModules.pane';

export class CustomModulesPane extends ViewPane {
	private containerEl?: HTMLElement;
	private filterText = '';
	private renderVersion = 0;
	private selectedModuleId?: string;
	private collapsedCategories: Set<string> = new Set<string>();

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
		@ICustomModulesService private readonly customModulesService: ICustomModulesService,
		@IDialogService private readonly dialogService: IDialogService,
		@IQuickInputService private readonly quickInputService: IQuickInputService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.customModulesService.onDidChangeModules(() => {
			this.renderContent();
		}));
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this.renderContent();
			}
		}));
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		parent.classList.add('custom-modules-viewpane');

		this.containerEl = append(parent, $('.custom-modules-main-container'));
		this.renderContent();
	}

	public async renderContent(): Promise<void> {
		if (!this.containerEl) {
			return;
		}

		const currentVersion = ++this.renderVersion;
		const prevScrollTop = this.containerEl.scrollTop;

		const [customModules, compositeClasses, categories] = await Promise.all([
			this.customModulesService.getCustomModules(),
			this.customModulesService.getCompositeComponents(),
			this.customModulesService.getCategories()
		]);

		if (currentVersion !== this.renderVersion || !this.containerEl) {
			return;
		}

		clearNode(this.containerEl);

		// Use actual persisted modules directly (sorted by most recently edited first)
		const allModules = customModules;

		// Update native pane title cleanly (e.g. "Custom Modules (11)")
		this.updateTitle(`Custom Modules (${allModules.length})`);

		// 1. Clean Search Input Box with New Category Button
		const filterRow = append(this.containerEl, $('.custom-modules-filter-row'));
		const searchInput = append(filterRow, $('input.custom-modules-search-input')) as HTMLInputElement;
		searchInput.placeholder = 'Search modules by name or description...';
		searchInput.value = this.filterText;
		searchInput.style.flex = '1';
		searchInput.oninput = () => {
			this.filterText = searchInput.value.toLowerCase().trim();
			renderList();
		};

		const newCatBtn = append(filterRow, $('span.action-icon-btn.new-cat-btn' + ThemeIcon.asCSSSelector(Codicon.newFolder), {
			title: 'New Category',
			style: 'padding: 5px 7px; border-radius: 4px; cursor: pointer; color: #888888; display: inline-flex; align-items: center; justify-content: center; background: var(--vscode-input-background, #222222); border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.12)); flex-shrink: 0;'
		}));
		newCatBtn.onmouseenter = () => { newCatBtn.style.color = '#38bdf8'; newCatBtn.style.borderColor = '#38bdf8'; };
		newCatBtn.onmouseleave = () => { newCatBtn.style.color = '#888888'; newCatBtn.style.borderColor = 'var(--vscode-input-border, rgba(255, 255, 255, 0.12))'; };
		newCatBtn.onclick = async () => {
			const catName = await this.quickInputService.input({
				prompt: 'Enter category name (e.g. Job Search, Resume Tools, Database)',
				placeHolder: 'Category name'
			});
			if (catName && catName.trim()) {
				await this.customModulesService.addCategory(catName.trim());
				await this.renderContent();
			}
		};

		// 2. Modules List Container
		const listContainer = append(this.containerEl, $('.custom-modules-list'));

		// Module cards currently rendered in `listContainer` (reset whenever the list is re-rendered).
		const moduleCards: HTMLElement[] = [];

		const updateSelectedCardStyle = () => {
			moduleCards.forEach(cardEl => {
				const cardModId = (cardEl.getAttribute('data-module-id') || '').toLowerCase();
				if (this.selectedModuleId && cardModId === this.selectedModuleId.toLowerCase()) {
					cardEl.classList.add('selected');
				} else {
					cardEl.classList.remove('selected');
				}
			});
		};

		const renderModuleCard = (m: ICustomModule, targetContainer: HTMLElement) => {
			const card = append(targetContainer, $('.custom-module-card'));
			card.setAttribute('data-module-id', m.id);
			moduleCards.push(card);
			if (this.selectedModuleId && m.id.toLowerCase() === this.selectedModuleId.toLowerCase()) {
				card.classList.add('selected');
			}
			if (m.isDeprecated) {
				card.classList.add('deprecated');
			}

			// Top row: module icon, module name, action buttons
			const cardTop = append(card, $('.custom-module-card-top'));
			const titleLeft = append(cardTop, $('.custom-module-card-title-left'));

			const modColor = m.color || '#38bdf8';
			const modIcon = resolveCustomModuleIcon(m.icon, m.id);
			const iconSpan = append(titleLeft, $('span' + ThemeIcon.asCSSSelector(modIcon), {
				style: `color: ${modColor}; font-size: 14px; flex-shrink: 0;`
			}));
			iconSpan.title = `Icon: ${modIcon.id} · Color: ${modColor}`;

			const nameSpan = append(titleLeft, $('span.custom-module-name', {}, m.name));
			if (m.isDeprecated) {
				nameSpan.style.textDecoration = 'line-through';
				nameSpan.style.opacity = '0.75';
				append(titleLeft, $('span.custom-module-status-pill.disabled', {}, 'Disabled'));
			}

			// Description (between header and footer)
			if (typeof m.description === 'string' && m.description.trim()) {
				append(card, $('.custom-module-desc', {}, m.description));
			}

			// Footer row: clean field count on left
			const footer = append(card, $('.custom-module-card-footer'));
			const fieldCount = m.fields ? m.fields.length : 0;
			append(footer, $('.custom-module-fields-count', {}, `${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'}`));

			// Right click context menu on card for category and schema operations
			card.oncontextmenu = (e: MouseEvent) => {
				e.preventDefault();
				e.stopPropagation();

				const moveActions: IAction[] = [];
				if (categories.length > 0) {
					for (const cat of categories) {
						const isCurrent = (m.category || '').toLowerCase() === cat.toLowerCase();
						moveActions.push(new Action(
							`customModules.move.${cat}`,
							`${isCurrent ? '✓ ' : '    '}${cat}`,
							undefined,
							true,
							async () => {
								await this.customModulesService.setModuleCategory(m.id, cat);
								await this.renderContent();
							}
						));
					}
					moveActions.push(new Separator());
				}
				moveActions.push(new Action(
					'customModules.moveToNewCategory',
					'+ New Category...',
					undefined,
					true,
					async () => {
						const newName = await this.quickInputService.input({
							prompt: 'Enter category name to create and move this module to',
							placeHolder: 'Category name'
						});
						if (newName && newName.trim()) {
							await this.customModulesService.setModuleCategory(m.id, newName.trim());
							await this.renderContent();
						}
					}
				));
				if (m.category) {
					moveActions.push(new Action(
						'customModules.removeFromCategory',
						'Remove from Category (Move to Root)',
						undefined,
						true,
						async () => {
							await this.customModulesService.setModuleCategory(m.id, undefined);
							await this.renderContent();
						}
					));
				}

				const menuActions: IAction[] = [
					new SubmenuAction('customModules.categorySubmenu', 'Move to Category', moveActions),
					new Separator(),
					new Action('customModules.editSchema', 'Edit Module Schema', undefined, true, async () => {
						this.selectedModuleId = m.id;
						updateSelectedCardStyle();
						await this.customModulesService.openSchemaDesigner({
							targetModuleId: m.id
						});
					}),
					new Action('customModules.previewTicket', 'Preview Ticket Template', undefined, true, async () => {
						await this.customModulesService.openModuleTicketPreview(m);
					}),
					new Separator(),
					new Action('customModules.deleteModule', 'Delete Module', undefined, true, async () => {
						const res = await this.dialogService.confirm({
							message: `Delete module "${m.name}"?`,
							detail: `This will remove the YAML schema file (${m.id}.yaml). Existing entities of this type will preserve their data.`,
							primaryButton: 'Delete'
						});
						if (res.confirmed) {
							await this.customModulesService.deleteCustomModule(m.id);
						}
					})
				];

				this.contextMenuService.showContextMenu({
					getAnchor: () => ({ x: e.clientX, y: e.clientY }),
					getActions: () => menuActions
				});
			};

			// Clicking card directly launches the schema editor in main workspace without re-rendering or resetting scroll
			card.onclick = () => {
				this.selectedModuleId = m.id;
				updateSelectedCardStyle();
				this.customModulesService.openSchemaDesigner({
					targetModuleId: m.id
				});
			};
		};

		const renderList = () => {
			clearNode(listContainer);
			moduleCards.length = 0;

			let filtered = allModules;
			if (this.filterText) {
				filtered = filtered.filter(m =>
					(m.name || '').toLowerCase().includes(this.filterText) ||
					(typeof m.description === 'string' && m.description.toLowerCase().includes(this.filterText)) ||
					(typeof m.category === 'string' && m.category.toLowerCase().includes(this.filterText))
				);
			}

			if (filtered.length === 0) {
				const empty = append(listContainer, $('.custom-modules-empty'));
				append(empty, $('span.custom-modules-empty-icon' + ThemeIcon.asCSSSelector(Codicon.package)));
				append(empty, $('div', { class: 'custom-modules-empty-text' }, this.filterText ? 'No modules match your search.' : 'No modules defined yet.'));
				return;
			}

			// Render each Category Group
			if (categories.length > 0) {
				categories.forEach(cat => {
					const catModules = filtered.filter(m => (m.category || '').toLowerCase() === cat.toLowerCase());
					if (this.filterText && catModules.length === 0) {
						return;
					}

					const isCollapsed = this.collapsedCategories.has(cat);
					const groupEl = append(listContainer, $('.custom-modules-category-group'));

					const catHeader = append(groupEl, $('.custom-modules-category-header'));
					if (!isCollapsed) {
						catHeader.classList.add('expanded');
					}

					const headerLeft = append(catHeader, $('.custom-modules-category-header-left'));
					append(headerLeft, $('span.custom-modules-category-chevron' + ThemeIcon.asCSSSelector(isCollapsed ? Codicon.chevronRight : Codicon.chevronDown)));
					append(headerLeft, $('span.custom-modules-category-icon' + ThemeIcon.asCSSSelector(isCollapsed ? Codicon.folder : Codicon.folderOpened)));
					append(headerLeft, $('span.custom-modules-category-title', {}, cat));
					append(headerLeft, $('span.custom-modules-category-count', {}, `(${catModules.length})`));

					// Header Actions: Rename & Delete Category
					const headerActions = append(catHeader, $('.custom-modules-category-header-actions'));

					const renameBtn = append(headerActions, $('span.custom-modules-category-action-btn' + ThemeIcon.asCSSSelector(Codicon.edit)));
					renameBtn.title = `Rename category "${cat}"`;
					renameBtn.onclick = async (e) => {
						e.stopPropagation();
						const newName = await this.quickInputService.input({
							prompt: 'Rename category',
							value: cat
						});
						if (newName && newName.trim() && newName.trim() !== cat) {
							await this.customModulesService.renameCategory(cat, newName.trim());
							await this.renderContent();
						}
					};

					const deleteBtn = append(headerActions, $('span.custom-modules-category-action-btn' + ThemeIcon.asCSSSelector(Codicon.trash)));
					deleteBtn.title = `Delete category "${cat}"`;
					deleteBtn.onclick = async (e) => {
						e.stopPropagation();
						const res = await this.dialogService.confirm({
							message: `Delete category "${cat}"?`,
							detail: 'Modules in this category will not be deleted; they will be moved to the uncategorized list.',
							primaryButton: 'Delete Category'
						});
						if (res.confirmed) {
							await this.customModulesService.deleteCategory(cat);
							await this.renderContent();
						}
					};

					catHeader.onclick = () => {
						if (this.collapsedCategories.has(cat)) {
							this.collapsedCategories.delete(cat);
						} else {
							this.collapsedCategories.add(cat);
						}
						renderList();
					};

					if (!isCollapsed) {
						const bodyEl = append(groupEl, $('.custom-modules-category-body'));
						if (catModules.length === 0) {
							append(bodyEl, $('.custom-modules-category-empty', {}, 'No modules in this category. Right-click any module to move it here.'));
						} else {
							catModules.forEach(m => renderModuleCard(m, bodyEl));
						}
					}
				});
			}

			// Uncategorized modules (always remain at root / outer level per user requirement)
			const uncategorizedModules = filtered.filter(m => !m.category || !categories.some(c => c.toLowerCase() === (m.category || '').toLowerCase()));
			if (uncategorizedModules.length > 0) {
				if (categories.length > 0) {
					const uncatSection = append(listContainer, $('.custom-modules-uncategorized-section'));
					const uncatHeader = append(uncatSection, $('.custom-modules-uncategorized-header'));
					append(uncatHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.package)));
					append(uncatHeader, $('span', {}, `Uncategorized (${uncategorizedModules.length})`));
					uncategorizedModules.forEach(m => renderModuleCard(m, uncatSection));
				} else {
					uncategorizedModules.forEach(m => renderModuleCard(m, listContainer));
				}
			}

			// 3. Composite Classes Section (if any exist)
			if (compositeClasses.length > 0) {
				const compSection = append(listContainer, $('.custom-modules-comp-section', {
					style: 'margin-top: 14px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 10px; display: flex; flex-direction: column; gap: 8px;'
				}));
				const compHeader = append(compSection, $('.custom-modules-section-title'));
				append(compHeader, $('span', { style: 'color: #06b6d4;' }, `Reusable Composite Classes (${compositeClasses.length})`));

				compositeClasses.forEach(cc => {
					const ccCard = append(compSection, $('.custom-module-card'));

					const top = append(ccCard, $('.custom-module-card-top'));
					const titleLeft = append(top, $('.custom-module-card-title-left'));
					append(titleLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolClass), { style: 'color: #06b6d4; font-size: 13px;' }));
					append(titleLeft, $('span.custom-module-name', {}, cc.name));

					// Footer row: divider line + sub-field count on left, delete icon on right
					const footer = append(ccCard, $('.custom-module-card-footer'));
					const subCount = cc.itemFields ? cc.itemFields.length : 0;
					append(footer, $('.custom-module-fields-count', {}, `${subCount} ${subCount === 1 ? 'sub-field' : 'sub-fields'}`));

					const footerActions = append(footer, $('.custom-module-footer-actions'));
					const delBtn = append(footerActions, $('span.action-icon-btn.delete-btn' + ThemeIcon.asCSSSelector(Codicon.trash)));
					delBtn.title = 'Delete Reusable Class';
					delBtn.onclick = async (e) => {
						e.stopPropagation();
						const res = await this.dialogService.confirm({
							message: `Delete composite class "${cc.name}"?`,
							detail: 'This will remove the saved class template from the component library.',
							primaryButton: 'Delete'
						});
						if (res.confirmed) {
							await this.customModulesService.deleteCompositeComponent(cc);
							this.renderContent();
						}
					};
				});
			}
		};

		renderList();
		this.containerEl.scrollTop = prevScrollTop;
	}

	/*
	private async _toggleModuleStatus(m: ICustomModule, customModules: ICustomModule[]): Promise<void> {
		m.isDeprecated = !m.isDeprecated;
		m.updatedAt = Date.now();
		const existingIndex = customModules.findIndex(cm => cm.id.toLowerCase() === m.id.toLowerCase());
		if (existingIndex !== -1) {
			customModules[existingIndex].isDeprecated = m.isDeprecated;
			customModules[existingIndex].updatedAt = m.updatedAt;
		} else {
			customModules.push(m);
		}
		await this.customModulesService.saveCustomModules(customModules);
		this.renderContent();
	}
	*/
}
