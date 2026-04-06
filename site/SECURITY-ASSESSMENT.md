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

# Security Assessment — `site/`

Scope: the `site/` directory and the `.github/workflows/site-publish.yml`
workflow that drives it.

Assessment date: 2026-04-01.

---

## Severity legend

| Level | Meaning |
|-------|---------|
| **HIGH** | Can directly enable a compromise of the repository, CI pipeline, or published site |
| **MEDIUM** | Requires additional preconditions or local access to exploit |
| **LOW** | Informational / defence-in-depth gaps |
| **GOOD** | Positive finding — deliberate control worth preserving |

---

## ~~HIGH~~ — `peaceiris/actions-gh-pages` — finding retracted

**File:** `.github/workflows/site-publish.yml` line 55

```yaml
uses: peaceiris/actions-gh-pages@4f9cc6602d3f66b9c108549d475ec49e8ef4d45e # v4.0.0
```

`peaceiris/actions-gh-pages` appears in the ASF infrastructure approved-actions
list with `'*': keep: true`, so any pinned SHA is permitted.  The SHA
`4f9cc6602d3f66b9c108549d475ec49e8ef4d45e` is the commit for the v4.0.0 tag,
which is the latest release.  **No action required.**

The `GITHUB_TOKEN` exposure with `contents: write` is real, but it is the
intended mechanism for deploying to `gh-pages` from an approved action.  The
`persist-credentials: false` guard on the checkout step (see **GOOD** section)
limits the window in which those credentials are available to other steps.

---

## ~~HIGH~~ — `actions/checkout` wrong SHA — **fixed**

**File:** `.github/workflows/site-publish.yml` line 40

The original SHA `93cb6efe18208431cddfb8368fd83d5badbf9bfd` was annotated
`v5.0.1`, but `actions/checkout` v5 does not exist.  The SHA has been updated
to `de0fac2e4500dabe0009e67214ff5f5447ce83dd` (v6.0.2), the current stable
release.  `actions` is an implicitly approved organisation; no further action
required beyond keeping the SHA in sync with tags via Renovate/Dependabot.

---

## ~~MEDIUM~~ — Entire workspace parent directory mounted into build container — **fixed**

**File:** `site/Makefile`

The single `$(WORKSPACE_ROOT)` bind mount has been replaced with explicit
per-repo mounts.  The main `buildish` repo is mounted read-write (build outputs
are written back into it); each component repo is mounted read-only.  The
component directory list is derived from `catalog.yaml` at Makefile parse
time — no manual maintenance required as components are added or removed.
`localDir` entries that contain a `/` (pointing inside the main repo) are
filtered out automatically since they are already covered by the main-repo
mount.  A `$(error ...)` guard stops the build immediately if the YAML parse
fails.

```makefile
_component_local_dirs := $(shell python3 -c "\
import yaml; \
data = yaml.safe_load(open('$(CURDIR)/catalog.yaml')); \
dirs = [c['localDir'].split('/')[0] for c in data['components'] \
        if '/' not in c.get('localDir', '')]; \
print(' '.join(dirs))" 2>/dev/null)
$(if $(_component_local_dirs),,$(error Could not parse component dirs from $(CURDIR)/catalog.yaml))
CONTAINER_COMPONENT_MOUNTS = $(foreach d,$(_component_local_dirs),\
    -v $(WORKSPACE_ROOT)/$(d):/workspace/$(d):ro$(CONTAINER_MOUNT_LABEL))
CONTAINER_WORKSPACE_FLAGS = \
    -v $(REPO_ROOT):/workspace/$(REPO_NAME)$(CONTAINER_MOUNT_LABEL) \
    $(CONTAINER_COMPONENT_MOUNTS) \
    -w $(CONTAINER_SITE_ROOT)
```

Any sibling repo that is not listed in `catalog.yaml` is invisible to the
container.  The `:Z` SELinux label (applied on Podman via `CONTAINER_MOUNT_LABEL`)
is applied once per distinct host source path; there are no overlapping mounts
that would cause conflicting relabeling operations.

---

## ~~MEDIUM~~ — World-writable scratch directories on the host — **fixed**

**File:** `site/Makefile` (various `chmod` calls and detection block)

Both issues are now fixed:

* `chmod 0777` on scratch/per-run temp directories replaced with `chmod 0700`
  (private to the calling user, sufficient because `--user $(id -u):$(id -g)`
  already ensures the container process runs as the same UID).
* `chmod 0777` on output directories (`.stage`, `.preview`, `.public`,
  `resources/_gen`) replaced with `chmod 0755` (conventional for shared-read
  directories; world-write was never needed).
* `umask 000` removed from `CONTAINER_TEST_SCRIPT`,
  `CONTAINER_INTEGRATION_TEST_SCRIPT`, and `CONTAINER_PREPARE_SITE_ENV`.
* The Podman detection block replaced with a version-string probe that checks
  both executable basename and `--version` output, plus an explicit
  `CONTAINER_IS_PODMAN` override variable:

```makefile
_container_version    := $(shell $(CONTAINER_ENGINE) --version 2>/dev/null)
_container_name_match := $(filter podman,$(CONTAINER_ENGINE_BASENAME))
_container_ver_match  := $(findstring podman,$(_container_version))
CONTAINER_IS_PODMAN   ?= $(if $(or $(_container_name_match),$(_container_ver_match)),1,)
```

This correctly handles renamed/wrapped Podman binaries and the `podman-docker`
shim (whose `--version` still contains the word `podman`), while never
accidentally applying `--userns=keep-id` to Docker or other runtimes.

---

## ~~MEDIUM~~ — Full CI environment propagated to exec'd pipeline process — **fixed**

**File:** `site/pipeline/refresh_latest_snapshot.py`

`_managed_environment_vars` and `_sync_consumer_environment_if_needed` both
previously started from `os.environ.copy()`, which would pass every variable
in the caller's environment (including CI secrets) through to `site-pipeline`
and every subprocess it spawned.

Both call sites now use a new `_filtered_environment()` helper that builds from
an explicit allowlist instead.  Variables are included only if their name is in
`_ENV_PASSTHROUGH_EXACT` (an exact-match `frozenset`) or starts with one of the
prefixes in `_ENV_PASSTHROUGH_PREFIXES`:

| Exact names | Prefix groups |
|---|---|
| `HOME`, `LANG`, `PATH`, `SHELL`, `TERM` | `BUILDISH_` — state variables set by this script |
| `TMPDIR`, `TEMP`, `TMP` | `LC_` — locale category overrides |
| `SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE` | `PYTHON` — Python runtime settings |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `http_proxy`, `https_proxy`, `no_proxy` | `UV_` — uv configuration |
| | `XDG_` — XDG base directory spec |

This is a defence-in-depth measure.  A compromised dependency could still call
`os.environ` directly, but accidental leakage of CI tokens injected by the
runner or a prior workflow step is now prevented.

---

## ~~LOW~~ — Hugo module proxy set to `direct` — **fixed**

**File:** `site/hugo.yaml` line 91

Changed to the standard Go toolchain default:

```yaml
module:
  proxy: "https://proxy.golang.org,direct"
```

Hugo now fetches modules via the Go module mirror first and falls back to
direct only if the module is not cached there.  `go.sum` hash verification
is unaffected — a tampered module served by the proxy would still be rejected.
The `direct` fallback preserves availability if the proxy does not have a
module.

---

## ~~LOW~~ — Sidebar JavaScript interpolation without explicit `safeJS` — **fixed**

**File:** `site/layouts/partials/sidebar.html` line 88

`$mid` is now derived with `| safeJS` applied at the point of assignment:

```go-html-template
{{ $mid := printf "m-%s" (.RelPermalink | anchorize | safeJS) }}
```

All six subsequent interpolations of `{{ $mid }}` in the same `<script>` block
are covered by this single change.  No further action required.

---

## GOOD — `npm ci --ignore-scripts` prevents lifecycle-script attacks

**File:** `site/Makefile` line 177

```makefile
npm ci --ignore-scripts --prefix "$$node_root";
```

`--ignore-scripts` blocks `preinstall`, `install`, `postinstall`, and similar
lifecycle hooks from running during dependency installation.  This is the
single most effective protection against npm supply-chain attacks, where a
malicious package embeds code in lifecycle scripts.  The flag is consistently
applied in both containerised and local build paths.

---

## GOOD — `persist-credentials: false` on checkout

**File:** `.github/workflows/site-publish.yml` line 42

```yaml
persist-credentials: false
```

Git credentials are not written to disk after the checkout, preventing
subsequent steps (including the third-party `peaceiris` action) from silently
re-using them for unrelated operations.

---

## GOOD — Repository and branch guard on publish job

**File:** `.github/workflows/site-publish.yml` line 37

```yaml
if: github.repository == 'apache/buildish' && github.ref == 'refs/heads/main'
```

Publication is gated on both the canonical repository identity and the `main`
branch, even when the workflow is invoked via `workflow_call`.  This prevents
accidental publishing from forks or feature branches.

---

## GOOD — Wheel path boundary enforcement in snapshot loader

**File:** `site/pipeline/refresh_latest_snapshot.py` lines 281–290

```python
if not wheel_path.is_relative_to(snapshot_root):
    raise ValueError(
        f"Snapshot wheel must stay within {snapshot_root}, got {wheel_path}"
    )
```

The `latest.json` manifest is consumed by first resolving the wheel path to an
absolute path and then asserting it stays within the expected snapshot root.
Path traversal attempts (e.g. `wheelPath: "../../evil.whl"`) are rejected even
if they point to an existing file outside the snapshot directory.

---

## GOOD — Third-party JavaScript served locally, no CDN loading

**Files:** `site/layouts/partials/head.html`, `site/layouts/partials/scripts/mermaid.html`

jQuery, Mermaid, and Lunr are all loaded from `/js/vendor/` (vendored into the
build output) rather than from a public CDN.  plantuml and markmap are
explicitly disabled because they would load external JavaScript, which is
consistent with the ASF website data policy.

---

## GOOD — Hugo Goldmark renderer with `unsafe: false`

**File:** `site/hugo.yaml` line 61

```yaml
renderer:
  unsafe: false
```

Raw HTML embedded in Markdown source files is stripped by Hugo before
rendering.  This prevents contributors from accidentally (or intentionally)
injecting arbitrary HTML, including `<script>` tags, through content files.

---

## GOOD — `package-lock.json` with integrity hashes (lockfileVersion 3)

**File:** `site/package-lock.json`

The lock file uses npm lockfile v3 format, which records a `integrity`
SHA-512 digest for every package.  `npm ci` verifies these digests before
installation, making it infeasible to substitute a different package payload
at the same registry coordinate without detection.

---

## GOOD — uv lockfile with per-package SHA-256 hashes

**File:** `site/pipeline/uv.lock`

All Python packages (including `mypy`, `ruff`, and their transitive
dependencies) are pinned with explicit `hash = "sha256:..."` entries.  `uv
sync --frozen` verifies these hashes before installing, equivalent protection
to npm's integrity fields.

---

## GOOD — `container-npx` intercept prevents `npx` package downloads

**File:** `site/scripts/container-npx`

The custom `npx` wrapper strips `--no-install` / `-y` flags and resolves
`postcss` to the locally-installed binary, preventing Hugo from invoking the
real `npx` to download packages on demand during the build.  The real `npx` is
only invoked as a fallback for unrecognised commands, and only if it is present
in `PATH`.

