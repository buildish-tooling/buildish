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

## Target architecture

- `src/core/**`: provider-neutral prepare/finalize orchestration
- `src/ci/**`: provider metadata, URLs, provider HTTP headers
- `src/runtime-host/**`: inputs, outputs, state, reporting, temp/workspace paths
- `src/storage/**`: base-cache and artifact backend interfaces/implementations
- `src/entrypoints/**`: GitHub action entrypoints today, CLI/provider entrypoints later

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

## Recommended sequence

1. Runtime-host capability split
2. Lifecycle driver
3. Artifact execution-scope generalization
4. Reporting sink split
5. Shared cache/artifact contract cleanup
6. Codeberg compatibility spike
7. Codeberg implementation
8. CLI entrypoint extraction
9. GitLab host/backend design spike
10. GitLab implementation

## Success criteria

Shared portability prep is complete when:

- core flows no longer require one monolithic GitHub-style runtime object
- lifecycle is expressed independently of GitHub `main`/`post`
- artifact lookup scope is provider-neutral
- report generation does not require a GitHub-native summary surface
- provider-specific code is confined to provider/runtime/storage entry layers
