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

"""Shared helpers for site pipeline tests."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from collections.abc import Mapping
from pathlib import Path
from textwrap import dedent
from typing import Any

import yaml

SOURCE_REPO_ROOT = Path(__file__).resolve().parents[3]
EXTRACTED_PIPELINE_SNAPSHOT_ROOT = (
    SOURCE_REPO_ROOT.parent / "buildish-site-pipeline" / "dist" / "snapshots"
)
CONSUMER_PIPELINE_ROOT = SOURCE_REPO_ROOT / "site" / "pipeline"
CONSUMER_PIPELINE_REFRESH = CONSUMER_PIPELINE_ROOT / "refresh_latest_snapshot.py"
CONSUMER_PIPELINE_VENV = CONSUMER_PIPELINE_ROOT / ".venv"
PIPELINE_FIXTURE_IGNORE = shutil.ignore_patterns(
    ".venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
)
BUILDISH_DISCLAIMER = """Apache Buildish (Incubating) is an effort undergoing incubation at The Apache
Software Foundation (ASF), sponsored by the Apache Incubator PMC.

Incubation is required of all newly accepted projects until a further review
indicates that the infrastructure, communications, and decision making process
have stabilized in a manner consistent with other successful ASF projects.

While incubation status is not necessarily a reflection of the completeness
or stability of the code, it does indicate that the project has yet to be
fully endorsed by the ASF.
"""
FIXTURE_COMPONENTS = [
    {"slug": "mammoth-cache", "localDir": "buildish-mammoth-cache"},
    {"slug": "no-gradle-wrapper-jar", "localDir": "buildish-no-gradle-wrapper-jar", "weight": 5},
    {"slug": "site", "localDir": "buildish/site", "weight": 100},
]


def normalize_fixture_component(component: Mapping[str, object]) -> dict[str, object]:
    """Return one fixture catalog entry with an explicit component mount path."""

    normalized = dict(component)
    publication = dict(normalized.get("publication", {}))
    slug = normalized.get("slug")
    if isinstance(slug, str) and slug and "mountPath" not in publication:
        publication["mountPath"] = f"/components/{slug}/"
    if publication:
        normalized["publication"] = publication
    return normalized
SITE_ROOT_FILES = (
    "Makefile",
    "go.mod",
    "go.sum",
    "hugo.yaml",
    "package.json",
    "package-lock.json",
    "postcss.config.js",
)


def write_text(path: Path, contents: str) -> None:
    """Write UTF-8 text, creating parent directories as needed."""

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8")


def text_block(contents: str) -> str:
    """Dedent a triple-quoted fixture string and drop a leading blank line."""

    return dedent(contents).lstrip("\n")


def write_files(root: Path, files: Mapping[str, str]) -> None:
    """Write a batch of relative fixture files below ``root``."""

    for relative_path, contents in files.items():
        write_text(root / relative_path, contents)


def dump_yaml(path: Path, payload: object) -> None:
    """Serialize one YAML payload using the test-suite formatting convention."""

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        yaml.safe_dump(payload, handle, sort_keys=False, default_flow_style=False)


class TestCaseHelpers:
    """Common filesystem and assertion helpers for site pipeline tests."""

    @staticmethod
    def read_text(path: Path) -> str:
        return path.read_text(encoding="utf-8")

    @staticmethod
    def write_yaml(path: Path, payload: object) -> None:
        dump_yaml(path, payload)

    def load_yaml(self, path: Path) -> Any:
        return yaml.safe_load(self.read_text(path))

    def load_json(self, path: Path) -> Any:
        return json.loads(self.read_text(path))

    def assert_paths_exist(self, *paths: Path) -> None:
        for path in paths:
            self.assertTrue(path.exists(), f"Expected path to exist: {path}")

    def assert_contains_all(self, text: str, *snippets: str) -> None:
        for snippet in snippets:
            self.assertIn(snippet, text)

    def assert_not_contains_any(self, text: str, *snippets: str) -> None:
        for snippet in snippets:
            self.assertNotIn(snippet, text)

    def run_pipeline_command(
        self, repo_root: Path, *args: str, check: bool = False
    ) -> subprocess.CompletedProcess[str]:
        command = [
            sys.executable,
            str(CONSUMER_PIPELINE_REFRESH),
            "--consumer-root",
            str(CONSUMER_PIPELINE_ROOT),
            "--lock",
            "--sync",
            "--venv-path",
            str(CONSUMER_PIPELINE_VENV),
            "--",
            "site-pipeline",
            *args,
            "--workspace-root",
            str(repo_root.parent),
        ]
        if "--catalog" not in args:
            command.extend(["--catalog", str(repo_root / "site" / "components.yaml")])
        env = os.environ.copy()
        env["UV_PROJECT_ENVIRONMENT"] = str(CONSUMER_PIPELINE_VENV)
        return subprocess.run(  # noqa: S603 - fixed local interpreter/script invocation
            command,
            cwd=CONSUMER_PIPELINE_ROOT,
            text=True,
            capture_output=True,
            check=check,
            env=env,
        )

    def run_pipeline_build(
        self, repo_root: Path, *args: str, check: bool = False
    ) -> subprocess.CompletedProcess[str]:
        return self.run_pipeline_command(repo_root, "build", *args, check=check)

    def run_pipeline_clean(
        self, repo_root: Path, *args: str, check: bool = False
    ) -> subprocess.CompletedProcess[str]:
        return self.run_pipeline_command(repo_root, "clean", *args, check=check)

    def assert_command_succeeded(self, result: subprocess.CompletedProcess[str]) -> None:
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def assert_command_failed(
        self, result: subprocess.CompletedProcess[str], expected_message: str
    ) -> None:
        self.assertNotEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn(expected_message, result.stdout + result.stderr)


def write_fixture_catalog(site_root: Path, components: list[dict[str, object]] | None = None) -> None:
    """Write a components catalog tailored for integration fixtures."""

    catalog = yaml.safe_load((SOURCE_REPO_ROOT / "site" / "components.yaml").read_text(encoding="utf-8"))
    selected_components = FIXTURE_COMPONENTS if components is None else components
    catalog["components"] = [normalize_fixture_component(component) for component in selected_components]
    dump_yaml(site_root / "components.yaml", catalog)


def seed_api_fixture_main_repo(repo_root: Path) -> None:
    """Seed the minimal main-repo inputs needed by API integration tests."""

    site_root = repo_root / "site"
    site_root.mkdir(parents=True, exist_ok=True)
    shutil.copytree(SOURCE_REPO_ROOT / "site" / "content", site_root / "content", dirs_exist_ok=True)
    shutil.copytree(SOURCE_REPO_ROOT / "site" / "site", site_root / "site", dirs_exist_ok=True)
    shutil.copy2(SOURCE_REPO_ROOT / "DISCLAIMER", repo_root / "DISCLAIMER")
    write_fixture_catalog(site_root)


def seed_make_fixture_main_repo(repo_root: Path) -> None:
    """Seed the richer main-repo inputs needed by Make-target integration tests."""

    site_root = repo_root / "site"
    site_root.mkdir(parents=True, exist_ok=True)
    for relative in ("assets", "content", "layouts", "scripts", "site", "static"):
        shutil.copytree(SOURCE_REPO_ROOT / "site" / relative, site_root / relative, dirs_exist_ok=True)
    shutil.copytree(
        SOURCE_REPO_ROOT / "site" / "pipeline",
        site_root / "pipeline",
        dirs_exist_ok=True,
        ignore=PIPELINE_FIXTURE_IGNORE,
    )
    shutil.copytree(
        EXTRACTED_PIPELINE_SNAPSHOT_ROOT,
        repo_root.parent / "buildish-site-pipeline" / "dist" / "snapshots",
        dirs_exist_ok=True,
    )
    rewrite_snapshot_manifest(repo_root.parent / "buildish-site-pipeline" / "dist" / "snapshots")
    shutil.copy2(SOURCE_REPO_ROOT / "DISCLAIMER", repo_root / "DISCLAIMER")
    for relative in SITE_ROOT_FILES:
        shutil.copy2(SOURCE_REPO_ROOT / "site" / relative, site_root / relative)
    write_fixture_catalog(site_root)


def rewrite_snapshot_manifest(snapshot_root: Path) -> None:
    """Rewrite ``latest.json`` to point at the copied fixture wheel path."""

    manifest_path = snapshot_root / "latest.json"
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    wheel_name = payload["wheel"]
    wheel_path = (snapshot_root / wheel_name).resolve()
    payload["wheelPath"] = str(wheel_path)
    payload["fileUrl"] = wheel_path.as_uri()
    payload["dependencySpec"] = f"apache-buildish-site-pipeline @ {wheel_path.as_uri()}"
    manifest_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def seed_mammoth_fixture(
    repo_root: Path,
    *,
    landing_page: str,
    docs_index: str,
    getting_started: str,
) -> None:
    """Seed the shared Mammoth Cache component fixture."""

    write_text(repo_root / "README.md", "# Mammoth Cache for Gradle® and Apache Maven™\n\nFixture component summary.\n")
    dump_yaml(
        repo_root / "site" / "component.yaml",
        {
            "schemaVersion": 1,
            "component": {
                "slug": "mammoth-cache",
                "displayName": "Fixture Mammoth Cache for Gradle® and Apache Maven™",
            },
            "content": {"docsRoot": "site/docs"},
            "lifecycle": {"latestStable": "v1.2.3"},
        },
    )
    write_files(
        repo_root,
        {
            "site/pages/_index.md": landing_page,
            "site/docs/_index.md": docs_index,
            "site/docs/getting-started.md": getting_started,
            "site/assets/images/diagram.svg": "<svg xmlns='http://www.w3.org/2000/svg'></svg>\n",
        },
    )


def seed_no_wrapper_fixture(repo_root: Path, *, landing_page: str, docs_index: str) -> None:
    """Seed the shared no-wrapper component fixture."""

    dump_yaml(
        repo_root / "site" / "component.yaml",
        {
            "schemaVersion": 1,
            "component": {"slug": "no-gradle-wrapper-jar", "displayName": "Fixture no-gradle-wrapper-jar"},
            "content": {"docsRoot": "site/docs"},
        },
    )
    write_files(
        repo_root,
        {
            "site/pages/_index.md": landing_page,
            "site/docs/_index.md": docs_index,
        },
    )