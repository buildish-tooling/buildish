---
weight: 30
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

# Adoption guide

Use this guide when wiring Site Pipeline into a consumer repository.

## 1. Add the dependency

Install the package into the consumer site's Python environment with your chosen
package manager. During local development, a path dependency is also fine as
long as the consumer invokes the `site-pipeline` CLI from its managed runtime.

## 2. Create the site workspace

At minimum, the consumer repo should provide:

- `site/components.yaml`
- optional `site/site-pipeline.yaml`
- optional authored site content under `site/content/`

Example `site/site-pipeline.yaml`:

```yaml
schemaVersion: 1
workspace:
  catalogPath: site/components.yaml
  authoredSiteContentPath: site/content
  stagePath: site/.stage
  previewPath: site/.preview
site:
  siteTitle: Example Project Site
  projectStatus: incubating
```

## 3. Define the component catalog

Each component entry needs a `slug` plus a checkout location:

```yaml
schemaVersion: 1
defaults:
  metadataFile: site/component.yaml
  pagesRoot: site/pages
  docsRoot: site/docs
  assetsRoot: site/assets
components:
  - slug: example-component
    localDir: example-component
    displayName: Example Component
    repository: https://github.com/apache/example-component
```

## 4. Provide component-owned inputs

Each participating component repository should provide:

- `site/component.yaml`
- `site/pages/_index.md`
- optional additional `site/pages/**`
- optional `site/docs/**`
- optional `site/assets/**`

The component landing page body is authored by the component. The pipeline does
not inject a mandatory hero or action shell.

## 5. Invoke the pipeline

Run the pipeline from the consumer environment and pass an explicit repo root:

```bash
site-pipeline build --repo-root .
```

The resulting staged tree under `site/.stage/` becomes the single source of
truth for the downstream renderer.

## 6. Integrate the renderer

Point the consumer renderer at the staged outputs rather than at component
repositories directly.

The current stage contract exposes:

- `content/` for rendered page inputs,
- `data/` for generated component and lifecycle metadata,
- `static/` for versioned assets, and
- `manifest.yaml` for aggregate staging metadata.

## 7. Add local and CI workflows

Typical local workflows use:

- `site-pipeline build` for a full staged refresh,
- `site-pipeline watch` for interactive restaging, and
- `site-pipeline serve` for the lightweight preview server.

In CI, run the pipeline before the site renderer so the published build always
consumes staged content from the contract boundary.

## Migration notes

If you are moving from an in-repo staging implementation to the extracted
package:

- call the installed `site-pipeline` CLI instead of importing private modules,
- pass `--repo-root` explicitly from consumer scripts,
- keep renderer helpers in the consumer repository, and
- update any build logic to read from `site/.stage/` instead of from component
  repos directly.