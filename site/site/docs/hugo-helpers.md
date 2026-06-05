---
title: Hugo Helpers
linkTitle: Hugo Helpers
weight: 20
description: Buildish-specific Hugo shortcodes and partials used by page authors and site maintainers.
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

This page documents the Buildish-specific Hugo helpers used by component page
authors and by maintainers of the Buildish site renderer.

Hugo shortcode and partial templates are hard to read in many IDEs because they
are HTML files with Go template syntax and little useful highlighting. Treat this
page as the user-facing contract. The template comments are only implementation
notes.

## Choosing a helper

Use `buildish-button` when the page author knows the target page and can write a
normal Markdown link. This keeps the target visible to the site-pipeline source
link checker.

Use `buildish-component-link` when the target is generated from component or
release metadata. Examples are the current component overview page, development
docs, release docs, and the source repository URL.

Do not use a generated component link for an ordinary sibling page such as
`getting-started/`. Write the link in Markdown and wrap it with
`buildish-button` if it should look like a button.

## Shared appearance values

Both link shortcodes support the same `appearance` values:

| Value | Result |
| --- | --- |
| `link` | Plain link, no button classes. |
| `primary` | Primary button. |
| `secondary` | Secondary button. |
| `outline-primary` | Outline primary button. |
| `outline-secondary` | Outline secondary button. |

The shared mapping lives in the `buildish-link-appearance-class.html` partial.

## `buildish-button`

`buildish-button` styles one authored link as a button.

Use this when you want a button that points to a page target written directly in
the Markdown source:

```md
{{</* buildish-button appearance="primary" */>}}
[Get started](getting-started/)
{{</* /buildish-button */>}}
```

The shortcode body must render to exactly one link. These are valid bodies:

```md
[Get started](getting-started/)
```

```md
<a href="getting-started/">Get started</a>
```

Do not pass the link target as a shortcode attribute. This would hide the target
from the site-pipeline source link checker. The checker can see Markdown links in
the shortcode body, but it does not understand Hugo shortcode attributes.

Use angle-delimited shortcode syntax, not percent-delimited syntax:

```md
{{</* buildish-button appearance="primary" */>}}
[Get started](getting-started/)
{{</* /buildish-button */>}}
```

Do not use this form:

```md
{{%/* buildish-button appearance="primary" */%}}
[Get started](getting-started/)
{{%/* /buildish-button */%}}
```

With the current Goldmark raw HTML policy, the percent-delimited form sends the
shortcode output back through Markdown rendering and can strip or flatten the
button HTML.

### Attributes

| Attribute | Required | Default | Description |
| --- | --- | --- | --- |
| `appearance` | no | `primary` | Visual style. See shared appearance values above. |

## `buildish-component-link`

`buildish-component-link` renders a link whose target is derived from staged
component metadata, staged release metadata, or repository metadata.

Use this shortcode for targets that should move with the component publication
model rather than with the authored page location.

### Overview link

Link to the current component landing page:

```md
{{</* buildish-component-link kind="overview" label="Overview" appearance="secondary" */>}}
```

### Development docs link

Link to unreleased development docs:

```md
{{</* buildish-component-link kind="development" label="Developer Docs (unreleased)" appearance="primary" */>}}
```

Development docs are not ASF release documentation. Use this kind only when the
page is intentionally pointing to unreleased content.

### Latest release docs link

Link to the latest released docs:

```md
{{</* buildish-component-link kind="docs" label="Read docs" appearance="primary" */>}}
```

`kind="docs"` means release docs. It does not mean development docs.

If no release exists, this target cannot be resolved unless `optional="true"` is
set.

### Exact release docs link

Link to a specific release version:

```md
{{</* buildish-component-link kind="release" version="1.2.3" label="Release 1.2.3 docs" */>}}
```

### Release-line docs link

Link to the latest release in a release line:

```md
{{</* buildish-component-link kind="release" releaseLine="1.1" label="1.1 docs" */>}}
```

The aliases `line` and `release-line` are also accepted, but `releaseLine` is the
preferred spelling.

### Source repository link

Link to the component source repository:

```md
{{</* buildish-component-link kind="source" label="Browse source" appearance="outline-secondary" */>}}
```

If the repository URL is missing, `kind="source"` behaves as optional by default
and emits no link.

### Attributes

| Attribute | Required | Default | Description |
| --- | --- | --- | --- |
| `kind` | no | `docs` | Link target kind. Supported values are `overview`, `development`, `docs`, `release`, and `source`. |
| `label` | no | depends on `kind` | Link text. Overrides the default label. |
| `appearance` | no | `link` | Visual style. See shared appearance values above. |
| `optional` | no | `false` | If `true`, emit nothing when the target cannot be resolved. |
| `version` | for some `release` links | `latest` | Release version selector. Use an exact version such as `1.2.3` or `latest`. |
| `releaseLine` | no | empty | Select the latest release in a release line, for example `1.1`. |
| `line` | no | empty | Alias for `releaseLine`. |
| `release-line` | no | empty | Alias for `releaseLine`. |

## `buildish-component-releases`

`buildish-component-releases` renders a compact release summary for the current
component.

Use it on a component landing page when the page should show the latest stable
version and known release lines:

```md
{{</* buildish-component-releases heading="Release lines" optional="true" */>}}
```

If no release metadata exists and `optional` is not `true`, the shortcode fails
the Hugo build.

### Attributes

| Attribute | Required | Default | Description |
| --- | --- | --- | --- |
| `heading` | no | empty | Optional heading rendered above the release list. |
| `optional` | no | `false` | If `true`, emit nothing when no release metadata exists. |

## Partials

Partials are implementation helpers used by layouts and shortcodes. Page authors
normally do not call them directly.

## Layout partials

These partials are called by page layouts or by other partials. They are not
intended for direct use from authored Markdown.

### `apache-buildish-pipeline-icon.html`

Renders the inline SVG Buildish icon. Used by the navbar and other branded
surfaces.

### `apache-incubator-logo.html`

Renders the inline SVG Apache Incubator logo.

### `breadcrumb.html`

Overrides the Docsy breadcrumb renderer. It uses pipeline-derived titles and
hides the generic `/components/` crumb on component pages.

### `buildish-component-context.html`

Builds the normalized component context for the current staged page. The context
contains component metadata, publication paths, docs menu items, release menu
items, repository URL, and component landing-page detection.

Used by navigation layouts, sidebars, and component-aware shortcodes.

### `buildish-link-appearance-class.html`

Maps the shared `appearance` attribute values to CSS classes. This keeps
`buildish-button` and `buildish-component-link` visually consistent.

### `buildish-embedded-metadata.html`

Emits Open Graph, Twitter, and schema metadata using the same title and
description fallback rules as the visible page.

### `buildish-ordered-component-pages.html`

Orders component landing pages by the staged `data/components.json` aggregate.
This is used by the components index because Hugo page weights alone do not see
the cross-component catalog order.

### `buildish-resolved-description.html`

Returns the best available description for a page. It prefers authored
description, then pipeline-derived description, then site description.

### `buildish-resolved-title.html`

Returns the best available title for a page. It prefers authored title or link
title, then pipeline-derived title, then site title.

### `favicons.html`

Adds Buildish favicon and web-app icon links.

### `head.html`

Extends the Docsy head partial with Buildish-specific metadata and assets.

### `navbar.html`

Renders the main navbar. On component pages it adds component-aware Docs,
Releases, and Source entries while preserving global site navigation.

### `section-index.html`

Overrides the section index renderer so staged component pages can use
pipeline-derived titles and descriptions.

### `sidebar.html`

Chooses the sidebar root. Static component pages get the static component tree.
Versioned docs pages get the version-specific docs tree.

### `sidebar-tree.html`

Renders the chosen sidebar tree and filters versioned docs roots out of static
component sidebars.

### `sidebar-version-context.html`

Renders the version context block in the left sidebar for versioned docs. It also
renders the prominent link back to the component landing page.

### `version-banner.html`

Renders the main content warning banner for development docs, release candidates,
withdrawn releases, unsupported releases, and limited-maintenance releases.

### `buildish-component-context.html` and release data

Release-aware helpers currently rely on staged route and component aggregates.
That means generated release links are only available when site-pipeline has
staged release route metadata for the component.
