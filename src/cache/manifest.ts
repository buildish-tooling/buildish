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
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { CacheModel, CachePartitionDefinition } from './model';

export const CACHE_MANIFEST_SCHEMA_VERSION = 1;
const STABLE_ENTRY_CAPTURE_ATTEMPTS = 3;

interface CompiledGlobPattern {
  readonly source: string;
  readonly segments: readonly CompiledGlobSegment[];
}

type CompiledGlobSegment =
  | { readonly kind: 'globstar' }
  | {
      readonly kind: 'segment';
      readonly raw: string;
      readonly hasWildcard: boolean;
      readonly regex: RegExp;
    };

/**
 * Stable file metadata captured for one cache file at one point in time.
 */
export interface CacheFileSnapshot {
  /** SHA-256 digest of the file contents in lowercase hexadecimal form. */
  readonly contentSha256: string;
  /** File size in bytes. */
  readonly size: number;
  /** POSIX mode bits reported by the filesystem stat result. */
  readonly mode: number;
  /** Best-effort file access time in milliseconds since the Unix epoch. */
  readonly atimeMs: number;
  /** File modification time in milliseconds since the Unix epoch. */
  readonly mtimeMs: number;
}

/**
 * Captured manifest entry for one regular file rooted under the supported Gradle user home.
 */
export interface CacheFileManifestEntry extends CacheFileSnapshot {
  /** POSIX-style path relative to `gradleUserHome`. */
  readonly relativePath: string;
}

/**
 * Captured manifest entries for one logical cache partition.
 */
export interface CachePartitionManifest {
  /** Stable partition identifier from the cache model. */
  readonly partitionId: CachePartitionDefinition['id'];
  /** Sorted manifest entries for this partition. */
  readonly entries: readonly CacheFileManifestEntry[];
}

/**
 * Full pre- or post-build cache manifest for all configured Gradle cache partitions.
 */
export interface CacheManifest {
  /** Schema version for on-disk manifest serialization. Currently always `1`. */
  readonly schemaVersion: typeof CACHE_MANIFEST_SCHEMA_VERSION;
  /** Absolute Gradle user home path the manifest was captured from. */
  readonly gradleUserHome: string;
  /** Ordered partition manifests following the cache model partition order. */
  readonly partitions: readonly CachePartitionManifest[];
}

/**
 * Captured change for a single path between two manifests.
 */
export interface CacheDeltaEntry {
  /** POSIX-style path relative to `gradleUserHome`. */
  readonly relativePath: string;
  /**
   * Change classification.
   *
   * Valid values are `added`, `modified`, and `deleted`.
   */
  readonly changeType: 'added' | 'modified' | 'deleted';
  /** Snapshot from the earlier manifest, or `null` for newly added files. */
  readonly previous: CacheFileSnapshot | null;
  /** Snapshot from the later manifest, or `null` for deleted files. */
  readonly current: CacheFileSnapshot | null;
}

/**
 * Partition-local delta entries.
 */
export interface CachePartitionDelta {
  /** Stable partition identifier from the cache model. */
  readonly partitionId: CachePartitionDefinition['id'];
  /** Sorted delta entries for this partition. */
  readonly entries: readonly CacheDeltaEntry[];
}

/**
 * Full delta manifest between two cache manifests.
 */
export interface CacheDeltaManifest {
  /** Schema version for on-disk delta serialization. Currently always `1`. */
  readonly schemaVersion: typeof CACHE_MANIFEST_SCHEMA_VERSION;
  /** Absolute Gradle user home path shared by the compared manifests. */
  readonly gradleUserHome: string;
  /** Ordered partition deltas following the cache model partition order. */
  readonly partitions: readonly CachePartitionDelta[];
}

/**
 * Scans all configured cache partitions and captures a deterministic manifest of regular files.
 *
 * The scanner retries a small number of times when a file changes while being hashed so later delta
 * computation does not observe inconsistent size/hash metadata for the same path.
 */
export async function captureCacheManifest(cacheModel: CacheModel): Promise<CacheManifest> {
  const gradleUserHome = deriveGradleUserHome(cacheModel);
  const compiledPartitions = cacheModel.partitions.map((partition) => ({
    partition,
    includePatterns: partition.relativeIncludeGlobs.map(compileGlobPattern),
    excludePatterns: partition.relativeExcludeGlobs.map(compileGlobPattern),
    entries: [] as CacheFileManifestEntry[],
    seenRelativePaths: new Set<string>(),
  }));
  const claimedPaths = new Map<string, CachePartitionDefinition['id']>();

  for (const compiledPartition of compiledPartitions) {
    for (const includePattern of compiledPartition.includePatterns) {
      const includeRoots = await expandIncludePatternRoots(gradleUserHome, includePattern);

      for (const includeRoot of includeRoots) {
        await walkIncludedTree(includeRoot, async (absolutePath) => {
          const relativePath = toPosixRelativePath(gradleUserHome, absolutePath);
          if (
            compiledPartition.seenRelativePaths.has(relativePath) ||
            matchesAnyCompiledGlob(relativePath, compiledPartition.excludePatterns)
          ) {
            return;
          }

          const existingPartitionId = claimedPaths.get(relativePath);
          if (existingPartitionId && existingPartitionId !== compiledPartition.partition.id) {
            throw new Error(
              `Cache manifest path '${relativePath}' matches multiple cache partitions: ${existingPartitionId}, ${compiledPartition.partition.id}.`,
            );
          }

          const entry = await captureStableFileEntry(gradleUserHome, absolutePath, relativePath);
          if (!entry) {
            return;
          }

          compiledPartition.seenRelativePaths.add(relativePath);
          claimedPaths.set(relativePath, compiledPartition.partition.id);
          compiledPartition.entries.push(entry);
        });
      }
    }
  }

  return {
    schemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
    gradleUserHome,
    partitions: cacheModel.partitions.map((partition) => ({
      partitionId: partition.id,
      entries: [
        ...(compiledPartitions.find((candidate) => candidate.partition.id === partition.id)
          ?.entries ?? []),
      ].sort(compareManifestEntries),
    })),
  };
}

/**
 * Computes the partitioned file delta between two manifests captured from the same Gradle user home.
 */
export function computeCacheDelta(
  previousManifest: CacheManifest,
  currentManifest: CacheManifest,
): CacheDeltaManifest {
  validateComparableManifests(previousManifest, currentManifest);

  return {
    schemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
    gradleUserHome: previousManifest.gradleUserHome,
    partitions: previousManifest.partitions.map((previousPartition, index) => {
      const currentPartition = currentManifest.partitions[index];
      const entries: CacheDeltaEntry[] = [];
      let previousIndex = 0;
      let currentIndex = 0;

      while (
        previousIndex < previousPartition.entries.length ||
        currentIndex < currentPartition.entries.length
      ) {
        const previousEntry = previousPartition.entries[previousIndex] ?? null;
        const currentEntry = currentPartition.entries[currentIndex] ?? null;

        if (!previousEntry && currentEntry) {
          entries.push(createDeltaEntry(currentEntry.relativePath, 'added', null, currentEntry));
          currentIndex += 1;
          continue;
        }

        if (previousEntry && !currentEntry) {
          entries.push(
            createDeltaEntry(previousEntry.relativePath, 'deleted', previousEntry, null),
          );
          previousIndex += 1;
          continue;
        }

        if (!previousEntry || !currentEntry) {
          continue;
        }

        const pathComparison = previousEntry.relativePath.localeCompare(currentEntry.relativePath);
        if (pathComparison < 0) {
          entries.push(
            createDeltaEntry(previousEntry.relativePath, 'deleted', previousEntry, null),
          );
          previousIndex += 1;
          continue;
        }

        if (pathComparison > 0) {
          entries.push(createDeltaEntry(currentEntry.relativePath, 'added', null, currentEntry));
          currentIndex += 1;
          continue;
        }

        if (!areManifestEntriesEquivalent(previousEntry, currentEntry)) {
          entries.push(
            createDeltaEntry(previousEntry.relativePath, 'modified', previousEntry, currentEntry),
          );
        }

        previousIndex += 1;
        currentIndex += 1;
      }

      return {
        partitionId: previousPartition.partitionId,
        entries,
      };
    }),
  };
}

/**
 * Serializes a captured manifest into deterministic compact JSON with a trailing newline for file storage.
 */
export function serializeCacheManifest(manifest: CacheManifest): string {
  return `${JSON.stringify(manifest)}\n`;
}

/**
 * Serializes a computed delta manifest into deterministic compact JSON with a trailing newline for file storage.
 */
export function serializeCacheDeltaManifest(deltaManifest: CacheDeltaManifest): string {
  return `${JSON.stringify(deltaManifest)}\n`;
}

async function captureStableFileEntry(
  gradleUserHome: string,
  absolutePath: string,
  relativePath: string,
): Promise<CacheFileManifestEntry | null> {
  for (let attempt = 0; attempt < STABLE_ENTRY_CAPTURE_ATTEMPTS; attempt += 1) {
    const beforeStat = await lstat(absolutePath).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return null;
      }

      throw error;
    });

    if (!beforeStat) {
      return null;
    }

    if (beforeStat.isSymbolicLink()) {
      throw new Error(`Cache manifest does not support symbolic links: '${relativePath}'.`);
    }

    if (!beforeStat.isFile()) {
      throw new Error(`Cache manifest only supports regular files, but found '${relativePath}'.`);
    }

    const contentSha256 = await hashFileSha256(absolutePath).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return null;
      }

      throw error;
    });

    if (!contentSha256) {
      return null;
    }

    const afterStat = await lstat(absolutePath).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return null;
      }

      throw error;
    });

    if (!afterStat) {
      return null;
    }

    if (isStableDuringCapture(beforeStat, afterStat)) {
      return {
        relativePath: toPosixRelativePath(gradleUserHome, absolutePath),
        contentSha256,
        size: afterStat.size,
        mode: afterStat.mode,
        atimeMs: afterStat.atimeMs,
        mtimeMs: afterStat.mtimeMs,
      };
    }
  }

  throw new Error(`Cache manifest could not capture a stable snapshot for '${relativePath}'.`);
}

async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);

  return await new Promise<string>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('close', () => resolve(hash.digest('hex')));
  });
}

async function walkIncludedTree(
  pathToScan: string,
  onFile: (absolutePath: string) => Promise<void>,
): Promise<void> {
  const entryStat = await lstat(pathToScan).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return null;
    }

    throw error;
  });

  if (!entryStat) {
    return;
  }

  if (entryStat.isSymbolicLink() || entryStat.isFile()) {
    await onFile(pathToScan);
    return;
  }

  if (!entryStat.isDirectory()) {
    return;
  }

  const entries = await readSortedDirectoryEntries(pathToScan);

  if (!entries) {
    return;
  }

  for (const entry of entries) {
    const absolutePath = path.join(pathToScan, entry.name);

    if (entry.isSymbolicLink()) {
      await onFile(absolutePath);
      continue;
    }

    if (entry.isDirectory()) {
      if (entry.name === 'configuration-cache') {
        continue;
      }

      await walkIncludedTree(absolutePath, onFile);
      continue;
    }

    if (entry.isFile()) {
      await onFile(absolutePath);
    }
  }
}

function deriveGradleUserHome(cacheModel: CacheModel): string {
  const firstPartition = cacheModel.partitions[0];
  const firstRelativeGlob = firstPartition?.relativeIncludeGlobs[0];
  const firstAbsoluteGlob = firstPartition?.absoluteIncludeGlobs[0];

  if (!firstRelativeGlob || !firstAbsoluteGlob) {
    throw new Error('Cache manifest capture requires at least one include path.');
  }

  const relativeGlobPath = firstRelativeGlob.split('/').join(path.sep);
  if (!firstAbsoluteGlob.endsWith(relativeGlobPath)) {
    throw new Error(
      `Unable to derive Gradle user home from include path '${firstAbsoluteGlob}' and relative glob '${firstRelativeGlob}'.`,
    );
  }

  return firstAbsoluteGlob.slice(0, firstAbsoluteGlob.length - relativeGlobPath.length - 1);
}

async function expandIncludePatternRoots(
  baseDirectory: string,
  pattern: CompiledGlobPattern,
): Promise<readonly string[]> {
  const terminalSegment = pattern.segments.at(-1);
  if (!terminalSegment || terminalSegment.kind !== 'globstar') {
    throw new Error(`Unsupported cache include glob '${pattern.source}': expected trailing '**'.`);
  }

  return await expandPatternPrefix(baseDirectory, pattern.segments.slice(0, -1), 0);
}

async function expandPatternPrefix(
  currentPath: string,
  segments: readonly CompiledGlobSegment[],
  segmentIndex: number,
): Promise<readonly string[]> {
  if (segmentIndex >= segments.length) {
    return [currentPath];
  }

  const segment = segments[segmentIndex];
  if (segment.kind === 'globstar') {
    throw new Error('Unsupported cache include glob: non-terminal ** segment.');
  }

  if (!segment.hasWildcard) {
    const nextPath = path.join(currentPath, segment.raw);
    const nextStat = await lstat(nextPath).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return null;
      }

      throw error;
    });

    if (!nextStat || (segmentIndex < segments.length - 1 && !nextStat.isDirectory())) {
      return [];
    }

    return await expandPatternPrefix(nextPath, segments, segmentIndex + 1);
  }

  const entries = await readSortedDirectoryEntries(currentPath);
  if (!entries) {
    return [];
  }

  const expandedRoots: string[] = [];
  for (const entry of entries) {
    if (!segment.regex.test(entry.name)) {
      continue;
    }

    if (segmentIndex < segments.length - 1 && !entry.isDirectory()) {
      continue;
    }

    expandedRoots.push(
      ...(await expandPatternPrefix(
        path.join(currentPath, entry.name),
        segments,
        segmentIndex + 1,
      )),
    );
  }

  return expandedRoots;
}

function compileGlobPattern(pattern: string): CompiledGlobPattern {
  return {
    source: pattern,
    segments: pattern.split('/').map((segment) => {
      if (segment === '**') {
        return { kind: 'globstar' };
      }

      return {
        kind: 'segment',
        raw: segment,
        hasWildcard: segment.includes('*'),
        regex: compileSegmentRegex(segment),
      };
    }),
  };
}

function matchesAnyCompiledGlob(
  relativePath: string,
  compiledPatterns: readonly CompiledGlobPattern[],
): boolean {
  const pathSegments = relativePath.split('/');
  return compiledPatterns.some((pattern) => matchesGlobSegments(pathSegments, pattern.segments));
}

function matchesGlobSegments(
  pathSegments: readonly string[],
  patternSegments: readonly CompiledGlobSegment[],
  pathIndex = 0,
  patternIndex = 0,
): boolean {
  if (patternIndex === patternSegments.length) {
    return pathIndex === pathSegments.length;
  }

  const patternSegment = patternSegments[patternIndex];
  if (patternSegment.kind === 'globstar') {
    for (let nextPathIndex = pathIndex; nextPathIndex <= pathSegments.length; nextPathIndex += 1) {
      if (matchesGlobSegments(pathSegments, patternSegments, nextPathIndex, patternIndex + 1)) {
        return true;
      }
    }

    return false;
  }

  if (pathIndex === pathSegments.length) {
    return false;
  }

  return (
    patternSegment.regex.test(pathSegments[pathIndex]) &&
    matchesGlobSegments(pathSegments, patternSegments, pathIndex + 1, patternIndex + 1)
  );
}

function compileSegmentRegex(patternSegment: string): RegExp {
  return new RegExp(
    `^${patternSegment.replaceAll(/([.+^${}()|[\]\\])/g, '\\$1').replaceAll('*', '[^/]*')}$`,
    'u',
  );
}

function createDeltaEntry(
  relativePath: string,
  changeType: CacheDeltaEntry['changeType'],
  previousEntry: CacheFileManifestEntry | null,
  currentEntry: CacheFileManifestEntry | null,
): CacheDeltaEntry {
  return {
    relativePath,
    changeType,
    previous: previousEntry ? toSnapshot(previousEntry) : null,
    current: currentEntry ? toSnapshot(currentEntry) : null,
  };
}

function toSnapshot(entry: CacheFileManifestEntry): CacheFileSnapshot {
  return {
    contentSha256: entry.contentSha256,
    size: entry.size,
    mode: entry.mode,
    atimeMs: entry.atimeMs,
    mtimeMs: entry.mtimeMs,
  };
}

function validateComparableManifests(
  previousManifest: CacheManifest,
  currentManifest: CacheManifest,
): void {
  if (
    previousManifest.schemaVersion !== CACHE_MANIFEST_SCHEMA_VERSION ||
    currentManifest.schemaVersion !== CACHE_MANIFEST_SCHEMA_VERSION
  ) {
    throw new Error('Cache delta computation only supports the current manifest schema version.');
  }

  if (previousManifest.gradleUserHome !== currentManifest.gradleUserHome) {
    throw new Error('Cache delta computation requires manifests from the same Gradle user home.');
  }

  if (previousManifest.partitions.length !== currentManifest.partitions.length) {
    throw new Error('Cache delta computation requires matching partition layouts.');
  }

  previousManifest.partitions.forEach((partition, index) => {
    if (partition.partitionId !== currentManifest.partitions[index]?.partitionId) {
      throw new Error(
        'Cache delta computation requires matching partition identifiers in the same order.',
      );
    }
  });
}

function areManifestEntriesEquivalent(
  previousEntry: CacheFileManifestEntry,
  currentEntry: CacheFileManifestEntry,
): boolean {
  return (
    previousEntry.contentSha256 === currentEntry.contentSha256 &&
    previousEntry.size === currentEntry.size &&
    previousEntry.mode === currentEntry.mode &&
    previousEntry.mtimeMs === currentEntry.mtimeMs
  );
}

async function readSortedDirectoryEntries(directoryPath: string) {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return null;
    }

    throw error;
  });

  if (!entries) {
    return null;
  }

  return [...entries].sort((left, right) => left.name.localeCompare(right.name));
}

function compareManifestEntries(
  left: CacheFileManifestEntry,
  right: CacheFileManifestEntry,
): number {
  return left.relativePath.localeCompare(right.relativePath);
}

function isStableDuringCapture(
  beforeStat: Awaited<ReturnType<typeof lstat>>,
  afterStat: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    beforeStat.size === afterStat.size &&
    beforeStat.mode === afterStat.mode &&
    beforeStat.mtimeMs === afterStat.mtimeMs &&
    beforeStat.ctimeMs === afterStat.ctimeMs
  );
}

function toPosixRelativePath(baseDirectory: string, absolutePath: string): string {
  return path.relative(baseDirectory, absolutePath).split(path.sep).join(path.posix.sep);
}

function isMissingPathError(error: unknown): boolean {
  return !!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
