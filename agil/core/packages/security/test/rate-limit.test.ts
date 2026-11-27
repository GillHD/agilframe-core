import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/rate-limit.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('check: лимит соблюдается, remaining убывает, лишние запросы отклоняются', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
  assert.deepEqual(limiter.check('ip:room'), { allowed: true, retryAfterMs: 0, remaining: 2 });
  assert.deepEqual(limiter.check('ip:room'), { allowed: true, retryAfterMs: 0, remaining: 1 });
  assert.deepEqual(limiter.check('ip:room'), { allowed: true, retryAfterMs: 0, remaining: 0 });
  const denied = limiter.check('ip:room');
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
  assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 60_000);
});

test('check: ключи независимы', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
  assert.equal(limiter.check('a').allowed, true);
  assert.equal(limiter.check('a').allowed, false);
  assert.equal(limiter.check('b').allowed, true);
});

test('окно: после windowMs лимит сбрасывается', async () => {
  const limiter = createRateLimiter({ windowMs: 40, max: 1 });
  assert.equal(limiter.check('key').allowed, true);
  assert.equal(limiter.check('key').allowed, false);
  await sleep(80);
  assert.equal(limiter.check('key').allowed, true);
});

test('reset: очищает один ключ', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
  assert.equal(limiter.check('k').allowed, true);
  assert.equal(limiter.check('k').allowed, false);
  limiter.reset('k');
  assert.equal(limiter.check('k').allowed, true);
});

test('bounded memory: maxKeys ограничивает число ключей (LRU-eviction)', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1, maxKeys: 2 });
  assert.equal(limiter.check('a').allowed, true);
  assert.equal(limiter.check('b').allowed, true);
  assert.equal(limiter.check('c').allowed, true); // вытесняет самый старый ключ
  assert.ok(limiter.size <= 2, `size=${limiter.size} должен быть <= maxKeys`);
  // 'a' вытеснен -> снова доступен как новый ключ
  assert.equal(limiter.check('a').allowed, true);
  assert.ok(limiter.size <= 2);
  limiter.clear();
  assert.equal(limiter.size, 0);
});
