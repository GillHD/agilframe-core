/**
 * Signed playback for LiveKit Egress artifacts (HLS/MP4).
 *
 * Egress writes MP4/HLS to a private S3-compatible bucket (or `/out` in a local
 * lab); the app never exposes the bucket. It mints a short-lived HMAC token
 * bound to `tenant + room + egressId + object key + scope + expiry` and serves
 * the object through a same-origin endpoint, rewriting every HLS segment URI in
 * a playlist to its own signed URL.
 *
 * No secret ever appears in a URL, log or error (only the HMAC signature) and
 * the token is opaque (`base64url(payload).base64url(HMAC)`), so callers cannot
 * forge a tenant/room/key by editing query parameters; `verifyToken` is
 * constant-time and treats malformed input as invalid. Both storage backends
 * answer Range requests identically (`206`/`416`/`200` per RFC 9110) and a
 * `HEAD` is header-only. Local reads are contained to the artifact root and
 * S3/network error text is sanitized.
 *
 * Token payload (internal, versioned):
 *   { v:1, t:<tenant>, r:<room>, e:<egressId>, k:<object key>, s:<scope>, x:<ms> }
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { sanitizeEgressErrorText } from './error-text.js';

export type PlaybackScope = 'playlist' | 'segment' | 'file';
export type EgressArtifactKind = 'recording' | 'hls';
export type EgressPlaybackBackend = 'auto' | 'local' | 's3';

const TOKEN_VERSION = 1;
const MAX_TOKEN_LENGTH = 4096;
const MAX_KEY_LENGTH = 1024;
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024;

export interface EgressS3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  sessionToken?: string;
  forcePathStyle: boolean;
}

export interface EgressPlaybackConfig {
  /** HMAC secret (AGIL_EGRESS_PLAYBACK_SECRET; defaults to AGIL_TOKEN_SECRET). */
  secret: string;
  /** Default link TTL in seconds. */
  defaultTtlSec: number;
  /** Hard cap for a requested TTL in seconds. */
  maxTtlSec: number;
  backend?: EgressPlaybackBackend;
  /** S3 read credentials; when absent, `localDir` may be used for a lab. */
  s3?: EgressS3Config;
  /** Local artifact root (the worker's `/out`), for offline/lab deployments. */
  localDir?: string;
}

export interface PlaybackClaims {
  v: number;
  t: string;
  r: string;
  e: string;
  k: string;
  s: PlaybackScope;
  x: number;
  /** Binds new links to their configured store across configuration changes. */
  b?: string;
}

export interface PlaybackLink {
  /** Relative, same-origin path including the signed token. */
  path: string;
  /** Absolute URL using the caller's public origin. */
  url: string;
  expiresAt: number;
}

export interface PlaybackObject {
  status: number;
  headers: Record<string, string>;
  body: Readable;
  /** Content length when known (S3 `content-length`, local file size). */
  size?: number;
}

/**
 * Header-only response for `HEAD` playback requests.
 *
 * Status/headers mirror the corresponding `GET`, but no body is ever opened:
 * the S3 backend issues a metadata `HEAD`, the local backend a `stat`. A
 * playlist HEAD reports the stored object size, which may differ from the
 * rewritten playlist length a GET would send (`egress-production-s3.md` §3.2).
 */
export interface PlaybackHead {
  status: number;
  headers: Record<string, string>;
  /** Object size when known. */
  size?: number;
}

export class EgressPlaybackError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'EgressPlaybackError';
    this.code = code;
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* Token signing / verification                                        */
/* ------------------------------------------------------------------ */

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function encodeClaims(claims: PlaybackClaims): string {
  return Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
}

export function signPlaybackToken(secret: string, claims: PlaybackClaims): string {
  const payload = encodeClaims(claims);
  return `${payload}.${sign(secret, payload)}`;
}

function isScope(value: unknown): value is PlaybackScope {
  return value === 'playlist' || value === 'segment' || value === 'file';
}

function parseClaims(value: unknown): PlaybackClaims | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== TOKEN_VERSION) return null;
  if (typeof raw.t !== 'string' || !raw.t || raw.t.length > 64) return null;
  if (typeof raw.r !== 'string' || !raw.r || raw.r.length > 64) return null;
  if (typeof raw.e !== 'string' || !raw.e || raw.e.length > 128) return null;
  if (typeof raw.k !== 'string' || !raw.k || raw.k.length > MAX_KEY_LENGTH) return null;
  if (!isScope(raw.s)) return null;
  if (typeof raw.x !== 'number' || !Number.isFinite(raw.x) || raw.x <= 0) return null;
  if (raw.b !== undefined && (typeof raw.b !== 'string' || !/^[a-f0-9]{64}$/.test(raw.b))) return null;
  return { v: TOKEN_VERSION, t: raw.t, r: raw.r, e: raw.e, k: raw.k, s: raw.s, x: raw.x, ...(raw.b ? { b: raw.b } : {}) };
}

/**
 * Verifies a token's signature and shape. Expiry is checked separately by the
 * service so callers can distinguish "invalid" (403) from "expired" (403 with
 * a different code) without timing leaks; both are failures to the client.
 */
export function verifyPlaybackToken(secret: string, token: string | undefined | null): PlaybackClaims | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  if (!safeEqual(sign(secret, payload), signature)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    return parseClaims(decoded);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Object keys                                                         */
/* ------------------------------------------------------------------ */

/**
 * Normalises an artifact location (`s3://bucket/key`, an HTTPS URL, or a raw
 * key) into a bucket-relative key. Returns null for an external URL we cannot
 * prove belongs to this bucket; the caller must not sign it.
 */
export function objectKeyFromLocation(location: unknown, bucket = ''): string | null {
  if (typeof location !== 'string') return null;
  const raw = location.trim();
  if (!raw) return null;
  if (/^s3:\/\//i.test(raw)) {
    const withoutScheme = raw.replace(/^s3:\/\//i, '');
    const slash = withoutScheme.indexOf('/');
    if (slash <= 0) return null;
    const foundBucket = withoutScheme.slice(0, slash);
    if (bucket && foundBucket !== bucket) return null;
    return normalizeObjectKey(withoutScheme.slice(slash + 1));
  }
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const segments = url.pathname.split('/').filter(Boolean);
      if (bucket && url.hostname === bucket) segments.shift();
      else if (bucket && url.hostname.startsWith(`${bucket}.`)) {
        /* virtual-hosted bucket: the path is already the key */
      } else if (bucket && segments[0] === bucket) segments.shift();
      else return null;
      return normalizeObjectKey(segments.join('/'));
    } catch {
      return null;
    }
  }
  return normalizeObjectKey(raw);
}

export function normalizeObjectKey(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let key = raw.trim().replace(/^\/+/, '');
  if (!key || key.length > MAX_KEY_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(key)) return null;
  // `\` is not a separator in an S3 key but *is* one on Windows: a key like
  // `..\..\x` would pass `path.posix.normalize` and then escape a local root.
  // Reject it outright (egress never generates such keys).
  if (key.includes('\\')) return null;
  key = path.posix.normalize(key);
  if (key === '.' || key === '..' || key.startsWith('../') || key.includes('/../')) return null;
  if (!key || key.length > MAX_KEY_LENGTH) return null;
  return key;
}

/**
 * Resolves a normalized object key inside the local artifact root.
 *
 * Returns null for anything that is not provably contained: a traversal, an
 * absolute/drive-qualified path, or a backslash-separated key (see
 * `normalizeObjectKey`). Shared by `exists()` and `localGet()` so the boolean
 * existence probe cannot see files the reader refuses to serve.
 */
function resolveLocalObjectPath(root: string, key: string): string | null {
  if (key.includes('\\') || key.includes('\u0000')) return null;
  const full = path.resolve(root, key);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

/**
 * True when the resolved file (and the root) are still inside the root after
 * symlink resolution. Defense in depth for the local fallback: a symlink under
 * `/out` must not expose a file outside it.
 */
async function realPathWithinRoot(root: string, full: string): Promise<boolean> {
  try {
    const [realRoot, realFull] = await Promise.all([realpath(root), realpath(full)]);
    return realFull === realRoot || realFull.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = value[0];
  return first && typeof first === 'object' && !Array.isArray(first) ? (first as Record<string, unknown>) : null;
}

function stringField(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') return '';
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' ? found.trim() : '';
}

/**
 * Derives the playlist/MP4 key from a LiveKit `EgressInfo` (proto-JSON).
 *
 * Result locations are authoritative. While a job is still running egress may
 * not have published them yet, so the request's output prefix is a conservative
 * fallback (`<filename_prefix>/<playlist_name>`); a caller should surface
 * `409 egress_not_ready` when both are missing.
 */
export function artifactKeyFromEgressInfo(info: unknown, kind: EgressArtifactKind, bucket = ''): string | null {
  if (!info || typeof info !== 'object') return null;
  const item = info as Record<string, unknown>;
  const status = stringField(item, 'status').toUpperCase();
  const active = status.includes('ACTIVE') || status.includes('STARTING') || status.includes('ENDING');

  if (kind === 'hls') {
    const result = firstRecord(item.segment_results);
    if (result) {
      const preferred = active
        ? [stringField(result, 'live_playlist_location'), stringField(result, 'playlist_location')]
        : [stringField(result, 'playlist_location'), stringField(result, 'live_playlist_location')];
      for (const location of preferred) {
        const key = objectKeyFromLocation(location, bucket);
        if (key) return key;
      }
    }
    const request = item.request && typeof item.request === 'object' ? (item.request as Record<string, unknown>) : {};
    const output = firstRecord(request.segment_outputs);
    if (output) {
      const prefix = normalizeObjectKey(stringField(output, 'filename_prefix'));
      const playlist = stringField(output, 'live_playlist_name') || stringField(output, 'playlist_name');
      if (prefix && playlist) {
        const key = normalizeObjectKey(`${prefix}/${playlist}`);
        if (key) return key;
      }
    }
    return null;
  }

  const result = firstRecord(item.file_results);
  if (!result) return null;
  for (const field of ['location', 'filename']) {
    const key = objectKeyFromLocation(stringField(result, field), bucket);
    if (key) return key;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

function contentTypeFor(key: string, storageType: string | null = null): string {
  const ext = path.posix.extname(key).toLowerCase();
  // Object storage may guess a different type for HLS assets, such as TypeScript for .ts.
  switch (ext) {
    case '.m3u8':
      return 'application/vnd.apple.mpegurl';
    case '.ts':
      return 'video/mp2t';
    case '.m4s':
      return 'video/iso.segment';
    case '.mp4':
      return 'video/mp4';
    case '.m4a':
      return 'audio/mp4';
    case '.aac':
      return 'audio/aac';
    default:
      return storageType ?? 'application/octet-stream';
  }
}

function contentRange(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`;
}

/**
 * Header-only `416` body shared by the local and S3 backends.
 *
 * The upstream S3 XML error body is never forwarded (it may contain bucket
 * details); the response is the same short text the local backend uses so both
 * backends answer identically. `size` may be unknown when a metadata probe
 * failed, in which case `content-range` is omitted.
 */
function unsatisfiableObject(size: number | null): PlaybackObject {
  const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8', 'accept-ranges': 'bytes' };
  if (size !== null) headers['content-range'] = `bytes */${size}`;
  return {
    status: 416,
    headers,
    body: Readable.from([Buffer.from('Range not satisfiable\n')]),
    ...(size !== null ? { size } : {}),
  };
}

/** How a `Range` request header is treated by both storage backends. */
export type RangePolicy = 'none' | 'ignore' | 'invalid' | 'single';

/** Result of a metadata-only S3 `HEAD` (never opens an object body). */
type S3HeadResult =
  | { kind: 'ok'; size: number | null; contentType: string | null }
  | { kind: 'missing' }
  | { kind: 'error'; status: number | null };

/**
 * Classifies a `Range` header before it is forwarded to S3 or applied locally.
 *
 * Only a single satisfiable-shaped range is honoured. A multi-range value is
 * *ignored* (the whole object is served with `200`): RFC 9110 permits that, and
 * neither backend can emit a multipart `206`. A syntactically invalid value is
 * `416`. This runs before the S3 GET, so an invalid or multi-range request never
 * reaches the bucket.
 */
export function classifyRange(header: string | undefined): RangePolicy {
  if (typeof header !== 'string' || header.trim() === '') return 'none';
  const match = /^bytes=([^=]*)$/i.exec(header.trim());
  if (!match) return 'invalid';
  const spec = (match[1] ?? '').trim();
  if (!spec) return 'invalid';
  if (spec.includes(',')) return 'ignore';
  const single = /^(\d*)-(\d*)$/.exec(spec);
  if (!single) return 'invalid';
  const startRaw = single[1] ?? '';
  const endRaw = single[2] ?? '';
  if (!startRaw && !endRaw) return 'invalid';
  if (!startRaw) {
    const suffix = Number(endRaw);
    return Number.isFinite(suffix) && suffix > 0 ? 'single' : 'invalid';
  }
  const start = Number(startRaw);
  if (!Number.isFinite(start) || start < 0) return 'invalid';
  if (endRaw) {
    const end = Number(endRaw);
    if (!Number.isFinite(end) || end < start) return 'invalid';
  }
  return 'single';
}

function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'ignore' | 'invalid' | null {
  const policy = classifyRange(header);
  if (policy === 'none') return null;
  if (policy === 'ignore') return 'ignore';
  if (policy === 'invalid' || size <= 0) return 'invalid';
  const match = /^bytes=(\d*)-(\d*)$/i.exec((header as string).trim());
  if (!match) return 'invalid';
  const startRaw = match[1] ?? '';
  const endRaw = match[2] ?? '';
  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startRaw);
  if (!Number.isFinite(start) || start < 0 || start >= size) return 'invalid';
  const end = endRaw ? Number(endRaw) : size - 1;
  if (!Number.isFinite(end) || end < start) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

export class EgressPlaybackService {
  private readonly config: EgressPlaybackConfig;
  readonly storageIdentity: string | null;

  constructor(config: EgressPlaybackConfig) {
    const s3Candidate = config.backend !== 'local' && config.s3?.endpoint && config.s3.bucket && config.s3.accessKey && config.s3.secretKey
      ? config.s3 : undefined;
    let endpoint: URL | undefined;
    if (s3Candidate) {
      try {
        const parsed = new URL(s3Candidate.endpoint);
        if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) endpoint = parsed;
      } catch {
        // Leave playback unconfigured for an invalid explicit endpoint.
      }
    }
    const s3 = endpoint ? s3Candidate : undefined;
    const localDir = !s3Candidate && config.backend !== 's3' ? config.localDir : undefined;
    const { s3: _s3, localDir: _localDir, ...settings } = config;
    this.config = { ...settings, ...(s3 ? { s3 } : {}), ...(localDir ? { localDir } : {}) };
    const storage = s3 && endpoint ? ['s3', endpoint.origin + endpoint.pathname.replace(/\/+$/, ''), s3.bucket, s3.forcePathStyle]
      : localDir ? ['local', path.resolve(localDir)] : null;
    this.storageIdentity = storage ? createHash('sha256').update(JSON.stringify(storage)).digest('hex') : null;
  }

  get configured(): boolean {
    return this.storageIdentity !== null;
  }

  get localOnly(): boolean {
    return !this.config.s3 && Boolean(this.config.localDir);
  }

  private get secret(): string {
    return this.config.secret;
  }

  ttlFor(requested: number | undefined): number {
    const fallback = this.config.defaultTtlSec > 0 ? this.config.defaultTtlSec : 900;
    const max = this.config.maxTtlSec > 0 ? this.config.maxTtlSec : 86400;
    const value = typeof requested === 'number' && Number.isFinite(requested) ? Math.floor(requested) : fallback;
    return Math.min(max, Math.max(60, value));
  }

  private claims(input: {
    tenantId: string;
    roomId: string;
    egressId: string;
    key: string;
    scope: PlaybackScope;
    exp: number;
  }): PlaybackClaims {
    return {
      v: TOKEN_VERSION,
      t: input.tenantId,
      r: input.roomId,
      e: input.egressId,
      k: input.key,
      s: input.scope,
      x: input.exp,
      ...(this.storageIdentity ? { b: this.storageIdentity } : {}),
    };
  }

  /** Returns the same-origin path for a scope; segment paths are nested. */
  pathFor(claims: PlaybackClaims): string {
    const room = encodeURIComponent(claims.r);
    const egress = encodeURIComponent(claims.e);
    const route = claims.s === 'playlist' ? 'playlist' : claims.s === 'segment' ? 'segment' : 'file';
    return `/v1/rooms/${room}/egress/${egress}/${route}?token=${encodeURIComponent(signPlaybackToken(this.secret, claims))}`;
  }

  createLink(input: {
    tenantId: string;
    roomId: string;
    egressId: string;
    key: string;
    /** Playlist for HLS (default), `file` for MP4. */
    scope?: 'playlist' | 'file';
    ttlSec?: number;
    origin: string;
  }): PlaybackLink {
    const key = normalizeObjectKey(input.key);
    if (!key) throw new EgressPlaybackError('invalid_key', 400, 'Invalid egress artifact key');
    const exp = Date.now() + this.ttlFor(input.ttlSec) * 1000;
    const claims = this.claims({
      tenantId: input.tenantId,
      roomId: input.roomId,
      egressId: input.egressId,
      key,
      scope: input.scope ?? 'playlist',
      exp,
    });
    const relative = this.pathFor(claims);
    return { path: relative, url: `${input.origin.replace(/\/+$/, '')}${relative}`, expiresAt: exp };
  }

  /**
   * Verifies a token and enforces the room/egress/tenant binding.
   *
   * `tenantId` is optional so a GET can keep working after the live room object
   * is gone (Core restart / room deleted): the signed token already binds the
   * tenant, and the URL binds the room/egress. When the room *is* known, its
   * tenant must match too. A token for another tenant maps to 404 (the room
   * lookup fails first), so every tenant/room mismatch is a 404.
   */
  verify(input: {
    token: string | undefined;
    tenantId?: string;
    roomId: string;
    egressId: string;
    scope: PlaybackScope;
  }): PlaybackClaims {
    const claims = verifyPlaybackToken(this.secret, input.token);
    if (!claims) throw new EgressPlaybackError('playback_forbidden', 403, 'Playback link is invalid');
    if (claims.x <= Date.now()) throw new EgressPlaybackError('playback_expired', 403, 'Playback link has expired');
    // Another tenant's (or room's) token looks like a missing resource, not a
    // permission error: do not confirm that a foreign room exists.
    if (claims.r !== input.roomId) {
      throw new EgressPlaybackError('not_found', 404, 'Playback link not found');
    }
    if (input.tenantId !== undefined && claims.t !== input.tenantId) {
      throw new EgressPlaybackError('not_found', 404, 'Playback link not found');
    }
    if (claims.e !== input.egressId || claims.s !== input.scope) {
      throw new EgressPlaybackError('playback_forbidden', 403, 'Playback link is invalid');
    }
    if (claims.b && claims.b !== this.storageIdentity) {
      throw new EgressPlaybackError('not_found', 404, 'Playback link not found');
    }
    return claims;
  }

  /** True when the artifact object exists (local stat or S3 HEAD). */
  async exists(key: string): Promise<boolean> {
    const normalized = normalizeObjectKey(key);
    if (!normalized) return false;
    if (this.config.s3) {
      const head = await this.s3Head(this.config.s3, normalized);
      if (head.kind === 'missing') return false;
      if (head.kind === 'error') throw this.storageError(head.status);
      return true;
    }
    if (this.config.localDir) {
      const root = path.resolve(this.config.localDir);
      const full = resolveLocalObjectPath(root, normalized);
      if (!full) return false;
      try {
        const info = await stat(full);
        if (!info.isFile()) return false;
        return await realPathWithinRoot(root, full);
      } catch {
        return false;
      }
    }
    return false;
  }

  /** Archive readiness also requires a non-empty object. */
  async objectSize(key: string): Promise<number | null> {
    const normalized = normalizeObjectKey(key);
    return normalized ? (await this.objectMeta(normalized))?.size ?? null : null;
  }

  /** Removes one server-generated archive object, never a directory or a symlink. */
  async removeArchiveObject(key: string, expectedSize: number): Promise<void> {
    const normalized = normalizeObjectKey(key);
    if (!normalized) throw new EgressPlaybackError('invalid_key', 400, 'Invalid egress artifact key');
    const current = await this.objectSize(normalized);
    if (current !== null && current !== expectedSize) throw new EgressPlaybackError('egress_archive_object_changed', 409, 'Recording object changed');
    const s3 = this.config.s3;
    if (s3) {
      let response: Response;
      try {
        const url = s3ObjectUrl(s3, normalized);
        response = await fetch(url, {
          method: 'DELETE',
          headers: signS3Get(s3, url, 'UNSIGNED-PAYLOAD', undefined, 'DELETE'),
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        });
      } catch {
        throw this.storageError(null);
      }
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw this.storageError(response.status);
      if (await this.objectSize(normalized) !== null) throw this.storageError(null, 'Egress storage did not confirm deletion');
      return;
    }
    if (current === null) return;
    const root = path.resolve(this.config.localDir as string);
    const target = resolveLocalObjectPath(root, normalized);
    if (!target || !(await realPathWithinRoot(root, target))) {
      throw new EgressPlaybackError('invalid_key', 400, 'Invalid egress artifact key');
    }
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.size !== expectedSize) {
        throw new EgressPlaybackError('egress_archive_object_changed', 409, 'Recording object changed');
      }
      await unlink(target);
    } catch (error) {
      if (error instanceof EgressPlaybackError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw this.storageError(null);
    }
  }

  /**
   * Rewrites a master/media playlist so every object URI is signed.
   *
   * Covers segments, fMP4 `#EXT-X-MAP`, and the URI-bearing tags a master
   * playlist or encrypted stream can use: `#EXT-X-KEY`, `#EXT-X-SESSION-KEY`,
   * `#EXT-X-MEDIA`, `#EXT-X-I-FRAME-STREAM-INF`, `#EXT-X-RENDITION-REPORT` and
   * `#EXT-X-PRELOAD-HINT`. A URI pointing at another `.m3u8` is signed with
   * `scope: 'playlist'`, so the variant playlist is served through the playlist
   * handler and its body is rewritten recursively; everything else is a
   * `segment` object. Absolute URLs belong to a CDN/host this app cannot read,
   * so they are left alone.
   */
  rewritePlaylist(text: string, claims: PlaybackClaims): string {
    if (text.length > MAX_PLAYLIST_BYTES) throw new EgressPlaybackError('playlist_too_large', 502, 'Playlist is too large');
    const baseDir = path.posix.dirname(claims.k);
    // Signs one relative playlist URI with the playlist's own expiry.
    const signedUri = (uri: string): string | null => {
      const clean = uri.split(/[?#]/, 1)[0] ?? '';
      if (!clean) return null;
      const key = normalizeObjectKey(path.posix.join(baseDir, clean));
      if (!key) return null;
      const scope: PlaybackScope = /\.m3u8?$/i.test(key) ? 'playlist' : 'segment';
      return this.pathFor(
        this.claims({
          tenantId: claims.t,
          roomId: claims.r,
          egressId: claims.e,
          key,
          scope,
          exp: claims.x,
        }),
      );
    };
    const rewriteTagUris = (line: string): string =>
      line.replace(/URI="([^"]*)"/gi, (whole, uri: string) => {
        if (!uri || /^https?:\/\//i.test(uri)) return whole;
        const signed = signedUri(uri);
        return signed ? `URI="${signed}"` : whole;
      });
    const lines = text.split(/\r?\n/);
    const rewritten = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        // `#EXT-X-MAP:URI="init.mp4"` (fMP4) and the other URI-bearing
        // `#EXT-X-…` tags are real object URIs inside a tag. Left relative, the
        // player resolves them against the playlist URL path (`…/playlist`).
        if (/^#EXT-X-[A-Z0-9-]+:/i.test(trimmed) && /URI="/i.test(line)) return rewriteTagUris(line);
        return line;
      }
      if (/^https?:\/\//i.test(trimmed)) return line;
      return signedUri(trimmed) ?? line;
    });
    return rewritten.join('\n');
  }

  /** Reads a playlist object and returns rewritten UTF-8 text. */
  async playlistText(claims: PlaybackClaims): Promise<string> {
    const object = await this.fetchObject(claims.k);
    if (!object) throw new EgressPlaybackError('not_found', 404, 'Playlist not found');
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of object.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > MAX_PLAYLIST_BYTES) {
        object.body.destroy();
        throw new EgressPlaybackError('playlist_too_large', 502, 'Playlist is too large');
      }
      chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.includes('#EXTM3U')) throw new EgressPlaybackError('invalid_playlist', 502, 'Egress returned an invalid playlist');
    return this.rewritePlaylist(text, claims);
  }

  /** Streams one MP4/segment; supports a single HTTP Range. */
  async objectStream(claims: PlaybackClaims, rangeHeader?: string): Promise<PlaybackObject> {
    const object = await this.fetchObject(claims.k, rangeHeader);
    if (!object) throw new EgressPlaybackError('not_found', 404, 'Egress artifact not found');
    return object;
  }

  /**
   * Header-only metadata for a playlist `HEAD`.
   *
   * Never fetches or rewrites the playlist body: an S3 `HEAD` (or local `stat`)
   * supplies the size. The reported `content-length` is the *stored* object
   * size, which can differ from the rewritten length a `GET` would send
   * (`egress-production-s3.md` §3.2).
   */
  async playlistHead(claims: PlaybackClaims): Promise<PlaybackHead> {
    const key = normalizeObjectKey(claims.k);
    if (!key) throw new EgressPlaybackError('invalid_key', 400, 'Invalid egress artifact key');
    const meta = await this.objectMeta(key);
    if (!meta) throw new EgressPlaybackError('not_found', 404, 'Playlist not found');
    return {
      status: 200,
      headers: {
        'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'content-length': String(meta.size),
      },
      size: meta.size,
    };
  }

  /**
   * Header-only metadata for a segment/file `HEAD`, with the same `Range`
   * classification as `objectStream` (`200`/`206`/`416`) but without opening
   * the object body. The S3 backend issues one metadata `HEAD` per request and
   * never a `GET`.
   */
  async objectHead(claims: PlaybackClaims, rangeHeader?: string): Promise<PlaybackHead> {
    const key = normalizeObjectKey(claims.k);
    if (!key) throw new EgressPlaybackError('invalid_key', 400, 'Invalid egress artifact key');
    const meta = await this.objectMeta(key);
    if (!meta) throw new EgressPlaybackError('not_found', 404, 'Egress artifact not found');
    const range = parseRange(rangeHeader, meta.size);
    if (range === 'invalid') {
      return {
        status: 416,
        headers: { 'content-range': `bytes */${meta.size}`, 'content-type': 'text/plain; charset=utf-8', 'accept-ranges': 'bytes' },
        size: meta.size,
      };
    }
    const headers: Record<string, string> = { 'content-type': meta.contentType };
    if (range && range !== 'ignore') {
      headers['content-range'] = contentRange(range.start, range.end, meta.size);
      headers['accept-ranges'] = 'bytes';
      headers['content-length'] = String(range.end - range.start + 1);
      return { status: 206, headers, size: meta.size };
    }
    // no Range (`none`) and multi-range (`ignore`) both describe the whole object
    headers['content-length'] = String(meta.size);
    headers['accept-ranges'] = 'bytes';
    return { status: 200, headers, size: meta.size };
  }

  /**
   * Metadata-only lookup shared by `playlistHead`/`objectHead`.
   *
   * Returns null when the object is missing; throws 400 for an uncontained
   * local key, 502 for an S3 failure, 501 when playback is not configured.
   */
  private async objectMeta(key: string): Promise<{ size: number; contentType: string } | null> {
    if (this.config.s3) {
      const head = await this.s3Head(this.config.s3, key);
      if (head.kind === 'missing') return null;
      if (head.kind === 'error') throw this.storageError(head.status);
      if (head.size === null) throw this.storageError(null, 'Egress storage did not report the object size');
      return { size: head.size, contentType: contentTypeFor(key, head.contentType) };
    }
    if (this.config.localDir) {
      const root = path.resolve(this.config.localDir);
      const full = resolveLocalObjectPath(root, key);
      if (!full) throw new EgressPlaybackError('invalid_key', 400, 'Invalid egress artifact key');
      try {
        const info = await stat(full);
        if (!info.isFile()) return null;
        if (!(await realPathWithinRoot(root, full))) {
          throw new EgressPlaybackError('invalid_key', 400, 'Invalid egress artifact key');
        }
        return { size: info.size, contentType: contentTypeFor(key) };
      } catch (error) {
        if (error instanceof EgressPlaybackError) throw error;
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
        throw this.storageError(null);
      }
    }
    throw new EgressPlaybackError(
      'egress_playback_not_configured',
      501,
      'Egress playback is not configured: set AGIL_EGRESS_S3_* or AGIL_EGRESS_PLAYBACK_DIR',
    );
  }

  /** Consistent 502 for an S3 metadata/GET failure (no upstream text leaks). */
  private storageError(status: number | null, message = 'Egress storage request failed'): EgressPlaybackError {
    return new EgressPlaybackError(
      'egress_storage_failed',
      502,
      status === null ? message : `Egress storage returned HTTP ${status}`,
    );
  }

  private async fetchObject(key: string, rangeHeader?: string): Promise<PlaybackObject | null> {
    const normalized = normalizeObjectKey(key);
    if (!normalized) throw new EgressPlaybackError('invalid_key', 400, 'Invalid egress artifact key');
    if (this.config.s3) return this.s3Get(normalized, rangeHeader);
    if (this.config.localDir) return this.localGet(normalized, rangeHeader);
    throw new EgressPlaybackError(
      'egress_playback_not_configured',
      501,
      'Egress playback is not configured: set AGIL_EGRESS_S3_* or AGIL_EGRESS_PLAYBACK_DIR',
    );
  }

  private async localGet(key: string, rangeHeader?: string): Promise<PlaybackObject | null> {
    const root = path.resolve(this.config.localDir as string);
    const full = resolveLocalObjectPath(root, key);
    if (!full) throw new EgressPlaybackError('invalid_key', 400, 'Invalid egress artifact key');
    let size: number;
    try {
      const info = await stat(full);
      if (!info.isFile()) return null;
      size = info.size;
    } catch {
      return null;
    }
    // Stat already proves containment lexically; this also rejects a symlink
    // inside the artifact root that points outside it.
    if (!(await realPathWithinRoot(root, full))) {
      throw new EgressPlaybackError('invalid_key', 400, 'Invalid egress artifact key');
    }
    const headers: Record<string, string> = { 'content-type': contentTypeFor(key) };
    const range = parseRange(rangeHeader, size);
    if (range === 'invalid') return unsatisfiableObject(size);
    if (range && range !== 'ignore') {
      headers['content-range'] = contentRange(range.start, range.end, size);
      headers['accept-ranges'] = 'bytes';
      headers['content-length'] = String(range.end - range.start + 1);
      return {
        status: 206,
        headers,
        body: createReadStream(full, { start: range.start, end: range.end }),
        size,
      };
    }
    // `ignore` (multi-range) serves the whole object, exactly like the S3 path.
    headers['content-length'] = String(size);
    headers['accept-ranges'] = 'bytes';
    return { status: 200, headers, body: createReadStream(full), size };
  }

  /**
   * Metadata-only S3 `HEAD`: size/content-type, `missing` on 404, `error`
   * otherwise. Never reads an object body.
   */
  private async s3Head(s3: EgressS3Config, key: string): Promise<S3HeadResult> {
    const url = s3ObjectUrl(s3, key);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'HEAD',
        headers: signS3Get(s3, url, 'UNSIGNED-PAYLOAD', undefined, 'HEAD'),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
    } catch {
      return { kind: 'error', status: null };
    }
    if (response.status === 404) return { kind: 'missing' };
    if (!response.ok) return { kind: 'error', status: response.status };
    const lengthHeader = response.headers.get('content-length');
    const length = lengthHeader === null || lengthHeader.trim() === '' ? null : Number(lengthHeader);
    return {
      kind: 'ok',
      size: length !== null && Number.isFinite(length) && length >= 0 ? length : null,
      contentType: response.headers.get('content-type'),
    };
  }

  /**
   * Builds a `416 Range Not Satisfiable` response for the S3 backend.
   *
   * The upstream 416 normally carries `content-range: bytes *\/<size>`; when it
   * does not, a metadata HEAD fills it in. A HEAD that proves the object is
   * missing returns null so the caller answers `404`, matching the local
   * backend. The upstream error body is discarded (S3 may return XML with
   * bucket details) and replaced with the same short text the local backend
   * uses.
   */
  private async s3Unsatisfiable(
    s3: EgressS3Config,
    key: string,
    upstreamContentRange: string | null,
  ): Promise<PlaybackObject | null> {
    const parsed = /^bytes \*\/(\d+)$/.exec((upstreamContentRange ?? '').trim());
    if (parsed) return unsatisfiableObject(Number(parsed[1]));
    const head = await this.s3Head(s3, key);
    if (head.kind === 'missing') return null;
    return unsatisfiableObject(head.kind === 'ok' ? head.size : null);
  }

  private async s3Get(key: string, rangeHeader?: string): Promise<PlaybackObject | null> {
    const s3 = this.config.s3 as EgressS3Config;
    const url = s3ObjectUrl(s3, key);
    const policy = classifyRange(rangeHeader);
    // A syntactically invalid range cannot be satisfied. A metadata HEAD checks
    // that the object exists first: a missing object answers 404 (same as the
    // local backend), an existing one answers 416 without asking for
    // the body. A multi-range value is ignored (200, whole object) and is never
    // signed into the upstream request — same policy as the local path.
    if (policy === 'invalid') return this.s3Unsatisfiable(s3, key, null);
    const forwardRange = policy === 'single' ? (rangeHeader as string).trim() : undefined;
    const headers = signS3Get(s3, url, 'UNSIGNED-PAYLOAD', forwardRange);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(20_000),
        redirect: 'error',
      });
    } catch (error) {
      throw new EgressPlaybackError(
        'egress_storage_failed',
        502,
        `Egress storage request failed: ${sanitizeEgressErrorText((error as Error).message)}`,
      );
    }
    if (response.status === 404) {
      if (response.body) await response.body.cancel().catch(() => undefined);
      return null;
    }
    if (response.status === 416) {
      const upstreamRange = response.headers.get('content-range');
      if (response.body) await response.body.cancel().catch(() => undefined);
      return this.s3Unsatisfiable(s3, key, upstreamRange);
    }
    if (!response.ok) {
      if (response.body) await response.body.cancel().catch(() => undefined);
      throw new EgressPlaybackError('egress_storage_failed', 502, `Egress storage returned HTTP ${response.status}`);
    }
    const out: Record<string, string> = { 'content-type': contentTypeFor(key, response.headers.get('content-type')) };
    for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const value = response.headers.get(name);
      if (value) out[name] = value;
    }
    const size = Number(out['content-length']);
    const body = response.body ? Readable.fromWeb(response.body as never) : Readable.from([]);
    return { status: response.status, headers: out, body, ...(Number.isFinite(size) ? { size } : {}) };
  }
}

/* ------------------------------------------------------------------ */
/* S3 SigV4 GET (no SDK)                                               */
/* ------------------------------------------------------------------ */

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function encodeKey(key: string): string {
  return key.split('/').map((part) => encodeURIComponent(part)).join('/');
}

/** Builds a path-style or virtual-hosted object URL from an S3 endpoint. */
export function s3ObjectUrl(s3: Pick<EgressS3Config, 'endpoint' | 'bucket' | 'forcePathStyle'>, key: string): string {
  const endpoint = new URL(s3.endpoint);
  if (!/^https?:$/.test(endpoint.protocol)) throw new EgressPlaybackError('invalid_config', 500, 'S3 endpoint must be http(s)');
  const prefix = endpoint.pathname.replace(/\/+$/, '');
  if (s3.forcePathStyle) {
    endpoint.pathname = `${prefix}/${encodeURIComponent(s3.bucket)}/${encodeKey(key)}`;
  } else {
    endpoint.hostname = `${s3.bucket}.${endpoint.hostname}`;
    endpoint.pathname = `${prefix}/${encodeKey(key)}`;
  }
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint.toString();
}

function pathAndQuery(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

/** Returns headers for a SigV4 GET (header auth; no query presign). */
export function signS3Get(
  s3: Pick<EgressS3Config, 'region' | 'accessKey' | 'secretKey' | 'sessionToken'>,
  objectUrl: string,
  payloadHash = 'UNSIGNED-PAYLOAD',
  rangeHeader?: string,
  method = 'GET',
): Record<string, string> {
  const parsed = new URL(objectUrl);
  const host = parsed.host;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (rangeHeader) headers.range = rangeHeader;
  if (s3.sessionToken) headers['x-amz-security-token'] = s3.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    method,
    parsed.pathname,
    parsed.search.replace(/^\?/, ''),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${date}/${s3.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${s3.secretKey}`, date), s3.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${s3.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  // Remove the placeholder host used for canonicalisation; real fetch adds it.
  delete headers.host;
  headers.authorization = authorization;
  return headers;
}
