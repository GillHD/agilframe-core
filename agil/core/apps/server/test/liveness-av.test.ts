/**
 * Liveness challenges and upload malware scanning (AV) over the public API.
 *
 * The engines are injected through the documented `securityEngines` seam, so the
 * tests are hermetic: no clamd daemon, no external detector. The infected path
 * uses the harmless EICAR test string, assembled by `@agil/security`, and a fake
 * scanner that recognises it the way clamd would.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  EICAR_TEST_STRING,
  LIVENESS_TASKS,
  type AvScanner,
  type AvScanResult,
  type LivenessChallengeRecord,
  type LivenessEngine,
  type LivenessSignals,
  type LivenessVerdict,
} from '@agil/security';
import { livenessTasks } from '@agil/protocol';
import { startTestServer, delay, relativeUrl, type ApiResponse, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const EICAR = Buffer.from(EICAR_TEST_STRING, 'ascii');
const EICAR_MARKER = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE';

/** Real-engine server: exercises the shipped free `challenge` baseline. */
let ts: TestServer;

before(async () => {
  ts = await startTestServer();
});

after(async () => {
  await ts.close();
});

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

/** Deterministic stand-in for the self-hosted liveness detector. */
class FakeLivenessEngine implements LivenessEngine {
  readonly name = 'fake-liveness';
  verifyMode: 'verified' | 'failed' | 'throw' = 'verified';
  configured = true;
  issueCalls = 0;
  verifyCalls = 0;

  isConfigured(): boolean {
    return this.configured;
  }

  async issue(
    input: { tenantId: string; roomId: string; participantId: string },
    options: { ttlSec: number },
  ): Promise<Omit<LivenessChallengeRecord, 'attempts' | 'maxAttempts'>> {
    this.issueCalls += 1;
    const issuedAt = Date.now();
    return {
      sessionId: randomUUID(),
      tenantId: input.tenantId,
      roomId: input.roomId,
      participantId: input.participantId,
      task: 'blink',
      issuedAt,
      expiresAt: issuedAt + Math.max(30, options.ttlSec) * 1000,
      engine: this.name,
    };
  }

  async verify(params: { challenge: LivenessChallengeRecord; signals: LivenessSignals }): Promise<LivenessVerdict> {
    this.verifyCalls += 1;
    // The fake never trusts the browser signals: only the configured verdict counts.
    void params;
    if (this.verifyMode === 'throw') throw new Error('detector is down');
    return {
      passed: this.verifyMode === 'verified',
      status: this.verifyMode,
      score: this.verifyMode === 'verified' ? 0.1 : 0.9,
      flags: this.verifyMode === 'verified' ? [] : ['fake_failed'],
      engine: this.name,
    };
  }
}

/**
 * Fake AV engine: reports `infected` for the EICAR marker (like clamd's
 * `Eicar-Test-Signature`) and `error` when switched to the outage mode.
 */
class EicarScanner implements AvScanner {
  readonly name = 'fake-av';
  mode: 'detect' | 'error' = 'detect';

  isConfigured(): boolean {
    return true;
  }

  async scan(input: { data: Buffer }): Promise<AvScanResult> {
    const bytes = Buffer.isBuffer(input?.data) ? input.data.length : 0;
    if (this.mode === 'error') {
      return {
        status: 'error',
        engine: this.name,
        detail: 'clamd unreachable',
        durationMs: 1,
        scannedAt: Date.now(),
        bytes,
      };
    }
    const infected = input.data.includes(EICAR_MARKER);
    return {
      status: infected ? 'infected' : 'clean',
      engine: this.name,
      ...(infected ? { signature: 'Eicar-Test-Signature' } : {}),
      durationMs: 1,
      scannedAt: Date.now(),
      bytes,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** EICAR scanner whose next scan can be held until the test releases it. */
class GatedEicarScanner implements AvScanner {
  readonly name = 'fake-av-gated';
  private readonly base = new EicarScanner();
  /** When set, the next scan waits for this promise before returning a verdict. */
  hold: Promise<void> | null = null;

  isConfigured(): boolean {
    return true;
  }

  async scan(input: { data: Buffer }): Promise<AvScanResult> {
    const hold = this.hold;
    if (hold) {
      this.hold = null;
      await hold;
    }
    return this.base.scan(input);
  }
}

async function createRoom(server: TestServer, name: string): Promise<{ roomId: string; token: string }> {
  const created = await server.api('POST', '/v1/rooms', { body: { name } });
  assert.equal(created.status, 200);
  return { roomId: created.body.room.id, token: created.body.token };
}

async function enableLiveness(server: TestServer, onEngineError: 'fail-open' | 'fail-closed'): Promise<void> {
  const patched = await server.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { security: { liveness: { enabled: true, onEngineError } } },
  });
  assert.equal(patched.status, 200);
}

async function enableAvScan(
  server: TestServer,
  policy: { mode: 'sync' | 'async'; onScanError: 'fail-open' | 'fail-closed' },
): Promise<void> {
  const patched = await server.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: {
      features: { fileShare: true },
      // Objects with a schema-level `.default()` are not deep-partial: the whole
      // policy has to be sent (the dashboard does the same).
      security: { avScan: { enabled: true, mode: policy.mode, onScanError: policy.onScanError, maxScanMb: 25 } },
    },
  });
  assert.equal(patched.status, 200);
}

function upload(server: TestServer, token: string, data: Buffer, name = 'upload.bin'): Promise<ApiResponse> {
  return server.api('POST', '/v1/files', {
    headers: {
      authorization: `Bearer ${token}`,
      'x-file-name': encodeURIComponent(name),
      'content-type': 'application/octet-stream',
    },
    rawBody: data,
  });
}

/* ------------------------------------------------------------------ */
/* Liveness                                                            */
/* ------------------------------------------------------------------ */

test('liveness: the protocol contract and the security engine list stay in sync', () => {
  // `@agil/security` intentionally has no runtime dependency on `@agil/protocol`,
  // so the task literals are duplicated; this test is the guard against drift.
  assert.deepEqual([...livenessTasks], [...LIVENESS_TASKS]);
});

test('liveness: disabled by default (403), enabled tenant issues an advisory challenge', async () => {
  const { roomId, token } = await createRoom(ts, 'Liveness default');

  const disabled = await ts.api('POST', `/v1/rooms/${roomId}/liveness/challenge`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(disabled.status, 403);
  assert.equal(disabled.body.error.code, 'liveness_disabled');

  await enableLiveness(ts, 'fail-open');
  const issued = await ts.api('POST', `/v1/rooms/${roomId}/liveness/challenge`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(issued.status, 200);
  assert.deepEqual(['blink', 'head-left', 'head-right'].includes(issued.body.task), true);
  assert.equal(issued.body.engine, 'challenge');
  assert.equal(issued.body.advisory, true);
  assert.ok(issued.body.sessionId);
  assert.ok(issued.body.expiresAt > issued.body.issuedAt);
  assert.ok(issued.body.ttlSec >= 30 && issued.body.ttlSec <= 600);

  // The matching signal passes; nothing about the frame ever leaves the browser.
  const signals =
    issued.body.task === 'blink'
      ? { faceDetected: true, blinkDetected: true, confidence: 0.9, framesAnalyzed: 42, durationMs: 3000 }
      : { faceDetected: true, headTurnDetected: true, confidence: 0.9, framesAnalyzed: 42, durationMs: 3000 };
  const verified = await ts.api('POST', `/v1/rooms/${roomId}/liveness/${issued.body.sessionId}/verify`, {
    headers: { authorization: `Bearer ${token}` },
    body: { signals },
  });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.status, 'verified');
  assert.equal(verified.body.passed, true);
  assert.equal(verified.body.advisory, true);
  assert.equal(verified.body.attempts, 1);

  // Single use: the consumed session id is no longer usable.
  const replay = await ts.api('POST', `/v1/rooms/${roomId}/liveness/${issued.body.sessionId}/verify`, {
    headers: { authorization: `Bearer ${token}` },
    body: { signals },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.passed, false);
  assert.equal(replay.body.status, 'invalid');
});

test('liveness: auth, room binding, malformed signals and audit trail', async () => {
  const first = await createRoom(ts, 'Liveness auth');
  const second = await createRoom(ts, 'Liveness foreign');
  await enableLiveness(ts, 'fail-open');

  const noToken = await ts.api('POST', `/v1/rooms/${first.roomId}/liveness/challenge`, {});
  assert.equal(noToken.status, 401);

  const unknownRoom = await ts.api('POST', '/v1/rooms/room-does-not-exist/liveness/challenge', {
    headers: { authorization: `Bearer ${first.token}` },
  });
  assert.equal(unknownRoom.status, 404);

  // A valid token for another room cannot request a challenge here.
  const foreign = await ts.api('POST', `/v1/rooms/${first.roomId}/liveness/challenge`, {
    headers: { authorization: `Bearer ${second.token}` },
  });
  assert.equal(foreign.status, 403);

  const issued = await ts.api('POST', `/v1/rooms/${first.roomId}/liveness/challenge`, {
    headers: { authorization: `Bearer ${first.token}` },
  });
  assert.equal(issued.status, 200);

  const badSignals = await ts.api('POST', `/v1/rooms/${first.roomId}/liveness/${issued.body.sessionId}/verify`, {
    headers: { authorization: `Bearer ${first.token}` },
    body: { signals: { confidence: 2 } },
  });
  assert.equal(badSignals.status, 400);
  assert.equal(badSignals.body.error.code, 'validation_failed');

  const badSession = await ts.api('POST', `/v1/rooms/${first.roomId}/liveness/..%2Fescape/verify`, {
    headers: { authorization: `Bearer ${first.token}` },
    body: { signals: {} },
  });
  assert.ok([400, 404].includes(badSession.status));

  // A failed attempt is NOT a deepfake accusation: it only yields `failed`.
  const failed = await ts.api('POST', `/v1/rooms/${first.roomId}/liveness/${issued.body.sessionId}/verify`, {
    headers: { authorization: `Bearer ${first.token}` },
    body: { signals: { faceDetected: true, blinkDetected: false, headTurnDetected: false } },
  });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.passed, false);
  assert.equal(failed.body.status, 'failed');
  assert.equal(failed.body.score >= 0.5, true);

  const audit = await ts.api('GET', '/v1/admin/audit?type=liveness.failed', { headers: ADMIN });
  assert.equal(audit.status, 200);
  assert.ok(audit.body.entries.some((entry: { roomId: string }) => entry.roomId === first.roomId));

  const challengeAudit = await ts.api('GET', '/v1/admin/audit?type=liveness.challenge', { headers: ADMIN });
  assert.equal(challengeAudit.status, 200);
  assert.ok(challengeAudit.body.entries.some((entry: { roomId: string }) => entry.roomId === first.roomId));
});

test('liveness: engine crash follows the tenant fail-open/fail-closed policy', async () => {
  const engine = new FakeLivenessEngine();
  engine.verifyMode = 'throw';
  const server = await startTestServer({ securityEngines: { livenessEngine: engine } });
  try {
    const { roomId, token } = await createRoom(server, 'Liveness policy');
    const headers = { authorization: `Bearer ${token}` };

    await enableLiveness(server, 'fail-open');
    const open = await server.api('POST', `/v1/rooms/${roomId}/liveness/challenge`, { headers });
    assert.equal(open.status, 200);
    assert.equal(open.body.engine, 'fake-liveness');
    const unavailable = await server.api('POST', `/v1/rooms/${roomId}/liveness/${open.body.sessionId}/verify`, {
      headers,
      body: { signals: { faceDetected: true } },
    });
    assert.equal(unavailable.status, 200);
    assert.equal(unavailable.body.status, 'unavailable');
    assert.equal(unavailable.body.passed, false);
    assert.ok(unavailable.body.flags.includes('liveness_engine_error'));

    await enableLiveness(server, 'fail-closed');
    const closed = await server.api('POST', `/v1/rooms/${roomId}/liveness/challenge`, { headers });
    assert.equal(closed.status, 200);
    const failed = await server.api('POST', `/v1/rooms/${roomId}/liveness/${closed.body.sessionId}/verify`, {
      headers,
      body: { signals: { faceDetected: true } },
    });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.status, 'failed');
    assert.ok(failed.body.flags.includes('liveness_engine_unavailable_fail_closed'));
  } finally {
    await server.close();
  }
});

test('liveness: 501 when no engine is configured (external engine without URL)', async () => {
  const server = await startTestServer({ livenessEngine: 'external', livenessUrl: '' });
  try {
    const { roomId, token } = await createRoom(server, 'Liveness unconfigured');
    await enableLiveness(server, 'fail-open');
    const response = await server.api('POST', `/v1/rooms/${roomId}/liveness/challenge`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 501);
    assert.equal(response.body.error.code, 'liveness_not_configured');
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* Upload malware scan (AV)                                            */
/* ------------------------------------------------------------------ */

test('AV: disabled by default — the EICAR payload is stored unscanned', async () => {
  const scanner = new EicarScanner();
  const server = await startTestServer({ securityEngines: { avScanner: scanner } });
  try {
    await server.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { features: { fileShare: true } } });
    const { token } = await createRoom(server, 'AV disabled');
    const stored = await upload(server, token, EICAR, 'eicar.com');
    assert.equal(stored.status, 200);
    assert.equal((await server.api('GET', relativeUrl(stored.body.url))).status, 200);
    const quarantine = await server.api('GET', '/v1/admin/quarantine', { headers: ADMIN });
    assert.equal(quarantine.status, 200);
    assert.equal(quarantine.body.count, 0);
  } finally {
    await server.close();
  }
});

test('AV sync: infected upload is rejected (422), quarantined, audited and purged', async () => {
  const scanner = new EicarScanner();
  const server = await startTestServer({ securityEngines: { avScanner: scanner } });
  try {
    const { roomId, token } = await createRoom(server, 'AV sync');
    await enableAvScan(server, { mode: 'sync', onScanError: 'fail-open' });

    const blocked = await upload(server, token, EICAR, 'eicar.com');
    assert.equal(blocked.status, 422);
    assert.equal(blocked.body.error.code, 'file_infected');

    // A clean file is accepted and downloadable.
    const clean = await upload(server, token, Buffer.from('hello agil'), 'notes.txt');
    assert.equal(clean.status, 200);
    assert.equal((await server.api('GET', relativeUrl(clean.body.url))).text, 'hello agil');

    const quarantine = await server.api('GET', '/v1/admin/quarantine', { headers: ADMIN });
    assert.equal(quarantine.status, 200);
    assert.equal(quarantine.body.count, 1);
    const record = quarantine.body.files[0];
    assert.equal(record.reason, 'infected');
    assert.equal(record.engine, 'fake-av');
    assert.equal(record.signature, 'Eicar-Test-Signature');
    assert.equal(record.downloadable, false);
    assert.equal(record.roomId, roomId);
    assert.equal(record.size, EICAR.length);
    assert.match(record.sha256, /^[a-f0-9]{64}$/);

    // Quarantined metadata is tenant-scoped: a foreign API key sees nothing.
    const acme = await server.api('GET', '/v1/admin/quarantine', { headers: { 'x-api-key': 'acme-key' } });
    assert.equal(acme.status, 200);
    assert.equal(acme.body.count, 0);
    const foreignPurge = await server.api('DELETE', `/v1/admin/quarantine/${record.id}`, {
      headers: { 'x-api-key': 'acme-key' },
    });
    assert.equal(foreignPurge.status, 404);

    const audit = await server.api('GET', '/v1/admin/audit?type=file.quarantined', { headers: ADMIN });
    assert.equal(audit.status, 200);
    const entry = audit.body.entries.find((candidate: { roomId: string }) => candidate.roomId === roomId);
    assert.ok(entry, 'quarantine must be audited');
    assert.equal(entry.severity, 'critical');
    assert.equal(entry.details.signature, 'Eicar-Test-Signature');

    // Purge removes the stored bytes + metadata.
    const purged = await server.api('DELETE', `/v1/admin/quarantine/${record.id}`, { headers: ADMIN });
    assert.equal(purged.status, 200);
    assert.equal(purged.body.deleted, true);
    const after = await server.api('GET', '/v1/admin/quarantine', { headers: ADMIN });
    assert.equal(after.body.count, 0);
  } finally {
    await server.close();
  }
});

test('AV async: upload answers 200 first, the stored copy is quarantined afterwards', async () => {
  const scanner = new EicarScanner();
  const server = await startTestServer({ securityEngines: { avScanner: scanner } });
  try {
    const { token } = await createRoom(server, 'AV async');
    await enableAvScan(server, { mode: 'async', onScanError: 'fail-open' });

    const accepted = await upload(server, token, EICAR, 'eicar.com');
    assert.equal(accepted.status, 200, 'async mode never blocks the response');
    await server.server.services.uploadScan.idle();

    const quarantine = await server.api('GET', '/v1/admin/quarantine', { headers: ADMIN });
    assert.equal(quarantine.body.count, 1);
    assert.equal(quarantine.body.files[0].reason, 'infected');

    // The signed URL existed briefly, but the bytes are gone after quarantine.
    const download = await server.api('GET', relativeUrl(accepted.body.url));
    assert.equal(download.status, 403);
  } finally {
    await server.close();
  }
});

test('AV sync: scanner outage is fail-open by default and fail-closed on request', async () => {
  const scanner = new EicarScanner();
  scanner.mode = 'error';
  const server = await startTestServer({ securityEngines: { avScanner: scanner } });
  try {
    const { token } = await createRoom(server, 'AV outage');

    await enableAvScan(server, { mode: 'sync', onScanError: 'fail-open' });
    const kept = await upload(server, token, Buffer.from('unscanned but kept'), 'notes.txt');
    assert.equal(kept.status, 200);
    assert.equal((await server.api('GET', relativeUrl(kept.body.url))).status, 200);
    assert.equal((await server.api('GET', '/v1/admin/quarantine', { headers: ADMIN })).body.count, 0);

    await enableAvScan(server, { mode: 'sync', onScanError: 'fail-closed' });
    const rejected = await upload(server, token, Buffer.from('unscanned and rejected'), 'notes.txt');
    assert.equal(rejected.status, 503);
    assert.equal(rejected.body.error.code, 'scan_unavailable');

    const quarantine = await server.api('GET', '/v1/admin/quarantine', { headers: ADMIN });
    assert.equal(quarantine.body.count, 1);
    assert.equal(quarantine.body.files[0].reason, 'scan_error');
  } finally {
    await server.close();
  }
});

test('file.shared webhook: exactly once after a clean verdict, never for a quarantined upload', async () => {
  const scanner = new GatedEicarScanner();
  // The webhook secret must be in the server-owned startup snapshot; inject it
  // through the env override instead of mutating `process.env` after startup.
  const server = await startTestServer({
    securityEngines: { avScanner: scanner },
    tenantSecretEnv: { AGIL_WEBHOOK_AV_TEST_SECRET: 'av-webhook-secret' },
  });
  const received: Array<{ event: string; body: any }> = [];
  const receiver: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: any = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      received.push({ event: String(request.headers['x-agil-event'] ?? ''), body });
      response.statusCode = 200;
      response.end('ok');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  let release: (() => void) | null = null;
  const shared = (): Array<{ event: string; body: any }> => received.filter((entry) => entry.event === 'file.shared');
  const secure = (): Array<{ event: string; body: any }> => received.filter((entry) => entry.event === 'security.event');
  try {
    const saved = await server.api('PUT', '/v1/admin/webhooks', {
      headers: ADMIN,
      body: {
        webhooks: [
          {
            id: 'av-hook',
            url: `${receiverUrl}/hook`,
            events: ['file.shared', 'security.event'],
            secretEnv: 'AGIL_WEBHOOK_AV_TEST_SECRET',
            enabled: true,
            retries: 0,
            timeoutMs: 1000,
          },
        ],
      },
    });
    assert.equal(saved.status, 200);
    const { token } = await createRoom(server, 'AV webhook');
    // AV is off by default even though a scanner is configured: share immediately.
    await server.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { features: { fileShare: true } } });
    const off = await upload(server, token, Buffer.from('plain file'), 'plain.txt');
    assert.equal(off.status, 200);
    await server.server.services.webhooks.drain(3000);
    assert.equal(shared().length, 1, 'AV disabled emits exactly one file.shared');
    assert.equal(secure().length, 0);

    // AV async, clean file: the share event is deferred until the scan verdict.
    received.length = 0;
    await enableAvScan(server, { mode: 'async', onScanError: 'fail-open' });
    scanner.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deferred = await upload(server, token, Buffer.from('clean async'), 'clean.txt');
    assert.equal(deferred.status, 200);
    assert.equal(shared().length, 0, 'async clean file must not be shared before the scan');
    (release as (() => void) | null)?.();
    release = null;
    await server.server.services.uploadScan.idle();
    await server.server.services.webhooks.drain(3000);
    assert.equal(shared().length, 1, 'async clean file is shared exactly once after the verdict');

    // AV async, infected file: no file.shared, only the quarantine security event.
    received.length = 0;
    const infectedAsync = await upload(server, token, EICAR, 'eicar-async.com');
    assert.equal(infectedAsync.status, 200);
    await server.server.services.uploadScan.idle();
    await server.server.services.webhooks.drain(3000);
    assert.equal(shared().length, 0, 'quarantined async upload must not emit file.shared');
    assert.equal(secure().length, 1);
    assert.equal(secure()[0]?.body?.data?.kind, 'file.quarantined');

    // AV sync, clean file: exactly one share event (after the verdict, before 200).
    received.length = 0;
    await enableAvScan(server, { mode: 'sync', onScanError: 'fail-open' });
    const cleanSync = await upload(server, token, Buffer.from('clean sync'), 'sync.txt');
    assert.equal(cleanSync.status, 200);
    await server.server.services.webhooks.drain(3000);
    assert.equal(shared().length, 1, 'sync clean file is shared exactly once');

    // AV sync, infected file: rejected and never shared.
    received.length = 0;
    const infectedSync = await upload(server, token, EICAR, 'eicar-sync.com');
    assert.equal(infectedSync.status, 422);
    await server.server.services.webhooks.drain(3000);
    assert.equal(shared().length, 0, 'sync infected upload must not emit file.shared');
    assert.equal(secure().length, 1);
    assert.equal(secure()[0]?.body?.data?.kind, 'file.quarantined');
  } finally {
    release?.();
    await server.close();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
});

test('AV async: double quarantine failure blocks the download and raises a critical quarantine_failed event', async () => {
  const scanner = new EicarScanner();
  const server = await startTestServer({ securityEngines: { avScanner: scanner } });
  const emitted: Array<{ type: string; data: Record<string, unknown> }> = [];
  try {
    const { token } = await createRoom(server, 'AV double failure');
    await enableAvScan(server, { mode: 'async', onScanError: 'fail-open' });

    // Fault injection: archive write and live-copy removal both fail.
    const quarantine = server.server.services.quarantine;
    (quarantine as unknown as { put: () => never }).put = () => {
      throw new Error('ENOSPC: no space left on device');
    };
    (server.server.providers as unknown as { filesRemove: () => Promise<boolean> }).filesRemove = async () => false;
    const webhooks = server.server.services.webhooks;
    const originalEmit = webhooks.emit.bind(webhooks);
    webhooks.emit = ((type: string, context: { tenantId: string; roomId?: string }, data: Record<string, unknown> = {}) => {
      emitted.push({ type, data });
      return originalEmit(type as never, context, data);
    }) as typeof webhooks.emit;

    const accepted = await upload(server, token, EICAR, 'eicar-double.com');
    assert.equal(accepted.status, 200);
    await server.server.services.uploadScan.idle();

    // The signed URL is now dead even though the bytes could not be deleted.
    const download = await server.api('GET', relativeUrl(accepted.body.url));
    assert.equal(download.status, 403);

    // Critical SIEM signal: audit + security.event / file.quarantine_failed.
    const audit = await server.api('GET', '/v1/admin/audit?type=file.quarantine_failed', { headers: ADMIN });
    assert.equal(audit.status, 200);
    const entry = audit.body.entries.find(
      (candidate: { details?: { fileId?: string } }) => candidate.details?.fileId === accepted.body.id,
    );
    assert.ok(entry, 'quarantine failure must be audited');
    assert.equal(entry.severity, 'critical');
    assert.equal(entry.details.fileId, accepted.body.id);
    assert.equal(entry.details.archived, false);
    assert.equal(entry.details.removed, false);
    assert.equal(entry.details.blockPersisted, true);
    assert.match(entry.details.error ?? '', /ENOSPC/);

    const failure = emitted.find(
      (event) => event.type === 'security.event' && event.data.kind === 'file.quarantine_failed',
    );
    assert.ok(failure, 'a security.event quarantine failure webhook is emitted');
    assert.equal(failure?.data.fileId, accepted.body.id);
    assert.equal(failure?.data.blocked, true);
    assert.equal(emitted.some((event) => event.type === 'file.shared'), false, 'blocked bytes are never shared');

    // No archive record (the disk write failed), but the file id is denied.
    assert.equal((await server.api('GET', '/v1/admin/quarantine', { headers: ADMIN })).body.count, 0);
    assert.equal(quarantine.isBlocked('demo', accepted.body.id), true);
  } finally {
    await server.close();
  }
});

test('AV async fail-closed: a crash before the scan is recovered on restart and the file is quarantined', async () => {
  // This scanner never settles: the upload is acknowledged, then the "process
  // dies" with the job still in the spool.
  const stuck: AvScanner = {
    name: 'stuck-restart',
    isConfigured: () => true,
    scan: () => new Promise<AvScanResult>(() => {}),
  };
  const first = await startTestServer({ securityEngines: { avScanner: stuck } });
  const { token } = await createRoom(first, 'AV restart');
  await enableAvScan(first, { mode: 'async', onScanError: 'fail-closed' });
  const accepted = await upload(first, token, EICAR, 'eicar-restart.com');
  assert.equal(accepted.status, 200);

  // Close the HTTP server (bounded drain cannot finish the stuck scan) but keep
  // the data directory: this is the crash/restart path, not a clean shutdown.
  await first.server.close();

  const second = await startTestServer({
    dataDir: first.dataDir,
    securityEngines: { avScanner: new EicarScanner() },
  });
  try {
    // Startup recovery runs in the background; poll the quarantine list.
    let files: Array<{ reason: string; sourceId: string }> = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      files = (await second.api('GET', '/v1/admin/quarantine', { headers: ADMIN })).body.files ?? [];
      if (files.length > 0) break;
      await delay(50);
    }
    assert.equal(files.length, 1, 'the recovered job is scanned and quarantined');
    assert.equal(files[0]?.reason, 'infected');
    assert.equal(files[0]?.sourceId, accepted.body.id);
    assert.equal((await second.api('GET', relativeUrl(accepted.body.url))).status, 403);
  } finally {
    await second.close();
    rmSync(first.dataDir, { recursive: true, force: true });
  }
});

test('AV async fail-closed: a restart without any scanner still quarantines and blocks the recovered job (P2-3-R)', async () => {
  // The first process accepts the fail-closed job, then "dies" mid-scan.
  const stuck: AvScanner = {
    name: 'stuck-noscan',
    isConfigured: () => true,
    scan: () => new Promise<AvScanResult>(() => {}),
  };
  const first = await startTestServer({ securityEngines: { avScanner: stuck } });
  const { token } = await createRoom(first, 'AV restart no scanner');
  await enableAvScan(first, { mode: 'async', onScanError: 'fail-closed' });
  const accepted = await upload(first, token, EICAR, 'eicar-noscan.com');
  assert.equal(accepted.status, 200);
  const spoolDir = first.server.services.dirs.avQueue;
  assert.equal(
    readdirSync(spoolDir).filter((name) => name.endsWith('.json')).length,
    1,
    'the accepted job is durable before the restart',
  );

  // Close the HTTP server (bounded drain cannot finish the stuck scan), keep data.
  await first.server.close();

  // Restart with an explicitly unconfigured engine: same as removing
  // AGIL_CLAMAV_*/AGIL_YARA_RULES, i.e. `isEnabled() === false`.
  const unconfigured: AvScanner = {
    name: 'removed-engine',
    isConfigured: () => false,
    scan: async () => {
      throw new Error('scan() must not be called without a configured engine');
    },
  };
  const second = await startTestServer({
    dataDir: first.dataDir,
    securityEngines: { avScanner: unconfigured },
  });
  try {
    // Startup recovery runs in the background; poll the quarantine list.
    let files: Array<{ reason: string; sourceId: string; detail?: string }> = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      files = (await second.api('GET', '/v1/admin/quarantine', { headers: ADMIN })).body.files ?? [];
      if (files.length > 0) break;
      await delay(50);
    }
    assert.equal(files.length, 1, 'the recovered job is quarantined without an engine');
    assert.equal(files[0]?.reason, 'scan_error');
    assert.equal(files[0]?.sourceId, accepted.body.id);
    assert.match(files[0]?.detail ?? '', /no antivirus engine is configured/i);

    // Fail-closed: the signed URL issued before the crash is dead and the id is
    // persistently denied even if the bytes had survived.
    assert.equal((await second.api('GET', relativeUrl(accepted.body.url))).status, 403);
    assert.equal(second.server.services.quarantine.isBlocked('demo', accepted.body.id), true);

    // Critical SIEM signal: audit + security.event / scan_unavailable.
    const audit = await second.api('GET', '/v1/admin/audit?type=file.scan_unavailable', { headers: ADMIN });
    assert.equal(audit.status, 200);
    const entry = audit.body.entries.find(
      (candidate: { details?: { fileId?: string } }) => candidate.details?.fileId === accepted.body.id,
    );
    assert.ok(entry, 'the no-scanner recovery must be audited');
    assert.equal(entry.severity, 'critical');
    assert.equal(entry.details.recovered, true);
    assert.equal(entry.details.blocked, true);
    assert.equal(entry.details.quarantined, true);

    // Spool drained: the job is not replayed on the next restart.
    assert.deepEqual(readdirSync(spoolDir), []);
  } finally {
    await second.close();
    rmSync(first.dataDir, { recursive: true, force: true });
  }
});
