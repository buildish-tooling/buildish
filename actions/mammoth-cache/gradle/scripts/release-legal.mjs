#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

/**
 * Generate and verify distribution-oriented legal files for the bundled GitHub
 * Action under dist/github/.
 *
 * The repository-root LICENSE / NOTICE describe the ASF project itself. The
 * generated files under legal/github/ describe which third-party npm packages
 * are bundled into the shipped action artifact and what attribution text must be
 * carried forward for that distribution.
 *
 * High-level flow:
 * 1. Build the action entrypoints with esbuild metafile output enabled.
 * 2. Treat the metafile inputs as the source of truth for which published npm
 *    packages actually ship in the GitHub Action bundle.
 * 3. Read package metadata plus any LICENSE / NOTICE files from node_modules/.
 * 4. Normalize upstream repository URLs so multiple npm packages from the same
 *    source project can be grouped into one distribution section.
 * 5. Append those grouped sections to the repository-root LICENSE / NOTICE and
 *    write the result under legal/github/.
 * 6. Fail closed when required legal metadata is missing or when a bundled
 *    dependency declares a Category X license under Apache policy.
 *
 * Supported modes:
 * --write             Regenerate legal/github/LICENSE and legal/github/NOTICE.
 * --check             Verify those generated files and report all legal blockers.
 * --check-category-x  Verify only that the current bundle contains no
 *                     Category X licenses. This narrower gate is intended for
 *                     regular CI so forbidden licenses cannot slip in even while
 *                     broader release-preparation issues are still being worked.
 */

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const projectRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(projectRoot, '..', '..', '..');
const distributionLegalDir = path.join(projectRoot, 'legal', 'github');
const distributionLicensePath = path.join(distributionLegalDir, 'LICENSE');
const distributionNoticePath = path.join(distributionLegalDir, 'NOTICE');
const rootLicensePath = path.join(repoRoot, 'LICENSE');
const rootNoticePath = path.join(repoRoot, 'NOTICE');
const packageLockPath = path.join(projectRoot, 'package-lock.json');

const ENTRY_POINTS = ['src/main.ts', 'src/post.ts'];
const SECTION_SEPARATOR =
  '--------------------------------------------------------------------------------';
const LICENSE_FILE_PATTERN = /^(license|licence|copying)([._-].*)?$/i;
const NOTICE_FILE_PATTERN = /^notice([._-].*)?$/i;
const MODES = Object.freeze({
  CHECK: 'check',
  CHECK_CATEGORY_X: 'check-category-x',
  WRITE: 'write',
});
const ISSUE_CODES = Object.freeze({
  CATEGORY_X_LICENSE: 'CATEGORY_X_LICENSE',
  MISSING_ATTRIBUTION_TEXT: 'MISSING_ATTRIBUTION_TEXT',
  MISSING_COPYRIGHT: 'MISSING_COPYRIGHT',
  MISSING_LICENSE_DECLARATION: 'MISSING_LICENSE_DECLARATION',
  MISSING_PROJECT_HOMEPAGE: 'MISSING_PROJECT_HOMEPAGE',
});

const SPDX_URLS = new Map([
  ['Apache-2.0', 'https://www.apache.org/licenses/LICENSE-2.0'],
  ['BlueOak-1.0.0', 'https://spdx.org/licenses/BlueOak-1.0.0.html'],
  ['BSD-2-Clause', 'https://spdx.org/licenses/BSD-2-Clause.html'],
  ['BSD-3-Clause', 'https://spdx.org/licenses/BSD-3-Clause.html'],
  ['ISC', 'https://spdx.org/licenses/ISC.html'],
  ['MIT', 'https://spdx.org/licenses/MIT.html'],
]);

const CATEGORY_X_RULES = [
  { pattern: /\bAGPL(?:[-+. ]|\b)/i, reason: 'AGPL is Category X under Apache release policy.' },
  { pattern: /\bLGPL(?:[-+. ]|\b)/i, reason: 'LGPL is Category X under Apache release policy.' },
  { pattern: /\bGPL(?:[-+. ]|\b)/i, reason: 'GPL is Category X under Apache release policy.' },
  { pattern: /Sleepycat/i, reason: 'Sleepycat is Category X under Apache release policy.' },
  { pattern: /CPOL/i, reason: 'CPOL is Category X under Apache release policy.' },
  { pattern: /JSON/i, reason: 'The JSON license is Category X under Apache release policy.' },
  { pattern: /QPL/i, reason: 'QPL is Category X under Apache release policy.' },
  { pattern: /SSPL/i, reason: 'SSPL is Category X under Apache release policy.' },
  {
    pattern: /Commons Clause/i,
    reason: 'Commons Clause is Category X under Apache release policy.',
  },
  {
    pattern: /Business Source/i,
    reason: 'Business Source License is Category X under Apache release policy.',
  },
  {
    pattern: /RSAL/i,
    reason: 'Redis Source Available License is Category X under Apache release policy.',
  },
  { pattern: /BSD-4-Clause/i, reason: 'BSD-4-Clause is Category X under Apache release policy.' },
  { pattern: /APSL-2\.0/i, reason: 'APSL 2.0 is Category X under Apache release policy.' },
  { pattern: /NPL/i, reason: 'NPL is Category X under Apache release policy.' },
];

// Older published npm tarballs occasionally omit enough legal metadata that the
// release inventory would otherwise become non-deterministic. Keep the manual
// overrides explicit, minimal, and tied to the exact package names that need
// preserved attribution text.
const PACKAGE_OVERRIDES = {
  binary: {
    copyright: 'Copyright (c) 2010 James Halliday (mail@substack.net)',
    attributionText: createMitLicenseText('Copyright (c) 2010 James Halliday (mail@substack.net)'),
  },
  buffers: {
    copyright: 'Copyright (c) 2010 James Halliday (mail@substack.net)',
    licenseExpression: 'MIT/X11',
    specialHandlingText: [
      'This package is licensed under the MIT/X11 license, as indicated by the',
      'commit of the original author here (on a fork)',
      'https://github.com/bitpay/node-buffers/commit/1b745ee35d33eb166e15ef1866073a07c6d7de87.',
      'The original source repository https://github.com/substack/node-buffers no',
      'longer exists, the dependency has been published to npmjs 14 years ago and',
      'is since then unmaintained.',
    ].join('\n'),
    attributionText: createMitLicenseText('Copyright (c) 2010 James Halliday (mail@substack.net)'),
  },
  chainsaw: {
    copyright: 'Copyright (c) 2010 James Halliday (mail@substack.net)',
    attributionText: createMitLicenseText('Copyright (c) 2010 James Halliday (mail@substack.net)'),
  },
  isarray: {
    copyright: 'Copyright (c) 2013 Julian Gruber <julian@juliangruber.com>',
    attributionText: [
      'MIT License',
      '',
      'Copyright (c) 2013 Julian Gruber <julian@juliangruber.com>',
      '',
      'Permission is hereby granted, free of charge, to any person obtaining a copy',
      'of this software and associated documentation files (the "Software"), to deal',
      'in the Software without restriction, including without limitation the rights',
      'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
      'copies of the Software, and to permit persons to whom the Software is',
      'furnished to do so, subject to the following conditions:',
      '',
      'The above copyright notice and this permission notice shall be included in all',
      'copies or substantial portions of the Software.',
      '',
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
      'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
      'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
      'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
      'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
      'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
      'SOFTWARE.',
    ].join('\n'),
  },
};

function createMitLicenseText(copyrightLine) {
  return [
    'MIT License',
    '',
    copyrightLine,
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of this software and associated documentation files (the "Software"), to deal',
    'in the Software without restriction, including without limitation the rights',
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    'copies of the Software, and to permit persons to whom the Software is',
    'furnished to do so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all',
    'copies or substantial portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
    'SOFTWARE.',
  ].join('\n');
}

/** Normalize repository/homepage metadata so bundled packages can be grouped by source project. */
export function normalizeProjectUrl(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  let normalized = value.trim();
  if (!normalized) {
    return '';
  }
  normalized = normalized.replace(/^git\+/, '');
  normalized = normalized.replace(/^http:\/\/github\.com\//i, 'https://github.com/');
  normalized = normalized.replace(/^git:\/\/github\.com\//i, 'https://github.com/');
  normalized = normalized.replace(/^github:/i, 'https://github.com/');
  normalized = normalized.replace(/^git@github\.com:/i, 'https://github.com/');
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    normalized = `https://github.com/${normalized}`;
  }
  normalized = normalized.replace(/#.*$/, '');
  normalized = normalized.replace(/\.git$/i, '');
  normalized = normalized.replace(/\/readme$/i, '');
  normalized = normalized.replace(/#readme$/i, '');
  normalized = normalized.replace(/\/$/, '');
  return normalized;
}

function chooseProjectHomePage(packageJson) {
  const homepage = normalizeProjectUrl(packageJson.homepage ?? '');
  const repository = normalizeProjectUrl(
    typeof packageJson.repository === 'string'
      ? packageJson.repository
      : (packageJson.repository?.url ?? ''),
  );
  if (repository) {
    return repository;
  }
  if (homepage && !homepage.startsWith('https://www.npmjs.com/')) {
    return homepage;
  }
  return repository || homepage;
}

function normalizeAuthor(author) {
  if (!author) {
    return '';
  }
  if (typeof author === 'string') {
    return author.trim();
  }
  if (typeof author === 'object' && typeof author.name === 'string') {
    const details = [author.name.trim()];
    if (typeof author.email === 'string' && author.email.trim()) {
      details.push(`<${author.email.trim()}>`);
    }
    if (typeof author.url === 'string' && author.url.trim()) {
      details.push(`(${author.url.trim()})`);
    }
    return details.join(' ');
  }
  return '';
}

function normalizeLicenseExpression(packageJson) {
  if (typeof packageJson.license === 'string' && packageJson.license.trim()) {
    return packageJson.license.trim();
  }
  if (Array.isArray(packageJson.licenses) && packageJson.licenses.length > 0) {
    const values = packageJson.licenses
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry.trim();
        }
        if (entry && typeof entry.type === 'string') {
          return entry.type.trim();
        }
        return '';
      })
      .filter(Boolean);
    if (values.length > 0) {
      return values.join(' OR ');
    }
  }
  return '';
}

/** Return a human-readable Category X explanation for the given license expression, if any. */
export function detectCategoryXReason(licenseExpression) {
  if (!licenseExpression) {
    return '';
  }
  const match = CATEGORY_X_RULES.find((rule) => rule.pattern.test(licenseExpression));
  return match?.reason ?? '';
}

function licenseRequiresAttributionText(licenseExpression) {
  return /MIT|BSD|ISC|BlueOak/i.test(licenseExpression);
}

export function renderLicenseReference(licenseExpression) {
  if (!licenseExpression) {
    return 'not declared in published npm metadata';
  }
  const url = SPDX_URLS.get(licenseExpression);
  return url ? `${licenseExpression} - ${url}` : licenseExpression;
}

function trimDocumentText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function ensureTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function renderPipedBlock(text) {
  return trimDocumentText(text)
    .split('\n')
    .map((line) => (line ? `| ${line}` : '|'))
    .join('\n');
}

/** Append generated bundled-dependency sections after the ASF project boilerplate. */
export function appendBundledSections(baseText, sections) {
  const trimmedBase = baseText.replace(/\r\n/g, '\n').trimEnd();
  if (sections.length === 0) {
    return ensureTrailingNewline(trimmedBase);
  }
  return ensureTrailingNewline(
    `${trimmedBase}\n\n${SECTION_SEPARATOR}\n\n${sections.join(`\n\n${SECTION_SEPARATOR}\n\n`)}`,
  );
}

function summarizeCopyright(licenseText, packageJson, packageOverride) {
  if (packageOverride?.copyright) {
    return packageOverride.copyright;
  }
  const explicitLines = extractCopyrightLines(licenseText);
  if (explicitLines.length > 0) {
    return [...new Set(explicitLines)].join('; ');
  }
  const author = normalizeAuthor(packageJson.author);
  if (author) {
    return `Copyright (c) ${author}`;
  }
  return '';
}

function extractCopyrightLines(text) {
  return trimDocumentText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const matchIndex = line.toLowerCase().indexOf('copyright');
      if (matchIndex < 0 || matchIndex > 24) {
        return false;
      }
      return ![
        /copyright notice/i,
        /copyright holder/i,
        /copyright in it\./i,
        /copyright owner/i,
        /grant of copyright/i,
        /copyright license/i,
        /copyright statement/i,
        /^##\s*copyright$/i,
      ].some((pattern) => pattern.test(line));
    });
}

async function findMatchingFiles(packageDir, pattern) {
  const entries = await fs.readdir(packageDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function preferredLicenseText(packageName, licenseExpression, licenseTexts, copyrightLine) {
  const packageOverride = PACKAGE_OVERRIDES[packageName];
  if (packageOverride?.attributionText) {
    return trimDocumentText(packageOverride.attributionText);
  }
  if (licenseRequiresAttributionText(licenseExpression) && licenseTexts.length > 0) {
    return trimDocumentText(licenseTexts[0]);
  }
  if (/^(MIT|MIT\/X11)$/i.test(licenseExpression) && copyrightLine) {
    return trimDocumentText(createMitLicenseText(copyrightLine));
  }
  return '';
}

function buildIssue(code, packageId, detail) {
  return { code, packageId, detail };
}

function filterIssuesByCode(issues, expectedCodes) {
  const codeSet = new Set(expectedCodes);
  return issues.filter((issue) => codeSet.has(issue.code));
}

function categoryXIssues(issues) {
  return filterIssuesByCode(issues, [ISSUE_CODES.CATEGORY_X_LICENSE]);
}

function renderSourceProjectIntro(group) {
  return `This product bundles packages from the source project at ${group.projectHomePage}.`;
}

export function renderLicenseSection(group) {
  const lines = [renderSourceProjectIntro(group), '', '* npm package IDs:'];
  for (const packageId of group.packageIds) {
    lines.push(`  * ${packageId}`);
  }
  lines.push(
    '',
    `Copyright: ${group.copyright}`,
    `Home page: ${group.projectHomePage}`,
    `License: ${group.licenseReference}`,
  );
  if (group.specialHandlingText) {
    lines.push('', 'Special handling:', renderPipedBlock(group.specialHandlingText));
  }
  if (group.attributionText) {
    lines.push(renderPipedBlock(group.attributionText));
  }
  return lines.join('\n');
}

export function renderNoticeSection(group) {
  const lines = [
    `${renderSourceProjectIntro(group)} with the following in its NOTICE file:`,
    '|',
    '| npm package IDs:',
  ];
  for (const packageId of group.packageIds) {
    lines.push(`|   * ${packageId}`);
  }
  lines.push('|', renderPipedBlock(group.noticeText));
  return lines.join('\n');
}

function createLicenseGroupKey(packageInfo) {
  return [
    packageInfo.projectHomePage,
    packageInfo.licenseExpression || 'UNRESOLVED',
    packageInfo.specialHandlingText,
    packageInfo.attributionText,
  ].join('\u0001');
}

function createNoticeGroupKey(packageInfo, noticeText) {
  return [packageInfo.projectHomePage, noticeText].join('\u0001');
}

async function collectBundledPackageRoots() {
  // The esbuild metafile is the authoritative answer to "what ships in the
  // action bundle". We intentionally do not scan package-lock.json alone,
  // because many installed packages never make it into dist/github/.
  const packageLock = JSON.parse(await fs.readFile(packageLockPath, 'utf8'));
  const candidateRoots = Object.keys(packageLock.packages)
    .filter((packagePath) => packagePath.startsWith('node_modules/'))
    .sort((left, right) => right.length - left.length);
  const result = await build({
    absWorkingDir: projectRoot,
    bundle: true,
    entryPoints: ENTRY_POINTS,
    format: 'cjs',
    logLevel: 'silent',
    metafile: true,
    outdir: path.join(projectRoot, 'build', 'release-legal-audit'),
    platform: 'node',
    target: 'node24',
    write: false,
  });

  const packageRoots = new Set();
  for (const inputPath of Object.keys(result.metafile.inputs)) {
    const normalizedInputPath = inputPath.replace(/\\/g, '/');
    const packageRoot = candidateRoots.find(
      (candidateRoot) =>
        normalizedInputPath === candidateRoot ||
        normalizedInputPath.startsWith(`${candidateRoot}/`),
    );
    if (packageRoot) {
      packageRoots.add(packageRoot);
    }
  }
  return [...packageRoots].sort((left, right) => left.localeCompare(right));
}

export async function collectPackageInfo(packageRoot) {
  // Collect per-package facts first, then let analyzeDistribution() decide how
  // to group those facts into source-project-oriented LICENSE / NOTICE blocks.
  const packageDir = path.join(projectRoot, packageRoot);
  const packageJson = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
  const packageId = `${packageJson.name}@${packageJson.version}`;
  const packageOverride = PACKAGE_OVERRIDES[packageJson.name] ?? null;
  const licenseExpression =
    packageOverride?.licenseExpression ?? normalizeLicenseExpression(packageJson);
  const projectHomePage = chooseProjectHomePage(packageJson);
  const licenseFileNames = await findMatchingFiles(packageDir, LICENSE_FILE_PATTERN);
  const noticeFileNames = await findMatchingFiles(packageDir, NOTICE_FILE_PATTERN);
  const licenseTexts = await Promise.all(
    licenseFileNames.map((fileName) => fs.readFile(path.join(packageDir, fileName), 'utf8')),
  );
  const noticeTexts = await Promise.all(
    noticeFileNames.map((fileName) => fs.readFile(path.join(packageDir, fileName), 'utf8')),
  );
  const copyright = summarizeCopyright(licenseTexts[0] ?? '', packageJson, packageOverride);
  const attributionText = preferredLicenseText(
    packageJson.name,
    licenseExpression,
    licenseTexts,
    copyright,
  );
  const specialHandlingText = packageOverride?.specialHandlingText
    ? trimDocumentText(packageOverride.specialHandlingText)
    : '';

  const issues = [];
  if (!licenseExpression) {
    issues.push(
      buildIssue(
        ISSUE_CODES.MISSING_LICENSE_DECLARATION,
        packageId,
        'Published npm metadata does not declare a license.',
      ),
    );
  }
  const categoryXReason = detectCategoryXReason(licenseExpression);
  if (categoryXReason) {
    issues.push(
      buildIssue(
        ISSUE_CODES.CATEGORY_X_LICENSE,
        packageId,
        `${categoryXReason} Found ${licenseExpression}.`,
      ),
    );
  }
  if (!projectHomePage) {
    issues.push(
      buildIssue(
        ISSUE_CODES.MISSING_PROJECT_HOMEPAGE,
        packageId,
        'Could not determine a project home page from homepage/repository metadata.',
      ),
    );
  }
  if (!copyright) {
    issues.push(
      buildIssue(
        ISSUE_CODES.MISSING_COPYRIGHT,
        packageId,
        'Could not derive copyright text from license text or author metadata.',
      ),
    );
  }
  if (licenseRequiresAttributionText(licenseExpression) && !attributionText) {
    issues.push(
      buildIssue(
        ISSUE_CODES.MISSING_ATTRIBUTION_TEXT,
        packageId,
        `License ${licenseExpression} requires preserved attribution text, but none was found.`,
      ),
    );
  }

  return {
    attributionText,
    copyright,
    issues,
    licenseExpression,
    licenseReference: renderLicenseReference(licenseExpression),
    noticeTexts: noticeTexts.map(trimDocumentText).filter(Boolean),
    packageId,
    projectHomePage,
    specialHandlingText,
  };
}

async function analyzeDistribution() {
  // Group by upstream project rather than by package name so the generated
  // output talks about the original source project in ASF distribution style.
  const packageRoots = await collectBundledPackageRoots();
  const packageInfos = await Promise.all(
    packageRoots.map((packageRoot) => collectPackageInfo(packageRoot)),
  );
  const licenseGroups = new Map();
  const noticeGroups = new Map();
  const issues = [];

  for (const packageInfo of packageInfos) {
    issues.push(...packageInfo.issues);

    const licenseGroupKey = createLicenseGroupKey(packageInfo);
    if (!licenseGroups.has(licenseGroupKey)) {
      licenseGroups.set(licenseGroupKey, {
        attributionText: packageInfo.attributionText,
        copyright: new Set(),
        licenseReference: packageInfo.licenseReference,
        packageIds: new Set(),
        projectHomePage: packageInfo.projectHomePage,
        specialHandlingText: packageInfo.specialHandlingText,
      });
    }
    const licenseGroup = licenseGroups.get(licenseGroupKey);
    licenseGroup.packageIds.add(packageInfo.packageId);
    if (packageInfo.copyright) {
      licenseGroup.copyright.add(packageInfo.copyright);
    }

    for (const noticeText of packageInfo.noticeTexts) {
      const noticeGroupKey = createNoticeGroupKey(packageInfo, noticeText);
      if (!noticeGroups.has(noticeGroupKey)) {
        noticeGroups.set(noticeGroupKey, {
          noticeText,
          packageIds: new Set(),
          projectHomePage: packageInfo.projectHomePage,
        });
      }
      noticeGroups.get(noticeGroupKey).packageIds.add(packageInfo.packageId);
    }
  }

  const sortedLicenseGroups = [...licenseGroups.values()]
    .map((group) => ({
      attributionText: group.attributionText,
      copyright: [...group.copyright].sort((left, right) => left.localeCompare(right)).join('; '),
      licenseReference: group.licenseReference,
      packageIds: [...group.packageIds].sort((left, right) => left.localeCompare(right)),
      projectHomePage: group.projectHomePage,
      specialHandlingText: group.specialHandlingText,
    }))
    .sort((left, right) => {
      const leftKey = `${left.projectHomePage}\u0001${left.packageIds[0]}`;
      const rightKey = `${right.projectHomePage}\u0001${right.packageIds[0]}`;
      return leftKey.localeCompare(rightKey);
    });

  const sortedNoticeGroups = [...noticeGroups.values()]
    .map((group) => ({
      noticeText: group.noticeText,
      packageIds: [...group.packageIds].sort((left, right) => left.localeCompare(right)),
      projectHomePage: group.projectHomePage,
    }))
    .sort((left, right) => {
      const leftKey = `${left.projectHomePage}\u0001${left.packageIds[0]}`;
      const rightKey = `${right.projectHomePage}\u0001${right.packageIds[0]}`;
      return leftKey.localeCompare(rightKey);
    });

  return { issues, licenseGroups: sortedLicenseGroups, noticeGroups: sortedNoticeGroups };
}

function renderIssueList(issues) {
  return issues.map((issue) => `- ${issue.packageId}: ${issue.detail}`).join('\n');
}

async function writeDistributionFiles(licenseText, noticeText) {
  await fs.mkdir(distributionLegalDir, { recursive: true });
  await Promise.all([
    fs.writeFile(distributionLicensePath, licenseText, 'utf8'),
    fs.writeFile(distributionNoticePath, noticeText, 'utf8'),
  ]);
}

async function checkDistributionFiles(expectedFiles) {
  // Compare exact bytes so stale generated files are detected deterministically.
  const mismatches = [];
  for (const expectedFile of expectedFiles) {
    let actualText;
    try {
      actualText = await fs.readFile(expectedFile.path, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        mismatches.push(
          `${expectedFile.kind} is missing at ${path.relative(projectRoot, expectedFile.path)}.`,
        );
        continue;
      }
      throw error;
    }
    if (actualText !== expectedFile.expectedText) {
      mismatches.push(`${expectedFile.kind} does not match the bundled dependency analysis.`);
    }
  }
  return mismatches;
}

/** Parse the CLI mode and reject ambiguous invocations early. */
export function parseMode(argv) {
  const selectedModes = [
    argv.includes('--check') ? MODES.CHECK : null,
    argv.includes('--check-category-x') ? MODES.CHECK_CATEGORY_X : null,
    argv.includes('--write') ? MODES.WRITE : null,
  ].filter(Boolean);
  if (selectedModes.length !== 1) {
    throw new Error('Pass exactly one of --check, --check-category-x, or --write.');
  }
  return selectedModes[0];
}

// --check-category-x is intentionally handled before any LICENSE / NOTICE file
// reads because it is a pure policy gate for CI; it only needs the bundle
// analysis and the filtered Category X issue set.
async function main(argv = process.argv.slice(2)) {
  const mode = parseMode(argv);
  const analysis = await analyzeDistribution();
  const blockingIssues =
    mode === MODES.CHECK_CATEGORY_X ? categoryXIssues(analysis.issues) : analysis.issues;

  if (mode === MODES.CHECK_CATEGORY_X) {
    if (blockingIssues.length > 0) {
      console.error('release-legal Category X check failed:');
      console.error(renderIssueList(blockingIssues));
      process.exitCode = 1;
      return;
    }
    console.log('release-legal verified: no bundled Category X licenses detected.');
    return;
  }

  const [rootLicenseText, rootNoticeText] = await Promise.all([
    fs.readFile(rootLicensePath, 'utf8'),
    fs.readFile(rootNoticePath, 'utf8'),
  ]);

  const distributionLicenseText = appendBundledSections(
    rootLicenseText,
    analysis.licenseGroups.map((group) => renderLicenseSection(group)),
  );
  const distributionNoticeText = appendBundledSections(
    rootNoticeText,
    analysis.noticeGroups.map((group) => renderNoticeSection(group)),
  );

  if (mode === MODES.WRITE) {
    await writeDistributionFiles(distributionLicenseText, distributionNoticeText);
    console.log(`Updated ${path.relative(projectRoot, distributionLicensePath)}`);
    console.log(`Updated ${path.relative(projectRoot, distributionNoticePath)}`);
  }

  const mismatches =
    mode === MODES.CHECK
      ? await checkDistributionFiles([
          { expectedText: distributionLicenseText, kind: 'LICENSE', path: distributionLicensePath },
          { expectedText: distributionNoticeText, kind: 'NOTICE', path: distributionNoticePath },
        ])
      : [];

  if (mismatches.length > 0) {
    console.error('release-legal check failed:');
    console.error(mismatches.map((mismatch) => `- ${mismatch}`).join('\n'));
  }
  if (blockingIssues.length > 0) {
    console.error('release-legal audit found blockers:');
    console.error(renderIssueList(blockingIssues));
  }
  if (mismatches.length > 0 || blockingIssues.length > 0) {
    process.exitCode = 1;
    return;
  }

  const verb = mode === MODES.WRITE ? 'updated' : 'verified';
  const fileList = [distributionLicensePath, distributionNoticePath]
    .map((targetPath) => path.relative(projectRoot, targetPath))
    .join(', ');
  console.log(`release-legal ${verb}: ${fileList}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main();
}
