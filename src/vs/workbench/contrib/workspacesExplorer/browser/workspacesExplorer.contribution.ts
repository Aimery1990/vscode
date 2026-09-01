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
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';

import {
	WORKSPACES_EXPLORER_VIEWLET_ID,
	WORKSPACE_PANE_VIEW_ID,
	IWorkspacesExplorerService
} from '../common/workspacesExplorer.js';
import { WorkspacesExplorerService } from './workspacesExplorerService.js';
import { WorkspacesExplorerViewPaneContainer } from './workspacesExplorerViewlet.js';
import { MainWorkspaceViewPane } from './workspacesExplorerPane.js';
import { EntityDetailEditor } from './entityDetailEditor.js';
import { EntityDetailEditorInput } from './entityDetailEditorInput.js';
import './tools/ticketTools.contribution.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';

// 1. Register Singleton Service
registerSingleton(IWorkspacesExplorerService, WorkspacesExplorerService, InstantiationType.Delayed);

// 2. Register Icon
const workspacesExplorerIcon = registerIcon(
	'workspaces-explorer-view-icon',
	Codicon.rootFolder,
	localize('workspacesExplorerIcon', 'View icon of the Workspaces view.')
);

// 3. Register View Container (order: -1 places it at the very top of Activity Bar, right above Explorer)
const viewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: WORKSPACES_EXPLORER_VIEWLET_ID,
	title: localize2('workspaces', "Workspaces"),
	ctorDescriptor: new SyncDescriptor(WorkspacesExplorerViewPaneContainer),
	storageId: 'workbench.workspacesExplorer.views.state',
	icon: workspacesExplorerIcon,
	alwaysUseContainerInfo: true,
	order: -1,
	openCommandActionDescriptor: {
		id: WORKSPACES_EXPLORER_VIEWLET_ID,
		title: localize2('workspaces', "Workspaces"),
		mnemonicTitle: localize({ key: 'miViewWorkspaces', comment: ['&& denotes a mnemonic'] }, "&&Workspaces"),
		keybindings: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyW },
		order: -1
	}
}, ViewContainerLocation.Sidebar, { isDefault: false });

// 4. Register View Pane
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

const viewDescriptors: IViewDescriptor[] = [
	{
		id: WORKSPACE_PANE_VIEW_ID,
		name: localize2('workspace', "Workspace"),
		ctorDescriptor: new SyncDescriptor(MainWorkspaceViewPane),
		order: 1,
		canToggleVisibility: true,
		canMoveView: true,
		containerIcon: workspacesExplorerIcon
	}
];

viewsRegistry.registerViews(viewDescriptors, viewContainer);

// 5. Register Header Action Icons (Open Workspace & New Workspace)
registerAction2(class OpenWorkspaceAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.workspacesExplorer.openWorkspace',
			title: localize2('openWorkspace', "Open Workspace"),
			icon: Codicon.folderOpened,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', WORKSPACE_PANE_VIEW_ID),
				group: 'navigation',
				order: 1
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		const fileDialogService = accessor.get(IFileDialogService);

		const selected = await fileDialogService.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: true,
			canSelectMany: false,
			title: localize('openWorkspaceDialog', "Open Workspace Folder or File")
		});

		if (selected && selected.length > 0) {
			const uri = selected[0];
			await commandService.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
		}
	}
});

registerAction2(class NewWorkspaceAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.workspacesExplorer.newWorkspace',
			title: localize2('newWorkspace', "New Workspace"),
			icon: Codicon.plus,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', WORKSPACE_PANE_VIEW_ID),
				group: 'navigation',
				order: 2
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		const fileDialogService = accessor.get(IFileDialogService);
		const fileService = accessor.get(IFileService);
		const notificationService = accessor.get(INotificationService);

		const folderUri = await fileDialogService.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			title: localize('newWorkspaceDialog', "Select Folder for New Workspace")
		});

		if (folderUri && folderUri.length > 0) {
			const uri = folderUri[0];
			const name = uri.path.split('/').pop() || 'Workspace';
			const wsFileUri = URI.file(`${uri.fsPath}/${name}.code-workspace`);

			const wsConfig = {
				folders: [{ path: '.' }],
				settings: {}
			};
			const content = JSON.stringify(wsConfig, null, 2);
			await fileService.writeFile(wsFileUri, VSBuffer.fromString(content));
			notificationService.info(`Workspace '${name}' created!`);
			await commandService.executeCommand('vscode.openFolder', wsFileUri, { forceNewWindow: false });
		}
	}
});

// --- Register Entity Detail Editor ---
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		EntityDetailEditor,
		EntityDetailEditor.ID,
		localize('entityDetailEditor', "Entity Detail")
	),
	[
		new SyncDescriptor(EntityDetailEditorInput)
	]
);

class EntityDetailEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return false;
	}

	serialize(): string | undefined {
		return undefined;
	}

	deserialize(): EntityDetailEditorInput | undefined {
		return undefined;
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(EntityDetailEditorInput.ID, EntityDetailEditorInputSerializer);

