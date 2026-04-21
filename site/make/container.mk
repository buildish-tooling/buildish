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

CONTAINER_ENGINE ?= $(shell if command -v podman >/dev/null 2>&1; then printf 'podman'; elif command -v docker >/dev/null 2>&1; then printf 'docker'; fi)
CONTAINER_IMAGE ?= localhost/buildish-site-build:local
SITE_PIPELINE_CONTAINER_IMAGE ?= localhost/buildish-site-pipeline:local
CONTAINER_WORKSPACE_ROOT ?= /workspace
CONTAINER_SITE_ROOT ?= $(CONTAINER_WORKSPACE_ROOT)/$(REPO_NAME)/site
CONTAINER_SITE_PIPELINE_CATALOG ?= $(CONTAINER_SITE_ROOT)/catalog.yaml
CONTAINER_SITE_PIPELINE_WORKSPACE_ARG ?= $(if $(filter podman docker,$(CONTAINER_ENGINE_BASENAME)),$(CONTAINER_WORKSPACE_ROOT),$(WORKSPACE_ROOT))
CONTAINER_SITE_PIPELINE_CATALOG_ARG ?= $(if $(filter podman docker,$(CONTAINER_ENGINE_BASENAME)),$(CONTAINER_SITE_PIPELINE_CATALOG),$(SITE_PIPELINE_CATALOG))
CONTAINER_BUILD_DIR ?= $(REPO_ROOT)/tools/site-build-image
CONTAINER_HOME ?= $(CONTAINER_SITE_ROOT)/build/.container-home
LOCAL_REGISTRY_TEST_PLATFORMS ?= linux/amd64,linux/arm64
LOCAL_REGISTRY_TEST_TAG ?= integration-test
LOCAL_REGISTRY_TEST_ARGS ?=
HOST_CONTAINER_SCRATCH_ROOT ?= $(CURDIR)/build/container
CONTAINER_SCRATCH_ROOT ?= $(CONTAINER_SITE_ROOT)/build/container
HOST_ARCH ?= $(shell uname -m)

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
# wrapped binaries are handled correctly. Override when auto-detection does not
# match your setup: make CONTAINER_IS_PODMAN=1 or make CONTAINER_IS_PODMAN=0
_container_version    := $(if $(strip $(CONTAINER_ENGINE)),$(shell $(CONTAINER_ENGINE) --version 2>/dev/null))
_container_name_match := $(filter podman,$(CONTAINER_ENGINE_BASENAME))
_container_ver_match  := $(findstring podman,$(_container_version))
CONTAINER_IS_PODMAN   ?= $(if $(or $(_container_name_match),$(_container_ver_match)),1,)
CONTAINER_MOUNT_LABEL      :=
CONTAINER_RO_MOUNT_OPTIONS := :ro
CONTAINER_USERNS_FLAGS     :=
ifneq ($(CONTAINER_IS_PODMAN),)
CONTAINER_MOUNT_LABEL      := :Z
CONTAINER_RO_MOUNT_OPTIONS := :ro,Z
CONTAINER_USERNS_FLAGS     := --userns=keep-id
endif

CONTAINER_CACHE_ENV = \
	-e HOME=$(CONTAINER_HOME) \
	-e XDG_CACHE_HOME=$(CONTAINER_HOME)/.cache \
	-e npm_config_cache=$(CONTAINER_HOME)/.cache/npm \
	-e UV_CACHE_DIR=$(CONTAINER_HOME)/.cache/uv

# Derive component sibling-repo directories from catalog.yaml at parse time.
# localDir entries that contain a '/' point inside the main repo and are already
# covered by the main-repo mount; they are excluded here.
# If parsing fails the build stops immediately with a clear error.
_component_local_dirs := $(shell python3 -c "import yaml; \
data = yaml.safe_load(open('$(CURDIR)/catalog.yaml')); \
dirs = [c['localDir'].split('/')[0] for c in data['components'] \
	        if '/' not in c.get('localDir', '')]; \
print(' '.join(dirs))" 2>/dev/null)
$(if $(_component_local_dirs),,$(error Could not parse component dirs from $(CURDIR)/catalog.yaml))
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
	node_root="$(CONTAINER_HOME)/node-work"; \
	tool_bin="$(CONTAINER_HOME)/tool-bin"; \
	node_inputs_hash_file="$$node_root/.buildish-node-inputs.sha256"; \
	current_node_inputs_hash="$$(cat package.json package-lock.json | sha256sum)"; \
	printf "==> [container] using scratch directory %s\\n" "$$scratch"; \
	mkdir -p "$$scratch/uv-cache" "$$node_root" "$$tool_bin" "$(CONTAINER_HOME)/.cache/npm"; \
	trap "printf \"==> [container] cleaning scratch directory %s\\n\" \"$$scratch\"; rm -rf \"$$scratch\"" EXIT; \
	export UV_CACHE_DIR="$$scratch/uv-cache"; \
	export UV_PROJECT_ENVIRONMENT="$$scratch/uv-venv"; \
	export npm_config_cache="$(CONTAINER_HOME)/.cache/npm"; \
	if [ ! -f "$$tool_bin/npx" ] || ! cmp -s scripts/container-npx "$$tool_bin/npx"; then \
		cp scripts/container-npx "$$tool_bin/npx"; \
		chmod 755 "$$tool_bin/npx"; \
	fi; \
	if [ -f "$$node_inputs_hash_file" ] && [ "$$(cat "$$node_inputs_hash_file")" = "$$current_node_inputs_hash" ] \
		&& [ -x "$$node_root/node_modules/.bin/postcss" ] \
		&& [ -f "$$node_root/node_modules/jquery/dist/jquery.min.js" ] \
		&& [ -f "$$node_root/node_modules/mermaid/dist/mermaid.min.js" ] \
		&& [ -f "$$node_root/node_modules/lunr/lunr.min.js" ]; then \
		printf "==> [container] reusing cached Node dependencies from %s\\n" "$$node_root"; \
	else \
		printf "==> [container] syncing Node dependencies into %s\\n" "$$node_root"; \
		cp package.json package-lock.json "$$node_root"/; \
		npm ci --ignore-scripts --prefix "$$node_root"; \
		printf "%s\\n" "$$current_node_inputs_hash" > "$$node_inputs_hash_file"; \
	fi; \
	export PATH="$$tool_bin:$$node_root/node_modules/.bin:$$PATH"; \
	export NODE_PATH="$$node_root/node_modules"; \
	export NODE_MODULES_DIR="$$node_root/node_modules"

CONTAINER_STAGE_SCRIPT = \
	$(CONTAINER_PREPARE_SITE_ENV); \
	printf "==> [container-stage] running site-pipeline build\\n"; \
	$(SITE_PIPELINE) build --workspace-root $(CONTAINER_SITE_PIPELINE_WORKSPACE_ARG) --catalog $(CONTAINER_SITE_PIPELINE_CATALOG_ARG) $(SITE_PIPELINE_ARGS); \
	printf "==> [container-stage] staged site contract completed\\n"

CONTAINER_SITE_CHECK_SCRIPT = \
	$(CONTAINER_PREPARE_SITE_ENV); \
	printf "==> [container-stage] running site-pipeline check\\n"; \
	$(SITE_PIPELINE) check --report-format text --report-output - --workspace-root $(CONTAINER_SITE_PIPELINE_WORKSPACE_ARG) --catalog $(CONTAINER_SITE_PIPELINE_CATALOG_ARG) $(SITE_PIPELINE_ARGS); \
	printf "==> [container-stage] site check completed\\n"

CONTAINER_STAGE_WATCH_SCRIPT = \
	$(CONTAINER_PREPARE_SITE_ENV); \
	printf "==> [container-stage-watch] running site-pipeline watch\\n"; \
	$(SITE_PIPELINE) watch --workspace-root $(CONTAINER_SITE_PIPELINE_WORKSPACE_ARG) --catalog $(CONTAINER_SITE_PIPELINE_CATALOG_ARG) $(SITE_PIPELINE_ARGS); \
	printf "==> [container-stage-watch] stage watch exited\\n"

CONTAINER_SERVE_SCRIPT = \
	$(CONTAINER_PREPARE_SITE_ENV); \
	watch_pid=''; events_file=''; \
	container_serve_cleanup() { status=$$?; if [ -n "$$watch_pid" ] && kill -0 "$$watch_pid" 2>/dev/null; then kill "$$watch_pid" 2>/dev/null || true; wait "$$watch_pid" 2>/dev/null || true; fi; if [ -n "$$events_file" ]; then rm -f "$$events_file"; fi; exit $$status; }; \
	trap container_serve_cleanup EXIT INT TERM; \
	mkdir -p '$(WATCH_EVENTS_ROOT)'; \
	events_file="$$(mktemp '$(WATCH_EVENTS_TEMPLATE)')"; \
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
( \
	container_name="buildish-site-$(1)-$$PPID-$$BASHPID-$$RANDOM"; \
	run_pid=''; \
	managed_container_cleanup() { \
		status=$$?; \
		trap - EXIT INT TERM; \
		if [ -n "$$run_pid" ] && kill -0 "$$run_pid" 2>/dev/null; then \
			$(CONTAINER_ENGINE) stop -t 0 "$$container_name" >/dev/null 2>&1 || true; \
			wait "$$run_pid" 2>/dev/null || true; \
		fi; \
		$(CONTAINER_ENGINE) rm -f "$$container_name" >/dev/null 2>&1 || true; \
		exit $$status; \
	}; \
	trap managed_container_cleanup EXIT INT TERM; \
	$(2) bash -c '$(3)' & \
	run_pid=$$!; \
	wait "$$run_pid" \
)
endef

.PHONY: \
	container-build \
	container-check-fast \
	container-engine-check \
	container-image \
	container-image-ensure \
	container-image-local-registry-test \
	container-integration-test \
	container-render \
	container-serve \
	container-site-check \
	container-stage \
	container-stage-watch \
	container-test \
	site-pipeline-container-image \
	site-pipeline-container-image-ensure

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

container-site-check: container-image-ensure ## Run the site-pipeline check inside the build container.
	@printf '==> [container-stage] preparing host scratch root %s\n' '$(HOST_CONTAINER_SCRATCH_ROOT)'
	@$(PREPARE_CONTAINER_SCRATCH)
	@$(PREPARE_CONTAINER_STAGE_OUTPUTS)
	@printf '==> [container-stage] starting containerized site checks\n'
	@$(CONTAINER_RUN) bash -c '$(CONTAINER_SITE_CHECK_SCRIPT)'

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

container-serve: container-image-ensure ## Serve the staged site with Hugo and automatic restaging inside the build container.
	@printf '==> [container-serve] preparing host scratch root %s\n' '$(HOST_CONTAINER_SCRATCH_ROOT)'
	@$(PREPARE_CONTAINER_SCRATCH)
	@$(PREPARE_CONTAINER_SERVE_OUTPUTS)
	@mkdir -p '$(WATCH_EVENTS_ROOT)'
	@find '$(WATCH_EVENTS_ROOT)' -maxdepth 1 -type f -name '.watch-events.*.jsonl' -delete
	@rm -f .hugo_build.lock
	@printf '==> [container-serve] starting containerized site server on http://127.0.0.1:%s/\n' '$(PORT)'
	@host_container_serve_cleanup() { status=$$?; find '$(WATCH_EVENTS_ROOT)' -maxdepth 1 -type f -name '.watch-events.*.jsonl' -delete; exit $$status; }; \
	trap host_container_serve_cleanup EXIT INT TERM; \
	$(call RUN_MANAGED_CONTAINER,serve,$(CONTAINER_MANAGED_SERVE_RUN),$(CONTAINER_SERVE_SCRIPT))
