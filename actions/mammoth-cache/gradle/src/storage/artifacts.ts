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

/** Cross-execution lookup scope used by artifact backends when reads must escape the current run. */
export interface ArtifactLookupScope {
  /** Backend credential/token used for the lookup. */
  readonly token: string;
  /** Provider-defined run or pipeline execution identifier. */
  readonly runId: number;
  /** Repository slug in `owner/name` form. */
  readonly repository: string;
}

/** Optional lookup scoping for artifact backend operations. */
export interface ArtifactLookupOptions {
  readonly scope?: ArtifactLookupScope;
}

/** Minimal provider-neutral artifact descriptor returned by the storage layer. */
export interface WorkflowArtifactDescriptor {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly digest: string | null;
}

/** Download options shared by artifact backends. */
export interface WorkflowArtifactDownloadOptions extends ArtifactLookupOptions {
  readonly path?: string;
  readonly expectedHash?: string;
}

/** Download result returned by artifact backends. */
export interface WorkflowArtifactDownloadResult {
  readonly downloadPath: string;
  readonly digestMismatch: boolean;
}

/** Provider-neutral artifact backend used by the distributed cache flow. */
export interface WorkflowArtifactBackend {
  uploadArtifact(
    name: string,
    files: readonly string[],
    rootDirectory: string,
    options?: {
      readonly retentionDays?: number;
      readonly compressionLevel?: number;
    },
  ): Promise<WorkflowArtifactDescriptor>;
  listArtifacts(
    options?: ArtifactLookupOptions & { readonly latest?: boolean },
  ): Promise<readonly WorkflowArtifactDescriptor[]>;
  getArtifact(name: string, options?: ArtifactLookupOptions): Promise<WorkflowArtifactDescriptor>;
  downloadArtifact(
    artifactId: number,
    options?: WorkflowArtifactDownloadOptions,
  ): Promise<WorkflowArtifactDownloadResult>;
  deleteArtifact(name: string, options?: ArtifactLookupOptions): Promise<void>;
}
