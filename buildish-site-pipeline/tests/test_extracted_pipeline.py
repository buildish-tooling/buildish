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

"""Self-contained tests for the extracted site-pipeline package."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
import sys

import apache_buildish_site_pipeline as site_pipeline
from apache_buildish_site_pipeline.filesystem import repo_root_from
from apache_buildish_site_pipeline.filesystem import load_component_metadata

from tests.test_support import dump_yaml, text_block, write_files


class ExtractedSitePipelineTest(unittest.TestCase):
    def test_load_component_metadata_returns_typed_models(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir) / "mammoth-cache"
            dump_yaml(
                repo_root / "site" / "component.yaml",
                {
                    "schemaVersion": 1,
                    "component": {"displayName": "Mammoth Cache"},
                    "content": {"pagesRoot": "site/pages", "docsRoot": "site/docs"},
                    "versioning": {"developmentLabel": "Preview"},
                    "navigation": {"section": "components"},
                },
            )

            metadata, metadata_path = load_component_metadata(
                repo_root, "site/component.yaml", "mammoth-cache"
            )

            self.assertEqual(repo_root / "site" / "component.yaml", metadata_path)
            self.assertEqual("Mammoth Cache", metadata.component.display_name)
            self.assertEqual("site/pages", metadata.content.pages_root)
            self.assertEqual("Preview", metadata.versioning.development_label)
            self.assertEqual("components", metadata.navigation.section)

    def test_load_component_metadata_accepts_legacy_unreleased_label(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir) / "mammoth-cache"
            dump_yaml(
                repo_root / "site" / "component.yaml",
                {"schemaVersion": 1, "versioning": {"unreleasedLabel": "Unreleased"}},
            )

            metadata, _ = load_component_metadata(
                repo_root, "site/component.yaml", "mammoth-cache"
            )

            self.assertEqual("Unreleased", metadata.versioning.development_label)

    def test_build_reads_workspace_paths_from_config_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = workspace / "consumer"
            dump_yaml(
                repo_root / "site" / "site-pipeline.yaml",
                {
                    "schemaVersion": 1,
                    "workspace": {
                        "authoredSiteContentPath": "docs-src",
                        "stagePath": "build/site-stage",
                        "previewPath": "build/site-preview",
                    },
                },
            )
            dump_yaml(
                repo_root / "site" / "components.yaml",
                {
                    "schemaVersion": 1,
                    "defaults": {
                        "metadataFile": "site/component.yaml",
                        "pagesRoot": "site/pages",
                        "docsRoot": "site/docs",
                        "assetsRoot": "site/assets",
                    },
                    "components": [{"slug": "mammoth-cache", "localDir": "mammoth-cache"}],
                },
            )
            write_files(
                repo_root,
                {"docs-src/_index.md": text_block("""
                # Root

                Consumer overview.
                """)},
            )
            write_files(
                workspace / "mammoth-cache",
                {
                    "site/pages/_index.md": text_block("""
                    # Overview

                    Landing page.
                    """),
                    "site/docs/_index.md": text_block("""
                    # Docs

                    Hello.
                    """),
                },
            )
            dump_yaml(
                workspace / "mammoth-cache" / "site" / "component.yaml",
                {"schemaVersion": 1, "component": {"displayName": "Mammoth Cache"}},
            )

            results = site_pipeline.build(repo_root)

            self.assertEqual("/components/mammoth-cache/", results[0].raw_component_index_path)
            self.assertEqual(
                "/components/mammoth-cache/development/",
                results[0].raw_development_index_path,
            )
            self.assertTrue((repo_root / "build" / "site-stage" / "manifest.yaml").is_file())
            self.assertTrue((repo_root / "build" / "site-preview" / "index.html").is_file())

    def test_collect_watch_roots_uses_local_pipeline_dependency_source(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir) / "consumer"
            write_files(
                repo_root,
                {
                    "site/pipeline/main.py": "raise SystemExit(0)\n",
                    "site/pipeline/pyproject.toml": text_block("""
                    [project]
                    name='consumer'

                    [tool.uv.sources]
                    apache-buildish-site-pipeline = { path = "../../buildish-site-pipeline" }
                    """),
                    "buildish-site-pipeline/apache_buildish_site_pipeline/__init__.py": "",
                    "site/content/_index.md": "# Root\n",
                },
            )
            dump_yaml(repo_root / "site" / "components.yaml", {"schemaVersion": 1, "components": []})

            watch_roots = set(site_pipeline.collect_watch_roots(repo_root))
            self.assertIn((repo_root / "buildish-site-pipeline").resolve(), watch_roots)

    def test_repo_root_from_accepts_string_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir) / "consumer"
            repo_root.mkdir()

            self.assertEqual(repo_root.resolve(), repo_root_from(str(repo_root)))

    def test_second_consumer_fixture_builds_through_cli(self) -> None:
        fixture_root = Path(__file__).parent / "fixtures" / "second-consumer-workspace"
        package_root = Path(__file__).resolve().parents[1]

        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir) / "workspace"
            shutil.copytree(fixture_root, workspace)
            repo_root = workspace / "consumer-site"

            completed = subprocess.run(  # noqa: S603 - intentional CLI contract test
                [
                    sys.executable,
                    str(package_root / "main.py"),
                    "build",
                    "--repo-root",
                    str(repo_root),
                ],
                cwd=package_root,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(0, completed.returncode, msg=completed.stderr)
            self.assertIn("Built 1 component(s)", completed.stdout)

            stage_root = repo_root / "out" / "stage"
            preview_root = repo_root / "out" / "preview"
            component_root = stage_root / "content" / "components" / "rocket-cache"
            self.assertTrue((stage_root / "content" / "_index.md").is_file())
            self.assertTrue((stage_root / "manifest.yaml").is_file())
            self.assertTrue((stage_root / "data" / "components.yaml").is_file())
            self.assertTrue((preview_root / "index.html").is_file())
            self.assertTrue((component_root / "_index.md").is_file())
            self.assertTrue(
                (
                    component_root
                    / "development"
                    / "docs"
                    / "getting-started.md"
                ).is_file()
            )
            self.assertTrue(
                (
                    stage_root
                    / "static"
                    / "components"
                    / "rocket-cache"
                    / "development"
                    / "assets"
                    / "logos"
                    / "mark.txt"
                ).is_file()
            )
            landing_page = (component_root / "_index.md").read_text(encoding="utf-8")
            self.assertIn("Alt checkout content", landing_page)
            self.assertIn("Rocket Cache Alt", landing_page)

