import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { WebhookPayload } from '@agil/protocol';
import {
  signWebhookPayload,
  verifyWebhookSignature,
  buildWebhookHeaders,
  buildWebhookRequest,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '../src/webhooks.js';

const SECRET = 'whsec_test_secret';
const BODY = JSON.stringify({ hello: 'world' });

const payload: WebhookPayload = {
  id: 'delivery-1',
  type: 'room.created',
  ts: 1_700_000_000_000,
  tenantId: 'acme',
  roomId: 'room-1',
  data: { foo: 'bar' },
};

test('signWebhookPayload: hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)', () => {
  const timestamp = 1_700_000_000_000;
  const signature = signWebhookPayload(BODY, SECRET, timestamp);
  assert.match(signature, /^[0-9a-f]{64}$/);

  const expected = createHmac('sha256', SECRET).update(`${timestamp}.${BODY}`, 'utf8').digest('hex');
  assert.equal(signature, expected);

  assert.equal(signWebhookPayload(BODY, SECRET, timestamp), signature, 'детерминированная подпись');
  assert.notEqual(signWebhookPayload(BODY, SECRET, timestamp + 1), signature);
  assert.notEqual(signWebhookPayload(`${BODY} `, SECRET, timestamp), signature);
  assert.notEqual(signWebhookPayload(BODY, 'other-secret', timestamp), signature);
});

test('signWebhookPayload: пустой секрет -> Error (вебхук нельзя отправить неподписанным)', () => {
  assert.throws(() => signWebhookPayload(BODY, ''), /secret/);
  assert.throws(() => signWebhookPayload(BODY, undefined as unknown as string), /secret/);
});

test('verifyWebhookSignature: валидная подпись -> true; окно timestamp соблюдается', () => {
  const now = Date.now();
  const signature = signWebhookPayload(BODY, SECRET, now);
  assert.equal(verifyWebhookSignature(BODY, SECRET, signature, now), true);
  assert.equal(verifyWebhookSignature(BODY, SECRET, signature, String(now)), true);

  // В пределах допуска (по умолчанию 300 с).
  const recent = now - 60_000;
  assert.equal(verifyWebhookSignature(BODY, SECRET, signWebhookPayload(BODY, SECRET, recent), recent), true);

  // Истёкший / будущий timestamp.
  const old = now - 10 * 60 * 1000;
  assert.equal(verifyWebhookSignature(BODY, SECRET, signWebhookPayload(BODY, SECRET, old), old), false);
  const future = now + 10 * 60 * 1000;
  assert.equal(verifyWebhookSignature(BODY, SECRET, signWebhookPayload(BODY, SECRET, future), future), false);
});

test('verifyWebhookSignature: кастомный toleranceSec', () => {
  const now = Date.now();
  const tenSecondsAgo = now - 10_000;
  const signature = signWebhookPayload(BODY, SECRET, tenSecondsAgo);
  assert.equal(verifyWebhookSignature(BODY, SECRET, signature, tenSecondsAgo, 30), true);
  assert.equal(verifyWebhookSignature(BODY, SECRET, signature, tenSecondsAgo, 5), false);
});

test('verifyWebhookSignature: неправильное тело/секрет/подпись/malformed -> false, без исключений', () => {
  const now = Date.now();
  const signature = signWebhookPayload(BODY, SECRET, now);
  assert.equal(verifyWebhookSignature(`${BODY} `, SECRET, signature, now), false);
  assert.equal(verifyWebhookSignature(BODY, 'wrong-secret', signature, now), false);
  assert.equal(verifyWebhookSignature(BODY, SECRET, signature.toUpperCase(), now), true, 'hex case-insensitive');
  assert.equal(verifyWebhookSignature(BODY, SECRET, signature.slice(0, -2), now), false);
  assert.equal(verifyWebhookSignature(BODY, SECRET, 'not-a-hex-signature', now), false);
  assert.equal(verifyWebhookSignature(BODY, SECRET, '', now), false);
  assert.equal(verifyWebhookSignature(BODY, SECRET, signature, undefined), false);
  assert.equal(verifyWebhookSignature(BODY, SECRET, signature, 'not-a-timestamp'), false);
  assert.equal(verifyWebhookSignature(BODY, '', signature, now), false);
  assert.equal(verifyWebhookSignature(undefined as unknown as string, SECRET, signature, now), false);
});

test('buildWebhookHeaders: стандартные заголовки, подпись сходится с JSON.stringify(payload)', () => {
  const timestamp = Date.now();
  const headers = buildWebhookHeaders(payload, SECRET, timestamp);

  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers[WEBHOOK_DELIVERY_HEADER], payload.id);
  assert.equal(headers[WEBHOOK_EVENT_HEADER], payload.type);
  assert.equal(headers[WEBHOOK_TIMESTAMP_HEADER], String(timestamp));
  assert.match(headers[WEBHOOK_SIGNATURE_HEADER] as string, /^[0-9a-f]{64}$/);

  const rawBody = JSON.stringify(payload);
  assert.equal(
    verifyWebhookSignature(rawBody, SECRET, headers[WEBHOOK_SIGNATURE_HEADER] as string, headers[WEBHOOK_TIMESTAMP_HEADER]),
    true,
  );
});

test('buildWebhookRequest: body и headers берутся из одного места', () => {
  const timestamp = Date.now();
  const request = buildWebhookRequest(payload, SECRET, timestamp);
  assert.equal(request.body, JSON.stringify(payload));
  assert.equal(request.timestamp, timestamp);
  assert.deepEqual(request.headers, buildWebhookHeaders(payload, SECRET, timestamp));
  assert.equal(
    verifyWebhookSignature(request.body, SECRET, request.headers[WEBHOOK_SIGNATURE_HEADER] as string, request.timestamp),
    true,
  );
});
