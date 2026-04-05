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

.DEFAULT_GOAL := help

HELP_TARGETS := $(MAKEFILE_LIST)
WORKSPACE_ROOT := $(abspath $(CURDIR)/..)
SITE_PIPELINE_REPO_ROOT ?= $(WORKSPACE_ROOT)/buildish-site-pipeline
SITE_PIPELINE_BIN ?= $(SITE_PIPELINE_REPO_ROOT)/.venv/bin/site-pipeline
SITE_PIPELINE_ARGS ?=
SITE_PIPELINE_CATALOG ?= $(CURDIR)/site/components.yaml
SITE_STAGE_ROOT ?= $(CURDIR)/site/.stage

.PHONY: help rat-check stage-local stage-watch-local

help: ## Show available Make targets.
	@awk 'BEGIN {FS = ":.*## "; printf "Available targets:\n"} /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-14s %s\n", $$1, $$2}' $(HELP_TARGETS)

rat-check: ## Run Apache RAT against tracked files in this repository (requires Java 21+).
	sh tools/rat/rat-check.sh

stage-local: ## Build the staged site output with the sibling buildish-site-pipeline checkout.
	@if [ ! -x '$(SITE_PIPELINE_BIN)' ]; then \
		echo "Error: expected site-pipeline executable at $(SITE_PIPELINE_BIN)."; \
		echo "Hint: prepare the sibling buildish-site-pipeline checkout and its .venv first."; \
		exit 1; \
	fi
	@if [ ! -f '$(SITE_PIPELINE_CATALOG)' ]; then \
		echo "Error: expected Buildish catalog at $(SITE_PIPELINE_CATALOG)."; \
		exit 1; \
	fi
	@if [ -e '$(SITE_STAGE_ROOT)' ]; then \
		rm -rf '$(SITE_STAGE_ROOT)'; \
	fi
	PYTHONPATH='$(SITE_PIPELINE_REPO_ROOT)/src' '$(SITE_PIPELINE_BIN)' build \
		--workspace-root '$(WORKSPACE_ROOT)' \
		--catalog '$(SITE_PIPELINE_CATALOG)' \
		$(SITE_PIPELINE_ARGS)

stage-watch-local: ## Watch sources and refresh the staged site output with the sibling buildish-site-pipeline checkout.
	@if [ ! -x '$(SITE_PIPELINE_BIN)' ]; then \
		echo "Error: expected site-pipeline executable at $(SITE_PIPELINE_BIN)."; \
		echo "Hint: prepare the sibling buildish-site-pipeline checkout and its .venv first."; \
		exit 1; \
	fi
	@if [ ! -f '$(SITE_PIPELINE_CATALOG)' ]; then \
		echo "Error: expected Buildish catalog at $(SITE_PIPELINE_CATALOG)."; \
		exit 1; \
	fi
	@if [ -e '$(SITE_STAGE_ROOT)' ]; then \
		rm -rf '$(SITE_STAGE_ROOT)'; \
	fi
	PYTHONPATH='$(SITE_PIPELINE_REPO_ROOT)/src' '$(SITE_PIPELINE_BIN)' watch \
		--workspace-root '$(WORKSPACE_ROOT)' \
		--catalog '$(SITE_PIPELINE_CATALOG)' \
		$(SITE_PIPELINE_ARGS)
