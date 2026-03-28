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

# MVP: local POC for the Buildish site infrastructure

## Status

This document describes a small MVP for implementing and experimenting with a
local proof of concept for the site infrastructure proposed in
[`site-infra.md`](site-infra.md).

The goal is to learn quickly with the smallest useful implementation, not to
ship the full production design in one step.

## MVP goals

- Prove the aggregator + renderer split works in practice.
- Build and serve a local site from the main repository plus locally available
  sub-project repositories.
- Validate the proposed `site/projects.yaml` catalog shape.
- Validate the proposed staged tree under `.site-stage/`.
- Validate the `unreleased` + exact-release version model.
- Keep the implementation small enough to iterate on quickly.

## Explicit non-goals for the MVP

- Production publication to `buildish.apache.org`.
- Cross-repository trigger/authentication design.
- Full release automation.
- Full search, sitemap, and redirect behavior.
- Full AsciiDoc feature support.
- Perfect theme or navigation design.

## Recommended MVP scope

The MVP should intentionally stay narrow:

- one main repository site shell,
- one or two sub-project repositories discovered from the local workspace,
- `unreleased` docs for those projects,
- optionally one exact release snapshot for one project,
- Hugo + Docsy as the renderer,
- local build and local serve only.

If needed, the first MVP iteration may support Markdown-only input even though
our long-term contract allows both Markdown and AsciiDoc.

## Minimal inputs

The MVP should assume only these inputs exist:

- `site/projects.yaml` in the main repository,
- `site/project.yaml` in each participating sub-project,
- `site/docs/` in each participating sub-project,
- optional `site/assets/` in each participating sub-project,
- optional locally available release snapshot content.

## Minimal output contract

The MVP should generate a staged tree roughly like:

- `.site-stage/content/projects/<slug>/unreleased/...`
- `.site-stage/content/projects/<slug>/releases/<exact-version>/...`
- `.site-stage/content/projects/<slug>/lifecycle.yaml`
- `.site-stage/data/projects.yaml`
- `.site-stage/data/lifecycle.yaml`

This is enough to validate the aggregator contract without solving every
production concern.

## Recommended first implementation steps

1. Add a minimal `site/projects.yaml` with one or two example projects.
2. Add a tiny discovery mechanism for sibling checkout directories.
3. Read each participating project's `site/project.yaml` with defaults applied.
4. Copy or stage `site/docs/` content into `.site-stage/` under the canonical
   project/version paths.
5. Generate minimal `version.yaml` and `lifecycle.yaml` files.
6. Render the staged tree with Hugo + Docsy.
7. Add a `bin/site` wrapper with commands such as `build` and `serve`.

## Suggested simplifications

To keep the MVP fast and low-risk, it is reasonable to defer or simplify:

- use scheduled/publication concerns later; focus on local builds first,
- skip alias-tag redirects,
- skip search indexing of versioned content,
- skip advanced lifecycle badges,
- skip release-line policy beyond a minimal static example,
- skip AsciiDoc includes unless there is a concrete need to validate them.

## Validation checkpoints

The MVP should be considered successful if it can:

- discover at least one local sub-project repository,
- build a staged tree with `unreleased` content,
- optionally include one exact release snapshot,
- render a working local site,
- show a project landing page with links to `unreleased` and release docs,
- run repeatedly without depending on ad hoc manual edits.

## Security baseline for the MVP

Even the MVP should keep the core guardrails from the proposal:

- no arbitrary code execution from sub-project content,
- no `iframe` embeds,
- no embedded remote content,
- no arbitrary embedded JavaScript,
- no remote fetching during normal local builds,
- no path traversal or symlink escapes outside approved content roots.

## Likely follow-up after the MVP

If the MVP works well, the next step should be to harden it by adding:

- better lifecycle metadata generation,
- stricter content validation,
- AsciiDoc support validation,
- containerized pinned tooling,
- CI builds,
- later, a discussion about publication automation.

