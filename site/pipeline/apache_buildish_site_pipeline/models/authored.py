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


class ComponentCatalogDefaults(YamlModel):
    """Typed representation of the ``defaults`` section in ``site/components.yaml``."""

    metadata_file: str | None = None
    pages_root: str | None = None
    docs_root: str | None = None
    assets_root: str | None = None
    development_label: str | None = None
    tag_pattern: re.Pattern[str] | None = None
    navigation_section: str | None = None


class CatalogComponent(YamlModel):
    """Typed representation of one component entry in ``site/components.yaml``."""

    slug: str
    local_dir: str
    display_name: str | None = None
    repository: str | None = None
    default_branch: str | None = None
    metadata_file: str | None = None
    pages_root: str | None = None
    docs_root: str | None = None
    assets_root: str | None = None
    development_label: str | None = None
    tag_pattern: re.Pattern[str] | None = None
    navigation_section: str | None = None
    weight: int | None = None


class ComponentsCatalog(YamlModel):
    """Typed representation of the main ``site/components.yaml`` catalog."""

    schema_version: int | None = None
    defaults: ComponentCatalogDefaults = Field(default_factory=ComponentCatalogDefaults)
    components: tuple[CatalogComponent, ...] = Field(default_factory=tuple)


class LocalWorkspaceComponentOverride(YamlModel):
    """One slug-keyed local checkout override from ``site/components.local.yaml``."""

    checkout_dir: str


class LocalWorkspaceOverrides(YamlModel):
    """Workspace-local source bindings from ``site/components.local.yaml``."""

    components: dict[str, LocalWorkspaceComponentOverride] = Field(default_factory=dict)


class ComponentsLocalOverrides(YamlModel):
    """Typed representation of ``site/components.local.yaml`` when present."""

    schema_version: int | None = None
    workspace: LocalWorkspaceOverrides = Field(default_factory=LocalWorkspaceOverrides)


class ComponentIdentity(YamlModel):
    """Component identity and repository fields from ``component.yaml``."""

    slug: str | None = None
    display_name: str | None = None
    repository: str | None = None
    default_branch: str | None = None


class ComponentContentSettings(YamlModel):
    """Typed content-path settings from ``component.yaml``."""

    pages_root: str | None = None
    docs_root: str | None = None
    assets_root: str | None = None


class ComponentVersioningSettings(YamlModel):
    """Typed versioning settings from ``component.yaml``."""

    development_label: str | None = None
    tag_pattern: re.Pattern[str] | None = None


class ComponentLifecycleReleaseLine(YamlModel):
    """One lifecycle release-line entry from ``component.yaml``."""

    line: str
    latest: str
    status: Literal["maintained", "eol"]
    aliases: tuple[str, ...] = Field(default_factory=tuple)


class ComponentLifecycleSettings(YamlModel):
    """Typed lifecycle settings from ``component.yaml``."""

    latest_stable: str | None = None
    release_lines: tuple[ComponentLifecycleReleaseLine, ...] = Field(
        default_factory=tuple
    )


class ComponentNavigationSettings(YamlModel):
    """Typed navigation settings from ``component.yaml``."""

    section: str | None = None


class ComponentMetadata(YamlModel):
    """Typed representation of one component ``component.yaml`` file."""

    schema_version: int | None = None
    component: ComponentIdentity = Field(default_factory=ComponentIdentity)
    content: ComponentContentSettings = Field(default_factory=ComponentContentSettings)
    versioning: ComponentVersioningSettings = Field(
        default_factory=ComponentVersioningSettings
    )
    lifecycle: ComponentLifecycleSettings = Field(
        default_factory=ComponentLifecycleSettings
    )
    navigation: ComponentNavigationSettings = Field(
        default_factory=ComponentNavigationSettings
    )
