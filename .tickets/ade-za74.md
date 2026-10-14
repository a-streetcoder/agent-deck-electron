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
