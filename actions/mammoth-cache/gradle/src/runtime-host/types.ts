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

import type { InputProvider } from '../config/action-config';

/** Runtime capability for resolving action inputs. */
export type RuntimeInputSource = InputProvider;

/** Runtime capability for persisting cross-phase action state. */
export interface RuntimeStateStore {
  getState(name: string): string;
  saveState(name: string, value: string): void;
}

/** Runtime capability for publishing entrypoint outputs. */
export interface RuntimeOutputSink {
  setOutput(name: string, value: unknown): void;
}

/** Runtime capability for non-fatal diagnostics. */
export interface RuntimeReporter {
  info(message: string): void;
  warning(message: string): void;
}

/** Runtime capability for marking the active execution as failed. */
export interface RuntimeFailureReporter {
  setFailed(message: string): void;
}

/**
 * Backward-compatible composite host used by current provider runtime implementations.
 */
export type ActionRuntimeHost = RuntimeInputSource &
  RuntimeStateStore &
  RuntimeOutputSink &
  RuntimeReporter &
  RuntimeFailureReporter;
