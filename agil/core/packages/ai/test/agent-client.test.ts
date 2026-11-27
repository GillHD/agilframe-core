import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { AiAgentRequest } from '@agil/protocol';
import { AiAgentClient, buildAiAgentRequest } from '../src/index.js';

interface CapturedRequest {
  method: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

interface TestServer {
  url: string;
  captured: CapturedRequest[];
  close: () => Promise<void>;
}

async function startServer(handler: (request: CapturedRequest, response: ServerResponse) => void): Promise<TestServer> {
  const captured: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const entry: CapturedRequest = {
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      captured.push(entry);
      handler(entry, res);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/analyze`,
    captured,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(payload);
}

function makeRequest(requestId = 'req-1'): AiAgentRequest {
  return buildAiAgentRequest({
    tenantId: 'tenant-1',
    roomId: 'room-1',
    roomName: 'Sync',
    locale: 'ru',
    participants: [{ id: 'p1', name: 'Анна', role: 'host' }],
    segments: [
      { id: 's1', participantId: 'p1', participantName: 'Анна', text: 'Обсудили интеграцию.', start: 0, end: 3, isFinal: true, ts: 1 },
    ],
    policy: [],
    requestId,
  });
}

function validResponse(requestId: string): Record<string, unknown> {
  return {
    requestId,
    summary: 'Обсудили интеграцию.',
    findings: [
      {
        ruleId: 'ai.custom',
        ruleName: 'AI review',
        severity: 'warn',
        action: 'flag',
        excerpt: 'Обсудили интеграцию.',
      },
    ],
    provider: 'corp-ai',
  };
}

test('200 valid response: ok:true, provider, request headers', async () => {
  const server = await startServer((_captured, response) => respondJson(response, 200, validResponse('req-1')));
  try {
    const client = new AiAgentClient({ endpoint: server.url });
    const result = await client.analyze(makeRequest('req-1'));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.provider, 'corp-ai');
    assert.equal(result.response.summary, 'Обсудили интеграцию.');
    assert.equal(result.response.findings.length, 1);

    assert.equal(server.captured.length, 1);
    const captured = server.captured[0]!;
    assert.equal(captured.method, 'POST');
    assert.equal(captured.headers['content-type'], 'application/json');
    assert.equal(captured.headers['x-agil-request-id'], 'req-1');
    assert.equal(captured.headers['x-agil-tenant'], 'tenant-1');
    assert.equal(captured.headers.authorization, undefined);
    assert.equal(captured.headers['x-agil-signature'], undefined);
    const body = JSON.parse(captured.body) as { requestId?: string };
    assert.equal(body.requestId, 'req-1');
  } finally {
    await server.close();
  }
});

test('provider falls back to "external" when the agent omits it', async () => {
  const response = validResponse('req-1');
  delete response.provider;
  const server = await startServer((_captured, res) => respondJson(res, 200, response));
  try {
    const result = await new AiAgentClient({ endpoint: server.url }).analyze(makeRequest());
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.provider, 'external');
  } finally {
    await server.close();
  }
});

test('signs the raw body with HMAC-SHA256 and sends Bearer auth', async () => {
  const secret = 'top-secret';
  const apiKey = 'corp-key';
  let observedSignature: string | undefined;
  let observedAuthorization: string | undefined;
  const server = await startServer((captured, response) => {
    observedSignature = captured.headers['x-agil-signature'] as string | undefined;
    observedAuthorization = captured.headers.authorization;
    respondJson(response, 200, validResponse('req-hmac'));
  });
  try {
    const client = new AiAgentClient({ endpoint: server.url, apiKey, hmacSecret: secret });
    const result = await client.analyze(makeRequest('req-hmac'));
    assert.equal(result.ok, true);

    const expected = createHmac('sha256', secret).update(server.captured[0]!.body, 'utf8').digest('hex');
    assert.equal(observedSignature, expected);
    assert.equal(observedAuthorization, `Bearer ${apiKey}`);
  } finally {
    await server.close();
  }
});

test('200 invalid JSON → ok:false, retryable:false, no retry', async () => {
  const server = await startServer((_captured, res) => respondJson(res, 200, 'not json at all'));
  try {
    const result = await new AiAgentClient({ endpoint: server.url }).analyze(makeRequest());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.retryable, false);
    assert.match(result.error, /invalid JSON/);
    assert.equal(server.captured.length, 1);
  } finally {
    await server.close();
  }
});

test('200 JSON that fails schema validation → ok:false, retryable:false', async () => {
  const server = await startServer((_captured, res) => respondJson(res, 200, { requestId: 42, findings: 'nope' }));
  try {
    const result = await new AiAgentClient({ endpoint: server.url }).analyze(makeRequest());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.retryable, false);
    assert.match(result.error, /schema validation/);
    assert.equal(server.captured.length, 1);
  } finally {
    await server.close();
  }
});

test('HTTP 500 is retried exactly once by default', async () => {
  const server = await startServer((_captured, res) => respondJson(res, 500, { error: 'boom' }));
  try {
    const result = await new AiAgentClient({ endpoint: server.url }).analyze(makeRequest());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.retryable, true);
    assert.match(result.error, /HTTP 500/);
    assert.equal(server.captured.length, 2);
  } finally {
    await server.close();
  }
});

test('HTTP 400 is not retried', async () => {
  const server = await startServer((_captured, res) => respondJson(res, 400, { error: 'bad request' }));
  try {
    const result = await new AiAgentClient({ endpoint: server.url }).analyze(makeRequest());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.retryable, false);
    assert.match(result.error, /HTTP 400/);
    assert.equal(server.captured.length, 1);
  } finally {
    await server.close();
  }
});

test('timeout aborts the request and reports retryable failure', async () => {
  const server = await startServer((_captured, res) => {
    setTimeout(() => respondJson(res, 200, validResponse('req-1')), 500);
  });
  try {
    const client = new AiAgentClient({ endpoint: server.url, timeoutMs: 120, maxRetries: 0 });
    const result = await client.analyze(makeRequest());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.retryable, true);
    assert.match(result.error, /timed out/);
  } finally {
    await server.close();
  }
});

test('network error is retried and reported as retryable', async () => {
  const client = new AiAgentClient({ endpoint: 'http://127.0.0.1:1/analyze', maxRetries: 1 });
  const result = await client.analyze(makeRequest());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.retryable, true);
  assert.match(result.error, /network error/);
});

test('isConfigured() reflects a non-empty endpoint and unconfigured calls are rejected', async () => {
  const unconfigured = new AiAgentClient({ endpoint: '   ' });
  assert.equal(unconfigured.isConfigured(), false);
  const result = await unconfigured.analyze(makeRequest());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.retryable, false);
  assert.match(result.error, /not configured/);

  const configured = new AiAgentClient({ endpoint: ' https://ai.corp.example/analyze ' });
  assert.equal(configured.isConfigured(), true);
});

test('invalid request payload is rejected before any network call', async () => {
  const client = new AiAgentClient({ endpoint: 'http://127.0.0.1:1/analyze' });
  const invalid = { ...makeRequest(), requestId: '' } as AiAgentRequest;
  const result = await client.analyze(invalid);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.retryable, false);
  assert.match(result.error, /invalid AiAgentRequest/);
});
