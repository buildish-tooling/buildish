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

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CACHE_MANIFEST_SCHEMA_VERSION, type CacheManifest } from '../../src/cache/manifest';
import {
  getPersistedPreBuildCacheManifestPath,
  loadPersistedPreBuildCacheManifest,
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

async function withWorkspace(testBody: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cache-gradle-post-state-'));
  try {
    await testBody(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
