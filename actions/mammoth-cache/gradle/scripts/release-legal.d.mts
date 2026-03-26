/*
 * Copyright 2026 The Apache Software Foundation
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

export interface ReleaseLegalIssue {
  code: string;
  detail: string;
  packageId: string;
}

export interface ReleaseLegalPackageInfo {
  attributionText: string;
  copyright: string;
  issues: ReleaseLegalIssue[];
  licenseExpression: string;
  licenseReference: string;
  noticeTexts: string[];
  packageId: string;
  projectHomePage: string;
  specialHandlingText: string;
}

export interface ReleaseLegalSection {
  attributionText: string;
  copyright: string;
  licenseReference: string;
  packageIds: string[];
  projectHomePage: string;
  specialHandlingText?: string;
}

export function appendBundledSections(baseText: string, sections: string[]): string;
export function collectPackageInfo(packageRoot: string): Promise<ReleaseLegalPackageInfo>;
export function detectCategoryXReason(licenseExpression: string): string;
export function normalizeProjectUrl(value: unknown): string;
export function parseMode(argv: string[]): 'check' | 'check-category-x' | 'write';
export function renderLicenseReference(licenseExpression: string): string;
export function renderLicenseSection(group: ReleaseLegalSection): string;
