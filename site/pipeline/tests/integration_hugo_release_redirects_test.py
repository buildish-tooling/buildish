# Copyright 2026 The Buildish Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Render metadata-driven moving release URLs with the production Hugo adapter."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[3] / "site"
HUGO = shutil.which("hugo")


@unittest.skipUnless(HUGO, "Hugo is required for redirect integration tests")
class ReleaseRedirectsIntegrationTest(unittest.TestCase):
    def setUp(self) -> None:
        temp_root = SOURCE_ROOT / "build/tests"
        temp_root.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=temp_root)
        self.addCleanup(temporary.cleanup)
        self.site = Path(temporary.name)
        for relative in (
            "content/_content.gotmpl",
            "layouts/partials/buildish-release-redirects.html",
            "layouts/buildish-release-redirect/single.html",
        ):
            destination = self.site / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(SOURCE_ROOT / relative, destination)
        (self.site / "hugo.yaml").write_text(
            "baseURL: https://example.test/\ndisableKinds: [taxonomy, term, RSS]\n"
        )
        self.components = []
        self.routes = []
        self.releases = []
        self.pages = []

    def add_component(self, slug: str, latest: str = "0.2.2") -> None:
        self.components.append(
            {
                "slug": slug,
                "publication": {"paths": {"component": f"/components/{slug}/"}},
                "artifacts": [
                    {
                        "key": slug,
                        "latestStable": latest,
                        "releaseLines": [
                            {"key": "0.1", "latest": "0.1.2"},
                            {"key": "0.2", "latest": latest},
                        ],
                    }
                ],
            }
        )
        for version in ("0.1.2", latest):
            self.add_release(slug, version)

    def add_release(self, slug: str, version: str) -> None:
        path = f"/components/{slug}/releases/{version}/"
        self.routes.append(
            {
                "componentSlug": slug,
                "artifactKey": slug,
                "routeKind": "context",
                "section": "released",
                "path": path,
                "targetId": f"released:{slug}:{slug}:{version}",
            }
        )
        self.releases.append(
            {
                "componentSlug": slug,
                "artifactKey": slug,
                "version": version,
                "publicationState": "published",
            }
        )
        self.pages.append(
            {
                "componentSlug": slug,
                "artifactKey": slug,
                "path": path.rstrip("/"),
                "pageKind": "release-page",
            }
        )
        page = self.site / "content" / path.strip("/") / "_index.md"
        page.parent.mkdir(parents=True, exist_ok=True)
        page.write_text(f"---\ntitle: Release {version}\n---\n")

    def render(self) -> None:
        for name, items in (
            ("components", self.components),
            ("routes", self.routes),
            ("releases", self.releases),
            ("content-index", self.pages),
        ):
            path = self.site / "data" / f"{name}.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"items": items}))
        result = subprocess.run(  # noqa: S603 - fixed Hugo invocation with disposable fixture paths
            [
                HUGO,
                "--source",
                str(self.site),
                "--destination",
                str(self.site / "public"),
                "--cleanDestinationDir",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def assert_redirect(self, source: str, target: str) -> None:
        html = (self.site / "public" / source.strip("/") / "index.html").read_text()
        self.assertIn(f'content="0; url={target}"', html)
        self.assertIn(f'href="https://example.test{target}"', html)
        self.assertIn(f'<a href="{target}">', html)
        self.assertIn('content="noindex, follow"', html)
        sitemap = (self.site / "public/sitemap.xml").read_text()
        self.assertNotIn(f"https://example.test{source}", sitemap)

    def test_released_components_get_stable_and_per_line_redirects(self) -> None:
        for slug in ("release-tooling", "mammoth-cache", "atr-maven-bundle"):
            self.add_component(slug)
        self.render()
        for component in self.components:
            base = f"/components/{component['slug']}"
            self.assert_redirect(f"{base}/latest/", f"{base}/releases/0.2.2/")
            for line, version in (("0.1", "0.1.2"), ("0.2", "0.2.2")):
                self.assert_redirect(
                    f"{base}/releases/{line}/latest/", f"{base}/releases/{version}/"
                )

    def test_recommendations_advance_and_new_lines_appear_automatically(self) -> None:
        self.add_component("mammoth-cache")
        self.render()
        base = "/components/mammoth-cache"
        artifact = self.components[0]["artifacts"][0]
        self.add_release("mammoth-cache", "0.2.3")
        artifact["latestStable"] = "0.2.3"
        artifact["releaseLines"][1]["latest"] = "0.2.3"
        self.render()
        self.assert_redirect(f"{base}/latest/", f"{base}/releases/0.2.3/")
        self.assert_redirect(f"{base}/releases/0.2/latest/", f"{base}/releases/0.2.3/")
        self.add_release("mammoth-cache", "0.3.0")
        artifact["latestStable"] = "0.3.0"
        artifact["releaseLines"].append({"key": "0.3", "latest": "0.3.0"})
        self.render()
        self.assert_redirect(f"{base}/latest/", f"{base}/releases/0.3.0/")
        self.assert_redirect(f"{base}/releases/0.3/latest/", f"{base}/releases/0.3.0/")
        self.assert_redirect(f"{base}/releases/0.2/latest/", f"{base}/releases/0.2.3/")

    def test_unavailable_and_withdrawn_targets_do_not_get_redirects(self) -> None:
        self.add_component("mammoth-cache")
        for state in ("hidden", "withdrawn", "tombstoned"):
            with self.subTest(state=state):
                self.releases[-1]["publicationState"] = state
                self.render()
                for path in ("latest", "releases/0.2/latest"):
                    self.assertFalse(
                        (
                            self.site
                            / f"public/components/mammoth-cache/{path}/index.html"
                        ).exists()
                    )
                self.assert_redirect(
                    "/components/mammoth-cache/releases/0.1/latest/",
                    "/components/mammoth-cache/releases/0.1.2/",
                )
        self.releases[-1]["publicationState"] = "published"
        for kind in ("withdrawal-notice", "development-page"):
            with self.subTest(page_kind=kind):
                self.pages[-1]["pageKind"] = kind
                self.render()
                self.assertFalse(
                    (
                        self.site / "public/components/mammoth-cache/latest/index.html"
                    ).exists()
                )
        self.pages.pop()
        self.render()
        self.assertFalse(
            (self.site / "public/components/mammoth-cache/latest/index.html").exists()
        )
