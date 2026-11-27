/** SFU E2EE: deterministic per-room keys, no key in JWT/audit, status/conflicts. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openWs, startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const SFU = { sfuUrl: 'wss://sfu.test', sfuApiKey: 'sfu-key', sfuApiSecret: 'sfu-secret', sfuEnabled: true };

async function sfuRoom(ts: TestServer, name = 'E2EE room'): Promise<string> {
  await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { scale: { mediaMode: 'sfu' }, security: { e2ee: true } },
  });
  const room = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name } });
  return room.body.room.id;
}

function decodePayload(token: string): string {
  const segment = token.split('.')[1] ?? '';
  return Buffer.from(segment, 'base64url').toString('utf8');
}

test('E2EE: same AES-GCM key for all participants of a room, different for another room', async () => {
  const ts = await startTestServer({ ...SFU, e2eeSecret: 'e2ee-test-secret' });
  try {
    const roomId = await sfuRoom(ts);
    const first = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'A' } });
    const second = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'B' } });
    const key1 = first.body.media?.e2ee;
    const key2 = second.body.media?.e2ee;
    assert.ok(key1, 'media.e2ee present');
    assert.equal(key1.algorithm, 'AES-GCM');
    assert.equal(key1.keyIndex, 0);
    assert.equal(key1.key, key2.key, 'all participants of a room get the same key');
    const bytes = Buffer.from(key1.key, 'base64url');
    assert.equal(bytes.length, 32, '32-byte key');
    assert.ok(!first.body.media.token.includes(key1.key), 'key is not inside the SFU JWT');
    assert.ok(!decodePayload(first.body.media.token).includes(key1.key));

    // WS welcome carries the same key.
    const client = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(first.body.token)}`);
    const welcome = await client.waitFor((message) => message.type === 'welcome');
    assert.equal(welcome.media?.e2ee?.key, key1.key);
    assert.equal(welcome.media?.e2ee?.algorithm, 'AES-GCM');
    await client.close();

    const otherRoom = await sfuRoom(ts, 'Other E2EE room');
    const other = await ts.api('POST', `/v1/rooms/${otherRoom}/join`, { body: { name: 'C' } });
    assert.ok(other.body.media.e2ee);
    assert.notEqual(other.body.media.e2ee.key, key1.key, 'different rooms → different keys');

    // Audit never stores the key.
    const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
    assert.ok(!JSON.stringify(audit.body).includes(key1.key), 'E2EE key is not written to audit');
    const status = await ts.api('GET', '/v1/admin/media/processing', { headers: ADMIN });
    assert.equal(status.body.e2eeConfigured, true);
    assert.equal(status.body.e2eeActive, true);
    assert.equal(status.body.e2eeConflict, false);
  } finally {
    await ts.close();
  }
});

test('E2EE: absent when security.e2ee=false or media mode is mesh', async () => {
  const ts = await startTestServer({ ...SFU, e2eeSecret: 'e2ee-test-secret' });
  try {
    await ts.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: { scale: { mediaMode: 'sfu' }, security: { e2ee: false } },
    });
    const room = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'No E2EE' } });
    const joined = await ts.api('POST', `/v1/rooms/${room.body.room.id}/join`, { body: { name: 'A' } });
    assert.ok(joined.body.media, 'SFU media still present');
    assert.equal(joined.body.media.e2ee, undefined);

    await ts.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: { scale: { mediaMode: 'mesh' }, security: { e2ee: true } },
    });
    const meshRoom = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Mesh E2EE' } });
    const meshJoin = await ts.api('POST', `/v1/rooms/${meshRoom.body.room.id}/join`, { body: { name: 'B' } });
    assert.equal(meshJoin.body.media, undefined, 'mesh has no SFU media block');
    const status = await ts.api('GET', '/v1/admin/media/processing', { headers: ADMIN });
    assert.equal(status.body.e2eeActive, false);
    assert.match(status.body.note, /E2EE включён в конфиге/i);
  } finally {
    await ts.close();
  }
});

test('E2EE: dev fallback to join secret is reported and warned', async () => {
  const ts = await startTestServer(SFU); // no AGIL_E2EE_SECRET
  try {
    const roomId = await sfuRoom(ts);
    const joined = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'A' } });
    assert.ok(joined.body.media.e2ee.key, 'fallback still yields a room key');
    const status = await ts.api('GET', '/v1/admin/media/processing', { headers: ADMIN });
    assert.equal(status.body.e2eeConfigured, false, 'explicit AGIL_E2EE_SECRET is missing');
    assert.equal(status.body.e2eeActive, true);
    assert.match(status.body.note, /AGIL_E2EE_SECRET не задан.*fallback/i);
  } finally {
    await ts.close();
  }
});

test('E2EE + egress/transcoding is misconfigured and warns (no egress worker)', async () => {
  const ts = await startTestServer({ ...SFU, e2eeSecret: 'e2ee-test-secret' });
  try {
    await sfuRoom(ts);
    const patched = await ts.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: {
        security: { e2ee: true },
        scale: { mediaMode: 'sfu' },
        mediaProcessing: { mode: 'server-assisted', egress: true, transcoding: true, provider: 'livekit-egress' },
      },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    const status = await ts.api('GET', '/v1/admin/media/processing', { headers: ADMIN });
    assert.equal(status.body.e2eeActive, true);
    assert.equal(status.body.e2eeConflict, true);
    assert.equal(status.body.misconfigured, true);
    assert.match(status.body.note, /E2EE конфликтует|не запускаются/i);
    const scale = await ts.api('GET', '/v1/admin/scale', { headers: ADMIN });
    assert.equal(scale.body.mediaProcessing.e2eeConfigured, true);
    assert.equal(scale.body.mediaProcessing.e2eeActive, true);
    assert.equal(scale.body.mediaProcessing.misconfigured, true);
  } finally {
    await ts.close();
  }
});
