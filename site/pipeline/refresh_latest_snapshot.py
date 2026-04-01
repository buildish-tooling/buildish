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

"""Refresh the Buildish consumer to the latest sibling wheel snapshot."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import subprocess
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

PACKAGE_NAME = "apache-buildish-site-pipeline"
SOURCE_LINE_RE = re.compile(r"(?m)^apache-buildish-site-pipeline = \{.*\}$")


@dataclass(frozen=True)
class SnapshotRefreshResult:
    """Describe one local snapshot refresh attempt."""

    changed: bool
    wheel_path: Path
    relative_wheel_path: str


def refresh_consumer_snapshot(
    consumer_root: Path,
    *,
    manifest_path: Path | None = None,
    lock: bool = False,
    uv_executable: str = "uv",
) -> SnapshotRefreshResult:
    """Refresh ``consumer_root`` to the latest sibling snapshot wheel."""

    consumer_root = consumer_root.resolve()
    pyproject_path = consumer_root / "pyproject.toml"
    snapshot_root = _snapshot_root_from(consumer_root)
    manifest_path = (snapshot_root / "latest.json") if manifest_path is None else manifest_path.resolve()

    with _consumer_refresh_lock(consumer_root):
        wheel_path = _load_latest_wheel_path(manifest_path, snapshot_root)
        relative_wheel_path = os.path.relpath(wheel_path, consumer_root)
        changed = _rewrite_consumer_source(pyproject_path, relative_wheel_path)
        if changed and lock:
            _run_uv_lock(consumer_root, uv_executable)
        return SnapshotRefreshResult(
            changed=changed,
            wheel_path=wheel_path,
            relative_wheel_path=relative_wheel_path,
        )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse command-line arguments."""

    parser = argparse.ArgumentParser(
        description="Refresh site/pipeline to the latest sibling wheel snapshot."
    )
    parser.add_argument(
        "--consumer-root",
        default=str(Path(__file__).resolve().parent),
        help="Consumer project root containing pyproject.toml and uv.lock.",
    )
    parser.add_argument(
        "--manifest",
        help="Path to the sibling latest.json manifest. Defaults to the standard sibling snapshot location.",
    )
    parser.add_argument(
        "--lock",
        action="store_true",
        help="Run 'uv lock --project <consumer-root>' when the snapshot path changes.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Refresh the local consumer snapshot and report the result."""

    args = parse_args(argv)
    result = refresh_consumer_snapshot(
        Path(args.consumer_root),
        manifest_path=None if args.manifest is None else Path(args.manifest),
        lock=args.lock,
    )
    action = "Updated" if result.changed else "Already using"
    print(f"{action} latest snapshot wheel: {result.relative_wheel_path}")
    return 0


def _snapshot_root_from(consumer_root: Path) -> Path:
    repo_root = consumer_root.parents[1]
    return repo_root.parent / "buildish-site-pipeline" / "dist" / "snapshots"


def _load_latest_wheel_path(manifest_path: Path, snapshot_root: Path) -> Path:
    if not manifest_path.is_file():
        raise FileNotFoundError(
            f"Snapshot manifest not found: {manifest_path}. Run 'make -C ../buildish-site-pipeline publish-snapshot-local'."
        )
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    if payload.get("package") != PACKAGE_NAME:
        raise ValueError(f"Unexpected snapshot package in {manifest_path}: {payload.get('package')!r}")
    wheel_path_value = payload.get("wheelPath")
    if wheel_path_value is None:
        wheel_name = payload.get("wheel")
        if not isinstance(wheel_name, str) or not wheel_name:
            raise ValueError(f"Snapshot manifest is missing 'wheelPath' and 'wheel': {manifest_path}")
        wheel_path = manifest_path.parent / wheel_name
    else:
        wheel_path = Path(wheel_path_value)
        if not wheel_path.is_absolute():
            wheel_path = manifest_path.parent / wheel_path
    wheel_path = wheel_path.resolve()
    snapshot_root = snapshot_root.resolve()
    if not wheel_path.is_file():
        raise FileNotFoundError(f"Snapshot wheel not found: {wheel_path}")
    if wheel_path.suffix != ".whl":
        raise ValueError(f"Snapshot wheel must be a .whl file: {wheel_path}")
    if not wheel_path.is_relative_to(snapshot_root):
        raise ValueError(
            f"Snapshot wheel must stay within {snapshot_root}, got {wheel_path}"
        )
    return wheel_path


def _rewrite_consumer_source(pyproject_path: Path, relative_wheel_path: str) -> bool:
    current_text = pyproject_path.read_text(encoding="utf-8")
    replacement = f'{PACKAGE_NAME} = {{ path = "{relative_wheel_path}" }}'
    updated_text, replacements = SOURCE_LINE_RE.subn(replacement, current_text, count=1)
    if replacements != 1:
        raise ValueError(
            f"Expected exactly one {PACKAGE_NAME!r} source entry in {pyproject_path}"
        )
    if updated_text == current_text:
        return False
    _write_text_atomic(pyproject_path, updated_text)
    return True


def _run_uv_lock(consumer_root: Path, uv_executable: str) -> None:
    subprocess.run(  # noqa: S603 - fixed local tool invocation
        [uv_executable, "lock", "--project", str(consumer_root)],
        cwd=consumer_root.parent,
        check=True,
    )


@contextmanager
def _consumer_refresh_lock(consumer_root: Path) -> Iterator[None]:
    # Keep a stable on-disk lock path. Removing it after unlock would be racy:
    # another process may already be waiting on the old inode while a third
    # process recreates the pathname and acquires a separate lock.
    lock_path = consumer_root / ".refresh-latest-snapshot.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("w", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _write_text_atomic(path: Path, content: str) -> None:
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    temp_path.replace(path)


if __name__ == "__main__":
    raise SystemExit(main())