/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainer, ViewContainerLocation, IViewDescriptor } from '../../../common/views.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { basename, dirname } from '../../../../base/common/resources.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { externalizeLongTicketFields } from './ticketFieldMigration.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { describeTicketLocation, GO_TO_TICKET_COMMAND_ID, ITicketSearchEntry, ITicketSearchIndex, searchTickets, TICKET_SEARCH_MAX_RESULTS } from '../common/ticketSearch.js';
import { WorkflowEditorInput } from '../../workflowsManager/browser/workflowEditorInput.js';
import { openSubWorkflowTicketCanvas } from '../../workflowsManager/browser/subWorkflowLiveView.js';
import { isSubWorkflowTicketType } from '../../customModules/common/subWorkflowType.js';

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
import { EditorInput } from '../../../common/editor/editorInput.js';
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

// CI-51: one-time explicit migration of long inline ticket field values into `.agents/fields/<key>.txt`.
registerAction2(class ExternalizeLongTicketFieldsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.workspacesExplorer.externalizeLongTicketFields',
			title: localize2('externalizeLongTicketFields', "Externalize Long Ticket Fields"),
			category: localize2('anyAgentCategory', "AnyAgent"),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const workspacesExplorerService = accessor.get(IWorkspacesExplorerService);
		const quickInputService = accessor.get(IQuickInputService);
		const dialogService = accessor.get(IDialogService);
		const progressService = accessor.get(IProgressService);
		const notificationService = accessor.get(INotificationService);
		const fileService = accessor.get(IFileService);

		const workspaces = (await workspacesExplorerService.getWorkspaces()).filter(w => !w.isMissing);
		if (workspaces.length === 0) {
			notificationService.info(localize('externalizeNoWorkspaces', "No workspaces found."));
			return;
		}
		const picked = await quickInputService.pick(workspaces.map((w): IQuickPickItem & { root: URI } => {
			const root = w.uri.path.endsWith('.code-workspace') ? dirname(w.uri) : w.uri;
			return { label: w.name, description: root.fsPath, root };
		}), { placeHolder: localize('externalizePickWorkspace', "Select the workspace whose long ticket field values should be moved into .agents/fields/") });
		if (!picked) {
			return;
		}

		const dryRun = await progressService.withProgress({ location: ProgressLocation.Notification, title: localize('externalizeScanning', "Scanning tickets for long field values...") },
			() => externalizeLongTicketFields(fileService, picked.root, { dryRun: true }));
		if (dryRun.files.length === 0) {
			notificationService.info(localize('externalizeNothing', "No long inline ticket field values found in '{0}' ({1} ticket files scanned).", picked.label, dryRun.ticketFilesScanned));
			return;
		}
		const lines = dryRun.files.slice(0, 15).map(f => `- ${f.uri.fsPath.slice(picked.root.fsPath.length).replace(/^[\\/]+/, '')}: ${f.fields.map(x => `${x.label} (${x.chars} chars)`).join(', ')}`);
		if (dryRun.files.length > 15) {
			lines.push(localize('externalizeMore', "... and {0} more files", dryRun.files.length - 15));
		}
		const { confirmed } = await dialogService.confirm({
			message: localize('externalizeConfirm', "Move {0} long field values ({1} characters) of {2} ticket files into .agents/fields/?", dryRun.fieldCount, dryRun.charCount, dryRun.files.length),
			detail: localize('externalizeDetail', "ticket.md / README.md / instruction.md keep a one line reference (@file(...)); values are unchanged and no change log entry is written.\n\n{0}", lines.join('\n')),
			primaryButton: localize({ key: 'externalizeConfirmButton', comment: ['&& denotes a mnemonic'] }, "&&Externalize")
		});
		if (!confirmed) {
			return;
		}
		const result = await progressService.withProgress({ location: ProgressLocation.Notification, title: localize('externalizeRunning', "Externalizing long ticket field values...") },
			() => externalizeLongTicketFields(fileService, picked.root, { dryRun: false }));
		if (result.failed.length > 0) {
			notificationService.warn(localize('externalizePartial', "Externalized {0} field values; {1} files failed: {2}", result.fieldCount - result.failed.length, result.failed.length, result.failed.map(f => f.uri.fsPath).join(', ')));
		} else {
			notificationService.info(localize('externalizeDone', "Externalized {0} field values of {1} ticket files.", result.fieldCount, result.files.length));
		}
	}
});

// UI-21: Go to Ticket - a quick pick over every ticket of every managed workspace (ID or title); the pick is opened
// and revealed in the Workspaces tree. Cmd+Alt+T is taken on macOS (Close Other Editors in Group), so Cmd/Ctrl+Alt+J.
registerAction2(class GoToTicketAction extends Action2 {
	constructor() {
		super({
			id: GO_TO_TICKET_COMMAND_ID,
			title: localize2('goToTicket', "Go to Ticket..."),
			category: localize2('anyAgentCategory', "AnyAgent"),
			icon: Codicon.search,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyJ,
				weight: KeybindingWeight.WorkbenchContrib
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const workspacesExplorerService = accessor.get(IWorkspacesExplorerService);
		const quickInputService = accessor.get(IQuickInputService);
		const viewsService = accessor.get(IViewsService);
		const editorService = accessor.get(IEditorService);
		const storageService = accessor.get(IStorageService);
		const includeRemoved = storageService.getBoolean('anyagent.workspacesExplorer.showRemovedItems', StorageScope.PROFILE, false);

		type TicketPickItem = IQuickPickItem & { entry: ITicketSearchEntry };
		const store = new DisposableStore();
		const picker = store.add(quickInputService.createQuickPick<TicketPickItem>());
		picker.placeholder = localize('goToTicketPlaceholder', "Type a ticket ID (e.g. ANYAG-0111 or 0111) or part of a title");
		picker.matchOnLabel = picker.matchOnDescription = picker.matchOnDetail = picker.sortByLabel = false;
		picker.busy = true;
		let index: ITicketSearchIndex | undefined;
		const update = () => {
			if (!index) {
				return;
			}
			const result = searchTickets(index.entries, picker.value, { includeRemoved, minLength: 1 });
			picker.items = result.matches.map((m): TicketPickItem => {
				const sep = m.entry.title ? ' \u2014 ' : '';
				const titleOffset = m.entry.ticketId.length + sep.length;
				const highlights = [];
				if (m.idRange) {
					highlights.push({ start: m.idRange[0], end: m.idRange[1] });
				}
				if (m.titleRange) {
					highlights.push({ start: titleOffset + m.titleRange[0], end: titleOffset + m.titleRange[1] });
				}
				return {
					label: `${m.entry.ticketId}${sep}${m.entry.title}`,
					description: describeTicketLocation(m.entry) + (m.entry.status ? ` \u00b7 ${m.entry.status}` : ''),
					highlights: { label: highlights },
					entry: m.entry
				};
			});
			picker.title = !picker.value.trim()
				? localize('goToTicketTitleAll', "Go to Ticket ({0} tickets)", index.entries.length)
				: result.capped
					? localize('goToTicketTitleCapped', "Go to Ticket (first {0} of {1} matches)", TICKET_SEARCH_MAX_RESULTS, result.total)
					: localize('goToTicketTitle', "Go to Ticket ({0} matches)", result.total);
		};
		store.add(picker.onDidChangeValue(update));
		const picked = new Promise<ITicketSearchEntry | undefined>(resolve => {
			store.add(picker.onDidAccept(() => {
				resolve(picker.selectedItems[0]?.entry ?? picker.activeItems[0]?.entry);
				picker.hide();
			}));
			store.add(picker.onDidHide(() => resolve(undefined)));
		});
		picker.show();
		workspacesExplorerService.getTicketSearchIndex().then(loaded => {
			index = loaded;
			picker.busy = false;
			update();
		}, () => {
			picker.busy = false;
		});
		const entry = await picked;
		store.dispose();
		if (!entry) {
			return;
		}
		const pane = await viewsService.openView(WORKSPACE_PANE_VIEW_ID, false);
		if (pane instanceof MainWorkspaceViewPane) {
			await pane.revealTicket(entry, true);
			return;
		}
		// the Workspaces view is unavailable: still open the ticket
		const name = basename(entry.resource);
		if (entry.type === 'workflow') {
			await editorService.openEditor(new WorkflowEditorInput(entry.resource, name), { pinned: true });
		} else if (entry.type && isSubWorkflowTicketType(entry.type)) {
			await openSubWorkflowTicketCanvas(editorService, entry.resource, name);
		} else {
			await editorService.openEditor(new EntityDetailEditorInput(entry.resource, name), { pinned: true });
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

/** Restores open ticket / entity detail tabs on start-up. Template previews are transient and not restored. */
class EntityDetailEditorInputSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof EntityDetailEditorInput && !input.previewModule;
	}

	serialize(input: EditorInput): string | undefined {
		if (!(input instanceof EntityDetailEditorInput) || input.previewModule) {
			return undefined;
		}
		return JSON.stringify({ entityUri: input.entityUri.toString(), entityName: input.entityName });
	}

	deserialize(_instantiationService: IInstantiationService, raw: string): EntityDetailEditorInput | undefined {
		try {
			const data = JSON.parse(raw);
			if (typeof data?.entityUri !== 'string' || typeof data?.entityName !== 'string') {
				return undefined;
			}
			return new EntityDetailEditorInput(URI.parse(data.entityUri), data.entityName);
		} catch {
			return undefined;
		}
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(EntityDetailEditorInput.ID, EntityDetailEditorInputSerializer);

