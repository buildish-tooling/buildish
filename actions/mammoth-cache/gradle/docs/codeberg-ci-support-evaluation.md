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

# Codeberg / Forgejo remaining architecture work

This note tracks only the work still left for a Codeberg / Forgejo port.

Completed shared portability refactors are intentionally omitted; see
`docs/provider-portability-implementation-plan.md` for the current shared baseline.

## Current starting point

The shared core already exposes the seams a Codeberg implementation should reuse:

- `src/entrypoints/cli/**`: shared `prepare` / `finalize` entrypoints
- `src/ci/types.ts`: normalized CI metadata, URLs, and host-scoped headers
- `src/runtime-host/types.ts`: runtime capabilities
- `src/reporting/types.ts`: grouped-log and summary sink
- `src/storage/**`: provider-neutral cache and artifact backends

GitHub is the only implemented provider today.

## Remaining work

1. Validate runtime compatibility on the target Forgejo / Codeberg runtime:
   - `@actions/core`
   - `@actions/cache`
   - `@actions/artifact`
   - JavaScript-action post-hook behavior
   - grouped logs and job summaries
2. Add a provider adapter under `src/ci/codeberg/**` or `src/ci/forgejo/**` for environment parsing, URLs,
   diagnostics, and host-scoped headers.
3. Add a provider-specific runtime host only if the current GitHub-compatible host cannot be reused safely.
4. Add a provider-specific report sink only if the current GitHub summary/log behavior cannot be reused safely.
5. Add provider-specific cache and artifact backends only where runtime compatibility diverges.
6. Add Codeberg-facing consumer packaging alongside the existing GitHub descriptor/bundles.

## Constraints to preserve

- keep Codeberg-specific inputs, headers, and environment parsing out of shared config normalization
- keep the shared core wired through the existing `prepare` / `finalize` entrypoints
- widen shared artifact lookup identity only if a real Forgejo backend proves the current scope insufficient
- preserve exact-host auth-header behavior and re-check artifact visibility / trust boundaries on the target runtime
