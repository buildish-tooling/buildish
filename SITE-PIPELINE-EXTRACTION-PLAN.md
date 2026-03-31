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

# Site Pipeline Extraction Plan

## Status and design stance

This document describes how to turn the current site pipeline into its own reusable component in a separate Git repository so other Apache projects can adopt it.

**Important:** this work happens before the wider Buildish stack goes public. There is **no legacy or backward-compatibility obligation** to preserve. We should optimize for the cleanest long-term design now, even if that means:

- renaming files, packages, and commands,
- changing schemas,
- changing staged output layouts,
- changing repository structure,
- deleting Buildish-specific assumptions,
- and breaking any current in-repo internal contract.

This is the right time to make the design correct.

## Goal

Create a reusable Apache-hosted site-pipeline component that can:

- aggregate content from multiple repositories,
- validate and normalize project metadata,
- stage content into a deterministic contract for a static site generator,
- support local build and watch workflows,
- and optionally provide reference CI/container integration.

Buildish becomes the first consumer of that component rather than the long-term home of its implementation.

## Non-goals for the first extraction

The first extraction should **not** try to move every Buildish site concern into the new repo.

Do not treat these as phase-1 scope:

- the Buildish homepage content,
- Buildish-specific Hugo pages and copy,
- Buildish-specific incubation/trademark/footer presentation,
- Buildish-specific publishing workflow details,
- Buildish branding, navigation, or component naming conventions.

## Product split

We should split the current `site/` implementation into three conceptual deliverables.

### 1. Core staging pipeline

Reusable and generic:

- catalog loading,
- per-component metadata loading,
- safety checks,
- content staging,
- staged data generation,
- watch support,
- CLI entry points.

This is the first thing to extract.

### 2. Optional build/runtime packaging

Reusable but not core to the API:

- reproducible container image,
- tool bootstrap for CI,
- example build wrappers.

### 3. Reference presentation/integration

Reusable examples, but intentionally optional:

- Hugo integration guidance,
- shortcodes/layout examples,
- example workflows,
- example publish flow.

## What moves to the new repo

Initial target:

- `site/pipeline/`
  - package code
  - tests
  - CLI
  - `pyproject.toml`
  - lockfile
- the minimum docs needed to describe:
  - input schemas
  - staged output contract
  - trust/security model
  - CLI usage
- optional container-image build assets if they are kept generic

## What stays in Buildish

Keep these in this repository:

- `site/content/`
- `site/layouts/`
- `site/static/`
- `site/assets/`
- `site/hugo.yaml`
- Buildish-specific workflows
- Buildish-specific homepage/legal/incubator presentation
- Buildish-specific catalog content and component examples

Buildish should consume the extracted pipeline as a dependency.

## Proposed new repository shape

Suggested neutral structure:

- `README.md`
- `docs/`
- `examples/`
- `pipeline/`
  - `pyproject.toml`
  - `uv.lock`
  - `src/<neutral_package_name>/`
  - `tests/`
- `Containerfile-site-pipeline` (optional)
- `.github/workflows/`

The new repo should look like a standalone product, not like a copied subdirectory from Buildish.

## Naming recommendations

Use neutral names from the start.

### Avoid

- package names containing `buildish`
- CLI names containing `buildish`
- repo names that imply Buildish-only usage

### Prefer

- a neutral repo name such as `apache-site-pipeline` or `multi-repo-site-pipeline`
- a neutral Python package name
- a neutral CLI command such as `site-pipeline`

Exact naming can be finalized in phase 1, but neutrality is required.

## Contracts that must be made explicit

Before extraction, we need to define stable contracts instead of relying on current Buildish behavior.

### Input contract

Document and version:

- catalog file schema,
- component metadata schema,
- expected content directories,
- optional fields and defaults,
- reserved names.

### Output contract

Document and version:

- staged content tree,
- staged data files,
- staged static assets,
- manifest/lifecycle outputs,
- watch/build side effects.

### Security contract

Document and preserve:

- path traversal protections,
- symlink handling,
- reserved pipeline-owned paths,
- no network fetching in normal builds,
- trust model for local overrides,
- no component-supplied arbitrary renderer logic.

## Buildish migration target

After extraction, Buildish should stop calling in-repo Python files directly.

Current model:

- `site/Makefile` points to `pipeline/main.py`

Target model:

- `site/Makefile` calls an installed CLI or package entry point
- Buildish pins a released version of the pipeline
- integration tests exercise Buildish as a real consumer

This is critical. Buildish must not keep a privileged/private integration path after the split.

## Recommended phases

## Phase 1: productize the pipeline in-place

Do this in the current repo first.

1. Remove Buildish-specific assumptions from the Python pipeline.
2. Introduce neutral package/module/CLI naming.
3. Define and document explicit input/output/security contracts.
4. Separate core pipeline logic from presentation/theme assumptions.
5. Make Buildish’s `site/Makefile` capable of using an installed CLI instead of `pipeline/main.py`.
6. Add tests that validate the contract, not just current implementation details.

### Phase-1 deliverable

At the end of phase 1, the pipeline should be extractable with minimal code movement and without hidden Buildish coupling.

## Phase 2: create the new repo

1. Move the generic pipeline package and tests.
2. Add standalone docs and examples.
3. Add release automation for source releases.
4. Optionally add generic container-image build support.

## Phase 3: convert Buildish into consumer #1

1. Replace in-tree execution with dependency usage.
2. Update CI and local tooling to use the released component.
3. Keep Buildish-specific site rendering and publishing logic in this repo.
4. Add an end-to-end test that proves Buildish works as an external consumer.

## Phase 4: enable broader Apache adoption

1. Publish example integrations.
2. Provide reusable workflow examples.
3. Provide migration docs for single-repo and multi-repo adopters.
4. Stabilize toward a `1.0` contract after enough consumer feedback.

## Concrete phase-1 work items

Phase 1 should produce these artifacts here in this repo:

- a neutral naming proposal,
- a documented schema for catalog and component metadata,
- a documented staged output contract,
- a documented trust/security model,
- a package/CLI layout that can be moved as-is,
- tests that cover contract-level behavior,
- a Buildish integration path that uses the future external CLI shape.

## Success criteria

We are ready to extract when all of the following are true:

- the core pipeline has no Buildish-specific naming or assumptions,
- Buildish-specific site presentation remains in this repo,
- the pipeline can be used via a neutral CLI,
- contracts are documented and versioned,
- Buildish passes as a normal consumer,
- moving the code to a new repo is mostly file relocation, not redesign.

## Immediate next step

Start **phase 1** in this repository.

That means we should first inventory and remove current Buildish-specific assumptions from the pipeline package and decide the neutral naming for:

- the future repo,
- the Python package,
- the CLI,
- and the schema/version identifiers.