import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { InCallAssistantRequest } from '@agil/protocol';
import { InCallAssistantClient } from '../src/index.js';

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
    url: `http://127.0.0.1:${address.port}/assistant`,
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

function makeRequest(requestId = 'ic-1'): InCallAssistantRequest {
  return {
    requestId,
    tenantId: 'tenant-1',
    roomId: 'room-1',
    participant: { id: 'p1', name: 'Анна', role: 'host', permissions: ['chat', 'recording'] },
    text: 'Включи запись',
    locale: 'ru',
    tools: ['start_recording', 'open_chat'],
    state: { participants: 2, recording: false },
    systemPrompt: 'Ты — ассистент звонка.',
  };
}

function validResponse(requestId: string): Record<string, unknown> {
  return {
    requestId,
    text: 'Начинаю запись звонка.',
    actions: [{ tool: 'start_recording' }],
    spotlight: [{ target: 'recording', text: 'Кнопка записи внизу', step: 0 }],
    provider: 'corp-llm',
    model: 'corp-llm-v2',
  };
}

test('200 valid response: ok:true with text, actions, spotlight and headers', async () => {
  const server = await startServer((_captured, response) => respondJson(response, 200, validResponse('ic-1')));
  try {
    const client = new InCallAssistantClient({ endpoint: server.url });
    const result = await client.ask(makeRequest('ic-1'));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.provider, 'corp-llm');
    assert.match(result.response.text, /запись/);
    assert.equal(result.response.actions.length, 1);
    assert.equal(result.response.actions[0]!.tool, 'start_recording');
    assert.equal(result.response.spotlight.length, 1);
    assert.equal(result.response.spotlight[0]!.target, 'recording');

    assert.equal(server.captured.length, 1);
    const captured = server.captured[0]!;
    assert.equal(captured.method, 'POST');
    assert.equal(captured.headers['content-type'], 'application/json');
    assert.equal(captured.headers['x-agil-request-id'], 'ic-1');
    assert.equal(captured.headers['x-agil-tenant'], 'tenant-1');
    assert.equal(captured.headers.authorization, undefined);
    assert.equal(captured.headers['x-agil-signature'], undefined);
    assert.equal((JSON.parse(captured.body) as { text?: string }).text, 'Включи запись');
  } finally {
    await server.close();
  }
});

test('provider falls back to "external" when the assistant omits it', async () => {
  const response = validResponse('ic-1');
  delete response.provider;
  const server = await startServer((_captured, res) => respondJson(res, 200, response));
  try {
    const result = await new InCallAssistantClient({ endpoint: server.url }).ask(makeRequest());
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.provider, 'external');
  } finally {
    await server.close();
  }
});

test('signs the raw body with HMAC-SHA256 and sends Bearer auth', async () => {
  const secret = 'assistant-secret';
  const apiKey = 'assistant-key';
  let observedSignature: string | undefined;
  let observedAuthorization: string | undefined;
  const server = await startServer((captured, response) => {
    observedSignature = captured.headers['x-agil-signature'] as string | undefined;
    observedAuthorization = captured.headers.authorization;
    respondJson(response, 200, validResponse('ic-hmac'));
  });
  try {
    const client = new InCallAssistantClient({ endpoint: server.url, apiKey, hmacSecret: secret });
    const result = await client.ask(makeRequest('ic-hmac'));
    assert.equal(result.ok, true);

    const expected = createHmac('sha256', secret).update(server.captured[0]!.body, 'utf8').digest('hex');
    assert.equal(observedSignature, expected);
    assert.equal(observedAuthorization, `Bearer ${apiKey}`);
  } finally {
    await server.close();
  }
});

test('200 garbage → ok:false, retryable:false, no retry', async () => {
  const server = await startServer((_captured, res) => respondJson(res, 200, { requestId: 1, text: 42 }));
  try {
    const result = await new InCallAssistantClient({ endpoint: server.url }).ask(makeRequest());
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
  const server = await startServer((_captured, res) => respondJson(res, 500, { error: 'llm down' }));
  try {
    const result = await new InCallAssistantClient({ endpoint: server.url }).ask(makeRequest());
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
    const result = await new InCallAssistantClient({ endpoint: server.url }).ask(makeRequest());
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
    setTimeout(() => respondJson(res, 200, validResponse('ic-1')), 500);
  });
  try {
    const client = new InCallAssistantClient({ endpoint: server.url, timeoutMs: 120, maxRetries: 0 });
    const result = await client.ask(makeRequest());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.retryable, true);
    assert.match(result.error, /timed out/);
  } finally {
    await server.close();
  }
});

test('isConfigured() and invalid request handling', async () => {
  const unconfigured = new InCallAssistantClient({ endpoint: '   ' });
  assert.equal(unconfigured.isConfigured(), false);
  const notConfigured = await unconfigured.ask(makeRequest());
  assert.equal(notConfigured.ok, false);
  if (!notConfigured.ok) assert.match(notConfigured.error, /not configured/);

  const configured = new InCallAssistantClient({ endpoint: ' http://127.0.0.1:1/assistant ' });
  assert.equal(configured.isConfigured(), true);
  const invalid = await configured.ask(makeRequest({ text: '' }));
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.retryable, false);
    assert.match(invalid.error, /invalid InCallAssistantRequest/);
  }
});

test('API keys are redacted from error messages', async () => {
  const apiKey = 'sk-live-super-secret';
  const server = await startServer((_captured, res) =>
    respondJson(res, 500, { error: { message: `invalid api key ${apiKey}` } }),
  );
  try {
    const result = await new InCallAssistantClient({
      endpoint: server.url,
      apiKey,
      maxRetries: 0,
    }).ask(makeRequest());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(!result.error.includes(apiKey), `key leaked: ${result.error}`);
    assert.match(result.error, /\[redacted\]/);
    assert.equal(server.captured.length, 1);
  } finally {
    await server.close();
  }
});
