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

# Current site sub-project contract

This document describes the **currently implemented** input contract for the site MVP.
For the broader long-term design, see [`site-infra.md`](site-infra.md).

## Workspace model

- the main repository is expected at `./buildish`
- participating sub-projects are normally sibling checkouts such as `./buildish-mammoth-cache-gradle`
- missing sub-project repositories are allowed during local builds and CI; they are skipped cleanly

## Main repository catalog

The main repository owns `site/projects.yaml`.

Current supported top-level fields:

- `schemaVersion`
- `defaults`
- `projects`

Current supported `defaults` fields:

- `metadataFile`
- `docsRoot`
- `assetsRoot`
- `unreleasedLabel`
- `tagPattern`
- `navigationSection`

Each `projects[]` entry currently supports:

- required: `slug`, `localDir`
- optional: `displayName`, `repository`, `defaultBranch`, `weight`
- optional overrides: `metadataFile`, `docsRoot`, `assetsRoot`
- optional publication/navigation hints: `unreleasedLabel`, `tagPattern`, `navigationSection`

## Sub-project metadata file

When present, the aggregator reads `site/project.yaml` from the sub-project.

Preferred structure:

- `schemaVersion`
- `project`
  - `slug`
  - `displayName`
  - `repository`
  - `defaultBranch`
- `content`
  - `docsRoot`
  - `assetsRoot`
- `versioning`
  - `unreleasedLabel`
  - `tagPattern`
- `lifecycle`
  - `latestStable`
  - `releaseLines`
- `navigation`
  - `section`

The current implementation also accepts a few legacy/top-level fallbacks for content
and navigation fields, but new metadata should prefer the nested structure above.

## Precedence rules

The current implementation resolves values in this order:

1. per-project overrides in `site/projects.yaml`
2. sub-project metadata in `site/project.yaml`
3. catalog defaults from `site/projects.yaml`
4. built-in defaults in the aggregator

In practice, that means the central catalog controls inventory and local discovery,
while the sub-project metadata controls content-local structure.

## Content inputs

For each available sub-project repository, the current MVP stages:

- the configured docs tree, defaulting to `site/docs`
- the configured asset tree, defaulting to `site/assets`

The docs tree should include a site-oriented `_index.md` landing page.

If the docs tree is missing, unreleased docs staging is skipped for that
project.

## Lifecycle inputs

The current MVP supports lightweight lifecycle metadata in `site/project.yaml`:

- `latestStable`: exact version tag such as `v1.3.5`
- `releaseLines[]`
  - `line`
  - `latest`
  - `status` (`maintained` or `eol`)
  - optional `aliases`

Only exact-version tags matching the configured `tagPattern` are accepted for
`latestStable` and `releaseLines[].latest`.

## Safety constraints

The current aggregator enforces these guardrails:

- configured paths must stay within the approved repository root
- path traversal outside the allowed repo tree is rejected
- symlinks are not followed when copying docs or assets
- hidden files and directories are skipped during staged tree copies

## Staged outputs

The current MVP generates, at minimum:

- `site/.stage/content/projects/<slug>/_index.md`
- `site/.stage/content/projects/<slug>/unreleased/docs/...`
- `site/.stage/content/projects/<slug>/unreleased/version.yaml`
- `site/.stage/content/projects/<slug>/lifecycle.yaml`
- `site/.stage/data/projects.yaml`
- `site/.stage/data/lifecycle.yaml`
- `site/.stage/data/aliases.yaml`
- `site/.stage/static/projects/<slug>/unreleased/assets/...` when assets exist

## Local commands

From `site/`:

- `make test` validates the Python staging logic
- `make build` stages content and renders the Hugo site
- `make stage-watch` re-stages on source changes
- `make serve` runs the watcher and Hugo together

The CI workflow mirrors the containerized build path so the staged-site contract and
the renderer are both exercised in a reproducible environment.