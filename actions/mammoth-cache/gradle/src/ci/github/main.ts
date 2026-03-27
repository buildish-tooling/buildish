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

import { runPrepareExecution } from '../../entrypoints/cli/prepare';

import {
  createGitHubBaseCacheBackend,
  createGitHubPlatform,
  createGitHubReportSink,
  createGitHubRuntimeHost,
  createGitHubWorkflowArtifactBackend,
} from './index';

const runtimeHost = createGitHubRuntimeHost();
const ciProvider = createGitHubPlatform({
  env: process.env,
  githubTokenInput: runtimeHost.getInput('github-token', { trimWhitespace: true }),
  githubJobCheckRunId: runtimeHost.getInput('github-job-check-run-id', {
    trimWhitespace: true,
  }),
});
const reportSink = createGitHubReportSink({ env: process.env });

void runPrepareExecution({
  runtimeHost,
  ciProvider,
  reportSink,
  env: process.env,
  cacheBackend: createGitHubBaseCacheBackend(),
  artifactBackend: createGitHubWorkflowArtifactBackend(),
}).catch((error: unknown) => {
  runtimeHost.setFailed(error instanceof Error ? error.message : String(error));
});
