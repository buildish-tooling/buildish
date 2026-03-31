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

"""Integration tests for the Make targets that wrap the site pipeline."""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import time
import unittest
from pathlib import Path
from typing import TextIO

import yaml

from test_support import (
    SOURCE_REPO_ROOT,
    TestCaseHelpers,
    seed_make_fixture_main_repo,
    seed_mammoth_fixture,
    seed_no_wrapper_fixture,
    text_block,
)

DEFAULT_FIXTURE_ROOT = SOURCE_REPO_ROOT / "site" / "build" / "tests" / f"integration-make-targets-{os.getpid()}"
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

                {{< buildish-component-link kind="docs" label="Read development docs" appearance="primary" >}}

                {{< buildish-component-link kind="source" label="Browse source" appearance="outline-secondary" >}}

                {{< buildish-component-releases heading="Current release lines" >}}
                """
            ),
            docs_index=text_block(
                """
                # Overview

                Initial overview.
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

    def seed_fake_tools(self, site_root: Path, include_engine: bool = False, include_hugo: bool = False, include_native_docsy: bool = False) -> Path:
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
                mkdir -p "$root/.bin" "$root/autoprefixer" "$root/jquery/dist" "$root/mermaid/dist" "$root/lunr"
                printf 'module.exports = {}\n' > "$root/autoprefixer/index.js"
                printf '#!/usr/bin/env sh\nset -eu\nif [ -n "${NODE_PATH:-}" ] && [ -f "${NODE_PATH}/autoprefixer/index.js" ]; then\n  exit 0\nfi\nif [ -f "$PWD/node_modules/autoprefixer/index.js" ]; then\n  exit 0\nfi\necho "autoprefixer is not resolvable" >&2\nexit 1\n' > "$root/.bin/postcss"
                chmod 755 "$root/.bin/postcss"
                printf '// fake asset\n' > "$root/jquery/dist/jquery.min.js"
                printf '// fake asset\n' > "$root/mermaid/dist/mermaid.min.js"
                printf '// fake asset\n' > "$root/lunr/lunr.min.js"
                echo 'fake npm ci completed'
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
                        Path(os.environ['BUILDISH_FAKE_HUGO_READY']).write_text('ready\n', encoding='utf-8')
                        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
                        signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
                        while True:
                            time.sleep(0.1)

                    if os.environ.get('BUILDISH_FAKE_HUGO_REQUIRE_POSTCSS_NPX') == '1':
                        subprocess.run(['npx', 'postcss', '--help'], check=True)
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
                            try:
                                os.killpg(int(pidfile.read_text(encoding='utf-8')), signal.SIGTERM)
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
                        command = args[i + 1 :]
                        break

                    if command is None:
                        sys.exit(1)

                    cwd = os.environ.get('BUILDISH_FAKE_CONTAINER_CWD', os.getcwd())
                    if workdir is not None:
                        for container_root, host_root in volume_map.items():
                            if workdir == container_root or workdir.startswith(container_root + '/'):
                                suffix = workdir[len(container_root) :].lstrip('/')
                                cwd = str(Path(host_root) / suffix)
                                break

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
            for rel in ["jquery/dist/jquery.min.js", "mermaid/dist/mermaid.min.js", "lunr/lunr.min.js"]:
                target = node_modules / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("// fake asset\n", encoding="utf-8")
        return bin_dir

    def base_env(self, site_root: Path, bin_dir: Path) -> dict[str, str]:
        env = os.environ.copy()
        env["PATH"] = f"{bin_dir}:{env.get('PATH', '')}"
        env["NVM_DIR"] = str(site_root / "build" / "fake-nvm")
        env["BUILDISH_FAKE_HUGO_LOG"] = str(site_root / "build" / "fake-hugo.log")
        env["BUILDISH_FAKE_HUGO_READY"] = str(site_root / "build" / "fake-hugo.ready")
        env["BUILDISH_FAKE_CONTAINER_LOG"] = str(site_root / "build" / "fake-container.log")
        env["BUILDISH_FAKE_CONTAINER_STATE_DIR"] = str(site_root / "build" / "fake-container-state")
        env["BUILDISH_FAKE_CONTAINER_CWD"] = str(site_root)
        return env

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

    def test_make_stage_local_builds_fixture_workspace(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        result = self.run_make(repo_root / "site", "stage-local", os.environ.copy())
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assert_paths_exist(
            repo_root / "site" / ".stage" / "manifest.yaml",
            repo_root / "site" / ".stage" / "content" / "components" / "mammoth-cache" / "development" / "docs" / "getting-started.md",
        )

    def test_make_build_local_renders_component_navigation_without_cross_component_sidebar(self) -> None:
        if shutil.which("hugo") is None:
            self.skipTest("hugo is required for render integration coverage")
        if not (SOURCE_REPO_ROOT / "site" / "node_modules" / ".bin" / "postcss").exists():
            self.skipTest("site/node_modules is required for render integration coverage")

        repo_root = self.prepare_fixture_workspace()
        env = os.environ.copy()
        env["NODE_MODULES_DIR"] = str(SOURCE_REPO_ROOT / "site" / "node_modules")
        result = self.run_make(repo_root / "site", "build-local", env)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

        home_index = self.read_text(repo_root / "site" / ".public" / "index.html")
        self.assert_contains_all(
            home_index,
            'rel="shortcut icon" href="/favicons/favicon.ico"',
            'rel="icon" href="/favicons/favicon.svg" type="image/svg+xml" sizes="any"',
            'rel="icon" href="/favicons/favicon-32x32.png" type="image/png" sizes="32x32"',
            'rel="icon" href="/favicons/favicon-16x16.png" type="image/png" sizes="16x16"',
            'rel="apple-touch-icon" href="/favicons/apple-touch-icon.png" sizes="180x180"',
            'rel="manifest" href="/favicons/site.webmanifest"',
            'rel="mask-icon" href="/favicons/safari-pinned-tab.svg" color="#38bdf8"',
            'name="msapplication-config" content="/favicons/browserconfig.xml"',
            'name="theme-color" content="#0f172a"',
            'class="btn btn-primary me-2 mb-2" href="/community/">Community</a>',
            '/community/contributing-guidelines/',
            '/community/community-guidelines/',
            'href="/community/">Overview</a>',
            'href="/community/contact/">Contact</a>',
            'class="navbar-toggler td-navbar__toggle collapsed d-md-none"',
            'data-bs-target="#main_navbar"',
            'navbar-mobile-section-title d-md-none',
            'Gradle® is a registered trademark of Gradle, Inc.',
        )
        overview_index = home_index.find('href="/community/">Overview</a>')
        self.assertNotEqual(-1, overview_index)
        divider_index = home_index.find('class="dropdown-divider"', overview_index)
        self.assertNotEqual(-1, divider_index)
        self.assertGreater(home_index.find('href="/community/contact/">Contact</a>'), divider_index)
        incubator_index = home_index.find('>Incubation status</h2>')
        self.assertNotEqual(-1, incubator_index)
        trademark_index = home_index.find('Apache® is a registered trademark of The Apache Software Foundation.')
        self.assertNotEqual(-1, trademark_index)
        self.assertGreater(trademark_index, incubator_index)
        trademark_card_index = home_index.find('buildish-home-legal-card')
        self.assertNotEqual(-1, trademark_card_index)
        self.assertGreater(trademark_card_index, incubator_index)
        self.assert_not_contains_any(home_index, "Browse components", 'Community &amp; contact', 'class="nav-item navbar-group-separator"', 'navbar-item--global')

        docs_index = self.read_text(repo_root / "site" / ".public" / "components" / "mammoth-cache" / "development" / "docs" / "index.html")
        self.assert_contains_all(
            docs_index,
            'class="td-navbar__top"',
            'class="td-breadcrumbs',
            'class="collapse d-md-flex td-navbar__main',
            'navbar-mobile-section-title d-md-none',
            'class="td-sidebar__controls d-flex d-md-none align-items-center"',
            'class="btn btn-link td-sidebar__search-toggle"',
            'data-bs-target="#td-sidebar-search"',
            'class="td-sidebar__search td-sidebar__search--mobile collapse d-md-none" id="td-sidebar-search"',
            'class="navbar-brand__home" href="/"',
            'class="navbar-brand__component" href="/components/mammoth-cache/"',
            'class="navbar-brand__divider"',
            '<span class="navbar-brand__context">Fixture Mammoth Cache for Gradle® and Apache Maven™</span>',
            'href="https://github.com/apache/buildish-mammoth-cache"',
            '>Source</span>',
            'navbar-item--component',
            'class="nav-item navbar-group-separator"',
            'class="navbar-group-separator__line"',
            'navbar-item--global',
            '/community/contributing-guidelines/',
            '/community/community-guidelines/',
        )
        self.assert_not_contains_any(docs_index, '<a href="/components/">Components</a>')

        component_index = self.read_text(repo_root / "site" / ".public" / "components" / "mammoth-cache" / "index.html")
        self.assert_contains_all(
            component_index,
            'Fixture component landing page.',
            'Read development docs',
            'href="/components/mammoth-cache/development/docs/"',
            'Browse source',
            'href="https://github.com/apache/buildish-mammoth-cache"',
            'Current release lines',
            'Latest stable (v1.2.3)',
            'v1 — maintained (latest v1.2.3); aliases: v1',
        )
        self.assert_not_contains_any(component_index, 'buildish-component-landing__hero', 'buildish-component-landing__actions', 'class="td-breadcrumbs', 'aria-label="breadcrumb"')

        components_index = self.read_text(repo_root / "site" / ".public" / "components" / "index.html")
        self.assert_contains_all(
            components_index,
            '<h1>Components</h1>',
            'class="section-index"',
            'href="/components/mammoth-cache/"',
            'href="/components/no-gradle-wrapper-jar/"',
        )
        self.assert_not_contains_any(components_index, 'class="td-breadcrumbs', 'aria-label="breadcrumb"', 'col-12 col-md-3 col-xl-2 td-sidebar d-print-none')

        community_index = self.read_text(repo_root / "site" / ".public" / "community" / "index.html")
        self.assert_contains_all(
            community_index,
            '<h1>Community</h1>',
            'class="section-index"',
            'href="/community/contact/"',
            'href="/community/get-involved/"',
        )
        self.assert_not_contains_any(community_index, 'class="td-breadcrumbs', 'aria-label="breadcrumb"', 'col-12 col-md-3 col-xl-2 td-sidebar d-print-none')

        favicons_dir = repo_root / "site" / ".public" / "favicons"
        for favicon_name in (
            "favicon.ico",
            "favicon.svg",
            "favicon-16x16.png",
            "favicon-32x32.png",
            "apple-touch-icon.png",
            "android-chrome-192x192.png",
            "android-chrome-512x512.png",
            "mstile-150x150.png",
            "safari-pinned-tab.svg",
            "site.webmanifest",
            "browserconfig.xml",
        ):
            self.assertTrue((favicons_dir / favicon_name).exists(), favicon_name)

        webmanifest = self.read_text(favicons_dir / "site.webmanifest")
        self.assert_contains_all(
            webmanifest,
            '"name": "Apache Buildish"',
            '"src": "/favicons/android-chrome-192x192.png"',
            '"src": "/favicons/android-chrome-512x512.png"',
            '"theme_color": "#0f172a"',
        )

        sidebar = docs_index.split('<aside class="col-12 col-md-3 col-xl-2 td-sidebar d-print-none">', 1)[1].split('<aside class="d-none d-xl-block col-xl-2 td-sidebar-toc d-print-none">', 1)[0]
        self.assertNotIn('id="m-componentsmammoth-cache"', sidebar)
        self.assertNotIn('id="m-componentsno-gradle-wrapper-jar"', sidebar)
        self.assertIn("Development", sidebar)

        contributing_guidelines = self.read_text(repo_root / "site" / ".public" / "community" / "contributing-guidelines" / "index.html")
        self.assert_contains_all(
            contributing_guidelines,
            "Contributing Guidelines",
            "apache/buildish",
            "https://www.apache.org/legal/generative-tooling.html",
        )

        community_guidelines = self.read_text(repo_root / "site" / ".public" / "community" / "community-guidelines" / "index.html")
        self.assert_contains_all(community_guidelines, "Community Guidelines", "Apache Way")

        contact_index = self.read_text(repo_root / "site" / ".public" / "community" / "contact" / "index.html")
        self.assert_contains_all(
            contact_index,
            'class="dropdown-item active" href="/community/contact/"',
            'href="/community/contact/">Contact</a>',
        )
        self.assertNotIn('class="dropdown-item active" href="/community/"', contact_index)

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
            repo_root / "site" / ".stage" / "manifest.yaml",
            repo_root / "site" / ".stage" / "static" / "js" / "vendor" / "jquery.min.js",
        )
        components_payload = yaml.safe_load((repo_root / "site" / ".stage" / "data" / "components.yaml").read_text(encoding="utf-8"))
        self.assertTrue(components_payload["components"]["mammoth-cache"]["available"])
        self.assertIn("Mammoth Cache for Gradle® and Apache Maven™", components_payload["components"]["mammoth-cache"]["displayName"])
        self.assertEqual("/components/mammoth-cache/development/docs/", components_payload["components"]["mammoth-cache"]["docsPath"])
        container_log = self.read_text(repo_root / "site" / "build" / "fake-container.log")
        self.assert_contains_all(container_log, "run", "--init", "/workspace/buildish/site")

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
        self.assert_contains_all(self.read_text(Path(env["BUILDISH_FAKE_HUGO_LOG"])), "--source .", "--config hugo.yaml")

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
            "serve              Serve the site with live restaging in the build container",
            "build              Stage and render the site in the build container",
            "test               Run unit tests.",
            "check              Run lint, type checks, tests, and build-local.",
            "serve-local        Serve the site with live restaging using host tools",
            "build-local        Stage and render the site with host tools.",
            "render             Render the current staged site in the build container.",
            "render-local       Render the current staged site with host tools.",
            "stage-local        Refresh staged site inputs with host tools.",
            "For advanced/internal targets, run 'make help-all'.",
        )
        self.assert_not_contains_any(result.stdout, "container-serve", "hugo-check", "docsy-check", "vendor-assets", "container-build")

    def test_make_stage_watch_local_rebuilds_after_doc_change(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        source_doc = self.workspace / "buildish-mammoth-cache" / "site" / "docs" / "getting-started.md"
        staged_doc = repo_root / "site" / ".stage" / "content" / "components" / "mammoth-cache" / "development" / "docs" / "getting-started.md"
        process = self.start_make(repo_root / "site", "stage-watch-local", os.environ.copy())
        self.wait_for("initial stage-watch build", lambda: staged_doc.exists(), process=process)
        time.sleep(1.0)
        source_doc.write_text(
            text_block(
                """
                # Getting started

                Updated by stage-watch-local.
                """
            ),
            encoding="utf-8",
        )
        self.wait_for(
            "restaged docs after stage-watch-local change",
            lambda: staged_doc.exists() and "Updated by stage-watch-local." in staged_doc.read_text(encoding="utf-8"),
            process=process,
        )
        self.stop_process(process)

    def test_make_stage_watch_rebuilds_after_doc_change_in_containerized_mode(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        bin_dir = self.seed_fake_tools(repo_root / "site", include_engine=True)
        env = self.base_env(repo_root / "site", bin_dir)
        env["CONTAINER_ENGINE"] = "fake-container-engine"
        env["CONTAINER_IMAGE"] = "fake/buildish-site:local"
        env["CONTAINER_HOME"] = str(repo_root / "site" / "build" / "fake-container-home")
        env["CONTAINER_SCRATCH_ROOT"] = str(repo_root / "site" / "build" / "container")
        source_doc = self.workspace / "buildish-mammoth-cache" / "site" / "docs" / "getting-started.md"
        staged_doc = repo_root / "site" / ".stage" / "content" / "components" / "mammoth-cache" / "development" / "docs" / "getting-started.md"
        process = self.start_make(repo_root / "site", "stage-watch", env)
        self.wait_for("initial containerized stage-watch build", lambda: staged_doc.exists(), process=process)
        time.sleep(1.0)
        source_doc.write_text(
            text_block(
                """
                # Getting started

                Updated by containerized stage-watch.
                """
            ),
            encoding="utf-8",
        )
        self.wait_for(
            "restaged docs after containerized stage-watch change",
            lambda: staged_doc.exists() and "Updated by containerized stage-watch." in staged_doc.read_text(encoding="utf-8"),
            process=process,
        )
        self.stop_process(process)
        self.assert_contains_all(self.read_text(repo_root / "site" / "build" / "fake-container.log"), "run")

    def test_make_serve_local_starts_hugo_with_local_bind_and_restages_changes(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        bin_dir = self.seed_fake_tools(repo_root / "site", include_hugo=True, include_native_docsy=True)
        env = self.base_env(repo_root / "site", bin_dir)
        env["PORT"] = "8766"
        source_doc = self.workspace / "buildish-mammoth-cache" / "site" / "docs" / "getting-started.md"
        staged_doc = repo_root / "site" / ".stage" / "content" / "components" / "mammoth-cache" / "development" / "docs" / "getting-started.md"
        process = self.start_make(repo_root / "site", "serve-local", env)
        self.wait_for("fake local Hugo server readiness", lambda: Path(env["BUILDISH_FAKE_HUGO_READY"]).exists(), process=process)
        source_doc.write_text(
            text_block(
                """
                # Getting started

                Updated by serve-local.
                """
            ),
            encoding="utf-8",
        )
        self.wait_for(
            "restaged docs after serve-local change",
            lambda: staged_doc.exists() and "Updated by serve-local." in staged_doc.read_text(encoding="utf-8"),
            process=process,
        )
        hugo_log = self.read_text(Path(env["BUILDISH_FAKE_HUGO_LOG"]))
        self.assert_contains_all(hugo_log, "server", "--bind 127.0.0.1", "--port 8766")
        self.stop_process(process)

    def test_make_serve_starts_hugo_in_containerized_mode_with_public_bind(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        bin_dir = self.seed_fake_tools(repo_root / "site", include_engine=True, include_hugo=True)
        env = self.base_env(repo_root / "site", bin_dir)
        env["PORT"] = "8767"
        env["CONTAINER_ENGINE"] = "fake-container-engine"
        env["CONTAINER_IMAGE"] = "fake/buildish-site:local"
        env["CONTAINER_HOME"] = str(repo_root / "site" / "build" / "fake-container-home")
        env["CONTAINER_SCRATCH_ROOT"] = str(repo_root / "site" / "build" / "container")
        source_doc = self.workspace / "buildish-mammoth-cache" / "site" / "docs" / "getting-started.md"
        staged_doc = repo_root / "site" / ".stage" / "content" / "components" / "mammoth-cache" / "development" / "docs" / "getting-started.md"
        process = self.start_make(repo_root / "site", "serve", env)
        self.wait_for(
            "fake containerized Hugo server readiness",
            lambda: Path(env["BUILDISH_FAKE_HUGO_READY"]).exists(),
            timeout=CONTAINERIZED_SERVE_READY_TIMEOUT,
            process=process,
        )
        source_doc.write_text(
            text_block(
                """
                # Getting started

                Updated by containerized serve.
                """
            ),
            encoding="utf-8",
        )
        self.wait_for(
            "restaged docs after containerized serve change",
            lambda: staged_doc.exists() and "Updated by containerized serve." in staged_doc.read_text(encoding="utf-8"),
            process=process,
        )
        hugo_log = self.read_text(Path(env["BUILDISH_FAKE_HUGO_LOG"]))
        self.assert_contains_all(hugo_log, "--bind 0.0.0.0", "--port 8767")
        container_log = self.read_text(repo_root / "site" / "build" / "fake-container.log")
        self.assert_contains_all(container_log, "run", "--init", "/workspace/buildish/site")
        self.stop_process(process)

    def test_make_serve_in_containerized_mode_stops_on_sigint(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        bin_dir = self.seed_fake_tools(repo_root / "site", include_engine=True, include_hugo=True)
        env = self.base_env(repo_root / "site", bin_dir)
        env["PORT"] = "8768"
        env["CONTAINER_ENGINE"] = "fake-container-engine"
        env["CONTAINER_IMAGE"] = "fake/buildish-site:local"
        env["CONTAINER_HOME"] = str(repo_root / "site" / "build" / "fake-container-home")
        env["CONTAINER_SCRATCH_ROOT"] = str(repo_root / "site" / "build" / "container")
        process = self.start_make(repo_root / "site", "serve", env)
        self.wait_for(
            "fake containerized Hugo server readiness",
            lambda: Path(env["BUILDISH_FAKE_HUGO_READY"]).exists(),
            timeout=CONTAINERIZED_SERVE_READY_TIMEOUT,
            process=process,
        )
        os.killpg(process.pid, signal.SIGINT)
        process.wait(timeout=10)
        output = self.stop_process(process)
        self.assertIn(process.returncode, {130, -signal.SIGINT}, output)
        container_log = self.read_text(repo_root / "site" / "build" / "fake-container.log")
        self.assert_contains_all(container_log, "stop -t 0", "rm -f")


if __name__ == "__main__":
    unittest.main()