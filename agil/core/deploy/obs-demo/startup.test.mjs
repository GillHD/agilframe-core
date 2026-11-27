import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

async function withBroker(testContext, exercise, useCaptcha = false) {
  let requests = 0;
  const directory = mkdtempSync(path.join(tmpdir(), 'agil-obs-chat-http-'));
  const media = createServer((request, response) => {
    if (request.method === 'POST' && request.url?.startsWith('/v3/config/paths/add/obs/')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    if (request.method === 'DELETE' && request.url?.startsWith('/v3/config/paths/delete/obs/')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    if (request.url !== '/v3/config/paths/list') {
      response.writeHead(404).end();
      return;
    }
    requests += 1;
    response.writeHead(requests === 1 ? 503 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ items: [] }));
  });
  media.listen(0, '127.0.0.1');
  await once(media, 'listening');
  const verifyFixture = `
    const networkFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      if (String(url) !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') return networkFetch(url, init);
      return Promise.resolve(Response.json({ success: init.body.get('response') === 'valid', hostname: '127.0.0.1', action: 'obs_chat' }));
    };`;
  const args = useCaptcha ? ['--import', 'data:text/javascript,' + encodeURIComponent(verifyFixture)] : [];
  const child = spawn(process.execPath, [...args, fileURLToPath(new URL('./server.mjs', import.meta.url))], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AGIL_OBS_SITE_ORIGIN: 'http://127.0.0.1:18765',
      AGIL_OBS_PUBLIC_URL: 'http://127.0.0.1:18898',
      AGIL_OBS_INGEST_URL: 'rtmp://127.0.0.1:11935/obs',
      AGIL_OBS_MTX_CONTROL_URL: `http://127.0.0.1:${media.address().port}`,
      AGIL_OBS_MTX_HLS_URL: 'http://127.0.0.1:18888',
      AGIL_OBS_MTX_WEBRTC_URL: 'http://127.0.0.1:18889',
      AGIL_OBS_MTX_PLAYBACK_URL: 'http://127.0.0.1:19996',
      AGIL_OBS_REPLAY_DIR: path.join(directory, 'replays'),
      AGIL_OBS_CHAT_FILE: path.join(directory, 'chat.sqlite'),
      AGIL_OBS_CHAT_TRUSTED_PROXIES: '',
      AGIL_OBS_TURNSTILE_SITE_KEY: useCaptcha ? 'test-site-key' : '',
      AGIL_OBS_TURNSTILE_SECRET_KEY: useCaptcha ? 'test-secret' : '',
      AGIL_OBS_ORGANIZER_KEY: 'qa-obs-organizer-placeholder',
      AGIL_OBS_CALLBACK_KEY: 'qa-obs-callback-placeholder',
      AGIL_OBS_EDGES: '[]',
      AGIL_OBS_HOST: '127.0.0.1',
      AGIL_OBS_PORT: '0',
    },
  });
  const finished = once(child, 'close');
  const stop = () => child.kill();
  testContext.signal.addEventListener('abort', stop, { once: true });
  // Capture a launch failure so it can be reported even before the assertion.
  finished.catch(() => undefined);
  let error = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { error += chunk; });
  try {
    const listening = (async () => {
      let output = '';
      for await (const chunk of child.stdout) {
        output += chunk;
        const port = /OBS demo broker listening on (\d+)[\r\n]/.exec(output)?.[1];
        if (port) return port;
      }
      return undefined;
    })();
    const port = await Promise.race([listening, finished.then(() => undefined)]);
    assert.ok(port, error);
    assert.equal(requests, 2);
    const base = `http://127.0.0.1:${port}/obs-demo`;
    await exercise(base);
  } finally {
    testContext.signal.removeEventListener('abort', stop);
    stop();
    await Promise.allSettled([finished, new Promise((resolve) => media.close(resolve))]);
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function viewerIdentity(chatUrl) {
  const response = await fetch(`${chatUrl}/identity`, { method: 'POST' });
  assert.equal(response.status, 201);
  return (await response.json()).credential;
}

test('broker waits for MediaMTX and serves protected chat routes', { timeout: 8000 }, (testContext) => withBroker(testContext, async (base) => {
    const created = await fetch(`${base}/sessions?public=1&replay=1`, {
      method: 'POST', headers: { Authorization: 'Bearer qa-obs-organizer-placeholder' },
    });
    assert.equal(created.status, 201);
    const { id, manageToken } = await created.json();
    const url = `${base}/sessions/${id}/chat`;
    const credential = await viewerIdentity(url);
    const empty = await fetch(url);
    assert.deepEqual(await empty.json(), { messages: [], before: null });
    assert.equal((await fetch(url, { headers: { 'If-None-Match': empty.headers.get('etag') } })).status, 304);
    const post = (text, fakeAddress, name = 'viewer') => fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-agil-client-ip': fakeAddress },
      body: JSON.stringify({ name, text, credential }),
    });
    const first = await post('hello', '203.0.113.1');
    assert.equal(first.status, 201);
    const saved = await first.json();
    const duplicate = await post('HELLO', '203.0.113.2');
    assert.equal(duplicate.status, 429);
    assert.equal((await duplicate.json()).error, 'duplicate_comment');
    assert.equal((await post('next', '203.0.113.3', 'latest viewer')).status, 201);
    const limited = await post('spam', '203.0.113.4');
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    for (let index = 0; index < 8; index += 1) await (await post('spam', '203.0.113.4')).json();
    const blocked = await post('spam', '203.0.113.5', 'ignored after block');
    assert.equal((await blocked.json()).error, 'source_blocked');
    assert.equal((await fetch(`${url}/blocked`)).status, 401);
    assert.equal((await fetch(`${url}/blocked`, { headers: { Authorization: 'Bearer qa-obs-organizer-placeholder' } })).status, 401);
    const otherSession = await fetch(`${base}/sessions?public=1`, {
      method: 'POST', headers: { Authorization: 'Bearer qa-obs-organizer-placeholder' },
    });
    assert.equal(otherSession.status, 201);
    const other = await otherSession.json();
    assert.equal((await fetch(`${url}/blocked`, { headers: { Authorization: `Bearer ${other.manageToken}` } })).status, 401);
    const response = await fetch(`${url}/blocked`, { headers: { Authorization: `Bearer ${manageToken}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { blocks, total } = await response.json();
    assert.equal(total, 1);
    assert.equal(blocks[0].address, '127.0.0.1');
    assert.equal(blocks[0].name, 'latest viewer');
    assert.equal(blocks[0].reason, 'comment_rate_limited');
    assert.equal(blocks[0].blockedUntil - blocks[0].blockedAt, 300_000);
    assert.ok(blocks[0].blockedUntil > Date.now());
    assert.deepEqual((await (await fetch(`${url}?before=2`)).json()).messages, [saved]);
    assert.equal((await fetch(`${url}/${saved.id}`, { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(`${url}/${saved.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${manageToken}` } })).status, 204);
    assert.deepEqual((await (await fetch(`${url}?before=2`)).json()).messages, []);
    assert.equal((await fetch(`${url}?archive=1`)).status, 404);
    const stopped = await fetch(`${base}/sessions/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${manageToken}` } });
    assert.equal(stopped.status, 204);
    assert.equal((await fetch(`${url}/blocked`, { headers: { Authorization: `Bearer ${manageToken}` } })).status, 404);
    assert.equal((await fetch(url)).status, 404);
    const archived = await fetch(`${url}?archive=1`);
    assert.equal(archived.status, 200);
    assert.deepEqual((await archived.json()).messages.map(({ text }) => text), ['next']);
    assert.equal((await fetch(`${url}?archive=1`, { method: 'POST' })).status, 405);
}));

test('an enabled captcha is enforced on direct HTTP writes and issues a chat-only pass', { timeout: 8000 }, (testContext) => withBroker(testContext, async (base) => {
  const created = await fetch(`${base}/sessions?public=1`, {
    method: 'POST', headers: { Authorization: 'Bearer qa-obs-organizer-placeholder' },
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const url = `${base}/sessions/${id}/chat`;
  const credential = await viewerIdentity(url);
  const page = await (await fetch(url)).json();
  assert.deepEqual(page.captcha, { siteKey: 'test-site-key', action: 'obs_chat' });
  const post = (text, proof) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'viewer', text, credential, ...proof }),
  });
  const missing = await post('test without token');
  assert.equal(missing.status, 403);
  assert.equal((await missing.json()).error, 'captcha_required');
  const verified = await post('First', { turnstileToken: 'valid' });
  assert.equal(verified.status, 201);
  const { chatPass } = await verified.json();
  assert.ok(chatPass);
  assert.equal((await post('Second', { chatPass })).status, 201);
  const history = await (await fetch(url)).json();
  assert.deepEqual(history.messages.map(({ text }) => text), ['First', 'Second']);
  assert.ok(history.messages.every((message) => !('chatPass' in message)));
  assert.equal((await fetch(`${url}/blocked`, { headers: { Authorization: `Bearer ${chatPass}` } })).status, 401);
}, true));

test('moderation rejects policy matches and bans one viewer without affecting a shared IP', { timeout: 8000 }, (t) => withBroker(t, async (base) => {
  const created = await fetch(`${base}/sessions?public=1`, {
    method: 'POST', headers: { Authorization: 'Bearer qa-obs-organizer-placeholder' },
  });
  assert.equal(created.status, 201);
  const { id, manageToken } = await created.json();
  const url = `${base}/sessions/${id}/chat`;
  const headers = { Authorization: `Bearer ${manageToken}`, 'content-type': 'application/json' };
  const settings = { method: 'PUT', body: JSON.stringify({ allowLinks: false, blockedPhrases: ['рекламный текст'] }) };
  assert.equal((await fetch(`${url}/policy`, settings)).status, 401);
  assert.equal((await fetch(`${url}/policy`, { ...settings, headers })).status, 200);
  const [first, second] = await Promise.all([viewerIdentity(url), viewerIdentity(url)]);
  const post = (credential, text, name = 'Same nickname') => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, text, credential }),
  });
  const denied = await post(first, 'Это РЕКЛАМНЫЙ ТЕКСТ.');
  assert.equal(denied.status, 422);
  assert.equal((await denied.json()).error, 'blocked_content');
  assert.equal((await post(first, 'https://example.test')).status, 422);
  const one = await post(first, 'Первая реплика 🙂');
  assert.equal(one.status, 201);
  const message = await one.json();
  assert.equal((await fetch(`${url}/ban/${message.id}`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${url}/ban/${message.id}`, { method: 'POST', headers })).status, 204);
  const barred = await post(first, 'Другое имя, тот же зритель', 'New nickname');
  assert.equal(barred.status, 403);
  assert.equal((await barred.json()).error, 'viewer_banned');
  assert.equal((await post(second, 'Вторая реплика 👍')).status, 201);
  assert.equal((await post(undefined, 'Нет пропуска')).status, 403);
  const history = await (await fetch(url)).json();
  assert.deepEqual(history.messages.map(({ text }) => text), ['Первая реплика 🙂', 'Вторая реплика 👍']);
  assert.ok(history.messages.every((entry) => !('viewer_id' in entry) && !('credential' in entry)));
  const { blocks } = await (await fetch(`${url}/blocked`, { headers })).json();
  assert.equal(blocks[0].reason, 'manual_ban');
  assert.equal((await fetch(`${url}/bans/${blocks[0].banId}`, { method: 'DELETE', headers })).status, 204);
  assert.equal((await (await fetch(`${url}/blocked`, { headers })).json()).total, 0);
}));
