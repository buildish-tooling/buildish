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
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  type CacheDeltaEntry,
  type CacheDeltaManifest,
  type CacheFileSnapshot,
  deserializeCacheDeltaManifest,
  serializeCacheDeltaManifest,
} from '../cache/manifest';
import type { CacheModel } from '../cache/model';
import type { CiJobContext } from '../ci/types';
import type {
  ArtifactLookupOptions,
  WorkflowArtifactBackend,
  WorkflowArtifactDescriptor,
} from '../storage/artifacts';
import {
  parseSerializedJsonObject,
  validateArray,
  validateLowercaseSha256 as validateSha256,
  validateNonNegativeInteger,
  validateNonNegativeNumber,
  validateNormalizedRelativePosixPath,
  validateRecord,
  validateString,
} from '../validation';

export const DELTA_ARTIFACT_PACKAGE_SCHEMA_VERSION = 1;
export const PORTABLE_GRADLE_USER_HOME = '<portable-gradle-user-home>';

const DELTA_ARTIFACT_NAME_PREFIX = 'buildish-mammoth-cache-gradle-delta';
const DELTA_PACKAGE_METADATA_FILE = 'delta-package.json';
const DELTA_PACKAGE_MANIFEST_FILE = 'delta-manifest.json';
const DELTA_PACKAGE_PAYLOAD_DIRECTORY = 'payload';
const DEFAULT_ARTIFACT_COMPRESSION_LEVEL = 1;
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

/**
 * Back-compat alias for the provider-neutral artifact descriptor.
 */
export type { WorkflowArtifactDescriptor };

/**
 * Producer metadata embedded in a delta artifact package.
 */
export interface DeltaArtifactProducerMetadata {
  readonly repository: string;
  readonly workflowName: string;
  readonly jobName: string;
  readonly runId: number | null;
  readonly runAttempt: number | null;
  readonly runnerOs: string;
  readonly runnerArch: string;
  readonly safeRefName: string;
  readonly cacheKey: string;
}

/**
 * Metadata entry describing one copied payload file inside a staged delta artifact.
 *
 * `payloadPath` is always a generated path beneath `payload/`; it never reuses the original Gradle
 * cache relative path. This prevents path traversal and keeps archive extraction deterministic.
 */
export interface DeltaArtifactPayloadEntry {
  readonly relativePath: string;
  readonly payloadPath: string;
  readonly contentSha256: string;
  readonly size: number;
  readonly mode: number;
  readonly mtimeMs: number;
}

/**
 * Top-level metadata file stored alongside each staged delta artifact package.
 */
export interface DeltaArtifactPackageMetadata {
  readonly schemaVersion: typeof DELTA_ARTIFACT_PACKAGE_SCHEMA_VERSION;
  readonly artifactType: 'buildish-mammoth-cache-gradle-delta';
  readonly artifactName: string;
  readonly createdAt: string;
  readonly producer: DeltaArtifactProducerMetadata;
  readonly deltaManifestPath: string;
  readonly deltaManifestSha256: string;
  readonly payloadEntries: readonly DeltaArtifactPayloadEntry[];
}

/**
 * Result of staging a delta artifact package on disk before upload.
 */
export interface StagedDeltaArtifactPackage {
  readonly artifactName: string;
  readonly stagingDirectory: string;
  readonly rootDirectory: string;
  readonly files: readonly string[];
  readonly metadataPath: string;
  readonly deltaManifestPath: string;
  readonly metadata: DeltaArtifactPackageMetadata;
  readonly deltaManifest: CacheDeltaManifest;
}

/**
 * Result of uploading a previously staged delta artifact package.
 */
export interface UploadedDeltaArtifactPackage {
  readonly artifact: WorkflowArtifactDescriptor;
  readonly metadata: DeltaArtifactPackageMetadata;
  readonly stagingDirectory: string;
}

/**
 * Result of downloading and verifying a delta artifact package.
 */
export interface DownloadedDeltaArtifactPackage {
  readonly artifact: WorkflowArtifactDescriptor;
  readonly downloadDirectory: string;
  readonly metadata: DeltaArtifactPackageMetadata;
  readonly deltaManifest: CacheDeltaManifest;
}

/**
 * Optional overrides used when staging a delta artifact package.
 */
export interface StageDeltaArtifactPackageOptions {
  /** Parent directory beneath which a temporary staging directory should be created. */
  readonly parentDirectory?: string;
  /** Explicit artifact name override. Defaults to the deterministic name derived from job metadata. */
  readonly artifactName?: string;
}

/**
 * Optional overrides used when uploading a staged delta artifact package.
 */
export interface UploadDeltaArtifactPackageOptions {
  /** Optional retention override passed to the artifact service. */
  readonly retentionDays?: number;
  /** Optional compression override. Defaults to a low-cost level that still compresses JSON well. */
  readonly compressionLevel?: number;
}

/**
 * Optional overrides used when downloading and verifying a delta artifact package.
 */
export interface DownloadDeltaArtifactPackageOptions extends ArtifactLookupOptions {
  /** Parent directory beneath which a temporary extraction directory should be created. */
  readonly parentDirectory?: string;
}

/**
 * Creates the deterministic artifact-name prefix used to locate one worker delta by job identity.
 */
export function createDeltaArtifactNamePrefix(
  jobName: string,
  runId: number | null,
  runAttempt: number | null,
): string {
  const sanitizedJobName = sanitizeArtifactToken(jobName, 'job name', 48);
  const runSegment = runId === null ? 'run-unknown' : `run-${runId}`;
  const attemptSegment = runAttempt === null ? 'attempt-unknown' : `attempt-${runAttempt}`;
  return `${DELTA_ARTIFACT_NAME_PREFIX}-${sanitizedJobName}-${runSegment}-${attemptSegment}-`;
}

/**
 * Creates the final deterministic artifact name for one worker delta package.
 *
 * The hash suffix folds in the cache key and portable delta-manifest digest, keeping names stable,
 * human-readable, and unique for the supported distributed-job model where each worker job name is
 * unique within one distributed execution.
 */
export function createDeltaArtifactName(
  ciContext: CiJobContext,
  cacheModel: CacheModel,
  deltaManifest: CacheDeltaManifest,
): string {
  const portableManifest = createPortableDeltaManifest(deltaManifest);
  const deltaDigest = sha256Hex(serializeCacheDeltaManifest(portableManifest)).slice(0, 12);
  const cacheDigest = sha256Hex(cacheModel.cacheKey).slice(0, 12);
  const artifactName = `${createDeltaArtifactNamePrefix(ciContext.jobName, ciContext.runId, ciContext.runAttempt)}${cacheDigest}-${deltaDigest}`;

  if (!ARTIFACT_NAME_PATTERN.test(artifactName)) {
    throw new Error(`Derived artifact name '${artifactName}' contains unsupported characters.`);
  }

  return artifactName;
}

/**
 * Stages one delta artifact package on disk using generated payload paths under `payload/`.
 *
 * The staged package intentionally serializes a *portable* delta manifest whose `gradleUserHome`
 * field is redacted to a constant sentinel. Worker absolute filesystem paths should not leave the
 * worker machine in distributed mode.
 */
export async function stageDeltaArtifactPackage(
  ciContext: CiJobContext,
  cacheModel: CacheModel,
  deltaManifest: CacheDeltaManifest,
  options: StageDeltaArtifactPackageOptions = {},
): Promise<StagedDeltaArtifactPackage> {
  const stagingParent = options.parentDirectory ?? os.tmpdir();
  const stagingDirectory = await mkdtemp(
    path.join(stagingParent, 'buildish-mammoth-cache-gradle-delta-artifact-'),
  );
  const rootDirectory = stagingDirectory;
  const artifactName =
    options.artifactName ?? createDeltaArtifactName(ciContext, cacheModel, deltaManifest);
  const portableDeltaManifest = createPortableDeltaManifest(deltaManifest);
  const serializedPortableDeltaManifest = serializeCacheDeltaManifest(portableDeltaManifest);
  const deltaManifestSha256 = sha256Hex(serializedPortableDeltaManifest);
  const deltaManifestPath = path.join(rootDirectory, DELTA_PACKAGE_MANIFEST_FILE);
  const metadataPath = path.join(rootDirectory, DELTA_PACKAGE_METADATA_FILE);
  const payloadDirectory = path.join(rootDirectory, DELTA_PACKAGE_PAYLOAD_DIRECTORY);

  validateArtifactName(artifactName);
  await mkdir(payloadDirectory, { recursive: true });

  const payloadEntries = await stagePayloadEntries(deltaManifest, payloadDirectory);
  const metadata: DeltaArtifactPackageMetadata = {
    schemaVersion: DELTA_ARTIFACT_PACKAGE_SCHEMA_VERSION,
    artifactType: 'buildish-mammoth-cache-gradle-delta',
    artifactName,
    createdAt: new Date().toISOString(),
    producer: {
      repository: ciContext.repository,
      workflowName: ciContext.workflowName,
      jobName: ciContext.jobName,
      runId: ciContext.runId,
      runAttempt: ciContext.runAttempt,
      runnerOs: ciContext.runnerOs,
      runnerArch: ciContext.runnerArch,
      safeRefName: ciContext.safeRefName,
      cacheKey: cacheModel.cacheKey,
    },
    deltaManifestPath: DELTA_PACKAGE_MANIFEST_FILE,
    deltaManifestSha256,
    payloadEntries,
  };

  await writeFile(deltaManifestPath, serializedPortableDeltaManifest, 'utf8');
  await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, 'utf8');

  return {
    artifactName,
    stagingDirectory,
    rootDirectory,
    files: await listRegularFilesRecursively(rootDirectory),
    metadataPath,
    deltaManifestPath,
    metadata,
    deltaManifest: portableDeltaManifest,
  };
}

/**
 * Uploads a previously staged delta artifact package using the supplied artifact API.
 */
export async function uploadDeltaArtifactPackage(
  artifactBackend: WorkflowArtifactBackend,
  stagedPackage: StagedDeltaArtifactPackage,
  options: UploadDeltaArtifactPackageOptions = {},
): Promise<UploadedDeltaArtifactPackage> {
  const artifact = await artifactBackend.uploadArtifact(
    stagedPackage.artifactName,
    stagedPackage.files,
    stagedPackage.rootDirectory,
    {
      retentionDays: options.retentionDays,
      compressionLevel: options.compressionLevel ?? DEFAULT_ARTIFACT_COMPRESSION_LEVEL,
    },
  );

  return {
    artifact,
    metadata: stagedPackage.metadata,
    stagingDirectory: stagedPackage.stagingDirectory,
  };
}

/**
 * Locates the single delta artifact produced by one worker job in one distributed execution.
 */
export async function findDeltaArtifactByProducerJob(
  artifactBackend: WorkflowArtifactBackend,
  producerJobName: string,
  runId: number | null,
  runAttempt: number | null,
  options: ArtifactLookupOptions = {},
): Promise<WorkflowArtifactDescriptor> {
  const expectedPrefix = createDeltaArtifactNamePrefix(producerJobName, runId, runAttempt);
  const matches = (
    await artifactBackend.listArtifacts({ latest: true, scope: options.scope })
  ).filter((artifact) => artifact.name.startsWith(expectedPrefix));

  if (matches.length === 0) {
    throw new Error(
      `No delta artifact found for job '${producerJobName}' with prefix '${expectedPrefix}'.`,
    );
  }

  if (matches.length > 1) {
    throw new Error(
      `Multiple delta artifacts matched job '${producerJobName}' with prefix '${expectedPrefix}'. Distributed jobs must use unique producer job names.`,
    );
  }

  return matches[0];
}

/**
 * Downloads a named artifact, verifies the reported content hash when available, and validates the
 * package.
 */
export async function downloadAndVerifyDeltaArtifactPackageByName(
  artifactBackend: WorkflowArtifactBackend,
  artifactName: string,
  options: DownloadDeltaArtifactPackageOptions = {},
): Promise<DownloadedDeltaArtifactPackage> {
  const artifact = await artifactBackend.getArtifact(artifactName, { scope: options.scope });
  return downloadAndVerifyDeltaArtifactPackage(artifactBackend, artifact, options);
}

/**
 * Downloads an artifact by descriptor, verifies the reported content hash when available, and
 * validates the package.
 */
export async function downloadAndVerifyDeltaArtifactPackage(
  artifactBackend: WorkflowArtifactBackend,
  artifact: WorkflowArtifactDescriptor,
  options: DownloadDeltaArtifactPackageOptions = {},
): Promise<DownloadedDeltaArtifactPackage> {
  const parentDirectory = options.parentDirectory ?? os.tmpdir();
  const downloadDirectory = await mkdtemp(
    path.join(parentDirectory, 'buildish-mammoth-cache-gradle-delta-download-'),
  );
  const downloadResult = await artifactBackend.downloadArtifact(artifact.id, {
    path: downloadDirectory,
    expectedHash: artifact.digest ?? undefined,
    scope: options.scope,
  });

  if (downloadResult.digestMismatch) {
    throw new Error(`Downloaded artifact '${artifact.name}' did not match the expected hash.`);
  }

  const verified = await verifyExtractedDeltaArtifactPackage(
    downloadResult.downloadPath,
    artifact.name,
  );

  return {
    artifact,
    downloadDirectory: downloadResult.downloadPath,
    metadata: verified.metadata,
    deltaManifest: verified.deltaManifest,
  };
}

/**
 * Verifies a previously extracted delta artifact package and returns the parsed metadata.
 */
export async function verifyExtractedDeltaArtifactPackage(
  extractedDirectory: string,
  expectedArtifactName?: string,
): Promise<{
  readonly metadata: DeltaArtifactPackageMetadata;
  readonly deltaManifest: CacheDeltaManifest;
}> {
  const actualFiles = await listRelativeRegularFiles(extractedDirectory);
  const metadataPath = path.join(extractedDirectory, DELTA_PACKAGE_METADATA_FILE);
  const metadata = deserializeDeltaArtifactPackageMetadata(await readFile(metadataPath, 'utf8'));

  if (expectedArtifactName && metadata.artifactName !== expectedArtifactName) {
    throw new Error(
      `Downloaded package metadata expected artifact name '${expectedArtifactName}', but found '${metadata.artifactName}'.`,
    );
  }

  const manifestRelativePath = validatePackageRelativePath(
    metadata.deltaManifestPath,
    'delta artifact metadata deltaManifestPath',
  );
  const manifestPath = resolveArtifactPackagePath(extractedDirectory, manifestRelativePath);
  const serializedDeltaManifest = await readFile(manifestPath, 'utf8');
  const deltaManifestSha256 = sha256Hex(serializedDeltaManifest);

  if (deltaManifestSha256 !== metadata.deltaManifestSha256) {
    throw new Error('Downloaded delta manifest did not match the packaged manifest digest.');
  }

  const deltaManifest = deserializeCacheDeltaManifest(serializedDeltaManifest);
  if (deltaManifest.gradleUserHome !== PORTABLE_GRADLE_USER_HOME) {
    throw new Error('Downloaded delta artifact must use the portable Gradle user home sentinel.');
  }

  const expectedPayloads = collectExpectedPayloadSnapshots(deltaManifest);
  const seenRelativePaths = new Set<string>();
  const expectedFiles = new Set<string>([DELTA_PACKAGE_METADATA_FILE, manifestRelativePath]);

  for (const payloadEntry of metadata.payloadEntries) {
    if (seenRelativePaths.has(payloadEntry.relativePath)) {
      throw new Error(
        `Downloaded delta artifact contains duplicate payload metadata for '${payloadEntry.relativePath}'.`,
      );
    }
    seenRelativePaths.add(payloadEntry.relativePath);

    const expectedSnapshot = expectedPayloads.get(payloadEntry.relativePath);
    if (!expectedSnapshot) {
      throw new Error(
        `Downloaded delta artifact payload '${payloadEntry.relativePath}' does not correspond to an added or modified delta entry.`,
      );
    }

    verifyPayloadEntryMatchesSnapshot(payloadEntry, expectedSnapshot, payloadEntry.relativePath);

    const payloadRelativePath = validatePackageRelativePath(
      payloadEntry.payloadPath,
      `delta artifact payload path for '${payloadEntry.relativePath}'`,
    );
    if (!payloadRelativePath.startsWith(`${DELTA_PACKAGE_PAYLOAD_DIRECTORY}/`)) {
      throw new Error(
        `Delta artifact payload '${payloadEntry.relativePath}' must be stored beneath '${DELTA_PACKAGE_PAYLOAD_DIRECTORY}/'.`,
      );
    }

    expectedFiles.add(payloadRelativePath);

    const payloadAbsolutePath = resolveArtifactPackagePath(extractedDirectory, payloadRelativePath);
    const payloadStat = await lstat(payloadAbsolutePath);
    if (payloadStat.isSymbolicLink()) {
      throw new Error(
        `Delta artifact payload '${payloadEntry.relativePath}' must not be a symbolic link.`,
      );
    }
    if (!payloadStat.isFile()) {
      throw new Error(
        `Delta artifact payload '${payloadEntry.relativePath}' must be a regular file.`,
      );
    }
    if (payloadStat.size !== payloadEntry.size) {
      throw new Error(
        `Delta artifact payload '${payloadEntry.relativePath}' size does not match metadata.`,
      );
    }

    const payloadDigest = await hashFileSha256(payloadAbsolutePath);
    if (payloadDigest !== payloadEntry.contentSha256) {
      throw new Error(
        `Delta artifact payload '${payloadEntry.relativePath}' failed SHA-256 verification.`,
      );
    }
  }

  if (expectedPayloads.size !== metadata.payloadEntries.length) {
    throw new Error(
      'Downloaded delta artifact payload metadata count does not match the delta manifest.',
    );
  }

  if (
    actualFiles.length !== expectedFiles.size ||
    actualFiles.some((relativePath) => !expectedFiles.has(relativePath))
  ) {
    throw new Error(
      'Downloaded delta artifact contains unexpected files outside the documented package layout.',
    );
  }

  return {
    metadata,
    deltaManifest,
  };
}

/**
 * Parses and validates a serialized delta-package metadata file.
 */
export function deserializeDeltaArtifactPackageMetadata(
  serializedMetadata: string,
): DeltaArtifactPackageMetadata {
  const parsed = parseSerializedJsonObject(serializedMetadata, 'delta artifact metadata');

  return {
    schemaVersion: validatePackageSchemaVersion(parsed.schemaVersion),
    artifactType: validateArtifactType(parsed.artifactType),
    artifactName: validateArtifactName(
      validateString(parsed.artifactName, 'delta artifact metadata artifactName'),
    ),
    createdAt: validateString(parsed.createdAt, 'delta artifact metadata createdAt'),
    producer: validateProducerMetadata(parsed.producer),
    deltaManifestPath: validatePackageRelativePath(
      validateString(parsed.deltaManifestPath, 'delta artifact metadata deltaManifestPath'),
      'delta artifact metadata deltaManifestPath',
    ),
    deltaManifestSha256: validateSha256(
      parsed.deltaManifestSha256,
      'delta artifact metadata deltaManifestSha256',
    ),
    payloadEntries: validatePayloadEntries(parsed.payloadEntries),
  };
}

async function stagePayloadEntries(
  deltaManifest: CacheDeltaManifest,
  payloadDirectory: string,
): Promise<readonly DeltaArtifactPayloadEntry[]> {
  const payloadEntries: DeltaArtifactPayloadEntry[] = [];
  const changedEntries = collectChangedEntries(deltaManifest);

  for (const [index, { entry, currentSnapshot }] of changedEntries.entries()) {
    const payloadPath = `${DELTA_PACKAGE_PAYLOAD_DIRECTORY}/${formatPayloadFileName(index)}`;
    const destinationPath = path.join(payloadDirectory, formatPayloadFileName(index));
    const sourcePath = resolveGradleCachePath(deltaManifest.gradleUserHome, entry.relativePath);
    await copyAndVerifySourceFile(sourcePath, destinationPath, entry.relativePath, currentSnapshot);
    payloadEntries.push({
      relativePath: entry.relativePath,
      payloadPath,
      contentSha256: currentSnapshot.contentSha256,
      size: currentSnapshot.size,
      mode: currentSnapshot.mode,
      mtimeMs: currentSnapshot.mtimeMs,
    });
  }

  return payloadEntries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function createPortableDeltaManifest(deltaManifest: CacheDeltaManifest): CacheDeltaManifest {
  return {
    ...deltaManifest,
    gradleUserHome: PORTABLE_GRADLE_USER_HOME,
  };
}

function collectChangedEntries(deltaManifest: CacheDeltaManifest): readonly {
  readonly entry: CacheDeltaEntry;
  readonly currentSnapshot: CacheFileSnapshot;
}[] {
  const changedEntries: Array<{ entry: CacheDeltaEntry; currentSnapshot: CacheFileSnapshot }> = [];

  for (const partition of deltaManifest.partitions) {
    for (const entry of partition.entries) {
      if (entry.changeType === 'deleted') {
        continue;
      }

      if (!entry.current) {
        throw new Error(`Delta entry '${entry.relativePath}' is missing its current snapshot.`);
      }

      changedEntries.push({
        entry,
        currentSnapshot: entry.current,
      });
    }
  }

  return changedEntries;
}

function collectExpectedPayloadSnapshots(
  deltaManifest: CacheDeltaManifest,
): Map<string, CacheFileSnapshot> {
  const snapshots = new Map<string, CacheFileSnapshot>();

  for (const { entry, currentSnapshot } of collectChangedEntries(deltaManifest)) {
    snapshots.set(entry.relativePath, currentSnapshot);
  }

  return snapshots;
}

function verifyPayloadEntryMatchesSnapshot(
  payloadEntry: DeltaArtifactPayloadEntry,
  snapshot: CacheFileSnapshot,
  relativePath: string,
): void {
  if (
    payloadEntry.contentSha256 !== snapshot.contentSha256 ||
    payloadEntry.size !== snapshot.size ||
    payloadEntry.mode !== snapshot.mode ||
    payloadEntry.mtimeMs !== snapshot.mtimeMs
  ) {
    throw new Error(
      `Delta artifact payload metadata for '${relativePath}' does not match the delta manifest snapshot.`,
    );
  }
}

async function copyAndVerifySourceFile(
  sourcePath: string,
  destinationPath: string,
  relativePath: string,
  expectedSnapshot: CacheFileSnapshot,
): Promise<void> {
  const beforeStat = await lstat(sourcePath);

  if (beforeStat.isSymbolicLink()) {
    throw new Error(`Delta artifact packaging does not support symbolic links: '${relativePath}'.`);
  }
  if (!beforeStat.isFile()) {
    throw new Error(`Delta artifact packaging only supports regular files: '${relativePath}'.`);
  }

  assertStatMatchesSnapshot(beforeStat, expectedSnapshot, relativePath);
  await mkdir(path.dirname(destinationPath), { recursive: true });

  const hash = createHash('sha256');
  let copiedBytes = 0;
  const input = createReadStream(sourcePath);
  input.on('data', (chunk: Buffer) => {
    copiedBytes += chunk.length;
    hash.update(chunk);
  });

  await pipeline(input, createWriteStream(destinationPath));

  const afterStat = await lstat(sourcePath);
  if (afterStat.isSymbolicLink() || !afterStat.isFile()) {
    throw new Error(`Delta artifact packaging observed an unstable source file '${relativePath}'.`);
  }

  const copiedDigest = hash.digest('hex');
  if (copiedBytes !== expectedSnapshot.size || copiedDigest !== expectedSnapshot.contentSha256) {
    throw new Error(
      `Delta artifact packaging observed content drift for '${relativePath}'. Recompute the delta manifest before uploading.`,
    );
  }

  if (
    beforeStat.size !== afterStat.size ||
    beforeStat.mode !== afterStat.mode ||
    beforeStat.mtimeMs !== afterStat.mtimeMs ||
    beforeStat.ctimeMs !== afterStat.ctimeMs
  ) {
    throw new Error(
      `Delta artifact packaging observed source-file races for '${relativePath}'. Recompute the delta manifest before uploading.`,
    );
  }
}

function assertStatMatchesSnapshot(
  fileStat: Awaited<ReturnType<typeof lstat>>,
  snapshot: CacheFileSnapshot,
  relativePath: string,
): void {
  if (
    fileStat.size !== snapshot.size ||
    fileStat.mode !== snapshot.mode ||
    fileStat.mtimeMs !== snapshot.mtimeMs
  ) {
    throw new Error(
      `Delta artifact packaging source file '${relativePath}' no longer matches the captured manifest snapshot.`,
    );
  }
}

async function listRegularFilesRecursively(rootDirectory: string): Promise<readonly string[]> {
  return (await listRelativeRegularFiles(rootDirectory)).map((relativePath) =>
    path.join(rootDirectory, relativePath),
  );
}

async function listRelativeRegularFiles(rootDirectory: string): Promise<readonly string[]> {
  const relativePaths: string[] = [];
  await walkDirectory(rootDirectory, '', relativePaths);
  return relativePaths.sort((left, right) => left.localeCompare(right));
}

async function walkDirectory(
  absoluteDirectory: string,
  relativeDirectory: string,
  collector: string[],
): Promise<void> {
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const childRelativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const childAbsolutePath = path.join(absoluteDirectory, entry.name);

    if (entry.isSymbolicLink()) {
      throw new Error(`Artifact packages must not contain symbolic links: '${childRelativePath}'.`);
    }

    if (entry.isDirectory()) {
      await walkDirectory(childAbsolutePath, childRelativePath, collector);
      continue;
    }

    if (!entry.isFile()) {
      throw new Error(
        `Artifact packages only support regular files, but found '${childRelativePath}'.`,
      );
    }

    collector.push(childRelativePath);
  }
}

function formatPayloadFileName(index: number): string {
  return `${String(index + 1).padStart(6, '0')}.bin`;
}

function resolveGradleCachePath(gradleUserHome: string, relativePath: string): string {
  const normalizedRelativePath = validatePackageRelativePath(relativePath, 'delta relativePath');
  const resolvedRoot = path.resolve(gradleUserHome);
  const resolvedPath = path.resolve(resolvedRoot, normalizedRelativePath.split('/').join(path.sep));
  const rootWithSeparator = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${path.sep}`;

  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(rootWithSeparator)) {
    throw new Error(`Delta relative path '${relativePath}' escapes the Gradle user home.`);
  }

  return resolvedPath;
}

function resolveArtifactPackagePath(rootDirectory: string, relativePath: string): string {
  const normalizedRelativePath = validatePackageRelativePath(
    relativePath,
    'artifact package relative path',
  );
  const resolvedRoot = path.resolve(rootDirectory);
  const resolvedPath = path.resolve(resolvedRoot, normalizedRelativePath.split('/').join(path.sep));
  const rootWithSeparator = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${path.sep}`;

  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(rootWithSeparator)) {
    throw new Error(
      `Artifact package path '${relativePath}' escapes the extracted root directory.`,
    );
  }

  return resolvedPath;
}

function validatePackageSchemaVersion(
  value: unknown,
): typeof DELTA_ARTIFACT_PACKAGE_SCHEMA_VERSION {
  if (value !== DELTA_ARTIFACT_PACKAGE_SCHEMA_VERSION) {
    throw new Error(
      `Delta artifact metadata schemaVersion must be ${DELTA_ARTIFACT_PACKAGE_SCHEMA_VERSION}.`,
    );
  }

  return DELTA_ARTIFACT_PACKAGE_SCHEMA_VERSION;
}

function validateArtifactType(value: unknown): 'buildish-mammoth-cache-gradle-delta' {
  if (value !== 'buildish-mammoth-cache-gradle-delta') {
    throw new Error(`Delta artifact metadata type must be 'buildish-mammoth-cache-gradle-delta'.`);
  }

  return 'buildish-mammoth-cache-gradle-delta';
}

function validateProducerMetadata(value: unknown): DeltaArtifactProducerMetadata {
  const producer = validateRecord(value, 'delta artifact metadata producer');

  return {
    repository: validateString(producer.repository, 'delta artifact metadata producer.repository'),
    workflowName: validateString(
      producer.workflowName,
      'delta artifact metadata producer.workflowName',
    ),
    jobName: validateString(producer.jobName, 'delta artifact metadata producer.jobName'),
    runId: validateNullableInteger(producer.runId, 'delta artifact metadata producer.runId'),
    runAttempt: validateNullableInteger(
      producer.runAttempt,
      'delta artifact metadata producer.runAttempt',
    ),
    runnerOs: validateString(producer.runnerOs, 'delta artifact metadata producer.runnerOs'),
    runnerArch: validateString(producer.runnerArch, 'delta artifact metadata producer.runnerArch'),
    safeRefName: validateString(
      producer.safeRefName,
      'delta artifact metadata producer.safeRefName',
    ),
    cacheKey: validateString(producer.cacheKey, 'delta artifact metadata producer.cacheKey'),
  };
}

function validatePayloadEntries(value: unknown): readonly DeltaArtifactPayloadEntry[] {
  const entries = validateArray(value, 'delta artifact metadata payloadEntries');
  let previousRelativePath = '';

  return entries.map((entryValue, index) => {
    const entry = validateRecord(
      entryValue,
      `delta artifact metadata payload entry at index ${index}`,
    );
    const relativePath = validatePackageRelativePath(
      validateString(
        entry.relativePath,
        `delta artifact metadata payload entry ${index} relativePath`,
      ),
      `delta artifact metadata payload entry ${index} relativePath`,
    );

    if (previousRelativePath.localeCompare(relativePath) >= 0) {
      throw new Error(
        'Delta artifact payload entries must be sorted by strictly increasing relativePath.',
      );
    }
    previousRelativePath = relativePath;

    return {
      relativePath,
      payloadPath: validatePackageRelativePath(
        validateString(
          entry.payloadPath,
          `delta artifact metadata payload entry ${index} payloadPath`,
        ),
        `delta artifact metadata payload entry ${index} payloadPath`,
      ),
      contentSha256: validateSha256(
        entry.contentSha256,
        `delta artifact metadata payload entry ${index} contentSha256`,
      ),
      size: validateNonNegativeInteger(
        entry.size,
        `delta artifact metadata payload entry ${index} size`,
      ),
      mode: validateNonNegativeInteger(
        entry.mode,
        `delta artifact metadata payload entry ${index} mode`,
      ),
      mtimeMs: validateNonNegativeNumber(
        entry.mtimeMs,
        `delta artifact metadata payload entry ${index} mtimeMs`,
      ),
    };
  });
}

function validateArtifactName(artifactName: string): string {
  if (!ARTIFACT_NAME_PATTERN.test(artifactName)) {
    throw new Error(
      `Artifact name '${artifactName}' contains unsupported characters. Allowed characters are letters, numbers, dot, underscore, and dash.`,
    );
  }

  return artifactName;
}

function sanitizeArtifactToken(token: string, label: string, maxLength = 64): string {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    throw new Error(`Artifact ${label} must not be empty.`);
  }

  const sanitized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, maxLength)
    .replace(/^-|-$/gu, '');

  if (sanitized.length === 0) {
    throw new Error(`Artifact ${label} did not contain any supported characters.`);
  }

  return sanitized;
}

function validatePackageRelativePath(relativePath: string, label: string): string {
  return validateNormalizedRelativePosixPath(relativePath, label, 'the artifact package');
}

async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');

  return await new Promise<string>((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on('data', (chunk: Buffer) => hash.update(chunk));
    input.on('error', reject);
    input.on('close', () => resolve(hash.digest('hex')));
  });
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validateNullableInteger(value: unknown, label: string): number | null {
  if (value === null) {
    return null;
  }

  return validateNonNegativeInteger(value, label);
}
