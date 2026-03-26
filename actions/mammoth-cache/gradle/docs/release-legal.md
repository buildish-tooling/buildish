<!--
Copyright 2026 The Apache Software Foundation

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# GitHub action distribution legal files

This directory holds the legal files for the bundled GitHub Action distribution under `dist/github/`.

The generated distribution files are:

- `legal/github/LICENSE`
- `legal/github/NOTICE`

They are **not** the same as the repository-root `LICENSE` and `NOTICE`, which remain the ASF project legal files.

## Commands

- `npm run release-legal:write` — regenerate `legal/github/LICENSE` and `legal/github/NOTICE`
- `npm run release-legal:check` — verify the generated files and run the full release-preparation legal audit
- `npm run release-legal:check-category-x` — fail if the current bundled action dependency set contains a Category X license
- `make release-legal-check`
- `make release-legal-category-x-check`

`npm run verify`, `make check`, and the regular GitHub CI `check` job now include the Category X gate.

## Generation model

`scripts/release-legal.mjs` builds the action entrypoints with esbuild metadata enabled and inspects the actual bundled npm package inputs.

The script then:

1. starts from the repository-root `LICENSE` / `NOTICE`
2. appends bundled third-party sections in ASF-style distribution format
3. writes the results into `legal/github/`

If there is nothing to append to a generated file, the output is just the repository-root file content.

## Formatting rules

- Use **"bundles"** for dependencies that are only packaged into the action bundle.
- Do **not** say **"includes code"** unless source code is actually copied into this project.
- Group dependencies by source project when they share the same upstream repository / home page.
- Every bundled section must list:
  - npm package IDs (`name@version`)
  - copyright text
  - project home page
  - license link or SPDX-style identifier
- Licenses with attribution requirements (for example MIT, BSD, ISC) must include the preserved attribution/license text.

## NOTICE handling

`legal/github/NOTICE` only grows when a bundled dependency ships NOTICE content that must be propagated.

If no bundled dependency contributes NOTICE text, `legal/github/NOTICE` is identical to the repository-root `NOTICE`.

## Policy checks

The full release audit fails closed for:

- Category X licenses under Apache release policy
- missing license declarations in bundled npm metadata
- missing attribution text where the bundled license requires it
- missing project home page or copyright metadata

The narrower Category X gate checks only the first item above. It exists so regular CI can reject forbidden licenses immediately without waiting for the broader release-preparation audit to be green.

## Current known blockers

- `openpgp@6.3.0` (`LGPL-3.0+`, Category X)

Because `openpgp@6.3.0` is currently bundled, the regular Category X CI gate is expected to fail until that dependency is removed or replaced.

`buffers@0.1.1` is handled explicitly in `scripts/release-legal.mjs` because the published npm tarball omits its license declaration even though upstream provenance indicates `MIT/X11`.
