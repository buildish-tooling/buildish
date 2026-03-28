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

from __future__ import annotations

import os
import shutil
import sys
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mvp


SOURCE_REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_FIXTURE_BUILD_ROOT = SOURCE_REPO_ROOT / "site" / "build" / "tests" / f"integration-fixture-workspace-{os.getpid()}"
FIXTURE_BUILD_ROOT = Path(os.environ.get("BUILDISH_SITE_FIXTURE_WORKSPACE", str(DEFAULT_FIXTURE_BUILD_ROOT)))


class SiteFixtureIntegrationTest(unittest.TestCase):
    def seed_main_repo(self, repo_root: Path) -> None:
        (repo_root / "site").mkdir(parents=True, exist_ok=True)
        shutil.copytree(SOURCE_REPO_ROOT / "site" / "content", repo_root / "site" / "content", dirs_exist_ok=True)
        shutil.copytree(SOURCE_REPO_ROOT / "docs", repo_root / "docs", dirs_exist_ok=True)
        shutil.copy2(SOURCE_REPO_ROOT / "DISCLAIMER", repo_root / "DISCLAIMER")
        shutil.copy2(SOURCE_REPO_ROOT / "site" / "project.yaml", repo_root / "site" / "project.yaml")

        catalog = yaml.safe_load((SOURCE_REPO_ROOT / "site" / "projects.yaml").read_text(encoding="utf-8"))
        catalog["projects"] = [
            {"slug": "mammoth-cache-gradle", "localDir": "buildish-mammoth-cache-gradle"},
            {"slug": "no-gradle-wrapper-jar", "localDir": "buildish-no-gradle-wrapper-jar", "weight": 5},
            {"slug": "site", "localDir": "buildish", "weight": 100},
        ]
        with (repo_root / "site" / "projects.yaml").open("w", encoding="utf-8") as handle:
            yaml.safe_dump(catalog, handle, sort_keys=False, default_flow_style=False)

    @staticmethod
    def seed_mammoth_fixture(repo_root: Path) -> None:
        (repo_root / "site" / "docs").mkdir(parents=True)
        (repo_root / "site" / "assets" / "images").mkdir(parents=True)
        (repo_root / "README.md").write_text("# Mammoth Cache for Gradle\n\nFixture project summary.\n", encoding="utf-8")
        with (repo_root / "site" / "project.yaml").open("w", encoding="utf-8") as handle:
            yaml.safe_dump(
                {
                    "schemaVersion": 1,
                    "project": {
                        "slug": "mammoth-cache-gradle",
                        "displayName": "Fixture Mammoth Cache for Gradle",
                        "repository": "https://github.com/apache/buildish-mammoth-cache-gradle",
                        "defaultBranch": "main",
                    },
                    "lifecycle": {
                        "latestStable": "v1.2.3",
                        "releaseLines": [{"line": "v1", "latest": "v1.2.3", "status": "maintained", "aliases": ["v1"]}],
                    },
                },
                handle,
                sort_keys=False,
                default_flow_style=False,
            )
        (repo_root / "site" / "docs" / "_index.md").write_text("# Overview\n", encoding="utf-8")
        (repo_root / "site" / "docs" / "getting-started.md").write_text("# Getting started\n", encoding="utf-8")
        (repo_root / "site" / "assets" / "images" / "diagram.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'></svg>\n", encoding="utf-8")

    @staticmethod
    def seed_no_wrapper_fixture(repo_root: Path) -> None:
        (repo_root / "site").mkdir(parents=True)
        (repo_root / "site" / "docs").mkdir(parents=True)
        with (repo_root / "site" / "project.yaml").open("w", encoding="utf-8") as handle:
            yaml.safe_dump(
                {
                    "schemaVersion": 1,
                    "project": {"slug": "no-gradle-wrapper-jar", "displayName": "Fixture no-gradle-wrapper-jar"},
                    "content": {"docsRoot": "site/docs"},
                },
                handle,
                sort_keys=False,
                default_flow_style=False,
            )
        (repo_root / "site" / "docs" / "_index.md").write_text("# No Wrapper JAR\n\nFixture docs overview.\n", encoding="utf-8")

    def test_build_from_fixture_workspace(self) -> None:
        shutil.rmtree(FIXTURE_BUILD_ROOT, ignore_errors=True)
        try:
            workspace = FIXTURE_BUILD_ROOT
            workspace.mkdir(parents=True, exist_ok=True)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            self.seed_main_repo(repo_root)

            self.seed_mammoth_fixture(workspace / "buildish-mammoth-cache-gradle")
            self.seed_no_wrapper_fixture(workspace / "buildish-no-gradle-wrapper-jar")

            first_results = mvp.build(repo_root)
            second_results = mvp.build(repo_root)

            self.assertEqual(3, len(first_results))
            self.assertEqual(3, len(second_results))

            self.assertTrue((repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "unreleased" / "docs" / "getting-started.md").exists())
            self.assertTrue((repo_root / "site" / ".stage" / "static" / "projects" / "mammoth-cache-gradle" / "unreleased" / "assets" / "images" / "diagram.svg").exists())
            self.assertTrue((repo_root / "site" / ".stage" / "content" / "projects" / "no-gradle-wrapper-jar" / "unreleased" / "docs" / "_index.md").exists())
            self.assertTrue((repo_root / "site" / ".stage" / "content" / "projects" / "site" / "unreleased" / "docs" / "_index.md").exists())
            self.assertTrue((repo_root / "site" / ".preview" / "index.html").exists())

            projects_data = yaml.safe_load((repo_root / "site" / ".stage" / "data" / "projects.yaml").read_text(encoding="utf-8"))
            self.assertEqual("Fixture Mammoth Cache for Gradle", projects_data["projects"]["mammoth-cache-gradle"]["displayName"])
            self.assertEqual("buildish-no-gradle-wrapper-jar", projects_data["projects"]["no-gradle-wrapper-jar"]["localDir"])
            self.assertEqual("Apache Buildish Site", projects_data["projects"]["site"]["displayName"])
            self.assertEqual(0, projects_data["projects"]["site"]["assetCount"])

            lifecycle_data = yaml.safe_load((repo_root / "site" / ".stage" / "data" / "lifecycle.yaml").read_text(encoding="utf-8"))
            self.assertEqual("v1.2.3", lifecycle_data["projects"]["mammoth-cache-gradle"]["latestStable"])
            self.assertEqual("maintained", lifecycle_data["projects"]["mammoth-cache-gradle"]["releaseLines"][0]["status"])

            site_unreleased_index = (repo_root / "site" / ".stage" / "content" / "projects" / "site" / "unreleased" / "_index.md").read_text(encoding="utf-8")
            self.assertIn("## Docs", site_unreleased_index)
            self.assertNotIn("Open staged assets", site_unreleased_index)

            preview_index = (repo_root / "site" / ".preview" / "index.html").read_text(encoding="utf-8")
            self.assertIn("Fixture Mammoth Cache for Gradle", preview_index)
            self.assertIn("Fixture no-gradle-wrapper-jar", preview_index)
            self.assertIn("Apache Buildish Site", preview_index)
        finally:
            shutil.rmtree(FIXTURE_BUILD_ROOT, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()