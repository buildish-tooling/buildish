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

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$BuildishToolName = 'buildish-no-gradle-wrapper-jar'
$DefaultBaseUrl = 'https://raw.githubusercontent.com/apache/buildish/main/tools/buildish-no-gradle-wrapper-jar'
$BaseUrl = if ([string]::IsNullOrWhiteSpace($env:BUILDISH_NO_GRADLE_WRAPPER_JAR_BASE_URL)) { $DefaultBaseUrl } else { $env:BUILDISH_NO_GRADLE_WRAPPER_JAR_BASE_URL }
$TargetDirectory = if ($args.Count -ge 1 -and -not [string]::IsNullOrWhiteSpace($args[0])) { $args[0] } elseif (-not [string]::IsNullOrWhiteSpace($env:BUILDISH_NO_GRADLE_WRAPPER_JAR_TARGET_DIR)) { $env:BUILDISH_NO_GRADLE_WRAPPER_JAR_TARGET_DIR } else { (Get-Location).Path }

function Get-BuildishUtf8NoBomEncoding {
  return [System.Text.UTF8Encoding]::new($false)
}

function Test-BuildishReparsePoint {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return $false
  }

  $item = Get-Item -LiteralPath $Path -Force
  return [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

function Assert-BuildishNotSymlink {
  param(
    [string]$Path,
    [string]$Label
  )

  if (Test-BuildishReparsePoint -Path $Path) {
    throw "$Label must not be a symbolic link: '$Path'."
  }
}

function New-BuildishInstallTempPath {
  param([string]$Directory)

  return [System.IO.Path]::Combine($Directory, ".buildish-no-gradle-wrapper-jar-install.$([System.IO.Path]::GetRandomFileName())")
}

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

function Add-BuildishLineAfterAnchor {
  param(
    [string]$Path,
    [string]$Anchor,
    [string]$Insertion,
    [string]$Label
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-Warning "$BuildishToolName install: Skipping missing $Label at '$Path'."
    return
  }

  Assert-BuildishNotSymlink -Path $Path -Label $Label
  $content = [System.IO.File]::ReadAllText($Path)
  if ($content.Contains($Insertion)) {
    return
  }

  $newline = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
  $anchorWithNewline = "$Anchor$newline"
  if ($content.Contains($anchorWithNewline)) {
    $updated = $content.Replace($anchorWithNewline, "$Anchor$newline$Insertion$newline")
  } elseif ($content.EndsWith($Anchor)) {
    $updated = $content.Substring(0, $content.Length - $Anchor.Length) + "$Anchor$newline$Insertion"
  } else {
    throw "Unable to find the expected insertion point in $Label at '$Path'."
  }

  [System.IO.File]::WriteAllText($Path, $updated, (Get-BuildishUtf8NoBomEncoding))
}

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
  if ($args.Count -gt 1) {
    throw 'Expected zero or one positional argument: the target project directory.'
  }
  if (-not (Test-Path -LiteralPath $TargetDirectory -PathType Container)) {
    throw "Target directory does not exist: '$TargetDirectory'."
  }

  $TargetDirectoryAbsolute = (Resolve-Path -LiteralPath $TargetDirectory).Path
  $GradleDirectory = Join-Path -Path $TargetDirectoryAbsolute -ChildPath 'gradle'
  $WrapperDirectory = Join-Path -Path $GradleDirectory -ChildPath 'wrapper'
  $GradlePropertiesPath = Join-Path -Path $WrapperDirectory -ChildPath 'gradle-wrapper.properties'
  $GradlewPath = Join-Path -Path $TargetDirectoryAbsolute -ChildPath 'gradlew'
  $GradlewBatPath = Join-Path -Path $TargetDirectoryAbsolute -ChildPath 'gradlew.bat'

  if (-not (Test-Path -LiteralPath $GradlePropertiesPath -PathType Leaf)) {
    throw "Gradle wrapper properties file was not found at '$GradlePropertiesPath'. Run this installer from a Gradle project root or pass that directory as the only argument."
  }
  Assert-BuildishNotSymlink -Path $GradlePropertiesPath -Label 'gradle-wrapper.properties'

  Save-BuildishDownloadedFile -Path (Join-Path -Path $GradleDirectory -ChildPath 'buildish-no-gradle-wrapper-jar.sh') -Uri "$BaseUrl/buildish-no-gradle-wrapper-jar.sh" -Label 'POSIX helper script'
  Save-BuildishDownloadedFile -Path (Join-Path -Path $GradleDirectory -ChildPath 'buildish-no-gradle-wrapper-jar.ps1') -Uri "$BaseUrl/buildish-no-gradle-wrapper-jar.ps1" -Label 'PowerShell helper script'

  Add-BuildishLineAfterAnchor -Path $GradlewPath -Anchor 'APP_HOME=$( cd -P "${APP_HOME:-./}" > /dev/null && printf ''%s\n'' "$PWD" ) || exit' -Insertion '. "${APP_HOME}/gradle/buildish-no-gradle-wrapper-jar.sh"' -Label 'gradlew'
  Add-BuildishLineAfterAnchor -Path $GradlewBatPath -Anchor 'for %%i in ("%APP_HOME%") do set APP_HOME=%%~fi' -Insertion 'powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%APP_HOME%\gradle\buildish-no-gradle-wrapper-jar.ps1"' -Label 'gradlew.bat'
  Update-BuildishGitignore

  Write-Host "$BuildishToolName install: Installed helper files into '$GradleDirectory' and updated launcher scripts in '$TargetDirectoryAbsolute'."
} catch {
  Write-Error "$BuildishToolName install: $($_.Exception.Message)"
  exit 1
}