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

import * as core from '@actions/core';
import * as fs from 'node:fs';
import * as os from 'node:os';

import { isRecord } from '../validation';
import type { CiJobContext, CiPlatformAdapter, HttpHeadersByHost, SummaryWriter } from './types';

const METADATA_PATTERN = /^[A-Za-z0-9._/-]{0,200}$/;
const DISPLAY_NAME_PATTERN = /^[A-Za-z0-9._ -]{0,100}$/;
const REF_NAME_PATTERN = /^[A-Za-z0-9._/ -]{1,100}$/;
const RUNNER_VALUE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const GITHUB_API_HOST = 'api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_API_ACCEPT = 'application/vnd.github.raw';
const ACTION_USER_AGENT = 'apache-buildish-mammoth-cache-gradle-action';
const EMPTY_HTTP_HEADERS_BY_HOST: HttpHeadersByHost = new Map();
const GITHUB_EVENT_NAME_OVERRIDE_ENV = 'BUILDISH_MAMMOTH_CACHE_GITHUB_EVENT_NAME_OVERRIDE';
const GITHUB_RESOLVED_REF_NAME_OVERRIDE_ENV =
  'BUILDISH_MAMMOTH_CACHE_GITHUB_RESOLVED_REF_NAME_OVERRIDE';
const GITHUB_DEFAULT_BRANCH_OVERRIDE_ENV = 'BUILDISH_MAMMOTH_CACHE_GITHUB_DEFAULT_BRANCH_OVERRIDE';
const GITHUB_JOB_NAME_OVERRIDE_ENV = 'BUILDISH_MAMMOTH_CACHE_GITHUB_JOB_NAME_OVERRIDE';

/**
 * Optional overrides used to build a deterministic GitHub adapter in tests.
 */
export interface GitHubPlatformOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly eventPayload?: Record<string, unknown>;
  readonly eventPayloadReader?: (eventPath: string) => string;
  readonly summaryWriter?: SummaryWriter;
  /**
   * Optional GitHub token used only for authenticated GitHub-host requests.
   *
   * This is intentionally kept out of the normalized action config and summaries so it never
   * becomes user-visible status data.
   */
  readonly githubToken?: string;
}

/**
 * Creates the GitHub-specific CI adapter used by the bootstrap layer.
 */
export function createGitHubPlatform(options: GitHubPlatformOptions = {}): CiPlatformAdapter {
  const env = options.env ?? process.env;
  const eventPayload =
    options.eventPayload ?? readGitHubEventPayload(env, options.eventPayloadReader ?? defaultRead);
  const summaryWriter = options.summaryWriter ?? core.summary;
  const context = createGitHubContext(env, eventPayload);
  const httpHeadersByHost = createGitHubHttpHeadersByHost(
    options.githubToken ?? env.GITHUB_TOKEN,
    env.GITHUB_API_URL,
  );

  return {
    context,
    httpHeadersByHost,
    publishLogGroup(
      title: string,
      lines: readonly string[],
      writeLine: (message: string) => void,
    ): void {
      if (lines.length === 0) {
        return;
      }

      writeLine(`::group::${title}`);
      try {
        for (const line of lines) {
          writeLine(line);
        }
      } finally {
        writeLine('::endgroup::');
      }
    },
    async publishSummary(lines: readonly string[]): Promise<void> {
      for (const line of lines) {
        summaryWriter.addRaw(line, true);
      }

      await summaryWriter.write();
    },
  };
}

export function createGitHubHttpHeadersByHost(
  githubToken: string | undefined,
  apiUrl: string | undefined = undefined,
): HttpHeadersByHost {
  const trimmedToken = githubToken?.trim();

  if (!trimmedToken) {
    return EMPTY_HTTP_HEADERS_BY_HOST;
  }

  const apiHost = normalizeApiHost(apiUrl);

  return new Map([
    [
      apiHost,
      new Map([
        ['accept', GITHUB_API_ACCEPT],
        ['authorization', `Bearer ${trimmedToken}`],
        ['user-agent', ACTION_USER_AGENT],
        ['x-github-api-version', GITHUB_API_VERSION],
      ]),
    ],
  ]);
}

function normalizeApiHost(apiUrl: string | undefined): string {
  const trimmedApiUrl = apiUrl?.trim();
  if (!trimmedApiUrl) {
    return GITHUB_API_HOST;
  }

  try {
    return new URL(trimmedApiUrl).hostname.toLowerCase();
  } catch {
    return GITHUB_API_HOST;
  }
}

/**
 * Normalizes GitHub environment variables and event payload fields into a provider-neutral
 * `CiJobContext`.
 */
export function createGitHubContext(
  env: NodeJS.ProcessEnv,
  eventPayload: Record<string, unknown>,
): CiJobContext {
  const eventName =
    (readNonEmptyEnvValue(env, GITHUB_EVENT_NAME_OVERRIDE_ENV) ?? env.GITHUB_EVENT_NAME?.trim()) ||
    'unknown';
  const defaultBranch =
    readNonEmptyEnvValue(env, GITHUB_DEFAULT_BRANCH_OVERRIDE_ENV) ||
    readNestedString(eventPayload, ['repository', 'default_branch']) ||
    env.GITHUB_BASE_REF?.trim() ||
    env.GITHUB_REF_NAME?.trim() ||
    'main';
  const resolvedRefName =
    readNonEmptyEnvValue(env, GITHUB_RESOLVED_REF_NAME_OVERRIDE_ENV) ||
    resolveGitHubRefName(eventName, env, eventPayload, defaultBranch);

  return {
    platform: 'github',
    eventName,
    resolvedRefName,
    safeRefName: sanitizeRefName(resolvedRefName),
    runnerOs: normalizeRunnerOs(env.RUNNER_OS),
    runnerArch: normalizeRunnerArch(env.RUNNER_ARCH),
    defaultBranch,
    isPullRequest: eventName === 'pull_request' || eventName === 'pull_request_target',
    repository: validateMetadataValue(env.GITHUB_REPOSITORY?.trim() || '', 'GITHUB_REPOSITORY'),
    workflowName: validateDisplayName(env.GITHUB_WORKFLOW?.trim() || '', 'GITHUB_WORKFLOW'),
    jobName: validateDisplayName(
      readNonEmptyEnvValue(env, GITHUB_JOB_NAME_OVERRIDE_ENV) ?? env.GITHUB_JOB?.trim() ?? '',
      'GITHUB_JOB',
    ),
    runId: parseOptionalInteger(env.GITHUB_RUN_ID, 'GITHUB_RUN_ID'),
    runAttempt: parseOptionalInteger(env.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT'),
    tempDirectory: env.RUNNER_TEMP?.trim() || null,
    workspace: env.GITHUB_WORKSPACE?.trim() || process.cwd(),
    actionPath: env.GITHUB_ACTION_PATH?.trim() || null,
  };
}

/**
 * Reads the GitHub event payload JSON if GitHub exposed one for the current run.
 */
function readGitHubEventPayload(
  env: NodeJS.ProcessEnv,
  eventPayloadReader: (eventPath: string) => string,
): Record<string, unknown> {
  const eventPath = env.GITHUB_EVENT_PATH?.trim();

  if (!eventPath) {
    return {};
  }

  const raw = eventPayloadReader(eventPath).trim();

  if (raw.length === 0) {
    return {};
  }

  const parsed = JSON.parse(raw);
  return isRecord(parsed) ? parsed : {};
}

/**
 * Resolves the logical branch name used for cache partitioning and read-only defaults.
 *
 * Pull requests use the base branch, while branch pushes and manual dispatches prefer the
 * triggering branch ref.
 */
function resolveGitHubRefName(
  eventName: string,
  env: NodeJS.ProcessEnv,
  eventPayload: Record<string, unknown>,
  defaultBranch: string,
): string {
  if (eventName === 'push') {
    return extractBranchRefName(env.GITHUB_REF, env.GITHUB_REF_NAME) || defaultBranch;
  }

  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    return (
      readNestedString(eventPayload, ['pull_request', 'base', 'ref']) ||
      env.GITHUB_BASE_REF?.trim() ||
      defaultBranch
    );
  }

  if (eventName === 'workflow_dispatch') {
    return (
      extractBranchRefName(env.GITHUB_REF, env.GITHUB_REF_NAME) ||
      env.GITHUB_REF_NAME?.trim() ||
      defaultBranch
    );
  }

  return defaultBranch;
}

/**
 * Extracts a branch name from GitHub's ref environment variables when one is available.
 */
function extractBranchRefName(
  ref: string | undefined,
  fallbackRefName: string | undefined,
): string | null {
  const trimmedRef = ref?.trim();

  if (trimmedRef?.startsWith('refs/heads/')) {
    return trimmedRef.slice('refs/heads/'.length);
  }

  const trimmedFallback = fallbackRefName?.trim();
  return trimmedFallback && !trimmedFallback.startsWith('refs/') ? trimmedFallback : null;
}

function readNonEmptyEnvValue(env: NodeJS.ProcessEnv, variableName: string): string | null {
  const value = env[variableName]?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * Produces a cache-safe ref name while preserving enough structure to remain human-readable.
 */
function sanitizeRefName(refName: string): string {
  const trimmed = refName.trim();

  if (!REF_NAME_PATTERN.test(trimmed)) {
    throw new Error(
      'Resolved Git reference name contains unsupported characters. Allowed characters are letters, numbers, space, dot, underscore, slash, and dash.',
    );
  }

  const safeRefName = trimmed
    .replace(/[ /]+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (safeRefName.length === 0) {
    throw new Error('Resolved Git reference name is empty after safety normalization.');
  }

  return safeRefName;
}

/**
 * Normalizes the runner operating system identifier into a lower-case cache-safe value.
 */
function normalizeRunnerOs(input: string | undefined): string {
  const normalizedInput = input?.trim().toLowerCase() || os.platform().toLowerCase();
  const runnerOs =
    normalizedInput === 'darwin' || normalizedInput === 'macos'
      ? 'macos'
      : normalizedInput === 'win32' || normalizedInput === 'windows'
        ? 'windows'
        : normalizedInput === 'linux'
          ? 'linux'
          : normalizedInput;

  return validateRunnerValue(runnerOs, 'runner operating system');
}

/**
 * Normalizes the runner architecture identifier into a lower-case cache-safe value.
 */
function normalizeRunnerArch(input: string | undefined): string {
  const normalizedInput = input?.trim().toLowerCase() || os.arch().toLowerCase();
  const runnerArch =
    normalizedInput === 'x86_64' || normalizedInput === 'amd64'
      ? 'x64'
      : normalizedInput === 'aarch64'
        ? 'arm64'
        : normalizedInput === 'i386' || normalizedInput === 'i686'
          ? 'x86'
          : normalizedInput;

  return validateRunnerValue(runnerArch, 'runner architecture');
}

function validateRunnerValue(value: string, label: string): string {
  if (!RUNNER_VALUE_PATTERN.test(value)) {
    throw new Error(`Resolved ${label} contains unsupported characters.`);
  }

  return value;
}

/**
 * Validates machine-oriented metadata such as repository identifiers.
 */
function validateMetadataValue(value: string, variableName: string): string {
  if (!METADATA_PATTERN.test(value)) {
    throw new Error(`${variableName} contains unsupported characters.`);
  }

  return value;
}

/**
 * Validates human-readable GitHub display fields like workflow and job names.
 */
function validateDisplayName(value: string, variableName: string): string {
  if (!DISPLAY_NAME_PATTERN.test(value)) {
    throw new Error(`${variableName} contains unsupported characters.`);
  }

  return value;
}

/**
 * Parses optional integer-valued GitHub metadata when present.
 */
function parseOptionalInteger(value: string | undefined, variableName: string): number | null {
  if (!value || value.trim().length === 0) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${variableName} must be a positive integer when set.`);
  }

  return parsed;
}

/**
 * Reads a nested string from the event payload without assuming the payload shape.
 */
function readNestedString(
  input: Record<string, unknown>,
  pathSegments: readonly string[],
): string | null {
  let current: unknown = input;

  for (const segment of pathSegments) {
    if (!isRecord(current) || !(segment in current)) {
      return null;
    }

    current = current[segment];
  }

  return typeof current === 'string' && current.trim().length > 0 ? current.trim() : null;
}

function defaultRead(eventPath: string): string {
  return fs.readFileSync(eventPath, 'utf8');
}
