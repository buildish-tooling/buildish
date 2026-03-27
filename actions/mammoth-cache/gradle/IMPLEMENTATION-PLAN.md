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

# Implementation status and remaining provider architecture

## Purpose

This file is an internal status note for `actions/mammoth-cache/gradle`.

It no longer tracks pre-implementation work. Instead, it records the current architecture shape and the remaining
provider-portability work for GitHub, Codeberg/Forgejo, and GitLab.

## Current implementation shape

### Shared core

- `src/bootstrap.ts` initializes configuration, wrapper, cache, and reporting state for both lifecycle phases.
- `src/main-flow.ts` drives the shared `prepare` phase.
- `src/post-flow.ts` drives the shared `finalize` phase.
- `src/entrypoints/cli/prepare.ts` and `src/entrypoints/cli/finalize.ts` are the provider-neutral entrypoints used by
  provider adapters.

### Portability seams already in place

- `src/ci/types.ts`: normalized CI context, execution URLs, host-scoped HTTP headers, and bootstrap diagnostics
- `src/runtime-host/types.ts`: runtime input/state/output/reporting capabilities
- `src/reporting/types.ts`: grouped-log and summary publication surface
- `src/storage/cache.ts`: capability-based base-cache backend seam
- `src/storage/artifacts.ts`: capability-based artifact backend seam

### Implemented behavior

- wrapper discovery, parsing, static validation, download, and checksum verification
- base cache restore/save orchestration
- distributed worker / aggregator delta packaging, upload, download, merge, and cleanup
- grouped-log and summary reporting
- GitHub consumer packaging under `action-descriptors/github/**` and `dist/github/**`

## Remaining architecture work

No more speculative shared-core refactor is planned on its own.

The next architectural changes should be driven by the first concrete non-GitHub provider mismatch instead of widening
shared abstractions pre-emptively.

### Codeberg / Forgejo

- validate `@actions/core`, `@actions/cache`, `@actions/artifact`, and post-hook behavior on the target runtime
- add a provider adapter under `src/ci/codeberg/**` or `src/ci/forgejo/**`
- add a provider-specific runtime host only if the current GitHub-compatible host cannot be reused safely
- add a provider-specific report sink only if the current GitHub summary/log behavior cannot be reused safely
- add provider-specific cache/artifact backends only where runtime compatibility diverges
- add Codeberg-facing consumer packaging next to the existing GitHub descriptor/bundles

### GitLab

- add a provider adapter under `src/ci/gitlab/**`
- add a GitLab runtime host / state bridge that can drive shared `prepare` / `finalize` execution
- add a GitLab report sink for logs and any generated-file or artifact-based summaries
- add GitLab cache and artifact backends behind the existing storage seams
- widen shared artifact lookup identity only if a real GitLab backend needs more than the current repository/run scope
- add a GitLab-facing runner/package surface around the shared entrypoints

## Architecture rules to preserve

- keep raw provider environment parsing inside `src/ci/<provider>/**`
- keep provider-specific inputs out of shared config normalization
- keep shared lifecycle names `prepare` / `finalize`; provider `main` / `post` naming stays at provider edges only
- keep provider-specific reporting behavior inside report sinks
- extend backend capability metadata before teaching shared flow logic about provider quirks
- preserve existing security constraints: exact-host auth headers, strict artifact/package validation, and no trust of
  provider-controlled filenames or paths

## Related notes

- `docs/provider-portability-implementation-plan.md`
- `docs/codeberg-ci-support-evaluation.md`
- `docs/gitlab-ci-support-evaluation.md`
- `docs/ci-abstraction-rule.md`