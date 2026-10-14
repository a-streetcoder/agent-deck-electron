---
id: ade-lfpv
status: closed
deps: []
links: []
created: 2026-10-14T00:08:59Z
type: chore
priority: 1
assignee: ale
---
# DST-A (operator): create the Agent Deck certificate profile on Azure Artifact Signing

Operator-only. On the existing account codemeter-signing (North Europe, endpoint https://neu.codesigning.azure.net/, identity validation STREETCODING LTD valid to 2028-12-28) create certificate profile agentdeck-profile (PublicTrust) via the portal or ARM PUT api-version 2026-05-15-preview. Ensure the machine has the TrustedSigning PowerShell module, Azure CLI and a .NET SDK; az login --tenant TENANT --scope https://codesigning.azure.net/.default works (MSYS_NO_PATHCONV=1 in Git Bash). For CI later: service principal with Certificate Profile Signer role and an OIDC federated credential for the repo; repo variables AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID.

## Acceptance Criteria

Profile visible in the portal; a local test signature of any exe via Invoke-TrustedSigning reports Valid with subject CN=STREETCODING LTD; the variable names recorded in docs/release-windows.md.


## Notes

**2026-10-14T00:18:24Z**

Decision (owner, 2026-10-14): share the existing codemeter-profile; a second PublicTrust profile is refused on the Basic tier. Machine prereqs verified: az logged in to tenant 55b9578e (StreetCoding), TrustedSigning 0.5.8 installed, .NET SDK 8.0.425.

**2026-10-14T00:18:44Z**

Acceptance met 2026-10-14: Invoke-TrustedSigning with codemeter-profile signed a scratch exe; Get-AuthenticodeSignature = Valid, subject CN=STREETCODING LTD, O=STREETCODING LTD, L=London, C=GB. OperationId 3f378c9c. No browser login needed; az token already had the codesigning scope.
