---
# Copyright 2026 The Buildish Authors
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
title: About Buildish
description: What Buildish provides, who it serves, and how its components fit together.
type: docs
weight: 5
---

Buildish provides focused tools for people maintaining builds, CI workflows,
project documentation, and release automation. Each component can be used and
developed independently; the family shares community, security, licensing, and
website infrastructure.

This aggregate repository owns those project-wide files, the component catalog,
the Buildish Website renderer, and site publication. It does not contain every
component implementation and is not itself a build system. Site Pipeline
assembles validated, renderer-neutral content from the component repositories;
the Website component renders that content with Hugo and Docsy.

Buildish has not published a release. Development documentation describes
unreleased behavior, and APIs, configuration, and workflows may change before a
first release.
