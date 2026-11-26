/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import './media/customModules.css';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IViewDescriptor, IViewsRegistry, Extensions as ViewContainerExtensions, WindowEnablement, ViewContainer, IViewContainersRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { localize, localize2 } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ICustomModulesService } from '../common/customModules.js';
import { CustomModulesService } from './customModulesService.js';
import { CustomModulesPane, CustomModulesViewPaneId } from './customModulesPane.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { CustomModuleSchemaEditor } from './customModuleSchemaEditor.js';
import { CustomModuleSchemaEditorInput, customModulesViewIcon } from './customModuleSchemaEditorInput.js';
import './tools/customModuleTools.contribution.js';

// 1. Register Singleton Service
registerSingleton(ICustomModulesService, CustomModulesService, InstantiationType.Delayed);

export { customModulesViewIcon };

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
				when: ContextKeyExpr.equals('view', CustomModulesViewPaneId)
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(ICustomModulesService);
		await service.openSchemaDesigner();
	}
});

registerAction2(class NewCustomModuleCategoryAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.customModules.newCategory',
			title: localize2('newCustomModuleCategory', "New Category"),
			icon: Codicon.newFolder,
			menu: {
				id: MenuId.ViewTitle,
				group: 'navigation',
				order: 2,
				when: ContextKeyExpr.equals('view', CustomModulesViewPaneId)
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(ICustomModulesService);
		const quickInputService = accessor.get(IQuickInputService);
		const name = await quickInputService.input({
			prompt: localize('enterCategoryPrompt', "Enter category name to organize custom modules"),
			placeHolder: localize('categoryPlaceholder', "e.g. Job Search, Resume Tools, Data Engine")
		});
		if (name && name.trim()) {
			await service.addCategory(name.trim());
		}
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
				order: 3,
				when: ContextKeyExpr.equals('view', CustomModulesViewPaneId)
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const pane = viewsService.getActiveViewWithId<CustomModulesPane>(CustomModulesViewPaneId);
		if (pane && typeof pane.renderContent === 'function') {
			await pane.renderContent();
		} else {
			const service = accessor.get(ICustomModulesService);
			await service.getCustomModules();
		}
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

/**
 * Restores component / module editor tabs on start-up. Workflow-node editors (`wf_node_*`) come back unbound and are
 * re-bound by their workflow canvas once it has loaded (see WorkflowEditor._rebindOpenNodeSchemaEditors); until then
 * the editor shows a placeholder.
 */
class CustomModuleSchemaEditorInputSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof CustomModuleSchemaEditorInput && !!input.moduleId;
	}

	serialize(input: EditorInput): string | undefined {
		if (!(input instanceof CustomModuleSchemaEditorInput)) {
			return undefined;
		}
		return JSON.stringify({
			moduleId: input.moduleId,
			moduleName: input.moduleName,
			workspaceUri: input.workspaceUri?.toString(),
			nodeId: input.nodeId,
			freestyleTicketUri: input.freestyleTicketUri?.toString()
		});
	}

	deserialize(_instantiationService: IInstantiationService, raw: string): CustomModuleSchemaEditorInput | undefined {
		try {
			const data = JSON.parse(raw);
			if (typeof data?.moduleId !== 'string' || !data.moduleId) {
				return undefined;
			}
			const input = new CustomModuleSchemaEditorInput(data.moduleId, data.moduleName || data.moduleId, typeof data.workspaceUri === 'string' ? URI.parse(data.workspaceUri) : undefined);
			if (typeof data.nodeId === 'string') {
				input.nodeId = data.nodeId;
			}
			if (typeof data.freestyleTicketUri === 'string' && data.freestyleTicketUri) {
				input.freestyleTicketUri = URI.parse(data.freestyleTicketUri);
			}
			return input;
		} catch {
			return undefined;
		}
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(CustomModuleSchemaEditorInput.ID, CustomModuleSchemaEditorInputSerializer);

