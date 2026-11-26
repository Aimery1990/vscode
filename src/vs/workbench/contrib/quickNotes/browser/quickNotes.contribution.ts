/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainer, ViewContainerLocation } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import {
	IQuickNotesService,
	QUICK_NOTES_CLEAR_ALL_COMMAND_ID,
	QUICK_NOTES_CONTAINER_ID,
	QUICK_NOTES_NEW_COMMAND_ID,
	QUICK_NOTES_VIEW_ID
} from '../common/quickNotes.js';
import { QuickNotesPane } from './quickNotesPane.js';
import { QuickNotesService } from './quickNotesService.js';

// 1. Register Quick Notes Service
registerSingleton(IQuickNotesService, QuickNotesService, InstantiationType.Delayed);

// 2. Register Icon
const quickNotesIcon = registerIcon(
	'quick-notes-view-icon',
	Codicon.note,
	localize('quickNotesIcon', 'View icon of the Quick Notes panel.')
);

// 3. Register View Container in the Right Side Panel (Auxiliary Bar)
const viewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: QUICK_NOTES_CONTAINER_ID,
	title: localize2('quickNotes', "Quick Notes"),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [QUICK_NOTES_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: 'workbench.quickNotes.views.state',
	icon: quickNotesIcon,
	hideIfEmpty: false,
	order: 10
}, ViewContainerLocation.AuxiliaryBar);

// 4. Register Quick Notes View Pane
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

const viewDescriptor: IViewDescriptor = {
	id: QUICK_NOTES_VIEW_ID,
	name: localize2('quickNotes', "Quick Notes"),
	ctorDescriptor: new SyncDescriptor(QuickNotesPane),
	order: 1,
	canToggleVisibility: true,
	canMoveView: true,
	containerIcon: quickNotesIcon
};

viewsRegistry.registerViews([viewDescriptor], viewContainer);

async function createAndFocusQuickNote(accessor: ServicesAccessor): Promise<void> {
	const quickNotesService = accessor.get(IQuickNotesService);
	const viewsService = accessor.get(IViewsService);

	const note = quickNotesService.createNote();
	const view = await viewsService.openView<QuickNotesPane>(QUICK_NOTES_VIEW_ID, true);
	if (view) {
		view.focusNote(note.id);
	}
}

// 5. Register Top Toolbar Action (Right next to the Browser globe icon in MenuId.TitleBar)
registerAction2(class NewQuickNoteTitleBarAction extends Action2 {
	constructor() {
		super({
			id: QUICK_NOTES_NEW_COMMAND_ID,
			title: localize2('quickNotes.titleBarAction', "Quick Notes: New Note"),
			icon: Codicon.note,
			f1: true,
			menu: {
				id: MenuId.TitleBar,
				group: 'navigation',
				order: 11
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await createAndFocusQuickNote(accessor);
	}
});

// 6. Register Panel Header Actions: Add Note (+) and Clear All
registerAction2(class AddQuickNoteViewAction extends Action2 {
	constructor() {
		super({
			id: `${QUICK_NOTES_NEW_COMMAND_ID}.viewTitle`,
			title: localize2('quickNotes.addNote', "New Note"),
			icon: Codicon.add,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', QUICK_NOTES_VIEW_ID),
				group: 'navigation',
				order: 1
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await createAndFocusQuickNote(accessor);
	}
});

registerAction2(class ClearAllQuickNotesAction extends Action2 {
	constructor() {
		super({
			id: QUICK_NOTES_CLEAR_ALL_COMMAND_ID,
			title: localize2('quickNotes.clearAll', "Clear All Notes"),
			icon: Codicon.clearAll,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', QUICK_NOTES_VIEW_ID),
				group: 'navigation',
				order: 2
			}
		});
	}

	run(accessor: ServicesAccessor): void {
		const quickNotesService = accessor.get(IQuickNotesService);
		quickNotesService.clearAllNotes();
	}
});
