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

"""Public API for the Buildish site pipeline package.

Most callers only need the exported build helpers from this module. The package
internals are split into smaller modules so contributors can find the Markdown,
filesystem, watch-mode, and build orchestration logic more easily.
"""

from __future__ import annotations

from .builder import build, clean, serve, stage_project
from .cli import main, parse_args
from .constants import WATCH_DEBOUNCE_MS
from .markdown import extract_title_and_summary, normalize_markdown_doc
from .models import ProjectBuildResult
from .watching import collect_watch_roots, is_relevant_watch_path, watch_and_build

__all__ = [
    "ProjectBuildResult",
    "WATCH_DEBOUNCE_MS",
    "build",
    "clean",
    "collect_watch_roots",
    "extract_title_and_summary",
    "is_relevant_watch_path",
    "main",
    "normalize_markdown_doc",
    "parse_args",
    "serve",
    "stage_project",
    "watch_and_build",
]