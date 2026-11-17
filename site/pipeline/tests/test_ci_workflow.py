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


class ReleasedDocsWorkflowTests(unittest.TestCase):
    def test_shared_build_checks_out_docs_and_uses_publication_profile(self) -> None:
        action = yaml.safe_load(
            (SOURCE_REPO_ROOT / ".github/actions/build-site/action.yml").read_text()
        )
        steps = action["runs"]["steps"]
        for component in ("mammoth-cache", "release-tooling"):
            with self.subTest(component=component):
                checkouts = [
                    step
                    for step in steps
                    if step.get("with", {}).get("ref") == "versioned-docs"
                    and step["with"].get("repository") == f"buildish-tooling/buildish-{component}"
                ]
                self.assertEqual(1, len(checkouts))
                checkout = checkouts[0]
                self.assertEqual(f"buildish-{component}/docs/releases", checkout["with"]["path"])
                self.assertFalse(checkout["with"]["persist-credentials"])
                self.assertFalse(checkout.get("continue-on-error", False))
        for native, check_target, build_target in (
            ("inputs.native == 'true'", "site-check-local", "build-local"),
            ("inputs.native != 'true'", "site-check", "build"),
        ):
            commands = "\n".join(step.get("run", "") for step in steps if step.get("if") == native)
            self.assertIn("SITE_PIPELINE_PROFILE=publication", commands)
            self.assertIn(check_target, commands)
            self.assertIn(build_target, commands)
