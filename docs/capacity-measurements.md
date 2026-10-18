# Capacity measurements (shared server)

What one live session costs on the shared server, measured on the production VM on 2026-10-18,
and what that means for sizing. Idle numbers are measurements; the per-session planning figures
derive from them; everything about large projects is still an assumption (see "Not measured").

## Method

- Host: the production VM (6 vCPU, 7 GB RAM, 148 GB disk at 82 percent), container `agent-deck`
  capped at 3.7 GB, image `poc-6d7497f` (CRB-02 broker on).
- Sampler: every 3 to 5 seconds, `docker stats` for the container (CPU, memory, pids) and the six
  largest processes by resident memory (`/proc/*/status`). Sharp peaks shorter than a sample
  interval are missed, so the peaks below are lower bounds.
- Load: real sessions in the CrunchyMurmur project (a small Node and Electron app, 98 unit tests,
  a lint that builds an editor bundle), driven through `POST /sessions` and `POST /sessions/:id/prompt`
  on the model `openai-codex/gpt-6-luna` through the credential broker.

## Measurements

| Situation | Container memory | CPU | pids | Notes |
|---|---|---|---|---|
| Server alone (no live Pi) | 190 MB (server process) | 0 | 20 | |
| One idle Pi session | +120 to 130 MB | 0 | +5 | Pi plus socat helpers |
| One active Pi during a turn | 150 to 190 MB | low | | Context of a few thousand tokens |
| One session: `npm ci`, `npm test`, `npm run lint` (with a bundle build) | peak 662 MB (baseline 478 MB with 3 Pi) | peak 200 percent (two cores) for about a minute | peak 124 | Turn took about 90 s, 4 model calls |
| Four concurrent coding sessions (e2e tests, a doc-writing read of src/, repeated test runs, a TODO inventory) over a baseline of 5 idle Pi | peak 1.30 GB (baseline 790 MB) | peak 210 percent, mostly under one core | peak 266 | Each turn 12 to 60 s, 5 to 16 model calls |

Derived planning figures for a **small Node project**:

| Component | Idle | Active |
|---|---|---|
| Pi process | 125 MB | 150 to 190 MB |
| Session's tool processes (install, test, lint) | 0 | 150 to 250 MB, bursts of 2 cores for a minute |
| Processes per live session | 5 | 30 to 70 |
| Whole live session, planning figure | 130 MB | 300 MB, 0.25 core average |

## Sizing

| Target | Memory | CPU | Notes |
|---|---|---|---|
| Today's VM (3.7 GB container) | about 10 idle Pi, or 6 to 8 active sessions on a small project | 6 vCPU: three simultaneous installs saturate it | Disk is the first wall: 82 percent full |
| 300 live sessions, small projects | 90 GB for sessions plus 20 to 40 GB for simultaneous installs and headroom: **128 GB** | 32 vCPU | pid limit must rise above 4096 (about 15 000) |
| 300 live sessions, mixed with heavy builds (TypeScript monorepos, Rust, Docker) | unknown, see below | unknown | |

A 32 vCPU, 128 GB cloud VM or four cells of 8 vCPU and 32 GB each (one team per cell) carries 300
light sessions. Bare metal is not required: the sandbox needs user namespaces, seccomp and
AppArmor on a Linux kernel, which any ordinary VM provides; nested virtualization is not needed.

## Not measured

- Large projects: a `pnpm build` of this repository or a Rust or Docker build inside a session will
  take gigabytes and several cores; the mixed-load line above stays open until it is measured the
  same way on such a project.
- Long contexts: a Pi process holding a 150k-token context was not sampled.
- Sustained concurrency over hours (memory growth of the server process, log and session file
  growth on disk).
- Per-session limits: the container limit is the only cap today, so one runaway build takes the
  whole box. A cgroup per launch is the precondition for the planning figures to hold.

## How to repeat

Run the sampler on the VM (`docker stats --no-stream` and the `/proc/*/status` sum every few
seconds, read-only), then create sessions and prompts through the HTTP API as above. Delete the
sessions afterwards (`DELETE /sessions/:id`) and restore the project checkout the sessions edited.
