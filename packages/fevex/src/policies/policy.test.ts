import { expect, test } from 'bun:test';
import type { ToolRisk } from '../tools';
import { riskGuardrail } from './policy';

const authorization = (risk: ToolRisk) => ({
  runId: 'run-1',
  agentName: 'assistant',
  toolName: 'tool',
  risk,
  input: {},
  action: 'tool.execute' as const,
});

test('riskGuardrail denies destructive and requires approval for sensitive by default', async () => {
  const policy = riskGuardrail();
  expect(policy.name).toBe('risk');
  expect(await policy.authorize(authorization('read'))).toBe('allow');
  expect(await policy.authorize(authorization('write'))).toBe('allow');
  expect(await policy.authorize(authorization('sensitive'))).toBe('require_approval');
  expect(await policy.authorize(authorization('destructive'))).toBe('deny');
});

test('riskGuardrail supports explicit thresholds and names', async () => {
  const policy = riskGuardrail({
    name: 'tenant-risk',
    deny: ['sensitive', 'destructive'],
    requireApproval: ['write'],
  });
  expect(policy.name).toBe('tenant-risk');
  expect(await policy.authorize(authorization('read'))).toBe('allow');
  expect(await policy.authorize(authorization('write'))).toBe('require_approval');
  expect(await policy.authorize(authorization('sensitive'))).toBe('deny');
});

test('riskGuardrail can fail closed for tools without a declared risk', async () => {
  const deny = riskGuardrail({ undeclaredRisk: 'deny' });
  expect(await deny.authorize(authorization('read'))).toBe('deny');
  expect(await deny.authorize({ ...authorization('read'), declaredRisk: 'read' })).toBe('allow');

  const approve = riskGuardrail({ undeclaredRisk: 'require_approval' });
  expect(await approve.authorize(authorization('read'))).toBe('require_approval');
  expect(await approve.authorize({ ...authorization('read'), declaredRisk: 'read' })).toBe('allow');
});

test('riskGuardrail validates its options', () => {
  expect(() => riskGuardrail({ name: ' ' })).toThrow('name');
  expect(() => riskGuardrail({ deny: ['unknown' as ToolRisk] })).toThrow('invalid tool risk');
  expect(() => riskGuardrail({ requireApproval: ['unknown' as ToolRisk] })).toThrow(
    'invalid tool risk',
  );
  expect(() => riskGuardrail({ undeclaredRisk: 'unknown' as 'deny' })).toThrow(
    'undeclaredRisk',
  );
});
