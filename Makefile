#
# Copyright 2026 The Project Nessie Authors
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
NODE_MODULES_STAMP := node_modules/.cache-gradle-installed

.PHONY: build check clean clean-all lint-check lint-fix sanity-check test

sanity-check:
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

$(NODE_MODULES_STAMP): package.json package-lock.json sanity-check
	$(NPM) ci
	@mkdir -p $(dir $@)
	@touch $@

clean: sanity-check
	$(NPM) run clean

clean-all: clean
	rm -rf lib node_modules

build: sanity-check $(NODE_MODULES_STAMP)
	$(NPM) run build

test: sanity-check $(NODE_MODULES_STAMP)
	$(NPM) run test

lint-check: sanity-check $(NODE_MODULES_STAMP)
	$(NPM) run lint
	$(NPM) run format

lint-fix: sanity-check $(NODE_MODULES_STAMP)
	$(NPM) exec eslint -- . --fix
	$(NPM) run format:write

check:
	$(MAKE) clean-all
	$(MAKE) build
	$(MAKE) test
	$(MAKE) lint-check