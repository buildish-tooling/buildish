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

# **The Gradle User Home Caches Directory: Portability, Internal Structures, and Optimization for Distributed Build Systems**

The architecture of the Gradle build tool is predicated on a sophisticated caching hierarchy designed to minimize
redundant computation and network overhead. Central to this system is the Gradle User Home directory, commonly referred
to as the GUH, which serves as the global repository for build state, external dependencies, and ephemeral metadata.1
Within this hierarchy, the caches/ directory represents the primary storage engine, housing a diverse array of data
structures ranging from immutable binary artifacts to highly volatile execution histories. As modern software
development increasingly shifts toward ephemeral Continuous Integration (CI) environments and distributed build
infrastructures, the ability to selectively persist and migrate these caches has become a critical concern for build
engineers. Understanding which components of the caches/ directory represent "reusable knowledge" versus "local state"
is essential for maintaining build determinism and optimizing performance. The following analysis provides an exhaustive
decomposition of the caches/ directory, identifying the specific patterns of files that are safe for cross-machine
migration and those that must be omitted to avoid non-deterministic failures.

## **Taxonomy of the Gradle User Home and Caches Hierarchy**

The Gradle User Home is typically established at \~/.gradle on Unix-based systems or %USERPROFILE%\\.gradle on Windows
environments, though its location can be overridden via the GRADLE_USER_HOME environment variable or the \-g
command-line flag.1 This directory is distinct from the installation directory, often termed GRADLE_HOME, and is
structured to support multi-version concurrency and global data sharing across disparate projects.

| Directory Level | Primary Function                                         | Persistence Recommended for CI |
| :-------------- | :------------------------------------------------------- | :----------------------------- |
| caches/         | Central repository for all cached resources.             | Yes (Selective) 3              |
| daemon/         | Registry and logs for the long-running Gradle processes. | No 1                           |
| wrapper/        | Downloaded distributions and related metadata.           | Yes 5                          |
| native/         | Platform-specific native binaries used by Gradle.        | No (Regenerated) 2             |
| notifications/  | Internal notification state for the build tool.          | No 7                           |

The caches/ subdirectory itself is a partitioned environment where data is organized by its lifecycle and scope.
Gradle's internal cleanup services categorize these resources into specific buckets with varying retention policies,
reflecting their relative importance and ease of regeneration.6

### **Categories of Cached Resources and Retention Policies**

The management of disk space within the caches/ directory is governed by an automated garbage collection mechanism that
evaluates the age and utility of specific files. Resources that are "downloaded" from external sources generally enjoy
longer retention periods compared to "created" resources that can be computed locally.

| Resource Category      | Directory Pattern | Default Retention (Unused) | Origin Type                      |
| :--------------------- | :---------------- | :------------------------- | :------------------------------- |
| Downloaded Resources   | modules-2/        | 30 Days                    | External (Remote Repositories) 6 |
| Created Resources      | transforms-x/     | 7 Days                     | Internal (Computed locally) 6    |
| Build Cache            | build-cache-1/    | 7 Days                     | Internal (Task outputs) 6        |
| Released Distributions | wrapper/dists/    | 30 Days                    | External (Gradle Services) 6     |
| Snapshot Distributions | wrapper/dists/    | 7 Days                     | External (Nightly/Dev builds) 6  |
| Daemon Logs            | daemon/x.y/       | 14 Days                    | Internal (Diagnostics) 6         |

This categorization provides the first major insight into portability: resources with 30-day retention are typically
immutable and global, while those with 7-day retention are often ephemeral or derivative, suggesting they are safer to
omit when storage is constrained.

## **Anatomy of the Dependency Store: modules-2**

The modules-2 directory is arguably the most critical component of the cache for ensuring offline build capability and
reducing network latency. It functions as a local proxy for all Maven, Ivy, and flat-directory repositories declared in
a project's build scripts.8 The internal structure of modules-2 is split between raw file storage and binary metadata
indexes.

### **File-based Artifact Storage in files-2.1**

The files-2.1 subdirectory implements a deterministic, content-addressable storage model for external artifacts. When
Gradle resolves a dependency, such as org.apache.httpcomponents:httpclient:4.3.3, it stores the resulting JARs and
metadata files using a specific path hierarchy:  
////\[FILENAME\]  
For example, a typical entry might appear as:
\~/.gradle/caches/modules-2/files-2.1/org.apache.httpcomponents/httpclient/4.3.3/65cba03c4f6207f2885f88206fcf52c53f8d111b/httpclient-4.3.3.jar.10  
The integration of the checksum into the file path is a fundamental architectural decision that ensures several
properties:

1. **Immutability:** Once a file is stored under a specific checksum, it is never modified. If the repository serves a
   different file for the same version, it will receive a different checksum and a separate directory.8
2. **Concurrency:** Multiple Gradle processes can safely read these files without locking, as they are never updated in
   place.
3. **Portability:** Because the path is derived solely from the artifact's coordinates and its content, this directory
   is perfectly portable across different machines and operating systems.8

### **The Metadata Binary Store**

While files-2.1 contains the "physical" files, the metadata-x directories (where x corresponds to an internal schema
version, such as metadata-2.107) contain the "logical" understanding of the dependency graph.8 This store is comprised
of binary descriptors and indexes that map dynamic versions (like 1.+) to concrete versions and record the results of
repository lookups.

| Metadata Component   | Description                                           | Portability Risk                 |
| :------------------- | :---------------------------------------------------- | :------------------------------- |
| descriptors/         | Binary representations of POM and Ivy files.          | High (Contains absolute paths) 8 |
| module-versions.bin  | Map of resolved dynamic version numbers.              | Low (Regenerated quickly) 11     |
| module-artifacts.bin | Map of module versions to their constituent files.    | High (Absolute path pointers) 8  |
| absent/              | Records of "404 Not Found" results from repositories. | Low (Local optimization) 8       |

The binary store presents a significant challenge for cross-machine persistence. Many of the internal binary structures
use absolute file system paths to point to the artifacts located in files-2.1.11 If the Gradle User Home is restored to
a different location on a CI agent (e.g., /home/runner/.gradle vs /Users/developer/.gradle), these binary pointers
become invalid, leading to "File Not Found" errors despite the artifacts being present on disk. Consequently, while
files-2.1 should always be persisted, the metadata-x folders are often better left for local regeneration.11

## **Artifact Transformations and the transforms-x Directory**

One of the most complex and frequently misunderstood components of the Gradle cache is the transforms-x directory.
Artifact transforms are a mechanism used by plugins (notably the Android Gradle Plugin) to convert dependencies from one
state to another before they are placed on the classpath.3 Common examples include the Jetifier transform, which
migrates legacy Android support libraries to AndroidX, and the Dexing transform, which converts Java bytecode to Dalvik
Executable format.13

### **Mechanism of Transform Storage**

Each transform is uniquely identified by a hash of its inputs, including the transform's implementation code, the input
artifact's content, and any parameters (such as minSdkVersion).12 The result is stored in a directory named with this
hash under caches/transforms-3/ (or transforms-4 in more recent Gradle versions).15  
\~/.gradle/caches/transforms-3//transformed/  
The underlying trend in artifact transforms is a trade-off between build speed and environmental sensitivity. While
these transforms save significant time by avoiding repeated work, they are notoriously non-portable for three primary
reasons:

1. **Absolute Path Injection:** Transformed artifacts, particularly those involving Android resources or native
   libraries, often contain metadata or absolute paths pointing back to the original source location in the modules-2
   cache.16
2. **Environment Dependencies:** Many transforms rely on external tools like the JDK or Android SDK. If a transform was
   executed using JDK 11 and restored on a machine using JDK 17, the resulting artifact may be incompatible or
   invalid.17
3. **Local Binary Indexes:** Each transforms-x directory contains a results.bin file that acts as a local index. This
   file is highly sensitive to the local file system layout and is a frequent point of corruption.18

### **Portability and Omission Strategy for Transforms**

Experience from large-scale CI implementations, such as those documented by the Flutter and Android communities,
suggests that the transforms-x directory is a "high-risk, high-reward" cache.19 In environments where the file system
path of the GUH is identical across all agents, persisting transforms-x can yield massive performance gains. However, in
heterogeneous environments, it is the most common cause of build instability.  
For distributed builds, the transforms-x directory contains purely locally computed data and should generally be omitted
from shared caches unless path symmetry is guaranteed. The cost of regenerating these transforms is usually lower than
the cost of debugging a "CorruptedCacheException" or an "Incompatible Class Version" error.18

## **The Build Cache: build-cache-1**

In contrast to the dependency cache, which stores external inputs, the Gradle Build Cache stores the outputs of the
project's own tasks.21 This feature, introduced in Gradle 3.5, allows for the reuse of task outputs even when the local
build/ directory has been cleaned or when the build is running on a completely different machine.3

### **The Hashing Algorithm for Task Outputs**

The build cache operates on the principle of input-output determinism. Before executing a task, Gradle computes a build
cache key $K$ by hashing all relevant inputs 22:

$$K \= \\text{SHA-256}(\\text{Task Class} \+ \\text{Inputs} \+ \\text{Output Definitions} \+ \\text{Environment Metadata})$$  
If a result for key $K$ exists in caches/build-cache-1/, the task is marked as FROM-CACHE, and the outputs are unpacked
directly into the project workspace.23

### **Relocatability and Path Sensitivity**

The portability of the build cache is governed by the PathSensitivity setting of the task's inputs.21 If a task is
configured with PathSensitivity.ABSOLUTE, the cache key will change if the project is moved to a different directory,
rendering the cache entry useless on another machine.21 However, when using PathSensitivity.RELATIVE or
PathSensitivity.NAME_ONLY, the build cache becomes highly portable.

| Sensitivity Level | Key Dependency                                          | Portability |
| :---------------- | :------------------------------------------------------ | :---------- |
| ABSOLUTE          | Full file path (e.g., /Users/dev/project/src/Main.java) | Low         |
| RELATIVE          | Path relative to project root (e.g., src/Main.java)     | High        |
| NAME_ONLY         | Just the filename (e.g., Main.java)                     | High        |
| NONE              | Only the file content                                   | Highest     |

The build cache is designed to be shared. In fact, many organizations utilize a Remote Build Cache (via HTTP) to bridge
the gap between CI and developer machines.3 Therefore, build-cache-1 is an excellent candidate for persistence, provided
that the build authors have correctly configured task inputs to be path-agnostic.

## **Version-Specific Internal Caches and Metadata**

For each version of Gradle used on a machine, a dedicated subdirectory is created under caches/ (e.g., caches/8.10.2/ or
caches/7.6/).3 These directories contain the "operational state" of the build tool and are almost entirely comprised of
locally computed data that is not intended for transfer between machines.

### **Execution History and File Hashes**

The execution-history/ subdirectory is the most significant component of these version-specific folders. It contains a
persistent record of every task's inputs and outputs from the last time it ran _on that specific machine_.25 This data
supports "up-to-date" checks, allowing Gradle to skip tasks without even looking at the build cache.  
The files within execution-history/ are inherently non-portable because they:

1. Store file system timestamps that are unique to the local disk.
2. Store absolute paths to every source file and output artifact in the project.
3. Store file system "snapshot" metadata that includes OS-specific attributes like file permissions and inode numbers.3

Similarly, the file-hashes/ directory contains a mapping of file paths to their content hashes. This acts as a cache for
the hashing process itself. Because this index is keyed by absolute file paths, it is useless if the project location
changes.26

### **The Kotlin DSL and Classpath Caches**

For projects using the Kotlin DSL (build.gradle.kts), the version-specific directory also contains compiled versions of
the build scripts.23 While these could theoretically be shared, they are often tied to specific versions of the Kotlin
compiler and the classpath of the build, making them fragile and prone to verification errors if migrated.

| Pattern to Omit                       | Description                        | Reason for Omission                       |
| :------------------------------------ | :--------------------------------- | :---------------------------------------- |
| caches/\[version\]/execution-history/ | Task state for incremental builds. | Absolute paths and local timestamps.25    |
| caches/\[version\]/file-hashes/       | Index of file content signatures.  | Keyed by absolute local paths.27          |
| caches/\[version\]/kotlin-dsl/        | Compiled build script binaries.    | Sensitive to classpath and JVM version.23 |
| caches/\[version\]/java-compile/      | Incremental compilation analysis.  | Non-portable analysis data.3              |

## **Maintenance Metadata: journal-1 and Lock Files**

The journal-1 directory and various \*.lock files found throughout the caches/ hierarchy constitute the synchronization
and maintenance layer of Gradle.29

### **The File Access Time Journal**

The journal-1/file-access.bin file is a B-Tree database used by the Gradle cleanup service to track the last time any
particular cache entry was used.30 This allows Gradle to implement the 7-day and 30-day eviction policies mentioned
previously.6  
This journal is a purely local optimization. It contains no data that affects the correctness or performance of the
build process itself; it only helps with housekeeping. Furthermore, the journal is a frequent source of "
CorruptedCacheException" if it is partially written or if multiple Gradle instances attempt to access it
simultaneously.20 Sharing this file between machines is not only unnecessary but actively dangerous, as it can propagate
corruption across the build fleet.

### **Synchronization Locks**

Gradle uses \*.lock files to coordinate access to shared resources across different processes (e.g., the Gradle Daemon,
the IDE, and the CLI).3 These lock files often contain the Process ID (PID) of the owning process.29  
When a cache is persisted for use on another machine, the inclusion of lock files can cause the new build to fail. If
machine A saves a lock file owned by PID 1234, and machine B restores that file, machine B may believe that a local
process with PID 1234 is currently modifying the cache.31 Since no such process exists on machine B, or worse, an
unrelated process has that PID, the Gradle build will hang indefinitely waiting for the lock to be released.32

## **Configuration Cache and Security Implications**

The Configuration Cache is a newer feature that saves the result of the project configuration phase to disk, allowing
Gradle to skip build script evaluation entirely for subsequent runs.33 While most of the Configuration Cache data is
stored in the project's root .gradle/ directory, it relies on global state within the GUH, specifically an encrypted
keystore.33

### **Relocatability of Configuration Cache Data**

Prior to Gradle 8.6, the Configuration Cache was explicitly non-relocatable and could not be shared between machines.28
Modern versions have introduced limited support for relocatability, but this requires:

1. **Encryption Key Management:** The encryption key used to protect secrets within the configuration cache must be
   shared between machines via environment variables.28
2. **Path Sensitivity:** All logic in the build scripts must avoid using absolute paths or environment-specific
   variables during the configuration phase.23

A significant security vulnerability (CVE-2023-30853) was identified where environment variables containing secrets were
inadvertently persisted into the configuration cache.35 As a result, current best practices for distributed builds
involve treating the configuration cache as "local-only" data unless rigorous security controls and encryption key
rotations are in place.34

## **Identification of File Path Patterns for Strategic Omission**

Based on the preceding architectural analysis, it is possible to define a clear boundary between files that should be
persisted for cross-machine reuse and those that should be omitted. This "whitelist and blacklist" approach is standard
in high-performance CI pipelines.

### **The Whitelist: Essential Portable Data**

The following directories contain immutable or content-addressable data that is safe and highly beneficial to migrate
between machines.

| Pattern                         | Functional Role                  | Implications of Persistence                                    |
| :------------------------------ | :------------------------------- | :------------------------------------------------------------- |
| caches/modules-2/files-2.1/\*\* | External artifacts (JARs, POMs). | Eliminates redundant downloads; essential for offline builds.8 |
| caches/build-cache-1/\*\*       | Task output snapshots.           | Enables cross-machine task reuse (e.g., CI to Dev).21          |
| wrapper/dists/\*\*              | Gradle distributions.            | Avoids re-downloading the build tool itself.5                  |
| caches/jars-\*/\*\*             | Cached plugin JARs.              | Speeds up the initial startup of the Gradle Daemon.3           |

### **The Blacklist: Locally Computed and Environment-Specific Data**

The following patterns represent data that is either unique to the local file system, prone to corruption during
migration, or contains absolute paths that will break on other machines.

| Pattern                                       | Category        | Technical Reason for Omission                                    |
| :-------------------------------------------- | :-------------- | :--------------------------------------------------------------- |
| caches/\*\*/\*.lock                           | Synchronization | Prevents "Timeout waiting to lock" hangs.31                      |
| caches/journal-1/\*\*                         | Maintenance     | Prevents corruption; journal is unique to local disk activity.20 |
| caches/transforms-\*/\*\*                     | Transforms      | Likely contains absolute paths to the original GUH location.17   |
| caches/\[0-9.\]\*/\*\*                        | Version State   | Contains execution history with local file system timestamps.25  |
| caches/modules-2/metadata-\*/descriptors/\*\* | Binary Metadata | Binary pointers to absolute paths in files-2.1.11                |
| daemon/\*\*                                   | Daemon State    | Registry of local PIDs and ephemeral log files.1                 |
| native/\*\*                                   | Native Binaries | Platform-specific binaries regenerated on demand.2               |

## **Operational Implications for Distributed Build Systems**

The underlying theme of the Gradle cache is a transition from "Workspace Local" state to "Content Addressable" storage.
Older versions of Gradle relied heavily on the absolute path of the user's home directory, but the introduction of the
Build Cache and Artifact Transforms has pushed the architecture toward a more relocatable model. However, the legacy of
absolute path indexing remains a significant hurdle.

### **CI/CD Integration Patterns**

In ephemeral CI systems like GitHub Actions or CircleCI, the common mistake is to archive the entire \~/.gradle
directory. This leads to "Cache Bloat," where the archive size grows exponentially with files that are useless on
subsequent runs. A more sophisticated approach, as implemented in tools like setup-gradle, is to perform a pre-archive
cleanup.34  
This cleanup logic explicitly deletes the journal-1 and \*.lock files and evaluates which version-specific caches have
been "touched" during the current build. Any files that were not accessed are purged, ensuring that the persisted cache
contains only the dependencies and task outputs relevant to the current state of the project.6

### **Impact of Shared File Systems**

In enterprise environments using shared file systems (like NFS or Lustre) for the GUH, the locking behavior of journal-1
and the daemon registry becomes a primary failure point.2 Shared file systems often lack the consistent locking
semantics required by Gradle's DefaultFileLockManager, leading to strange build results or deadlocks when multiple
machines attempt to use the same GUH simultaneously.2 The desired behavior in these scenarios is to relocate the caches/
directory to a local, high-speed disk (e.g., /var/tmp/gradle-cache) while keeping configuration files in the shared home
directory.2

## **Conclusion**

The caches/ directory of the Gradle User Home is a dual-natured entity. On one hand, it is a highly efficient repository
of global knowledge (modules-2/files-2.1, build-cache-1) that is deterministic and relocatable. On the other hand, it is
a graveyard of local execution state (execution-history, journal-1, transforms-x) that is inextricably linked to the
specific file system, process IDs, and absolute paths of the machine where it was created.  
For professional peers managing build infrastructure, the core takeaway is that "more cache is not always better."
Persisting the machine-specific metadata of the caches/ directory is not merely a waste of storage; it is a source of
non-determinism that can undermine the reliability of the entire build pipeline. By strictly adhering to the omission
patterns identified—specifically targeting locks, journals, and version-specific execution histories—engineers can
achieve the optimal balance of speed and stability, ensuring that the Gradle cache remains a tool for acceleration
rather than a vector for corruption. The future of Gradle caching lies in the continued refinement of these relocatable
structures, ultimately moving toward a world where the local file system path is entirely abstracted away from the
build's persistent state.

#### **Works cited**

1. Anatomy of a Gradle Build, accessed March 26,
   2026, [https://docs.gradle.org/current/userguide/gradle_directories_intermediate.html](https://docs.gradle.org/current/userguide/gradle_directories_intermediate.html)
2. Allow the location of the Gradle cache to be specified independent of the user configuration files \#1319 \- GitHub,
   accessed March 26, 2026, [https://github.com/gradle/gradle/issues/1319](https://github.com/gradle/gradle/issues/1319)
3. Mastering Gradle Caching and Incremental Builds | by Fedor Korotkov \- Medium, accessed March 26,
   2026, [https://medium.com/cirruslabs/mastering-gradle-caching-and-incremental-builds-37eb1af7fcde](https://medium.com/cirruslabs/mastering-gradle-caching-and-incremental-builds-37eb1af7fcde)
4. General \- The Gradle Blog, accessed March 26,
   2026, [https://blog.gradle.org/category/general](https://blog.gradle.org/category/general)
5. Gradle Wrapper \- Gradle User Manual, accessed March 26,
   2026, [https://docs.gradle.org/current/userguide/gradle_wrapper.html](https://docs.gradle.org/current/userguide/gradle_wrapper.html)
6. Gradle-managed Directories \- Gradle User Manual, accessed March 26,
   2026, [https://docs.gradle.org/current/userguide/directory_layout.html](https://docs.gradle.org/current/userguide/directory_layout.html)
7. Parallel workflows containing jobs with the same name use the same cache key, resulting in "Failed to save cache
   entry" · Issue \#699 · gradle/gradle-build-action \- GitHub, accessed March 26,
   2026, [https://github.com/gradle/gradle-build-action/issues/699](https://github.com/gradle/gradle-build-action/issues/699)
8. Dependency Caching \- Gradle User Manual, accessed March 26,
   2026, [https://docs.gradle.org/current/userguide/dependency_caching.html](https://docs.gradle.org/current/userguide/dependency_caching.html)
9. How to make Gradle repository point to local directory \- Stack Overflow, accessed March 26,
   2026, [https://stackoverflow.com/questions/25965901/how-to-make-gradle-repository-point-to-local-directory](https://stackoverflow.com/questions/25965901/how-to-make-gradle-repository-point-to-local-directory)
10. .classpath · GitHub, accessed March 26,
    2026, [https://gist.github.com/Shup04/242c9fb0292f51032d4f](https://gist.github.com/Shup04/242c9fb0292f51032d4f)
11. Copying the Gradle cache to another machine \- Old Forum Archive, accessed March 26,
    2026, [https://discuss.gradle.org/t/copying-the-gradle-cache-to-another-machine/7546](https://discuss.gradle.org/t/copying-the-gradle-cache-to-another-machine/7546)
12. Registering multiple transforms with the same values of attributes should fail \#26974, accessed March 26,
    2026, [https://github.com/gradle/gradle/issues/26974](https://github.com/gradle/gradle/issues/26974)
13. Execution failed for task ':app:mergeExtDexDebug'. Could not resolve all files for configuration ':app:
    debugRuntimeClasspath' \- Stack Overflow, accessed March 26,
    2026, [https://stackoverflow.com/questions/78605853/execution-failed-for-task-appmergeextdexdebug-could-not-resolve-all-files-f](https://stackoverflow.com/questions/78605853/execution-failed-for-task-appmergeextdexdebug-could-not-resolve-all-files-f)
14. Flutter ERROR:C:\\Users\\kamde\\.gradle\\caches\\transforms-3 \- Stack Overflow, accessed March 26,
    2026, [https://stackoverflow.com/questions/78267161/flutter-errorc-users-kamde-gradle-caches-transforms-3](https://stackoverflow.com/questions/78267161/flutter-errorc-users-kamde-gradle-caches-transforms-3)
15. Unused caches/transforms-3 directory is not removed by Gradle User Home cache cleanup \#28178 \- GitHub, accessed
    March 26, 2026, [https://github.com/gradle/gradle/issues/28178](https://github.com/gradle/gradle/issues/28178)
16. One or more issues found when checking AAR metadata values: \- Stack Overflow, accessed March 26,
    2026, [https://stackoverflow.com/questions/69943549/one-or-more-issues-found-when-checking-aar-metadata-values](https://stackoverflow.com/questions/69943549/one-or-more-issues-found-when-checking-aar-metadata-values)
17. Failing Flutter Android Build Because of JDK / compileOptions \- Stack Overflow, accessed March 26,
    2026, [https://stackoverflow.com/questions/79057570/failing-flutter-android-build-because-of-jdk-compileoptions](https://stackoverflow.com/questions/79057570/failing-flutter-android-build-because-of-jdk-compileoptions)
18. React-native android build fails due to missing files in the gradle cache? \- Stack Overflow, accessed March 26,
    2026, [https://stackoverflow.com/questions/72830273/react-native-android-build-fails-due-to-missing-files-in-the-gradle-cache](https://stackoverflow.com/questions/72830273/react-native-android-build-fails-due-to-missing-files-in-the-gradle-cache)
19. Android Gradle build fails from cached files \- Stack Overflow, accessed March 26,
    2026, [https://stackoverflow.com/questions/70010356/android-gradle-build-fails-from-cached-files](https://stackoverflow.com/questions/70010356/android-gradle-build-fails-from-cached-files)
20. android \- CorruptedCacheException: Corrupted IndexBlock 298298 found in cache '
    /Users/macuser/.gradle/caches/journal-1/file-access.bin' \- Stack Overflow, accessed March 26,
    2026, [https://stackoverflow.com/questions/55801823/corruptedcacheexception-corrupted-indexblock-298298-found-in-cache-users-macu](https://stackoverflow.com/questions/55801823/corruptedcacheexception-corrupted-indexblock-298298-found-in-cache-users-macu)
21. Build Cache \- Gradle User Manual, accessed March 26,
    2026, [https://docs.gradle.org/current/userguide/build_cache.html](https://docs.gradle.org/current/userguide/build_cache.html)
22. Gradle Build Cache Basics | Baeldung, accessed March 26,
    2026, [https://www.baeldung.com/gradle-build-cache](https://www.baeldung.com/gradle-build-cache)
23. Popular Gradle mistakes (and how to avoid them) \- part 2 \- Allegro Tech Blog, accessed March 26,
    2026, [https://blog.allegro.tech/2025/05/popular-gradle-mistakes-and-how-to-avoid-them-part2.html](https://blog.allegro.tech/2025/05/popular-gradle-mistakes-and-how-to-avoid-them-part2.html)
24. Use cases for the build cache \- Gradle User Manual, accessed March 26,
    2026, [https://docs.gradle.org/current/userguide/build_cache_use_cases.html](https://docs.gradle.org/current/userguide/build_cache_use_cases.html)
25. Use snapshots instead of fingerprints for work outputs · Issue \#9034 · gradle/gradle \- GitHub, accessed March 26,
    2026, [https://github.com/gradle/gradle/issues/9034](https://github.com/gradle/gradle/issues/9034)
26. punkpeye/awesome-mcp-servers at nocodeopensource.io \- GitHub, accessed March 26,
    2026, [https://github.com/punkpeye/awesome-mcp-servers?ref=nocodeopensource.io](https://github.com/punkpeye/awesome-mcp-servers?ref=nocodeopensource.io)
27. Remember to check your Gradle (Cache) folder\! : r/androiddev \- Reddit, accessed March 26,
    2026, [https://www.reddit.com/r/androiddev/comments/1ax7bxh/remember_to_check_your_gradle_cache_folder/](https://www.reddit.com/r/androiddev/comments/1ax7bxh/remember_to_check_your_gradle_cache_folder/)
28. Configuration cache should be shareable between machines · Issue \#13510 \- GitHub, accessed March 26,
    2026, [https://github.com/gradle/gradle/issues/13510](https://github.com/gradle/gradle/issues/13510)
29. Can't Run Two Gradle Things Simultaneously \- "Gradle could not start your build. Cannot create service of type
    BuildSessionActionExecutor", accessed March 26,
    2026, [https://intellij-support.jetbrains.com/hc/en-us/community/posts/25197295440658-Can-t-Run-Two-Gradle-Things-Simultaneously-Gradle-could-not-start-your-build-Cannot-create-service-of-type-BuildSessionActionExecutor](https://intellij-support.jetbrains.com/hc/en-us/community/posts/25197295440658-Can-t-Run-Two-Gradle-Things-Simultaneously-Gradle-could-not-start-your-build-Cannot-create-service-of-type-BuildSessionActionExecutor)
30. I'm struggling to develop a mobile application with Flutter. : r/CodingTR \- Reddit, accessed March 26,
    2026, [https://www.reddit.com/r/CodingTR/comments/1ixtevx/flutter_ile_mobil_uygulama_geli%C5%9Ftirmeye/?tl=en](https://www.reddit.com/r/CodingTR/comments/1ixtevx/flutter_ile_mobil_uygulama_geli%C5%9Ftirmeye/?tl=en)
31. Timeout waiting to lock journal cache. It is currently in use by another Gradle instance, accessed March 26,
    2026, [https://stackoverflow.com/questions/75671382/timeout-waiting-to-lock-journal-cache-it-is-currently-in-use-by-another-gradle](https://stackoverflow.com/questions/75671382/timeout-waiting-to-lock-journal-cache-it-is-currently-in-use-by-another-gradle)
32. Timeout waiting to lock journal cache with gradle? \- Stack Overflow, accessed March 26,
    2026, [https://stackoverflow.com/questions/72393855/timeout-waiting-to-lock-journal-cache-with-gradle](https://stackoverflow.com/questions/72393855/timeout-waiting-to-lock-journal-cache-with-gradle)
33. Gradle Config Cache Reuse on CI \- Jason Pearson, accessed March 26,
    2026, [https://www.jasonpearson.dev/gradle-config-cache-reuse-on-ci/](https://www.jasonpearson.dev/gradle-config-cache-reuse-on-ci/)
34. actions/docs/setup-gradle.md at main \- GitHub, accessed March 26,
    2026, [https://github.com/gradle/actions/blob/main/docs/setup-gradle.md](https://github.com/gradle/actions/blob/main/docs/setup-gradle.md)
35. CVE-2023-30853 Detail \- NVD, accessed March 26,
    2026, [https://nvd.nist.gov/vuln/detail/CVE-2023-30853](https://nvd.nist.gov/vuln/detail/CVE-2023-30853)
36. Gradle BuildJet Action \- GitHub Marketplace, accessed March 26,
    2026, [https://github.com/marketplace/actions/gradle-buildjet-action](https://github.com/marketplace/actions/gradle-buildjet-action)
37. Follow the Freedesktop XDG base directory standard (in Linux) · Issue \#8262 \- GitHub, accessed March 26,
    2026, [https://github.com/gradle/gradle/issues/8262](https://github.com/gradle/gradle/issues/8262)
