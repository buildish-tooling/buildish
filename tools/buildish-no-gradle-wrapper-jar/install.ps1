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
PowerShell installer for this helper tool.

The installer assumes it is run against an existing Gradle project that already
contains the generated wrapper launchers and `gradle-wrapper.properties`. It then:
  1. stages the helper files into `gradle/`
  2. removes any existing `gradle-wrapper.jar`
  3. patches `gradlew` / `gradlew.bat` so the helpers execute on every launch
  4. updates `.gitignore` for the retained checksum/signature side files

Safety properties:
  * symlinks / reparse points are rejected rather than followed
  * writes go through temporary files and atomic moves where possible
  * integration tests can supply a trusted local source directory instead of
    downloading helper files from GitHub
#>

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$BuildishToolName = 'buildish-no-gradle-wrapper-jar'
$DefaultBaseUrl = 'https://raw.githubusercontent.com/apache/buildish/main/tools/buildish-no-gradle-wrapper-jar'
$BaseUrl = if ([string]::IsNullOrWhiteSpace($env:BUILDISH_NO_GRADLE_WRAPPER_JAR_BASE_URL)) { $DefaultBaseUrl } else { $env:BUILDISH_NO_GRADLE_WRAPPER_JAR_BASE_URL }
$SourceDirectory = $env:BUILDISH_NO_GRADLE_WRAPPER_JAR_SOURCE_DIR
$TargetDirectory = if ($args.Count -ge 1 -and -not [string]::IsNullOrWhiteSpace($args[0])) { $args[0] } elseif (-not [string]::IsNullOrWhiteSpace($env:BUILDISH_NO_GRADLE_WRAPPER_JAR_TARGET_DIR)) { $env:BUILDISH_NO_GRADLE_WRAPPER_JAR_TARGET_DIR } else { (Get-Location).Path }

# Use UTF-8 without a BOM when rewriting launcher and text files so the output
# remains stable and acceptable to Gradle / shell tooling.
function Get-BuildishUtf8NoBomEncoding {
  return [System.Text.UTF8Encoding]::new($false)
}

# PowerShell on Windows reports symlinks and junctions as reparse points. The
# installer rejects them so it never patches through indirection.
function Test-BuildishReparsePoint {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return $false
  }

  $item = Get-Item -LiteralPath $Path -Force
  return [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

# Shared symlink / reparse-point guard.
function Assert-BuildishNotSymlink {
  param(
    [string]$Path,
    [string]$Label
  )

  if (Test-BuildishReparsePoint -Path $Path) {
    throw "$Label must not be a symbolic link: '$Path'."
  }
}

# Create a temp file path inside the destination directory so the final move is a
# same-volume rename whenever possible.
function New-BuildishInstallTempPath {
  param([string]$Directory)

  return [System.IO.Path]::Combine($Directory, ".buildish-no-gradle-wrapper-jar-install.$([System.IO.Path]::GetRandomFileName())")
}

# Download helper content to a temp file and move it into place only after the
# transfer succeeds.
function Save-BuildishDownloadedFile {
  param(
    [string]$Path,
    [string]$Uri,
    [string]$Label
  )

  Assert-BuildishNotSymlink -Path $Path -Label $Label
  $tempPath = New-BuildishInstallTempPath -Directory $GradleDirectory

  try {
    Invoke-WebRequest -Uri $Uri -OutFile $tempPath -UseBasicParsing -ErrorAction Stop
    Move-Item -LiteralPath $tempPath -Destination $Path -Force
  } catch {
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    throw "Unable to download $Label from '$Uri': $($_.Exception.Message)"
  }
}

# Local-copy variant used by integration tests and trusted development flows.
function Save-BuildishCopiedFile {
  param(
    [string]$Path,
    [string]$SourcePath,
    [string]$Label
  )

  if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
    throw "$Label source file was not found at '$SourcePath'."
  }

  Assert-BuildishNotSymlink -Path $Path -Label $Label
  Assert-BuildishNotSymlink -Path $SourcePath -Label "$Label source file"
  $tempPath = New-BuildishInstallTempPath -Directory $GradleDirectory

  try {
    [System.IO.File]::WriteAllBytes($tempPath, [System.IO.File]::ReadAllBytes($SourcePath))
    Move-Item -LiteralPath $tempPath -Destination $Path -Force
  } catch {
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    throw "Unable to copy $Label from '$SourcePath': $($_.Exception.Message)"
  }
}

# Resolve whether a helper file should come from the trusted local source tree or
# the canonical GitHub raw URL.
function Save-BuildishToolFile {
  param(
    [string]$Path,
    [string]$FileName,
    [string]$Label
  )

  if ([string]::IsNullOrWhiteSpace($SourceDirectoryAbsolute)) {
    Save-BuildishDownloadedFile -Path $Path -Uri "$BaseUrl/$FileName" -Label $Label
  } else {
    Save-BuildishCopiedFile -Path $Path -SourcePath (Join-Path -Path $SourceDirectoryAbsolute -ChildPath $FileName) -Label $Label
  }
}

# Normalize inserted multi-line text to match the target file's existing newline
# convention so patched launchers remain platform-native.
function Convert-BuildishTextToNewlineStyle {
  param(
    [string]$Text,
    [string]$Newline
  )

  return (($Text -split "`r?`n") -join $Newline)
}

# Insert one block after any one of several exact anchor lines unless that block
# is already present.
function Add-BuildishLineAfterAnyAnchor {
  param(
    [string]$Path,
    [string]$Insertion,
    [string]$Label,
    [string[]]$Anchors
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-Warning "$BuildishToolName install: Skipping missing $Label at '$Path'."
    return
  }

  Assert-BuildishNotSymlink -Path $Path -Label $Label
  $content = [System.IO.File]::ReadAllText($Path)

  $newline = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
  $normalizedInsertion = Convert-BuildishTextToNewlineStyle -Text $Insertion -Newline $newline
  if ($content.Contains($normalizedInsertion)) {
    return
  }

  foreach ($anchor in $Anchors) {
    $anchorWithNewline = "$anchor$newline"
    if ($content.Contains($anchorWithNewline)) {
      $updated = $content.Replace($anchorWithNewline, "$anchor$newline$normalizedInsertion$newline")
      [System.IO.File]::WriteAllText($Path, $updated, (Get-BuildishUtf8NoBomEncoding))
      return
    }
    if ($content.EndsWith($anchor)) {
      $updated = $content.Substring(0, $content.Length - $anchor.Length) + "$anchor$newline$normalizedInsertion"
      [System.IO.File]::WriteAllText($Path, $updated, (Get-BuildishUtf8NoBomEncoding))
      return
    }
  }

  throw "Unable to find the expected insertion point in $Label at '$Path'."
}

# Replace one exact generated line when present. Missing lines are tolerated here
# because Gradle launcher shapes evolve; the installer performs a required-line
# assertion afterwards to ensure the supported patched form exists.
function Replace-BuildishLineIfPresent {
  param(
    [string]$Path,
    [string]$CurrentLine,
    [string]$Replacement,
    [string]$Label
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-Warning "$BuildishToolName install: Skipping missing $Label at '$Path'."
    return
  }

  Assert-BuildishNotSymlink -Path $Path -Label $Label
  $content = [System.IO.File]::ReadAllText($Path)
  $newline = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
  $normalizedReplacement = Convert-BuildishTextToNewlineStyle -Text $Replacement -Newline $newline
  if ($content.Contains($normalizedReplacement)) {
    return
  }

  $currentWithNewline = "$CurrentLine$newline"
  if ($content.Contains($currentWithNewline)) {
    $updated = $content.Replace($currentWithNewline, "$normalizedReplacement$newline")
  } elseif ($content.EndsWith($CurrentLine)) {
    $updated = $content.Substring(0, $content.Length - $CurrentLine.Length) + $normalizedReplacement
  } else {
    return
  }

  [System.IO.File]::WriteAllText($Path, $updated, (Get-BuildishUtf8NoBomEncoding))
}

# Exact-line assertion used after patching.
function Assert-BuildishLinePresent {
  param(
    [string]$Path,
    [string]$ExpectedLine,
    [string]$Label
  )

  $content = [System.IO.File]::ReadAllText($Path)
  if (-not ($content -split "`r?`n" | Where-Object { $_ -eq $ExpectedLine } | Select-Object -First 1)) {
    throw "Unable to apply the expected update to $Label at '$Path'."
  }
}

# Variant that accepts any of several supported exact lines.
function Assert-BuildishAnyLinePresent {
  param(
    [string]$Path,
    [string[]]$ExpectedLines,
    [string]$Label
  )

  $content = [System.IO.File]::ReadAllText($Path)
  $lines = $content -split "`r?`n"
  foreach ($expectedLine in $ExpectedLines) {
    if ($lines -contains $expectedLine) {
      return
    }
  }

  throw "Unable to apply the expected update to $Label at '$Path'."
}

# Remove only regular files. This is used to delete an existing wrapper JAR so the
# next Gradle launch must recreate it through the helper's verified download path.
function Remove-BuildishRegularFile {
  param(
    [string]$Path,
    [string]$Label
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  Assert-BuildishNotSymlink -Path $Path -Label $Label
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label must be a regular file: '$Path'."
  }

  Remove-Item -LiteralPath $Path -Force
}

# Add ignore entries for the retained metadata side files while leaving projects
# free to commit them explicitly if that suits their policy.
function Update-BuildishGitignore {
  $gitignorePath = Join-Path -Path $TargetDirectoryAbsolute -ChildPath '.gitignore'
  $commentLine = '# Added by buildish-no-gradle-wrapper-jar'
  $entries = @(
    'gradle/wrapper/gradle-wrapper-*.sha256',
    'gradle/wrapper/gradle-wrapper-*.asc'
  )

  if (Test-Path -LiteralPath $gitignorePath -PathType Leaf) {
    Assert-BuildishNotSymlink -Path $gitignorePath -Label '.gitignore'
    $content = [System.IO.File]::ReadAllText($gitignorePath)
    $newline = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
  } else {
    $content = ''
    $newline = [Environment]::NewLine
  }

  $existingLines = if ([string]::IsNullOrEmpty($content)) { @() } else { $content -split "`r?`n" }
  $missingEntries = @($entries | Where-Object { -not ($existingLines -contains $_) })
  if ($missingEntries.Count -eq 0) {
    return
  }

  $builder = [System.Text.StringBuilder]::new($content)
  if ($builder.Length -gt 0 -and -not $content.EndsWith("`n") -and -not $content.EndsWith("`r")) {
    [void]$builder.Append($newline)
  }
  if ($builder.Length -gt 0) {
    [void]$builder.Append($newline)
  }
  if (-not ($existingLines -contains $commentLine)) {
    [void]$builder.Append($commentLine).Append($newline)
  }
  foreach ($entry in $missingEntries) {
    [void]$builder.Append($entry).Append($newline)
  }

  [System.IO.File]::WriteAllText($gitignorePath, $builder.ToString(), (Get-BuildishUtf8NoBomEncoding))
}

try {
  # Installer entrypoint validation and derived project-local paths.
  if ($args.Count -gt 1) {
    throw 'Expected zero or one positional argument: the target project directory.'
  }
  if (-not (Test-Path -LiteralPath $TargetDirectory -PathType Container)) {
    throw "Target directory does not exist: '$TargetDirectory'."
  }

  $TargetDirectoryAbsolute = (Resolve-Path -LiteralPath $TargetDirectory).Path
  $SourceDirectoryAbsolute = if ([string]::IsNullOrWhiteSpace($SourceDirectory)) { '' } else { (Resolve-Path -LiteralPath $SourceDirectory).Path }
  $GradleDirectory = Join-Path -Path $TargetDirectoryAbsolute -ChildPath 'gradle'
  $WrapperDirectory = Join-Path -Path $GradleDirectory -ChildPath 'wrapper'
  $GradlePropertiesPath = Join-Path -Path $WrapperDirectory -ChildPath 'gradle-wrapper.properties'
  $GradleWrapperJarPath = Join-Path -Path $WrapperDirectory -ChildPath 'gradle-wrapper.jar'
  $GradlewPath = Join-Path -Path $TargetDirectoryAbsolute -ChildPath 'gradlew'
  $GradlewBatPath = Join-Path -Path $TargetDirectoryAbsolute -ChildPath 'gradlew.bat'
  $GradleInitScriptPath = Join-Path -Path $GradleDirectory -ChildPath 'buildish-no-gradle-wrapper-jar.init.gradle.kts'

  # Windows launcher patch structure: first capture helper-emitted arguments into
  # an environment variable, then splice that variable into the final Java line.
  # The pre-8.14 classpath/main-class form plus the later `-jar` forms are
  # supported so the installer spans multiple Gradle minor lines explicitly.
  $GradlewBatHelperBlock = @'
set BUILDISH_NO_GRADLE_WRAPPER_JAR_ORIGINAL_ARGS=%*
set BUILDISH_NO_GRADLE_WRAPPER_JAR_ARGS=
for /f "delims=" %%a in ('powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%APP_HOME%\gradle\buildish-no-gradle-wrapper-jar.ps1"') do @set BUILDISH_NO_GRADLE_WRAPPER_JAR_ARGS=%%a
set BUILDISH_NO_GRADLE_WRAPPER_JAR_ORIGINAL_ARGS=
if errorlevel 1 goto fail
'@
  $GradlewBatOldExecuteLine = '"%JAVA_EXE%" %DEFAULT_JVM_OPTS% %JAVA_OPTS% %GRADLE_OPTS% "-Dorg.gradle.appname=%APP_BASE_NAME%" -classpath "%CLASSPATH%" org.gradle.wrapper.GradleWrapperMain %*'
  $GradlewBatPatchedOldExecuteLine = '"%JAVA_EXE%" %DEFAULT_JVM_OPTS% %JAVA_OPTS% %GRADLE_OPTS% "-Dorg.gradle.appname=%APP_BASE_NAME%" -classpath "%CLASSPATH%" org.gradle.wrapper.GradleWrapperMain %BUILDISH_NO_GRADLE_WRAPPER_JAR_ARGS% %*'
  $GradlewBatLegacyExecuteLine = '"%JAVA_EXE%" %DEFAULT_JVM_OPTS% %JAVA_OPTS% %GRADLE_OPTS% "-Dorg.gradle.appname=%APP_BASE_NAME%" -classpath "%CLASSPATH%" -jar "%APP_HOME%\gradle\wrapper\gradle-wrapper.jar" %*'
  $GradlewBatPatchedLegacyExecuteLine = '"%JAVA_EXE%" %DEFAULT_JVM_OPTS% %JAVA_OPTS% %GRADLE_OPTS% "-Dorg.gradle.appname=%APP_BASE_NAME%" -classpath "%CLASSPATH%" -jar "%APP_HOME%\gradle\wrapper\gradle-wrapper.jar" %BUILDISH_NO_GRADLE_WRAPPER_JAR_ARGS% %*'
  $GradlewBatCurrentExecuteLine = '"%JAVA_EXE%" %DEFAULT_JVM_OPTS% %JAVA_OPTS% %GRADLE_OPTS% "-Dorg.gradle.appname=%APP_BASE_NAME%" -jar "%APP_HOME%\gradle\wrapper\gradle-wrapper.jar" %*'
  $GradlewBatPatchedCurrentExecuteLine = '"%JAVA_EXE%" %DEFAULT_JVM_OPTS% %JAVA_OPTS% %GRADLE_OPTS% "-Dorg.gradle.appname=%APP_BASE_NAME%" -jar "%APP_HOME%\gradle\wrapper\gradle-wrapper.jar" %BUILDISH_NO_GRADLE_WRAPPER_JAR_ARGS% %*'

  if (-not (Test-Path -LiteralPath $GradlePropertiesPath -PathType Leaf)) {
    throw "Gradle wrapper properties file was not found at '$GradlePropertiesPath'. Run this installer from a Gradle project root or pass that directory as the only argument."
  }
  Assert-BuildishNotSymlink -Path $GradlePropertiesPath -Label 'gradle-wrapper.properties'
  # The helper verifies `gradle-wrapper.jar`, but it does not make Gradle start
  # verifying the distribution ZIP automatically. Emit a prominent installer-time
  # warning so adopters notice the missing checksum pin immediately.
  if (-not (Select-String -Path $GradlePropertiesPath -Pattern '^distributionSha256Sum=\S' -Quiet)) {
    Write-Warning "$BuildishToolName install: WARNING: '$GradlePropertiesPath' does not define distributionSha256Sum. Gradle itself will not pin the distribution ZIP checksum during wrapper downloads; this helper continues, but it only verifies gradle-wrapper.jar."
  }

  # Stage helper files before patching launchers so every inserted path points to
  # an existing project-local script.
  Save-BuildishToolFile -Path (Join-Path -Path $GradleDirectory -ChildPath 'buildish-no-gradle-wrapper-jar.sh') -FileName 'buildish-no-gradle-wrapper-jar.sh' -Label 'POSIX helper script'
  Save-BuildishToolFile -Path (Join-Path -Path $GradleDirectory -ChildPath 'buildish-no-gradle-wrapper-jar.ps1') -FileName 'buildish-no-gradle-wrapper-jar.ps1' -Label 'PowerShell helper script'
  Save-BuildishToolFile -Path $GradleInitScriptPath -FileName 'buildish-no-gradle-wrapper-jar.init.gradle.kts' -Label 'Gradle init script'
  Remove-BuildishRegularFile -Path $GradleWrapperJarPath -Label 'gradle-wrapper.jar'

  # Patch the launchers and then assert that a supported final batch execute line
  # is present so new unsupported launcher shapes fail loudly during install.
  Add-BuildishLineAfterAnyAnchor -Path $GradlewPath -Insertion '. "${APP_HOME}/gradle/buildish-no-gradle-wrapper-jar.sh"' -Label 'gradlew' -Anchors @('APP_HOME=$( cd -P "${APP_HOME:-./}" > /dev/null && printf ''%s\n'' "$PWD" ) || exit', 'APP_HOME=$( cd "${APP_HOME:-./}" && pwd -P ) || exit')
  Replace-BuildishLineIfPresent -Path $GradlewBatPath -CurrentLine 'powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%APP_HOME%\gradle\buildish-no-gradle-wrapper-jar.ps1"' -Replacement $GradlewBatHelperBlock -Label 'gradlew.bat'
  Add-BuildishLineAfterAnyAnchor -Path $GradlewBatPath -Insertion $GradlewBatHelperBlock -Label 'gradlew.bat' -Anchors @('for %%i in ("%APP_HOME%") do set APP_HOME=%%~fi')
  Replace-BuildishLineIfPresent -Path $GradlewBatPath -CurrentLine $GradlewBatOldExecuteLine -Replacement $GradlewBatPatchedOldExecuteLine -Label 'gradlew.bat'
  Replace-BuildishLineIfPresent -Path $GradlewBatPath -CurrentLine $GradlewBatLegacyExecuteLine -Replacement $GradlewBatPatchedLegacyExecuteLine -Label 'gradlew.bat'
  Replace-BuildishLineIfPresent -Path $GradlewBatPath -CurrentLine $GradlewBatCurrentExecuteLine -Replacement $GradlewBatPatchedCurrentExecuteLine -Label 'gradlew.bat'
  Assert-BuildishAnyLinePresent -Path $GradlewBatPath -ExpectedLines @($GradlewBatPatchedOldExecuteLine, $GradlewBatPatchedLegacyExecuteLine, $GradlewBatPatchedCurrentExecuteLine) -Label 'gradlew.bat'
  Update-BuildishGitignore

  Write-Host "$BuildishToolName install: Installed helper files into '$GradleDirectory' and updated launcher scripts in '$TargetDirectoryAbsolute'."
} catch {
  Write-Error "$BuildishToolName install: $($_.Exception.Message)"
  exit 1
}