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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { executePostAction } from '../src/post-flow';
import {
  persistPreBuildCacheManifest,
  PRE_BUILD_CACHE_MANIFEST_PATH_STATE,
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
      expect(summary.lines).toEqual(
        expect.arrayContaining([
          '## Apache Buildish bootstrap',
          '## Apache Buildish post action',
          '- Delta artifact result: uploaded',
          '- Post-build cache delta: 0 added, 1 modified, 0 deleted.',
          `- Uploaded artifact name: ${artifacts[0]!.name}`,
          `- Uploaded artifact ID: ${artifacts[0]!.id}`,
        ]),
      );
      expect(summary.writeCalls).toBe(2);
      await rm(downloaded.downloadDirectory, { recursive: true, force: true });
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
      expect(summary.lines).toEqual(
        expect.arrayContaining([
          '## Apache Buildish post action',
          '- Delta artifact result: not-distributed-worker',
          '- Post-build cache delta: 0 added, 1 modified, 0 deleted.',
        ]),
      );
      expect(summary.writeCalls).toBe(2);
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
      expect(summary.lines).toEqual(
        expect.arrayContaining([
          '## Apache Buildish post action',
          '- Consumed delta cleanup attempted: 1',
          '- Consumed delta cleanup deleted: 1',
          '- Consumed delta cleanup warnings: 0',
          '- Delta artifact result: not-distributed-worker',
          '- Post-build cache delta: 0 added, 1 modified, 0 deleted.',
        ]),
      );
      expect(summary.writeCalls).toBe(2);
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
      expect(summary.lines).toEqual(
        expect.arrayContaining([
          '## Apache Buildish post action',
          '- Delta artifact result: no-changes',
          '- Post-build cache delta: 0 added, 0 modified, 0 deleted.',
        ]),
      );
      expect(summary.writeCalls).toBe(2);
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
    GITHUB_WORKSPACE: workspace,
    GRADLE_USER_HOME: gradleUserHome,
    HOME: workspace,
    RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64',
    RUNNER_TEMP: path.join(workspace, 'runner-temp'),
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
    cacheKey: 'gradle-cache-1-21-linux-x64-main',
    javaMajor: 21,
    runnerOs: 'linux',
    runnerArch: 'x64',
    safeRefName: 'main',
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
