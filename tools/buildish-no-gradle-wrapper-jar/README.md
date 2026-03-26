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

# Buildish no-gradle-wrapper-jar blueprint

This directory contains a copyable blueprint for projects that want local `gradlew` / `gradlew.bat`
usage without checking `gradle/wrapper/gradle-wrapper.jar` into the source tree.

Projects copy these files into their own `gradle/` directory as:

- `gradle/buildish-no-gradle-wrapper-jar.sh`
- `gradle/buildish-no-gradle-wrapper-jar.ps1`

Then they add one small invocation to their generated `gradlew` / `gradlew.bat`, following the
same include-style approach used by `gradle-wrapper-no-jar`.

## Files in this blueprint

- `buildish-no-gradle-wrapper-jar.sh` — POSIX helper for `gradlew`
- `buildish-no-gradle-wrapper-jar.ps1` — PowerShell helper for Windows / `gradlew.bat`

The helpers are standalone on purpose. They do not import this repository's TypeScript runtime.

## What the helpers do

The helpers read `gradle/wrapper/gradle-wrapper.properties`, derive the configured Gradle version,
and ensure that `gradle/wrapper/gradle-wrapper.jar` is present and verified before Gradle starts.

They mirror the _Apache Buildish Mammoth Cache for Gradle_ action's trust model:

1. require a canonical `https://services.gradle.org/distributions/...` `distributionUrl`
2. download the wrapper JAR checksum from `services.gradle.org`
3. download the wrapper JAR detached signature from `services.gradle.org`
4. download the wrapper JAR bytes from the matching Gradle source tag on GitHub
5. verify the JAR against both:
   - the authoritative SHA-256 checksum
   - the detached OpenPGP signature using pinned Gradle signing keys

The helpers retain the downloaded metadata beside the wrapper properties file as:

- `gradle/wrapper/gradle-wrapper-<version>.sha256`
- `gradle/wrapper/gradle-wrapper-<version>.asc`

They write downloaded files through temporary paths and then move them into place, so partially
written files are not left behind if a download or verification step fails.

## Required tools

### POSIX helper

- POSIX shell
- `curl`
- `gpg`
- `mktemp`
- either `sha256sum` or `shasum`

### PowerShell helper

- Windows PowerShell / PowerShell
- `gpg` / `gpg.exe`
- `Invoke-WebRequest`
- `Get-FileHash`

## How projects adopt the helper

### 1. Copy the helper files into the target project

Copy:

- `tools/buildish-no-gradle-wrapper-jar/buildish-no-gradle-wrapper-jar.sh` -> `gradle/buildish-no-gradle-wrapper-jar.sh`
- `tools/buildish-no-gradle-wrapper-jar/buildish-no-gradle-wrapper-jar.ps1` -> `gradle/buildish-no-gradle-wrapper-jar.ps1`

### 2. Patch `gradlew`

Insert the following line immediately after `APP_HOME` is resolved:

```sh
. "${APP_HOME}/gradle/buildish-no-gradle-wrapper-jar.sh"
```

In current Gradle launchers, that means directly after:

```sh
APP_HOME=$( cd -P "${APP_HOME:-./}" > /dev/null && printf '%s\n' "$PWD" ) || exit
```

### 3. Patch `gradlew.bat`

Insert the following line immediately after the `for %%i in ("%APP_HOME%") do set APP_HOME=%%~fi`
line:

```bat
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%APP_HOME%\gradle\buildish-no-gradle-wrapper-jar.ps1"
```

### 4. Stop tracking `gradle-wrapper.jar`

Projects that want source trees without compiled wrapper binaries should remove
`gradle/wrapper/gradle-wrapper.jar` from version control.

Whether projects also commit the retained `.sha256` / `.asc` files is a policy choice. The helper
works when those files are absent because it will download and retain them locally.

## Customization boundaries

The scripts intentionally assume the same Gradle hosts as the action:

- `services.gradle.org` for checksum and detached signature metadata
- `raw.githubusercontent.com/gradle/gradle/...` for the wrapper JAR bytes

Projects that use custom Gradle distributions or custom wrapper JAR locations will need to adapt
the URLs and, possibly, the trust material.

## Current validation scope in this repository

This repository currently validates the blueprint with focused static / syntax checks. End-to-end
integration coverage for the copied helper flow is intentionally deferred for now.