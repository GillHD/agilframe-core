/**
 * Billing tools: mocked fetch — no live server.
 * Verifies endpoints/query, read-only flags, output shape and error hints.
 */
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { McpEnv } from '../src/env.js';
import { AgilHttpClient } from '../src/http-client.js';
import { billingToolSpecs } from '../src/tools/billing.js';
import type { ToolOutcome, ToolContext } from '../src/tool-kit.js';

const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; method: string }> = [];

beforeEach(() => {
  calls.length = 0;
});

after(() => {
  globalThis.fetch = originalFetch;
});

function makeContext(): ToolContext {
  const env: McpEnv = {
    serverUrl: 'http://billing.test',
    apiKey: 'admin-key',
    tenantId: 'demo',
    scimToken: '',
    timeoutMs: 5000,
    mode: 'full',
  };
  return { env, client: new AgilHttpClient(env) };
}

function mockResponses(responses: Array<{ status: number; body: unknown }>): void {
  let index = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

async function run(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const spec = billingToolSpecs().find((candidate) => candidate.name === name);
  assert.ok(spec, `${name} must exist`);
  return spec.handler(args, makeContext());
}

test('billing: both tools are read-only', () => {
  const specs = billingToolSpecs();
  assert.equal(specs.length, 2);
  for (const spec of specs) {
    assert.equal(spec.write, false, `${spec.name} must be read-only`);
    assert.equal(spec.online, true, `${spec.name} must be online`);
  }
});

test('billing_usage: GET /v1/admin/billing/usage and compact output', async () => {
  mockResponses([
    {
      status: 200,
      body: {
        tenantId: 'demo',
        month: '2026-11',
        billing: { enabled: true, plan: 'team', includedMinutes: 3000, maxParticipants: 25, maxRooms: 50, overagePolicy: 'warn' },
        usage: { tenantId: 'demo', month: '2026-11', minutes: 12.5, roomsCreated: 2, participantJoins: 3, peakParticipants: 2, recordings: 1, recordingMinutes: 4, createdAt: 1, updatedAt: 2 },
        live: { activeRooms: 1, activeParticipants: 2, liveMinutes: 0.5, totalMinutes: 13 },
        quota: { includedMinutes: 3000, maxParticipants: 25, maxRooms: 50, overagePolicy: 'warn', minutesRemaining: 2987, overageMinutes: 0 },
        months: ['2026-11'],
        warnings: [],
      },
    },
  ]);
  const outcome = await run('billing_usage', {});
  assert.equal(outcome.isError, undefined);
  assert.deepEqual(calls[0], { url: 'http://billing.test/v1/admin/billing/usage', method: 'GET' });
  const value = JSON.parse(outcome.text) as Record<string, any>;
  assert.equal(value.plan, 'team');
  assert.equal(value.enforcementEnabled, true);
  assert.equal(value.usage.minutes, 12.5);
  assert.equal(value.live.totalMinutes, 13);
  assert.equal(value.quota.minutesRemaining, 2987);
});

test('billing_usage: month query is passed through and validated', async () => {
  mockResponses([{ status: 200, body: { tenantId: 'demo', month: '2026-10', billing: {}, usage: {}, live: {}, months: [], warnings: [] } }]);
  const outcome = await run('billing_usage', { month: '2026-10' });
  assert.equal(outcome.isError, undefined);
  assert.equal(calls[0]?.url, 'http://billing.test/v1/admin/billing/usage?month=2026-10');

  const spec = billingToolSpecs().find((candidate) => candidate.name === 'billing_usage')!;
  assert.equal(spec.inputSchema.safeParse({ month: '2026-13' }).success, false);
  assert.equal(spec.inputSchema.safeParse({ month: '2026-10' }).success, true);
  assert.equal(spec.inputSchema.safeParse({}).success, true);
});

test('billing_status: GET /v1/admin/billing/plan and plan summary', async () => {
  mockResponses([
    {
      status: 200,
      body: {
        tenantId: 'demo',
        billing: { enabled: false, plan: 'free', includedMinutes: 0, maxParticipants: 12, maxRooms: 5, overagePolicy: 'warn' },
        plans: { free: { includedMinutes: 0, maxParticipants: 12, maxRooms: 5 } },
        usage: { month: '2026-11', minutes: 0, totalMinutes: 0, roomsCreated: 0, participantJoins: 0, peakParticipants: 0, recordings: 0, activeRooms: 0, activeParticipants: 0 },
      },
    },
  ]);
  const outcome = await run('billing_status', {});
  assert.equal(outcome.isError, undefined);
  assert.deepEqual(calls[0], { url: 'http://billing.test/v1/admin/billing/plan', method: 'GET' });
  const value = JSON.parse(outcome.text) as Record<string, any>;
  assert.equal(value.plan, 'free');
  assert.equal(value.enforcementEnabled, false);
  assert.equal(value.overagePolicy, 'warn');
  assert.equal(value.plans.free.maxRooms, 5);
});

test('billing: 403 produces an actionable tool error, no key leak', async () => {
  mockResponses([{ status: 403, body: { error: { code: 'forbidden', message: 'nope' } } }]);
  const spec = billingToolSpecs().find((candidate) => candidate.name === 'billing_status')!;
  await assert.rejects(
    () => spec.handler({}, makeContext()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /нет прав/);
      assert.ok(!error.message.includes('admin-key'));
      return true;
    },
  );
});

test('billing: 400 month error produces a format hint', async () => {
  mockResponses([{ status: 400, body: { error: { code: 'validation_failed', message: 'month must be YYYY-MM' } } }]);
  const spec = billingToolSpecs().find((candidate) => candidate.name === 'billing_usage')!;
  await assert.rejects(
    () => spec.handler({ month: '2026-11' }, makeContext()),
    (error: unknown) => error instanceof Error && /YYYY-MM/.test(error.message),
  );
});
