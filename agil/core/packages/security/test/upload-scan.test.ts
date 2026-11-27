/** Upload scan pipeline: async queue, quarantine, audit callbacks and fail-open/closed policy. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EICAR_TEST_STRING, type AvScanResult, type AvScanner } from '../src/av.js';
import { QuarantineStore } from '../src/quarantine.js';
import {
  UploadScanService,
  type QuarantineEvent,
  type QuarantineFailureEvent,
  type ScanEvent,
  type ScanUnavailableEvent,
} from '../src/upload-scan.js';

const EICAR = Buffer.from(EICAR_TEST_STRING, 'utf8');

function fakeScanner(
  behaviour: (data: Buffer) => Partial<AvScanResult> | Promise<Partial<AvScanResult>>,
  options: { name?: string; configured?: boolean; delayMs?: number } = {},
): AvScanner & { calls: number } {
  const scanner = {
    name: options.name ?? 'fake',
    calls: 0,
    isConfigured: () => options.configured ?? true,
    async scan(input: { data: Buffer }): Promise<AvScanResult> {
      scanner.calls += 1;
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      const partial = await behaviour(input.data);
      return {
        status: 'clean',
        engine: scanner.name,
        durationMs: 1,
        scannedAt: Date.now(),
        bytes: input.data.length,
        ...partial,
      };
    },
  };
  return scanner;
}

/** A stored-file stand-in with the same `remove` contract as FileStore. */
function makeJob(
  dir: string,
  data: Buffer,
  overrides: { fileId?: string; tenantId?: string; roomId?: string } = {},
): {
  job: {
    fileId: string;
    tenantId: string;
    roomId: string;
    fileName: string;
    mime: string;
    data: Buffer;
    uploadedBy: string;
    remove: () => boolean;
  };
  removed: () => boolean;
} {
  let removed = false;
  const job = {
    fileId: overrides.fileId ?? 'file-1',
    tenantId: overrides.tenantId ?? 'demo',
    roomId: overrides.roomId ?? 'room-1',
    fileName: 'invoice.pdf',
    mime: 'application/pdf',
    data,
    uploadedBy: 'p-1',
    remove: () => {
      removed = true;
      return true;
    },
  };
  void dir;
  return { job, removed: () => removed };
}

test('async mode answers `queued`, quarantines the payload and calls back with audit data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agil-quarantine-test-'));
  const quarantine = new QuarantineStore({ dir });
  const events: QuarantineEvent[] = [];
  const scans: ScanEvent[] = [];
  const scanner = fakeScanner((data) =>
    data.includes('EICAR') ? { status: 'infected', signature: 'Eicar-Test-Signature' } : { status: 'clean' },
  );
  const service = new UploadScanService({
    scanner,
    quarantine,
    onQuarantined: (event) => events.push(event),
    onScan: (event) => scans.push(event),
  });
  try {
    const { job, removed } = makeJob(dir, EICAR);
    const accepted = await service.scan(job, { enabled: true, mode: 'async', onScanError: 'fail-open', maxScanMb: 25 });
    assert.equal(accepted.status, 'queued');

    await service.idle();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.record.reason, 'infected');
    assert.equal(events[0]?.record.signature, 'Eicar-Test-Signature');
    assert.equal(events[0]?.record.sourceId, 'file-1');
    assert.equal(events[0]?.job.tenantId, 'demo');
    assert.equal(removed(), true, 'the live copy is removed after quarantine');
    assert.equal(scans.length, 1);
    assert.equal(scans[0]?.outcome.status, 'infected');
    assert.equal(scans[0]?.outcome.quarantined, true);

    // Payload + metadata are on disk; the admin listing has no payload bytes.
    const listed = quarantine.list({ tenantId: 'demo' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.size, EICAR.length);
    assert.ok(readdirSync(dir).some((name) => name.endsWith('.json')));

    // Tenant scoping: another tenant cannot read or delete the record.
    assert.equal(quarantine.get('acme', listed[0]!.id), null);
    assert.equal(quarantine.remove('acme', listed[0]!.id), false);
    assert.equal(quarantine.list({ tenantId: 'acme' }).length, 0);
    assert.equal(quarantine.get('demo', listed[0]!.id)?.data.length, EICAR.length);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clean files are not quarantined and the stored copy is kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agil-quarantine-clean-'));
  const quarantine = new QuarantineStore({ dir });
  const service = new UploadScanService({ scanner: fakeScanner(() => ({ status: 'clean' })), quarantine });
  try {
    const { job, removed } = makeJob(dir, Buffer.from('harmless'));
    const accepted = await service.scan(job, { enabled: true, mode: 'async', maxScanMb: 25 });
    assert.equal(accepted.status, 'queued');
    await service.idle();
    assert.equal(removed(), false);
    assert.equal(quarantine.count('demo'), 0);
    assert.deepEqual(service.stats(), {
      queued: 0,
      running: 0,
      completed: 1,
      infected: 0,
      quarantined: 0,
      errors: 0,
      skipped: 0,
    });
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sync mode returns the verdict and blocks the upload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agil-quarantine-sync-'));
  const quarantine = new QuarantineStore({ dir });
  const service = new UploadScanService({
    scanner: fakeScanner(() => ({ status: 'infected', signature: 'Eicar-Test-Signature' })),
    quarantine,
  });
  try {
    const { job, removed } = makeJob(dir, EICAR);
    const outcome = await service.scan(job, { enabled: true, mode: 'sync', maxScanMb: 25 });
    assert.equal(outcome.status, 'infected');
    assert.equal(outcome.quarantined, true);
    assert.equal(removed(), true);
    assert.equal(quarantine.count('demo'), 1);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanner errors follow the explicit fail-open / fail-closed policy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agil-quarantine-policy-'));
  const quarantine = new QuarantineStore({ dir });
  const broken = fakeScanner(() => ({ status: 'error', detail: 'clamd down' }));

  const open = new UploadScanService({ scanner: broken, quarantine });
  try {
    const { job, removed } = makeJob(dir, Buffer.from('x'));
    const outcome = await open.scan(job, { enabled: true, mode: 'sync', onScanError: 'fail-open' });
    assert.equal(outcome.status, 'error');
    assert.equal(outcome.quarantined, false);
    assert.equal(removed(), false, 'fail-open keeps the file');
    assert.equal(quarantine.count('demo'), 0);
  } finally {
    await open.close();
  }

  const closed = new UploadScanService({ scanner: broken, quarantine });
  try {
    const { job, removed } = makeJob(dir, Buffer.from('y'));
    const outcome = await closed.scan(job, { enabled: true, mode: 'sync', onScanError: 'fail-closed' });
    assert.equal(outcome.status, 'error');
    assert.equal(outcome.quarantined, true);
    assert.equal(removed(), true, 'fail-closed removes unscanned bytes');
    assert.equal(quarantine.list({ tenantId: 'demo' })[0]?.reason, 'scan_error');
  } finally {
    await closed.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('disabled tenants never scan; missing engine is an explicit policy decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agil-quarantine-disabled-'));
  const quarantine = new QuarantineStore({ dir });
  const scanner = fakeScanner(() => ({ status: 'clean' }));
  const service = new UploadScanService({ scanner, quarantine });
  try {
    const { job } = makeJob(dir, Buffer.from('x'));
    const disabled = await service.scan(job, { enabled: false, mode: 'async', maxScanMb: 25 });
    assert.equal(disabled.status, 'disabled');
    assert.equal(scanner.calls, 0);

    const noEngine = new UploadScanService({ quarantine });
    const outcome = await noEngine.scan(job, { enabled: true, mode: 'sync', onScanError: 'fail-open' });
    assert.equal(outcome.status, 'error');
    assert.match(outcome.detail ?? '', /no antivirus engine/i);
    assert.equal(noEngine.isEnabled(), false);
    await noEngine.close();
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('oversized files are skipped (never streamed) and large queue overflow is policy-driven', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agil-quarantine-skip-'));
  const quarantine = new QuarantineStore({ dir });
  const service = new UploadScanService({
    scanner: fakeScanner(() => ({ status: 'clean' }), { delayMs: 25 }),
    quarantine,
    queueLimit: 1,
    concurrency: 1,
  });
  try {
    const big = makeJob(dir, Buffer.alloc(2 * 1024 * 1024, 1));
    const skipped = await service.scan(big.job, { enabled: true, mode: 'async', maxScanMb: 1 });
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.blocked, false);

    const first = await service.scan(makeJob(dir, Buffer.from('a')).job, { enabled: true, mode: 'async', maxScanMb: 25 });
    const second = await service.scan(makeJob(dir, Buffer.from('b')).job, { enabled: true, mode: 'async', maxScanMb: 25 });
    const overflow = await service.scan(makeJob(dir, Buffer.from('c')).job, {
      enabled: true,
      mode: 'async',
      onScanError: 'fail-open',
      maxScanMb: 25,
    });
    assert.equal(first.status, 'queued');
    assert.equal(second.status, 'queued');
    assert.equal(overflow.status, 'error');
    assert.match(overflow.detail ?? '', /queue is full/);
    assert.equal(overflow.quarantined, false);
    assert.equal(overflow.blocked, false);
    await service.idle();
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('double quarantine failure: raised critical callback, persisted block marker, no serve', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agil-quarantine-double-fail-'));
  const quarantine = new QuarantineStore({ dir });
  const failureEvents: QuarantineFailureEvent[] = [];
  const quarantineEvents: QuarantineEvent[] = [];
  const service = new UploadScanService({
    scanner: fakeScanner(() => ({ status: 'infected', signature: 'Eicar-Test-Signature' })),
    quarantine,
    onQuarantined: (event) => quarantineEvents.push(event),
    onQuarantineFailed: (event) => failureEvents.push(event),
  });
  // Fault injection: archive write AND live-copy removal both fail.
  (quarantine as unknown as { put: () => never }).put = () => {
    throw new Error('ENOSPC: no space left on device');
  };
  try {
    const { job } = makeJob(dir, EICAR);
    job.remove = () => false;
    const outcome = await service.scan(job, { enabled: true, mode: 'sync', maxScanMb: 25 });

    assert.equal(outcome.status, 'infected');
    assert.equal(outcome.quarantined, false, 'no archive record exists');
    assert.equal(outcome.removed, false, 'the live copy is still there');
    assert.equal(outcome.blocked, true, 'infected bytes must never be served');
    assert.match(outcome.detail ?? '', /could not be removed/i);
    assert.equal(quarantineEvents.length, 0, 'nothing was archived');
    assert.equal(failureEvents.length, 1);
    assert.equal(failureEvents[0]?.archived, false);
    assert.equal(failureEvents[0]?.blockPersisted, true);
    assert.match(failureEvents[0]?.error ?? '', /ENOSPC/);
    assert.equal(quarantine.list({ tenantId: 'demo' }).length, 0);

    // The deny marker is durable: a restarted store still refuses the file id.
    assert.equal(quarantine.isBlocked('demo', 'file-1'), true);
    assert.equal(quarantine.isBlocked('acme', 'file-1'), false, 'tenant-scoped');
    const reopened = new QuarantineStore({ dir });
    assert.equal(reopened.isBlocked('demo', 'file-1'), true);
    assert.equal(reopened.isBlocked('acme', 'file-1'), false);
    // External providers may use ids longer than 64 characters.
    const externalId = `ext-${'a'.repeat(80)}`;
    quarantine.block({ tenantId: 'demo', sourceId: externalId, fileName: 'x.bin' });
    assert.equal(quarantine.isBlocked('demo', externalId), true);
    assert.equal(new QuarantineStore({ dir }).isBlocked('demo', externalId), true);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archive succeeds but removal fails: file.quarantined + failure callback + block marker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agil-quarantine-remove-fail-'));
  const quarantine = new QuarantineStore({ dir });
  const failureEvents: QuarantineFailureEvent[] = [];
  const quarantineEvents: QuarantineEvent[] = [];
  const service = new UploadScanService({
    scanner: fakeScanner(() => ({ status: 'infected', signature: 'Eicar-Test-Signature' })),
    quarantine,
    onQuarantined: (event) => quarantineEvents.push(event),
    onQuarantineFailed: (event) => failureEvents.push(event),
  });
  try {
    const { job } = makeJob(dir, EICAR);
    job.remove = () => false;
    const outcome = await service.scan(job, { enabled: true, mode: 'sync', maxScanMb: 25 });

    assert.equal(outcome.status, 'infected');
    assert.equal(outcome.quarantined, true);
    assert.equal(outcome.removed, false);
    assert.equal(outcome.blocked, true);
    assert.equal(quarantineEvents.length, 1, 'the archive record is still reported');
    assert.equal(failureEvents.length, 1, 'the removal failure is a separate critical event');
    assert.equal(failureEvents[0]?.archived, true);
    assert.equal(failureEvents[0]?.quarantineId, quarantineEvents[0]?.record.id);
    assert.equal(quarantine.isBlocked('demo', 'file-1'), true);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('durable async queue: a queued scan survives a crash and is recovered on restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agil-av-spool-'));
  const quarantine = new QuarantineStore({ dir: join(root, 'quarantine') });
  const spoolDir = join(root, 'av-queue');
  let removeCalls = 0;
  // Simulates the process dying mid-scan: the promise never settles and the
  // first service is abandoned (no close/idle) — only the spool remains.
  const stuck: AvScanner = {
    name: 'stuck',
    isConfigured: () => true,
    scan: () => new Promise<AvScanResult>(() => {}),
  };
  const first = new UploadScanService({ scanner: stuck, quarantine, spoolDir });
  try {
    const firstJob = makeJob(root, EICAR).job;
    const accepted = await first.scan(firstJob, { enabled: true, mode: 'async', onScanError: 'fail-closed', maxScanMb: 25 });
    assert.equal(accepted.status, 'queued');
    const spooled = readdirSync(spoolDir);
    assert.ok(spooled.some((name) => name.endsWith('.json')), 'metadata is durable before the 200');
    assert.ok(spooled.some((name) => name.endsWith('.bin')), 'payload is durable before the 200');

    // "Restart": a new process instance recovers the unfinished job and scans it.
    const second = new UploadScanService({
      scanner: fakeScanner(() => ({ status: 'infected', signature: 'Eicar-Test-Signature' })),
      quarantine,
      spoolDir,
    });
    const recovered = await second.recoverPending({
      removeFile: () => {
        removeCalls += 1;
        return true;
      },
    });
    assert.equal(recovered, 1);
    await second.idle();
    assert.equal(removeCalls, 1, 'the recovered job removes the live copy');
    assert.equal(quarantine.count('demo'), 1, 'the recovered infected file is quarantined');
    assert.equal(quarantine.list({ tenantId: 'demo' })[0]?.sourceId, 'file-1');
    assert.deepEqual(readdirSync(spoolDir), [], 'finished jobs leave no spool files');
    await second.close();
  } finally {
    // Do not await close(): the stuck scan intentionally never completes.
    void first.close(10);
    rmSync(root, { recursive: true, force: true });
  }
});

test('durable async queue: a restart without any scanner still fails closed (P2-3-R)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agil-av-spool-noscan-'));
  const quarantine = new QuarantineStore({ dir: join(root, 'quarantine') });
  const spoolDir = join(root, 'av-queue');
  let removeCalls = 0;
  // First process: the scanner never settles, so the job stays in the spool.
  const stuck: AvScanner = {
    name: 'stuck',
    isConfigured: () => true,
    scan: () => new Promise<AvScanResult>(() => {}),
  };
  const first = new UploadScanService({ scanner: stuck, quarantine, spoolDir });
  const unavailable: ScanUnavailableEvent[] = [];
  const quarantineEvents: QuarantineEvent[] = [];
  try {
    const accepted = await first.scan(makeJob(root, EICAR).job, {
      enabled: true,
      mode: 'async',
      onScanError: 'fail-closed',
      maxScanMb: 25,
    });
    assert.equal(accepted.status, 'queued');
    assert.equal(readdirSync(spoolDir).length, 2, 'payload + metadata are spooled before the 200');

    // Restart with NO scanner configured (engine removed / deployment misconfigured).
    const second = new UploadScanService({
      quarantine,
      spoolDir,
      onScanUnavailable: (event) => unavailable.push(event),
      onQuarantined: (event) => quarantineEvents.push(event),
    });
    assert.equal(second.isEnabled(), false);
    const recovered = await second.recoverPending({
      removeFile: () => {
        removeCalls += 1;
        return true;
      },
    });
    assert.equal(recovered, 1, 'the spooled job is recovered even without an engine');
    await second.idle();

    assert.equal(removeCalls, 1, 'the live copy is removed (fail closed)');
    assert.deepEqual(readdirSync(spoolDir), [], 'the spool is drained, not left behind');

    const records = quarantine.list({ tenantId: 'demo' });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.reason, 'scan_error');
    assert.equal(records[0]?.sourceId, 'file-1');
    assert.match(records[0]?.detail ?? '', /no antivirus engine is configured/i);
    assert.equal(quarantineEvents.length, 1, 'the archived payload is still reported');

    assert.equal(unavailable.length, 1, 'one critical scan-unavailable signal per job');
    assert.equal(unavailable[0]?.recovered, true);
    assert.equal(unavailable[0]?.outcome.blocked, true);
    assert.equal(unavailable[0]?.outcome.quarantined, true);
    assert.equal(unavailable[0]?.outcome.removed, true);
    assert.match(unavailable[0]?.scan.detail ?? '', /re-scan a queued job after restart/i);
    await second.close();
  } finally {
    // Do not await close(): the stuck scan intentionally never completes.
    void first.close(10);
    rmSync(root, { recursive: true, force: true });
  }
});

test('durable async queue: spool write failure scans inline instead of acknowledging an unscanned job', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agil-av-spool-bad-'));
  const quarantine = new QuarantineStore({ dir: join(root, 'quarantine') });
  const notADir = join(root, 'not-a-dir');
  writeFileSync(notADir, 'x');
  let calls = 0;
  const scanner = fakeScanner(() => {
    calls += 1;
    return { status: 'clean' };
  });
  const service = new UploadScanService({ scanner, quarantine, spoolDir: notADir });
  try {
    const outcome = await service.scan(makeJob(root, Buffer.from('hello')).job, {
      enabled: true,
      mode: 'async',
      onScanError: 'fail-closed',
      maxScanMb: 25,
    });
    assert.notEqual(outcome.status, 'queued', 'no false acknowledgement without durability');
    assert.equal(outcome.status, 'clean');
    assert.equal(calls, 1, 'the payload was scanned inline');
    assert.equal(outcome.blocked, false);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('durable async queue: a truncated spool payload fails closed without scanning partial bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agil-av-spool-corrupt-'));
  const quarantine = new QuarantineStore({ dir: join(root, 'quarantine') });
  const spoolDir = join(root, 'av-queue');
  const stuck: AvScanner = {
    name: 'stuck',
    isConfigured: () => true,
    scan: () => new Promise<AvScanResult>(() => {}),
  };
  const first = new UploadScanService({ scanner: stuck, quarantine, spoolDir });
  try {
    await first.scan(makeJob(root, EICAR).job, {
      enabled: true,
      mode: 'async',
      onScanError: 'fail-closed',
      maxScanMb: 25,
    });
    const bin = readdirSync(spoolDir).find((name) => name.endsWith('.bin'));
    assert.ok(bin, 'payload was spooled');
    writeFileSync(join(spoolDir, bin), Buffer.from('partial'));
    let calls = 0;
    let removed = false;
    const second = new UploadScanService({
      scanner: fakeScanner(() => {
        calls += 1;
        return { status: 'clean' };
      }),
      quarantine,
      spoolDir,
    });
    const recovered = await second.recoverPending({
      removeFile: () => {
        removed = true;
        return true;
      },
    });
    await second.idle();
    assert.equal(recovered, 0, 'the truncated job is not scanned as a clean file');
    assert.equal(calls, 0, 'partial bytes are never streamed to the scanner');
    assert.equal(removed, true, 'the live copy is removed (fail closed)');
    assert.equal(quarantine.list({ tenantId: 'demo' })[0]?.reason, 'scan_error');
    assert.match(quarantine.list({ tenantId: 'demo' })[0]?.detail ?? '', /missing or truncated spool payload/i);
    assert.deepEqual(readdirSync(spoolDir), []);
    await second.close();
  } finally {
    void first.close(10);
    rmSync(root, { recursive: true, force: true });
  }
});
