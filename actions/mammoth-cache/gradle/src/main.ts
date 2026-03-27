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

import {
  createMainActionOutputs,
  executeMainAction,
  type MainActionDependencies,
} from './main-flow';
import { claimSingleRunJobInvocation } from './runtime/job-single-run';

export type MainEntrypointDependencies = MainActionDependencies;

export async function runMain(dependencies: MainEntrypointDependencies): Promise<void> {
  const { ciProvider, runtimeHost } = dependencies;
  const singleRunClaim = await claimSingleRunJobInvocation({
    ciContext: ciProvider.context,
    saveState: runtimeHost.saveState,
  });
  if (!singleRunClaim.accepted) {
    throw new Error(singleRunClaim.message);
  }

  const status = await executeMainAction(dependencies);
  for (const [name, value] of Object.entries(createMainActionOutputs(status))) {
    runtimeHost.setOutput(name, value);
  }
  if (status.bootstrap.baseCacheResult) {
    runtimeHost.info(status.bootstrap.baseCacheResult.message);
  }
  if (status.dependentDeltaResult) {
    runtimeHost.info(status.dependentDeltaResult.message);
    for (const warning of status.dependentDeltaResult.warnings) {
      runtimeHost.warning(warning);
    }
  }
  runtimeHost.info(status.message);
}
