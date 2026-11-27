/**
 * Server-side storage for call recordings (+ optional transcript).
 *
 * Same layout and signed-URL scheme as {@link FileStore}, but the metadata is a
 * `RecordingRecord` with `durationSec`, `createdBy` and an optional `transcript`
 * (filled in later by the STT / AI pipeline via `attachTranscript`).
 *
 * Download URL: ${baseUrl}/v1/recordings/<id>?sig=<base64url>&exp=<epoch ms>
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { RecordingRecord } from '@agil/protocol';
import { SecurityError } from './errors.js';
import { signPayload, verifyPayload } from './signing.js';
import {
  DEFAULT_TTL_SEC,
  MB,
  clampText,
  ensureDir,
  isSafeStorageId,
  listBlobRecords,
  normalizeMime,
  readBlobRecord,
  readJsonFile,
  removeBlobFiles,
  saveBlobRecord,
  writeJsonAtomic,
} from './storage.js';

const DEFAULT_MAX_RECORDING_MB = 512;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;
const MAX_TRANSCRIPT_CHARS = 500_000;

function cleanTranscript(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, MAX_TRANSCRIPT_CHARS)
    : '';
}

export interface RecordingStoreOptions {
  /** Data directory, e.g. `<AGIL_DATA_DIR>/recordings`. Created recursively. */
  dir: string;
  /** HMAC secret (`AGIL_TOKEN_SECRET` or a dedicated secret). */
  secret: string;
  /** Public origin used to build download URLs, e.g. `http://localhost:8787`. */
  baseUrl: string;
  /** Link/record TTL in seconds (default 86400). */
  ttlSec?: number;
  /** Default maximum recording size in MiB (default 512). */
  maxSizeMb?: number;
}

export interface SaveRecordingOptions {
  data: Buffer;
  /** Recording MIME type (`video/webm`, `audio/webm`, `video/mp4`, ...). */
  mime: string;
  tenantId: string;
  roomId: string;
  /** Participant id/name that started the recording. */
  createdBy: string;
  durationSec: number;
  /** Optional transcript attached at save time. */
  transcript?: string;
  /** Per-request override for the size limit (MiB). */
  maxSizeMb?: number;
}

export interface SignedRecordingResult {
  record: RecordingRecord;
  data: Buffer;
}

export interface ListRecordingsOptions {
  tenantId?: string;
  roomId?: string;
  /** Maximum number of records to return (default 100, capped at 1000). */
  limit?: number;
}

function normalizeBaseUrl(baseUrl: string): string {
  const raw = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  return raw.replace(/\/+$/, '');
}

export class RecordingStore {
  readonly dir: string;
  private readonly secret: string;
  private readonly baseUrl: string;
  private readonly ttlSec: number;
  private readonly maxSizeMb: number;

  constructor(opts: RecordingStoreOptions) {
    if (!opts || typeof opts.dir !== 'string' || opts.dir.length === 0) {
      throw new Error('RecordingStore: dir is required');
    }
    if (typeof opts.secret !== 'string' || opts.secret.length === 0) {
      throw new Error('RecordingStore: secret is required');
    }
    this.dir = opts.dir;
    this.secret = opts.secret;
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.ttlSec = Number.isFinite(opts.ttlSec) ? Math.floor(opts.ttlSec as number) : DEFAULT_TTL_SEC;
    this.maxSizeMb =
      Number.isFinite(opts.maxSizeMb) && (opts.maxSizeMb as number) > 0
        ? (opts.maxSizeMb as number)
        : DEFAULT_MAX_RECORDING_MB;
    ensureDir(this.dir);
  }

  /** Signs `<id>` with an expiry; exposed for link refreshes and for tests. */
  sign(id: string, exp: number): string {
    return signPayload(this.secret, `recording:${id}:${exp}`);
  }

  private urlFor(id: string, exp: number): string {
    return `${this.baseUrl}/v1/recordings/${id}?sig=${this.sign(id, exp)}&exp=${exp}`;
  }

  /**
   * Stores a recording and returns its public record (with a signed URL).
   *
   * @throws SecurityError `file_too_large` | `unsupported_mime`
   */
  save(opts: SaveRecordingOptions): RecordingRecord {
    if (!opts || !Buffer.isBuffer(opts.data)) {
      throw new Error('RecordingStore.save: data must be a Buffer');
    }
    const limitMb =
      Number.isFinite(opts.maxSizeMb) && (opts.maxSizeMb as number) > 0 ? (opts.maxSizeMb as number) : this.maxSizeMb;
    if (opts.data.length > limitMb * MB) {
      throw new SecurityError(
        'file_too_large',
        `Recording is ${opts.data.length} bytes; the limit is ${Math.floor(limitMb * MB)} bytes`,
      );
    }

    const mime = normalizeMime(opts.mime) || 'video/webm';
    if (!/^(video|audio)\//.test(mime) && mime !== 'application/octet-stream') {
      throw new SecurityError('unsupported_mime', `Recording MIME type ${mime} is not supported`);
    }

    const id = randomUUID();
    const now = Date.now();
    const exp = now + Math.max(0, this.ttlSec) * 1000;
    const durationSec =
      typeof opts.durationSec === 'number' && Number.isFinite(opts.durationSec) && opts.durationSec > 0
        ? Math.round(opts.durationSec * 1000) / 1000
        : 0;

    const record: RecordingRecord = {
      id,
      tenantId: clampText(opts.tenantId, 64, 'demo'),
      roomId: clampText(opts.roomId, 64, ''),
      mime,
      size: opts.data.length,
      durationSec,
      url: this.urlFor(id, exp),
      createdAt: now,
      createdBy: clampText(opts.createdBy, 64, ''),
    };
    const transcript = cleanTranscript(opts.transcript);
    if (transcript) record.transcript = transcript;

    saveBlobRecord(this.dir, opts.data, record);
    return record;
  }

  /**
   * Returns the recording when the signed URL is valid and not expired;
   * otherwise null (including path-traversal ids).
   */
  get(id: string, sig: string | undefined, exp: number | undefined): SignedRecordingResult | null {
    if (!isSafeStorageId(id)) return null;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
    if (Date.now() > exp) return null;
    if (!verifyPayload(this.secret, `recording:${id}:${exp}`, sig)) return null;
    return readBlobRecord<RecordingRecord>(this.dir, id);
  }

  /** Lists recordings, newest first. */
  list(opts: ListRecordingsOptions = {}): RecordingRecord[] {
    const limit =
      Number.isFinite(opts.limit) && (opts.limit as number) >= 1
        ? Math.min(MAX_LIST_LIMIT, Math.floor(opts.limit as number))
        : DEFAULT_LIST_LIMIT;
    const exp = Date.now() + Math.max(0, this.ttlSec) * 1000;
    return this.matching(opts)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((record) => ({ ...record, url: this.urlFor(record.id, exp) }));
  }

  count(tenantId: string): number {
    return this.matching({ tenantId }).length;
  }

  private matching({ tenantId, roomId }: ListRecordingsOptions): RecordingRecord[] {
    return listBlobRecords<RecordingRecord>(this.dir).filter((record) =>
      (tenantId === undefined || record.tenantId === tenantId) && (roomId === undefined || record.roomId === roomId));
  }

  /**
   * Attaches/replaces the transcript of a recording.
   *
   * @throws SecurityError `not_found` when the recording does not exist.
   */
  attachTranscript(id: string, text: string): void {
    if (!isSafeStorageId(id)) throw new SecurityError('not_found', 'Recording not found');
    const loaded = readBlobRecord<RecordingRecord>(this.dir, id);
    if (!loaded) throw new SecurityError('not_found', 'Recording not found');
    const transcript = cleanTranscript(text);
    if (transcript) {
      loaded.record.transcript = transcript;
    } else {
      delete loaded.record.transcript;
    }
    writeJsonAtomic(join(this.dir, `${id}.json`), loaded.record);
  }

  /** Deletes recording + metadata; returns true when anything existed. */
  remove(id: string, tenantId?: string): boolean {
    if (!isSafeStorageId(id)) return false;
    if (tenantId !== undefined && readJsonFile<RecordingRecord>(join(this.dir, `${id}.json`))?.tenantId !== tenantId) return false;
    return removeBlobFiles(this.dir, id);
  }

  /** Absolute path of the payload (must not be exposed through the API). */
  filePath(id: string): string | null {
    return isSafeStorageId(id) ? join(this.dir, id) : null;
  }
}
