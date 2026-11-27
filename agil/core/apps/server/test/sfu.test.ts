/** SFU media sessions: HS256 tokens in join/welcome, webinar viewers, mesh fallback. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { loadEnv } from '../src/env.js';
import { closeSfuRoom, removeSfuParticipant } from '../src/sfu.js';
import { openWs, startTestServer, type TestServer } from './helpers.js';

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

function decode(token: string): { header: Record<string, unknown>; claims: Record<string, any>; signature: string; signed: string } {
  const [header, claims, signature] = token.split('.');
  assert.ok(header && claims && signature);
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')),
    signature: signature!,
    signed: `${header}.${claims}`,
  };
}

function verify(token: string, secret = SFU.sfuApiSecret): boolean {
  const parsed = decode(token);
  const expected = createHmac('sha256', secret).update(parsed.signed).digest('base64url');
  return expected === parsed.signature;
}

test('RoomService uses the private Core endpoint when configured and preserves the legacy fallback', async () => {
  const requests: Array<{ path: string | undefined; authorization: string | undefined }> = [];
  const control = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  try {
    const address = control.address();
    assert.ok(address && typeof address !== 'string');
    const privateUrl = `http://127.0.0.1:${address.port}`;
    const env = { ...loadEnv(), ...SFU, sfuControlUrl: privateUrl };
    assert.equal(await removeSfuParticipant(env, 'demo', 'room', 'speaker'), true);
    assert.equal(await closeSfuRoom({ ...env, sfuControlUrl: '', sfuUrl: privateUrl }, 'demo', 'room'), true);
    assert.deepEqual(requests.map(({ path }) => path), [
      '/twirp/livekit.RoomService/RemoveParticipant',
      '/twirp/livekit.RoomService/DeleteRoom',
    ]);
    const token = requests[0]?.authorization?.replace(/^Bearer /, '');
    assert.ok(token && verify(token));
    assert.deepEqual(decode(token).claims.video, { roomAdmin: true, room: 'demo__room' });
  } finally {
    await new Promise<void>((resolve, reject) => control.close((error) => error ? reject(error) : resolve()));
  }
});

test('Core validates the configured SFU URL map without exposing malformed input', () => {
  const previous = process.env.AGIL_SFU_NODE_URLS;
  try {
    process.env.AGIL_SFU_NODE_URLS = '{"demo":{"sfu-a":"wss://sfu.example.test/rtc"}}';
    assert.equal(loadEnv().sfuNodeUrls.get('demo')?.get('sfu-a'), 'wss://sfu.example.test/rtc');
    for (const address of ['https://sfu.example.test', 'wss://operator:secret@sfu.example.test', 'wss://sfu.example.test?token=test']) {
      process.env.AGIL_SFU_NODE_URLS = JSON.stringify({ demo: { 'sfu-a': address } });
      assert.throws(() => loadEnv(), { message: /^AGIL_SFU_NODE_URLS must map tenant IDs/ });
    }
  } finally {
    if (previous === undefined) delete process.env.AGIL_SFU_NODE_URLS;
    else process.env.AGIL_SFU_NODE_URLS = previous;
  }
});

test('a registered node cannot replace tenant-configured SFU endpoints in join and welcome', async () => {
  const endpoint = 'wss://trusted-sfu.test/';
  const routed = await startTestServer({ ...SFU, sfuNodeUrls: new Map([['demo', new Map([['sfu-a', endpoint]])]]) });
  try {
    for (const [tenant, headers] of [['demo', ADMIN], ['acme', { 'x-api-key': 'acme-key' }]] as const) {
      assert.equal((await routed.api('PATCH', `/v1/tenants/${tenant}/config`, { headers,
        body: { scale: { mediaMode: 'sfu' } } })).status, 200);
      const issued = await routed.api('POST', '/v1/admin/cluster/tokens', {
        headers, body: { kind: 'node', role: 'sfu' },
      });
      const enrolled = await routed.api('POST', '/v1/nodes/register', {
        body: { token: issued.body.token, nodeId: 'sfu-a', role: 'sfu', endpoint: 'wss://registry.test' },
      });
      assert.equal(enrolled.status, 201);
      const heartbeat = await routed.api('POST', '/v1/nodes/sfu-a/heartbeat', {
        headers: { 'x-node-token': enrolled.body.nodeKey }, body: { sfuReady: true },
      });
      assert.equal(heartbeat.status, 200);
      const createRoom = () => routed.api('POST', '/v1/admin/rooms', { headers, body: { name: 'Node routing' } });
      const room = await createRoom();
      const join = (roomId: string) => routed.api('POST', `/v1/rooms/${roomId}/join?tenant=${tenant}`, { body: { name: 'Viewer' } });
      const joined = await join(room.body.room.id);
      assert.equal(joined.status, 200);
      const expected = tenant === 'demo' ? endpoint : SFU.sfuUrl;
      assert.equal(joined.body.media.url, expected);
      assert.equal(joined.body.media.fallbackUrl, tenant === 'demo' ? `${SFU.sfuUrl}/` : undefined);
      const socket = await openWs(`${routed.wsUrl}?token=${encodeURIComponent(joined.body.token)}`);
      try {
        const welcome = await socket.waitFor((message) => message.type === 'welcome');
        assert.equal(welcome.media.url, expected);
        assert.equal(welcome.media.fallbackUrl, joined.body.media.fallbackUrl);
        socket.send({ type: 'ping', ts: 101 });
        assert.equal((await socket.waitFor((message) => message.type === 'pong' && message.ts === 101)).sfuMedia, undefined);
        socket.send({ type: 'ping', ts: 102, refreshSfu: true });
        const refreshed = (await socket.waitFor((message) => message.type === 'pong' && message.ts === 102)).sfuMedia;
        assert.equal(refreshed.room, welcome.media.room);
        assert.equal(refreshed.url, expected);
        assert.equal(decode(refreshed.token).claims.sub, joined.body.participant.id);
        assert.ok(verify(refreshed.token));
      } finally {
        socket.close();
      }
      const setDrain = (drain: boolean) => routed.api('POST', '/v1/admin/nodes/sfu-a/drain', { headers, body: { drain } });
      const drain = await setDrain(true);
      assert.equal(drain.status, 200);
      assert.equal((await join(room.body.room.id)).body.media.url, expected);
      const fallback = await createRoom();
      assert.equal((await join(fallback.body.room.id)).body.media.url, SFU.sfuUrl);
      const undrain = await setDrain(false);
      assert.equal(undrain.status, 200);
      assert.equal(undrain.body.node.sfuReady, false, 'a readiness report before maintenance cannot reopen direct ingress');
      const waiting = await createRoom();
      assert.equal((await join(waiting.body.room.id)).body.media.url, SFU.sfuUrl);
      assert.equal((await join(room.body.room.id)).body.media.url, expected);

      // A fresh readiness report during maintenance can be used immediately
      // after removal of the drain marker, including after an idempotent retry.
      assert.equal((await setDrain(true)).status, 200);
      assert.equal((await routed.api('POST', '/v1/nodes/sfu-a/heartbeat', {
        headers: { 'x-node-token': enrolled.body.nodeKey }, body: { sfuReady: true },
      })).status, 200);
      assert.equal((await setDrain(true)).status, 200);
      const restored = await setDrain(false);
      assert.equal(restored.status, 200);
      assert.equal(restored.body.node.sfuReady, true);
      const recovered = await createRoom();
      assert.equal((await join(recovered.body.room.id)).body.media.url, expected);
      assert.equal((await join(waiting.body.room.id)).body.media.url, SFU.sfuUrl, 'fallback room retains its original assignment');
    }
  } finally {
    await routed.close();
  }
});

test('a mapped SFU pin respects readiness and drain for new rooms', async () => {
  const preferred = 'wss://sfu-preferred.test/';
  const alternate = 'wss://sfu-alternate.test/';
  const routed = await startTestServer({
    ...SFU, sfuNodeId: 'sfu-preferred',
    sfuNodeUrls: new Map([['demo', new Map([['sfu-preferred', preferred], ['sfu-alternate', alternate]])]]),
  });
  try {
    assert.equal((await routed.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN, body: { scale: { mediaMode: 'sfu' } },
    })).status, 200);
    const enroll = async (nodeId: string) => {
      const issued = await routed.api('POST', '/v1/admin/cluster/tokens', {
        headers: ADMIN, body: { kind: 'node', role: 'sfu' },
      });
      assert.equal(issued.status, 201);
      const enrolled = await routed.api('POST', '/v1/nodes/register', {
        body: { token: issued.body.token, nodeId, role: 'sfu' },
      });
      assert.equal(enrolled.status, 201);
      return enrolled.body.nodeKey;
    };
    const beat = (nodeId: string, nodeKey: string) => routed.api('POST', `/v1/nodes/${nodeId}/heartbeat`, {
      headers: { 'x-node-token': nodeKey }, body: { sfuReady: true },
    });
    const join = (roomId: string) => routed.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'QA participant' } });
    const checkNewRoom = async (url: string) => {
      const created = await routed.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'SFU maintenance QA' } });
      assert.equal(created.status, 200);
      const roomId = created.body.room.id;
      const joined = await join(roomId);
      assert.equal(joined.status, 200);
      assert.equal(joined.body.media.url, url);
      return roomId;
    };
    await checkNewRoom(SFU.sfuUrl);
    const alternateKey = await enroll('sfu-alternate');
    assert.equal((await beat('sfu-alternate', alternateKey)).status, 200);
    const preferredKey = await enroll('sfu-preferred');
    await checkNewRoom(alternate);
    assert.equal((await beat('sfu-preferred', preferredKey)).status, 200);
    const active = await checkNewRoom(preferred);
    const setDrain = (drain: boolean) => routed.api('POST', '/v1/admin/nodes/sfu-preferred/drain', {
      headers: ADMIN, body: { drain },
    });
    const existing = await join(active);
    const socket = await openWs(`${routed.wsUrl}?token=${encodeURIComponent(existing.body.token)}`);
    try {
      assert.equal((await socket.waitFor((message) => message.type === 'welcome')).media.url, preferred);
      assert.equal((await setDrain(true)).status, 200);
      const duringDrain = await checkNewRoom(alternate);
      const newcomer = await join(duringDrain);
      const newSocket = await openWs(`${routed.wsUrl}?token=${encodeURIComponent(newcomer.body.token)}`);
      try {
        assert.equal((await newSocket.waitFor((message) => message.type === 'welcome')).media.url, alternate);
      } finally {
        newSocket.close();
      }
      assert.equal((await join(active)).body.media.url, preferred);
      socket.send({ type: 'ping', ts: 401, refreshSfu: true });
      assert.equal((await socket.waitFor((message) => message.type === 'pong' && message.ts === 401)).sfuMedia.url, preferred);
      assert.equal((await setDrain(false)).status, 200);
      await checkNewRoom(alternate);
      assert.equal((await beat('sfu-preferred', preferredKey)).status, 200);
      await checkNewRoom(preferred);
    } finally {
      socket.close();
    }
  } finally {
    await routed.close();
  }
});

test('SFU join/welcome media: valid HS256 token, claims, room, TTL cap, canPublish', async () => {
  const room = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'SFU room' } });
  const roomId = room.body.room.id;
  assert.equal(room.body.room.mediaMode, 'sfu', 'RoomInfo.mediaMode reflects the effective mode');
  const joined = await ts.api('POST', `/v1/rooms/${roomId}/join`, {
    headers: { authorization: 'Bearer ' },
    body: { name: 'SFU guest' },
  });
  assert.equal(joined.status, 200);
  const media = joined.body.media;
  assert.ok(media, 'media block present');
  assert.equal(media.mode, 'sfu');
  assert.equal(media.url, 'wss://sfu.test');
  assert.equal(media.room, `demo__${roomId}`);
  assert.equal(media.canPublish, true, 'guests publish in MVP (not a webinar)');
  assert.ok(verify(media.token));
  const { header, claims } = decode(media.token);
  assert.equal(header.alg, 'HS256');
  assert.equal(claims.iss, 'sfu-key-123');
  assert.equal(claims.sub, joined.body.participant.id);
  assert.equal(claims.name, 'SFU guest');
  assert.equal(claims.video.room, `demo__${roomId}`);
  assert.equal(claims.video.roomJoin, true);
  assert.equal(claims.video.canPublish, true);
  assert.equal(claims.video.canSubscribe, true);
  assert.ok(claims.exp > claims.nbf);
  assert.ok(claims.exp - claims.nbf <= 3600, 'session TTL is capped at 1h');
  assert.ok(claims.exp - claims.nbf >= 3000);
  assert.equal(media.expiresAt, claims.exp * 1000);
  // A forged secret must not verify.
  assert.equal(verify(media.token, 'wrong-secret'), false);

  // WS welcome carries the same media block.
  const welcomeClient = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(joined.body.token)}`);
  const welcome = await welcomeClient.waitFor((message) => message.type === 'welcome');
  assert.ok(welcome.media, 'welcome.media present');
  assert.equal(welcome.media.room, `demo__${roomId}`);
  assert.ok(verify(welcome.media.token));
  const welcomeClaims = decode(welcome.media.token).claims;
  assert.equal(welcomeClaims.video.canPublish, true);
  await welcomeClient.close();

  const scale = await ts.api('GET', '/v1/admin/scale', { headers: ADMIN });
  assert.equal(scale.body.sfuConfigured, true, 'scale status reflects real SFU readiness');
});

test('SFU webinar: guest is receive-only, host can publish', async () => {
  await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { scale: { mediaMode: 'sfu', webinar: { enabled: true, hostOnlyPublish: true } } },
  });
  const room = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Webinar room' } });
  const roomId = room.body.room.id;
  assert.equal(room.body.room.mediaMode, 'broadcast');
  const guest = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'Viewer' } });
  assert.ok(guest.body.media);
  assert.equal(guest.body.media.canPublish, false, 'webinar viewer cannot publish');
  assert.equal(decode(guest.body.media.token).claims.video.canPublish, false);
  const viewer = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(guest.body.token)}`);
  try {
    await viewer.waitFor((message) => message.type === 'welcome');
    viewer.send({ type: 'ping', ts: 103, refreshSfu: true });
    const refreshed = (await viewer.waitFor((message) => message.type === 'pong' && message.ts === 103)).sfuMedia;
    assert.equal(refreshed.canPublish, false);
    assert.equal(decode(refreshed.token).claims.video.canPublish, false);
  } finally {
    viewer.close();
  }

  const hostToken = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Speaker', role: 'host' } },
  });
  const hostJoin = await ts.api('POST', `/v1/rooms/${roomId}/join`, {
    headers: { authorization: `Bearer ${hostToken.body.token}` },
    body: { name: 'Speaker' },
  });
  assert.equal(hostJoin.body.participant.role, 'host');
  assert.equal(hostJoin.body.media.canPublish, true);

  await ts.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { scale: { webinar: { enabled: false } } } });
});

test('mesh rooms have no media block; SFU disabled falls back to mesh', async () => {
  const mesh = await startTestServer();
  try {
    const room = await mesh.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Mesh room' } });
    const joined = await mesh.api('POST', `/v1/rooms/${room.body.room.id}/join`, { body: { name: 'Mesh guest' } });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.media, undefined);
    const meshSocket = await openWs(`${mesh.wsUrl}?token=${encodeURIComponent(joined.body.token)}`);
    try {
      await meshSocket.waitFor((message) => message.type === 'welcome');
      meshSocket.send({ type: 'ping', ts: 104, refreshSfu: true });
      assert.equal((await meshSocket.waitFor((message) => message.type === 'pong' && message.ts === 104)).sfuMedia, null);
    } finally {
      meshSocket.close();
    }
    assert.equal((await mesh.api('GET', '/v1/admin/scale', { headers: ADMIN })).body.sfuConfigured, false);
  } finally {
    await mesh.close();
  }

  const disabled = await startTestServer({ ...SFU, sfuEnabled: false });
  try {
    await disabled.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { scale: { mediaMode: 'sfu' } } });
    const room = await disabled.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Disabled SFU' } });
    const joined = await disabled.api('POST', `/v1/rooms/${room.body.room.id}/join`, { body: { name: 'Guest' } });
    assert.equal(joined.body.media, undefined, 'disabled SFU → mesh fallback without media');
    assert.equal((await disabled.api('GET', '/v1/admin/scale', { headers: ADMIN })).body.sfuConfigured, false);
  } finally {
    await disabled.close();
  }
});

test('SFU capacity caps room seats and join tokens (no fake 200-seat promise)', async () => {
  await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { scale: { mediaMode: 'sfu', sfu: { maxParticipants: 200, capacityProfile: 'high' } } },
  });
  const room = await ts.api('POST', '/v1/admin/rooms', {
    headers: ADMIN,
    body: { name: 'Capped by SFU', maxParticipants: 500 },
  });
  assert.equal(room.status, 200);
  assert.equal(room.body.room.maxParticipants, 200, 'room limit is min(requested, high profile, sfu.maxParticipants)');
  assert.equal(room.body.room.mediaMode, 'sfu');

  // Lower the SFU cap to 2 and verify both REST join and WS handshake stop at 2.
  await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { scale: { sfu: { maxParticipants: 2 } } },
  });
  const tiny = await ts.api('POST', '/v1/admin/rooms', {
    headers: ADMIN,
    body: { name: 'Two SFU seats', maxParticipants: 5 },
  });
  assert.equal(tiny.body.room.maxParticipants, 2);
  const tinyId = tiny.body.room.id;
  const tokens: string[] = [];
  for (const name of ['A', 'B']) {
    const issued = await ts.api('POST', '/v1/tokens', {
      headers: ADMIN,
      body: { tenantId: 'demo', roomId: tinyId, participant: { name } },
    });
    tokens.push(issued.body.token);
  }
  const clients = [];
  for (const token of tokens) {
    const client = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(token)}`);
    await client.waitFor((message) => message.type === 'welcome');
    clients.push(client);
  }
  const third = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId: tinyId, participant: { name: 'C' } },
  });
  const rejected = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(third.body.token)}`);
  const error = await rejected.waitFor((message) => message.type === 'error');
  assert.equal(error.code, 'room_full', 'SFU capacity is enforced on the WS handshake');
  await rejected.close();
  for (const client of clients) await client.close();

  await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { scale: { sfu: { maxParticipants: 5000, capacityProfile: 'standard' } } },
  });
});

test('SFU token TTL is capped at 1 hour even with a longer room token TTL', async () => {
  const long = await startTestServer({ ...SFU, tokenTtlSec: 7200 });
  try {
    await long.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { scale: { mediaMode: 'sfu' } } });
    const room = await long.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'TTL SFU' } });
    const joined = await long.api('POST', `/v1/rooms/${room.body.room.id}/join`, { body: { name: 'Guest' } });
    const { claims } = decode(joined.body.media.token);
    assert.ok(claims.exp - claims.nbf <= 3600);
    assert.ok(claims.exp - claims.nbf >= 3500);
  } finally {
    await long.close();
  }
});

test('REST join and lobby admit enforce SFU capacity (room_full)', async () => {
  await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { scale: { mediaMode: 'sfu', sfu: { maxParticipants: 2 } } },
  });
  try {
    // REST join: a room already full on the media plane rejects the next guest
    // before a token is issued. Tokens are issued per participant because a
    // REST join response does not itself occupy a seat.
    const room = await ts.api('POST', '/v1/admin/rooms', {
      headers: ADMIN,
      body: { name: 'REST capacity', maxParticipants: 5 },
    });
    const roomId = room.body.room.id;
    assert.equal(room.body.room.maxParticipants, 2);
    const clients = [];
    for (const name of ['A', 'B']) {
      const issued = await ts.api('POST', '/v1/tokens', {
        headers: ADMIN,
        body: { tenantId: 'demo', roomId, participant: { name } },
      });
      const client = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(issued.body.token)}`);
      await client.waitFor((message) => message.type === 'welcome');
      clients.push(client);
    }
    const third = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'C' } });
    assert.equal(third.status, 409);
    assert.equal(third.body.error.code, 'room_full');
    for (const client of clients) await client.close();

    // Lobby admit: the room fills while the guest is pending.
    await ts.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: { security: { waitingRoom: true } },
    });
    const lobbyRoom = await ts.api('POST', '/v1/admin/rooms', {
      headers: ADMIN,
      body: { name: 'Lobby capacity', maxParticipants: 5 },
    });
    const lobbyRoomId = lobbyRoom.body.room.id;
    const openSeat = async (role: 'host' | 'moderator', name: string) => {
      const issued = await ts.api('POST', '/v1/tokens', {
        headers: ADMIN,
        body: { tenantId: 'demo', roomId: lobbyRoomId, participant: { name, role } },
      });
      const client = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(issued.body.token)}`);
      await client.waitFor((message) => message.type === 'welcome');
      return client;
    };
    const host = await openSeat('host', 'Host');
    const pending = await ts.api('POST', `/v1/rooms/${lobbyRoomId}/join`, { body: { name: 'Guest' } });
    assert.equal(pending.status, 202, JSON.stringify(pending.body));
    assert.equal(typeof pending.body.requestId, 'string');
    const moderator = await openSeat('moderator', 'Moderator');
    const admitted = await ts.api('POST', `/v1/rooms/${lobbyRoomId}/lobby/${pending.body.requestId}/admit`, {
      headers: ADMIN,
    });
    assert.equal(admitted.status, 409, JSON.stringify(admitted.body));
    assert.equal(admitted.body.error.code, 'room_full');
    await host.close();
    await moderator.close();
  } finally {
    await ts.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: { security: { waitingRoom: false } },
    });
    await ts.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: { scale: { sfu: { maxParticipants: 5000 } } },
    });
  }
});
