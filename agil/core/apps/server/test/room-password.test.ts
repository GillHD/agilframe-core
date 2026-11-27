/** Admin room password API: set / generate once / remove, scrypt storage, audit. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
let ts: TestServer;

before(async () => {
  ts = await startTestServer();
});

after(async () => {
  await ts.close();
});

async function createRoom(password?: string): Promise<string> {
  const created = await ts.api('POST', '/v1/admin/rooms', {
    headers: ADMIN,
    body: { name: `Password room ${Date.now()}`, ...(password ? { password } : {}) },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return created.body.room.id;
}

test('room password: set, change, generated once, remove; hash never leaked', async () => {
  const roomId = await createRoom('initial-secret');

  const detail = await ts.api('GET', `/v1/admin/rooms/${roomId}`, { headers: ADMIN });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.passwordProtected, true);

  const wrong = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'A', password: 'nope' } });
  assert.equal(wrong.status, 401);
  const correct = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'A', password: 'initial-secret' } });
  assert.equal(correct.status, 200);

  // Change the password (explicit value is not echoed back).
  const changed = await ts.api('POST', `/v1/admin/rooms/${roomId}/password`, {
    headers: ADMIN,
    body: { password: 'rotated-secret-1' },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.updated, true);
  assert.equal(changed.body.generated, false);
  assert.equal(changed.body.password, undefined);
  assert.equal((await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'A', password: 'initial-secret' } })).status, 401);
  assert.equal((await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'A', password: 'rotated-secret-1' } })).status, 200);

  // Generate a password when the body omits it; it is returned exactly once.
  const generated = await ts.api('POST', `/v1/admin/rooms/${roomId}/password`, { headers: ADMIN, body: {} });
  assert.equal(generated.status, 200);
  assert.equal(generated.body.updated, true);
  assert.equal(generated.body.generated, true);
  assert.equal(typeof generated.body.password, 'string');
  assert.ok(generated.body.password.length >= 12, `generated password length: ${generated.body.password?.length}`);
  assert.equal((await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'B', password: generated.body.password } })).status, 200);

  // The plaintext password and the scrypt hash are never exposed by GET/list.
  const detail2 = await ts.api('GET', `/v1/admin/rooms/${roomId}`, { headers: ADMIN });
  const list = await ts.api('GET', '/v1/admin/rooms', { headers: ADMIN });
  const detailText = JSON.stringify(detail2.body);
  const listText = JSON.stringify(list.body);
  assert.ok(!detailText.includes('passwordHash'), 'room detail must not expose the hash');
  assert.ok(!listText.includes('passwordHash'), 'room list must not expose the hash');
  assert.ok(!detailText.includes(generated.body.password), 'room detail must not expose the plaintext');
  assert.ok(!listText.includes(generated.body.password), 'room list must not expose the plaintext');

  // Remove the password: joins no longer require one.
  const removed = await ts.api('DELETE', `/v1/admin/rooms/${roomId}/password`, { headers: ADMIN });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.updated, true);
  assert.equal(removed.body.passwordProtected, false);
  assert.equal((await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'C' } })).status, 200);
  assert.equal((await ts.api('GET', `/v1/admin/rooms/${roomId}`, { headers: ADMIN })).body.passwordProtected, false);

  // Empty string behaves like "generate".
  const emptyGenerated = await ts.api('POST', `/v1/admin/rooms/${roomId}/password`, { headers: ADMIN, body: { password: '' } });
  assert.equal(emptyGenerated.status, 200);
  assert.equal(emptyGenerated.body.generated, true);
  assert.equal(typeof emptyGenerated.body.password, 'string');

  // Removing an already public room is idempotent.
  const removedAgain = await ts.api('DELETE', `/v1/admin/rooms/${roomId}/password`, { headers: ADMIN });
  assert.equal(removedAgain.status, 200);
  assert.equal(removedAgain.body.removed, true);
});

test('room password: validation, auth and 404s', async () => {
  await ts.api('DELETE', '/v1/admin/rooms/00000000-0000-4000-8000-000000000000/password', { headers: ADMIN }).then((response) => {
    assert.equal(response.status, 404);
  });
  await ts.api('POST', '/v1/admin/rooms/00000000-0000-4000-8000-000000000000/password', { headers: ADMIN, body: {} }).then((response) => {
    assert.equal(response.status, 404);
  });

  const roomId = await createRoom();
  const unauthorized = await ts.api('POST', `/v1/admin/rooms/${roomId}/password`, { body: { password: 'x' } });
  assert.equal(unauthorized.status, 401);
  const tooLong = await ts.api('POST', `/v1/admin/rooms/${roomId}/password`, { headers: ADMIN, body: { password: 'x'.repeat(201) } });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error.code, 'validation_failed');
  const wrongType = await ts.api('POST', `/v1/admin/rooms/${roomId}/password`, { headers: ADMIN, body: { password: 123 } });
  assert.equal(wrongType.status, 400);

  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
  const passwordEntries = audit.body.entries.filter(
    (entry: { details?: { kind?: string } }) => entry.details?.kind === 'room.password.changed',
  );
  assert.ok(passwordEntries.length >= 3, 'set/generated/removed are audited');
  const auditText = JSON.stringify(audit.body);
  assert.ok(!auditText.includes('rotated-secret-1'), 'the audit log never stores plaintext passwords');
});
