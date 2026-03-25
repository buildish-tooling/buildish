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

import { executeMainAction } from './main-flow';

export async function runMain(): Promise<void> {
  const status = await executeMainAction();
  if (status.bootstrap.baseCacheResult) {
    core.info(status.bootstrap.baseCacheResult.message);
  }
  if (status.dependentDeltaResult) {
    core.info(status.dependentDeltaResult.message);
    for (const warning of status.dependentDeltaResult.warnings) {
      core.warning(warning);
    }
  }
  core.info(status.message);
}

void runMain().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
