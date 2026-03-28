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

# Apache Buildish (Incubating)

Apache Buildish develops build automation, CI integrations, and supporting tooling.

## Available actions

- [Apache Buildish Mammoth Cache for Gradle](actions/mammoth-cache/gradle/README.md) — secure Gradle wrapper
  provisioning plus local and distributed cache management.

Use it in GitHub workflows as:

- `uses: apache/buildish/actions/mammoth-cache/gradle@<ref>`

## Repository layout

- `actions/mammoth-cache/gradle/` — Mammoth Cache for Gradle, the first action in the Mammoth Cache family
- `site/` — Hugo/Docsy site sources and staged-site tooling
- `tools/site-build-image/` — reusable container image definition for site build/test workflows
- `tools/buildish-no-gradle-wrapper-jar/` — Buildish no-gradle-wrapper-jar helper tool

> [!ALERT] This repository is a work-in-progress and is not yet ready for use.
> 
> We should use multiple GitHub repositories for the different actions and likely (most) plugins.
> Especially GitHub/Codeberg/GitLab CI "actions" heavily rely on Git tags. Having different release
> cadences for "all the actions" and "all the plugins" seems natural, but "telling" users of plugin "A"
> that a new version exists just because GitHub action "B" did a release seems wrong. The only way to
> avoid that seems to be to have separate repositories for each action/plugin.
> 
> This has a big impact on how we design/build the infrastructure for the web site, documentation, etc.

## License

Apache Buildish is licensed under Apache License 2.0.

See [`LICENSE`](LICENSE), [`NOTICE`](NOTICE), and [`DISCLAIMER`](DISCLAIMER).

## Incubation status

Apache Buildish is an effort undergoing incubation at The Apache Software Foundation (ASF), sponsored by the Apache
Incubator PMC.

Incubation is required of all newly accepted projects until a further review indicates that the infrastructure,
communications, and decision-making process have stabilized in a manner consistent with other successful ASF projects.

While incubation status is not necessarily a reflection of the completeness or stability of the code, it does indicate
that the project has yet to be fully endorsed by the ASF.
