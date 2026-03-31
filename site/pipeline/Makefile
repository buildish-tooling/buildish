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

.PHONY: pipeline-stage-local pipeline-watch-local pipeline-clean-local

pipeline-stage-local: sanity-check ## Refresh staged site inputs with host tools.
	$(UV_RUN) $(SITE_PIPELINE) build --repo-root $(PIPELINE_REPO_ROOT) $(SITE_PIPELINE_ARGS)

pipeline-watch-local: sanity-check ## Watch sources and refresh staged site inputs with host tools.
	$(UV_RUN) $(SITE_PIPELINE) watch --repo-root $(PIPELINE_REPO_ROOT) $(SITE_PIPELINE_ARGS)

pipeline-clean-local: sanity-check ## Remove staged site-pipeline output with host tools.
	$(UV_RUN) $(SITE_PIPELINE) clean --repo-root $(PIPELINE_REPO_ROOT) $(SITE_PIPELINE_ARGS)

