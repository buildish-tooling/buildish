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

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createGradleBuildSummaryLines,
  loadGradleBuildReport,
} from '../../src/gradle/build-results';

describe('Gradle build reporting', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directoryPath) => {
        await rm(directoryPath, { recursive: true, force: true });
      }),
    );
  });

  it('merges captured build results with optional build scan metadata', async () => {
    const runnerTemp = await createRunnerTemp(temporaryDirectories);
    const captureRoot = path.join(runnerTemp, '.buildish-mammoth-cache-gradle');
    const buildResultsDirectory = path.join(captureRoot, 'build-results');
    const buildScansDirectory = path.join(captureRoot, 'build-scans');
    await mkdir(buildResultsDirectory, { recursive: true });
    await mkdir(buildScansDirectory, { recursive: true });

    await writeFile(
      path.join(buildResultsDirectory, '__run-2.json'),
      JSON.stringify({
        capturedAtEpochMillis: 2000,
        rootProjectName: 'demo',
        requestedTasks: 'check',
        gradleVersion: '8.14.3',
        buildFailed: true,
        configCacheHit: true,
      }),
      'utf8',
    );
    await writeFile(
      path.join(buildResultsDirectory, '__run-1.json'),
      JSON.stringify({
        capturedAtEpochMillis: 1000,
        rootProjectName: 'demo',
        requestedTasks: 'build --scan',
        gradleVersion: '8.14.3',
        buildFailed: false,
        configCacheHit: false,
      }),
      'utf8',
    );
    await writeFile(
      path.join(buildScansDirectory, '__run-1.json'),
      JSON.stringify({
        buildScanUri: 'https://scans.gradle.com/s/local-it-published',
        buildScanFailed: false,
      }),
      'utf8',
    );
    await writeFile(
      path.join(buildScansDirectory, '__run-orphan.json'),
      JSON.stringify({
        buildScanUri: null,
        buildScanFailed: true,
      }),
      'utf8',
    );

    const report = await loadGradleBuildReport({ RUNNER_TEMP: runnerTemp });

    expect(report.builds).toEqual([
      expect.objectContaining({
        invocationKey: '__run-1',
        requestedTasks: 'build --scan',
        buildFailed: false,
        buildScanUri: 'https://scans.gradle.com/s/local-it-published',
        buildScanFailed: false,
      }),
      expect.objectContaining({
        invocationKey: '__run-2',
        requestedTasks: 'check',
        buildFailed: true,
        buildScanUri: null,
        buildScanFailed: false,
      }),
    ]);
    expect(report.warnings).toEqual([
      expect.stringContaining("Ignoring build scan metadata for invocation '__run-orphan'"),
    ]);
  });

  it('renders a compact build summary with outcomes and build scan states', () => {
    const lines = createGradleBuildSummaryLines({
      builds: [
        {
          invocationKey: '__run-1',
          capturedAtEpochMillis: 1000,
          rootProjectName: 'demo',
          requestedTasks: 'build --scan',
          gradleVersion: '8.14.3',
          buildFailed: false,
          configCacheHit: false,
          buildScanUri: 'https://scans.gradle.com/s/local-it-published',
          buildScanFailed: false,
        },
        {
          invocationKey: '__run-2',
          capturedAtEpochMillis: 2000,
          rootProjectName: 'demo',
          requestedTasks: 'publishFakeBuildScanFailure',
          gradleVersion: '8.14.3',
          buildFailed: false,
          configCacheHit: true,
          buildScanUri: null,
          buildScanFailed: true,
        },
      ],
      warnings: ['sample warning'],
    });

    expect(lines).toEqual(
      expect.arrayContaining([
        '### Performed Gradle builds',
        '- Captured Gradle builds: 2',
        '- Build outcomes: 2 succeeded, 0 failed',
        '- Build scans: 1 published, 1 failed, 0 not attempted',
        '- Build reporting warnings: 1',
        '- Warning: sample warning',
        '  - Outcome: succeeded',
        '  - Configuration cache reused: no',
        '  - Build Scan: attempted but failed',
      ]),
    );
    expect(lines.some((line) => line.startsWith('- Build 1: demo'))).toBe(true);
    expect(lines.some((line) => line.includes('build') && line.includes('scan'))).toBe(true);
    expect(
      lines.some(
        (line) =>
          line === '  - Build Scan: published (https://scans.gradle.com/s/local-it-published)',
      ),
    ).toBe(true);
    expect(lines.some((line) => line.startsWith('- Build 2: demo'))).toBe(true);
  });
});

async function createRunnerTemp(temporaryDirectories: string[]): Promise<string> {
  const directoryPath = await mkdtemp(path.join(os.tmpdir(), 'buildish-gradle-build-report-'));
  temporaryDirectories.push(directoryPath);
  return directoryPath;
}
