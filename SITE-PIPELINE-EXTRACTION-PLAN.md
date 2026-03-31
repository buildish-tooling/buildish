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

## Objective

Extract the current site pipeline into a reusable Apache-hosted component that
Buildish consumes as a normal dependency.

The pipeline should own generic staging, validation, configuration, and local
workflow logic. Buildish should keep its own site presentation, content, and
project-specific integration decisions.

## Current state

## Dependency additions during extraction

- Phase 1: no new external dependencies added.
- Phase 2: no new external dependencies added; the extracted
  `buildish-site-pipeline/` repo currently reuses the same dependency set as the
  in-repo package.

### Implemented

- The front matter contract is namespaced as:
  - `sitePipeline`
  - `sitePipelineComponent`
  - `sitePipelineComponentPage`
- The pipeline supports configuration from both CLI arguments and
  `site/site-pipeline.yaml`.
- Configuration precedence is:
  1. CLI arguments
  2. configuration file
  3. built-in defaults
- `siteTitle`, `projectStatus`, and the workspace paths below are
  configuration-driven:
  - `workspace.catalogPath`
  - `workspace.authoredSiteContentPath`
  - `workspace.stagePath`
  - `workspace.previewPath`
- Workspace paths are resolved relative to the repository root and validated so
  authored inputs and generated outputs cannot overlap protected source roots or
  escape the repository boundary.
- `projectStatus` is restricted to:
  - `incubating`
  - `graduated`
  - `retired`
- The builder no longer depends on repository `DISCLAIMER` content.
- `site/Makefile` delegates pipeline-local targets to `site/pipeline/Makefile`.
- The implementation package/module is now `apache_buildish_site_pipeline`.
- Local workflows now invoke the installable `site-pipeline` CLI through the
  local `uv` project.
- Buildish-specific project-status presentation now lives in the Buildish site
  layer.
- Public component/docs/release URLs are now derived from the staged content
  tree, and preview HTML links are derived from the resolved workspace output
  paths instead of from hard-coded Buildish defaults.

### Still coupled to Buildish or in-repo execution

- The current staged contract is still shaped around the Buildish Hugo/Docsy
  integration, even though the duplicated URL/preview conventions were removed
  from the core.
- Buildish still executes the in-repo implementation instead of consuming a
  released package.

## Target split

### Moves to the extracted repository

- reusable staging, build, clean, serve, and watch logic
- input validation and safety checks
- configuration loading and precedence rules
- staged output/data contract
- generic CLI and tests
- optional runtime/container assets if they remain generic

### Stays in Buildish

- `site/content/`
- `site/layouts/`
- `site/static/`
- `site/assets/`
- `site/hugo.yaml`
- Buildish-specific project-status/legal presentation
- Buildish-specific navigation, branding, and publishing workflows

## Naming target

- Repository: `buildish-site-pipeline`
- Python package: `apache_buildish_site_pipeline`
- CLI: `site-pipeline`

## Required contracts

### Input contract

Document and version:

- catalog schema
- component metadata schema
- pipeline configuration schema
- workspace defaults and override points
- reserved names and reserved paths

### Output contract

Document and version:

- staged content tree
- staged data files
- staged static assets
- manifest/lifecycle outputs
- watch/build side effects
- front matter namespaces and payload shapes

### Security contract

Document and preserve:

- path traversal protections
- symlink handling rules
- repository-root restrictions for config and workspace inputs
- reserved pipeline-owned paths
- no network fetching in normal builds
- no component-supplied arbitrary renderer logic

## Remaining phases

### Phase 1: finish in-place productization

Status: complete.

Remaining work:

- completed:
  - reduced Buildish-shaped integration assumptions in the core by making watch
    mode follow the consumer project's dependency metadata instead of assuming
    the implementation package always lives directly under `site/pipeline/`
  - kept the pipeline focused on deterministic staged outputs and generic
    metadata, with the staged tree remaining the single source of truth for
    published component paths

### Phase 2: create the extracted repository

Status: complete.

Completed:

- defined the extracted repository layout under `buildish-site-pipeline/`
- copied the reusable implementation, entrypoint, package metadata, and lockfile
  into that repository
- copied the reusable contract docs into `buildish-site-pipeline/docs/`
- added a self-contained `Makefile`, `README.md`, and generic unit tests so the
  extracted repo can already run `make check`

Follow-up work carried by later phases:

- keep example integration material separate from the core API description
- keep runtime/container assets optional unless they are truly generic

### Phase 3: convert Buildish into consumer #1

- stop executing the in-repo implementation directly
- make `site/pipeline/Makefile` invoke the installed `site-pipeline` CLI
- pin a released version of the extracted pipeline in Buildish
- keep end-to-end tests that validate Buildish as a normal consumer

### Phase 4: broaden adoption and harden the public contract

- publish migration and integration guidance for other adopters
- add reusable examples for common Apache site setups
- stabilize the public contract based on consumer feedback

## Immediate next steps

1. Switch Buildish to consume `buildish-site-pipeline/` through its consumer
   project instead of executing the in-repo implementation directly.

