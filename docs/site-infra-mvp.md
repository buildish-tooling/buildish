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

# MVP status: Buildish site infrastructure

## Current status

The current MVP is considered complete for the **unreleased-first local site
workflow**.

The implementation under `site/` provides:

- catalog-driven aggregation from `site/projects.yaml`,
- per-project metadata loading from each sub-project's `site/project.yaml`,
- staged generated content and metadata under `site/.stage/`,
- local Hugo + Docsy rendering,
- watch-based restaging for interactive local development,
- containerized reproducible verification, and
- repository-level license-header checking via Apache RAT.

Release snapshot staging is still intentionally deferred. In practice, the MVP
should currently be treated as **unreleased-first and unreleased-only**.

The current sub-project metadata contract is documented separately in
[`site-subproject-contract.md`](site-subproject-contract.md).

## Supported workflows

### Local site workflow

From `site/` the MVP supports:

- `make build`
- `make serve`
- `make stage-watch`
- `make test`
- `make integration-test`

These commands stage content from the local workspace, render the site with
Hugo, and exercise both unit and fixture-based integration coverage.

In local `make serve` sessions, catalog changes in `site/projects.yaml` are
eventually reflected, but route removals can linger briefly in the already-running
Hugo server even after the staged catalog has been rebuilt. This is treated as an
accepted development-only inconvenience rather than a correctness issue in the
staged-site contract.

### Containerized workflow

From `site/` the MVP also supports:

- `make container-image`
- `make container-test`
- `make container-integration-test`
- `make container-check-fast`
- `make container-build`

The containerized path uses pinned multi-architecture base-image index digests
with an explicit platform selection derived from the local host architecture.
This keeps the builder reproducible while avoiding ambiguous platform selection
by the container engine.

### Repository verification

From the repository root the MVP also includes:

- `make rat-check`

for Apache RAT license-header validation.

## Current MVP contract

### Inputs

The MVP assumes these inputs:

- `site/projects.yaml` in the main repository,
- `site/project.yaml` in each participating sub-project,
- `site/docs/` in each participating sub-project,
- optional `site/assets/` in each participating sub-project.

### Outputs

The staging and rendering flow currently produces:

- `site/.stage/content/projects/<slug>/unreleased/...`
- `site/.stage/data/projects.yaml`
- `site/.stage/data/lifecycle.yaml`
- `site/.stage/static/projects/<slug>/unreleased/assets/...` for optional
  project assets,
- `site/.preview/` for the lightweight Python preview output,
- `site/.public/` for the Hugo-rendered site.

### Metadata and content scope

The aggregator currently supports the parts of `site/project.yaml` needed for:

- project identity,
- content root overrides,
- unreleased labeling,
- release-line lifecycle annotations.

## Security baseline

The MVP keeps the core safety guardrails from the broader site proposal:

- no arbitrary code execution from sub-project content,
- no `iframe` embeds,
- no embedded remote content,
- no arbitrary embedded JavaScript,
- no remote fetching during normal local site builds,
- no path traversal or symlink escapes outside approved content roots.

## Out of scope

The following remain outside the MVP:

- production publication to `buildish.apache.org`,
- cross-repository trigger and authentication design,
- release snapshot staging from real exact-version tags,
- full release automation,
- full search, sitemap, and redirect behavior,
- full AsciiDoc validation and support,
- broader theme and navigation polish.

## Next hardening areas

The next phase after this MVP should focus on hardening rather than widening
scope. The main follow-up areas are:

- stricter content and schema validation,
- release snapshot staging from real tags,
- AsciiDoc support validation,
- lifecycle/content schema tightening,
- search, sitemap, redirect, and indexing policy hardening,
- publication automation and cross-repository trigger design.

