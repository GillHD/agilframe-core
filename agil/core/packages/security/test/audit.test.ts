import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, auditFileName } from '../src/audit.js';
import { hashIp } from '../src/ip.js';

const SALT = 'test-ip-salt';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'agil-audit-'));
}

test('append: возвращает AuditEntry с id/ts, JSONL-файл создаётся и содержит запись', () => {
  const dir = makeTempDir();
  try {
    const log = new AuditLog({ dir: join(dir, 'audit'), salt: SALT });
    const entry = log.append({
      type: 'join.allowed',
      severity: 'info',
      tenantId: 'acme',
      roomId: 'room-1',
      participantId: 'p-1',
      message: 'participant joined',
      details: { role: 'guest' },
    });

    assert.ok(entry.id.length > 0);
    assert.equal(typeof entry.ts, 'number');
    assert.equal(entry.type, 'join.allowed');
    assert.equal(entry.tenantId, 'acme');

    const file = join(dir, 'audit', 'acme.jsonl');
    assert.equal(existsSync(file), true);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0] as string), entry);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('append: ip хэшируется солью лога, сырой IP не пишется на диск', () => {
  const dir = makeTempDir();
  try {
    const log = new AuditLog({ dir, salt: SALT });
    const entry = log.append({
      type: 'join.denied',
      severity: 'warn',
      tenantId: 'demo',
      ip: '203.0.113.7',
      message: 'geo blocked',
    });
    assert.equal(entry.ipHash, hashIp('203.0.113.7', SALT));
    assert.match(entry.ipHash as string, /^[0-9a-f]{32}$/);

    const raw = readFileSync(join(dir, 'demo.jsonl'), 'utf8');
    assert.ok(!raw.includes('203.0.113.7'), 'сырой IP не должен попадать в файл');
    assert.ok(raw.includes(entry.ipHash as string));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('append: без tenantId -> _global.jsonl; traversal в tenantId не выходит из каталога', () => {
  const dir = makeTempDir();
  try {
    const log = new AuditLog({ dir });
    log.append({ type: 'admin.action', severity: 'info', message: 'no tenant' });
    assert.equal(existsSync(join(dir, '_global.jsonl')), true);

    const nested = new AuditLog({ dir: join(dir, 'audit') });
    const evil = nested.append({
      type: 'admin.action',
      severity: 'warn',
      tenantId: '../../etc/passwd',
      message: 'traversal attempt',
    });
    const created = readdirSync(join(dir, 'audit'));
    assert.equal(created.length, 1);
    assert.ok(created[0]!.endsWith('.jsonl'));
    assert.ok(!created[0]!.includes('/') && !created[0]!.includes('\\'));
    assert.equal(auditFileName('..'), '_global.jsonl');
    assert.equal(auditFileName('acme/prod'), 'acme_prod.jsonl');
    assert.equal(evil.tenantId, '../../etc/passwd'); // событие хранит исходный tenantId
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('list: новые первыми + фильтры type/roomId/since/limit', async () => {
  const dir = makeTempDir();
  try {
    const log = new AuditLog({ dir });
    const first = log.append({ type: 'join.allowed', severity: 'info', tenantId: 't', roomId: 'r1', message: 'first' });
    await sleep(5);
    const second = log.append({ type: 'password.failed', severity: 'warn', tenantId: 't', roomId: 'r1', message: 'second' });
    await sleep(5);
    const third = log.append({ type: 'file.shared', severity: 'info', tenantId: 't', roomId: 'r2', message: 'third' });

    assert.deepEqual(log.list().map((e) => e.id), [third.id, second.id, first.id]);
    assert.deepEqual(log.list({ limit: 2 }).map((e) => e.message), ['third', 'second']);
    assert.deepEqual(log.list({ type: 'join.allowed' }).map((e) => e.message), ['first']);
    assert.deepEqual(log.list({ roomId: 'r2' }).map((e) => e.message), ['third']);
    assert.deepEqual(log.list({ since: second.ts }).map((e) => e.id), [third.id, second.id]);
    assert.deepEqual(log.list({ since: third.ts + 1 }), []);
    assert.equal(log.list({ limit: 9999 }).length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('page: anchors by append order and only within the current tenant', () => {
  const dir = makeTempDir();
  try {
    const log = new AuditLog({ dir, ringSize: 6 });
    const append = (tenantId: string) => log.append({
      tenantId, type: 'session.resumed', severity: 'info', message: 'report',
    });
    const old = append('demo');
    const boundary = append('demo');
    const other = append('acme');
    const first = log.page({ tenantId: 'demo', limit: 1 });
    assert.equal(first.anchorId, boundary.id);
    assert.deepEqual(first.entries.map((entry) => entry.id), [boundary.id]);
    const fresh = append('demo');
    assert.deepEqual(log.page({ tenantId: 'demo', anchorId: first.anchorId, offset: 1 }).entries.map((entry) => entry.id), [old.id]);
    assert.deepEqual(log.page({ tenantId: 'demo', limit: 1 }).entries.map((entry) => entry.id), [fresh.id]);
    assert.deepEqual(log.page({ tenantId: 'demo', anchorId: other.id }), { entries: [], total: 0 });
    for (let index = 0; index < 4; index++) append('demo');
    assert.deepEqual(log.page({ tenantId: 'demo', anchorId: first.anchorId }), { entries: [], total: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('countByType: считает события с ts >= since', () => {
  const dir = makeTempDir();
  try {
    const log = new AuditLog({ dir });
    const since = Date.now();
    log.append({ type: 'join.allowed', severity: 'info', message: 'a' });
    log.append({ type: 'join.allowed', severity: 'info', message: 'b' });
    log.append({ type: 'join.denied', severity: 'warn', message: 'c' });
    const counts = log.countByType(since);
    assert.deepEqual(counts, { 'join.allowed': 2, 'join.denied': 1 });
    assert.deepEqual(log.countByType(Date.now() + 60_000), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ring: ограничен ringSize, list видит только последние записи', () => {
  const dir = makeTempDir();
  try {
    const log = new AuditLog({ dir, ringSize: 3 });
    for (let i = 0; i < 5; i += 1) {
      log.append({ type: 'admin.action', severity: 'info', message: `event-${i}` });
    }
    assert.equal(log.size, 3);
    assert.deepEqual(log.list().map((e) => e.message), ['event-4', 'event-3', 'event-2']);
    const lines = readFileSync(join(dir, '_global.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 5, 'все записи остаются на диске');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('конструктор: создаёт отсутствующий каталог recursive', () => {
  const dir = makeTempDir();
  try {
    const nested = join(dir, 'a', 'b', 'c');
    const log = new AuditLog({ dir: nested });
    log.append({ type: 'room.created', severity: 'info', message: 'ok' });
    assert.equal(existsSync(join(nested, '_global.jsonl')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
