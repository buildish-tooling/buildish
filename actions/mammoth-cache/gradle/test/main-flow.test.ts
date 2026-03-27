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
import { cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  stageDeltaArtifactPackage,
  type WorkflowArtifactDescriptor,
} from '../src/artifacts/service';
import {
  captureCacheManifest,
  computeCacheDelta,
  deserializeCacheManifest,
} from '../src/cache/manifest';
import { createCacheModel, type CacheModel } from '../src/cache/model';
import type { CiJobContext } from '../src/ci/types';
import type { NormalizedActionConfig } from '../src/config/types';
import {
  createMainActionOutputs,
  createMainActionSummaryLines,
  executeMainAction,
} from '../src/main-flow';
import {
  STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES,
  type WorkflowArtifactBackend,
} from '../src/storage/artifacts';
import {
  STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
  type BaseCacheBackend,
} from '../src/storage/cache';
import type { SummaryWriter } from '../src/reporting/types';
import {
  CONSUMED_DELTA_ARTIFACT_NAMES_STATE,
  PRE_BUILD_CACHE_MANIFEST_PATH_STATE,
} from '../src/state/post-action';
import {
  createTestGitHubProvider,
  createTestGitHubReportSink,
  createTestRuntimeHost,
} from './support/github-test-runtime';

function createMainActionDependencies(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly eventPayload: Record<string, unknown>;
  readonly summaryWriter: SummaryWriter;
  readonly inputs?: Readonly<Record<string, string>>;
  readonly saveState?: (name: string, value: string) => void;
  readonly info?: (message: string) => void;
}) {
  const runtimeHost = createTestRuntimeHost({
    inputs: options.inputs,
    saveState: options.saveState,
    info: options.info,
  });

  return {
    runtimeHost,
    ciProvider: createTestGitHubProvider(runtimeHost, {
      env: options.env,
      eventPayload: options.eventPayload,
    }),
    reportSink: createTestGitHubReportSink(runtimeHost, {
      env: options.env,
      summaryWriter: options.summaryWriter,
    }),
  };
}

describe('executeMainAction', () => {
  it('downloads dependent job deltas, applies them, and persists the pre-build manifest', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const wrapperJarBytes = Buffer.from('existing-wrapper-jar');
      const wrapperJarSha256 = sha256Hex(wrapperJarBytes);
      const savedState = new Map<string, string>();
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      const summary = createSummaryCapture();
      const infoMessages: string[] = [];

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
        artifactBackend: artifactApi,
        cacheBackend: createCacheApi(),
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        env: {
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REPOSITORY: 'apache/buildish',
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
        ...createMainActionDependencies({
          env: {
            GITHUB_EVENT_NAME: 'push',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_REPOSITORY: 'apache/buildish',
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
          inputs: {
            'job-mode': 'distributed-aggregator',
            'dependent-jobs': 'worker-build',
          },
          info(message: string): void {
            infoMessages.push(message);
          },
          saveState(name: string, value: string): void {
            savedState.set(name, value);
          },
          summaryWriter: summary.writer,
        }),
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
      expect(savedState.get('buildish-mammoth-cache-gradle-base-cache-armed')).toBe('true');
      expect(savedState.get(CONSUMED_DELTA_ARTIFACT_NAMES_STATE)).toContain(
        'buildish-mammoth-cache-gradle-delta-',
      );

      const manifestPath = savedState.get(PRE_BUILD_CACHE_MANIFEST_PATH_STATE);
      expect(manifestPath).toBeTruthy();
      const persistedManifest = deserializeCacheManifest(await readFile(manifestPath!, 'utf8'));
      expect(
        persistedManifest.partitions
          .flatMap((partition) => partition.entries)
          .map((entry) => entry.relativePath),
      ).toContain('caches/modules-2/files-2.1/example/module.bin');
      expect(summary.lines).toEqual([]);
      const summaryText = createMainActionSummaryLines(status).join('\n');
      expect(summaryText).toContain('## Apache Buildish prepare execution');
      expect(summaryText).toContain('- Restore cleanup: none');
      expect(summaryText).toContain('- Dependent delta reuse: 1 artifact(s) from 1 job(s)');
      expect(summaryText).toContain('- Pre-build manifest: persisted');
      expect(summaryText).toContain('<summary>Prepare-phase details</summary>');
      expect(summaryText).toContain('- Downloaded delta artifacts: 1');
      expect(summaryText).toContain('- Applied delta changes: 1 added, 0 modified, 0 deleted.');
      expect(summaryText).toContain('- Delta apply warnings: 0');
      expect(summaryText).toContain('- Post-job artifact cleanup scheduled: 1');
      expect(infoMessages).toEqual(
        expect.arrayContaining([
          '::group::Apache Buildish prepare execution',
          'Bootstrap: Prepared prepare phase for push on main in distributed-aggregator mode.',
          "GitHub input 'github-token' present: no.",
          "GitHub environment 'GITHUB_TOKEN' available: no.",
          "GitHub input 'github-job-check-run-id': unset.",
          'Wrapper provisioning: 1 ready (0 downloaded, 1 reused).',
          `Downloaded dependent delta artifacts: ${status.dependentDeltaResult!.downloadedArtifactNames[0]}.`,
          `Persisted pre-build cache manifest to '${manifestPath}'.`,
          '::endgroup::',
        ]),
      );
      expect(createMainActionOutputs(status)).toEqual({
        'cache-key': expect.stringMatching(
          /^buildish-mammoth-gradle-cache-2-21-linux-x64-[a-f0-9]{16}-main$/,
        ),
        'base-cache-restore-status': 'miss',
        'java-major': '21',
        'job-mode': 'distributed-aggregator',
        'read-only': 'false',
        'wrapper-count': '1',
        'gradle-versions': '8.14.0',
        'wrapper-downloaded-count': '0',
        'wrapper-reused-count': '1',
        'resolved-ref-name': 'main',
        'safe-ref-name': 'main',
        'dependent-jobs-count': '1',
        'downloaded-dependent-artifact-count': '1',
        'job-name': 'aggregate',
      });
      expect(summary.writeCalls).toBe(0);
    });
  });

  it('rejects dependent delta artifacts whose producer cache key does not match the current job', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const wrapperJarBytes = Buffer.from('existing-wrapper-jar');
      const wrapperJarSha256 = sha256Hex(wrapperJarBytes);
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));

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
          'distributionUrl=https://services.gradle.org/distributions/gradle-8.14-bin.zip',
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
        overrideCacheKey: 'mismatched-cache-key',
      });

      await expect(
        executeMainAction({
          artifactBackend: artifactApi,
          cacheBackend: createCacheApi(),
          captureCommandOutput: async (): Promise<string> =>
            'openjdk version "21.0.4" 2024-07-16\n',
          env: {
            GITHUB_EVENT_NAME: 'push',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_REPOSITORY: 'apache/buildish',
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
          ...createMainActionDependencies({
            env: {
              GITHUB_EVENT_NAME: 'push',
              GITHUB_REF: 'refs/heads/main',
              GITHUB_REPOSITORY: 'apache/buildish',
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
            inputs: {
              'job-mode': 'distributed-aggregator',
              'dependent-jobs': 'worker-build',
            },
            saveState(): void {},
            summaryWriter: createSummaryCapture().writer,
          }),
          verifyWrapperSignature: async () => {},
        }),
      ).rejects.toThrow(/targets cache key 'mismatched-cache-key'/);
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
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));

      const status = await executeMainAction({
        artifactBackend: artifactApi,
        cacheBackend: createCacheApi(),
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        env: {
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REPOSITORY: 'apache/buildish',
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
        ...createMainActionDependencies({
          env: {
            GITHUB_EVENT_NAME: 'push',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_REPOSITORY: 'apache/buildish',
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
          saveState(name: string, value: string): void {
            savedState.set(name, value);
          },
          summaryWriter: summary.writer,
        }),
        verifyWrapperSignature: async () => {},
      });

      expect(status.dependentDeltaResult).toBeNull();
      expect(status.preBuildManifestState).not.toBeNull();
      expect(savedState.get(PRE_BUILD_CACHE_MANIFEST_PATH_STATE)).toBeTruthy();
      const summaryText = createMainActionSummaryLines(status).join('\n');
      expect(summaryText).toContain('## Apache Buildish prepare execution');
      expect(summaryText).toContain('- Restore cleanup: none');
      expect(summaryText).toContain('- Dependent delta reuse: none');
      expect(summaryText).toContain('<summary>Prepare-phase details</summary>');
      expect(summaryText).toContain('- Downloaded delta artifacts: 0');
      expect(summaryText).toContain('- Pre-build manifest: persisted');
      expect(createMainActionOutputs(status)).toEqual({
        'cache-key': expect.stringMatching(
          /^buildish-mammoth-gradle-cache-2-21-linux-x64-[a-f0-9]{16}-main$/,
        ),
        'base-cache-restore-status': 'miss',
        'java-major': '21',
        'job-mode': 'standalone',
        'read-only': 'false',
        'wrapper-count': '1',
        'gradle-versions': '8.14.0',
        'wrapper-downloaded-count': '0',
        'wrapper-reused-count': '1',
        'resolved-ref-name': 'main',
        'safe-ref-name': 'main',
        'dependent-jobs-count': '0',
        'downloaded-dependent-artifact-count': '0',
        'job-name': 'build',
      });
      expect(summary.writeCalls).toBe(0);
    });
  });

  it('optionally prunes active managed files and re-restores on a base-cache hit', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const wrapperJarBytes = Buffer.from('existing-wrapper-jar');
      const wrapperJarSha256 = sha256Hex(wrapperJarBytes);
      const savedState = new Map<string, string>();
      const summary = createSummaryCapture();
      let restoreCalls = 0;

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
          'distributionUrl=https://services.gradle.org/distributions/gradle-8.14-bin.zip',
          'validateDistributionUrl=true',
          'zipStoreBase=GRADLE_USER_HOME',
          'zipStorePath=wrapper/dists',
          '',
        ].join('\n'),
        'utf8',
      );

      const managedFile = path.join(
        gradleUserHome,
        'caches',
        'modules-2',
        'files-2.1',
        'example',
        'module.bin',
      );
      await mkdir(path.dirname(managedFile), { recursive: true });
      await writeFile(managedFile, 'stale-local', 'utf8');
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));

      const status = await executeMainAction({
        artifactBackend: artifactApi,
        cacheBackend: createCacheApi({
          matchedKeyMode: 'primary',
          onRestore: async () => {
            restoreCalls += 1;
            await mkdir(path.dirname(managedFile), { recursive: true });
            await writeFile(managedFile, `from-cache-${restoreCalls}`, 'utf8');
          },
        }),
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        env: {
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REPOSITORY: 'apache/buildish',
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
        ...createMainActionDependencies({
          env: {
            GITHUB_EVENT_NAME: 'push',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_REPOSITORY: 'apache/buildish',
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
          inputs: {
            'restore-cleanup-mode': 'prune-managed',
          },
          saveState(name: string, value: string): void {
            savedState.set(name, value);
          },
          summaryWriter: summary.writer,
        }),
        verifyWrapperSignature: async () => {},
      });

      expect(status.restoreCleanupResult).toEqual(
        expect.objectContaining({
          mode: 'prune-managed',
          status: 'pruned',
          deletedFileCount: 1,
        }),
      );
      expect(restoreCalls).toBe(2);
      await expect(readFile(managedFile, 'utf8')).resolves.toBe('from-cache-2');
      const summaryText = createMainActionSummaryLines(status).join('\n');
      expect(summaryText).toContain('## Apache Buildish prepare execution');
      expect(summaryText).toContain('- Restore cleanup: prune-managed (1 deleted)');
      expect(summaryText).toContain('- Restore cleanup status: pruned');
      expect(summaryText).toContain('- Restore cleanup deleted files: 1');
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
          artifactBackend: artifactApi,
          cacheBackend: createCacheApi(),
          captureCommandOutput: async (): Promise<string> =>
            'openjdk version "21.0.4" 2024-07-16\n',
          env: {
            GITHUB_EVENT_NAME: 'push',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_REPOSITORY: 'apache/buildish',
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
          ...createMainActionDependencies({
            env: {
              GITHUB_EVENT_NAME: 'push',
              GITHUB_REF: 'refs/heads/main',
              GITHUB_REPOSITORY: 'apache/buildish',
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
            inputs: {
              'job-mode': 'distributed-aggregator',
              'dependent-jobs': 'windows-worker',
            },
            summaryWriter: createSummaryCapture().writer,
          }),
          verifyWrapperSignature: async () => {},
        }),
      ).rejects.toThrow(/Cross-runner dependent delta reuse is not supported/u);
    });
  });

  it('can resolve overlapping dependent delta paths by newest mtime when configured', async () => {
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
        jobName: 'worker-a',
        runId: 101,
        runAttempt: 2,
        relativePath: 'caches/modules-2/files-2.1/example/module.bin',
        contents: 'from-worker-a',
        modifiedAt: new Date('2026-03-25T12:00:02.000Z'),
        accessedAt: new Date('2026-03-25T12:00:01.000Z'),
      });
      await stageWorkerDeltaArtifact(artifactApi, workspace, {
        jobName: 'worker-b',
        runId: 101,
        runAttempt: 2,
        relativePath: 'caches/modules-2/files-2.1/example/module.bin',
        contents: 'from-worker-b',
        modifiedAt: new Date('2026-03-25T12:00:06.000Z'),
        accessedAt: new Date('2026-03-25T12:00:05.000Z'),
      });

      const status = await executeMainAction({
        artifactBackend: artifactApi,
        cacheBackend: createCacheApi(),
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        env: {
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REPOSITORY: 'apache/buildish',
          GITHUB_WORKFLOW: 'CI',
          GITHUB_JOB: 'aggregate',
          GITHUB_RUN_ID: '101',
          GITHUB_RUN_ATTEMPT: '2',
          GITHUB_WORKSPACE: workspace,
          GRADLE_USER_HOME: gradleUserHome,
          RUNNER_OS: 'Linux',
          RUNNER_ARCH: 'X64',
          HOME: workspace,
          RUNNER_TEMP: path.join(workspace, 'runner-temp'),
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
        ...createMainActionDependencies({
          env: {
            GITHUB_EVENT_NAME: 'push',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_REPOSITORY: 'apache/buildish',
            GITHUB_WORKFLOW: 'CI',
            GITHUB_JOB: 'aggregate',
            GITHUB_RUN_ID: '101',
            GITHUB_RUN_ATTEMPT: '2',
            GITHUB_WORKSPACE: workspace,
            GRADLE_USER_HOME: gradleUserHome,
            RUNNER_OS: 'Linux',
            RUNNER_ARCH: 'X64',
            HOME: workspace,
            RUNNER_TEMP: path.join(workspace, 'runner-temp'),
          },
          eventPayload: {
            repository: { default_branch: 'main' },
          },
          inputs: {
            'job-mode': 'distributed-aggregator',
            'dependent-jobs': 'worker-a,worker-b',
            'allow-duplicate-dependent-delta-paths': 'true',
          },
          summaryWriter: createSummaryCapture().writer,
        }),
        verifyWrapperSignature: async () => {},
      });

      expect(status.dependentDeltaResult).toEqual(
        expect.objectContaining({
          appliedArtifactCount: 2,
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
      ).resolves.toBe('from-worker-b');
    });
  });
});

async function stageWorkerDeltaArtifact(
  artifactApi: WorkflowArtifactBackend,
  workspace: string,
  options: {
    readonly jobName: string;
    readonly runId: number;
    readonly runAttempt: number;
    readonly relativePath: string;
    readonly contents: string;
    readonly accessedAt?: Date;
    readonly modifiedAt?: Date;
    readonly runnerOs?: string;
    readonly runnerArch?: string;
    readonly overrideCacheKey?: string;
  },
): Promise<void> {
  const workerGradleHome = path.join(workspace, `${options.jobName}-gradle-home`);
  await mkdir(path.dirname(path.join(workerGradleHome, options.relativePath)), { recursive: true });

  const cacheModel = await createTestCacheModel(
    workerGradleHome,
    options.runnerOs ?? 'linux',
    options.runnerArch ?? 'x64',
  );
  const previousManifest = await captureCacheManifest(cacheModel);
  await writeFile(path.join(workerGradleHome, options.relativePath), options.contents, 'utf8');
  if (options.accessedAt || options.modifiedAt) {
    const modifiedAt = options.modifiedAt ?? options.accessedAt ?? new Date();
    const accessedAt = options.accessedAt ?? modifiedAt;
    await utimes(path.join(workerGradleHome, options.relativePath), accessedAt, modifiedAt);
  }
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
    options.overrideCacheKey ? { ...cacheModel, cacheKey: options.overrideCacheKey } : cacheModel,
    deltaManifest,
  );

  await artifactApi.uploadArtifact(
    stagedPackage.artifactName,
    stagedPackage.files,
    stagedPackage.rootDirectory,
  );
}

async function createTestCacheModel(
  gradleUserHome: string,
  runnerOs = 'linux',
  runnerArch = 'x64',
): Promise<CacheModel> {
  return createCacheModel(
    createTestConfig(gradleUserHome),
    createCiContext('worker', gradleUserHome, 1, 1, runnerOs, runnerArch),
    {
      captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
    },
  );
}

function createTestConfig(gradleUserHome: string): NormalizedActionConfig {
  return {
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
    gradleUserHome,
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
    eventName: 'push',
    resolvedRefName: 'main',
    safeRefName: 'main',
    runnerOs,
    runnerArch,
    defaultBranch: 'main',
    isPullRequest: false,
    repository: 'apache/buildish',
    workflowName: 'CI',
    jobName,
    runId,
    runAttempt,
    tempDirectory: null,
    workspace,
    actionPath: null,
  };
}

function createCacheApi(
  options: {
    readonly matchedKeyMode?: 'miss' | 'primary';
    readonly onRestore?: () => Promise<void>;
  } = {},
): BaseCacheBackend {
  return {
    capabilities: STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
    isFeatureAvailable(): boolean {
      return true;
    },
    async restoreCache(_paths: string[], primaryKey: string): Promise<string | undefined> {
      await options.onRestore?.();
      return options.matchedKeyMode === 'primary' ? primaryKey : undefined;
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
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), 'buildish-mammoth-cache-gradle-main-flow-'),
  );
  try {
    await testBody(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

class FakeArtifactApi implements WorkflowArtifactBackend {
  readonly capabilities = STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES;

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
