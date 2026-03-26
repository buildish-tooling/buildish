/*
 * Copyright 2026 The Project Nessie Authors
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

import * as core from '@actions/core';

import { executePostAction } from './post-flow';
import { decideSingleRunPostExecution } from './runtime/job-single-run';

export async function runPost(): Promise<void> {
  const postDecision = decideSingleRunPostExecution();
  if (!postDecision.shouldRun) {
    core.info(postDecision.message);
    return;
  }

  const status = await executePostAction();
  if (status.bootstrap.baseCacheResult) {
    core.info(status.bootstrap.baseCacheResult.message);
  }
  if (status.consumedDeltaCleanupResult) {
    core.info(status.consumedDeltaCleanupResult.message);
    for (const warning of status.consumedDeltaCleanupResult.warnings) {
      core.warning(warning);
    }
  }
  if (status.deltaArtifactResult) {
    core.info(status.deltaArtifactResult.message);
  }
  core.info(status.message);
}

void runPost().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
