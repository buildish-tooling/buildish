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

# Apache Buildish Mammoth Cache for Gradle

Apache Buildish Mammoth Cache for Gradle provides secure Gradle wrapper provisioning plus local and distributed cache management for GitHub Actions.

Use it in workflows as `apache/buildish/actions/mammoth-cache/gradle@<ref>`.

This action lives in `actions/mammoth-cache/gradle/` so the `actions/mammoth-cache/` family can grow with sibling actions for other build tools over time.

## Current status

Mammoth Cache for Gradle is under active development.

Implemented today:

- action bootstrap entrypoints
- runtime input parsing and validation
- GitHub CI context abstraction
- local build, lint, test, and CI workflows

Not implemented yet:

- Gradle wrapper discovery and static validation
- wrapper download and checksum verification
- cache restore/save orchestration
- distributed worker / aggregator data exchange

The action metadata and configuration surface are ready, but the core Gradle execution and cache-management behavior is still being built.

## Usage in workflows

Until the first public release exists, use a repository ref you control for testing.

```yaml
steps:
  - uses: actions/checkout@v5
  - uses: apache/buildish/actions/mammoth-cache/gradle@<ref>
```

## Runtime and toolchain requirements

- GitHub Action runtime: Node 24
- Local development baseline: Node `24.13.0`
- Expected npm version for repository tooling: `11.6.2`
- Java `21+` for Apache RAT license-header checks

The repository pins these versions so local development, CI, and the published action runtime stay aligned.

For Java installation and switching, we recommend [SDKMAN!](https://sdkman.io/). Install at least Java 21 before running the RAT checks locally.

## Inputs

### `base-directory`

- Default: `.`
- Repository-relative base directory for wrapper discovery and other project-relative paths.
- Windows-style relative paths using `\` are accepted and normalized to internal POSIX-style paths.
- Absolute/rooted paths are rejected, including `C:\repo`, `\Windows\System32`, and `\\server\share`.
- Must remain inside the repository workspace.

### `cache-enabled`

- Default: `true`
- Accepted values: `true`, `false`
- Enables or disables cache orchestration.

### `read-only`

- Default: event-dependent
- Accepted values: `true`, `false`
- Defaults to `true` for `pull_request` / `pull_request_target`.
- Defaults to `false` for other events.
- Use this to prevent cache mutation.

### `job-mode`

- Default: `standalone`
- Supported values:
  - `standalone`
  - `distributed-worker`
  - `distributed-aggregator`
- Controls cache coordination behavior.

### `dependent-jobs`

- Default: empty
- Comma- or newline-separated job names.
- Only valid with distributed job modes.

### `cache-key-prefix`

- Default: `gradle-cache-`
- Must start with an alphanumeric character.
- Remaining characters may only be letters, numbers, `.`, `_`, or `-`.

### `cache-key-template`

- Default: unset
- Optional restricted template for cache key generation.
- Supported placeholders:
  - `${cacheKeyPrefix}`
  - `${schemaVersion}`
  - `${javaMajor}`
  - `${runnerOs}`
  - `${runnerArch}`
  - `${refName}`

### `process-all-wrapper-files`

- Default: `false`
- Accepted values: `true`, `false`
- Scans for every matching wrapper properties file under `base-directory`.
- Cannot be combined with `wrapper-properties-files`.

### `wrapper-properties-glob`

- Default: `**/gradle/wrapper/gradle-wrapper.properties`
- Repository-relative discovery glob used beneath `base-directory`.
- Windows-style relative paths using `\` are accepted and normalized before evaluation.
- Absolute/rooted paths are rejected, including drive-prefixed, rooted, and UNC paths.

### `wrapper-properties-files`

- Default: empty
- Comma- or newline-separated explicit `gradle-wrapper.properties` files.
- Paths are relative to `base-directory`.
- Windows-style relative paths using `\` are accepted and normalized to internal POSIX-style paths.
- Absolute/rooted paths are rejected, including drive-prefixed, rooted, and UNC paths.
- Entries must be explicit file paths, not globs.

### `cleanup-enabled`

- Default: `true`
- Accepted values: `true`, `false`
- Enables the later cleanup-trigger flow used by cache management.

### `gradle-user-home`

- Default: `$GRADLE_USER_HOME` when set, otherwise `$HOME/.gradle`
- In v1, only the default Gradle user home is supported.
- Non-default values fail validation intentionally.

### `setup-java`

- Default: `false`
- Accepted values: `true`, `false`
- Reserved compatibility flag.
- In v1, setting `true` fails intentionally.
- Run `actions/setup-java` before this action instead.

### `github-token`

- Default: unset
- Optional GitHub token used only for authenticated wrapper JAR downloads against the GitHub API.
- When omitted, the action uses `GITHUB_TOKEN` from the runner environment if available.
- Helps reduce throttling when fetching `gradle-wrapper.jar` from the Gradle source repository.
- Downloaded wrapper JARs are accepted only after detached-signature and SHA-256 verification.
- Gradle signing keys are pinned in-source as an allowlist so old and new keys can overlap during rotation.
- Never written to summaries or persisted post-action state.

## Development

The action project provides both npm scripts and Make targets.

Use Node `24.13.0` and npm `11.6.2` for local development. The Makefile sanity check enforces those versions.

Common commands:

- `make help`
- `make build`
- `make smoke-test`
- `make test`
- `make lint-check`
- `make rat-check`
- `make check`

Equivalent npm script:

- `npm run rat-check`
- `npm run smoke-test`

The Makefile verifies the expected `node` and `npm` versions before running user-facing targets.

### Dependency warning note

If `npm install` / `npm ci` prints a deprecation warning for `glob@10.5.0`, that warning is currently
transitive and does **not** mean this project depends on `glob` directly.

Current chain:

- `@actions/artifact`
- `archiver`
- `archiver-utils`
- `glob@10.5.0`

This repository already tracks GitHub's current `@actions/artifact` release line. The warning comes from
that upstream dependency graph, and we will pick up or evaluate a cleaner fix when GitHub's dependency
stack moves off the older `glob` release.

## Local verification

Full local verification:

- `npm run verify`
- `make smoke-test`
- `make rat-check`
- `make check`

This runs:

- lint
- formatting checks
- unit tests
- a fresh rebuild
- Apache RAT license-header verification (`make check`)

`make smoke-test` / `npm run smoke-test` performs a lightweight bundled-action smoke run against a temporary copy of `test/fixtures/smoke`, so it does not modify committed fixture files.

## License

Apache Buildish is licensed under Apache License 2.0.

See:

- [`LICENSE`](./LICENSE)
- [`NOTICE`](./NOTICE)
- [`DISCLAIMER`](./DISCLAIMER)

Project governance and community docs:

- [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- [`SECURITY.md`](./SECURITY.md)
- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)

## Incubation status

Apache Buildish is an effort undergoing incubation at The Apache Software Foundation (ASF), sponsored by the Apache Incubator PMC.

Incubation is required of all newly accepted projects until a further review indicates that the infrastructure, communications, and decision making process have stabilized in a manner consistent with other successful ASF projects.

While incubation status is not necessarily a reflection of the completeness or stability of the code, it does indicate that the project has yet to be fully endorsed by the ASF.
