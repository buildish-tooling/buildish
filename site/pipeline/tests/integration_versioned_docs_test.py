# Copyright 2026 The Buildish Authors
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

"""Exercise the aggregate catalog's released-docs contract in disposable workspaces."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml
from test_support import SOURCE_REPO_ROOT, TestCaseHelpers, dump_yaml, write_text


class VersionedDocsIntegrationTest(TestCaseHelpers, unittest.TestCase):
    def setUp(self) -> None:
        temporary_root = SOURCE_REPO_ROOT / "site/build/tests"
        temporary_root.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=temporary_root)
        self.addCleanup(temporary.cleanup)
        self.workspace = Path(temporary.name)
        self.repo = self.workspace / "buildish"
        catalog = yaml.safe_load((SOURCE_REPO_ROOT / "site/catalog.yaml").read_text())
        component = next(
            item for item in catalog["components"] if item["slug"] == "release-tooling"
        )
        fixture = {
            "schemaVersion": 1,
            "defaults": catalog["defaults"],
            "origins": catalog["origins"],
            "sources": {"release-tooling": catalog["sources"]["release-tooling"]},
            "components": [component],
        }
        dump_yaml(self.repo / "site/catalog.yaml", fixture)
        self.source = self.workspace / "buildish-release-tooling"
        dump_yaml(
            self.source / "site/component.yaml",
            {
                "schemaVersion": 1,
                "component": {"slug": "release-tooling"},
                "content": {"pagesRoot": "site/pages", "docsRoot": "docs"},
                "artifacts": [{"key": "release-tooling"}],
            },
        )
        write_text(self.source / "site/pages/_index.md", "# Release Tooling\n")
        write_text(self.source / "docs/_index.md", "# Development only\n")

    def seed_released_docs(self) -> None:
        records = []
        for version, state in (
            ("0.1.1", "hidden"),
            ("0.1.2", "hidden"),
            ("0.1.3", "published"),
        ):
            records.append(
                {
                    "provider": "release-tooling-tags",
                    "kind": "released",
                    "componentSlug": "release-tooling",
                    "artifactKey": "release-tooling",
                    "version": version,
                    "tag": f"v{version}",
                    "publicationState": state,
                    "releaseLine": "0.1",
                }
            )
            write_text(
                self.source / f"docs/releases/{version}/_index.md",
                f"# Release {version}\n",
            )
        payload = {
            "schemaVersion": 1,
            "providers": [
                {
                    "key": "release-tooling-tags",
                    "type": "git-tags",
                    "fetchedAt": "2026-11-16T00:00:00Z",
                }
            ],
            "records": records,
            "artifacts": [
                {
                    "componentSlug": "release-tooling",
                    "artifactKey": "release-tooling",
                    "latestStable": "0.1.3",
                    "releaseLines": [{"key": "0.1", "latest": "0.1.3"}],
                }
            ],
        }
        write_text(
            self.source / "docs/releases/provider-snapshot.json", json.dumps(payload)
        )
        write_text(
            self.source / "docs/releases/.git", "gitdir: /not-a-real-git-directory\n"
        )

    def test_local_without_checkout_succeeds_but_publication_fails(self) -> None:
        local = self.run_pipeline_command(self.repo, "build")
        self.assertEqual(0, local.returncode, local.stdout + local.stderr)
        publication = self.run_pipeline_command(
            self.repo, "check", "--profile", "publication"
        )
        self.assertNotEqual(0, publication.returncode)
        self.assertIn("snapshot", publication.stdout + publication.stderr)

    def test_publication_uses_component_release_facts_without_development_leakage(
        self,
    ) -> None:
        self.seed_released_docs()
        result = self.run_pipeline_command(
            self.repo, "build", "--profile", "publication"
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        stage = self.repo / "site/.stage"
        routes = json.loads((stage / "data/routes.json").read_text())["items"]
        released = [
            route
            for route in routes
            if route.get("section") == "released"
            and route.get("routeKind") == "context"
        ]
        self.assertEqual(3, len(released))
        self.assertTrue(
            (
                stage / "content/components/release-tooling/releases/0.1.3/_index.md"
            ).exists()
        )
        for version in ("0.1.1", "0.1.2"):
            self.assertFalse(
                (
                    stage / f"content/components/release-tooling/releases/{version}"
                ).exists()
            )
        development_files = list((stage / "content").rglob("development/**/*.md"))
        self.assertTrue(development_files)
        for path in development_files:
            self.assertNotIn("# Release 0.1.", path.read_text())
        self.assertFalse(list((stage / "content").rglob("provider-snapshot.json")))
        self.assertFalse(list((stage / "content").rglob(".git")))

    @unittest.skipUnless(
        shutil.which("hugo"), "Hugo is required for publication rendering"
    )
    def test_publication_inventory_drives_rendered_release_navigation(self) -> None:
        self.seed_released_docs()
        result = self.run_pipeline_command(
            self.repo, "build", "--profile", "publication"
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        site = self.repo / "site"
        dump_yaml(
            site / "hugo.yaml",
            {
                "baseURL": "https://example.test/",
                "contentDir": ".stage/content",
                "dataDir": ".stage/data",
            },
        )
        template = (
            '{{ $context := partial "buildish-component-context.html" . }}'
            '<nav>{{ range $context.releaseItems }}<a href="{{ .href }}">'
            "{{ .label }}</a>{{ end }}</nav>{{ .Content }}"
        )
        for layout in ("home.html", "_default/list.html", "_default/single.html"):
            write_text(site / "layouts" / layout, template)
        partial = site / "layouts/partials/buildish-component-context.html"
        partial.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(
            SOURCE_REPO_ROOT / "site/layouts/partials/buildish-component-context.html",
            partial,
        )
        hugo = shutil.which("hugo")
        if hugo is None:
            self.fail("missing Hugo after prerequisite check")
        rendered = subprocess.run(  # noqa: S603 - fixed local Hugo and disposable fixture arguments
            [hugo, "--source", str(site), "--destination", str(site / "public")],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(0, rendered.returncode, rendered.stdout + rendered.stderr)
        routes = json.loads((site / ".stage/data/routes.json").read_text())["items"]
        released = next(
            route
            for route in routes
            if route.get("section") == "released"
            and route.get("routeKind") == "context"
            and route["path"].endswith("/0.1.3/")
        )
        output = site / "public" / released["path"].strip("/") / "index.html"
        html = output.read_text()
        self.assertIn("Latest stable (0.1.3)", html)
        self.assertIn(f'href="{released["path"]}"', html)

    def test_component_can_advance_latest_without_catalog_changes(self) -> None:
        self.seed_released_docs()
        catalog = self.repo / "site/catalog.yaml"
        original_catalog = catalog.read_bytes()
        inventory = self.source / "docs/releases/provider-snapshot.json"
        snapshot = json.loads(inventory.read_text())
        record = dict(snapshot["records"][-1], version="0.1.4", tag="v0.1.4")
        snapshot["records"].append(record)
        snapshot["artifacts"][0]["latestStable"] = "0.1.4"
        snapshot["artifacts"][0]["releaseLines"][0]["latest"] = "0.1.4"
        inventory.write_text(json.dumps(snapshot))
        write_text(self.source / "docs/releases/0.1.4/_index.md", "# Release 0.1.4\n")
        result = self.run_pipeline_command(
            self.repo, "build", "--profile", "publication"
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        routes = json.loads((self.repo / "site/.stage/data/routes.json").read_text())[
            "items"
        ]
        released = [
            route
            for route in routes
            if route.get("section") == "released"
            and route.get("routeKind") == "context"
        ]
        self.assertEqual(
            {
                f"/components/release-tooling/releases/{version}/"
                for version in ("0.1.1", "0.1.2", "0.1.3", "0.1.4")
            },
            {route["path"] for route in released},
        )
        for version in ("0.1.3", "0.1.4"):
            self.assertTrue(
                (
                    self.repo
                    / f"site/.stage/content/components/release-tooling/releases/{version}/_index.md"
                ).exists()
            )
        self.assertEqual(original_catalog, catalog.read_bytes())

    def test_catalog_can_keep_an_optional_artifact_binding(self) -> None:
        self.seed_released_docs()
        catalog = self.repo / "site/catalog.yaml"
        payload = yaml.safe_load(catalog.read_text())
        payload["components"][0]["artifacts"] = [{"key": "release-tooling"}]
        dump_yaml(catalog, payload)
        result = self.run_pipeline_command(
            self.repo, "build", "--profile", "publication"
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_present_inventory_with_missing_selected_docs_blocks_publication(
        self,
    ) -> None:
        self.seed_released_docs()
        (self.source / "docs/releases/0.1.3/_index.md").unlink()
        (self.source / "docs/releases/0.1.3").rmdir()
        result = self.run_pipeline_command(
            self.repo, "check", "--profile", "publication"
        )
        self.assertNotEqual(0, result.returncode)
