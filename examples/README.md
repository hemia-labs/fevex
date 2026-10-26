# Choose an example

Run commands from the repository root with Bun 1.3.2, after
`bun install --frozen-lockfile`. Agent and tool definitions are ordinary TypeScript;
the catalog helps you choose a starting point and is not part of execution.

| Start here | Run | Requirements | Adapt |
| --- | --- | --- | --- |
| [Starter](starter/) | `bun run demo:starter` | No keys or network | `agent.ts`: instructions, tool lookup, schemas and limits. |
| [Channels and resolvers](channel-elicitation/) | `bun run demo:channels` | No keys or network | Adapter, trusted routing, durable receipts and responder identity. |
| [MCP and OpenAPI](connections/) | `bun run demo:connections` | Local HTTP; no keys | Endpoint, OpenAPI document, allowlists and credentials. |
| [Research and evals](research/) | `bun run demo:research`; `bun run eval:research` | Scripted mode without keys; optional real model | Shared agent, section context, code evidence, fixtures and seven eval cases. |
| [HTTP playground](nest-api/) | `bun run dev:nest` | OpenAI or DeepSeek key | Agents, tools, HTTP host, authentication and SQLite persistence. |
| [Playground UI](next-playground/) | `bun run dev:next` | Running Nest API | Frontend views consuming the public HTTP client. |
| [MCP server](nest-mcp/) | `bun run dev:mcp` | Local HTTP; no keys | SDK-backed server tool registrations. |

The first four examples default to scripted models and synthetic account data. They verify
the runtime contracts, not the answer quality of a real model. Their READMEs
explain how to replace fixtures with actual services and model gateways.
The research example also runs with a real model and is shared with the
playground's research agent, source view and evaluation action.

## Adapt a template

1. Start with the smallest example that includes the capability you need.
2. Copy its agent/tool definitions and `createFevex` composition into your app.
3. Replace the deterministic model with a gateway under the same registry name.
4. Replace synthetic lookups with authorized data access and validate inputs.
5. Set explicit tool allowlists, interaction modes and resource limits.
6. Keep deterministic checks, and add representative eval cases for real models.

When runs must survive restarts, configure a persistent store. The host owns
authentication, tenant/resource authorization, channel correlation, scheduling
and delivery receipts; example identities and Maps are demonstration data.

## Inspect a run

The starter prints the final run ID and a metadata-only trace. To keep it
available for inspection in another terminal:

```bash
bun run demo:starter --serve
```

Copy `api` and `runId` from its final JSON line, then run:

```bash
bun run inspect RUN_ID --api http://127.0.0.1:PORT --events
```

The host is restricted to localhost and GET requests. Stop it with Ctrl+C.
Runs are in memory and disappear when it stops. For the Nest host, use
`bun run inspect RUN_ID --api http://localhost:3001 --events`.

The inspector prints run state and event metadata as JSON lines. It uses only
the public HTTP client and never starts, resumes, cancels or recovers a run.
The default timeout is ten seconds. `--events` replays the journal and follows
a running execution until it pauses or finishes; a timeout exits with a nonzero
code and does not cancel the run. Reconnect after the last printed event ID:

```bash
bun run inspect RUN_ID --api http://localhost:3001 --events --after EVENT_ID --timeout-ms 30000
```

Set `FEVEX_API_TOKEN` in your environment if your HTTP host expects bearer
authentication. Do not put credentials in the URL. The inspector does not print
run outputs, prompts, tool inputs, pause request content or event payloads.
The host still controls authorization of reads; metadata may also be sensitive.
