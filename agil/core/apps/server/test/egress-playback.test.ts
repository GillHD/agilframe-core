/**
 * Signed egress playback: HMAC token scope/expiry, HLS segment rewriting,
 * local object proxy, MP4 download, and the public API contract.
 *
 * The API test uses the same local-directory backend as an offline lab, so it
 * exercises the real handlers, real token verification and real playlists
 * without Docker/S3. S3 SigV4 URL/header construction is unit-tested.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { startTestServer, type TestServer } from './helpers.js';
import { createOpenApiSpec } from '../src/openapi.js';
import {
  EgressPlaybackService,
  artifactKeyFromEgressInfo,
  classifyRange,
  normalizeObjectKey,
  objectKeyFromLocation,
  s3ObjectUrl,
  signPlaybackToken,
  signS3Get,
  verifyPlaybackToken,
} from '../src/egress-playback.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const BUCKET = 'agil-recordings';
const SECRET = 'playback-test-secret-0123456789';
const KEY = 'demo/room-1/2026/index.m3u8';

let ts: TestServer;
let twirp: Server;
let twirpUrl = '';
let localDir = '';
let roomId = '';
let hostToken = '';
let closingRoomId = '';
let closingRoomToken = '';
let infoItems: Array<Record<string, unknown>> = [];

function service(overrides: Partial<ConstructorParameters<typeof EgressPlaybackService>[0]> = {}): EgressPlaybackService {
  return new EgressPlaybackService({
    secret: SECRET,
    defaultTtlSec: 900,
    maxTtlSec: 86400,
    localDir,
    ...overrides,
  });
}

function localPath(key: string): string {
  return path.join(localDir, ...key.split('/'));
}

test('explicit S3 does not fall back to the configured local directory', async () => {
  assert.equal(service({ backend: 'auto' }).localOnly, true);
  const playback = service({ backend: 's3' });
  assert.equal(playback.configured, false);
  await assert.rejects(playback.objectSize('demo/room/recording.mp4'), { code: 'egress_playback_not_configured' });
});

function relative(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

async function collect(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString();
}

before(async () => {
  localDir = mkdtempSync(path.join(tmpdir(), 'agil-egress-playback-'));
  twirp = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, any>;
      const method = (req.url ?? '').split('/').pop() ?? '';
      res.setHeader('content-type', 'application/json');
      if (method === 'ListEgress') {
        res.end(JSON.stringify({ items: infoItems.filter((item) => !body.room_name || item.room_name === body.room_name) }));
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
    egressPlaybackDir: localDir,
    egressPlaybackSecret: SECRET,
    egressS3Bucket: BUCKET,
  });
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Playback room' } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  roomId = created.body.room.id as string;
  hostToken = created.body.token as string;

  // A second room used to prove links outlive the in-memory room object.
  const closing = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Closing room' } });
  assert.equal(closing.status, 200, JSON.stringify(closing.body));
  closingRoomId = closing.body.room.id as string;
  closingRoomToken = closing.body.token as string;

  const hlsKey = `demo/${roomId}/2026/index.m3u8`;
  const segmentKey = `demo/${roomId}/2026/seg000.ts`;
  mkdirSync(path.dirname(localPath(hlsKey)), { recursive: true });
  writeFileSync(
    localPath(hlsKey),
    ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXTINF:2.0,', 'seg000.ts', '#EXT-X-ENDLIST', ''].join('\n'),
    'utf8',
  );
  writeFileSync(localPath(segmentKey), 'QA_SEGMENT_BYTES', 'utf8');
  const mp4Key = `demo/${roomId}/2026/recording.mp4`;
  writeFileSync(localPath(mp4Key), 'QA_MP4_BYTES', 'utf8');

  const closingKey = `demo/${closingRoomId}/2026/index.m3u8`;
  mkdirSync(path.dirname(localPath(closingKey)), { recursive: true });
  writeFileSync(
    localPath(closingKey),
    ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXTINF:2.0,', 'seg000.ts', '#EXT-X-ENDLIST', ''].join('\n'),
    'utf8',
  );
  writeFileSync(localPath(`demo/${closingRoomId}/2026/seg000.ts`), 'QA_CLOSING_SEGMENT', 'utf8');

  infoItems = [
    {
      egress_id: 'EG_HLS',
      room_name: `demo__${roomId}`,
      status: 'EGRESS_COMPLETE',
      segment_results: [{ playlist_location: `s3://${BUCKET}/${hlsKey}` }],
      request: { segment_outputs: [{ filename_prefix: `demo/${roomId}/2026`, playlist_name: 'index.m3u8' }] },
    },
    {
      egress_id: 'EG_DELETE',
      room_name: `demo__${closingRoomId}`,
      status: 'EGRESS_COMPLETE',
      segment_results: [{ playlist_location: `s3://${BUCKET}/${closingKey}` }],
    },
    {
      egress_id: 'EG_MP4',
      room_name: `demo__${roomId}`,
      status: 'EGRESS_COMPLETE',
      file_results: [{ location: `s3://${BUCKET}/${mp4Key}` }],
      request: { file_outputs: [{ filepath: `demo/${roomId}/2026/recording.mp4` }] },
    },
    {
      egress_id: 'EG_STARTING',
      room_name: `demo__${roomId}`,
      status: 'EGRESS_STARTING',
      request: { segment_outputs: [{ filename_prefix: `demo/${roomId}/2030`, playlist_name: 'index.m3u8' }] },
    },
  ];
});

after(async () => {
  await ts.close();
  await new Promise<void>((resolve) => twirp.close(() => resolve()));
  rmSync(localDir, { recursive: true, force: true });
});

test('token: round-trip, tamper, expiry and key normalisation', () => {
  const claims = { v: 1, t: 'demo', r: 'room-1', e: 'EG_1', k: KEY, s: 'playlist' as const, x: Date.now() + 60_000 };
  const token = signPlaybackToken(SECRET, claims);
  assert.deepEqual(verifyPlaybackToken(SECRET, token), claims);
  assert.equal(verifyPlaybackToken('other-secret', token), null, 'wrong secret rejected');
  assert.equal(verifyPlaybackToken(SECRET, `${token.slice(0, -2)}xx`), null, 'tampered signature rejected');
  assert.equal(verifyPlaybackToken(SECRET, 'not-a-token'), null);
  assert.equal(verifyPlaybackToken(SECRET, 'x'.repeat(5000)), null);

  assert.equal(normalizeObjectKey('/a/b/../c.ts'), 'a/c.ts');
  assert.equal(normalizeObjectKey('../etc/passwd'), null);
  assert.equal(normalizeObjectKey('a/../../etc/passwd'), null);
  assert.equal(normalizeObjectKey('a/\u0000b'), null);
  assert.equal(objectKeyFromLocation(`s3://${BUCKET}/a/b.m3u8`, BUCKET), 'a/b.m3u8');
  assert.equal(objectKeyFromLocation(`s3://other-bucket/a/b.m3u8`, BUCKET), null);
  assert.equal(objectKeyFromLocation(`https://${BUCKET}.s3.example.com/a/b.ts`, BUCKET), 'a/b.ts');
  assert.equal(objectKeyFromLocation('https://cdn.example/foreign/b.ts', BUCKET), null);
});

test('OpenAPI: egress playback/cleanup paths and schemas are published with resolvable refs', () => {
  const full = createOpenApiSpec({ publicOrigin: 'https://calls.example', scope: 'full' });
  const published = createOpenApiSpec({ publicOrigin: 'https://calls.example', scope: 'public' });
  const fullPaths = Object.keys((full.paths ?? {}) as Record<string, unknown>);
  const publicPaths = Object.keys((published.paths ?? {}) as Record<string, unknown>);
  for (const path of [
    '/v1/rooms/{roomId}/egress/{egressId}/playback',
    '/v1/rooms/{roomId}/egress/{egressId}/playlist',
    '/v1/rooms/{roomId}/egress/{egressId}/segment',
    '/v1/rooms/{roomId}/egress/{egressId}/file',
  ]) {
    assert.ok(publicPaths.includes(path), `public spec publishes ${path}`);
  }
  // HEAD mirrors GET on the three playback routes and the Range contract is documented.
  const publishedPaths = (published.paths ?? {}) as Record<string, Record<string, any>>;
  for (const path of [
    '/v1/rooms/{roomId}/egress/{egressId}/playlist',
    '/v1/rooms/{roomId}/egress/{egressId}/segment',
    '/v1/rooms/{roomId}/egress/{egressId}/file',
  ]) {
    assert.ok(publishedPaths[path]?.get, `GET documented for ${path}`);
    assert.ok(publishedPaths[path]?.head, `HEAD documented for ${path}`);
  }
  for (const path of [
    '/v1/rooms/{roomId}/egress/{egressId}/segment',
    '/v1/rooms/{roomId}/egress/{egressId}/file',
  ]) {
    assert.ok(publishedPaths[path]?.get?.responses?.['416'], `416 documented for ${path}`);
    assert.ok(publishedPaths[path]?.get?.responses?.['206'], `206 documented for ${path}`);
  }
  const fullPathsObject = (full.paths ?? {}) as Record<string, Record<string, any>>;
  assert.match(
    String(fullPathsObject['/v1/admin/egress/status']?.get?.description ?? ''),
    /tenant/i,
    'tenant-scoped status is documented',
  );
  for (const path of ['/v1/admin/egress/workers', '/v1/admin/egress/cleanup']) {
    assert.ok(fullPaths.includes(path), `full spec publishes ${path}`);
    assert.ok(!publicPaths.includes(path), `${path} is not public`);
  }

  const schemas = (full.components as { schemas: Record<string, unknown> }).schemas;
  for (const name of [
    'EgressPlaybackLink',
    'EgressPlaybackLinkRequest',
    'EgressCleanupRequest',
    'EgressCleanupResult',
    'EgressStuckJob',
    'EgressWorkerStatus',
  ]) {
    assert.ok(name in schemas, `schema ${name} exists`);
  }
  const cleanup = (full.paths as Record<string, any>)['/v1/admin/egress/cleanup'].post.responses['200'];
  assert.deepEqual(cleanup.content['application/json'].schema, { $ref: '#/components/schemas/EgressCleanupResult' });

  // Every schema $ref used by the document must resolve (request bodies included).
  const refs = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === '$ref' && typeof entry === 'string') refs.add(entry);
      else walk(entry);
    }
  };
  walk(full);
  const missing = [...refs]
    .filter((ref) => ref.startsWith('#/components/schemas/'))
    .map((ref) => ref.slice('#/components/schemas/'.length))
    .filter((name) => !(name in schemas));
  assert.deepEqual(missing, [], 'no dangling schema refs');
});

test('playlist rewrite signs every segment with the same expiry and never leaks the key', () => {
  const svc = service();
  assert.equal(svc.ttlFor(undefined), 900, 'default TTL');
  assert.equal(svc.ttlFor(30), 60, 'TTL is clamped up to 60 s');
  assert.equal(svc.ttlFor(999_999), 86_400, 'TTL is clamped to 24 h');
  const link = svc.createLink({ tenantId: 'demo', roomId: 'room-1', egressId: 'EG_1', key: KEY, origin: 'https://calls.example' });
  assert.match(link.url, /^https:\/\/calls\.example\/v1\/rooms\/room-1\/egress\/EG_1\/playlist\?token=/);
  const claims = svc.verify({ token: decodeURIComponent(new URL(link.url).searchParams.get('token') as string), tenantId: 'demo', roomId: 'room-1', egressId: 'EG_1', scope: 'playlist' });
  const rewritten = svc.rewritePlaylist('#EXTM3U\n#EXTINF:2.0,\nseg000.ts\n#EXT-X-ENDLIST\n', claims);
  assert.match(rewritten, /#EXTM3U/);
  assert.match(rewritten, /#EXT-X-ENDLIST/);
  assert.ok(!rewritten.includes('\nseg000.ts\n'), 'relative segment URI was rewritten');
  const segmentLine = rewritten.split('\n').find((line) => line.startsWith('/v1/rooms/')) as string;
  assert.match(segmentLine, /\/segment\?token=/);
  const segmentToken = decodeURIComponent(new URL(segmentLine, 'https://x').searchParams.get('token') as string);
  const segmentClaims = verifyPlaybackToken(SECRET, segmentToken);
  assert.equal(segmentClaims?.s, 'segment');
  assert.equal(segmentClaims?.k, `demo/room-1/2026/seg000.ts`);
  assert.equal(segmentClaims?.x, claims.x, 'segment expiry equals playlist expiry');
  assert.ok(!rewritten.includes(SECRET), 'secret never enters the playlist');
});

test('playlist rewrite signs fMP4 init segments and leaves absolute CDN URIs alone', () => {
  const svc = service();
  const link = svc.createLink({ tenantId: 'demo', roomId: 'room-1', egressId: 'EG_1', key: KEY, origin: 'https://calls.example' });
  const claims = svc.verify({
    token: decodeURIComponent(new URL(link.url).searchParams.get('token') as string),
    tenantId: 'demo',
    roomId: 'room-1',
    egressId: 'EG_1',
    scope: 'playlist',
  });
  const playlist = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:2.0,',
    'seg000.ts?v=1',
    '#EXTINF:2.0,',
    'https://cdn.example.com/foreign/seg001.ts',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
  const rewritten = svc.rewritePlaylist(playlist, claims);
  const mapLine = rewritten.split('\n').find((line) => line.startsWith('#EXT-X-MAP:')) as string;
  const mapUri = /URI="([^"]+)"/.exec(mapLine)?.[1] as string;
  assert.match(mapUri, /^\/v1\/rooms\/room-1\/egress\/EG_1\/segment\?token=/);
  const mapClaims = verifyPlaybackToken(SECRET, decodeURIComponent(new URL(mapUri, 'https://x').searchParams.get('token') as string));
  assert.equal(mapClaims?.k, 'demo/room-1/2026/init.mp4');
  assert.equal(mapClaims?.s, 'segment');
  assert.equal(mapClaims?.x, claims.x, 'init segment shares the playlist expiry');
  assert.ok(rewritten.includes('https://cdn.example.com/foreign/seg001.ts'), 'absolute CDN URI is untouched');
  assert.ok(!rewritten.includes('\nseg000.ts?v=1'), 'segment query is stripped before signing');
});

test('artifact key selection prefers live playlist while active and falls back to prefix', () => {
  const active = {
    status: 'EGRESS_ACTIVE',
    segment_results: [
      { playlist_location: `s3://${BUCKET}/demo/r/final.m3u8`, live_playlist_location: `s3://${BUCKET}/demo/r/live.m3u8` },
    ],
  };
  assert.equal(artifactKeyFromEgressInfo(active, 'hls', BUCKET), 'demo/r/live.m3u8');
  const done = { ...active, status: 'EGRESS_COMPLETE' };
  assert.equal(artifactKeyFromEgressInfo(done, 'hls', BUCKET), 'demo/r/final.m3u8');
  const fallback = { status: 'EGRESS_STARTING', request: { segment_outputs: [{ filename_prefix: 'demo/r', playlist_name: 'index.m3u8' }] } };
  assert.equal(artifactKeyFromEgressInfo(fallback, 'hls', BUCKET), 'demo/r/index.m3u8');
  assert.equal(artifactKeyFromEgressInfo({ status: 'EGRESS_COMPLETE' }, 'hls', BUCKET), null);
});

test('S3 URL + SigV4: path/virtual style and no secret in headers', () => {
  assert.equal(
    s3ObjectUrl({ endpoint: 'http://127.0.0.1:9000', bucket: BUCKET, forcePathStyle: true }, 'a/b c.ts'),
    'http://127.0.0.1:9000/agil-recordings/a/b%20c.ts',
  );
  assert.equal(
    s3ObjectUrl({ endpoint: 'https://s3.example.com', bucket: BUCKET, forcePathStyle: false }, 'a/b.ts'),
    `https://${BUCKET}.s3.example.com/a/b.ts`,
  );
  const headers = signS3Get(
    { region: 'ru-msk', accessKey: 'AKIA_TEST', secretKey: 'SECRET_CANARY', sessionToken: 'SESSION_CANARY' },
    `https://${BUCKET}.s3.example.com/a/b.ts`,
    'UNSIGNED-PAYLOAD',
    'bytes=0-9',
  );
  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIA_TEST\/\d{8}\/ru-msk\/s3\/aws4_request/);
  assert.match(headers.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date;x-amz-security-token/);
  assert.equal(headers['x-amz-security-token'], 'SESSION_CANARY');
  assert.ok(!JSON.stringify(headers).includes('SECRET_CANARY'), 'secret key is not copied into headers');
});

test('S3 backend: SigV4 GET/HEAD (path-style, Range) against a signature-verifying mock', async () => {
  const region = 'ru-msk';
  const accessKey = 'AKIA_S3_MOCK';
  const secretKey = 'S3_SECRET_CANARY';
  const objects = new Map<string, Buffer>([
    ['demo/room-1/2026/index.m3u8', Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2.0,\nseg 000.ts\n#EXT-X-ENDLIST\n')],
    ['demo/room-1/2026/seg 000.ts', Buffer.from('abcdefghij')],
  ]);
  const seen: Array<{ method: string; url: string; headers: Record<string, unknown> }> = [];
  const failures: string[] = [];

  /**
   * Independent canonicalisation: recompute the SigV4 signature from what the
   * HTTP server actually received. This is the check that a live MinIO would
   * perform; it fails if the client signs a different path/header set.
   */
  const signatureProblem = (req: IncomingMessage): string | null => {
    const authorization = String(req.headers.authorization ?? '');
    const match =
      /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
        authorization,
      );
    if (!match) return 'malformed Authorization header';
    if (match[1] !== accessKey) return 'wrong access key';
    if (match[3] !== region) return 'wrong region scope';
    const signedHeaders = match[4] as string;
    const names = signedHeaders.split(';');
    const canonicalHeaders = names.map((name) => `${name}:${String(req.headers[name] ?? '')}\n`).join('');
    const payloadHash = String(req.headers['x-amz-content-sha256'] ?? '');
    const canonicalRequest = [req.method, req.url, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${match[2]}/${region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', String(req.headers['x-amz-date']), scope, createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')].join('\n');
    const hmac = (key: Buffer | string, value: string): Buffer => createHmac('sha256', key).update(value, 'utf8').digest();
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, match[2] as string), region), 's3'), 'aws4_request');
    const expected = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
    return expected === match[5] ? null : 'signature mismatch (path/header canonicalisation)';
  };

  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: { ...req.headers } });
    const problem = signatureProblem(req);
    if (problem) {
      failures.push(`${req.method} ${req.url}: ${problem}`);
      res.statusCode = 403;
      res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
      return;
    }
    const key = decodeURIComponent((req.url ?? '').replace(/^\/agil-recordings\//, '').split('?')[0] as string);
    const body = objects.get(key);
    if (!body) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', key.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
    const range = typeof req.headers.range === 'string' ? /^bytes=(\d+)-(\d+)$/.exec(req.headers.range) : null;
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), body.length - 1);
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${end}/${body.length}`);
      res.end(body.subarray(start, end + 1));
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-length', String(body.length));
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;

  const svc = new EgressPlaybackService({
    secret: SECRET,
    defaultTtlSec: 900,
    maxTtlSec: 86_400,
    s3: {
      endpoint: `http://127.0.0.1:${port}`,
      region,
      bucket: BUCKET,
      accessKey,
      secretKey,
      forcePathStyle: true,
    },
  });
  try {
    assert.equal(await svc.exists('demo/room-1/2026/index.m3u8'), true);
    assert.equal(await svc.exists('demo/room-1/2026/missing.ts'), false);

    const claims = { v: 1, t: 'demo', r: 'room-1', e: 'EG_S3', k: 'demo/room-1/2026/index.m3u8', s: 'playlist' as const, x: Date.now() + 60_000 };
    const text = await svc.playlistText(claims);
    assert.match(text, /#EXT-X-ENDLIST/);
    assert.ok(!text.includes('\nseg 000.ts\n'), 'S3 playlist segment was rewritten');
    const segmentLine = text.split('\n').find((line) => line.startsWith('/v1/rooms/')) as string;
    const segmentClaims = verifyPlaybackToken(SECRET, decodeURIComponent(new URL(segmentLine, 'https://x').searchParams.get('token') as string));
    assert.equal(segmentClaims?.k, 'demo/room-1/2026/seg 000.ts');

    const object = await svc.objectStream(segmentClaims as NonNullable<typeof segmentClaims>, 'bytes=2-5');
    assert.equal(object.status, 206);
    assert.equal(object.headers['content-range'], 'bytes 2-5/10');
    const chunks: Buffer[] = [];
    for await (const chunk of object.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    assert.equal(Buffer.concat(chunks).toString(), 'cdef');

    assert.ok(seen.some((entry) => entry.method === 'HEAD'), 'existence check used HEAD');
    assert.ok(seen.every((entry) => entry.url.startsWith(`/${BUCKET}/`)), 'path-style bucket URL');
    assert.ok(!JSON.stringify(seen).includes(secretKey), 'secret key never leaves the app');
    assert.deepEqual(failures, [], 'every request carried a valid SigV4 signature');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('API: mint signed link, serve rewritten playlist, segment and MP4 (Range)', async () => {
  const linkResponse = await ts.api('POST', `/v1/rooms/${roomId}/egress/EG_HLS/playback`, {
    headers: { authorization: `Bearer ${hostToken}` },
    body: { ttlSec: 900 },
  });
  assert.equal(linkResponse.status, 200, JSON.stringify(linkResponse.body));
  assert.equal(linkResponse.body.kind, 'hls');
  assert.match(linkResponse.body.url, /\/playlist\?token=/);
  assert.equal(linkResponse.body.ttlSec, 900);

  const playlist = await ts.api('GET', relative(linkResponse.body.url));
  assert.equal(playlist.status, 200, playlist.text);
  assert.match(String(playlist.headers.get('content-type')), /application\/vnd\.apple\.mpegurl/);
  assert.equal(playlist.headers.get('cache-control'), 'private, no-store');
  assert.match(playlist.text, /#EXT-X-ENDLIST/);
  assert.ok(!playlist.text.includes('\nseg000.ts\n'));
  const segmentPath = playlist.text.split('\n').find((line) => line.startsWith('/v1/rooms/')) as string;
  assert.ok(segmentPath, 'rewritten segment URL present');

  const segment = await ts.api('GET', segmentPath);
  assert.equal(segment.status, 200, segment.text);
  assert.equal(segment.text, 'QA_SEGMENT_BYTES');
  assert.match(String(segment.headers.get('content-type')), /video\/mp2t/);
  assert.equal(segment.headers.get('cache-control'), 'private, max-age=3600');

  const mp4Link = await ts.api('POST', `/v1/rooms/${roomId}/egress/EG_MP4/playback`, {
    headers: { authorization: `Bearer ${hostToken}` },
    body: {},
  });
  assert.equal(mp4Link.status, 200, JSON.stringify(mp4Link.body));
  assert.equal(mp4Link.body.kind, 'recording');
  const file = await ts.api('GET', relative(mp4Link.body.url), { headers: { range: 'bytes=0-3' } });
  assert.equal(file.status, 206, file.text);
  assert.equal(file.text, 'QA_M');
  assert.equal(file.headers.get('content-range'), 'bytes 0-3/12');
  assert.match(String(file.headers.get('content-disposition')), /attachment;/);

  // An out-of-range request must answer 416 with the total size, not 500/206.
  const unsatisfiable = await ts.api('GET', relative(mp4Link.body.url), { headers: { range: 'bytes=99-120' } });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */12');
});

test('API: HEAD on the S3 backend is header-only (only S3 HEADs, never a GET) (P3-14)', async () => {
  const hlsKey = 'demo/s3-room/index.m3u8';
  const fileKey = 'demo/s3-room/rec.mp4';
  const objects = new Map<string, Buffer>([
    [hlsKey, Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2.0,\nseg.ts\n#EXT-X-ENDLIST\n')],
    [fileKey, Buffer.from('0123456789')],
  ]);
  const seen: string[] = [];
  const s3 = createServer((req, res) => {
    const method = req.method ?? '';
    seen.push(`${method} ${req.url ?? ''}`);
    const key = decodeURIComponent((req.url ?? '').replace(`/${BUCKET}/`, '').split('?')[0] as string);
    const body = objects.get(key);
    if (!body) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', key.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4');
    res.setHeader('content-length', String(body.length));
    if (method === 'HEAD') {
      res.end();
      return;
    }
    res.statusCode = 200;
    res.end(body);
  });
  await new Promise<void>((resolve) => s3.listen(0, '127.0.0.1', () => resolve()));
  const port = (s3.address() as { port: number }).port;
  const s3Ts = await startTestServer({
    egressUrl: twirpUrl,
    egressApiKey: 'egress-key',
    egressApiSecret: 'egress-secret',
    egressEnabled: true,
    egressPlaybackSecret: SECRET,
    egressS3Endpoint: `http://127.0.0.1:${port}`,
    egressS3Region: 'ru-msk',
    egressS3Bucket: BUCKET,
    egressS3AccessKey: 'AKIA_S3_MOCK',
    egressS3SecretKey: 'S3_SECRET_CANARY',
    egressS3ForcePathStyle: true,
  });
  const added: Array<Record<string, unknown>> = [];
  try {
    const created = await s3Ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'S3 HEAD room' } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const roomId = created.body.room.id as string;
    const token = created.body.token as string;
    added.push(
      { egress_id: 'EG_S3_HLS', room_name: `demo__${roomId}`, status: 'EGRESS_COMPLETE', segment_results: [{ playlist_location: `s3://${BUCKET}/${hlsKey}` }] },
      { egress_id: 'EG_S3_MP4', room_name: `demo__${roomId}`, status: 'EGRESS_COMPLETE', file_results: [{ location: `s3://${BUCKET}/${fileKey}` }] },
    );
    infoItems.push(...added);

    const hls = await s3Ts.api('POST', `/v1/rooms/${roomId}/egress/EG_S3_HLS/playback`, {
      headers: { authorization: `Bearer ${token}` },
      body: {},
    });
    assert.equal(hls.status, 200, JSON.stringify(hls.body));
    seen.length = 0;
    const headPlaylist = await s3Ts.api('HEAD', relative(hls.body.url));
    assert.equal(headPlaylist.status, 200);
    assert.match(String(headPlaylist.headers.get('content-type')), /application\/vnd\.apple\.mpegurl/);
    assert.equal(headPlaylist.headers.get('content-length'), String(objects.get(hlsKey)!.length));
    assert.equal(headPlaylist.text, '');
    assert.deepEqual(seen, [`HEAD /${BUCKET}/${hlsKey}`], 'playlist HEAD is one metadata HEAD, no GET/rewrite');

    const mp4 = await s3Ts.api('POST', `/v1/rooms/${roomId}/egress/EG_S3_MP4/playback`, {
      headers: { authorization: `Bearer ${token}` },
      body: {},
    });
    assert.equal(mp4.status, 200, JSON.stringify(mp4.body));
    const mp4Path = relative(mp4.body.url);

    seen.length = 0;
    const headSegment = await s3Ts.api('HEAD', mp4Path);
    assert.equal(headSegment.status, 200);
    assert.equal(headSegment.headers.get('content-length'), '10');
    assert.equal(headSegment.text, '');
    assert.deepEqual(seen, [`HEAD /${BUCKET}/${fileKey}`]);

    seen.length = 0;
    const ranged = await s3Ts.api('HEAD', mp4Path, { headers: { range: 'bytes=2-3' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), 'bytes 2-3/10');
    assert.equal(ranged.headers.get('content-length'), '2');
    assert.equal(ranged.text, '');
    assert.deepEqual(seen, [`HEAD /${BUCKET}/${fileKey}`], 'a HEAD Range is answered from the HEAD size, no GET');

    seen.length = 0;
    const invalid = await s3Ts.api('HEAD', mp4Path, { headers: { range: 'bytes=abc' } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get('content-range'), 'bytes */10');
    assert.deepEqual(seen, [`HEAD /${BUCKET}/${fileKey}`]);

    // GET still works normally (a HEAD-only code path must not break playback).
    const get = await s3Ts.api('GET', mp4Path);
    assert.equal(get.status, 200);
    assert.equal(get.text, '0123456789');
  } finally {
    for (const item of added) {
      const index = infoItems.indexOf(item);
      if (index >= 0) infoItems.splice(index, 1);
    }
    await s3Ts.close();
    await new Promise<void>((resolve) => s3.close(() => resolve()));
  }
});

test('API: a signed link keeps working after its room is closed (restart/deploy)', async () => {
  const link = await ts.api('POST', `/v1/rooms/${closingRoomId}/egress/EG_DELETE/playback`, {
    headers: { authorization: `Bearer ${closingRoomToken}` },
    body: {},
  });
  assert.equal(link.status, 200, JSON.stringify(link.body));
  const closed = await ts.api('DELETE', `/v1/admin/rooms/${closingRoomId}`, { headers: ADMIN });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));

  // The live room is gone, but the HMAC token still binds room/egress/key.
  const playlist = await ts.api('GET', relative(link.body.url));
  assert.equal(playlist.status, 200, playlist.text);
  assert.match(playlist.text, /#EXT-X-ENDLIST/);
  const segmentPath = playlist.text.split('\n').find((line) => line.startsWith('/v1/rooms/')) as string;
  const segment = await ts.api('GET', segmentPath);
  assert.equal(segment.status, 200);
  assert.equal(segment.text, 'QA_CLOSING_SEGMENT');

  // Minting a *new* link still requires the live room (and its moderator).
  const remint = await ts.api('POST', `/v1/rooms/${closingRoomId}/egress/EG_DELETE/playback`, {
    headers: ADMIN,
    body: {},
  });
  assert.equal(remint.status, 404);
});

test('API: expired token 403, foreign-tenant token 404, bad signature 403, not-ready 409', async () => {
  const expiredClaims = { v: 1, t: 'demo', r: roomId, e: 'EG_HLS', k: `demo/${roomId}/2026/index.m3u8`, s: 'playlist' as const, x: Date.now() - 1000 };
  const expired = signPlaybackToken(SECRET, expiredClaims);
  const expiredResponse = await ts.api('GET', `/v1/rooms/${roomId}/egress/EG_HLS/playlist?token=${encodeURIComponent(expired)}`);
  assert.equal(expiredResponse.status, 403);
  assert.equal(expiredResponse.body.error.code, 'playback_expired');

  const foreignClaims = { ...expiredClaims, t: 'acme', x: Date.now() + 60_000 };
  const foreign = await ts.api('GET', `/v1/rooms/${roomId}/egress/EG_HLS/playlist?token=${encodeURIComponent(signPlaybackToken(SECRET, foreignClaims))}`);
  assert.equal(foreign.status, 404);

  const tampered = await ts.api('GET', `/v1/rooms/${roomId}/egress/EG_HLS/playlist?token=abc.def`);
  assert.equal(tampered.status, 403);
  assert.equal(tampered.body.error.code, 'playback_forbidden');

  const notReady = await ts.api('POST', `/v1/rooms/${roomId}/egress/EG_STARTING/playback`, {
    headers: { authorization: `Bearer ${hostToken}` },
    body: {},
  });
  assert.equal(notReady.status, 409);
  assert.equal(notReady.body.error.code, 'egress_not_ready');

  const missing = await ts.api('POST', `/v1/rooms/${roomId}/egress/EG_NOPE/playback`, {
    headers: { authorization: `Bearer ${hostToken}` },
    body: {},
  });
  assert.equal(missing.status, 404);
});

test('API: disabled playback returns 501 and does not mint links', async () => {
  const disabled = await startTestServer({
    egressUrl: twirpUrl,
    egressApiKey: 'egress-key',
    egressApiSecret: 'egress-secret',
    egressEnabled: true,
    egressPlaybackDir: localDir,
    egressPlaybackEnabled: false,
  });
  try {
    const created = await disabled.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Disabled playback' } });
    const response = await disabled.api('POST', `/v1/rooms/${created.body.room.id}/egress/EG_HLS/playback`, {
      headers: { authorization: `Bearer ${created.body.token}` },
      body: {},
    });
    assert.equal(response.status, 501);
    assert.equal(response.body.error.code, 'egress_playback_disabled');
  } finally {
    await disabled.close();
  }
});

test('Range policy: single/ignore/invalid is classified before any storage call', () => {
  assert.equal(classifyRange(undefined), 'none');
  assert.equal(classifyRange('   '), 'none');
  assert.equal(classifyRange('bytes=0-1'), 'single');
  assert.equal(classifyRange('bytes=5-'), 'single');
  assert.equal(classifyRange('bytes=-5'), 'single');
  assert.equal(classifyRange('BYTES=0-1'), 'single');
  // Multi-range: RFC 9110 allows ignoring it; both backends serve 200.
  assert.equal(classifyRange('bytes=0-1,3-4'), 'ignore');
  assert.equal(classifyRange('bytes=0-1, 3-4'), 'ignore');
  // Syntactically invalid: 416 without touching the object store.
  assert.equal(classifyRange('bytes=abc'), 'invalid');
  assert.equal(classifyRange('bytes=-'), 'invalid');
  assert.equal(classifyRange('bytes=5-3'), 'invalid');
  assert.equal(classifyRange('items=0-1'), 'invalid');
  assert.equal(classifyRange('bytes=0-1-2'), 'invalid');
});

test('playlist rewrite signs EXT-X-KEY, master variants, EXT-X-MEDIA and I-FRAME playlists', () => {
  const svc = service();
  const masterKey = 'demo/room-1/2026/master.m3u8';
  const link = svc.createLink({ tenantId: 'demo', roomId: 'room-1', egressId: 'EG_1', key: masterKey, origin: 'https://calls.example' });
  const claims = svc.verify({
    token: decodeURIComponent(new URL(link.url).searchParams.get('token') as string),
    tenantId: 'demo',
    roomId: 'room-1',
    egressId: 'EG_1',
    scope: 'playlist',
  });
  const playlist = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="ru",URI="audio/index.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="aud"',
    'video/index.m3u8',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI="iframe/index.m3u8"',
    '#EXT-X-RENDITION-REPORT:URI="media/index.m3u8",LAST-MSN=5',
    '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin",IV=0x0123',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:2.0,',
    'seg000.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const rewritten = svc.rewritePlaylist(playlist, claims);

  const uris = [...rewritten.matchAll(/URI="([^"]+)"/g)].map((match) => match[1] as string);
  assert.equal(uris.length, 5, 'every URI-bearing tag is rewritten (no URI is left relative)');
  for (const uri of uris) assert.match(uri, /^\/v1\/rooms\/room-1\/egress\/EG_1\/(?:playlist|segment)\?token=/);

  const decoded = uris.map((uri) => {
    const token = decodeURIComponent(new URL(uri, 'https://x').searchParams.get('token') as string);
    const parsed = verifyPlaybackToken(SECRET, token);
    assert.ok(parsed, 'each rewritten URI carries a valid token');
    return parsed;
  });
  // Order of the URIs in the playlist: MEDIA, I-FRAME, RENDITION-REPORT, KEY, MAP.
  assert.deepEqual(
    decoded.map((entry) => entry?.s),
    ['playlist', 'playlist', 'playlist', 'segment', 'segment'],
  );
  assert.deepEqual(
    decoded.map((entry) => entry?.k),
    [
      'demo/room-1/2026/audio/index.m3u8',
      'demo/room-1/2026/iframe/index.m3u8',
      'demo/room-1/2026/media/index.m3u8',
      'demo/room-1/2026/keys/key.bin',
      'demo/room-1/2026/init.mp4',
    ],
  );
  for (const entry of decoded) assert.equal(entry?.x, claims.x, 'every child URL shares the playlist expiry');

  // A master-playlist variant line is a playlist, not a segment: it must be
  // served through /playlist so its body is rewritten recursively.
  const variantLine = rewritten.split('\n').find((line) => line.startsWith('/v1/rooms/room-1/egress/EG_1/')) as string;
  assert.match(variantLine, /\/playlist\?token=/);
  const variantClaims = verifyPlaybackToken(SECRET, decodeURIComponent(new URL(variantLine, 'https://x').searchParams.get('token') as string));
  assert.equal(variantClaims?.s, 'playlist');
  assert.equal(variantClaims?.k, 'demo/room-1/2026/video/index.m3u8');
  assert.ok(!rewritten.includes(`\n${masterKey}\n`));
  assert.ok(!rewritten.includes(SECRET));
});

test('local backend: containment rejects traversal on both separators; multi-range served whole', async () => {
  const svc = service();
  const outside = path.join(localDir, '..', `agil-egress-outside-${Date.now()}.txt`);
  writeFileSync(outside, 'OUTSIDE_SECRET', 'utf8');
  try {
    const base = path.basename(outside);
    assert.equal(await svc.exists(`..\\${base}`), false, 'backslash traversal is not visible');
    assert.equal(await svc.exists(`../${base}`), false, 'slash traversal is not visible');
    assert.equal(await svc.exists(outside.replace(/\\/g, '/')), false, 'absolute/drive path is not contained');
    assert.equal(normalizeObjectKey(`..\\${base}`), null);
    const claims = { v: 1, t: 'demo', r: 'room-1', e: 'EG_1', k: `..\\${base}`, s: 'segment' as const, x: Date.now() + 60_000 };
    await assert.rejects(
      () => svc.objectStream(claims, undefined),
      (error: unknown) => (error as { status?: number }).status === 400,
      'reading a backslash key is rejected, not silently resolved',
    );

    // Multi-range is ignored for the whole object, matching the S3 backend.
    const segmentClaims = { v: 1, t: 'demo', r: 'room-1', e: 'EG_HLS', k: `demo/${roomId}/2026/seg000.ts`, s: 'segment' as const, x: Date.now() + 60_000 };
    const multi = await svc.objectStream(segmentClaims, 'bytes=0-1,3-4');
    assert.equal(multi.status, 200);
    assert.equal(await collect(multi.body), 'QA_SEGMENT_BYTES');
    const invalid = await svc.objectStream(segmentClaims, 'bytes=abc');
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers['content-range'], `bytes */${'QA_SEGMENT_BYTES'.length}`);

    // P3-13 consistency: a missing object is 404 even with an invalid Range,
    // because the local backend stats before it classifies the range.
    await assert.rejects(
      () => svc.objectStream({ ...segmentClaims, k: `demo/${roomId}/2026/missing.ts` }, 'bytes=abc'),
      (error: unknown) => (error as { status?: number }).status === 404,
    );
  } finally {
    rmSync(outside, { force: true });
  }
});

test('S3 backend: upstream 416 becomes 416 + content-range, multi-range is ignored', async () => {
  const objects = new Map<string, Buffer>([['demo/room-1/2026/seg.ts', Buffer.from('0123456789')]]);
  const seen: Array<{ method: string; url: string; range: string }> = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', range: String(req.headers.range ?? '') });
    const key = decodeURIComponent((req.url ?? '').replace(`/${BUCKET}/`, '').split('?')[0] as string);
    const body = objects.get(key);
    if (!body) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (req.method === 'HEAD') {
      res.setHeader('content-length', String(body.length));
      res.end();
      return;
    }
    const range = typeof req.headers.range === 'string' ? /^bytes=(\d+)-(\d*)$/.exec(req.headers.range) : null;
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(range[2] ? Number(range[2]) : body.length - 1, body.length - 1);
      if (start >= body.length) {
        // A real S3/MinIO reply: 416 with the total size and no body.
        res.statusCode = 416;
        res.setHeader('content-range', `bytes */${body.length}`);
        res.end();
        return;
      }
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${end}/${body.length}`);
      res.end(body.subarray(start, end + 1));
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-length', String(body.length));
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const svc = new EgressPlaybackService({
    secret: SECRET,
    defaultTtlSec: 900,
    maxTtlSec: 86_400,
    s3: {
      endpoint: `http://127.0.0.1:${port}`,
      region: 'ru-msk',
      bucket: BUCKET,
      accessKey: 'AKIA_S3_MOCK',
      secretKey: 'S3_SECRET_CANARY',
      forcePathStyle: true,
    },
  });
  const claims = { v: 1, t: 'demo', r: 'room-1', e: 'EG_S3', k: 'demo/room-1/2026/seg.ts', s: 'segment' as const, x: Date.now() + 60_000 };
  try {
    // Unsatisfiable single range: the upstream 416 must not become a 502.
    const unsatisfiable = await svc.objectStream(claims, 'bytes=99-120');
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers['content-range'], 'bytes */10');
    assert.equal(await collect(unsatisfiable.body), 'Range not satisfiable\n', 'upstream XML body is not forwarded');

    // Multi-range is ignored: whole object, 200, and no Range is forwarded.
    const multi = await svc.objectStream(claims, 'bytes=0-1,3-4');
    assert.equal(multi.status, 200);
    assert.equal(await collect(multi.body), '0123456789');
    const multiRequest = seen.filter((entry) => entry.method === 'GET' && entry.url.includes('seg.ts')).at(-1);
    assert.equal(multiRequest?.range, '', 'a multi-range header is not forwarded to S3');

    // Syntactically invalid: 416 without a GET; the size comes from a HEAD.
    const invalid = await svc.objectStream(claims, 'bytes=abc');
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers['content-range'], 'bytes */10');
    assert.ok(seen.some((entry) => entry.method === 'HEAD' && entry.url.includes('seg.ts')), 'HEAD fills in the total size');
    assert.ok(!seen.some((entry) => entry.method === 'GET' && entry.range === 'bytes=abc'), 'invalid range is never sent to S3');

    // A satisfiable range still returns 206 with the upstream content-range.
    const ok = await svc.objectStream(claims, 'bytes=2-3');
    assert.equal(ok.status, 206);
    assert.equal(ok.headers['content-range'], 'bytes 2-3/10');
    assert.equal(await collect(ok.body), '23');

    // Missing object stays 404 (not 502) and drains the upstream body.
    await assert.rejects(
      () => svc.objectStream({ ...claims, k: 'demo/room-1/2026/missing.ts' }),
      (error: unknown) => (error as { status?: number; code?: string }).status === 404,
    );

    // P3-13: a missing object with an invalid Range is still 404, exactly like
    // the local backend; the existence probe is a HEAD and no GET is issued.
    const beforeMissing = seen.length;
    await assert.rejects(
      () => svc.objectStream({ ...claims, k: 'demo/room-1/2026/missing.ts' }, 'bytes=abc'),
      (error: unknown) => (error as { status?: number }).status === 404,
    );
    const missingCalls = seen.slice(beforeMissing);
    assert.deepEqual(missingCalls.map((entry) => entry.method), ['HEAD'], 'missing+invalid uses one HEAD, no GET');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('S3 backend: HEAD is header-only (metadata HEAD, no object GET) and mirrors the Range contract (P3-14)', async () => {
  const objects = new Map<string, Buffer>([
    [
      'demo/room-1/2026/index.m3u8',
      Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2.0,\nseg.ts\n#EXT-X-ENDLIST\n'),
    ],
    ['demo/room-1/2026/seg.ts', Buffer.from('0123456789')],
  ]);
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const method = req.method ?? '';
    seen.push(`${method} ${req.url ?? ''}`);
    const key = decodeURIComponent((req.url ?? '').replace(`/${BUCKET}/`, '').split('?')[0] as string);
    const body = objects.get(key);
    if (!body) {
      res.statusCode = 404;
      res.end();
      return;
    }
    // SeaweedFS infers text/typescript from MPEG-TS objects without Content-Type metadata.
    res.setHeader('content-type', key.endsWith('.m3u8') ? 'application/octet-stream' : 'text/typescript; charset=utf-8');
    res.setHeader('content-length', String(body.length));
    if (method === 'HEAD') {
      res.end();
      return;
    }
    res.statusCode = 200;
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const svc = new EgressPlaybackService({
    secret: SECRET,
    defaultTtlSec: 900,
    maxTtlSec: 86_400,
    s3: {
      endpoint: `http://127.0.0.1:${port}`,
      region: 'ru-msk',
      bucket: BUCKET,
      accessKey: 'AKIA_S3_MOCK',
      secretKey: 'S3_SECRET_CANARY',
      forcePathStyle: true,
    },
  });
  const playlistClaims = { v: 1, t: 'demo', r: 'room-1', e: 'EG_S3', k: 'demo/room-1/2026/index.m3u8', s: 'playlist' as const, x: Date.now() + 60_000 };
  const segmentClaims = { v: 1, t: 'demo', r: 'room-1', e: 'EG_S3', k: 'demo/room-1/2026/seg.ts', s: 'segment' as const, x: Date.now() + 60_000 };
  const methods = (): string[] => seen.map((entry) => entry.split(' ', 1)[0] as string);
  try {
    // Playlist HEAD: the stored object size, no GET and no rewrite.
    seen.length = 0;
    const playlistHead = await svc.playlistHead(playlistClaims);
    assert.equal(playlistHead.status, 200);
    assert.match(String(playlistHead.headers['content-type']), /application\/vnd\.apple\.mpegurl/);
    assert.equal(playlistHead.headers['content-length'], String(objects.get('demo/room-1/2026/index.m3u8')!.length));
    assert.deepEqual(methods(), ['HEAD'], 'playlist HEAD is one metadata HEAD, never a GET');

    // Segment HEAD: 200 + size, no body GET.
    seen.length = 0;
    const segmentHead = await svc.objectHead(segmentClaims);
    assert.equal(segmentHead.status, 200);
    assert.equal(segmentHead.headers['content-length'], '10');
    assert.equal(segmentHead.headers['content-type'], 'video/mp2t');
    assert.deepEqual(methods(), ['HEAD']);

    seen.length = 0;
    const segment = await svc.objectStream(segmentClaims);
    assert.equal(segment.headers['content-type'], 'video/mp2t');
    assert.equal(await collect(segment.body!), '0123456789');
    assert.deepEqual(methods(), ['GET']);

    // A satisfiable Range is computed from the HEAD size: 206 headers, no GET.
    seen.length = 0;
    const ranged = await svc.objectHead(segmentClaims, 'bytes=2-3');
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers['content-range'], 'bytes 2-3/10');
    assert.equal(ranged.headers['content-length'], '2');
    assert.deepEqual(methods(), ['HEAD']);

    // A multi-range is ignored (200 whole object), like GET.
    seen.length = 0;
    const multi = await svc.objectHead(segmentClaims, 'bytes=0-1,3-4');
    assert.equal(multi.status, 200);
    assert.equal(multi.headers['content-length'], '10');
    assert.deepEqual(methods(), ['HEAD']);

    // Unsatisfiable and invalid ranges: 416 + content-range, HEAD only.
    for (const header of ['bytes=99-120', 'bytes=abc']) {
      seen.length = 0;
      const unsatisfiable = await svc.objectHead(segmentClaims, header);
      assert.equal(unsatisfiable.status, 416, header);
      assert.equal(unsatisfiable.headers['content-range'], 'bytes */10', header);
      assert.deepEqual(methods(), ['HEAD'], header);
    }

    // Missing object (with and without an invalid Range) is 404, via HEAD only.
    seen.length = 0;
    await assert.rejects(
      () => svc.objectHead({ ...segmentClaims, k: 'demo/room-1/2026/missing.ts' }),
      (error: unknown) => (error as { status?: number }).status === 404,
    );
    await assert.rejects(
      () => svc.objectHead({ ...segmentClaims, k: 'demo/room-1/2026/missing.ts' }, 'bytes=abc'),
      (error: unknown) => (error as { status?: number }).status === 404,
    );
    assert.deepEqual(methods(), ['HEAD', 'HEAD'], 'HEAD never issues an object GET');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('API: HEAD mirrors GET on playback routes and streams no body (P3-1)', async () => {
  const link = await ts.api('POST', `/v1/rooms/${roomId}/egress/EG_HLS/playback`, {
    headers: { authorization: `Bearer ${hostToken}` },
    body: {},
  });
  assert.equal(link.status, 200, JSON.stringify(link.body));
  const playlistPath = relative(link.body.url);

  const headPlaylist = await ts.api('HEAD', playlistPath);
  assert.equal(headPlaylist.status, 200);
  assert.match(String(headPlaylist.headers.get('content-type')), /application\/vnd\.apple\.mpegurl/);
  assert.equal(headPlaylist.headers.get('cache-control'), 'private, no-store');
  assert.equal(headPlaylist.text, '', 'HEAD returns no body');
  // P3-14: a playlist HEAD is metadata-only; its content-length is the stored
  // object size, not the (longer) rewritten body a GET would send.
  assert.equal(
    headPlaylist.headers.get('content-length'),
    String(statSync(localPath(`demo/${roomId}/2026/index.m3u8`)).size),
    'playlist HEAD reports the stored object size without rewriting it',
  );

  const playlist = await ts.api('GET', playlistPath);
  assert.equal(playlist.status, 200, playlist.text);
  const segmentPath = playlist.text.split('\n').find((line) => line.startsWith('/v1/rooms/')) as string;
  const headSegment = await ts.api('HEAD', segmentPath);
  assert.equal(headSegment.status, 200);
  assert.equal(headSegment.text, '');
  assert.equal(headSegment.headers.get('content-length'), String('QA_SEGMENT_BYTES'.length));
  assert.match(String(headSegment.headers.get('content-type')), /video\/mp2t/);

  const mp4Link = await ts.api('POST', `/v1/rooms/${roomId}/egress/EG_MP4/playback`, {
    headers: { authorization: `Bearer ${hostToken}` },
    body: {},
  });
  assert.equal(mp4Link.status, 200, JSON.stringify(mp4Link.body));
  const mp4Path = relative(mp4Link.body.url);

  const headRange = await ts.api('HEAD', mp4Path, { headers: { range: 'bytes=0-3' } });
  assert.equal(headRange.status, 206);
  assert.equal(headRange.headers.get('content-range'), 'bytes 0-3/12');
  assert.equal(headRange.headers.get('content-length'), '4');
  assert.equal(headRange.text, '');

  const headUnsatisfiable = await ts.api('HEAD', mp4Path, { headers: { range: 'bytes=99-120' } });
  assert.equal(headUnsatisfiable.status, 416);
  assert.equal(headUnsatisfiable.headers.get('content-range'), 'bytes */12');
  assert.equal(headUnsatisfiable.text, '');

  // HEAD on a token-less URL must fail like GET (no capability bypass). HEAD
  // responses carry no body, so only the status is observable.
  const headNoToken = await ts.api('HEAD', `/v1/rooms/${roomId}/egress/EG_HLS/playlist`);
  assert.equal(headNoToken.status, 403);
  assert.equal(headNoToken.text, '');
  const getNoToken = await ts.api('GET', `/v1/rooms/${roomId}/egress/EG_HLS/playlist`);
  assert.equal(getNoToken.status, 403);
  assert.equal(getNoToken.body.error.code, 'playback_forbidden');
});
