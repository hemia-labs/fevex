# Real-model playground validation

Recorded on 2026-10-03 through the **Evaluar modelo** action in
`examples/next-playground`, backed by `examples/nest-api`. The model was
`deepseek-v4-flash`, using the existing ignored Nest env file and provider-default
reasoning. No provider keys are stored in these reports.

The model API was real. Documentation came from the repository through the MCP
fixture; account data came from the OpenAPI fixture. These are local test sources,
not live account services or web research.

| Report | Dataset | Passed checks | What it shows |
| --- | --- | --- | --- |
| [initial](./deepseek-v4-flash.initial.json) | 1 | 1/12 | Empty assistant content on tool-call turns was incorrectly parsed as final JSON. |
| [adapter fix](./deepseek-v4-flash.adapter-fixed.json) | 1 | 9/12 | Tool calls work; repeated searches and an unnecessary search for a missing account ID remain. |
| [focused instructions](./deepseek-v4-flash.instructions.json) | 1 | 11/12 | Tool selection passes; one final reply is invalid JSON. |
| [explicit JSON instructions](./deepseek-v4-flash.raw-quotes.json) | 1 | 11/12 | All normal runs complete; a quoted line wrap becomes a space and fails exact character matching. |
| [version 2 baseline](./deepseek-v4-flash.json) | 2 | 12/12 | Quotes tolerate whitespace differences while preserving source and wording checks. |
| [version 3, run 1](./deepseek-v4-flash.v3.run-1.json) | 3 | 21/21 | Section context, complete sourced code and missing-code handling pass. |
| [version 3, run 2](./deepseek-v4-flash.v3.run-2.json) | 3 | 21/21 | The same suite passes again without code or instruction changes. |

The version 2 baseline has five completed runs and one expected API-failure run.
All twelve scores pass. Total wall time was **13,134 ms**. Reported usage is
8,972 input and 962 output tokens (9,934 total). Failed runs may omit usage, so
this is not a complete billing total.

A subsequent normal chat run in the playground also completed for
`¿Cómo uso resumeRun y cuál es el estado y plan de la cuenta 42?`. The UI showed
the documentation answer, its source quotation, and account 42 as active/pro.

The dataset version changed because the quotation scorer now ignores whitespace
and line wrapping. Earlier reports also used different instructions and adapter
behavior; they document debugging, not a controlled performance comparison.
Tests still reject invented URLs, altered quotation wording and unsupported
account facts.

Version 3 adds a requested-code-unavailable case and the `research.code` scorer.
Both consecutive runs have six completed runs, one expected API failure, and all
21 checks passed. Latencies were 17,565 ms and 19,892 ms. Reported token totals
were 14,889 and 15,480 respectively. These reports use the same code and model
configuration; no automatic retries ran between them. The documentation fixture
now returns whole sections and the workflow docs include a distinct `resumeRun`
example, so version 2 latency and scores are not directly comparable.

A normal version 3 chat run also completed for the combined question. The UI
rendered the documented event name, payload and actor in a code block alongside
the answer, sources and account facts. Clicking its copy button showed the
browser's successful `Copiado` state.

These two passing suites are a small sample, not a statistical reliability estimate. An
earlier run contained invalid final JSON; the adapter continues to reject that
output, with no automatic retries or permissive parsing. Evaluate representative
domain data and repeated runs before relying on this example in production.

To reproduce, follow the [playground instructions](../README.md#playground),
choose the configured DeepSeek model, run **Evaluar modelo**, and use
**Descargar JSON**. The download exports the existing report without making new
model calls.
