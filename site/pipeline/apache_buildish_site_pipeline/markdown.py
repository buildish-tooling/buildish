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

from dataclasses import dataclass
import re
from pathlib import Path
from typing import Any

from frontmatter.default_handlers import YAMLHandler
from mistletoe import Document, block_token, span_token

from .yaml_support import yaml_safe_value


_LEADING_HTML_COMMENT_PATTERN = re.compile(
    r"\A(?:[ \t\r\n]*<!--.*?-->[ \t\r\n]*)+", flags=re.DOTALL
)
_FRONT_MATTER_HANDLER = YAMLHandler()


@dataclass(frozen=True, slots=True)
class _MarkdownAnalysis:
    """Structured view of the leading Markdown blocks relevant to normalization."""

    title_index: int | None
    summary_index: int | None
    summary_is_first_body_block: bool
    title: str
    summary: str


def _token_plain_text(token: Any) -> str:
    """Return the plain-text content of a mistletoe token tree."""

    if isinstance(token, span_token.LineBreak):
        return "\n"

    children = getattr(token, "children", None)
    children_text = (
        "".join(_token_plain_text(child) for child in children)
        if children is not None
        else ""
    )
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

    return " ".join(
        line.strip() for line in _block_plain_text(block).splitlines() if line.strip()
    )


def _split_leading_html_comments(markdown_text: str) -> tuple[str, str]:
    """Split one or more leading HTML comments from ``markdown_text``."""

    match = _LEADING_HTML_COMMENT_PATTERN.match(markdown_text)
    if match is None:
        return "", markdown_text
    return markdown_text[: match.end()], markdown_text[match.end() :]


def _heading_level(block: Any) -> int | None:
    """Return the Markdown heading level for heading blocks, otherwise None."""

    if not isinstance(block, (block_token.Heading, block_token.SetextHeading)):
        return None
    level = getattr(block, "level", None)
    return level if isinstance(level, int) else None


def _analyze_markdown(blocks: list[Any], fallback_title: str) -> _MarkdownAnalysis:
    """Analyze the leading title/summary structure of a Markdown document."""

    significant_indexes = list(range(len(blocks)))
    if not significant_indexes:
        return _MarkdownAnalysis(None, None, False, fallback_title, "")

    title_index = significant_indexes[0]
    if _heading_level(blocks[title_index]) != 1:
        return _MarkdownAnalysis(None, None, False, fallback_title, "")

    title = _paragraph_plain_text(blocks[title_index]) or fallback_title
    remaining_indexes = significant_indexes[1:]
    first_significant_after_title_index = (
        remaining_indexes[0] if remaining_indexes else None
    )
    for index in remaining_indexes:
        block = blocks[index]
        heading_level = _heading_level(block)
        if heading_level is not None and heading_level >= 2:
            break
        if isinstance(block, block_token.Paragraph):
            return _MarkdownAnalysis(
                title_index,
                index,
                first_significant_after_title_index == index,
                title,
                _paragraph_plain_text(block),
            )

    return _MarkdownAnalysis(
        title_index,
        None,
        False,
        title,
        "",
    )


def _remove_blocks(
    markdown_text: str, blocks: list[Any], block_indexes: list[int]
) -> str:
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

    return "".join(
        line for line_index, line in enumerate(lines) if not skip[line_index]
    )


def extract_title_and_summary(
    markdown_text: str, fallback_title: str
) -> tuple[str, str]:
    """Extract a page title and short summary from Markdown content."""

    _, analyzable_body = _split_leading_html_comments(markdown_text)
    analysis = _analyze_markdown(
        list(Document(analyzable_body).children or ()), fallback_title
    )
    return analysis.title, analysis.summary


def with_yaml_front_matter(markdown: str, **fields: Any) -> str:
    """Wrap a Markdown body with YAML front matter fields."""

    front_matter = _FRONT_MATTER_HANDLER.export(
        yaml_safe_value(fields), sort_keys=False
    ).rstrip()
    body = markdown.lstrip()
    return f"---\n{front_matter}\n---\n\n{body}"


def _split_markdown_front_matter(markdown: str) -> tuple[dict[str, Any], str]:
    """Split a Markdown document into front matter and body content."""

    if not _FRONT_MATTER_HANDLER.detect(markdown):
        return {}, markdown

    raw_front_matter, body = _FRONT_MATTER_HANDLER.split(markdown)
    front_matter = _FRONT_MATTER_HANDLER.load(raw_front_matter)
    if front_matter is None:
        front_matter = {}
    if not isinstance(front_matter, dict):
        raise ValueError("Expected markdown front matter to be a mapping")
    return front_matter, body


def update_markdown_front_matter(markdown: str, **fields: Any) -> str:
    """Merge new fields into a document's existing front matter."""

    existing_fields, body = _split_markdown_front_matter(markdown)
    existing_fields.update(fields)
    return with_yaml_front_matter(body, **existing_fields)


def normalize_markdown_doc(
    markdown_text: str, fallback_title: str, **fields: Any
) -> tuple[str, str, str]:
    """Normalize staged Markdown so Hugo pages have predictable metadata."""

    existing_fields, body = _split_markdown_front_matter(markdown_text)
    _, analyzable_body = _split_leading_html_comments(body)

    existing_title = existing_fields.get("title")
    effective_fallback_title = fallback_title
    if isinstance(existing_title, str) and existing_title.strip():
        effective_fallback_title = existing_title.strip()

    blocks = list(Document(analyzable_body).children or ())
    analysis = _analyze_markdown(blocks, effective_fallback_title)
    title = analysis.title
    summary = analysis.summary
    existing_description = existing_fields.get("description")
    has_explicit_description = isinstance(existing_description, str) and bool(
        existing_description.strip()
    )
    if not summary and isinstance(existing_description, str):
        summary = existing_description.strip()

    removed_blocks: list[int] = []
    if analysis.title_index is not None:
        removed_blocks.append(analysis.title_index)
    if (
        summary
        and not has_explicit_description
        and analysis.summary_index is not None
        and analysis.summary_is_first_body_block
    ):
        removed_blocks.append(analysis.summary_index)
    normalized_body = (
        _remove_blocks(analyzable_body, blocks, removed_blocks)
        if analysis.title_index is not None
        else body
    )

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

    return [
        " ".join(lines)
        for chunk in text.strip().split("\n\n")
        if (lines := [line.strip() for line in chunk.splitlines() if line.strip()])
    ]
