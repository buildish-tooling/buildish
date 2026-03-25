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

# cache-gradle

GitHub Action for secure Gradle wrapper provisioning and Gradle cache management.

## Current status

This repository is under active development.

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

So the action metadata and configuration surface are ready, but the core Gradle behavior is still being built.

## Usage

Until the first public release exists, use a repository ref you control for testing.

```yaml
steps:
  - uses: actions/checkout@v5
  - uses: projectnessie/cache-gradle@<ref>
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

### `wrapper-properties-files`

- Default: empty
- Comma- or newline-separated explicit `gradle-wrapper.properties` files.
- Paths are relative to `base-directory`.
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

- Default: `${{ github.token }}`
- Optional GitHub token used only for authenticated wrapper JAR downloads against the GitHub API.
- Helps reduce throttling when fetching `gradle-wrapper.jar` from the Gradle source repository.
- Never written to summaries or persisted post-action state.

## Development

The repository provides both npm scripts and Make targets.

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

This project is licensed under Apache License 2.0.

See:

- [`LICENSE`](./LICENSE)
- [`NOTICE`](./NOTICE)
