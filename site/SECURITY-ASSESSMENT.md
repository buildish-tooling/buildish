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

## MEDIUM — Entire workspace parent directory mounted into build container

**File:** `site/Makefile` lines 83–85

```makefile
CONTAINER_WORKSPACE_FLAGS = \
    -v $(WORKSPACE_ROOT):/workspace$(CONTAINER_MOUNT_LABEL) \
    -w $(CONTAINER_SITE_ROOT)
```

`WORKSPACE_ROOT` is the *parent* of the repository root, so every sibling
repository checked out alongside `buildish` is also mounted inside the
container.  Any code executing inside the container (the site-pipeline binary,
Hugo) can read and potentially write all of those sibling repositories.

`npm ci --ignore-scripts` (see **GOOD** section below) significantly mitigates
the npm risk.  The site-pipeline binary is installed from a hash-locked wheel,
which limits that surface.  Hugo is fetched from the container image.  The
residual risk is the transitive dependency graph of those tools writing to or
exfiltrating sibling repos that happen to be present in the workspace.

**Context:** The broad mount exists because the build genuinely requires the
main `buildish` repo and three specific sibling repos enumerated in
`site/components.yaml`: `buildish-mammoth-cache`, `buildish-no-gradle-wrapper-jar`,
and `buildish-site-pipeline`.  Any additional repos that happen to sit adjacent
in the developer's workspace are incidental.

**Options (from least to most invasive):**

1. **Document and rely on existing controls (lowest effort).**  The primary
   mitigations already in place — SHA-pinned container images, hash-locked npm
   and Python dependencies, `--ignore-scripts` — make it very hard for build
   tooling to act maliciously even when it can see sibling repos.  Add a comment
   in the Makefile documenting the scope of the mount and the rationale.

2. **Mount explicit per-repo bind mounts derived from `components.yaml`
   (recommended).**  Replace the single `$(WORKSPACE_ROOT)` bind mount with
   individual mounts: read-write for `buildish` (build outputs are written back
   into it), and `:ro` (read-only) for each component repo.  Derive the list
   from `components.yaml` at Makefile parse time so it never goes out of sync,
   filtering out entries with a `/` in `localDir` (those point inside the main
   repo and are already covered by its mount):

   ```makefile
   _component_local_dirs := $(shell python3 -c "\
   import yaml, sys; \
   data = yaml.safe_load(open('$(CURDIR)/components.yaml')); \
   dirs = [c['localDir'].split('/')[0] for c in data['components'] \
           if '/' not in c.get('localDir','')]; \
   print(' '.join(dirs))")
   $(if $(_component_local_dirs),,$(error Failed to parse components.yaml))
   CONTAINER_COMPONENT_MOUNTS = $(foreach d,$(_component_local_dirs),\
       -v $(WORKSPACE_ROOT)/$(d):/workspace/$(d):ro$(CONTAINER_MOUNT_LABEL))
   CONTAINER_WORKSPACE_FLAGS = \
       -v $(REPO_ROOT):/workspace/$(REPO_NAME)$(CONTAINER_MOUNT_LABEL) \
       $(CONTAINER_COMPONENT_MOUNTS) \
       -w $(CONTAINER_SITE_ROOT)
   ```

   Only the declared component repos (plus the main repo) are exposed; any other
   repo in the workspace is invisible to the container.  Component repos are
   read-only so build tooling cannot accidentally corrupt them.  Scales to any
   number of components without manual maintenance.

   > **Note — why not "mount workspace read-only + main repo read-write on top":**
   > That pattern (`-v $(WORKSPACE_ROOT):/workspace:ro:Z -v $(REPO_ROOT):/workspace/$(REPO_NAME):Z`)
   > looks attractive at first but is unreliable.  The `:Z` SELinux relabeling
   > flag operates on the host source directory; applying it to two overlapping
   > paths (parent read-only, child read-write) produces conflicting relabeling
   > operations that are not guaranteed to be stable across Podman versions.
   > Even without SELinux, the read-only propagation behaviour of overlapping
   > bind mounts has known edge cases.  Explicit, non-overlapping per-repo
   > mounts avoid the problem entirely.

3. **Add `--cap-drop=ALL --security-opt=no-new-privileges` to container runs.**
   Even with the broad mount, removing all Linux capabilities and preventing
   privilege escalation limits what a compromised process inside the container
   could do with the visible filesystem.  This is complementary to option 2, not
   a substitute.  Note: some tools may require specific capabilities; test
   carefully.

---

## MEDIUM — World-writable scratch directories on the host

**File:** `site/Makefile` lines 69–75, 128–130, 132–145 (various `chmod 0777` calls)

```makefile
chmod 0777 '$(HOST_CONTAINER_SCRATCH_ROOT)'   # host-side root scratch dir
chmod 0777 "$$scratch"                         # per-run temp dir inside container
chmod 0777 .stage .preview .public resources/_gen
```

Using `0777` makes every scratch and output directory world-writable.  On a
shared machine (CI agent pool, multi-user workstation) another local user could
replace files between when they are created and when they are consumed, i.e., a
local TOCTOU / cache-poisoning attack on npm modules or uv venv artefacts.

**Engine detection fragility — the deeper issue:**

The Makefile detects Podman vs Docker by comparing the basename of
`CONTAINER_ENGINE` against the literal string `podman`:

```makefile
CONTAINER_ENGINE_BASENAME := $(notdir $(CONTAINER_ENGINE))
ifeq ($(CONTAINER_ENGINE_BASENAME),podman)
CONTAINER_USERNS_FLAGS := --userns=keep-id
endif
```

`--userns=keep-id` is a Podman-specific flag; passing it to Docker causes an
error.  The current detection fails if:

* The user has Docker named `podman` (e.g. via `podman-docker` shim in reverse)
* The user has Podman installed under a non-standard name (e.g. `podman-remote`,
  `/opt/podman/bin/podman4`)
* `CONTAINER_ENGINE` is set to a full path like `/usr/bin/podman` — this
  actually works correctly since `$(notdir ...)` strips the path, but it is
  worth noting it relies on the final path component.

**Why `0777` was chosen and why it may not be necessary:**

Both Docker and rootless Podman are invoked with `--user $(id -u):$(id -g)`,
so the container process runs as the same UID/GID as the calling user.
Scratch directories created on the host (or visible to the container via the
volume mount) and owned by the calling user are fully accessible to the
container process at mode `0700` — no world-write permission is needed.

The `umask 000` + `chmod 0777` pattern inside the container scripts appears to
be a historical carry-over from a time when user-namespace mapping was not yet
consistent.  With `--userns=keep-id` (Podman) or `--user uid:gid` (Docker) both
consistently mapping to the host user, the directories simply need to be
writable by that UID.

**Recommended options:**

1. **Replace `chmod 0777` with `chmod 0700` on scratch dirs (recommended).**
   Since `--user $(id -u):$(id -g)` is applied uniformly, the container process
   owns the scratch directories and `0700` is sufficient.  The output directories
   (`.stage`, `.preview`, `.public`, `resources/_gen`) can use `0755` (readable
   by group/others, conventional for directories) if that is useful for
   downstream processes reading them on the host; `0700` works too.  Drop the
   `umask 000` calls at the same time; they are not needed.

2. **Make the Podman/Docker detection robust with a version-string probe and
   allow explicit override.**  Instead of matching only the binary basename,
   also check the `--version` output, and let the user hard-override the flag:

   ```makefile
   # Auto-detect: check both binary name and --version output for the word "podman".
   # Override with: make CONTAINER_IS_PODMAN=1  or  make CONTAINER_IS_PODMAN=0
   _container_version := $(shell $(CONTAINER_ENGINE) --version 2>/dev/null)
   _container_name_match := $(filter podman,$(CONTAINER_ENGINE_BASENAME))
   _container_ver_match  := $(findstring podman,$(_container_version))
   CONTAINER_IS_PODMAN ?= $(if $(or $(_container_name_match),$(_container_ver_match)),1,)

   CONTAINER_MOUNT_LABEL  :=
   CONTAINER_USERNS_FLAGS :=
   ifneq ($(CONTAINER_IS_PODMAN),)
   CONTAINER_MOUNT_LABEL  := :Z
   CONTAINER_USERNS_FLAGS := --userns=keep-id
   endif
   ```

   This correctly handles: full-path Podman binaries, the `podman-docker` shim
   (which prints `podman` in `--version`), and Docker named `docker` (whose
   `--version` output contains `Docker` not `podman`).  It also gives operators
   a clean escape hatch (`CONTAINER_IS_PODMAN=0` or `=1`) without editing the
   Makefile.

   Note: the `$(shell ...)` call runs at Make parse time on every invocation.
   If startup latency is a concern, the result can be cached via a stamp file or
   the probe can be moved into a recipe.

---

## MEDIUM — Full CI environment propagated to exec'd pipeline process

**File:** `site/pipeline/refresh_latest_snapshot.py` lines 131, 393–403

```python
os.execvpe(command[0], list(command), env)   # env = os.environ.copy() + additions
```

The managed environment includes every variable inherited from the caller, not
just those required by the pipeline.  In CI contexts this means any secrets
present in the runner environment (e.g. tokens set by earlier steps or the
organisation's secret injection mechanism) are transparently passed through to
the `site-pipeline` process and everything it spawns.

**Recommended fix:** Build the environment from a minimal explicit allowlist
(PATH, HOME, UV\_\*, VIRTUAL\_ENV, BUILDISH\_\*, plus any other variables the
pipeline genuinely needs) instead of starting from `os.environ.copy()`.  This
is a defence-in-depth measure; it does not prevent a compromised dependency
from calling `os.environ` itself, but it limits accidental leakage.

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

