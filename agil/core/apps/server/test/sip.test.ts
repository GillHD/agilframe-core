/**
 * SIP/PSTN baseline against a mock LiveKit SIP Twirp gateway:
 * status/501, auth/gating/E2EE, E.164, create body + JWT grants, list/stop,
 * masking/audit, tenant isolation, rate limit/concurrency and admin test modes.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultConfig } from '@agil/protocol';
import { createLogger } from '../src/logger.js';
import { startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const ACME = { 'x-api-key': 'acme-key' };
const SIP_KEY = 'sip-key-value';
const SIP_SECRET = 'sip-secret-value';
const DEMO_NUMBER = '+74951234567';
const ACME_NUMBER = '+74957654321';
const UPSTREAM_LEAK = 'gateway https://internal.example:7880/secret?api_key=supersecret failed for +74951234567';

interface RecordedRequest {
  service: string;
  method: string;
  body: Record<string, any>;
  auth: string;
}

interface RawParticipant {
  identity: string;
  name: string;
  kind: string;
  state: string;
  /** Twirp/protojson may send int64 seconds as a string. */
  joined_at: number | string;
  attributes: Record<string, string>;
  /** LiveKit participant id (`PA_...`); present on real gateway responses. */
  sid?: string;
}

let ts: TestServer;
let twirp: Server;
let twirpUrl = '';
let requests: RecordedRequest[] = [];
let participants = new Map<string, RawParticipant[]>();
let failCreate = false;
let failList = false;
let failRemove = false;
let failMessage = '';
let logLines: string[] = [];

function decodeJwt(token: string): Record<string, any> {
  const segment = token.replace(/^Bearer\s+/i, '').split('.')[1] ?? '';
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, any>;
}

/** Decodes and verifies the HS256 signature against AGIL_SIP_API_SECRET. */
function verifyJwt(token: string): Record<string, any> {
  const raw = token.replace(/^Bearer\s+/i, '');
  const [header, payload, signature] = raw.split('.');
  assert.ok(header && payload && signature, 'JWT has three segments');
  const expected = createHmac('sha256', SIP_SECRET).update(`${header}.${payload}`).digest('base64url');
  assert.equal(signature, expected, 'JWT is HMAC-SHA256 signed with AGIL_SIP_API_SECRET');
  const claims = decodeJwt(raw);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(claims.nbf <= now, 'nbf is not in the future');
  assert.ok(claims.exp > now, 'exp is in the future');
  assert.ok(claims.exp - claims.nbf <= 130, 'short-lived token (≈125 s)');
  return claims;
}

async function configureSip(
  tenant: 'demo' | 'acme' = 'demo',
  overrides: {
    feature?: boolean;
    scaleEnabled?: boolean;
    e2ee?: boolean;
    maxConcurrent?: number;
    trunkId?: string;
    numbers?: string[];
    callerId?: string;
  } = {},
): Promise<void> {
  const headers = tenant === 'acme' ? ACME : ADMIN;
  const response = await ts.api('PATCH', `/v1/tenants/${tenant}/config`, {
    headers,
    body: {
      features: { sipDialIn: overrides.feature ?? true },
      security: { e2ee: overrides.e2ee ?? false },
      scale: {
        mediaMode: 'sfu',
        sip: {
          enabled: overrides.scaleEnabled ?? true,
          provider: 'livekit-sip',
          httpUrl: twirpUrl,
          wsUrl: 'ws://127.0.0.1:7880',
          trunkId: overrides.trunkId ?? `ST_${tenant}`,
          dialInNumbers: overrides.numbers ?? [tenant === 'acme' ? ACME_NUMBER : DEMO_NUMBER],
          callerId: overrides.callerId ?? '+74950000000',
          maxConcurrent: overrides.maxConcurrent ?? 100,
          region: 'ru-msk',
        },
      },
    },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

async function createRoom(tenant: 'demo' | 'acme' = 'demo'): Promise<{ roomId: string; token: string }> {
  const created = await ts.api('POST', '/v1/admin/rooms', {
    headers: tenant === 'acme' ? ACME : ADMIN,
    body: { name: `SIP ${tenant} ${Date.now()}` },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return { roomId: created.body.room.id, token: created.body.token };
}

async function guestToken(roomId: string): Promise<string> {
  const joined = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'Guest' } });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return joined.body.token;
}

function dial(
  room: { roomId: string; token?: string },
  body: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  return ts.api('POST', `/v1/rooms/${room.roomId}/sip/dial-in`, {
    headers: headers ?? { authorization: `Bearer ${room.token}` },
    body,
  });
}

function listSip(room: { roomId: string; token?: string }, headers?: Record<string, string>) {
  return ts.api('GET', `/v1/rooms/${room.roomId}/sip`, {
    headers: headers ?? { authorization: `Bearer ${room.token}` },
  });
}

function stopSip(room: { roomId: string; token?: string }, participantId: string, headers?: Record<string, string>) {
  return ts.api('POST', `/v1/rooms/${room.roomId}/sip/${encodeURIComponent(participantId)}/stop`, {
    headers: headers ?? { authorization: `Bearer ${room.token}` },
  });
}

function roomName(room: { roomId: string }, tenant = 'demo'): string {
  return `${tenant}__${room.roomId}`;
}

before(async () => {
  twirp = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, any>;
      const parts = (req.url ?? '').split('/');
      const method = parts.pop() ?? '';
      const service = parts.pop() ?? '';
      requests.push({ service, method, body, auth: String(req.headers.authorization ?? '') });
      res.setHeader('content-type', 'application/json');

      if (service === 'livekit.SIP' && method === 'CreateSIPParticipant') {
        if (failCreate) {
          res.statusCode = 500;
          res.end(JSON.stringify({ code: 'internal', msg: failMessage || `carrier rejected ${body.sip_call_to}` }));
          return;
        }
        // Real `SIPParticipantInfo`: a separate participant id and identity, no
        // nested `participant`. The identity is what list/stop must use.
        const participantId = `PA_${requests.length}`;
        const returnedIdentity = `sip_gateway_${requests.length.toString(16)}`;
        const raw: RawParticipant = {
          identity: returnedIdentity,
          name: String(body.participant_name),
          kind: 'SIP',
          state: 'JOINING',
          joined_at: String(Math.floor(Date.now() / 1000)),
          attributes: {
            'sip.callID': `SC_${requests.length}`,
            'sip.phoneNumber': String(body.sip_call_to),
          },
        };
        const room = String(body.room_name);
        participants.set(room, [...(participants.get(room) ?? []), raw]);
        res.end(
          JSON.stringify({
            participant_id: participantId,
            participant_identity: returnedIdentity,
            room_name: room,
            sip_call_id: `SC_${requests.length}`,
          }),
        );
        return;
      }
      if (service === 'livekit.RoomService' && method === 'ListParticipants') {
        if (failList) {
          res.statusCode = 500;
          res.end(JSON.stringify({ code: 'internal', msg: failMessage || UPSTREAM_LEAK }));
          return;
        }
        const room = String(body.room);
        res.end(
          JSON.stringify({
            participants: [
              ...(participants.get(room) ?? []),
              // A regular participant must be filtered out of SIP lists.
              { identity: 'standard-user', name: 'Standard', kind: 'STANDARD', state: 'ACTIVE' },
            ],
          }),
        );
        return;
      }
      if (service === 'livekit.RoomService' && method === 'RemoveParticipant') {
        if (failRemove) {
          res.statusCode = 500;
          res.end(JSON.stringify({ code: 'internal', msg: failMessage || UPSTREAM_LEAK }));
          return;
        }
        const room = String(body.room);
        participants.set(
          room,
          (participants.get(room) ?? []).filter((entry) => entry.identity !== body.identity),
        );
        res.end(JSON.stringify({}));
        return;
      }
      if (service === 'livekit.RoomService' && method === 'ListRooms') {
        res.end(JSON.stringify({ rooms: [] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ code: 'not_found', msg: `unknown ${service}/${method}` }));
    });
  });
  await new Promise<void>((resolve) => twirp.listen(0, '127.0.0.1', () => resolve()));
  twirpUrl = `http://127.0.0.1:${(twirp.address() as { port: number }).port}`;
  ts = await startTestServer({
    sipUrl: twirpUrl,
    sipApiKey: SIP_KEY,
    sipApiSecret: SIP_SECRET,
    sipEnabled: true,
    logger: createLogger({ sink: (line) => logLines.push(line) }),
  });
});

beforeEach(() => {
  requests = [];
  participants = new Map();
  failCreate = false;
  failList = false;
  failRemove = false;
  failMessage = '';
  logLines = [];
});

after(async () => {
  await ts.close();
  await new Promise<void>((resolve) => twirp.close(() => resolve()));
});

test('bound SIP module gates new outbound calls and keeps existing calls listed and stoppable', async () => {
  const nodeId = 'qa-managed-sip';
  const setBinding = (id: string) => ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN, body: { scale: { sip: { nodeId: id } } },
  });
  const enroll = async (headers: Record<string, string>) => {
    const issued = await ts.api('POST', '/v1/admin/cluster/tokens', { headers, body: { kind: 'node', role: 'all' } });
    assert.equal(issued.status, 201, issued.text);
    const registered = await ts.api('POST', '/v1/nodes/register', { body: { token: issued.body.token, nodeId, role: 'all' } });
    assert.equal(registered.status, 201, registered.text);
    return registered.body.nodeKey as string;
  };
  const beat = (key: string, status: string) => ts.api('POST', `/v1/nodes/${nodeId}/heartbeat`, {
    headers: { 'x-node-token': key },
    body: { modules: [{ id: 'sip', image: 'agil/node-sip:0.1.0', status, health: 'healthy' }] },
  });
  await configureSip();
  const room = await createRoom();
  const assertBlocked = async () => {
    const before = requests.length;
    const blocked = await dial(room, { number: DEMO_NUMBER });
    assert.equal(blocked.status, 503, blocked.text);
    assert.equal(blocked.body.error.code, 'sip_node_unavailable');
    assert.equal(requests.length, before, 'blocked calls do not contact LiveKit');
  };
  try {
    assert.equal((await setBinding('https://invalid')).status, 400);
    assert.equal((await setBinding(nodeId)).status, 200);
    assert.equal((await beat(await enroll(ACME), 'running')).status, 200);
    await assertBlocked();
    const key = await enroll(ADMIN);
    await assertBlocked();
    assert.equal((await beat(key, 'running')).status, 200);
    const call = await dial(room, { number: DEMO_NUMBER });
    assert.equal(call.status, 200, call.text);
    assert.equal((await ts.api('GET', '/v1/admin/sip/status', { headers: ADMIN })).body.nodeAvailable, true);
    assert.equal((await beat(key, 'stopped')).status, 200);
    await assertBlocked();
    const overrideRoom = await ts.api('POST', '/v1/admin/rooms', {
      headers: ADMIN, body: { name: 'SIP binding stays tenant-scoped', configOverrides: { scale: { sip: { nodeId: '' } } } },
    });
    assert.equal(overrideRoom.status, 200, overrideRoom.text);
    const roomOverride = await dial({ roomId: overrideRoom.body.room.id, token: overrideRoom.body.token }, { number: DEMO_NUMBER });
    assert.equal(roomOverride.status, 503, roomOverride.text);
    assert.equal(roomOverride.body.error.code, 'sip_node_unavailable');
    assert.equal((await ts.api('GET', '/v1/admin/sip/status', { headers: ADMIN })).body.nodeAvailable, false);
    const mock = await ts.api('POST', '/v1/admin/sip/test', { headers: ADMIN, body: { mode: 'mock' } });
    assert.equal(mock.body.ok, false);
    assert.match(mock.body.detail, /bound SIP node is unavailable/);
    const listed = await listSip(room);
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.body.participants[0].id, call.body.id);
    assert.equal((await stopSip(room, call.body.id)).status, 200);
    assert.equal((await beat(key, 'running')).status, 200);
    assert.equal((await dial(room, { number: DEMO_NUMBER })).status, 200);
    assert.equal((await beat(key, 'stopped')).status, 200);
    assert.equal((await setBinding('')).status, 200);
    assert.equal((await dial(room, { number: DEMO_NUMBER })).status, 200);
  } finally {
    assert.equal((await setBinding('')).status, 200);
  }
});

test('SIP status: defaults, configured/trunk/numbers and no URL/secrets', async () => {
  await configureSip('demo');
  const status = await ts.api('GET', '/v1/admin/sip/status', { headers: ADMIN });
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.deepEqual(Object.keys(status.body).sort(), ['active', 'configured', 'enabled', 'numbers', 'trunkConfigured']);
  assert.equal(status.body.configured, true);
  assert.equal(status.body.enabled, true);
  assert.equal(status.body.trunkConfigured, true);
  assert.deepEqual(status.body.numbers, [DEMO_NUMBER]);
  assert.equal(status.body.active, 0);
  const text = JSON.stringify(status.body);
  assert.ok(!text.includes(SIP_SECRET));
  assert.ok(!text.includes(SIP_KEY));
  assert.ok(!text.includes(twirpUrl), 'gateway URL is not exposed');
  assert.equal((await ts.api('GET', '/v1/admin/sip/status')).status, 401);
});

test('SIP 501 when disabled or unconfigured; 501 when trunk missing', async () => {
  await configureSip('demo');
  const room = await createRoom();

  const disabled = await startTestServer({
    sipUrl: twirpUrl,
    sipApiKey: SIP_KEY,
    sipApiSecret: SIP_SECRET,
    sipEnabled: false,
  });
  try {
    await disabled.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: {
        features: { sipDialIn: true },
        scale: { sip: { enabled: true, trunkId: 'ST_demo' } },
      },
    });
    const created = await disabled.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Disabled SIP' } });
    const response = await disabled.api('POST', `/v1/rooms/${created.body.room.id}/sip/dial-in`, {
      headers: { authorization: `Bearer ${created.body.token}` },
      body: { number: DEMO_NUMBER },
    });
    assert.equal(response.status, 501);
    assert.equal(response.body.error.code, 'sip_disabled');
    const status = await disabled.api('GET', '/v1/admin/sip/status', { headers: ADMIN });
    assert.equal(status.body.configured, true);
    assert.equal(status.body.enabled, false);
  } finally {
    await disabled.close();
  }

  const unconfigured = await startTestServer({ sipEnabled: true });
  try {
    await unconfigured.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: { features: { sipDialIn: true }, scale: { sip: { enabled: true, trunkId: 'ST_demo' } } },
    });
    const created = await unconfigured.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Unconfigured SIP' } });
    const response = await unconfigured.api('POST', `/v1/rooms/${created.body.room.id}/sip/dial-in`, {
      headers: { authorization: `Bearer ${created.body.token}` },
      body: { number: DEMO_NUMBER },
    });
    assert.equal(response.status, 501);
    assert.equal(response.body.error.code, 'sip_not_configured');
  } finally {
    await unconfigured.close();
  }

  await configureSip('demo', { trunkId: '' });
  const missingTrunk = await dial(room, { number: DEMO_NUMBER });
  assert.equal(missingTrunk.status, 501);
  assert.equal(missingTrunk.body.error.code, 'sip_trunk_not_configured');
});

test('SIP auth/gating: guest 403, feature/scale 403, E2EE 409, E.164 400', async () => {
  await configureSip('demo');
  const room = await createRoom();
  const guest = await guestToken(room.roomId);

  const guestAttempt = await dial(room, { number: DEMO_NUMBER }, { authorization: `Bearer ${guest}` });
  assert.equal(guestAttempt.status, 403);
  assert.equal((await dial(room, { number: DEMO_NUMBER }, {})).status, 401);

  await configureSip('demo', { feature: false });
  const noFeature = await dial(room, { number: DEMO_NUMBER });
  assert.equal(noFeature.status, 403);
  assert.equal(noFeature.body.error.code, 'feature_disabled');

  await configureSip('demo', { scaleEnabled: false });
  const noScale = await dial(room, { number: DEMO_NUMBER });
  assert.equal(noScale.status, 403);
  assert.equal(noScale.body.error.code, 'feature_disabled');

  await configureSip('demo', { e2ee: true });
  const e2ee = await dial(room, { number: DEMO_NUMBER });
  assert.equal(e2ee.status, 409);
  assert.equal(e2ee.body.error.code, 'e2ee_incompatible');

  await configureSip('demo');
  const invalid = await dial(room, { number: '89991234567' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'validation_failed');
  const tooLong = await dial(room, { number: '+7999123456789012' });
  assert.equal(tooLong.status, 400);
  assert.equal((await dial(room, {})).status, 400);
  assert.equal(requests.filter((entry) => entry.method === 'CreateSIPParticipant').length, 0);
});

test('SIP dial-in: Twirp body, real response identity, JWT grants, masked audit', async () => {
  await configureSip('demo');
  const room = await createRoom();
  const response = await dial(room, { number: DEMO_NUMBER, name: 'Анна' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  // P1-1: real SIPParticipantInfo has a separate participant_id (`PA_...`) and
  // participant_identity. The identity (not the participant id) is returned.
  assert.match(response.body.identity, /^sip_gateway_[0-9a-f]+$/);
  assert.ok(!response.body.identity.startsWith('PA_'), 'participant_id is not used as the identity');
  assert.equal(response.body.id, response.body.identity);
  assert.equal(response.body.name, 'Анна');
  assert.equal(response.body.role, 'guest');
  assert.equal(response.body.roomId, room.roomId);
  assert.equal(response.body.source, 'sip');
  assert.equal(response.body.status, 'dialing');
  assert.ok(!JSON.stringify(response.body).includes(DEMO_NUMBER), 'response never contains the number');

  const create = requests.find((entry) => entry.method === 'CreateSIPParticipant');
  assert.ok(create, 'CreateSIPParticipant was called');
  assert.equal(create.service, 'livekit.SIP');
  assert.equal(create.body.sip_trunk_id, 'ST_demo');
  assert.equal(create.body.sip_call_to, DEMO_NUMBER);
  assert.equal(create.body.room_name, roomName(room));
  assert.match(create.body.participant_identity, /^sip_[a-f0-9]{32}$/, 'request identity is generated');
  assert.notEqual(create.body.participant_identity, response.body.identity, 'response participant_identity wins');
  assert.equal(create.body.participant_name, 'Анна');
  assert.equal(create.body.hide_phone_number, true);
  assert.equal(create.body.sip_number, '+74950000000');
  assert.equal(create.body.max_call_duration, '3600s', 'bounded PSTN call duration');
  assert.equal(create.body.ringing_timeout, '60s');
  const metadata = JSON.parse(create.body.participant_metadata);
  assert.deepEqual(metadata, { source: 'sip', role: 'guest', tenantId: 'demo', roomId: room.roomId });

  const jwt = verifyJwt(create.auth);
  assert.equal(jwt.iss, SIP_KEY);
  assert.equal(jwt.sub, 'agil-sip-controller');
  assert.equal(jwt.video.room, roomName(room));
  assert.equal(jwt.video.roomJoin, true);
  assert.equal(jwt.sip.call, true);
  assert.ok(!create.auth.includes(SIP_SECRET), 'secret is never in the token');

  const audit = await ts.api('GET', '/v1/admin/audit?type=sip.dialin.started&limit=100', { headers: ADMIN });
  assert.equal(audit.status, 200, JSON.stringify(audit.body));
  const entry = audit.body.entries.find((item: any) => item.roomId === room.roomId);
  assert.ok(entry, 'sip.dialin.started audit entry');
  assert.equal(entry.participantId, response.body.identity);
  assert.equal(entry.details.kind, 'sip.dialin.started');
  assert.match(entry.details.numberMasked, /^\+7•+67$/);
  const auditText = JSON.stringify(audit.body);
  assert.ok(!auditText.includes(DEMO_NUMBER), 'raw phone number is not audited');
  assert.ok(!auditText.includes('Анна'), 'participant name is not audited');
  assert.ok(!auditText.includes(SIP_SECRET) && !auditText.includes(SIP_KEY));
  assert.ok(!logLines.join('\n').includes(DEMO_NUMBER), 'raw phone number is not logged');
  assert.ok(!logLines.join('\n').includes(SIP_SECRET), 'secret is not logged');
});

test('SIP list/stop: only SIP participants, roomAdmin grant, audit, 404, guest 403', async () => {
  await configureSip('demo');
  const room = await createRoom();
  const created = await dial(room, { number: DEMO_NUMBER, name: 'Гость SIP' });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  const status = await ts.api('GET', '/v1/admin/sip/status', { headers: ADMIN });
  assert.equal(status.body.active, 1);

  const listed = await listSip(room);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.roomId, room.roomId);
  assert.equal(listed.body.participants.length, 1);
  assert.equal(listed.body.participants[0].identity, created.body.identity);
  assert.equal(listed.body.participants[0].role, 'guest');
  assert.equal(typeof listed.body.participants[0].joinedAt, 'number', 'protojson string joined_at is parsed');
  assert.ok(!JSON.stringify(listed.body).includes(DEMO_NUMBER), 'list response masks numbers');
  assert.ok(!JSON.stringify(listed.body).includes('standard-user'), 'only SIP participants are listed');
  const listRequest = requests.filter((entry) => entry.method === 'ListParticipants').pop();
  assert.equal(listRequest?.body.room, roomName(room));
  assert.equal(verifyJwt(listRequest!.auth).video.roomAdmin, true);
  assert.equal(decodeJwt(listRequest!.auth).video.room, roomName(room));

  const guest = await guestToken(room.roomId);
  assert.equal((await listSip(room, { authorization: `Bearer ${guest}` })).status, 403);
  assert.equal((await stopSip(room, created.body.identity, { authorization: `Bearer ${guest}` })).status, 403);

  const stopped = await stopSip(room, created.body.identity);
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.deepEqual(stopped.body, { stopped: true, participantId: created.body.identity });
  const remove = requests.find((entry) => entry.method === 'RemoveParticipant');
  assert.ok(remove);
  assert.deepEqual(remove.body, { room: roomName(room), identity: created.body.identity });
  assert.equal(verifyJwt(remove.auth).video.roomAdmin, true);

  assert.equal((await listSip(room)).body.participants.length, 0);
  assert.equal((await stopSip(room, created.body.identity)).status, 404);

  const audit = await ts.api('GET', '/v1/admin/audit?type=sip.dialin.stopped&limit=100', { headers: ADMIN });
  const stoppedEntry = audit.body.entries.find(
    (item: any) => item.roomId === room.roomId && item.details.kind === 'sip.dialin.stopped',
  );
  assert.ok(stoppedEntry, 'stop audit entry');
  assert.equal(stoppedEntry.participantId, created.body.identity);
  assert.equal(stoppedEntry.details.action, 'stop');
  assert.equal(stoppedEntry.details.identity, created.body.identity);
});

test('SIP failure: 502 sip_failed, masked error/audit, URLs/tokens/phone scrubbed', async () => {
  await configureSip('demo');
  const room = await createRoom();
  failCreate = true;
  failMessage = UPSTREAM_LEAK;
  const failed = await dial(room, { number: DEMO_NUMBER });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error.code, 'sip_failed');
  assert.ok(!failed.text.includes(DEMO_NUMBER), 'error response does not echo the number');
  assert.ok(!failed.text.includes('internal.example'), 'error response does not echo the gateway URL');
  assert.ok(!failed.text.includes('supersecret'), 'error response does not echo token-like text');
  assert.ok(!failed.text.includes(SIP_SECRET));
  const audit = await ts.api('GET', '/v1/admin/audit?type=sip.dialin.failed&limit=100', { headers: ADMIN });
  const entry = audit.body.entries.find((item: any) => item.roomId === room.roomId);
  assert.ok(entry, 'sip.dialin.failed audit entry');
  assert.equal(entry.details.action, 'start');
  assert.match(entry.details.numberMasked, /^\+7•+67$/);
  assert.ok(!JSON.stringify(audit.body).includes(DEMO_NUMBER), 'raw number is not audited');
  assert.ok(!JSON.stringify(audit.body).includes('internal.example'), 'URL is not audited');
  assert.ok(!JSON.stringify(audit.body).includes('supersecret'), 'token is not audited');
  assert.ok(!logLines.join('\n').includes(DEMO_NUMBER), 'raw phone number is not logged');
  assert.ok(!logLines.join('\n').includes('internal.example'), 'URL is not logged');
});

test('SIP tenant isolation: config, rooms and stop are tenant-scoped', async () => {
  await configureSip('demo', { trunkId: 'ST_demo_isolation', numbers: [DEMO_NUMBER] });
  await configureSip('acme', { trunkId: 'ST_acme_isolation', numbers: [ACME_NUMBER] });

  const demoStatus = await ts.api('GET', '/v1/admin/sip/status', { headers: ADMIN });
  const acmeStatus = await ts.api('GET', '/v1/admin/sip/status', { headers: ACME });
  assert.deepEqual(demoStatus.body.numbers, [DEMO_NUMBER]);
  assert.deepEqual(acmeStatus.body.numbers, [ACME_NUMBER]);

  const acmeRoom = await createRoom('acme');
  const foreignDial = await dial(acmeRoom, { number: ACME_NUMBER }, ADMIN);
  assert.equal(foreignDial.status, 403);
  const foreignList = await listSip(acmeRoom, ADMIN);
  assert.equal(foreignList.status, 403);

  const viaAcme = await dial(acmeRoom, { number: ACME_NUMBER });
  assert.equal(viaAcme.status, 200, JSON.stringify(viaAcme.body));
  const create = requests.find((entry) => entry.method === 'CreateSIPParticipant');
  assert.equal(create?.body.sip_trunk_id, 'ST_acme_isolation');
  assert.equal(create?.body.room_name, roomName(acmeRoom, 'acme'));

  const foreignStop = await stopSip(acmeRoom, viaAcme.body.identity, ADMIN);
  assert.equal(foreignStop.status, 403);
  const acmeList = await listSip(acmeRoom, ACME);
  assert.equal(acmeList.status, 200);
  assert.equal(acmeList.body.participants[0].identity, viaAcme.body.identity);
});

test('SIP rate limit and maxConcurrent', async () => {
  await configureSip('demo', { maxConcurrent: 100 });
  const room = await createRoom();
  for (let index = 0; index < 10; index += 1) {
    const response = await dial(room, { number: DEMO_NUMBER });
    assert.equal(response.status, 200, `attempt ${index + 1}: ${JSON.stringify(response.body)}`);
  }
  const limited = await dial(room, { number: DEMO_NUMBER });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'rate_limited');

  const room2 = await createRoom();
  await configureSip('demo', { maxConcurrent: 1 });
  assert.equal((await dial(room2, { number: DEMO_NUMBER })).status, 200);
  const overLimit = await dial(room2, { number: '+74951112233' });
  assert.equal(overLimit.status, 409);
  assert.equal(overLimit.body.error.code, 'sip_limit_reached');
});

test('SIP admin test: mock validates config, live calls Twirp, disabled live 501', async () => {
  await configureSip('demo');
  requests = [];
  const mock = await ts.api('POST', '/v1/admin/sip/test', {
    headers: ADMIN,
    body: { mode: 'mock', number: DEMO_NUMBER },
  });
  assert.equal(mock.status, 200, JSON.stringify(mock.body));
  assert.equal(mock.body.ok, true);
  assert.equal(mock.body.mode, 'mock');
  assert.equal(mock.body.configured, true);
  assert.equal(mock.body.trunkConfigured, true);
  assert.equal(requests.length, 0, 'mock mode performs no network call');
  assert.ok(!JSON.stringify(mock.body).includes(SIP_SECRET));
  assert.ok(!JSON.stringify(mock.body).includes(twirpUrl));

  const invalid = await ts.api('POST', '/v1/admin/sip/test', {
    headers: ADMIN,
    body: { mode: 'mock', number: '12345' },
  });
  assert.equal(invalid.status, 400);

  const live = await ts.api('POST', '/v1/admin/sip/test', { headers: ADMIN, body: { mode: 'live' } });
  assert.equal(live.status, 200, JSON.stringify(live.body));
  assert.equal(live.body.ok, true);
  assert.equal(live.body.mode, 'live');
  assert.equal(typeof live.body.latencyMs, 'number');
  const probe = requests.find((entry) => entry.method === 'ListRooms');
  assert.ok(probe, 'live mode calls RoomService.ListRooms');
  assert.equal(verifyJwt(probe.auth).video.roomList, true);

  const disabled = await startTestServer({
    sipUrl: twirpUrl,
    sipApiKey: SIP_KEY,
    sipApiSecret: SIP_SECRET,
    sipEnabled: false,
  });
  try {
    await disabled.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: { features: { sipDialIn: true }, scale: { sip: { enabled: true, trunkId: 'ST_demo' } } },
    });
    const response = await disabled.api('POST', '/v1/admin/sip/test', { headers: ADMIN, body: { mode: 'live' } });
    assert.equal(response.status, 501);
    assert.equal(response.body.error.code, 'sip_disabled');
    const mockDisabled = await disabled.api('POST', '/v1/admin/sip/test', { headers: ADMIN, body: { mode: 'mock' } });
    assert.equal(mockDisabled.status, 200);
    assert.equal(mockDisabled.body.ok, false);
    assert.match(mockDisabled.body.detail, /AGIL_SIP_ENABLED/);
  } finally {
    await disabled.close();
  }
});

test('PUT /v1/admin/scale merges a deep-partial scale.sip and validates it', async () => {
  const updated = await ts.api('PUT', '/v1/admin/scale', {
    headers: ADMIN,
    body: {
      scale: {
        sip: {
          enabled: true,
          provider: 'livekit-sip',
          httpUrl: twirpUrl,
          wsUrl: 'ws://127.0.0.1:7880',
          trunkId: 'ST_scale',
          dialInNumbers: [DEMO_NUMBER],
          callerId: '+74950000000',
          maxConcurrent: 7,
          region: 'ru-msk',
        },
      },
    },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.config.sip.enabled, true);
  assert.equal(updated.body.config.sip.trunkId, 'ST_scale');
  assert.equal(updated.body.config.sip.maxConcurrent, 7);
  assert.deepEqual(updated.body.config.sip.dialInNumbers, [DEMO_NUMBER]);
  assert.equal(updated.body.config.mediaMode, 'sfu', 'sibling scale fields survive the patch');

  const badNumber = await ts.api('PUT', '/v1/admin/scale', {
    headers: ADMIN,
    body: { scale: { sip: { dialInNumbers: ['89991234567'] } } },
  });
  assert.equal(badNumber.status, 400);
  assert.equal(badNumber.body.error.code, 'validation_failed');

  const noTrunk = await ts.api('PUT', '/v1/admin/scale', {
    headers: ADMIN,
    body: { scale: { sip: { enabled: true, trunkId: '' } } },
  });
  assert.equal(noTrunk.status, 400);
  assert.equal(noTrunk.body.error.code, 'validation_failed');
});

test('PATCH /v1/tenants/:id/config is deep-partial for scale.sip (docs example)', async () => {
  await configureSip('demo');
  const minimal = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { scale: { sip: { enabled: true, trunkId: 'ST_deep' } } },
  });
  assert.equal(minimal.status, 200, JSON.stringify(minimal.body));
  const sip = minimal.body.config.scale.sip;
  assert.equal(sip.trunkId, 'ST_deep');
  assert.equal(sip.provider, 'livekit-sip', 'default survives a minimal patch');
  assert.equal(sip.httpUrl, twirpUrl, 'existing sibling value survives');
  assert.equal(minimal.body.config.scale.mediaMode, 'sfu', 'sibling scale fields survive');
  assert.equal(sip.maxCallDurationSec, 3600);

  // The exact documented enablement payload (no provider/wsUrl/region).
  const docsExample = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: {
      features: { sipDialIn: true },
      scale: {
        sip: {
          enabled: true,
          trunkId: 'ST_docs',
          httpUrl: twirpUrl,
          dialInNumbers: [DEMO_NUMBER],
          callerId: '+74950000000',
          maxConcurrent: 10,
        },
      },
    },
  });
  assert.equal(docsExample.status, 200, JSON.stringify(docsExample.body));
  assert.equal(docsExample.body.config.scale.sip.trunkId, 'ST_docs');
  assert.equal(docsExample.body.config.scale.sip.region, 'ru-msk', 'omitted field keeps the stored value');
});

test('tenant config PATCH/PUT enforces the SIP SSRF/TLS policy in secure mode', async () => {
  const secure = await startTestServer({
    trustProxy: true,
    sipApiKey: SIP_KEY,
    sipApiSecret: SIP_SECRET,
    sipEnabled: true,
  });
  try {
    const privateMetadata = await secure.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: { scale: { sip: { enabled: true, trunkId: 'ST_sec', httpUrl: 'http://169.254.169.254' } } },
    });
    assert.equal(privateMetadata.status, 400, JSON.stringify(privateMetadata.body));
    assert.equal(privateMetadata.body.error.code, 'validation_failed');
    assert.ok(JSON.stringify(privateMetadata.body).includes('scale.sip.httpUrl'));

    const insecureHttp = await secure.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: { scale: { sip: { httpUrl: 'http://livekit.example' } } },
    });
    assert.equal(insecureHttp.status, 400, 'http:// is rejected in secure mode');

    const insecureWs = await secure.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: { scale: { sip: { wsUrl: 'ws://livekit.example' } } },
    });
    assert.equal(insecureWs.status, 400, 'ws:// is rejected in secure mode');

    const privateHttps = await secure.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: { scale: { sip: { httpUrl: 'https://127.0.0.1:7880' } } },
    });
    assert.equal(privateHttps.status, 400, 'loopback is rejected in secure mode');

    // The admin scale endpoint keeps the same policy (no bypass by switching route).
    const adminScale = await secure.api('PUT', '/v1/admin/scale', {
      headers: ADMIN,
      body: { scale: { sip: { httpUrl: 'http://169.254.169.254' } } },
    });
    assert.equal(adminScale.status, 400);

    const accepted = await secure.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: {
        scale: {
          sip: { enabled: true, trunkId: 'ST_sec', httpUrl: 'https://livekit.example', wsUrl: 'wss://livekit.example' },
        },
      },
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

    // Full PUT goes through the same TenantStore validation hook.
    const current = await secure.api('GET', '/v1/tenants/demo/config');
    current.body.config.scale.sip.httpUrl = 'http://169.254.169.254';
    const put = await secure.api('PUT', '/v1/tenants/demo/config', { headers: ADMIN, body: current.body.config });
    assert.equal(put.status, 400, JSON.stringify(put.body));
    assert.equal(put.body.error.code, 'validation_failed');
  } finally {
    await secure.close();
  }
});

test('stop rejects phone-like ids without leaking them; cleanup works while SIP is disabled', async () => {
  const cleanupLogs: string[] = [];
  const cleanup = await startTestServer({
    sipUrl: twirpUrl,
    sipApiKey: SIP_KEY,
    sipApiSecret: SIP_SECRET,
    sipEnabled: false,
    logger: createLogger({ sink: (line) => cleanupLogs.push(line) }),
  });
  try {
    const configured = await cleanup.api('PATCH', '/v1/tenants/demo/config', {
      headers: ADMIN,
      body: {
        features: { sipDialIn: true },
        scale: { sip: { enabled: true, trunkId: 'ST_demo', httpUrl: twirpUrl } },
      },
    });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    const created = await cleanup.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Cleanup SIP' } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const roomId = created.body.room.id;
    const auth = { authorization: `Bearer ${created.body.token}` };
    const phone = '79991234567';

    const rejected = await cleanup.api('POST', `/v1/rooms/${roomId}/sip/${phone}/stop`, { headers: auth });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, 'validation_failed');
    assert.ok(!rejected.text.includes(phone), 'response contains no raw number');
    assert.ok(!cleanupLogs.join('\n').includes(phone), 'logs contain no raw number');

    // P2-2: list/stop use cleanup readiness, so they still work with SIP disabled.
    const listed = await cleanup.api('GET', `/v1/rooms/${roomId}/sip`, { headers: auth });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    participants.set(`demo__${roomId}`, [
      {
        identity: 'sip_inbound_safe',
        name: 'SIP guest',
        kind: 'SIP',
        state: 'ACTIVE',
        joined_at: String(Math.floor(Date.now() / 1000)),
        attributes: { 'sip.callID': 'SC_cleanup' },
      },
    ]);
    const stopped = await cleanup.api('POST', `/v1/rooms/${roomId}/sip/sip_inbound_safe/stop`, { headers: auth });
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.deepEqual(stopped.body, { stopped: true, participantId: 'sip_inbound_safe' });

    const audit = await cleanup.api('GET', '/v1/admin/audit?type=sip.dialin.failed&limit=100', { headers: ADMIN });
    const entry = audit.body.entries.find(
      (item: any) => item.roomId === roomId && item.details.action === 'stop',
    );
    assert.ok(entry, 'rejected stop is audited with a masked identity');
    assert.ok(!JSON.stringify(audit.body).includes(phone), 'audit contains no raw number');
    assert.ok(!cleanupLogs.join('\n').includes(phone), 'error logs contain no raw number');
  } finally {
    await cleanup.close();
  }
});

test('SIP list/stop are rate-limited', async () => {
  await configureSip('demo');
  const room = await createRoom();
  for (let index = 0; index < 10; index += 1) {
    const response = await stopSip(room, `sip_missing_${index}`);
    assert.equal(response.status, 404, `stop ${index + 1}: ${JSON.stringify(response.body)}`);
  }
  const limitedStop = await stopSip(room, 'sip_missing_final');
  assert.equal(limitedStop.status, 429);
  assert.equal(limitedStop.body.error.code, 'rate_limited');

  for (let index = 0; index < 30; index += 1) {
    const response = await listSip(room);
    assert.equal(response.status, 200, `list ${index + 1}: ${JSON.stringify(response.body)}`);
  }
  const limitedList = await listSip(room);
  assert.equal(limitedList.status, 429);
  assert.equal(limitedList.body.error.code, 'rate_limited');
});

test('SIP list/stop upstream failures are 502 with scrubbed detail', async () => {
  await configureSip('demo');
  const room = await createRoom();
  const created = await dial(room, { number: DEMO_NUMBER, name: 'SIP fail' });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  failMessage = UPSTREAM_LEAK;
  failList = true;
  const listed = await listSip(room);
  assert.equal(listed.status, 502, JSON.stringify(listed.body));
  assert.equal(listed.body.error.code, 'sip_failed');
  assert.ok(!listed.text.includes('internal.example'), 'list error does not expose the gateway URL');
  assert.ok(!listed.text.includes('supersecret'));
  assert.ok(!listed.text.includes(DEMO_NUMBER));

  failList = false;
  failRemove = true;
  const stopped = await stopSip(room, created.body.identity);
  assert.equal(stopped.status, 502, JSON.stringify(stopped.body));
  assert.equal(stopped.body.error.code, 'sip_failed');
  assert.ok(!stopped.text.includes('internal.example'));
  assert.ok(!stopped.text.includes('supersecret'));
  assert.ok(!stopped.text.includes(DEMO_NUMBER));

  const audit = await ts.api('GET', '/v1/admin/audit?type=sip.dialin.failed&limit=100', { headers: ADMIN });
  const entry = audit.body.entries.find(
    (item: any) => item.roomId === room.roomId && item.details.action === 'stop',
  );
  assert.ok(entry, 'stop failure audit');
  assert.ok(!JSON.stringify(audit.body).includes('internal.example'));
  assert.ok(!JSON.stringify(audit.body).includes('supersecret'));
  assert.ok(!logLines.join('\n').includes('internal.example'));
});

test('SIP maxConcurrent is serialized for concurrent dial-ins', async () => {
  await configureSip('demo', { maxConcurrent: 1 });
  const room = await createRoom();
  const [first, second] = await Promise.all([
    dial(room, { number: DEMO_NUMBER }),
    dial(room, { number: '+74951112233' }),
  ]);
  const statuses = [first.status, second.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);
  const rejected = first.status === 409 ? first : second;
  assert.equal(rejected.body.error.code, 'sip_limit_reached');
  const accepted = first.status === 200 ? first : second;
  const listed = await listSip(room);
  assert.equal(listed.body.participants.length, 1);
  assert.equal(listed.body.participants[0].identity, accepted.body.identity);
});

test('OpenAPI room SIP routes are authenticated and document 502', async () => {
  const spec = await ts.api('GET', '/openapi.json');
  assert.equal(spec.status, 200);
  const routes: Array<[string, string]> = [
    ['/v1/rooms/{roomId}/sip/dial-in', 'post'],
    ['/v1/rooms/{roomId}/sip/{participantId}/stop', 'post'],
    ['/v1/rooms/{roomId}/sip', 'get'],
  ];
  for (const [path, method] of routes) {
    const operation = spec.body.paths[path][method];
    assert.ok(Array.isArray(operation.security), `${path} has security`);
    assert.ok(
      !operation.security.some((entry: Record<string, unknown>) => Object.keys(entry).length === 0),
      `${path} is not anonymous`,
    );
    assert.ok(operation.responses['502'], `${path} documents 502 sip_failed`);
  }
});

test('R1: legacy tenant config without scale.sip loads with defaults and is full-PUT compatible', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'agil-legacy-sip-'));
  try {
    const tenantsDir = path.join(dataDir, 'tenants');
    mkdirSync(tenantsDir, { recursive: true });
    const legacy = defaultConfig({ tenantId: 'acme' }) as unknown as Record<string, any>;
    legacy.features.chat = false;
    legacy.branding.productName = 'Legacy ACME';
    delete (legacy.scale as Record<string, unknown>).sip;
    writeFileSync(path.join(tenantsDir, 'acme.json'), JSON.stringify(legacy, null, 2), 'utf8');

    const legacyServer = await startTestServer({ dataDir });
    try {
      const loaded = await legacyServer.api('GET', '/v1/tenants/acme/config');
      assert.equal(loaded.status, 200, JSON.stringify(loaded.body));
      assert.equal(loaded.body.config.features.chat, false, 'legacy features.chat=false survives the load');
      assert.equal(loaded.body.config.branding.productName, 'Legacy ACME', 'other custom settings survive');
      assert.deepEqual(
        loaded.body.config.scale.sip,
        defaultConfig({ tenantId: 'acme' }).scale.sip,
        'missing scale.sip is defaulted, not silently replaced as a whole config',
      );

      // Full-schema PATCH without scale.sip still merges into the stored config.
      const patched = await legacyServer.api('PATCH', '/v1/tenants/acme/config', {
        headers: ACME,
        body: { branding: { productName: 'Legacy ACME 2' } },
      });
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
      assert.equal(patched.body.config.features.chat, false);
      assert.equal(patched.body.config.branding.productName, 'Legacy ACME 2');
      assert.equal(patched.body.config.scale.sip.enabled, false);

      // Full-schema PUT without scale.sip is accepted and defaults only that object.
      const withoutSip = structuredClone(patched.body.config);
      delete withoutSip.scale.sip;
      const put = await legacyServer.api('PUT', '/v1/tenants/acme/config', { headers: ACME, body: withoutSip });
      assert.equal(put.status, 200, JSON.stringify(put.body));
      assert.equal(put.body.config.features.chat, false, 'full PUT preserves custom flags');
      assert.equal(put.body.config.scale.sip.enabled, false);
      assert.equal(put.body.config.scale.sip.maxCallDurationSec, 3600);
      assert.equal(put.body.config.scale.mediaMode, 'mesh');
    } finally {
      await legacyServer.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('R2: room configOverrides enforce the SIP SSRF/TLS policy before room creation', async () => {
  const secure = await startTestServer({
    trustProxy: true,
    sipApiKey: SIP_KEY,
    sipApiSecret: SIP_SECRET,
    sipEnabled: true,
  });
  try {
    const assertRejected = async (
      roomId: string,
      configOverrides: Record<string, unknown>,
      headers?: Record<string, string>,
    ): Promise<void> => {
      const response = await secure.api('POST', headers ? '/v1/admin/rooms' : '/v1/rooms', {
        ...(headers ? { headers } : {}),
        body: { roomId, configOverrides },
      });
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'validation_failed');
      assert.ok(JSON.stringify(response.body).includes('scale.sip.'), JSON.stringify(response.body));
      assert.equal(secure.server.rooms.get(roomId), undefined, 'no room/roomConfig is created on rejection');
    };

    // Anonymous room creation (AGIL_ALLOW_ANONYMOUS=1 in the test harness).
    await assertRejected('r2-anon-loopback', { scale: { sip: { httpUrl: 'https://127.0.0.1:1' } } });
    await assertRejected('r2-anon-metadata', { scale: { sip: { httpUrl: 'http://169.254.169.254' } } });
    await assertRejected('r2-anon-http', { scale: { sip: { httpUrl: 'http://livekit.example' } } });
    await assertRejected('r2-anon-ws', { scale: { sip: { wsUrl: 'ws://livekit.example' } } });
    // The admin room surface uses the same check.
    await assertRejected('r2-admin-private', { scale: { sip: { httpUrl: 'https://10.0.0.5:7880' } } }, ADMIN);

    // A public HTTPS override is accepted and stored on the room.
    const accepted = await secure.api('POST', '/v1/rooms', {
      body: {
        roomId: 'r2-allowed',
        configOverrides: { scale: { sip: { httpUrl: 'https://livekit.example', wsUrl: 'wss://livekit.example' } } },
      },
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const room = secure.server.rooms.get('r2-allowed');
    assert.ok(room, 'accepted override creates the room');
    assert.equal(room.configOverrides?.scale?.sip?.httpUrl, 'https://livekit.example');
  } finally {
    await secure.close();
  }
});

test('R3: phone-like stop rejection consumes the stop limiter and audits only limited attempts', async () => {
  await configureSip('demo');
  const room = await createRoom();
  const phone = '79991234567';
  const statuses: number[] = [];
  for (let index = 0; index < 12; index += 1) {
    const response = await stopSip(room, phone);
    statuses.push(response.status);
    assert.ok(!response.text.includes(phone), 'rejection never echoes the raw number');
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(400), 'first 10 attempts are rejected as before');
  assert.deepEqual(statuses.slice(10), [429, 429], 'requests after the stop limit return 429');
  const limited = await stopSip(room, phone);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'rate_limited');

  const audit = await ts.api('GET', '/v1/admin/audit?type=sip.dialin.failed&limit=100', { headers: ADMIN });
  const entries = audit.body.entries.filter(
    (item: any) => item.roomId === room.roomId && item.details?.action === 'stop',
  );
  assert.equal(entries.length, 10, 'only attempts that passed the limiter are audited');
  assert.ok(!JSON.stringify(audit.body).includes(phone), 'audit contains no raw number');
  assert.ok(!logLines.join('\n').includes(phone), 'logs contain no raw number');
});

test('SIP dial-in: dtmf is forwarded to LiveKit and never audited or logged', async () => {
  await configureSip('demo');
  const room = await createRoom();
  requests = [];
  const ok = await dial(room, { number: DEMO_NUMBER, dtmf: 'w123#' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const create = requests.find((entry) => entry.method === 'CreateSIPParticipant');
  assert.ok(create, 'CreateSIPParticipant was called');
  assert.equal(create.body.dtmf, 'w123#', 'dtmf digits are forwarded for the IVR/lab leg');
  assert.equal(ok.body.dtmf, undefined, 'digits are not echoed in the response');
  assert.ok(!JSON.stringify(ok.body).includes('w123#'));
  const audit = await ts.api('GET', '/v1/admin/audit?type=sip.dialin.started&limit=100', { headers: ADMIN });
  assert.ok(!JSON.stringify(audit.body).includes('w123#'), 'digits are never audited');
  assert.ok(!logLines.join('\n').includes('w123#'), 'digits are never logged');

  // Invalid DTMF is rejected before any gateway call.
  requests = [];
  for (const dtmf of ['123456789012345678901234567890123', 'abc', '1;2', '123 456']) {
    const bad = await dial(room, { number: DEMO_NUMBER, dtmf });
    assert.equal(bad.status, 400, `dtmf=${dtmf} must be rejected`);
    assert.equal(bad.body.error.code, 'validation_failed');
  }
  assert.equal(requests.filter((entry) => entry.method === 'CreateSIPParticipant').length, 0);
});

test('SIP maxConcurrent: the local fallback drops identities LiveKit no longer reports', async () => {
  await configureSip('demo', { maxConcurrent: 1 });
  const room = await createRoom();
  const first = await dial(room, { number: DEMO_NUMBER });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  // The callee hung up on its own: the gateway no longer lists the participant.
  participants.set(roomName(room), []);
  // A successful list reconciles the local fallback used when listing fails.
  assert.equal((await listSip(room)).status, 200);

  failList = true;
  const second = await dial(room, { number: '+74951112233' });
  assert.equal(second.status, 200, `stale identity must not count: ${JSON.stringify(second.body)}`);
});

test('SIP inbound phone-like identity: masked in list, stoppable by opaque participant id', async () => {
  await configureSip('demo');
  const room = await createRoom();
  const phone = '+74951234567';
  participants.set(roomName(room), [
    {
      sid: 'PA_inbound_1',
      identity: phone,
      // LiveKit synthesizes this name for inbound callers; it embeds the number
      // and must be masked as well (a whole-string phone check is not enough).
      name: `Phone ${phone}`,
      kind: 'SIP',
      state: 'ACTIVE',
      joined_at: String(Math.floor(Date.now() / 1000)),
      attributes: { 'sip.callID': 'SC_inbound' },
    },
  ]);

  const listed = await listSip(room);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.participants.length, 1);
  const entry = listed.body.participants[0];
  assert.equal(entry.id, 'PA_inbound_1', 'the opaque LiveKit participant id is the stop handle');
  assert.match(entry.identity, /^\+7•+67$/, 'phone identity is masked');
  assert.match(entry.name, /^Phone \+7•+67$/, 'the number embedded in the display name is masked');
  assert.equal(entry.masked, true);
  assert.ok(!JSON.stringify(listed.body).includes(phone), 'the raw number is never returned');

  // A masked identity / raw number is not accepted as a stop id.
  assert.equal((await stopSip(room, phone)).status, 400);
  assert.equal((await stopSip(room, entry.identity)).status, 400);

  const stopped = await stopSip(room, 'PA_inbound_1');
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  const remove = requests.filter((item) => item.method === 'RemoveParticipant').pop();
  assert.ok(remove, 'RemoveParticipant was called');
  assert.equal(remove.body.identity, phone, 'the number is resolved server-side only');

  const stopAudit = await ts.api('GET', '/v1/admin/audit?type=sip.dialin.stopped&limit=100', { headers: ADMIN });
  assert.ok(!JSON.stringify(stopAudit.body).includes(phone), 'audit only carries the opaque handle');
  assert.ok(!logLines.join('\n').includes(phone), 'logs never carry the number');
});
