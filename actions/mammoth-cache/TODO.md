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

# Open TODOs

1. Documentation for the mammoth action
   - Write `README.md`, examples, permissions table, security section, and maintenance notes.
   - Explicitly document the Gradle wrapper jar download and verification process in the docs/ directory.
     Also explain how it related to the "buildish helper tool".
   - Explicitly document the cache key generation process in the docs/ directory.
   - Explicitly document the base cache design in the docs/ directory.
   - Explicitly document the CI abstraction layer in the docs/ directory.
   - Explicitly document the bootstrap process in the docs/ directory.
   - If diagrams help, use Mermaid
   - All types and functions must have JSDoc comments.
2. Add the "buildish helper tool" to the top-level README
3. Add release workflows
   - Use version tags. "full" version tags like v1.2.3 become actual GitHub releases.
     We can provide "moving" tags like v1, v1.2 as well. Those would then point to the latest release in their
     respective series.
   - The plan is to use GitHub's immutable release feature.
     See https://docs.github.com/en/actions/how-tos/create-and-publish-actions/using-immutable-releases-and-tags-to-manage-your-actions-releases
   - As the action's `dist/` folder is .gitignore'd, we need to ensure that the release workflow ensure that the
     `dist/` folder is included in the Git commit for the release tag.
4. Cleanup the code base
   - MANUALLY inspect all files
   - Check validate*() functions for duplicates
5. Site + logo!
   - We need a logo for the project!
   - Leverage the work done in Polaris, use Hugo.
   - But come up with better Docker builds for the site.
   - Respect that different plugins/actions/tools have different release cadences.
   - Also respect that different plugins/actions/tools have different documentation needs.
6. Validate that the action build-results (INIT_SCRIPT_CONTENTS + SERVICE_PLUGIN_CONTENTS in actions/mammoth-cache/gradle/src/gradle/build-results.ts)
   are not too close to the Gradle action's code.
   - The scripts look a bit GitHub CI specific, using `RUNNER_TEMP` and `GITHUB_ACTION` system properties.
   - Why are those not env vars?

## Deferred / explicitly out of scope for v1

- Non-default `GRADLE_USER_HOME`
- Project-local `.gradle`
- Non-GitHub CI implementations
- Java versions below 8
- Built-in invocation of `actions/setup-java`.
  Just to install Java for a particular version using a particular distribution.
  Using the same defaults as `actions/setup-java` for the version and distribution (value pass-through).
  PROBLEM:
    - the stock setup-java entrypoint always writes Maven auth/toolchain files after installing Java.
    - invoking upstream setup-java as a raw child process would not update this action’s current process environment by itself
    - the upstream entrypoint also emits a Java problem matcher and writes Maven settings/toolchains by default
- Multi-level aggregation (TO BE THOUGHT THROUGH / DOES IT MAKE REAL SENSE?)
    - Currently, the action only supports a set of jobs and exactly one aggregator.
    - It should be possible to have multiple levels of aggregation. In other words, an aggregator could just
      aggregate the input deltas and produce a new, combined delta consumed by another aggregator.
