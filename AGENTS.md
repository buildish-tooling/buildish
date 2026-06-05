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

## Hugo Shortcodes And Partials

- Treat Hugo shortcodes and partials as developer-facing APIs when they are used
  from authored pages or shared layouts.
- Keep shortcode and partial files ASCII-only. Many IDEs provide weak
  highlighting for Hugo templates, so avoid symbols that make plain-text reading
  harder.
- Add a short purpose comment near the top of every Buildish-owned shortcode and
  partial. State whether it is page-author-facing or layout-only.
- For shortcodes, document supported attributes, defaults, and examples in
  `site/site/docs/hugo-helpers.md`.
- Keep shortcode examples in Markdown docs escaped with Hugo's shortcode-comment
  syntax, such as `{{</* buildish-button */>}}`, so examples render as examples
  instead of executing.
- Prefer shared helper partials for repeated behavior, such as button appearance
  mapping, instead of duplicating the same logic across shortcodes.
- For authored links that should be validated by the Site Pipeline source link
  checker, keep the target as a normal Markdown or HTML link in page content.
  Do not hide such targets inside shortcode attributes.
- Use generated component-aware shortcodes only for links whose targets come from
  staged component, release, or repository metadata.

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

## Security issues

Before reporting or fixing security issues, read
[site/site/docs/threat-model.md](site/site/docs/threat-model.md) to determine
whether a finding is a Buildish vulnerability, a deployment responsibility, 
a dependency issue, or a false positive. Use [`SECURITY.md`](SECURITY.md) 
reporting process and disclosure handling.

ASF severity, advisory status, and CVE candidacy are non-authoritative triage
estimates. Do not infer them from `site/site/docs/threat-model.md` alone.

Do not treat a test as proof of a vulnerability unless it demonstrates that the
stated actor can cross a real trust boundary without already-authorized access,
privileged fixtures, mocked trust decisions, or protected information.

Do not include private vulnerability details, exploit payloads, reporter names,
private mailing-list content, secrets, or non-public infrastructure details in
code, comments, tests, documentation, commit messages, or PR descriptions.
