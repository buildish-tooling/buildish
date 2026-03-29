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

# Apache Buildish site development

The site uses Hugo + Docsy for rendering, with the Python staging pipeline implemented under
`site/pipeline/site_pipeline/` and a small CLI entrypoint in `site/pipeline/main.py`.

## Local native workflow

From `site/`:

- `make test`
- `make integration-test`
- `make stage-local`
- `make stage-watch-local`
- `make build`
- `make serve-local`

The native workflow expects:

- `uv`
- Hugo extended
- Node available via `nvm` using `.nvmrc`

The Node.js files in `site/` support the Hugo + Docsy render path, while the Python staging package, Python tests, and
`uv` project files now live under `site/pipeline/`.

`make stage-local` runs the staging pipeline directly on the host. `make serve-local` keeps
`site/.stage/` up to date while Hugo runs, including changes in project READMEs/docs/assets
that live outside `site/`. Use `make stage-watch-local` if you want to run only the native
staging watcher without starting Hugo.

Known local-dev behavior:

- changes to `site/projects.yaml` can take a short while to appear in the running Hugo server
- newly added projects usually show up correctly after the watcher restages content
- removed project routes can linger briefly in an already-running `make serve` session even after they disappear from
  the staged catalog

Treat that last case as an accepted development-only inconvenience. A fresh `make build` or a restarted
`make serve-local` reflects the current catalog cleanly.

## Current subproject contract

The currently implemented catalog and subproject metadata contract is documented in
[`../docs/site-subproject-contract.md`](site/docs/site-subproject-contract.md).

That document describes:

- `site/projects.yaml` defaults and per-project overrides
- the preferred `site/project.yaml` structure
- precedence rules between catalog values and subproject metadata
- current staging outputs and safety constraints

## Containerized workflow

The repository includes a pinned build container, so developers can build the site without installing the full local
toolchain.

The reusable builder-image definition lives in `../tools/site-build-image/`, while `site/Makefile` remains the main
entrypoint for local site workflows.

From `site/`:

- `make stage`
- `make stage-watch`
- `make serve`
- `make container-image`
- `make container-check-fast`
- `make container-test`
- `make container-integration-test`
- `make container-build`

Defaults:

- `CONTAINER_ENGINE=<auto-detected: podman, then docker>`
- `CONTAINER_IMAGE=localhost/buildish-site-build:local`
- `CONTAINER_PLATFORM=<derived from the local host architecture>`

You can override the engine if needed, for example:

- `make CONTAINER_ENGINE=podman stage`
- `make CONTAINER_ENGINE=docker serve`
- `make CONTAINER_ENGINE=docker container-build`

`make stage`, `make stage-watch`, and `make serve` are now the default containerized entrypoints.
They reuse the local builder image when available and build it on demand when missing. The
previous host-native entrypoints remain available as `make stage-local`,
`make stage-watch-local`, and `make serve-local`.

The containerized flow:

- bind-mounts the parent workspace into `/workspace`, with this repository available at `/workspace/<repo-name>/`
- uses that mount in read/write mode, not read-only, because the container writes generated outputs and caches back into
  this repository
- can only stage/serve subprojects whose `localDir` resolves within that parent workspace; in practice that means
  sibling repositories next to the main repo (for example `../buildish-mammoth-cache-gradle`)
- if your subproject repositories live somewhere else, prefer the native `make stage-local`, `make stage-watch-local`,
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

The current site verification workflow also uses this containerized path, so CI exercises
the same staged-site and Hugo build flow with pinned tooling.

## Produced outputs

Builds write to:

- `site/.stage/`
- `site/.preview/`
- `site/.public/`

Git ignores these outputs.