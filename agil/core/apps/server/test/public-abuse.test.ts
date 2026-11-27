import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicAbuseGuard } from '../src/public-abuse.js';
import { openWs, startTestServer } from './helpers.js';

const admin = { 'x-api-key': 'dev-key' };
const configPath = '/v1/tenants/demo/config';

test('older organization configuration still imports and public limits are off by default', async (t) => {
  const app = await startTestServer({ publicAbuseDefaultMode: 'off' });
  t.after(() => app.close());
  const config = await app.api('GET', configPath, { headers: admin });
  assert.equal(config.status, 200);
  assert.equal(config.body.config.security.publicAbuseMode, undefined);
  assert.equal((await app.api('PUT', configPath, { headers: admin, body: config.body.config })).status, 200);
  const requests = await Promise.all(Array.from({ length: 6 }, () => app.api('POST', '/v1/rooms', { body: {} })));
  assert.ok(requests.every((result) => result.status === 200));
});

test('observe and enforce modes apply to public creation; company API keys retain access', async (t) => {
  const app = await startTestServer({ publicAbuseDefaultMode: 'observe' });
  t.after(() => app.close());
  const create = (body = {}, headers?: Record<string, string>) => app.api('POST', '/v1/rooms', { body, headers });
  const setMode = (publicAbuseMode: unknown) => app.api('PATCH', configPath, { headers: admin, body: { security: { publicAbuseMode } } });
  const observe = await Promise.all(Array.from({ length: 8 }, () => create()));
  assert.ok(observe.every((result) => result.status === 200));
  assert.equal((await setMode('invalid')).status, 400);
  assert.equal((await setMode('enforce')).status, 200);
  const enforce = await Promise.all(Array.from({ length: 8 }, () => create()));
  assert.equal(enforce.filter((result) => result.status === 200).length, 5);
  const blocked = enforce.filter((result) => result.status === 429);
  assert.equal(blocked.length, 3);
  for (const result of blocked) {
    assert.equal(result.body.error.code, 'rate_limited');
    assert.match(result.headers.get('retry-after') ?? '', /^\d+$/);
  }
  assert.equal((await create({}, { 'x-api-key': 'invalid' })).status, 401);
  assert.equal((await create({}, admin)).status, 200);
  assert.equal((await create({ tenantId: 'acme' })).status, 200);
  const audit = await app.api('GET', '/v1/admin/audit?type=public_abuse.threshold', { headers: admin });
  const entries = audit.body.entries.filter((entry: { type: string }) => entry.type === 'public_abuse.threshold');
  assert.deepEqual(entries.map((entry: { details: { mode: string } }) => entry.details.mode).sort(), ['enforce', 'observe']);
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry.details).sort(), ['action', 'mode', 'scope']);
    assert.equal(entry.ipHash, undefined);
  }
  assert.equal((await setMode(null)).body.config.security.publicAbuseMode, null);
  assert.equal((await create()).status, 200);
});

test('organization budget groups distinct clients and keeps a separate join budget', () => {
  const guard = createPublicAbuseGuard();
  const create = (ipHash: string, tenantId = 'demo') => guard.check({ tenantId, ipHash, action: 'room.create', mode: 'enforce' });
  for (let i = 0; i < 100; i += 1) assert.ok(create(`source-${i}`).allowed);
  assert.equal(create('source-100').threshold?.scope, 'organization');
  assert.ok(guard.check({ tenantId: 'demo', ipHash: 'source-100', action: 'room.join', mode: 'enforce' }).allowed);
  assert.ok(create('source-100', 'another-org').allowed);
});

test('anonymous REST and WebSocket joins share the organization source budget; invitations still work', async (t) => {
  const app = await startTestServer({ publicAbuseDefaultMode: 'enforce' });
  t.after(() => app.close());
  const first = await app.api('POST', '/v1/rooms', { headers: admin, body: {} });
  const second = await app.api('POST', '/v1/rooms', { headers: admin, body: {} });
  const join = (roomId: string, body: Record<string, unknown> = {}) => app.api('POST', `/v1/rooms/${roomId}/join`, { body });
  const legacyWs = (roomId: string) => openWs(`${app.wsUrl}?room=${roomId}`, undefined, { origin: 'http://127.0.0.1:1' });
  const guest = await legacyWs(first.body.room.id);
  assert.equal((await guest.waitFor((message) => message.type === 'welcome')).type, 'welcome');
  await guest.close();
  for (let count = 0; count < 119; count += 1) {
    assert.equal((await join(count < 60 ? first.body.room.id : second.body.room.id)).status, 200);
  }
  assert.equal((await join(second.body.room.id)).status, 429);
  const restrictedGuest = await legacyWs(second.body.room.id);
  assert.equal((await restrictedGuest.waitFor((message) => message.type === 'error')).code, 'rate_limited');
  await restrictedGuest.close();
  assert.equal((await join(second.body.room.id, { token: second.body.token })).status, 200);
  const invited = await openWs(`${app.wsUrl}?token=${encodeURIComponent(second.body.token)}`);
  assert.equal((await invited.waitFor((message) => message.type === 'welcome')).type, 'welcome');
  await invited.close();
});
