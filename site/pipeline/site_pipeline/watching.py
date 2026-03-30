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

The local watch loop deliberately follows a narrower contract than a full
`build()` run:

- it watches only staged-source inputs, not generated outputs,
- it watches a curated subset of `site/pipeline/` instead of the whole tree, and
- it rebuilds `site/.stage/` only, leaving `site/.preview/` untouched to reduce
  file-system churn while Hugo is serving.

Those constraints keep local `make serve-local` sessions responsive and reduce
the amount of external file activity observed by IDE file watchers.
"""

from __future__ import annotations

import sys
from pathlib import Path

from .builder import build
from .common import first_non_none
from .constants import STAGED_VENDOR_ASSETS, WATCH_DEBOUNCE_MS, WATCH_IGNORE_PATH_PARTS, WATCH_IGNORE_SUFFIXES, WATCH_STEP_MS
from .filesystem import (
    load_project_metadata,
    repo_root_from,
    resolve_vendor_asset_source,
    safe_relative_path,
    safe_repo_path,
    watchable_existing_path,
)
from .models import CatalogProject, ProjectCatalogDefaults, ProjectMetadata, ProjectsCatalog


def _configured_content_root(
    project: CatalogProject,
    metadata: ProjectMetadata,
    defaults: ProjectCatalogDefaults,
    field_name: str,
) -> str | None:
    """Resolve typed docs/assets settings for watch-root collection."""

    return first_non_none(
        getattr(project, field_name),
        getattr(metadata.content, field_name),
        getattr(defaults, field_name),
    )


def _project_watch_roots(repo_root: Path, project: CatalogProject, defaults: ProjectCatalogDefaults) -> set[Path]:
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

    docs_setting = _configured_content_root(project, metadata, defaults, "docs_root")
    if docs_setting is not None:
        docs_path = safe_relative_path(repo_path, str(docs_setting), f"docsRoot for {slug}")
        if docs_path is not None:
            watch_roots.add(watchable_existing_path(docs_path, repo_path))

    assets_setting = _configured_content_root(project, metadata, defaults, "assets_root")
    if assets_setting is not None:
        assets_path = safe_relative_path(repo_path, str(assets_setting), f"assetsRoot for {slug}")
        if assets_path is not None:
            watch_roots.add(watchable_existing_path(assets_path, repo_path))

    return watch_roots


def _pipeline_watch_roots(site_root: Path) -> set[Path]:
    """Return the narrow set of pipeline paths that can affect watch-mode rebuilds.

    Watching all of ``site/pipeline/`` recursively would also subscribe to tool
    directories such as ``.venv`` and ``.idea``. The watch loop only needs the
    entrypoint, dependency metadata, and the package source tree itself.
    """

    pipeline_root = site_root / "pipeline"
    watch_roots: set[Path] = set()
    for relative_path in (Path("main.py"), Path("pyproject.toml"), Path("uv.lock"), Path("site_pipeline")):
        candidate = pipeline_root / relative_path
        if candidate.exists():
            watch_roots.add(candidate.resolve())
    return watch_roots


def collect_watch_roots(repo_root: Path | None = None) -> list[Path]:
    """Collect every path that should trigger a staged rebuild in watch mode."""

    resolved_repo_root = repo_root_from(repo_root)
    site_root = resolved_repo_root / "site"
    catalog = ProjectsCatalog.from_yaml_path(site_root / "projects.yaml")

    watch_roots: set[Path] = {
        watchable_existing_path(site_root / "projects.yaml", site_root),
        watchable_existing_path(site_root / "content", site_root),
    }
    watch_roots.update(_pipeline_watch_roots(site_root))

    for source_relative, _ in STAGED_VENDOR_ASSETS:
        source = resolve_vendor_asset_source(site_root, source_relative)
        if source.exists():
            watch_roots.add(source.resolve())

    for project in catalog.projects:
        watch_roots.update(_project_watch_roots(resolved_repo_root, project, catalog.defaults))

    return sorted(watch_roots, key=str)


def is_relevant_watch_path(path: Path) -> bool:
    """Filter out temporary editor files and generated output paths."""

    name = path.name
    if name.startswith(".#") or name == "4913":
        return False
    if name.endswith(WATCH_IGNORE_SUFFIXES):
        return False
    return not any(part in WATCH_IGNORE_PATH_PARTS for part in path.parts)


def _format_watch_path(path: Path, repo_root: Path) -> str:
    """Format a watched path so logs are easy to read in a multi-repo workspace."""

    resolved_path = path.resolve(strict=False)
    workspace_parent = repo_root.parent.resolve()
    try:
        return resolved_path.relative_to(workspace_parent).as_posix()
    except ValueError:
        return str(resolved_path)


def watch_and_build(repo_root: Path | None = None, debounce_ms: int = WATCH_DEBOUNCE_MS) -> None:
    """Continuously rebuild ``site/.stage`` whenever relevant inputs change.

    Watch mode intentionally skips preview generation because local Hugo serve
    sessions consume ``site/.stage`` directly. Rewriting ``site/.preview`` on
    every change only adds extra external file churn without affecting the live
    rendered site.
    """

    from watchfiles import watch

    resolved_repo_root = repo_root_from(repo_root)
    results = build(resolved_repo_root, include_preview=False)
    print(f"Built {len(results)} project(s) into site/.stage")

    while True:
        watch_roots = collect_watch_roots(resolved_repo_root)
        print("Watching staged-source inputs:")
        for root in watch_roots:
            print(f"  - {_format_watch_path(root, resolved_repo_root)}")

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
                print(f"  - {_format_watch_path(changed_path, resolved_repo_root)}")

            try:
                results = build(resolved_repo_root, include_preview=False)
                print(f"Built {len(results)} project(s) into site/.stage")
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