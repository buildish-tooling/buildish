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

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createGitHubPlatform } from '../../src/ci/github';
import type { SummaryWriter } from '../../src/ci/types';
import { appendJobSummary, publishJobLogGroup, replaceJobSummary } from '../../src/logging/summary';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('appendJobSummary', () => {
  it('publishes each summary line through the configured writer', async () => {
    const capture = createSummaryCapture();

    await appendJobSummary(createGitHubProvider(capture.writer), ['first line', 'second line']);

    expect(capture.lines).toEqual([
      { text: 'first line', addEol: true },
      { text: 'second line', addEol: true },
    ]);
    expect(capture.writeCalls).toBe(1);
  });

  it('does nothing when no summary lines were provided', async () => {
    const capture = createSummaryCapture();

    await appendJobSummary(createGitHubProvider(capture.writer), []);

    expect(capture.lines).toEqual([]);
    expect(capture.writeCalls).toBe(0);
  });
});

describe('publishJobLogGroup', () => {
  it('publishes grouped log lines through the configured CI adapter', async () => {
    const messages: string[] = [];

    await publishJobLogGroup(
      createGitHubProvider(createSummaryCapture().writer),
      'Main action',
      ['first line', 'second line'],
      (message) => messages.push(message),
    );

    expect(messages).toEqual(['::group::Main action', 'first line', 'second line', '::endgroup::']);
  });
});

describe('replaceJobSummary', () => {
  it('replaces the step summary file when GITHUB_STEP_SUMMARY is available', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'buildish-summary-'));
    temporaryDirectories.push(directory);
    const capture = createSummaryCapture();
    const summaryPath = path.join(directory, 'step-summary.md');

    await replaceJobSummary(
      createGitHubProvider(capture.writer, { GITHUB_STEP_SUMMARY: summaryPath }),
      ['replaced line', 'second line'],
    );

    await expect(readFile(summaryPath, 'utf8')).resolves.toBe('replaced line\nsecond line\n');
    expect(capture.lines).toEqual([]);
    expect(capture.writeCalls).toBe(0);
  });

  it('falls back to the configured writer when no summary file is available', async () => {
    const capture = createSummaryCapture();

    await replaceJobSummary(createGitHubProvider(capture.writer), ['first line', 'second line']);

    expect(capture.lines).toEqual([
      { text: 'first line', addEol: true },
      { text: 'second line', addEol: true },
    ]);
    expect(capture.writeCalls).toBe(1);
  });
});

function createGitHubProvider(summaryWriter: SummaryWriter, envOverrides: NodeJS.ProcessEnv = {}) {
  return createGitHubPlatform({
    env: {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REPOSITORY: 'apache/buildish',
      GITHUB_WORKFLOW: 'CI',
      GITHUB_JOB: 'check',
      RUNNER_OS: 'Linux',
      RUNNER_ARCH: 'X64',
      ...envOverrides,
    },
    eventPayload: {
      repository: { default_branch: 'main' },
    },
    summaryWriter,
  });
}

function createSummaryCapture(): {
  readonly lines: Array<{ text: string; addEol: boolean | undefined }>;
  readonly writer: SummaryWriter;
  get writeCalls(): number;
} {
  const lines: Array<{ text: string; addEol: boolean | undefined }> = [];
  let writeCalls = 0;
  const writer: SummaryWriter = {
    addRaw(text: string, addEol?: boolean): SummaryWriter {
      lines.push({ text, addEol });
      return writer;
    },
    async write(): Promise<void> {
      writeCalls += 1;
    },
  };

  return {
    lines,
    writer,
    get writeCalls(): number {
      return writeCalls;
    },
  };
}
