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

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { WorkflowArtifactApi, WorkflowArtifactDescriptor } from '../src/artifacts/service';
import type { BaseCacheApi } from '../src/cache/service';
import type { SummaryWriter } from '../src/ci/types';
import { createMainActionOutputs, executeMainAction } from '../src/main-flow';
import { executePostAction } from '../src/post-flow';

const RUN_ID = '92001';
const RUN_ATTEMPT = '1';
const CACHE_KEY_PREFIX = `local-it-distributed-${RUN_ID}-${RUN_ATTEMPT}-`;
const INTEGRATION_WORKFLOW_NAME = 'Local Distributed Reuse Integration Test';
const FIXTURE_JOB_NAMES = ['worker_a', 'worker_b', 'aggregator'] as const;
const UNAVAILABLE_CACHE_API: BaseCacheApi = {
  isFeatureAvailable(): boolean {
    return false;
  },
  async restoreCache(): Promise<string | undefined> {
    throw new Error('restoreCache must not be called when the cache feature is unavailable.');
  },
  async saveCache(): Promise<number> {
    throw new Error('saveCache must not be called when the cache feature is unavailable.');
  },
};

interface LocalJobRuntime {
  readonly jobName: string;
  readonly jobRoot: string;
  readonly projectDirectory: string;
  readonly gradleUserHome: string;
  readonly env: NodeJS.ProcessEnv;
  readonly state: Map<string, string>;
}

async function main(): Promise<void> {
  if (process.platform === 'win32') {
    throw new Error(
      'The local distributed reuse integration test currently requires a POSIX shell because the fixture only ships gradlew.',
    );
  }

  const repoRoot = process.cwd();
  const fixtureSourceDirectory = path.join(
    repoRoot,
    'test',
    'fixtures',
    'integration',
    'gradle-project',
  );
  const buildRoot = path.join(repoRoot, 'build');
  await mkdir(buildRoot, { recursive: true });

  const stagedRoot = await mkdtemp(path.join(buildRoot, 'integration-distributed-reuse-'));
  let keepStagedRoot = process.env.BUILDISH_MAMMOTH_CACHE_KEEP_LOCAL_IT === '1';

  try {
    const artifactApi = new FakeArtifactApi(path.join(stagedRoot, 'artifacts'));
    const jobs = await stageJobs(stagedRoot, fixtureSourceDirectory);

    await runWorkerJob(jobs.worker_a, 'resolveWorkerA', artifactApi);
    await runWorkerJob(jobs.worker_b, 'resolveWorkerB', artifactApi);

    const uploadedArtifacts = await artifactApi.listArtifacts();
    assert.equal(
      uploadedArtifacts.length,
      2,
      'Expected both worker delta artifacts to be available.',
    );

    const aggregatorMainStatus = await executeActionMain(
      jobs.aggregator,
      {
        'base-directory': 'project',
        'job-mode': 'distributed-aggregator',
        'dependent-jobs': 'worker_a,worker_b',
        'cache-key-prefix': CACHE_KEY_PREFIX,
      },
      artifactApi,
    );
    const aggregatorOutputs = createMainActionOutputs(aggregatorMainStatus);
    assert.equal(aggregatorOutputs['downloaded-dependent-artifact-count'], '2');
    printOutputs('aggregator', aggregatorOutputs);

    const aggregatorLog = await runGradle(
      jobs.aggregator,
      ['--info', '--no-daemon', '--continue', 'resolveWorkerA', 'resolveWorkerB'],
      'aggregator-gradle',
    );
    await writeFile(
      path.join(jobs.aggregator.jobRoot, 'aggregator-gradle.log'),
      aggregatorLog,
      'utf8',
    );
    assert.match(aggregatorLog, /resolved workerA: guava-33\.4\.8-jre\.jar/);
    assert.match(aggregatorLog, /resolved workerB: commons-io-2\.18\.0\.jar/);
    assert.ok(
      !/(Downloading|Downloaded).*(guava-33\.4\.8-jre|commons-io-2\.18\.0)\.jar/.test(
        aggregatorLog,
      ),
      'Expected restored worker dependency jars to be reused, but Gradle downloaded them again.',
    );

    const aggregatorPostStatus = await executeActionPost(
      jobs.aggregator,
      {
        'base-directory': 'project',
        'job-mode': 'distributed-aggregator',
        'dependent-jobs': 'worker_a,worker_b',
        'cache-key-prefix': CACHE_KEY_PREFIX,
      },
      artifactApi,
    );
    assert.equal(aggregatorPostStatus.consumedDeltaCleanupResult?.deletedArtifactNames.length, 2);
    assert.equal(aggregatorPostStatus.deltaArtifactResult?.status, 'not-distributed-worker');
    assert.equal(
      (await artifactApi.listArtifacts()).length,
      0,
      'Expected consumed worker artifacts to be deleted.',
    );

    if (keepStagedRoot) {
      console.log(
        `\nOK: distributed reuse integration test passed. Staged root preserved at: ${stagedRoot}`,
      );
    } else {
      console.log(
        '\nOK: distributed reuse integration test passed. Staged root cleaned up; set BUILDISH_MAMMOTH_CACHE_KEEP_LOCAL_IT=1 to preserve it.',
      );
    }
  } catch (error) {
    keepStagedRoot = true;
    console.error(
      `\nFAIL: distributed reuse integration test failed. Staged root preserved at: ${stagedRoot}`,
    );
    throw error;
  } finally {
    if (!keepStagedRoot) {
      await rm(stagedRoot, { recursive: true, force: true });
    }
  }
}

async function stageJobs(
  stagedRoot: string,
  fixtureSourceDirectory: string,
): Promise<Record<(typeof FIXTURE_JOB_NAMES)[number], LocalJobRuntime>> {
  const entries = await Promise.all(
    FIXTURE_JOB_NAMES.map(async (jobName) => [
      jobName,
      await stageJob(stagedRoot, fixtureSourceDirectory, jobName),
    ]),
  );
  return Object.fromEntries(entries) as Record<(typeof FIXTURE_JOB_NAMES)[number], LocalJobRuntime>;
}

async function stageJob(
  stagedRoot: string,
  fixtureSourceDirectory: string,
  jobName: string,
): Promise<LocalJobRuntime> {
  const jobRoot = path.join(stagedRoot, jobName);
  const projectDirectory = path.join(jobRoot, 'project');
  const gradleUserHome = path.join(jobRoot, 'gradle-home');
  await cp(fixtureSourceDirectory, projectDirectory, { recursive: true });
  await chmod(path.join(projectDirectory, 'gradlew'), 0o755);

  return {
    jobName,
    jobRoot,
    projectDirectory,
    gradleUserHome,
    state: new Map<string, string>(),
    env: {
      ...process.env,
      CI: 'true',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_NAME: 'main',
      GITHUB_REPOSITORY: 'apache/buildish',
      GITHUB_WORKFLOW: INTEGRATION_WORKFLOW_NAME,
      GITHUB_RUN_ID: RUN_ID,
      GITHUB_RUN_ATTEMPT: RUN_ATTEMPT,
      GITHUB_WORKSPACE: jobRoot,
      GRADLE_USER_HOME: gradleUserHome,
      RUNNER_OS: normalizeRunnerOs(process.platform),
      RUNNER_ARCH: normalizeRunnerArch(process.arch),
      BUILDISH_MAMMOTH_CACHE_GITHUB_JOB_NAME_OVERRIDE: jobName,
      BUILDISH_MAMMOTH_CACHE_GITHUB_DEFAULT_BRANCH_OVERRIDE: 'main',
    },
  };
}

async function runWorkerJob(
  job: LocalJobRuntime,
  taskName: 'resolveWorkerA' | 'resolveWorkerB',
  artifactApi: WorkflowArtifactApi,
): Promise<void> {
  const mainStatus = await executeActionMain(
    job,
    {
      'base-directory': 'project',
      'job-mode': 'distributed-worker',
      'cache-key-prefix': CACHE_KEY_PREFIX,
    },
    artifactApi,
  );
  printOutputs(job.jobName, createMainActionOutputs(mainStatus));
  await runGradle(job, ['--info', '--no-daemon', taskName], `${job.jobName}-gradle`);
  const postStatus = await executeActionPost(
    job,
    {
      'base-directory': 'project',
      'job-mode': 'distributed-worker',
      'cache-key-prefix': CACHE_KEY_PREFIX,
    },
    artifactApi,
  );
  assert.equal(postStatus.deltaArtifactResult?.status, 'uploaded');
}

async function executeActionMain(
  job: LocalJobRuntime,
  inputs: Record<string, string>,
  artifactApi: WorkflowArtifactApi,
) {
  return await executeMainAction({
    env: job.env,
    artifactApi,
    cacheApi: UNAVAILABLE_CACHE_API,
    inputProvider: createInputProvider(inputs),
    logInfo: (message) => console.log(`[${job.jobName}] ${message}`),
    saveState: (name, value) => {
      job.state.set(name, value);
    },
    getState: (name) => job.state.get(name) ?? '',
    summaryWriter: createSummaryWriter(job.jobName),
  });
}

async function executeActionPost(
  job: LocalJobRuntime,
  inputs: Record<string, string>,
  artifactApi: WorkflowArtifactApi,
) {
  return await executePostAction({
    env: job.env,
    artifactApi,
    cacheApi: UNAVAILABLE_CACHE_API,
    inputProvider: createInputProvider(inputs),
    logInfo: (message) => console.log(`[${job.jobName}] ${message}`),
    saveState: (name, value) => {
      job.state.set(name, value);
    },
    getState: (name) => job.state.get(name) ?? '',
    summaryWriter: createSummaryWriter(`${job.jobName} post`),
  });
}

function createInputProvider(values: Record<string, string>): { getInput(name: string): string } {
  return {
    getInput(name: string): string {
      return values[name] ?? '';
    },
  };
}

function createSummaryWriter(label: string): SummaryWriter {
  const lines: string[] = [];
  return {
    addRaw(text: string, addEol = false): SummaryWriter {
      lines.push(addEol ? `${text}${os.EOL}` : text);
      return this;
    },
    async write(): Promise<void> {
      if (lines.length === 0) {
        return;
      }
      console.log(`\n--- ${label} summary ---`);
      process.stdout.write(lines.join(''));
      lines.length = 0;
    },
  };
}

function printOutputs(label: string, outputs: Record<string, string>): void {
  console.log(`\n--- ${label} outputs ---`);
  for (const [name, value] of Object.entries(outputs)) {
    console.log(`${name}=${value}`);
  }
}

async function runGradle(
  job: LocalJobRuntime,
  args: readonly string[],
  label: string,
): Promise<string> {
  console.log(`\n--- ${label} ---`);
  const result = await runProcess('./gradlew', args, {
    cwd: job.projectDirectory,
    env: job.env,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Gradle command for '${job.jobName}' failed with exit code ${result.exitCode}.`,
    );
  }
  return result.output;
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<{ readonly exitCode: number; readonly output: string }> {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';

  const append = (chunk: Buffer | string, stream: NodeJS.WriteStream): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    output += text;
    stream.write(text);
  };

  child.stdout.on('data', (chunk) => append(chunk, process.stdout));
  child.stderr.on('data', (chunk) => append(chunk, process.stderr));

  return await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`Process '${command}' terminated by signal ${signal}.`));
        return;
      }
      resolve({ exitCode: code ?? 1, output });
    });
  });
}

function normalizeRunnerOs(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'linux':
      return 'Linux';
    case 'darwin':
      return 'macOS';
    default:
      throw new Error(`Unsupported platform '${platform}' for this local integration test.`);
  }
}

function normalizeRunnerArch(arch: string): string {
  switch (arch) {
    case 'x64':
      return 'X64';
    case 'arm64':
      return 'ARM64';
    default:
      throw new Error(`Unsupported architecture '${arch}' for this local integration test.`);
  }
}

class FakeArtifactApi implements WorkflowArtifactApi {
  private nextId = 1;
  private readonly artifacts = new Map<
    number,
    { descriptor: WorkflowArtifactDescriptor; directory: string }
  >();

  constructor(private readonly storageRoot: string) {}

  async uploadArtifact(
    name: string,
    _files: readonly string[],
    rootDirectory: string,
  ): Promise<WorkflowArtifactDescriptor> {
    await mkdir(this.storageRoot, { recursive: true });
    const id = this.nextId++;
    const directory = path.join(this.storageRoot, String(id));
    await cp(rootDirectory, directory, { recursive: true });
    const descriptor: WorkflowArtifactDescriptor = { id, name, size: 0, digest: null };
    this.artifacts.set(id, { descriptor, directory });
    return descriptor;
  }

  async listArtifacts(): Promise<readonly WorkflowArtifactDescriptor[]> {
    return [...this.artifacts.values()].map((artifact) => artifact.descriptor);
  }

  async getArtifact(name: string): Promise<WorkflowArtifactDescriptor> {
    const artifact = [...this.artifacts.values()].find(
      (candidate) => candidate.descriptor.name === name,
    );
    if (!artifact) {
      throw new Error(`Artifact '${name}' not found.`);
    }
    return artifact.descriptor;
  }

  async downloadArtifact(
    artifactId: number,
    options?: { readonly path?: string },
  ): Promise<{ readonly downloadPath: string; readonly digestMismatch: boolean }> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) {
      throw new Error(`Artifact '${artifactId}' not found.`);
    }
    const parentDirectory = options?.path ?? this.storageRoot;
    const downloadPath = path.join(parentDirectory, `artifact-${artifactId}`);
    await cp(artifact.directory, downloadPath, { recursive: true });
    return { downloadPath, digestMismatch: false };
  }

  async deleteArtifact(name: string): Promise<void> {
    const artifact = [...this.artifacts.entries()].find(
      ([, candidate]) => candidate.descriptor.name === name,
    );
    if (!artifact) {
      throw new Error(`Artifact '${name}' not found.`);
    }
    this.artifacts.delete(artifact[0]);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
