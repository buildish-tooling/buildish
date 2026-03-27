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

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  normalizeActionConfig,
  readActionInputs,
  resolveActionInputsFromConfigFile,
  type InputProvider,
} from '../../src/config/action-config';
import type { CiJobContext } from '../../src/ci/types';

const baseCiContext: CiJobContext = {
  eventName: 'push',
  resolvedRefName: 'main',
  safeRefName: 'main',
  runnerOs: 'linux',
  runnerArch: 'x64',
  defaultBranch: 'main',
  isPullRequest: false,
  repository: 'apache/buildish',
  workflowName: 'CI',
  jobName: 'check',
  runId: 123,
  runAttempt: 1,
  tempDirectory: null,
  workspace: '/workspace',
  actionPath: '/workspace',
};

describe('readActionInputs', () => {
  it('reads flat action inputs through the input provider', () => {
    const inputProvider: InputProvider = {
      getInput(name: string): string {
        return (
          {
            'base-directory': 'subdir',
            'cache-enabled': 'false',
            'job-mode': 'distributed-worker',
          }[name] ?? ''
        );
      },
    };

    expect(readActionInputs(inputProvider)).toMatchObject({
      configFile: '',
      baseDirectory: 'subdir',
      cacheEnabled: 'false',
      jobMode: 'distributed-worker',
      githubToken: '',
    });
  });
});

describe('resolveActionInputsFromConfigFile', () => {
  it('loads YAML config and lets direct action inputs override file values', async () => {
    await withWorkspace(
      {
        '.github/buildish-mammoth-cache.yml': [
          'base-directory: project',
          'cache-enabled: false',
          'job-mode: distributed-aggregator',
          'dependent-jobs:',
          '  - worker_a',
          '  - worker_b',
          'cache-partitions:',
          '  - id: modules',
          '    includes:',
          '      - caches/modules-*/files-*/**',
          '    excludes:',
          '      - caches/modules-*/metadata-*/**',
          '',
        ].join('\n'),
      },
      async (workspace) => {
        const rawInputs = await resolveActionInputsFromConfigFile(
          readActionInputs(
            createInputProvider({
              'config-file': '.github/buildish-mammoth-cache.yml',
              'cache-enabled': 'true',
              'dependent-jobs': 'aggregator',
            }),
          ),
          { workspace },
        );

        expect(rawInputs).toMatchObject({
          configFile: '.github/buildish-mammoth-cache.yml',
          baseDirectory: 'project',
          cacheEnabled: 'true',
          jobMode: 'distributed-aggregator',
          dependentJobs: 'aggregator',
        });

        const config = normalizeActionConfig(rawInputs, {
          phase: 'main',
          ciContext: { ...baseCiContext, workspace, actionPath: workspace },
          env: {},
        });

        expect(config).toMatchObject({
          baseDirectory: 'project',
          cacheEnabled: true,
          jobMode: 'distributed-aggregator',
          dependentJobs: ['aggregator'],
          cachePartitions: [
            {
              id: 'modules',
              includes: ['caches/modules-*/files-*/**'],
              excludes: ['caches/modules-*/metadata-*/**'],
            },
          ],
        });
      },
    );
  });

  it('loads JSON config files', async () => {
    await withWorkspace(
      {
        '.github/buildish-mammoth-cache.json': JSON.stringify({
          'base-directory': 'project',
          'process-all-wrapper-files': true,
        }),
      },
      async (workspace) => {
        const rawInputs = await resolveActionInputsFromConfigFile(
          readActionInputs(
            createInputProvider({
              'config-file': '.github/buildish-mammoth-cache.json',
            }),
          ),
          { workspace },
        );

        expect(rawInputs).toMatchObject({
          baseDirectory: 'project',
          processAllWrapperFiles: 'true',
        });
      },
    );
  });

  it('rejects github-token in config files', async () => {
    await withWorkspace(
      {
        '.github/buildish-mammoth-cache.yml': ['github-token: should-not-be-here', ''].join('\n'),
      },
      async (workspace) => {
        await expect(
          resolveActionInputsFromConfigFile(
            readActionInputs(
              createInputProvider({
                'config-file': '.github/buildish-mammoth-cache.yml',
              }),
            ),
            { workspace },
          ),
        ).rejects.toThrow(/must not contain github-token/u);
      },
    );
  });

  it('rejects github-job-check-run-id in config files', async () => {
    await withWorkspace(
      {
        '.github/buildish-mammoth-cache.yml': ['github-job-check-run-id: 987654321', ''].join('\n'),
      },
      async (workspace) => {
        await expect(
          resolveActionInputsFromConfigFile(
            readActionInputs(
              createInputProvider({
                'config-file': '.github/buildish-mammoth-cache.yml',
              }),
            ),
            { workspace },
          ),
        ).rejects.toThrow(/contains unsupported key 'github-job-check-run-id'/u);
      },
    );
  });

  it('rejects config files that escape the workspace via symlinks', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const outsideDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'buildish-mammoth-cache-gradle-config-outside-'),
    );

    try {
      const outsideConfigPath = path.join(outsideDirectory, 'outside.yml');
      await writeFile(outsideConfigPath, 'cache-enabled: false\n', 'utf8');

      await withWorkspace({}, async (workspace) => {
        await symlink(outsideConfigPath, path.join(workspace, 'escaped.yml'));

        await expect(
          resolveActionInputsFromConfigFile(
            readActionInputs(
              createInputProvider({
                'config-file': 'escaped.yml',
              }),
            ),
            { workspace },
          ),
        ).rejects.toThrow(/must stay within the repository workspace after symlink resolution/u);
      });
    } finally {
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });
});

describe('normalizeActionConfig', () => {
  it('applies secure defaults for a push event', () => {
    const config = normalizeActionConfig(readActionInputs(emptyInputProvider()), {
      phase: 'main',
      ciContext: baseCiContext,
      env: {},
    });

    expect(config).toMatchObject({
      phase: 'main',
      baseDirectory: '.',
      cacheEnabled: true,
      readOnly: false,
      jobMode: 'standalone',
      allowDuplicateDependentDeltaPaths: false,
      cacheKeyPrefix: 'gradle-cache-',
      cachePartitions: [],
      restoreCleanupMode: 'none',
      wrapperSelectionMode: 'default',
      defaultWrapperPropertiesFile: 'gradle/wrapper/gradle-wrapper.properties',
    });
  });

  it('parses cache partition overrides and restore cleanup mode', () => {
    const config = normalizeActionConfig(
      readActionInputs(
        createInputProvider({
          'cache-partitions': JSON.stringify([
            {
              id: 'modules',
              includes: ['caches/modules-*/files-*/**'],
              excludes: ['caches/modules-*/metadata-*/**'],
            },
            {
              id: 'custom-generated-jars',
              includes: ['caches/*/generated-gradle-jars/**'],
              excludes: [],
            },
          ]),
          'restore-cleanup-mode': 'prune-managed',
        }),
      ),
      {
        phase: 'main',
        ciContext: baseCiContext,
        env: {},
      },
    );

    expect(config.cachePartitions).toEqual([
      {
        id: 'modules',
        includes: ['caches/modules-*/files-*/**'],
        excludes: ['caches/modules-*/metadata-*/**'],
      },
      {
        id: 'custom-generated-jars',
        includes: ['caches/*/generated-gradle-jars/**'],
        excludes: [],
      },
    ]);
    expect(config.restoreCleanupMode).toBe('prune-managed');
  });

  it('rejects custom cache-key templates without partitionFingerprint', () => {
    expect(() =>
      normalizeActionConfig(
        readActionInputs(
          createInputProvider({
            'cache-key-template': '${cacheKeyPrefix}${schemaVersion}-${javaMajor}-${refName}',
          }),
        ),
        {
          phase: 'main',
          ciContext: baseCiContext,
          env: {},
        },
      ),
    ).toThrow(/must include \$\{partitionFingerprint}/);
  });

  it('rejects cache partition include globs that do not end in /**', () => {
    expect(() =>
      normalizeActionConfig(
        readActionInputs(
          createInputProvider({
            'cache-partitions': JSON.stringify([
              {
                id: 'modules',
                includes: ['caches/modules-*/files-*'],
              },
            ]),
          }),
        ),
        {
          phase: 'main',
          ciContext: baseCiContext,
          env: {},
        },
      ),
    ).toThrow(/must end with '\/\*\*'/);
  });

  it('rejects cache partition globs that attempt traversal or unsupported syntax', () => {
    expect(() =>
      normalizeActionConfig(
        readActionInputs(
          createInputProvider({
            'cache-partitions': JSON.stringify([
              {
                id: 'modules',
                includes: ['../outside/**'],
              },
            ]),
          }),
        ),
        {
          phase: 'main',
          ciContext: baseCiContext,
          env: {},
        },
      ),
    ).toThrow(/must not use '\.\.' path traversal segments/);

    expect(() =>
      normalizeActionConfig(
        readActionInputs(
          createInputProvider({
            'cache-partitions': JSON.stringify([
              {
                id: 'modules',
                includes: ['caches/modules-*/files-*/**'],
                excludes: ['!caches/foo/**'],
              },
            ]),
          }),
        ),
        {
          phase: 'main',
          ciContext: baseCiContext,
          env: {},
        },
      ),
    ).toThrow(/must not be a negated glob/);
  });

  it('parses allow-duplicate-dependent-delta-paths explicitly', () => {
    const config = normalizeActionConfig(
      readActionInputs(createInputProvider({ 'allow-duplicate-dependent-delta-paths': 'true' })),
      {
        phase: 'main',
        ciContext: baseCiContext,
        env: {},
      },
    );

    expect(config.allowDuplicateDependentDeltaPaths).toBe(true);
  });

  it('defaults to read-only on pull requests', () => {
    const config = normalizeActionConfig(readActionInputs(emptyInputProvider()), {
      phase: 'main',
      ciContext: { ...baseCiContext, eventName: 'pull_request', isPullRequest: true },
      env: {},
    });

    expect(config.readOnly).toBe(true);
  });

  it('defaults to read-only on pull_request_target events', () => {
    const config = normalizeActionConfig(readActionInputs(emptyInputProvider()), {
      phase: 'main',
      ciContext: { ...baseCiContext, eventName: 'pull_request_target', isPullRequest: true },
      env: {},
    });

    expect(config.readOnly).toBe(true);
  });

  it('keeps workflow_dispatch writable by default', () => {
    const config = normalizeActionConfig(readActionInputs(emptyInputProvider()), {
      phase: 'main',
      ciContext: {
        ...baseCiContext,
        eventName: 'workflow_dispatch',
        resolvedRefName: 'release/2026.03',
        safeRefName: 'release-2026.03',
      },
      env: {},
    });

    expect(config.readOnly).toBe(false);
  });

  it('keeps schedule runs writable by default', () => {
    const config = normalizeActionConfig(readActionInputs(emptyInputProvider()), {
      phase: 'main',
      ciContext: {
        ...baseCiContext,
        eventName: 'schedule',
        resolvedRefName: 'main',
        safeRefName: 'main',
      },
      env: {},
    });

    expect(config.readOnly).toBe(false);
  });

  it('normalizes explicit wrapper file paths under the configured base directory', () => {
    const config = normalizeActionConfig(
      readActionInputs(
        createInputProvider({
          'base-directory': 'tools',
          'wrapper-properties-files': 'app/gradle/wrapper/gradle-wrapper.properties',
        }),
      ),
      {
        phase: 'main',
        ciContext: baseCiContext,
        env: {},
      },
    );

    expect(config.wrapperSelectionMode).toBe('explicit');
    expect(config.wrapperPropertiesFiles).toEqual([
      'tools/app/gradle/wrapper/gradle-wrapper.properties',
    ]);
  });

  it('accepts Windows-style relative config paths and normalizes them to POSIX', () => {
    const config = normalizeActionConfig(
      readActionInputs(
        createInputProvider({
          'base-directory': 'tools\\nested',
          'wrapper-properties-files': 'app\\gradle\\wrapper\\gradle-wrapper.properties',
        }),
      ),
      {
        phase: 'main',
        ciContext: baseCiContext,
        env: {},
      },
    );

    expect(config.baseDirectory).toBe('tools/nested');
    expect(config.wrapperPropertiesFiles).toEqual([
      'tools/nested/app/gradle/wrapper/gradle-wrapper.properties',
    ]);
  });

  it('rejects conflicting wrapper selection configuration', () => {
    expect(() =>
      normalizeActionConfig(
        readActionInputs(
          createInputProvider({
            'process-all-wrapper-files': 'true',
            'wrapper-properties-files': 'gradle/wrapper/gradle-wrapper.properties',
          }),
        ),
        {
          phase: 'main',
          ciContext: baseCiContext,
          env: {},
        },
      ),
    ).toThrow(/cannot be combined/);
  });

  it('rejects Windows absolute paths for repository-relative inputs', () => {
    expect(() =>
      normalizeActionConfig(
        readActionInputs(createInputProvider({ 'base-directory': 'C:\\workspace' })),
        {
          phase: 'main',
          ciContext: baseCiContext,
          env: {},
        },
      ),
    ).toThrow(/base-directory must be a relative path/u);
  });

  it('rejects rooted Windows paths for repository-relative inputs', () => {
    expect(() =>
      normalizeActionConfig(
        readActionInputs(createInputProvider({ 'base-directory': '\\Windows\\System32' })),
        {
          phase: 'main',
          ciContext: baseCiContext,
          env: {},
        },
      ),
    ).toThrow(/base-directory must be a relative path/u);
  });

  it('rejects unsupported setup-java usage in v1', () => {
    expect(() =>
      normalizeActionConfig(readActionInputs(createInputProvider({ 'setup-java': 'true' })), {
        phase: 'main',
        ciContext: baseCiContext,
        env: {},
      }),
    ).toThrow(/Run actions\/setup-java before this action instead/);
  });
});

function emptyInputProvider(): InputProvider {
  return createInputProvider({});
}

function createInputProvider(values: Record<string, string>): InputProvider {
  return {
    getInput(name: string): string {
      return values[name] ?? '';
    },
  };
}

async function withWorkspace(
  files: Record<string, string>,
  testBody: (workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), 'buildish-mammoth-cache-gradle-action-config-'),
  );

  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = path.join(workspace, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents, 'utf8');
    }

    await testBody(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
