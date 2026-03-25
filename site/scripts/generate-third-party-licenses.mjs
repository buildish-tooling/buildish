/*
 * Copyright 2026 The Buildish Authors
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

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const DISTRIBUTED_NODE_ROOTS = [
  '@fortawesome/fontawesome-free',
  'bootstrap',
  'jquery',
  'lunr',
  'mermaid',
];
const REVIEWED_DOCSY_MODULE = 'github.com/google/docsy/theme';
const REVIEWED_DOCSY_VERSION = 'v0.16.0';

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(
        'Usage: generate-third-party-licenses.mjs ' +
          '--node-modules <dir> --go-mod <file> --project-license <file> --output <file>',
      );
    }
    result[name.slice(2)] = value;
  }
  for (const required of ['node-modules', 'go-mod', 'project-license', 'output']) {
    if (!result[required]) {
      throw new Error(`Missing required argument --${required}`);
    }
  }
  return result;
}

function resolvePackage(packageName, fromDirectory) {
  const requireFromPackage = createRequire(path.join(fromDirectory, 'package-resolution.cjs'));
  const searchPaths = requireFromPackage.resolve.paths(packageName) ?? [];
  for (const searchPath of searchPaths) {
    const packageJson = path.join(searchPath, ...packageName.split('/'), 'package.json');
    if (!fs.existsSync(packageJson)) {
      continue;
    }
    return {
      directory: path.dirname(packageJson),
      metadata: JSON.parse(fs.readFileSync(packageJson, 'utf8')),
    };
  }
  throw new Error(`Could not resolve package ${packageName} from ${fromDirectory}`);
}

function readLegalFiles(packageDirectory) {
  const candidates = fs
    .readdirSync(packageDirectory)
    .filter((name) => /^(licen[cs]e|copying|notice)(\..*)?$/iu.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (candidates.length === 0) {
    throw new Error(`No license or notice file found in ${packageDirectory}`);
  }
  return candidates
    .map((name) => {
      const contents = fs.readFileSync(path.join(packageDirectory, name), 'utf8').trimEnd();
      return `File: ${name}\n\n${contents}`;
    })
    .join('\n\n');
}

function collectNodePackages(nodeModulesDirectory) {
  const pending = DISTRIBUTED_NODE_ROOTS.map((name) => ({
    name,
    fromDirectory: path.dirname(nodeModulesDirectory),
  }));
  const collected = new Map();

  while (pending.length > 0) {
    const { name, fromDirectory } = pending.pop();
    const resolved = resolvePackage(name, fromDirectory);
    const key = `${resolved.metadata.name}@${resolved.metadata.version}`;
    if (collected.has(key)) {
      continue;
    }

    collected.set(key, {
      name: resolved.metadata.name,
      version: resolved.metadata.version,
      declaredLicense: resolved.metadata.license ?? 'not declared',
      licenseText: readLegalFiles(resolved.directory),
    });

    const dependencies = {
      ...(resolved.metadata.dependencies ?? {}),
      ...(resolved.metadata.optionalDependencies ?? {}),
    };
    for (const dependencyName of Object.keys(dependencies)) {
      pending.push({ name: dependencyName, fromDirectory: resolved.directory });
    }
  }

  return [...collected.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
}

function readDocsyVersion(goModPath) {
  const goMod = fs.readFileSync(goModPath, 'utf8');
  const match = goMod.match(
    /^\s*(github\.com\/google\/docsy(?:\/theme)?)\s+(v\S+)(?:\s+\/\/.*)?$/mu,
  );
  if (!match) {
    throw new Error(`Could not find the Docsy module version in ${goModPath}`);
  }
  const docsyModule = { moduleName: match[1], version: match[2] };
  if (
    docsyModule.moduleName !== REVIEWED_DOCSY_MODULE ||
    docsyModule.version !== REVIEWED_DOCSY_VERSION
  ) {
    throw new Error(
      `Docsy changed from reviewed dependency ${REVIEWED_DOCSY_MODULE}@${REVIEWED_DOCSY_VERSION} ` +
        `to ${docsyModule.moduleName}@${docsyModule.version}; review its license before updating ` +
        'the generated site inventory.',
    );
  }
  return docsyModule;
}

function renderInventory(nodePackages, docsyModule, apacheLicenseText) {
  const sections = [
    'Buildish website third-party licenses',
    '========================================',
    '',
    'This file is generated from the dependencies used by the rendered site.',
    'Build tools that are not distributed in the site are not listed.',
    '',
  ];

  for (const dependency of nodePackages) {
    const heading = `${dependency.name}@${dependency.version}`;
    sections.push(
      heading,
      '-'.repeat(heading.length),
      `Declared license: ${dependency.declaredLicense}`,
      '',
      dependency.licenseText,
      '',
    );
  }

  const docsyHeading = `${docsyModule.moduleName}@${docsyModule.version}`;
  sections.push(
    docsyHeading,
    '-'.repeat(docsyHeading.length),
    'Declared license: Apache-2.0',
    '',
    apacheLicenseText.trimEnd(),
    '',
  );
  return `${sections.join('\n')}\n`;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const outputPath = path.resolve(args.output);
  const inventory = renderInventory(
    collectNodePackages(path.resolve(args['node-modules'])),
    readDocsyVersion(path.resolve(args['go-mod'])),
    fs.readFileSync(path.resolve(args['project-license']), 'utf8'),
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, inventory, 'utf8');
  process.stdout.write(`Wrote ${outputPath}\n`);
}

main();
