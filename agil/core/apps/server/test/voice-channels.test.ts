import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openWs, startTestServer, type TestServer } from './helpers.js';

const base = '/v1/admin/voice-channels';
const demo = { 'x-api-key': 'dev-key' };
const acme = { 'x-api-key': 'acme-key' };
const alice = { participantId: 'staff-alice', name: 'Corporate Alice', role: 'moderator' };
const bob = { participantId: 'staff-bob', role: 'guest' };

async function grant(core: TestServer, channel: string, participantId: string, headers = demo) {
  const result = await core.api('POST', base + '/' + channel + '/join', { headers, body: { participantId } });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.body.channelId, channel);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  return result.body as { channelId: string; roomId: string; token: string; expiresAt: number };
}

test('voice channels reuse a private room while preserving tenant and roster authorization', async () => {
  const core = await startTestServer();
  try {
    const create = (id: string, headers = demo) => core.api('POST', base, {
      headers, body: { id, name: id + ' voice', members: [alice, bob] },
    });
    assert.equal((await create('general')).status, 201);
    assert.equal((await create('quiet')).status, 201);
    assert.equal((await create('general')).status, 409);
    assert.equal((await core.api('GET', base + '/general', { headers: acme })).status, 404);
    assert.deepEqual((await core.api('GET', base, { headers: acme })).body.channels, []);
    assert.equal((await create('general', acme)).status, 201);
    const [one, same, other] = await Promise.all([
      grant(core, 'general', alice.participantId),
      grant(core, 'general', bob.participantId),
      grant(core, 'general', alice.participantId, acme),
    ]);
    assert.equal(one.roomId, same.roomId);
    assert.notEqual(one.roomId, other.roomId);
    assert.equal(core.server.rooms.get(one.roomId)?.tenantId, 'demo');
    assert.equal(core.server.rooms.get(other.roomId)?.tenantId, 'acme');
    assert.equal((await core.api('POST', base + '/general/join', { body: { participantId: alice.participantId } })).status, 401);
    assert.equal((await core.api('POST', base + '/general/join', {
      headers: demo, body: { participantId: 'unknown' },
    })).status, 403);
    const second = await grant(core, 'quiet', alice.participantId);
    assert.notEqual(second.roomId, one.roomId);
    for (const token of [second.token, other.token, undefined]) {
      assert.equal((await core.api('POST', '/v1/rooms/' + one.roomId + '/join', { body: { token, participantId: alice.participantId } })).status, 403);
    }
    const joined = await core.api('POST', '/v1/rooms/' + one.roomId + '/join', {
      body: { token: one.token, participantId: bob.participantId, name: 'Alternative name' },
    });
    assert.equal(joined.status, 200, joined.text);
    assert.deepEqual(joined.body.participant, {
      id: alice.participantId, name: alice.name, role: 'moderator',
    });
    assert.equal((await core.api('POST', '/v1/tokens', {
      headers: demo, body: { tenantId: 'demo', roomId: one.roomId, participant: { name: 'Bob', participantId: bob.participantId, role: 'host' } },
    })).status, 403);
    const member = await openWs(core.wsUrl + '?token=' + encodeURIComponent(joined.body.token));
    await member.waitFor((event) => event.type === 'welcome');
    const renamed = await core.api('PATCH', base + '/general', { headers: demo, body: { name: 'New title' } });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal((await grant(core, 'general', alice.participantId)).roomId, one.roomId);
    assert.equal(core.server.rooms.get(one.roomId)?.name, 'New title');
    const reordered = await core.api('PATCH', base + '/general', { headers: demo, body: { members: [bob, alice] } });
    assert.equal(reordered.status, 200, reordered.text);
    assert.equal((await grant(core, 'general', alice.participantId)).roomId, one.roomId);
    const bye = member.waitFor((event) => event.type === 'bye');
    const updated = await core.api('PATCH', base + '/general', {
      headers: demo, body: { members: [{ ...alice, role: 'guest' }] },
    });
    assert.equal(updated.status, 200, updated.text);
    assert.equal((await bye).reason, 'admin_closed');
    assert.equal(core.server.rooms.get(one.roomId), undefined);
    assert.equal((await core.api('POST', '/v1/rooms/' + one.roomId + '/join', { body: { token: one.token } })).status, 404);
    assert.equal((await core.api('POST', base + '/general/join', { headers: demo, body: { participantId: bob.participantId } })).status, 403);
    const refreshed = await grant(core, 'general', alice.participantId);
    const rejoined = await core.api('POST', '/v1/rooms/' + refreshed.roomId + '/join', { body: { token: refreshed.token } });
    assert.equal(rejoined.status, 200, rejoined.text);
    assert.equal(rejoined.body.participant.role, 'guest');
    assert.equal(rejoined.body.participant.id, alice.participantId);
    assert.equal((await core.api('DELETE', base + '/general', { headers: demo })).status, 200);
    assert.equal((await core.api('GET', base + '/general', { headers: demo })).status, 404);
    assert.equal((await core.api('GET', base + '/general', { headers: acme })).status, 200);
    assert.equal(core.server.rooms.get(refreshed.roomId), undefined);
    assert.ok(core.server.rooms.get(other.roomId));
  } finally {
    await core.close();
  }
});

test('voice-channel roster persists even when Core discards old runtime rooms and grants', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'agil-voice-channels-'));
  let core = await startTestServer({ dataDir });
  try {
    const created = await core.api('POST', base, { headers: demo, body: { id: 'persistent', name: 'Persistent voice', members: [alice] } });
    assert.equal(created.status, 201, created.text);
    const before = await grant(core, 'persistent', alice.participantId);
    const client = await openWs(core.wsUrl + '?token=' + encodeURIComponent(before.token));
    await client.waitFor((event) => event.type === 'welcome');
    await core.server.continuity.flushAll();
    const room = core.server.rooms.get(before.roomId);
    assert.ok(room);
    assert.equal(core.server.continuity.snapshotRoom(room), null);
    await core.close();

    core = await startTestServer({ dataDir });
    const stored = await core.api('GET', base + '/persistent', { headers: demo });
    assert.deepEqual(stored.body.channel, created.body.channel);
    assert.equal(core.server.rooms.get(before.roomId), undefined);
    const next = await grant(core, 'persistent', alice.participantId);
    assert.notEqual(next.roomId, before.roomId);
    assert.equal((await core.api('POST', '/v1/rooms/' + next.roomId + '/join', { body: { token: before.token } })).status, 403);
    const joined = await core.api('POST', '/v1/rooms/' + next.roomId + '/join', { body: { token: next.token } });
    assert.equal(joined.status, 200, joined.text);
    assert.equal(joined.body.participant.id, alice.participantId);
    assert.equal(joined.body.participant.role, alice.role);
  } finally {
    await core.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
