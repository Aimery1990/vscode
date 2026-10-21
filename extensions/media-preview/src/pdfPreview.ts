/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BinarySizeStatusBarEntry } from './binarySizeStatusBarEntry';
import { MediaPreview, isGitLfsPointer, reopenAsText } from './mediaPreview';
import { escapeAttribute } from './util/dom';
import { generateUuid } from './util/uuid';

class PdfPreviewProvider implements vscode.CustomReadonlyEditorProvider {

	public static readonly viewType = 'vscode.pdfPreview';

	constructor(
		private readonly extensionRoot: vscode.Uri,
		private readonly binarySizeStatusBarEntry: BinarySizeStatusBarEntry,
	) { }

	public async openCustomDocument(uri: vscode.Uri) {
		return { uri, dispose: () => { } };
	}

	public async resolveCustomEditor(document: vscode.CustomDocument, webviewEditor: vscode.WebviewPanel): Promise<void> {
		new PdfPreview(this.extensionRoot, document.uri, webviewEditor, this.binarySizeStatusBarEntry);
	}
}

class PdfPreview extends MediaPreview {

	constructor(
		private readonly extensionRoot: vscode.Uri,
		resource: vscode.Uri,
		webviewEditor: vscode.WebviewPanel,
		binarySizeStatusBarEntry: BinarySizeStatusBarEntry,
	) {
		super(extensionRoot, resource, webviewEditor, binarySizeStatusBarEntry);

		this._register(webviewEditor.webview.onDidReceiveMessage(message => {
			switch (message.type) {
				case 'reopen-as-text': {
					reopenAsText(resource, webviewEditor.viewColumn);
					break;
				}
			}
		}));

		this.updateBinarySize();
		this.render();
		this.updateState();
	}

	protected async getWebviewContents(): Promise<string> {
		const version = Date.now().toString();
		const src = await this.getResourcePath(this._webviewEditor, this._resource, version);
		const pdfJsSrc = this.extensionResource('media', 'pdf.min.js').toString();
		const pdfWorkerSrc = this.extensionResource('media', 'pdf.worker.min.js').toString();

		const settings = {
			src,
			workerSrc: pdfWorkerSrc,
			isGitLfs: src === null,
		};

		const nonce = generateUuid();
		const cspSource = this._webviewEditor.webview.cspSource;

		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
	<title>PDF Preview</title>
	<link rel="stylesheet" href="${escapeAttribute(this.extensionResource('media', 'pdfPreview.css'))}" type="text/css" media="screen">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${cspSource} blob: data:; script-src 'nonce-${nonce}' ${cspSource} blob:; worker-src blob: data: ${cspSource}; style-src ${cspSource} 'unsafe-inline'; img-src data: blob: ${cspSource};">
	<meta id="settings" data-settings="${escapeAttribute(JSON.stringify(settings))}">
</head>
<body class="loading" data-vscode-context='{ "preventDefaultContextMenuItems": true }'>
	<div class="loading-indicator"></div>
	<div class="loading-error">
		<p>${vscode.l10n.t("An error occurred while loading the PDF document.")}</p>
		<a href="#" class="open-file-link">${vscode.l10n.t("Open file using standard text/binary editor?")}</a>
	</div>
	<div class="git-lfs-info">
		<p>${vscode.l10n.t("The PDF file is stored with Git LFS and is not available for preview.")}</p>
		<a href="#" class="open-file-link">${vscode.l10n.t("Open file using standard text/binary editor?")}</a>
	</div>

	<!-- Floating Glassmorphism Toolbar -->
	<div class="pdf-toolbar" id="toolbar" style="display: none;">
		<div class="toolbar-group">
			<button class="toolbar-btn icon-btn" id="prevPage" title="Previous Page">◀</button>
			<div class="page-indicator">
				<input type="number" id="pageNumber" min="1" value="1" />
				<span class="page-total">/ <span id="numPages">0</span></span>
			</div>
			<button class="toolbar-btn icon-btn" id="nextPage" title="Next Page">▶</button>
		</div>
		<div class="toolbar-divider"></div>
		<div class="toolbar-group">
			<button class="toolbar-btn icon-btn" id="zoomOut" title="Zoom Out">−</button>
			<button class="toolbar-btn text-btn" id="zoomVal" title="Reset Zoom">100%</button>
			<button class="toolbar-btn icon-btn" id="zoomIn" title="Zoom In">+</button>
		</div>
		<div class="toolbar-divider"></div>
		<div class="toolbar-group">
			<button class="toolbar-btn text-btn" id="fitWidth" title="Fit to Width">Fit Width</button>
			<button class="toolbar-btn text-btn" id="fitPage" title="Fit to Page">Fit Page</button>
		</div>
	</div>

	<!-- PDF Pages Container -->
	<div class="pdf-container" id="pdfContainer"></div>

	<script src="${escapeAttribute(pdfWorkerSrc)}" nonce="${nonce}"></script>
	<script src="${escapeAttribute(pdfJsSrc)}" nonce="${nonce}"></script>
	<script src="${escapeAttribute(this.extensionResource('media', 'pdfPreview.js'))}" nonce="${nonce}"></script>
</body>
</html>`;
	}

	private async getResourcePath(webviewEditor: vscode.WebviewPanel, resource: vscode.Uri, version: string): Promise<string | null> {
		if (await isGitLfsPointer(resource)) {
			return null;
		}
		if (resource.query) {
			return webviewEditor.webview.asWebviewUri(resource).toString();
		}
		return webviewEditor.webview.asWebviewUri(resource).with({ query: `version=${version}` }).toString();
	}

	private extensionResource(...parts: string[]) {
		return this._webviewEditor.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionRoot, ...parts));
	}
}

export function registerPdfPreviewSupport(context: vscode.ExtensionContext, binarySizeStatusBarEntry: BinarySizeStatusBarEntry): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];
	const provider = new PdfPreviewProvider(context.extensionUri, binarySizeStatusBarEntry);
	disposables.push(vscode.window.registerCustomEditorProvider(PdfPreviewProvider.viewType, provider, {
		supportsMultipleEditorsPerDocument: true,
		webviewOptions: {
			retainContextWhenHidden: true,
		}
	}));

	disposables.push(vscode.commands.registerCommand('pdfPreview.reopenAsPreview', async () => {
		await vscode.commands.executeCommand('reopenActiveEditorWith', PdfPreviewProvider.viewType);
	}));

	disposables.push(vscode.commands.registerCommand('pdfPreview.reopenAsText', async () => {
		await vscode.commands.executeCommand('reopenActiveEditorWith', 'default');
	}));

	return vscode.Disposable.from(...disposables);
}
