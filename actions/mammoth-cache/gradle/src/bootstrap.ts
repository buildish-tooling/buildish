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

import {
  armBaseCachePostAction,
  isBaseCachePostActionArmed,
  restoreBaseCache,
  saveBaseCache,
  type BaseCacheApi,
  type BaseCacheOperationResult,
} from './cache/service';
import type { CiExecutionUrls, CiJobContext, CiPlatformAdapter } from './ci/types';
import { createCacheModel, type CacheModel, type CommandOutputCapture } from './cache/model';
import {
  normalizeActionConfig,
  readActionInputs,
  resolveActionInputsFromConfigFile,
} from './config/action-config';
import type { NormalizedActionConfig } from './config/types';
import {
  createDetailsSection,
  createHtmlTable,
  escapeHtml,
  escapeSummaryText,
} from './logging/summary';
import type { RuntimeInputSource, RuntimeReporter, RuntimeStateStore } from './runtime-host/types';
import { provisionWrapperJars, type WrapperProvisionOptions } from './wrapper/download';
import { validateTargetWrapperProperties } from './wrapper/static-validation';
import type { ProvisionedWrapperJar, ValidatedWrapperPropertiesFile } from './wrapper/types';

/**
 * Action execution phase.
 *
 * Valid values are `main` for the primary action entrypoint and `post` for the post-action
 * cleanup/save entrypoint.
 */
export type BootstrapPhase = 'main' | 'post';

/**
 * Bootstrap output shared by the action entrypoints and tests.
 */
export interface BootstrapStatus {
  /** Phase currently being prepared. Valid values are `main` and `post`. */
  readonly phase: BootstrapPhase;
  /** Human-readable one-line status summary generated from the normalized context and config. */
  readonly message: string;
  /** Fully normalized action configuration used by later modules. */
  readonly config: NormalizedActionConfig;
  /** Provider-neutral CI metadata for the current job execution. */
  readonly ciContext: CiJobContext;
  /**
   * Fully derived cache model, or `null` when `config.cacheEnabled` is `false`.
   *
   * Defaults to `null` in `createBootstrapStatus()`.
   */
  readonly cacheModel: CacheModel | null;
  /**
   * Base cache restore/save outcome for the current phase, or `null` when caching is disabled.
   *
   * Defaults to `null` in `createBootstrapStatus()`.
   */
  readonly baseCacheResult: BaseCacheOperationResult | null;
  /**
   * Wrapper properties files validated during bootstrap.
   *
   * Defaults to an empty array and is empty in the `post` phase.
   */
  readonly validatedWrappers: readonly ValidatedWrapperPropertiesFile[];
  /**
   * Wrapper JAR provisioning results for validated wrappers.
   *
   * Defaults to an empty array and is empty in the `post` phase.
   */
  readonly provisionedWrappers: readonly ProvisionedWrapperJar[];
  /** Provider-specific bootstrap diagnostics rendered by the active CI adapter. */
  readonly ciDiagnosticsLines: readonly string[];
  /** Provider-specific execution URLs for the current job/run when available. */
  readonly ciExecutionUrls: CiExecutionUrls;
}

export interface BootstrapExecution extends BootstrapStatus {
  readonly ciProvider: CiPlatformAdapter;
}

export type BootstrapRuntimeHost = RuntimeInputSource & RuntimeStateStore & RuntimeReporter;

/**
 * Injectable dependencies for bootstrap-time environment/input discovery.
 */
export interface BootstrapDependencies {
  /** Optional environment map used by config resolution and persistence helpers. */
  readonly env?: NodeJS.ProcessEnv;
  /** Runtime host implementation used for input discovery, non-fatal reporting, and state. */
  readonly runtimeHost: BootstrapRuntimeHost;
  /** Provider adapter for the active CI environment. */
  readonly ciProvider: CiPlatformAdapter;
  /**
   * Optional `fetch` override used by wrapper download tests.
   *
   * Defaults to the runtime global `fetch` when omitted.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Optional command-capture override for Java version detection.
   *
   * Defaults to the internal child-process implementation when omitted.
   */
  readonly captureCommandOutput?: CommandOutputCapture;
  /** Cache-service implementation for the active CI provider. */
  readonly cacheApi: BaseCacheApi;
  /**
   * Optional detached-signature verifier override used by focused wrapper tests.
   *
   * Defaults to the pinned Gradle signing-key verifier when omitted.
   */
  readonly verifyWrapperSignature?: WrapperProvisionOptions['verifyWrapperSignature'];
}

/**
 * Shared startup path for both the main and post-action entrypoints.
 *
 * This is the only place that currently wires the active CI adapter, reads action inputs, and
 * normalizes runtime config.
 */
export async function bootstrapPhase(
  phase: BootstrapPhase,
  dependencies: BootstrapDependencies,
): Promise<BootstrapExecution> {
  const runtimeEnv = dependencies.env ?? process.env;
  const directInputs = readActionInputs(dependencies.runtimeHost);
  const ciProvider = dependencies.ciProvider;
  const rawInputs = await resolveActionInputsFromConfigFile(directInputs, {
    workspace: ciProvider.context.workspace,
  });
  const config = normalizeActionConfig(rawInputs, {
    phase,
    ciContext: ciProvider.context,
    env: runtimeEnv,
  });
  const cacheModel = config.cacheEnabled
    ? await createCacheModel(config, ciProvider.context, {
        captureCommandOutput: dependencies.captureCommandOutput,
        env: runtimeEnv,
      })
    : null;
  const validatedWrappers =
    phase === 'main'
      ? await validateTargetWrapperProperties(config, ciProvider.context.workspace)
      : [];
  const provisionedWrappers =
    phase === 'main'
      ? await provisionWrapperJars(validatedWrappers, {
          fetchImpl: dependencies.fetchImpl,
          httpHeadersByHost: ciProvider.httpHeadersByHost,
          logRetry: dependencies.runtimeHost.info,
          verifyWrapperSignature: dependencies.verifyWrapperSignature,
        })
      : [];
  const baseCacheResult = await runBaseCachePhase(phase, config, cacheModel, dependencies);
  const status = createBootstrapStatus(
    phase,
    config,
    ciProvider.context,
    cacheModel,
    baseCacheResult,
    validatedWrappers,
    provisionedWrappers,
    ciProvider.createBootstrapDiagnosticsLines(phase),
    ciProvider.executionUrls,
  );

  return {
    ...status,
    ciProvider,
  };
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
  ciDiagnosticsLines: readonly string[] = [],
  ciExecutionUrls: CiExecutionUrls = { jobUrl: null, workflowRunUrl: null },
): BootstrapStatus {
  return {
    phase,
    config,
    ciContext,
    cacheModel,
    baseCacheResult,
    validatedWrappers,
    provisionedWrappers,
    ciDiagnosticsLines,
    ciExecutionUrls,
    message: `Prepared ${phase} phase for ${ciContext.eventName} on ${ciContext.safeRefName} in ${config.jobMode} mode.`,
  };
}

/**
 * Builds the initial job summary section emitted during bootstrap.
 */
export function createBootstrapSummaryLines(status: BootstrapStatus): readonly string[] {
  const downloadedWrapperCount = status.provisionedWrappers.filter(
    (wrapper) => wrapper.wasDownloaded,
  ).length;
  const reusedWrapperCount = status.provisionedWrappers.length - downloadedWrapperCount;

  return [
    '## Apache Buildish bootstrap',
    `- Base cache ${status.baseCacheResult?.operation ?? 'state'}: ${status.baseCacheResult?.status ?? (status.cacheModel ? 'not-run' : 'disabled')}`,
    `- Wrapper provisioning: ${status.provisionedWrappers.length} ready (${downloadedWrapperCount} downloaded, ${reusedWrapperCount} reused)`,
    ...createDetailsSection('Execution context', [
      `- Phase: ${escapeSummaryText(status.phase)}`,
      `- Workflow: ${escapeSummaryText(status.ciContext.workflowName)}`,
      `- Job: ${escapeSummaryText(status.ciContext.jobName)}`,
      `- Event: ${escapeSummaryText(status.ciContext.eventName)}`,
      `- Ref: ${escapeSummaryText(status.ciContext.resolvedRefName)}`,
      `- Safe ref: ${escapeSummaryText(status.ciContext.safeRefName)}`,
      `- Runner: ${escapeSummaryText(`${status.ciContext.runnerOs}/${status.ciContext.runnerArch}`)}`,
      `- Job mode: ${escapeSummaryText(status.config.jobMode)}`,
      `- Read only: ${status.config.readOnly ? 'yes' : 'no'}`,
      `- Cache enabled: ${status.config.cacheEnabled ? 'yes' : 'no'}`,
      `- Cache key: ${escapeSummaryText(status.cacheModel?.cacheKey ?? 'disabled')}`,
      `- Java major: ${escapeSummaryText(String(status.cacheModel?.javaMajor ?? 'n/a'))}`,
      `- Cache partitions: ${status.cacheModel?.partitions.length ?? 0}`,
      `- Wrapper selection: ${escapeSummaryText(status.config.wrapperSelectionMode)}`,
      `- Wrapper files: ${status.validatedWrappers.length}`,
      ...(status.baseCacheResult
        ? [`- Base cache detail: ${escapeSummaryText(status.baseCacheResult.message)}`]
        : []),
    ]),
    ...createDetailsSection('Wrapper provisioning', createWrapperProvisioningSummaryLines(status)),
  ];
}

export function createBootstrapLogLines(status: BootstrapStatus): readonly string[] {
  const downloadedWrapperCount = status.provisionedWrappers.filter(
    (wrapper) => wrapper.wasDownloaded,
  ).length;
  const reusedWrapperCount = status.provisionedWrappers.length - downloadedWrapperCount;
  const lines = [
    `Bootstrap: ${status.message}`,
    `Base cache ${status.baseCacheResult?.operation ?? 'state'}: ${status.baseCacheResult?.status ?? (status.cacheModel ? 'not-run' : 'disabled')}.`,
    `Wrapper provisioning: ${status.provisionedWrappers.length} ready (${downloadedWrapperCount} downloaded, ${reusedWrapperCount} reused).`,
    `Execution context: workflow '${status.ciContext.workflowName}', job '${status.ciContext.jobName}', event '${status.ciContext.eventName}', ref '${status.ciContext.resolvedRefName}', safe ref '${status.ciContext.safeRefName}', runner '${status.ciContext.runnerOs}/${status.ciContext.runnerArch}', job mode '${status.config.jobMode}', read only ${status.config.readOnly ? 'yes' : 'no'}, cache ${status.config.cacheEnabled ? 'enabled' : 'disabled'}.`,
    `Wrapper selection: ${status.config.wrapperSelectionMode}; wrapper files: ${status.validatedWrappers.length}.`,
  ];

  if (status.cacheModel) {
    lines.push(
      `Cache key: ${status.cacheModel.cacheKey}; Java major: ${status.cacheModel.javaMajor}; cache partitions: ${status.cacheModel.partitions.length}.`,
    );
  }

  if (status.baseCacheResult) {
    lines.push(status.baseCacheResult.message);
  }

  if (status.ciDiagnosticsLines.length > 0) {
    lines.push(...status.ciDiagnosticsLines);
  }

  if (status.phase === 'post') {
    lines.push('Wrapper provisioning is skipped during the post phase.');
    return lines;
  }

  if (status.provisionedWrappers.length === 0) {
    lines.push('No Gradle wrapper properties files were selected for provisioning.');
    return lines;
  }

  for (const wrapper of status.provisionedWrappers) {
    lines.push(createWrapperProvisioningLogMessage(wrapper));
  }

  return lines;
}

function createWrapperProvisioningSummaryLines(status: BootstrapStatus): readonly string[] {
  if (status.phase === 'post') {
    return ['- Wrapper provisioning is skipped during the post phase.'];
  }

  if (status.provisionedWrappers.length === 0) {
    return ['- No Gradle wrapper properties files were selected for provisioning.'];
  }

  return createHtmlTable(
    ['Wrapper properties', 'Action', 'Wrapper JAR', 'Gradle'],
    status.provisionedWrappers.map((wrapper) => [
      escapeHtml(wrapper.relativePath),
      escapeHtml(capitalize(describeWrapperProvisioningAction(wrapper))),
      escapeHtml(wrapper.wrapperJarRelativePath),
      escapeHtml(wrapper.wrapperSourceVersion),
    ]),
  );
}

function createWrapperProvisioningLogMessage(wrapper: ProvisionedWrapperJar): string {
  return (
    `${capitalize(describeWrapperProvisioningAction(wrapper))} trusted wrapper JAR for ` +
    `'${wrapper.relativePath}' at '${wrapper.wrapperJarRelativePath}' using Gradle ${wrapper.wrapperSourceVersion}.`
  );
}

function describeWrapperProvisioningAction(
  wrapper: ProvisionedWrapperJar,
): 'downloaded' | 'reused' {
  return wrapper.wasDownloaded ? 'downloaded' : 'reused';
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
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

    armBaseCachePostAction(dependencies.runtimeHost.saveState);
    return restoreResult;
  }

  return await saveBaseCache(
    config,
    cacheModel,
    isBaseCachePostActionArmed(dependencies.runtimeHost.getState),
    {
      cacheApi: dependencies.cacheApi,
    },
  );
}
