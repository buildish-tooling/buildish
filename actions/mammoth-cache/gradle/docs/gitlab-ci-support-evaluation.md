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

# GitLab remaining architecture work

This note tracks only the work still left for a GitLab port.

Completed shared portability refactors are intentionally omitted; see
`docs/provider-portability-implementation-plan.md` for the current shared baseline.

## Current starting point

The shared seams GitLab should build on already exist:

- `src/entrypoints/cli/**`: shared `prepare` / `finalize` entrypoints
- `src/ci/types.ts`: normalized CI metadata, execution URLs, and host-scoped headers
- `src/runtime-host/types.ts`: runtime capabilities
- `src/reporting/types.ts`: grouped-log and summary sink
- `src/storage/**`: provider-neutral cache and artifact backends

GitHub is the only implemented provider today.

## Remaining work

1. Add a provider adapter under `src/ci/gitlab/**` for environment parsing, URLs, diagnostics, and host-scoped
   headers.
2. Add a GitLab runtime host / state bridge that can drive shared `prepare` / `finalize` execution safely.
3. Add a GitLab report sink that maps shared reporting to GitLab logs plus any generated-file or artifact-based summary
   surface.
4. Add a GitLab base-cache backend behind `BaseCacheBackend`.
5. Add a GitLab artifact backend behind `WorkflowArtifactBackend`.
6. Widen shared artifact lookup identity only if a real GitLab backend needs more than the current repository/run scope.
7. Add a GitLab-facing runner/package surface around the shared entrypoints.
8. Validate distributed worker / aggregator behavior against real pipeline/job artifact semantics, retention rules, and
   cleanup semantics.

## Constraints to preserve

- keep GitLab-specific inputs and environment parsing out of shared config normalization
- keep shared lifecycle naming `prepare` / `finalize`; provider-specific invocation belongs in GitLab-facing wiring only
- keep cache and artifact differences inside GitLab backends instead of branching shared flows by provider
- preserve exact-host auth-header behavior and re-check `CI_JOB_TOKEN`, artifact visibility, and fork trust boundaries
  against real GitLab behavior
