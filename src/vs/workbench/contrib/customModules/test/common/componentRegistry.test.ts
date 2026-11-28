/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICustomField, normalizeFieldType } from '../../../entityPersistence/common/entityPersistence.js';
import { BASE_COMPONENT_PALETTE } from '../../common/componentPalette.js';
import {
	COMMON_COMPONENT_PROPS, COMPONENT_SPECS, NODE_PALETTE_ORDER, TEMPLATE_PALETTE_ORDER, buildAiBasePrimitives, buildPrimitivesCatalog,
	CARD_OUTPUT_RULES, describeAiConfigProps, describeOutput, documentedOutputName, documentedOutputs, getAiConfigProps, getAiTemplateComponentTypes, getAllComponentSpecs, getComponentConfig,
	getComponentProps, getComponentSpec, getNodeComponentPalette, getPrimitiveGuide, getSecretPropNames
} from '../../common/componentRegistry.js';
import { validateComponentConfig } from '../../common/componentConfigSchema.js';

/** Types that publish no `{var}` of their own (Inputs publish one variable per input; Display publishes nothing). */
const NO_VAR_OUTPUT = new Set(['parameters', 'output', 'display']);

suite('componentRegistry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every component type has a complete spec (description, config schema, outputs, help)', () => {
		for (const spec of getAllComponentSpecs()) {
			assert.strictEqual(COMPONENT_SPECS[spec.type].type, spec.type);
			assert.ok(spec.displayName && spec.purpose && spec.description && spec.runtime, `${spec.type}: texts`);
			assert.ok(spec.usableIn.length > 0, `${spec.type}: usableIn`);
			assert.ok(Array.isArray(spec.props), `${spec.type}: props`);
			assert.ok(Array.isArray(spec.outputs), `${spec.type}: outputs`);
			assert.ok(spec.help.headline && spec.help.steps.length > 0, `${spec.type}: help`);
			const names = getComponentProps(spec.type).map(p => p.name);
			assert.strictEqual(new Set(names).size, names.length, `${spec.type}: duplicate prop names`);
			for (const prop of spec.props) {
				assert.ok(prop.description, `${spec.type}.${prop.name}: description`);
				if (prop.default !== undefined && prop.enum) {
					assert.ok(prop.enum.includes(String(prop.default)), `${spec.type}.${prop.name}: default outside enum`);
				}
			}
			for (const out of spec.outputs) {
				assert.ok(out.name && out.type && out.description, `${spec.type}: output fields`);
			}
			if (!NO_VAR_OUTPUT.has(spec.type)) {
				assert.ok(spec.outputs.some(o => o.name === '{var}'), `${spec.type}: publishes {var}`);
			}
		}
	});

	test('every palette entry has a spec with a palette entry; palettes are generated in order', () => {
		assert.deepStrictEqual(BASE_COMPONENT_PALETTE.map(item => item.type), [...TEMPLATE_PALETTE_ORDER]);
		for (const item of BASE_COMPONENT_PALETTE) {
			const spec = getComponentSpec(item.type)!;
			assert.ok(spec.templatePalette && spec.usableIn.includes('ticket'), item.type);
			assert.strictEqual(item.label, spec.displayName);
			assert.strictEqual(item.icon, spec.icon);
		}
		const nodePalette = getNodeComponentPalette();
		assert.deepStrictEqual(nodePalette.map(item => item.compType), [...NODE_PALETTE_ORDER]);
		for (const item of nodePalette) {
			assert.ok(getComponentSpec(item.compType)!.usableIn.includes('node'), item.compType);
			assert.ok(item.label && item.desc && item.accent, item.compType);
		}
		// Call Sub-Workflow is offered in templates too (CI-38); in nodes it comes from the Sub-Workflow Library
		assert.ok(TEMPLATE_PALETTE_ORDER.includes('sub_workflow'));
		assert.ok(!NODE_PALETTE_ORDER.includes('sub_workflow'));
	});

	test('the AI config allowlist is exactly the config-role props of each spec', () => {
		for (const type of getAiTemplateComponentTypes()) {
			const allow = getAiConfigProps(type).map(p => p.name).sort();
			const expected = getComponentProps(type).filter(p => (p.role ?? 'config') === 'config').map(p => p.name).sort();
			assert.deepStrictEqual(allow, expected, type);
		}
		// Unchanged from the CI-20 allowlist for a few representative types
		assert.deepStrictEqual(getAiConfigProps('browser').map(p => p.name).filter(n => !COMMON_COMPONENT_PROPS.some(c => c.name === n)),
			['defaultUrl', 'browserMaxRetries', 'browserRetryDelayMs', 'credentials']);
		assert.ok(describeAiConfigProps().includes('http_request: httpUrl, httpMethod'));
		assert.deepStrictEqual(getSecretPropNames().sort(), ['httpApiKeyValue', 'httpAuthPassword', 'httpAuthToken', 'sshPassword']);
	});

	test('no hidden or legacy types are exposed to the AI; Call Sub-Workflow is usable in templates', () => {
		const hidden = getAllComponentSpecs().filter(s => s.ai === 'hidden').map(s => s.type);
		const aiTypes = new Set<string>(getAiTemplateComponentTypes());
		for (const type of hidden) {
			assert.ok(!aiTypes.has(type), type);
		}
		for (const legacy of ['result', 'button']) {
			assert.notStrictEqual(normalizeFieldType(legacy), legacy);
			assert.ok(!aiTypes.has(legacy));
			assert.ok(!buildPrimitivesCatalog().some(e => e.type === legacy));
		}
		// Call Sub-Workflow is usable in templates and the AI may configure it (CI-38)
		assert.ok(aiTypes.has('sub_workflow'));
		assert.deepStrictEqual(getAiConfigProps('sub_workflow').map(p => p.name).filter(n => !COMMON_COMPONENT_PROPS.some(c => c.name === n)), ['subWorkflowId', 'subWorkflowInputs']);
		assert.deepStrictEqual(buildAiBasePrimitives().map(p => p.type), [...aiTypes]);
		// usableIn is only listed for restricted types: sub_workflow is no longer node-only
		assert.ok(buildPrimitivesCatalog().some(e => e.type === 'sub_workflow' && e.usableIn === undefined));
	});

	test('the help guide renders for every type and includes its outputs', () => {
		for (const spec of getAllComponentSpecs()) {
			const guide = getPrimitiveGuide(spec.type);
			assert.strictEqual(guide.type, spec.type);
			assert.strictEqual(guide.title, spec.displayName);
			assert.ok(guide.summary && guide.runTicketsFlow.steps.length > 0);
			assert.deepStrictEqual(guide.outputs, documentedOutputs(spec.outputs).map(describeOutput));
		}
		assert.strictEqual(getPrimitiveGuide('python', 'My Script').title, 'My Script');
		assert.strictEqual(getPrimitiveGuide('dynamic_list', 'SEO Pack', 'cls_1').type, 'reusable_class');
		assert.strictEqual(getPrimitiveGuide('unknown_thing').category, 'Custom Field Primitive');
	});

	test('the AI catalogs include description, config and outputs of every type', () => {
		const catalog = buildPrimitivesCatalog();
		for (const entry of catalog) {
			const spec = getComponentSpec(entry.type)!;
			assert.strictEqual(entry.description, spec.description);
			assert.strictEqual(entry.icon, spec.icon.id);
			for (const out of documentedOutputs(spec.outputs)) {
				assert.ok(entry.supportedOutputs?.some(line => line.startsWith(documentedOutputName(out.name))), `${spec.type}: ${out.name}`);
			}
			for (const prop of spec.props.filter(p => p.role !== 'state')) {
				assert.ok(entry.supportedInputs?.some(line => line.startsWith(prop.name)), `${spec.type}: ${prop.name}`);
			}
		}
		for (const primitive of buildAiBasePrimitives()) {
			assert.strictEqual(primitive.outputs.length, documentedOutputs(getComponentSpec(primitive.type)!.outputs).length);
			// Examples only use declared props
			const names = new Set<string>(getComponentProps(primitive.type).map(p => p.name));
			for (const key of Object.keys(primitive.example)) {
				assert.ok(names.has(key), `${primitive.type} example uses undeclared '${key}'`);
			}
		}
		assert.strictEqual(buildAiBasePrimitives().find(p => p.type === 'select')?.requiresOptions, true);
		assert.strictEqual(buildAiBasePrimitives().find(p => p.type === 'dynamic_list')?.supportsItemFields, true);
	});

	test('every example config passes the schema validation', () => {
		for (const spec of getAllComponentSpecs()) {
			const { id: _id, label: _label, type: _type, ...config } = spec.example;
			assert.deepStrictEqual(validateComponentConfig(spec.type, config, { checkRequired: false, aiWrite: true }), [], spec.type);
		}
	});

	test('typed component views', () => {
		const field: ICustomField = { id: 'a', label: 'A', type: 'http_request', httpUrl: 'https://x' };
		assert.strictEqual(getComponentConfig(field, 'http_request')?.httpUrl, 'https://x');
		assert.strictEqual(getComponentConfig(field, 'ssh'), undefined);
	});
});

suite('validateComponentConfig', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const codes = (type: string, config: Record<string, unknown>, aiWrite = true) =>
		validateComponentConfig(type, config, { writableRoles: ['config'], checkRequired: false, aiWrite }).map(e => `${e.code}:${e.prop}`);

	test('unknown type and unknown / non-writable props', () => {
		assert.deepStrictEqual(codes('nope', {}), ['unknownType:']);
		assert.deepStrictEqual(codes('http_request', { httpBody: 'x' }), ['unknownProp:httpBody']);
		assert.deepStrictEqual(codes('select', { options: ['a'] }), ['notWritable:options']);
		assert.deepStrictEqual(codes('http_request', { httpResponseStatus: 200 }), ['notWritable:httpResponseStatus']);
		assert.deepStrictEqual(codes('text', { outputVariableName: 'x', disabled: true, required: 'true' }), []);
	});

	test('input family: date / number / switch', () => {
		assert.deepStrictEqual(codes('date', { defaultContent: '2026-11-25' }), []);
		assert.deepStrictEqual(codes('number', { defaultContent: 12 }), []);
		assert.deepStrictEqual(codes('switch', { defaultContent: 'maybe' }), ['enum:defaultContent']);
		assert.deepStrictEqual(codes('switch', { defaultContent: 'TRUE' }), []);
	});

	test('integration family: http / ssh / browser secrets, enums and types', () => {
		assert.deepStrictEqual(codes('http_request', { httpUrl: 'https://a', httpMethod: 'post', httpAuthToken: '{API_TOKEN}', httpTimeoutMs: '5000' }), []);
		assert.deepStrictEqual(codes('http_request', { httpMethod: 'FETCH' }), ['enum:httpMethod']);
		assert.deepStrictEqual(codes('http_request', { httpAuthToken: 'sk-123' }), ['plaintextSecret:httpAuthToken']);
		assert.deepStrictEqual(codes('http_request', { httpAuthToken: 'sk-123' }, false), []);
		assert.deepStrictEqual(codes('http_request', { httpTimeoutMs: 'soon' }), ['type:httpTimeoutMs']);
		assert.deepStrictEqual(codes('http_request', { httpHeaders: 'Accept' }), ['type:httpHeaders']);
		assert.deepStrictEqual(codes('ssh', { sshPassword: 'hunter2' }), ['plaintextSecret:sshPassword']);
		assert.deepStrictEqual(codes('browser', { credentials: [{ key: 'k', value: '{SITE_KEY}' }] }), []);
		assert.deepStrictEqual(codes('browser', { credentials: [{ key: 'k', value: 'plain' }] }), ['plaintextSecret:credentials']);
		assert.deepStrictEqual(codes('python', { pythonEnvMode: 'conda' }), ['enum:pythonEnvMode']);
	});

	test('AI / media family: prompt, tts, media_player', () => {
		assert.deepStrictEqual(codes('prompt', { defaultUserPrompts: ['a', 'b'], targetModel: 'gpt-4o' }), []);
		assert.deepStrictEqual(codes('prompt', { targetMode: 'agent' }), ['notWritable:targetMode']);
		assert.deepStrictEqual(codes('tts', { ttsFormat: 'flac' }), ['enum:ttsFormat']);
		assert.deepStrictEqual(codes('media_player', { mediaSubtitleDisplayMode: 'dictation', mediaDictationAutoPause: 'false', mediaSubtitleProvider: '' }), []);
		assert.deepStrictEqual(codes('media_player', { mediaDictationUnit: 'words' }), ['enum:mediaDictationUnit']);
	});

	test('orchestration family: ticket built-ins and required props', () => {
		assert.deepStrictEqual(codes('create_tickets', { wfTicketType: 'run', wfTicketParams: { lr: '{lr}' } }), []);
		assert.deepStrictEqual(codes('create_tickets', { wfTicketParams: ['x'] }), ['type:wfTicketParams']);
		const required = validateComponentConfig('run_tickets', {}).map(e => `${e.code}:${e.prop}`);
		assert.deepStrictEqual(required, ['required:wfTicketTarget']);
		assert.deepStrictEqual(validateComponentConfig('get_tickets', {}), []);
		assert.deepStrictEqual(validateComponentConfig('select', {}).map(e => e.prop), ['options']);
		// Button Group gate (CI-25): the Waiting Prompt is an AI-writable text setting
		assert.deepStrictEqual(codes('button_group', { waitingPrompt: 'Approve {version}?' }), []);
		assert.deepStrictEqual(codes('button_group', { waitingPrompt: { text: 'x' } }), ['type:waitingPrompt']);
	});

	test('CI-69: docs, help and AI catalogs describe only the card rules (no sub-fields, no derived names)', () => {
		const derived = /\{[^{}]*\.(?:ok|exitCode|stdout|stderr|command|repoPath|branch|commit|cwd|durationMs|id|label|at|by|rows|json|output|sqlOutput|table|columns|dbPath|tableName)\}|\}_[a-z]|\{[A-Z][^{}]*_(?:result|status|ok|data|body|raw|url|logs|code|output|rows|payload)\}|_result\}|"[^"]*_result"|<var>_|label_key|Subtitles\}|Sub-fields? \./;
		const texts: string[] = [];
		for (const spec of getAllComponentSpecs()) {
			const guide = getPrimitiveGuide(spec.type);
			texts.push(spec.description, spec.runtime, ...spec.notes, ...guide.outputs, guide.runTicketsFlow.variableResolution, guide.runTicketsFlow.downstreamPassing, ...guide.runTicketsFlow.steps.map(st => st.detail), ...guide.syntaxExamples, ...guide.tips);
		}
		for (const entry of buildPrimitivesCatalog()) {
			texts.push(...(entry.supportedOutputs ?? []), ...(entry.notes ?? []), entry.executionBehavior);
		}
		for (const primitive of buildAiBasePrimitives()) {
			texts.push(...primitive.outputs);
		}
		const offending = texts.filter(t => derived.test(t));
		assert.deepStrictEqual(offending, []);
		// The rules themselves: title key, one variable, the plain Python variable; no "default" wording
		assert.ok(CARD_OUTPUT_RULES.includes('TICKET_CONTEXT["Log Step"]') && CARD_OUTPUT_RULES.includes('{log_step}') && /plain variable/.test(CARD_OUTPUT_RULES));
		assert.ok(!/default/i.test(CARD_OUTPUT_RULES));
		assert.ok(getPrimitiveGuide('git').runTicketsFlow.downstreamPassing.includes(CARD_OUTPUT_RULES));
		assert.ok(getPrimitiveGuide('git').outputs.some(line => line.startsWith('TICKET_CONTEXT["<Title>"]')));
		// The compatibility names are still declared (runtime aliases), only hidden
		assert.ok(getComponentSpec('git')!.outputs.some(o => o.name === '{var}_result' && o.internal));
	});
});
