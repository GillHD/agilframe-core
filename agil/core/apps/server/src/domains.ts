/**
 * Custom-domain registry: `Host` header -> tenant, with DNS verification.
 *
 * Persisted as one JSON file under `<AGIL_DATA_DIR>/domains.json` (atomic
 * tmp+rename) and served from an in-memory `Map`, so host resolution never
 * touches the disk.
 *
 * Security model:
 * - a domain resolves to a tenant only after DNS proof; pending domains fall
 *   back to the default tenant;
 * - **ownership requires the TXT token** (`_agil-calls.<domain>` =
 *   `agil-verify=<token>`) on the first verification: a CNAME pointing at
 *   {@link publicHost} is public information, so CNAME-only never proves
 *   ownership, and is accepted on its own only as a **re-check** of a domain
 *   that is already verified;
 * - one domain belongs to exactly one tenant (409 on conflict);
 * - one tenant has at most one custom domain (assigning a new one retires the
 *   previous record, including its host mapping).
 *
 * TLS/ACME is out of scope: the Node server speaks plain HTTP behind a reverse
 * proxy (Caddy/HAProxy). This module only answers "may this host be served as
 * tenant X?" and exposes the DNS instructions.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveCname, resolveTxt } from 'node:dns/promises';

export type DomainStatus = 'pending' | 'verified';
export type DomainMethod = 'txt' | 'cname';

/** DNS lookups used by verification (injectable so tests never touch the network). */
export interface DomainDnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
}

export interface DomainRecord {
  domain: string;
  tenantId: string;
  status: DomainStatus;
  /** Random verification secret; published as `agil-verify=<token>` in DNS. */
  token: string;
  method: DomainMethod;
  createdAt: number;
  verifiedAt?: number;
  lastCheckedAt?: number;
  /** Last verification failure (human-readable, no secrets beyond the public token). */
  lastError?: string;
}

export interface DomainVerification {
  record: DomainRecord;
  /** DNS name queried for the TXT challenge. */
  txtName: string;
  /** TXT values observed (empty when NXDOMAIN/timeout). */
  txtValues: string[];
  /** CNAME target observed (null when absent). */
  cnameTarget: string | null;
  /** Configured CNAME target the record must point to. */
  expectedCname: string;
  verified: boolean;
}

export interface DomainRegistryOptions {
  /** Path of `domains.json`. */
  file: string;
  /** CNAME target advertised to tenants and accepted during verification. */
  publicHost: string;
  /** DNS resolver (defaults to `node:dns/promises`). */
  resolver?: DomainDnsResolver;
  /** Per-lookup timeout in milliseconds. */
  timeoutMs?: number;
  now?: () => number;
}

export type DomainParseResult = { ok: true; domain: string } | { ok: false; reason: string };

const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const TXT_PREFIX = '_agil-calls.';
const TXT_VALUE_PREFIX = 'agil-verify=';

/** Raised when a domain is already assigned to another tenant. */
export class DomainConflictError extends Error {
  readonly domain: string;
  readonly tenantId: string;
  constructor(domain: string, tenantId: string) {
    super(`Domain ${domain} is already assigned to another tenant`);
    this.name = 'DomainConflictError';
    this.domain = domain;
    this.tenantId = tenantId;
  }
}

/**
 * Normalises and validates a custom domain: bare host name, lowercase, no
 * scheme/path/port/IP/wildcards/localhost. Empty input means "no domain".
 */
export function parseDomain(raw: string): DomainParseResult {
  const value = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!value) return { ok: true, domain: '' };
  if (/[^\x00-\x7f]/.test(value)) {
    return { ok: false, reason: 'Internationalized domains must be entered in punycode (xn--…)' };
  }
  if (
    value.includes('://') ||
    value.includes('/') ||
    value.includes(':') ||
    value.includes('?') ||
    value.includes('#') ||
    /\s/.test(value)
  ) {
    return { ok: false, reason: 'Domain must be a bare host name (no scheme, path or port)' };
  }
  if (value.length > 253) return { ok: false, reason: 'Domain is too long (max 253)' };
  if (value.includes('*') || value === 'localhost') {
    return { ok: false, reason: 'Wildcards and localhost are not allowed' };
  }
  const labels = value.split('.');
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL_RE.test(label))) {
    return { ok: false, reason: 'Invalid domain format' };
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) {
    return { ok: false, reason: 'IP addresses are not allowed; use a host name' };
  }
  if ((labels[labels.length - 1] as string).length < 2) {
    return { ok: false, reason: 'Invalid top-level domain' };
  }
  return { ok: true, domain: value };
}

/**
 * Extracts a bare, lowercase host name from a `Host`/`x-forwarded-host` value:
 * strips the port, brackets around IPv6 and a trailing root dot. Returns `''`
 * for missing or syntactically invalid values (callers then use the default
 * tenant instead of failing the request).
 *
 * `options.list` accepts the comma-separated form some proxies emit for
 * `X-Forwarded-Host` (`edge.example.com, inner.local`) and keeps the first
 * hop. The plain `Host` header is parsed strictly: a comma there is malformed.
 */
export function hostFromHeader(
  header: string | string[] | undefined,
  options: { list?: boolean } = {},
): string {
  const raw = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
  let value = raw.trim().toLowerCase();
  if (!value) return '';
  if (options.list) {
    const comma = value.indexOf(',');
    if (comma >= 0) value = value.slice(0, comma).trim();
    if (!value) return '';
  }
  if (value.startsWith('[')) {
    // IPv6 literal: [::1]:8787 -> ::1 (never a valid custom domain, but valid as
    // an HTTP URL base; host resolution will simply miss).
    const end = value.indexOf(']');
    if (end < 2) return '';
    const inner = value.slice(1, end);
    return /^[0-9a-f:.]+$/.test(inner) ? inner : '';
  }
  // Strip the port before the trailing root dot so `host.example.com.:443`
  // (FQDN written by some clients) still normalises to `host.example.com`.
  const portMatch = /:(\d{1,5})$/.exec(value);
  if (portMatch) value = value.slice(0, -portMatch[0].length);
  value = value.replace(/\.$/, '');
  if (!value || value.length > 253) return '';
  if (!HOST_RE.test(value) || value.includes('..') || value.startsWith('.')) return '';
  return value;
}

/**
 * Normalises the configured CNAME target (`AGIL_DOMAIN_TARGET`): accepts a bare
 * host, a full origin, an FQDN with a trailing dot and an accidental `:port`,
 * and falls back to `calls.example.com` for values that are not a host name.
 */
export function normalizePublicHost(raw: string): string {
  const parsed = parseDomain(hostFromHeader(hostFromOrigin(raw, raw)));
  return parsed.ok && parsed.domain ? parsed.domain : 'calls.example.com';
}

/** `https://calls.example.com/x` -> `calls.example.com`; safe fallback. */
export function hostFromOrigin(origin: string, fallback = 'calls.example.com'): string {
  try {
    return new URL(origin).hostname.toLowerCase() || fallback;
  } catch {
    return fallback;
  }
}

function systemResolver(): DomainDnsResolver {
  return {
    resolveTxt: (name) => resolveTxt(name),
    resolveCname: (name) => resolveCname(name),
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('dns_timeout')), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function tokenFor(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 32);
}

interface PersistedFile {
  version: 1;
  domains: Record<string, DomainRecord>;
}

/**
 * Host -> tenant registry plus DNS verification. Reads are synchronous and
 * allocation-free after the first lookup; writes are atomic and best-effort
 * (a read-only data dir keeps the in-memory mapping alive).
 */
export class DomainRegistry {
  readonly file: string;
  readonly publicHost: string;
  private resolver: DomainDnsResolver;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly byDomain = new Map<string, DomainRecord>();
  private readonly byTenant = new Map<string, string>();

  constructor(options: DomainRegistryOptions) {
    this.file = options.file;
    this.publicHost = normalizePublicHost(options.publicHost);
    this.resolver = options.resolver ?? systemResolver();
    this.timeoutMs = Math.min(30_000, Math.max(250, options.timeoutMs ?? 5000));
    this.now = options.now ?? Date.now;
    this.load();
  }

  /** Test helper: replace the DNS resolver after construction. */
  setResolver(resolver: DomainDnsResolver): void {
    this.resolver = resolver;
  }

  /** Verified record for a host, or null (pending domains never resolve). */
  resolveHost(host: string): DomainRecord | null {
    const normalized = hostFromHeader(host);
    if (!normalized) return null;
    const record = this.byDomain.get(normalized);
    return record && record.status === 'verified' ? record : null;
  }

  /** The (single) domain assigned to a tenant, pending or verified. */
  getForTenant(tenantId: string): DomainRecord | null {
    const domain = this.byTenant.get(tenantId);
    return domain ? (this.byDomain.get(domain) ?? null) : null;
  }

  list(): DomainRecord[] {
    return [...this.byDomain.values()].map((record) => ({ ...record }));
  }

  /** Throws {@link DomainConflictError} when another tenant already owns `domain`. */
  assertAvailable(tenantId: string, domain: string): void {
    const existing = this.byDomain.get(domain);
    if (existing && existing.tenantId !== tenantId) throw new DomainConflictError(domain, existing.tenantId);
  }

  /**
   * Assigns (or keeps) a pending domain for a tenant and persists it. The token
   * is stable while the domain is unchanged, so repeated PUTs do not invalidate
   * DNS records the customer already published.
   */
  assign(tenantId: string, domain: string): DomainRecord {
    const previous = this.getForTenant(tenantId);
    if (previous && previous.domain === domain) return previous;
    this.assertAvailable(tenantId, domain);
    if (previous) this.byDomain.delete(previous.domain);
    const record: DomainRecord = {
      domain,
      tenantId,
      status: 'pending',
      token: tokenFor(`${tenantId}:${domain}:${randomBytes(16).toString('hex')}`),
      method: 'txt',
      createdAt: this.now(),
    };
    this.byDomain.set(domain, record);
    this.byTenant.set(tenantId, domain);
    this.persist();
    return record;
  }

  /** Ensures a pending record exists for a tenant (idempotent, no status reset). */
  ensureForTenant(tenantId: string, domain: string): DomainRecord {
    const parsed = parseDomain(domain);
    if (!parsed.ok || !parsed.domain) {
      const existing = this.getForTenant(tenantId);
      if (existing) return existing;
      throw new Error(`invalid domain: ${domain}`);
    }
    const existing = this.getForTenant(tenantId);
    if (existing && existing.domain === parsed.domain) return existing;
    return this.assign(tenantId, parsed.domain);
  }

  /**
   * Keeps the registry in sync with `branding.customDomain` written through the
   * regular tenant-config API. Same domain -> no-op (verification is preserved);
   * changed/removed domain -> new pending record or removal.
   */
  syncTenant(tenantId: string, customDomain: string): void {
    const parsed = parseDomain(customDomain);
    if (!parsed.ok || !parsed.domain) {
      this.remove(tenantId);
      return;
    }
    const existing = this.getForTenant(tenantId);
    if (existing && existing.domain === parsed.domain) return;
    try {
      this.assign(tenantId, parsed.domain);
    } catch (error) {
      if (error instanceof DomainConflictError) return;
      throw error;
    }
  }

  /** Removes a tenant's domain (no-op when absent). Returns true when removed. */
  remove(tenantId: string): boolean {
    const domain = this.byTenant.get(tenantId);
    if (!domain) return false;
    this.byTenant.delete(tenantId);
    this.byDomain.delete(domain);
    this.persist();
    return true;
  }

  /**
   * Runs DNS verification for the tenant's current domain.
   *
   * Ownership policy:
   * - **first** verification: the TXT record `_agil-calls.<domain>` must contain
   *   the per-domain token (`agil-verify=<token>` or the bare token); a CNAME to
   *   {@link publicHost} alone never verifies, because CNAME is public
   *   information and proves routing, not ownership;
   * - **re-check** of an already verified domain: TXT (or the plain token) still
   *   verifies it, and a CNAME alone also keeps it verified;
   * - a failed re-check revokes the host mapping (status back to `pending`,
   *   fail-closed); a first-time CNAME-only attempt stays `pending` with a
   *   `lastError` that names the mandatory TXT record.
   */
  async verify(tenantId: string): Promise<DomainVerification> {
    const record = this.getForTenant(tenantId);
    if (!record) throw new Error('no_domain');
    const txtName = `${TXT_PREFIX}${record.domain}`;
    const expectedTxt = `${TXT_VALUE_PREFIX}${record.token}`;
    let txtValues: string[] = [];
    try {
      const rows = await withTimeout(this.resolver.resolveTxt(txtName), this.timeoutMs);
      txtValues = rows.map((chunks) => chunks.join('')).map((value) => value.trim()).filter(Boolean);
    } catch {
      /* NXDOMAIN/timeout -> fall through to CNAME */
    }
    const expectedCname = this.publicHost;
    let cnameTarget: string | null = null;
    try {
      const targets = await withTimeout(this.resolver.resolveCname(record.domain), this.timeoutMs);
      cnameTarget = (targets[0] ?? '').trim().toLowerCase().replace(/\.$/, '') || null;
    } catch {
      /* no CNAME record */
    }

    const txtMatch = txtValues.some((value) => value === expectedTxt || value === record.token);
    const cnameMatch = Boolean(cnameTarget && cnameTarget === expectedCname);
    // CNAME-only is a re-check affordance, never an ownership proof: it is
    // accepted only for a domain this registry has already verified (TXT was
    // present at that point); `status` alone proves a previous success.
    const previouslyVerified = record.status === 'verified';
    const verified = txtMatch || (cnameMatch && previouslyVerified);
    const checkedAt = this.now();
    // `method` records how ownership was proven; a CNAME-only re-check keeps the
    // original proof (`txt` for a domain first verified by its token).
    const method: DomainMethod = verified ? (txtMatch ? 'txt' : record.method) : record.method;
    const failure =
      previouslyVerified
        ? `DNS verification failed: TXT ${txtName} must contain "${expectedTxt}" or CNAME ${record.domain} must point to ${expectedCname}`
        : `DNS verification failed: TXT ${txtName} must contain "${expectedTxt}" (mandatory for the first verification); CNAME ${record.domain} -> ${expectedCname} only routes traffic`;
    const updated: DomainRecord = {
      ...record,
      status: verified ? 'verified' : 'pending',
      method,
      lastCheckedAt: checkedAt,
      ...(verified ? { verifiedAt: checkedAt } : {}),
      ...(verified ? {} : { lastError: failure }),
    };
    if (!verified) delete updated.verifiedAt;
    else delete updated.lastError;
    this.byDomain.set(record.domain, updated);
    this.persist();
    return {
      record: { ...updated },
      txtName,
      txtValues,
      cnameTarget,
      expectedCname,
      verified,
    };
  }

  /** Verification instructions for the admin API/dashboard. */
  instructions(record: DomainRecord): {
    token: string;
    method: DomainMethod;
    txt: { name: string; value: string; ttl: number };
    cname: { name: string; value: string; ttl: number };
    verifiedAt?: number;
    lastCheckedAt?: number;
    lastError?: string;
  } {
    return {
      token: record.token,
      method: record.method,
      txt: { name: `${TXT_PREFIX}${record.domain}`, value: `${TXT_VALUE_PREFIX}${record.token}`, ttl: 300 },
      cname: { name: record.domain, value: this.publicHost, ttl: 300 },
      ...(record.verifiedAt !== undefined ? { verifiedAt: record.verifiedAt } : {}),
      ...(record.lastCheckedAt !== undefined ? { lastCheckedAt: record.lastCheckedAt } : {}),
      ...(record.lastError !== undefined ? { lastError: record.lastError } : {}),
    };
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PersistedFile>;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.domains !== 'object' || !parsed.domains) return;
      for (const [domain, raw] of Object.entries(parsed.domains)) {
        const record = normalizeRecord(raw, domain);
        if (!record) continue;
        const previous = this.byTenant.get(record.tenantId);
        if (previous && previous !== record.domain) this.byDomain.delete(previous);
        this.byDomain.set(record.domain, record);
        this.byTenant.set(record.tenantId, record.domain);
      }
    } catch {
      /* corrupt or unreadable registry: start empty, keep serving the default tenant */
    }
  }

  private persist(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const data: PersistedFile = { version: 1, domains: Object.fromEntries(this.byDomain) };
      const tmp = `${this.file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      try {
        renameSync(tmp, this.file);
      } catch {
        // Windows can refuse to replace an open file; retry after removing it.
        rmSync(this.file, { force: true });
        renameSync(tmp, this.file);
      }
    } catch {
      /* persistence is best-effort; the in-memory mapping keeps working */
    }
  }
}

function normalizeRecord(raw: unknown, fallbackDomain: string): DomainRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<DomainRecord>;
  const parsed = parseDomain(typeof candidate.domain === 'string' ? candidate.domain : fallbackDomain);
  if (!parsed.ok || !parsed.domain) return null;
  const tenantId = typeof candidate.tenantId === 'string' ? candidate.tenantId.trim() : '';
  if (!tenantId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(tenantId)) return null;
  const status: DomainStatus = candidate.status === 'verified' ? 'verified' : 'pending';
  const token = typeof candidate.token === 'string' && /^[a-f0-9]{16,64}$/.test(candidate.token) ? candidate.token : tokenFor(`${tenantId}:${parsed.domain}`);
  const method: DomainMethod = candidate.method === 'cname' ? 'cname' : 'txt';
  const createdAt = typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt) ? candidate.createdAt : 0;
  return {
    domain: parsed.domain,
    tenantId,
    status,
    token,
    method,
    createdAt,
    ...(typeof candidate.verifiedAt === 'number' ? { verifiedAt: candidate.verifiedAt } : {}),
    ...(typeof candidate.lastCheckedAt === 'number' ? { lastCheckedAt: candidate.lastCheckedAt } : {}),
    ...(typeof candidate.lastError === 'string' ? { lastError: candidate.lastError.slice(0, 500) } : {}),
  };
}
