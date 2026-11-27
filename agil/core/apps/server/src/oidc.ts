/**
 * OIDC identity verification for SSO (verified joins + dashboard login).
 *
 * The tenant IdP (`integrations.identity`, mode `oidc`) supplies a JWKS URL,
 * issuer and audience; RS256/ES256 JWTs are verified locally with
 * `node:crypto` and mapped to a verified identity. The same verifier serves
 * verified joins (`POST /v1/auth/oidc/verify`, `POST /v1/rooms/:id/join`) and
 * the dashboard authorization-code flow (`oidc-flow.ts`), which also checks the
 * `nonce` and accepts the OAuth client id as an audience. Hardening rules are
 * documented in docs/sso-oidc.md.
 *
 * The token, claims object and email are never logged or audited.
 */
import { createHash, createPublicKey, verify as cryptoVerify, timingSafeEqual, constants, type KeyObject } from 'node:crypto';
import { featureKeys, type FeatureKey, type IdentityRole, type Role, type TenantConfig } from '@agil/protocol';
import type { Env } from './env.js';
import { isSecureMode, validateExternalUrl } from './url-policy.js';
import { OidcError } from './oidc-error.js';
import { isOidcDiscoveryEnabled, resolveOidcEndpoints } from './oidc-discovery.js';

export { OidcError } from './oidc-error.js';

/** Default JWKS cache lifetime; a conforming `Cache-Control: max-age` overrides it. */
const JWKS_CACHE_TTL_MS = 10 * 60_000;
const JWKS_MIN_TTL_MS = 60_000;
const JWKS_MAX_TTL_MS = 60 * 60_000;
const JWKS_TIMEOUT_MS = 3000;
/** At most one forced refresh (unknown `kid`) per URL in this window. */
const JWKS_MIN_FORCED_REFRESH_MS = 30_000;
/** Negative cache: do not hammer an unavailable IdP more than once per window. */
const JWKS_FAILURE_BACKOFF_MS = 30_000;
const JWKS_MAX_ENTRIES = 64;
const JWKS_MAX_KEYS = 32;
const JWKS_MAX_BYTES = 512 * 1024;
const CLOCK_SKEW_SEC = 60;
const MAX_CLOCK_SKEW_SEC = 300;
const FEATURE_SET = new Set<string>(featureKeys);

export interface OidcIdentity {
  userId: string;
  name: string;
  role: Role;
  permissions?: FeatureKey[];
  verified: boolean;
  issuer: string;
}

export interface VerifyOidcOptions {
  /** Expected `nonce` claim (authorization-code flow). */
  nonce?: string;
  /** Additional accepted `aud` values (the OAuth client id for the code flow). */
  audiences?: string[];
}

export interface VerifiedOidcToken {
  identity: OidcIdentity;
  /** Raw, signature-verified claim set (never logged). */
  claims: Record<string, unknown>;
  /** Group values from `groupsClaim` — used for dashboard admin-group gating. */
  groups: string[];
  /** Lower-case email after validation (never logged; not part of the identity). */
  email?: string;
}

interface Jwk {
  kty?: unknown;
  kid?: unknown;
  alg?: unknown;
  use?: unknown;
  key_ops?: unknown;
  n?: unknown;
  e?: unknown;
  crv?: unknown;
  x?: unknown;
  y?: unknown;
}

interface JwksCacheEntry {
  keys: Jwk[];
  fetchedAt: number;
  expiresAt: number;
  fetchCount: number;
  etag?: string;
  lastError?: string;
}

const jwksCache = new Map<string, JwksCacheEntry>();
const jwksInflight = new Map<string, Promise<Jwk[]>>();
const jwksLastForcedAt = new Map<string, number>();
const jwksLastFailureAt = new Map<string, number>();

/** Diagnostic snapshot of the JWKS cache (tests/ops; contains no tokens). */
export interface OidcJwksDiagnostic {
  url: string;
  keys: number;
  fetchedAt: number;
  expiresAt: number;
  fetchCount: number;
  lastError?: string;
}

export function oidcJwksDiagnostics(): OidcJwksDiagnostic[] {
  return [...jwksCache.entries()].map(([url, entry]) => ({
    url,
    keys: entry.keys.length,
    fetchedAt: entry.fetchedAt,
    expiresAt: entry.expiresAt,
    fetchCount: entry.fetchCount,
    ...(entry.lastError ? { lastError: entry.lastError } : {}),
  }));
}

/** Clears every JWKS cache/cooldown (tests/diagnostics). */
export function clearOidcJwksCache(): void {
  jwksCache.clear();
  jwksInflight.clear();
  jwksLastForcedAt.clear();
  jwksLastFailureAt.clear();
}

function b64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeJson<T>(segment: string, what: string): T {
  try {
    const parsed: unknown = JSON.parse(b64url(segment).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as T;
  } catch {
    throw new OidcError(401, 'invalid_identity_token', `Некорректный identity-токен (${what})`);
  }
}

/* --------------------------------- JWKS -------------------------------- */

function isSigningJwk(value: unknown): value is Jwk {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const jwk = value as Jwk;
  if (jwk.kty !== 'RSA' && jwk.kty !== 'EC') return false;
  // `use`/`key_ops` are optional in JWKS, but when present they must allow verify.
  if (typeof jwk.use === 'string' && jwk.use !== 'sig') return false;
  if (jwk.use !== undefined && typeof jwk.use !== 'string') return false;
  if (jwk.key_ops !== undefined) {
    if (!Array.isArray(jwk.key_ops) || !jwk.key_ops.some((op) => op === 'verify')) return false;
  }
  if (jwk.alg !== undefined && typeof jwk.alg !== 'string') return false;
  if (jwk.kid !== undefined && typeof jwk.kid !== 'string') return false;
  return true;
}

function jwksTtlMs(response: Response): number {
  const cacheControl = response.headers.get('cache-control') ?? '';
  // `no-store`/`no-cache` from the IdP must win over the default TTL: a key
  // revoked at the IdP should not stay trusted for 10 minutes on this node.
  if (/(?:^|,)\s*no-(?:store|cache)(?:\s*=|,|$)/i.test(cacheControl)) return 0;
  const match = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cacheControl);
  if (!match?.[1]) return JWKS_CACHE_TTL_MS;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return JWKS_CACHE_TTL_MS;
  return Math.min(Math.max(seconds * 1000, JWKS_MIN_TTL_MS), JWKS_MAX_TTL_MS);
}

function pruneJwksCache(url: string): void {
  if (jwksCache.size <= JWKS_MAX_ENTRIES) return;
  const oldest = [...jwksCache.entries()]
    .filter(([key]) => key !== url)
    .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0];
  if (oldest) jwksCache.delete(oldest[0]);
}

function parseJwksBody(text: string): Jwk[] {
  let body: { keys?: unknown };
  try {
    body = JSON.parse(text) as { keys?: unknown };
  } catch {
    throw new OidcError(503, 'identity_not_configured', 'JWKS вернул некорректный JSON');
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.keys)) {
    throw new OidcError(503, 'identity_not_configured', 'JWKS без ключей');
  }
  const keys = body.keys.filter(isSigningJwk).slice(0, JWKS_MAX_KEYS);
  if (keys.length === 0) {
    throw new OidcError(503, 'identity_not_configured', 'JWKS без пригодных ключей подписи');
  }
  return keys;
}

async function fetchJwksOnce(url: string, cached: JwksCacheEntry | undefined): Promise<Jwk[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JWKS_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (cached?.etag) headers['if-none-match'] = cached.etag;
    const response = await fetch(url, { signal: controller.signal, headers, redirect: 'error' });
    if (response.status === 304 && cached) {
      cached.fetchedAt = Date.now();
      cached.expiresAt = cached.fetchedAt + jwksTtlMs(response);
      jwksLastFailureAt.delete(url);
      return cached.keys;
    }
    if (!response.ok) {
      throw new OidcError(503, 'identity_not_configured', `JWKS недоступен (HTTP ${response.status})`);
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > JWKS_MAX_BYTES) {
      throw new OidcError(503, 'identity_not_configured', 'JWKS слишком большой');
    }
    const text = await response.text();
    if (text.length > JWKS_MAX_BYTES) {
      throw new OidcError(503, 'identity_not_configured', 'JWKS слишком большой');
    }
    const keys = parseJwksBody(text);
    const now = Date.now();
    const etag = response.headers.get('etag') ?? undefined;
    const entry: JwksCacheEntry = {
      keys,
      fetchedAt: now,
      expiresAt: now + jwksTtlMs(response),
      fetchCount: (cached?.fetchCount ?? 0) + 1,
      ...(etag ? { etag } : {}),
    };
    jwksCache.set(url, entry);
    pruneJwksCache(url);
    jwksLastFailureAt.delete(url);
    return keys;
  } catch (error) {
    const message =
      error instanceof OidcError
        ? error.message
        : (error as Error).name === 'AbortError'
          ? 'JWKS timeout'
          : 'JWKS недоступен';
    jwksLastFailureAt.set(url, Date.now());
    if (cached) cached.lastError = message;
    if (error instanceof OidcError) throw error;
    throw new OidcError(503, 'identity_not_configured', message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns signing keys for the tenant. `force` is used once on an unknown `kid`
 * (key rotation) and is rate-limited so a token with a random `kid` cannot turn
 * every request into an IdP fetch.
 */
async function fetchJwks(config: TenantConfig, env: Env, force = false): Promise<Jwk[]> {
  const identity = config.integrations.identity;
  let rawUrl = identity.jwksUrl.trim();
  if (!rawUrl && isOidcDiscoveryEnabled(identity)) {
    // Discovery is opt-in: resolve `jwks_uri` from the IdP metadata, pinned to
    // the configured issuer. An explicit jwksUrl always wins (no extra fetch).
    const resolved = await resolveOidcEndpoints(env, identity);
    rawUrl = resolved.jwksUrl?.trim() ?? '';
    if (!rawUrl) {
      throw new OidcError(
        501,
        'identity_not_configured',
        `OIDC не настроен: нет jwksUrl и discovery не дал jwks_uri${resolved.discoveryError ? ` (${resolved.discoveryError})` : ''}`,
      );
    }
  }
  if (!rawUrl) throw new OidcError(501, 'identity_not_configured', 'OIDC не настроен: укажите jwksUrl');
  const policy = validateExternalUrl(rawUrl, { secure: isSecureMode(env) });
  if (!policy.ok) {
    throw new OidcError(501, 'identity_not_configured', 'jwksUrl отклонён политикой URL: ' + policy.reason);
  }
  const url = policy.url.toString();
  const now = Date.now();
  const cached = jwksCache.get(url);
  const lastForced = jwksLastForcedAt.get(url) ?? 0;

  // Serve a fresh cache entry. A forced (rotation) refresh is coalesced: at most
  // one per URL per window, so a random `kid` cannot amplify IdP traffic.
  if (cached && now < cached.expiresAt) {
    if (!force || now - lastForced < JWKS_MIN_FORCED_REFRESH_MS) return cached.keys;
  } else if (force && now - lastForced < JWKS_MIN_FORCED_REFRESH_MS) {
    // Never serve an expired key set just because a rotation refetch is cooling
    // down; fail closed instead.
    throw new OidcError(503, 'identity_not_configured', 'JWKS обновляется слишком часто');
  }

  const expired = !cached || now >= cached.expiresAt;
  if (expired) {
    const failedAt = jwksLastFailureAt.get(url);
    if (failedAt !== undefined && now - failedAt < JWKS_FAILURE_BACKOFF_MS) {
      throw new OidcError(503, 'identity_not_configured', 'JWKS временно недоступен');
    }
  }
  if (force) jwksLastForcedAt.set(url, now);

  const inflight = jwksInflight.get(url);
  if (inflight) return inflight;
  const promise = fetchJwksOnce(url, cached);
  jwksInflight.set(url, promise);
  try {
    return await promise;
  } catch (error) {
    // A failed rotation refresh may still use a *fresh* cache entry; an expired
    // key set is never served (fail closed).
    if (force && cached && cached.keys.length > 0 && Date.now() < cached.expiresAt) return cached.keys;
    throw error;
  } finally {
    if (jwksInflight.get(url) === promise) jwksInflight.delete(url);
  }
}

/* ------------------------------- signature ------------------------------ */

function publicKeyFor(jwk: Jwk): KeyObject | null {
  try {
    const key = createPublicKey({ key: jwk as unknown as import('node:crypto').JsonWebKey, format: 'jwk' });
    if (key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return null;
    return key;
  } catch {
    return null;
  }
}

function verifySignature(header: { alg?: unknown }, signingInput: Buffer, signature: Buffer, jwk: Jwk): boolean {
  const alg = typeof header.alg === 'string' ? header.alg : '';
  if (alg === 'RS256' && jwk.kty !== 'RSA') return false;
  if (alg === 'ES256' && (jwk.kty !== 'EC' || jwk.crv !== 'P-256')) return false;
  // A JWK `alg`, when present, must match the header (no algorithm substitution).
  if (typeof jwk.alg === 'string' && jwk.alg !== alg) return false;
  const key = publicKeyFor(jwk);
  if (!key) return false;
  try {
    if (alg === 'RS256') {
      return cryptoVerify('sha256', signingInput, { key, padding: constants.RSA_PKCS1_PADDING }, signature);
    }
    if (alg === 'ES256') {
      return cryptoVerify('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' }, signature);
    }
    return false;
  } catch {
    return false;
  }
}

/* -------------------------------- claims -------------------------------- */

function audienceMatches(audience: unknown, expected: string): boolean {
  if (!expected) return false;
  if (typeof audience === 'string') return audience === expected;
  if (Array.isArray(audience)) return audience.includes(expected);
  return false;
}

function audienceMatchesAny(audience: unknown, expected: readonly string[]): boolean {
  return expected.some((candidate) => audienceMatches(audience, candidate));
}

/** Constant-time nonce comparison (length-independent via SHA-256). */
function nonceMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || actual.length === 0) return false;
  const a = createHash('sha256').update(actual).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function claimString(payload: Record<string, unknown>, name: string): string | undefined {
  if (!name) return undefined;
  const value = payload[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function claimBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true' || value === 1) return true;
  if (value === false || value === 'false' || value === 0) return false;
  return undefined;
}

function cleanText(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function readConfigInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function roleFromClaim(raw: string | undefined): Role {
  const value = (raw ?? '').toLowerCase();
  return value === 'host' || value === 'moderator' || value === 'guest' ? value : 'guest';
}

const ROLE_RANK: Record<IdentityRole, number> = { guest: 1, moderator: 2, host: 3 };

/** Highest-privilege matching group rule; `undefined` when no group matches. */
function roleFromGroups(groups: readonly string[], map: TenantConfig['integrations']['identity']['groupRoleMap']): IdentityRole | undefined {
  let picked: IdentityRole | undefined;
  let rank = 0;
  for (const rule of map) {
    if (!groups.includes(rule.group)) continue;
    const candidate = ROLE_RANK[rule.role];
    if (candidate > rank) {
      rank = candidate;
      picked = rule.role;
    }
  }
  return picked;
}

/** Group claim: string array (Keycloak/Entra) or a space/comma-separated string. */
function groupsFromClaim(payload: Record<string, unknown>, name: string): string[] {
  if (!name) return [];
  const value = payload[name];
  const raw: string[] = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : [];
  const groups: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const group = entry.trim();
    if (!group || group.length > 200 || seen.has(group)) continue;
    seen.add(group);
    groups.push(group);
    if (groups.length >= 200) break;
  }
  return groups;
}

function permissionsFromClaim(payload: Record<string, unknown>, name: string): FeatureKey[] | undefined {
  const value = payload[name];
  if (!Array.isArray(value)) return undefined;
  const allowed = value.filter((entry): entry is FeatureKey => typeof entry === 'string' && FEATURE_SET.has(entry));
  return allowed.length > 0 ? [...new Set(allowed)] : undefined;
}

/* ----------------------------- email policy ----------------------------- */

const EMAIL_LOCAL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

interface EmailAddress {
  email: string;
  domain: string;
}

function parseEmail(raw: string): EmailAddress | null {
  const value = raw.trim().toLowerCase();
  if (!value || value.length > 320 || /\s/.test(value)) return null;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || !EMAIL_LOCAL_RE.test(local) || !DOMAIN_RE.test(domain)) return null;
  return { email: value, domain };
}

type DomainRule = { kind: 'exact'; domain: string } | { kind: 'subdomain'; domain: string };

function parseDomainRule(raw: string): DomainRule | null {
  let value = raw.trim().toLowerCase();
  if (!value || value.length > 253) return null;
  let kind: DomainRule['kind'] = 'exact';
  if (value.startsWith('*.')) {
    kind = 'subdomain';
    value = value.slice(2);
  } else if (value.startsWith('.')) {
    kind = 'subdomain';
    value = value.slice(1);
  }
  if (!DOMAIN_RE.test(value)) return null;
  return { kind, domain: value };
}

function domainRuleMatches(rule: DomainRule, domain: string): boolean {
  if (rule.kind === 'exact') return domain === rule.domain;
  return domain.endsWith(`.${rule.domain}`);
}

/**
 * Enforces `allowedEmails` / `allowedEmailDomains` / `requireEmailVerified`.
 * A configured allowlist with no valid entries denies everyone (fail closed);
 * an explicit `email_verified: false` always denies, even when no allowlist and
 * no `requireEmailVerified` is configured.
 */
function assertEmailAllowed(identity: TenantConfig['integrations']['identity'], payload: Record<string, unknown>): string | undefined {
  const configuredEmails = Array.isArray(identity.allowedEmails) ? identity.allowedEmails : [];
  const configuredDomains = Array.isArray(identity.allowedEmailDomains) ? identity.allowedEmailDomains : [];
  const requireVerified = identity.requireEmailVerified === true;
  const allowlistConfigured = configuredEmails.length > 0 || configuredDomains.length > 0;
  const email = claimString(payload, identity.emailClaim);
  const parsed = email ? parseEmail(email) : null;
  const emailVerified = claimBoolean(payload[identity.emailVerifiedClaim]);
  // Explicit false is a denial regardless of the access-policy configuration.
  if (emailVerified === false) {
    throw new OidcError(403, 'identity_not_allowed', 'Email в identity-токене помечен IdP как неподтверждённый');
  }
  if (!allowlistConfigured && !requireVerified) {
    // No policy: a missing/malformed email is not an access restriction.
    return parsed?.email;
  }
  if (!parsed) {
    throw new OidcError(403, 'identity_not_allowed', 'В identity-токене нет корректного email для проверки доступа');
  }
  if (requireVerified && emailVerified !== true) {
    throw new OidcError(403, 'identity_not_allowed', 'Email в identity-токене не подтверждён IdP');
  }
  if (!allowlistConfigured) return parsed.email;

  const exact = configuredEmails
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => parseEmail(entry)?.email)
    .filter((entry): entry is string => Boolean(entry));
  const rules = configuredDomains
    .filter((entry): entry is string => typeof entry === 'string')
    .map(parseDomainRule)
    .filter((rule): rule is DomainRule => Boolean(rule));
  if (exact.length === 0 && rules.length === 0) {
    // The admin configured an allowlist but every entry is malformed: deny all
    // rather than silently disabling the restriction.
    throw new OidcError(403, 'identity_not_allowed', 'Список разрешённых email/доменов настроен некорректно');
  }
  if (exact.includes(parsed.email) || rules.some((rule) => domainRuleMatches(rule, parsed.domain))) {
    return parsed.email;
  }
  throw new OidcError(403, 'identity_not_allowed', 'Учётная запись не входит в разрешённый список (email/домен)');
}

/* ------------------------------ main verify ----------------------------- */

/**
 * Verifies an OIDC JWT for the tenant and maps its claims. Throws OidcError
 * (401 invalid_identity_token, 403 identity_not_allowed/tenant_mismatch,
 * 501 identity_not_configured).
 */
export async function verifyOidcToken(
  env: Env,
  config: TenantConfig,
  token: string,
  options: VerifyOidcOptions = {},
): Promise<VerifiedOidcToken> {
  const identity = config.integrations.identity;
  if (identity.mode !== 'oidc') {
    throw new OidcError(501, 'identity_not_configured', 'OIDC не настроен для этого тенанта');
  }
  // mode:'oidc' requires an issuer and an audience: an absent check is fail-open.
  const issuer = identity.issuer.trim();
  if (!issuer) throw new OidcError(501, 'identity_not_configured', 'OIDC не настроен: укажите issuer');
  const expectedAudiences = [...new Set([identity.audience, ...(options.audiences ?? [])].map((value) => value.trim()).filter(Boolean))];
  if (expectedAudiences.length === 0) {
    throw new OidcError(501, 'identity_not_configured', 'OIDC не настроен: укажите audience или clientId');
  }

  const raw = typeof token === 'string' ? token.trim() : '';
  if (!raw || raw.length > 16384) throw new OidcError(401, 'invalid_identity_token', 'Некорректный identity-токен');
  const parts = raw.split('.');
  if (parts.length !== 3) throw new OidcError(401, 'invalid_identity_token', 'Некорректный identity-токен (JWT)');
  const header = decodeJson<{ alg?: unknown; kid?: unknown; typ?: unknown }>(parts[0]!, 'header');
  if (typeof header.alg !== 'string' || !['RS256', 'ES256'].includes(header.alg)) {
    throw new OidcError(401, 'invalid_identity_token', 'Неподдерживаемый алгоритм identity-токена');
  }
  if (header.typ !== undefined) {
    const typ = typeof header.typ === 'string' ? header.typ.toLowerCase() : '';
    // Access tokens (`at+jwt`) must not be accepted where an id_token/identity
    // JWT is expected.
    if (typ !== 'jwt' && typ !== 'application/jwt') {
      throw new OidcError(401, 'invalid_identity_token', 'Некорректный тип identity-токена (typ)');
    }
  }
  if (header.kid !== undefined && (typeof header.kid !== 'string' || header.kid.length > 256)) {
    throw new OidcError(401, 'invalid_identity_token', 'Некорректный kid identity-токена');
  }
  const payload = decodeJson<Record<string, unknown>>(parts[1]!, 'payload');
  const kid = typeof header.kid === 'string' ? header.kid : undefined;
  const matching = (keys: Jwk[]): Jwk[] =>
    keys.filter((key) => (kid ? key.kid === kid : true) && (key.alg === undefined || key.alg === header.alg));
  let candidates = matching(await fetchJwks(config, env));
  if (kid && candidates.length === 0) {
    // Key rotation: one rate-limited refetch before giving up.
    candidates = matching(await fetchJwks(config, env, true));
  }
  if (candidates.length === 0) throw new OidcError(401, 'invalid_identity_token', 'Ключ identity-подписи не найден');
  const signature = b64url(parts[2]!);
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
  if (!candidates.some((key) => verifySignature(header, signingInput, signature, key))) {
    throw new OidcError(401, 'invalid_identity_token', 'Неверная подпись identity-токена');
  }

  const now = Math.floor(Date.now() / 1000);
  const clockSkew = readConfigInt(identity.clockSkewSec, CLOCK_SKEW_SEC, 0, MAX_CLOCK_SKEW_SEC);
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= now - clockSkew) {
    throw new OidcError(401, 'invalid_identity_token', 'Identity-токен истёк');
  }
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || payload.nbf > now + clockSkew) {
      throw new OidcError(401, 'invalid_identity_token', 'Identity-токен ещё не активен');
    }
  }
  if (payload.iat !== undefined) {
    if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > now + clockSkew) {
      throw new OidcError(401, 'invalid_identity_token', 'Некорректное время выпуска identity-токена (iat)');
    }
    if (typeof payload.iat === 'number' && payload.exp < payload.iat - clockSkew) {
      throw new OidcError(401, 'invalid_identity_token', 'Некорректный срок действия identity-токена');
    }
    const maxTokenAgeSec = readConfigInt(identity.maxTokenAgeSec, 0, 0, 7 * 86400);
    if (maxTokenAgeSec > 0 && payload.exp - payload.iat > maxTokenAgeSec) {
      throw new OidcError(401, 'invalid_identity_token', 'Identity-токен выпущен слишком давно');
    }
  } else if (readConfigInt(identity.maxTokenAgeSec, 0, 0, 7 * 86400) > 0) {
    throw new OidcError(401, 'invalid_identity_token', 'В identity-токене нет iat при заданном maxTokenAgeSec');
  }
  if (payload.iss !== issuer) {
    throw new OidcError(401, 'invalid_identity_token', 'Неверный issuer identity-токена');
  }
  if (!audienceMatchesAny(payload.aud, expectedAudiences)) {
    throw new OidcError(401, 'invalid_identity_token', 'Неверная audience identity-токена');
  }
  // OIDC: when `aud` has multiple values the token must name the authorized
  // party in `azp`; that party must be one we accept. A single-value `aud` is
  // already unambiguous, so an IdP-specific `azp` (e.g. the resource client id)
  // is not rejected there.
  if (Array.isArray(payload.aud) && payload.aud.length > 1) {
    if (typeof payload.azp !== 'string' || !expectedAudiences.includes(payload.azp)) {
      throw new OidcError(401, 'invalid_identity_token', 'Неверная authorized party identity-токена (azp)');
    }
  }
  if (options.nonce !== undefined && !nonceMatches(payload.nonce, options.nonce)) {
    throw new OidcError(401, 'invalid_identity_token', 'Неверный nonce identity-токена');
  }

  // Tenant binding: an id_token minted for another tenant cannot be replayed
  // here when `tenantClaim` is configured.
  const tenantClaim = identity.tenantClaim.trim();
  if (tenantClaim) {
    const claimed = claimString(payload, tenantClaim);
    if (claimed !== config.tenantId) {
      throw new OidcError(403, 'tenant_mismatch', 'Identity-токен выдан для другой организации');
    }
  }

  const email = assertEmailAllowed(identity, payload);

  const groups = groupsFromClaim(payload, identity.groupsClaim);
  const roleMap = Array.isArray(identity.groupRoleMap) ? identity.groupRoleMap : [];
  const role = roleMap.length > 0 ? (roleFromGroups(groups, roleMap) ?? 'guest') : roleFromClaim(claimString(payload, identity.roleClaim));

  const userId = claimString(payload, identity.userIdClaim) ?? claimString(payload, 'sub');
  if (!userId) throw new OidcError(401, 'invalid_identity_token', 'В identity-токене нет userId (sub)');
  const cleanUserId = cleanText(userId, 200);
  if (!cleanUserId) throw new OidcError(401, 'invalid_identity_token', 'Некорректный userId identity-токена');
  const name = claimString(payload, identity.nameClaim) ?? cleanUserId;
  const permissions = permissionsFromClaim(payload, identity.permissionsClaim);
  const verified = claimBoolean(payload[identity.verifiedClaim]) === true;
  return {
    identity: {
      userId: cleanUserId,
      name: cleanText(name, 120) || cleanUserId,
      role,
      ...(permissions ? { permissions } : {}),
      verified,
      issuer,
    },
    claims: payload,
    groups,
    ...(email ? { email } : {}),
  };
}

/** Verified identity only (joins/verify endpoint); see {@link verifyOidcToken}. */
export async function verifyOidcIdentity(
  env: Env,
  config: TenantConfig,
  token: string,
  options: VerifyOidcOptions = {},
): Promise<OidcIdentity> {
  return (await verifyOidcToken(env, config, token, options)).identity;
}
