/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Sub-Workflow Live View
 *
 * Opens the user's real workflow canvas (the regular Workflow Editor) in a side editor group, focused on a
 * single Sub-Workflow: only that Sub-Workflow's nodes are shown, with their live run states. The focused
 * editor shares the in-memory flowchart data with any other open editor of the same workflow, so inspecting
 * or editing capsules there is the same as doing it on the main canvas.
 *
 * It is opened automatically whenever a workflow starts invoking a Sub-Workflow, and can be reopened from the
 * caller node's context menu or the "Show Sub-Workflow Live View" command.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
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

/**
 * A Workflow Editor input focused on one Sub-Workflow of `workflowUri`. Resolved by the regular Workflow Editor
 * (it is a `WorkflowEditorInput` subclass); the editor detects `subWorkflowId` and only renders that region.
 */
export class SubWorkflowCanvasEditorInput extends WorkflowEditorInput {
	static readonly CANVAS_ID = 'workbench.input.subWorkflowCanvasEditor';

	private readonly _focusResource: URI;

	constructor(
		workflowUri: URI,
		workflowName: string,
		public readonly subWorkflowId: string,
		public readonly subWorkflowName: string
	) {
		super(workflowUri, workflowName);
		this._focusResource = URI.from({
			scheme: 'vscode-subworkflow-canvas',
			path: `/${encodeURIComponent(workflowUri.toString())}/${encodeURIComponent(subWorkflowId)}`
		});
	}

	override get typeId(): string {
		return SubWorkflowCanvasEditorInput.CANVAS_ID;
	}

	override get resource(): URI {
		return this._focusResource;
	}

	override getName(): string {
		return localize('subWorkflowCanvasName', "{0} (Sub-Workflow)", this.subWorkflowName);
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof SubWorkflowCanvasEditorInput
			&& other.subWorkflowId === this.subWorkflowId
			&& other.workflowUri.toString() === this.workflowUri.toString();
	}
}

/** Restores open Sub-Workflow canvas tabs on start-up (same identity fields as the constructor). */
class SubWorkflowCanvasEditorInputSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof SubWorkflowCanvasEditorInput;
	}

	serialize(input: EditorInput): string | undefined {
		if (!(input instanceof SubWorkflowCanvasEditorInput)) {
			return undefined;
		}
		return JSON.stringify({
			workflowUri: input.workflowUri.toString(),
			workflowName: input.workflowName,
			subWorkflowId: input.subWorkflowId,
			subWorkflowName: input.subWorkflowName
		});
	}

	deserialize(_instantiationService: IInstantiationService, raw: string): SubWorkflowCanvasEditorInput | undefined {
		try {
			const data = JSON.parse(raw);
			if (typeof data?.workflowUri !== 'string' || typeof data?.subWorkflowId !== 'string') {
				return undefined;
			}
			return new SubWorkflowCanvasEditorInput(URI.parse(data.workflowUri), data.workflowName || 'Workflow', data.subWorkflowId, data.subWorkflowName || data.subWorkflowId);
		} catch {
			return undefined;
		}
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(SubWorkflowCanvasEditorInput.CANVAS_ID, SubWorkflowCanvasEditorInputSerializer);

/**
 * Opens (or reveals) the focused Sub-Workflow canvas in an editor group other than the one showing the parent
 * workflow, so both canvases stay side by side. With `onlyIfNotOpen`, does nothing if it is already open.
 */
export async function openSubWorkflowLiveView(
	editorService: IEditorService,
	editorGroupsService: IEditorGroupsService,
	workflowExecutionService: IWorkflowExecutionService,
	subWorkflowId: string,
	options?: { parentWorkflowUri?: string; onlyIfNotOpen?: boolean; preserveFocus?: boolean; group?: () => number }
): Promise<SubWorkflowCanvasEditorInput> {
	const subDef = workflowExecutionService.getSubWorkflowById(subWorkflowId);
	const sourceUriStr = subDef?.sourceWorkflowUri || options?.parentWorkflowUri;
	if (!sourceUriStr) {
		throw new Error(localize('swlvNoSource', "Cannot locate the workflow that contains Sub-Workflow '{0}'.", subDef?.name || subWorkflowId));
	}
	const sourceUri = URI.parse(sourceUriStr);
	const sourceName = subDef?.sourceWorkflowName || decodeURIComponent(sourceUri.path.replace(/\/+$/, '').split('/').pop() || 'Workflow');
	const input = new SubWorkflowCanvasEditorInput(sourceUri, sourceName, subWorkflowId, subDef?.name || subWorkflowId);

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

	// Prefer a group that does not show the parent workflow canvas, else create a side group
	const parentUriStr = options?.parentWorkflowUri || sourceUriStr;
	const parentGroup = editorGroupsService.groups.find(g => g.editors.some(e => e instanceof WorkflowEditorInput && !(e instanceof SubWorkflowCanvasEditorInput) && e.workflowUri.toString() === parentUriStr));
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
