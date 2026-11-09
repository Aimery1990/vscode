/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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
		@IDialogService private readonly dialogService: IDialogService
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

		const [customModules, compositeClasses] = await Promise.all([
			this.customModulesService.getCustomModules(),
			this.customModulesService.getCompositeComponents()
		]);

		if (currentVersion !== this.renderVersion || !this.containerEl) {
			return;
		}

		clearNode(this.containerEl);

		// Use actual persisted modules directly (sorted by most recently edited first)
		const allModules = customModules;

		// Update native pane title cleanly (e.g. "Custom Modules (11)")
		this.updateTitle(`Custom Modules (${allModules.length})`);

		// 1. Clean Search Input Box (No duplicate header/buttons)
		const filterRow = append(this.containerEl, $('.custom-modules-filter-row'));
		const searchInput = append(filterRow, $('input.custom-modules-search-input')) as HTMLInputElement;
		searchInput.placeholder = 'Search modules by name or description...';
		searchInput.value = this.filterText;
		searchInput.oninput = () => {
			this.filterText = searchInput.value.toLowerCase().trim();
			renderList();
		};

		// 2. Modules List Container
		const listContainer = append(this.containerEl, $('.custom-modules-list'));

		const updateSelectedCardStyle = () => {
			listContainer.querySelectorAll('.custom-module-card[data-module-id]').forEach(el => {
				const cardEl = el as HTMLElement;
				const cardModId = (cardEl.getAttribute('data-module-id') || '').toLowerCase();
				if (this.selectedModuleId && cardModId === this.selectedModuleId.toLowerCase()) {
					cardEl.classList.add('selected');
				} else {
					cardEl.classList.remove('selected');
				}
			});
		};

		const renderList = () => {
			clearNode(listContainer);

			let filtered = allModules;
			if (this.filterText) {
				filtered = filtered.filter(m =>
					(m.name || '').toLowerCase().includes(this.filterText) ||
					(typeof m.description === 'string' && m.description.toLowerCase().includes(this.filterText))
				);
			}

			if (filtered.length === 0) {
				const empty = append(listContainer, $('.custom-modules-empty'));
				append(empty, $('span.custom-modules-empty-icon' + ThemeIcon.asCSSSelector(Codicon.package)));
				append(empty, $('div', { class: 'custom-modules-empty-text' }, this.filterText ? 'No modules match your search.' : 'No modules defined yet.'));
				return;
			}

			filtered.forEach(m => {
				const card = append(listContainer, $('.custom-module-card'));
				card.setAttribute('data-module-id', m.id);
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

				/*
				// Action icons container in bottom-right (commented out per user preference: all actions are performed in the Schema Editor header)
				const footerActions = append(footer, $('.custom-module-footer-actions'));

				// 0. Preview Ticket button (opens live Ticket Preview tab in Editor Area)
				const previewBtn = append(footerActions, $('span.action-icon-btn.preview-btn' + ThemeIcon.asCSSSelector(Codicon.eye)));
				previewBtn.title = 'Preview Ticket Template';
				previewBtn.onclick = async (e) => {
					e.stopPropagation();
					await this.customModulesService.openModuleTicketPreview(m);
				};

				// 1. Toggle Disable/Enable button
				const toggleBtn = append(footerActions, $(`span.action-icon-btn.${m.isDeprecated ? 'enable-btn' : 'disable-btn'}` + ThemeIcon.asCSSSelector(m.isDeprecated ? Codicon.check : Codicon.circleSlash)));
				toggleBtn.title = m.isDeprecated ? 'Enable Module' : 'Disable Module';
				toggleBtn.onclick = async (e) => {
					e.stopPropagation();
					await this._toggleModuleStatus(m, customModules);
				};

				// 2. Edit button (opens in Editor Area)
				const editBtn = append(footerActions, $('span.action-icon-btn.edit-btn' + ThemeIcon.asCSSSelector(Codicon.edit)));
				editBtn.title = 'Edit Module Schema';
				editBtn.onclick = (e) => {
					e.stopPropagation();
					this.selectedModuleId = m.id;
					updateSelectedCardStyle();
					this.customModulesService.openSchemaDesigner({
						targetModuleId: m.id
					});
				};

				// 3. Delete button
				const delBtn = append(footerActions, $('span.action-icon-btn.delete-btn' + ThemeIcon.asCSSSelector(Codicon.trash)));
				delBtn.title = 'Delete Module';
				delBtn.onclick = async (e) => {
					e.stopPropagation();
					const res = await this.dialogService.confirm({
						message: `Delete module "${m.name}"?`,
						detail: `This will remove the YAML schema file (${m.id}.yaml). Existing entities of this type will preserve their data.`,
						primaryButton: 'Delete'
					});
					if (res.confirmed) {
						await this.customModulesService.deleteCustomModule(m.id);
					}
				};
				*/

				// Clicking card directly launches the schema editor in main workspace without re-rendering or resetting scroll
				card.onclick = () => {
					this.selectedModuleId = m.id;
					updateSelectedCardStyle();
					this.customModulesService.openSchemaDesigner({
						targetModuleId: m.id
					});
				};
			});

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
