/** LiveKit Egress Twirp controller: start/list/stop, gating, E2EE, redaction. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { startTestServer, type TestServer } from './helpers.js';
import { sanitizeEgressErrorText } from '../src/egress.js';
import { createLogger } from '../src/logger.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const ACME = { 'x-api-key': 'acme-key' };
const STREAM_KEY = 'super-secret-stream-key';
const RTMP = `rtmp://live.example/app/${STREAM_KEY}`;
let ts: TestServer;
let twirp: Server;
let twirpUrl = '';
let requests: Array<{ method: string; body: Record<string, any>; auth: string }> = [];
let failStart = false;
/** Raw upstream `msg` for the next failing start (P1-1 canary). */
let failStartEcho: string | null = null;
/** Every log line the app emitted (asserts the key never reaches a log). */
const logLines: string[] = [];
let items: Array<Record<string, unknown>> = [];
let invalidBodies: string[] = [];

/**
 * Minimal protojson-shaped validator for `StartRoomCompositeEgress`.
 *
 * Twirp decodes the JSON body with protojson, which rejects unknown fields and
 * invalid enum names. The old mock accepted anything, so `protocol: "rtmp"` and
 * `segment_outputs[].kind` passed the tests while failing against a real SFU.
 * This validator makes the mock fail closed the same way.
 */
function rejectUnknown(value: Record<string, unknown>, allowed: string[], path: string): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return `${path}.${key} is not a valid Egress field`;
  }
  return null;
}

function validateOutputList(
  request: Record<string, any>,
  field: 'file_outputs' | 'stream_outputs' | 'segment_outputs',
  allowed: string[],
  check: (entry: Record<string, any>, path: string) => string | null,
): string | null {
  if (request[field] === undefined) return null;
  if (!Array.isArray(request[field])) return `request.${field} must be an array`;
  for (let index = 0; index < request[field].length; index += 1) {
    const entry = request[field][index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return `request.${field}[${index}] must be an object`;
    const unknown = rejectUnknown(entry as Record<string, unknown>, allowed, `request.${field}[${index}]`);
    if (unknown) return unknown;
    const invalid = check(entry as Record<string, any>, `request.${field}[${index}]`);
    if (invalid) return invalid;
  }
  return null;
}

function validateStartBody(request: Record<string, any>): string | null {
  const unknown = rejectUnknown(
    request,
    ['room_name', 'layout', 'audio_only', 'file_outputs', 'stream_outputs', 'segment_outputs', 'image_outputs', 'preset', 'advanced'],
    'request',
  );
  if (unknown) return unknown;
  if ('room_name' in request && typeof request.room_name !== 'string') return 'request.room_name must be a string';
  if ('layout' in request && typeof request.layout !== 'string') return 'request.layout must be a string';
  if ('audio_only' in request && typeof request.audio_only !== 'boolean') return 'request.audio_only must be a bool';

  const fileError = validateOutputList(
    request,
    'file_outputs',
    ['file_type', 'filepath', 'disable_manifest', 's3', 'gcp', 'azure', 'aliOSS'],
    (entry, path) => {
      if ('file_type' in entry && !['DEFAULT_FILETYPE', 'MP4', 'OGG', 'MP3'].includes(entry.file_type)) {
        return `${path}.file_type has an invalid EncodedFileType value`;
      }
      return null;
    },
  );
  if (fileError) return fileError;

  const streamError = validateOutputList(request, 'stream_outputs', ['protocol', 'urls'], (entry, path) => {
    if (!['RTMP', 'SRT', 'WEBSOCKET'].includes(entry.protocol)) {
      return `${path}.protocol must be a StreamProtocol name (RTMP/SRT/WEBSOCKET), got ${JSON.stringify(entry.protocol)}`;
    }
    if (!Array.isArray(entry.urls) || entry.urls.length === 0 || entry.urls.some((url: unknown) => typeof url !== 'string')) {
      return `${path}.urls must be a non-empty array of strings`;
    }
    return null;
  });
  if (streamError) return streamError;

  const segmentError = validateOutputList(
    request,
    'segment_outputs',
    [
      'protocol',
      'filename_prefix',
      'playlist_name',
      'live_playlist_name',
      'segment_duration',
      'filename_suffix',
      'disable_manifest',
      's3',
      'gcp',
      'azure',
      'aliOSS',
    ],
    (entry, path) => {
      if (!['DEFAULT_SEGMENTED_FILE_PROTOCOL', 'HLS_PROTOCOL'].includes(entry.protocol)) {
        return `${path}.protocol must be a SegmentedFileProtocol name (DEFAULT_SEGMENTED_FILE_PROTOCOL/HLS_PROTOCOL)`;
      }
      if ('segment_duration' in entry && (!Number.isInteger(entry.segment_duration) || entry.segment_duration <= 0)) {
        return `${path}.segment_duration must be a positive integer`;
      }
      return null;
    },
  );
  if (segmentError) return segmentError;
  return null;
}


function decodeJwt(token: string): Record<string, any> {
  const segment = token.replace(/^Bearer\s+/i, '').split('.')[1] ?? '';
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, any>;
}

async function setupRoom(config: Record<string, unknown> = {}): Promise<{ roomId: string; token: string }> {
  const patched = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: {
      features: { recording: true, liveStreaming: true },
      scale: { streaming: { enabled: true }, mediaMode: 'mesh' },
      mediaProcessing: { mode: 'server-assisted', egress: true },
      ...config,
    },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: `Egress ${Date.now()}` } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return { roomId: created.body.room.id, token: created.body.token };
}

async function start(room: { roomId: string; token?: string }, body: Record<string, unknown>, headers?: Record<string, string>) {
  return ts.api('POST', `/v1/rooms/${room.roomId}/egress/start`, {
    headers: headers ?? { authorization: `Bearer ${room.token}` },
    body,
  });
}

before(async () => {
  twirp = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, any>;
      const method = (req.url ?? '').split('/').pop() ?? '';
      requests.push({ method, body, auth: String(req.headers.authorization ?? '') });
      res.setHeader('content-type', 'application/json');
      if (method === 'StartRoomCompositeEgress') {
        const invalid = validateStartBody(body);
        if (invalid) {
          invalidBodies.push(invalid);
          res.statusCode = 400;
          res.end(JSON.stringify({ code: 'invalid_argument', msg: invalid }));
          return;
        }
        if (failStartEcho !== null) {
          // P1-1 repro: the upstream error echoes the full RTMP URL incl. the
          // stream key. A real LiveKit/SRS error can do the same.
          res.statusCode = 500;
          res.end(JSON.stringify({ code: 'internal', msg: failStartEcho }));
          return;
        }
        if (failStart) {
          res.statusCode = 500;
          res.end(JSON.stringify({ code: 'internal', msg: 'worker exploded' }));
          return;
        }
        const egressId = `EG_${body.room_name}_${requests.length}`;
        items = [{ egress_id: egressId, room_name: body.room_name, status: 'EGRESS_ACTIVE' }];
        res.end(JSON.stringify({ egress_id: egressId, status: 'EGRESS_STARTING' }));
        return;
      }
      if (method === 'ListEgress') {
        res.end(JSON.stringify({ items: body.active ? items : items.filter((item) => item.room_name === body.room_name) }));
        return;
      }
      if (method === 'StopEgress') {
        res.end(JSON.stringify({ egress_id: body.egress_id, status: 'EGRESS_COMPLETE' }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => twirp.listen(0, '127.0.0.1', () => resolve()));
  twirpUrl = `http://127.0.0.1:${(twirp.address() as { port: number }).port}`;
  ts = await startTestServer({
    egressUrl: twirpUrl,
    egressApiKey: 'egress-key',
    egressApiSecret: 'egress-secret',
    egressEnabled: true,
    // Collect every log line: P1-1 asserts a stream key never reaches a log.
    logger: createLogger({ sink: (line) => logLines.push(line) }),
  });
});

after(async () => {
  await ts.close();
  await new Promise<void>((resolve) => twirp.close(() => resolve()));
});

test('egress auth/gating: guest forbidden, feature/streaming gate, e2ee 409, disabled 501', async () => {
  const room = await setupRoom();
  const list = () => ts.api('GET', `/v1/rooms/${room.roomId}/egress`, { headers: ADMIN });
  const guest = await ts.api('POST', `/v1/rooms/${room.roomId}/join`, { body: { name: 'Guest' } });
  assert.equal((await start(room, { kind: 'recording' }, { authorization: `Bearer ${guest.body.token}` })).status, 403);

  await ts.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { features: { recording: false } } });
  const noFeature = await start(room, { kind: 'recording' });
  assert.equal(noFeature.status, 403);
  assert.equal(noFeature.body.error.code, 'feature_disabled');
  const restricted = await list();
  assert.equal(restricted.status, 200, restricted.text);
  assert.deepEqual(restricted.body.startRestrictions, { recording: 'feature_disabled', rtmp: null, hls: null });

  await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { features: { recording: true }, scale: { streaming: { enabled: false } }, mediaProcessing: { mode: 'server-assisted', egress: false } },
  });
  assert.equal((await start(room, { kind: 'recording' })).status, 403, 'recording needs egress or streaming');
  assert.deepEqual((await list()).body.startRestrictions,
    { recording: 'feature_disabled', rtmp: 'feature_disabled', hls: 'feature_disabled' });

  await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { scale: { streaming: { enabled: true }, mediaMode: 'sfu' }, security: { e2ee: true } },
  });
  const e2ee = await start(room, { kind: 'rtmp', rtmpUrl: RTMP });
  assert.equal(e2ee.status, 409);
  assert.equal(e2ee.body.error.code, 'e2ee_incompatible');
  assert.deepEqual((await list()).body.startRestrictions,
    { recording: 'e2ee_incompatible', rtmp: 'e2ee_incompatible', hls: 'e2ee_incompatible' });

  const disabled = await startTestServer({ egressEnabled: false });
  try {
    const created = await disabled.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Disabled egress' } });
    const response = await disabled.api('POST', `/v1/rooms/${created.body.room.id}/egress/start`, {
      headers: { authorization: `Bearer ${created.body.token}` },
      body: { kind: 'recording' },
    });
    assert.equal(response.status, 501);
    assert.equal(response.body.error.code, 'egress_disabled');
  } finally {
    await disabled.close();
  }
});

test('optional Egress node binding gates new work while leaving existing jobs manageable', async () => {
  const nodeId = 'qa-managed-egress';
  const room = await setupRoom({ security: { e2ee: false }, mediaProcessing: { egress: true, egressNodeId: nodeId } });
  const report = { id: 'egress', image: 'agil/node-egress:0.1.0', status: 'running', health: 'healthy' };
  const recorder = { id: 'recorder', image: 'agil/node-recorder:0.1.0', status: 'running', health: 'healthy' };
  const enroll = async (headers: Record<string, string>) => {
    const enrolled = await ts.api('POST', '/v1/admin/cluster/tokens', { headers, body: { kind: 'node', role: 'sfu' } });
    assert.equal(enrolled.status, 201, enrolled.text);
    const registered = await ts.api('POST', '/v1/nodes/register', { body: { token: enrolled.body.token, role: 'sfu', nodeId } });
    assert.equal(registered.status, 201, registered.text);
    return registered.body.nodeKey as string;
  };
  const heartbeat = (key: string, status: string) => ts.api('POST', `/v1/nodes/${nodeId}/heartbeat`, {
    headers: { 'x-node-token': key }, body: { status: 'online', modules: [{ ...report, status }, recorder] },
  });
  const setBinding = (id: string) => ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN, body: { mediaProcessing: { egressNodeId: id } },
  });
  const startCount = () => requests.filter(({ method }) => method === 'StartRoomCompositeEgress').length;
  const assertStatus = async (available: boolean) => {
    const response = await ts.api('GET', '/v1/admin/egress/status', { headers: ADMIN });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.startNodeAvailable, available);
    assert.equal(response.body.enabled, true, 'blocking new jobs does not disable the controller');
  };
  const assertUnavailable = async (body: Record<string, unknown>) => {
    const before = startCount();
    const blocked = await start(room, body);
    assert.equal(blocked.status, 503, blocked.text);
    assert.equal(blocked.body.error.code, 'egress_node_unavailable');
    assert.equal(startCount(), before);
  };
  try {
    assert.equal((await setBinding('https://invalid')).status, 400);
    const foreignKey = await enroll(ACME);
    assert.equal((await heartbeat(foreignKey, 'running')).status, 200);
    await assertStatus(false);
    await assertUnavailable({ kind: 'recording' });

    const key = await enroll(ADMIN);
    await assertUnavailable({ kind: 'recording' });
    assert.equal((await heartbeat(key, 'running')).status, 200);
    await assertStatus(true);
    const first = await start(room, { kind: 'recording' });
    assert.equal(first.status, 200, first.text);

    const setModulePolicy = (enabled: boolean) => ts.api('PATCH', `/v1/admin/nodes/${nodeId}`, {
      headers: ADMIN, body: { moduleEnabled: { egress: enabled } },
    });
    const disabled = await setModulePolicy(false);
    assert.equal(disabled.status, 200, disabled.text);
    assert.deepEqual(disabled.body.node.availableModules, ['recorder']);
    assert.equal(disabled.body.node.modules.find(({ id }: { id: string }) => id === 'egress').status, 'running');
    await assertStatus(false);
    await assertUnavailable({ kind: 'rtmp', rtmpUrl: RTMP });

    const egressStopped = await heartbeat(key, 'stopped');
    assert.equal(egressStopped.status, 200);
    assert.deepEqual(egressStopped.body.node.availableModules, ['recorder']);
    await assertUnavailable({ kind: 'recording' });
    await assertUnavailable({ kind: 'rtmp', rtmpUrl: RTMP });
    await assertUnavailable({ kind: 'hls' });
    const stopped = await ts.api('POST', `/v1/rooms/${room.roomId}/egress/${encodeURIComponent(first.body.egressId)}/stop`, {
      headers: { authorization: `Bearer ${room.token}` },
    });
    assert.equal(stopped.status, 200, stopped.text);
    assert.ok(requests.some(({ method, body }) => method === 'StopEgress' && body.egress_id === first.body.egressId));

    assert.equal((await setModulePolicy(true)).status, 200);
    await assertStatus(false);
    assert.equal((await heartbeat(key, 'running')).status, 200);
    await assertStatus(true);
    assert.equal((await start(room, { kind: 'hls' })).status, 200);
    assert.equal((await ts.api('POST', `/v1/admin/nodes/${nodeId}/drain`, { headers: ADMIN, body: { drain: true } })).status, 200);
    await assertUnavailable({ kind: 'hls' });
    assert.equal((await setBinding('')).status, 200);
    await assertStatus(true);
    assert.equal((await start(room, { kind: 'hls' })).status, 200);
  } finally {
    assert.equal((await setBinding('')).status, 200);
  }
});

test('egress start: recording/rtmp/hls Twirp bodies, JWT roomRecord, no stream key leakage', async () => {
  const room = await setupRoom();
  requests = [];
  invalidBodies = [];
  failStart = false;

  const recording = await start(room, { kind: 'recording', layout: 'speaker', audioOnly: true });
  assert.equal(recording.status, 200, JSON.stringify(recording.body));
  assert.equal(recording.body.kind, 'recording');
  assert.ok(recording.body.egressId);
  const recRequest = requests.find((entry) => entry.method === 'StartRoomCompositeEgress')!;
  assert.equal(recRequest.body.room_name, `demo__${room.roomId}`);
  assert.equal(recRequest.body.layout, 'speaker');
  assert.equal(recRequest.body.audio_only, true);
  assert.equal(recRequest.body.file_outputs[0].file_type, 'MP4');
  assert.match(recRequest.body.file_outputs[0].filepath, /\.mp4$/);
  const jwt = decodeJwt(recRequest.auth);
  assert.equal(jwt.video.room, `demo__${room.roomId}`);
  assert.equal(jwt.video.roomRecord, true);
  assert.equal(jwt.iss, 'egress-key');

  requests = [];
  const rtmp = await start(room, { kind: 'rtmp', rtmpUrl: RTMP });
  assert.equal(rtmp.status, 200, JSON.stringify(rtmp.body));
  const rtmpRequest = requests.find((entry) => entry.method === 'StartRoomCompositeEgress')!;
  assert.deepEqual(rtmpRequest.body.stream_outputs, [{ protocol: 'RTMP', urls: [RTMP] }]);
  assert.ok(!JSON.stringify(rtmp.body).includes(STREAM_KEY));
  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
  const auditText = JSON.stringify(audit.body);
  assert.ok(!auditText.includes(STREAM_KEY), 'stream key is not written to audit');
  assert.ok(auditText.includes('rtmp://live.example/…'), 'host-only redaction in audit');

  requests = [];
  const hls = await start(room, { kind: 'hls', audioOnly: false });
  assert.equal(hls.status, 200, JSON.stringify(hls.body));
  const hlsRequest = requests.find((entry) => entry.method === 'StartRoomCompositeEgress')!;
  const segment = hlsRequest.body.segment_outputs[0];
  assert.equal(segment.protocol, 'HLS_PROTOCOL');
  assert.equal(segment.kind, undefined, 'SegmentedFileOutput has no `kind` field');
  assert.equal(segment.playlist_name, 'index.m3u8');
  assert.equal(segment.live_playlist_name, 'live.m3u8');
  assert.equal(segment.segment_duration, 2);
  assert.deepEqual(invalidBodies, [], `mock Twirp rejected an app request: ${invalidBodies.join('; ')}`);

  const invalid = await start(room, { kind: 'rtmp', rtmpUrl: 'http://insecure.example/key' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'validation_failed');
});

test('mock Twirp validator rejects the old invalid egress shape (regression guard)', () => {
  assert.equal(validateStartBody({ room_name: 'room', stream_outputs: [{ protocol: 'RTMP', urls: ['rtmp://host/app/key'] }] }), null);
  assert.equal(validateStartBody({ room_name: 'room', segment_outputs: [{ protocol: 'HLS_PROTOCOL' }] }), null);
  assert.match(
    validateStartBody({ room_name: 'room', stream_outputs: [{ protocol: 'rtmp', urls: ['rtmp://host/app/key'] }] }) ?? '',
    /protocol must be a StreamProtocol name/,
  );
  assert.match(
    validateStartBody({ room_name: 'room', segment_outputs: [{ kind: 'HLS', playlist_name: 'index.m3u8' }] }) ?? '',
    /kind is not a valid Egress field/,
  );
});

test('egress list/stop proxy Twirp and redact stream URLs; admin status', async () => {
  const room = await setupRoom();
  const otherRoom = await setupRoom();
  requests = [];
  assert.equal((await start(room, { kind: 'rtmp', rtmpUrl: RTMP })).status, 200);
  items = [{ egress_id: 'EG_list', room_name: `demo__${room.roomId}`, status: 'EGRESS_ACTIVE', stream: { url: RTMP } }];
  const list = await ts.api('GET', `/v1/rooms/${room.roomId}/egress`, { headers: { authorization: `Bearer ${room.token}` } });
  assert.equal(list.status, 200);
  assert.equal(list.body.egress.length, 1);
  assert.ok(!JSON.stringify(list.body).includes(STREAM_KEY), 'list response redacts stream URLs');
  const listRequest = requests.find((entry) => entry.method === 'ListEgress')!;
  assert.equal(listRequest.body.room_name, `demo__${room.roomId}`);

  const outOfRoom = await ts.api('POST', `/v1/rooms/${otherRoom.roomId}/egress/EG_list/stop`, {
    headers: { authorization: `Bearer ${otherRoom.token}` },
  });
  assert.equal(outOfRoom.status, 404);
  assert.equal(requests.some((entry) => entry.method === 'StopEgress'), false);

  const stopped = await ts.api('POST', `/v1/rooms/${room.roomId}/egress/EG_list/stop`, {
    headers: { authorization: `Bearer ${room.token}` },
  });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.status, 'stopped');
  assert.equal(requests.find((entry) => entry.method === 'StopEgress')!.body.egress_id, 'EG_list');

  const status = await ts.api('GET', '/v1/admin/egress/status', { headers: ADMIN });
  assert.equal(status.status, 200);
  assert.equal(status.body.configured, true);
  assert.equal(status.body.enabled, true);
  assert.equal(status.body.urlConfigured, true);
  assert.equal(typeof status.body.activeCount, 'number');
  assert.ok(!JSON.stringify(status.body).includes('egress-secret'));
  assert.ok(!JSON.stringify(status.body).includes(twirpUrl), 'Twirp URL is not exposed');
});

test('egress start honours the moderator token feature list', async () => {
  const { roomId } = await setupRoom();
  const issued = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Limited moderator', role: 'moderator' }, permissions: ['chat'] },
  });
  assert.equal(issued.status, 200);
  const reply = await start({ roomId, token: issued.body.token }, { kind: 'recording' });
  assert.equal(reply.status, 403);
  assert.equal(reply.body.error.code, 'feature_disabled');
});

test('admin cleanup: dry-run first, tenant-scoped, apply stops only stale jobs', async () => {
  const room = await setupRoom();
  const old = String((Date.now() - 5 * 3600 * 1000) * 1e6);
  const fresh = String((Date.now() - 60 * 1000) * 1e6);
  items = [
    { egress_id: 'EG_old', room_name: `demo__${room.roomId}`, status: 'EGRESS_ACTIVE', started_at: old },
    { egress_id: 'EG_fresh', room_name: `demo__${room.roomId}`, status: 'EGRESS_ACTIVE', started_at: fresh },
    { egress_id: 'EG_unknown_age', room_name: `demo__${room.roomId}`, status: 'EGRESS_STARTING' },
    { egress_id: 'EG_foreign', room_name: 'acme__other', status: 'EGRESS_ACTIVE', started_at: old },
  ];
  requests = [];
  const dryRun = await ts.api('POST', '/v1/admin/egress/cleanup', {
    headers: ADMIN,
    body: { thresholdSec: 14400 },
  });
  assert.equal(dryRun.status, 200, JSON.stringify(dryRun.body));
  assert.equal(dryRun.body.applied, false);
  assert.deepEqual(dryRun.body.stuck.map((job: { egressId: string }) => job.egressId), ['EG_old']);
  assert.ok(
    !dryRun.body.stuck.some((job: { egressId: string }) => job.egressId === 'EG_unknown_age'),
    'a job without started_at is never treated as stuck',
  );
  assert.equal(dryRun.body.stopped.length, 0);
  assert.equal(requests.filter((entry) => entry.method === 'StopEgress').length, 0, 'dry run never stops');

  const applied = await ts.api('POST', '/v1/admin/egress/cleanup', {
    headers: ADMIN,
    body: { thresholdSec: 14400, apply: true },
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.applied, true);
  assert.deepEqual(applied.body.stopped, ['EG_old']);
  assert.ok(!applied.body.stopped.includes('EG_unknown_age'), 'unknown-age job is not stopped');
  const stops = requests.filter((entry) => entry.method === 'StopEgress');
  assert.equal(stops.length, 1);
  assert.equal(stops[0]!.body.egress_id, 'EG_old');
  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
  assert.ok(JSON.stringify(audit.body).includes('egress.cleanup'), 'cleanup is audited');
  items = [];
});

test('admin workers: optional health URL is probed without exposing the URL or secrets', async () => {
  const health = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', CpuLoad: 1.25 }));
  });
  await new Promise<void>((resolve) => health.listen(0, '127.0.0.1', () => resolve()));
  const healthUrl = `http://127.0.0.1:${(health.address() as { port: number }).port}`;
  const withHealth = await startTestServer({
    egressUrl: twirpUrl,
    egressApiKey: 'egress-key',
    egressApiSecret: 'egress-secret',
    egressEnabled: true,
    egressHealthUrl: healthUrl,
    egressPlaybackEnabled: true,
    egressS3Endpoint: 'https://storage-egress-qa.example',
    egressS3Bucket: 'qa-private-egress-assets',
    egressS3AccessKey: 'qa-egress-read-access-key',
    egressS3SecretKey: 'qa-egress-read-secret',
  });
  try {
    const response = await withHealth.api('GET', '/v1/admin/egress/workers', { headers: ADMIN });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.worker.urlConfigured, true);
    assert.equal(response.body.worker.reachable, true);
    assert.equal(response.body.worker.status, 'ok');
    assert.equal(response.body.worker.cpuLoad, 1.25);
    assert.deepEqual(response.body.playback, { enabled: true, backend: 's3' });
    assert.ok(!JSON.stringify(response.body).includes(healthUrl), 'health URL is not exposed');
    assert.ok(!JSON.stringify(response.body).includes('egress-secret'));
    for (const value of ['storage-egress-qa.example', 'qa-private-egress-assets', 'qa-egress-read-access-key', 'qa-egress-read-secret']) {
      assert.ok(!JSON.stringify(response.body).includes(value), 'playback configuration is redacted');
    }
  } finally {
    await withHealth.close();
    await new Promise<void>((resolve) => health.close(() => resolve()));
  }

  const withoutHealth = await ts.api('GET', '/v1/admin/egress/workers', { headers: ADMIN });
  assert.equal(withoutHealth.status, 200);
  assert.equal(withoutHealth.body.worker.urlConfigured, false);
  assert.equal(withoutHealth.body.worker.reachable, null);
  assert.equal(withoutHealth.body.playback.backend, 'none');
});

test('egress Twirp failure → 502 egress_failed with audit, no secrets', async () => {
  const room = await setupRoom();
  requests = [];
  failStart = true;
  try {
    const failed = await start(room, { kind: 'recording' });
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error.code, 'egress_failed');
    assert.ok(!JSON.stringify(failed.body).includes('egress-secret'));
    const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
    const kinds = audit.body.entries.map((entry: { details?: { kind?: string } }) => entry.details?.kind);
    assert.ok(kinds.includes('egress.failed'));
  } finally {
    failStart = false;
  }
});

test('sanitizeEgressErrorText redacts RTMP keys, URLs, credentials and bearer tokens', () => {
  const raw = [
    `egress failed for ${RTMP}`,
    'and rtmps://user:pass@live.example/app/KEY2?token=abc',
    'GET https://s3.example.com/bucket/obj?X-Amz-Signature=deadbeefcafe failed',
    'Authorization: Bearer eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM',
    'password=hunter2&api_key=AKIA123&stream_key=zzz',
  ].join(' ');
  const clean = sanitizeEgressErrorText(raw);
  for (const secret of ['super-secret-stream-key', 'KEY2', 'user:pass', 'deadbeefcafe', 'hunter2', 'AKIA123', 'zzz', 'SflKxwRJSM']) {
    assert.ok(!clean.includes(secret), `${secret} must be redacted: ${clean}`);
  }
  assert.match(clean, /rtmp:\/\/live\.example\/…/);
  assert.match(clean, /https:\/\/s3\.example\.com\/…/);
  assert.ok(!clean.includes('X-Amz-Signature'));
  assert.ok(clean.length <= 300, 'stored error text is bounded');

  // Non-string input must not throw and must not echo the value.
  assert.equal(sanitizeEgressErrorText({ toString: () => 'rtmp://h/a/KEY' }), 'Egress request failed');
  assert.equal(sanitizeEgressErrorText(''), 'Egress request failed');
});

test('P2-2: sanitizer covers any scheme authority, generic short names and percent-encoding', () => {
  const cases: Array<{ raw: string; secret: string; shape?: RegExp }> = [
    { raw: 'redis://:REDISPASS9876@127.0.0.1:6379/0', secret: 'REDISPASS9876', shape: /redis:\/\/127\.0\.0\.1:6379\/…/ },
    { raw: 'rediss://:REDISPASS9876@cache.internal:6380', secret: 'REDISPASS9876', shape: /rediss:\/\/cache\.internal:6380\/…/ },
    { raw: 'rtsp://rtspuser9876:RTSPPASS9876@cam.example/live', secret: 'RTSPPASS9876', shape: /rtsp:\/\/cam\.example\/…/ },
    { raw: 'srt://live.example:9000?streamid=SRTSTREAMID9876', secret: 'SRTSTREAMID9876', shape: /srt:\/\/live\.example:9000\/…/ },
    { raw: 'invalid stream key=SHORTKEY9876', secret: 'SHORTKEY9876', shape: /key=…/ },
    { raw: 'invalid pass=SHORTPASS9876', secret: 'SHORTPASS9876', shape: /pass=…/ },
    { raw: 'invalid sig=SHORTSIG9876', secret: 'SHORTSIG9876', shape: /sig=…/ },
    { raw: 'invalid streamid=SHORTID9876', secret: 'SHORTID9876' },
    { raw: 'failed rtmp%3A%2F%2Flive.example%2Fapp%2FENCODEDKEY9876', secret: 'ENCODEDKEY9876', shape: /rtmp:\/\/live\.example\/…/ },
    { raw: 'failed rtmp%253A%252F%252Flive.example%252Fapp%252FDOUBLEKEY9876', secret: 'DOUBLEKEY9876', shape: /rtmp:\/\/live\.example\/…/ },
    { raw: 'rtsp%3A%2F%2Fuser%3ARTSPPASS9876%40cam.example%2Flive', secret: 'RTSPPASS9876', shape: /rtsp:\/\/cam\.example\/…/ },
  ];
  for (const { raw, secret, shape } of cases) {
    const clean = sanitizeEgressErrorText(`StartRoomCompositeEgress failed: ${raw}`);
    assert.ok(!clean.includes(secret), `${secret} must be redacted: ${clean}`);
    if (shape) assert.match(clean, shape, `host is preserved for ${raw}: ${clean}`);
  }
  // Short values are removed by name, not only 40+ char opaque blobs.
  assert.equal(sanitizeEgressErrorText('invalid pass=SHORTPASS9876'), 'invalid pass=…');
  // A stray `%` is not valid percent-encoding and must not throw or drop text.
  assert.equal(sanitizeEgressErrorText('progress 100%'), 'progress 100%');
});

test('P2-2: punctuation inside a credential is part of the URL, not a split point', () => {
  // Each raw value used to be split at the punctuation mark: the first fragment
  // stayed (or became the "host") and the rest leaked verbatim. The whole
  // authority must be dropped, host preserved, punctuation kept as prose only.
  const cases: Array<{ raw: string; secrets: string[]; shape: RegExp }> = [
    {
      raw: 'redis://:COMMAPASS9876,COMMAFRAG9876@127.0.0.1:6379/0',
      secrets: ['COMMAPASS9876', 'COMMAFRAG9876'],
      shape: /redis:\/\/127\.0\.0\.1:6379\/…/,
    },
    {
      raw: 'redis://:SEMIPASS9876;SEMIFRAG9876@127.0.0.1:6379/0',
      secrets: ['SEMIPASS9876', 'SEMIFRAG9876'],
      shape: /redis:\/\/127\.0\.0\.1:6379\/…/,
    },
    {
      raw: 'redis://:PARENPASS9876)PARENFRAG9876@127.0.0.1:6379/0',
      secrets: ['PARENPASS9876', 'PARENFRAG9876'],
      shape: /redis:\/\/127\.0\.0\.1:6379\/…/,
    },
    {
      raw: 'redis://:BRACKETPASS9876]BRACKETFRAG9876@127.0.0.1:6379/0',
      secrets: ['BRACKETPASS9876', 'BRACKETFRAG9876'],
      shape: /redis:\/\/127\.0\.0\.1:6379\/…/,
    },
    {
      raw: 'redis://:BRACEPASS9876}BRACEFRAG9876@127.0.0.1:6379/0',
      secrets: ['BRACEPASS9876', 'BRACEFRAG9876'],
      shape: /redis:\/\/127\.0\.0\.1:6379\/…/,
    },
    {
      raw: 'redis://:ENCPASS9876%2CENCFRAG9876@127.0.0.1:6379/0',
      secrets: ['ENCPASS9876', 'ENCFRAG9876'],
      shape: /redis:\/\/127\.0\.0\.1:6379\/…/,
    },
    {
      // A decoded slash would end the authority; the later `@host` is still
      // the real host and must survive the fallback.
      raw: 'redis://:SLASHPASS9876%2FSLASHFRAG9876@127.0.0.1:6379/0',
      secrets: ['SLASHPASS9876', 'SLASHFRAG9876'],
      shape: /redis:\/\/127\.0\.0\.1:6379\/…/,
    },
    {
      raw: 'https://host/path?token=SRTQUERY9876,SRTVALUE9876',
      secrets: ['SRTQUERY9876', 'SRTVALUE9876'],
      shape: /https:\/\/host\/…/,
    },
    {
      raw: 'srt://host:9000?streamid=SRTKEY9876,SRTVAL9876',
      secrets: ['SRTKEY9876', 'SRTVAL9876'],
      shape: /srt:\/\/host:9000\/…/,
    },
  ];
  for (const { raw, secrets, shape } of cases) {
    const clean = sanitizeEgressErrorText(`StartRoomCompositeEgress failed: ${raw}`);
    for (const secret of secrets) {
      assert.ok(!clean.includes(secret), `${secret} must be redacted: ${clean}`);
    }
    assert.match(clean, shape, `host is preserved and the URL is whole for ${raw}: ${clean}`);
  }

  // Sentence punctuation is peeled after parsing and re-appended, so prose
  // around the URL keeps its closing mark without splitting the credential.
  assert.equal(
    sanitizeEgressErrorText('StartRoomCompositeEgress failed: (see redis://:COMMAPASS9876,COMMAFRAG9876@host:6379/0).'),
    'StartRoomCompositeEgress failed: (see redis://host:6379/…).',
  );
  assert.equal(
    sanitizeEgressErrorText('redis://:COMMAPASS9876,COMMAFRAG9876@host, then failed'),
    'redis://host/…, then failed',
  );
  // A bare host stays host-only and the trailing full stop stays in the prose.
  assert.equal(sanitizeEgressErrorText('redis://:COMMAPASS9876,COMMAFRAG9876@host.'), 'redis://host/….');
  // Percent-encoded whitespace in a credential cannot split it either (the
  // space is only restored after the URL authority has been redacted).
  assert.equal(sanitizeEgressErrorText('redis://:PASSPART9876%20FRAGMENT9876@host:6379/0'), 'redis://host:6379/…');
});

test('P1-1: an upstream error that echoes the RTMP URL is sanitized and tenant-scoped', async () => {
  const room = await setupRoom();
  failStartEcho = `StartRoomCompositeEgress failed: could not connect to ${RTMP}: stream key invalid`;
  logLines.length = 0;
  try {
    const failed = await start(room, { kind: 'rtmp', rtmpUrl: RTMP });
    assert.equal(failed.status, 502, JSON.stringify(failed.body));
    assert.equal(failed.body.error.code, 'egress_failed');
    const responseText = JSON.stringify(failed.body);
    assert.ok(!responseText.includes(STREAM_KEY), 'start response must not echo the stream key');
    assert.match(String(failed.body.error.message), /rtmp:\/\/live\.example\/…/, 'host-only redaction in the error');

    // /status and /workers are tenant-scoped: the demo tenant sees its own
    // sanitized failure; acme must not see the demo failure text at all.
    const demoStatus = await ts.api('GET', '/v1/admin/egress/status', { headers: ADMIN });
    assert.equal(demoStatus.status, 200);
    assert.ok(!JSON.stringify(demoStatus.body).includes(STREAM_KEY));
    assert.match(String(demoStatus.body.lastError), /rtmp:\/\/live\.example\/…/);

    const demoWorkers = await ts.api('GET', '/v1/admin/egress/workers', { headers: ADMIN });
    assert.equal(demoWorkers.status, 200);
    assert.ok(!JSON.stringify(demoWorkers.body).includes(STREAM_KEY));
    assert.match(String(demoWorkers.body.lastError), /rtmp:\/\/live\.example\/…/);

    const acmeStatus = await ts.api('GET', '/v1/admin/egress/status', { headers: ACME });
    assert.equal(acmeStatus.status, 200, JSON.stringify(acmeStatus.body));
    assert.equal(acmeStatus.body.lastError, null, 'another tenant must not see the demo lastError');
    assert.ok(!JSON.stringify(acmeStatus.body).includes(STREAM_KEY));
    assert.ok(!JSON.stringify(acmeStatus.body).includes('could not connect'), 'no cross-tenant error text');

    const acmeWorkers = await ts.api('GET', '/v1/admin/egress/workers', { headers: ACME });
    assert.equal(acmeWorkers.status, 200);
    assert.equal(acmeWorkers.body.lastError, null);
    assert.ok(!JSON.stringify(acmeWorkers.body).includes(STREAM_KEY));

    // The audit trail keeps the failure (for the owning tenant) without the key.
    const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
    const auditText = JSON.stringify(audit.body);
    assert.ok(!auditText.includes(STREAM_KEY), 'stream key is not written to audit');
    assert.ok(auditText.includes('rtmp://live.example/…'), 'host-only redaction in audit');

    // No log line (Twirp warn + 502 error log) may contain the key.
    const logs = logLines.join('\n');
    assert.ok(!logs.includes(STREAM_KEY), `stream key leaked to a log line: ${logs.slice(0, 400)}`);
    assert.match(logs, /egress Twirp error/, 'the sanitized upstream detail is still logged for operators');
  } finally {
    failStartEcho = null;
  }
});

test('P2-2: handler canaries (redis/rtsp/srt/short key/percent-encoded/punctuated) never reach response, status, audit or log', async () => {
  const room = await setupRoom();
  const cases: Array<{ raw: string; secrets: string[]; shape?: RegExp }> = [
    { raw: 'redis://:REDISPASS9876@127.0.0.1:6379/0', secrets: ['REDISPASS9876'], shape: /redis:\/\/127\.0\.0\.1:6379\/…/ },
    { raw: 'rtsp://QAUSER9876:RTSPPASS9876@cam.example/live', secrets: ['RTSPPASS9876', 'QAUSER9876'], shape: /rtsp:\/\/cam\.example\/…/ },
    { raw: 'srt://live.example:9000?streamid=SRTSTREAMID9876', secrets: ['SRTSTREAMID9876'], shape: /srt:\/\/live\.example:9000\/…/ },
    { raw: 'invalid stream key=SHORTKEY9876', secrets: ['SHORTKEY9876'], shape: /key=…/ },
    { raw: 'invalid pass=SHORTPASS9876', secrets: ['SHORTPASS9876'], shape: /pass=…/ },
    { raw: 'invalid sig=SHORTSIG9876', secrets: ['SHORTSIG9876'], shape: /sig=…/ },
    { raw: 'failed rtmp%3A%2F%2Flive.example%2Fapp%2FENCODEDKEY9876', secrets: ['ENCODEDKEY9876'], shape: /rtmp:\/\/live\.example\/…/ },
    // P2-2 punctuation canaries: a credential containing `, ; )` or a
    // percent-encoded comma must be redacted whole, not split into fragments.
    {
      raw: 'redis://:CANARYCOMMA9876,COMMAFRAG9876@127.0.0.1:6379/0',
      secrets: ['CANARYCOMMA9876', 'COMMAFRAG9876'],
      shape: /redis:\/\/127\.0\.0\.1:6379\/…/,
    },
    {
      raw: 'redis://:CANARYSEMI9876;SEMIFRAG9876@127.0.0.1:6379/0',
      secrets: ['CANARYSEMI9876', 'SEMIFRAG9876'],
      shape: /redis:\/\/127\.0\.0\.1:6379\/…/,
    },
    {
      raw: 'redis://:CANARYPAREN9876)PARENFRAG9876@127.0.0.1:6379/0',
      secrets: ['CANARYPAREN9876', 'PARENFRAG9876'],
      shape: /redis:\/\/127\.0\.0\.1:6379\/…/,
    },
    {
      raw: 'redis://:CANARYENC9876%2CENCFRAG9876@127.0.0.1:6379/0',
      secrets: ['CANARYENC9876', 'ENCFRAG9876'],
      shape: /redis:\/\/127\.0\.0\.1:6379\/…/,
    },
  ];
  logLines.length = 0;
  try {
    for (const entry of cases) {
      failStartEcho = `StartRoomCompositeEgress failed: ${entry.raw}`;
      const failed = await start(room, { kind: 'recording' });
      assert.equal(failed.status, 502, JSON.stringify(failed.body));
      assert.equal(failed.body.error.code, 'egress_failed');
      const responseText = JSON.stringify(failed.body);
      for (const secret of entry.secrets) {
        assert.ok(!responseText.includes(secret), `start response leaked ${secret}: ${responseText}`);
      }
      if (entry.shape) assert.match(String(failed.body.error.message), entry.shape);

      const demoStatus = await ts.api('GET', '/v1/admin/egress/status', { headers: ADMIN });
      assert.equal(demoStatus.status, 200);
      for (const secret of entry.secrets) {
        assert.ok(!JSON.stringify(demoStatus.body).includes(secret), `lastError leaked ${secret}`);
      }
      const demoWorkers = await ts.api('GET', '/v1/admin/egress/workers', { headers: ADMIN });
      assert.equal(demoWorkers.status, 200);
      for (const secret of entry.secrets) {
        assert.ok(!JSON.stringify(demoWorkers.body).includes(secret), `/workers leaked ${secret}`);
      }
      const acme = await ts.api('GET', '/v1/admin/egress/status', { headers: ACME });
      assert.equal(acme.status, 200);
      assert.equal(acme.body.lastError, null, 'another tenant never sees the failure');
      for (const secret of entry.secrets) {
        assert.ok(!JSON.stringify(acme.body).includes(secret));
      }

      const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
      for (const secret of entry.secrets) {
        assert.ok(!JSON.stringify(audit.body).includes(secret), `audit leaked ${secret}`);
      }
      const logs = logLines.join('\n');
      for (const secret of entry.secrets) {
        assert.ok(!logs.includes(secret), `log leaked ${secret}: ${logs.slice(-300)}`);
      }
    }
  } finally {
    failStartEcho = null;
  }
});

test('P1-1: a successful start clears only that tenant lastError', async () => {
  const room = await setupRoom();
  failStartEcho = `cannot publish to ${RTMP}`;
  try {
    assert.equal((await start(room, { kind: 'rtmp', rtmpUrl: RTMP })).status, 502);
    const failedStatus = await ts.api('GET', '/v1/admin/egress/status', { headers: ADMIN });
    assert.ok(failedStatus.body.lastError);
    failStartEcho = null;
    assert.equal((await start(room, { kind: 'recording' })).status, 200);
    const cleared = await ts.api('GET', '/v1/admin/egress/status', { headers: ADMIN });
    assert.equal(cleared.body.lastError, null, 'a successful start clears the tenant lastError');
    // still nothing for acme
    const acme = await ts.api('GET', '/v1/admin/egress/status', { headers: ACME });
    assert.equal(acme.body.lastError, null);
  } finally {
    failStartEcho = null;
  }
});

test('admin egress status requires a tenant credential', async () => {
  const anonymous = await ts.api('GET', '/v1/admin/egress/status');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error.code, 'unauthorized');
});
