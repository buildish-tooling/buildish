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
import sys
import time
import unittest
from pathlib import Path

import yaml

SOURCE_REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_FIXTURE_ROOT = SOURCE_REPO_ROOT / "site" / "build" / "tests" / f"integration-make-targets-{os.getpid()}"


class MakeTargetIntegrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = DEFAULT_FIXTURE_ROOT / self._testMethodName
        shutil.rmtree(self.workspace, ignore_errors=True)
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.processes: list[subprocess.Popen[str]] = []

    def tearDown(self) -> None:
        for process in self.processes:
            self.stop_process(process)
        shutil.rmtree(self.workspace, ignore_errors=True)

    def prepare_fixture_workspace(self) -> Path:
        repo_root = self.workspace / "buildish"
        repo_root.mkdir()
        self.seed_main_repo(repo_root)
        self.seed_mammoth_fixture(self.workspace / "buildish-mammoth-cache-gradle")
        self.seed_no_wrapper_fixture(self.workspace / "buildish-no-gradle-wrapper-jar")
        return repo_root

    def seed_main_repo(self, repo_root: Path) -> None:
        site_root = repo_root / "site"
        site_root.mkdir(parents=True, exist_ok=True)
        shutil.copytree(SOURCE_REPO_ROOT / "site" / "assets", site_root / "assets", dirs_exist_ok=True)
        shutil.copytree(SOURCE_REPO_ROOT / "site" / "content", site_root / "content", dirs_exist_ok=True)
        shutil.copytree(SOURCE_REPO_ROOT / "site" / "layouts", site_root / "layouts", dirs_exist_ok=True)
        shutil.copytree(SOURCE_REPO_ROOT / "site" / "pipeline", site_root / "pipeline", dirs_exist_ok=True)
        shutil.copytree(SOURCE_REPO_ROOT / "site" / "site", site_root / "site", dirs_exist_ok=True)
        shutil.copytree(SOURCE_REPO_ROOT / "site" / "static", site_root / "static", dirs_exist_ok=True)
        shutil.copy2(SOURCE_REPO_ROOT / "DISCLAIMER", repo_root / "DISCLAIMER")
        for relative in ["Makefile", "go.mod", "go.sum", "hugo.yaml", "package.json", "package-lock.json", "postcss.config.js"]:
            shutil.copy2(SOURCE_REPO_ROOT / "site" / relative, site_root / relative)

        catalog = yaml.safe_load((SOURCE_REPO_ROOT / "site" / "projects.yaml").read_text(encoding="utf-8"))
        catalog["projects"] = [
            {"slug": "mammoth-cache-gradle", "localDir": "buildish-mammoth-cache-gradle"},
            {"slug": "no-gradle-wrapper-jar", "localDir": "buildish-no-gradle-wrapper-jar", "weight": 5},
            {"slug": "site", "localDir": "buildish/site", "weight": 100},
        ]
        with (site_root / "projects.yaml").open("w", encoding="utf-8") as handle:
            yaml.safe_dump(catalog, handle, sort_keys=False, default_flow_style=False)

    @staticmethod
    def seed_mammoth_fixture(repo_root: Path) -> None:
        (repo_root / "site" / "docs").mkdir(parents=True)
        (repo_root / "site" / "assets" / "images").mkdir(parents=True)
        (repo_root / "README.md").write_text("# Mammoth Cache for Gradle\n\nFixture project summary.\n", encoding="utf-8")
        with (repo_root / "site" / "project.yaml").open("w", encoding="utf-8") as handle:
            yaml.safe_dump(
                {
                    "schemaVersion": 1,
                    "project": {
                        "slug": "mammoth-cache-gradle",
                        "displayName": "Fixture Mammoth Cache for Gradle",
                        "repository": "https://github.com/apache/buildish-mammoth-cache-gradle",
                        "defaultBranch": "main",
                    },
                    "lifecycle": {
                        "latestStable": "v1.2.3",
                        "releaseLines": [{"line": "v1", "latest": "v1.2.3", "status": "maintained", "aliases": ["v1"]}],
                    },
                },
                handle,
                sort_keys=False,
                default_flow_style=False,
            )
        (repo_root / "site" / "docs" / "_index.md").write_text("# Overview\n\nInitial overview.\n", encoding="utf-8")
        (repo_root / "site" / "docs" / "getting-started.md").write_text("# Getting started\n\nInitial fixture text.\n", encoding="utf-8")
        (repo_root / "site" / "assets" / "images" / "diagram.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'></svg>\n", encoding="utf-8")

    @staticmethod
    def seed_no_wrapper_fixture(repo_root: Path) -> None:
        (repo_root / "site" / "docs").mkdir(parents=True)
        with (repo_root / "site" / "project.yaml").open("w", encoding="utf-8") as handle:
            yaml.safe_dump(
                {
                    "schemaVersion": 1,
                    "project": {"slug": "no-gradle-wrapper-jar", "displayName": "Fixture no-gradle-wrapper-jar"},
                    "content": {"docsRoot": "site/docs"},
                },
                handle,
                sort_keys=False,
                default_flow_style=False,
            )
        (repo_root / "site" / "docs" / "_index.md").write_text("# No Wrapper JAR\n\nFixture docs overview.\n", encoding="utf-8")

    def write_executable(self, path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        path.chmod(0o755)

    def seed_fake_tools(self, site_root: Path, include_engine: bool = False, include_hugo: bool = False, include_native_docsy: bool = False) -> Path:
        bin_dir = site_root / "build" / "test-bin"
        self.write_executable(bin_dir / "node", "#!/usr/bin/env sh\nexit 0\n")
        self.write_executable(
            bin_dir / "npm",
            "#!/usr/bin/env sh\n"
            "set -eu\n"
            "prefix=.\n"
            "while [ \"$#\" -gt 0 ]; do\n"
            "  if [ \"$1\" = \"--prefix\" ]; then\n"
            "    prefix=\"$2\"\n"
            "    shift 2\n"
            "    continue\n"
            "  fi\n"
            "  shift\n"
            "done\n"
            "root=\"$prefix/node_modules\"\n"
            "mkdir -p \"$root/.bin\" \"$root/jquery/dist\" \"$root/mermaid/dist\" \"$root/lunr\"\n"
            "printf '#!/usr/bin/env sh\\nexit 0\\n' > \"$root/.bin/postcss\"\n"
            "chmod 755 \"$root/.bin/postcss\"\n"
            "printf '// fake asset\\n' > \"$root/jquery/dist/jquery.min.js\"\n"
            "printf '// fake asset\\n' > \"$root/mermaid/dist/mermaid.min.js\"\n"
            "printf '// fake asset\\n' > \"$root/lunr/lunr.min.js\"\n"
            "echo 'fake npm ci completed'\n",
        )
        if include_hugo:
            self.write_executable(
                bin_dir / "hugo",
                "#!/usr/bin/env python3\nfrom pathlib import Path\nimport os, signal, sys, time\n"
                "log_path = Path(os.environ['BUILDISH_FAKE_HUGO_LOG'])\nlog_path.parent.mkdir(parents=True, exist_ok=True)\n"
                "with log_path.open('a', encoding='utf-8') as handle: handle.write(' '.join(sys.argv[1:]) + '\\n')\n"
                "if 'server' in sys.argv[1:]:\n"
                "    Path(os.environ['BUILDISH_FAKE_HUGO_READY']).write_text('ready\\n', encoding='utf-8')\n"
                "    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))\n"
                "    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))\n"
                "    while True: time.sleep(0.1)\n",
            )
        if include_engine:
            self.write_executable(
                bin_dir / "fake-container-engine",
                "#!/usr/bin/env python3\nfrom pathlib import Path\nimport os, signal, subprocess, sys\n"
                "args=sys.argv[1:]\nlog=Path(os.environ['BUILDISH_FAKE_CONTAINER_LOG'])\nlog.parent.mkdir(parents=True, exist_ok=True)\n"
                "state_dir=Path(os.environ['BUILDISH_FAKE_CONTAINER_STATE_DIR'])\nstate_dir.mkdir(parents=True, exist_ok=True)\n"
                "with log.open('a', encoding='utf-8') as handle: handle.write(' '.join(args) + '\\n')\n"
                "if not args: sys.exit(1)\n"
                "if args[:2] == ['image', 'inspect'] or args[0] == 'build': sys.exit(0)\n"
                "if args[0] == 'stop':\n"
                "    name = args[-1]\n"
                "    pidfile = state_dir / f'{name}.pid'\n"
                "    if pidfile.exists():\n"
                "        try: os.killpg(int(pidfile.read_text(encoding='utf-8')), signal.SIGTERM)\n"
                "        except ProcessLookupError: pass\n"
                "    sys.exit(0)\n"
                "if args[0] == 'rm':\n"
                "    name = args[-1]\n"
                "    pidfile = state_dir / f'{name}.pid'\n"
                "    pidfile.unlink(missing_ok=True)\n"
                "    sys.exit(0)\n"
                "if args[0] != 'run': sys.exit(0)\n"
                "env=os.environ.copy(); i=1; command=None; workdir=None; volume_map={}; name=None\n"
                "while i < len(args):\n"
                "    arg=args[i]\n"
                "    if arg == '-e':\n        key, value = args[i+1].split('=', 1); env[key]=value; i += 2; continue\n"
                "    if arg == '-v':\n        spec=args[i+1]; parts=spec.split(':'); volume_map[parts[1]]=parts[0]; i += 2; continue\n"
                "    if arg == '-w':\n        workdir=args[i+1]; i += 2; continue\n"
                "    if arg == '--name':\n        name=args[i+1]; i += 2; continue\n"
                "    if arg in {'-p', '--platform', '--user'}: i += 2; continue\n"
                "    if arg == '--rm' or arg == '--init' or arg.startswith('--userns='): i += 1; continue\n"
                "    command = args[i+1:]; break\n"
                "if command is None: sys.exit(1)\n"
                "cwd = os.environ.get('BUILDISH_FAKE_CONTAINER_CWD', os.getcwd())\n"
                "if workdir is not None:\n"
                "    for container_root, host_root in volume_map.items():\n"
                "        if workdir == container_root or workdir.startswith(container_root + '/'):\n"
                "            suffix = workdir[len(container_root):].lstrip('/')\n"
                "            cwd = str(Path(host_root) / suffix)\n"
                "            break\n"
                "proc = subprocess.Popen(command, cwd=cwd, env=env, start_new_session=True)\n"
                "if name is not None:\n"
                "    (state_dir / f'{name}.pid').write_text(str(proc.pid), encoding='utf-8')\n"
                "def forward(signum, _frame):\n"
                "    try: os.killpg(proc.pid, signum)\n"
                "    except ProcessLookupError: pass\n"
                "signal.signal(signal.SIGINT, forward)\n"
                "signal.signal(signal.SIGTERM, forward)\n"
                "returncode = proc.wait()\n"
                "if name is not None:\n"
                "    (state_dir / f'{name}.pid').unlink(missing_ok=True)\n"
                "sys.exit(returncode)\n",
            )
        if include_native_docsy:
            node_modules = site_root / "node_modules"
            self.write_executable(node_modules / ".bin" / "postcss", "#!/usr/bin/env sh\nexit 0\n")
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
        return subprocess.run(["make", target], cwd=site_root, env=env, capture_output=True, text=True, check=False)

    def start_make(self, site_root: Path, target: str, env: dict[str, str]) -> subprocess.Popen[str]:
        process = subprocess.Popen(
            ["make", target],
            cwd=site_root,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        self.processes.append(process)
        return process

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
        output = ""
        if process.stdout and not process.stdout.closed:
            output = process.stdout.read()
            process.stdout.close()
        return output

    def wait_for(self, description: str, predicate, timeout: float = 20.0) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate():
                return
            time.sleep(0.1)
        self.fail(f"Timed out waiting for {description}")

    def test_make_stage_local_builds_fixture_workspace(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        result = self.run_make(repo_root / "site", "stage-local", os.environ.copy())
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertTrue((repo_root / "site" / ".stage" / "manifest.yaml").exists())
        self.assertTrue((repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "unreleased" / "docs" / "getting-started.md").exists())

    def test_make_build_renders_project_navigation_without_cross_project_sidebar(self) -> None:
        if shutil.which("hugo") is None:
            self.skipTest("hugo is required for render integration coverage")
        if not (SOURCE_REPO_ROOT / "site" / "node_modules" / ".bin" / "postcss").exists():
            self.skipTest("site/node_modules is required for render integration coverage")

        repo_root = self.prepare_fixture_workspace()
        env = os.environ.copy()
        env["NODE_MODULES_DIR"] = str(SOURCE_REPO_ROOT / "site" / "node_modules")
        result = self.run_make(repo_root / "site", "build", env)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

        home_index = (repo_root / "site" / ".public" / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("Browse projects", home_index)
        self.assertIn('/community/contributing-guidelines/', home_index)
        self.assertIn('/community/community-guidelines/', home_index)

        docs_index = (repo_root / "site" / ".public" / "projects" / "mammoth-cache-gradle" / "unreleased" / "docs" / "index.html").read_text(encoding="utf-8")
        self.assertIn('class="navbar-brand" href="/"', docs_index)
        self.assertIn('<span class="navbar-brand__context">Fixture Mammoth Cache for Gradle</span>', docs_index)
        self.assertNotIn('<a href="/projects/">Projects</a>', docs_index)
        self.assertIn('/community/contributing-guidelines/', docs_index)
        self.assertIn('/community/community-guidelines/', docs_index)

        sidebar = docs_index.split('<aside class="col-12 col-md-3 col-xl-2 td-sidebar d-print-none">', 1)[1].split('<aside class="d-none d-xl-block col-xl-2 td-sidebar-toc d-print-none">', 1)[0]
        self.assertNotIn('id="m-projectsmammoth-cache-gradle"', sidebar)
        self.assertNotIn('id="m-projectsno-gradle-wrapper-jar"', sidebar)
        self.assertIn("Unreleased", sidebar)

        contributing_guidelines = (repo_root / "site" / ".public" / "community" / "contributing-guidelines" / "index.html").read_text(encoding="utf-8")
        self.assertIn("Contributing Guidelines", contributing_guidelines)
        self.assertIn("apache/buildish", contributing_guidelines)

        community_guidelines = (repo_root / "site" / ".public" / "community" / "community-guidelines" / "index.html").read_text(encoding="utf-8")
        self.assertIn("Community Guidelines", community_guidelines)
        self.assertIn("Apache Way", community_guidelines)

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
        self.assertTrue((repo_root / "site" / ".stage" / "manifest.yaml").exists())
        self.assertTrue((repo_root / "site" / ".stage" / "static" / "js" / "vendor" / "jquery.min.js").exists())
        projects_payload = yaml.safe_load((repo_root / "site" / ".stage" / "data" / "projects.yaml").read_text(encoding="utf-8"))
        self.assertTrue(projects_payload["projects"]["mammoth-cache-gradle"]["available"])
        self.assertIn("Mammoth Cache for Gradle", projects_payload["projects"]["mammoth-cache-gradle"]["displayName"])
        self.assertEqual("/projects/mammoth-cache-gradle/unreleased/docs/", projects_payload["projects"]["mammoth-cache-gradle"]["docsPath"])
        container_log = (repo_root / "site" / "build" / "fake-container.log").read_text(encoding="utf-8")
        self.assertIn("run", container_log)
        self.assertIn("--init", container_log)
        self.assertIn("/workspace/buildish/site", container_log)

    def test_make_stage_watch_local_rebuilds_after_doc_change(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        source_doc = self.workspace / "buildish-mammoth-cache-gradle" / "site" / "docs" / "getting-started.md"
        staged_doc = repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "unreleased" / "docs" / "getting-started.md"
        process = self.start_make(repo_root / "site", "stage-watch-local", os.environ.copy())
        self.wait_for("initial stage-watch build", lambda: staged_doc.exists())
        time.sleep(1.0)
        source_doc.write_text("# Getting started\n\nUpdated by stage-watch-local.\n", encoding="utf-8")
        self.wait_for("restaged docs after stage-watch-local change", lambda: staged_doc.exists() and "Updated by stage-watch-local." in staged_doc.read_text(encoding="utf-8"))
        self.stop_process(process)

    def test_make_stage_watch_rebuilds_after_doc_change_in_containerized_mode(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        bin_dir = self.seed_fake_tools(repo_root / "site", include_engine=True)
        env = self.base_env(repo_root / "site", bin_dir)
        env["CONTAINER_ENGINE"] = "fake-container-engine"
        env["CONTAINER_IMAGE"] = "fake/buildish-site:local"
        env["CONTAINER_HOME"] = str(repo_root / "site" / "build" / "fake-container-home")
        env["CONTAINER_SCRATCH_ROOT"] = str(repo_root / "site" / "build" / "container")
        source_doc = self.workspace / "buildish-mammoth-cache-gradle" / "site" / "docs" / "getting-started.md"
        staged_doc = repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "unreleased" / "docs" / "getting-started.md"
        process = self.start_make(repo_root / "site", "stage-watch", env)
        self.wait_for("initial containerized stage-watch build", lambda: staged_doc.exists())
        time.sleep(1.0)
        source_doc.write_text("# Getting started\n\nUpdated by containerized stage-watch.\n", encoding="utf-8")
        self.wait_for("restaged docs after containerized stage-watch change", lambda: staged_doc.exists() and "Updated by containerized stage-watch." in staged_doc.read_text(encoding="utf-8"))
        self.stop_process(process)
        self.assertIn("run", (repo_root / "site" / "build" / "fake-container.log").read_text(encoding="utf-8"))

    def test_make_serve_local_starts_hugo_with_local_bind_and_restages_changes(self) -> None:
        repo_root = self.prepare_fixture_workspace()
        bin_dir = self.seed_fake_tools(repo_root / "site", include_hugo=True, include_native_docsy=True)
        env = self.base_env(repo_root / "site", bin_dir)
        env["PORT"] = "8766"
        source_doc = self.workspace / "buildish-mammoth-cache-gradle" / "site" / "docs" / "getting-started.md"
        staged_doc = repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "unreleased" / "docs" / "getting-started.md"
        process = self.start_make(repo_root / "site", "serve-local", env)
        self.wait_for("fake local Hugo server readiness", lambda: Path(env["BUILDISH_FAKE_HUGO_READY"]).exists())
        source_doc.write_text("# Getting started\n\nUpdated by serve-local.\n", encoding="utf-8")
        self.wait_for("restaged docs after serve-local change", lambda: staged_doc.exists() and "Updated by serve-local." in staged_doc.read_text(encoding="utf-8"))
        hugo_log = Path(env["BUILDISH_FAKE_HUGO_LOG"]).read_text(encoding="utf-8")
        self.assertIn("server", hugo_log)
        self.assertIn("--bind 127.0.0.1", hugo_log)
        self.assertIn("--port 8766", hugo_log)
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
        source_doc = self.workspace / "buildish-mammoth-cache-gradle" / "site" / "docs" / "getting-started.md"
        staged_doc = repo_root / "site" / ".stage" / "content" / "projects" / "mammoth-cache-gradle" / "unreleased" / "docs" / "getting-started.md"
        process = self.start_make(repo_root / "site", "serve", env)
        self.wait_for("fake containerized Hugo server readiness", lambda: Path(env["BUILDISH_FAKE_HUGO_READY"]).exists())
        source_doc.write_text("# Getting started\n\nUpdated by containerized serve.\n", encoding="utf-8")
        self.wait_for("restaged docs after containerized serve change", lambda: staged_doc.exists() and "Updated by containerized serve." in staged_doc.read_text(encoding="utf-8"))
        hugo_log = Path(env["BUILDISH_FAKE_HUGO_LOG"]).read_text(encoding="utf-8")
        self.assertIn("--bind 0.0.0.0", hugo_log)
        self.assertIn("--port 8767", hugo_log)
        container_log = (repo_root / "site" / "build" / "fake-container.log").read_text(encoding="utf-8")
        self.assertIn("run", container_log)
        self.assertIn("--init", container_log)
        self.assertIn("/workspace/buildish/site", container_log)
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
        self.wait_for("fake containerized Hugo server readiness", lambda: Path(env["BUILDISH_FAKE_HUGO_READY"]).exists())
        os.killpg(process.pid, signal.SIGINT)
        process.wait(timeout=10)
        output = self.stop_process(process)
        self.assertIn(process.returncode, {130, -signal.SIGINT}, output)
        container_log = (repo_root / "site" / "build" / "fake-container.log").read_text(encoding="utf-8")
        self.assertIn("stop -t 0", container_log)
        self.assertIn("rm -f", container_log)


if __name__ == "__main__":
    unittest.main()