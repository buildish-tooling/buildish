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
 * Provider adapters may map this to toolkit- or service-specific cache APIs, but shared
 * orchestration should depend only on this narrower backend seam.
 */
export interface BaseCacheBackendCapabilities {
  /** Whether the backend supports restore-key fallback/prefix matching beyond the exact key. */
  readonly supportsRestoreKeys: boolean;
  /** Whether the backend supports explicit save calls from shared post-action logic. */
  readonly supportsExplicitSave: boolean;
}

/** Capability set for a fully programmatic cache backend such as GitHub Actions cache. */
export const STANDARD_BASE_CACHE_BACKEND_CAPABILITIES: BaseCacheBackendCapabilities = {
  supportsRestoreKeys: true,
  supportsExplicitSave: true,
};

export interface BaseCacheBackend {
  /** Declares optional cache features that shared orchestration may need to branch on. */
  readonly capabilities: BaseCacheBackendCapabilities;
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
