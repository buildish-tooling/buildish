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

"""Tests for refreshing the consumer to the latest local wheel snapshot."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

PIPELINE_ROOT = Path(__file__).resolve().parents[1]
if str(PIPELINE_ROOT) not in sys.path:
    sys.path.insert(0, str(PIPELINE_ROOT))

import refresh_latest_snapshot


class RefreshLatestSnapshotTest(unittest.TestCase):
    def write_fixture_consumer(
        self,
        consumer_root: Path,
        *,
        source_entry: str = 'apache-buildish-site-pipeline = { path = "../../buildish-site-pipeline", editable = true }',
    ) -> None:
        consumer_root.mkdir(parents=True, exist_ok=True)
        (consumer_root / "pyproject.toml").write_text(
            "\n".join(
                [
                    "[project]",
                    'name = "apache-buildish-site-consumer"',
                    'version = "0.1.0"',
                    "",
                    "[tool.uv.sources]",
                    source_entry,
                    "",
                ]
            ),
            encoding="utf-8",
        )
        (consumer_root / "uv.lock").write_text("version = 1\n", encoding="utf-8")

    def write_manifest(
        self, snapshot_root: Path, wheel_name: str, *, wheel_path: Path | None = None
    ) -> Path:
        snapshot_root.mkdir(parents=True, exist_ok=True)
        wheel_path = (snapshot_root / wheel_name) if wheel_path is None else wheel_path
        (snapshot_root / "latest.json").write_text(
            json.dumps(
                {
                    "name": "apache-buildish-site-pipeline",
                    "version": "0.1.0.devfixture+gtest",
                    "wheel": wheel_name,
                    "wheelPath": str(wheel_path),
                }
            )
            + "\n",
            encoding="utf-8",
        )
        return snapshot_root / "latest.json"

    def test_refresh_updates_editable_source_to_latest_wheel_and_locks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            consumer_root = workspace / "buildish" / "site" / "pipeline"
            snapshot_root = workspace / "buildish-site-pipeline" / "dist" / "snapshots"
            wheel_path = (
                snapshot_root
                / "apache_buildish_site_pipeline-0.1.0.devfixture+gtest-py3-none-any.whl"
            )
            wheel_path.parent.mkdir(parents=True, exist_ok=True)
            wheel_path.write_bytes(b"fixture wheel")
            manifest_path = self.write_manifest(snapshot_root, wheel_path.name)
            self.write_fixture_consumer(consumer_root)

            with patch("refresh_latest_snapshot.subprocess.run") as run_mock:
                result = refresh_latest_snapshot.refresh_consumer_snapshot(
                    consumer_root,
                    manifest_path=manifest_path,
                    lock=True,
                )

            self.assertTrue(result.changed)
            self.assertEqual(
                "../../../buildish-site-pipeline/dist/snapshots/apache_buildish_site_pipeline-0.1.0.devfixture+gtest-py3-none-any.whl",
                result.relative_wheel_path,
            )
            pyproject_text = (consumer_root / "pyproject.toml").read_text(encoding="utf-8")
            self.assertIn(result.relative_wheel_path, pyproject_text)
            run_mock.assert_called_once_with(
                ["uv", "lock", "--project", str(consumer_root)],
                cwd=consumer_root.parent,
                check=True,
            )

    def test_refresh_skips_lock_when_consumer_already_uses_latest_wheel(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            consumer_root = workspace / "buildish" / "site" / "pipeline"
            snapshot_root = workspace / "buildish-site-pipeline" / "dist" / "snapshots"
            wheel_name = "apache_buildish_site_pipeline-0.1.0.devfixture+gtest-py3-none-any.whl"
            wheel_path = snapshot_root / wheel_name
            wheel_path.parent.mkdir(parents=True, exist_ok=True)
            wheel_path.write_bytes(b"fixture wheel")
            manifest_path = self.write_manifest(snapshot_root, wheel_name)
            self.write_fixture_consumer(
                consumer_root,
                source_entry=(
                    'apache-buildish-site-pipeline = { path = '
                    '"../../../buildish-site-pipeline/dist/snapshots/apache_buildish_site_pipeline-0.1.0.devfixture+gtest-py3-none-any.whl" }'
                ),
            )

            with patch("refresh_latest_snapshot.subprocess.run") as run_mock:
                result = refresh_latest_snapshot.refresh_consumer_snapshot(
                    consumer_root,
                    manifest_path=manifest_path,
                    lock=True,
                )

            self.assertFalse(result.changed)
            run_mock.assert_not_called()

    def test_refresh_rejects_manifest_wheel_outside_snapshot_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            consumer_root = workspace / "buildish" / "site" / "pipeline"
            snapshot_root = workspace / "buildish-site-pipeline" / "dist" / "snapshots"
            outside_wheel = workspace / "untrusted.whl"
            outside_wheel.write_bytes(b"not allowed")
            manifest_path = self.write_manifest(
                snapshot_root,
                outside_wheel.name,
                wheel_path=outside_wheel,
            )
            self.write_fixture_consumer(consumer_root)

            with self.assertRaisesRegex(ValueError, "must stay within"):
                refresh_latest_snapshot.refresh_consumer_snapshot(
                    consumer_root,
                    manifest_path=manifest_path,
                    lock=False,
                )

    def test_prepare_consumer_environment_syncs_managed_venv_when_needed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            consumer_root = workspace / "buildish" / "site" / "pipeline"
            snapshot_root = workspace / "buildish-site-pipeline" / "dist" / "snapshots"
            wheel_name = "apache_buildish_site_pipeline-0.1.0.devfixture+gtest-py3-none-any.whl"
            wheel_path = snapshot_root / wheel_name
            wheel_path.parent.mkdir(parents=True, exist_ok=True)
            wheel_path.write_bytes(b"fixture wheel")
            manifest_path = self.write_manifest(snapshot_root, wheel_name)
            self.write_fixture_consumer(consumer_root)
            venv_path = consumer_root / ".venv"

            with patch("refresh_latest_snapshot.subprocess.run") as run_mock:
                result = refresh_latest_snapshot.prepare_consumer_environment(
                    consumer_root,
                    manifest_path=manifest_path,
                    lock=True,
                    sync=True,
                    venv_path=venv_path,
                )

            self.assertTrue(result.snapshot.changed)
            self.assertTrue(result.synced)
            self.assertEqual(venv_path.resolve(), result.venv_path)
            self.assertTrue(
                (venv_path / ".buildish-site-pipeline-sync-stamp").exists()
            )
            self.assertEqual(2, run_mock.call_count)
            self.assertEqual(
                ["uv", "lock", "--project", str(consumer_root)],
                run_mock.call_args_list[0].args[0],
            )
            self.assertEqual(
                ["uv", "sync", "--project", str(consumer_root), "--frozen"],
                run_mock.call_args_list[1].args[0],
            )
            self.assertEqual(str(venv_path.resolve()), run_mock.call_args_list[1].kwargs["env"]["UV_PROJECT_ENVIRONMENT"])

    def test_prepare_consumer_environment_skips_sync_when_stamp_is_current(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            consumer_root = workspace / "buildish" / "site" / "pipeline"
            snapshot_root = workspace / "buildish-site-pipeline" / "dist" / "snapshots"
            wheel_name = "apache_buildish_site_pipeline-0.1.0.devfixture+gtest-py3-none-any.whl"
            wheel_path = snapshot_root / wheel_name
            wheel_path.parent.mkdir(parents=True, exist_ok=True)
            wheel_path.write_bytes(b"fixture wheel")
            manifest_path = self.write_manifest(snapshot_root, wheel_name)
            self.write_fixture_consumer(
                consumer_root,
                source_entry=(
                    'apache-buildish-site-pipeline = { path = '
                    '"../../../buildish-site-pipeline/dist/snapshots/apache_buildish_site_pipeline-0.1.0.devfixture+gtest-py3-none-any.whl" }'
                ),
            )
            venv_path = consumer_root / ".venv"
            bin_dir = venv_path / "bin"
            bin_dir.mkdir(parents=True, exist_ok=True)
            (bin_dir / "python").write_text("", encoding="utf-8")
            (bin_dir / "site-pipeline").write_text("", encoding="utf-8")
            stamp_path = venv_path / ".buildish-site-pipeline-sync-stamp"
            stamp_path.write_text("synced\n", encoding="utf-8")
            future = stamp_path.stat().st_mtime + 5
            os.utime(stamp_path, (future, future))

            with patch("refresh_latest_snapshot.subprocess.run") as run_mock:
                result = refresh_latest_snapshot.prepare_consumer_environment(
                    consumer_root,
                    manifest_path=manifest_path,
                    lock=True,
                    sync=True,
                    venv_path=venv_path,
                )

            self.assertFalse(result.snapshot.changed)
            self.assertFalse(result.synced)
            run_mock.assert_not_called()

    def test_run_consumer_command_execs_using_managed_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            consumer_root = workspace / "buildish" / "site" / "pipeline"
            workspace_root = workspace / "workspace"
            catalog_path = workspace_root / "buildish" / "site" / "catalog.yaml"
            snapshot_root = workspace / "buildish-site-pipeline" / "dist" / "snapshots"
            wheel_name = "apache_buildish_site_pipeline-0.1.0.devfixture+gtest-py3-none-any.whl"
            wheel_path = snapshot_root / wheel_name
            wheel_path.parent.mkdir(parents=True, exist_ok=True)
            wheel_path.write_bytes(b"fixture wheel")
            manifest_path = self.write_manifest(snapshot_root, wheel_name)
            self.write_fixture_consumer(
                consumer_root,
                source_entry=(
                    'apache-buildish-site-pipeline = { path = '
                    '"../../../buildish-site-pipeline/dist/snapshots/apache_buildish_site_pipeline-0.1.0.devfixture+gtest-py3-none-any.whl" }'
                ),
            )
            venv_path = consumer_root / ".venv"
            bin_dir = venv_path / "bin"
            bin_dir.mkdir(parents=True, exist_ok=True)
            python_path = bin_dir / "python"
            python_path.write_text("", encoding="utf-8")
            python_path.chmod(0o755)
            site_pipeline_path = bin_dir / "site-pipeline"
            site_pipeline_path.write_text("", encoding="utf-8")
            site_pipeline_path.chmod(0o755)
            stamp_path = venv_path / ".buildish-site-pipeline-sync-stamp"
            stamp_path.write_text("synced\n", encoding="utf-8")
            future = stamp_path.stat().st_mtime + 5
            os.utime(stamp_path, (future, future))
            command = [
                "site-pipeline",
                "build",
                "--workspace-root",
                str(workspace_root),
                "--catalog",
                str(catalog_path),
            ]

            with (
                patch("refresh_latest_snapshot.subprocess.run") as run_mock,
                patch("refresh_latest_snapshot.os.execve", side_effect=RuntimeError("exec-called")) as exec_mock,
            ):
                with self.assertRaisesRegex(RuntimeError, "exec-called"):
                    refresh_latest_snapshot.run_consumer_command(
                        consumer_root,
                        command,
                        manifest_path=manifest_path,
                        lock=True,
                        sync=True,
                        venv_path=venv_path,
                    )

            run_mock.assert_not_called()
            exec_args = exec_mock.call_args.args
            self.assertEqual(str(site_pipeline_path), exec_args[0])
            self.assertEqual(command, exec_args[1])
            self.assertTrue(exec_args[2]["PATH"].startswith(f"{bin_dir}:"))
            self.assertEqual(str(venv_path.resolve()), exec_args[2]["VIRTUAL_ENV"])


if __name__ == "__main__":
    unittest.main()
