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

from pathlib import Path
import unittest

from test_support import SOURCE_REPO_ROOT


class SiteBuildImageContainerfileTests(unittest.TestCase):
    def test_containerfile_uses_a_single_structured_run_step(self) -> None:
        containerfile_text = (
            SOURCE_REPO_ROOT / "tools" / "site-build-image" / "Containerfile"
        ).read_text(encoding="utf-8")

        self.assertEqual(1, containerfile_text.count("RUN set -eux;"))
        self.assertNotIn("AS uvbin", containerfile_text)
        self.assertNotIn("COPY --from=uvbin /uv /uvx /usr/local/bin/", containerfile_text)
        self.assertNotIn(
            "RUN apt-get update \\\n    && apt-get install -y --no-install-recommends curl git make xz-utils \\\n    && rm -rf /var/lib/apt/lists/*",
            containerfile_text,
        )

    def test_containerfile_keeps_the_expected_build_sections(self) -> None:
        containerfile_text = (
            SOURCE_REPO_ROOT / "tools" / "site-build-image" / "Containerfile"
        ).read_text(encoding="utf-8")

        self.assertIn("USER root", containerfile_text)
        self.assertIn("USER site-pipeline", containerfile_text)
        self.assertIn(
            ': "Install base OS packages required by the derived site builder.";',
            containerfile_text,
        )
        self.assertIn(
            ': "Resolve architecture-specific download targets and checksums.";',
            containerfile_text,
        )
        self.assertIn(': "Install Node.js.";', containerfile_text)
        self.assertIn(': "Install Go.";', containerfile_text)
        self.assertIn(': "Install Hugo.";', containerfile_text)
        self.assertIn(': "Verify the derived site builder toolchain.";', containerfile_text)


if __name__ == "__main__":
    unittest.main()
