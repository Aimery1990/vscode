/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

(function () {
	// @ts-ignore
	const vscode = acquireVsCodeApi();

	const settingsElement = document.getElementById('settings');
	if (!settingsElement) {
		return;
	}

	const settings = JSON.parse(settingsElement.getAttribute('data-settings') || '{}');
	if (settings.isGitLfs) {
		document.body.classList.remove('loading');
		document.body.classList.add('git-lfs');
		return;
	}

	// Link click handler
	document.querySelectorAll('.open-file-link').forEach(link => {
		link.addEventListener('click', (e) => {
			e.preventDefault();
			vscode.postMessage({ type: 'reopen-as-text' });
		});
	});

	if (!settings.src) {
		document.body.classList.remove('loading');
		document.body.classList.add('error');
		return;
	}

	// Elements
	const toolbar = document.getElementById('toolbar');
	const container = document.getElementById('pdfContainer');
	const prevPageBtn = document.getElementById('prevPage');
	const nextPageBtn = document.getElementById('nextPage');
	const pageNumberInput = document.getElementById('pageNumber');
	const numPagesSpan = document.getElementById('numPages');
	const zoomInBtn = document.getElementById('zoomIn');
	const zoomOutBtn = document.getElementById('zoomOut');
	const zoomValBtn = document.getElementById('zoomVal');
	const fitWidthBtn = document.getElementById('fitWidth');
	const fitPageBtn = document.getElementById('fitPage');

	// State
	let pdfDoc = null;
	let currentScale = 1.0;
	let currentPage = 1;
	let pageWrappers = [];
	let renderedPages = new Map(); // pageNum -> renderedScale
	let pageSizes = new Map(); // pageNum -> { width, height }
	let defaultPageWidth = 595.28;
	let defaultPageHeight = 841.89;

	// Configure PDF.js worker
	// @ts-ignore
	const pdfjsLib = window.pdfjsLib;
	if (!pdfjsLib) {
		console.error('PDF.js library failed to load.');
		document.body.classList.remove('loading');
		document.body.classList.add('error');
		return;
	}

	// Disable remote workerSrc to prevent 30-second timeout caused by webview sandboxing
	pdfjsLib.GlobalWorkerOptions.workerSrc = '';

	// Load Document
	async function loadDocument() {
		try {
			console.time('PDF_FETCH');
			const response = await fetch(settings.src);
			if (!response.ok) {
				throw new Error('HTTP status ' + response.status);
			}
			const arrayBuffer = await response.arrayBuffer();
			console.timeEnd('PDF_FETCH');
			
			console.time('PDF_PARSE');
			pdfDoc = await pdfjsLib.getDocument({
				data: arrayBuffer,
				cMapUrl: undefined,
				cMapPacked: true,
			}).promise;
			console.timeEnd('PDF_PARSE');

			const numPages = pdfDoc.numPages;
			numPagesSpan.textContent = String(numPages);
			pageNumberInput.max = String(numPages);

			// Measure first page
			const firstPage = await pdfDoc.getPage(1);
			const firstViewport = firstPage.getViewport({ scale: 1.0 });
			defaultPageWidth = firstViewport.width;
			defaultPageHeight = firstViewport.height;

			// Auto fit to width by default if page is wide
			const containerWidth = container.clientWidth - 60;
			if (containerWidth > 300 && defaultPageWidth > 0) {
				currentScale = Math.min(containerWidth / defaultPageWidth, 1.25);
			}

			// Build placeholder wrappers for all pages
			buildPagePlaceholders(numPages);

			// Show UI immediately
			document.body.classList.remove('loading');
			toolbar.style.display = 'flex';
			updateZoomDisplay();

			// Immediately render Page 1 without waiting for observer
			renderPage(1);

			// Setup intersection observer for lazy rendering remaining pages
			setupIntersectionObserver();

		} catch (err) {
			console.error('Failed to render PDF document:', err);
			document.body.classList.remove('loading');
			document.body.classList.add('error');
		}
	}

	// Create placeholders for all pages
	function buildPagePlaceholders(numPages) {
		container.innerHTML = '';
		pageWrappers = [];

		for (let i = 1; i <= numPages; i++) {
			const wrapper = document.createElement('div');
			wrapper.className = 'pdf-page-wrapper';
			wrapper.id = 'page-wrapper-' + i;
			wrapper.dataset.pageNum = String(i);

			// Set initial responsive dimensions
			const width = defaultPageWidth * currentScale;
			const height = defaultPageHeight * currentScale;
			wrapper.style.width = width + 'px';
			wrapper.style.height = height + 'px';

			const canvas = document.createElement('canvas');
			canvas.id = 'page-canvas-' + i;
			wrapper.appendChild(canvas);

			container.appendChild(wrapper);
			pageWrappers.push(wrapper);
		}
	}

	// Render a single page into canvas
	const renderingPages = new Set();
	async function renderPage(pageNum) {
		if (!pdfDoc) return;
		if (renderedPages.get(pageNum) === currentScale) {
			return; // already rendered at this scale
		}
		if (renderingPages.has(pageNum)) {
			return; // currently rendering
		}

		const wrapper = pageWrappers[pageNum - 1];
		if (!wrapper) return;
		const canvas = wrapper.querySelector('canvas');
		if (!canvas) return;

		renderingPages.add(pageNum);
		try {
			const page = await pdfDoc.getPage(pageNum);
			const dpr = window.devicePixelRatio || 1;
			const viewport = page.getViewport({ scale: currentScale });

			pageSizes.set(pageNum, { width: viewport.width, height: viewport.height });
			wrapper.style.width = viewport.width + 'px';
			wrapper.style.height = viewport.height + 'px';

			canvas.width = Math.floor(viewport.width * dpr);
			canvas.height = Math.floor(viewport.height * dpr);
			canvas.style.width = viewport.width + 'px';
			canvas.style.height = viewport.height + 'px';

			const ctx = canvas.getContext('2d', { alpha: false });
			ctx.imageSmoothingEnabled = true;
			ctx.imageSmoothingQuality = 'high';

			const renderContext = {
				canvasContext: ctx,
				viewport: page.getViewport({ scale: currentScale * dpr }),
			};

			await page.render(renderContext).promise;
			renderedPages.set(pageNum, currentScale);
		} catch (err) {
			console.error(`Error rendering page ${pageNum}:`, err);
		} finally {
			renderingPages.delete(pageNum);
		}
	}

	// Lazy Rendering & Active Page Tracking
	let observer = null;
	function setupIntersectionObserver() {
		if (observer) {
			observer.disconnect();
		}

		observer = new IntersectionObserver((entries) => {
			let maxVisibleRatio = 0;
			let mostVisiblePage = currentPage;

			for (const entry of entries) {
				const pageNum = parseInt(entry.target.dataset.pageNum || '1', 10);
				if (entry.isIntersecting) {
					renderPage(pageNum);
					if (entry.intersectionRatio > maxVisibleRatio) {
						maxVisibleRatio = entry.intersectionRatio;
						mostVisiblePage = pageNum;
					}
				}
			}

			if (mostVisiblePage !== currentPage && maxVisibleRatio > 0.2) {
				currentPage = mostVisiblePage;
				pageNumberInput.value = String(currentPage);
			}
		}, {
			root: container,
			threshold: [0.05, 0.25, 0.5, 0.75, 1.0],
		});

		for (const wrapper of pageWrappers) {
			observer.observe(wrapper);
		}
	}

	// Resize all wrappers when scale changes and re-render visible pages
	function applyScaleChange() {
		renderedPages.clear();

		for (let i = 1; i <= pageWrappers.length; i++) {
			const wrapper = pageWrappers[i - 1];
			const size = pageSizes.get(i) || { width: defaultPageWidth, height: defaultPageHeight };
			wrapper.style.width = (defaultPageWidth * currentScale) + 'px';
			wrapper.style.height = (defaultPageHeight * currentScale) + 'px';
		}

		updateZoomDisplay();

		// Trigger observer check
		const visibleEntries = observer ? pageWrappers.filter(w => {
			const rect = w.getBoundingClientRect();
			return rect.bottom >= 0 && rect.top <= window.innerHeight;
		}) : [];

		for (const w of visibleEntries) {
			const num = parseInt(w.dataset.pageNum || '1', 10);
			renderPage(num);
		}
	}

	function updateZoomDisplay() {
		zoomValBtn.textContent = Math.round(currentScale * 100) + '%';
	}

	// Toolbar Interactions
	zoomInBtn.addEventListener('click', () => {
		if (currentScale < 4.0) {
			currentScale = Math.min(currentScale * 1.25, 4.0);
			applyScaleChange();
		}
	});

	zoomOutBtn.addEventListener('click', () => {
		if (currentScale > 0.25) {
			currentScale = Math.max(currentScale / 1.25, 0.25);
			applyScaleChange();
		}
	});

	zoomValBtn.addEventListener('click', () => {
		currentScale = 1.0;
		applyScaleChange();
	});

	fitWidthBtn.addEventListener('click', () => {
		const availableWidth = container.clientWidth - 60;
		if (availableWidth > 200 && defaultPageWidth > 0) {
			currentScale = availableWidth / defaultPageWidth;
			applyScaleChange();
		}
	});

	fitPageBtn.addEventListener('click', () => {
		const availableHeight = container.clientHeight - 80;
		if (availableHeight > 200 && defaultPageHeight > 0) {
			currentScale = availableHeight / defaultPageHeight;
			applyScaleChange();
		}
	});

	prevPageBtn.addEventListener('click', () => {
		if (currentPage > 1) {
			scrollToPage(currentPage - 1);
		}
	});

	nextPageBtn.addEventListener('click', () => {
		if (pdfDoc && currentPage < pdfDoc.numPages) {
			scrollToPage(currentPage + 1);
		}
	});

	pageNumberInput.addEventListener('change', () => {
		const target = parseInt(pageNumberInput.value, 10);
		if (pdfDoc && target >= 1 && target <= pdfDoc.numPages) {
			scrollToPage(target);
		} else {
			pageNumberInput.value = String(currentPage);
		}
	});

	function scrollToPage(pageNum) {
		const wrapper = document.getElementById('page-wrapper-' + pageNum);
		if (wrapper) {
			wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
			currentPage = pageNum;
			pageNumberInput.value = String(pageNum);
		}
	}

	// Start Loading
	loadDocument();
})();
