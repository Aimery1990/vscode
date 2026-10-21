/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../common/editor/editorInput.js';
import { IUntypedEditorInput, EditorInputCapabilities } from '../../../common/editor.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { customModulesViewIcon } from './customModules.contribution.js';
import { ICustomModule } from '../../entityPersistence/common/entityPersistence.js';

export class CustomModuleSchemaEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.customModuleSchema';

	private readonly _resource: URI;
	public draftModule?: ICustomModule;

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
		return `Edit Module Schema: ${this.moduleName}`;
	}

	override getDescription(): string {
		return 'Schema Designer';
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
