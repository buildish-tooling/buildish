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

import { spawn } from 'node:child_process';
import path from 'node:path';

import type { CiJobContext } from '../ci/types';
import type { NormalizedActionConfig } from '../config/types';

const DEFAULT_CACHE_KEY_TEMPLATE =
  '${cacheKeyPrefix}${schemaVersion}-${javaMajor}-${runnerOs}-${runnerArch}-${refName}';
const CACHE_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/;

/**
 * Fully derived cache identity and partition metadata for a single job execution.
 *
 * This object is the handoff point between bootstrap-time environment discovery and later
 * cache restore/save or delta-manifest logic.
 */
export interface CacheModel {
  readonly cacheKey: string;
  readonly javaMajor: number;
  readonly runnerOs: string;
  readonly runnerArch: string;
  readonly safeRefName: string;
  readonly partitions: readonly CachePartitionDefinition[];
  readonly includePaths: readonly string[];
  readonly excludePaths: readonly string[];
}

/**
 * Describes one logical slice of Gradle user home content that should participate in cache
 * restore/save and later delta computation.
 *
 * Relative globs are stable identifiers for manifests and tests, while absolute globs are ready
 * to pass to filesystem or cache APIs for the current `gradleUserHome`.
 */
export interface CachePartitionDefinition {
  readonly id: 'modules' | 'transforms-metadata' | 'kotlin-dsl' | 'build-cache' | 'wrapper-dists';
  readonly displayName: string;
  readonly description: string;
  readonly relativeIncludeGlobs: readonly string[];
  readonly relativeExcludeGlobs: readonly string[];
  readonly absoluteIncludeGlobs: readonly string[];
  readonly absoluteExcludeGlobs: readonly string[];
}

/**
 * Optional injection points for cache-model creation.
 *
 * Tests can replace command execution to avoid spawning `java`, and callers may supply a custom
 * environment when detection must not read from `process.env`.
 */
export interface CacheModelOptions {
  readonly captureCommandOutput?: CommandOutputCapture;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Minimal abstraction for commands whose combined stdout/stderr should be captured as text.
 *
 * The cache model currently uses this for Java version detection, but keeping it typed makes the
 * bootstrap path deterministic in tests and avoids coupling callers to `child_process` directly.
 */
export type CommandOutputCapture = (
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
) => Promise<string>;

/**
 * Derives the cache key coordinates and partition definitions for the current job.
 */
export async function createCacheModel(
  config: NormalizedActionConfig,
  ciContext: CiJobContext,
  options: CacheModelOptions = {},
): Promise<CacheModel> {
  const javaMajor = await detectJavaMajor(
    options.captureCommandOutput ?? captureCombinedOutput,
    options.env,
  );
  const cacheKey = renderCacheKey(config, ciContext, javaMajor);
  const partitions = createCachePartitions(config.gradleUserHome);

  return {
    cacheKey,
    javaMajor,
    runnerOs: ciContext.runnerOs,
    runnerArch: ciContext.runnerArch,
    safeRefName: ciContext.safeRefName,
    partitions,
    includePaths: partitions.flatMap((partition) => partition.absoluteIncludeGlobs),
    excludePaths: deduplicatePaths(
      partitions.flatMap((partition) => partition.absoluteExcludeGlobs),
    ),
  };
}

/**
 * Renders the effective cache key from either the restricted user template or the default.
 */
export function renderCacheKey(
  config: NormalizedActionConfig,
  ciContext: CiJobContext,
  javaMajor: number,
): string {
  validateJavaMajor(javaMajor);
  const template = config.cacheKeyTemplate ?? DEFAULT_CACHE_KEY_TEMPLATE;
  const placeholderValues: Record<string, string> = {
    cacheKeyPrefix: config.cacheKeyPrefix,
    schemaVersion: String(config.cacheSchemaVersion),
    javaMajor: String(javaMajor),
    runnerOs: ciContext.runnerOs,
    runnerArch: ciContext.runnerArch,
    refName: ciContext.safeRefName,
  };
  const cacheKey = template.replaceAll(/\$\{([A-Za-z0-9]+)}/g, (match, placeholderName: string) => {
    return placeholderValues[placeholderName] ?? match;
  });

  if (!CACHE_KEY_PATTERN.test(cacheKey)) {
    throw new Error(
      'Resolved cache key contains unsupported characters or exceeds the 512 character limit.',
    );
  }

  return cacheKey;
}

/**
 * Parses `java -version` output into a supported Java major version.
 */
export function parseJavaMajor(versionOutput: string): number {
  const match = /version "((?:1\.)?[0-9]+)(?:[._][^"]*)?"/u.exec(versionOutput);

  if (!match) {
    throw new Error(`Unable to determine Java version from output:\n${versionOutput}`);
  }

  const versionToken = match[1];
  const javaMajor = versionToken.startsWith('1.')
    ? Number.parseInt(versionToken.slice(2), 10)
    : Number.parseInt(versionToken, 10);

  validateJavaMajor(javaMajor);
  return javaMajor;
}

/**
 * Computes the Gradle user home partitions used by cache restore/save and delta tracking.
 */
export function createCachePartitions(gradleUserHome: string): readonly CachePartitionDefinition[] {
  return [
    createPartition(
      'modules',
      'Dependency modules',
      'Downloaded dependency metadata and artifact stores shared across builds.',
      gradleUserHome,
      ['caches/modules-2/**', 'caches/jars-*/**'],
    ),
    createPartition(
      'transforms-metadata',
      'Transforms and metadata',
      'Artifact transforms plus supporting metadata reused between builds.',
      gradleUserHome,
      ['caches/transforms-*/**', 'caches/*/fileHashes/**', 'caches/*/md-rule/**'],
    ),
    createPartition(
      'kotlin-dsl',
      'Kotlin DSL caches',
      'Compiled Kotlin DSL scripts and generated Gradle API jars.',
      gradleUserHome,
      ['caches/*/kotlin-dsl/**', 'caches/*/scripts/**', 'caches/*/generated-gradle-jars/**'],
    ),
    createPartition(
      'build-cache',
      'Local build cache',
      'Reusable local task output cache entries maintained by Gradle.',
      gradleUserHome,
      ['caches/build-cache-*/**'],
    ),
    createPartition(
      'wrapper-dists',
      'Wrapper distributions',
      'Wrapper-downloaded Gradle distributions stored under the supported wrapper layout.',
      gradleUserHome,
      ['wrapper/dists/**'],
    ),
  ];
}

async function detectJavaMajor(
  captureCommandOutput: CommandOutputCapture,
  env: NodeJS.ProcessEnv | undefined,
): Promise<number> {
  const javaVersionOutput = await captureCommandOutput(
    env?.JAVA_BIN?.trim() || 'java',
    ['-version'],
    env,
  );
  return parseJavaMajor(javaVersionOutput);
}

async function captureCombinedOutput(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env });
    let output = '';

    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', (error) => {
      reject(new Error(`Unable to execute '${command} ${args.join(' ')}': ${error.message}`));
    });
    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`'${command} ${args.join(' ')}' terminated by signal ${signal}.`));
        return;
      }

      if (code !== 0) {
        reject(
          new Error(`'${command} ${args.join(' ')}' failed with exit code ${code}.\n${output}`),
        );
        return;
      }

      resolve(output);
    });
  });
}

function createPartition(
  id: CachePartitionDefinition['id'],
  displayName: string,
  description: string,
  gradleUserHome: string,
  relativeIncludeGlobs: readonly string[],
): CachePartitionDefinition {
  const relativeExcludeGlobs = ['**/configuration-cache/**', '**/*.lock'];

  return {
    id,
    displayName,
    description,
    relativeIncludeGlobs,
    relativeExcludeGlobs,
    absoluteIncludeGlobs: relativeIncludeGlobs.map((glob) => path.join(gradleUserHome, glob)),
    absoluteExcludeGlobs: relativeExcludeGlobs.map((glob) => path.join(gradleUserHome, glob)),
  };
}

function deduplicatePaths(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function validateJavaMajor(javaMajor: number): void {
  if (!Number.isInteger(javaMajor) || javaMajor < 8) {
    throw new Error(`Unsupported Java major version '${javaMajor}'. Expected Java 8 or newer.`);
  }
}
