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
	 * Set when the designer edits the own structure of one Freestyle ticket (stored in the ticket folder)
	 * instead of a template: changes are saved to that ticket only and no template is created.
	 */
	public freestyleTicketUri?: URI;

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
		if (this.freestyleTicketUri) {
			return `Ticket Structure: ${this.moduleName}`;
		}
		return this.isFlowchartNodeMode
			? `Node: ${this.moduleName}`
			: `Edit Module Schema: ${this.moduleName}`;
	}

	override getDescription(): string {
		if (this.freestyleTicketUri) {
			return 'Freestyle Ticket Components';
		}
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
