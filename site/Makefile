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
PORT ?= 8000
UV_RUN := $(UV) run --project . --frozen
HELP_TARGETS := $(MAKEFILE_LIST)
DOCSY_ENV = export NVM_DIR="$(NVM_DIR)"; [ -s "$$NVM_DIR/nvm.sh" ] && . "$$NVM_DIR/nvm.sh"; if [ -f .nvmrc ]; then nvm use --silent >/dev/null; fi; export PATH="$(CURDIR)/node_modules/.bin:$$PATH"

.PHONY: build check clean docsy-check help hugo-check render sanity-check serve stage test vendor-assets

help: ## Show available Make targets.
	@awk 'BEGIN {FS = ":.*## "; printf "Available targets:\n"} /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-14s %s\n", $$1, $$2}' $(HELP_TARGETS)

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
	test -f node_modules/jquery/dist/jquery.min.js || { echo "Error: jquery is not available. Run npm install in site/."; exit 1; }; \
	test -f node_modules/mermaid/dist/mermaid.esm.min.mjs || { echo "Error: mermaid is not available. Run npm install in site/."; exit 1; }

vendor-assets: docsy-check ## Stage local vendor assets required by the renderer.
	@mkdir -p .stage/static/js/vendor
	@cp node_modules/jquery/dist/jquery.min.js .stage/static/js/vendor/jquery.min.js
	@cp node_modules/mermaid/dist/mermaid.esm.min.mjs .stage/static/js/vendor/mermaid.esm.min.mjs

stage: sanity-check ## Build the staged site contract and lightweight Python preview.
	$(UV_RUN) $(PYTHON) mvp.py build

render: hugo-check docsy-check vendor-assets ## Render the staged site through local Hugo.
	@$(DOCSY_ENV); $(HUGO) --source . --config hugo.yaml --cleanDestinationDir

build: stage render ## Build staged content and render the local Hugo site.

serve: stage hugo-check docsy-check vendor-assets ## Serve the staged site with local Hugo; override PORT=<port> if needed.
	@$(DOCSY_ENV); $(HUGO) server --source . --config hugo.yaml --port $(PORT)

clean: sanity-check ## Remove generated local preview outputs.
	$(UV_RUN) $(PYTHON) mvp.py clean
	rm -rf .public .hugo_build.lock resources

test: sanity-check ## Run the site MVP unit tests.
	$(UV_RUN) $(PYTHON) -m unittest discover -s tests -p 'test_*.py' -v

check: ## Run the site verification flow: clean, test, build.
	$(MAKE) clean
	$(MAKE) test
	$(MAKE) build
