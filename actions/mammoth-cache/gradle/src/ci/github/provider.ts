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

import type { CoreExecutionPhase } from '../../core/lifecycle';
import type { CiJobContext, CiPlatformAdapter, HttpHeadersByHost } from '../types';

export interface GitHubPlatformOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly eventPayload?: Record<string, unknown>;
  readonly eventPayloadReader?: (eventPath: string) => string;
  readonly githubTokenInput?: string;
  readonly githubJobCheckRunId?: string;
}

export function createGitHubPlatform(options: GitHubPlatformOptions = {}): CiPlatformAdapter {
  const env = options.env ?? process.env;
  const context = createGitHubContext({
    env,
    eventPayload: options.eventPayload,
    eventPayloadReader: options.eventPayloadReader,
  });
  const executionUrls = createGitHubExecutionUrls(context, env, options.githubJobCheckRunId);
  const httpHeadersByHost = createGitHubHttpHeadersByHost(env, options.githubTokenInput);

  return {
    context,
    executionUrls,
    httpHeadersByHost,
    createBootstrapDiagnosticsLines(phase: CoreExecutionPhase): readonly string[] {
      if (phase !== 'prepare') {
        return [];
      }

      return [
        `GitHub input 'github-token' present: ${options.githubTokenInput && options.githubTokenInput.trim().length > 0 ? 'yes' : 'no'}.`,
        `GitHub environment 'GITHUB_TOKEN' available: ${env.GITHUB_TOKEN && env.GITHUB_TOKEN.trim().length > 0 ? 'yes' : 'no'}.`,
        `GitHub input 'github-job-check-run-id': ${options.githubJobCheckRunId && options.githubJobCheckRunId.trim().length > 0 ? options.githubJobCheckRunId.trim() : 'unset'}.`,
      ];
    },
  };
}

export const createGitHubCiProvider = createGitHubPlatform;

export interface GitHubContextOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly eventPayload?: Record<string, unknown>;
  readonly eventPayloadReader?: (eventPath: string) => string;
}

export function createGitHubContext(options: GitHubContextOptions = {}): CiJobContext {
  const env = options.env ?? process.env;
  const eventPayload = readGitHubEventPayload(
    env,
    options.eventPayload,
    options.eventPayloadReader,
  );
  const eventName =
    env.BUILDISH_MAMMOTH_CACHE_GITHUB_EVENT_NAME_OVERRIDE?.trim() ||
    env.GITHUB_EVENT_NAME?.trim() ||
    'unknown';
  const defaultBranch = resolveDefaultBranch(env, eventPayload);
  const refName = resolveGitHubRefName(env, eventName, eventPayload);
  const safeRefName = sanitizeRefName(refName);

  return {
    eventName,
    resolvedRefName: refName,
    safeRefName,
    runnerOs: (env.RUNNER_OS?.trim() || 'linux').toLowerCase(),
    runnerArch: normalizeRunnerArch(env.RUNNER_ARCH),
    defaultBranch,
    isPullRequest: eventName === 'pull_request' || eventName === 'pull_request_target',
    repository: env.GITHUB_REPOSITORY?.trim() || 'unknown/unknown',
    workflowName: env.GITHUB_WORKFLOW?.trim() || 'unknown-workflow',
    jobName:
      env.BUILDISH_MAMMOTH_CACHE_GITHUB_JOB_NAME_OVERRIDE?.trim() ||
      env.GITHUB_JOB?.trim() ||
      'unknown-job',
    runId: parseOptionalNumber(env.GITHUB_RUN_ID),
    runAttempt: parseOptionalNumber(env.GITHUB_RUN_ATTEMPT),
    tempDirectory: normalizeOptionalPath(env.RUNNER_TEMP),
    workspace: normalizeWorkspace(env.GITHUB_WORKSPACE),
    actionPath: normalizeOptionalPath(env.GITHUB_ACTION_PATH),
  };
}

function createGitHubExecutionUrls(
  context: CiJobContext,
  env: NodeJS.ProcessEnv,
  githubJobCheckRunId: string | undefined,
) {
  const serverUrl = (env.GITHUB_SERVER_URL?.trim() || 'https://github.com').replace(/\/+$/u, '');
  const repository = context.repository;
  const runId = context.runId;
  const jobCheckRunId =
    githubJobCheckRunId?.trim() || env.BUILDISH_GITHUB_JOB_CHECK_RUN_ID?.trim() || '';

  if (!repository || runId === null) {
    return {
      jobUrl: null,
      workflowRunUrl: null,
    };
  }

  const workflowRunUrl = `${serverUrl}/${repository}/actions/runs/${runId}`;
  const workflowAttemptUrl =
    context.runAttempt !== null
      ? `${workflowRunUrl}/attempts/${context.runAttempt}`
      : workflowRunUrl;

  return {
    jobUrl:
      jobCheckRunId.length > 0 ? `${workflowRunUrl}/job/${jobCheckRunId}` : workflowAttemptUrl,
    workflowRunUrl: workflowAttemptUrl,
  };
}

function createGitHubHttpHeadersByHost(
  env: NodeJS.ProcessEnv,
  githubTokenInput: string | undefined,
): HttpHeadersByHost {
  const inputToken = githubTokenInput?.trim() || '';
  const envToken = env.GITHUB_TOKEN?.trim() || '';
  const token = inputToken || envToken;
  if (!token) {
    return new Map();
  }

  const apiUrl = env.GITHUB_API_URL?.trim() || 'https://api.github.com';
  const host = safeHttpsHost(apiUrl);
  if (!host) {
    return new Map();
  }

  return new Map([
    [
      host,
      new Map([
        ['accept', 'application/vnd.github.raw'],
        ['authorization', `Bearer ${token}`],
        ['user-agent', 'apache-buildish-mammoth-cache-gradle-action'],
        ['x-github-api-version', '2022-11-28'],
      ]),
    ],
  ]);
}

function readGitHubEventPayload(
  env: NodeJS.ProcessEnv,
  providedEventPayload: Record<string, unknown> | undefined,
  eventPayloadReader: ((eventPath: string) => string) | undefined,
): Record<string, unknown> {
  if (providedEventPayload) {
    return providedEventPayload;
  }

  const eventPath = env.GITHUB_EVENT_PATH?.trim();
  if (!eventPath) {
    return {};
  }

  const reader = eventPayloadReader;
  if (!reader) {
    return {};
  }

  try {
    const parsed = JSON.parse(reader(eventPath));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resolveGitHubRefName(
  env: NodeJS.ProcessEnv,
  eventName: string,
  eventPayload: Record<string, unknown>,
): string {
  const explicitRefOverride = env.BUILDISH_MAMMOTH_CACHE_GITHUB_RESOLVED_REF_NAME_OVERRIDE?.trim();
  if (explicitRefOverride) {
    return explicitRefOverride;
  }

  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const pullRequest = isRecord(eventPayload.pull_request) ? eventPayload.pull_request : undefined;
    const base = pullRequest && isRecord(pullRequest.base) ? pullRequest.base : undefined;
    const baseRef = typeof base?.ref === 'string' ? base.ref.trim() : '';
    if (baseRef) {
      return baseRef;
    }
  }

  const explicitRefName = env.GITHUB_REF_NAME?.trim();
  if (explicitRefName) {
    return explicitRefName;
  }

  const ref = env.GITHUB_REF?.trim();
  if (!ref) {
    return resolveDefaultBranch(env, eventPayload);
  }

  if (ref.startsWith('refs/heads/')) {
    return ref.slice('refs/heads/'.length);
  }
  if (ref.startsWith('refs/tags/')) {
    return ref.slice('refs/tags/'.length);
  }
  if (ref.startsWith('refs/pull/')) {
    return ref
      .replace(/^refs\/pull\//u, '')
      .replace(/\/merge$/u, '')
      .replace(/\/head$/u, '');
  }

  return ref;
}

function resolveDefaultBranch(
  env: NodeJS.ProcessEnv,
  eventPayload: Record<string, unknown>,
): string {
  const explicitDefaultBranch = env.BUILDISH_MAMMOTH_CACHE_GITHUB_DEFAULT_BRANCH_OVERRIDE?.trim();
  if (explicitDefaultBranch) {
    return explicitDefaultBranch;
  }

  const repo = isRecord(eventPayload.repository) ? eventPayload.repository : undefined;
  const defaultBranch = typeof repo?.default_branch === 'string' ? repo.default_branch.trim() : '';
  return defaultBranch || env.GITHUB_DEFAULT_BRANCH?.trim() || 'main';
}

function normalizeRunnerArch(value: string | undefined): string {
  const normalized = (value?.trim() || 'x64').toLowerCase();
  switch (normalized) {
    case 'amd64':
    case 'x86_64':
      return 'x64';
    case 'aarch64':
      return 'arm64';
    default:
      return normalized;
  }
}

function normalizeWorkspace(workspace: string | undefined): string {
  const normalized = normalizeOptionalPath(workspace);
  return normalized ?? process.cwd();
}

function normalizeOptionalPath(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function parseOptionalNumber(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeRefName(refName: string): string {
  const trimmed = refName.trim();
  if (!trimmed) {
    return 'unknown-ref';
  }

  const sanitized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 64)
    .replace(/^-|-$/gu, '');

  return sanitized || 'unknown-ref';
}

function safeHttpsHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
