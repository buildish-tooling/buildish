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

# Site component contract

This document defines the current contract between a consumer site workspace and
the component repositories that participate in staging.

## Workspace model

- the consumer repository owns the catalog, pipeline config, and top-level site
  content,
- component repositories are discovered from the catalog and may live anywhere
  reachable from the workspace root,
- missing component repositories are allowed during local builds and CI and are
  skipped cleanly, and
- pipeline-managed outputs default to `site/.stage` and `site/.preview`.

All configured consumer-workspace paths must remain inside the repo root. The
default `localDir` lookup for catalog components is relative to the workspace
parent, which supports sibling checkouts such as `../component-a` from the site
repository's point of view. Optional `site/components.local.yaml` overrides are
resolved relative to the consumer repo root.

## Consumer-owned catalog

By default, the component catalog lives at `site/components.yaml`.

Supported top-level fields:

- `schemaVersion`
- `defaults`
- `components`

Supported `defaults` fields:

- `metadataFile`
- `pagesRoot`
- `docsRoot`
- `assetsRoot`
- `developmentLabel`
- `tagPattern`
- `navigationSection`

Each `components[]` entry supports:

- required: `slug`, `localDir`
- optional identity fields: `displayName`, `repository`, `defaultBranch`, `weight`
- optional path overrides: `metadataFile`, `pagesRoot`, `docsRoot`, `assetsRoot`
- optional publication hints: `developmentLabel`, `tagPattern`, `navigationSection`

The effective catalog path may be overridden by `workspace.catalogPath` in
`site/site-pipeline.yaml` or by the CLI `--catalog` flag. The authored site
content root, stage root, and preview root can likewise be overridden through
config or CLI flags.

## Optional local checkout overrides

Developers can keep committed catalog metadata stable while binding a component
slug to a different local checkout in `site/components.local.yaml`.

That override file is workspace-local only. It should not redefine published
component identity or site metadata; it only changes where the current checkout
is found.

## Component metadata file

When present, the pipeline reads `site/component.yaml` from the component.

Preferred structure:

- `schemaVersion`
- `component`
  - `slug`
  - `displayName`
  - `repository`
  - `defaultBranch`
- `content`
  - `pagesRoot`
  - `docsRoot`
  - `assetsRoot`
- `versioning`
  - `developmentLabel`
  - `tagPattern`
- `lifecycle`
  - `latestStable`
  - `releaseLines`
- `navigation`
  - `section`

The implementation still accepts a few legacy top-level fallbacks for content
and navigation fields, but new metadata should prefer the nested structure.

## Precedence rules

The pipeline resolves values in this order:

1. per-component overrides in the catalog,
2. component metadata in `site/component.yaml`,
3. catalog defaults, and
4. built-in defaults.

In practice, the consumer catalog controls inventory and checkout discovery,
while component metadata controls content-local structure and lifecycle hints.

## Content inputs

For each available component repository, the pipeline stages:

- the configured component pages tree, defaulting to `site/pages`,
- the configured docs tree, defaulting to `site/docs`, and
- the configured asset tree, defaulting to `site/assets`.

`pagesRoot` is the non-versioned component content tree. It stages directly into
`content/components/<slug>/...`, and `pagesRoot/_index.md` becomes the authored
component landing page.

The component pages tree is mandatory for available repositories and must
include `_index.md`.

`docsRoot` is the versioned documentation tree. The current working-tree copy is
staged as the development docs set beneath
`content/components/<slug>/development/docs/...`.

Because `pagesRoot` stages directly into `content/components/<slug>/...`, the
top-level names `development/`, `releases/`, and `lifecycle.yaml` are reserved
for pipeline-owned output.

If the docs tree is missing, development docs staging is skipped for that
component. If the assets tree is missing, static asset staging is skipped.

The pipeline does not impose a required hero, CTA row, or release-card shell on
component landing pages. Component authors own the landing-page body and can add
consumer-specific links or helpers as needed.

## Lifecycle inputs

Lifecycle metadata in `site/component.yaml` supports:

- `latestStable`: an exact version tag such as `v1.3.5`
- `releaseLines[]`
  - `line`
  - `latest`
  - `status` (`maintained` or `eol`)
  - optional `aliases`

Only exact-version tags matching the configured `tagPattern` are accepted for
`latestStable` and `releaseLines[].latest`.

## Staged outputs

At minimum, the configured `workspace.stagePath` contains:

- `content/components/<slug>/_index.md`
- `content/components/<slug>/...` for additional component pages
- `content/components/<slug>/development/docs/...`
- `content/components/<slug>/development/version.yaml`
- `content/components/<slug>/lifecycle.yaml`
- `data/components.yaml`
- `data/lifecycle.yaml`
- `data/aliases.yaml`
- `static/components/<slug>/development/assets/...` when assets exist
- `manifest.yaml`

Each staged component Markdown page also receives pipeline-owned front matter
under:

- `sitePipelineComponent` for component identity, derived paths, and lifecycle
  summary
- `sitePipelineComponentPage` for page kind and active development-version
  context

Consumer-specific renderer helpers are not part of this contract. A consumer may
choose to expose shortcodes, partials, or templates that read the staged front
matter, but those integration details belong to that consumer's rendering layer.

## Safety constraints

The pipeline enforces these guardrails:

- configured paths must stay within approved workspace roots,
- path traversal outside the allowed workspace is rejected,
- symlinks are not followed when copying docs or assets,
- hidden files and directories are skipped during staged tree copies, and
- authored inputs cannot overlap pipeline-managed outputs or protected workspace
  files.

## Read next

- [Site Pipeline overview](site-pipeline.md)
- [Adoption guide](adoption-guide.md)
- [Workspace examples](examples.md)