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

export const DEFAULT_CACHE_KEY_TEMPLATE =
  '${cacheKeyPrefix}${schemaVersion}-${javaMajor}-${runnerOs}-${runnerArch}-${refName}';
const CACHE_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/;

/**
 * Fully derived cache identity and partition metadata for a single job execution.
 *
 * This object is the handoff point between bootstrap-time environment discovery and later
 * cache restore/save or delta-manifest logic.
 */
export interface CacheModel {
  /**
   * Fully resolved primary cache key for this job.
   *
   * Must satisfy the GitHub cache key constraints enforced by `CACHE_KEY_PATTERN`: only
   * `[A-Za-z0-9._:-]` characters and a maximum length of 512 characters.
   */
  readonly cacheKey: string;
  /**
   * Detected Java major version from `java -version`.
   *
   * Must be an integer >= 8; versions below 8 are rejected during model creation.
   */
  readonly javaMajor: number;
  /**
   * Normalized runner operating system, lower-cased by the CI adapter.
   *
   * Typical values include `linux`, `windows`, and `macos`.
   */
  readonly runnerOs: string;
  /**
   * Normalized runner architecture, lower-cased by the CI adapter.
   *
   * Typical values include `x64`, `arm64`, and `x86`.
   */
  readonly runnerArch: string;
  /**
   * Ref name sanitized for safe cache-key usage.
   *
   * This is derived by the CI adapter and excludes path separators or other cache-unsafe
   * characters.
   */
  readonly safeRefName: string;
  /**
   * Ordered logical cache partitions that make up the Gradle cache model.
   *
   * Currently contains five partitions from `createCachePartitions()`.
   */
  readonly partitions: readonly CachePartitionDefinition[];
  /**
   * Absolute include globs aggregated from all partitions.
   *
   * These are passed to cache and filesystem operations in listed order.
   */
  readonly includePaths: readonly string[];
  /**
   * Absolute exclude globs aggregated and de-duplicated from all partitions.
   *
   * Always includes the shared exclusions for configuration-cache content and `*.lock` files.
   */
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
  /**
   * Stable machine-readable partition identifier.
   *
   * Valid values are `modules`, `transforms-metadata`, `kotlin-dsl`, `build-cache`, and
   * `wrapper-dists`.
   */
  readonly id: 'modules' | 'transforms-metadata' | 'kotlin-dsl' | 'build-cache' | 'wrapper-dists';
  /** Short human-readable partition label for logs and summaries. */
  readonly displayName: string;
  /** Longer human-readable explanation of what the partition stores. */
  readonly description: string;
  /**
   * Partition include globs relative to `gradleUserHome`.
   *
   * These remain stable across machines and are preferred for manifests and tests.
   */
  readonly relativeIncludeGlobs: readonly string[];
  /**
   * Partition exclude globs relative to `gradleUserHome`.
   *
   * Every partition currently excludes configuration-cache content and `*.lock` files.
   */
  readonly relativeExcludeGlobs: readonly string[];
  /**
   * Absolute include globs rooted under the effective `gradleUserHome`.
   *
   * These are the concrete paths used by cache restore/save operations for the current runner.
   */
  readonly absoluteIncludeGlobs: readonly string[];
  /**
   * Absolute exclude globs rooted under the effective `gradleUserHome`.
   *
   * These mirror `relativeExcludeGlobs` after joining against `gradleUserHome`.
   */
  readonly absoluteExcludeGlobs: readonly string[];
}

/**
 * Optional injection points for cache-model creation.
 *
 * Tests can replace command execution to avoid spawning `java`, and callers may supply a custom
 * environment when detection must not read from `process.env`.
 */
export interface CacheModelOptions {
  /**
   * Optional command runner override used for Java detection.
   *
   * Defaults to the internal child-process implementation when omitted.
   */
  readonly captureCommandOutput?: CommandOutputCapture;
  /**
   * Optional environment override used during Java detection.
   *
   * Defaults to `process.env` when omitted.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Minimal abstraction for commands whose combined stdout/stderr should be captured as text.
 *
 * The cache model currently uses this for Java version detection, but keeping it typed makes the
 * bootstrap path deterministic in tests and avoids coupling callers to `child_process` directly.
 *
 * @param command Executable name or absolute path. Defaults to `java` in the built-in caller.
 * @param args Command arguments, typically `['-version']` for Java detection.
 * @param env Optional environment to run with; if omitted, the current process environment is used.
 * @returns Combined stdout/stderr text from the completed command.
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
  const javaCommand = env?.JAVA_BIN?.trim() || 'java';
  let javaVersionOutput: string;

  try {
    javaVersionOutput = await captureCommandOutput(javaCommand, ['-version'], env);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    if (!/ENOENT|not found/iu.test(message)) {
      throw new Error(`Failed to detect the Java runtime using '${javaCommand} -version'.`, {
        cause: error,
      });
    }

    throw new Error(
      `No Java runtime is available for cache-gradle. Install Java 8 or newer and make it available via '${javaCommand}' before running this action.`,
      { cause: error },
    );
  }

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
