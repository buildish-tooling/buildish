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

event_name="${EVENT_NAME:-workflow_dispatch}"
pr_base_sha="${PR_BASE_SHA:-}"
push_before_sha="${PUSH_BEFORE_SHA:-}"
head_sha="${HEAD_SHA:-$(git rev-parse HEAD)}"
github_output="${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set}"

site_verify=false
site_build_image=false

site_verify_pattern='^(\.github/workflows/ci\.yml|\.github/scripts/ci-detect-changes\.sh|\.github/scripts/ci-site-verify\.sh|site/|tools/site-build-image/)'
site_build_image_pattern='^(\.github/workflows/ci\.yml|\.github/scripts/ci-detect-changes\.sh|tools/site-build-image/)'

enable_all() {
  site_verify=true
  site_build_image=true
}

if [ "$event_name" = "workflow_dispatch" ]; then
  enable_all
else
  if [ "$event_name" = "pull_request" ]; then
    base_sha="$pr_base_sha"
  else
    base_sha="$push_before_sha"
  fi

  if [ -z "$base_sha" ] || [ "$base_sha" = "0000000000000000000000000000000000000000" ]; then
    enable_all
  elif ! git cat-file -e "${base_sha}^{commit}" 2>/dev/null; then
    echo "Base commit $base_sha is not available locally; enabling all gated jobs."
    enable_all
  else
    changed_files="$(git diff --name-only "$base_sha" "$head_sha")"

    echo "Changed files between $base_sha and $head_sha:"
    if [ -n "$changed_files" ]; then
      printf '%s\n' "$changed_files"
    else
      echo "(none)"
    fi

    if printf '%s\n' "$changed_files" | grep -E -q "$site_verify_pattern"; then
      site_verify=true
    fi

    if printf '%s\n' "$changed_files" | grep -E -q "$site_build_image_pattern"; then
      site_build_image=true
    fi
  fi
fi

echo "site_verify=$site_verify" >>"$github_output"
echo "site_build_image=$site_build_image" >>"$github_output"

echo "Computed job gates:"
echo "  site_verify=$site_verify"
echo "  site_build_image=$site_build_image"