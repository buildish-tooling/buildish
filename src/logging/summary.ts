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

import { createGitHubPlatform, type GitHubPlatformOptions } from '../ci/github';

/**
 * Appends a follow-up summary section using the same GitHub summary surface as bootstrap.
 */
export async function appendJobSummary(
  options: Pick<
    GitHubPlatformOptions,
    'env' | 'eventPayload' | 'eventPayloadReader' | 'summaryWriter'
  >,
  lines: readonly string[],
): Promise<void> {
  if (lines.length === 0) {
    return;
  }

  const platform = createGitHubPlatform(options);
  await platform.publishSummary(lines);
}
