/*
 * Copyright 2026 The Project Nessie Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * A wrapper properties file that has passed the point-4 static validation checks.
 */
export interface ValidatedWrapperPropertiesFile {
  /** Repository-relative path to the validated `gradle-wrapper.properties` file. */
  readonly relativePath: string;
  /** Absolute filesystem path to the validated `gradle-wrapper.properties` file. */
  readonly absolutePath: string;
  /** Repository-relative directory containing the wrapper properties file and wrapper JAR. */
  readonly wrapperDirectoryRelativePath: string;
  /** Repository-relative target path for the colocated `gradle-wrapper.jar`. */
  readonly wrapperJarRelativePath: string;
  /**
   * Parsed wrapper properties key/value map.
   *
   * Keys and values are non-empty strings after parsing and validation.
   */
  readonly properties: Readonly<Record<string, string>>;
  /**
   * Validated `distributionUrl` from the wrapper properties file.
   *
   * Must use the supported Gradle distribution host/path conventions enforced by validation.
   */
  readonly distributionUrl: string;
  /**
   * Validated `distributionSha256Sum` from the wrapper properties file.
   *
   * Must be a 64-character hexadecimal SHA-256 string.
   */
  readonly distributionSha256Sum: string;
}

/**
 * Derived remote metadata needed to provision a trusted Gradle wrapper JAR.
 */
export interface WrapperDownloadPlan {
  /** Repository-relative path to the wrapper properties file this plan was derived from. */
  readonly relativePath: string;
  /** Gradle distribution version parsed from `distributionUrl`, such as `8.12.1`. */
  readonly distributionVersion: string;
  /**
   * Normalized Gradle version metadata derived from `distributionUrl`.
   *
   * This may differ from `distributionVersion` when the distribution version omits a trailing
   * patch segment, such as `8.14` becoming `8.14.0`.
   */
  readonly wrapperSourceVersion: string;
  /** Absolute HTTPS URL for the authoritative wrapper JAR checksum file. */
  readonly wrapperChecksumUrl: string;
  /** Absolute HTTPS URL for the authoritative wrapper JAR download. */
  readonly wrapperJarUrl: string;
}

/**
 * A wrapper JAR that has been verified and is ready beside its wrapper properties file.
 */
export interface ProvisionedWrapperJar extends WrapperDownloadPlan {
  /** Repository-relative target path for the trusted wrapper JAR. */
  readonly wrapperJarRelativePath: string;
  /** Absolute filesystem path where the trusted wrapper JAR now resides. */
  readonly wrapperJarAbsolutePath: string;
  /** Expected SHA-256 checksum fetched for the trusted wrapper JAR. */
  readonly expectedWrapperJarSha256: string;
  /**
   * Whether bootstrap had to download and replace/write the JAR during this run.
   *
   * `false` means an existing local JAR already matched the expected checksum.
   */
  readonly wasDownloaded: boolean;
}
