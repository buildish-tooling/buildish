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

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

interface GpgCommandOptions {
  readonly command?: string;
}

interface CompletedCommand {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^([A-Za-z]):[\\/](.*)$/u;

let gradleTrustedPublicKeysPromise: Promise<readonly TrustedOpenPgpPublicKey[]> | undefined;

/**
 * Resolves the GnuPG executable used for detached-signature verification.
 *
 * Windows CI may need to force a non-default `gpg.exe` path because Git for
 * Windows can expose multiple binaries with different path semantics.
 */
export function resolveDefaultGpgCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND?.trim();
  if (override) {
    return override;
  }

  return platform === 'win32' ? 'gpg.exe' : 'gpg';
}

/**
 * Git-for-Windows `usr/bin/gpg.exe` is an MSYS build that expects `/c/...`
 * style paths. Convert Windows absolute paths only for that binary.
 */
export function normalizePathForGpgCommand(
  filePath: string,
  command: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') {
    return filePath;
  }

  const resolvedCommand = command?.trim() || resolveDefaultGpgCommand(platform);
  const normalizedCommand = resolvedCommand.replaceAll('\\', '/').toLowerCase();
  if (!normalizedCommand.endsWith('/usr/bin/gpg.exe')) {
    return filePath;
  }

  const windowsPathMatch = filePath.match(WINDOWS_ABSOLUTE_PATH_PATTERN);
  if (!windowsPathMatch) {
    return filePath.replaceAll('\\', '/');
  }

  const [, driveLetter, remainder] = windowsPathMatch;
  return `/${driveLetter.toLowerCase()}/${remainder.replaceAll('\\', '/')}`;
}

export async function loadTrustedOpenPgpPublicKeys(
  trustedKeyAllowlist: readonly TrustedOpenPgpPublicKey[],
  options: GpgCommandOptions = {},
): Promise<readonly TrustedOpenPgpPublicKey[]> {
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

      const actualFingerprint = await readArmoredKeyFingerprint(
        trustedKey.armoredKey,
        options.command,
      );

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
      return {
        armoredKey: trustedKey.armoredKey,
        expectedFingerprint: trustedKey.expectedFingerprint,
      };
    }),
  );
}

export async function verifyDetachedOpenPgpSignature(
  payload: Uint8Array,
  armoredSignature: string,
  verificationKeys: readonly TrustedOpenPgpPublicKey[],
  resourceDescription: string,
  options: GpgCommandOptions = {},
): Promise<void> {
  if (verificationKeys.length === 0) {
    throw new Error('At least one verification key is required for detached signature checks.');
  }

  await withTemporaryGpgHome(async (gpgHome) => {
    const trustedKeysPath = path.join(gpgHome, 'trusted-keys.asc');
    const payloadPath = path.join(gpgHome, 'payload.bin');
    const signaturePath = path.join(gpgHome, 'payload.asc');
    const resolvedCommand = options.command?.trim() || resolveDefaultGpgCommand();

    // Use a fresh GPG home per verification so wrapper checks do not share mutable
    // keyring/trustdb state across calls or concurrent action invocations.
    await Promise.all([
      writeFile(
        trustedKeysPath,
        `${verificationKeys.map((key) => key.armoredKey.trim()).join('\n\n')}\n`,
        { encoding: 'utf8', flag: 'wx' },
      ),
      writeFile(payloadPath, payload, { flag: 'wx' }),
      writeFile(signaturePath, `${armoredSignature.trim()}\n`, { encoding: 'utf8', flag: 'wx' }),
    ]);

    const importResult = await runCommand(options.command, [
      '--homedir',
      normalizePathForGpgCommand(gpgHome, resolvedCommand),
      '--batch',
      '--no-options',
      '--import',
      normalizePathForGpgCommand(trustedKeysPath, resolvedCommand),
    ]);
    if (importResult.exitCode !== 0) {
      throw new Error(
        `Unable to import trusted OpenPGP public keys: ${formatCommandDiagnostics(importResult, 'import failed.')}`,
      );
    }

    const verificationResult = await runCommand(options.command, [
      '--homedir',
      normalizePathForGpgCommand(gpgHome, resolvedCommand),
      '--batch',
      '--no-options',
      '--no-auto-key-retrieve',
      '--verify',
      normalizePathForGpgCommand(signaturePath, resolvedCommand),
      normalizePathForGpgCommand(payloadPath, resolvedCommand),
    ]);
    if (verificationResult.exitCode !== 0) {
      throw new Error(
        `Detached signature verification failed for ${resourceDescription}: ${formatCommandDiagnostics(verificationResult, 'signature was not valid.')}`,
      );
    }
  });
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

async function readArmoredKeyFingerprint(
  armoredKey: string,
  command: string | undefined,
): Promise<string> {
  return await withTemporaryGpgHome(async (gpgHome) => {
    const keyPath = path.join(gpgHome, 'trusted-key.asc');
    const resolvedCommand = command?.trim() || resolveDefaultGpgCommand();
    await writeFile(keyPath, `${armoredKey.trim()}\n`, { encoding: 'utf8', flag: 'wx' });

    const result = await runCommand(command, [
      '--homedir',
      normalizePathForGpgCommand(gpgHome, resolvedCommand),
      '--batch',
      '--no-options',
      '--show-keys',
      '--with-colons',
      '--fingerprint',
      normalizePathForGpgCommand(keyPath, resolvedCommand),
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `Unable to inspect trusted OpenPGP key material: ${formatCommandDiagnostics(result, 'fingerprint extraction failed.')}`,
      );
    }

    const primaryFingerprint = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.startsWith('fpr:'));
    if (!primaryFingerprint) {
      throw new Error('Trusted OpenPGP key material did not contain a primary fingerprint.');
    }

    const fingerprint = normalizeFingerprint(primaryFingerprint.split(':')[9] ?? '');
    if (fingerprint.length !== 40) {
      throw new Error('Trusted OpenPGP key material did not expose a valid primary fingerprint.');
    }
    return fingerprint;
  });
}

async function withTemporaryGpgHome<T>(callback: (gpgHome: string) => Promise<T>): Promise<T> {
  const parentDirectory = process.env.RUNNER_TEMP?.trim() || os.tmpdir();
  const gpgHome = await mkdtemp(path.join(parentDirectory, 'buildish-mammoth-cache-gradle-gpg-'));

  try {
    return await callback(gpgHome);
  } finally {
    await rm(gpgHome, { recursive: true, force: true });
  }
}

async function runCommand(
  command: string | undefined,
  args: readonly string[],
): Promise<CompletedCommand> {
  const resolvedCommand = command?.trim() || resolveDefaultGpgCommand();

  return await new Promise((resolve, reject) => {
    const child = spawn(resolvedCommand, [...args], {
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
    child.on('error', (error) => {
      const commandError = error as NodeJS.ErrnoException;
      if (commandError.code === 'ENOENT') {
        reject(
          new Error(
            `GnuPG command '${resolvedCommand}' is required for Gradle wrapper detached-signature verification but was not found on PATH. Install GnuPG and ensure '${resolvedCommand}' is available before running this action.`,
          ),
        );
        return;
      }

      reject(
        new Error(
          `Unable to execute '${resolvedCommand} ${args.join(' ')}': ${commandError.message}`,
        ),
      );
    });
    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`'${resolvedCommand} ${args.join(' ')}' terminated by signal ${signal}.`));
        return;
      }

      resolve({
        exitCode: code ?? 1,
        stderr,
        stdout,
      });
    });
  });
}

function formatCommandDiagnostics(result: CompletedCommand, fallback: string): string {
  const diagnostic = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  return diagnostic || fallback;
}
