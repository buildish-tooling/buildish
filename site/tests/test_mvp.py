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

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mvp


class SiteMvpTest(unittest.TestCase):
    @staticmethod
    def seed_authored_site_content(repo_root: Path) -> None:
        source_content = Path(__file__).resolve().parents[1] / "content"
        shutil.copytree(source_content, repo_root / "site" / "content", dirs_exist_ok=True)

    @staticmethod
    def seed_docsy_vendor_assets(repo_root: Path) -> None:
        vendor_sources = {
            "node_modules/jquery/dist/jquery.min.js": "window.jQuery = {};\n",
            "node_modules/mermaid/dist/mermaid.esm.min.mjs": "export const mermaid = {};\n",
            "node_modules/lunr/lunr.min.js": "window.lunr = {};\n",
        }
        for relative_path, contents in vendor_sources.items():
            target = repo_root / "site" / relative_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(contents, encoding="utf-8")

    def test_build_stages_docs_and_lifecycle_from_project_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site").mkdir()
            (repo_root / "DISCLAIMER").write_text(
                "Apache Buildish (Incubating) is an effort undergoing incubation at The Apache\n"
                "Software Foundation (ASF), sponsored by the Apache Incubator PMC.\n\n"
                "Incubation is required of all newly accepted projects until a further review\n"
                "indicates that the infrastructure, communications, and decision making process\n"
                "have stabilized in a manner consistent with other successful ASF projects.\n\n"
                "While incubation status is not necessarily a reflection of the completeness\n"
                "or stability of the code, it does indicate that the project has yet to be\n"
                "fully endorsed by the ASF.\n",
                encoding="utf-8",
            )
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
            self.seed_authored_site_content(repo_root)

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

            staged_root_index = (repo_root / "site" / ".stage" / "content" / "_index.md").read_text(encoding="utf-8")
            self.assertIn("Apache Buildish is an incubating Apache umbrella project focused on practical tooling", staged_root_index)
            self.assertNotIn("redirect_url:", staged_root_index)
            self.assertNotIn("## Incubation status", staged_root_index)
            root_front_matter = yaml.safe_load(staged_root_index.split("---", 2)[1])
            self.assertEqual("Apache Buildish (Incubating)", root_front_matter["title"])
            self.assertEqual("Apache Buildish develops build automation, CI integrations, and supporting tooling.", root_front_matter["description"])
            self.assertEqual(3, len(root_front_matter["incubator_disclaimer_paragraphs"]))
            self.assertIn("Apache Buildish (Incubating) is an effort undergoing incubation", root_front_matter["incubator_disclaimer_paragraphs"][0])
            self.assertIn("While incubation status is not necessarily a reflection", root_front_matter["incubator_disclaimer_paragraphs"][2])

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
            self.assertIn("type: docs", projects_index)
            self.assertIn("Browse staged subprojects", projects_index)
            self.assertNotIn("\n# Projects\n", projects_index)

            security_report_page = (repo_root / "site" / ".stage" / "content" / "community" / "security-report.md").read_text(encoding="utf-8")
            self.assertIn("title: Security Report", security_report_page)
            self.assertIn("do not disclose them in public issues", security_report_page)

            about_page = (repo_root / "site" / ".stage" / "content" / "about.md").read_text(encoding="utf-8")
            self.assertIn("title: About Apache Buildish", about_page)
            self.assertIn("build automation, CI integrations, and supporting tooling", about_page)

            community_index = (repo_root / "site" / ".stage" / "content" / "community" / "_index.md").read_text(encoding="utf-8")
            self.assertIn("title: Community", community_index)
            self.assertIn("[Community & Contact](/community/contact/)", community_index)

            contact_page = (repo_root / "site" / ".stage" / "content" / "community" / "contact.md").read_text(encoding="utf-8")
            self.assertIn("title: Community & Contact", contact_page)
            self.assertIn("https://github.com/apache/buildish", contact_page)
            self.assertIn("dev@buildish.apache.org", contact_page)

            get_involved_page = (repo_root / "site" / ".stage" / "content" / "community" / "get-involved.md").read_text(encoding="utf-8")
            self.assertIn("title: Get Involved", get_involved_page)
            self.assertIn("Ways to contribute", get_involved_page)

            staged_doc = (repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "unreleased" / "docs" / "wrapper-provisioning.md").read_text(encoding="utf-8")
            self.assertNotIn("\n# Wrapper provisioning\n", staged_doc)

            preview_index = (repo_root / "site" / ".preview" / "index.html").read_text(encoding="utf-8")
            self.assertIn("Apache Buildish (Incubating)", preview_index)
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

    def test_build_stages_vendor_assets_when_available(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site").mkdir()
            with (repo_root / "site" / "projects.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump({"schemaVersion": 1, "projects": []}, handle, sort_keys=False, default_flow_style=False)
            self.seed_docsy_vendor_assets(repo_root)

            mvp.build(repo_root)

            self.assertTrue((repo_root / "site" / ".stage" / "static" / "js" / "vendor" / "jquery.min.js").exists())
            self.assertTrue((repo_root / "site" / ".stage" / "static" / "js" / "vendor" / "mermaid.esm.min.mjs").exists())
            self.assertTrue((repo_root / "site" / ".stage" / "static" / "js" / "vendor" / "lunr.min.js").exists())

    def test_collect_watch_roots_includes_catalog_project_inputs_and_missing_repo_parent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site" / "content").mkdir(parents=True)
            catalog = {
                "schemaVersion": 1,
                "defaults": {
                    "metadataFile": "site/project.yaml",
                    "readmePath": "README.md",
                    "docsRoot": "site/docs",
                    "assetsRoot": "site/assets",
                },
                "projects": [
                    {"slug": "mammoth-cache-gradle", "localDir": "buildish-mammoth-cache-gradle"},
                    {"slug": "missing-project", "localDir": "buildish-missing-project"},
                ],
            }
            with (repo_root / "site" / "projects.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump(catalog, handle, sort_keys=False, default_flow_style=False)

            mammoth = workspace / "buildish-mammoth-cache-gradle"
            (mammoth / "site" / "docs").mkdir(parents=True)
            (mammoth / "site" / "assets").mkdir(parents=True)
            (mammoth / "README.md").write_text("# Mammoth\n", encoding="utf-8")
            with (mammoth / "site" / "project.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump({"schemaVersion": 1, "project": {"displayName": "Mammoth"}}, handle, sort_keys=False, default_flow_style=False)

            watch_roots = set(mvp.collect_watch_roots(repo_root))

            self.assertIn((repo_root / "site" / "projects.yaml").resolve(), watch_roots)
            self.assertIn((repo_root / "site" / "content").resolve(), watch_roots)
            self.assertIn((mammoth / "site" / "project.yaml").resolve(), watch_roots)
            self.assertIn((mammoth / "README.md").resolve(), watch_roots)
            self.assertIn((mammoth / "site" / "docs").resolve(), watch_roots)
            self.assertIn((mammoth / "site" / "assets").resolve(), watch_roots)
            self.assertIn(workspace.resolve(), watch_roots)

    def test_is_relevant_watch_path_allows_explicit_vendor_asset_paths(self) -> None:
        self.assertTrue(mvp.is_relevant_watch_path(Path("site/node_modules/jquery/dist/jquery.min.js")))
        self.assertFalse(mvp.is_relevant_watch_path(Path("site/.stage/content/_index.md")))


if __name__ == "__main__":
    unittest.main()