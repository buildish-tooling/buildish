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

HUGO ?= hugo
NVM_DIR ?= $(HOME)/.nvm
UV ?= uv
PYTHON ?= python
WATCH_READY_TIMEOUT_SECONDS ?= 20
WAIT_FOR_WATCH_READY ?= scripts/wait_for_watch_ready.py
SITE_PIPELINE_READY_ARGS ?= --unstable-events jsonl
# Keep transient watch event files under build/ so serve workflows do not leave
# noisy JSONL files in the site root when a long-running process exits. Use a
# site-root-relative path so the same setting works on the host and inside the
# containerized serve workspace.
WATCH_EVENTS_ROOT ?= build
WATCH_EVENTS_TEMPLATE ?= $(WATCH_EVENTS_ROOT)/.watch-events.XXXXXX.jsonl
PORT ?= 8000
HUGO_SERVER_BIND ?= 127.0.0.1
HELP_TARGETS = $(MAKEFILE_LIST)

DOCSY_ENV = \
	export NVM_DIR="$(NVM_DIR)"; \
	if [ -s "$$NVM_DIR/nvm.sh" ]; then \
		. "$$NVM_DIR/nvm.sh"; \
		if [ -f .nvmrc ]; then \
			nvm use --silent >/dev/null; \
		fi; \
	fi; \
	export PATH="$(NODE_MODULES_DIR)/.bin:$$PATH"

REPO_ROOT := $(abspath $(CURDIR)/..)
WORKSPACE_ROOT := $(abspath $(REPO_ROOT)/..)
REPO_NAME := $(notdir $(REPO_ROOT))
SITE_PIPELINE_REPO_ROOT ?= $(WORKSPACE_ROOT)/buildish-site-pipeline
SITE_PIPELINE_CATALOG ?= $(REPO_ROOT)/site/catalog.yaml
NODE_MODULES_DIR ?= $(CURDIR)/node_modules