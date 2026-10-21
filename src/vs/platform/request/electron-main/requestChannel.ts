/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { session } from 'electron';
import { streamToBuffer, VSBuffer } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Event } from '../../../base/common/event.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IHeaders, IRequestOptions } from '../../../base/parts/request/common/request.js';
import { IRequestService } from '../common/request.js';

type RequestResponse = [
	{
		headers: IHeaders;
		statusCode?: number;
	},
	VSBuffer
];

export class ElectronRequestChannel implements IServerChannel {

	constructor(private readonly service: IRequestService) { }

	listen(context: any, event: string): Event<any> {
		throw new Error('Invalid listen');
	}

	async call(context: any, command: string, args?: any, token: CancellationToken = CancellationToken.None): Promise<any> {
		switch (command) {
			case 'request': {
				const options: IRequestOptions = args[0] || {};
				if (options && options.url) {
					try {
						// Retrieve session cookies from integrated browser (persist:vscode-browser) and default session
						const partitionSession = session.fromPartition('persist:vscode-browser');
						const [pCookies, dCookies] = await Promise.all([
							partitionSession.cookies.get({ url: options.url }).catch(() => []),
							session.defaultSession.cookies.get({ url: options.url }).catch(() => [])
						]);

						const cookieMap = new Map<string, string>();
						for (const c of dCookies) {
							if (c && c.name && c.value) {
								cookieMap.set(c.name, c.value);
							}
						}
						for (const c of pCookies) {
							if (c && c.name && c.value) {
								cookieMap.set(c.name, c.value);
							}
						}

						if (cookieMap.size > 0) {
							options.headers = options.headers || {};
							if (!options.headers['Cookie']) {
								options.headers['Cookie'] = Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
							}
							if (cookieMap.has('JSESSIONID') && !options.headers['csrf-token']) {
								options.headers['csrf-token'] = cookieMap.get('JSESSIONID')!.replace(/^"|"$/g, '');
							}
						}
					} catch {
						// Cookie extraction failed, proceed with normal request
					}
				}

				const { res, stream } = await this.service.request(options, token);
				const buffer = await streamToBuffer(stream);
				return <RequestResponse>[{ statusCode: res.statusCode, headers: res.headers }, buffer];
			}
			case 'resolveProxy': return this.service.resolveProxy(args[0]);
			case 'lookupAuthorization': return this.service.lookupAuthorization(args[0]);
			case 'lookupKerberosAuthorization': return this.service.lookupKerberosAuthorization(args[0]);
			case 'loadCertificates': return this.service.loadCertificates();
		}
		throw new Error('Invalid call');
	}
}
