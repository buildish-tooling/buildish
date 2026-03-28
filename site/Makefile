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

UV ?= uv
PYTHON ?= python
PORT ?= 8000
UV_RUN := $(UV) run --project . --frozen
HELP_TARGETS := $(MAKEFILE_LIST)

.PHONY: build check clean help sanity-check serve test

help: ## Show available Make targets.
	@awk 'BEGIN {FS = ":.*## "; printf "Available targets:\n"} /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-14s %s\n", $$1, $$2}' $(HELP_TARGETS)

sanity-check: ## Verify uv is available on PATH.
	@command -v $(UV) >/dev/null 2>&1 || { \
		echo "Error: $(UV) is not available on PATH."; \
		exit 1; \
	}

build: sanity-check ## Build the staged site and lightweight local preview.
	$(UV_RUN) $(PYTHON) mvp.py build

serve: sanity-check ## Serve the local preview; override PORT=<port> if needed.
	$(UV_RUN) $(PYTHON) mvp.py serve --port $(PORT)

clean: sanity-check ## Remove generated local preview outputs.
	$(UV_RUN) $(PYTHON) mvp.py clean

test: sanity-check ## Run the site MVP unit tests.
	$(UV_RUN) $(PYTHON) -m unittest discover -s tests -p 'test_*.py' -v

check: ## Run the site verification flow: clean, test, build.
	$(MAKE) clean
	$(MAKE) test
	$(MAKE) build
