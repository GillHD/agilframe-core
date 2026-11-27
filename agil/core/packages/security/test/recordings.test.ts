import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordingStore, type RecordingStoreOptions } from '../src/recordings.js';
import { SecurityError } from '../src/errors.js';

function makeStore(overrides: Partial<RecordingStoreOptions> = {}): { dir: string; store: RecordingStore } {
  const dir = mkdtempSync(join(tmpdir(), 'agil-recordings-'));
  const store = new RecordingStore({ dir, secret: 'rec-secret', baseUrl: 'http://localhost:8787/', ttlSec: 3600, ...overrides });
  return { dir, store };
}

function signedParts(url: string): { sig: string | null; exp: number } {
  const parsed = new URL(url);
  return { sig: parsed.searchParams.get('sig'), exp: Number(parsed.searchParams.get('exp')) };
}

test('save + get: RecordingRecord с подписанным url /v1/recordings', () => {
  const { dir, store } = makeStore();
  try {
    const data = Buffer.from('webm-bytes');
    const record = store.save({
      data,
      mime: 'video/webm',
      tenantId: 'acme',
      roomId: 'room-1',
      createdBy: 'host-1',
      durationSec: 12.5,
    });

    assert.match(record.id, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(record.mime, 'video/webm');
    assert.equal(record.size, data.length);
    assert.equal(record.durationSec, 12.5);
    assert.equal(record.tenantId, 'acme');
    assert.equal(record.roomId, 'room-1');
    assert.equal(record.createdBy, 'host-1');
    assert.equal(record.transcript, undefined);
    assert.ok(record.url.startsWith(`http://localhost:8787/v1/recordings/${record.id}?sig=`));

    const { sig, exp } = signedParts(record.url);
    assert.equal(exp, record.createdAt + 3600 * 1000);
    const loaded = store.get(record.id, sig, exp);
    assert.ok(loaded);
    assert.deepEqual(loaded.data, data);
    assert.equal(loaded.record.durationSec, 12.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('get: битая подпись и истёкший exp -> null', () => {
  const { dir, store } = makeStore();
  try {
    const record = store.save({
      data: Buffer.from('x'),
      mime: 'audio/webm',
      tenantId: 't',
      roomId: 'r',
      createdBy: 'u',
      durationSec: 1,
    });
    const { sig, exp } = signedParts(record.url);
    assert.ok(sig);
    assert.equal(store.get(record.id, `${sig.slice(0, -1)}X`, exp), null);
    assert.equal(store.get(record.id, sig, exp + 1000), null);
    const expiredExp = Date.now() - 1;
    assert.equal(store.get(record.id, store.sign(record.id, expiredExp), expiredExp), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save: unsupported mime для записей', () => {
  const { dir, store } = makeStore();
  try {
    assert.throws(
      () =>
        store.save({
          data: Buffer.from('x'),
          mime: 'text/plain',
          tenantId: 't',
          roomId: 'r',
          createdBy: 'u',
          durationSec: 1,
        }),
      (err: unknown) => err instanceof SecurityError && err.code === 'unsupported_mime',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('attachTranscript: добавляет/заменяет transcript, not_found для чужого id', () => {
  const { dir, store } = makeStore();
  try {
    const record = store.save({
      data: Buffer.from('x'),
      mime: 'video/webm',
      tenantId: 't',
      roomId: 'r',
      createdBy: 'u',
      durationSec: 3,
    });
    store.attachTranscript(record.id, 'Привет, это расшифровка.');
    const { sig, exp } = signedParts(record.url);
    const loaded = store.get(record.id, sig, exp);
    assert.equal(loaded?.record.transcript, 'Привет, это расшифровка.');

    store.attachTranscript(record.id, 'Новая расшифровка.');
    assert.equal(store.get(record.id, sig, exp)?.record.transcript, 'Новая расшифровка.');

    assert.throws(
      () => store.attachTranscript('00000000-0000-0000-0000-000000000000', 'x'),
      (err: unknown) => err instanceof SecurityError && err.code === 'not_found',
    );
    assert.throws(
      () => store.attachTranscript('../../etc/passwd', 'x'),
      (err: unknown) => err instanceof SecurityError && err.code === 'not_found',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save: transcript можно приложить сразу', () => {
  const { dir, store } = makeStore();
  try {
    const record = store.save({
      data: Buffer.from('x'),
      mime: 'video/webm',
      tenantId: 't',
      roomId: 'r',
      createdBy: 'u',
      durationSec: 1,
      transcript: 'заранее',
    });
    assert.equal(record.transcript, 'заранее');
    const { sig, exp } = signedParts(record.url);
    assert.equal(store.get(record.id, sig, exp)?.record.transcript, 'заранее');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('list: фильтры tenantId/roomId/limit и remove', () => {
  const { dir, store } = makeStore();
  try {
    const first = store.save({ data: Buffer.from('1'), mime: 'video/webm', tenantId: 'acme', roomId: 'r1', createdBy: 'u', durationSec: 1 });
    store.save({ data: Buffer.from('2'), mime: 'video/webm', tenantId: 'acme', roomId: 'r1', createdBy: 'u', durationSec: 2 });
    store.save({ data: Buffer.from('3'), mime: 'video/webm', tenantId: 'acme', roomId: 'r2', createdBy: 'u', durationSec: 3 });

    assert.equal(store.list().length, 3);
    assert.equal(store.list({ roomId: 'r1' }).length, 2);
    assert.equal(store.list({ roomId: 'r2' }).length, 1);
    assert.equal(store.list({ tenantId: 'acme' }).length, 3);
    assert.equal(store.list({ tenantId: 'other' }).length, 0);
    assert.equal(store.list({ limit: 1 }).length, 1);

    assert.equal(store.remove(first.id), true);
    assert.equal(store.list().length, 2);
    assert.equal(store.remove(first.id), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
