#!/usr/bin/env python3
#
# Copyright 2026 The Apache Software Foundation
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
    forbidden_patterns: tuple[str, ...] = ()


DEFAULT_EXPECTATIONS = (
    RenderExpectation(
        relative_path="components/site-pipeline/architecture/build-architecture/index.html",
        required_snippets=(
            '<meta property="og:title" content="Recommended staging-engine implementation architecture">',
            '<meta property="og:description" content="This document describes the recommended internal architecture for the staging engine and watch loop.">',
            '<meta itemprop="name" content="Recommended staging-engine implementation architecture">',
            '<meta itemprop="description" content="This document describes the recommended internal architecture for the staging engine and watch loop.">',
            '<meta name="twitter:title" content="Recommended staging-engine implementation architecture">',
            '<meta name="twitter:description" content="This document describes the recommended internal architecture for the staging engine and watch loop.">',
        ),
    ),
    RenderExpectation(
        relative_path="components/site-pipeline/architecture/index.html",
        required_snippets=(
            'href="/components/site-pipeline/architecture/build-architecture/">Recommended staging-engine implementation architecture</a>',
            '<p>This document describes the recommended internal architecture for the staging engine and watch loop.</p>',
        ),
        forbidden_patterns=(r"<h5>\s*<a [^>]*>\s*</a>", r"<p>\s*</p>"),
    ),
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
    for pattern in expectation.forbidden_patterns:
        if re.search(pattern, rendered_html):
            errors.append(f"Found forbidden pattern in {html_path}: {pattern}")
    return errors


def check_rendered_site(
    public_root: Path, expectations: tuple[RenderExpectation, ...] = DEFAULT_EXPECTATIONS
) -> list[str]:
    """Validate the curated fallback regression checks for the rendered site."""

    errors: list[str] = []
    for expectation in expectations:
        errors.extend(check_rendered_file(public_root, expectation))
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