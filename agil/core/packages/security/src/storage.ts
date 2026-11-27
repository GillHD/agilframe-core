/**
 * Small filesystem helpers shared by {@link FileStore} and {@link RecordingStore}.
 *
 * On-disk layout of a store directory:
 *   <dir>/<id>        — raw binary payload
 *   <dir>/<id>.json   — metadata record
 *
 * The `id` is always generated with `crypto.randomUUID()` and validated against
 * a strict allow-list before any path is built, which keeps `..`/`/` out of the
 * filesystem.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Bytes in one megabyte (binary). */
export const MB = 1024 * 1024;

/** Default download-link / retention TTL: 24 hours. */
export const DEFAULT_TTL_SEC = 86_400;

/** Only UUID-like identifiers are accepted for storage paths. */
export const STORAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** MIME types that are never stored (active content could be served from the API origin). */
const BLOCKED_MIME_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
  'application/x-javascript',
  'application/x-shockwave-flash',
]);

/** Creates `dir` (recursively) if it does not exist yet. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Returns true when `id` is safe to use as a single path segment. */
export function isSafeStorageId(id: unknown): id is string {
  return typeof id === 'string' && STORAGE_ID_RE.test(id);
}

/** Truncates untrusted text and strips control characters; never throws. */
export function clampText(value: unknown, maxLength: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Keeps only the basename of an uploaded file name, capped and control-char free. */
export function sanitizeFileName(name: unknown): string {
  const raw = typeof name === 'string' ? name : '';
  const base = raw.split(/[\\/]/).pop() ?? '';
  return clampText(base, 200, 'file');
}

/** Lowercases a MIME type, drops parameters and rejects non `type/subtype` values. */
export function normalizeMime(mime: unknown): string {
  if (typeof mime !== 'string') return '';
  const bare = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(bare)) return '';
  return bare;
}

/** True for MIME types that must not be stored/served (active content). */
export function isBlockedMimeType(mime: string): boolean {
  return BLOCKED_MIME_TYPES.has(mime);
}

/**
 * Checks a MIME type against an allow-list. An empty allow-list allows every
 * non-blocked type; entries support exact values and `type/*` wildcards.
 */
export function isMimeAllowed(mime: string, allowedMimeTypes: readonly string[]): boolean {
  if (isBlockedMimeType(mime)) return false;
  if (allowedMimeTypes.length === 0) return true;
  for (const entry of allowedMimeTypes) {
    const rule = entry.trim().toLowerCase();
    if (!rule) continue;
    if (rule === '*/*' || rule === mime) return true;
    const slash = rule.indexOf('/*');
    if (slash > 0 && mime.startsWith(`${rule.slice(0, slash)}/`)) return true;
  }
  return false;
}

/** Writes a file atomically: temp file in the same directory, then rename. */
export function writeFileAtomic(path: string, data: Buffer | string, mode = 0o666): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(tmp, data, { mode, flag: 'wx' });
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp file may not exist — ignore */
    }
    throw error;
  }
}

/** Writes JSON atomically (metadata is small; pretty-printed for debuggability). */
export function writeJsonAtomic(path: string, value: unknown, mode?: number): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/** Reads and parses a JSON file; returns null for missing/corrupt files. */
export function readJsonFile<T>(path: string): T | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as T) : null;
  } catch {
    return null;
  }
}

/** Persists the payload plus its metadata record. */
export function saveBlobRecord(dir: string, data: Buffer, record: { id: string }): void {
  ensureDir(dir);
  const dataPath = join(dir, record.id);
  const metaPath = join(dir, `${record.id}.json`);
  try {
    writeFileAtomic(dataPath, data);
    writeJsonAtomic(metaPath, record);
  } catch (error) {
    try {
      unlinkSync(dataPath);
    } catch {
      /* nothing to clean up */
    }
    try {
      unlinkSync(metaPath);
    } catch {
      /* nothing to clean up */
    }
    throw error;
  }
}

/** Loads payload + metadata; returns null when either is missing or inconsistent. */
export function readBlobRecord<T extends { id: string; size?: number }>(
  dir: string,
  id: string,
): { record: T; data: Buffer } | null {
  if (!isSafeStorageId(id)) return null;
  const record = readJsonFile<T>(join(dir, `${id}.json`));
  if (!record || record.id !== id) return null;
  let data: Buffer;
  try {
    data = readFileSync(join(dir, id));
  } catch {
    return null;
  }
  if (typeof record.size === 'number' && record.size !== data.length) return null;
  return { record, data };
}

/** Lists all metadata records in a store directory (unsorted). */
export function listBlobRecords<T extends { id: string }>(dir: string): T[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const records: T[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!isSafeStorageId(id)) continue;
    const record = readJsonFile<T>(join(dir, name));
    if (!record || record.id !== id) continue;
    records.push(record);
  }
  return records;
}

/** Removes payload + metadata; returns true when either file existed. */
export function removeBlobFiles(dir: string, id: string): boolean {
  if (!isSafeStorageId(id)) return false;
  let removed = false;
  for (const path of [join(dir, id), join(dir, `${id}.json`)]) {
    try {
      unlinkSync(path);
      removed = true;
    } catch {
      /* missing file is fine */
    }
  }
  return removed;
}
