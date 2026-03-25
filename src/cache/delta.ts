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

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, rename, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  PORTABLE_GRADLE_USER_HOME,
  type DownloadedDeltaArtifactPackage,
} from '../artifacts/service';
import { validateNormalizedRelativePosixPath } from '../validation';

import {
  CACHE_MANIFEST_SCHEMA_VERSION,
  type CacheDeltaEntry,
  type CacheDeltaManifest,
  type CacheFileSnapshot,
} from './manifest';
import type { CachePartitionDefinition } from './model';

interface MergedDeltaState {
  readonly entry: CacheDeltaEntry;
  readonly artifactName: string;
  readonly producerJobName: string;
  readonly payloadPath: string | null;
}

export interface MergedDeltaPayload {
  readonly relativePath: string;
  readonly payloadPath: string;
  readonly artifactName: string;
  readonly producerJobName: string;
}

export interface MergedDeltaPlan {
  readonly deltaManifest: CacheDeltaManifest;
  readonly payloads: readonly MergedDeltaPayload[];
}

export interface DeltaApplyOptions {
  readonly setTimes?: (filePath: string, atime: Date, mtime: Date) => Promise<unknown>;
}

export interface DeltaApplyResult {
  readonly gradleUserHome: string;
  readonly addedCount: number;
  readonly modifiedCount: number;
  readonly deletedCount: number;
  readonly warnings: readonly string[];
}

export function mergeDeltaArtifactPackages(
  packages: readonly DownloadedDeltaArtifactPackage[],
): MergedDeltaPlan {
  if (packages.length === 0) {
    return {
      deltaManifest: {
        schemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
        gradleUserHome: PORTABLE_GRADLE_USER_HOME,
        partitions: [],
      },
      payloads: [],
    };
  }

  const expectedPartitionIds = packages[0]!.deltaManifest.partitions.map(
    (partition) => partition.partitionId,
  );
  const mergedByPartition = new Map<
    CachePartitionDefinition['id'],
    Map<string, MergedDeltaState>
  >();

  for (const artifactPackage of packages) {
    assertPortableDeltaPackage(artifactPackage, expectedPartitionIds);
    const payloads = collectPayloadPaths(artifactPackage);

    for (const partition of artifactPackage.deltaManifest.partitions) {
      const partitionEntries =
        mergedByPartition.get(partition.partitionId) ?? new Map<string, MergedDeltaState>();
      mergedByPartition.set(partition.partitionId, partitionEntries);

      for (const entry of partition.entries) {
        const candidatePayloadPath =
          entry.changeType === 'deleted' ? null : (payloads.get(entry.relativePath) ?? null);
        if (entry.changeType !== 'deleted' && !candidatePayloadPath) {
          throw new Error(
            `Downloaded delta artifact '${artifactPackage.artifact.name}' is missing payload metadata for '${entry.relativePath}'.`,
          );
        }

        const existing = partitionEntries.get(entry.relativePath);
        if (!existing) {
          partitionEntries.set(entry.relativePath, {
            entry,
            artifactName: artifactPackage.artifact.name,
            producerJobName: artifactPackage.metadata.producer.jobName,
            payloadPath: candidatePayloadPath,
          });
          continue;
        }

        if (areMergeCompatible(existing.entry, entry)) {
          continue;
        }

        throw new Error(
          `Conflicting dependent deltas for '${entry.relativePath}': artifact '${existing.artifactName}' from job '${existing.producerJobName}' and artifact '${artifactPackage.artifact.name}' from job '${artifactPackage.metadata.producer.jobName}' produce different content or metadata.`,
        );
      }
    }
  }

  const partitions = expectedPartitionIds.map((partitionId) => ({
    partitionId,
    entries: [...(mergedByPartition.get(partitionId)?.values() ?? [])]
      .map((state) => state.entry)
      .sort(compareEntriesByPath),
  }));
  const payloads = [...mergedByPartition.values()]
    .flatMap((partitionEntries) => [...partitionEntries.values()])
    .filter((state) => state.payloadPath !== null)
    .map((state) => ({
      relativePath: state.entry.relativePath,
      payloadPath: state.payloadPath!,
      artifactName: state.artifactName,
      producerJobName: state.producerJobName,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return {
    deltaManifest: {
      schemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
      gradleUserHome: PORTABLE_GRADLE_USER_HOME,
      partitions,
    },
    payloads,
  };
}

export async function applyMergedDeltaPlan(
  plan: MergedDeltaPlan,
  gradleUserHome: string,
  options: DeltaApplyOptions = {},
): Promise<DeltaApplyResult> {
  const resolvedGradleUserHome = path.resolve(gradleUserHome);
  const setTimes = options.setTimes ?? defaultSetTimes;
  const warnings: string[] = [];
  const payloads = new Map(plan.payloads.map((payload) => [payload.relativePath, payload]));
  let addedCount = 0;
  let modifiedCount = 0;
  let deletedCount = 0;

  await ensureDirectoryPath(resolvedGradleUserHome, '');

  for (const partition of plan.deltaManifest.partitions) {
    for (const entry of partition.entries) {
      const targetPath = resolvePathWithinRoot(
        resolvedGradleUserHome,
        entry.relativePath,
        'merged delta relativePath',
      );

      if (entry.changeType === 'deleted') {
        await deleteTargetPath(resolvedGradleUserHome, targetPath, entry.relativePath);
        deletedCount += 1;
        continue;
      }

      const currentSnapshot = entry.current;
      if (!currentSnapshot) {
        throw new Error(
          `Merged delta entry '${entry.relativePath}' is missing its current snapshot.`,
        );
      }

      const payload = payloads.get(entry.relativePath);
      if (!payload) {
        throw new Error(`Merged delta entry '${entry.relativePath}' is missing its payload file.`);
      }

      await writePayloadAtomically(
        payload.payloadPath,
        resolvedGradleUserHome,
        targetPath,
        entry.relativePath,
        currentSnapshot,
      );
      const timestampWarning = await restoreFileTimestamps(
        targetPath,
        entry.relativePath,
        currentSnapshot,
        setTimes,
      );
      if (timestampWarning) {
        warnings.push(timestampWarning);
      }

      if (entry.changeType === 'added') {
        addedCount += 1;
      } else {
        modifiedCount += 1;
      }
    }
  }

  return {
    gradleUserHome: resolvedGradleUserHome,
    addedCount,
    modifiedCount,
    deletedCount,
    warnings,
  };
}

function assertPortableDeltaPackage(
  artifactPackage: DownloadedDeltaArtifactPackage,
  expectedPartitionIds: readonly CachePartitionDefinition['id'][],
): void {
  if (artifactPackage.deltaManifest.gradleUserHome !== PORTABLE_GRADLE_USER_HOME) {
    throw new Error(
      `Downloaded delta artifact '${artifactPackage.artifact.name}' must use the portable Gradle user home sentinel.`,
    );
  }

  const actualPartitionIds = artifactPackage.deltaManifest.partitions.map(
    (partition) => partition.partitionId,
  );
  if (actualPartitionIds.length !== expectedPartitionIds.length) {
    throw new Error('Downloaded delta artifacts must share the same partition layout.');
  }

  actualPartitionIds.forEach((partitionId, index) => {
    if (partitionId !== expectedPartitionIds[index]) {
      throw new Error('Downloaded delta artifacts must share the same partition order.');
    }
  });
}

function collectPayloadPaths(
  artifactPackage: DownloadedDeltaArtifactPackage,
): ReadonlyMap<string, string> {
  return new Map(
    artifactPackage.metadata.payloadEntries.map((payloadEntry) => [
      payloadEntry.relativePath,
      resolvePathWithinRoot(
        artifactPackage.downloadDirectory,
        payloadEntry.payloadPath,
        `payload path for '${payloadEntry.relativePath}'`,
      ),
    ]),
  );
}

function areMergeCompatible(left: CacheDeltaEntry, right: CacheDeltaEntry): boolean {
  if (left.current && right.current) {
    return areSnapshotsEquivalent(left.current, right.current);
  }

  if (
    !left.current &&
    !right.current &&
    left.changeType === 'deleted' &&
    right.changeType === 'deleted'
  ) {
    return left.previous !== null && right.previous !== null
      ? areSnapshotsEquivalent(left.previous, right.previous)
      : false;
  }

  return false;
}

function areSnapshotsEquivalent(left: CacheFileSnapshot, right: CacheFileSnapshot): boolean {
  return (
    left.contentSha256 === right.contentSha256 &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs
  );
}

function compareEntriesByPath(left: CacheDeltaEntry, right: CacheDeltaEntry): number {
  return left.relativePath.localeCompare(right.relativePath);
}

async function writePayloadAtomically(
  payloadPath: string,
  gradleUserHome: string,
  targetPath: string,
  relativePath: string,
  expectedSnapshot: CacheFileSnapshot,
): Promise<void> {
  await ensureDirectoryPath(gradleUserHome, path.posix.dirname(relativePath));
  await assertReplaceableFile(targetPath, relativePath);
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.cache-gradle-delta.${randomUUID()}.tmp`,
  );

  try {
    await copyAndVerifyPayload(payloadPath, temporaryPath, relativePath, expectedSnapshot);
    await chmod(temporaryPath, expectedSnapshot.mode & 0o777);

    try {
      await rename(temporaryPath, targetPath);
    } catch (error) {
      if (!isReplaceTargetError(error)) {
        throw error;
      }

      await rm(targetPath, { force: true });
      await rename(temporaryPath, targetPath);
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function copyAndVerifyPayload(
  payloadPath: string,
  destinationPath: string,
  relativePath: string,
  expectedSnapshot: CacheFileSnapshot,
): Promise<void> {
  const beforeStat = await lstat(payloadPath);
  if (beforeStat.isSymbolicLink()) {
    throw new Error(`Delta payload '${relativePath}' must not be a symbolic link.`);
  }
  if (!beforeStat.isFile()) {
    throw new Error(`Delta payload '${relativePath}' must be a regular file.`);
  }

  const hash = createHash('sha256');
  let copiedBytes = 0;
  const input = createReadStream(payloadPath);
  input.on('data', (chunk: Buffer) => {
    copiedBytes += chunk.length;
    hash.update(chunk);
  });
  await pipeline(input, createWriteStream(destinationPath, { flags: 'wx' }));

  const afterStat = await lstat(payloadPath);
  if (afterStat.isSymbolicLink() || !afterStat.isFile()) {
    throw new Error(`Delta payload '${relativePath}' changed while it was being applied.`);
  }

  if (
    beforeStat.size !== afterStat.size ||
    beforeStat.mtimeMs !== afterStat.mtimeMs ||
    beforeStat.ctimeMs !== afterStat.ctimeMs
  ) {
    throw new Error(`Delta payload '${relativePath}' changed while it was being applied.`);
  }

  if (
    copiedBytes !== expectedSnapshot.size ||
    hash.digest('hex') !== expectedSnapshot.contentSha256
  ) {
    throw new Error(`Delta payload '${relativePath}' does not match the expected snapshot.`);
  }
}

async function restoreFileTimestamps(
  targetPath: string,
  relativePath: string,
  snapshot: CacheFileSnapshot,
  setTimes: NonNullable<DeltaApplyOptions['setTimes']>,
): Promise<string | null> {
  const atime = new Date(snapshot.atimeMs);
  const mtime = new Date(snapshot.mtimeMs);

  if (snapshot.atimeMs === snapshot.mtimeMs) {
    await setTimes(targetPath, atime, mtime);
    return null;
  }

  try {
    await setTimes(targetPath, atime, mtime);
    return null;
  } catch {
    await setTimes(targetPath, mtime, mtime);
    return `Could not fully restore access time for '${relativePath}'; preserved modification time only.`;
  }
}

async function deleteTargetPath(
  gradleUserHome: string,
  targetPath: string,
  relativePath: string,
): Promise<void> {
  await verifyDirectoryPath(gradleUserHome, path.posix.dirname(relativePath), false);
  const stats = await lstat(targetPath).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return null;
    }

    throw error;
  });

  if (!stats) {
    return;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Merged delta target '${relativePath}' must not be a symbolic link.`);
  }
  if (!stats.isFile()) {
    throw new Error(`Merged delta target '${relativePath}' must be a regular file.`);
  }

  await rm(targetPath);
}

async function assertReplaceableFile(targetPath: string, relativePath: string): Promise<void> {
  const stats = await lstat(targetPath).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return null;
    }

    throw error;
  });

  if (!stats) {
    return;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Merged delta target '${relativePath}' must not be a symbolic link.`);
  }
  if (!stats.isFile()) {
    throw new Error(`Merged delta target '${relativePath}' must be a regular file.`);
  }
}

async function ensureDirectoryPath(
  directoryPath: string,
  relativeDirectory: string,
): Promise<void> {
  await verifyDirectoryPath(directoryPath, relativeDirectory, true);
}

async function verifyDirectoryPath(
  directoryPath: string,
  relativeDirectory: string,
  createMissing: boolean,
): Promise<void> {
  const segments =
    relativeDirectory === '.' || relativeDirectory.length === 0 ? [] : relativeDirectory.split('/');
  let currentPath = path.resolve(directoryPath);

  const rootStats = await lstat(currentPath).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return null;
    }

    throw error;
  });
  if (!rootStats) {
    if (!createMissing) {
      return;
    }
    await mkdir(currentPath, { recursive: true });
  } else if (rootStats.isSymbolicLink()) {
    throw new Error(`Merged delta directory '${relativeDirectory}' contains a symbolic link.`);
  } else if (!rootStats.isDirectory()) {
    throw new Error(`Merged delta directory '${relativeDirectory}' contains a non-directory path.`);
  }

  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    const stats = await lstat(currentPath).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return null;
      }

      throw error;
    });

    if (!stats) {
      if (!createMissing) {
        return;
      }
      await mkdir(currentPath);
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Merged delta directory '${relativeDirectory}' contains a symbolic link.`);
    }
    if (!stats.isDirectory()) {
      throw new Error(
        `Merged delta directory '${relativeDirectory}' contains a non-directory path.`,
      );
    }
  }
}

function resolvePathWithinRoot(rootDirectory: string, relativePath: string, label: string): string {
  const normalizedRelativePath = validateNormalizedRelativePosixPath(
    relativePath,
    label,
    'the target directory',
  );
  const resolvedRoot = path.resolve(rootDirectory);
  const resolvedPath = path.resolve(resolvedRoot, normalizedRelativePath.split('/').join(path.sep));
  const rootWithSeparator = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${path.sep}`;

  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(rootWithSeparator)) {
    throw new Error(`${label} '${relativePath}' escapes the target directory.`);
  }

  return resolvedPath;
}

function isReplaceTargetError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES';
}

function isMissingPathError(error: unknown): boolean {
  return !!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

async function defaultSetTimes(filePath: string, atime: Date, mtime: Date): Promise<void> {
  await utimes(filePath, atime, mtime);
}
