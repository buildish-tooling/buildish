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

# Apache Buildish Site Pipeline

This repository packages the reusable multi-repository site staging pipeline that
Apache Buildish uses to assemble component documentation, metadata, and preview
outputs before handing the staged tree to the site renderer.

## Included here

- the `apache_buildish_site_pipeline` Python package
- the `site-pipeline` CLI entrypoint
- reusable contract docs under `docs/`
- a small self-contained generic test suite

## Local development

Run the extracted repo checks with:

- `make check`

Buildish can consume this repo locally through a path dependency while the
repository still lives inside the main Buildish checkout.

