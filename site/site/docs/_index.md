---
title: Website Development Documentation
description: Unreleased contributor documentation for rendering and maintaining the Buildish website.
---

<!--
Copyright 2026 The Buildish Authors

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

The Website component consumes the reusable `site-pipeline` staging package from the sibling
`buildish-site-pipeline` repository and then renders the staged contract with
Hugo + Docsy.

This unreleased development documentation keeps only Buildish-specific consumer notes. Canonical generic
pipeline documentation lives under the dedicated `site-pipeline` component.

## Buildish-owned concerns

Buildish owns the parts that are specific to this consumer site:

- Hugo + Docsy as the renderer and theme stack
- `site/Makefile` as the main developer entrypoint
- the Buildish-derived builder image layered on top of the generic
  `site-pipeline` base image
- renderer-specific navigation, shortcodes, styling, and publication behavior
- final search, indexing, and publishing policy for the public Buildish site

## Authoring helpers

Buildish-specific Hugo shortcodes and partials are documented separately:

- [Hugo helpers](hugo-helpers/)

## Common workflows

From `site/`:

- `make serve` / `make serve-local` — live restaging plus Hugo preview
- `make build` / `make build-local` — fresh staged and rendered site output
- `make render` / `make render-local` — rerun Hugo against the current stage root
- `make stage` / `make stage-local` — refresh only `site/.stage/` and `site/.preview/`
- `make check` — run clean, tests, and `build-local`

Host-tool workflows expect `uv`, Hugo extended, and Node via `nvm` using
`.nvmrc`.

## Containerized Buildish workflow

Buildish keeps a pinned consumer-specific build image so contributors can work
without installing the full local toolchain.

- the generic `site-pipeline` base image lives in the sibling repository
- Buildish layers its own renderer tooling on top in `../tools/site-build-image/`
- `site/Makefile` remains the main entrypoint for both containerized and native
  workflows

Both workflows select Node from `site/.nvmrc`. The image build script passes
that version to the Containerfile, which verifies the Node archive against the
matching upstream checksum manifest. Containerized Make targets rebuild a local
builder image when its Node version differs from `.nvmrc`.

The main generated paths remain:

- `site/.stage/`
- `site/.preview/`
- `site/.public/`

## Released component documentation

Release Tooling publishes released docs from its independent `versioned-docs`
branch. The shared CI build checks that branch out at
`buildish-release-tooling/docs/releases/`, so its provider inventory and version
folders come from the same commit. Site Pipeline consumes these local inputs;
it does not fetch branches or generate documentation.

The aggregate catalog binds each component-owned `provider-snapshot.json` with
`requirement: publication`. Artifact definitions and repository-relative content
roots belong to the component metadata. Release records, release lines and their
latest versions belong to that component's provider snapshot. Adding a release
must not require copying its version or latest designation into this catalog.
Optional catalog artifact entries may still bind sources and publication policy.
The released components use `publicationSelection.releases.mode: allKnown`, so
publishing a newer patch retains older released docs URLs. Explicit hidden and
removed release policies still apply.
Hidden or withdrawn historical records remain inventory rather than being deleted
and rediscovered by imports.

Component metadata, inventory and exported docs must agree with the Site Pipeline
contract. An invalid present snapshot fails in both profiles; the local profile
only permits absence. Validate component exporter upgrades and inventory migrations
together before using them in a publication build.

Normal developer targets use `SITE_PIPELINE_PROFILE=local`. Developers may
preview static and development docs without the released-docs checkout; links
to unavailable released docs are omitted. To preview the released docs, use the
checkout helper in the Release Tooling source repository before building here.

Publication uses an explicit profile in both native and container build paths:

```sh
make SITE_PIPELINE_PROFILE=publication site-check-local build-local
make SITE_PIPELINE_PROFILE=publication site-check build
```

Run these commands from `site/`. Missing required snapshots or selected released
docs block publication. A present malformed snapshot is an error in either
profile. The profile is not inferred from `CI`, environment names, or branch
names. Existing container images without profile support are rebuilt by the
normal image compatibility probe.

## Canonical Site Pipeline docs

For pipeline behavior, workspace semantics, and the reusable component contract,
use the `site-pipeline` docs:

- [Site Pipeline docs index](/components/site-pipeline/development/)
- [Site Pipeline overview](/components/site-pipeline/)
- [Staged output contract](/components/site-pipeline/development/reference/staged-output-contract/)
- [API contract](/components/site-pipeline/development/reference/api-contract/)
- [Flexible component publication](/components/site-pipeline/development/reference/flexible-component-publication/)
- [Validation and check](/components/site-pipeline/development/reference/validation-and-check/)
- [Hugo integration guide](/components/site-pipeline/how-to/integrate-with-hugo/)

## Buildish-specific notes

The interactive workflow intentionally keeps Hugo focused on staged sources.
`make serve` and `make serve-local` keep `site/.stage/` current while Hugo runs
without regenerating every derived output on each change.

The current development-only limitations are consumer-facing rather than
pipeline-contract issues. For example, route removals can linger briefly in an
already-running Hugo session until the server is restarted.
