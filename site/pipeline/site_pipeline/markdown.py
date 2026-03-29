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

from mistletoe import Document, block_token, span_token
import yaml

from .yaml_support import yaml_safe_value


_HTML_COMMENT_PATTERN = re.compile(r"^<!--.*?-->\s*$", flags=re.DOTALL)


def _token_plain_text(token: Any) -> str:
    """Return the plain-text content of a mistletoe token tree."""

    if isinstance(token, span_token.LineBreak):
        return "\n"

    children = getattr(token, "children", None)
    children_text = "".join(_token_plain_text(child) for child in children) if children is not None else ""
    if isinstance(token, span_token.InlineCode):
        return f"`{children_text}`"
    if isinstance(token, span_token.Emphasis):
        return f"*{children_text}*"
    if isinstance(token, span_token.Strong):
        return f"**{children_text}**"
    if isinstance(token, span_token.Strikethrough):
        return f"~~{children_text}~~"
    if isinstance(token, span_token.Link):
        return f"[{children_text}]({token.target})"
    if isinstance(token, span_token.AutoLink):
        return f"<{token.target}>"
    if isinstance(token, span_token.Image):
        return f"![{children_text}]({token.src})"
    if children is not None:
        return children_text
    content = getattr(token, "content", None)
    return content if isinstance(content, str) else ""


def _block_plain_text(block: Any) -> str:
    """Return normalized plain text for a parsed Markdown block."""

    return _token_plain_text(block).strip()


def _paragraph_plain_text(block: Any) -> str:
    """Return a paragraph block collapsed into a single summary line."""

    return " ".join(line.strip() for line in _block_plain_text(block).splitlines() if line.strip())


def _is_html_comment_block(block: Any) -> bool:
    """Return whether a parsed block is only an HTML comment."""

    if not isinstance(block, (block_token.Paragraph, block_token.HtmlBlock)):
        return False
    return _HTML_COMMENT_PATTERN.fullmatch(_block_plain_text(block)) is not None


def _is_heading_level(block: Any, level: int) -> bool:
    """Return whether a parsed block is a heading of the requested level."""

    return isinstance(block, (block_token.Heading, block_token.SetextHeading)) and getattr(block, "level", None) == level


def _is_heading_level_at_least(block: Any, level: int) -> bool:
    """Return whether a parsed block is a heading at or above the requested level."""

    return isinstance(block, (block_token.Heading, block_token.SetextHeading)) and getattr(block, "level", 0) >= level


def _leading_h1_index(blocks: list[Any]) -> int | None:
    """Return the leading H1 index after skipping leading HTML comment blocks."""

    for index, block in enumerate(blocks):
        if _is_html_comment_block(block):
            continue
        return index if _is_heading_level(block, 1) else None
    return None


def _summary_paragraph_index_and_text(blocks: list[Any], title_index: int) -> tuple[int | None, str]:
    """Find the first summary paragraph after a leading H1 and before the next section heading."""

    for index in range(title_index + 1, len(blocks)):
        block = blocks[index]
        if _is_html_comment_block(block):
            continue
        if _is_heading_level_at_least(block, 2):
            break
        if isinstance(block, block_token.Paragraph):
            return index, _paragraph_plain_text(block)
    return None, ""


def _first_non_comment_block_index(blocks: list[Any], start_index: int) -> int | None:
    """Return the first block index at or after start_index that is not an HTML comment block."""

    for index in range(start_index, len(blocks)):
        if not _is_html_comment_block(blocks[index]):
            return index
    return None


def _remove_blocks(markdown_text: str, blocks: list[Any], block_indexes: list[int]) -> str:
    """Remove parsed blocks from Markdown text using mistletoe line metadata."""

    if not block_indexes:
        return markdown_text

    lines = markdown_text.splitlines(keepends=True)
    skip = [False] * len(lines)

    for index in sorted(set(block_indexes)):
        line_number = getattr(blocks[index], "line_number", None)
        if not isinstance(line_number, int):
            continue
        next_line_number = len(lines) + 1
        for next_index in range(index + 1, len(blocks)):
            candidate = getattr(blocks[next_index], "line_number", None)
            if isinstance(candidate, int):
                next_line_number = candidate
                break
        for line_index in range(line_number - 1, min(next_line_number - 1, len(lines))):
            skip[line_index] = True

    return "".join(line for line_index, line in enumerate(lines) if not skip[line_index])


def extract_title_and_summary(markdown_text: str, fallback_title: str) -> tuple[str, str]:
    """Extract a page title and short summary from Markdown content."""

    blocks = list(Document(markdown_text).children)
    title_index = _leading_h1_index(blocks)
    if title_index is None:
        return fallback_title, ""

    title = _paragraph_plain_text(blocks[title_index])
    _, summary = _summary_paragraph_index_and_text(blocks, title_index)
    return title or fallback_title, summary


def with_yaml_front_matter(markdown: str, **fields: Any) -> str:
    """Wrap a Markdown body with YAML front matter fields."""

    front_matter = yaml.safe_dump(yaml_safe_value(fields), sort_keys=False, default_flow_style=False).rstrip()
    body = markdown.lstrip()
    return f"---\n{front_matter}\n---\n\n{body}"


def _split_markdown_front_matter(markdown: str) -> tuple[dict[str, Any], str]:
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

    existing_fields, body = _split_markdown_front_matter(markdown)
    existing_fields.update(fields)
    return with_yaml_front_matter(body, **existing_fields)


def normalize_markdown_doc(markdown_text: str, fallback_title: str, **fields: Any) -> tuple[str, str, str]:
    """Normalize staged Markdown so Hugo pages have predictable metadata."""

    existing_fields, body = _split_markdown_front_matter(markdown_text)

    existing_title = existing_fields.get("title")
    effective_fallback_title = fallback_title
    if isinstance(existing_title, str) and existing_title.strip():
        effective_fallback_title = existing_title.strip()

    blocks = list(Document(body).children)
    title_index = _leading_h1_index(blocks)
    title = effective_fallback_title
    summary = ""
    summary_index: int | None = None
    if title_index is not None:
        title = _paragraph_plain_text(blocks[title_index]) or effective_fallback_title
        summary_index, summary = _summary_paragraph_index_and_text(blocks, title_index)
    existing_description = existing_fields.get("description")
    has_explicit_description = isinstance(existing_description, str) and bool(existing_description.strip())
    if not summary and isinstance(existing_description, str):
        summary = existing_description.strip()

    removed_blocks: list[int] = []
    if title_index is not None:
        removed_blocks.append(title_index)
    if summary and not has_explicit_description and summary_index is not None:
        first_content_after_title = _first_non_comment_block_index(blocks, title_index + 1)
        if first_content_after_title == summary_index:
            removed_blocks.append(summary_index)
    normalized_body = _remove_blocks(body, blocks, removed_blocks)

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