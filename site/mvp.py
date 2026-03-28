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

from __future__ import annotations

import argparse
import datetime as dt
import functools
import html
import http.server
import os
import re
import shutil
import socketserver
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


DEFAULT_TAG_PATTERN = r"^v[0-9]+\.[0-9]+\.[0-9]+$"
VALID_RELEASE_LINE_STATUSES = {"maintained", "eol"}
SITE_TITLE = "Apache Buildish (Incubating)"
PROJECT_HEADLINE = "Apache Buildish develops build automation, CI integrations, and supporting tooling."
PROJECT_REPOSITORY_URL = "https://github.com/apache/buildish"
PROJECT_DEV_MAILING_LIST = "dev@buildish.apache.org"


@dataclass(frozen=True)
class ProjectBuildResult:
    slug: str
    display_name: str
    navigation_weight: int
    available: bool
    repository: str | None
    local_dir: str
    repo_path: Path
    summary: str
    raw_readme_path: str | None
    raw_unreleased_index_path: str | None
    raw_project_index_path: str | None
    raw_assets_root_path: str | None
    unreleased_label: str
    default_branch: str | None
    navigation_section: str | None
    asset_count: int
    latest_stable_version: str | None
    latest_stable_path: str | None
    release_lines: list[dict[str, Any]]
    alias_mappings: list[dict[str, str]]
    doc_links: list[dict[str, str]]
    warnings: list[str]


def repo_root_from(start: Path | None = None) -> Path:
    if start is not None:
        return start.resolve()
    return Path(__file__).resolve().parent.parent.resolve()


def load_yaml_like(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle)

    if not isinstance(data, dict):
        raise ValueError(f"Expected mapping in {path}")
    return data


def mapping_or_empty(payload: dict[str, Any], key: str, label: str) -> dict[str, Any]:
    value = payload.get(key)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"Expected mapping for {label}")
    return value


def first_non_none(*values: Any) -> Any:
    for value in values:
        if value is not None:
            return value
    return None


def parse_int_like(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"Expected integer for {label}")
    if isinstance(value, int):
        return value
    try:
        return int(str(value))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Expected integer for {label}") from exc


def load_project_metadata(repo_path: Path, metadata_relative: str | None, slug: str) -> tuple[dict[str, Any], Path | None]:
    if not metadata_relative:
        return {}, None

    metadata_path = safe_relative_path(repo_path, metadata_relative, f"metadataFile for {slug}")
    if metadata_path is None or not metadata_path.is_file():
        return {}, None

    metadata = load_yaml_like(metadata_path)
    project_fields = mapping_or_empty(metadata, "project", f"project metadata in {metadata_path}")
    payload = project_fields or metadata
    metadata_slug = first_non_none(project_fields.get("slug"), metadata.get("slug"))
    if metadata_slug is not None and str(metadata_slug) != slug:
        raise ValueError(f"Project metadata slug mismatch for {slug}: {metadata_slug}")

    return metadata, metadata_path


def write_yaml_like(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        yaml.safe_dump(payload, handle, sort_keys=False, allow_unicode=True, default_flow_style=False)


def ensure_within(parent: Path, candidate: Path, label: str) -> Path:
    parent_resolved = parent.resolve()
    candidate_resolved = candidate.resolve(strict=False)
    common = os.path.commonpath([str(parent_resolved), str(candidate_resolved)])
    if common != str(parent_resolved):
        raise ValueError(f"{label} escapes allowed root: {candidate}")
    return candidate_resolved


def safe_repo_path(repo_root: Path, local_dir: str) -> Path:
    workspace_parent = repo_root.parent.resolve()
    return ensure_within(workspace_parent, workspace_parent / local_dir, "Project localDir")


def safe_relative_path(base: Path, relative_path: str | None, label: str) -> Path | None:
    if not relative_path:
        return None
    return ensure_within(base, base / relative_path, label)


def copy_tree_without_symlinks(source: Path, destination: Path) -> list[Path]:
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


def strip_leading_html_comment(text: str) -> str:
    return re.sub(r"^<!--.*?-->\s*", "", text, count=1, flags=re.DOTALL)


def strip_leading_markdown_h1(markdown_text: str) -> str:
    lines = markdown_text.splitlines(keepends=True)
    prefix: list[str] = []
    index = 0

    while index < len(lines) and not lines[index].strip():
        index += 1

    while index < len(lines) and lines[index].lstrip().startswith("<!--"):
        while index < len(lines):
            current = lines[index]
            prefix.append(current)
            index += 1
            if "-->" in current:
                break
        while index < len(lines) and not lines[index].strip():
            prefix.append(lines[index])
            index += 1

    if index < len(lines) and lines[index].startswith("# "):
        index += 1
        while index < len(lines) and not lines[index].strip():
            index += 1
        return "".join(prefix + lines[index:])

    return markdown_text


def read_text_if_exists(path: Path | None) -> str:
    if path is None or not path.is_file():
        return ""
    return path.read_text(encoding="utf-8")


def extract_title_and_summary(markdown_text: str, fallback_title: str) -> tuple[str, str]:
    cleaned = strip_leading_html_comment(markdown_text).strip()
    if not cleaned:
        return fallback_title, ""

    title = fallback_title
    summary_lines: list[str] = []
    saw_title = False

    for raw_line in cleaned.splitlines():
        line = raw_line.strip()
        if not saw_title and line.startswith("# "):
            title = line[2:].strip()
            saw_title = True
            continue
        if not saw_title:
            continue
        if line.startswith("## "):
            break
        if line:
            summary_lines.append(line)
        elif summary_lines:
            break

    return title, " ".join(summary_lines).strip()


def humanized_stem(path: Path) -> str:
    return path.stem.replace("-", " ").replace("_", " ").strip().title()


def relative_web_path(path: Path) -> str:
    return "/" + path.as_posix().lstrip("/")


def with_yaml_front_matter(markdown: str, **fields: Any) -> str:
    front_matter = yaml.safe_dump(fields, sort_keys=False, default_flow_style=False).rstrip()
    body = markdown.lstrip()
    return f"---\n{front_matter}\n---\n\n{body}"


def write_markdown_page(path: Path, markdown: str, **fields: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(with_yaml_front_matter(markdown, **fields), encoding="utf-8")


def public_project_path(slug: str) -> str:
    return f"/projects/{slug}/"


def public_unreleased_path(slug: str) -> str:
    return f"/projects/{slug}/unreleased/"


def public_source_readme_path(slug: str) -> str:
    return f"/projects/{slug}/source-readme/"


def public_assets_root_path(slug: str) -> str:
    return f"/projects/{slug}/unreleased/assets/"


def public_release_path(slug: str, version: str) -> str:
    return f"/projects/{slug}/releases/{version}/"


def public_content_page_path(root_segments: list[str], relative_path: Path) -> str:
    file_path = Path(relative_path)
    segments = [segment for segment in file_path.parts[:-1] if segment not in {"."}]
    stem = file_path.stem
    if stem not in {"index", "_index"}:
        segments.append(stem)
    suffix = "/".join(root_segments + segments)
    return "/" + suffix.strip("/") + "/"


def release_index_web_path(project_root: Path, slug: str, version: str) -> str | None:
    release_index_path = project_root / "releases" / version / "_index.md"
    if not release_index_path.is_file():
        return None
    return public_release_path(slug, version)


def compile_tag_pattern(pattern_text: str, slug: str, warnings: list[str]) -> re.Pattern[str]:
    try:
        return re.compile(pattern_text)
    except re.error:
        warnings.append(f"Invalid tagPattern for {slug}; falling back to the default exact-version pattern.")
        return re.compile(DEFAULT_TAG_PATTERN)


def normalize_aliases(raw_aliases: Any, slug: str, line: str, warnings: list[str]) -> list[str]:
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
    lines: list[str] = []
    if result.summary:
        lines.extend([result.summary, ""])
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
    lines: list[str] = []
    if result.default_branch:
        lines.extend([f"Built from the local `{result.default_branch}` branch snapshot.", ""])
    if result.summary:
        lines.extend([result.summary, ""])
    if result.asset_count and result.raw_assets_root_path:
        lines.extend([f"- [Open staged assets]({result.raw_assets_root_path})", ""])
    if not result.doc_links:
        lines.extend([f"This project currently uses its README as the {result.unreleased_label} docs entry point.", ""])
    return "\n".join(lines).rstrip() + "\n"


def build_root_index_markdown(results: list[ProjectBuildResult]) -> str:
    available = sum(1 for result in results if result.available)
    total = len(results)
    lines = [
        "Apache Buildish is an incubating Apache umbrella project for build engineering, CI provider integrations, and the tooling that supports reliable developer workflows.",
        "",
        "Use this site to explore staged subprojects, learn what the umbrella project is building toward, and find the best way to join the community.",
        "",
        f"Currently staged local projects: {available}/{total} available.",
    ]
    return "\n".join(lines).rstrip() + "\n"


def split_paragraphs(text: str) -> list[str]:
    paragraphs: list[str] = []
    for chunk in text.strip().split("\n\n"):
        lines = [line.strip() for line in chunk.splitlines() if line.strip()]
        if lines:
            paragraphs.append(" ".join(lines))
    return paragraphs


def build_projects_index_markdown(results: list[ProjectBuildResult]) -> str:
    available = sum(1 for result in results if result.available)
    total = len(results)
    lines = [f"Local sub-projects staged from the catalog: {available}/{total} available."]
    return "\n".join(lines).rstrip() + "\n"


def build_security_report_markdown() -> str:
    lines = [
        "Report suspected vulnerabilities privately; do not disclose them in public issues, pull requests, or mailing lists.",
        "",
        "Follow the [Apache Software Foundation security guidance](https://www.apache.org/security/) when reporting a vulnerability affecting Apache Buildish.",
        "",
        "Include the affected component, versions, reproduction details, impact, and any suggested mitigations to help the report be triaged quickly.",
    ]
    return "\n".join(lines).rstrip() + "\n"


def build_about_markdown() -> str:
    lines = [
        "Apache Buildish is an incubating Apache project focused on build automation, CI integrations, and supporting developer tooling.",
        "",
        "The umbrella project is intended to host practical tools, reusable build components, and provider-facing integrations that help development teams build, test, and ship software more consistently.",
        "",
        "This MVP site brings together umbrella-project information and staged documentation from local Buildish subprojects so contributors can review structure, content, and navigation before the site grows further.",
    ]
    return "\n".join(lines).rstrip() + "\n"


def build_community_index_markdown() -> str:
    lines = [
        "Apache Buildish is built in the open. Use this section to find project communication channels, contribution entry points, and security reporting guidance.",
        "",
        "- [Community & Contact](/community/contact/)",
        f"- [Source Code]({PROJECT_REPOSITORY_URL})",
        "- [Get Involved](/community/get-involved/)",
        "- [Security Report](/community/security-report/)",
    ]
    return "\n".join(lines).rstrip() + "\n"


def build_contact_markdown() -> str:
    lines = [
        "Apache Buildish coordinates development in public and welcomes early feedback while the project is incubating.",
        "",
        "## Project channels",
        "",
        f"- Source repository: [{PROJECT_REPOSITORY_URL}]({PROJECT_REPOSITORY_URL})",
        f"- Development mailing list: [{PROJECT_DEV_MAILING_LIST}](mailto:{PROJECT_DEV_MAILING_LIST})",
        "",
        "## How to reach the project",
        "",
        "Use the development mailing list for design discussion, contributor onboarding questions, release planning, and general project feedback.",
        "",
        "Use the source repository for code, issue tracking, pull requests, and implementation-oriented discussion tied to specific changes.",
        "",
        "For private vulnerability reports, follow the [Security Report](/community/security-report/) guidance instead of opening a public issue.",
    ]
    return "\n".join(lines).rstrip() + "\n"


def build_get_involved_markdown() -> str:
    lines = [
        "Apache Buildish is looking for feedback on project structure, docs, workflows, and tooling ideas while the site and subprojects take shape.",
        "",
        "## Ways to contribute",
        "",
        "- Try the staged subprojects and share what works or what feels rough.",
        f"- Join the [development mailing list](mailto:{PROJECT_DEV_MAILING_LIST}) to discuss ideas and priorities.",
        f"- Browse the [source repository]({PROJECT_REPOSITORY_URL}) for issues, pull requests, and project structure.",
        "- Improve docs, examples, naming, onboarding notes, and contributor guidance.",
        "",
        "## Early focus areas",
        "",
        "Early contributors can help validate the umbrella-project site, shape CI integration patterns, improve build automation ergonomics, and tighten the handoff between project docs and implementation repositories.",
    ]
    return "\n".join(lines).rstrip() + "\n"


def html_page(title: str, body: str) -> str:
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
    doc_items = "".join(
        f"<li><a href='{html.escape(entry['href'])}'>{html.escape(entry['label'])}</a></li>"
        for entry in result.doc_links
    )
    warning_items = "".join(f"<li>{html.escape(item)}</li>" for item in result.warnings)
    body = [f"<p><a href='/site/.preview/'>&larr; Back to preview index</a></p>"]
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


def stage_project(repo_root: Path, stage_root: Path, project: dict[str, Any], defaults: dict[str, Any], catalog_index: int) -> ProjectBuildResult:
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

    readme_setting = first_non_none(
        project.get("readmePath"),
        content_fields.get("readmePath"),
        project_fields.get("readmePath"),
        metadata_fields.get("readmePath"),
        defaults.get("readmePath"),
        "README.md",
    )
    readme_relative = str(readme_setting)

    docs_setting = (
        project["docsRoot"]
        if "docsRoot" in project
        else first_non_none(content_fields.get("docsRoot"), project_fields.get("docsRoot"), metadata_fields.get("docsRoot"), defaults.get("docsRoot"))
    )
    docs_relative = "" if docs_setting is None else str(docs_setting)

    assets_setting = (
        project["assetsRoot"]
        if "assetsRoot" in project
        else first_non_none(
            content_fields.get("assetsRoot"),
            project_fields.get("assetsRoot"),
            metadata_fields.get("assetsRoot"),
            defaults.get("assetsRoot"),
        )
    )
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

    readme_path = safe_relative_path(repo_path, readme_relative, f"README for {slug}")
    readme_text = read_text_if_exists(readme_path) if available else ""
    _, summary = extract_title_and_summary(readme_text, display_name)

    project_root = stage_root / "content" / "projects" / slug
    unreleased_root = project_root / "unreleased"
    docs_root = unreleased_root / "docs"
    staged_assets_root = stage_root / "static" / "projects" / slug / "unreleased" / "assets"

    staged_readme_path = project_root / "source-readme.md"
    raw_readme_path = None
    if readme_text:
        staged_readme_path.parent.mkdir(parents=True, exist_ok=True)
        _, readme_summary = extract_title_and_summary(readme_text, f"{display_name} source README")
        readme_body = strip_leading_markdown_h1(readme_text)
        staged_readme_path.write_text(
            with_yaml_front_matter(
                readme_body,
                title=f"{display_name} source README",
                weight=20,
                type="docs",
                **({"description": readme_summary} if readme_summary else {}),
            ),
            encoding="utf-8",
        )
        raw_readme_path = public_source_readme_path(slug)

    copied_docs: list[Path] = []
    copied_assets: list[Path] = []
    if available:
        docs_path = safe_relative_path(repo_path, str(docs_relative), f"docsRoot for {slug}") if docs_relative else None
        if docs_path and docs_path.is_dir():
            copied_docs = copy_tree_without_symlinks(docs_path, docs_root)
        else:
            warnings.append("No docs directory found; using the README as the unreleased docs entry point.")
            if readme_text:
                docs_root.mkdir(parents=True, exist_ok=True)
                fallback_readme = docs_root / "readme.md"
                fallback_readme.write_text(readme_text, encoding="utf-8")
                copied_docs = [Path("readme.md")]

        assets_path = safe_relative_path(repo_path, str(assets_relative), f"assetsRoot for {slug}") if assets_relative else None
        if assets_path and assets_path.is_dir():
            copied_assets = copy_tree_without_symlinks(assets_path, staged_assets_root)
    else:
        warnings.append("Local repository directory is missing; project was skipped for raw docs staging.")

    if copied_docs:
        docs_root.mkdir(parents=True, exist_ok=True)
        (docs_root / "_index.md").write_text(
            with_yaml_front_matter(
                f"Browsable {unreleased_label.lower()} docs staged for {display_name}.\n",
                title=f"{display_name} {unreleased_label} docs",
                weight=10,
                type="docs",
                description=f"Browsable {unreleased_label.lower()} docs staged for {display_name}.",
            ),
            encoding="utf-8",
        )

    doc_links: list[dict[str, str]] = []
    for copied in copied_docs:
        staged_doc_path = docs_root / copied
        if copied.suffix.lower() in {".md", ".markdown"} and staged_doc_path.is_file():
            doc_text = staged_doc_path.read_text(encoding="utf-8")
            doc_title, doc_summary = extract_title_and_summary(doc_text, humanized_stem(copied))
            doc_body = strip_leading_markdown_h1(doc_text)
            staged_doc_path.write_text(
                with_yaml_front_matter(
                    doc_body,
                    title=doc_title,
                    type="docs",
                    **({"description": doc_summary} if doc_summary else {}),
                ),
                encoding="utf-8",
            )
        if copied.suffix.lower() not in {".md", ".markdown", ".adoc", ".asciidoc"}:
            continue
        raw_path = public_content_page_path(["projects", slug, "unreleased", "docs"], copied)
        doc_links.append({"label": copied.with_suffix("").as_posix().replace("-", " "), "href": raw_path})

    unreleased_index_path = unreleased_root / "_index.md"
    project_index_path = project_root / "_index.md"
    version_metadata_path = unreleased_root / "version.yaml"
    lifecycle_metadata_path = project_root / "lifecycle.yaml"

    raw_unreleased_index_path = public_unreleased_path(slug)
    raw_project_index_path = public_project_path(slug)
    raw_assets_root_path = public_assets_root_path(slug) if copied_assets else None

    tag_pattern = compile_tag_pattern(tag_pattern_text, slug, warnings)
    latest_stable_version, latest_stable_path, release_lines, alias_mappings = normalize_lifecycle(
        lifecycle_fields,
        tag_pattern,
        slug,
        project_root,
        warnings,
    )

    project_result = ProjectBuildResult(
        slug=slug,
        display_name=display_name,
        navigation_weight=navigation_weight,
        available=available,
        repository=str(repository) if repository else None,
        local_dir=local_dir,
        repo_path=repo_path,
        summary=summary,
        raw_readme_path=raw_readme_path,
        raw_unreleased_index_path=raw_unreleased_index_path,
        raw_project_index_path=raw_project_index_path,
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

    project_index_path.parent.mkdir(parents=True, exist_ok=True)
    project_index_path.write_text(
        with_yaml_front_matter(
            build_project_markdown(project_result),
            title=display_name,
            weight=navigation_weight,
            type="docs",
            **({"description": summary} if summary else {}),
        ),
        encoding="utf-8",
    )
    unreleased_index_path.write_text(
        with_yaml_front_matter(
            build_unreleased_index_markdown(project_result),
            title=f"{display_name} {unreleased_label}",
            weight=10,
            type="docs",
            **({"description": summary} if summary else {}),
        ),
        encoding="utf-8",
    )

    write_yaml_like(
        version_metadata_path,
        {
            "schemaVersion": 1,
            "project": {"slug": slug, "displayName": display_name},
            "version": {"kind": "unreleased", "label": unreleased_label, "path": raw_unreleased_index_path},
            "source": {
                "repository": repository,
                "localDir": local_dir,
                "metadataFile": metadata_relative,
                "metadataLoaded": metadata_path is not None,
                "defaultBranch": default_branch,
                "readmePath": readme_relative,
                "docsRoot": docs_relative or None,
                "assetsRoot": assets_relative or None,
            },
            "assets": {
                "count": len(copied_assets),
                "path": raw_assets_root_path,
            },
        },
    )
    lifecycle_payload: dict[str, Any] = {
        "unreleased": {
            "label": unreleased_label,
            "path": raw_unreleased_index_path,
            "robots": "index,follow",
        },
        "latestStable": None,
        "releaseLines": [],
    }
    if latest_stable_version is not None:
        latest_stable_entry: dict[str, Any] = {"version": latest_stable_version}
        if latest_stable_path is not None:
            latest_stable_entry["path"] = latest_stable_path
        lifecycle_payload["latestStable"] = latest_stable_entry
    if release_lines:
        lifecycle_payload["releaseLines"] = [
            {
                key: value
                for key, value in release_line.items()
                if value is not None and (key != "aliases" or value)
            }
            for release_line in release_lines
        ]
    write_yaml_like(
        lifecycle_metadata_path,
        {
            "schemaVersion": 1,
            "project": {"slug": slug, "displayName": display_name},
            "lifecycle": lifecycle_payload,
        },
    )

    return project_result


def build(repo_root: Path | None = None) -> list[ProjectBuildResult]:
    resolved_repo_root = repo_root_from(repo_root)
    site_root = resolved_repo_root / "site"
    catalog_path = site_root / "projects.yaml"
    catalog = load_yaml_like(catalog_path)
    defaults = dict(catalog.get("defaults") or {})
    projects = list(catalog.get("projects") or [])

    stage_root = site_root / ".stage"
    preview_root = site_root / ".preview"
    shutil.rmtree(stage_root, ignore_errors=True)
    shutil.rmtree(preview_root, ignore_errors=True)
    stage_root.mkdir(parents=True, exist_ok=True)
    preview_root.mkdir(parents=True, exist_ok=True)

    results = [stage_project(resolved_repo_root, stage_root, project, defaults, index) for index, project in enumerate(projects, start=1)]
    incubator_disclaimer = read_text_if_exists(resolved_repo_root / "DISCLAIMER").strip()
    incubator_disclaimer_paragraphs = split_paragraphs(incubator_disclaimer)

    root_index = stage_root / "content" / "_index.md"
    write_markdown_page(
        root_index,
        build_root_index_markdown(results),
        title=SITE_TITLE,
        description=PROJECT_HEADLINE,
        incubator_disclaimer_paragraphs=incubator_disclaimer_paragraphs,
    )

    projects_index = stage_root / "content" / "projects" / "_index.md"
    write_markdown_page(
        projects_index,
        build_projects_index_markdown(results),
        title="Projects",
        description="Browsable project sections staged from the local catalog.",
        type="docs",
    )

    about_page = stage_root / "content" / "about.md"
    write_markdown_page(
        about_page,
        build_about_markdown(),
        title="About Apache Buildish",
        description=PROJECT_HEADLINE,
        type="docs",
        weight=5,
    )

    community_index_page = stage_root / "content" / "community" / "_index.md"
    write_markdown_page(
        community_index_page,
        build_community_index_markdown(),
        title="Community",
        description="Community links, contributor entry points, and contact information for Apache Buildish.",
        type="docs",
        weight=20,
    )

    contact_page = stage_root / "content" / "community" / "contact.md"
    write_markdown_page(
        contact_page,
        build_contact_markdown(),
        title="Community & Contact",
        description="How to reach the Apache Buildish project and where to find its public development channels.",
        type="docs",
        weight=10,
    )

    get_involved_page = stage_root / "content" / "community" / "get-involved.md"
    write_markdown_page(
        get_involved_page,
        build_get_involved_markdown(),
        title="Get Involved",
        description="Ways contributors can participate in Apache Buildish while the project is taking shape.",
        type="docs",
        weight=20,
    )

    security_report_page = stage_root / "content" / "community" / "security-report.md"
    write_markdown_page(
        security_report_page,
        build_security_report_markdown(),
        title="Security Report",
        description="How to report suspected Apache Buildish security vulnerabilities.",
        type="docs",
        weight=30,
    )

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
                    "assetCount": result.asset_count,
                    "assetsPath": result.raw_assets_root_path,
                    "latestStable": result.latest_stable_version,
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
                    "releaseLines": [
                        {
                            key: value
                            for key, value in release_line.items()
                            if key in {"line", "latest", "status", "aliases"} and (key != "aliases" or value)
                        }
                        for release_line in result.release_lines
                    ],
                    "unreleased": {"label": result.unreleased_label, "path": result.raw_unreleased_index_path},
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
    resolved_repo_root = repo_root_from(repo_root)
    shutil.rmtree(resolved_repo_root / "site" / ".stage", ignore_errors=True)
    shutil.rmtree(resolved_repo_root / "site" / ".preview", ignore_errors=True)
    shutil.rmtree(resolved_repo_root / ".site-stage", ignore_errors=True)
    shutil.rmtree(resolved_repo_root / ".site-preview", ignore_errors=True)


def serve(repo_root: Path | None = None, port: int = 8000) -> None:
    resolved_repo_root = repo_root_from(repo_root)
    build(resolved_repo_root)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(resolved_repo_root))
    with socketserver.TCPServer(("127.0.0.1", port), handler) as httpd:
        print(f"Serving local preview at http://127.0.0.1:{port}/site/.preview/")
        httpd.serve_forever()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Buildish site helper")
    parser.add_argument("command", choices=["build", "clean", "serve"], nargs="?", default="build")
    parser.add_argument("--port", type=int, default=8000, help="Port for the local preview server")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.command == "build":
        results = build()
        print(f"Built {len(results)} project(s) into site/.stage and site/.preview")
        return 0
    if args.command == "clean":
        clean()
        print("Removed site/.stage and site/.preview")
        return 0
    serve(port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
