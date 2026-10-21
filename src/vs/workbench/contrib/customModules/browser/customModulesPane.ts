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
import { ICustomModule } from '../../entityPersistence/common/entityPersistence.js';
import { ICustomModulesService } from '../common/customModules.js';

export const CustomModulesViewPaneId = 'workbench.view.customModules.pane';

export class CustomModulesPane extends ViewPane {
	private containerEl?: HTMLElement;
	private filterText = '';
	private renderVersion = 0;

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
		clearNode(this.containerEl);

		const [customModules, compositeClasses] = await Promise.all([
			this.customModulesService.getCustomModules(),
			this.customModulesService.getCompositeComponents()
		]);

		if (currentVersion !== this.renderVersion) {
			return;
		}

		const systemModules = this.customModulesService.getSystemModules();

		// Combine custom and system modules into unified list
		const allModulesMap = new Map<string, ICustomModule>();
		systemModules.forEach(m => allModulesMap.set(m.id.toLowerCase(), m));
		customModules.forEach(m => allModulesMap.set(m.id.toLowerCase(), m));
		const allModules = Array.from(allModulesMap.values());

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

		const renderList = () => {
			clearNode(listContainer);

			let filtered = allModules;
			if (this.filterText) {
				filtered = filtered.filter(m =>
					m.name.toLowerCase().includes(this.filterText) ||
					(m.description && m.description.toLowerCase().includes(this.filterText))
				);
			}

			if (filtered.length === 0) {
				const empty = append(listContainer, $('.custom-modules-empty'));
				append(empty, $('span' + ThemeIcon.asCSSSelector(Codicon.package), { class: 'custom-modules-empty-icon' }));
				append(empty, $('div', { class: 'custom-modules-empty-text' }, this.filterText ? 'No modules match your search.' : 'No modules defined yet.'));
				return;
			}

			filtered.forEach(m => {
				const card = append(listContainer, $('.custom-module-card'));
				if (m.isDeprecated) {
					card.classList.add('deprecated');
				}

				// Top row: color dot, module name, action buttons
				const cardTop = append(card, $('.custom-module-card-top'));
				const titleLeft = append(cardTop, $('.custom-module-card-title-left'));

				const dot = append(titleLeft, $('.custom-module-color-dot'));
				dot.style.backgroundColor = m.color || '#38bdf8';
				dot.style.color = m.color || '#38bdf8';

				const nameSpan = append(titleLeft, $('span.custom-module-name', {}, m.name));
				if (m.isDeprecated) {
					nameSpan.style.textDecoration = 'line-through';
					nameSpan.style.opacity = '0.75';
					append(titleLeft, $('span.custom-module-status-pill.disabled', {}, 'Disabled'));
				}

				// Description (between header and footer)
				if (m.description) {
					append(card, $('.custom-module-desc', {}, m.description));
				}

				// Footer row: clean field count on left, action icons on right
				const footer = append(card, $('.custom-module-card-footer'));
				const fieldCount = m.fields ? m.fields.length : 0;
				append(footer, $('.custom-module-fields-count', {}, `${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'}`));

				// Action icons container in bottom-right
				const footerActions = append(footer, $('.custom-module-footer-actions'));

				// 1. Toggle Disable/Enable button
				const toggleBtn = append(footerActions, $('span' + ThemeIcon.asCSSSelector(m.isDeprecated ? Codicon.check : Codicon.circleSlash), {
					class: `action-icon-btn ${m.isDeprecated ? 'enable-btn' : 'disable-btn'}`
				}));
				toggleBtn.title = m.isDeprecated ? 'Enable Module' : 'Disable Module';
				toggleBtn.onclick = async (e) => {
					e.stopPropagation();
					await this._toggleModuleStatus(m, customModules);
				};

				// 2. Edit button (opens in Editor Area)
				const editBtn = append(footerActions, $('span' + ThemeIcon.asCSSSelector(Codicon.edit), { class: 'action-icon-btn edit-btn' }));
				editBtn.title = 'Edit Module Schema';
				editBtn.onclick = (e) => {
					e.stopPropagation();
					this.customModulesService.openSchemaDesigner({
						targetModuleId: m.id,
						onUpdate: () => this.renderContent()
					});
				};

				// 3. Delete button (only for custom modules, omitted for system modules)
				const isSystem = systemModules.some(sm => sm.id.toLowerCase() === m.id.toLowerCase());
				if (!isSystem) {
					const delBtn = append(footerActions, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), {
						class: 'action-icon-btn delete-btn'
					}));
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
							this.renderContent();
						}
					};
				}

				// Clicking card directly launches the schema editor in main workspace
				card.onclick = () => {
					this.customModulesService.openSchemaDesigner({
						targetModuleId: m.id,
						onUpdate: () => this.renderContent()
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
					const delBtn = append(footerActions, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), { class: 'action-icon-btn delete-btn' }));
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
	}

	private async _toggleModuleStatus(m: ICustomModule, customModules: ICustomModule[]): Promise<void> {
		m.isDeprecated = !m.isDeprecated;
		const existingIndex = customModules.findIndex(cm => cm.id.toLowerCase() === m.id.toLowerCase());
		if (existingIndex !== -1) {
			customModules[existingIndex].isDeprecated = m.isDeprecated;
		} else {
			customModules.push(m);
		}
		await this.customModulesService.saveCustomModules(customModules);
		this.renderContent();
	}
}
