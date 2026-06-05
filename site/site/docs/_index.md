---
title: Apache Buildish Site Documentation
description: Buildish-specific notes for using Site Pipeline with the Apache Buildish web site.
---

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

Buildish consumes the reusable `site-pipeline` staging package from the sibling
`buildish-site-pipeline` repository and then renders the staged contract with
Hugo + Docsy.

This page keeps only Buildish-specific consumer notes. Canonical generic
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

The main generated paths remain:

- `site/.stage/`
- `site/.preview/`
- `site/.public/`

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
