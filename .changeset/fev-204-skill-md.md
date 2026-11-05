---
"@fevex/core": minor
---

Add explicit `SKILL.md` support with progressive disclosure. `loadSkillFile`
and `loadSkillFiles` parse YAML frontmatter, advertise only name and
description, and load instructions or resources on demand through the reserved
`fevex__load_skill` tool. Add `createAgentsMdContextProvider` for explicit
`AGENTS.md` context. Scripts under `scripts/` are listed but not executed.
