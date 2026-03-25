#!/usr/bin/env bash
#
# Copyright 2026 The Buildish Authors
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
BUILD_SCRIPT="$SCRIPT_DIR/build-image.sh"
REGISTRY_CONTAINERFILE="$SCRIPT_DIR/Containerfile-local-registry"
PLATFORMS="linux/amd64,linux/arm64"
REPOSITORY="buildish-site-build"
TAG="integration-test"
KEEP_REGISTRY=false
SKIP_PLATFORM_PREREQ_CHECK=false
REGISTRY_NAME="buildish-site-registry-$$-$(date +%s)"
REGISTRY_PORT=""
ERROR_BORDER='********************************************************************************'

usage() {
  cat <<'EOF'
Usage: test-local-registry.sh [options]

Start a localhost-only registry, build and push the multi-platform site builder image,
then verify the pushed manifest contains linux/amd64 and linux/arm64.

Options:
  --platforms <list>    Comma-separated platforms. Default: linux/amd64,linux/arm64
  --repository <name>   Repository name inside the local registry. Default: buildish-site-build
  --tag <tag>           Tag to push and verify. Default: integration-test
  --skip-platform-prereq-check
                       Skip the podman binfmt/QEMU prerequisite check and attempt the build anyway.
  --keep-registry       Leave the local registry container running for debugging.
  --help                Show this help.

Examples:
  ./test-local-registry.sh
  ./test-local-registry.sh --tag smoke-test --keep-registry
EOF
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

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    highlighted_error "required command '$1' is not available on PATH."
    exit 1
  }
}

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

validate_platform_prereqs() {
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
      highlighted_error "unsupported platform '$platform'. Expected linux/<arch>."
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

registry_image_ref() {
  local image_ref

  if [[ ! -r "$REGISTRY_CONTAINERFILE" ]]; then
    echo "Error: registry image source file '$REGISTRY_CONTAINERFILE' is not readable." >&2
    exit 1
  fi

  image_ref="$(awk 'toupper($1) == "FROM" { print $2; exit }' "$REGISTRY_CONTAINERFILE")"
  if [[ -z "$image_ref" ]]; then
    echo "Error: failed to extract registry image reference from '$REGISTRY_CONTAINERFILE'." >&2
    exit 1
  fi

  printf '%s\n' "$image_ref"
}

cleanup() {
  if $KEEP_REGISTRY; then
    return
  fi
  podman rm -f "$REGISTRY_NAME" >/dev/null 2>&1 || true
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platforms)
      PLATFORMS="${2:?Missing value for --platforms}"
      shift 2
      ;;
    --repository)
      REPOSITORY="${2:?Missing value for --repository}"
      shift 2
      ;;
    --tag)
      TAG="${2:?Missing value for --tag}"
      shift 2
      ;;
    --skip-platform-prereq-check)
      SKIP_PLATFORM_PREREQ_CHECK=true
      shift
      ;;
    --keep-registry)
      KEEP_REGISTRY=true
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

require_cmd podman
require_cmd curl
require_cmd python3
require_cmd "$BUILD_SCRIPT"

if ! $SKIP_PLATFORM_PREREQ_CHECK; then
  validate_platform_prereqs
fi

trap cleanup EXIT

REGISTRY_IMAGE="$(registry_image_ref)"

echo "Starting local registry container '$REGISTRY_NAME'..."
podman run -d --rm --name "$REGISTRY_NAME" -p 127.0.0.1::5000 "$REGISTRY_IMAGE" >/dev/null

REGISTRY_PORT="$(podman port "$REGISTRY_NAME" 5000/tcp | head -n1)"
REGISTRY_PORT="${REGISTRY_PORT##*:}"
if [[ -z "$REGISTRY_PORT" ]]; then
  echo "Error: failed to determine local registry port." >&2
  exit 1
fi

echo "Waiting for localhost registry on 127.0.0.1:${REGISTRY_PORT}..."
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${REGISTRY_PORT}/v2/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "http://127.0.0.1:${REGISTRY_PORT}/v2/" >/dev/null 2>&1; then
  echo "Error: localhost registry did not become ready on port ${REGISTRY_PORT}." >&2
  exit 1
fi

IMAGE_REF="localhost:${REGISTRY_PORT}/${REPOSITORY}:${TAG}"
echo "Building and pushing multi-platform image to ${IMAGE_REF}..."
build_cmd=(
  "$BUILD_SCRIPT"
  --engine podman
  --image "$IMAGE_REF"
  --platforms "$PLATFORMS"
  --push
  --allow-insecure-localhost-registry
)
if $SKIP_PLATFORM_PREREQ_CHECK; then
  build_cmd+=(--skip-platform-prereq-check)
fi
"${build_cmd[@]}"

echo "Inspecting pushed manifest list..."
MANIFEST_JSON="$(curl -fsS \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
  "http://127.0.0.1:${REGISTRY_PORT}/v2/${REPOSITORY}/manifests/${TAG}")"

MANIFEST_JSON="$MANIFEST_JSON" python3 - "$PLATFORMS" <<'PY'
import json
import os
import sys

expected = set()
for item in sys.argv[1].split(','):
    item = item.strip()
    os_name, arch = item.split('/', 1)
    expected.add((os_name, arch))

payload = json.loads(os.environ['MANIFEST_JSON'])
media_type = payload.get('mediaType', '')
if media_type not in {
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
}:
    raise SystemExit(f'Unexpected manifest media type: {media_type}')

found = {
    (entry.get('platform', {}).get('os'), entry.get('platform', {}).get('architecture'))
    for entry in payload.get('manifests', [])
}
missing = expected - found
if missing:
    raise SystemExit(f'Missing expected platforms: {sorted(missing)}; found {sorted(found)}')

print('Verified manifest platforms:', ', '.join(f'{os_name}/{arch}' for os_name, arch in sorted(found)))
PY

echo "Integration test succeeded for ${IMAGE_REF}."
if $KEEP_REGISTRY; then
  echo "Registry left running as ${REGISTRY_NAME} on 127.0.0.1:${REGISTRY_PORT}."
fi