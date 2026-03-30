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

# Current site component contract

This document describes the implemented input contract for the site pipeline.
For the broader long-term design, see [`site-infra.md`](site-infra.md).

## Workspace model

- the main repository is expected at `./buildish`
- participating components are normally sibling checkouts such as `./buildish-mammoth-cache-gradle`
- missing component repositories are allowed during local builds and CI; they are skipped cleanly

## Main repository catalog

The main repository owns `site/components.yaml`.

Current supported top-level fields:

- `schemaVersion`
- `defaults`
- `components`

Current supported `defaults` fields:

- `metadataFile`
- `pagesRoot`
- `docsRoot`
- `assetsRoot`
- `unreleasedLabel`
- `tagPattern`
- `navigationSection`

Each `components[]` entry currently supports:

- required: `slug`, `localDir`
- optional: `displayName`, `repository`, `defaultBranch`, `weight`
- optional overrides: `metadataFile`, `pagesRoot`, `docsRoot`, `assetsRoot`
- optional publication/navigation hints: `unreleasedLabel`, `tagPattern`, `navigationSection`

## Component metadata file

When present, the aggregator reads `site/component.yaml` from the component.

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

1. per-component overrides in `site/components.yaml`
2. component metadata in `site/component.yaml`
3. catalog defaults from `site/components.yaml`
4. built-in defaults in the aggregator

In practice, that means the central catalog controls inventory and local discovery,
while the component metadata controls content-local structure.

## Content inputs

For each available component repository, it stages:

- the configured component pages tree, defaulting to `site/pages`
- the configured docs tree, defaulting to `site/docs`
- the configured asset tree, defaulting to `site/assets`

`pagesRoot` is the non-versioned component content tree. It stages directly into
`content/components/<slug>/...`, and `pagesRoot/_index.md` is the authored
component landing page at `/components/<slug>/`.

The component pages tree is mandatory for available component repositories and
must include `_index.md`.

`docsRoot` is the version-specific documentation tree. In the current
implementation, the working-tree copy stages to
`content/components/<slug>/unreleased/docs/...`.

The docs tree should include a site-oriented `_index.md` landing page for that
versioned docs section.

Because `pagesRoot` stages directly into `content/components/<slug>/...`, the
top-level names `unreleased/`, `releases/`, and `lifecycle.yaml` are reserved
for pipeline-owned output.

If the docs tree is missing, unreleased docs staging is skipped for that
component.

The renderer does not inject a mandatory component-home hero, CTA button row, or
release-card shell. Component authors own the landing-page body in
`pagesRoot/_index.md` and can place links to unreleased docs, releases, source,
or any other component-specific content where they want.

### Landing-page shortcodes

The site provides a small set of site-owned Hugo shortcodes for component pages.
They read the pipeline-owned `buildishComponent` front matter and avoid
hard-coding URLs in component-authored Markdown.

- `buildish-component-link`
  - supported `kind` values: `overview`, `component`, `docs`, `unreleased`, `source`
  - optional `label`
  - optional `appearance`: `link`, `primary`, `secondary`, `outline-primary`, `outline-secondary`
  - optional `optional="true"` to suppress output when a target is unavailable
- `buildish-component-releases`
  - renders the current latest-stable and release-line summary from component metadata
  - emits a `release-lines` anchor for landing-page links
  - optional `heading`
  - optional `optional="true"`

Example landing-page usage:

```text
{{< buildish-component-link kind="docs" label="Read unreleased docs" appearance="primary" >}}
{{< buildish-component-link kind="source" appearance="outline-secondary" >}}
{{< buildish-component-releases heading="Current release lines" optional="true" >}}
```

## Lifecycle inputs

Lightweight lifecycle metadata in `site/component.yaml`:

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

Stage outputs are, at minimum:

- `site/.stage/content/components/<slug>/_index.md`
- `site/.stage/content/components/<slug>/...` for any additional authored component pages
- `site/.stage/content/components/<slug>/unreleased/docs/...`
- `site/.stage/content/components/<slug>/unreleased/version.yaml`
- `site/.stage/content/components/<slug>/lifecycle.yaml`
- `site/.stage/data/components.yaml`
- `site/.stage/data/lifecycle.yaml`
- `site/.stage/data/aliases.yaml`
- `site/.stage/static/components/<slug>/unreleased/assets/...` when assets exist

Each staged component Markdown page also receives pipeline-owned front matter under:

- `buildishComponent` for the current component identity, navigation paths, and lifecycle summary
- `buildishComponentPage` for the current staged page kind and active unreleased-version context

## Local commands

From `site/`:

- `make test` validates the Python staging logic
- `make build` stages content and renders the Hugo site
- `make stage-watch` re-stages on source changes
- `make serve` runs the watcher and Hugo together

The CI workflow mirrors the containerized build path so the staged-site contract and
the renderer are both exercised in a reproducible environment.