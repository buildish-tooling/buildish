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
  - `${partitionFingerprint}`
  - `${javaMajor}`
  - `${runnerOs}`
  - `${runnerArch}`
  - `${refName}`
- Custom templates must include `${partitionFingerprint}` so different cache partition layouts do not share the same base cache key.

### `cache-partitions`

- Default: empty
- Optional JSON array of cache partition overrides and custom partitions.
- Each object must contain:
  - `id`: lowercase letters, numbers, and `-` only
  - `includes`: array of Gradle-user-home-relative include globs
  - `excludes`: optional array of Gradle-user-home-relative exclude globs
- Overriding a built-in partition replaces its built-in include/exclude lists.
- Setting `includes: []` disables a built-in partition.
- Custom partitions must have at least one include glob.
- Hard safety excludes are always enforced even when a partition is overridden.

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

### `restore-cleanup-mode`

- Default: `none`
- Supported values:
  - `none`
  - `prune-managed`
- `prune-managed` only acts after a base-cache hit.
- It deletes files currently matched by the active managed partitions, then restores the matched base cache again.
- It never deletes files outside the action-managed partition space.
- It is intentionally opt-in because it is more destructive and may increase restore time.

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

## Cache partitions and restore cleanup

### Built-in partitions

The action resolves the Gradle user home into ordered logical partitions:

- `modules` — dependency artifacts, jars, and resource stores
- `transforms-metadata` — artifact transforms and related metadata; disabled by default
- `kotlin-dsl` — compiled Kotlin DSL scripts and generated Gradle API jars; enabled by default
- `build-cache` — the local Gradle build cache
- `wrapper-dists` — wrapper-downloaded Gradle distributions

Built-ins keep a deterministic order. Custom partitions are appended after the active built-ins in the order supplied by `cache-partitions`.

### Include and exclude semantics

- Includes define the files the action manages for a partition.
- Excludes remove files from that partition after includes are matched.
- Overriding a built-in replaces its built-in include/exclude lists.
- Built-in overrides with `includes: []` disable that built-in.
- Custom partitions with `includes: []` are rejected.
- If the same file matches more than one active partition, manifest capture fails instead of guessing an owner.

Hard safety excludes are always applied to every active partition and cannot be removed:

- `**/configuration-cache/**`
- `**/*.lock`
- `caches/*/cc-keystore`
- `caches/journal-1/**`

These exclusions are intentional safety rails for volatile or security-sensitive content.

### Supported glob subset

All partition globs are relative to the supported Gradle user home.

- Absolute paths are rejected.
- `..` traversal is rejected.
- Negated globs are rejected.
- Supported wildcards are:
  - `*` within a single path segment
  - `**` as a whole path segment
- Include globs must end in `/**`.
- Include globs may not use `**` anywhere except the final segment.
- Exclude globs may use `**` as a whole path segment anywhere in the pattern.
- Other glob operators such as `?`, character classes, braces, and extglobs are rejected.

Examples:

- valid include: `caches/*/kotlin-dsl/**`
- valid exclude: `caches/modules-*/metadata-*/**`
- valid exclude: `**/*.lock`
- invalid include: `/home/runner/.gradle/caches/**`
- invalid include: `caches/**/tmp/**`
- invalid exclude: `!caches/foo/**`

### Partition customization example

Use `cache-partitions` as JSON. Example:

```json
[
  {
    "id": "modules",
    "includes": ["caches/modules-*/files-*/**", "caches/jars-*/**"],
    "excludes": ["caches/modules-*/metadata-*/**"]
  },
  {
    "id": "kotlin-dsl",
    "includes": []
  },
  {
    "id": "custom-generated-jars",
    "includes": ["caches/*/generated-gradle-jars/**"],
    "excludes": []
  }
]
```

That example:

- overrides `modules`
- disables the built-in `kotlin-dsl` partition
- adds a custom partition named `custom-generated-jars`

### Restore cleanup behavior

`restore-cleanup-mode=prune-managed` is the safe, narrow cleanup mode supported today.

- It only runs after a base-cache hit.
- It only deletes files currently matched by the active managed partitions.
- After pruning, it restores the matched base cache again before the build starts.
- It does not delete unmanaged files elsewhere in `GRADLE_USER_HOME`.
- If you disable a partition, files from that now-disabled partition are no longer considered action-managed and are left untouched.

This is intentionally narrower than “delete everything outside the include patterns” because the action does not own all of `GRADLE_USER_HOME`, especially on long-lived self-hosted runners.

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
