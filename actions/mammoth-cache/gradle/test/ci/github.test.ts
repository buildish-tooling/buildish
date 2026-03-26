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

import { createGitHubContext, createGitHubPlatform } from '../../src/ci/github';
import type { SummaryWriter } from '../../src/ci/types';

describe('createGitHubContext', () => {
  it('resolves push refs from branch refs', () => {
    const context = createGitHubContext(
      {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/feature/cache-improvements',
        GITHUB_REPOSITORY: 'apache/buildish',
        GITHUB_WORKFLOW: 'CI',
        GITHUB_JOB: 'check',
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
      },
      {
        repository: { default_branch: 'main' },
      },
    );

    expect(context.resolvedRefName).toBe('feature/cache-improvements');
    expect(context.safeRefName).toBe('feature-cache-improvements');
    expect(context.runnerOs).toBe('linux');
    expect(context.runnerArch).toBe('x64');
  });

  it('uses the pull request base branch for pull_request events', () => {
    const context = createGitHubContext(
      {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REPOSITORY: 'apache/buildish',
        GITHUB_WORKFLOW: 'CI',
        GITHUB_JOB: 'check',
      },
      {
        repository: { default_branch: 'main' },
        pull_request: { base: { ref: 'release/1.0' } },
      },
    );

    expect(context.isPullRequest).toBe(true);
    expect(context.resolvedRefName).toBe('release/1.0');
  });

  it('treats pull_request_target like a pull request for ref resolution and trust checks', () => {
    const context = createGitHubContext(
      {
        GITHUB_EVENT_NAME: 'pull_request_target',
        GITHUB_REPOSITORY: 'apache/buildish',
        GITHUB_WORKFLOW: 'CI',
        GITHUB_JOB: 'check',
      },
      {
        repository: { default_branch: 'main' },
        pull_request: { base: { ref: 'stable/2.x' } },
      },
    );

    expect(context.isPullRequest).toBe(true);
    expect(context.resolvedRefName).toBe('stable/2.x');
    expect(context.safeRefName).toBe('stable-2.x');
  });

  it('uses the triggering branch for workflow_dispatch events', () => {
    const context = createGitHubContext(
      {
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF: 'refs/heads/release/2026.03',
        GITHUB_REPOSITORY: 'apache/buildish',
        GITHUB_WORKFLOW: 'CI',
        GITHUB_JOB: 'check',
      },
      {
        repository: { default_branch: 'main' },
      },
    );

    expect(context.isPullRequest).toBe(false);
    expect(context.resolvedRefName).toBe('release/2026.03');
    expect(context.safeRefName).toBe('release-2026.03');
  });

  it('honors caller-context overrides for reusable workflow runs', () => {
    const context = createGitHubContext(
      {
        GITHUB_EVENT_NAME: 'workflow_call',
        GITHUB_REPOSITORY: 'apache/buildish',
        GITHUB_WORKFLOW: 'CI',
        GITHUB_JOB: 'check',
        BUILDISH_MAMMOTH_CACHE_GITHUB_EVENT_NAME_OVERRIDE: 'pull_request',
        BUILDISH_MAMMOTH_CACHE_GITHUB_RESOLVED_REF_NAME_OVERRIDE: 'release/1.1',
        BUILDISH_MAMMOTH_CACHE_GITHUB_DEFAULT_BRANCH_OVERRIDE: 'main',
      },
      {
        repository: { default_branch: 'ignored-default' },
      },
    );

    expect(context.eventName).toBe('pull_request');
    expect(context.isPullRequest).toBe(true);
    expect(context.defaultBranch).toBe('main');
    expect(context.resolvedRefName).toBe('release/1.1');
    expect(context.safeRefName).toBe('release-1.1');
  });

  it('normalizes runner metadata into cache-safe values', () => {
    const context = createGitHubContext(
      {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: 'apache/buildish',
        GITHUB_WORKFLOW: 'CI',
        GITHUB_JOB: 'check',
        RUNNER_OS: 'macOS',
        RUNNER_ARCH: 'AMD64',
      },
      {
        repository: { default_branch: 'main' },
      },
    );

    expect(context.runnerOs).toBe('macos');
    expect(context.runnerArch).toBe('x64');
  });

  it('normalizes Windows runner metadata into cache-safe values', () => {
    const context = createGitHubContext(
      {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: 'apache/buildish',
        GITHUB_WORKFLOW: 'CI',
        GITHUB_JOB: 'check',
        RUNNER_OS: 'Windows',
        RUNNER_ARCH: 'ARM64',
      },
      {
        repository: { default_branch: 'main' },
      },
    );

    expect(context.runnerOs).toBe('windows');
    expect(context.runnerArch).toBe('arm64');
  });

  it('falls back to the repository default branch for unsupported events', () => {
    const context = createGitHubContext(
      {
        GITHUB_EVENT_NAME: 'schedule',
        GITHUB_REPOSITORY: 'apache/buildish',
        GITHUB_WORKFLOW: 'CI',
        GITHUB_JOB: 'check',
      },
      {
        repository: { default_branch: 'main' },
      },
    );

    expect(context.resolvedRefName).toBe('main');
  });
});

describe('createGitHubPlatform', () => {
  it('publishes summaries through the configured writer', async () => {
    const summaryLines: Array<{ text: string; addEol: boolean | undefined }> = [];
    let writeCalls = 0;
    const writer: SummaryWriter = {
      addRaw(text: string, addEol?: boolean): SummaryWriter {
        summaryLines.push({ text, addEol });
        return this;
      },
      async write(): Promise<void> {
        writeCalls += 1;
      },
    };

    const platform = createGitHubPlatform({
      env: {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: 'apache/buildish',
        GITHUB_WORKFLOW: 'CI',
        GITHUB_JOB: 'check',
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
      },
      eventPayload: {
        repository: { default_branch: 'main' },
      },
      summaryWriter: writer,
    });

    await platform.publishSummary(['first line', 'second line']);

    expect(summaryLines).toEqual([
      { text: 'first line', addEol: true },
      { text: 'second line', addEol: true },
    ]);
    expect(writeCalls).toBe(1);
  });

  it('exposes exact-host GitHub API headers when a token is configured', () => {
    const platform = createGitHubPlatform({
      env: {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: 'apache/buildish',
        GITHUB_WORKFLOW: 'CI',
        GITHUB_JOB: 'check',
      },
      eventPayload: {
        repository: { default_branch: 'main' },
      },
      githubToken: '  ghs_test_token  ',
    });

    expect(platform.httpHeadersByHost.get('api.github.com')).toEqual(
      new Map([
        ['accept', 'application/vnd.github.raw'],
        ['authorization', 'Bearer ghs_test_token'],
        ['user-agent', 'apache-buildish-mammoth-cache-gradle-action'],
        ['x-github-api-version', '2022-11-28'],
      ]),
    );
    expect(platform.httpHeadersByHost.get('raw.githubusercontent.com')).toBeUndefined();
  });

  it('falls back to GITHUB_TOKEN from the environment when the input token is omitted', () => {
    const platform = createGitHubPlatform({
      env: {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: 'apache/buildish',
        GITHUB_WORKFLOW: 'CI',
        GITHUB_JOB: 'check',
        GITHUB_TOKEN: '  ghs_env_token  ',
      },
      eventPayload: {
        repository: { default_branch: 'main' },
      },
    });

    expect(platform.httpHeadersByHost.get('api.github.com')).toEqual(
      new Map([
        ['accept', 'application/vnd.github.raw'],
        ['authorization', 'Bearer ghs_env_token'],
        ['user-agent', 'apache-buildish-mammoth-cache-gradle-action'],
        ['x-github-api-version', '2022-11-28'],
      ]),
    );
  });
});
