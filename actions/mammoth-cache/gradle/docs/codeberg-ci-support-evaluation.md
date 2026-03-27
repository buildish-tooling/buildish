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

# Codeberg CI support evaluation

This note evaluates the likely effort to support Codeberg later, assuming a Forgejo-based Actions runtime.

For the concrete shared refactor sequence and proposed target architecture, see
`docs/provider-portability-implementation-plan.md`.

## Bottom line

The codebase is in a **meaningfully better place** for future Codeberg support than it was before the SPI refactor.

Today there is a real split between:

- provider metadata/log/summary wiring in `src/ci/**`
- runtime-host behavior in `src/ci/runtime-host.ts`
- cache and artifact backend interfaces in `src/cache/service.ts` and `src/artifacts/service.ts`

That means Codeberg support later looks **plausible with moderate follow-on work**, not a rewrite. But it is still **not adapter-only yet**, because several shared contracts are still shaped around GitHub Action runtime semantics and the consumer packaging/runtime model is still a GitHub-style JavaScript action.

## Why Codeberg looks feasible

- Forgejo documents `github` context and `GITHUB_*` environment-variable aliases for compatibility.
- Forgejo also documents `FORGEJO_STEP_SUMMARY` and compatibility aliases for `GITHUB_STEP_SUMMARY`.
- The recently refactored CI adapter already centralizes:
  - event/ref parsing
  - execution URLs
  - provider summary/log rendering hooks
  - provider-scoped HTTP headers

Those are exactly the kinds of things that should live in a provider adapter.

## Why the current abstraction is not sufficient by itself

Several important portability concerns still remain.

### 1. The runtime-host contract is still GitHub Action-shaped

The runtime-host boundary now exists, which is good.

But `ActionRuntimeHost` still directly models `@actions/core`-style semantics such as:

- action inputs
- step outputs
- `saveState` / `getState`
- GitHub-style failure reporting

If Forgejo compatibility covers those behaviors closely enough, this may still be fine. If not, Codeberg support is no longer just “write a new provider adapter”; it also needs a narrower host contract or a provider-specific host that can emulate those semantics safely.

### 2. Cache and artifact seams still carry GitHub-shaped assumptions

The code now has top-level seams for:

- base cache operations
- workflow artifact operations

However, some shared contracts still encode GitHub-oriented assumptions, for example:

- cache availability/status wording still talks about the Actions cache runtime
- `ArtifactFindOptions.findBy` is keyed by `workflowRunId`, `repositoryOwner`, and `repositoryName`
- some artifact lookup/verification wording still assumes GitHub job naming or GitHub-provided digests

So the seam is there, but Codeberg still needs a little shared cleanup beyond pure provider wiring.

### 3. The action still depends on GitHub Actions toolkits

The codebase still depends on:

- `@actions/core`
- `@actions/cache`
- `@actions/artifact`

For Codeberg, this may or may not be acceptable depending on the exact Forgejo/Codeberg runtime behavior. Forgejo explicitly documents **familiarity instead of compatibility**, so this should be treated as a real integration risk, not assumed to work.

### 4. Entry points are still GitHub Action shaped

The project is still packaged through a GitHub-specific action descriptor at
`action-descriptors/github/very-temporary-unreleased-consumer-path/action.yml`, including:

- action inputs
- outputs
- `post` entrypoint
- `post-if`

If Codeberg executes JavaScript actions with enough GitHub compatibility, this may still be fine. But it means portability is not purely inside `src/ci/**`.

## What “not adapter-only” means concretely

Besides the Codeberg-specific work itself (event/env mapping, URLs, headers, summary/log behavior), the remaining cross-cutting tasks are:

1. Narrow the runtime-host contract so inputs, outputs, state handoff, failure reporting, and path discovery are not all assumed to come from one GitHub-Action-shaped surface.
2. Generalize artifact lookup coordinates away from GitHub-specific `workflowRunId` / owner / repository fields toward a provider-neutral execution-scope object.
3. Isolate lifecycle assumptions so `main`/`post` is primarily a host concern rather than a shared-core assumption.
4. Provide a provider-neutral consumer/package surface, or at least a CLI fallback, so packaging is not tied only to a GitHub action descriptor.
5. Add explicit compatibility checks for `@actions/core`, `@actions/cache`, `@actions/artifact`, and JavaScript-action post behavior on the target Codeberg/Forgejo runtime.

If Forgejo compatibility proves strong, some of those can stay as light-touch wrappers. If not, these are the concrete non-Codeberg-centric tasks that turn the work from “add an adapter” into “finish the portability refactor”.

## What would likely need to be done

### A. Keep the current CI/runtime split and add a Codeberg provider implementation

Likely work:

- add a `createForgejoPlatform()` or `createCodebergPlatform()` implementation
- add a corresponding runtime-host implementation if Forgejo compatibility is not good enough to reuse the GitHub one unchanged
- map Forgejo/Codeberg event metadata, URLs, summary file path, and log-group behavior there
- decide whether to model the provider as `forgejo` or `codeberg` for long-term correctness

This part should be straightforward.

### B. Narrow the remaining GitHub-shaped shared contracts

The smallest helpful shared cleanup would be:

- split `ActionRuntimeHost` into narrower capabilities, or at least document which capabilities may be emulated by a non-GitHub host
- replace `ArtifactFindOptions.findBy` with a provider-neutral execution-scope object
- scrub remaining GitHub-specific wording from shared cache/artifact status and error surfaces

Those are not Codeberg-specific features, but they lower the risk of the later provider port substantially.

### C. Keep provider-specific inputs confined to provider-specific entrypoints

This cleanup is mostly done now.

For example, the GitHub-only `github-job-check-run-id` input is consumed in `src/ci/github/*` rather than flowing through generic config normalization.

That pattern should continue for future Codeberg-only quirks as well: keep them inside provider-specific wiring instead of widening shared config models.

### D. Audit toolkit compatibility instead of assuming it

Before committing to Codeberg support, do a small spike that verifies:

- `@actions/core` input/output/state behavior
- JavaScript action `post` behavior
- `@actions/cache` behavior
- `@actions/artifact` upload/download/list/delete behavior

This is especially important because Forgejo explicitly does **not** promise full GitHub Actions compatibility.

### E. Re-check security boundaries

Security review items for a future Codeberg port:

- token scope and masking behavior
- pull-request/fork secret exposure semantics
- artifact visibility and cross-run lookup permissions
- cache poisoning behavior on untrusted branches/PRs

Do not assume GitHub security semantics transfer exactly.

## Rough effort estimate

If the Forgejo/Codeberg runtime proves compatible enough with the GitHub Actions toolkits:

- **Adapter + focused shared refactors:** small-to-medium effort
- **Validation and provider-specific workflow wiring:** medium effort

If toolkit compatibility is partial or weak:

- **Runtime-host/lifecycle refactor + provider adapter + artifact/cache contract cleanup:** medium-to-large effort

So the realistic summary is:

- **best case:** moderate effort
- **likely case:** moderate effort with one or two additional abstraction passes
- **worst case:** much larger if `@actions/cache` / `@actions/artifact` compatibility is poor

## Recommended future sequence

If Codeberg support becomes a real goal later, the safest order looks like this:

1. Spike actual Codeberg/Forgejo compatibility for `@actions/core`, `@actions/cache`, and `@actions/artifact`.
2. Add a real Codeberg/Forgejo provider implementation under `src/ci/codeberg/*` or `src/ci/forgejo/*`.
3. Add a provider-specific runtime host only if Forgejo compatibility is too weak to reuse the GitHub one safely.
4. Re-check cache/artifact backend assumptions against the real Codeberg runtime and APIs.
5. Only then freeze user-facing provider packaging/descriptor paths.

## Final assessment

The current CI adapter refactor was worthwhile and moves the project in the right direction.

For Codeberg, I would describe the codebase as:

> **portable enough to justify future support, but not yet portable enough to make it an adapter-only task.**

The main remaining question is not the high-level shape anymore. It is whether the GitHub-oriented runtime/toolkit assumptions are compatible enough with the real Codeberg runtime to reuse the current seams safely.
