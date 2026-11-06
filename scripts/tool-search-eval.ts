import { parseArgs } from 'node:util';
import { toolSearchEvalDataset } from './tool-search-eval-data';
import {
  evaluateToolSearch,
  formatJson,
  formatReport,
  lexicalStrategy,
} from './tool-search-eval-lib';

const usage = `bun run eval:tool-search -- [options]

Options:
  --k <n>     Results per query. Default: 5
  --json      Print the full result as JSON
  --help      Show this help

The baseline is deterministic and runs entirely in memory. Add cases in
scripts/tool-search-eval-data.ts.`;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    k: { type: 'string', default: '5' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(usage);
  process.exit(0);
}

const k = Number(values.k);
if (!Number.isSafeInteger(k) || k < 1) {
  console.error('--k must be a positive safe integer');
  process.exit(1);
}

const result = await evaluateToolSearch({
  dataset: toolSearchEvalDataset,
  strategy: lexicalStrategy,
  k,
});
console.log(values.json ? formatJson(result) : formatReport(result));
