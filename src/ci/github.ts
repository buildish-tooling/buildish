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

import * as core from '@actions/core';
import * as fs from 'node:fs';

import type { CiJobContext, CiPlatformAdapter, SummaryWriter } from './types';

const METADATA_PATTERN = /^[A-Za-z0-9._/-]{0,200}$/;
const DISPLAY_NAME_PATTERN = /^[A-Za-z0-9._ -]{0,100}$/;
const REF_NAME_PATTERN = /^[A-Za-z0-9._/ -]{1,100}$/;

export interface GitHubPlatformOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly eventPayload?: Record<string, unknown>;
  readonly eventPayloadReader?: (eventPath: string) => string;
  readonly summaryWriter?: SummaryWriter;
}

export function createGitHubPlatform(options: GitHubPlatformOptions = {}): CiPlatformAdapter {
  const env = options.env ?? process.env;
  const eventPayload =
    options.eventPayload ?? readGitHubEventPayload(env, options.eventPayloadReader ?? defaultRead);
  const summaryWriter = options.summaryWriter ?? core.summary;
  const context = createGitHubContext(env, eventPayload);

  return {
    context,
    async publishSummary(lines: readonly string[]): Promise<void> {
      for (const line of lines) {
        summaryWriter.addRaw(line, true);
      }

      await summaryWriter.write();
    },
  };
}

export function createGitHubContext(
  env: NodeJS.ProcessEnv,
  eventPayload: Record<string, unknown>,
): CiJobContext {
  const eventName = env.GITHUB_EVENT_NAME?.trim() || 'unknown';
  const defaultBranch =
    readNestedString(eventPayload, ['repository', 'default_branch']) ||
    env.GITHUB_BASE_REF?.trim() ||
    env.GITHUB_REF_NAME?.trim() ||
    'main';
  const resolvedRefName = resolveGitHubRefName(eventName, env, eventPayload, defaultBranch);

  return {
    platform: 'github',
    eventName,
    resolvedRefName,
    safeRefName: sanitizeRefName(resolvedRefName),
    defaultBranch,
    isPullRequest: eventName === 'pull_request' || eventName === 'pull_request_target',
    repository: validateMetadataValue(env.GITHUB_REPOSITORY?.trim() || '', 'GITHUB_REPOSITORY'),
    workflowName: validateDisplayName(env.GITHUB_WORKFLOW?.trim() || '', 'GITHUB_WORKFLOW'),
    jobName: validateDisplayName(env.GITHUB_JOB?.trim() || '', 'GITHUB_JOB'),
    runId: parseOptionalInteger(env.GITHUB_RUN_ID, 'GITHUB_RUN_ID'),
    runAttempt: parseOptionalInteger(env.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT'),
    workspace: env.GITHUB_WORKSPACE?.trim() || process.cwd(),
    actionPath: env.GITHUB_ACTION_PATH?.trim() || null,
  };
}

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

function validateMetadataValue(value: string, variableName: string): string {
  if (!METADATA_PATTERN.test(value)) {
    throw new Error(`${variableName} contains unsupported characters.`);
  }

  return value;
}

function validateDisplayName(value: string, variableName: string): string {
  if (!DISPLAY_NAME_PATTERN.test(value)) {
    throw new Error(`${variableName} contains unsupported characters.`);
  }

  return value;
}

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

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function defaultRead(eventPath: string): string {
  return fs.readFileSync(eventPath, 'utf8');
}
