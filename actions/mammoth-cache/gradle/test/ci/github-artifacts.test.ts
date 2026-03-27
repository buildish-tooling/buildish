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

import { describe, expect, it } from 'vitest';

import { createGitHubWorkflowArtifactBackend } from '../../src/ci/github';
import { STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES } from '../../src/storage/artifacts';

describe('createGitHubWorkflowArtifactBackend', () => {
  it('maps provider-neutral lookup scope to GitHub artifact findBy coordinates', async () => {
    const recorded: Record<string, unknown> = {};
    const client = {
      async uploadArtifact() {
        return { id: 1, size: 1, digest: 'sha256:test' };
      },
      async listArtifacts(options: unknown) {
        recorded.list = options;
        return { artifacts: [] };
      },
      async getArtifact(_name: string, options: unknown) {
        recorded.get = options;
        return { artifact: { id: 7, name: 'delta', size: 9, digest: 'sha256:test' } };
      },
      async downloadArtifact(_artifactId: number, options: unknown) {
        recorded.download = options;
        return { downloadPath: '/tmp/delta', digestMismatch: false };
      },
      async deleteArtifact(_name: string, options: unknown) {
        recorded.delete = options;
      },
    };

    const backend = createGitHubWorkflowArtifactBackend(client as never);
    const scope = { token: 'ghs_test', runId: 42, repository: 'apache/buildish' } as const;
    const findBy = {
      token: 'ghs_test',
      workflowRunId: 42,
      repositoryOwner: 'apache',
      repositoryName: 'buildish',
    };

    await backend.listArtifacts({ latest: true, scope });
    await backend.getArtifact('delta', { scope });
    await backend.downloadArtifact(7, { path: '/tmp/work', expectedHash: 'sha256:test', scope });
    await backend.deleteArtifact('delta', { scope });

    expect(backend.capabilities).toEqual(STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES);
    expect(recorded).toEqual({
      list: { latest: true, findBy },
      get: { findBy },
      download: { path: '/tmp/work', expectedHash: 'sha256:test', findBy },
      delete: { findBy },
    });
  });

  it('rejects invalid lookup-scope repository slugs', async () => {
    const backend = createGitHubWorkflowArtifactBackend({
      async uploadArtifact() {
        return { id: 1, size: 1 };
      },
      async listArtifacts() {
        return { artifacts: [] };
      },
      async getArtifact() {
        return { artifact: { id: 1, name: 'delta', size: 1 } };
      },
      async downloadArtifact() {
        return { downloadPath: '/tmp/delta' };
      },
      async deleteArtifact() {},
    } as never);

    await expect(
      backend.listArtifacts({
        scope: { token: 'ghs_test', runId: 42, repository: 'apache/buildish/extra' },
      }),
    ).rejects.toThrow("must use 'owner/name' form");
  });
});
