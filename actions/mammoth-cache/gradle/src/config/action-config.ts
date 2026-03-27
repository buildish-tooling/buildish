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

import { readFile, realpath } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { CiJobContext } from '../ci/types';
import type { CoreExecutionPhase } from '../core/lifecycle';
import {
  isAbsolutePosixOrWindowsPath,
  normalizeUserSuppliedRelativePath,
  parseSerializedJson,
  validateArray,
  validateRecord,
  validateString,
} from '../validation';
import {
  CACHE_KEY_TEMPLATE_PLACEHOLDERS,
  JOB_MODES,
  RESTORE_CLEANUP_MODES,
  type ConfiguredCachePartitionInput,
  type NormalizedActionConfig,
  type RawActionInputs,
  type WrapperSelectionMode,
} from './types';

const NAME_PATTERN = /^[A-Za-z0-9._ -]{1,100}$/;
const CACHE_KEY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CACHE_PARTITION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const EXPLICIT_PATH_GLOB_PATTERN = /[*?[\]{}!]/;
const MAX_TEMPLATE_LENGTH = 200;
const UNSUPPORTED_GLOB_TOKENS_PATTERN = /[?[\]{}!]/u;
const CACHE_SCHEMA_VERSION = 2;

/**
 * Minimal abstraction over the GitHub Actions input API.
 *
 * Tests use this interface to provide deterministic input values without pulling in the
 * real `@actions/core` implementation.
 */
export interface InputProvider {
  /**
   * Reads a named action input.
   *
   * @param name GitHub Actions input name such as `cache-enabled` or `job-mode`.
   * @param options Optional read behavior passed through to the provider.
   * @param options.required When `true`, the provider may throw if the input is absent. This module
   *   currently relies on explicit normalization defaults instead of required inputs.
   * @param options.trimWhitespace When `true`, surrounding whitespace is removed before returning.
   *   `readActionInputs()` always requests trimmed values.
   * @returns Raw string input value; missing optional inputs are returned as an empty string.
   */
  getInput(name: string, options?: { required?: boolean; trimWhitespace?: boolean }): string;
}

/**
 * Extra state required to turn raw user inputs into normalized runtime configuration.
 */
export interface NormalizeActionConfigOptions {
  /**
   * Action phase being normalized.
   *
   * Valid values are `prepare` and `finalize`; this is supplied by bootstrap, not user input.
   */
  readonly phase: CoreExecutionPhase;
  /**
   * Provider-neutral CI context used for event-dependent defaults.
   *
   * This is required so read-only mode and other derived behavior do not depend on raw env access.
   */
  readonly ciContext: CiJobContext;
  /**
   * Optional environment override used for supported Gradle user home resolution.
   *
   * Defaults to `process.env`-equivalent runtime state when omitted by higher-level callers.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Options for loading file-backed action configuration.
 */
export interface ResolveActionInputsFromConfigFileOptions {
  /** Repository workspace root used to resolve the optional `config-file` input. */
  readonly workspace: string;
  /** Optional file-reader override for focused tests. */
  readonly readFileImpl?: typeof readFile;
  /** Optional realpath override for focused tests. */
  readonly realpathImpl?: typeof realpath;
}

/**
 * Reads every supported action input exactly once and returns the raw string values.
 */
export function readActionInputs(inputProvider: InputProvider): RawActionInputs {
  return {
    configFile: inputProvider.getInput('config-file', { trimWhitespace: true }),
    baseDirectory: inputProvider.getInput('base-directory', { trimWhitespace: true }),
    cacheEnabled: inputProvider.getInput('cache-enabled', { trimWhitespace: true }),
    readOnly: inputProvider.getInput('read-only', { trimWhitespace: true }),
    jobMode: inputProvider.getInput('job-mode', { trimWhitespace: true }),
    dependentJobs: inputProvider.getInput('dependent-jobs', { trimWhitespace: true }),
    allowDuplicateDependentDeltaPaths: inputProvider.getInput(
      'allow-duplicate-dependent-delta-paths',
      { trimWhitespace: true },
    ),
    cacheKeyPrefix: inputProvider.getInput('cache-key-prefix', { trimWhitespace: true }),
    cacheKeyTemplate: inputProvider.getInput('cache-key-template', { trimWhitespace: true }),
    cachePartitions: inputProvider.getInput('cache-partitions', { trimWhitespace: true }),
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
    restoreCleanupMode: inputProvider.getInput('restore-cleanup-mode', { trimWhitespace: true }),
    gradleUserHome: inputProvider.getInput('gradle-user-home', { trimWhitespace: true }),
    setupJava: inputProvider.getInput('setup-java', { trimWhitespace: true }),
    githubToken: inputProvider.getInput('github-token', { trimWhitespace: true }),
  };
}

/**
 * Loads the optional workspace-relative config file and overlays it with explicit action inputs.
 *
 * Direct action inputs always win over file-backed values so workflows can keep local defaults in a
 * committed config file while retaining per-job overrides in workflow YAML.
 */
export async function resolveActionInputsFromConfigFile(
  directInputs: RawActionInputs,
  options: ResolveActionInputsFromConfigFileOptions,
): Promise<RawActionInputs> {
  const configFile = directInputs.configFile.trim();
  if (configFile.length === 0) {
    return directInputs;
  }

  const normalizedConfigFile = normalizeRelativePath(configFile, 'config-file');
  if (normalizedConfigFile === '.') {
    throw new Error(
      'config-file must point to a .json, .yml, or .yaml file inside the repository workspace.',
    );
  }

  const configFilePath = await resolveConfigFilePath(
    options.workspace,
    normalizedConfigFile,
    options,
  );
  const contents = await readConfigFileContents(configFilePath, normalizedConfigFile, options);
  const fileInputs = serializeConfigFileInputs(
    parseConfigFileContents(contents, normalizedConfigFile),
    normalizedConfigFile,
  );

  return overlayConfiguredInputs(fileInputs, directInputs);
}

/**
 * Validates and normalizes raw GitHub Action inputs into the internal runtime config.
 *
 * This function is intentionally strict:
 * - booleans must be explicit `true` / `false`
 * - path-like inputs must stay inside the repository workspace
 * - unsupported v1 features fail early with actionable messages
 */
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
  const allowDuplicateDependentDeltaPaths = parseBooleanInput(
    rawInputs.allowDuplicateDependentDeltaPaths || 'false',
    'allow-duplicate-dependent-delta-paths',
  );
  const cacheKeyPrefix = validateCacheKeyPrefix(
    rawInputs.cacheKeyPrefix || 'buildish-mammoth-gradle-cache-',
  );
  const cacheKeyTemplate = validateCacheKeyTemplate(rawInputs.cacheKeyTemplate);
  const cachePartitions = parseCachePartitionsInput(rawInputs.cachePartitions);
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
  const restoreCleanupMode = parseEnumInput(
    rawInputs.restoreCleanupMode || 'none',
    RESTORE_CLEANUP_MODES,
    'restore-cleanup-mode',
  );
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
    allowDuplicateDependentDeltaPaths,
    cacheKeyPrefix,
    cacheKeyTemplate,
    cachePartitions,
    cacheSchemaVersion: CACHE_SCHEMA_VERSION,
    wrapperSelectionMode,
    wrapperPropertiesGlob,
    defaultWrapperPropertiesFile: joinWithinBaseDirectory(
      baseDirectory,
      'gradle/wrapper/gradle-wrapper.properties',
    ),
    wrapperPropertiesFiles: explicitWrapperPropertiesFiles,
    cleanupEnabled,
    restoreCleanupMode,
    gradleUserHome,
  };
}

function createEmptyRawActionInputs(): RawActionInputs {
  return {
    configFile: '',
    baseDirectory: '',
    cacheEnabled: '',
    readOnly: '',
    jobMode: '',
    dependentJobs: '',
    allowDuplicateDependentDeltaPaths: '',
    cacheKeyPrefix: '',
    cacheKeyTemplate: '',
    cachePartitions: '',
    processAllWrapperFiles: '',
    wrapperPropertiesGlob: '',
    wrapperPropertiesFiles: '',
    cleanupEnabled: '',
    restoreCleanupMode: '',
    gradleUserHome: '',
    setupJava: '',
    githubToken: '',
  };
}

async function resolveConfigFilePath(
  workspace: string,
  normalizedConfigFile: string,
  options: ResolveActionInputsFromConfigFileOptions,
): Promise<string> {
  const realpathImpl = options.realpathImpl ?? realpath;
  const workspaceRealPath = await resolveRealPath(realpathImpl, workspace, 'workspace');
  const candidatePath = path.resolve(workspaceRealPath, normalizedConfigFile);
  const configFileRealPath = await resolveRealPath(
    realpathImpl,
    candidatePath,
    `config-file '${normalizedConfigFile}'`,
  );

  if (!isPathInside(workspaceRealPath, configFileRealPath)) {
    throw new Error(
      `config-file '${normalizedConfigFile}' must stay within the repository workspace after symlink resolution.`,
    );
  }

  return configFileRealPath;
}

async function resolveRealPath(
  realpathImpl: typeof realpath,
  targetPath: string,
  label: string,
): Promise<string> {
  try {
    return await realpathImpl(targetPath);
  } catch (error: unknown) {
    throw new Error(
      `Could not resolve ${label}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function readConfigFileContents(
  configFilePath: string,
  normalizedConfigFile: string,
  options: ResolveActionInputsFromConfigFileOptions,
): Promise<string> {
  const readFileImpl = options.readFileImpl ?? readFile;

  try {
    const contents = await readFileImpl(configFilePath, 'utf8');
    return contents.replace(/^\uFEFF/u, '');
  } catch (error: unknown) {
    throw new Error(
      `Could not read config-file '${normalizedConfigFile}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function parseConfigFileContents(
  contents: string,
  normalizedConfigFile: string,
): Record<string, unknown> {
  const extension = path.posix.extname(normalizedConfigFile).toLowerCase();
  let parsed: unknown;

  switch (extension) {
    case '.json':
      parsed = parseSerializedJson(contents, `config-file '${normalizedConfigFile}'`);
      break;
    case '.yaml':
    case '.yml':
      try {
        parsed = parseYaml(contents, {
          strict: true,
          stringKeys: true,
          uniqueKeys: true,
          merge: false,
          maxAliasCount: 0,
          prettyErrors: true,
        });
      } catch (error: unknown) {
        throw new Error(
          `Could not parse config-file '${normalizedConfigFile}': ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      break;
    default:
      throw new Error(
        `config-file '${normalizedConfigFile}' must use a .json, .yml, or .yaml extension.`,
      );
  }

  return validateRecord(parsed, `config-file '${normalizedConfigFile}'`);
}

function serializeConfigFileInputs(
  values: Record<string, unknown>,
  normalizedConfigFile: string,
): RawActionInputs {
  const inputs: Record<keyof RawActionInputs, string> = createEmptyRawActionInputs();

  for (const [key, value] of Object.entries(values)) {
    switch (key) {
      case 'config-file':
        throw new Error(
          `config-file '${normalizedConfigFile}' must not contain nested config-file entries.`,
        );
      case 'base-directory':
        inputs.baseDirectory = serializeStringConfigValue(value, key);
        break;
      case 'cache-enabled':
        inputs.cacheEnabled = serializeBooleanLikeConfigValue(value, key);
        break;
      case 'read-only':
        inputs.readOnly = serializeBooleanLikeConfigValue(value, key);
        break;
      case 'job-mode':
        inputs.jobMode = serializeStringConfigValue(value, key);
        break;
      case 'dependent-jobs':
        inputs.dependentJobs = serializeListLikeConfigValue(value, key);
        break;
      case 'allow-duplicate-dependent-delta-paths':
        inputs.allowDuplicateDependentDeltaPaths = serializeBooleanLikeConfigValue(value, key);
        break;
      case 'cache-key-prefix':
        inputs.cacheKeyPrefix = serializeStringConfigValue(value, key);
        break;
      case 'cache-key-template':
        inputs.cacheKeyTemplate = serializeStringConfigValue(value, key);
        break;
      case 'cache-partitions':
        inputs.cachePartitions = serializeStructuredConfigValue(value, key);
        break;
      case 'process-all-wrapper-files':
        inputs.processAllWrapperFiles = serializeBooleanLikeConfigValue(value, key);
        break;
      case 'wrapper-properties-glob':
        inputs.wrapperPropertiesGlob = serializeStringConfigValue(value, key);
        break;
      case 'wrapper-properties-files':
        inputs.wrapperPropertiesFiles = serializeListLikeConfigValue(value, key);
        break;
      case 'cleanup-enabled':
        inputs.cleanupEnabled = serializeBooleanLikeConfigValue(value, key);
        break;
      case 'restore-cleanup-mode':
        inputs.restoreCleanupMode = serializeStringConfigValue(value, key);
        break;
      case 'gradle-user-home':
        inputs.gradleUserHome = serializeStringConfigValue(value, key);
        break;
      case 'setup-java':
        inputs.setupJava = serializeBooleanLikeConfigValue(value, key);
        break;
      case 'github-token':
        throw new Error(
          `config-file '${normalizedConfigFile}' must not contain github-token. Pass it directly as an action input or environment secret instead.`,
        );
      default:
        throw new Error(
          `config-file '${normalizedConfigFile}' contains unsupported key '${key}'. Use the same kebab-case names as action inputs.`,
        );
    }
  }

  return inputs;
}

function serializeStringConfigValue(value: unknown, label: string): string {
  return validateString(value, label).trim();
}

function serializeBooleanLikeConfigValue(value: unknown, label: string): string {
  if (typeof value === 'boolean') {
    return String(value);
  }

  return serializeStringConfigValue(value, label);
}

function serializeListLikeConfigValue(value: unknown, label: string): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  return validateArray(value, label)
    .map((entry, index) => validateString(entry, `${label} entry ${index}`).trim())
    .filter((entry) => entry.length > 0)
    .join('\n');
}

function serializeStructuredConfigValue(value: unknown, label: string): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  try {
    return JSON.stringify(value);
  } catch (error: unknown) {
    throw new Error(
      `Could not serialize ${label} from config-file: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function overlayConfiguredInputs(
  fileInputs: RawActionInputs,
  directInputs: RawActionInputs,
): RawActionInputs {
  return {
    configFile: directInputs.configFile,
    baseDirectory: directInputs.baseDirectory || fileInputs.baseDirectory,
    cacheEnabled: directInputs.cacheEnabled || fileInputs.cacheEnabled,
    readOnly: directInputs.readOnly || fileInputs.readOnly,
    jobMode: directInputs.jobMode || fileInputs.jobMode,
    dependentJobs: directInputs.dependentJobs || fileInputs.dependentJobs,
    allowDuplicateDependentDeltaPaths:
      directInputs.allowDuplicateDependentDeltaPaths ||
      fileInputs.allowDuplicateDependentDeltaPaths,
    cacheKeyPrefix: directInputs.cacheKeyPrefix || fileInputs.cacheKeyPrefix,
    cacheKeyTemplate: directInputs.cacheKeyTemplate || fileInputs.cacheKeyTemplate,
    cachePartitions: directInputs.cachePartitions || fileInputs.cachePartitions,
    processAllWrapperFiles:
      directInputs.processAllWrapperFiles || fileInputs.processAllWrapperFiles,
    wrapperPropertiesGlob: directInputs.wrapperPropertiesGlob || fileInputs.wrapperPropertiesGlob,
    wrapperPropertiesFiles:
      directInputs.wrapperPropertiesFiles || fileInputs.wrapperPropertiesFiles,
    cleanupEnabled: directInputs.cleanupEnabled || fileInputs.cleanupEnabled,
    restoreCleanupMode: directInputs.restoreCleanupMode || fileInputs.restoreCleanupMode,
    gradleUserHome: directInputs.gradleUserHome || fileInputs.gradleUserHome,
    setupJava: directInputs.setupJava || fileInputs.setupJava,
    githubToken: directInputs.githubToken,
  };
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

/**
 * Parses strict boolean inputs so ambiguous values fail fast instead of silently
 * changing behavior later in the action flow.
 */
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

/**
 * Parses a closed string enum exposed through action inputs.
 */
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

/**
 * Splits comma- or newline-separated list inputs into trimmed non-empty entries.
 */
function parseListInput(input: string): string[] {
  return input
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * Validates human-readable names that later influence cache coordination behavior.
 */
function validateNamedValue(value: string, inputName: string): string {
  if (!NAME_PATTERN.test(value)) {
    throw new Error(
      `${inputName} contains unsupported characters. Allowed characters are letters, numbers, space, dot, underscore, and dash.`,
    );
  }

  return value;
}

/**
 * Restricts the cache key prefix to a conservative character set so future cache-key
 * composition never has to deal with unsafe separators or shell-sensitive values.
 */
function validateCacheKeyPrefix(input: string): string {
  const trimmed = input.trim();

  if (!CACHE_KEY_PREFIX_PATTERN.test(trimmed)) {
    throw new Error(
      'cache-key-prefix must start with an alphanumeric character and only contain letters, numbers, dot, underscore, and dash.',
    );
  }

  return trimmed;
}

/**
 * Validates the optional cache key template against the small supported placeholder set.
 */
function validateCacheKeyTemplate(input: string): string | null {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length > MAX_TEMPLATE_LENGTH) {
    throw new Error(`cache-key-template must be at most ${MAX_TEMPLATE_LENGTH} characters.`);
  }

  const allowedPlaceholders = new Set<string>(CACHE_KEY_TEMPLATE_PLACEHOLDERS);
  const placeholders = [...trimmed.matchAll(/\$\{([A-Za-z0-9]+)}/g)];

  for (const match of placeholders) {
    if (!allowedPlaceholders.has(match[1])) {
      throw new Error(`cache-key-template uses unsupported placeholder '${match[1]}'.`);
    }
  }

  const literalPortion = trimmed.replace(/\$\{([A-Za-z0-9]+)}/g, '');

  if (!/^[A-Za-z0-9._:-]*$/.test(literalPortion)) {
    throw new Error(
      'cache-key-template may only contain supported placeholders and the literal characters A-Z, a-z, 0-9, dot, underscore, colon, and dash.',
    );
  }

  if (!trimmed.includes('${partitionFingerprint}')) {
    throw new Error(
      'cache-key-template must include ${partitionFingerprint} so different cache partition layouts do not share the same cache key.',
    );
  }

  return trimmed;
}

/**
 * Parses the optional JSON partition configuration input.
 *
 * The input must be a JSON array of objects with `id`, `includes`, and optional `excludes` fields.
 * Includes use a restricted Gradle-user-home-relative glob subset and built-in partitions may be
 * disabled by supplying an empty include list.
 */
function parseCachePartitionsInput(input: string): readonly ConfiguredCachePartitionInput[] {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const parsed = parseSerializedJson(trimmed, 'cache-partitions');
  const partitionValues = validateArray(parsed, 'cache-partitions');
  const seenIds = new Set<string>();

  return partitionValues.map((partitionValue, index) => {
    const partition = validateRecord(partitionValue, `cache-partitions entry ${index}`);
    const id = validateCachePartitionId(partition.id, `cache-partitions entry ${index} id`);
    if (seenIds.has(id)) {
      throw new Error(`cache-partitions contains duplicate partition id '${id}'.`);
    }
    seenIds.add(id);

    return {
      id,
      includes: validateCachePartitionGlobList(
        partition.includes,
        `cache-partitions entry '${id}' includes`,
        'include',
      ),
      excludes: validateCachePartitionGlobList(
        partition.excludes ?? [],
        `cache-partitions entry '${id}' excludes`,
        'exclude',
      ),
    } satisfies ConfiguredCachePartitionInput;
  });
}

function validateCachePartitionId(value: unknown, label: string): string {
  const id = validateString(value, label).trim();
  if (!CACHE_PARTITION_ID_PATTERN.test(id)) {
    throw new Error(
      `${label} must match ${CACHE_PARTITION_ID_PATTERN} using lowercase letters, numbers, and dashes only.`,
    );
  }

  return id;
}

function validateCachePartitionGlobList(
  value: unknown,
  label: string,
  kind: 'include' | 'exclude',
): readonly string[] {
  const entries = validateArray(value, label);
  return entries.map((entryValue, index) =>
    normalizeCachePartitionGlob(entryValue, `${label} entry ${index}`, kind),
  );
}

function normalizeCachePartitionGlob(
  value: unknown,
  label: string,
  kind: 'include' | 'exclude',
): string {
  const raw = validateString(value, label).trim();
  if (raw.length === 0) {
    throw new Error(`${label} must not be blank.`);
  }

  if (raw.startsWith('~')) {
    throw new Error(`${label} must not use home-directory expansion.`);
  }

  const posixRaw = raw.replaceAll('\\', '/');
  const rawSegments = posixRaw.split('/');
  if (rawSegments.includes('..')) {
    throw new Error(`${label} must not use '..' path traversal segments.`);
  }
  if (rawSegments.includes('.')) {
    throw new Error(`${label} must not contain '.' path segments.`);
  }

  const normalized = path.posix.normalize(posixRaw);
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    isAbsolutePosixOrWindowsPath(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error(`${label} must be a Gradle-user-home-relative glob.`);
  }

  if (normalized.startsWith('!/')) {
    throw new Error(`${label} must not be a negated glob.`);
  }

  if (normalized.startsWith('!')) {
    throw new Error(`${label} must not be a negated glob.`);
  }

  if (UNSUPPORTED_GLOB_TOKENS_PATTERN.test(normalized)) {
    throw new Error(
      `${label} uses unsupported glob syntax. Supported wildcards are '*' within a segment and '**' as a whole path segment.`,
    );
  }

  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new Error(`${label} must not contain empty path segments.`);
    }
    if (segment.includes('**') && segment !== '**') {
      throw new Error(`${label} may only use '**' as a complete path segment.`);
    }
  }

  if (kind === 'include') {
    if (segments.at(-1) !== '**') {
      throw new Error(`${label} must end with '/**'.`);
    }
    if (segments.slice(0, -1).includes('**')) {
      throw new Error(`${label} may only use '**' as the final path segment.`);
    }
  }

  return normalized;
}

/**
 * Determines how wrapper properties should be discovered once mutually exclusive input
 * combinations have been validated.
 */
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

/**
 * Resolves an explicitly provided wrapper properties file relative to the configured
 * base directory while preventing globbing or traversal semantics.
 */
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

/**
 * Resolves the wrapper discovery glob relative to the normalized base directory.
 */
function resolveGlobPattern(baseDirectory: string, input: string): string {
  const normalized = normalizeRelativePath(input, 'wrapper-properties-glob');
  return joinWithinBaseDirectory(baseDirectory, normalized);
}

/**
 * Joins a path underneath the configured base directory while preserving the simpler
 * relative form for the repository root.
 */
function joinWithinBaseDirectory(baseDirectory: string, relativePath: string): string {
  if (baseDirectory === '.') {
    return relativePath;
  }

  return path.posix.join(baseDirectory, relativePath);
}

/**
 * Normalizes user-controlled relative paths and rejects anything that attempts to leave
 * the repository workspace.
 */
function normalizeRelativePath(input: string, inputName: string): string {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    throw new Error(`${inputName} must not be empty.`);
  }

  if (trimmed.startsWith('~')) {
    throw new Error(`${inputName} must not use home-directory expansion.`);
  }

  return normalizeUserSuppliedRelativePath(trimmed, inputName);
}

/**
 * Pull requests default to read-only mode, so untrusted branches do not mutate the shared
 * cache state unless the caller opts in explicitly.
 */
function defaultReadOnlyForEvent(eventName: string): boolean {
  return eventName === 'pull_request' || eventName === 'pull_request_target';
}

/**
 * v1 intentionally supports only the default Gradle user home, so later cache logic can
 * make strong assumptions about on-disk layout.
 */
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
