---
weight: 40
---

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

# Workspace examples

These examples show common layouts that fit the current Site Pipeline contract.

## Consumer repo with sibling component checkouts

This is the simplest layout for a central website repository:

```text
workspace/
  project-site/
    site/components.yaml
  component-a/
  component-b/
```

With `project-site` as `--repo-root`, catalog `localDir` values such as
`component-a` and `component-b` resolve relative to the workspace parent.

## Consumer repo with components under a shared source directory

If the workspace keeps component clones under `src/`, the catalog can point at
them directly:

```text
workspace/
  project-site/
    site/components.yaml
  src/
    component-a/
    component-b/
```

Example catalog entry:

```yaml
components:
  - slug: component-a
    localDir: src/component-a
```

## Local worktrees and checkout overrides

Developers can keep committed `localDir` values stable while redirecting a slug
to a different checkout in `site/components.local.yaml`:

```yaml
schemaVersion: 1
workspace:
  components:
    component-a:
      checkoutDir: ../worktrees/component-a
```

`checkoutDir` is resolved relative to the consumer repo root and stays subject
to the pipeline's workspace-boundary checks.

## Renderer integration example

A consumer renderer should read only from the staged contract:

- staged pages from `site/.stage/content/`
- generated metadata from `site/.stage/data/`
- staged assets from `site/.stage/static/`

That keeps renderer logic deterministic and avoids letting templates reach back
into arbitrary component repositories at render time.