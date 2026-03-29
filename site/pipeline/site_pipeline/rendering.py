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
from typing import Any

from .constants import DEFAULT_TAG_PATTERN, SITE_TITLE, VALID_RELEASE_LINE_STATUSES
from .models import ProjectBuildResult


def relative_web_path(path: Path) -> str:
    """Convert a filesystem-relative path into a site-relative URL path."""

    return "/" + path.as_posix().lstrip("/")


def public_project_path(slug: str) -> str:
    """Return the public URL of a staged project landing page."""

    return f"/projects/{slug}/"


def public_unreleased_path(slug: str) -> str:
    """Return the public URL of a staged unreleased-docs landing page."""

    return f"/projects/{slug}/unreleased/"


def public_assets_root_path(slug: str) -> str:
    """Return the public URL prefix for staged unreleased assets."""

    return f"/projects/{slug}/unreleased/assets/"


def public_release_path(slug: str, version: str) -> str:
    """Return the public URL of a staged release landing page."""

    return f"/projects/{slug}/releases/{version}/"


def public_content_page_path(root_segments: list[str], relative_path: Path) -> str:
    """Map a staged content file path to the URL Hugo will publish."""

    file_path = Path(relative_path)
    segments = [segment for segment in file_path.parts[:-1] if segment not in {"."}]
    stem = file_path.stem
    if stem not in {"index", "_index"}:
        segments.append(stem)
    suffix = "/".join(root_segments + segments)
    return "/" + suffix.strip("/") + "/"


def release_index_web_path(project_root: Path, slug: str, version: str) -> str | None:
    """Return the staged URL of a release landing page if that page exists."""

    release_index_path = project_root / "releases" / version / "_index.md"
    if not release_index_path.is_file():
        return None
    return public_release_path(slug, version)


def compile_tag_pattern(pattern_text: str, slug: str, warnings: list[str]) -> re.Pattern[str]:
    """Compile a project's release-tag pattern with a safe fallback."""

    try:
        return re.compile(pattern_text)
    except re.error:
        warnings.append(f"Invalid tagPattern for {slug}; falling back to the default exact-version pattern.")
        return re.compile(DEFAULT_TAG_PATTERN)


def normalize_aliases(raw_aliases: Any, slug: str, line: str, warnings: list[str]) -> list[str]:
    """Validate and normalize alias values declared for a release line."""

    if raw_aliases is None:
        return []
    if not isinstance(raw_aliases, list):
        warnings.append(f"Ignoring invalid aliases for release line {line} in {slug}; expected a list.")
        return []
    aliases: list[str] = []
    for raw_alias in raw_aliases:
        if raw_alias is None:
            continue
        alias = str(raw_alias).strip()
        if alias:
            aliases.append(alias)
    return aliases


def normalize_lifecycle(
    lifecycle_fields: dict[str, Any],
    tag_pattern: re.Pattern[str],
    slug: str,
    project_root: Path,
    warnings: list[str],
) -> tuple[str | None, str | None, list[dict[str, Any]], list[dict[str, str]]]:
    """Validate lifecycle metadata and turn it into staged output structures."""

    latest_stable_raw = lifecycle_fields.get("latestStable")
    latest_stable_version = str(latest_stable_raw).strip() if latest_stable_raw is not None else None
    if latest_stable_version and tag_pattern.fullmatch(latest_stable_version) is None:
        warnings.append(f"Ignoring invalid latestStable value for {slug}; expected an exact version tag.")
        latest_stable_version = None

    release_lines_raw = lifecycle_fields.get("releaseLines")
    if release_lines_raw is None:
        release_lines_raw = []
    if not isinstance(release_lines_raw, list):
        warnings.append(f"Ignoring invalid releaseLines metadata for {slug}; expected a list.")
        release_lines_raw = []

    release_lines: list[dict[str, Any]] = []
    alias_mappings: list[dict[str, str]] = []
    for raw_line in release_lines_raw:
        if not isinstance(raw_line, dict):
            warnings.append(f"Ignoring invalid release line entry for {slug}; expected a mapping.")
            continue

        line = str(raw_line.get("line") or "").strip()
        latest = str(raw_line.get("latest") or "").strip()
        status = str(raw_line.get("status") or "").strip()
        if not line or not latest or not status:
            warnings.append(f"Ignoring incomplete release line entry for {slug}; line/latest/status are required.")
            continue
        if tag_pattern.fullmatch(latest) is None:
            warnings.append(f"Ignoring release line {line} for {slug}; latest must be an exact version tag.")
            continue
        if status not in VALID_RELEASE_LINE_STATUSES:
            warnings.append(f"Ignoring release line {line} for {slug}; unsupported status {status!r}.")
            continue

        aliases = normalize_aliases(raw_line.get("aliases"), slug, line, warnings)
        path = release_index_web_path(project_root, slug, latest)
        release_line = {"line": line, "latest": latest, "status": status, "aliases": aliases}
        if path is not None:
            release_line["path"] = path
        release_lines.append(release_line)
        for alias in aliases:
            alias_mappings.append({"alias": alias, "target": latest, "line": line, "status": status})

    latest_stable_path = None
    if latest_stable_version is not None:
        latest_stable_path = release_index_web_path(project_root, slug, latest_stable_version)

    return latest_stable_version, latest_stable_path, release_lines, alias_mappings


def build_project_markdown(result: ProjectBuildResult) -> str:
    """Build the staged landing-page body for one project."""

    lines: list[str] = []
    if result.repository:
        lines.append(f"- Repository: <{result.repository}>")
    if result.default_branch:
        lines.append(f"- Default branch: `{result.default_branch}`")
    lines.append(f"- Local workspace directory: `{result.local_dir}`")
    if result.navigation_section:
        lines.append(f"- Navigation section: `{result.navigation_section}`")
    if result.asset_count and result.raw_assets_root_path:
        lines.append(
            f"- Staged assets: {result.asset_count} file(s) under "
            f"[{result.raw_assets_root_path}]({result.raw_assets_root_path})."
        )
    if result.latest_stable_version:
        latest_stable = f"`{result.latest_stable_version}`"
        if result.latest_stable_path:
            latest_stable = f"[{result.latest_stable_version}]({result.latest_stable_path})"
        lines.append(f"- Latest stable: {latest_stable}")
    if result.release_lines:
        lines.extend(["", "## Release lines", ""])
        for release_line in result.release_lines:
            latest = f"`{release_line['latest']}`"
            if release_line.get("path"):
                latest = f"[{release_line['latest']}]({release_line['path']})"
            alias_suffix = ""
            if release_line["aliases"]:
                alias_suffix = " (aliases: " + ", ".join(f"`{alias}`" for alias in release_line["aliases"]) + ")"
            lines.append(f"- `{release_line['line']}` — {release_line['status']}; latest {latest}{alias_suffix}")
    return "\n".join(lines).rstrip() + "\n"


def build_unreleased_index_markdown(result: ProjectBuildResult) -> str:
    """Build the staged unreleased landing-page body for one project."""

    lines: list[str] = []
    if result.default_branch:
        lines.extend([f"Built from the local `{result.default_branch}` branch snapshot.", ""])
    if result.doc_links:
        lines.extend(["## Docs", ""])
        for doc_link in result.doc_links:
            lines.append(f"- [{doc_link['label']}]({doc_link['href']})")
        lines.append("")
    if result.asset_count and result.raw_assets_root_path:
        lines.extend([f"- [Open staged assets]({result.raw_assets_root_path})", ""])
    if not result.doc_links:
        lines.extend([f"No staged {result.unreleased_label.lower()} docs pages are currently available for this project.", ""])
    return "\n".join(lines).rstrip() + "\n"


def html_page(title: str, body: str) -> str:
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


def build_preview_index(results: list[ProjectBuildResult]) -> str:
    """Build the lightweight preview index shown outside Hugo."""

    items = []
    for result in results:
        status = "available" if result.available else "missing from local workspace"
        items.append(
            f"<li><a href='/site/.preview/projects/{result.slug}/'>{html.escape(result.display_name)}</a>"
            f" — <span class='muted'>{html.escape(status)}</span></li>"
        )
    body = (
        f"<h1>{SITE_TITLE}</h1>"
        "<p>This is a lightweight local preview for the staged site contract.</p>"
        "<p><a href='/site/.stage/content/_index.md'>Open staged root markdown</a></p>"
        f"<ul>{''.join(items)}</ul>"
    )
    return html_page(SITE_TITLE, body)


def build_project_preview(result: ProjectBuildResult) -> str:
    """Build the lightweight preview page for one staged project."""

    doc_items = "".join(
        f"<li><a href='{html.escape(entry['href'])}'>{html.escape(entry['label'])}</a></li>"
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
    if result.raw_project_index_path:
        body.append(f"<p><a href='{html.escape(result.raw_project_index_path)}'>Open staged project landing page</a></p>")
    if result.raw_unreleased_index_path:
        body.append(f"<p><a href='{html.escape(result.raw_unreleased_index_path)}'>Open {html.escape(result.unreleased_label)} docs index</a></p>")
    if doc_items:
        body.append(f"<h2>Docs</h2><ul>{doc_items}</ul>")
    if result.release_lines:
        release_items = []
        for release_line in result.release_lines:
            latest = f"<code>{html.escape(release_line['latest'])}</code>"
            if release_line.get("path"):
                latest = f"<a href='{html.escape(release_line['path'])}'>{html.escape(release_line['latest'])}</a>"
            aliases = ""
            if release_line["aliases"]:
                aliases = " (aliases: " + ", ".join(html.escape(alias) for alias in release_line["aliases"]) + ")"
            release_items.append(
                f"<li><code>{html.escape(release_line['line'])}</code> — {html.escape(release_line['status'])}; latest {latest}{aliases}</li>"
            )
        body.append(f"<h2>Release lines</h2><ul>{''.join(release_items)}</ul>")
    if warning_items:
        body.append(f"<h2 class='warn'>Warnings</h2><ul>{warning_items}</ul>")
    return html_page(result.display_name, "".join(body))