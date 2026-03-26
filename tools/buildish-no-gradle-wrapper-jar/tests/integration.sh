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

# This script serves two roles:
#   * the default integration suite used by `make test`
#   * a reusable "version list exercise" that can probe many Gradle wrapper
#     versions via `./gradlew wrapper --gradle-version ...`
#
# The default suite still covers both installers. The version-list exercise is
# intentionally POSIX-centric because its purpose is to discover which generated
# launcher shapes and wrapper versions this helper can support; each probe still
# verifies both `gradlew` and generated `gradlew.bat` patching.

TOOL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUILD_DIR=$TOOL_DIR/build/tests
UPDATED_GRADLE_VERSION=${UPDATED_GRADLE_VERSION:-8.14}

fail() {
  echo "integration-test: $*" >&2
  exit 1
}

log() {
  echo "integration-test: $*"
}

source_sdkman_gradle() {
  if [ -s "$HOME/.sdkman/bin/sdkman-init.sh" ] && ! command -v sdk >/dev/null 2>&1; then
    set +u
    . "$HOME/.sdkman/bin/sdkman-init.sh"
    set -u
  fi
  if command -v gradle >/dev/null 2>&1; then
    return 0
  fi
  [ -s "$HOME/.sdkman/bin/sdkman-init.sh" ] || fail "gradle is not on PATH and SDKMAN init script was not found."
  command -v gradle >/dev/null 2>&1 || fail 'gradle is still not available on PATH after sourcing SDKMAN.'
}

use_sdkman_gradle_version() {
  version=$1
  source_sdkman_gradle
  command -v sdk >/dev/null 2>&1 || fail 'SDKMAN is required to select the bootstrap Gradle version for the version exercise.'
  set +u
  sdk use gradle "$version" >/dev/null
  set -u
  command -v gradle >/dev/null 2>&1 || fail "gradle is not available on PATH after selecting SDKMAN Gradle version '$version'."
}

select_sdkman_java_version_for_version_exercise() {
  [ -d "$HOME/.sdkman/candidates/java" ] || fail 'SDKMAN Java candidates directory was not found for the version exercise.'
  java_version=$(find "$HOME/.sdkman/candidates/java" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep '^17\.' | sort -V | tail -n 1)
  [ -n "$java_version" ] || fail 'The version exercise requires an installed SDKMAN Java 17.x runtime to run Gradle 8.1.x safely.'
  printf '%s' "$java_version"
}

use_sdkman_java_version() {
  version=$1
  source_sdkman_gradle
  command -v sdk >/dev/null 2>&1 || fail 'SDKMAN is required to select the Java runtime for the version exercise.'
  set +u
  sdk use java "$version" >/dev/null
  set -u
  command -v java >/dev/null 2>&1 || fail "java is not available on PATH after selecting SDKMAN Java version '$version'."
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command '$1' is not available on PATH."
}

sanitize_for_path() {
  printf '%s' "$1" | tr '/:' '__' | tr -c 'A-Za-z0-9._-' '_'
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
  bootstrap_gradle_version=${2:-}
  fixture_gradle_user_home=$(gradle_user_home "$project_dir")
  mkdir -p "$project_dir"
  log "initializing fixture in '$project_dir' (GRADLE_USER_HOME='$fixture_gradle_user_home'${bootstrap_gradle_version:+, bootstrap Gradle='$bootstrap_gradle_version'})"
  if [ -n "$bootstrap_gradle_version" ]; then
    use_sdkman_gradle_version "$bootstrap_gradle_version"
    # Gradle 8.1.x still prompts for the target Java version and whether to use
    # incubating APIs even when the project type and DSL are specified. Feed the
    # stable answers explicitly so the version exercise stays non-interactive.
    printf '17\nno\n' | GRADLE_USER_HOME="$fixture_gradle_user_home" gradle -p "$project_dir" init --dsl groovy --type java-library --project-name sample --package org.example --test-framework junit --no-daemon --console=plain >/dev/null
  else
    GRADLE_USER_HOME="$fixture_gradle_user_home" gradle -p "$project_dir" init --dsl groovy --type java-library --use-defaults --no-daemon >/dev/null
  fi
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
  log "running ./gradlew $* in '$project_dir' (GRADLE_USER_HOME='$(gradle_user_home "$project_dir")')"
  (cd "$project_dir" && GRADLE_USER_HOME=$(gradle_user_home "$project_dir") ./gradlew --no-daemon "$@" >/dev/null)
}

exercise_wrapper_update_to_version() {
  project_dir=$1
  bootstrap_gradle_version=$2
  target_version=$3

  log "starting wrapper exercise for target Gradle '$target_version' in '$project_dir'"
  gradle_init_fixture "$project_dir" "$bootstrap_gradle_version"
  log "installing POSIX helper into '$project_dir'"
  BUILDISH_NO_GRADLE_WRAPPER_JAR_SOURCE_DIR="$TOOL_DIR" sh "$TOOL_DIR/install.sh" "$project_dir" >/dev/null
  [ ! -e "$project_dir/gradle/wrapper/gradle-wrapper.jar" ] || fail 'install.sh should remove the existing gradle-wrapper.jar.'
  assert_helper_files "$project_dir"
  assert_launcher_patches "$project_dir"
  assert_gitignore_updates "$project_dir"

  log "verifying freshly installed helper for '$project_dir'"
  run_wrapper "$project_dir" help
  initial_version=$(extract_gradle_version "$project_dir")
  [ -n "$initial_version" ] || fail 'unable to extract the initial Gradle version after install.sh.'
  assert_metadata_for_version "$project_dir" "$initial_version"

  log "upgrading wrapper in '$project_dir' from '$initial_version' to '$target_version'"
  run_wrapper "$project_dir" wrapper --gradle-version "$target_version" --distribution-type bin
  updated_version=$(extract_gradle_version "$project_dir")
  [ "$updated_version" = "$target_version" ] || fail "expected updated Gradle version '$target_version' but found '$updated_version'."
  assert_launcher_patches "$project_dir"

  log "verifying upgraded helper for '$project_dir' at Gradle '$updated_version'"
  run_wrapper "$project_dir" help
  assert_metadata_for_version "$project_dir" "$updated_version"
}

run_posix_installer_flow() {
  project_dir=$1
  log "running default POSIX installer flow in '$project_dir'"
  exercise_wrapper_update_to_version "$project_dir" '' "$UPDATED_GRADLE_VERSION"
}

run_powershell_installer_flow() {
  project_dir=$1
  log "running default PowerShell installer flow in '$project_dir'"
  gradle_init_fixture "$project_dir"
  log "installing PowerShell helper into '$project_dir'"
  BUILDISH_NO_GRADLE_WRAPPER_JAR_SOURCE_DIR="$TOOL_DIR" pwsh -NoLogo -NoProfile -File "$TOOL_DIR/install.ps1" "$project_dir" >/dev/null
  [ ! -e "$project_dir/gradle/wrapper/gradle-wrapper.jar" ] || fail 'install.ps1 should remove the existing gradle-wrapper.jar.'
  assert_helper_files "$project_dir"
  assert_launcher_patches "$project_dir"
  assert_gitignore_updates "$project_dir"

  log "verifying PowerShell-installed helper for '$project_dir'"
  run_wrapper "$project_dir" help
  installed_version=$(extract_gradle_version "$project_dir")
  [ -n "$installed_version" ] || fail 'unable to extract the installed Gradle version after install.ps1.'
  assert_metadata_for_version "$project_dir" "$installed_version"
}

run_default_integration_suite() {
  source_sdkman_gradle
  require_command gradle
  require_command gpg
  require_command python3
  require_command pwsh
  command -v sha256sum >/dev/null 2>&1 || require_command shasum
  mkdir -p "$BUILD_DIR"
  test_root=$(mktemp -d "$BUILD_DIR/integration.XXXXXX")
  trap 'rm -rf "$test_root"' EXIT HUP INT TERM

  log "starting default integration suite (test_root='$test_root')"
  run_posix_installer_flow "$test_root/posix-installer"
  run_powershell_installer_flow "$test_root/powershell-installer"
  log 'all helper-tool integration checks passed.'
}

run_single_version_exercise() {
  bootstrap_gradle_version=$1
  target_version=$2
  source_sdkman_gradle
  require_command gradle
  require_command gpg
  require_command python3
  command -v sha256sum >/dev/null 2>&1 || require_command shasum
  mkdir -p "$BUILD_DIR"
  test_root=$(mktemp -d "$BUILD_DIR/version-single.XXXXXX")
  trap 'rm -rf "$test_root"' EXIT HUP INT TERM

  version_exercise_java_version=$(select_sdkman_java_version_for_version_exercise)
  log "starting single-version exercise (test_root='$test_root', bootstrap Gradle='$bootstrap_gradle_version', target Gradle='$target_version', Java='$version_exercise_java_version')"
  use_sdkman_java_version "$version_exercise_java_version"
  exercise_wrapper_update_to_version "$test_root/version-$target_version" "$bootstrap_gradle_version" "$target_version"
  log "Gradle $target_version wrapper exercise passed (bootstrap Gradle: $bootstrap_gradle_version, Java: $version_exercise_java_version)."
}

run_version_list_exercise() {
  [ "$#" -gt 0 ] || fail 'version-list requires one or more explicit Gradle versions.'
  mkdir -p "$BUILD_DIR/version-list"

  bootstrap_gradle_version=$1

  passed_versions=''
  failed_versions=''

  log "using SDKMAN bootstrap Gradle $bootstrap_gradle_version for fixture initialization."
  for target_version in "$@"; do
    log_path="$BUILD_DIR/version-list/$(sanitize_for_path "$target_version").log"
    log "starting version-list entry for Gradle '$target_version' (log='$log_path')"
    if bash "$0" single-version "$bootstrap_gradle_version" "$target_version" >"$log_path" 2>&1; then
      log "PASS Gradle $target_version (log: $log_path)"
      passed_versions="${passed_versions}${passed_versions:+ }$target_version"
    else
      echo "integration-test: FAIL Gradle $target_version (log: $log_path)" >&2
      failed_versions="${failed_versions}${failed_versions:+ }$target_version"
    fi
  done

  [ -n "$passed_versions" ] && log "supported versions in this run: $passed_versions"
  if [ -n "$failed_versions" ]; then
    echo "integration-test: unsupported or failing versions in this run: $failed_versions" >&2
    return 1
  fi
}

main() {
  mode=${1:-default}
  case "$mode" in
    default)
      run_default_integration_suite
      ;;
    single-version)
      if [ "$#" -eq 2 ]; then
        run_single_version_exercise "$2" "$2"
      elif [ "$#" -eq 3 ]; then
        run_single_version_exercise "$2" "$3"
      else
        fail 'single-version requires one target version or a bootstrap-version/target-version pair.'
      fi
      ;;
    version-list)
      shift
      run_version_list_exercise "$@"
      ;;
    *)
      fail "unknown mode '$mode' (expected: default, single-version, version-list)."
      ;;
  esac
}

main "$@"