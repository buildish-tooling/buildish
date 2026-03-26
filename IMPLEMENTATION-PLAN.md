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

# Implementation Plan

## Purpose

This file is an internal implementation plan for the Gradle cache / wrapper GitHub Action.
It is not user-facing. It turns the current requirements into a concrete, secure, and incrementally
implementable design.

## Guiding decisions

1. Implement the action as a Node 20 + TypeScript JavaScript action with `main` and `post` entrypoints.
2. Use GitHub toolkit libraries from code, not nested `uses:` calls inside the action.
3. Use `@actions/cache` for restoring/saving the base cache.
4. Use `@actions/artifact` for exchanging intra-workflow cache deltas between jobs.
5. Make `read-only` disable all persistence of modified state:
   - no cache save
   - no modified-cache artifact upload
6. Resolve distributed merge conflicts deterministically and safely:
   - apply dependency deltas in declared order
   - if two deltas change the same file to different content, fail hard
   - if content is identical, allow it
7. Treat `atime` restoration as best-effort only; log when it cannot be preserved.
8. Keep the design CI-agnostic internally, but implement only the GitHub adapter in v1.
9. For v1, require users to run `actions/setup-java` explicitly before this action.
   Rationale: a JavaScript action cannot reliably invoke `actions/setup-java` as another action.
   We will still detect the effective Java version from the configured runtime (`java -version`).

## High-level architecture

### Action shape

- `action.yml`
  - `runs.using: node20`
  - `main: dist/main.js`
  - `post: dist/post.js`
- `src/main.ts`
  - parse inputs
  - validate configuration and environment
  - discover/validate wrapper files
  - download/verify wrapper JARs if needed
  - restore base Gradle cache
  - optionally download and apply dependent job deltas
  - capture pre-build cache manifest/state for post-step diffing
  - write state for post action
- `src/post.ts`
  - read saved state
  - re-scan cache contents
  - compute cache deltas
  - optionally run Gradle cleanup trigger
  - upload worker/aggregator artifacts when enabled
  - save final base cache when allowed and applicable
  - publish job summary

### Internal modules

- `src/config/`
  - input parsing
  - defaults
  - normalization
  - validation
- `src/ci/`
  - CI-agnostic interfaces
  - GitHub implementation for refs, job/run metadata, permissions assumptions, summaries
- `src/wrapper/`
  - wrapper-properties discovery
  - wrapper-properties parsing
  - security checks (`validateDistributionUrl`, `distributionSha256Sum`, path restrictions)
  - version normalization (`8.0` vs `8` style mismatch handling)
  - jar checksum fetch + download + checksum verify
- `src/cache/`
  - cache key builder
  - cache partition definitions
  - base cache restore/save using `@actions/cache`
  - file manifest capture
  - delta computation
  - delta application
- `src/artifacts/`
  - artifact naming
  - artifact upload/download using `@actions/artifact`
  - archive packing/unpacking
  - manifest integrity checks
- `src/gradle/`
  - Gradle invocation helper
  - cleanup trigger logic
  - init-script generation for cache cleanup tuning
- `src/logging/`
  - structured logging helpers
  - warning/error rendering
  - job summary rendering
- `src/util/`
  - hashing
  - retries with backoff
  - path safety helpers
  - filesystem metadata helpers

## Libraries and tools

- Runtime / action toolkit
  - `@actions/core`
  - `@actions/github`
  - `@actions/cache`
  - `@actions/artifact`
  - `@actions/exec`
  - `@actions/glob`
  - `@actions/io`
- Build / packaging
  - `typescript`
  - `@vercel/ncc` for bundling the action
- Quality
  - `eslint`
  - `prettier`
  - `vitest` or `jest` (prefer one; do not mix)
  - `c8` for coverage if needed
- Test helpers
  - `nock` for HTTP mocking
  - filesystem fixtures / temp directories

## Concrete v1 behavior

### Wrapper management

- Default target wrapper file is `gradle/wrapper/gradle-wrapper.properties` under the configured base directory.
- Support either:
  - one default wrapper file
  - all files matching the wrapper glob
  - an explicit allow-list of wrapper property files
- Reject path traversal and absolute paths in configured wrapper paths.
- For every targeted wrapper file:
  - parse properties
  - require `validateDistributionUrl=true`
  - require `distributionSha256Sum`
  - require supported `distributionBase` / `zipStoreBase` / `distributionPath` / `zipStorePath`
  - derive wrapper version from `distributionUrl`
  - fetch expected wrapper JAR SHA256 from `services.gradle.org`
  - download wrapper JAR from `raw.githubusercontent.com`
  - verify checksum before placing it beside the properties file
- Retry network downloads 3 times with fixed or exponential backoff.
- Any targeted wrapper failure fails the action.

### Cache model

- Effective cache scope in v1: `$HOME/.gradle` only.
- Exclude configuration cache explicitly.
- Include partitions for:
  - modules
  - transforms / metadata
  - Kotlin DSL caches
  - build cache
  - wrapper distributions when present under the supported layout
- Key format default:
  - `gradle-cache-${schemaVersion}-${javaMajor}-${runnerOs}-${runnerArch}-${safeRefName}`
- Allow user customization only via:
  - prefix override
  - optional restricted template placeholders
- Normalize ref names for cache/artifact safety instead of trusting raw names directly.

### Distributed workflow model

- Base cache is always restored from GitHub cache storage.
- Worker/aggregator exchange uses GitHub artifacts only for current-workflow deltas.
- Each job captures a pre-run manifest and computes a post-run delta.
- Delta format:
  - partitioned archive(s)
  - manifest with file path, mode, size, digest, timestamps, deletion markers
- Aggregator behavior:
  - restore base cache
  - download worker deltas
  - optionally download dependent-job deltas in declared order
  - fail on conflicting file updates with different digests
  - apply merged result
  - trigger Gradle cleanup
  - save final cache with `@actions/cache`
- Worker behavior:
  - never save base cache directly
  - upload only its delta artifact when not read-only

### Cleanup trigger

- Provide a small Gradle invocation helper that prefers a fast no-op style command.
- Start with a conservative command such as invoking `help` through the project wrapper.
- Support custom init script generation to influence cleanup settings.
- If cleanup trigger fails in aggregator mode, fail hard before saving the final cache.

## Public API / configuration plan

- Keep inputs flat and string-based in `action.yml`.
- Avoid nested YAML objects in action inputs.
- Use exact enum values, e.g.:
  - `standalone`
  - `distributed-worker`
  - `distributed-aggregator`
- Validate:
  - booleans
  - enum values
  - integer Java major version
  - cache prefix / template length and allowed placeholders
  - job names used for dependent delta download
  - wrapper path allow-list

## Testing strategy

### Unit tests

- input parsing / validation
- ref normalization and cache key building
- wrapper property parsing and restriction enforcement
- version normalization for wrapper downloads
- checksum verification and retry behavior
- manifest diffing and delta application
- artifact naming uniqueness
- conflict detection for overlapping deltas
- job summary rendering

### Integration tests

- standalone cache restore/save on Linux
- distributed worker + aggregator flow
- dependent delta download via `needs`
- read-only PR behavior
- wrapper download success and failure cases
- multiple wrapper files / explicit allow-list
- unsupported configuration failures

## Recommended implementation order

1. Bootstrap repository tooling: package manager, TypeScript, linting, tests, bundling, Apache files.
2. Define input schema, validation layer, and normalized runtime configuration.
3. Implement CI abstraction and GitHub adapter for events, refs, run metadata, and summary output.
4. Implement wrapper properties discovery/parsing and all static security checks.
5. Implement wrapper JAR version normalization, download, retry, and checksum verification.
6. Implement cache key builder, safe ref normalization, and partition definitions.
7. Implement base cache restore/save service using `@actions/cache`.
8. Implement manifest capture and delta computation for relevant Gradle cache partitions.
9. Implement artifact packaging, naming, upload/download, and delta application.
10. Implement `main` orchestration and persistent action state handoff to `post`.
11. Implement `post` orchestration, cleanup trigger, worker upload flow, and aggregator save flow.
12. Implement job summary rendering and operational logging.
13. Add unit test coverage for all core modules.
14. Add GitHub workflow integration tests covering standalone and distributed scenarios.
15. Write the user-facing `README.md`, permissions guidance, examples, and security notes.

## Task list

1. Repository bootstrap
   - Initialize Node/TypeScript project, bundler, linter, formatter, test runner, and license files.
2. Runtime config system
   - Define action inputs, defaults, enums, schema validation, and normalized config objects.
3. CI abstraction layer
   - Create CI interfaces plus the GitHub implementation for refs, job metadata, and summary emission.
4. Wrapper static validation
   - Discover wrapper files, parse properties, enforce supported layouts, and validate mandatory properties.
5. Wrapper download pipeline
   - Implement version mapping, checksum fetch, download, retry, verify, and atomic file placement.
6. Cache key + partition model
   - Implement safe cache key generation and split cache partition definitions.
7. Base cache service
   - Restore/save base cache with correct warnings, error handling, and summary hooks.
8. Delta manifest engine
   - Scan partitions, compute changed/new/deleted files, and serialize delta manifests.
9. Artifact exchange layer
   - Package deltas, generate unique names, upload/download artifacts, and verify archive contents.
10. Delta merge/apply engine
    - Apply dependent deltas in declared order and emit a warning, logged in the job summary, on conflicting file content.
11. Main action flow
    - Wire together validation, wrapper provisioning, cache restore, dependent delta download, and state save.
12. Post action flow
    - Recompute deltas, optionally trigger cleanup, upload worker artifacts, and save final cache.
13. Summary and observability
    - Produce clear logs and job summaries for cache hits, misses, wrapper actions, and distributed merges.
14. Unit test suite
    - Cover validation, wrapper logic, caching, artifacts, merging, and summaries.
15. Make sure the delta artifacts are either deleted after the aggregator job has finished or after 12 hours.
16. Add a safeguard to prevent the action from run more than once per job.
17. Fail hard when no Java runtime is available.
18. Support macOS and Windows runners
19. Integration workflow suite
    - Those workflows are not part of the action itself, but required to run integration tests.
    - Add real GitHub workflow tests for standalone, distributed, read-only, and failure scenarios.
      - Single job workflow
      - Distributed workflow with multiple workers and an aggregator
        - All workers finish with deltas
        - Some workers finish without deltas
        - No workers finish with deltas
      - Read-only mode
        - Exercise for standalone and distributed jobs
      - Failure handling
20. Cleanup job summary
21. Cleanup the code base
22. Documentation
    - Write `README.md`, examples, permissions table, security section, and maintenance notes.
    - Explicitly document the Gradle wrapper jar download and verification process in the docs/ directory.
    - Explicitly document the cache key generation process in the docs/ directory.
    - Explicitly document the base cache design in the docs/ directory.
    - Explicitly document the CI abstraction layer in the docs/ directory.
    - Explicitly document the bootstrap process in the docs/ directory.
    - All types and functions must have JSDoc comments.
23. Add release workflows
    - Ensure LICENSE and NOTICE are present and up-to-date in the release artifacts.
    - Support version tags, but only immutable tags, no "moving" tags like 'v1' or so.

## Deferred / explicitly out of scope for v1

- Non-default `GRADLE_USER_HOME`
- Project-local `.gradle`
- Non-GitHub CI implementations
- Java versions below 8 
- Built-in invocation of `actions/setup-java`.
  Just to install Java for a particular version using a particular distribution.
  Using the same defaults as `actions/setup-java` for the version and distribution (value pass-through).
  PROBLEM:
  - the stock setup-java entrypoint always writes Maven auth/toolchain files after installing Java.
  - invoking upstream setup-java as a raw child process would not update this action’s current process environment by itself
  - the upstream entrypoint also emits a Java problem matcher and writes Maven settings/toolchains by default
