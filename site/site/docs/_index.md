---
title: Apache Buildish Site Documentation
description: This section documents the Apache Buildish website itself, the current component metadata contract, the current implementation, and the broader long-term site infrastructure proposal.
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

The site uses Hugo + Docsy for rendering, with the Python staging pipeline implemented under
`site/pipeline/apache_buildish_site_pipeline/` and exposed through the installable
`site-pipeline` CLI.

## Common workflows

From `site/`:

- `make serve` — preview the site with live restaging in the build container
- `make build` — stage and render a fresh static site in the build container

## Checks and cleanup

From `site/`:

- `make test` — run unit tests
- `make integration-test` — run integration tests
- `make check` — run clean, tests, and `build-local`
- `make clean` — remove generated site output

## Host-tool workflows

From `site/`:

- `make serve-local` — preview the site with live restaging using host tools
- `make build-local` — stage and render a fresh static site using host tools

Host-tool workflows expect:

- `uv`
- Hugo extended
- Node available via `nvm` using `.nvmrc`

The Node.js files in `site/` support the Hugo + Docsy render path, while the Python staging package, Python tests, and
`uv` project files now live under `site/pipeline/`.

`make serve` and `make serve-local` both keep `site/.stage/` up to date while Hugo runs,
including changes in component docs and assets that live outside `site/`.

If you want to inspect a static build without running Hugo in watch mode, first run
`make build` (containerized default) or `make build-local` (native), then serve `site/.public/`
over a tiny local HTTP server. From `site/`:

- `python3 -m http.server --directory .public 8080`
- `docker run --rm --init -p 127.0.0.1:8080:8080 -v "$PWD/.public:/www:ro" docker.io/library/busybox:1.36.1 httpd -f -p 8080 -h /www`
- open `http://127.0.0.1:8080/`

If you prefer Podman, replace `docker` with `podman` in the same command.

The watch loop intentionally watches only staged-source inputs and rebuilds only
`site/.stage/`. It does **not** regenerate `site/.preview/` on every change. That keeps the
live Hugo workflow focused on the staged contract and reduces external file churn seen by IDEs.
The full implementation is documented in [`site/site/docs/site-pipeline.md`](site/docs/site-pipeline.md).

## Less common workflows

These are useful when you want direct control over staging versus rendering:

- `make render` — rerun Hugo in the build container using the current `site/.stage/`
- `make render-local` — rerun Hugo with host tools using the current `site/.stage/`
- `make stage-local` — refresh `site/.stage/` and `site/.preview/` without running Hugo
- `make stage-watch-local` — watch sources and refresh `site/.stage/` without running Hugo

Containerized staging-only variants also exist as `make stage` and `make stage-watch`, but most
developers will usually want `make serve` or `make build` instead.

Known local-dev behavior:

- changes to `site/components.yaml` can take a short while to appear in the running Hugo server
- newly added components usually show up correctly after the watcher restages content
- removed component routes can linger briefly in an already-running `make serve` session even after they disappear from
  the staged catalog

Treat that last case as an accepted development-only inconvenience. A fresh `make build` or a restarted
`make serve` reflects the current catalog cleanly.

## Component contract

The implemented catalog and component metadata contract is documented in
[`../docs/site-component-contract.md`](site/docs/site-component-contract.md).

That document describes:

- `site/components.yaml` defaults and per-component overrides
- the preferred `site/component.yaml` structure
- precedence rules between catalog values and component metadata
- staging outputs and safety constraints

## Containerized workflow

The repository includes a pinned build container, so developers can build the site without installing the full local
toolchain.

The reusable builder-image definition lives in `../tools/site-build-image/`, while `site/Makefile` remains the main
entrypoint for local site workflows.

From `site/`:

- `make serve`
- `make build`
- `make render`
- `make stage`
- `make stage-watch`
- `make container-image`
- `make container-check-fast`
- `make container-test`
- `make container-integration-test`

Defaults:

- `CONTAINER_ENGINE=<auto-detected: podman, then docker>`
- `CONTAINER_IMAGE=localhost/buildish-site-build:local`
- `CONTAINER_PLATFORM=<derived from the local host architecture>`

You can override the engine if needed, for example:

- `make CONTAINER_ENGINE=podman stage`
- `make CONTAINER_ENGINE=docker serve`
- `make CONTAINER_ENGINE=docker build`

`make serve`, `make build`, and `make render` are the main containerized entrypoints.
They reuse the local builder image when available and build it on demand when missing. The
host-native entrypoints remain available as `make serve-local`, `make build-local`,
`make render-local`, `make stage-local`, and `make stage-watch-local`.

The containerized flow:

- bind-mounts the parent workspace into `/workspace`, with this repository available at `/workspace/<repo-name>/`
- uses that mount in read/write mode, not read-only, because the container writes generated outputs and caches back into
  this repository
- can only stage/serve components whose `localDir` resolves within that parent workspace; in practice that means
  sibling repositories next to the main repo (for example `../buildish-mammoth-cache`)
- if your component repositories live somewhere else, prefer the native `make stage-local`, `make stage-watch-local`,
  or `make serve-local` workflow instead
- writes generated outputs back into the working tree
- keeps tool caches under `site/.container-home/`
- installs Node dependencies with `npm ci --ignore-scripts`

The builder `Containerfile` pins multi-architecture index digests. The
`site/Makefile` then passes an explicit `--platform` value derived from the host
architecture so Podman/Docker select the intended child manifest instead of
guessing from local cache state.

This split also makes it straightforward for future CI to rebuild or publish the builder image only when the
builder-image inputs change.

The site verification workflow also uses this containerized path, so CI exercises
the same staged-site and Hugo build flow with pinned tooling.

## Produced outputs

Builds write to:

- `site/.stage/`
- `site/.preview/`
- `site/.public/`

Git ignores these outputs.
