/**
 * IP allowlists (OpenAPI docs, admin API) — CIDR support, no dependencies.
 *
 * Used only with the address already resolved through `resolveClientIp`
 * (`x-forwarded-for` is trusted solely when AGIL_TRUST_PROXY=1), so the
 * allowlist cannot be bypassed with a spoofed header in a direct-exposure setup.
 */
import { isIP } from 'node:net';

interface ParsedRule {
  version: 4 | 6;
  bytes: Uint8Array;
  prefix: number;
}

function parseIpv4(address: string): Uint8Array | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let index = 0; index < 4; index += 1) {
    const value = Number(parts[index]);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    bytes[index] = value;
  }
  return bytes;
}

function parseIpv6(address: string): Uint8Array | null {
  const raw = address.toLowerCase().split('%')[0] ?? '';
  if (!raw.includes(':')) return null;
  const halves = raw.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    const group = groups[index] as string;
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = (value >> 8) & 0xff;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function parseAddress(address: string): { version: 4 | 6; bytes: Uint8Array } | null {
  const version = isIP(address);
  if (version === 4) {
    const bytes = parseIpv4(address);
    return bytes ? { version: 4, bytes } : null;
  }
  if (version === 6) {
    const bytes = parseIpv6(address);
    return bytes ? { version: 6, bytes } : null;
  }
  return null;
}

/** Parses `ip`, `ip/prefix` (CIDR) or `0.0.0.0/0` rules; invalid entries are skipped. */
export function parseAllowlist(rules: readonly string[]): ParsedRule[] {
  const parsed: ParsedRule[] = [];
  for (const rule of rules) {
    const trimmed = rule.trim();
    if (!trimmed) continue;
    const slash = trimmed.indexOf('/');
    const address = slash >= 0 ? trimmed.slice(0, slash) : trimmed;
    const parsedAddress = parseAddress(address);
    if (!parsedAddress) continue;
    const maxPrefix = parsedAddress.version === 4 ? 32 : 128;
    let prefix = maxPrefix;
    if (slash >= 0) {
      const rawPrefix = trimmed.slice(slash + 1);
      if (!/^\d{1,3}$/.test(rawPrefix)) continue;
      prefix = Number(rawPrefix);
      if (prefix < 0 || prefix > maxPrefix) continue;
    }
    parsed.push({ version: parsedAddress.version, bytes: parsedAddress.bytes, prefix });
  }
  return parsed;
}

function matches(rule: ParsedRule, address: { version: 4 | 6; bytes: Uint8Array }): boolean {
  if (rule.version !== address.version) return false;
  const fullBytes = Math.floor(rule.prefix / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (rule.bytes[index] !== address.bytes[index]) return false;
  }
  const remainder = rule.prefix % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return ((rule.bytes[fullBytes] ?? 0) & mask) === ((address.bytes[fullBytes] ?? 0) & mask);
}

/**
 * True when the IP is allowed by an allowlist.
 *
 * An **empty** allowlist means "no restriction" (the default for
 * `AGIL_DOCS_ALLOW_IPS`/`AGIL_ADMIN_ALLOW_IPS`/`AGIL_ENROLL_ALLOW_IPS`).
 *
 * A **non-empty** allowlist that parses to zero valid rules fails closed: a
 * typo (`172.17.0.1/33`, a hostname, a stray `*`) must never silently turn the
 * allowlist into "allow everyone". The handler rejects an empty/all-invalid list
 * before calling this function, so the gate has two fail-closed layers.
 */
export function isIpAllowed(ip: string | undefined, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  const rules = parseAllowlist(allowlist);
  if (rules.length === 0) return false;
  if (!ip) return false;
  const address = parseAddress(ip);
  if (!address) return false;
  return rules.some((rule) => matches(rule, address));
}
