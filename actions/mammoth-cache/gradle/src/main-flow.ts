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
import {
  persistConsumedDeltaArtifactNames,
  persistPreBuildCacheManifest,
  type PersistedPreBuildCacheManifestState,
} from './state/post-action';
import { appendJobSummary } from './logging/summary';

export interface MainDependentDeltaResult extends DeltaApplyResult {
  readonly requestedJobs: readonly string[];
  readonly downloadedArtifactNames: readonly string[];
  readonly appliedArtifactCount: number;
  readonly message: string;
}

export interface MainActionStatus {
  readonly bootstrap: BootstrapStatus;
  readonly dependentDeltaResult: MainDependentDeltaResult | null;
  readonly preBuildManifestState: PersistedPreBuildCacheManifestState | null;
  readonly message: string;
}

export interface MainActionDependencies extends BootstrapDependencies {
  readonly artifactApi?: WorkflowArtifactApi;
}

export async function executeMainAction(
  dependencies: MainActionDependencies = {},
): Promise<MainActionStatus> {
  const bootstrap = await bootstrapPhase('main', dependencies);

  if (!bootstrap.cacheModel) {
    return {
      bootstrap,
      dependentDeltaResult: null,
      preBuildManifestState: null,
      message: 'Main action flow completed without cache orchestration.',
    };
  }

  const dependentDeltaResult = await applyDependentJobDeltas(bootstrap, dependencies);
  if (dependentDeltaResult) {
    persistConsumedDeltaArtifactNames(
      dependentDeltaResult.downloadedArtifactNames,
      dependencies.saveState ?? core.saveState,
    );
  }
  const manifest = await captureCacheManifest(bootstrap.cacheModel);
  const preBuildManifestState = await persistPreBuildCacheManifest(
    manifest,
    dependencies.saveState ?? core.saveState,
    { env: dependencies.env },
  );

  const status = {
    bootstrap,
    dependentDeltaResult,
    preBuildManifestState,
    message: createMainActionMessage(dependentDeltaResult),
  } satisfies MainActionStatus;

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
    const plan = mergeDeltaArtifactPackages(downloadedPackages);
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
  const currentRunner = `${bootstrap.ciContext.runnerOs}/${bootstrap.ciContext.runnerArch}`;

  for (const artifactPackage of downloadedPackages) {
    const producer = artifactPackage.metadata.producer;
    if (
      producer.runnerOs === bootstrap.ciContext.runnerOs &&
      producer.runnerArch === bootstrap.ciContext.runnerArch
    ) {
      continue;
    }

    throw new Error(
      `Dependent delta artifact '${artifactPackage.artifact.name}' from job '${producer.jobName}' targets runner ${producer.runnerOs}/${producer.runnerArch}, but the current job runs on ${currentRunner}. Cross-runner dependent delta reuse is not supported; keep distributed jobs on the same runner OS and architecture.`,
    );
  }
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
  return [
    '## Apache Buildish main action',
    ...(status.dependentDeltaResult
      ? [
          `- Dependent jobs requested: ${formatSummaryList(status.dependentDeltaResult.requestedJobs)}`,
          `- Downloaded delta artifacts: ${status.dependentDeltaResult.appliedArtifactCount}`,
          `- Artifact names: ${formatSummaryList(status.dependentDeltaResult.downloadedArtifactNames)}`,
          `- Applied delta changes: ${status.dependentDeltaResult.addedCount} added, ${status.dependentDeltaResult.modifiedCount} modified, ${status.dependentDeltaResult.deletedCount} deleted.`,
          `- Delta apply warnings: ${status.dependentDeltaResult.warnings.length}`,
          `- Post-job artifact cleanup scheduled: ${status.dependentDeltaResult.downloadedArtifactNames.length}`,
          ...status.dependentDeltaResult.warnings.map((warning) => `- Warning: ${warning}`),
        ]
      : ['- Dependent jobs requested: none', '- Downloaded delta artifacts: 0']),
    ...(status.preBuildManifestState
      ? [
          '- Pre-build manifest persisted: yes',
          `- Pre-build manifest path: ${status.preBuildManifestState.manifestPath}`,
        ]
      : ['- Pre-build manifest persisted: no']),
  ];
}

function formatSummaryList(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ');
}
