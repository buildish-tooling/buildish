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

import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  stageDeltaArtifactPackage,
  type WorkflowArtifactApi,
  type WorkflowArtifactDescriptor,
} from '../src/artifacts/service';
import {
  captureCacheManifest,
  computeCacheDelta,
  deserializeCacheManifest,
} from '../src/cache/manifest';
import { createCachePartitions, type CacheModel } from '../src/cache/model';
import type { BaseCacheApi } from '../src/cache/service';
import type { CiJobContext, SummaryWriter } from '../src/ci/types';
import { executeMainAction } from '../src/main-flow';
import {
  CONSUMED_DELTA_ARTIFACT_NAMES_STATE,
  PRE_BUILD_CACHE_MANIFEST_PATH_STATE,
} from '../src/state/post-action';

describe('executeMainAction', () => {
  it('downloads dependent job deltas, applies them, and persists the pre-build manifest', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const wrapperJarBytes = Buffer.from('existing-wrapper-jar');
      const wrapperJarSha256 = sha256Hex(wrapperJarBytes);
      const savedState = new Map<string, string>();
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      const summary = createSummaryCapture();

      await mkdir(path.join(workspace, 'gradle', 'wrapper'), { recursive: true });
      await mkdir(gradleUserHome, { recursive: true });
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
        wrapperJarBytes,
      );
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
        [
          'distributionBase=GRADLE_USER_HOME',
          'distributionPath=wrapper/dists',
          'distributionSha256Sum=61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
          'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14-bin.zip',
          'validateDistributionUrl=true',
          'zipStoreBase=GRADLE_USER_HOME',
          'zipStorePath=wrapper/dists',
          '',
        ].join('\n'),
        'utf8',
      );

      await stageWorkerDeltaArtifact(artifactApi, workspace, {
        jobName: 'worker-build',
        runId: 101,
        runAttempt: 2,
        relativePath: 'caches/modules-2/files-2.1/example/module.bin',
        contents: 'from-worker-delta',
      });

      const status = await executeMainAction({
        artifactApi,
        cacheApi: createCacheApi(),
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        env: {
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REPOSITORY: 'projectnessie/cache-gradle',
          GITHUB_WORKFLOW: 'CI',
          GITHUB_JOB: 'aggregate',
          GITHUB_RUN_ID: '101',
          GITHUB_RUN_ATTEMPT: '2',
          GITHUB_WORKSPACE: workspace,
          GRADLE_USER_HOME: gradleUserHome,
          HOME: workspace,
          RUNNER_OS: 'Linux',
          RUNNER_ARCH: 'X64',
          RUNNER_TEMP: path.join(workspace, 'runner-temp'),
        },
        eventPayload: {
          repository: { default_branch: 'main' },
        },
        fetchImpl: async (input: string | URL | Request): Promise<Response> => {
          const url = String(input);
          if (url.endsWith('gradle-8.14-wrapper.jar.sha256')) {
            return new Response(`${wrapperJarSha256}\n`, { status: 200 });
          }
          if (url.endsWith('gradle-8.14-wrapper.jar.asc')) {
            return new Response(TEST_SIGNATURE_ARMORED, { status: 200 });
          }
          throw new Error(`Unexpected fetch URL: ${url}`);
        },
        inputProvider: {
          getInput(name: string): string {
            switch (name) {
              case 'job-mode':
                return 'distributed-aggregator';
              case 'dependent-jobs':
                return 'worker-build';
              default:
                return '';
            }
          },
        },
        saveState(name: string, value: string): void {
          savedState.set(name, value);
        },
        summaryWriter: summary.writer,
        verifyWrapperSignature: async () => {},
      });

      expect(status.bootstrap.config.jobMode).toBe('distributed-aggregator');
      expect(status.dependentDeltaResult).toEqual(
        expect.objectContaining({
          appliedArtifactCount: 1,
          addedCount: 1,
          modifiedCount: 0,
          deletedCount: 0,
        }),
      );
      await expect(
        readFile(
          path.join(gradleUserHome, 'caches', 'modules-2', 'files-2.1', 'example', 'module.bin'),
          'utf8',
        ),
      ).resolves.toBe('from-worker-delta');
      expect(savedState.get('cache-gradle-base-cache-armed')).toBe('true');
      expect(savedState.get(CONSUMED_DELTA_ARTIFACT_NAMES_STATE)).toContain('cache-gradle-delta-');

      const manifestPath = savedState.get(PRE_BUILD_CACHE_MANIFEST_PATH_STATE);
      expect(manifestPath).toBeTruthy();
      const persistedManifest = deserializeCacheManifest(await readFile(manifestPath!, 'utf8'));
      expect(
        persistedManifest.partitions
          .flatMap((partition) => partition.entries)
          .map((entry) => entry.relativePath),
      ).toContain('caches/modules-2/files-2.1/example/module.bin');
      expect(summary.lines).toEqual(
        expect.arrayContaining([
          '## Cache Gradle bootstrap',
          '## Wrapper provisioning',
          '- gradle/wrapper/gradle-wrapper.properties: reused trusted wrapper JAR at gradle/wrapper/gradle-wrapper.jar for Gradle 8.14.0.',
          '## Cache Gradle main action',
          '- Dependent jobs requested: worker-build',
          '- Downloaded delta artifacts: 1',
          `- Artifact names: ${status.dependentDeltaResult!.downloadedArtifactNames[0]}`,
          '- Applied delta changes: 1 added, 0 modified, 0 deleted.',
          '- Delta apply warnings: 0',
          '- Post-job artifact cleanup scheduled: 1',
          '- Pre-build manifest persisted: yes',
        ]),
      );
      expect(summary.writeCalls).toBe(2);
    });
  });

  it('captures pre-build state even without dependent jobs', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const wrapperJarBytes = Buffer.from('existing-wrapper-jar');
      const wrapperJarSha256 = sha256Hex(wrapperJarBytes);
      const savedState = new Map<string, string>();
      const summary = createSummaryCapture();

      await mkdir(path.join(workspace, 'gradle', 'wrapper'), { recursive: true });
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
        wrapperJarBytes,
      );
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
        [
          'distributionBase=GRADLE_USER_HOME',
          'distributionPath=wrapper/dists',
          'distributionSha256Sum=61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
          'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14-bin.zip',
          'validateDistributionUrl=true',
          'zipStoreBase=GRADLE_USER_HOME',
          'zipStorePath=wrapper/dists',
          '',
        ].join('\n'),
        'utf8',
      );

      const status = await executeMainAction({
        cacheApi: createCacheApi(),
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        env: {
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REPOSITORY: 'projectnessie/cache-gradle',
          GITHUB_WORKFLOW: 'CI',
          GITHUB_JOB: 'build',
          GITHUB_RUN_ID: '101',
          GITHUB_RUN_ATTEMPT: '2',
          GITHUB_WORKSPACE: workspace,
          GRADLE_USER_HOME: gradleUserHome,
          HOME: workspace,
          RUNNER_OS: 'Linux',
          RUNNER_ARCH: 'X64',
          RUNNER_TEMP: path.join(workspace, 'runner-temp'),
        },
        eventPayload: {
          repository: { default_branch: 'main' },
        },
        fetchImpl: async (input: string | URL | Request): Promise<Response> => {
          const url = String(input);
          if (url.endsWith('gradle-8.14-wrapper.jar.sha256')) {
            return new Response(`${wrapperJarSha256}\n`, { status: 200 });
          }
          if (url.endsWith('gradle-8.14-wrapper.jar.asc')) {
            return new Response(TEST_SIGNATURE_ARMORED, { status: 200 });
          }
          throw new Error(`Unexpected fetch URL: ${url}`);
        },
        inputProvider: {
          getInput(): string {
            return '';
          },
        },
        saveState(name: string, value: string): void {
          savedState.set(name, value);
        },
        summaryWriter: summary.writer,
        verifyWrapperSignature: async () => {},
      });

      expect(status.dependentDeltaResult).toBeNull();
      expect(status.preBuildManifestState).not.toBeNull();
      expect(savedState.get(PRE_BUILD_CACHE_MANIFEST_PATH_STATE)).toBeTruthy();
      expect(summary.lines).toEqual(
        expect.arrayContaining([
          '## Cache Gradle main action',
          '- Dependent jobs requested: none',
          '- Downloaded delta artifacts: 0',
          '- Pre-build manifest persisted: yes',
        ]),
      );
      expect(summary.writeCalls).toBe(2);
    });
  });

  it('rejects dependent deltas produced for a different runner OS or architecture', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const wrapperJarBytes = Buffer.from('existing-wrapper-jar');
      const wrapperJarSha256 = sha256Hex(wrapperJarBytes);

      await mkdir(path.join(workspace, 'gradle', 'wrapper'), { recursive: true });
      await mkdir(gradleUserHome, { recursive: true });
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
        wrapperJarBytes,
      );
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
        [
          'distributionBase=GRADLE_USER_HOME',
          'distributionPath=wrapper/dists',
          'distributionSha256Sum=61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
          'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14-bin.zip',
          'validateDistributionUrl=true',
          'zipStoreBase=GRADLE_USER_HOME',
          'zipStorePath=wrapper/dists',
          '',
        ].join('\n'),
        'utf8',
      );

      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      await stageWorkerDeltaArtifact(artifactApi, workspace, {
        jobName: 'windows-worker',
        runId: 101,
        runAttempt: 2,
        relativePath: 'caches/modules-2/files-2.1/example/module.bin',
        contents: 'from-worker-delta',
        runnerOs: 'windows',
      });

      await expect(
        executeMainAction({
          artifactApi,
          cacheApi: createCacheApi(),
          captureCommandOutput: async (): Promise<string> =>
            'openjdk version "21.0.4" 2024-07-16\n',
          env: {
            GITHUB_EVENT_NAME: 'push',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_REPOSITORY: 'projectnessie/cache-gradle',
            GITHUB_WORKFLOW: 'CI',
            GITHUB_JOB: 'aggregate',
            GITHUB_RUN_ID: '101',
            GITHUB_RUN_ATTEMPT: '2',
            GITHUB_WORKSPACE: workspace,
            GRADLE_USER_HOME: gradleUserHome,
            HOME: workspace,
            RUNNER_OS: 'Linux',
            RUNNER_ARCH: 'X64',
            RUNNER_TEMP: path.join(workspace, 'runner-temp'),
          },
          eventPayload: {
            repository: { default_branch: 'main' },
          },
          fetchImpl: async (input: string | URL | Request): Promise<Response> => {
            const url = String(input);
            if (url.endsWith('gradle-8.14-wrapper.jar.sha256')) {
              return new Response(`${wrapperJarSha256}\n`, { status: 200 });
            }
            if (url.endsWith('gradle-8.14-wrapper.jar.asc')) {
              return new Response(TEST_SIGNATURE_ARMORED, { status: 200 });
            }
            throw new Error(`Unexpected fetch URL: ${url}`);
          },
          inputProvider: {
            getInput(name: string): string {
              switch (name) {
                case 'job-mode':
                  return 'distributed-aggregator';
                case 'dependent-jobs':
                  return 'windows-worker';
                default:
                  return '';
              }
            },
          },
          summaryWriter: createSummaryCapture().writer,
          verifyWrapperSignature: async () => {},
        }),
      ).rejects.toThrow(/Cross-runner dependent delta reuse is not supported/u);
    });
  });
});

async function stageWorkerDeltaArtifact(
  artifactApi: WorkflowArtifactApi,
  workspace: string,
  options: {
    readonly jobName: string;
    readonly runId: number;
    readonly runAttempt: number;
    readonly relativePath: string;
    readonly contents: string;
    readonly runnerOs?: string;
    readonly runnerArch?: string;
  },
): Promise<void> {
  const workerGradleHome = path.join(workspace, `${options.jobName}-gradle-home`);
  await mkdir(path.dirname(path.join(workerGradleHome, options.relativePath)), { recursive: true });

  const cacheModel = createTestCacheModel(
    workerGradleHome,
    options.runnerOs ?? 'linux',
    options.runnerArch ?? 'x64',
  );
  const previousManifest = await captureCacheManifest(cacheModel);
  await writeFile(path.join(workerGradleHome, options.relativePath), options.contents, 'utf8');
  const currentManifest = await captureCacheManifest(cacheModel);
  const deltaManifest = computeCacheDelta(previousManifest, currentManifest);
  const stagedPackage = await stageDeltaArtifactPackage(
    createCiContext(
      options.jobName,
      workspace,
      options.runId,
      options.runAttempt,
      options.runnerOs ?? 'linux',
      options.runnerArch ?? 'x64',
    ),
    cacheModel,
    deltaManifest,
  );

  await artifactApi.uploadArtifact(
    stagedPackage.artifactName,
    stagedPackage.files,
    stagedPackage.rootDirectory,
  );
}

function createTestCacheModel(
  gradleUserHome: string,
  runnerOs = 'linux',
  runnerArch = 'x64',
): CacheModel {
  const partitions = createCachePartitions(gradleUserHome);
  return {
    cacheKey: `gradle-cache-1-21-${runnerOs}-${runnerArch}-main`,
    javaMajor: 21,
    runnerOs,
    runnerArch,
    safeRefName: 'main',
    partitions,
    includePaths: partitions.flatMap((partition) => partition.absoluteIncludeGlobs),
    excludePaths: [...new Set(partitions.flatMap((partition) => partition.absoluteExcludeGlobs))],
  };
}

function createCiContext(
  jobName: string,
  workspace: string,
  runId: number,
  runAttempt: number,
  runnerOs = 'linux',
  runnerArch = 'x64',
): CiJobContext {
  return {
    platform: 'github',
    eventName: 'push',
    resolvedRefName: 'main',
    safeRefName: 'main',
    runnerOs,
    runnerArch,
    defaultBranch: 'main',
    isPullRequest: false,
    repository: 'projectnessie/cache-gradle',
    workflowName: 'CI',
    jobName,
    runId,
    runAttempt,
    workspace,
    actionPath: null,
  };
}

function createCacheApi(): BaseCacheApi {
  return {
    isFeatureAvailable(): boolean {
      return true;
    },
    async restoreCache(): Promise<string | undefined> {
      return undefined;
    },
    async saveCache(): Promise<number> {
      throw new Error('saveCache should not be called during main action flow');
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

async function withWorkspace(testBody: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cache-gradle-main-flow-'));
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
    _options?: { readonly retentionDays?: number; readonly compressionLevel?: number },
  ): Promise<WorkflowArtifactDescriptor> {
    await mkdir(this.storageRoot, { recursive: true });
    const id = this.nextId++;
    const directory = path.join(this.storageRoot, String(id));
    await cp(rootDirectory, directory, { recursive: true });

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
    const artifact = [...this.artifacts.entries()].find(
      ([, candidate]) => candidate.descriptor.name === name,
    );
    if (!artifact) {
      throw new Error(`Artifact '${name}' not found.`);
    }
    this.artifacts.delete(artifact[0]);
  }
}

const TEST_SIGNATURE_ARMORED = `-----BEGIN PGP SIGNATURE-----
Version: test

ZmFrZQ==
=abcd
-----END PGP SIGNATURE-----`;

function sha256Hex(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
