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

/**
 * Runtime host surface used by provider-agnostic orchestration code.
 */
export interface ActionRuntimeHost extends InputProvider {
  getState(name: string): string;
  saveState(name: string, value: string): void;
  setOutput(name: string, value: unknown): void;
  info(message: string): void;
  warning(message: string): void;
  setFailed(message: string): void;
}
