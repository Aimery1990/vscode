/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
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
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { URI } from '../../../../base/common/uri.js';

import { IWorkflowsManagerService } from '../common/workflowsManager.js';
import { WorkflowsManagerService } from './workflowsManagerService.js';
import { IWorkflowExecutionService } from '../common/workflowExecutionService.js';
import { WorkflowExecutionService } from './workflowExecutionService.js';
import { ITicketWorkflowRuntimeService, TicketWorkflowRuntime } from './ticketWorkflowRuntime.js';
import { WorkflowsManagerPane } from './workflowsManagerPane.js';
import { WorkflowEditor } from './workflowEditor.js';
import { WorkflowEditorInput } from './workflowEditorInput.js';
import { WorkflowNotebookEditor, WorkflowNotebookEditorInput } from './workflowNotebookEditor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { createWorkflowDialog } from './workflowEditorDialog.js';
import { IWorkflowPyToolboxHost } from './workflowPythonSync.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEntityPersistenceService } from '../../entityPersistence/common/entityPersistence.js';
import { ICustomModulesService } from '../../customModules/common/customModules.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import './tools/workflowTools.contribution.js';
import './subWorkflowLiveView.js';
import './restoreTabsPrompt.js';

export const WORKFLOWS_MANAGER_VIEWLET_ID = 'workbench.view.workflowsManager';

// 1. Register Services
registerSingleton(IWorkflowsManagerService, WorkflowsManagerService, InstantiationType.Delayed);
registerSingleton(IWorkflowExecutionService, WorkflowExecutionService, InstantiationType.Delayed);
registerSingleton(ITicketWorkflowRuntimeService, TicketWorkflowRuntime, InstantiationType.Delayed);

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
	},
	{
		id: 'workbench.view.workflowsManager.independent',
		name: localize2('workflowsIndependent', "Independent Workflows"),
		ctorDescriptor: new SyncDescriptor(WorkflowsManagerPane),
		order: 3,
		canToggleVisibility: true,
		canMoveView: true,
		containerIcon: Codicon.circleSlash
	}
];

viewsRegistry.registerViews(viewDescriptors, viewContainer);

// 5. Register Header Actions: New Workflow, Open Workflow & Refresh Workflow buttons
for (const vd of viewDescriptors) {
	registerAction2(class AddWorkflowAction extends Action2 {
		constructor() {
			super({
				id: `workbench.action.workflowsManager.addWorkflow.${vd.id}`,
				title: localize2('addWorkflow', "New Workflow..."),
				icon: Codicon.plus,
				menu: {
					id: MenuId.ViewTitle,
					when: ContextKeyExpr.equals('view', vd.id),
					group: 'navigation',
					order: 1
				}
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const defaultUri = vd.id.endsWith('.independent') ? URI.file('/Users/aimery/Documents/workflows') : undefined;
			await createWorkflowDialog(accessor, defaultUri);
		}
	});

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
					order: 2
				}
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const fileDialogService = accessor.get(IFileDialogService);
			const instantiationService = accessor.get(IInstantiationService);
			const res = await fileDialogService.showOpenDialog({
				canSelectFolders: true,
				canSelectFiles: false,
				canSelectMany: false,
				defaultUri: URI.file('/Users/aimery/Documents/workflows'),
				title: 'Open Existing Workflow Directory'
			});
			if (res && res.length > 0) {
				await instantiationService.invokeFunction(createWorkflowDialog, res[0]);
			}
		}
	});

	registerAction2(class RefreshWorkflowsAction extends Action2 {
		constructor() {
			super({
				id: `workbench.action.workflowsManager.refresh.${vd.id}`,
				title: localize2('refreshWorkflows', "Refresh Workflows"),
				icon: Codicon.refresh,
				menu: {
					id: MenuId.ViewTitle,
					when: ContextKeyExpr.equals('view', vd.id),
					group: 'navigation',
					order: 3
				}
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const workflowsManagerService = accessor.get(IWorkflowsManagerService);
			workflowsManagerService.refresh();
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

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		WorkflowNotebookEditor,
		WorkflowNotebookEditor.ID,
		localize('workflowNotebookEditor', "Workflow Jupyter Notebook Editor")
	),
	[
		new SyncDescriptor(WorkflowNotebookEditorInput)
	]
);

/**
 * Persists open workflow canvas / notebook tabs (workflow file URI + name) so they are restored on the next
 * start-up together with the editor layout. Run state is not part of it: the run history is persisted separately.
 */
interface ISerializedWorkflowEditorInput {
	workflowUri: string;
	workflowName: string;
}

function parseSerializedWorkflowInput(raw: string): ISerializedWorkflowEditorInput | undefined {
	try {
		const data = JSON.parse(raw) as Partial<ISerializedWorkflowEditorInput>;
		return typeof data.workflowUri === 'string' && data.workflowUri ? { workflowUri: data.workflowUri, workflowName: data.workflowName || 'Workflow' } : undefined;
	} catch {
		return undefined;
	}
}

class WorkflowEditorInputSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof WorkflowEditorInput;
	}

	serialize(input: EditorInput): string | undefined {
		if (!(input instanceof WorkflowEditorInput)) {
			return undefined;
		}
		const data: ISerializedWorkflowEditorInput = { workflowUri: input.workflowUri.toString(), workflowName: input.workflowName };
		return JSON.stringify(data);
	}

	deserialize(_instantiationService: IInstantiationService, raw: string): WorkflowEditorInput | undefined {
		const data = parseSerializedWorkflowInput(raw);
		return data ? new WorkflowEditorInput(URI.parse(data.workflowUri), data.workflowName) : undefined;
	}
}

class WorkflowNotebookEditorInputSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof WorkflowNotebookEditorInput;
	}

	serialize(input: EditorInput): string | undefined {
		if (!(input instanceof WorkflowNotebookEditorInput)) {
			return undefined;
		}
		const data: ISerializedWorkflowEditorInput = { workflowUri: input.workflowUri.toString(), workflowName: input.workflowName };
		return JSON.stringify(data);
	}

	deserialize(_instantiationService: IInstantiationService, raw: string): WorkflowNotebookEditorInput | undefined {
		const data = parseSerializedWorkflowInput(raw);
		return data ? new WorkflowNotebookEditorInput(URI.parse(data.workflowUri), data.workflowName) : undefined;
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(WorkflowEditorInput.ID, WorkflowEditorInputSerializer);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(WorkflowNotebookEditorInput.ID, WorkflowNotebookEditorInputSerializer);

// 7. Register "Sync to Workflow" Action for `.workflow.py` Editor Tabs
registerAction2(class SyncPythonToWorkflowAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.workflowsManager.syncPythonToWorkflow',
			title: localize2('syncToWorkflow', "Sync to Workflow"),
			icon: Codicon.sync,
			f1: true,
			menu: [
				{
					id: MenuId.EditorTitle,
					when: ContextKeyExpr.regex('resourceFilename', /\.workflow\.py$/i),
					group: 'navigation',
					order: -100
				},
				{
					id: MenuId.EditorContext,
					when: ContextKeyExpr.regex('resourceFilename', /\.workflow\.py$/i),
					group: 'navigation',
					order: 1
				}
			]
		});
	}

	async run(accessor: ServicesAccessor, resourceArg?: URI): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const fileService = accessor.get(IFileService);
		const notificationService = accessor.get(INotificationService);
		const entityPersistenceService = accessor.get(IEntityPersistenceService);
		const ticketRuntimeService = accessor.get(ITicketWorkflowRuntimeService);

		const activePane = editorService.activeEditorPane;
		const activeControl = activePane?.getControl?.();
		const activeResource = resourceArg || editorService.activeEditor?.resource;

		await WorkflowEditor.syncPythonEditorToWorkflow(
			activeResource,
			activeControl,
			fileService,
			notificationService,
			entityPersistenceService,
			ticketRuntimeService
		);
	}
});

// 8. Automatically attach the left-side Python Toolbox to any active `.workflow.py` editor tab
class WorkflowPythonEditorToolboxContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.workflowPythonEditorToolbox';

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@IFileService private readonly _fileService: IFileService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IEntityPersistenceService private readonly _entityPersistenceService: IEntityPersistenceService,
		@ITicketWorkflowRuntimeService private readonly _ticketRuntimeService: ITicketWorkflowRuntimeService,
		@ICustomModulesService private readonly _customModulesService: ICustomModulesService
	) {
		super();
		this._register(this._editorService.onDidActiveEditorChange(() => this._checkActiveEditor()));
		this._register(this._editorService.onDidVisibleEditorsChange(() => this._checkActiveEditor()));
		this._register(this._customModulesService.onDidChangeModules(() => this._checkActiveEditor()));
		this._checkActiveEditor();
	}

	private _checkActiveEditor(): void {
		setTimeout(() => {
			try {
				for (const pane of this._editorService.visibleEditorPanes) {
					const resource = pane.input?.resource;
					const control = pane.getControl?.();
					if (control && resource && /\.workflow\.py$/i.test(resource.path)) {
						WorkflowEditor.attachWorkflowPythonToolbox(
							control,
							this._fileService,
							this._notificationService,
							this._entityPersistenceService,
							this._ticketRuntimeService,
							this._editorService,
							this._customModulesService,
							resource
						);
					} else if (control && (control as IWorkflowPyToolboxHost).__wfPyToolboxController) {
						(control as IWorkflowPyToolboxHost).__wfPyToolboxController!.refreshContext(resource);
					}
				}
			} catch (err) {
				console.error('[WorkflowPythonEditorToolboxContribution] Failed to attach toolbox:', err);
			}
		}, 30);
	}
}

registerWorkbenchContribution2(
	WorkflowPythonEditorToolboxContribution.ID,
	WorkflowPythonEditorToolboxContribution,
	WorkbenchPhase.AfterRestored
);


