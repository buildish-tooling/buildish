<#
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
#>

<#
This helper is invoked from `gradlew.bat` after `%APP_HOME%` has been resolved.

High-level behavior:
  1. Optionally emit a project-local `--init-script ...` argument fragment so the
     wrapper update path keeps the launcher patches installed by this tool.
  2. Read `gradle-wrapper.properties` to determine the requested Gradle version.
  3. Ensure the detached-signature metadata files for that version exist.
  4. Verify any existing `gradle-wrapper.jar` against the expected checksum and
     the pinned Gradle public signing key.
  5. Download and install a replacement JAR if the local one is missing or fails
     validation.

The PowerShell helper prints only the extra command-line fragment to stdout. The
patched batch launcher captures that output into an environment variable and then
appends it to the final Java invocation. Doing it that way avoids trying to mutate
`%*` from a child process, which is brittle in cmd.exe.
#>

Import-Module $PSHOME\Modules\Microsoft.PowerShell.Utility -Function Get-FileHash

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# This fingerprint is the trust root for detached-signature verification. We pin
# the exact Gradle signing key and verify the fingerprint before importing it into
# the temporary GPG home used for each validation run.
$TrustedGradleKeyFingerprint = '1bd97a6a154e7810ee0bc832e2f38302c8075e3d'
$TrustedGradlePublicKey = @'
-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBGOtCzoBEAC7hGOPLFnfvQKzCZpJb3QYq8X9OiUL4tVa5mG0lDTeBBiuQCDy
Iyhpo8IypllGG6Wxj6ZJbhuHXcnXSu/atmtrnnjARMvDnQ20jX77B+g39ZYuqxgw
F/EkDYC6gtNUqzJ8IcxFMIQT+J6LCd3a/eTJWwDLUwSnGXVUPTXzYf4laSVdBDVp
jp6K+tDHQrLZ140DY4GSvT1SzcgR5+5C1Mda3XobIJNHe47AeZPzKuFzZSlKqvrX
QNexgGGjrEDWt9I3CXeNoOVVZvI2k6jAvUSZb+jN/YWpW+onDeV1S/7AUBaKE2TE
EJtidYIOuFsufSwLURwX0um17M47sgzxov9vZYDucGntZn4zKYcZsdkTTkrrgU7N
RSu90mqdL7rCxkUPsSeEUWFyhleGB108QBa5HiE/Z5T5C94kxD9JV1HAocFraTaZ
SrNr0dBvZH7SoLCUQZ6q3gXebLbLQgDSuApjn523927O1wdnig+xDgAqTP14sw9i
9OfvpNhCSolFL7mjGYKGfzTFo4pj5CzoKvvAXcsWY4HvwslWJvmrEqvo8Ss+YTII
fiRSL4DWurT+42yOoExPwcYNofNwEuyYy5Zr9edsXeodScvy/hlri3JuB3Ji142w
xFCuKUfrAh7hOw6QOXgIFyFXWrW0HH/8IoeJjxvG+6euxkGx8QZutyaY6wARAQAB
tClHcmFkbGUgSW5jLiA8bWF2ZW4tcHVibGlzaGluZ0BncmFkbGUuY29tPokCUQQT
AQgAOxYhBBvZemoVTngQ7gvIMuLzgwLIB149BQJjrQs6AhsDBQsJCAcCAiICBhUK
CQgLAgQWAgMBAh4HAheAAAoJEOLzgwLIB1491PkQAJLhZivNlDcMNGZb5f5PVUiz
6iZ/q62D6gD00NAE5JAxM9JugoNeRrjhibnAN2rwAlv6yW6Thc8dRZ/t/PrzivO5
f3f+P8rLd+M6XTStSXsDPaCNFl002ZJWeH40AQCw8vwgXL0oIvT2qyvJ+Y3/vJUg
vSCB1O1xKfs8jylb6oZKA4C4lv60IR3jLBb4BneTqXn5ZCHJt4g7+TY2jNY8fQeb
V0Sbq+W/3kcUry8Na0TnffdDP/yuonNx0jYNi72Bb5qoCv++L86WLDmVNbCaNhEf
JA1UGvaMDSn1bVop6bZ431t7omPjTwmoB3maHo2HKHQebzSIoTCanEtFgnffW5gT
LVwif8r97ipJgN3ohdhIdgY7bSKRoUugr3UlST9ScNFpz2Dw+IKWR1A4B8BPz2tc
/TXowLS3fc0DHJJYd5WqCyBTl9ndXTiRb8ImO4RdYyfbv+KfmWh93Cj9fBrN654S
RFGjilcJlZR7Vxn9m+E6tDxUI/fs0GWMf/9UY+jAJMPv3W1/7RMihGQfw51lXnnS
Jz9u6xJJKK5KL4L0hFYyfv2Zs24BQTq+h3lFDpPB4pfgDLm+Tbf7V0VlXUwAt3rq
FxsxxxIut6+0DcfsqWPUfu0wnSpNzKqwS/36hUDwFX+yBZU4kyTn1PMVvyxcXi3j
bcHUw1QpCiEeMi7FTjFhuQINBGOtCzoBEADSUdEj7dz3jsz4EObAdNXnZnJ5zAkq
E4zbGtU94sXdBtxD1F++5dTNE0ZCVwJLtZnYvxYXYwHBEDB5ZWS7noTL9rXkgXpD
P5WGVLTYIMiGjPkVu2fWZZ78Tu4KIfRnkWdUoMQ2g7YNZ8cVU40cZlk63tRdt7Th
71g+K/RKWdqh7NK0laualahK+Glped0QEo1TfrEhNgT0JUCwWzuM4qWHDys7itF+
+xLJsPSwS/wAUqvsWqGzW/1KrYbbxgKX4vbrqL3jnk4IHvcKAub0uchLv9KR5Qps
VT86TmOB3WsAAlPdosW/ahAc2/XyiCxv5JEo8YpErBZ5TSgUy7lJNABS0JUVCeUC
q/AAZ2TScOwRX8aXCeYASfRHOZCiWrWy5nMGGnXVs42MMIML9d+Hr37BCCFT3Gbw
8WOTeGleE92sed5dBAjOPyQWP+IvYxF7zOyNs46RAVlJfg3G33VwEBQgJwLSl/sU
YqSHe9QubbxI0fiMsTJdZ6/5fbsXVnMbGe4kQDZbDTgylotiHfMCMNefgb0+yA6F
w+EHQeN/v/AtpcpT0w12AOpmlNy4+zPQE8Ai73gtJeTRpiuob3k1/JwvLHemB14C
txBGiHAyYHCjPqTPyQUIikj+R8mecG/60RfSmGe3HW7Hpt907BNEcc4s4V9uvJPH
IJdZS/gmtSp5VQARAQABiQI2BBgBCAAgFiEEG9l6ahVOeBDuC8gy4vODAsgHXj0F
AmOtCzoCGwwACgkQ4vODAsgHXj0ZAhAApDNUMc5H7Zsm5vC9F71CZBO29arMuiYV
P/k6oHWbJHu6VWOU9cn/FKnXcIF6H9WcaV/lshARxGsuXWwvW3MP79bINXBuxOYr
Mc2dEGXoRR6YyTqs8NmQumddWeTAZa1DXLAm6U/KpyuU7aShfJoNcdSOi+pLKyJJ
vM85zGYYeA2c3wD++5VaqFV4ptqa4dkbwNf9KSKPNn30Vm2BaCFaHyR7a3TJTZDr
Po+o7Mj75OlCsSz/UZFMOv5DnPU8dOeP7iaetXXqezKhVzJ6dbUgxPh+IRDOfi+L
ySR73YUgW/JHDfyAkeHPmsmSGWeW7hDsWlgiwBNVOIjEqOLyhsMV+aXHnJ28F25u
QhcnOeITIFYR7f+O/D64aEq2jx2nXQ0URU1CCZI2jlcofUTSOVLDgaK8mcc5Yrs2
ybcOYjDVtKCswfTwIrzEOG7ME/opHnv3GzwBlxUI7xp5d5ZQsLHREwHvVrI3QxxJ
h2eNTGMpg3jZdJ7/fPYuZ5FZvALl5A9w22h3lOuy3+ooWwh7X5iV1lNSSgGft1mh
SRv3NcygIVkxsMTzdOoTDp+GohoM6VJyW45xIbEHtyy9byCtvLIhOOSXXIN3TZz8
+T1wROd4CFsC8Ee2aL6yYTTSDyD+LV1qeuDKX5t/MnegA52oEsFWXay7rkg9TwZw
f7TkwC6aybc=
=B8WW
-----END PGP PUBLIC KEY BLOCK-----
'@

# Locate the first available command from a preference-ordered name list. This is
# primarily used to find `gpg.exe` / `gpg` without assuming a specific filename.
function Get-BuildishNoGradleWrapperJarCommandPath {
  param([string[]]$Names)

  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -ne $command) {
      return $command.Source
    }
  }

  return $null
}

# Create a unique temporary path inside a caller-selected directory. Callers write
# to the temp path first and move into place afterwards to avoid leaving partial
# files behind.
function New-BuildishNoGradleWrapperJarTempPath {
  param([string]$Directory)

  return [System.IO.Path]::Combine($Directory, ".buildish-no-gradle-wrapper-jar.$([System.IO.Path]::GetRandomFileName())")
}

# Write ASCII text deterministically. The checksum and armored-signature files are
# specified as ASCII, and using a fixed encoding avoids host-dependent defaults.
function Write-BuildishNoGradleWrapperJarAsciiFile {
  param(
    [string]$Path,
    [string]$Content
  )

  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.Encoding]::ASCII)
}

# Quote one argument using the Windows command-line escaping rules expected by the
# eventual Java process. The helper emits this quoted fragment back to cmd.exe.
function ConvertTo-BuildishWindowsCommandLineArgument {
  param([string]$Argument)

  if ($Argument -notmatch '[\s"]') {
    return $Argument
  }

  $builder = [System.Text.StringBuilder]::new()
  $backslash = [char]92
  [void]$builder.Append('"')
  $backslashCount = 0

  foreach ($character in $Argument.ToCharArray()) {
    if ($character -eq $backslash) {
      $backslashCount += 1
      continue
    }

    if ($character -eq '"') {
      [void]$builder.Append($backslash, $backslashCount * 2 + 1)
      [void]$builder.Append('"')
      $backslashCount = 0
      continue
    }

    if ($backslashCount -gt 0) {
      [void]$builder.Append($backslash, $backslashCount)
      $backslashCount = 0
    }

    [void]$builder.Append($character)
  }

  if ($backslashCount -gt 0) {
    [void]$builder.Append($backslash, $backslashCount * 2)
  }

  [void]$builder.Append('"')
  return $builder.ToString()
}

# Decide whether the helper needs to inject the tool-local init script argument.
# The check deliberately looks for the exact project-local path so it does not add
# duplicate `--init-script` fragments on repeated wrapper invocations.
function Get-BuildishNoGradleWrapperJarInjectedInitScriptArguments {
  param([string]$InitScriptPath)

  if (-not (Test-Path -LiteralPath $InitScriptPath -PathType Leaf)) {
    return ''
  }

  $originalArguments = $env:BUILDISH_NO_GRADLE_WRAPPER_JAR_ORIGINAL_ARGS
  if (-not [string]::IsNullOrWhiteSpace($originalArguments) -and
      $originalArguments.IndexOf($InitScriptPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
    return ''
  }

  return "--init-script $(ConvertTo-BuildishWindowsCommandLineArgument -Argument $InitScriptPath)"
}

# Read, validate, normalize, and return the expected SHA-256 value from a cached
# checksum file. The normalized file is written back so later comparisons use a
# stable format.
function Get-BuildishNoGradleWrapperJarExpectedSha256 {
  param([string]$Path)

  $checksum = (Get-Content -LiteralPath $Path -Raw).Trim().ToLowerInvariant()
  if ($checksum -notmatch '^[0-9a-f]{64}$') {
    throw "Wrapper checksum file '$Path' did not contain a valid SHA-256 value."
  }
  Write-BuildishNoGradleWrapperJarAsciiFile -Path $Path -Content "$checksum`n"
  return $checksum
}

# Lightweight structural check for detached-signature cache files. Full crypto
# verification happens later; this just filters out obviously wrong content.
function Test-BuildishNoGradleWrapperJarSignatureFile {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $false
  }

  $firstLine = Get-Content -LiteralPath $Path -TotalCount 1
  return $firstLine -eq '-----BEGIN PGP SIGNATURE-----'
}

# Download a file to a temp path, optionally validate it, then move it into place.
# This keeps the cache directory free of partial or unvalidated results.
function Save-BuildishNoGradleWrapperJarDownloadedFile {
  param(
    [string]$Path,
    [string]$Uri,
    [string]$Label,
    [scriptblock]$Validator
  )

  $tempPath = New-BuildishNoGradleWrapperJarTempPath -Directory $GradleWrapperDirectory
  try {
    Invoke-WebRequest -Uri $Uri -OutFile $tempPath -UseBasicParsing -ErrorAction Stop
    if ($null -ne $Validator) {
      & $Validator $tempPath
    }
    Move-Item -LiteralPath $tempPath -Destination $Path -Force
  } catch {
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    throw "Unable to download $Label from '$Uri': $($_.Exception.Message)"
  }
}

# Ensure the per-version checksum and detached-signature files are present and
# minimally well formed before the wrapper JAR is trusted or downloaded.
function Ensure-BuildishNoGradleWrapperJarMetadataFiles {
  if (-not (Test-Path -LiteralPath $GradleWrapperSha256Path -PathType Leaf)) {
    Save-BuildishNoGradleWrapperJarDownloadedFile -Path $GradleWrapperSha256Path -Uri $GradleWrapperSha256Url -Label 'wrapper checksum' -Validator {
      param($DownloadedPath)
      [void](Get-BuildishNoGradleWrapperJarExpectedSha256 -Path $DownloadedPath)
    }
  } else {
    try {
      [void](Get-BuildishNoGradleWrapperJarExpectedSha256 -Path $GradleWrapperSha256Path)
    } catch {
      Remove-Item -LiteralPath $GradleWrapperSha256Path -Force -ErrorAction SilentlyContinue
      Save-BuildishNoGradleWrapperJarDownloadedFile -Path $GradleWrapperSha256Path -Uri $GradleWrapperSha256Url -Label 'wrapper checksum' -Validator {
        param($DownloadedPath)
        [void](Get-BuildishNoGradleWrapperJarExpectedSha256 -Path $DownloadedPath)
      }
    }
  }

  if (-not (Test-BuildishNoGradleWrapperJarSignatureFile -Path $GradleWrapperSignaturePath)) {
    Remove-Item -LiteralPath $GradleWrapperSignaturePath -Force -ErrorAction SilentlyContinue
    Save-BuildishNoGradleWrapperJarDownloadedFile -Path $GradleWrapperSignaturePath -Uri $GradleWrapperSignatureUrl -Label 'wrapper detached signature' -Validator {
      param($DownloadedPath)
      if (-not (Test-BuildishNoGradleWrapperJarSignatureFile -Path $DownloadedPath)) {
        throw "Downloaded wrapper detached signature was not valid ASCII-armored OpenPGP data."
      }
    }
  }
}

# Perform detached-signature verification in a fresh temporary GPG home. This
# makes the result independent of the caller's personal keyring, trust database,
# or auto-key retrieval settings.
function Test-BuildishNoGradleWrapperJarDetachedSignature {
  param(
    [string]$SignaturePath,
    [string]$PayloadPath,
    [string]$GpgCommand
  )

  $tempDirectory = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath "buildish-no-gradle-wrapper-jar-gpg-$([System.Guid]::NewGuid())"
  $gpgHome = Join-Path -Path $tempDirectory -ChildPath 'home'
  $trustedKeyPath = Join-Path -Path $tempDirectory -ChildPath 'gradle-trusted-key.asc'

  try {
    New-Item -ItemType Directory -Path $gpgHome -Force | Out-Null
    Write-BuildishNoGradleWrapperJarAsciiFile -Path $trustedKeyPath -Content $TrustedGradlePublicKey

    $fingerprintOutput = (& $GpgCommand --homedir $gpgHome --batch --no-options --show-keys --with-colons --fingerprint $trustedKeyPath 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
      throw "Unable to inspect pinned Gradle signing key: $fingerprintOutput"
    }

    $fingerprintLine = ($fingerprintOutput -split "`r?`n" | Where-Object { $_.StartsWith('fpr:') } | Select-Object -First 1)
    if ([string]::IsNullOrWhiteSpace($fingerprintLine)) {
      throw 'Pinned Gradle signing key did not expose a primary fingerprint.'
    }

    $actualFingerprint = $fingerprintLine.Split(':')[9].ToLowerInvariant()
    if ($actualFingerprint -ne $TrustedGradleKeyFingerprint) {
      throw 'Pinned Gradle signing key fingerprint mismatch.'
    }

    $importOutput = (& $GpgCommand --homedir $gpgHome --batch --no-options --import $trustedKeyPath 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
      throw "Unable to import pinned Gradle signing key: $importOutput"
    }

    $verifyOutput = (& $GpgCommand --homedir $gpgHome --batch --no-options --no-auto-key-retrieve --verify $SignaturePath $PayloadPath 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
      throw "Detached signature verification failed: $verifyOutput"
    }
  } finally {
    Remove-Item -LiteralPath $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}

try {
  # The patched batch launcher resolves APP_HOME before invoking this helper.
  if ([string]::IsNullOrWhiteSpace($env:APP_HOME)) {
    throw 'APP_HOME must already be set by gradlew.bat before invoking this helper.'
  }

  # Detached-signature verification is mandatory; if GnuPG is unavailable the
  # helper must fail closed rather than silently trusting downloaded bytes.
  $GpgCommand = Get-BuildishNoGradleWrapperJarCommandPath -Names @('gpg.exe', 'gpg')
  if ([string]::IsNullOrWhiteSpace($GpgCommand)) {
    throw "GnuPG command 'gpg.exe' is required for Gradle wrapper detached-signature verification but was not found on PATH."
  }

  # All paths are project-local and derived from the existing Gradle launcher
  # layout expected by the installer.
  $GradleWrapperDirectory = Join-Path -Path $env:APP_HOME -ChildPath 'gradle\wrapper'
  $GradlePropertiesPath = Join-Path -Path $GradleWrapperDirectory -ChildPath 'gradle-wrapper.properties'
  $GradleWrapperJarPath = Join-Path -Path $GradleWrapperDirectory -ChildPath 'gradle-wrapper.jar'

  if (-not (Test-Path -LiteralPath $GradlePropertiesPath -PathType Leaf)) {
    throw "Gradle wrapper properties file was not found at '$GradlePropertiesPath'."
  }

  $distributionLine = (Select-String -Path $GradlePropertiesPath -CaseSensitive -Pattern '^distributionUrl=' | Select-Object -First 1).Line
  if ([string]::IsNullOrWhiteSpace($distributionLine)) {
    throw 'Gradle wrapper properties file is missing a distributionUrl entry.'
  }

  # Only accept canonical services.gradle.org URLs so the checksum, signature,
  # and source-JAR URLs can be derived predictably and reviewed easily.
  $distributionUrl = $distributionLine.Substring('distributionUrl='.Length).Replace('\:', ':')
  $distributionMatch = [regex]::Match($distributionUrl, '^https://services\.gradle\.org/distributions/gradle-([0-9]+(?:\.[0-9]+){1,2})-(?:bin|all)\.zip$')
  if (-not $distributionMatch.Success) {
    throw 'distributionUrl must be a canonical HTTPS services.gradle.org URL ending in gradle-<version>-bin.zip or gradle-<version>-all.zip.'
  }

  $GradleDistributionVersion = $distributionMatch.Groups[1].Value
  $versionSegments = $GradleDistributionVersion.Split('.')
  # Gradle Git tags use three numeric segments, so normalize `8.3` to `8.3.0`
  # before building the GitHub raw URL for `gradle-wrapper.jar`.
  switch ($versionSegments.Count) {
    2 { $GradleSourceVersion = "$GradleDistributionVersion.0" }
    3 { $GradleSourceVersion = $GradleDistributionVersion }
    default { throw "Unsupported Gradle version '$GradleDistributionVersion' in distributionUrl." }
  }

  $GradleWrapperSha256Path = Join-Path -Path $GradleWrapperDirectory -ChildPath "gradle-wrapper-$GradleDistributionVersion.sha256"
  $GradleWrapperSignaturePath = Join-Path -Path $GradleWrapperDirectory -ChildPath "gradle-wrapper-$GradleDistributionVersion.asc"
  $GradleWrapperSha256Url = "https://services.gradle.org/distributions/gradle-$GradleDistributionVersion-wrapper.jar.sha256"
  $GradleWrapperSignatureUrl = "https://services.gradle.org/distributions/gradle-$GradleDistributionVersion-wrapper.jar.asc"
  $GradleWrapperJarUrl = "https://raw.githubusercontent.com/gradle/gradle/v$GradleSourceVersion/gradle/wrapper/gradle-wrapper.jar"
  $GradleInitScriptPath = Join-Path -Path $env:APP_HOME -ChildPath 'gradle\buildish-no-gradle-wrapper-jar.init.gradle.kts'
  $wrapperJarReady = $false

  # Metadata is cached project-locally so repeated runs can validate an existing
  # wrapper JAR without always redownloading the side files.
  Ensure-BuildishNoGradleWrapperJarMetadataFiles
  $ExpectedWrapperSha256 = Get-BuildishNoGradleWrapperJarExpectedSha256 -Path $GradleWrapperSha256Path

  # Fast path: if the current wrapper JAR already matches the expected checksum
  # and validates against the detached signature, keep it.
  if (Test-Path -LiteralPath $GradleWrapperJarPath -PathType Leaf) {
    try {
      $existingChecksum = (Get-FileHash -LiteralPath $GradleWrapperJarPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($existingChecksum -eq $ExpectedWrapperSha256) {
        Test-BuildishNoGradleWrapperJarDetachedSignature -SignaturePath $GradleWrapperSignaturePath -PayloadPath $GradleWrapperJarPath -GpgCommand $GpgCommand
        $wrapperJarReady = $true
      }
    } catch {
      Write-Warning "Existing Gradle wrapper JAR verification failed; the helper will re-download it. $($_.Exception.Message)"
    }

    if (-not $wrapperJarReady) {
      Remove-Item -LiteralPath $GradleWrapperJarPath -Force -ErrorAction SilentlyContinue
    }
  }

  # Slow path: download, verify, and install a fresh wrapper JAR.
  if (-not $wrapperJarReady) {
    $downloadedWrapperPath = New-BuildishNoGradleWrapperJarTempPath -Directory $GradleWrapperDirectory
    try {
      Invoke-WebRequest -Uri $GradleWrapperJarUrl -OutFile $downloadedWrapperPath -UseBasicParsing -ErrorAction Stop
      $downloadedChecksum = (Get-FileHash -LiteralPath $downloadedWrapperPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($downloadedChecksum -ne $ExpectedWrapperSha256) {
        throw 'Downloaded Gradle wrapper JAR checksum did not match the expected SHA-256.'
      }

      Test-BuildishNoGradleWrapperJarDetachedSignature -SignaturePath $GradleWrapperSignaturePath -PayloadPath $downloadedWrapperPath -GpgCommand $GpgCommand
      Move-Item -LiteralPath $downloadedWrapperPath -Destination $GradleWrapperJarPath -Force
    } finally {
      Remove-Item -LiteralPath $downloadedWrapperPath -Force -ErrorAction SilentlyContinue
    }
  }

  # The patched batch launcher consumes this single line of stdout and appends it
  # to the final Java invocation. Returning an empty string is the idempotent case.
  [Console]::Out.WriteLine((Get-BuildishNoGradleWrapperJarInjectedInitScriptArguments -InitScriptPath $GradleInitScriptPath))
} catch {
  Write-Error "buildish-no-gradle-wrapper-jar: $($_.Exception.Message)"
  exit 1
}