/**
 * Asynchronous upload-scan pipeline: bounded queue → {@link AvScanner} →
 * quarantine + callbacks.
 *
 * Policy is explicit per request (the server resolves it from
 * `config.security.avScan`):
 *   - `mode:'async'`  — answer the upload immediately and scan in the background;
 *     the stored copy is quarantined when infected, so a signed URL handed out
 *     earlier answers 403/404 after quarantine.
 *   - `mode:'sync'`   — wait for the verdict and let the handler reject the
 *     upload (HTTP 422 `file_infected`).
 *   - `onScanError:'fail-open'` keeps the file when the daemon is down/times out;
 *     `'fail-closed'` quarantines it (both modes) so unscanned bytes are never
 *     served.
 *
 * The queue is bounded (`queueLimit`) and single-concurrency by default: clamd
 * scans one stream at a time, and unbounded buffering of 25 MiB uploads would be
 * a memory DoS. Overflow applies the same error policy as a failed scan.
 *
 * With `spoolDir`, every accepted async job is written to disk (payload +
 * metadata) before the upload is acknowledged and removed only after the scan
 * completes; `UploadScanService.recoverPending` reloads unfinished jobs after a
 * restart (at-least-once). A queued/recovered job that finds no configured engine
 * is still failed closed as `scan_error` and reported through
 * `onScanUnavailable`, never silently skipped.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AvScanResult, AvScanner } from './av.js';
import type { QuarantineBlockRecord, QuarantineReason, QuarantineRecord, QuarantineStore } from './quarantine.js';

export type ScanMode = 'async' | 'sync';
export type ScanErrorPolicy = 'fail-open' | 'fail-closed';

/** Per-tenant scan policy resolved from `config.security.avScan`. */
export interface UploadScanPolicy {
  enabled: boolean;
  mode: ScanMode;
  onScanError: ScanErrorPolicy;
  /** Larger payloads are reported as `skipped` and never buffered to the daemon. */
  maxScanMb: number;
}

export interface UploadScanJob {
  /** Store id of the already-saved file (audit correlation). */
  fileId: string;
  tenantId: string;
  roomId?: string;
  fileName: string;
  mime: string;
  data: Buffer;
  uploadedBy?: string;
  /** Stored file size (webhook payload); defaults to `data.length`. */
  size?: number;
  /** Removes the live copy after quarantine; must never throw (may be async). */
  remove?: () => boolean | Promise<boolean>;
}

export type UploadScanStatus = 'disabled' | 'queued' | 'clean' | 'infected' | 'skipped' | 'error';

export interface UploadScanOutcome {
  status: UploadScanStatus;
  engine?: string;
  signature?: string;
  /** True when the payload was archived in quarantine (even if removal failed). */
  quarantined: boolean;
  quarantineId?: string;
  /** True when the live copy is gone (archived+removed, or removed without archive). */
  removed: boolean;
  /**
   * True when the bytes must never be served/shared: infected, or an
   * unscanned file under `onScanError:'fail-closed'`. The server also installs a
   * persistent deny marker for this file id when the live copy remains.
   */
  blocked: boolean;
  detail?: string;
  durationMs: number;
  policy: Pick<UploadScanPolicy, 'mode' | 'onScanError'>;
}

export interface QuarantineEvent {
  record: QuarantineRecord;
  scan: AvScanResult;
  job: UploadScanJob;
}

/**
 * Raised when the live copy could not be removed after a verdict that requires
 * quarantine (archive write failed, remove failed, or both). The server turns
 * this into a critical `file.quarantine_failed` audit + `security.event`
 * webhook and keeps the file id blocked from downloads.
 */
export interface QuarantineFailureEvent {
  job: UploadScanJob;
  scan: AvScanResult;
  reason: QuarantineReason;
  /** True when the payload was archived even though removal failed. */
  archived: boolean;
  quarantineId?: string;
  /** Whether the persistent "do not serve" marker was written. */
  blockPersisted: boolean;
  /** Archive-write error (when any). */
  error?: string;
  /** Live-copy removal error (when any). */
  removeError?: string;
}

export interface ScanEvent {
  outcome: UploadScanOutcome;
  job: UploadScanJob;
}

/**
 * Raised when a queued/recovered job has to be failed closed because no AV
 * engine is configured at scan time. `recovered` marks a durable-spool job
 * reloaded after a restart: it was accepted while fail-closed was enforced, so
 * skipping it would be a fail-closed bypass. The server turns this into a
 * critical `file.scan_unavailable` audit + `security.event` webhook.
 */
export interface ScanUnavailableEvent {
  job: UploadScanJob;
  scan: AvScanResult;
  outcome: UploadScanOutcome;
  /** True when {@link UploadScanService.recoverPending} reloaded the job. */
  recovered: boolean;
}

export interface UploadScanServiceOptions {
  /** Engine; when absent the service reports `disabled` and never scans. */
  scanner?: AvScanner;
  /** Quarantine store; without it fail-closed removes without archiving (audited). */
  quarantine?: QuarantineStore;
  /**
   * Durable spool directory for accepted async jobs (payload + metadata).
   * When set, a job is persisted before `scan()` reports `queued`, and
   * `recoverPending()` reloads it after a crash/restart. The server passes
   * `<AGIL_DATA_DIR>/av-queue`.
   */
  spoolDir?: string;
  /** Parallel scans (default 1; clamd streams one file at a time). */
  concurrency?: number;
  /** Maximum queued jobs before the overflow policy applies (default 50). */
  queueLimit?: number;
  /** Default scan timeout in milliseconds (default 15000). */
  timeoutMs?: number;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
  /** Called after a payload is quarantined (audit/webhook wiring). */
  onQuarantined?: (event: QuarantineEvent) => void;
  /** Called when a required quarantine could not remove/archive the live copy. */
  onQuarantineFailed?: (event: QuarantineFailureEvent) => void;
  /** Called when a queued/recovered job is failed closed because no engine exists. */
  onScanUnavailable?: (event: ScanUnavailableEvent) => void;
  /** Called for every completed scan (clean/infected/skipped/error). */
  onScan?: (event: ScanEvent) => void;
}

interface PendingScan {
  job: UploadScanJob;
  policy: UploadScanPolicy;
  /** Spool entry to delete after the scan (durable async queue). */
  spool?: string;
  /** True for a job reloaded by `recoverPending()` after a restart. */
  recovered?: boolean;
}

interface PersistedScanJob {
  version: 1;
  jobId: string;
  queuedAt: number;
  fileId: string;
  tenantId: string;
  roomId?: string;
  fileName: string;
  mime: string;
  /** Stored file size (webhook payload). */
  size: number;
  /** Spooled payload length (integrity check on recovery). */
  bytes: number;
  uploadedBy?: string;
  policy: UploadScanPolicy;
}

const SPOOL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const DEFAULT_QUEUE_LIMIT = 50;
const DEFAULT_TIMEOUT_MS = 15_000;

function normalizePolicy(policy: Partial<UploadScanPolicy> | undefined): UploadScanPolicy {
  const source = policy && typeof policy === 'object' ? policy : {};
  const maxScanMb =
    Number.isFinite(source.maxScanMb) && (source.maxScanMb as number) > 0 ? Math.floor(source.maxScanMb as number) : 25;
  return {
    enabled: source.enabled === true,
    mode: source.mode === 'sync' ? 'sync' : 'async',
    onScanError: source.onScanError === 'fail-closed' ? 'fail-closed' : 'fail-open',
    maxScanMb: Math.min(100, Math.max(1, maxScanMb)),
  };
}

function outcomeFromScan(scan: AvScanResult, policy: UploadScanPolicy): UploadScanOutcome {
  const blocked = scan.status === 'infected' || (scan.status === 'error' && policy.onScanError === 'fail-closed');
  return {
    status: scan.status,
    ...(scan.engine ? { engine: scan.engine } : {}),
    ...(scan.signature ? { signature: scan.signature } : {}),
    ...(scan.detail ? { detail: scan.detail } : {}),
    quarantined: false,
    removed: false,
    blocked,
    durationMs: scan.durationMs,
    policy: { mode: policy.mode, onScanError: policy.onScanError },
  };
}

export class UploadScanService {
  private readonly scanner?: AvScanner;
  private readonly quarantineStore?: QuarantineStore;
  private readonly spoolDir?: string;
  private readonly concurrency: number;
  private readonly queueLimit: number;
  private readonly timeoutMs: number;
  private readonly logger?: UploadScanServiceOptions['logger'];
  private readonly onQuarantined?: (event: QuarantineEvent) => void;
  private readonly onQuarantineFailed?: (event: QuarantineFailureEvent) => void;
  private readonly onScanUnavailable?: (event: ScanUnavailableEvent) => void;
  private readonly onScan?: (event: ScanEvent) => void;

  private readonly pending: PendingScan[] = [];
  private readonly idleWaiters: Array<() => void> = [];
  private active = 0;
  private counters = { completed: 0, infected: 0, quarantined: 0, errors: 0, skipped: 0 };

  constructor(options: UploadScanServiceOptions = {}) {
    const source = options && typeof options === 'object' ? options : {};
    this.scanner = source.scanner;
    this.quarantineStore = source.quarantine;
    this.spoolDir = typeof source.spoolDir === 'string' && source.spoolDir.length > 0 ? source.spoolDir : undefined;
    this.concurrency = Number.isFinite(source.concurrency) && (source.concurrency as number) >= 1
      ? Math.min(4, Math.floor(source.concurrency as number))
      : 1;
    this.queueLimit = Number.isFinite(source.queueLimit) && (source.queueLimit as number) >= 1
      ? Math.floor(source.queueLimit as number)
      : DEFAULT_QUEUE_LIMIT;
    this.timeoutMs = Number.isFinite(source.timeoutMs) && (source.timeoutMs as number) >= 500
      ? Math.floor(source.timeoutMs as number)
      : DEFAULT_TIMEOUT_MS;
    this.logger = source.logger;
    this.onQuarantined = source.onQuarantined;
    this.onQuarantineFailed = source.onQuarantineFailed;
    this.onScanUnavailable = source.onScanUnavailable;
    this.onScan = source.onScan;
  }

  /** True when an engine is configured (tenant policy still has to enable it). */
  isEnabled(): boolean {
    return Boolean(this.scanner?.isConfigured());
  }

  /** Engine name for health/diagnostics (`null` when not configured). */
  get engineName(): string | null {
    return this.scanner?.isConfigured() ? this.scanner.name : null;
  }

  stats(): { queued: number; running: number; completed: number; infected: number; quarantined: number; errors: number; skipped: number } {
    return { queued: this.pending.length, running: this.active, ...this.counters };
  }

  /**
   * Scans (or enqueues) one upload. `async` resolves with `queued` once the job
   * is accepted; the real outcome is delivered through `onScan`/`onQuarantined`.
   */
  async scan(job: UploadScanJob, policyInput: Partial<UploadScanPolicy>): Promise<UploadScanOutcome> {
    const policy = normalizePolicy(policyInput);
    if (!policy.enabled) {
      return {
        status: 'disabled',
        quarantined: false,
        removed: false,
        blocked: false,
        durationMs: 0,
        policy: { mode: policy.mode, onScanError: policy.onScanError },
      };
    }
    if (!Buffer.isBuffer(job?.data)) {
      return this.failClosedOrOpen(
        { ...job, data: Buffer.alloc(0) },
        policy,
        { status: 'error', engine: this.engineName ?? 'none', detail: 'data must be a Buffer', durationMs: 0, scannedAt: Date.now(), bytes: 0 },
        'scan_error',
      );
    }
    // Oversized payloads are never buffered: report `skipped` (documented limit).
    if (job.data.length > policy.maxScanMb * 1024 * 1024) {
      const outcome: UploadScanOutcome = {
        status: 'skipped',
        quarantined: false,
        removed: false,
        blocked: false,
        detail: `file is ${job.data.length} bytes; maxScanMb=${policy.maxScanMb}`,
        durationMs: 0,
        policy: { mode: policy.mode, onScanError: policy.onScanError },
      };
      this.record(outcome, job);
      return outcome;
    }

    if (!this.isEnabled()) {
      const missing = this.missingEngineScan(job, false);
      const outcome = await this.failClosedOrOpen(job, policy, missing, 'scan_error');
      if (outcome.blocked) this.emitScanUnavailable(job, missing, outcome, false);
      return outcome;
    }

    if (policy.mode === 'sync') {
      return this.run(job, policy);
    }

    if (this.pending.length >= this.queueLimit) {
      this.logger?.warn('antivirus queue is full; applying the configured error policy', {
        queueLimit: this.queueLimit,
        tenantId: job.tenantId,
      });
      const scan: AvScanResult = {
        status: 'error',
        engine: this.engineName ?? 'none',
        detail: `scan queue is full (${this.queueLimit})`,
        durationMs: 0,
        scannedAt: Date.now(),
        bytes: job.data.length,
      };
      return this.failClosedOrOpen(job, policy, scan, 'scan_error');
    }

    const spool = await this.persist(job, policy);
    if (this.spoolDir && !spool) {
      // No durable queue → do not acknowledge an async job that a crash would
      // lose. Scan inline instead (the upload simply waits for the verdict).
      this.logger?.warn('antivirus queue persistence failed; scanning inline', {
        tenantId: job.tenantId,
        fileId: job.fileId,
      });
      return this.run(job, policy);
    }

    this.pending.push({ job, policy, ...(spool ? { spool } : {}) });
    this.pump();
    return {
      status: 'queued',
      ...(this.engineName ? { engine: this.engineName } : {}),
      quarantined: false,
      removed: false,
      blocked: false,
      durationMs: 0,
      policy: { mode: policy.mode, onScanError: policy.onScanError },
    };
  }

  /**
   * Reloads unfinished async jobs from `spoolDir` after a restart and re-queues
   * them. `removeFile` reconstructs the live-copy removal callback (the server
   * passes its file provider); without it a recovered job still archives/blocks
   * but cannot delete the stored copy.
   *
   * If no engine is configured at restart, the recovered job is run through the
   * fail-closed error path (archive/block/remove + `onScanUnavailable`) instead
   * of being skipped, so restarting without a scanner cannot un-quarantine an
   * accepted upload.
   *
   * Returns the number of recovered jobs. Scanning continues in the background;
   * await `idle()` (tests) or let the normal callbacks run (production).
   */
  async recoverPending(options: {
    removeFile?: (input: { tenantId: string; fileId: string }) => boolean | Promise<boolean>;
  } = {}): Promise<number> {
    if (!this.spoolDir) return 0;
    let names: string[];
    try {
      names = await readdir(this.spoolDir);
    } catch {
      return 0;
    }
    let recovered = 0;
    const known = new Set<string>();
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const jobId = name.slice(0, -'.json'.length);
      if (!SPOOL_ID_RE.test(jobId)) continue;
      const metaPath = join(this.spoolDir, name);
      const dataPath = join(this.spoolDir, `${jobId}.bin`);
      let meta: PersistedScanJob | null = null;
      try {
        meta = JSON.parse(await readFile(metaPath, 'utf8')) as PersistedScanJob;
      } catch {
        meta = null;
      }
      let data: Buffer | null = null;
      try {
        data = await readFile(dataPath);
      } catch {
        data = null;
      }
      known.add(jobId);
      if (!meta || meta.jobId !== jobId || !Buffer.isBuffer(data) || !meta.fileId || !meta.tenantId) {
        // Metadata exists but the payload is unreadable: fail closed for this
        // file id (block + remove) instead of silently dropping the job.
        if (meta && typeof meta.fileId === 'string' && typeof meta.tenantId === 'string') {
          this.logger?.warn('antivirus spool entry is incomplete; failing closed', { jobId });
          await this.recoverOrphan(meta, options);
        } else {
          this.logger?.warn('antivirus spool metadata is unreadable; dropping the entry', { jobId });
        }
        await this.removeSpool(jobId);
        continue;
      }
      if (Number.isFinite(meta.bytes) && meta.bytes !== data.length) {
        // Truncated payload: treat like a failed scan rather than scanning a
        // partial file (the live copy is removed/blocked).
        await this.recoverOrphan(meta, options);
        await this.removeSpool(jobId);
        continue;
      }
      const policy: UploadScanPolicy = {
        enabled: true,
        mode: meta.policy?.mode === 'sync' ? 'sync' : 'async',
        onScanError: meta.policy?.onScanError === 'fail-closed' ? 'fail-closed' : 'fail-open',
        maxScanMb: normalizePolicy(meta.policy).maxScanMb,
      };
      const job: UploadScanJob = {
        fileId: meta.fileId,
        tenantId: meta.tenantId,
        ...(meta.roomId ? { roomId: meta.roomId } : {}),
        fileName: meta.fileName || 'file',
        mime: meta.mime || 'application/octet-stream',
        data,
        ...(meta.uploadedBy ? { uploadedBy: meta.uploadedBy } : {}),
        size: Number.isFinite(meta.size) ? meta.size : data.length,
        ...(options.removeFile
          ? { remove: () => options.removeFile!({ tenantId: meta.tenantId, fileId: meta.fileId }) }
          : {}),
      };
      // Recovered scans are appended to the same bounded queue; a spool larger
      // than the limit is still drained (the queue limit only gates new uploads).
      this.pending.push({ job, policy, spool: jobId, recovered: true });
      recovered += 1;
    }
    // Remove orphan payload files whose metadata never landed (crash window
    // before the job was acknowledged: the client got no signed URL).
    for (const name of names) {
      if (!name.endsWith('.bin')) continue;
      const jobId = name.slice(0, -'.bin'.length);
      if (!SPOOL_ID_RE.test(jobId) || known.has(jobId)) continue;
      await this.removeSpool(jobId);
    }
    // Aborted atomic metadata writes (rename never happened).
    for (const name of names) {
      if (!name.endsWith('.json.tmp')) continue;
      await rm(join(this.spoolDir, name), { force: true }).catch(() => undefined);
    }
    if (recovered > 0) {
      if (!this.isEnabled()) {
        // One alert per startup (not per recovered job): the scanner-less restart
        // must still be visible when the job list is long.
        this.logger?.warn('recovered antivirus jobs without a configured engine; they will be failed closed', {
          count: recovered,
        });
      }
      this.pump();
    }
    return recovered;
  }

  /** Best-effort fail-closed cleanup for a spool entry whose payload is missing. */
  private async recoverOrphan(
    meta: PersistedScanJob,
    options: { removeFile?: (input: { tenantId: string; fileId: string }) => boolean | Promise<boolean> },
  ): Promise<void> {
    const scan: AvScanResult = {
      status: 'error',
      engine: this.engineName ?? 'none',
      detail: 'queued scan job was lost on restart (missing or truncated spool payload)',
      durationMs: 0,
      scannedAt: Date.now(),
      bytes: 0,
    };
    const job: UploadScanJob = {
      fileId: meta.fileId,
      tenantId: meta.tenantId,
      ...(meta.roomId ? { roomId: meta.roomId } : {}),
      fileName: meta.fileName || 'file',
      mime: meta.mime || 'application/octet-stream',
      data: Buffer.alloc(0),
      ...(meta.uploadedBy ? { uploadedBy: meta.uploadedBy } : {}),
      ...(options.removeFile
        ? { remove: () => options.removeFile!({ tenantId: meta.tenantId, fileId: meta.fileId }) }
        : {}),
    };
    const policy: UploadScanPolicy = {
      enabled: true,
      mode: 'async',
      onScanError: 'fail-closed',
      maxScanMb: normalizePolicy(meta.policy).maxScanMb,
    };
    await this.failClosedOrOpen(job, policy, scan, 'scan_error');
  }

  private spoolPath(jobId: string, extension: 'bin' | 'json'): string {
    return join(this.spoolDir as string, `${jobId}.${extension}`);
  }

  /** Persists an async job before it is acknowledged; null when unavailable. */
  private async persist(job: UploadScanJob, policy: UploadScanPolicy): Promise<string | undefined> {
    if (!this.spoolDir) return undefined;
    const jobId = randomUUID();
    const meta: PersistedScanJob = {
      version: 1,
      jobId,
      queuedAt: Date.now(),
      fileId: job.fileId,
      tenantId: job.tenantId,
      ...(job.roomId ? { roomId: job.roomId } : {}),
      fileName: job.fileName,
      mime: job.mime,
      size: job.size ?? job.data.length,
      bytes: job.data.length,
      ...(job.uploadedBy ? { uploadedBy: job.uploadedBy } : {}),
      policy: { ...policy },
    };
    try {
      await mkdir(this.spoolDir, { recursive: true });
      await writeFile(this.spoolPath(jobId, 'bin'), job.data, { mode: 0o600 });
      // Metadata last and atomic: a crash never leaves a valid-looking job with
      // a truncated policy/meta file.
      const metaPath = this.spoolPath(jobId, 'json');
      const metaTmp = `${metaPath}.tmp`;
      await writeFile(metaTmp, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
      await rename(metaTmp, metaPath);
      return jobId;
    } catch (error) {
      this.logger?.warn('antivirus queue persistence failed', {
        error: error instanceof Error ? error.message : String(error),
        fileId: job.fileId,
      });
      await this.removeSpool(jobId);
      return undefined;
    }
  }

  private async removeSpool(jobId: string): Promise<void> {
    if (!this.spoolDir) return;
    await Promise.all(
      (['bin', 'json'] as const).map(async (extension) => {
        try {
          await rm(this.spoolPath(jobId, extension), { force: true });
        } catch {
          /* best effort: a stale entry is re-scanned after restart */
        }
      }),
    );
  }

  /** Resolves when the queue and all in-flight scans are finished. */
  idle(): Promise<void> {
    if (this.pending.length === 0 && this.active === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /** Drains in-flight work (bounded) so `server.close()` does not truncate scans. */
  async close(timeoutMs = 2000): Promise<void> {
    await Promise.race([
      this.idle(),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, timeoutMs));
        timer.unref?.();
      }),
    ]);
  }

  private pump(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const next = this.pending.shift() as PendingScan;
      this.active += 1;
      // Keep the spool entry until the scan resolves: if `run` throws (a scanner
      // contract violation), the job survives for startup recovery.
      const task = this.run(next.job, next.policy, next.recovered === true).then(async () => {
        if (next.spool) await this.removeSpool(next.spool);
      });
      void task
        .catch((error: unknown) => {
          this.logger?.warn('antivirus scan crashed', {
            error: error instanceof Error ? error.message : String(error),
            fileId: next.job.fileId,
          });
        })
        .finally(() => {
          this.active -= 1;
          this.settleIdle();
          this.pump();
        });
    }
    this.settleIdle();
  }

  private settleIdle(): void {
    if (this.pending.length > 0 || this.active > 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private async run(job: UploadScanJob, policy: UploadScanPolicy, recovered = false): Promise<UploadScanOutcome> {
    if (!this.isEnabled()) {
      // Recovered/queued job with no engine (engine removed or deployment
      // misconfigured). Fail closed instead of dereferencing the missing
      // scanner: an unscanned fail-closed upload must never stay downloadable.
      const missing = this.missingEngineScan(job, recovered);
      this.logger?.warn('antivirus engine is not configured for a queued scan; failing closed', {
        fileId: job.fileId,
        tenantId: job.tenantId,
        recovered,
        onScanError: policy.onScanError,
      });
      const outcome = await this.failClosedOrOpen(job, policy, missing, 'scan_error');
      if (outcome.blocked) this.emitScanUnavailable(job, missing, outcome, recovered);
      return outcome;
    }
    const scan = await (this.scanner as AvScanner).scan(
      {
        data: job.data,
        tenantId: job.tenantId,
        ...(job.roomId ? { roomId: job.roomId } : {}),
        fileId: job.fileId,
        fileName: job.fileName,
        mime: job.mime,
      },
      { timeoutMs: this.timeoutMs },
    );
    if (scan.status === 'infected') {
      return this.quarantine(job, policy, scan, 'infected');
    }
    if (scan.status === 'error') {
      return this.failClosedOrOpen(job, policy, scan, 'scan_error');
    }
    const outcome = outcomeFromScan(scan, policy);
    if (outcome.status === 'skipped') this.counters.skipped += 1;
    else this.counters.completed += 1;
    this.record(outcome, job);
    return outcome;
  }

  /**
   * Synthetic `error` verdict for "no engine configured". `recovered` only
   * changes the wording: a recovered job was accepted under fail-closed before
   * the crash and is now failed closed for the same reason.
   */
  private missingEngineScan(job: UploadScanJob, recovered: boolean): AvScanResult {
    return {
      status: 'error',
      engine: this.engineName ?? 'none',
      detail: recovered
        ? 'no antivirus engine is configured to re-scan a queued job after restart (AGIL_CLAMAV_* / AGIL_YARA_RULES)'
        : 'no antivirus engine is configured (AGIL_CLAMAV_* / AGIL_YARA_RULES)',
      durationMs: 0,
      scannedAt: Date.now(),
      bytes: job.data.length,
    };
  }

  /** Reports a fail-closed job that could not be scanned; never throws. */
  private emitScanUnavailable(
    job: UploadScanJob,
    scan: AvScanResult,
    outcome: UploadScanOutcome,
    recovered: boolean,
  ): void {
    try {
      this.onScanUnavailable?.({ job, scan, outcome, recovered });
    } catch (error) {
      this.logger?.warn('scan-unavailable callback failed', {
        error: error instanceof Error ? error.message : String(error),
        fileId: job.fileId,
      });
    }
  }

  /**
   * Fail-closed: archive + remove; fail-open: keep the file and report the error
   * (the audit trail still records that scanning did not happen).
   */
  private async failClosedOrOpen(
    job: UploadScanJob,
    policy: UploadScanPolicy,
    scan: AvScanResult,
    reason: QuarantineReason,
  ): Promise<UploadScanOutcome> {
    if (policy.onScanError === 'fail-closed') return this.quarantine(job, policy, scan, reason);
    const outcome = outcomeFromScan(scan, policy);
    this.counters.errors += 1;
    this.record(outcome, job);
    return outcome;
  }

  private async quarantine(
    job: UploadScanJob,
    policy: UploadScanPolicy,
    scan: AvScanResult,
    reason: QuarantineReason,
  ): Promise<UploadScanOutcome> {
    const outcome = outcomeFromScan(scan, policy);
    this.counters.errors += scan.status === 'error' ? 1 : 0;
    this.counters.infected += scan.status === 'infected' ? 1 : 0;

    let record: QuarantineRecord | undefined;
    let archiveError: string | undefined;
    try {
      record = this.quarantineStore?.put({
        data: job.data,
        tenantId: job.tenantId,
        roomId: job.roomId ?? '',
        sourceId: job.fileId,
        fileName: job.fileName,
        mime: job.mime,
        reason,
        engine: scan.engine,
        ...(scan.signature ? { signature: scan.signature } : {}),
        ...(scan.detail ? { detail: scan.detail } : {}),
        ...(job.uploadedBy ? { uploadedBy: job.uploadedBy } : {}),
      });
      outcome.quarantined = Boolean(record);
      if (record) outcome.quarantineId = record.id;
    } catch (error) {
      archiveError = error instanceof Error ? error.message : String(error);
      this.logger?.warn('quarantine write failed', {
        error: archiveError,
        fileId: job.fileId,
      });
    }

    // Remove the live copy even when archiving failed: infected bytes must not
    // stay downloadable. `remove` is documented to never throw.
    let removed = false;
    let removeError: string | undefined;
    try {
      removed = (await job.remove?.()) ?? false;
    } catch (error) {
      removeError = error instanceof Error ? error.message : String(error);
      this.logger?.warn('quarantine removal failed', {
        error: removeError,
        fileId: job.fileId,
      });
    }
    outcome.removed = removed;

    if (record) {
      this.counters.quarantined += 1;
    } else if (!removed) {
      outcome.detail = [outcome.detail, 'live copy could not be removed; file is blocked from downloads']
        .filter(Boolean)
        .join('; ');
    }

    // "Do not serve" guarantee: when removal failed, persist a tenant-scoped
    // block marker. It also covers the archived-but-not-removed case and
    // survives restarts, so the signed URL cannot turn back into a download.
    let blockPersisted = false;
    if (!removed) {
      try {
        const blocked: QuarantineBlockRecord | undefined = this.quarantineStore?.block({
          tenantId: job.tenantId,
          sourceId: job.fileId,
          ...(job.roomId ? { roomId: job.roomId } : {}),
          fileName: job.fileName,
          reason,
          archived: Boolean(record),
          ...(archiveError || removeError
            ? { detail: [archiveError ? `archive: ${archiveError}` : '', removeError ? `remove: ${removeError}` : ''].filter(Boolean).join('; ') }
            : {}),
        });
        blockPersisted = Boolean(blocked);
      } catch (error) {
        this.logger?.warn('quarantine block marker failed', {
          error: error instanceof Error ? error.message : String(error),
          fileId: job.fileId,
        });
      }
    }

    this.record(outcome, job);
    if (record) {
      try {
        this.onQuarantined?.({ record, scan, job });
      } catch (error) {
        this.logger?.warn('quarantine callback failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!removed) {
      try {
        this.onQuarantineFailed?.({
          job,
          scan,
          reason,
          archived: Boolean(record),
          ...(record ? { quarantineId: record.id } : {}),
          blockPersisted,
          ...(archiveError ? { error: archiveError } : {}),
          ...(removeError ? { removeError } : {}),
        });
      } catch (error) {
        this.logger?.warn('quarantine failure callback failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return outcome;
  }

  private record(outcome: UploadScanOutcome, job: UploadScanJob): void {
    try {
      this.onScan?.({ outcome, job });
    } catch (error) {
      this.logger?.warn('scan callback failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
