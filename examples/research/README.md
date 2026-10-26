# Research with MCP, OpenAPI and evaluations

This example and the Nest + Next playground import the same `researchAgent`
definition from `agent.ts`. The model chooses documentation searches and account
reads, then returns an answer, cited sources with verbatim evidence, and account
facts. Only the two read tools are exposed; missing information returns an
`insufficient` answer. Transport failures fail the run through Fevex's existing
error contract.

Each question makes one focused documentation search and/or one account read.
Missing account IDs are requested before calling the account API. Answers explain
the limits of the retrieved excerpt instead of guessing or repeating searches.
Documentation search returns complete heading sections, including nearby code,
with at most three matches of 6,000 characters each. Oversized or incomplete
sections are skipped instead of cutting a code block. This is a small local
fixture, not an indexed documentation service.

## Without API keys

From the repository root, with workspace dependencies installed:

```bash
bun run demo:research
bun run eval:research
bun test examples/research/evaluation.test.ts
bun x tsc -p examples/research/tsconfig.json
```

The demo uses a scripted model and actual HTTP against a temporary localhost
fixture. The eval uses the same MCP/OpenAPI adapters with an injected fixture
fetch, so it needs no listening port. These checks verify runtime behavior and
the scorers; they do not measure real model quality. Scripted token usage is
synthetic. No VM or browser is required.

## With a real model

Choose a model ID available in your provider account and set its key in your
environment. The adapters already in the workspace handle model requests:

```bash
# OPENAI_API_KEY must be set; MODEL_ID is your provider's model ID.
bun run demo:research --provider openai --model "$MODEL_ID" \
  --question '¿Cómo uso resumeRun y cuál es el estado y plan de la cuenta 42?'
bun run eval:research --provider openai --model "$MODEL_ID" --json

# DEEPSEEK_API_KEY must be set for this provider.
bun run eval:research --provider deepseek --model "$MODEL_ID"
```

Real model runs use the provider API and incur its normal usage. The default
sources remain local repository documentation and a synthetic account:
`{ id: 42, status: "active", plan: "pro" }`. Other account IDs are unavailable;
ID `503` deliberately simulates an unavailable service. Runs have explicit
step, tool-call and output-token limits, plus a two-minute timeout.

For research against external services, set **both** `RESEARCH_MCP_URL` and
`RESEARCH_API_URL`. The MCP service must expose `search({ query })` returning
`{ matches: [{ title, url, excerpt }] }`. The API must match the bundled OpenAPI
`GET /accounts/{id}` and its account schema. For a different API, adapt that
document and the agent's tools. Optional `RESEARCH_DOCS_TOKEN` and
`RESEARCH_API_TOKEN` are host-supplied bearer credentials. Each MCP provider is
scoped to that identity; endpoint and credential selection are not model input.
Authorize actual account access in the host/service.

## Evaluations

The seven versioned cases cover documentation, accounts, combined research,
empty search results, missing account IDs, missing requested code and an API failure. Existing
`@fevex/core/evals` provides the runner, tool-selection scorer and reports.
The custom evidence scorer compares sources/quotes and structured account facts
with **actual tool replies seen by the model**. Negative tests reject invented
URLs, quotes and account facts. Quotation checks ignore whitespace and line wrapping
when comparing quotations; words, punctuation, source titles and URLs must
still match retrieved evidence.

Version 3 adds `research.code`: API-usage answers must include a complete
documented `app.resumeRun` example. Every answer code block must match an entire
block from a retrieved, cited source, including its internal whitespace.
Invented parameters, edited code, partial blocks and uncited examples fail the
check. If the requested `stepId` example is absent, the answer must say the
information is insufficient and include no code. These are evaluation checks,
not a runtime guarantee that every model answer is correct.

The API-failure case intentionally has `status: failed`; both its scores must
pass. Thus a passing suite reports six completed runs, one expected failure,
and twenty-one passed checks. The command exits nonzero for unexpected failures or
failed/error/skipped checks. `--json` emits the public `fevex.eval.v1` report.

Evaluations always use isolated in-memory runs and local fixture data, including
when normal research is configured with external endpoints. They do not alter
the playground conversation or its SQLite store. Evidence checks validate
citation provenance and structured facts; they are not a semantic assessment
of every claim in the answer. Add domain-specific checks and representative
cases when adapting the example.

## Playground

Start `bun run dev:nest` with your existing provider configuration, then
`bun run dev:next`. Select **Investigación MCP + OpenAPI**. The timeline shows
the two connections; the final response displays steps, copyable code, cited
evidence and account facts. Code is displayed as escaped text and is never
executed by the UI. **Evaluar modelo** explicitly runs the seven cases using the selected
model and shows checks per case. It uses that model's default reasoning setting.
**Descargar JSON** saves the public evaluation report, including case results,
reported token usage and latency, without executing the model again.

If your ignored env file is `examples/nest-api/.env.local`, load it explicitly
from that example directory:

```bash
cd examples/nest-api
bun --env-file=.env.local src/main.ts
```

Start the UI in a second terminal from the repository root. If port 3000 is
already occupied, choose another port:

```bash
bun run --cwd examples/next-playground dev --port 3141 --hostname 127.0.0.1
```

Open `http://localhost:3141`, choose a configured model, then run **Evaluar
modelo**. Provider keys remain in the Nest process; they are not sent to the UI
or included in downloaded reports. See [recorded runs](./baselines/) for the
real-model validation and its limits.

Nest uses fixture fetch by default, without a separate MCP process. Only the
standalone demo opens a fixture HTTP port. Nest's host-only
`POST /research/evaluations` accepts `{ model: "deepseek" | "openai" }`; it is
an example route, not a new Fevex core protocol. Concurrent evaluations return
409 and execution is bounded to two minutes. The existing example actor/auth
limitations apply. The full Studio/builder remains future work.
