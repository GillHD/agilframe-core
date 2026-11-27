/**
 * Explicit P2P transport for direct (1:1) rooms (docs/p2p.md).
 *
 * The server is configured for SFU here on purpose: `transport:'p2p'` must force
 * the mesh plane even when the tenant default is SFU, and `transport:'sfu'` must
 * keep the current SFU behaviour. P2P never gets a LiveKit media block.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openWs, startTestServer, type TestServer, type WsClient } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const SFU = { sfuUrl: 'wss://sfu.test', sfuApiKey: 'sfu-key-123', sfuApiSecret: 'sfu-secret-456', sfuEnabled: true };
let ts: TestServer;

before(async () => {
  ts = await startTestServer(SFU);
  await ts.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { scale: { mediaMode: 'sfu' } } });
});

after(async () => {
  await ts.close();
});

test('public API: transport p2p creates a direct mesh room with exactly 2 seats', async () => {
  const created = await ts.api('POST', '/v1/rooms', {
    body: { tenantId: 'demo', name: 'P2P direct', mode: 'direct', transport: 'p2p' },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.room.mode, 'direct');
  assert.equal(created.body.room.mediaMode, 'mesh', 'p2p overrides an SFU tenant default');
  assert.equal(created.body.room.maxParticipants, 2);

  const roomId = created.body.room.id;
  // A REST join only issues a token; the seat is taken when the WS joins.
  const seated: WsClient[] = [];
  for (const name of ['One', 'Two']) {
    const joined = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name } });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.media, undefined, 'p2p join has no server media session');
    const socket = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(joined.body.token)}`);
    const welcome = await socket.waitFor((message) => message.type === 'welcome');
    assert.equal(welcome.media, undefined, 'p2p welcome has no SFU media block');
    seated.push(socket);
  }

  const third = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'Three' } });
  assert.equal(third.status, 409, 'a third participant is rejected');
  assert.equal(third.body.error.code, 'room_full');
  assert.match(third.body.error.message, /full|2/i);
  await Promise.all(seated.map((socket) => socket.close()));
});

test('admin API: transport p2p also creates mesh/2 for a direct room', async () => {
  const created = await ts.api('POST', '/v1/admin/rooms', {
    headers: ADMIN,
    body: { name: 'P2P admin', mode: 'direct', transport: 'p2p', maxParticipants: 2 },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.room.mode, 'direct');
  assert.equal(created.body.room.mediaMode, 'mesh');
  assert.equal(created.body.room.maxParticipants, 2);
});

test('transport sfu (and omission) keep the current direct-room media plane', async () => {
  const explicit = await ts.api('POST', '/v1/rooms', {
    body: { tenantId: 'demo', name: 'SFU direct', mode: 'direct', transport: 'sfu' },
  });
  assert.equal(explicit.status, 200);
  assert.equal(explicit.body.room.mediaMode, 'sfu');
  assert.equal(explicit.body.room.maxParticipants, 2);

  const omitted = await ts.api('POST', '/v1/rooms', {
    body: { tenantId: 'demo', name: 'Implicit direct', mode: 'direct' },
  });
  assert.equal(omitted.status, 200);
  assert.equal(omitted.body.room.mediaMode, 'sfu', 'omitted transport keeps the previous behaviour');
  assert.equal(omitted.body.room.maxParticipants, 2);
});

test('p2p is rejected for group rooms (public and admin)', async () => {
  const publicRoom = await ts.api('POST', '/v1/rooms', {
    body: { tenantId: 'demo', name: 'Group p2p', mode: 'group', transport: 'p2p' },
  });
  assert.equal(publicRoom.status, 400);
  assert.equal(publicRoom.body.error.code, 'validation_failed');
  assert.match(publicRoom.body.error.message, /direct/i);

  const adminRoom = await ts.api('POST', '/v1/admin/rooms', {
    headers: ADMIN,
    body: { name: 'Group p2p admin', transport: 'p2p' },
  });
  assert.equal(adminRoom.status, 400);
  assert.equal(adminRoom.body.error.code, 'validation_failed');

  const groupSfu = await ts.api('POST', '/v1/rooms', {
    body: { tenantId: 'demo', name: 'Group sfu transport', mode: 'group', transport: 'sfu' },
  });
  assert.equal(groupSfu.status, 400, 'transport is direct-only for every value');
  assert.equal(groupSfu.body.error.code, 'validation_failed');
});

test('p2p with more than 2 seats is rejected, not silently clamped', async () => {
  const created = await ts.api('POST', '/v1/rooms', {
    body: { tenantId: 'demo', name: 'P2P too many', mode: 'direct', transport: 'p2p', maxParticipants: 3 },
  });
  assert.equal(created.status, 400);
  assert.equal(created.body.error.code, 'validation_failed');
  assert.match(created.body.error.message, /2 seats/i);
});

test('p2p with server egress is a clear 409 p2p_unsupported', async () => {
  await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { mediaProcessing: { egress: true } },
  });
  try {
    const created = await ts.api('POST', '/v1/rooms', {
      body: { tenantId: 'demo', name: 'P2P egress', mode: 'direct', transport: 'p2p' },
    });
    assert.equal(created.status, 409);
    assert.equal(created.body.error.code, 'p2p_unsupported');
    assert.equal(created.body.error.details.feature, 'egress');
    assert.match(created.body.error.message, /egress/i);
    assert.match(created.body.error.message, /transport:'sfu'/);
  } finally {
    await ts.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: { mediaProcessing: { egress: false } },
    });
  }
});

test('p2p with egress requested through configOverrides is also rejected', async () => {
  const created = await ts.api('POST', '/v1/rooms', {
    body: {
      tenantId: 'demo',
      name: 'P2P override egress',
      mode: 'direct',
      transport: 'p2p',
      configOverrides: { mediaProcessing: { egress: true } },
    },
  });
  assert.equal(created.status, 409);
  assert.equal(created.body.error.code, 'p2p_unsupported');
  assert.equal(created.body.error.details.feature, 'egress');
});

test('p2p with server-side streaming is also rejected before room creation', async () => {
  const created = await ts.api('POST', '/v1/rooms', {
    body: {
      tenantId: 'demo',
      name: 'P2P stream',
      mode: 'direct',
      transport: 'p2p',
      configOverrides: { scale: { streaming: { enabled: true } } },
    },
  });
  assert.equal(created.status, 409);
  assert.equal(created.body.error.code, 'p2p_unsupported');
  assert.equal(created.body.error.details.feature, 'streaming');
});

test('local client-side recording stays allowed in a p2p room', async () => {
  const created = await ts.api('POST', '/v1/rooms', {
    body: {
      tenantId: 'demo',
      name: 'P2P local recording',
      mode: 'direct',
      transport: 'p2p',
      configOverrides: { features: { recording: true } },
    },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.room.mediaMode, 'mesh');
});
