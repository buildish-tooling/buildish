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

/**
 * Minimal provider-neutral base-cache backend contract.
 *
 * The current GitHub implementation maps this to `@actions/cache`, but shared orchestration should
 * depend only on this narrower backend seam.
 */
export interface BaseCacheBackend {
  /** Reports whether the active cache backend is usable in the current environment. */
  isFeatureAvailable(): boolean;
  /** Attempts to restore one cache entry for the given exact key and optional prefix keys. */
  restoreCache(
    paths: string[],
    primaryKey: string,
    restoreKeys?: string[],
  ): Promise<string | undefined>;
  /** Attempts to create a new cache entry for the given key. */
  saveCache(paths: string[], key: string): Promise<number>;
}
