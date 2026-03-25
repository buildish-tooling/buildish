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

import * as core from '@actions/core';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CiJobContext } from '../ci/types';
import {
  CACHE_KEY_TEMPLATE_PLACEHOLDERS,
  JOB_MODES,
  type NormalizedActionConfig,
  type RawActionInputs,
  type WrapperSelectionMode,
} from './types';

const NAME_PATTERN = /^[A-Za-z0-9._ -]{1,100}$/;
const CACHE_KEY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const EXPLICIT_PATH_GLOB_PATTERN = /[*?[\]{}!]/;
const MAX_TEMPLATE_LENGTH = 200;
const CACHE_SCHEMA_VERSION = 1;

export interface InputProvider {
  getInput(name: string, options?: { required?: boolean; trimWhitespace?: boolean }): string;
}

export interface NormalizeActionConfigOptions {
  readonly phase: 'main' | 'post';
  readonly ciContext: CiJobContext;
  readonly env?: NodeJS.ProcessEnv;
}

export function readActionInputs(inputProvider: InputProvider = core): RawActionInputs {
  return {
    baseDirectory: inputProvider.getInput('base-directory', { trimWhitespace: true }),
    cacheEnabled: inputProvider.getInput('cache-enabled', { trimWhitespace: true }),
    readOnly: inputProvider.getInput('read-only', { trimWhitespace: true }),
    jobMode: inputProvider.getInput('job-mode', { trimWhitespace: true }),
    dependentJobs: inputProvider.getInput('dependent-jobs', { trimWhitespace: true }),
    cacheKeyPrefix: inputProvider.getInput('cache-key-prefix', { trimWhitespace: true }),
    cacheKeyTemplate: inputProvider.getInput('cache-key-template', { trimWhitespace: true }),
    processAllWrapperFiles: inputProvider.getInput('process-all-wrapper-files', {
      trimWhitespace: true,
    }),
    wrapperPropertiesGlob: inputProvider.getInput('wrapper-properties-glob', {
      trimWhitespace: true,
    }),
    wrapperPropertiesFiles: inputProvider.getInput('wrapper-properties-files', {
      trimWhitespace: true,
    }),
    cleanupEnabled: inputProvider.getInput('cleanup-enabled', { trimWhitespace: true }),
    gradleUserHome: inputProvider.getInput('gradle-user-home', { trimWhitespace: true }),
    setupJava: inputProvider.getInput('setup-java', { trimWhitespace: true }),
  };
}

export function normalizeActionConfig(
  rawInputs: RawActionInputs,
  options: NormalizeActionConfigOptions,
): NormalizedActionConfig {
  const baseDirectory = normalizeRelativePath(rawInputs.baseDirectory || '.', 'base-directory');
  const cacheEnabled = parseBooleanInput(rawInputs.cacheEnabled || 'true', 'cache-enabled');
  const jobMode = parseEnumInput(rawInputs.jobMode || 'standalone', JOB_MODES, 'job-mode');
  const dependentJobs = parseListInput(rawInputs.dependentJobs).map((jobName) =>
    validateNamedValue(jobName, 'dependent-jobs'),
  );
  const cacheKeyPrefix = validateCacheKeyPrefix(rawInputs.cacheKeyPrefix || 'gradle-cache-');
  const cacheKeyTemplate = validateCacheKeyTemplate(rawInputs.cacheKeyTemplate);
  const processAllWrapperFiles = parseBooleanInput(
    rawInputs.processAllWrapperFiles || 'false',
    'process-all-wrapper-files',
  );
  const explicitWrapperPropertiesFiles = parseListInput(rawInputs.wrapperPropertiesFiles).map(
    (filePath) => resolveWrapperPropertiesPath(baseDirectory, filePath),
  );
  const wrapperSelectionMode = determineWrapperSelectionMode(
    processAllWrapperFiles,
    explicitWrapperPropertiesFiles.length,
  );
  const wrapperPropertiesGlob = resolveGlobPattern(
    baseDirectory,
    rawInputs.wrapperPropertiesGlob || '**/gradle/wrapper/gradle-wrapper.properties',
  );
  const cleanupEnabled = parseBooleanInput(rawInputs.cleanupEnabled || 'true', 'cleanup-enabled');
  const readOnly =
    rawInputs.readOnly.length > 0
      ? parseBooleanInput(rawInputs.readOnly, 'read-only')
      : defaultReadOnlyForEvent(options.ciContext.eventName);
  const gradleUserHome = normalizeGradleUserHome(rawInputs.gradleUserHome, options.env);
  const setupJava = parseBooleanInput(rawInputs.setupJava || 'false', 'setup-java');

  if (dependentJobs.length > 0 && jobMode === 'standalone') {
    throw new Error('dependent-jobs can only be used with distributed job modes.');
  }

  if (setupJava) {
    throw new Error(
      'setup-java=true is not supported in v1. Run actions/setup-java before this action instead.',
    );
  }

  return {
    phase: options.phase,
    baseDirectory,
    cacheEnabled,
    readOnly,
    jobMode,
    dependentJobs,
    cacheKeyPrefix,
    cacheKeyTemplate,
    cacheSchemaVersion: CACHE_SCHEMA_VERSION,
    wrapperSelectionMode,
    wrapperPropertiesGlob,
    defaultWrapperPropertiesFile: joinWithinBaseDirectory(
      baseDirectory,
      'gradle/wrapper/gradle-wrapper.properties',
    ),
    wrapperPropertiesFiles: explicitWrapperPropertiesFiles,
    cleanupEnabled,
    gradleUserHome,
  };
}

function parseBooleanInput(input: string, inputName: string): boolean {
  const normalized = input.trim().toLowerCase();

  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  throw new Error(`${inputName} must be either 'true' or 'false'.`);
}

function parseEnumInput<const T extends readonly string[]>(
  input: string,
  allowedValues: T,
  inputName: string,
): T[number] {
  if (allowedValues.includes(input as T[number])) {
    return input as T[number];
  }

  throw new Error(`${inputName} must be one of: ${allowedValues.join(', ')}.`);
}

function parseListInput(input: string): string[] {
  return input
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function validateNamedValue(value: string, inputName: string): string {
  if (!NAME_PATTERN.test(value)) {
    throw new Error(
      `${inputName} contains unsupported characters. Allowed characters are letters, numbers, space, dot, underscore, and dash.`,
    );
  }

  return value;
}

function validateCacheKeyPrefix(input: string): string {
  const trimmed = input.trim();

  if (!CACHE_KEY_PREFIX_PATTERN.test(trimmed)) {
    throw new Error(
      'cache-key-prefix must start with an alphanumeric character and only contain letters, numbers, dot, underscore, and dash.',
    );
  }

  return trimmed;
}

function validateCacheKeyTemplate(input: string): string | null {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length > MAX_TEMPLATE_LENGTH) {
    throw new Error(`cache-key-template must be at most ${MAX_TEMPLATE_LENGTH} characters.`);
  }

  const allowedPlaceholders = new Set<string>(CACHE_KEY_TEMPLATE_PLACEHOLDERS);
  const placeholders = [...trimmed.matchAll(/\$\{([A-Za-z0-9]+)\}/g)];

  for (const match of placeholders) {
    if (!allowedPlaceholders.has(match[1])) {
      throw new Error(`cache-key-template uses unsupported placeholder '${match[1]}'.`);
    }
  }

  const literalPortion = trimmed.replace(/\$\{([A-Za-z0-9]+)\}/g, '');

  if (!/^[A-Za-z0-9._:-]*$/.test(literalPortion)) {
    throw new Error(
      'cache-key-template may only contain supported placeholders and the literal characters A-Z, a-z, 0-9, dot, underscore, colon, and dash.',
    );
  }

  return trimmed;
}

function determineWrapperSelectionMode(
  processAllWrapperFiles: boolean,
  explicitWrapperPropertiesFileCount: number,
): WrapperSelectionMode {
  if (processAllWrapperFiles && explicitWrapperPropertiesFileCount > 0) {
    throw new Error('process-all-wrapper-files cannot be combined with wrapper-properties-files.');
  }

  if (explicitWrapperPropertiesFileCount > 0) {
    return 'explicit';
  }

  if (processAllWrapperFiles) {
    return 'all';
  }

  return 'default';
}

function resolveWrapperPropertiesPath(baseDirectory: string, input: string): string {
  const normalizedRelativePath = normalizeRelativePath(input, 'wrapper-properties-files');

  if (EXPLICIT_PATH_GLOB_PATTERN.test(normalizedRelativePath)) {
    throw new Error(
      'wrapper-properties-files entries must be explicit file paths, not glob patterns.',
    );
  }

  if (path.posix.basename(normalizedRelativePath) !== 'gradle-wrapper.properties') {
    throw new Error(
      'wrapper-properties-files entries must point to gradle-wrapper.properties files.',
    );
  }

  return joinWithinBaseDirectory(baseDirectory, normalizedRelativePath);
}

function resolveGlobPattern(baseDirectory: string, input: string): string {
  const normalized = normalizeRelativePath(input, 'wrapper-properties-glob');
  return joinWithinBaseDirectory(baseDirectory, normalized);
}

function joinWithinBaseDirectory(baseDirectory: string, relativePath: string): string {
  if (baseDirectory === '.') {
    return relativePath;
  }

  return path.posix.join(baseDirectory, relativePath);
}

function normalizeRelativePath(input: string, inputName: string): string {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    throw new Error(`${inputName} must not be empty.`);
  }

  if (trimmed.startsWith('~')) {
    throw new Error(`${inputName} must not use home-directory expansion.`);
  }

  const unixPath = trimmed.replaceAll('\\', '/');

  if (path.posix.isAbsolute(unixPath)) {
    throw new Error(`${inputName} must be a relative path.`);
  }

  const normalizedPath = path.posix.normalize(unixPath);

  if (
    normalizedPath === '..' ||
    normalizedPath.startsWith('../') ||
    normalizedPath.includes('/../')
  ) {
    throw new Error(`${inputName} must stay within the repository workspace.`);
  }

  return normalizedPath === '' ? '.' : normalizedPath.replace(/\/$/, '') || '.';
}

function defaultReadOnlyForEvent(eventName: string): boolean {
  return eventName === 'pull_request' || eventName === 'pull_request_target';
}

function normalizeGradleUserHome(input: string, env: NodeJS.ProcessEnv | undefined): string {
  const supportedDefault = env?.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle');
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return supportedDefault;
  }

  if (path.resolve(trimmed) !== path.resolve(supportedDefault)) {
    throw new Error(
      'Non-default gradle-user-home values are not supported in v1. Use the default GRADLE_USER_HOME location.',
    );
  }

  return supportedDefault;
}
