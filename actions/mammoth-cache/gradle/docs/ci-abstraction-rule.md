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

# CI abstraction rule

When changing this action, treat `src/ci/types.ts` as the provider boundary.

## Rules

- Add provider-specific values to `CiJobContext` and expose them through the CI adapter.
- Prefer passing `CiJobContext` or narrow adapter-derived options through the codebase.
- Do **not** add new direct reads of provider-specific environment variables like `GITHUB_*` or `RUNNER_TEMP` outside CI adapter code unless there is a documented, reviewed exception.
- Do **not** write main/post action detail to the provider job summary surface; keep that detail in grouped logs.
- Keep provider-specific rendering behaviors behind adapter methods when possible.

## Review checklist

- Does the change introduce a new `process.env` or raw env dependency outside `src/ci/**`?
- Could the required value live on `CiJobContext` instead?
- Is the behavior still portable to another CI provider with only adapter changes?
- Are detailed phase diagnostics emitted to logs instead of the job summary?
