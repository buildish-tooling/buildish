/*
 * Copyright 2026 The Apache Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as toolkitCache from '@actions/cache';

import {
  STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
  type BaseCacheBackend,
} from '../../storage/cache';

export function createGitHubBaseCacheBackend(
  cacheBackend: Pick<
    BaseCacheBackend,
    'isFeatureAvailable' | 'restoreCache' | 'saveCache'
  > = toolkitCache,
): BaseCacheBackend {
  return {
    capabilities: STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
    isFeatureAvailable(): boolean {
      return cacheBackend.isFeatureAvailable();
    },
    async restoreCache(paths: string[], primaryKey: string, restoreKeys?: string[]) {
      return await cacheBackend.restoreCache(paths, primaryKey, restoreKeys);
    },
    async saveCache(paths: string[], key: string) {
      return await cacheBackend.saveCache(paths, key);
    },
  };
}
