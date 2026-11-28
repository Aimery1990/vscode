/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import Severity from '../../../../base/common/severity.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICustomField } from '../../entityPersistence/common/entityPersistence.js';
import { countOutputVariableReferences, findOutputVariableReferences, formatOutputVariableReference, getOutputSubFields, getOutputVariableHoverEntries, getOutputVariableInfo, IOutputVariableReference, validateOutputVariableName } from '../common/outputVariable.js';

/**
 * The output variable chip of a component card in edit mode (UI-27): `→ name` in the card header. Click copies the
 * reference (`{name}`), the pencil renames it inline (same validation and save path as the component settings), and
 * after a rename the references in the other components can be updated too. Used by the Freestyle ticket page, the
 * template designer and the workflow node component editor.
 */
export interface IOutputVariableChipOptions {
	readonly field: ICustomField;
	/** The components of the same ticket / template / node (uniqueness and references). */
	getComponents(): readonly ICustomField[];
	readonly clipboardService: IClipboardService;
	readonly notificationService: INotificationService;
	readonly dialogService: IDialogService;
	/**
	 * Saves the new name through the host's component settings path; with `updateReferences` the references to the
	 * old name in the other components are replaced too.
	 */
	commit(newName: string, oldName: string, updateReferences: boolean): void | Promise<void>;
}

const MAX_LISTED_REFERENCES = 12;

/** Tooltip of the chip: how to use it, the sub-fields and what the component publishes. */
export function outputVariableChipTooltip(field: ICustomField, name: string): string {
	const lines = [`Output variable — click to copy ${formatOutputVariableReference(name)}`];
	const subFields = getOutputSubFields(field.type);
	if (subFields.length > 0) {
		lines.push(`Sub-fields: ${subFields.map(s => `.${s}`).join(' ')}`);
	}
	const entries = getOutputVariableHoverEntries(field, name);
	if (entries.length > 0) {
		lines.push('', 'Publishes:');
		for (const e of entries) {
			lines.push(`  ${e.reference} — ${e.description}`);
		}
	}
	return lines.join('\n');
}

function describeReferences(refs: readonly IOutputVariableReference[]): string {
	const lines = refs.slice(0, MAX_LISTED_REFERENCES).map(r => `• ${r.fieldLabel} · ${r.path}${r.count > 1 ? ` (${r.count}×)` : ''}`);
	if (refs.length > MAX_LISTED_REFERENCES) {
		lines.push(`… and ${refs.length - MAX_LISTED_REFERENCES} more`);
	}
	return lines.join('\n');
}

/** Renders the chip, or returns undefined when the component has no output variable. */
export function renderOutputVariableChip(options: IOutputVariableChipOptions): HTMLElement | undefined {
	const { field } = options;
	const info = getOutputVariableInfo(field);
	if (!info) {
		return undefined;
	}
	const name = info.name;
	const reference = formatOutputVariableReference(name);
	const nameEl = $('span.anyagent-output-var-chip-name', undefined, name);
	const copyBtn = $<HTMLButtonElement>('button.anyagent-output-var-chip-copy', {
		type: 'button',
		title: outputVariableChipTooltip(field, name),
		'aria-label': `Output variable ${name}: copy ${reference}`
	},
		$('span.anyagent-output-var-chip-arrow', { 'aria-hidden': 'true' }, '→'),
		nameEl
	);
	const editBtn = $<HTMLButtonElement>('button.anyagent-output-var-chip-edit', { type: 'button', title: 'Rename Output Variable', 'aria-label': 'Rename Output Variable' },
		$(`span${ThemeIcon.asCSSSelector(Codicon.edit)}`)
	);
	const chip = $('span.anyagent-output-var-chip', { 'data-output-var': name, 'data-component-id': field.id }, copyBtn, editBtn);
	// Keep clicks / drags inside the chip away from the card (drag handles, card selection)
	chip.onmousedown = e => e.stopPropagation();
	chip.ondragstart = e => {
		e.preventDefault();
		e.stopPropagation();
	};

	let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
	copyBtn.onclick = async e => {
		e.preventDefault();
		e.stopPropagation();
		try {
			await options.clipboardService.writeText(reference);
		} catch (err) {
			options.notificationService.warn(`Could not copy ${reference}: ${err}`);
			return;
		}
		chip.classList.add('copied');
		nameEl.textContent = `Copied ${reference}`;
		if (feedbackTimer) {
			clearTimeout(feedbackTimer);
		}
		feedbackTimer = setTimeout(() => {
			chip.classList.remove('copied');
			nameEl.textContent = name;
		}, 1200);
	};

	editBtn.onclick = e => {
		e.preventDefault();
		e.stopPropagation();
		startEdit();
	};

	const startEdit = () => {
		const input = $<HTMLInputElement>('input.anyagent-output-var-chip-input', { type: 'text', spellcheck: 'false', 'aria-label': 'Output variable name' });
		input.value = name;
		input.size = Math.max(8, name.length + 2);
		copyBtn.style.display = 'none';
		editBtn.style.display = 'none';
		chip.classList.add('editing');
		chip.insertBefore(input, copyBtn);
		input.focus();
		input.select();
		const validate = (): string | undefined => {
			const error = input.value.trim() === name ? undefined : validateOutputVariableName(input.value, options.getComponents(), field.id);
			input.classList.toggle('invalid', !!error);
			input.title = error ?? 'Enter: save · Escape: cancel';
			return error;
		};
		validate();
		let finished = false;
		const finish = (commit: boolean) => {
			if (finished) {
				return;
			}
			const value = input.value.trim();
			const error = commit && value !== name ? validate() : undefined;
			if (error) {
				options.notificationService.warn(error);
				if (input.isConnected && commit) {
					// Keep editing on Enter; a blur with an invalid name cancels
					return;
				}
			}
			finished = true;
			input.remove();
			chip.classList.remove('editing');
			copyBtn.style.display = '';
			editBtn.style.display = '';
			if (commit && !error && value && value !== name) {
				renameTo(value).catch(err => options.notificationService.error(`Failed to rename the output variable: ${err}`));
			}
		};
		input.oninput = () => {
			input.size = Math.max(8, input.value.length + 2);
			validate();
		};
		input.onkeydown = e => {
			e.stopPropagation();
			if (e.key === 'Enter') {
				e.preventDefault();
				finish(true);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				finish(false);
			}
		};
		input.onblur = () => {
			if (validate()) {
				finish(false);
			} else {
				finish(true);
			}
		};
		input.onclick = e => e.stopPropagation();
	};

	const renameTo = async (newName: string) => {
		const refs = findOutputVariableReferences(options.getComponents(), field.id, name);
		const count = countOutputVariableReferences(refs);
		if (count === 0) {
			await options.commit(newName, name, false);
			return;
		}
		const { result } = await options.dialogService.prompt<'update' | 'keep' | 'cancel'>({
			type: Severity.Info,
			message: `Also update ${count} reference${count === 1 ? '' : 's'} to ${reference}?`,
			detail: `The variable is renamed to ${formatOutputVariableReference(newName)}. These places still use the old name:\n${describeReferences(refs)}`,
			buttons: [
				{ label: `&&Update ${count === 1 ? 'Reference' : 'References'}`, run: () => 'update' },
				{ label: '&&Rename Only', run: () => 'keep' }
			],
			cancelButton: { label: 'Cancel', run: () => 'cancel' }
		});
		if (result === 'cancel') {
			return;
		}
		await options.commit(newName, name, result === 'update');
		if (result === 'keep') {
			options.notificationService.warn(`${count} reference${count === 1 ? '' : 's'} still use${count === 1 ? 's' : ''} ${reference}: ${refs.map(r => r.fieldLabel).filter((l, i, a) => a.indexOf(l) === i).join(', ')}.`);
		}
	};

	return chip;
}
