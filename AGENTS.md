# Repository Instructions

This file contains repository-wide guidance for coding agents working in the
Buildish aggregate repository. Keep instructions factual, tool-neutral, and
scoped to rules that should apply across code, tests, docs, and release work.

## General

- Preserve existing project style and structure unless a task explicitly asks for
  a broader refactor.
- Do not edit generated outputs such as `site/.stage/` or `site/.public/` unless
  the task is specifically about generated artifacts.
- Prefer small, reviewable changes with matching tests or validation commands.
- Do not revert user or maintainer changes unless explicitly asked.

## Related Repositories

- The reusable Buildish Site Pipeline implementation lives in the sibling
  checkout `../buildish-site-pipeline`.
- Site Pipeline documentation and component content live in
  `../buildish-site-pipeline/docs/` and `../buildish-site-pipeline/site/`.

## Code Style

- Follow the language and formatter conventions already used in the touched
  files.
- Keep comments concise and focused on non-obvious behavior.
- Prefer existing helper functions, build scripts, layouts, and shortcodes over
  introducing parallel mechanisms.

## Testing And Validation

- All changes should pass the relevant `make check` gate before they are treated
  as complete.
- Run the narrowest relevant checks first while iterating.
- For changes that affect Buildish site content or routing, run
  `make site-check-local` from the repository `site/` directory.
- If a relevant check cannot be run, state that explicitly in the final response.

## Site Pipeline Content

The embedded Buildish web site component lives under `site/site/` and has its
own scoped instructions in `site/site/AGENTS.md`.

## Site Publication Policy

For Buildish site content, follow `site/site/AGENTS.md`. In particular,
`development/` routes are unreleased documentation and must not be presented as
latest, stable, current, release docs, or generic docs.
