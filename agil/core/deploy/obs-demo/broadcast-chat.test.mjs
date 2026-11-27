import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { chatSource, openBroadcastChat } from './broadcast-chat.mjs';

const comment = (text) => ({ name: 'Зритель', text });

test('comment spam is limited by source, repetition, and the stream budget', (t) => {
  let now = 10_000;
  const store = openBroadcastChat({ streamPerSecond: 2, clock: () => now });
  t.after(() => store.close());
  const chat = store.create('stream', now + 100_000);
  function post(ip, text) {
    const attempt = chat.admit(ip);
    return attempt.retry ? { status: 429, retry: attempt.retry } : chat.post(comment(text), attempt.source);
  }
  assert.equal(post('source-a', 'Привет!').status, 201);
  assert.equal(post('source-a', '  ПРИВЕТ!  ').body.error, 'duplicate_comment');
  assert.equal(post('source-a', 'Второе сообщение').status, 201);
  assert.equal(post('source-a', 'Третье сообщение').retry, 5);
  assert.equal(post('source-b', 'Привет!').status, 201);
  assert.equal(post('source-c', 'Первый комментарий').status, 201);
  assert.equal(post('source-d', 'Привет!').body.error, 'chat_busy');
  now += 5000;
  assert.equal(post('source-a', 'Новое сообщение').status, 201);
  assert.equal(chat.list().messages.length, 5);
});

test('trusted proxy identity is opt-in and IPv6 clients are grouped by network', () => {
  const request = (peer, supplied) => ({ socket: { remoteAddress: peer }, headers: { 'x-agil-client-ip': supplied } });
  assert.equal(chatSource(request('::ffff:127.0.0.1', '203.0.113.5'), new Set()), '127.0.0.1');
  const trusted = new Set(['127.0.0.1']);
  assert.equal(chatSource(request('::ffff:127.0.0.1', '203.0.113.5'), trusted), '203.0.113.5');
  assert.equal(chatSource(request('127.0.0.1', '203.0.113.5, 127.0.0.1'), trusted), '127.0.0.1');
  assert.equal(chatSource(request('2001:db8:1::1'), trusted), chatSource(request('2001:db8:0001::ffff'), trusted));
});

test('an active automatic block is scoped to the stream and expires without being extended by requests', (t) => {
  let now = 10_000;
  const store = openBroadcastChat({ clock: () => now });
  t.after(() => store.close());
  const chat = store.create('stream', now + 400_000);
  const other = store.create('other', now + 400_000);
  const address = '192.0.2.1';
  const { source } = chat.admit(address);
  chat.rejectCaptcha(source, 'First name');
  for (let index = 0; index < 6; index += 1) chat.rejectCaptcha(source, '  Last known name  ');
  chat.rejectCaptcha(source, 'invalid\u0000character');
  chat.rejectCaptcha(source, 'Ignored after blocking');
  const [block] = chat.blocked(0).blocks;
  const { blockId, ...details } = block;
  const { blockedUntil } = details;
  assert.match(blockId, /^[a-f0-9-]{36}$/);
  assert.equal(chat.blocked(0).blocks[0].blockId, blockId);
  assert.deepEqual(details, { address, name: 'Last known name', blockedAt: now, blockedUntil, reason: 'captcha_invalid' });
  assert.deepEqual(chat.list().messages, [], 'moderation-only claimed names are not archived as comments');
  assert.equal(blockedUntil, now + 300_000);
  assert.equal(chat.admit(address).blocked, true);
  assert.equal(other.admit(address).blocked, undefined);
  assert.deepEqual(other.blocked(0), { blocks: [], total: 0 });
  now = blockedUntil - 1000;
  assert.deepEqual(chat.admit(address), { blocked: true, retry: 1 });
  now = blockedUntil;
  assert.equal(chat.admit(address).blocked, undefined);
  assert.deepEqual(chat.blocked(0), { blocks: [], total: 0 });
});

test('the same spam from multiple sources shares a repetition limit', (t) => {
  const store = openBroadcastChat({ clock: () => 10_000 });
  t.after(() => store.close());
  const chat = store.create('stream', 100_000);
  for (let index = 0; index < 6; index += 1) {
    assert.equal(chat.post(comment('Посетите наш сайт'), chat.admit(String(index)).source).status, 201);
  }
  const anotherSource = chat.admit('new-source').source;
  assert.equal(chat.post(comment('ПОСЕТИТЕ  НАШ САЙТ'), anotherSource).body.error, 'repeated_comment');
  assert.equal(chat.post(comment('Когда перерыв?'), anotherSource).status, 201);
});

test('a large archive uses indexed cursor pages, survives restart, and expires', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'agil-broadcast-chat-'));
  const filename = path.join(directory, 'archive.sqlite');
  let now = 10_000;
  const options = { filename, clock: () => now };
  const first = openBroadcastChat(options);
  first.create('other', now + 100_000);
  first.create('large', now + 5000);
  first.close();
  const fixture = new DatabaseSync(filename);
  fixture.exec(`WITH RECURSIVE sample(id) AS (VALUES (1) UNION ALL SELECT id + 1 FROM sample WHERE id < 100000)
    INSERT INTO chat_messages (stream_id, id, name, text, at) SELECT 'large', id, 'viewer', 'sample ' || id, 10000 FROM sample`);
  fixture.close();
  const store = openBroadcastChat(options);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 3 }); });
  const latest = store.list('large');
  assert.equal(latest.messages.length, 80);
  assert.equal(latest.messages.at(-1).id, 100000);
  assert.equal(latest.before, 99921);
  assert.equal(store.list('large', latest.before).messages.at(-1).id, 99920);
  assert.equal(store.list('large', 2).messages[0].id, 1);
  assert.deepEqual(store.list('other').messages, []);
  now += 5000;
  assert.equal(store.exists('large'), false);
  assert.equal(store.sweep(), 1);
  assert.deepEqual(store.list('large').messages, []);
});

test('write retention and moderation update the tail without breaking the cursor', (t) => {
  const store = openBroadcastChat({ limit: 3 });
  t.after(() => store.close());
  const chat = store.create('stream', Date.now() + 5000);
  for (let index = 1; index <= 4; index += 1) {
    assert.equal(chat.post(comment(String(index)), chat.admit(String(index)).source).status, 201);
  }
  const latest = chat.list();
  assert.deepEqual(latest.messages.map(({ id }) => id), [2, 3, 4]);
  assert.equal(chat.remove(3), true);
  assert.notEqual(chat.list().etag, latest.etag);
  assert.deepEqual(chat.list(4).messages.map(({ id }) => id), [2]);
});

test('old archive schema is upgraded and author identifiers are cleared when the stream ends', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'agil-old-chat-'));
  const filename = path.join(directory, 'archive.sqlite');
  const old = new DatabaseSync(filename);
  old.exec(`
    CREATE TABLE chat_streams (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE chat_messages (
      stream_id TEXT NOT NULL REFERENCES chat_streams(id) ON DELETE CASCADE,
      id INTEGER NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (stream_id, id)
    ) WITHOUT ROWID;
    INSERT INTO chat_streams VALUES ('legacy', 1000000);
    INSERT INTO chat_messages VALUES ('legacy', 1, 'Old viewer', 'Old comment', 0);
  `);
  old.close();
  const store = openBroadcastChat({ filename, clock: () => 10_000 });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 3 }); });
  assert.equal(store.list('legacy').messages[0].text, 'Old comment');
  const chat = store.create('new', 100_000);
  chat.post(comment('New comment'), chat.admit('viewer', '192.0.2.1').source);
  assert.equal(chat.ban(1, 20_000), true);
  assert.equal(chat.admit('viewer', '192.0.2.200').banned, true);
  assert.ok(chat.admit('another-viewer', '192.0.2.1').source);
  store.forgetAuthors('new');
  const db = new DatabaseSync(filename);
  try { assert.equal(db.prepare('SELECT viewer_id FROM chat_messages WHERE stream_id = ?').get('new').viewer_id, null); }
  finally { db.close(); }
  assert.equal(store.list('new').messages[0].text, 'New comment');
});
