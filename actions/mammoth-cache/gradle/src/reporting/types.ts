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

/**
 * Minimal interface for job summary writers.
 */
export interface SummaryWriter {
  /** Appends raw text to the job summary buffer. */
  addRaw(text: string, addEol?: boolean): SummaryWriter;
  /** Flushes the accumulated summary content to the provider. */
  write(): Promise<unknown>;
}

/**
 * Provider-specific reporting surface used by shared action flows.
 */
export interface ReportSink {
  /** Publishes the provided lines as a grouped log block using the provider-specific log surface. */
  publishLogGroup(
    title: string,
    lines: readonly string[],
    writeLine: (message: string) => void,
  ): void;
  /** Publishes the provided markdown lines to the provider summary surface. */
  publishSummary(lines: readonly string[]): Promise<void>;
  /** Replaces the current provider-managed summary content when supported. */
  replaceSummary(lines: readonly string[]): Promise<void>;
}
