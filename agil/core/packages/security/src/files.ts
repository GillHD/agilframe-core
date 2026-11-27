/**
 * Server-side storage for chat file attachments.
 *
 * Layout: `<dir>/<uuid>` (bytes) + `<dir>/<uuid>.json` (metadata). Downloads are
 * authorised by an HMAC-signed, expiring URL:
 *   ${baseUrl}/v1/files/<id>?sig=<base64url>&exp=<epoch ms>
 *
 * The signature covers `file:<id>:<exp>`; `get()` verifies it in constant time,
 * checks the TTL, rejects unsafe ids (path traversal) and unknown files.
 */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { FileRecord } from '@agil/protocol';
import { SecurityError } from './errors.js';
import { signPayload, verifyPayload } from './signing.js';
import {
  DEFAULT_TTL_SEC,
  MB,
  clampText,
  ensureDir,
  isMimeAllowed,
  isSafeStorageId,
  listBlobRecords,
  normalizeMime,
  readBlobRecord,
  removeBlobFiles,
  sanitizeFileName,
  saveBlobRecord,
} from './storage.js';

const DEFAULT_MAX_FILE_MB = 25;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

export interface FileStoreOptions {
  /** Data directory, e.g. `<AGIL_DATA_DIR>/files`. Created recursively. */
  dir: string;
  /** HMAC secret (`AGIL_TOKEN_SECRET` or a dedicated `AGIL_FILE_SECRET`). */
  secret: string;
  /** Public origin used to build download URLs, e.g. `http://localhost:8787`. */
  baseUrl: string;
  /** Link/record TTL in seconds (default 86400 = `AGIL_FILE_TTL_SEC`). */
  ttlSec?: number;
  /** Default maximum upload size in MiB (default 25, `AGIL_MAX_UPLOAD_MB`). */
  maxSizeMb?: number;
  /** Default MIME allow-list; empty array = allow all except active content. */
  allowedMimeTypes?: string[];
}

export interface SaveFileOptions {
  data: Buffer;
  /** Original file name (sanitised to a basename; path separators stripped). */
  name: string;
  /** MIME type from the request `content-type` header. */
  mime: string;
  tenantId: string;
  roomId: string;
  /** Participant id/name of the uploader. */
  uploadedBy: string;
  /** Per-request override for the size limit (MiB). */
  maxSizeMb?: number;
  /** Per-request MIME allow-list override (e.g. `config.session.fileShare.allowedMimeTypes`). */
  allowedMimeTypes?: string[];
}

export interface SignedFileResult {
  record: FileRecord;
  data: Buffer;
}

export interface ListFilesOptions {
  tenantId?: string;
  roomId?: string;
  /** Maximum number of records to return (default 100, capped at 1000). */
  limit?: number;
}

function normalizeBaseUrl(baseUrl: string): string {
  const raw = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  return raw.replace(/\/+$/, '');
}

export class FileStore {
  readonly dir: string;
  private readonly secret: string;
  private readonly baseUrl: string;
  private readonly ttlSec: number;
  private readonly maxSizeMb: number;
  private readonly allowedMimeTypes: string[];

  constructor(opts: FileStoreOptions) {
    if (!opts || typeof opts.dir !== 'string' || opts.dir.length === 0) {
      throw new Error('FileStore: dir is required');
    }
    if (typeof opts.secret !== 'string' || opts.secret.length === 0) {
      throw new Error('FileStore: secret is required');
    }
    this.dir = opts.dir;
    this.secret = opts.secret;
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.ttlSec = Number.isFinite(opts.ttlSec) ? Math.floor(opts.ttlSec as number) : DEFAULT_TTL_SEC;
    this.maxSizeMb =
      Number.isFinite(opts.maxSizeMb) && (opts.maxSizeMb as number) > 0
        ? (opts.maxSizeMb as number)
        : DEFAULT_MAX_FILE_MB;
    this.allowedMimeTypes = Array.isArray(opts.allowedMimeTypes) ? opts.allowedMimeTypes : [];
    ensureDir(this.dir);
  }

  /** Signs `<id>` with an expiry; exposed for link refreshes and for tests. */
  sign(id: string, exp: number): string {
    return signPayload(this.secret, `file:${id}:${exp}`);
  }

  private urlFor(id: string, exp: number): string {
    return `${this.baseUrl}/v1/files/${id}?sig=${this.sign(id, exp)}&exp=${exp}`;
  }

  /**
   * Stores an uploaded file and returns its public record (with a signed URL).
   *
   * @throws SecurityError `file_too_large` | `unsupported_mime`
   */
  save(opts: SaveFileOptions): FileRecord {
    if (!opts || !Buffer.isBuffer(opts.data)) {
      throw new Error('FileStore.save: data must be a Buffer');
    }
    const limitMb =
      Number.isFinite(opts.maxSizeMb) && (opts.maxSizeMb as number) > 0 ? (opts.maxSizeMb as number) : this.maxSizeMb;
    if (opts.data.length > limitMb * MB) {
      throw new SecurityError(
        'file_too_large',
        `File is ${opts.data.length} bytes; the limit is ${Math.floor(limitMb * MB)} bytes`,
      );
    }

    const mime = normalizeMime(opts.mime);
    if (!mime) {
      throw new SecurityError('unsupported_mime', 'A valid MIME type is required');
    }
    const allowed = Array.isArray(opts.allowedMimeTypes) && opts.allowedMimeTypes.length > 0
      ? opts.allowedMimeTypes
      : this.allowedMimeTypes;
    if (!isMimeAllowed(mime, allowed)) {
      throw new SecurityError('unsupported_mime', `MIME type ${mime} is not allowed`);
    }

    const id = randomUUID();
    const now = Date.now();
    const exp = now + Math.max(0, this.ttlSec) * 1000;
    const record: FileRecord = {
      id,
      tenantId: clampText(opts.tenantId, 64, 'demo'),
      roomId: clampText(opts.roomId, 64, ''),
      name: sanitizeFileName(opts.name),
      size: opts.data.length,
      mime,
      url: this.urlFor(id, exp),
      createdAt: now,
      expiresAt: exp,
      uploadedBy: clampText(opts.uploadedBy, 64, ''),
    };

    saveBlobRecord(this.dir, opts.data, record);
    return record;
  }

  /**
   * Returns the file when the signed URL is valid and not expired; otherwise null.
   * Invalid ids (including path traversal attempts) yield null, never a throw.
   */
  get(id: string, sig: string | undefined, exp: number | undefined): SignedFileResult | null {
    if (!isSafeStorageId(id)) return null;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
    if (Date.now() > exp) return null;
    if (!verifyPayload(this.secret, `file:${id}:${exp}`, sig)) return null;
    return readBlobRecord<FileRecord>(this.dir, id);
  }

  /** Lists stored files, newest first. */
  list(opts: ListFilesOptions = {}): FileRecord[] {
    const limit =
      Number.isFinite(opts.limit) && (opts.limit as number) >= 1
        ? Math.min(MAX_LIST_LIMIT, Math.floor(opts.limit as number))
        : DEFAULT_LIST_LIMIT;
    return this.matching(opts)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  count(tenantId: string): number {
    return this.matching({ tenantId }).length;
  }

  private matching({ tenantId, roomId }: ListFilesOptions): FileRecord[] {
    return listBlobRecords<FileRecord>(this.dir).filter((record) =>
      (tenantId === undefined || record.tenantId === tenantId) && (roomId === undefined || record.roomId === roomId));
  }

  /** Deletes file + metadata; returns true when anything existed. */
  remove(id: string): boolean {
    return removeBlobFiles(this.dir, id);
  }

  /** Stable, non-reversible fingerprint of the stored payload (diagnostics). */
  fingerprint(id: string): string | null {
    if (!isSafeStorageId(id)) return null;
    const loaded = readBlobRecord<FileRecord>(this.dir, id);
    if (!loaded) return null;
    return createHash('sha256').update(loaded.data).digest('hex').slice(0, 32);
  }

  /** Absolute path of the payload (must not be exposed through the API). */
  filePath(id: string): string | null {
    return isSafeStorageId(id) ? join(this.dir, id) : null;
  }
}
