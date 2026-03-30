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

"""Command-line interface for the site pipeline package."""

from __future__ import annotations

import argparse

from .builder import build, clean, serve
from .constants import WATCH_DEBOUNCE_MS
from .watching import watch_and_build


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse command-line arguments for the site pipeline helper."""

    parser = argparse.ArgumentParser(description="Site pipeline helper")
    parser.add_argument("command", choices=["build", "clean", "serve", "watch"], nargs="?", default="build")
    parser.add_argument("--port", type=int, default=8000, help="Port for the local preview server")
    parser.add_argument("--debounce-ms", type=int, default=WATCH_DEBOUNCE_MS, help="Debounce window for watch mode")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Run the requested site pipeline command and return a process exit code."""

    args = parse_args(argv)
    if args.command == "build":
        results = build()
        print(f"Built {len(results)} component(s) into site/.stage and site/.preview")
        return 0
    if args.command == "clean":
        clean()
        print("Removed site/.stage and site/.preview")
        return 0
    if args.command == "watch":
        watch_and_build(debounce_ms=args.debounce_ms)
        return 0
    serve(port=args.port)
    return 0