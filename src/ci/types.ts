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
  /** CI provider identifier. Currently only `github` is supported. */
  readonly platform: 'github';
  /** Raw event name from the CI provider, such as `push` or `pull_request`. */
  readonly eventName: string;
  /**
   * Best-effort human-readable ref name for the current execution.
   *
   * Examples include `main`, `feature/my-branch`, or a PR head/base ref depending on event type.
   */
  readonly resolvedRefName: string;
  /**
   * Cache-safe ref slug derived from `resolvedRefName`.
   *
   * This value is normalized for cache keys and summary output and should not contain slash-heavy or
   * otherwise unsafe raw ref formatting.
   */
  readonly safeRefName: string;
  /**
   * Normalized runner operating system, lower-cased by the CI adapter.
   *
   * Typical values include `linux`, `windows`, and `macos`.
   */
  readonly runnerOs: string;
  /**
   * Normalized runner CPU architecture, lower-cased by the CI adapter.
   *
   * Typical values include `x64`, `arm64`, and `x86`.
   */
  readonly runnerArch: string;
  /** Default branch name reported by the repository metadata, typically `main`. */
  readonly defaultBranch: string;
  /** Whether the current execution originates from a pull request event. */
  readonly isPullRequest: boolean;
  /** Repository slug in `owner/name` form. */
  readonly repository: string;
  /** Workflow display name as exposed by the provider. */
  readonly workflowName: string;
  /** Job name as exposed by the provider. */
  readonly jobName: string;
  /** Numeric workflow run identifier, or `null` when unavailable from the provider. */
  readonly runId: number | null;
  /** Numeric retry/attempt count for the workflow run, or `null` when unavailable. */
  readonly runAttempt: number | null;
  /** Absolute workspace directory for the current job. */
  readonly workspace: string;
  /** Absolute action checkout path, or `null` when the provider does not expose one. */
  readonly actionPath: string | null;
}

/**
 * Minimal interface for job summary writers.
 */
export interface SummaryWriter {
  /** Appends raw text to the job summary buffer. */
  addRaw(text: string, addEol?: boolean): SummaryWriter;
  /** Flushes the accumulated summary content to the provider. */
  write(): Promise<unknown>;
}

/**
 * Provider-neutral CI adapter surface used by the bootstrap flow.
 */
export interface CiPlatformAdapter {
  /** Normalized CI metadata for the current execution. */
  readonly context: CiJobContext;
  /** Publishes the provided markdown lines to the provider summary surface. */
  publishSummary(lines: readonly string[]): Promise<void>;
}
