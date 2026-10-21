/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IVoiceModelService } from '../common/voiceModel.js';
import { VoiceModelService } from './voiceModelService.js';

// Register VoiceModelService singleton across Workbench
registerSingleton(IVoiceModelService, VoiceModelService, InstantiationType.Delayed);
