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

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

const RAT_VERSION = '0.18';
const RAT_ARCHIVE_SHA512 =
  '315b16536526838237c42b5e6b613d29adc77e25a6e44a866b2b7f8b162e03d3629d49c9faea86ceb864a36b2c42838b8ce43d6f2db544e961f2259e242748f4';
const RAT_ARCHIVE_NAME = `apache-rat-${RAT_VERSION}-bin.tar.gz`;
const RAT_ARCHIVE_URL = `https://dlcdn.apache.org/creadur/apache-rat-${RAT_VERSION}/${RAT_ARCHIVE_NAME}`;
const JAVA_BIN = process.env.JAVA_BIN ?? 'java';

async function main() {
  const repoRoot = process.cwd();
  await ensureJava21();
  await ensureCommandOnPath('git');
  await ensureCommandOnPath('tar');

  const ratCacheDir = path.join(repoRoot, 'build', 'rat');
  await mkdir(ratCacheDir, { recursive: true });

  const archiveFile = path.join(ratCacheDir, RAT_ARCHIVE_NAME);
  const workDir = await mkdtemp(path.join(ratCacheDir, 'work-'));
  const inputSourceFile = path.join(workDir, 'input-source.txt');

  try {
    await ensureRatArchive(archiveFile);
    await runProcess('tar', ['-xzf', archiveFile, '-C', workDir]);

    const ratJar = path.join(workDir, `apache-rat-${RAT_VERSION}`, `apache-rat-${RAT_VERSION}.jar`);
    await access(ratJar);

    const candidateFiles = await collectCandidateFiles(repoRoot);
    const gitIgnoredFiles = await collectGitIgnoredFiles(candidateFiles);
    const exclusions = await loadExclusions(path.join(repoRoot, '.rat-excludes'));
    const filesToScan = candidateFiles
      .filter((filePath) => !gitIgnoredFiles.has(filePath))
      .filter((filePath) => !matchesAnyExclusion(filePath, exclusions))
      .map((filePath) => path.join(repoRoot, filePath));

    await writeFile(inputSourceFile, `${filesToScan.join('\n')}\n`, 'utf8');

    await runProcess(JAVA_BIN, ['-jar', ratJar, '--input-source', inputSourceFile, '--']);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function collectCandidateFiles(repoRoot, relativeDir = '') {
  const absoluteDir = path.join(repoRoot, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === '.git') {
      continue;
    }

    const relativePath = path.posix.join(relativeDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectCandidateFiles(repoRoot, relativePath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files;
}

async function collectGitIgnoredFiles(candidateFiles) {
  if (candidateFiles.length === 0) {
    return new Set();
  }

  const { stdout, code } = await spawnProcess('git', ['check-ignore', '--stdin'], {
    allowFailure: true,
    input: `${candidateFiles.join('\n')}\n`,
  });

  if (code !== 0 && code !== 1) {
    throw new Error(`git check-ignore failed with exit code ${code}.\n${stdout}`);
  }

  return new Set(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

async function ensureRatArchive(archiveFile) {
  if (await hasVerifiedArchive(archiveFile)) {
    console.log(`Reusing cached Apache RAT ${RAT_VERSION} archive from ${archiveFile}`);
    return;
  }

  const downloadFilePath = `${archiveFile}.${process.pid}.${Date.now()}.download`;

  try {
    await downloadFile(RAT_ARCHIVE_URL, downloadFilePath);
    await verifySha512(downloadFilePath, RAT_ARCHIVE_SHA512);
    await rename(downloadFilePath, archiveFile);
  } finally {
    await rm(downloadFilePath, { force: true });
  }

  await verifySha512(archiveFile, RAT_ARCHIVE_SHA512);
}

async function hasVerifiedArchive(archiveFile) {
  try {
    await access(archiveFile);
  } catch {
    return false;
  }

  try {
    await verifySha512(archiveFile, RAT_ARCHIVE_SHA512);
    return true;
  } catch {
    await rm(archiveFile, { force: true });
    return false;
  }
}

async function ensureJava21() {
  const versionOutput = await captureCombinedOutput(JAVA_BIN, ['-version']);
  const version = parseJavaMajor(versionOutput);
  if (version < 21) {
    throw new Error(`Apache RAT requires Java 21 or newer, but found Java ${version}.`);
  }
}

function parseJavaMajor(versionOutput) {
  const match = /version "([0-9]+)(?:\.[^"]*)?"/.exec(versionOutput);
  if (!match) {
    throw new Error(`Unable to determine Java version from output:\n${versionOutput}`);
  }
  return Number.parseInt(match[1], 10);
}

async function downloadFile(url, destinationFile) {
  console.log(`Downloading Apache RAT ${RAT_VERSION} from ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(destinationFile));
}

async function verifySha512(filePath, expectedSha512) {
  const actualSha512 = createHash('sha512')
    .update(await readFile(filePath))
    .digest('hex');
  if (actualSha512 !== expectedSha512) {
    throw new Error(
      `SHA-512 mismatch for ${filePath}. Expected ${expectedSha512}, found ${actualSha512}.`,
    );
  }
}

async function ensureCommandOnPath(command) {
  try {
    await runProcess(command, ['--version'], { stdout: 'ignore', stderr: 'ignore' });
  } catch {
    throw new Error(`Required command '${command}' is not available on PATH.`);
  }
}

async function loadExclusions(exclusionsFile) {
  const contents = await readFile(exclusionsFile, 'utf8');
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) =>
      line.startsWith('%regex[') && line.endsWith(']')
        ? { type: 'regex', value: new RegExp(line.slice(7, -1)) }
        : { type: 'exact', value: line },
    );
}

function matchesAnyExclusion(filePath, exclusions) {
  return exclusions.some((exclusion) => {
    if (exclusion.type === 'regex') {
      return exclusion.value.test(filePath);
    }

    return exclusion.value === filePath;
  });
}

async function captureCombinedOutput(command, args) {
  const { stdout, stderr } = await spawnProcess(command, args, { allowFailure: false });
  return `${stdout}${stderr}`.trim();
}

async function runProcess(command, args, options = {}) {
  await spawnProcess(command, args, options);
}

async function spawnProcess(command, args, options = {}) {
  const { allowFailure = false, input, stdout = 'pipe', stderr = 'pipe' } = options;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', stdout, stderr] });
    let out = '';
    let err = '';
    child.stdin?.end(input);
    child.stdout?.on('data', (chunk) => {
      out += chunk;
      if (stdout === 'inherit') {
        process.stdout.write(chunk);
      }
    });
    child.stderr?.on('data', (chunk) => {
      err += chunk;
      if (stderr === 'inherit') {
        process.stderr.write(chunk);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || allowFailure) {
        resolve({ stdout: out, stderr: err, code: code ?? 0 });
        return;
      }
      reject(
        new Error(`${command} ${args.join(' ')} failed with exit code ${code}.\n${out}${err}`),
      );
    });
  });
}

await main();
