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

"""Watch-mode helpers for the site pipeline.

These functions decide which paths should trigger a rebuild and run the
long-lived watcher loop used by local development targets.
"""

from __future__ import annotations

import sys
from pathlib import Path

from .builder import build
from .constants import STAGED_VENDOR_ASSETS, WATCH_DEBOUNCE_MS, WATCH_IGNORE_PATH_PARTS, WATCH_IGNORE_SUFFIXES, WATCH_STEP_MS
from .filesystem import (
    load_projects_catalog,
    load_project_metadata,
    repo_root_from,
    resolve_vendor_asset_source,
    safe_relative_path,
    safe_repo_path,
    watchable_existing_path,
)
from .models import CatalogProject, ProjectCatalogDefaults, ProjectMetadata


def _configured_content_root(
    project: CatalogProject,
    metadata: ProjectMetadata,
    defaults: ProjectCatalogDefaults,
    key: str,
) -> str | None:
    """Resolve typed docs/assets settings for watch-root collection."""

    if key == "docsRoot":
        if project.docs_root.is_set:
            return project.docs_root.value
        if metadata.content.docs_root.is_set:
            return metadata.content.docs_root.value
        if metadata.docs_root.is_set:
            return metadata.docs_root.value
        if defaults.docs_root.is_set:
            return defaults.docs_root.value
        return None
    if project.assets_root.is_set:
        return project.assets_root.value
    if metadata.content.assets_root.is_set:
        return metadata.content.assets_root.value
    if metadata.assets_root.is_set:
        return metadata.assets_root.value
    if defaults.assets_root.is_set:
        return defaults.assets_root.value
    return None


def project_watch_roots(repo_root: Path, project: CatalogProject, defaults: ProjectCatalogDefaults) -> set[Path]:
    """Return the filesystem paths that can affect one project's staged output."""

    slug = project.slug
    local_dir = project.local_dir
    repo_path = safe_repo_path(repo_root, local_dir)
    parent_fallback = repo_path.parent if repo_path.parent.exists() else repo_root.parent.resolve()

    if not repo_path.exists():
        return {watchable_existing_path(repo_path, parent_fallback)}

    metadata_relative = project.metadata_file or defaults.metadata_file or "site/project.yaml"
    metadata, _ = load_project_metadata(repo_path, metadata_relative, slug)

    watch_roots: set[Path] = set()

    metadata_path = safe_relative_path(repo_path, metadata_relative, f"metadataFile for {slug}")
    if metadata_path is not None:
        watch_roots.add(watchable_existing_path(metadata_path, repo_path))

    docs_setting = _configured_content_root(project, metadata, defaults, "docsRoot")
    if docs_setting is not None:
        docs_path = safe_relative_path(repo_path, str(docs_setting), f"docsRoot for {slug}")
        if docs_path is not None:
            watch_roots.add(watchable_existing_path(docs_path, repo_path))

    assets_setting = _configured_content_root(project, metadata, defaults, "assetsRoot")
    if assets_setting is not None:
        assets_path = safe_relative_path(repo_path, str(assets_setting), f"assetsRoot for {slug}")
        if assets_path is not None:
            watch_roots.add(watchable_existing_path(assets_path, repo_path))

    return watch_roots


def collect_watch_roots(repo_root: Path | None = None) -> list[Path]:
    """Collect every path that should trigger a full staged rebuild."""

    resolved_repo_root = repo_root_from(repo_root)
    site_root = resolved_repo_root / "site"
    catalog = load_projects_catalog(site_root / "projects.yaml")

    watch_roots: set[Path] = {
        watchable_existing_path(site_root / "projects.yaml", site_root),
        watchable_existing_path(site_root / "content", site_root),
        watchable_existing_path(site_root / "pipeline", site_root),
    }

    for source_relative, _ in STAGED_VENDOR_ASSETS:
        source = resolve_vendor_asset_source(site_root, source_relative)
        if source.exists():
            watch_roots.add(source.resolve())

    for project in catalog.projects:
        watch_roots.update(project_watch_roots(resolved_repo_root, project, catalog.defaults))

    return sorted(watch_roots, key=str)


def is_relevant_watch_path(path: Path) -> bool:
    """Filter out temporary editor files and generated output paths."""

    name = path.name
    if name.startswith(".#") or name == "4913":
        return False
    if name.endswith(WATCH_IGNORE_SUFFIXES):
        return False
    return not any(part in WATCH_IGNORE_PATH_PARTS for part in path.parts)


def format_watch_path(path: Path, repo_root: Path) -> str:
    """Format a watched path so logs are easy to read in a multi-repo workspace."""

    resolved_path = path.resolve(strict=False)
    workspace_parent = repo_root.parent.resolve()
    try:
        return resolved_path.relative_to(workspace_parent).as_posix()
    except ValueError:
        return str(resolved_path)


def watch_and_build(repo_root: Path | None = None, debounce_ms: int = WATCH_DEBOUNCE_MS) -> None:
    """Continuously rebuild staged output whenever relevant inputs change."""

    from watchfiles import watch

    resolved_repo_root = repo_root_from(repo_root)
    results = build(resolved_repo_root)
    print(f"Built {len(results)} project(s) into site/.stage and site/.preview")

    while True:
        watch_roots = collect_watch_roots(resolved_repo_root)
        print("Watching staged-source inputs:")
        for root in watch_roots:
            print(f"  - {format_watch_path(root, resolved_repo_root)}")

        def watch_filter(_change: object, changed_path: str) -> bool:
            return is_relevant_watch_path(Path(changed_path))

        restart_watch = False
        for changes in watch(
            *(str(path) for path in watch_roots),
            watch_filter=watch_filter,
            debounce=debounce_ms,
            step=WATCH_STEP_MS,
            ignore_permission_denied=True,
            yield_on_timeout=False,
        ):
            changed_paths = sorted(
                {
                    Path(path).resolve(strict=False)
                    for _change, path in changes
                    if is_relevant_watch_path(Path(path))
                },
                key=str,
            )
            if not changed_paths:
                continue

            print("Detected source changes:")
            for changed_path in changed_paths:
                print(f"  - {format_watch_path(changed_path, resolved_repo_root)}")

            try:
                results = build(resolved_repo_root)
                print(f"Built {len(results)} project(s) into site/.stage and site/.preview")
            except Exception as exc:
                print(f"Rebuild failed: {exc}", file=sys.stderr)

            try:
                updated_watch_roots = collect_watch_roots(resolved_repo_root)
            except Exception as exc:
                print(f"Re-evaluating watch roots failed: {exc}", file=sys.stderr)
                updated_watch_roots = watch_roots

            if updated_watch_roots != watch_roots:
                print("Watch roots changed; restarting watcher.")
                restart_watch = True
                break

        if not restart_watch:
            continue