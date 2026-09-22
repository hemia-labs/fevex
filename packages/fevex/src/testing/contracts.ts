import type { ModelGateway, ModelInput, ModelResult } from '../models';
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelOutput,
} from '../channels';
import type { JsonObject, JsonValue, ToolCall } from '../core';
import type { MemoryStore } from '../knowledge';
import { IntegrationError, type ToolProvider } from '../tools';
import type {
  AgentRun,
  DurableRunStore,
  RunCheckpoint,
  Session,
  ToolExecutionRecord,
} from '../runtime';
import { readModelStream } from '../internal/model-stream';

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

async function assertRejects(operation: () => Promise<unknown>, message: string, code?: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (code !== undefined) {
      assert(error instanceof Error && 'code' in error && error.code === code, message);
    }
    return;
  }
  throw new TypeError(message);
}

export interface ChannelAdapterContract<TInput, TOutput> {
  input: TInput;
  message: ChannelMessage;
  output: ChannelOutput;
  delivered: TOutput;
  ignoredInput?: TInput;
}

export interface ToolProviderContract {
  allowedTool: string;
  input?: unknown;
  output?: unknown;
  disallowedTool?: string;
  safeError?: boolean;
  timeout?: boolean;
}

export async function testMemoryStore(store: MemoryStore): Promise<void> {
  const actor = { id: `actor-${crypto.randomUUID()}` };
  const sessionId = `session-${crypto.randomUUID()}`;
  const context = {
    agentName: 'assistant',
    input: 'refund status',
    sessionId,
    context: { namespace: 'tenant-a', actor },
  };
  const saved = await store.write(
    {
      content: 'Refund status is approved.',
      agentName: 'assistant',
      sessionId,
      namespace: 'tenant-a',
      actor,
      metadata: { source: 'contract' },
    },
    context,
  );
  assert(saved.id.trim(), 'MemoryRecord id cannot be empty');
  assert(saved.createdAt.trim(), 'MemoryRecord createdAt cannot be empty');
  saved.content = 'mutated';
  assert(
    (await store.search({ query: 'refund', sessionId, namespace: 'tenant-a', actor }, context))[0]
      ?.content === 'Refund status is approved.',
    'MemoryStore must not expose mutable record references',
  );
  assert(
    (await store.search({ query: 'refund', sessionId: 'other' }, context)).length === 0,
    'MemoryStore must isolate sessions',
  );
  assert(
    (await store.search({ query: 'refund', namespace: 'tenant-b' }, context)).length === 0,
    'MemoryStore must isolate namespaces',
  );
  assert(
    (await store.search({ query: 'refund', actor: { id: 'other' } }, context)).length === 0,
    'MemoryStore must isolate actors',
  );
  await store.write({ content: 'Refund backup note.', sessionId, namespace: 'tenant-a', actor }, context);
  assert(
    (await store.search({ query: 'refund', sessionId, namespace: 'tenant-a', actor, limit: 1 }, context))
      .length === 1,
    'MemoryStore must respect limits',
  );
  const controller = new AbortController();
  controller.abort();
  await store.search(
    { query: 'refund' },
    { ...context, signal: controller.signal },
  ).then(
    () => {
      throw new TypeError('MemoryStore must reject aborted searches');
    },
    () => {},
  );
}

export async function testToolProvider(
  provider: ToolProvider,
  contract: ToolProviderContract,
): Promise<void> {
  const tools = await provider.listTools({});
  assert(
    tools.some((tool) => tool.name === contract.allowedTool),
    'ToolProvider must list the allowed contract tool',
  );
  if (contract.disallowedTool !== undefined) {
    assert(
      !tools.some((tool) => tool.name === contract.disallowedTool),
      'ToolProvider must not list disallowed tools',
    );
  }

  const output = await provider.callTool(
    contract.allowedTool,
    (contract.input ?? { query: 'value' }) as JsonValue,
    {},
  );
  assert(
    JSON.stringify(output) === JSON.stringify(contract.output ?? { answer: 'ok' }),
    'ToolProvider returned an unexpected output',
  );

  if (contract.safeError) {
    await Promise.resolve(provider.callTool('contract_error', {}, {})).then(
      () => {
        throw new TypeError('ToolProvider must reject configured error calls');
      },
      (error: unknown) => {
        assert(error instanceof IntegrationError, 'ToolProvider errors must be IntegrationError');
        assert(error.message === error.safeMessage, 'IntegrationError message must be safe');
      },
    );
  }

  if (contract.timeout) {
    const controller = new AbortController();
    controller.abort();
    await Promise.resolve(
      provider.callTool(contract.allowedTool, {}, { signal: controller.signal }),
    ).then(
      () => {
        throw new TypeError('ToolProvider must reject aborted calls');
      },
      () => {},
    );
  }
}

export async function testChannelAdapter<TInput, TOutput>(
  adapter: ChannelAdapter<TInput, TOutput>,
  contract: ChannelAdapterContract<TInput, TOutput>,
): Promise<void> {
  assert(adapter.name.trim(), 'ChannelAdapter name cannot be empty');
  const message = await adapter.parse(contract.input, {});
  assert(message !== null, 'ChannelAdapter must parse the contract input');
  for (const [name, value] of [
    ['id', message.id],
    ['deliveryId', message.deliveryId],
    ['conversationId', message.conversationId],
    ['content', message.content],
  ]) {
    assert(value.trim(), `ChannelMessage ${name} cannot be empty`);
  }
  if (message.threadId !== undefined) {
    assert(message.threadId.trim(), 'ChannelMessage threadId cannot be empty');
  }
  if (message.actor !== undefined) {
    assert(message.actor.id.trim(), 'ChannelMessage actor id cannot be empty');
  }
  if (message.metadata !== undefined) {
    JSON.stringify(message.metadata);
  }
  assert(
    JSON.stringify(message) === JSON.stringify(contract.message),
    'ChannelAdapter returned an unexpected message',
  );
  if (contract.ignoredInput !== undefined) {
    assert(
      (await adapter.parse(contract.ignoredInput, {})) === null,
      'ChannelAdapter must ignore the configured input',
    );
  }
  if (contract.output.threadId !== undefined) {
    assert(contract.output.threadId.trim(), 'ChannelOutput threadId cannot be empty');
  }
  if (contract.output.metadata !== undefined) {
    JSON.stringify(contract.output.metadata);
  }
  assert(
    JSON.stringify(await adapter.deliver(contract.output, {}))
      === JSON.stringify(contract.delivered),
    'ChannelAdapter returned an unexpected delivery',
  );
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
  const atomicRunId = `contract-atomic-run-${suffix}`;
  const atomicSessionId = `contract-atomic-session-${suffix}`;
  const atomicRun: AgentRun = {
    id: atomicRunId,
    sessionId: atomicSessionId,
    agentName: 'contract-agent',
    status: 'running',
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
  const atomicSession: Session = {
    id: atomicSessionId,
    history: [],
    createdAt: now,
    updatedAt: now,
  };
  const atomicCheckpoint: RunCheckpoint = {
    version: 2,
    runId: atomicRunId,
    definitionHash: 'atomic-definition',
    messages: [{ role: 'user', content: 'atomic input' }],
    inputContent: 'atomic input',
    step: 1,
    toolCallCount: 0,
    seenToolCallIds: [],
    pendingTools: [],
    pendingIndex: 0,
  };
  const atomicLease = {
    generation: 0,
    runId: atomicRunId,
    ownerId: `atomic-owner-${suffix}`,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
  const atomicStarted = {
    id: `atomic-event-${suffix}`,
    sequence: 1,
    type: 'run.started' as const,
    runId: atomicRunId,
    timestamp: now,
  };
  assert(
    await store.createExecution({
      run: atomicRun,
      session: atomicSession,
      checkpoint: atomicCheckpoint,
      lease: atomicLease,
      events: [atomicStarted],
    }),
    'RunStore must atomically create a new execution',
  );
  assert(
    atomicRun.revision === 1
      && (await store.getRun(atomicRunId))?.revision === 1
      && (await store.getSession(atomicSessionId))?.id === atomicSessionId
      && (await store.getCheckpoint(atomicRunId))?.version === 2
      && (await store.listEvents(atomicRunId))[0]?.id === atomicStarted.id,
    'RunStore createExecution must include run, session, checkpoint, lease, and started event',
  );
  assert(
    !(await store.acquireLease({
      ...atomicLease,
      ownerId: `atomic-competitor-${suffix}`,
    })),
    'RunStore createExecution must acquire the initial lease',
  );
  assert(
    !(await store.createExecution({
      run: { ...atomicRun, revision: 0 },
      session: (await store.getSession(atomicRun.sessionId))!,
      checkpoint: atomicCheckpoint,
      lease: atomicLease,
      events: [atomicStarted],
    })),
    'RunStore createExecution must reject duplicate run ids',
  );
  const ownedSession = (await store.getSession(atomicRun.sessionId))!;
  const competitorId = `competitor-${suffix}`;
  const competitor = () => ({
    run: { ...atomicRun, id: competitorId, revision: 0, status: 'running' as const },
    session: structuredClone(ownedSession),
    checkpoint: { ...atomicCheckpoint, runId: competitorId },
    lease: { ...atomicLease, runId: competitorId },
    events: [],
  });
  assert(!(await store.createExecution(competitor())), 'Active sessions must reject another run');
  await assertRejects(() => store.saveSession(structuredClone(ownedSession)),
    'Compaction must reject an active session');
  assert(await store.commitExecution({
    lease: atomicLease, expectedRevision: atomicRun.revision, run: Object.assign(atomicRun, { status: 'paused' as const }),
  }), 'Owner must be able to pause');
  await store.releaseLease(atomicRunId, atomicLease.ownerId, atomicLease.generation);
  assert(!(await store.createExecution(competitor())), 'Paused sessions remain reserved without a worker lease');
  await assertRejects(() => store.saveSession(structuredClone(ownedSession)),
    'Compaction must reject a paused session');
  assert(await store.acquireLease(atomicLease), 'Resume must acquire a new lease generation');
  assert(await store.commitExecution({
    lease: atomicLease, expectedRevision: atomicRun.revision, run: Object.assign(atomicRun, { status: 'completed' as const }),
    session: ownedSession,
  }), 'Terminal commit must release the session');
  const staleSession = structuredClone(ownedSession);
  await store.saveSession(ownedSession);
  await assertRejects(() => store.saveSession(staleSession), 'Stale compaction must not overwrite history');
  assert(!(await store.createExecution({ ...competitor(), session: staleSession })),
    'Run creation must reject history read before compaction');
  const next = competitor();
  assert(await store.createExecution(next), 'Terminal sessions can be reserved again');
  assert(!(await store.commitExecution({
    lease: next.lease, expectedRevision: next.run.revision, run: next.run, session: staleSession,
  })), 'A stale history commit must fail atomically');
  assert((await store.getRun(next.run.id))?.revision === next.run.revision,
    'Rejected history commits must not advance the run');


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
  const commitLease = { generation: 0, runId, ownerId: `writer-${suffix}`, expiresAt: new Date(Date.now() + 30_000).toISOString() };
  assert(await store.acquireLease(commitLease), 'Writer must acquire a lease');

  const snapshot = await store.getRun(runId);
  assert(snapshot?.status === 'running', 'RunStore must return saved runs');
  snapshot.status = 'failed';
  assert(
    (await store.getRun(runId))?.status === 'running',
    'RunStore must not expose mutable run references',
  );

  await store.saveRun({ ...run, status: 'completed' });
  assert(
    (await store.getRun(runId))?.status === 'completed',
    'RunStore must overwrite an existing run on save',
  );
  await store.saveRun(run);

  const firstEvent = {
    id: `event-1-${suffix}`,
    sequence: 1,
    type: 'run.started' as const,
    runId,
    timestamp: now,
  };
  await store.appendEvent(firstEvent);
  const checkpoint: RunCheckpoint = {
    version: 2,
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
      lease: commitLease, expectedRevision: 0,
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
      lease: commitLease, expectedRevision: 0,
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
  const firstPage = await store.listEvents(runId, { limit: 1 });
  assert(firstPage.length === 1 && firstPage[0]?.id === firstEvent.id,
    'Event pagination must honor limit and start at the first sequence');
  assert((await store.listEvents(runId, { after: firstEvent.id, limit: 1 }))[0]?.id === secondEvent.id,
    'Event pagination must continue after the cursor');
  assert((await store.listEvents(runId, { after: secondEvent.id, limit: 1 })).length === 0,
    'Event pagination after the last event must be empty');
  const latestPage = await store.listEvents(runId, { order: 'desc', limit: 1 });
  assert(latestPage.length === 1 && latestPage[0]?.id === secondEvent.id,
    'Descending pagination must honor limit and find the latest event');
  const descending = await store.listEvents(runId, { order: 'desc', limit: 2 });
  assert(descending.length === 2 && descending[0]?.id === secondEvent.id && descending[1]?.id === firstEvent.id,
    'Event pagination must order by sequence');
  const descendingAfter = await store.listEvents(runId, { after: firstEvent.id, order: 'desc', limit: 2 });
  assert(descendingAfter.length === 1 && descendingAfter[0]?.id === secondEvent.id,
    'Event cursors must select strictly newer sequences even in descending order');
  await assertRejects(() => store.listEvents(runId, { after: atomicStarted.id, limit: 1 }),
    'Event pagination must reject a cursor from another run with INVALID_CURSOR', 'INVALID_CURSOR');
  for (const limit of [0, -1, NaN, Infinity, 1.5]) {
    await assertRejects(() => store.listEvents(runId, { limit }), 'Event pagination must validate limits');
  }
  const events = await store.listEvents(runId, { after: firstEvent.id });
  assert(
    events.length === 1 && events[0]?.id === secondEvent.id,
    'RunStore cursors must return stable ordered suffixes',
  );
  await assertRejects(
    () => store.listEvents(`missing-run-${suffix}`),
    'RunStore listEvents must reject unknown runs',
  );
  await assertRejects(
    () => store.listEvents(runId, { after: `missing-cursor-${suffix}` }),
    'RunStore listEvents must reject unknown cursors with INVALID_CURSOR', 'INVALID_CURSOR',
  );

  assert(
    await store.commitExecution({ lease: commitLease, expectedRevision: 1, run, checkpoint: null }),
    'RunStore must commit a checkpoint deletion',
  );
  assert(
    (await store.getCheckpoint(runId)) === undefined,
    'RunStore must delete the checkpoint when a commit sets it to null',
  );
  assert(
    (await store.getToolExecution(runId, 'tool-call'))?.status === 'completed',
    'RunStore must keep the tool ledger when a checkpoint is deleted',
  );

  await store.releaseLease(runId, commitLease.ownerId, commitLease.generation);
  const lease1 = {
    generation: 0,
    runId,
    ownerId: `owner-1-${suffix}`,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
  const lease2 = {
    generation: 0,
    runId,
    ownerId: `owner-2-${suffix}`,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
  assert(await store.acquireLease(lease1), 'RunStore must acquire a free lease');
  assert(!(await store.acquireLease(lease2)), 'RunStore must reject a competing lease');
  assert(!(await store.renewLease(lease2)), 'RunStore must reject renewal by another owner');
  assert(await store.renewLease(lease1), 'RunStore must renew a matching lease');
  await store.releaseLease(runId, lease1.ownerId, lease1.generation);
  assert(await store.acquireLease(lease2), 'RunStore must release a lease for another owner');
  await store.releaseLease(runId, lease2.ownerId, lease2.generation);

  assert(
    !(await store.renewLease(lease1)),
    'RunStore must reject renewal of a released lease',
  );

  const expiredLease = {
    generation: 0,
    runId,
    ownerId: `owner-3-${suffix}`,
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  };
  const takeoverLease = {
    generation: 0,
    runId,
    ownerId: `owner-4-${suffix}`,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
  assert(await store.acquireLease(expiredLease), 'RunStore must acquire a free lease');
  const beforeTakeover = (await store.getRun(runId))!;
  assert(!(await store.commitExecution({
    lease: expiredLease, expectedRevision: beforeTakeover.revision,
    run: { ...beforeTakeover, status: 'failed' },
  })), 'An expired lease must not commit even before takeover');
  assert(!(await store.renewLease({ ...expiredLease, expiresAt: takeoverLease.expiresAt })),
    'An expired lease cannot be revived by renewal');

  assert(
    await store.acquireLease(takeoverLease),
    'RunStore must let another owner take over an expired lease',
  );
  await store.releaseLease(runId, takeoverLease.ownerId, takeoverLease.generation);
  const oldToken = { ...takeoverLease };
  assert(await store.acquireLease(takeoverLease), 'A released owner can acquire a new generation');
  assert(takeoverLease.generation > oldToken.generation, 'Generation must increase even for the same owner');
  const currentRun = (await store.getRun(runId))!;
  const currentSession = (await store.getSession(sessionId))!;
  const currentEvents = await store.listEvents(runId);
  const currentTool = await store.getToolExecution(runId, 'tool-call');
  assert(currentRun.revision === beforeTakeover.revision, 'Takeover must be tested before revision changes');
  const staleCommit = {
    lease: oldToken, expectedRevision: currentRun.revision,
    run: { ...currentRun, status: 'failed' as const },
    session: { ...currentSession, history: [] },
    checkpoint,
    toolExecution: { ...toolExecution, output: 'stale' },
    events: [{ ...firstEvent, id: `stale-owner-${suffix}`, sequence: 3 }],
  };
  assert(!(await store.commitExecution(staleCommit)),
    'A previous generation must not commit with a still-current run revision');
  assert(!(await store.commitExecution({ ...staleCommit, lease: {
    ...takeoverLease, ownerId: 'wrong-owner',
  } })), 'Generation alone must not authorize a commit');
  assert(!(await store.renewLease({ ...oldToken, expiresAt: takeoverLease.expiresAt })),
    'A stale generation must not renew a new lease owned by the same owner');
  await store.releaseLease(runId, oldToken.ownerId, oldToken.generation);
  assert(await store.renewLease(takeoverLease), 'A stale release must not revoke the new generation');
  assert(JSON.stringify(await store.getRun(runId)) === JSON.stringify(currentRun),
    'Rejected lease commits must not change the run');
  assert(JSON.stringify(await store.getSession(sessionId)) === JSON.stringify(currentSession),
    'Rejected lease commits must not change history');
  assert(JSON.stringify(await store.listEvents(runId)) === JSON.stringify(currentEvents),
    'Rejected lease commits must not append events');
  assert(JSON.stringify(await store.getToolExecution(runId, 'tool-call')) === JSON.stringify(currentTool),
    'Rejected lease commits must not change the tool ledger');
  assert(await store.getCheckpoint(runId) === undefined, 'Rejected lease commits must not create checkpoints');
  assert(await store.commitExecution({
    lease: takeoverLease, expectedRevision: currentRun.revision,
    run: { ...currentRun, status: 'completed' },
  }), 'The current generation must be able to commit');
  await store.releaseLease(runId, takeoverLease.ownerId, takeoverLease.generation);

}
