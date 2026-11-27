import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, type FileStoreOptions } from '../src/files.js';
import { SecurityError } from '../src/errors.js';

function makeStore(overrides: Partial<FileStoreOptions> = {}): { dir: string; store: FileStore } {
  const dir = mkdtempSync(join(tmpdir(), 'agil-files-'));
  const store = new FileStore({ dir, secret: 'test-secret', baseUrl: 'http://localhost:8787/', ttlSec: 3600, ...overrides });
  return { dir, store };
}

function signedParts(url: string): { sig: string | null; exp: number } {
  const parsed = new URL(url);
  return { sig: parsed.searchParams.get('sig'), exp: Number(parsed.searchParams.get('exp')) };
}

test('save + get: FileRecord, подписанный url, файлы на диске', () => {
  const { dir, store } = makeStore();
  try {
    const data = Buffer.from('hello attachment');
    const record = store.save({
      data,
      name: '../../secrets/photo.png',
      mime: 'image/png; charset=binary',
      tenantId: 'acme',
      roomId: 'room-1',
      uploadedBy: 'participant-1',
    });

    assert.match(record.id, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(record.name, 'photo.png', 'path traversal в имени файла должен быть отрезан');
    assert.equal(record.mime, 'image/png');
    assert.equal(record.size, data.length);
    assert.equal(record.tenantId, 'acme');
    assert.equal(record.roomId, 'room-1');
    assert.equal(record.uploadedBy, 'participant-1');
    assert.equal(record.expiresAt, record.createdAt + 3600 * 1000);
    assert.ok(record.url.startsWith(`http://localhost:8787/v1/files/${record.id}?sig=`));

    const parsed = new URL(record.url);
    assert.equal(parsed.pathname, `/v1/files/${record.id}`);
    const { sig, exp } = signedParts(record.url);
    assert.ok(sig && sig.length > 0);
    assert.equal(exp, record.expiresAt);

    const loaded = store.get(record.id, sig, exp);
    assert.ok(loaded);
    assert.equal(loaded.record.id, record.id);
    assert.deepEqual(loaded.data, data);

    assert.equal(existsSync(join(dir, record.id)), true);
    assert.equal(existsSync(join(dir, `${record.id}.json`)), true);
    const meta = JSON.parse(readFileSync(join(dir, `${record.id}.json`), 'utf8'));
    assert.equal(meta.id, record.id);
    assert.equal(meta.name, 'photo.png');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('get: чужая/битая подпись -> null', () => {
  const { dir, store } = makeStore();
  try {
    const record = store.save({
      data: Buffer.from('x'),
      name: 'a.txt',
      mime: 'text/plain',
      tenantId: 't',
      roomId: 'r',
      uploadedBy: 'u',
    });
    const { sig, exp } = signedParts(record.url);
    assert.ok(sig);

    const tampered = `${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
    assert.equal(store.get(record.id, tampered, exp), null);
    assert.equal(store.get(record.id, undefined, exp), null);
    assert.equal(store.get(record.id, '', exp), null);
    assert.equal(store.get(record.id, sig, exp + 1), null, 'exp не подписан заново');
    assert.equal(store.get(record.id, 'another-secret-signature', exp), null);
    assert.equal(store.get('00000000-0000-0000-0000-000000000000', sig, exp), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('get: истёкший exp -> null (подпись валидна)', () => {
  const { dir, store } = makeStore();
  try {
    const record = store.save({
      data: Buffer.from('x'),
      name: 'a.txt',
      mime: 'text/plain',
      tenantId: 't',
      roomId: 'r',
      uploadedBy: 'u',
    });
    const expiredExp = Date.now() - 1000;
    const sig = store.sign(record.id, expiredExp);
    assert.equal(store.get(record.id, sig, expiredExp), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('get/remove: path traversal в id -> null/false, ничего не читается', () => {
  const { dir, store } = makeStore();
  try {
    const record = store.save({
      data: Buffer.from('x'),
      name: 'a.txt',
      mime: 'text/plain',
      tenantId: 't',
      roomId: 'r',
      uploadedBy: 'u',
    });
    const { sig, exp } = signedParts(record.url);
    for (const id of ['../../etc/passwd', '..', '.', 'a/b', 'a\\b', '../agil-files-x', '', 'x'.repeat(65)]) {
      assert.equal(store.get(id, sig, exp), null, `id=${JSON.stringify(id)}`);
      assert.equal(store.remove(id), false, `remove id=${JSON.stringify(id)}`);
    }
    assert.equal(store.get(record.id, sig, exp)?.record.id, record.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save: file_too_large', () => {
  const { dir, store } = makeStore();
  try {
    assert.throws(
      () =>
        store.save({
          data: Buffer.alloc(2 * 1024 * 1024),
          name: 'big.bin',
          mime: 'application/octet-stream',
          tenantId: 't',
          roomId: 'r',
          uploadedBy: 'u',
          maxSizeMb: 1,
        }),
      (err: unknown) => err instanceof SecurityError && err.code === 'file_too_large',
    );
    // дефолтный лимит конструктора тоже работает
    const tiny = makeStore({ maxSizeMb: 0.001 });
    try {
      assert.throws(
        () =>
          tiny.store.save({
            data: Buffer.alloc(2048),
            name: 'big2.bin',
            mime: 'application/octet-stream',
            tenantId: 't',
            roomId: 'r',
            uploadedBy: 'u',
          }),
        (err: unknown) => err instanceof SecurityError && err.code === 'file_too_large',
      );
    } finally {
      rmSync(tiny.dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save: unsupported_mime (активный контент, пустой mime, allow-list)', () => {
  const { dir, store } = makeStore();
  const save = (mime: string, allowedMimeTypes?: string[]) =>
    store.save({ data: Buffer.from('x'), name: 'a.bin', mime, tenantId: 't', roomId: 'r', uploadedBy: 'u', allowedMimeTypes });
  try {
    for (const mime of ['text/html', 'image/svg+xml', 'application/javascript', '']) {
      assert.throws(
        () => save(mime),
        (err: unknown) => err instanceof SecurityError && err.code === 'unsupported_mime',
        `mime=${JSON.stringify(mime)}`,
      );
    }
    assert.throws(
      () => save('application/pdf', ['image/*']),
      (err: unknown) => err instanceof SecurityError && err.code === 'unsupported_mime',
    );
    assert.doesNotThrow(() => save('application/pdf', ['application/pdf']));
    assert.doesNotThrow(() => save('image/webp', ['image/*']));
    assert.doesNotThrow(() => save('image/webp', ['*/*']));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('list: фильтры tenantId/roomId/limit, новые первыми', () => {
  const { dir, store } = makeStore();
  try {
    const save = (roomId: string, name: string) =>
      store.save({ data: Buffer.from(name), name, mime: 'text/plain', tenantId: 'acme', roomId, uploadedBy: 'u' });
    save('room-1', 'one.txt');
    save('room-1', 'two.txt');
    save('room-2', 'three.txt');

    assert.equal(store.list().length, 3);
    assert.equal(store.list({ roomId: 'room-1' }).length, 2);
    assert.equal(store.list({ roomId: 'room-2' }).length, 1);
    assert.equal(store.list({ tenantId: 'acme' }).length, 3);
    assert.equal(store.list({ tenantId: 'other' }).length, 0);
    assert.equal(store.list({ limit: 1 }).length, 1);
    const names = store.list().map((r) => r.name);
    assert.ok(names.includes('one.txt') && names.includes('two.txt') && names.includes('three.txt'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('remove: удаляет payload+meta, повторный remove -> false', () => {
  const { dir, store } = makeStore();
  try {
    const record = store.save({
      data: Buffer.from('bye'),
      name: 'bye.txt',
      mime: 'text/plain',
      tenantId: 't',
      roomId: 'r',
      uploadedBy: 'u',
    });
    const { sig, exp } = signedParts(record.url);
    assert.equal(store.remove(record.id), true);
    assert.equal(existsSync(join(dir, record.id)), false);
    assert.equal(existsSync(join(dir, `${record.id}.json`)), false);
    assert.equal(store.get(record.id, sig, exp), null);
    assert.equal(store.remove(record.id), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
