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

import {
  bootstrapPhase,
  createBootstrapStatus,
  createBootstrapSummaryLines,
} from '../src/bootstrap';
import type { SummaryWriter } from '../src/ci/types';

const config = {
  phase: 'main',
  baseDirectory: '.',
  cacheEnabled: true,
  readOnly: false,
  jobMode: 'standalone',
  dependentJobs: [],
  cacheKeyPrefix: 'gradle-cache-',
  cacheKeyTemplate: null,
  cacheSchemaVersion: 1,
  wrapperSelectionMode: 'default',
  wrapperPropertiesGlob: '**/gradle/wrapper/gradle-wrapper.properties',
  defaultWrapperPropertiesFile: 'gradle/wrapper/gradle-wrapper.properties',
  wrapperPropertiesFiles: [],
  cleanupEnabled: true,
  gradleUserHome: '/home/runner/.gradle',
} as const;

const ciContext = {
  platform: 'github',
  eventName: 'push',
  resolvedRefName: 'main',
  safeRefName: 'main',
  defaultBranch: 'main',
  isPullRequest: false,
  repository: 'projectnessie/cache-gradle',
  workflowName: 'CI',
  jobName: 'check',
  runId: 123,
  runAttempt: 1,
  workspace: '/workspace',
  actionPath: '/workspace',
} as const;

describe('bootstrap helpers', () => {
  it('creates a status message with config and CI context details', () => {
    expect(createBootstrapStatus('main', config, ciContext)).toEqual({
      phase: 'main',
      config,
      ciContext,
      message: 'Prepared main phase for push on main in standalone mode.',
    });
  });

  it('renders summary lines for the bootstrap status', () => {
    expect(createBootstrapSummaryLines(createBootstrapStatus('main', config, ciContext))).toContain(
      '- Job mode: standalone',
    );
  });

  it('bootstraps the main phase and publishes a summary', async () => {
    const summaryLines: string[] = [];
    let writeCalls = 0;
    const summaryWriter: SummaryWriter = {
      addRaw(text: string, _addEol?: boolean): SummaryWriter {
        summaryLines.push(text);
        return this;
      },
      async write(): Promise<void> {
        writeCalls += 1;
      },
    };

    const status = await bootstrapPhase('main', {
      env: {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: 'projectnessie/cache-gradle',
        GITHUB_WORKFLOW: 'CI',
        GITHUB_JOB: 'check',
      },
      eventPayload: {
        repository: { default_branch: 'main' },
      },
      inputProvider: {
        getInput(): string {
          return '';
        },
      },
      summaryWriter,
    });

    expect(status.message).toBe('Prepared main phase for push on main in standalone mode.');
    expect(summaryLines[0]).toBe('## Cache Gradle bootstrap');
    expect(writeCalls).toBe(1);
  });
});
