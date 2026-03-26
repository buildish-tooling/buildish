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

import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

import {
  captureCacheManifest,
  computeCacheDelta,
  serializeCacheDeltaManifest,
  serializeCacheManifest,
} from '../../src/cache/manifest';
import { createCachePartitions, type CacheModel } from '../../src/cache/model';

interface MemoryReading {
  readonly rss: number;
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly external: number;
}

interface Measurement<T> {
  readonly result: T;
  readonly durationMs: number;
  readonly before: MemoryReading;
  readonly after: MemoryReading;
  readonly peak: MemoryReading;
}

const DEFAULT_FILE_COUNTS = [10_000, 50_000, 100_000] as const;
const MEASUREMENT_POLL_INTERVAL_MS = 25;

await main();

async function main(): Promise<void> {
  const fileCounts = parseFileCounts(process.argv.slice(2));
  const heapLimit = getHeapStatistics().heap_size_limit;

  console.log(`Node ${process.version}`);
  console.log(`Heap size limit: ${formatBytes(heapLimit)}`);
  console.log('Benchmark counts:', fileCounts.join(', '));

  for (const fileCount of fileCounts) {
    await runScenario(fileCount);
  }
}

async function runScenario(fileCount: number): Promise<void> {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), 'buildish-mammoth-cache-gradle-manifest-bench-'),
  );
  const gradleUserHome = path.join(tempRoot, '.gradle');
  const cacheModel = createBenchmarkCacheModel(gradleUserHome);
  const modifyCount = Math.max(1, Math.floor(fileCount * 0.01));
  const deleteCount = Math.max(1, Math.floor(fileCount * 0.005));
  const addCount = deleteCount;

  try {
    await mkdir(gradleUserHome, { recursive: true });
    const generatedBytes = await generateSyntheticCacheTree(gradleUserHome, fileCount, 0);
    const previousCapture = await measureAsync(() => captureCacheManifest(cacheModel));

    await mutateSyntheticCacheTree(gradleUserHome, fileCount, modifyCount, deleteCount, addCount);

    const currentCapture = await measureAsync(() => captureCacheManifest(cacheModel));
    const deltaComputation = measureSync(() =>
      computeCacheDelta(previousCapture.result, currentCapture.result),
    );
    const manifestSerialization = measureSync(() => serializeCacheManifest(currentCapture.result));
    const deltaSerialization = measureSync(() =>
      serializeCacheDeltaManifest(deltaComputation.result),
    );

    const deltaEntryCount = deltaComputation.result.partitions.reduce(
      (sum, partition) => sum + partition.entries.length,
      0,
    );

    console.log(`\nScenario: ${fileCount.toLocaleString()} files`);
    console.log(`Synthetic bytes written: ${formatBytes(generatedBytes)}`);
    console.log(
      `Mutations: modified=${modifyCount.toLocaleString()}, deleted=${deleteCount.toLocaleString()}, added=${addCount.toLocaleString()}`,
    );
    printMeasurement('capture(previous)', previousCapture);
    printMeasurement('capture(current)', currentCapture);
    printMeasurement('delta(compute)', deltaComputation);
    printMeasurement('serialize(manifest)', manifestSerialization);
    printMeasurement('serialize(delta)', deltaSerialization);
    console.log(
      `Manifest entries: ${currentCapture.result.partitions.reduce((sum, p) => sum + p.entries.length, 0).toLocaleString()}`,
    );
    console.log(`Delta entries: ${deltaEntryCount.toLocaleString()}`);
    console.log(
      `Serialized manifest size: ${formatBytes(Buffer.byteLength(manifestSerialization.result))}`,
    );
    console.log(
      `Serialized delta size: ${formatBytes(Buffer.byteLength(deltaSerialization.result))}`,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function generateSyntheticCacheTree(
  gradleUserHome: string,
  fileCount: number,
  generationOffset: number,
): Promise<number> {
  let writtenBytes = 0;

  for (let index = 0; index < fileCount; index += 1) {
    const relativePath = relativePathForFileIndex(index + generationOffset);
    const content = syntheticFileContent(index + generationOffset, 'base');
    writtenBytes += Buffer.byteLength(content);
    await writeSyntheticFile(gradleUserHome, relativePath, content);
  }

  return writtenBytes;
}

async function mutateSyntheticCacheTree(
  gradleUserHome: string,
  fileCount: number,
  modifyCount: number,
  deleteCount: number,
  addCount: number,
): Promise<void> {
  for (let index = 0; index < modifyCount; index += 1) {
    await writeSyntheticFile(
      gradleUserHome,
      relativePathForFileIndex(index),
      syntheticFileContent(index, 'modified'),
    );
  }

  for (let index = modifyCount; index < modifyCount + deleteCount; index += 1) {
    await unlink(path.join(gradleUserHome, relativePathForFileIndex(index)));
  }

  for (let index = 0; index < addCount; index += 1) {
    const newFileIndex = fileCount + index;
    await writeSyntheticFile(
      gradleUserHome,
      relativePathForFileIndex(newFileIndex),
      syntheticFileContent(newFileIndex, 'added'),
    );
  }
}

function relativePathForFileIndex(index: number): string {
  const bucket = Math.floor(index / 100);
  const shard = index % 100;
  switch (index % 10) {
    case 0:
    case 1:
    case 2:
    case 3:
      return `caches/modules-2/files-2.1/group-${bucket}/artifact-${shard}/artifact-${index}.jar`;
    case 4:
    case 5:
      return `caches/${8 + (index % 3)}.${index % 7}/fileHashes/group-${bucket}/hash-${index}.bin`;
    case 6:
    case 7:
      return `caches/${8 + (index % 2)}.${index % 5}/scripts/group-${bucket}/script-${index}.bin`;
    case 8:
      return `caches/build-cache-1/group-${bucket}/entry-${index}.bin`;
    default:
      return `wrapper/dists/gradle-${8 + (index % 2)}.${index % 11}/group-${bucket}/gradle-${index}.zip`;
  }
}

function syntheticFileContent(index: number, phase: 'base' | 'modified' | 'added'): string {
  return `${phase}|${index}|${'x'.repeat(48)}\n`;
}

async function writeSyntheticFile(
  gradleUserHome: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const absolutePath = path.join(gradleUserHome, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
}

function createBenchmarkCacheModel(gradleUserHome: string): CacheModel {
  const partitions = createCachePartitions(gradleUserHome);
  return {
    cacheKey: 'benchmark-cache-key',
    javaMajor: 21,
    runnerOs: 'linux',
    runnerArch: 'x64',
    safeRefName: 'benchmark',
    partitionFingerprint: 'benchmark-partitions',
    partitions,
    includePaths: partitions.flatMap((partition) => partition.absoluteIncludeGlobs),
    excludePaths: [...new Set(partitions.flatMap((partition) => partition.absoluteExcludeGlobs))],
  };
}

async function measureAsync<T>(operation: () => Promise<T>): Promise<Measurement<T>> {
  runGc();
  const before = readMemory();
  let peak = before;
  const sampler = setInterval(() => {
    peak = maxMemoryReading(peak, readMemory());
  }, MEASUREMENT_POLL_INTERVAL_MS);
  const start = performance.now();

  try {
    const result = await operation();
    const durationMs = performance.now() - start;
    const after = readMemory();
    peak = maxMemoryReading(peak, after);
    return { result, durationMs, before, after, peak };
  } finally {
    clearInterval(sampler);
  }
}

function measureSync<T>(operation: () => T): Measurement<T> {
  runGc();
  const before = readMemory();
  const start = performance.now();
  const result = operation();
  const durationMs = performance.now() - start;
  const after = readMemory();
  return { result, durationMs, before, after, peak: maxMemoryReading(before, after) };
}

function readMemory(): MemoryReading {
  const { rss, heapUsed, heapTotal, external } = process.memoryUsage();
  return { rss, heapUsed, heapTotal, external };
}

function maxMemoryReading(left: MemoryReading, right: MemoryReading): MemoryReading {
  return {
    rss: Math.max(left.rss, right.rss),
    heapUsed: Math.max(left.heapUsed, right.heapUsed),
    heapTotal: Math.max(left.heapTotal, right.heapTotal),
    external: Math.max(left.external, right.external),
  };
}

function printMeasurement<T>(label: string, measurement: Measurement<T>): void {
  console.log(
    `${label}: ${measurement.durationMs.toFixed(1)} ms | heap ${formatBytes(measurement.before.heapUsed)} -> ${formatBytes(measurement.after.heapUsed)} (peak ${formatBytes(measurement.peak.heapUsed)}) | rss ${formatBytes(measurement.before.rss)} -> ${formatBytes(measurement.after.rss)} (peak ${formatBytes(measurement.peak.rss)})`,
  );
}

function parseFileCounts(arguments_: readonly string[]): readonly number[] {
  if (arguments_.length === 0) {
    return DEFAULT_FILE_COUNTS;
  }

  return arguments_.map((value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid file-count argument '${value}'. Expected a positive integer.`);
    }

    return parsed;
  });
}

function runGc(): void {
  global.gc?.();
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = value;
  let unitIndex = -1;
  do {
    scaled /= 1024;
    unitIndex += 1;
  } while (scaled >= 1024 && unitIndex < units.length - 1);

  return `${scaled.toFixed(1)} ${units[unitIndex]}`;
}
