import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { LlmError, UniversalLlmClient } from '../src/index.js';
import type { LlmErrorCode } from '../src/index.js';

interface CapturedRequest {
  path: string;
  method: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

interface TestServer {
  baseUrl: string;
  captured: CapturedRequest[];
  close: () => Promise<void>;
}

async function startServer(handler: (request: CapturedRequest, response: ServerResponse) => void): Promise<TestServer> {
  const captured: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      const entry: CapturedRequest = {
        path,
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
    baseUrl: `http://127.0.0.1:${address.port}`,
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

function jsonBody(captured: CapturedRequest): Record<string, unknown> {
  return JSON.parse(captured.body) as Record<string, unknown>;
}

async function captureError(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof LlmError, `expected LlmError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected chat() to reject');
}

function assertLlmError(
  error: LlmError,
  code: LlmErrorCode,
  options: { retryable?: boolean; status?: number; message?: RegExp } = {},
): void {
  assert.equal(error.code, code);
  if (options.retryable !== undefined) assert.equal(error.retryable, options.retryable);
  if (options.status !== undefined) assert.equal(error.status, options.status);
  if (options.message) assert.match(error.message, options.message);
}

test('openai-compatible: valid response, request shape, usage mapping', async () => {
  const server = await startServer((_captured, res) =>
    respondJson(res, 200, {
      choices: [{ message: { role: 'assistant', content: 'Привет из OpenAI' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
  );
  try {
    const client = new UniversalLlmClient({
      provider: 'openai-compatible',
      endpoint: server.baseUrl,
      apiKey: 'sk-test-key',
      model: 'gpt-test',
    });
    const result = await client.chat({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      jsonMode: true,
      maxTokens: 256,
      temperature: 0.2,
    });

    assert.equal(result.text, 'Привет из OpenAI');
    assert.deepEqual(result.usage, { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    assert.ok(result.raw !== undefined);

    assert.equal(server.captured.length, 1);
    const captured = server.captured[0]!;
    assert.equal(captured.path, '/v1/chat/completions');
    assert.equal(captured.headers.authorization, 'Bearer sk-test-key');
    const body = jsonBody(captured);
    assert.equal(body.model, 'gpt-test');
    assert.equal(body.max_tokens, 256);
    assert.equal(body.temperature, 0.2);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal((body.messages as unknown[]).length, 2);
  } finally {
    await server.close();
  }
});

test('anthropic: valid response, system extraction, usage mapping', async () => {
  const server = await startServer((_captured, res) =>
    respondJson(res, 200, {
      content: [
        { type: 'text', text: 'Привет ' },
        { type: 'text', text: 'из Anthropic' },
      ],
      usage: { input_tokens: 4, output_tokens: 3 },
    }),
  );
  try {
    const client = new UniversalLlmClient({
      provider: 'anthropic',
      endpoint: server.baseUrl,
      apiKey: 'ak-test-key',
      model: 'claude-test',
    });
    const result = await client.chat({
      messages: [
        { role: 'system', content: 'sys prompt' },
        { role: 'user', content: 'hi' },
      ],
      jsonMode: true,
    });

    assert.equal(result.text, 'Привет из Anthropic');
    assert.deepEqual(result.usage, { promptTokens: 4, completionTokens: 3, totalTokens: 7 });

    const captured = server.captured[0]!;
    assert.equal(captured.path, '/v1/messages');
    assert.equal(captured.headers['x-api-key'], 'ak-test-key');
    assert.equal(captured.headers['anthropic-version'], '2023-06-01');
    assert.equal(captured.headers.authorization, undefined);
    const body = jsonBody(captured);
    assert.equal(body.model, 'claude-test');
    assert.equal(body.max_tokens, 1024);
    assert.match(String(body.system), /sys prompt/);
    assert.match(String(body.system), /JSON/);
    const messages = body.messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.role, 'user');
  } finally {
    await server.close();
  }
});

test('ollama: valid response, native options, usage mapping', async () => {
  const server = await startServer((_captured, res) =>
    respondJson(res, 200, {
      message: { role: 'assistant', content: 'Привет из Ollama' },
      prompt_eval_count: 5,
      eval_count: 3,
    }),
  );
  try {
    const client = new UniversalLlmClient({
      provider: 'ollama',
      endpoint: server.baseUrl,
      model: 'qwen-test',
    });
    const result = await client.chat({
      messages: [{ role: 'user', content: 'hi' }],
      jsonMode: true,
      maxTokens: 128,
      temperature: 0,
    });

    assert.equal(result.text, 'Привет из Ollama');
    assert.deepEqual(result.usage, { promptTokens: 5, completionTokens: 3, totalTokens: 8 });

    const captured = server.captured[0]!;
    assert.equal(captured.path, '/api/chat');
    assert.equal(captured.headers.authorization, undefined);
    const body = jsonBody(captured);
    assert.equal(body.model, 'qwen-test');
    assert.equal(body.stream, false);
    assert.equal(body.format, 'json');
    const options = body.options as Record<string, unknown>;
    assert.equal(options.num_predict, 128);
    assert.equal(options.temperature, 0);
  } finally {
    await server.close();
  }
});

test('reads provider/url/key/model from AGIL_LLM_* environment variables', async () => {
  const saved: Record<string, string | undefined> = {
    AGIL_LLM_PROVIDER: process.env.AGIL_LLM_PROVIDER,
    AGIL_LLM_URL: process.env.AGIL_LLM_URL,
    AGIL_LLM_KEY: process.env.AGIL_LLM_KEY,
    AGIL_LLM_MODEL: process.env.AGIL_LLM_MODEL,
  };
  const server = await startServer((_captured, res) =>
    respondJson(res, 200, { message: { content: 'env answer' } }),
  );
  try {
    process.env.AGIL_LLM_PROVIDER = 'ollama';
    process.env.AGIL_LLM_URL = server.baseUrl;
    process.env.AGIL_LLM_KEY = 'env-key';
    process.env.AGIL_LLM_MODEL = 'env-model';

    const client = new UniversalLlmClient();
    assert.equal(client.provider, 'ollama');
    assert.equal(client.model, 'env-model');
    assert.equal(client.baseUrl, server.baseUrl);

    const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.text, 'env answer');
    const captured = server.captured[0]!;
    assert.equal(captured.path, '/api/chat');
    assert.equal(captured.headers.authorization, 'Bearer env-key');
    assert.equal(jsonBody(captured).model, 'env-model');
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await server.close();
  }
});

test('HTTP 400 is reported as non-retryable and not retried', async () => {
  const server = await startServer((_captured, res) =>
    respondJson(res, 400, { error: { message: 'bad request from provider' } }),
  );
  try {
    const client = new UniversalLlmClient({ provider: 'openai-compatible', endpoint: server.baseUrl, model: 'm' });
    const error = await captureError(client.chat({ messages: [{ role: 'user', content: 'hi' }] }));
    assertLlmError(error, 'http', { retryable: false, status: 400, message: /HTTP 400/ });
    assert.match(error.message, /bad request from provider/);
    assert.equal(server.captured.length, 1);
  } finally {
    await server.close();
  }
});

test('HTTP 500 is retried exactly once by default', async () => {
  const server = await startServer((_captured, res) => respondJson(res, 500, { error: 'overloaded' }));
  try {
    const client = new UniversalLlmClient({ provider: 'openai-compatible', endpoint: server.baseUrl, model: 'm' });
    const error = await captureError(client.chat({ messages: [{ role: 'user', content: 'hi' }] }));
    assertLlmError(error, 'http', { retryable: true, status: 500, message: /HTTP 500/ });
    assert.equal(server.captured.length, 2);
  } finally {
    await server.close();
  }
});

test('timeout aborts the request and is retryable', async () => {
  const server = await startServer((_captured, res) => {
    setTimeout(() => respondJson(res, 200, { choices: [] }), 500);
  });
  try {
    const client = new UniversalLlmClient({
      provider: 'openai-compatible',
      endpoint: server.baseUrl,
      model: 'm',
      timeoutMs: 120,
      maxRetries: 0,
    });
    const error = await captureError(client.chat({ messages: [{ role: 'user', content: 'hi' }] }));
    assertLlmError(error, 'timeout', { retryable: true, message: /timed out/ });
  } finally {
    await server.close();
  }
});

test('invalid JSON and unexpected response shapes are non-retryable', async () => {
  const server = await startServer((_captured, res) => respondJson(res, 200, 'not-json-at-all'));
  try {
    const client = new UniversalLlmClient({ provider: 'openai-compatible', endpoint: server.baseUrl, model: 'm' });
    const error = await captureError(client.chat({ messages: [{ role: 'user', content: 'hi' }] }));
    assertLlmError(error, 'invalid_response', { retryable: false, message: /invalid JSON/ });
    assert.equal(server.captured.length, 1);
  } finally {
    await server.close();
  }

  const secondServer = await startServer((_captured, res) => respondJson(res, 200, { result: 'nope' }));
  try {
    const client = new UniversalLlmClient({ provider: 'openai-compatible', endpoint: secondServer.baseUrl, model: 'm' });
    const error = await captureError(client.chat({ messages: [{ role: 'user', content: 'hi' }] }));
    assertLlmError(error, 'invalid_response', { message: /choices/ });
    assert.equal(secondServer.captured.length, 1);
  } finally {
    await secondServer.close();
  }
});

test('empty assistant text is reported as empty_response', async () => {
  const server = await startServer((_captured, res) =>
    respondJson(res, 200, { choices: [{ message: { content: '' } }] }),
  );
  try {
    const client = new UniversalLlmClient({ provider: 'openai-compatible', endpoint: server.baseUrl, model: 'm' });
    const error = await captureError(client.chat({ messages: [{ role: 'user', content: 'hi' }] }));
    assertLlmError(error, 'empty_response', { retryable: false });
  } finally {
    await server.close();
  }
});

test('invalid chat requests fail before any network call', async () => {
  const client = new UniversalLlmClient({ provider: 'openai-compatible', endpoint: 'http://127.0.0.1:1', model: 'm' });

  const empty = await captureError(client.chat({ messages: [] }));
  assertLlmError(empty, 'invalid_request', { retryable: false, message: /non-empty/ });

  const badRole = await captureError(
    client.chat({ messages: [{ role: 'tool' as never, content: 'x' }] }),
  );
  assertLlmError(badRole, 'invalid_request', { retryable: false, message: /role/ });

  const anthropic = new UniversalLlmClient({ provider: 'anthropic', endpoint: 'http://127.0.0.1:1', model: 'm' });
  const systemOnly = await captureError(anthropic.chat({ messages: [{ role: 'system', content: 'only system' }] }));
  assertLlmError(systemOnly, 'invalid_request', { retryable: false, message: /user\/assistant/ });
});

test('API keys are redacted from error messages', async () => {
  const apiKey = 'sk-super-secret-key';
  const server = await startServer((_captured, res) =>
    respondJson(res, 500, { error: { message: `invalid api key ${apiKey}` } }),
  );
  try {
    const client = new UniversalLlmClient({
      provider: 'openai-compatible',
      endpoint: server.baseUrl,
      apiKey,
      model: 'm',
      maxRetries: 0,
    });
    const error = await captureError(client.chat({ messages: [{ role: 'user', content: 'hi' }] }));
    assertLlmError(error, 'http', { retryable: true });
    assert.ok(!error.message.includes(apiKey), `key leaked: ${error.message}`);
    assert.match(error.message, /\[redacted\]/);
    assert.equal(server.captured.length, 1);
  } finally {
    await server.close();
  }
});
