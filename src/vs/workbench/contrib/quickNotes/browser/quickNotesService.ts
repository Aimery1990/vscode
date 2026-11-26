/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { AuthenticationSession, AuthenticationSessionAccount, IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IQuickNoteAttachment, IQuickNoteItem, IQuickNotesService, QuickNoteStatus } from '../common/quickNotes.js';

const STORAGE_KEY_PREFIX = 'anyagent.quickNotes.items';
const KEEP_VOICE_AUDIO_STORAGE_KEY = 'anyagent.quickNotes.keepVoiceAudio';

export class QuickNotesService extends Disposable implements IQuickNotesService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeNotes = this._register(new Emitter<void>());
	readonly onDidChangeNotes: Event<void> = this._onDidChangeNotes.event;

	private readonly _onDidCreateNote = this._register(new Emitter<IQuickNoteItem>());
	readonly onDidCreateNote: Event<IQuickNoteItem> = this._onDidCreateNote.event;

	private notes: IQuickNoteItem[] = [];
	private activeUserEmail: string = '';
	private hasResolvedInitialUser = false;
	private readonly preInitCreatedNoteIds = new Set<string>();

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService
	) {
		super();

		this._register(this.authenticationService.onDidChangeSessions(async () => {
			await this.updateActiveUser();
		}));

		this._register(this.authenticationService.onDidRegisterAuthenticationProvider(async () => {
			await this.updateActiveUser();
		}));

		void this.updateActiveUser();
	}

	private getStorageKey(userEmail?: string): string {
		const id = (userEmail !== undefined ? userEmail : this.activeUserEmail) || 'unauthenticated';
		return `${STORAGE_KEY_PREFIX}:${id}`;
	}

	private loadFromStorage(userEmail?: string): IQuickNoteItem[] {
		try {
			const raw = this.storageService.get(this.getStorageKey(userEmail), StorageScope.PROFILE);
			if (!raw) {
				return [];
			}
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) {
				return [];
			}
			return parsed.filter((item): item is IQuickNoteItem =>
				item && typeof item === 'object' && typeof item.id === 'string' && typeof item.content === 'string'
			);
		} catch {
			return [];
		}
	}

	private saveToStorage(): void {
		try {
			this.storageService.store(
				this.getStorageKey(),
				JSON.stringify(this.notes),
				StorageScope.PROFILE,
				StorageTarget.USER
			);
		} catch {
			// Ignore storage quota / serialization errors
		}
	}

	private async updateActiveUser(): Promise<void> {
		try {
			const providers = ['google', 'github', 'microsoft', 'apple', ...this.authenticationService.declaredProviders.map(p => p.id)];
			const uniqueProviders = Array.from(new Set(providers));

			const sessionPromises = uniqueProviders.map(async providerId => {
				let timeoutId: ReturnType<typeof setTimeout> | undefined;
				try {
					const sessionsPromise = this.authenticationService.getSessions(providerId, undefined, undefined, true);
					const timeoutPromise = new Promise<readonly AuthenticationSession[]>(resolve => {
						timeoutId = setTimeout(() => resolve([]), 5000);
					});
					const sessions = await Promise.race([sessionsPromise, timeoutPromise]);
					if (timeoutId !== undefined) {
						clearTimeout(timeoutId);
					}
					if (sessions && sessions.length > 0) {
						return { providerId, session: sessions[0] };
					}
				} catch {
					if (timeoutId !== undefined) {
						clearTimeout(timeoutId);
					}
				}
				return null;
			});

			const results = await Promise.all(sessionPromises);
			const activeResult = results.find(r => r !== null && r !== undefined);
			let newUserIdentifier = '';

			if (activeResult) {
				// Some providers attach an `email` to the account at runtime.
				const account: AuthenticationSessionAccount & { readonly email?: string } = activeResult.session.account;
				const label = account.label || account.email || '';
				const match = label.match(/\(([^)]+)\)/);
				newUserIdentifier = (match ? match[1] : label).trim().toLowerCase();
			}

			const prevUser = this.activeUserEmail;
			const isColdInit = !this.hasResolvedInitialUser;
			this.hasResolvedInitialUser = true;

			if (isColdInit || newUserIdentifier !== prevUser) {
				const pendingSessionNotes = isColdInit
					? this.notes.filter(n => this.preInitCreatedNoteIds.has(n.id))
					: [];
				this.preInitCreatedNoteIds.clear();

				this.activeUserEmail = newUserIdentifier;
				const storedNotes = this.loadFromStorage(newUserIdentifier);

				// Clean up any stale empty notes left in the unauthenticated bucket so they never resurrect
				if (newUserIdentifier) {
					const unauthNotes = this.loadFromStorage('');
					const nonEmptyUnauth = unauthNotes.filter(n => n.content.trim().length > 0 || (n.attachments && n.attachments.length > 0));
					if (nonEmptyUnauth.length !== unauthNotes.length) {
						if (nonEmptyUnauth.length === 0) {
							this.storageService.remove(this.getStorageKey(''), StorageScope.PROFILE);
						} else {
							this.storageService.store(
								this.getStorageKey(''),
								JSON.stringify(nonEmptyUnauth),
								StorageScope.PROFILE,
								StorageTarget.USER
							);
						}
					}
				}

				if (pendingSessionNotes.length > 0) {
					const existingIds = new Set(storedNotes.map(n => n.id));
					const topStoredIsEmptyTodo = storedNotes.length > 0 && storedNotes[0].content.trim() === '' && (!storedNotes[0].attachments || storedNotes[0].attachments.length === 0) && storedNotes[0].status === 'todo';
					const toMerge = pendingSessionNotes.filter(n => {
						if (existingIds.has(n.id)) {
							return false;
						}
						// Avoid stacking a redundant empty note on top of an already empty top note
						if (topStoredIsEmptyTodo && n.content.trim() === '' && (!n.attachments || n.attachments.length === 0) && n.status === 'todo') {
							return false;
						}
						return true;
					});
					this.notes = [...toMerge, ...storedNotes];
					if (toMerge.length > 0) {
						this.saveToStorage();
					}
				} else {
					this.notes = storedNotes;
				}
				this._onDidChangeNotes.fire();
			}
		} catch {
			this.hasResolvedInitialUser = true;
		}
	}

	getNotes(): readonly IQuickNoteItem[] {
		return this.notes;
	}

	createNote(initialContent: string = ''): IQuickNoteItem {
		const now = Date.now();
		const note: IQuickNoteItem = {
			id: generateUuid(),
			content: initialContent,
			status: 'todo',
			createdAt: now,
			updatedAt: now
		};
		// Newest note is always placed at the top
		this.notes.unshift(note);
		if (!this.hasResolvedInitialUser) {
			this.preInitCreatedNoteIds.add(note.id);
		} else {
			this.saveToStorage();
		}
		this._onDidChangeNotes.fire();
		this._onDidCreateNote.fire(note);
		return note;
	}

	updateNote(id: string, content: string): void {
		const note = this.notes.find(n => n.id === id);
		if (!note) {
			return;
		}
		if (note.content === content) {
			return;
		}
		note.content = content;
		note.updatedAt = Date.now();
		this.saveToStorage();
	}

	updateNoteStatus(id: string, status: QuickNoteStatus): void {
		const note = this.notes.find(n => n.id === id);
		if (!note) {
			return;
		}
		if (note.status === status) {
			return;
		}
		note.status = status;
		note.updatedAt = Date.now();
		this.saveToStorage();
		this._onDidChangeNotes.fire();
	}

	addAttachment(noteId: string, attachment: Omit<IQuickNoteAttachment, 'id' | 'createdAt'>): IQuickNoteAttachment | undefined {
		const note = this.notes.find(n => n.id === noteId);
		if (!note) {
			return undefined;
		}
		const newAttachment: IQuickNoteAttachment = {
			...attachment,
			id: generateUuid(),
			createdAt: Date.now()
		};
		if (!Array.isArray(note.attachments)) {
			note.attachments = [];
		}
		note.attachments.push(newAttachment);
		note.updatedAt = Date.now();
		if (this.hasResolvedInitialUser) {
			this.saveToStorage();
		}
		this._onDidChangeNotes.fire();
		return newAttachment;
	}

	removeAttachment(noteId: string, attachmentId: string): void {
		const note = this.notes.find(n => n.id === noteId);
		if (!note || !Array.isArray(note.attachments)) {
			return;
		}
		const idx = note.attachments.findIndex(a => a.id === attachmentId);
		if (idx === -1) {
			return;
		}
		note.attachments.splice(idx, 1);
		note.updatedAt = Date.now();
		if (this.hasResolvedInitialUser) {
			this.saveToStorage();
		}
		this._onDidChangeNotes.fire();
	}

	getKeepVoiceAudio(): boolean {
		return this.storageService.getBoolean(KEEP_VOICE_AUDIO_STORAGE_KEY, StorageScope.PROFILE, false);
	}

	setKeepVoiceAudio(keep: boolean): void {
		this.storageService.store(KEEP_VOICE_AUDIO_STORAGE_KEY, keep, StorageScope.PROFILE, StorageTarget.USER);
	}

	deleteNote(id: string): void {
		const index = this.notes.findIndex(n => n.id === id);
		if (index === -1) {
			return;
		}
		this.notes.splice(index, 1);
		this.saveToStorage();
		this._onDidChangeNotes.fire();
	}

	clearAllNotes(): void {
		if (this.notes.length === 0) {
			return;
		}
		this.notes = [];
		this.saveToStorage();
		this._onDidChangeNotes.fire();
	}
}
