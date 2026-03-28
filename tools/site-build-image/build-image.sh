#!/usr/bin/env bash
#
# Copyright 2026 The Apache Software Foundation
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONTAINERFILE_DEFAULT="$SCRIPT_DIR/Containerfile"
BUILD_CONTEXT_DEFAULT="$SCRIPT_DIR"
PLATFORMS="linux/amd64,linux/arm64"
ENGINE="${CONTAINER_ENGINE:-}"
IMAGE_REF=""
PUSH_IMAGE=false
ALLOW_INSECURE_LOCALHOST_REGISTRY=false
DRY_RUN=false
SKIP_PLATFORM_PREREQ_CHECK=false
ERROR_BORDER='********************************************************************************'

normalize_arch() {
  case "$1" in
    x86_64|amd64)
      printf 'amd64\n'
      ;;
    aarch64|arm64)
      printf 'arm64\n'
      ;;
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

qemu_binfmt_candidates() {
  case "$1" in
    amd64)
      printf '%s\n' qemu-x86_64 qemu-amd64
      ;;
    arm64)
      printf '%s\n' qemu-aarch64 qemu-arm64
      ;;
    arm)
      printf '%s\n' qemu-arm
      ;;
    *)
      printf 'qemu-%s\n' "$1"
      ;;
  esac
}

usage() {
  cat <<'EOF'
Usage: build-image.sh --image <image-ref> [options]

Build the Apache Buildish site builder image.

Options:
  --image <ref>         Fully-qualified image reference to build.
  --engine <name>       Container engine to use: podman or docker.
  --platforms <list>    Comma-separated platforms. Default: linux/amd64,linux/arm64
  --push                Push/publish the multi-platform image after building.
  --allow-insecure-localhost-registry
                        Allow insecure publishing only to localhost/loopback registries.
  --skip-platform-prereq-check
                        Skip the podman binfmt/QEMU prerequisite check and attempt the build anyway.
  --dry-run             Print commands without executing them.
  --help                Show this help.

Examples:
  ./build-image.sh --image ghcr.io/example/buildish-site-build:latest --dry-run
  ./build-image.sh --engine podman --image ghcr.io/example/buildish-site-build:latest
  ./build-image.sh --engine podman --image localhost:5000/buildish-site-build:test --push --allow-insecure-localhost-registry
  ./build-image.sh --engine docker --image ghcr.io/example/buildish-site-build:latest --push
EOF
}

print_cmd() {
  printf '+'
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'
}

highlighted_error() {
  local message="$1"
  shift || true

  printf '%s\n' "$ERROR_BORDER" >&2
  printf '❌ %s\n' "$message" >&2
  for message in "$@"; do
    printf '%s\n' "$message" >&2
  done
  printf '%s\n' "$ERROR_BORDER" >&2
}

run_cmd() {
  print_cmd "$@"
  if ! $DRY_RUN; then
    "$@"
  fi
}

has_enabled_binfmt_handler() {
  local handler path

  for handler in "$@"; do
    path="/proc/sys/fs/binfmt_misc/$handler"
    if [[ -r "$path" ]] && grep -q '^enabled$' "$path"; then
      return 0
    fi
  done

  return 1
}

extract_registry_host() {
  local image_ref="$1"
  local first_component registry_host

  if [[ "$image_ref" != */* ]]; then
    return 1
  fi

  first_component="${image_ref%%/*}"
  if [[ "$first_component" != *.* && "$first_component" != *:* && "$first_component" != localhost && "$first_component" != \[*\] ]]; then
    return 1
  fi

  if [[ "$first_component" =~ ^(\[[0-9A-Fa-f:]+\])(:[0-9]+)?$ ]]; then
    registry_host="${BASH_REMATCH[1]}"
  elif [[ "$first_component" == *:* ]]; then
    registry_host="${first_component%%:*}"
  else
    registry_host="$first_component"
  fi

  printf '%s\n' "$registry_host"
}

validate_push_settings() {
  local registry_host

  if ! $PUSH_IMAGE && $ALLOW_INSECURE_LOCALHOST_REGISTRY; then
    echo "Error: --allow-insecure-localhost-registry requires --push." >&2
    exit 1
  fi

  if ! $ALLOW_INSECURE_LOCALHOST_REGISTRY; then
    return
  fi

  if ! registry_host="$(extract_registry_host "$IMAGE_REF")"; then
    echo "Error: --allow-insecure-localhost-registry requires an explicit localhost registry in --image." >&2
    exit 1
  fi

  case "$registry_host" in
    localhost|127.0.0.1|'[::1]') ;;
    *)
      echo "Error: insecure publishing is only allowed for localhost/loopback registries, got '$registry_host'." >&2
      exit 1
      ;;
  esac
}

validate_podman_platform_support() {
  local host_arch platform target_os target_arch
  local -a platforms candidates

  host_arch="$(normalize_arch "$(uname -m)")"
  IFS=',' read -r -a platforms <<< "$PLATFORMS"

  for platform in "${platforms[@]}"; do
    platform="${platform//[[:space:]]/}"
    [[ -n "$platform" ]] || continue

    target_os="${platform%%/*}"
    target_arch="${platform#*/}"
    target_arch="${target_arch%%/*}"
    target_arch="$(normalize_arch "$target_arch")"

    if [[ "$target_os" != "linux" ]]; then
      echo "Error: unsupported platform '$platform'. Expected linux/<arch>." >&2
      exit 1
    fi

    if [[ "$target_arch" == "$host_arch" ]]; then
      continue
    fi

    mapfile -t candidates < <(qemu_binfmt_candidates "$target_arch")
    if has_enabled_binfmt_handler "${candidates[@]}"; then
      continue
    fi

    highlighted_error \
      "podman cross-platform build for '$platform' requires enabled binfmt/QEMU support (${candidates[*]})." \
      "Install/register the required binfmt handlers or limit --platforms to linux/$host_arch on this host." \
      "Use --skip-platform-prereq-check to attempt the build anyway."
    exit 1
  done
}

build_with_podman() {
  local platform
  local -a platforms

  if ! $DRY_RUN; then
    if ! $SKIP_PLATFORM_PREREQ_CHECK; then
      validate_podman_platform_support
    fi
    podman manifest rm "$IMAGE_REF" >/dev/null 2>&1 || true
  fi

  run_cmd podman manifest create "$IMAGE_REF"

  IFS=',' read -r -a platforms <<< "$PLATFORMS"
  for platform in "${platforms[@]}"; do
    platform="${platform//[[:space:]]/}"
    [[ -n "$platform" ]] || continue
    run_cmd podman build --rm --platform "$platform" --manifest "$IMAGE_REF" -f "$CONTAINERFILE_DEFAULT" "$BUILD_CONTEXT_DEFAULT"
  done

  if $PUSH_IMAGE; then
    if $ALLOW_INSECURE_LOCALHOST_REGISTRY; then
      run_cmd podman manifest push --all --tls-verify=false "$IMAGE_REF" "docker://$IMAGE_REF"
    else
      run_cmd podman manifest push --all "$IMAGE_REF" "docker://$IMAGE_REF"
    fi
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image)
      IMAGE_REF="${2:?Missing value for --image}"
      shift 2
      ;;
    --engine)
      ENGINE="${2:?Missing value for --engine}"
      shift 2
      ;;
    --platforms)
      PLATFORMS="${2:?Missing value for --platforms}"
      shift 2
      ;;
    --push)
      PUSH_IMAGE=true
      shift
      ;;
    --allow-insecure-localhost-registry)
      ALLOW_INSECURE_LOCALHOST_REGISTRY=true
      shift
      ;;
    --skip-platform-prereq-check)
      SKIP_PLATFORM_PREREQ_CHECK=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$IMAGE_REF" ]]; then
  echo "Error: --image is required." >&2
  usage >&2
  exit 1
fi

validate_push_settings

if [[ -z "$ENGINE" ]]; then
  if command -v podman >/dev/null 2>&1; then
    ENGINE=podman
  elif command -v docker >/dev/null 2>&1; then
    ENGINE=docker
  else
    echo "Error: neither podman nor docker is available on PATH." >&2
    exit 1
  fi
fi

case "$ENGINE" in
  podman)
    build_with_podman
    ;;
  docker)
    if $ALLOW_INSECURE_LOCALHOST_REGISTRY; then
      echo "Error: --allow-insecure-localhost-registry is currently only supported with --engine podman." >&2
      exit 1
    fi
    run_cmd docker buildx version
    docker_cmd=(docker buildx build --platform "$PLATFORMS" --rm --tag "$IMAGE_REF" -f "$CONTAINERFILE_DEFAULT")
    if $PUSH_IMAGE; then
      docker_cmd+=(--push)
    fi
    docker_cmd+=("$BUILD_CONTEXT_DEFAULT")
    run_cmd "${docker_cmd[@]}"
    ;;
  *)
    echo "Error: unsupported engine '$ENGINE'. Expected podman or docker." >&2
    exit 1
    ;;
esac