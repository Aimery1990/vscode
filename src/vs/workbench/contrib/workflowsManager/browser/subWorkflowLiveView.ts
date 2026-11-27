/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Sub-Workflow canvas (CI-23)
 *
 * A Sub-Workflow ticket is an independent workflow with its own canvas: opening it (from the explorer, the
 * Sub-Workflow Library, a Call Sub-Workflow step, or this module's command) shows its definition
 * (`.agents/sub_workflow.json`) in the regular Workflow Editor, editable like any workflow. Saving writes the
 * definition back, and every caller runs that latest version.
 *
 * The same canvas is the live view of a running call: it opens automatically whenever a workflow starts invoking a
 * Sub-Workflow, showing the call's live node states.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { ISubWorkflowDefinition } from '../common/workflowExecutionModel.js';
import { IWorkflowExecutionService } from '../common/workflowExecutionService.js';
import { WorkflowEditorInput } from './workflowEditorInput.js';

const RUN_STATUS_TEXT: Record<string, string> = {
	idle: 'Idle',
	running: 'Running',
	paused: 'Paused',
	waiting_human: 'Waiting for input',
	completed: 'Completed',
	failed: 'Failed',
	stopped: 'Stopped'
};

/** Command that opens a Sub-Workflow's own canvas; argument: its ticket ID (or legacy id), or its ticket folder URI. */
export const OPEN_SUB_WORKFLOW_COMMAND_ID = 'workbench.action.workflowsManager.openSubWorkflow';

/**
 * The Workflow Editor input of a Sub-Workflow ticket's own canvas. `workflowUri` is the ticket folder; the editor
 * reads and writes `<ticket folder>/.agents/sub_workflow.json` instead of a workflow flowchart file.
 */
export class SubWorkflowCanvasEditorInput extends WorkflowEditorInput {
	static readonly CANVAS_ID = 'workbench.input.subWorkflowCanvasEditor';

	private readonly _canvasResource: URI;

	constructor(
		ticketFolderUri: URI,
		public readonly subWorkflowName: string
	) {
		super(ticketFolderUri, subWorkflowName);
		this._canvasResource = URI.from({
			scheme: 'vscode-subworkflow-canvas',
			path: `/${encodeURIComponent(ticketFolderUri.toString())}`
		});
	}

	/** The Sub-Workflow ticket folder. */
	get ticketFolderUri(): URI {
		return this.workflowUri;
	}

	override get typeId(): string {
		return SubWorkflowCanvasEditorInput.CANVAS_ID;
	}

	override get resource(): URI {
		return this._canvasResource;
	}

	override getName(): string {
		return localize('subWorkflowCanvasName', "{0} (Sub-Workflow)", this.subWorkflowName);
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof SubWorkflowCanvasEditorInput && other.ticketFolderUri.toString() === this.ticketFolderUri.toString();
	}
}

/** Restores open Sub-Workflow canvas tabs on start-up. Tabs of the former "focused region of the parent canvas" view are dropped. */
class SubWorkflowCanvasEditorInputSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof SubWorkflowCanvasEditorInput;
	}

	serialize(input: EditorInput): string | undefined {
		if (!(input instanceof SubWorkflowCanvasEditorInput)) {
			return undefined;
		}
		return JSON.stringify({ ticketFolderUri: input.ticketFolderUri.toString(), subWorkflowName: input.subWorkflowName });
	}

	deserialize(_instantiationService: IInstantiationService, raw: string): SubWorkflowCanvasEditorInput | undefined {
		try {
			const data: unknown = JSON.parse(raw);
			if (!data || typeof data !== 'object') {
				return undefined;
			}
			const folder: unknown = Reflect.get(data, 'ticketFolderUri');
			const name: unknown = Reflect.get(data, 'subWorkflowName');
			if (typeof folder !== 'string' || !folder) {
				return undefined;
			}
			return new SubWorkflowCanvasEditorInput(URI.parse(folder), typeof name === 'string' && name ? name : 'Sub-Workflow');
		} catch {
			return undefined;
		}
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(SubWorkflowCanvasEditorInput.CANVAS_ID, SubWorkflowCanvasEditorInputSerializer);

/** The canvas input of a Sub-Workflow, by ticket ID (or legacy id). Throws for an unknown or not migrated one. */
async function resolveCanvasInput(workflowExecutionService: IWorkflowExecutionService, subWorkflowId: string): Promise<SubWorkflowCanvasEditorInput> {
	const def = await workflowExecutionService.resolveSubWorkflow(subWorkflowId);
	if (!def) {
		throw new Error(localize('swcvNotFound', "Sub-Workflow '{0}' was not found: no sub_workflow ticket with this ID.", subWorkflowId));
	}
	if (!def.ticketFolderUri) {
		throw new Error(localize('swcvLegacy', "Sub-Workflow '{0}' ({1}) is not a ticket yet: its migration has not finished. Try again after a restart.", def.name, def.id));
	}
	return new SubWorkflowCanvasEditorInput(URI.parse(def.ticketFolderUri), def.name);
}

/** Opens a Sub-Workflow ticket folder's own canvas in the active group (the explorer / ticket page entry point). */
export async function openSubWorkflowTicketCanvas(editorService: IEditorService, ticketFolderUri: URI, name: string): Promise<void> {
	await editorService.openEditor(new SubWorkflowCanvasEditorInput(ticketFolderUri, name), { pinned: true });
}

/**
 * Opens (or reveals) a Sub-Workflow's own canvas, by ticket ID, in an editor group other than the one showing the
 * calling workflow, so both canvases stay side by side. With `onlyIfNotOpen`, does nothing if it is already open.
 */
export async function openSubWorkflowLiveView(
	editorService: IEditorService,
	editorGroupsService: IEditorGroupsService,
	workflowExecutionService: IWorkflowExecutionService,
	subWorkflowId: string,
	options?: { parentWorkflowUri?: string; onlyIfNotOpen?: boolean; preserveFocus?: boolean; group?: () => number }
): Promise<SubWorkflowCanvasEditorInput> {
	const input = await resolveCanvasInput(workflowExecutionService, subWorkflowId);

	const existing = editorService.findEditors(input.resource);
	if (existing.length > 0) {
		if (!options?.onlyIfNotOpen) {
			await editorService.openEditor(existing[0].editor, { pinned: true, preserveFocus: options?.preserveFocus ?? true }, existing[0].groupId);
		}
		return existing[0].editor as SubWorkflowCanvasEditorInput;
	}

	// Caller-chosen group (e.g. a new split below the canvas), created only when the view is not open yet
	if (options?.group) {
		await editorService.openEditor(input, { pinned: true, preserveFocus: options.preserveFocus ?? true }, options.group());
		return input;
	}

	// Prefer a group that does not show the calling workflow canvas, else create a side group
	const parentUriStr = options?.parentWorkflowUri;
	const parentGroup = parentUriStr ? editorGroupsService.groups.find(g => g.editors.some(e => e instanceof WorkflowEditorInput && e.workflowUri.toString() === parentUriStr)) : undefined;
	const parentGroupId = parentGroup ? parentGroup.id : editorGroupsService.activeGroup.id;
	const sideGroup = editorGroupsService.groups.find(g => g.id !== parentGroupId);
	await editorService.openEditor(input, { pinned: true, preserveFocus: options?.preserveFocus ?? true }, sideGroup ? sideGroup.id : SIDE_GROUP);
	return input;
}

// ---------------------------------------------------------------------------------------------
// Auto-open whenever a workflow starts invoking a Sub-Workflow
// ---------------------------------------------------------------------------------------------

class SubWorkflowLiveViewAutoOpenContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.subWorkflowLiveViewAutoOpen';

	private readonly _seenRunIds = new Set<string>();

	constructor(
		@IWorkflowExecutionService private readonly _workflowExecutionService: IWorkflowExecutionService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService
	) {
		super();
		this._register(this._workflowExecutionService.onDidChangeSubWorkflowRun(run => {
			if (!run.subWorkflowId || this._seenRunIds.has(run.runId)) {
				return;
			}
			this._seenRunIds.add(run.runId);
			if (this._seenRunIds.size > 500) {
				this._seenRunIds.delete(this._seenRunIds.values().next().value as string);
			}
			if (run.status !== 'running') {
				return;
			}
			// Open once per Sub-Workflow call; if the user closes the tab mid-run it stays closed until the next call
			openSubWorkflowLiveView(this._editorService, this._editorGroupsService, this._workflowExecutionService, run.subWorkflowId, {
				parentWorkflowUri: run.parentWorkflowUri,
				onlyIfNotOpen: true,
				preserveFocus: true
			}).catch(err => console.error('[SubWorkflowLiveView] Failed to open live view:', err));
		}));
	}
}

registerWorkbenchContribution2(SubWorkflowLiveViewAutoOpenContribution.ID, SubWorkflowLiveViewAutoOpenContribution, WorkbenchPhase.AfterRestored);

// ---------------------------------------------------------------------------------------------
// Legacy Sub-Workflow migration at startup (not on the first read of the library)
// ---------------------------------------------------------------------------------------------

class SubWorkflowStartupMigrationContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.subWorkflowStartupMigration';

	constructor(
		@IWorkflowExecutionService workflowExecutionService: IWorkflowExecutionService,
		@ILogService logService: ILogService
	) {
		super();
		// Idempotent: each legacy id is migrated once (stored), the profile-storage backup is kept, failures are retried
		workflowExecutionService.migrateLegacySubWorkflows()
			.catch(err => logService.error('[WorkflowExecution] Sub-Workflow startup migration failed:', err));
	}
}

registerWorkbenchContribution2(SubWorkflowStartupMigrationContribution.ID, SubWorkflowStartupMigrationContribution, WorkbenchPhase.AfterRestored);

registerAction2(class OpenSubWorkflowAction extends Action2 {
	constructor() {
		super({
			id: OPEN_SUB_WORKFLOW_COMMAND_ID,
			title: localize2('openSubWorkflow', "Open Sub-Workflow"),
			category: localize2('workflowsCategory', "Workflows"),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor, target?: string): Promise<void> {
		const workflowExecutionService = accessor.get(IWorkflowExecutionService);
		const editorService = accessor.get(IEditorService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		try {
			const ref = (typeof target === 'string' ? target : '').trim();
			if (ref.includes('://')) {
				const folderUri = URI.parse(ref);
				const def = await workflowExecutionService.loadSubWorkflowTicket(folderUri);
				await openSubWorkflowTicketCanvas(editorService, folderUri, def?.name || folderUri.path.split('/').filter(Boolean).pop() || 'Sub-Workflow');
				return;
			}
			let id = ref;
			if (!id) {
				await workflowExecutionService.whenSubWorkflowsReady();
				const items: (IQuickPickItem & { def: ISubWorkflowDefinition })[] = workflowExecutionService.getSubWorkflows().map(def => ({ label: def.name, description: def.id, def }));
				const picked = await quickInputService.pick(items, { placeHolder: localize('swcvPick', "Select a Sub-Workflow to open") });
				id = picked?.def.id || '';
			}
			if (id) {
				await editorService.openEditor(await resolveCanvasInput(workflowExecutionService, id), { pinned: true });
			}
		} catch (err) {
			notificationService.error(err instanceof Error ? err.message : String(err));
		}
	}
});

registerAction2(class ShowSubWorkflowLiveViewAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.workflowsManager.showSubWorkflowLiveView',
			title: localize2('showSubWorkflowLiveView', "Show Sub-Workflow Live View"),
			category: localize2('workflowsCategory', "Workflows"),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor, subWorkflowId?: string): Promise<void> {
		const workflowExecutionService = accessor.get(IWorkflowExecutionService);
		const editorService = accessor.get(IEditorService);
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const quickInputService = accessor.get(IQuickInputService);

		let target: ISubWorkflowDefinition | undefined = subWorkflowId ? workflowExecutionService.getSubWorkflowById(subWorkflowId) : undefined;
		if (!target) {
			const items: (IQuickPickItem & { def: ISubWorkflowDefinition })[] = workflowExecutionService.getSubWorkflows().map(def => {
				const run = workflowExecutionService.getActiveSubWorkflowRun(def.id);
				return {
					label: def.name,
					description: run ? `${RUN_STATUS_TEXT[run.status] || run.status} · ${new Date(run.startedAt).toLocaleString()}` : localize('swlvNeverRun', "not run yet"),
					detail: run?.callerNodeLabel ? localize('swlvPickCaller', "Last called by \"{0}\"", run.callerNodeLabel) : undefined,
					def
				};
			});
			const picked = await quickInputService.pick(items, { placeHolder: localize('swlvPickPlaceholder', "Select a Sub-Workflow to watch") });
			target = picked?.def;
		}
		if (target) {
			const run = workflowExecutionService.getActiveSubWorkflowRun(target.id);
			await openSubWorkflowLiveView(editorService, editorGroupsService, workflowExecutionService, target.id, { parentWorkflowUri: run?.parentWorkflowUri, preserveFocus: false });
		}
	}
});
