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

import * as core from '@actions/core';

import { createGitHubPlatform, type GitHubPlatformOptions } from './ci/github';
import {
  armBaseCachePostAction,
  isBaseCachePostActionArmed,
  restoreBaseCache,
  saveBaseCache,
  type BaseCacheApi,
  type BaseCacheOperationResult,
} from './cache/service';
import type { CiJobContext } from './ci/types';
import { createCacheModel, type CacheModel, type CommandOutputCapture } from './cache/model';
import {
  normalizeActionConfig,
  readActionInputs,
  type InputProvider,
} from './config/action-config';
import type { NormalizedActionConfig } from './config/types';
import { provisionWrapperJars } from './wrapper/download';
import { validateTargetWrapperProperties } from './wrapper/static-validation';
import type { ProvisionedWrapperJar, ValidatedWrapperPropertiesFile } from './wrapper/types';

export type BootstrapPhase = 'main' | 'post';

/**
 * Bootstrap output shared by the action entrypoints and tests.
 */
export interface BootstrapStatus {
  readonly phase: BootstrapPhase;
  readonly message: string;
  readonly config: NormalizedActionConfig;
  readonly ciContext: CiJobContext;
  readonly cacheModel: CacheModel | null;
  readonly baseCacheResult: BaseCacheOperationResult | null;
  readonly validatedWrappers: readonly ValidatedWrapperPropertiesFile[];
  readonly provisionedWrappers: readonly ProvisionedWrapperJar[];
}

/**
 * Injectable dependencies for bootstrap-time environment/input discovery.
 */
export interface BootstrapDependencies extends GitHubPlatformOptions {
  readonly inputProvider?: InputProvider;
  readonly fetchImpl?: typeof fetch;
  readonly captureCommandOutput?: CommandOutputCapture;
  readonly cacheApi?: BaseCacheApi;
  readonly saveState?: (name: string, value: string) => void;
  readonly getState?: (name: string) => string;
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
  const cacheModel = config.cacheEnabled
    ? await createCacheModel(config, platform.context, {
        captureCommandOutput: dependencies.captureCommandOutput,
        env: dependencies.env,
      })
    : null;
  const validatedWrappers =
    phase === 'main'
      ? await validateTargetWrapperProperties(config, platform.context.workspace)
      : [];
  const provisionedWrappers =
    phase === 'main'
      ? await provisionWrapperJars(validatedWrappers, { fetchImpl: dependencies.fetchImpl })
      : [];
  const baseCacheResult = await runBaseCachePhase(phase, config, cacheModel, dependencies);
  const status = createBootstrapStatus(
    phase,
    config,
    platform.context,
    cacheModel,
    baseCacheResult,
    validatedWrappers,
    provisionedWrappers,
  );

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
  cacheModel: CacheModel | null = null,
  baseCacheResult: BaseCacheOperationResult | null = null,
  validatedWrappers: readonly ValidatedWrapperPropertiesFile[] = [],
  provisionedWrappers: readonly ProvisionedWrapperJar[] = [],
): BootstrapStatus {
  return {
    phase,
    config,
    ciContext,
    cacheModel,
    baseCacheResult,
    validatedWrappers,
    provisionedWrappers,
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
    `- Runner: ${status.ciContext.runnerOs}/${status.ciContext.runnerArch}`,
    `- Job mode: ${status.config.jobMode}`,
    `- Read only: ${status.config.readOnly}`,
    `- Cache enabled: ${status.config.cacheEnabled}`,
    `- Cache key: ${status.cacheModel?.cacheKey ?? 'disabled'}`,
    `- Java major: ${status.cacheModel?.javaMajor ?? 'n/a'}`,
    `- Cache partitions: ${status.cacheModel?.partitions.length ?? 0}`,
    ...(status.baseCacheResult
      ? [
          `- Base cache ${status.baseCacheResult.operation}: ${status.baseCacheResult.status}`,
          `- Base cache detail: ${status.baseCacheResult.message}`,
        ]
      : []),
    `- Wrapper selection: ${status.config.wrapperSelectionMode}`,
    `- Wrapper files: ${status.validatedWrappers.length}`,
    `- Wrapper JARs ready: ${status.provisionedWrappers.length}`,
  ];
}

async function runBaseCachePhase(
  phase: BootstrapPhase,
  config: NormalizedActionConfig,
  cacheModel: CacheModel | null,
  dependencies: BootstrapDependencies,
): Promise<BaseCacheOperationResult | null> {
  if (!cacheModel) {
    return null;
  }

  if (phase === 'main') {
    const restoreResult = await restoreBaseCache(config, cacheModel, {
      cacheApi: dependencies.cacheApi,
    });

    armBaseCachePostAction(dependencies.saveState ?? core.saveState);
    return restoreResult;
  }

  return await saveBaseCache(
    config,
    cacheModel,
    isBaseCachePostActionArmed(dependencies.getState ?? core.getState),
    {
      cacheApi: dependencies.cacheApi,
    },
  );
}
