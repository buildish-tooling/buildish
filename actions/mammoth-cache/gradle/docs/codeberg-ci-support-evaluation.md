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

## Bottom line

The codebase is in a **meaningfully better place** for future Codeberg support than it was before the SPI refactor.

Today there is a real split between:

- provider metadata/log/summary wiring in `src/ci/**`
- runtime-host behavior in `src/ci/runtime-host.ts`
- cache and artifact backend interfaces in `src/cache/service.ts` and `src/artifacts/service.ts`

That means Codeberg support later looks **plausible with moderate follow-on work**, not a rewrite. But it is still **not adapter-only yet**, because the only production implementations are still GitHub-oriented and the packaging/runtime model is still a GitHub JavaScript action.

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

### 1. The production runtime host is still GitHub Actions specific

The runtime-host boundary now exists, which is good.

But the only real implementation is still `src/ci/github/runtime-host.ts`, backed by `@actions/core` semantics such as:

- action inputs
- step outputs
- `saveState` / `getState`
- GitHub-style failure reporting

That is enough for GitHub today, but future Codeberg support still depends on Forgejo compatibility for those toolkit behaviors.

### 2. Cache and artifact seams exist, but only GitHub implementations ship today

The code now has provider-neutral interfaces for:

- base cache operations
- workflow artifact operations

However, the production implementations are still GitHub-specific and wired from `src/ci/github/*` via:

- `createGitHubBaseCacheApi()`
- `createGitHubWorkflowArtifactApi()`

So the seam is there, but Codeberg still depends on either GitHub-compatibility or a future Codeberg/Forgejo implementation.

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

## What would likely need to be done

### A. Keep the current CI/runtime split and add a Codeberg provider implementation

Likely work:

- add a `createForgejoPlatform()` or `createCodebergPlatform()` implementation
- add a corresponding runtime-host implementation if Forgejo compatibility is not good enough to reuse the GitHub one unchanged
- map Forgejo/Codeberg event metadata, URLs, summary file path, and log-group behavior there
- decide whether to model the provider as `forgejo` or `codeberg` for long-term correctness

This part should be straightforward.

### B. Keep provider-specific inputs confined to provider-specific entrypoints

This cleanup is mostly done now.

For example, the GitHub-only `github-job-check-run-id` input is consumed in `src/ci/github/*` rather than flowing through generic config normalization.

That pattern should continue for future Codeberg-only quirks as well: keep them inside provider-specific wiring instead of widening shared config models.

### C. Audit toolkit compatibility instead of assuming it

Before committing to Codeberg support, do a small spike that verifies:

- `@actions/core` input/output/state behavior
- JavaScript action `post` behavior
- `@actions/cache` behavior
- `@actions/artifact` upload/download/list/delete behavior

This is especially important because Forgejo explicitly does **not** promise full GitHub Actions compatibility.

### D. Re-check security boundaries

Security review items for a future Codeberg port:

- token scope and masking behavior
- pull-request/fork secret exposure semantics
- artifact visibility and cross-run lookup permissions
- cache poisoning behavior on untrusted branches/PRs

Do not assume GitHub security semantics transfer exactly.

## Rough effort estimate

If the Forgejo/Codeberg runtime proves compatible enough with the GitHub Actions toolkits:

- **Adapter + focused refactors:** small-to-medium effort
- **Validation and provider-specific workflow wiring:** medium effort

If toolkit compatibility is partial or weak:

- **Runtime-host abstraction + provider adapter + artifact/cache rework:** medium-to-large effort

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
