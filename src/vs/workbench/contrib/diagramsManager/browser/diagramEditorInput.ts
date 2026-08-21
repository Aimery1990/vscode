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

export const diagramEditorIcon = registerIcon('diagram-editor-label-icon', Codicon.graph, 'Icon of the diagram editor label.');

export class DiagramEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.diagramEditor';

	private _resource: URI;
	private _name: string;
	public readonly isPureDiagram: boolean = true;

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton;
	}

	constructor(
		public readonly diagramUri: URI,
		public readonly diagramName: string
	) {
		super();
		this._resource = URI.from({
			scheme: 'vscode-diagram-editor',
			path: `/${encodeURIComponent(diagramUri.toString())}`,
		});
		this._name = `${diagramName} (Diagram)`;
	}

	override get typeId(): string {
		return DiagramEditorInput.ID;
	}

	override get resource(): URI {
		return this._resource;
	}

	override getName(): string {
		return this._name;
	}

	override getIcon(): ThemeIcon {
		return diagramEditorIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (other instanceof DiagramEditorInput) {
			return other.diagramUri.toString() === this.diagramUri.toString();
		}
		return false;
	}
}
