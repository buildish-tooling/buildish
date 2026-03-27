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

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

import type { CiJobContext } from '../ci/types';
import type { ConfiguredCachePartitionInput, NormalizedActionConfig } from '../config/types';

export const DEFAULT_CACHE_KEY_TEMPLATE =
  '${cacheKeyPrefix}${schemaVersion}-${javaMajor}-${runnerOs}-${runnerArch}-${partitionFingerprint}-${refName}';
const CACHE_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/;
export const HARD_CACHE_EXCLUDE_GLOBS = [
  '**/configuration-cache/**',
  '**/*.lock',
  'caches/*/cc-keystore',
  'caches/journal-1/**',
] as const;

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
   * Must satisfy the cache key constraints enforced by `CACHE_KEY_PATTERN`: only `[A-Za-z0-9._:-]`
   * characters and a maximum length of 512 characters.
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
   * Stable digest of the resolved active cache partition layout.
   *
   * The fingerprint changes when the active partition order, includes, or excludes change and is
   * part of the base cache key so different cache layouts do not collide.
   */
  readonly partitionFingerprint: string;
  /**
   * Ordered logical cache partitions that make up the Gradle cache model.
   *
   * Contains the active built-in partitions plus any custom partitions after overrides and opt-outs
   * have been resolved.
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
   */
  readonly id: string;
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
   * The effective list always contains the non-overridable hard safety excludes plus any
   * partition-specific excludes from the built-in preset or user override.
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

interface BuiltInCachePartitionPreset {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly defaultEnabled: boolean;
  readonly relativeIncludeGlobs: readonly string[];
  readonly relativeExcludeGlobs: readonly string[];
}

/**
 * Built-in partition presets in their stable resolution order.
 *
 * This order is user-visible because active built-ins are emitted first, custom partitions are
 * appended afterwards, and the resulting ordered layout contributes to `partitionFingerprint`.
 */
const BUILT_IN_CACHE_PARTITION_PRESETS: readonly BuiltInCachePartitionPreset[] = [
  {
    id: 'modules',
    displayName: 'Dependency modules',
    description:
      'Downloaded dependency artifacts, plugin jars, and shared resource stores reused across builds.',
    defaultEnabled: true,
    relativeIncludeGlobs: [
      'caches/modules-*/files-*/**',
      'caches/jars-*/**',
      'caches/resources-*/**',
    ],
    relativeExcludeGlobs: ['caches/modules-*/metadata-*/**'],
  },
  {
    id: 'transforms-metadata',
    displayName: 'Transforms and metadata',
    description:
      'Artifact transforms and related metadata that can be fast but environment-sensitive to reuse.',
    defaultEnabled: false,
    relativeIncludeGlobs: ['caches/transforms-*/**'],
    relativeExcludeGlobs: [],
  },
  {
    id: 'kotlin-dsl',
    displayName: 'Kotlin DSL caches',
    description: 'Compiled Kotlin DSL scripts and generated Gradle API jars.',
    defaultEnabled: true,
    relativeIncludeGlobs: [
      'caches/*/kotlin-dsl/**',
      'caches/*/scripts/**',
      'caches/*/generated-gradle-jars/**',
    ],
    relativeExcludeGlobs: [],
  },
  {
    id: 'build-cache',
    displayName: 'Local build cache',
    description: 'Reusable local task output cache entries maintained by Gradle.',
    defaultEnabled: true,
    relativeIncludeGlobs: ['caches/build-cache-*/**'],
    relativeExcludeGlobs: [],
  },
  {
    id: 'wrapper-dists',
    displayName: 'Wrapper distributions',
    description:
      'Wrapper-downloaded Gradle distributions stored under the supported wrapper layout.',
    defaultEnabled: true,
    relativeIncludeGlobs: ['wrapper/dists/**'],
    relativeExcludeGlobs: [],
  },
];

const BUILT_IN_CACHE_PARTITION_IDS = new Set(
  BUILT_IN_CACHE_PARTITION_PRESETS.map((preset) => preset.id),
);

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
  const partitions = createCachePartitions(config.gradleUserHome, config.cachePartitions);
  const partitionFingerprint = createPartitionFingerprint(partitions);
  const cacheKey = renderCacheKey(config, ciContext, javaMajor, partitionFingerprint);

  return {
    cacheKey,
    javaMajor,
    runnerOs: ciContext.runnerOs,
    runnerArch: ciContext.runnerArch,
    safeRefName: ciContext.safeRefName,
    partitionFingerprint,
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
  partitionFingerprint: string,
): string {
  validateJavaMajor(javaMajor);
  const template = config.cacheKeyTemplate ?? DEFAULT_CACHE_KEY_TEMPLATE;
  const placeholderValues: Record<string, string> = {
    cacheKeyPrefix: config.cacheKeyPrefix,
    schemaVersion: String(config.cacheSchemaVersion),
    partitionFingerprint,
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
 *
 * Rules:
 * - built-ins are considered in stable preset order
 * - built-in overrides replace the preset include/exclude lists entirely
 * - built-ins with empty effective includes are disabled
 * - custom partitions are appended in declaration order and must keep at least one include glob
 */
export function createCachePartitions(
  gradleUserHome: string,
  configuredPartitions: readonly ConfiguredCachePartitionInput[] = [],
): readonly CachePartitionDefinition[] {
  const configuredById = new Map(
    configuredPartitions.map((partition) => [partition.id, partition]),
  );
  const builtIns = BUILT_IN_CACHE_PARTITION_PRESETS.flatMap((preset) => {
    const override = configuredById.get(preset.id);
    if (!override && !preset.defaultEnabled) {
      return [];
    }

    const includeGlobs = deduplicatePaths(override?.includes ?? preset.relativeIncludeGlobs);
    if (includeGlobs.length === 0) {
      return [];
    }

    return [
      createPartition(
        preset.id,
        preset.displayName,
        preset.description,
        gradleUserHome,
        includeGlobs,
        deduplicatePaths(override?.excludes ?? preset.relativeExcludeGlobs),
      ),
    ];
  });

  const customPartitions = configuredPartitions.flatMap((partition) => {
    if (BUILT_IN_CACHE_PARTITION_IDS.has(partition.id)) {
      return [];
    }
    if (partition.includes.length === 0) {
      throw new Error(
        `Custom cache partition '${partition.id}' must declare at least one include glob. Empty includes only disable built-in partitions.`,
      );
    }

    return [
      createPartition(
        partition.id,
        `Custom partition '${partition.id}'`,
        `User-defined Gradle cache partition '${partition.id}'.`,
        gradleUserHome,
        deduplicatePaths(partition.includes),
        deduplicatePaths(partition.excludes),
      ),
    ];
  });

  return [...builtIns, ...customPartitions];
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
      `No Java runtime is available for Apache Buildish Mammoth Cache for Gradle. Install Java 8 or newer and make it available via '${javaCommand}' before running this action.`,
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
  partitionRelativeExcludeGlobs: readonly string[],
): CachePartitionDefinition {
  const deduplicatedIncludeGlobs = deduplicatePaths(relativeIncludeGlobs);
  const relativeExcludeGlobs = deduplicatePaths([
    ...HARD_CACHE_EXCLUDE_GLOBS,
    ...partitionRelativeExcludeGlobs,
  ]);

  return {
    id,
    displayName,
    description,
    relativeIncludeGlobs: deduplicatedIncludeGlobs,
    relativeExcludeGlobs,
    absoluteIncludeGlobs: deduplicatedIncludeGlobs.map((glob) => path.join(gradleUserHome, glob)),
    absoluteExcludeGlobs: relativeExcludeGlobs.map((glob) => path.join(gradleUserHome, glob)),
  };
}

function createPartitionFingerprint(partitions: readonly CachePartitionDefinition[]): string {
  // Include the hard excludes and fully resolved ordered partition layout so cache keys diverge
  // whenever the managed cache surface changes.
  const serializedLayout = JSON.stringify({
    hardExcludes: HARD_CACHE_EXCLUDE_GLOBS,
    partitions: partitions.map((partition) => ({
      id: partition.id,
      includes: partition.relativeIncludeGlobs,
      excludes: partition.relativeExcludeGlobs,
    })),
  });

  return createHash('sha256').update(serializedLayout).digest('hex').slice(0, 16);
}

function deduplicatePaths(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function validateJavaMajor(javaMajor: number): void {
  if (!Number.isInteger(javaMajor) || javaMajor < 8) {
    throw new Error(`Unsupported Java major version '${javaMajor}'. Expected Java 8 or newer.`);
  }
}
