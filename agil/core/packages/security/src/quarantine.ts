/**
 * Quarantine store for uploads that failed malware scanning.
 *
 * Layout: `<dir>/<uuid>` (payload) + `<dir>/<uuid>.json` (metadata), the same
 * safe-id scheme as {@link FileStore}. A quarantine record is **never** served
 * by the public API: admins may list/inspect metadata and purge, but the
 * payload is not downloadable (serving live malware back would be a new
 * vulnerability).
 *
 * Records are tenant-scoped: every read requires the owning `tenantId`, and
 * `list()` filters by tenant so one tenant can never enumerate another's
 * quarantined files.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from './av.js';
import {
  clampText,
  ensureDir,
  listBlobRecords,
  readBlobRecord,
  readJsonFile,
  removeBlobFiles,
  sanitizeFileName,
  saveBlobRecord,
  writeJsonAtomic,
} from './storage.js';

export type QuarantineReason = 'infected' | 'scan_error' | 'manual';

export interface QuarantineRecord {
  id: string;
  tenantId: string;
  roomId: string;
  /** Original store id (FileStore record) when the upload was already stored. */
  sourceId: string;
  fileName: string;
  mime: string;
  size: number;
  /** SHA-256 of the quarantined bytes (correlation, never reversible). */
  sha256: string;
  reason: QuarantineReason;
  engine: string;
  signature?: string;
  detail?: string;
  quarantinedAt: number;
  /** Uploader/participant id when known (no PII beyond the internal id). */
  uploadedBy?: string;
}

export interface QuarantineInput {
  data: Buffer;
  tenantId: string;
  roomId?: string;
  sourceId?: string;
  fileName?: string;
  mime?: string;
  reason: QuarantineReason;
  engine?: string;
  signature?: string;
  detail?: string;
  uploadedBy?: string;
}

export interface QuarantineListOptions {
  tenantId?: string;
  limit?: number;
}

export interface QuarantineStoreOptions {
  /** Data directory, e.g. `<AGIL_DATA_DIR>/quarantine`. Created recursively. */
  dir: string;
  /** Maximum number of records returned by `list()` (default 100, capped 1000). */
  listLimit?: number;
}

/**
 * A "do not serve" marker written when the live copy could not be removed after
 * a scan verdict (archive write failed, download-store removal failed, or both).
 *
 * It is intentionally separate from {@link QuarantineRecord}: there may be no
 * archived payload at all (the disk-full case), yet the original file id must
 * never be served again. The list endpoint still only shows real quarantined
 * payloads; this marker is used by the download handler and by the critical
 * `file.quarantine_failed` audit/webhook.
 */
export interface QuarantineBlockRecord {
  tenantId: string;
  sourceId: string;
  roomId: string;
  fileName: string;
  reason: QuarantineReason;
  /** True when the payload was archived even though removal failed. */
  archived: boolean;
  blockedAt: number;
  detail?: string;
}

export interface QuarantineBlockInput {
  tenantId: string;
  sourceId: string;
  roomId?: string;
  fileName?: string;
  reason?: QuarantineReason;
  archived?: boolean;
  detail?: string;
}

export interface QuarantineBlockListOptions {
  tenantId?: string;
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

export class QuarantineStore {
  readonly dir: string;
  /** `<dir>/blocked/` — metadata-only "do not serve" markers. */
  readonly blockedDir: string;
  private readonly listLimit: number;
  private readonly blocked = new Map<string, QuarantineBlockRecord>();

  constructor(options: QuarantineStoreOptions) {
    if (!options || typeof options.dir !== 'string' || options.dir.length === 0) {
      throw new Error('QuarantineStore: dir is required');
    }
    this.dir = options.dir;
    this.blockedDir = join(this.dir, 'blocked');
    this.listLimit =
      Number.isFinite(options.listLimit) && (options.listLimit as number) >= 1
        ? Math.min(MAX_LIST_LIMIT, Math.floor(options.listLimit as number))
        : DEFAULT_LIST_LIMIT;
    ensureDir(this.dir);
    ensureDir(this.blockedDir);
    this.loadBlocked();
  }

  /** Stable key for the block index (tenant-scoped; safe id is not required). */
  private blockKey(tenantId: string, sourceId: string): string {
    return sha256Hex(Buffer.from(`${tenantId}\u0000${sourceId}`, 'utf8'));
  }

  private blockPath(tenantId: string, sourceId: string): string {
    return join(this.blockedDir, `${this.blockKey(tenantId, sourceId)}.json`);
  }

  /** Loads persisted block markers on startup so a restart cannot un-deny a file. */
  private loadBlocked(): void {
    let names: string[];
    try {
      names = readdirSync(this.blockedDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const record = readJsonFile<QuarantineBlockRecord>(join(this.blockedDir, name));
      if (!record || typeof record.tenantId !== 'string' || typeof record.sourceId !== 'string') continue;
      const tenantId = clampText(record.tenantId, 64, '');
      const sourceId = QuarantineStore.blockSourceId(record.sourceId);
      if (!tenantId || !sourceId) continue;
      this.blocked.set(this.blockKey(tenantId, sourceId), record);
    }
  }

  /** Stores the payload + metadata; returns the record that was persisted. */
  put(input: QuarantineInput): QuarantineRecord {
    if (!input || !Buffer.isBuffer(input.data)) {
      throw new Error('QuarantineStore.put: data must be a Buffer');
    }
    const record: QuarantineRecord = {
      id: randomUUID(),
      tenantId: clampText(input.tenantId, 64, 'demo'),
      roomId: clampText(input.roomId, 64, ''),
      sourceId: clampText(input.sourceId, 64, ''),
      fileName: sanitizeFileName(input.fileName),
      mime: clampText(input.mime, 128, 'application/octet-stream'),
      size: input.data.length,
      sha256: sha256Hex(input.data),
      reason: input.reason,
      engine: clampText(input.engine, 64, 'unknown'),
      ...(input.signature ? { signature: clampText(input.signature, 200) } : {}),
      ...(input.detail ? { detail: clampText(input.detail, 500) } : {}),
      quarantinedAt: Date.now(),
      ...(input.uploadedBy ? { uploadedBy: clampText(input.uploadedBy, 64, '') } : {}),
    };
    saveBlobRecord(this.dir, input.data, record);
    return record;
  }

  /** Normalised source id used by the deny index (external providers may use long ids). */
  private static blockSourceId(sourceId: unknown): string {
    return clampText(sourceId, 200, '');
  }

  /**
   * Marks a source file id as "never serve" even when it could not be archived.
   *
   * The marker is persisted under `<dir>/blocked/<hash>.json` (metadata only,
   * tenant-scoped) and cached in memory. If the write fails the in-memory deny
   * is still installed, so this process cannot serve the bytes; the caller logs
   * the persistence failure and emits the critical alert.
   */
  block(input: QuarantineBlockInput): QuarantineBlockRecord {
    const tenantId = clampText(input?.tenantId, 64, '');
    const sourceId = QuarantineStore.blockSourceId(input?.sourceId);
    if (!tenantId || !sourceId) throw new Error('QuarantineStore.block: tenantId and sourceId are required');
    const record: QuarantineBlockRecord = {
      tenantId,
      sourceId,
      roomId: clampText(input.roomId, 64, ''),
      fileName: sanitizeFileName(input.fileName),
      reason: input.reason ?? 'scan_error',
      archived: input.archived === true,
      blockedAt: Date.now(),
      ...(input.detail ? { detail: clampText(input.detail, 500) } : {}),
    };
    const key = this.blockKey(tenantId, sourceId);
    this.blocked.set(key, record);
    // Persisting is best-effort on top of the in-memory deny (disk-full case).
    writeJsonAtomic(this.blockPath(tenantId, sourceId), record);
    return record;
  }

  /** True when the source file id must not be served (tenant-scoped). */
  isBlocked(tenantId: string, sourceId: string): boolean {
    const tenant = clampText(tenantId, 64, '');
    const source = QuarantineStore.blockSourceId(sourceId);
    if (!tenant || !source) return false;
    return this.blocked.has(this.blockKey(tenant, source));
  }

  /** Block markers (diagnostics/tests); tenant-scoped when `tenantId` is set. */
  listBlocked(options: QuarantineBlockListOptions = {}): QuarantineBlockRecord[] {
    return [...this.blocked.values()]
      .filter((record) => (options.tenantId === undefined ? true : record.tenantId === options.tenantId))
      .sort((a, b) => b.blockedAt - a.blockedAt);
  }

  /** Lists records newest first, optionally filtered to one tenant. */
  list(options: QuarantineListOptions = {}): QuarantineRecord[] {
    const limit =
      Number.isFinite(options.limit) && (options.limit as number) >= 1
        ? Math.min(MAX_LIST_LIMIT, Math.floor(options.limit as number))
        : this.listLimit;
    return listBlobRecords<QuarantineRecord>(this.dir)
      .filter((record) => (options.tenantId === undefined ? true : record.tenantId === options.tenantId))
      .sort((a, b) => b.quarantinedAt - a.quarantinedAt)
      .slice(0, limit);
  }

  /**
   * Loads one record + payload. Returns null unless `tenantId` matches, so a
   * guessed id can never cross tenants. Intended for admin diagnostics only.
   */
  get(tenantId: string, id: string): { record: QuarantineRecord; data: Buffer } | null {
    const loaded = readBlobRecord<QuarantineRecord>(this.dir, id);
    if (!loaded) return null;
    if (clampText(tenantId, 64, '') !== loaded.record.tenantId) return null;
    return loaded;
  }

  /** Deletes payload + metadata; tenant-scoped. Returns true when anything existed. */
  remove(tenantId: string, id: string): boolean {
    const loaded = this.get(tenantId, id);
    if (!loaded) return false;
    return removeBlobFiles(this.dir, id);
  }

  /** Number of quarantined files (optionally for one tenant). */
  count(tenantId?: string): number {
    return this.list({ ...(tenantId ? { tenantId } : {}), limit: MAX_LIST_LIMIT }).length;
  }
}
