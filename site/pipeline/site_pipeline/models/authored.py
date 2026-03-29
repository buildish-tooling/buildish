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

"""Pydantic models for authored YAML inputs consumed by the site pipeline."""

from __future__ import annotations

import re
from typing import Literal

from pydantic import Field

from .base import YamlModel


class ProjectCatalogDefaults(YamlModel):
    """Typed representation of the ``defaults`` section in ``site/projects.yaml``."""

    metadata_file: str | None = None
    docs_root: str | None = None
    assets_root: str | None = None
    unreleased_label: str | None = None
    tag_pattern: re.Pattern[str] | None = None
    navigation_section: str | None = None


class CatalogProject(YamlModel):
    """Typed representation of one project entry in ``site/projects.yaml``."""

    slug: str
    local_dir: str
    display_name: str | None = None
    repository: str | None = None
    default_branch: str | None = None
    metadata_file: str | None = None
    docs_root: str | None = None
    assets_root: str | None = None
    unreleased_label: str | None = None
    tag_pattern: re.Pattern[str] | None = None
    navigation_section: str | None = None
    weight: int | None = None


class ProjectsCatalog(YamlModel):
    """Typed representation of the main ``site/projects.yaml`` catalog."""

    schema_version: int | None = None
    defaults: ProjectCatalogDefaults = Field(default_factory=ProjectCatalogDefaults)
    projects: tuple[CatalogProject, ...] = Field(default_factory=tuple)


class ProjectIdentity(YamlModel):
    """Project identity and repository fields from ``project.yaml``."""

    slug: str | None = None
    display_name: str | None = None
    repository: str | None = None
    default_branch: str | None = None


class ProjectContentSettings(YamlModel):
    """Typed content-path settings from ``project.yaml``."""

    docs_root: str | None = None
    assets_root: str | None = None


class ProjectVersioningSettings(YamlModel):
    """Typed versioning settings from ``project.yaml``."""

    unreleased_label: str | None = None
    tag_pattern: re.Pattern[str] | None = None


class ProjectLifecycleReleaseLine(YamlModel):
    """One lifecycle release-line entry from ``project.yaml``."""

    line: str
    latest: str
    status: Literal["maintained", "eol"]
    aliases: tuple[str, ...] = Field(default_factory=tuple)


class ProjectLifecycleSettings(YamlModel):
    """Typed lifecycle settings from ``project.yaml``."""

    latest_stable: str | None = None
    release_lines: tuple[ProjectLifecycleReleaseLine, ...] = Field(default_factory=tuple)


class ProjectNavigationSettings(YamlModel):
    """Typed navigation settings from ``project.yaml``."""

    section: str | None = None


class ProjectMetadata(YamlModel):
    """Typed representation of one sub-project ``project.yaml`` file."""

    schema_version: int | None = None
    project: ProjectIdentity = Field(default_factory=ProjectIdentity)
    content: ProjectContentSettings = Field(default_factory=ProjectContentSettings)
    versioning: ProjectVersioningSettings = Field(default_factory=ProjectVersioningSettings)
    lifecycle: ProjectLifecycleSettings = Field(default_factory=ProjectLifecycleSettings)
    navigation: ProjectNavigationSettings = Field(default_factory=ProjectNavigationSettings)