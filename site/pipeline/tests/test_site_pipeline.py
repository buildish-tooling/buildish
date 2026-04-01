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

"""Unit tests for the site pipeline package."""

from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

import yaml
from test_support import (
    TestCaseHelpers,
    text_block,
    write_files,
    write_text,
)


class SitePipelineTest(TestCaseHelpers, unittest.TestCase):
    @staticmethod
    def default_catalog_defaults(**overrides: object) -> dict[str, object]:
        defaults: dict[str, object] = {
            "metadataFile": "site/component.yaml",
            "pagesRoot": "site/pages",
            "docsRoot": "site/docs",
            "assetsRoot": "site/assets",
        }
        defaults.update(overrides)
        return defaults

    @staticmethod
    def catalog_payload(
        *components: dict[str, object], defaults: dict[str, object] | None = None
    ) -> dict[str, object]:
        payload: dict[str, object] = {
            "schemaVersion": 1,
            "components": list(components),
        }
        if defaults is not None:
            payload["defaults"] = defaults
        return payload

    @staticmethod
    def local_overrides_payload(
        *, components: dict[str, dict[str, object]] | None = None
    ) -> dict[str, object]:
        return {
            "schemaVersion": 1,
            "workspace": {"components": {} if components is None else components},
        }

    @staticmethod
    def seed_authored_site_content(
        repo_root: Path, target_relative: str = "site/content"
    ) -> None:
        source_content = Path(__file__).resolve().parents[2] / "content"
        shutil.copytree(source_content, repo_root / target_relative, dirs_exist_ok=True)

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

    def test_build_falls_back_to_default_docs_root_when_component_value_is_null(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site").mkdir()
            self.write_yaml(
                repo_root / "site" / "components.yaml",
                self.catalog_payload(
                    {
                        "slug": "mammoth-cache",
                        "localDir": "buildish-mammoth-cache",
                        "docsRoot": None,
                    },
                    defaults={"pagesRoot": "site/pages", "docsRoot": "site/docs"},
                ),
            )
            component_root = workspace / "buildish-mammoth-cache"
            write_files(
                component_root,
                {
                    "site/pages/_index.md": text_block(
                        """
                        # Mammoth Cache for Gradle® and Apache Maven™

                        Component landing page.
                        """
                    ),
                    "site/docs/_index.md": text_block(
                        """
                        ---
                        title: Docs
                        ---
                        """
                    ),
                },
            )

            result = self.run_pipeline_build(repo_root)
            self.assert_command_succeeded(result)

            self.assert_paths_exist(
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
                / "content"
                / "components"
                / "mammoth-cache"
                / "development"
                / "docs"
                / "_index.md",
            )

    def test_build_stages_docs_and_lifecycle_from_component_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site").mkdir()
            catalog = {
                "schemaVersion": 1,
                "defaults": {
                    "metadataFile": "site/component.yaml",
                    "pagesRoot": "site/pages",
                    "docsRoot": "site/docs",
                    "assetsRoot": "site/assets",
                    "developmentLabel": "Development",
                    "tagPattern": r"^v[0-9]+\.[0-9]+\.[0-9]+$",
                    "navigationSection": "components",
                },
                "components": [
                    {
                        "slug": "mammoth-cache",
                        "displayName": "Mammoth Cache for Gradle® and Apache Maven™",
                        "localDir": "buildish-mammoth-cache",
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
            self.write_yaml(repo_root / "site" / "components.yaml", catalog)
            self.seed_authored_site_content(repo_root)
            write_files(
                repo_root,
                {
                    "site/pages/_index.md": text_block(
                        """
                        # Buildish Site

                        Buildish site publishing and shared documentation tooling.

                        Use the authored component pages for the stable overview and the development docs for implementation details.
                        """
                    ),
                    "docs/_index.md": text_block(
                        """
                        # Apache Buildish Site Documentation

                        Site implementation and infrastructure docs.
                        """
                    ),
                },
            )
            self.write_yaml(
                repo_root / "site" / "component.yaml",
                {
                    "schemaVersion": 1,
                    "component": {
                        "slug": "site",
                        "displayName": "Site",
                        "repository": "https://github.com/apache/buildish",
                    },
                    "content": {"docsRoot": "docs", "assetsRoot": None},
                    "navigation": {"section": "components"},
                },
            )

            mammoth = workspace / "buildish-mammoth-cache"
            write_text(
                mammoth / "README.md",
                text_block(
                    """
                    # Apache Buildish Mammoth Cache for Gradle® and Apache Maven™

                    Secure Gradle wrapper provisioning.
                    """
                ),
            )
            self.write_yaml(
                mammoth / "site" / "component.yaml",
                {
                    "schemaVersion": 1,
                    "component": {
                        "slug": "mammoth-cache",
                        "displayName": "Apache Buildish Mammoth Cache for Gradle® and Apache Maven™",
                        "repository": "https://github.com/apache/buildish-mammoth-cache",
                        "defaultBranch": "trunk",
                    },
                    "content": {"docsRoot": "site/docs", "assetsRoot": "site/assets"},
                    "versioning": {"developmentLabel": "Preview"},
                    "lifecycle": {
                        "latestStable": "v1.3.5",
                        "releaseLines": [
                            {
                                "line": "v1",
                                "latest": "v1.3.5",
                                "status": "maintained",
                                "aliases": ["v1"],
                            },
                            {
                                "line": "v1.2",
                                "latest": "v1.2.9",
                                "status": "eol",
                                "aliases": ["v1.2"],
                            },
                        ],
                    },
                    "navigation": {"section": "components"},
                },
            )
            write_files(
                mammoth,
                {
                    "site/pages/_index.md": text_block(
                        """
                        # Mammoth Cache for Gradle® and Apache Maven™

                        Secure Gradle wrapper provisioning.

                        Use the development docs to evaluate planned changes before they ship.
                        """
                    ),
                    "site/pages/faq.md": text_block(
                        """
                        # FAQ

                        Answers for component-level rollout questions.
                        """
                    ),
                    "site/docs/_index.md": text_block(
                        """
                        # Mammoth overview

                        Secure Gradle wrapper provisioning.
                        """
                    ),
                    "site/docs/wrapper-provisioning.md": text_block(
                        """
                        # Wrapper provisioning
                        """
                    ),
                    "site/assets/images/logo.svg": text_block(
                        """
                        <svg xmlns='http://www.w3.org/2000/svg'></svg>
                        """
                    ),
                },
            )

            no_wrapper = workspace / "buildish-no-gradle-wrapper-jar"
            self.write_yaml(
                no_wrapper / "site" / "component.yaml",
                {
                    "schemaVersion": 1,
                    "component": {
                        "slug": "no-gradle-wrapper-jar",
                        "displayName": "Buildish no-gradle-wrapper-jar",
                        "repository": "https://github.com/apache/buildish-no-gradle-wrapper-jar",
                        "defaultBranch": "main",
                    },
                    "content": {"docsRoot": "site/docs"},
                    "navigation": {"section": "components"},
                },
            )
            write_files(
                no_wrapper,
                {
                    "site/pages/_index.md": text_block(
                        """
                        # No Wrapper JAR

                        Helper scripts for Gradle wrapper usage.

                        This component keeps wrapper bootstrapping lean for repositories that do not ship the wrapper JAR.
                        """
                    ),
                    "site/docs/_index.md": text_block(
                        """
                        # No wrapper JAR

                        Helper scripts for Gradle wrapper usage.
                        """
                    ),
                },
            )

            result = self.run_pipeline_build(repo_root)
            self.assert_command_succeeded(result)
            self.assert_paths_exist(
                repo_root / "site" / ".stage" / "content" / "components" / "_index.md",
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "mammoth-cache"
                / "development"
                / "docs"
                / "wrapper-provisioning.md",
                repo_root
                / "site"
                / ".stage"
                / "static"
                / "components"
                / "mammoth-cache"
                / "development"
                / "assets"
                / "images"
                / "logo.svg",
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "no-gradle-wrapper-jar"
                / "development"
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

            staged_root_index = (
                repo_root / "site" / ".stage" / "content" / "_index.md"
            ).read_text(encoding="utf-8")
            self.assert_contains_all(
                staged_root_index,
                "Apache Buildish is an incubating Apache umbrella project focused on practical tooling",
            )
            self.assert_not_contains_any(
                staged_root_index, "redirect_url:", "## Incubation status"
            )
            root_front_matter = yaml.safe_load(staged_root_index.split("---", 2)[1])
            self.assertEqual("Apache Project Site", root_front_matter["title"])
            self.assertEqual(
                "Apache Buildish develops build automation, CI integrations, and supporting tooling.",
                root_front_matter["description"],
            )
            self.assertEqual(
                "Apache® is a registered trademark of The Apache Software Foundation. Apache Maven™ and Maven™ are trademarks of The Apache Software Foundation. Gradle® is a registered trademark of Gradle, Inc.",
                root_front_matter["trademark_attribution"],
            )
            self.assertEqual(
                "Apache Project Site",
                root_front_matter["sitePipeline"]["siteTitle"],
            )
            self.assertEqual(
                "incubating", root_front_matter["sitePipeline"]["projectStatus"]
            )
            self.assertNotIn("incubator_disclaimer_paragraphs", root_front_matter)

            component_index = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "mammoth-cache"
                / "_index.md"
            ).read_text(encoding="utf-8")
            self.assert_contains_all(
                component_index,
                "title: Mammoth Cache for Gradle® and Apache Maven™",
                "weight: 10",
                "description: Secure Gradle wrapper provisioning.",
                "Use the development docs to evaluate planned changes before they ship.",
            )
            self.assert_not_contains_any(
                component_index,
                "linkTitle:",
                "\nSecure Gradle wrapper provisioning.\n",
                "\n# Mammoth Cache for Gradle® and Apache Maven™\n",
            )
            self.assert_contains_all(
                (
                    repo_root
                    / "site"
                    / ".stage"
                    / "content"
                    / "components"
                    / "site"
                    / "_index.md"
                ).read_text(encoding="utf-8"),
                "Use the authored component pages for the stable overview",
            )
            component_front_matter = yaml.safe_load(component_index.split("---", 2)[1])
            self.assertEqual(
                "incubating", component_front_matter["sitePipeline"]["projectStatus"]
            )
            self.assertEqual(
                "mammoth-cache", component_front_matter["sitePipelineComponent"]["slug"]
            )
            self.assertEqual(
                "Mammoth Cache for Gradle® and Apache Maven™",
                component_front_matter["sitePipelineComponent"]["displayName"],
            )
            self.assertEqual(
                "/components/mammoth-cache/development/docs/",
                component_front_matter["sitePipelineComponent"]["paths"]["docs"],
            )
            self.assertEqual(
                "component-home",
                component_front_matter["sitePipelineComponentPage"]["kind"],
            )

            mammoth_component_page = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "mammoth-cache"
                / "faq.md"
            ).read_text(encoding="utf-8")
            mammoth_component_front_matter = yaml.safe_load(
                mammoth_component_page.split("---", 2)[1]
            )
            self.assertEqual(
                "component-page",
                mammoth_component_front_matter["sitePipelineComponentPage"]["kind"],
            )
            self.assertEqual(
                "/components/mammoth-cache/faq/",
                mammoth_component_front_matter["sitePipelineComponentPage"]["path"],
            )

            mammoth_development_index = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "mammoth-cache"
                / "development"
                / "_index.md"
            ).read_text(encoding="utf-8")
            self.assert_contains_all(
                mammoth_development_index,
                "title: Mammoth Cache for Gradle® and Apache Maven™ Preview",
                "linkTitle: Preview",
            )
            self.assert_not_contains_any(
                mammoth_development_index, "\nSecure Gradle wrapper provisioning.\n"
            )
            mammoth_development_front_matter = yaml.safe_load(
                mammoth_development_index.split("---", 2)[1]
            )
            self.assertEqual(
                "development-home",
                mammoth_development_front_matter["sitePipelineComponentPage"]["kind"],
            )

            mammoth_docs_index = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "mammoth-cache"
                / "development"
                / "docs"
                / "_index.md"
            ).read_text(encoding="utf-8")
            self.assert_contains_all(mammoth_docs_index, "linkTitle: Docs")
            mammoth_docs_front_matter = yaml.safe_load(
                mammoth_docs_index.split("---", 2)[1]
            )
            self.assertEqual(
                "docs-home",
                mammoth_docs_front_matter["sitePipelineComponentPage"]["kind"],
            )
            self.assertEqual(
                "/components/mammoth-cache/development/docs/",
                mammoth_docs_front_matter["sitePipelineComponentPage"]["path"],
            )

            components_index = (
                repo_root / "site" / ".stage" / "content" / "components" / "_index.md"
            ).read_text(encoding="utf-8")
            self.assert_contains_all(
                components_index,
                "title: Components",
                "type: docs",
                "Browse staged components",
            )
            self.assert_not_contains_any(components_index, "\n# Components\n")

            security_report_page = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "community"
                / "security-report.md"
            ).read_text(encoding="utf-8")
            self.assertIn("title: Security Report", security_report_page)
            self.assertIn("do not disclose them in public issues", security_report_page)

            about_page = (
                repo_root / "site" / ".stage" / "content" / "about.md"
            ).read_text(encoding="utf-8")
            self.assertIn("title: About Apache Buildish", about_page)
            self.assertIn(
                "build automation, CI integrations, and supporting", about_page
            )
            self.assertIn("tooling.", about_page)

            community_index = (
                repo_root / "site" / ".stage" / "content" / "community" / "_index.md"
            ).read_text(encoding="utf-8")
            self.assertIn("title: Community", community_index)
            self.assertIn("buildish_landing_page: true", community_index)
            self.assertIn("project communication channels", community_index)

            contact_page = (
                repo_root / "site" / ".stage" / "content" / "community" / "contact.md"
            ).read_text(encoding="utf-8")
            self.assertIn("title: Contact", contact_page)
            self.assertIn("https://github.com/apache/buildish", contact_page)
            self.assertIn("dev@buildish.apache.org", contact_page)

            get_involved_page = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "community"
                / "get-involved.md"
            ).read_text(encoding="utf-8")
            self.assertIn("title: Get Involved", get_involved_page)
            self.assertIn("Ways to contribute", get_involved_page)

            contributing_guidelines_page = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "community"
                / "contributing-guidelines.md"
            ).read_text(encoding="utf-8")
            self.assertIn(
                "title: Contributing Guidelines", contributing_guidelines_page
            )
            self.assertIn("apache/buildish", contributing_guidelines_page)
            self.assertIn(
                "For the Buildish site repository, a good baseline is:",
                contributing_guidelines_page,
            )
            self.assertIn(
                "https://www.apache.org/legal/generative-tooling.html",
                contributing_guidelines_page,
            )

            community_guidelines_page = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "community"
                / "community-guidelines.md"
            ).read_text(encoding="utf-8")
            self.assertIn("title: Community Guidelines", community_guidelines_page)
            self.assertIn("ASF Code of Conduct", community_guidelines_page)
            self.assertIn("Apache Way", community_guidelines_page)

            staged_doc = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "mammoth-cache"
                / "development"
                / "docs"
                / "wrapper-provisioning.md"
            ).read_text(encoding="utf-8")
            self.assertNotIn("\n# Wrapper provisioning\n", staged_doc)

            preview_index = (repo_root / "site" / ".preview" / "index.html").read_text(
                encoding="utf-8"
            )
            self.assertIn("Apache Project Site", preview_index)
            self.assertIn("Mammoth Cache for Gradle® and Apache Maven™", preview_index)
            self.assertIn("Site", preview_index)

            version_metadata_path = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "mammoth-cache"
                / "development"
                / "version.yaml"
            )
            version_metadata = version_metadata_path.read_text(encoding="utf-8")
            version_payload = self.load_yaml(version_metadata_path)
            self.assertIn("metadataLoaded: true", version_metadata)
            self.assertIn("metadataFile: site/component.yaml", version_metadata)
            self.assertIn("label: Preview", version_metadata)
            self.assertIn(
                "path: /components/mammoth-cache/development/", version_metadata
            )
            self.assertIn(
                "docsPath: /components/mammoth-cache/development/docs/", version_metadata
            )
            self.assertIn("defaultBranch: trunk", version_metadata)
            self.assertIn("assetsRoot: site/assets", version_metadata)
            self.assertIn("count: 1", version_metadata)
            self.assertIn(
                "path: /components/mammoth-cache/development/assets/", version_metadata
            )
            self.assertEqual("mammoth-cache", version_payload["component"]["slug"])
            self.assertEqual("Preview", version_payload["version"]["label"])
            self.assertEqual("site/component.yaml", version_payload["source"]["metadataFile"])
            self.assertTrue(version_payload["source"]["metadataLoaded"])
            self.assertEqual("site/pages", version_payload["source"]["pagesRoot"])
            self.assertEqual("site/assets", version_payload["source"]["assetsRoot"])
            self.assertEqual(1, version_payload["assets"]["count"])

            lifecycle_metadata_path = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "mammoth-cache"
                / "lifecycle.yaml"
            )
            lifecycle_metadata = lifecycle_metadata_path.read_text(encoding="utf-8")
            lifecycle_payload = self.load_yaml(lifecycle_metadata_path)
            self.assertIn("version: v1.3.5", lifecycle_metadata)
            self.assertIn("line: v1", lifecycle_metadata)
            self.assertIn("status: maintained", lifecycle_metadata)
            self.assertIn("- v1", lifecycle_metadata)
            self.assertIn(
                "docsPath: /components/mammoth-cache/development/docs/",
                lifecycle_metadata,
            )
            self.assertEqual("mammoth-cache", lifecycle_payload["component"]["slug"])
            self.assertEqual(
                "v1.3.5", lifecycle_payload["lifecycle"]["latestStable"]["version"]
            )
            self.assertEqual("v1", lifecycle_payload["lifecycle"]["releaseLines"][0]["line"])
            self.assertEqual(["v1"], lifecycle_payload["lifecycle"]["releaseLines"][0]["aliases"])

            aggregated_lifecycle_path = repo_root / "site" / ".stage" / "data" / "lifecycle.yaml"
            aggregated_lifecycle = aggregated_lifecycle_path.read_text(encoding="utf-8")
            lifecycle_data = self.load_yaml(aggregated_lifecycle_path)
            self.assertIn("latestStable: v1.3.5", aggregated_lifecycle)
            self.assertIn("line: v1.2", aggregated_lifecycle)
            self.assertIn(
                "docsPath: /components/mammoth-cache/development/docs/",
                aggregated_lifecycle,
            )
            self.assertEqual(
                "v1.3.5", lifecycle_data["components"]["mammoth-cache"]["latestStable"]
            )
            self.assertEqual(
                "Preview",
                lifecycle_data["components"]["mammoth-cache"]["development"]["label"],
            )

            components_data = self.load_yaml(repo_root / "site" / ".stage" / "data" / "components.yaml")
            self.assertEqual(
                "/components/mammoth-cache/",
                components_data["components"]["mammoth-cache"]["componentPath"],
            )
            self.assertEqual(
                "/components/mammoth-cache/development/docs/",
                components_data["components"]["mammoth-cache"]["docsPath"],
            )
            self.assertEqual(
                "/components/site/", components_data["components"]["site"]["componentPath"]
            )

            aliases_path = repo_root / "site" / ".stage" / "data" / "aliases.yaml"
            aliases = aliases_path.read_text(encoding="utf-8")
            aliases_data = self.load_yaml(aliases_path)
            self.assertIn("alias: v1", aliases)
            self.assertIn("target: v1.3.5", aliases)
            self.assertEqual(
                "v1", aliases_data["components"]["mammoth-cache"]["aliases"][0]["alias"]
            )
            self.assertEqual(
                "v1.3.5",
                aliases_data["components"]["mammoth-cache"]["aliases"][0]["target"],
            )

            manifest_document = self.load_yaml(repo_root / "site" / ".stage" / "manifest.yaml")
            self.assertEqual(str(repo_root), manifest_document["repoRoot"])
            self.assertEqual("mammoth-cache", manifest_document["components"][0]["slug"])

            no_wrapper_component_index = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "no-gradle-wrapper-jar"
                / "_index.md"
            ).read_text(encoding="utf-8")
            self.assertIn("weight: 5", no_wrapper_component_index)
            self.assertNotIn("linkTitle:", no_wrapper_component_index)
            self.assertIn(
                "Helper scripts for Gradle wrapper usage.", no_wrapper_component_index
            )
            self.assertIn(
                "keeps wrapper bootstrapping lean", no_wrapper_component_index
            )

            site_component_index = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "site"
                / "_index.md"
            ).read_text(encoding="utf-8")
            self.assertIn("title: Buildish Site", site_component_index)
            self.assertIn("weight: 100", site_component_index)
            self.assertIn(
                "Buildish site publishing and shared documentation tooling.",
                site_component_index,
            )
            self.assertNotIn(
                "Site implementation and infrastructure docs.", site_component_index
            )

            site_development_index = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "site"
                / "development"
                / "_index.md"
            ).read_text(encoding="utf-8")
            self.assertIn("## Docs", site_development_index)
            self.assertIn(
                "[Apache Buildish Site Documentation](/components/site/development/docs/)",
                site_development_index,
            )
            self.assertNotIn("Open staged assets", site_development_index)

            site_version_metadata_path = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "site"
                / "development"
                / "version.yaml"
            )
            site_version_metadata = site_version_metadata_path.read_text(encoding="utf-8")
            site_version_payload = self.load_yaml(site_version_metadata_path)
            self.assertIn(
                "docsPath: /components/site/development/docs/", site_version_metadata
            )
            self.assertIn("pagesRoot: site/pages", site_version_metadata)
            self.assertIn("assetsRoot: site/assets", site_version_metadata)
            self.assertIn("count: 0", site_version_metadata)
            self.assertEqual("site/pages", site_version_payload["source"]["pagesRoot"])
            self.assertEqual("site/assets", site_version_payload["source"]["assetsRoot"])

    def test_rejects_metadata_path_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site").mkdir()
            self.write_yaml(
                repo_root / "site" / "components.yaml",
                self.catalog_payload(
                    {"slug": "mammoth-cache", "localDir": "buildish-mammoth-cache"},
                    defaults={
                        "metadataFile": "site/component.yaml",
                        "pagesRoot": "site/pages",
                        "docsRoot": "site/docs",
                    },
                ),
            )

            mammoth = workspace / "buildish-mammoth-cache"
            write_files(
                mammoth,
                {
                    "site/pages/_index.md": text_block(
                        """
                        # Bad metadata

                        Landing page.
                        """
                    )
                },
            )
            self.write_yaml(
                mammoth / "site" / "component.yaml",
                {
                    "schemaVersion": 1,
                    "component": {"displayName": "Bad metadata"},
                    "content": {"docsRoot": "../escape"},
                },
            )

            result = self.run_pipeline_build(repo_root)
            self.assert_command_failed(result, "escapes allowed root")

    def test_rejects_component_escape_outside_workspace_parent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            (repo_root / "site").mkdir(parents=True)
            self.write_yaml(
                repo_root / "site" / "components.yaml",
                self.catalog_payload(
                    {
                        "slug": "bad-component",
                        "displayName": "Bad",
                        "localDir": "../escape",
                    },
                    defaults={
                        "metadataFile": "site/component.yaml",
                        "pagesRoot": "site/pages",
                        "docsRoot": "site/docs",
                    },
                ),
            )

            result = self.run_pipeline_build(repo_root)
            self.assert_command_failed(result, "escapes allowed root")

    def test_rejects_local_override_escape_outside_workspace_parent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            (repo_root / "site").mkdir(parents=True)
            self.write_yaml(
                repo_root / "site" / "components.yaml",
                self.catalog_payload(
                    {"slug": "mammoth-cache", "localDir": "buildish-mammoth-cache"}
                ),
            )
            self.write_yaml(
                repo_root / "site" / "components.local.yaml",
                self.local_overrides_payload(
                    components={"mammoth-cache": {"checkoutDir": "../../escape"}}
                ),
            )

            result = self.run_pipeline_build(repo_root)
            self.assert_command_failed(result, "escapes allowed root")

    def test_build_uses_components_local_yaml_checkout_override(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site").mkdir()
            self.write_yaml(
                repo_root / "site" / "components.yaml",
                self.catalog_payload(
                    {"slug": "mammoth-cache", "localDir": "buildish-mammoth-cache"},
                    defaults={
                        "metadataFile": "site/component.yaml",
                        "pagesRoot": "site/pages",
                        "docsRoot": "site/docs",
                    },
                ),
            )
            self.write_yaml(
                repo_root / "site" / "components.local.yaml",
                self.local_overrides_payload(
                    components={
                        "mammoth-cache": {"checkoutDir": "../src/mammoth-cache"}
                    }
                ),
            )

            mammoth = workspace / "src" / "mammoth-cache"
            write_files(
                mammoth,
                {
                    "site/pages/_index.md": text_block(
                        """
                        # Mammoth

                        Landing page.
                        """
                    ),
                    "site/docs/_index.md": text_block(
                        """
                        # Overview

                        Docs landing page.
                        """
                    ),
                },
            )
            self.write_yaml(
                mammoth / "site" / "component.yaml",
                {"schemaVersion": 1, "component": {"displayName": "Mammoth"}},
            )
            self.seed_authored_site_content(repo_root)

            result = self.run_pipeline_build(repo_root)
            self.assert_command_succeeded(result)
            components_data = self.load_yaml(
                repo_root / "site" / ".stage" / "data" / "components.yaml"
            )
            self.assertEqual(
                "buildish-mammoth-cache",
                components_data["components"]["mammoth-cache"]["localDir"],
            )
            self.assert_paths_exist(
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
                / "content"
                / "components"
                / "mammoth-cache"
                / "development"
                / "docs"
                / "_index.md",
            )

    def test_rejects_assets_path_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site").mkdir(parents=True)
            self.write_yaml(
                repo_root / "site" / "components.yaml",
                self.catalog_payload(
                    {"slug": "mammoth-cache", "localDir": "buildish-mammoth-cache"},
                    defaults=self.default_catalog_defaults(),
                ),
            )

            mammoth = workspace / "buildish-mammoth-cache"
            write_files(
                mammoth,
                {
                    "site/pages/_index.md": text_block(
                        """
                        # Bad assets metadata

                        Landing page.
                        """
                    )
                },
            )
            self.write_yaml(
                mammoth / "site" / "component.yaml",
                {
                    "schemaVersion": 1,
                    "component": {"displayName": "Bad assets metadata"},
                    "content": {"assetsRoot": "../escape"},
                },
            )

            result = self.run_pipeline_build(repo_root)
            self.assert_command_failed(result, "escapes allowed root")

    def test_build_stages_vendor_assets_when_available(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site").mkdir()
            self.write_yaml(
                repo_root / "site" / "components.yaml", self.catalog_payload()
            )
            self.seed_docsy_vendor_assets(repo_root)

            result = self.run_pipeline_build(repo_root)
            self.assert_command_succeeded(result)

            self.assert_paths_exist(
                repo_root
                / "site"
                / ".stage"
                / "static"
                / "js"
                / "vendor"
                / "jquery.min.js",
                repo_root
                / "site"
                / ".stage"
                / "static"
                / "js"
                / "vendor"
                / "mermaid.min.js",
                repo_root
                / "site"
                / ".stage"
                / "static"
                / "js"
                / "vendor"
                / "lunr.min.js",
            )

    def test_build_reads_site_title_and_project_status_from_config_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site").mkdir(parents=True)
            self.seed_authored_site_content(repo_root)
            self.write_yaml(
                repo_root / "site" / "site-pipeline.yaml",
                {
                    "schemaVersion": 1,
                    "site": {
                        "siteTitle": "Example Buildish",
                        "projectStatus": "retired",
                    },
                },
            )
            self.write_yaml(
                repo_root / "site" / "components.yaml",
                self.catalog_payload(
                    {"slug": "mammoth-cache", "localDir": "buildish-mammoth-cache"},
                    defaults={
                        "metadataFile": "site/component.yaml",
                        "pagesRoot": "site/pages",
                        "docsRoot": "site/docs",
                    },
                ),
            )

            mammoth = workspace / "buildish-mammoth-cache"
            write_files(
                mammoth,
                {
                    "site/pages/_index.md": text_block(
                        """
                        # Overview

                        Landing page.
                        """
                    ),
                    "site/docs/_index.md": text_block(
                        """
                        # Overview

                        Hello.
                        """
                    ),
                },
            )
            self.write_yaml(
                mammoth / "site" / "component.yaml",
                {"schemaVersion": 1, "component": {"displayName": "Mammoth Cache"}},
            )

            result = self.run_pipeline_build(repo_root)
            self.assert_command_succeeded(result)

            staged_root_index = (
                repo_root / "site" / ".stage" / "content" / "_index.md"
            ).read_text(encoding="utf-8")
            root_front_matter = yaml.safe_load(staged_root_index.split("---", 2)[1])
            self.assertEqual("Example Buildish", root_front_matter["title"])
            self.assertEqual(
                "retired", root_front_matter["sitePipeline"]["projectStatus"]
            )

            staged_component_index = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "mammoth-cache"
                / "_index.md"
            ).read_text(encoding="utf-8")
            component_front_matter = yaml.safe_load(
                staged_component_index.split("---", 2)[1]
            )
            self.assertEqual(
                "Example Buildish", component_front_matter["sitePipeline"]["siteTitle"]
            )
            self.assertEqual(
                "retired", component_front_matter["sitePipeline"]["projectStatus"]
            )

            preview_index = (repo_root / "site" / ".preview" / "index.html").read_text(
                encoding="utf-8"
            )
            self.assertIn("Example Buildish", preview_index)

    def test_build_reads_catalog_path_from_config_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site" / "catalogs").mkdir(parents=True)
            self.seed_authored_site_content(repo_root)
            self.write_yaml(
                repo_root / "site" / "site-pipeline.yaml",
                {
                    "schemaVersion": 1,
                    "workspace": {"catalogPath": "site/catalogs/components.yaml"},
                },
            )
            self.write_yaml(
                repo_root / "site" / "catalogs" / "components.yaml",
                self.catalog_payload(
                    {"slug": "mammoth-cache", "localDir": "buildish-mammoth-cache"},
                    defaults=self.default_catalog_defaults(),
                ),
            )

            mammoth = workspace / "buildish-mammoth-cache"
            write_files(
                mammoth,
                {
                    "site/pages/_index.md": text_block(
                        """
                        # Overview

                        Landing page.
                        """
                    ),
                    "site/docs/_index.md": text_block(
                        """
                        # Overview

                        Hello.
                        """
                    ),
                },
            )
            self.write_yaml(
                mammoth / "site" / "component.yaml",
                {"schemaVersion": 1, "component": {"displayName": "Mammoth Cache"}},
            )

            result = self.run_pipeline_build(repo_root)
            self.assert_command_succeeded(result)
            manifest_document = self.load_yaml(repo_root / "site" / ".stage" / "manifest.yaml")
            self.assertEqual(["mammoth-cache"], [component["slug"] for component in manifest_document["components"]])
            self.assertTrue(
                (
                    repo_root
                    / "site"
                    / ".stage"
                    / "content"
                    / "components"
                    / "mammoth-cache"
                    / "_index.md"
                ).is_file()
            )

    def test_build_rejects_config_paths_outside_repo_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site").mkdir(parents=True)
            outside_config = workspace / "outside.yaml"
            self.write_yaml(
                outside_config,
                {"schemaVersion": 1, "site": {"projectStatus": "graduated"}},
            )

            result = self.run_pipeline_build(repo_root, "--config", str(outside_config))
            self.assert_command_failed(
                result, "Config path must stay within the repository root"
            )

    def test_build_rejects_catalog_paths_outside_repo_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            outside_catalog = workspace / "outside.yaml"
            self.write_yaml(outside_catalog, self.catalog_payload())

            result = self.run_pipeline_build(repo_root, "--catalog", str(outside_catalog))
            self.assert_command_failed(
                result, "Catalog path must stay within the repository root"
            )

    def test_build_rejects_stage_paths_outside_repo_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site").mkdir(parents=True)
            self.write_yaml(repo_root / "site" / "components.yaml", self.catalog_payload())

            result = self.run_pipeline_build(repo_root, "--stage-path", "../outside-stage")
            self.assert_command_failed(
                result, "Stage output path must stay within the repository root"
            )

    def test_build_rejects_output_path_overlapping_protected_site_source_root(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            write_files(
                repo_root,
                {
                    "site/components.yaml": text_block(
                        """
                        schemaVersion: 1
                        components: []
                        """
                    ),
                    "site/layouts/home.html": "{{ define \"main\" }}Home{{ end }}\n",
                },
            )

            result = self.run_pipeline_build(repo_root, "--stage-path", "site/layouts")
            self.assert_command_failed(
                result,
                "Stage output path must not overlap with protected site source root",
            )

    def test_clean_removes_configured_output_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir) / "buildish"
            (repo_root / "site").mkdir(parents=True)
            self.write_yaml(
                repo_root / "site" / "site-pipeline.yaml",
                {
                    "schemaVersion": 1,
                    "workspace": {
                        "stagePath": "build/site-stage",
                        "previewPath": "build/site-preview",
                    },
                },
            )
            write_files(
                repo_root,
                {
                    "build/site-stage/manifest.yaml": "schemaVersion: 1\n",
                    "build/site-preview/index.html": "<html></html>\n",
                },
            )

            result = self.run_pipeline_clean(
                repo_root, "--config", "site/site-pipeline.yaml"
            )
            self.assert_command_succeeded(result)

            self.assertFalse((repo_root / "build" / "site-stage").exists())
            self.assertFalse((repo_root / "build" / "site-preview").exists())

    def test_build_rejects_reserved_component_pages_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site").mkdir()
            self.write_yaml(
                repo_root / "site" / "components.yaml",
                self.catalog_payload(
                    {"slug": "mammoth-cache", "localDir": "buildish-mammoth-cache"},
                    defaults={"pagesRoot": "site/pages", "docsRoot": "site/docs"},
                ),
            )

            mammoth = workspace / "buildish-mammoth-cache"
            write_files(
                mammoth,
                {
                    "site/pages/_index.md": text_block(
                        """
                        # Mammoth Cache for Gradle® and Apache Maven™

                        Landing page.
                        """
                    ),
                    "site/pages/development/overview.md": text_block(
                        """
                        # Bad path
                        """
                    ),
                },
            )

            result = self.run_pipeline_build(repo_root)
            self.assert_command_failed(result, "reserved staged path")

