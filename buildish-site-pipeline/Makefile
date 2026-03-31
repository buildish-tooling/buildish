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

UV_RUN = uv run --frozen

.PHONY: lint typecheck test check

lint:
	$(UV_RUN) ruff check main.py apache_buildish_site_pipeline tests

typecheck:
	$(UV_RUN) mypy

test:
	$(UV_RUN) python -m unittest discover -s tests -p 'test_*.py' -v

check: lint typecheck test

