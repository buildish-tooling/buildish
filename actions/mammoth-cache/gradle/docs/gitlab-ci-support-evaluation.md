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

# GitLab CI support evaluation

This note evaluates the likely effort to support GitLab CI later.

For the concrete shared refactor sequence and proposed target architecture, see
`docs/provider-portability-implementation-plan.md`.

## Bottom line

The current `src/ci/**` adapter is **not sufficient** to make GitLab support a small follow-on task.

For GitLab, the main problem is not event/ref parsing. The main problem is that this project is still fundamentally shaped like a **GitHub Action runtime**:

- `action-descriptors/github/internal-unreleased-consumer-path/action.yml`
- `@actions/core`
- `@actions/cache`
- `@actions/artifact`
- main/post lifecycle
- action inputs/outputs/state

GitLab CI has useful equivalents for some of these concepts, but they are exposed through a **different execution model**. Supporting GitLab later would still require a **different packaging/invocation story** and likely a **GitLab-specific runtime host / lifecycle model**, not just a new CI adapter.

## Why the current CI adapter still helps

The existing adapter work is still valuable.

It already centralizes:

- normalized CI metadata
- execution URLs
- provider-specific summary/log hooks
- provider-scoped HTTP headers

GitLab also exposes rich predefined variables such as:

- `CI_JOB_URL`
- `CI_PIPELINE_URL`
- `CI_SERVER_URL`
- `CI_PROJECT_DIR`
- `CI_PROJECT_PATH`
- `CI_JOB_TOKEN`

So the metadata side of the problem is manageable.

## Why GitLab is a bigger lift than Codeberg

### 1. GitLab does not execute this project as a GitHub Action

Today the project is published and invoked through the GitHub action descriptor as a JavaScript action with:

- inputs
- outputs
- `post`
- `post-if`

GitLab CI jobs do not consume that GitHub action descriptor model. GitLab runs job scripts defined in `.gitlab-ci.yml`.

That means GitLab support would need one of these approaches:

- a dedicated CLI entrypoint invoked from `.gitlab-ci.yml`
- a wrapper script/container image for GitLab
- or a broader runtime abstraction that can host the same core logic outside GitHub Actions

This is the single biggest portability gap.

### 2. The runtime-host contract is still GitHub Actions specific

The refactor already introduced a runtime-host seam, which is good.

But the contract itself still models GitHub Actions toolkit behavior for:

- inputs
- outputs
- state handoff between main and post
- failure reporting

GitLab has no direct equivalent to GitHub Action `saveState` / `getState`, so a future GitLab host would need a different state/lifecycle strategy.

### 3. The action depends on a post-action lifecycle

A lot of the design assumes a main phase plus a later post phase.

That is normal for GitHub Actions JavaScript actions, but GitLab CI does not provide the same action-level post hook. The closest GitLab concept is usually `after_script`, which is job-level shell behavior, not action-runtime behavior.

That affects:

- base cache save timing
- delta capture/upload timing
- build-result summary generation
- cleanup of consumed delta artifacts

This likely requires a deliberate redesign of lifecycle control for GitLab.

### 4. The cache backend seam exists, but the contract is still Actions-cache shaped

The code now has a `BaseCacheApi` seam, but the contract and status model are still shaped around the Actions cache runtime.

GitLab cache behavior is largely configured in `.gitlab-ci.yml` and handled by the runner. It is not the same as calling a GitHub Actions cache toolkit from inside a Node program.

Even though GitLab has caching, that does **not** mean the current cache implementation can be reused as-is.

At minimum, a GitLab port would need one of these decisions:

- reimplement cache restore/save against GitLab-native mechanisms
- treat GitLab cache as workflow-level wiring outside this action logic
- or disable/replace parts of current base-cache behavior for GitLab

### 5. The artifact backend seam exists, but the lookup model is still GitHub-shaped

The code now has a `WorkflowArtifactApi` seam, but the distributed delta flow still depends on artifact behavior shaped around GitHub workflow runs/jobs for:

- upload
- lookup
- download
- delete
- cross-run coordinates tied to workflow-run identity

GitLab has job artifacts and an artifacts API, but the API shape and lifecycle are different. Artifacts are naturally tied to jobs/pipelines and are usually declared in `.gitlab-ci.yml`.

In particular, `ArtifactFindOptions.findBy` currently uses GitHub-oriented coordinates (`workflowRunId`, repository owner/name), which is exactly the sort of shared contract that needs widening before GitLab support becomes comfortable.

### 6. The core is more provider-neutral now, but GitLab still needs a different execution model

Recent refactors already improved several earlier portability blockers:

- `src/ci/types.ts` is provider-neutral
- `src/runtime/job-single-run.ts` now consumes normalized CI context instead of raw `GITHUB_*` env
- delta artifact producer metadata is no longer tagged with a GitHub-only platform field

That is real progress, but it does **not** remove the need for a GitLab-specific host/lifecycle model because GitLab still does not execute JavaScript actions with GitHub main/post semantics.

## Architectural preparation needed before GitLab becomes realistic

### A. Split `ActionRuntimeHost` into narrower capabilities

Today `ActionRuntimeHost` bundles several concerns together:

- input resolution
- state handoff
- output emission
- logging and failure reporting

For GitLab preparation, that should become smaller capability interfaces such as:

- `RuntimeInputSource`
- `RuntimeStateStore`
- `RuntimeOutputSink`
- `RuntimeReporter`
- `RuntimePaths`

Then `bootstrap`, `main-flow`, and `post-flow` can depend only on the pieces they actually need, instead of assuming a GitHub-Action-shaped runtime object.

### B. Add an explicit lifecycle driver instead of assuming GitHub `main`/`post`

GitHub Actions happens to provide a two-phase JavaScript-action lifecycle.

GitLab does not. So the project needs an explicit lifecycle abstraction such as:

- `prepare` / `finalize`
- or `restore` / `complete`

The current GitHub action entrypoints can remain thin adapters over that lifecycle, while GitLab can map it to job scripts, `after_script`, or two explicit commands.

### C. Extract a CLI-friendly core

The core orchestration in `bootstrap`, `main-flow`, and `post-flow` should eventually be callable from:

- GitHub Action entrypoints
- a plain Node CLI
- possibly a future container entrypoint

That would let GitLab invoke the same core logic from `.gitlab-ci.yml` instead of pretending to be a GitHub Action runtime.

### D. Generalize artifact lookup and execution-scope identity

The current artifact contract is not quite abstracted at the right level for GitLab.

As preparation, replace GitHub-oriented lookup coordinates with a provider-neutral scope object that can represent at least:

- repository/project identity
- workflow-run or pipeline identity
- job identity
- auth context

That change belongs in shared code, because it is not GitLab-specific; it is the missing abstraction point for any non-GitHub backend.

### E. Decouple reporting surfaces from provider-native summaries

Current reporting assumes two provider surfaces:

- grouped logs
- replaceable/appendable job summaries

For GitLab prep, introduce a report sink abstraction so the same generated Markdown/details can be sent to:

- a native summary surface when one exists
- a plain log sink
- a generated file or uploaded artifact

That keeps report generation reusable without forcing every provider to emulate GitHub step summaries.

### F. Redesign lifecycle for non-post environments

Because GitLab does not provide GitHub Action post hooks, future support would need a clear lifecycle model, for example:

- one command for restore/bootstrap
- one command for finalization/save/upload
- or a single command with explicit trap/after-script integration

This is a real design task, not a small adapter patch.

### G. Widen cache and artifact contracts where they are still GitHub-shaped

The current cache/artifact seams are useful, but a GitLab prep pass should still widen the shared contracts where they encode GitHub-specific assumptions.

Concretely, that means:

- avoid GitHub-specific terminology in shared result/status text
- move GitHub-specific artifact lookup coordinates out of `ArtifactFindOptions`
- make digest/retention/delete semantics explicit capabilities rather than assuming GitHub-style behavior

After that, GitLab-specific backends can use:

- GitLab cache wiring where feasible
- GitLab job artifacts / artifacts API
- `CI_JOB_TOKEN` for authenticated API access where appropriate

### H. Revisit summary/log UX for GitLab

GitHub step summaries map fairly well to the current design.

GitLab does not have the same job-summary surface. It does, however, support custom collapsible log sections in job logs and exposes job/pipeline URLs directly.

A future GitLab implementation would probably:

- lean more heavily on grouped/collapsible logs
- treat any Markdown summary as an uploaded artifact or generated file
- avoid assuming a provider-native step-summary file exists

### I. Re-check security assumptions explicitly

Future GitLab review items should include:

- `CI_JOB_TOKEN` scope and cross-job artifact access rules
- branch protection vs cache sharing behavior
- merge request vs branch pipeline trust boundaries
- artifact retention/deletion semantics
- forked-merge-request behavior and secret exposure

GitHub assumptions should not be copied over blindly.

## Rough effort estimate

For GitLab, the likely effort is **large compared with Codeberg**.

Reasonable forecast:

- **small effort:** unrealistic
- **medium effort:** possible only if the goal is a very reduced feature set
- **large effort:** likely for near-feature-parity with current GitHub behavior

The most expensive parts are not metadata mapping. They are:

- runtime-host splitting/capability design
- lifecycle redesign
- cache backend redesign
- artifact backend redesign
- GitLab-specific workflow packaging/documentation

## A sensible future scope split

If GitLab support is pursued later, it would help to decide up front between two goals.

### Option 1: “reduced GitLab support”

Possible scope:

- wrapper provisioning
- config parsing/validation
- CI metadata normalization
- build-result reporting in logs
- maybe limited artifact exchange

Likely excludes or defers:

- full post-phase parity
- full base-cache parity
- exact GitHub-style artifact lifecycle behavior

This is the lowest-risk path.

### Option 2: “close to GitHub parity”

This would aim to preserve:

- main/finalize lifecycle
- base cache semantics
- distributed delta exchange
- cleanup behavior
- similar observability surfaces

That likely requires the larger redesign described above.

## Recommended future sequence

If GitLab support becomes a real roadmap item later, the safest order looks like this:

1. Split the current runtime host into smaller capabilities and introduce an explicit lifecycle driver.
2. Extract a **CLI-friendly core** that does not require a GitHub action descriptor.
3. Generalize artifact execution-scope lookup and report-sink abstractions in shared code.
4. Add a GitLab-capable host plus GitLab-specific **cache** and **artifact** backends.
5. Design and validate the GitLab lifecycle model using job scripts / `after_script` / explicit finalize commands.
6. Only then implement and validate a GitLab provider/package surface.

## Final assessment

For GitLab, I would describe the current codebase as:

> **not yet abstracted at the right level for low-cost provider support.**

The current CI adapter is useful, but GitLab support would require a broader shift from a **GitHub Action-shaped application** to a **provider-neutral core plus provider/runtime/reporting/storage adapters**.
