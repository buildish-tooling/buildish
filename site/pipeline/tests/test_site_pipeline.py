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

"""Unit tests for the Buildish site pipeline package."""

from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from pipeline import site_pipeline
from pipeline.site_pipeline.filesystem import load_project_metadata
from pipeline.site_pipeline.markdown import with_yaml_front_matter
from pipeline.site_pipeline.models import (
    AliasesDataDocument,
    BuildishProjectPagePayload,
    BuildishProjectPaths,
    BuildishProjectPayload,
    BuildishProjectUnreleased,
    DocsFrontMatter,
    LifecycleDataDocument,
    LifecycleLatestStable,
    LifecycleUnreleased,
    ManifestDocument,
    ProjectLifecycleDocument,
    ProjectsCatalog,
    ProjectsDataDocument,
    ProjectVersionDocument,
    StagedReleaseLine,
    VersionDescriptor,
)


class SitePipelineTest(unittest.TestCase):
    @staticmethod
    def seed_authored_site_content(repo_root: Path) -> None:
        source_content = Path(__file__).resolve().parents[2] / "content"
        shutil.copytree(source_content, repo_root / "site" / "content", dirs_exist_ok=True)

    @staticmethod
    def seed_docsy_vendor_assets(repo_root: Path) -> None:
        vendor_sources = {
            "node_modules/jquery/dist/jquery.min.js": "window.jQuery = {};\n",
            "node_modules/mermaid/dist/mermaid.min.js": "globalThis.mermaid = { mermaidAPI: { defaultConfig: {} }, initialize() {}, run: async () => {} };\n",
            "node_modules/lunr/lunr.min.js": "window.lunr = {};\n",
        }
        for relative_path, contents in vendor_sources.items():
            target = repo_root / "site" / relative_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(contents, encoding="utf-8")

    def test_staged_release_line_to_yaml_data_omits_empty_aliases_and_null_path(self) -> None:
        payload = StagedReleaseLine(line="v1", latest="v1.2.3", status="maintained").to_yaml_data()

        self.assertEqual({"line": "v1", "latest": "v1.2.3", "status": "maintained"}, payload)

    def test_staged_section_to_yaml_data_omits_null_optional_fields(self) -> None:
        self.assertEqual(
            {"kind": "unreleased", "label": "Preview", "path": "/projects/foo/unreleased/"},
            VersionDescriptor(kind="unreleased", label="Preview", path="/projects/foo/unreleased/").to_yaml_data(),
        )
        self.assertEqual(
            {"label": "Preview", "path": "/projects/foo/unreleased/"},
            LifecycleUnreleased(label="Preview", path="/projects/foo/unreleased/").to_yaml_data(),
        )
        self.assertEqual({"version": "v1.2.3"}, LifecycleLatestStable(version="v1.2.3").to_yaml_data())

    def test_markdown_front_matter_serializes_typed_project_payload_models(self) -> None:
        markdown = with_yaml_front_matter(
            "Body\n",
            buildishProject=BuildishProjectPayload(
                slug="mammoth-cache-gradle",
                display_name="Mammoth Cache for Gradle",
                available=True,
                local_dir="buildish-mammoth-cache-gradle",
                paths=BuildishProjectPaths(project="/projects/mammoth-cache-gradle/", unreleased="/projects/mammoth-cache-gradle/unreleased/"),
                unreleased_label="Preview",
                unreleased=BuildishProjectUnreleased(label="Preview", path="/projects/mammoth-cache-gradle/unreleased/"),
                release_lines=(StagedReleaseLine(line="v1", latest="v1.2.3", status="maintained"),),
            ),
            buildishProjectPage=BuildishProjectPagePayload(
                kind="docs-home",
                section="docs",
                path="/projects/mammoth-cache-gradle/unreleased/docs/",
                project_path="/projects/mammoth-cache-gradle/",
                version=VersionDescriptor(
                    kind="unreleased",
                    label="Preview",
                    path="/projects/mammoth-cache-gradle/unreleased/",
                ),
            ),
        )

        front_matter = yaml.safe_load(markdown.split("---", 2)[1])
        self.assertEqual("Mammoth Cache for Gradle", front_matter["buildishProject"]["displayName"])
        self.assertEqual("Preview", front_matter["buildishProject"]["unreleased"]["label"])
        self.assertNotIn("latestStable", front_matter["buildishProject"])
        self.assertEqual("docs-home", front_matter["buildishProjectPage"]["kind"])

    def test_docs_front_matter_to_yaml_data_omits_null_optionals(self) -> None:
        payload = DocsFrontMatter(title="Docs", weight=10).to_yaml_data()

        self.assertEqual({"title": "Docs", "weight": 10, "type": "docs"}, payload)

    def test_projects_catalog_from_yaml_path_returns_typed_models(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir) / "buildish"
            (repo_root / "site").mkdir(parents=True)
            with (repo_root / "site" / "projects.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump(
                    {
                        "schemaVersion": 1,
                        "defaults": {
                            "metadataFile": "site/project.yaml",
                            "docsRoot": "site/docs",
                            "assetsRoot": "site/assets",
                        },
                        "projects": [
                            {
                                "slug": "mammoth-cache-gradle",
                                "localDir": "buildish-mammoth-cache-gradle",
                                "assetsRoot": None,
                                "weight": "7",
                            }
                        ],
                    },
                    handle,
                    sort_keys=False,
                    default_flow_style=False,
                )

            catalog = ProjectsCatalog.from_yaml_path(repo_root / "site" / "projects.yaml")

            self.assertEqual(1, catalog.schema_version)
            self.assertEqual("site/project.yaml", catalog.defaults.metadata_file)
            self.assertEqual("site/docs", catalog.defaults.docs_root)
            self.assertEqual(1, len(catalog.projects))
            self.assertEqual("mammoth-cache-gradle", catalog.projects[0].slug)
            self.assertIsNone(catalog.projects[0].assets_root)
            self.assertEqual(7, catalog.projects[0].weight)

    def test_projects_catalog_from_yaml_path_accepts_null_weight(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir) / "buildish"
            (repo_root / "site").mkdir(parents=True)
            with (repo_root / "site" / "projects.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump(
                    {"schemaVersion": 1, "projects": [{"slug": "mammoth-cache-gradle", "localDir": "buildish-mammoth-cache-gradle", "weight": None}]},
                    handle,
                    sort_keys=False,
                    default_flow_style=False,
                )

            catalog = ProjectsCatalog.from_yaml_path(repo_root / "site" / "projects.yaml")

            self.assertIsNone(catalog.projects[0].weight)

    def test_projects_catalog_from_yaml_path_rejects_null_defaults_and_projects(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir) / "buildish"
            (repo_root / "site").mkdir(parents=True)
            with (repo_root / "site" / "projects.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump({"schemaVersion": 1, "defaults": None, "projects": None}, handle, sort_keys=False, default_flow_style=False)

            with self.assertRaisesRegex(ValueError, "Invalid YAML"):
                ProjectsCatalog.from_yaml_path(repo_root / "site" / "projects.yaml")

    def test_load_project_metadata_returns_typed_models(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir) / "buildish-mammoth-cache-gradle"
            (repo_root / "site").mkdir(parents=True)
            with (repo_root / "site" / "project.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump(
                    {
                        "schemaVersion": 1,
                        "project": {
                            "slug": "mammoth-cache-gradle",
                            "displayName": "Mammoth Cache for Gradle",
                            "repository": "https://github.com/apache/buildish-mammoth-cache-gradle",
                        },
                        "content": {"docsRoot": "site/docs", "assetsRoot": None},
                        "versioning": {"unreleasedLabel": "Preview", "tagPattern": r"^v[0-9]+\.[0-9]+\.[0-9]+$"},
                        "lifecycle": {
                            "latestStable": "v1.2.3",
                            "releaseLines": [
                                {"line": "v1", "latest": "v1.2.3", "status": "maintained", "aliases": ["v1"]},
                                {"line": "v0", "latest": "v0.9.0", "status": "eol", "aliases": ["stable"]},
                            ],
                        },
                        "navigation": {"section": "sub-projects"},
                    },
                    handle,
                    sort_keys=False,
                    default_flow_style=False,
                )

            metadata, metadata_path = load_project_metadata(repo_root, "site/project.yaml", "mammoth-cache-gradle")

            self.assertEqual(repo_root / "site" / "project.yaml", metadata_path)
            self.assertEqual(1, metadata.schema_version)
            self.assertEqual("Mammoth Cache for Gradle", metadata.project.display_name)
            self.assertEqual("site/docs", metadata.content.docs_root)
            self.assertIsNone(metadata.content.assets_root)
            self.assertEqual("Preview", metadata.versioning.unreleased_label)
            self.assertEqual("v1.2.3", metadata.lifecycle.latest_stable)
            self.assertEqual(2, len(metadata.lifecycle.release_lines))
            self.assertEqual(("v1",), metadata.lifecycle.release_lines[0].aliases)
            self.assertEqual(("stable",), metadata.lifecycle.release_lines[1].aliases)
            self.assertEqual("sub-projects", metadata.navigation.section)

    def test_load_project_metadata_rejects_invalid_tag_pattern(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir) / "buildish-mammoth-cache-gradle"
            (repo_root / "site").mkdir(parents=True)
            with (repo_root / "site" / "project.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump(
                    {"schemaVersion": 1, "versioning": {"tagPattern": "["}},
                    handle,
                    sort_keys=False,
                    default_flow_style=False,
                )

            with self.assertRaisesRegex(ValueError, "Invalid YAML"):
                load_project_metadata(repo_root, "site/project.yaml", "mammoth-cache-gradle")

    def test_load_project_metadata_rejects_invalid_release_line_aliases(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir) / "buildish-mammoth-cache-gradle"
            (repo_root / "site").mkdir(parents=True)
            with (repo_root / "site" / "project.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump(
                    {
                        "schemaVersion": 1,
                        "lifecycle": {
                            "releaseLines": [
                                {"line": "v1", "latest": "v1.2.3", "status": "maintained", "aliases": "stable"}
                            ]
                        },
                    },
                    handle,
                    sort_keys=False,
                    default_flow_style=False,
                )

            with self.assertRaisesRegex(ValueError, "Invalid YAML"):
                load_project_metadata(repo_root, "site/project.yaml", "mammoth-cache-gradle")

    def test_load_project_metadata_rejects_null_nested_sections(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir) / "buildish-mammoth-cache-gradle"
            (repo_root / "site").mkdir(parents=True)
            with (repo_root / "site" / "project.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump(
                    {"schemaVersion": 1, "project": None, "content": None, "versioning": None, "lifecycle": None, "navigation": None},
                    handle,
                    sort_keys=False,
                    default_flow_style=False,
                )

            with self.assertRaisesRegex(ValueError, "Invalid YAML"):
                load_project_metadata(repo_root, "site/project.yaml", "mammoth-cache-gradle")

    def test_build_falls_back_to_default_docs_root_when_project_value_is_null(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site").mkdir()
            with (repo_root / "site" / "projects.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump(
                    {
                        "schemaVersion": 1,
                        "defaults": {"docsRoot": "site/docs"},
                        "projects": [{"slug": "mammoth-cache-gradle", "localDir": "buildish-mammoth-cache-gradle", "docsRoot": None}],
                    },
                    handle,
                    sort_keys=False,
                    default_flow_style=False,
                )
            project_root = workspace / "buildish-mammoth-cache-gradle"
            (project_root / "site" / "docs").mkdir(parents=True)
            (project_root / "site" / "docs" / "_index.md").write_text("---\ntitle: Docs\n---\n", encoding="utf-8")

            site_pipeline.build(repo_root)

            self.assertTrue((repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "unreleased" / "docs" / "_index.md").is_file())

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
                    "docsRoot": "site/docs",
                    "assetsRoot": "site/assets",
                    "unreleasedLabel": "Unreleased",
                    "tagPattern": r"^v[0-9]+\.[0-9]+\.[0-9]+$",
                    "navigationSection": "sub-projects",
                },
                "projects": [
                    {
                        "slug": "mammoth-cache-gradle",
                        "displayName": "Mammoth Cache for Gradle",
                        "localDir": "buildish-mammoth-cache-gradle",
                    },
                    {
                        "slug": "no-gradle-wrapper-jar",
                        "displayName": "No Gradle Wrapper JAR",
                        "localDir": "buildish-no-gradle-wrapper-jar",
                        "weight": 5,
                    },
                    {"slug": "site", "localDir": "buildish", "weight": 100},
                ],
            }
            with (repo_root / "site" / "projects.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump(catalog, handle, sort_keys=False, default_flow_style=False)
            self.seed_authored_site_content(repo_root)
            (repo_root / "docs").mkdir()
            (repo_root / "docs" / "_index.md").write_text(
                "# Apache Buildish Site Documentation\n\nSite implementation and infrastructure docs.\n",
                encoding="utf-8",
            )
            with (repo_root / "site" / "project.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump(
                    {
                        "schemaVersion": 1,
                        "project": {
                            "slug": "site",
                            "displayName": "Site",
                            "repository": "https://github.com/apache/buildish",
                        },
                        "content": {"docsRoot": "docs", "assetsRoot": None},
                        "navigation": {"section": "sub-projects"},
                    },
                    handle,
                    sort_keys=False,
                    default_flow_style=False,
                )

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
                        "content": {"docsRoot": "site/docs", "assetsRoot": "site/assets"},
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
            (mammoth / "site" / "docs" / "_index.md").write_text(
                "# Mammoth overview\n\nSecure Gradle wrapper provisioning.\n",
                encoding="utf-8",
            )
            (mammoth / "site" / "docs" / "wrapper-provisioning.md").write_text("# Wrapper provisioning\n", encoding="utf-8")
            (mammoth / "site" / "assets" / "images" / "logo.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'></svg>\n", encoding="utf-8")

            no_wrapper = workspace / "buildish-no-gradle-wrapper-jar"
            (no_wrapper / "site").mkdir(parents=True)
            (no_wrapper / "site" / "docs").mkdir()
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
                        "content": {"docsRoot": "site/docs"},
                        "navigation": {"section": "sub-projects"},
                    },
                    handle,
                    sort_keys=False,
                    default_flow_style=False,
                )
            (no_wrapper / "site" / "docs" / "_index.md").write_text(
                "# No wrapper JAR\n\nHelper scripts for Gradle wrapper usage.\n",
                encoding="utf-8",
            )

            results = site_pipeline.build(repo_root)

            self.assertEqual(3, len(results))
            self.assertTrue((repo_root / "site" / ".stage" / "content" / "projects" / "_index.md").exists())
            self.assertTrue((repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "unreleased" / "docs" / "wrapper-provisioning.md").exists())
            self.assertTrue((repo_root / "site" / ".stage" / "static" / "projects" / "mammoth-cache-gradle" / "unreleased" / "assets" / "images" / "logo.svg").exists())
            self.assertTrue((repo_root / "site" / ".stage" / "content" / "projects" / "no-gradle-wrapper-jar" / "unreleased" / "_index.md").exists())
            self.assertTrue((repo_root / "site" / ".stage" / "content" / "projects" / "site" / "unreleased" / "docs" / "_index.md").exists())
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
            self.assertIn("title: Mammoth Cache for Gradle", project_index)
            self.assertIn("weight: 10", project_index)
            self.assertNotIn("linkTitle:", project_index)
            self.assertIn("description: Secure Gradle wrapper provisioning.", project_index)
            self.assertNotIn("\nSecure Gradle wrapper provisioning.\n", project_index)
            self.assertNotIn("\n# Mammoth Cache for Gradle\n", project_index)
            self.assertIn("Staged assets: 1 file(s)", project_index)
            self.assertIn("Latest stable: `v1.3.5`", project_index)
            self.assertIn("`v1` — maintained; latest `v1.3.5`", project_index)
            project_front_matter = yaml.safe_load(project_index.split("---", 2)[1])
            self.assertEqual("mammoth-cache-gradle", project_front_matter["buildishProject"]["slug"])
            self.assertEqual("Mammoth Cache for Gradle", project_front_matter["buildishProject"]["displayName"])
            self.assertEqual("/projects/mammoth-cache-gradle/unreleased/docs/", project_front_matter["buildishProject"]["paths"]["docs"])
            self.assertEqual("project-home", project_front_matter["buildishProjectPage"]["kind"])

            mammoth_unreleased_index = (repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "unreleased" / "_index.md").read_text(encoding="utf-8")
            self.assertIn("title: Mammoth Cache for Gradle Preview", mammoth_unreleased_index)
            self.assertIn("linkTitle: Preview", mammoth_unreleased_index)
            self.assertNotIn("\nSecure Gradle wrapper provisioning.\n", mammoth_unreleased_index)
            mammoth_unreleased_front_matter = yaml.safe_load(mammoth_unreleased_index.split("---", 2)[1])
            self.assertEqual("unreleased-home", mammoth_unreleased_front_matter["buildishProjectPage"]["kind"])

            mammoth_docs_index = (repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "unreleased" / "docs" / "_index.md").read_text(encoding="utf-8")
            self.assertIn("linkTitle: Docs", mammoth_docs_index)
            mammoth_docs_front_matter = yaml.safe_load(mammoth_docs_index.split("---", 2)[1])
            self.assertEqual("docs-home", mammoth_docs_front_matter["buildishProjectPage"]["kind"])
            self.assertEqual("/projects/mammoth-cache-gradle/unreleased/docs/", mammoth_docs_front_matter["buildishProjectPage"]["path"])

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
            self.assertIn("[Contributing Guidelines](/community/contributing-guidelines/)", community_index)
            self.assertIn("[Community Guidelines](/community/community-guidelines/)", community_index)

            contact_page = (repo_root / "site" / ".stage" / "content" / "community" / "contact.md").read_text(encoding="utf-8")
            self.assertIn("title: Community & Contact", contact_page)
            self.assertIn("https://github.com/apache/buildish", contact_page)
            self.assertIn("dev@buildish.apache.org", contact_page)

            get_involved_page = (repo_root / "site" / ".stage" / "content" / "community" / "get-involved.md").read_text(encoding="utf-8")
            self.assertIn("title: Get Involved", get_involved_page)
            self.assertIn("Ways to contribute", get_involved_page)

            contributing_guidelines_page = (repo_root / "site" / ".stage" / "content" / "community" / "contributing-guidelines.md").read_text(encoding="utf-8")
            self.assertIn("title: Contributing Guidelines", contributing_guidelines_page)
            self.assertIn("apache/buildish", contributing_guidelines_page)
            self.assertIn("For the Buildish site repository, a good baseline is:", contributing_guidelines_page)
            self.assertIn("https://www.apache.org/legal/generative-tooling.html", contributing_guidelines_page)

            community_guidelines_page = (repo_root / "site" / ".stage" / "content" / "community" / "community-guidelines.md").read_text(encoding="utf-8")
            self.assertIn("title: Community Guidelines", community_guidelines_page)
            self.assertIn("ASF Code of Conduct", community_guidelines_page)
            self.assertIn("Apache Way", community_guidelines_page)

            staged_doc = (repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "unreleased" / "docs" / "wrapper-provisioning.md").read_text(encoding="utf-8")
            self.assertNotIn("\n# Wrapper provisioning\n", staged_doc)

            preview_index = (repo_root / "site" / ".preview" / "index.html").read_text(encoding="utf-8")
            self.assertIn("Apache Buildish (Incubating)", preview_index)
            self.assertIn("Mammoth Cache for Gradle", preview_index)
            self.assertIn("Site", preview_index)

            version_document = ProjectVersionDocument.from_yaml_path(
                repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "unreleased" / "version.yaml"
            )
            version_metadata = (repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "unreleased" / "version.yaml").read_text(encoding="utf-8")
            self.assertIn("metadataLoaded: true", version_metadata)
            self.assertIn("metadataFile: site/project.yaml", version_metadata)
            self.assertIn("label: Preview", version_metadata)
            self.assertIn("path: /projects/mammoth-cache-gradle/unreleased/", version_metadata)
            self.assertIn("docsPath: /projects/mammoth-cache-gradle/unreleased/docs/", version_metadata)
            self.assertIn("defaultBranch: trunk", version_metadata)
            self.assertIn("assetsRoot: site/assets", version_metadata)
            self.assertIn("count: 1", version_metadata)
            self.assertIn("path: /projects/mammoth-cache-gradle/unreleased/assets/", version_metadata)
            self.assertEqual("mammoth-cache-gradle", version_document.project.slug)
            self.assertEqual("Preview", version_document.version.label)
            self.assertEqual("site/project.yaml", version_document.source.metadata_file)
            self.assertTrue(version_document.source.metadata_loaded)
            self.assertEqual("site/assets", version_document.source.assets_root)
            self.assertEqual(1, version_document.assets.count)

            lifecycle_document = ProjectLifecycleDocument.from_yaml_path(
                repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "lifecycle.yaml"
            )
            lifecycle_metadata = (repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "lifecycle.yaml").read_text(encoding="utf-8")
            self.assertIn("version: v1.3.5", lifecycle_metadata)
            self.assertIn("line: v1", lifecycle_metadata)
            self.assertIn("status: maintained", lifecycle_metadata)
            self.assertIn("- v1", lifecycle_metadata)
            self.assertIn("docsPath: /projects/mammoth-cache-gradle/unreleased/docs/", lifecycle_metadata)
            self.assertEqual("mammoth-cache-gradle", lifecycle_document.project.slug)
            self.assertEqual("v1.3.5", lifecycle_document.lifecycle.latest_stable.version)
            self.assertEqual("v1", lifecycle_document.lifecycle.release_lines[0].line)
            self.assertEqual(("v1",), lifecycle_document.lifecycle.release_lines[0].aliases)

            lifecycle_data = LifecycleDataDocument.from_yaml_path(repo_root / "site" / ".stage" / "data" / "lifecycle.yaml")
            aggregated_lifecycle = (repo_root / "site" / ".stage" / "data" / "lifecycle.yaml").read_text(encoding="utf-8")
            self.assertIn("latestStable: v1.3.5", aggregated_lifecycle)
            self.assertIn("line: v1.2", aggregated_lifecycle)
            self.assertIn("docsPath: /projects/mammoth-cache-gradle/unreleased/docs/", aggregated_lifecycle)
            self.assertEqual("v1.3.5", lifecycle_data.projects["mammoth-cache-gradle"].latest_stable)
            self.assertEqual("Preview", lifecycle_data.projects["mammoth-cache-gradle"].unreleased.label)

            projects_data = ProjectsDataDocument.from_yaml_path(repo_root / "site" / ".stage" / "data" / "projects.yaml")
            self.assertEqual("/projects/mammoth-cache-gradle/", projects_data.projects["mammoth-cache-gradle"].project_path)
            self.assertEqual("/projects/mammoth-cache-gradle/unreleased/docs/", projects_data.projects["mammoth-cache-gradle"].docs_path)
            self.assertEqual("/projects/site/", projects_data.projects["site"].project_path)

            aliases_data = AliasesDataDocument.from_yaml_path(repo_root / "site" / ".stage" / "data" / "aliases.yaml")
            aliases = (repo_root / "site" / ".stage" / "data" / "aliases.yaml").read_text(encoding="utf-8")
            self.assertIn("alias: v1", aliases)
            self.assertIn("target: v1.3.5", aliases)
            self.assertEqual("v1", aliases_data.projects["mammoth-cache-gradle"].aliases[0].alias)

            manifest_document = ManifestDocument.from_yaml_path(repo_root / "site" / ".stage" / "manifest.yaml")
            self.assertEqual(str(repo_root), manifest_document.repo_root)
            self.assertEqual("mammoth-cache-gradle", manifest_document.projects[0].slug)

            no_wrapper_project_index = (repo_root / "site" / ".stage" / "content" / "projects" / "no-gradle-wrapper-jar" / "_index.md").read_text(encoding="utf-8")
            self.assertIn("weight: 5", no_wrapper_project_index)
            self.assertNotIn("linkTitle:", no_wrapper_project_index)
            self.assertIn("Helper scripts for Gradle wrapper usage.", no_wrapper_project_index)
            self.assertNotIn("Latest stable:", no_wrapper_project_index)
            self.assertNotIn("## Release lines", no_wrapper_project_index)
            self.assertNotIn("Staged assets:", no_wrapper_project_index)

            site_project_index = (repo_root / "site" / ".stage" / "content" / "projects" / "site" / "_index.md").read_text(encoding="utf-8")
            self.assertIn("title: Site", site_project_index)
            self.assertIn("weight: 100", site_project_index)
            self.assertIn("Site implementation and infrastructure docs.", site_project_index)
            self.assertNotIn("Staged assets:", site_project_index)

            site_unreleased_index = (repo_root / "site" / ".stage" / "content" / "projects" / "site" / "unreleased" / "_index.md").read_text(encoding="utf-8")
            self.assertIn("## Docs", site_unreleased_index)
            self.assertIn("[Apache Buildish Site Documentation](/projects/site/unreleased/docs/)", site_unreleased_index)
            self.assertNotIn("Open staged assets", site_unreleased_index)

            site_version_document = ProjectVersionDocument.from_yaml_path(
                repo_root / "site" / ".stage" / "content" / "projects" / "site" / "unreleased" / "version.yaml"
            )
            site_version_metadata = (repo_root / "site" / ".stage" / "content" / "projects" / "site" / "unreleased" / "version.yaml").read_text(encoding="utf-8")
            self.assertIn("docsPath: /projects/site/unreleased/docs/", site_version_metadata)
            self.assertIn("assetsRoot: site/assets", site_version_metadata)
            self.assertIn("count: 0", site_version_metadata)
            self.assertEqual("site/assets", site_version_document.source.assets_root)

    def test_rejects_metadata_path_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site").mkdir()
            catalog = {
                "schemaVersion": 1,
                "defaults": {"metadataFile": "site/project.yaml", "docsRoot": "site/docs"},
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
                        "content": {"docsRoot": "../escape"},
                    },
                    handle,
                    sort_keys=False,
                    default_flow_style=False,
                )

            with self.assertRaisesRegex(ValueError, "escapes allowed root"):
                site_pipeline.build(repo_root)

    def test_rejects_project_escape_outside_workspace_parent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            (repo_root / "site").mkdir(parents=True)
            catalog = {
                "schemaVersion": 1,
                "defaults": {"metadataFile": "site/project.yaml", "docsRoot": "site/docs"},
                "projects": [{"slug": "bad-project", "displayName": "Bad", "localDir": "../escape"}],
            }
            with (repo_root / "site" / "projects.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump(catalog, handle, sort_keys=False, default_flow_style=False)

            with self.assertRaisesRegex(ValueError, "escapes allowed root"):
                site_pipeline.build(repo_root)

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
                        "content": {"assetsRoot": "../escape"},
                    },
                    handle,
                    sort_keys=False,
                    default_flow_style=False,
                )

            with self.assertRaisesRegex(ValueError, "escapes allowed root"):
                site_pipeline.build(repo_root)

    def test_build_stages_vendor_assets_when_available(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site").mkdir()
            with (repo_root / "site" / "projects.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump({"schemaVersion": 1, "projects": []}, handle, sort_keys=False, default_flow_style=False)
            self.seed_docsy_vendor_assets(repo_root)

            site_pipeline.build(repo_root)

            self.assertTrue((repo_root / "site" / ".stage" / "static" / "js" / "vendor" / "jquery.min.js").exists())
            self.assertTrue((repo_root / "site" / ".stage" / "static" / "js" / "vendor" / "mermaid.min.js").exists())
            self.assertTrue((repo_root / "site" / ".stage" / "static" / "js" / "vendor" / "lunr.min.js").exists())

    def test_extract_title_and_summary_ignores_headings_inside_fenced_code_blocks(self) -> None:
        markdown = """<!--\ncomment\n-->\n\nThis page currently carries content moved from the project README.\n\n```yaml\n# .github/buildish-mammoth-gradle.yml\njob-mode: distributed-worker\n```\n\n## Next section\n"""

        title, summary = site_pipeline.extract_title_and_summary(markdown, "[FROM README] Usage examples")

        self.assertEqual("[FROM README] Usage examples", title)
        self.assertEqual("Temporary home for usage examples.", site_pipeline.normalize_markdown_doc(
            "---\ntitle: \"[FROM README] Usage examples\"\ndescription: Temporary home for usage examples.\n---\n\n" + markdown,
            "Usage examples",
            type="docs",
        )[2])

    def test_normalize_markdown_doc_strips_auto_promoted_summary_from_body(self) -> None:
        markdown = """<!--\ncomment\n-->\n\n# Bootstrap Process\n\nThis document describes the full execution sequence for both the `prepare` and `finalize` phases.\n\n```mermaid\nflowchart TD\n    A --> B\n```\n"""

        normalized, title, summary = site_pipeline.normalize_markdown_doc(markdown, "Bootstrap Process", type="docs")

        self.assertEqual("Bootstrap Process", title)
        self.assertEqual(
            "This document describes the full execution sequence for both the `prepare` and `finalize` phases.",
            summary,
        )
        self.assertIn("description: This document describes the full execution sequence", normalized)
        self.assertNotIn("# Bootstrap Process", normalized)
        self.assertNotIn("This document describes the full execution sequence for both the `prepare` and `finalize` phases.\n\n```mermaid", normalized)
        self.assertIn("```mermaid", normalized)

    def test_collect_watch_roots_includes_catalog_project_inputs_and_missing_repo_parent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site" / "content").mkdir(parents=True)
            (repo_root / "site" / "pipeline").mkdir(parents=True)
            (repo_root / "site" / "pipeline" / "site_pipeline").mkdir(parents=True)
            (repo_root / "site" / "pipeline" / "site_pipeline" / "__init__.py").write_text("# watcher stub\n", encoding="utf-8")
            catalog = {
                "schemaVersion": 1,
                "defaults": {
                    "metadataFile": "site/project.yaml",
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
            with (mammoth / "site" / "project.yaml").open("w", encoding="utf-8") as handle:
                yaml.safe_dump({"schemaVersion": 1, "project": {"displayName": "Mammoth"}}, handle, sort_keys=False, default_flow_style=False)

            watch_roots = set(site_pipeline.collect_watch_roots(repo_root))

            self.assertIn((repo_root / "site" / "projects.yaml").resolve(), watch_roots)
            self.assertIn((repo_root / "site" / "content").resolve(), watch_roots)
            self.assertIn((repo_root / "site" / "pipeline").resolve(), watch_roots)
            self.assertIn((mammoth / "site" / "project.yaml").resolve(), watch_roots)
            self.assertIn((mammoth / "site" / "docs").resolve(), watch_roots)
            self.assertIn((mammoth / "site" / "assets").resolve(), watch_roots)
            self.assertIn(workspace.resolve(), watch_roots)

    def test_is_relevant_watch_path_allows_explicit_vendor_asset_paths(self) -> None:
        self.assertTrue(site_pipeline.is_relevant_watch_path(Path("site/node_modules/jquery/dist/jquery.min.js")))
        self.assertFalse(site_pipeline.is_relevant_watch_path(Path("site/.stage/content/_index.md")))


if __name__ == "__main__":
    unittest.main()