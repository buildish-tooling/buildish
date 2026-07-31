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

"""Integration tests for the Make targets that wrap the site pipeline."""

from __future__ import annotations

import os
import re
import shutil
import signal
import subprocess
import sys
import time
import unittest
from pathlib import Path
from typing import TextIO

from test_support import (
    SOURCE_REPO_ROOT,
    TestCaseHelpers,
    seed_make_fixture_main_repo,
    seed_mammoth_fixture,
    seed_no_wrapper_fixture,
    text_block,
)

EXTRACTED_PIPELINE_REPO_ROOT = (SOURCE_REPO_ROOT.parent / "buildish-site-pipeline").resolve()
EXTRACTED_PIPELINE_PYTHON = (
    EXTRACTED_PIPELINE_REPO_ROOT / ".venv" / "bin" / "python"
)
DEFAULT_FIXTURE_ROOT = (
    SOURCE_REPO_ROOT / "site" / "build" / "tests" / f"integration-make-targets-{os.getpid()}"
)
CONTAINERIZED_SERVE_READY_TIMEOUT = 60.0


class MakeTargetIntegrationTest(TestCaseHelpers, unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = DEFAULT_FIXTURE_ROOT / self._testMethodName
        shutil.rmtree(self.workspace, ignore_errors=True)
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.processes: list[subprocess.Popen[str]] = []
        self.process_logs: dict[int, tuple[Path, TextIO]] = {}

    def tearDown(self) -> None:
        for process in self.processes:
            self.stop_process(process)
        shutil.rmtree(self.workspace, ignore_errors=True)

    def prepare_fixture_workspace(self) -> Path:
        repo_root = self.workspace / "buildish"
        repo_root.mkdir()
        self.seed_main_repo(repo_root)
        self.seed_mammoth_fixture(self.workspace / "buildish-mammoth-cache")
        self.seed_no_wrapper_fixture(self.workspace / "buildish-no-gradle-wrapper-jar")
        return repo_root

    def seed_main_repo(self, repo_root: Path) -> None:
        seed_make_fixture_main_repo(repo_root)

    @staticmethod
    def seed_mammoth_fixture(repo_root: Path) -> None:
        seed_mammoth_fixture(
            repo_root,
            landing_page=text_block(
                """
                # Mammoth Cache for Gradle® and Apache Maven™

                Fixture component landing page.

                {{< buildish-component-link kind="source" label="Browse source" appearance="outline-secondary" >}}

                {{< buildish-component-releases heading="Current release lines" >}}
                """
            ),
            docs_index=text_block(
                """
                # Overview

                Initial fixture docs overview.
                """
            ),
            getting_started=text_block(
                """
                # Getting started

                Initial fixture text.
                """
            ),
        )

    @staticmethod
    def seed_no_wrapper_fixture(repo_root: Path) -> None:
        seed_no_wrapper_fixture(
            repo_root,
            landing_page=text_block(
                """
                # No Wrapper JAR

                Fixture component landing page.
                """
            ),
            docs_index=text_block(
                """
                # No Wrapper JAR

                Fixture docs overview.
                """
            ),
        )

    def write_executable(self, path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        path.chmod(0o755)

    def seed_fake_tools(
        self,
        site_root: Path,
        *,
        include_engine: bool = False,
        include_hugo: bool = False,
        include_native_docsy: bool = False,
    ) -> Path:
        bin_dir = site_root / "build" / "test-bin"
        self.write_executable(
            bin_dir / "node",
            text_block(
                r"""
                #!/usr/bin/env sh
                exit 0
                """
            ),
        )
        self.write_executable(
            bin_dir / "npm",
            text_block(
                r"""
                #!/usr/bin/env sh
                set -eu
                args="$*"
                if [ -n "${BUILDISH_FAKE_NPM_LOG:-}" ]; then
                  mkdir -p "$(dirname "$BUILDISH_FAKE_NPM_LOG")"
                  printf '%s\n' "$args" >> "$BUILDISH_FAKE_NPM_LOG"
                fi
                prefix=.
                while [ "$#" -gt 0 ]; do
                  if [ "$1" = "--prefix" ]; then
                    prefix="$2"
                    shift 2
                    continue
                  fi
                  shift
                done
                root="$prefix/node_modules"
                mkdir -p \
                  "$root/.bin" \
                  "$root/@fortawesome/fontawesome-free/scss" \
                  "$root/autoprefixer" \
                  "$root/bootstrap/scss" \
                  "$root/jquery/dist" \
                  "$root/mermaid/dist" \
                  "$root/lunr"
                printf '// fake asset\n' > "$root/@fortawesome/fontawesome-free/scss/fontawesome.scss"
                printf 'module.exports = {}\n' > "$root/autoprefixer/index.js"
                printf '// fake asset\n' > "$root/bootstrap/scss/bootstrap.scss"
                printf '#!/usr/bin/env sh\nset -eu\nif [ -n "${NODE_PATH:-}" ] && [ -f "${NODE_PATH}/autoprefixer/index.js" ]; then\n  exit 0\nfi\nif [ -f "$PWD/node_modules/autoprefixer/index.js" ]; then\n  exit 0\nfi\necho "autoprefixer is not resolvable" >&2\nexit 1\n' > "$root/.bin/postcss"
                chmod 755 "$root/.bin/postcss"
                printf '// fake asset\n' > "$root/jquery/dist/jquery.min.js"
                printf '// fake asset\n' > "$root/mermaid/dist/mermaid.min.js"
                printf '// fake asset\n' > "$root/lunr/lunr.min.js"
                echo 'fake npm ci completed'
                """
            ),
        )
        self.write_executable(
            bin_dir / "site-pipeline",
            text_block(
                f"""
                #!/usr/bin/env python3
                import os
                import sys

                env = os.environ.copy()
                env["PYTHONPATH"] = {str(EXTRACTED_PIPELINE_REPO_ROOT / "src")!r}
                os.execve(
                    {str(EXTRACTED_PIPELINE_PYTHON)!r},
                    [
                        {str(EXTRACTED_PIPELINE_PYTHON)!r},
                        "-m",
                        "buildish_site_pipeline",
                        *sys.argv[1:],
                    ],
                    env,
                )
                """
            ),
        )
        if include_hugo:
            self.write_executable(
                bin_dir / "hugo",
                text_block(
                    r"""
                    #!/usr/bin/env python3
                    from pathlib import Path
                    import os, signal, subprocess, sys, time

                    log_path = Path(os.environ['BUILDISH_FAKE_HUGO_LOG'])
                    log_path.parent.mkdir(parents=True, exist_ok=True)
                    with log_path.open('a', encoding='utf-8') as handle:
                        handle.write(' '.join(sys.argv[1:]) + '\n')

                    if 'server' in sys.argv[1:]:
                        if os.environ.get('BUILDISH_FAKE_HUGO_TOUCH_GENERATED_RESOURCES_ON_SERVER_START') == '1':
                            generated_root = Path('resources/_gen/assets/scss')
                            generated_root.mkdir(parents=True, exist_ok=True)
                            Path(generated_root, 'main.scss_fake.content').write_text('generated\n', encoding='utf-8')
                            Path(generated_root, 'main.scss_fake.json').write_text('{}\n', encoding='utf-8')
                        Path(os.environ['BUILDISH_FAKE_HUGO_READY']).write_text('ready\n', encoding='utf-8')
                        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
                        signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
                        while True:
                            time.sleep(0.1)

                    destination = '.public'
                    if '--destination' in sys.argv[1:]:
                        destination = sys.argv[sys.argv.index('--destination') + 1]
                    Path(destination).mkdir(parents=True, exist_ok=True)
                    Path(destination, 'index.html').write_text('<html>fake hugo</html>\n', encoding='utf-8')

                    if os.environ.get('BUILDISH_FAKE_HUGO_REQUIRE_POSTCSS_NPX') == '1':
                        subprocess.run(['npx', '--no-install', '--', 'postcss', '--help'], check=True)
                    """
                ),
            )
        if include_engine:
            self.write_executable(
                bin_dir / "fake-container-engine",
                text_block(
                    r"""
                    #!/usr/bin/env python3
                    from pathlib import Path
                    import os, signal, subprocess, sys

                    args = sys.argv[1:]
                    log = Path(os.environ['BUILDISH_FAKE_CONTAINER_LOG'])
                    log.parent.mkdir(parents=True, exist_ok=True)
                    state_dir = Path(os.environ['BUILDISH_FAKE_CONTAINER_STATE_DIR'])
                    state_dir.mkdir(parents=True, exist_ok=True)
                    with log.open('a', encoding='utf-8') as handle:
                        handle.write(' '.join(args) + '\n')

                    if not args:
                        sys.exit(1)
                    if args[:2] == ['image', 'inspect'] or args[0] == 'build':
                        sys.exit(0)
                    if args[0] == 'stop':
                        name = args[-1]
                        pidfile = state_dir / f'{name}.pid'
                        if pidfile.exists():
                            stop_signal_name = os.environ.get('BUILDISH_FAKE_CONTAINER_STOP_SIGNAL', 'SIGTERM')
                            stop_signal = getattr(signal, stop_signal_name)
                            try:
                                os.killpg(int(pidfile.read_text(encoding='utf-8')), stop_signal)
                            except ProcessLookupError:
                                pass
                        sys.exit(0)
                    if args[0] == 'rm':
                        name = args[-1]
                        pidfile = state_dir / f'{name}.pid'
                        pidfile.unlink(missing_ok=True)
                        sys.exit(0)
                    if args[0] != 'run':
                        sys.exit(0)

                    env = os.environ.copy()
                    i = 1
                    image = None
                    command = None
                    workdir = None
                    volume_map = {}
                    name = None
                    while i < len(args):
                        arg = args[i]
                        if arg == '-e':
                            key, value = args[i + 1].split('=', 1)
                            env[key] = value
                            i += 2
                            continue
                        if arg == '-v':
                            spec = args[i + 1]
                            parts = spec.split(':')
                            volume_map[parts[1]] = parts[0]
                            i += 2
                            continue
                        if arg == '-w':
                            workdir = args[i + 1]
                            i += 2
                            continue
                        if arg == '--name':
                            name = args[i + 1]
                            i += 2
                            continue
                        if arg in {'-p', '--platform', '--user'}:
                            i += 2
                            continue
                        if arg == '--rm' or arg == '--init' or arg.startswith('--userns='):
                            i += 1
                            continue
                        image = arg
                        command = args[i + 1 :]
                        break

                    if command is None:
                        sys.exit(1)

                    if image is not None and 'buildish-site-pipeline' in image:
                        command = ['site-pipeline', *command]

                    def translate_container_path(path_value: str) -> str:
                        for container_root, host_root in volume_map.items():
                            if path_value == container_root or path_value.startswith(container_root + '/'):
                                suffix = path_value[len(container_root) :].lstrip('/')
                                return str(Path(host_root) / suffix)
                        return path_value

                    cwd = os.environ.get('BUILDISH_FAKE_CONTAINER_CWD', os.getcwd())
                    if workdir is not None:
                        cwd = translate_container_path(workdir)

                    for key, value in list(env.items()):
                        env[key] = translate_container_path(value)

                    proc = subprocess.Popen(command, cwd=cwd, env=env, start_new_session=True)
                    if name is not None:
                        (state_dir / f'{name}.pid').write_text(str(proc.pid), encoding='utf-8')

                    def forward(signum, _frame):
                        try:
                            os.killpg(proc.pid, signum)
                        except ProcessLookupError:
                            pass

                    signal.signal(signal.SIGINT, forward)
                    signal.signal(signal.SIGTERM, forward)
                    returncode = proc.wait()
                    if name is not None:
                        (state_dir / f'{name}.pid').unlink(missing_ok=True)
                    sys.exit(returncode)
                    """
                ),
            )
        if include_native_docsy:
            node_modules = site_root / "node_modules"
            self.write_executable(
                node_modules / ".bin" / "postcss",
                text_block(
                    r"""
                    #!/usr/bin/env sh
                    exit 0
                    """
                ),
            )
            for rel in (
                "@fortawesome/fontawesome-free/scss/fontawesome.scss",
                "bootstrap/scss/bootstrap.scss",
                "jquery/dist/jquery.min.js",
                "mermaid/dist/mermaid.min.js",
                "lunr/lunr.min.js",
            ):
                target = node_modules / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("// fake asset\n", encoding="utf-8")
        return bin_dir

    def local_env(self, _site_root: Path) -> dict[str, str]:
        env = os.environ.copy()
        env["SITE_PIPELINE_REPO_ROOT"] = str(EXTRACTED_PIPELINE_REPO_ROOT)
        env["SITE_PIPELINE_PYTHON"] = str(EXTRACTED_PIPELINE_PYTHON)
        return env

    def base_env(self, site_root: Path, bin_dir: Path) -> dict[str, str]:
        env = self.local_env(site_root)
        env["PATH"] = f"{bin_dir}:{env.get('PATH', '')}"
        env["NVM_DIR"] = str(site_root / "build" / "fake-nvm")
        env["BUILDISH_FAKE_HUGO_LOG"] = str(site_root / "build" / "fake-hugo.log")
        env["BUILDISH_FAKE_HUGO_READY"] = str(site_root / "build" / "fake-hugo.ready")
        env["BUILDISH_FAKE_NPM_LOG"] = str(site_root / "build" / "fake-npm.log")
        env["BUILDISH_FAKE_CONTAINER_LOG"] = str(site_root / "build" / "fake-container.log")
        env["BUILDISH_FAKE_CONTAINER_STATE_DIR"] = str(site_root / "build" / "fake-container-state")
        env["BUILDISH_FAKE_CONTAINER_CWD"] = str(site_root)
        return env

    def build_watch_event_files(self, site_root: Path) -> list[Path]:
        return sorted((site_root / "build").glob(".watch-events.*.jsonl"))

    def root_watch_event_files(self, site_root: Path) -> list[Path]:
        return sorted(site_root.glob(".watch-events.*.jsonl"))

    def run_make(self, site_root: Path, target: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(  # noqa: S603,S607
            ["make", target],  # noqa: S607
            cwd=site_root,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

    def start_make(self, site_root: Path, target: str, env: dict[str, str]) -> subprocess.Popen[str]:
        log_dir = self.workspace / "process-logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / f"{target}-{len(self.processes)}.log"
        log_handle = log_path.open("w+", encoding="utf-8")
        process = subprocess.Popen(  # noqa: S603,S607
            ["make", target],  # noqa: S607
            cwd=site_root,
            env=env,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        self.processes.append(process)
        self.process_logs[process.pid] = (log_path, log_handle)
        return process

    def read_process_output(self, process: subprocess.Popen[str]) -> str:
        log_info = self.process_logs.get(process.pid)
        if log_info is None:
            return ""
        log_path, log_handle = log_info
        log_handle.flush()
        return log_path.read_text(encoding="utf-8")

    def stop_process(self, process: subprocess.Popen[str]) -> str:
        if process in self.processes:
            self.processes.remove(process)
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=10)
        output = self.read_process_output(process)
        log_info = self.process_logs.pop(process.pid, None)
        if log_info is not None:
            _, log_handle = log_info
            log_handle.close()
        return output

    def wait_for(self, description: str, predicate, timeout: float = 20.0, process: subprocess.Popen[str] | None = None) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate():
                return
            if process is not None and process.poll() is not None:
                self.fail(
                    f"Process exited while waiting for {description} (returncode={process.returncode})\n"
                    f"{self.read_process_output(process)}"
                )
            time.sleep(0.1)
        details = ""
        if process is not None:
            details = f"\n{self.read_process_output(process)}"
        self.fail(f"Timed out waiting for {description}{details}")

    def file_contains(self, path: Path, snippet: str) -> bool:
        try:
            return path.exists() and snippet in path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return False

    @staticmethod
    def mammoth_page_path(repo_root: Path) -> Path:
        return (
            repo_root
            / "site"
            / ".stage"
            / "content"
            / "components"
            / "mammoth-cache"
            / "_index.md"
        )

    def test_make_stage_local_builds_fixture_workspace(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        bin_dir = self.seed_fake_tools(repo_root / "site", include_native_docsy=True)
        result = self.run_make(repo_root / "site", "stage-local", self.base_env(repo_root / "site", bin_dir))
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assert_paths_exist(
            repo_root / "site" / ".stage" / "manifest.json",
            repo_root / "site" / ".stage" / "data" / "components.json",
            repo_root / "site" / ".stage" / "data" / "content-index.json",
            self.mammoth_page_path(repo_root),
            repo_root / "site" / ".stage" / "static" / "components" / "mammoth-cache" / "assets" / "images" / "diagram.svg",
        )
        self.assertFalse((repo_root / "site" / ".stage" / "content" / "components" / "mammoth-cache" / "latest").exists())

    def test_make_pipeline_component_source_roots_local_emits_effective_roots(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        stage_marker = repo_root / "site" / ".stage" / "keep.txt"
        stage_marker.parent.mkdir(parents=True, exist_ok=True)
        stage_marker.write_text("keep\n", encoding="utf-8")

        result = self.run_make(
            repo_root / "site",
            "pipeline-component-source-roots-local",
            self.local_env(repo_root / "site"),
        )

        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual(
            [
                "buildish-mammoth-cache",
                "buildish-no-gradle-wrapper-jar",
                "buildish-site-pipeline",
                "buildish",
            ],
            result.stdout.splitlines(),
            result.stdout + result.stderr,
        )
        self.assertEqual("", result.stderr)
        self.assertTrue(stage_marker.exists())

    def test_make_stage_local_uses_extracted_checkout_instead_of_consumer_snapshot(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        bin_dir = self.seed_fake_tools(repo_root / "site", include_native_docsy=True)
        consumer_pyproject = repo_root / "site" / "pipeline" / "pyproject.toml"
        stale_wheel = "buildish_site_pipeline-0.0.0.dev0+stale-py3-none-any.whl"
        updated_text, replacements = re.subn(
            r'buildish_site_pipeline-[^"]+\.whl',
            stale_wheel,
            consumer_pyproject.read_text(encoding="utf-8"),
            count=1,
        )
        self.assertEqual(1, replacements)
        consumer_pyproject.write_text(
            updated_text,
            encoding="utf-8",
        )
        snapshots_root = repo_root.parent / "buildish-site-pipeline" / "dist" / "snapshots"
        shutil.rmtree(snapshots_root, ignore_errors=True)

        result = self.run_make(repo_root / "site", "stage-local", self.base_env(repo_root / "site", bin_dir))

        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn(stale_wheel, consumer_pyproject.read_text(encoding="utf-8"))
        self.assert_paths_exist(repo_root / "site" / ".stage" / "manifest.json", self.mammoth_page_path(repo_root))

    def test_make_build_local_runs_hugo_against_the_current_stage_with_fake_tools(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        bin_dir = self.seed_fake_tools(repo_root / "site", include_hugo=True, include_native_docsy=True)
        env = self.base_env(repo_root / "site", bin_dir)
        result = self.run_make(repo_root / "site", "build-local", env)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assert_paths_exist(
            repo_root / "site" / ".stage" / "manifest.json",
            self.mammoth_page_path(repo_root),
            repo_root / "site" / ".public" / "index.html",
            repo_root / "site" / ".stage" / "static" / "components" / "mammoth-cache" / "assets" / "images" / "diagram.svg",
            repo_root / "site" / "static" / "js" / "vendor" / "mermaid.min.js",
        )
        hugo_log = self.read_text(Path(env["BUILDISH_FAKE_HUGO_LOG"]))
        self.assert_contains_all(hugo_log, "--source .", "--config hugo.yaml")

    def test_repo_root_make_build_local_delegates_to_site_makefile(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        bin_dir = self.seed_fake_tools(repo_root / "site", include_hugo=True, include_native_docsy=True)
        env = self.base_env(repo_root / "site", bin_dir)

        result = self.run_make(repo_root, "build-local", env)

        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assert_paths_exist(
            repo_root / "site" / ".stage" / "manifest.json",
            self.mammoth_page_path(repo_root),
            repo_root / "site" / ".public" / "index.html",
        )
        self.assert_contains_all(self.read_text(Path(env["BUILDISH_FAKE_HUGO_LOG"])), "--source .", "--config hugo.yaml")

    def test_repo_root_make_build_delegates_to_site_makefile(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        bin_dir = self.seed_fake_tools(repo_root / "site", include_engine=True, include_hugo=True)
        env = self.base_env(repo_root / "site", bin_dir)
        env["CONTAINER_ENGINE"] = "fake-container-engine"
        env["CONTAINER_IMAGE"] = "fake/buildish-site:local"
        env["CONTAINER_HOME"] = str(repo_root / "site" / "build" / "fake-container-home")
        env["CONTAINER_SCRATCH_ROOT"] = str(repo_root / "site" / "build" / "container")

        result = self.run_make(repo_root, "build", env)

        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assert_paths_exist(
            repo_root / "site" / ".stage" / "manifest.json",
            repo_root / "site" / ".public" / "index.html",
        )
        self.assert_contains_all(self.read_text(repo_root / "site" / "build" / "fake-container.log"), "run", "--init")

    def test_make_stage_uses_containerized_path_and_stages_vendor_assets(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        bin_dir = self.seed_fake_tools(repo_root / "site", include_engine=True)
        env = self.base_env(repo_root / "site", bin_dir)
        env["CONTAINER_ENGINE"] = "fake-container-engine"
        env["CONTAINER_IMAGE"] = "fake/buildish-site:local"
        env["CONTAINER_HOME"] = str(repo_root / "site" / "build" / "fake-container-home")
        env["CONTAINER_SCRATCH_ROOT"] = str(repo_root / "site" / "build" / "container")
        result = self.run_make(repo_root / "site", "stage", env)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assert_paths_exist(
            repo_root / "site" / ".stage" / "manifest.json",
            self.mammoth_page_path(repo_root),
            repo_root / "site" / ".stage" / "static" / "components" / "mammoth-cache" / "assets" / "images" / "diagram.svg",
            repo_root / "site" / "static" / "js" / "vendor" / "mermaid.min.js",
        )
        components_payload = self.load_json(repo_root / "site" / ".stage" / "data" / "components.json")
        slugs = {item["slug"] for item in components_payload["items"]}
        self.assertIn("mammoth-cache", slugs)
        container_log = self.read_text(repo_root / "site" / "build" / "fake-container.log")
        self.assert_contains_all(
            container_log,
            "run",
            "--init",
            "/workspace/buildish/site",
            f"HOME={env['CONTAINER_HOME']}",
        )

    def test_make_build_uses_containerized_path_and_exposes_postcss_to_hugo_via_npx(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        bin_dir = self.seed_fake_tools(repo_root / "site", include_engine=True, include_hugo=True)
        env = self.base_env(repo_root / "site", bin_dir)
        env["CONTAINER_ENGINE"] = "fake-container-engine"
        env["CONTAINER_IMAGE"] = "fake/buildish-site:local"
        env["CONTAINER_HOME"] = str(repo_root / "site" / "build" / "fake-container-home")
        env["CONTAINER_SCRATCH_ROOT"] = str(repo_root / "site" / "build" / "container")
        env["BUILDISH_FAKE_HUGO_REQUIRE_POSTCSS_NPX"] = "1"
        result = self.run_make(repo_root / "site", "build", env)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assert_paths_exist(repo_root / "site" / ".stage" / "manifest.json", repo_root / "site" / ".public" / "index.html")
        self.assert_contains_all(self.read_text(Path(env["BUILDISH_FAKE_HUGO_LOG"])), "--source .", "--config hugo.yaml")

    def test_make_build_reuses_cached_container_node_dependencies_when_inputs_are_unchanged(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        bin_dir = self.seed_fake_tools(repo_root / "site", include_engine=True, include_hugo=True)
        env = self.base_env(repo_root / "site", bin_dir)
        env["CONTAINER_ENGINE"] = "fake-container-engine"
        env["CONTAINER_IMAGE"] = "fake/buildish-site:local"
        env["CONTAINER_HOME"] = str(repo_root / "site" / "build" / "fake-container-home")
        env["CONTAINER_SCRATCH_ROOT"] = str(repo_root / "site" / "build" / "container")

        first_result = self.run_make(repo_root / "site", "build", env)
        second_result = self.run_make(repo_root / "site", "build", env)

        self.assertEqual(0, first_result.returncode, first_result.stdout + first_result.stderr)
        self.assertEqual(0, second_result.returncode, second_result.stdout + second_result.stderr)
        npm_invocations = Path(env["BUILDISH_FAKE_NPM_LOG"]).read_text(encoding="utf-8").splitlines()
        self.assertEqual(1, len(npm_invocations), npm_invocations)
        self.assertIn("reusing cached Node dependencies", second_result.stdout)

    def test_make_build_reinstalls_cached_container_node_dependencies_after_lockfile_change(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        bin_dir = self.seed_fake_tools(repo_root / "site", include_engine=True, include_hugo=True)
        env = self.base_env(repo_root / "site", bin_dir)
        env["CONTAINER_ENGINE"] = "fake-container-engine"
        env["CONTAINER_IMAGE"] = "fake/buildish-site:local"
        env["CONTAINER_HOME"] = str(repo_root / "site" / "build" / "fake-container-home")
        env["CONTAINER_SCRATCH_ROOT"] = str(repo_root / "site" / "build" / "container")

        first_result = self.run_make(repo_root / "site", "build", env)
        self.assertEqual(0, first_result.returncode, first_result.stdout + first_result.stderr)

        package_lock = repo_root / "site" / "package-lock.json"
        package_lock.write_text(package_lock.read_text(encoding="utf-8") + "\n", encoding="utf-8")

        second_result = self.run_make(repo_root / "site", "build", env)

        self.assertEqual(0, second_result.returncode, second_result.stdout + second_result.stderr)
        npm_invocations = Path(env["BUILDISH_FAKE_NPM_LOG"]).read_text(encoding="utf-8").splitlines()
        self.assertEqual(2, len(npm_invocations), npm_invocations)
        self.assertIn("syncing Node dependencies", second_result.stdout)

    def test_make_build_reinstalls_cached_container_node_dependencies_after_hugo_workspace_change(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        bin_dir = self.seed_fake_tools(repo_root / "site", include_engine=True, include_hugo=True)
        env = self.base_env(repo_root / "site", bin_dir)
        env["CONTAINER_ENGINE"] = "fake-container-engine"
        env["CONTAINER_IMAGE"] = "fake/buildish-site:local"
        env["CONTAINER_HOME"] = str(repo_root / "site" / "build" / "fake-container-home")
        env["CONTAINER_SCRATCH_ROOT"] = str(repo_root / "site" / "build" / "container")

        first_result = self.run_make(repo_root / "site", "build", env)
        self.assertEqual(0, first_result.returncode, first_result.stdout + first_result.stderr)

        workspace_package = repo_root / "site" / "packages" / "hugoautogen" / "package.json"
        workspace_package.write_text(workspace_package.read_text(encoding="utf-8") + "\n", encoding="utf-8")

        second_result = self.run_make(repo_root / "site", "build", env)

        self.assertEqual(0, second_result.returncode, second_result.stdout + second_result.stderr)
        npm_invocations = Path(env["BUILDISH_FAKE_NPM_LOG"]).read_text(encoding="utf-8").splitlines()
        self.assertEqual(2, len(npm_invocations), npm_invocations)
        self.assertIn("syncing Node dependencies", second_result.stdout)

    def test_make_render_uses_containerized_path(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        bin_dir = self.seed_fake_tools(repo_root / "site", include_engine=True, include_hugo=True)
        env = self.base_env(repo_root / "site", bin_dir)
        env["CONTAINER_ENGINE"] = "fake-container-engine"
        env["CONTAINER_IMAGE"] = "fake/buildish-site:local"
        env["CONTAINER_HOME"] = str(repo_root / "site" / "build" / "fake-container-home")
        env["CONTAINER_SCRATCH_ROOT"] = str(repo_root / "site" / "build" / "container")
        result = self.run_make(repo_root / "site", "render", env)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assert_contains_all(self.read_text(Path(env["BUILDISH_FAKE_HUGO_LOG"])), "--source .", "--config hugo.yaml")
        self.assert_contains_all(self.read_text(repo_root / "site" / "build" / "fake-container.log"), "run", "--init")

    def test_make_stage_uses_component_source_roots_for_container_mounts(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        bin_dir = self.seed_fake_tools(repo_root / "site", include_engine=True)
        self.write_executable(
            bin_dir / "python3",
            text_block(
                f"""
                #!/usr/bin/env sh
                if [ "${{1:-}}" = "-c" ]; then
                  echo "unexpected direct host python3 -c invocation" >&2
                  exit 97
                fi
                exec {sys.executable} "$@"
                """
            ),
        )
        env = self.base_env(repo_root / "site", bin_dir)
        env["CONTAINER_ENGINE"] = "fake-container-engine"
        env["CONTAINER_IMAGE"] = "fake/buildish-site:local"
        env["CONTAINER_HOME"] = str(repo_root / "site" / "build" / "fake-container-home")
        env["CONTAINER_SCRATCH_ROOT"] = str(repo_root / "site" / "build" / "container")

        result = self.run_make(repo_root / "site", "stage", env)

        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        container_log = self.read_text(repo_root / "site" / "build" / "fake-container.log")
        self.assert_contains_all(
            container_log,
            "localhost/buildish-site-pipeline:local component-source-roots",
            f"{repo_root.parent / 'buildish-mammoth-cache'}:/workspace/buildish-mammoth-cache:ro",
            f"{repo_root.parent / 'buildish-no-gradle-wrapper-jar'}:/workspace/buildish-no-gradle-wrapper-jar:ro",
        )
        self.assertNotIn(
            f"{repo_root / 'site'}:/workspace/buildish/site:ro",
            container_log,
            container_log,
        )
        self.assertNotIn("unexpected direct host python3 -c invocation", result.stdout + result.stderr)

    def test_make_help_curates_public_targets(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        result = self.run_make(repo_root / "site", "help", os.environ.copy())
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assert_contains_all(
            result.stdout,
            "Common workflows:",
            "Checks and cleanup:",
            "Host-tool workflows:",
            "Less common workflows:",
            "serve              Serve the full Hugo site with automatic restaging in the build container; override PORT=<port> if needed.",
            "build              Build the staged contract and full Hugo site in the build container.",
            "test               Run unit tests.",
            "integration-test   Run integration tests.",
            "check              Run lint, type checks, tests, and build-local.",
            "clean              Remove generated pipeline and renderer output.",
            "serve-local        Serve the full Hugo site with automatic restaging using host tools; override PORT=<port> if needed.",
            "build-local        Build the staged contract and full Hugo site with host tools.",
            "render             Render the current staged site through Hugo in the build container.",
            "render-local       Render the current staged site through Hugo with host tools.",
            "stage-local        Build the staged site contract and lightweight preview with host tools.",
            "stage-watch-local  Watch sources and rebuild the staged site contract only with host tools.",
            "For advanced/internal targets, run 'make help-all'.",
        )
        self.assert_not_contains_any(result.stdout, "container-serve", "hugo-check", "docsy-check", "vendor-assets", "container-build")

    def test_repo_root_make_help_curates_repo_entrypoints(self) -> None:
        repo_root = self.prepare_fixture_workspace()

        result = self.run_make(repo_root, "help", os.environ.copy())

        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assert_contains_all(
            result.stdout,
            "Repository maintenance:",
            "Containerized site workflows:",
            "Local site workflows:",
            "Site-specific help:",
            "rat-check          Run Apache RAT against tracked files in this repository (requires Java 21+).",
            "check              Run the non-container site check gate from the repository root.",
            "build-local        Build the staged contract and full Hugo site with host tools.",
            "build              Build the staged contract and full Hugo site in the containerized site environment.",
            "serve              Serve the full Hugo site with automatic restaging in the containerized site environment.",
            "serve-local        Serve the full Hugo site with automatic restaging using host tools.",
            "site-help          Show curated site-specific Make targets from site/Makefile.",
        )
        self.assert_not_contains_any(result.stdout, "container-build", "pipeline-lint", "vendor-assets")

    def test_make_stage_watch_local_restages_component_pages_after_source_change(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        source_page = self.workspace / "buildish-mammoth-cache" / "site" / "pages" / "_index.md"
        staged_page = self.mammoth_page_path(repo_root)
        process = self.start_make(repo_root / "site", "stage-watch-local", self.local_env(repo_root / "site"))
        self.wait_for("initial stage-watch build", staged_page.exists, process=process)
        source_page.write_text(
            text_block(
                """
                # Mammoth Cache for Gradle® and Apache Maven™

                Updated by stage-watch-local.
                """
            ),
            encoding="utf-8",
        )
        self.wait_for(
            "restaged component page after stage-watch-local change",
            lambda: self.file_contains(staged_page, "Updated by stage-watch-local."),
            process=process,
        )
        self.stop_process(process)

    def test_make_stage_watch_rebuilds_component_pages_after_source_change_in_containerized_mode(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        bin_dir = self.seed_fake_tools(repo_root / "site", include_engine=True)
        env = self.base_env(repo_root / "site", bin_dir)
        env["CONTAINER_ENGINE"] = "fake-container-engine"
        env["CONTAINER_IMAGE"] = "fake/buildish-site:local"
        env["CONTAINER_HOME"] = str(repo_root / "site" / "build" / "fake-container-home")
        env["CONTAINER_SCRATCH_ROOT"] = str(repo_root / "site" / "build" / "container")
        source_page = self.workspace / "buildish-mammoth-cache" / "site" / "pages" / "_index.md"
        staged_page = self.mammoth_page_path(repo_root)
        process = self.start_make(repo_root / "site", "stage-watch", env)
        self.wait_for("initial containerized stage-watch build", staged_page.exists, process=process)
        time.sleep(1.0)
        source_page.write_text(
            text_block(
                """
                # Mammoth Cache for Gradle® and Apache Maven™

                Updated by containerized stage-watch.
                """
            ),
            encoding="utf-8",
        )
        self.wait_for(
            "restaged component page after containerized stage-watch change",
            lambda: self.file_contains(staged_page, "Updated by containerized stage-watch."),
            timeout=CONTAINERIZED_SERVE_READY_TIMEOUT,
            process=process,
        )
        self.stop_process(process)
        self.assertIn("run", self.read_text(repo_root / "site" / "build" / "fake-container.log"))

    def test_make_serve_local_starts_hugo_with_local_bind_and_restages_component_changes(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        site_root = repo_root / "site"
        bin_dir = self.seed_fake_tools(repo_root / "site", include_hugo=True, include_native_docsy=True)
        env = self.base_env(repo_root / "site", bin_dir)
        env["PORT"] = "8766"
        env["BUILDISH_FAKE_HUGO_TOUCH_GENERATED_RESOURCES_ON_SERVER_START"] = "1"
        source_page = self.workspace / "buildish-mammoth-cache" / "site" / "pages" / "_index.md"
        staged_page = self.mammoth_page_path(repo_root)
        generated_resource = repo_root / "site" / "resources" / "_gen" / "assets" / "scss" / "main.scss_fake.content"
        process = self.start_make(site_root, "serve-local", env)
        self.wait_for("fake local Hugo server readiness", lambda: Path(env["BUILDISH_FAKE_HUGO_READY"]).exists(), process=process)
        self.wait_for("initial serve-local stage", staged_page.exists, process=process)
        self.wait_for("fake generated resources", generated_resource.exists, process=process)
        self.wait_for(
            "serve-local vendor assets",
            lambda: (site_root / "static" / "js" / "vendor" / "mermaid.min.js").exists(),
            process=process,
        )
        self.wait_for(
            "serve-local watch event file under build/",
            lambda: bool(self.build_watch_event_files(site_root)),
            process=process,
        )
        self.assertEqual([], self.root_watch_event_files(site_root))
        time.sleep(0.5)
        self.assertNotIn("watch cycle 2", self.read_process_output(process), self.read_process_output(process))
        source_page.write_text(
            text_block(
                """
                # Mammoth Cache for Gradle® and Apache Maven™

                Updated by serve-local.
                """
            ),
            encoding="utf-8",
        )
        self.wait_for(
            "restaged component page after serve-local change",
            lambda: self.file_contains(staged_page, "Updated by serve-local."),
            process=process,
        )
        hugo_log = self.read_text(Path(env["BUILDISH_FAKE_HUGO_LOG"]))
        self.assert_contains_all(hugo_log, "server", "--bind 127.0.0.1", "--port 8766")
        self.stop_process(process)
        self.assertEqual([], self.build_watch_event_files(site_root))
        self.assertEqual([], self.root_watch_event_files(site_root))

    def test_make_serve_starts_hugo_in_containerized_mode_with_public_bind(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        site_root = repo_root / "site"
        bin_dir = self.seed_fake_tools(repo_root / "site", include_engine=True, include_hugo=True)
        env = self.base_env(repo_root / "site", bin_dir)
        env["CONTAINER_ENGINE"] = "fake-container-engine"
        env["CONTAINER_IMAGE"] = "fake/buildish-site:local"
        env["CONTAINER_HOME"] = str(repo_root / "site" / "build" / "fake-container-home")
        env["CONTAINER_SCRATCH_ROOT"] = str(repo_root / "site" / "build" / "container")
        env["PORT"] = "8767"
        source_page = self.workspace / "buildish-mammoth-cache" / "site" / "pages" / "_index.md"
        staged_page = self.mammoth_page_path(repo_root)
        process = self.start_make(site_root, "serve", env)
        self.wait_for(
            "fake containerized Hugo server readiness",
            lambda: Path(env["BUILDISH_FAKE_HUGO_READY"]).exists(),
            timeout=CONTAINERIZED_SERVE_READY_TIMEOUT,
            process=process,
        )
        self.wait_for("initial containerized serve stage", staged_page.exists, process=process)
        self.wait_for(
            "containerized serve watch event file under build/",
            lambda: bool(self.build_watch_event_files(site_root)),
            timeout=CONTAINERIZED_SERVE_READY_TIMEOUT,
            process=process,
        )
        self.assertEqual([], self.root_watch_event_files(site_root))
        source_page.write_text(
            text_block(
                """
                # Mammoth Cache for Gradle® and Apache Maven™

                Updated by containerized serve.
                """
            ),
            encoding="utf-8",
        )
        self.wait_for(
            "restaged component page after containerized serve change",
            lambda: self.file_contains(staged_page, "Updated by containerized serve."),
            timeout=CONTAINERIZED_SERVE_READY_TIMEOUT,
            process=process,
        )
        hugo_log = self.read_text(Path(env["BUILDISH_FAKE_HUGO_LOG"]))
        self.assert_contains_all(hugo_log, "server", "--bind 0.0.0.0", "--port 8767")
        self.stop_process(process)
        self.assertEqual([], self.build_watch_event_files(site_root))
        self.assertEqual([], self.root_watch_event_files(site_root))
        self.assert_contains_all(self.read_text(repo_root / "site" / "build" / "fake-container.log"), "run", "--init")

    def test_repo_root_make_serve_delegates_to_site_makefile(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        bin_dir = self.seed_fake_tools(repo_root / "site", include_engine=True, include_hugo=True)
        env = self.base_env(repo_root / "site", bin_dir)
        env["CONTAINER_ENGINE"] = "fake-container-engine"
        env["CONTAINER_IMAGE"] = "fake/buildish-site:local"
        env["CONTAINER_HOME"] = str(repo_root / "site" / "build" / "fake-container-home")
        env["CONTAINER_SCRATCH_ROOT"] = str(repo_root / "site" / "build" / "container")
        env["PORT"] = "8770"
        staged_page = self.mammoth_page_path(repo_root)

        process = self.start_make(repo_root, "serve", env)

        self.wait_for(
            "repo-root delegated serve readiness",
            lambda: Path(env["BUILDISH_FAKE_HUGO_READY"]).exists(),
            timeout=CONTAINERIZED_SERVE_READY_TIMEOUT,
            process=process,
        )
        self.wait_for("repo-root delegated serve stage", staged_page.exists, process=process)
        self.stop_process(process)
        self.assert_contains_all(self.read_text(repo_root / "site" / "build" / "fake-container.log"), "run", "--init")

    def test_make_serve_in_containerized_mode_stops_on_sigint(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        site_root = repo_root / "site"
        bin_dir = self.seed_fake_tools(repo_root / "site", include_engine=True, include_hugo=True)
        env = self.base_env(repo_root / "site", bin_dir)
        env["CONTAINER_ENGINE"] = "fake-container-engine"
        env["CONTAINER_IMAGE"] = "fake/buildish-site:local"
        env["CONTAINER_HOME"] = str(repo_root / "site" / "build" / "fake-container-home")
        env["CONTAINER_SCRATCH_ROOT"] = str(repo_root / "site" / "build" / "container")
        env["PORT"] = "8768"
        process = self.start_make(site_root, "serve", env)
        self.wait_for(
            "fake containerized Hugo server readiness",
            lambda: Path(env["BUILDISH_FAKE_HUGO_READY"]).exists(),
            timeout=CONTAINERIZED_SERVE_READY_TIMEOUT,
            process=process,
        )
        self.wait_for(
            "containerized serve watch event file under build/",
            lambda: bool(self.build_watch_event_files(site_root)),
            timeout=CONTAINERIZED_SERVE_READY_TIMEOUT,
            process=process,
        )
        self.assertEqual([], self.root_watch_event_files(site_root))
        os.killpg(process.pid, signal.SIGINT)
        process.wait(timeout=10)
        output = self.read_process_output(process)
        self.assertIn(process.returncode, (-signal.SIGINT, 130), output)
        self.assertIn("serve exited", output)
        self.assertEqual([], self.build_watch_event_files(site_root))
        self.assertEqual([], self.root_watch_event_files(site_root))

    def test_make_serve_host_cleanup_removes_watch_events_when_container_stop_skips_traps(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        site_root = repo_root / "site"
        bin_dir = self.seed_fake_tools(repo_root / "site", include_engine=True, include_hugo=True)
        env = self.base_env(repo_root / "site", bin_dir)
        env["CONTAINER_ENGINE"] = "fake-container-engine"
        env["CONTAINER_IMAGE"] = "fake/buildish-site:local"
        env["CONTAINER_HOME"] = str(repo_root / "site" / "build" / "fake-container-home")
        env["CONTAINER_SCRATCH_ROOT"] = str(repo_root / "site" / "build" / "container")
        env["BUILDISH_FAKE_CONTAINER_STOP_SIGNAL"] = "SIGKILL"
        env["PORT"] = "8769"
        process = self.start_make(site_root, "serve", env)
        self.wait_for(
            "fake containerized Hugo server readiness",
            lambda: Path(env["BUILDISH_FAKE_HUGO_READY"]).exists(),
            timeout=CONTAINERIZED_SERVE_READY_TIMEOUT,
            process=process,
        )
        self.wait_for(
            "containerized serve watch event file under build/",
            lambda: bool(self.build_watch_event_files(site_root)),
            timeout=CONTAINERIZED_SERVE_READY_TIMEOUT,
            process=process,
        )
        self.stop_process(process)
        self.assertEqual([], self.build_watch_event_files(site_root))
        self.assertEqual([], self.root_watch_event_files(site_root))


if __name__ == "__main__":
    unittest.main()
