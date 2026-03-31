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

"""Integration tests that stage a fixture workspace through the Python API."""

from __future__ import annotations

import os
import shutil
import unittest
from pathlib import Path

import yaml

import apache_buildish_site_pipeline as site_pipeline

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

            first_results = site_pipeline.build(repo_root)
            second_results = site_pipeline.build(repo_root)

            self.assertEqual(3, len(first_results))
            self.assertEqual(3, len(second_results))

            self.assert_paths_exist(
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "mammoth-cache"
                / "development"
                / "docs"
                / "getting-started.md",
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "mammoth-cache"
                / "_index.md",
                repo_root
                / "site"
                / ".stage"
                / "static"
                / "components"
                / "mammoth-cache"
                / "development"
                / "assets"
                / "images"
                / "diagram.svg",
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "no-gradle-wrapper-jar"
                / "development"
                / "docs"
                / "_index.md",
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "site"
                / "development"
                / "docs"
                / "_index.md",
                repo_root / "site" / ".preview" / "index.html",
            )

            components_data = self.load_yaml(
                repo_root / "site" / ".stage" / "data" / "components.yaml"
            )
            self.assertEqual(
                "Fixture Mammoth Cache for Gradle® and Apache Maven™",
                components_data["components"]["mammoth-cache"]["displayName"],
            )
            self.assertEqual(
                "buildish-no-gradle-wrapper-jar",
                components_data["components"]["no-gradle-wrapper-jar"]["localDir"],
            )
            self.assertEqual(
                "Site", components_data["components"]["site"]["displayName"]
            )
            self.assertEqual(
                "/components/site/",
                components_data["components"]["site"]["componentPath"],
            )
            self.assertEqual(
                "/components/site/development/docs/",
                components_data["components"]["site"]["docsPath"],
            )
            self.assertEqual(0, components_data["components"]["site"]["assetCount"])
            self.assertEqual(
                "Fixture component landing page.",
                components_data["components"]["mammoth-cache"]["summary"],
            )

            lifecycle_data = self.load_yaml(
                repo_root / "site" / ".stage" / "data" / "lifecycle.yaml"
            )
            self.assertEqual(
                "v1.2.3", lifecycle_data["components"]["mammoth-cache"]["latestStable"]
            )
            self.assertEqual(
                "maintained",
                lifecycle_data["components"]["mammoth-cache"]["releaseLines"][0][
                    "status"
                ],
            )

            site_development_index = self.read_text(
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "site"
                / "development"
                / "_index.md"
            )
            self.assert_contains_all(site_development_index, "## Docs")
            self.assert_not_contains_any(site_development_index, "Open staged assets")
            site_development_front_matter = yaml.safe_load(
                site_development_index.split("---", 2)[1]
            )
            self.assertEqual(
                "Site",
                site_development_front_matter["sitePipelineComponent"]["displayName"],
            )
            self.assertEqual(
                "development-home",
                site_development_front_matter["sitePipelineComponentPage"]["kind"],
            )

            preview_index = self.read_text(
                repo_root / "site" / ".preview" / "index.html"
            )
            self.assert_contains_all(
                preview_index,
                "Fixture Mammoth Cache for Gradle® and Apache Maven™",
                "Fixture no-gradle-wrapper-jar",
                "Site",
            )
        finally:
            shutil.rmtree(FIXTURE_BUILD_ROOT, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
