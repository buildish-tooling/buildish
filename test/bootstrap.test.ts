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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  bootstrapPhase,
  createBootstrapStatus,
  createBootstrapSummaryLines,
} from '../src/bootstrap';
import type { SummaryWriter } from '../src/ci/types';
import type { ValidatedWrapperPropertiesFile } from '../src/wrapper/types';

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

const validatedWrappers: readonly ValidatedWrapperPropertiesFile[] = [
  {
    relativePath: 'gradle/wrapper/gradle-wrapper.properties',
    absolutePath: '/workspace/gradle/wrapper/gradle-wrapper.properties',
    wrapperDirectoryRelativePath: 'gradle/wrapper',
    wrapperJarRelativePath: 'gradle/wrapper/gradle-wrapper.jar',
    properties: {
      distributionUrl: 'https://services.gradle.org/distributions/gradle-8.14-bin.zip',
      distributionSha256Sum: '61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
      validateDistributionUrl: 'true',
    },
    distributionUrl: 'https://services.gradle.org/distributions/gradle-8.14-bin.zip',
    distributionSha256Sum: '61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
  },
] as const;

describe('bootstrap helpers', () => {
  it('creates a status message with config and CI context details', () => {
    expect(createBootstrapStatus('main', config, ciContext, validatedWrappers)).toEqual({
      phase: 'main',
      config,
      ciContext,
      validatedWrappers,
      message: 'Prepared main phase for push on main in standalone mode.',
    });
  });

  it('renders summary lines for the bootstrap status', () => {
    expect(
      createBootstrapSummaryLines(
        createBootstrapStatus('main', config, ciContext, validatedWrappers),
      ),
    ).toEqual(expect.arrayContaining(['- Job mode: standalone', '- Wrapper files: 1']));
  });

  it('bootstraps the main phase and publishes a summary', async () => {
    const workspace = await createWorkspaceWithWrapper();
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
    try {
      const status = await bootstrapPhase('main', {
        env: {
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REPOSITORY: 'projectnessie/cache-gradle',
          GITHUB_WORKFLOW: 'CI',
          GITHUB_JOB: 'check',
          GITHUB_WORKSPACE: workspace,
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
      expect(status.validatedWrappers).toHaveLength(1);
      expect(summaryLines).toEqual(
        expect.arrayContaining(['## Cache Gradle bootstrap', '- Wrapper files: 1']),
      );
      expect(writeCalls).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

async function createWorkspaceWithWrapper(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cache-gradle-bootstrap-'));
  const wrapperDirectory = path.join(workspace, 'gradle', 'wrapper');
  await mkdir(wrapperDirectory, { recursive: true });
  await writeFile(
    path.join(wrapperDirectory, 'gradle-wrapper.properties'),
    [
      'distributionBase=GRADLE_USER_HOME',
      'distributionPath=wrapper/dists',
      'distributionSha256Sum=61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
      'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14-bin.zip',
      'validateDistributionUrl=true',
      'zipStoreBase=GRADLE_USER_HOME',
      'zipStorePath=wrapper/dists',
      '',
    ].join('\n'),
    'utf8',
  );
  return workspace;
}
