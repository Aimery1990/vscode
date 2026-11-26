/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../common/editor/editorInput.js';
import { IUntypedEditorInput } from '../../../common/editor.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ICustomModule } from '../../entityPersistence/common/entityPersistence.js';

/** Template module shown in preview mode; workflow-node views also carry `__wfNode`. */
export interface IEntityPreviewModule extends ICustomModule {
	__wfNode?: {
		nodeId?: string;
		nodeLabel: string;
		workflowName: string;
		workflowUri?: string;
		subWorkflowName?: string;
	};
}

const entityDetailEditorIcon = registerIcon('entity-detail-editor-label-icon', Codicon.info, 'Icon of the entity detail editor label.');

export class EntityDetailEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.entityDetail';

	private _resource: URI;
	private _name: string;

	constructor(
		public readonly entityUri: URI,
		public readonly entityName: string,
		public readonly startInEditMode?: boolean,
		public previewModule?: IEntityPreviewModule
	) {
		super();
		this._resource = URI.from({
			scheme: Schemas.vscodeEntityDetail,
			path: previewModule
				? `/preview/${encodeURIComponent(previewModule.id || entityName)}`
				: `/${encodeURIComponent(entityUri.toString())}/${encodeURIComponent(entityName)}`,
		});
		this._name = previewModule?.__wfNode
			? `Node: ${previewModule.name || entityName}`
			: previewModule
				? `Preview: ${previewModule.name || entityName} (Ticket)`
				: `${entityName} (Detail)`;
	}

	public updatePreviewModule(mod: IEntityPreviewModule): void {
		this.previewModule = mod;
		this._name = mod?.__wfNode ? `Node: ${mod.name || this.entityName}` : `Preview: ${mod.name || this.entityName} (Ticket)`;
		this._onDidChangeLabel.fire();
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
			if (this.previewModule && other.previewModule) {
				return String(this.previewModule.id || '').toLowerCase() === String(other.previewModule.id || '').toLowerCase();
			}
			if (!!this.previewModule !== !!other.previewModule) {
				return false;
			}
			return other.entityUri.toString() === this.entityUri.toString() &&
				(other.entityName || '').trim().toLowerCase() === (this.entityName || '').trim().toLowerCase();
		}
		return false;
	}
}
