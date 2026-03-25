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

import { createMessage, generateKey, sign, type PrivateKey } from 'openpgp';
import { describe, expect, it } from 'vitest';

import {
  loadTrustedOpenPgpPublicKeys,
  verifyDetachedOpenPgpSignature,
  type TrustedOpenPgpPublicKey,
} from '../../src/wrapper/signature';

describe('loadTrustedOpenPgpPublicKeys', () => {
  it('loads pinned keys when the expected fingerprint matches', async () => {
    const trustedKey = await createTrustedSigningKey();

    await expect(loadTrustedOpenPgpPublicKeys([trustedKey])).resolves.toHaveLength(1);
  });

  it('rejects pinned keys whose expected fingerprint does not match the armored key', async () => {
    const trustedKey = await createTrustedSigningKey();

    await expect(
      loadTrustedOpenPgpPublicKeys([
        {
          ...trustedKey,
          expectedFingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
      ]),
    ).rejects.toThrow(/fingerprint mismatch/);
  });
});

describe('verifyDetachedOpenPgpSignature', () => {
  it('accepts a valid detached signature from a trusted key', async () => {
    const trustedKey = await createTrustedSigningKey();
    const verificationKeys = await loadTrustedOpenPgpPublicKeys([trustedKey]);
    const payload = Buffer.from('verified payload');
    const armoredSignature = await createDetachedSignature(payload, trustedKey.privateKey);

    await expect(
      verifyDetachedOpenPgpSignature(payload, armoredSignature, verificationKeys, 'test payload'),
    ).resolves.toBeUndefined();
  });

  it('accepts a valid detached signature from a later key in the trusted allowlist', async () => {
    const firstTrustedKey = await createTrustedSigningKey();
    const secondTrustedKey = await createTrustedSigningKey();
    const verificationKeys = await loadTrustedOpenPgpPublicKeys([
      firstTrustedKey,
      secondTrustedKey,
    ]);
    const payload = Buffer.from('verified payload from rotated key');
    const armoredSignature = await createDetachedSignature(payload, secondTrustedKey.privateKey);

    await expect(
      verifyDetachedOpenPgpSignature(payload, armoredSignature, verificationKeys, 'test payload'),
    ).resolves.toBeUndefined();
  });

  it('rejects a detached signature when the payload is tampered with', async () => {
    const trustedKey = await createTrustedSigningKey();
    const verificationKeys = await loadTrustedOpenPgpPublicKeys([trustedKey]);
    const originalPayload = Buffer.from('verified payload');
    const armoredSignature = await createDetachedSignature(originalPayload, trustedKey.privateKey);

    await expect(
      verifyDetachedOpenPgpSignature(
        Buffer.from('tampered payload'),
        armoredSignature,
        verificationKeys,
        'test payload',
      ),
    ).rejects.toThrow(/Detached signature verification failed/);
  });
});

async function createTrustedSigningKey(): Promise<
  TrustedOpenPgpPublicKey & { readonly privateKey: PrivateKey }
> {
  const keyPair = await generateKey({
    type: 'curve25519',
    userIDs: [{ name: 'Test Signer', email: 'test@example.com' }],
    format: 'object',
  });

  return {
    armoredKey: keyPair.publicKey.armor(),
    expectedFingerprint: keyPair.publicKey.getFingerprint(),
    privateKey: keyPair.privateKey,
  };
}

async function createDetachedSignature(
  payload: Uint8Array,
  privateKey: PrivateKey,
): Promise<string> {
  return await sign({
    message: await createMessage({ binary: payload }),
    signingKeys: privateKey,
    detached: true,
    format: 'armored',
  });
}
