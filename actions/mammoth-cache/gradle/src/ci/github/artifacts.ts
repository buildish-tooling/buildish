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

import artifactClient, { type ArtifactClient } from '@actions/artifact';

import type { WorkflowArtifactApi, WorkflowArtifactDescriptor } from '../../artifacts/service';

export function createGitHubWorkflowArtifactApi(
  client: ArtifactClient = artifactClient,
): WorkflowArtifactApi {
  return {
    async uploadArtifact(name, files, rootDirectory, options) {
      const response = await client.uploadArtifact(name, [...files], rootDirectory, options);

      if (!response.id || typeof response.size !== 'number') {
        throw new Error(
          `Artifact upload for '${name}' did not return a valid artifact identifier.`,
        );
      }

      return {
        id: response.id,
        name,
        size: response.size,
        digest: response.digest ?? null,
      };
    },
    async listArtifacts(options) {
      const response = await client.listArtifacts({
        latest: options?.latest,
        findBy: options?.findBy,
      });

      return response.artifacts.map(toArtifactDescriptor);
    },
    async getArtifact(name, options) {
      const response = await client.getArtifact(
        name,
        options?.findBy ? { findBy: options.findBy } : undefined,
      );
      return toArtifactDescriptor(response.artifact);
    },
    async downloadArtifact(artifactId, options) {
      const response = await client.downloadArtifact(artifactId, {
        path: options?.path,
        expectedHash: options?.expectedHash,
        findBy: options?.findBy,
      });

      if (!response.downloadPath) {
        throw new Error(`Artifact download for id '${artifactId}' did not return a download path.`);
      }

      return {
        downloadPath: response.downloadPath,
        digestMismatch: response.digestMismatch ?? false,
      };
    },
    async deleteArtifact(name, options) {
      await client.deleteArtifact(name, options?.findBy ? { findBy: options.findBy } : undefined);
    },
  };
}

function toArtifactDescriptor(artifact: {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly digest?: string;
}): WorkflowArtifactDescriptor {
  return {
    id: artifact.id,
    name: artifact.name,
    size: artifact.size,
    digest: artifact.digest ?? null,
  };
}
