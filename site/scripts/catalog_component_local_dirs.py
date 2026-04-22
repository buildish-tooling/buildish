#!/usr/bin/env python3
#
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

"""Print sibling component repo directories from a site catalog."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

MAKE_SUCCESS_SENTINEL = "__BUILDISH_COMPONENT_DIRS_OK__"


def fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


def load_catalog(catalog_path: Path) -> dict[str, Any]:
    try:
        import yaml
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "host-side catalog parsing for containerized Make targets requires "
            f"PyYAML on the machine running make ({exc}). Install python3-yaml and retry."
        ) from exc

    try:
        with catalog_path.open(encoding="utf-8") as handle:
            data = yaml.safe_load(handle)
    except FileNotFoundError as exc:
        raise RuntimeError(f"cannot read catalog '{catalog_path}': {exc.strerror}.") from exc
    except yaml.YAMLError as exc:
        raise RuntimeError(f"cannot parse catalog '{catalog_path}': {exc}") from exc
    except OSError as exc:
        raise RuntimeError(f"cannot read catalog '{catalog_path}': {exc}") from exc

    if not isinstance(data, dict):
        raise RuntimeError(f"catalog '{catalog_path}' must be a YAML mapping.")
    return data


def component_local_dirs(catalog: dict[str, Any], catalog_path: Path) -> list[str]:
    components = catalog.get("components")
    if not isinstance(components, list):
        raise RuntimeError(f"catalog '{catalog_path}' must define 'components' as a list.")

    dirs: list[str] = []
    for index, component in enumerate(components, start=1):
        if not isinstance(component, dict):
            raise RuntimeError(
                f"catalog '{catalog_path}' has a non-mapping component entry at index {index}."
            )
        local_dir = component.get("localDir", "")
        if not isinstance(local_dir, str):
            raise RuntimeError(
                f"catalog '{catalog_path}' component {index} has a non-string localDir."
            )
        if not local_dir or "/" in local_dir:
            continue
        if local_dir not in dirs:
            dirs.append(local_dir)
    return dirs


def main(argv: list[str]) -> int:
    emit_make_output = False
    if len(argv) == 3 and argv[1] == "--make":
        emit_make_output = True
        catalog_arg = argv[2]
    elif len(argv) == 2:
        catalog_arg = argv[1]
    else:
        return fail(f"Usage: {Path(argv[0]).name} [--make] <catalog-path>")

    catalog_path = Path(catalog_arg).resolve()
    try:
        catalog = load_catalog(catalog_path)
        dirs = component_local_dirs(catalog, catalog_path)
        if emit_make_output:
            output = " ".join([MAKE_SUCCESS_SENTINEL, *dirs])
            print(output)
        else:
            print(" ".join(dirs))
    except RuntimeError as exc:
        return fail(f"Error: {exc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
