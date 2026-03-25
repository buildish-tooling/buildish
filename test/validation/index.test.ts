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

import { describe, expect, it } from 'vitest';

import {
  parseSerializedJsonObject,
  validateLowercaseSha256,
  validateNormalizedRelativePosixPath,
} from '../../src/validation';

describe('validation helpers', () => {
  it('parses serialized JSON objects and rejects non-object payloads', () => {
    expect(parseSerializedJsonObject('{"ok":true}', 'fixture')).toEqual({ ok: true });
    expect(() => parseSerializedJsonObject('[1,2,3]', 'fixture')).toThrow(/JSON object/u);
  });

  it('validates lowercase SHA-256 digests', () => {
    expect(validateLowercaseSha256('a'.repeat(64), 'digest')).toBe('a'.repeat(64));
    expect(() => validateLowercaseSha256('A'.repeat(64), 'digest')).toThrow(/SHA-256/u);
  });

  it('validates normalized relative POSIX paths for caller-defined roots', () => {
    expect(validateNormalizedRelativePosixPath('payload/000001.bin', 'path', 'the package')).toBe(
      'payload/000001.bin',
    );
    expect(() => validateNormalizedRelativePosixPath('../escape', 'path', 'the package')).toThrow(
      /normalized relative POSIX path inside the package/u,
    );
  });
});
