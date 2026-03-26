#!/bin/sh
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

# Included from gradlew after APP_HOME has been resolved.

buildish_no_gradle_wrapper_jar_fail() {
  echo "buildish-no-gradle-wrapper-jar: $*" >&2
  exit 1
}

buildish_no_gradle_wrapper_jar_require_command() {
  command -v "$1" >/dev/null 2>&1 ||
    buildish_no_gradle_wrapper_jar_fail "Required command '$1' was not found on PATH."
}

buildish_no_gradle_wrapper_jar_sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print tolower($1); exit }'
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print tolower($1); exit }'
    return 0
  fi
  buildish_no_gradle_wrapper_jar_fail "Neither 'sha256sum' nor 'shasum' is available for checksum verification."
}

buildish_no_gradle_wrapper_jar_download_to_file() {
  target_path=$1
  download_url=$2
  resource_label=$3
  temp_path=$(mktemp "${BUILDISH_HELPER_WRAPPER_DIR}/.buildish-no-gradle-wrapper-jar.XXXXXX") ||
    buildish_no_gradle_wrapper_jar_fail "Unable to create a temporary file for ${resource_label}."

  if ! curl --fail --location --silent --show-error --output "$temp_path" "$download_url"; then
    rm -f "$temp_path"
    buildish_no_gradle_wrapper_jar_fail "Unable to download ${resource_label} from '${download_url}'."
  fi

  if ! mv -f "$temp_path" "$target_path"; then
    rm -f "$temp_path"
    buildish_no_gradle_wrapper_jar_fail "Unable to move ${resource_label} into '${target_path}'."
  fi
}

buildish_no_gradle_wrapper_jar_normalize_checksum_file() {
  checksum_path=$1
  normalized_checksum=$(tr -d '\r\n' < "$checksum_path" | tr '[:upper:]' '[:lower:]')
  if ! printf '%s' "$normalized_checksum" | grep -E '^[0-9a-f]{64}$' >/dev/null 2>&1; then
    return 1
  fi
  printf '%s\n' "$normalized_checksum" > "$checksum_path" || return 1
  return 0
}

buildish_no_gradle_wrapper_jar_validate_signature_file() {
  signature_path=$1
  first_line=$(sed -n '1p' "$signature_path")
  [ "$first_line" = '-----BEGIN PGP SIGNATURE-----' ]
}

buildish_no_gradle_wrapper_jar_ensure_metadata_files() {
  if [ ! -f "$BUILDISH_HELPER_SHA256_PATH" ] ||
     ! buildish_no_gradle_wrapper_jar_normalize_checksum_file "$BUILDISH_HELPER_SHA256_PATH"; then
    rm -f "$BUILDISH_HELPER_SHA256_PATH"
    buildish_no_gradle_wrapper_jar_download_to_file \
      "$BUILDISH_HELPER_SHA256_PATH" \
      "$BUILDISH_HELPER_SHA256_URL" \
      "wrapper checksum"
    buildish_no_gradle_wrapper_jar_normalize_checksum_file "$BUILDISH_HELPER_SHA256_PATH" ||
      buildish_no_gradle_wrapper_jar_fail "Downloaded wrapper checksum was not a valid SHA-256 value."
  fi

  if [ ! -f "$BUILDISH_HELPER_SIGNATURE_PATH" ] ||
     ! buildish_no_gradle_wrapper_jar_validate_signature_file "$BUILDISH_HELPER_SIGNATURE_PATH"; then
    rm -f "$BUILDISH_HELPER_SIGNATURE_PATH"
    buildish_no_gradle_wrapper_jar_download_to_file \
      "$BUILDISH_HELPER_SIGNATURE_PATH" \
      "$BUILDISH_HELPER_SIGNATURE_URL" \
      "wrapper detached signature"
    buildish_no_gradle_wrapper_jar_validate_signature_file "$BUILDISH_HELPER_SIGNATURE_PATH" ||
      buildish_no_gradle_wrapper_jar_fail "Downloaded wrapper detached signature was not valid ASCII-armored OpenPGP data."
  fi
}

buildish_no_gradle_wrapper_jar_verify_signature() {
  signature_path=$1
  payload_path=$2
  temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/buildish-no-gradle-wrapper-jar-gpg.XXXXXX") || {
    echo "buildish-no-gradle-wrapper-jar: Unable to create a temporary GnuPG home." >&2
    return 1
  }
  gpg_home="${temp_dir}/home"
  trusted_key_path="${temp_dir}/gradle-trusted-key.asc"

  mkdir "$gpg_home" || {
    rm -rf "$temp_dir"
    echo "buildish-no-gradle-wrapper-jar: Unable to create a temporary GnuPG home directory." >&2
    return 1
  }

  cat > "$trusted_key_path" <<'EOF'
-----BEGIN PGP PUBLIC KEY BLOCK-----

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
f7TkwC6aybc=
=B8WW
-----END PGP PUBLIC KEY BLOCK-----
EOF

  fingerprint_output=$(LC_ALL=C LANG=C gpg --homedir "$gpg_home" --batch --no-options --show-keys --with-colons --fingerprint "$trusted_key_path" 2>&1)
  if [ $? -ne 0 ]; then
    rm -rf "$temp_dir"
    echo "buildish-no-gradle-wrapper-jar: Unable to inspect pinned Gradle signing key: ${fingerprint_output}" >&2
    return 1
  fi

  actual_fingerprint=$(printf '%s\n' "$fingerprint_output" | awk -F: '$1 == "fpr" { print tolower($10); exit }')
  if [ "$actual_fingerprint" != '1bd97a6a154e7810ee0bc832e2f38302c8075e3d' ]; then
    rm -rf "$temp_dir"
    echo "buildish-no-gradle-wrapper-jar: Pinned Gradle signing key fingerprint mismatch." >&2
    return 1
  fi

  import_output=$(LC_ALL=C LANG=C gpg --homedir "$gpg_home" --batch --no-options --import "$trusted_key_path" 2>&1)
  if [ $? -ne 0 ]; then
    rm -rf "$temp_dir"
    echo "buildish-no-gradle-wrapper-jar: Unable to import pinned Gradle signing key: ${import_output}" >&2
    return 1
  fi

  verify_output=$(LC_ALL=C LANG=C gpg --homedir "$gpg_home" --batch --no-options --no-auto-key-retrieve --verify "$signature_path" "$payload_path" 2>&1)
  if [ $? -ne 0 ]; then
    rm -rf "$temp_dir"
    echo "buildish-no-gradle-wrapper-jar: Detached signature verification failed: ${verify_output}" >&2
    return 1
  fi

  rm -rf "$temp_dir"
  return 0
}

buildish_no_gradle_wrapper_jar_require_command curl
buildish_no_gradle_wrapper_jar_require_command gpg
buildish_no_gradle_wrapper_jar_require_command mktemp

[ -n "${APP_HOME:-}" ] || buildish_no_gradle_wrapper_jar_fail "APP_HOME must already be set by gradlew before including this helper."

BUILDISH_HELPER_WRAPPER_DIR="${APP_HOME}/gradle/wrapper"
BUILDISH_HELPER_PROPERTIES_PATH="${BUILDISH_HELPER_WRAPPER_DIR}/gradle-wrapper.properties"
BUILDISH_HELPER_JAR_PATH="${BUILDISH_HELPER_WRAPPER_DIR}/gradle-wrapper.jar"

[ -f "$BUILDISH_HELPER_PROPERTIES_PATH" ] ||
  buildish_no_gradle_wrapper_jar_fail "Gradle wrapper properties file was not found at '${BUILDISH_HELPER_PROPERTIES_PATH}'."

distribution_line=$(sed -n '/^distributionUrl=/{p;q;}' "$BUILDISH_HELPER_PROPERTIES_PATH")
[ -n "$distribution_line" ] ||
  buildish_no_gradle_wrapper_jar_fail "Gradle wrapper properties file is missing a distributionUrl entry."

distribution_url=$(printf '%s' "$distribution_line" | sed 's/^distributionUrl=//; s/\\:/:/g')
BUILDISH_HELPER_DIST_VERSION=$(printf '%s' "$distribution_url" | sed -n 's#^https://services\.gradle\.org/distributions/gradle-\([0-9][0-9]*\(\.[0-9][0-9]*\)\{1,2\}\)-[A-Za-z][A-Za-z0-9-]*\.zip$#\1#p')

[ -n "$BUILDISH_HELPER_DIST_VERSION" ] ||
  buildish_no_gradle_wrapper_jar_fail "distributionUrl must be a canonical HTTPS services.gradle.org URL ending in gradle-<version>-bin.zip or gradle-<version>-all.zip."

case "$BUILDISH_HELPER_DIST_VERSION" in
  *.*.*) BUILDISH_HELPER_SOURCE_VERSION="$BUILDISH_HELPER_DIST_VERSION" ;;
  *.*) BUILDISH_HELPER_SOURCE_VERSION="${BUILDISH_HELPER_DIST_VERSION}.0" ;;
  *) buildish_no_gradle_wrapper_jar_fail "Unsupported Gradle version '${BUILDISH_HELPER_DIST_VERSION}' in distributionUrl." ;;
esac

BUILDISH_HELPER_SHA256_PATH="${BUILDISH_HELPER_WRAPPER_DIR}/gradle-wrapper-${BUILDISH_HELPER_DIST_VERSION}.sha256"
BUILDISH_HELPER_SIGNATURE_PATH="${BUILDISH_HELPER_WRAPPER_DIR}/gradle-wrapper-${BUILDISH_HELPER_DIST_VERSION}.asc"
BUILDISH_HELPER_SHA256_URL="https://services.gradle.org/distributions/gradle-${BUILDISH_HELPER_DIST_VERSION}-wrapper.jar.sha256"
BUILDISH_HELPER_SIGNATURE_URL="https://services.gradle.org/distributions/gradle-${BUILDISH_HELPER_DIST_VERSION}-wrapper.jar.asc"
BUILDISH_HELPER_JAR_URL="https://raw.githubusercontent.com/gradle/gradle/v${BUILDISH_HELPER_SOURCE_VERSION}/gradle/wrapper/gradle-wrapper.jar"

buildish_no_gradle_wrapper_jar_ensure_metadata_files
expected_wrapper_checksum=$(tr -d '\r\n' < "$BUILDISH_HELPER_SHA256_PATH" | tr '[:upper:]' '[:lower:]')

if [ -f "$BUILDISH_HELPER_JAR_PATH" ]; then
  existing_wrapper_checksum=$(buildish_no_gradle_wrapper_jar_sha256_file "$BUILDISH_HELPER_JAR_PATH")
  if [ "$existing_wrapper_checksum" = "$expected_wrapper_checksum" ] &&
     buildish_no_gradle_wrapper_jar_verify_signature "$BUILDISH_HELPER_SIGNATURE_PATH" "$BUILDISH_HELPER_JAR_PATH"; then
    return 0 2>/dev/null || exit 0
  fi
  rm -f "$BUILDISH_HELPER_JAR_PATH"
fi

downloaded_wrapper_path=$(mktemp "${BUILDISH_HELPER_WRAPPER_DIR}/.buildish-no-gradle-wrapper-jar-wrapper.XXXXXX") ||
  buildish_no_gradle_wrapper_jar_fail "Unable to create a temporary path for the wrapper JAR download."

if ! curl --fail --location --silent --show-error --output "$downloaded_wrapper_path" "$BUILDISH_HELPER_JAR_URL"; then
  rm -f "$downloaded_wrapper_path"
  buildish_no_gradle_wrapper_jar_fail "Unable to download Gradle wrapper JAR from '${BUILDISH_HELPER_JAR_URL}'."
fi

downloaded_wrapper_checksum=$(buildish_no_gradle_wrapper_jar_sha256_file "$downloaded_wrapper_path")
[ "$downloaded_wrapper_checksum" = "$expected_wrapper_checksum" ] || {
  rm -f "$downloaded_wrapper_path"
  buildish_no_gradle_wrapper_jar_fail "Downloaded Gradle wrapper JAR checksum did not match the expected SHA-256."
}

buildish_no_gradle_wrapper_jar_verify_signature "$BUILDISH_HELPER_SIGNATURE_PATH" "$downloaded_wrapper_path" || {
  rm -f "$downloaded_wrapper_path"
  buildish_no_gradle_wrapper_jar_fail "Downloaded Gradle wrapper JAR failed detached signature verification."
}

mv -f "$downloaded_wrapper_path" "$BUILDISH_HELPER_JAR_PATH" || {
  rm -f "$downloaded_wrapper_path"
  buildish_no_gradle_wrapper_jar_fail "Unable to install the verified Gradle wrapper JAR into '${BUILDISH_HELPER_JAR_PATH}'."
}