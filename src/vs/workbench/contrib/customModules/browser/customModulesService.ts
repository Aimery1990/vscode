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
import { ICustomModule, ICompositeComponent } from '../../entityPersistence/common/entityPersistence.js';
import { ICustomModulesService } from '../common/customModules.js';
import { CustomModuleSchemaEditorInput } from './customModuleSchemaEditorInput.js';

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
					let firstVStr = '';
					if (typeof firstV === 'object' && firstV !== null) {
						firstVStr = stringifyYaml(firstV, indent + 4);
						res += `\n${spacing}- ${firstK}:${firstVStr}`;
					} else {
						const valFormatted = typeof firstV === 'string' && (firstV.includes('\n') || firstV.includes(':') || firstV.startsWith('#') || firstV.includes(',') || firstV.includes('[') || firstV.includes(']'))
							? JSON.stringify(firstV)
							: firstV;
						res += `\n${spacing}- ${firstK}: ${valFormatted}`;
					}
					for (let j = 1; j < entries.length; j++) {
						const [k, v] = entries[j];
						if (typeof v === 'object' && v !== null) {
							res += `\n${spacing}  ${k}:${stringifyYaml(v, indent + 4)}`;
						} else {
							const valFormatted = typeof v === 'string' && (v.includes('\n') || v.includes(':') || v.startsWith('#') || v.includes(',') || v.includes('[') || v.includes(']'))
								? JSON.stringify(v)
								: v;
							res += `\n${spacing}  ${k}: ${valFormatted}`;
						}
					}
				}
			} else {
				res += `\n${spacing}- ${item}`;
			}
		}
		return res;
	} else if (typeof obj === 'object' && obj !== null) {
		let res = '';
		for (const [k, v] of Object.entries(obj)) {
			if (v === undefined) continue;
			if (typeof v === 'object' && v !== null) {
				res += `${res ? '\n' : ''}${spacing}${k}:${stringifyYaml(v, indent + 2)}`;
			} else {
				const valStr = typeof v === 'string' && (v.includes('\n') || v.includes(':') || v.startsWith('#') || v.includes(',') || v.includes('[') || v.includes(']'))
					? JSON.stringify(v)
					: v;
				res += `${res ? '\n' : ''}${spacing}${k}: ${valStr}`;
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
				} else if (content.includes(':')) {
					const colonIdx = content.indexOf(':');
					const k = content.substring(0, colonIdx).trim();
					let v: any = content.substring(colonIdx + 1).trim();
					if (!v) {
						i++;
						v = parseBlock(indent + 4);
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
								nv = parseBlock(nextIndent + 2);
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
					val = parseBlock(indent + 2);
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
		{ id: 'job', name: 'Job', color: '#10b981', storageScope: 'global', description: 'System pre-configured Job module.' },
		{ id: 'project', name: 'Project', color: '#6366f1', storageScope: 'global', description: 'System pre-configured Project module.' },
		{ id: 'task', name: 'Task', color: '#3b82f6', storageScope: 'global', description: 'System pre-configured Task module.' },
		{ id: 'note', name: 'Note', color: '#f59e0b', storageScope: 'global', description: 'System pre-configured Note module.' },
		{ id: 'workflow', name: 'Workflow', color: '#8b5cf6', storageScope: 'global', description: 'System pre-configured Workflow module.' },
		{ id: 'case', name: 'Case', color: '#ec4899', storageScope: 'global', description: 'System pre-configured Case module.' },
		{ id: 'agent', name: 'Agent', color: '#06b6d4', storageScope: 'global', description: 'System pre-configured Agent module.' },
		{ id: 'issue', name: 'Issue', color: '#ef4444', storageScope: 'global', description: 'System pre-configured Issue module.' },
		{ id: 'analysis', name: 'Analysis', color: '#14b8a6', storageScope: 'global', description: 'System pre-configured Analysis module.' }
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

	async getCustomModules(workspaceUri?: URI): Promise<ICustomModule[]> {
		const targetUri = await this._resolveTargetWorkspaceUri(workspaceUri);
		const modulesMap = new Map<string, ICustomModule>();

		try {
			const globalDir = this.getGlobalEntityTypeDir();
			if (await this.fileService.exists(globalDir)) {
				const stat = await this.fileService.resolve(globalDir);
				if (stat.children) {
					for (const child of stat.children) {
						if (!child.isDirectory && (child.name.endsWith('.yaml') || child.name.endsWith('.yml'))) {
							const mod = await this._readYamlFile(child.resource);
							if (mod && mod.id) {
								mod.storageScope = 'global';
								modulesMap.set(mod.id.toLowerCase(), mod);
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
						const stat = await this.fileService.resolve(dir);
						if (stat.children) {
							for (const child of stat.children) {
								if (!child.isDirectory && (child.name.endsWith('.yaml') || child.name.endsWith('.yml'))) {
									const mod = await this._readYamlFile(child.resource);
									if (mod && mod.id) {
										if (!modulesMap.has(mod.id.toLowerCase())) {
											mod.storageScope = 'global';
											modulesMap.set(mod.id.toLowerCase(), mod);
										}
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

		return Array.from(modulesMap.values());
	}

	async saveCustomModules(modules: ICustomModule[], workspaceUri?: URI): Promise<void> {
		const targetUri = await this._resolveTargetWorkspaceUri(workspaceUri);
		try {
			const globalDir = this.getGlobalEntityTypeDir();
			const activeIds = new Set(modules.map(m => m.id));

			try {
				if (await this.fileService.exists(globalDir)) {
					const stat = await this.fileService.resolve(globalDir);
					if (stat.children) {
						for (const child of stat.children) {
							const id = child.name.replace(/\.yaml$|\.yml$/i, '');
							if (!activeIds.has(id)) {
								await this.fileService.del(child.resource);
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
								const id = child.name.replace(/\.yaml$|\.yml$/i, '');
								if (!activeIds.has(id)) {
									await this.fileService.del(child.resource);
								}
							}
						}
					}
				} catch {}
			}

			for (const m of modules) {
				const fileData = { ...m };
				delete fileData.storageScope;
				const filename = `${m.id}.yaml`;

				if (m.storageScope === 'global') {
					const globalFile = URI.joinPath(globalDir, filename);
					await this._writeYamlFile(globalFile, { ...fileData, storageScope: 'global' });
					if (targetUri) {
						const localFile = URI.joinPath(targetUri, '.agents', 'entity_type', filename);
						await this._writeYamlFile(localFile, { ...fileData, storageScope: 'global' });
					}
				} else if (targetUri) {
					const localFile = URI.joinPath(targetUri, '.agents', 'entity_type', filename);
					await this._writeYamlFile(localFile, { ...fileData, storageScope: 'workspace' });
				} else {
					const globalFile = URI.joinPath(globalDir, filename);
					await this._writeYamlFile(globalFile, { ...fileData, storageScope: 'global' });
				}
			}

			this._onDidChangeModules.fire();
		} catch (e) {
			console.error('Error in saveCustomModules:', e);
			this.notificationService.error(`Failed to save custom modules: ${e}`);
		}
	}

	async deleteCustomModule(moduleId: string, workspaceUri?: URI): Promise<void> {
		const targetUri = await this._resolveTargetWorkspaceUri(workspaceUri);
		const globalDir = this.getGlobalEntityTypeDir();
		const filename = `${moduleId}.yaml`;

		try {
			const globalFile = URI.joinPath(globalDir, filename);
			if (await this.fileService.exists(globalFile)) {
				await this.fileService.del(globalFile);
			}
		} catch {}

		if (targetUri) {
			const localFile = URI.joinPath(targetUri, '.agents', 'entity_type', filename);
			try {
				if (await this.fileService.exists(localFile)) {
					await this.fileService.del(localFile);
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

		if (targetModuleId) {
			const allMods = await this.getCustomModules(targetUri);
			const found = allMods.find(m => m.id.toLowerCase() === targetModuleId!.toLowerCase());
			if (found) {
				targetModuleName = found.name;
			} else {
				targetModuleName = targetModuleId;
			}
		} else {
			// Creating a new module: ask for module name via quick input
			const enteredName = await this.quickInputService.input({
				prompt: 'Enter new custom module name',
				placeHolder: 'e.g. Test, Release, Bug, Feature...'
			});
			if (!enteredName || !enteredName.trim()) {
				return;
			}
			targetModuleName = enteredName.trim();
			targetModuleId = targetModuleName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
		}

		const editorInput = this.instantiationService.createInstance(
			CustomModuleSchemaEditorInput,
			targetModuleId,
			targetModuleName,
			targetUri
		);

		await this.editorService.openEditor(editorInput, { pinned: true });

		if (options?.onUpdate) {
			options.onUpdate();
		}
	}
}

