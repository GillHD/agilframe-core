/**
 * Client IP resolution and pseudonymisation.
 *
 * The raw IP is never written to the audit log: callers store
 * `hashIp(ip, AGIL_IP_SALT)` (32 hex chars / 128 bits of SHA-256) instead.
 */
import { createHash } from 'node:crypto';

/** Shape of Node's `IncomingHttpHeaders` (compatible with `req.headers`). */
export type HeaderMap = Record<string, string | string[] | undefined>;

/** Replaces the IPv4-mapped IPv6 prefix and strips ports/brackets. */
export function normalizeIp(raw: string): string {
  if (typeof raw !== 'string') return '';
  let ip = raw.trim();
  if (!ip) return '';

  // [::1]:443 / [::1]
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(ip);
  if (bracketed?.[1]) ip = bracketed[1];

  // 203.0.113.7:5678 (IPv4 with port; bare IPv6 keeps its colons)
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(ip);
  if (v4WithPort?.[1]) ip = v4WithPort[1];

  // ::ffff:203.0.113.7 → 203.0.113.7
  if (ip.toLowerCase().startsWith('::ffff:')) {
    const mapped = ip.slice('::ffff:'.length);
    if (mapped && !mapped.includes(':')) ip = mapped;
  }

  // Drop a zone index (fe80::1%eth0) — it is not part of the address.
  const zone = ip.indexOf('%');
  if (zone > 0) ip = ip.slice(0, zone);

  return ip;
}

/**
 * Pseudonymises an IP address: `sha256(salt + "|" + ip)`, hex, truncated to
 * 32 characters (128 bits). Empty input still yields a stable hash of the salt.
 */
export function hashIp(ip: string, salt: string): string {
  const normalized = normalizeIp(typeof ip === 'string' ? ip : '');
  return createHash('sha256')
    .update(typeof salt === 'string' ? salt : '', 'utf8')
    .update('|', 'utf8')
    .update(normalized, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/** Case-insensitive header lookup; returns the first non-empty value. */
export function headerValue(headers: HeaderMap | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = headers[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim().length > 0) return item.trim();
      }
      return undefined;
    }
  }
  return undefined;
}

export interface ClientIpInput {
  headers?: HeaderMap;
  remoteAddress?: string;
  /**
   * When true, `x-forwarded-for` (the first hop, i.e. the original client) is
   * trusted. Must only be enabled behind a reverse proxy you control
   * (`AGIL_TRUST_PROXY=1`).
   */
  trustProxy?: boolean;
}

/**
 * Resolves the effective client IP.
 *
 * - `trustProxy: true` → first address of `x-forwarded-for`, else `remoteAddress`;
 * - otherwise → `remoteAddress` (headers are ignored);
 * - IPv4-mapped IPv6 addresses (`::ffff:127.0.0.1`) are normalised to IPv4.
 */
export function resolveClientIp(input: ClientIpInput = {}): string {
  const remote = normalizeIp(input.remoteAddress ?? '');
  if (!input.trustProxy) return remote;

  const forwarded = headerValue(input.headers, 'x-forwarded-for');
  if (!forwarded) return remote;

  const first = forwarded.split(',')[0]?.trim() ?? '';
  const candidate = normalizeIp(first);
  if (!candidate || candidate.toLowerCase() === 'unknown') return remote;
  return candidate;
}
