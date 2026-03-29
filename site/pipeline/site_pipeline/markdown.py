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

"""Markdown normalization helpers used by the site staging pipeline.

The pipeline turns documentation from several repositories into one staged Hugo
content tree. These helpers keep front matter, titles, and summaries consistent
without requiring every source repository to follow identical conventions.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml


def strip_leading_html_comment(text: str) -> str:
    """Remove a leading HTML comment block from a Markdown document."""

    return re.sub(r"^<!--.*?-->\s*", "", text, count=1, flags=re.DOTALL)


def strip_leading_markdown_h1(markdown_text: str) -> str:
    """Drop the first Markdown H1 heading while preserving leading comments."""

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


def extract_title_and_summary(markdown_text: str, fallback_title: str) -> tuple[str, str]:
    """Extract a page title and short summary from Markdown content."""

    cleaned = strip_leading_html_comment(markdown_text).strip()
    if not cleaned:
        return fallback_title, ""

    title = fallback_title
    summary_lines: list[str] = []
    saw_title = False
    in_fenced_block = False
    fence_marker = ""

    for raw_line in cleaned.splitlines():
        stripped = raw_line.lstrip()
        if stripped.startswith(("```", "~~~")):
            marker = stripped[:3]
            if not in_fenced_block:
                in_fenced_block = True
                fence_marker = marker
            elif marker == fence_marker:
                in_fenced_block = False
                fence_marker = ""
            continue

        if in_fenced_block:
            continue

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


def strip_leading_summary_paragraph(markdown_text: str) -> str:
    """Remove an auto-promoted summary paragraph from the document body."""

    lines = markdown_text.splitlines(keepends=True)
    prefix: list[str] = []
    index = 0

    while index < len(lines) and not lines[index].strip():
        prefix.append(lines[index])
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

    paragraph_start = index
    paragraph_lines: list[str] = []
    while index < len(lines):
        stripped = lines[index].strip()
        if not stripped:
            index += 1
            while index < len(lines) and not lines[index].strip():
                index += 1
            return "".join(prefix + lines[index:])
        if not paragraph_lines and stripped.startswith(("#", "```", "~~~", "- ", "* ", ">", "|")):
            return markdown_text
        if not paragraph_lines and re.match(r"^[0-9]+\.\s", stripped):
            return markdown_text
        if paragraph_lines and stripped.startswith("## "):
            return "".join(prefix + lines[index:])
        paragraph_lines.append(lines[index])
        index += 1

    if paragraph_lines:
        return "".join(prefix + lines[index:])
    return markdown_text if paragraph_start == index else "".join(prefix + lines[index:])


def with_yaml_front_matter(markdown: str, **fields: Any) -> str:
    """Wrap a Markdown body with YAML front matter fields."""

    front_matter = yaml.safe_dump(fields, sort_keys=False, default_flow_style=False).rstrip()
    body = markdown.lstrip()
    return f"---\n{front_matter}\n---\n\n{body}"


def split_markdown_front_matter(markdown: str) -> tuple[dict[str, Any], str]:
    """Split a Markdown document into front matter and body content."""

    match = re.match(r"^---\n(.*?)\n---\n?", markdown, flags=re.DOTALL)
    if match is None:
        return {}, markdown
    front_matter = yaml.safe_load(match.group(1)) or {}
    if not isinstance(front_matter, dict):
        raise ValueError("Expected markdown front matter to be a mapping")
    return front_matter, markdown[match.end() :]


def update_markdown_front_matter(markdown: str, **fields: Any) -> str:
    """Merge new fields into a document's existing front matter."""

    existing_fields, body = split_markdown_front_matter(markdown)
    existing_fields.update(fields)
    return with_yaml_front_matter(body, **existing_fields)


def normalize_markdown_doc(markdown_text: str, fallback_title: str, **fields: Any) -> tuple[str, str, str]:
    """Normalize staged Markdown so Hugo pages have predictable metadata."""

    existing_fields, body = split_markdown_front_matter(markdown_text)

    existing_title = existing_fields.get("title")
    effective_fallback_title = fallback_title
    if isinstance(existing_title, str) and existing_title.strip():
        effective_fallback_title = existing_title.strip()

    title, summary = extract_title_and_summary(body, effective_fallback_title)
    existing_description = existing_fields.get("description")
    has_explicit_description = isinstance(existing_description, str) and bool(existing_description.strip())
    if not summary and isinstance(existing_description, str):
        summary = existing_description.strip()

    normalized_body = strip_leading_markdown_h1(body)
    if summary and not has_explicit_description:
        normalized_body = strip_leading_summary_paragraph(normalized_body)

    updated_fields = dict(existing_fields)
    updated_fields.update(fields)
    updated_fields["title"] = title
    if summary:
        updated_fields["description"] = summary
    else:
        updated_fields.pop("description", None)

    return with_yaml_front_matter(normalized_body, **updated_fields), title, summary


def humanized_stem(path: Path) -> str:
    """Convert a file stem into a human-friendly fallback title."""

    return path.stem.replace("-", " ").replace("_", " ").strip().title()


def split_paragraphs(text: str) -> list[str]:
    """Split plain text into normalized paragraphs for YAML front matter."""

    paragraphs: list[str] = []
    for chunk in text.strip().split("\n\n"):
        lines = [line.strip() for line in chunk.splitlines() if line.strip()]
        if lines:
            paragraphs.append(" ".join(lines))
    return paragraphs