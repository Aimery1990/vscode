/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICustomField, ICustomModule } from '../../../entityPersistence/common/entityPersistence.js';
import { BASE_COMPONENT_PALETTE, createComponentField, createCompositeComponentField, findPaletteItem, getUniqueComponentLabel } from '../../common/componentPalette.js';
import { insertComponent, isDescriptionComponent, isTitleComponent, moveComponent, moveComponentBy, propagateComponentLabelRename, removeComponent, renameComponent, renameComponentValueKey } from '../../common/componentSchemaEdits.js';

function structure(...ids: string[]): ICustomModule {
	return {
		id: 'freestyle',
		name: 'Freestyle',
		fields: [
			{ id: 'title', label: 'Title', type: 'text', required: true },
			...ids.map((id): ICustomField => id === 'description'
				? { id, label: 'Description', type: 'textarea' }
				: { id, label: id.toUpperCase(), type: 'text' })
		]
	};
}

function ids(mod: ICustomModule): string[] {
	return (mod.fields ?? []).map(f => f.id);
}

const context = { defaultModel: { providerId: 'p', modelId: 'm' }, defaultTicketType: 'Bug' };

suite('componentSchemaEdits', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('recognizes the Title and Description root fields by id or label', () => {
		assert.strictEqual(isTitleComponent({ id: 'title', label: 'x' }), true);
		assert.strictEqual(isTitleComponent({ id: 'x', label: 'TITLE' }), true);
		assert.strictEqual(isDescriptionComponent({ id: 'description', label: 'x' }), true);
		assert.strictEqual(isDescriptionComponent({ id: 'a', label: 'A' }), false);
	});

	test('insert appends, inserts at an index and never goes before the Title', () => {
		const mod = structure('a', 'b');
		const field: ICustomField = { id: 'n', label: 'N', type: 'text' };
		assert.deepStrictEqual(ids(insertComponent(mod, field)), ['title', 'a', 'b', 'n']);
		assert.deepStrictEqual(ids(insertComponent(mod, field, 2)), ['title', 'a', 'n', 'b']);
		assert.deepStrictEqual(ids(insertComponent(mod, field, 0)), ['title', 'n', 'a', 'b']);
		assert.deepStrictEqual(ids(insertComponent(mod, field, 99)), ['title', 'a', 'b', 'n']);
		assert.deepStrictEqual(ids(mod), ['title', 'a', 'b'], 'input is not modified');
	});

	test('move puts a component at the target index; the Title stays first', () => {
		const mod = structure('a', 'b', 'c');
		assert.deepStrictEqual(ids(moveComponent(mod, 'c', 1)), ['title', 'c', 'a', 'b']);
		assert.deepStrictEqual(ids(moveComponent(mod, 'a', 3)), ['title', 'b', 'c', 'a']);
		assert.deepStrictEqual(ids(moveComponent(mod, 'b', 0)), ['title', 'b', 'a', 'c']);
		assert.deepStrictEqual(ids(moveComponent(mod, 'title', 3)), ['title', 'a', 'b', 'c']);
		assert.deepStrictEqual(ids(moveComponent(mod, 'missing', 1)), ['title', 'a', 'b', 'c']);
		assert.deepStrictEqual(ids(moveComponentBy(mod, 'b', -1)), ['title', 'b', 'a', 'c']);
		assert.deepStrictEqual(ids(moveComponentBy(mod, 'b', 1)), ['title', 'a', 'c', 'b']);
		assert.deepStrictEqual(ids(moveComponentBy(mod, 'a', -1)), ['title', 'a', 'b', 'c']);
		assert.deepStrictEqual(ids(mod), ['title', 'a', 'b', 'c'], 'input is not modified');
	});

	test('remove deletes any component except the Title (Description can be removed)', () => {
		const mod = structure('description', 'a');
		assert.deepStrictEqual(ids(removeComponent(mod, 'description')), ['title', 'a']);
		assert.deepStrictEqual(ids(removeComponent(mod, 'A')), ['title', 'description']);
		assert.deepStrictEqual(ids(removeComponent(mod, 'title')), ['title', 'description', 'a']);
		assert.deepStrictEqual(ids(mod), ['title', 'description', 'a'], 'input is not modified');
	});

	test('rename changes the label, keeps the id and updates references in other components', () => {
		const mod = structure('a');
		mod.fields!.push({ id: 'p', label: 'Prompt', type: 'prompt', defaultContent: 'Use {A} and @{{A}} but not {AB}' });
		mod.fields!.push({ id: 'o', label: 'Output', type: 'output', outputSpecs: [{ fieldKey: 'A', label: 'A', enabled: true }] });
		mod.fields!.push({ id: 'py', label: 'Script', type: 'python', pythonCode: 'x = TICKET_CONTEXT[\'A\'] + TICKET_CONTEXT["A"]' });
		const result = renameComponent(mod, 'a', '  Budget  ');
		assert.strictEqual(result.error, undefined);
		assert.strictEqual(result.oldLabel, 'A');
		const renamed = result.module.fields!.find(f => f.id === 'a') as ICustomField & { previousLabels?: string[] };
		assert.strictEqual(renamed.label, 'Budget');
		assert.deepStrictEqual(renamed.previousLabels, ['A']);
		const byId = (id: string) => result.module.fields!.find(f => f.id === id)!;
		assert.strictEqual(byId('p').defaultContent, 'Use {Budget} and @{{Budget}} but not {AB}');
		assert.deepStrictEqual(byId('o').outputSpecs, [{ fieldKey: 'Budget', label: 'Budget', enabled: true }]);
		assert.strictEqual(byId('py').pythonCode, 'x = TICKET_CONTEXT[\'Budget\'] + TICKET_CONTEXT["Budget"]');
		assert.strictEqual(mod.fields![1].label, 'A', 'input is not modified');
	});

	test('rename refuses root fields, empty, reserved and duplicate names', () => {
		const mod = structure('description', 'a', 'b');
		assert.ok(renameComponent(mod, 'title', 'X').error);
		assert.ok(renameComponent(mod, 'description', 'X').error);
		assert.ok(renameComponent(mod, 'a', '   ').error);
		assert.ok(renameComponent(mod, 'a', 'title').error);
		assert.ok(renameComponent(mod, 'a', 'Description').error);
		assert.ok(renameComponent(mod, 'a', 'b').error, 'clashes with another label (case-insensitive)');
		assert.ok(renameComponent(mod, 'missing', 'X').error);
		const same = renameComponent(mod, 'a', 'A');
		assert.strictEqual(same.error, undefined);
		assert.strictEqual(same.oldLabel, '', 'unchanged label is a no-op');
	});

	test('propagate leaves the renamed component itself alone', () => {
		const self: ICustomField = { id: 's', label: 'New', type: 'prompt', defaultContent: '{Old}' };
		propagateComponentLabelRename([self], self, 'Old', 'New');
		assert.strictEqual(self.defaultContent, '{Old}');
	});

	test('renameComponentValueKey moves a stored value to the new label', () => {
		assert.deepStrictEqual(renameComponentValueKey({ 'Text Field 1': 'hello', Other: 'x' }, 'Text Field 1', 'Name'), { Other: 'x', Name: 'hello' });
		assert.deepStrictEqual(renameComponentValueKey({ text_field_1: 'v' }, 'Text Field 1', 'Name'), { Name: 'v' }, 'matches like the ticket page (case, _ as space)');
		assert.deepStrictEqual(renameComponentValueKey({ Other: 'x' }, 'Missing', 'Name'), { Other: 'x' });
		assert.deepStrictEqual(renameComponentValueKey({ A: '1', Name: '2' }, 'A', 'name'), { A: '1', Name: '2' }, 'never overwrites an existing value');
	});
});

suite('componentPalette', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every palette entry has a unique type and can be looked up', () => {
		const types = BASE_COMPONENT_PALETTE.map(item => item.type);
		assert.strictEqual(new Set(types).size, types.length);
		assert.strictEqual(findPaletteItem('python')?.defaultName, 'Python Script');
		assert.strictEqual(findPaletteItem('nope'), undefined);
	});

	test('unique labels skip used labels / ids and the root field names', () => {
		const fields: ICustomField[] = [{ id: 'title', label: 'Title', type: 'text' }, { id: 'amount_1', label: 'Something', type: 'number' }];
		assert.deepStrictEqual(getUniqueComponentLabel(fields, 'Amount'), { label: 'Amount 2', id: 'amount_2' });
		assert.deepStrictEqual(getUniqueComponentLabel([], 'Title'), { label: 'Title 1', id: 'title_1' });
	});

	test('new components get their type defaults and fresh nested ids', () => {
		const fields: ICustomField[] = [{ id: 'title', label: 'Title', type: 'text' }, { id: 'notes', label: 'Notes', type: 'textarea' }];
		const prompt = createComponentField(findPaletteItem('prompt')!, fields, context);
		assert.deepStrictEqual([prompt.id, prompt.label, prompt.targetProvider, prompt.targetModel], ['ai_prompt_1', 'AI Prompt 1', 'p', 'm']);
		assert.strictEqual(createComponentField(findPaletteItem('create_tickets')!, fields, context).wfTicketType, 'Bug');
		assert.deepStrictEqual(createComponentField(findPaletteItem('select')!, fields, context).options, ['Option 1', 'Option 2', 'Option 3']);
		const output = createComponentField(findPaletteItem('output')!, fields, context);
		assert.deepStrictEqual(output.outputSpecs?.map(s => s.fieldKey), ['Notes']);
		const container = createComponentField(findPaletteItem('dynamic_list')!, fields, context);
		assert.strictEqual(container.itemFields?.length, 2);
		const otherContainer = createComponentField(findPaletteItem('dynamic_list')!, fields, context);
		assert.notStrictEqual(container.itemFields, otherContainer.itemFields, 'nested defaults are not shared');
	});

	test('a reusable class becomes a Container bound to the class', () => {
		const field = createCompositeComponentField({ id: 'cls', name: 'Address', itemFields: [{ id: 's', label: 'Street', type: 'text' }] }, []);
		assert.strictEqual(field.label, 'Address 1');
		assert.strictEqual(field.type, 'dynamic_list');
		assert.strictEqual(field.componentRef, 'cls');
		assert.deepStrictEqual(field.itemFields, [{ id: 's', label: 'Street', type: 'text' }]);
	});
});
