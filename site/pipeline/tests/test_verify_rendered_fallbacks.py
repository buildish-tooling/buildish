# Copyright 2026 The Apache Software Foundation
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Tests for the rendered-site fallback verification helper."""

from __future__ import annotations

import runpy
import tempfile
import unittest
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "verify_rendered_fallbacks.py"
SCRIPT_GLOBALS = runpy.run_path(str(SCRIPT_PATH))
RenderExpectation = SCRIPT_GLOBALS["RenderExpectation"]
check_rendered_file = SCRIPT_GLOBALS["check_rendered_file"]
check_rendered_site = SCRIPT_GLOBALS["check_rendered_site"]


class VerifyRenderedFallbacksTest(unittest.TestCase):
    def test_default_checks_accept_expected_resolved_output(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            public_root = Path(temp_dir)
            metadata_page = public_root / "components" / "site-pipeline" / "architecture" / "build-architecture" / "index.html"
            metadata_page.parent.mkdir(parents=True, exist_ok=True)
            metadata_page.write_text(
                "\n".join(
                    (
                        '<meta property="og:title" content="Recommended staging-engine implementation architecture">',
                        '<meta property="og:description" content="This document describes the recommended internal architecture for the staging engine and watch loop.">',
                        '<meta itemprop="name" content="Recommended staging-engine implementation architecture">',
                        '<meta itemprop="description" content="This document describes the recommended internal architecture for the staging engine and watch loop.">',
                        '<meta name="twitter:title" content="Recommended staging-engine implementation architecture">',
                        '<meta name="twitter:description" content="This document describes the recommended internal architecture for the staging engine and watch loop.">',
                    )
                )
                + "\n",
                encoding="utf-8",
            )
            listing_page = public_root / "components" / "site-pipeline" / "architecture" / "index.html"
            listing_page.parent.mkdir(parents=True, exist_ok=True)
            listing_page.write_text(
                "\n".join(
                    (
                        '<div class="entry">',
                        '<h5><a href="/components/site-pipeline/architecture/build-architecture/">Recommended staging-engine implementation architecture</a></h5>',
                        '<p>This document describes the recommended internal architecture for the staging engine and watch loop.</p>',
                        '</div>',
                    )
                )
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual([], check_rendered_site(public_root))

    def test_reports_blank_listing_entries(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            public_root = Path(temp_dir)
            listing_page = public_root / "components" / "site-pipeline" / "architecture" / "index.html"
            listing_page.parent.mkdir(parents=True, exist_ok=True)
            listing_page.write_text(
                '<div class="entry"><h5><a href="/components/site-pipeline/architecture/build-architecture/"></a></h5><p></p></div>\n',
                encoding="utf-8",
            )
            errors = check_rendered_file(
                public_root,
                RenderExpectation(
                    relative_path="components/site-pipeline/architecture/index.html",
                    forbidden_patterns=(r"<h5>\s*<a [^>]*>\s*</a>", r"<p>\s*</p>"),
                ),
            )

            self.assertEqual(2, len(errors))
            self.assertIn("<h5>\\s*<a [^>]*>\\s*</a>", errors[0])
            self.assertIn("<p>\\s*</p>", errors[1])

    def test_reports_missing_rendered_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            public_root = Path(temp_dir)
            errors = check_rendered_file(public_root, RenderExpectation(relative_path="missing/index.html"))

            self.assertEqual([f"Missing rendered file: {public_root / 'missing' / 'index.html'}"], errors)


if __name__ == "__main__":
    unittest.main()