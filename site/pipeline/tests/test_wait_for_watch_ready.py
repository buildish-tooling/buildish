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

"""Tests for the Makefile helper that waits for watch readiness events."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "wait_for_watch_ready.py"


class WaitForWatchReadyTest(unittest.TestCase):
    def run_helper(self, events_file: Path, pid: int, timeout: float = 1.0) -> subprocess.CompletedProcess[str]:
        return subprocess.run(  # noqa: S603 - fixed local script invocation owned by this test
            [sys.executable, str(SCRIPT_PATH), "--events-file", str(events_file), "--pid", str(pid), "--timeout", str(timeout)],
            text=True,
            capture_output=True,
            check=False,
        )

    def spawn_sleeping_python(self, seconds: float) -> subprocess.Popen[str]:
        return subprocess.Popen(  # noqa: S603 - fixed local Python test helper with an absolute interpreter path
            [sys.executable, "-c", f"import time; time.sleep({seconds!r})"]
        )

    def test_succeeds_after_ready_event(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            events_file = Path(temp_dir) / "events.jsonl"
            process = self.spawn_sleeping_python(5.0)
            writer = threading.Thread(target=lambda: (time.sleep(0.1), events_file.write_text(json.dumps({"event": "ready"}) + "\n", encoding="utf-8")))
            writer.start()
            try:
                result = self.run_helper(events_file, process.pid, timeout=1.0)
            finally:
                process.terminate()
                process.wait(timeout=5)
                writer.join(timeout=1.0)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_ignores_malformed_lines_before_ready(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            events_file = Path(temp_dir) / "events.jsonl"
            process = self.spawn_sleeping_python(5.0)

            def _write_events() -> None:
                time.sleep(0.1)
                with events_file.open("w", encoding="utf-8") as handle:
                    handle.write("not-json\n")
                    handle.write(json.dumps({"event": "ready"}) + "\n")

            writer = threading.Thread(target=_write_events)
            writer.start()
            try:
                result = self.run_helper(events_file, process.pid, timeout=1.0)
            finally:
                process.terminate()
                process.wait(timeout=5)
                writer.join(timeout=1.0)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_fails_when_watch_exits_before_ready(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            events_file = Path(temp_dir) / "events.jsonl"
            process = self.spawn_sleeping_python(0.1)
            try:
                result = self.run_helper(events_file, process.pid, timeout=1.0)
            finally:
                process.wait(timeout=5)
        self.assertEqual(1, result.returncode)
        self.assertIn("exited before emitting a ready event", result.stderr)

    def test_fails_immediately_for_unusable_cycle_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            events_file = Path(temp_dir) / "events.jsonl"
            process = self.spawn_sleeping_python(5.0)
            events_file.write_text(json.dumps({"event": "cycle-failed", "stageUsable": False}) + "\n", encoding="utf-8")
            try:
                result = self.run_helper(events_file, process.pid, timeout=1.0)
            finally:
                process.terminate()
                process.wait(timeout=5)
        self.assertEqual(1, result.returncode)
        self.assertIn("unusable stage", result.stderr)


if __name__ == "__main__":
    unittest.main()
