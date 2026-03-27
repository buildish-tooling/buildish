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

import { executePostAction, type PostActionDependencies } from './post-flow';
import { decideSingleRunPostExecution } from './runtime/job-single-run';

export type PostEntrypointDependencies = PostActionDependencies;

export async function runPost(dependencies: PostEntrypointDependencies): Promise<void> {
  const { runtimeHost } = dependencies;
  const postDecision = decideSingleRunPostExecution({
    getState: runtimeHost.getState,
  });
  if (!postDecision.shouldRun) {
    runtimeHost.info(postDecision.message);
    return;
  }

  const status = await executePostAction(dependencies);
  if (status.bootstrap.baseCacheResult) {
    runtimeHost.info(status.bootstrap.baseCacheResult.message);
  }
  if (status.consumedDeltaCleanupResult) {
    runtimeHost.info(status.consumedDeltaCleanupResult.message);
    for (const warning of status.consumedDeltaCleanupResult.warnings) {
      runtimeHost.warning(warning);
    }
  }
  if (status.deltaArtifactResult) {
    runtimeHost.info(status.deltaArtifactResult.message);
  }
  runtimeHost.info(status.message);
}
