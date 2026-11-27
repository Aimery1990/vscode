/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../common/editor/editorInput.js';
import { IUntypedEditorInput, EditorInputCapabilities } from '../../../common/editor.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { localize } from '../../../../nls.js';
import { Emitter } from '../../../../base/common/event.js';
import { ICustomModule, ICustomField } from '../../entityPersistence/common/entityPersistence.js';

export const customModulesViewIcon = registerIcon(
	'custom-modules-view-icon',
	Codicon.layout,
	localize('customModulesViewIcon', 'View icon of the Custom Modules & Data Types view.')
);

export class CustomModuleSchemaEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.customModuleSchema';

	private readonly _resource: URI;
	public draftModule?: ICustomModule;
	public isFlowchartNodeMode?: boolean;
	public nodeId?: string;
	public workflowVariablesProvider?: () => Array<{ label: string; type: string; ticketType?: string }>;
	public workflowRuntimeContextProvider?: () => Record<string, unknown>;
	/** Same variables as `workflowRuntimeContextProvider`, with large spilled variables (`__anyagentVarRef__`) loaded back to their real values. */
	public hydratedWorkflowRuntimeContextProvider?: () => Promise<Record<string, unknown>>;
	public subWorkflowRefreshProvider?: (subWorkflowId: string) => Promise<{
		name: string;
		inputs: Array<{ name: string; defaultValue?: string; description?: string }>;
		outputs: Array<{ label: string; varName: string; defaultFormat?: string }>;
	} | undefined>;
	public onNodeFieldsChange?: (fields: ICustomField[], immediate?: boolean) => void;
	public focusFieldId?: string;
	/**
	 * Embedded single-component mode: the designer is hosted inside another page (not as an editor tab) and shows
	 * only the configuration of this component of `draftModule`. The designer never saves in this mode; edits stay
	 * in `draftModule` and the host saves them.
	 */
	public embeddedFieldId?: string;
	/**
	 * Embedded mode opened from a ticket: the media fields of the `embeddedFieldId` component in `draftModule` hold
	 * the ticket's current media (not the structure's default), and the host applies a changed file to the ticket.
	 */
	public embeddedTicketMedia?: boolean;

	private readonly _onDidUpdateExternalDraft = this._register(new Emitter<string | undefined>());
	public readonly onDidUpdateExternalDraft = this._onDidUpdateExternalDraft.event;

	public notifyExternalDraftUpdated(focusFieldId?: string): void {
		this.focusFieldId = focusFieldId;
		this._onDidUpdateExternalDraft.fire(focusFieldId);
	}

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton;
	}

	constructor(
		public readonly moduleId: string,
		public moduleName: string,
		public readonly workspaceUri?: URI
	) {
		super();
		this._resource = URI.from({
			scheme: 'vscode-custom-module-schema',
			path: `/${encodeURIComponent(moduleId)}`
		});
	}

	override get typeId(): string {
		return CustomModuleSchemaEditorInput.ID;
	}

	override get resource(): URI {
		return this._resource;
	}

	override getName(): string {
		return this.isFlowchartNodeMode
			? `Node: ${this.moduleName}`
			: `Edit Module Schema: ${this.moduleName}`;
	}

	override getDescription(): string {
		return this.isFlowchartNodeMode ? 'Flowchart Node Components' : 'Schema Designer';
	}

	override getIcon(): ThemeIcon {
		return customModulesViewIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (other instanceof CustomModuleSchemaEditorInput) {
			return other.moduleId.toLowerCase() === this.moduleId.toLowerCase();
		}
		return false;
	}
}
