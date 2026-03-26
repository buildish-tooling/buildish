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
  info: vi.fn(),
  saveState: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  warning: vi.fn(),
}));

const mainFlowMock = vi.hoisted(() => ({
  createMainActionOutputs: vi.fn(() => ({ 'cache-key': 'cache-key-value' })),
  executeMainAction: vi.fn(async () => ({
    bootstrap: { baseCacheResult: null },
    dependentDeltaResult: null,
    message: 'Main action flow completed.',
    preBuildManifestState: null,
  })),
}));

const jobSingleRunMock = vi.hoisted(() => ({
  claimSingleRunJobInvocation: vi.fn(async () => ({
    accepted: true,
    message: 'Claimed ownership.',
  })),
}));

vi.mock('@actions/core', () => coreMock);
vi.mock('../src/main-flow', () => mainFlowMock);
vi.mock('../src/runtime/job-single-run', () => jobSingleRunMock);

describe('main entrypoint', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('persists single-run ownership state for the post action', async () => {
    await import('../src/main');

    expect(jobSingleRunMock.claimSingleRunJobInvocation).toHaveBeenCalledWith({
      saveState: coreMock.saveState,
    });
  });
});
