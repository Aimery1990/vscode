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
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { URI } from '../../../../base/common/uri.js';

import { IWorkflowsManagerService } from '../common/workflowsManager.js';
import { WorkflowsManagerService } from './workflowsManagerService.js';
import { IWorkflowExecutionService } from '../common/workflowExecutionService.js';
import { WorkflowExecutionService } from './workflowExecutionService.js';
import { WorkflowsManagerPane } from './workflowsManagerPane.js';
import { WorkflowEditor } from './workflowEditor.js';
import { WorkflowEditorInput } from './workflowEditorInput.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { createWorkflowDialog } from './workflowEditorDialog.js';
import './tools/workflowTools.contribution.js';

export const WORKFLOWS_MANAGER_VIEWLET_ID = 'workbench.view.workflowsManager';

// 1. Register Services
registerSingleton(IWorkflowsManagerService, WorkflowsManagerService, InstantiationType.Delayed);
registerSingleton(IWorkflowExecutionService, WorkflowExecutionService, InstantiationType.Delayed);

// 2. Register Icon (GithubAction is the unified Workflow Icon)
const workflowsManagerIcon = registerIcon(
	'workflows-manager-view-icon',
	Codicon.githubAction,
	localize('workflowsManagerIcon', 'View icon of the Workflows Manager view.')
);

// 3. Register View Container (order: 3 places it right below AI Agents)
const viewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: WORKFLOWS_MANAGER_VIEWLET_ID,
	title: localize2('workflowsManager', "Workflows"),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [WORKFLOWS_MANAGER_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: false }]),
	storageId: 'workbench.workflowsManager.views.state',
	icon: workflowsManagerIcon,
	hideIfEmpty: false,
	order: 3,
	openCommandActionDescriptor: {
		id: WORKFLOWS_MANAGER_VIEWLET_ID,
		title: localize2('workflowsManager', "Workflows"),
		mnemonicTitle: localize({ key: 'miViewWorkflowsManager', comment: ['&& denotes a mnemonic'] }, "&&Workflows"),
		keybindings: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyO }, // Ctrl+Shift+O is Outline usually, but we use Cmd+Shift+O/Ctrl+Shift+O or other
		order: 3
	}
}, ViewContainerLocation.Sidebar, { isDefault: true });

// 4. Register View Panes
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

const viewDescriptors: IViewDescriptor[] = [
	{
		id: 'workbench.view.workflowsManager.all',
		name: localize2('workflowsAll', "All Workflows"),
		ctorDescriptor: new SyncDescriptor(WorkflowsManagerPane),
		order: 1,
		canToggleVisibility: true,
		canMoveView: true,
		containerIcon: workflowsManagerIcon
	},
	{
		id: 'workbench.view.workflowsManager.workspace',
		name: localize2('workflowsWorkspace', "Workspace Workflows"),
		ctorDescriptor: new SyncDescriptor(WorkflowsManagerPane),
		order: 2,
		canToggleVisibility: true,
		canMoveView: true,
		containerIcon: Codicon.globe
	}
];

viewsRegistry.registerViews(viewDescriptors, viewContainer);

// 5. Register Header Actions: Open Workflow & New Workflow buttons
for (const vd of viewDescriptors) {
	registerAction2(class OpenWorkflowAction extends Action2 {
		constructor() {
			super({
				id: `workbench.action.workflowsManager.openWorkflow.${vd.id}`,
				title: localize2('openWorkflow', "Open Workflow Directory..."),
				icon: Codicon.folderOpened,
				menu: {
					id: MenuId.ViewTitle,
					when: ContextKeyExpr.equals('view', vd.id),
					group: 'navigation',
					order: 1
				}
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const fileDialogService = accessor.get(IFileDialogService);
			const res = await fileDialogService.showOpenDialog({
				canSelectFolders: true,
				canSelectFiles: false,
				canSelectMany: false,
				defaultUri: URI.file('/Users/aimery/Documents/workflows'),
				title: 'Open Existing Workflow Directory'
			});
			if (res && res.length > 0) {
				await createWorkflowDialog(accessor, res[0]);
			}
		}
	});

	registerAction2(class AddWorkflowAction extends Action2 {
		constructor() {
			super({
				id: `workbench.action.workflowsManager.addWorkflow.${vd.id}`,
				title: localize2('addWorkflow', "New / Open Workflow"),
				icon: Codicon.plus,
				menu: {
					id: MenuId.ViewTitle,
					when: ContextKeyExpr.equals('view', vd.id),
					group: 'navigation',
					order: 2
				}
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const workspaceContextService = accessor.get(IWorkspaceContextService);
			const folders = workspaceContextService.getWorkspace().folders;
			const targetFolderUri = folders[0]?.uri;
			await createWorkflowDialog(accessor, targetFolderUri);
		}
	});
}

// 6. Register Workflow Editor Pane
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		WorkflowEditor,
		WorkflowEditor.ID,
		localize('workflowEditor', "Workflow Editor")
	),
	[
		new SyncDescriptor(WorkflowEditorInput)
	]
);

class WorkflowEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return false;
	}

	serialize(): string | undefined {
		return undefined;
	}

	deserialize(): WorkflowEditorInput | undefined {
		return undefined;
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(WorkflowEditorInput.ID, WorkflowEditorInputSerializer);
