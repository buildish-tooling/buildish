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

import { describe, expect, it } from 'vitest';

import {
  appendBundledSections,
  collectPackageInfo,
  detectCategoryXReason,
  normalizeProjectUrl,
  parseMode,
  renderLicenseReference,
  renderLicenseSection,
} from '../scripts/release-legal.mjs';

describe('release-legal helpers', () => {
  it('normalizes git and github repository URLs', () => {
    expect(normalizeProjectUrl('git+https://github.com/actions/toolkit.git')).toBe(
      'https://github.com/actions/toolkit',
    );
    expect(normalizeProjectUrl('github:octokit/core.js')).toBe(
      'https://github.com/octokit/core.js',
    );
  });

  it('detects Category X license expressions', () => {
    expect(detectCategoryXReason('LGPL-3.0+')).toContain('Category X');
    expect(detectCategoryXReason('MIT')).toBe('');
  });

  it('parses the supported CLI modes', () => {
    expect(parseMode(['--check'])).toBe('check');
    expect(parseMode(['--check-category-x'])).toBe('check-category-x');
    expect(parseMode(['--write'])).toBe('write');
    expect(() => parseMode(['--check', '--write'])).toThrow(
      'Pass exactly one of --check, --check-category-x, or --write.',
    );
  });

  it('preserves the base document when nothing must be appended', () => {
    expect(appendBundledSections('Base text\n', [])).toBe('Base text\n');
  });

  it('renders SPDX-backed license references', () => {
    expect(renderLicenseReference('MIT')).toBe('MIT - https://spdx.org/licenses/MIT.html');
    expect(renderLicenseReference('MIT/X11')).toBe('MIT/X11');
  });

  it('renders ASF-style bundled sections', () => {
    const section = renderLicenseSection({
      attributionText: 'MIT License\n\nCopyright (c) 2020 Example Corp.',
      copyright: 'Copyright (c) 2020 Example Corp.',
      licenseReference: 'MIT - https://spdx.org/licenses/MIT.html',
      packageIds: ['example-a@1.0.0', 'example-b@1.0.0'],
      projectHomePage: 'https://github.com/example/project',
      specialHandlingText: 'Recovered from upstream provenance evidence.',
    });

    expect(section).toContain(
      'This product bundles packages from the source project at https://github.com/example/project.',
    );
    expect(section).toContain('* npm package IDs:');
    expect(section).toContain('Special handling:');
    expect(section).toContain('| Recovered from upstream provenance evidence.');
    expect(section).toContain('| MIT License');
  });

  it('applies the buffers special-case license override', async () => {
    const packageInfo = await collectPackageInfo('node_modules/buffers');

    expect(packageInfo.licenseExpression).toBe('MIT/X11');
    expect(packageInfo.licenseReference).toBe('MIT/X11');
    expect(packageInfo.specialHandlingText).toContain(
      'This package is licensed under the MIT/X11 license, as indicated by the',
    );
    expect(packageInfo.attributionText).toContain('MIT License');
    expect(packageInfo.issues.map((issue) => issue.code)).not.toContain(
      'MISSING_LICENSE_DECLARATION',
    );
  });
});
