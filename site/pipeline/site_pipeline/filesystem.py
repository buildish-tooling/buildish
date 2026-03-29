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

"""Low-level filesystem and YAML helpers for the site pipeline.

These helpers centralize the path-safety rules used throughout the staging
workflow so the higher-level build code can stay focused on site behavior.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any

import yaml

from .constants import STAGED_VENDOR_ASSETS
from .models import (
    AliasesDataDocument,
    CatalogProject,
    ConfiguredValue,
    LifecycleDataDocument,
    LifecycleDataEntry,
    LifecycleLatestStable,
    LifecycleUnreleased,
    ManifestDocument,
    ManifestProjectEntry,
    ProjectAliasesEntry,
    ProjectCatalogDefaults,
    ProjectContentSettings,
    ProjectIdentity,
    ProjectLifecycleDocument,
    ProjectLifecycleDocumentData,
    ProjectLifecycleReleaseLine,
    ProjectLifecycleSettings,
    ProjectMetadata,
    ProjectNavigationSettings,
    ProjectVersionDocument,
    ProjectsDataDocument,
    ProjectsDataEntry,
    ProjectsCatalog,
    ProjectVersioningSettings,
    StagedAliasMapping,
    StagedProjectRef,
    StagedReleaseLine,
    _serialize_yaml_value,
    VersionAssets,
    VersionDescriptor,
    VersionSource,
)


def resolve_vendor_asset_source(site_root: Path, source_relative: Path) -> Path:
    """Return the on-disk source path for a vendored JavaScript asset."""

    node_modules_dir = os.environ.get("NODE_MODULES_DIR")
    if node_modules_dir:
        try:
            return Path(node_modules_dir) / source_relative.relative_to("node_modules")
        except ValueError:
            pass
    return site_root / source_relative


def repo_root_from(start: Path | None = None) -> Path:
    """Resolve the repository root for the current pipeline invocation."""

    if start is not None:
        return start.resolve()
    return Path(__file__).resolve().parents[3]


def load_yaml_like(path: Path) -> dict[str, Any]:
    """Load a YAML file and require the top-level value to be a mapping."""

    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle)

    if not isinstance(data, dict):
        raise ValueError(f"Expected mapping in {path}")
    return data


def mapping_or_empty(payload: dict[str, Any], key: str, label: str) -> dict[str, Any]:
    """Return a nested mapping or an empty mapping when the key is absent."""

    value = payload.get(key)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"Expected mapping for {label}")
    return value


def first_non_none(*values: Any) -> Any:
    """Return the first value that is not ``None``."""

    for value in values:
        if value is not None:
            return value
    return None


def first_defined_mapping_value(key: str, *mappings: dict[str, Any]) -> Any:
    """Return the first explicitly defined mapping value for ``key``."""

    for mapping in mappings:
        if key in mapping:
            return mapping[key]
    return None


def parse_int_like(value: Any, label: str) -> int:
    """Parse an integer-like value while rejecting booleans and junk input."""

    if isinstance(value, bool):
        raise ValueError(f"Expected integer for {label}")
    if isinstance(value, int):
        return value
    try:
        return int(str(value))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Expected integer for {label}") from exc


def _optional_string(value: Any) -> str | None:
    """Normalize an optional scalar field to ``str | None``."""

    if value is None:
        return None
    return str(value)


def _configured_string(payload: dict[str, Any], key: str) -> ConfiguredValue[str]:
    """Return a typed configured string while preserving key presence."""

    if key not in payload:
        return ConfiguredValue.unset()
    return ConfiguredValue(_optional_string(payload.get(key)), is_set=True)


def _configured_int(payload: dict[str, Any], key: str, label: str) -> ConfiguredValue[int]:
    """Return a typed configured integer while preserving key presence."""

    if key not in payload:
        return ConfiguredValue.unset()
    return ConfiguredValue(parse_int_like(payload.get(key), label), is_set=True)


def _schema_version(payload: dict[str, Any], label: str) -> int | None:
    """Parse an optional schema version field."""

    if "schemaVersion" not in payload or payload.get("schemaVersion") is None:
        return None
    return parse_int_like(payload.get("schemaVersion"), f"schemaVersion in {label}")


def _list_or_empty(payload: dict[str, Any], key: str, label: str) -> list[Any]:
    """Return a nested list value or an empty list when absent."""

    value = payload.get(key)
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"Expected list for {label}")
    return value


def _parse_catalog_defaults(payload: dict[str, Any], label: str) -> ProjectCatalogDefaults:
    """Parse the ``defaults`` section of ``site/projects.yaml``."""

    return ProjectCatalogDefaults(
        metadata_file=_optional_string(payload.get("metadataFile")),
        docs_root=_configured_string(payload, "docsRoot"),
        assets_root=_configured_string(payload, "assetsRoot"),
        unreleased_label=_optional_string(payload.get("unreleasedLabel")),
        tag_pattern=_optional_string(payload.get("tagPattern")),
        navigation_section=_optional_string(payload.get("navigationSection")),
    )


def _parse_catalog_project(payload: dict[str, Any], index: int, label: str) -> CatalogProject:
    """Parse one typed project entry from ``site/projects.yaml``."""

    slug = payload.get("slug")
    if slug is None:
        raise ValueError(f"Missing slug for project entry {index} in {label}")
    local_dir = payload.get("localDir")
    if local_dir is None:
        raise ValueError(f"Missing localDir for project {slug} in {label}")
    return CatalogProject(
        slug=str(slug),
        local_dir=str(local_dir),
        display_name=_optional_string(payload.get("displayName")),
        repository=_optional_string(payload.get("repository")),
        default_branch=_optional_string(payload.get("defaultBranch")),
        metadata_file=_optional_string(payload.get("metadataFile")),
        docs_root=_configured_string(payload, "docsRoot"),
        assets_root=_configured_string(payload, "assetsRoot"),
        unreleased_label=_optional_string(payload.get("unreleasedLabel")),
        tag_pattern=_optional_string(payload.get("tagPattern")),
        navigation_section=_optional_string(payload.get("navigationSection")),
        weight=_configured_int(payload, "weight", f"weight for {slug}"),
    )


def _parse_identity(payload: dict[str, Any]) -> ProjectIdentity:
    """Parse the ``project`` section of ``project.yaml``."""

    return ProjectIdentity(
        slug=_optional_string(payload.get("slug")),
        display_name=_optional_string(payload.get("displayName")),
        repository=_optional_string(payload.get("repository")),
        default_branch=_optional_string(payload.get("defaultBranch")),
    )


def _parse_content(payload: dict[str, Any]) -> ProjectContentSettings:
    """Parse the ``content`` section of ``project.yaml``."""

    return ProjectContentSettings(
        docs_root=_configured_string(payload, "docsRoot"),
        assets_root=_configured_string(payload, "assetsRoot"),
    )


def _parse_versioning(payload: dict[str, Any]) -> ProjectVersioningSettings:
    """Parse the ``versioning`` section of ``project.yaml``."""

    return ProjectVersioningSettings(
        unreleased_label=_optional_string(payload.get("unreleasedLabel")),
        tag_pattern=_optional_string(payload.get("tagPattern")),
    )


def _parse_release_line(raw_line: Any) -> ProjectLifecycleReleaseLine:
    """Parse one lifecycle release-line entry while preserving invalid-shape signals."""

    if not isinstance(raw_line, dict):
        return ProjectLifecycleReleaseLine(is_mapping=False)

    raw_aliases = raw_line.get("aliases")
    aliases_were_list = raw_aliases is None or isinstance(raw_aliases, list)
    aliases: tuple[str, ...] = ()
    if isinstance(raw_aliases, list):
        aliases = tuple(
            alias
            for alias in (str(raw_alias).strip() for raw_alias in raw_aliases if raw_alias is not None)
            if alias
        )

    return ProjectLifecycleReleaseLine(
        line=str(raw_line.get("line") or "").strip() or None,
        latest=str(raw_line.get("latest") or "").strip() or None,
        status=str(raw_line.get("status") or "").strip() or None,
        aliases=aliases,
        is_mapping=True,
        aliases_were_list=aliases_were_list,
    )


def _parse_lifecycle(payload: dict[str, Any]) -> ProjectLifecycleSettings:
    """Parse the ``lifecycle`` section of ``project.yaml``."""

    raw_release_lines = payload.get("releaseLines")
    release_lines_were_list = raw_release_lines is None or isinstance(raw_release_lines, list)
    parsed_release_lines = ()
    if isinstance(raw_release_lines, list):
        parsed_release_lines = tuple(_parse_release_line(raw_line) for raw_line in raw_release_lines)

    latest_stable = payload.get("latestStable")
    normalized_latest_stable = str(latest_stable).strip() if latest_stable is not None else None
    return ProjectLifecycleSettings(
        latest_stable=normalized_latest_stable or None,
        release_lines=parsed_release_lines,
        release_lines_were_list=release_lines_were_list,
    )


def _parse_navigation(payload: dict[str, Any]) -> ProjectNavigationSettings:
    """Parse the ``navigation`` section of ``project.yaml``."""

    return ProjectNavigationSettings(section=_optional_string(payload.get("section")))


def load_projects_catalog(path: Path) -> ProjectsCatalog:
    """Load ``site/projects.yaml`` into typed model classes."""

    catalog = load_yaml_like(path)
    defaults_payload = mapping_or_empty(catalog, "defaults", f"defaults in {path}")
    projects_payload = _list_or_empty(catalog, "projects", f"projects in {path}")
    projects: list[CatalogProject] = []
    for index, raw_project in enumerate(projects_payload, start=1):
        if not isinstance(raw_project, dict):
            raise ValueError(f"Expected mapping for project entry {index} in {path}")
        projects.append(_parse_catalog_project(raw_project, index, str(path)))
    return ProjectsCatalog(
        schema_version=_schema_version(catalog, str(path)),
        defaults=_parse_catalog_defaults(defaults_payload, str(path)),
        projects=tuple(projects),
    )


def load_project_metadata(repo_path: Path, metadata_relative: str | None, slug: str) -> tuple[ProjectMetadata, Path | None]:
    """Load optional per-project metadata and validate its slug if present."""

    if not metadata_relative:
        return ProjectMetadata(), None

    metadata_path = safe_relative_path(repo_path, metadata_relative, f"metadataFile for {slug}")
    if metadata_path is None or not metadata_path.is_file():
        return ProjectMetadata(), None

    raw_metadata = load_yaml_like(metadata_path)
    metadata = ProjectMetadata(
        schema_version=_schema_version(raw_metadata, str(metadata_path)),
        project=_parse_identity(mapping_or_empty(raw_metadata, "project", f"project metadata in {metadata_path}")),
        content=_parse_content(mapping_or_empty(raw_metadata, "content", f"content metadata in {metadata_path}")),
        versioning=_parse_versioning(mapping_or_empty(raw_metadata, "versioning", f"versioning metadata in {metadata_path}")),
        lifecycle=_parse_lifecycle(mapping_or_empty(raw_metadata, "lifecycle", f"lifecycle metadata in {metadata_path}")),
        navigation=_parse_navigation(mapping_or_empty(raw_metadata, "navigation", f"navigation metadata in {metadata_path}")),
        slug=_optional_string(raw_metadata.get("slug")),
        display_name=_optional_string(raw_metadata.get("displayName")),
        repository=_optional_string(raw_metadata.get("repository")),
        default_branch=_optional_string(raw_metadata.get("defaultBranch")),
        docs_root=_configured_string(raw_metadata, "docsRoot"),
        assets_root=_configured_string(raw_metadata, "assetsRoot"),
        unreleased_label=_optional_string(raw_metadata.get("unreleasedLabel")),
        tag_pattern=_optional_string(raw_metadata.get("tagPattern")),
        navigation_section=_optional_string(raw_metadata.get("navigationSection")),
    )
    metadata_slug = first_non_none(metadata.project.slug, metadata.slug)
    if metadata_slug is not None and str(metadata_slug) != slug:
        raise ValueError(f"Project metadata slug mismatch for {slug}: {metadata_slug}")

    return metadata, metadata_path


def _required_mapping(payload: dict[str, Any], key: str, label: str) -> dict[str, Any]:
    """Return a required nested mapping value."""

    value = payload.get(key)
    if not isinstance(value, dict):
        raise ValueError(f"Expected mapping for {label}")
    return value


def _required_string(payload: dict[str, Any], key: str, label: str) -> str:
    """Return a required string-like field from a mapping."""

    if key not in payload or payload.get(key) is None:
        raise ValueError(f"Missing {key} in {label}")
    return str(payload.get(key))


def _required_bool(payload: dict[str, Any], key: str, label: str) -> bool:
    """Return a required boolean field from a mapping."""

    value = payload.get(key)
    if not isinstance(value, bool):
        raise ValueError(f"Expected boolean for {key} in {label}")
    return value


def _parse_staged_project_ref(payload: dict[str, Any], label: str) -> StagedProjectRef:
    """Parse a staged project reference mapping."""

    return StagedProjectRef(
        slug=_required_string(payload, "slug", label),
        display_name=_required_string(payload, "displayName", label),
    )


def _parse_staged_release_line(payload: dict[str, Any], label: str) -> StagedReleaseLine:
    """Parse a staged release-line mapping."""

    raw_aliases = payload.get("aliases")
    if raw_aliases is None:
        aliases: tuple[str, ...] = ()
    elif isinstance(raw_aliases, list):
        aliases = tuple(str(alias) for alias in raw_aliases)
    else:
        raise ValueError(f"Expected list for aliases in {label}")
    return StagedReleaseLine(
        line=_required_string(payload, "line", label),
        latest=_required_string(payload, "latest", label),
        status=_required_string(payload, "status", label),
        aliases=aliases,
        path=_optional_string(payload.get("path")),
    )


def _parse_release_line_list(payload: dict[str, Any], key: str, label: str) -> tuple[StagedReleaseLine, ...]:
    """Parse a staged release-line list from a mapping."""

    raw_lines = payload.get(key)
    if raw_lines is None:
        return ()
    if not isinstance(raw_lines, list):
        raise ValueError(f"Expected list for {label}")
    release_lines: list[StagedReleaseLine] = []
    for index, raw_line in enumerate(raw_lines, start=1):
        if not isinstance(raw_line, dict):
            raise ValueError(f"Expected mapping for release line {index} in {label}")
        release_lines.append(_parse_staged_release_line(raw_line, f"release line {index} in {label}"))
    return tuple(release_lines)


def _parse_alias_mapping(payload: dict[str, Any], label: str) -> StagedAliasMapping:
    """Parse a staged alias mapping."""

    return StagedAliasMapping(
        alias=_required_string(payload, "alias", label),
        target=_required_string(payload, "target", label),
        line=_required_string(payload, "line", label),
        status=_required_string(payload, "status", label),
    )


def _parse_alias_mapping_list(payload: dict[str, Any], key: str, label: str) -> tuple[StagedAliasMapping, ...]:
    """Parse a staged alias-mapping list from a mapping."""

    raw_aliases = payload.get(key)
    if raw_aliases is None:
        return ()
    if not isinstance(raw_aliases, list):
        raise ValueError(f"Expected list for {label}")
    aliases: list[StagedAliasMapping] = []
    for index, raw_alias in enumerate(raw_aliases, start=1):
        if not isinstance(raw_alias, dict):
            raise ValueError(f"Expected mapping for alias {index} in {label}")
        aliases.append(_parse_alias_mapping(raw_alias, f"alias {index} in {label}"))
    return tuple(aliases)


def load_version_document(path: Path) -> ProjectVersionDocument:
    """Load a staged project ``version.yaml`` file into typed model classes."""

    payload = load_yaml_like(path)
    return ProjectVersionDocument(
        schema_version=parse_int_like(payload.get("schemaVersion"), f"schemaVersion in {path}"),
        project=_parse_staged_project_ref(_required_mapping(payload, "project", f"project in {path}"), f"project in {path}"),
        version=VersionDescriptor(
            kind=_required_string(_required_mapping(payload, "version", f"version in {path}"), "kind", f"version in {path}"),
            label=_required_string(_required_mapping(payload, "version", f"version in {path}"), "label", f"version in {path}"),
            path=_required_string(_required_mapping(payload, "version", f"version in {path}"), "path", f"version in {path}"),
            docs_path=_optional_string(_required_mapping(payload, "version", f"version in {path}").get("docsPath")),
        ),
        source=VersionSource(
            repository=_optional_string(_required_mapping(payload, "source", f"source in {path}").get("repository")),
            local_dir=_required_string(_required_mapping(payload, "source", f"source in {path}"), "localDir", f"source in {path}"),
            metadata_file=_required_string(_required_mapping(payload, "source", f"source in {path}"), "metadataFile", f"source in {path}"),
            metadata_loaded=_required_bool(_required_mapping(payload, "source", f"source in {path}"), "metadataLoaded", f"source in {path}"),
            default_branch=_optional_string(_required_mapping(payload, "source", f"source in {path}").get("defaultBranch")),
            docs_root=_optional_string(_required_mapping(payload, "source", f"source in {path}").get("docsRoot")),
            assets_root=_optional_string(_required_mapping(payload, "source", f"source in {path}").get("assetsRoot")),
        ),
        assets=VersionAssets(
            count=parse_int_like(_required_mapping(payload, "assets", f"assets in {path}").get("count"), f"assets.count in {path}"),
            path=_optional_string(_required_mapping(payload, "assets", f"assets in {path}").get("path")),
        ),
    )


def load_project_lifecycle_document(path: Path) -> ProjectLifecycleDocument:
    """Load a staged project ``lifecycle.yaml`` file into typed model classes."""

    payload = load_yaml_like(path)
    lifecycle_payload = _required_mapping(payload, "lifecycle", f"lifecycle in {path}")
    latest_stable_payload = lifecycle_payload.get("latestStable")
    latest_stable = None
    if latest_stable_payload is not None:
        if not isinstance(latest_stable_payload, dict):
            raise ValueError(f"Expected mapping for latestStable in {path}")
        latest_stable = LifecycleLatestStable(
            version=_required_string(latest_stable_payload, "version", f"latestStable in {path}"),
            path=_optional_string(latest_stable_payload.get("path")),
        )
    return ProjectLifecycleDocument(
        schema_version=parse_int_like(payload.get("schemaVersion"), f"schemaVersion in {path}"),
        project=_parse_staged_project_ref(_required_mapping(payload, "project", f"project in {path}"), f"project in {path}"),
        lifecycle=ProjectLifecycleDocumentData(
            unreleased=LifecycleUnreleased(
                label=_required_string(_required_mapping(lifecycle_payload, "unreleased", f"unreleased in {path}"), "label", f"unreleased in {path}"),
                path=_required_string(_required_mapping(lifecycle_payload, "unreleased", f"unreleased in {path}"), "path", f"unreleased in {path}"),
                docs_path=_optional_string(_required_mapping(lifecycle_payload, "unreleased", f"unreleased in {path}").get("docsPath")),
                robots=_optional_string(_required_mapping(lifecycle_payload, "unreleased", f"unreleased in {path}").get("robots")),
            ),
            latest_stable=latest_stable,
            release_lines=_parse_release_line_list(lifecycle_payload, "releaseLines", f"releaseLines in {path}"),
        ),
    )


def load_manifest_document(path: Path) -> ManifestDocument:
    """Load the staged root ``manifest.yaml`` file into typed model classes."""

    payload = load_yaml_like(path)
    raw_projects = _list_or_empty(payload, "projects", f"projects in {path}")
    projects: list[ManifestProjectEntry] = []
    for index, raw_project in enumerate(raw_projects, start=1):
        if not isinstance(raw_project, dict):
            raise ValueError(f"Expected mapping for manifest project {index} in {path}")
        projects.append(
            ManifestProjectEntry(
                slug=_required_string(raw_project, "slug", f"manifest project {index} in {path}"),
                display_name=_required_string(raw_project, "displayName", f"manifest project {index} in {path}"),
                weight=parse_int_like(raw_project.get("weight"), f"weight for manifest project {index} in {path}"),
                available=_required_bool(raw_project, "available", f"manifest project {index} in {path}"),
                local_dir=_required_string(raw_project, "localDir", f"manifest project {index} in {path}"),
                repository=_optional_string(raw_project.get("repository")),
                default_branch=_optional_string(raw_project.get("defaultBranch")),
                project_path=_optional_string(raw_project.get("projectPath")),
                unreleased_path=_optional_string(raw_project.get("unreleasedPath")),
                docs_path=_optional_string(raw_project.get("docsPath")),
            )
        )
    return ManifestDocument(
        schema_version=parse_int_like(payload.get("schemaVersion"), f"schemaVersion in {path}"),
        generated_at=_required_string(payload, "generatedAt", f"manifest in {path}"),
        repo_root=_required_string(payload, "repoRoot", f"manifest in {path}"),
        projects=tuple(projects),
    )


def load_projects_data_document(path: Path) -> ProjectsDataDocument:
    """Load staged aggregated ``data/projects.yaml`` into typed model classes."""

    payload = load_yaml_like(path)
    projects_payload = _required_mapping(payload, "projects", f"projects in {path}")
    projects: dict[str, ProjectsDataEntry] = {}
    for slug, raw_project in projects_payload.items():
        if not isinstance(raw_project, dict):
            raise ValueError(f"Expected mapping for project {slug} in {path}")
        projects[str(slug)] = ProjectsDataEntry(
            display_name=_required_string(raw_project, "displayName", f"project {slug} in {path}"),
            weight=parse_int_like(raw_project.get("weight"), f"weight for project {slug} in {path}"),
            available=_required_bool(raw_project, "available", f"project {slug} in {path}"),
            local_dir=_required_string(raw_project, "localDir", f"project {slug} in {path}"),
            repository=_optional_string(raw_project.get("repository")),
            summary=_required_string(raw_project, "summary", f"project {slug} in {path}"),
            default_branch=_optional_string(raw_project.get("defaultBranch")),
            navigation_section=_optional_string(raw_project.get("navigationSection")),
            unreleased_label=_required_string(raw_project, "unreleasedLabel", f"project {slug} in {path}"),
            project_path=_optional_string(raw_project.get("projectPath")),
            unreleased_path=_optional_string(raw_project.get("unreleasedPath")),
            docs_path=_optional_string(raw_project.get("docsPath")),
            asset_count=parse_int_like(raw_project.get("assetCount"), f"assetCount for project {slug} in {path}"),
            assets_path=_optional_string(raw_project.get("assetsPath")),
            latest_stable=_optional_string(raw_project.get("latestStable")),
            latest_stable_path=_optional_string(raw_project.get("latestStablePath")),
            release_lines=_parse_release_line_list(raw_project, "releaseLines", f"releaseLines for project {slug} in {path}"),
        )
    return ProjectsDataDocument(
        schema_version=parse_int_like(payload.get("schemaVersion"), f"schemaVersion in {path}"),
        projects=projects,
    )


def load_lifecycle_data_document(path: Path) -> LifecycleDataDocument:
    """Load staged aggregated ``data/lifecycle.yaml`` into typed model classes."""

    payload = load_yaml_like(path)
    projects_payload = _required_mapping(payload, "projects", f"projects in {path}")
    projects: dict[str, LifecycleDataEntry] = {}
    for slug, raw_project in projects_payload.items():
        if not isinstance(raw_project, dict):
            raise ValueError(f"Expected mapping for lifecycle project {slug} in {path}")
        raw_unreleased = raw_project.get("unreleased")
        unreleased = None
        if raw_unreleased is not None:
            if not isinstance(raw_unreleased, dict):
                raise ValueError(f"Expected mapping for unreleased in project {slug} in {path}")
            unreleased = LifecycleUnreleased(
                label=_required_string(raw_unreleased, "label", f"unreleased for project {slug} in {path}"),
                path=_required_string(raw_unreleased, "path", f"unreleased for project {slug} in {path}"),
                docs_path=_optional_string(raw_unreleased.get("docsPath")),
                robots=_optional_string(raw_unreleased.get("robots")),
            )
        projects[str(slug)] = LifecycleDataEntry(
            latest_stable=_optional_string(raw_project.get("latestStable")),
            release_lines=_parse_release_line_list(raw_project, "releaseLines", f"releaseLines for project {slug} in {path}"),
            unreleased=unreleased,
        )
    return LifecycleDataDocument(
        schema_version=parse_int_like(payload.get("schemaVersion"), f"schemaVersion in {path}"),
        projects=projects,
    )


def load_aliases_data_document(path: Path) -> AliasesDataDocument:
    """Load staged aggregated ``data/aliases.yaml`` into typed model classes."""

    payload = load_yaml_like(path)
    projects_payload = _required_mapping(payload, "projects", f"projects in {path}")
    projects: dict[str, ProjectAliasesEntry] = {}
    for slug, raw_project in projects_payload.items():
        if not isinstance(raw_project, dict):
            raise ValueError(f"Expected mapping for aliases project {slug} in {path}")
        projects[str(slug)] = ProjectAliasesEntry(
            aliases=_parse_alias_mapping_list(raw_project, "aliases", f"aliases for project {slug} in {path}")
        )
    return AliasesDataDocument(
        schema_version=parse_int_like(payload.get("schemaVersion"), f"schemaVersion in {path}"),
        projects=projects,
    )


def write_yaml_like(path: Path, payload: Any) -> None:
    """Write YAML-safe content with stable formatting used across the pipeline."""

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        yaml.safe_dump(_serialize_yaml_value(payload), handle, sort_keys=False, allow_unicode=True, default_flow_style=False)


def ensure_within(parent: Path, candidate: Path, label: str) -> Path:
    """Resolve ``candidate`` and reject paths that escape ``parent``."""

    parent_resolved = parent.resolve()
    candidate_resolved = candidate.resolve(strict=False)
    common = os.path.commonpath([str(parent_resolved), str(candidate_resolved)])
    if common != str(parent_resolved):
        raise ValueError(f"{label} escapes allowed root: {candidate}")
    return candidate_resolved


def safe_repo_path(repo_root: Path, local_dir: str) -> Path:
    """Resolve a configured sibling-repository path within the workspace parent."""

    workspace_parent = repo_root.parent.resolve()
    return ensure_within(workspace_parent, workspace_parent / local_dir, "Project localDir")


def safe_relative_path(base: Path, relative_path: str | None, label: str) -> Path | None:
    """Resolve an optional relative path beneath ``base``."""

    if not relative_path:
        return None
    return ensure_within(base, base / relative_path, label)


def copy_tree_without_symlinks(source: Path, destination: Path) -> list[Path]:
    """Copy a directory tree while skipping dotfiles and symbolic links."""

    copied: list[Path] = []
    for current_root, dir_names, file_names in os.walk(source):
        current = Path(current_root)
        dir_names[:] = sorted(
            name for name in dir_names if not (current / name).is_symlink() and not name.startswith(".")
        )
        for file_name in sorted(file_names):
            source_file = current / file_name
            if source_file.is_symlink() or file_name.startswith("."):
                continue
            relative = source_file.relative_to(source)
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_file, target)
            copied.append(relative)
    return copied


def stage_vendor_assets(site_root: Path, stage_root: Path) -> None:
    """Copy optional vendored JavaScript assets into the staged site tree."""

    for source_relative, destination_relative in STAGED_VENDOR_ASSETS:
        source = resolve_vendor_asset_source(site_root, source_relative)
        if not source.is_file():
            continue
        destination = stage_root / destination_relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)


def reset_output_directory(path: Path) -> None:
    """Empty an output directory without following symlinks."""

    if path.exists() and (not path.is_dir() or path.is_symlink()):
        path.unlink()
    path.mkdir(parents=True, exist_ok=True)
    for child in path.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()


def watchable_existing_path(candidate: Path, fallback: Path) -> Path:
    """Return the nearest existing path to watch for a not-yet-created input."""

    current = candidate.resolve(strict=False)
    fallback_resolved = fallback.resolve(strict=False)
    while True:
        if current.exists():
            return current
        if current == fallback_resolved:
            return fallback_resolved
        current = current.parent


def read_text_if_exists(path: Path | None) -> str:
    """Read a text file if it exists, otherwise return an empty string."""

    if path is None or not path.is_file():
        return ""
    return path.read_text(encoding="utf-8")