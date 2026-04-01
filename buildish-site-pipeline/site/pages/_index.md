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

# Site Pipeline

Assemble component-owned docs into a predictable site contract.

The Site Pipeline discovers component content, validates the workspace contract,
and stages normalized pages, docs, assets, and metadata for a downstream site
renderer.

It gives a consumer site one place to aggregate cross-repository content without
pulling renderer logic, branding, or publishing policy into every component.

{{< buildish-component-link kind="docs" label="Read docs" appearance="primary" >}}

{{< buildish-component-link kind="source" label="Browse source" appearance="outline-secondary" >}}

## Why teams use it

- one staging contract for component pages, docs, assets, and lifecycle data,
- safety checks for workspace paths and protected outputs,
- generated metadata for navigation, release lines, and preview links, and
- local build, clean, watch, and preview workflows.

## What you integrate

Participating repositories provide the content inputs the pipeline knows how to
stage:

- `site/component.yaml` for component identity and content settings,
- `site/pages/` for non-versioned component pages,
- `site/docs/` for versioned documentation, and
- optional `site/assets/` content for static files that should be published with
  the docs.

The consumer repository keeps ownership of the rendered site experience:

- theme integration,
- shared layouts and helper shortcodes,
- navigation and branding,
- publishing, and
- environment-specific runtime choices.

## Learn more

Start with the docs for the current contract, configuration model, and adoption
patterns. If you are integrating or modifying the pipeline, the source
repository contains the implementation, tests, and extracted component content.

{{< buildish-component-releases heading="Current release lines" optional="true" >}}
