/*
 * Copyright 2026 The Project Nessie Authors
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

const baseConfig: NormalizedActionConfig = {
  phase: 'main',
  baseDirectory: '.',
  cacheEnabled: true,
  readOnly: false,
  jobMode: 'standalone',
  dependentJobs: [],
  cacheKeyPrefix: 'gradle-cache-',
  cacheKeyTemplate: null,
  cacheSchemaVersion: 1,
  wrapperSelectionMode: 'default',
  wrapperPropertiesGlob: '**/gradle/wrapper/gradle-wrapper.properties',
  defaultWrapperPropertiesFile: 'gradle/wrapper/gradle-wrapper.properties',
  wrapperPropertiesFiles: [],
  cleanupEnabled: true,
  gradleUserHome: '/home/runner/.gradle',
};

const cacheModel: CacheModel = {
  cacheKey: 'gradle-cache-1-21-linux-x64-feature-cache-model',
  javaMajor: 21,
  runnerOs: 'linux',
  runnerArch: 'x64',
  safeRefName: 'feature-cache-model',
  partitions: [],
  includePaths: ['/home/runner/.gradle/caches/modules-2/**'],
  excludePaths: [
    '/home/runner/.gradle/**/configuration-cache/**',
    '/home/runner/.gradle/**/*.lock',
  ],
};

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
      'gradle-cache-1-21-linux-x64-',
    ]);
  });

  it('omits restore keys when a custom template does not end with refName', () => {
    expect(
      createBaseCacheRestoreKeys(
        {
          ...baseConfig,
          cacheKeyTemplate: '${cacheKeyPrefix}${refName}-${runnerOs}-${javaMajor}',
        },
        cacheModel,
      ),
    ).toEqual([]);
  });
});

describe('restoreBaseCache', () => {
  it('classifies exact cache hits', async () => {
    const result = await restoreBaseCache(baseConfig, cacheModel, {
      cacheApi: {
        isFeatureAvailable: () => true,
        restoreCache: async () => cacheModel.cacheKey,
        saveCache: async () => 0,
      },
    });

    expect(result.status).toBe('exact-hit');
    expect(result.restoreKeys).toEqual(['gradle-cache-1-21-linux-x64-']);
  });

  it('classifies partial cache hits', async () => {
    const result = await restoreBaseCache(baseConfig, cacheModel, {
      cacheApi: {
        isFeatureAvailable: () => true,
        restoreCache: async () => 'gradle-cache-1-21-linux-x64-main',
        saveCache: async () => 0,
      },
    });

    expect(result.status).toBe('partial-hit');
    expect(result.matchedKey).toBe('gradle-cache-1-21-linux-x64-main');
  });

  it('returns a miss when no base cache is restored', async () => {
    const result = await restoreBaseCache(baseConfig, cacheModel, {
      cacheApi: {
        isFeatureAvailable: () => true,
        restoreCache: async () => undefined,
        saveCache: async () => 0,
      },
    });

    expect(result.status).toBe('miss');
  });
});

describe('saveBaseCache', () => {
  it('skips saving in read-only mode', async () => {
    const result = await saveBaseCache({ ...baseConfig, readOnly: true }, cacheModel, true, {
      cacheApi: {
        isFeatureAvailable: () => true,
        restoreCache: async () => undefined,
        saveCache: async () => 999,
      },
    });

    expect(result.status).toBe('read-only');
  });

  it('skips saving for distributed workers', async () => {
    const result = await saveBaseCache(
      { ...baseConfig, jobMode: 'distributed-worker' },
      cacheModel,
      true,
      {
        cacheApi: {
          isFeatureAvailable: () => true,
          restoreCache: async () => undefined,
          saveCache: async () => 999,
        },
      },
    );

    expect(result.status).toBe('distributed-worker');
  });

  it('reports saved cache IDs for eligible saves', async () => {
    const result = await saveBaseCache(baseConfig, cacheModel, true, {
      cacheApi: {
        isFeatureAvailable: () => true,
        restoreCache: async () => undefined,
        saveCache: async () => 77,
      },
    });

    expect(result.status).toBe('saved');
    expect(result.cacheId).toBe(77);
  });

  it('returns not-saved when the toolkit declines to create a new cache entry', async () => {
    const result = await saveBaseCache(baseConfig, cacheModel, true, {
      cacheApi: {
        isFeatureAvailable: () => true,
        restoreCache: async () => undefined,
        saveCache: async () => -1,
      },
    });

    expect(result.status).toBe('not-saved');
  });
});

describe('isBaseCachePostActionArmed', () => {
  it('detects the saved post-action arm state', () => {
    expect(
      isBaseCachePostActionArmed((name) =>
        name === 'cache-gradle-base-cache-armed' ? 'true' : '',
      ),
    ).toBe(true);
  });
});
