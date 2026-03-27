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

import { writeFile } from 'node:fs/promises';

import * as core from '@actions/core';

import type { ReportSink, SummaryWriter } from './types';

export interface GitHubReportSinkOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly summaryWriter?: SummaryWriter;
}

export function createGitHubReportSink(options: GitHubReportSinkOptions = {}): ReportSink {
  const env = options.env ?? process.env;
  const summaryWriter = options.summaryWriter ?? core.summary;

  const reportSink: ReportSink = {
    publishLogGroup(title: string, lines: readonly string[], writeLine: (message: string) => void) {
      writeLine(`::group::${title}`);
      for (const line of lines) {
        writeLine(line);
      }
      writeLine('::endgroup::');
    },
    async publishSummary(lines: readonly string[]): Promise<void> {
      for (const line of lines) {
        summaryWriter.addRaw(line, true);
      }
      await summaryWriter.write();
    },
    async replaceSummary(lines: readonly string[]): Promise<void> {
      if (env.GITHUB_STEP_SUMMARY && env.GITHUB_STEP_SUMMARY.trim().length > 0) {
        await writeFile(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`, 'utf8');
        return;
      }

      await reportSink.publishSummary(lines);
    },
  };

  return reportSink;
}
