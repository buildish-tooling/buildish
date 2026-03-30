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

# Proposal: Apache Buildish web site infrastructure

## Status

This document captures the current proposal for the Apache Buildish web site
infrastructure. It is intentionally written as a proposal, not yet as a final
implementation specification.

Unless a section explicitly says otherwise, the content in this document should
be read as the proposed **baseline implementation**. Ideas intentionally
deferred beyond that baseline are collected in the [Follow-ups](#follow-ups)
section.

For the implementation and local development behavior, see
[`site-pipeline.md`](site-pipeline.md).

The current implementation is intentionally unreleased-only in practice; release
snapshot staging should wait until real tagged releases exist.

> [!NOTE]
> The current implementation already provides the local aggregation/rendering split,
> central catalog plus component metadata contract, unreleased staging, local
> Hugo rendering, and containerized verification. The main gaps between the implementation
> and this full proposal are released-docs handling from exact tags,
> publication automation, redirect/search/indexing policy, and stricter content
> and schema hardening.

## Goals

- Publish one web site for the Apache Buildish project.
- Keep component specific documentation in the respective component Git
  repositories.
- Publish docs for both:
  - the current state of each component's default branch, and
  - released versions of each component.
- Allow every developer to build and serve the site locally with whatever
  content is available in the local workspace.
- Keep the architecture mostly immune to Hugo and/or Docsy implementation
  changes by defining a renderer-neutral aggregation contract.
- Make local builds and CI builds reproducible via pinned tool versions and a
  container-based toolchain.

## Non-goals

- Allowing components to inject custom renderer logic, theme fragments,
  shortcodes, or custom build steps.
- Making alias tags such as `v1` or `v1.1` first-class published versions.
- Requiring every developer to clone every component repository.
- Optimizing for bit-for-bit identical historical HTML rendering across all
  future renderer upgrades.

## Proposed architecture

The site infrastructure should be split into two layers:

1. **Aggregation layer (owned by Buildish)**
   - discovers locally available component repositories,
   - reads component site metadata,
   - collects current and release-specific content,
   - resolves version relationships and alias tags,
   - generates a normalized staging tree for the renderer.
2. **Rendering layer (initially Hugo + Docsy)**
   - renders the normalized staging tree into the final static web site.

This separation keeps the long-term contract independent from Hugo/Docsy and
reduces the impact of renderer upgrades.

## Renderer choice

The initial renderer should be **Hugo with Docsy**.

Reasons:

- good fit for a project web site with guides, reference docs, and blog posts,
- strong Markdown support,
- workable AsciiDoc support,
- fast local iteration,
- easy to package into a pinned container image.

However, Hugo/Docsy should be treated as an implementation detail of the
rendering layer. The primary contract remains the normalized staged site tree.

## Decision rationale

### Why Hugo + Docsy

Hugo + Docsy is the preferred initial renderer because it provides a good fit
for a project web site that combines:

- guides,
- reference docs,
- release information,
- blogs/news,
- project-wide pages.

It also supports fast local iteration and works well with a containerized,
pinned toolchain.

### Why not make Hugo/Docsy the contract

The long-term contract should not depend on Hugo concepts such as layouts,
shortcodes, content bundles, or theme internals. Instead, Buildish should own a
renderer-neutral aggregation contract that can later be rendered by another tool
if needed.

### Why not use alias tags as versions

Alias tags are moving references and therefore not stable identifiers. They are
useful as convenience information for users, but they are unsuitable as the
canonical identity of published release docs.

### Why not let components customize rendering

Allowing each component to inject custom rendering behavior would create:

- upgrade fragility,
- inconsistent look and feel,
- higher security risk,
- harder local and CI reproducibility.

The proposal therefore keeps component inputs limited to content, metadata,
and static assets.

## Content ownership model

### Main repository

The main repository owns:

- the top-level site structure,
- community/governance/incubator-specific pages,
- blogs/news,
- shared styling and navigation,
- the aggregation tooling,
- the renderer integration,
- the containerized build tooling,
- the central catalog of known components.

### Component repositories

Each component repository should contain a `site/` directory with only:

- Markdown and/or AsciiDoc content,
- front matter / page metadata,
- static assets,
- component-local metadata required by the aggregation layer.

Component repositories must **not** contribute:

- custom Hugo layouts,
- custom Docsy fragments,
- custom shortcodes,
- custom renderer plugins,
- custom build scripts.

## Sub-project contract

Each component should expose a small, stable contract, for example:

- `site/`
- `site/component.yaml` (or similar metadata file)
- `site/docs/` for documentation content

The metadata should be kept intentionally small and may later include fields
such as:

- project slug,
- display name,
- repository URL,
- default branch,
- documentation root path,
- lifecycle state,
- version policy metadata.

### Draft metadata schema

The exact schema can still evolve, but a good starting point is a small,
renderer-neutral file such as `site/component.yaml`.

The schema should be **default-heavy**. Most components should be able to use
the common conventions without repeating them in every repository.

Example draft:

```yaml
schemaVersion: 1
component:
  slug: mammoth-cache-gradle
  displayName: Mammoth Cache Gradle
  repository: https://github.com/apache/buildish-mammoth-cache-gradle
  defaultBranch: main
content:
  docsRoot: docs
  assetsRoot: assets
versioning:
  unreleasedLabel: Unreleased
  tagPattern: ^v[0-9]+\.[0-9]+\.[0-9]+$
  aliasTagPatterns:
    - ^v[0-9]+$
    - ^v[0-9]+\.[0-9]+$
navigation:
  section: components
```

Notes:

- most fields should be optional when a safe default or a central-catalog value
  exists,
- `schemaVersion` allows careful evolution of the contract.
- `slug` is the stable identifier used in URLs and staged content paths.
- `defaultBranch` is source metadata only; the public site should still present
  this content as `unreleased`.
- `docsRoot` is relative to the repository's `site/` directory.
- release line lifecycle state such as maintained vs EOL should likely be
  tracked outside this file, because it changes over time and is not purely a
  property of the docs source tree.

### Suggested defaults

Unless explicitly overridden, the aggregation layer should assume defaults such
as:

- metadata file: `site/component.yaml`
- docs root: `site/docs`
- assets root: `site/assets`
- public unreleased label: `Unreleased`
- exact release tag pattern: `vX.Y.Z`
- alias tag patterns: `vX` and `vX.Y`
- navigation section: `components`

Repository URL and default branch should usually be discoverable from Git or the
central catalog and should not need to be repeated unless there is a reason.

### Minimal metadata example

With defaults in place, many components should only need something like:

```yaml
schemaVersion: 1
component:
  slug: mammoth-cache-gradle
  displayName: Mammoth Cache Gradle
```

### Proposed supported content profile

To keep the contract portable across renderer upgrades, component content
should stay within a documented supported subset.

### Goals of the supported subset

The supported subset should optimize for:

- portability across renderer upgrades,
- safe aggregation from multiple repositories,
- predictable local and CI builds,
- consistent authoring conventions across components.

### Guaranteed portable features

The following features should be part of the guaranteed portable subset for both
Markdown and AsciiDoc content:

- page titles and section headings,
- paragraphs and line-wrapped prose,
- ordered and unordered lists,
- links to pages and anchors,
- code blocks,
- inline code,
- emphasis such as bold and italic,
- block quotes,
- simple tables,
- images and other static assets within approved content roots,
- front matter / page metadata in the renderer-approved format.

If authors stay within this subset, the content should remain portable even if
the rendering layer changes in the future.

### Markdown expectations

For Markdown content, the supported subset should assume conventional static-docs
features only.

Allowed:

- headings,
- lists,
- links,
- fenced code blocks,
- block quotes,
- simple tables,
- images,
- YAML front matter.

Not part of the guaranteed subset:

- renderer-specific shortcodes,
- renderer-specific Markdown extensions,
- embedded script content,
- implicit include mechanisms,
- raw HTML relied on for essential page structure.

### AsciiDoc expectations

For AsciiDoc content, the supported subset should likewise remain conservative.

Allowed:

- headings,
- lists,
- links,
- source/code blocks,
- block quotes,
- simple tables,
- images,
- document attributes and page metadata limited to documented, renderer-approved
  usage.

Limited support:

- local `include::` usage may be supported only when it stays within the same
  component's approved content roots and does not depend on remote fetching or
  path traversal.

Not part of the guaranteed subset:

- remote includes,
- includes outside approved content roots,
- custom AsciiDoctor extensions,
- renderer-specific macros beyond the centrally documented subset,
- raw HTML relied on for essential page structure.

### Linking rules

To keep versioned content stable and reusable:

- links within a component's docs should prefer relative links,
- links should not hardcode the repository's default branch name,
- links should not hardcode alias-tag URLs as canonical references,
- links to released docs should prefer canonical exact-version URLs when an
  explicit version is intended,
- links to other site sections may use stable root-relative site paths.

Cross-component links are allowed, but authors should understand that locally
missing components may be absent from a partial workspace build.

### Asset rules

Static assets are allowed only when they remain inside the approved content or
asset roots for the component.

At minimum:

- no asset path traversal,
- no symlink-based escape outside approved roots,
- no build-time remote asset fetching,
- no reliance on executable client-side assets for core documentation content.

### Metadata rules

Page metadata should be intentionally small and portable.

The documented subset should prefer:

- YAML front matter for page-level metadata,
- centrally documented fields such as title, description, weight, and other
  renderer-owned navigation metadata,
- component-wide metadata in `site/component.yaml` rather than repeated per page.

Components should avoid depending on undocumented theme-specific metadata
fields.

### Admonitions and rich formatting

Admonitions, tabs, diagrams, and other richer documentation constructs are often
useful, but they should not enter the guaranteed subset unless Buildish defines
a centrally documented, renderer-owned contract for them.

Until such a contract exists, they should be treated as:

- unsupported in the guaranteed portable subset, or
- allowed only through centrally approved conventions owned by the main site.

### Explicitly prohibited or unsupported features

The following should be treated as prohibited or unsupported unless the main
site explicitly standardizes a tightly controlled exception:

- custom shortcodes,
- custom renderer plugins,
- arbitrary embedded JavaScript,
- `iframe`-based embeds,
- embedded remote content of any kind,
- remote data fetching at build time,
- undocumented front matter fields with renderer-specific behavior,
- content that depends on a component-specific theme customization.

In particular:

- `iframe`-based content is a no-go,
- embedded remote content is a no-go because of privacy, compliance, and long-
  term reliability concerns,
- embedded JavaScript is a no-go for component content because it increases
  security risk and maintenance burden.

### Validation expectation

The aggregation layer should eventually validate content against this supported
subset and produce actionable warnings or failures for inputs that are outside
the approved contract.

## Version model

### Unreleased docs

The current state of a component's default branch should be published as
**`unreleased`**.

The site should clearly mark unreleased documentation as unstable, for example:

- this content is work in progress,
- it may change at any time without prior notice,
- it is built from the component's default branch,
- it should include provenance such as branch name and commit SHA where useful.

### Released docs

Released documentation should be derived from **exact version tags** only, such
as `v1.2.3`.

Exact version tags are the canonical identifiers for published release docs.

### Alias tags

Moving tags such as `v1` or `v1.1` must never be treated as canonical versions.
They should instead be displayed as informational aliases, for example:

- `v1 currently refers to v1.3.5`
- `v1.1 currently refers to v1.1.9`

Alias tags may be used to generate convenience links or informational release
metadata, but not as the primary stored version identity.

### Lifecycle state

The site should distinguish between at least:

- unreleased,
- latest stable,
- actively maintained release lines,
- end-of-life (EOL) release lines.

### Recommended lifecycle metadata model

Lifecycle should be modeled at the **release-line** level, not only at the
individual version level.

The central idea is:

- exact versions such as `v1.3.5` are immutable releases,
- release lines such as `v1` or `v1.3` describe maintenance policy,
- alias tags may point to the latest exact version within a release line,
- the site should present maintenance state based on release-line metadata.

At minimum, each component should be able to describe:

- `latestStable`: the current latest stable exact version,
- `releaseLines`: the known major/minor lines,
- per line:
  - a stable line identifier such as `v1` or `v1.3`,
  - a status such as `maintained` or `eol`,
  - the latest exact version in that line,
  - optional alias tags associated with that line.

### Draft lifecycle example

```yaml
lifecycle:
  latestStable: v1.3.5
  releaseLines:
    - line: v1
      latest: v1.3.5
      status: maintained
      aliases:
        - v1
    - line: v1.2
      latest: v1.2.9
      status: eol
      aliases:
        - v1.2
```

### Lifecycle interpretation rules

- `latestStable` should always be an exact version.
- `releaseLines[*].latest` should always be an exact version.
- `status` should be constrained to a small controlled vocabulary, initially at
  least `maintained` and `eol`.
- alias mappings should be informational and should never replace exact version
  identifiers in stored release metadata.
- a released version inherits its maintenance status from its release line.
- `unreleased` is not part of any release line and should always be presented as
  work in progress.

### Why line-level lifecycle metadata matters

This model allows the site to answer user-facing questions clearly, for example:

- which version should I start with,
- which versions still receive fixes,
- which older version line is still supported,
- whether `v1` currently maps to `v1.3.5` and whether that line is maintained.

## URL scheme

### Goals for the URL scheme

The public URL scheme should be:

- stable,
- human-readable,
- component-first,
- based on canonical exact versions,
- independent from the component's actual branch naming.

### Canonical paths

The proposal is to use canonical public URLs of the form:

- `/components/`
- `/components/<component-slug>/`
- `/components/<component-slug>/unreleased/`
- `/components/<component-slug>/unreleased/<page-path>/`
- `/components/<component-slug>/releases/<exact-version>/`
- `/components/<component-slug>/releases/<exact-version>/<page-path>/`

Examples:

- `/components/mammoth-cache-gradle/`
- `/components/mammoth-cache-gradle/unreleased/`
- `/components/mammoth-cache-gradle/releases/v1.3.5/`

### URL behavior by version type

- `unreleased` is always the public path for content built from the default
  branch, even if the branch is named `main`, `master`, or something else.
- exact versions such as `v1.3.5` are the canonical published release URLs.
- alias tags such as `v1` or `v1.1` should not be canonical content paths.

### Convenience redirects

Convenience redirects may be added later, but they should not change the
canonical identity of the content. In particular:

- `/components/<component-slug>/latest/` may redirect to the latest stable exact
  version,
- alias-tag-based URLs, if added at all, should be redirects only.

### Component landing pages

Each component landing page at `/components/<component-slug>/` should summarize:

- what the component is,
- the `unreleased` docs entry point,
- the latest stable release docs,
- maintained release lines,
- EOL release lines,
- alias mappings such as `v1 currently refers to v1.3.5`.

### Search and indexing implications

The URL scheme is designed to support the indexing policy defined below:

- `unreleased` and latest stable are the primary discovery entry points,
- older exact releases remain linkable and browsable,
- older versions should not become the default surface presented by search.

## Redirect and indexing policy

This section defines the expected behavior for canonical URLs, convenience
redirects, and search-engine indexing for versioned component docs.

### Indexable content

The following pages should be indexable by default:

- component landing pages at `/components/<component-slug>/`,
- `unreleased` component docs,
- the latest stable exact release docs.

This matches the earlier requirement that public discovery should focus on
`unreleased` and the latest stable release, while older versions remain
available primarily for direct navigation.

### Non-indexable content

The following pages should default to `noindex, follow`:

- all non-latest exact release docs,
- any convenience redirect pages if they are implemented as generated HTML
  redirect documents,
- any alias-tag-based paths if such paths are exposed at all.

This means that even a maintained but non-latest release line remains browsable
and linkable, but should not compete with `unreleased` or the latest stable
release in search results.

### Canonical URL rules

Canonical URL rules should be:

- component landing pages should be self-canonical,
- `unreleased` pages should be self-canonical,
- latest stable exact release pages should be self-canonical,
- non-latest exact release pages should also be self-canonical, even when they
  are marked `noindex, follow`.

Non-latest exact releases should **not** canonicalize to the latest stable
release, because they are distinct documentation sets and should retain stable,
direct-linkable identities.

### Redirect policy

Convenience URLs should resolve to canonical exact-version or `unreleased` URLs.

Initial policy:

- `/components/<component-slug>/latest/` may redirect to the latest stable exact
  release root,
- alias-tag-based URLs such as `/components/<component-slug>/releases/v1/` or
  `/components/<component-slug>/releases/v1.2/` should, if exposed at all, redirect
  to the corresponding exact version root,
- redirect paths are convenience entry points only and must not be treated as
  canonical content locations.

To keep the first implementation simpler and safer, page-preserving redirects
such as `/latest/<page-path>/` or `/releases/v1/<page-path>/` should be treated
as optional future enhancements rather than mandatory requirements.

### Redirect implementation guidance

If the hosting platform supports real HTTP redirects, those are preferred.

If the site must implement redirects as generated static pages, those pages
should:

- immediately redirect to the canonical target,
- declare `noindex, follow`,
- declare the canonical target URL,
- contain minimal explanatory fallback content for clients that do not follow
  automatic redirects.

This keeps convenience URLs usable without turning them into independently
indexed content.

### Robots policy for versioned docs

For versioned component docs, the renderer should emit page metadata consistent
with the following policy:

- `index, follow` for component landing pages,
- `index, follow` for `unreleased` pages,
- `index, follow` for the latest stable exact release pages,
- `noindex, follow` for all other exact release pages,
- `noindex, follow` for redirect-only pages.

If platform support exists, equivalent HTTP-level robots directives may also be
used, but page-level metadata should remain sufficient for static hosting.

### Site-local search policy

Site-local search should include only:

- `unreleased`,
- the latest stable exact release,
- and any non-versioned top-level site content the component chooses to index.

Non-latest release docs should remain directly browsable but should be excluded
from the primary search index.

### Sitemap policy

The generated sitemap should prefer:

- component landing pages,
- `unreleased` docs,
- latest stable exact release docs,
- other top-level site content intended for discovery.

Non-latest release docs may either be omitted from the primary sitemap or be
included with a clear `noindex` posture, depending on renderer capabilities, but
they should not be promoted as primary discovery entry points.

### Why this policy

This policy gives users stable access to old docs without letting:

- outdated versions dominate search,
- alias tags become quasi-canonical URLs,
- convenience redirect pages compete with canonical docs,
- search engines blur the distinction between current and historical content.

## Release snapshot storage

The preferred model is:

- exact Git tags remain the authoritative release source,
- a dedicated `versioned-docs` branch may be used as a derived snapshot store
  containing per-version released docs.

If a `versioned-docs` branch is used, it should:

- store one directory per released version,
- treat released version directories as immutable,
- include provenance metadata such as source tag and source commit SHA.

This keeps release doc assembly efficient without making the snapshot branch the
canonical release identity.

### Recommended `versioned-docs` layout

If used, the `versioned-docs` branch should follow a simple, predictable
structure per component, for example:

```text
<component-slug>/
  releases/
    v1.2.3/
      docs/
      metadata.yaml
    v1.3.5/
      docs/
      metadata.yaml
```

`metadata.yaml` should at least record:

- the exact source tag,
- the source commit SHA,
- the generation timestamp,
- the source repository URL.

This allows the main site build to use fast snapshot consumption while still
preserving provenance.

## Aggregation contract

The aggregation layer should stage all content into a normalized tree before the
renderer runs. The renderer should consume only this staged tree plus the main
site theme/layout assets.

### Proposed staged tree

One possible staging layout is:

```text
.site-stage/
  manifest.yaml
  content/
    _index.md
    blog/
    components/
      <component-slug>/
        _index.md
        unreleased/
          docs/
          version.yaml
        releases/
          v1.2.3/
            docs/
            version.yaml
          v1.3.5/
            docs/
            version.yaml
        lifecycle.yaml
  data/
    components.yaml
    aliases.yaml
    lifecycle.yaml
  static/
```

### Staging rules

- Each component gets its own namespace under `content/components/<component-slug>/`.
- Unreleased content is always staged under `unreleased/` regardless of the
  repository's actual default branch name.
- Released content is staged only under exact version identifiers.
- Alias tags are recorded as metadata in `data/aliases.yaml` or equivalent, not
  as independent content directories.
- Provenance metadata should be recorded for both unreleased and released docs.
- The renderer must not need to inspect component repositories directly.

### Generated lifecycle metadata

The aggregation layer should generate lifecycle metadata in a renderer-neutral
format so that templates and navigation code do not need to re-derive release
state from raw tags or repository layout.

The recommended model is to generate both:

- a per-component lifecycle file at
  `content/components/<component-slug>/lifecycle.yaml`, and
- an aggregated lifecycle index at `data/lifecycle.yaml`.

### Per-component lifecycle metadata

The per-component lifecycle file should contain the complete publication-oriented
view for that component, for example:

```yaml
schemaVersion: 1
component:
  slug: mammoth-cache-gradle
  displayName: Mammoth Cache Gradle
lifecycle:
  unreleased:
    label: Unreleased
    path: /components/mammoth-cache-gradle/unreleased/
    robots: index,follow
  latestStable:
    version: v1.3.5
    path: /components/mammoth-cache-gradle/releases/v1.3.5/
  releaseLines:
    - line: v1
      status: maintained
      latest: v1.3.5
      aliases:
        - v1
      path: /components/mammoth-cache-gradle/releases/v1.3.5/
    - line: v1.2
      status: eol
      latest: v1.2.9
      aliases:
        - v1.2
      path: /components/mammoth-cache-gradle/releases/v1.2.9/
```

### Aggregated lifecycle index

The aggregated lifecycle index at `data/lifecycle.yaml` should provide a compact
lookup-oriented view across all components, for example:

```yaml
schemaVersion: 1
components:
  mammoth-cache-gradle:
    latestStable: v1.3.5
    releaseLines:
      - line: v1
        status: maintained
        latest: v1.3.5
      - line: v1.2
        status: eol
        latest: v1.2.9
  no-gradle-wrapper-jar:
    latestStable: v2.0.1
    releaseLines:
      - line: v2
        status: maintained
        latest: v2.0.1
```

### Version metadata relationship

Per-version `version.yaml` files should remain focused on provenance and page
set identity, while lifecycle metadata should describe how those versions are
presented to users.

In other words:

- `version.yaml` answers: what is this exact content set?
- `lifecycle.yaml` answers: how should this version be classified and surfaced?

This separation avoids duplicating publication policy in every versioned content
directory.

### Lifecycle metadata generation rules

The aggregation layer should apply these rules when generating lifecycle
metadata:

- `latestStable` must always point to an exact version,
- each release line must reference its latest exact version,
- release line `status` must come from the controlled lifecycle vocabulary,
- alias mappings must be informational only,
- `unreleased` must always be represented separately from release lines,
- missing lifecycle input should degrade gracefully by omitting annotations
  rather than failing the whole build unless the catalog marks the metadata as
  required.

### Why generate lifecycle metadata centrally

Generating lifecycle metadata centrally helps keep:

- templates simple,
- navigation behavior consistent,
- version labels and badges reproducible,
- publication policy separate from raw docs content.

### Why this boundary matters

This boundary helps with:

- renderer independence,
- reproducible builds,
- clearer testing of the assembler,
- security isolation,
- simpler future migrations away from Hugo/Docsy if needed.

## Workspace model for local development

Local development should work with a partial workspace.

Example layout:

- `./buildish`
- `./buildish-mammoth-cache-gradle`
- `./buildish-no-gradle-wrapper-jar`

The build should include only components that are available locally.
Missing components must be skipped cleanly.

The main repository should maintain a central catalog of known components.
Local repo discovery may use conventional sibling directory layouts, but should
also support local override configuration for non-standard checkout locations.

## Central component catalog

The main repository should maintain a central catalog file describing the known
components that participate in the unified web site.

One possible location is:

- `site/components.yaml`

### Responsibilities of the catalog

The catalog should provide:

- the authoritative inventory of components expected on the published site,
- default values that most components inherit,
- repository discovery information for local development and CI,
- cross-cutting metadata such as lifecycle state and navigation grouping.

### Draft catalog format

```yaml
schemaVersion: 1
defaults:
  metadataFile: site/component.yaml
  docsRoot: site/docs
  assetsRoot: site/assets
  unreleasedLabel: Unreleased
  tagPattern: ^v[0-9]+\.[0-9]+\.[0-9]+$
  aliasTagPatterns:
    - ^v[0-9]+$
    - ^v[0-9]+\.[0-9]+$
  navigationSection: components
components:
  - slug: mammoth-cache-gradle
    repository: https://github.com/apache/buildish-mammoth-cache-gradle
    localDir: buildish-mammoth-cache-gradle
  - slug: no-gradle-wrapper-jar
    repository: https://github.com/apache/buildish-no-gradle-wrapper-jar
    localDir: buildish-no-gradle-wrapper-jar
    displayName: No Gradle Wrapper JAR
    lifecycle:
      latestStable: v1.3.5
      releaseLines:
        - line: v1
          latest: v1.3.5
          status: maintained
          aliases:
            - v1
        - line: v0
          latest: v0.9.8
          status: eol
          aliases:
            - v0
```

### Catalog design notes

- Most component entries should stay very small.
- `slug`, `repository`, and a conventional `localDir` are likely the only
  fields most entries need.
- Catalog defaults should align with the component metadata defaults so that
  most components do not need local overrides.
- Lifecycle state such as maintained vs EOL is a good fit for the central
  catalog because it is a publication concern, not just a property of a single
  source tree.
- If lifecycle metadata is omitted for a component, the site should degrade
  gracefully and simply avoid showing maintained/EOL annotations until that
  metadata is provided.

### Precedence rules

If both the central catalog and a component metadata file provide related
values, the intended precedence should be:

1. central catalog for site-wide inventory and publication policy,
2. component metadata for content-local configuration,
3. built-in defaults for everything else.

This keeps publication control centralized while still allowing components to
describe their own local content structure.

### Local workspace overrides

For non-standard local checkouts, developers may use an ignored local override
file, for example `site/components.local.yaml`, to map a component slug to a custom
filesystem path.

That file should affect only local discovery, not the published site model.

## Build tooling

The site build should use a containerized toolchain that is pinned to specific
versions of:

- the container image,
- Hugo,
- Docsy,
- Node/npm if required,
- AsciiDoc-related tooling if required.

Developers should invoke the site tooling through a stable component-local
entrypoint such as `make -C site build`, not via raw `docker` or `podman`
commands.

That entrypoint should handle:

- engine detection (`docker`, `podman`, macOS-compatible runtimes),
- cache directory mounting,
- workspace mounting,
- runtime-specific compatibility differences.

Component-local cache directories should be preferred over engine-specific named
volumes where possible, because they are usually easier to debug and more
portable across environments.

## CI and publishing model

The main site build should be responsible for assembling and publishing the
complete site.

The **baseline implementation** should use a main-repository-owned,
schedule-first publishing model.

That baseline should rely on:

- pushes to the main repository affecting site infrastructure or top-level site
  content,
- scheduled reconciliation builds run from the main repository,
- optional manual workflow dispatch for explicit operator-triggered rebuilds.

This keeps the initial implementation simpler and avoids prematurely committing
to cross-repository authentication and event-trigger design before those details
have been fully reviewed. Component-triggered publication is intentionally
deferred to [Follow-ups](#follow-ups).

Publishing must use a **strict concurrency setting** so that two publish jobs
can never race each other.

### Recommended baseline event flow

The central site workflow should initially be triggered by:

- pushes to the main repository affecting site infrastructure or top-level site
  content,
- scheduled reconciliation builds.

An additional manual dispatch trigger is also useful for maintainers who need to
force a rebuild without waiting for the next scheduled run.

Scheduled reconciliation builds should be responsible for discovering:

- new release snapshots,
- changes to unreleased docs on component default branches,
- lifecycle or catalog changes that affect the published site.

### Recommended publication flow

For the baseline model, the main repository workflow should typically:

1. resolve the authoritative build inputs from the central catalog and the
   currently visible source state,
2. generate a manifest containing all included refs and resolved SHAs,
3. assemble the staged site tree,
4. render the site,
5. run validation checks,
6. publish the generated site if validation succeeds.

Release snapshots in `versioned-docs` branches, if used, should simply be part
of what the scheduled main-repository build discovers and consumes.

### Recommended concurrency model

The safest model is:

- preview and validation runs may be cancelable,
- publish runs must be serialized,
- the final publish step should use a fixed GitHub Actions concurrency group,
- the publish step should not overlap with another publish step.

In practice, that means the main publishing job should use a strict concurrency
group with non-overlapping execution so that the public site can never be
updated by two jobs at the same time.

### Suggested manifest-based build input

To avoid races and moving-reference inconsistencies, the main site build should
resolve its inputs into a manifest at the start of the workflow.

That manifest should capture, for each included content source:

- repository,
- branch or tag name,
- resolved commit SHA,
- content kind (`unreleased` or exact release),
- any alias mappings to display,
- any lifecycle metadata to display.

The remaining build steps should operate only on that resolved manifest.

## Search and indexing

The baseline search behavior should be intentionally limited:

- site-local search should index only `unreleased`, the latest stable release,
  and any selected non-versioned top-level site content,
- older versions should remain browsable but should not dominate default search
  results,
- external indexing should follow the canonical/robots policy defined in
  [Redirect and indexing policy](#redirect-and-indexing-policy).

This keeps discovery focused on current material while still preserving stable
links to historical docs.

## Security constraints

The aggregation and rendering pipeline must apply conservative safety rules.

At minimum:

- no arbitrary custom code from component repos,
- no remote content fetching during normal builds,
- no `iframe`-based embeds,
- no embedded remote content,
- no arbitrary embedded JavaScript in component content,
- no file inclusion outside approved content roots,
- reject path traversal attempts,
- reject symlink-based escapes from repository boundaries,
- be cautious with raw HTML support,
- define and document what AsciiDoc include behavior is allowed.

## Follow-ups

The following items are intentionally left as follow-up design work rather than
part of the initial publishing baseline.

### Component-triggered publication

As a future enhancement, component repositories may trigger central site
rebuilds immediately after release or documentation changes.

That could reduce publication latency compared to a purely schedule-based model,
but it introduces additional design questions around authentication,
authorization, auditability, and operational simplicity.

For now, publication remains main-repository-owned and schedule-driven.

### Potential trigger transport

If component-triggered publication is added later, the likely transport is a
cross-repository GitHub event such as `repository_dispatch` sent to the main
site repository.

### Potential authentication model

If such a model is introduced later, the preferred direction is a dedicated
GitHub App with narrowly scoped permissions and a least-privilege installation
model.

### Potential dispatch payload

If dispatch-based triggers are added later, the payload should be versioned and
small, and should identify at least:

- the source repository,
- the source event kind,
- the relevant branch and/or exact tag,
- the best-known resolved commit SHA,
- whether the content kind is `unreleased` or `release`.

### Potential validation rules

If trigger-based publication is added later, the main site workflow should still
remain authoritative. In particular:

- the central site workflow must not trust incoming payloads as the sole source
  of truth,
- all refs should be re-resolved by the main site workflow,
- publishing should proceed only from the resolved manifest,
- unknown repositories or unexpected refs should be rejected,
- trigger handling should be conservative and fail closed.

## Open items

There are currently no unresolved open items for the baseline proposal.
Deferred enhancements remain tracked in [Follow-ups](#follow-ups).
