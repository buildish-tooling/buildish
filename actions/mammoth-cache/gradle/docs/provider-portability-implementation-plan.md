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

# Provider portability implementation plan

This note turns the Codeberg and GitLab evaluations into a concrete prep plan. It covers the
shared refactors that should happen before or alongside any future provider implementation.

## Scope split

There are two workstreams:

1. Shared portability prep: make the core less GitHub-Action-shaped.
2. Provider-specific implementation: adapters, hosts, packaging, and validation.

Codeberg likely needs less shared prep than GitLab, but both benefit from the same target shape.

## Shared portability prep status

The shared portability prep tracked in this note is now largely in place:

- runtime-host capabilities are split under `src/runtime-host/types.ts`
- lifecycle is expressed as provider-neutral `prepare` / `finalize`
- report publication uses `src/reporting/**` instead of living on the CI adapter
- shared entrypoints live under `src/entrypoints/cli/**`
- cache and artifact backends expose explicit capability metadata

The remaining work is mostly provider-specific validation and implementation.

## Target architecture

- `src/core/**`: provider-neutral lifecycle types and shared coordination primitives
- `src/ci/**`: provider metadata, URLs, provider HTTP headers, provider-specific runtime entry adapters
- `src/reporting/**`: grouped logs and summary/report publication
- `src/runtime-host/**`: inputs, outputs, state, reporting, temp/workspace paths
- `src/storage/**`: base-cache and artifact backend interfaces/implementations
- `src/entrypoints/**`: provider-neutral prepare/finalize entrypoints

The immediate goal is not a large move. It is to make current modules depend on narrower seams.

## Phase 1: split the runtime host into capabilities

- Current file: `src/ci/runtime-host.ts`
- Problem: `ActionRuntimeHost` bundles inputs, state, outputs, logging, warnings, and failure reporting into one GitHub-style object.
- Planned change:
  - keep `ActionRuntimeHost` temporarily as a compatibility alias
  - add `src/runtime-host/types.ts` with `RuntimeInputSource`, `RuntimeStateStore`, `RuntimeOutputSink`, `RuntimeReporter`, and `RuntimePaths`
  - add `CompositeRuntimeHost` as the temporary intersection type
- Migration targets:
  - `src/bootstrap.ts`: input/state/reporter/paths
  - `src/main.ts`: output/reporter/state
  - `src/post.ts`: reporter/state
  - `src/main-flow.ts`: reporter/state
  - `src/post-flow.ts`: reporter/state
- Why: Codeberg may need a host shim; GitLab almost certainly needs a different host model.

## Phase 2: add an explicit lifecycle driver

- Problem: shared orchestration still assumes GitHub JavaScript action `main` and `post`.
- Planned change:
  - add `src/core/lifecycle.ts` with `CoreExecutionPhase = 'prepare' | 'finalize'`
  - keep `runMain()` / `runPost()` as wrappers during migration
  - map GitHub `main` -> `prepare`, GitHub `post` -> `finalize`
- Migration targets:
  - `src/main.ts`
  - `src/post.ts`
  - `src/bootstrap.ts`
  - `src/runtime/job-single-run.ts`
- Current state:
  - shared lifecycle phases now use `prepare` / `finalize`
  - `src/core/lifecycle.ts` defines the shared provider-neutral lifecycle phase model
  - provider-neutral prepare/finalize entrypoints now live under `src/entrypoints/cli/**`
  - GitHub-facing `runMain()` / `runPost()` are now thin wrappers over those shared entrypoints
- Why: Codeberg may need lifecycle adaptation; GitLab needs mapping to job scripts or `after_script`.

## Phase 3: generalize artifact lookup scope

- Completed:
  - introduced provider-neutral artifact lookup types under `src/storage/artifacts.ts`
  - replaced the old GitHub-shaped `findBy` wiring with `ArtifactLookupScope` / `ArtifactLookupOptions`
  - kept the GitHub implementation as an adapter translating that scope into toolkit `findBy` coordinates
- Remaining limitation:
  - shared lookup scope is now provider-neutral, but it currently models repository/run/auth lookup context only; producer-job identity is still carried by artifact naming and distributed-job conventions
- Why it still matters: Codeberg may reuse GitHub-like coordinates, but the shared contract no longer requires them; GitLab may still need broader pipeline/job identity and lifecycle work.

## Phase 4: separate provider metadata from report sinks

- Problem: `CiPlatformAdapter` currently mixes CI metadata with report-publication behavior.
- Planned change:
  - keep `CiJobContext` and execution URLs under `src/ci/**`
  - move summary/log publishing into `src/reporting/types.ts`
  - add a report sink interface for grouped logs plus optional summary publication/replacement
- Migration targets: `src/ci/types.ts`, `src/logging/summary.ts`, `src/main-flow.ts`, `src/post-flow.ts`.
- Current state:
  - grouped logs and summary publication now flow through `src/reporting/types.ts`
  - GitHub-specific summary/group handling lives in `src/reporting/github.ts`
  - shared bootstrap/main/post flows take an explicit `reportSink` instead of depending on reporting methods on the CI adapter
- Why: Codeberg may support native summaries; GitLab likely needs logs plus generated-file or artifact reports.

## Phase 5: widen cache/artifact contracts where still GitHub-shaped

- Planned change:
  - use `BaseCacheBackend` and `WorkflowArtifactBackend` consistently in shared code
  - remove remaining temporary compatibility aliases once callers are migrated
  - keep shared status/error/reporting text provider-neutral as execution/cache/artifact flows evolve
  - document backend-varying capabilities explicitly: digest availability, retention, delete support, cross-run lookup scope
- Current state:
  - `BaseCacheBackend` and `WorkflowArtifactBackend` now expose explicit capability metadata
  - shared cache/artifact/post-action flows branch on those capabilities for restore keys, explicit saves, retention overrides, cross-execution lookup, and deletion cleanup
- This is shared cleanup, not provider implementation.

## Phase 6: add a CLI-friendly core entrypoint

- Planned change:
  - add `src/entrypoints/cli/prepare.ts`
  - add `src/entrypoints/cli/finalize.ts`
  - keep GitHub entrypoints where they are until the earlier phases settle
- Current state:
  - provider-neutral prepare/finalize entrypoints now live under `src/entrypoints/cli/**`
  - `src/main.ts` and `src/post.ts` remain thin compatibility adapters over those shared entrypoints
- Why: optional for Codeberg if Forgejo runs JavaScript actions well enough; strongly recommended for GitLab.

## Provider-specific work after shared prep

### Codeberg / Forgejo

- add `src/ci/codeberg/**` or `src/ci/forgejo/**`
- implement provider metadata adapter
- add a provider runtime host only if GitHub host reuse is unreliable
- add `action-descriptors/codeberg/**`
- validate `@actions/core`, `@actions/cache`, `@actions/artifact`, and post behavior on a real Forgejo runtime

### GitLab

- add a GitLab runtime host or CLI wrapper
- add a GitLab provider metadata adapter
- add GitLab cache and artifact backend strategies
- map `prepare` / `finalize` to `.gitlab-ci.yml` steps or explicit commands
- decide whether reports live in logs, artifacts, or both

## Recommended remaining sequence

1. Codeberg / Forgejo compatibility spike for `@actions/core`, `@actions/cache`, and `@actions/artifact`
2. Codeberg / Forgejo provider implementation and descriptor packaging
3. GitLab host/backend/lifecycle design around the shared `prepare` / `finalize` CLI entrypoints
4. GitLab implementation and validation

## Success criteria

Shared portability prep is complete when:

- core flows no longer require one monolithic GitHub-style runtime object
- lifecycle is expressed independently of GitHub `main`/`post`
- artifact lookup scope is provider-neutral
- report generation does not require a GitHub-native summary surface
- provider-specific code is confined to provider/runtime/storage entry layers

The current codebase now satisfies those shared-prep criteria closely enough that the remaining work is mostly provider-specific.
