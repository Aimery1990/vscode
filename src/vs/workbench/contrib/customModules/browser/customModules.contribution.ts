/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/customModules.css';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IViewDescriptor, IViewsRegistry, Extensions as ViewContainerExtensions, WindowEnablement, ViewContainer, IViewContainersRegistry, ViewContainerLocation } from '../../../common/views.js';
import { localize, localize2 } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ICustomModulesService } from '../common/customModules.js';
import { CustomModulesService } from './customModulesService.js';
import { CustomModulesPane, CustomModulesViewPaneId } from './customModulesPane.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { CustomModuleSchemaEditor } from './customModuleSchemaEditor.js';
import { CustomModuleSchemaEditorInput } from './customModuleSchemaEditorInput.js';
import './tools/customModuleTools.contribution.js';

// 1. Register Singleton Service
registerSingleton(ICustomModulesService, CustomModulesService, InstantiationType.Delayed);

// 2. Register Icon
export const customModulesViewIcon = registerIcon(
	'custom-modules-view-icon',
	Codicon.layout,
	localize('customModulesViewIcon', 'View icon of the Custom Modules & Data Types view.')
);

export const CUSTOM_MODULES_VIEWLET_ID = 'workbench.view.customModules';
const CUSTOM_MODULES_VIEW_TITLE = localize2('customModules.view.label', "Custom Modules");

// 3. Register View Container (order: 8 mounts between Agent Groups (7) and Extensions (9))
const customModulesViewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: CUSTOM_MODULES_VIEWLET_ID,
	title: CUSTOM_MODULES_VIEW_TITLE,
	icon: customModulesViewIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CUSTOM_MODULES_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: 'workbench.customModules.views.state',
	hideIfEmpty: false,
	order: 8,
	openCommandActionDescriptor: {
		id: CUSTOM_MODULES_VIEWLET_ID,
		mnemonicTitle: localize({ key: 'miCustomModules', comment: ['&& denotes a mnemonic'] }, "&&Custom Modules"),
		order: 8
	},
	windowEnablement: WindowEnablement.Both
}, ViewContainerLocation.Sidebar, { isDefault: true });

// 4. Register View Pane
const customModulesViewPaneDescriptor: IViewDescriptor = {
	id: CustomModulesViewPaneId,
	containerIcon: customModulesViewIcon,
	containerTitle: CUSTOM_MODULES_VIEW_TITLE.value,
	singleViewPaneContainerTitle: CUSTOM_MODULES_VIEW_TITLE.value,
	name: CUSTOM_MODULES_VIEW_TITLE,
	canToggleVisibility: true,
	canMoveView: false,
	ctorDescriptor: new SyncDescriptor(CustomModulesPane),
	windowEnablement: WindowEnablement.Both
};

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([customModulesViewPaneDescriptor], customModulesViewContainer);

// 5. Header Actions
registerAction2(class NewCustomModuleAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.customModules.newModule',
			title: localize2('newCustomModule', "New Custom Module"),
			icon: Codicon.plus,
			menu: {
				id: MenuId.ViewTitle,
				group: 'navigation',
				order: 1,
				when: undefined
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(ICustomModulesService);
		await service.openSchemaDesigner();
	}
});

registerAction2(class RefreshCustomModulesAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.customModules.refresh',
			title: localize2('refreshCustomModules', "Refresh Modules"),
			icon: Codicon.refresh,
			menu: {
				id: MenuId.ViewTitle,
				group: 'navigation',
				order: 2,
				when: undefined
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(ICustomModulesService);
		await service.getCustomModules();
	}
});

registerAction2(class OpenCustomModulesManagerAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.customModules.openManager',
			title: localize2('openCustomModulesManager', "Manage Custom Modules & Schema"),
		});
	}

	async run(accessor: ServicesAccessor, options?: { targetModuleId?: string; workspaceUri?: URI; onUpdate?: () => void }): Promise<void> {
		const service = accessor.get(ICustomModulesService);
		await service.openSchemaDesigner(options);
	}
});

// 6. Register Custom Module Schema Editor Pane in Main Editor Work Area
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		CustomModuleSchemaEditor,
		CustomModuleSchemaEditor.ID,
		localize('customModuleSchemaEditor', "Module Schema Designer")
	),
	[
		new SyncDescriptor(CustomModuleSchemaEditorInput)
	]
);

class CustomModuleSchemaEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return false;
	}

	serialize(): string | undefined {
		return undefined;
	}

	deserialize(): CustomModuleSchemaEditorInput | undefined {
		return undefined;
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(CustomModuleSchemaEditorInput.ID, CustomModuleSchemaEditorInputSerializer);

