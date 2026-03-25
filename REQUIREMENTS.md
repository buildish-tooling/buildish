## AUGMENT INSTRUCTIONS

This document is not user-facing but defines the rules and constraints to build the action.
Consider this as the general potentially vague concept. It may be not precise enough in every detail.
Feel free to adjust things for better usability and better security.

If the general idea is sound, go ahead and create a file named `IMPLEMENTATION-PLAN.md` to contain:
1. A high-level plan of how to implement the action, what libraries to use, what APIs to implement, etc.
2. A list of tasks to implement the action. The tasks shall be self-contained and build upon each other.

Assume that it is, for now, only "you" and me working on this. But the intent is to eventually publish this work
as open source.

This document and the implementation plan will not be part of the eventually open-sourced work.

The eventually open-sourced work however must contain a user-facing `README.md` that explains the action, how it
works, the configuration options, the use cases, and the security considerations.

## Summary

GitHub action to be used by GitHub repositories using the Gradle build tool.
It is aimed to provide the necessary functionality to save and restore the Gradle caches and manage the Gradle wrapper
setup securely.

## Functionalities

### Gradle Wrapper download

Adding executable code, including jar files like the `gradle-wrapper.jar`, is considered bad practice and can lead to
security vulnerabilities.

The action inspects files matching the `**/gradle/wrapper/gradle-wrapper.properties` glob to identify the Gradle
wrapper version from the `distributionUrl` property.

#### Notes:

* Similar to the functionality of this script:
  https://raw.githubusercontent.com/apache/polaris/refs/heads/main/gradle/gradlew-include.sh
* Take care of respecting the version number misalignment between the version numbers in the used to retrieve the
  SHA256 hashes from services.gradle.org and the version number used when downloading the wrapper from
  raw.githubusercontent.com. For example, for `.0` versions, the version used in the gradle-wrapper.properties file
  and the URLs against services.gradle.org use the `.0` suffix, while the URLs against raw.githubusercontent.com
  omit the suffix for `.0` versions.
* Source of truth:
    * The SHA256 of the wrapper jar is downloaded from services.gradle.org.
    * The wrapper jar is downloaded from raw.githubusercontent.com.
* SHA256 mismatches and 404 (not found) errors are hard failures.
* As mentioned above, the `**/gradle/wrapper/gradle-wrapper.properties` glob can match multiple Gradle setups.
  This action respects the `gradle/wrapper/gradle-wrapper.properties` (from the base directory, which is configurable,
  defaults to the current directory). Users may either allow this action to process all files matched by the glob or
  specify a list of gradle-wrapper.properties files to process.
* The downloaded gradle-wrapper.jar goes into the directory next to the `gradle-wrapper.properties` file, for example
  `gradle/wrapper/gradle-wrapper.jar` for the default case.
* Dig into the sources of https://github.com/gradle/actions/tree/v5/sources/src/wrapper-validation to understand more
  about Gradle wrapper validation. Stick with the 'v5' branch in that repository and no newer version!
* A failure to download the wrapper jar is a hard failure.
* Downloads, however, should be retried a few (3?) times at an interval of a few (5?) seconds before failing.

### Gradle cache management

This action populates the Gradle caches from a previously cached state and saves the cache for future re-use.

The cache key is composed of the current major Java version, for example `21`, and the Git reference (branch) name.
The current Java version is derived from either the Java version to set up via `actions/setup-java`, if configured,
or from the Java version as reported by the `java` command, aka resolved via the `PATH` environment variable.
Users can override the cache key via the configuration.
If the `actions/setup-java` action is enabled/used, and it fails, this action must fail as well.
The branch name is derived depending on the event that triggered the currently running workflow:

* For `push` events, the name of the branch being pushed to is used.
* For `pull_request` and `pull_request_target` events, the name of the branch the pull request is targeting is used.
* For `workflow_dispatch` events, the name of the branch the workflow was manually dispatched from is used.
* For other events, the name of the repository's default branch is used.

### Support for "distributed" GitHub workflows

Workflows often consist of multiple jobs that are executed in parallel. This action supports such "distributed"
workflows and ensures that the eventually cached state of the Gradle caches contains the modifications of all jobs
in such workflows.

* The action supports distributed workflows by allowing multiple jobs to share the same cache.
* Each job pulls the Gradle caches of the previously persisted Gradle cache state, using the `actions/download-artifact`
  action.
* The _modified_ Gradle cache contents are uploaded as a GitHub artifact using the `actions/upload-artifact` action.
* Each job does not pull the already uploaded _modified_ Gradle cache contents from the other jobs in the same workflow.
* Users may configure this action to download the _delta_ of the Gradle cache contents from other jobs in the
  same workflow. This happens by configuring this action with the names of the jobs that are expected to have
  finished before the current job starts, so this action can download their artifacts. This should be documented
  to require that such "dependent" jobs must be declared with the `needs: []` syntax to work as expected.
* Failures to download the _delta_ of dependent jobs' Gradle cache contents let this action fail hard.
* "Distributed" workflows would contain a final job that assembles the Gradle caches from all other jobs and pushes the
  result to the GitHub cache storage using the `actions/cache` action.
* Before uploading the final Gradle cache state using the `actions/cache` action, the action ensures that Gradle had a
  chance to clean up the caches. We have to invoke Gradle in a way that completes quickly (but not too quick?) for this.
  See https://docs.gradle.org/current/userguide/directory_layout.html#dir:gradle_user_home:cache_cleanup
* The previous point requires that the cached files are restored with the correct `atime`. This is implemented as a
  best-effort.
* The names of the GitHub artifacts are an implementation internal concern. Those shall ensure that they are unique and
  do not clash with other artifacts in the workflow. The names should be user-readable, though, for debugging and
  troubleshooting purposes, using the job name plus necessary unique identifiers (GH job ID, GH workflow run ID)
  seems fine, as long as it is unique. The "run attempt" feels risky to include in the artifact names, because jobs
  can be individually re-tried, so the "run attempt" numbers of different jobs can be different.

#### Questions:

* Should this action split the cached artifacts like the `gradle/actions/setup-gradle` action?
  ANSWER: YES! For better cache hit rates.

#### Notes:

* Dig into the sources of https://github.com/gradle/actions/tree/v5/sources/src/caching to understand how a Gradle
  cache can be managed. Stick with the 'v5' branch in that repository and no newer version!
* For support of multiple GH jobs, consider the functionality implemented in
  https://raw.githubusercontent.com/apache/polaris/refs/heads/main/.github/actions/ci-incr-build-cache-prepare/action.yml
  and https://raw.githubusercontent.com/apache/polaris/refs/heads/main/.github/actions/ci-incr-build-cache-save/action.yml.
  Those implementations may neither be 100% correct nor support all cases, but seem to work.
* Restoring and saving the cache contents shall use to the `actions/cache` action.
* Restoring the cache contents happens when this action is being used.
* Failures when restoring the "base" cache contents must not fail this action, but a warning shall be logged.
* Saving the cache contents happens as a "post-action," but not a separate invocation of this action.
* The configuration cache is explicitly excluded from the cached artifacts to not potentially expose secrets that might
  pbe contained in the configuration cache.
* Otherwise, the cached contents include:
    * The build cache
    * Kotlin DSL caches
    * Transforms/modules metadata
    * Modules (downloaded artifacts)

### JDK setup

If enabled, the action sets up the JDK by using the `actions/setup-java` action.
The options passed to the invocation of the `actions/setup-java` action are configurable.

### Job summaries

Each job shall produce a GitHub job summary, analoguous to the functionality of the `gradle/actions/setup-gradle` action
as in https://github.com/gradle/actions/blob/v5/sources/src/job-summary.ts.

## Security features

* Verification of the Gradle wrapper.
* The property `validateDistributionUrl` must be set to `true` in each `gradle-wrapper.properties` file.
* The property `distributionSha256Sum` must be present in each `gradle-wrapper.properties` file.
* All configuration options are validated to prevent injecting malicious values, which might lead to security issues.
* Environmental options like the Git reference name are validated to prevent malicious values.
* Options and environmental values that do not pass validation cause the action to fail with an appropriate error
  message.
* Validation rules shall effectively prevent injecting malicious content.
    * Reference names shall be validated against "common sense," using a realistic maximum length (100?) and a whitelist
      of allowed common characters, for example, `[a-zA-Z0-9-_/ ]`.
    * Similar rules apply to other values used in the cache key, cache prefix, job names, and artifact names.
    * The Java version must be an integer number in the range of supported Java versions (8+).
* This action expects the minimum viable permissions to function properly. A list of the permissions required for
  the respective use cases shall be documented in the user facing `README.md` to be built later.

## Implementation

The implementation is using Node/TypeScript.

References to all other actions must be pinned to the respective the Git SHA, annotated (commented) with the Git tag
name. Node/TypeScript dependencies must be pinned as well.

All source files where syntactically possible must include the Apache license header

The root directory must contain a `LICENSE` file with the Apache License 2.0 text and a `NOTICE` file with the
required notices, according to ASF project standards. Do only use dependencies that comply
with https://www.apache.org/legal/resolved.html.

The eventually distributed GitHub action artifacts bundle generated, for example, via ncc/esbuild must contain the
correct LICENSE and NOTICE files.

The Java version is derived from the current default Java version of the GitHub workflow environment.

While the implementation shall be focused on GitHub first, it should be designed in a way to allow re-use in other CI
environments like GitLab CI, Codeberg, etc. This means that all GitHub-specific functionality must be abstracted using
a CI system agnostic API layer. We leverage this API layer for testing purposes. This "CI system agnostic layer" also
applies to configuration options.

Do NEVER EVER blindly copy code from other actions. Always understand what the code does and how it works.
Rewrite the code in a way that fits this project's needs but is different enough to not be considered as a copy
from the source to prevent copyright and licensing issues.

When this doc refers to "using another GitHub action," it means to call this action from this action's code base,
referring to the "other" actions via imports like `import * as cache from '@actions/cache'`

## Configuration

* Cache key prefix: `gradle-cache-` - this one can be used by users to specifiy custom workflow namespaces or other
  distinguishers.
* Cache key format:
  `${cacheKeyPrefix}${cacheSchemaVersion}-${javaMajorVersion}[${runnerOs}-${runnerArchitecture}]-${gitRefName}`.
    * The `cacheSchemaVersion` determined by this action and is a constant value like `1` for now.
    * The user can configure the cache key pattern.
* Environment variable: defaults to `GRADLE_USER_HOME`, which defaults to `$HOME/.gradle`.
* Flag to enable setting up Java by using the `actions/setup-java` action: `setupJava`, defaults to `false`.
* Configuration for the `actions/setup-java` action, consisting only of the java version and distribution.
  If users need more configuration options, they can always call the `actions/setup-java` action themselves before
  calling this action.
* Option to completely disable Gradle cache management. Default is to enable it.
* Option to disable upload of changed caches (aka "read-only"). Default depends on the GitHub event:
    * `false` for `push` events
    * `true` for `pull_request` and `pull_request_target` events
* Option to create a custom Gradle init script to allow fine-grained control of the Gradle cache cleanup settings, as
  described in
  https://docs.gradle.org/current/userguide/directory_layout.html#dir:gradle_user_home:configure_cache_cleanup. The
  retention of the daemon logs is irrelevant.
* Option to tell the action the "personality" of the job it is running in. This option basically says whether the
  job is part of a "distributed workflow" or not. The default is `non-distributed` (or the like), indicating that
  the job is the only job in the workflow using Gradle. For "distributed workflows" there are two other
  "personalities":
    * `distributed-worker` - a job in the workflow that uses Gradle, downloads the previous Gradle cache artifacts
      from the GitHub cache storage, and potentially already uploaded Gradle cache artifacts from other jobs in the
      workflow.
    * `distributed-aggregator` - the job in the workflow that eventually saves the Gradle cache to the GitHub cache
      storage.

## Documentation

Need proper and thorough documentation in a `README.md` file at the root of this project.

Core must contain proper inline documentation.

## Testing

* Unit tests for the action code.
* Unit tests using mocked invocations of the used actions.
* Integration tests for the action in a real GitHub workflow environment. Those workflows shall be implemented as well.
* GitHub workflow to build, verify (linting, etc.) and run the unit tests.

### Coverage (minimum)

* push, pull_request, pull_request_target, workflow_dispatch
* non-distributed worker/aggregator personalities
* setup-java on/off
* wrapper validation pass/fail
* multiple gradle-wrapper.properties files
* cache disabled
* read-only mode
* artifact merge/aggregation
* default branch fallback behavior
* unsupported config values fail securely

## Build

* Use eslint and prettier for code formatting and linting.
* Respect the Node/TypeScript version constraints of the GitHub actions ecosystem.
* The project shall be seamlessly built and tested from the command line.
* The project shall be seamlessly built and tested within common IDEs like WebStorm, VS Code, etc.

## Restrictions

For simplicity, a couple of restrictions are in place, which might be lifted in future versions:

* no support yet for non-default GRADLE_USER_HOME.
  The property `distributionBase` in each `gradle-wrapper.properties` file must be set to `GRADLE_USER_HOME` or
  be absent. Same for the `zipStoreBase` property. Only the default value of the `distributionPath` and `zipStorePath`
  properties are supported, which is
  `wrapper/dists` for both.
* no support yet for non-GitHub CI
* no support yet for Java < 8
* no support yet for project-local .gradle
* no support yet for macOS or Windows runners
