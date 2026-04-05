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

"""Integration tests that stage a fixture workspace through the CLI."""

from __future__ import annotations

import os
import shutil
import unittest
from pathlib import Path

import yaml

from test_support import (
    TestCaseHelpers,
    seed_api_fixture_main_repo,
    seed_mammoth_fixture,
    seed_no_wrapper_fixture,
    text_block,
)


SOURCE_REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_FIXTURE_BUILD_ROOT = (
    SOURCE_REPO_ROOT
    / "site"
    / "build"
    / "tests"
    / f"integration-fixture-workspace-{os.getpid()}"
)
FIXTURE_BUILD_ROOT = Path(
    os.environ.get("BUILDISH_SITE_FIXTURE_WORKSPACE", str(DEFAULT_FIXTURE_BUILD_ROOT))
)


class SiteFixtureIntegrationTest(TestCaseHelpers, unittest.TestCase):
    def seed_main_repo(self, repo_root: Path) -> None:
        seed_api_fixture_main_repo(repo_root)

    @staticmethod
    def seed_mammoth_fixture(repo_root: Path) -> None:
        seed_mammoth_fixture(
            repo_root,
            landing_page=text_block(
                """
                # Mammoth Cache for Gradle® and Apache Maven™

                Fixture component landing page.
                """
            ),
            docs_index=text_block(
                """
                # Overview
                """
            ),
            getting_started=text_block(
                """
                # Getting started
                """
            ),
        )

    @staticmethod
    def seed_no_wrapper_fixture(repo_root: Path) -> None:
        seed_no_wrapper_fixture(
            repo_root,
            landing_page=text_block(
                """
                # No Wrapper JAR

                Fixture component landing page.
                """
            ),
            docs_index=text_block(
                """
                # No Wrapper JAR

                Fixture docs overview.
                """
            ),
        )

    def test_build_from_fixture_workspace(self) -> None:
        shutil.rmtree(FIXTURE_BUILD_ROOT, ignore_errors=True)
        try:
            workspace = FIXTURE_BUILD_ROOT
            workspace.mkdir(parents=True, exist_ok=True)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            self.seed_main_repo(repo_root)

            self.seed_mammoth_fixture(workspace / "buildish-mammoth-cache")
            self.seed_no_wrapper_fixture(workspace / "buildish-no-gradle-wrapper-jar")

            first_result = self.run_pipeline_build(repo_root)
            second_result = self.run_pipeline_build(repo_root)

            self.assert_command_succeeded(first_result)
            self.assertIn("build clean: succeeded=yes", first_result.stdout)
            self.assertEqual(3, second_result.returncode, second_result.stdout + second_result.stderr)
            self.assertIn(
                "Stage root must be absent or empty",
                second_result.stdout + second_result.stderr,
            )

            stage_root = repo_root / "site" / ".stage"
            data_root = stage_root / "data"
            mammoth_component_root = stage_root / "content" / "components" / "mammoth-cache"
            no_wrapper_component_root = stage_root / "content" / "components" / "no-gradle-wrapper-jar"
            site_component_root = stage_root / "content" / "components" / "site"

            self.assert_paths_exist(
                stage_root / "manifest.json",
                data_root / "components.json",
                data_root / "content-index.json",
                data_root / "routes.json",
                mammoth_component_root / "pages" / "_index.md",
                no_wrapper_component_root / "pages" / "_index.md",
                site_component_root / "pages" / "_index.md",
                stage_root / "static" / "components" / "mammoth-cache" / "assets" / "images" / "diagram.svg",
            )
            self.assertFalse((repo_root / "site" / ".preview").exists())
            self.assertFalse((repo_root / "site" / ".public").exists())
            self.assertFalse((mammoth_component_root / "latest").exists())
            self.assertFalse((site_component_root / "latest").exists())

            manifest = self.load_json(stage_root / "manifest.json")
            self.assertEqual(1, manifest["schemaVersion"])

            component_items = self.load_json(data_root / "components.json")["items"]
            components = {item["slug"]: item for item in component_items}
            self.assertEqual(
                {"mammoth-cache", "no-gradle-wrapper-jar", "site"},
                set(components),
            )
            self.assertEqual(
                "/components/mammoth-cache/",
                components["mammoth-cache"]["publication"]["paths"]["component"],
            )
            self.assertEqual(
                "/components/mammoth-cache/latest/",
                components["mammoth-cache"]["publication"]["paths"]["docs"],
            )
            self.assertEqual(
                "/components/site/",
                components["site"]["publication"]["paths"]["component"],
            )
            self.assertEqual(
                "/components/site/latest/",
                components["site"]["publication"]["paths"]["docs"],
            )

            content_index = self.load_json(data_root / "content-index.json")["items"]
            content_paths = {
                (item["componentSlug"], item["pageKind"], item["path"])
                for item in content_index
            }
            self.assertTrue(
                {
                    ("mammoth-cache", "component-page", "/components/mammoth-cache/_index"),
                    ("no-gradle-wrapper-jar", "component-page", "/components/no-gradle-wrapper-jar/_index"),
                    ("site", "component-page", "/components/site/_index"),
                }.issubset(content_paths)
            )

            mammoth_page = self.read_text(mammoth_component_root / "pages" / "_index.md")
            site_page = self.read_text(site_component_root / "pages" / "_index.md")
            self.assertIn("Fixture component landing page.", mammoth_page)
            self.assertIn("# Buildish Site", site_page)
        finally:
            shutil.rmtree(FIXTURE_BUILD_ROOT, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
