/**
 * OIDC authorization-code login for the dashboard (PKCE + state + nonce) and
 * optional RP-initiated logout.
 *
 * `start` creates a single-use `state`, a `nonce` and an S256 PKCE challenge in
 * memory (never disk or logs), plus an HttpOnly `SameSite=Lax` binding cookie
 * for same-origin starts, so a callback URL minted in another browser cannot be
 * replayed into the victim's. `callback` consumes the state, exchanges the code
 * at `tokenEndpoint` (client_secret_post or client_secret_basic), verifies the
 * `id_token` (signature, iss, aud, azp, exp, nonce, tenant claim, email/group
 * policy), mints a short-lived admin session JWT and redirects to
 * `returnTo#sso_token=…` — a fragment, never sent to a server, logged, or leaked
 * via `Referer`.
 *
 * Endpoints can come from explicit tenant config or, when enabled, from the
 * issuer's OIDC discovery document (`oidc-discovery.ts`); explicit fields win.
 * `response_mode=form_post` is supported through the POST callback plus a
 * `SameSite=None; Secure` binding cookie (HTTPS deployments).
 *
 * State/PKCE/logout entries are process-local (multi-node needs sticky sessions
 * or a shared store); binding is skipped for cross-origin dashboards. See
 * docs/sso-oidc.md.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  OIDC_RESPONSE_MODES,
  OIDC_TOKEN_ENDPOINT_AUTH_METHODS,
  isAllowedOidcClientSecretEnv,
  isOidcClientSecretEnvBoundToTenant,
  type OidcResponseMode,
  type OidcTokenEndpointAuthMethod,
  type TenantConfig,
} from '@agil/protocol';
import type { Env } from './env.js';
import { OidcError, verifyOidcToken } from './oidc.js';
import { resolveOidcEndpoints } from './oidc-discovery.js';
import { signAdminSession, type IssuedAdminSession } from './admin-session.js';
import { isSecureMode, validateExternalUrl } from './url-policy.js';

/** Upper bound of pending authorizations kept in memory. */
const MAX_PENDING = 1000;
/** Upper bound of pending RP-initiated logout states kept in memory. */
const MAX_PENDING_LOGOUTS = 1000;
/** Token-endpoint timeout (ms). */
export const OIDC_EXCHANGE_TIMEOUT_MS = 8000;
/** Dashboard path used when `returnTo` is absent. */
const DEFAULT_RETURN_PATH = '/dashboard/';
/** Server route registered as the default post-logout redirect URI. */
export const OIDC_LOGOUT_CALLBACK_PATH = '/v1/auth/oidc/logout/callback';
const MAX_RETURN_TO_LENGTH = 2048;
/** Path scope of the state-binding cookie (start + callback only). */
const BINDING_COOKIE_PATH = '/v1/auth/oidc';
const BINDING_COOKIE_NAME = 'agil_oidc_binding';

interface PendingAuthorization {
  state: string;
  tenantId: string;
  returnTo: string;
  nonce: string;
  verifier: string;
  createdAt: number;
  expiresAt: number;
  /** SHA-256 of the browser-binding cookie value; absent = not bound. */
  bindingHash?: string;
}

interface PendingLogout {
  tenantId: string;
  returnTo: string;
  createdAt: number;
  expiresAt: number;
}

const pending = new Map<string, PendingAuthorization>();
const pendingLogouts = new Map<string, PendingLogout>();

/**
 * State/PKCE entry was rejected. Carries the (already validated) `returnTo` when
 * known so the browser can still be sent back to the right dashboard on errors.
 */
export class OidcStateError extends OidcError {
  readonly returnTo?: string;
  constructor(code: 'state_invalid' | 'state_expired', message: string, returnTo?: string) {
    super(400, code, message);
    this.name = 'OidcStateError';
    this.returnTo = returnTo;
  }
}

/** Clears the in-memory pending stores (tests). */
export function resetOidcFlowForTests(): void {
  pending.clear();
  pendingLogouts.clear();
}

/** Number of pending authorizations (diagnostics/tests). */
export function pendingOidcCount(): number {
  return pending.size;
}

/** Number of pending RP-initiated logout states (diagnostics/tests). */
export function pendingOidcLogoutCount(): number {
  return pendingLogouts.size;
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function bindingHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Name of the HttpOnly state-binding cookie (no token, no PII). */
export function oidcBindingCookieName(): string {
  return BINDING_COOKIE_NAME;
}

/**
 * `Set-Cookie` value for a browser-bound pending authorization.
 *
 * `form_post` responses are cross-site POSTs, so the binding cookie must be
 * `SameSite=None` there (with `Secure` when the public origin uses HTTPS). Query-mode logins
 * keep `SameSite=Lax`, which is sent on the top-level GET redirect back.
 */
export function oidcBindingCookieHeader(
  env: Env,
  value: string,
  maxAgeSec: number,
  sameSite: 'Lax' | 'None' = 'Lax',
): string {
  const parts = [
    `${BINDING_COOKIE_NAME}=${value}`,
    `Path=${BINDING_COOKIE_PATH}`,
    `Max-Age=${Math.max(1, Math.trunc(maxAgeSec))}`,
    'HttpOnly',
    `SameSite=${sameSite}`,
  ];
  if (isSecureMode(env) || env.publicOrigin.startsWith('https://')) parts.push('Secure');
  return parts.join('; ');
}

/** `Set-Cookie` value that deletes the binding cookie (every callback path). */
export function clearOidcBindingCookieHeader(env: Env): string {
  const parts = [`${BINDING_COOKIE_NAME}=`, `Path=${BINDING_COOKIE_PATH}`, 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (isSecureMode(env) || env.publicOrigin.startsWith('https://')) parts.push('Secure');
  return parts.join('; ');
}

/** Reads one cookie value from a Cookie header (no decoding; values are base64url). */
export function readCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const chunk of cookieHeader.split(';')) {
    const index = chunk.indexOf('=');
    if (index <= 0) continue;
    if (chunk.slice(0, index).trim() !== name) continue;
    return chunk.slice(index + 1).trim() || undefined;
  }
  return undefined;
}

/** S256 PKCE challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export interface OidcFlowConfig {
  /** Authorization endpoint (login; absent for a logout-only config). */
  authorizationEndpoint?: URL;
  /** Token endpoint (login; absent for a logout-only config). */
  tokenEndpoint?: URL;
  clientId: string;
  clientSecretEnv: string;
  redirectUri: string;
  scopes: string[];
  tokenEndpointAuthMethod: OidcTokenEndpointAuthMethod;
  responseMode: OidcResponseMode;
  /** RP-initiated logout endpoint (`end_session_endpoint`), when configured. */
  endSessionEndpoint?: URL;
  /** Validated `post_logout_redirect_uri` (server callback by default). */
  postLogoutRedirectUri: string;
  discoveryEnabled: boolean;
  discoveryError?: string;
}

function requireExternal(env: Env, raw: string, label: string): URL {
  const result = validateExternalUrl(raw, { secure: isSecureMode(env) });
  if (!result.ok) throw new OidcError(501, 'identity_not_configured', `${label}: ${result.reason}`);
  return result.url;
}

/**
 * Resolves a browser-facing redirect URL (login redirect URI / post-logout
 * redirect URI): http(s), no credentials/fragment, HTTPS in production mode.
 */
function parseBrowserRedirect(env: Env, raw: string, label: string): string {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OidcError(501, 'identity_not_configured', `${label}: URL is malformed`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OidcError(501, 'identity_not_configured', `${label}: http(s) is required`);
  }
  if (isSecureMode(env) && url.protocol !== 'https:') {
    // The authorization code / logout redirect travel through these URLs;
    // production is TLS-only.
    throw new OidcError(501, 'identity_not_configured', `${label}: HTTPS is required in production mode`);
  }
  if (url.username || url.password) {
    throw new OidcError(501, 'identity_not_configured', `${label} must not contain credentials`);
  }
  if (url.hash) throw new OidcError(501, 'identity_not_configured', `${label} must not contain a fragment`);
  return url.toString();
}

function parseRedirectUri(env: Env, raw: string): string {
  return parseBrowserRedirect(env, raw.trim() || `${env.publicOrigin}/v1/auth/oidc/callback`, 'redirectUri');
}

/** Default post-logout redirect: the server callback that validates `state`. */
export function oidcPostLogoutRedirectUri(env: Env, config: TenantConfig): string {
  const raw = config.integrations.identity.postLogoutRedirectUri.trim();
  return parseBrowserRedirect(env, raw || `${env.publicOrigin}${OIDC_LOGOUT_CALLBACK_PATH}`, 'postLogoutRedirectUri');
}

function normalizedScopes(config: TenantConfig): string[] {
  const configured = config.integrations.identity.scopes
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0 && scope.length <= 100 && !/\s/.test(scope));
  // `openid` is mandatory for an id_token; always request it first.
  return [...new Set(['openid', ...configured])];
}

function runtimeAuthMethod(identity: TenantConfig['integrations']['identity']): OidcTokenEndpointAuthMethod {
  const value = identity.tokenEndpointAuthMethod;
  if (typeof value !== 'string' || !(OIDC_TOKEN_ENDPOINT_AUTH_METHODS as readonly string[]).includes(value)) {
    throw new OidcError(
      400,
      'validation_failed',
      'tokenEndpointAuthMethod: допустимо client_secret_post или client_secret_basic',
    );
  }
  return value as OidcTokenEndpointAuthMethod;
}

function runtimeResponseMode(identity: TenantConfig['integrations']['identity']): OidcResponseMode {
  const value = identity.responseMode;
  if (typeof value !== 'string' || !(OIDC_RESPONSE_MODES as readonly string[]).includes(value)) {
    throw new OidcError(400, 'validation_failed', 'responseMode: допустимо query или form_post');
  }
  return value as OidcResponseMode;
}

/**
 * Resolves and validates the flow config from explicit tenant fields plus
 * (when enabled) the issuer's discovery document. `purpose` selects the
 * required endpoint set: `login` needs authorization+token, `logout` needs
 * `end_session_endpoint`; both require clientId/issuer and a tenant-bound
 * client-secret env name. Throws `OidcError` (`501 identity_not_configured` for
 * a missing endpoint, `400 validation_failed` for unsafe config values).
 */
export async function resolveOidcFlowConfig(
  env: Env,
  config: TenantConfig,
  purpose: 'login' | 'logout' = 'login',
): Promise<OidcFlowConfig> {
  const identity = config.integrations.identity;
  if (identity.mode !== 'oidc') {
    throw new OidcError(501, 'identity_not_configured', 'OIDC не настроен для этого тенанта (mode != oidc)');
  }
  if (!identity.clientId.trim()) {
    throw new OidcError(501, 'identity_not_configured', 'OIDC не настроен: укажите clientId');
  }
  if (!identity.issuer.trim()) {
    // Without a pinned issuer the id_token check would be fail-open.
    throw new OidcError(501, 'identity_not_configured', 'OIDC не настроен: укажите issuer');
  }
  // A tenant may only name a server-owned env var, and that name must be bound
  // to *this* tenant, so one tenant cannot select another tenant's OIDC client
  // secret. Validated at every resolution (start + exchange) to fail closed.
  const clientSecretEnv = identity.clientSecretEnv.trim();
  if (!isAllowedOidcClientSecretEnv(clientSecretEnv)) {
    throw new OidcError(
      400,
      'validation_failed',
      'clientSecretEnv: разрешены только имена из namespace AGIL_OIDC_CLIENT_SECRET[_*]',
    );
  }
  if (!isOidcClientSecretEnvBoundToTenant(clientSecretEnv, config.tenantId, env.oidcTenantSecrets)) {
    throw new OidcError(
      400,
      'validation_failed',
      'clientSecretEnv: имя переменной не привязано к тенанту; используйте AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME> (канонический lower-case id) или точную запись в AGIL_OIDC_TENANT_SECRETS',
    );
  }
  const authMethod = runtimeAuthMethod(identity);
  const responseMode = runtimeResponseMode(identity);
  const endpoints = await resolveOidcEndpoints(env, identity);
  const fallbackHint = endpoints.discoveryError
    ? ` (discovery: ${endpoints.discoveryError}; задайте endpoint явно)`
    : '';
  const missing = (field: string): never => {
    throw new OidcError(501, 'identity_not_configured', `OIDC не настроен: нет ${field}${fallbackHint}`);
  };

  if (endpoints.tokenEndpointAuthMethods && !endpoints.tokenEndpointAuthMethods.includes(authMethod)) {
    // Metadata says the IdP does not accept the configured method: fail closed
    // rather than sending credentials in a form the IdP will reject.
    throw new OidcError(
      501,
      'identity_not_configured',
      `OIDC discovery: IdP не поддерживает tokenEndpointAuthMethod=${authMethod} (поддерживаются: ${endpoints.tokenEndpointAuthMethods.join(', ')})`,
    );
  }
  if (responseMode === 'form_post' && endpoints.responseModes && !endpoints.responseModes.includes('form_post')) {
    throw new OidcError(
      501,
      'identity_not_configured',
      'OIDC discovery: IdP не поддерживает response_mode=form_post (response_modes_supported не содержит form_post)',
    );
  }

  let authorizationEndpoint: URL | undefined;
  let tokenEndpoint: URL | undefined;
  if (purpose === 'login') {
    const authorizationUrl = endpoints.authorizationEndpoint?.trim();
    if (!authorizationUrl) missing('authorizationEndpoint');
    const tokenUrl = endpoints.tokenEndpoint?.trim();
    if (!tokenUrl) missing('tokenEndpoint');
    authorizationEndpoint = requireExternal(env, authorizationUrl as string, 'authorizationEndpoint');
    tokenEndpoint = requireExternal(env, tokenUrl as string, 'tokenEndpoint');
  }
  let endSessionEndpoint: URL | undefined;
  const rawEndSession = endpoints.endSessionEndpoint?.trim();
  if (rawEndSession) {
    endSessionEndpoint = requireExternal(env, rawEndSession, 'endSessionEndpoint');
  } else if (purpose === 'logout') {
    missing('endSessionEndpoint');
  }
  return {
    ...(authorizationEndpoint ? { authorizationEndpoint } : {}),
    ...(tokenEndpoint ? { tokenEndpoint } : {}),
    clientId: identity.clientId.trim(),
    clientSecretEnv,
    redirectUri: parseRedirectUri(env, identity.redirectUri),
    scopes: normalizedScopes(config),
    tokenEndpointAuthMethod: authMethod,
    responseMode,
    ...(endSessionEndpoint ? { endSessionEndpoint } : {}),
    postLogoutRedirectUri: oidcPostLogoutRedirectUri(env, config),
    discoveryEnabled: endpoints.discoveryEnabled,
    ...(endpoints.discoveryError ? { discoveryError: endpoints.discoveryError } : {}),
  };
}

/** Default post-login target: the bundled dashboard. */
export function oidcDefaultReturnTo(env: Env): string {
  return `${env.publicOrigin}${DEFAULT_RETURN_PATH}`;
}

function canonicalPublicOrigin(env: Env): string | null {
  try {
    return new URL(env.publicOrigin).origin;
  } catch {
    return null; // operator misconfiguration: fail closed instead of guessing
  }
}

/**
 * Characters that make the WHATWG URL parser reinterpret a relative path.
 * For special schemes `\` is treated like `/`, so `/\evil.example` resolves to
 * another origin; control characters can be stripped/normalised by proxies and
 * browsers. Both are rejected before parsing (defence in depth).
 */
const RETURN_TO_FORBIDDEN_CHAR_RE = /[\u0000-\u001f\u007f-\u009f\\]/;

/**
 * Validates `returnTo` (open-redirect guard). Relative paths are resolved
 * against `AGIL_PUBLIC_ORIGIN` **and must keep that exact origin**; absolute
 * URLs must be the public origin or an entry of
 * `integrations.allowedOrigins`. Backslashes/control characters are rejected
 * before parsing, and credentials/fragments are never allowed. Fragments are
 * stripped (the SSO token fragment is appended later, exactly once).
 */
export function resolveOidcReturnTo(env: Env, config: TenantConfig, raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return oidcDefaultReturnTo(env);
  if (value.length > MAX_RETURN_TO_LENGTH) {
    throw new OidcError(400, 'validation_failed', 'returnTo слишком длинный');
  }
  if (RETURN_TO_FORBIDDEN_CHAR_RE.test(value)) {
    throw new OidcError(400, 'validation_failed', 'returnTo: обратные слэши и управляющие символы запрещены');
  }
  const finish = (url: URL): string => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new OidcError(400, 'validation_failed', 'returnTo: http(s) is required');
    }
    if (url.username || url.password) {
      throw new OidcError(400, 'validation_failed', 'returnTo must not contain credentials');
    }
    url.hash = '';
    return url.toString();
  };
  const origin = canonicalPublicOrigin(env);
  function rejectOrigin(): never {
    throw new OidcError(400, 'validation_failed', 'returnTo: origin is not allowed');
  }
  if (value.startsWith('/')) {
    // Resolve first, then compare the *resolved* origin: a parser-normalised
    // path (e.g. `//host` style input) must never leave the public origin.
    if (value.startsWith('//')) rejectOrigin();
    if (!origin) rejectOrigin();
    let resolved: URL;
    try {
      resolved = new URL(value, env.publicOrigin);
    } catch {
      throw new OidcError(400, 'validation_failed', 'returnTo: URL is malformed');
    }
    if (resolved.origin !== origin) rejectOrigin();
    return finish(resolved);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OidcError(400, 'validation_failed', 'returnTo: URL is malformed');
  }
  const allowed = new Set<string>();
  if (!origin) rejectOrigin();
  allowed.add(origin);
  for (const allowedOrigin of config.integrations.allowedOrigins) {
    try {
      const parsed = new URL(allowedOrigin.trim());
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') allowed.add(parsed.origin);
    } catch {
      /* wildcard/invalid entries are not usable as a redirect target */
    }
  }
  if (!allowed.has(url.origin)) rejectOrigin();
  return finish(url);
}

function prunePending(now: number): void {
  for (const [state, entry] of pending) {
    // Keep entries for one extra TTL so an expired state can still be reported
    // as `state_expired` instead of the generic `state_invalid`.
    if (entry.expiresAt + (entry.expiresAt - entry.createdAt) < now) pending.delete(state);
  }
}

function makeRoom(now: number): void {
  prunePending(now);
  if (pending.size < MAX_PENDING) return;
  // Drop the oldest entry (Map preserves insertion order).
  const oldest = pending.keys().next().value;
  if (typeof oldest === 'string') pending.delete(oldest);
}

export interface StartedOidcAuthorization {
  authorizationUrl: string;
  expiresAt: number;
  /**
   * Raw browser-binding cookie value when the flow was bound. The handler must
   * send it as {@link oidcBindingCookieHeader}; it is never logged.
   */
  browserBinding?: string;
  /** Cookie SameSite policy: `None` for cross-site `form_post` responses. */
  bindingSameSite?: 'Lax' | 'None';
}

export interface StartOidcAuthorizationOptions {
  /** Bind the state to a browser cookie (same-origin starts). */
  bindBrowser?: boolean;
  /** Request `Host`; binding is skipped when the redirect URI uses another host. */
  requestHost?: string;
}

/**
 * Creates state/nonce/PKCE (and a browser binding when requested) and returns
 * the IdP authorization URL. Async because endpoints may come from discovery.
 */
export async function startOidcAuthorization(
  env: Env,
  config: TenantConfig,
  tenantId: string,
  rawReturnTo?: string,
  options: StartOidcAuthorizationOptions = {},
): Promise<StartedOidcAuthorization> {
  const flow = await resolveOidcFlowConfig(env, config, 'login');
  const returnTo = resolveOidcReturnTo(env, config, rawReturnTo);
  const now = Date.now();
  makeRoom(now);

  const state = randomToken(32);
  const nonce = randomToken(32);
  // 48 random bytes -> 64 base64url chars (RFC 7636 allows 43..128).
  const verifier = randomToken(48);
  const ttlMs = Math.max(1, env.oidcStateTtlSec) * 1000;
  const expiresAt = now + ttlMs;
  // Only bind when the browser will store the cookie for the callback host: the
  // start response and the redirect URI must share an origin host. Cross-origin
  // dashboards therefore keep state/nonce/PKCE but no login-CSRF binding.
  let browserBinding: string | undefined;
  if (options.bindBrowser) {
    try {
      const redirectHost = new URL(flow.redirectUri).host.toLowerCase();
      const requestHost = (options.requestHost ?? redirectHost).toLowerCase();
      if (redirectHost === requestHost) browserBinding = randomToken(32);
    } catch {
      /* malformed redirect URI was rejected above; do not bind */
    }
  }
  pending.set(state, {
    state,
    tenantId,
    returnTo,
    nonce,
    verifier,
    createdAt: now,
    expiresAt,
    ...(browserBinding ? { bindingHash: bindingHash(browserBinding) } : {}),
  });

  const url = new URL((flow.authorizationEndpoint as URL).toString());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', flow.clientId);
  url.searchParams.set('redirect_uri', flow.redirectUri);
  url.searchParams.set('scope', flow.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', pkceChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  if (flow.responseMode === 'form_post') url.searchParams.set('response_mode', 'form_post');
  return {
    authorizationUrl: url.toString(),
    expiresAt,
    ...(browserBinding ? { browserBinding } : {}),
    ...(browserBinding && flow.responseMode === 'form_post' ? { bindingSameSite: 'None' as const } : {}),
  };
}

/**
 * Consumes a pending authorization (single use). Throws 400 `state_invalid` /
 * `state_expired`; the entry is removed even when it turns out to be expired or
 * its browser binding is missing/mismatched, so a replayed callback can never
 * succeed.
 */
export function takePendingOidcAuthorization(state: string | undefined, binding?: string): PendingAuthorization {
  const key = typeof state === 'string' ? state.trim() : '';
  if (!key || key.length > 512) throw new OidcStateError('state_invalid', 'Некорректный state');
  const entry = pending.get(key);
  if (!entry) {
    throw new OidcStateError('state_invalid', 'Состояние входа не найдено или уже использовано');
  }
  // Consume before any further check: a failed binding must burn the state.
  pending.delete(key);
  if (Date.now() > entry.expiresAt) {
    throw new OidcStateError('state_expired', 'Время входа истекло, начните вход заново', entry.returnTo);
  }
  if (entry.bindingHash) {
    const provided = typeof binding === 'string' ? binding.trim() : '';
    const actual = provided ? Buffer.from(bindingHash(provided), 'hex') : Buffer.alloc(0);
    const expected = Buffer.from(entry.bindingHash, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new OidcStateError('state_invalid', 'Вход открыт в другом браузере или cookie входа потеряна', entry.returnTo);
    }
  }
  return entry;
}

export interface OidcTokenExchangeResult {
  /** Signature-verified later by {@link completeOidcLogin}; never logged. */
  idToken: string;
}

/**
 * Exchanges an authorization code at the IdP token endpoint (PKCE verifier +
 * `client_secret_post` or `client_secret_basic`). The client secret is read from
 * the server-owned allowlist snapshot (`env.oidcClientSecrets`, keys restricted
 * to `AGIL_OIDC_CLIENT_SECRET[_*]`), only when the name is bound to this tenant,
 * and is never logged (neither in the body nor in the Authorization header).
 */
export async function exchangeOidcCode(
  env: Env,
  config: TenantConfig,
  entry: PendingAuthorization,
  code: string | undefined,
): Promise<OidcTokenExchangeResult> {
  const flow = await resolveOidcFlowConfig(env, config, 'login');
  const value = typeof code === 'string' ? code.trim() : '';
  if (!value || value.length > 4096) {
    throw new OidcError(400, 'validation_failed', 'Некорректный authorization code');
  }
  // Never `process.env[name]`: the tenant only selects a key from the
  // server-owned namespace snapshot taken at startup.
  const clientSecret = flow.clientSecretEnv ? env.oidcClientSecrets[flow.clientSecretEnv] : undefined;
  if (!clientSecret) {
    throw new OidcError(
      501,
      'identity_not_configured',
      `Секрет OIDC-клиента не задан (переменная окружения ${flow.clientSecretEnv || 'clientSecretEnv'})`,
    );
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: value,
    redirect_uri: flow.redirectUri,
    code_verifier: entry.verifier,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if (flow.tokenEndpointAuthMethod === 'client_secret_basic') {
    // RFC 6749 §2.3.1: form-urlencode both values before joining/base64, so a
    // `:`/`+`/`%`/space in the credentials cannot corrupt the header.
    const basicPart = (value: string): string => new URLSearchParams({ v: value }).toString().slice(2);
    const credentials = `${basicPart(flow.clientId)}:${basicPart(clientSecret)}`;
    headers.authorization = `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
  } else {
    body.set('client_id', flow.clientId);
    body.set('client_secret', clientSecret);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OIDC_EXCHANGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(flow.tokenEndpoint as URL, {
      method: 'POST',
      headers,
      body: body.toString(),
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (error) {
    const message = (error as Error).name === 'AbortError' ? 'Token endpoint timeout' : 'Token endpoint недоступен';
    throw new OidcError(502, 'idp_error', message);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    // Never surface the IdP response body (it may contain tokens or PII).
    throw new OidcError(502, 'idp_error', `Token endpoint вернул HTTP ${response.status}`);
  }
  let payload: { id_token?: unknown; access_token?: unknown };
  try {
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > 64 * 1024) {
      throw new OidcError(502, 'idp_error', 'Token endpoint вернул слишком большой ответ');
    }
    const text = await response.text();
    if (text.length > 64 * 1024) {
      throw new OidcError(502, 'idp_error', 'Token endpoint вернул слишком большой ответ');
    }
    payload = JSON.parse(text) as typeof payload;
  } catch (error) {
    if (error instanceof OidcError) throw error;
    throw new OidcError(502, 'idp_error', 'Token endpoint вернул некорректный JSON');
  }
  if (typeof payload.id_token !== 'string' || payload.id_token.length === 0) {
    throw new OidcError(502, 'idp_error', 'IdP не вернул id_token');
  }
  if (payload.id_token.length > 16384) {
    throw new OidcError(502, 'idp_error', 'IdP вернул слишком большой id_token');
  }
  // The access token (if any) is dropped here: this server never calls a
  // resource API on the user's behalf, so it must not be retained.
  return { idToken: payload.id_token };
}

export interface CompletedOidcLogin {
  session: IssuedAdminSession;
  tenantId: string;
  returnTo: string;
  user: { id: string; name: string };
}

/**
 * Verifies the id_token (JWKS, nonce, tenant/email policy) and mints the admin
 * session. Rejects an identity the IdP explicitly marks unverified
 * (`verifiedClaim: false`) and identities outside `dashboardAdminGroups`.
 */
export async function completeOidcLogin(
  env: Env,
  config: TenantConfig,
  entry: PendingAuthorization,
  idToken: string,
): Promise<CompletedOidcLogin> {
  const identity = config.integrations.identity;
  // The pending entry names the tenant; the config was loaded from it. Keep the
  // explicit check so a future refactor cannot mint a session for a mismatch.
  if (config.tenantId !== entry.tenantId) {
    throw new OidcError(403, 'tenant_mismatch', 'Конфигурация входа не совпадает с организацией сессии');
  }
  let verified: Awaited<ReturnType<typeof verifyOidcToken>>;
  try {
    verified = await verifyOidcToken(env, config, idToken, {
      nonce: entry.nonce,
      audiences: [identity.clientId.trim()].filter(Boolean),
    });
  } catch (error) {
    if (error instanceof OidcError) throw error;
    throw new OidcError(502, 'idp_error', 'Не удалось проверить id_token');
  }
  // Absent claim = no opinion; an explicit false (boolean/string/number) is a
  // denial. The verifier normalizes it for joins; keep the dashboard strict too.
  const verifiedClaim = identity.verifiedClaim ? verified.claims[identity.verifiedClaim] : undefined;
  if (verifiedClaim === false || verifiedClaim === 'false' || verifiedClaim === 0) {
    throw new OidcError(403, 'identity_not_verified', 'Корпоративная идентичность не подтверждена');
  }
  // Restrict dashboard admin access to IdP groups when configured. Empty list
  // keeps the contract: any identity authenticated by the client.
  const adminGroups = Array.isArray(identity.dashboardAdminGroups) ? identity.dashboardAdminGroups : [];
  if (adminGroups.length > 0 && !adminGroups.some((group) => verified.groups.includes(group))) {
    throw new OidcError(403, 'identity_not_allowed', 'Учётная запись не входит в разрешённую группу администраторов');
  }
  const session = signAdminSession(env, {
    sub: verified.identity.userId,
    name: verified.identity.name,
    tenantId: entry.tenantId,
  });
  return {
    session,
    tenantId: entry.tenantId,
    returnTo: entry.returnTo,
    user: { id: verified.identity.userId, name: verified.identity.name },
  };
}

/** Builds the post-login redirect target (token in the fragment only). */
export function ssoRedirectUrl(returnTo: string, token: string): string {
  const base = returnTo.split('#')[0] ?? returnTo;
  return `${base}#sso_token=${encodeURIComponent(token)}`;
}

/** Builds the post-login error redirect target (stable code, no details). */
export function ssoErrorRedirectUrl(returnTo: string, code: string): string {
  const base = returnTo.split('#')[0] ?? returnTo;
  return `${base}#sso_error=${encodeURIComponent(code)}`;
}

/* ----------------------- RP-initiated logout ---------------------------- */

function prunePendingLogouts(now: number): void {
  for (const [state, entry] of pendingLogouts) {
    if (entry.expiresAt + (entry.expiresAt - entry.createdAt) < now) pendingLogouts.delete(state);
  }
}

function makeLogoutRoom(now: number): void {
  prunePendingLogouts(now);
  if (pendingLogouts.size < MAX_PENDING_LOGOUTS) return;
  const oldest = pendingLogouts.keys().next().value;
  if (typeof oldest === 'string') pendingLogouts.delete(oldest);
}

export interface StartedOidcLogout {
  /** IdP RP-initiated logout URL; the browser is expected to navigate there. */
  logoutUrl: string;
  expiresAt: number;
}

/**
 * Builds the RP-initiated logout URL (`end_session_endpoint` +
 * `post_logout_redirect_uri` + single-use `state`) and stores the pending
 * `state` → dashboard `returnTo` mapping in memory.
 *
 * The `id_token_hint` is deliberately not sent: this server never retains the
 * IdP id_token (it is dropped after verification). OIDC RPs may omit it and
 * identify the client/session by `client_id` + registered
 * `post_logout_redirect_uri`; IdPs that *require* `id_token_hint` need a
 * staging-specific follow-up (documented in docs/sso-oidc.md).
 *
 * Throws 501 `identity_not_configured` when no `end_session_endpoint` is
 * configured (explicit field or discovery).
 */
export async function startOidcLogout(
  env: Env,
  config: TenantConfig,
  tenantId: string,
  rawReturnTo?: string,
): Promise<StartedOidcLogout> {
  const flow = await resolveOidcFlowConfig(env, config, 'logout');
  if (!flow.endSessionEndpoint) {
    throw new OidcError(501, 'identity_not_configured', 'RP-initiated logout не настроен: укажите endSessionEndpoint');
  }
  const returnTo = resolveOidcReturnTo(env, config, rawReturnTo);
  const now = Date.now();
  makeLogoutRoom(now);
  const state = randomToken(32);
  const ttlMs = Math.max(1, env.oidcStateTtlSec) * 1000;
  const expiresAt = now + ttlMs;
  pendingLogouts.set(state, { tenantId, returnTo, createdAt: now, expiresAt });

  const url = new URL(flow.endSessionEndpoint.toString());
  url.searchParams.set('client_id', flow.clientId);
  url.searchParams.set('post_logout_redirect_uri', flow.postLogoutRedirectUri);
  url.searchParams.set('state', state);
  return { logoutUrl: url.toString(), expiresAt };
}

/**
 * Consumes a pending RP-initiated logout state (single use, TTL bounded).
 * Throws `state_invalid`/`state_expired`; the entry is removed even when it
 * turns out to be expired or malformed.
 */
export function takePendingOidcLogout(state: string | undefined): PendingLogout {
  const key = typeof state === 'string' ? state.trim() : '';
  if (!key || key.length > 512) throw new OidcStateError('state_invalid', 'Некорректный state выхода');
  const entry = pendingLogouts.get(key);
  if (!entry) throw new OidcStateError('state_invalid', 'Состояние выхода не найдено или уже использовано');
  pendingLogouts.delete(key);
  if (Date.now() > entry.expiresAt) {
    throw new OidcStateError('state_expired', 'Время выхода истекло', entry.returnTo);
  }
  return entry;
}
