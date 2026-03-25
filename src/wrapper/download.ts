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

import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleepTimeout } from 'node:timers/promises';

import type {
  ProvisionedWrapperJar,
  ValidatedWrapperPropertiesFile,
  WrapperDownloadPlan,
} from './types';

const DISTRIBUTION_HOST = 'services.gradle.org';
const DISTRIBUTION_PATH_PATTERN =
  /^\/distributions\/gradle-([0-9]+(?:\.[0-9]+){1,2})-[A-Za-z][A-Za-z0-9-]*\.zip$/u;
const SHA256_PATTERN = /^[A-Fa-f0-9]{64}$/;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

export interface WrapperProvisionOptions {
  /**
   * Optional HTTP fetch implementation override.
   *
   * Defaults to the runtime global `fetch` when omitted.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Optional sleep implementation used between retry attempts.
   *
   * Defaults to the internal timer-based sleep helper when omitted.
   */
  readonly sleep?: (milliseconds: number) => Promise<unknown>;
  /**
   * Maximum number of download attempts per resource.
   *
   * Defaults to `3` and must be an integer between `1` and `10` inclusive.
   */
  readonly retryAttempts?: number;
  /**
   * Base retry delay in milliseconds before exponential backoff is applied.
   *
   * Defaults to `1000` and must be an integer between `0` and `60000` inclusive.
   */
  readonly retryDelayMs?: number;
}

/**
 * Maps a validated distribution URL to the remote resources needed to provision a trusted
 * wrapper JAR.
 */
export function deriveWrapperDownloadPlan(
  wrapper: ValidatedWrapperPropertiesFile,
): WrapperDownloadPlan {
  const distributionUrl = parseDistributionUrl(wrapper);
  const distributionVersion = extractDistributionVersion(
    distributionUrl.pathname,
    wrapper.relativePath,
  );
  const wrapperSourceVersion = normalizeWrapperSourceVersion(
    distributionVersion,
    wrapper.relativePath,
  );

  return {
    relativePath: wrapper.relativePath,
    distributionVersion,
    wrapperSourceVersion,
    wrapperChecksumUrl: `https://${DISTRIBUTION_HOST}/distributions/gradle-${distributionVersion}-wrapper.jar.sha256`,
    wrapperJarUrl: `https://raw.githubusercontent.com/gradle/gradle/v${wrapperSourceVersion}/gradle/wrapper/gradle-wrapper.jar`,
  };
}

/**
 * Ensures each targeted wrapper has a verified `gradle-wrapper.jar` beside its properties file.
 */
export async function provisionWrapperJars(
  wrappers: readonly ValidatedWrapperPropertiesFile[],
  options: WrapperProvisionOptions = {},
): Promise<readonly ProvisionedWrapperJar[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retryAttempts = validateRetryAttempts(options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS);
  const retryDelayMs = validateRetryDelay(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const checksumCache = new Map<string, Promise<string>>();
  const jarCache = new Map<string, Promise<Uint8Array>>();
  const results: ProvisionedWrapperJar[] = [];

  for (const wrapper of wrappers) {
    const plan = deriveWrapperDownloadPlan(wrapper);
    const expectedWrapperJarSha256 = await getOrCreate(
      checksumCache,
      plan.wrapperChecksumUrl,
      async () =>
        await downloadExpectedWrapperJarSha256(plan, fetchImpl, sleep, retryAttempts, retryDelayMs),
    );
    const wrapperJarAbsolutePath = path.join(
      path.dirname(wrapper.absolutePath),
      'gradle-wrapper.jar',
    );
    const existingJarMatches = await doesExistingWrapperJarMatch(
      wrapperJarAbsolutePath,
      expectedWrapperJarSha256,
      wrapper.relativePath,
    );
    let wasDownloaded = false;

    if (!existingJarMatches) {
      const jarBytes = await getOrCreate(
        jarCache,
        plan.wrapperJarUrl,
        async () => await downloadWrapperJar(plan, fetchImpl, sleep, retryAttempts, retryDelayMs),
      );
      const downloadedJarSha256 = computeSha256(jarBytes);

      if (downloadedJarSha256 !== expectedWrapperJarSha256) {
        throw new Error(
          `Downloaded wrapper JAR for '${wrapper.relativePath}' failed checksum verification.`,
        );
      }

      await placeWrapperJarAtomically(wrapperJarAbsolutePath, jarBytes);
      wasDownloaded = true;
    }

    results.push({
      ...plan,
      wrapperJarRelativePath: wrapper.wrapperJarRelativePath,
      wrapperJarAbsolutePath,
      expectedWrapperJarSha256,
      wasDownloaded,
    });
  }

  return results;
}

function parseDistributionUrl(wrapper: ValidatedWrapperPropertiesFile): URL {
  let distributionUrl: URL;

  try {
    distributionUrl = new URL(wrapper.distributionUrl);
  } catch {
    throw new Error(
      `Wrapper properties file '${wrapper.relativePath}' has an invalid distributionUrl.`,
    );
  }

  if (
    distributionUrl.protocol !== 'https:' ||
    distributionUrl.hostname !== DISTRIBUTION_HOST ||
    distributionUrl.port.length > 0 ||
    distributionUrl.username.length > 0 ||
    distributionUrl.password.length > 0 ||
    distributionUrl.search.length > 0 ||
    distributionUrl.hash.length > 0
  ) {
    throw new Error(
      `Wrapper properties file '${wrapper.relativePath}' must use a canonical HTTPS services.gradle.org distributionUrl without credentials, query parameters, or fragments.`,
    );
  }

  return distributionUrl;
}

function extractDistributionVersion(pathname: string, relativePath: string): string {
  const match = DISTRIBUTION_PATH_PATTERN.exec(pathname);

  if (!match) {
    throw new Error(
      `Wrapper properties file '${relativePath}' must use a supported Gradle distributionUrl ending in 'gradle-<version>-bin.zip' or 'gradle-<version>-all.zip'.`,
    );
  }

  return match[1];
}

function normalizeWrapperSourceVersion(distributionVersion: string, relativePath: string): string {
  const segments = distributionVersion.split('.');

  if (segments.length === 2) {
    return `${distributionVersion}.0`;
  }

  if (segments.length === 3) {
    return distributionVersion;
  }

  throw new Error(
    `Wrapper properties file '${relativePath}' uses unsupported Gradle version '${distributionVersion}'. Expected a major.minor or major.minor.patch version.`,
  );
}

async function downloadExpectedWrapperJarSha256(
  plan: WrapperDownloadPlan,
  fetchImpl: typeof fetch,
  sleep: (milliseconds: number) => Promise<unknown>,
  retryAttempts: number,
  retryDelayMs: number,
): Promise<string> {
  const response = await fetchWithRetries(
    plan.wrapperChecksumUrl,
    fetchImpl,
    sleep,
    retryAttempts,
    retryDelayMs,
    `wrapper checksum for '${plan.relativePath}'`,
  );
  const checksum = (await response.text()).trim();

  if (!SHA256_PATTERN.test(checksum)) {
    throw new Error(
      `Wrapper checksum response for '${plan.relativePath}' was not a valid SHA-256.`,
    );
  }

  return checksum.toLowerCase();
}

async function downloadWrapperJar(
  plan: WrapperDownloadPlan,
  fetchImpl: typeof fetch,
  sleep: (milliseconds: number) => Promise<unknown>,
  retryAttempts: number,
  retryDelayMs: number,
): Promise<Uint8Array> {
  const response = await fetchWithRetries(
    plan.wrapperJarUrl,
    fetchImpl,
    sleep,
    retryAttempts,
    retryDelayMs,
    `wrapper JAR for '${plan.relativePath}'`,
  );
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchWithRetries(
  url: string,
  fetchImpl: typeof fetch,
  sleep: (milliseconds: number) => Promise<unknown>,
  retryAttempts: number,
  retryDelayMs: number,
  resourceDescription: string,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url);

      if (response.ok) {
        return response;
      }

      if (response.status === 404) {
        throw new Error(
          `Could not download ${resourceDescription}: '${url}' returned 404 Not Found.`,
        );
      }

      lastError = new Error(
        `Could not download ${resourceDescription}: '${url}' returned HTTP ${response.status}.`,
      );
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (lastError.message.includes('404 Not Found')) {
        throw lastError;
      }
    }

    if (attempt < retryAttempts) {
      await sleep(retryDelayMs * 2 ** (attempt - 1));
    }
  }

  throw lastError ?? new Error(`Could not download ${resourceDescription}.`);
}

async function doesExistingWrapperJarMatch(
  wrapperJarAbsolutePath: string,
  expectedWrapperJarSha256: string,
  relativePath: string,
): Promise<boolean> {
  let stats;
  try {
    stats = await lstat(wrapperJarAbsolutePath);
  } catch {
    return false;
  }

  if (stats.isSymbolicLink()) {
    throw new Error(
      `Existing wrapper JAR for '${relativePath}' must not be a symbolic link: '${wrapperJarAbsolutePath}'.`,
    );
  }

  if (!stats.isFile()) {
    throw new Error(
      `Existing wrapper JAR for '${relativePath}' must be a regular file: '${wrapperJarAbsolutePath}'.`,
    );
  }

  const existingContents = await readFile(wrapperJarAbsolutePath);
  return computeSha256(existingContents) === expectedWrapperJarSha256;
}

async function placeWrapperJarAtomically(
  wrapperJarAbsolutePath: string,
  jarBytes: Uint8Array,
): Promise<void> {
  const directory = path.dirname(wrapperJarAbsolutePath);
  const temporaryPath = path.join(directory, `.gradle-wrapper.${randomUUID()}.tmp`);

  await mkdir(directory, { recursive: true });

  try {
    await writeFile(temporaryPath, jarBytes, { flag: 'wx' });

    try {
      await rename(temporaryPath, wrapperJarAbsolutePath);
    } catch (error) {
      if (!isReplaceTargetError(error)) {
        throw error;
      }

      await rm(wrapperJarAbsolutePath, { force: true });
      await rename(temporaryPath, wrapperJarAbsolutePath);
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function computeSha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

function isReplaceTargetError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES';
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await sleepTimeout(milliseconds);
}

function validateRetryAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error('retryAttempts must be an integer between 1 and 10.');
  }

  return value;
}

function validateRetryDelay(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 60_000) {
    throw new Error('retryDelayMs must be an integer between 0 and 60000.');
  }

  return value;
}

function getOrCreate<T>(
  map: Map<string, Promise<T>>,
  key: string,
  createValue: () => Promise<T>,
): Promise<T> {
  const existingValue = map.get(key);

  if (existingValue) {
    return existingValue;
  }

  const createdValue = createValue();
  map.set(key, createdValue);
  return createdValue;
}
