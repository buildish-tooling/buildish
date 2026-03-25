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

/**
 * Normalized CI metadata consumed by later cache and coordination code.
 *
 * The goal is to isolate provider-specific environment parsing in a single adapter layer.
 */
export interface CiJobContext {
  readonly platform: 'github';
  readonly eventName: string;
  readonly resolvedRefName: string;
  readonly safeRefName: string;
  readonly runnerOs: string;
  readonly runnerArch: string;
  readonly defaultBranch: string;
  readonly isPullRequest: boolean;
  readonly repository: string;
  readonly workflowName: string;
  readonly jobName: string;
  readonly runId: number | null;
  readonly runAttempt: number | null;
  readonly workspace: string;
  readonly actionPath: string | null;
}

/**
 * Minimal interface for job summary writers.
 */
export interface SummaryWriter {
  addRaw(text: string, addEol?: boolean): SummaryWriter;
  write(): Promise<unknown>;
}

/**
 * Provider-neutral CI adapter surface used by the bootstrap flow.
 */
export interface CiPlatformAdapter {
  readonly context: CiJobContext;
  publishSummary(lines: readonly string[]): Promise<void>;
}
