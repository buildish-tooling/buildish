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

# Artifact portability boundary

This note tracks the remaining cross-provider architecture constraints for distributed artifact exchange.

Detailed package implementation already exists in `src/artifacts/service.ts`; this document focuses only on the provider
boundary and the work still left for non-GitHub providers.

## Current shared seam

- `src/artifacts/service.ts` owns portable package staging, naming, validation, and verification
- `src/storage/artifacts.ts` defines the provider-neutral `WorkflowArtifactBackend` contract and capability flags
- `src/ci/github/artifacts.ts` is the current GitHub implementation
- shared flows currently locate worker artifacts by producer job name plus run/attempt naming conventions

## Remaining work for future providers

- add provider-specific `WorkflowArtifactBackend` implementations instead of branching shared flows by provider
- keep artifact names and package metadata portable; provider-specific identifiers stay in adapter/backend wiring only
- widen `ArtifactLookupScope` and producer metadata only when a real backend needs broader execution identity than the
  current repository/run scope
- validate retention, delete, and cross-execution lookup behavior per provider before enabling those features
- preserve the current verification guarantees: digest checks, schema validation, path safety, and source-race checks

## Constraint that still matters today

Distributed artifact lookup still assumes unique producer job names within one distributed execution.

That matches the current `dependent-jobs` configuration and GitHub implementation. If a future provider cannot preserve
that mapping cleanly, the shared artifact lookup model should be widened together with that provider backend.
