/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { append, $ } from '../../../../base/browser/dom.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { getPrimitiveGuide } from '../common/componentRegistry.js';

/**
 * Displays a clean, modal flyout window explaining the primitive's usage and RUN_TICKETS execution behavior.
 */
export function showPrimitiveHelpModal(container: HTMLElement, fieldType: string, customLabel?: string, componentRef?: string): void {
	const guide = getPrimitiveGuide(fieldType, customLabel, componentRef);

	// Overlay backdrop
	const overlay = append(container, $('.primitive-help-modal-overlay', {
		style: 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0, 0, 0, 0.72); backdrop-filter: blur(6px); z-index: 999999; display: flex; align-items: center; justify-content: center; animation: anyagentFadeIn 0.15s ease-out;'
	}));

	// Modal Card
	const card = append(overlay, $('.primitive-help-modal-card', {
		style: 'width: 720px; max-width: 92vw; max-height: 86vh; background: var(--vscode-editorWidget-background, #1e1e1e); border: 1px solid rgba(56, 189, 248, 0.35); border-radius: 12px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.85); display: flex; flex-direction: column; overflow: hidden; color: var(--vscode-editor-foreground, #cccccc); font-family: var(--vscode-font-family, system-ui, sans-serif);'
	}));

	// Prevent click from propagating to overlay backdrop
	card.onclick = (e) => e.stopPropagation();

	// 1. Header
	const header = append(card, $('div', {
		style: 'display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); background: rgba(0, 0, 0, 0.25); flex-shrink: 0;'
	}));

	const titleLeft = append(header, $('div', { style: 'display: flex; align-items: center; gap: 10px;' }));
	append(titleLeft, $('span' + ThemeIcon.asCSSSelector(guide.icon), {
		style: 'font-size: 20px; color: #38bdf8;'
	}));

	const titleCol = append(titleLeft, $('div', { style: 'display: flex; flex-direction: column; gap: 2px;' }));
	const titleRow = append(titleCol, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
	append(titleRow, $('span', { style: 'font-size: 15px; font-weight: 600; color: #ffffff;' }, guide.title));
	append(titleRow, $('span.category-badge', {
		style: 'font-size: 9.5px; font-weight: 700; text-transform: uppercase; padding: 2px 7px; border-radius: 4px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); letter-spacing: 0.04em;'
	}, guide.category));

	const closeBtn = append(header, $('button', {
		style: 'background: transparent; border: none; font-size: 16px; color: rgba(255, 255, 255, 0.6); cursor: pointer; padding: 4px 8px; border-radius: 6px; transition: all 0.15s ease;'
	}, '\u2715'));
	closeBtn.onmouseenter = () => { closeBtn.style.color = '#ffffff'; closeBtn.style.background = 'rgba(255, 255, 255, 0.1)'; };
	closeBtn.onmouseleave = () => { closeBtn.style.color = 'rgba(255, 255, 255, 0.6)'; closeBtn.style.background = 'transparent'; };

	const targetDocument = container.ownerDocument;
	const closeModal = () => {
		overlay.remove();
		targetDocument.removeEventListener('keydown', onKeyDown);
	};

	closeBtn.onclick = closeModal;
	overlay.onclick = closeModal;

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			closeModal();
		}
	};
	targetDocument.addEventListener('keydown', onKeyDown);

	// 2. Scrollable Content Body
	const body = append(card, $('div', {
		style: 'flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 18px; font-size: 12.5px; line-height: 1.6;'
	}));

	// Summary Callout Box
	const summaryBox = append(body, $('div', {
		style: 'padding: 12px 16px; background: rgba(56, 189, 248, 0.06); border-left: 3px solid #38bdf8; border-radius: 0 6px 6px 0; font-size: 13px; color: #e2e8f0;'
	}));
	summaryBox.textContent = guide.summary;

	// SECTION A: RUN_TICKETS Runtime Execution Flow (Highlighted as Core)
	const runSection = append(body, $('div', {
		style: 'background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(56, 189, 248, 0.28); border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 12px;'
	}));

	const runHeader = append(runSection, $('div', { style: 'display: flex; align-items: center; justify-content: space-between;' }));
	const runTitle = append(runHeader, $('div', { style: 'display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13.5px; color: #38bdf8;' }));
	append(runTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.playCircle)));
	append(runTitle, $('span', {}, guide.runTicketsFlow.headline));

	append(runHeader, $('span', {
		style: 'font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 4px; background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3);'
	}, 'RUNTIME PIPELINE'));

	const stepsList = append(runSection, $('div', { style: 'display: flex; flex-direction: column; gap: 10px;' }));
	guide.runTicketsFlow.steps.forEach(st => {
		const row = append(stepsList, $('div', { style: 'display: flex; flex-direction: column; gap: 3px; padding: 8px 12px; background: rgba(255, 255, 255, 0.02); border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.05);' }));
		append(row, $('div', { style: 'font-weight: 600; color: #ffffff; font-size: 12px;' }, st.step));
		append(row, $('div', { style: 'opacity: 0.85; font-size: 11.5px; line-height: 1.5;' }, st.detail));
	});

	// Downstream Passing Highlight in RUN_TICKETS
	const flowFooter = append(runSection, $('div', {
		style: 'border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 10px; display: flex; flex-direction: column; gap: 4px; font-size: 11.5px;'
	}));
	const flowLabel = append(flowFooter, $('div', { style: 'font-weight: 600; color: #a78bfa;' }, 'Downstream Data Propagation:'));
	flowLabel.textContent = 'Downstream Workflow Propagation:';
	append(flowFooter, $('div', { style: 'opacity: 0.85;' }, guide.runTicketsFlow.downstreamPassing));

	// SECTION B: Designer Configuration Spec
	const configSection = append(body, $('div', { style: 'display: flex; flex-direction: column; gap: 8px;' }));
	append(configSection, $('div', { style: 'font-weight: 600; font-size: 13px; color: #ffffff; display: flex; align-items: center; gap: 6px;' }, [
		$('span' + ThemeIcon.asCSSSelector(Codicon.settings)),
		$('span', {}, 'Designer Configuration & Properties')
	]));

	const configTable = append(configSection, $('div', {
		style: 'display: flex; flex-direction: column; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; overflow: hidden;'
	}));
	guide.designerConfig.forEach((cfg, idx) => {
		const row = append(configTable, $('div', {
			style: `display: flex; padding: 8px 12px; gap: 14px; background: ${idx % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent'}; border-bottom: ${idx < guide.designerConfig.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none'}; font-size: 11.5px;`
		}));
		append(row, $('div', { style: 'font-weight: 600; width: 180px; flex-shrink: 0; color: #e2e8f0;' }, cfg.name));
		append(row, $('div', { style: 'flex: 1; opacity: 0.8;' }, cfg.desc));
	});

	// SECTION B2: Published Variables (generated from the registry outputs)
	if (guide.outputs.length > 0) {
		const outputsSection = append(body, $('div', { style: 'display: flex; flex-direction: column; gap: 6px;' }));
		const outputsTitle = append(outputsSection, $('div', { style: 'font-weight: 600; font-size: 13px; color: #ffffff; display: flex; align-items: center; gap: 6px;' }));
		append(outputsTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolVariable)));
		append(outputsTitle, $('span', {}, 'Published Variables'));
		guide.outputs.forEach(line => {
			append(outputsSection, $('div', { style: 'font-size: 11.5px; opacity: 0.85; font-family: var(--vscode-editor-font-family, monospace);' }, line));
		});
	}

	// SECTION C: Variable Syntax & Interpolation
	const syntaxSection = append(body, $('div', { style: 'display: flex; flex-direction: column; gap: 8px;' }));
	append(syntaxSection, $('div', { style: 'font-weight: 600; font-size: 13px; color: #ffffff; display: flex; align-items: center; gap: 6px;' }, [
		$('span' + ThemeIcon.asCSSSelector(Codicon.code)),
		$('span', {}, 'Variable Reference & Interpolation Syntax')
	]));

	const syntaxList = append(syntaxSection, $('div', { style: 'display: flex; flex-wrap: wrap; gap: 8px;' }));
	guide.syntaxExamples.forEach(syn => {
		append(syntaxList, $('code', {
			style: 'padding: 4px 10px; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 4px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; color: #38bdf8;'
		}, syn));
	});

	// SECTION D: Best Practice Tips
	if (guide.tips.length > 0) {
		const tipsSection = append(body, $('div', { style: 'display: flex; flex-direction: column; gap: 6px;' }));
		guide.tips.forEach(tp => {
			const tipRow = append(tipsSection, $('div', { style: 'display: flex; align-items: flex-start; gap: 8px; font-size: 11.5px; opacity: 0.8;' }));
			append(tipRow, $('span' + ThemeIcon.asCSSSelector(Codicon.lightbulb), { style: 'color: #facc15; font-size: 13px; margin-top: 2px;' }));
			append(tipRow, $('span', {}, tp));
		});
	}

	// 3. Footer Bar
	const footer = append(card, $('div', {
		style: 'padding: 12px 20px; border-top: 1px solid rgba(255, 255, 255, 0.08); background: rgba(0, 0, 0, 0.25); display: flex; justify-content: flex-end; align-items: center; gap: 10px; flex-shrink: 0;'
	}));

	const okBtn = append(footer, $('button.monaco-button', {
		style: 'padding: 6px 18px; font-size: 12px; font-weight: 500; border-radius: 6px; cursor: pointer; background: #0284c7; color: #ffffff; border: 1px solid rgba(255, 255, 255, 0.2);'
	}, 'Close Guide'));
	okBtn.onclick = closeModal;
}
