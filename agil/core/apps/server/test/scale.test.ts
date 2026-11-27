/** Scale-out contract: config/status/validation/TURN/ICE, media mode and limits. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openWs, startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const TURN_SECRET = 'turn-secret-value';
let ts: TestServer;

before(async () => {
  // Allowlisted names must exist before startup: the server snapshots them.
  process.env.AGIL_TURN_TEST_SECRET = TURN_SECRET;
  process.env.AGIL_SFU_TEST_KEY = 'sfu-key-value';
  process.env.AGIL_SFU_TEST_SECRET = 'sfu-secret-value';
  ts = await startTestServer();
});

after(async () => {
  delete process.env.AGIL_TURN_TEST_SECRET;
  delete process.env.AGIL_SFU_TEST_KEY;
  delete process.env.AGIL_SFU_TEST_SECRET;
  await ts.close();
});

function validScale(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mediaMode: 'sfu',
    maxParticipants: 500,
    signaling: {
      nodeId: 'node-1',
      redisUrl: '',
      pubsubChannel: 'agil:signaling',
      stickySessions: true,
      nodes: [{ id: 'node-2', url: 'https://calls-2.example', region: 'ru-spb', weight: 100 }],
    },
    sfu: {
      provider: 'livekit',
      url: 'wss://sfu.example',
      apiKeyEnv: 'AGIL_SFU_TEST_KEY',
      apiSecretEnv: 'AGIL_SFU_TEST_SECRET',
      region: 'ru-msk',
      maxParticipants: 5000,
      // These tests exercise the legacy 200-seat large-room paths; `high` keeps
      // the capacity profile from being the binding limit (see capacity tests).
      capacityProfile: 'high',
    },
    turn: [
      {
        id: 'turn-msk',
        urls: ['turn:turn-msk.example:3478?transport=udp', 'turns:turn-msk.example:5349'],
        username: 'agil',
        credentialEnv: 'AGIL_TURN_TEST_SECRET',
        region: 'ru-msk',
        weight: 100,
      },
      {
        id: 'turn-broken',
        urls: ['turn:turn-broken.example:3478'],
        username: 'agil',
        credentialEnv: 'AGIL_TURN_MISSING_SECRET',
        region: 'ru-spb',
        weight: 50,
      },
    ],
    webinar: { enabled: false, hostOnlyPublish: true, viewerLimit: 10000, chatMode: 'moderated', reactions: true, raiseHandQueue: true },
    ...overrides,
  };
}

async function putScale(scale: Record<string, unknown>): Promise<any> {
  return ts.api('PUT', '/v1/admin/scale', { headers: ADMIN, body: { scale } });
}

test('GET /v1/admin/scale requires an admin key and returns MVP defaults', async () => {
  const unauthorized = await ts.api('GET', '/v1/admin/scale');
  assert.equal(unauthorized.status, 401);

  const status = await ts.api('GET', '/v1/admin/scale', { headers: ADMIN });
  assert.equal(status.status, 200);
  assert.equal(status.body.config.mediaMode, 'mesh');
  assert.equal(status.body.mediaMode, 'mesh');
  assert.equal(status.body.cluster.nodeId, 'node-1');
  assert.equal(status.body.cluster.redisConfigured, false);
  assert.equal(status.body.turn.length, 0);
  assert.equal(status.body.sfuConfigured, false);
  assert.equal(status.body.webinarEnabled, false);
  assert.equal(status.body.streamingProvider, 'none');
  assert.equal(status.body.config.streaming.playbackProtocol, 'hls');
  assert.equal(status.body.config.streaming.whepUrl, '');
  assert.ok(Array.isArray(status.body.limitations) && status.body.limitations.length >= 4);

  const cluster = await ts.api('GET', '/v1/admin/cluster/status', { headers: ADMIN });
  assert.equal(cluster.status, 200);
  assert.equal(cluster.body.multiNodeActive, false);
  assert.equal(cluster.body.nodeId, 'node-1');
  assert.ok(Array.isArray(cluster.body.nodes));
});

test('PUT /v1/admin/scale validates URL schemes, hosts and env references', async () => {
  const incompleteRelay = await putScale({ turn: [{ id: 'relay', urls: ['turn:turn.example:3478'], credentialMode: 'rest' }] });
  assert.equal(incompleteRelay.status, 400);
  assert.equal(incompleteRelay.body.error.code, 'validation_failed');

  const badTurnScheme = await putScale(validScale({ turn: [{ id: 't1', urls: ['https://turn.example:5349'], username: 'u', credentialEnv: 'AGIL_TURN_TEST_SECRET', region: 'ru', weight: 1 }] }));
  assert.equal(badTurnScheme.status, 400);
  assert.equal(badTurnScheme.body.error.code, 'validation_failed');

  const privateNode = await putScale(validScale({ signaling: { nodes: [{ id: 'n2', url: 'http://10.0.0.5:8787', region: 'ru', weight: 1 }] } }));
  assert.equal(privateNode.status, 400);

  const badCredentialEnv = await putScale(validScale({ turn: [{ id: 't1', urls: ['turn:turn.example:3478'], username: 'u', credentialEnv: 'not an env', region: 'ru', weight: 1 }] }));
  assert.equal(badCredentialEnv.status, 400);

  const badSfuEnv = await putScale(validScale({ sfu: { provider: 'livekit', url: 'wss://sfu.example', apiKeyEnv: 'bad env', apiSecretEnv: 'AGIL_SFU_TEST_SECRET', region: 'ru', maxParticipants: 100 } }));
  assert.equal(badSfuEnv.status, 400);

  const missingUrl = await putScale(validScale({ turn: [{ id: 't1', urls: [''], username: 'u', credentialEnv: 'AGIL_TURN_TEST_SECRET', region: 'ru', weight: 1 }] }));
  assert.equal(missingUrl.status, 400);

  const wrongWhepScheme = await putScale({ streaming: { playbackProtocol: 'whep', whepUrl: 'rtsp://edge.example/live/whep' } });
  assert.equal(wrongWhepScheme.status, 400);
});

test('admin can select WHEP without changing the existing HLS destination', async () => {
  const hlsUrl = 'https://edge.example/live/index.m3u8';
  const whepUrl = 'https://edge.example/live/whep';
  const updated = await putScale({ streaming: { enabled: true, hlsUrl, playbackProtocol: 'whep', whepUrl } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const saved = await ts.api('GET', '/v1/admin/scale', { headers: ADMIN });
  assert.equal(saved.body.config.streaming.hlsUrl, hlsUrl);
  assert.equal(saved.body.config.streaming.whepUrl, whepUrl);
  assert.equal(saved.body.config.streaming.playbackProtocol, 'whep');
  const reverted = await putScale({ streaming: { enabled: false, hlsUrl: '', playbackProtocol: 'hls', whepUrl: '' } });
  assert.equal(reverted.status, 200);
});

test('PUT /v1/admin/scale merges and reports status without leaking secrets', async () => {
  const updated = await putScale(validScale());
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.mediaMode, 'sfu');
  assert.equal(updated.body.config.maxParticipants, 500);
  assert.equal(updated.body.sfuConfigured, true);
  assert.equal(updated.body.cluster.stickySessions, true);
  assert.equal(updated.body.cluster.nodes.length, 1);
  assert.equal(updated.body.cluster.nodes[0].id, 'node-2');
  const turn = updated.body.turn.find((server: { id: string }) => server.id === 'turn-msk');
  assert.equal(turn.usernameConfigured, true);
  assert.equal(turn.credentialConfigured, true);
  const broken = updated.body.turn.find((server: { id: string }) => server.id === 'turn-broken');
  assert.equal(broken.credentialConfigured, false);
  assert.ok(!JSON.stringify(updated.body).includes(TURN_SECRET), 'TURN credential is never returned');
  assert.ok(!JSON.stringify(updated.body).includes('sfu-secret-value'), 'SFU secret is never returned');

  // A deep-partial patch keeps untouched fields.
  const partial = await putScale({ maxParticipants: 777 });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.config.maxParticipants, 777);
  assert.equal(partial.body.mediaMode, 'sfu');
  assert.equal(partial.body.turn.length, 2);
});

test('TURN test probes real UDP/TCP reachability and validates config (ok/missing env/unknown id)', async () => {
  // The configured host is unreachable from CI/local: the probe must report a real network failure.
  const ok = await ts.api('POST', '/v1/admin/scale/turn/test', { headers: ADMIN, body: { id: 'turn-msk' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, false);
  assert.equal(typeof ok.body.latencyMs, 'number');
  assert.match(ok.body.detail, /failed|timeout|ENOTFOUND|EAI_AGAIN/i);

  const missingEnv = await ts.api('POST', '/v1/admin/scale/turn/test', { headers: ADMIN, body: { id: 'turn-broken' } });
  assert.equal(missingEnv.status, 200);
  assert.equal(missingEnv.body.ok, false);
  assert.match(missingEnv.body.detail, /AGIL_TURN_MISSING_SECRET/);

  const unknown = await ts.api('POST', '/v1/admin/scale/turn/test', { headers: ADMIN, body: { id: 'nope' } });
  assert.equal(unknown.status, 404);

  const audit = await ts.api('GET', '/v1/admin/audit?type=admin.action&limit=100', { headers: ADMIN });
  assert.ok(audit.body.entries.some((entry: { details?: { kind?: string } }) => entry.details?.kind === 'scale.updated'));
});

test('welcome.iceServers contains STUN + the TURN pool with env credentials', async () => {
  const created = await ts.api('POST', '/v1/rooms', { body: { name: 'ICE room' } });
  const client = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(created.body.token)}`);
  const welcome = await client.waitFor((message) => message.type === 'welcome');
  const ice: Array<{ urls: string | string[]; username?: string; credential?: string }> = welcome.iceServers;
  assert.ok(ice.some((server) => String(server.urls).includes('stun:')), 'STUN is always advertised');
  const turn = ice.find((server) => JSON.stringify(server.urls).includes('turn:'));
  assert.ok(turn, 'TURN pool from config.scale.turn is advertised');
  const welcomeTurnUrls = turn ? (Array.isArray(turn.urls) ? turn.urls : [turn.urls]).map(String) : [];
  assert.ok(welcomeTurnUrls.some((url) => /transport=tcp/i.test(url)), 'TURN TCP fallback URL is advertised in welcome.iceServers');
  assert.equal(turn.username, 'agil');
  assert.equal(turn.credential, TURN_SECRET);
  assert.ok(ice.some((server) => JSON.stringify(server.urls).includes('turns:turn-msk.example:5349')));
  await client.close();
});

test('rooms inherit mediaMode/maxParticipants from config.scale (direct stays 2)', async () => {
  const group = await ts.api('POST', '/v1/rooms', { body: { name: 'SFU room' } });
  assert.equal(group.status, 200);
  assert.equal(group.body.room.mediaMode, 'sfu');
  // scale.maxParticipants is 777, but the high capacity profile caps one node
  // at 200 participants (effective = min(room default, profile, sfu.max)).
  assert.equal(group.body.room.maxParticipants, 200);

  const explicit = await ts.api('POST', '/v1/rooms', { body: { name: 'Ten seats', maxParticipants: 10 } });
  assert.equal(explicit.body.room.maxParticipants, 10);

  const direct = await ts.api('POST', '/v1/rooms', { body: { name: 'Direct', mode: 'direct', maxParticipants: 500 } });
  assert.equal(direct.body.room.mode, 'direct');
  assert.equal(direct.body.room.maxParticipants, 2);
  assert.equal(direct.body.room.mediaMode, 'sfu');

  const detail = await ts.api('GET', `/v1/admin/rooms/${group.body.room.id}`, { headers: ADMIN });
  assert.equal(detail.body.room.mediaMode, 'sfu');
  assert.equal(detail.body.room.maxParticipants, 200);
  assert.equal(detail.body.effectiveMaxParticipants, 200);
  assert.equal(detail.body.capacity.limit, 'profile');
  assert.equal(detail.body.capacity.profileParticipants, 200);

  // Webinar + non-mesh media mode resolves to broadcast.
  const webinar = await putScale({ webinar: { enabled: true } });
  assert.equal(webinar.status, 200);
  assert.equal(webinar.body.mediaMode, 'broadcast');
  const webinarRoom = await ts.api('POST', '/v1/rooms', { body: { name: 'Webinar' } });
  assert.equal(webinarRoom.body.room.mediaMode, 'broadcast');
  await putScale({ webinar: { enabled: false } });

  // Back to mesh: direct rooms stay mesh.
  const mesh = await putScale({ mediaMode: 'mesh' });
  assert.equal(mesh.body.mediaMode, 'mesh');
  const meshDirect = await ts.api('POST', '/v1/rooms', { body: { name: 'Mesh direct', mode: 'direct' } });
  assert.equal(meshDirect.body.room.mediaMode, 'mesh');
});

test('room capacity is enforced from room.maxParticipants', async () => {
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Tiny', maxParticipants: 2 } });
  const roomId = created.body.room.id;
  assert.equal(created.body.room.maxParticipants, 2);
  const tokens: string[] = [];
  for (const name of ['A', 'B']) {
    const issued = await ts.api('POST', '/v1/tokens', {
      headers: ADMIN,
      body: { tenantId: 'demo', roomId, participant: { name } },
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
    body: { tenantId: 'demo', roomId, participant: { name: 'C' } },
  });
  const fourth = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(third.body.token)}`);
  const error = await fourth.waitFor((message) => message.type === 'error');
  assert.equal(error.code, 'room_full');
  for (const client of clients) await client.close();
  await fourth.close();
});

test('health exposes mediaMode and scaleConfigured flags', async () => {
  const health = await ts.api('GET', '/v1/health');
  assert.equal(health.status, 200);
  assert.ok(['mesh', 'sfu', 'broadcast'].includes(health.body.security.mediaMode));
  assert.equal(health.body.security.scaleConfigured, true);
});

test('one office NAT can fill a 200-seat room inside the join window', async () => {
  // Regression for the stage-1 room-fill path: the old default (120/min per
  // IP+room) rejected the 121st participant of a 200-person office.
  assert.ok(ts.server.env.joinRateLimitPerMin >= 200, `default join rate limit is ${ts.server.env.joinRateLimitPerMin}/min`);
  const created = await ts.api('POST', '/v1/rooms', { body: { name: 'NAT fill', maxParticipants: 200 } });
  assert.equal(created.status, 200);
  const roomId = created.body.room.id;
  for (let index = 0; index < 125; index += 1) {
    const joined = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: `Guest ${index}` } });
    assert.equal(joined.status, 200, `join ${index + 1}: ${JSON.stringify(joined.body)}`);
  }
});
