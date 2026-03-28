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

# Provider portability remaining work

This note tracks only the architecture work still left for GitHub, Codeberg/Forgejo, and GitLab support.

Completed portability refactors are intentionally omitted.

## Current shared architecture

The current shared seams are already in place:

- `src/core/lifecycle.ts`: provider-neutral lifecycle phases
- `src/entrypoints/cli/**`: shared `prepare` / `finalize` entrypoints
- `src/ci/types.ts`: normalized CI metadata, execution URLs, host-scoped headers, bootstrap diagnostics
- `src/runtime-host/types.ts`: runtime input/state/output/reporting capabilities
- `src/reporting/types.ts`: grouped-log and summary sink
- `src/storage/cache.ts`: capability-based base-cache backend
- `src/storage/artifacts.ts`: capability-based artifact backend

GitHub is the only implemented provider today and lives under `src/ci/github/**` plus `descriptors/github/**`.

## Shared refactor status

No further shared refactor is scheduled independently right now.

Future shared changes should be driven by the first concrete non-GitHub provider mismatch instead of widening the shared
model speculatively.

That means:

- do not reintroduce raw `GITHUB_*` reads or GitHub-only names into shared code
- do not widen shared config for provider-specific quirks
- do not add provider branching to shared flows when a provider adapter, runtime host, report sink, or backend can own it

## Remaining Codeberg / Forgejo work

- add a provider adapter under `src/ci/codeberg/**` or `src/ci/forgejo/**`
- validate `@actions/core`, `@actions/cache`, `@actions/artifact`, and post-hook behavior on the target runtime
- add a provider runtime host only if the current GitHub-compatible host cannot be reused safely
- add a provider report sink only if the current GitHub summary/log behavior cannot be reused safely
- add provider-specific cache and artifact backends only where runtime compatibility diverges
- add Codeberg-facing consumer packaging next to the existing GitHub descriptor/bundles

## Remaining GitLab work

- add a provider adapter under `src/ci/gitlab/**`
- add a GitLab runtime host / state bridge that can drive shared `prepare` / `finalize` execution
- add a GitLab report sink for logs and any generated-file or artifact-based summaries
- add GitLab cache and artifact backends behind the existing storage seams
- widen shared artifact lookup identity only if a real GitLab backend needs more than the current repository/run scope
- add a GitLab-facing runner/package surface around the shared entrypoints
- validate distributed worker / aggregator behavior against real pipeline/job artifact semantics

## Guardrails for future provider work

- keep raw provider environment parsing in `src/ci/<provider>/**`
- keep provider-specific inputs in provider entry layers
- keep shared reporting content provider-neutral and map it to provider surfaces in report sinks
- extend backend capability flags before encoding provider quirks in shared flow logic
- preserve the existing security properties: exact-host auth headers, strict artifact/package validation, and no trust of
  provider-controlled filenames or paths
