# Copyright 2026 The Buildish Authors
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
check_for_staged_source_links = SCRIPT_GLOBALS["check_for_staged_source_links"]
check_third_party_license_inventory = SCRIPT_GLOBALS[
    "check_third_party_license_inventory"
]


class VerifyRenderedFallbacksTest(unittest.TestCase):
    def test_default_checks_accept_expected_resolved_output(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            public_root = Path(temp_dir)
            about_page = public_root / "about" / "index.html"
            about_page.parent.mkdir(parents=True, exist_ok=True)
            about_page.write_text(
                "\n".join(
                    (
                        '<a href="https://github.com/buildish-tooling/buildish/blob/main/site/content/about.md">View source</a>',
                        '<a href="https://github.com/buildish-tooling/buildish/edit/main/site/content/about.md">Edit source</a>',
                    )
                )
                + "\n",
                encoding="utf-8",
            )
            component_root_page = public_root / "components" / "site-pipeline" / "index.html"
            component_root_page.parent.mkdir(parents=True, exist_ok=True)
            component_root_page.write_text(
                '<body class="td-section buildish-docs-landing-page buildish-component-landing-page"></body>\n',
                encoding="utf-8",
            )
            nested_docs_page = public_root / "components" / "site-pipeline" / "how-to" / "integrate-with-hugo" / "index.html"
            nested_docs_page.parent.mkdir(parents=True, exist_ok=True)
            nested_docs_page.write_text(
                '<aside class="col-12 col-md-3 col-xl-2 td-sidebar d-print-none"></aside>\n',
                encoding="utf-8",
            )
            schema_guide = (
                public_root
                / "components"
                / "site-pipeline"
                / "how-to"
                / "use-json-schema-for-yaml-authoring"
                / "index.html"
            )
            schema_guide.parent.mkdir(parents=True, exist_ok=True)
            schema_guide.write_text(
                "\n".join(
                    (
                        '<a href="https://github.com/buildish-tooling/buildish-site-pipeline/blob/main/site/pages/how-to/use-json-schema-for-yaml-authoring.md">View source</a>',
                        '<a href="https://github.com/buildish-tooling/buildish-site-pipeline/edit/main/site/pages/how-to/use-json-schema-for-yaml-authoring.md">Edit source</a>',
                    )
                )
                + "\n",
                encoding="utf-8",
            )
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
            (public_root / "third-party-licenses.txt").write_text(
                "\n".join(
                    (
                        "@fortawesome/fontawesome-free@7.3.1",
                        "bootstrap@5.3.8",
                        "jquery@4.0.0",
                        "lunr@2.3.9",
                        "mermaid@11.16.0",
                        "github.com/google/docsy/theme@v0.16.0",
                    )
                )
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual([], check_rendered_site(public_root))

    def test_reports_repository_link_to_staged_content(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            public_root = Path(temp_dir)
            rendered_page = public_root / "components" / "example" / "index.html"
            rendered_page.parent.mkdir(parents=True, exist_ok=True)
            rendered_page.write_text(
                '<a href="https://github.com/buildish-tooling/buildish/edit/main/.stage/content/components/example/_index.md">Edit</a>\n',
                encoding="utf-8",
            )

            errors = check_for_staged_source_links(public_root)

            self.assertEqual([f"Found staged source link in {rendered_page}"], errors)

    def test_ignores_stage_path_mentioned_as_page_content(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            public_root = Path(temp_dir)
            rendered_page = public_root / "guide" / "index.html"
            rendered_page.parent.mkdir(parents=True, exist_ok=True)
            rendered_page.write_text(
                "<p>Hugo reads generated pages from <code>.stage/content</code>.</p>\n",
                encoding="utf-8",
            )

            self.assertEqual([], check_for_staged_source_links(public_root))

    def test_reports_component_root_with_docs_sidebar(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            public_root = Path(temp_dir)
            component_root_page = public_root / "components" / "site-pipeline" / "index.html"
            component_root_page.parent.mkdir(parents=True, exist_ok=True)
            component_root_page.write_text(
                '<body class="td-section"></body>\n<aside class="col-12 col-md-3 col-xl-2 td-sidebar d-print-none"></aside>\n',
                encoding="utf-8",
            )
            errors = check_rendered_file(
                public_root,
                RenderExpectation(
                    relative_path="components/site-pipeline/index.html",
                    required_snippets=(
                        '<body class="td-section buildish-docs-landing-page buildish-component-landing-page">',
                    ),
                    forbidden_patterns=(r'<aside class="col-12 col-md-3 col-xl-2 td-sidebar d-print-none">',),
                ),
            )

            self.assertEqual(2, len(errors))
            self.assertIn('buildish-component-landing-page', errors[0])
            self.assertIn('td-sidebar d-print-none', errors[1])

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

    def test_reports_missing_third_party_license_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            public_root = Path(temp_dir)

            self.assertEqual(
                [
                    "Missing third-party license inventory: "
                    f"{public_root / 'third-party-licenses.txt'}"
                ],
                check_third_party_license_inventory(public_root),
            )

    def test_reports_missing_direct_distributed_dependency_license(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            public_root = Path(temp_dir)
            inventory_path = public_root / "third-party-licenses.txt"
            inventory_path.write_text(
                "\n".join(
                    (
                        "@fortawesome/fontawesome-free@7.3.1",
                        "bootstrap@5.3.8",
                        "jquery@4.0.0",
                        "lunr@2.3.9",
                        "github.com/google/docsy/theme@v0.16.0",
                    )
                )
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual(
                [f"Missing distributed dependency mermaid in {inventory_path}"],
                check_third_party_license_inventory(public_root),
            )


if __name__ == "__main__":
    unittest.main()
