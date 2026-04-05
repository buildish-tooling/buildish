#!/usr/bin/env python3
#
# Copyright 2026 The Apache Software Foundation
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Wait for the unstable `site-pipeline watch` ready event in a JSONL file."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path


def _pid_is_running(pid: int) -> bool:
    proc_stat = Path(f"/proc/{pid}/stat")
    try:
        state = proc_stat.read_text(encoding="utf-8").split()[2]
    except FileNotFoundError:
        return False
    except OSError:
        pass
    else:
        if state == "Z":
            return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _iter_new_lines(handle, *, remainder: str) -> tuple[list[str], str]:
    chunk = handle.read()
    if not chunk:
        return [], remainder
    buffered = remainder + chunk
    lines = buffered.splitlines(keepends=True)
    if lines and not lines[-1].endswith(("\n", "\r")):
        return [line.rstrip("\r\n") for line in lines[:-1]], lines[-1]
    return [line.rstrip("\r\n") for line in lines], ""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--events-file", required=True)
    parser.add_argument("--pid", required=True, type=int)
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args()

    events_path = Path(args.events_file)
    deadline = time.monotonic() + args.timeout
    position = 0
    remainder = ""
    while time.monotonic() < deadline:
        if events_path.exists():
            with events_path.open("r", encoding="utf-8") as handle:
                handle.seek(position)
                lines, remainder = _iter_new_lines(handle, remainder=remainder)
                position = handle.tell()
            for line in lines:
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("event") == "ready":
                    return 0
                if event.get("event") == "cycle-failed" and event.get("stageUsable") is False:
                    print("site-pipeline watch reported an unusable stage before becoming ready.", file=sys.stderr)
                    return 1
        if not _pid_is_running(args.pid):
            print("site-pipeline watch exited before emitting a ready event.", file=sys.stderr)
            return 1
        time.sleep(0.05)
    print(f"Timed out after {args.timeout:.1f}s waiting for site-pipeline watch to emit ready.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
