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

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  parseSerializedJsonObject,
  validateNonNegativeNumber,
  validateString,
} from '../validation';

const CAPTURE_DIRECTORY_NAME = '.buildish-mammoth-cache-gradle';
const BUILD_RESULTS_SUBDIRECTORY = 'build-results';
const BUILD_SCANS_SUBDIRECTORY = 'build-scans';
const INIT_SCRIPT_FILE_NAME = 'buildish-mammoth-cache-gradle.build-result-capture.init.gradle';
const SERVICE_PLUGIN_FILE_NAME =
  'buildish-mammoth-cache-gradle.build-result-capture-service.plugin.groovy';
const SKIP_CAPTURE_ENVIRONMENT_VARIABLE = 'BUILDISH_MAMMOTH_CACHE_GRADLE_SKIP_BUILD_RESULT_CAPTURE';

export interface CapturedGradleBuild {
  readonly invocationKey: string;
  readonly capturedAtEpochMillis: number;
  readonly rootProjectName: string;
  readonly requestedTasks: string;
  readonly gradleVersion: string;
  readonly buildFailed: boolean;
  readonly configCacheHit: boolean;
  readonly buildScanUri: string | null;
  readonly buildScanFailed: boolean;
}

export interface GradleBuildReport {
  readonly builds: readonly CapturedGradleBuild[];
  readonly warnings: readonly string[];
}

interface CapturedBuildResultFile {
  readonly capturedAtEpochMillis: number;
  readonly rootProjectName: string;
  readonly requestedTasks: string;
  readonly gradleVersion: string;
  readonly buildFailed: boolean;
  readonly configCacheHit: boolean;
}

interface CapturedBuildScanFile {
  readonly buildScanUri: string | null;
  readonly buildScanFailed: boolean;
}

export async function installGradleBuildResultCapture(gradleUserHome: string): Promise<void> {
  const initDirectory = path.join(gradleUserHome, 'init.d');
  await mkdir(initDirectory, { recursive: true });
  await writeFile(path.join(initDirectory, INIT_SCRIPT_FILE_NAME), INIT_SCRIPT_CONTENTS, {
    encoding: 'utf8',
  });
  await writeFile(path.join(initDirectory, SERVICE_PLUGIN_FILE_NAME), SERVICE_PLUGIN_CONTENTS, {
    encoding: 'utf8',
  });
}

export async function cleanupGradleBuildResultCapture(
  gradleUserHome: string,
): Promise<readonly string[]> {
  const warnings: string[] = [];

  await Promise.all(
    [INIT_SCRIPT_FILE_NAME, SERVICE_PLUGIN_FILE_NAME].map(async (fileName) => {
      const absolutePath = path.join(gradleUserHome, 'init.d', fileName);
      try {
        await rm(absolutePath, { force: true });
      } catch (error: unknown) {
        warnings.push(
          `Could not remove Gradle build-result capture file '${absolutePath}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );

  return warnings;
}

export async function loadGradleBuildReport(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GradleBuildReport> {
  const warnings: string[] = [];
  const resultsRoot = resolveCaptureRoot(env);
  if (!resultsRoot) {
    return {
      builds: [],
      warnings: ['Gradle build reporting is unavailable because RUNNER_TEMP is not set.'],
    };
  }

  const buildResults = await loadFilesByInvocationKey<CapturedBuildResultFile>(
    path.join(resultsRoot, BUILD_RESULTS_SUBDIRECTORY),
    'build result',
    warnings,
    validateCapturedBuildResultFile,
  );
  const buildScans = await loadFilesByInvocationKey<CapturedBuildScanFile>(
    path.join(resultsRoot, BUILD_SCANS_SUBDIRECTORY),
    'build scan',
    warnings,
    validateCapturedBuildScanFile,
  );

  for (const invocationKey of buildScans.keys()) {
    if (!buildResults.has(invocationKey)) {
      warnings.push(
        `Ignoring build scan metadata for invocation '${invocationKey}' because the corresponding build result was not captured.`,
      );
    }
  }

  const builds = [...buildResults.entries()]
    .map(([invocationKey, buildResult]) => {
      const buildScan = buildScans.get(invocationKey);
      return {
        invocationKey,
        capturedAtEpochMillis: buildResult.capturedAtEpochMillis,
        rootProjectName: buildResult.rootProjectName,
        requestedTasks: buildResult.requestedTasks,
        gradleVersion: buildResult.gradleVersion,
        buildFailed: buildResult.buildFailed,
        configCacheHit: buildResult.configCacheHit,
        buildScanUri: buildScan?.buildScanUri ?? null,
        buildScanFailed: buildScan?.buildScanFailed ?? false,
      } satisfies CapturedGradleBuild;
    })
    .sort(
      (left, right) =>
        left.capturedAtEpochMillis - right.capturedAtEpochMillis ||
        left.invocationKey.localeCompare(right.invocationKey),
    );

  return { builds, warnings };
}

export function createGradleBuildSummaryLines(report: GradleBuildReport): readonly string[] {
  const successfulBuildCount = report.builds.filter((build) => !build.buildFailed).length;
  const failedBuildCount = report.builds.length - successfulBuildCount;
  const buildScanCounts = report.builds.reduce(
    (counts, build) => {
      if (build.buildScanUri) {
        counts.published += 1;
      } else if (build.buildScanFailed) {
        counts.failed += 1;
      } else {
        counts.notAttempted += 1;
      }

      return counts;
    },
    { failed: 0, notAttempted: 0, published: 0 },
  );

  return [
    '### Performed Gradle builds',
    `- Captured Gradle builds: ${report.builds.length}`,
    `- Build outcomes: ${successfulBuildCount} succeeded, ${failedBuildCount} failed`,
    `- Build scans: ${buildScanCounts.published} published, ${buildScanCounts.failed} failed, ${buildScanCounts.notAttempted} not attempted`,
    `- Build reporting warnings: ${report.warnings.length}`,
    ...report.warnings.map((warning) => `- Warning: ${escapeSummaryText(warning)}`),
    ...report.builds.flatMap((build, index) => createBuildSummaryLines(build, index)),
  ];
}

function createBuildSummaryLines(build: CapturedGradleBuild, index: number): readonly string[] {
  const title = `${displayText(build.rootProjectName, '(unnamed root project)')} — ${displayText(build.requestedTasks, '(default tasks)')}`;
  const buildScanSummaryLine = build.buildScanUri
    ? `  - Build Scan: published (${build.buildScanUri})`
    : build.buildScanFailed
      ? '  - Build Scan: attempted but failed'
      : '  - Build Scan: not attempted';

  return [
    `- Build ${index + 1}: ${escapeSummaryText(truncateSummaryText(title, 200))}`,
    `  - Outcome: ${build.buildFailed ? 'failed' : 'succeeded'}`,
    `  - Gradle version: ${escapeSummaryText(build.gradleVersion)}`,
    `  - Configuration cache reused: ${build.configCacheHit ? 'yes' : 'no'}`,
    buildScanSummaryLine,
  ];
}

async function loadFilesByInvocationKey<T>(
  directoryPath: string,
  label: string,
  warnings: string[],
  validate: (contents: string, filePath: string) => T,
): Promise<Map<string, T>> {
  let entries: readonly string[];
  try {
    entries = await readdir(directoryPath);
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return new Map();
    }

    warnings.push(
      `Could not enumerate Gradle ${label} files in '${directoryPath}': ${error instanceof Error ? error.message : String(error)}`,
    );
    return new Map();
  }

  const files = entries.filter((entry) => entry.endsWith('.json')).sort();
  const results = new Map<string, T>();
  for (const fileName of files) {
    const absolutePath = path.join(directoryPath, fileName);
    try {
      const contents = await readFile(absolutePath, 'utf8');
      results.set(fileName.slice(0, -'.json'.length), validate(contents, absolutePath));
    } catch (error: unknown) {
      warnings.push(
        `Could not read Gradle ${label} file '${absolutePath}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return results;
}

function validateCapturedBuildResultFile(
  contents: string,
  filePath: string,
): CapturedBuildResultFile {
  const parsed = parseSerializedJsonObject(contents, `Gradle build result file '${filePath}'`);
  return {
    capturedAtEpochMillis: validateNonNegativeNumber(
      parsed.capturedAtEpochMillis,
      `Gradle build result file '${filePath}' capturedAtEpochMillis`,
    ),
    rootProjectName: validateString(
      parsed.rootProjectName,
      `Gradle build result file '${filePath}' rootProjectName`,
    ),
    requestedTasks: validateString(
      parsed.requestedTasks,
      `Gradle build result file '${filePath}' requestedTasks`,
    ),
    gradleVersion: validateString(
      parsed.gradleVersion,
      `Gradle build result file '${filePath}' gradleVersion`,
    ),
    buildFailed: validateBoolean(
      parsed.buildFailed,
      `Gradle build result file '${filePath}' buildFailed`,
    ),
    configCacheHit: validateBoolean(
      parsed.configCacheHit,
      `Gradle build result file '${filePath}' configCacheHit`,
    ),
  };
}

function validateCapturedBuildScanFile(contents: string, filePath: string): CapturedBuildScanFile {
  const parsed = parseSerializedJsonObject(contents, `Gradle build scan file '${filePath}'`);
  const buildScanUri = parsed.buildScanUri;

  return {
    buildScanUri: buildScanUri === null ? null : validateBuildScanUri(buildScanUri, filePath),
    buildScanFailed: validateBoolean(
      parsed.buildScanFailed,
      `Gradle build scan file '${filePath}' buildScanFailed`,
    ),
  };
}

function validateBuildScanUri(value: unknown, filePath: string): string {
  const uri = validateString(value, `Gradle build scan file '${filePath}' buildScanUri`);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(uri);
  } catch (error: unknown) {
    throw new Error(
      `Gradle build scan file '${filePath}' buildScanUri must be a valid URL: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new Error(
      `Gradle build scan file '${filePath}' buildScanUri must use http or https, but was '${parsedUrl.protocol}'.`,
    );
  }

  return parsedUrl.toString();
}

function validateBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
  }

  return value;
}

function resolveCaptureRoot(env: NodeJS.ProcessEnv): string | null {
  const runnerTemp = env.RUNNER_TEMP?.trim();
  return runnerTemp ? path.join(runnerTemp, CAPTURE_DIRECTORY_NAME) : null;
}

function displayText(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

function truncateSummaryText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function escapeSummaryText(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!<>|-]/g, '\\$&');
}

function isMissingPathError(error: unknown): boolean {
  return !!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

const INIT_SCRIPT_CONTENTS = `/*
 * Capture information for each executed Gradle build to display in the job summary.
 */
import org.gradle.util.GradleVersion
import org.slf4j.LoggerFactory

def SKIP_BUILD_CAPTURE = "${SKIP_CAPTURE_ENVIRONMENT_VARIABLE}"
def BUILD_SCAN_PLUGIN_ID = "com.gradle.build-scan"
def BUILD_SCAN_EXTENSION = "buildScan"
def DEVELOCITY_PLUGIN_ID = "com.gradle.develocity"
def DEVELOCITY_EXTENSION = "develocity"
def GE_PLUGIN_ID = "com.gradle.enterprise"
def GE_EXTENSION = "gradleEnterprise"

if (System.properties[SKIP_BUILD_CAPTURE] ?: System.getenv(SKIP_BUILD_CAPTURE)) {
    logger.lifecycle("buildish/mammoth-cache/gradle: Not capturing build results")
    return
}

def isTopLevelBuild = gradle.getParent() == null
if (isTopLevelBuild) {
    def resultsWriter = new ResultsWriter()
    def version = GradleVersion.current().baseVersion
    def atLeastGradle6 = version >= GradleVersion.version("6.0")
    def atLeastGradle7 = version >= GradleVersion.version("7.0")
    def invocationId = "-" + java.util.UUID.randomUUID().toString()

    if (atLeastGradle6 && atLeastGradle7) {
        captureUsingBuildService(invocationId)
    } else {
        captureUsingBuildFinished(gradle, invocationId, resultsWriter)
    }

    settingsEvaluated { settings ->
        def captureBuildScanLink = {
            if (settings.extensions.findByName(DEVELOCITY_EXTENSION)) {
                captureUsingBuildScanPublished(settings.extensions[DEVELOCITY_EXTENSION].buildScan, invocationId, resultsWriter)
            } else if (settings.extensions.findByName(GE_EXTENSION)) {
                captureUsingBuildScanPublished(settings.extensions[GE_EXTENSION].buildScan, invocationId, resultsWriter)
            }
        }
        settings.pluginManager.withPlugin(GE_PLUGIN_ID, captureBuildScanLink)
        settings.pluginManager.withPlugin(DEVELOCITY_PLUGIN_ID) {
            if (settings.pluginManager.hasPlugin(GE_PLUGIN_ID)) return
            captureBuildScanLink()
        }
    }

    projectsEvaluated { gradle ->
        def captureBuildScanLink = {
            if (gradle.rootProject.extensions.findByName(DEVELOCITY_EXTENSION)) {
                captureUsingBuildScanPublished(gradle.rootProject.extensions[DEVELOCITY_EXTENSION].buildScan, invocationId, resultsWriter)
            } else if (gradle.rootProject.extensions.findByName(BUILD_SCAN_EXTENSION)) {
                captureUsingBuildScanPublished(gradle.rootProject.extensions[BUILD_SCAN_EXTENSION], invocationId, resultsWriter)
            }
        }

        gradle.rootProject.pluginManager.withPlugin(BUILD_SCAN_PLUGIN_ID, captureBuildScanLink)
        gradle.rootProject.pluginManager.withPlugin(DEVELOCITY_PLUGIN_ID) {
            if (gradle.rootProject.pluginManager.hasPlugin(BUILD_SCAN_PLUGIN_ID)) return
            captureBuildScanLink()
        }
    }
}

def captureUsingBuildService(invocationId) {
    gradle.ext.invocationId = invocationId
    apply from: '${SERVICE_PLUGIN_FILE_NAME}'
}

void captureUsingBuildFinished(gradle, String invocationId, ResultsWriter resultsWriter) {
    gradle.buildFinished { result ->
        def buildResults = [
            capturedAtEpochMillis: System.currentTimeMillis(),
            rootProjectName: rootProject.name,
            requestedTasks: gradle.startParameter.taskNames.join(" "),
            gradleVersion: GradleVersion.current().version,
            buildFailed: result.failure != null,
            configCacheHit: false
        ]
        resultsWriter.writeToResultsFile("${BUILD_RESULTS_SUBDIRECTORY}", invocationId, buildResults)
    }
}

void captureUsingBuildScanPublished(buildScanExtension, String invocationId, ResultsWriter resultsWriter) {
    buildScanExtension.with {
        buildScanPublished { buildScan ->
            def scanResults = [
                buildScanUri: buildScan.buildScanUri.toASCIIString(),
                buildScanFailed: false
            ]
            resultsWriter.writeToResultsFile("${BUILD_SCANS_SUBDIRECTORY}", invocationId, scanResults)
        }

        onError { error ->
            def scanResults = [
                buildScanUri: null,
                buildScanFailed: true
            ]
            resultsWriter.writeToResultsFile("${BUILD_SCANS_SUBDIRECTORY}", invocationId, scanResults)
        }
    }
}

class ResultsWriter {
    private final logger = LoggerFactory.getLogger("buildish/mammoth-cache/gradle")

    void writeToResultsFile(String subDir, String invocationId, def content) {
        def runnerTempDir = System.getProperty("RUNNER_TEMP") ?: System.getenv("RUNNER_TEMP")
        def githubActionStep = System.getProperty("GITHUB_ACTION") ?: System.getenv("GITHUB_ACTION")
        if (!runnerTempDir || !githubActionStep) {
            return
        }

        try {
            def buildResultsDir = new File(runnerTempDir, "${CAPTURE_DIRECTORY_NAME}/" + subDir)
            buildResultsDir.mkdirs()
            def buildResultsFile = new File(buildResultsDir, githubActionStep + invocationId + ".json")
            if (!buildResultsFile.exists()) {
                logger.lifecycle("buildish/mammoth-cache/gradle: Writing build results to ${'$'}{buildResultsFile}")
                buildResultsFile << groovy.json.JsonOutput.toJson(content)
            }
        } catch (Exception e) {
            println "buildish/mammoth-cache/gradle failed to write build-results file. Will continue. > ${'$'}{e.getLocalizedMessage()}"
        }
    }
}
`;

const SERVICE_PLUGIN_CONTENTS = `import org.gradle.api.provider.Property
import org.gradle.api.services.BuildService
import org.gradle.api.services.BuildServiceParameters
import org.gradle.tooling.events.*
import org.gradle.internal.operations.*
import org.gradle.initialization.*
import org.gradle.execution.*
import org.gradle.internal.build.event.BuildEventListenerRegistryInternal
import org.gradle.util.GradleVersion
import org.slf4j.LoggerFactory

settingsEvaluated { settings ->
    def projectTracker = gradle.sharedServices.registerIfAbsent("buildish-mammoth-cache-gradle-buildResultsRecorder", BuildResultsRecorder, { spec ->
        spec.getParameters().getRootProjectName().set(settings.rootProject.name)
        spec.getParameters().getRequestedTasks().set(gradle.startParameter.taskNames.join(" "))
        spec.getParameters().getInvocationId().set(gradle.ext.invocationId)
    })

    gradle.services.get(BuildEventListenerRegistryInternal).onOperationCompletion(projectTracker)
}

abstract class BuildResultsRecorder implements BuildService<BuildResultsRecorder.Params>, BuildOperationListener, AutoCloseable {
    private final logger = LoggerFactory.getLogger("buildish/mammoth-cache/gradle")
    private boolean buildFailed = false
    private boolean configCacheHit = true

    interface Params extends BuildServiceParameters {
        Property<String> getRootProjectName()
        Property<String> getRequestedTasks()
        Property<String> getInvocationId()
    }

    void started(BuildOperationDescriptor buildOperation, OperationStartEvent startEvent) {}

    void progress(OperationIdentifier operationIdentifier, OperationProgressEvent progressEvent) {}

    void finished(BuildOperationDescriptor buildOperation, OperationFinishEvent finishEvent) {
        if (buildOperation.details in EvaluateSettingsBuildOperationType.Details) {
            configCacheHit = false
        }
        if (buildOperation.metadata == BuildOperationCategory.RUN_WORK ||
            buildOperation.metadata == BuildOperationCategory.CONFIGURE_PROJECT) {
            if (finishEvent.failure != null) {
                buildFailed = true
            }
        }
    }

    @Override
    public void close() {
        def buildResults = [
            capturedAtEpochMillis: System.currentTimeMillis(),
            rootProjectName: getParameters().getRootProjectName().get(),
            requestedTasks: getParameters().getRequestedTasks().get(),
            gradleVersion: GradleVersion.current().version,
            buildFailed: buildFailed,
            configCacheHit: configCacheHit
        ]

        def runnerTempDir = System.getProperty("RUNNER_TEMP") ?: System.getenv("RUNNER_TEMP")
        def githubActionStep = System.getProperty("GITHUB_ACTION") ?: System.getenv("GITHUB_ACTION")
        if (!runnerTempDir || !githubActionStep) {
            return
        }

        try {
            def buildResultsDir = new File(runnerTempDir, "${CAPTURE_DIRECTORY_NAME}/${BUILD_RESULTS_SUBDIRECTORY}")
            buildResultsDir.mkdirs()
            def buildResultsFile = new File(buildResultsDir, githubActionStep + getParameters().getInvocationId().get() + ".json")
            if (!buildResultsFile.exists()) {
                logger.lifecycle("buildish/mammoth-cache/gradle: Writing build results to ${'$'}{buildResultsFile}")
                buildResultsFile << groovy.json.JsonOutput.toJson(buildResults)
            }
        } catch (Exception e) {
            println "buildish/mammoth-cache/gradle failed to write build-results file. Will continue. > ${'$'}{e.getLocalizedMessage()}"
        }
    }
}
`;
