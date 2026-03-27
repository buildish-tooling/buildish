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

import type { NormalizedActionConfig } from '../config/types';

import { DEFAULT_CACHE_KEY_TEMPLATE, type CacheModel } from './model';

const POST_ACTION_ARMED_STATE = 'buildish-mammoth-cache-gradle-base-cache-armed';
const REF_NAME_PLACEHOLDER = '${refName}';
const NO_CACHE_PATHS_FOUND_ERROR_FRAGMENT =
  'Path Validation Error: Path(s) specified in the action for caching do(es) not exist';

/**
 * Minimal wrapper around `@actions/cache` so restore/save behavior can be tested deterministically.
 *
 * The production implementation is the toolkit module itself; tests inject lightweight fakes so
 * restore/save classification can be exercised without the GitHub cache runtime.
 */
export interface BaseCacheApi {
  /**
   * Reports whether the GitHub cache runtime is usable in the current execution environment.
   *
   * Returns `false` in local smoke runs or unsupported runners; restore/save then degrade to a
   * documented skip result instead of failing.
   */
  isFeatureAvailable(): boolean;
  /**
   * Attempts to restore the cache for the primary key and optional prefix fallback keys.
   *
   * @param paths Ordered include paths plus negated excludes in the `@actions/cache` format.
   * @param primaryKey Exact cache key for the current job.
   * @param restoreKeys Optional ordered prefix keys used after a primary-key miss.
   * @returns The matched cache key, or `undefined` when nothing was restored.
   */
  restoreCache(
    paths: string[],
    primaryKey: string,
    restoreKeys?: string[],
  ): Promise<string | undefined>;
  /**
   * Attempts to create a new cache entry for the given key.
   *
   * @param paths Ordered include paths plus negated excludes in the `@actions/cache` format.
   * @param key Exact cache key to reserve and save.
   * @returns Positive cache ID on success; non-positive values indicate no new entry was created.
   */
  saveCache(paths: string[], key: string): Promise<number>;
}

/**
 * Optional test seams for the base cache service.
 */
export interface BaseCacheServiceDependencies {
  /** Cache implementation override used by tests and local smoke flows. */
  readonly cacheApi: BaseCacheApi;
}

/**
 * Result of restoring the base cache before the workflow's Gradle work begins.
 *
 * `status` distinguishes exact reuse of the primary key from broader prefix fallback so later
 * orchestration can make policy decisions without reinterpreting raw toolkit return values.
 */
export interface BaseCacheRestoreResult {
  /** Discriminator for bootstrap consumers; always `restore` for this result shape. */
  readonly operation: 'restore';
  /**
   * Restore outcome classification.
   *
   * Valid values:
   * - `feature-unavailable`: cache service unavailable in this environment
   * - `miss`: no cache matched
   * - `exact-hit`: exact primary key match restored
   * - `partial-hit`: a prefix restore key matched instead of the primary key
   */
  readonly status: 'feature-unavailable' | 'miss' | 'exact-hit' | 'partial-hit';
  /** Primary cache key derived for the current job. */
  readonly cacheKey: string;
  /** Key actually restored by the cache service, if any. */
  readonly matchedKey: string | null;
  /** Prefix fallback keys attempted after the primary key miss. */
  readonly restoreKeys: readonly string[];
  /** Ordered cache path list passed to `@actions/cache`, including negated excludes. */
  readonly paths: readonly string[];
  /** Human-readable summary suitable for logs and job summaries. */
  readonly message: string;
}

/**
 * Result of saving the base cache from the action post phase.
 *
 * Non-`saved` statuses are intentional control-flow outcomes, not necessarily errors. In
 * particular, save is skipped in modes that would create unsafe or redundant concurrent writers.
 */
export interface BaseCacheSaveResult {
  /** Discriminator for bootstrap consumers; always `save` for this result shape. */
  readonly operation: 'save';
  /**
   * Save outcome classification.
   *
   * Valid values:
   * - `not-armed`: post phase was not paired with an armed main phase
   * - `read-only`: config forbids writes
   * - `distributed-worker`: worker jobs do not save shared base caches
   * - `feature-unavailable`: cache service unavailable in this environment
   * - `missing-paths`: no configured cache paths currently exist on disk, so save is skipped
   * - `saved`: a new cache entry was created
   * - `not-saved`: toolkit ran but did not create a new cache entry
   */
  readonly status:
    | 'not-armed'
    | 'read-only'
    | 'distributed-worker'
    | 'feature-unavailable'
    | 'missing-paths'
    | 'saved'
    | 'not-saved';
  /** Primary cache key that the post phase attempted, or would have attempted, to save. */
  readonly cacheKey: string;
  /** Cache identifier returned by GitHub when a new entry is successfully created. */
  readonly cacheId: number | null;
  /** Ordered cache path list passed to `@actions/cache`, including negated excludes. */
  readonly paths: readonly string[];
  /** Human-readable summary suitable for logs and job summaries. */
  readonly message: string;
}

/** Unified cache-service result shape emitted by bootstrap for either phase. */
export type BaseCacheOperationResult = BaseCacheRestoreResult | BaseCacheSaveResult;

/**
 * Creates the ordered include/exclude path list expected by `@actions/cache`.
 *
 * Excludes are emitted as negated patterns so the cache service never captures transient Gradle
 * state such as configuration cache content or lock files.
 */
export function createBaseCachePaths(cacheModel: CacheModel): readonly string[] {
  return [...cacheModel.includePaths, ...cacheModel.excludePaths.map((pattern) => `!${pattern}`)];
}

/**
 * Derives restore-key prefixes for branch fallback when the configured template supports it.
 *
 * We only generate a restore prefix when `refName` is the final placeholder in the template. That
 * keeps prefix matching predictable and avoids accidentally widening fallback scope for more complex
 * custom templates.
 */
export function createBaseCacheRestoreKeys(
  config: NormalizedActionConfig,
  cacheModel: CacheModel,
): readonly string[] {
  const template = config.cacheKeyTemplate ?? DEFAULT_CACHE_KEY_TEMPLATE;
  const refPlaceholderCount = template.split(REF_NAME_PLACEHOLDER).length - 1;

  if (refPlaceholderCount === 0) {
    return [];
  }

  if (refPlaceholderCount !== 1 || !template.endsWith(REF_NAME_PLACEHOLDER)) {
    return [];
  }

  const restoreKeyPrefix = renderCacheKeyTemplate(
    template.slice(0, -REF_NAME_PLACEHOLDER.length),
    config,
    cacheModel,
  );

  return restoreKeyPrefix.length === 0 ? [] : [restoreKeyPrefix];
}

/**
 * Restores the base Gradle cache and classifies the outcome for logs and summaries.
 *
 * This function intentionally treats cache availability and cache misses as ordinary outcomes. It
 * only delegates exceptional behavior to the underlying toolkit when restore itself fails.
 */
export async function restoreBaseCache(
  config: NormalizedActionConfig,
  cacheModel: CacheModel,
  dependencies: BaseCacheServiceDependencies,
): Promise<BaseCacheRestoreResult> {
  const { cacheApi } = dependencies;
  const paths = createBaseCachePaths(cacheModel);
  const restoreKeys = createBaseCacheRestoreKeys(config, cacheModel);

  if (!cacheApi.isFeatureAvailable()) {
    return {
      operation: 'restore',
      status: 'feature-unavailable',
      cacheKey: cacheModel.cacheKey,
      matchedKey: null,
      restoreKeys,
      paths,
      message: 'Base cache restore skipped because the GitHub cache service is unavailable.',
    };
  }

  const matchedKey = await cacheApi.restoreCache([...paths], cacheModel.cacheKey, [...restoreKeys]);

  if (!matchedKey) {
    return {
      operation: 'restore',
      status: 'miss',
      cacheKey: cacheModel.cacheKey,
      matchedKey: null,
      restoreKeys,
      paths,
      message: `Base cache restore missed for key '${cacheModel.cacheKey}'.`,
    };
  }

  if (matchedKey === cacheModel.cacheKey) {
    return {
      operation: 'restore',
      status: 'exact-hit',
      cacheKey: cacheModel.cacheKey,
      matchedKey,
      restoreKeys,
      paths,
      message: `Base cache restore hit exact key '${matchedKey}'.`,
    };
  }

  return {
    operation: 'restore',
    status: 'partial-hit',
    cacheKey: cacheModel.cacheKey,
    matchedKey,
    restoreKeys,
    paths,
    message: `Base cache restore reused prefix-matched key '${matchedKey}'.`,
  };
}

/**
 * Saves the base Gradle cache from the post action when the current job mode allows it.
 *
 * Save is intentionally gated behind post-action arming, read-only mode, and job-mode checks so we
 * avoid introducing duplicate writers or unexpected state changes in distributed execution.
 */
export async function saveBaseCache(
  config: NormalizedActionConfig,
  cacheModel: CacheModel,
  postActionArmed: boolean,
  dependencies: BaseCacheServiceDependencies,
): Promise<BaseCacheSaveResult> {
  const paths = createBaseCachePaths(cacheModel);

  if (!postActionArmed) {
    return createSaveResult(
      'not-armed',
      cacheModel.cacheKey,
      paths,
      'Base cache save skipped because the main action phase did not arm post-save state.',
    );
  }

  if (config.readOnly) {
    return createSaveResult(
      'read-only',
      cacheModel.cacheKey,
      paths,
      'Base cache save skipped because read-only mode is enabled.',
    );
  }

  if (config.jobMode === 'distributed-worker') {
    return createSaveResult(
      'distributed-worker',
      cacheModel.cacheKey,
      paths,
      'Base cache save skipped for distributed-worker mode.',
    );
  }

  const { cacheApi } = dependencies;
  if (!cacheApi.isFeatureAvailable()) {
    return createSaveResult(
      'feature-unavailable',
      cacheModel.cacheKey,
      paths,
      'Base cache save skipped because the GitHub cache service is unavailable.',
    );
  }

  let cacheId: number;

  try {
    cacheId = await cacheApi.saveCache([...paths], cacheModel.cacheKey);
  } catch (error) {
    if (isMissingCachePathsError(error)) {
      return createSaveResult(
        'missing-paths',
        cacheModel.cacheKey,
        paths,
        'Base cache save skipped because none of the configured cache paths exist yet.',
      );
    }

    throw error;
  }

  if (cacheId > 0) {
    return createSaveResult(
      'saved',
      cacheModel.cacheKey,
      paths,
      `Base cache saved under key '${cacheModel.cacheKey}' (cache ID ${cacheId}).`,
      cacheId,
    );
  }

  return createSaveResult(
    'not-saved',
    cacheModel.cacheKey,
    paths,
    `Base cache save did not create a new cache entry for key '${cacheModel.cacheKey}'.`,
  );
}

/**
 * Marks the post phase as eligible to consider a later base-cache save.
 *
 * Arming happens during the main phase after restore/setup work has completed, so the post phase can
 * cheaply distinguish a legitimate paired execution from a standalone post invocation.
 */
export function armBaseCachePostAction(saveState: (name: string, value: string) => void): void {
  saveState(POST_ACTION_ARMED_STATE, 'true');
}

/**
 * Returns whether the post phase was armed by the main phase for a later base-cache save.
 */
export function isBaseCachePostActionArmed(getState: (name: string) => string): boolean {
  return getState(POST_ACTION_ARMED_STATE) === 'true';
}

function renderCacheKeyTemplate(
  template: string,
  config: NormalizedActionConfig,
  cacheModel: CacheModel,
): string {
  const placeholderValues: Record<string, string> = {
    cacheKeyPrefix: config.cacheKeyPrefix,
    schemaVersion: String(config.cacheSchemaVersion),
    partitionFingerprint: cacheModel.partitionFingerprint,
    javaMajor: String(cacheModel.javaMajor),
    runnerOs: cacheModel.runnerOs,
    runnerArch: cacheModel.runnerArch,
    refName: cacheModel.safeRefName,
  };

  return template.replaceAll(/\$\{([A-Za-z0-9]+)}/g, (match, placeholderName: string) => {
    return placeholderValues[placeholderName] ?? match;
  });
}

function createSaveResult(
  status: BaseCacheSaveResult['status'],
  cacheKey: string,
  paths: readonly string[],
  message: string,
  cacheId: number | null = null,
): BaseCacheSaveResult {
  return {
    operation: 'save',
    status,
    cacheKey,
    cacheId,
    paths,
    message,
  };
}

function isMissingCachePathsError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(NO_CACHE_PATHS_FOUND_ERROR_FRAGMENT);
}
