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

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CACHE_MANIFEST_SCHEMA_VERSION, type CacheManifest } from '../../src/cache/manifest';
import type { BaseCacheRestoreResult } from '../../src/cache/service';
import type { CiJobContext } from '../../src/ci/types';
import {
  BASE_CACHE_RESTORE_RESULT_STATE,
  CONSUMED_DELTA_ARTIFACT_NAMES_STATE,
  DELTA_ARTIFACT_EXECUTION_IDENTITY_STATE,
  getPersistedBaseCacheRestoreResult,
  getPersistedConsumedDeltaArtifactNames,
  getPersistedDeltaArtifactExecutionIdentity,
  getPersistedPreBuildCacheManifestPath,
  loadPersistedPreBuildCacheManifest,
  persistBaseCacheRestoreResult,
  persistConsumedDeltaArtifactNames,
  persistDeltaArtifactExecutionIdentity,
  persistPreBuildCacheManifest,
  PRE_BUILD_CACHE_MANIFEST_PATH_STATE,
} from '../../src/state/post-action';

describe('post-action state helpers', () => {
  it('persists a pre-build manifest under RUNNER_TEMP and loads it back', async () => {
    await withWorkspace(async (workspace) => {
      const runnerTemp = path.join(workspace, 'runner-temp');
      const savedState = new Map<string, string>();

      const persisted = await persistPreBuildCacheManifest(
        SAMPLE_MANIFEST,
        savedState.set.bind(savedState),
        {
          env: { RUNNER_TEMP: runnerTemp },
        },
      );

      expect(persisted.manifestPath.startsWith(path.resolve(runnerTemp) + path.sep)).toBe(true);
      expect(savedState.get(PRE_BUILD_CACHE_MANIFEST_PATH_STATE)).toBe(persisted.manifestPath);
      await expect(readFile(persisted.manifestPath, 'utf8')).resolves.toContain('"gradleUserHome"');
      await expect(
        loadPersistedPreBuildCacheManifest((name: string) => savedState.get(name) ?? ''),
      ).resolves.toEqual(SAMPLE_MANIFEST);
    });
  });

  it('prefers an explicit parent directory over RUNNER_TEMP', async () => {
    await withWorkspace(async (workspace) => {
      const savedState = new Map<string, string>();
      const parentDirectory = path.join(workspace, 'custom-parent');

      const persisted = await persistPreBuildCacheManifest(
        SAMPLE_MANIFEST,
        savedState.set.bind(savedState),
        {
          env: { RUNNER_TEMP: path.join(workspace, 'runner-temp') },
          parentDirectory,
        },
      );

      expect(persisted.manifestPath.startsWith(path.resolve(parentDirectory) + path.sep)).toBe(
        true,
      );
    });
  });

  it('returns null for blank state and resolves trimmed manifest paths', () => {
    expect(getPersistedPreBuildCacheManifestPath(() => '   ')).toBeNull();
    expect(
      getPersistedPreBuildCacheManifestPath(
        () => '  relative/post-state/pre-build-cache-manifest.json  ',
      ),
    ).toBe(path.resolve('relative/post-state/pre-build-cache-manifest.json'));
  });

  it('persists consumed delta artifact names as trimmed unique JSON state', () => {
    const savedState = new Map<string, string>();

    persistConsumedDeltaArtifactNames(
      ['artifact-a', 'artifact-b', 'artifact-a'],
      savedState.set.bind(savedState),
    );

    expect(savedState.get(CONSUMED_DELTA_ARTIFACT_NAMES_STATE)).toContain('artifact-a');
    expect(
      getPersistedConsumedDeltaArtifactNames((name: string) =>
        name === CONSUMED_DELTA_ARTIFACT_NAMES_STATE
          ? '  ["artifact-a", "artifact-b", "artifact-a"]\n '
          : '',
      ),
    ).toEqual(['artifact-a', 'artifact-b']);
  });

  it('persists and reloads the base cache restore result', () => {
    const savedState = new Map<string, string>();

    persistBaseCacheRestoreResult(
      SAMPLE_BASE_CACHE_RESTORE_RESULT,
      savedState.set.bind(savedState),
    );

    expect(savedState.get(BASE_CACHE_RESTORE_RESULT_STATE)).toContain('exact-hit');
    expect(
      getPersistedBaseCacheRestoreResult((name: string) => savedState.get(name) ?? ''),
    ).toEqual(SAMPLE_BASE_CACHE_RESTORE_RESULT);
  });

  it('persists only normalized execution identity for delta artifacts', () => {
    const savedState = new Map<string, string>();

    persistDeltaArtifactExecutionIdentity(SAMPLE_CI_CONTEXT, savedState.set.bind(savedState));

    expect(savedState.get(DELTA_ARTIFACT_EXECUTION_IDENTITY_STATE)).toBe(
      '{"jobName":"check","runId":123,"runAttempt":1}\n',
    );
    expect(
      getPersistedDeltaArtifactExecutionIdentity((name: string) => savedState.get(name) ?? ''),
    ).toEqual({
      jobName: 'check',
      runId: 123,
      runAttempt: 1,
    });

    const parsedState = JSON.parse(
      savedState.get(DELTA_ARTIFACT_EXECUTION_IDENTITY_STATE) ?? 'null',
    ) as Record<string, unknown>;
    expect(Object.keys(parsedState).sort()).toEqual(['jobName', 'runAttempt', 'runId']);
    expect(parsedState).not.toHaveProperty('platform');
    expect(parsedState).not.toHaveProperty('provider');
  });

  it('rejects malformed consumed delta artifact state', () => {
    expect(() => getPersistedConsumedDeltaArtifactNames(() => 'not-json')).toThrow(/valid JSON/u);
    expect(() => getPersistedConsumedDeltaArtifactNames(() => '[""]')).toThrow(
      /must not be blank/u,
    );
  });

  it('rejects unsupported base cache restore result state', () => {
    expect(() =>
      getPersistedBaseCacheRestoreResult(
        () =>
          '{"operation":"restore","status":"saved","cacheKey":"cache-key","matchedKey":null,"restoreKeys":[],"paths":["/tmp/.gradle"],"message":"bad"}',
      ),
    ).toThrow(/Unsupported base cache restore result status/u);
  });
});

const SAMPLE_MANIFEST: CacheManifest = {
  schemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
  gradleUserHome: '/tmp/gradle-home',
  partitions: [
    {
      partitionId: 'modules',
      entries: [
        {
          relativePath: 'caches/modules-2/files-2.1/example/module.bin',
          contentSha256: 'a'.repeat(64),
          size: 5,
          mode: 0o100644,
          atimeMs: 1000,
          mtimeMs: 2000,
        },
      ],
    },
  ],
};

const SAMPLE_BASE_CACHE_RESTORE_RESULT: BaseCacheRestoreResult = {
  operation: 'restore',
  status: 'exact-hit',
  cacheKey: 'buildish-cache-main-linux',
  matchedKey: 'buildish-cache-main-linux',
  restoreKeys: ['buildish-cache-main-linux', 'buildish-cache-main'],
  paths: ['/tmp/workspace/.gradle/caches'],
  message: 'Restored cache using exact key hit.',
};

const SAMPLE_CI_CONTEXT: CiJobContext = {
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

async function withWorkspace(testBody: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), 'buildish-mammoth-cache-gradle-post-state-'),
  );
  try {
    await testBody(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
