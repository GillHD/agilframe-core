/** External chat injection (contract §22.1): public Bearer endpoint + admin bot endpoint. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWs, startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
let ts: TestServer;
let roomId: string;
let hostToken: string;
let guestToken: string;

before(async () => {
  ts = await startTestServer();
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Chat room' } });
  roomId = created.body.room.id;
  const host = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Host', role: 'host' } },
  });
  hostToken = host.body.token;
  const guest = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Guest', role: 'guest' } },
  });
  guestToken = guest.body.token;
});

after(async () => {
  await ts.close();
});

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

test('off delivers live chat, clears session history and emits no content webhook', async (t) => {
  const core = await startTestServer();
  const created = await core.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Live only' } });
  assert.equal(created.status, 200);
  const id = created.body.room.id as string;
  const token = await core.api('POST', '/v1/tokens', {
    headers: ADMIN, body: { tenantId: 'demo', roomId: id, participant: { name: 'Host', role: 'host' } },
  });
  const client = await openWs(`${core.wsUrl}?token=${encodeURIComponent(token.body.token)}`);
  t.after(async () => { await client.close(); await core.close(); });
  await client.waitFor((message) => message.type === 'welcome');
  const emit = t.mock.method(core.server.services.webhooks, 'emit');
  const post = (key: string) => core.api('POST', `/v1/admin/rooms/${id}/chat`, {
    headers: ADMIN, body: { text: key, id: key },
  });
  assert.equal((await post('old-session')).status, 200);
  const patch = (historyStorage: string) => core.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN, body: { session: { chat: { historyStorage } } },
  });
  assert.equal((await patch('off')).status, 200);
  assert.equal((await post('live-only')).status, 200);
  await client.waitFor((frame) => frame.type === 'chat' && frame.message.id === 'live-only');
  client.send({ type: 'history', limit: 15 });
  assert.deepEqual((await client.waitFor((frame) => frame.type === 'chat-history')).messages, []);
  assert.equal(emit.mock.calls.filter((call) => call.arguments[0] === 'chat.message').length, 1);
  assert.equal((await patch('session')).status, 200);
  const history = await core.api('GET', `/v1/rooms/${id}/messages`, { headers: ADMIN });
  assert.deepEqual(history.body.messages, []);
});

test('local chat keeps scoped history after restart and room closure', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agil-chat-local-'));
  let core = await startTestServer({ dataDir });
  t.after(async () => { await core.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const configure = (chat: Record<string, unknown>) => core.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN, body: { session: { chat } },
  });
  assert.equal((await configure({ historyStorage: 'local', historyRetentionSec: 120 })).status, 200);
  const updated = await configure({ allowSystemMessages: true });
  assert.equal(updated.body.config.session.chat.historyStorage, 'local');
  assert.equal(updated.body.config.session.chat.historyRetentionSec, 120);

  const created = await core.api('POST', '/v1/admin/rooms', {
    headers: ADMIN, body: { name: 'Local chat', roomId: 'same-local-room' },
  });
  assert.equal(created.status, 200);
  const id = created.body.room.id as string;
  const post = (text: string) => core.api('POST', `/v1/admin/rooms/${id}/chat`, {
    headers: ADMIN, body: { id: 'durable-id', text },
  });
  assert.equal((await post('persisted')).status, 200);
  await core.close();
  core = await startTestServer({ dataDir });
  const read = (headers: Record<string, string>) => core.api('GET', `/v1/rooms/${id}/messages`, { headers });
  const history = await read(ADMIN);
  assert.equal(history.status, 200, history.text);
  assert.equal(history.body.messages[0].text, 'persisted');
  assert.equal((await post('retry')).body.message.text, 'persisted');
  assert.equal((await core.api('DELETE', `/v1/rooms/${id}`, { headers: ADMIN })).status, 200);
  assert.equal((await read({ 'x-api-key': 'acme-key' })).status, 404);
  assert.equal((await read(ADMIN)).body.messages.length, 1);
  assert.equal((await core.api('POST', '/v1/admin/rooms', {
    headers: ADMIN, body: { name: 'New meeting', roomId: id },
  })).status, 200);
  assert.deepEqual((await read(ADMIN)).body.messages, []);
  assert.equal((await post('new meeting')).body.message.text, 'new meeting');
  assert.equal((await core.api('DELETE', `/v1/rooms/${id}`, { headers: ADMIN })).status, 200);
  assert.deepEqual((await read(ADMIN)).body.messages.map((message: { text: string }) => message.text), ['new meeting']);
  assert.equal((await configure({ historyStorage: 'off' })).status, 200);
  assert.equal((await read(ADMIN)).status, 404);
});

async function setChat(config: Record<string, unknown>): Promise<void> {
  const patched = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { session: { chat: config } },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
}

test('public injection: Bearer token, broadcast to WS, history and idempotency', async () => {
  const client = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(guestToken)}`);
  await client.waitFor((message) => message.type === 'welcome');

  const posted = await ts.api('POST', `/v1/rooms/${roomId}/chat`, {
    headers: bearer(hostToken),
    body: { text: 'привет из корпоративного чата', id: 'inject-1' },
  });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.message.id, 'inject-1');
  assert.equal(posted.body.message.text, 'привет из корпоративного чата');
  const broadcast = await client.waitFor((message) => message.type === 'chat' && message.message.id === 'inject-1');
  assert.equal(broadcast.message.roomId, roomId);

  const duplicate = await ts.api('POST', `/v1/rooms/${roomId}/chat`, {
    headers: bearer(hostToken),
    body: { text: 'другой текст', id: 'inject-1' },
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.message.text, 'привет из корпоративного чата');

  const messages = await ts.api('GET', `/v1/rooms/${roomId}/messages?limit=200`, { headers: ADMIN });
  const matches = messages.body.messages.filter((message: { id: string }) => message.id === 'inject-1');
  assert.equal(matches.length, 1);

  const unauthenticated = await ts.api('POST', `/v1/rooms/${roomId}/chat`, { body: { text: 'x' } });
  assert.equal(unauthenticated.status, 401);
  const tooLong = await ts.api('POST', `/v1/rooms/${roomId}/chat`, {
    headers: bearer(hostToken),
    body: { text: 'x'.repeat(4001) },
  });
  assert.equal(tooLong.status, 400);
  await client.close();
});

test('system messages require allowSystemMessages and a host/moderator role', async () => {
  const guestSystem = await ts.api('POST', `/v1/rooms/${roomId}/chat`, {
    headers: bearer(guestToken),
    body: { kind: 'system', text: 'системное объявление' },
  });
  assert.equal(guestSystem.status, 403);

  const hostSystem = await ts.api('POST', `/v1/rooms/${roomId}/chat`, {
    headers: bearer(hostToken),
    body: { kind: 'system', text: 'созвон начнётся через минуту', id: 'sys-1' },
  });
  assert.equal(hostSystem.status, 200);
  assert.equal(hostSystem.body.message.kind, 'system');
  assert.equal(hostSystem.body.message.from.name, 'Система');

  await setChat({ allowSystemMessages: false });
  const disabled = await ts.api('POST', `/v1/rooms/${roomId}/chat`, {
    headers: bearer(hostToken),
    body: { kind: 'system', text: 'не должно пройти' },
  });
  assert.equal(disabled.status, 403);
  await setChat({ allowSystemMessages: true });
});

test('allowHostInjection=false blocks text injection; external UI keeps the API path', async () => {
  await setChat({ ui: 'external', allowHostInjection: false });
  const blocked = await ts.api('POST', `/v1/rooms/${roomId}/chat`, {
    headers: bearer(hostToken),
    body: { text: 'нельзя' },
  });
  assert.equal(blocked.status, 403);

  const adminBlocked = await ts.api('POST', `/v1/admin/rooms/${roomId}/chat`, { headers: ADMIN, body: { text: 'нельзя' } });
  assert.equal(adminBlocked.status, 403);

  await setChat({ ui: 'external', allowHostInjection: true });
  const allowed = await ts.api('POST', `/v1/rooms/${roomId}/chat`, {
    headers: bearer(hostToken),
    body: { text: 'можно' },
  });
  assert.equal(allowed.status, 200);
});

test('admin bot injection: defaults to "Система", broadcasts and is audited', async () => {
  const client = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(guestToken)}`);
  await client.waitFor((message) => message.type === 'welcome');
  const posted = await ts.api('POST', `/v1/admin/rooms/${roomId}/chat`, {
    headers: ADMIN,
    body: { text: 'CRM: клиент в очереди', id: 'crm-1' },
  });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.message.from.name, 'Система');
  assert.equal(posted.body.message.from.role, 'moderator');
  const broadcast = await client.waitFor((message) => message.type === 'chat' && message.message.id === 'crm-1');
  assert.equal(broadcast.message.text, 'CRM: клиент в очереди');

  const audit = await ts.api('GET', '/v1/admin/audit?type=chat.sent&limit=50', { headers: ADMIN });
  assert.equal(audit.status, 200);
  assert.ok(audit.body.entries.some((entry: { roomId?: string }) => entry.roomId === roomId));
  await client.close();
});

test('chat history and delivery honor room permissions, including changes during a call', async () => {
  const existing = await ts.api('GET', '/v1/tenants/demo/config', { headers: ADMIN });
  assert.equal(existing.status, 200);
  const originalGuestFeatures: string[] = existing.body.config.security.accessPolicy.roleDefaults.guest;
  const patch = async (security: Record<string, unknown>) => {
    const response = await ts.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { security } });
    assert.equal(response.status, 200);
  };
  await patch({ guestCanChat: false });
  const seeded = await ts.api('POST', `/v1/admin/rooms/${roomId}/chat`, {
    headers: ADMIN, body: { text: 'Meeting agenda', id: 'agenda' },
  });
  assert.equal(seeded.status, 200);
  const restricted = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Observer', role: 'guest' }, permissions: ['participantList'] },
  });
  assert.equal(restricted.status, 200);
  const [host, reader, observer] = await Promise.all([hostToken, guestToken, restricted.body.token].map(
    (token) => openWs(`${ts.wsUrl}?token=${encodeURIComponent(token)}`),
  ));
  try {
    const [, readable, hidden] = await Promise.all([host, reader, observer].map(
      (client) => client.waitFor((message) => message.type === 'welcome'),
    ));
    assert.ok(readable.history.some((message: { id: string }) => message.id === 'agenda'));
    assert.deepEqual(hidden.history, []);
    reader.send({ type: 'history' });
    const history = await reader.waitFor((message) => message.type === 'chat-history');
    assert.ok(history.messages.some((message: { id: string }) => message.id === 'agenda'));
    const send = await ts.api('POST', `/v1/rooms/${roomId}/chat`, {
      headers: bearer(guestToken), body: { text: 'Read-only role' },
    });
    assert.equal(send.status, 403);

    const publish = async (id: string) => {
      const response = await ts.api('POST', `/v1/admin/rooms/${roomId}/chat`, {
        headers: ADMIN, body: { text: 'Meeting update', id },
      });
      assert.equal(response.status, 200);
      await host.waitFor((message) => message.type === 'chat' && message.message.id === id);
    };
    const assertExcluded = async (client: typeof observer, id: string) => {
      const ts = Date.now();
      client.send({ type: 'ping', ts });
      await client.waitFor((message) => message.type === 'pong' && message.ts === ts);
      assert.ok(!client.messages.some((message) => message.type === 'chat' && message.message.id === id));
    };

    await publish('visible-to-reader');
    await reader.waitFor((message) => message.type === 'chat' && message.message.id === 'visible-to-reader');
    await assertExcluded(observer, 'visible-to-reader');
    await patch({ accessPolicy: { roleDefaults: { guest: originalGuestFeatures.filter((feature) => feature !== 'chat') } } });
    await reader.waitFor((message) => message.type === 'room' && message.participants.some(
      (member: { id: string; permissions: string[] }) => member.id === readable.self.id && !member.permissions.includes('chat'),
    ));
    await publish('after-chat-revocation');
    await assertExcluded(reader, 'after-chat-revocation');
  } finally {
    await Promise.all([host, reader, observer].map((client) => client.close()));
    await patch({ guestCanChat: true, accessPolicy: { roleDefaults: { guest: originalGuestFeatures } } });
  }
});

test('tenant config validates §22 fields (session.chat + layout chrome/minimized)', async () => {
  const invalid = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { session: { chat: { ui: 'weird' } } },
  });
  assert.equal(invalid.status, 400);

  const valid = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: {
      session: { chat: { ui: 'hidden', allowHostInjection: false, allowSystemMessages: false, externalProviderName: 'corp' } },
      layout: { chrome: 'compact', persistAcrossPages: true, inheritHostStyles: true, minimized: { enabled: true, mode: 'bubble' } },
    },
  });
  assert.equal(valid.status, 200, JSON.stringify(valid.body));
  assert.equal(valid.body.config.session.chat.ui, 'hidden');
  assert.equal(valid.body.config.layout.chrome, 'compact');
  assert.equal(valid.body.config.layout.persistAcrossPages, true);

  // Restore defaults used by the rest of the suite.
  await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { session: { chat: { ui: 'builtin', allowHostInjection: true, allowSystemMessages: true } } },
  });
});
