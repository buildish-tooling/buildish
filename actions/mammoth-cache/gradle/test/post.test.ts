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

const coreMock = vi.hoisted(() => ({
  getState: vi.fn(() => 'persisted-state'),
  info: vi.fn(),
  setFailed: vi.fn(),
  warning: vi.fn(),
}));

const postFlowMock = vi.hoisted(() => ({
  executePostAction: vi.fn(async () => ({
    bootstrap: { baseCacheResult: null },
    consumedDeltaCleanupResult: null,
    deltaArtifactResult: null,
    message: 'Post action flow completed.',
  })),
}));

const jobSingleRunMock = vi.hoisted(() => ({
  decideSingleRunPostExecution: vi.fn(() => ({
    shouldRun: true,
    message: 'Run post action.',
  })),
}));

vi.mock('@actions/core', () => coreMock);
vi.mock('../src/post-flow', () => postFlowMock);
vi.mock('../src/runtime/job-single-run', () => jobSingleRunMock);

describe('post entrypoint', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('loads persisted action state when deciding and executing post work', async () => {
    await import('../src/post');

    expect(jobSingleRunMock.decideSingleRunPostExecution).toHaveBeenCalledWith({
      getState: coreMock.getState,
    });
    expect(postFlowMock.executePostAction).toHaveBeenCalledWith({
      getState: coreMock.getState,
    });
  });
});
