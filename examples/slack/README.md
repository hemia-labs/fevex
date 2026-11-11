# Slack channel example

Runnable host that connects a Fevex agent to the Slack Events API. It uses the
repository-only `@fevex/slack` adapter, `@fevex/sqlite` and `@fevex/mcp`.

Account data comes from MCP tools, not local functions. By default the example
starts a small stateless MCP `2026-07-28` fixture on localhost and connects to
it through `createMcpToolProvider`. Set `FEVEX_MCP_URL` to use an external MCP
server with the same `accounts_list` and `accounts_get` tools.

Demo accounts:

| ID | Name | Status | Plan |
| --- | --- | --- | --- |
| 1 | Acme Starter | active | free |
| 7 | Acme Paused | paused | free |
| 42 | Acme Pro | active | pro |
| 99 | Acme Enterprise Trial | paused | pro |

The default model is deterministic. It lists accounts when asked for a list,
looks up a numeric account ID through MCP and answers with status and plan.
Unknown IDs return `found: false` instead of failing the run. No API key is
required. The browser simulator can switch to a real OpenAI or DeepSeek model
at runtime.

## Simulated chat: no Slack account

If `SLACK_SIGNING_SECRET` or `SLACK_BOT_TOKEN` is missing, the host starts in
simulator mode automatically:

```bash
bun run demo:slack
# open http://localhost:3000
```

The page signs local Events API payloads, runs the same `handleSlackWebhook`
path and captures `chat.postMessage`. It does not contact Slack.

- **Scripted** provider: no key. Try `list accounts`, `account 42` or
  `account 67` to see a not-found result.
- **OpenAI** provider: enter the API key and the exact model ID available in
  your account, then press **Apply**.
- **DeepSeek** provider: same flow with a DeepSeek key.

The API key is sent to the local process and kept in memory only. It is not
written to disk or logs. Do not use the simulator through a public tunnel.

Forced simulation:

```bash
FEVEX_SLACK_SIMULATE=1 bun run demo:slack
```

## What it demonstrates

- Slack request signature verification over the raw body.
- `url_verification` handling.
- MCP discovery, `accounts_list` and `accounts_get` through the connection
  allowlist.
- Tool activity shown under each assistant reply.
- Mentions and direct messages mapped to Fevex runs.
- One Fevex session per Slack thread or DM channel.
- Deduplication of Slack retries by `event_id`.
- Durable delivery receipts in SQLite.
- Graceful shutdown of the HTTP host, MCP fixture and both SQLite connections.

## Run locally

```bash
cp examples/slack/.env.example examples/slack/.env.slack
# Fill SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN and SLACK_BOT_USER_ID.
set -a; source examples/slack/.env.slack; set +a
bun run demo:slack
```

Expose the local port with a tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
# or: ngrok http 3000
```

Use the public URL as the Slack Events API request URL:
`https://<tunnel>/slack/events`.

## Run with Docker

```bash
# Build the tarballs and a small runtime image.
bun run docker:slack

cd examples/slack
cp .env.example .env.slack
# Fill the Slack values, or leave them empty for simulator mode.
docker compose up
```

For simulator mode, leave `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` empty and
open `http://localhost:3000` after the container starts. `docker compose up`
starts only the bot. For a real Slack workspace, start the tunnel profile:

```bash
docker compose --profile tunnel up
```

and use the public URL printed by `cloudflared` as the Slack request URL.

`docker:slack` builds the repository tarballs into `examples/slack/.release/`
(gitignored), installs only the runtime packages into the image, and tags it as
`fevex-slack-example:local`. The image is about 115 MB and does not contain the
monorepo, dev dependencies, applications or other examples.
`docker compose up --build` also works after the tarballs exist.

This Docker check is manual. CI typechecks the example, but version PRs contain
unpublished package versions and cannot resolve those sibling tarballs from the
registry during an image build.

`cloudflared` only starts with the `tunnel` profile and prints the public URL in
its logs. If you prefer ngrok on the host, skip the profile and run
`ngrok http 3000` instead.

The SQLite database and session map live in the `slack-data` volume at
`/data/slack.sqlite` and `/data/sessions.json`. They survive container restarts.
Use `docker compose down -v` only when you want to delete the data.

## Slack app setup

In the Slack app settings:

1. Add bot scopes: `app_mentions:read`, `chat:write` and `im:history`.
2. Enable Event Subscriptions and set the request URL to
   `https://<tunnel>/slack/events`.
3. Subscribe to `app_mention` and `message.im`.
4. Install the app in the workspace.
5. Copy the Bot User OAuth Token and Signing Secret into `.env.slack`.
6. Set `SLACK_BOT_USER_ID` to the bot user ID so mentions are stripped from the
   agent input.

Do not subscribe to both `app_mention` and `message.channels` for mentions:
Slack sends different event IDs and both would start a run. This example does
not enable ambient channel messages.

## Test matrix

1. **URL verification**: Slack saves the request URL without an error.
2. **Mention**: `@bot what is the status of account 42?` replies in a thread.
3. **Direct message**: a DM receives a reply in the DM.
4. **Invalid signature**: a request without valid Slack headers returns `401`
   and starts no run.
5. **Retry dedupe**: replay the same event with a valid signature and
   `X-Slack-Retry-Num: 1`; only one run and one reply are produced.
6. **Restart**: `docker compose restart slack-bot`, replay the event, and verify
   that SQLite still rejects the duplicate.
7. **Real model**: set `FEVEX_PROVIDER`, `FEVEX_MODEL` and the provider key;
   ask a question that requires the `accounts_get` tool.

Inspect persisted state:

```bash
docker compose exec slack-bot bun -e "import { Database } from 'bun:sqlite'; const db = new Database('/data/slack.sqlite'); console.log(db.query('select * from channel_events').all()); console.log(db.query('select * from channel_deliveries').all());"
```

## Real model

```bash
FEVEX_PROVIDER=openai
FEVEX_MODEL=<your-model-id>
OPENAI_API_KEY=...
```

or:

```bash
FEVEX_PROVIDER=deepseek
FEVEX_MODEL=<your-model-id>
DEEPSEEK_API_KEY=...
```

The provider must support the capabilities used by the example: streaming,
tool calls and a system/user message loop. The scripted model remains the
default so the transport can be tested without keys.

## Security and scope

- `.env.slack` is ignored by Git. Do not commit tokens or signing secrets.
- The adapter verifies Slack's signature and five-minute replay window before
  parsing the payload.
- This example authorizes every Slack user in the workspace. Production hosts
  must add an allowlist or resource authorization before exposing tools.
- Rotate the bot token after testing.
- The Docker image installs the repository tarballs and is intended for local
  integration tests, not as a hardened production deployment.
- OAuth multi-workspace installation, Block Kit, slash commands, attachments,
  approvals and prior thread history are out of scope. Elicitation routing is
  covered by [`examples/channel-elicitation`](../channel-elicitation/).
