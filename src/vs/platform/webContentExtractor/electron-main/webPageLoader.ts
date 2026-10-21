/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { BeforeSendResponse, BrowserWindow, BrowserWindowConstructorOptions, Event, HeadersReceivedResponse, OnBeforeSendHeadersListenerDetails, OnHeadersReceivedListenerDetails } from 'electron';
import { Queue, raceTimeout, TimeoutTimer } from '../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { createSingleCallFunction } from '../../../base/common/functional.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { ILogService } from '../../log/common/log.js';
import { IAgentNetworkFilterService } from '../../networkFilter/common/networkFilterService.js';
import { IWebContentExtractorOptions, WebContentExtractResult } from '../common/webContentExtractor.js';
import { AXNode, convertAXTreeToMarkdown } from './cdpAccessibilityDomain.js';

type NetworkRequestEventParams = Readonly<{
	requestId?: string;
	request?: { url?: string };
	response?: { status?: number; statusText?: string };
	type?: string;
}>;

type FrameInfo = Readonly<{
	id: string;
	url?: string;
	name?: string;
}>;

type FrameTreeNode = Readonly<{
	frame: FrameInfo;
	childFrames?: FrameTreeNode[];
}>;

/**
 * A web page loader that uses Electron to load web pages and extract their content.
 */
export class WebPageLoader extends Disposable {
	private static readonly TIMEOUT = 30000; // 30 seconds
	private static readonly POST_LOAD_TIMEOUT = 5000; // 5 seconds - increased for dynamic content
	private static readonly FRAME_TIMEOUT = 500; // 0.5 seconds
	private static readonly EXTRACT_CONTENT_TIMEOUT = 8000; // 8 seconds
	private static readonly IDLE_DEBOUNCE_TIME = 500; // 0.5 seconds - wait after last network request
	private static readonly MIN_CONTENT_LENGTH = 100; // Minimum content length to consider extraction successful

	private readonly _window: BrowserWindow;
	private readonly _debugger: Electron.Debugger;
	private readonly _requests = new Set<string>();
	private readonly _queue = this._register(new Queue());
	private readonly _timeout = this._register(new TimeoutTimer());
	private readonly _idleDebounceTimer = this._register(new TimeoutTimer());
	private _onResult = (_result: WebContentExtractResult) => { };
	private _didFinishLoad = false;
	private _receivedMarkdown = false;

	constructor(
		browserWindowFactory: (options: BrowserWindowConstructorOptions) => BrowserWindow,
		private readonly _logger: ILogService,
		private readonly _uri: URI,
		private readonly _options: IWebContentExtractorOptions | undefined,
		private readonly _isTrustedDomain: (uri: URI) => boolean,
		private readonly _agentNetworkFilterService: IAgentNetworkFilterService,
	) {
		super();

		this._window = browserWindowFactory({
			width: 1440,
			height: 2560,
			show: false,
			webPreferences: {
				partition: this._options?.partition || 'persist:vscode-browser',
				javascript: true,
				offscreen: true,
				sandbox: true,
				webgl: false,
			}
		});

		this._register(toDisposable(() => this._window.destroy()));

		this._debugger = this._window.webContents.debugger;
		this._debugger.attach('1.1');
		this._debugger.on('message', this.onDebugMessage.bind(this));

		this._window.webContents
			.once('did-start-loading', this.onStartLoading.bind(this))
			.once('did-finish-load', this.onFinishLoad.bind(this))
			.once('did-fail-load', this.onFailLoad.bind(this))
			.on('will-navigate', this.onRedirect.bind(this))
			.on('will-redirect', this.onRedirect.bind(this))
			.on('select-client-certificate', (event) => event.preventDefault());

		this._window.webContents.session.webRequest.onBeforeSendHeaders(
			this.onBeforeSendHeaders.bind(this));

		this._window.webContents.session.webRequest.onHeadersReceived(
			this.onHeadersReceived.bind(this));

		this._window.webContents.session.on('will-download', this.onDownload.bind(this));
	}

	private trace(message: string) {
		this._logger.trace(`[WebPageLoader] [${this._uri}] ${message}`);
	}

	/**
	 * Loads the web page and extracts its content.
	 */
	public async load() {
		return await new Promise<WebContentExtractResult>((resolve) => {
			this._onResult = createSingleCallFunction((result) => {
				switch (result.status) {
					case 'ok':
						this.trace(`Loaded web page content, status: ${result.status}, title: '${result.title}', length: ${result.result.length}`);
						break;
					case 'redirect':
						this.trace(`Loaded web page content, status: ${result.status}, toURI: ${result.toURI}`);
						break;
					case 'error':
						this.trace(`Loaded web page content, status: ${result.status}, code: ${result.statusCode}, error: '${result.error}', title: '${result.title}', length: ${result.result?.length ?? 0}`);
						break;
				}

				const content = result.status !== 'redirect' ? result.result : undefined;
				if (content !== undefined) {
					this.trace(content.length < 200 ? `Extracted content: '${content}'` : `Extracted content preview: '${content.substring(0, 200)}...'`);
				}

				resolve(result);
				this.dispose();
			});

			this.trace(`Loading web page content`);
			void this._window.loadURL(this._uri.toString(true));
			this.setTimeout(WebPageLoader.TIMEOUT);
		});
	}

	/**
	 * Sets a timeout to trigger content extraction regardless of current loading state.
	 */
	private setTimeout(time: number) {
		if (this._store.isDisposed) {
			return;
		}

		this.trace(`Setting page load timeout to ${time} ms`);
		this._timeout.cancelAndSet(() => {
			this.trace(`Page load timeout reached`);
			void this._queue.queue(() => this.extractContent());
		}, time);
	}

	/**
	 * Updates HTTP headers for each web request.
	 */
	private onBeforeSendHeaders(details: OnBeforeSendHeadersListenerDetails, callback: (beforeSendResponse: BeforeSendResponse) => void) {
		const headers = { ...details.requestHeaders };

		// Request privacy for web-sites that respect these.
		headers['DNT'] = '1';
		headers['Sec-GPC'] = '1';

		// For the main document request, use standard modern browser Accept header
		if (details.resourceType === 'mainFrame') {
			headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
		}

		callback({ requestHeaders: headers });
	}

	/**
	 * Checks response headers for download-triggering Content-Disposition.
	 * For text-based content types, replaces it with 'inline' so the content
	 * is rendered and can be extracted. For binary content, cancels the response.
	 */
	private onHeadersReceived(details: OnHeadersReceivedListenerDetails, callback: (headersReceivedResponse: HeadersReceivedResponse) => void) {
		const headers = details.responseHeaders;
		if (headers) {
			let hasAttachment = false;
			let attachmentHeaderName: string | undefined;
			let contentType: string | undefined;

			for (const name of Object.keys(headers)) {
				const lowerName = name.toLowerCase();
				if (lowerName === 'content-disposition' && headers[name]?.some(v => v.toLowerCase().includes('attachment'))) {
					hasAttachment = true;
					attachmentHeaderName = name;
				}
				if (lowerName === 'content-type') {
					contentType = headers[name]?.[0]?.toLowerCase();
				}
			}

			// Track whether the current main-frame response is markdown (redirects can change content-type)
			if (details.resourceType === 'mainFrame') {
				this._receivedMarkdown = contentType?.split(';')[0].trim() === 'text/markdown';
				if (this._receivedMarkdown) {
					this.trace('Received text/markdown response, will extract document text content directly');
				}
			}

			if (hasAttachment && attachmentHeaderName) {
				if (this.isTextMimeType(contentType)) {
					this.trace(`Replacing Content-Disposition: attachment with inline for ${details.url} (content-type: ${contentType})`);
					headers[attachmentHeaderName] = ['inline'];
					callback({ responseHeaders: headers, cancel: false });
				} else {
					this.trace(`Blocked binary download (Content-Disposition: attachment, content-type: ${contentType}) for ${details.url}`);
					callback({ cancel: true });
				}
				return;
			}
		}
		callback({ cancel: false });
	}

	/**
	 * Returns whether the given MIME type represents text-based content
	 * that can be meaningfully rendered and extracted.
	 */
	private static readonly TEXT_MIME_TYPE_RE = /^(?:text\/|application\/(?:json|xml|xhtml\+xml|rss\+xml|atom\+xml|svg\+xml|javascript|ecmascript|x-yaml|yaml|toml|.*\+(?:xml|json))$)/;

	private isTextMimeType(contentType: string | undefined): boolean {
		const mimeType = contentType?.split(';')[0].trim();
		return !!mimeType && WebPageLoader.TEXT_MIME_TYPE_RE.test(mimeType);
	}

	/**
	 * Handles the 'will-download' event, blocking any downloads.
	 */
	private onDownload(_event: Event, item: Electron.DownloadItem) {
		const filename = item.getFilename();
		this.trace(`Blocked download: ${filename}`);
		item.cancel();
		void this._queue.queue(() => this.extractContent({ status: 'error', error: `Download not allowed: ${filename}` }));
	}

	/**
	 * Handles the 'did-start-loading' event, enabling network tracking.
	 */
	private onStartLoading() {
		if (this._store.isDisposed) {
			return;
		}

		this.trace(`Received 'did-start-loading' event`);
		void this._debugger.sendCommand('Network.enable').catch(() => {
			// This throws when we destroy the window on redirect.
		});
	}

	/**
	 * Handles the 'did-finish-load' event, checking for idle state
	 * and updating timeout to allow for post-load activities.
	 */
	private onFinishLoad() {
		if (this._store.isDisposed) {
			return;
		}

		this.trace(`Received 'did-finish-load' event`);
		this._didFinishLoad = true;
		this.scheduleIdleCheck();
		this.setTimeout(WebPageLoader.POST_LOAD_TIMEOUT);
	}

	/**
	 * Handles the 'did-fail-load' event, reporting load failures.
	 */
	private onFailLoad(_event: Event, statusCode: number, error: string) {
		if (this._store.isDisposed) {
			return;
		}

		this.trace(`Received 'did-fail-load' event, code: ${statusCode}, error: '${error}'`);
		if (statusCode === -3) {
			this.trace(`Ignoring ERR_ABORTED (-3) as it may be caused by CSP or other measures`);
			void this._queue.queue(() => this.extractContent());
		} else if (statusCode === -27) {
			this.trace(`Ignoring ERR_BLOCKED_BY_CLIENT (-27) as it may be caused by ad-blockers or similar extensions`);
			void this._queue.queue(() => this.extractContent());
		} else {
			void this._queue.queue(() => this.extractContent({ status: 'error', statusCode, error }));
		}
	}

	/**
	 * Handles the 'will-navigate' and 'will-redirect' events, managing redirects.
	 */
	private onRedirect(event: Event, url: string) {
		if (this._store.isDisposed) {
			return;
		}

		this.trace(`Received 'will-navigate' or 'will-redirect' event, url: ${url}`);

		// Check domain filter policy first — this applies regardless of followRedirects
		const toURI = URI.parse(url);
		if (!this._agentNetworkFilterService.isUriAllowed(toURI)) {
			this.trace(`Blocking navigation to ${url} (blocked by domain filter policy)`);
			event.preventDefault();
			this._onResult({ status: 'error', error: this._agentNetworkFilterService.formatError(toURI) });
			return;
		}

		if (!this._options?.followRedirects) {
			// Allow redirect if authority is the same when ignoring www prefix
			if (this.normalizeAuthority(toURI.authority) === this.normalizeAuthority(this._uri.authority)) {
				return;
			}

			// Allow redirect if target is a trusted domain
			if (this._isTrustedDomain(toURI)) {
				return;
			}

			// Ignore script-initiated navigation (ads/trackers etc)
			if (this._didFinishLoad) {
				this.trace(`Blocking post-load navigation to ${url} (likely ad/tracker script)`);
				event.preventDefault();
				return;
			}

			// Otherwise, prevent redirect and report it
			event.preventDefault();
			this._onResult({ status: 'redirect', toURI });
		}
	}

	/**
	 * Normalizes an authority by removing the 'www.' prefix if present.
	 */
	private normalizeAuthority(authority: string): string {
		return authority.toLowerCase().replace(/^www\./, '');
	}

	/**
	 * Handles debugger messages related to network requests, tracking their lifecycle.
	 * @note DO NOT add logging to this function, microsoft.com will freeze when too many logs are generated
	 */
	private onDebugMessage(_event: Event, method: string, params: NetworkRequestEventParams) {
		if (this._store.isDisposed) {
			return;
		}

		const { requestId, type, response } = params;
		switch (method) {
			case 'Network.requestWillBeSent':
				if (requestId !== undefined) {
					this._requests.add(requestId);
					this._idleDebounceTimer.cancel();
				}
				break;
			case 'Network.loadingFinished':
			case 'Network.loadingFailed':
				if (requestId !== undefined) {
					this._requests.delete(requestId);
					if (this._requests.size === 0 && this._didFinishLoad) {
						this.scheduleIdleCheck();
					}
				}
				break;
			case 'Network.responseReceived':
				if (type === 'Document') {
					const statusCode = response?.status ?? 0;
					if (statusCode >= 400) {
						const error = response?.statusText || `HTTP error ${statusCode}`;
						void this._queue.queue(() => this.extractContent({ status: 'error', statusCode, error }));
					}
				}
				break;
		}
	}

	/**
	 * Schedules an idle check after a debounce period to allow for bursts of network activity.
	 * If idle is detected, proceeds to extract content.
	 */
	private scheduleIdleCheck() {
		if (this._store.isDisposed) {
			return;
		}

		this._idleDebounceTimer.cancelAndSet(async () => {
			if (this._store.isDisposed) {
				return;
			}

			await this.nextFrame();

			if (this._requests.size === 0) {
				this._queue.queue(() => this.extractContent());
			} else {
				this.trace(`New network requests detected, deferring content extraction`);
			}
		}, WebPageLoader.IDLE_DEBOUNCE_TIME);
	}

	/**
	 * Waits for a rendering frame to ensure the page had a chance to update.
	 */
	private async nextFrame() {
		if (this._store.isDisposed) {
			return;
		}

		// Wait for a rendering frame to ensure the page had a chance to update.
		await raceTimeout(
			new Promise<void>((resolve) => {
				try {
					this.trace(`Waiting for a frame to be rendered`);
					this._window.webContents.beginFrameSubscription(false, () => {
						try {
							this.trace(`A frame has been rendered`);
							this._window.webContents.endFrameSubscription();
						} catch {
							// ignore errors
						}
						resolve();
					});
				} catch {
					// ignore errors
					resolve();
				}
			}),
			WebPageLoader.FRAME_TIMEOUT
		);
	}

	/**
	 * Extracts the content of the loaded web page using the Accessibility domain and reports the result.
	 */
	private async extractContent(errorResult?: WebContentExtractResult & { status: 'error' }) {
		if (this._store.isDisposed) {
			return;
		}

		try {
			const title = this._window.webContents.getTitle();

			let result = '';
			const cts = new CancellationTokenSource();
			try {
				await raceTimeout((async () => {
					// If the server returned text/markdown, the document is already plain text.
					// Extract it directly from the document instead of running accessibility/DOM heuristics.
					if (this._receivedMarkdown) {
						this.trace('Extracting markdown text content from document');
						result = await this._window.webContents.executeJavaScript('document.body?.textContent ?? document.documentElement?.textContent ?? ""') ?? '';
						return;
					}

					let jobListSummary = '';
					try {
						jobListSummary = await this.extractJobListContent();
					} catch {}

					if (!cts.token.isCancellationRequested) {
						result = await this.extractAccessibilityTreeContent(cts.token) ?? '';
					}

					if (!cts.token.isCancellationRequested && result.length < WebPageLoader.MIN_CONTENT_LENGTH) {
						this.trace(`Accessibility tree extraction yielded insufficient content, trying main DOM element extraction`);
						const domContent = await this.extractMainDomElementContent() ?? '';
						result = domContent.length > result.length ? domContent : result;
					}

					if (jobListSummary) {
						result = jobListSummary + result;
					}
				})(), WebPageLoader.EXTRACT_CONTENT_TIMEOUT);
			} finally {
				cts.cancel();
				cts.dispose();
			}

			if (result.length === 0) {
				this._onResult({ status: 'error', error: 'Failed to extract meaningful content from the web page' });
			} else if (errorResult !== undefined) {
				this._onResult({ ...errorResult, result, title });
			} else {
				this._onResult({ status: 'ok', result, title });
			}
		} catch (e) {
			if (errorResult !== undefined) {
				this._onResult(errorResult);
			} else {
				this._onResult({
					status: 'error',
					error: e instanceof Error ? e.message : String(e)
				});
			}
		}
	}

	/**
	 * Extracts content from the Accessibility tree of the loaded web page.
	 * @param token Cancellation token to abort the operation.
	 * @return The extracted content, or undefined if extraction fails or is cancelled.
	 */
	private async extractAccessibilityTreeContent(token: CancellationToken): Promise<string | undefined> {
		this.trace(`Extracting content using Accessibility domain`);
		try {
			// Enable the Page domain to get frame information
			await this._debugger.sendCommand('Page.enable');
			if (token.isCancellationRequested) {
				return undefined;
			}

			// Get all frames including iframes
			const { frameTree } = await this._debugger.sendCommand('Page.getFrameTree') as { frameTree: FrameTreeNode };
			if (token.isCancellationRequested) {
				return undefined;
			}

			const frameNodes = [frameTree];
			for (let i = 0; i < frameNodes.length; i++) {
				frameNodes.push(...frameNodes[i].childFrames ?? []);
			}

			// Collect accessibility nodes from all frames
			const allNodes: AXNode[] = [];
			for (const { frame } of frameNodes) {
				try {
					const { nodes } = await this._debugger.sendCommand('Accessibility.getFullAXTree', { frameId: frame.id }) as { nodes: AXNode[] };
					allNodes.push(...nodes);
					if (token.isCancellationRequested) {
						return undefined;
					}
				} catch {
					// ignore
				}
			}

			return convertAXTreeToMarkdown(this._uri, allNodes);
		} catch (error) {
			this.trace(`Accessibility tree extraction failed: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	/**
	 * Fallback method for extracting web page content when Accessibility tree extraction yields insufficient content.
	 * Attempts to extract meaningful text content from the main DOM elements of the loaded web page.
	 * @returns The extracted text content, or undefined if extraction fails.
	 */
	private async extractMainDomElementContent(): Promise<string | undefined> {
		try {
			this.trace(`Extracting content from main DOM element`);
			return await this._window.webContents.executeJavaScript(`
				(() => {
					const selectors = ['main','article','[role="main"]','.main-content','#main-content','.article-body','.post-content','.entry-content','.content','body'];
					for (const selector of selectors) {
						const content = document.querySelector(selector)?.textContent?.replace(/[ \\t]+/g, ' ').replace(/\\s{2,}/gm, '\\n').trim();
						if (content && content.length > ${WebPageLoader.MIN_CONTENT_LENGTH}) {
							return content;
						}
					}
					return undefined;
				})();
			`);
		} catch (error) {
			this.trace(`DOM extraction failed: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	/**
	 * Automatically extracts structured job search results (including Job ID, Title, Company, Location, Compensation, and Direct Links)
	 * from job portals such as LinkedIn and Indeed, ensuring full coverage without virtual occlusion.
	 */
	private async extractJobListContent(): Promise<string> {
		try {
			const script = `
				(() => {
					try {
						// 1. Scroll potential job list containers to trigger virtual list rendering
						const scrollables = document.querySelectorAll(
							'.jobs-search-results-list, .scaffold-layout__list, .scaffold-layout__list-container, [data-view-name*="job"], ul.jobs-search__results-list, main'
						);
						scrollables.forEach(s => {
							try { s.scrollTop = s.scrollHeight; } catch {}
						});

						const jobs = [];
						const seenIds = new Set();
						const seenTitles = new Set();

						function addJob(job) {
							if (!job) return;
							const id = (job.jobId || '').trim();
							let title = (job.title || '').replace(/[ \\t\\r\\n]+/g, ' ').replace(/\\(Verified job\\)/gi, '').replace(/^Selected,\\s*/i, '').trim();
							if (!title && !id) return;

							// Filter out common non-job page buttons and navigation anchors
							if (/^(share negative feedback|try premium|about|accessibility|help center|privacy|terms|ad choices|advertising|business services|get the linkedin app|linkedin corporation|are these results helpful|more|notifications|jobs|messaging|home|my network)$/i.test(title)) {
								return;
							}
							if (title.length < 3 || title.length > 140) return;

							if (id && seenIds.has(id)) {
								const existing = jobs.find(j => j.jobId === id);
								if (existing) {
									if ((!existing.title || existing.title === 'Job Posting') && title) existing.title = title;
									if ((!existing.company || existing.company === 'Unknown Company') && job.company) existing.company = job.company;
									if (!existing.location && job.location) existing.location = job.location;
									if (!existing.salary && job.salary) existing.salary = job.salary;
								}
								return;
							}
							if (id) seenIds.add(id);

							const key = title.toLowerCase() + '|' + (job.company || '').toLowerCase();
							if (!id && seenTitles.has(key)) return;
							if (key) seenTitles.add(key);

							const directLink = id
								? ('https://www.linkedin.com/jobs/view/' + id + '/')
								: (job.link && job.link.startsWith('http') ? job.link : (job.link ? ('https://www.linkedin.com' + job.link) : ''));

							jobs.push({
								jobId: id || 'N/A',
								title: title || 'Job Posting',
								company: (job.company || '').replace(/[ \\t\\r\\n]+/g, ' ').trim() || 'Unknown Company',
								location: (job.location || '').replace(/[ \\t\\r\\n]+/g, ' ').trim(),
								salary: (job.salary || '').replace(/[ \\t\\r\\n]+/g, ' ').trim(),
								link: directLink
							});
						}

						// 2. Parse BigPipe data blocks (contains exact Voyager JobPosting data)
						const codeTags = document.querySelectorAll('code[id^="bpr-guid-"], script[type="application/json"], script[type="application/ld+json"]');
						codeTags.forEach(code => {
							try {
								let text = (code.textContent || '').trim();
								if (text.startsWith('<!--')) {
									text = text.replace(/^<!--+/, '').replace(/--+>$/, '').trim();
								}
								if (!text.startsWith('{') && !text.startsWith('[')) return;
								const parsed = JSON.parse(text);
								const included = parsed.included || (Array.isArray(parsed.data) ? parsed.data : (parsed.data ? [parsed.data] : []));
								if (!Array.isArray(included)) return;

								included.forEach(item => {
									if (!item) return;
									const urn = item.entityUrn || item.urn || '';
									const m = urn.match(/jobPosting(?:Card)?:([0-9]{8,})/i) || urn.match(/([0-9]{8,})/);
									if (!m) return;
									const jobId = m[1];

									const rawTitle = (
										(typeof item.title === 'string' ? item.title : item.title?.text) ||
										(typeof item.jobPostingTitle === 'string' ? item.jobPostingTitle : item.jobPostingTitle?.text) ||
										item.heading?.text ||
										item.titleV2?.text ||
										''
									);
									const rawComp = (
										item.primaryDescription?.text ||
										item.companyDetails?.companyName ||
										item.subtitle?.text ||
										item.companyName ||
										''
									);
									const rawLoc = (
										item.secondaryDescription?.text ||
										item.formattedLocation ||
										item.location ||
										item.tertiaryDescription?.text ||
										''
									);
									const rawSalary = (
										item.salaryResolutionResult?.text ||
										item.salaryAttribute?.text ||
										item.compensation?.text ||
										''
									);

									if (jobId && (rawTitle || rawComp)) {
										addJob({ jobId, title: rawTitle, company: rawComp, location: rawLoc, salary: rawSalary, link: '' });
									}
								});
							} catch {}
						});

						// 3. Regex scan over all embedded code/script content as deep fallback
						const allScriptsText = Array.from(document.querySelectorAll('code, script')).map(c => c.textContent || '').join('\\n');
						const fsdRegex = /"(?:entityUrn|urn)":"urn:li:(?:fsd_)?jobPosting(?:Card)?:([0-9]{8,})[^"]*"/g;
						let fsdMatch;
						while ((fsdMatch = fsdRegex.exec(allScriptsText)) !== null) {
							const jobId = fsdMatch[1];
							if (seenIds.has(jobId)) continue;
							const idx = fsdMatch.index;
							const snippet = allScriptsText.slice(Math.max(0, idx - 500), Math.min(allScriptsText.length, idx + 2000));
							const tM = snippet.match(/"(?:jobPostingTitle|title)":\{"text":"([^"]+)"\}|"(?:jobPostingTitle|title)":"([^"]+)"/);
							const cM = snippet.match(/"(?:companyName|primaryDescription)":\{"text":"([^"]+)"\}|"(?:companyName|primaryDescription)":"([^"]+)"/);
							const lM = snippet.match(/"(?:formattedLocation|secondaryDescription)":\{"text":"([^"]+)"\}|"(?:formattedLocation|secondaryDescription)":"([^"]+)"/);
							if (jobId) {
								addJob({
									jobId,
									title: tM ? (tM[1] || tM[2] || '') : '',
									company: cM ? (cM[1] || cM[2] || '') : '',
									location: lM ? (lM[1] || lM[2] || '') : ''
								});
							}
						}

						// 4. Scan rendered DOM cards (li items, base-card, job-search-card)
						const cardElements = document.querySelectorAll(
							'li, div.base-card, div.job-search-card, [data-view-name*="job"], div[data-occludable-job-id], div[data-job-id]'
						);
						cardElements.forEach(card => {
							try {
								const text = card.innerText || '';
								if (text.length < 15 || text.length > 1200) return;
								const hasJobIndicator = text.includes('Verified job') ||
									card.hasAttribute('data-occludable-job-id') ||
									card.hasAttribute('data-job-id') ||
									/\\b(CAD\\/yr|USD\\/yr|\\/yr|\\/hr|Posted|Applied|Viewed|Easy Apply)\\b/i.test(text);
								if (!hasJobIndicator) return;

								let jobId = card.getAttribute('data-job-id') || card.getAttribute('data-occludable-job-id') || '';
								if (!jobId) {
									const innerEl = card.querySelector('[data-job-id], [data-occludable-job-id], [data-entity-urn*="jobPosting"]');
									if (innerEl) {
										jobId = innerEl.getAttribute('data-job-id') || innerEl.getAttribute('data-occludable-job-id') || '';
										if (!jobId) {
											const m = (innerEl.getAttribute('data-entity-urn') || '').match(/([0-9]{8,})/);
											if (m) jobId = m[1];
										}
									}
								}
								if (!jobId) {
									const links = card.querySelectorAll('a[href]');
									for (const a of links) {
										const h = a.getAttribute('href') || '';
										const m = h.match(/\\/jobs\\/view\\/([0-9]{8,})/i) || h.match(/currentJobId=([0-9]{8,})/i);
										if (m) { jobId = m[1]; break; }
									}
								}

								const lines = text.split('\\n')
									.map(l => l.trim())
									.filter(l => l.length > 0 && !/^(Viewed|Applied|Actively reviewing|Easy Apply|Be an early applicant|How promoted jobs are ranked)$/i.test(l));

								if (lines.length === 0) return;
								let title = lines[0].replace(/\\(Verified job\\)/gi, '').replace(/^Selected,\\s*/i, '').trim();
								let company = lines.length > 1 ? lines[1].trim() : '';
								let location = lines.length > 2 ? lines[2].trim() : '';
								let salary = '';
								for (let i = 3; i < lines.length; i++) {
									if (/CAD\\/yr|USD\\/yr|\\/yr|\\/hr|\\$/i.test(lines[i])) {
										salary = lines[i].trim();
										break;
									}
								}

								const titleEl = card.querySelector('h3, strong, a.job-card-list__title, [class*="title"]');
								if (titleEl && titleEl.innerText.trim().length > 3) {
									title = titleEl.innerText.replace(/\\(Verified job\\)/gi, '').replace(/^Selected,\\s*/i, '').trim();
								}
								const compEl = card.querySelector('h4, [class*="company"], [class*="primary-description"]');
								if (compEl && compEl.innerText.trim()) {
									company = compEl.innerText.trim();
								}
								const locEl = card.querySelector('[class*="location"], [class*="metadata"]');
								if (locEl && locEl.innerText.trim()) {
									location = locEl.innerText.trim();
								}

								if (title && (jobId || company)) {
									addJob({ jobId, title, company, location, salary, link: '' });
								}
							} catch {}
						});

						// 5. Correlate unassigned DOM titles with unassigned Job IDs if any exist
						const unassignedIds = Array.from(seenIds).filter(id => {
							const j = jobs.find(job => job.jobId === id);
							return j && (!j.title || j.title === 'Job Posting');
						});
						const unassignedJobs = jobs.filter(j => j.jobId === 'N/A' && j.title && j.title !== 'Job Posting');
						for (let i = 0; i < Math.min(unassignedIds.length, unassignedJobs.length); i++) {
							unassignedJobs[i].jobId = unassignedIds[i];
							unassignedJobs[i].link = 'https://www.linkedin.com/jobs/view/' + unassignedIds[i] + '/';
						}

						// Remove any items that are still 'N/A' if we have enough identified jobs, or keep them with directLink
						return jobs;
					} catch {
						return [];
					}
				})()
			`;

			const jobs = await this._window.webContents.executeJavaScript(script);
			if (!Array.isArray(jobs) || jobs.length === 0) {
				this.trace('Structured job listing extraction found 0 jobs');
				return '';
			}

			this.trace(`Structured job listing extraction found ${jobs.length} jobs`);
			let md = `## Extracted Job Listings (${jobs.length} Jobs Found)\n\n`;
			md += `| # | Job ID | Job Title | Company | Location | Compensation | Direct Link |\n`;
			md += `|---|---|---|---|---|---|---|\n`;
			for (let i = 0; i < jobs.length; i++) {
				const j = jobs[i];
				const title = j.title || 'Job Posting';
				const company = j.company || 'Unknown Company';
				const loc = j.location || '-';
				const sal = j.salary || '-';
				const link = j.link || `https://www.linkedin.com/jobs/view/${j.jobId}/`;
				md += `| ${i + 1} | ${j.jobId} | ${title} | ${company} | ${loc} | ${sal} | [${title}](${link}) |\n`;
			}
			md += `\n---\n\n`;
			return md;
		} catch (error) {
			this.trace(`Structured job listing extraction failed: ${error instanceof Error ? error.message : String(error)}`);
			return '';
		}
	}
}
