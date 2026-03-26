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
  createCacheModel,
  createCachePartitions,
  parseJavaMajor,
  renderCacheKey,
} from '../../src/cache/model';
import type { CiJobContext } from '../../src/ci/types';
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

const baseCiContext: CiJobContext = {
  platform: 'github',
  eventName: 'push',
  resolvedRefName: 'feature/cache model',
  safeRefName: 'feature-cache-model',
  runnerOs: 'linux',
  runnerArch: 'x64',
  defaultBranch: 'main',
  isPullRequest: false,
  repository: 'projectnessie/cache-gradle',
  workflowName: 'CI',
  jobName: 'check',
  runId: 123,
  runAttempt: 1,
  workspace: '/workspace',
  actionPath: '/workspace',
};

describe('parseJavaMajor', () => {
  it('parses current java version output', () => {
    expect(parseJavaMajor('openjdk version "21.0.4" 2024-07-16\n')).toBe(21);
  });

  it('parses legacy java 8 version output', () => {
    expect(parseJavaMajor('java version "1.8.0_432"\n')).toBe(8);
  });

  it('rejects unsupported java versions', () => {
    expect(() => parseJavaMajor('openjdk version "1.7.0_80"\n')).toThrow(/Java 8 or newer/);
  });
});

describe('renderCacheKey', () => {
  it('renders the default cache key using the safe ref name', () => {
    expect(renderCacheKey(baseConfig, baseCiContext, 21)).toBe(
      'gradle-cache-1-21-linux-x64-feature-cache-model',
    );
  });

  it('renders a restricted custom template', () => {
    expect(
      renderCacheKey(
        {
          ...baseConfig,
          cacheKeyTemplate: '${cacheKeyPrefix}${runnerOs}:${runnerArch}:${javaMajor}:${refName}',
        },
        baseCiContext,
        17,
      ),
    ).toBe('gradle-cache-linux:x64:17:feature-cache-model');
  });
});

describe('createCachePartitions', () => {
  it('defines the expected Gradle user home partitions and excludes configuration cache and lock files', () => {
    const partitions = createCachePartitions('/home/runner/.gradle');

    expect(partitions.map((partition) => partition.id)).toEqual([
      'modules',
      'transforms-metadata',
      'kotlin-dsl',
      'build-cache',
      'wrapper-dists',
    ]);
    expect(
      partitions.every((partition) =>
        partition.relativeExcludeGlobs.includes('**/configuration-cache/**'),
      ),
    ).toBe(true);
    expect(
      partitions.every((partition) => partition.relativeExcludeGlobs.includes('**/*.lock')),
    ).toBe(true);
    expect(partitions[0]?.absoluteIncludeGlobs).toContain(
      '/home/runner/.gradle/caches/modules-2/**',
    );
    expect(partitions[0]?.absoluteExcludeGlobs).toContain('/home/runner/.gradle/**/*.lock');
  });
});

describe('createCacheModel', () => {
  it('derives the cache model from the normalized config and ci context', async () => {
    const cacheModel = await createCacheModel(baseConfig, baseCiContext, {
      captureCommandOutput: async () => 'openjdk version "21.0.4" 2024-07-16\n',
    });

    expect(cacheModel.cacheKey).toBe('gradle-cache-1-21-linux-x64-feature-cache-model');
    expect(cacheModel.javaMajor).toBe(21);
    expect(cacheModel.partitions).toHaveLength(5);
    expect(cacheModel.includePaths).toContain('/home/runner/.gradle/wrapper/dists/**');
    expect(cacheModel.excludePaths).toContain('/home/runner/.gradle/**/configuration-cache/**');
    expect(cacheModel.excludePaths).toContain('/home/runner/.gradle/**/*.lock');
  });

  it('fails hard with an actionable message when no Java runtime is available', async () => {
    await expect(
      createCacheModel(baseConfig, baseCiContext, {
        env: {
          ...process.env,
          JAVA_BIN: '__cache_gradle_missing_java_binary__',
        },
      }),
    ).rejects.toThrow(/No Java runtime is available for cache-gradle/);
  });

  it('preserves non-missing Java detection failures as probe errors', async () => {
    await expect(
      createCacheModel(baseConfig, baseCiContext, {
        captureCommandOutput: async () => {
          throw new Error("'java -version' failed with exit code 2.");
        },
      }),
    ).rejects.toThrow(/Failed to detect the Java runtime using 'java -version'/);
  });
});
