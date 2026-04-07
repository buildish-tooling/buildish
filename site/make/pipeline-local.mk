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

SITE_PIPELINE ?= site-pipeline
SITE_PIPELINE_ARGS ?=
PIPELINE_REPO_ROOT ?= ..
PIPELINE_CONSUMER_ROOT ?= $(CURDIR)/pipeline
PIPELINE_VENV ?= $(PIPELINE_CONSUMER_ROOT)/.venv
PIPELINE_REFRESH_SCRIPT ?= pipeline/refresh_latest_snapshot.py
SITE_PIPELINE_BIN ?= $(SITE_PIPELINE_REPO_ROOT)/.venv/bin/site-pipeline
SITE_PIPELINE_CATALOG ?= $(CURDIR)/catalog.yaml
SITE_STAGE_ROOT ?= $(CURDIR)/.stage
PIPELINE_CHECK_REPORT_ARGS ?= --report-format text --report-output -
PIPELINE_UNIT_TEST_PATTERN ?= test_*.py
PIPELINE_INTEGRATION_TEST_PATTERN ?= integration_*_test.py

# Keep the sibling checkout glue and consumer-management targets together so
# site/Makefile can stay as the public entrypoint while this fragment provides
# the local site-pipeline implementation details.
SITE_PIPELINE_LOCAL_BASE_ARGS = \
	--workspace-root '$(WORKSPACE_ROOT)' \
	--catalog '$(SITE_PIPELINE_CATALOG)' \
	$(SITE_PIPELINE_ARGS)

define RUN_PIPELINE_MANAGED_COMMAND
python_cmd='$(PYTHON)'; \
if ! command -v "$$python_cmd" >/dev/null 2>&1; then \
	python_cmd='python3'; \
fi; \
command -v "$$python_cmd" >/dev/null 2>&1 || { \
	echo "Error: neither $(PYTHON) nor python3 is available on PATH."; \
	exit 1; \
}; \
"$$python_cmd" $(PIPELINE_REFRESH_SCRIPT) --consumer-root "$(PIPELINE_CONSUMER_ROOT)" --lock --sync --venv-path "$(PIPELINE_VENV)" -- $(1)
endef

define REQUIRE_SITE_PIPELINE_LOCAL
if [ ! -x '$(SITE_PIPELINE_BIN)' ]; then \
	echo "Error: expected site-pipeline executable at $(SITE_PIPELINE_BIN)."; \
	echo "Hint: prepare the sibling buildish-site-pipeline checkout and its .venv first."; \
	exit 1; \
fi; \
if [ ! -f '$(SITE_PIPELINE_CATALOG)' ]; then \
	echo "Error: expected Buildish catalog at $(SITE_PIPELINE_CATALOG)."; \
	exit 1; \
fi
endef

define RUN_SITE_PIPELINE_LOCAL_COMMAND
$(call REQUIRE_SITE_PIPELINE_LOCAL); \
rm -rf '$(SITE_STAGE_ROOT)'; \
PYTHONPATH='$(SITE_PIPELINE_REPO_ROOT)/src' '$(SITE_PIPELINE_BIN)' $(1) $(2) $(SITE_PIPELINE_LOCAL_BASE_ARGS)
endef

.PHONY: \
	integration-test \
	pipeline-clean-local \
	pipeline-format \
	pipeline-lint \
	pipeline-refresh-local \
	pipeline-site-check-local \
	pipeline-stage-local \
	pipeline-typecheck \
	pipeline-watch-local \
	test

pipeline-refresh-local: sanity-check ## Refresh the consumer to the latest sibling snapshot wheel.
	@$(call RUN_PIPELINE_MANAGED_COMMAND)

pipeline-stage-local: sanity-check ## Build staged site inputs with the sibling site-pipeline checkout.
	@$(call RUN_SITE_PIPELINE_LOCAL_COMMAND,build,)

pipeline-site-check-local: sanity-check ## Run site checks with the sibling site-pipeline checkout.
	@$(call RUN_SITE_PIPELINE_LOCAL_COMMAND,check,$(PIPELINE_CHECK_REPORT_ARGS))

pipeline-watch-local: sanity-check ## Watch sources and refresh staged site inputs with the sibling site-pipeline checkout.
	@$(call RUN_SITE_PIPELINE_LOCAL_COMMAND,watch,)

pipeline-clean-local: sanity-check ## Remove staged site-pipeline output with host tools.
	rm -rf '$(SITE_STAGE_ROOT)'

pipeline-format: sanity-check ## Format Python sources under site/pipeline.
	@$(call RUN_PIPELINE_MANAGED_COMMAND,ruff format $(PIPELINE_CONSUMER_ROOT))

pipeline-lint: sanity-check ## Run Ruff checks for Python sources under site/pipeline.
	@$(call RUN_PIPELINE_MANAGED_COMMAND,ruff check $(PIPELINE_CONSUMER_ROOT))

pipeline-typecheck: sanity-check ## Run Mypy checks for Python sources under site/pipeline.
	@$(call RUN_PIPELINE_MANAGED_COMMAND,mypy --config-file $(PIPELINE_CONSUMER_ROOT)/pyproject.toml $(PIPELINE_CONSUMER_ROOT)/refresh_latest_snapshot.py)

test: sanity-check ## Run unit tests.
	@$(call RUN_PIPELINE_MANAGED_COMMAND,python -m unittest discover -s pipeline/tests -p '$(PIPELINE_UNIT_TEST_PATTERN)' -v)

integration-test: sanity-check ## Run integration tests.
	@$(call RUN_PIPELINE_MANAGED_COMMAND,python -m unittest discover -s pipeline/tests -p '$(PIPELINE_INTEGRATION_TEST_PATTERN)' -v)