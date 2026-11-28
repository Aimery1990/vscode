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
import { countOutputVariableReferences, findOutputVariableReferences, formatOutputVariableReference, getOutputVariableHoverEntries, getOutputVariableInfo, IOutputVariableReference, validateOutputVariableName } from '../common/outputVariable.js';

/**
 * The exported variable chip of a component card (UI-27): `→ name` in the card header. Click copies the reference
 * (`{name}`). In edit mode the pencil renames it inline (same validation and save path as the component settings), and
 * after a rename the references in the other components can be updated too. In view / run mode (CI-69) the chip is
 * read-only (no pencil) and is shown on every card that has a variable. Used by the ticket page (Freestyle and
 * template tickets), the template designer and the workflow node component editor.
 */
export interface IOutputVariableChipOptions {
	readonly field: ICustomField;
	readonly clipboardService: IClipboardService;
	readonly notificationService: INotificationService;
	/** Edit mode only: rename with the pencil. Without it the chip is read-only (view / run mode). */
	readonly edit?: IOutputVariableChipEditOptions;
}

export interface IOutputVariableChipEditOptions {
	/** The components of the same ticket / template / node (uniqueness and references). */
	getComponents(): readonly ICustomField[];
	readonly dialogService: IDialogService;
	/**
	 * Saves the new name through the host's component settings path; with `updateReferences` the references to the
	 * old name in the other components are replaced too.
	 */
	commit(newName: string, oldName: string, updateReferences: boolean): void | Promise<void>;
}

const MAX_LISTED_REFERENCES = 12;

/**
 * Tooltip of the chip (CI-69): only the ways to use the card's output — `{name}` in this ticket or a workflow,
 * `TICKET_CONTEXT["<Title>"]` and the plain variable in Python. Click copies `{name}`.
 */
export function outputVariableChipTooltip(field: ICustomField, name: string): string {
	const lines = [`Exported variable of this card — click to copy ${formatOutputVariableReference(name)}`, ''];
	for (const e of getOutputVariableHoverEntries(field, name)) {
		lines.push(`${e.reference} — ${e.description}`);
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
		'aria-label': `Exported variable ${name}: copy ${reference}`
	},
		$('span.anyagent-output-var-chip-arrow', { 'aria-hidden': 'true' }, '→'),
		nameEl
	);
	const edit = options.edit;
	const editBtn = edit ? $<HTMLButtonElement>('button.anyagent-output-var-chip-edit', { type: 'button', title: 'Rename Exported Variable', 'aria-label': 'Rename Exported Variable' },
		$(`span${ThemeIcon.asCSSSelector(Codicon.edit)}`)
	) : undefined;
	const chip = $(`span.anyagent-output-var-chip${edit ? '' : '.readonly'}`, { 'data-output-var': name, 'data-component-id': field.id }, copyBtn, ...(editBtn ? [editBtn] : []));
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

	if (!edit || !editBtn) {
		return chip;
	}

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
			const error = input.value.trim() === name ? undefined : validateOutputVariableName(input.value, edit.getComponents(), field.id);
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
		const refs = findOutputVariableReferences(edit.getComponents(), field.id, name);
		const count = countOutputVariableReferences(refs);
		if (count === 0) {
			await edit.commit(newName, name, false);
			return;
		}
		const { result } = await edit.dialogService.prompt<'update' | 'keep' | 'cancel'>({
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
		await edit.commit(newName, name, result === 'update');
		if (result === 'keep') {
			options.notificationService.warn(`${count} reference${count === 1 ? '' : 's'} still use${count === 1 ? 's' : ''} ${reference}: ${refs.map(r => r.fieldLabel).filter((l, i, a) => a.indexOf(l) === i).join(', ')}.`);
		}
	};

	return chip;
}
