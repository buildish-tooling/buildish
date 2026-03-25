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

import { access } from 'node:fs/promises';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function main() {
  const repoRoot = process.cwd();
  const bundlePath = path.join(repoRoot, 'dist', 'main', 'index.cjs');
  const fixturePath = path.join(repoRoot, 'test', 'fixtures', 'smoke');
  const committedJarPath = path.join(fixturePath, 'gradle', 'wrapper', 'gradle-wrapper.jar');

  await access(bundlePath).catch(() => {
    throw new Error(
      `Missing bundled action entrypoint at '${bundlePath}'. Run 'make build' first.`,
    );
  });
  await access(fixturePath).catch(() => {
    throw new Error(`Missing smoke fixture directory at '${fixturePath}'.`);
  });

  const buildRoot = path.join(repoRoot, 'build');
  await mkdir(buildRoot, { recursive: true });

  const stagedRoot = await mkdtemp(path.join(buildRoot, 'smoke-fixture-'));
  const fixtureCopyPath = path.join(stagedRoot, 'smoke');
  const summaryFile = path.join(stagedRoot, 'step-summary.md');

  try {
    await cp(fixturePath, fixtureCopyPath, { recursive: true });
    await writeFile(summaryFile, '', 'utf8');

    const baseDirectory = toPosixPath(path.relative(repoRoot, fixtureCopyPath));
    const exitCode = await runProcess(process.execPath, [bundlePath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: 'projectnessie/cache-gradle',
        GITHUB_WORKFLOW: 'Local Smoke Test',
        GITHUB_JOB: 'smoke',
        GITHUB_WORKSPACE: repoRoot,
        GITHUB_STEP_SUMMARY: summaryFile,
        'INPUT_BASE-DIRECTORY': baseDirectory,
      },
    });

    const summary = await readFile(summaryFile, 'utf8').catch(() => '');
    if (summary.trim().length > 0) {
      console.log('--- summary ---');
      process.stdout.write(summary.endsWith(os.EOL) ? summary : `${summary}${os.EOL}`);
    }

    await access(committedJarPath)
      .then(() => {
        throw new Error(`Smoke test must not modify committed fixtures: '${committedJarPath}'.`);
      })
      .catch((error) => {
        if (
          (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') ||
          error === undefined
        ) {
          return;
        }

        throw error;
      });

    process.exitCode = exitCode;
  } finally {
    await rm(stagedRoot, { recursive: true, force: true });
  }
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join(path.posix.sep);
}

async function runProcess(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
  });

  return await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`Process '${command}' terminated by signal ${signal}.`));
        return;
      }

      resolve(code ?? 1);
    });
  });
}

await main();
