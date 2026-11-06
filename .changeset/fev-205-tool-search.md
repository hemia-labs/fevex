---
"@fevex/core": minor
---

Add on-demand tool search. Agents can opt into `toolSearch` with `auto`, `on`
or `off` modes, a tool-count or token threshold, pinned tools and a result
limit. Above the threshold the model sees `fevex__search_tools` instead of every
schema; matching tools load for the next turn. Search only indexes the agent's
own tools, and allowlists, policies and approvals still apply when a loaded tool
executes. Loaded tools are persisted in the run checkpoint.
