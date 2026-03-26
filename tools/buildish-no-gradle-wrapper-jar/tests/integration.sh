#!/bin/bash
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

set -eu

TOOL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUILD_DIR=$TOOL_DIR/build/tests
UPDATED_GRADLE_VERSION=${UPDATED_GRADLE_VERSION:-8.14}

fail() {
  echo "integration-test: $*" >&2
  exit 1
}

source_sdkman_gradle() {
  if command -v gradle >/dev/null 2>&1; then
    return 0
  fi
  [ -s "$HOME/.sdkman/bin/sdkman-init.sh" ] || fail "gradle is not on PATH and SDKMAN init script was not found."
  set +u
  . "$HOME/.sdkman/bin/sdkman-init.sh"
  set -u
  command -v gradle >/dev/null 2>&1 || fail 'gradle is still not available on PATH after sourcing SDKMAN.'
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command '$1' is not available on PATH."
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

extract_gradle_version() {
  sed -n 's/^distributionUrl=.*gradle-\([0-9.][0-9.]*\)-[a-z]*\.zip$/\1/p' "$1/gradle/wrapper/gradle-wrapper.properties"
}

gradle_user_home() {
  printf '%s-gradle-user-home' "$1"
}

gradle_init_fixture() {
  project_dir=$1
  mkdir -p "$project_dir"
  GRADLE_USER_HOME=$(gradle_user_home "$project_dir") gradle -p "$project_dir" init --dsl groovy --type java-library --use-defaults --no-daemon >/dev/null
  [ -f "$project_dir/gradle/wrapper/gradle-wrapper.jar" ] || fail "gradle init did not create gradle-wrapper.jar in '$project_dir'."
}

assert_helper_files() {
  project_dir=$1
  test -f "$project_dir/gradle/buildish-no-gradle-wrapper-jar.sh" || fail 'missing POSIX helper file.'
  test -f "$project_dir/gradle/buildish-no-gradle-wrapper-jar.ps1" || fail 'missing PowerShell helper file.'
  test -f "$project_dir/gradle/buildish-no-gradle-wrapper-jar.init.gradle.kts" || fail 'missing Gradle init script.'
}

file_has_exact_line() {
  file_path=$1
  expected_line=$2
  python3 - <<'PY' "$file_path" "$expected_line"
from pathlib import Path
import sys
lines = Path(sys.argv[1]).read_text().splitlines()
raise SystemExit(0 if sys.argv[2] in lines else 1)
PY
}

file_contains_text() {
  file_path=$1
  expected_text=$2
  python3 - <<'PY' "$file_path" "$expected_text"
from pathlib import Path
import sys
text = Path(sys.argv[1]).read_text().replace('\r\n', '\n')
raise SystemExit(0 if sys.argv[2] in text else 1)
PY
}

assert_launcher_patches() {
  project_dir=$1
  file_has_exact_line "$project_dir/gradlew" '. "${APP_HOME}/gradle/buildish-no-gradle-wrapper-jar.sh"' || fail 'gradlew was not patched with the helper include.'
  file_has_exact_line "$project_dir/gradlew.bat" 'set BUILDISH_NO_GRADLE_WRAPPER_JAR_ORIGINAL_ARGS=%*' || fail 'gradlew.bat was not patched with the helper block.'
  file_contains_text "$project_dir/gradlew.bat" '%BUILDISH_NO_GRADLE_WRAPPER_JAR_ARGS% %*' || fail 'gradlew.bat final Java invocation was not patched.'
}

assert_gitignore_updates() {
  project_dir=$1
  grep -Fqx '# Added by buildish-no-gradle-wrapper-jar' "$project_dir/.gitignore" || fail '.gitignore helper comment was not added.'
  grep -Fqx 'gradle/wrapper/gradle-wrapper-*.sha256' "$project_dir/.gitignore" || fail '.gitignore sha256 ignore was not added.'
  grep -Fqx 'gradle/wrapper/gradle-wrapper-*.asc' "$project_dir/.gitignore" || fail '.gitignore asc ignore was not added.'
}

assert_metadata_for_version() {
  project_dir=$1
  version=$2
  jar_path="$project_dir/gradle/wrapper/gradle-wrapper.jar"
  sha_path="$project_dir/gradle/wrapper/gradle-wrapper-$version.sha256"
  asc_path="$project_dir/gradle/wrapper/gradle-wrapper-$version.asc"
  [ -f "$jar_path" ] || fail "wrapper jar is missing for version '$version'."
  [ -f "$sha_path" ] || fail "wrapper checksum file is missing for version '$version'."
  [ -f "$asc_path" ] || fail "wrapper detached signature is missing for version '$version'."
  expected_checksum=$(tr -d '\r\n' < "$sha_path")
  actual_checksum=$(hash_file "$jar_path")
  [ "$expected_checksum" = "$actual_checksum" ] || fail "wrapper checksum mismatch for version '$version'."
  first_signature_line=$(sed -n '1p' "$asc_path")
  [ "$first_signature_line" = '-----BEGIN PGP SIGNATURE-----' ] || fail "wrapper detached signature file for version '$version' is malformed."
}

run_wrapper() {
  project_dir=$1
  shift
  (cd "$project_dir" && GRADLE_USER_HOME=$(gradle_user_home "$project_dir") ./gradlew --no-daemon "$@" >/dev/null)
}

run_posix_installer_flow() {
  project_dir=$1
  gradle_init_fixture "$project_dir"
  BUILDISH_NO_GRADLE_WRAPPER_JAR_SOURCE_DIR="$TOOL_DIR" sh "$TOOL_DIR/install.sh" "$project_dir" >/dev/null
  [ ! -e "$project_dir/gradle/wrapper/gradle-wrapper.jar" ] || fail 'install.sh should remove the existing gradle-wrapper.jar.'
  assert_helper_files "$project_dir"
  assert_launcher_patches "$project_dir"
  assert_gitignore_updates "$project_dir"

  run_wrapper "$project_dir" help
  initial_version=$(extract_gradle_version "$project_dir")
  [ -n "$initial_version" ] || fail 'unable to extract the initial Gradle version after install.sh.'
  assert_metadata_for_version "$project_dir" "$initial_version"

  run_wrapper "$project_dir" wrapper --gradle-version "$UPDATED_GRADLE_VERSION" --distribution-type bin
  updated_version=$(extract_gradle_version "$project_dir")
  [ "$updated_version" = "$UPDATED_GRADLE_VERSION" ] || fail "expected updated Gradle version '$UPDATED_GRADLE_VERSION' but found '$updated_version'."
  assert_launcher_patches "$project_dir"

  run_wrapper "$project_dir" help
  assert_metadata_for_version "$project_dir" "$updated_version"
}

run_powershell_installer_flow() {
  project_dir=$1
  gradle_init_fixture "$project_dir"
  BUILDISH_NO_GRADLE_WRAPPER_JAR_SOURCE_DIR="$TOOL_DIR" pwsh -NoLogo -NoProfile -File "$TOOL_DIR/install.ps1" "$project_dir" >/dev/null
  [ ! -e "$project_dir/gradle/wrapper/gradle-wrapper.jar" ] || fail 'install.ps1 should remove the existing gradle-wrapper.jar.'
  assert_helper_files "$project_dir"
  assert_launcher_patches "$project_dir"
  assert_gitignore_updates "$project_dir"

  run_wrapper "$project_dir" help
  installed_version=$(extract_gradle_version "$project_dir")
  [ -n "$installed_version" ] || fail 'unable to extract the installed Gradle version after install.ps1.'
  assert_metadata_for_version "$project_dir" "$installed_version"
}

main() {
  source_sdkman_gradle
  require_command gradle
  require_command gpg
  require_command pwsh
  command -v sha256sum >/dev/null 2>&1 || require_command shasum
  mkdir -p "$BUILD_DIR"
  test_root=$(mktemp -d "$BUILD_DIR/integration.XXXXXX")
  trap 'rm -rf "$test_root"' EXIT HUP INT TERM

  run_posix_installer_flow "$test_root/posix-installer"
  run_powershell_installer_flow "$test_root/powershell-installer"
  echo 'integration-test: all helper-tool integration checks passed.'
}

main "$@"