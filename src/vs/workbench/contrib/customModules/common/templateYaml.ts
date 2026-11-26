/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ICustomField, normalizeLegacyFieldTypes } from '../../entityPersistence/common/entityPersistence.js';

/** A value produced by {@link parseYaml}. */
export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export function parseYaml(yaml: string): unknown {
	const lines = yaml.split(/\r?\n/);
	let i = 0;

	function parseBlock(currentIndent: number): YamlValue {
		let isArray = false;
		const arrayResult: YamlValue[] = [];
		const objectResult: { [key: string]: YamlValue } = {};

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
				} else if (!content.startsWith('"') && !content.startsWith('\'') && content.includes(':')) {
					const colonIdx = content.indexOf(':');
					const k = content.substring(0, colonIdx).trim();
					let v: YamlValue = content.substring(colonIdx + 1).trim();
					if (!v) {
						i++;
						let nextNonEmptyIndent = -1;
						for (let kIdx = i; kIdx < lines.length; kIdx++) {
							const kl = lines[kIdx].trim();
							if (!kl || kl.startsWith('#')) { continue; }
							nextNonEmptyIndent = lines[kIdx].search(/\S/);
							break;
						}
						v = (nextNonEmptyIndent >= indent + 4) ? parseBlock(indent + 4) : '';
					} else {
						v = parseValue(v);
						i++;
					}
					const itemObj: { [key: string]: YamlValue } = { [k]: v };
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
							let nv: YamlValue = nextTrimmed.substring(nColon + 1).trim();
							if (!nv) {
								i++;
								let nextSubIndent = -1;
								for (let kIdx = i; kIdx < lines.length; kIdx++) {
									const kl = lines[kIdx].trim();
									if (!kl || kl.startsWith('#')) { continue; }
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
				let val: YamlValue = trimmed.substring(colonIdx + 1).trim();
				if (!val) {
					i++;
					let nextTopIndent = -1;
					for (let kIdx = i; kIdx < lines.length; kIdx++) {
						const kl = lines[kIdx].trim();
						if (!kl || kl.startsWith('#')) { continue; }
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

	function parseValue(val: string): YamlValue {
		if (val === 'true') { return true; }
		if (val === 'false') { return false; }
		if (val === 'null' || val === '~') { return null; }
		if (val === '[]') { return []; }
		if (val === '{}') { return {}; }
		if (!isNaN(Number(val)) && val.trim() !== '') { return Number(val); }
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))) {
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

/**
 * Parses a ticket template (entity type) YAML file into a plain object, renaming legacy component types
 * (e.g. `result` -> `output`). This is how every template loader reads template YAML.
 */
export function parseTemplateYaml(yaml: string): unknown {
	return normalizeLegacyFieldTypes(parseYaml(yaml));
}

/** The template's `fields` (its components), or `[]` when the template has none / is not an object. */
export function getTemplateFields(template: unknown): ICustomField[] {
	if (!template || typeof template !== 'object' || Array.isArray(template)) {
		return [];
	}
	const fields = (template as { fields?: unknown }).fields;
	return Array.isArray(fields) ? fields.filter((f): f is ICustomField => !!f && typeof f === 'object' && !Array.isArray(f)) : [];
}

/**
 * Finds the template component a caller refers to by its label (preferred, ticket values are stored under the label)
 * or by its id. Matching is case-sensitive unless `ignoreCase` is set; `type` restricts the search to one component type.
 */
export function findTemplateField(fields: readonly ICustomField[], key: string, options?: { type?: string; ignoreCase?: boolean }): ICustomField | undefined {
	const norm = (s: unknown): string | undefined => typeof s === 'string' ? (options?.ignoreCase ? s.toLowerCase() : s) : undefined;
	const wanted = norm(key.trim());
	if (!wanted) {
		return undefined;
	}
	const candidates = options?.type ? fields.filter(f => f.type === options.type) : fields;
	return candidates.find(f => norm(f.label) === wanted) ?? candidates.find(f => norm(f.id) === wanted);
}
