#!/usr/bin/env python3
#
# Copyright 2026 The Buildish Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Verify rendered fallback metadata and docs listing output in ``site/.public``."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import NamedTuple


class RenderExpectation(NamedTuple):
    """Describe one rendered file and the snippets or patterns it must satisfy."""

    relative_path: str
    required_snippets: tuple[str, ...] = ()
    required_patterns: tuple[str, ...] = ()
    forbidden_patterns: tuple[str, ...] = ()


DEFAULT_EXPECTATIONS = (
    RenderExpectation(
        relative_path="about/index.html",
        required_snippets=(
            'href="https://github.com/buildish-tooling/buildish/blob/main/site/content/about.md"',
            'href="https://github.com/buildish-tooling/buildish/edit/main/site/content/about.md"',
        ),
    ),
    RenderExpectation(
        relative_path="components/site-pipeline/index.html",
        required_snippets=(
            '<body class="td-section buildish-docs-landing-page buildish-component-landing-page">',
        ),
        forbidden_patterns=(r'<aside class="col-12 col-md-3 col-xl-2 td-sidebar d-print-none">',),
    ),
    RenderExpectation(
        relative_path="components/site-pipeline/how-to/integrate-with-hugo/index.html",
        required_snippets=(
            '<aside class="col-12 col-md-3 col-xl-2 td-sidebar d-print-none">',
        ),
        forbidden_patterns=(r'buildish-component-landing-page',),
    ),
    RenderExpectation(
        relative_path="components/site-pipeline/how-to/use-json-schema-for-yaml-authoring/index.html",
        required_snippets=(
            'href="https://github.com/buildish-tooling/buildish-site-pipeline/blob/main/site/pages/how-to/use-json-schema-for-yaml-authoring.md"',
            'href="https://github.com/buildish-tooling/buildish-site-pipeline/edit/main/site/pages/how-to/use-json-schema-for-yaml-authoring.md"',
        ),
    ),
    RenderExpectation(
        relative_path="components/site-pipeline/architecture/build-architecture/index.html",
        required_patterns=(
            r'<meta property="og:title" content="\s*Recommended staging-engine implementation architecture">',
            r'<meta property="og:description" content="\s*This document describes the recommended internal architecture for the staging engine and watch loop\.\s*">',
            r'<meta itemprop="name" content="\s*Recommended staging-engine implementation architecture">',
            r'<meta itemprop="description" content="\s*This document describes the recommended internal architecture for the staging engine and watch loop\.\s*">',
            r'<meta name="twitter:title" content="\s*Recommended staging-engine implementation architecture">',
            r'<meta name="twitter:description" content="\s*This document describes the recommended internal architecture for the staging engine and watch loop\.\s*">',
        ),
    ),
    RenderExpectation(
        relative_path="components/site-pipeline/architecture/index.html",
        required_snippets=(
            '<p>This document describes the recommended internal architecture for the staging engine and watch loop.</p>',
        ),
        required_patterns=(
            r'href="/components/site-pipeline/architecture/build-architecture/"[^>]*>\s*(?:<span[^>]*>\s*)?Recommended staging-engine implementation architecture',
        ),
        forbidden_patterns=(r"<h5>\s*<a [^>]*>\s*</a>", r"<p>\s*</p>"),
    ),
)

STAGED_SOURCE_LINK_PATTERN = re.compile(r'href=["\'][^"\']*\.stage/content')
THIRD_PARTY_LICENSE_ROOTS = (
    "@fortawesome/fontawesome-free",
    "bootstrap",
    "jquery",
    "lunr",
    "mermaid",
    "github.com/google/docsy/theme",
)


def check_rendered_file(public_root: Path, expectation: RenderExpectation) -> list[str]:
    """Validate one rendered HTML file against required snippets and forbidden regexes."""

    html_path = public_root / expectation.relative_path
    if not html_path.is_file():
        return [f"Missing rendered file: {html_path}"]
    rendered_html = html_path.read_text(encoding="utf-8")
    errors: list[str] = []
    for snippet in expectation.required_snippets:
        if snippet not in rendered_html:
            errors.append(f"Missing expected snippet in {html_path}: {snippet}")
    for pattern in expectation.required_patterns:
        if not re.search(pattern, rendered_html):
            errors.append(f"Missing expected pattern in {html_path}: {pattern}")
    for pattern in expectation.forbidden_patterns:
        if re.search(pattern, rendered_html):
            errors.append(f"Found forbidden pattern in {html_path}: {pattern}")
    return errors


def check_for_staged_source_links(public_root: Path) -> list[str]:
    """Reject repository links that expose Hugo's generated stage path."""

    errors: list[str] = []
    for html_path in sorted(public_root.rglob("*.html")):
        if STAGED_SOURCE_LINK_PATTERN.search(html_path.read_text(encoding="utf-8")):
            errors.append(f"Found staged source link in {html_path}")
    return errors


def check_third_party_license_inventory(public_root: Path) -> list[str]:
    """Require the generated legal payload for every directly distributed site dependency."""

    inventory_path = public_root / "third-party-licenses.txt"
    if not inventory_path.is_file():
        return [f"Missing third-party license inventory: {inventory_path}"]

    inventory = inventory_path.read_text(encoding="utf-8")
    errors: list[str] = []
    for package_name in THIRD_PARTY_LICENSE_ROOTS:
        pattern = rf"(?m)^{re.escape(package_name)}@\S+$"
        if not re.search(pattern, inventory):
            errors.append(
                f"Missing distributed dependency {package_name} in {inventory_path}"
            )
    return errors


def check_rendered_site(
    public_root: Path, expectations: tuple[RenderExpectation, ...] = DEFAULT_EXPECTATIONS
) -> list[str]:
    """Validate the curated fallback regression checks for the rendered site."""

    errors: list[str] = []
    for expectation in expectations:
        errors.extend(check_rendered_file(public_root, expectation))
    errors.extend(check_for_staged_source_links(public_root))
    errors.extend(check_third_party_license_inventory(public_root))
    return errors


def main(argv: list[str] | None = None) -> int:
    """Parse CLI arguments and verify the rendered site."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--public-root",
        default=str(Path(__file__).resolve().parents[1] / ".public"),
        help="Path to the rendered Hugo output directory. Default: %(default)s",
    )
    args = parser.parse_args(argv)

    errors = check_rendered_site(Path(args.public_root))
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print(f"Rendered fallback verification passed for {args.public_root}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
