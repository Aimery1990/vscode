/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspacesExplorerService } from '../../workspacesExplorer/common/workspacesExplorer.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import {
	ICustomModule,
	ICompositeComponent,
	DEFAULT_STATUS_DEFINITIONS,
	getDefaultCustomModuleIconId,
	getDefaultCustomModuleColor
} from '../../entityPersistence/common/entityPersistence.js';
import { parseTemplateYaml } from '../common/templateYaml.js';
import { getReservedFreestyleNameMessage, getReservedTemplateNameError, isReservedFreestyleName, isReservedFreestyleTemplate } from '../common/freestyleTicket.js';
import { ICustomModulesService } from '../common/customModules.js';
import { CustomModuleSchemaEditorInput } from './customModuleSchemaEditorInput.js';
import { EntityDetailEditorInput } from '../../workspacesExplorer/browser/entityDetailEditorInput.js';

function formatYamlScalar(val: unknown): unknown {
	if (typeof val !== 'string') {
		return val;
	}
	if (
		val === '' ||
		val === 'true' ||
		val === 'false' ||
		val === 'null' ||
		val === '~' ||
		(!isNaN(Number(val)) && val.trim() !== '') ||
		/[\n\r:#,\[\]{}"'\\]|^[\s\-?]|[\s]$/.test(val)
	) {
		return JSON.stringify(val);
	}
	return val;
}

export function stringifyYaml(obj: unknown, indent = 0): string {
	const spacing = ' '.repeat(indent);
	if (Array.isArray(obj)) {
		if (obj.length === 0) { return ' []'; }
		let res = '';
		for (const item of obj) {
			if (typeof item === 'object' && item !== null) {
				const entries = Object.entries(item).filter(([_, v]) => v !== undefined);
				if (entries.length > 0) {
					const [firstK, firstV] = entries[0];
					if (typeof firstV === 'object' && firstV !== null) {
						const firstVStr = stringifyYaml(firstV, indent + 4);
						const formattedFirst = (firstVStr === ' []' || firstVStr === ' {}' || firstVStr.startsWith('\n')) ? firstVStr : (firstVStr ? '\n' + firstVStr : ' {}');
						res += `\n${spacing}- ${firstK}:${formattedFirst}`;
					} else {
						res += `\n${spacing}- ${firstK}: ${formatYamlScalar(firstV)}`;
					}
					for (let j = 1; j < entries.length; j++) {
						const [k, v] = entries[j];
						if (typeof v === 'object' && v !== null) {
							const subStr = stringifyYaml(v, indent + 4);
							const formattedSub = (subStr === ' []' || subStr === ' {}' || subStr.startsWith('\n')) ? subStr : (subStr ? '\n' + subStr : ' {}');
							res += `\n${spacing}  ${k}:${formattedSub}`;
						} else {
							res += `\n${spacing}  ${k}: ${formatYamlScalar(v)}`;
						}
					}
				}
			} else {
				res += `\n${spacing}- ${formatYamlScalar(item)}`;
			}
		}
		return res;
	} else if (typeof obj === 'object' && obj !== null) {
		const entries = Object.entries(obj).filter(([_, v]) => v !== undefined);
		if (entries.length === 0) { return ' {}'; }
		let res = '';
		for (const [k, v] of entries) {
			if (typeof v === 'object' && v !== null) {
				const subStr = stringifyYaml(v, indent + 2);
				const formattedSub = (subStr === ' []' || subStr === ' {}' || subStr.startsWith('\n')) ? subStr : (subStr ? '\n' + subStr : ' {}');
				res += `${res ? '\n' : ''}${spacing}${k}:${formattedSub}`;
			} else {
				res += `${res ? '\n' : ''}${spacing}${k}: ${formatYamlScalar(v)}`;
			}
		}
		return res;
	}
	return String(obj);
}

/** Plain JSON-like record used when sanitizing data before it is written to YAML. */
interface IPersistedRecord {
	[key: string]: unknown;
}

/** Editor panes (e.g. the entity detail editor) that can live-refresh a previewed module. */
interface IPreviewModuleRefreshable {
	refreshPreviewModule(mod: ICustomModule): Promise<void>;
}

function isPreviewModuleRefreshable(pane: unknown): pane is IPreviewModuleRefreshable {
	return !!pane && typeof (pane as Partial<IPreviewModuleRefreshable>).refreshPreviewModule === 'function';
}

export class CustomModulesService extends Disposable implements ICustomModulesService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeModules = this._register(new Emitter<void>());
	readonly onDidChangeModules: Event<void> = this._onDidChangeModules.event;

	private readonly defaultSystemModules: ICustomModule[] = [
		{ id: 'job', name: 'Job', icon: 'rocket', color: '#10b981', storageScope: 'global', description: 'System pre-configured Job module.' },
		{ id: 'project', name: 'Project', icon: 'project', color: '#6366f1', storageScope: 'global', description: 'System pre-configured Project module.' },
		{ id: 'task', name: 'Task', icon: 'checklist', color: '#3b82f6', storageScope: 'global', description: 'System pre-configured Task module.' },
		{ id: 'note', name: 'Note', icon: 'book', color: '#f59e0b', storageScope: 'global', description: 'System pre-configured Note module.' },
		{ id: 'workflow', name: 'Workflow', icon: 'github-action', color: '#8b5cf6', storageScope: 'global', description: 'System pre-configured Workflow module.' },
		{ id: 'case', name: 'Case', icon: 'beaker', color: '#ec4899', storageScope: 'global', description: 'System pre-configured Case module.' },
		{ id: 'agent', name: 'Agent', icon: 'robot', color: '#06b6d4', storageScope: 'global', description: 'System pre-configured Agent module.' },
		{ id: 'issue', name: 'Issue', icon: 'bug', color: '#ef4444', storageScope: 'global', description: 'System pre-configured Issue module.' },
		{ id: 'analysis', name: 'Analysis', icon: 'graph', color: '#14b8a6', storageScope: 'global', description: 'System pre-configured Analysis module.' }
	];

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IStorageService private readonly storageService: IStorageService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkspacesExplorerService private readonly workspacesExplorerService: IWorkspacesExplorerService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
		@IQuickInputService private readonly quickInputService: IQuickInputService
	) {
		super();
	}

	getSystemModules(): ICustomModule[] {
		return JSON.parse(JSON.stringify(this.defaultSystemModules));
	}

	public getGlobalEntityTypeDir(): URI {
		let savedPath = '~/.anyagent/entity_type';
		try {
			if (this.storageService) {
				savedPath = this.storageService.get('anyagent.globalEntityTypePath', StorageScope.PROFILE, '~/.anyagent/entity_type');
			}
		} catch (e) {
			console.error('Failed to read globalEntityTypePath setting:', e);
		}
		const userHome = this.environmentService.userHome.fsPath;
		const resolvedPath = (savedPath && savedPath.startsWith('~/')) ? userHome + savedPath.substring(1) : savedPath === '~' ? userHome : (savedPath || '~/.anyagent/entity_type');
		return URI.file(resolvedPath);
	}

	public getGlobalEntityComponentDir(): URI {
		let savedPath = '~/.anyagent/entity_component';
		try {
			if (this.storageService) {
				savedPath = this.storageService.get('anyagent.globalEntityComponentPath', StorageScope.PROFILE, '~/.anyagent/entity_component');
			}
		} catch (e) {
			console.error('Failed to read globalEntityComponentPath setting:', e);
		}
		const userHome = this.environmentService.userHome.fsPath;
		const resolvedPath = (savedPath && savedPath.startsWith('~/')) ? userHome + savedPath.substring(1) : savedPath === '~' ? userHome : (savedPath || '~/.anyagent/entity_component');
		return URI.file(resolvedPath);
	}

	private async _resolveTargetWorkspaceUri(workspaceUri?: URI): Promise<URI | undefined> {
		if (workspaceUri) {
			return workspaceUri;
		}
		try {
			const workspaces = await this.workspacesExplorerService.getWorkspaces();
			const current = workspaces.find(w => w.isCurrent) || workspaces[0];
			return current?.uri;
		} catch {
			return undefined;
		}
	}

	private async _ensureDirExists(dirUri: URI): Promise<void> {
		const parts: URI[] = [];
		let curr = dirUri;
		while (curr.path && curr.path !== '/') {
			parts.push(curr);
			const parent = dirname(curr);
			if (parent.path === curr.path) { break; }
			curr = parent;
		}
		parts.reverse();
		for (const p of parts) {
			try {
				if (!await this.fileService.exists(p)) {
					await this.fileService.createFolder(p);
				}
			} catch (e) {
				console.error(`Failed to create directory part: ${p.toString()}`, e);
			}
		}
	}

	/**
	 * Reads and parses a YAML file. The parsed content is untrusted: callers must validate
	 * the shape (e.g. `mod && mod.id`) before relying on it.
	 */
	private async _readYamlFile<T>(uri: URI): Promise<T | null> {
		try {
			const content = await this.fileService.readFile(uri);
			return parseTemplateYaml(content.value.toString()) as T | null;
		} catch (e) {
			console.error(`Error reading YAML from ${uri.toString()}:`, e);
			return null;
		}
	}

	private async _writeYamlFile(uri: URI, data: unknown): Promise<void> {
		try {
			const parentDir = dirname(uri);
			await this._ensureDirExists(parentDir);
			const yamlContent = stringifyYaml(data);
			await this.fileService.writeFile(uri, VSBuffer.fromString(yamlContent));
		} catch (e) {
			console.error('Error writing YAML file:', e);
			this.notificationService.error(`Failed to write custom module YAML file: ${e}`);
		}
	}

	private _ensureUniqueFieldIds(mod: ICustomModule): void {
		if (!mod || !Array.isArray(mod.fields)) {
			return;
		}
		mod.fields = mod.fields.filter(f => f && typeof f === 'object' && !Array.isArray(f));
		const usedIds = new Set<string>();
		for (let idx = 0; idx < mod.fields.length; idx++) {
			const f = mod.fields[idx];
			if (!f || typeof f !== 'object') {
				continue;
			}
			const rawId = (f.id || '').trim();
			const rawIdLower = rawId.toLowerCase();
			if (rawId && !usedIds.has(rawIdLower)) {
				usedIds.add(rawIdLower);
				continue;
			}
			const baseSlug = ((f.label || f.type || `field_${idx + 1}`).toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/^_+|_+$/g, '')) || `field_${idx + 1}`;
			let candidateId = baseSlug;
			let suffix = 2;
			while (usedIds.has(candidateId.toLowerCase())) {
				candidateId = `${baseSlug}_${suffix}`;
				suffix++;
			}
			f.id = candidateId;
			usedIds.add(candidateId.toLowerCase());
		}
	}

	private _sanitizeModuleForPersistence(mod: ICustomModule): IPersistedRecord {
		if (!mod || typeof mod !== 'object') {
			return mod;
		}
		const clone: IPersistedRecord = JSON.parse(JSON.stringify(mod));
		if (Array.isArray(clone.fields)) {
			const fields = clone.fields.filter((f: unknown): f is IPersistedRecord => !!f && typeof f === 'object' && !Array.isArray(f));
			clone.fields = fields;
			for (const f of fields) {
				delete f.lastSentPrompt;
				delete f.lastExecutionLog;
				delete f.lastExecutionOutput;
				delete f.lastExecutionStatus;
				delete f.lastExecutionDurationMs;
				delete f.lastExecutedAt;
				delete f.lastExecutionExitCode;
				delete f.pythonOutput;
				delete f.pythonResult;
				delete f.pythonStructuredData;
				delete f.structuredData;
				delete f.debugPromptOutput;
				delete f.debugSqlOutput;
				delete f.debugOutput;
				if (f.type === 'table' && (f.tableDbEngine || 'sqlite') === 'sqlite' && f.tableDbPath && String(f.tableDbPath).trim()) {
					f.tableRows = [];
				}
			}
		}
		return clone;
	}

	private _stripModuleTransientMeta(mod: ICustomModule): IPersistedRecord {
		if (!mod || typeof mod !== 'object') {
			return mod;
		}
		const clone = this._sanitizeModuleForPersistence(mod);
		delete clone.updatedAt;
		delete clone.storageScope;
		return clone;
	}

	async getCustomModules(workspaceUri?: URI): Promise<ICustomModule[]> {
		const targetUri = await this._resolveTargetWorkspaceUri(workspaceUri);
		const modulesMap = new Map<string, ICustomModule>();
		const pendingMigrations: { resource: URI; mod: ICustomModule }[] = [];

		try {
			const globalDir = this.getGlobalEntityTypeDir();
			if (await this.fileService.exists(globalDir)) {
				const stat = await this.fileService.resolve(globalDir, { resolveMetadata: true });
				if (stat.children) {
					const sortedChildren = [...stat.children].sort((a, b) => a.name.localeCompare(b.name));
					for (const child of sortedChildren) {
						if (!child.isDirectory && (child.name.endsWith('.yaml') || child.name.endsWith('.yml'))) {
							try {
								const mod = await this._readYamlFile<ICustomModule>(child.resource);
								if (mod && mod.id) {
									if (typeof mod.description !== 'string') {
										mod.description = '';
									}
									if (typeof mod.prompt !== 'string') {
										mod.prompt = '';
									}
									this._ensureUniqueFieldIds(mod);
									mod.storageScope = 'global';
									if (typeof mod.updatedAt !== 'number' || !Number.isFinite(mod.updatedAt)) {
										mod.updatedAt = (typeof child.mtime === 'number' && child.mtime > 0) ? child.mtime : 0;
									}
									if (!mod.icon || !mod.color) {
										pendingMigrations.push({ resource: child.resource, mod });
									}
									modulesMap.set(mod.id.toLowerCase(), mod);
								}
							} catch (fileErr) {
								console.error(`Error loading global module ${child.name}:`, fileErr);
							}
						}
					}
				}
			}
		} catch (e) {
			console.error('Error listing global entity types:', e);
		}

		if (targetUri) {
			const localDir = URI.joinPath(targetUri, '.agents', 'entity_type');
			const localDirPlural = URI.joinPath(targetUri, '.agents', 'entity_types');
			const parentLocalDir = URI.joinPath(dirname(targetUri), '.agents', 'entity_type');
			const checkDirs = [localDir, localDirPlural, parentLocalDir];

			for (const dir of checkDirs) {
				try {
					if (await this.fileService.exists(dir)) {
						const stat = await this.fileService.resolve(dir, { resolveMetadata: true });
						if (stat.children) {
							const sortedChildren = [...stat.children].sort((a, b) => a.name.localeCompare(b.name));
							for (const child of sortedChildren) {
								if (!child.isDirectory && (child.name.endsWith('.yaml') || child.name.endsWith('.yml'))) {
									try {
										const mod = await this._readYamlFile<ICustomModule>(child.resource);
										if (mod && mod.id) {
											if (!modulesMap.has(mod.id.toLowerCase())) {
												if (typeof mod.description !== 'string') {
													mod.description = '';
												}
												if (typeof mod.prompt !== 'string') {
													mod.prompt = '';
												}
												this._ensureUniqueFieldIds(mod);
												mod.storageScope = 'global';
												if (typeof mod.updatedAt !== 'number' || !Number.isFinite(mod.updatedAt)) {
													mod.updatedAt = (typeof child.mtime === 'number' && child.mtime > 0) ? child.mtime : 0;
												}
												if (!mod.icon || !mod.color) {
													pendingMigrations.push({ resource: child.resource, mod });
												}
												modulesMap.set(mod.id.toLowerCase(), mod);
											}
										}
									} catch (fileErr) {
										console.error(`Error loading local module ${child.name}:`, fileErr);
									}
								}
							}
						}
					}
				} catch (e) {
					console.error('Error listing local entity types:', e);
				}
			}
		}

		// One-time migration: ensure every loaded module has a permanently persisted icon and color in its YAML file
		if (pendingMigrations.length > 0) {
			const usedColors = new Set<string>();
			for (const m of modulesMap.values()) {
				if (m.icon && m.color) {
					usedColors.add(m.color.toLowerCase());
				}
			}
			for (const { resource, mod } of pendingMigrations) {
				const hadIcon = Boolean(mod.icon && String(mod.icon).trim());
				if (!hadIcon) {
					mod.icon = getDefaultCustomModuleIconId(mod.id);
				}
				const rawColor = (mod.color || '').trim();
				const isUnassignedLegacyDefault = !hadIcon && rawColor.toLowerCase() === '#38bdf8' && mod.id.toLowerCase() !== 'agent';
				if (!rawColor || isUnassignedLegacyDefault) {
					mod.color = getDefaultCustomModuleColor(mod.name || mod.id, usedColors);
				}
				usedColors.add(mod.color.toLowerCase());
				try {
					const toSave = this._sanitizeModuleForPersistence(mod);
					await this._writeYamlFile(resource, toSave);
				} catch (err) {
					console.error('Failed to persist initial icon/color migration:', err);
				}
			}
		}

		const result = Array.from(modulesMap.values());
		result.sort((a, b) => {
			const timeDiff = (b.updatedAt || 0) - (a.updatedAt || 0);
			if (timeDiff !== 0) {
				return timeDiff;
			}
			return (a.name || a.id).localeCompare(b.name || b.id);
		});
		return result;
	}

	/**
	 * "freestyle" is reserved for Freestyle tickets: returns the error for the first module that would be
	 * created with (or renamed to) a reserved id or name. A legacy template already stored with the same id
	 * and name is left alone so saving other changes keeps working.
	 */
	private async _findReservedTemplateNameError(modules: ICustomModule[], targetUri: URI | undefined): Promise<string | undefined> {
		const globalDir = this.getGlobalEntityTypeDir();
		for (const m of modules) {
			if (!isReservedFreestyleTemplate(m)) {
				continue;
			}
			const filename = `${m.id}.yaml`;
			const candidates = [
				...(targetUri ? [URI.joinPath(targetUri, '.agents', 'entity_type', filename)] : []),
				URI.joinPath(globalDir, filename)
			];
			let existing: ICustomModule | null = null;
			for (const candidate of candidates) {
				try {
					if (await this.fileService.exists(candidate)) {
						existing = await this._readYamlFile<ICustomModule>(candidate);
						if (existing) {
							break;
						}
					}
				} catch { }
			}
			const error = getReservedTemplateNameError(m, existing ? { id: m.id, name: typeof existing.name === 'string' ? existing.name : m.name } : undefined);
			if (error) {
				return error;
			}
		}
		return undefined;
	}

	async saveCustomModules(modules: ICustomModule[], workspaceUri?: URI): Promise<void> {
		const targetUri = await this._resolveTargetWorkspaceUri(workspaceUri);
		// Checked before anything is written or deleted; callers (UI and AI tools) get the error
		const reservedNameError = await this._findReservedTemplateNameError(modules, targetUri);
		if (reservedNameError) {
			this.notificationService.error(reservedNameError);
			throw new Error(reservedNameError);
		}
		try {
			const globalDir = this.getGlobalEntityTypeDir();
			const activeIdsLower = new Set(modules.map(m => m.id.toLowerCase()));
			let anyChanged = false;

			try {
				if (await this.fileService.exists(globalDir)) {
					const stat = await this.fileService.resolve(globalDir);
					if (stat.children) {
						for (const child of stat.children) {
							const id = child.name.replace(/\.yaml$|\.yml$/i, '').toLowerCase();
							if (!activeIdsLower.has(id)) {
								await this.fileService.del(child.resource);
								anyChanged = true;
							}
						}
					}
				}
			} catch { }

			if (targetUri) {
				const localDir = URI.joinPath(targetUri, '.agents', 'entity_type');
				try {
					if (await this.fileService.exists(localDir)) {
						const stat = await this.fileService.resolve(localDir);
						if (stat.children) {
							for (const child of stat.children) {
								const id = child.name.replace(/\.yaml$|\.yml$/i, '').toLowerCase();
								if (!activeIdsLower.has(id)) {
									await this.fileService.del(child.resource);
									anyChanged = true;
								}
							}
						}
					}
				} catch { }
			}

			for (const m of modules) {
				this._ensureUniqueFieldIds(m);
				if (!m.icon) {
					m.icon = getDefaultCustomModuleIconId(m.id);
				}
				if (!m.color) {
					m.color = getDefaultCustomModuleColor(m.name || m.id);
				}
				const filename = `${m.id}.yaml`;
				const primaryFile = (m.storageScope === 'workspace' && targetUri)
					? URI.joinPath(targetUri, '.agents', 'entity_type', filename)
					: URI.joinPath(globalDir, filename);

				let existingMod: ICustomModule | null = null;
				if (await this.fileService.exists(primaryFile)) {
					existingMod = await this._readYamlFile<ICustomModule>(primaryFile);
				}

				const isContentChanged = !existingMod ||
					JSON.stringify(this._stripModuleTransientMeta(m)) !== JSON.stringify(this._stripModuleTransientMeta(existingMod));

				if (!isContentChanged) {
					if (existingMod && typeof existingMod.updatedAt === 'number') {
						m.updatedAt = existingMod.updatedAt;
					}
					continue;
				}

				anyChanged = true;
				m.updatedAt = Date.now();

				const fileData = this._sanitizeModuleForPersistence(m);
				delete fileData.storageScope;

				if (m.storageScope === 'global') {
					const globalFile = URI.joinPath(globalDir, filename);
					await this._writeYamlFile(globalFile, { ...fileData, storageScope: 'global' });
					const localCandidateFiles: URI[] = [];
					if (targetUri) {
						localCandidateFiles.push(
							URI.joinPath(targetUri, '.agents', 'entity_type', filename),
							URI.joinPath(targetUri, '.agents', 'entity_types', filename),
							URI.joinPath(dirname(targetUri), '.agents', 'entity_type', filename)
						);
					}
					try {
						const allWorkspaces = await this.workspacesExplorerService.getWorkspaces();
						for (const ws of allWorkspaces) {
							localCandidateFiles.push(
								URI.joinPath(ws.uri, '.agents', 'entity_type', filename),
								URI.joinPath(ws.uri, '.agents', 'entity_types', filename),
								URI.joinPath(dirname(ws.uri), '.agents', 'entity_type', filename)
							);
						}
					} catch { }
					const visitedPaths = new Set<string>();
					for (const candidateFile of localCandidateFiles) {
						const key = candidateFile.toString();
						if (visitedPaths.has(key)) {
							continue;
						}
						visitedPaths.add(key);
						try {
							if (await this.fileService.exists(candidateFile)) {
								await this._writeYamlFile(candidateFile, { ...fileData, storageScope: 'global' });
							}
						} catch { }
					}
				} else if (targetUri) {
					const localFile = URI.joinPath(targetUri, '.agents', 'entity_type', filename);
					await this._writeYamlFile(localFile, { ...fileData, storageScope: 'workspace' });
				} else {
					const globalFile = URI.joinPath(globalDir, filename);
					await this._writeYamlFile(globalFile, { ...fileData, storageScope: 'global' });
				}
			}

			// Always notify listeners (such as CustomModulesPane) when saveCustomModules is called,
			// even if auto-persist already wrote the identical content moments earlier.
			this._onDidChangeModules.fire();
		} catch (e) {
			console.error('Error in saveCustomModules:', e);
			this.notificationService.error(`Failed to save custom modules: ${e}`);
		}
	}

	async deleteCustomModule(moduleId: string, workspaceUri?: URI): Promise<void> {
		const targetUri = await this._resolveTargetWorkspaceUri(workspaceUri);
		const globalDir = this.getGlobalEntityTypeDir();
		const targetIdLower = moduleId.toLowerCase();

		const candidateDirs: URI[] = [globalDir];
		if (targetUri) {
			candidateDirs.push(
				URI.joinPath(targetUri, '.agents', 'entity_type'),
				URI.joinPath(targetUri, '.agents', 'entity_types'),
				URI.joinPath(dirname(targetUri), '.agents', 'entity_type')
			);
		}
		try {
			const allWorkspaces = await this.workspacesExplorerService.getWorkspaces();
			for (const ws of allWorkspaces) {
				candidateDirs.push(
					URI.joinPath(ws.uri, '.agents', 'entity_type'),
					URI.joinPath(ws.uri, '.agents', 'entity_types')
				);
			}
		} catch { }

		for (const dir of candidateDirs) {
			try {
				if (await this.fileService.exists(dir)) {
					const stat = await this.fileService.resolve(dir);
					if (stat.children) {
						for (const child of stat.children) {
							if (!child.isDirectory && (child.name.endsWith('.yaml') || child.name.endsWith('.yml'))) {
								const fileBase = child.name.replace(/\.yaml$|\.yml$/i, '').toLowerCase();
								if (fileBase === targetIdLower) {
									await this.fileService.del(child.resource);
								}
							}
						}
					}
				}
			} catch { }
		}

		this._onDidChangeModules.fire();
	}

	async getCategories(): Promise<string[]> {
		const raw = this.storageService.get('customModules.categories', StorageScope.PROFILE, '[]');
		let stored: string[] = [];
		try {
			stored = JSON.parse(raw);
		} catch {
			stored = [];
		}
		if (!Array.isArray(stored)) {
			stored = [];
		}
		const catSet = new Set<string>(stored.filter(c => typeof c === 'string' && c.trim().length > 0));
		const modules = await this.getCustomModules();
		for (const m of modules) {
			if (m.category && typeof m.category === 'string' && m.category.trim()) {
				catSet.add(m.category.trim());
			}
		}
		return Array.from(catSet);
	}

	async addCategory(category: string): Promise<void> {
		const trimmed = (category || '').trim();
		if (!trimmed) { return; }
		const categories = await this.getCategories();
		if (!categories.includes(trimmed)) {
			categories.push(trimmed);
			this.storageService.store('customModules.categories', JSON.stringify(categories), StorageScope.PROFILE, StorageTarget.USER);
			this._onDidChangeModules.fire();
		}
	}

	async deleteCategory(category: string): Promise<void> {
		const trimmed = (category || '').trim();
		if (!trimmed) { return; }
		let categories = await this.getCategories();
		categories = categories.filter(c => c !== trimmed);
		this.storageService.store('customModules.categories', JSON.stringify(categories), StorageScope.PROFILE, StorageTarget.USER);

		const modules = await this.getCustomModules();
		let changed = false;
		for (const m of modules) {
			if (m.category === trimmed) {
				delete m.category;
				changed = true;
			}
		}
		if (changed) {
			await this.saveCustomModules(modules);
		} else {
			this._onDidChangeModules.fire();
		}
	}

	async renameCategory(oldName: string, newName: string): Promise<void> {
		const o = (oldName || '').trim();
		const n = (newName || '').trim();
		if (!o || !n || o === n) { return; }

		let categories = await this.getCategories();
		categories = categories.map(c => c === o ? n : c);
		if (!categories.includes(n)) {
			categories.push(n);
		}
		this.storageService.store('customModules.categories', JSON.stringify(categories), StorageScope.PROFILE, StorageTarget.USER);

		const modules = await this.getCustomModules();
		let changed = false;
		for (const m of modules) {
			if (m.category === o) {
				m.category = n;
				changed = true;
			}
		}
		if (changed) {
			await this.saveCustomModules(modules);
		} else {
			this._onDidChangeModules.fire();
		}
	}

	async setModuleCategory(moduleId: string, category?: string): Promise<void> {
		const cat = category?.trim() || undefined;
		const modules = await this.getCustomModules();
		const mod = modules.find(m => m.id.toLowerCase() === moduleId.toLowerCase());
		if (mod) {
			mod.category = cat;
			if (cat) {
				await this.addCategory(cat);
			}
			await this.saveCustomModules(modules);
		}
	}

	async getCompositeComponents(workspaceUri?: URI): Promise<ICompositeComponent[]> {
		const targetUri = await this._resolveTargetWorkspaceUri(workspaceUri);
		const componentsMap = new Map<string, ICompositeComponent>();

		try {
			const globalDir = this.getGlobalEntityComponentDir();
			if (await this.fileService.exists(globalDir)) {
				const stat = await this.fileService.resolve(globalDir);
				if (stat.children) {
					for (const child of stat.children) {
						if (!child.isDirectory && (child.name.endsWith('.yaml') || child.name.endsWith('.yml'))) {
							const comp = await this._readYamlFile<ICompositeComponent>(child.resource);
							if (comp && comp.id) {
								comp.storageScope = 'global';
								componentsMap.set(comp.id, comp);
							}
						}
					}
				}
			}
		} catch (e) {
			console.error('Error listing global entity components:', e);
		}

		if (targetUri) {
			const localDir = URI.joinPath(targetUri, '.agents', 'entity_component');
			const localDirPlural = URI.joinPath(targetUri, '.agents', 'entity_components');
			const parentLocalDir = URI.joinPath(dirname(targetUri), '.agents', 'entity_component');
			const checkDirs = [localDir, localDirPlural, parentLocalDir];

			for (const dir of checkDirs) {
				try {
					if (await this.fileService.exists(dir)) {
						const stat = await this.fileService.resolve(dir);
						if (stat.children) {
							for (const child of stat.children) {
								if (!child.isDirectory && (child.name.endsWith('.yaml') || child.name.endsWith('.yml'))) {
									const comp = await this._readYamlFile<ICompositeComponent>(child.resource);
									if (comp && comp.id) {
										if (!comp.storageScope) { comp.storageScope = 'workspace'; }
										componentsMap.set(comp.id, comp);
									}
								}
							}
						}
					}
				} catch (e) {
					console.error('Error listing local entity components:', e);
				}
			}
		}

		return Array.from(componentsMap.values());
	}

	async saveCompositeComponent(component: ICompositeComponent, workspaceUri?: URI): Promise<void> {
		const targetUri = await this._resolveTargetWorkspaceUri(workspaceUri);
		try {
			const globalDir = this.getGlobalEntityComponentDir();
			const filename = `${component.id}.yaml`;

			if (component.storageScope === 'workspace' && targetUri) {
				const localDir = URI.joinPath(targetUri, '.agents', 'entity_component');
				await this._writeYamlFile(URI.joinPath(localDir, filename), component);
			} else {
				await this._writeYamlFile(URI.joinPath(globalDir, filename), { ...component, storageScope: 'global' });
			}

			this._onDidChangeModules.fire();
		} catch (e) {
			console.error('Error in saveCompositeComponent:', e);
			this.notificationService.error(`Failed to save composite class: ${e}`);
		}
	}

	async deleteCompositeComponent(component: ICompositeComponent, workspaceUri?: URI): Promise<void> {
		const targetUri = await this._resolveTargetWorkspaceUri(workspaceUri);
		try {
			const globalDir = this.getGlobalEntityComponentDir();
			const filename = `${component.id}.yaml`;

			const globalFile = URI.joinPath(globalDir, filename);
			if (await this.fileService.exists(globalFile)) {
				await this.fileService.del(globalFile);
			}
			if (targetUri) {
				const localFile = URI.joinPath(targetUri, '.agents', 'entity_component', filename);
				if (await this.fileService.exists(localFile)) {
					await this.fileService.del(localFile);
				}
			}

			this._onDidChangeModules.fire();
		} catch (e) {
			console.error('Error in deleteCompositeComponent:', e);
		}
	}

	async openSchemaDesigner(options?: { targetModuleId?: string; workspaceUri?: URI; onUpdate?: () => void }): Promise<void> {
		const targetUri = await this._resolveTargetWorkspaceUri(options?.workspaceUri);

		let targetModuleId = options?.targetModuleId;
		let targetModuleName = '';
		let createdDraftModule: ICustomModule | undefined;

		if (targetModuleId) {
			const allMods = await this.getCustomModules(targetUri);
			const found = allMods.find(m => m.id.toLowerCase() === targetModuleId!.toLowerCase());
			if (found) {
				targetModuleName = found.name;
			} else {
				if (isReservedFreestyleName(targetModuleId)) {
					// Opening the designer on an unknown id would create that template
					this.notificationService.error(getReservedFreestyleNameMessage(targetModuleId));
					return;
				}
				targetModuleName = targetModuleId;
			}
		} else {
			// Creating a new module: only ask for module name via quick input
			const enteredName = await this.quickInputService.input({
				prompt: 'Enter new custom module name',
				placeHolder: 'e.g. Test, Release, Bug, Feature...',
				validateInput: async value => {
					const trimmed = value.trim();
					const candidateId = trimmed.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
					return isReservedFreestyleTemplate({ id: candidateId, name: trimmed }) ? getReservedFreestyleNameMessage(trimmed) : undefined;
				}
			});
			if (!enteredName || !enteredName.trim()) {
				return;
			}
			targetModuleName = enteredName.trim();
			targetModuleId = targetModuleName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
			if (isReservedFreestyleTemplate({ id: targetModuleId, name: targetModuleName })) {
				this.notificationService.error(getReservedFreestyleNameMessage(targetModuleName));
				return;
			}

			const allMods = await this.getCustomModules(targetUri);
			const existing = allMods.find(m => m.id.toLowerCase() === targetModuleId!.toLowerCase());
			if (!existing) {
				const usedColors = new Set(allMods.map(m => (m.color || '').toLowerCase()).filter(Boolean));
				createdDraftModule = {
					id: targetModuleId,
					name: targetModuleName,
					icon: getDefaultCustomModuleIconId(targetModuleId),
					color: getDefaultCustomModuleColor(targetModuleName, usedColors),
					storageScope: 'global',
					description: '',
					prompt: '',
					isDeprecated: false,
					fields: [
						{ id: 'title', label: 'Title', type: 'text', required: true }
					],
					statuses: JSON.parse(JSON.stringify(DEFAULT_STATUS_DEFINITIONS))
				};
				allMods.push(createdDraftModule);
				await this.saveCustomModules(allMods, targetUri);
			}
		}

		const editorInput = this.instantiationService.createInstance(
			CustomModuleSchemaEditorInput,
			targetModuleId,
			targetModuleName,
			targetUri
		);
		if (createdDraftModule) {
			editorInput.draftModule = JSON.parse(JSON.stringify(createdDraftModule));
		}

		await this.editorService.openEditor(editorInput, { pinned: true });

		if (options?.onUpdate) {
			options.onUpdate();
		}
	}

	async openModuleTicketPreview(moduleOrId: string | ICustomModule, workspaceUri?: URI): Promise<void> {
		const targetUri = await this._resolveTargetWorkspaceUri(workspaceUri);
		let resolvedModule: ICustomModule | undefined;

		if (typeof moduleOrId === 'string') {
			const allMods = await this.getCustomModules(targetUri);
			resolvedModule = allMods.find(m => m.id.toLowerCase() === moduleOrId.toLowerCase());
			if (!resolvedModule) {
				const sysMods = this.getSystemModules();
				resolvedModule = sysMods.find(m => m.id.toLowerCase() === moduleOrId.toLowerCase());
			}
		} else {
			resolvedModule = moduleOrId;
		}

		if (!resolvedModule) {
			this.notificationService.warn('Could not locate template module to preview.');
			return;
		}

		const clonedMod: ICustomModule = JSON.parse(JSON.stringify(resolvedModule));
		this._ensureUniqueFieldIds(clonedMod);
		const previewUri = URI.from({
			scheme: 'vscode-custom-module-preview',
			path: `/${encodeURIComponent(clonedMod.id || 'preview')}`
		});

		const existingInput = this.editorService.editors.find(
			ed => ed instanceof EntityDetailEditorInput &&
				ed.previewModule &&
				String(ed.previewModule.id || '').toLowerCase() === String(clonedMod.id || '').toLowerCase()
		) as EntityDetailEditorInput | undefined;

		if (existingInput) {
			existingInput.updatePreviewModule(clonedMod);
			const pane = await this.editorService.openEditor(existingInput, { pinned: true });
			if (isPreviewModuleRefreshable(pane)) {
				await pane.refreshPreviewModule(clonedMod);
			}
			return;
		}

		const previewInput = new EntityDetailEditorInput(
			previewUri,
			clonedMod.name || clonedMod.id,
			false,
			clonedMod
		);
		await this.editorService.openEditor(previewInput, { pinned: true });
	}
}

