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
  createGitHubPlatform,
  createGitHubReportSink,
  type GitHubPlatformOptions,
  type GitHubReportSinkOptions,
} from '../../src/ci/github';
import type { CompositeRuntimeHost } from '../../src/runtime-host/types';

export interface TestRuntimeHostOptions {
  readonly inputs?: Readonly<Record<string, string>>;
  readonly getInput?: (
    name: string,
    options?: { required?: boolean; trimWhitespace?: boolean },
  ) => string;
  readonly getState?: (name: string) => string;
  readonly saveState?: (name: string, value: string) => void;
  readonly info?: (message: string) => void;
  readonly warning?: (message: string) => void;
  readonly setOutput?: (name: string, value: unknown) => void;
  readonly setFailed?: (message: string) => void;
}

export function createTestRuntimeHost(options: TestRuntimeHostOptions = {}): CompositeRuntimeHost {
  return {
    getInput(name, inputOptions) {
      if (options.getInput) {
        return options.getInput(name, inputOptions);
      }

      const rawValue = options.inputs?.[name] ?? '';
      const value = inputOptions?.trimWhitespace === false ? rawValue : rawValue.trim();
      if (inputOptions?.required && value.length === 0) {
        throw new Error(`Input required and not supplied: ${name}`);
      }
      return value;
    },
    getState(name) {
      return options.getState?.(name) ?? '';
    },
    saveState(name, value) {
      options.saveState?.(name, value);
    },
    setOutput(name, value) {
      options.setOutput?.(name, value);
    },
    info(message) {
      options.info?.(message);
    },
    warning(message) {
      options.warning?.(message);
    },
    setFailed(message) {
      options.setFailed?.(message);
    },
  };
}

export function createTestGitHubProvider(
  runtimeHost: CompositeRuntimeHost,
  options: GitHubPlatformOptions = {},
) {
  return createGitHubPlatform({
    ...options,
    githubTokenInput:
      options.githubTokenInput ?? runtimeHost.getInput('github-token', { trimWhitespace: true }),
    githubJobCheckRunId:
      options.githubJobCheckRunId ??
      runtimeHost.getInput('github-job-check-run-id', { trimWhitespace: true }),
  });
}

export function createTestGitHubReportSink(
  _runtimeHost: CompositeRuntimeHost,
  options: GitHubReportSinkOptions = {},
) {
  return createGitHubReportSink(options);
}
