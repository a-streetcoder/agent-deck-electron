---
id: ade-si3i
status: open
deps: []
links: []
created: 2026-10-17T07:43:06Z
type: sandbox
priority: 3
assignee: almoretti
parent: ade-1c88
---
# SBX-08: image gap — Ruby toolchain (libyaml-dev, zlib1g-dev; glibc 2.38 or ruby-build)

From SBX-06 run 1: no Ruby runs in the image. rv's relocatable Ruby needs glibc 2.38 (Debian 12 has 2.36); ruby-build needs libyaml-dev and zlib1g-dev in the builder layer. Decide: add the two -dev packages so ruby-build works per user into /data/home (preferred, smallest), or move the base image to Debian 13 (glibc 2.38, also lets rv work) and re-run SBX-01's profile checks. Document the per-user line in docs/stack-matrix.md and re-run the rails stack.

