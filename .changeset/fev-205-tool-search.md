---
"@fevex/core": minor
---

Add on-demand tool search. `auto` mode is the default and enables search above
30 tools or a configured token threshold; `on` always enables it and `off`
disables it. Configure `threshold`, `tokenThreshold`, `limit` and `pinned`.
Above the threshold the model sees `fevex__search_tools` instead of every
schema; matching tools load for the next turn. Search only indexes the agent's
own tools, and allowlists, policies and approvals still apply when a loaded tool
executes. Loaded tools are persisted in the run checkpoint.
