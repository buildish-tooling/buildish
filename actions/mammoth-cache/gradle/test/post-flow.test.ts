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

import { cp } from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  downloadAndVerifyDeltaArtifactPackage,
  stageDeltaArtifactPackage,
  type WorkflowArtifactApi,
  type WorkflowArtifactDescriptor,
} from '../src/artifacts/service';
import { captureCacheManifest, computeCacheDelta } from '../src/cache/manifest';
import { createCachePartitions, type CacheModel } from '../src/cache/model';
import type { BaseCacheApi } from '../src/cache/service';
import type { SummaryWriter } from '../src/ci/types';
import { createPostActionSummaryLines, executePostAction } from '../src/post-flow';
import {
  DELTA_ARTIFACT_PRODUCER_IDENTITY_STATE,
  persistBaseCacheRestoreResult,
  persistPreBuildCacheManifest,
  PRE_BUILD_CACHE_MANIFEST_PATH_STATE,
  persistDeltaArtifactProducerIdentity,
  persistConsumedDeltaArtifactNames,
} from '../src/state/post-action';

describe('executePostAction', () => {
  it('uploads a delta artifact for distributed-worker jobs when cache contents changed', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      const savedState = new Map<string, string>();
      const summary = createSummaryCapture();

      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'before',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'after',
      );

      const status = await executePostAction({
        artifactApi,
        cacheApi: createCacheApi({ saveCache: async () => 0 }),
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        env: createTestEnv(workspace, gradleUserHome, 'worker-build'),
        eventPayload: {
          repository: { default_branch: 'main' },
        },
        getState(name: string): string {
          if (name === 'buildish-mammoth-cache-gradle-base-cache-armed') {
            return 'true';
          }
          return savedState.get(name) ?? '';
        },
        inputProvider: createInputProvider('distributed-worker'),
        summaryWriter: summary.writer,
      });

      expect(status.bootstrap.baseCacheResult).toEqual(
        expect.objectContaining({ status: 'distributed-worker' }),
      );
      expect(status.deltaArtifactResult).toEqual(
        expect.objectContaining({
          status: 'uploaded',
          addedCount: 0,
          modifiedCount: 1,
          deletedCount: 0,
          totalChangedCount: 1,
        }),
      );

      const artifacts = await artifactApi.listArtifacts();
      expect(artifacts).toHaveLength(1);
      expect(artifactApi.uploadRetentionDays).toEqual([7]);
      const downloaded = await downloadAndVerifyDeltaArtifactPackage(artifactApi, artifacts[0]);
      expect(downloaded.metadata.producer.jobName).toBe('worker-build');
      expect(downloaded.metadata.producer.runId).toBe(101);
      expect(
        downloaded.deltaManifest.partitions.some((partition) => partition.entries.length > 0),
      ).toBe(true);
      const bootstrapSummaryText = summary.lines.join('\n');
      expect(bootstrapSummaryText).toContain('## Apache Buildish bootstrap');
      const summaryText = createPostActionSummaryLines(status).join('\n');
      expect(summaryText).toContain('## Apache Buildish Mammoth Cache for Gradle');
      expect(summaryText).toContain('### Gradle builds');
      expect(summaryText).toContain('<summary>Cache details</summary>');
      expect(summaryText).toContain('- Delta artifact: uploaded');
      expect(summary.writeCalls).toBe(1);
      await rm(downloaded.downloadDirectory, { recursive: true, force: true });
    });
  });

  it('reuses the persisted main-phase producer identity when post-phase job metadata drifts', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      const savedState = new Map<string, string>();
      const summary = createSummaryCapture();

      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'before',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      persistDeltaArtifactProducerIdentity(
        {
          ...createTestCiContext(workspace),
          jobName: 'worker_a',
          runId: 101,
          runAttempt: 2,
        },
        (name: string, value: string) => savedState.set(name, value),
      );
      expect(savedState.get(DELTA_ARTIFACT_PRODUCER_IDENTITY_STATE)).toBeTruthy();
      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'after',
      );

      const status = await executePostAction({
        artifactApi,
        cacheApi: createCacheApi({ saveCache: async () => 0 }),
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        env: createTestEnv(workspace, gradleUserHome, 'post-phase-job-name'),
        eventPayload: {
          repository: { default_branch: 'main' },
        },
        getState(name: string): string {
          if (name === 'buildish-mammoth-cache-gradle-base-cache-armed') {
            return 'true';
          }
          return savedState.get(name) ?? '';
        },
        inputProvider: createInputProvider('distributed-worker'),
        summaryWriter: summary.writer,
      });

      expect(status.deltaArtifactResult).toEqual(
        expect.objectContaining({
          status: 'uploaded',
          artifactName: expect.stringMatching(
            /^buildish-mammoth-cache-gradle-delta-worker_a-run-101-attempt-2-/u,
          ),
        }),
      );

      const artifacts = await artifactApi.listArtifacts();
      expect(artifacts).toHaveLength(1);
      const downloaded = await downloadAndVerifyDeltaArtifactPackage(artifactApi, artifacts[0]);
      expect(downloaded.metadata.producer.jobName).toBe('worker_a');
      expect(downloaded.metadata.producer.runId).toBe(101);
      expect(downloaded.metadata.producer.runAttempt).toBe(2);
      await rm(downloaded.downloadDirectory, { recursive: true, force: true });
    });
  });

  it('renders the final post-action report layout and logs grouped details', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      const savedState = new Map<string, string>();
      const infoMessages: string[] = [];

      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'before',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      persistBaseCacheRestoreResult(
        {
          operation: 'restore',
          status: 'exact-hit',
          cacheKey: 'buildish-cache-main-linux',
          matchedKey: 'buildish-cache-main-linux',
          restoreKeys: ['buildish-cache-main-linux'],
          paths: [path.join(gradleUserHome, 'caches')],
          message: 'Restored cache using exact key hit.',
        },
        savedState.set.bind(savedState),
      );
      await writeCapturedBuildResult(path.join(workspace, 'runner-temp'), {
        invocationKey: 'build-1',
        rootProjectName: 'platform',
        requestedTasks: 'build --scan',
        gradleVersion: '8.14.3',
        javaVersion: '21.0.4',
        configCacheHit: true,
        buildScanUri: 'https://scans.gradle.com/s/local-it-published',
      });
      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'after',
      );

      const status = await executePostAction({
        artifactApi,
        cacheApi: createCacheApi({ saveCache: async () => 0 }),
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        env: {
          ...createTestEnv(workspace, gradleUserHome, 'worker-build'),
          GITHUB_TOKEN: 'test-token',
        },
        eventPayload: {
          repository: { default_branch: 'main' },
        },
        fetchImpl: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url = String(input);
          if (url.includes('/actions/runs/101/attempts/2/jobs')) {
            expect(init?.headers).toBeInstanceOf(Headers);
            expect((init!.headers as Headers).get('authorization')).toBe('Bearer test-token');
            return new Response(
              JSON.stringify({
                jobs: [
                  {
                    name: 'worker-build',
                    html_url: 'https://github.com/apache/buildish/actions/runs/101/job/987654321',
                  },
                ],
              }),
              { status: 200 },
            );
          }
          throw new Error(`Unexpected fetch URL: ${url}`);
        },
        getState(name: string): string {
          if (name === 'buildish-mammoth-cache-gradle-base-cache-armed') {
            return 'true';
          }
          return savedState.get(name) ?? '';
        },
        inputProvider: createInputProvider('distributed-worker'),
        logInfo(message: string): void {
          infoMessages.push(message);
        },
        summaryWriter: createSummaryCapture().writer,
      });

      const publishedSummary = await readFile(path.join(workspace, 'step-summary.md'), 'utf8');
      const summaryContent = createPostActionSummaryLines(status).join('\n');
      expect(publishedSummary).toBe(`${summaryContent}\n`);
      expect(summaryContent).toContain('## Apache Buildish Mammoth Cache for Gradle');
      expect(summaryContent).toContain(
        '### <a href="https://github.com/apache/buildish/actions/runs/101/job/987654321">Gradle builds</a>',
      );
      expect(summaryContent).toContain('Gradle 8.14.3 / Java 21.0.4');
      expect(summaryContent).toContain('<summary>Cache details</summary>');
      expect(summaryContent).toContain('Pulled base cache');
      expect(summaryContent).toContain('Delta artifact');
      expect(summaryContent).toContain('Uploaded base cache');
      expect(summaryContent).toContain('manifest-derived, uncompressed content sizes');
      expect(summaryContent).not.toContain('### Warnings');
      expect(summaryContent).not.toContain('### Errors');
      expect(infoMessages).toEqual(
        expect.arrayContaining([
          '::group::Apache Buildish Mammoth Cache for Gradle',
          expect.stringContaining("Uploaded delta artifact 'buildish-mammoth-cache-gradle-delta-"),
          'Captured Gradle build 1: platform — build --scan; Gradle 8.14.3 / Java 21.0.4; configuration cache reused; Build Scan https://scans.gradle.com/s/local-it-published.',
          '::endgroup::',
        ]),
      );
    });
  });

  it('falls back to the workflow run URL when the current job URL cannot be resolved', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const status = await executePostAction({
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        env: createTestEnv(workspace, gradleUserHome, 'worker-build'),
        inputProvider: createInputProvider('distributed-worker'),
        summaryWriter: createSummaryCapture().writer,
      });

      const summaryContent = createPostActionSummaryLines(status).join('\n');
      expect(summaryContent).toContain('### Gradle builds');
      expect(summaryContent).not.toContain('Workflow run:');
    });
  });

  it('skips artifact upload for standalone jobs even when cache contents changed', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      const savedState = new Map<string, string>();
      let saveCalls = 0;
      const summary = createSummaryCapture();

      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'before',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'after',
      );

      const status = await executePostAction({
        artifactApi,
        cacheApi: createCacheApi({
          saveCache: async () => {
            saveCalls += 1;
            return 77;
          },
        }),
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        env: createTestEnv(workspace, gradleUserHome, 'build'),
        eventPayload: {
          repository: { default_branch: 'main' },
        },
        getState(name: string): string {
          if (name === 'buildish-mammoth-cache-gradle-base-cache-armed') {
            return 'true';
          }
          return savedState.get(name) ?? '';
        },
        inputProvider: createInputProvider('standalone'),
        summaryWriter: summary.writer,
      });

      expect(saveCalls).toBe(1);
      expect(status.bootstrap.baseCacheResult).toEqual(
        expect.objectContaining({ status: 'saved' }),
      );
      expect(status.deltaArtifactResult).toEqual(
        expect.objectContaining({
          status: 'not-distributed-worker',
          modifiedCount: 1,
          totalChangedCount: 1,
        }),
      );
      const summaryText = createPostActionSummaryLines(status).join('\n');
      expect(summaryText).toContain('## Apache Buildish Mammoth Cache for Gradle');
      expect(summaryText).toContain('### Gradle builds');
      expect(summaryText).toContain('- Delta artifact: not\\-distributed\\-worker');
      expect(summaryText).toContain('- Post-build cache delta: 0 added, 1 modified, 0 deleted');
      expect(summary.writeCalls).toBe(1);
      await expect(artifactApi.listArtifacts()).resolves.toHaveLength(0);
    });
  });

  it('skips artifact upload for distributed-aggregator jobs and still saves the base cache', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      const savedState = new Map<string, string>();
      let saveCalls = 0;
      const summary = createSummaryCapture();

      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'before',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'after',
      );
      await stageWorkerArtifactForCleanup(artifactApi, workspace, 'worker-build');
      const artifactNameToDelete = (await artifactApi.listArtifacts())[0]!.name;
      persistConsumedDeltaArtifactNames([artifactNameToDelete], savedState.set.bind(savedState));

      const status = await executePostAction({
        artifactApi,
        cacheApi: createCacheApi({
          saveCache: async () => {
            saveCalls += 1;
            return 91;
          },
        }),
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        env: createTestEnv(workspace, gradleUserHome, 'aggregate'),
        eventPayload: {
          repository: { default_branch: 'main' },
        },
        getState(name: string): string {
          if (name === 'buildish-mammoth-cache-gradle-base-cache-armed') {
            return 'true';
          }
          return savedState.get(name) ?? '';
        },
        inputProvider: createInputProvider('distributed-aggregator'),
        summaryWriter: summary.writer,
      });

      expect(saveCalls).toBe(1);
      expect(status.bootstrap.baseCacheResult).toEqual(
        expect.objectContaining({ status: 'saved' }),
      );
      expect(status.deltaArtifactResult).toEqual(
        expect.objectContaining({
          status: 'not-distributed-worker',
          modifiedCount: 1,
          totalChangedCount: 1,
        }),
      );
      expect(status.consumedDeltaCleanupResult).toEqual(
        expect.objectContaining({
          attemptedArtifactNames: [artifactNameToDelete],
          deletedArtifactNames: [artifactNameToDelete],
          warnings: [],
        }),
      );
      const summaryText = createPostActionSummaryLines(status).join('\n');
      expect(summaryText).toContain('## Apache Buildish Mammoth Cache for Gradle');
      expect(summaryText).toContain('<summary>Cache details</summary>');
      expect(summaryText).toContain('- Consumed delta cleanup: deleted 1 of 1');
      expect(summaryText).toContain('- Delta artifact: not\\-distributed\\-worker');
      expect(summaryText).toContain('- Post-build cache delta: 0 added, 1 modified, 0 deleted');
      expect(summary.writeCalls).toBe(1);
      await expect(artifactApi.listArtifacts()).resolves.toHaveLength(0);
    });
  });

  it('skips distributed-worker artifact upload when no cache changes were detected', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      const savedState = new Map<string, string>();
      const summary = createSummaryCapture();

      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'before',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);

      const status = await executePostAction({
        artifactApi,
        cacheApi: createCacheApi({ saveCache: async () => 0 }),
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        env: createTestEnv(workspace, gradleUserHome, 'worker-build'),
        eventPayload: {
          repository: { default_branch: 'main' },
        },
        getState(name: string): string {
          if (name === 'buildish-mammoth-cache-gradle-base-cache-armed') {
            return 'true';
          }
          return savedState.get(name) ?? '';
        },
        inputProvider: createInputProvider('distributed-worker'),
        summaryWriter: summary.writer,
      });

      expect(status.deltaArtifactResult).toEqual(
        expect.objectContaining({
          status: 'no-changes',
          addedCount: 0,
          modifiedCount: 0,
          deletedCount: 0,
          totalChangedCount: 0,
        }),
      );
      const summaryText = createPostActionSummaryLines(status).join('\n');
      expect(summaryText).toContain('## Apache Buildish Mammoth Cache for Gradle');
      expect(summaryText).toContain('- Delta artifact: no\\-changes');
      expect(summaryText).toContain('- Post-build cache delta: 0 added, 0 modified, 0 deleted');
      expect(summary.writeCalls).toBe(1);
      await expect(artifactApi.listArtifacts()).resolves.toHaveLength(0);
    });
  });
});

function createTestEnv(
  workspace: string,
  gradleUserHome: string,
  jobName: string,
): NodeJS.ProcessEnv {
  return {
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'apache/buildish',
    GITHUB_WORKFLOW: 'CI',
    GITHUB_JOB: jobName,
    GITHUB_RUN_ID: '101',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_STEP_SUMMARY: path.join(workspace, 'step-summary.md'),
    GITHUB_WORKSPACE: workspace,
    GRADLE_USER_HOME: gradleUserHome,
    HOME: workspace,
    RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64',
    RUNNER_TEMP: path.join(workspace, 'runner-temp'),
  };
}

function createTestCiContext(workspace: string) {
  return {
    platform: 'github' as const,
    eventName: 'push',
    resolvedRefName: 'main',
    safeRefName: 'main',
    runnerOs: 'linux',
    runnerArch: 'x64',
    defaultBranch: 'main',
    isPullRequest: false,
    repository: 'apache/buildish',
    workflowName: 'CI',
    jobName: 'worker-build',
    runId: 101,
    runAttempt: 2,
    tempDirectory: path.join(workspace, 'runner-temp'),
    workspace,
    actionPath: null,
  };
}

function createInputProvider(jobMode: string): { getInput(name: string): string } {
  return {
    getInput(name: string): string {
      return name === 'job-mode' ? jobMode : '';
    },
  };
}

function createCacheApi(options: { readonly saveCache: () => Promise<number> }): BaseCacheApi {
  return {
    isFeatureAvailable(): boolean {
      return true;
    },
    async restoreCache(): Promise<string | undefined> {
      throw new Error('restoreCache should not be called during post action flow');
    },
    async saveCache(): Promise<number> {
      return await options.saveCache();
    },
  };
}

function createSummaryCapture(): {
  readonly lines: string[];
  readonly writer: SummaryWriter;
  get writeCalls(): number;
} {
  const lines: string[] = [];
  let writeCalls = 0;
  const writer: SummaryWriter = {
    addRaw(text: string): SummaryWriter {
      lines.push(text);
      return writer;
    },
    async write(): Promise<void> {
      writeCalls += 1;
    },
  };

  return {
    lines,
    writer,
    get writeCalls(): number {
      return writeCalls;
    },
  };
}

function createTestCacheModel(gradleUserHome: string): CacheModel {
  const partitions = createCachePartitions(gradleUserHome);
  return {
    cacheKey: 'gradle-cache-2-21-linux-x64-feedcafe1234abcd-main',
    javaMajor: 21,
    runnerOs: 'linux',
    runnerArch: 'x64',
    safeRefName: 'main',
    partitionFingerprint: 'feedcafe1234abcd',
    partitions,
    includePaths: partitions.flatMap((partition) => partition.absoluteIncludeGlobs),
    excludePaths: [...new Set(partitions.flatMap((partition) => partition.absoluteExcludeGlobs))],
  };
}

async function persistPreBuildState(
  gradleUserHome: string,
  savedState: Map<string, string>,
  workspace: string,
): Promise<void> {
  const manifest = await captureCacheManifest(createTestCacheModel(gradleUserHome));
  await persistPreBuildCacheManifest(
    manifest,
    (name: string, value: string) => savedState.set(name, value),
    { env: { RUNNER_TEMP: path.join(workspace, 'runner-temp') } },
  );
  expect(savedState.get(PRE_BUILD_CACHE_MANIFEST_PATH_STATE)).toBeTruthy();
}

async function writeGradleFile(
  gradleUserHome: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const absolutePath = path.join(gradleUserHome, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, 'utf8');
}

async function writeCapturedBuildResult(
  gradleUserHome: string,
  options: {
    readonly invocationKey: string;
    readonly rootProjectName: string;
    readonly requestedTasks: string;
    readonly gradleVersion: string;
    readonly javaVersion: string;
    readonly configCacheHit: boolean;
    readonly buildScanUri: string | null;
  },
): Promise<void> {
  const resultsDirectory = path.join(
    gradleUserHome,
    '.buildish-mammoth-cache-gradle',
    'build-results',
  );
  const buildScansDirectory = path.join(
    gradleUserHome,
    '.buildish-mammoth-cache-gradle',
    'build-scans',
  );
  await mkdir(resultsDirectory, { recursive: true });
  await mkdir(buildScansDirectory, { recursive: true });
  await writeFile(
    path.join(resultsDirectory, `${options.invocationKey}.json`),
    JSON.stringify({
      capturedAtEpochMillis: 1_000,
      rootProjectName: options.rootProjectName,
      requestedTasks: options.requestedTasks,
      gradleVersion: options.gradleVersion,
      javaVersion: options.javaVersion,
      buildFailed: false,
      configCacheHit: options.configCacheHit,
    }),
    'utf8',
  );

  if (options.buildScanUri) {
    await writeFile(
      path.join(buildScansDirectory, `${options.invocationKey}.json`),
      JSON.stringify({ buildScanUri: options.buildScanUri, buildScanFailed: false }),
      'utf8',
    );
  }
}

async function withWorkspace(testBody: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), 'buildish-mammoth-cache-gradle-post-flow-'),
  );
  try {
    await testBody(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

class FakeArtifactApi implements WorkflowArtifactApi {
  private nextId = 1;
  private readonly artifacts = new Map<
    number,
    { descriptor: WorkflowArtifactDescriptor; directory: string }
  >();

  constructor(private readonly storageRoot: string) {}

  async uploadArtifact(
    name: string,
    _files: readonly string[],
    rootDirectory: string,
    options?: { readonly retentionDays?: number; readonly compressionLevel?: number },
  ): Promise<WorkflowArtifactDescriptor> {
    await mkdir(this.storageRoot, { recursive: true });
    const id = this.nextId++;
    const directory = path.join(this.storageRoot, String(id));
    await cp(rootDirectory, directory, { recursive: true });
    this.uploadRetentionDays.push(options?.retentionDays ?? null);

    const descriptor: WorkflowArtifactDescriptor = {
      id,
      name,
      size: 0,
      digest: null,
    };
    this.artifacts.set(id, { descriptor, directory });
    return descriptor;
  }

  async listArtifacts(): Promise<readonly WorkflowArtifactDescriptor[]> {
    return [...this.artifacts.values()].map((artifact) => artifact.descriptor);
  }

  async getArtifact(name: string): Promise<WorkflowArtifactDescriptor> {
    const artifact = [...this.artifacts.values()].find(
      (candidate) => candidate.descriptor.name === name,
    );
    if (!artifact) {
      throw new Error(`Artifact '${name}' not found.`);
    }
    return artifact.descriptor;
  }

  async downloadArtifact(
    artifactId: number,
    options?: { readonly path?: string; readonly expectedHash?: string },
  ): Promise<{ readonly downloadPath: string; readonly digestMismatch: boolean }> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) {
      throw new Error(`Artifact '${artifactId}' not found.`);
    }

    const parentDirectory = options?.path ?? this.storageRoot;
    const downloadPath = path.join(parentDirectory, `artifact-${artifactId}`);
    await cp(artifact.directory, downloadPath, { recursive: true });

    return {
      downloadPath,
      digestMismatch: false,
    };
  }

  async deleteArtifact(name: string): Promise<void> {
    this.deletedArtifactNames.push(name);
    const artifact = [...this.artifacts.entries()].find(
      ([, candidate]) => candidate.descriptor.name === name,
    );
    if (!artifact) {
      throw new Error(`Artifact '${name}' not found.`);
    }
    this.artifacts.delete(artifact[0]);
  }

  readonly uploadRetentionDays: Array<number | null> = [];

  readonly deletedArtifactNames: string[] = [];
}

async function stageWorkerArtifactForCleanup(
  artifactApi: WorkflowArtifactApi,
  workspace: string,
  jobName: string,
): Promise<void> {
  const workerGradleHome = path.join(workspace, `${jobName}-gradle-home`);
  await writeGradleFile(
    workerGradleHome,
    'caches/modules-2/files-2.1/example/module.bin',
    'worker-before',
  );
  const cacheModel = createTestCacheModel(workerGradleHome);
  const previousManifest = await captureCacheManifest(cacheModel);
  await writeGradleFile(
    workerGradleHome,
    'caches/modules-2/files-2.1/example/module.bin',
    'worker-after',
  );
  const currentManifest = await captureCacheManifest(cacheModel);
  const deltaManifest = computeCacheDelta(previousManifest, currentManifest);
  const stagedPackage = await stageDeltaArtifactPackage(
    {
      platform: 'github',
      eventName: 'push',
      resolvedRefName: 'main',
      safeRefName: 'main',
      runnerOs: 'linux',
      runnerArch: 'x64',
      defaultBranch: 'main',
      isPullRequest: false,
      repository: 'apache/buildish',
      workflowName: 'CI',
      jobName,
      runId: 101,
      runAttempt: 2,
      tempDirectory: path.join(workspace, 'runner-temp'),
      workspace,
      actionPath: null,
    },
    cacheModel,
    deltaManifest,
  );
  await artifactApi.uploadArtifact(
    stagedPackage.artifactName,
    stagedPackage.files,
    stagedPackage.rootDirectory,
  );
}
