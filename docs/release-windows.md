# Windows release: code signing and installer

Status (ade-za74): signed NSIS installer, release workflow and auto-update are wired and signing
is proven locally; the first tag run and an installed-update test are still pending. For the
Windows development loop and `pnpm pack:win` pitfalls see
[agent-guidelines/WINDOWS.md](agent-guidelines/WINDOWS.md).

## Signing identity

- **Azure Artifact Signing** (formerly Trusted Signing), Public Trust. There is no PFX anywhere:
  keys stay in Azure's HSM, Microsoft issues a short-lived leaf certificate per signing run, and
  signatures are RFC 3161 timestamped. Basic tier, about $9.99/month per account.
- Account: resource group `codemeter-rg`, account `codemeter-signing` (North Europe), data-plane
  endpoint `https://neu.codesigning.azure.net/`. The account is owned by the Code Meter lane (see
  [LANES.md](LANES.md)).
- Identity validation "STREETCODING LTD" (Companies House 15995534) is completed and valid to
  2028-12-28. One validation covers every certificate profile for the legal entity. Validations
  can only be created in the portal by a user with the "Artifact Signing Identity Verifier" role,
  and the name must match Companies House exactly or it is rejected.
- Signed subject DN: `CN=STREETCODING LTD, O=STREETCODING LTD, L=London, C=GB`; issuer
  "Microsoft ID Verified CS AOC CA 04".
- **Certificate profile: `codemeter-profile`** (PublicTrust, `includeStreetAddress=false`,
  `includePostalCode=false`). Decision (ade-lfpv): the Basic tier allows one PublicTrust profile,
  so Agent Deck and Code Meter share `codemeter-profile`; the signed publisher is the company
  either way, and upgrading to Premium is only worth it if per-app revocation ever matters.
  History: creating a separate `agentdeck-profile` on the Basic tier was refused on 2026-10-14
  ("maximum limit of certificate profiles of selected type").

## Signing step (electron-builder 26.x)

No custom hook, no signtool or AzureSignTool. Signing lives only in
`electron-builder.win-signed.yml`, which `extends` `electron-builder.yml` and adds
`win.azureSignOptions`; `pnpm pack:win` never loads it and stays unsigned. Build a signed
installer with `pnpm pack:win:signed` (`electron-builder --win nsis --x64 -c
electron-builder.win-signed.yml`). The options:

```json
{
  "endpoint": "https://neu.codesigning.azure.net/",
  "codeSigningAccountName": "codemeter-signing",
  "certificateProfileName": "codemeter-profile",
  "timestampRfc3161": "http://timestamp.acs.microsoft.com",
  "publisherName": "CN=STREETCODING LTD, O=STREETCODING LTD, L=London, C=GB"
}
```

electron-builder shells out to the TrustedSigning PowerShell module (`Invoke-TrustedSigning`,
0.5.8), which bootstraps Microsoft's `sign` .NET tool and signs with a SHA-256 digest and a
timestamp. The first run downloads the `sign` tool (about a minute; CI needs network). Paths with
spaces work.

electron-builder signs every `.exe` in the app, in `app.asar.unpacked` and in `extraResources`
(including the Pi runtime's node-pty), plus `elevate.exe`, the uninstaller and the installer. It
does **not** skip files that are already signed: it replaced Microsoft's signature on node-pty's
`OpenConsole.exe` (verified 2026-10-14), and electron-builder 26 has no sign hook on the Azure
path. The signed config therefore sets `signExts: ["!OpenConsole.exe"]`, which keeps Microsoft's
signature on every copy; node-pty's unsigned `winpty-agent.exe` is signed by us. `.dll` and
`.node` files are not signed (electron-builder's default). Signing costs about 2–3 s per file.

### Prerequisites

- `Install-Module TrustedSigning`
- Azure CLI
- A .NET SDK, not just runtimes (runtimes alone fail with "No .NET SDKs were found"):
  `winget install Microsoft.DotNet.SDK.8`
- RBAC: "Artifact Signing Certificate Profile Signer" on the account.

### Sign locally

Log in with the code-signing scope before building:

```sh
az login --tenant <tenant-id> --scope "https://codesigning.azure.net/.default"
```

Without the scope the token is for ARM and signing fails with 401/403. In Git Bash set
`MSYS_NO_PATHCONV=1` first so the scope is not mangled.

Verify the result:

```sh
powershell -c "Get-AuthenticodeSignature release\*.exe | Format-List Status,SignerCertificate"
signtool verify /pa /v <installer>.exe
```

## CI: `.github/workflows/release-windows.yml`

Runs on a `v*` tag and on manual dispatch, on `windows-latest`. It checks that the tag equals
`v` + the root `package.json` version, runs the same checks as the macOS release, builds,
installs the TrustedSigning module, logs in with `azure/login` (OIDC, no client secret) after
the build and fetches the code-signing token at once (the GitHub OIDC assertion is short-lived),
then runs electron-builder with the signed config. A tag run publishes a **draft** release
(installer, blockmap, `latest.yml`); a dispatch run publishes nothing. It then installs the
installer silently on the runner and fails unless the installer, `Agent Deck.exe` and the
uninstaller are `Valid` with the STREETCODING LTD subject, and uploads the files as an artifact.
Publish the draft by hand after checking it.

It expects:

- Repository **variables** `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`: a
  service principal with a federated credential for this repository and the "Artifact Signing
  Certificate Profile Signer" role on `codemeter-signing`.
- The built-in `GITHUB_TOKEN` (the workflow asks for `contents: write` and `id-token: write`);
  optional secret `PACKAGES_READ_TOKEN` as in the other workflows, for the private package.

## Installer and SmartScreen

- NSIS one-click, `perMachine: false`. MSIX and the Store are deferred.
- SmartScreen shows the blue warning until reputation accrues, with the named publisher
  STREETCODING LTD. "Unknown publisher" means signing broke.

## Auto-update

`electron-builder.yml` publishes to GitHub (`a-streetcoder/agent-deck-electron`, draft
releases) and sets `win.verifyUpdateCodeSignature: true`; `electron-updater` is a root
dependency, so it is packed with the app. The signed build writes the feed and
`azureSignOptions.publisherName` into `resources/app-update.yml` (electron-builder 26 has no
`win.publisherName`; the Azure options carry it). electron-updater verifies the download against
`latest.yml`'s sha512 and rejects an installer whose Authenticode publisher differs from that
name, so it must match the signed subject above character for character.

The NSIS install has **Help > Check for Updates…**: it checks the latest published (not draft)
release, downloads it, and offers Restart Now or install on next quit. The entry is shown only in
packaged Windows builds; the unpacked `pnpm pack:win` build has no feed, so it reports an error
there. The installer goes to `%LOCALAPPDATA%\Programs\agent-deck-electron` and uses the same
`%APPDATA%\Agent Deck` data as the hand-promoted stable copy.
