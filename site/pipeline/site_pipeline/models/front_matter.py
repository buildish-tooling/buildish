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

"""Typed front matter payloads injected into staged Markdown pages."""

from __future__ import annotations

from typing import Literal

from pydantic import Field, StrictBool

from .base import YamlModel
from .staged import LifecycleLatestStable, StagedReleaseLine, VersionDescriptor


class BuildishComponentPaths(YamlModel):
    """Path map injected into staged component page front matter."""

    component: str | None = Field(default=None, exclude_if=lambda value: value is None)
    unreleased: str | None = Field(default=None, exclude_if=lambda value: value is None)
    docs: str | None = Field(default=None, exclude_if=lambda value: value is None)
    assets: str | None = Field(default=None, exclude_if=lambda value: value is None)


class BuildishComponentUnreleased(YamlModel):
    """Unreleased-version metadata injected into staged component page front matter."""

    label: str
    path: str
    docs_path: str | None = Field(default=None, exclude_if=lambda value: value is None)
    assets_path: str | None = Field(
        default=None, exclude_if=lambda value: value is None
    )


class BuildishComponentPayload(YamlModel):
    """Component context payload injected into staged Markdown front matter."""

    slug: str
    display_name: str
    summary: str | None = Field(default=None, exclude_if=lambda value: value is None)
    available: StrictBool
    local_dir: str
    repository: str | None = Field(default=None, exclude_if=lambda value: value is None)
    default_branch: str | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    navigation_section: str | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    paths: BuildishComponentPaths
    unreleased_label: str
    unreleased: BuildishComponentUnreleased
    latest_stable: LifecycleLatestStable | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    release_lines: tuple[StagedReleaseLine, ...] = Field(default_factory=tuple)


class BuildishComponentPagePayload(YamlModel):
    """Per-page context payload injected into staged component page front matter."""

    kind: Literal[
        "component-home", "component-page", "unreleased-home", "docs-home", "docs-page"
    ]
    section: Literal["component", "unreleased", "docs"]
    path: str | None = Field(default=None, exclude_if=lambda value: value is None)
    component_path: str | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    version: VersionDescriptor | None = Field(
        default=None, exclude_if=lambda value: value is None
    )


class DocsFrontMatter(YamlModel):
    """Common docs-style front matter used for staged Markdown pages."""

    title: str | None = Field(default=None, exclude_if=lambda value: value is None)
    link_title: str | None = Field(default=None, exclude_if=lambda value: value is None)
    weight: int | None = Field(default=None, exclude_if=lambda value: value is None)
    type: Literal["docs"] = "docs"
    description: str | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
