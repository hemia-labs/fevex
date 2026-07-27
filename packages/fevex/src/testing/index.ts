import type { ModelGateway, ModelInput, ModelResult } from '../models';
import type { JsonObject, ToolCall } from '../core';
import type {
  AgentRun,
  DurableRunStore,
  RunCheckpoint,
  Session,
  ToolExecutionRecord,
} from '../runtime';
import { readModelStream } from '../internal/model-stream';

export interface FakeModel extends ModelGateway {
  readonly calls: readonly ModelInput[];
}

export function fakeModel(...responses: ModelResult[]): FakeModel {
  const calls: ModelInput[] = [];

  return {
    calls,
    async *stream(input) {
      input.signal?.throwIfAborted();

      const response = responses[calls.length];
      calls.push(input);

      if (!response) {
        throw new Error(`fakeModel has no response for call ${calls.length}`);
      }

      if (response.output !== undefined) {
        const delta =
          typeof response.output === 'string' ? response.output : JSON.stringify(response.output);
        if (delta) yield { type: 'output.delta' as const, delta };
      }
      yield { type: 'completed' as const, result: response };
    },
  };
}

export interface ModelGatewayContract {
  output?: unknown;
  toolCall?: ToolCall;
  usage?: boolean;
  error?: Error;
}

const contractOutputSchema: JsonObject = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
const contractToolInputSchema: JsonObject = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
  additionalProperties: false,
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(message);
}

export async function testModelGateway(
  model: ModelGateway,
  contract: ModelGatewayContract = {},
): Promise<void> {
  const output = contract.output ?? { answer: 'ok' };
  const toolCall = contract.toolCall ?? { id: 'call-1', name: 'lookup', input: { query: 'value' } };
  const outputStream = readModelStream(model, {
    messages: [{ role: 'user', content: 'Return a final answer.' }],
    outputSchema: contractOutputSchema,
  });
  const firstOutput = await outputStream.next();
  assert(
    !firstOutput.done && firstOutput.value.length > 0,
    'ModelGateway must stream an output delta before completed',
  );
  const outputResult = await collectModelResult(outputStream);

  assert(outputResult.output !== undefined, 'ModelGateway must return output for a final answer');
  assert(
    JSON.stringify(outputResult.output) === JSON.stringify(output),
    'ModelGateway returned an unexpected output',
  );

  if (contract.usage) {
    assert(
      outputResult.usage !== undefined,
      'ModelGateway must return usage when the contract requires it',
    );
  }

  const toolResult = await collectModelResult(model, {
    messages: [{ role: 'user', content: 'Call lookup.' }],
    tools: [
      { name: 'lookup', description: 'Look up a value.', inputSchema: contractToolInputSchema },
    ],
  });

  assert(toolResult.toolCalls?.length === 1, 'ModelGateway must return one tool call');
  assert(
    toolResult.toolCalls[0]?.id === toolCall.id,
    'ModelGateway returned an unexpected tool call id',
  );
  assert(
    toolResult.toolCalls[0]?.name === toolCall.name,
    'ModelGateway returned an unexpected tool name',
  );
  if (model.stateCodec && toolResult.providerState !== undefined) {
    const serialized = model.stateCodec.serialize(toolResult.providerState);
    const restored = model.stateCodec.restore(structuredClone(serialized));
    assert(
      JSON.stringify(model.stateCodec.serialize(restored)) === JSON.stringify(serialized),
      'ModelGateway stateCodec must preserve provider state across a JSON round-trip',
    );
  }

  const controller = new AbortController();
  controller.abort();
  await collectModelResult(model, {
    messages: [{ role: 'user', content: 'This call is aborted.' }],
    signal: controller.signal,
  }).then(
    () => {
      throw new TypeError('ModelGateway must reject aborted calls');
    },
    () => {},
  );

  if (contract.error) {
    await collectModelResult(model, {
      messages: [{ role: 'user', content: 'Propagate an error.' }],
    }).then(
      () => {
        throw new TypeError('ModelGateway must propagate provider errors');
      },
      (error) => {
        assert(error === contract.error, 'ModelGateway must preserve provider error identity');
      },
    );
  }
}

async function collectModelResult(
  modelOrStream: ModelGateway | AsyncGenerator<string, ModelResult>,
  input?: ModelInput,
): Promise<ModelResult> {
  const stream = 'stream' in modelOrStream ? readModelStream(modelOrStream, input!) : modelOrStream;
  while (true) {
    const next = await stream.next();
    if (next.done) return next.value;
  }
}

export async function testRunStore(store: DurableRunStore): Promise<void> {
  const suffix = crypto.randomUUID();
  const runId = `contract-run-${suffix}`;
  const sessionId = `contract-session-${suffix}`;
  const now = new Date().toISOString();
  const session: Session = {
    id: sessionId,
    history: [],
    createdAt: now,
    updatedAt: now,
  };
  const run: AgentRun = {
    id: runId,
    sessionId,
    agentName: 'contract-agent',
    status: 'running',
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
  await store.saveSession(session);
  await store.saveRun(run);

  const snapshot = await store.getRun(runId);
  assert(snapshot?.status === 'running', 'RunStore must return saved runs');
  snapshot.status = 'failed';
  assert(
    (await store.getRun(runId))?.status === 'running',
    'RunStore must not expose mutable run references',
  );

  const firstEvent = {
    id: `event-1-${suffix}`,
    sequence: 1,
    type: 'run.started' as const,
    runId,
    timestamp: now,
  };
  await store.appendEvent(firstEvent);
  const checkpoint: RunCheckpoint = {
    runId,
    definitionHash: 'definition',
    messages: [{ role: 'user', content: 'input' }],
    inputContent: 'input',
    step: 1,
    toolCallCount: 0,
    seenToolCallIds: ['tool-call'],
    pendingTools: [
      {
        call: { id: 'tool-call', name: 'lookup', input: { query: 'value' } },
        input: { query: 'value' },
        idempotencyKey: `key-${suffix}`,
        attempt: 1,
      },
    ],
    pendingIndex: 0,
  };
  const toolExecution: ToolExecutionRecord = {
    runId,
    toolCallId: 'tool-call',
    toolName: 'lookup',
    input: { query: 'value' },
    status: 'completed',
    attempt: 1,
    idempotencyKey: `key-${suffix}`,
    output: { answer: 'ok' },
    updatedAt: now,
  };
  session.history.push({ role: 'system', content: 'committed' });
  const secondEvent = {
    id: `event-2-${suffix}`,
    sequence: 2,
    type: 'tool.completed' as const,
    runId,
    timestamp: now,
    payload: { step: 1, toolCallId: 'tool-call', toolName: 'lookup' },
  };
  assert(
    await store.commitExecution({
      expectedRevision: 0,
      run,
      session,
      checkpoint,
      toolExecution,
      events: [secondEvent],
    }),
    'RunStore must commit a matching revision',
  );
  assert(run.revision === 1, 'RunStore must advance the committed run revision');
  assert(
    (await store.getSession(sessionId))?.history.length === 1 &&
      (await store.getCheckpoint(runId))?.definitionHash === 'definition' &&
      (await store.getToolExecution(runId, 'tool-call'))?.status === 'completed',
    'RunStore atomic commits must include session, checkpoint, and tool ledger',
  );
  assert(
    !(await store.commitExecution({
      expectedRevision: 0,
      run: { ...run, status: 'failed' },
      events: [
        {
          id: `stale-event-${suffix}`,
          sequence: 3,
          type: 'run.failed',
          runId,
          timestamp: now,
          payload: { error: 'stale' },
        },
      ],
    })),
    'RunStore must reject stale revisions',
  );
  const events = await store.listEvents(runId, { after: firstEvent.id });
  assert(
    events.length === 1 && events[0]?.id === secondEvent.id,
    'RunStore cursors must return stable ordered suffixes',
  );

  const lease1 = {
    runId,
    ownerId: `owner-1-${suffix}`,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
  const lease2 = {
    runId,
    ownerId: `owner-2-${suffix}`,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
  assert(await store.acquireLease(lease1), 'RunStore must acquire a free lease');
  assert(!(await store.acquireLease(lease2)), 'RunStore must reject a competing lease');
  assert(!(await store.renewLease(lease2)), 'RunStore must reject renewal by another owner');
  assert(await store.renewLease(lease1), 'RunStore must renew a matching lease');
  await store.releaseLease(runId, lease1.ownerId);
  assert(await store.acquireLease(lease2), 'RunStore must release a lease for another owner');
  await store.releaseLease(runId, lease2.ownerId);
}
