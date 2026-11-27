/**
 * Validation of outbound URLs (SSRF protection for company endpoints).
 *
 * Used for tenant-configured endpoints that the server calls: AI agent,
 * knowledge agent, webhooks and the external media-integrity detector
 * (`AGIL_INTEGRITY_URL`). The server must validate them **before** each call and
 * fail closed when the check returns `ok: false`.
 *
 * Rules:
 *   - only `https:` by default (`allowHttp` opts in for local dev only);
 *   - no `user:password@` in the URL (credentials must go into headers/secrets);
 *   - URL length <= 500 characters;
 *   - private / loopback / link-local / ULA IPv4+IPv6 addresses are rejected
 *     unless `allowPrivate: true` (never in production);
 *   - hostnames are not resolved here (sync helper): a DNS name that resolves to
 *     a private IP must additionally be blocked by the egress firewall/DNS policy.
 */
import { isIP } from 'node:net';

/** Maximum accepted URL length, characters. */
export const MAX_OUTBOUND_URL_LENGTH = 500;

export interface OutboundUrlOptions {
  /** Allow plain `http:` URLs (local development only; default false). */
  allowHttp?: boolean;
  /** Allow private/loopback addresses (local development only; default false). */
  allowPrivate?: boolean;
}

export type OutboundUrlResult = { ok: true; url: URL } | { ok: false; error: string };

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function ipv6Bytes(ip: string): number[] | undefined {
  if (ip.includes('.')) return undefined; // embedded IPv4 is normalised by URL parsing
  const halves = ip.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return undefined;
  const groups = halves.length === 2 ? [...left, ...Array<string>(missing).fill('0'), ...right] : left;
  if (groups.length !== 8) return undefined;
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
    const value = Number.parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 (this host)
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const bytes = ipv6Bytes(ip);
  if (!bytes) return false;
  const first = bytes[0] as number;
  const second = bytes[1] as number;
  // :: (unspecified) and ::1 (loopback)
  if (bytes.every((byte) => byte === 0)) return true;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true;
  // IPv4-mapped: ::ffff:127.0.0.1 / ::ffff:7f00:1
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10 link-local
  return false;
}

function isPrivateHost(hostname: string): boolean {
  const host = stripBrackets(hostname.trim().toLowerCase()).replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // IPv4-mapped IPv6 (URL gives ::ffff:127.0.0.1 as-is for some inputs).
  if (host.startsWith('::ffff:')) {
    const mapped = host.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return isPrivateIpv4(mapped);
  }

  const version = isIP(host);
  if (version === 4) return isPrivateIpv4(host);
  if (version === 6) return isPrivateIpv6(host);
  // DNS name: cannot be resolved synchronously. The caller must rely on the
  // egress firewall / DNS pinning in addition to this check.
  return false;
}

/**
 * Validates an outbound URL for tenant-configured endpoints (SSRF guard).
 * Never throws. Use it for AI/knowledge/webhook URLs and on startup for
 * `AGIL_INTEGRITY_URL`.
 *
 * @example
 * const check = validateOutboundUrl(process.env.AGIL_INTEGRITY_URL ?? '');
 * if (!check.ok) throw new Error(`AGIL_INTEGRITY_URL: ${check.error}`);
 */
export function validateOutboundUrl(raw: string, opts: OutboundUrlOptions = {}): OutboundUrlResult {
  try {
    if (typeof raw !== 'string') return { ok: false, error: 'invalid_url' };
    const value = raw.trim();
    if (value.length === 0) return { ok: false, error: 'invalid_url' };
    if (value.length > MAX_OUTBOUND_URL_LENGTH) return { ok: false, error: 'url_too_long' };

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { ok: false, error: 'invalid_url' };
    }

    const protocol = url.protocol.toLowerCase();
    if (protocol === 'http:') {
      if (opts.allowHttp !== true) return { ok: false, error: 'http_not_allowed' };
    } else if (protocol !== 'https:') {
      return { ok: false, error: 'unsupported_protocol' };
    }

    if (url.username.length > 0 || url.password.length > 0) {
      return { ok: false, error: 'credentials_not_allowed' };
    }

    if (opts.allowPrivate !== true && isPrivateHost(url.hostname)) {
      return { ok: false, error: 'private_address_not_allowed' };
    }

    return { ok: true, url };
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
}
