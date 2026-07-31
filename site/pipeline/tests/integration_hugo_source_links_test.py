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

"""Hugo integration tests for Buildish source and edit page metadata links."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from textwrap import dedent


SOURCE_REPO_ROOT = Path(__file__).resolve().parents[3]
PARTIALS_ROOT = SOURCE_REPO_ROOT / "site" / "layouts" / "partials"
HUGO = shutil.which("hugo")


def write_text(root: Path, relative_path: str, content: str) -> None:
    """Write one dedented UTF-8 fixture file."""

    path = root / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(dedent(content).lstrip("\n"), encoding="utf-8")


@unittest.skipUnless(HUGO, "Hugo is required for template integration tests")
class HugoSourceLinksIntegrationTest(unittest.TestCase):
    """Render representative provenance states through the real Hugo templates."""

    def test_source_links_use_provenance_and_fail_closed(self) -> None:
        temp_root = SOURCE_REPO_ROOT / "site" / "build" / "tests"
        temp_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temp_root) as temp_dir:
            fixture_root = Path(temp_dir)
            write_text(
                fixture_root,
                "hugo.yaml",
                """
                baseURL: https://example.test/
                params:
                  github_repo: https://github.com/buildish-tooling/buildish
                  github_project_repo: https://github.com/buildish-tooling/buildish
                  github_branch: main
                  github_subdir: site
                module:
                  mounts:
                    - source: content
                      target: content
                    - source: .stage/content
                      target: content
                    - source: layouts
                      target: layouts
                    - source: assets
                      target: assets
                """,
            )
            write_text(
                fixture_root,
                "layouts/_default/single.html",
                '{{ partial "page-meta-links.html" . }}\n',
            )
            for partial_name in (
                "buildish-page-source-context.html",
                "buildish-url-path-escape.html",
                "page-meta-links.html",
            ):
                partial_target = fixture_root / "layouts" / "partials" / partial_name
                partial_target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(PARTIALS_ROOT / partial_name, partial_target)
            write_text(
                fixture_root, "assets/stubs/new-page-template.md", "# New page\n"
            )
            write_text(
                fixture_root,
                "i18n/en.toml",
                """
                [post_view_this]
                other = "View source"
                [post_edit_this]
                other = "Edit source"
                [post_create_child_page]
                other = "Create child page"
                [post_create_issue]
                other = "Create issue"
                [post_create_project_issue]
                other = "Create project issue"
                [print_entire_section]
                other = "Print entire section"
                """,
            )
            write_text(fixture_root, "content/native.md", "# Native\n")
            write_text(
                fixture_root,
                "content/pipeline.md",
                """
                ---
                title: Pipeline
                pipeline:
                  page:
                    source:
                      key: site-pipeline
                      path: site/pages/guide.md
                      repository: https://github.com/buildish-tooling/buildish-site-pipeline
                      viewRef: main
                      editRef: main
                ---
                """,
            )
            write_text(
                fixture_root,
                "content/released.md",
                """
                ---
                title: Released
                pipeline:
                  page:
                    source:
                      key: site-pipeline
                      path: docs/guide.md
                      repository: https://github.com/buildish-tooling/buildish-site-pipeline
                      viewRef: v1.2.3
                ---
                """,
            )
            write_text(
                fixture_root,
                "content/partial.md",
                """
                ---
                title: Partial
                pipeline:
                  page:
                    source:
                      key: site-pipeline
                      path: site/pages/partial.md
                ---
                """,
            )
            write_text(
                fixture_root,
                "content/escaped.md",
                """
                ---
                title: Escaped
                pipeline:
                  page:
                    source:
                      key: site-pipeline
                      path: site/pages/a%2Fb#c?.md
                      repository: https://github.com/buildish-tooling/buildish-site-pipeline
                      viewRef: feature/docs
                      editRef: feature/docs
                ---
                """,
            )
            write_text(
                fixture_root,
                "content/unsupported.md",
                """
                ---
                title: Unsupported
                pipeline:
                  page:
                    source:
                      key: other-forge
                      path: docs/guide.md
                      repository: https://gitlab.com/example/docs
                      viewRef: main
                      editRef: main
                ---
                """,
            )
            write_text(
                fixture_root,
                ".stage/content/generated.md",
                """
                ---
                title: Generated
                pipeline:
                  page:
                    kind: generated
                ---
                """,
            )
            self.assertIsNotNone(HUGO)
            result = subprocess.run(  # noqa: S603 - fixed local Hugo executable and fixture arguments
                [
                    HUGO,
                    "--source",
                    str(fixture_root),
                    "--config",
                    "hugo.yaml",
                    "--destination",
                    str(fixture_root / "public"),
                    "--noBuildLock",
                ],
                cwd=fixture_root,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)

            native_html = (fixture_root / "public/native/index.html").read_text(
                encoding="utf-8"
            )
            self.assertIn(
                "https://github.com/buildish-tooling/buildish/blob/main/site/content/native.md",
                native_html,
            )
            self.assertIn(
                "https://github.com/buildish-tooling/buildish/edit/main/site/content/native.md",
                native_html,
            )

            pipeline_html = (fixture_root / "public/pipeline/index.html").read_text(
                encoding="utf-8"
            )
            self.assertIn(
                "https://github.com/buildish-tooling/buildish-site-pipeline/blob/main/site/pages/guide.md",
                pipeline_html,
            )
            self.assertIn(
                "https://github.com/buildish-tooling/buildish-site-pipeline/edit/main/site/pages/guide.md",
                pipeline_html,
            )
            self.assertIn(
                "https://github.com/buildish-tooling/buildish/issues/new", pipeline_html
            )

            released_html = (fixture_root / "public/released/index.html").read_text(
                encoding="utf-8"
            )
            self.assertIn(
                "https://github.com/buildish-tooling/buildish-site-pipeline/blob/v1.2.3/docs/guide.md",
                released_html,
            )
            self.assertNotIn("td-page-meta__edit", released_html)
            self.assertNotIn("td-page-meta__child", released_html)

            partial_html = (fixture_root / "public/partial/index.html").read_text(
                encoding="utf-8"
            )
            self.assertNotIn("td-page-meta__view", partial_html)
            self.assertNotIn("td-page-meta__edit", partial_html)
            self.assertNotIn("td-page-meta__child", partial_html)

            escaped_html = (fixture_root / "public/escaped/index.html").read_text(
                encoding="utf-8"
            )
            self.assertIn(
                "https://github.com/buildish-tooling/buildish-site-pipeline/"
                "blob/feature/docs/site/pages/a%252Fb%23c%3F.md",
                escaped_html,
            )
            self.assertNotIn("a%2Fb#c?.md", escaped_html)

            unsupported_html = (
                fixture_root / "public/unsupported/index.html"
            ).read_text(encoding="utf-8")
            self.assertNotIn("gitlab.com", unsupported_html)
            self.assertNotIn("td-page-meta__view", unsupported_html)
            self.assertNotIn("td-page-meta__edit", unsupported_html)
            self.assertNotIn("td-page-meta__child", unsupported_html)

            generated_html = (fixture_root / "public/generated/index.html").read_text(
                encoding="utf-8"
            )
            self.assertNotIn("td-page-meta__view", generated_html)
            self.assertNotIn("td-page-meta__edit", generated_html)
            self.assertNotIn("td-page-meta__child", generated_html)
            self.assertNotIn(".stage/content", generated_html)


if __name__ == "__main__":
    unittest.main()
