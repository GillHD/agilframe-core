/**
 * GeoIP resolution: country/city/VPN detection for join policy and audit.
 *
 * Providers (mirrors AGIL_GEO_PROVIDER):
 *   - 'header' — trust `x-agil-country` / `cf-ipcountry` / `x-vercel-ip-country`
 *                (only behind a reverse proxy you control);
 *   - 'ipapi'  — HTTPS lookup at https://ipapi.co/{ip}/json/ with AbortController
 *                timeout and an in-memory TTL cache (default 10 min);
 *   - 'none'   — geo disabled.
 *
 * `resolveGeo` NEVER throws: any failure yields `{ source: 'none', vpn: false }`.
 * Use `countryFromHeaders()` together with `resolveGeo(..., { provider: 'header',
 * headerCountry })` to pass the country extracted from HTTP headers.
 */
import { isIP } from 'node:net';
import { SecurityError } from './errors.js';
import { headerValue, normalizeIp, type HeaderMap } from './ip.js';

export type GeoProvider = 'header' | 'ipapi' | 'none';
export type GeoSource = 'header' | 'lookup' | 'none';

export interface GeoResult {
  /** ISO-3166 alpha-2, uppercase, when known. */
  country?: string;
  city?: string;
  vpn: boolean;
  source: GeoSource;
}

export interface GeoOptions {
  /** Provider to use; defaults to 'none' (safe: geo is opt-in). */
  provider?: GeoProvider;
  /** Country code taken from a trusted header (for `provider: 'header'`). */
  headerCountry?: string;
  /** Lookup timeout in milliseconds (default 1200 ms, mirroring the contract). */
  timeoutMs?: number;
  /** Lookup cache TTL in milliseconds (default 10 min; 0 disables the cache). */
  cacheTtlMs?: number;
}

/** Header names checked by `countryFromHeaders`, in priority order. */
export const GEO_COUNTRY_HEADERS = ['x-agil-country', 'cf-ipcountry', 'x-vercel-ip-country'] as const;

const DEFAULT_TIMEOUT_MS = 1200;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 5000;
const IPAPI_ENDPOINT = 'https://ipapi.co';

interface CacheEntry {
  expiresAt: number;
  result: GeoResult;
}

const geoCache = new Map<string, CacheEntry>();

/** Clears the module-level lookup cache (useful for tests and config reloads). */
export function clearGeoCache(): void {
  geoCache.clear();
}

/**
 * Validates and normalises an ISO-3166 alpha-2 country code.
 * Rejects the "unknown" placeholders used by CDNs (`XX`, `T1`, `A1`, ...) and
 * anything that is not exactly two ASCII letters.
 */
export function normalizeCountryCode(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return undefined;
  if (code === 'XX' || code === 'ZZ') return undefined;
  return code;
}

/**
 * Extracts a validated country code from trusted proxy headers.
 *
 * Call this only when `AGIL_TRUST_PROXY=1`; plain clients can forge headers.
 */
export function countryFromHeaders(headers: HeaderMap | undefined): string | undefined {
  if (!headers) return undefined;
  for (const name of GEO_COUNTRY_HEADERS) {
    const code = normalizeCountryCode(headerValue(headers, name));
    if (code) return code;
  }
  return undefined;
}

function noGeo(): GeoResult {
  return { source: 'none', vpn: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

/** Parses an ipapi.co JSON answer; tolerates missing/foreign fields. */
function parseIpapiPayload(raw: unknown): GeoResult {
  if (!isRecord(raw)) return noGeo();
  if (raw.error === true) return noGeo();

  const country = normalizeCountryCode(raw.country_code) ?? normalizeCountryCode(raw.country);
  const rawCity = raw.city;
  const city = typeof rawCity === 'string' ? rawCity.trim().slice(0, 120) : '';
  const security = isRecord(raw.security) ? raw.security : undefined;
  const vpn =
    asBoolean(security?.vpn) ||
    asBoolean(security?.proxy) ||
    asBoolean(security?.tor) ||
    asBoolean(raw.proxy) ||
    asBoolean(raw.vpn);

  if (!country && !city) return noGeo();
  const result: GeoResult = { vpn, source: 'lookup' };
  if (country) result.country = country;
  if (city) result.city = city;
  return result;
}

function readCache(key: string, now: number): GeoResult | undefined {
  const entry = geoCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    geoCache.delete(key);
    return undefined;
  }
  // Refresh LRU position.
  geoCache.delete(key);
  geoCache.set(key, entry);
  return { ...entry.result };
}

function writeCache(key: string, result: GeoResult, ttlMs: number, now: number): void {
  if (ttlMs <= 0) return;
  geoCache.set(key, { expiresAt: now + ttlMs, result: { ...result } });
  while (geoCache.size > CACHE_MAX_ENTRIES) {
    const oldest = geoCache.keys().next();
    if (oldest.done) break;
    geoCache.delete(oldest.value);
  }
}

async function lookupIpapi(ip: string, timeoutMs: number): Promise<GeoResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${IPAPI_ENDPOINT}/${encodeURIComponent(ip)}/json/`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return noGeo();
    const payload: unknown = await response.json();
    return parseIpapiPayload(payload);
  } catch {
    // Network error, timeout, aborted request, invalid JSON — degrade to none.
    return noGeo();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves geo data for an IP address. Never throws.
 *
 * @example
 * const country = countryFromHeaders(req.headers); // only with AGIL_TRUST_PROXY=1
 * const geo = await resolveGeo(ip, { provider: 'header', headerCountry: country });
 */
export async function resolveGeo(ip: string, opts: GeoOptions = {}): Promise<GeoResult> {
  try {
    const provider: GeoProvider = opts.provider ?? 'none';

    if (provider === 'none') return noGeo();

    if (provider === 'header') {
      const country = normalizeCountryCode(opts.headerCountry);
      if (!country) return noGeo();
      return { country, vpn: false, source: 'header' };
    }

    const normalizedIp = normalizeIp(typeof ip === 'string' ? ip : '');
    if (!normalizedIp || isIP(normalizedIp) === 0) return noGeo();

    const timeoutMs =
      Number.isFinite(opts.timeoutMs) && (opts.timeoutMs as number) > 0
        ? Math.min(30_000, Math.floor(opts.timeoutMs as number))
        : DEFAULT_TIMEOUT_MS;
    const cacheTtlMs =
      Number.isFinite(opts.cacheTtlMs) && (opts.cacheTtlMs as number) >= 0
        ? Math.floor(opts.cacheTtlMs as number)
        : DEFAULT_CACHE_TTL_MS;

    const now = Date.now();
    const cacheKey = `ipapi:${normalizedIp}`;
    const cached = readCache(cacheKey, now);
    if (cached) return cached;

    const result = await lookupIpapi(normalizedIp, timeoutMs);
    if (result.source === 'lookup') writeCache(cacheKey, result, cacheTtlMs, now);
    return result;
  } catch {
    // Hard guarantee: policy code must never fail because of geo lookup.
    return noGeo();
  }
}

/** Throws `SecurityError('geo_blocked')` when a country is not allowed by policy. */
export function assertCountryAllowed(
  country: string | undefined,
  policy: { allowedCountries?: readonly string[]; blockedCountries?: readonly string[] },
): void {
  const blocked = (policy.blockedCountries ?? []).map((c) => normalizeCountryCode(c)).filter((c): c is string => Boolean(c));
  const allowed = (policy.allowedCountries ?? []).map((c) => normalizeCountryCode(c)).filter((c): c is string => Boolean(c));

  if (country) {
    if (blocked.includes(country)) {
      throw new SecurityError('geo_blocked', `Country ${country} is blocked`);
    }
    if (allowed.length > 0 && !allowed.includes(country)) {
      throw new SecurityError('geo_blocked', `Country ${country} is not allowed`);
    }
    return;
  }

  // Unknown country: only deny when an explicit allow-list is configured.
  if (allowed.length > 0) {
    throw new SecurityError('geo_blocked', 'Country could not be determined');
  }
}
