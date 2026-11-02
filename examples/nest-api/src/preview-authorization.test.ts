import { afterEach, expect, test } from 'bun:test';
import { DemoAuthorization } from './authorization';
import { PreviewController } from './preview.controller';
import type { FevexService } from './fevex.service';

const previousDemoAuth = process.env.FEVEX_DEMO_AUTH;

afterEach(() => {
  if (previousDemoAuth === undefined) delete process.env.FEVEX_DEMO_AUTH;
  else process.env.FEVEX_DEMO_AUTH = previousDemoAuth;
});

test('requires authentication and ownership for preview streams', async () => {
  const authorization = new DemoAuthorization();
  authorization.claim({ id: 'run-1', sessionId: 'session-1' }, {
    actor: { id: 'alice' },
    attributes: { tenantId: 'tenant-a' },
  });
  let reads = 0;
  const service = {
    authorization,
    async getRun() {
      reads += 1;
      return undefined;
    },
  } as unknown as FevexService;
  const controller = new PreviewController(service);

  delete process.env.FEVEX_DEMO_AUTH;
  const anonymous = response();
  await controller.preview('run-1', {
    headers: { 'x-fevex-actor': 'alice' },
  }, anonymous.res);
  expect(anonymous.result.status).toBe(401);
  expect(reads).toBe(0);

  const bob = response();
  await controller.preview('run-1', {
    headers: { authorization: 'Bearer bob-token' },
  }, bob.res);
  expect(bob.result.status).toBe(403);
  expect(reads).toBe(0);

  const alice = response();
  await controller.preview('run-1', {
    headers: { authorization: 'Bearer alice-token' },
  }, alice.res);
  expect(alice.result.status).toBe(404);
  expect(reads).toBe(1);
});

function response() {
  const result = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown };
  const res = {
    status(value: number) {
      result.status = value;
      return res;
    },
    setHeader(name: string, value: string) {
      result.headers[name] = value;
    },
    json(value: unknown) {
      result.body = value;
    },
  };
  return { res, result };
}
