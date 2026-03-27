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

import { describe, expect, it } from 'vitest';

import {
  createBaseCachePaths,
  createBaseCacheRestoreKeys,
  isBaseCachePostActionArmed,
  restoreBaseCache,
  saveBaseCache,
} from '../../src/cache/service';
import type { CacheModel } from '../../src/cache/model';
import type { NormalizedActionConfig } from '../../src/config/types';
import {
  STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
  type BaseCacheBackend,
} from '../../src/storage/cache';

const baseConfig: NormalizedActionConfig = {
  phase: 'prepare',
  baseDirectory: '.',
  cacheEnabled: true,
  readOnly: false,
  jobMode: 'standalone',
  dependentJobs: [],
  allowDuplicateDependentDeltaPaths: false,
  cacheKeyPrefix: 'buildish-mammoth-gradle-cache-',
  cacheKeyTemplate: null,
  cachePartitions: [],
  cacheSchemaVersion: 2,
  wrapperSelectionMode: 'default',
  wrapperPropertiesGlob: '**/gradle/wrapper/gradle-wrapper.properties',
  defaultWrapperPropertiesFile: 'gradle/wrapper/gradle-wrapper.properties',
  wrapperPropertiesFiles: [],
  cleanupEnabled: true,
  restoreCleanupMode: 'none',
  gradleUserHome: '/home/runner/.gradle',
};

const cacheModel: CacheModel = {
  cacheKey: 'buildish-mammoth-gradle-cache-2-21-linux-x64-feedcafe1234abcd-feature-cache-model',
  javaMajor: 21,
  runnerOs: 'linux',
  runnerArch: 'x64',
  safeRefName: 'feature-cache-model',
  partitionFingerprint: 'feedcafe1234abcd',
  partitions: [],
  includePaths: ['/home/runner/.gradle/caches/modules-2/**'],
  excludePaths: [
    '/home/runner/.gradle/**/configuration-cache/**',
    '/home/runner/.gradle/**/*.lock',
  ],
};

function createCacheBackend(
  backend: Pick<BaseCacheBackend, 'isFeatureAvailable' | 'restoreCache' | 'saveCache'>,
  capabilities = STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
): BaseCacheBackend {
  return {
    capabilities,
    isFeatureAvailable: backend.isFeatureAvailable,
    restoreCache: backend.restoreCache,
    saveCache: backend.saveCache,
  };
}

describe('createBaseCachePaths', () => {
  it('appends exclude globs as negated cache patterns', () => {
    expect(createBaseCachePaths(cacheModel)).toEqual([
      '/home/runner/.gradle/caches/modules-2/**',
      '!/home/runner/.gradle/**/configuration-cache/**',
      '!/home/runner/.gradle/**/*.lock',
    ]);
  });
});

describe('createBaseCacheRestoreKeys', () => {
  it('derives a branch-agnostic restore key for the default template', () => {
    expect(createBaseCacheRestoreKeys(baseConfig, cacheModel)).toEqual([
      'buildish-mammoth-gradle-cache-2-21-linux-x64-feedcafe1234abcd-',
    ]);
  });

  it('omits restore keys when a custom template does not end with refName', () => {
    expect(
      createBaseCacheRestoreKeys(
        {
          ...baseConfig,
          cacheKeyTemplate:
            '${cacheKeyPrefix}${partitionFingerprint}-${refName}-${runnerOs}-${javaMajor}',
        },
        cacheModel,
      ),
    ).toEqual([]);
  });
});

describe('restoreBaseCache', () => {
  it('classifies exact cache hits', async () => {
    const result = await restoreBaseCache(baseConfig, cacheModel, {
      cacheBackend: createCacheBackend({
        isFeatureAvailable: () => true,
        restoreCache: async () => cacheModel.cacheKey,
        saveCache: async () => 0,
      }),
    });

    expect(result.status).toBe('exact-hit');
    expect(result.restoreKeys).toEqual([
      'buildish-mammoth-gradle-cache-2-21-linux-x64-feedcafe1234abcd-',
    ]);
  });

  it('classifies partial cache hits', async () => {
    const result = await restoreBaseCache(baseConfig, cacheModel, {
      cacheBackend: createCacheBackend({
        isFeatureAvailable: () => true,
        restoreCache: async () =>
          'buildish-mammoth-gradle-cache-2-21-linux-x64-feedcafe1234abcd-main',
        saveCache: async () => 0,
      }),
    });

    expect(result.status).toBe('partial-hit');
    expect(result.matchedKey).toBe(
      'buildish-mammoth-gradle-cache-2-21-linux-x64-feedcafe1234abcd-main',
    );
  });

  it('returns a miss when no base cache is restored', async () => {
    const result = await restoreBaseCache(baseConfig, cacheModel, {
      cacheBackend: createCacheBackend({
        isFeatureAvailable: () => true,
        restoreCache: async () => undefined,
        saveCache: async () => 0,
      }),
    });

    expect(result.status).toBe('miss');
  });

  it('omits restore-key fallbacks when the cache backend does not support them', async () => {
    let observedRestoreKeys: readonly string[] | undefined;

    const result = await restoreBaseCache(baseConfig, cacheModel, {
      cacheBackend: createCacheBackend(
        {
          isFeatureAvailable: () => true,
          restoreCache: async (_paths, _primaryKey, restoreKeys) => {
            observedRestoreKeys = restoreKeys;
            return undefined;
          },
          saveCache: async () => 0,
        },
        {
          ...STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
          supportsRestoreKeys: false,
        },
      ),
    });

    expect(observedRestoreKeys).toEqual([]);
    expect(result.restoreKeys).toEqual([]);
    expect(result.status).toBe('miss');
  });
});

describe('saveBaseCache', () => {
  it('skips saving in read-only mode', async () => {
    const result = await saveBaseCache({ ...baseConfig, readOnly: true }, cacheModel, true, {
      cacheBackend: createCacheBackend({
        isFeatureAvailable: () => true,
        restoreCache: async () => undefined,
        saveCache: async () => 999,
      }),
    });

    expect(result.status).toBe('read-only');
  });

  it('skips saving for distributed workers', async () => {
    const result = await saveBaseCache(
      { ...baseConfig, jobMode: 'distributed-worker' },
      cacheModel,
      true,
      {
        cacheBackend: createCacheBackend({
          isFeatureAvailable: () => true,
          restoreCache: async () => undefined,
          saveCache: async () => 999,
        }),
      },
    );

    expect(result.status).toBe('distributed-worker');
  });

  it('reports saved cache IDs for eligible saves', async () => {
    const result = await saveBaseCache(baseConfig, cacheModel, true, {
      cacheBackend: createCacheBackend({
        isFeatureAvailable: () => true,
        restoreCache: async () => undefined,
        saveCache: async () => 77,
      }),
    });

    expect(result.status).toBe('saved');
    expect(result.cacheId).toBe(77);
  });

  it('skips saving when the cache backend does not support explicit saves', async () => {
    let saveCalls = 0;

    const result = await saveBaseCache(baseConfig, cacheModel, true, {
      cacheBackend: createCacheBackend(
        {
          isFeatureAvailable: () => true,
          restoreCache: async () => undefined,
          saveCache: async () => {
            saveCalls += 1;
            return 77;
          },
        },
        {
          ...STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
          supportsExplicitSave: false,
        },
      ),
    });

    expect(saveCalls).toBe(0);
    expect(result.status).toBe('feature-unavailable');
    expect(result.message).toMatch(/does not support explicit save operations/i);
  });

  it('skips saving when no cache paths currently exist on disk', async () => {
    const result = await saveBaseCache(baseConfig, cacheModel, true, {
      cacheBackend: createCacheBackend({
        isFeatureAvailable: () => true,
        restoreCache: async () => undefined,
        saveCache: async () => {
          throw new Error(
            'Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.',
          );
        },
      }),
    });

    expect(result.status).toBe('missing-paths');
    expect(result.message).toMatch(/none of the configured cache paths exist yet/i);
  });

  it('returns not-saved when the toolkit declines to create a new cache entry', async () => {
    const result = await saveBaseCache(baseConfig, cacheModel, true, {
      cacheBackend: createCacheBackend({
        isFeatureAvailable: () => true,
        restoreCache: async () => undefined,
        saveCache: async () => -1,
      }),
    });

    expect(result.status).toBe('not-saved');
  });

  it('rethrows unrelated save failures', async () => {
    await expect(
      saveBaseCache(baseConfig, cacheModel, true, {
        cacheBackend: createCacheBackend({
          isFeatureAvailable: () => true,
          restoreCache: async () => undefined,
          saveCache: async () => {
            throw new Error('boom');
          },
        }),
      }),
    ).rejects.toThrow('boom');
  });
});

describe('isBaseCachePostActionArmed', () => {
  it('detects the saved post-action arm state', () => {
    expect(
      isBaseCachePostActionArmed((name) =>
        name === 'buildish-mammoth-cache-gradle-base-cache-armed' ? 'true' : '',
      ),
    ).toBe(true);
  });
});
