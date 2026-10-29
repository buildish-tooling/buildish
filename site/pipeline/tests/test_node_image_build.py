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

import hashlib
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from test_support import SOURCE_REPO_ROOT


class NodeImageBuildTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "buildish"
        (self.root / "site/make").mkdir(parents=True)
        shutil.copytree(
            SOURCE_REPO_ROOT / "tools/site-build-image",
            self.root / "tools/site-build-image",
        )
        for name in ("common.mk", "container.mk"):
            shutil.copy2(
                SOURCE_REPO_ROOT / "site/make" / name, self.root / "site/make" / name
            )
        (self.root / "site/.nvmrc").write_text("24.22.2\n", encoding="utf-8")
        (self.root / "site/Makefile").write_text(
            "SHELL := /bin/bash\n.SHELLFLAGS := -eu -o pipefail -c\n"
            "include make/common.mk\ninclude make/container.mk\n",
            encoding="utf-8",
        )

    def run_command(
        self, command: list[str], **env: str
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(  # noqa: S603 - fixed local test commands and fixtures
            command,
            cwd=self.root / "site",
            env={**os.environ, **env},
            capture_output=True,
            text=True,
            check=False,
        )

    def test_both_engines_read_nvmrc_independent_of_working_directory(self) -> None:
        for engine in ("docker", "podman"):
            with self.subTest(engine=engine):
                result = self.run_command(
                    [
                        str(self.root / "tools/site-build-image/build-image.sh"),
                        "--engine",
                        engine,
                        "--image",
                        "localhost/test",
                        "--dry-run",
                    ]
                )
                self.assertEqual(0, result.returncode, result.stderr)
                self.assertIn("NODE_VERSION=24.22.2", result.stdout)

    def test_rejects_non_exact_nvmrc_version(self) -> None:
        (self.root / "site/.nvmrc").write_text("lts/*\n", encoding="utf-8")
        result = self.run_command(
            [
                str(self.root / "tools/site-build-image/build-image.sh"),
                "--engine",
                "docker",
                "--image",
                "localhost/test",
                "--dry-run",
            ]
        )
        self.assertNotEqual(0, result.returncode)
        self.assertIn("exact Node.js version", result.stderr)

    def test_node_download_checks_the_upstream_checksum_for_each_architecture(
        self,
    ) -> None:
        containerfile = (self.root / "tools/site-build-image/Containerfile").read_text(
            encoding="utf-8"
        )
        script = containerfile.split(': "Install Node.js.";')[1].split(
            ': "Install Go.";'
        )[0]
        scratch = self.root / "downloads"
        scratch.mkdir()
        script = script.replace("/tmp/", f"{scratch}/")  # noqa: S108 - redirect container paths into the isolated test directory
        bin_dir = self.root / "test-bin"
        bin_dir.mkdir()
        manifest = scratch / "manifest"
        manifest.write_text(
            "".join(
                f"{hashlib.sha256(arch.encode()).hexdigest()}  node-v24.22.2-linux-{arch}.tar.xz\n"
                for arch in ("x64", "arm64")
            ),
            encoding="utf-8",
        )
        scripts = {
            "curl": """#!/usr/bin/env bash
set -eu
if [[ "$3" = */SHASUMS256.txt ]]; then
  cp "$BUILDISH_TEST_MANIFEST" "$2"
else
  printf %s "$node_arch" > "$2"
fi
""",
            "tar": '#!/bin/sh\ntouch "$BUILDISH_TEST_EXTRACTED"\n',
        }
        for name, content in scripts.items():
            executable = bin_dir / name
            executable.write_text(content, encoding="utf-8")
            executable.chmod(0o755)
        extracted = scratch / "extracted"
        for arch, valid in (("x64", True), ("arm64", True), ("missing", False)):
            with self.subTest(arch=arch):
                extracted.unlink(missing_ok=True)
                result = self.run_command(
                    ["/bin/bash", "-eu", "-o", "pipefail", "-c", script],
                    PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                    NODE_VERSION="24.22.2",
                    node_arch=arch,
                    BUILDISH_TEST_MANIFEST=str(manifest),
                    BUILDISH_TEST_EXTRACTED=str(extracted),
                )
                self.assertEqual(valid, result.returncode == 0, result.stderr)
                self.assertEqual(valid, extracted.exists())
        manifest.write_text(
            f"{'0' * 64}  node-v24.22.2-linux-x64.tar.xz\n", encoding="utf-8"
        )
        extracted.unlink(missing_ok=True)
        result = self.run_command(
            ["/bin/bash", "-eu", "-o", "pipefail", "-c", script],
            PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            NODE_VERSION="24.22.2",
            node_arch="x64",
            BUILDISH_TEST_MANIFEST=str(manifest),
            BUILDISH_TEST_EXTRACTED=str(extracted),
        )
        self.assertNotEqual(0, result.returncode)
        self.assertFalse(extracted.exists())

    def test_make_reuses_matching_image_and_rebuilds_stale_node(self) -> None:
        bin_dir = self.root / "test-bin"
        bin_dir.mkdir()
        scripts = {
            "docker": """#!/usr/bin/env bash
set -eu
echo "$*" >> "$BUILDISH_TEST_ENGINE_LOG"
if [ "$1" = run ]; then
  while [ "$1" != -c ]; do shift; done
  shift
  exec /bin/bash -c "$@"
fi
""",
            "site-pipeline": "#!/bin/sh\necho --workspace-root\n",
            "node": '#!/bin/sh\necho "$BUILDISH_TEST_IMAGE_NODE"\n',
        }
        for name, content in scripts.items():
            executable = bin_dir / name
            executable.write_text(content, encoding="utf-8")
            executable.chmod(0o755)
        log = self.root / "engine.log"
        for version, rebuild in (("v24.22.2", False), ("v24.18.1", True)):
            with self.subTest(version=version):
                log.write_text("", encoding="utf-8")
                result = self.run_command(
                    [
                        shutil.which("make") or "/usr/bin/make",
                        "container-image-ensure",
                        "CONTAINER_ENGINE=docker",
                    ],
                    PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                    BUILDISH_TEST_ENGINE_LOG=str(log),
                    BUILDISH_TEST_IMAGE_NODE=version,
                )
                self.assertEqual(0, result.returncode, result.stdout + result.stderr)
                commands = log.read_text(encoding="utf-8")
                self.assertEqual(rebuild, "buildx build" in commands)
                if rebuild:
                    self.assertIn("NODE_VERSION=24.22.2", commands)
                    self.assertIn("--load", commands)

    def test_nvmrc_changes_trigger_image_publication(self) -> None:
        bin_dir = self.root / "test-bin"
        bin_dir.mkdir()
        git = bin_dir / "git"
        git.write_text(
            '#!/bin/sh\nif [ "$1" = diff ]; then echo site/.nvmrc; fi\n',
            encoding="utf-8",
        )
        git.chmod(0o755)
        output = self.root / "github-output"
        result = self.run_command(
            [
                "/bin/bash",
                str(SOURCE_REPO_ROOT / ".github/scripts/ci-detect-changes.sh"),
            ],
            PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            EVENT_NAME="push",
            PUSH_BEFORE_SHA="base",
            HEAD_SHA="head",
            GITHUB_OUTPUT=str(output),
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("site_build_image=true", output.read_text(encoding="utf-8"))
