/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';

const entityDetailEditorIcon = registerIcon('entity-detail-editor-label-icon', Codicon.info, 'Icon of the entity detail editor label.');

export class EntityDetailEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.entityDetail';

	private _resource: URI;
	private _name: string;

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton;
	}

	constructor(
		public readonly entityUri: URI,
		public readonly entityName: string
	) {
		super();
		this._resource = URI.from({
			scheme: Schemas.vscodeEntityDetail,
			path: `/${encodeURIComponent(entityUri.toString())}`,
		});
		this._name = `${entityName} (Detail)`;
	}

	override get typeId(): string {
		return EntityDetailEditorInput.ID;
	}

	override get resource(): URI {
		return this._resource;
	}

	override getName(): string {
		return this._name;
	}

	override getIcon(): ThemeIcon {
		return entityDetailEditorIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (other instanceof EntityDetailEditorInput) {
			return other.entityUri.toString() === this.entityUri.toString();
		}
		return false;
	}
}
