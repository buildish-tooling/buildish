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

.DEFAULT_GOAL := check

HELP_TARGETS := $(MAKEFILE_LIST)

.PHONY: check clean help rat-check release-check syntax-check test

help: ## Show available Make targets.
	@awk 'BEGIN {FS = ":.*## "; printf "Available targets:\n"} /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-14s %s\n", $$1, $$2}' $(HELP_TARGETS)

syntax-check: ## Verify shell syntax and PowerShell parseability for the helper tool files.
	sh -n buildish-no-gradle-wrapper-jar.sh install.sh scripts/rat-check.sh
	bash -n tests/integration.sh
	pwsh -NoLogo -NoProfile -Command '$$files=@("buildish-no-gradle-wrapper-jar.ps1","install.ps1"); foreach($$file in $$files){ $$tokens=$$null; $$errors=$$null; [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) $$file), [ref]$$tokens, [ref]$$errors); if($$errors.Count -gt 0){ $$errors | ForEach-Object { $$_.ToString() }; exit 1 } }'

test: syntax-check ## Run integration tests for the helper tool.
	bash tests/integration.sh

rat-check: ## Run Apache RAT against tracked files in this tool directory (requires Java 21+).
	sh scripts/rat-check.sh

release-check: test rat-check ## Run the release-oriented verification tasks for this tool.

check: syntax-check test rat-check ## Run the full local verification suite for this tool.

clean: ## Remove generated build outputs for this tool.
	rm -rf build