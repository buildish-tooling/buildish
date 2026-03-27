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

import * as core from '@actions/core';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import {
  createGitHubArtifactApi,
  downloadAndVerifyDeltaArtifactPackage,
  findDeltaArtifactByProducerJob,
  type DownloadedDeltaArtifactPackage,
  type WorkflowArtifactApi,
} from './artifacts/service';
import { bootstrapPhase, type BootstrapDependencies, type BootstrapStatus } from './bootstrap';
import {
  applyMergedDeltaPlan,
  mergeDeltaArtifactPackages,
  type DeltaApplyResult,
} from './cache/delta';
import { captureCacheManifest } from './cache/manifest';
import { restoreBaseCache } from './cache/service';
import {
  persistBaseCacheRestoreResult,
  persistConsumedDeltaArtifactNames,
  persistDeltaArtifactProducerIdentity,
  persistPreBuildCacheManifest,
  type PersistedPreBuildCacheManifestState,
} from './state/post-action';
import { installGradleBuildResultCapture } from './gradle/build-results';
import { appendJobSummary, createDetailsSection, escapeSummaryText } from './logging/summary';

export interface MainDependentDeltaResult extends DeltaApplyResult {
  readonly requestedJobs: readonly string[];
  readonly downloadedArtifactNames: readonly string[];
  readonly appliedArtifactCount: number;
  readonly message: string;
}

export interface MainActionStatus {
  readonly bootstrap: BootstrapStatus;
  readonly restoreCleanupResult: RestoreCleanupResult | null;
  readonly dependentDeltaResult: MainDependentDeltaResult | null;
  readonly preBuildManifestState: PersistedPreBuildCacheManifestState | null;
  readonly message: string;
}

export interface RestoreCleanupResult {
  readonly mode: 'prune-managed';
  readonly status: 'skipped-no-hit' | 'pruned';
  readonly deletedFileCount: number;
  readonly message: string;
}

export interface MainActionDependencies extends BootstrapDependencies {
  readonly artifactApi?: WorkflowArtifactApi;
}

export async function executeMainAction(
  dependencies: MainActionDependencies = {},
): Promise<MainActionStatus> {
  const logInfo = dependencies.logInfo ?? core.info;
  const bootstrap = await bootstrapPhase('main', dependencies);
  await installGradleBuildResultCapture(bootstrap.config.gradleUserHome).catch((error: unknown) => {
    logInfo(
      `Gradle build reporting could not install capture hooks and will be skipped for this job: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  if (!bootstrap.cacheModel) {
    return {
      bootstrap,
      restoreCleanupResult: null,
      dependentDeltaResult: null,
      preBuildManifestState: null,
      message: 'Main action flow completed without cache orchestration.',
    };
  }

  const restoreCleanupResult = await maybePruneManagedFilesAfterRestore(bootstrap, dependencies);
  const dependentDeltaResult = await applyDependentJobDeltas(bootstrap, dependencies);
  if (dependentDeltaResult) {
    persistConsumedDeltaArtifactNames(
      dependentDeltaResult.downloadedArtifactNames,
      dependencies.saveState ?? core.saveState,
    );
  }
  if (bootstrap.baseCacheResult?.operation === 'restore') {
    persistBaseCacheRestoreResult(
      bootstrap.baseCacheResult,
      dependencies.saveState ?? core.saveState,
    );
  }
  persistDeltaArtifactProducerIdentity(
    bootstrap.ciContext,
    dependencies.saveState ?? core.saveState,
  );
  const manifest = await captureCacheManifest(bootstrap.cacheModel);
  const preBuildManifestState = await persistPreBuildCacheManifest(
    manifest,
    dependencies.saveState ?? core.saveState,
    { env: dependencies.env },
  );

  const status = {
    bootstrap,
    restoreCleanupResult,
    dependentDeltaResult,
    preBuildManifestState,
    message: createMainActionMessage(dependentDeltaResult),
  } satisfies MainActionStatus;

  logMainActionDetails(status, logInfo);
  await appendJobSummary(dependencies, createMainActionSummaryLines(status));

  return status;
}

async function applyDependentJobDeltas(
  bootstrap: BootstrapStatus,
  dependencies: MainActionDependencies,
): Promise<MainDependentDeltaResult | null> {
  const requestedJobs = bootstrap.config.dependentJobs;
  if (requestedJobs.length === 0) {
    return null;
  }

  const artifactApi = dependencies.artifactApi ?? createGitHubArtifactApi();
  const downloadedPackages = await Promise.all(
    requestedJobs.map(async (jobName) => {
      const artifact = await findDeltaArtifactByProducerJob(
        artifactApi,
        jobName,
        bootstrap.ciContext.runId,
        bootstrap.ciContext.runAttempt,
      );
      return await downloadAndVerifyDeltaArtifactPackage(artifactApi, artifact);
    }),
  );

  try {
    assertCompatibleDependentDeltaArtifacts(downloadedPackages, bootstrap);
    const plan = mergeDeltaArtifactPackages(downloadedPackages, {
      allowDuplicateDependentDeltaPaths: bootstrap.config.allowDuplicateDependentDeltaPaths,
    });
    const applied = await applyMergedDeltaPlan(plan, bootstrap.config.gradleUserHome);
    return createMainDependentDeltaResult(requestedJobs, downloadedPackages, applied);
  } finally {
    await cleanupDownloadedPackages(downloadedPackages);
  }
}

function assertCompatibleDependentDeltaArtifacts(
  downloadedPackages: readonly DownloadedDeltaArtifactPackage[],
  bootstrap: BootstrapStatus,
): void {
  const currentCacheKey = bootstrap.cacheModel?.cacheKey;
  const currentRunner = `${bootstrap.ciContext.runnerOs}/${bootstrap.ciContext.runnerArch}`;

  for (const artifactPackage of downloadedPackages) {
    const producer = artifactPackage.metadata.producer;
    if (
      producer.runnerOs === bootstrap.ciContext.runnerOs &&
      producer.runnerArch === bootstrap.ciContext.runnerArch
    ) {
      if (currentCacheKey && producer.cacheKey !== currentCacheKey) {
        throw new Error(
          `Dependent delta artifact '${artifactPackage.artifact.name}' from job '${producer.jobName}' targets cache key '${producer.cacheKey}', but the current job expects '${currentCacheKey}'. Distributed delta reuse requires identical cache key inputs, partition layout, and runner selection.`,
        );
      }
      continue;
    }

    throw new Error(
      `Dependent delta artifact '${artifactPackage.artifact.name}' from job '${producer.jobName}' targets runner ${producer.runnerOs}/${producer.runnerArch}, but the current job runs on ${currentRunner}. Cross-runner dependent delta reuse is not supported; keep distributed jobs on the same runner OS and architecture.`,
    );
  }
}

async function maybePruneManagedFilesAfterRestore(
  bootstrap: BootstrapStatus,
  dependencies: MainActionDependencies,
): Promise<RestoreCleanupResult | null> {
  if (bootstrap.config.restoreCleanupMode === 'none' || !bootstrap.cacheModel) {
    return null;
  }

  const baseCacheResult = bootstrap.baseCacheResult;
  if (
    !baseCacheResult ||
    baseCacheResult.operation !== 'restore' ||
    (baseCacheResult.status !== 'exact-hit' && baseCacheResult.status !== 'partial-hit')
  ) {
    return {
      mode: 'prune-managed',
      status: 'skipped-no-hit',
      deletedFileCount: 0,
      message:
        'Restore cleanup skipped because no base cache hit was available to re-apply after pruning managed files.',
    };
  }

  const manifest = await captureCacheManifest(bootstrap.cacheModel);
  const relativePaths = manifest.partitions.flatMap((partition) =>
    partition.entries.map((entry) => entry.relativePath),
  );
  await Promise.all(
    relativePaths.map(async (relativePath) => {
      await rm(path.join(bootstrap.config.gradleUserHome, relativePath), { force: true });
    }),
  );

  const reRestore = await restoreBaseCache(bootstrap.config, bootstrap.cacheModel, dependencies);
  if (
    reRestore.operation !== 'restore' ||
    (reRestore.status !== 'exact-hit' && reRestore.status !== 'partial-hit')
  ) {
    throw new Error(
      `restore-cleanup-mode=prune-managed deleted ${relativePaths.length} managed file(s), but the follow-up base cache restore did not hit again. Refusing to continue with a partially pruned Gradle user home.`,
    );
  }

  return {
    mode: 'prune-managed',
    status: 'pruned',
    deletedFileCount: relativePaths.length,
    message: `Pruned ${relativePaths.length} managed file(s) from the active cache partitions and re-restored base cache '${reRestore.matchedKey ?? reRestore.cacheKey}'.`,
  };
}

function createMainDependentDeltaResult(
  requestedJobs: readonly string[],
  downloadedPackages: readonly DownloadedDeltaArtifactPackage[],
  applied: DeltaApplyResult,
): MainDependentDeltaResult {
  return {
    ...applied,
    requestedJobs,
    downloadedArtifactNames: downloadedPackages.map(
      (artifactPackage) => artifactPackage.artifact.name,
    ),
    appliedArtifactCount: downloadedPackages.length,
    message:
      `Applied ${downloadedPackages.length} dependent delta artifact(s) ` +
      `from ${requestedJobs.length} configured job(s): ` +
      `${applied.addedCount} added, ${applied.modifiedCount} modified, ${applied.deletedCount} deleted.`,
  };
}

async function cleanupDownloadedPackages(
  downloadedPackages: readonly DownloadedDeltaArtifactPackage[],
): Promise<void> {
  await Promise.all(
    downloadedPackages.map(async (artifactPackage) => {
      await rm(artifactPackage.downloadDirectory, { recursive: true, force: true });
    }),
  );
}

function createMainActionMessage(dependentDeltaResult: MainDependentDeltaResult | null): string {
  if (!dependentDeltaResult) {
    return 'Main action flow completed and captured the pre-build cache manifest for post processing.';
  }

  return 'Main action flow completed and captured the pre-build cache manifest for post processing.';
}

export function createMainActionSummaryLines(status: MainActionStatus): readonly string[] {
  const dependentDelta = status.dependentDeltaResult;

  return [
    '## Apache Buildish main action',
    `- Restore cleanup: ${describeRestoreCleanupSummary(status.restoreCleanupResult)}`,
    `- Dependent delta reuse: ${describeDependentDeltaSummary(dependentDelta)}`,
    ...(status.preBuildManifestState
      ? ['- Pre-build manifest: persisted']
      : ['- Pre-build manifest: not persisted']),
    ...createDetailsSection('Main-phase details', [
      `- Dependent jobs configured: ${dependentDelta?.requestedJobs.length ?? 0}`,
      `- Downloaded delta artifacts: ${dependentDelta?.appliedArtifactCount ?? 0}`,
      ...(dependentDelta
        ? [
            `- Applied delta changes: ${dependentDelta.addedCount} added, ${dependentDelta.modifiedCount} modified, ${dependentDelta.deletedCount} deleted.`,
            `- Delta apply warnings: ${dependentDelta.warnings.length}`,
            `- Post-job artifact cleanup scheduled: ${dependentDelta.downloadedArtifactNames.length}`,
          ]
        : []),
      ...(status.restoreCleanupResult
        ? [
            `- Restore cleanup mode: ${escapeSummaryText(status.restoreCleanupResult.mode)}`,
            `- Restore cleanup status: ${escapeSummaryText(status.restoreCleanupResult.status)}`,
            `- Restore cleanup deleted files: ${status.restoreCleanupResult.deletedFileCount}`,
          ]
        : []),
    ]),
  ];
}

function logMainActionDetails(status: MainActionStatus, logInfo: (message: string) => void): void {
  if (status.restoreCleanupResult) {
    logInfo(status.restoreCleanupResult.message);
  }

  if (status.dependentDeltaResult) {
    if (status.dependentDeltaResult.requestedJobs.length > 0) {
      logInfo(
        `Configured dependent jobs: ${formatSummaryList(status.dependentDeltaResult.requestedJobs)}.`,
      );
    }
    if (status.dependentDeltaResult.downloadedArtifactNames.length > 0) {
      logInfo(
        `Downloaded dependent delta artifacts: ${formatSummaryList(status.dependentDeltaResult.downloadedArtifactNames)}.`,
      );
    }
  }

  if (status.preBuildManifestState) {
    logInfo(
      `Persisted pre-build cache manifest to '${status.preBuildManifestState.manifestPath}'.`,
    );
  }
}

function describeRestoreCleanupSummary(result: RestoreCleanupResult | null): string {
  if (!result) {
    return 'none';
  }

  return result.status === 'pruned'
    ? `${result.mode} (${result.deletedFileCount} deleted)`
    : `${result.mode} (${result.status})`;
}

function describeDependentDeltaSummary(result: MainDependentDeltaResult | null): string {
  if (!result) {
    return 'none';
  }

  return `${result.appliedArtifactCount} artifact(s) from ${result.requestedJobs.length} job(s)`;
}

export function createMainActionOutputs(status: MainActionStatus): Record<string, string> {
  const gradleVersions = [
    ...new Set(status.bootstrap.provisionedWrappers.map((wrapper) => wrapper.wrapperSourceVersion)),
  ]
    .sort()
    .join(',');
  const wrapperDownloadedCount = status.bootstrap.provisionedWrappers.filter(
    (wrapper) => wrapper.wasDownloaded,
  ).length;

  return {
    'cache-key': status.bootstrap.cacheModel?.cacheKey ?? '',
    'base-cache-restore-status':
      status.bootstrap.baseCacheResult?.operation === 'restore'
        ? status.bootstrap.baseCacheResult.status
        : '',
    'java-major': status.bootstrap.cacheModel?.javaMajor?.toString() ?? '',
    'job-mode': status.bootstrap.config.jobMode,
    'read-only': String(status.bootstrap.config.readOnly),
    'wrapper-count': String(status.bootstrap.provisionedWrappers.length),
    'gradle-versions': gradleVersions,
    'wrapper-downloaded-count': String(wrapperDownloadedCount),
    'wrapper-reused-count': String(
      status.bootstrap.provisionedWrappers.length - wrapperDownloadedCount,
    ),
    'resolved-ref-name': status.bootstrap.ciContext.resolvedRefName,
    'safe-ref-name': status.bootstrap.ciContext.safeRefName,
    'dependent-jobs-count': String(status.bootstrap.config.dependentJobs.length),
    'downloaded-dependent-artifact-count': String(
      status.dependentDeltaResult?.appliedArtifactCount ?? 0,
    ),
    'job-name': status.bootstrap.ciContext.jobName,
  };
}

function formatSummaryList(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ');
}
