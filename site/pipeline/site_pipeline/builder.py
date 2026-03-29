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

"""Core build and cleanup operations for the Buildish site pipeline."""

from __future__ import annotations

import datetime as dt
import functools
import http.server
import shutil
import socketserver
from pathlib import Path
from typing import Any

from .constants import DEFAULT_TAG_PATTERN
from .filesystem import (
    copy_tree_without_symlinks,
    first_defined_mapping_value,
    first_non_none,
    load_project_metadata,
    load_yaml_like,
    mapping_or_empty,
    parse_int_like,
    read_text_if_exists,
    repo_root_from,
    reset_output_directory,
    safe_relative_path,
    safe_repo_path,
    stage_vendor_assets,
    write_yaml_like,
)
from .markdown import humanized_stem, normalize_markdown_doc, split_paragraphs, update_markdown_front_matter, with_yaml_front_matter
from .models import ProjectBuildResult
from .rendering import (
    build_preview_index,
    build_project_markdown,
    build_project_preview,
    build_unreleased_index_markdown,
    compile_tag_pattern,
    normalize_lifecycle,
    public_assets_root_path,
    public_content_page_path,
    public_project_path,
    public_unreleased_path,
)


def _without_none(payload: dict[str, Any]) -> dict[str, Any]:
    """Return a shallow copy that excludes keys whose value is ``None``."""

    return {key: value for key, value in payload.items() if value is not None}


def _serialized_release_lines(release_lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove null and empty alias values from release-line payloads."""

    return [
        {
            key: value
            for key, value in release_line.items()
            if value is not None and (key != "aliases" or value)
        }
        for release_line in release_lines
    ]


def _content_setting(
    project: dict[str, Any],
    metadata_fields: dict[str, Any],
    project_fields: dict[str, Any],
    content_fields: dict[str, Any],
    defaults: dict[str, Any],
    key: str,
) -> Any:
    """Resolve a content-related setting using the pipeline precedence rules."""

    if key in project:
        return project[key]
    return first_defined_mapping_value(key, content_fields, project_fields, metadata_fields, defaults)


def _stage_project_docs(
    repo_path: Path,
    docs_relative: str,
    docs_root: Path,
    slug: str,
    warnings: list[str],
) -> list[Path]:
    """Copy a project's docs tree into the staged Hugo content tree."""

    docs_path = safe_relative_path(repo_path, docs_relative, f"docsRoot for {slug}") if docs_relative else None
    if docs_path and docs_path.is_dir():
        return copy_tree_without_symlinks(docs_path, docs_root)
    warnings.append("No docs directory found; skipping unreleased docs staging.")
    return []


def _stage_project_assets(
    repo_path: Path,
    assets_relative: str,
    staged_assets_root: Path,
    slug: str,
) -> list[Path]:
    """Copy a project's static assets into the staged site tree."""

    assets_path = safe_relative_path(repo_path, assets_relative, f"assetsRoot for {slug}") if assets_relative else None
    if assets_path and assets_path.is_dir():
        return copy_tree_without_symlinks(assets_path, staged_assets_root)
    return []


def _normalize_staged_docs(
    docs_root: Path,
    slug: str,
    copied_docs: list[Path],
) -> tuple[list[dict[str, str]], str]:
    """Normalize staged Markdown docs and build their preview links."""

    doc_links: list[dict[str, str]] = []
    summary = ""
    for copied in copied_docs:
        staged_doc_path = docs_root / copied
        doc_title = humanized_stem(copied)
        if copied.suffix.lower() in {".md", ".markdown"} and staged_doc_path.is_file():
            doc_text = staged_doc_path.read_text(encoding="utf-8")
            normalize_fields: dict[str, Any] = {"type": "docs"}
            if copied == Path("_index.md"):
                normalize_fields["linkTitle"] = "Docs"
            normalized_doc, doc_title, doc_summary = normalize_markdown_doc(
                doc_text,
                humanized_stem(copied),
                **normalize_fields,
            )
            staged_doc_path.write_text(normalized_doc, encoding="utf-8")
            if copied == Path("_index.md"):
                summary = doc_summary
        if copied.suffix.lower() not in {".md", ".markdown", ".adoc", ".asciidoc"}:
            continue
        raw_path = public_content_page_path(["projects", slug, "unreleased", "docs"], copied)
        doc_links.append({"label": doc_title, "href": raw_path})
    return doc_links, summary


def _write_project_indexes(result: ProjectBuildResult, project_root: Path, unreleased_root: Path) -> None:
    """Write the staged Markdown landing pages for one project."""

    project_index_path = project_root / "_index.md"
    unreleased_index_path = unreleased_root / "_index.md"
    project_index_path.parent.mkdir(parents=True, exist_ok=True)
    unreleased_index_path.parent.mkdir(parents=True, exist_ok=True)
    project_index_path.write_text(
        with_yaml_front_matter(
            build_project_markdown(result),
            title=result.display_name,
            weight=result.navigation_weight,
            type="docs",
            **({"description": result.summary} if result.summary else {}),
        ),
        encoding="utf-8",
    )
    unreleased_index_path.write_text(
        with_yaml_front_matter(
            build_unreleased_index_markdown(result),
            title=f"{result.display_name} {result.unreleased_label}",
            linkTitle=result.unreleased_label,
            weight=10,
            type="docs",
            **({"description": result.summary} if result.summary else {}),
        ),
        encoding="utf-8",
    )


def _buildish_project_payload(result: ProjectBuildResult) -> dict[str, Any]:
    """Build the project-context payload injected into staged Markdown pages."""

    payload = {
        "slug": result.slug,
        "displayName": result.display_name,
        "summary": result.summary or None,
        "available": result.available,
        "localDir": result.local_dir,
        "repository": result.repository,
        "defaultBranch": result.default_branch,
        "navigationSection": result.navigation_section,
        "paths": _without_none(
            {
                "project": result.raw_project_index_path,
                "unreleased": result.raw_unreleased_index_path,
                "docs": result.raw_docs_root_path,
                "assets": result.raw_assets_root_path,
            }
        ),
        "unreleasedLabel": result.unreleased_label,
        "unreleased": _without_none(
            {
                "label": result.unreleased_label,
                "path": result.raw_unreleased_index_path,
                "docsPath": result.raw_docs_root_path,
                "assetsPath": result.raw_assets_root_path,
            }
        ),
        "latestStable": None,
        "releaseLines": _serialized_release_lines(result.release_lines),
    }
    if result.latest_stable_version is not None:
        payload["latestStable"] = _without_none(
            {
                "version": result.latest_stable_version,
                "path": result.latest_stable_path,
            }
        )
    return _without_none(payload)


def _buildish_project_page_payload(
    result: ProjectBuildResult,
    *,
    kind: str,
    section: str,
    page_path: str | None,
) -> dict[str, Any]:
    """Build per-page context for staged project pages."""

    payload: dict[str, Any] = {
        "kind": kind,
        "section": section,
        "path": page_path,
        "projectPath": result.raw_project_index_path,
    }
    if section in {"unreleased", "docs"}:
        payload["version"] = _without_none(
            {
                "kind": "unreleased",
                "label": result.unreleased_label,
                "path": result.raw_unreleased_index_path,
                "docsPath": result.raw_docs_root_path,
            }
        )
    return _without_none(payload)


def _annotate_staged_project_pages(
    result: ProjectBuildResult,
    project_root: Path,
    unreleased_root: Path,
    docs_root: Path,
    copied_docs: list[Path],
) -> None:
    """Inject pipeline-owned project context into all staged Markdown pages."""

    project_payload = _buildish_project_payload(result)
    project_index_path = project_root / "_index.md"
    project_index_path.write_text(
        update_markdown_front_matter(
            project_index_path.read_text(encoding="utf-8"),
            buildishProject=project_payload,
            buildishProjectPage=_buildish_project_page_payload(
                result,
                kind="project-home",
                section="project",
                page_path=result.raw_project_index_path,
            ),
        ),
        encoding="utf-8",
    )

    unreleased_index_path = unreleased_root / "_index.md"
    unreleased_index_path.write_text(
        update_markdown_front_matter(
            unreleased_index_path.read_text(encoding="utf-8"),
            buildishProject=project_payload,
            buildishProjectPage=_buildish_project_page_payload(
                result,
                kind="unreleased-home",
                section="unreleased",
                page_path=result.raw_unreleased_index_path,
            ),
        ),
        encoding="utf-8",
    )

    for copied in copied_docs:
        staged_doc_path = docs_root / copied
        if copied.suffix.lower() not in {".md", ".markdown"} or not staged_doc_path.is_file():
            continue
        page_path = public_content_page_path(["projects", result.slug, "unreleased", "docs"], copied)
        staged_doc_path.write_text(
            update_markdown_front_matter(
                staged_doc_path.read_text(encoding="utf-8"),
                buildishProject=project_payload,
                buildishProjectPage=_buildish_project_page_payload(
                    result,
                    kind="docs-home" if copied == Path("_index.md") else "docs-page",
                    section="docs",
                    page_path=page_path,
                ),
            ),
            encoding="utf-8",
        )


def _write_project_metadata_files(
    result: ProjectBuildResult,
    project_root: Path,
    unreleased_root: Path,
    metadata_relative: str,
    metadata_loaded: bool,
    docs_relative: str,
    assets_relative: str,
) -> None:
    """Write the YAML metadata files consumed by the staged site."""

    raw_unreleased_index_path = public_unreleased_path(result.slug)
    version_metadata_path = unreleased_root / "version.yaml"
    lifecycle_metadata_path = project_root / "lifecycle.yaml"

    write_yaml_like(
        version_metadata_path,
        {
            "schemaVersion": 1,
            "project": {"slug": result.slug, "displayName": result.display_name},
            "version": _without_none(
                {
                    "kind": "unreleased",
                    "label": result.unreleased_label,
                    "path": raw_unreleased_index_path,
                    "docsPath": result.raw_docs_root_path,
                }
            ),
            "source": {
                "repository": result.repository,
                "localDir": result.local_dir,
                "metadataFile": metadata_relative,
                "metadataLoaded": metadata_loaded,
                "defaultBranch": result.default_branch,
                "docsRoot": docs_relative or None,
                "assetsRoot": assets_relative or None,
            },
            "assets": {
                "count": result.asset_count,
                "path": result.raw_assets_root_path,
            },
        },
    )

    lifecycle_payload: dict[str, Any] = {
        "unreleased": {
            "label": result.unreleased_label,
            "path": raw_unreleased_index_path,
            "docsPath": result.raw_docs_root_path,
            "robots": "index,follow",
        },
        "latestStable": None,
        "releaseLines": [],
    }
    if result.latest_stable_version is not None:
        lifecycle_payload["latestStable"] = _without_none(
            {"version": result.latest_stable_version, "path": result.latest_stable_path}
        )
    if result.release_lines:
        lifecycle_payload["releaseLines"] = _serialized_release_lines(result.release_lines)

    write_yaml_like(
        lifecycle_metadata_path,
        {
            "schemaVersion": 1,
            "project": {"slug": result.slug, "displayName": result.display_name},
            "lifecycle": lifecycle_payload,
        },
    )


def stage_authored_site_content(site_root: Path, stage_root: Path, incubator_disclaimer_paragraphs: list[str]) -> None:
    """Copy the site's hand-authored content into the staged Hugo tree."""

    source_content_root = site_root / "content"
    if source_content_root.is_dir():
        copy_tree_without_symlinks(source_content_root, stage_root / "content")

    root_index = stage_root / "content" / "_index.md"
    if root_index.is_file():
        root_index.write_text(
            update_markdown_front_matter(
                root_index.read_text(encoding="utf-8"),
                incubator_disclaimer_paragraphs=incubator_disclaimer_paragraphs,
            ),
            encoding="utf-8",
        )


def stage_project(repo_root: Path, stage_root: Path, project: dict[str, Any], defaults: dict[str, Any], catalog_index: int) -> ProjectBuildResult:
    """Stage one project described in ``site/projects.yaml``."""

    slug = str(project["slug"])
    local_dir = str(project["localDir"])
    repo_path = safe_repo_path(repo_root, local_dir)
    warnings: list[str] = []
    available = repo_path.is_dir()
    navigation_weight = parse_int_like(project.get("weight"), f"weight for {slug}") if "weight" in project else catalog_index * 10

    metadata_relative = str(project.get("metadataFile") or defaults.get("metadataFile") or "site/project.yaml")
    metadata_fields: dict[str, Any] = {}
    metadata_path: Path | None = None
    if available:
        metadata_fields, metadata_path = load_project_metadata(repo_path, metadata_relative, slug)

    project_fields = mapping_or_empty(metadata_fields, "project", f"project metadata for {slug}")
    content_fields = mapping_or_empty(metadata_fields, "content", f"content metadata for {slug}")
    versioning_fields = mapping_or_empty(metadata_fields, "versioning", f"versioning metadata for {slug}")
    lifecycle_fields = mapping_or_empty(metadata_fields, "lifecycle", f"lifecycle metadata for {slug}")
    navigation_fields = mapping_or_empty(metadata_fields, "navigation", f"navigation metadata for {slug}")

    display_name = str(first_non_none(project.get("displayName"), project_fields.get("displayName"), metadata_fields.get("displayName"), slug))
    repository = first_non_none(project.get("repository"), project_fields.get("repository"), metadata_fields.get("repository"))
    default_branch = first_non_none(project.get("defaultBranch"), project_fields.get("defaultBranch"), metadata_fields.get("defaultBranch"))
    navigation_section = first_non_none(
        project.get("navigationSection"),
        navigation_fields.get("section"),
        metadata_fields.get("navigationSection"),
        defaults.get("navigationSection"),
    )

    docs_setting = _content_setting(project, metadata_fields, project_fields, content_fields, defaults, "docsRoot")
    docs_relative = "" if docs_setting is None else str(docs_setting)

    assets_setting = _content_setting(project, metadata_fields, project_fields, content_fields, defaults, "assetsRoot")
    assets_relative = "" if assets_setting is None else str(assets_setting)

    unreleased_label = str(
        first_non_none(
            project.get("unreleasedLabel"),
            versioning_fields.get("unreleasedLabel"),
            metadata_fields.get("unreleasedLabel"),
            defaults.get("unreleasedLabel"),
            "Unreleased",
        )
    )
    tag_pattern_text = str(
        first_non_none(
            project.get("tagPattern"),
            versioning_fields.get("tagPattern"),
            metadata_fields.get("tagPattern"),
            defaults.get("tagPattern"),
            DEFAULT_TAG_PATTERN,
        )
    )

    project_root = stage_root / "content" / "projects" / slug
    unreleased_root = project_root / "unreleased"
    docs_root = unreleased_root / "docs"
    staged_assets_root = stage_root / "static" / "projects" / slug / "unreleased" / "assets"

    if available:
        copied_docs = _stage_project_docs(repo_path, docs_relative, docs_root, slug, warnings)
        copied_assets = _stage_project_assets(repo_path, assets_relative, staged_assets_root, slug)
    else:
        copied_docs = []
        copied_assets = []
        warnings.append("Local repository directory is missing; project was skipped for raw docs staging.")

    doc_links, summary = _normalize_staged_docs(docs_root, slug, copied_docs)
    if copied_docs and not (docs_root / "_index.md").is_file():
        warnings.append("Docs root is missing _index.md; add a site-oriented docs landing page.")

    raw_unreleased_index_path = public_unreleased_path(slug)
    raw_project_index_path = public_project_path(slug)
    raw_docs_root_path = public_content_page_path(["projects", slug, "unreleased", "docs"], Path("_index.md")) if (docs_root / "_index.md").is_file() else None
    raw_assets_root_path = public_assets_root_path(slug) if copied_assets else None
    tag_pattern = compile_tag_pattern(tag_pattern_text, slug, warnings)
    latest_stable_version, latest_stable_path, release_lines, alias_mappings = normalize_lifecycle(
        lifecycle_fields,
        tag_pattern,
        slug,
        project_root,
        warnings,
    )

    result = ProjectBuildResult(
        slug=slug,
        display_name=display_name,
        navigation_weight=navigation_weight,
        available=available,
        repository=str(repository) if repository else None,
        local_dir=local_dir,
        repo_path=repo_path,
        summary=summary,
        raw_unreleased_index_path=raw_unreleased_index_path,
        raw_project_index_path=raw_project_index_path,
        raw_docs_root_path=raw_docs_root_path,
        raw_assets_root_path=raw_assets_root_path,
        unreleased_label=unreleased_label,
        default_branch=str(default_branch) if default_branch else None,
        navigation_section=str(navigation_section) if navigation_section else None,
        asset_count=len(copied_assets),
        latest_stable_version=latest_stable_version,
        latest_stable_path=latest_stable_path,
        release_lines=release_lines,
        alias_mappings=alias_mappings,
        doc_links=doc_links,
        warnings=warnings,
    )

    _write_project_indexes(result, project_root, unreleased_root)
    _write_project_metadata_files(
        result,
        project_root,
        unreleased_root,
        metadata_relative=metadata_relative,
        metadata_loaded=metadata_path is not None,
        docs_relative=docs_relative,
        assets_relative=assets_relative,
    )
    _annotate_staged_project_pages(result, project_root, unreleased_root, docs_root, copied_docs)
    return result


def build(repo_root: Path | None = None) -> list[ProjectBuildResult]:
    """Build the complete staged site contract and preview pages."""

    resolved_repo_root = repo_root_from(repo_root)
    site_root = resolved_repo_root / "site"
    catalog = load_yaml_like(site_root / "projects.yaml")
    defaults = dict(catalog.get("defaults") or {})
    projects = list(catalog.get("projects") or [])

    stage_root = site_root / ".stage"
    preview_root = site_root / ".preview"
    reset_output_directory(stage_root)
    reset_output_directory(preview_root)

    results = [stage_project(resolved_repo_root, stage_root, project, defaults, index) for index, project in enumerate(projects, start=1)]
    incubator_disclaimer = read_text_if_exists(resolved_repo_root / "DISCLAIMER").strip()
    incubator_disclaimer_paragraphs = split_paragraphs(incubator_disclaimer)
    stage_authored_site_content(site_root, stage_root, incubator_disclaimer_paragraphs)
    stage_vendor_assets(site_root, stage_root)

    write_yaml_like(
        stage_root / "manifest.yaml",
        {
            "schemaVersion": 1,
            "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "repoRoot": str(resolved_repo_root),
            "projects": [
                {
                    "slug": result.slug,
                    "displayName": result.display_name,
                    "weight": result.navigation_weight,
                    "available": result.available,
                    "localDir": result.local_dir,
                    "repository": result.repository,
                    "defaultBranch": result.default_branch,
                    "projectPath": result.raw_project_index_path,
                    "unreleasedPath": result.raw_unreleased_index_path,
                    "docsPath": result.raw_docs_root_path,
                }
                for result in results
            ],
        },
    )
    write_yaml_like(
        stage_root / "data" / "projects.yaml",
        {
            "schemaVersion": 1,
            "projects": {
                result.slug: {
                    "displayName": result.display_name,
                    "weight": result.navigation_weight,
                    "available": result.available,
                    "localDir": result.local_dir,
                    "repository": result.repository,
                    "summary": result.summary,
                    "defaultBranch": result.default_branch,
                    "navigationSection": result.navigation_section,
                    "unreleasedLabel": result.unreleased_label,
                    "projectPath": result.raw_project_index_path,
                    "unreleasedPath": result.raw_unreleased_index_path,
                    "docsPath": result.raw_docs_root_path,
                    "assetCount": result.asset_count,
                    "assetsPath": result.raw_assets_root_path,
                    "latestStable": result.latest_stable_version,
                    "latestStablePath": result.latest_stable_path,
                    "releaseLines": _serialized_release_lines(result.release_lines),
                }
                for result in results
            },
        },
    )
    write_yaml_like(
        stage_root / "data" / "lifecycle.yaml",
        {
            "schemaVersion": 1,
            "projects": {
                result.slug: {
                    "latestStable": result.latest_stable_version,
                    "releaseLines": _serialized_release_lines(result.release_lines),
                    "unreleased": _without_none(
                        {
                            "label": result.unreleased_label,
                            "path": result.raw_unreleased_index_path,
                            "docsPath": result.raw_docs_root_path,
                        }
                    ),
                }
                for result in results
            },
        },
    )
    write_yaml_like(
        stage_root / "data" / "aliases.yaml",
        {
            "schemaVersion": 1,
            "projects": {
                result.slug: {"aliases": result.alias_mappings}
                for result in results
            },
        },
    )

    (preview_root / "index.html").write_text(build_preview_index(results), encoding="utf-8")
    for result in results:
        project_preview = preview_root / "projects" / result.slug / "index.html"
        project_preview.parent.mkdir(parents=True, exist_ok=True)
        project_preview.write_text(build_project_preview(result), encoding="utf-8")
    return results


def clean(repo_root: Path | None = None) -> None:
    """Remove generated staging and preview directories."""

    resolved_repo_root = repo_root_from(repo_root)
    shutil.rmtree(resolved_repo_root / "site" / ".stage", ignore_errors=True)
    shutil.rmtree(resolved_repo_root / "site" / ".preview", ignore_errors=True)
    shutil.rmtree(resolved_repo_root / ".site-stage", ignore_errors=True)
    shutil.rmtree(resolved_repo_root / ".site-preview", ignore_errors=True)


def serve(repo_root: Path | None = None, port: int = 8000) -> None:
    """Serve the lightweight preview tree with Python's standard HTTP server."""

    resolved_repo_root = repo_root_from(repo_root)
    build(resolved_repo_root)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(resolved_repo_root))
    with socketserver.TCPServer(("127.0.0.1", port), handler) as httpd:
        print(f"Serving local preview at http://127.0.0.1:{port}/site/.preview/")
        httpd.serve_forever()