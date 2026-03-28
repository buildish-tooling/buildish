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

import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mvp


class SiteMvpTest(unittest.TestCase):
    def test_build_stages_docs_and_lifecycle_from_project_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site").mkdir()
            catalog = {
                "schemaVersion": 1,
                "defaults": {
                    "metadataFile": "site/project.yaml",
                    "readmePath": "README.md",
                    "docsRoot": "site/docs",
                    "assetsRoot": "site/assets",
                    "unreleasedLabel": "Unreleased",
                    "tagPattern": r"^v[0-9]+\.[0-9]+\.[0-9]+$",
                    "navigationSection": "sub-projects",
                },
                "projects": [
                    {"slug": "mammoth-cache-gradle", "localDir": "buildish-mammoth-cache-gradle"},
                    {"slug": "no-gradle-wrapper-jar", "localDir": "buildish-no-gradle-wrapper-jar", "weight": 5},
                ],
            }
            with (repo_root / "site" / "projects.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump(catalog, handle, sort_keys=False, default_flow_style=False)

            mammoth = workspace / "buildish-mammoth-cache-gradle"
            (mammoth / "site").mkdir(parents=True)
            (mammoth / "site" / "docs").mkdir(parents=True)
            (mammoth / "site" / "assets" / "images").mkdir(parents=True)
            (mammoth / "README.md").write_text(
                "# Apache Buildish Mammoth Cache for Gradle\n\nSecure Gradle wrapper provisioning.\n",
                encoding="utf-8",
            )
            with (mammoth / "site" / "project.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump(
                    {
                        "schemaVersion": 1,
                        "project": {
                            "slug": "mammoth-cache-gradle",
                            "displayName": "Apache Buildish Mammoth Cache for Gradle",
                            "repository": "https://github.com/apache/buildish-mammoth-cache-gradle",
                            "defaultBranch": "trunk",
                        },
                        "content": {"readmePath": "README.md", "docsRoot": "site/docs", "assetsRoot": "site/assets"},
                        "versioning": {"unreleasedLabel": "Preview"},
                        "lifecycle": {
                            "latestStable": "v1.3.5",
                            "releaseLines": [
                                {"line": "v1", "latest": "v1.3.5", "status": "maintained", "aliases": ["v1"]},
                                {"line": "v1.2", "latest": "v1.2.9", "status": "eol", "aliases": ["v1.2"]},
                            ],
                        },
                        "navigation": {"section": "sub-projects"},
                    },
                    handle,
                    sort_keys=False,
                    default_flow_style=False,
                )
            (mammoth / "site" / "docs" / "wrapper-provisioning.md").write_text("# Wrapper provisioning\n", encoding="utf-8")
            (mammoth / "site" / "assets" / "images" / "logo.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'></svg>\n", encoding="utf-8")

            no_wrapper = workspace / "buildish-no-gradle-wrapper-jar"
            (no_wrapper / "site").mkdir(parents=True)
            (no_wrapper / "README.md").write_text(
                "# Buildish no-gradle-wrapper-jar\n\nHelper scripts for Gradle wrapper usage.\n",
                encoding="utf-8",
            )
            with (no_wrapper / "site" / "project.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump(
                    {
                        "schemaVersion": 1,
                        "project": {
                            "slug": "no-gradle-wrapper-jar",
                            "displayName": "Buildish no-gradle-wrapper-jar",
                            "repository": "https://github.com/apache/buildish-no-gradle-wrapper-jar",
                            "defaultBranch": "main",
                        },
                        "content": {"readmePath": "README.md", "docsRoot": None},
                        "navigation": {"section": "sub-projects"},
                    },
                    handle,
                    sort_keys=False,
                    default_flow_style=False,
                )

            results = mvp.build(repo_root)

            self.assertEqual(2, len(results))
            self.assertTrue((repo_root / "site" / ".stage" / "content" / "projects" / "_index.md").exists())
            self.assertTrue((repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "unreleased" / "docs" / "wrapper-provisioning.md").exists())
            self.assertTrue((repo_root / "site" / ".stage" / "static" / "projects" / "mammoth-cache-gradle" / "unreleased" / "assets" / "images" / "logo.svg").exists())
            self.assertTrue((repo_root / "site" / ".stage" / "content" / "projects" / "no-gradle-wrapper-jar" / "unreleased" / "_index.md").exists())
            self.assertTrue((repo_root / "site" / ".preview" / "index.html").exists())

            project_index = (repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "_index.md").read_text(encoding="utf-8")
            self.assertIn("title: Apache Buildish Mammoth Cache for Gradle", project_index)
            self.assertIn("weight: 10", project_index)
            self.assertNotIn("linkTitle:", project_index)
            self.assertIn("Secure Gradle wrapper provisioning.", project_index)
            self.assertNotIn("\n# Apache Buildish Mammoth Cache for Gradle\n", project_index)
            self.assertIn("Staged assets: 1 file(s)", project_index)
            self.assertIn("Latest stable: `v1.3.5`", project_index)
            self.assertIn("`v1` — maintained; latest `v1.3.5`", project_index)

            projects_index = (repo_root / "site" / ".stage" / "content" / "projects" / "_index.md").read_text(encoding="utf-8")
            self.assertIn("title: Projects", projects_index)
            self.assertIn("Local sub-projects staged from the catalog", projects_index)
            self.assertNotIn("\n# Projects\n", projects_index)

            staged_doc = (repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "unreleased" / "docs" / "wrapper-provisioning.md").read_text(encoding="utf-8")
            self.assertNotIn("\n# Wrapper provisioning\n", staged_doc)

            preview_index = (repo_root / "site" / ".preview" / "index.html").read_text(encoding="utf-8")
            self.assertIn("Apache Buildish Mammoth Cache for Gradle", preview_index)

            version_metadata = (repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "unreleased" / "version.yaml").read_text(encoding="utf-8")
            self.assertIn("metadataLoaded: true", version_metadata)
            self.assertIn("metadataFile: site/project.yaml", version_metadata)
            self.assertIn("label: Preview", version_metadata)
            self.assertIn("path: /projects/mammoth-cache-gradle/unreleased/", version_metadata)
            self.assertIn("defaultBranch: trunk", version_metadata)
            self.assertIn("assetsRoot: site/assets", version_metadata)
            self.assertIn("count: 1", version_metadata)
            self.assertIn("path: /projects/mammoth-cache-gradle/unreleased/assets/", version_metadata)

            lifecycle_metadata = (repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "lifecycle.yaml").read_text(encoding="utf-8")
            self.assertIn("version: v1.3.5", lifecycle_metadata)
            self.assertIn("line: v1", lifecycle_metadata)
            self.assertIn("status: maintained", lifecycle_metadata)
            self.assertIn("- v1", lifecycle_metadata)

            aggregated_lifecycle = (repo_root / "site" / ".stage" / "data" / "lifecycle.yaml").read_text(encoding="utf-8")
            self.assertIn("latestStable: v1.3.5", aggregated_lifecycle)
            self.assertIn("line: v1.2", aggregated_lifecycle)

            aliases = (repo_root / "site" / ".stage" / "data" / "aliases.yaml").read_text(encoding="utf-8")
            self.assertIn("alias: v1", aliases)
            self.assertIn("target: v1.3.5", aliases)

            no_wrapper_project_index = (repo_root / "site" / ".stage" / "content" / "projects" / "no-gradle-wrapper-jar" / "_index.md").read_text(encoding="utf-8")
            self.assertIn("weight: 5", no_wrapper_project_index)
            self.assertNotIn("linkTitle:", no_wrapper_project_index)
            self.assertNotIn("Latest stable:", no_wrapper_project_index)
            self.assertNotIn("## Release lines", no_wrapper_project_index)
            self.assertNotIn("Staged assets:", no_wrapper_project_index)

    def test_rejects_metadata_path_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site").mkdir()
            catalog = {
                "schemaVersion": 1,
                "defaults": {"metadataFile": "site/project.yaml", "readmePath": "README.md", "docsRoot": "site/docs"},
                "projects": [{"slug": "mammoth-cache-gradle", "localDir": "buildish-mammoth-cache-gradle"}],
            }
            with (repo_root / "site" / "projects.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump(catalog, handle, sort_keys=False, default_flow_style=False)

            mammoth = workspace / "buildish-mammoth-cache-gradle"
            (mammoth / "site").mkdir(parents=True)
            with (mammoth / "site" / "project.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump(
                    {
                        "schemaVersion": 1,
                        "project": {"displayName": "Bad metadata"},
                        "content": {"docsRoot": "../escape", "readmePath": "README.md"},
                    },
                    handle,
                    sort_keys=False,
                    default_flow_style=False,
                )

            (mammoth / "README.md").write_text("# Test\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "escapes allowed root"):
                mvp.build(repo_root)

    def test_rejects_project_escape_outside_workspace_parent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            (repo_root / "site").mkdir(parents=True)
            catalog = {
                "schemaVersion": 1,
                "defaults": {"metadataFile": "site/project.yaml", "readmePath": "README.md", "docsRoot": "site/docs"},
                "projects": [{"slug": "bad-project", "displayName": "Bad", "localDir": "../escape"}],
            }
            with (repo_root / "site" / "projects.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump(catalog, handle, sort_keys=False, default_flow_style=False)

            with self.assertRaisesRegex(ValueError, "escapes allowed root"):
                mvp.build(repo_root)

    def test_rejects_assets_path_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site").mkdir(parents=True)
            catalog = {
                "schemaVersion": 1,
                "defaults": {
                    "metadataFile": "site/project.yaml",
                    "readmePath": "README.md",
                    "docsRoot": "site/docs",
                    "assetsRoot": "site/assets",
                },
                "projects": [{"slug": "mammoth-cache-gradle", "localDir": "buildish-mammoth-cache-gradle"}],
            }
            with (repo_root / "site" / "projects.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump(catalog, handle, sort_keys=False, default_flow_style=False)

            mammoth = workspace / "buildish-mammoth-cache-gradle"
            (mammoth / "site").mkdir(parents=True)
            with (mammoth / "site" / "project.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump(
                    {
                        "schemaVersion": 1,
                        "project": {"displayName": "Bad assets metadata"},
                        "content": {"readmePath": "README.md", "assetsRoot": "../escape"},
                    },
                    handle,
                    sort_keys=False,
                    default_flow_style=False,
                )

            (mammoth / "README.md").write_text("# Test\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "escapes allowed root"):
                mvp.build(repo_root)


if __name__ == "__main__":
    unittest.main()