<!--
Copyright 2026 The Buildish Authors

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

# Buildish

Buildish is a family of independent tools for build engineers, CI maintainers,
and project contributors. The components address practical build and release
work such as sharing Gradle and Maven caches, running the Gradle Wrapper without
checking its JAR into source control, assembling documentation from multiple
repositories, and preparing releases.

This aggregate repository owns the project-wide community and legal files, the
component catalog, the Buildish Website renderer, and the integration that
publishes [buildish.org](https://buildish.org/). Component implementations live
in their own repositories.

> **Project status:** Buildish has not published a release. Documentation under
> a component's `development/` route describes unreleased behavior, and APIs,
> configuration, and workflows may change.

## Components

- [Mammoth Cache](https://buildish.org/components/mammoth-cache/) — reusable
  GitHub Actions caching for Gradle and Maven builds.
- [No Gradle Wrapper JAR](https://buildish.org/components/no-gradle-wrapper-jar/)
  — run the Gradle Wrapper without storing `gradle-wrapper.jar` in the project.
- [Site Pipeline](https://buildish.org/components/site-pipeline/) — validate and
  assemble documentation from multiple repositories into a renderer-neutral
  staged site.
- [Release Tooling](https://buildish.org/components/release-tooling/) — model
  and automate release preparation, verification, and publication workflows.
- [Website](https://buildish.org/components/site/) — render the staged Buildish
  documentation with Hugo and Docsy.

## Development quick start

The site catalog expects the five repositories to be sibling directories:

```text
workspace/
├── buildish/
├── buildish-mammoth-cache/
├── buildish-no-gradle-wrapper-jar/
├── buildish-release-tooling/
└── buildish-site-pipeline/
```

From `buildish/`, run the repository gate:

```shell
make check
```

The host-tool workflow uses `uv`, Hugo Extended, and the Node version selected
by `site/.nvmrc`. To preview the assembled site locally, run:

```shell
make serve-local
```

See the [unreleased Website development documentation](site/site/docs/_index.md)
for containerized and advanced workflows. Buildish is a tool family, not a
replacement for Gradle, Maven, GitHub Actions, or other build systems.

## Community

- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security](SECURITY.md)
- [Release process status](BUILDISH-RELEASE-PROCESS.md)

## License

Buildish is licensed under the Apache License, Version 2.0.

See [`LICENSE`](LICENSE), [`NOTICE`](NOTICE), and the
[artwork provenance record](ARTWORK.md).
