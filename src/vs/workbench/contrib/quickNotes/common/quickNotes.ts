/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const QUICK_NOTES_CONTAINER_ID = 'workbench.view.quickNotes';
export const QUICK_NOTES_VIEW_ID = 'workbench.view.quickNotes.pane';

export const QUICK_NOTES_NEW_COMMAND_ID = 'workbench.action.quickNotes.newNote';
export const QUICK_NOTES_CLEAR_ALL_COMMAND_ID = 'workbench.action.quickNotes.clearAll';

export type QuickNoteStatus = 'todo' | 'doing' | 'done';

export interface IQuickNoteAttachment {
	readonly id: string;
	readonly kind: 'image' | 'audio';
	readonly name?: string;
	readonly mimeType: string;
	readonly dataUrl: string;
	readonly durationSeconds?: number;
	readonly createdAt: number;
}

export interface IQuickNoteItem {
	readonly id: string;
	content: string;
	status?: QuickNoteStatus;
	attachments?: IQuickNoteAttachment[];
	readonly createdAt: number;
	updatedAt: number;
}

export const IQuickNotesService = createDecorator<IQuickNotesService>('quickNotesService');

export interface IQuickNotesService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeNotes: Event<void>;
	readonly onDidCreateNote: Event<IQuickNoteItem>;

	getNotes(): readonly IQuickNoteItem[];
	createNote(initialContent?: string): IQuickNoteItem;
	updateNote(id: string, content: string): void;
	updateNoteStatus(id: string, status: QuickNoteStatus): void;
	addAttachment(noteId: string, attachment: Omit<IQuickNoteAttachment, 'id' | 'createdAt'>): IQuickNoteAttachment | undefined;
	removeAttachment(noteId: string, attachmentId: string): void;
	getKeepVoiceAudio(): boolean;
	setKeepVoiceAudio(keep: boolean): void;
	deleteNote(id: string): void;
	clearAllNotes(): void;
}
