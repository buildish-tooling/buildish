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

"""Rendering helpers for staged Markdown, lifecycle data, and preview pages."""

from __future__ import annotations

import html
import re
from pathlib import Path

from .constants import SITE_TITLE
from .models import ComponentBuildResult, ComponentLifecycleSettings, StagedAliasMapping, StagedReleaseLine


def _relative_web_path(path: Path) -> str:
    """Convert a filesystem-relative path into a site-relative URL path."""

    return "/" + path.as_posix().lstrip("/")


def public_component_path(slug: str) -> str:
    """Return the public URL of a staged component landing page."""

    return f"/components/{slug}/"


def public_unreleased_path(slug: str) -> str:
    """Return the public URL of a staged unreleased-docs landing page."""

    return f"/components/{slug}/unreleased/"


def public_assets_root_path(slug: str) -> str:
    """Return the public URL prefix for staged unreleased assets."""

    return f"/components/{slug}/unreleased/assets/"


def _public_release_path(slug: str, version: str) -> str:
    """Return the public URL of a staged release landing page."""

    return f"/components/{slug}/releases/{version}/"


def public_content_page_path(root_segments: list[str], relative_path: Path) -> str:
    """Map a staged content file path to the URL Hugo will publish."""

    file_path = Path(relative_path)
    segments = [segment for segment in file_path.parts[:-1] if segment not in {"."}]
    stem = file_path.stem
    if stem not in {"index", "_index"}:
        segments.append(stem)
    suffix = "/".join(root_segments + segments)
    return "/" + suffix.strip("/") + "/"


def _release_index_web_path(component_root: Path, slug: str, version: str) -> str | None:
    """Return the staged URL of a release landing page if that page exists."""

    release_index_path = component_root / "releases" / version / "_index.md"
    if not release_index_path.is_file():
        return None
    return _public_release_path(slug, version)


def normalize_lifecycle(
    lifecycle_fields: ComponentLifecycleSettings,
    tag_pattern: re.Pattern[str],
    slug: str,
    component_root: Path,
) -> tuple[str | None, str | None, tuple[StagedReleaseLine, ...], tuple[StagedAliasMapping, ...]]:
    """Validate lifecycle metadata and turn it into staged output structures."""

    latest_stable_version = lifecycle_fields.latest_stable
    if latest_stable_version and tag_pattern.fullmatch(latest_stable_version) is None:
        raise ValueError(f"Invalid latestStable for {slug}: expected an exact version tag matching {tag_pattern.pattern!r}")

    release_lines: list[StagedReleaseLine] = []
    alias_mappings: list[StagedAliasMapping] = []
    for release_line_model in lifecycle_fields.release_lines:
        line = release_line_model.line
        latest = release_line_model.latest
        status = release_line_model.status
        if tag_pattern.fullmatch(latest) is None:
            raise ValueError(
                f"Invalid release line {line!r} for {slug}: latest must match the exact version tag pattern {tag_pattern.pattern!r}"
            )

        aliases = tuple(release_line_model.aliases)
        path = _release_index_web_path(component_root, slug, latest)
        release_lines.append(StagedReleaseLine(line=line, latest=latest, status=status, aliases=aliases, path=path))
        for alias in aliases:
            alias_mappings.append(StagedAliasMapping(alias=alias, target=latest, line=line, status=status))

    latest_stable_path = None
    if latest_stable_version is not None:
        latest_stable_path = _release_index_web_path(component_root, slug, latest_stable_version)

    return latest_stable_version, latest_stable_path, tuple(release_lines), tuple(alias_mappings)


def build_unreleased_index_markdown(result: ComponentBuildResult) -> str:
    """Build the staged unreleased landing-page body for one component."""

    lines: list[str] = []
    if result.default_branch:
        lines.extend([f"Built from the local `{result.default_branch}` branch snapshot.", ""])
    if result.doc_links:
        lines.extend(["## Docs", ""])
        for doc_link in result.doc_links:
            lines.append(f"- [{doc_link.label}]({doc_link.href})")
        lines.append("")
    if result.asset_count and result.raw_assets_root_path:
        lines.extend([f"- [Open staged assets]({result.raw_assets_root_path})", ""])
    if not result.doc_links:
        lines.extend([f"No staged {result.unreleased_label.lower()} docs pages are currently available for this component.", ""])
    return "\n".join(lines).rstrip() + "\n"


def _html_page(title: str, body: str) -> str:
    """Wrap a preview-page body in a tiny standalone HTML document."""

    return """<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\">
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
  <title>{title}</title>
  <style>
    body {{ font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 58rem; padding: 0 1rem; line-height: 1.5; }}
    code {{ background: #f3f4f6; padding: 0.1rem 0.3rem; border-radius: 0.2rem; }}
    .muted {{ color: #555; }}
    .warn {{ color: #8a4b00; }}
  </style>
</head>
<body>
{body}
</body>
</html>
""".format(title=html.escape(title), body=body)


def build_preview_index(results: list[ComponentBuildResult]) -> str:
    """Build the lightweight preview index shown outside Hugo."""

    items = []
    for result in results:
        status = "available" if result.available else "missing from local workspace"
        items.append(
            f"<li><a href='/site/.preview/components/{result.slug}/'>{html.escape(result.display_name)}</a>"
            f" — <span class='muted'>{html.escape(status)}</span></li>"
        )
    body = (
        f"<h1>{SITE_TITLE}</h1>"
        "<p>This is a lightweight local preview for the staged site contract.</p>"
        "<p><a href='/site/.stage/content/_index.md'>Open staged root markdown</a></p>"
        f"<ul>{''.join(items)}</ul>"
    )
    return _html_page(SITE_TITLE, body)


def build_component_preview(result: ComponentBuildResult) -> str:
    """Build the lightweight preview page for one staged component."""

    doc_items = "".join(
        f"<li><a href='{html.escape(entry.href)}'>{html.escape(entry.label)}</a></li>"
        for entry in result.doc_links
    )
    warning_items = "".join(f"<li>{html.escape(item)}</li>" for item in result.warnings)
    body = ["<p><a href='/site/.preview/'>&larr; Back to preview index</a></p>"]
    body.append(f"<h1>{html.escape(result.display_name)}</h1>")
    if result.summary:
        body.append(f"<p>{html.escape(result.summary)}</p>")
    body.append(f"<p><strong>Workspace directory:</strong> <code>{html.escape(result.local_dir)}</code></p>")
    if result.repository:
        body.append(f"<p><strong>Repository:</strong> <a href='{html.escape(result.repository)}'>{html.escape(result.repository)}</a></p>")
    if result.default_branch:
        body.append(f"<p><strong>Default branch:</strong> <code>{html.escape(result.default_branch)}</code></p>")
    if result.latest_stable_version:
        latest_stable = f"<code>{html.escape(result.latest_stable_version)}</code>"
        if result.latest_stable_path:
            latest_stable = f"<a href='{html.escape(result.latest_stable_path)}'>{html.escape(result.latest_stable_version)}</a>"
        body.append(f"<p><strong>Latest stable:</strong> {latest_stable}</p>")
    if result.asset_count and result.raw_assets_root_path:
        body.append(
            f"<p><strong>Staged assets:</strong> <a href='{html.escape(result.raw_assets_root_path)}'>"
            f"{result.asset_count} file(s)</a></p>"
        )
    if result.raw_component_index_path:
        body.append(f"<p><a href='{html.escape(result.raw_component_index_path)}'>Open staged component landing page</a></p>")
    if result.raw_unreleased_index_path:
        body.append(f"<p><a href='{html.escape(result.raw_unreleased_index_path)}'>Open {html.escape(result.unreleased_label)} docs index</a></p>")
    if doc_items:
        body.append(f"<h2>Docs</h2><ul>{doc_items}</ul>")
    if result.release_lines:
        release_items = []
        for release_line in result.release_lines:
            latest = f"<code>{html.escape(release_line.latest)}</code>"
            if release_line.path:
                latest = f"<a href='{html.escape(release_line.path)}'>{html.escape(release_line.latest)}</a>"
            aliases = ""
            if release_line.aliases:
                aliases = " (aliases: " + ", ".join(html.escape(alias) for alias in release_line.aliases) + ")"
            release_items.append(
                f"<li><code>{html.escape(release_line.line)}</code> — {html.escape(release_line.status)}; latest {latest}{aliases}</li>"
            )
        body.append(f"<h2>Release lines</h2><ul>{''.join(release_items)}</ul>")
    if warning_items:
        body.append(f"<h2 class='warn'>Warnings</h2><ul>{warning_items}</ul>")
    return _html_page(result.display_name, "".join(body))