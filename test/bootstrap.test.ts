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

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  bootstrapPhase,
  createBootstrapStatus,
  createBootstrapSummaryLines,
} from '../src/bootstrap';
import type { SummaryWriter } from '../src/ci/types';
import type { ProvisionedWrapperJar, ValidatedWrapperPropertiesFile } from '../src/wrapper/types';

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

const provisionedWrappers: readonly ProvisionedWrapperJar[] = [
  {
    relativePath: 'gradle/wrapper/gradle-wrapper.properties',
    distributionVersion: '8.14',
    wrapperSourceVersion: '8.14.0',
    wrapperChecksumUrl: 'https://services.gradle.org/distributions/gradle-8.14-wrapper.jar.sha256',
    wrapperJarUrl:
      'https://raw.githubusercontent.com/gradle/gradle/v8.14.0/gradle/wrapper/gradle-wrapper.jar',
    wrapperJarRelativePath: 'gradle/wrapper/gradle-wrapper.jar',
    wrapperJarAbsolutePath: '/workspace/gradle/wrapper/gradle-wrapper.jar',
    expectedWrapperJarSha256: 'ecf4726f7d253471e541f6385b55d00e809387ed44250fb53f65b0deaf8e72ad',
    wasDownloaded: true,
  },
] as const;

describe('bootstrap helpers', () => {
  it('creates a status message with config and CI context details', () => {
    expect(
      createBootstrapStatus('main', config, ciContext, validatedWrappers, provisionedWrappers),
    ).toEqual({
      phase: 'main',
      config,
      ciContext,
      validatedWrappers,
      provisionedWrappers,
      message: 'Prepared main phase for push on main in standalone mode.',
    });
  });

  it('renders summary lines for the bootstrap status', () => {
    expect(
      createBootstrapSummaryLines(
        createBootstrapStatus('main', config, ciContext, validatedWrappers, provisionedWrappers),
      ),
    ).toEqual(
      expect.arrayContaining([
        '- Job mode: standalone',
        '- Wrapper files: 1',
        '- Wrapper JARs ready: 1',
      ]),
    );
  });

  it('bootstraps the main phase and publishes a summary', async () => {
    const wrapperJarBytes = Buffer.from('verified wrapper jar');
    const wrapperJarSha256 = createHash('sha256').update(wrapperJarBytes).digest('hex');
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
    await withWorkspaceWithWrapper(async (workspace) => {
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
        fetchImpl: async (input: string | URL | Request): Promise<Response> => {
          const url = String(input);

          if (url.endsWith('gradle-8.14-wrapper.jar.sha256')) {
            return new Response(`${wrapperJarSha256}\n`, { status: 200 });
          }

          if (url.endsWith('/v8.14.0/gradle/wrapper/gradle-wrapper.jar')) {
            return new Response(wrapperJarBytes, { status: 200 });
          }

          throw new Error(`Unexpected fetch URL: ${url}`);
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
      expect(status.provisionedWrappers).toHaveLength(1);
      expect(summaryLines).toEqual(
        expect.arrayContaining([
          '## Cache Gradle bootstrap',
          '- Wrapper files: 1',
          '- Wrapper JARs ready: 1',
        ]),
      );
      expect(writeCalls).toBe(1);
      await expect(
        readFile(path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.jar')),
      ).resolves.toEqual(wrapperJarBytes);
    });
  });
});

async function withWorkspaceWithWrapper(
  testBody: (workspace: string) => Promise<void>,
): Promise<void> {
  await withWorkspace(
    {
      'gradle/wrapper/gradle-wrapper.properties': [
        'distributionBase=GRADLE_USER_HOME',
        'distributionPath=wrapper/dists',
        'distributionSha256Sum=61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
        'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14-bin.zip',
        'validateDistributionUrl=true',
        'zipStoreBase=GRADLE_USER_HOME',
        'zipStorePath=wrapper/dists',
        '',
      ].join('\n'),
    },
    testBody,
  );
}

async function withWorkspace(
  files: Record<string, string>,
  testBody: (workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cache-gradle-bootstrap-'));

  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = path.join(workspace, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents, 'utf8');
    }

    await testBody(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
