/*
 * Copyright 2026 The Apache Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import java.io.File
import org.gradle.api.GradleException
import org.gradle.api.tasks.wrapper.Wrapper

val unixAnchor =
  """APP_HOME=$( cd -P "${'$'}{APP_HOME:-./}" > /dev/null && printf '%s\n' "${'$'}PWD" ) || exit"""
val unixInsertion = ". \"${'$'}{APP_HOME}/gradle/buildish-no-gradle-wrapper-jar.sh\""
val batchAnchor = "for %%i in (\"%APP_HOME%\") do set APP_HOME=%%~fi"
val batchHelperBlock =
  """
  set BUILDISH_NO_GRADLE_WRAPPER_JAR_ORIGINAL_ARGS=%*
  set BUILDISH_NO_GRADLE_WRAPPER_JAR_ARGS=
  for /f "delims=" %%a in ('powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%APP_HOME%\gradle\buildish-no-gradle-wrapper-jar.ps1"') do @set BUILDISH_NO_GRADLE_WRAPPER_JAR_ARGS=%%a
  set BUILDISH_NO_GRADLE_WRAPPER_JAR_ORIGINAL_ARGS=
  if errorlevel 1 goto fail
  """.trimIndent()
val legacyBatchExecuteLine =
  "\"%JAVA_EXE%\" %DEFAULT_JVM_OPTS% %JAVA_OPTS% %GRADLE_OPTS% \"-Dorg.gradle.appname=%APP_BASE_NAME%\" -classpath \"%CLASSPATH%\" -jar \"%APP_HOME%\\gradle\\wrapper\\gradle-wrapper.jar\" %*"
val patchedLegacyBatchExecuteLine =
  "\"%JAVA_EXE%\" %DEFAULT_JVM_OPTS% %JAVA_OPTS% %GRADLE_OPTS% \"-Dorg.gradle.appname=%APP_BASE_NAME%\" -classpath \"%CLASSPATH%\" -jar \"%APP_HOME%\\gradle\\wrapper\\gradle-wrapper.jar\" %BUILDISH_NO_GRADLE_WRAPPER_JAR_ARGS% %*"
val currentBatchExecuteLine =
  "\"%JAVA_EXE%\" %DEFAULT_JVM_OPTS% %JAVA_OPTS% %GRADLE_OPTS% \"-Dorg.gradle.appname=%APP_BASE_NAME%\" -jar \"%APP_HOME%\\gradle\\wrapper\\gradle-wrapper.jar\" %*"
val patchedCurrentBatchExecuteLine =
  "\"%JAVA_EXE%\" %DEFAULT_JVM_OPTS% %JAVA_OPTS% %GRADLE_OPTS% \"-Dorg.gradle.appname=%APP_BASE_NAME%\" -jar \"%APP_HOME%\\gradle\\wrapper\\gradle-wrapper.jar\" %BUILDISH_NO_GRADLE_WRAPPER_JAR_ARGS% %*"

fun normalizeForFile(text: String, newline: String): String = text.lines().joinToString(newline)

fun patchAfterAnchor(target: File, anchor: String, insertion: String, label: String) {
  val content = target.readText()
  val newline = if (content.contains("\r\n")) "\r\n" else "\n"
  val normalizedInsertion = normalizeForFile(insertion, newline)
  if (content.contains(normalizedInsertion)) return
  val anchorWithNewline = "$anchor$newline"
  val updated =
    when {
      content.contains(anchorWithNewline) ->
        content.replace(anchorWithNewline, "$anchor$newline$normalizedInsertion$newline")
      content.endsWith(anchor) -> content.dropLast(anchor.length) + "$anchor$newline$normalizedInsertion"
      else -> throw GradleException("Unable to find the expected insertion point in $label at '${target.absolutePath}'.")
    }
  target.writeText(updated)
}

fun replaceAnyExactLine(target: File, replacements: List<Pair<String, String>>, label: String) {
  val content = target.readText()
  val newline = if (content.contains("\r\n")) "\r\n" else "\n"
  for ((_, replacement) in replacements) {
    val normalizedReplacement = normalizeForFile(replacement, newline)
    if (content.contains(normalizedReplacement)) return
  }
  for ((currentLine, replacement) in replacements) {
    val normalizedReplacement = normalizeForFile(replacement, newline)
    val currentLineWithNewline = "$currentLine$newline"
    val replacementWithNewline = "$normalizedReplacement$newline"
    val updated =
      when {
        content.contains(currentLineWithNewline) -> content.replace(currentLineWithNewline, replacementWithNewline)
        content.endsWith(currentLine) -> content.dropLast(currentLine.length) + normalizedReplacement
        else -> continue
      }
    target.writeText(updated)
    return
  }
  throw GradleException("Unable to find the expected replacement point in $label at '${target.absolutePath}'.")
}

gradle.projectsLoaded {
  rootProject {
    tasks.withType<Wrapper>().configureEach {
      notCompatibleWithConfigurationCache("Patches generated launcher scripts after the Wrapper task writes them.")
      doLast {
        patchAfterAnchor(scriptFile, unixAnchor, unixInsertion, "gradlew")
        patchAfterAnchor(batchScript, batchAnchor, batchHelperBlock, "gradlew.bat")
        replaceAnyExactLine(
          batchScript,
          listOf(
            legacyBatchExecuteLine to patchedLegacyBatchExecuteLine,
            currentBatchExecuteLine to patchedCurrentBatchExecuteLine,
          ),
          "gradlew.bat",
        )
      }
    }
  }
}