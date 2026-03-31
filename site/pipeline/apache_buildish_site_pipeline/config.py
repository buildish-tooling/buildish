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

"""Configuration loading and precedence rules for the site pipeline."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import Field

from .filesystem import repo_root_from
from .models import YamlModel

ProjectStatus = Literal["incubating", "graduated", "retired"]

DEFAULT_SITE_PIPELINE_CONFIG_PATH = Path("site/site-pipeline.yaml")
DEFAULT_CATALOG_PATH = Path("site/components.yaml")
DEFAULT_AUTHORED_SITE_CONTENT_PATH = Path("site/content")
DEFAULT_STAGE_PATH = Path("site/.stage")
DEFAULT_PREVIEW_PATH = Path("site/.preview")
DEFAULT_SITE_TITLE = "Apache Project Site"
DEFAULT_PROJECT_STATUS: ProjectStatus = "incubating"


class SitePipelineSiteConfig(YamlModel):
    """Site-facing configuration values exposed by the pipeline."""

    site_title: str | None = None
    project_status: ProjectStatus | None = None


class SitePipelineWorkspaceConfig(YamlModel):
    """Workspace-facing configuration values exposed by the pipeline."""

    catalog_path: str | None = None
    authored_site_content_path: str | None = None
    stage_path: str | None = None
    preview_path: str | None = None


@dataclass(frozen=True)
class ResolvedWorkspacePaths:
    """Effective workspace paths after merging CLI, file, and defaults."""

    repo_root: Path
    config_path: Path | None
    site_root: Path
    authored_site_content_path: Path
    stage_path: Path
    preview_path: Path


class SitePipelineConfigFile(YamlModel):
    """Top-level configuration document for one site-pipeline workspace."""

    schema_version: int = Field(default=1)
    workspace: SitePipelineWorkspaceConfig = Field(
        default_factory=SitePipelineWorkspaceConfig
    )
    site: SitePipelineSiteConfig = Field(default_factory=SitePipelineSiteConfig)


@dataclass(frozen=True)
class ResolvedPipelineConfig(ResolvedWorkspacePaths):
    """Effective runtime configuration after merging CLI, file, and defaults."""

    catalog_path: Path
    site_title: str
    project_status: ProjectStatus


def resolve_workspace_paths(
    repo_root: Path | None = None,
    *,
    config_path: str | Path | None = None,
    catalog_path: str | Path | None = None,
    authored_site_content_path: str | Path | None = None,
    stage_path: str | Path | None = None,
    preview_path: str | Path | None = None,
) -> ResolvedWorkspacePaths:
    """Resolve the effective workspace paths for one pipeline invocation."""

    resolved_repo_root = repo_root_from(repo_root)
    resolved_config_path, file_config = _load_pipeline_config_file(
        resolved_repo_root, config_path
    )
    return _resolve_workspace_paths_from_file_config(
        resolved_repo_root,
        resolved_config_path,
        file_config,
        catalog_path=catalog_path,
        authored_site_content_path=authored_site_content_path,
        stage_path=stage_path,
        preview_path=preview_path,
    )


def resolve_pipeline_config(
    repo_root: Path | None = None,
    *,
    config_path: str | Path | None = None,
    catalog_path: str | Path | None = None,
    authored_site_content_path: str | Path | None = None,
    stage_path: str | Path | None = None,
    preview_path: str | Path | None = None,
    site_title: str | None = None,
    project_status: ProjectStatus | None = None,
) -> ResolvedPipelineConfig:
    """Resolve the effective configuration for one pipeline invocation."""

    resolved_repo_root = repo_root_from(repo_root)
    resolved_config_path, file_config = _load_pipeline_config_file(
        resolved_repo_root, config_path
    )
    workspace_paths = _resolve_workspace_paths_from_file_config(
        resolved_repo_root,
        resolved_config_path,
        file_config,
        catalog_path=catalog_path,
        authored_site_content_path=authored_site_content_path,
        stage_path=stage_path,
        preview_path=preview_path,
    )
    resolved_catalog_path = _resolve_catalog_path(
        resolved_repo_root,
        (
            catalog_path
            if catalog_path is not None
            else file_config.workspace.catalog_path
        ),
    )
    return ResolvedPipelineConfig(
        repo_root=workspace_paths.repo_root,
        config_path=workspace_paths.config_path,
        site_root=workspace_paths.site_root,
        authored_site_content_path=workspace_paths.authored_site_content_path,
        stage_path=workspace_paths.stage_path,
        preview_path=workspace_paths.preview_path,
        catalog_path=resolved_catalog_path,
        site_title=site_title or file_config.site.site_title or DEFAULT_SITE_TITLE,
        project_status=(
            project_status or file_config.site.project_status or DEFAULT_PROJECT_STATUS
        ),
    )


def _resolve_config_path(
    repo_root: Path, config_path: str | Path | None
) -> Path | None:
    """Resolve a config path within the repo root, or return ``None`` if absent."""

    if config_path is None:
        candidate = (repo_root / DEFAULT_SITE_PIPELINE_CONFIG_PATH).resolve(
            strict=False
        )
        return candidate if candidate.is_file() else None

    return _resolve_repo_file_path(
        repo_root,
        config_path,
        boundary_label="Config path",
        missing_label="Config file",
    )


def _load_pipeline_config_file(
    repo_root: Path, config_path: str | Path | None
) -> tuple[Path | None, SitePipelineConfigFile]:
    """Resolve and load the optional pipeline config file."""

    resolved_config_path = _resolve_config_path(repo_root, config_path)
    file_config = (
        SitePipelineConfigFile.from_yaml_path(resolved_config_path)
        if resolved_config_path is not None
        else SitePipelineConfigFile()
    )
    return resolved_config_path, file_config


def _resolve_catalog_path(repo_root: Path, catalog_path: str | Path | None) -> Path:
    """Resolve the effective component catalog path within the repo root."""

    return _resolve_repo_file_path(
        repo_root,
        DEFAULT_CATALOG_PATH if catalog_path is None else catalog_path,
        boundary_label="Catalog path",
        missing_label="Catalog file",
    )


def _resolve_workspace_paths_from_file_config(
    repo_root: Path,
    config_path: Path | None,
    file_config: SitePipelineConfigFile,
    *,
    catalog_path: str | Path | None,
    authored_site_content_path: str | Path | None,
    stage_path: str | Path | None,
    preview_path: str | Path | None,
) -> ResolvedWorkspacePaths:
    """Resolve workspace-rooted input and output paths from config sources."""

    site_root = (repo_root / "site").resolve(strict=False)
    resolved_authored_site_content_path = _resolve_repo_path(
        repo_root,
        (
            authored_site_content_path
            if authored_site_content_path is not None
            else file_config.workspace.authored_site_content_path
            or DEFAULT_AUTHORED_SITE_CONTENT_PATH
        ),
        boundary_label="Authored site content path",
    )
    resolved_stage_path = _resolve_repo_path(
        repo_root,
        stage_path if stage_path is not None else file_config.workspace.stage_path or DEFAULT_STAGE_PATH,
        boundary_label="Stage output path",
    )
    resolved_preview_path = _resolve_repo_path(
        repo_root,
        preview_path
        if preview_path is not None
        else file_config.workspace.preview_path
        or DEFAULT_PREVIEW_PATH,
        boundary_label="Preview output path",
    )
    resolved_catalog_path = _resolve_repo_path(
        repo_root,
        catalog_path
        if catalog_path is not None
        else file_config.workspace.catalog_path or DEFAULT_CATALOG_PATH,
        boundary_label="Catalog path",
    )
    _validate_workspace_paths(
        repo_root,
        site_root,
        config_path,
        resolved_catalog_path,
        resolved_authored_site_content_path,
        resolved_stage_path,
        resolved_preview_path,
    )
    return ResolvedWorkspacePaths(
        repo_root=repo_root,
        config_path=config_path,
        site_root=site_root,
        authored_site_content_path=resolved_authored_site_content_path,
        stage_path=resolved_stage_path,
        preview_path=resolved_preview_path,
    )


def _resolve_repo_file_path(
    repo_root: Path,
    raw_path: str | Path,
    *,
    boundary_label: str,
    missing_label: str,
) -> Path:
    """Resolve one file path beneath ``repo_root`` while enforcing repo boundaries."""

    candidate = Path(raw_path)
    if not candidate.is_absolute():
        candidate = (repo_root / candidate).resolve(strict=False)
    else:
        candidate = candidate.resolve(strict=False)

    repo_root_resolved = repo_root.resolve(strict=False)
    try:
        candidate.relative_to(repo_root_resolved)
    except ValueError as exc:
        raise ValueError(f"{boundary_label} must stay within the repository root: {candidate}") from exc

    if not candidate.is_file():
        raise ValueError(f"{missing_label} not found: {candidate}")
    return candidate


def _resolve_repo_path(
    repo_root: Path, raw_path: str | Path, *, boundary_label: str
) -> Path:
    """Resolve one path beneath ``repo_root`` while enforcing repo boundaries."""

    candidate = Path(raw_path)
    if not candidate.is_absolute():
        candidate = (repo_root / candidate).resolve(strict=False)
    else:
        candidate = candidate.resolve(strict=False)

    repo_root_resolved = repo_root.resolve(strict=False)
    try:
        candidate.relative_to(repo_root_resolved)
    except ValueError as exc:
        raise ValueError(
            f"{boundary_label} must stay within the repository root: {candidate}"
        ) from exc
    return candidate


def _paths_overlap(left: Path, right: Path) -> bool:
    """Return whether two resolved paths overlap in either direction."""

    try:
        left.relative_to(right)
        return True
    except ValueError:
        pass
    try:
        right.relative_to(left)
        return True
    except ValueError:
        return False


def _path_contains(root: Path, candidate: Path) -> bool:
    """Return whether ``candidate`` is equal to or nested beneath ``root``."""

    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def _validate_workspace_paths(
    repo_root: Path,
    site_root: Path,
    config_path: Path | None,
    catalog_path: Path,
    authored_site_content_path: Path,
    stage_path: Path,
    preview_path: Path,
) -> None:
    """Reject dangerous workspace path combinations before any filesystem writes."""

    path_labels = {
        authored_site_content_path: "Authored site content path",
        stage_path: "Stage output path",
        preview_path: "Preview output path",
    }
    for path, label in path_labels.items():
        if path == repo_root:
            raise ValueError(f"{label} must not be the repository root: {path}")
        if path.exists() and (not path.is_dir() or path.is_symlink()):
            raise ValueError(f"{label} must be a directory path: {path}")

    if _paths_overlap(authored_site_content_path, stage_path):
        raise ValueError(
            "Authored site content path must not overlap with the stage output path"
        )
    if _paths_overlap(authored_site_content_path, preview_path):
        raise ValueError(
            "Authored site content path must not overlap with the preview output path"
        )
    if _paths_overlap(stage_path, preview_path):
        raise ValueError("Stage output path must not overlap with the preview output path")

    protected_site_roots = (
        tuple(
            child.resolve(strict=False)
            for child in site_root.iterdir()
            if child.is_dir() and not child.name.startswith(".") and child.name != "build"
        )
        if site_root.is_dir()
        else tuple()
    )
    for output_path, output_label in (
        (stage_path, "Stage output path"),
        (preview_path, "Preview output path"),
    ):
        for protected_root in protected_site_roots:
            if _paths_overlap(output_path, protected_root):
                raise ValueError(
                    f"{output_label} must not overlap with protected site source root: {protected_root}"
                )

    protected_files = [site_root / "components.local.yaml", catalog_path]
    if config_path is not None:
        protected_files.append(config_path)
    for protected_file in protected_files:
        if not protected_file.exists() and protected_file != catalog_path:
            continue
        if _path_contains(authored_site_content_path, protected_file):
            raise ValueError(
                f"Authored site content path must not contain protected workspace file: {protected_file}"
            )
        for output_path, output_label in (
            (stage_path, "Stage output path"),
            (preview_path, "Preview output path"),
        ):
            if _path_contains(output_path, protected_file):
                raise ValueError(
                    f"{output_label} must not contain protected workspace file: {protected_file}"
                )
