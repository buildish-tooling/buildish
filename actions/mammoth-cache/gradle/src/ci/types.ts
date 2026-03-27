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

import type { CoreExecutionPhase } from '../core/lifecycle';

/**
 * Normalized CI metadata consumed by later cache and coordination code.
 *
 * The goal is to isolate provider-specific environment parsing in a single adapter layer.
 */
export interface CiJobContext {
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
  /** Numeric provider run/execution identifier, or `null` when unavailable. */
  readonly runId: number | null;
  /** Numeric retry/attempt count for the current provider run/execution, or `null` when unavailable. */
  readonly runAttempt: number | null;
  /** Absolute provider-managed temp directory for the current job, or `null` when unavailable. */
  readonly tempDirectory: string | null;
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
 * Exact-host HTTP headers that are safe to apply to outbound requests.
 *
 * Keys are lower-case host names without ports. Callers must only apply these headers to matching
 * HTTPS requests so credentials never bleed to unrelated endpoints.
 */
export type HttpHeadersByHost = ReadonlyMap<string, ReadonlyMap<string, string>>;

/**
 * Provider-generated links to the current job execution surfaces when available.
 */
export interface CiExecutionUrls {
  /** Direct link to the current job's logs/details view, or `null` when unavailable. */
  readonly jobUrl: string | null;
  /** Direct link to the current execution or run view, or `null` when unavailable. */
  readonly workflowRunUrl: string | null;
}

/**
 * Provider-neutral CI adapter surface used by the bootstrap flow.
 */
export interface CiPlatformAdapter {
  /** Normalized CI metadata for the current execution. */
  readonly context: CiJobContext;
  /** Optional exact-host HTTP headers, such as provider API auth headers derived from CI tokens. */
  readonly httpHeadersByHost: HttpHeadersByHost;
  /** Provider-generated execution URLs for the current job/run, when available. */
  readonly executionUrls: CiExecutionUrls;
  /** Emits provider-specific diagnostic lines for the given action phase. */
  createBootstrapDiagnosticsLines(phase: CoreExecutionPhase): readonly string[];
  /** Publishes the provided lines as a grouped log block using the provider-specific log surface. */
  publishLogGroup(
    title: string,
    lines: readonly string[],
    writeLine: (message: string) => void,
  ): void;
  /** Publishes the provided markdown lines to the provider summary surface. */
  publishSummary(lines: readonly string[]): Promise<void>;
  /** Replaces the current provider-managed summary content when supported. */
  replaceSummary(lines: readonly string[]): Promise<void>;
}
