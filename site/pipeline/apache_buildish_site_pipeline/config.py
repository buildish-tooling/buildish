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
DEFAULT_SITE_TITLE = "Apache Buildish (Incubating)"
DEFAULT_PROJECT_STATUS: ProjectStatus = "incubating"


class SitePipelineSiteConfig(YamlModel):
    """Site-facing configuration values exposed by the pipeline."""

    site_title: str | None = None
    project_status: ProjectStatus | None = None


class SitePipelineWorkspaceConfig(YamlModel):
    """Workspace-facing configuration values exposed by the pipeline."""

    catalog_path: str | None = None


class SitePipelineConfigFile(YamlModel):
    """Top-level configuration document for one site-pipeline workspace."""

    schema_version: int = Field(default=1)
    workspace: SitePipelineWorkspaceConfig = Field(
        default_factory=SitePipelineWorkspaceConfig
    )
    site: SitePipelineSiteConfig = Field(default_factory=SitePipelineSiteConfig)


@dataclass(frozen=True)
class ResolvedPipelineConfig:
    """Effective runtime configuration after merging CLI, file, and defaults."""

    repo_root: Path
    config_path: Path | None
    catalog_path: Path
    site_title: str
    project_status: ProjectStatus


def resolve_pipeline_config(
    repo_root: Path | None = None,
    *,
    config_path: str | Path | None = None,
    catalog_path: str | Path | None = None,
    site_title: str | None = None,
    project_status: ProjectStatus | None = None,
) -> ResolvedPipelineConfig:
    """Resolve the effective configuration for one pipeline invocation."""

    resolved_repo_root = repo_root_from(repo_root)
    resolved_config_path = _resolve_config_path(resolved_repo_root, config_path)
    file_config = (
        SitePipelineConfigFile.from_yaml_path(resolved_config_path)
        if resolved_config_path is not None
        else SitePipelineConfigFile()
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
        repo_root=resolved_repo_root,
        config_path=resolved_config_path,
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


def _resolve_catalog_path(repo_root: Path, catalog_path: str | Path | None) -> Path:
    """Resolve the effective component catalog path within the repo root."""

    return _resolve_repo_file_path(
        repo_root,
        DEFAULT_CATALOG_PATH if catalog_path is None else catalog_path,
        boundary_label="Catalog path",
        missing_label="Catalog file",
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
