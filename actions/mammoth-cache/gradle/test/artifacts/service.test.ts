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
import { cp } from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PORTABLE_GRADLE_USER_HOME,
  createDeltaArtifactName,
  deserializeDeltaArtifactPackageMetadata,
  downloadAndVerifyDeltaArtifactPackage,
  findDeltaArtifactByProducerJob,
  stageDeltaArtifactPackage,
  type WorkflowArtifactApi,
  type WorkflowArtifactDescriptor,
  uploadDeltaArtifactPackage,
  verifyExtractedDeltaArtifactPackage,
} from '../../src/artifacts/service';
import { captureCacheManifest, computeCacheDelta } from '../../src/cache/manifest';
import { createCachePartitions, type CacheModel } from '../../src/cache/model';
import type { CiJobContext } from '../../src/ci/types';

describe('artifact exchange service', () => {
  const temporaryDirectories = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...temporaryDirectories].map(async (directory) => {
        temporaryDirectories.delete(directory);
        await rm(directory, { recursive: true, force: true });
      }),
    );
  });

  it('creates a deterministic human-readable artifact name', async () => {
    const gradleUserHome = await createTempDirectory(
      temporaryDirectories,
      'buildish-mammoth-cache-gradle-artifact-name-',
    );
    const cacheModel = createFixtureCacheModel(gradleUserHome);

    await writeGradleFile(
      gradleUserHome,
      'caches/modules-2/files-2.1/org/example/module.bin',
      'before',
    );
    const previousManifest = await captureCacheManifest(cacheModel);

    await writeGradleFile(
      gradleUserHome,
      'caches/modules-2/files-2.1/org/example/module.bin',
      'after',
    );
    const currentManifest = await captureCacheManifest(cacheModel);
    const deltaManifest = computeCacheDelta(previousManifest, currentManifest);

    const artifactName = createDeltaArtifactName(
      createFixtureCiContext(),
      cacheModel,
      deltaManifest,
    );

    expect(artifactName).toMatch(
      /^buildish-mammoth-cache-gradle-delta-gradle-worker-run-12345-attempt-2-[a-f0-9]{12}-[a-f0-9]{12}$/u,
    );
    expect(artifactName).toBe(
      createDeltaArtifactName(createFixtureCiContext(), cacheModel, deltaManifest),
    );
  });

  it('stages, uploads, locates, downloads, and verifies a portable delta artifact package', async () => {
    const gradleUserHome = await createTempDirectory(
      temporaryDirectories,
      'buildish-mammoth-cache-gradle-stage-',
    );
    const cacheModel = createFixtureCacheModel(gradleUserHome);
    const ciContext = createFixtureCiContext();

    await writeGradleFile(
      gradleUserHome,
      'caches/modules-2/files-2.1/org/example/module.bin',
      'before',
    );
    await writeGradleFile(gradleUserHome, 'wrapper/dists/gradle-8.10/bin.zip', 'delete-me');
    const previousManifest = await captureCacheManifest(cacheModel);

    await writeGradleFile(
      gradleUserHome,
      'caches/modules-2/files-2.1/org/example/module.bin',
      'after',
    );
    await writeGradleFile(
      gradleUserHome,
      'caches/build-cache-1/output.bin',
      'new-build-cache-entry',
    );
    await rm(path.join(gradleUserHome, 'wrapper/dists/gradle-8.10/bin.zip'));
    const currentManifest = await captureCacheManifest(cacheModel);
    const deltaManifest = computeCacheDelta(previousManifest, currentManifest);

    const stagedPackage = await stageDeltaArtifactPackage(ciContext, cacheModel, deltaManifest, {
      parentDirectory: await createTempDirectory(
        temporaryDirectories,
        'buildish-mammoth-cache-gradle-stage-parent-',
      ),
    });

    expect(stagedPackage.metadata.payloadEntries).toHaveLength(2);
    expect(stagedPackage.metadata.payloadEntries.map((entry) => entry.relativePath)).toEqual([
      'caches/build-cache-1/output.bin',
      'caches/modules-2/files-2.1/org/example/module.bin',
    ]);

    const serializedPortableManifest = await readFile(stagedPackage.deltaManifestPath, 'utf8');
    expect(serializedPortableManifest).toContain(PORTABLE_GRADLE_USER_HOME);
    expect(serializedPortableManifest).not.toContain(gradleUserHome);

    const serializedMetadata = await readFile(stagedPackage.metadataPath, 'utf8');
    const metadata = deserializeDeltaArtifactPackageMetadata(serializedMetadata);
    expect(metadata.artifactName).toBe(stagedPackage.artifactName);
    expect(metadata.producer.cacheKey).toBe(cacheModel.cacheKey);
    const rawMetadata = JSON.parse(serializedMetadata) as {
      producer: Record<string, unknown>;
    };
    expect(Object.keys(rawMetadata.producer).sort()).toEqual([
      'cacheKey',
      'jobName',
      'repository',
      'runAttempt',
      'runId',
      'runnerArch',
      'runnerOs',
      'safeRefName',
      'workflowName',
    ]);
    expect(rawMetadata.producer).not.toHaveProperty('platform');
    expect(rawMetadata.producer).not.toHaveProperty('provider');

    const fakeApi = new FakeArtifactApi(
      await createTempDirectory(
        temporaryDirectories,
        'buildish-mammoth-cache-gradle-artifact-store-',
      ),
    );
    const uploadedPackage = await uploadDeltaArtifactPackage(fakeApi, stagedPackage);
    const locatedArtifact = await findDeltaArtifactByProducerJob(
      fakeApi,
      ciContext.jobName,
      ciContext.runId,
      ciContext.runAttempt,
    );
    expect(locatedArtifact.id).toBe(uploadedPackage.artifact.id);

    const downloadedPackage = await downloadAndVerifyDeltaArtifactPackage(
      fakeApi,
      locatedArtifact,
      {
        parentDirectory: await createTempDirectory(
          temporaryDirectories,
          'buildish-mammoth-cache-gradle-download-parent-',
        ),
      },
    );

    expect(downloadedPackage.deltaManifest.gradleUserHome).toBe(PORTABLE_GRADLE_USER_HOME);
    expect(downloadedPackage.metadata.deltaManifestSha256).toBe(metadata.deltaManifestSha256);
    expect(downloadedPackage.metadata.payloadEntries).toEqual(metadata.payloadEntries);
  });

  it('rejects tampered payload content during verification', async () => {
    const stagedPackage = await createStagedDeltaFixture(temporaryDirectories);
    await writeFile(path.join(stagedPackage.rootDirectory, 'payload/000001.bin'), 'other');

    await expect(
      verifyExtractedDeltaArtifactPackage(stagedPackage.rootDirectory, stagedPackage.artifactName),
    ).rejects.toThrow(/SHA-256 verification/u);
  });

  it('rejects metadata path traversal in downloaded packages', async () => {
    const stagedPackage = await createStagedDeltaFixture(temporaryDirectories);
    const metadata = deserializeDeltaArtifactPackageMetadata(
      await readFile(stagedPackage.metadataPath, 'utf8'),
    );

    await writeFile(
      stagedPackage.metadataPath,
      `${JSON.stringify({
        ...metadata,
        payloadEntries: [{ ...metadata.payloadEntries[0], payloadPath: '../escape.bin' }],
      })}\n`,
    );

    await expect(
      verifyExtractedDeltaArtifactPackage(stagedPackage.rootDirectory, stagedPackage.artifactName),
    ).rejects.toThrow(/normalized relative POSIX path/u);
  });

  it('fails staging when source files drift after the delta manifest was captured', async () => {
    const gradleUserHome = await createTempDirectory(
      temporaryDirectories,
      'buildish-mammoth-cache-gradle-drift-',
    );
    const cacheModel = createFixtureCacheModel(gradleUserHome);

    await writeGradleFile(
      gradleUserHome,
      'caches/modules-2/files-2.1/org/example/module.bin',
      'before',
    );
    const previousManifest = await captureCacheManifest(cacheModel);

    await writeGradleFile(
      gradleUserHome,
      'caches/modules-2/files-2.1/org/example/module.bin',
      'after',
    );
    const currentManifest = await captureCacheManifest(cacheModel);
    const deltaManifest = computeCacheDelta(previousManifest, currentManifest);

    await writeGradleFile(
      gradleUserHome,
      'caches/modules-2/files-2.1/org/example/module.bin',
      'after-but-different',
    );

    await expect(
      stageDeltaArtifactPackage(createFixtureCiContext(), cacheModel, deltaManifest, {
        parentDirectory: await createTempDirectory(
          temporaryDirectories,
          'buildish-mammoth-cache-gradle-drift-parent-',
        ),
      }),
    ).rejects.toThrow(/captured manifest snapshot|content drift/u);
  });
});

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
    const id = this.nextId++;
    const directory = path.join(this.storageRoot, String(id));
    await cp(rootDirectory, directory, { recursive: true });

    const descriptor: WorkflowArtifactDescriptor = {
      id,
      name,
      size: 0,
      digest: createHash('sha256').update(`${name}:${id}`).digest('hex'),
    };
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
    options?: { readonly path?: string; readonly expectedHash?: string },
  ): Promise<{ readonly downloadPath: string; readonly digestMismatch: boolean }> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) {
      throw new Error(`Artifact '${artifactId}' not found.`);
    }

    const parentDirectory = options?.path ?? this.storageRoot;
    const downloadPath = path.join(parentDirectory, `artifact-${artifactId}`);
    await cp(artifact.directory, downloadPath, { recursive: true });

    return {
      downloadPath,
      digestMismatch:
        options?.expectedHash !== undefined && options.expectedHash !== artifact.descriptor.digest,
    };
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

async function createStagedDeltaFixture(temporaryDirectories: Set<string>) {
  const gradleUserHome = await createTempDirectory(
    temporaryDirectories,
    'buildish-mammoth-cache-gradle-fixture-',
  );
  const cacheModel = createFixtureCacheModel(gradleUserHome);

  await writeGradleFile(
    gradleUserHome,
    'caches/modules-2/files-2.1/org/example/module.bin',
    'before',
  );
  const previousManifest = await captureCacheManifest(cacheModel);

  await writeGradleFile(
    gradleUserHome,
    'caches/modules-2/files-2.1/org/example/module.bin',
    'after',
  );
  const currentManifest = await captureCacheManifest(cacheModel);
  const deltaManifest = computeCacheDelta(previousManifest, currentManifest);

  return stageDeltaArtifactPackage(createFixtureCiContext(), cacheModel, deltaManifest, {
    parentDirectory: await createTempDirectory(
      temporaryDirectories,
      'buildish-mammoth-cache-gradle-fixture-parent-',
    ),
  });
}

function createFixtureCacheModel(gradleUserHome: string): CacheModel {
  const partitions = createCachePartitions(gradleUserHome);

  return {
    cacheKey: 'buildish-mammoth-gradle-cache-v1:21:linux:x64:main',
    javaMajor: 21,
    runnerOs: 'linux',
    runnerArch: 'x64',
    safeRefName: 'main',
    partitionFingerprint: 'fixture-partitions',
    partitions,
    includePaths: partitions.flatMap((partition) => partition.absoluteIncludeGlobs),
    excludePaths: [...new Set(partitions.flatMap((partition) => partition.absoluteExcludeGlobs))],
  };
}

function createFixtureCiContext(): CiJobContext {
  return {
    eventName: 'push',
    resolvedRefName: 'main',
    safeRefName: 'main',
    runnerOs: 'linux',
    runnerArch: 'x64',
    defaultBranch: 'main',
    isPullRequest: false,
    repository: 'apache/buildish',
    workflowName: 'CI',
    jobName: 'Gradle Worker',
    runId: 12345,
    runAttempt: 2,
    tempDirectory: null,
    workspace: '/tmp/workspace',
    actionPath: null,
  };
}

async function createTempDirectory(
  temporaryDirectories: Set<string>,
  prefix: string,
): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

async function writeGradleFile(
  gradleUserHome: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const absolutePath = path.join(gradleUserHome, ...relativePath.split('/'));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}
