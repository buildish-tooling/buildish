<!--
Copyright 2026 The Buildish Authors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# Buildish Release Signing Key Ceremony

This document describes how Buildish maintainers create, back up, and publish
the OpenPGP key used to sign release artifacts. It does not define or authorize
a Buildish release; the release process remains documented separately in
[`BUILDISH-RELEASE-PROCESS.md`](BUILDISH-RELEASE-PROCESS.md).

The ceremony creates:

- an offline, certification-only primary key;
- a one-year signing subkey for release automation;
- a revocation certificate;
- a public key for [`https://buildish.org/KEYS`](https://buildish.org/KEYS);
- a primary-key backup for restricted custody; and
- a signing-subkey export for GitHub Actions.

The primary secret key must never be stored in GitHub. GitHub receives only the
expiring signing subkey. If GitHub is compromised, the offline primary key can
revoke and replace that subkey without replacing the Buildish identity.

GnuPG documents certification-only primary keys, signing subkeys, and
secret-subkey exports in its [OpenPGP key management][gpg-key-management] and
[operational commands][gpg-operational-commands] documentation.

## Requirements

Run the ceremony on a trusted, patched, full-disk-encrypted machine. An offline
machine or disposable encrypted virtual machine is preferable. Do not work in
a Git checkout or cloud-synchronized directory.

The commands below require:

- Bash;
- GnuPG 2.4 or newer;
- `awk`;
- either `pinentry-curses` or `pinentry-tty`; and
- optionally, the GitHub CLI for uploading the GitHub secrets and `curl` for
  verifying the deployed `KEYS` resource.

Run all snippets in the same terminal session. The commands derive the primary
fingerprint, signing-subkey fingerprint, and signing-subkey keygrip from
GnuPG's machine-readable output. No fingerprint copying, whitespace removal, or
manual key selection is required.

Passphrases remain intentionally interactive. The disposable GnuPG homes are
configured to use a terminal Pinentry, not a graphical dialog. This permits
switching to a password manager while a prompt is active without exposing a
passphrase in shell history, process arguments, environment variables, or a
plaintext file. GnuPG documents `GPG_TTY` and terminal Pinentry configuration
in its [agent documentation][gpg-agent].

### Prepare two passphrases

Before starting, create two independent, strong, randomly generated
passphrases. Preparing and storing them in an encrypted password manager is
convenient but optional. They must be unique to this ceremony and must not be
derived from one another. A password-manager-generated value containing at
least 32 random characters is a reasonable default for each passphrase; a
randomly generated multi-word passphrase of comparable strength is also
appropriate.

| Label used below | Protects | Where it is stored after the ceremony |
|---|---|---|
| **Primary passphrase** | Offline primary key and initial signing-subkey export | Restricted custody vault and offline backup; never GitHub |
| **CI passphrase** | Final signing-subkey export used by release automation | Restricted custody vault and GitHub secret `BUILDISH_RELEASE_GPG_PASSPHRASE` |

Keep both passphrases available throughout the ceremony. A password manager
may store them under names such as `Buildish OpenPGP primary passphrase` and
`Buildish CI signing-subkey passphrase`. Do not put either passphrase in a
shell variable, command-line argument, unencrypted note, or file in the
ceremony workspace.

The following table shows the logical passphrase required by each operation.
GnuPG may reuse a value from its short-lived agent cache, so an expected prompt
does not necessarily appear every time.

| Step and operation | Passphrase interaction |
|---|---|
| Generate the primary key | Set and confirm the **primary passphrase** |
| Add the signing subkey | Enter the **primary passphrase** |
| Export either secret-key file initially | Enter the **primary passphrase** |
| Change the isolated signing subkey's passphrase | Enter the **primary passphrase**, then set and confirm the **CI passphrase** |
| Re-export or test the isolated signing subkey | Enter the **CI passphrase** |
| Verify the primary-key custody backup | Enter the **primary passphrase** |
| Create the GitHub passphrase secret | Enter the **CI passphrase** |

Public-key export, fingerprint and keygrip discovery, revocation-certificate
extraction, public-key import, and signature verification require no
passphrase.

## 1. Create an isolated workspace

Create a private temporary directory and configure GnuPG to use a terminal
Pinentry. The marker file is used later to guard cleanup of the directory.

```bash
umask 077

export BUILDISH_WORK_DIR="$(mktemp -d)"
chmod 700 "$BUILDISH_WORK_DIR"
printf '%s\n' 'Buildish signing-key ceremony workspace' \
  > "$BUILDISH_WORK_DIR/.buildish-key-ceremony"

export GNUPGHOME="$BUILDISH_WORK_DIR/primary-gnupg"
mkdir -m 700 "$GNUPGHOME"

BUILDISH_PINENTRY="$(
  command -v pinentry-curses || command -v pinentry-tty || true
)"
if [[ -z "$BUILDISH_PINENTRY" ]]; then
  printf '%s\n' \
    'A terminal Pinentry (pinentry-curses or pinentry-tty) is required.' >&2
  exit 1
fi
export BUILDISH_PINENTRY

printf 'pinentry-program %s\nno-allow-external-cache\n' \
  "$BUILDISH_PINENTRY" > "$GNUPGHOME/gpg-agent.conf"

GPG_TTY="$(tty)"
export GPG_TTY

cd "$BUILDISH_WORK_DIR"
gpg --version
printf 'Workspace: %s\nTerminal Pinentry: %s\n' \
  "$BUILDISH_WORK_DIR" "$BUILDISH_PINENTRY"
```

Do not continue if `tty` reports an error or the selected Pinentry is not a
terminal program.

## 2. Generate the primary key and signing subkey

Generate an Ed25519 certification-only primary key, valid for three years.
Terminal Pinentry asks to set and confirm the prepared **primary passphrase**.

```bash
BUILDISH_KEY_UID='Buildish Automated Release Signing <dev@buildish.org>'

gpg --quick-generate-key "$BUILDISH_KEY_UID" ed25519 cert 3y
```

Extract and validate the primary fingerprint. A fresh keyring contains exactly
one primary key, so the first primary fingerprint is unambiguous.

```bash
PRIMARY_FPR="$(
  gpg --batch --with-colons --list-secret-keys |
    awk -F: '
      $1 == "sec" { primary = 1; next }
      primary && $1 == "fpr" { print $10; exit }
    '
)"
if [[ ! "$PRIMARY_FPR" =~ ^[0-9A-Fa-f]{40}$ ]]; then
  printf 'Could not derive the primary fingerprint: %s\n' "$PRIMARY_FPR" >&2
  exit 1
fi
export PRIMARY_FPR
printf 'Primary fingerprint: %s\n' "$PRIMARY_FPR"
```

Add an Ed25519 signing subkey valid for one year. Terminal Pinentry may ask for
the **primary passphrase**; the agent may already have it cached.

```bash
gpg --quick-add-key "$PRIMARY_FPR" ed25519 sign 1y
```

Extract and validate the signing-subkey fingerprint and keygrip. The keygrip
identifies the individual secret-key material managed by `gpg-agent`; it is not
an OpenPGP fingerprint.

```bash
SIGNING_FPR="$(
  gpg --batch --with-colons --with-keygrip \
    --list-secret-keys "$PRIMARY_FPR" |
    awk -F: '
      $1 == "ssb" { subkey = 1; next }
      subkey && $1 == "fpr" { print $10; exit }
    '
)"
SIGNING_KEYGRIP="$(
  gpg --batch --with-colons --with-keygrip \
    --list-secret-keys "$PRIMARY_FPR" |
    awk -F: '
      $1 == "ssb" { subkey = 1; next }
      subkey && $1 == "grp" { print $10; exit }
    '
)"

if [[ ! "$SIGNING_FPR" =~ ^[0-9A-Fa-f]{40}$ ]]; then
  printf 'Could not derive the signing fingerprint: %s\n' "$SIGNING_FPR" >&2
  exit 1
fi
if [[ ! "$SIGNING_KEYGRIP" =~ ^[0-9A-Fa-f]{40}$ ]]; then
  printf 'Could not derive the signing keygrip: %s\n' "$SIGNING_KEYGRIP" >&2
  exit 1
fi
export SIGNING_FPR SIGNING_KEYGRIP

printf 'Primary fingerprint: %s\nSigning fingerprint: %s\n' \
  "$PRIMARY_FPR" "$SIGNING_FPR"
```

## 3. Export the public key, backups, and CI subkey

GnuPG automatically creates a revocation certificate for a newly generated
primary key. Extract its armored key block into a portable file without
creating another interactive prompt:

```bash
BUILDISH_AUTO_REVOCATION="$GNUPGHOME/openpgp-revocs.d/$PRIMARY_FPR.rev"
if [[ ! -f "$BUILDISH_AUTO_REVOCATION" ]]; then
  printf 'Automatic revocation certificate not found: %s\n' \
    "$BUILDISH_AUTO_REVOCATION" >&2
  exit 1
fi

awk '
  /^:-----BEGIN PGP PUBLIC KEY BLOCK-----/ {
    copying = 1
    sub(/^:/, "")
  }
  copying { print }
' "$BUILDISH_AUTO_REVOCATION" > buildish-revocation.asc

if [[ ! -s buildish-revocation.asc ]]; then
  printf '%s\n' 'Failed to extract the revocation certificate.' >&2
  exit 1
fi
```

Export the public certificate, complete primary-key custody copy, and selected
signing subkey. The public export requires no passphrase. Both secret-key
exports may request the **primary passphrase** through terminal Pinentry.

```bash
gpg --armor \
  --export-options export-minimal \
  --export "$PRIMARY_FPR" \
  > buildish-public.asc

gpg --armor \
  --export-secret-keys "$PRIMARY_FPR" \
  > buildish-primary-private.asc

gpg --armor \
  --export-secret-subkeys "${SIGNING_FPR}!" \
  > buildish-ci-signing-subkey.asc
```

The `!` selects the exact signing subkey. The CI export contains the public
primary certificate, an unusable primary-secret-key stub, and the usable
signing subkey.

## 4. Assign a separate CI passphrase

The initial signing-subkey export uses the primary-key passphrase. Never store
that passphrase in GitHub. Import the CI subkey into a second isolated keyring
and configure its agent to use terminal Pinentry:

```bash
export BUILDISH_CI_HOME="$BUILDISH_WORK_DIR/ci-gnupg"
mkdir -m 700 "$BUILDISH_CI_HOME"
printf 'pinentry-program %s\nno-allow-external-cache\n' \
  "$BUILDISH_PINENTRY" > "$BUILDISH_CI_HOME/gpg-agent.conf"

GNUPGHOME="$BUILDISH_CI_HOME" \
  gpg --import buildish-ci-signing-subkey.asc
```

Confirm that the imported subkey matches the generated subkey:

```bash
CI_SIGNING_FPR="$(
  GNUPGHOME="$BUILDISH_CI_HOME" \
    gpg --batch --with-colons --with-keygrip \
      --list-secret-keys "$PRIMARY_FPR" |
    awk -F: '
      $1 == "ssb" { subkey = 1; next }
      subkey && $1 == "fpr" { print $10; exit }
    '
)"
CI_SIGNING_KEYGRIP="$(
  GNUPGHOME="$BUILDISH_CI_HOME" \
    gpg --batch --with-colons --with-keygrip \
      --list-secret-keys "$PRIMARY_FPR" |
    awk -F: '
      $1 == "ssb" { subkey = 1; next }
      subkey && $1 == "grp" { print $10; exit }
    '
)"

if [[ "$CI_SIGNING_FPR" != "$SIGNING_FPR" ||
      "$CI_SIGNING_KEYGRIP" != "$SIGNING_KEYGRIP" ]]; then
  printf '%s\n' 'Imported CI subkey does not match the generated subkey.' >&2
  exit 1
fi
```

Change the passphrase through the GnuPG agent's individual-key `PASSWD`
operation. The first terminal prompt requests the current passphrase, which is
the **primary passphrase**. The subsequent prompts set and confirm the prepared
**CI passphrase**.

```bash
GNUPGHOME="$BUILDISH_CI_HOME" \
  gpg-connect-agent "HAVEKEY $SIGNING_KEYGRIP" /bye

GNUPGHOME="$BUILDISH_CI_HOME" \
  gpg-connect-agent "PASSWD $SIGNING_KEYGRIP" /bye
```

Using the keygrip is important. `gpg --change-passphrase "$PRIMARY_FPR"` would
target the deliberately absent primary secret key and cannot perform this
operation. The agent's [`PASSWD` command][gpg-agent-passwd] changes only the
secret-key material identified by the signing subkey's keygrip.

Re-export the signing subkey. Terminal Pinentry may request the **CI
passphrase**:

```bash
GNUPGHOME="$BUILDISH_CI_HOME" \
  gpg --armor \
    --export-secret-subkeys "${SIGNING_FPR}!" \
  > buildish-ci-signing-subkey-gh.asc
```

## 5. Verify the exports

Import the final CI export into a third isolated keyring and create a test
signature. Terminal Pinentry should request and accept the **CI passphrase**.

```bash
export BUILDISH_TEST_HOME="$BUILDISH_WORK_DIR/test-gnupg"
mkdir -m 700 "$BUILDISH_TEST_HOME"
printf 'pinentry-program %s\nno-allow-external-cache\n' \
  "$BUILDISH_PINENTRY" > "$BUILDISH_TEST_HOME/gpg-agent.conf"

GNUPGHOME="$BUILDISH_TEST_HOME" \
  gpg --import buildish-ci-signing-subkey-gh.asc

printf 'Buildish signing test\n' > signing-test.txt

GNUPGHOME="$BUILDISH_TEST_HOME" \
  gpg --armor \
    --detach-sign \
    --local-user "${SIGNING_FPR}!" \
    signing-test.txt

GNUPGHOME="$BUILDISH_TEST_HOME" \
  gpg --verify signing-test.txt.asc signing-test.txt
```

The secret-key listing must show the primary secret key as unavailable
(`sec#`) and the signing subkey as available (`ssb`):

```bash
GNUPGHOME="$BUILDISH_TEST_HOME" \
  gpg --list-secret-keys \
    --with-fingerprint \
    --with-subkey-fingerprint "$PRIMARY_FPR"
```

Verify the complete primary-key backup in a fourth isolated keyring. Its
listing must show the primary secret key as available (`sec`, without `#`):

```bash
export BUILDISH_BACKUP_TEST_HOME="$BUILDISH_WORK_DIR/backup-test-gnupg"
mkdir -m 700 "$BUILDISH_BACKUP_TEST_HOME"
printf 'pinentry-program %s\nno-allow-external-cache\n' \
  "$BUILDISH_PINENTRY" > "$BUILDISH_BACKUP_TEST_HOME/gpg-agent.conf"

GNUPGHOME="$BUILDISH_BACKUP_TEST_HOME" \
  gpg --import buildish-primary-private.asc

GNUPGHOME="$BUILDISH_BACKUP_TEST_HOME" \
  gpg --list-secret-keys \
    --with-fingerprint \
    --with-subkey-fingerprint "$PRIMARY_FPR"

GNUPGHOME="$BUILDISH_BACKUP_TEST_HOME" \
  gpg --armor --export-secret-keys "$PRIMARY_FPR" > /dev/null
```

The final command requests the **primary passphrase** and confirms that the
custody copy can be unlocked with it.

## 6. Store the custody material

Store the following in a restricted encrypted vault accessible only to
designated release-key custodians:

- `buildish-primary-private.asc`;
- `buildish-revocation.asc`;
- the primary-key passphrase;
- both OpenPGP fingerprints;
- the key creation and expiration dates; and
- the planned rotation owner and date.

Also maintain a separate encrypted offline backup of the primary private key
and revocation certificate. The revocation certificate is sensitive because
anyone possessing it can invalidate the public key.

A password manager supporting encrypted file attachments, such as 1Password,
is one possible custody mechanism; it is not required. For example, a
restricted 1Password vault may contain one item for the primary-key custody
material and another for the CI signing subkey and CI-only passphrase. Protect
custodian accounts with strong multi-factor authentication.

Do not destroy the ceremony workspace until a custodian has retrieved the
stored attachments and successfully repeated the import tests.

## 7. Configure GitHub Actions

Store only the following final CI export and CI-only passphrase in GitHub:

| GitHub setting | Value |
|---|---|
| Organization secret `BUILDISH_RELEASE_GPG_SECRET_SUBKEY` | Contents of `buildish-ci-signing-subkey-gh.asc` |
| Organization secret `BUILDISH_RELEASE_GPG_PASSPHRASE` | CI-only passphrase |
| Organization variable `BUILDISH_RELEASE_GPG_SIGNING_FINGERPRINT` | Value of `SIGNING_FPR` |

The dormant component workflows expose the two organization secrets to
Release Tooling under its internal environment-variable contract:
`BUILDISH_RELEASE_GPG_SECRET_SUBKEY` becomes `BUILDISH_GPG_PRIVATE_KEY`, and
`BUILDISH_RELEASE_GPG_PASSPHRASE` becomes `BUILDISH_GPG_PASSPHRASE`. These
internal names are not additional GitHub secrets.

The organization variable records the expected signing identity but is not yet
consumed by the deliberately incomplete release configurations. When the
release process is adopted, bind its value to Release Tooling's OpenPGP
`expected_fingerprint` setting and fail the workflow if it is absent or does
not match. Do not enable signing merely because the secrets exist.

While no release workflow has been approved, create the organization secrets
without granting them to any repository:

```bash
gh secret set BUILDISH_RELEASE_GPG_SECRET_SUBKEY \
  --org buildish-tooling \
  --no-repos-selected \
  < buildish-ci-signing-subkey-gh.asc

gh secret set BUILDISH_RELEASE_GPG_PASSPHRASE \
  --org buildish-tooling \
  --no-repos-selected

printf '%s\n' "$SIGNING_FPR" |
  gh variable set BUILDISH_RELEASE_GPG_SIGNING_FINGERPRINT \
    --org buildish-tooling \
    --visibility all
```

The second command requests the **CI passphrase** in the terminal; it does not
place the passphrase in shell history. Later, grant each secret only to the
repository containing the approved signing workflow. GitHub documents
repository-limited organization secrets in the [`gh secret set`
documentation][gh-secret-set].

Any workflow in an authorized repository may potentially reference an
organization secret. An approved release workflow should therefore use a
separate signing job, a protected GitHub environment with required reviewers,
minimal permissions, GitHub-hosted ephemeral runners, and actions pinned to
full commit SHAs. It must not expose signing secrets to pull requests or run
untrusted repository code after importing the key. See GitHub's [secure-use
guidance][github-secure-use] and [environment documentation][github-env].

## 8. Publish the public key

The repository already publishes a Buildish certificate. Replace the armored
certificate block for the same primary fingerprint with the complete contents
of `buildish-public.asc`. For a new primary fingerprint, retain any previously
published revoked or historical certificate blocks and append the new complete
export.

`site/static/KEYS` intentionally contains OpenPGP public certificate blocks
only. Fingerprints and expiration dates are derived from the certificates by
the validation commands below instead of being duplicated in comments. If the
file does not exist during a future initial ceremony, create it directly from
the complete public export.

Never publish a private-key block or the revocation certificate. Validate the
result from the repository root:

```bash
gpg --show-keys \
  --with-fingerprint \
  --with-subkey-fingerprint \
  site/static/KEYS

if rg -q 'PRIVATE KEY|REVOCATION CERTIFICATE' site/static/KEYS; then
  printf '%s\n' 'Unexpected private material in site/static/KEYS.' >&2
  exit 1
fi
```

The published file is available as
[`https://buildish.org/KEYS`](https://buildish.org/KEYS). Publish the primary
fingerprint through another independently maintained Buildish channel as well,
so users do not obtain both the key and its sole trust reference from the same
website.

### Maintain `KEYS` after key changes

`site/static/KEYS` is the published state of the complete Buildish OpenPGP
certificate, not a one-time copy of the initially generated public key. Every
new expiration self-signature, signing subkey, and revocation must therefore be
published there.

Apply these rules when editing it:

- When a signing subkey is added, expires, or is revoked, replace the existing
  armored certificate block for its primary fingerprint with a fresh complete
  public export. Do not append a second copy of the same primary certificate.
- When the primary key's expiration is extended, replace its existing armored
  block with the renewed complete public export.
- When a primary key is revoked and replaced, retain one updated, revoked block
  for the old primary key and add one block for the new primary key. Never drop
  the old revoked block merely because it is no longer used for new releases.
- Retain old and revoked signing subkeys inside their primary certificate so
  consumers can evaluate historical signatures and revocation state.
- Derive fingerprint, status, and expiration information from the armored
  certificates. Do not add comments that can become stale independently of the
  cryptographic data.

After every maintenance edit, run the private-material check above and inspect
all primary keys and subkeys:

```bash
gpg --show-keys \
  --with-fingerprint \
  --with-subkey-fingerprint \
  site/static/KEYS

gpg --batch --with-colons --show-keys site/static/KEYS
```

In the machine-readable output, the second field is `r` for a revoked `pub` or
`sub` record and `e` for an expired record. Confirm that the intended active
signing subkey is neither revoked nor expired and that all expected historical
keys remain present.

After deployment, verify that the served file matches the reviewed repository
content and contains the expected fingerprints and status:

```bash
curl --fail --silent --show-error https://buildish.org/KEYS |
  gpg --show-keys \
    --with-fingerprint \
    --with-subkey-fingerprint
```

## 9. Finish the initial ceremony

Record a reminder at least 60 days before the signing subkey expires. Use the
maintenance procedures below to replace it before that date.

After all stored copies have been retrieved and verified, stop the agents for
the disposable GnuPG homes:

```bash
for BUILDISH_HOME_TO_STOP in \
  "$GNUPGHOME" \
  "$BUILDISH_CI_HOME" \
  "$BUILDISH_TEST_HOME" \
  "$BUILDISH_BACKUP_TEST_HOME"
do
  gpgconf --homedir "$BUILDISH_HOME_TO_STOP" --kill all || true
done
```

On an encrypted disposable machine or volume, destroy that environment. If the
workspace was created with the first snippet and must be removed directly,
validate its marker and delete only that exact generated directory:

```bash
if [[ -n "${BUILDISH_WORK_DIR:-}" &&
      "$BUILDISH_WORK_DIR" != "/" &&
      -f "$BUILDISH_WORK_DIR/.buildish-key-ceremony" ]]; then
  find "$BUILDISH_WORK_DIR" -depth -delete
else
  printf '%s\n' 'Refusing to remove an unverified ceremony workspace.' >&2
  exit 1
fi
```

File deletion is not guaranteed to securely erase data from SSDs or
copy-on-write filesystems. Destroying the encrypted disposable environment is
the preferred cleanup method.

## 10. Prepare for later key maintenance

Revocation and renewal must be performed from a trusted, preferably offline
machine using the latest complete primary-key custody backup. Do not perform
primary-key maintenance in a Git checkout. Before going offline, separately
record the full fingerprint of any specific subkey that may need to be
revoked; fingerprints are public information.

Create a fresh maintenance workspace with terminal Pinentry:

```bash
umask 077

export BUILDISH_MAINTENANCE_DIR="$(mktemp -d)"
chmod 700 "$BUILDISH_MAINTENANCE_DIR"
printf '%s\n' 'Buildish signing-key maintenance workspace' \
  > "$BUILDISH_MAINTENANCE_DIR/.buildish-key-maintenance"

export GNUPGHOME="$BUILDISH_MAINTENANCE_DIR/primary-gnupg"
mkdir -m 700 "$GNUPGHOME"

BUILDISH_PINENTRY="$(
  command -v pinentry-curses || command -v pinentry-tty || true
)"
if [[ -z "$BUILDISH_PINENTRY" ]]; then
  printf '%s\n' \
    'A terminal Pinentry (pinentry-curses or pinentry-tty) is required.' >&2
  exit 1
fi
export BUILDISH_PINENTRY

printf 'pinentry-program %s\nno-allow-external-cache\n' \
  "$BUILDISH_PINENTRY" > "$GNUPGHOME/gpg-agent.conf"

GPG_TTY="$(tty)"
export GPG_TTY
cd "$BUILDISH_MAINTENANCE_DIR"
```

Enter the path to the retrieved custody backup and import it. The path itself
is not secret, but the referenced file is:

```bash
read -r -e -p 'Path to buildish-primary-private.asc: ' \
  BUILDISH_PRIMARY_BACKUP
if [[ ! -f "$BUILDISH_PRIMARY_BACKUP" ]]; then
  printf 'Primary-key backup not found: %s\n' "$BUILDISH_PRIMARY_BACKUP" >&2
  exit 1
fi

gpg --import "$BUILDISH_PRIMARY_BACKUP"

PRIMARY_KEY_COUNT="$(
  gpg --batch --with-colons --list-secret-keys |
    awk -F: '$1 == "sec" { count++ } END { print count + 0 }'
)"
if [[ "$PRIMARY_KEY_COUNT" != 1 ]]; then
  printf 'Expected one primary key, found %s.\n' "$PRIMARY_KEY_COUNT" >&2
  exit 1
fi

PRIMARY_FPR="$(
  gpg --batch --with-colons --list-secret-keys |
    awk -F: '
      $1 == "sec" { primary = 1; next }
      primary && $1 == "fpr" { print $10; exit }
    '
)"
if [[ ! "$PRIMARY_FPR" =~ ^[0-9A-Fa-f]{40}$ ]]; then
  printf 'Could not derive the primary fingerprint: %s\n' "$PRIMARY_FPR" >&2
  exit 1
fi
export PRIMARY_FPR

gpg --list-secret-keys \
  --with-fingerprint \
  --with-subkey-fingerprint "$PRIMARY_FPR"
```

Confirm that the displayed primary fingerprint matches the independently
recorded Buildish fingerprint before continuing. The listing must show the
primary secret key as available (`sec`, without `#`). Maintenance operations
that certify a new expiration, signing subkey, or revocation request the
**primary passphrase** through terminal Pinentry.

## 11. Revoke a key

Revocation is permanent. First decide which scope applies:

| Situation | Action |
|---|---|
| The GitHub CI signing subkey or its passphrase may be exposed | Revoke only that signing subkey, then create a replacement |
| A signing subkey is no longer authorized but is not compromised | Normally let it expire after replacement; revoke it only when policy requires immediate invalidation |
| The primary private key, its passphrase, or primary-key custody may be exposed | Revoke the complete primary key and create a new primary identity |
| A key has merely expired or is approaching expiration | Do not revoke it; follow the renewal procedure |

### Revoke a signing subkey

Contain suspected exposure immediately from an online administrative machine:
stop signing workflows and delete the two organization secrets so the subkey
cannot continue to be used. Do this even if the offline primary key is not yet
available.

```bash
gh secret delete BUILDISH_RELEASE_GPG_SECRET_SUBKEY \
  --org buildish-tooling
gh secret delete BUILDISH_RELEASE_GPG_PASSPHRASE \
  --org buildish-tooling
```

Do not connect the offline maintenance machine to GitHub. In the maintenance
workspace, enter the full fingerprint of the affected signing subkey. The
snippet removes any spaces and verifies that the value identifies an actual
subkey of the imported primary certificate:

```bash
read -r -p 'Full signing-subkey fingerprint to revoke: ' REVOKE_FPR
REVOKE_FPR="${REVOKE_FPR//[[:space:]]/}"
if [[ ! "$REVOKE_FPR" =~ ^[0-9A-Fa-f]{40}$ ]]; then
  printf 'Invalid signing-subkey fingerprint: %s\n' "$REVOKE_FPR" >&2
  exit 1
fi

REVOKE_KEYID="$(
  gpg --batch --with-colons --list-keys "$PRIMARY_FPR" |
    awk -F: -v target="$REVOKE_FPR" '
      $1 == "ssb" { keyid = $5; next }
      $1 == "fpr" && toupper($10) == toupper(target) {
      print keyid
      exit
      }
    '
)"
if [[ ! "$REVOKE_KEYID" =~ ^[0-9A-Fa-f]{16}$ ]]; then
  printf '%s\n' 'Fingerprint is not a subkey of the Buildish primary key.' >&2
  exit 1
fi

printf 'Subkey fingerprint: %s\nSubkey key ID: %s\n' \
  "$REVOKE_FPR" "$REVOKE_KEYID"
```

Launch the interactive editor:

```bash
gpg --edit-key "$PRIMARY_FPR"
```

At the `gpg>` prompt:

1. Run `key REVOKE_KEYID`, replacing `REVOKE_KEYID` with the value printed by
   the previous snippet.
2. Confirm that GnuPG marks exactly the intended signing subkey as selected.
3. Run `revkey`.
4. Choose the accurate reason, such as compromised or superseded, and add only
   public-safe explanatory text.
5. Confirm the revocation and run `save`.

This confirmation is intentionally not automated. GnuPG documents `revkey` as
the operation for revoking a selected subkey in its [OpenPGP key management
documentation][gpg-key-management].

Inspect and export the updated public certificate and custody backup:

```bash
gpg --list-options show-unusable-subkeys \
  --list-keys \
  --with-fingerprint \
  --with-subkey-fingerprint "$PRIMARY_FPR"

gpg --armor \
  --export-options export-minimal \
  --export "$PRIMARY_FPR" \
  > buildish-public-revoked.asc

gpg --armor \
  --export-secret-keys "$PRIMARY_FPR" \
  > buildish-primary-private.asc
```

The secret-key export requests the **primary passphrase**. Verify the updated
custody backup in another isolated keyring before replacing the prior backup.
Transfer only the updated public certificate and, after replacement, the new
CI subkey export out of the offline environment.

On an online administrative machine:

1. Replace the existing armored block for `PRIMARY_FPR` in `site/static/KEYS`
   with `buildish-public-revoked.asc`; do not append a duplicate block. Retain
   the revoked subkey so old signatures and its revoked state remain visible.
2. Publish the revocation through the independent fingerprint/status channel.
3. Review artifacts signed during the possible exposure window; do not assume
   those signatures remain trustworthy.
4. Create a replacement signing subkey using the renewal procedure below.
5. Replace the same `PRIMARY_FPR` block again with the export containing both
   the revoked subkey and its replacement.
6. Restore GitHub access only after publishing and testing the replacement.

### Revoke the complete primary key

Use this path only when primary-key custody may be compromised or the Buildish
identity must be retired. Delete the GitHub signing secrets as shown above.
Retrieve the stored `buildish-revocation.asc` into the offline maintenance
environment, then import it:

```bash
read -r -e -p 'Path to buildish-revocation.asc: ' \
  BUILDISH_REVOCATION_FILE
if [[ ! -f "$BUILDISH_REVOCATION_FILE" ]]; then
  printf 'Revocation certificate not found: %s\n' \
    "$BUILDISH_REVOCATION_FILE" >&2
  exit 1
fi

gpg --import "$BUILDISH_REVOCATION_FILE"

gpg --list-options show-unusable-uids,show-unusable-subkeys \
  --list-keys \
  --with-fingerprint \
  --with-subkey-fingerprint "$PRIMARY_FPR"

gpg --armor \
  --export-options export-minimal \
  --export "$PRIMARY_FPR" \
  > buildish-public-primary-revoked.asc
```

The listing must show the primary certificate as revoked. Importing the stored
certificate applies the revocation; generating a revocation certificate alone
would not. GnuPG documents this distinction under
[`--generate-revocation`][gpg-key-management].

Replace the old primary key's existing block in `site/static/KEYS` with
`buildish-public-primary-revoked.asc` and publish it through the independent
status channel. Keep that revoked block permanently so consumers can identify
the revoked identity and inspect historical signatures. Run the complete
initial ceremony to create a new primary key, then add the new primary key as a
separate armored block. Publish both the revoked old certificate and the new
public certificate, and independently announce the new primary fingerprint.
Review all artifacts signed during the possible compromise window.

A revoked primary key or subkey cannot be renewed or made valid again.

## 12. Renew keys

For Buildish, renewal means:

- extending an uncompromised offline primary key before its three-year
  expiration; and
- replacing the one-year CI signing subkey with a newly generated subkey.

Do not extend a signing subkey that may have been exposed. Revoke it and rotate
instead. Buildish also replaces healthy signing subkeys annually instead of
extending their expiration, limiting the useful lifetime of an undiscovered CI
key exposure. Keep old signing subkeys in the published certificate so old
release signatures remain verifiable; do not delete them.

### Renew the primary key

If the primary key is approaching expiration and its custody remains sound,
extend it for another three years:

```bash
gpg --quick-set-expire "$PRIMARY_FPR" 3y
```

Terminal Pinentry requests the **primary passphrase**. Confirm the new expiry:

```bash
gpg --list-keys \
  --with-fingerprint \
  --with-subkey-fingerprint "$PRIMARY_FPR"
```

Renew the primary key during the same maintenance window as the annual signing
subkey replacement. This ensures the new CI export contains the updated
primary-key metadata. If primary-key custody may be compromised, do not extend
it; follow the complete-primary-key revocation procedure instead.

### Replace the signing subkey

Record the current subkey count, add a new one-year signing subkey, and verify
that exactly one subkey was added:

```bash
SIGNING_SUBKEY_COUNT_BEFORE="$(
  gpg --batch --with-colons --list-secret-keys "$PRIMARY_FPR" |
    awk -F: '$1 == "ssb" { count++ } END { print count + 0 }'
)"

gpg --quick-add-key "$PRIMARY_FPR" ed25519 sign 1y

SIGNING_SUBKEY_COUNT_AFTER="$(
  gpg --batch --with-colons --list-secret-keys "$PRIMARY_FPR" |
    awk -F: '$1 == "ssb" { count++ } END { print count + 0 }'
)"
if (( SIGNING_SUBKEY_COUNT_AFTER != SIGNING_SUBKEY_COUNT_BEFORE + 1 )); then
  printf 'Expected one new subkey; count changed from %s to %s.\n' \
    "$SIGNING_SUBKEY_COUNT_BEFORE" "$SIGNING_SUBKEY_COUNT_AFTER" >&2
  exit 1
fi
```

Terminal Pinentry requests the **primary passphrase**. Derive the newly added
subkey's fingerprint and keygrip from the last subkey in the certificate:

```bash
NEW_SIGNING_FPR="$(
  gpg --batch --with-colons --with-keygrip \
    --list-secret-keys "$PRIMARY_FPR" |
    awk -F: '
      $1 == "ssb" { subkey = 1; next }
      subkey && $1 == "fpr" { latest = $10; subkey = 0 }
      END { print latest }
    '
)"
NEW_SIGNING_KEYGRIP="$(
  gpg --batch --with-colons --with-keygrip \
    --list-secret-keys "$PRIMARY_FPR" |
    awk -F: '
      $1 == "ssb" { subkey = 1; next }
      subkey && $1 == "grp" { latest = $10; subkey = 0 }
      END { print latest }
    '
)"

if [[ ! "$NEW_SIGNING_FPR" =~ ^[0-9A-Fa-f]{40}$ ||
      ! "$NEW_SIGNING_KEYGRIP" =~ ^[0-9A-Fa-f]{40}$ ]]; then
  printf '%s\n' 'Could not derive the new signing-subkey identifiers.' >&2
  exit 1
fi

export SIGNING_FPR="$NEW_SIGNING_FPR"
export SIGNING_KEYGRIP="$NEW_SIGNING_KEYGRIP"
printf 'New signing fingerprint: %s\n' "$SIGNING_FPR"
```

Export the updated public certificate, refreshed custody backup, and new CI
subkey:

```bash
gpg --armor \
  --export-options export-minimal \
  --export "$PRIMARY_FPR" \
  > buildish-public-renewed.asc

gpg --armor \
  --export-secret-keys "$PRIMARY_FPR" \
  > buildish-primary-private.asc

gpg --armor \
  --export-secret-subkeys "${SIGNING_FPR}!" \
  > buildish-ci-signing-subkey.asc
```

The secret exports request the **primary passphrase**. Set
`BUILDISH_WORK_DIR` to the maintenance directory, then repeat sections 4 and 5
to assign the prepared **CI passphrase** to the new subkey and verify both the
CI export and refreshed custody backup:

```bash
export BUILDISH_WORK_DIR="$BUILDISH_MAINTENANCE_DIR"
```

Before activating the replacement:

1. Store and independently re-import `buildish-primary-private.asc`.
2. Store `buildish-ci-signing-subkey-gh.asc` and its **CI passphrase** in the
   restricted custody vault.
3. Replace the existing `PRIMARY_FPR` armored block in `site/static/KEYS` with
   `buildish-public-renewed.asc`; do not append a duplicate block. Retain all
   older subkeys inside the renewed certificate.
4. Confirm that `site/static/KEYS` contains the new signing fingerprint.
5. Replace the two GitHub organization secrets while preserving their exact
   selected-repository policy. If they were deleted during incident
   containment, recreate them with the explicitly approved repository policy.
6. Set `BUILDISH_RELEASE_GPG_SIGNING_FINGERPRINT` to the new fingerprint.
7. Run a controlled signing and verification test through the approved release
   workflow.

Only after all checks succeed should the replacement become the active signing
subkey. Let an uncompromised predecessor expire naturally. Revoke it only if
there is a specific need for immediate invalidation.

## 13. Finish maintenance

Do not remove the maintenance workspace until the refreshed custody material
has been retrieved from its vault and independently tested. Then stop all
agents created for the maintenance operation:

```bash
for BUILDISH_HOME_TO_STOP in \
  "$GNUPGHOME" \
  "${BUILDISH_CI_HOME:-}" \
  "${BUILDISH_TEST_HOME:-}" \
  "${BUILDISH_BACKUP_TEST_HOME:-}"
do
  if [[ -n "$BUILDISH_HOME_TO_STOP" ]]; then
    gpgconf --homedir "$BUILDISH_HOME_TO_STOP" --kill all || true
  fi
done
```

Prefer destroying the encrypted disposable machine or volume. To remove only
the generated maintenance directory, validate its marker first:

```bash
if [[ -n "${BUILDISH_MAINTENANCE_DIR:-}" &&
      "$BUILDISH_MAINTENANCE_DIR" != "/" &&
      -f "$BUILDISH_MAINTENANCE_DIR/.buildish-key-maintenance" ]]; then
  find "$BUILDISH_MAINTENANCE_DIR" -depth -delete
else
  printf '%s\n' 'Refusing to remove an unverified maintenance workspace.' >&2
  exit 1
fi
```

As with the initial ceremony, direct deletion may not securely erase data from
SSDs or copy-on-write filesystems.

[gh-secret-set]: https://cli.github.com/manual/gh_secret_set
[github-env]: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
[github-secure-use]: https://docs.github.com/en/actions/reference/security/secure-use
[gpg-agent]: https://gnupg.org/documentation/manuals/gnupg/Invoking-GPG_002dAGENT.html
[gpg-agent-passwd]: https://gnupg.org/documentation/manuals/gnupg/Agent-PASSWD.html
[gpg-key-management]: https://gnupg.org/documentation/manuals/gnupg/OpenPGP-Key-Management.html
[gpg-operational-commands]: https://gnupg.org/documentation/manuals/gnupg/Operational-GPG-Commands.html
