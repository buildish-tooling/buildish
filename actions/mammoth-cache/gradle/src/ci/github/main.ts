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

import { runMain } from '../../main';

import {
  createGitHubBaseCacheApi,
  createGitHubPlatform,
  createGitHubRuntimeHost,
  createGitHubWorkflowArtifactApi,
} from './index';

const runtimeHost = createGitHubRuntimeHost();
const ciProvider = createGitHubPlatform({
  env: process.env,
  githubTokenInput: runtimeHost.getInput('github-token', { trimWhitespace: true }),
  githubJobCheckRunId: runtimeHost.getInput('github-job-check-run-id', {
    trimWhitespace: true,
  }),
});

void runMain({
  runtimeHost,
  ciProvider,
  env: process.env,
  cacheApi: createGitHubBaseCacheApi(),
  artifactApi: createGitHubWorkflowArtifactApi(),
}).catch((error: unknown) => {
  runtimeHost.setFailed(error instanceof Error ? error.message : String(error));
});
