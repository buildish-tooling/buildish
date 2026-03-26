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

import { chmod, mkdir, mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  captureCacheManifest,
  computeCacheDelta,
  serializeCacheDeltaManifest,
  serializeCacheManifest,
  type CacheManifest,
} from '../../src/cache/manifest';
import {
  createCachePartitions,
  type CacheModel,
  type CachePartitionDefinition,
} from '../../src/cache/model';

describe('captureCacheManifest', () => {
  it('captures regular files by partition and excludes lock/configuration-cache content', async () => {
    await withGradleUserHome(async (gradleUserHome) => {
      await writeTrackedFile(gradleUserHome, 'caches/modules-2/files-2.1/example.jar', 'module');
      await writeTrackedFile(gradleUserHome, 'caches/8.10/fileHashes/hash.bin', 'transform');
      await writeTrackedFile(gradleUserHome, 'caches/8.10/scripts/script.bin', 'script');
      await writeTrackedFile(gradleUserHome, 'caches/build-cache-1/output.bin', 'build');
      await writeTrackedFile(
        gradleUserHome,
        'wrapper/dists/gradle-8.10/bin/gradle',
        'wrapper',
        0o755,
      );
      await writeTrackedFile(gradleUserHome, 'caches/modules-2/example.lock', 'ignored');
      await writeTrackedFile(
        gradleUserHome,
        'caches/modules-2/configuration-cache/should-be-ignored.bin',
        'ignored',
      );

      const manifest = await captureCacheManifest(createTestCacheModel(gradleUserHome));

      expect(flattenManifestPaths(manifest)).toEqual([
        'caches/8.10/fileHashes/hash.bin',
        'caches/8.10/scripts/script.bin',
        'caches/build-cache-1/output.bin',
        'caches/modules-2/files-2.1/example.jar',
        'wrapper/dists/gradle-8.10/bin/gradle',
      ]);
      expect(manifest.partitions.map((partition) => partition.partitionId)).toEqual([
        'modules',
        'transforms-metadata',
        'kotlin-dsl',
        'build-cache',
        'wrapper-dists',
      ]);
      const wrapperEntry = manifest.partitions.find(
        (partition) => partition.partitionId === 'wrapper-dists',
      )?.entries[0];
      expect(wrapperEntry).toBeDefined();
      expect(wrapperEntry!.mode & 0o777).toBe(0o755);
      expect(serializeCacheManifest(manifest)).toContain('"schemaVersion":1');
    });
  });

  it('preserves the pre-read access time when hashing updates atime', async () => {
    await withGradleUserHome(async (gradleUserHome) => {
      const relativePath = 'caches/modules-2/files-2.1/example.jar';
      const expectedAtime = new Date('2026-03-25T11:59:58.000Z');
      const expectedMtime = new Date('2026-03-25T12:00:00.000Z');
      const absolutePath = path.join(gradleUserHome, relativePath);

      await writeTrackedFile(gradleUserHome, relativePath, 'module');
      await utimes(absolutePath, expectedAtime, expectedMtime);

      const manifest = await captureCacheManifest(createTestCacheModel(gradleUserHome));
      const entry = manifest.partitions.find((partition) => partition.partitionId === 'modules')
        ?.entries[0];

      expect(entry).toMatchObject({
        relativePath,
        atimeMs: expectedAtime.getTime(),
        mtimeMs: expectedMtime.getTime(),
      });
    });
  });

  it('fails when the same file matches multiple cache partitions', async () => {
    await withGradleUserHome(async (gradleUserHome) => {
      await writeTrackedFile(gradleUserHome, 'shared/example.bin', 'shared');

      await expect(
        captureCacheManifest(createOverlappingCacheModel(gradleUserHome)),
      ).rejects.toThrow(/matches multiple cache partitions/);
    });
  });
});

describe('computeCacheDelta', () => {
  it('classifies added, modified, and deleted files per partition', async () => {
    await withGradleUserHome(async (gradleUserHome) => {
      const cacheModel = createTestCacheModel(gradleUserHome);
      await writeTrackedFile(gradleUserHome, 'caches/modules-2/files-2.1/example.jar', 'before');
      await writeTrackedFile(gradleUserHome, 'caches/build-cache-1/deleted.bin', 'delete-me');
      await writeTrackedFile(gradleUserHome, 'wrapper/dists/gradle-8.10/bin/gradle', 'same');

      const previousManifest = await captureCacheManifest(cacheModel);

      await writeTrackedFile(gradleUserHome, 'caches/modules-2/files-2.1/example.jar', 'after');
      await writeTrackedFile(gradleUserHome, 'caches/build-cache-1/added.bin', 'add-me');
      await unlink(path.join(gradleUserHome, 'caches/build-cache-1/deleted.bin'));

      const currentManifest = await captureCacheManifest(cacheModel);
      const delta = computeCacheDelta(previousManifest, currentManifest);

      expect(
        delta.partitions.find((partition) => partition.partitionId === 'modules')?.entries,
      ).toEqual([
        expect.objectContaining({
          relativePath: 'caches/modules-2/files-2.1/example.jar',
          changeType: 'modified',
        }),
      ]);
      expect(
        delta.partitions.find((partition) => partition.partitionId === 'build-cache')?.entries,
      ).toEqual([
        expect.objectContaining({
          relativePath: 'caches/build-cache-1/added.bin',
          changeType: 'added',
          previous: null,
        }),
        expect.objectContaining({
          relativePath: 'caches/build-cache-1/deleted.bin',
          changeType: 'deleted',
          current: null,
        }),
      ]);
      expect(
        delta.partitions
          .filter((partition) => partition.entries.length > 0)
          .map((partition) => partition.partitionId),
      ).toEqual(['modules', 'build-cache']);
      expect(serializeCacheDeltaManifest(delta)).toContain('"changeType":"modified"');
    });
  });

  it('rejects manifests from different Gradle user homes', () => {
    const previousManifest: CacheManifest = {
      schemaVersion: 1,
      gradleUserHome: '/tmp/one',
      partitions: [{ partitionId: 'modules', entries: [] }],
    };
    const currentManifest: CacheManifest = {
      schemaVersion: 1,
      gradleUserHome: '/tmp/two',
      partitions: [{ partitionId: 'modules', entries: [] }],
    };

    expect(() => computeCacheDelta(previousManifest, currentManifest)).toThrow(
      /same Gradle user home/,
    );
  });

  it('ignores atime-only differences so manifest capture does not manufacture large deltas', async () => {
    await withGradleUserHome(async (gradleUserHome) => {
      const cacheModel = createTestCacheModel(gradleUserHome);
      const relativePath = 'caches/modules-2/files-2.1/example.jar';
      const absolutePath = path.join(gradleUserHome, relativePath);
      const originalMtime = new Date('2026-03-25T12:00:00.000Z');

      await writeTrackedFile(gradleUserHome, relativePath, 'same-content');
      const previousManifest = await captureCacheManifest(cacheModel);

      await utimes(absolutePath, new Date('2026-03-25T13:30:00.000Z'), originalMtime);
      const currentManifest = await captureCacheManifest(cacheModel);
      const delta = computeCacheDelta(previousManifest, currentManifest);

      expect(delta.partitions.every((partition) => partition.entries.length === 0)).toBe(true);
    });
  });
});

async function withGradleUserHome(run: (gradleUserHome: string) => Promise<void>): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'buildish-mammoth-cache-gradle-manifest-'));
  const gradleUserHome = path.join(tempRoot, '.gradle');
  await mkdir(gradleUserHome, { recursive: true });

  try {
    await run(gradleUserHome);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function writeTrackedFile(
  gradleUserHome: string,
  relativePath: string,
  content: string,
  mode = 0o644,
): Promise<void> {
  const absolutePath = path.join(gradleUserHome, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
  await chmod(absolutePath, mode);
  const timestamp = new Date('2026-03-25T12:00:00.000Z');
  await utimes(absolutePath, timestamp, timestamp);
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

function createOverlappingCacheModel(gradleUserHome: string): CacheModel {
  const partitions: readonly CachePartitionDefinition[] = [
    createCustomPartition('modules', gradleUserHome, ['shared/**']),
    createCustomPartition('build-cache', gradleUserHome, ['shared/**']),
  ];

  return {
    cacheKey: 'overlap',
    javaMajor: 21,
    runnerOs: 'linux',
    runnerArch: 'x64',
    safeRefName: 'main',
    partitions,
    includePaths: partitions.flatMap((partition) => partition.absoluteIncludeGlobs),
    excludePaths: [],
  };
}

function createCustomPartition(
  id: CachePartitionDefinition['id'],
  gradleUserHome: string,
  relativeIncludeGlobs: readonly string[],
): CachePartitionDefinition {
  return {
    id,
    displayName: id,
    description: id,
    relativeIncludeGlobs,
    relativeExcludeGlobs: [],
    absoluteIncludeGlobs: relativeIncludeGlobs.map((glob) => path.join(gradleUserHome, glob)),
    absoluteExcludeGlobs: [],
  };
}

function flattenManifestPaths(manifest: CacheManifest): readonly string[] {
  return manifest.partitions
    .flatMap((partition) => partition.entries.map((entry) => entry.relativePath))
    .sort();
}
