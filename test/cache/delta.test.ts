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

import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { type DownloadedDeltaArtifactPackage, stageDeltaArtifactPackage } from '../../src/artifacts/service';
import { applyMergedDeltaPlan, mergeDeltaArtifactPackages } from '../../src/cache/delta';
import { captureCacheManifest, computeCacheDelta } from '../../src/cache/manifest';
import { createCachePartitions, type CacheModel } from '../../src/cache/model';
import type { CiJobContext } from '../../src/ci/types';

describe('cache delta merge/apply engine', () => {
  const temporaryDirectories = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...temporaryDirectories].map(async (directory) => {
        temporaryDirectories.delete(directory);
        await rm(directory, { recursive: true, force: true });
      }),
    );
  });

  it('merges ordered delta packages and applies them to a Gradle user home', async () => {
    const packageA = await createDownloadedPackage(temporaryDirectories, 'Worker A', async (home) => {
      await writeGradleFile(home, 'caches/modules-2/files-2.1/example.jar', 'after-a');
    });
    const packageB = await createDownloadedPackage(temporaryDirectories, 'Worker B', async (home) => {
      await writeGradleFile(home, 'caches/build-cache-1/output.bin', 'build-output');
      await rm(path.join(home, 'wrapper/dists/gradle-8.10/bin.zip'));
    });
    const targetGradleUserHome = await createGradleUserHome(temporaryDirectories, 'cache-gradle-apply-');
    await seedBaseGradleUserHome(targetGradleUserHome);

    const plan = mergeDeltaArtifactPackages([packageA, packageB]);
    const result = await applyMergedDeltaPlan(plan, targetGradleUserHome);

    expect(
      plan.deltaManifest.partitions
        .filter((partition) => partition.entries.length > 0)
        .map((partition) => partition.partitionId),
    ).toEqual(['modules', 'build-cache', 'wrapper-dists']);
    expect(result).toMatchObject({ addedCount: 1, modifiedCount: 1, deletedCount: 1, warnings: [] });
    await expect(
      readFile(path.join(targetGradleUserHome, 'caches/modules-2/files-2.1/example.jar'), 'utf8'),
    ).resolves.toBe('after-a');
    await expect(
      readFile(path.join(targetGradleUserHome, 'caches/build-cache-1/output.bin'), 'utf8'),
    ).resolves.toBe('build-output');
    await expect(stat(path.join(targetGradleUserHome, 'wrapper/dists/gradle-8.10/bin.zip'))).rejects.toThrow();
  });

  it('fails hard when dependent deltas change the same file to different content', async () => {
    const packageA = await createDownloadedPackage(temporaryDirectories, 'Worker A', async (home) => {
      await writeGradleFile(home, 'caches/modules-2/files-2.1/example.jar', 'after-a');
    });
    const packageB = await createDownloadedPackage(temporaryDirectories, 'Worker B', async (home) => {
      await writeGradleFile(home, 'caches/modules-2/files-2.1/example.jar', 'after-b');
    });

    expect(() => mergeDeltaArtifactPackages([packageA, packageB])).toThrow(
      /Conflicting dependent deltas.*example.jar/u,
    );
  });

  it('allows identical overlapping content from multiple dependent deltas', async () => {
    const packageA = await createDownloadedPackage(temporaryDirectories, 'Worker A', async (home) => {
      await writeGradleFile(home, 'caches/modules-2/files-2.1/example.jar', 'same-after');
    });
    const packageB = await createDownloadedPackage(temporaryDirectories, 'Worker B', async (home) => {
      await writeGradleFile(home, 'caches/modules-2/files-2.1/example.jar', 'same-after');
    });

    const plan = mergeDeltaArtifactPackages([packageA, packageB]);
    expect(plan.payloads).toHaveLength(1);
    expect(plan.deltaManifest.partitions.find((partition) => partition.partitionId === 'modules')?.entries)
      .toHaveLength(1);
  });

  it('warns and falls back to preserving only mtime when atime restoration fails', async () => {
    const packageA = await createDownloadedPackage(temporaryDirectories, 'Worker A', async (home) => {
      await writeGradleFile(home, 'caches/build-cache-1/output.bin', 'build-output');
    });
    const targetGradleUserHome = await createGradleUserHome(temporaryDirectories, 'cache-gradle-times-');
    const basePlan = mergeDeltaArtifactPackages([packageA]);
    const plan = {
      ...basePlan,
      deltaManifest: {
        ...basePlan.deltaManifest,
        partitions: basePlan.deltaManifest.partitions.map((partition) => ({
          ...partition,
          entries: partition.entries.map((entry) =>
            entry.relativePath === 'caches/build-cache-1/output.bin' && entry.current
              ? {
                  ...entry,
                  current: { ...entry.current, atimeMs: entry.current.mtimeMs + 1000 },
                }
              : entry,
          ),
        })),
      },
    };
    const expectedMtimeMs =
      plan.deltaManifest.partitions.find((partition) => partition.partitionId === 'build-cache')?.entries[0]
        ?.current?.mtimeMs ?? 0;
    const setTimes = vi.fn(async (filePath: string, atime: Date, mtime: Date) => {
      if (atime.getTime() !== mtime.getTime()) {
        throw new Error('atime not supported');
      }
      await utimes(filePath, atime, mtime);
    });

    const result = await applyMergedDeltaPlan(plan, targetGradleUserHome, { setTimes });
    const fileStats = await stat(path.join(targetGradleUserHome, 'caches/build-cache-1/output.bin'));

    expect(result.warnings).toEqual([
      "Could not fully restore access time for 'caches/build-cache-1/output.bin'; preserved modification time only.",
    ]);
    expect(setTimes).toHaveBeenCalledTimes(2);
    expect(Math.round(fileStats.mtimeMs)).toBe(Math.round(expectedMtimeMs));
  });

  it('rejects existing symbolic-link targets during apply', async () => {
    const packageA = await createDownloadedPackage(temporaryDirectories, 'Worker A', async (home) => {
      await writeGradleFile(home, 'caches/build-cache-1/output.bin', 'build-output');
    });
    const targetGradleUserHome = await createGradleUserHome(temporaryDirectories, 'cache-gradle-symlink-');
    const targetPath = path.join(targetGradleUserHome, 'caches/build-cache-1/output.bin');
    await mkdir(path.dirname(targetPath), { recursive: true });
    await symlink('/tmp/escape', targetPath);

    await expect(applyMergedDeltaPlan(mergeDeltaArtifactPackages([packageA]), targetGradleUserHome)).rejects.toThrow(
      /must not be a symbolic link/u,
    );
  });
});

async function createDownloadedPackage(
  temporaryDirectories: Set<string>,
  jobName: string,
  mutateGradleUserHome: (gradleUserHome: string) => Promise<void>,
): Promise<DownloadedDeltaArtifactPackage> {
  const gradleUserHome = await createGradleUserHome(temporaryDirectories, 'cache-gradle-worker-');
  await seedBaseGradleUserHome(gradleUserHome);
  const cacheModel = createFixtureCacheModel(gradleUserHome);
  const previousManifest = await captureCacheManifest(cacheModel);

  await mutateGradleUserHome(gradleUserHome);

  const currentManifest = await captureCacheManifest(cacheModel);
  const deltaManifest = computeCacheDelta(previousManifest, currentManifest);
  const stagedPackage = await stageDeltaArtifactPackage(
    createFixtureCiContext(jobName),
    cacheModel,
    deltaManifest,
    { parentDirectory: await createTempDirectory(temporaryDirectories, 'cache-gradle-stage-parent-') },
  );

  return {
    artifact: { id: 1, name: stagedPackage.artifactName, size: 0, digest: null },
    downloadDirectory: stagedPackage.rootDirectory,
    metadata: stagedPackage.metadata,
    deltaManifest: stagedPackage.deltaManifest,
  };
}

async function seedBaseGradleUserHome(gradleUserHome: string): Promise<void> {
  await writeGradleFile(gradleUserHome, 'caches/modules-2/files-2.1/example.jar', 'before');
  await writeGradleFile(gradleUserHome, 'wrapper/dists/gradle-8.10/bin.zip', 'delete-me');
}

async function createGradleUserHome(
  temporaryDirectories: Set<string>,
  prefix: string,
): Promise<string> {
  const tempRoot = await createTempDirectory(temporaryDirectories, prefix);
  const gradleUserHome = path.join(tempRoot, '.gradle');
  await mkdir(gradleUserHome, { recursive: true });
  return gradleUserHome;
}

function createFixtureCacheModel(gradleUserHome: string): CacheModel {
  const partitions = createCachePartitions(gradleUserHome);

  return {
    cacheKey: 'gradle-cache-v1:21:linux:x64:main',
    javaMajor: 21,
    runnerOs: 'linux',
    runnerArch: 'x64',
    safeRefName: 'main',
    partitions,
    includePaths: partitions.flatMap((partition) => partition.absoluteIncludeGlobs),
    excludePaths: [...new Set(partitions.flatMap((partition) => partition.absoluteExcludeGlobs))],
  };
}

function createFixtureCiContext(jobName: string): CiJobContext {
  return {
    platform: 'github',
    eventName: 'push',
    resolvedRefName: 'main',
    safeRefName: 'main',
    runnerOs: 'linux',
    runnerArch: 'x64',
    defaultBranch: 'main',
    isPullRequest: false,
    repository: 'projectnessie/cache-gradle',
    workflowName: 'CI',
    jobName,
    runId: 12345,
    runAttempt: 2,
    workspace: '/tmp/workspace',
    actionPath: null,
  };
}

async function createTempDirectory(
  temporaryDirectories: Set<string>,
  prefix: string,
): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

async function writeGradleFile(
  gradleUserHome: string,
  relativePath: string,
  content: string,
  mode = 0o644,
): Promise<void> {
  const absolutePath = path.join(gradleUserHome, ...relativePath.split('/'));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
  await chmod(absolutePath, mode);
  const timestamp = new Date('2026-03-25T12:00:00.000Z');
  await utimes(absolutePath, timestamp, timestamp);
}
