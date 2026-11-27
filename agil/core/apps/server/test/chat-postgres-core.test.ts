import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Pool } from 'pg';
import { openWs, startTestServer, type TestServer, type WsClient } from './helpers.js';

const databaseUrl = process.env.AGIL_TEST_POSTGRES_URL;
const admin = { 'x-api-key': 'dev-key' };

async function postgresProxy(target: URL): Promise<{ url: string; stop: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((from) => {
    const to = createConnection({ host: target.hostname, port: Number(target.port || 5432) });
    const disconnect = () => {
      sockets.delete(from);
      sockets.delete(to);
      from.destroy();
      to.destroy();
    };
    for (const socket of [from, to]) {
      sockets.add(socket);
      socket.on('error', disconnect);
      socket.once('close', disconnect);
    }
    from.pipe(to).pipe(from);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const routed = new URL(target);
  routed.hostname = '127.0.0.1';
  routed.port = String(address.port);
  let stopping: Promise<void> | undefined;
  return {
    url: routed.href,
    stop() {
      if (stopping) return stopping;
      for (const socket of sockets) socket.destroy();
      stopping = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      return stopping;
    },
  };
}

test('Core REST and WebSocket share PostgreSQL chat history across restart and fail closed during a DB outage', {
  skip: databaseUrl ? false : 'Set AGIL_TEST_POSTGRES_URL to a local test database with permission to create schemas',
  timeout: 30_000,
}, async () => {
  const database = new Pool({ connectionString: databaseUrl });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'agil-chat-pg-core-'));
  const schema = `agil_chat_core_test_${randomUUID().replaceAll('-', '')}`;
  const target = new URL(databaseUrl!);
  target.searchParams.set('options', `-c search_path=${schema}`);
  const priorUrl = process.env.AGIL_CHAT_POSTGRES_URL;
  let proxy: Awaited<ReturnType<typeof postgresProxy>> | undefined;
  let core: TestServer | undefined;
  let host: WsClient | undefined;
  let recreatedGuest: WsClient | undefined;
  try {
    await database.query(`CREATE SCHEMA ${schema}`);
    proxy = await postgresProxy(target);
    process.env.AGIL_CHAT_POSTGRES_URL = proxy.url;
    core = await startTestServer({ dataDir, continuityEnabled: true });
    const patched = await core.api('PATCH', '/v1/tenants/demo/config', {
      headers: admin,
      body: { session: { chat: { historyStorage: 'postgres', historyRetentionSec: 60 } } },
    });
    assert.equal(patched.status, 200, patched.text);
    const created = await core.api('POST', '/v1/admin/rooms', { headers: admin, body: { name: 'PostgreSQL test room' } });
    assert.equal(created.status, 200);
    const roomId = created.body.room.id as string;
    const room = `/v1/rooms/${roomId}`;
    const issued = await core.api('POST', '/v1/tokens', {
      headers: admin,
      body: { tenantId: 'demo', roomId, participant: { name: 'Host', role: 'host' } },
    });
    assert.equal(issued.status, 200);
    const token = issued.body.token as string;
    const authorization = { authorization: `Bearer ${token}` };
    host = await openWs(`${core.wsUrl}?token=${encodeURIComponent(token)}`);
    await host.waitFor(({ type }) => type === 'welcome');
    const rest = await core.api('POST', `${room}/chat`, { headers: authorization, body: { id: 'rest-message', text: 'Fixture REST' } });
    assert.equal(rest.status, 200);
    await host.waitFor(({ type, message }) => type === 'chat' && message?.id === 'rest-message');
    host.send({ type: 'chat', id: 'socket-message', text: 'Fixture WebSocket', acknowledge: true });
    const posted = await host.waitFor(({ type, id }) => type === 'chat-result' && id === 'socket-message');
    assert.equal(posted.message?.text, 'Fixture WebSocket');
    const before = await core.api('GET', `${room}/messages`, { headers: admin });
    assert.deepEqual(before.body.messages.map(({ id }: { id: string }) => id), ['rest-message', 'socket-message']);
    host.send({ type: 'history', limit: 2 });
    const history = await host.waitFor(({ type }) => type === 'chat-history');
    assert.deepEqual(history.messages, before.body.messages);
    const foreign = await core.api('GET', `${room}/messages`, { headers: { 'x-api-key': 'acme-key' } });
    assert.ok(foreign.status === 403 || foreign.status === 404);
    const rows = await database.query(`SELECT message_id FROM ${schema}.agil_chat_messages WHERE tenant_id = $1 AND room_id = $2`,
      ['demo', roomId]);
    assert.equal(rows.rowCount, 2);

    await host.close();
    host = undefined;
    await core.close();
    core = undefined;
    core = await startTestServer({ dataDir, continuityEnabled: true });
    host = await openWs(`${core.wsUrl}?token=${encodeURIComponent(token)}`);
    const welcome = await host.waitFor(({ type }) => type === 'welcome');
    assert.deepEqual(welcome.history.map(({ id }: { id: string }) => id), ['rest-message', 'socket-message']);
    const replay = await core.api('POST', `${room}/chat`, { headers: authorization, body: { id: 'rest-message', text: 'Replay candidate' } });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.message.text, 'Fixture REST');
    const after = await core.api('GET', `${room}/messages`, { headers: admin });
    assert.deepEqual(after.body.messages, before.body.messages);

    const reusableId = 'pg-reused-room';
    const reusable = `/v1/rooms/${reusableId}`;
    const createReusable = async () => {
      const roomResult = await core!.api('POST', '/v1/admin/rooms', {
        headers: admin, body: { roomId: reusableId, name: 'Reusable room' },
      });
      assert.equal(roomResult.status, 200);
      const invite = await core!.api('POST', '/v1/tokens', {
        headers: admin,
        body: { tenantId: 'demo', roomId: reusableId, participant: { name: 'Participant', role: 'guest' } },
      });
      assert.equal(invite.status, 200);
      return invite.body.token as string;
    };
    const originalToken = await createReusable();
    const original = await core.api('POST', `${reusable}/chat`, {
      headers: { authorization: `Bearer ${originalToken}` }, body: { id: 'reused-id', text: 'Previous meeting' },
    });
    assert.equal(original.status, 200);
    assert.equal((await core.api('DELETE', `/v1/admin/rooms/${reusableId}`, { headers: admin })).status, 200);
    const originalArchive = await core.api('GET', `${reusable}/messages`, { headers: admin });
    assert.deepEqual(originalArchive.body.messages, [original.body.message]);

    const recreatedToken = await createReusable();
    const empty = await core.api('GET', `${reusable}/messages`, { headers: admin });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.messages, []);
    recreatedGuest = await openWs(`${core.wsUrl}?token=${encodeURIComponent(recreatedToken)}`);
    const recreatedWelcome = await recreatedGuest.waitFor(({ type }) => type === 'welcome');
    assert.deepEqual(recreatedWelcome.history, []);
    recreatedGuest.send({ type: 'chat', id: 'reused-id', text: 'New meeting', acknowledge: true });
    const recreated = await recreatedGuest.waitFor(({ type, id }) => type === 'chat-result' && id === 'reused-id');
    assert.equal(recreated.message?.text, 'New meeting');
    await recreatedGuest.close();
    recreatedGuest = undefined;
    assert.equal((await core.api('DELETE', `/v1/admin/rooms/${reusableId}`, { headers: admin })).status, 200);
    const latestArchive = await core.api('GET', `${reusable}/messages`, { headers: admin });
    assert.deepEqual(latestArchive.body.messages, [recreated.message]);
    const instanceRows = await database.query(`SELECT DISTINCT room_instance_id FROM ${schema}.agil_chat_messages
      WHERE tenant_id = $1 AND room_id = $2`, ['demo', reusableId]);
    assert.equal(instanceRows.rowCount, 2);

    await proxy.stop();
    const failed = await core.api('POST', `${room}/chat`, { headers: authorization, body: { id: 'during-outage', text: 'Fixture outage' } });
    assert.equal(failed.status, 503, failed.text);
    assert.equal(failed.body.error.code, 'chat_storage_unavailable');
    assert.ok(!failed.text.includes('Fixture outage'));
    if (target.password) assert.ok(!failed.text.includes(target.password));
    host.send({ type: 'chat', id: 'socket-outage', text: 'Fixture outage via WS', acknowledge: true });
    const rejected = await host.waitFor(({ type, id }) => type === 'chat-result' && id === 'socket-outage');
    assert.equal(rejected.error, 'delivery_failed');
    host.send({ type: 'history', limit: 2 });
    await host.waitFor(({ type, code }) => type === 'error' && code === 'chat_storage_unavailable');
    assert.ok(!host.messages.some(({ type, message }) => type === 'chat' && ['during-outage', 'socket-outage'].includes(message?.id)));
    assert.equal((await core.api('GET', `${room}/messages`, { headers: admin })).status, 503);
    assert.equal((await core.api('GET', '/v1/health')).status, 200);
    const afterOutage = await database.query(`SELECT message_id FROM ${schema}.agil_chat_messages WHERE tenant_id = $1 AND room_id = $2`,
      ['demo', roomId]);
    assert.deepEqual(afterOutage.rows.map(({ message_id }) => message_id).sort(), ['rest-message', 'socket-message']);
  } finally {
    if (priorUrl === undefined) delete process.env.AGIL_CHAT_POSTGRES_URL;
    else process.env.AGIL_CHAT_POSTGRES_URL = priorUrl;
    await recreatedGuest?.close().catch(() => {});
    await host?.close().catch(() => {});
    await core?.close().catch(() => {});
    await proxy?.stop().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
    await database.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).finally(() => database.end());
  }
});
