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

import type { Key } from 'openpgp';
// Use the Node-targeted CJS build so esbuild bundles a __filename-based createRequire(...)
// path instead of the package ESM entrypoint's import.meta.url variant.
// prettier-ignore
// @ts-ignore -- this deep runtime import is intentional for bundling compatibility.
import { createMessage, readKey, readSignature, verify } from '../../node_modules/openpgp/dist/node/openpgp.cjs';

export interface TrustedOpenPgpPublicKey {
  /** ASCII-armored OpenPGP public key block. */
  readonly armoredKey: string;
  /** Expected full 40-hex-character fingerprint for the pinned key. */
  readonly expectedFingerprint: string;
}

/**
 * Trust allowlist for Gradle wrapper detached-signature verification.
 *
 * Rotation guidance:
 * - pin only keys published at https://gradle.org/keys/
 * - keep old and new trusted keys here concurrently during Gradle key rotation
 * - remove a retired key only after supported wrapper versions are no longer signed by it
 */
export const GRADLE_TRUSTED_SIGNING_KEY_ALLOWLIST: readonly TrustedOpenPgpPublicKey[] = [
  {
    // From: https://gradle.org/keys/
    expectedFingerprint: '1BD97A6A154E7810EE0BC832E2F38302C8075E3D',
    armoredKey: `-----BEGIN PGP PUBLIC KEY BLOCK-----

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
f7TkwC6aybc=
=B8WW
-----END PGP PUBLIC KEY BLOCK-----`,
  },
];

let gradleTrustedPublicKeysPromise: Promise<readonly Key[]> | undefined;

export async function loadTrustedOpenPgpPublicKeys(
  trustedKeyAllowlist: readonly TrustedOpenPgpPublicKey[],
): Promise<readonly Key[]> {
  if (trustedKeyAllowlist.length === 0) {
    throw new Error('At least one trusted OpenPGP public key must be configured.');
  }

  const fingerprints = new Set<string>();

  return await Promise.all(
    trustedKeyAllowlist.map(async (trustedKey, index) => {
      const expectedFingerprint = normalizeFingerprint(trustedKey.expectedFingerprint);
      if (expectedFingerprint.length !== 40) {
        throw new Error(`Trusted OpenPGP key ${index + 1} has an invalid expected fingerprint.`);
      }

      const parsedKey = await readKey({ armoredKey: trustedKey.armoredKey });
      const actualFingerprint = normalizeFingerprint(parsedKey.getFingerprint());

      if (actualFingerprint !== expectedFingerprint) {
        throw new Error(
          `Trusted OpenPGP key ${index + 1} fingerprint mismatch. Expected ${expectedFingerprint}, found ${actualFingerprint}.`,
        );
      }

      if (fingerprints.has(actualFingerprint)) {
        throw new Error(
          `Trusted OpenPGP fingerprint ${actualFingerprint} was configured more than once.`,
        );
      }

      fingerprints.add(actualFingerprint);
      return parsedKey;
    }),
  );
}

export async function verifyDetachedOpenPgpSignature(
  payload: Uint8Array,
  armoredSignature: string,
  verificationKeys: readonly Key[],
  resourceDescription: string,
): Promise<void> {
  if (verificationKeys.length === 0) {
    throw new Error('At least one verification key is required for detached signature checks.');
  }

  const verificationResult = await verify({
    message: await createMessage({ binary: payload }),
    signature: await readSignature({ armoredSignature }),
    verificationKeys: [...verificationKeys],
  });

  if (verificationResult.signatures.length === 0) {
    throw new Error(
      `Detached signature verification for ${resourceDescription} returned no signatures.`,
    );
  }

  let lastError: Error | null = null;

  for (const result of verificationResult.signatures) {
    try {
      await result.verified;
      return;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(
    `Detached signature verification failed for ${resourceDescription}: ${lastError?.message ?? 'signature was not valid.'}`,
  );
}

export async function verifyGradleDetachedSignature(
  payload: Uint8Array,
  armoredSignature: string,
  resourceDescription: string,
): Promise<void> {
  gradleTrustedPublicKeysPromise ??= loadTrustedOpenPgpPublicKeys(
    GRADLE_TRUSTED_SIGNING_KEY_ALLOWLIST,
  );
  const verificationKeys = await gradleTrustedPublicKeysPromise;
  await verifyDetachedOpenPgpSignature(
    payload,
    armoredSignature,
    verificationKeys,
    resourceDescription,
  );
}

function normalizeFingerprint(value: string): string {
  return value.replaceAll(/[^A-Fa-f0-9]/g, '').toLowerCase();
}
