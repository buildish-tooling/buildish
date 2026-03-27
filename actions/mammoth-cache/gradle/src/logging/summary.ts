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

import type { CiPlatformAdapter } from '../ci/types';

/**
 * Appends a follow-up summary section using the active CI provider summary surface.
 */
export async function appendJobSummary(
  ciProvider: Pick<CiPlatformAdapter, 'publishSummary'>,
  lines: readonly string[],
): Promise<void> {
  if (lines.length === 0) {
    return;
  }

  await ciProvider.publishSummary(lines);
}

/**
 * Replaces the current provider-managed job summary when supported, falling back to append mode.
 */
export async function replaceJobSummary(
  ciProvider: Pick<CiPlatformAdapter, 'replaceSummary'>,
  lines: readonly string[],
): Promise<void> {
  if (lines.length === 0) {
    return;
  }

  await ciProvider.replaceSummary(lines);
}

/**
 * Publishes a grouped log block through the active CI adapter so main/post details stay out of the
 * provider summary surface.
 */
export async function publishJobLogGroup(
  ciProvider: Pick<CiPlatformAdapter, 'publishLogGroup'>,
  title: string,
  lines: readonly string[],
  writeLine: (message: string) => void,
): Promise<void> {
  if (lines.length === 0) {
    return;
  }

  ciProvider.publishLogGroup(title, lines, writeLine);
}

export function createDetailsSection(
  title: string,
  bodyLines: readonly string[],
): readonly string[] {
  return [
    '<details>',
    `<summary>${escapeHtml(title)}</summary>`,
    '',
    ...bodyLines,
    '',
    '</details>',
  ];
}

export function createHtmlTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): readonly string[] {
  const headerCells = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('');
  return [
    '<table>',
    `  <thead><tr>${headerCells}</tr></thead>`,
    '  <tbody>',
    ...rows.map((row) => `    <tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`),
    '  </tbody>',
    '</table>',
  ];
}

export function createHtmlLink(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function escapeSummaryText(value: string): string {
  return value.replaceAll(/[\\`*_{}[\]()#+.!|-]/g, '\\$&');
}
