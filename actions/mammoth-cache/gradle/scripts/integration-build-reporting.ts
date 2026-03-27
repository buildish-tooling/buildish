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
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ActionRuntimeHost } from '../src/ci';
import { createGitHubPlatform, createGitHubReportSink } from '../src/ci/github';
import { executeMainAction } from '../src/main-flow';
import { createPostActionSummaryLines, executePostAction } from '../src/post-flow';
import type { SummaryWriter } from '../src/reporting/types';
import {
  STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES,
  type WorkflowArtifactBackend,
} from '../src/storage/artifacts';
import {
  STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
  type BaseCacheBackend,
} from '../src/storage/cache';

const RUN_ID = '92002';
const RUN_ATTEMPT = '1';
const WORKFLOW_NAME = 'Local Build Reporting Integration Test';
const SUMMARY_FILE_NAME = 'build-reporting-summary.md';

interface GradleInvocation {
  readonly args: readonly string[];
  readonly expectedExitCode?: number;
  readonly label: string;
}

async function main(): Promise<void> {
  if (process.platform === 'win32') {
    throw new Error(
      'The local build-reporting integration test currently requires a POSIX shell because the fixture only ships gradlew.',
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

  const stagedRoot = await mkdtemp(path.join(buildRoot, 'integration-build-reporting-'));
  let keepStagedRoot = process.env.BUILDISH_MAMMOTH_CACHE_KEEP_LOCAL_IT === '1';
  const summaryPath = path.join(stagedRoot, SUMMARY_FILE_NAME);

  try {
    const runtime = await stageProject(stagedRoot, fixtureSourceDirectory);
    const summary = createSummaryCapture();
    const gradleInvocations: readonly GradleInvocation[] = [
      { args: ['help'], label: 'Baseline help build' },
      { args: ['publishFakeBuildScan'], label: 'Publish fake Build Scan' },
      { args: ['publishFakeBuildScanFailure'], label: 'Fail fake Build Scan publication' },
      { args: ['failingVerification'], expectedExitCode: 1, label: 'Fail verification task' },
    ];

    await executeMainAction({
      artifactBackend: unavailableArtifactApi(),
      cacheBackend: unavailableCacheApi(),
      captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
      env: runtime.env,
      ...createGitHubActionDependencies(
        runtime,
        {
          'base-directory': 'project',
          'cache-enabled': 'false',
          'read-only': 'true',
        },
        summary.writer,
        'main',
      ),
    });

    for (const invocation of gradleInvocations) {
      await runGradle(runtime, invocation.args, invocation.label, invocation.expectedExitCode ?? 0);
    }

    const postStatus = await executePostAction({
      artifactBackend: unavailableArtifactApi(),
      cacheBackend: unavailableCacheApi(),
      captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
      env: runtime.env,
      ...createGitHubActionDependencies(
        runtime,
        {
          'base-directory': 'project',
          'cache-enabled': 'false',
          'read-only': 'true',
        },
        summary.writer,
        'post',
      ),
    });
    await writeFile(
      summaryPath,
      `${createPostActionSummaryLines(postStatus).join('\n')}\n`,
      'utf8',
    );

    assert.equal(postStatus.gradleBuildReport.builds.length, 4);
    assert.equal(
      postStatus.gradleBuildReport.builds.filter((build) => !build.buildFailed).length,
      3,
    );
    assert.equal(
      postStatus.gradleBuildReport.builds.filter((build) => build.buildFailed).length,
      1,
    );
    assert.ok(
      postStatus.gradleBuildReport.builds.some(
        (build) => build.buildScanUri === 'https://scans.gradle.com/s/fake-published-scan',
      ),
    );
    assert.ok(postStatus.gradleBuildReport.builds.some((build) => build.buildScanFailed));
    assert.ok(
      postStatus.gradleBuildReport.builds.some(
        (build) => build.requestedTasks === 'failingVerification',
      ),
    );
    assert.ok(postStatus.gradleBuildReport.builds.some((build) => build.requestedTasks === 'help'));

    const summaryText = await readFile(summaryPath, 'utf8');
    assert.match(summaryText, /## Apache Buildish Mammoth Cache for Gradle/u);
    assert.match(summaryText, /### Gradle builds/u);
    assert.match(summaryText, /<table>/u);
    assert.match(summaryText, /mammoth-cache-gradle-it — help/u);
    assert.match(
      summaryText,
      /<a href="https:\/\/scans\.gradle\.com\/s\/fake-published-scan">🔗<\/a>/u,
    );
    assert.match(summaryText, /<td>❌<\/td>/u);
    assert.match(summaryText, /mammoth-cache-gradle-it — failingVerification/u);

    const initScriptPath = path.join(
      runtime.gradleUserHome,
      'init.d',
      'buildish-mammoth-cache-gradle.build-result-capture.init.gradle',
    );
    await assert.rejects(readFile(initScriptPath, 'utf8'));

    if (keepStagedRoot) {
      console.log(
        `\nOK: build-reporting integration test passed. Staged root preserved at: ${stagedRoot}\nSummary report: ${summaryPath}`,
      );
    } else {
      console.log(
        '\nOK: build-reporting integration test passed. Staged root cleaned up; set BUILDISH_MAMMOTH_CACHE_KEEP_LOCAL_IT=1 to preserve it.',
      );
    }
  } catch (error) {
    keepStagedRoot = true;
    console.error(
      `\nFAIL: build-reporting integration test failed. Staged root preserved at: ${stagedRoot}\nSummary report: ${summaryPath}`,
    );
    throw error;
  } finally {
    if (!keepStagedRoot) {
      await rm(stagedRoot, { recursive: true, force: true });
    }
  }
}

interface LocalRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly gradleUserHome: string;
  readonly projectDirectory: string;
  readonly state: Map<string, string>;
}

async function stageProject(
  stagedRoot: string,
  fixtureSourceDirectory: string,
): Promise<LocalRuntime> {
  const projectDirectory = path.join(stagedRoot, 'project');
  const gradleUserHome = path.join(stagedRoot, 'gradle-home');
  await cp(fixtureSourceDirectory, projectDirectory, { recursive: true });
  await chmod(path.join(projectDirectory, 'gradlew'), 0o755);
  await writeFixtureProject(projectDirectory);

  return {
    projectDirectory,
    gradleUserHome,
    state: new Map<string, string>(),
    env: {
      ...process.env,
      GITHUB_ACTION: '__run',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_NAME: 'main',
      GITHUB_REPOSITORY: 'apache/buildish',
      GITHUB_WORKFLOW: WORKFLOW_NAME,
      GITHUB_JOB: 'build-reporting',
      GITHUB_RUN_ID: RUN_ID,
      GITHUB_RUN_ATTEMPT: RUN_ATTEMPT,
      GITHUB_WORKSPACE: stagedRoot,
      GRADLE_USER_HOME: gradleUserHome,
      HOME: stagedRoot,
      RUNNER_OS: normalizeRunnerOs(process.platform),
      RUNNER_ARCH: normalizeRunnerArch(process.arch),
      RUNNER_TEMP: path.join(stagedRoot, 'runner-temp'),
      BUILDISH_MAMMOTH_CACHE_GITHUB_JOB_NAME_OVERRIDE: 'build-reporting',
      BUILDISH_MAMMOTH_CACHE_GITHUB_DEFAULT_BRANCH_OVERRIDE: 'main',
    },
  };
}

async function writeFixtureProject(projectDirectory: string): Promise<void> {
  await writeFile(
    path.join(projectDirectory, 'settings.gradle'),
    `rootProject.name = 'mammoth-cache-gradle-it'\n`,
    'utf8',
  );
  await writeFile(
    path.join(projectDirectory, 'build.gradle'),
    `plugins {\n  id 'com.gradle.build-scan'\n}\n`,
    'utf8',
  );

  const buildSrcDirectory = path.join(projectDirectory, 'buildSrc');
  await mkdir(path.join(buildSrcDirectory, 'src', 'main', 'groovy', 'fixture'), {
    recursive: true,
  });
  await mkdir(
    path.join(buildSrcDirectory, 'src', 'main', 'resources', 'META-INF', 'gradle-plugins'),
    {
      recursive: true,
    },
  );
  await writeFile(
    path.join(buildSrcDirectory, 'build.gradle'),
    `plugins {\n  id 'groovy-gradle-plugin'\n}\n`,
    'utf8',
  );
  await writeFile(
    path.join(
      buildSrcDirectory,
      'src',
      'main',
      'resources',
      'META-INF',
      'gradle-plugins',
      'com.gradle.build-scan.properties',
    ),
    `implementation-class=fixture.FakeBuildScanPlugin\n`,
    'utf8',
  );
  await writeFile(
    path.join(buildSrcDirectory, 'src', 'main', 'groovy', 'fixture', 'FakeBuildScanPlugin.groovy'),
    `package fixture\n\nimport org.gradle.api.GradleException\nimport org.gradle.api.Plugin\nimport org.gradle.api.Project\n\nclass FakeBuildScanPlugin implements Plugin<Project> {\n    @Override\n    void apply(Project project) {\n        def extension = project.extensions.create('buildScan', FakeBuildScanExtension)\n        project.tasks.register('publishFakeBuildScan') {\n            doLast {\n                extension.publish('https://scans.gradle.com/s/fake-published-scan')\n            }\n        }\n        project.tasks.register('publishFakeBuildScanFailure') {\n            doLast {\n                extension.fail(new RuntimeException('simulated Build Scan publication failure'))\n            }\n        }\n        project.tasks.register('failingVerification') {\n            doLast {\n                throw new GradleException('simulated task failure')\n            }\n        }\n    }\n}\n\nclass FakeBuildScanExtension {\n    private Closure<?> publishedCallback\n    private Closure<?> errorCallback\n\n    void buildScanPublished(Closure<?> callback) {\n        publishedCallback = callback\n    }\n\n    void onError(Closure<?> callback) {\n        errorCallback = callback\n    }\n\n    void publish(String uri) {\n        publishedCallback?.call(new FakePublishedBuildScan(uri))\n    }\n\n    void fail(Throwable error) {\n        errorCallback?.call(error)\n    }\n}\n\nclass FakePublishedBuildScan {\n    final URI buildScanUri\n\n    FakePublishedBuildScan(String uri) {\n        this.buildScanUri = new URI(uri)\n    }\n}\n`,
    'utf8',
  );
}

function createInputProvider(values: Record<string, string>): { getInput(name: string): string } {
  return {
    getInput(name: string): string {
      return values[name] ?? '';
    },
  };
}

function createGitHubActionDependencies(
  runtime: { readonly env: NodeJS.ProcessEnv; readonly state: Map<string, string> },
  inputs: Record<string, string>,
  summaryWriter: SummaryWriter,
  logPrefix: string,
) {
  const inputProvider = createInputProvider(inputs);
  const runtimeHost: ActionRuntimeHost = {
    getInput(name): string {
      return inputProvider.getInput(name);
    },
    getState(name): string {
      return runtime.state.get(name) ?? '';
    },
    saveState(name, value): void {
      runtime.state.set(name, value);
    },
    setOutput(): void {},
    info(message): void {
      console.log(`[${logPrefix}] ${message}`);
    },
    warning(message): void {
      console.warn(`[${logPrefix}] ${message}`);
    },
    setFailed(message): void {
      throw new Error(message);
    },
  };

  return {
    runtimeHost,
    ciProvider: createGitHubPlatform({
      env: runtime.env,
      eventPayload: {
        repository: { default_branch: 'main' },
      },
    }),
    reportSink: createGitHubReportSink({
      env: runtime.env,
      summaryWriter,
    }),
  };
}

function createSummaryCapture(): {
  readonly flushes: string[][];
  readonly writer: SummaryWriter;
} {
  const lines: string[] = [];
  const flushes: string[][] = [];
  return {
    flushes,
    writer: {
      addRaw(text: string, _addEol?: boolean): SummaryWriter {
        lines.push(text);
        return this;
      },
      async write(): Promise<void> {
        if (lines.length === 0) {
          return;
        }

        flushes.push([...lines]);
        lines.length = 0;
      },
    },
  };
}

async function runGradle(
  runtime: LocalRuntime,
  args: readonly string[],
  label: string,
  expectedExitCode = 0,
): Promise<void> {
  console.log(`\n--- ${label} ---`);
  const result = await runProcess('./gradlew', args, {
    cwd: runtime.projectDirectory,
    env: runtime.env,
  });
  assert.equal(
    result.exitCode,
    expectedExitCode,
    `Gradle command '${label}' exited with ${result.exitCode}. Output:\n${result.output}`,
  );
}

function unavailableCacheApi(): BaseCacheBackend {
  return {
    capabilities: STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
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
}

function unavailableArtifactApi(): WorkflowArtifactBackend {
  return {
    capabilities: {
      ...STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES,
      supportsDeletion: false,
      supportsCrossExecutionLookup: false,
    },
    async uploadArtifact(): Promise<never> {
      throw new Error(
        'Artifact operations should not run in the build-reporting integration test.',
      );
    },
    async listArtifacts(): Promise<readonly []> {
      return [];
    },
    async getArtifact(): Promise<never> {
      throw new Error(
        'Artifact operations should not run in the build-reporting integration test.',
      );
    },
    async downloadArtifact(): Promise<never> {
      throw new Error(
        'Artifact operations should not run in the build-reporting integration test.',
      );
    },
    async deleteArtifact(): Promise<void> {},
  };
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<{ readonly exitCode: number | null; readonly output: string }> {
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
    child.on('close', (code) => resolve({ exitCode: code, output }));
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

void main();
