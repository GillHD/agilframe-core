import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { ChatMessage } from '@agil/protocol';
import { openPostgresChatStore, PostgresChatStoreError, type ChatHistoryStore } from '../src/chat-postgres.js';

const databaseUrl = process.env.AGIL_TEST_POSTGRES_URL;

test('PostgreSQL isolates room instances and tenants, deduplicates retries, and expires old rows', {
  skip: databaseUrl ? false : 'Set AGIL_TEST_POSTGRES_URL to a test database with permission to create schemas',
  timeout: 15_000,
}, async () => {
  const database = new Pool({ connectionString: databaseUrl });
  const schema = `agil_chat_test_${randomUUID().replaceAll('-', '')}`;
  const scopedUrl = new URL(databaseUrl!);
  scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const stores: ChatHistoryStore[] = [];
  const open = async () => {
    const store = await openPostgresChatStore(scopedUrl.href);
    stores.push(store);
    return store;
  };
  try {
    // The schema name is a local test identifier derived from a UUID.
    await database.query(`CREATE SCHEMA ${schema}`);
    const [first, second] = await Promise.all([open(), open()]);
    const archive = { tenantId: 'demo', roomId: 'alpha' };
    const scope = { ...archive, roomInstanceId: 'a-original' };
    const recreated = { ...archive, roomInstanceId: 'z-recreated' };
    const siblingRoom = { tenantId: 'demo', roomId: 'beta', roomInstanceId: scope.roomInstanceId };
    const siblingTenant = { tenantId: 'acme', roomId: 'alpha', roomInstanceId: scope.roomInstanceId };
    const message = (id: string, roomId: string, text: string, ts = 10): ChatMessage => ({
      id, roomId, text, ts, kind: 'text', from: { id: 'sample-user', name: 'Sample', role: 'guest' },
    });

    const retries = await Promise.all([
      first.append(scope, message('dedupe', scope.roomId, 'Original candidate'), 30),
      second.append(scope, message('dedupe', scope.roomId, 'Concurrent candidate'), 30),
    ]);
    assert.equal(retries.filter(({ duplicate }) => !duplicate).length, 1);
    assert.deepEqual(retries[0]?.message, retries[1]?.message);
    const ttl = async () => (await database.query<{ expires_at: Date; remaining: number }>(`
      SELECT expires_at, EXTRACT(EPOCH FROM expires_at - CURRENT_TIMESTAMP)::int AS remaining
      FROM ${schema}.agil_chat_messages WHERE tenant_id = $1 AND room_id = $2 AND room_instance_id = $3 AND message_id = $4`,
    [scope.tenantId, scope.roomId, scope.roomInstanceId, 'dedupe'])).rows[0];
    const beforeRetry = await ttl();
    assert.ok(beforeRetry && beforeRetry.remaining > 0 && beforeRetry.remaining <= 30);
    const replay = await first.append(scope, message('dedupe', scope.roomId, 'Replay'), 60);
    assert.equal(replay.duplicate, true);
    assert.deepEqual((await ttl())?.expires_at, beforeRetry.expires_at);
    await first.append(scope, message('later', scope.roomId, 'Later', 20), 30);
    await second.append(siblingRoom, message('dedupe', siblingRoom.roomId, 'Another room'), 30);
    await second.append(siblingTenant, message('dedupe', siblingTenant.roomId, 'Another tenant'), 30);

    await first.close();
    const restarted = await open();
    assert.deepEqual((await restarted.recent(scope, 200)).map(({ id }) => id), ['dedupe', 'later']);
    assert.deepEqual((await restarted.recent(scope, 1)).map(({ id }) => id), ['later']);
    assert.equal((await restarted.recent(siblingRoom, 10))[0]?.text, 'Another room');
    assert.equal((await restarted.recent(siblingTenant, 10))[0]?.text, 'Another tenant');
    await assert.rejects(() => restarted.append(scope, message('invalid-scope', siblingRoom.roomId, 'Wrong scope'), 30), TypeError);
    await assert.rejects(() => restarted.append(archive, message('missing-instance', scope.roomId, 'Missing scope'), 30), TypeError);
    assert.deepEqual(await restarted.recent(recreated, 200), []);
    const originalHistory = await restarted.recent(scope, 200);
    assert.deepEqual(await restarted.recent(archive, 200), originalHistory);

    const reused = message('dedupe', recreated.roomId, 'New room instance', 1);
    assert.deepEqual(await restarted.append(recreated, reused, 30), { message: reused, duplicate: false });
    assert.deepEqual(await restarted.recent(recreated, 200), [reused]);
    assert.deepEqual(await restarted.recent(archive, 200), [reused]);
    assert.deepEqual(await restarted.recent(scope, 200), originalHistory);
    await database.query(`UPDATE ${schema}.agil_chat_messages SET stored_at = CURRENT_TIMESTAMP
      WHERE tenant_id = $1 AND room_id = $2`, [scope.tenantId, scope.roomId]);
    assert.deepEqual(await restarted.recent(archive, 200), [reused]);

    await database.query(`UPDATE ${schema}.agil_chat_messages SET expires_at = CURRENT_TIMESTAMP
      WHERE tenant_id = $1 AND room_id = $2 AND message_id = $3`, [scope.tenantId, scope.roomId, 'dedupe']);
    assert.deepEqual((await restarted.recent(scope, 200)).map(({ id }) => id), ['later']);
    assert.deepEqual((await restarted.recent(archive, 200)).map(({ id }) => id), ['later']);
    assert.equal(await restarted.sweepExpired(), 2);
    assert.equal(await restarted.purge(scope), 1);
    assert.equal(await restarted.purge(scope), 0);
    assert.equal((await restarted.recent(siblingRoom, 10)).length, 1);
    assert.equal(await restarted.purge({ tenantId: 'demo' }), 1);
    assert.equal((await restarted.recent(siblingTenant, 10)).length, 1);
  } finally {
    await Promise.allSettled(stores.map((store) => store.close()));
    await database.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).finally(() => database.end());
  }
});

test('PostgreSQL chat startup returns a sanitized configuration error', async () => {
  await assert.rejects(() => openPostgresChatStore('postgres://fixture-user:fixture-sensitive@['), {
    name: PostgresChatStoreError.name,
    code: 'chat_storage_unavailable',
    message: 'PostgreSQL chat storage is unavailable',
  });
});
