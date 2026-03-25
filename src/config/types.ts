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

/**
 * Supported execution personalities for the action.
 *
 * These values intentionally mirror the flat string inputs exposed from `action.yml`
 * so parsing can stay simple and explicit.
 */
export const JOB_MODES = ['standalone', 'distributed-worker', 'distributed-aggregator'] as const;
export type JobMode = (typeof JOB_MODES)[number];

/**
 * How wrapper property files should be selected after input normalization.
 */
export const WRAPPER_SELECTION_MODES = ['default', 'all', 'explicit'] as const;
export type WrapperSelectionMode = (typeof WRAPPER_SELECTION_MODES)[number];

/**
 * Restricted placeholder names accepted by the cache key template input.
 *
 * Keeping this list centralized makes it harder to accidentally widen the user-facing
 * templating surface without updating validation and tests together.
 */
export const CACHE_KEY_TEMPLATE_PLACEHOLDERS = [
  'cacheKeyPrefix',
  'schemaVersion',
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
  readonly baseDirectory: string;
  readonly cacheEnabled: string;
  readonly readOnly: string;
  readonly jobMode: string;
  readonly dependentJobs: string;
  readonly cacheKeyPrefix: string;
  readonly cacheKeyTemplate: string;
  readonly processAllWrapperFiles: string;
  readonly wrapperPropertiesGlob: string;
  readonly wrapperPropertiesFiles: string;
  readonly cleanupEnabled: string;
  readonly gradleUserHome: string;
  readonly setupJava: string;
}

/**
 * Validated action configuration used by the rest of the implementation.
 *
 * By the time a value reaches this structure, it should already be safe to consume by
 * later modules without repeating GitHub input parsing logic.
 */
export interface NormalizedActionConfig {
  readonly phase: 'main' | 'post';
  readonly baseDirectory: string;
  readonly cacheEnabled: boolean;
  readonly readOnly: boolean;
  readonly jobMode: JobMode;
  readonly dependentJobs: readonly string[];
  readonly cacheKeyPrefix: string;
  readonly cacheKeyTemplate: string | null;
  readonly cacheSchemaVersion: number;
  readonly wrapperSelectionMode: WrapperSelectionMode;
  readonly wrapperPropertiesGlob: string;
  readonly defaultWrapperPropertiesFile: string;
  readonly wrapperPropertiesFiles: readonly string[];
  readonly cleanupEnabled: boolean;
  readonly gradleUserHome: string;
}
