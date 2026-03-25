# Copyright 2026 The Buildish Authors
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
import shutil
import subprocess
import tempfile
from collections.abc import Sequence
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TextIO

PACKAGE_NAME = "buildish-site-pipeline"
SOURCE_LINE_RE = re.compile(r"(?m)^buildish-site-pipeline = \{.*\}$")
ACTIVE_CONSUMER_ROOT_ENV = "BUILDISH_SITE_PIPELINE_CONSUMER_ROOT"
ACTIVE_VENV_PATH_ENV = "BUILDISH_SITE_PIPELINE_VENV"
ACTIVE_ENV_READY_ENV = "BUILDISH_SITE_PIPELINE_ENV_READY"

# Variables passed through verbatim from the caller's environment.
# Intentionally minimal: CI secrets that happen to be in the environment must
# not be inherited by the site-pipeline process or its children.
_ENV_PASSTHROUGH_EXACT: frozenset[str] = frozenset({
    "HOME",
    "LANG",
    "PATH",
    "SHELL",
    "TERM",
    "TMPDIR",
    "TEMP",
    "TMP",
    # TLS certificate overrides (needed in corporate / proxied environments).
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    # Network proxy — both conventional casings.
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
})
# Variable name prefixes whose values are passed through verbatim.
_ENV_PASSTHROUGH_PREFIXES: tuple[str, ...] = (
    "BUILDISH_",  # state variables set and consumed by this script
    "LC_",        # locale category overrides
    "PYTHON",     # Python runtime settings (PYTHONPATH, PYTHONDONTWRITEBYTECODE, …)
    "UV_",        # uv configuration (UV_CACHE_DIR, UV_INDEX_URL, …)
    "XDG_",       # XDG base directory spec used by uv and other tools
)


@dataclass(frozen=True)
class SnapshotRefreshResult:
    """Describe one local snapshot refresh attempt."""

    changed: bool
    wheel_path: Path
    relative_wheel_path: str


@dataclass(frozen=True)
class ConsumerEnvironmentResult:
    """Describe one managed consumer-environment preparation attempt."""

    snapshot: SnapshotRefreshResult
    synced: bool
    venv_path: Path


def refresh_consumer_snapshot(
    consumer_root: Path,
    *,
    manifest_path: Path | None = None,
    lock: bool = False,
    uv_executable: str = "uv",
) -> SnapshotRefreshResult:
    """Refresh ``consumer_root`` to the latest sibling snapshot wheel."""

    consumer_root = consumer_root.resolve()
    with _consumer_environment_lock(consumer_root, exclusive=True):
        return _refresh_consumer_snapshot_locked(
            consumer_root,
            manifest_path=manifest_path,
            lock=lock,
            uv_executable=uv_executable,
        )


def prepare_consumer_environment(
    consumer_root: Path,
    *,
    manifest_path: Path | None = None,
    lock: bool = False,
    sync: bool = False,
    uv_executable: str = "uv",
    venv_path: Path | None = None,
) -> ConsumerEnvironmentResult:
    """Refresh the consumer snapshot and optionally sync its dedicated venv."""

    consumer_root = consumer_root.resolve()
    resolved_venv_path = _resolve_venv_path(consumer_root, venv_path)

    with _consumer_environment_lock(consumer_root, exclusive=True):
        snapshot = _refresh_consumer_snapshot_locked(
            consumer_root,
            manifest_path=manifest_path,
            lock=lock,
            uv_executable=uv_executable,
        )
        synced = False
        if sync:
            synced = _sync_consumer_environment_if_needed(
                consumer_root,
                resolved_venv_path,
                uv_executable,
            )
        return ConsumerEnvironmentResult(
            snapshot=snapshot,
            synced=synced,
            venv_path=resolved_venv_path,
        )


def run_consumer_command(
    consumer_root: Path,
    command: Sequence[str],
    *,
    manifest_path: Path | None = None,
    lock: bool = False,
    sync: bool = False,
    uv_executable: str = "uv",
    venv_path: Path | None = None,
) -> int:
    """Prepare the managed environment and replace the process with ``command``."""

    consumer_root = consumer_root.resolve()
    resolved_venv_path = _resolve_venv_path(consumer_root, venv_path)
    if not command:
        raise ValueError("command must not be empty")

    if _active_consumer_environment_matches(consumer_root, resolved_venv_path):
        env = _managed_environment_vars(resolved_venv_path, consumer_root)
        _exec_managed_command(command, env)

    with _consumer_environment_lock(consumer_root, exclusive=True) as handle:
        _refresh_consumer_snapshot_locked(
            consumer_root,
            manifest_path=manifest_path,
            lock=lock,
            uv_executable=uv_executable,
        )
        if sync:
            _sync_consumer_environment_if_needed(
                consumer_root,
                resolved_venv_path,
                uv_executable,
            )

        fcntl.flock(handle.fileno(), fcntl.LOCK_SH)
        os.set_inheritable(handle.fileno(), True)

        env = _managed_environment_vars(resolved_venv_path, consumer_root)
        _exec_managed_command(command, env)
    raise AssertionError("_exec_managed_command returned unexpectedly")


def _refresh_consumer_snapshot_locked(
    consumer_root: Path,
    *,
    manifest_path: Path | None,
    lock: bool,
    uv_executable: str,
) -> SnapshotRefreshResult:
    """Refresh ``consumer_root`` while the caller holds the environment lock."""

    pyproject_path = consumer_root / "pyproject.toml"
    snapshot_root = _snapshot_root_from(consumer_root)
    manifest_path = (snapshot_root / "latest.json") if manifest_path is None else manifest_path.resolve()
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
    parser.add_argument(
        "--sync",
        action="store_true",
        help="Run 'uv sync --project <consumer-root> --frozen' into the managed venv when needed.",
    )
    parser.add_argument(
        "--venv-path",
        help="Managed virtual-environment path. Defaults to <consumer-root>/.venv.",
    )
    parser.add_argument(
        "--uv-executable",
        default="uv",
        help="Executable name or path to use for uv invocations.",
    )
    parser.add_argument(
        "command",
        nargs=argparse.REMAINDER,
        help="Optional command to exec after preparing the environment. Separate it with '--'.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Refresh the local consumer snapshot and report the result."""

    args = parse_args(argv)
    consumer_root = Path(args.consumer_root)
    manifest_path = None if args.manifest is None else Path(args.manifest)
    venv_path = None if args.venv_path is None else Path(args.venv_path)
    command = list(args.command)
    if command and command[0] == "--":
        command = command[1:]
    if command:
        return run_consumer_command(
            consumer_root,
            command,
            manifest_path=manifest_path,
            lock=args.lock,
            sync=args.sync,
            uv_executable=args.uv_executable,
            venv_path=venv_path,
        )

    result = prepare_consumer_environment(
        consumer_root,
        manifest_path=manifest_path,
        lock=args.lock,
        sync=args.sync,
        uv_executable=args.uv_executable,
        venv_path=venv_path,
    )
    action = "Updated" if result.snapshot.changed else "Already using"
    print(f"{action} latest snapshot wheel: {result.snapshot.relative_wheel_path}")
    if args.sync:
        sync_action = "Synced" if result.synced else "Using existing"
        print(f"{sync_action} managed environment: {result.venv_path}")
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
    package_name = payload.get("name")
    if package_name != PACKAGE_NAME:
        raise ValueError(
            f"Unexpected snapshot package in {manifest_path}: {package_name!r}"
        )
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
def _consumer_environment_lock(
    consumer_root: Path, *, exclusive: bool
) -> Iterator[TextIO]:
    # Keep a stable on-disk lock path. Removing it after unlock would be racy:
    # another process may already be waiting on the old inode while a third
    # process recreates the pathname and acquires a separate lock.
    lock_path = consumer_root / ".consumer-environment.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("w", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
        try:
            yield handle
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _sync_consumer_environment_if_needed(
    consumer_root: Path,
    venv_path: Path,
    uv_executable: str,
) -> bool:
    if not _consumer_environment_needs_sync(consumer_root, venv_path):
        return False

    env = _filtered_environment()
    env["UV_PROJECT_ENVIRONMENT"] = str(venv_path)
    subprocess.run(  # noqa: S603 - fixed local tool invocation
        [uv_executable, "sync", "--project", str(consumer_root), "--frozen"],
        cwd=consumer_root.parent,
        check=True,
        env=env,
    )
    sync_stamp = _sync_stamp_path(venv_path)
    sync_stamp.parent.mkdir(parents=True, exist_ok=True)
    sync_stamp.touch()
    return True


def _consumer_environment_needs_sync(consumer_root: Path, venv_path: Path) -> bool:
    sync_stamp = _sync_stamp_path(venv_path)
    required_paths = [
        _venv_bin_dir(venv_path) / "python",
        _venv_bin_dir(venv_path) / "site-pipeline",
        consumer_root / "uv.lock",
        consumer_root / "pyproject.toml",
    ]
    if any(not path.exists() for path in required_paths):
        return True
    if not sync_stamp.exists():
        return True
    stamp_mtime = sync_stamp.stat().st_mtime_ns
    return any(path.stat().st_mtime_ns > stamp_mtime for path in required_paths[2:])


def _resolve_venv_path(consumer_root: Path, venv_path: Path | None) -> Path:
    return (consumer_root / ".venv" if venv_path is None else venv_path).resolve()


def _venv_bin_dir(venv_path: Path) -> Path:
    return venv_path / "bin"


def _sync_stamp_path(venv_path: Path) -> Path:
    return venv_path / ".buildish-site-pipeline-sync-stamp"


def _exec_managed_command(command: Sequence[str], env: dict[str, str]) -> None:
    """Resolve ``command`` within the managed environment and replace the process.

    Resolve the executable against the curated managed ``PATH`` first so the final
    exec call does not depend on the caller's ambient shell lookup behavior.
    """

    resolved_executable = shutil.which(command[0], path=env.get("PATH"))
    if resolved_executable is None:
        raise FileNotFoundError(f"Command not found in managed PATH: {command[0]}")
    os.execve(resolved_executable, list(command), env)  # noqa: S606 - resolved absolute executable path within the managed allowlisted environment
    raise AssertionError("os.execve returned unexpectedly")


def _active_consumer_environment_matches(consumer_root: Path, venv_path: Path) -> bool:
    if os.environ.get(ACTIVE_ENV_READY_ENV) != "1":
        return False
    active_consumer_root = os.environ.get(ACTIVE_CONSUMER_ROOT_ENV)
    active_venv_path = os.environ.get(ACTIVE_VENV_PATH_ENV)
    if active_consumer_root is None or active_venv_path is None:
        return False
    return Path(active_consumer_root).resolve() == consumer_root and Path(active_venv_path).resolve() == venv_path


def _filtered_environment() -> dict[str, str]:
    """Return a minimal copy of the caller environment needed by the pipeline.

    Builds from an explicit allowlist rather than ``os.environ.copy()`` so that
    CI secrets that happen to be present in the runner environment are not
    inherited by the site-pipeline process or any subprocess it spawns.
    """
    result: dict[str, str] = {}
    for key, value in os.environ.items():
        if key in _ENV_PASSTHROUGH_EXACT or key.startswith(_ENV_PASSTHROUGH_PREFIXES):
            result[key] = value
    return result


def _managed_environment_vars(venv_path: Path, consumer_root: Path) -> dict[str, str]:
    env = _filtered_environment()
    venv_bin = str(_venv_bin_dir(venv_path))
    path_entries = env.get("PATH", "").split(":") if env.get("PATH") else []
    if not path_entries or path_entries[0] != venv_bin:
        env["PATH"] = ":".join([venv_bin, *path_entries]) if path_entries else venv_bin
    env["VIRTUAL_ENV"] = str(venv_path)
    env["UV_PROJECT_ENVIRONMENT"] = str(venv_path)
    env[ACTIVE_CONSUMER_ROOT_ENV] = str(consumer_root)
    env[ACTIVE_VENV_PATH_ENV] = str(venv_path)
    env[ACTIVE_ENV_READY_ENV] = "1"
    return env


def _write_text_atomic(path: Path, content: str) -> None:
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    temp_path.replace(path)


if __name__ == "__main__":
    raise SystemExit(main())
