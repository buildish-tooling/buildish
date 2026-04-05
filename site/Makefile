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
.SHELLFLAGS := -eu -o pipefail -c
SHELL := /bin/bash

HUGO ?= hugo
NVM_DIR ?= $(HOME)/.nvm
UV ?= uv
PYTHON ?= python
SITE_PIPELINE ?= site-pipeline
WATCH_READY_TIMEOUT_SECONDS ?= 20
WAIT_FOR_WATCH_READY ?= scripts/wait_for_watch_ready.py
SITE_PIPELINE_READY_ARGS ?= --unstable-events jsonl
PORT ?= 8000
HUGO_SERVER_BIND ?= 127.0.0.1
CONTAINER_ENGINE ?= $(shell if command -v podman >/dev/null 2>&1; then printf 'podman'; elif command -v docker >/dev/null 2>&1; then printf 'docker'; fi)
CONTAINER_IMAGE ?= localhost/buildish-site-build:local
SITE_PIPELINE_CONTAINER_IMAGE ?= localhost/buildish-site-pipeline:local
CONTAINER_HOME ?= $(CONTAINER_SITE_ROOT)/.container-home
LOCAL_REGISTRY_TEST_PLATFORMS ?= linux/amd64,linux/arm64
LOCAL_REGISTRY_TEST_TAG ?= integration-test
LOCAL_REGISTRY_TEST_ARGS ?=
HELP_TARGETS = $(MAKEFILE_LIST)
HELP_PUBLIC_COMMON_TARGETS := serve build
HELP_PUBLIC_CHECK_TARGETS := test integration-test check clean
HELP_PUBLIC_NATIVE_TARGETS := serve-local build-local
HELP_PUBLIC_ADVANCED_TARGETS := render render-local stage-local stage-watch-local
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
SITE_PIPELINE_CATALOG ?= $(REPO_ROOT)/site/components.yaml
CONTAINER_WORKSPACE_ROOT ?= /workspace
CONTAINER_SITE_ROOT ?= $(CONTAINER_WORKSPACE_ROOT)/$(REPO_NAME)/site
CONTAINER_SITE_PIPELINE_CATALOG ?= $(CONTAINER_SITE_ROOT)/components.yaml
CONTAINER_SITE_PIPELINE_WORKSPACE_ARG ?= $(if $(filter podman docker,$(CONTAINER_ENGINE_BASENAME)),$(CONTAINER_WORKSPACE_ROOT),$(WORKSPACE_ROOT))
CONTAINER_SITE_PIPELINE_CATALOG_ARG ?= $(if $(filter podman docker,$(CONTAINER_ENGINE_BASENAME)),$(CONTAINER_SITE_PIPELINE_CATALOG),$(SITE_PIPELINE_CATALOG))
CONTAINER_BUILD_DIR ?= $(REPO_ROOT)/tools/site-build-image
NODE_MODULES_DIR ?= $(CURDIR)/node_modules
HOST_CONTAINER_SCRATCH_ROOT ?= $(CURDIR)/build/container
CONTAINER_SCRATCH_ROOT ?= $(CONTAINER_SITE_ROOT)/build/container
HOST_ARCH ?= $(shell uname -m)
include pipeline/Makefile

ifneq ($(filter x86_64 amd64,$(HOST_ARCH)),)
CONTAINER_PLATFORM ?= linux/amd64
else ifneq ($(filter aarch64 arm64,$(HOST_ARCH)),)
CONTAINER_PLATFORM ?= linux/arm64
endif
CONTAINER_PLATFORM_FLAG :=
ifneq ($(strip $(CONTAINER_PLATFORM)),)
CONTAINER_PLATFORM_FLAG := --platform $(CONTAINER_PLATFORM)
endif
CONTAINER_ENGINE_BASENAME := $(notdir $(CONTAINER_ENGINE))
# Detect Podman by both executable basename and --version output so renamed or
# wrapped binaries are handled correctly.  Override when auto-detection does not
# match your setup: make CONTAINER_IS_PODMAN=1  or  make CONTAINER_IS_PODMAN=0
_container_version    := $(if $(strip $(CONTAINER_ENGINE)),$(shell $(CONTAINER_ENGINE) --version 2>/dev/null))
_container_name_match := $(filter podman,$(CONTAINER_ENGINE_BASENAME))
_container_ver_match  := $(findstring podman,$(_container_version))
CONTAINER_IS_PODMAN   ?= $(if $(or $(_container_name_match),$(_container_ver_match)),1,)
CONTAINER_MOUNT_LABEL     :=
CONTAINER_RO_MOUNT_OPTIONS := :ro
CONTAINER_USERNS_FLAGS    :=
ifneq ($(CONTAINER_IS_PODMAN),)
CONTAINER_MOUNT_LABEL     := :Z
CONTAINER_RO_MOUNT_OPTIONS := :ro,Z
CONTAINER_USERNS_FLAGS    := --userns=keep-id
endif

CONTAINER_CACHE_ENV = \
	-e HOME=$(CONTAINER_HOME) \
	-e XDG_CACHE_HOME=$(CONTAINER_HOME)/.cache \
	-e npm_config_cache=$(CONTAINER_HOME)/.cache/npm \
	-e UV_CACHE_DIR=$(CONTAINER_HOME)/.cache/uv

# Derive component sibling-repo directories from components.yaml at parse time.
# localDir entries that contain a '/' point inside the main repo and are already
# covered by the main-repo mount; they are excluded here.
# If parsing fails the build stops immediately with a clear error.
_component_local_dirs := $(shell python3 -c "import yaml; \
data = yaml.safe_load(open('$(CURDIR)/components.yaml')); \
dirs = [c['localDir'].split('/')[0] for c in data['components'] \
        if '/' not in c.get('localDir', '')]; \
print(' '.join(dirs))" 2>/dev/null)
$(if $(_component_local_dirs),,$(error Could not parse component dirs from $(CURDIR)/components.yaml))
CONTAINER_COMPONENT_MOUNTS = $(foreach d,$(_component_local_dirs),\
	-v $(WORKSPACE_ROOT)/$(d):/workspace/$(d)$(CONTAINER_RO_MOUNT_OPTIONS))
CONTAINER_WORKSPACE_FLAGS = \
	-v $(REPO_ROOT):/workspace/$(REPO_NAME)$(CONTAINER_MOUNT_LABEL) \
	$(CONTAINER_COMPONENT_MOUNTS) \
	-w $(CONTAINER_SITE_ROOT)

CONTAINER_RUN_BASE = \
	$(CONTAINER_ENGINE) run --rm \
	--init \
	$(CONTAINER_PLATFORM_FLAG) \
	$(CONTAINER_USERNS_FLAGS) \
	--user $$(id -u):$$(id -g) \
	$(CONTAINER_CACHE_ENV) \
	$(CONTAINER_WORKSPACE_FLAGS)

CONTAINER_RUN = \
	$(CONTAINER_RUN_BASE) \
	$(CONTAINER_IMAGE)

CONTAINER_MANAGED_RUN = \
	$(CONTAINER_ENGINE) run --rm \
	--name "$$container_name" \
	--init \
	$(CONTAINER_PLATFORM_FLAG) \
	$(CONTAINER_USERNS_FLAGS) \
	--user $$(id -u):$$(id -g) \
	$(CONTAINER_CACHE_ENV) \
	$(CONTAINER_WORKSPACE_FLAGS) \
	$(CONTAINER_IMAGE)

CONTAINER_SERVE_RUN = \
	$(CONTAINER_RUN_BASE) \
	-p 127.0.0.1:$(PORT):$(PORT) \
	$(CONTAINER_IMAGE)

CONTAINER_MANAGED_SERVE_RUN = \
	$(CONTAINER_ENGINE) run --rm \
	--name "$$container_name" \
	--init \
	$(CONTAINER_PLATFORM_FLAG) \
	$(CONTAINER_USERNS_FLAGS) \
	--user $$(id -u):$$(id -g) \
	$(CONTAINER_CACHE_ENV) \
	$(CONTAINER_WORKSPACE_FLAGS) \
	-p 127.0.0.1:$(PORT):$(PORT) \
	$(CONTAINER_IMAGE)

PREPARE_CONTAINER_SCRATCH = \
	mkdir -p '$(HOST_CONTAINER_SCRATCH_ROOT)'; \
	chmod 0700 '$(HOST_CONTAINER_SCRATCH_ROOT)'

PREPARE_CONTAINER_STAGE_OUTPUTS = \
	rm -rf .stage .preview

PREPARE_CONTAINER_SERVE_OUTPUTS = \
	rm -rf .stage .preview .public resources/_gen; \
	mkdir -p .public resources/_gen; \
	chmod 0755 .public resources/_gen

CONTAINER_TEST_SCRIPT = \
	scratch="$$(mktemp -d "$(CONTAINER_SCRATCH_ROOT)/test.XXXXXX")"; \
	chmod 0700 "$$scratch"; \
	mkdir -p "$$scratch/uv-cache"; \
	trap "rm -rf \"$$scratch\"" EXIT; \
	export UV_CACHE_DIR="$$scratch/uv-cache"; \
	export UV_PROJECT_ENVIRONMENT="$$scratch/uv-venv"; \
	make test

CONTAINER_INTEGRATION_TEST_SCRIPT = \
	scratch="$$(mktemp -d "$(CONTAINER_SCRATCH_ROOT)/integration.XXXXXX")"; \
	chmod 0700 "$$scratch"; \
	mkdir -p "$$scratch/uv-cache"; \
	trap "rm -rf \"$$scratch\"" EXIT; \
	export UV_CACHE_DIR="$$scratch/uv-cache"; \
	export UV_PROJECT_ENVIRONMENT="$$scratch/uv-venv"; \
	export BUILDISH_SITE_FIXTURE_WORKSPACE="$$scratch/workspace"; \
	make integration-test

CONTAINER_PREPARE_SITE_ENV = \
	set -euo pipefail; \
	scratch="$$(mktemp -d "$(CONTAINER_SCRATCH_ROOT)/run.XXXXXX")"; \
	chmod 0700 "$$scratch"; \
	node_root="$$scratch/node-work"; \
	tool_bin="$$scratch/tool-bin"; \
	printf "==> [container] using scratch directory %s\\n" "$$scratch"; \
	mkdir -p "$$scratch/uv-cache" "$$scratch/npm-cache" "$$node_root" "$$tool_bin"; \
	trap "printf \"==> [container] cleaning scratch directory %s\\n\" \"$$scratch\"; rm -rf \"$$scratch\"" EXIT; \
	export UV_CACHE_DIR="$$scratch/uv-cache"; \
	export UV_PROJECT_ENVIRONMENT="$$scratch/uv-venv"; \
	export npm_config_cache="$$scratch/npm-cache"; \
	printf "==> [container] installing Node dependencies into %s\\n" "$$node_root"; \
	cp package.json package-lock.json "$$node_root"/; \
	npm ci --ignore-scripts --prefix "$$node_root"; \
	cp scripts/container-npx "$$tool_bin/npx"; \
	chmod 755 "$$tool_bin/npx"; \
	export PATH="$$tool_bin:$$node_root/node_modules/.bin:$$PATH"; \
	export NODE_PATH="$$node_root/node_modules"; \
	export NODE_MODULES_DIR="$$node_root/node_modules"

CONTAINER_STAGE_SCRIPT = \
	$(CONTAINER_PREPARE_SITE_ENV); \
	printf "==> [container-stage] running site-pipeline build\\n"; \
	$(SITE_PIPELINE) build --workspace-root $(CONTAINER_SITE_PIPELINE_WORKSPACE_ARG) --catalog $(CONTAINER_SITE_PIPELINE_CATALOG_ARG) $(SITE_PIPELINE_ARGS); \
	printf "==> [container-stage] staged site contract completed\\n"

CONTAINER_STAGE_WATCH_SCRIPT = \
	$(CONTAINER_PREPARE_SITE_ENV); \
	printf "==> [container-stage-watch] running site-pipeline watch\\n"; \
	$(SITE_PIPELINE) watch --workspace-root $(CONTAINER_SITE_PIPELINE_WORKSPACE_ARG) --catalog $(CONTAINER_SITE_PIPELINE_CATALOG_ARG) $(SITE_PIPELINE_ARGS); \
	printf "==> [container-stage-watch] stage watch exited\\n"

CONTAINER_SERVE_SCRIPT = \
	$(CONTAINER_PREPARE_SITE_ENV); \
	watch_pid=''; events_file=''; \
	cleanup() { status=$$?; if [ -n "$$watch_pid" ] && kill -0 "$$watch_pid" 2>/dev/null; then kill "$$watch_pid" 2>/dev/null || true; wait "$$watch_pid" 2>/dev/null || true; fi; if [ -n "$$events_file" ]; then rm -f "$$events_file"; fi; exit $$status; }; \
	trap cleanup EXIT INT TERM; \
	events_file="$$(mktemp .watch-events.XXXXXX.jsonl)"; \
	printf "==> [container-serve] running site-pipeline watch on %s:%s\n" "0.0.0.0" "$(PORT)"; \
	$(SITE_PIPELINE) watch --workspace-root $(CONTAINER_SITE_PIPELINE_WORKSPACE_ARG) --catalog $(CONTAINER_SITE_PIPELINE_CATALOG_ARG) $(SITE_PIPELINE_READY_ARGS) --unstable-events-output "$$events_file" $(SITE_PIPELINE_ARGS) & \
	watch_pid=$$!; \
	$(WAIT_FOR_WATCH_READY) --events-file "$$events_file" --pid "$$watch_pid" --timeout $(WATCH_READY_TIMEOUT_SECONDS); \
	$(DOCSY_ENV); $(HUGO) server --source . --config hugo.yaml --baseURL http://127.0.0.1:$(PORT)/ --bind 0.0.0.0 --port $(PORT) --poll 700ms --disableFastRender --noBuildLock --renderToMemory; \
	printf "==> [container-serve] serve exited\n"

CONTAINER_RENDER_SCRIPT = \
	$(CONTAINER_PREPARE_SITE_ENV); \
	printf "==> [container-render] running make render-local\\n"; \
	make render-local; \
	printf "==> [container-render] site render completed\\n"

CONTAINER_BUILD_SCRIPT = \
	$(CONTAINER_PREPARE_SITE_ENV); \
	printf "==> [container-build] running site-pipeline build and make render-local\\n"; \
	$(SITE_PIPELINE) build --workspace-root $(CONTAINER_SITE_PIPELINE_WORKSPACE_ARG) --catalog $(CONTAINER_SITE_PIPELINE_CATALOG_ARG) $(SITE_PIPELINE_ARGS); \
	make render-local; \
	printf "==> [container-build] site render completed\\n"

define RUN_MANAGED_CONTAINER
container_name="buildish-site-$(1)-$$PPID-$$BASHPID-$$RANDOM"; \
run_pid=''; \
cleanup() { \
	status=$$?; \
	trap - EXIT INT TERM; \
	if [ -n "$$run_pid" ] && kill -0 "$$run_pid" 2>/dev/null; then \
		$(CONTAINER_ENGINE) stop -t 0 "$$container_name" >/dev/null 2>&1 || true; \
		wait "$$run_pid" 2>/dev/null || true; \
	fi; \
	$(CONTAINER_ENGINE) rm -f "$$container_name" >/dev/null 2>&1 || true; \
	exit $$status; \
}; \
trap cleanup EXIT INT TERM; \
$(2) bash -c '$(3)' & \
run_pid=$$!; \
wait "$$run_pid"
endef

.PHONY: \
	build \
	check \
	clean \
	container-engine-check \
	container-build \
	container-render \
	container-check-fast \
	container-image \
		site-pipeline-container-image \
		site-pipeline-container-image-ensure \
	container-image-ensure \
	container-image-local-registry-test \
	container-integration-test \
	pipeline-format \
	pipeline-core-check \
	pipeline-lint \
	pipeline-typecheck \
	container-serve \
	container-stage \
	container-stage-watch \
	container-test \
	docsy-check \
	help \
	help-all \
	hugo-check \
	integration-test \
	render \
	render-local \
	sanity-check \
	serve \
	build-local \
	serve-local \
	stage \
	stage-local \
	stage-watch \
	stage-watch-local \
	test \
	vendor-assets

help: ## Show the curated Make targets for common site workflows.
	@desc_for() { awk -v target="$$1" 'BEGIN {FS = ":.*## "} $$1 == target {print $$2; exit}' $(HELP_TARGETS); }; \
	print_section() { title="$$1"; shift; printf "\n%s\n" "$$title"; for target in "$$@"; do printf "  %-18s %s\n" "$$target" "$$(desc_for "$$target")"; done; }; \
	printf "Available targets:\n"; \
	print_section "Common workflows:" $(HELP_PUBLIC_COMMON_TARGETS); \
	print_section "Checks and cleanup:" $(HELP_PUBLIC_CHECK_TARGETS); \
	print_section "Host-tool workflows:" $(HELP_PUBLIC_NATIVE_TARGETS); \
	print_section "Less common workflows:" $(HELP_PUBLIC_ADVANCED_TARGETS); \
	printf "\nFor advanced/internal targets, run 'make help-all'.\n"

help-all: ## Show all Make targets, including advanced/internal ones.
	@awk 'BEGIN {FS = ":.*## "; printf "Available targets:\n"} /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-18s %s\n", $$1, $$2}' $(HELP_TARGETS)

sanity-check: ## Verify uv is available on PATH.
	@command -v $(UV) >/dev/null 2>&1 || { \
		echo "Error: $(UV) is not available on PATH."; \
		exit 1; \
	}

hugo-check: ## Verify Hugo is available on PATH.
	@command -v $(HUGO) >/dev/null 2>&1 || { \
		echo "Error: $(HUGO) is not available on PATH."; \
		exit 1; \
	}

docsy-check: ## Verify Node/PostCSS tooling for Docsy is available.
	@$(DOCSY_ENV); command -v node >/dev/null 2>&1 || { echo "Error: node is not available (expected via nvm)."; exit 1; }; \
		command -v postcss >/dev/null 2>&1 || { echo "Error: postcss is not available. Run npm install in site/."; exit 1; }; \
		test -f $(NODE_MODULES_DIR)/jquery/dist/jquery.min.js || { echo "Error: jquery is not available. Run npm install in site/."; exit 1; }; \
		test -f $(NODE_MODULES_DIR)/mermaid/dist/mermaid.min.js || { echo "Error: mermaid is not available. Run npm install in site/."; exit 1; }; \
	test -f $(NODE_MODULES_DIR)/lunr/lunr.min.js || { echo "Error: lunr is not available. Run npm install in site/."; exit 1; }

vendor-assets: docsy-check ## Stage local vendor assets required by the renderer.
	@mkdir -p .stage/static/js/vendor
	@cp $(NODE_MODULES_DIR)/jquery/dist/jquery.min.js .stage/static/js/vendor/jquery.min.js
	@cp $(NODE_MODULES_DIR)/mermaid/dist/mermaid.min.js .stage/static/js/vendor/mermaid.min.js
	@cp $(NODE_MODULES_DIR)/lunr/lunr.min.js .stage/static/js/vendor/lunr.min.js

stage: container-stage ## Build the staged site contract and lightweight preview in the build container.

stage-local: sanity-check ## Build the staged site contract and lightweight preview with host tools.
	$(MAKE) --no-print-directory pipeline-stage-local

stage-watch: container-stage-watch ## Watch sources and rebuild the staged site contract only in the build container.

stage-watch-local: sanity-check ## Watch sources and rebuild the staged site contract only with host tools.
	$(MAKE) --no-print-directory pipeline-watch-local

render: container-render ## Render the current staged site through Hugo in the build container.

render-local: hugo-check docsy-check vendor-assets ## Render the current staged site through Hugo with host tools.
	@$(DOCSY_ENV); $(HUGO) --source . --config hugo.yaml --cleanDestinationDir

build: container-build ## Build the staged contract and full Hugo site in the build container.

build-local: stage-local render-local ## Build the staged contract and full Hugo site with host tools.

pipeline-core-check: sanity-check ## Run the extracted pipeline repository checks.
	$(MAKE) --no-print-directory -C ../../buildish-site-pipeline check

container-engine-check: ## Verify Podman or Docker is available for containerized site targets.
	@engine='$(strip $(CONTAINER_ENGINE))'; \
	if [ -z "$$engine" ]; then \
		echo "Error: no supported container engine detected. Install podman or docker, or set CONTAINER_ENGINE=<engine>."; \
		exit 1; \
	fi; \
	command -v "$$engine" >/dev/null 2>&1 || { echo "Error: $$engine is not available on PATH."; exit 1; }

site-pipeline-container-image-ensure: container-engine-check ## Build the generic site-pipeline base image if it is missing locally.
	@if $(CONTAINER_ENGINE) image inspect $(SITE_PIPELINE_CONTAINER_IMAGE) >/dev/null 2>&1 \
		&& { [ '$(CONTAINER_ENGINE_BASENAME)' != 'podman' ] && [ '$(CONTAINER_ENGINE_BASENAME)' != 'docker' ] \
			|| $(CONTAINER_ENGINE) run --rm $(CONTAINER_PLATFORM_FLAG) --entrypoint /bin/bash $(SITE_PIPELINE_CONTAINER_IMAGE) -c 'site-pipeline build --help | grep -q -- --workspace-root' >/dev/null 2>&1; }; then \
		printf '==> [site-pipeline-image] using existing image %s via %s\n' '$(SITE_PIPELINE_CONTAINER_IMAGE)' '$(CONTAINER_ENGINE_BASENAME)'; \
	else \
		printf '==> [site-pipeline-image] rebuilding image %s via %s to match the current CLI\n' '$(SITE_PIPELINE_CONTAINER_IMAGE)' '$(CONTAINER_ENGINE_BASENAME)'; \
		$(MAKE) site-pipeline-container-image; \
	fi

site-pipeline-container-image: container-engine-check ## Build the generic site-pipeline base image from the extracted repo checkout.
	@if [ ! -d '$(SITE_PIPELINE_REPO_ROOT)' ]; then \
		echo "Error: expected extracted pipeline checkout at $(SITE_PIPELINE_REPO_ROOT)."; \
		exit 1; \
	fi
	$(MAKE) --no-print-directory -C $(SITE_PIPELINE_REPO_ROOT) \
		container-image \
		CONTAINER_ENGINE=$(CONTAINER_ENGINE_BASENAME) \
		CONTAINER_IMAGE=$(SITE_PIPELINE_CONTAINER_IMAGE) \
		CONTAINER_IMAGE_PLATFORMS=$(CONTAINER_PLATFORM)

container-image-ensure: site-pipeline-container-image-ensure ## Build the site builder image if it is missing locally.
	@if $(CONTAINER_ENGINE) image inspect $(CONTAINER_IMAGE) >/dev/null 2>&1 \
		&& { [ '$(CONTAINER_ENGINE_BASENAME)' != 'podman' ] && [ '$(CONTAINER_ENGINE_BASENAME)' != 'docker' ] \
			|| $(CONTAINER_ENGINE) run --rm $(CONTAINER_PLATFORM_FLAG) --entrypoint /bin/bash $(CONTAINER_IMAGE) -c 'site-pipeline build --help | grep -q -- --workspace-root' >/dev/null 2>&1; }; then \
		printf '==> [container-image] using existing image %s via %s\n' '$(CONTAINER_IMAGE)' '$(CONTAINER_ENGINE_BASENAME)'; \
	else \
		printf '==> [container-image] rebuilding image %s via %s to match the current CLI\n' '$(CONTAINER_IMAGE)' '$(CONTAINER_ENGINE_BASENAME)'; \
		$(MAKE) container-image; \
	fi

container-image: site-pipeline-container-image-ensure ## Build the Buildish-derived container image used for reproducible site builds.
	$(CONTAINER_ENGINE) build \
		$(CONTAINER_PLATFORM_FLAG) \
		-t $(CONTAINER_IMAGE) \
		--build-arg SITE_PIPELINE_BASE_IMAGE=$(SITE_PIPELINE_CONTAINER_IMAGE) \
		-f $(CONTAINER_BUILD_DIR)/Containerfile \
		$(CONTAINER_BUILD_DIR)

container-test: container-image ## Run the site unit tests inside the build container.
	@$(PREPARE_CONTAINER_SCRATCH)
	@$(CONTAINER_RUN) bash -c '$(CONTAINER_TEST_SCRIPT)'

container-integration-test: container-image ## Run the fixture integration test inside the build container.
	@$(PREPARE_CONTAINER_SCRATCH)
	@$(CONTAINER_RUN) bash -c '$(CONTAINER_INTEGRATION_TEST_SCRIPT)'

container-check-fast: container-test container-integration-test ## Run the fast containerized verification path for interactive use.

container-stage: container-image-ensure ## Build the staged site contract and lightweight Python preview inside the build container.
	@printf '==> [container-stage] preparing host scratch root %s\n' '$(HOST_CONTAINER_SCRATCH_ROOT)'
	@$(PREPARE_CONTAINER_SCRATCH)
	@$(PREPARE_CONTAINER_STAGE_OUTPUTS)
	@printf '==> [container-stage] starting containerized site staging\n'
	@$(CONTAINER_RUN) bash -c '$(CONTAINER_STAGE_SCRIPT)'

container-stage-watch: container-image-ensure ## Watch site inputs and rebuild the staged site contract inside the build container.
	@printf '==> [container-stage-watch] preparing host scratch root %s\n' '$(HOST_CONTAINER_SCRATCH_ROOT)'
	@$(PREPARE_CONTAINER_SCRATCH)
	@$(PREPARE_CONTAINER_STAGE_OUTPUTS)
	@printf '==> [container-stage-watch] starting containerized site watch\n'
	@$(call RUN_MANAGED_CONTAINER,stage-watch,$(CONTAINER_MANAGED_RUN),$(CONTAINER_STAGE_WATCH_SCRIPT))

container-render: container-image-ensure ## Render the staged site through Hugo inside the build container.
	@printf '==> [container-render] preparing host scratch root %s\n' '$(HOST_CONTAINER_SCRATCH_ROOT)'
	@$(PREPARE_CONTAINER_SCRATCH)
	@rm -f .hugo_build.lock
	@printf '==> [container-render] starting containerized site render\n'
	@$(CONTAINER_RUN) bash -c '$(CONTAINER_RENDER_SCRIPT)'

container-build: container-image-ensure ## Build the staged site and Hugo output inside the build container.
	@printf '==> [container-build] preparing host scratch root %s\n' '$(HOST_CONTAINER_SCRATCH_ROOT)'
	@$(PREPARE_CONTAINER_SCRATCH)
	@$(PREPARE_CONTAINER_STAGE_OUTPUTS)
	@rm -f .hugo_build.lock
	@printf '==> [container-build] starting containerized site render\n'
	@$(CONTAINER_RUN) bash -c '$(CONTAINER_BUILD_SCRIPT)'

container-image-local-registry-test: container-engine-check ## Run the localhost-registry integration test for the builder image.
	$(MAKE) --no-print-directory -C $(SITE_PIPELINE_REPO_ROOT) \
		container-image \
		CONTAINER_ENGINE=$(CONTAINER_ENGINE_BASENAME) \
		CONTAINER_IMAGE=$(SITE_PIPELINE_CONTAINER_IMAGE) \
		CONTAINER_IMAGE_PLATFORMS=$(LOCAL_REGISTRY_TEST_PLATFORMS)
	SITE_PIPELINE_BASE_IMAGE=$(SITE_PIPELINE_CONTAINER_IMAGE) \
		$(CONTAINER_BUILD_DIR)/test-local-registry.sh --platforms '$(LOCAL_REGISTRY_TEST_PLATFORMS)' --tag '$(LOCAL_REGISTRY_TEST_TAG)' $(LOCAL_REGISTRY_TEST_ARGS)

serve: container-serve ## Serve the full Hugo site with automatic restaging in the build container; override PORT=<port> if needed.

serve-local: sanity-check hugo-check docsy-check ## Serve the full Hugo site with automatic restaging using host tools; override PORT=<port> if needed.
	@watch_pid=''; events_file=''; \
	cleanup() { status=$$?; if [ -n "$$watch_pid" ] && kill -0 "$$watch_pid" 2>/dev/null; then kill "$$watch_pid" 2>/dev/null || true; wait "$$watch_pid" 2>/dev/null || true; fi; if [ -n "$$events_file" ]; then rm -f "$$events_file"; fi; exit $$status; }; \
	trap cleanup EXIT INT TERM; \
	events_file="$$(mktemp .watch-events.XXXXXX.jsonl)"; \
	$(MAKE) --silent --no-print-directory pipeline-watch-local SITE_PIPELINE_ARGS="$(SITE_PIPELINE_READY_ARGS) --unstable-events-output $$events_file $(SITE_PIPELINE_ARGS)" & \
	watch_pid=$$!; \
	$(WAIT_FOR_WATCH_READY) --events-file "$$events_file" --pid "$$watch_pid" --timeout $(WATCH_READY_TIMEOUT_SECONDS); \
	$(DOCSY_ENV); $(HUGO) server --source . --config hugo.yaml --baseURL http://127.0.0.1:$(PORT)/ --bind $(HUGO_SERVER_BIND) --port $(PORT) --disableFastRender --noBuildLock --renderToMemory

container-serve: container-image-ensure ## Serve the staged site with Hugo and automatic restaging inside the build container.
	@printf '==> [container-serve] preparing host scratch root %s\n' '$(HOST_CONTAINER_SCRATCH_ROOT)'
	@$(PREPARE_CONTAINER_SCRATCH)
	@$(PREPARE_CONTAINER_SERVE_OUTPUTS)
	@rm -f .hugo_build.lock
	@printf '==> [container-serve] starting containerized site server on http://127.0.0.1:%s/\n' '$(PORT)'
	@$(call RUN_MANAGED_CONTAINER,serve,$(CONTAINER_MANAGED_SERVE_RUN),$(CONTAINER_SERVE_SCRIPT))

clean: sanity-check ## Remove generated pipeline and renderer output.
	$(MAKE) --no-print-directory pipeline-clean-local
	rm -rf .public .hugo_build.lock resources

pipeline-format: sanity-check ## Format Python sources under site/pipeline.
	@$(call RUN_PIPELINE_MANAGED_COMMAND,ruff format $(PIPELINE_CONSUMER_ROOT))

pipeline-lint: sanity-check ## Run Ruff checks for Python sources under site/pipeline.
	@$(call RUN_PIPELINE_MANAGED_COMMAND,ruff check $(PIPELINE_CONSUMER_ROOT))

pipeline-typecheck: sanity-check ## Run Mypy checks for Python sources under site/pipeline.
	@$(call RUN_PIPELINE_MANAGED_COMMAND,mypy --config-file $(PIPELINE_CONSUMER_ROOT)/pyproject.toml $(PIPELINE_CONSUMER_ROOT)/refresh_latest_snapshot.py)

test: sanity-check ## Run unit tests.
	@$(call RUN_PIPELINE_MANAGED_COMMAND,python -m unittest discover -s pipeline/tests -p 'test_*.py' -v)

integration-test: sanity-check ## Run integration tests.
	@$(call RUN_PIPELINE_MANAGED_COMMAND,python -m unittest discover -s pipeline/tests -p 'integration_*_test.py' -v)

check: ## Run lint, type checks, tests, and build-local.
	$(MAKE) clean
	$(MAKE) pipeline-core-check
	$(MAKE) pipeline-lint
	$(MAKE) pipeline-typecheck
	$(MAKE) test
	$(MAKE) integration-test
	$(MAKE) build-local
