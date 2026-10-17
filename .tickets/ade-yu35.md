---
id: ade-yu35
status: closed
deps: []
links: []
created: 2026-10-17T19:53:38Z
type: bug
priority: 2
assignee: almoretti
parent: ade-1c88
---
# QA: deleting a global skill leaves its fan-out link dangling in ~/.pi/agent/skills

Browser run 2026-10-17 on the server. Skills > qa-greet > Delete removed /data/home/.agents/skills/qa-greet (store canonical) but left the fan-out link /data/home/.pi/agent/skills/qa-greet -> (gone). The 39 other dangling links in that folder on the VM point at the owner's desktop paths, so they come from the copied agent dir, but the delete path reproduces the same end state. Pi's discovery and the Skills screen then see a dangling entry. Desktop shares the engine.

## Acceptance Criteria

deleteSkill (EngineSkillStore / engine) removes the fan-out link with the store folder, or the scan prunes dangling fan-out links; test.


## Outcome (2026-10-17)
Fixed: deleteSkill unlinks ~/.pi/agent/skills/<name> when it is a link. Verified on the VM: create qa-del -> delete -> neither the link nor the store folder remain. Closed.
