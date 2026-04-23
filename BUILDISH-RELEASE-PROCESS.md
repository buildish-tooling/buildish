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

# Buildish Release Process

This draft defines the Buildish-wide release architecture for components that use Git repositories
and GitHub workflows while remaining inside ASF release policy.

The policy boundary is:

- the official ASF release is the signed source release published through Apache distribution
  infrastructure
- everything else is a secondary artifact published only after that source release is approved and
  live

Some components may also stage or publish secondary artifacts through ASF SVN. That must be treated
as a transport and distribution detail only. It does not make those artifacts the official ASF
release unless they are the voted source release itself.

## Release branches

Buildish release lines should use dedicated release branches. The standard names are:

- `release/1.x`
- `release/1.2.x`

Those branches are maintenance lines for source history only. Release-only generated content must
not be merged into them.

Release branches should be created only by the `Create release branch` workflow backed by shared
release tooling, not by ad hoc manual Git commands.

## Detached materialization commits

Some components need generated convenience-artifact payloads that are intentionally git-ignored in
normal branch history, for example runnable `dist/` content for GitHub Actions.

Those components may use a detached materialization commit model:

- start from the resolved release-branch source commit
- build the generated release payload in a detached worktree or equivalent isolated Git state
- create a detached commit that adds only the release-materialized payload and related legal files
- keep that detached commit out of `release/<line>` history

In that model:

- the voted ASF source release is still built from the release-branch source commit
- the RC Git tag may point at the detached materialization commit instead of the branch commit
- the final exact Git tag should normally point at the same detached commit as the released RC tag
- moving aliases, if any, move only after the final exact tag is live

This rule is component-specific policy, not the default for all Buildish components. Components that
do not need generated release-only Git content should tag the plain source commit directly.

## Implementation model

GitHub workflow YAML should stay thin. The shared release orchestration should live in a separately
versioned Buildish component, `buildish-release-tooling/`, while each consuming
component keeps only a thin bash dispatcher for local and workflow entrypoints.

That model keeps:

- local trusted verification simple on Linux and macOS
- the shared implementation unit-testable and integration-testable
- workflow jobs retryable because the orchestration surface is a stable CLI

The current layout uses:

- shared release tooling component under `buildish-release-tooling/`
- production Python sources under
  `buildish-release-tooling/src/apache_buildish_release_tooling/`
- tooling unit and integration tests under `buildish-release-tooling/tests/`
- per-component policy in each component repository's
  `buildish-release-tooling/release-config.yaml`
- per-component bash dispatchers under each component repository's
  `buildish-release-tooling/release-tooling.sh`
- per-component workflows under each component repository's `.github/workflows/`

The shared Python test suite in `buildish-release-tooling` owns the deeper shared release-state and
CLI integration coverage. It currently uses checked-in fixture components plus temporary Git and SVN
sandboxes under the repository-local ignored `build/` tree. The real component repositories should
add their own component-level integration coverage on top of that shared suite.

### Shared tooling component

`buildish-release-tooling` is intended to be released as its own Buildish component and consumed by
other Buildish repositories at an exact immutable Git ref.

The consumption model is:

- the consumer workflow checks out an exact pinned tooling ref
- the consumer wrapper runs `uv run --project <tooling-checkout> --frozen`
- the component policy is loaded from `buildish-release-tooling/release-config.yaml`
- the YAML config is validated by structured Python models before any release action runs

`uvx` can be supported for ad hoc local use, but the release-critical path should stay on a pinned
source checkout, not on a package index.

The current draft uses `pydantic` for typed release/config models and `pyyaml` for the component
YAML files.

The shared tooling logs the external release-tool commands it executes, especially `git`, `svn`,
and `gpg`, including their effective command-line options. That logging must redact credentials and
secret material before it reaches workflow logs.

The component wrappers and the shared tooling should assume they are launched from inside the target
component repository's Git worktree. They should not accept synthetic branch/tag state through
environment variables. In GitHub Actions, the workflow must therefore do a real checkout and fetch
remote heads plus tags before it invokes the wrappers.

### Git machinery abstraction

The draft treats Git as its own shared subsystem rather than scattering raw `git` command sequences
throughout each component workflow.

The shared Git layer lives under:

- `buildish-release-tooling/src/apache_buildish_release_tooling/git_repo.py`

It is responsible for operations such as:

- resolving the current worktree root
- listing local and remote-tracking release branches
- listing tags
- resolving refs to commits
- creating release branches
- creating annotated tags
- deriving RC state from a real repository

The component wrappers consume that shared layer through the `buildish-release-tooling` CLI rather
than embedding Git behavior directly.

### Git test model

The draft uses two levels of Git testing:

- unit tests for the Git abstraction
- integration tests that create a real temporary origin/clone pair and exercise tags and branches

Those integration sandboxes are intentionally created under the repository-local ignored `build/`
tree, not under `/tmp`, so they stay contained within the project workspace and do not pollute the
global temp directory.

### GitHub-check gate abstraction

The draft treats the source-ref GitHub check gate as shared release logic as well.

The shared gate layer lives under:

- `buildish-release-tooling/src/apache_buildish_release_tooling/github_checks.py`

It is responsible for:

- resolving the repository slug
- fetching check runs and legacy status contexts for a commit
- enforcing the rule that only `success` and `skipped` conclusions are acceptable for release
  gating
- enforcing the optional rule that at least one check must exist when release-branch CI is required

That gate is consumed through the shared CLI so every component uses the same pass/fail policy.

### Source-artifact abstraction

The draft also treats source-archive creation, signing, manifest generation, and summary rendering
as shared subsystems.

The shared layers live under:

- `buildish-release-tooling/src/apache_buildish_release_tooling/prepare_rc_state.py`
- `buildish-release-tooling/src/apache_buildish_release_tooling/source_artifact.py`
- `buildish-release-tooling/src/apache_buildish_release_tooling/gpg_signing.py`
- `buildish-release-tooling/src/apache_buildish_release_tooling/manifest.py`
- `buildish-release-tooling/src/apache_buildish_release_tooling/summary.py`

They are responsible for:

- resolving the exact `Prepare RC` source commit and RC metadata
- deriving the canonical source artifact filename and top-level archive prefix
- building a reproducible tar.gz from Git with a fixed mtime and stable gzip options
- computing the SHA512 checksum used in summaries and later signing/staging steps
- writing the `.sha512` sidecar file
- importing the ASF-managed CI signing key from `BUILDISH_GPG_PRIVATE_KEY`
- creating the detached ASCII-armored source signature with `gpg`
- writing release manifests and GitHub Summary content

The draft assumes `gpg` is available on the GitHub runner used for source RC preparation.

### ASF SVN machinery abstraction

The draft also treats ASF SVN as its own shared abstraction layer rather than scattering raw `svn`
commands throughout workflows and release scripts.

The shared SVN layer lives under:

- `buildish-release-tooling/src/apache_buildish_release_tooling/asf_svn.py`

It is responsible for operations such as:

- joining and normalizing SVN URLs
- resolving the root of an SVN working copy
- checking out a detached working copy
- listing entries from an SVN URL or working copy path
- creating directories in the repository by URL
- copying staged directories from `dist/dev` to `dist/release`
- deleting stale RC directories and older release directories by URL
- staging files into a detached working copy and committing them

The shared SVN layer accepts credentials from:

- `BUILDISH_SVN_DEV_USERNAME`
- `BUILDISH_SVN_DEV_PASSWORD`

Those credentials should be used only for ASF `dist/dev` and `dist/release` operations and must
never be echoed into logs.

That shared layer is intentionally generic enough to support:

- the required source-release flows in ASF SVN
- optional future component-specific secondary artifacts that may also need to live in ASF SVN

The official release rules do not change when secondary artifacts also use ASF SVN. The voted source
release remains the authoritative ASF release artifact.

### ASF SVN test model

The draft uses two levels of SVN testing:

- unit tests for the SVN abstraction
- integration tests that create a real detached local SVN repository with `svnadmin` plus a working
  copy under the repository-local ignored `build/` tree

Those SVN integration sandboxes use the same local `build/` isolation model as the Git tests.

## Standard workflows

### 1. `Create release branch`

Inputs:

- `release_line`
- `source_ref`

Purpose:

- create `release/<release_line>` from a known source ref

### 2. `Prepare RC`

Inputs:

- exact `version`, for example `1.2.3`
- optional `source_sha`

Source resolution rules:

- if `source_sha` is present, use it directly
- otherwise try the matching release branches from most specific to least specific
- for `1.2.3`, first try `release/1.2.x`, then `release/1.x`

RC-number rules:

- derive the next RC number from the highest existing RC number for the exact version
- if no RC exists yet for the version, use `rc0`

Source-ref gate rules:

- the workflow must hard-fail unless every GitHub check on the resolved source commit has either
  passed or been skipped
- if `RELEASE_BRANCH_CI_REQUIRED=true`, the gate must also fail when the resolved source commit has
  no GitHub checks at all

Component CI policy:

- every component must satisfy at least one of these policies:
  - `PREPARE_RC_RUNS_TESTS=true`
  - `RELEASE_BRANCH_CI_REQUIRED=true`
- components may skip test execution inside the `Prepare RC` workflow only when they rely on CI that
  runs on `release/*` branches and the source-ref gate validates those checks
- components that do not rely on release-branch CI must run their test suite from the `Prepare RC`
  workflow itself

Expected behavior:

1. resolve the source commit
2. hard-gate the workflow on the GitHub checks for that exact source commit
3. determine the RC number
4. clean pre-existing RC staging directories for that component and version in ASF SVN
5. build the reproducible source release candidate, write its `.sha512`, sign it with the
   ASF-managed CI key, and stage the source RC into ASF SVN
6. build any staged secondary artifacts
7. create the RC tag
   - by default, tag the resolved source commit directly
   - for components using detached materialization commits, create the detached commit outside
     `release/<line>` history and tag that detached commit instead
8. create or re-create the corresponding draft GitHub Release metadata for the final version
9. emit GitHub Summary sections with fenced plain-text blocks for:
   - Buildish dev-list vote subject/body
   - Incubator approval subject/body
   - result-mail subject/body
   - source artifact SHA512 lines
   - source artifact detached ASCII-armored signatures
   - verification commands and URLs

The GitHub draft release stays draft-only during the RC phase.

In this draft, the source-artifact build, `.sha512` generation, detached ASCII-armored signing, and
ASF SVN staging are intentionally unified into a single idempotent `build-source-rc` job. That job
should stay cheap enough to rerun, which keeps the workflow simpler while still allowing other
publication jobs to remain independently retryable.

The source archive should be produced reproducibly from Git using:

```bash
git archive \
  --prefix="${archive_root}/" \
  --format=tar \
  --mtime="1980-02-01 00:00:00 UTC" \
  "${source_commit}" \
  | gzip -6 --no-name > "${source_artifact_path}"
```

The `archive_root` should match the source artifact filename without the `.tar.gz` suffix, for
example `apache-buildish-example-1.2.3-incubating-src/`.

If a component later needs RC-phase secondary artifacts in ASF SVN, those should use the same shared
SVN layer and should remain isolated in dedicated retryable jobs and dedicated component paths.

### 3. `Release version`

Inputs:

- exact `version`, for example `1.2.3`

Expected behavior:

1. resolve the selected RC for the version from the exact-version draft GitHub Release
   - this resolution step must emit the selected RC tag as structured workflow output
   - later RC-sensitive jobs in the same workflow must carry that exact selected RC tag forward
   - those later jobs must fail if the draft GitHub Release drifted to a different RC after the
     initial resolution step
2. publish the official source release to Apache `dist/release`
3. prune older releases from the same release line out of Apache `dist/release`
4. create the final exact tag
   - by default, point it at the same commit as the released RC tag
   - for components using detached materialization commits, reuse the detached commit already tagged
     by the released RC instead of creating a second release-only commit
5. publish each secondary artifact target in its own retryable job
6. remove any RC-only draft GitHub Release assets that must not appear in the final public release,
   especially mirrored `rc-vote-manifest.json`, `rc-vote-manifest.json.asc`, and
   `rc-vote-manifest.json.sha512`
7. finalize the corresponding draft GitHub Release
8. update moving aliases where the target type allows them
9. emit GitHub Summary sections with fenced plain-text blocks for:
   - source artifact SHA512 lines
   - source artifact detached ASCII-armored signatures
   - archived same-line releases
   - final artifact URLs

Pruning old releases from `dist/release` is the ASF-correct way to make them disappear from
`downloads.apache.org` while they remain available via `archive.apache.org`.

For components using detached materialization commits, the release workflow must treat the released
RC tag as the source of truth for the final tag target, not recalculate a new detached commit during
the finalization path.

If a component later publishes secondary artifacts to ASF SVN as well, those jobs should also use
the shared SVN abstraction and remain separate from source-release publication and pruning jobs.

For most components, the final exact tag should point at the same Git commit as the released RC.
Components that need release-materialized Git content may instead use a detached final commit that
must not enter release-branch history.

Moving aliases should be configured by policy flags, not by listing the concrete tag names in
component config:

- `MOVING_TAGS_ENABLED=true|false`
- `LATEST_TAG_ENABLED=true|false`

The concrete version aliases can be derived from the final version string and target family:

- GitHub Actions from `1.2.3` -> `v1`, `v1.2`
- container images from `1.2.3` -> `1`, `1.2`

`latest` should not be derived mechanically from the version string. It is a policy alias for the
current default stable line, so it should remain a separate opt-in flag and should default to
`false` unless the project explicitly wants that behavior.

Moving-alias updates must also obey a no-backward-move rule:

- exact tags remain immutable
- line-specific aliases may move only within their own line, for example `v1.2` may move from
  `1.2.2` to `1.2.3`
- broader aliases such as `v1` or `latest` must not move backward to an older release than the one
  they already reference

Example:

- if `1.3.4` is released first and moves `v1` to `1.3.4`
- then a later release of `1.2.3` may still move `v1.2` to `1.2.3`
- but it must not move `v1` away from `1.3.4`

The `Release version` workflow should therefore resolve the current target of each moving alias and
only update that alias when the new release is newer within that alias's scope.

For container images, the shared release tooling should support both:

- plan-time alias derivation for component workflows and summaries
- actual Docker Hub alias publication after the exact image has already been pushed

That Docker Hub alias publication should operate at the registry level from the already-pushed
exact image reference, so one shared command path can work for both single-platform images and
multi-platform images.

### 4. `Verify RC`

This may be exposed as a manual GitHub workflow, but the authoritative use case is local execution
on trusted and owned hardware using a bash script that works on Linux and macOS.

The verification script should:

- accept the authoritative RC vote-manifest URL directly, for example
  `./verify-rc https://dist.apache.org/repos/dist/dev/incubator/buildish/buildish-example/1.2.3-rc2/rc-vote-manifest.json`
- optionally also accept a local `rc-vote-manifest.json` path for offline or partially cached
  verification
- fetch the KEYS file identified by the manifest trust-root metadata
- cut the fetched KEYS file to the manifest's recorded known length
- verify the SHA512 of that known-length KEYS prefix
- use only that verified KEYS prefix for manifest and artifact signature validation
- fetch the RC vote manifest first
- verify the RC vote manifest `.sha512`
- verify the RC vote manifest `.asc`
- download the staged RC
- verify `.sha512`
- verify `.asc`
- rebuild the source release
- rebuild any secondary artifacts under vote
- compare staged and rebuilt outputs
- emit a compact summary suitable for a vote reply

## Manifest semantics

Buildish should treat release manifests as machine-readable transport, audit, and validation
artifacts, not as the sole source of truth for release-critical decisions.

The authoritative state remains the live external state in:

- Git refs and tags
- ASF SVN staging and release paths
- GitHub Releases and attached assets

That means:

- workflow jobs and later workflows may consume a manifest when it is available
- later jobs must still revalidate the key facts they rely on against Git, ASF SVN, or GitHub
- reruns and retries must remain possible even when a prior manifest is unavailable

Within one job, a manifest file in the checked-out workspace is sufficient.

Across jobs in one workflow:

- small scalar values may be promoted through job outputs
- richer structured state may be persisted as a workflow artifact

Across separate workflow runs, a workflow artifact is not sufficient as the primary handoff
mechanism. The preferred persistence locations are:

- the authoritative RC staging area in ASF SVN `dist/dev`
- optionally the corresponding draft GitHub Release as a mirrored convenience copy

If the RC vote manifest is mirrored to the draft GitHub Release during RC preparation, that mirror
must be removed before the draft release is finalized and published as the final public GitHub
Release.

The human-readable vote email content and the machine-readable vote manifest should be generated
from the same resolved RC state.

## RC vote manifest

Buildish should define a machine-readable RC inventory artifact, `rc-vote-manifest.json`, that
describes exactly what the RC vote covers.

Its purpose is to give `Verify RC` and similar tooling a technically precise input that can be
authenticated and checked without scraping GitHub Summary content or email text.

The intended user-facing verification UX should be simple enough that a contributor can start RC
verification from one authoritative manifest URL, for example:

```bash
./verify-rc https://dist.apache.org/repos/dist/dev/incubator/buildish/buildish-example/1.2.3-rc2/rc-vote-manifest.json
```

That verifier should then use the signed RC vote manifest as its machine-readable inventory for the
rest of the verification flow.

The RC vote manifest should:

- identify the exact source state and release-policy context for the RC
- include audit and provenance metadata about when and how the RC inventory was produced
- include trust-root metadata for the exact KEYS snapshot that verification should use
- list every artifact that is under vote for that RC
- include the locations and digests needed for automated verification
- include per-artifact provenance when an artifact derives from a commit other than the top-level
  source commit
- be staged in ASF SVN `dist/dev` beside the voted source artifact
- have its own `.sha512` and detached ASCII-armored `.asc`
- optionally be mirrored unchanged to the corresponding draft GitHub Release during the RC phase
- be removed from the draft GitHub Release before that release is finalized and published as the
  final public GitHub Release

Because `Verify RC` may use this file as a machine-readable source of the voted inventory, the RC
vote manifest itself should be signed. That signature does not replace artifact verification; it
authenticates the inventory document that describes what was staged for vote.

The RC vote manifest should include secondary artifacts only when those artifacts already exist at
RC time and are explicitly part of the voted RC. Secondary artifacts that are created only after the
ASF vote passes must not be listed as RC-voted artifacts.

Derived moving aliases should not be recorded in the RC vote manifest as committed release outcomes.
Actual moving-tag changes belong to final release publication state, not to the voted RC inventory.

The release flow should distinguish between:

- `rc-vote-manifest.json`, which describes the exact RC inventory under vote
- a future final publication manifest, which may later describe what was actually published after
  the vote passed, including actual moving-alias updates and per-target publication results

### Proposed `rc-vote-manifest.json` schema

This is a proposal for iteration, not yet a frozen schema:

```json
{
  "schema_version": "1",
  "manifest_type": "rc-vote",
  "component_id": "buildish-example",
  "version": "1.2.3",
  "release_line": "1.2.x",
  "release_branch": "release/1.2.x",
  "source_commit_sha": "0123456789abcdef0123456789abcdef01234567",
  "materialized_commit_sha": "89abcdef0123456789abcdef0123456789abcdef",
  "rc_tag": "v1.2.3-rc2",
  "final_tag": "v1.2.3",
  "final_tag_mode": "detached-materialization-commit",
  "provenance": {
    "created_at": "2026-04-23T10:15:30Z",
    "github": {
      "repository": "apache/buildish-example",
      "workflow": "Releasey Prepare RC",
      "workflow_ref": "apache/buildish-example/.github/workflows/releasey-20-prepare-rc.yml@refs/heads/main",
      "run_id": 123456789,
      "run_attempt": 2,
      "run_url": "https://github.com/apache/buildish-example/actions/runs/123456789"
    },
    "tooling": {
      "repository": "apache/buildish-release-tooling",
      "repository_url": "https://github.com/apache/buildish-release-tooling",
      "git_ref": "refs/tags/v0.4.0",
      "git_commit_sha": "fedcba9876543210fedcba9876543210fedcba98",
      "version": "0.4.0"
    }
  },
  "trust_roots": {
    "asf_keys": {
      "uri": "https://downloads.apache.org/incubator/buildish/KEYS",
      "known_length_bytes": 12345,
      "known_prefix_sha512": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  },
  "draft_github_release": {
    "repository": "apache/buildish-example",
    "tag": "v1.2.3",
    "url": "https://github.com/apache/buildish-example/releases/tag/v1.2.3"
  },
  "vote_materials": {
    "source_artifacts": [
      {
        "role": "asf-source-release",
        "filename": "apache-buildish-example-1.2.3-incubating-src.tar.gz",
        "uri": "https://dist.apache.org/repos/dist/dev/incubator/buildish/buildish-example/1.2.3-rc2/apache-buildish-example-1.2.3-incubating-src.tar.gz",
        "artifact_origin": "source-commit",
        "git_commit_sha": "0123456789abcdef0123456789abcdef01234567",
        "checksums": {
          "sha512": {
            "value": "abc123",
            "uri": "https://dist.apache.org/repos/dist/dev/incubator/buildish/buildish-example/1.2.3-rc2/apache-buildish-example-1.2.3-incubating-src.tar.gz.sha512"
          }
        },
        "signatures": [
          {
            "type": "openpgp-detached-ascii-armored",
            "uri": "https://dist.apache.org/repos/dist/dev/incubator/buildish/buildish-example/1.2.3-rc2/apache-buildish-example-1.2.3-incubating-src.tar.gz.asc"
          }
        ]
      }
    ],
    "secondary_artifacts": [
      {
        "target_family": "github-action",
        "role": "convenience-artifact-under-vote",
        "filename": "buildish-example-action-dist.zip",
        "uri": "https://github.com/apache/buildish-example/releases/download/v1.2.3/buildish-example-action-dist.zip",
        "artifact_origin": "materialized-commit",
        "git_commit_sha": "89abcdef0123456789abcdef0123456789abcdef",
        "checksums": {
          "sha512": {
            "value": "def456",
            "uri": "https://github.com/apache/buildish-example/releases/download/v1.2.3/buildish-example-action-dist.zip.sha512"
          }
        },
        "signatures": [
          {
            "type": "openpgp-detached-ascii-armored",
            "uri": "https://github.com/apache/buildish-example/releases/download/v1.2.3/buildish-example-action-dist.zip.asc"
          }
        ]
      }
    ]
  },
  "verification": {
    "staging_svn_url": "https://dist.apache.org/repos/dist/dev/incubator/buildish/buildish-example/1.2.3-rc2/",
    "authoritative_manifest": {
      "uri": "https://dist.apache.org/repos/dist/dev/incubator/buildish/buildish-example/1.2.3-rc2/rc-vote-manifest.json",
      "checksum_uris": {
        "sha512": "https://dist.apache.org/repos/dist/dev/incubator/buildish/buildish-example/1.2.3-rc2/rc-vote-manifest.json.sha512"
      },
      "signatures": [
        {
          "type": "openpgp-detached-ascii-armored",
          "uri": "https://dist.apache.org/repos/dist/dev/incubator/buildish/buildish-example/1.2.3-rc2/rc-vote-manifest.json.asc"
        }
      ]
    }
  },
  "mirrors": {
    "draft_github_release_assets": [
      {
        "filename": "rc-vote-manifest.json",
        "url": "https://github.com/apache/buildish-example/releases/download/v1.2.3/rc-vote-manifest.json",
        "draft_only": true,
        "remove_before_final_release": true
      },
      {
        "filename": "rc-vote-manifest.json.asc",
        "url": "https://github.com/apache/buildish-example/releases/download/v1.2.3/rc-vote-manifest.json.asc",
        "draft_only": true,
        "remove_before_final_release": true
      },
      {
        "filename": "rc-vote-manifest.json.sha512",
        "url": "https://github.com/apache/buildish-example/releases/download/v1.2.3/rc-vote-manifest.json.sha512",
        "draft_only": true,
        "remove_before_final_release": true
      }
    ]
  }
}
```

Notes on the proposed fields:

- `materialized_commit_sha` should be omitted or set to `null` for components that tag the plain
  source commit directly
- the `provenance.created_at` timestamp should be recorded in UTC
- the `provenance.github` block should identify the workflow run that created the manifest
- the `provenance.tooling` block should identify the exact Buildish release-tooling revision that
  generated the manifest; `schema_version` does not replace tooling provenance
- the `provenance.tooling.repository` and `provenance.tooling.repository_url` fields should
  identify the tooling source repository
- the `provenance.tooling.git_commit_sha` field should be treated as the authoritative tooling
  identity
- the `provenance.tooling.git_ref` field should be included when available, whether it is a tag or
  a branch ref
- the `provenance.tooling.version` field should be optional and should be present only when the
  tooling run can be associated with a meaningful released version
- self-release of `buildish-release-tooling` from a branch is valid; in that case the tooling
  provenance may contain a branch `git_ref` and omit `version`
- the `trust_roots.asf_keys` block should identify the KEYS document used for signature
  verification, together with the known byte length and SHA512 of the trusted prefix that existed
  when the RC was created
- a verifier may therefore download the current KEYS file, truncate it to
  `trust_roots.asf_keys.known_length_bytes`, verify `trust_roots.asf_keys.known_prefix_sha512`,
  and use only that verified prefix so that later appended public keys do not change the RC trust
  root
- `source_artifacts` should usually contain exactly the authoritative ASF source release
- `secondary_artifacts` should be empty when no convenience artifacts are part of the RC vote
- `checksums` and `signatures` nested objects are the preferred shape for artifact integrity and
  signature metadata
- `artifact_origin` and `git_commit_sha` should be present when an artifact derives from a commit
  other than the top-level `source_commit_sha`; components using detached materialization commits
  should populate those fields for voted convenience artifacts and may populate them for all voted
  artifacts for clarity
- the `verification.authoritative_manifest` object should always point at the authoritative ASF SVN
  `dist/dev` copy of the RC vote manifest and its sidecars
- the `mirrors` object should be omitted when there is no mirrored draft GitHub Release copy
- any mirrored draft GitHub Release copy of the RC vote manifest is draft-phase convenience
  metadata only and must be removed before final GitHub Release publication
- target-family-specific secondary-artifact fields can be added later in backward-compatible schema
  extensions, for example Maven coordinates or container-image digests
- moving aliases should not be listed here as final outcomes; if any future schema adds advisory
  derived aliases for operator convenience, those must remain clearly non-authoritative
- each listed artifact should include enough information for `Verify RC` to fetch it and verify its
  digest and detached signature
- later schema versions may add fields, but the meaning of existing fields should remain stable
- the schema should stay simple enough that bash, Python, or other verification tooling can consume
  it easily

## Retryability

Release workflows should be decomposed into separate jobs wherever the failure boundaries are
independent. Examples:

- source resolution
- RC-number resolution
- ASF SVN cleanup
- source-archive build
- RC signing and staging
- draft GitHub Release synchronization
- same-line pruning from `dist/release`
- Maven publication
- PyPI publication
- Docker Hub publication
- GitHub Action publication
- moving-tag updates

Each job may consume a persisted manifest for transport and validation, but release-critical actions
must still revalidate their key inputs against authoritative live state in Git, ASF SVN, and
GitHub.

## Integration-testing strategy

Buildish release automation should be integration-tested at two levels:

1. in `buildish-release-tooling` itself
2. in each consuming Buildish component

The detailed design and current implementation of that test framework live in
`buildish-release-tooling/buildish-release-tooling/harness/README.md`.

At a high level, the harness should:

- keep `git` and detached local ASF SVN repositories real where possible
- keep local filesystem mutations real
- replace service-facing tools such as `gh`, `docker`, and optionally `gpg` with deterministic
  shims
- support fixture `JAVA_HOME` shims for JVM launchers such as `./gradlew`, `./mvnw`, SDKMAN
  `gradle`, and SDKMAN `mvn`
- record normalized command traces, manifests, and step-summary outputs
- support deterministic transient-failure injection and `Rerun failed jobs`-style reruns
- use a runner-agnostic scenario model so that both a custom backend and a future `act` backend can
  consume the same scenarios

The shared tooling should own the deeper release-state and workflow-behaviour simulations. Each
Buildish component should add smaller integration tests that validate:

- the checked-in `buildish-release-tooling/release-config.yaml`
- the thin component wrapper scripts or workflow entrypoints
- component-specific release jobs such as `dist/` materialization or secondary-artifact builds
- the exact CLI commands and flags passed to `buildish-release-tooling`

The goal should not be a full GitHub Actions emulator. The preferred architecture is a focused
release harness with deterministic shims and real local Git and SVN state, optionally complemented
by an outer `act`-based smoke-test layer.

## TODO list

- Implement a manifest-driven `verify-rc` command that can start from the authoritative
  `rc-vote-manifest.json` URL, verify the manifest signature and checksum sidecars, and then verify
  all voted artifacts.
- Validate and iterate on the draft release workflows now checked into the actual Buildish
  component repositories and their real GitHub environments.
- Implement the Mammoth Cache `dist/` materialization job that produces the detached materialization
  commit and `MATERIALIZED_COMMIT_SHA` input for `create-rc-materialization-tag`.
- Implement the component-specific secondary-artifact build and publication jobs for the components
  that need them.
- Add the shared workflow simulation harness to `buildish-release-tooling`, including deterministic
  command shims, failure injection, and `Rerun failed jobs` scenario coverage.
- Add an optional `act`-based workflow smoke-test layer using a custom runner image with the same
  command shims and a test-only `bash` summary-capture hook.
- Add fixture scenarios in `buildish-release-tooling` for:
  - no parallel RCs
  - parallel RCs on the same major line
  - a lower-minor release after a higher-minor release
  - transient `gh` failures
  - transient `docker` failures
  - transient ASF SVN failures
  - same-version follow-up RC preparation
  - release-version drift prevention
- Add component-level integration tests that exercise the real component release wrappers and
  component-specific jobs against fixture repositories.
- Add component-level rerun tests that simulate a failed publication job followed by rerun of only
  the failed job.
- Flesh out target-family-specific artifact metadata for Maven, Docker Hub, PyPI, and other
  secondary targets.

## References

- ASF Release Policy:
  <https://www.apache.org/legal/release-policy.html>
- ASF Release Creation Process:
  <https://infra.apache.org/release-publishing.html>
- ASF Release Distribution Policy:
  <https://infra.apache.org/release-distribution.html>
- ASF Release Signing:
  <https://infra.apache.org/release-signing.html>
- ASF Build and Supported Services:
  <https://infra.apache.org/build-supported-services.html>
- Apache Incubator Distribution Guidelines:
  <https://incubator.apache.org/guides/distribution.html>
