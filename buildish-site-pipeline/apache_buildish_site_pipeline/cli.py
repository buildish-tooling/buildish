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

from .builder import build, clean, preview
from .constants import WATCH_DEBOUNCE_MS
from .watching import watch_and_build


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse command-line arguments for the site pipeline helper."""

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--repo-root", help="Repository root to build from (defaults to this checkout)"
    )
    common.add_argument(
        "--config", help="Config file path relative to the repository root"
    )
    common.add_argument(
        "--catalog", help="Component catalog path relative to the repository root"
    )
    common.add_argument(
        "--authored-site-content",
        help="Authored site content path relative to the repository root",
    )
    common.add_argument(
        "--stage-path",
        help="Stage output path relative to the repository root",
    )
    common.add_argument(
        "--preview-path",
        help="Preview output path relative to the repository root",
    )
    common.add_argument("--site-title", help="Override the effective site title")
    common.add_argument(
        "--project-status",
        choices=["incubating", "graduated", "retired"],
        help="Override the effective project status",
    )

    parser = argparse.ArgumentParser(
        description=(
            "Site pipeline helper for staged content generation and a deliberately "
            "minimal preview; consumers still need their own real renderer."
        ),
        parents=[common],
    )
    subparsers = parser.add_subparsers(dest="command")

    build_parser = subparsers.add_parser("build", parents=[common])
    clean_parser = subparsers.add_parser("clean", parents=[common])
    preview_parser = subparsers.add_parser(
        "preview",
        parents=[common],
        help="Serve the deliberately barebones preview tree, not a real rendered site",
        description=(
            "Build and serve the deliberately barebones preview tree with Python's "
            "standard HTTP server. This is far away from a real rendered website and "
            "exists only as a lightweight staging/debug convenience."
        ),
    )
    watch_parser = subparsers.add_parser("watch", parents=[common])

    preview_parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Port for the deliberately barebones preview server",
    )
    watch_parser.add_argument(
        "--debounce-ms",
        type=int,
        default=WATCH_DEBOUNCE_MS,
        help="Debounce window for watch mode",
    )
    build_parser.set_defaults(command="build")
    clean_parser.set_defaults(command="clean")
    preview_parser.set_defaults(command="preview")
    watch_parser.set_defaults(command="watch")
    args = parser.parse_args(argv)
    if args.command is None:
        args.command = "build"
        args.port = 8000
        args.debounce_ms = WATCH_DEBOUNCE_MS
    return args


def main(argv: list[str] | None = None) -> int:
    """Run the requested site pipeline command and return a process exit code."""

    args = parse_args(argv)
    if args.command == "build":
        results = build(
            repo_root=args.repo_root,
            config_path=args.config,
            catalog_path=args.catalog,
            authored_site_content_path=args.authored_site_content,
            stage_path=args.stage_path,
            preview_path=args.preview_path,
            site_title=args.site_title,
            project_status=args.project_status,
        )
        print(f"Built {len(results)} component(s)")
        return 0
    if args.command == "clean":
        clean(
            repo_root=args.repo_root,
            config_path=args.config,
            authored_site_content_path=args.authored_site_content,
            stage_path=args.stage_path,
            preview_path=args.preview_path,
        )
        print("Removed generated outputs")
        return 0
    if args.command == "watch":
        watch_and_build(
            repo_root=args.repo_root,
            debounce_ms=args.debounce_ms,
            config_path=args.config,
            catalog_path=args.catalog,
            authored_site_content_path=args.authored_site_content,
            stage_path=args.stage_path,
            preview_path=args.preview_path,
            site_title=args.site_title,
            project_status=args.project_status,
        )
        return 0
    preview(
        repo_root=args.repo_root,
        port=args.port,
        config_path=args.config,
        catalog_path=args.catalog,
        authored_site_content_path=args.authored_site_content,
        stage_path=args.stage_path,
        preview_path=args.preview_path,
        site_title=args.site_title,
        project_status=args.project_status,
    )
    return 0
