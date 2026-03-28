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

The site uses Hugo + Docsy for rendering and `mvp.py` for staging generated project content.

## Local native workflow

From `site/`:

- `make test`
- `make integration-test`
- `make build`
- `make serve`
- `make stage-watch`

The native workflow expects:

- `uv`
- Hugo extended
- Node available via `nvm` using `.nvmrc`

`make serve` now keeps `site/.stage/` up to date while Hugo runs, including changes in
project READMEs/docs/assets that live outside `site/`. Use `make stage-watch` if you want
to run only the staging watcher without starting Hugo.

## Current sub-project contract

The currently implemented catalog and sub-project metadata contract is documented in
[`../docs/site-subproject-contract.md`](../docs/site-subproject-contract.md).

That document describes:

- `site/projects.yaml` defaults and per-project overrides
- the preferred `site/project.yaml` structure
- precedence rules between catalog values and sub-project metadata
- current staging outputs and safety constraints

## Containerized workflow

The repository includes a pinned build container so developers can build the site without installing the full local toolchain.

The reusable builder-image definition lives in `../tools/site-build-image/`, while `site/Makefile` remains the main entrypoint for local site workflows.

From `site/`:

- `make container-image`
- `make container-check-fast`
- `make container-test`
- `make container-integration-test`
- `make container-build`

Defaults:

- `CONTAINER_ENGINE=podman`
- `CONTAINER_IMAGE=localhost/buildish-site-build:local`
- `CONTAINER_PLATFORM=<derived from the local host architecture>`

You can override the engine if needed, for example:

- `make CONTAINER_ENGINE=docker container-build`

The containerized flow:

- bind-mounts the repository into `/workspace`
- writes generated outputs back into the working tree
- keeps tool caches under `site/.container-home/`
- installs Node dependencies with `npm ci --ignore-scripts`

The builder `Containerfile` pins multi-architecture index digests. The
`site/Makefile` then passes an explicit `--platform` value derived from the host
architecture so Podman/Docker select the intended child manifest instead of
guessing from local cache state.

This split also makes it straightforward for future CI to rebuild or publish the builder image only when the builder-image inputs change.

The current site verification workflow also uses this containerized path so CI exercises
the same staged-site and Hugo build flow with pinned tooling.

## Produced outputs

Builds write to:

- `site/.stage/`
- `site/.preview/`
- `site/.public/`

These outputs are ignored by Git.