/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IVoiceModelService } from '../common/voiceModel.js';
import { VoiceModelService } from './voiceModelService.js';

// Register VoiceModelService singleton across Workbench
registerSingleton(IVoiceModelService, VoiceModelService, InstantiationType.Delayed);
