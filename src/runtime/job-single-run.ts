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

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export const JOB_SINGLE_RUN_OWNER_TOKEN_STATE = 'cache-gradle-job-single-run-owner-token';
export const JOB_SINGLE_RUN_DUPLICATE_STATE = 'cache-gradle-job-single-run-duplicate';

const JOB_SINGLE_RUN_DIRECTORY = 'cache-gradle-job-guards';

export interface JobSingleRunDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly saveState?: (name: string, value: string) => void;
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
  dependencies: JobSingleRunDependencies = {},
): Promise<JobSingleRunClaimResult> {
  const guardFilePath = resolveSingleRunGuardFilePath(dependencies.env);
  const ownerToken = createSingleRunOwnerToken(dependencies.createOwnerToken);
  await mkdir(path.dirname(guardFilePath), { recursive: true });

  try {
    await writeFile(
      guardFilePath,
      `${createSingleRunGuardContents(dependencies.env, ownerToken)}\n`,
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
          'This action may run only once per GitHub job. Another cache-gradle invocation already claimed this job, so this duplicate usage is rejected and its post action will be skipped.',
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
    message: 'Claimed cache-gradle single-run ownership for this GitHub job.',
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
        'Skipping post action for this cache-gradle invocation because its main step was rejected as a duplicate usage in the same GitHub job.',
    };
  }

  if (getState(JOB_SINGLE_RUN_OWNER_TOKEN_STATE).trim().length === 0) {
    return {
      shouldRun: false,
      message:
        'Skipping post action because this cache-gradle invocation did not claim single-run ownership for the current GitHub job.',
    };
  }

  return {
    shouldRun: true,
    message: 'Running post action for the owning cache-gradle invocation in this GitHub job.',
  };
}

export function resolveSingleRunGuardFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const guardRoot = env.RUNNER_TEMP?.trim() || os.tmpdir();
  const jobIdentity = [
    env.GITHUB_REPOSITORY?.trim() || 'unknown-repository',
    env.GITHUB_WORKFLOW?.trim() || 'unknown-workflow',
    env.GITHUB_JOB?.trim() || 'unknown-job',
    env.GITHUB_RUN_ID?.trim() || 'unknown-run-id',
    env.GITHUB_RUN_ATTEMPT?.trim() || 'unknown-run-attempt',
  ].join('\n');
  const guardFileName = `${createHash('sha256').update(jobIdentity).digest('hex')}.json`;

  return path.join(path.resolve(guardRoot), JOB_SINGLE_RUN_DIRECTORY, guardFileName);
}

function createSingleRunGuardContents(
  env: NodeJS.ProcessEnv | undefined,
  ownerToken: string,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    repository: env?.GITHUB_REPOSITORY?.trim() || 'unknown-repository',
    workflowName: env?.GITHUB_WORKFLOW?.trim() || 'unknown-workflow',
    jobName: env?.GITHUB_JOB?.trim() || 'unknown-job',
    runId: env?.GITHUB_RUN_ID?.trim() || 'unknown-run-id',
    runAttempt: env?.GITHUB_RUN_ATTEMPT?.trim() || 'unknown-run-attempt',
    ownerToken,
  });
}

function createSingleRunOwnerToken(createOwnerToken: (() => string) | undefined): string {
  return (createOwnerToken ?? randomUUID)();
}

function persistSingleRunPostState(
  saveState: ((name: string, value: string) => void) | undefined,
  ownerToken: string | null,
  duplicate: boolean,
): void {
  const persist = saveState ?? (() => undefined);
  persist(JOB_SINGLE_RUN_DUPLICATE_STATE, duplicate ? 'true' : 'false');
  persist(JOB_SINGLE_RUN_OWNER_TOKEN_STATE, ownerToken ?? '');
}

function isAlreadyExistsError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
}
