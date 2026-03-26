<!--
Copyright 2026 The Apache Software Foundation

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
  - `main: dist/github/main.js`
  - `post: dist/github/post.js`
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
19. Update licenses (C) and project name.
    - This project will be part of a new Apache Incubator project.
    - The name of the project will be "Apache Buildish (Incubating)"
    - Need to have a DISCLAIMER file next to the LICENSE and NOTICE file.
      Content template: https://raw.githubusercontent.com/apache/polaris/refs/heads/release/1.2.x/DISCLAIMER
    - The (C) needs in all license headers needs to be updated to "The Apache Software Foundation"
      Template: https://raw.githubusercontent.com/apache/polaris/refs/heads/main/codestyle/copyright-header.txt
    - The project name needs to be updated everywhere in the code base.
      Output of the code base, as in log message or job summaries, can just use "Apache Buildish" without the
      "(Incubating)" suffix.
    - Note: Documents like the README and the files in the docs/ directory only need to mention "Apache Buildish"
      with the "(Incubating)" suffix once and can afterwards just use "Buildish" or "Apache Buildish."
    - The README.md needs to have two sections at the end.
      Template: Lines 206-214 from https://raw.githubusercontent.com/apache/polaris/refs/heads/release/1.2.x/README.md
    - Also add CONTRIBUTING.md, SECURITY.md and CODE_OF_CONDUCT.md.
      Use the files present on the branch https://github.com/apache/polaris/tree/release/1.2.x as templates.
      Keep the CONTRIBUTING.md very general and do not add any build or other project specific instructions.
20. Change the project structure.
    - The to-be-established "Apache Buildish" project will contain not just this action, but also other build related
      functionality like Gradle plugins, other actions, build helper scripts, etc.
    - We have to move everything for this action into a subdirectory.
      Let's use `actions/mammoth-cache/gradle` as the new root directory for this action.
      IDEs would be opened using the `actions/mammoth-cache/gradle` as the project root directory.
    - Add a symlink from `actions/mammoth-cache/gradle/dot-github` to the root `.github` directory.
    - Add symlinks from the `actions/mammoth-cache/gradle` directories for the LICENSE, NOTICE and DISCLAIMER files to the root
      directory.
    - Rename the current CI workflow to `ci-mammoth-cache-gradle.yml` and scope it to changes in the `actions/mammoth-cache/gradle`
      directory.
    - Move the current README.md to `actions/mammoth-cache/gradle/README.md`.
    - Add a new top-level README.md introducing the "Apache Buildish" project and list the available actions
      (currently just this one).
21. Integration workflow suite
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
    - Set of integration test workflows for macOS and Windows.
      - A subset of the the Linux based workflows above should be sufficient to exercise the macOS and Windows
        specific behaviors.
      - Do not copy the Linux workflows. Instead make those Matrix jobs
22. GH integration test workflows permissions
    - We can only expect read-only permissions, especially for PRs againt the project.
    - The workflows must not fail in such cases.
    - We should also ensure that multiple CI jobs running in parallel or sequentially do not interfere with each
      other and cause flaky test runs or any other side effects or other issues.
23. As the action shall be CI platform agnostic, the GH action should be placed in `dist/github/`, not just `dist/`.
24. There are lot of configuration options now.
    - We should allow reading the configuration from a file in YAML or JSON format.
    - Configuration values on the action override those from a file.
25. Prepare for releases
    - Ensure LICENSE and NOTICE are present and up-to-date in the release artifacts. Those MUST be ASF compliant,
      if possible, generate those from the contents of the package-lock.json? Is that enough even for the NOTICE file?
    - All dependencies that are contained in (or "distributed with") the action MUST be listed in the LICENSE/NOTICE
      files.
    - Hint: Only Apache-License projects' NOTICE file content is to be included in the distribution's NOTICE file.
      Other licenses that require attribution (e.g., MIT, BSD, etc.) do not go into the NOTICE file.
      They are to be included in the LICENSE file.
26. Problematic licenses
    - openpgp (LGPL-3.0+) https://www.npmjs.com/package/openpgp
      - Remove the openpgp dependency and replace it with invocations of the gpg binary, is should be presenton
        Linux and macOS GitHub runners.
      - If the gpg binary is not present, the action shall fail with an actionable error message (aka on Windows?).
    - buffers (no license) https://www.npmjs.com/package/buffers
      - Have to mention this specially, as the package information doesn't include any license information.
      - Special mention text:
        """
        This package is licensed under the MIT/X11 license, as indicated by the commit of the original author here
        (on a fork) https://github.com/bitpay/node-buffers/commit/1b745ee35d33eb166e15ef1866073a07c6d7de87.
        The original source repository https://github.com/substack/node-buffers no longer exists,
        the dependency has been published to npmjs 14 years ago and is since then unmaintained.
        """
      - License Type: MIT / X11
      - No license URL
27. Having the Gradle wrapper verification and automatic download in CI is great, but that does not help
    developers that need to run Gradle on their local machine, because the `gradlew[.bat]` scripts expect
    the wrapper JAR to be present.
    - As a generic solution, I created this approach: https://github.com/snazy/gradle-wrapper-no-jar
    - We should replace or adapt that approach, and pull it as a separate tool into this repository.
    - The action and the "local tool" need to work well together, or better: in the same way.
    - The tool should live in the `tools/` directory of the repository.
    - As we do not have a running Gradle, we cannot put it into any Gradle build or init script, so we
      have to rely on shell script / powershell "magic" to get it working.
    - In a local dev environment we can however retain the downloaded SHA256 and GPG signatures of the wrapper jar,
      keeping those in the gradle/wrapper/ directory as `gradle-wrapper-<version-number>.sha256` and
      `gradle-wrapper-<version-number>.asc` files.
28. Followup for the "buildish helper tool" - automatic installation script via "run bash via curl"
    - The idea is to setup the "buildish helper tool" via a "bash script" that can be installed via
      `curl -s https://raw.githubusercontent.com/apache/buildish/main/tools/buildish-no-gradle-wrapper-jar/install.sh | bash`.
    - Should have a similar mechanism for Windows, if that's available.
    - The setup script should also patch existing `gradlew[.bat]` scripts, aka insert the helper script invocation
      at the right place.
    - The setup script should also add `.gitignore` entries for the `gradle-wrapper-<version-number>[.sha256|.asc]` files.
29. Followup for the "buildish helper tool" - support from the action
    - The buildish mammoth action should write the right `gradle-wrapper-<version-number>[.sha256|.asc]` files.
    - That way, the "buildish helper tool" does not need to download the files again.
30. Followup for the "buildish helper tool" - Gradle init script for Renovate
    - Background: When Renovate updates the Gradle version, it uses the Gradle `:wrapper` task, which then updates
      the `gradle-wrapper.properties` file and writes _new_ `gradlew[.bat]` scripts, which do not contain the patches.
    - So we have to re-apply the patches when the `:wrapper` task finiwhes.
    - Idea is to have a Gradle init script that is automatically applied in CI and hooks into the Gradle `:wrapper`
      task, see lines 260.. in https://raw.githubusercontent.com/apache/polaris/refs/heads/main/build.gradle.kts,
      to update the `gradlew[.bat]` files generated by the `:wrapper` task. This is easier for users than to
      let them update their build file(s).
    - The trickier part is how the included helper scripts can modify the eventual Gradle execution to add the
      necessary command line options, see https://docs.gradle.org/current/userguide/init_scripts.html#sec:using_an_init_script.
    - In bash, we might be able to prepend the command line arguments.
    - For powershell, I've got no clue - do you?
31. Followup for the "buildish helper tool" - Integration and other tests
    - Add a Makefile to the `tools/buildish-no-gradle-wrapper-jar/` directory acting as a trampoline to run tests,
      RAT, and release verification tasks.
    - RAT check - share the RAT setup across all tools.
    - License check
    - LICENSE/NOTICE (just symlinks to the root)
32. Need to add information performed Gradle builds.
    - Similar to the information published on this workflow run: https://github.com/apache/polaris/actions/runs/23577520926
    - Probably worth to look into https://github.com/gradle/actions/tree/v5/sources/src/ and use a similar approach
      to capture Gradle build runs, their outcome and whether build scans were attempted, whether they were
      successful and where those are published (link those).
    - Should have a local integration test for this instead of only validating it in the CI workflows.
33. Cleanup job summary
    - Can we get the cache partition statistics from the cache manifest into the summary? Like number of files and
      total size for each partition.
    - The level of detail is great, it's just not very readable.
    - Worth to consider: Collapsed sections, see https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/organizing-information-with-collapsed-sections
    - Should use "green checkmarks" (UTF-8 icon) and a brief summary, if everything worked fine. Hide the details in collapsed sections.
    - Should use "red crosses" (UTF-8 icon) for each error. Place errors right at the top.
    - Should use "yellow warning signs" (UTF-8 icon) for each warning. Place warnings right after errors.
    - Do not emit duplicate information.
34. Cleanup the code base
    - Check validate*() functions for duplicates
35. Documentation for the action
    - Write `README.md`, examples, permissions table, security section, and maintenance notes.
    - Explicitly document the Gradle wrapper jar download and verification process in the docs/ directory.
    - Explicitly document the cache key generation process in the docs/ directory.
    - Explicitly document the base cache design in the docs/ directory.
    - Explicitly document the CI abstraction layer in the docs/ directory.
    - Explicitly document the bootstrap process in the docs/ directory.
    - All types and functions must have JSDoc comments.
36. Add the "buildish helper tool" to the top-level README
37. Add release workflows
    - Use version tags. "full" version tags like v1.2.3 become actual GitHub releases.
      We can provide "moving" tags like v1, v1.2 as well. Those would then point to the latest release in their
      respective series.
    - The plan is to use GitHub's immutable release feature.
      See https://docs.github.com/en/actions/how-tos/create-and-publish-actions/using-immutable-releases-and-tags-to-manage-your-actions-releases
    - As the action's `dist/` folder is .gitignore'd, we need to ensure that the release workflow ensure that the
      `dist/` folder is included in the Git commit for the release tag.

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
- Multi-level aggregation (TO BE THOUGHT THROUGH / DOES IT MAKE REAL SENSE?)
  - Currently, the action only supports a set of jobs and exactly one aggregator.
  - It should be possible to have multiple levels of aggregation. In other words, an aggregator could just
    aggregate the input deltas and produce a new, combined delta consumed by another aggregator.
