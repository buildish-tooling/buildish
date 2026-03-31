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

"""Shared constants used throughout the site pipeline package.

This module keeps the small, global knobs in one place so the higher-level
modules can focus on behavior instead of configuration details.
"""

from __future__ import annotations

from pathlib import Path

DEFAULT_TAG_PATTERN = r"^v[0-9]+\.[0-9]+\.[0-9]+$"
SITE_TITLE = "Apache Project Site"
WATCH_DEBOUNCE_MS = 300
WATCH_STEP_MS = 50
WATCH_IGNORE_PATH_PARTS = {
    ".container-home",
    ".git",
    ".preview",
    ".public",
    ".stage",
    "__pycache__",
}
WATCH_IGNORE_SUFFIXES = (".swp", ".swx", "~", ".tmp")
STAGED_VENDOR_ASSETS = (
    (
        Path("node_modules/jquery/dist/jquery.min.js"),
        Path("static/js/vendor/jquery.min.js"),
    ),
    (
        Path("node_modules/mermaid/dist/mermaid.min.js"),
        Path("static/js/vendor/mermaid.min.js"),
    ),
    (Path("node_modules/lunr/lunr.min.js"), Path("static/js/vendor/lunr.min.js")),
)
