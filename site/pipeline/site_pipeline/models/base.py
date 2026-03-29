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

"""Shared base helpers for the site pipeline's YAML-backed models."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, ValidationError
import yaml


def _snake_to_camel(value: str) -> str:
    """Convert ``snake_case`` names into the YAML contract's ``camelCase`` form."""

    first, *rest = value.split("_")
    return first + "".join(part[:1].upper() + part[1:] for part in rest)


class YamlModel(BaseModel):
    """Base model for plain YAML contracts validated with Pydantic."""

    model_config = ConfigDict(
        alias_generator=_snake_to_camel,
        populate_by_name=True,
        extra="forbid",
        frozen=True,
    )

    @classmethod
    def from_yaml_path(cls: type[Self], path: Path) -> Self:
        """Load and validate a YAML mapping from ``path`` into this model type."""

        with path.open("r", encoding="utf-8") as handle:
            payload = yaml.safe_load(handle)
        if not isinstance(payload, dict):
            raise ValueError(f"Expected mapping in {path}")
        try:
            return cls.model_validate(payload)
        except ValidationError as exc:
            raise ValueError(f"Invalid YAML in {path}: {exc}") from exc

    def to_yaml_data(self) -> dict[str, Any]:
        """Serialize the model into plain YAML-safe Python data."""

        return self._to_yaml_data()

    def _to_yaml_data(self, *, exclude_none: bool = False) -> dict[str, Any]:
        """Serialize the model into YAML-safe data with optional null elision."""

        return self.model_dump(by_alias=True, mode="json", exclude_none=exclude_none)