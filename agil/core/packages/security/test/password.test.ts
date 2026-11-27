import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  isPasswordHash,
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  SCRYPT_KEY_LEN,
  SCRYPT_SALT_BYTES,
} from '../src/password.js';
import { SecurityError } from '../src/errors.js';

const PLAIN = 'correct horse battery staple';

test('hashPassword: формат scrypt$N$r$p$salt$hash, соль и ключ base64url', () => {
  const stored = hashPassword(PLAIN);
  const parts = stored.split('$');
  assert.equal(parts.length, 6);
  assert.equal(parts[0], 'scrypt');
  assert.equal(parts[1], String(SCRYPT_N));
  assert.equal(parts[2], String(SCRYPT_R));
  assert.equal(parts[3], String(SCRYPT_P));
  // 16 bytes -> 22 base64url chars; 64 bytes -> 86 chars (no padding)
  assert.match(parts[4] as string, new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((SCRYPT_SALT_BYTES * 4) / 3)}}$`));
  assert.match(parts[5] as string, new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((SCRYPT_KEY_LEN * 4) / 3)}}$`));
  assert.match(stored, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.ok(isPasswordHash(stored));
});

test('hashPassword: не хранит и не возвращает пароль в открытом виде; соль случайна', () => {
  const first = hashPassword(PLAIN);
  const second = hashPassword(PLAIN);
  assert.notEqual(first, PLAIN);
  assert.ok(!first.includes(PLAIN));
  assert.notEqual(first, second, 'случайная соль должна давать разные хэши');
  assert.notEqual(first.split('$')[4], second.split('$')[4]);
});

test('hashPassword: пустой пароль -> SecurityError(password_required)', () => {
  assert.throws(
    () => hashPassword(''),
    (error: unknown) => error instanceof SecurityError && error.code === 'password_required',
  );
});

test('verifyPassword: верный пароль -> true, неверный -> false', () => {
  const stored = hashPassword(PLAIN);
  assert.equal(verifyPassword(PLAIN, stored), true);
  assert.equal(verifyPassword(`${PLAIN} `, stored), false);
  assert.equal(verifyPassword('wrong', stored), false);
  assert.equal(verifyPassword('', stored), false);
  assert.equal(verifyPassword(PLAIN, ''), false);
});

test('verifyPassword: битый/подделанный хэш -> false, без исключения', () => {
  const stored = hashPassword(PLAIN);
  const parts = stored.split('$');
  const hash = parts[5] as string;
  const tamperedHash = `${hash[0] === 'A' ? 'B' : 'A'}${hash.slice(1)}`;
  const malformed = [
    '',
    'plain-password',
    'scrypt',
    'scrypt$16384$8$1$only-five-parts',
    `bcrypt$${parts[1]}$${parts[2]}$${parts[3]}$${parts[4]}$${parts[5]}`,
    `scrypt$16383$8$1$${parts[4]}$${tamperedHash}`, // N not a power of two
    `scrypt$0$8$1$${parts[4]}$${tamperedHash}`,
    `scrypt$16384$0$1$${parts[4]}$${tamperedHash}`,
    `scrypt$16384$8$1$!!!$???`,
    `scrypt$16384$8$1$${parts[4]}$${tamperedHash}`,
    `scrypt$16384$8$1$${parts[4]}$${hash.slice(0, 8)}`,
  ];
  for (const candidate of malformed) {
    assert.equal(verifyPassword(PLAIN, candidate), false, `должен вернуть false для ${JSON.stringify(candidate)}`);
  }
});

test('isPasswordHash: строки-пароли и мусор -> false', () => {
  assert.equal(isPasswordHash(null), false);
  assert.equal(isPasswordHash(undefined), false);
  assert.equal(isPasswordHash(PLAIN), false);
  assert.equal(isPasswordHash('scrypt$16384$8$1$abc'), false);
  assert.equal(isPasswordHash(hashPassword('x')), true);
});
