# ADR 0010 — The company instance: a control plane, cells of disposable sessions, state in object storage

- Status: **Proposed** 2026-10-18 (owner direction: build the shape on the Proxmox VM first, decide external hosting later; awaiting the owner's `approved` on the ticket tree)
- Deciders: Ale (owner), architect session
- Related: [ADR 0003](0003-shared-server-trust-model.md) (trust model), [ADR 0007](0007-per-session-process-sandbox.md)
  (the sandbox), [ADR 0008](0008-deployment-profiles.md) (desktop or shared server),
  [ADR 0009](0009-subscriptions-in-shared-sessions.md) (the credential broker),
  `docs/capacity-measurements.md` (what a session costs), `docs/remote-server-poc.md` (the live setup)

## Context

The shared server is one Compose stack on one VM: the server process spawns a Pi process per session
next to itself, inside bubblewrap, and keeps every session's files on the VM's volume. That shape is
right for a team on one box and wrong for the two things a product needs: more than one box, and a
session that is not pinned to the box it started on.

What we know, measured on 2026-10-18 (`docs/capacity-measurements.md`): an idle Pi session costs about
125 MB; a coding turn on a small Node project costs 150 to 250 MB and two cores for a minute; four
concurrent sessions peaked the container at 1.3 GB. Heavy projects (monorepo builds, Docker, Rust,
browsers) and orchestration (every delegated child is another Pi, a Loop runs around the clock) are
not measured yet and will dominate.

What the vendors do (their docs): Claude Code on the web runs each session in a disposable managed VM,
keeps the GitHub token outside it behind a proxy, enforces an egress allowlist with a proxy outside
the sandbox, and lets an organization route sessions to self-hosted infrastructure it provisions.
Codex cloud runs each task in a container built from a published image, with setup scripts, cached
containers and internet off by default during the agent phase. E2B, whose runtime is open source,
resumes a Firecracker microVM per sandbox from a pre-booted snapshot held in object storage, one
orchestrator per node, Postgres and Redis as the control plane, and runs the same code on its cloud,
on dedicated deployments and in an "Embed" mode on one KVM machine.

The structural differences from our cell are three, and none of them is "sandbox versus cell": the
session's compute is **disposable and resumed from a snapshot**; the session's **state lives outside
the compute**; **no secret enters the compute**. ADR 0009's broker already gives us the third for model
credentials. The GitHub token still enters the session env (SRV-06).

Pi makes the first two cheap: everything Pi needs is on disk (an append-only JSONL transcript, the
worktree, the agent dir), it rebuilds its context from the transcript on resume, and the server already
moves, returns and forks sessions through exactly that path (SRV-12, SRV-15).

The owner's VM is a Proxmox guest that exposes KVM (`/dev/kvm`, virtualization flags, kernel 6.12), so
both stages below can be built there, and more cells can be more VMs on the same host.

## Decision

1. **The company instance is the unit a customer gets.** It is a template: one small control-plane VM,
   one or more execution cells, one object-storage bucket, one Cloudflare Access application and
   tunnel. Spinning up a company is running the template; growing it is adding cells.
2. **The control plane** is the server as it is today minus Pi: identity, the session record, the
   event log, the broker, the web app, the orchestration and Loop engines. It never runs model work.
3. **A cell runs sessions as disposable units.** A session's compute is created for it and may be
   destroyed after it: in stage A a Pi process under bubblewrap in a session-host container with a
   cgroup of its own; in stage B a Firecracker microVM resumed from the project's snapshot. Either
   way the cell is the only place Pi runs.
4. **The runtime host is a seam.** `packages/pi-host` grows a second implementation: the server talks
   to a session host over the network with the same JSONL RPC it reads from a child process today, and
   the session record names the host its session runs on. The desktop stays the `local` host (ADR
   0008); a third implementation may later be a sandbox vendor's API.
5. **State lives outside the compute.** At every turn end the session's transcript and a worktree
   snapshot go to the object store; a project's warm image (repo, installed dependencies, toolchain)
   is a snapshot too. Any cell of the instance can resume any of its sessions; a dead host loses
   minutes, not sessions. Git remains the truth for code.
6. **No secret enters a session.** The broker (ADR 0009) covers model credentials; the GitHub token
   moves behind it as a git proxy that issues scoped repository credentials, as the vendors do. A
   cell's egress is the broker, the object store and the policy's allow-list, nothing else.
7. **Hosting is a property of a cell, not of the product.** Stage A runs on the Proxmox VM; stage B
   runs there too while it fits in memory; cells later run on commodity VMs or dedicated hosts chosen
   per customer (`docs/capacity-measurements.md` carries the price research). KVM is needed only
   for microVM cells; a cell without it runs the stage A shape.
8. **Interoperability.** A company instance can register as the self-hosted environment that Claude
   Code on the web routes an organization's sessions to, so vendor sessions and Agent Deck sessions
   land on the same cells under the same broker and egress rules.

## Alternatives considered

- **Sandbox vendor only (E2B, Daytona, Modal, Fly Machines per session).** Elastic and isolated, ten to
  twenty times the per-hour cost of owned cells, and a dependency for every turn. Kept as a possible
  third runtime host behind the seam, not as the architecture.
- **Kubernetes.** Needs pod user namespaces plus a custom seccomp profile on every node for
  bubblewrap, is unavailable on GKE Autopilot, Fargate and Cloud Run, and buys bin-packing we get from
  cells plus a small autoscaler. Revisit above roughly ten cells.
- **Cloudflare Containers as compute.** At most 4 vCPU, 12 GiB and 20 GB per instance, with no
  documented persistent disk. Cloudflare stays the front door (Access, Tunnel, R2 for the bucket).
- **Bare metal only.** Cheapest GB and KVM included, but one box is one failure domain and nothing
  about the design needs bare metal except microVM cells.
- **Status quo.** One stack per VM: fine for one team, no path to many.

## Consequences (ticket tree, to approve; lane HOST)

- **CAP-01 heavy-load measurement.** The sampler from `docs/capacity-measurements.md` run against this
  repository (pnpm install, build, the unit suites) and a Loop, as real sessions on the VM, so the
  Standard and Power profiles are measured, not assumed. Numbers into the capacity document.
- **HOST-01 runtime-host seam.** `pi-host`: a session-host agent that spawns Pi and bridges its JSONL
  over the Compose network; the server's spawn path chooses `local` or `cell` from the record. Stage A
  split of the Compose stack into `control` and `cell` on the VM, as a separate Compose project beside
  production until it replaces it.
- **HOST-02 state outside the compute.** MinIO on the VM (R2 or S3 later): transcript and worktree
  snapshot at turn end, project warm images, resume from the store. The proof: a turn on cell A, a
  resume on cell B, indistinguishable to the user (two containers; no microVM needed).
- **HOST-03 per-session limits and warm caches.** A cgroup per launch (memory, pids, CPU weight) and
  a per-project dependency cache shared read-only, both inside the stage A cell.
- **HOST-04 git credentials behind the broker.** A git proxy in the control plane issuing scoped
  credentials; `GH_TOKEN` leaves the session env (amends SRV-06 and ADR 0007).
- **HOST-05 the company-instance template.** Cloud-init for a control plane and a cell, the
  Cloudflare API for the Access application and tunnel, a bucket, a runbook page; first exercised as
  a second VM on the Proxmox host.
- **HOST-06 microVM cell spike.** Firecracker (or E2B's runtime in Embed mode) inside a cell on the
  Proxmox VM with `/dev/kvm`: start time from a project snapshot, resume across cells, memory floor
  per session; go/no-go for microVM cells as the stage B default.
- Docs: ADR 0007 and ADR 0009 amended where the cell and the broker's addresses change; the runbook
  gains "Cells" and "Company instance" sections; `remote-server-poc.md` renamed when the POC label
  stops being true.

Sequencing: CAP-01 and HOST-01 first and in parallel; HOST-02 is the decisive one; HOST-03 and
HOST-04 ride along; HOST-05 and HOST-06 after HOST-02 proves resume. The CRB and SUB lanes (ADR 0009)
continue; HOST-04 depends on CRB-02 being merged (it is).

## Open questions for the owner

1. Whether a customer's control plane is one per company (simplest, this ADR) or shared across small
   companies (cheaper per customer, more code).
2. Whether Hetzner, netcup or the Proxmox host is the first external home for cells; the prices in the
   capacity document are from 2026-10-18 and Hetzner's rose in June.
3. Whether to pursue registration as a Claude Code on the web self-hosted environment early (a
   product differentiator) or after the cells exist.
