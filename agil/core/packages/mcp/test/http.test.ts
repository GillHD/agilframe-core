/**
 * HTTP transport tests (docs/api-exposure.md): spawn `dist/http.js`, then talk
 * to `POST /mcp` with fetch — auth, IP allowlist, body limit, stateless
 * initialize/tools, and the read-only exposure mode.
 *
 * The server prints its real ephemeral port to stderr, so tests never race on a
 * fixed port.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HTTP_ENTRY = fileURLToPath(new URL('../dist/http.js', import.meta.url));
const STDIO_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));

interface RunningServer {
  port: number;
  stop: () => Promise<void>;
}

async function startHttpServer(env: Record<string, string>, entry = HTTP_ENTRY): Promise<RunningServer> {
  if (!existsSync(entry)) {
    throw new Error(`Built entry not found at ${entry}. Run: npm run build -w @agil/mcp`);
  }
  const proc: ChildProcess = spawn(process.execPath, [entry], {
    env: { ...process.env, AGIL_MCP_HTTP_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  return await new Promise<RunningServer>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`HTTP MCP server did not start in time. stderr:\n${stderr}`));
    }, 10_000);
    const onData = (chunk: Buffer | string): void => {
      stderr += String(chunk);
      const match = /listening on http:\/\/([^:]+):(\d+)\/mcp/.exec(stderr);
      if (!match?.[2]) return;
      clearTimeout(timer);
      proc.stderr?.off('data', onData);
      resolve({
        port: Number(match[2]),
        stop: () =>
          new Promise<void>((done) => {
            const killTimer = setTimeout(done, 2000);
            proc.once('exit', () => {
              clearTimeout(killTimer);
              done();
            });
            proc.kill();
          }),
      });
    };
    proc.stderr?.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`HTTP MCP server exited with ${String(code)}. stderr:\n${stderr}`));
    });
  });
}

interface RpcOptions {
  token?: string | null;
  path?: string;
  method?: string;
  rawBody?: string;
  headers?: Record<string, string>;
}

interface RpcResult {
  status: number;
  json: Record<string, unknown> | null;
  text: string;
  headers: Headers;
}

async function rpc(port: number, body: unknown, options: RpcOptions = {}): Promise<RpcResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...options.headers,
  };
  const method = options.method ?? 'POST';
  const response = await fetch(`http://127.0.0.1:${port}${options.path ?? '/mcp'}`, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: options.rawBody ?? JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: response.status, json, text, headers: response.headers };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'agil-mcp-http-tests', version: '0.0.0' },
  },
};

const READ_ONLY_EXPECTED = 'AGIL_MCP_MODE=read';

const TOKEN = 'test-token-5f0c2a';

let fullServer: RunningServer;

before(async () => {
  fullServer = await startHttpServer({
    AGIL_MCP_HTTP_TOKEN: TOKEN,
    AGIL_MCP_HTTP_ALLOW_IPS: '127.0.0.1',
    AGIL_MCP_MODE: 'full',
  });
});

after(async () => {
  await fullServer?.stop();
});

test('HTTP initialize: 200 with serverInfo and no-store', async () => {
  const result = await rpc(fullServer.port, INITIALIZE, { token: TOKEN });
  assert.equal(result.status, 200);
  const response = result.json?.result as { serverInfo?: { name?: string } } | undefined;
  assert.equal(response?.serverInfo?.name, 'agil-calls-mcp');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('mcp-session-id'), null);
});

test('HTTP tools/list: 200 with the full tool set (stateless, no session needed)', async () => {
  const result = await rpc(fullServer.port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, {
    token: TOKEN,
  });
  assert.equal(result.status, 200);
  const tools = (result.json?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? [];
  assert.equal(tools.length, 84);
  assert.ok(tools.some((tool) => tool.name === 'agil_validate_config'));
  assert.ok(tools.some((tool) => tool.name === 'agil_update_config'));
});

test('HTTP tools/call: offline tools work over HTTP', async () => {
  const result = await rpc(
    fullServer.port,
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'agil_validate_config', arguments: { config: { theme: { colors: { primary: '#0b5fff' } } } } },
    },
    { token: TOKEN },
  );
  assert.equal(result.status, 200);
  const content = (result.json?.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text;
  const parsed = JSON.parse(content ?? '{}') as { valid?: boolean };
  assert.equal(parsed.valid, true);
});

test('HTTP auth: missing/invalid bearer → 401 without leaking the token', async () => {
  const missing = await rpc(fullServer.port, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get('www-authenticate'), 'Bearer');
  assert.ok(!missing.text.includes(TOKEN));

  const wrong = await rpc(
    fullServer.port,
    { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} },
    { token: 'wrong-token' },
  );
  assert.equal(wrong.status, 401);
  assert.ok(!wrong.text.includes(TOKEN));
});

test('HTTP routing: wrong path → 404, GET → 405, wrong content-type → 415', async () => {
  const notFound = await rpc(fullServer.port, {}, { token: TOKEN, path: '/nope' });
  assert.equal(notFound.status, 404);
  const method = await rpc(fullServer.port, {}, { token: TOKEN, method: 'GET' });
  assert.equal(method.status, 405);
  const contentType = await rpc(fullServer.port, {}, { token: TOKEN, headers: { 'content-type': 'text/plain' } });
  assert.equal(contentType.status, 415);
});

test('HTTP body limit: oversized body → 413', async () => {
  const huge = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: { pad: 'x'.repeat(1024 * 1024 + 128) } });
  const result = await rpc(fullServer.port, null, { token: TOKEN, rawBody: huge });
  assert.equal(result.status, 413);
});

test('HTTP IP allowlist: a different allowlist rejects the request with 403', async () => {
  const restricted = await startHttpServer({
    AGIL_MCP_HTTP_TOKEN: TOKEN,
    AGIL_MCP_HTTP_ALLOW_IPS: '10.9.9.9',
    AGIL_MCP_MODE: 'full',
  });
  try {
    const result = await rpc(restricted.port, INITIALIZE, { token: TOKEN });
    assert.equal(result.status, 403);
  } finally {
    await restricted.stop();
  }
});

test('HTTP mode can be enabled from the stdio entry via AGIL_MCP_HTTP_ENABLED=1', async () => {
  const indexServer = await startHttpServer(
    {
      AGIL_MCP_HTTP_ENABLED: '1',
      AGIL_MCP_HTTP_TOKEN: TOKEN,
      AGIL_MCP_HTTP_ALLOW_IPS: '127.0.0.1',
    },
    STDIO_ENTRY,
  );
  try {
    const result = await rpc(indexServer.port, INITIALIZE, { token: TOKEN });
    assert.equal(result.status, 200);
    const response = result.json?.result as { serverInfo?: { name?: string } } | undefined;
    assert.equal(response?.serverInfo?.name, 'agil-calls-mcp');
  } finally {
    await indexServer.stop();
  }
});

test('HTTP read mode: write tools are not registered and cannot be called', async () => {
  const readServer = await startHttpServer({
    AGIL_MCP_HTTP_TOKEN: TOKEN,
    AGIL_MCP_HTTP_ALLOW_IPS: '127.0.0.1',
    AGIL_MCP_MODE: 'read',
  });
  try {
    const listed = await rpc(readServer.port, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, {
      token: TOKEN,
    });
    assert.equal(listed.status, 200);
    const tools = (listed.json?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? [];
    const names = tools.map((tool) => tool.name);
    const writeTools = [
      'agil_update_config',
      'agil_create_room',
      'agil_create_invite',
      'agil_create_token',
      'agil_post_room_chat',
      'agil_set_chat_mode',
      'agil_set_ai_agent',
      'agil_set_access_policy',
      'agil_set_knowledge_agent',
      'agil_set_webhooks',
      'agil_set_providers',
      'agil_test_webhook',
      'agil_test_provider',
      'agil_run_analysis',
      'agil_set_in_call_agent',
      'agil_set_scale',
      'agil_create_role',
      'agil_update_role',
      'agil_delete_role',
      'agil_create_poll',
      'agil_vote_poll',
      'agil_close_poll',
      'scim_create_user',
      'scim_update_user',
      'scim_delete_user',
      'scim_create_group',
      'scim_update_group',
      'scim_delete_group',
      'egress_start_recording',
      'egress_start_rtmp',
      'egress_start_hls',
      'egress_stop',
    ];
    for (const writeTool of writeTools) {
      assert.ok(!names.includes(writeTool), `${writeTool} must not be registered in read mode`);
    }
    assert.ok(names.includes('agil_validate_config'));
    assert.ok(names.includes('agil_get_config'));
    assert.ok(names.includes('agil_ask_knowledge_agent')); // POST query, non-mutating
    assert.ok(names.includes('agil_get_assistant_tools'));
    assert.ok(names.includes('agil_explain_scaling'));
    assert.ok(names.includes('agil_explain_roles'));
    assert.ok(names.includes('agil_assess_change'));
    assert.ok(names.includes('agil_dashboard_assistant'));
    assert.equal(names.length, 84 - writeTools.length);

    const writeCall = await rpc(
      readServer.port,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'agil_update_config', arguments: { patch: {} } },
      },
      { token: TOKEN },
    );
    assert.equal(writeCall.status, 200);
    const result = writeCall.json?.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
    assert.equal(result?.isError, true);
    assert.ok((result?.content?.[0]?.text ?? '').includes(READ_ONLY_EXPECTED));
  } finally {
    await readServer.stop();
  }
});
