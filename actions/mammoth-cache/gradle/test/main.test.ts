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

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runMain, type MainEntrypointDependencies } from '../src/main';

const mainFlowMock = vi.hoisted(() => ({
  createMainActionOutputs: vi.fn(() => ({ 'cache-key': 'cache-key-value' })),
  executeMainAction: vi.fn(async () => ({
    bootstrap: { baseCacheResult: null },
    dependentDeltaResult: null,
    message: 'Prepare execution completed.',
    preBuildManifestState: null,
  })),
}));

const jobSingleRunMock = vi.hoisted(() => ({
  claimSingleRunPrepareExecution: vi.fn(async () => ({
    accepted: true,
    message: 'Claimed ownership.',
  })),
}));

vi.mock('../src/main-flow', () => mainFlowMock);
vi.mock('../src/runtime/job-single-run', () => jobSingleRunMock);

describe('main entrypoint', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('persists single-run ownership state for the post action', async () => {
    const runtimeHost = {
      getInput: vi.fn(() => ''),
      getState: vi.fn(() => ''),
      saveState: vi.fn(),
      setOutput: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      setFailed: vi.fn(),
    };
    const ciProvider = {
      context: {
        eventName: 'push',
        resolvedRefName: 'main',
        safeRefName: 'main',
        runnerOs: 'linux',
        runnerArch: 'x64',
        defaultBranch: 'main',
        isPullRequest: false,
        repository: 'apache/buildish',
        workflowName: 'CI',
        jobName: 'test',
        runId: 123,
        runAttempt: 1,
        tempDirectory: '/tmp',
        workspace: '/workspace',
        actionPath: null,
      },
      httpHeadersByHost: new Map(),
      executionUrls: { jobUrl: null, workflowRunUrl: null },
      createBootstrapDiagnosticsLines: vi.fn(() => []),
      publishLogGroup: vi.fn(),
      publishSummary: vi.fn(async () => undefined),
      replaceSummary: vi.fn(async () => undefined),
    };
    const dependencies = {
      runtimeHost,
      ciProvider,
      env: process.env,
      cacheBackend: {} as MainEntrypointDependencies['cacheBackend'],
      artifactBackend: {} as MainEntrypointDependencies['artifactBackend'],
    } satisfies MainEntrypointDependencies;

    await runMain(dependencies);

    expect(jobSingleRunMock.claimSingleRunPrepareExecution).toHaveBeenCalledWith({
      ciContext: ciProvider.context,
      saveState: runtimeHost.saveState,
    });
    expect(mainFlowMock.executeMainAction).toHaveBeenCalledWith(dependencies);
    expect(runtimeHost.setOutput).toHaveBeenCalledWith('cache-key', 'cache-key-value');
  });
});
