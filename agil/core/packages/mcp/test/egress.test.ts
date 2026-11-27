/**
 * Egress / RTMP / HLS tools: mocked fetch — no live server.
 * Verifies endpoints/bodies, read/write flags, URL redaction and Russian errors.
 */
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { McpEnv } from '../src/env.js';
import { AgilHttpClient } from '../src/http-client.js';
import { egressToolSpecs } from '../src/tools/egress.js';
import type { ToolContext } from '../src/tool-kit.js';

const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];

beforeEach(() => {
  calls.length = 0;
});

function makeContext(): ToolContext {
  const env: McpEnv = {
    serverUrl: 'http://egress.test',
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
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    if (response.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

async function call(name: string, args: Record<string, unknown>): Promise<{ value: Record<string, unknown>; text: string }> {
  const spec = egressToolSpecs().find((candidate) => candidate.name === name);
  assert.ok(spec, `${name} must exist`);
  const outcome = await spec.handler(args, makeContext());
  assert.equal(outcome.isError, undefined);
  return { value: JSON.parse(outcome.text) as Record<string, unknown>, text: outcome.text };
}

test('egress: status/list are read-only; start/stop are write', () => {
  const specs = egressToolSpecs();
  assert.equal(specs.length, 6);
  for (const name of ['egress_status', 'egress_list']) {
    assert.equal(specs.find((spec) => spec.name === name)?.write, false, `${name} must be read-only`);
  }
  for (const name of ['egress_start_recording', 'egress_start_rtmp', 'egress_start_hls', 'egress_stop']) {
    assert.equal(specs.find((spec) => spec.name === name)?.write, true, `${name} must be write`);
  }
});

test('egress_status: GET /v1/admin/egress/status', async () => {
  mockResponses([{ status: 200, body: { configured: true, workerConfigured: true, detail: 'ok https://worker.internal/x' } }]);
  const { value } = await call('egress_status', {});
  assert.equal(value.configured, true);
  assert.match(String(value.detail), /\[redacted-url\]/);
  assert.equal(calls[0]?.url, 'http://egress.test/v1/admin/egress/status');
  assert.equal(calls[0]?.method, 'GET');
});

test('egress_list: /egress/list, sessions are URL/key redacted', async () => {
  mockResponses([
    {
      status: 200,
      body: {
        configured: true,
        sessions: [
          {
            id: 'e1',
            kind: 'rtmp',
            status: 'active',
            url: 'rtmps://live.example/secret-stream-key',
            rtmpUrl: 'rtmps://live.example/secret-stream-key',
            streamKey: 'super-secret',
            startedAt: 1,
          },
        ],
      },
    },
  ]);
  const { text, value } = await call('egress_list', { roomId: 'room 1' });
  assert.equal(calls[0]?.url, 'http://egress.test/v1/rooms/room%201/egress/list');
  assert.equal(value.sessions instanceof Array, true);
  assert.equal(text.includes('secret-stream-key'), false);
  assert.equal(text.includes('super-secret'), false);
  assert.match(text, /\[redacted\]/);
});

test('egress_list: falls back to /egress on 404', async () => {
  mockResponses([
    { status: 404, body: { error: { code: 'not_found', message: 'nope' } } },
    { status: 200, body: { active: [{ id: 'e2', kind: 'recording', status: 'active' }] } },
  ]);
  const { value } = await call('egress_list', { roomId: 'room-1' });
  assert.equal(calls[0]?.url, 'http://egress.test/v1/rooms/room-1/egress/list');
  assert.equal(calls[1]?.url, 'http://egress.test/v1/rooms/room-1/egress');
  assert.deepEqual(value.sessions, [{ id: 'e2', kind: 'recording', status: 'active' }]);
});

test('start recording/RTMP/HLS bodies and redacted echo; invalid RTMP rejected by schema', async () => {
  mockResponses([{ status: 200, body: { session: { id: 'e3', kind: 'recording' } } }]);
  const recording = await call('egress_start_recording', { roomId: 'room-1' });
  assert.equal(recording.value.started, true);
  assert.equal(calls[0]?.url, 'http://egress.test/v1/rooms/room-1/egress/start');
  assert.equal(calls[0]?.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0]!.body!), { kind: 'recording' });

  mockResponses([{ status: 200, body: { session: { id: 'e4', kind: 'rtmp', rtmpUrl: 'rtmps://live.example/key' } } }]);
  const rtmp = await call('egress_start_rtmp', { roomId: 'room-1', rtmpUrl: 'rtmps://live.example/key' });
  assert.deepEqual(JSON.parse(calls[1]!.body!), { kind: 'rtmp', rtmpUrl: 'rtmps://live.example/key' });
  assert.equal(rtmp.text.includes('live.example'), false);
  assert.equal(rtmp.text.includes('rtmpUrl'), true);
  assert.match(rtmp.text, /\[redacted\]/);

  mockResponses([{ status: 200, body: { session: { id: 'e5', kind: 'hls' } } }]);
  await call('egress_start_hls', { roomId: 'room-1' });
  assert.deepEqual(JSON.parse(calls[2]!.body!), { kind: 'hls' });

  const spec = egressToolSpecs().find((candidate) => candidate.name === 'egress_start_rtmp')!;
  assert.equal(spec.inputSchema.safeParse({ roomId: 'room-1', rtmpUrl: 'https://not-rtmp.example' }).success, false);
  assert.equal(spec.inputSchema.safeParse({ roomId: 'room-1', rtmpUrl: 'rtmp://live.example/key' }).success, true);
});

test('egress_stop: one session/all; 501 is a Russian actionable error', async () => {
  mockResponses([{ status: 200, body: { stopped: true } }]);
  const one = await call('egress_stop', { roomId: 'room-1', sessionId: 'e1' });
  assert.equal(one.value.stopped, true);
  assert.deepEqual(JSON.parse(calls[0]!.body!), { sessionId: 'e1' });
  assert.equal(one.value.sessionId, 'e1');

  mockResponses([{ status: 200, body: { stopped: true } }]);
  const all = await call('egress_stop', { roomId: 'room-1' });
  assert.deepEqual(JSON.parse(calls[1]!.body!), {});
  assert.equal(all.value.all, true);

  mockResponses([{ status: 501, body: { error: { code: 'egress_not_configured', message: 'worker missing' } } }]);
  const spec = egressToolSpecs().find((candidate) => candidate.name === 'egress_stop')!;
  await assert.rejects(
    () => spec.handler({ roomId: 'room-1' }, makeContext()),
    (error: unknown) => error instanceof Error && /egress-воркер не настроен/.test(error.message),
  );
});

// Restore the real fetch after all tests.
after(() => {
  globalThis.fetch = originalFetch;
});
