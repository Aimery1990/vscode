/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';

const workflowEditorIcon = registerIcon('workflow-editor-label-icon', Codicon.githubAction, 'Icon of the workflow editor label.');

export class WorkflowEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.workflowEditor';

	private _resource: URI;
	private _name: string;

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton;
	}

	constructor(
		public readonly workflowUri: URI,
		public readonly workflowName: string
	) {
		super();
		this._resource = URI.from({
			scheme: 'vscode-workflow-editor',
			path: `/${encodeURIComponent(workflowUri.toString())}`,
		});
		this._name = `${workflowName} (Workflow)`;
	}

	override get typeId(): string {
		return WorkflowEditorInput.ID;
	}

	override get resource(): URI {
		return this._resource;
	}

	override getName(): string {
		return this._name;
	}

	override getIcon(): ThemeIcon {
		return workflowEditorIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (other instanceof WorkflowEditorInput) {
			return other.workflowUri.toString() === this.workflowUri.toString();
		}
		return false;
	}
}
