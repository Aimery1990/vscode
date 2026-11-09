/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
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
import { ICustomModulesService } from '../common/customModules.js';
import { CustomModuleSchemaEditorInput } from './customModuleSchemaEditorInput.js';
import { EntityDetailEditorInput } from '../../workspacesExplorer/browser/entityDetailEditorInput.js';

function formatYamlScalar(val: any): any {
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

export function stringifyYaml(obj: any, indent = 0): string {
	const spacing = ' '.repeat(indent);
	if (Array.isArray(obj)) {
		if (obj.length === 0) return ' []';
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
		if (entries.length === 0) return ' {}';
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

export function parseYaml(yaml: string): any {
	const lines = yaml.split(/\r?\n/);
	let i = 0;

	function parseBlock(currentIndent: number): any {
		let isArray = false;
		const arrayResult: any[] = [];
		const objectResult: any = {};

		while (i < lines.length) {
			const line = lines[i];
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) {
				i++;
				continue;
			}

			const indent = line.search(/\S/);
			if (indent < currentIndent) {
				break;
			}

			if (trimmed.startsWith('- ')) {
				isArray = true;
				const content = trimmed.substring(2).trim();
				if (!content) {
					i++;
					const child = parseBlock(indent + 2);
					arrayResult.push(child);
				} else if (!content.startsWith('"') && !content.startsWith("'") && content.includes(':')) {
					const colonIdx = content.indexOf(':');
					const k = content.substring(0, colonIdx).trim();
					let v: any = content.substring(colonIdx + 1).trim();
					if (!v) {
						i++;
						let nextNonEmptyIndent = -1;
						for (let kIdx = i; kIdx < lines.length; kIdx++) {
							const kl = lines[kIdx].trim();
							if (!kl || kl.startsWith('#')) continue;
							nextNonEmptyIndent = lines[kIdx].search(/\S/);
							break;
						}
						v = (nextNonEmptyIndent >= indent + 4) ? parseBlock(indent + 4) : '';
					} else {
						v = parseValue(v);
						i++;
					}
					const itemObj: any = { [k]: v };
					while (i < lines.length) {
						const nextLine = lines[i];
						const nextTrimmed = nextLine.trim();
						if (!nextTrimmed || nextTrimmed.startsWith('#')) {
							i++;
							continue;
						}
						const nextIndent = nextLine.search(/\S/);
						if (nextIndent <= indent) {
							break;
						}
						if (nextTrimmed.startsWith('- ')) {
							break;
						}
						const nColon = nextTrimmed.indexOf(':');
						if (nColon !== -1) {
							const nk = nextTrimmed.substring(0, nColon).trim();
							let nv: any = nextTrimmed.substring(nColon + 1).trim();
							if (!nv) {
								i++;
								let nextSubIndent = -1;
								for (let kIdx = i; kIdx < lines.length; kIdx++) {
									const kl = lines[kIdx].trim();
									if (!kl || kl.startsWith('#')) continue;
									nextSubIndent = lines[kIdx].search(/\S/);
									break;
								}
								nv = (nextSubIndent > nextIndent) ? parseBlock(nextIndent + 2) : '';
							} else {
								nv = parseValue(nv);
								i++;
							}
							itemObj[nk] = nv;
						} else {
							i++;
						}
					}
					arrayResult.push(itemObj);
				} else {
					arrayResult.push(parseValue(content));
					i++;
				}
			} else {
				const colonIdx = trimmed.indexOf(':');
				if (colonIdx === -1) {
					i++;
					continue;
				}
				const key = trimmed.substring(0, colonIdx).trim();
				let val: any = trimmed.substring(colonIdx + 1).trim();
				if (!val) {
					i++;
					let nextTopIndent = -1;
					for (let kIdx = i; kIdx < lines.length; kIdx++) {
						const kl = lines[kIdx].trim();
						if (!kl || kl.startsWith('#')) continue;
						nextTopIndent = lines[kIdx].search(/\S/);
						break;
					}
					val = (nextTopIndent > indent) ? parseBlock(indent + 2) : '';
				} else {
					val = parseValue(val);
					i++;
				}
				objectResult[key] = val;
			}
		}

		return isArray ? arrayResult : objectResult;
	}

	function parseValue(val: string): any {
		if (val === 'true') return true;
		if (val === 'false') return false;
		if (val === 'null' || val === '~') return null;
		if (val === '[]') return [];
		if (val === '{}') return {};
		if (!isNaN(Number(val)) && val.trim() !== '') return Number(val);
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			try { return JSON.parse(val); } catch { return val.slice(1, -1); }
		}
		return val;
	}

	try {
		return parseBlock(0);
	} catch {
		return {};
	}
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
			if (parent.path === curr.path) break;
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

	private async _readYamlFile(uri: URI): Promise<any> {
		try {
			const content = await this.fileService.readFile(uri);
			return parseYaml(content.value.toString());
		} catch (e) {
			console.error(`Error reading YAML from ${uri.toString()}:`, e);
			return null;
		}
	}

	private async _writeYamlFile(uri: URI, data: any): Promise<void> {
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

	private _sanitizeModuleForPersistence(mod: any): any {
		if (!mod || typeof mod !== 'object') {
			return mod;
		}
		const clone = JSON.parse(JSON.stringify(mod));
		if (Array.isArray(clone.fields)) {
			clone.fields = clone.fields.filter((f: any) => f && typeof f === 'object' && !Array.isArray(f));
			for (const f of clone.fields) {
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

	private _stripModuleTransientMeta(mod: any): any {
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
								const mod = await this._readYamlFile(child.resource);
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
										const mod = await this._readYamlFile(child.resource);
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

	async saveCustomModules(modules: ICustomModule[], workspaceUri?: URI): Promise<void> {
		const targetUri = await this._resolveTargetWorkspaceUri(workspaceUri);
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
			} catch {}

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
				} catch {}
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

				let existingMod: any = null;
				if (await this.fileService.exists(primaryFile)) {
					existingMod = await this._readYamlFile(primaryFile);
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
					} catch {}
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
						} catch {}
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
		} catch {}

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
			} catch {}
		}

		this._onDidChangeModules.fire();
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
							const comp = await this._readYamlFile(child.resource);
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
									const comp = await this._readYamlFile(child.resource);
									if (comp && comp.id) {
										if (!comp.storageScope) comp.storageScope = 'workspace';
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
				targetModuleName = targetModuleId;
			}
		} else {
			// Creating a new module: only ask for module name via quick input
			const enteredName = await this.quickInputService.input({
				prompt: 'Enter new custom module name',
				placeHolder: 'e.g. Test, Release, Bug, Feature...'
			});
			if (!enteredName || !enteredName.trim()) {
				return;
			}
			targetModuleName = enteredName.trim();
			targetModuleId = targetModuleName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

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
			if (pane && typeof (pane as any).refreshPreviewModule === 'function') {
				await (pane as any).refreshPreviewModule(clonedMod);
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

