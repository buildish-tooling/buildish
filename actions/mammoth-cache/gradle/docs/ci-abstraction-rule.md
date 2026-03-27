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

# Provider boundary rule

When changing this action, treat the shared portability boundary as the combination of:

- `src/ci/types.ts`
- `src/runtime-host/types.ts`
- `src/reporting/types.ts`
- `src/storage/cache.ts`
- `src/storage/artifacts.ts`

## Rules

- Add provider-specific metadata to `CiJobContext` or provider-owned adapter data, not to unrelated shared modules.
- Prefer passing `CiJobContext`, runtime capabilities, report sinks, or backend interfaces through shared code.
- Do **not** add new direct reads of provider-specific environment variables like `GITHUB_*`, `CI_*`, or `RUNNER_TEMP`
  outside provider adapter code unless there is a documented, reviewed exception.
- Keep shared lifecycle names `prepare` / `finalize`; provider `main` / `post` naming stays at provider edges only.
- Keep provider-specific rendering behavior inside report sinks, not inside shared flows.
- Emit detailed phase diagnostics to grouped logs; keep summaries high-level and provider-mapped.

## Review checklist

- Does the change introduce a new raw `process.env` dependency outside `src/ci/**`?
- Could the required value live on `CiJobContext`, a runtime capability, or a report sink instead?
- Does the change widen shared config or shared flow logic for a provider-specific quirk that should stay in provider code?
- Does the behavior remain portable to another CI provider with adapter/host/backend changes only?
