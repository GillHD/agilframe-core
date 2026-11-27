import test from 'node:test';
import assert from 'node:assert/strict';
import { hashIp, resolveClientIp, normalizeIp, headerValue } from '../src/ip.js';

test('hashIp: sha256 hex, 32 символа, необратимый (без исходного IP)', () => {
  const hashed = hashIp('203.0.113.7', 'pepper');
  assert.equal(hashed.length, 32);
  assert.match(hashed, /^[0-9a-f]{32}$/);
  assert.ok(!hashed.includes('203.0.113.7'));
  assert.equal(hashIp('203.0.113.7', 'pepper'), hashed);
  assert.notEqual(hashIp('203.0.113.7', 'other-pepper'), hashed);
  assert.notEqual(hashIp('203.0.113.8', 'pepper'), hashed);
});

test('hashIp: ::ffff:-нормализация и IPv4-порт дают тот же хэш', () => {
  const expected = hashIp('1.2.3.4', 'salt');
  assert.equal(hashIp('::ffff:1.2.3.4', 'salt'), expected);
  assert.equal(hashIp('1.2.3.4:5555', 'salt'), expected);
  assert.equal(hashIp('  1.2.3.4  ', 'salt'), expected);
  assert.equal(hashIp('[::1]:443', 'salt'), hashIp('::1', 'salt'));
  assert.equal(hashIp('fe80::1%eth0', 'salt'), hashIp('fe80::1', 'salt'));
});

test('normalizeIp: основные формы', () => {
  assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeIp('::ffff:8.8.8.8'), '8.8.8.8');
  assert.equal(normalizeIp('[2001:db8::1]:8080'), '2001:db8::1');
  assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1');
  assert.equal(normalizeIp(''), '');
  assert.equal(normalizeIp(undefined as unknown as string), '');
});

test('resolveClientIp: x-forwarded-for игнорируется без trustProxy', () => {
  const ip = resolveClientIp({
    headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
    remoteAddress: '10.0.0.1',
    trustProxy: false,
  });
  assert.equal(ip, '10.0.0.1');
});

test('resolveClientIp: с trustProxy берётся первый адрес x-forwarded-for', () => {
  assert.equal(
    resolveClientIp({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, remoteAddress: '10.0.0.1', trustProxy: true }),
    '203.0.113.7',
  );
  assert.equal(
    resolveClientIp({ headers: { 'X-Forwarded-For': ' 198.51.100.9 ' }, remoteAddress: '10.0.0.1', trustProxy: true }),
    '198.51.100.9',
  );
  // массив значений (Node может отдать string[]) — первый непустой
  assert.equal(
    resolveClientIp({ headers: { 'x-forwarded-for': ['198.51.100.10', '10.0.0.1'] }, remoteAddress: '10.0.0.1', trustProxy: true }),
    '198.51.100.10',
  );
});

test('resolveClientIp: fallback на remoteAddress и нормализация ::ffff:', () => {
  assert.equal(resolveClientIp({ remoteAddress: '::ffff:127.0.0.1' }), '127.0.0.1');
  assert.equal(
    resolveClientIp({ headers: { 'x-forwarded-for': 'unknown' }, remoteAddress: '10.1.2.3', trustProxy: true }),
    '10.1.2.3',
  );
  assert.equal(resolveClientIp({ headers: {}, remoteAddress: '10.1.2.3', trustProxy: true }), '10.1.2.3');
  assert.equal(resolveClientIp({}), '');
});

test('headerValue: регистронезависимый поиск', () => {
  assert.equal(headerValue({ 'CF-IPCountry': 'DE' }, 'cf-ipcountry'), 'DE');
  assert.equal(headerValue({ 'cf-ipcountry': ['RU', 'DE'] }, 'cf-ipcountry'), 'RU');
  assert.equal(headerValue({ 'cf-ipcountry': '   ' }, 'cf-ipcountry'), undefined);
  assert.equal(headerValue(undefined, 'cf-ipcountry'), undefined);
});
