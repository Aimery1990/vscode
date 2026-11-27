/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import { FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getComponentProps, getComponentSpec } from '../../common/componentRegistry.js';

/**
 * Run bookkeeping the runtime keeps on its own runtime-field type (not ICustomField configuration), plus the
 * identity properties every component has.
 */
const RUN_STATE_KEYS = new Set([
	'id', 'label', 'type',
	'lastExecutedAt', 'lastExecutedUrl', 'lastExecutionLog', 'lastExecutionStatus', 'lastExecutionOutput',
	'lastExecutionDurationMs', 'lastExecutionExitCode', 'lastSentPrompt', 'lastQueryRows', 'ttsLastAudioPath', 'ttsLastCacheKey'
]);

/**
 * Scans the compiled workflow runtime for `case '<type>':` blocks of the ticket run and of the node executor and
 * collects every `field.X` / `comp.X` read inside them. Each must be declared in that type's config schema (CI-32 /
 * CI-33 consistency: the registry cannot silently fall behind the runtime).
 */
suite('componentRegistry vs. runtime reads', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every property the runtime reads for a component type is declared in its spec', () => {
		const file = FileAccess.asFileUri('vs/workbench/contrib/workflowsManager/browser/ticketWorkflowRuntime.js').fsPath;
		const lines = fs.readFileSync(file, 'utf8').split('\n');
		const indentOf = (line: string) => line.length - line.trimStart().length;
		const caseRe = /^\s*case ['"]([a-z_]+)['"]:/;
		const problems: string[] = [];
		let checkedBlocks = 0;
		// Both component switches (ticket run and node executor) start with `case 'parameters':`
		const switchStarts = lines.map((line, idx) => /^\s*case ['"]parameters['"]:/.test(line) ? idx : -1).filter(idx => idx >= 0);
		for (const start of switchStarts) {
			const caseIndent = indentOf(lines[start]);
			let current: { type: string; declared: Set<string> } | undefined;
			for (let j = start; j < lines.length; j++) {
				const line = lines[j];
				if (!line.trim()) {
					continue;
				}
				const indent = indentOf(line);
				if (indent < caseIndent) {
					if (line.trim().startsWith('}')) {
						break; // end of the switch
					}
					continue; // e.g. a multi-line template string (embedded Python) written at column 0
				}
				if (indent === caseIndent) {
					const match = caseRe.exec(line);
					const spec = match ? getComponentSpec(match[1]) : undefined;
					current = spec ? { type: spec.type, declared: new Set<string>(getComponentProps(spec.type).map(p => p.name)) } : undefined;
					if (current) {
						checkedBlocks++;
					}
				}
				if (!current) {
					continue;
				}
				for (const read of line.matchAll(/\b(?:field|comp)\.([a-zA-Z]+)\b/g)) {
					if (!current.declared.has(read[1]) && !RUN_STATE_KEYS.has(read[1])) {
						problems.push(`${current.type}.${read[1]} (line ${j + 1})`);
					}
				}
			}
		}
		assert.ok(checkedBlocks >= 30, `only ${checkedBlocks} component blocks found; did the runtime layout change?`);
		assert.deepStrictEqual([...new Set(problems.map(p => p.replace(/ \(line \d+\)$/, '')))], [], `Undeclared runtime reads:\n${problems.join('\n')}`);
	});
});
