/*
 * Copyright 2026 The Project Nessie Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, it } from 'vitest';

import { createBootstrapStatus } from '../src/bootstrap';

describe('createBootstrapStatus', () => {
  it('returns a placeholder message for the main phase', () => {
    expect(createBootstrapStatus('main')).toEqual({
      phase: 'main',
      message: 'Bootstrap placeholder for the main entrypoint.',
    });
  });

  it('returns a placeholder message for the post phase', () => {
    expect(createBootstrapStatus('post')).toEqual({
      phase: 'post',
      message: 'Bootstrap placeholder for the post entrypoint.',
    });
  });
});
