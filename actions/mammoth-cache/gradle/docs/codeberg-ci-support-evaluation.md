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

- provider metadata in `src/ci/**`
- report publication in `src/reporting/**`
- runtime-host capabilities in `src/runtime-host/**`
- shared prepare/finalize entrypoints in `src/entrypoints/cli/**`
- cache and artifact backend interfaces in `src/storage/**`

That means Codeberg support later looks **plausible with moderate follow-on work**, not a rewrite. The remaining risk is now centered more on **runtime/toolkit compatibility and provider packaging** than on missing shared-core seams.

## Why Codeberg looks feasible

- Forgejo documents `github` context and `GITHUB_*` environment-variable aliases for compatibility.
- Forgejo also documents `FORGEJO_STEP_SUMMARY` and compatibility aliases for `GITHUB_STEP_SUMMARY`.
- The recently refactored CI adapter already centralizes:
  - event/ref parsing
  - execution URLs
  - provider summary/log rendering hooks
  - provider-scoped HTTP headers

Those are exactly the kinds of things that should live in a provider adapter.

The shared portability prep is now largely complete; the remaining work is mostly validating a real Forgejo runtime and adding the provider-specific host/descriptor/backend pieces only where compatibility actually requires them.

## Why the current abstraction is not sufficient by itself

Several important portability concerns still remain.

### 1. The runtime-host contract is still GitHub Action-shaped

The runtime-host boundary now exists, which is good.

But the current composite runtime host still directly models `@actions/core`-style semantics such as:

- action inputs
- step outputs
- `saveState` / `getState`
- GitHub-style failure reporting

If Forgejo compatibility covers those behaviors closely enough, this may still be fine. If not, Codeberg support is no longer just “write a new provider adapter”; it also needs a narrower host contract or a provider-specific host that can emulate those semantics safely.

### 2. Cache and artifact seams still carry GitHub-shaped assumptions

The code now has top-level seams for:

- base cache operations
- workflow artifact operations

However, some shared contracts still encode provider-specific assumptions, for example:

- cache behavior still assumes a programmatic restore/save backend rather than runner-managed cache wiring
- artifact lookup scope is provider-neutral now, but it still only models repository/run/auth lookup context
- some artifact lookup/verification behavior still assumes unique producer-job identity and backend-reported digests when available

So the seam is there, but Codeberg still needs a little shared cleanup beyond pure provider wiring.

### 3. The action still depends on GitHub Actions toolkits

The codebase still depends on:

- `@actions/core`
- `@actions/cache`
- `@actions/artifact`

For Codeberg, this may or may not be acceptable depending on the exact Forgejo/Codeberg runtime behavior. Forgejo explicitly documents **familiarity instead of compatibility**, so this should be treated as a real integration risk, not assumed to work.

### 4. Shared entrypoints exist now, but packaging is still GitHub-action-first

The shared core now exposes provider-neutral `prepare` / `finalize` entrypoints under
`src/entrypoints/cli/**`.

However, the published consumer path is still packaged through the GitHub-specific action
descriptor at `action-descriptors/github/internal-unreleased-consumer-path/action.yml`, including:

- action inputs
- outputs
- `post` entrypoint
- `post-if`

If Codeberg executes JavaScript actions with enough GitHub compatibility, this may still be fine. But future Codeberg packaging still needs a provider-specific descriptor decision.

## What “not adapter-only” means concretely

Besides the Codeberg-specific work itself (event/env mapping, URLs, headers, summary/log behavior), the remaining cross-cutting tasks are:

1. Decide whether the current provider-neutral artifact lookup scope needs to widen beyond repository/run/auth context for a real Forgejo backend.
2. Validate `@actions/core`, `@actions/cache`, `@actions/artifact`, and JavaScript-action post behavior on the target Codeberg/Forgejo runtime.
3. Confirm whether Codeberg can reuse the current GitHub-shaped runtime host safely or needs a small compatibility host shim.
4. Add provider-specific descriptor/packaging once the runtime compatibility story is proven.

If Forgejo compatibility proves strong, most of the remaining work really can stay provider-specific.

## What would likely need to be done

### A. Keep the current CI/runtime split and add a Codeberg provider implementation

Likely work:

- add a `createForgejoPlatform()` or `createCodebergPlatform()` implementation
- add a corresponding runtime-host implementation if Forgejo compatibility is not good enough to reuse the GitHub one unchanged
- map Forgejo/Codeberg event metadata, URLs, summary file path, and log-group behavior there
- decide whether to model the provider as `forgejo` or `codeberg` for long-term correctness

This part should be straightforward.

### B. Reuse the current shared seams and widen them only if the real backend needs it

Most of the helpful shared prep is already in place:

- runtime-host capabilities are split
- lifecycle is `prepare` / `finalize`
- report publication is provider-neutral
- shared CLI-style entrypoints exist

The main remaining shared question is whether a real Forgejo backend needs broader artifact lookup identity than the current repository/run/auth-oriented scope exposes.

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

- **Adapter + focused validation:** small-to-medium effort
- **Validation and provider-specific workflow wiring:** medium effort

If toolkit compatibility is partial or weak:

- **Host compatibility work + provider adapter + artifact/cache contract cleanup:** medium-to-large effort

So the realistic summary is:

- **best case:** moderate effort
- **likely case:** moderate effort with one or two compatibility-driven cleanup passes
- **worst case:** much larger if `@actions/cache` / `@actions/artifact` compatibility is poor

## Recommended future sequence

If Codeberg support becomes a real goal later, the safest order looks like this:

1. Spike actual Codeberg/Forgejo compatibility for `@actions/core`, `@actions/cache`, and `@actions/artifact`.
2. Add a real Codeberg/Forgejo provider implementation under `src/ci/codeberg/*` or `src/ci/forgejo/*` plus a provider report sink if needed.
3. Add a provider-specific runtime host only if Forgejo compatibility is too weak to reuse the GitHub one safely.
4. Re-check cache/artifact backend assumptions against the real Codeberg runtime and APIs.
5. Freeze user-facing provider packaging/descriptor paths once runtime behavior is proven.

## Final assessment

The current CI adapter refactor was worthwhile and moves the project in the right direction.

For Codeberg, I would describe the codebase as:

> **portable enough to justify future support, with the remaining risk concentrated in runtime/toolkit compatibility rather than missing shared-core seams.**

The main remaining question is not the high-level shape anymore. It is whether the GitHub-oriented runtime/toolkit assumptions are compatible enough with the real Codeberg runtime to reuse the current seams safely.
