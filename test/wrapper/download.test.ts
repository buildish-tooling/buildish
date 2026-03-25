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
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { HttpHeadersByHost } from '../../src/ci/types';
import type { NormalizedActionConfig } from '../../src/config/types';
import { deriveWrapperDownloadPlan, provisionWrapperJars } from '../../src/wrapper/download';
import { validateTargetWrapperProperties } from '../../src/wrapper/static-validation';
import type { ValidatedWrapperPropertiesFile } from '../../src/wrapper/types';

describe('deriveWrapperDownloadPlan', () => {
  it('maps two-segment distribution versions to three-segment Gradle source tags', async () => {
    await withValidatedWrappers(
      {
        'gradle/wrapper/gradle-wrapper.properties': validWrapperProperties({
          distributionUrl: 'https\\://services.gradle.org/distributions/gradle-8.14-bin.zip',
        }),
      },
      async ([wrapper]) => {
        expect(deriveWrapperDownloadPlan(wrapper)).toEqual({
          relativePath: 'gradle/wrapper/gradle-wrapper.properties',
          distributionVersion: '8.14',
          wrapperSourceVersion: '8.14.0',
          wrapperChecksumUrl:
            'https://services.gradle.org/distributions/gradle-8.14-wrapper.jar.sha256',
          wrapperJarUrl:
            'https://raw.githubusercontent.com/gradle/gradle/v8.14.0/gradle/wrapper/gradle-wrapper.jar',
        });
      },
    );
  });

  it('preserves three-segment distribution versions for the Gradle source tag', async () => {
    await withValidatedWrappers(
      {
        'gradle/wrapper/gradle-wrapper.properties': validWrapperProperties({
          distributionUrl: 'https\\://services.gradle.org/distributions/gradle-9.4.1-bin.zip',
        }),
      },
      async ([wrapper]) => {
        expect(deriveWrapperDownloadPlan(wrapper).wrapperJarUrl).toBe(
          'https://raw.githubusercontent.com/gradle/gradle/v9.4.1/gradle/wrapper/gradle-wrapper.jar',
        );
      },
    );
  });
});

describe('provisionWrapperJars', () => {
  it('downloads, verifies, and writes the wrapper jar beside the properties file', async () => {
    await withValidatedWrappers(
      {
        'gradle/wrapper/gradle-wrapper.properties': validWrapperProperties(),
      },
      async ([wrapper]) => {
        const jarBytes = Buffer.from('verified wrapper jar');
        const jarSha256 = sha256(jarBytes);

        const provisioned = await provisionWrapperJars([wrapper], {
          fetchImpl: async (input: string | URL | Request): Promise<Response> => {
            const url = String(input);

            if (url.endsWith('gradle-8.14-wrapper.jar.sha256')) {
              return new Response(`${jarSha256}\n`, { status: 200 });
            }

            if (url.endsWith('/v8.14.0/gradle/wrapper/gradle-wrapper.jar')) {
              return new Response(jarBytes, { status: 200 });
            }

            throw new Error(`Unexpected fetch URL: ${url}`);
          },
        });

        expect(provisioned).toHaveLength(1);
        expect(provisioned[0]).toMatchObject({
          distributionVersion: '8.14',
          wrapperSourceVersion: '8.14.0',
          expectedWrapperJarSha256: jarSha256,
          wasDownloaded: true,
        });
        await expect(
          readFile(path.join(path.dirname(wrapper.absolutePath), 'gradle-wrapper.jar')),
        ).resolves.toEqual(jarBytes);
      },
    );
  });

  it('uses the authenticated GitHub API wrapper download when exact-host headers are available', async () => {
    await withValidatedWrappers(
      {
        'gradle/wrapper/gradle-wrapper.properties': validWrapperProperties(),
      },
      async ([wrapper]) => {
        const jarBytes = Buffer.from('verified wrapper jar');
        const jarSha256 = sha256(jarBytes);
        const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);

          if (url.endsWith('gradle-8.14-wrapper.jar.sha256')) {
            expect(init).toBeUndefined();
            return new Response(`${jarSha256}\n`, { status: 200 });
          }

          if (
            url ===
            'https://api.github.com/repos/gradle/gradle/contents/gradle/wrapper/gradle-wrapper.jar?ref=v8.14.0'
          ) {
            const headers = new Headers(init?.headers);
            expect(headers.get('authorization')).toBe('Bearer ghs_test_token');
            expect(headers.get('accept')).toBe('application/vnd.github.raw');
            expect(headers.get('x-github-api-version')).toBe('2022-11-28');
            return new Response(jarBytes, { status: 200 });
          }

          throw new Error(`Unexpected fetch URL: ${url}`);
        });

        const provisioned = await provisionWrapperJars([wrapper], {
          fetchImpl,
          httpHeadersByHost: createHttpHeadersByHost('api.github.com', {
            accept: 'application/vnd.github.raw',
            authorization: 'Bearer ghs_test_token',
            'x-github-api-version': '2022-11-28',
          }),
        });

        expect(provisioned[0]?.wasDownloaded).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      },
    );
  });

  it('retries transient HTTP failures and succeeds on a later attempt', async () => {
    await withValidatedWrappers(
      {
        'gradle/wrapper/gradle-wrapper.properties': validWrapperProperties(),
      },
      async ([wrapper]) => {
        const jarBytes = Buffer.from('verified wrapper jar');
        const jarSha256 = sha256(jarBytes);
        const logRetry = vi.fn();
        const sleep = vi.fn(async (_milliseconds: number) => {});
        let checksumAttempts = 0;

        const provisioned = await provisionWrapperJars([wrapper], {
          logRetry,
          sleep,
          retryDelayMs: 5,
          fetchImpl: async (input: string | URL | Request): Promise<Response> => {
            const url = String(input);

            if (url.endsWith('gradle-8.14-wrapper.jar.sha256')) {
              checksumAttempts += 1;
              return checksumAttempts === 1
                ? new Response('temporary failure', { status: 503 })
                : new Response(`${jarSha256}\n`, { status: 200 });
            }

            if (url.endsWith('/v8.14.0/gradle/wrapper/gradle-wrapper.jar')) {
              return new Response(jarBytes, { status: 200 });
            }

            throw new Error(`Unexpected fetch URL: ${url}`);
          },
        });

        expect(provisioned[0]?.wasDownloaded).toBe(true);
        expect(checksumAttempts).toBe(2);
        expect(logRetry).toHaveBeenCalledOnce();
        expect(logRetry).toHaveBeenCalledWith(
          "Retrying download of wrapper checksum for 'gradle/wrapper/gradle-wrapper.properties' after attempt 1 of 3 failed with HTTP 503; waiting 5ms before retrying.",
        );
        expect(sleep).toHaveBeenCalledOnce();
        expect(sleep).toHaveBeenCalledWith(5);
      },
    );
  });

  it('honors Retry-After when the wrapper jar download is throttled', async () => {
    await withValidatedWrappers(
      {
        'gradle/wrapper/gradle-wrapper.properties': validWrapperProperties(),
      },
      async ([wrapper]) => {
        const jarBytes = Buffer.from('verified wrapper jar');
        const jarSha256 = sha256(jarBytes);
        const logRetry = vi.fn();
        const sleep = vi.fn(async (_milliseconds: number) => {});
        let jarAttempts = 0;

        const provisioned = await provisionWrapperJars([wrapper], {
          logRetry,
          sleep,
          retryDelayMs: 5,
          fetchImpl: async (input: string | URL | Request): Promise<Response> => {
            const url = String(input);

            if (url.endsWith('gradle-8.14-wrapper.jar.sha256')) {
              return new Response(`${jarSha256}\n`, { status: 200 });
            }

            if (url.endsWith('/v8.14.0/gradle/wrapper/gradle-wrapper.jar')) {
              jarAttempts += 1;
              return jarAttempts === 1
                ? new Response('rate limited', {
                    status: 429,
                    headers: { 'retry-after': '7' },
                  })
                : new Response(jarBytes, { status: 200 });
            }

            throw new Error(`Unexpected fetch URL: ${url}`);
          },
        });

        expect(provisioned[0]?.wasDownloaded).toBe(true);
        expect(jarAttempts).toBe(2);
        expect(logRetry).toHaveBeenCalledOnce();
        expect(logRetry).toHaveBeenCalledWith(
          "Retrying download of wrapper JAR for 'gradle/wrapper/gradle-wrapper.properties' after attempt 1 of 3 failed with HTTP 429; waiting 7000ms before retrying.",
        );
        expect(sleep).toHaveBeenCalledOnce();
        expect(sleep).toHaveBeenCalledWith(7000);
      },
    );
  });

  it('fails fast on a 404 checksum response without retrying', async () => {
    await withValidatedWrappers(
      {
        'gradle/wrapper/gradle-wrapper.properties': validWrapperProperties(),
      },
      async ([wrapper]) => {
        const logRetry = vi.fn();
        const sleep = vi.fn(async (_milliseconds: number) => {});
        const fetchImpl = vi.fn(async (_input: string | URL | Request): Promise<Response> => {
          return new Response('not found', { status: 404 });
        });

        await expect(
          provisionWrapperJars([wrapper], {
            fetchImpl,
            logRetry,
            sleep,
          }),
        ).rejects.toThrow(/404 Not Found/);

        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(logRetry).not.toHaveBeenCalled();
        expect(sleep).not.toHaveBeenCalled();
      },
    );
  });

  it('rejects checksum mismatches and leaves no temporary files behind', async () => {
    await withValidatedWrappers(
      {
        'gradle/wrapper/gradle-wrapper.properties': validWrapperProperties(),
      },
      async ([wrapper]) => {
        const wrapperDirectory = path.dirname(wrapper.absolutePath);

        await expect(
          provisionWrapperJars([wrapper], {
            fetchImpl: async (input: string | URL | Request): Promise<Response> => {
              const url = String(input);

              if (url.endsWith('gradle-8.14-wrapper.jar.sha256')) {
                return new Response(`${'a'.repeat(64)}\n`, { status: 200 });
              }

              if (url.endsWith('/v8.14.0/gradle/wrapper/gradle-wrapper.jar')) {
                return new Response(Buffer.from('mismatched wrapper jar'), { status: 200 });
              }

              throw new Error(`Unexpected fetch URL: ${url}`);
            },
          }),
        ).rejects.toThrow(/failed checksum verification/);

        expect(await readdir(wrapperDirectory)).toEqual(['gradle-wrapper.properties']);
      },
    );
  });
});

const baseConfig: NormalizedActionConfig = {
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
};

async function withValidatedWrappers(
  files: Record<string, string>,
  testBody: (wrappers: readonly ValidatedWrapperPropertiesFile[]) => Promise<void>,
): Promise<void> {
  await withWorkspace(files, async (workspace) => {
    const wrappers = await validateTargetWrapperProperties(baseConfig, workspace);
    await testBody(wrappers);
  });
}

async function withWorkspace(
  files: Record<string, string>,
  testBody: (workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cache-gradle-wrapper-download-'));

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

function validWrapperProperties(overrides: Record<string, string> = {}): string {
  const properties = {
    distributionBase: 'GRADLE_USER_HOME',
    distributionPath: 'wrapper/dists',
    distributionSha256Sum: '61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
    distributionUrl: 'https\\://services.gradle.org/distributions/gradle-8.14-bin.zip',
    validateDistributionUrl: 'true',
    zipStoreBase: 'GRADLE_USER_HOME',
    zipStorePath: 'wrapper/dists',
    ...overrides,
  };

  return `${Object.entries(properties)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`;
}

function sha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

function createHttpHeadersByHost(
  host: string,
  headers: Record<string, string>,
): HttpHeadersByHost {
  return new Map([[host, new Map(Object.entries(headers))]]);
}
