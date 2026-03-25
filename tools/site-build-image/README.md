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

# Buildish site builder image

This directory contains the Buildish-specific derived container image definition for Buildish site workflows.

The generic `site-pipeline` runtime image now lives in the extracted `buildish-site-pipeline` repository. The image defined here layers Hugo, Node, Go, and the current Buildish-specific render/serve expectations on top of that generic base image.

It is intentionally separated from `site/` so local tooling and future CI can rebuild or publish the image independently from normal site-content changes.

The primary developer entrypoint remains `site/Makefile`.

## Local multi-platform image build script

Use `build-image.sh` for the actual builder-image automation.

- Default platforms: `linux/amd64,linux/arm64`
- Default engine selection: `podman`, then `docker`
- Optional generic base image override via `SITE_PIPELINE_BASE_IMAGE=<ref>` or `--site-pipeline-base-image <ref>`
- Publishing is opt-in via `--push`

Examples:

- `tools/site-build-image/build-image.sh --image ghcr.io/example/buildish-site-build:latest --dry-run`
- `tools/site-build-image/build-image.sh --engine podman --image ghcr.io/example/buildish-site-build:latest`
- `tools/site-build-image/build-image.sh --engine docker --image ghcr.io/example/buildish-site-build:latest --push`

Local multi-platform builds may require binfmt/QEMU support on the host.

For `podman`, the build script now builds each target platform sequentially into a manifest list and fails early with a clear prerequisite error if required binfmt/QEMU handlers are missing.

## Local publish testing with a localhost registry

The script is safe by default:

- no publishing happens unless `--push` is provided
- insecure publishing is disabled unless `--allow-insecure-localhost-registry` is also provided
- insecure publishing is only allowed for explicit localhost or loopback registry references

Current support:

- localhost insecure publish testing is supported with `podman`
- `docker` remains limited to the normal secure publish path

Example once you have a localhost registry listening on port `5000`:

- `tools/site-build-image/build-image.sh --engine podman --image localhost:5000/buildish-site-build:test --push --allow-insecure-localhost-registry`

## Reusable localhost registry integration test

Use `test-local-registry.sh` to exercise the full local publish path end to end.

It will:

- start a pinned local registry container bound only to `127.0.0.1`
- invoke `build-image.sh` with explicit localhost insecure-push opt-in
- fetch the published manifest list from the registry API
- verify that `linux/amd64` and `linux/arm64` were published
- clean up the local registry container automatically unless `--keep-registry` is used

The pinned local registry image reference is sourced from `tools/site-build-image/Containerfile-local-registry` so Renovate can manage it.

Examples:

- `tools/site-build-image/test-local-registry.sh`
- `tools/site-build-image/test-local-registry.sh --tag smoke-test --keep-registry`

### Host prerequisites for full dual-platform local testing

By default, `test-local-registry.sh` validates `linux/amd64,linux/arm64`.

For `podman`, any non-native target platform requires enabled `binfmt_misc`/QEMU support on the host. If those handlers are not available, the script will fail early with a highlighted prerequisite error before it starts the local registry or build.

Typical examples:

- on an `amd64` host, building `linux/arm64` requires `qemu-aarch64` or `qemu-arm64`
- on an `arm64` host, building `linux/amd64` requires `qemu-x86_64` or `qemu-amd64`

> [!NOTE] Brief setup notes:
> 
> - Ubuntu: `sudo apt-get update && sudo apt-get install -y qemu-user-static binfmt-support && sudo systemctl restart systemd-binfmt`
> - macOS with Podman: the dependency must be installed inside the Podman VM rather than on macOS itself. A typical Podman-machine flow is: `podman machine ssh 'sudo rpm-ostree install qemu-user-static && sudo systemctl reboot'`, then after the VM restarts: `podman machine ssh 'sudo systemctl enable --now systemd-binfmt'`

If you only want to validate the localhost registry plumbing on the current host, run a native-platform smoke test instead, for example:

- `tools/site-build-image/test-local-registry.sh --platforms linux/amd64 --tag amd64-smoke`

If you intentionally want to bypass the early prerequisite check and let the build try anyway, use:

- `tools/site-build-image/test-local-registry.sh --skip-platform-prereq-check`

## GitHub Actions

`.github/workflows/site-build-image.yml` builds the multi-platform image for `linux/amd64` and `linux/arm64`.

The future GHCR login/publish steps are present but currently disabled while the repository remains private.