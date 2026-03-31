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

"""Pydantic models for staged YAML outputs emitted by the site pipeline."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from pydantic import Field, StrictBool

from .base import YamlModel


class StagedComponentRef(YamlModel):
    """Component identity written into staged YAML contract files."""

    slug: str
    display_name: str


class StagedDocLink(YamlModel):
    """One normalized documentation link discovered during staging."""

    label: str
    href: str


class StagedReleaseLine(YamlModel):
    """One validated release-line entry written into staged YAML files."""

    line: str
    latest: str
    status: str
    aliases: tuple[str, ...] = Field(
        default_factory=tuple, exclude_if=lambda value: not value
    )
    path: str | None = Field(default=None, exclude_if=lambda value: value is None)


class StagedAliasMapping(YamlModel):
    """One alias mapping derived from a validated release line."""

    alias: str
    target: str
    line: str
    status: str


class VersionDescriptor(YamlModel):
    """The ``version`` section of a staged ``version.yaml`` file."""

    kind: str
    label: str
    path: str
    docs_path: str | None = Field(default=None, exclude_if=lambda value: value is None)


class VersionSource(YamlModel):
    """The ``source`` section of a staged ``version.yaml`` file."""

    repository: str | None = None
    local_dir: str
    metadata_file: str
    metadata_loaded: StrictBool
    default_branch: str | None = None
    pages_root: str | None = None
    docs_root: str | None = None
    assets_root: str | None = None


class VersionAssets(YamlModel):
    """The ``assets`` section of a staged ``version.yaml`` file."""

    count: int
    path: str | None = None


class ComponentVersionDocument(YamlModel):
    """Typed representation of a staged component ``version.yaml`` file."""

    schema_version: int
    component: StagedComponentRef
    version: VersionDescriptor
    source: VersionSource
    assets: VersionAssets


class LifecycleDevelopment(YamlModel):
    """The ``development`` section used in staged lifecycle YAML files."""

    label: str
    path: str
    docs_path: str | None = Field(default=None, exclude_if=lambda value: value is None)
    robots: str | None = Field(default=None, exclude_if=lambda value: value is None)


class LifecycleLatestStable(YamlModel):
    """The structured latest-stable entry used in component ``lifecycle.yaml``."""

    version: str
    path: str | None = Field(default=None, exclude_if=lambda value: value is None)


class ComponentLifecycleDocumentData(YamlModel):
    """The ``lifecycle`` section of a component ``lifecycle.yaml`` file."""

    development: LifecycleDevelopment
    latest_stable: LifecycleLatestStable | None = None
    release_lines: tuple[StagedReleaseLine, ...] = Field(default_factory=tuple)


class ComponentLifecycleDocument(YamlModel):
    """Typed representation of a staged component ``lifecycle.yaml`` file."""

    schema_version: int
    component: StagedComponentRef
    lifecycle: ComponentLifecycleDocumentData


class ManifestComponentEntry(YamlModel):
    """One component entry in the staged root ``manifest.yaml`` file."""

    slug: str
    display_name: str
    weight: int
    available: StrictBool
    local_dir: str
    repository: str | None = None
    default_branch: str | None = None
    component_path: str | None = None
    development_path: str | None = None
    docs_path: str | None = None


class ManifestDocument(YamlModel):
    """Typed representation of the staged root ``manifest.yaml`` file."""

    schema_version: int
    generated_at: str
    repo_root: str
    components: tuple[ManifestComponentEntry, ...] = Field(default_factory=tuple)


class ComponentsDataEntry(YamlModel):
    """One component entry in the aggregated staged ``data/components.yaml`` file."""

    display_name: str
    weight: int
    available: StrictBool
    local_dir: str
    repository: str | None = None
    summary: str
    default_branch: str | None = None
    navigation_section: str | None = None
    development_label: str
    component_path: str | None = None
    development_path: str | None = None
    docs_path: str | None = None
    asset_count: int
    assets_path: str | None = None
    latest_stable: str | None = None
    latest_stable_path: str | None = None
    release_lines: tuple[StagedReleaseLine, ...] = Field(default_factory=tuple)


class ComponentsDataDocument(YamlModel):
    """Typed representation of the staged aggregated ``data/components.yaml`` file."""

    schema_version: int
    components: dict[str, ComponentsDataEntry] = Field(default_factory=dict)


class LifecycleDataEntry(YamlModel):
    """One component entry in the aggregated staged ``data/lifecycle.yaml`` file."""

    latest_stable: str | None = None
    release_lines: tuple[StagedReleaseLine, ...] = Field(default_factory=tuple)
    development: LifecycleDevelopment | None = None


class LifecycleDataDocument(YamlModel):
    """Typed representation of the staged aggregated ``data/lifecycle.yaml`` file."""

    schema_version: int
    components: dict[str, LifecycleDataEntry] = Field(default_factory=dict)


class ComponentAliasesEntry(YamlModel):
    """One component entry in the staged aggregated ``data/aliases.yaml`` file."""

    aliases: tuple[StagedAliasMapping, ...] = Field(default_factory=tuple)


class AliasesDataDocument(YamlModel):
    """Typed representation of the staged aggregated ``data/aliases.yaml`` file."""

    schema_version: int
    components: dict[str, ComponentAliasesEntry] = Field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ComponentBuildResult:
    """Describe the staged output produced for one catalog component."""

    slug: str
    display_name: str
    navigation_weight: int
    available: bool
    repository: str | None
    local_dir: str
    repo_path: Path
    summary: str
    raw_development_index_path: str | None
    raw_component_index_path: str | None
    raw_docs_root_path: str | None
    raw_assets_root_path: str | None
    development_label: str
    default_branch: str | None
    navigation_section: str | None
    asset_count: int
    latest_stable_version: str | None
    latest_stable_path: str | None
    release_lines: tuple[StagedReleaseLine, ...]
    alias_mappings: tuple[StagedAliasMapping, ...]
    doc_links: tuple[StagedDocLink, ...]
    warnings: list[str] = field(default_factory=list)
