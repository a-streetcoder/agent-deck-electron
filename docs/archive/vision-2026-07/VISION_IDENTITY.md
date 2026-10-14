# VISION_IDENTITY — every action chains to a human

_Decision of record: Syncr #121 (M.21 owner-attested delegation chains), #122 (M.22 ADR — the
gate before any signing code), `Syncr/docs/research-nostr.md`. 2026-07-29._

## The principle

Identity is **conferred, not self-sovereign**: the directory (Syncr's Better Auth/SCIM) is the
trust root, and cryptographic keys are credentials _under_ it — the Sigstore/Matrix pattern,
not the Nostr pattern. What we lifted from Nostr/Buzz is the **signed-event spine** and Buzz's
owner-attestation model (their draft NIP-OA/NIP-AA), both PKI-portable, neither requiring any
Nostr dependency.

## The chain

```
Human (directory identity — the revocable root)
  └─ Device attestation      (this Agent Deck install, enrolled + approved)
       └─ Agent attestation  (conditions: tool allowlist, scopes, TTL)
            └─ Signed action (message, job transition, skill edit, tool call)
```

- **Attenuation only**: an agent can hold at most a subset of its owner's authority.
- **Transitive revocation**: deprovision the human → every device, agent, and access they
  attested dies with them. No orphaned agent identities, ever.
- **Verification at use time**: the coordination plane re-checks directory liveness when
  events/calls arrive — including the offline backlog (VISION_EDGE): events signed while
  offline by a since-deprovisioned user are rejected at sync and surfaced to admins.

## What Agent Deck specifically does

- **Signs device-side.** We control this client end-to-end (signed builds, OS keychain), so
  attestations and events are rooted on the user's own hardware — and offline authorship stays
  verifiable. Other surfaces (bare MCP clients, web) sign server-side; Agent Deck is the
  hardened tier.
- **Enrolls as a device.** Every install is a `Device` record; new devices are `pending` and
  mint nothing until approved (org policy: auto-first / admin / cross-device self-approval).
  Fail-closed: unknown device ⇒ no chains ⇒ no sync, no tool calls.
- **Displays provenance.** Skills/assets show verified-signed state; the workspace shows which
  human stands behind every agent in the room. Refusing unverified assets is an org policy
  Agent Deck enforces at materialization.

## Open questions — owned by the ADR (Syncr #122), not by implementation drift

Signature scheme vs Apple Secure Enclave (SE is P-256-only; BIP-340/secp256k1 is the
recommendation for event compatibility — single-curve-in-Keychain vs per-tier curves is
undecided); attestation TTLs per tier (device tier must tolerate offline stretches — days);
enrollment defaults per org tier; verifier chokepoint placement. **No signing code lands in
Agent Deck before that ADR is accepted.**
