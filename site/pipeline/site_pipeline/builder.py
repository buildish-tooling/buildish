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
import re
import shutil
import socketserver
from pathlib import Path

from .common import first_non_none
from .constants import DEFAULT_TAG_PATTERN
from .filesystem import (
    copy_tree_without_symlinks,
    load_component_metadata,
    load_components_local_overrides,
    read_text_if_exists,
    repo_root_from,
    reset_output_directory,
    resolve_component_repo_path,
    safe_relative_path,
    stage_vendor_assets,
    write_yaml_like,
)
from .markdown import humanized_stem, normalize_markdown_doc, split_paragraphs, update_markdown_front_matter, with_yaml_front_matter
from .models import (
    AliasesDataDocument,
    BuildishComponentPagePayload,
    BuildishComponentPaths,
    BuildishComponentPayload,
    CatalogComponent,
    BuildishComponentUnreleased,
    DocsFrontMatter,
    LifecycleDataDocument,
    LifecycleDataEntry,
    LifecycleLatestStable,
    LifecycleUnreleased,
    ManifestDocument,
    ManifestComponentEntry,
    ComponentAliasesEntry,
    ComponentBuildResult,
    ComponentCatalogDefaults,
    ComponentLifecycleDocument,
    ComponentLifecycleDocumentData,
    ComponentMetadata,
    ComponentVersionDocument,
    ComponentsCatalog,
    ComponentsDataDocument,
    ComponentsDataEntry,
    StagedDocLink,
    StagedComponentRef,
    VersionAssets,
    VersionDescriptor,
    VersionSource,
)
from .rendering import (
    build_preview_index,
    build_component_preview,
    build_unreleased_index_markdown,
    normalize_lifecycle,
    public_assets_root_path,
    public_content_page_path,
    public_component_path,
    public_unreleased_path,
)


_RESERVED_COMPONENT_TOP_LEVEL_PATHS = {"unreleased", "releases", "lifecycle.yaml"}


def _content_setting(
    component: CatalogComponent,
    metadata: ComponentMetadata,
    defaults: ComponentCatalogDefaults,
    field_name: str,
) -> str | None:
    """Resolve a content-related setting using the pipeline precedence rules."""

    return first_non_none(
        getattr(component, field_name),
        getattr(metadata.content, field_name),
        getattr(defaults, field_name),
    )


def _stage_component_docs(
    repo_path: Path,
    docs_relative: str,
    docs_root: Path,
    slug: str,
    warnings: list[str],
) -> list[Path]:
    """Copy a component's docs tree into the staged Hugo content tree."""

    docs_path = safe_relative_path(repo_path, docs_relative, f"docsRoot for {slug}") if docs_relative else None
    if docs_path and docs_path.is_dir():
        return copy_tree_without_symlinks(docs_path, docs_root)
    warnings.append("No docs directory found; skipping unreleased docs staging.")
    return []


def _stage_component_pages(repo_path: Path, pages_relative: str, component_root: Path, slug: str) -> list[Path]:
    """Copy a component's authored non-versioned pages into the staged Hugo tree."""

    if not pages_relative:
        raise ValueError(f"Missing required pagesRoot for {slug}")
    pages_path = safe_relative_path(repo_path, pages_relative, f"pagesRoot for {slug}")
    if pages_path is None or not pages_path.is_dir():
        raise ValueError(f"pagesRoot for {slug} does not exist: {pages_relative}")
    copied_pages = copy_tree_without_symlinks(pages_path, component_root)
    for copied in copied_pages:
        top_level = copied.parts[0] if copied.parts else ""
        if top_level in _RESERVED_COMPONENT_TOP_LEVEL_PATHS:
            raise ValueError(f"pagesRoot for {slug} uses reserved staged path: {top_level}")
    if Path("_index.md") not in copied_pages:
        raise ValueError(f"pagesRoot for {slug} must contain _index.md")
    return copied_pages


def _stage_component_assets(
    repo_path: Path,
    assets_relative: str,
    staged_assets_root: Path,
    slug: str,
) -> list[Path]:
    """Copy a component's static assets into the staged site tree."""

    assets_path = safe_relative_path(repo_path, assets_relative, f"assetsRoot for {slug}") if assets_relative else None
    if assets_path and assets_path.is_dir():
        return copy_tree_without_symlinks(assets_path, staged_assets_root)
    return []


def _normalize_staged_docs(
    docs_root: Path,
    slug: str,
    copied_docs: list[Path],
) -> tuple[list[StagedDocLink], str]:
    """Normalize staged Markdown docs and build their preview links."""

    doc_links: list[StagedDocLink] = []
    summary = ""
    for copied in copied_docs:
        staged_doc_path = docs_root / copied
        doc_title = humanized_stem(copied)
        if copied.suffix.lower() in {".md", ".markdown"} and staged_doc_path.is_file():
            doc_text = staged_doc_path.read_text(encoding="utf-8")
            normalized_doc, doc_title, doc_summary = normalize_markdown_doc(
                doc_text,
                humanized_stem(copied),
                **DocsFrontMatter(link_title="Docs" if copied == Path("_index.md") else None).to_yaml_data(),
            )
            staged_doc_path.write_text(normalized_doc, encoding="utf-8")
            if copied == Path("_index.md"):
                summary = doc_summary
        if copied.suffix.lower() not in {".md", ".markdown", ".adoc", ".asciidoc"}:
            continue
        raw_path = public_content_page_path(["components", slug, "unreleased", "docs"], copied)
        doc_links.append(StagedDocLink(label=doc_title, href=raw_path))
    return doc_links, summary


def _normalize_staged_component_pages(
    component_root: Path,
    copied_pages: list[Path],
    navigation_weight: int,
) -> str:
    """Normalize authored component pages and return the component landing summary."""

    summary = ""
    for copied in copied_pages:
        staged_page_path = component_root / copied
        if copied.suffix.lower() not in {".md", ".markdown"} or not staged_page_path.is_file():
            continue
        normalized_page, _, page_summary = normalize_markdown_doc(
            staged_page_path.read_text(encoding="utf-8"),
            humanized_stem(copied),
            **DocsFrontMatter(weight=navigation_weight if copied == Path("_index.md") else None).to_yaml_data(),
        )
        staged_page_path.write_text(normalized_page, encoding="utf-8")
        if copied == Path("_index.md"):
            summary = page_summary
    return summary


def _write_unreleased_index(result: ComponentBuildResult, unreleased_root: Path) -> None:
    """Write the staged unreleased landing page for one component."""

    unreleased_index_path = unreleased_root / "_index.md"
    unreleased_index_path.parent.mkdir(parents=True, exist_ok=True)
    unreleased_index_path.write_text(
        with_yaml_front_matter(
            build_unreleased_index_markdown(result),
            **DocsFrontMatter(
                title=f"{result.display_name} {result.unreleased_label}",
                link_title=result.unreleased_label,
                weight=10,
                description=result.summary or None,
            ).to_yaml_data(),
        ),
        encoding="utf-8",
    )


def _buildish_component_payload(result: ComponentBuildResult) -> BuildishComponentPayload:
    """Build the component-context payload injected into staged Markdown pages."""

    return BuildishComponentPayload(
        slug=result.slug,
        display_name=result.display_name,
        summary=result.summary or None,
        available=result.available,
        local_dir=result.local_dir,
        repository=result.repository,
        default_branch=result.default_branch,
        navigation_section=result.navigation_section,
        paths=BuildishComponentPaths(
            component=result.raw_component_index_path,
            unreleased=result.raw_unreleased_index_path,
            docs=result.raw_docs_root_path,
            assets=result.raw_assets_root_path,
        ),
        unreleased_label=result.unreleased_label,
        unreleased=BuildishComponentUnreleased(
            label=result.unreleased_label,
            path=result.raw_unreleased_index_path or public_unreleased_path(result.slug),
            docs_path=result.raw_docs_root_path,
            assets_path=result.raw_assets_root_path,
        ),
        latest_stable=(
            None
            if result.latest_stable_version is None
            else LifecycleLatestStable(version=result.latest_stable_version, path=result.latest_stable_path)
        ),
        release_lines=result.release_lines,
    )


def _buildish_component_page_payload(
    result: ComponentBuildResult,
    *,
    kind: str,
    section: str,
    page_path: str | None,
) -> BuildishComponentPagePayload:
    """Build per-page context for staged component pages."""

    return BuildishComponentPagePayload(
        kind=kind,
        section=section,
        path=page_path,
        component_path=result.raw_component_index_path,
        version=(
            None
            if section not in {"unreleased", "docs"}
            else VersionDescriptor(
                kind="unreleased",
                label=result.unreleased_label,
                path=result.raw_unreleased_index_path or public_unreleased_path(result.slug),
                docs_path=result.raw_docs_root_path,
            )
        ),
    )


def _annotate_staged_component_pages(
    result: ComponentBuildResult,
    component_root: Path,
    unreleased_root: Path,
    copied_component_pages: list[Path],
    docs_root: Path,
    copied_docs: list[Path],
) -> None:
    """Inject pipeline-owned component context into all staged Markdown pages."""

    component_payload = _buildish_component_payload(result)
    for copied in copied_component_pages:
        staged_page_path = component_root / copied
        if copied.suffix.lower() not in {".md", ".markdown"} or not staged_page_path.is_file():
            continue
        page_path = public_content_page_path(["components", result.slug], copied)
        staged_page_path.write_text(
            update_markdown_front_matter(
                staged_page_path.read_text(encoding="utf-8"),
                buildishComponent=component_payload,
                buildishComponentPage=_buildish_component_page_payload(
                    result,
                    kind="component-home" if copied == Path("_index.md") else "component-page",
                    section="component",
                    page_path=page_path,
                ),
            ),
            encoding="utf-8",
        )

    unreleased_index_path = unreleased_root / "_index.md"
    unreleased_index_path.write_text(
        update_markdown_front_matter(
            unreleased_index_path.read_text(encoding="utf-8"),
            buildishComponent=component_payload,
            buildishComponentPage=_buildish_component_page_payload(
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
        page_path = public_content_page_path(["components", result.slug, "unreleased", "docs"], copied)
        staged_doc_path.write_text(
            update_markdown_front_matter(
                staged_doc_path.read_text(encoding="utf-8"),
                buildishComponent=component_payload,
                buildishComponentPage=_buildish_component_page_payload(
                    result,
                    kind="docs-home" if copied == Path("_index.md") else "docs-page",
                    section="docs",
                    page_path=page_path,
                ),
            ),
            encoding="utf-8",
        )


def _write_component_metadata_files(
    result: ComponentBuildResult,
    component_root: Path,
    unreleased_root: Path,
    metadata_relative: str,
    metadata_loaded: bool,
    pages_relative: str,
    docs_relative: str,
    assets_relative: str,
) -> None:
    """Write the YAML metadata files consumed by the staged site."""

    raw_unreleased_index_path = public_unreleased_path(result.slug)
    version_metadata_path = unreleased_root / "version.yaml"
    lifecycle_metadata_path = component_root / "lifecycle.yaml"

    write_yaml_like(
        version_metadata_path,
        ComponentVersionDocument(
            schema_version=1,
            component=StagedComponentRef(slug=result.slug, display_name=result.display_name),
            version=VersionDescriptor(
                kind="unreleased",
                label=result.unreleased_label,
                path=raw_unreleased_index_path,
                docs_path=result.raw_docs_root_path,
            ),
            source=VersionSource(
                repository=result.repository,
                local_dir=result.local_dir,
                metadata_file=metadata_relative,
                metadata_loaded=metadata_loaded,
                default_branch=result.default_branch,
                pages_root=pages_relative or None,
                docs_root=docs_relative or None,
                assets_root=assets_relative or None,
            ),
            assets=VersionAssets(count=result.asset_count, path=result.raw_assets_root_path),
        ),
    )

    write_yaml_like(
        lifecycle_metadata_path,
        ComponentLifecycleDocument(
            schema_version=1,
            component=StagedComponentRef(slug=result.slug, display_name=result.display_name),
            lifecycle=ComponentLifecycleDocumentData(
                unreleased=LifecycleUnreleased(
                    label=result.unreleased_label,
                    path=raw_unreleased_index_path,
                    docs_path=result.raw_docs_root_path,
                    robots="index,follow",
                ),
                latest_stable=(
                    None
                    if result.latest_stable_version is None
                    else LifecycleLatestStable(
                        version=result.latest_stable_version,
                        path=result.latest_stable_path,
                    )
                ),
                release_lines=result.release_lines,
            ),
        ),
    )


def _stage_authored_site_content(site_root: Path, stage_root: Path, incubator_disclaimer_paragraphs: list[str]) -> None:
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


def stage_component(
    repo_root: Path,
    stage_root: Path,
    component: CatalogComponent,
    defaults: ComponentCatalogDefaults,
    catalog_index: int,
    local_overrides: ComponentsLocalOverrides | None = None,
) -> ComponentBuildResult:
    """Stage one component described in ``site/components.yaml``."""

    slug = component.slug
    local_dir = component.local_dir
    repo_path = resolve_component_repo_path(repo_root, component, local_overrides)
    warnings: list[str] = []
    available = repo_path.is_dir()
    navigation_weight = component.weight if component.weight is not None else catalog_index * 10

    metadata_relative = component.metadata_file or defaults.metadata_file or "site/component.yaml"
    metadata = ComponentMetadata()
    metadata_path: Path | None = None
    if available:
        metadata, metadata_path = load_component_metadata(repo_path, metadata_relative, slug)

    display_name = str(first_non_none(component.display_name, metadata.component.display_name, slug))
    repository = first_non_none(component.repository, metadata.component.repository)
    default_branch = first_non_none(component.default_branch, metadata.component.default_branch)
    navigation_section = first_non_none(
        component.navigation_section,
        metadata.navigation.section,
        defaults.navigation_section,
    )

    pages_setting = _content_setting(component, metadata, defaults, "pages_root")
    pages_relative = "" if pages_setting is None else str(pages_setting)

    docs_setting = _content_setting(component, metadata, defaults, "docs_root")
    docs_relative = "" if docs_setting is None else str(docs_setting)

    assets_setting = _content_setting(component, metadata, defaults, "assets_root")
    assets_relative = "" if assets_setting is None else str(assets_setting)

    unreleased_label = str(
        first_non_none(
            component.unreleased_label,
            metadata.versioning.unreleased_label,
            defaults.unreleased_label,
            "Unreleased",
        )
    )
    tag_pattern = first_non_none(
        component.tag_pattern,
        metadata.versioning.tag_pattern,
        defaults.tag_pattern,
    )
    if tag_pattern is None:
        tag_pattern = re.compile(DEFAULT_TAG_PATTERN)

    component_root = stage_root / "content" / "components" / slug
    unreleased_root = component_root / "unreleased"
    docs_root = unreleased_root / "docs"
    staged_assets_root = stage_root / "static" / "components" / slug / "unreleased" / "assets"

    if available:
        copied_component_pages = _stage_component_pages(repo_path, pages_relative, component_root, slug)
        copied_docs = _stage_component_docs(repo_path, docs_relative, docs_root, slug, warnings)
        copied_assets = _stage_component_assets(repo_path, assets_relative, staged_assets_root, slug)
    else:
        copied_component_pages = []
        copied_docs = []
        copied_assets = []
        warnings.append("Local repository directory is missing; component was skipped for staged page and docs content.")

    summary = _normalize_staged_component_pages(component_root, copied_component_pages, navigation_weight) if copied_component_pages else ""
    doc_links, docs_summary = _normalize_staged_docs(docs_root, slug, copied_docs)
    if copied_docs and not (docs_root / "_index.md").is_file():
        warnings.append("Docs root is missing _index.md; add a site-oriented docs landing page.")
    if not summary:
        summary = docs_summary

    raw_unreleased_index_path = public_unreleased_path(slug)
    raw_component_index_path = public_component_path(slug) if copied_component_pages else None
    raw_docs_root_path = public_content_page_path(["components", slug, "unreleased", "docs"], Path("_index.md")) if (docs_root / "_index.md").is_file() else None
    raw_assets_root_path = public_assets_root_path(slug) if copied_assets else None
    latest_stable_version, latest_stable_path, release_lines, alias_mappings = normalize_lifecycle(
        metadata.lifecycle,
        tag_pattern,
        slug,
        component_root,
    )

    result = ComponentBuildResult(
        slug=slug,
        display_name=display_name,
        navigation_weight=navigation_weight,
        available=available,
        repository=str(repository) if repository else None,
        local_dir=local_dir,
        repo_path=repo_path,
        summary=summary,
        raw_unreleased_index_path=raw_unreleased_index_path,
        raw_component_index_path=raw_component_index_path,
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
        doc_links=tuple(doc_links),
        warnings=warnings,
    )

    _write_unreleased_index(result, unreleased_root)
    _write_component_metadata_files(
        result,
        component_root,
        unreleased_root,
        metadata_relative=metadata_relative,
        metadata_loaded=metadata_path is not None,
        pages_relative=pages_relative,
        docs_relative=docs_relative,
        assets_relative=assets_relative,
    )
    _annotate_staged_component_pages(result, component_root, unreleased_root, copied_component_pages, docs_root, copied_docs)
    return result


def build(repo_root: Path | None = None, *, include_preview: bool = True) -> list[ComponentBuildResult]:
    """Build the staged site contract and, optionally, the lightweight preview pages.

    ``include_preview=False`` is used by watch mode so repeated restaging only
    rewrites ``site/.stage``. That keeps local Hugo serve sessions focused on the
    staged contract and reduces unnecessary file-system churn in ``site/.preview``.
    """

    resolved_repo_root = repo_root_from(repo_root)
    site_root = resolved_repo_root / "site"
    catalog = ComponentsCatalog.from_yaml_path(site_root / "components.yaml")
    local_overrides = load_components_local_overrides(site_root)

    stage_root = site_root / ".stage"
    preview_root = site_root / ".preview"
    reset_output_directory(stage_root)
    if include_preview:
        reset_output_directory(preview_root)

    results = [
        stage_component(resolved_repo_root, stage_root, component, catalog.defaults, index, local_overrides=local_overrides)
        for index, component in enumerate(catalog.components, start=1)
    ]
    incubator_disclaimer = read_text_if_exists(resolved_repo_root / "DISCLAIMER").strip()
    incubator_disclaimer_paragraphs = split_paragraphs(incubator_disclaimer)
    _stage_authored_site_content(site_root, stage_root, incubator_disclaimer_paragraphs)
    stage_vendor_assets(site_root, stage_root)

    write_yaml_like(
        stage_root / "manifest.yaml",
        ManifestDocument(
            schema_version=1,
            generated_at=dt.datetime.now(dt.timezone.utc).isoformat(),
            repo_root=str(resolved_repo_root),
            components=tuple(
                ManifestComponentEntry(
                    slug=result.slug,
                    display_name=result.display_name,
                    weight=result.navigation_weight,
                    available=result.available,
                    local_dir=result.local_dir,
                    repository=result.repository,
                    default_branch=result.default_branch,
                    component_path=result.raw_component_index_path,
                    unreleased_path=result.raw_unreleased_index_path,
                    docs_path=result.raw_docs_root_path,
                )
                for result in results
            ),
        ),
    )
    write_yaml_like(
        stage_root / "data" / "components.yaml",
        ComponentsDataDocument(
            schema_version=1,
            components={
                result.slug: ComponentsDataEntry(
                    display_name=result.display_name,
                    weight=result.navigation_weight,
                    available=result.available,
                    local_dir=result.local_dir,
                    repository=result.repository,
                    summary=result.summary,
                    default_branch=result.default_branch,
                    navigation_section=result.navigation_section,
                    unreleased_label=result.unreleased_label,
                    component_path=result.raw_component_index_path,
                    unreleased_path=result.raw_unreleased_index_path,
                    docs_path=result.raw_docs_root_path,
                    asset_count=result.asset_count,
                    assets_path=result.raw_assets_root_path,
                    latest_stable=result.latest_stable_version,
                    latest_stable_path=result.latest_stable_path,
                    release_lines=result.release_lines,
                )
                for result in results
            },
        ),
    )
    write_yaml_like(
        stage_root / "data" / "lifecycle.yaml",
        LifecycleDataDocument(
            schema_version=1,
            components={
                result.slug: LifecycleDataEntry(
                    latest_stable=result.latest_stable_version,
                    release_lines=result.release_lines,
                    unreleased=LifecycleUnreleased(
                        label=result.unreleased_label,
                        path=result.raw_unreleased_index_path,
                        docs_path=result.raw_docs_root_path,
                    ),
                )
                for result in results
            },
        ),
    )
    write_yaml_like(
        stage_root / "data" / "aliases.yaml",
        AliasesDataDocument(
            schema_version=1,
            components={result.slug: ComponentAliasesEntry(aliases=result.alias_mappings) for result in results},
        ),
    )

    if include_preview:
        (preview_root / "index.html").write_text(build_preview_index(results), encoding="utf-8")
        for result in results:
            component_preview = preview_root / "components" / result.slug / "index.html"
            component_preview.parent.mkdir(parents=True, exist_ok=True)
            component_preview.write_text(build_component_preview(result), encoding="utf-8")
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