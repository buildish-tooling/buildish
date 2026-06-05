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

"""Consumer-level tests for the current site-pipeline CLI contract."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import yaml
from test_support import (
    TestCaseHelpers,
    seed_api_fixture_main_repo,
    seed_mammoth_fixture,
    seed_no_wrapper_fixture,
    seed_site_pipeline_fixture,
    text_block,
)


class SitePipelineTest(TestCaseHelpers, unittest.TestCase):
    @staticmethod
    def prepare_fixture_workspace(workspace: Path) -> Path:
        repo_root = workspace / "buildish"
        repo_root.mkdir()
        seed_api_fixture_main_repo(repo_root)
        seed_mammoth_fixture(
            workspace / "buildish-mammoth-cache",
            landing_page=text_block(
                """
                # Mammoth Cache for Gradle® and Apache Maven™

                Fixture component landing page.
                """
            ),
            docs_index=text_block(
                """
                # Overview

                Fixture docs overview.
                """
            ),
            getting_started=text_block(
                """
                # Getting started

                Fixture getting-started guide.
                """
            ),
        )
        seed_no_wrapper_fixture(
            workspace / "buildish-no-gradle-wrapper-jar",
            landing_page=text_block(
                """
                # No Gradle® Wrapper JAR

                Fixture component landing page.
                """
            ),
            docs_index=text_block(
                """
                # Overview

                Fixture docs overview.
                """
            ),
        )
        seed_site_pipeline_fixture(workspace / "buildish-site-pipeline")
        return repo_root

    @staticmethod
    def mammoth_component_page(repo_root: Path) -> Path:
        return (
            repo_root
            / "site"
            / ".stage"
            / "content"
            / "components"
            / "mammoth-cache"
            / "_index.md"
        )

    def test_build_stages_fixture_workspace_into_the_current_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = self.prepare_fixture_workspace(workspace)

            result = self.run_pipeline_build(repo_root)

            self.assert_command_succeeded(result)
            self.assertIn("build clean: succeeded=yes", result.stdout)
            self.assert_paths_exist(
                repo_root / "site" / ".stage" / "manifest.json",
                repo_root / "site" / ".stage" / "data" / "components.json",
                repo_root / "site" / ".stage" / "data" / "content-index.json",
                self.mammoth_component_page(repo_root),
                repo_root / "site" / ".stage" / "content" / "site" / "_index.md",
                repo_root / "site" / ".stage" / "static" / "components" / "mammoth-cache" / "assets" / "images" / "diagram.svg",
            )
            self.assertFalse((repo_root / "site" / ".stage" / "content" / "components" / "mammoth-cache" / "latest").exists())

            components_payload = self.load_json(repo_root / "site" / ".stage" / "data" / "components.json")
            slugs = {item["slug"] for item in components_payload["items"]}
            self.assertEqual({"mammoth-cache", "no-gradle-wrapper-jar", "site", "site-pipeline"}, slugs)
            mammoth = next(item for item in components_payload["items"] if item["slug"] == "mammoth-cache")
            self.assertEqual("/components/mammoth-cache/", mammoth["publication"]["paths"]["component"])

    def test_build_writes_json_report_when_requested(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = self.prepare_fixture_workspace(workspace)
            report_path = repo_root / "site" / "build-report.json"

            result = self.run_pipeline_build(
                repo_root,
                "--report-format",
                "json",
                "--report-schema-version",
                "1",
                "--report-output",
                str(report_path),
            )

            self.assert_command_succeeded(result)
            payload = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(1, payload["schemaVersion"])
            self.assertEqual("build", payload["command"])
            self.assertEqual("clean", payload["summary"]["status"])
            self.assertTrue(payload["summary"]["succeeded"])
            self.assertEqual(str(repo_root / "site" / ".stage"), payload["stageRootPath"])
            self.assertEqual(str(repo_root / "site" / ".stage" / "manifest.json"), payload["manifestPath"])

    def test_check_writes_json_report_for_a_valid_fixture_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = self.prepare_fixture_workspace(workspace)
            report_path = repo_root / "site" / "check-report.json"

            result = self.run_pipeline_command(
                repo_root,
                "check",
                "--report-format",
                "json",
                "--report-schema-version",
                "1",
                "--report-output",
                str(report_path),
            )

            self.assert_command_succeeded(result)
            payload = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(1, payload["schemaVersion"])
            self.assertEqual("check", payload["command"])
            self.assertEqual("clean", payload["summary"]["status"])
            self.assertTrue(payload["summary"]["passed"])
            self.assertEqual([], payload["diagnostics"])

    def test_build_honors_an_explicit_catalog_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = self.prepare_fixture_workspace(workspace)
            default_catalog = repo_root / "site" / "catalog.yaml"
            custom_catalog = repo_root / "site" / "catalogs" / "consumer.yaml"
            custom_catalog.parent.mkdir(parents=True, exist_ok=True)
            default_catalog.rename(custom_catalog)

            result = self.run_pipeline_build(repo_root, "--catalog", str(custom_catalog))

            self.assert_command_succeeded(result)
            custom_stage_root = custom_catalog.parent / ".stage"
            self.assert_paths_exist(
                custom_stage_root / "manifest.json",
                custom_stage_root / "content" / "components" / "mammoth-cache" / "_index.md",
            )
            self.assertFalse((repo_root / "site" / ".stage").exists())

    def test_build_stages_vendor_assets_into_site_static_vendor_roots(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = self.prepare_fixture_workspace(workspace)
            catalog_path = repo_root / "site" / "catalog.yaml"
            catalog = yaml.safe_load(catalog_path.read_text(encoding="utf-8"))
            catalog.setdefault("site", {})["vendorAssets"] = [
                {"source": "buildish/site/node_modules/jquery/dist"},
                {"source": "buildish/site/node_modules/lunr"},
            ]
            catalog_path.write_text(yaml.safe_dump(catalog, sort_keys=False), encoding="utf-8")
            jquery_root = repo_root / "site" / "node_modules" / "jquery" / "dist"
            jquery_root.mkdir(parents=True, exist_ok=True)
            (jquery_root / "jquery.min.js").write_text("window.jQuery = {};\n", encoding="utf-8")
            lunr_root = repo_root / "site" / "node_modules" / "lunr"
            lunr_root.mkdir(parents=True, exist_ok=True)
            (lunr_root / "lunr.min.js").write_text("window.lunr = {};\n", encoding="utf-8")

            result = self.run_pipeline_build(repo_root)

            self.assert_command_succeeded(result)
            self.assert_paths_exist(
                repo_root / "site" / ".stage" / "static" / "site" / "vendor" / "vendorAssets:0" / "jquery.min.js",
                repo_root / "site" / ".stage" / "static" / "site" / "vendor" / "vendorAssets:1" / "lunr.min.js",
            )

    def test_build_rejects_invalid_component_metadata_documents(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = self.prepare_fixture_workspace(workspace)
            metadata_path = workspace / "buildish-mammoth-cache" / "site" / "component.yaml"
            metadata = yaml.safe_load(metadata_path.read_text(encoding="utf-8"))
            metadata.setdefault("content", {})["docsRoot"] = 42
            metadata_path.write_text(yaml.safe_dump(metadata, sort_keys=False), encoding="utf-8")

            result = self.run_pipeline_build(repo_root)

            self.assert_command_failed(result, "Document validation failed")
            self.assertIn(str(metadata_path), result.stdout + result.stderr)

    def test_build_reports_a_missing_default_catalog_document(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            repo_root = self.prepare_fixture_workspace(workspace)
            catalog_path = repo_root / "site" / "catalog.yaml"
            catalog_path.unlink()

            result = self.run_pipeline_build(repo_root)

            self.assert_command_failed(result, "Missing catalog document")
            self.assertIn(str(catalog_path), result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
