/**
 * Optional OIDC Discovery 1.0 support (`/.well-known/openid-configuration`).
 *
 * Corporate IdPs (Keycloak, Entra ID, Okta, ADFS, Ping) publish their endpoints
 * in a discovery document. Fetching it lets a tenant configure just `issuer` +
 * `clientId` instead of copying authorization/token/JWKS/logout URLs by hand.
 *
 * Safety model:
 *  - discovery is **opt-in** (`integrations.identity.discovery`) and the
 *    document URL is validated by the shared external-URL policy (SSRF/TLS);
 *  - the document `issuer` must equal the configured issuer (OIDC Discovery
 *    §4.3 mix-up defense), otherwise the document is rejected;
 *  - the JWKS endpoint stays pinned to the same issuer via that check;
 *  - explicit endpoint fields stay supported and win over discovered values
 *    (per-endpoint override/fallback when discovery is disabled or failing);
 *  - responses are cached (10 min by default, `Cache-Control` bounded), fetched
 *    once at a time, timeout/size bounded, and failures are negatively cached;
 *  - the document contains no secrets, but it is never logged verbatim.
 *
 * See docs/sso-oidc.md §3.
 */
import {
  OIDC_DISCOVERY_WELL_KNOWN_PATH,
  type IdentityConfig,
} from '@agil/protocol';
import type { Env } from './env.js';
import { OidcError } from './oidc.js';
import { isSecureMode, validateExternalUrl } from './url-policy.js';

const DISCOVERY_TIMEOUT_MS = 4000;
const DISCOVERY_CACHE_TTL_MS = 10 * 60_000;
const DISCOVERY_MIN_TTL_MS = 60_000;
const DISCOVERY_MAX_TTL_MS = 60 * 60_000;
const DISCOVERY_FAILURE_BACKOFF_MS = 30_000;
const DISCOVERY_MAX_BYTES = 256 * 1024;
const DISCOVERY_MAX_ENTRIES = 64;

/** Validated discovery metadata (only the fields this server consumes). */
export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  response_modes_supported?: string[];
}

interface DiscoveryCacheEntry {
  document: OidcDiscoveryDocument;
  fetchedAt: number;
  expiresAt: number;
  fetchCount: number;
  lastError?: string;
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>();
const discoveryInflight = new Map<string, Promise<OidcDiscoveryDocument>>();
let discoveryLastFailureAt: { url: string; at: number } | null = null;

/** Diagnostic snapshot of the discovery cache (tests/ops; no secrets). */
export interface OidcDiscoveryDiagnostic {
  url: string;
  issuer: string;
  fetchedAt: number;
  expiresAt: number;
  fetchCount: number;
  lastError?: string;
}

export function oidcDiscoveryDiagnostics(): OidcDiscoveryDiagnostic[] {
  return [...discoveryCache.entries()].map(([url, entry]) => ({
    url,
    issuer: entry.document.issuer,
    fetchedAt: entry.fetchedAt,
    expiresAt: entry.expiresAt,
    fetchCount: entry.fetchCount,
    ...(entry.lastError ? { lastError: entry.lastError } : {}),
  }));
}

/** Clears the discovery cache/in-flight/failure state (tests/diagnostics). */
export function clearOidcDiscoveryCache(): void {
  discoveryCache.clear();
  discoveryInflight.clear();
  discoveryLastFailureAt = null;
}

/** True when the tenant opted into discovery (explicit metadata URL implies it). */
export function isOidcDiscoveryEnabled(identity: IdentityConfig): boolean {
  return identity.discovery === true || identity.discoveryUrl.trim().length > 0;
}

/**
 * Discovery document URL for a tenant: explicit `discoveryUrl`, else the OIDC
 * Discovery 1.0 `issuer` + `/.well-known/openid-configuration` rule. Returns
 * `null` when discovery is disabled. Throws 501 when the configured URL is
 * rejected by the outbound URL policy.
 */
export function oidcDiscoveryUrl(env: Env, identity: IdentityConfig): string | null {
  if (!isOidcDiscoveryEnabled(identity)) return null;
  const explicit = identity.discoveryUrl.trim();
  const raw = explicit || discoveryUrlFromIssuer(identity.issuer);
  if (!raw) {
    throw new OidcError(501, 'identity_not_configured', 'OIDC discovery: укажите issuer (или discoveryUrl)');
  }
  const result = validateExternalUrl(raw, { secure: isSecureMode(env) });
  if (!result.ok) {
    throw new OidcError(501, 'identity_not_configured', `OIDC discovery URL отклонён политикой URL: ${result.reason}`);
  }
  return result.url.toString();
}

/** `issuer` + `/.well-known/openid-configuration` per OIDC Discovery 1.0. */
export function discoveryUrlFromIssuer(issuer: string): string {
  const value = issuer.trim().replace(/\/+$/, '');
  return value ? `${value}${OIDC_DISCOVERY_WELL_KNOWN_PATH}` : '';
}

/**
 * Issuer equality per OIDC Discovery: exact string match, with one benign
 * normalisation — a single trailing slash is ignored (some IdPs publish
 * `https://sso.corp/` while the configured issuer is `https://sso.corp`).
 * Scheme/host/path differences are never normalised away.
 */
export function discoveryIssuerMatches(configured: string, published: unknown): boolean {
  if (typeof published !== 'string') return false;
  const a = configured.trim().replace(/\/+$/, '');
  const b = published.trim().replace(/\/+$/, '');
  return a.length > 0 && a === b;
}

function discoveryTtlMs(response: Response): number {
  const cacheControl = response.headers.get('cache-control') ?? '';
  // An IdP that forbids caching gets refetched on the next resolution; this
  // keeps the "document issuer pinned" property when a document is corrected.
  if (/(?:^|,)\s*no-(?:store|cache)(?:\s*=|,|$)/i.test(cacheControl)) return 0;
  const match = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cacheControl);
  if (!match?.[1]) return DISCOVERY_CACHE_TTL_MS;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return DISCOVERY_CACHE_TTL_MS;
  return Math.min(Math.max(seconds * 1000, DISCOVERY_MIN_TTL_MS), DISCOVERY_MAX_TTL_MS);
}

function pruneDiscoveryCache(url: string): void {
  if (discoveryCache.size <= DISCOVERY_MAX_ENTRIES) return;
  const oldest = [...discoveryCache.entries()]
    .filter(([key]) => key !== url)
    .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0];
  if (oldest) discoveryCache.delete(oldest[0]);
}

/** Validates one discovery document; throws OidcError on any mismatch. */
export function parseOidcDiscoveryDocument(
  env: Env,
  identity: IdentityConfig,
  body: unknown,
): OidcDiscoveryDocument {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new OidcError(501, 'identity_not_configured', 'OIDC discovery: документ не является JSON-объектом');
  }
  const doc = body as Record<string, unknown>;
  if (!discoveryIssuerMatches(identity.issuer, doc.issuer)) {
    // Fail closed: a document for another issuer must not redirect our tokens.
    throw new OidcError(501, 'identity_not_configured', 'OIDC discovery: issuer документа не совпадает с настроенным issuer');
  }
  const secure = isSecureMode(env);
  const requireEndpoint = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new OidcError(501, 'identity_not_configured', `OIDC discovery: нет ${field}`);
    }
    const result = validateExternalUrl(value, { secure });
    if (!result.ok) {
      throw new OidcError(501, 'identity_not_configured', `OIDC discovery: ${field} отклонён политикой URL: ${result.reason}`);
    }
    return result.url.toString();
  };
  const authorizationEndpoint = requireEndpoint(doc.authorization_endpoint, 'authorization_endpoint');
  const tokenEndpoint = requireEndpoint(doc.token_endpoint, 'token_endpoint');
  const jwksUri = requireEndpoint(doc.jwks_uri, 'jwks_uri');
  const endSessionEndpoint = typeof doc.end_session_endpoint === 'string' && doc.end_session_endpoint.trim()
    ? requireEndpoint(doc.end_session_endpoint, 'end_session_endpoint')
    : undefined;
  const stringList = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const list = value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0 && item.length <= 100);
    return list.length > 0 ? [...new Set(list)] : undefined;
  };
  const authMethods = stringList(doc.token_endpoint_auth_methods_supported);
  const responseModes = stringList(doc.response_modes_supported);
  return {
    issuer: (doc.issuer as string).trim(),
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    jwks_uri: jwksUri,
    ...(endSessionEndpoint ? { end_session_endpoint: endSessionEndpoint } : {}),
    ...(authMethods ? { token_endpoint_auth_methods_supported: authMethods } : {}),
    ...(responseModes ? { response_modes_supported: responseModes } : {}),
  };
}

async function fetchDiscoveryOnce(env: Env, identity: IdentityConfig, url: string): Promise<OidcDiscoveryDocument> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new OidcError(503, 'identity_not_configured', `OIDC discovery недоступен (HTTP ${response.status})`);
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > DISCOVERY_MAX_BYTES) {
      throw new OidcError(503, 'identity_not_configured', 'OIDC discovery: слишком большой документ');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > DISCOVERY_MAX_BYTES) {
      throw new OidcError(503, 'identity_not_configured', 'OIDC discovery: слишком большой документ');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new OidcError(503, 'identity_not_configured', 'OIDC discovery: некорректный JSON');
    }
    const document = parseOidcDiscoveryDocument(env, identity, parsed);
    const now = Date.now();
    const cached = discoveryCache.get(url);
    discoveryCache.set(url, {
      document,
      fetchedAt: now,
      expiresAt: now + discoveryTtlMs(response),
      fetchCount: (cached?.fetchCount ?? 0) + 1,
    });
    pruneDiscoveryCache(url);
    discoveryLastFailureAt = null;
    return document;
  } catch (error) {
    const message =
      error instanceof OidcError
        ? error.message
        : (error as Error).name === 'AbortError'
          ? 'OIDC discovery timeout'
          : 'OIDC discovery недоступен';
    discoveryLastFailureAt = { url, at: Date.now() };
    const cached = discoveryCache.get(url);
    if (cached) cached.lastError = message;
    if (error instanceof OidcError) throw error;
    throw new OidcError(503, 'identity_not_configured', message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the validated discovery document, cached. Throws OidcError when
 * discovery is enabled but the document cannot be fetched/validated. Callers
 * that have explicit endpoint fallbacks catch this and use the static config.
 */
export async function getOidcDiscovery(env: Env, identity: IdentityConfig): Promise<OidcDiscoveryDocument> {
  const url = oidcDiscoveryUrl(env, identity);
  if (!url) throw new OidcError(501, 'identity_not_configured', 'OIDC discovery не включён');
  const now = Date.now();
  const cached = discoveryCache.get(url);
  if (cached && now < cached.expiresAt) {
    // The same explicit discovery URL may be reused after an issuer change; the
    // cached document must still be pinned to the *current* configured issuer.
    if (discoveryIssuerMatches(identity.issuer, cached.document.issuer)) return cached.document;
    discoveryCache.delete(url);
  }
  const failure = discoveryLastFailureAt;
  if (failure && failure.url === url && now - failure.at < DISCOVERY_FAILURE_BACKOFF_MS) {
    throw new OidcError(503, 'identity_not_configured', 'OIDC discovery временно недоступен');
  }
  // Single-flight is keyed by URL *and* expected issuer: two tenants sharing one
  // explicit discovery URL but pinning different issuers must not share a fetch.
  const inflightKey = `${url}\n${identity.issuer.trim()}`;
  const inflight = discoveryInflight.get(inflightKey);
  if (inflight) return inflight;
  const promise = fetchDiscoveryOnce(env, identity, url);
  discoveryInflight.set(inflightKey, promise);
  try {
    return await promise;
  } finally {
    if (discoveryInflight.get(inflightKey) === promise) discoveryInflight.delete(inflightKey);
  }
}

/** Endpoint set after merging explicit tenant config with (optional) discovery. */
export interface OidcResolvedEndpoints {
  discoveryEnabled: boolean;
  /** Why discovery failed, when it did (safe for logs: URL policy reason only). */
  discoveryError?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  jwksUrl?: string;
  endSessionEndpoint?: string;
  /** Metadata hints (discovery only); validated against the configured method/mode. */
  tokenEndpointAuthMethods?: string[];
  responseModes?: string[];
}

/**
 * Explicit config endpoints win per field; discovered endpoints fill the gaps.
 * A discovery failure never discards explicit config: the server falls back to
 * the operator-pinned endpoints and reports `discoveryError` to the caller.
 */
export async function resolveOidcEndpoints(
  env: Env,
  identity: IdentityConfig,
): Promise<OidcResolvedEndpoints> {
  const explicit = {
    authorizationEndpoint: identity.authorizationEndpoint.trim() || undefined,
    tokenEndpoint: identity.tokenEndpoint.trim() || undefined,
    jwksUrl: identity.jwksUrl.trim() || undefined,
    endSessionEndpoint: identity.endSessionEndpoint.trim() || undefined,
  };
  if (!isOidcDiscoveryEnabled(identity)) {
    return { discoveryEnabled: false, ...explicit };
  }
  try {
    const doc = await getOidcDiscovery(env, identity);
    return {
      discoveryEnabled: true,
      authorizationEndpoint: explicit.authorizationEndpoint ?? doc.authorization_endpoint,
      tokenEndpoint: explicit.tokenEndpoint ?? doc.token_endpoint,
      jwksUrl: explicit.jwksUrl ?? doc.jwks_uri,
      endSessionEndpoint: explicit.endSessionEndpoint ?? doc.end_session_endpoint,
      ...(doc.token_endpoint_auth_methods_supported
        ? { tokenEndpointAuthMethods: doc.token_endpoint_auth_methods_supported }
        : {}),
      ...(doc.response_modes_supported ? { responseModes: doc.response_modes_supported } : {}),
    };
  } catch (error) {
    return {
      discoveryEnabled: true,
      discoveryError: error instanceof OidcError ? error.message : 'OIDC discovery недоступен',
      ...explicit,
    };
  }
}
