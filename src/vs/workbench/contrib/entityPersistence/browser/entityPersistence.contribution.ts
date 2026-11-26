/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IEntityPersistenceService } from '../common/entityPersistence.js';
import { EntityPersistenceService } from './entityPersistenceService.js';

registerSingleton(IEntityPersistenceService, EntityPersistenceService, InstantiationType.Eager);
