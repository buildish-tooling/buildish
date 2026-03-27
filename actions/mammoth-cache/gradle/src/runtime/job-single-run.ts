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

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CiJobContext } from '../ci/types';

export const JOB_SINGLE_RUN_OWNER_TOKEN_STATE =
  'buildish-mammoth-cache-gradle-job-single-run-owner-token';
export const JOB_SINGLE_RUN_DUPLICATE_STATE =
  'buildish-mammoth-cache-gradle-job-single-run-duplicate';

const JOB_SINGLE_RUN_DIRECTORY = 'buildish-mammoth-cache-gradle-job-guards';

type JobSingleRunCiIdentity = Pick<
  CiJobContext,
  'repository' | 'workflowName' | 'jobName' | 'runId' | 'runAttempt' | 'tempDirectory'
>;

export interface JobSingleRunDependencies {
  readonly ciContext: JobSingleRunCiIdentity;
  readonly saveState: (name: string, value: string) => void;
  readonly getState?: (name: string) => string;
  readonly createOwnerToken?: () => string;
}

export interface JobSingleRunClaimResult {
  readonly accepted: boolean;
  readonly message: string;
}

export interface JobSingleRunPostDecision {
  readonly shouldRun: boolean;
  readonly message: string;
}

export async function claimSingleRunJobInvocation(
  dependencies: JobSingleRunDependencies,
): Promise<JobSingleRunClaimResult> {
  const guardFilePath = resolveSingleRunGuardFilePath(dependencies.ciContext);
  const ownerToken = createSingleRunOwnerToken(dependencies.createOwnerToken);
  await mkdir(path.dirname(guardFilePath), { recursive: true });

  try {
    // Write the guard file atomically with O_EXCL semantics instead of checking first, so concurrent
    // action invocations racing within the same CI job cannot both observe the guard as absent.
    await writeFile(
      guardFilePath,
      `${createSingleRunGuardContents(dependencies.ciContext, ownerToken)}\n`,
      {
        encoding: 'utf8',
        flag: 'wx',
      },
    );
  } catch (error: unknown) {
    if (isAlreadyExistsError(error)) {
      persistSingleRunPostState(dependencies.saveState, null, true);
      return {
        accepted: false,
        message:
          'This action may run only once per CI job. Another Apache Buildish Mammoth Cache for Gradle invocation already claimed this job, so this duplicate usage is rejected and its post action will be skipped.',
      };
    }

    throw new Error(
      `Unable to create the per-job single-run guard at '${guardFilePath}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  persistSingleRunPostState(dependencies.saveState, ownerToken, false);
  return {
    accepted: true,
    message:
      'Claimed Apache Buildish Mammoth Cache for Gradle single-run ownership for this CI job.',
  };
}

export function decideSingleRunPostExecution(
  dependencies: Pick<JobSingleRunDependencies, 'getState'> = {},
): JobSingleRunPostDecision {
  const getState = dependencies.getState ?? (() => '');
  if (getState(JOB_SINGLE_RUN_DUPLICATE_STATE) === 'true') {
    return {
      shouldRun: false,
      message:
        'Skipping post action for this Apache Buildish Mammoth Cache for Gradle invocation because its main step was rejected as a duplicate usage in the same CI job.',
    };
  }

  if (getState(JOB_SINGLE_RUN_OWNER_TOKEN_STATE).trim().length === 0) {
    return {
      shouldRun: false,
      message:
        'Skipping post action because this Apache Buildish Mammoth Cache for Gradle invocation did not claim single-run ownership for the current CI job.',
    };
  }

  return {
    shouldRun: true,
    message:
      'Running post action for the owning Apache Buildish Mammoth Cache for Gradle invocation in this CI job.',
  };
}

export function resolveSingleRunGuardFilePath(ciContext: JobSingleRunCiIdentity): string {
  const guardRoot = resolveGuardRoot(ciContext);
  const jobIdentity = [
    normalizeJobIdentityPart(ciContext.repository, 'unknown-repository'),
    normalizeJobIdentityPart(ciContext.workflowName, 'unknown-workflow'),
    normalizeJobIdentityPart(ciContext.jobName, 'unknown-job'),
    normalizeOptionalIntegerIdentityPart(ciContext.runId, 'unknown-run-id'),
    normalizeOptionalIntegerIdentityPart(ciContext.runAttempt, 'unknown-run-attempt'),
  ].join('\n');
  const guardFileName = `${createHash('sha256').update(jobIdentity).digest('hex')}.json`;

  return path.join(path.resolve(guardRoot), JOB_SINGLE_RUN_DIRECTORY, guardFileName);
}

function createSingleRunGuardContents(
  ciContext: JobSingleRunCiIdentity,
  ownerToken: string,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    repository: normalizeJobIdentityPart(ciContext.repository, 'unknown-repository'),
    workflowName: normalizeJobIdentityPart(ciContext.workflowName, 'unknown-workflow'),
    jobName: normalizeJobIdentityPart(ciContext.jobName, 'unknown-job'),
    runId: normalizeOptionalIntegerIdentityPart(ciContext.runId, 'unknown-run-id'),
    runAttempt: normalizeOptionalIntegerIdentityPart(ciContext.runAttempt, 'unknown-run-attempt'),
    ownerToken,
  });
}

function createSingleRunOwnerToken(createOwnerToken: (() => string) | undefined): string {
  const ownerToken = (createOwnerToken ?? randomUUID)().trim();
  if (ownerToken.length === 0) {
    throw new Error('Job single-run owner tokens must not be empty.');
  }
  return ownerToken;
}

function resolveGuardRoot(ciContext: JobSingleRunCiIdentity): string {
  const tempDirectory = ciContext.tempDirectory?.trim();
  return path.resolve(tempDirectory && tempDirectory.length > 0 ? tempDirectory : os.tmpdir());
}

function normalizeJobIdentityPart(value: string, fallback: string): string {
  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : fallback;
}

function normalizeOptionalIntegerIdentityPart(value: number | null, fallback: string): string {
  return value === null ? fallback : String(value);
}

function persistSingleRunPostState(
  saveState: (name: string, value: string) => void,
  ownerToken: string | null,
  duplicate: boolean,
): void {
  saveState(JOB_SINGLE_RUN_DUPLICATE_STATE, duplicate ? 'true' : 'false');
  saveState(JOB_SINGLE_RUN_OWNER_TOKEN_STATE, ownerToken ?? '');
}

function isAlreadyExistsError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
}
