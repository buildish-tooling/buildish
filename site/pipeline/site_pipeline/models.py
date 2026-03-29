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

"""Data structures shared across the site pipeline package."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ProjectBuildResult:
    """Describe the staged output produced for one catalog project.

    The pipeline creates one instance per project and then reuses that result
    for manifests, lifecycle metadata, lightweight preview pages, and tests.
    """

    slug: str
    display_name: str
    navigation_weight: int
    available: bool
    repository: str | None
    local_dir: str
    repo_path: Path
    summary: str
    raw_unreleased_index_path: str | None
    raw_project_index_path: str | None
    raw_docs_root_path: str | None
    raw_assets_root_path: str | None
    unreleased_label: str
    default_branch: str | None
    navigation_section: str | None
    asset_count: int
    latest_stable_version: str | None
    latest_stable_path: str | None
    release_lines: list[dict[str, Any]]
    alias_mappings: list[dict[str, str]]
    doc_links: list[dict[str, str]]
    warnings: list[str]