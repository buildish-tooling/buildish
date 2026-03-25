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

export const JOB_MODES = ['standalone', 'distributed-worker', 'distributed-aggregator'] as const;
export type JobMode = (typeof JOB_MODES)[number];

export const WRAPPER_SELECTION_MODES = ['default', 'all', 'explicit'] as const;
export type WrapperSelectionMode = (typeof WRAPPER_SELECTION_MODES)[number];

export const CACHE_KEY_TEMPLATE_PLACEHOLDERS = [
  'cacheKeyPrefix',
  'schemaVersion',
  'javaMajor',
  'runnerOs',
  'runnerArch',
  'refName',
] as const;

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
