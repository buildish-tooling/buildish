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

import { rm } from 'node:fs/promises';

import {
  createGitHubArtifactApi,
  uploadDeltaArtifactPackage,
  stageDeltaArtifactPackage,
  type WorkflowArtifactApi,
} from './artifacts/service';
import { bootstrapPhase, type BootstrapDependencies, type BootstrapStatus } from './bootstrap';
import { captureCacheManifest, computeCacheDelta } from './cache/manifest';
import { loadPersistedPreBuildCacheManifest } from './state/post-action';

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
  readonly deltaArtifactResult: PostDeltaArtifactResult | null;
  readonly message: string;
}

export interface PostActionDependencies extends BootstrapDependencies {
  readonly artifactApi?: WorkflowArtifactApi;
}

export async function executePostAction(
  dependencies: PostActionDependencies = {},
): Promise<PostActionStatus> {
  const bootstrap = await bootstrapPhase('post', dependencies);

  if (!bootstrap.cacheModel) {
    return {
      bootstrap,
      deltaArtifactResult: null,
      message: 'Post action flow completed without cache orchestration.',
    };
  }

  const preBuildManifest = await loadPersistedPreBuildCacheManifest(
    dependencies.getState ?? (() => ''),
  );
  if (!preBuildManifest) {
    return {
      bootstrap,
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
      message: 'Post action flow completed without a persisted pre-build cache manifest.',
    };
  }

  const currentManifest = await captureCacheManifest(bootstrap.cacheModel);
  const deltaManifest = computeCacheDelta(preBuildManifest, currentManifest);
  const deltaArtifactResult = await uploadPostDeltaArtifact(deltaManifest, bootstrap, dependencies);

  return {
    bootstrap,
    deltaArtifactResult,
    message: createPostActionMessage(deltaArtifactResult),
  };
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
  const stagedPackage = await stageDeltaArtifactPackage(
    bootstrap.ciContext,
    bootstrap.cacheModel!,
    deltaManifest,
  );

  try {
    const uploadedPackage = await uploadDeltaArtifactPackage(artifactApi, stagedPackage);
    return {
      status: 'uploaded',
      artifactName: uploadedPackage.artifact.name,
      artifactId: uploadedPackage.artifact.id,
      ...counts,
      message:
        `Uploaded delta artifact '${uploadedPackage.artifact.name}' ` +
        `with ${counts.addedCount} added, ${counts.modifiedCount} modified, ` +
        `${counts.deletedCount} deleted cache path(s).`,
    };
  } finally {
    await rm(stagedPackage.stagingDirectory, { recursive: true, force: true });
  }
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
