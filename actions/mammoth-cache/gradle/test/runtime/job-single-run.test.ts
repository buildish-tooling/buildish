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

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  claimSingleRunJobInvocation,
  decideSingleRunPostExecution,
  JOB_SINGLE_RUN_DUPLICATE_STATE,
  JOB_SINGLE_RUN_OWNER_TOKEN_STATE,
  resolveSingleRunGuardFilePath,
} from '../../src/runtime/job-single-run';

describe('job single-run guard', () => {
  it('accepts the first invocation, rejects the second, and suppresses duplicate post execution', async () => {
    await withRunnerTemp(async (runnerTemp) => {
      const env = createGitHubEnv(runnerTemp);
      const ownerState = new Map<string, string>();
      const duplicateState = new Map<string, string>();

      await expect(
        claimSingleRunJobInvocation({
          env,
          saveState: ownerState.set.bind(ownerState),
          createOwnerToken: () => 'owner-token-a',
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          accepted: true,
        }),
      );

      await expect(
        claimSingleRunJobInvocation({
          env,
          saveState: duplicateState.set.bind(duplicateState),
          createOwnerToken: () => 'owner-token-b',
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          accepted: false,
        }),
      );

      expect(ownerState.get(JOB_SINGLE_RUN_DUPLICATE_STATE)).toBe('false');
      expect(ownerState.get(JOB_SINGLE_RUN_OWNER_TOKEN_STATE)).toBe('owner-token-a');
      expect(duplicateState.get(JOB_SINGLE_RUN_DUPLICATE_STATE)).toBe('true');
      expect(duplicateState.get(JOB_SINGLE_RUN_OWNER_TOKEN_STATE)).toBe('');
      await expect(readFile(resolveSingleRunGuardFilePath(env), 'utf8')).resolves.toContain(
        'owner-token-a',
      );

      expect(
        decideSingleRunPostExecution({
          getState: (name: string) => ownerState.get(name) ?? '',
        }),
      ).toEqual(
        expect.objectContaining({
          shouldRun: true,
        }),
      );
      expect(
        decideSingleRunPostExecution({
          getState: (name: string) => duplicateState.get(name) ?? '',
        }),
      ).toEqual(
        expect.objectContaining({
          shouldRun: false,
        }),
      );
    });
  });

  it('uses the workflow attempt as part of the per-job guard identity', async () => {
    await withRunnerTemp(async (runnerTemp) => {
      const firstAttemptState = new Map<string, string>();
      const secondAttemptState = new Map<string, string>();

      await expect(
        claimSingleRunJobInvocation({
          env: createGitHubEnv(runnerTemp, { GITHUB_RUN_ATTEMPT: '1' }),
          saveState: firstAttemptState.set.bind(firstAttemptState),
          createOwnerToken: () => 'attempt-1',
        }),
      ).resolves.toEqual(expect.objectContaining({ accepted: true }));

      await expect(
        claimSingleRunJobInvocation({
          env: createGitHubEnv(runnerTemp, { GITHUB_RUN_ATTEMPT: '2' }),
          saveState: secondAttemptState.set.bind(secondAttemptState),
          createOwnerToken: () => 'attempt-2',
        }),
      ).resolves.toEqual(expect.objectContaining({ accepted: true }));

      expect(firstAttemptState.get(JOB_SINGLE_RUN_OWNER_TOKEN_STATE)).toBe('attempt-1');
      expect(secondAttemptState.get(JOB_SINGLE_RUN_OWNER_TOKEN_STATE)).toBe('attempt-2');
    });
  });

  it('skips post execution when no main-phase ownership state was persisted', () => {
    expect(decideSingleRunPostExecution({ getState: () => '' })).toEqual(
      expect.objectContaining({
        shouldRun: false,
      }),
    );
  });
});

function createGitHubEnv(
  runnerTemp: string,
  overrides: Partial<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  return {
    RUNNER_TEMP: runnerTemp,
    GITHUB_REPOSITORY: 'apache/buildish',
    GITHUB_WORKFLOW: 'CI',
    GITHUB_JOB: 'check',
    GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '1',
    ...overrides,
  };
}

async function withRunnerTemp(testBody: (runnerTemp: string) => Promise<void>): Promise<void> {
  const runnerTemp = await mkdtemp(
    path.join(os.tmpdir(), 'buildish-mammoth-cache-gradle-job-single-run-'),
  );
  try {
    await testBody(runnerTemp);
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
}
