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

import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { NormalizedActionConfig } from '../config/types';
import type { ValidatedWrapperPropertiesFile } from './types';

const WRAPPER_PROPERTIES_SUFFIX = 'gradle/wrapper/gradle-wrapper.properties';
const WRAPPER_JAR_NAME = 'gradle-wrapper.jar';
const SUPPORTED_GRADLE_USER_HOME_BASE = 'GRADLE_USER_HOME';
const SUPPORTED_WRAPPER_STORE_PATH = 'wrapper/dists';
const SHA256_PATTERN = /^[A-Fa-f0-9]{64}$/;

/**
 * Discovers the target wrapper properties files for the current config and enforces
 * the static validation rules that do not require network access.
 */
export async function validateTargetWrapperProperties(
  config: NormalizedActionConfig,
  workspace: string,
): Promise<readonly ValidatedWrapperPropertiesFile[]> {
  const targetedFiles = await discoverTargetWrapperPropertiesFiles(config, workspace);
  return await Promise.all(
    targetedFiles.map(
      async (relativePath) => await validateWrapperPropertiesFile(relativePath, workspace),
    ),
  );
}

async function discoverTargetWrapperPropertiesFiles(
  config: NormalizedActionConfig,
  workspace: string,
): Promise<readonly string[]> {
  switch (config.wrapperSelectionMode) {
    case 'default':
      return [
        await requireWrapperPropertiesFile(
          config.defaultWrapperPropertiesFile,
          workspace,
          'default wrapper properties file',
        ),
      ];
    case 'explicit': {
      const files = await Promise.all(
        config.wrapperPropertiesFiles.map(
          async (relativePath) =>
            await requireWrapperPropertiesFile(relativePath, workspace, 'wrapper-properties-files'),
        ),
      );
      return ensureUniqueRelativePaths(files, 'wrapper-properties-files');
    }
    case 'all':
      return await discoverAllMatchingWrapperPropertiesFiles(
        config.wrapperPropertiesGlob,
        workspace,
      );
  }
}

async function requireWrapperPropertiesFile(
  relativePath: string,
  workspace: string,
  inputName: string,
): Promise<string> {
  assertWrapperPropertiesLayout(relativePath, inputName);
  const absolutePath = resolveWorkspaceFile(workspace, relativePath, inputName);

  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch {
    throw new Error(`${inputName} '${relativePath}' does not exist inside the workspace.`);
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`${inputName} '${relativePath}' must not be a symbolic link.`);
  }

  if (!stats.isFile()) {
    throw new Error(`${inputName} '${relativePath}' must point to a regular file.`);
  }

  return relativePath;
}

async function discoverAllMatchingWrapperPropertiesFiles(
  globPattern: string,
  workspace: string,
): Promise<readonly string[]> {
  const matches = await collectMatchingWrapperPropertiesFiles(workspace, '', globPattern);
  const sortedMatches = [...matches].sort((left, right) => left.localeCompare(right));

  if (sortedMatches.length === 0) {
    throw new Error(
      `wrapper-properties-glob '${globPattern}' did not match any wrapper properties files.`,
    );
  }

  return ensureUniqueRelativePaths(sortedMatches, 'wrapper-properties-glob');
}

async function collectMatchingWrapperPropertiesFiles(
  workspace: string,
  relativeDirectory: string,
  globPattern: string,
): Promise<string[]> {
  const directoryPath = path.join(workspace, relativeDirectory);
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const sortedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  const matches: string[] = [];

  for (const entry of sortedEntries) {
    if (entry.name === '.git' || entry.isSymbolicLink()) {
      continue;
    }

    const relativePath = path.posix.join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      matches.push(
        ...(await collectMatchingWrapperPropertiesFiles(workspace, relativePath, globPattern)),
      );
      continue;
    }

    if (entry.isFile() && path.matchesGlob(relativePath, globPattern)) {
      assertWrapperPropertiesLayout(relativePath, 'wrapper-properties-glob');
      matches.push(relativePath);
    }
  }

  return matches;
}

async function validateWrapperPropertiesFile(
  relativePath: string,
  workspace: string,
): Promise<ValidatedWrapperPropertiesFile> {
  const absolutePath = resolveWorkspaceFile(workspace, relativePath, 'wrapper properties file');
  const contents = await readFile(absolutePath, 'utf8');
  const properties = parseProperties(contents);
  const distributionUrl = requireNonEmptyProperty(properties, relativePath, 'distributionUrl');
  const distributionSha256Sum = requireNonEmptyProperty(
    properties,
    relativePath,
    'distributionSha256Sum',
  );

  requireExactPropertyValue(
    properties,
    relativePath,
    'validateDistributionUrl',
    'true',
    "must be set to 'true'",
  );
  requireOptionalPropertyValue(
    properties,
    relativePath,
    'distributionBase',
    SUPPORTED_GRADLE_USER_HOME_BASE,
  );
  requireOptionalPropertyValue(
    properties,
    relativePath,
    'zipStoreBase',
    SUPPORTED_GRADLE_USER_HOME_BASE,
  );
  requireOptionalPropertyValue(
    properties,
    relativePath,
    'distributionPath',
    SUPPORTED_WRAPPER_STORE_PATH,
  );
  requireOptionalPropertyValue(
    properties,
    relativePath,
    'zipStorePath',
    SUPPORTED_WRAPPER_STORE_PATH,
  );

  if (!SHA256_PATTERN.test(distributionSha256Sum)) {
    throw new Error(
      `Wrapper properties file '${relativePath}' has an invalid distributionSha256Sum value. Expected 64 hexadecimal characters.`,
    );
  }

  const wrapperDirectoryRelativePath = path.posix.dirname(relativePath);

  return {
    relativePath,
    absolutePath,
    wrapperDirectoryRelativePath,
    wrapperJarRelativePath: path.posix.join(wrapperDirectoryRelativePath, WRAPPER_JAR_NAME),
    properties,
    distributionUrl,
    distributionSha256Sum,
  };
}

function ensureUniqueRelativePaths(
  relativePaths: readonly string[],
  inputName: string,
): readonly string[] {
  const seen = new Set<string>();

  for (const relativePath of relativePaths) {
    if (seen.has(relativePath)) {
      throw new Error(`${inputName} resolves '${relativePath}' more than once.`);
    }
    seen.add(relativePath);
  }

  return relativePaths;
}

function assertWrapperPropertiesLayout(relativePath: string, inputName: string): void {
  if (
    relativePath === WRAPPER_PROPERTIES_SUFFIX ||
    relativePath.endsWith(`/${WRAPPER_PROPERTIES_SUFFIX}`)
  ) {
    return;
  }

  throw new Error(
    `${inputName} must resolve to files ending with '${WRAPPER_PROPERTIES_SUFFIX}'. Found '${relativePath}'.`,
  );
}

function resolveWorkspaceFile(workspace: string, relativePath: string, inputName: string): string {
  const absolutePath = path.resolve(workspace, relativePath);
  const relativeToWorkspace = path.relative(workspace, absolutePath);

  if (
    relativeToWorkspace === '..' ||
    relativeToWorkspace.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToWorkspace)
  ) {
    throw new Error(`${inputName} '${relativePath}' escapes the workspace.`);
  }

  return absolutePath;
}

function parseProperties(contents: string): Readonly<Record<string, string>> {
  const properties: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/u)) {
    const trimmedLine = rawLine.trim();

    if (trimmedLine.length === 0 || trimmedLine.startsWith('#') || trimmedLine.startsWith('!')) {
      continue;
    }

    const { key, value } = splitPropertyLine(rawLine);

    if (key.length === 0) {
      continue;
    }

    properties[unescapePropertyText(key)] = unescapePropertyText(value);
  }

  return properties;
}

function splitPropertyLine(line: string): { key: string; value: string } {
  const separatorIndex = findPropertySeparatorIndex(line);

  if (separatorIndex < 0) {
    return { key: line.trim(), value: '' };
  }

  const rawKey = line.slice(0, separatorIndex).trimEnd();
  let valueStart = separatorIndex;

  if (/\s/u.test(line[separatorIndex])) {
    while (valueStart < line.length && /\s/u.test(line[valueStart])) {
      valueStart += 1;
    }

    if (line[valueStart] === '=' || line[valueStart] === ':') {
      valueStart += 1;
    }
  } else {
    valueStart += 1;
  }

  while (valueStart < line.length && /\s/u.test(line[valueStart])) {
    valueStart += 1;
  }

  return {
    key: rawKey,
    value: line.slice(valueStart),
  };
}

function findPropertySeparatorIndex(line: string): number {
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '\\') {
      index += 1;
      continue;
    }

    if (character === '=' || character === ':' || /\s/u.test(character)) {
      return index;
    }
  }

  return -1;
}

function unescapePropertyText(text: string): string {
  let result = '';

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character !== '\\') {
      result += character;
      continue;
    }

    if (index === text.length - 1) {
      result += '\\';
      continue;
    }

    index += 1;
    const escapedCharacter = text[index];

    switch (escapedCharacter) {
      case 't':
        result += '\t';
        break;
      case 'r':
        result += '\r';
        break;
      case 'n':
        result += '\n';
        break;
      case 'f':
        result += '\f';
        break;
      case 'u': {
        const unicodeEscape = text.slice(index + 1, index + 5);
        if (/^[A-Fa-f0-9]{4}$/u.test(unicodeEscape)) {
          result += String.fromCodePoint(Number.parseInt(unicodeEscape, 16));
          index += 4;
        } else {
          result += 'u';
        }
        break;
      }
      default:
        result += escapedCharacter;
        break;
    }
  }

  return result.trim();
}

function requireNonEmptyProperty(
  properties: Readonly<Record<string, string>>,
  relativePath: string,
  propertyName: string,
): string {
  const value = properties[propertyName]?.trim();

  if (!value) {
    throw new Error(`Wrapper properties file '${relativePath}' must define '${propertyName}'.`);
  }

  return value;
}

function requireExactPropertyValue(
  properties: Readonly<Record<string, string>>,
  relativePath: string,
  propertyName: string,
  expectedValue: string,
  messageSuffix: string,
): void {
  const value = requireNonEmptyProperty(properties, relativePath, propertyName);

  if (value !== expectedValue) {
    throw new Error(
      `Wrapper properties file '${relativePath}' must set '${propertyName}' to '${expectedValue}' (${messageSuffix}).`,
    );
  }
}

function requireOptionalPropertyValue(
  properties: Readonly<Record<string, string>>,
  relativePath: string,
  propertyName: string,
  expectedValue: string,
): void {
  const value = properties[propertyName]?.trim();

  if (!value) {
    return;
  }

  if (value !== expectedValue) {
    throw new Error(
      `Wrapper properties file '${relativePath}' must set '${propertyName}' to '${expectedValue}' when present.`,
    );
  }
}
