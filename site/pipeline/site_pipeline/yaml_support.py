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

"""Helpers for coercing nested values into YAML-safe Python data."""

from __future__ import annotations

from typing import Any

from pydantic import TypeAdapter

from .models.base import YamlModel


_ANY_ADAPTER = TypeAdapter(Any)


def yaml_safe_value(value: Any) -> Any:
    """Convert nested model values into data accepted by ``yaml.safe_dump``."""

    if isinstance(value, YamlModel):
        return value.to_yaml_data()
    if isinstance(value, tuple):
        return [yaml_safe_value(item) for item in value]
    if isinstance(value, list):
        return [yaml_safe_value(item) for item in value]
    if isinstance(value, dict):
        return {key: yaml_safe_value(item) for key, item in value.items()}
    return _ANY_ADAPTER.dump_python(value, mode="json")
