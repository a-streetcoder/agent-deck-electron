# Windows release: code signing and installer

Status: local signing only; CI and auto-update are not wired yet (ticket ade-za74). For the
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

No custom hook, no signtool or AzureSignTool. Configure `win.azureSignOptions`:

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

Pre-signed bundled binaries (node-pty prebuilds, `OpenConsole.exe`) are skipped by electron-builder
when their signature is valid. If that ever stops working, the fallback is a `sign` hook that
returns early when `Get-AuthenticodeSignature` reports `Valid`. Signing costs about 2–3 s per
file.

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

## CI (not wired yet)

Planned shape on `windows-latest`:

1. `azure/login` with an OIDC federated credential on a service principal holding Certificate
   Profile Signer (no client secret). Repository **variables** `AZURE_CLIENT_ID`,
   `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.
2. `Install-Module TrustedSigning -Force`.
3. electron-builder; `azureSignOptions` authenticates through `DefaultAzureCredential`.

Alternative: run `azure/trusted-signing-action` after packaging.

## Installer and SmartScreen

- NSIS one-click, `perMachine: false`. MSIX and the Store are deferred.
- SmartScreen shows the blue warning until reputation accrues, with the named publisher
  STREETCODING LTD. "Unknown publisher" means signing broke.

## Auto-update (not wired yet)

`publish: { provider: "github" }`; electron-builder emits `latest.yml` with a sha512.
electron-updater verifies the sha512 and, on Windows, that the installer's Authenticode publisher
matches `win.publisherName` **exactly**, so the DN string in `publisherName` must match the
signed subject above character for character.
