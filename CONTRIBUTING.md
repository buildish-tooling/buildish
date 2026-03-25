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

# Contributing to Buildish

Thank you for considering a contribution to Buildish.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). General project and
cross-component questions can be sent to
[dev@buildish.org](mailto:dev@buildish.org). The website contains the more
detailed [contribution guidelines](site/content/community/contributing-guidelines.md).

## Before opening a pull request

- Check whether an existing issue or pull request already covers the change.
- For larger changes, start a short design discussion on a GitHub issue before investing heavily in implementation.
- Keep pull requests focused; split unrelated work into separate changes.

## Pull request expectations

- Base pull requests on `main`.
- Describe the motivation and the change clearly.
- Add or update tests and documentation when applicable.
- Keep commit messages and pull request text readable for future project history.

## Validate changes

Run the repository gate from the repository root:

```shell
make check
```

Changes to licensing or newly added files should also pass:

```shell
make rat-check
```

Site contributors can use `make serve-local` for a local preview. See the
[unreleased Website development documentation](site/site/docs/_index.md) for
prerequisites, the sibling-repository layout, and additional workflows.

## Security issues

Do **not** open a public issue for a suspected security vulnerability. Instead, report it to [security@buildish.org](mailto:security@buildish.org).
