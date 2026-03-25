<!--
Copyright 2026 The Project Nessie Authors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# Distributed artifact exchange

The distributed cache flow needs a transport format for cache deltas produced by worker jobs and later consumed by an aggregator job. This document describes the task 9 implementation that now lives in `src/artifacts/service.ts`.

## Goals

- keep the upload/download layer provider-neutral except for one thin GitHub adapter
- avoid embedding untrusted cache-relative paths in archive filenames
- verify enough metadata to reject corruption, tampering, and malformed packages early
- stay memory-conscious for large delta sets by staging files on disk instead of building a second in-memory archive

## Public module surface

The artifact exchange module currently exposes:

- `createGitHubArtifactApi()`
- `createDeltaArtifactName()` and `createDeltaArtifactNamePrefix()`
- `stageDeltaArtifactPackage()`
- `uploadDeltaArtifactPackage()`
- `findDeltaArtifactByProducerJob()`
- `downloadAndVerifyDeltaArtifactPackage()` / `downloadAndVerifyDeltaArtifactPackageByName()`
- `verifyExtractedDeltaArtifactPackage()`

This keeps the GitHub toolkit dependency isolated to one place while the rest of the code works with a narrow `WorkflowArtifactApi` interface that is easy to fake in tests.

## Artifact naming

Artifact names use the following shape:

- `cache-gradle-delta-<sanitized-job-name>-run-<runId>-attempt-<runAttempt>-<cacheKeyHash>-<deltaManifestHash>`

Properties:

- human-readable prefix for logs and workflow debugging
- deterministic for a given worker, cache key, and portable delta manifest
- safe for GitHub artifact constraints (`[A-Za-z0-9._-]` only)
- discoverable later through `createDeltaArtifactNamePrefix()` + `listArtifacts()`

### Important limitation

Distributed mode still assumes **unique GitHub job names per worker**. If multiple workers share the same `GITHUB_JOB` value within one run, artifact discovery becomes ambiguous. That limitation already matches the `dependent-jobs` configuration surface and is enforced by `findDeltaArtifactByProducerJob()`.

## Package layout

Each staged package is a directory uploaded as one artifact.

- `delta-package.json`
- `delta-manifest.json`
- `payload/000001.bin`
- `payload/000002.bin`
- `...`

### Why generated payload filenames?

The original cache-relative paths are stored only in JSON metadata, not as archive paths. This is intentional:

- it prevents path traversal through payload filenames
- it keeps extraction layout deterministic
- it avoids deep directory trees with many repeated path segments
- it makes validation straightforward: every payload must live under `payload/`

## Portable delta manifests

Uploaded artifacts do **not** include the worker's absolute `GRADLE_USER_HOME` path.

Before writing `delta-manifest.json`, the artifact layer rewrites:

- `gradleUserHome` → `"<portable-gradle-user-home>"`

This avoids leaking worker-local filesystem paths into exchanged artifacts while preserving all relative-path and snapshot information needed for later merge/apply steps.

## Integrity and security model

Verification happens at multiple layers.

### 1. GitHub artifact digest

When GitHub returns an artifact digest, download verification passes it back as `expectedHash`. If the toolkit reports a digest mismatch, the package is rejected immediately.

### 2. Metadata schema validation

`delta-package.json` is parsed and validated for:

- schema version
- artifact type
- producer metadata shape
- safe normalized relative package paths
- strictly increasing `relativePath` ordering in payload metadata
- lowercase hexadecimal SHA-256 digests

### 3. Delta-manifest digest verification

The extracted `delta-manifest.json` file is hashed and compared with the digest recorded in `delta-package.json`.

### 4. Payload verification

For every added/modified delta entry:

- metadata must reference exactly one payload file
- the payload path must stay beneath `payload/`
- the payload file must be a regular file, not a symlink
- file size and SHA-256 must match metadata
- metadata snapshot fields must match the delta manifest snapshot

### 5. Unexpected file rejection

The verifier walks the extracted directory and rejects any file outside the documented package layout.

## Source-race protection during staging

Worker-side packaging also defends against local races.

For every source file copied into `payload/`:

- the file must still match the snapshot captured in the delta manifest before streaming begins
- the copied bytes must hash to the expected digest
- the source file's size/mode/mtime/ctime must remain stable before and after the copy

If any of those checks fail, staging aborts and instructs the caller to recompute the delta manifest. This avoids uploading a package whose payload no longer matches the manifest.

## Performance notes

The implementation is designed to stay conservative with memory:

- payloads are copied directly from Gradle user home into a temporary staging directory
- metadata is compact JSON with a trailing newline
- upload uses one artifact per worker job and a low compression level by default (`1`)

This keeps the code aligned with the earlier benchmark result that JSON manifests compress well, while not spending unnecessary CPU on aggressively recompressing already-compressed Gradle cache blobs.

## Current scope vs later tasks

Implemented here:

- artifact naming
- package staging
- GitHub upload/download adapter
- artifact lookup by producer job
- integrity and path-safety verification

Still left for later tasks:

- wiring workers to actually upload only when cache deltas exist
- wiring aggregators to merge/apply downloaded deltas into one cache save
- end-to-end summary/reporting around distributed cache fan-in
