/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainer, ViewContainerLocation, IViewDescriptor } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IDiagramsManagerService, DIAGRAMS_MANAGER_VIEWLET_ID, DIAGRAMS_MANAGER_PANE_ID } from '../common/diagramsManager.js';
import { DiagramsManagerService } from './diagramsManagerService.js';
import { DiagramsManagerPane } from './diagramsManagerPane.js';
import { DiagramEditorInput } from './diagramEditorInput.js';
import { WorkflowEditor } from '../../workflowsManager/browser/workflowEditor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { createDiagramDialog } from './diagramEditorDialog.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IPathService } from '../../../services/path/common/pathService.js';

// 1. Register Service
registerSingleton(IDiagramsManagerService, DiagramsManagerService, InstantiationType.Delayed);

// 2. Register Icon (Codicon.graph as the standard Diagram/Flowchart icon)
export const diagramsManagerIcon = registerIcon(
	'diagrams-manager-view-icon',
	Codicon.graph,
	localize('diagramsManagerIcon', 'View icon of the Diagrams Manager view.')
);

// 3. Register View Container (order: 4 places it right next to Workflows)
const viewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: DIAGRAMS_MANAGER_VIEWLET_ID,
	title: localize2('diagramsManager', "Diagrams"),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [DIAGRAMS_MANAGER_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: 'workbench.diagramsManager.views.state',
	icon: diagramsManagerIcon,
	hideIfEmpty: false,
	order: 4,
	openCommandActionDescriptor: {
		id: DIAGRAMS_MANAGER_VIEWLET_ID,
		title: localize2('diagramsManager', "Diagrams"),
		mnemonicTitle: localize({ key: 'miViewDiagramsManager', comment: ['&& denotes a mnemonic'] }, "&&Diagrams"),
		order: 4
	}
}, ViewContainerLocation.Sidebar, { isDefault: true });

// 4. Register View Panes
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

const viewDescriptors: IViewDescriptor[] = [
	{
		id: DIAGRAMS_MANAGER_PANE_ID,
		name: localize2('diagramsAll', "All Diagrams"),
		ctorDescriptor: new SyncDescriptor(DiagramsManagerPane),
		order: 1,
		canToggleVisibility: false,
		canMoveView: true,
		containerIcon: diagramsManagerIcon
	}
];

viewsRegistry.registerViews(viewDescriptors, viewContainer);

// 5. Register Header Action: New Diagram button
registerAction2(class NewDiagramAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.diagramsManager.newDiagram',
			title: localize2('newDiagram', "New Diagram..."),
			icon: Codicon.plus,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', DIAGRAMS_MANAGER_PANE_ID),
				group: 'navigation',
				order: 1
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const workspaceContextService = accessor.get(IWorkspaceContextService);
		const fileDialogService = accessor.get(IFileDialogService);
		const pathService = accessor.get(IPathService);
		const diagramsManagerService = accessor.get(IDiagramsManagerService);
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);

		await createDiagramDialog(workspaceContextService, fileDialogService, pathService, async (result) => {
			try {
				const uri = await diagramsManagerService.createDiagram(result);
				const editorInput = new DiagramEditorInput(uri, result.name);
				await editorService.openEditor(editorInput);
				notificationService.info(`Created diagram '${result.name}'`);
			} catch (err) {
				notificationService.error(`Failed to create diagram: ${err}`);
			}
		});
	}
});

// 6. Register Diagram Editor Pane (reusing the shared WorkflowEditor engine)
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		WorkflowEditor,
		'workbench.editor.diagramEditor',
		localize('diagramEditor', "Diagram Editor")
	),
	[
		new SyncDescriptor(DiagramEditorInput)
	]
);

class DiagramEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return false;
	}

	serialize(): string | undefined {
		return undefined;
	}

	deserialize(): DiagramEditorInput | undefined {
		return undefined;
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(DiagramEditorInput.ID, DiagramEditorInputSerializer);
