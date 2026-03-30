---
# Copyright 2026 The Apache Software Foundation
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
title: Contributing Guidelines
description: How to report issues, propose changes, and submit pull requests to Apache Buildish projects.
type: docs
weight: 30
---

Thank you for considering contributing to Apache Buildish. Contributions to code, docs, tests, examples, naming, onboarding, and project structure are all valuable.

## Report bugs and request features

Open a GitHub issue in the most relevant Buildish repository.

- For umbrella-project work such as the site, shared docs, or cross-component coordination, use the [apache/buildish](https://github.com/apache/buildish) repository.
- For component-specific work, open the issue in that component's repository.
- If you are not sure where something belongs, start with the [development mailing list](mailto:dev@buildish.apache.org).

If you find a security vulnerability, **do not** open a public issue. Follow the [Security Report](/community/security-report/) guidance instead.

When filing an issue, include:

- the affected repository, version, or branch,
- the environment or platform involved,
- what you did,
- what you expected to happen,
- and what actually happened.

## Before you start coding

Review open issues and discuss your approach before starting a larger change. For substantial design changes, explain the intended approach in the relevant issue or on the development mailing list before investing heavily in implementation.

## Submit changes in a pull request

The best way to contribute changes is through a pull request against the relevant Apache Buildish repository.

Recommended workflow:

1. Fork the relevant repository on GitHub.
2. Branch from that repository's default development branch.
3. Keep your change focused and easy to review.
4. Run the relevant checks for the repository you changed.
5. Open a pull request with a clear summary and rationale.

If the change corresponds to a GitHub issue, reference it in the pull request description with `Fixes #123` or `Related to #123`.

For the Buildish site repository, a good baseline is:

- `make test`
- `make integration-test`
- `make build`

## Working on a pull request

- Add or update tests when behavior changes.
- Rebase or otherwise refresh your branch if it falls behind the target branch.
- Use draft pull requests for work in progress.
- Be responsive to review feedback and resolve open questions before merge.

## AI-assisted contributions

Contributors may use AI tools while preparing changes, but the person opening the pull request remains fully responsible for the contribution.

- Understand the change end to end.
- Be ready to explain and justify the implementation during review.
- Ensure contributed material is compatible with ASF licensing and policy.
- Review the [ASF Generative Tooling Guidance](https://www.apache.org/legal/generative-tooling.html) when using AI-assisted tooling for contributions.
- Consider disclosing significant AI assistance in the pull request description for transparency.

## Code contribution guidelines

- Follow the existing style and structure of the repository you are changing.
- Prefer small, reviewable pull requests over large unrelated batches.
- Avoid unnecessary dependencies unless they have been discussed first.
- Discuss public interfaces, extension points, or cross-component impact before requesting merge.
- Give reviewers time to respond, especially for non-trivial changes.