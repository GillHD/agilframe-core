import { createHash } from 'node:crypto';
import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { RecordingRecord } from '@agil/protocol';
import { ensureDir, readJsonFile, writeJsonAtomic } from '@agil/security';
import { EgressPlaybackError, normalizeObjectKey, objectKeyFromLocation, type EgressPlaybackService } from './egress-playback.js';
import type { EgressClient, EgressStartInput, EgressStartResult } from './egress.js';
import type { Logger } from './logger.js';

interface PendingRecording {
  id: string;
  tenantId: string;
  roomId: string;
  roomName: string;
  egressId: string;
  key: string;
  createdAt: number;
  storageId?: string;
}

interface ArchivedRecording extends PendingRecording {
  size: number;
  durationSec: number;
  unavailable?: true;
}

interface ArchiveOptions {
  directory: string;
  egress: Pick<EgressClient, 'info'>;
  playback: EgressPlaybackService;
  bucket: string;
  deletionEnabled: boolean;
  logger: Logger;
  publishReady(record: ArchivedRecording): void;
}

const SAFE_TENANT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const ARCHIVE_ID = /^egress-[a-f0-9]{40}$/;
const TERMINAL_FAILURES = new Set(['EGRESS_FAILED', 'EGRESS_ABORTED', 'EGRESS_LIMIT_REACHED']);
const POLL_BATCH = 20;
const AVAILABILITY_INTERVAL_MS = 60_000;

function recordingId(tenantId: string, roomId: string, egressId: string): string {
  const hash = createHash('sha256').update(JSON.stringify([tenantId, roomId, egressId])).digest('hex');
  return `egress-${hash.slice(0, 40)}`;
}

function filesIn(directory: string): string[] {
  try {
    return readdirSync(directory).filter(name => name.endsWith('.json') && ARCHIVE_ID.test(name.slice(0, -5)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function durationSeconds(duration: unknown): number {
  if (typeof duration !== 'string' && typeof duration !== 'number') return 0;
  const nanoseconds = Number(duration);
  return Number.isFinite(nanoseconds) && nanoseconds > 0 ? nanoseconds / 1_000_000_000 : 0;
}

/**
 * Tracks jobs started by this deployment. Metadata is separate from media and
 * lives under Core's persistent data directory. A pending entry is removed
 * only after archive commit and durable event enqueue, or terminal failure.
 */
export class EgressRecordingArchive {
  private readonly pendingDirectory: string;
  private readonly deleting = new Map<string, Promise<boolean>>();
  private polling: Promise<void> | undefined;
  private offset = 0;
  private availabilityOffset = 0;
  private nextAvailabilityPoll = 0;

  constructor(private readonly options: ArchiveOptions) {
    this.pendingDirectory = join(options.directory, 'pending');
  }

  track(input: EgressStartInput, result: EgressStartResult, key: string): void {
    if (!SAFE_TENANT.test(input.tenantId)) throw new Error('Invalid recording tenant');
    const id = recordingId(input.tenantId, input.roomId, result.egressId);
    if (this.get(input.tenantId, input.roomId, result.egressId)) return;
    const pending: PendingRecording = {
      id, tenantId: input.tenantId, roomId: input.roomId, roomName: result.roomName, egressId: result.egressId,
      key, createdAt: Date.now(),
      ...(this.options.playback.storageIdentity ? { storageId: this.options.playback.storageIdentity } : {}),
    };
    ensureDir(this.pendingDirectory);
    writeJsonAtomic(join(this.pendingDirectory, `${id}.json`), pending);
  }

  get(tenantId: string, roomId: string, egressId: string): ArchivedRecording | null {
    if (!SAFE_TENANT.test(tenantId)) return null;
    const id = recordingId(tenantId, roomId, egressId);
    const record = this.readArchived(tenantId, `${id}.json`);
    return record?.roomId === roomId && record.egressId === egressId ? record : null;
  }

  records(tenantId: string, origin: string, roomId?: string): RecordingRecord[] {
    if (!SAFE_TENANT.test(tenantId) || !this.options.playback.configured) return [];
    const directory = this.tenantDirectory(tenantId);
    return filesIn(directory)
      .map(name => this.readArchived(tenantId, name))
      .filter((record): record is ArchivedRecording => record !== null && record.storageId === this.options.playback.storageIdentity
        && !record.unavailable && (roomId === undefined || record.roomId === roomId))
      .sort((first, second) => second.createdAt - first.createdAt)
      .slice(0, 500)
      .map(record => ({
        id: record.id, tenantId, roomId: record.roomId, mime: 'video/mp4', size: record.size,
        durationSec: record.durationSec, createdAt: record.createdAt, createdBy: 'LiveKit Egress',
        url: this.link(record, origin).url, source: 'egress', canDelete: this.options.deletionEnabled,
      }));
  }

  inConfiguredStore(record: PendingRecording): boolean {
    const identity = this.options.playback.storageIdentity;
    return identity !== null && (!record.storageId || record.storageId === identity);
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    if (!SAFE_TENANT.test(tenantId) || !ARCHIVE_ID.test(id)) return false;
    const key = `${tenantId}/${id}`;
    const pending = this.deleting.get(key);
    if (pending) return pending;
    const job = this.removeRecording(tenantId, id).finally(() => { this.deleting.delete(key); });
    this.deleting.set(key, job);
    return job;
  }

  private async removeRecording(tenantId: string, id: string): Promise<boolean> {
    const name = `${id}.json`;
    const record = this.readArchived(tenantId, name);
    if (!record) return false;
    if (!this.options.deletionEnabled) {
      throw new EgressPlaybackError('egress_archive_delete_disabled', 409, 'Server recording deletion is disabled');
    }
    if (!this.inConfiguredStore(record)) {
      throw new EgressPlaybackError('egress_archive_storage_changed', 409, 'Recording belongs to a different storage backend');
    }
    if (!record.storageId && await this.options.playback.objectSize(record.key) !== record.size) {
      throw new EgressPlaybackError('egress_archive_object_changed', 409, 'Could not verify the stored recording');
    }
    await this.options.playback.removeArchiveObject(record.key, record.size);
    // A pending ready notification must not recreate a removed catalogue entry.
    removeIfPresent(join(this.pendingDirectory, name));
    removeIfPresent(join(this.tenantDirectory(tenantId), name));
    return true;
  }

  link(record: ArchivedRecording, origin: string, ttlSec?: number): { url: string; expiresAt: number } {
    const signed = this.options.playback.createLink({
      tenantId: record.tenantId, roomId: record.roomId, egressId: record.egressId,
      key: record.key, scope: 'file', origin, ...(ttlSec === undefined ? {} : { ttlSec }),
    });
    // The dashboard uses exp to know when to reload the catalogue. Playback
    // always enforces the expiry embedded in the signed token.
    return { url: `${signed.url}&exp=${signed.expiresAt}`, expiresAt: signed.expiresAt };
  }

  poll(isLeader: () => boolean): Promise<void> {
    if (!isLeader() || !this.options.playback.configured) return Promise.resolve();
    this.polling ??= Promise.all([this.reconcile(isLeader), this.reconcileAvailability(isLeader)])
      .then(() => undefined).finally(() => { this.polling = undefined; });
    return this.polling;
  }

  private tenantDirectory(tenantId: string): string {
    return join(this.options.directory, 'ready', tenantId);
  }

  private readArchived(tenantId: string, name: string): ArchivedRecording | null {
    const record = readJsonFile<ArchivedRecording>(join(this.tenantDirectory(tenantId), name));
    if (!record || record.tenantId !== tenantId || name !== `${record.id}.json`
      || typeof record.roomId !== 'string' || typeof record.egressId !== 'string' || typeof record.key !== 'string'
      || !record.key.startsWith(`${tenantId}/${record.roomId}/`) || !record.key.endsWith('.mp4')
      || normalizeObjectKey(record.key) !== record.key
      || (record.storageId !== undefined && !/^[a-f0-9]{64}$/.test(record.storageId))
      || !Number.isSafeInteger(record.size) || record.size <= 0) return null;
    return record;
  }

  private async reconcile(isLeader: () => boolean): Promise<void> {
    const names = filesIn(this.pendingDirectory).sort();
    if (!names.length) return;
    const start = this.offset % names.length;
    const batch = [...names.slice(start), ...names.slice(0, start)].slice(0, POLL_BATCH);
    this.offset = start + batch.length;
    await Promise.all(batch.map(async name => {
      const path = join(this.pendingDirectory, name);
      const record = readJsonFile<PendingRecording>(path);
      if (!record || !SAFE_TENANT.test(record.tenantId) || name !== `${record.id}.json` || !isLeader()) return;
      try {
        const archived = this.get(record.tenantId, record.roomId, record.egressId) ?? await this.finalize(record, isLeader);
        if (!isLeader()) return;
        if (archived === 'failed') removeIfPresent(path);
        if (archived && archived !== 'failed') {
          if (this.deleting.has(`${record.tenantId}/${record.id}`)) return;
          this.options.publishReady(archived);
          removeIfPresent(path);
        }
      } catch {
        // Provider/storage failure can be transient. Leave the pending record
        // for retry and avoid logging paths or upstream credentials.
        this.options.logger.warn('could not reconcile egress recording', {
          tenantId: record.tenantId, roomId: record.roomId, egressId: record.egressId,
        });
      }
    }));
  }

  private async finalize(record: PendingRecording, isLeader: () => boolean): Promise<ArchivedRecording | 'failed' | null> {
    const storageId = this.options.playback.storageIdentity;
    if (!storageId || !this.inConfiguredStore(record)) return null;
    const info = await this.options.egress.info(record.roomName, record.egressId, record.tenantId);
    if (!info || info.room_name !== record.roomName) return null;
    const status = String(info.status ?? '');
    if (TERMINAL_FAILURES.has(status)) return 'failed';
    if (status !== 'EGRESS_COMPLETE') return null;
    const file = Array.isArray(info.file_results)
      ? info.file_results[0] as { location?: unknown; filename?: unknown; size?: unknown; duration?: unknown } | undefined
      : undefined;
    const matchesObject = [file?.location, file?.filename].some(value => {
      const key = objectKeyFromLocation(value, this.options.bucket);
      return key === record.key || key === `out/${record.key}`;
    });
    if (!matchesObject) return null;
    const size = await this.options.playback.objectSize(record.key);
    if (size === null || size <= 0 || !isLeader()) return null;
    const expectedSize = Number(file?.size);
    if (Number.isSafeInteger(expectedSize) && expectedSize > 0 && size !== expectedSize) return null;
    const archived: ArchivedRecording = { ...record, storageId, size, durationSec: durationSeconds(file?.duration ?? info.duration) };
    const directory = this.tenantDirectory(record.tenantId);
    ensureDir(directory);
    writeJsonAtomic(join(directory, `${record.id}.json`), archived);
    return archived;
  }

  private async reconcileAvailability(isLeader: () => boolean): Promise<void> {
    const storageId = this.options.playback.storageIdentity;
    if (!storageId || Date.now() < this.nextAvailabilityPoll) return;
    this.nextAvailabilityPoll = Date.now() + AVAILABILITY_INTERVAL_MS;
    const records = this.readyFiles();
    if (!records.length) return;
    const start = this.availabilityOffset % records.length;
    const batch = [...records.slice(start), ...records.slice(0, start)].slice(0, POLL_BATCH);
    this.availabilityOffset = start + batch.length;
    await Promise.all(batch.map(async ({ tenantId, name }) => {
      const record = this.readArchived(tenantId, name);
      if (!record || !this.inConfiguredStore(record) || !isLeader()) return;
      try {
        const size = await this.options.playback.objectSize(record.key);
        if (!isLeader() || this.deleting.has(`${tenantId}/${record.id}`)) return;
        const current = this.readArchived(tenantId, name);
        if (!current || current.key !== record.key || current.size !== record.size) return;
        const { unavailable, ...metadata } = current;
        const present = size === current.size;
        if (present && (unavailable || !current.storageId)) {
          writeJsonAtomic(join(this.tenantDirectory(tenantId), name), { ...metadata, storageId });
        } else if (!present && !unavailable) {
          writeJsonAtomic(join(this.tenantDirectory(tenantId), name), { ...metadata, unavailable: true });
        }
      } catch {
        // Provider errors are inconclusive. Keep catalogue metadata intact.
        this.options.logger.warn('could not check archived recording availability', { tenantId, roomId: record.roomId, egressId: record.egressId });
      }
    }));
  }

  private readyFiles(): Array<{ tenantId: string; name: string }> {
    try {
      return readdirSync(join(this.options.directory, 'ready'), { withFileTypes: true })
        .filter(entry => entry.isDirectory() && SAFE_TENANT.test(entry.name))
        .flatMap(entry => filesIn(this.tenantDirectory(entry.name)).sort().map(name => ({ tenantId: entry.name, name })));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

function removeIfPresent(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
