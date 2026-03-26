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

import { rm } from 'node:fs/promises';

import {
  createGitHubArtifactApi,
  uploadDeltaArtifactPackage,
  stageDeltaArtifactPackage,
  type WorkflowArtifactApi,
} from './artifacts/service';
import { bootstrapPhase, type BootstrapDependencies, type BootstrapStatus } from './bootstrap';
import { captureCacheManifest, computeCacheDelta } from './cache/manifest';
import {
  cleanupGradleBuildResultCapture,
  createGradleBuildSummaryLines,
  loadGradleBuildReport,
  type GradleBuildReport,
} from './gradle/build-results';
import { appendJobSummary } from './logging/summary';
import {
  getPersistedDeltaArtifactProducerIdentity,
  getPersistedConsumedDeltaArtifactNames,
  loadPersistedPreBuildCacheManifest,
} from './state/post-action';

const DELTA_ARTIFACT_RETENTION_DAYS = 7;

export interface PostDeltaArtifactResult {
  readonly status:
    | 'missing-pre-build-manifest'
    | 'not-distributed-worker'
    | 'read-only'
    | 'no-changes'
    | 'uploaded';
  readonly addedCount: number;
  readonly modifiedCount: number;
  readonly deletedCount: number;
  readonly totalChangedCount: number;
  readonly artifactName: string | null;
  readonly artifactId: number | null;
  readonly message: string;
}

export interface PostActionStatus {
  readonly bootstrap: BootstrapStatus;
  readonly consumedDeltaCleanupResult: PostConsumedDeltaCleanupResult | null;
  readonly deltaArtifactResult: PostDeltaArtifactResult | null;
  readonly gradleBuildReport: GradleBuildReport;
  readonly message: string;
}

export interface PostConsumedDeltaCleanupResult {
  readonly attemptedArtifactNames: readonly string[];
  readonly deletedArtifactNames: readonly string[];
  readonly warnings: readonly string[];
  readonly message: string;
}

export interface PostActionDependencies extends BootstrapDependencies {
  readonly artifactApi?: WorkflowArtifactApi;
}

export async function executePostAction(
  dependencies: PostActionDependencies = {},
): Promise<PostActionStatus> {
  const bootstrap = await bootstrapPhase('post', dependencies);
  const consumedDeltaCleanupResult = await cleanupConsumedDeltaArtifacts(bootstrap, dependencies);
  const gradleBuildReport = await loadGradleBuildReport(dependencies.env ?? process.env);
  const cleanupWarnings = await cleanupGradleBuildResultCapture(bootstrap.config.gradleUserHome);
  const combinedGradleBuildReport = {
    builds: gradleBuildReport.builds,
    warnings: [...gradleBuildReport.warnings, ...cleanupWarnings],
  } satisfies GradleBuildReport;

  if (!bootstrap.cacheModel) {
    const status = {
      bootstrap,
      consumedDeltaCleanupResult,
      deltaArtifactResult: null,
      gradleBuildReport: combinedGradleBuildReport,
      message: 'Post action flow completed without cache orchestration.',
    } satisfies PostActionStatus;
    await appendJobSummary(dependencies, createPostActionSummaryLines(status));
    return status;
  }

  const preBuildManifest = await loadPersistedPreBuildCacheManifest(
    dependencies.getState ?? (() => ''),
  );
  if (!preBuildManifest) {
    const status = {
      bootstrap,
      consumedDeltaCleanupResult,
      deltaArtifactResult: {
        status: 'missing-pre-build-manifest',
        addedCount: 0,
        modifiedCount: 0,
        deletedCount: 0,
        totalChangedCount: 0,
        artifactName: null,
        artifactId: null,
        message:
          'Delta artifact upload skipped because no persisted pre-build cache manifest was found in post-action state.',
      },
      gradleBuildReport: combinedGradleBuildReport,
      message: 'Post action flow completed without a persisted pre-build cache manifest.',
    } satisfies PostActionStatus;
    await appendJobSummary(dependencies, createPostActionSummaryLines(status));
    return status;
  }

  const currentManifest = await captureCacheManifest(bootstrap.cacheModel);
  const deltaManifest = computeCacheDelta(preBuildManifest, currentManifest);
  const deltaArtifactResult = await uploadPostDeltaArtifact(deltaManifest, bootstrap, dependencies);

  const status = {
    bootstrap,
    consumedDeltaCleanupResult,
    deltaArtifactResult,
    gradleBuildReport: combinedGradleBuildReport,
    message: createPostActionMessage(deltaArtifactResult),
  } satisfies PostActionStatus;

  await appendJobSummary(dependencies, createPostActionSummaryLines(status));

  return status;
}

async function uploadPostDeltaArtifact(
  deltaManifest: Parameters<typeof stageDeltaArtifactPackage>[2],
  bootstrap: BootstrapStatus,
  dependencies: PostActionDependencies,
): Promise<PostDeltaArtifactResult> {
  const counts = countDeltaEntries(deltaManifest);

  if (bootstrap.config.jobMode !== 'distributed-worker') {
    return {
      status: 'not-distributed-worker',
      artifactName: null,
      artifactId: null,
      ...counts,
      message: `Delta artifact upload skipped because only distributed-worker jobs publish delta artifacts; current mode is '${bootstrap.config.jobMode}'.`,
    };
  }

  if (bootstrap.config.readOnly) {
    return {
      status: 'read-only',
      artifactName: null,
      artifactId: null,
      ...counts,
      message: 'Delta artifact upload skipped because read-only mode is enabled.',
    };
  }

  if (counts.totalChangedCount === 0) {
    return {
      status: 'no-changes',
      artifactName: null,
      artifactId: null,
      ...counts,
      message:
        'Delta artifact upload skipped because no cache changes were detected after the build.',
    };
  }

  const artifactApi = dependencies.artifactApi ?? createGitHubArtifactApi();
  const persistedProducerIdentity = getPersistedDeltaArtifactProducerIdentity(
    dependencies.getState ?? (() => ''),
  );
  const deltaArtifactProducerContext = persistedProducerIdentity
    ? {
        ...bootstrap.ciContext,
        jobName: persistedProducerIdentity.jobName,
        runId: persistedProducerIdentity.runId,
        runAttempt: persistedProducerIdentity.runAttempt,
      }
    : bootstrap.ciContext;
  const stagedPackage = await stageDeltaArtifactPackage(
    deltaArtifactProducerContext,
    bootstrap.cacheModel!,
    deltaManifest,
  );

  try {
    const uploadedPackage = await uploadDeltaArtifactPackage(artifactApi, stagedPackage, {
      retentionDays: DELTA_ARTIFACT_RETENTION_DAYS,
    });
    return {
      status: 'uploaded',
      artifactName: uploadedPackage.artifact.name,
      artifactId: uploadedPackage.artifact.id,
      ...counts,
      message:
        `Uploaded delta artifact '${uploadedPackage.artifact.name}' ` +
        `with ${counts.addedCount} added, ${counts.modifiedCount} modified, ` +
        `${counts.deletedCount} deleted cache path(s); ` +
        `unconsumed artifacts expire after ${DELTA_ARTIFACT_RETENTION_DAYS} day(s).`,
    };
  } finally {
    await rm(stagedPackage.stagingDirectory, { recursive: true, force: true });
  }
}

async function cleanupConsumedDeltaArtifacts(
  bootstrap: BootstrapStatus,
  dependencies: PostActionDependencies,
): Promise<PostConsumedDeltaCleanupResult | null> {
  if (bootstrap.config.jobMode !== 'distributed-aggregator') {
    return null;
  }

  let artifactNames: readonly string[];
  try {
    artifactNames = getPersistedConsumedDeltaArtifactNames(dependencies.getState ?? (() => ''));
  } catch (error) {
    return {
      attemptedArtifactNames: [],
      deletedArtifactNames: [],
      warnings: [
        `Unable to load persisted consumed delta artifact names: ${error instanceof Error ? error.message : String(error)}`,
      ],
      message:
        'Consumed delta artifact cleanup skipped because persisted cleanup state could not be read.',
    };
  }

  if (artifactNames.length === 0) {
    return {
      attemptedArtifactNames: [],
      deletedArtifactNames: [],
      warnings: [],
      message:
        'Consumed delta artifact cleanup skipped because no dependent artifact names were persisted during the main phase.',
    };
  }

  const artifactApi = dependencies.artifactApi ?? createGitHubArtifactApi();
  const deleteResults = await Promise.allSettled(
    artifactNames.map(async (artifactName) => {
      await artifactApi.deleteArtifact(artifactName);
      return artifactName;
    }),
  );

  const deletedArtifactNames: string[] = [];
  const warnings: string[] = [];
  for (const [index, result] of deleteResults.entries()) {
    const artifactName = artifactNames[index]!;
    if (result.status === 'fulfilled') {
      deletedArtifactNames.push(result.value);
      continue;
    }

    warnings.push(
      `Failed to delete consumed delta artifact '${artifactName}': ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
    );
  }

  return {
    attemptedArtifactNames: artifactNames,
    deletedArtifactNames,
    warnings,
    message: `Consumed delta artifact cleanup deleted ${deletedArtifactNames.length} of ${artifactNames.length} persisted artifact(s).`,
  };
}

function countDeltaEntries(deltaManifest: Parameters<typeof stageDeltaArtifactPackage>[2]): {
  readonly addedCount: number;
  readonly modifiedCount: number;
  readonly deletedCount: number;
  readonly totalChangedCount: number;
} {
  let addedCount = 0;
  let modifiedCount = 0;
  let deletedCount = 0;

  for (const partition of deltaManifest.partitions) {
    for (const entry of partition.entries) {
      if (entry.changeType === 'added') {
        addedCount += 1;
      } else if (entry.changeType === 'modified') {
        modifiedCount += 1;
      } else {
        deletedCount += 1;
      }
    }
  }

  return {
    addedCount,
    modifiedCount,
    deletedCount,
    totalChangedCount: addedCount + modifiedCount + deletedCount,
  };
}

function createPostActionMessage(deltaArtifactResult: PostDeltaArtifactResult): string {
  if (deltaArtifactResult.status === 'uploaded') {
    return 'Post action flow completed and uploaded the distributed worker delta artifact.';
  }

  return 'Post action flow completed.';
}

export function createPostActionSummaryLines(status: PostActionStatus): readonly string[] {
  if (!status.deltaArtifactResult) {
    return [
      '## Apache Buildish post action',
      ...createGradleBuildSummaryLines(status.gradleBuildReport),
      ...createConsumedDeltaCleanupSummaryLines(status.consumedDeltaCleanupResult),
      '- Delta artifact upload: not evaluated.',
    ];
  }

  const result = status.deltaArtifactResult;
  return [
    '## Apache Buildish post action',
    ...createGradleBuildSummaryLines(status.gradleBuildReport),
    ...createConsumedDeltaCleanupSummaryLines(status.consumedDeltaCleanupResult),
    `- Delta artifact result: ${result.status}`,
    `- Post-build cache delta: ${result.addedCount} added, ${result.modifiedCount} modified, ${result.deletedCount} deleted.`,
    ...(result.artifactName
      ? [
          `- Uploaded artifact name: ${result.artifactName}`,
          `- Uploaded artifact ID: ${result.artifactId ?? 'unknown'}`,
        ]
      : []),
    `- Detail: ${result.message}`,
  ];
}

function createConsumedDeltaCleanupSummaryLines(
  cleanupResult: PostConsumedDeltaCleanupResult | null,
): readonly string[] {
  if (!cleanupResult) {
    return [];
  }

  return [
    `- Consumed delta cleanup attempted: ${cleanupResult.attemptedArtifactNames.length}`,
    `- Consumed delta cleanup deleted: ${cleanupResult.deletedArtifactNames.length}`,
    `- Consumed delta cleanup warnings: ${cleanupResult.warnings.length}`,
    ...cleanupResult.warnings.map((warning) => `- Warning: ${warning}`),
  ];
}
