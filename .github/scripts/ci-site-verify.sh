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

site_dir="${SITE_DIR:-site}"
container_engine="${CONTAINER_ENGINE:-docker}"
verify_timeout="${SITE_VERIFY_TIMEOUT:-5m}"

dump_diagnostics() {
  status="$1"

  if [ "$status" -eq 124 ]; then
    echo "::error::Site verification timed out after 5 minutes"
  else
    echo "::error::Site verification failed with exit code ${status}"
  fi

  echo "::group::Site verification diagnostics"
  date -u
  pwd
  ls -la "$site_dir/.hugo_build.lock" "$site_dir/.public" "$site_dir/resources" 2>/dev/null || true
  find "$site_dir" -maxdepth 4 \( -name '.hugo_build.lock' -o -name '*.pid' \) -print -exec ls -l {} \; 2>/dev/null || true
  pgrep -af 'hugo|node|postcss|docker|python|make' || true
  docker ps -a --no-trunc || true
  echo "::endgroup::"
}

rm -f "$site_dir/.hugo_build.lock"

set +e
timeout --signal=TERM --kill-after=30s "$verify_timeout" \
  make -C "$site_dir" \
    CONTAINER_ENGINE="$container_engine" \
    container-image \
    container-test \
    container-integration-test \
    container-build
status=$?
set -e

if [ "$status" -ne 0 ]; then
  dump_diagnostics "$status"
  exit "$status"
fi