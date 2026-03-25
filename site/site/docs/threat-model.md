<!--
Copyright 2026 The Buildish Authors

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

# Buildish Threat Model

## 1. Header

Project: Buildish.

Version binding: this draft is bound to repository commit `694017c` on
2026-06-05. Future vulnerability reports should be triaged against the threat
model version that shipped with the affected Buildish version or release tag,
not necessarily against `main`. (inferred)

Reporting cross-reference: findings that violate Section 8 security properties
should be reported through the project `SECURITY.md` disclosure channel;
findings that rely on Section 3 out-of-scope areas or Section 9 disclaimed
properties may be closed by citing this document. (documented)

Status: draft, created 2026-06-05. (documented)

Provenance legend: `(documented)` means stated in repository files or sibling
Site Pipeline documentation; `(maintainer)` means confirmed by maintainers;
`(inferred)` means derived from current code, configuration, or repo structure
and should be confirmed before treating this as accepted.

Draft confidence: approximately 28 documented / 0 maintainer / 58 inferred
claims. The high inferred count reflects that this is the first threat-model
pass and several negative side-effect and operational-contract claims are not yet
stated as maintainer policy.

Buildish is a project for build automation, CI integrations, and supporting
tooling. This repository is an aggregate and site
consumer: it contains project-level governance files, a Buildish website
consumer, Hugo layouts and shortcodes, local wrapper Make targets, and small
consumer-side scripts that integrate with the reusable Site Pipeline
implementation in the sibling `../buildish-site-pipeline` checkout.
(documented)

## 2. Scope and intended use

Primary intended use cases:

- Maintain Buildish project-level files, release-process notes, and the
  aggregate component catalog. (documented)
- Build and validate the Buildish public website from trusted local component
  checkouts through the sibling Site Pipeline, Hugo, Node/PostCSS assets, and
  local or containerized Make workflows. (documented)
- Provide Hugo templates, partials, and shortcodes that render staged Site
  Pipeline metadata into the Buildish website. (documented)
- Provide local development helpers for refreshing Site Pipeline wheel snapshots
  and preparing an isolated consumer environment. (documented)

Deployment contexts:

- Local developer workstation running `make` targets, Python/uv, Hugo, Node, and
  optionally Docker or Podman. (documented)
- CI-like build environment running the same site checks and build targets.
  (inferred)
- Static website output published through GitHub Pages. (documented)

Caller expectations:

- Maintainers and trusted contributors are trusted to edit repository source
  files and run local build commands. (inferred)
- Component source repositories listed in `site/catalog.yaml` are expected to be
  trusted Buildish component checkouts, not arbitrary attacker-controlled
  repositories. (inferred)
- Site readers are untrusted browser clients who receive already-rendered static
  files. They do not directly call repository code. (inferred)
- The Site Pipeline implementation is a sibling dependency with its own security
  and trust model; this repository consumes it rather than reimplementing those
  controls. (documented)

Component-family table:

| Family | Representative entry point | External surface | In model? |
| --- | --- | --- | --- |
| Repository governance and policy files | `README.md`, `SECURITY.md`, `BUILDISH-RELEASE-PROCESS.md` | None at runtime; read by humans and release tooling | Yes |
| Site consumer configuration | `site/catalog.yaml`, `site/site/component.yaml`, `site/hugo.yaml` | Filesystem paths, URLs, Hugo module configuration | Yes |
| Site Make workflows | root `Makefile`, `site/Makefile`, `site/make/*.mk` | Filesystem, environment variables, child processes, optional containers, network through dependency tools | Yes |
| Consumer Python helper scripts | `site/pipeline/refresh_latest_snapshot.py`, test helpers | Filesystem, environment variables, subprocess execution of selected tools | Yes |
| Hugo layouts, partials, and shortcodes | `site/layouts/partials/buildish-component-context.html`, `site/layouts/shortcodes/*.html` | Renderer input from Hugo page params and staged data; generated HTML output | Yes |
| Authored public site content | `site/content/**`, `site/site/pages/**`, `site/site/docs/**` | Static content rendered by Hugo | Yes |
| Static assets | `site/static/**`, `site/assets/**` | Browser-delivered files and Hugo Pipes inputs | Yes |
| Generated stage and public output | `site/.stage/`, `site/.public/`, Hugo resource outputs | Build artifacts | No; generated outputs are covered only as effects of in-scope build code |
| Sibling Site Pipeline implementation | `../buildish-site-pipeline/**` | Separate Python package, CLI, container image, docs | No; referenced as an external/sibling component with its own model |
| Third-party tools and dependencies | Hugo, Docsy, Node packages, uv, Python, container engine | Toolchain and dependency behavior | No; treated as environment assumptions |

## 3. Out of scope (explicit non-goals)

The model does not cover:

- Vulnerabilities in Hugo, Docsy, Python, uv, Node packages, Java, Docker,
  Podman, operating systems, or hosting infrastructure. Those are upstream
  or deployment-layer concerns. (inferred)
- The reusable Site Pipeline implementation under `../buildish-site-pipeline`,
  except as a trusted sibling dependency consumed by this aggregate repository.
  It should be threat-modeled separately. (documented)
- Generated outputs under `site/.stage/`, `site/.public/`, Hugo `resources/`,
  and vendored transient assets, except where an in-scope source file causes an
  unsafe generated result. (documented)
- A malicious maintainer, compromised committer account, or attacker with write
  access to the repository or CI configuration. Repository write access is above
  the security boundary for this model. (inferred)
- A compromised local developer workstation or hostile shell environment from
  which `make` is invoked. The local operator controls the execution
  environment. (inferred)
- Making arbitrary untrusted component repositories safe to stage and publish.
  Buildish component content is treated as trusted publication input unless the
  Site Pipeline model says otherwise. (inferred)
- Protecting browser users from active HTML, JavaScript, or CSS intentionally
  imported from trusted same-origin static assets or component content. Active
  content requires deployment policy such as origin isolation and CSP. (inferred)
- Supply-chain hygiene questions such as dependency freshness, release signing,
  GitHub Actions pinning, or release-process compliance. Those may be important but
  are not threat-model properties for this document. (documented from guidance)

## 4. Trust boundaries and data flow

Trust boundary:

- The primary boundary is between trusted repository/component input and the
  generated public static website. Buildish tooling should not allow trusted
  build inputs to accidentally publish local filesystem details, unsafe links,
  or malformed staged metadata. (inferred)
- A second boundary exists between local operator configuration and repository
  authored input. Local-only configuration and environment variables may affect
  local execution, but repository or provider metadata should not be able to
  select arbitrary local paths, commands, or unsafe publication policy.
  (inferred)
- A third boundary exists at the browser. Hugo templates and renderers should
  treat staged metadata strings as data and escape by default unless a field is
  explicitly trusted as active content. (documented in sibling Site Pipeline
  security docs)

Data flow:

1. Component inventory and publication settings are read from `site/catalog.yaml`
   and component metadata files. (documented)
2. Make targets invoke the sibling Site Pipeline to validate, stage, watch, or
   build content under `site/.stage/`. (documented)
3. Hugo renders local site content plus staged content/data/static assets using
   local layouts, partials, shortcodes, Docsy modules, and local static assets.
   (documented)
4. Generated public output is written to `site/.public/` for publication by the
   deployment layer. (documented)
5. Browser clients receive static HTML, CSS, JavaScript, images, and downloadable
   assets. (inferred)

Reachability preconditions per component:

| Family | In-model finding precondition |
| --- | --- |
| Repository governance and policy files | The issue must misdirect security reporting, release handling, or documented downstream responsibility. |
| Site consumer configuration | The issue must be reachable from committed or intended local configuration and must affect staging, rendering, routing, or publication safety. |
| Site Make workflows | The issue must be reachable by running a documented Make target with ordinary local/CI privileges. |
| Consumer Python helper scripts | The issue must be reachable through documented script or Make-target invocation, not by direct mutation of internal functions by an attacker who already controls the process. |
| Hugo layouts, partials, and shortcodes | The issue must be reachable from staged front matter, Hugo site data, authored content, or documented shortcode parameters. |
| Authored public site content | The issue must affect the rendered public site or documented user/security guidance. |
| Static assets | The issue must affect browser-delivered assets or renderer inputs used by the public site. |
| Generated outputs | The issue must trace back to an in-scope source or build workflow. |

For the referenced `site/layouts/partials/buildish-component-context.html`, an
in-model issue must be reachable from Hugo page parameters or `hugo.Data`
objects produced by the Site Pipeline or local site data. Directly calling the
partial with arbitrary objects outside Hugo rendering is not an intended entry
point. (inferred)

## 5. Assumptions about the environment

Operating system and runtime assumptions:

- Local checks assume a POSIX-like shell environment with GNU-compatible common
  tools unless a Make target explicitly delegates into a container. (inferred)
- Site Python helper code assumes Python 3.13 through the consumer
  `pyproject.toml`. (documented)
- Site rendering assumes Hugo extended 0.160.1 or newer through `site/hugo.yaml`.
  (documented)
- Node/PostCSS tooling is installed from `site/package-lock.json`/`package.json`
  for renderer assets. (documented)
- Containerized workflows assume Docker or Podman semantics close enough for the
  Makefile container wrappers. (documented)

Concurrency assumptions:

- Normal `make check` and build workflows are single-build workflows. (inferred)
- The snapshot refresh helper uses a filesystem lock to serialize consumer
  environment refresh operations. (documented)
- Watch-mode behavior is delegated to the Site Pipeline and its tests; this
  aggregate model does not make independent watch concurrency claims. (inferred)

Filesystem assumptions:

- The repository checkout, sibling `../buildish-site-pipeline` checkout, and
  component checkouts listed in `site/catalog.yaml` are controlled by the local
  operator. (inferred)
- Generated directories such as `site/.stage/`, `site/.public/`, build scratch
  directories, and vendored transient assets may be removed or recreated by
  Make targets. (documented)
- Local output paths should remain under intended build roots; path containment
  inside the reusable pipeline is delegated to the Site Pipeline model.
  (documented)

Network assumptions:

- Default rendering of the static site does not expose a network service.
  (inferred)
- Dependency tools may access networks for module, package, or container image
  operations depending on local cache state and tool configuration. (inferred)
- `serve-local` and containerized `serve` workflows start local development
  servers and are not intended as production internet-facing services.
  (inferred)

What the project does not do to its host:

- It does not provide a daemon intended to run continuously in production.
  (inferred)
- It does not accept direct untrusted network requests in the normal build path.
  (inferred)
- It does not intentionally install signal handlers in the parent shell process;
  shell traps are scoped to Make recipe subprocesses. (inferred)
- It does not intentionally read secrets from repository content. Environment
  variables are consumed by local tools, and the refresh helper deliberately
  passes through a limited set of variables plus selected prefixes. (documented)
- It does not intentionally write outside configured build, cache, scratch, or
  publication directories. (inferred)

## 5a. Build-time and configuration variants

| Variant or knob | Default | Security effect | Maintainer stance |
| --- | --- | --- | --- |
| `SITE_PIPELINE_REPO_ROOT` | Sibling `../buildish-site-pipeline` | Selects the Site Pipeline implementation used by local Make targets | Inferred: trusted local-operator override only |
| `SITE_PIPELINE_CATALOG` | `site/catalog.yaml` | Selects component inventory and source roots | Inferred: trusted local-operator override only |
| `NODE_MODULES_DIR` | `site/node_modules` | Selects source directory for copied renderer vendor assets | Inferred: trusted local-operator override only |
| `HUGO`, `UV`, `PYTHON` | Tool names on `PATH` | Selects executable tools invoked by Make targets | Inferred: trusted local shell/path only |
| `NVM_DIR` | `$HOME/.nvm` | Influences Node version selection and executable path | Inferred: trusted local shell/path only |
| `CONTAINER_ENGINE` | Auto-detected Docker/Podman | Selects container runtime and containerized execution behavior | Inferred: trusted local operator only |
| `CONTAINER_IMAGE` / `SITE_PIPELINE_CONTAINER_IMAGE` | Local image names | Selects images used for containerized workflows | Inferred: trusted local/CI image policy only |
| `PORT` / `HUGO_SERVER_BIND` | `8000` / `127.0.0.1` | Controls local development server binding | Inferred: binding to public interfaces is operator risk |
| `BUILDISH_*`, `UV_*`, `PYTHON*`, proxy and TLS environment variables | Caller environment | Passed to helper-managed process environments or dependency tools | Documented for exact pass-through set; stance inferred |
| Hugo `goldmark.renderer.unsafe` | `false` | Controls raw HTML rendering in Markdown | Documented default: unsafe raw HTML disabled |
| Hugo/Docsy privacy toggles | External embeds mostly disabled or privacy-enhanced | Affects browser privacy posture of rendered pages | Documented default; exact deployment posture inferred |

No build option in this repository is currently documented as a supported
production security hardening flag. Local overrides are modeled as trusted
operator execution policy, not as untrusted repo-authored data. (inferred)

## 6. Assumptions about inputs

Accepted inputs:

- Repository source files and documentation. (documented)
- Site catalog, component metadata, authored content, and local site data.
  (documented)
- Staged metadata and page front matter produced by the Site Pipeline.
  (documented)
- Environment variables and Make variables supplied by the local operator.
  (documented)
- Toolchain outputs from uv, Python, Hugo, Node, Docker, or Podman. (inferred)
- Browser requests to local development servers during `serve` workflows.
  (inferred)

Per-parameter trust table:

| Entry point | Parameter or input | Attacker-controllable? | Caller/operator must enforce |
| --- | --- | --- | --- |
| Root `make check` | Make variables and environment | No, trusted local operator | Do not run with hostile `PATH`, tool variables, or environment |
| `site/Makefile` local targets | `HUGO`, `UV`, `PYTHON`, `NVM_DIR`, `NODE_MODULES_DIR` | No, trusted local operator | Point to trusted tools and dependency directories |
| Containerized Make targets | `CONTAINER_ENGINE`, image variables, mount roots | No, trusted local/CI operator | Use trusted images and runtimes; avoid hostile mounts |
| `site/catalog.yaml` | Component `localDir`, mount paths, origin URLs | No, trusted repo-maintained config | Keep catalog reviewed and do not include arbitrary untrusted repositories |
| `site/site/component.yaml` | Component metadata | No, trusted repo-maintained config | Keep schema-valid and reviewed |
| Site Pipeline staged data | `hugo.Data.routes`, component records, page params | Partly: can be influenced by trusted component content | Pipeline must validate structure; templates must escape text |
| `buildish-component-context.html` | `.Params.sitePipelineComponent`, `.Params.pipeline.component` | Partly: from staged front matter | Treat strings as data; do not render arbitrary HTML from metadata |
| `buildish-component-context.html` | `.Params.sitePipelineComponentPage`, `.Params.pipeline.page` | Partly: from staged front matter | Use only for routing/layout decisions after pipeline validation |
| `buildish-component-context.html` | `hugo.Data.component_repos` | No, trusted local site data | Keep repository URLs reviewed; avoid unsafe schemes if rendered as links |
| `buildish-component-context.html` | `hugo.Data.routes.items` | Partly: staged pipeline data | Pipeline validates route shape; template uses paths as generated links |
| Hugo shortcodes | Authored shortcode attributes | No, trusted page authors | Keep link-validation expectations documented; do not hide validated links in generated-only attributes |
| `refresh_latest_snapshot.py` | `consumer_root`, `manifest_path`, `venv_path`, `uv_executable` | No, local operator/script caller | Pass trusted local paths and executable names |
| `serve-local` / `serve` | Browser HTTP request path | Yes, from local browser/client | Keep bound to local trusted networks; do not expose as production service |

Size, shape, and rate assumptions:

- Size ceilings for staged metadata are delegated to the Site Pipeline model and
  implementation. (documented)
- This aggregate repository does not currently state independent size or rate
  limits for Hugo rendering, static assets, or local development serving.
  (inferred)
- Tool and renderer resource usage is expected to be appropriate for trusted
  Buildish component content, not adversarially generated large inputs.
  (inferred)

## 7. Adversary model

In-scope adversaries:

- A remote site reader who can request public static files and local dev-server
  files if an operator exposes a dev server. (inferred)
- A malicious or compromised component-content contributor who can influence
  trusted component documentation before maintainer review, but not arbitrary
  local environment variables or Make variables. (inferred)
- A bug reporter or scanner that submits findings against committed source,
  staged metadata rendering, or documented build workflows. (inferred)

Out-of-scope actors:

- Attackers with repository write access or control of the Buildish release
  process. (inferred)
- Attackers with shell access to the local build machine, control of `PATH`, or
  control of configured tool executables. (inferred)
- Attackers who can modify dependency caches, container images, or upstream
  third-party packages used by the build. (inferred)
- Network attackers against package registries, module mirrors, or hosting
  infrastructure. Those are dependency/deployment concerns. (inferred)

Attacker goals considered:

- Cause unsafe rendered HTML or links by manipulating staged metadata or trusted
  authored content before publication review. (inferred)
- Publish local filesystem details or unintended paths into static site outputs.
  (inferred)
- Cause build commands to execute unintended tools or commands through untrusted
  repo-authored data. (inferred)
- Cause denial of service in local build or rendering through unexpectedly large
  or malformed content. (inferred)
- Mislead security triage by relying on properties the project does not claim.
  (inferred)

## 8. Security properties the project provides

| Property | Conditions | Violation symptom | Severity tier | Provenance |
| --- | --- | --- | --- | --- |
| Security reports have a defined disclosure channel | Report concerns an in-scope Buildish issue | Reporter cannot identify security contact or reports to wrong channel | Security-critical process property | documented |
| Generated outputs are not edited as source | Maintainers follow repository instructions and build from source inputs | Review contains hand-edited generated artifacts that can be overwritten or mask source issues | Correctness/reviewability; can become security-relevant if unsafe output is hidden | documented |
| Hugo metadata rendering treats metadata as data by default | Templates use normal Hugo escaping and do not opt into raw HTML for untrusted strings | Reflected or stored XSS in rendered site from staged metadata | Security-critical for public site readers | documented/inferred |
| `buildish-component-context.html` normalizes old and current front matter shapes | Inputs come from Site Pipeline staged front matter or compatible legacy data | Missing or wrong component navigation, release menu, brand label, or landing-page detection | Correctness; security only if it creates unsafe links or misleading release status | documented/inferred |
| Development docs are not represented as latest/stable/release docs | Site content follows `site/site/AGENTS.md` publication policy | Unreleased docs are linked or labeled as current stable release docs | Integrity/user-trust property | documented |
| Local dev servers bind to loopback by default | Operator does not override `HUGO_SERVER_BIND` or container publication policy unsafely | Local preview/site server is reachable by unintended network clients | Availability/confidentiality depends on environment; usually hardening | documented/inferred |
| Consumer helper subprocess environment is intentionally limited | `refresh_latest_snapshot.py` managed execution path is used | Unexpected CI secrets or unrelated variables are propagated to child tooling | Confidentiality/hardening | documented |
| Shell-command execution is not driven by staged metadata in this aggregate repo | Make targets and scripts use fixed commands plus trusted operator variables | Component metadata causes arbitrary local command execution | Security-critical local execution property | inferred |
| Published aggregate metadata should avoid machine-local implementation details | Pipeline and renderer honor Site Pipeline minimization rules | Absolute local paths or internal endpoints appear in public static output | Confidentiality/hardening | documented/inferred |
| Resource exhaustion is bounded only to the extent documented by Site Pipeline and tooling | Inputs stay within expected trusted Buildish content size | Build hangs, excessive memory, excessive output, or local dev server exhaustion | Availability; security-critical only for exposed CI/service contexts | documented/inferred |

## 9. Security properties the project does not provide

Disclaimed properties:

- No guarantee that arbitrary untrusted repositories or docs trees are safe to
  stage and publish. Component content is trusted publication input subject to
  review. (inferred)
- No guarantee that `make` targets are safe when run with attacker-controlled
  environment variables, Make variables, `PATH`, tools, dependency caches, or
  container images. (inferred)
- No production security guarantee for local `serve` workflows. They are local
  development servers, not hardened public services. (inferred)
- No independent security guarantee for the sibling Site Pipeline implementation
  beyond the properties stated in that project's own docs and tests. (documented)
- No guarantee that third-party tools or dependencies are vulnerability-free.
  (inferred)
- No browser sandboxing guarantee for intentionally active same-origin content
  such as JavaScript, CSS, imported active static trees, or third-party Docsy
  assets. Deployment policy must handle that. (inferred)
- No cryptographic integrity, authentication, authorization, or confidentiality
  service is provided by this repository's website templates or Make wrappers.
  (inferred)
- No constant-time, side-channel, or secret-processing properties are claimed.
  This project is not a cryptographic library. (inferred)

False-friend properties:

- Site Pipeline validation is structural validation for staging and publication;
  it is not a sanitizer that makes malicious active content safe for same-origin
  publication. (documented/inferred)
- Hugo escaping protects normal template rendering; it does not make every
  shortcode, raw HTML mode, static asset, or intentionally active content safe.
  (inferred)
- Containerized workflows improve reproducibility and isolation from some local
  host differences; they are not a sandbox for malicious inputs if the operator
  supplies trusted mounts, images, and tool configuration incorrectly. (inferred)
- Local development server binding to `127.0.0.1` by default reduces exposure;
  it is not authentication or access control if the bind address is changed.
  (inferred)

Well-known attack classes left to callers/operators:

- Supply-chain attacks against dependencies, modules, package registries, and
  container images must be handled by release/CI policy outside this model.
  (inferred)
- Same-origin script abuse from active static content must be handled through
  content review, isolation, CSP, and deployment policy. (inferred)
- CI secret exfiltration by malicious build configuration is out of scope once
  the attacker can alter trusted repository files or CI settings. (inferred)
- Denial of service from adversarially large documentation trees is not fully
  specified here; operators should apply CI timeouts and resource limits.
  (inferred)

## 10. Downstream responsibilities

Buildish maintainers and site operators must:

- Report and route suspected security issues through `security@buildish.org` as
  documented in `SECURITY.md`. (documented)
- Review changes to site catalog, component metadata, Hugo templates,
  shortcodes, Makefiles, and helper scripts as security-relevant when they affect
  paths, links, rendering, subprocesses, or environment handling. (inferred)
- Treat component repositories and authored site content as trusted publication
  inputs. Do not add arbitrary untrusted repositories to `site/catalog.yaml` for
  public publication. (inferred)
- Keep local-only path or checkout remapping outside tracked public source unless
  explicitly intended for publication. (inferred)
- Run Make targets with trusted `PATH`, trusted tool variables, trusted
  container images, and trusted dependency directories. (inferred)
- Keep development servers bound to trusted interfaces unless intentionally
  exposing them in a controlled environment. (inferred)
- Preserve Hugo escaping defaults and avoid raw HTML rendering for staged
  metadata unless the field is explicitly trusted active content. (inferred)
- Use deployment-layer controls for active same-origin content, including origin
  isolation and CSP where appropriate. (inferred)
- Re-run relevant checks, preferably `make check`, before treating changes as
  complete. (documented)

## 11. Known misuse patterns

- Treating `development/` documentation routes as latest, current, stable, or
  release documentation. This misleads users about unreleased behavior; link to
  released docs where available or clearly label development docs as unreleased.
  (documented)
- Editing generated output under `site/.stage/` or `site/.public/`. These edits
  are not durable and may hide the actual source of a rendering issue; edit
  source inputs instead. (documented)
- Passing unreviewed external repositories into the site catalog and publishing
  them as Buildish component content. The model assumes trusted component
  inputs; review or isolate external content first. (inferred)
- Running Make targets with a hostile `PATH`, overridden tool variable, or
  untrusted container image. Make variables are trusted operator inputs, not
  adversary-controlled data. (inferred)
- Exposing `serve-local` or `serve` as an internet-facing service. These are
  development workflows; use a static hosting deployment for public service.
  (inferred)
- Rendering staged metadata as raw HTML in templates. Metadata strings should be
  treated as data unless the relevant contract explicitly marks them active.
  (documented/inferred)

## 11a. Known non-findings (recurring false positives)

| Reported pattern | Why it is not a finding under this model | Disposition |
| --- | --- | --- |
| `site/.stage/` or `site/.public/` contains unsafe-looking generated content | Generated outputs are not source; report must trace to an in-scope source or build workflow | `OUT-OF-MODEL: unsupported-component` or `MODEL-GAP` if no source route is clear |
| Make target can execute a malicious `hugo`, `uv`, `python`, `docker`, or `podman` from `PATH` | Tool selection and `PATH` are trusted local-operator inputs | `OUT-OF-MODEL: adversary-not-in-scope` |
| A committed maintainer can add malicious JavaScript to site assets | Repository write access is outside the adversary model | `OUT-OF-MODEL: adversary-not-in-scope` |
| `serve-local` lacks production authentication | Local serve workflows are development servers, not production services | `BY-DESIGN: property-disclaimed` |
| `buildish-component-context.html` trusts Site Pipeline front matter enough to build navigation links | The partial is a renderer bridge; staged data validation belongs to the Site Pipeline and normal Hugo escaping/rendering policy | `BY-DESIGN: property-disclaimed` unless unsafe rendering is demonstrated |
| A report concerns only `../buildish-site-pipeline` implementation code | The sibling implementation is separately modeled and triaged in its own repository | `OUT-OF-MODEL: unsupported-component` for this aggregate model |

## 12. Conditions that would change this model

Revise this threat model when any of the following happens:

- Buildish adds a new public service, daemon, API endpoint, webhook receiver, or
  production network process. (inferred)
- Buildish starts treating arbitrary third-party component repositories as
  untrusted inputs that are staged or published without normal maintainer review.
  (inferred)
- Hugo templates or shortcodes begin rendering staged metadata as raw HTML or
  introduce new active-content mechanisms. (inferred)
- Site Pipeline ownership, implementation location, or security contract changes
  materially. (inferred)
- Make workflows add new subprocesses, shell interpolation, archive extraction,
  filesystem writes, network fetches, or container mounts controlled by
  repository-authored data. (inferred)
- Local development servers become intended public services. (inferred)
- The project adds release artifacts, downloads, signing flows, or CI publishing
  paths that this aggregate repository directly controls. (inferred)
- A vulnerability report cannot be classified using Section 13. That is a
  `MODEL-GAP` and the model should be updated rather than resolved ad hoc.
  (documented from guidance)

## 13. Triage dispositions

| Disposition | Meaning | Licensed by |
| --- | --- | --- |
| `VALID` | Violates a Section 8 property via an in-scope adversary and input | Sections 6, 7, 8 |
| `VALID-HARDENING` | No Section 8 property is violated, but an in-scope misuse is easy enough that the project elects to harden behavior | Section 11 |
| `OUT-OF-MODEL: trusted-input` | Requires attacker control of an input marked trusted | Section 6 |
| `OUT-OF-MODEL: adversary-not-in-scope` | Requires attacker capabilities excluded by the model | Section 7 |
| `OUT-OF-MODEL: unsupported-component` | Lands in generated output, sibling implementation, third-party tooling, or another component outside this model | Section 3 |
| `OUT-OF-MODEL: non-default-build` | Requires a discouraged or operator-only build/configuration variant outside the modeled default | Section 5a |
| `BY-DESIGN: property-disclaimed` | Concerns a property the project explicitly does not provide | Section 9 |
| `KNOWN-NON-FINDING` | Matches a recurring false positive documented here | Section 11a |
| `MODEL-GAP` | Cannot be cleanly routed to another disposition | Section 12 |

## 14. Open questions for maintainers

Wave 1: scope and boundaries.

- Should this root document be the canonical threat model for the aggregate
  repository, or should the site component have a separately published model
  under `site/site/docs/`? Proposed answer: root `docs/threat-model.md` is
  canonical for the aggregate; Site Pipeline keeps its separate model. Lands in
  Sections 1, 2, and 3.
- Are Buildish component repositories listed in `site/catalog.yaml` considered
  trusted publication inputs after normal maintainer review? Proposed answer:
  yes. Lands in Sections 2, 6, 7, 9, and 10.
- Should `serve` and `serve-local` be explicitly disclaimed as production
  services? Proposed answer: yes, they are development workflows only. Lands in
  Sections 3, 5, 7, 9, and 11.
- Should local operator overrides such as `SITE_PIPELINE_CATALOG`,
  `NODE_MODULES_DIR`, executable variables, and container image variables be
  classified as trusted local execution policy? Proposed answer: yes. Lands in
  Sections 5a, 6, 7, 9, and 11a.
- Should generated output findings be triaged only when they trace back to
  source inputs or build workflows? Proposed answer: yes. Lands in Sections 3,
  4, 11a, and 13.

Wave 2: rendering and browser-facing properties.

- Does the project claim that staged metadata rendered by Buildish-owned Hugo
  templates is escaped by default and must not be treated as trusted HTML?
  Proposed answer: yes, matching the sibling Site Pipeline security model.
  Lands in Sections 4, 8, 9, 10, and 11.
- Are same-origin active assets and intentionally imported HTML/JS/CSS trusted
  code whose isolation is a deployment responsibility? Proposed answer: yes.
  Lands in Sections 3, 9, and 10.
- Is the release/development documentation labeling policy a security-relevant
  integrity property for user trust? Proposed answer: yes, though not usually a
  CVE-class issue. Lands in Section 8.
- Does `buildish-component-context.html` have any additional guarantees around
  URL scheme validation, or does it rely on upstream staged route validation and
  reviewed local `component_repos` data? Proposed answer: it relies on upstream
  validation and trusted local data. Lands in Sections 4, 6, 8, 9, and 11a.

Wave 3: resources and side effects.

- Should this aggregate repository claim any independent resource-exhaustion
  bounds beyond those documented by the Site Pipeline and enforced by local CI?
  Proposed answer: no independent quantitative bounds for now. Lands in
  Sections 6, 8, 9, and 10.
- Are there any host side effects not captured here, such as intentional writes
  outside build/cache roots, external network fetches in default checks, or
  process-wide configuration changes? Proposed answer: none beyond documented
  toolchain behavior. Lands in Section 5.
- Should containerized workflows be treated as isolation/sandboxing properties
  or only as reproducibility and environment-control workflows? Proposed answer:
  only reproducibility and environment-control. Lands in Sections 5a, 9, and 11.
- Should this document include a machine-readable `threat-model.yaml` sidecar
  for triage automation? Proposed answer: not yet; add one after maintainer
  review if automated triage needs it. Lands in Section 15.

## 15. Optional: machine-readable companion

No `threat-model.yaml` sidecar is included in this first draft. The prose
threat model remains canonical. If the project later wants automated or
AI-assisted triage, derive a sidecar containing entry-point trust levels,
component scope, configuration variants, claimed and disclaimed properties,
known non-findings, and disposition labels from this document. (inferred)
