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

.DEFAULT_GOAL := build

NPM ?= npm
NODE_MODULES_STAMP := node_modules/.buildish-mammoth-cache-gradle-installed
BUILD_STAMP := dist/.buildish-mammoth-cache-gradle-built
BUILD_INPUTS := package.json tsconfig.json $(shell find src descriptors -type f 2>/dev/null)
INTEGRATION_FIXTURE_INPUTS := $(shell find test/fixtures/integration -type f 2>/dev/null)
INTEGRATION_BUILD_REPORTING_BUNDLE := build/integration-build-reporting.cjs
INTEGRATION_DISTRIBUTED_REUSE_BUNDLE := build/integration-distributed-reuse.cjs
HELP_TARGETS := $(MAKEFILE_LIST)

.PHONY: build check clean clean-all help integration-test-build-reporting integration-test-distributed-reuse lint-check lint-fix rat-check rebuild release-legal-category-x-check release-legal-check sanity-check smoke-test test

help: ## Show available Make targets.
	@awk 'BEGIN {FS = ":.*## "; printf "Available targets:\n"} /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(HELP_TARGETS)

sanity-check: ## Verify the active node and npm versions match the project expectations.
	@command -v node >/dev/null 2>&1 || { \
		echo "Error: node is not available on PATH. Run 'nvm use' first."; \
		exit 1; \
	}
	@command -v $(NPM) >/dev/null 2>&1 || { \
		echo "Error: $(NPM) is not available on PATH. Run 'nvm use' first."; \
		exit 1; \
	}
	@expected_node_version="$$(tr -d '[:space:]' < .nvmrc)"; \
	actual_node_version="$$(node --version | sed 's/^v//')"; \
	if [ "$$actual_node_version" != "$$expected_node_version" ]; then \
		echo "Error: expected node $$expected_node_version but found $$actual_node_version. Run 'nvm use' first."; \
		exit 1; \
	fi
	@expected_npm_version="$$(node -e "const packageJson = JSON.parse(require('fs').readFileSync('package.json', 'utf8')); const packageManager = packageJson.packageManager || ''; const match = /^npm@(.*)$$/.exec(packageManager); if (!match) { throw new Error('package.json packageManager must be set to npm@<version>'); } process.stdout.write(match[1]);")"; \
	actual_npm_version="$$($(NPM) --version)"; \
	if [ "$$actual_npm_version" != "$$expected_npm_version" ]; then \
		echo "Error: expected npm $$expected_npm_version but found $$actual_npm_version. Run 'nvm use' first."; \
		exit 1; \
	fi

$(NODE_MODULES_STAMP): package.json package-lock.json
	$(NPM) ci
	@mkdir -p $(dir $@)
	@touch $@

$(BUILD_STAMP): $(NODE_MODULES_STAMP) $(BUILD_INPUTS)
	$(NPM) run build
	@mkdir -p $(dir $@)
	@touch $@

clean: sanity-check ## Remove generated build outputs.
	$(NPM) run clean

clean-all: clean ## Remove build outputs, node_modules, and legacy lib outputs.
	rm -rf lib node_modules

build: sanity-check $(BUILD_STAMP) ## Perform an incremental-friendly build.

rebuild: clean build ## Perform a fresh rebuild from a clean workspace.

test: build ## Run unit tests after ensuring the project is built.
	$(NPM) run test

lint-check: sanity-check $(NODE_MODULES_STAMP) ## Run linting and formatting checks.
	$(NPM) run lint
	$(NPM) run format

lint-fix: sanity-check $(NODE_MODULES_STAMP) ## Automatically fix lint issues and rewrite formatting.
	$(NPM) exec eslint -- . --fix
	$(NPM) run format:write

rat-check: sanity-check ## Run Apache RAT license-header verification (requires Java 21+).
	$(NPM) run rat-check

release-legal-category-x-check: sanity-check $(NODE_MODULES_STAMP) ## Fail if the bundled GitHub action distribution contains a Category X license.
	$(NPM) run release-legal:check-category-x

release-legal-check: sanity-check $(NODE_MODULES_STAMP) ## Verify legal/github/LICENSE and legal/github/NOTICE for the GitHub action distribution.
	$(NPM) run release-legal:check

smoke-test: build ## Run the bundled-action smoke test against a staged fixture copy.
	$(NPM) run smoke-test

$(INTEGRATION_BUILD_REPORTING_BUNDLE): $(NODE_MODULES_STAMP) scripts/integration-build-reporting.ts $(BUILD_INPUTS) $(INTEGRATION_FIXTURE_INPUTS)
	$(NPM) run compile
	@mkdir -p $(dir $@)
	$(NPM) exec -- esbuild scripts/integration-build-reporting.ts --bundle --platform=node --target=node24 --format=cjs --outfile=$@

$(INTEGRATION_DISTRIBUTED_REUSE_BUNDLE): $(NODE_MODULES_STAMP) scripts/integration-distributed-reuse.ts $(BUILD_INPUTS) $(INTEGRATION_FIXTURE_INPUTS)
	$(NPM) run compile
	@mkdir -p $(dir $@)
	$(NPM) exec -- esbuild scripts/integration-distributed-reuse.ts --bundle --platform=node --target=node24 --format=cjs --outfile=$@

integration-test-build-reporting: sanity-check $(INTEGRATION_BUILD_REPORTING_BUNDLE) ## Run the local multi-build Gradle build-reporting integration test.
	node $(INTEGRATION_BUILD_REPORTING_BUNDLE)

integration-test-distributed-reuse: sanity-check $(INTEGRATION_DISTRIBUTED_REUSE_BUNDLE) ## Run the local worker/aggregator distributed reuse integration test.
	node $(INTEGRATION_DISTRIBUTED_REUSE_BUNDLE)

check: ## Run a full clean verification: clean-all, build, test, lint-check, release-legal-category-x-check, and rat-check.
	$(MAKE) clean-all
	$(MAKE) build
	$(MAKE) test
	$(MAKE) lint-check
	$(MAKE) release-legal-category-x-check
	$(MAKE) rat-check