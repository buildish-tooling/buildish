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

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Generic, TypeVar


T = TypeVar("T")


def _without_none(payload: dict[str, Any]) -> dict[str, Any]:
    """Return a shallow copy that excludes keys whose value is ``None``."""

    return {key: value for key, value in payload.items() if value is not None}


def _serialize_yaml_value(value: Any) -> Any:
    """Serialize nested model values into plain YAML-safe Python objects."""

    to_yaml_data = getattr(value, "to_yaml_data", None)
    if callable(to_yaml_data):
        return to_yaml_data()
    if isinstance(value, tuple):
        return [_serialize_yaml_value(item) for item in value]
    if isinstance(value, list):
        return [_serialize_yaml_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _serialize_yaml_value(item) for key, item in value.items()}
    return value


@dataclass(frozen=True, slots=True)
class ConfiguredValue(Generic[T]):
    """Represent a YAML field that may be absent or explicitly set to null."""

    value: T | None = None
    is_set: bool = False

    @classmethod
    def unset(cls) -> "ConfiguredValue[T]":
        """Return a sentinel representing an absent configuration field."""

        return cls()


@dataclass(frozen=True, slots=True)
class ProjectCatalogDefaults:
    """Typed representation of the ``defaults`` section in ``site/projects.yaml``."""

    metadata_file: str | None = None
    docs_root: ConfiguredValue[str] = field(default_factory=ConfiguredValue.unset)
    assets_root: ConfiguredValue[str] = field(default_factory=ConfiguredValue.unset)
    unreleased_label: str | None = None
    tag_pattern: str | None = None
    navigation_section: str | None = None


@dataclass(frozen=True, slots=True)
class CatalogProject:
    """Typed representation of one project entry in ``site/projects.yaml``."""

    slug: str
    local_dir: str
    display_name: str | None = None
    repository: str | None = None
    default_branch: str | None = None
    metadata_file: str | None = None
    docs_root: ConfiguredValue[str] = field(default_factory=ConfiguredValue.unset)
    assets_root: ConfiguredValue[str] = field(default_factory=ConfiguredValue.unset)
    unreleased_label: str | None = None
    tag_pattern: str | None = None
    navigation_section: str | None = None
    weight: ConfiguredValue[int] = field(default_factory=ConfiguredValue.unset)


@dataclass(frozen=True, slots=True)
class ProjectsCatalog:
    """Typed representation of the main ``site/projects.yaml`` catalog."""

    schema_version: int | None = None
    defaults: ProjectCatalogDefaults = field(default_factory=ProjectCatalogDefaults)
    projects: tuple[CatalogProject, ...] = ()


@dataclass(frozen=True, slots=True)
class ProjectIdentity:
    """Project identity and repository fields from ``project.yaml``."""

    slug: str | None = None
    display_name: str | None = None
    repository: str | None = None
    default_branch: str | None = None


@dataclass(frozen=True, slots=True)
class ProjectContentSettings:
    """Typed content-path settings from ``project.yaml``."""

    docs_root: ConfiguredValue[str] = field(default_factory=ConfiguredValue.unset)
    assets_root: ConfiguredValue[str] = field(default_factory=ConfiguredValue.unset)


@dataclass(frozen=True, slots=True)
class ProjectVersioningSettings:
    """Typed versioning settings from ``project.yaml``."""

    unreleased_label: str | None = None
    tag_pattern: str | None = None


@dataclass(frozen=True, slots=True)
class ProjectLifecycleReleaseLine:
    """One lifecycle release-line entry from ``project.yaml``."""

    line: str | None = None
    latest: str | None = None
    status: str | None = None
    aliases: tuple[str, ...] = ()
    is_mapping: bool = True
    aliases_were_list: bool = True


@dataclass(frozen=True, slots=True)
class ProjectLifecycleSettings:
    """Typed lifecycle settings from ``project.yaml``."""

    latest_stable: str | None = None
    release_lines: tuple[ProjectLifecycleReleaseLine, ...] = ()
    release_lines_were_list: bool = True


@dataclass(frozen=True, slots=True)
class ProjectNavigationSettings:
    """Typed navigation settings from ``project.yaml``."""

    section: str | None = None


@dataclass(frozen=True, slots=True)
class ProjectMetadata:
    """Typed representation of one sub-project ``project.yaml`` file."""

    schema_version: int | None = None
    project: ProjectIdentity = field(default_factory=ProjectIdentity)
    content: ProjectContentSettings = field(default_factory=ProjectContentSettings)
    versioning: ProjectVersioningSettings = field(default_factory=ProjectVersioningSettings)
    lifecycle: ProjectLifecycleSettings = field(default_factory=ProjectLifecycleSettings)
    navigation: ProjectNavigationSettings = field(default_factory=ProjectNavigationSettings)
    slug: str | None = None
    display_name: str | None = None
    repository: str | None = None
    default_branch: str | None = None
    docs_root: ConfiguredValue[str] = field(default_factory=ConfiguredValue.unset)
    assets_root: ConfiguredValue[str] = field(default_factory=ConfiguredValue.unset)
    unreleased_label: str | None = None
    tag_pattern: str | None = None
    navigation_section: str | None = None


@dataclass(frozen=True, slots=True)
class StagedProjectRef:
    """Project identity written into staged YAML contract files."""

    slug: str
    display_name: str

    def to_yaml_data(self) -> dict[str, Any]:
        """Serialize the project reference to its YAML shape."""

        return {"slug": self.slug, "displayName": self.display_name}


@dataclass(frozen=True, slots=True)
class StagedDocLink:
    """One normalized documentation link discovered during staging."""

    label: str
    href: str

    def to_yaml_data(self) -> dict[str, str]:
        """Serialize the link to a plain mapping."""

        return {"label": self.label, "href": self.href}


@dataclass(frozen=True, slots=True)
class StagedReleaseLine:
    """One validated release-line entry written into staged YAML files."""

    line: str
    latest: str
    status: str
    aliases: tuple[str, ...] = ()
    path: str | None = None

    def to_yaml_data(self) -> dict[str, Any]:
        """Serialize the release line to its YAML shape."""

        payload = {"line": self.line, "latest": self.latest, "status": self.status, "path": self.path}
        if self.aliases:
            payload["aliases"] = list(self.aliases)
        return _without_none(payload)


@dataclass(frozen=True, slots=True)
class StagedAliasMapping:
    """One alias mapping derived from a validated release line."""

    alias: str
    target: str
    line: str
    status: str

    def to_yaml_data(self) -> dict[str, str]:
        """Serialize the alias mapping to a plain mapping."""

        return {
            "alias": self.alias,
            "target": self.target,
            "line": self.line,
            "status": self.status,
        }


@dataclass(frozen=True, slots=True)
class VersionDescriptor:
    """The ``version`` section of a staged ``version.yaml`` file."""

    kind: str
    label: str
    path: str
    docs_path: str | None = None

    def to_yaml_data(self) -> dict[str, Any]:
        """Serialize the version descriptor to its YAML shape."""

        return _without_none(
            {
                "kind": self.kind,
                "label": self.label,
                "path": self.path,
                "docsPath": self.docs_path,
            }
        )


@dataclass(frozen=True, slots=True)
class VersionSource:
    """The ``source`` section of a staged ``version.yaml`` file."""

    repository: str | None
    local_dir: str
    metadata_file: str
    metadata_loaded: bool
    default_branch: str | None
    docs_root: str | None
    assets_root: str | None

    def to_yaml_data(self) -> dict[str, Any]:
        """Serialize the source metadata to its YAML shape."""

        return {
            "repository": self.repository,
            "localDir": self.local_dir,
            "metadataFile": self.metadata_file,
            "metadataLoaded": self.metadata_loaded,
            "defaultBranch": self.default_branch,
            "docsRoot": self.docs_root,
            "assetsRoot": self.assets_root,
        }


@dataclass(frozen=True, slots=True)
class VersionAssets:
    """The ``assets`` section of a staged ``version.yaml`` file."""

    count: int
    path: str | None

    def to_yaml_data(self) -> dict[str, Any]:
        """Serialize the assets metadata to its YAML shape."""

        return {"count": self.count, "path": self.path}


@dataclass(frozen=True, slots=True)
class ProjectVersionDocument:
    """Typed representation of a staged project ``version.yaml`` file."""

    schema_version: int
    project: StagedProjectRef
    version: VersionDescriptor
    source: VersionSource
    assets: VersionAssets

    def to_yaml_data(self) -> dict[str, Any]:
        """Serialize the full ``version.yaml`` document."""

        return {
            "schemaVersion": self.schema_version,
            "project": self.project.to_yaml_data(),
            "version": self.version.to_yaml_data(),
            "source": self.source.to_yaml_data(),
            "assets": self.assets.to_yaml_data(),
        }


@dataclass(frozen=True, slots=True)
class LifecycleUnreleased:
    """The ``unreleased`` section used in staged lifecycle YAML files."""

    label: str
    path: str
    docs_path: str | None = None
    robots: str | None = None

    def to_yaml_data(self) -> dict[str, Any]:
        """Serialize the unreleased lifecycle section."""

        return _without_none(
            {
                "label": self.label,
                "path": self.path,
                "docsPath": self.docs_path,
                "robots": self.robots,
            }
        )


@dataclass(frozen=True, slots=True)
class LifecycleLatestStable:
    """The structured latest-stable entry used in project ``lifecycle.yaml``."""

    version: str
    path: str | None = None

    def to_yaml_data(self) -> dict[str, Any]:
        """Serialize the latest stable entry."""

        return _without_none({"version": self.version, "path": self.path})


@dataclass(frozen=True, slots=True)
class ProjectLifecycleDocumentData:
    """The ``lifecycle`` section of a project ``lifecycle.yaml`` file."""

    unreleased: LifecycleUnreleased
    latest_stable: LifecycleLatestStable | None = None
    release_lines: tuple[StagedReleaseLine, ...] = ()

    def to_yaml_data(self) -> dict[str, Any]:
        """Serialize the project lifecycle section."""

        return {
            "unreleased": self.unreleased.to_yaml_data(),
            "latestStable": None if self.latest_stable is None else self.latest_stable.to_yaml_data(),
            "releaseLines": [_serialize_yaml_value(release_line) for release_line in self.release_lines],
        }


@dataclass(frozen=True, slots=True)
class ProjectLifecycleDocument:
    """Typed representation of a staged project ``lifecycle.yaml`` file."""

    schema_version: int
    project: StagedProjectRef
    lifecycle: ProjectLifecycleDocumentData

    def to_yaml_data(self) -> dict[str, Any]:
        """Serialize the full project lifecycle document."""

        return {
            "schemaVersion": self.schema_version,
            "project": self.project.to_yaml_data(),
            "lifecycle": self.lifecycle.to_yaml_data(),
        }


@dataclass(frozen=True, slots=True)
class ManifestProjectEntry:
    """One project entry in the staged root ``manifest.yaml`` file."""

    slug: str
    display_name: str
    weight: int
    available: bool
    local_dir: str
    repository: str | None
    default_branch: str | None
    project_path: str | None
    unreleased_path: str | None
    docs_path: str | None

    def to_yaml_data(self) -> dict[str, Any]:
        """Serialize the manifest entry."""

        return {
            "slug": self.slug,
            "displayName": self.display_name,
            "weight": self.weight,
            "available": self.available,
            "localDir": self.local_dir,
            "repository": self.repository,
            "defaultBranch": self.default_branch,
            "projectPath": self.project_path,
            "unreleasedPath": self.unreleased_path,
            "docsPath": self.docs_path,
        }


@dataclass(frozen=True, slots=True)
class ManifestDocument:
    """Typed representation of the staged root ``manifest.yaml`` file."""

    schema_version: int
    generated_at: str
    repo_root: str
    projects: tuple[ManifestProjectEntry, ...] = ()

    def to_yaml_data(self) -> dict[str, Any]:
        """Serialize the staged manifest document."""

        return {
            "schemaVersion": self.schema_version,
            "generatedAt": self.generated_at,
            "repoRoot": self.repo_root,
            "projects": [_serialize_yaml_value(project) for project in self.projects],
        }


@dataclass(frozen=True, slots=True)
class ProjectsDataEntry:
    """One project entry in the aggregated staged ``data/projects.yaml`` file."""

    display_name: str
    weight: int
    available: bool
    local_dir: str
    repository: str | None
    summary: str
    default_branch: str | None
    navigation_section: str | None
    unreleased_label: str
    project_path: str | None
    unreleased_path: str | None
    docs_path: str | None
    asset_count: int
    assets_path: str | None
    latest_stable: str | None
    latest_stable_path: str | None
    release_lines: tuple[StagedReleaseLine, ...] = ()

    def to_yaml_data(self) -> dict[str, Any]:
        """Serialize the aggregated project entry."""

        return {
            "displayName": self.display_name,
            "weight": self.weight,
            "available": self.available,
            "localDir": self.local_dir,
            "repository": self.repository,
            "summary": self.summary,
            "defaultBranch": self.default_branch,
            "navigationSection": self.navigation_section,
            "unreleasedLabel": self.unreleased_label,
            "projectPath": self.project_path,
            "unreleasedPath": self.unreleased_path,
            "docsPath": self.docs_path,
            "assetCount": self.asset_count,
            "assetsPath": self.assets_path,
            "latestStable": self.latest_stable,
            "latestStablePath": self.latest_stable_path,
            "releaseLines": [_serialize_yaml_value(release_line) for release_line in self.release_lines],
        }


@dataclass(frozen=True, slots=True)
class ProjectsDataDocument:
    """Typed representation of the staged aggregated ``data/projects.yaml`` file."""

    schema_version: int
    projects: dict[str, ProjectsDataEntry] = field(default_factory=dict)

    def to_yaml_data(self) -> dict[str, Any]:
        """Serialize the aggregated projects-data document."""

        return {
            "schemaVersion": self.schema_version,
            "projects": {slug: entry.to_yaml_data() for slug, entry in self.projects.items()},
        }


@dataclass(frozen=True, slots=True)
class LifecycleDataEntry:
    """One project entry in the aggregated staged ``data/lifecycle.yaml`` file."""

    latest_stable: str | None
    release_lines: tuple[StagedReleaseLine, ...] = ()
    unreleased: LifecycleUnreleased | None = None

    def to_yaml_data(self) -> dict[str, Any]:
        """Serialize the aggregated lifecycle entry."""

        return {
            "latestStable": self.latest_stable,
            "releaseLines": [_serialize_yaml_value(release_line) for release_line in self.release_lines],
            "unreleased": None if self.unreleased is None else self.unreleased.to_yaml_data(),
        }


@dataclass(frozen=True, slots=True)
class LifecycleDataDocument:
    """Typed representation of the staged aggregated ``data/lifecycle.yaml`` file."""

    schema_version: int
    projects: dict[str, LifecycleDataEntry] = field(default_factory=dict)

    def to_yaml_data(self) -> dict[str, Any]:
        """Serialize the aggregated lifecycle document."""

        return {
            "schemaVersion": self.schema_version,
            "projects": {slug: entry.to_yaml_data() for slug, entry in self.projects.items()},
        }


@dataclass(frozen=True, slots=True)
class ProjectAliasesEntry:
    """One project entry in the staged aggregated ``data/aliases.yaml`` file."""

    aliases: tuple[StagedAliasMapping, ...] = ()

    def to_yaml_data(self) -> dict[str, Any]:
        """Serialize the aliases entry."""

        return {"aliases": [_serialize_yaml_value(alias) for alias in self.aliases]}


@dataclass(frozen=True, slots=True)
class AliasesDataDocument:
    """Typed representation of the staged aggregated ``data/aliases.yaml`` file."""

    schema_version: int
    projects: dict[str, ProjectAliasesEntry] = field(default_factory=dict)

    def to_yaml_data(self) -> dict[str, Any]:
        """Serialize the aggregated aliases document."""

        return {
            "schemaVersion": self.schema_version,
            "projects": {slug: entry.to_yaml_data() for slug, entry in self.projects.items()},
        }


@dataclass(frozen=True, slots=True)
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
    release_lines: tuple[StagedReleaseLine, ...]
    alias_mappings: tuple[StagedAliasMapping, ...]
    doc_links: tuple[StagedDocLink, ...]
    warnings: list[str]