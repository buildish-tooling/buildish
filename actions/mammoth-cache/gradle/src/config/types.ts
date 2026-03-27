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

import type { CoreExecutionPhase } from '../core/lifecycle';

/**
 * Supported execution personalities for the action.
 *
 * These values intentionally mirror the flat string inputs exposed from the current
 * GitHub action descriptor so parsing can stay simple and explicit.
 */
export const JOB_MODES = ['standalone', 'distributed-worker', 'distributed-aggregator'] as const;
/**
 * Normalized job-mode value.
 *
 * Valid values are:
 * - `standalone`: single-job execution
 * - `distributed-worker`: worker job that contributes build outputs but does not save shared cache
 * - `distributed-aggregator`: coordinating job that can aggregate results from dependent jobs
 */
export type JobMode = (typeof JOB_MODES)[number];

/**
 * How wrapper property files should be selected after input normalization.
 */
export const WRAPPER_SELECTION_MODES = ['default', 'all', 'explicit'] as const;
/**
 * Normalized wrapper-discovery strategy.
 *
 * Valid values are:
 * - `default`: only the default wrapper properties path is targeted
 * - `all`: all matching wrapper properties files under the configured glob are targeted
 * - `explicit`: only explicitly listed wrapper properties files are targeted
 */
export type WrapperSelectionMode = (typeof WRAPPER_SELECTION_MODES)[number];

/**
 * Supported restore-time cleanup policies.
 *
 * - `none`: never delete managed cache content during restore
 * - `prune-managed`: on a cache hit, delete the currently active managed files and then restore the
 *   matched base cache again so the managed partition space reflects only the restored cache content
 */
export const RESTORE_CLEANUP_MODES = ['none', 'prune-managed'] as const;
export type RestoreCleanupMode = (typeof RESTORE_CLEANUP_MODES)[number];

/**
 * Normalized user-supplied cache partition override or custom partition definition.
 *
 * Partition IDs that match a built-in partition override that built-in's include/exclude lists.
 * New IDs create custom partitions appended after the built-ins in declaration order.
 */
export interface ConfiguredCachePartitionInput {
  /** Stable machine-readable partition identifier. */
  readonly id: string;
  /** Gradle-user-home-relative include globs for this partition. */
  readonly includes: readonly string[];
  /** Gradle-user-home-relative exclude globs for this partition. */
  readonly excludes: readonly string[];
}

/**
 * Restricted placeholder names accepted by the cache key template input.
 *
 * Keeping this list centralized makes it harder to accidentally widen the user-facing
 * templating surface without updating validation and tests together.
 */
export const CACHE_KEY_TEMPLATE_PLACEHOLDERS = [
  'cacheKeyPrefix',
  'schemaVersion',
  'partitionFingerprint',
  'javaMajor',
  'runnerOs',
  'runnerArch',
  'refName',
] as const;

/**
 * Raw string inputs read directly from the GitHub Actions input API.
 *
 * This shape intentionally preserves the stringly-typed external contract before the
 * normalization layer applies defaults, validation, and derived values.
 */
export interface RawActionInputs {
  /** Raw optional workspace-relative config file path. Empty string means no file-backed config. */
  readonly configFile: string;
  /** Raw `base-directory` input. Empty string means the repository root and later defaults to `.`. */
  readonly baseDirectory: string;
  /** Raw `cache-enabled` input. Empty string later defaults to `'true'`. */
  readonly cacheEnabled: string;
  /**
   * Raw `read-only` input.
   *
   * Empty string means “use the event-based default” during normalization.
   */
  readonly readOnly: string;
  /** Raw `job-mode` input. Empty string later defaults to `'standalone'`. */
  readonly jobMode: string;
  /** Raw comma/newline-separated `dependent-jobs` input. Empty string later defaults to none. */
  readonly dependentJobs: string;
  /** Raw `allow-duplicate-dependent-delta-paths` input. Empty string later defaults to `'false'`. */
  readonly allowDuplicateDependentDeltaPaths: string;
  /** Raw `cache-key-prefix` input. Empty string later defaults to `'buildish-mammoth-gradle-cache-'`. */
  readonly cacheKeyPrefix: string;
  /** Raw `cache-key-template` input. Empty string later means “use the built-in template”. */
  readonly cacheKeyTemplate: string;
  /** Raw JSON array of built-in partition overrides and custom partition definitions. */
  readonly cachePartitions: string;
  /** Raw `process-all-wrapper-files` input. Empty string later defaults to `'false'`. */
  readonly processAllWrapperFiles: string;
  /**
   * Raw `wrapper-properties-glob` input.
   *
   * Empty string later defaults to the standard recursive Gradle wrapper properties glob.
   */
  readonly wrapperPropertiesGlob: string;
  /** Raw comma/newline-separated explicit wrapper properties paths. Empty string later defaults to none. */
  readonly wrapperPropertiesFiles: string;
  /** Raw `cleanup-enabled` input. Empty string later defaults to `'true'`. */
  readonly cleanupEnabled: string;
  /** Raw restore cleanup mode. Empty string later defaults to `'none'`. */
  readonly restoreCleanupMode: string;
  /** Raw `gradle-user-home` input. Empty string later defaults to the supported runner default. */
  readonly gradleUserHome: string;
  /** Raw `setup-java` input. Empty string later defaults to `'false'`; `true` is currently rejected. */
  readonly setupJava: string;
  /** Raw `github-token` input used only for authenticated GitHub-host fetches. */
  readonly githubToken: string;
}

/**
 * Validated action configuration used by the rest of the implementation.
 *
 * By the time a value reaches this structure, it should already be safe to consume by
 * later modules without repeating GitHub input parsing logic.
 */
export interface NormalizedActionConfig {
  /**
   * Current action phase.
   *
   * Valid values are `prepare` and `finalize`; provided by bootstrap rather than user input.
   */
  readonly phase: CoreExecutionPhase;
  /**
   * Normalized repository-relative base directory.
   *
   * Defaults to `.` and must not escape the workspace.
   */
  readonly baseDirectory: string;
  /** Whether cache restore/save logic is enabled. Defaults to `true`. */
  readonly cacheEnabled: boolean;
  /**
   * Whether writes such as cache save are forbidden.
   *
   * Defaults to `true` for pull-request events and `false` otherwise unless explicitly provided.
   */
  readonly readOnly: boolean;
  /** Normalized job mode. Defaults to `standalone`. */
  readonly jobMode: JobMode;
  /**
   * Validated dependent job names.
   *
   * Defaults to an empty list and may only be non-empty for distributed job modes.
   */
  readonly dependentJobs: readonly string[];
  /**
   * Whether aggregators may resolve non-identical overlapping dependent delta paths by choosing the
   * newest-mtime entry instead of failing.
   *
   * Defaults to `false`. Exact same-content/same-mode overlaps still merge timestamp metadata even
   * when this flag is disabled.
   */
  readonly allowDuplicateDependentDeltaPaths: boolean;
  /**
   * Stable cache-key prefix.
   *
   * Defaults to `buildish-mammoth-gradle-cache-` and must match the repository's prefix validation rules.
   */
  readonly cacheKeyPrefix: string;
  /**
   * Optional custom cache-key template.
   *
   * Defaults to `null`, which means the built-in default template is used. Custom templates must
   * include `${partitionFingerprint}` so cache keys do not collide across different cache layouts.
   */
  readonly cacheKeyTemplate: string | null;

  /**
   * Normalized built-in partition overrides and custom partition definitions.
   *
   * Defaults to an empty list, which means only the built-in partition defaults are used.
   */
  readonly cachePartitions: readonly ConfiguredCachePartitionInput[];
  /**
   * Internal cache schema version.
   *
   * Currently fixed by the implementation, not by user input.
   */
  readonly cacheSchemaVersion: number;
  /** Wrapper discovery strategy derived from the wrapper-related inputs. */
  readonly wrapperSelectionMode: WrapperSelectionMode;
  /**
   * Repository-relative glob used when wrapper discovery mode needs pattern matching.
   *
   * Defaults to the standard recursive Gradle wrapper properties glob, resolved underneath
   * `baseDirectory`.
   */
  readonly wrapperPropertiesGlob: string;
  /**
   * Repository-relative default wrapper properties file.
   *
   * Defaults to `gradle/wrapper/gradle-wrapper.properties`, resolved underneath `baseDirectory`.
   */
  readonly defaultWrapperPropertiesFile: string;
  /**
   * Explicit repository-relative wrapper properties files.
   *
   * Defaults to an empty list and is populated only when wrapper selection mode is `explicit`.
   */
  readonly wrapperPropertiesFiles: readonly string[];
  /** Whether post-build cleanup behavior is enabled. Defaults to `true`. */
  readonly cleanupEnabled: boolean;
  /** Restore-time cleanup mode applied before the build starts. Defaults to `none`. */
  readonly restoreCleanupMode: RestoreCleanupMode;
  /**
   * Absolute supported Gradle user home.
   *
   * Defaults to `$GRADLE_USER_HOME` when set, otherwise `${home}/.gradle`; v1 rejects arbitrary
   * custom locations outside that supported default.
   */
  readonly gradleUserHome: string;
}
