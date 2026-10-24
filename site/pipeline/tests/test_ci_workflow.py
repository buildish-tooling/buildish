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

import os
import shutil
import subprocess
import unittest

import yaml

from test_support import SOURCE_REPO_ROOT


class RequiredChecksTests(unittest.TestCase):
    def run_gate(
        self, *, site_changes: bool, native_result: str
    ) -> subprocess.CompletedProcess[str]:
        workflow = yaml.safe_load(
            (SOURCE_REPO_ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        )
        step = workflow["jobs"]["required_checks"]["steps"][0]
        env = os.environ.copy()
        env.update(dict.fromkeys(step["env"], "success"))
        env["SITE_VERIFY_REQUIRED"] = str(site_changes).lower()
        env["SITE_BUILD_NATIVE_RESULT"] = native_result
        bash = shutil.which("bash")
        if bash is None:
            self.skipTest("bash is required to exercise the CI gate")
        return subprocess.run(  # noqa: S603 - execute the checked-in CI gate with fixed test inputs
            [bash, "-eu", "-o", "pipefail", "-c", step["run"]],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_site_changes_require_successful_native_build(self) -> None:
        for result in ("skipped", "failure", "cancelled"):
            with self.subTest(result=result):
                self.assertNotEqual(
                    0, self.run_gate(site_changes=True, native_result=result).returncode
                )

    def test_successful_native_build_passes(self) -> None:
        result = self.run_gate(site_changes=True, native_result="success")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_unrelated_changes_allow_skipped_native_build(self) -> None:
        result = self.run_gate(site_changes=False, native_result="skipped")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
