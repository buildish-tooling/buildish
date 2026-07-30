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

HELP_TARGETS := $(MAKEFILE_LIST)
SITE_MAKE := $(MAKE) --no-print-directory -C site

.PHONY: \
	build \
	build-local \
	check \
	clean \
	help \
	help-all \
	rat-check \
	render-local \
	serve \
	serve-local \
	site-help \
	site-help-all \
	stage-local \
	stage-watch-local

help: ## Show curated repository Make targets.
	@printf "Available targets:\n"; \
	printf "\nRepository maintenance:\n"; \
	printf "  %-18s %s\n" "help" "Show curated repository Make targets."; \
	printf "  %-18s %s\n" "help-all" "Show all repository-root Make targets."; \
	printf "  %-18s %s\n" "rat-check" "Run Apache RAT against tracked files in this repository (requires Java 21+)."; \
	printf "  %-18s %s\n" "check" "Run the non-container site check gate from the repository root."; \
	printf "  %-18s %s\n" "clean" "Remove generated site output with host tools."; \
	printf "\nContainerized site workflows:\n"; \
	printf "  %-18s %s\n" "build" "Build the staged contract and full Hugo site in the containerized site environment."; \
	printf "  %-18s %s\n" "serve" "Serve the full Hugo site with automatic restaging in the containerized site environment."; \
	printf "\nLocal site workflows:\n"; \
	printf "  %-18s %s\n" "stage-local" "Build the staged site contract with host tools."; \
	printf "  %-18s %s\n" "stage-watch-local" "Watch sources and rebuild the staged site contract with host tools."; \
	printf "  %-18s %s\n" "render-local" "Render the current staged site through Hugo with host tools."; \
	printf "  %-18s %s\n" "build-local" "Build the staged contract and full Hugo site with host tools."; \
	printf "  %-18s %s\n" "serve-local" "Serve the full Hugo site with automatic restaging using host tools."; \
	printf "\nSite-specific help:\n"; \
	printf "  %-18s %s\n" "site-help" "Show curated site-specific Make targets from site/Makefile."; \
	printf "  %-18s %s\n" "site-help-all" "Show all site-specific and internal Make targets from site/Makefile."

help-all: ## Show all repository-root Make targets.
	@awk 'BEGIN {FS = ":.*## "; printf "Available targets:\n"} /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-18s %s\n", $$1, $$2}' $(HELP_TARGETS)

rat-check: ## Run Apache RAT against tracked files in this repository (requires Java 21+).
	sh tools/rat/rat-check.sh

check: ## Run the non-container site check gate from the repository root.
	$(SITE_MAKE) check

clean: ## Remove generated site output with host tools.
	$(SITE_MAKE) clean

build: ## Build the staged contract and full Hugo site in the containerized site environment.
	$(SITE_MAKE) build

stage-local: ## Build the staged site contract with host tools.
	$(SITE_MAKE) stage-local

stage-watch-local: ## Watch sources and rebuild the staged site contract with host tools.
	$(SITE_MAKE) stage-watch-local

render-local: ## Render the current staged site through Hugo with host tools.
	$(SITE_MAKE) render-local

build-local: ## Build the staged contract and full Hugo site with host tools.
	$(SITE_MAKE) build-local

serve: ## Serve the full Hugo site with automatic restaging in the containerized site environment.
	$(SITE_MAKE) serve

serve-local: ## Serve the full Hugo site with automatic restaging using host tools.
	$(SITE_MAKE) serve-local

site-help: ## Show curated site-specific Make targets from site/Makefile.
	$(SITE_MAKE) help

site-help-all: ## Show all site-specific and internal Make targets from site/Makefile.
	$(SITE_MAKE) help-all
