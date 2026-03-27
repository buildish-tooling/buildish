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

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  deserializeCacheManifest,
  serializeCacheManifest,
  type CacheManifest,
} from '../cache/manifest';
import type { BaseCacheRestoreResult } from '../cache/service';
import type { CiJobContext } from '../ci/types';
import {
  parseSerializedJsonObject,
  validateArray,
  validateNonNegativeInteger,
  validateString,
} from '../validation';

export const PRE_BUILD_CACHE_MANIFEST_PATH_STATE =
  'buildish-mammoth-cache-gradle-pre-build-manifest-path';
export const CONSUMED_DELTA_ARTIFACT_NAMES_STATE =
  'buildish-mammoth-cache-gradle-consumed-delta-artifact-names';
export const DELTA_ARTIFACT_PRODUCER_IDENTITY_STATE =
  'buildish-mammoth-cache-gradle-delta-artifact-producer-identity';
export const BASE_CACHE_RESTORE_RESULT_STATE =
  'buildish-mammoth-cache-gradle-base-cache-restore-result';
const BASE_CACHE_RESTORE_STATUSES = [
  'feature-unavailable',
  'miss',
  'exact-hit',
  'partial-hit',
] as const;
const PRE_BUILD_CACHE_MANIFEST_FILE = 'pre-build-cache-manifest.json';

export interface PersistedDeltaArtifactProducerIdentity {
  readonly jobName: string;
  readonly runId: number | null;
  readonly runAttempt: number | null;
}

export interface PersistedPreBuildCacheManifestState {
  readonly manifestPath: string;
}

export interface PersistPreBuildCacheManifestOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly parentDirectory?: string;
  readonly tempDirectory?: string | null;
}

export interface LoadPersistedPreBuildCacheManifestOptions {
  readonly readFileImpl?: typeof readFile;
}

export async function persistPreBuildCacheManifest(
  manifest: CacheManifest,
  saveState: (name: string, value: string) => void,
  options: PersistPreBuildCacheManifestOptions = {},
): Promise<PersistedPreBuildCacheManifestState> {
  const parentDirectory = resolveStateParentDirectory(options);
  await mkdir(parentDirectory, { recursive: true });
  const stateDirectory = await mkdtemp(
    path.join(parentDirectory, 'buildish-mammoth-cache-gradle-post-state-'),
  );
  const manifestPath = path.join(stateDirectory, PRE_BUILD_CACHE_MANIFEST_FILE);

  await writeFile(manifestPath, serializeCacheManifest(manifest), 'utf8');
  saveState(PRE_BUILD_CACHE_MANIFEST_PATH_STATE, manifestPath);

  return { manifestPath };
}

export async function loadPersistedPreBuildCacheManifest(
  getState: (name: string) => string,
  options: LoadPersistedPreBuildCacheManifestOptions = {},
): Promise<CacheManifest | null> {
  const manifestPath = getPersistedPreBuildCacheManifestPath(getState);
  if (!manifestPath) {
    return null;
  }

  const readFileImpl = options.readFileImpl ?? readFile;
  return deserializeCacheManifest(await readFileImpl(manifestPath, 'utf8'));
}

export function getPersistedPreBuildCacheManifestPath(
  getState: (name: string) => string,
): string | null {
  const manifestPath = getState(PRE_BUILD_CACHE_MANIFEST_PATH_STATE).trim();
  return manifestPath.length > 0 ? path.resolve(manifestPath) : null;
}

export function persistConsumedDeltaArtifactNames(
  artifactNames: readonly string[],
  saveState: (name: string, value: string) => void,
): void {
  saveState(CONSUMED_DELTA_ARTIFACT_NAMES_STATE, `${JSON.stringify([...artifactNames])}\n`);
}

export function persistDeltaArtifactProducerIdentity(
  ciContext: CiJobContext,
  saveState: (name: string, value: string) => void,
): void {
  const identity: PersistedDeltaArtifactProducerIdentity = {
    jobName: ciContext.jobName,
    runId: ciContext.runId,
    runAttempt: ciContext.runAttempt,
  };
  saveState(DELTA_ARTIFACT_PRODUCER_IDENTITY_STATE, `${JSON.stringify(identity)}\n`);
}

export function persistBaseCacheRestoreResult(
  result: BaseCacheRestoreResult,
  saveState: (name: string, value: string) => void,
): void {
  saveState(BASE_CACHE_RESTORE_RESULT_STATE, `${JSON.stringify(result)}\n`);
}

export function getPersistedDeltaArtifactProducerIdentity(
  getState: (name: string) => string,
): PersistedDeltaArtifactProducerIdentity | null {
  const serializedIdentity = getState(DELTA_ARTIFACT_PRODUCER_IDENTITY_STATE).trim();
  if (serializedIdentity.length === 0) {
    return null;
  }

  const parsedIdentity = parseSerializedJsonObject(
    serializedIdentity,
    'delta artifact producer identity state',
  );
  return {
    jobName: validateNonEmptyStateString(
      parsedIdentity.jobName,
      'delta artifact producer identity jobName',
    ),
    runId: validateNullableInteger(parsedIdentity.runId, 'delta artifact producer identity runId'),
    runAttempt: validateNullableInteger(
      parsedIdentity.runAttempt,
      'delta artifact producer identity runAttempt',
    ),
  };
}

export function getPersistedBaseCacheRestoreResult(
  getState: (name: string) => string,
): BaseCacheRestoreResult | null {
  const serializedResult = getState(BASE_CACHE_RESTORE_RESULT_STATE).trim();
  if (serializedResult.length === 0) {
    return null;
  }

  const parsedResult = parseSerializedJsonObject(
    serializedResult,
    'base cache restore result state',
  );
  const operation = validateNonEmptyStateString(
    parsedResult.operation,
    'base cache restore result operation',
  );
  if (operation !== 'restore') {
    throw new Error(
      `base cache restore result operation must be 'restore', received '${operation}'.`,
    );
  }

  const status = validateNonEmptyStateString(
    parsedResult.status,
    'base cache restore result status',
  );
  if (
    !BASE_CACHE_RESTORE_STATUSES.includes(status as (typeof BASE_CACHE_RESTORE_STATUSES)[number])
  ) {
    throw new Error(`Unsupported base cache restore result status '${status}'.`);
  }

  return {
    operation: 'restore',
    status: status as BaseCacheRestoreResult['status'],
    cacheKey: validateNonEmptyStateString(
      parsedResult.cacheKey,
      'base cache restore result cacheKey',
    ),
    matchedKey: validateNullableStateString(
      parsedResult.matchedKey,
      'base cache restore result matchedKey',
    ),
    restoreKeys: validateStateStringArray(
      parsedResult.restoreKeys,
      'base cache restore result restoreKeys',
    ),
    paths: validateStateStringArray(parsedResult.paths, 'base cache restore result paths'),
    message: validateNonEmptyStateString(parsedResult.message, 'base cache restore result message'),
  } satisfies BaseCacheRestoreResult;
}

export function getPersistedConsumedDeltaArtifactNames(
  getState: (name: string) => string,
): readonly string[] {
  const serializedArtifactNames = getState(CONSUMED_DELTA_ARTIFACT_NAMES_STATE).trim();
  if (serializedArtifactNames.length === 0) {
    return [];
  }

  let parsedArtifactNames: unknown;
  try {
    parsedArtifactNames = JSON.parse(serializedArtifactNames) as unknown;
  } catch (error) {
    throw new Error(
      `Persisted consumed delta artifact state was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const uniqueArtifactNames = new Set<string>();
  for (const [index, value] of validateArray(
    parsedArtifactNames,
    'persisted consumed delta artifact names',
  ).entries()) {
    const artifactName = validateString(
      value,
      `persisted consumed delta artifact name at index ${index}`,
    );
    const trimmedArtifactName = artifactName.trim();
    if (trimmedArtifactName.length === 0) {
      throw new Error(
        `Persisted consumed delta artifact name at index ${index} must not be blank.`,
      );
    }
    uniqueArtifactNames.add(trimmedArtifactName);
  }

  return [...uniqueArtifactNames];
}

function resolveStateParentDirectory(options: PersistPreBuildCacheManifestOptions): string {
  const parentDirectory = options.parentDirectory?.trim();
  if (parentDirectory) {
    return path.resolve(parentDirectory);
  }

  const tempDirectory = options.tempDirectory?.trim();
  if (tempDirectory) {
    return path.resolve(tempDirectory);
  }

  const runnerTemp = options.env?.RUNNER_TEMP?.trim();
  return runnerTemp ? path.resolve(runnerTemp) : os.tmpdir();
}

function validateNonEmptyStateString(value: unknown, label: string): string {
  const trimmed = validateString(value, label).trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} must not be blank.`);
  }
  return trimmed;
}

function validateNullableInteger(value: unknown, label: string): number | null {
  if (value === null) {
    return null;
  }
  return validateNonNegativeInteger(value, label);
}

function validateNullableStateString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  return validateNonEmptyStateString(value, label);
}

function validateStateStringArray(value: unknown, label: string): readonly string[] {
  return validateArray(value, label).map((entry, index) =>
    validateNonEmptyStateString(entry, `${label} entry ${index}`),
  );
}
