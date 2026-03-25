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

export type BootstrapPhase = 'main' | 'post';

export interface BootstrapStatus {
  readonly phase: BootstrapPhase;
  readonly message: string;
  readonly config: NormalizedActionConfig;
  readonly ciContext: CiJobContext;
}

export interface BootstrapDependencies extends GitHubPlatformOptions {
  readonly inputProvider?: InputProvider;
}

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
  const status = createBootstrapStatus(phase, config, platform.context);

  await platform.publishSummary(createBootstrapSummaryLines(status));

  return status;
}

export function createBootstrapStatus(
  phase: BootstrapPhase,
  config: NormalizedActionConfig,
  ciContext: CiJobContext,
): BootstrapStatus {
  return {
    phase,
    config,
    ciContext,
    message: `Prepared ${phase} phase for ${ciContext.eventName} on ${ciContext.safeRefName} in ${config.jobMode} mode.`,
  };
}

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
  ];
}
