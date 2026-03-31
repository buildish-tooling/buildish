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

"""Shared helpers for extracted site-pipeline tests."""

from __future__ import annotations

from pathlib import Path
from textwrap import dedent
from typing import Mapping

import yaml


def text_block(contents: str) -> str:
    """Dedent a triple-quoted fixture string and drop a leading blank line."""

    return dedent(contents).lstrip("\n")


def write_text(path: Path, contents: str) -> None:
    """Write UTF-8 text, creating parent directories as needed."""

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8")


def write_files(root: Path, files: Mapping[str, str]) -> None:
    """Write a batch of relative fixture files below ``root``."""

    for relative_path, contents in files.items():
        write_text(root / relative_path, contents)


def dump_yaml(path: Path, payload: object) -> None:
    """Serialize a YAML payload using the test-suite formatting convention."""

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        yaml.safe_dump(payload, handle, sort_keys=False, default_flow_style=False)

