# Copyright 2026 The Apache Software Foundation
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

SITE_PIPELINE ?= site-pipeline
SITE_PIPELINE_ARGS ?=
PIPELINE_REPO_ROOT ?= ..

.PHONY: pipeline-refresh-local pipeline-stage-local pipeline-watch-local pipeline-clean-local

pipeline-refresh-local: sanity-check ## Refresh the consumer to the latest sibling snapshot wheel.
	@python_cmd='$(PYTHON)'; \
	if ! command -v "$$python_cmd" >/dev/null 2>&1; then \
		python_cmd='python3'; \
	fi; \
	command -v "$$python_cmd" >/dev/null 2>&1 || { \
		echo "Error: neither $(PYTHON) nor python3 is available on PATH."; \
		exit 1; \
	}; \
	"$$python_cmd" pipeline/refresh_latest_snapshot.py --lock

pipeline-stage-local: pipeline-refresh-local ## Refresh staged site inputs with host tools.
	$(UV_RUN) $(SITE_PIPELINE) build --repo-root $(PIPELINE_REPO_ROOT) $(SITE_PIPELINE_ARGS)

pipeline-watch-local: pipeline-refresh-local ## Watch sources and refresh staged site inputs with host tools.
	$(UV_RUN) $(SITE_PIPELINE) watch --repo-root $(PIPELINE_REPO_ROOT) $(SITE_PIPELINE_ARGS)

pipeline-clean-local: pipeline-refresh-local ## Remove staged site-pipeline output with host tools.
	$(UV_RUN) $(SITE_PIPELINE) clean --repo-root $(PIPELINE_REPO_ROOT) $(SITE_PIPELINE_ARGS)

