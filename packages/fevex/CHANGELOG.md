# @fevex/core

## 0.1.0-alpha.4

### Minor Changes

- f4f8020: Deliver elicitation pauses through ChannelAdapter with run, conversation and stable delivery-key correlation. Add deliverChannelRun for retrying stored requests and delivering resumed results without starting another agent run, and extend testChannelAdapter to exercise elicitation retry receipts.

### Patch Changes

- f4f8020: Enforce local sandbox timeout/cancellation with forced process termination and
  bound Unicode output by UTF-8 bytes. Persist effective model identity on agent
  runs so terminal and resumed traces and costs respect model overrides.
  
  Invalidate expired MCP sessions on HTTP 404 and reinitialize on the next call,
  without replaying failed tool calls or invalidating a replacement session when
  an old request finishes late.

## 0.1.0-alpha.3

### Minor Changes

- c5595c5: - `@fevex/core`: Add durable workflows, HTTP transport, teams, channels, knowledge and sandbox APIs, and harden runtime sessions and connections.
  - `@fevex/openai`: Honor tool-choice requests and support `xhigh` and `max` reasoning efforts.
  - `@fevex/deepseek`: Honor tool-choice requests, support `low` and `xhigh` reasoning efforts, and accept null streaming usage.

## 0.1.0-alpha.2

### Minor Changes

- d6322c3: - `@fevex/core`: Add durable workflows, HTTP transport, teams, channels, knowledge and sandbox APIs, and harden runtime sessions and connections.
  - `@fevex/openai`: Honor tool-choice requests and support `xhigh` and `max` reasoning efforts.
  - `@fevex/deepseek`: Honor tool-choice requests, support `low` and `xhigh` reasoning efforts, and accept null streaming usage.
