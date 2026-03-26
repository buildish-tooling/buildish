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

import path from 'node:path';

const LOWERCASE_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const WINDOWS_DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/u;

/**
 * Narrow utility for guarding JSON values before object property access.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parses serialized JSON and preserves the original error as the `cause`.
 */
export function parseSerializedJson(serializedValue: string, label: string): unknown {
  try {
    return JSON.parse(serializedValue);
  } catch (error: unknown) {
    throw new Error(
      `Could not parse serialized ${label}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Parses serialized JSON and requires the top-level value to be an object.
 */
export function parseSerializedJsonObject(
  serializedValue: string,
  label: string,
): Record<string, unknown> {
  const parsed = parseSerializedJson(serializedValue, label);

  if (!isRecord(parsed)) {
    throw new Error(`Serialized ${label} must be a JSON object.`);
  }

  return parsed;
}

/**
 * Requires a string value.
 */
export function validateString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }

  return value;
}

/**
 * Requires an array value.
 */
export function validateArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }

  return value;
}

/**
 * Requires a plain object value.
 */
export function validateRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value;
}

/**
 * Requires a non-negative integer value.
 */
export function validateNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return value as number;
}

/**
 * Requires a non-negative finite number value.
 */
export function validateNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`);
  }

  return value;
}

/**
 * Requires a lowercase hexadecimal SHA-256 digest.
 */
export function validateLowercaseSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !LOWERCASE_SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase hexadecimal SHA-256 digest.`);
  }

  return value;
}

/**
 * Treats POSIX-absolute and Windows-rooted inputs as non-relative paths.
 *
 * Windows drive prefixes are rejected even without a separator (for example `C:tmp`) because
 * they are not safe portable relative paths.
 */
export function isAbsolutePosixOrWindowsPath(value: string): boolean {
  return (
    path.posix.isAbsolute(value) ||
    WINDOWS_DRIVE_PREFIX_PATTERN.test(value) ||
    value.startsWith('\\')
  );
}

/**
 * Normalizes a user-supplied repository-relative path to canonical POSIX form.
 *
 * Windows separator characters are accepted for usability, but Windows drive-prefixed,
 * UNC, and rooted paths are rejected before normalization.
 */
export function normalizeUserSuppliedRelativePath(value: string, label: string): string {
  if (isAbsolutePosixOrWindowsPath(value)) {
    throw new Error(`${label} must be a relative path.`);
  }

  const normalizedPath = path.posix.normalize(value.replaceAll('\\', '/'));

  if (
    normalizedPath === '..' ||
    normalizedPath.startsWith('../') ||
    normalizedPath.includes('/../')
  ) {
    throw new Error(`${label} must stay within the repository workspace.`);
  }

  return normalizedPath === '' ? '.' : normalizedPath.replace(/\/$/, '') || '.';
}

/**
 * Requires a normalized relative POSIX path rooted beneath a caller-defined location.
 */
export function validateNormalizedRelativePosixPath(
  value: unknown,
  label: string,
  locationDescription: string,
): string {
  const relativePath = validateString(value, label);
  const normalizedPath = path.posix.normalize(relativePath);

  if (
    relativePath.length === 0 ||
    relativePath === '.' ||
    relativePath.includes('\\') ||
    isAbsolutePosixOrWindowsPath(relativePath) ||
    normalizedPath !== relativePath ||
    normalizedPath === '..' ||
    normalizedPath.startsWith('../')
  ) {
    throw new Error(
      `${label} must be a normalized relative POSIX path inside ${locationDescription}.`,
    );
  }

  return relativePath;
}
