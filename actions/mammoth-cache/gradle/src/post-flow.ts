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
  uploadDeltaArtifactPackage,
  stageDeltaArtifactPackage,
  type WorkflowArtifactApi,
} from './artifacts/service';
import {
  bootstrapPhase,
  createBootstrapLogLines,
  type BootstrapExecution,
  type BootstrapDependencies,
} from './bootstrap';
import type { CacheDeltaManifest, CacheManifest } from './cache/manifest';
import { captureCacheManifest, computeCacheDelta } from './cache/manifest';
import type { CacheModel } from './cache/model';
import type { BaseCacheRestoreResult } from './cache/service';
import {
  cleanupGradleBuildResultCapture,
  loadGradleBuildReport,
  type GradleBuildReport,
} from './gradle/build-results';
import {
  createHtmlLink,
  createHtmlTable,
  escapeHtml,
  publishJobLogGroup,
  replaceJobSummary,
} from './logging/summary';
import {
  getPersistedBaseCacheRestoreResult,
  getPersistedDeltaArtifactExecutionIdentity,
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
  readonly artifactSizeBytes: number | null;
  readonly message: string;
}

interface PostCacheStatisticCell {
  fileCount: number;
  totalSizeBytes: number;
}

interface PostCacheStatisticRow {
  readonly label: string;
  readonly total: PostCacheStatisticCell | null;
  readonly partitions: readonly (PostCacheStatisticCell | null)[];
}

interface PostCacheStatistics {
  readonly partitionDisplayNames: readonly string[];
  readonly rows: readonly PostCacheStatisticRow[];
}

export interface PostActionStatus {
  readonly bootstrap: BootstrapExecution;
  readonly baseCacheRestoreResult: BaseCacheRestoreResult | null;
  readonly cacheStatistics: PostCacheStatistics | null;
  readonly consumedDeltaCleanupResult: PostConsumedDeltaCleanupResult | null;
  readonly deltaArtifactResult: PostDeltaArtifactResult | null;
  readonly gradleBuildReport: GradleBuildReport;
  readonly jobUrl: string | null;
  readonly workflowRunUrl: string | null;
  readonly message: string;
}

export interface PostConsumedDeltaCleanupResult {
  readonly attemptedArtifactNames: readonly string[];
  readonly deletedArtifactNames: readonly string[];
  readonly warnings: readonly string[];
  readonly message: string;
}

export interface PostActionDependencies extends BootstrapDependencies {
  readonly artifactApi: WorkflowArtifactApi;
}

export async function executePostAction(
  dependencies: PostActionDependencies,
): Promise<PostActionStatus> {
  const logInfo = dependencies.runtimeHost.info;
  const bootstrap = await bootstrapPhase('post', dependencies);
  const { workflowRunUrl, jobUrl } = bootstrap.ciExecutionUrls;
  const baseCacheRestoreResult = getPersistedBaseCacheRestoreResult(
    dependencies.runtimeHost.getState,
  );
  const consumedDeltaCleanupResult = await cleanupConsumedDeltaArtifacts(bootstrap, dependencies);
  const gradleBuildReport = await loadGradleBuildReport(bootstrap.ciContext);
  const cleanupWarnings = await cleanupGradleBuildResultCapture(bootstrap.config.gradleUserHome);
  const combinedGradleBuildReport = {
    builds: gradleBuildReport.builds,
    warnings: [...gradleBuildReport.warnings, ...cleanupWarnings],
  } satisfies GradleBuildReport;

  if (!bootstrap.cacheModel) {
    const status = {
      bootstrap,
      baseCacheRestoreResult,
      cacheStatistics: null,
      consumedDeltaCleanupResult,
      deltaArtifactResult: null,
      gradleBuildReport: combinedGradleBuildReport,
      jobUrl,
      workflowRunUrl,
      message: 'Post action flow completed without cache orchestration.',
    } satisfies PostActionStatus;
    await publishPostActionLogGroup(dependencies, status, logInfo);
    await replaceJobSummary(bootstrap.ciProvider, createPostActionSummaryLines(status));
    return status;
  }

  const preBuildManifest = await loadPersistedPreBuildCacheManifest(
    dependencies.runtimeHost.getState,
  );
  if (!preBuildManifest) {
    const status = {
      bootstrap,
      baseCacheRestoreResult,
      cacheStatistics: null,
      consumedDeltaCleanupResult,
      deltaArtifactResult: {
        status: 'missing-pre-build-manifest',
        addedCount: 0,
        modifiedCount: 0,
        deletedCount: 0,
        totalChangedCount: 0,
        artifactName: null,
        artifactId: null,
        artifactSizeBytes: null,
        message:
          'Delta artifact upload skipped because no persisted pre-build cache manifest was found in post-action state.',
      },
      gradleBuildReport: combinedGradleBuildReport,
      jobUrl,
      workflowRunUrl,
      message: 'Post action flow completed without a persisted pre-build cache manifest.',
    } satisfies PostActionStatus;
    await publishPostActionLogGroup(dependencies, status, logInfo);
    await replaceJobSummary(bootstrap.ciProvider, createPostActionSummaryLines(status));
    return status;
  }

  const currentManifest = await captureCacheManifest(bootstrap.cacheModel);
  const deltaManifest = computeCacheDelta(preBuildManifest, currentManifest);
  const deltaArtifactResult = await uploadPostDeltaArtifact(deltaManifest, bootstrap, dependencies);

  const status = {
    bootstrap,
    baseCacheRestoreResult,
    cacheStatistics: createPostCacheStatistics(
      bootstrap.cacheModel,
      preBuildManifest,
      currentManifest,
      deltaManifest,
      baseCacheRestoreResult,
      deltaArtifactResult,
      bootstrap.baseCacheResult,
    ),
    consumedDeltaCleanupResult,
    deltaArtifactResult,
    gradleBuildReport: combinedGradleBuildReport,
    jobUrl,
    workflowRunUrl,
    message: createPostActionMessage(deltaArtifactResult),
  } satisfies PostActionStatus;

  await publishPostActionLogGroup(dependencies, status, logInfo);
  await replaceJobSummary(bootstrap.ciProvider, createPostActionSummaryLines(status));

  return status;
}

async function uploadPostDeltaArtifact(
  deltaManifest: Parameters<typeof stageDeltaArtifactPackage>[2],
  bootstrap: BootstrapExecution,
  dependencies: PostActionDependencies,
): Promise<PostDeltaArtifactResult> {
  const counts = countDeltaEntries(deltaManifest);

  if (bootstrap.config.jobMode !== 'distributed-worker') {
    return {
      status: 'not-distributed-worker',
      artifactName: null,
      artifactId: null,
      artifactSizeBytes: null,
      ...counts,
      message: `Delta artifact upload skipped because only distributed-worker jobs publish delta artifacts; current mode is '${bootstrap.config.jobMode}'.`,
    };
  }

  if (bootstrap.config.readOnly) {
    return {
      status: 'read-only',
      artifactName: null,
      artifactId: null,
      artifactSizeBytes: null,
      ...counts,
      message: 'Delta artifact upload skipped because read-only mode is enabled.',
    };
  }

  if (counts.totalChangedCount === 0) {
    return {
      status: 'no-changes',
      artifactName: null,
      artifactId: null,
      artifactSizeBytes: null,
      ...counts,
      message:
        'Delta artifact upload skipped because no cache changes were detected after the build.',
    };
  }

  const { artifactApi } = dependencies;
  const persistedExecutionIdentity = getPersistedDeltaArtifactExecutionIdentity(
    dependencies.runtimeHost.getState,
  );
  const deltaArtifactExecutionContext = persistedExecutionIdentity
    ? {
        ...bootstrap.ciContext,
        jobName: persistedExecutionIdentity.jobName,
        runId: persistedExecutionIdentity.runId,
        runAttempt: persistedExecutionIdentity.runAttempt,
      }
    : bootstrap.ciContext;
  const stagedPackage = await stageDeltaArtifactPackage(
    deltaArtifactExecutionContext,
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
      artifactSizeBytes: uploadedPackage.artifact.size,
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
  bootstrap: BootstrapExecution,
  dependencies: PostActionDependencies,
): Promise<PostConsumedDeltaCleanupResult | null> {
  if (bootstrap.config.jobMode !== 'distributed-aggregator') {
    return null;
  }

  let artifactNames: readonly string[];
  try {
    artifactNames = getPersistedConsumedDeltaArtifactNames(dependencies.runtimeHost.getState);
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

  const { artifactApi } = dependencies;
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
  const buildSummary = summarizeGradleBuildReport(status.gradleBuildReport);
  const summaryIssues = collectPostActionSummaryIssues(status, buildSummary);
  const overallStatus = determineOverallSummaryStatus(summaryIssues);
  return [
    '## Apache Buildish Mammoth Cache for Gradle',
    `${getSummaryStatusIcon(overallStatus)} Overall status: ${getSummaryStatusLabel(overallStatus)}`,
    '',
    createGradleBuildSectionHeading(status),
    ...createGradleBuildSectionLines(status),
  ];
}

async function publishPostActionLogGroup(
  dependencies: PostActionDependencies,
  status: PostActionStatus,
  logInfo: (message: string) => void,
): Promise<void> {
  await publishJobLogGroup(
    status.bootstrap.ciProvider,
    'Apache Buildish Mammoth Cache for Gradle',
    createPostActionLogLines(status),
    logInfo,
  );
}

function createPostActionLogLines(status: PostActionStatus): readonly string[] {
  const buildSummary = summarizeGradleBuildReport(status.gradleBuildReport);
  const summaryIssues = collectPostActionSummaryIssues(status, buildSummary);
  const lines = [
    ...createBootstrapLogLines(status.bootstrap),
    `${getSummaryStatusIcon(determineOverallSummaryStatus(summaryIssues))} Overall status: ${getSummaryStatusLabel(determineOverallSummaryStatus(summaryIssues))}`,
    `Captured Gradle builds: ${buildSummary.capturedBuildCount} (${buildSummary.successfulBuildCount} succeeded, ${buildSummary.failedBuildCount} failed).`,
    `Build Scans: ${buildSummary.publishedBuildScanCount} published, ${buildSummary.failedBuildScanCount} failed, ${buildSummary.buildScanNotAttemptedCount} not attempted.`,
  ];

  if (status.jobUrl) {
    lines.push(`Job logs: ${status.jobUrl}`);
  } else if (status.workflowRunUrl) {
    lines.push(`Workflow run: ${status.workflowRunUrl}`);
  }

  for (const error of summaryIssues.errors) {
    lines.push(`Error: ${error}`);
  }
  for (const warning of summaryIssues.warnings) {
    lines.push(`Warning: ${warning}`);
  }

  if (status.deltaArtifactResult?.artifactName) {
    const detailParts = [`Uploaded delta artifact '${status.deltaArtifactResult.artifactName}'`];
    if (status.deltaArtifactResult.artifactId !== null) {
      detailParts.push(`ID ${status.deltaArtifactResult.artifactId}`);
    }
    if (status.deltaArtifactResult.artifactSizeBytes !== null) {
      detailParts.push(formatByteCount(status.deltaArtifactResult.artifactSizeBytes));
    }
    lines.push(formatUploadedArtifactLogMessage(detailParts));
  }

  if (status.consumedDeltaCleanupResult?.attemptedArtifactNames.length) {
    lines.push(
      `Attempted cleanup of consumed delta artifacts: ${status.consumedDeltaCleanupResult.attemptedArtifactNames.join(', ')}.`,
    );
  }

  if (status.consumedDeltaCleanupResult?.deletedArtifactNames.length) {
    lines.push(
      `Deleted consumed delta artifacts: ${status.consumedDeltaCleanupResult.deletedArtifactNames.join(', ')}.`,
    );
  }

  lines.push(...createCacheDetailLogLines(status), ...createExecutionContextLogLines(status));

  for (const [index, build] of status.gradleBuildReport.builds.entries()) {
    const buildScanDetail = build.buildScanUri
      ? `Build Scan ${build.buildScanUri}`
      : build.buildScanFailed
        ? 'Build Scan failed'
        : 'Build Scan not attempted';
    lines.push(
      `Captured Gradle build ${index + 1}: ${displaySummaryText(build.rootProjectName, '(unnamed root project)')} — ${displaySummaryText(build.requestedTasks, '(default tasks)')}; Gradle ${build.gradleVersion} / Java ${build.javaVersion}; configuration cache ${build.configCacheHit ? 'reused' : 'not reused'}; ${buildScanDetail}.`,
    );
  }

  return lines;
}

function createCacheDetailLogLines(status: PostActionStatus): readonly string[] {
  if (!status.bootstrap.cacheModel) {
    return [];
  }

  const lines = [
    `Base cache restore: ${status.baseCacheRestoreResult?.status ?? 'not evaluated'}.`,
    `Base cache save: ${status.bootstrap.baseCacheResult?.status ?? 'not evaluated'}.`,
    `Delta artifact: ${status.deltaArtifactResult?.status ?? 'not evaluated'}.`,
  ];

  if (status.deltaArtifactResult) {
    lines.push(
      `Post-build cache delta: ${status.deltaArtifactResult.addedCount} added, ${status.deltaArtifactResult.modifiedCount} modified, ${status.deltaArtifactResult.deletedCount} deleted.`,
    );
  }

  if (status.consumedDeltaCleanupResult) {
    lines.push(
      `Consumed delta cleanup: deleted ${status.consumedDeltaCleanupResult.deletedArtifactNames.length} of ${status.consumedDeltaCleanupResult.attemptedArtifactNames.length}.`,
    );
  }

  if (status.cacheStatistics) {
    lines.push(...createCacheStatisticsLogLines(status.cacheStatistics));
  }

  return lines;
}

function createExecutionContextLogLines(status: PostActionStatus): readonly string[] {
  return [
    `Post-action detail: ${status.message}`,
    `Post-action cache context: cache key '${status.bootstrap.cacheModel?.cacheKey ?? 'disabled'}', Java major '${status.bootstrap.cacheModel?.javaMajor ?? 'n/a'}', cache partitions ${status.bootstrap.cacheModel?.partitions.length ?? 0}.`,
  ];
}

function summarizeGradleBuildReport(report: GradleBuildReport): {
  readonly capturedBuildCount: number;
  readonly successfulBuildCount: number;
  readonly failedBuildCount: number;
  readonly publishedBuildScanCount: number;
  readonly failedBuildScanCount: number;
  readonly buildScanNotAttemptedCount: number;
} {
  const successfulBuildCount = report.builds.filter((build) => !build.buildFailed).length;
  const failedBuildCount = report.builds.length - successfulBuildCount;
  const publishedBuildScanCount = report.builds.filter(
    (build) => build.buildScanUri !== null,
  ).length;
  const failedBuildScanCount = report.builds.filter((build) => build.buildScanFailed).length;
  const buildScanNotAttemptedCount =
    report.builds.length - publishedBuildScanCount - failedBuildScanCount;

  return {
    capturedBuildCount: report.builds.length,
    successfulBuildCount,
    failedBuildCount,
    publishedBuildScanCount,
    failedBuildScanCount,
    buildScanNotAttemptedCount,
  };
}

function collectPostActionSummaryIssues(
  status: PostActionStatus,
  buildSummary: ReturnType<typeof summarizeGradleBuildReport>,
): {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (buildSummary.failedBuildCount > 0) {
    errors.push(
      `${buildSummary.failedBuildCount} captured Gradle ${pluralize('build', buildSummary.failedBuildCount)} failed.`,
    );
  }

  if (status.deltaArtifactResult?.status === 'missing-pre-build-manifest') {
    errors.push(status.deltaArtifactResult.message);
  }

  if (buildSummary.failedBuildScanCount > 0) {
    warnings.push(
      `Build Scans failed for ${buildSummary.failedBuildScanCount} captured ${pluralize('build', buildSummary.failedBuildScanCount)}.`,
    );
  }

  warnings.push(...status.gradleBuildReport.warnings);
  warnings.push(...(status.consumedDeltaCleanupResult?.warnings ?? []));

  const restoreWarning = getBaseCacheWarning(status.baseCacheRestoreResult);
  if (restoreWarning) {
    warnings.push(restoreWarning);
  }

  const saveWarning = getBaseCacheWarning(status.bootstrap.baseCacheResult);
  if (saveWarning) {
    warnings.push(saveWarning);
  }

  return {
    errors,
    warnings,
  };
}

function determineOverallSummaryStatus(summaryIssues: {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}): 'success' | 'warning' | 'error' {
  if (summaryIssues.errors.length > 0) {
    return 'error';
  }
  if (summaryIssues.warnings.length > 0) {
    return 'warning';
  }
  return 'success';
}

function getSummaryStatusIcon(status: 'success' | 'warning' | 'error'): string {
  if (status === 'error') {
    return '❌';
  }
  if (status === 'warning') {
    return '⚠️';
  }
  return '✅';
}

function getSummaryStatusLabel(status: 'success' | 'warning' | 'error'): string {
  if (status === 'error') {
    return 'issues detected';
  }
  if (status === 'warning') {
    return 'completed with warnings';
  }
  return 'success';
}

function createGradleBuildSectionHeading(status: PostActionStatus): string {
  return status.jobUrl
    ? `### ${createHtmlLink(status.jobUrl, 'Gradle builds')}`
    : '### Gradle builds';
}

function createGradleBuildSectionLines(status: PostActionStatus): readonly string[] {
  if (status.gradleBuildReport.builds.length === 0) {
    return ['- No Gradle builds were captured in this job.'];
  }

  return [
    ...createHtmlTable(
      ['Outcome', 'Request', 'Toolchain', 'Configuration cache', 'Build Scan'],
      status.gradleBuildReport.builds.map((build) => [
        escapeHtml(build.buildFailed ? '❌' : '✅'),
        escapeHtml(
          `${displaySummaryText(build.rootProjectName, '(unnamed root project)')} — ${displaySummaryText(build.requestedTasks, '(default tasks)')}`,
        ),
        escapeHtml(`Gradle ${build.gradleVersion} / Java ${build.javaVersion}`),
        escapeHtml(build.configCacheHit ? 'reused' : 'not reused'),
        build.buildScanUri
          ? createHtmlLink(build.buildScanUri, '🔗')
          : escapeHtml(build.buildScanFailed ? '❌' : '—'),
      ]),
    ),
  ];
}

function createCacheStatisticsLogLines(cacheStatistics: PostCacheStatistics): readonly string[] {
  const hasAvailableRow = cacheStatistics.rows.some((row) => row.total !== null);
  if (!hasAvailableRow) {
    return [];
  }

  return [
    'Cache partition statistics (manifest-derived, uncompressed content sizes):',
    ...cacheStatistics.rows
      .filter((row) => row.total !== null)
      .map((row) => {
        const partitionSummary = row.partitions
          .map(
            (cell, index) =>
              `${cacheStatistics.partitionDisplayNames[index] ?? `Partition ${index + 1}`}: ${formatCacheStatisticCell(cell)}`,
          )
          .join('; ');
        return `- ${row.label}: total ${formatCacheStatisticCell(row.total)}; ${partitionSummary}`;
      }),
    'Note: base-cache rows reflect cache-manifest snapshots, not the compressed size of the backend cache entry.',
  ];
}

function displaySummaryText(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function formatUploadedArtifactLogMessage(detailParts: readonly string[]): string {
  if (detailParts.length === 0) {
    return 'Uploaded delta artifact.';
  }

  const [subject, ...details] = detailParts;
  return details.length > 0 ? `${subject} (${details.join(', ')}).` : `${subject}.`;
}

function createPostCacheStatistics(
  cacheModel: CacheModel,
  preBuildManifest: CacheManifest,
  currentManifest: CacheManifest,
  deltaManifest: CacheDeltaManifest,
  baseCacheRestoreResult: BaseCacheRestoreResult | null,
  deltaArtifactResult: PostDeltaArtifactResult,
  baseCacheSaveResult: BootstrapExecution['baseCacheResult'],
): PostCacheStatistics {
  const pulledBaseCache =
    baseCacheRestoreResult?.status === 'exact-hit' ||
    baseCacheRestoreResult?.status === 'partial-hit'
      ? summarizeManifest(cacheModel, preBuildManifest)
      : null;
  const deltaArtifact =
    deltaArtifactResult.status === 'uploaded' || deltaArtifactResult.status === 'no-changes'
      ? summarizeDeltaPayload(cacheModel, deltaManifest)
      : null;
  const uploadedBaseCache =
    baseCacheSaveResult?.operation === 'save' && baseCacheSaveResult.status === 'saved'
      ? summarizeManifest(cacheModel, currentManifest)
      : null;

  return {
    partitionDisplayNames: cacheModel.partitions.map((partition) => partition.displayName),
    rows: [
      createCacheStatisticRow('Pulled base cache', cacheModel, pulledBaseCache),
      createCacheStatisticRow('Delta artifact', cacheModel, deltaArtifact),
      createCacheStatisticRow('Uploaded base cache', cacheModel, uploadedBaseCache),
    ],
  };
}

function createCacheStatisticRow(
  label: string,
  cacheModel: CacheModel,
  statistics: ReadonlyMap<string, PostCacheStatisticCell> | null,
): PostCacheStatisticRow {
  const total = statistics ? summarizeStatisticCells(Array.from(statistics.values())) : null;
  return {
    label,
    total,
    partitions: cacheModel.partitions.map((partition) => statistics?.get(partition.id) ?? null),
  };
}

function summarizeManifest(
  cacheModel: CacheModel,
  manifest: CacheManifest,
): ReadonlyMap<string, PostCacheStatisticCell> {
  const statistics = initializeCacheStatistics(cacheModel);
  for (const partition of manifest.partitions) {
    const cell = statistics.get(partition.partitionId);
    if (!cell) {
      continue;
    }
    for (const entry of partition.entries) {
      cell.fileCount += 1;
      cell.totalSizeBytes += entry.size;
    }
  }
  return finalizeCacheStatistics(statistics);
}

function summarizeDeltaPayload(
  cacheModel: CacheModel,
  manifest: CacheDeltaManifest,
): ReadonlyMap<string, PostCacheStatisticCell> {
  const statistics = initializeCacheStatistics(cacheModel);
  for (const partition of manifest.partitions) {
    const cell = statistics.get(partition.partitionId);
    if (!cell) {
      continue;
    }
    for (const entry of partition.entries) {
      if (!entry.current) {
        continue;
      }
      cell.fileCount += 1;
      cell.totalSizeBytes += entry.current.size;
    }
  }
  return finalizeCacheStatistics(statistics);
}

function initializeCacheStatistics(cacheModel: CacheModel): Map<string, PostCacheStatisticCell> {
  return new Map(
    cacheModel.partitions.map((partition) => [
      partition.id,
      { fileCount: 0, totalSizeBytes: 0 } satisfies PostCacheStatisticCell,
    ]),
  );
}

function finalizeCacheStatistics(
  statistics: Map<string, PostCacheStatisticCell>,
): ReadonlyMap<string, PostCacheStatisticCell> {
  return new Map(
    Array.from(statistics.entries()).map(([partitionId, cell]) => [partitionId, { ...cell }]),
  );
}

function summarizeStatisticCells(cells: readonly PostCacheStatisticCell[]): PostCacheStatisticCell {
  return cells.reduce<PostCacheStatisticCell>(
    (summary, cell) => ({
      fileCount: summary.fileCount + cell.fileCount,
      totalSizeBytes: summary.totalSizeBytes + cell.totalSizeBytes,
    }),
    { fileCount: 0, totalSizeBytes: 0 },
  );
}

function formatCacheStatisticCell(cell: PostCacheStatisticCell | null): string {
  if (!cell) {
    return 'n/a';
  }
  return `${cell.fileCount} ${pluralize('file', cell.fileCount)} / ${formatByteCount(cell.totalSizeBytes)}`;
}

function getBaseCacheWarning(
  result: BaseCacheRestoreResult | BootstrapExecution['baseCacheResult'] | null,
): string | null {
  if (!result) {
    return null;
  }

  if (result.operation === 'restore') {
    if (result.status === 'feature-unavailable') {
      return result.message;
    }
    return null;
  }

  if (
    result.status === 'feature-unavailable' ||
    result.status === 'missing-paths' ||
    result.status === 'not-armed' ||
    result.status === 'not-saved'
  ) {
    return result.message;
  }

  return null;
}

function formatByteCount(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = value;
  let unitIndex = -1;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unitIndex]}`;
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}
