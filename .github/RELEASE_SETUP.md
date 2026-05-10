# Release CI setup (one-time)

`scripts/release.sh` is the single source of truth for a release. The
`Release` workflow at `.github/workflows/release.yml` reconstructs the
local environment that script expects (cert, signing keys, GH auth) on
a fresh `macos-14` runner and then invokes the script verbatim.

To enable CI releases you add **6 GitHub Secrets** to the repository.
After that, every release happens by either pushing a tag (`git tag
v0.6.5 && git push --tags`) or by running the workflow with the
`workflow_dispatch` event (which also bumps the version files for you).

> Until these secrets are added the workflow will fail at the
> "Import Apple Developer ID certificate" step. The local
> `bash scripts/release.sh` flow keeps working unaffected — both paths
> share the same script and don't depend on each other.

## Secrets to add

Open the repo on GitHub → **Settings → Secrets and variables → Actions
→ New repository secret**, then add each of the following.

| Name | Value |
|---|---|
| `TYPESET_GEMINI_API_KEY` | The Gemini API key (the same one currently in your macOS keychain under `typeset / gemini-api-key`). |
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.tauri/typeset.key`. Paste the file contents verbatim — the `untrusted comment:` line and the base64 blob below it. |
| `APPLE_CERTIFICATE_BASE64` | Your **Developer ID Application** certificate as a base64 string (instructions below). |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set on the `.p12` export. |
| `APPLE_SIGNING_IDENTITY` | The exact string `Developer ID Application: Aiden Magarian (NF6D29P3HJ)` (run the command below to confirm). |
| `RELEASE_KEYCHAIN_PASSWORD` | Any random string — used to unlock the temporary keychain inside the runner. Generate one with `openssl rand -hex 24`. |

## How to extract each value

### `TYPESET_GEMINI_API_KEY`

```bash
security find-generic-password -s typeset -a gemini-api-key -w
```

The output is the API key itself. Paste it into the secret. (macOS may
prompt the first time — click *Always Allow*.)

### `TAURI_SIGNING_PRIVATE_KEY`

```bash
cat ~/.tauri/typeset.key
```

Copy the entire output (multiple lines, starts with `untrusted comment:`).
Paste it into the secret as-is — GitHub preserves newlines inside
secret values.

### `APPLE_CERTIFICATE_BASE64`

You need a `.p12` export of your Developer ID Application certificate
(the private key + cert chain bundled together).

1. Open **Keychain Access** → **login** keychain → **My Certificates**.
2. Right-click `Developer ID Application: Aiden Magarian (...)` →
   **Export**. Save as `typeset-developer-id.p12`. Set a strong password.
3. Convert to base64 and copy to clipboard:

   ```bash
   base64 -i ~/Downloads/typeset-developer-id.p12 | pbcopy
   ```

4. Paste into the `APPLE_CERTIFICATE_BASE64` secret.
5. Paste the password you used in step 2 into `APPLE_CERTIFICATE_PASSWORD`.
6. Delete the `.p12` from disk once everything is verified working.

### `APPLE_SIGNING_IDENTITY`

```bash
security find-identity -p codesigning -v | grep "Developer ID Application"
```

Copy the quoted name (e.g. `Developer ID Application: Aiden Magarian (NF6D29P3HJ)`)
verbatim into the secret.

### `RELEASE_KEYCHAIN_PASSWORD`

```bash
openssl rand -hex 24
```

Paste the output into the secret. The value isn't sensitive — it just
unlocks the *temporary* keychain that lives only for the runner job.

## Triggering a release once secrets are configured

### Tag-based (simple)

```bash
# Bump version files first, commit and push.
git tag v0.6.5
git push origin v0.6.5
```

### Workflow-dispatch (no local version bump needed)

From the repo's **Actions** tab → **Release** → **Run workflow** →
enter version `0.6.5` → **Run**. The workflow bumps
`package.json` / `tauri.conf.json` / `package-lock.json`, commits, tags,
and proceeds.

You can also kick this off from the `gh` CLI:

```bash
gh workflow run release.yml -f version=0.6.5
```

## What the workflow does (high level)

1. Checks out the repo at the tag (or HEAD for `workflow_dispatch`).
2. For `workflow_dispatch`: bumps version files, commits, pushes the
   tag. After this point the rest is identical to the tag-push path.
3. Verifies `tauri.conf.json` version matches the tag (mismatch fails
   loudly so we never publish a tag whose binary thinks it's a different
   version).
4. Sets up Node 20 + stable Rust toolchain. Caches cargo target across
   runs (Swatinem/rust-cache).
5. Imports the `.p12` cert into a temporary keychain that lives only
   for the runner job.
6. Writes `~/.tauri/typeset.key` from the secret and exports
   `TYPESET_GEMINI_API_KEY` so the existing `scripts/release.sh` works
   unchanged.
7. Runs `bash scripts/release.sh`. The script handles signing, DMG
   assembly, updater archive + minisign, and `gh release create`.

## Local releases still work

Nothing about the local flow changes. `bash scripts/release.sh` on your
laptop continues to work exactly as before — it pulls the Gemini key
from your keychain, finds the cert in your login keychain, and signs.
The CI workflow is purely additive.
