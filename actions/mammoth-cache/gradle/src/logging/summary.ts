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

import { writeFile } from 'node:fs/promises';

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

/**
 * Replaces the current GitHub step summary when the runner exposes `GITHUB_STEP_SUMMARY`, falling
 * back to appending via the normal summary writer in environments that do not provide that file.
 */
export async function replaceJobSummary(
  options: Pick<
    GitHubPlatformOptions,
    'env' | 'eventPayload' | 'eventPayloadReader' | 'summaryWriter'
  >,
  lines: readonly string[],
): Promise<void> {
  if (lines.length === 0) {
    return;
  }

  const summaryPath = options.env?.GITHUB_STEP_SUMMARY?.trim();
  if (!summaryPath) {
    await appendJobSummary(options, lines);
    return;
  }

  await writeFile(summaryPath, `${lines.join('\n')}\n`, 'utf8');
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
