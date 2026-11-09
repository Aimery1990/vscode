/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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
	public workflowRuntimeContextProvider?: () => Record<string, any>;
	public onNodeFieldsChange?: (fields: ICustomField[]) => void;
	public focusFieldId?: string;

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
