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
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from pipeline import apache_buildish_site_pipeline as site_pipeline
from pipeline.apache_buildish_site_pipeline.filesystem import load_component_metadata
from pipeline.apache_buildish_site_pipeline.markdown import (
    update_markdown_front_matter,
    with_yaml_front_matter,
)
from pipeline.apache_buildish_site_pipeline.models import (
    AliasesDataDocument,
    ComponentsLocalOverrides,
    DocsFrontMatter,
    LifecycleDataDocument,
    LifecycleLatestStable,
    LifecycleUnreleased,
    ManifestDocument,
    ComponentLifecycleDocument,
    ComponentsCatalog,
    ComponentsDataDocument,
    ComponentVersionDocument,
    SitePipelineComponentPagePayload,
    SitePipelineComponentPaths,
    SitePipelineComponentPayload,
    SitePipelineComponentUnreleased,
    StagedReleaseLine,
    VersionDescriptor,
)
from pipeline.tests.test_support import (
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
    def seed_authored_site_content(repo_root: Path) -> None:
        source_content = Path(__file__).resolve().parents[2] / "content"
        shutil.copytree(
            source_content, repo_root / "site" / "content", dirs_exist_ok=True
        )

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

    def test_staged_release_line_to_yaml_data_omits_empty_aliases_and_null_path(
        self,
    ) -> None:
        payload = StagedReleaseLine(
            line="v1", latest="v1.2.3", status="maintained"
        ).to_yaml_data()

        self.assertEqual(
            {"line": "v1", "latest": "v1.2.3", "status": "maintained"}, payload
        )

    def test_staged_section_to_yaml_data_omits_null_optional_fields(self) -> None:
        self.assertEqual(
            {
                "kind": "unreleased",
                "label": "Preview",
                "path": "/components/foo/unreleased/",
            },
            VersionDescriptor(
                kind="unreleased", label="Preview", path="/components/foo/unreleased/"
            ).to_yaml_data(),
        )
        self.assertEqual(
            {"label": "Preview", "path": "/components/foo/unreleased/"},
            LifecycleUnreleased(
                label="Preview", path="/components/foo/unreleased/"
            ).to_yaml_data(),
        )
        self.assertEqual(
            {"version": "v1.2.3"},
            LifecycleLatestStable(version="v1.2.3").to_yaml_data(),
        )

    def test_markdown_front_matter_serializes_typed_component_payload_models(
        self,
    ) -> None:
        markdown = with_yaml_front_matter(
            "Body\n",
            sitePipelineComponent=SitePipelineComponentPayload(
                slug="mammoth-cache",
                display_name="Mammoth Cache for Gradle® and Apache Maven™",
                available=True,
                local_dir="buildish-mammoth-cache",
                paths=SitePipelineComponentPaths(
                    component="/components/mammoth-cache/",
                    unreleased="/components/mammoth-cache/unreleased/",
                ),
                unreleased_label="Preview",
                unreleased=SitePipelineComponentUnreleased(
                    label="Preview", path="/components/mammoth-cache/unreleased/"
                ),
                release_lines=(
                    StagedReleaseLine(line="v1", latest="v1.2.3", status="maintained"),
                ),
            ),
            sitePipelineComponentPage=SitePipelineComponentPagePayload(
                kind="docs-home",
                section="docs",
                path="/components/mammoth-cache/unreleased/docs/",
                component_path="/components/mammoth-cache/",
                version=VersionDescriptor(
                    kind="unreleased",
                    label="Preview",
                    path="/components/mammoth-cache/unreleased/",
                ),
            ),
        )

        front_matter = yaml.safe_load(markdown.split("---", 2)[1])
        self.assertEqual(
            "Mammoth Cache for Gradle® and Apache Maven™",
            front_matter["sitePipelineComponent"]["displayName"],
        )
        self.assertEqual(
            "Preview", front_matter["sitePipelineComponent"]["unreleased"]["label"]
        )
        self.assertNotIn("latestStable", front_matter["sitePipelineComponent"])
        self.assertEqual("docs-home", front_matter["sitePipelineComponentPage"]["kind"])

    def test_update_markdown_front_matter_rejects_non_mapping_front_matter(
        self,
    ) -> None:
        markdown = "---\n[]\n---\n\nBody\n"

        with self.assertRaisesRegex(
            ValueError, "Expected markdown front matter to be a mapping"
        ):
            update_markdown_front_matter(markdown, title="Body")

    def test_docs_front_matter_to_yaml_data_omits_null_optionals(self) -> None:
        payload = DocsFrontMatter(title="Docs", weight=10).to_yaml_data()

        self.assertEqual({"title": "Docs", "weight": 10, "type": "docs"}, payload)

    def test_components_catalog_from_yaml_path_returns_typed_models(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir) / "buildish"
            (repo_root / "site").mkdir(parents=True)
            self.write_yaml(
                repo_root / "site" / "components.yaml",
                self.catalog_payload(
                    {
                        "slug": "mammoth-cache",
                        "localDir": "buildish-mammoth-cache",
                        "assetsRoot": None,
                        "weight": "7",
                    },
                    defaults=self.default_catalog_defaults(),
                ),
            )

            catalog = ComponentsCatalog.from_yaml_path(
                repo_root / "site" / "components.yaml"
            )

            self.assertEqual(1, catalog.schema_version)
            self.assertEqual("site/component.yaml", catalog.defaults.metadata_file)
            self.assertEqual("site/pages", catalog.defaults.pages_root)
            self.assertEqual("site/docs", catalog.defaults.docs_root)
            self.assertEqual(1, len(catalog.components))
            self.assertEqual("mammoth-cache", catalog.components[0].slug)
            self.assertIsNone(catalog.components[0].assets_root)
            self.assertEqual(7, catalog.components[0].weight)

    def test_components_catalog_from_yaml_path_accepts_null_weight(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir) / "buildish"
            (repo_root / "site").mkdir(parents=True)
            self.write_yaml(
                repo_root / "site" / "components.yaml",
                self.catalog_payload(
                    {
                        "slug": "mammoth-cache",
                        "localDir": "buildish-mammoth-cache",
                        "weight": None,
                    }
                ),
            )

            catalog = ComponentsCatalog.from_yaml_path(
                repo_root / "site" / "components.yaml"
            )

            self.assertIsNone(catalog.components[0].weight)

    def test_components_catalog_from_yaml_path_rejects_null_defaults_and_components(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir) / "buildish"
            (repo_root / "site").mkdir(parents=True)
            self.write_yaml(
                repo_root / "site" / "components.yaml",
                {"schemaVersion": 1, "defaults": None, "components": None},
            )

            with self.assertRaisesRegex(ValueError, "Invalid YAML"):
                ComponentsCatalog.from_yaml_path(repo_root / "site" / "components.yaml")

    def test_components_local_overrides_from_yaml_path_returns_typed_models(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir) / "buildish"
            (repo_root / "site").mkdir(parents=True)
            self.write_yaml(
                repo_root / "site" / "components.local.yaml",
                self.local_overrides_payload(
                    components={
                        "mammoth-cache": {"checkoutDir": "../src/mammoth-cache"}
                    }
                ),
            )

            overrides = ComponentsLocalOverrides.from_yaml_path(
                repo_root / "site" / "components.local.yaml"
            )

            self.assertEqual(1, overrides.schema_version)
            self.assertEqual(
                "../src/mammoth-cache",
                overrides.workspace.components["mammoth-cache"].checkout_dir,
            )

    def test_load_component_metadata_returns_typed_models(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir) / "buildish-mammoth-cache"
            (repo_root / "site").mkdir(parents=True)
            self.write_yaml(
                repo_root / "site" / "component.yaml",
                {
                    "schemaVersion": 1,
                    "component": {
                        "slug": "mammoth-cache",
                        "displayName": "Mammoth Cache for Gradle® and Apache Maven™",
                        "repository": "https://github.com/apache/buildish-mammoth-cache",
                    },
                    "content": {
                        "pagesRoot": "site/pages",
                        "docsRoot": "site/docs",
                        "assetsRoot": None,
                    },
                    "versioning": {
                        "unreleasedLabel": "Preview",
                        "tagPattern": r"^v[0-9]+\.[0-9]+\.[0-9]+$",
                    },
                    "lifecycle": {
                        "latestStable": "v1.2.3",
                        "releaseLines": [
                            {
                                "line": "v1",
                                "latest": "v1.2.3",
                                "status": "maintained",
                                "aliases": ["v1"],
                            },
                            {
                                "line": "v0",
                                "latest": "v0.9.0",
                                "status": "eol",
                                "aliases": ["stable"],
                            },
                        ],
                    },
                    "navigation": {"section": "components"},
                },
            )

            metadata, metadata_path = load_component_metadata(
                repo_root, "site/component.yaml", "mammoth-cache"
            )

            self.assertEqual(repo_root / "site" / "component.yaml", metadata_path)
            self.assertEqual(1, metadata.schema_version)
            self.assertEqual(
                "Mammoth Cache for Gradle® and Apache Maven™",
                metadata.component.display_name,
            )
            self.assertEqual("site/pages", metadata.content.pages_root)
            self.assertEqual("site/docs", metadata.content.docs_root)
            self.assertIsNone(metadata.content.assets_root)
            self.assertEqual("Preview", metadata.versioning.unreleased_label)
            self.assertEqual("v1.2.3", metadata.lifecycle.latest_stable)
            self.assertEqual(2, len(metadata.lifecycle.release_lines))
            self.assertEqual(("v1",), metadata.lifecycle.release_lines[0].aliases)
            self.assertEqual(("stable",), metadata.lifecycle.release_lines[1].aliases)
            self.assertEqual("components", metadata.navigation.section)

    def test_load_component_metadata_rejects_invalid_tag_pattern(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir) / "buildish-mammoth-cache"
            (repo_root / "site").mkdir(parents=True)
            self.write_yaml(
                repo_root / "site" / "component.yaml",
                {"schemaVersion": 1, "versioning": {"tagPattern": "["}},
            )

            with self.assertRaisesRegex(ValueError, "Invalid YAML"):
                load_component_metadata(
                    repo_root, "site/component.yaml", "mammoth-cache"
                )

    def test_load_component_metadata_rejects_invalid_release_line_aliases(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir) / "buildish-mammoth-cache"
            (repo_root / "site").mkdir(parents=True)
            self.write_yaml(
                repo_root / "site" / "component.yaml",
                {
                    "schemaVersion": 1,
                    "lifecycle": {
                        "releaseLines": [
                            {
                                "line": "v1",
                                "latest": "v1.2.3",
                                "status": "maintained",
                                "aliases": "stable",
                            }
                        ]
                    },
                },
            )

            with self.assertRaisesRegex(ValueError, "Invalid YAML"):
                load_component_metadata(
                    repo_root, "site/component.yaml", "mammoth-cache"
                )

    def test_load_component_metadata_rejects_null_nested_sections(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir) / "buildish-mammoth-cache"
            (repo_root / "site").mkdir(parents=True)
            self.write_yaml(
                repo_root / "site" / "component.yaml",
                {
                    "schemaVersion": 1,
                    "component": None,
                    "content": None,
                    "versioning": None,
                    "lifecycle": None,
                    "navigation": None,
                },
            )

            with self.assertRaisesRegex(ValueError, "Invalid YAML"):
                load_component_metadata(
                    repo_root, "site/component.yaml", "mammoth-cache"
                )

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

            site_pipeline.build(repo_root)

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
                / "unreleased"
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
                    "unreleasedLabel": "Unreleased",
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

                        Use the authored component pages for the stable overview and the unreleased docs for implementation details.
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
                    "versioning": {"unreleasedLabel": "Preview"},
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

                        Use the unreleased docs to evaluate planned changes before they ship.
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

            results = site_pipeline.build(repo_root)

            self.assertEqual(3, len(results))
            self.assert_paths_exist(
                repo_root / "site" / ".stage" / "content" / "components" / "_index.md",
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "mammoth-cache"
                / "unreleased"
                / "docs"
                / "wrapper-provisioning.md",
                repo_root
                / "site"
                / ".stage"
                / "static"
                / "components"
                / "mammoth-cache"
                / "unreleased"
                / "assets"
                / "images"
                / "logo.svg",
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "no-gradle-wrapper-jar"
                / "unreleased"
                / "_index.md",
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "site"
                / "unreleased"
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
            self.assertEqual("Apache Buildish (Incubating)", root_front_matter["title"])
            self.assertEqual(
                "Apache Buildish develops build automation, CI integrations, and supporting tooling.",
                root_front_matter["description"],
            )
            self.assertEqual(
                "Apache® is a registered trademark of The Apache Software Foundation. Apache Maven™ and Maven™ are trademarks of The Apache Software Foundation. Gradle® is a registered trademark of Gradle, Inc.",
                root_front_matter["trademark_attribution"],
            )
            self.assertEqual(
                "Apache Buildish (Incubating)",
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
                "Use the unreleased docs to evaluate planned changes before they ship.",
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
                "/components/mammoth-cache/unreleased/docs/",
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

            mammoth_unreleased_index = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "mammoth-cache"
                / "unreleased"
                / "_index.md"
            ).read_text(encoding="utf-8")
            self.assert_contains_all(
                mammoth_unreleased_index,
                "title: Mammoth Cache for Gradle® and Apache Maven™ Preview",
                "linkTitle: Preview",
            )
            self.assert_not_contains_any(
                mammoth_unreleased_index, "\nSecure Gradle wrapper provisioning.\n"
            )
            mammoth_unreleased_front_matter = yaml.safe_load(
                mammoth_unreleased_index.split("---", 2)[1]
            )
            self.assertEqual(
                "unreleased-home",
                mammoth_unreleased_front_matter["sitePipelineComponentPage"]["kind"],
            )

            mammoth_docs_index = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "mammoth-cache"
                / "unreleased"
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
                "/components/mammoth-cache/unreleased/docs/",
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
                / "unreleased"
                / "docs"
                / "wrapper-provisioning.md"
            ).read_text(encoding="utf-8")
            self.assertNotIn("\n# Wrapper provisioning\n", staged_doc)

            preview_index = (repo_root / "site" / ".preview" / "index.html").read_text(
                encoding="utf-8"
            )
            self.assertIn("Apache Buildish (Incubating)", preview_index)
            self.assertIn("Mammoth Cache for Gradle® and Apache Maven™", preview_index)
            self.assertIn("Site", preview_index)

            version_document = ComponentVersionDocument.from_yaml_path(
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "mammoth-cache"
                / "unreleased"
                / "version.yaml"
            )
            version_metadata = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "mammoth-cache"
                / "unreleased"
                / "version.yaml"
            ).read_text(encoding="utf-8")
            self.assertIn("metadataLoaded: true", version_metadata)
            self.assertIn("metadataFile: site/component.yaml", version_metadata)
            self.assertIn("label: Preview", version_metadata)
            self.assertIn(
                "path: /components/mammoth-cache/unreleased/", version_metadata
            )
            self.assertIn(
                "docsPath: /components/mammoth-cache/unreleased/docs/", version_metadata
            )
            self.assertIn("defaultBranch: trunk", version_metadata)
            self.assertIn("assetsRoot: site/assets", version_metadata)
            self.assertIn("count: 1", version_metadata)
            self.assertIn(
                "path: /components/mammoth-cache/unreleased/assets/", version_metadata
            )
            self.assertEqual("mammoth-cache", version_document.component.slug)
            self.assertEqual("Preview", version_document.version.label)
            self.assertEqual(
                "site/component.yaml", version_document.source.metadata_file
            )
            self.assertTrue(version_document.source.metadata_loaded)
            self.assertEqual("site/pages", version_document.source.pages_root)
            self.assertEqual("site/assets", version_document.source.assets_root)
            self.assertEqual(1, version_document.assets.count)

            lifecycle_document = ComponentLifecycleDocument.from_yaml_path(
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "mammoth-cache"
                / "lifecycle.yaml"
            )
            lifecycle_metadata = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "mammoth-cache"
                / "lifecycle.yaml"
            ).read_text(encoding="utf-8")
            self.assertIn("version: v1.3.5", lifecycle_metadata)
            self.assertIn("line: v1", lifecycle_metadata)
            self.assertIn("status: maintained", lifecycle_metadata)
            self.assertIn("- v1", lifecycle_metadata)
            self.assertIn(
                "docsPath: /components/mammoth-cache/unreleased/docs/",
                lifecycle_metadata,
            )
            self.assertEqual("mammoth-cache", lifecycle_document.component.slug)
            self.assertEqual(
                "v1.3.5", lifecycle_document.lifecycle.latest_stable.version
            )
            self.assertEqual("v1", lifecycle_document.lifecycle.release_lines[0].line)
            self.assertEqual(
                ("v1",), lifecycle_document.lifecycle.release_lines[0].aliases
            )

            lifecycle_data = LifecycleDataDocument.from_yaml_path(
                repo_root / "site" / ".stage" / "data" / "lifecycle.yaml"
            )
            aggregated_lifecycle = (
                repo_root / "site" / ".stage" / "data" / "lifecycle.yaml"
            ).read_text(encoding="utf-8")
            self.assertIn("latestStable: v1.3.5", aggregated_lifecycle)
            self.assertIn("line: v1.2", aggregated_lifecycle)
            self.assertIn(
                "docsPath: /components/mammoth-cache/unreleased/docs/",
                aggregated_lifecycle,
            )
            self.assertEqual(
                "v1.3.5", lifecycle_data.components["mammoth-cache"].latest_stable
            )
            self.assertEqual(
                "Preview", lifecycle_data.components["mammoth-cache"].unreleased.label
            )

            components_data = ComponentsDataDocument.from_yaml_path(
                repo_root / "site" / ".stage" / "data" / "components.yaml"
            )
            self.assertEqual(
                "/components/mammoth-cache/",
                components_data.components["mammoth-cache"].component_path,
            )
            self.assertEqual(
                "/components/mammoth-cache/unreleased/docs/",
                components_data.components["mammoth-cache"].docs_path,
            )
            self.assertEqual(
                "/components/site/", components_data.components["site"].component_path
            )

            aliases_data = AliasesDataDocument.from_yaml_path(
                repo_root / "site" / ".stage" / "data" / "aliases.yaml"
            )
            aliases = (
                repo_root / "site" / ".stage" / "data" / "aliases.yaml"
            ).read_text(encoding="utf-8")
            self.assertIn("alias: v1", aliases)
            self.assertIn("target: v1.3.5", aliases)
            self.assertEqual(
                "v1", aliases_data.components["mammoth-cache"].aliases[0].alias
            )

            manifest_document = ManifestDocument.from_yaml_path(
                repo_root / "site" / ".stage" / "manifest.yaml"
            )
            self.assertEqual(str(repo_root), manifest_document.repo_root)
            self.assertEqual("mammoth-cache", manifest_document.components[0].slug)

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

            site_unreleased_index = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "site"
                / "unreleased"
                / "_index.md"
            ).read_text(encoding="utf-8")
            self.assertIn("## Docs", site_unreleased_index)
            self.assertIn(
                "[Apache Buildish Site Documentation](/components/site/unreleased/docs/)",
                site_unreleased_index,
            )
            self.assertNotIn("Open staged assets", site_unreleased_index)

            site_version_document = ComponentVersionDocument.from_yaml_path(
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "site"
                / "unreleased"
                / "version.yaml"
            )
            site_version_metadata = (
                repo_root
                / "site"
                / ".stage"
                / "content"
                / "components"
                / "site"
                / "unreleased"
                / "version.yaml"
            ).read_text(encoding="utf-8")
            self.assertIn(
                "docsPath: /components/site/unreleased/docs/", site_version_metadata
            )
            self.assertIn("pagesRoot: site/pages", site_version_metadata)
            self.assertIn("assetsRoot: site/assets", site_version_metadata)
            self.assertIn("count: 0", site_version_metadata)
            self.assertEqual("site/pages", site_version_document.source.pages_root)
            self.assertEqual("site/assets", site_version_document.source.assets_root)

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

            with self.assertRaisesRegex(ValueError, "escapes allowed root"):
                site_pipeline.build(repo_root)

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

            with self.assertRaisesRegex(ValueError, "escapes allowed root"):
                site_pipeline.build(repo_root)

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

            with self.assertRaisesRegex(ValueError, "escapes allowed root"):
                site_pipeline.build(repo_root)

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

            results = site_pipeline.build(repo_root)

            self.assertEqual(
                (workspace / "src" / "mammoth-cache").resolve(), results[0].repo_path
            )
            self.assertEqual("buildish-mammoth-cache", results[0].local_dir)
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
                / "unreleased"
                / "docs"
                / "_index.md",
            )

    def test_collect_watch_roots_uses_components_local_yaml_checkout_override(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            write_files(
                repo_root,
                {
                    "site/pipeline/main.py": text_block(
                        """
                        raise SystemExit(0)
                        """
                    ),
                    "site/pipeline/pyproject.toml": text_block(
                        """
                        [project]
                        name='stub'
                        """
                    ),
                    "site/pipeline/uv.lock": text_block(
                        """
                        version = 1
                        """
                    ),
                    "site/pipeline/apache_buildish_site_pipeline/__init__.py": text_block(
                        """
                        # watcher stub
                        """
                    ),
                },
            )
            (repo_root / "site" / "content").mkdir(parents=True)
            self.write_yaml(
                repo_root / "site" / "components.yaml",
                self.catalog_payload(
                    {"slug": "mammoth-cache", "localDir": "buildish-mammoth-cache"},
                    defaults=self.default_catalog_defaults(),
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
                    )
                },
            )
            (mammoth / "site" / "docs").mkdir(parents=True)
            (mammoth / "site" / "assets").mkdir(parents=True)
            self.write_yaml(
                mammoth / "site" / "component.yaml",
                {"schemaVersion": 1, "component": {"displayName": "Mammoth"}},
            )

            watch_roots = set(site_pipeline.collect_watch_roots(repo_root))

            self.assertIn(
                (repo_root / "site" / "components.local.yaml").resolve(), watch_roots
            )
            self.assertIn((mammoth / "site" / "component.yaml").resolve(), watch_roots)
            self.assertIn((mammoth / "site" / "pages").resolve(), watch_roots)
            self.assertIn((mammoth / "site" / "docs").resolve(), watch_roots)
            self.assertIn((mammoth / "site" / "assets").resolve(), watch_roots)

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

            with self.assertRaisesRegex(ValueError, "escapes allowed root"):
                site_pipeline.build(repo_root)

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

            site_pipeline.build(repo_root)

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

    def test_extract_title_and_summary_ignores_headings_inside_fenced_code_blocks(
        self,
    ) -> None:
        markdown = """<!--\ncomment\n-->\n\nThis page currently carries content moved from the component README.\n\n```yaml\n# .github/buildish-mammoth.yml\njob-mode: distributed-worker\n```\n\n## Next section\n"""

        title, summary = site_pipeline.extract_title_and_summary(
            markdown, "[FROM README] Usage examples"
        )

        self.assertEqual("[FROM README] Usage examples", title)
        self.assertEqual(
            "Temporary home for usage examples.",
            site_pipeline.normalize_markdown_doc(
                '---\ntitle: "[FROM README] Usage examples"\ndescription: Temporary home for usage examples.\n---\n\n'
                + markdown,
                "Usage examples",
                type="docs",
            )[2],
        )

    def test_normalize_markdown_doc_strips_auto_promoted_summary_from_body(
        self,
    ) -> None:
        markdown = """<!--\ncomment\n-->\n\n# Bootstrap Process\n\nThis document describes the full execution sequence for both the `prepare` and `finalize` phases.\n\n```mermaid\nflowchart TD\n    A --> B\n```\n"""

        normalized, title, summary = site_pipeline.normalize_markdown_doc(
            markdown, "Bootstrap Process", type="docs"
        )

        self.assertEqual("Bootstrap Process", title)
        self.assertEqual(
            "This document describes the full execution sequence for both the `prepare` and `finalize` phases.",
            summary,
        )
        self.assertIn(
            "description: This document describes the full execution sequence",
            normalized,
        )
        self.assertNotIn("# Bootstrap Process", normalized)
        self.assertNotIn(
            "This document describes the full execution sequence for both the `prepare` and `finalize` phases.\n\n```mermaid",
            normalized,
        )
        self.assertIn("```mermaid", normalized)

    def test_normalize_markdown_doc_strips_asf_header_comment_h1_and_summary(
        self,
    ) -> None:
        markdown = """<!--
Copyright 2026 The Apache Software Foundation

Licensed under the Apache License, Version 2.0 (the \"License\");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an \"AS IS\" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# Bootstrap Process

This document describes the full execution sequence for both the `prepare` and `finalize` phases,
covering input resolution, config normalization, cache model creation, wrapper provisioning,
single-run guarding, and the state that flows between phases.

## Two-phase execution model

Additional details.
"""

        normalized, title, summary = site_pipeline.normalize_markdown_doc(
            markdown, "Fallback Title", type="docs"
        )

        self.assertEqual("Bootstrap Process", title)
        self.assertEqual(
            "This document describes the full execution sequence for both the `prepare` and `finalize` phases, covering input resolution, config normalization, cache model creation, wrapper provisioning, single-run guarding, and the state that flows between phases.",
            summary,
        )
        self.assertIn(
            "description: This document describes the full execution sequence",
            normalized,
        )
        self.assertNotIn("Copyright 2026 The Apache Software Foundation", normalized)
        self.assertNotIn("# Bootstrap Process", normalized)
        self.assertIn("## Two-phase execution model", normalized)

    def test_normalize_markdown_doc_supports_setext_h1_titles(self) -> None:
        markdown = """Bootstrap Process
=================

This document describes the full execution sequence for the bootstrap path.

## Next section

Additional details.
"""

        normalized, title, summary = site_pipeline.normalize_markdown_doc(
            markdown, "Fallback Title", type="docs"
        )

        self.assertEqual("Bootstrap Process", title)
        self.assertEqual(
            "This document describes the full execution sequence for the bootstrap path.",
            summary,
        )
        self.assertNotIn("=================", normalized)
        self.assertNotIn(
            "This document describes the full execution sequence for the bootstrap path.\n\n## Next section",
            normalized,
        )
        self.assertIn("## Next section", normalized)

    def test_build_can_skip_preview_generation_in_watch_mode(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            (repo_root / "site").mkdir(parents=True)
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
                {
                    "schemaVersion": 1,
                    "component": {
                        "displayName": "Mammoth Cache for Gradle® and Apache Maven™"
                    },
                },
            )

            preview_sentinel = repo_root / "site" / ".preview" / "keep.txt"
            preview_sentinel.parent.mkdir(parents=True, exist_ok=True)
            preview_sentinel.write_text("preserve me\n", encoding="utf-8")

            results = site_pipeline.build(repo_root, include_preview=False)

            self.assertEqual(1, len(results))
            self.assert_paths_exist(repo_root / "site" / ".stage" / "manifest.yaml")
            self.assert_paths_exist(preview_sentinel)
            self.assertEqual(
                "preserve me\n", preview_sentinel.read_text(encoding="utf-8")
            )
            self.assertFalse((repo_root / "site" / ".preview" / "index.html").exists())

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

            site_pipeline.build(repo_root)

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

            with self.assertRaisesRegex(
                ValueError, "Config path must stay within the repository root"
            ):
                site_pipeline.build(repo_root, config_path=outside_config)

    def test_collect_watch_roots_includes_catalog_component_inputs_and_missing_repo_parent(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "buildish"
            repo_root.mkdir()
            write_files(
                repo_root,
                {
                    "site/pipeline/main.py": text_block(
                        """
                        raise SystemExit(0)
                        """
                    ),
                    "site/pipeline/pyproject.toml": text_block(
                        """
                        [project]
                        name='stub'
                        """
                    ),
                    "site/pipeline/uv.lock": text_block(
                        """
                        version = 1
                        """
                    ),
                    "site/pipeline/apache_buildish_site_pipeline/__init__.py": text_block(
                        """
                        # watcher stub
                        """
                    ),
                },
            )
            (repo_root / "site" / "content").mkdir(parents=True)
            self.write_yaml(
                repo_root / "site" / "site-pipeline.yaml",
                {"schemaVersion": 1, "site": {"projectStatus": "incubating"}},
            )
            (repo_root / "site" / "pipeline" / ".venv" / "bin").mkdir(parents=True)
            (repo_root / "site" / "pipeline" / ".idea").mkdir(parents=True)
            self.write_yaml(
                repo_root / "site" / "components.yaml",
                self.catalog_payload(
                    {"slug": "mammoth-cache", "localDir": "buildish-mammoth-cache"},
                    {
                        "slug": "missing-component",
                        "localDir": "buildish-missing-component",
                    },
                    defaults=self.default_catalog_defaults(),
                ),
            )

            mammoth = workspace / "buildish-mammoth-cache"
            write_files(
                mammoth,
                {
                    "site/pages/_index.md": text_block(
                        """
                        # Mammoth

                        Landing page.
                        """
                    )
                },
            )
            (mammoth / "site" / "docs").mkdir(parents=True)
            (mammoth / "site" / "assets").mkdir(parents=True)
            self.write_yaml(
                mammoth / "site" / "component.yaml",
                {"schemaVersion": 1, "component": {"displayName": "Mammoth"}},
            )

            watch_roots = set(site_pipeline.collect_watch_roots(repo_root))

            self.assertIn(
                (repo_root / "site" / "components.yaml").resolve(), watch_roots
            )
            self.assertIn(
                (repo_root / "site" / "site-pipeline.yaml").resolve(), watch_roots
            )
            self.assertIn((repo_root / "site" / "content").resolve(), watch_roots)
            self.assertIn(
                (repo_root / "site" / "pipeline" / "main.py").resolve(), watch_roots
            )
            self.assertIn(
                (repo_root / "site" / "pipeline" / "pyproject.toml").resolve(),
                watch_roots,
            )
            self.assertIn(
                (repo_root / "site" / "pipeline" / "uv.lock").resolve(), watch_roots
            )
            self.assertIn(
                (
                    repo_root / "site" / "pipeline" / "apache_buildish_site_pipeline"
                ).resolve(),
                watch_roots,
            )
            self.assertIn((mammoth / "site" / "component.yaml").resolve(), watch_roots)
            self.assertIn((mammoth / "site" / "pages").resolve(), watch_roots)
            self.assertIn((mammoth / "site" / "docs").resolve(), watch_roots)
            self.assertIn((mammoth / "site" / "assets").resolve(), watch_roots)
            self.assertIn(workspace.resolve(), watch_roots)
            self.assertNotIn((repo_root / "site" / "pipeline").resolve(), watch_roots)
            self.assertNotIn(
                (repo_root / "site" / "pipeline" / ".venv").resolve(), watch_roots
            )
            self.assertNotIn(
                (repo_root / "site" / "pipeline" / ".idea").resolve(), watch_roots
            )

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
                    "site/pages/unreleased/overview.md": text_block(
                        """
                        # Bad path
                        """
                    ),
                },
            )

            with self.assertRaisesRegex(ValueError, "reserved staged path"):
                site_pipeline.build(repo_root)

    def test_is_relevant_watch_path_allows_explicit_vendor_asset_paths(self) -> None:
        self.assertTrue(
            site_pipeline.is_relevant_watch_path(
                Path("site/node_modules/jquery/dist/jquery.min.js")
            )
        )
        self.assertFalse(
            site_pipeline.is_relevant_watch_path(Path("site/.stage/content/_index.md"))
        )


if __name__ == "__main__":
    unittest.main()
