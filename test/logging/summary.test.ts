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

import { describe, expect, it } from 'vitest';

import type { SummaryWriter } from '../../src/ci/types';
import { appendJobSummary } from '../../src/logging/summary';

describe('appendJobSummary', () => {
  it('publishes each summary line through the configured writer', async () => {
    const capture = createSummaryCapture();

    await appendJobSummary(createGitHubOptions(capture.writer), ['first line', 'second line']);

    expect(capture.lines).toEqual([
      { text: 'first line', addEol: true },
      { text: 'second line', addEol: true },
    ]);
    expect(capture.writeCalls).toBe(1);
  });

  it('does nothing when no summary lines were provided', async () => {
    const capture = createSummaryCapture();

    await appendJobSummary(createGitHubOptions(capture.writer), []);

    expect(capture.lines).toEqual([]);
    expect(capture.writeCalls).toBe(0);
  });
});

function createGitHubOptions(summaryWriter: SummaryWriter) {
  return {
    env: {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REPOSITORY: 'projectnessie/cache-gradle',
      GITHUB_WORKFLOW: 'CI',
      GITHUB_JOB: 'check',
      RUNNER_OS: 'Linux',
      RUNNER_ARCH: 'X64',
    },
    eventPayload: {
      repository: { default_branch: 'main' },
    },
    summaryWriter,
  };
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
