---
id: ade-za74
status: in_progress
deps: [ade-lfpv, ade-nocm]
links: []
created: 2026-10-14T00:09:00Z
type: feature
priority: 1
assignee: almoretti
---
# DST-03/04: signed Windows installer, release workflow and auto-update

Make the Windows build release-grade: electron-builder win.target nsis plus the existing dir; win.azureSignOptions with endpoint, codeSigningAccountName codemeter-signing, certificateProfileName agentdeck-profile, timestampRfc3161 http://timestamp.acs.microsoft.com, publisherName exactly CN=STREETCODING LTD, O=STREETCODING LTD, L=London, C=GB; keep pack:win unsigned for local dev. Add electron-updater with publish provider github and a Check for updates action in the desktop shell; latest.yml sha512 plus Authenticode publisherName verification. Add .github/workflows/release-windows.yml mirroring release-macos.yml: windows-latest, azure/login OIDC, Install-Module TrustedSigning, build, electron-builder --win nsis --publish, upload artifacts. Handle pre-signed bundled binaries (node-pty prebuilds, OpenConsole.exe): verify they are skipped, else a sign hook that returns on an existing valid signature.

## Design

GUARDRAILS (this checkout is mirrored live to the VM by Syncthing and is the server working tree): never git checkout/switch/stash/reset here; never run git on the VM replica; deploy only via: ssh dev then pnpm build:web and systemctl --user restart agent-deck-server; no pnpm build or pack:win while someone is on the server; read docs/agent-guidelines/WINDOWS.md and docs/remote-server-poc.md first. Signing requires the operator profile ticket first; CI signing requires the service principal.

## Acceptance Criteria

Get-AuthenticodeSignature on the installer, app exe and uninstaller reports Valid with the STREETCODING LTD subject; the workflow runs green on a tag and publishes a draft GitHub release with the installer and latest.yml; an installed previous version updates to the new one on this machine; docs/release-windows.md and WINDOWS.md updated; the register rows DST-03 and DST-04 are closed with the evidence.


## Notes

**2026-10-14T07:25:33Z**

Owner decision 2026-10-14: certificateProfileName is codemeter-profile (the Basic tier allows one PublicTrust profile; agentdeck-profile was refused). Read docs/release-windows.md for the account details.

**2026-10-14T08:06:15Z**

2026-10-14 committed. Local signing proof done (installer, app exe, uninstaller Valid, STREETCODING LTD; OpenConsole.exe keeps Microsoft's signature). Ponytail: accepted; win.verifyUpdateCodeSignature is electron-builder's default and kept as documentation. Remaining, owner-only: (1) repository variables AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID + a service principal with a federated credential for this repo and the Certificate Profile Signer role on codemeter-signing; (2) push a v<version> tag after the branch is on main, confirm the draft release has the installer, blockmap and latest.yml; (3) install the previous version, publish the draft, run Help > Check for Updates and confirm the update installs. Close the ticket and flip DST-03/04 to Done with that evidence.

**2026-10-14T09:40:02Z**

2026-10-14 Azure side done via local az CLI (owner's login): app registration agent-deck-release-signing (single tenant, no secret) + service principal; federated credential github-release-environment with subject repo:a-streetcoder/agent-deck-electron:environment:release; role Artifact Signing Certificate Profile Signer on codemeter-signing; repo variables AZURE_CLIENT_ID/TENANT_ID/SUBSCRIPTION_ID set with gh. Workflow job now runs in GitHub environment release (one subject for all v* tags). Still owner-only: push the v<version> tag once the branch is on main, check the draft release, install previous version, publish, Help > Check for Updates.
