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

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  bootstrapPhase,
  createBootstrapLogLines,
  createBootstrapStatus,
  createBootstrapSummaryLines,
} from '../src/bootstrap';
import type { BaseCacheApi, BaseCacheRestoreResult } from '../src/cache/service';
import type { CacheModel } from '../src/cache/model';
import type { SummaryWriter } from '../src/ci/types';
import type { ProvisionedWrapperJar, ValidatedWrapperPropertiesFile } from '../src/wrapper/types';
import { createTestGitHubProvider, createTestRuntimeHost } from './support/github-test-runtime';

const config = {
  phase: 'main',
  baseDirectory: '.',
  cacheEnabled: true,
  readOnly: false,
  jobMode: 'standalone',
  dependentJobs: [],
  allowDuplicateDependentDeltaPaths: false,
  cacheKeyPrefix: 'gradle-cache-',
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
} as const;

const ciContext = {
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
} as const;

function createBootstrapDependencies(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly eventPayload?: Record<string, unknown>;
  readonly summaryWriter: SummaryWriter;
  readonly inputs?: Readonly<Record<string, string>>;
  readonly getState?: (name: string) => string;
  readonly saveState?: (name: string, value: string) => void;
}) {
  const runtimeHost = createTestRuntimeHost({
    inputs: options.inputs,
    getState: options.getState,
    saveState: options.saveState,
  });

  return {
    runtimeHost,
    ciProvider: createTestGitHubProvider(runtimeHost, {
      env: options.env,
      eventPayload: options.eventPayload,
      summaryWriter: options.summaryWriter,
    }),
  };
}

const validatedWrappers: readonly ValidatedWrapperPropertiesFile[] = [
  {
    relativePath: 'gradle/wrapper/gradle-wrapper.properties',
    absolutePath: '/workspace/gradle/wrapper/gradle-wrapper.properties',
    wrapperDirectoryRelativePath: 'gradle/wrapper',
    wrapperJarRelativePath: 'gradle/wrapper/gradle-wrapper.jar',
    properties: {
      distributionUrl: 'https://services.gradle.org/distributions/gradle-8.14-bin.zip',
      distributionSha256Sum: '61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
      validateDistributionUrl: 'true',
    },
    distributionUrl: 'https://services.gradle.org/distributions/gradle-8.14-bin.zip',
    distributionSha256Sum: '61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
  },
] as const;

const cacheModel: CacheModel = {
  cacheKey: 'gradle-cache-2-21-linux-x64-feedcafe1234abcd-main',
  javaMajor: 21,
  runnerOs: 'linux',
  runnerArch: 'x64',
  safeRefName: 'main',
  partitionFingerprint: 'feedcafe1234abcd',
  includePaths: ['/home/runner/.gradle/caches/modules-*/files-*/**'],
  excludePaths: [
    '/home/runner/.gradle/**/configuration-cache/**',
    '/home/runner/.gradle/**/*.lock',
    '/home/runner/.gradle/caches/*/cc-keystore',
    '/home/runner/.gradle/caches/modules-*/metadata-*/**',
  ],
  partitions: [
    {
      id: 'modules',
      displayName: 'Dependency modules',
      description: 'Downloaded dependency artifacts and artifact stores shared across builds.',
      relativeIncludeGlobs: ['caches/modules-*/files-*/**'],
      relativeExcludeGlobs: [
        '**/configuration-cache/**',
        '**/*.lock',
        'caches/*/cc-keystore',
        'caches/modules-*/metadata-*/**',
      ],
      absoluteIncludeGlobs: ['/home/runner/.gradle/caches/modules-*/files-*/**'],
      absoluteExcludeGlobs: [
        '/home/runner/.gradle/**/configuration-cache/**',
        '/home/runner/.gradle/**/*.lock',
        '/home/runner/.gradle/caches/*/cc-keystore',
        '/home/runner/.gradle/caches/modules-*/metadata-*/**',
      ],
    },
  ],
};

const restoreResult: BaseCacheRestoreResult = {
  operation: 'restore',
  status: 'exact-hit',
  cacheKey: 'gradle-cache-2-21-linux-x64-feedcafe1234abcd-main',
  matchedKey: 'gradle-cache-2-21-linux-x64-feedcafe1234abcd-main',
  restoreKeys: ['gradle-cache-2-21-linux-x64-feedcafe1234abcd-'],
  paths: [
    '/home/runner/.gradle/caches/modules-*/files-*/**',
    '!/home/runner/.gradle/**/configuration-cache/**',
    '!/home/runner/.gradle/**/*.lock',
    '!/home/runner/.gradle/caches/*/cc-keystore',
    '!/home/runner/.gradle/caches/modules-*/metadata-*/**',
  ],
  message: "Base cache restore hit exact key 'gradle-cache-2-21-linux-x64-feedcafe1234abcd-main'.",
};

const provisionedWrappers: readonly ProvisionedWrapperJar[] = [
  {
    relativePath: 'gradle/wrapper/gradle-wrapper.properties',
    distributionVersion: '8.14',
    wrapperSourceVersion: '8.14.0',
    wrapperChecksumUrl: 'https://services.gradle.org/distributions/gradle-8.14-wrapper.jar.sha256',
    wrapperSignatureUrl: 'https://services.gradle.org/distributions/gradle-8.14-wrapper.jar.asc',
    wrapperJarUrl:
      'https://raw.githubusercontent.com/gradle/gradle/v8.14.0/gradle/wrapper/gradle-wrapper.jar',
    wrapperJarRelativePath: 'gradle/wrapper/gradle-wrapper.jar',
    wrapperJarAbsolutePath: '/workspace/gradle/wrapper/gradle-wrapper.jar',
    expectedWrapperJarSha256: 'ecf4726f7d253471e541f6385b55d00e809387ed44250fb53f65b0deaf8e72ad',
    wasDownloaded: true,
  },
] as const;

describe('bootstrap helpers', () => {
  it('creates a status message with config and CI context details', () => {
    expect(
      createBootstrapStatus(
        'main',
        config,
        ciContext,
        cacheModel,
        restoreResult,
        validatedWrappers,
        provisionedWrappers,
      ),
    ).toEqual({
      phase: 'main',
      config,
      ciContext,
      cacheModel,
      baseCacheResult: restoreResult,
      validatedWrappers,
      provisionedWrappers,
      ciDiagnosticsLines: [],
      ciExecutionUrls: { jobUrl: null, workflowRunUrl: null },
      message: 'Prepared main phase for push on main in standalone mode.',
    });
  });

  it('renders summary lines for the bootstrap status', () => {
    const summaryText = createBootstrapSummaryLines(
      createBootstrapStatus(
        'main',
        config,
        ciContext,
        cacheModel,
        restoreResult,
        validatedWrappers,
        provisionedWrappers,
      ),
    ).join('\n');

    expect(summaryText).toContain('- Base cache restore: exact-hit');
    expect(summaryText).toContain('- Wrapper provisioning: 1 ready (1 downloaded, 0 reused)');
    expect(summaryText).toContain('<summary>Execution context</summary>');
    expect(summaryText).toContain('- Cache partitions: 1');
    expect(summaryText).toContain('- Job mode: standalone');
    expect(summaryText).toContain('<summary>Wrapper provisioning</summary>');
    expect(summaryText).toContain('<table>');
    expect(summaryText).toContain('gradle/wrapper/gradle-wrapper.properties');
    expect(summaryText).toMatch(
      /- Cache key: gradle\\-cache\\-2\\-21\\-linux\\-x64\\-feedcafe1234abcd\\-main/u,
    );
  });

  it('renders log lines for the bootstrap status', () => {
    const logText = createBootstrapLogLines(
      createBootstrapStatus(
        'main',
        config,
        ciContext,
        cacheModel,
        restoreResult,
        validatedWrappers,
        provisionedWrappers,
        [
          "GitHub input 'github-token' present: yes.",
          "GitHub environment 'GITHUB_TOKEN' available: yes.",
          "GitHub input 'github-job-check-run-id': 987654321.",
        ],
      ),
    ).join('\n');

    expect(logText).toContain(
      'Bootstrap: Prepared main phase for push on main in standalone mode.',
    );
    expect(logText).toContain('Base cache restore: exact-hit.');
    expect(logText).toContain('Wrapper provisioning: 1 ready (1 downloaded, 0 reused).');
    expect(logText).toContain("Execution context: workflow 'CI', job 'check', event 'push'");
    expect(logText).toContain("GitHub input 'github-token' present: yes.");
    expect(logText).toContain("GitHub environment 'GITHUB_TOKEN' available: yes.");
    expect(logText).toContain("GitHub input 'github-job-check-run-id': 987654321.");
    expect(logText).toContain(
      'Cache key: gradle-cache-2-21-linux-x64-feedcafe1234abcd-main; Java major: 21; cache partitions: 1.',
    );
    expect(logText).toContain(
      "Downloaded trusted wrapper JAR for 'gradle/wrapper/gradle-wrapper.properties'",
    );
  });

  it('bootstraps the main phase without publishing a job summary directly', async () => {
    const wrapperJarBytes = Buffer.from('verified wrapper jar');
    const wrapperJarSha256 = createHash('sha256').update(wrapperJarBytes).digest('hex');
    const summaryLines: string[] = [];
    let writeCalls = 0;
    const savedState = new Map<string, string>();
    const cacheApi: BaseCacheApi = {
      isFeatureAvailable(): boolean {
        return true;
      },
      async restoreCache(_paths: string[], primaryKey: string): Promise<string | undefined> {
        return primaryKey;
      },
      async saveCache(): Promise<number> {
        throw new Error('saveCache should not be called during main bootstrap');
      },
    };
    const summaryWriter: SummaryWriter = {
      addRaw(text: string, _addEol?: boolean): SummaryWriter {
        summaryLines.push(text);
        return this;
      },
      async write(): Promise<void> {
        writeCalls += 1;
      },
    };
    await withWorkspaceWithWrapper(async (workspace) => {
      const status = await bootstrapPhase('main', {
        env: {
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REPOSITORY: 'apache/buildish',
          GITHUB_WORKFLOW: 'CI',
          GITHUB_JOB: 'check',
          GITHUB_WORKSPACE: workspace,
          RUNNER_OS: 'Linux',
          RUNNER_ARCH: 'X64',
        },
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        cacheApi,
        fetchImpl: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url = String(input);

          if (url.endsWith('gradle-8.14-wrapper.jar.sha256')) {
            expect(init).toBeUndefined();
            return new Response(`${wrapperJarSha256}\n`, { status: 200 });
          }

          if (url.endsWith('gradle-8.14-wrapper.jar.asc')) {
            expect(init).toBeUndefined();
            return new Response(TEST_SIGNATURE_ARMORED, { status: 200 });
          }

          if (
            url ===
            'https://api.github.com/repos/gradle/gradle/contents/gradle/wrapper/gradle-wrapper.jar?ref=v8.14.0'
          ) {
            const headers = new Headers(init?.headers);
            expect(headers.get('authorization')).toBe('Bearer ghs_bootstrap_token');
            expect(headers.get('accept')).toBe('application/vnd.github.raw');
            return new Response(wrapperJarBytes, { status: 200 });
          }

          throw new Error(`Unexpected fetch URL: ${url}`);
        },
        ...createBootstrapDependencies({
          env: {
            GITHUB_EVENT_NAME: 'push',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_REPOSITORY: 'apache/buildish',
            GITHUB_WORKFLOW: 'CI',
            GITHUB_JOB: 'check',
            GITHUB_WORKSPACE: workspace,
            RUNNER_OS: 'Linux',
            RUNNER_ARCH: 'X64',
          },
          eventPayload: {
            repository: { default_branch: 'main' },
          },
          inputs: {
            'github-token': 'ghs_bootstrap_token',
          },
          saveState(name: string, value: string): void {
            savedState.set(name, value);
          },
          summaryWriter,
        }),
        verifyWrapperSignature: async (jarBytes: Uint8Array, armoredSignature: string) => {
          expect(Buffer.from(jarBytes)).toEqual(wrapperJarBytes);
          expect(armoredSignature).toBe(TEST_SIGNATURE_ARMORED);
        },
      });

      expect(status.message).toBe('Prepared main phase for push on main in standalone mode.');
      expect(status.cacheModel?.cacheKey).toMatch(
        /^gradle-cache-2-21-linux-x64-[a-f0-9]{16}-main$/,
      );
      expect(status.baseCacheResult?.status).toBe('exact-hit');
      expect(status.validatedWrappers).toHaveLength(1);
      expect(status.provisionedWrappers).toHaveLength(1);
      expect(status.ciDiagnosticsLines).toEqual([
        "GitHub input 'github-token' present: yes.",
        "GitHub environment 'GITHUB_TOKEN' available: no.",
        "GitHub input 'github-job-check-run-id': unset.",
      ]);
      expect(status.ciExecutionUrls).toEqual({ jobUrl: null, workflowRunUrl: null });
      expect(summaryLines).toEqual([]);
      expect(savedState.get('buildish-mammoth-cache-gradle-base-cache-armed')).toBe('true');
      expect(writeCalls).toBe(0);
      await expect(
        readFile(path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.jar')),
      ).resolves.toEqual(wrapperJarBytes);
    });
  });

  it('bootstraps the post phase and saves the base cache when armed', async () => {
    const summaryLines: string[] = [];
    let writeCalls = 0;
    const cacheApi: BaseCacheApi = {
      isFeatureAvailable(): boolean {
        return true;
      },
      async restoreCache(): Promise<string | undefined> {
        throw new Error('restoreCache should not be called during post bootstrap');
      },
      async saveCache(): Promise<number> {
        return 42;
      },
    };
    const summaryWriter: SummaryWriter = {
      addRaw(text: string, _addEol?: boolean): SummaryWriter {
        summaryLines.push(text);
        return this;
      },
      async write(): Promise<void> {
        writeCalls += 1;
      },
    };

    await withWorkspace({}, async (workspace) => {
      const status = await bootstrapPhase('post', {
        env: {
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REPOSITORY: 'apache/buildish',
          GITHUB_WORKFLOW: 'CI',
          GITHUB_JOB: 'check',
          GITHUB_WORKSPACE: workspace,
          RUNNER_OS: 'Linux',
          RUNNER_ARCH: 'X64',
        },
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        cacheApi,
        ...createBootstrapDependencies({
          env: {
            GITHUB_EVENT_NAME: 'push',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_REPOSITORY: 'apache/buildish',
            GITHUB_WORKFLOW: 'CI',
            GITHUB_JOB: 'check',
            GITHUB_WORKSPACE: workspace,
            RUNNER_OS: 'Linux',
            RUNNER_ARCH: 'X64',
          },
          eventPayload: {
            repository: { default_branch: 'main' },
          },
          getState(name: string): string {
            return name === 'buildish-mammoth-cache-gradle-base-cache-armed' ? 'true' : '';
          },
          summaryWriter,
        }),
      });

      expect(status.baseCacheResult).toEqual(
        expect.objectContaining({
          operation: 'save',
          status: 'saved',
          cacheKey: expect.stringMatching(/^gradle-cache-2-21-linux-x64-[a-f0-9]{16}-main$/),
          cacheId: 42,
        }),
      );
      expect(summaryLines).toEqual([]);
      expect(writeCalls).toBe(0);
    });
  });

  it('loads optional config-file values during bootstrap while allowing direct overrides', async () => {
    const summaryLines: string[] = [];
    const cacheApi: BaseCacheApi = {
      isFeatureAvailable(): boolean {
        throw new Error('cacheApi should not be touched when config-file disables caching');
      },
      async restoreCache(): Promise<string | undefined> {
        throw new Error('restoreCache should not be called when caching is disabled');
      },
      async saveCache(): Promise<number> {
        throw new Error('saveCache should not be called when caching is disabled');
      },
    };
    const summaryWriter: SummaryWriter = {
      addRaw(text: string, _addEol?: boolean): SummaryWriter {
        summaryLines.push(text);
        return this;
      },
      async write(): Promise<void> {
        // no-op
      },
    };

    await withWorkspace(
      {
        '.github/buildish-mammoth-cache.yml': [
          'cache-enabled: false',
          'read-only: true',
          'job-mode: distributed-aggregator',
          'dependent-jobs:',
          '  - worker_a',
          '  - worker_b',
          '',
        ].join('\n'),
      },
      async (workspace) => {
        const status = await bootstrapPhase('post', {
          env: {
            GITHUB_EVENT_NAME: 'push',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_REPOSITORY: 'apache/buildish',
            GITHUB_WORKFLOW: 'CI',
            GITHUB_JOB: 'check',
            GITHUB_WORKSPACE: workspace,
            RUNNER_OS: 'Linux',
            RUNNER_ARCH: 'X64',
          },
          captureCommandOutput: async (): Promise<string> =>
            'openjdk version "21.0.4" 2024-07-16\n',
          cacheApi,
          ...createBootstrapDependencies({
            env: {
              GITHUB_EVENT_NAME: 'push',
              GITHUB_REF: 'refs/heads/main',
              GITHUB_REPOSITORY: 'apache/buildish',
              GITHUB_WORKFLOW: 'CI',
              GITHUB_JOB: 'check',
              GITHUB_WORKSPACE: workspace,
              RUNNER_OS: 'Linux',
              RUNNER_ARCH: 'X64',
            },
            eventPayload: {
              repository: { default_branch: 'main' },
            },
            inputs: {
              'config-file': '.github/buildish-mammoth-cache.yml',
              'read-only': 'false',
            },
            summaryWriter,
          }),
        });

        expect(status.config).toMatchObject({
          cacheEnabled: false,
          readOnly: false,
          jobMode: 'distributed-aggregator',
          dependentJobs: ['worker_a', 'worker_b'],
        });
        expect(status.cacheModel).toBeNull();
        expect(status.baseCacheResult).toBeNull();
      },
    );
  });

  it('falls back to process.env when resolving gradle user home during bundled entrypoint execution', async () => {
    const summaryWriter: SummaryWriter = {
      addRaw(): SummaryWriter {
        return this;
      },
      async write(): Promise<void> {
        // no-op
      },
    };

    await withWorkspace({}, async (workspace) => {
      const customGradleUserHome = path.join(workspace, 'custom-gradle-home');

      vi.stubEnv('GITHUB_EVENT_NAME', 'push');
      vi.stubEnv('GITHUB_REF', 'refs/heads/main');
      vi.stubEnv('GITHUB_REPOSITORY', 'apache/buildish');
      vi.stubEnv('GITHUB_WORKFLOW', 'CI');
      vi.stubEnv('GITHUB_JOB', 'check');
      vi.stubEnv('GITHUB_WORKSPACE', workspace);
      vi.stubEnv('RUNNER_OS', 'Linux');
      vi.stubEnv('RUNNER_ARCH', 'X64');
      vi.stubEnv('GRADLE_USER_HOME', customGradleUserHome);

      try {
        const status = await bootstrapPhase('post', {
          captureCommandOutput: async (): Promise<string> =>
            'openjdk version "21.0.4" 2024-07-16\n',
          cacheApi: {
            isFeatureAvailable(): boolean {
              throw new Error('cacheApi should not be touched when caching is disabled');
            },
            async restoreCache(): Promise<string | undefined> {
              throw new Error('restoreCache should not be called when caching is disabled');
            },
            async saveCache(): Promise<number> {
              throw new Error('saveCache should not be called when caching is disabled');
            },
          },
          ...createBootstrapDependencies({
            env: process.env,
            eventPayload: {
              repository: { default_branch: 'main' },
            },
            inputs: {
              'cache-enabled': 'false',
            },
            summaryWriter,
          }),
        });

        expect(status.config.gradleUserHome).toBe(customGradleUserHome);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
});

async function withWorkspaceWithWrapper(
  testBody: (workspace: string) => Promise<void>,
): Promise<void> {
  await withWorkspace(
    {
      'gradle/wrapper/gradle-wrapper.properties': [
        'distributionBase=GRADLE_USER_HOME',
        'distributionPath=wrapper/dists',
        'distributionSha256Sum=61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
        'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14-bin.zip',
        'validateDistributionUrl=true',
        'zipStoreBase=GRADLE_USER_HOME',
        'zipStorePath=wrapper/dists',
        '',
      ].join('\n'),
    },
    testBody,
  );
}

async function withWorkspace(
  files: Record<string, string>,
  testBody: (workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), 'buildish-mammoth-cache-gradle-bootstrap-'),
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

const TEST_SIGNATURE_ARMORED = `-----BEGIN PGP SIGNATURE-----
Version: test

ZmFrZQ==
=abcd
-----END PGP SIGNATURE-----`;
