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
from .models import CatalogComponent, ComponentMetadata, ComponentsLocalOverrides
from .yaml_support import yaml_safe_value


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


def load_component_metadata(
    repo_path: Path, metadata_relative: str | None, slug: str
) -> tuple[ComponentMetadata, Path | None]:
    """Load optional per-component metadata and validate its slug if present."""

    if not metadata_relative:
        return ComponentMetadata(), None

    metadata_path = safe_relative_path(
        repo_path, metadata_relative, f"metadataFile for {slug}"
    )
    if metadata_path is None or not metadata_path.is_file():
        return ComponentMetadata(), None

    metadata = ComponentMetadata.from_yaml_path(metadata_path)
    metadata_slug = metadata.component.slug
    if metadata_slug is not None and str(metadata_slug) != slug:
        raise ValueError(
            f"Component metadata slug mismatch for {slug}: {metadata_slug}"
        )

    return metadata, metadata_path


def write_yaml_like(path: Path, payload: Any) -> None:
    """Write YAML-safe content with stable formatting used across the pipeline."""

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        yaml.safe_dump(
            yaml_safe_value(payload),
            handle,
            sort_keys=False,
            allow_unicode=True,
            default_flow_style=False,
        )


def _ensure_within(parent: Path, candidate: Path, label: str) -> Path:
    """Resolve ``candidate`` and reject paths that escape ``parent``."""

    parent_resolved = parent.resolve()
    candidate_resolved = candidate.resolve(strict=False)
    common = os.path.commonpath([str(parent_resolved), str(candidate_resolved)])
    if common != str(parent_resolved):
        raise ValueError(f"{label} escapes allowed root: {candidate}")
    return candidate_resolved


def safe_repo_path(repo_root: Path, local_dir: str) -> Path:
    """Resolve a configured sibling-repository path within the workspace parent."""

    return safe_workspace_checkout_path(repo_root, local_dir, "Component localDir")


def safe_workspace_checkout_path(
    repo_root: Path,
    checkout_dir: str,
    label: str,
    *,
    relative_to_repo_root: bool = False,
) -> Path:
    """Resolve one workspace checkout path while enforcing the workspace-parent boundary."""

    workspace_parent = repo_root.parent.resolve()
    candidate = Path(checkout_dir)
    if not candidate.is_absolute():
        base_root = repo_root if relative_to_repo_root else workspace_parent
        candidate = base_root / checkout_dir
    return _ensure_within(workspace_parent, candidate, label)


def load_components_local_overrides(site_root: Path) -> ComponentsLocalOverrides:
    """Load optional local source bindings from ``site/components.local.yaml``."""

    overrides_path = site_root / "components.local.yaml"
    if not overrides_path.is_file():
        return ComponentsLocalOverrides()
    return ComponentsLocalOverrides.from_yaml_path(overrides_path)


def resolve_component_repo_path(
    repo_root: Path,
    component: CatalogComponent,
    local_overrides: ComponentsLocalOverrides | None = None,
) -> Path:
    """Resolve the effective local checkout path for one component."""

    override = None
    if local_overrides is not None:
        binding = local_overrides.workspace.components.get(component.slug)
        if binding is not None:
            override = binding.checkout_dir
    if override is not None:
        return safe_workspace_checkout_path(
            repo_root,
            override,
            f"Local override checkoutDir for {component.slug}",
            relative_to_repo_root=True,
        )
    return safe_repo_path(repo_root, component.local_dir)


def safe_relative_path(
    base: Path, relative_path: str | None, label: str
) -> Path | None:
    """Resolve an optional relative path beneath ``base``."""

    if not relative_path:
        return None
    return _ensure_within(base, base / relative_path, label)


def copy_tree_without_symlinks(source: Path, destination: Path) -> list[Path]:
    """Copy a directory tree while skipping dotfiles and symbolic links."""

    copied: list[Path] = []
    for current_root, dir_names, file_names in os.walk(source):
        current = Path(current_root)
        dir_names[:] = sorted(
            name
            for name in dir_names
            if not (current / name).is_symlink() and not name.startswith(".")
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
