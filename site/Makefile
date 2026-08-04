#
# Copyright 2026 The Buildish Authors
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

# Keep this file as the public site entrypoint. The heavier implementation lives
# in focused fragments so the developer-facing targets stay easy to discover.
HELP_PUBLIC_COMMON_TARGETS := serve build site-check
HELP_PUBLIC_CHECK_TARGETS := test integration-test check clean
HELP_PUBLIC_NATIVE_TARGETS := serve-local build-local site-check-local
HELP_PUBLIC_ADVANCED_TARGETS := render render-local stage-local stage-watch-local
include make/common.mk
include make/pipeline-local.mk
include make/container.mk

.PHONY: \
	build \
	build-local \
	check \
	clean \
	pipeline-core-check \
	docsy-check \
	help \
	help-all \
	hugo-check \
	integration-test \
	rendered-fallback-check \
	render \
	render-local \
	sanity-check \
	serve \
	serve-local \
	site-check \
	site-check-local \
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
		test -f $(NODE_MODULES_DIR)/@fortawesome/fontawesome-free/scss/fontawesome.scss || { echo "Error: Font Awesome is not available. Run npm install in site/."; exit 1; }; \
		test -d $(NODE_MODULES_DIR)/@fortawesome/fontawesome-free/webfonts || { echo "Error: Font Awesome webfonts are not available. Run npm install in site/."; exit 1; }; \
		test -f $(NODE_MODULES_DIR)/bootstrap/scss/bootstrap.scss || { echo "Error: Bootstrap is not available. Run npm install in site/."; exit 1; }; \
		test -f $(NODE_MODULES_DIR)/bootstrap/dist/js/bootstrap.bundle.js || { echo "Error: Bootstrap JavaScript is not available. Run npm install in site/."; exit 1; }; \
		test -f $(NODE_MODULES_DIR)/jquery/dist/jquery.min.js || { echo "Error: jquery is not available. Run npm install in site/."; exit 1; }; \
		test -f $(NODE_MODULES_DIR)/mermaid/dist/mermaid.min.js || { echo "Error: mermaid is not available. Run npm install in site/."; exit 1; }; \
	test -f $(NODE_MODULES_DIR)/lunr/lunr.min.js || { echo "Error: lunr is not available. Run npm install in site/."; exit 1; }

vendor-assets: docsy-check ## Stage local vendor assets required by the renderer.
	@rm -rf $(HUGO_VENDOR_DIR)
	@mkdir -p $(HUGO_VENDOR_DIR)/bootstrap/dist $(HUGO_VENDOR_DIR)/Font-Awesome
	@cp -R $(NODE_MODULES_DIR)/bootstrap/scss $(HUGO_VENDOR_DIR)/bootstrap/
	@cp -R $(NODE_MODULES_DIR)/bootstrap/dist/js $(HUGO_VENDOR_DIR)/bootstrap/dist/
	@cp -R $(NODE_MODULES_DIR)/@fortawesome/fontawesome-free/scss $(HUGO_VENDOR_DIR)/Font-Awesome/
	@cp -R $(NODE_MODULES_DIR)/@fortawesome/fontawesome-free/webfonts $(HUGO_VENDOR_DIR)/Font-Awesome/
	@mkdir -p static/js/vendor
	@cp $(NODE_MODULES_DIR)/jquery/dist/jquery.min.js static/js/vendor/jquery.min.js
	@cp $(NODE_MODULES_DIR)/mermaid/dist/mermaid.min.js static/js/vendor/mermaid.min.js
	@cp $(NODE_MODULES_DIR)/lunr/lunr.min.js static/js/vendor/lunr.min.js
	@$(DOCSY_ENV); node scripts/generate-third-party-licenses.mjs \
		--node-modules "$(NODE_MODULES_DIR)" \
		--go-mod go.mod \
		--project-license ../LICENSE \
		--output static/third-party-licenses.txt

site-check: container-site-check ## Run the 'site-pipeline check' command to validate the configuration and check for broken links in the build container.

site-check-local: sanity-check ## Run the 'site-pipeline check' command to validate the configuration and check for broken links with host tools.
	$(MAKE) --no-print-directory pipeline-site-check-local

stage: container-stage ## Build the staged site contract and lightweight preview in the build container.

stage-local: sanity-check ## Build the staged site contract and lightweight preview with host tools.
	$(MAKE) --no-print-directory pipeline-stage-local
	$(MAKE) --no-print-directory vendor-assets

stage-watch: container-stage-watch ## Watch sources and rebuild the staged site contract only in the build container.

stage-watch-local: sanity-check ## Watch sources and rebuild the staged site contract only with host tools.
	$(MAKE) --no-print-directory pipeline-watch-local

render: container-render ## Render the current staged site through Hugo in the build container.

render-local: hugo-check docsy-check vendor-assets ## Render the current staged site through Hugo with host tools.
	@$(DOCSY_ENV); $(HUGO) --source . --config hugo.yaml --cleanDestinationDir

rendered-fallback-check: ## Verify curated rendered-site behavior, including real source links.
	@$(PYTHON) scripts/verify_rendered_fallbacks.py --public-root .public

build: container-build ## Build the staged contract and full Hugo site in the build container.

build-local: stage-local render-local ## Build the staged contract and full Hugo site with host tools.

pipeline-core-check: sanity-check ## Run the extracted pipeline repository checks.
	$(MAKE) --no-print-directory -C ../../buildish-site-pipeline check

serve: container-serve ## Serve the full Hugo site with automatic restaging in the build container; override PORT=<port> if needed.

serve-local: sanity-check hugo-check docsy-check vendor-assets ## Serve the full Hugo site with automatic restaging using host tools; override PORT=<port> if needed.
	@watch_pid=''; events_file=''; \
	cleanup() { status=$$?; if [ -n "$$watch_pid" ] && kill -0 "$$watch_pid" 2>/dev/null; then kill "$$watch_pid" 2>/dev/null || true; wait "$$watch_pid" 2>/dev/null || true; fi; if [ -n "$$events_file" ]; then rm -f "$$events_file"; fi; exit $$status; }; \
	trap cleanup EXIT INT TERM; \
	mkdir -p '$(WATCH_EVENTS_ROOT)'; \
	events_file="$$(mktemp '$(WATCH_EVENTS_TEMPLATE)')"; \
	$(MAKE) --silent --no-print-directory pipeline-watch-local SITE_PIPELINE_ARGS="$(SITE_PIPELINE_READY_ARGS) --unstable-events-output $$events_file $(SITE_PIPELINE_ARGS)" & \
	watch_pid=$$!; \
	$(WAIT_FOR_WATCH_READY) --events-file "$$events_file" --pid "$$watch_pid" --timeout $(WATCH_READY_TIMEOUT_SECONDS); \
	$(DOCSY_ENV); $(HUGO) server --source . --config hugo.yaml --baseURL http://127.0.0.1:$(PORT)/ --bind $(HUGO_SERVER_BIND) --port $(PORT) --disableFastRender --noBuildLock --renderToMemory

clean: sanity-check ## Remove generated pipeline and renderer output.
	$(MAKE) --no-print-directory pipeline-clean-local
	rm -rf .public .hugo_build.lock resources $(HUGO_VENDOR_DIR) static/js/vendor static/third-party-licenses.txt

check: ## Run lint, type checks, tests, and build-local.
	$(MAKE) clean
	$(MAKE) pipeline-core-check
	$(MAKE) pipeline-lint
	$(MAKE) pipeline-typecheck
	$(MAKE) test
	$(MAKE) integration-test
	$(MAKE) build-local
	$(MAKE) rendered-fallback-check
