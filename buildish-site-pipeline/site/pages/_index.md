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

The Site Pipeline is the reusable staging component that assembles component-owned
pages, docs, assets, and metadata into a normalized site tree for rendering.

It separates the cross-repository content contract from the consumer's site theme,
templates, and publishing workflow.

{{< buildish-component-link kind="docs" label="Read docs" appearance="primary" >}}

{{< buildish-component-link kind="source" label="Browse source" appearance="outline-secondary" >}}

## What it provides

- catalog-driven discovery of participating components,
- validation for component metadata and workspace paths,
- staging for component landing pages, versioned docs, and static assets,
- generated metadata for navigation, lifecycle, and preview links, and
- build, clean, and watch workflows for local development and CI.

## Component contract

Participating repositories provide the content inputs the pipeline knows how to
stage:

- `site/component.yaml` for component identity and content settings,
- `site/pages/` for non-versioned component pages,
- `site/docs/` for versioned documentation, and
- optional `site/assets/` content for static files that should be published with
  the docs.

The consumer repository keeps ownership of the rendered site experience, such as
theme integration, shared layouts, publishing, and environment-specific runtime
choices.

## Next steps

Start with the docs for the current contract, configuration model, and staging
behavior. If you are integrating or modifying the pipeline, the source repository
contains the implementation, tests, and extracted component content.

{{< buildish-component-releases heading="Current release lines" optional="true" >}}
