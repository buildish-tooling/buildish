# Component Instructions

This file contains guidance for coding agents working in the Buildish web site
component. Keep instructions factual, tool-neutral, and scoped to rules that
should apply across code, tests, docs, and site content in this component root.

## General

- Preserve existing project style and structure unless a task explicitly asks for
  a broader refactor.
- Do not edit generated outputs such as `.stage/` or `.public/` unless the task
  is specifically about generated artifacts.
- Prefer small, reviewable changes with matching tests or validation commands.
- Do not revert user or maintainer changes unless explicitly asked.

## Code Style

- Follow the language and formatter conventions already used in the touched
  files.
- Keep comments concise and focused on non-obvious behavior.
- Prefer existing helper functions, build scripts, layouts, and shortcodes over
  introducing parallel mechanisms.

## Testing And Validation

- Run the narrowest relevant checks for the files changed.
- For changes that affect Buildish site content or routing, run
  `make site-check-local` from the repository `site/` directory.
- If a relevant check cannot be run, state that explicitly in the final response.

## Site Pipeline Content

This directory is the component root for the Buildish web site component as
consumed by the Buildish Site Pipeline.

Authored inputs:

- `component.yaml` defines the component identity and content roots.
- `pages/` contains static, non-versioned component pages.
- `docs/` contains development or version-specific documentation.

Use relative pretty-route links within this component:

- Do not use `.md` suffixes for page links.
- Do not include source directory names such as `pages/` or `docs/` in links.
- From a `_index.md`, link to a sibling page or section as `sibling/`.
- From a non-index page, link to a sibling page or section as `../sibling/`.
- From deeper pages, add enough `../` segments to reach the target route.

Static pages in `pages/` publish at `/components/site/`:

- Keep links between static pages relative.
- When a static page links to this component's version-specific docs, use a
  relative route such as `development/` from `pages/_index.md` or
  `../development/` from a non-index static page.

Docs in `docs/` publish under the moving development route and may later be
copied under a release-version route:

- Keep links within `docs/` relative so the whole docs tree remains relocatable.
- From `docs/_index.md`, link to a sibling as `sibling/`.
- From a non-index docs page, link to a sibling as `../sibling/`.
- Avoid root-absolute component links inside `docs/`; they hard-code the current
  development publication location and will not survive release-version copies.

Links to another component may use that component's public catalog mount path,
for example `/components/site-pipeline/`.
