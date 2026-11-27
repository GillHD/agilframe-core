import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { relativeUrl, startTestServer, type TestServer } from './helpers.js';
import type { CreateServerOptions } from '../src/index.js';
import { signPlaybackToken } from '../src/egress-playback.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const FOREIGN_ADMIN = { 'x-api-key': 'acme-key' };

async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 140; attempt++) {
    const value = await read();
    if (accept(value)) return value;
    await delay(50);
  }
  throw new Error('Archive did not reach the expected state in time');
}

test('Egress MP4 archive and ready delivery survive closed room and Core restarts', { timeout: 35_000 }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'agil-egress-archive-'));
  const dataDir = path.join(root, 'core');
  const localDir = path.join(root, 'objects');
  const sample = readFileSync(new URL('../../../../websdk/demo/public/media/bbb-360p-10s.mp4', import.meta.url));
  const jobs: Array<{ egress_id: string; room_name: string; status: string; key: string }> = [];
  const deliveries: Array<{ id: string; data: Record<string, unknown> }> = [];
  let listRequests = 0;
  const objectRequests: string[] = [];
  let remoteObject: Buffer | undefined;
  let permitRemoteDelete = false;
  const fixture = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/StartRoomCompositeEgress')) {
      const job = { egress_id: `EG_ARCHIVE_${jobs.length}`, room_name: body.room_name, status: 'EGRESS_STARTING', key: body.file_outputs[0].filepath };
      jobs.push(job);
      res.end(JSON.stringify(job));
    } else if (req.url?.endsWith('/ListEgress')) {
      listRequests++;
      const items = jobs.filter(job => job.room_name === body.room_name).map(job => ({
        ...job, file_results: [{ filename: `/out/${job.key}`, duration: '7667000000', size: String(sample.length) }],
      }));
      res.end(JSON.stringify({ items }));
    } else if (req.url?.startsWith('/archive-test/')) {
      objectRequests.push(req.method ?? '');
      assert.match(String(req.headers.authorization ?? ''), /^AWS4-HMAC-SHA256 Credential=archive-test-reader\//);
      if (!remoteObject) {
        res.statusCode = 404;
        res.end();
      } else if (req.method === 'DELETE') {
        res.statusCode = permitRemoteDelete ? 204 : 403;
        if (permitRemoteDelete) remoteObject = undefined;
        res.end();
      } else {
        res.setHeader('content-length', remoteObject.length);
        res.setHeader('content-type', 'video/mp4');
        res.end(req.method === 'HEAD' ? undefined : remoteObject);
      }
    } else if (req.url === '/recordings') {
      assert.equal(req.headers['x-agil-delivery'], body.id);
      deliveries.push(body);
      res.end('{}');
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  assert.ok(address && typeof address !== 'string');
  const fixtureUrl = `http://127.0.0.1:${address.port}`;
  const originalSecret = process.env.AGIL_WEBHOOK_EGRESS_ARCHIVE_TEST;
  process.env.AGIL_WEBHOOK_EGRESS_ARCHIVE_TEST = 'archive-fixture-secret';
  const boot = (egressEnabled = true, overrides: CreateServerOptions = {}): Promise<TestServer> => startTestServer({
    dataDir, publicOrigin: '', egressEnabled, egressUrl: fixtureUrl, egressApiKey: 'fixture-key', egressApiSecret: 'fixture-secret',
    egressPlaybackBackend: 'local', egressPlaybackDir: localDir, egressPlaybackSecret: 'fixture-egress-archive-test-secret',
    egressS3Endpoint: fixtureUrl, egressS3Bucket: 'archive-test', egressS3AccessKey: 'archive-test-reader', egressS3SecretKey: 'fixture-reader',
    ...overrides,
  });
  let core: TestServer | undefined;
  try {
    core = await boot();
    assert.equal((await core.api('PUT', '/v1/admin/webhooks', {
      headers: ADMIN,
      body: { webhooks: [{
        id: 'archive', url: fixtureUrl + '/recordings', events: ['recording.ready'],
        secretEnv: 'AGIL_WEBHOOK_EGRESS_ARCHIVE_TEST', enabled: true, retries: 0, timeoutMs: 1000,
      }] },
    })).status, 200);
    const created = await core.api('POST', '/v1/admin/rooms', {
      headers: ADMIN,
      body: { name: 'Archived meeting', configOverrides: { features: { recording: true }, mediaProcessing: { egress: true } } },
    });
    assert.equal(created.status, 200, created.text);
    const id = created.body.room.id;
    const archivePath = `/v1/admin/recordings?roomId=${id}`;
    const startPath = `/v1/rooms/${id}/egress/start`;
    const accepted = await core.api('POST', startPath, { headers: ADMIN, body: { kind: 'recording' } });
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal((await core.api('POST', startPath, { headers: ADMIN, body: { kind: 'recording' } })).status, 200);
    const [completed, failed] = jobs;
    assert.ok(completed && failed);
    const playbackPath = `/v1/rooms/${id}/egress/${completed.egress_id}/playback`;
    completed.status = 'EGRESS_COMPLETE';
    failed.status = 'EGRESS_FAILED';
    const failedFile = path.join(localDir, ...failed.key.split('/'));
    mkdirSync(path.dirname(failedFile), { recursive: true });
    writeFileSync(failedFile, sample);
    const completeFile = path.join(localDir, ...completed.key.split('/'));
    writeFileSync(completeFile, sample.subarray(0, 32));
    assert.equal((await core.api('DELETE', `/v1/admin/rooms/${id}`, { headers: ADMIN })).status, 200);
    await core.close();

    core = await boot();
    await eventually(() => listRequests, count => count >= 2);
    assert.equal(deliveries.length, 0, 'completed job with an incomplete storage object must not emit');
    assert.deepEqual((await core.api('GET', archivePath, { headers: ADMIN })).body.recordings, []);
    writeFileSync(completeFile, sample);
    const catalogue = await eventually(
      () => core!.api('GET', archivePath, { headers: ADMIN }),
      response => response.status === 200 && response.body.recordings.length > 0,
    );
    const [row] = catalogue.body.recordings;
    assert.equal(catalogue.body.recordings.length, 1);
    assert.equal(row.source, 'egress');
    assert.equal(row.mime, 'video/mp4');
    assert.equal(row.size, sample.length);
    assert.equal(row.durationSec, 7.667);
    assert.equal(row.canDelete, false);
    const deletionPath = `/v1/admin/recordings/${row.id}`;
    assert.equal((await core.api('DELETE', deletionPath, { headers: ADMIN })).body.error.code, 'egress_archive_delete_disabled');
    assert.equal((await core.api('DELETE', deletionPath, { headers: FOREIGN_ADMIN })).status, 404);
    assert.deepEqual(objectRequests, [], 'explicit local storage ignores S3 credentials');
    assert.equal(catalogue.headers.get('cache-control'), 'no-store');
    assert.ok(!catalogue.text.includes(completed.key), 'object key is not returned in clear text');
    await eventually(() => deliveries.length, count => count === 1);
    assert.equal(deliveries[0]?.data.recordingId, row.id);
    assert.equal(deliveries[0]?.data.egressId, completed.egress_id);
    const firstPlayback = await core.api('POST', playbackPath, { headers: ADMIN, body: { ttlSec: 60 } });
    assert.equal(firstPlayback.status, 200, firstPlayback.text);
    await core.close();

    core = await boot(false);
    const reopened = await core.api('GET', archivePath, { headers: ADMIN });
    assert.equal(reopened.body.recordings[0].id, row.id);
    assert.deepEqual((await core.api('GET', archivePath, { headers: FOREIGN_ADMIN })).body.recordings, []);
    assert.equal((await core.api('POST', playbackPath, { headers: FOREIGN_ADMIN, body: {} })).status, 404);
    assert.equal((await core.api('POST', playbackPath, { headers: { authorization: `Bearer ${created.body.token}` }, body: {} })).status, 401);
    const before = listRequests;
    t.mock.timers.enable({ apis: ['Date'], now: firstPlayback.body.expiresAt + 1000 });
    try {
      assert.equal((await core.api('GET', relativeUrl(new URL(firstPlayback.body.url, core.base).href))).status, 403);
      const renewed = await core.api('POST', playbackPath, { headers: ADMIN, body: {} });
      assert.equal(renewed.status, 200, renewed.text);
      assert.equal(listRequests, before, 'closed-room reissue does not require LiveKit');
      const media = await fetch(new URL(renewed.body.url, core.base));
      assert.equal(media.status, 200);
      assert.equal(media.headers.get('content-type'), 'video/mp4');
      assert.deepEqual(Buffer.from(await media.arrayBuffer()), sample);
    } finally {
      t.mock.timers.reset();
    }
    assert.equal(deliveries.length, 1);

    const storedMetadata = path.join(dataDir, 'egress-archive', 'ready', 'demo', `${row.id}.json`);
    const localLink = reopened.body.recordings[0].url;
    const legacyToken = signPlaybackToken('fixture-egress-archive-test-secret', {
      v: 1, t: 'demo', r: id, e: completed.egress_id, k: completed.key, s: 'file', x: Date.now() + 60_000,
    });
    const legacyLink = `/v1/rooms/${id}/egress/${completed.egress_id}/file?token=${legacyToken}`;
    assert.equal((await core.api('HEAD', legacyLink)).status, 200);
    await core.close();
    core = await boot(false, { egressPlaybackBackend: 's3', egressArchiveDeleteEnabled: true });
    assert.deepEqual((await core.api('GET', archivePath, { headers: ADMIN })).body.recordings, []);
    assert.equal((await core.api('GET', localLink)).status, 404);
    assert.equal((await core.api('HEAD', legacyLink)).status, 404);
    assert.equal((await core.api('POST', playbackPath, { headers: ADMIN, body: {} })).status, 404);
    assert.equal((await core.api('DELETE', deletionPath, { headers: ADMIN })).body.error.code, 'egress_archive_storage_changed');
    assert.deepEqual(objectRequests, [], 'operations on a bound local recording never call S3');
    assert.ok(existsSync(completeFile) && existsSync(storedMetadata));
    await core.close();

    unlinkSync(completeFile);
    core = await boot(false);
    await eventually(() => core!.api('GET', archivePath, { headers: ADMIN }), reply => reply.body.recordings?.length === 0);
    assert.ok(existsSync(storedMetadata), 'external retention hides a stale entry without destroying metadata');
    await core.close();
    writeFileSync(completeFile, sample);
    core = await boot(false, { egressArchiveDeleteEnabled: true });
    const restored = await eventually(() => core!.api('GET', archivePath, { headers: ADMIN }), reply => reply.body.recordings?.length === 1);
    assert.equal(restored.body.recordings[0].canDelete, true);
    assert.equal((await core.api('DELETE', deletionPath, { headers: ADMIN })).status, 200);
    assert.ok(!existsSync(completeFile) && !existsSync(storedMetadata));
    assert.deepEqual((await core.api('GET', archivePath, { headers: ADMIN })).body.recordings, []);
    assert.equal((await core.api('GET', restored.body.recordings[0].url)).status, 404);
    assert.ok(existsSync(failedFile), 'deleting a recording must not delete other files');
    await core.close();

    core = await boot(true, { egressPlaybackBackend: 's3', egressArchiveDeleteEnabled: true });
    const remoteRoom = await core.api('POST', '/v1/admin/rooms', {
      headers: ADMIN,
      body: { name: 'S3 archived meeting', configOverrides: { features: { recording: true }, mediaProcessing: { egress: true } } },
    });
    const remoteRoomId = remoteRoom.body.room.id;
    const remoteStart = await core.api('POST', `/v1/rooms/${remoteRoomId}/egress/start`, { headers: ADMIN, body: { kind: 'recording' } });
    assert.equal(remoteStart.status, 200, remoteStart.text);
    const remoteJob = jobs.at(-1);
    assert.ok(remoteJob);
    remoteJob.status = 'EGRESS_COMPLETE';
    remoteObject = sample;
    const remoteArchive = await eventually(
      () => core!.api('GET', `/v1/admin/recordings?roomId=${remoteRoomId}`, { headers: ADMIN }),
      reply => reply.body.recordings?.length === 1,
    );
    const [remoteRow] = remoteArchive.body.recordings;
    const remoteDelete = `/v1/admin/recordings/${remoteRow.id}`;
    const refused = await core.api('DELETE', remoteDelete, { headers: ADMIN });
    assert.equal(refused.status, 502, refused.text);
    assert.ok(remoteObject && (await core.api('GET', remoteRow.url)).status === 200);
    permitRemoteDelete = true;
    assert.equal((await core.api('DELETE', remoteDelete, { headers: ADMIN })).status, 200);
    assert.equal(remoteObject, undefined);
    assert.deepEqual((await core.api('GET', `/v1/admin/recordings?roomId=${remoteRoomId}`, { headers: ADMIN })).body.recordings, []);
    assert.equal((await core.api('GET', remoteRow.url)).status, 404);
    assert.equal(objectRequests.filter(method => method === 'DELETE').length, 2);
  } finally {
    await core?.close();
    if (originalSecret === undefined) delete process.env.AGIL_WEBHOOK_EGRESS_ARCHIVE_TEST;
    else process.env.AGIL_WEBHOOK_EGRESS_ARCHIVE_TEST = originalSecret;
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
