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

import { createGitHubPlatform, type GitHubPlatformOptions } from './ci/github';
import type { CiJobContext } from './ci/types';
import {
  normalizeActionConfig,
  readActionInputs,
  type InputProvider,
} from './config/action-config';
import type { NormalizedActionConfig } from './config/types';
import { validateTargetWrapperProperties } from './wrapper/static-validation';
import type { ValidatedWrapperPropertiesFile } from './wrapper/types';

export type BootstrapPhase = 'main' | 'post';

/**
 * Bootstrap output shared by the action entrypoints and tests.
 */
export interface BootstrapStatus {
  readonly phase: BootstrapPhase;
  readonly message: string;
  readonly config: NormalizedActionConfig;
  readonly ciContext: CiJobContext;
  readonly validatedWrappers: readonly ValidatedWrapperPropertiesFile[];
}

/**
 * Injectable dependencies for bootstrap-time environment/input discovery.
 */
export interface BootstrapDependencies extends GitHubPlatformOptions {
  readonly inputProvider?: InputProvider;
}

/**
 * Shared startup path for both the main and post-action entrypoints.
 *
 * This is the only place that currently knows how to read GitHub metadata, read action
 * inputs, normalize runtime config, and publish a small job summary.
 */
export async function bootstrapPhase(
  phase: BootstrapPhase,
  dependencies: BootstrapDependencies = {},
): Promise<BootstrapStatus> {
  const platform = createGitHubPlatform(dependencies);
  const rawInputs = readActionInputs(dependencies.inputProvider);
  const config = normalizeActionConfig(rawInputs, {
    phase,
    ciContext: platform.context,
    env: dependencies.env,
  });
  const validatedWrappers =
    phase === 'main'
      ? await validateTargetWrapperProperties(config, platform.context.workspace)
      : [];
  const status = createBootstrapStatus(phase, config, platform.context, validatedWrappers);

  await platform.publishSummary(createBootstrapSummaryLines(status));

  return status;
}

/**
 * Creates a compact bootstrap status object suitable for logging and testing.
 */
export function createBootstrapStatus(
  phase: BootstrapPhase,
  config: NormalizedActionConfig,
  ciContext: CiJobContext,
  validatedWrappers: readonly ValidatedWrapperPropertiesFile[] = [],
): BootstrapStatus {
  return {
    phase,
    config,
    ciContext,
    validatedWrappers,
    message: `Prepared ${phase} phase for ${ciContext.eventName} on ${ciContext.safeRefName} in ${config.jobMode} mode.`,
  };
}

/**
 * Builds the initial job summary section emitted during bootstrap.
 */
export function createBootstrapSummaryLines(status: BootstrapStatus): readonly string[] {
  return [
    '## Cache Gradle bootstrap',
    `- Phase: ${status.phase}`,
    `- Event: ${status.ciContext.eventName}`,
    `- Ref: ${status.ciContext.resolvedRefName}`,
    `- Safe ref: ${status.ciContext.safeRefName}`,
    `- Job mode: ${status.config.jobMode}`,
    `- Read only: ${status.config.readOnly}`,
    `- Cache enabled: ${status.config.cacheEnabled}`,
    `- Wrapper selection: ${status.config.wrapperSelectionMode}`,
    `- Wrapper files: ${status.validatedWrappers.length}`,
  ];
}
