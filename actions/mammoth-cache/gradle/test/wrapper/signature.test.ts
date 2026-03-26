/*
 * Copyright 2026 The Apache Software Foundation
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

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GRADLE_TRUSTED_SIGNING_KEY_ALLOWLIST,
  loadTrustedOpenPgpPublicKeys,
  resolveDefaultGpgCommand,
  verifyDetachedOpenPgpSignature,
  type TrustedOpenPgpPublicKey,
} from '../../src/wrapper/signature';

const DEFAULT_GPG_COMMAND = process.platform === 'win32' ? 'gpg.exe' : 'gpg';
const GPG_AVAILABLE = (() => {
  const result = spawnSync(DEFAULT_GPG_COMMAND, ['--version'], { stdio: 'ignore' });
  return result.status === 0;
})();
const itIfGpg = GPG_AVAILABLE ? it : it.skip;

describe('loadTrustedOpenPgpPublicKeys', () => {
  itIfGpg('loads pinned keys when the expected fingerprint matches', async () => {
    await expect(
      loadTrustedOpenPgpPublicKeys([GRADLE_TRUSTED_SIGNING_KEY_ALLOWLIST[0]]),
    ).resolves.toHaveLength(1);
  });

  itIfGpg(
    'rejects pinned keys whose expected fingerprint does not match the armored key',
    async () => {
      await expect(
        loadTrustedOpenPgpPublicKeys([
          {
            ...GRADLE_TRUSTED_SIGNING_KEY_ALLOWLIST[0],
            expectedFingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          },
        ]),
      ).rejects.toThrow(/fingerprint mismatch/);
    },
  );

  it('fails with an actionable error when the gpg binary is missing', async () => {
    await expect(
      loadTrustedOpenPgpPublicKeys([GRADLE_TRUSTED_SIGNING_KEY_ALLOWLIST[0]], {
        command: 'definitely-missing-gpg-command',
      }),
    ).rejects.toThrow(/required for Gradle wrapper detached-signature verification/);
  });
});

describe('resolveDefaultGpgCommand', () => {
  it('prefers an explicit environment override when provided', () => {
    expect(
      resolveDefaultGpgCommand('win32', {
        BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND: ' C:\\tools\\gnupg\\bin\\gpg.exe ',
      }),
    ).toBe('C:\\tools\\gnupg\\bin\\gpg.exe');
  });

  it('falls back to platform defaults when no override is set', () => {
    expect(resolveDefaultGpgCommand('win32', {})).toBe('gpg.exe');
    expect(resolveDefaultGpgCommand('linux', {})).toBe('gpg');
  });
});

describe('verifyDetachedOpenPgpSignature', () => {
  itIfGpg('accepts a valid detached signature from a trusted key', async () => {
    await withTrustedSigningKeys(1, async ([trustedKey]) => {
      const verificationKeys = await loadTrustedOpenPgpPublicKeys([trustedKey]);
      const payload = Buffer.from('verified payload');
      const armoredSignature = await createDetachedSignature(payload, trustedKey);

      await expect(
        verifyDetachedOpenPgpSignature(payload, armoredSignature, verificationKeys, 'test payload'),
      ).resolves.toBeUndefined();
    });
  });

  itIfGpg(
    'accepts a valid detached signature from a later key in the trusted allowlist',
    async () => {
      await withTrustedSigningKeys(2, async ([firstTrustedKey, secondTrustedKey]) => {
        const verificationKeys = await loadTrustedOpenPgpPublicKeys([
          firstTrustedKey,
          secondTrustedKey,
        ]);
        const payload = Buffer.from('verified payload from rotated key');
        const armoredSignature = await createDetachedSignature(payload, secondTrustedKey);

        await expect(
          verifyDetachedOpenPgpSignature(
            payload,
            armoredSignature,
            verificationKeys,
            'test payload',
          ),
        ).resolves.toBeUndefined();
      });
    },
  );

  itIfGpg('rejects a detached signature when the payload is tampered with', async () => {
    await withTrustedSigningKeys(1, async ([trustedKey]) => {
      const verificationKeys = await loadTrustedOpenPgpPublicKeys([trustedKey]);
      const originalPayload = Buffer.from('verified payload');
      const armoredSignature = await createDetachedSignature(originalPayload, trustedKey);

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
});

interface TestSigningKey extends TrustedOpenPgpPublicKey {
  readonly fingerprint: string;
  readonly gpgHome: string;
}

async function withTrustedSigningKeys<T>(
  count: number,
  callback: (keys: readonly TestSigningKey[]) => Promise<T>,
): Promise<T> {
  const keys: TestSigningKey[] = [];

  try {
    for (let index = 0; index < count; index += 1) {
      keys.push(await createTrustedSigningKey(index + 1));
    }
    return await callback(keys);
  } finally {
    await Promise.all(
      keys.map(async (key) => await rm(key.gpgHome, { recursive: true, force: true })),
    );
  }
}

async function createTrustedSigningKey(index: number): Promise<TestSigningKey> {
  const gpgHome = await mkdtemp(path.join(os.tmpdir(), 'buildish-mammoth-cache-gradle-test-gpg-'));

  try {
    await runGpgCommand([
      '--homedir',
      gpgHome,
      '--batch',
      '--no-options',
      '--pinentry-mode',
      'loopback',
      '--passphrase',
      '',
      '--quick-generate-key',
      `Test Signer ${index} <test-signer-${index}@example.com>`,
      'ed25519',
      'sign',
      '0',
    ]);

    const listing = await runGpgCommand([
      '--homedir',
      gpgHome,
      '--batch',
      '--no-options',
      '--with-colons',
      '--list-keys',
    ]);
    const fingerprint = parsePrimaryFingerprint(listing.stdout);
    const armoredKey = (
      await runGpgCommand([
        '--homedir',
        gpgHome,
        '--batch',
        '--no-options',
        '--armor',
        '--export',
        fingerprint,
      ])
    ).stdout.trim();

    return {
      armoredKey,
      expectedFingerprint: fingerprint,
      fingerprint,
      gpgHome,
    };
  } catch (error) {
    await rm(gpgHome, { recursive: true, force: true });
    throw error;
  }
}

async function createDetachedSignature(
  payload: Uint8Array,
  signingKey: TestSigningKey,
): Promise<string> {
  const workDirectory = await mkdtemp(path.join(signingKey.gpgHome, 'sign-'));
  const payloadPath = path.join(workDirectory, 'payload.bin');
  const signaturePath = path.join(workDirectory, 'payload.asc');

  try {
    await writeFile(payloadPath, payload, { flag: 'wx' });
    await runGpgCommand([
      '--homedir',
      signingKey.gpgHome,
      '--batch',
      '--yes',
      '--no-options',
      '--pinentry-mode',
      'loopback',
      '--passphrase',
      '',
      '--local-user',
      signingKey.fingerprint,
      '--armor',
      '--output',
      signaturePath,
      '--detach-sign',
      payloadPath,
    ]);
    return (await readFile(signaturePath, 'utf8')).trim();
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

async function runGpgCommand(args: readonly string[]): Promise<{ readonly stdout: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(DEFAULT_GPG_COMMAND, [...args], {
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) {
        reject(
          new Error(`'${DEFAULT_GPG_COMMAND} ${args.join(' ')}' terminated by signal ${signal}.`),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `'${DEFAULT_GPG_COMMAND} ${args.join(' ')}' failed with exit code ${code}. ${`${stderr}\n${stdout}`.trim()}`,
          ),
        );
        return;
      }

      resolve({ stdout });
    });
  });
}

function parsePrimaryFingerprint(output: string): string {
  const fingerprintLine = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith('fpr:'));
  if (!fingerprintLine) {
    throw new Error('Generated GPG key listing did not contain a fingerprint.');
  }

  const fingerprint = fingerprintLine.split(':')[9]?.trim() ?? '';
  if (!/^[A-F0-9]{40}$/iu.test(fingerprint)) {
    throw new Error(`Generated GPG key fingerprint was not valid: '${fingerprint}'.`);
  }
  return fingerprint;
}
