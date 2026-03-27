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

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { NormalizedActionConfig } from '../../src/config/types';
import { validateTargetWrapperProperties } from '../../src/wrapper/static-validation';

describe('validateTargetWrapperProperties', () => {
  it('validates the default wrapper properties file and normalizes escaped values', async () => {
    await withWorkspace(
      {
        'gradle/wrapper/gradle-wrapper.properties': validWrapperProperties(),
      },
      async (workspace) => {
        const wrappers = await validateTargetWrapperProperties(createConfig(), workspace);

        expect(wrappers).toHaveLength(1);
        expect(wrappers[0]).toMatchObject({
          relativePath: 'gradle/wrapper/gradle-wrapper.properties',
          wrapperJarRelativePath: 'gradle/wrapper/gradle-wrapper.jar',
          distributionUrl: 'https://services.gradle.org/distributions/gradle-8.14-bin.zip',
          distributionSha256Sum: '61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
        });
      },
    );
  });

  it('discovers and sorts all matching wrapper properties files', async () => {
    await withWorkspace(
      {
        'apps/zulu/gradle/wrapper/gradle-wrapper.properties': validWrapperProperties(),
        'apps/alpha/gradle/wrapper/gradle-wrapper.properties': validWrapperProperties(),
      },
      async (workspace) => {
        const wrappers = await validateTargetWrapperProperties(
          createConfig({
            wrapperSelectionMode: 'all',
            wrapperPropertiesGlob: 'apps/**/gradle/wrapper/gradle-wrapper.properties',
            defaultWrapperPropertiesFile: 'apps/alpha/gradle/wrapper/gradle-wrapper.properties',
          }),
          workspace,
        );

        expect(wrappers.map((wrapper) => wrapper.relativePath)).toEqual([
          'apps/alpha/gradle/wrapper/gradle-wrapper.properties',
          'apps/zulu/gradle/wrapper/gradle-wrapper.properties',
        ]);
      },
    );
  });

  it('rejects wrapper files that do not enable validateDistributionUrl', async () => {
    await withWorkspace(
      {
        'gradle/wrapper/gradle-wrapper.properties': validWrapperProperties({
          validateDistributionUrl: 'false',
        }),
      },
      async (workspace) => {
        await expect(validateTargetWrapperProperties(createConfig(), workspace)).rejects.toThrow(
          /validateDistributionUrl.*true/,
        );
      },
    );
  });

  it('rejects unsupported wrapper storage layout values', async () => {
    await withWorkspace(
      {
        'gradle/wrapper/gradle-wrapper.properties': validWrapperProperties({
          distributionBase: 'PROJECT',
        }),
      },
      async (workspace) => {
        await expect(validateTargetWrapperProperties(createConfig(), workspace)).rejects.toThrow(
          /distributionBase.*GRADLE_USER_HOME/,
        );
      },
    );
  });

  it('rejects explicit wrapper files outside the gradle/wrapper layout', async () => {
    await withWorkspace(
      {
        'custom/gradle-wrapper.properties': validWrapperProperties(),
      },
      async (workspace) => {
        await expect(
          validateTargetWrapperProperties(
            createConfig({
              wrapperSelectionMode: 'explicit',
              wrapperPropertiesFiles: ['custom/gradle-wrapper.properties'],
              defaultWrapperPropertiesFile: 'custom/gradle-wrapper.properties',
            }),
            workspace,
          ),
        ).rejects.toThrow(/ending with 'gradle\/wrapper\/gradle-wrapper\.properties'/);
      },
    );
  });
});

function createConfig(overrides: Partial<NormalizedActionConfig> = {}): NormalizedActionConfig {
  return {
    phase: 'main',
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
    ...overrides,
  };
}

async function createWorkspace(files: Record<string, string>): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'buildish-mammoth-cache-gradle-wrapper-'));

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(workspace, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, 'utf8');
  }

  return workspace;
}

async function withWorkspace(
  files: Record<string, string>,
  testBody: (workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = await createWorkspace(files);

  try {
    await testBody(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function validWrapperProperties(overrides: Record<string, string> = {}): string {
  const properties = {
    distributionBase: 'GRADLE_USER_HOME',
    distributionPath: 'wrapper/dists',
    distributionSha256Sum: '61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
    distributionUrl: 'https\\://services.gradle.org/distributions/gradle-8.14-bin.zip',
    validateDistributionUrl: 'true',
    zipStoreBase: 'GRADLE_USER_HOME',
    zipStorePath: 'wrapper/dists',
    ...overrides,
  };

  return `${Object.entries(properties)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`;
}
