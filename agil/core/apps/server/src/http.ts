/**
 * HTTP plumbing for the zero-dependency REST API: CORS, request ids, JSON/raw
 * body parsing with hard limits, a tiny pattern router and one central error
 * mapper that guarantees the `{error:{code,message}}` envelope.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { ZodError, ZodSchema } from 'zod';
import { isSecurityError, resolveClientIp, hashIp, countryFromHeaders } from '@agil/security';
import { verifyToken } from '@agil/protocol/token';
import type { ApiErrorBody, AuditEntry, TenantConfig } from '@agil/protocol';
import { resolveTenantApiKey } from './api-keys.js';
import { verifyAdminSession } from './admin-session.js';
import type { ClusterStore } from './cluster.js';
import { isIpAllowed } from './net-policy.js';
import type { Env } from './env.js';
import type { Logger } from './logger.js';
import type { AnalysisPipeline } from './analysis.js';
import { ProviderError } from './providers.js';
import { ChatStorageUnavailable } from './chat-history.js';
import type { ProviderRegistry } from './providers.js';
import type { RoomRegistry } from './rooms.js';
import type { RoutingService } from './routing.js';
import type { FlowService } from './flows.js';
import type { EgressStartLedger } from './egress-start-ledger.js';
import type { Services } from './services.js';
import type { TenantStore } from './tenants.js';
import { hostFromHeader, hostFromOrigin, type DomainRegistry } from './domains.js';

export const JSON_BODY_LIMIT = 1024 * 1024; // 1 MiB
export const FILE_BODY_LIMIT = 25 * 1024 * 1024; // 25 MiB (configurable per tenant)
export const RECORDING_BODY_LIMIT = 200 * 1024 * 1024; // 200 MiB
export const STT_BODY_LIMIT = 25 * 1024 * 1024; // 25 MiB
export const MAX_BODY_HARD_LIMIT = 512 * 1024 * 1024;

/** Error with an HTTP status + stable machine-readable code (contract §14). */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const SECURITY_STATUS: Record<string, number> = {
  password_required: 400,
  password_invalid: 401,
  geo_blocked: 403,
  rate_limited: 429,
  room_locked: 423,
  file_too_large: 413,
  payload_too_large: 413,
  unsupported_mime: 415,
  /** Antivirus verdict: the upload was rejected and quarantined (sync mode). */
  file_infected: 422,
  not_found: 404,
  stt_not_configured: 501,
  liveness_not_configured: 501,
  integrity_failed: 403,
};

/** Maps any thrown value to the API error envelope + HTTP status. */
export function toApiError(error: unknown): { status: number; code: string; message: string; details?: unknown } {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code, message: error.message, details: error.details };
  }
  if (isSecurityError(error)) {
    return {
      status: SECURITY_STATUS[error.code] ?? 400,
      code: error.code,
      message: error.message,
    };
  }
  const candidate = error as { name?: string; issues?: unknown; message?: string; code?: string };
  if (error instanceof ChatStorageUnavailable) {
    return { status: 503, code: 'chat_storage_unavailable', message: error.message };
  }
  if (error instanceof ProviderError) {
    const map: Record<string, { status: number; code: string }> = {
      provider_failed: { status: 502, code: 'provider_failed' },
      provider_unsupported: { status: 501, code: 'provider_unsupported' },
      provider_disabled: { status: 403, code: 'forbidden' },
      provider_not_configured: { status: 503, code: 'provider_not_configured' },
    };
    const mapped = map[error.code] ?? { status: 502, code: 'provider_failed' };
    return { status: mapped.status, code: mapped.code, message: error.message };
  }
  if (candidate && candidate.name === 'ConfigValidationError') {
    return {
      status: 400,
      code: 'validation_failed',
      message: 'Invalid tenant configuration',
      details: candidate.issues,
    };
  }
  if (candidate && candidate.name === 'RoomRegistryError') {
    if (candidate.code === 'room_exists') {
      return { status: 409, code: 'validation_failed', message: 'Room already exists' };
    }
    if (candidate.code === 'room_not_found') {
      return { status: 404, code: 'not_found', message: 'Room not found' };
    }
    return { status: 400, code: 'validation_failed', message: 'Invalid room id' };
  }
  if (candidate && Array.isArray(candidate.issues)) {
    return {
      status: 400,
      code: 'validation_failed',
      message: 'Validation failed',
      details: candidate.issues,
    };
  }
  return { status: 500, code: 'internal_error', message: 'Internal server error' };
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

export interface AppContext {
  env: Env;
  services: Services;
  tenants: TenantStore;
  /** Verified `Host` -> tenant mapping for white-label custom domains. */
  domains: DomainRegistry;
  rooms: RoomRegistry;
  continuity: import('./continuity.js').RoomContinuity;
  analysis: AnalysisPipeline;
  providers: ProviderRegistry;
  /** Cluster enrollment tokens + node/standby registry (file-backed). */
  cluster: ClusterStore;
  /** Routing baseline: tenant routes, Edge enrollment, egress evaluation. */
  routing: RoutingService;
  /** Generic media flows (`docs/flows.md`). */
  flows: FlowService;
  egressStarts: EgressStartLedger;
  logger: Logger;
  startedAt: number;
}

export interface RequestContext extends AppContext {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  /** Pathname without query string (percent-decoded). */
  path: string;
  url: URL;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: IncomingHttpHeaders;
  /** Bare, lowercase request host (no port); empty when the header is invalid. */
  host: string;
  /** Tenant resolved from a verified custom domain, or null for the default host. */
  hostTenantId: string | null;
  /** Remote/forwarded client IP (never logged raw). */
  ip: string;
  /** sha256(ip + salt) — the only form allowed in the audit log. */
  ipHash: string;
  /** Country from trusted proxy headers, when AGIL_TRUST_PROXY=1. */
  headerCountry?: string;
  requestId: string;
  /** Parses the JSON body (1 MiB limit, 400 on malformed input). */
  json<T = unknown>(): Promise<T>;
  /** Parses and validates the JSON body with a zod schema (400 on issues). */
  jsonSchema<T>(schema: ZodSchema<T>): Promise<T>;
  /** Reads the raw request body with an explicit byte limit. */
  raw(limitBytes: number, code?: string): Promise<Buffer>;
  /** Sends a JSON response. */
  send(status: number, body: unknown, headers?: Record<string, string>): void;
  /** Sends raw bytes (downloads). */
  sendRaw(status: number, data: Buffer, headers?: Record<string, string>): void;
  /** Sends the standard error envelope. */
  sendError(status: number, code: string, message: string, details?: unknown): void;
}

/* ------------------------------------------------------------------ */
/* Body parsing                                                        */
/* ------------------------------------------------------------------ */

function readBody(req: IncomingMessage, limitBytes: number, limitCode = 'file_too_large'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    // For absurdly large declared bodies answer early; the socket is closed by the
    // caller. Normal overflow drains first so the client can read the 413 instead
    // of seeing a connection reset mid-upload.
    if (Number.isFinite(declared) && declared > limitBytes * 4) {
      req.resume();
      reject(new HttpError(413, limitCode, `Request body exceeds ${limitBytes} bytes`));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let oversized = false;
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > limitBytes) {
        oversized = true;
        chunks.length = 0;
        // Keep draining (without buffering) so the response reaches the client.
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (oversized) {
        finish(new HttpError(413, limitCode, `Request body exceeds ${limitBytes} bytes`));
        return;
      }
      finish();
    };
    const onError = (error: Error): void => finish(error);
    const onAborted = (): void => finish(new HttpError(400, 'validation_failed', 'Request aborted'));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

export function zodErrorMessage(error: ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Validation failed';
  const path = first.path.join('.');
  return path ? `${path}: ${first.message}` : first.message;
}

/**
 * Masks phone-like URL segments in request logs. The SIP stop route carries the
 * participant identity in the path, and a phone-like id must never reach logs,
 * even when the request itself is rejected or rate-limited.
 */
export function redactPhoneLikePath(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        /* malformed escapes are logged as-is (still redacted below) */
      }
      // digits-only / E.164 / prefixed `sip_7999...` identity, mirroring
      // `isPhoneLikeIdentity` in sip.ts without importing it (avoid a cycle).
      if (!/(?:^|[_-])\+?\d[\d\s().-]{5,}\d$/.test(decoded)) return segment;
      return decoded.replace(/\d/g, '•');
    })
    .join('/');
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

export type Handler = (ctx: RequestContext) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export interface Router {
  get(pattern: string, handler: Handler): Router;
  head(pattern: string, handler: Handler): Router;
  post(pattern: string, handler: Handler): Router;
  put(pattern: string, handler: Handler): Router;
  patch(pattern: string, handler: Handler): Router;
  delete(pattern: string, handler: Handler): Router;
  handle(ctx: RequestContext): Promise<boolean>;
}

function splitPath(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

function matchRoute(route: Route, segments: string[]): Record<string, string> | null {
  if (route.segments.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < route.segments.length; index += 1) {
    const expected = route.segments[index] as string;
    const actual = segments[index] as string;
    if (expected.startsWith(':')) {
      if (!actual) return null;
      params[expected.slice(1)] = actual;
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

export function createRouter(): Router {
  const routes: Route[] = [];
  const add = (method: string, pattern: string, handler: Handler): Router => {
    routes.push({ method, segments: splitPath(pattern), handler });
    return router;
  };
  const router: Router = {
    get: (pattern, handler) => add('GET', pattern, handler),
    // HEAD is explicit (not implied by GET): only routes that can answer with
    // headers alone opt in, so a HEAD probe never triggers a GET side effect.
    head: (pattern, handler) => add('HEAD', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    put: (pattern, handler) => add('PUT', pattern, handler),
    patch: (pattern, handler) => add('PATCH', pattern, handler),
    delete: (pattern, handler) => add('DELETE', pattern, handler),
    async handle(ctx) {
      const segments = splitPath(ctx.path);
      for (const route of routes) {
        if (route.method !== ctx.method) continue;
        const params = matchRoute(route, segments);
        if (!params) continue;
        ctx.params = params;
        // Standby Cores are read-only: every admin mutation (tenant config,
        // rooms, tokens, nodes, docs, domains, keys, …) is leader-only. It is
        // checked before the handler so no standby can persist local state.
        if (route.method !== 'GET' && route.method !== 'HEAD' && isAdminPath(ctx.path)) {
          ctx.cluster.assertLeader('admin mutations');
        }
        await route.handler(ctx);
        return true;
      }
      return false;
    },
  };
  return router;
}

/* ------------------------------------------------------------------ */
/* Request handler                                                     */
/* ------------------------------------------------------------------ */

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers':
    'content-type, x-api-key, authorization, x-node-token, x-file-name, x-recording-meta, x-language, x-request-id, x-agil-country, x-tenant-id, idempotency-key',
  'access-control-expose-headers': 'x-request-id, retry-after',
  'access-control-max-age': '600',
};

/** Baseline browser-security headers applied to every response. */
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'SAMEORIGIN',
  'permissions-policy': 'camera=(self), microphone=(self), geolocation=(self)',
  'cross-origin-opener-policy': 'same-origin',
};

function frameAncestors(allowedOrigins: readonly string[], openByDefault: boolean): string {
  const list = allowedOrigins.map((origin) => origin.trim()).filter((origin) => origin.length > 0);
  if (list.length === 0) return openByDefault ? 'frame-ancestors *' : "frame-ancestors 'self'";
  return `frame-ancestors 'self' ${list.join(' ')}`;
}

/**
 * Request host used for tenant resolution. Behind a trusted proxy an explicit
 * `x-forwarded-host` wins (some proxies rewrite `Host` to the upstream socket);
 * otherwise the raw `Host` header is used. Invalid values resolve to `''`.
 */
export function requestHost(headers: IncomingHttpHeaders, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = hostFromHeader(headers['x-forwarded-host'], { list: true });
    if (forwarded) return forwarded;
  }
  return hostFromHeader(headers.host);
}

/**
 * Tenant used for CORS/frame/policy: from the API key, the join token, the
 * `/v1/tenants/:id/...` path segment, a verified custom domain (`Host`), or the
 * default tenant, in that order. Credentials always win over the host so an
 * admin acting on tenant A through tenant B's domain cannot be re-scoped.
 */
function policyTenant(
  ctx: AppContext,
  url: URL,
  headers: IncomingHttpHeaders,
): TenantConfig | null {
  try {
    if (/\/embed\.html$/i.test(url.pathname)) {
      const roomId = url.searchParams.get('room');
      const room = roomId ? ctx.rooms.get(roomId) : undefined;
      if (room) return ctx.tenants.getConfig(room.tenantId);

      const token = url.searchParams.get('token');
      if (token) {
        const verified = verifyToken(token, ctx.env.tokenSecret);
        if (verified.valid && (!roomId || roomId === verified.claims.roomId)) {
          return ctx.tenants.getConfig(verified.claims.tenantId);
        }
      }

      const tenantId = url.searchParams.get('tenant');
      if (tenantId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(tenantId)) {
        const config = ctx.tenants.peekConfig(tenantId);
        if (config) return config;
      }
    }
    const apiKey = typeof headers['x-api-key'] === 'string' ? headers['x-api-key'] : undefined;
    if (apiKey) {
      const tenantId = resolveTenantApiKey(ctx.env, apiKey);
      if (tenantId) return ctx.tenants.getConfig(tenantId);
    }
    const authorization = typeof headers.authorization === 'string' ? headers.authorization : '';
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) {
      const raw = match[1].trim();
      // Dashboard SSO sessions are tenant-scoped admin credentials; they must
      // resolve the same CORS/frame policy as the tenant's API key.
      const session = verifyAdminSession(ctx.env, raw);
      if (session.valid) return ctx.tenants.getConfig(session.claims.tenantId);
      const verified = verifyToken(raw, ctx.env.tokenSecret);
      if (verified.valid) return ctx.tenants.getConfig(verified.claims.tenantId);
    }
    const tenantMatch = /^\/v1\/tenants\/([^/]+)\//.exec(url.pathname);
    if (tenantMatch?.[1]) return ctx.tenants.getConfig(decodeURIComponent(tenantMatch[1]));
    const hostRecord = ctx.domains.resolveHost(requestHost(headers, ctx.env.trustProxy));
    if (hostRecord) return ctx.tenants.getConfig(hostRecord.tenantId);
  } catch {
    /* fall through to the default tenant */
  }
  return ctx.tenants.getConfig(ctx.env.defaultTenantId);
}

/** Public origin for links: the verified custom domain when the request came
 * through it and the linked tenant matches, otherwise `AGIL_PUBLIC_ORIGIN`. */
export function requestOrigin(ctx: RequestContext, tenantId?: string): string {
  if (ctx.hostTenantId && (!tenantId || tenantId === ctx.hostTenantId)) {
    const record = ctx.domains.getForTenant(ctx.hostTenantId);
    if (record && record.status === 'verified') {
      const forwarded = typeof ctx.headers['x-forwarded-proto'] === 'string' ? ctx.headers['x-forwarded-proto'].trim().toLowerCase() : '';
      const scheme = ctx.env.trustProxy && (forwarded === 'http' || forwarded === 'https') ? forwarded : 'https';
      return `${scheme}://${record.domain}`;
    }
  }
  return ctx.env.publicOrigin;
}

function applyCors(
  res: ServerResponse,
  originHeader: string | undefined,
  config: TenantConfig | null,
  isAdmin = false,
): void {
  const allowlist = (config?.integrations.allowedOrigins ?? []).map((origin) => origin.trim()).filter(Boolean);
  res.setHeader('vary', 'origin');
  if (isAdmin) {
    // The admin surface never gets a wildcard CORS grant: only an explicit
    // tenant origin allowlist entry opens it to a browser dashboard.
    if (originHeader && allowlist.includes(originHeader)) {
      res.setHeader('access-control-allow-origin', originHeader);
    }
  } else if (allowlist.length === 0) {
    // Demo default for the public call surface: any origin, no credentials.
    res.setHeader('access-control-allow-origin', '*');
  } else if (originHeader && (allowlist.includes(originHeader) || allowlist.includes('*'))) {
    res.setHeader('access-control-allow-origin', originHeader);
  }
  for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
}

/**
 * HSTS value for a response, or `''` when the header is disabled
 * (`AGIL_HSTS_MAX_AGE_SEC=0`).
 *
 * `includeSubDomains` is a one-way commitment that applies to every subdomain
 * of the host, so it is emitted only for the platform's own host(s)
 * (`AGIL_PUBLIC_ORIGIN` / `AGIL_DOMAIN_TARGET`). A customer host gets a plain
 * `max-age` unless `AGIL_HSTS_INCLUDE_SUBDOMAINS_CUSTOM=1` opts in.
 */
export function hstsHeaderValue(env: Env, host: string): string {
  if (!(env.hstsMaxAgeSec > 0)) return '';
  const platformHosts = new Set<string>([
    hostFromOrigin(env.publicOrigin, ''),
    hostFromHeader(env.domainTarget),
  ]);
  const normalized = hostFromHeader(host);
  const isPlatformHost = !normalized || platformHosts.has(normalized);
  const include = env.hstsIncludeSubDomains && (isPlatformHost || env.hstsIncludeSubDomainsCustom);
  return include ? `max-age=${env.hstsMaxAgeSec}; includeSubDomains` : `max-age=${env.hstsMaxAgeSec}`;
}

function applySecurityHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  env: Env,
  url: URL,
  config: TenantConfig | null,
): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
  const isEmbed = /\/embed\.html$/i.test(url.pathname);
  if (isEmbed) {
    // Embeds must be frameable by the tenant's allowed origins; COOP would break it.
    // CSP frame-ancestors is the authoritative policy; XFO would still block old
    // webviews, so it is dropped for /embed.html only.
    res.removeHeader('x-frame-options');
    res.removeHeader('cross-origin-opener-policy');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', frameAncestors(config?.integrations.allowedOrigins ?? [], !config || config.tenantId === env.defaultTenantId));
  } else if (/^\/(dashboard|editor)(?:\/|$)/i.test(url.pathname)) {
    res.setHeader('content-security-policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
  }
  if (env.trustProxy) {
    const hsts = hstsHeaderValue(env, requestHost(req.headers, env.trustProxy));
    if (hsts) res.setHeader('strict-transport-security', hsts);
  }
  void req;
}

export interface HttpHandlerOptions {
  ctx: AppContext;
  router: Router;
  /** Handles non-/v1 requests (static assets); returns true when a response was sent. */
  fallback?: (ctx: RequestContext) => Promise<boolean> | boolean;
  /** 'main' = API/WS/static; 'docs' = isolated docs/OpenAPI port. Defaults to 'main'. */
  surface?: 'main' | 'docs';
}

/** Paths owned by the documentation surface. */
export function isDocsPath(pathname: string): boolean {
  return (
    pathname === '/openapi.json' ||
    pathname === '/openapi.admin.json' ||
    pathname === '/docs' ||
    pathname === '/docs/' ||
    pathname.startsWith('/docs/')
  );
}

function isAdminPath(pathname: string): boolean {
  return pathname === '/v1/admin' || pathname.startsWith('/v1/admin/');
}

/**
 * Machine enrollment surface (docs/api/cluster.md §2): outside `/v1/admin`
 * (nodes have no admin key), optionally fenced by its own
 * `AGIL_ENROLL_ALLOW_IPS` allowlist.
 */
function isEnrollmentPath(pathname: string): boolean {
  return (
    pathname === '/v1/cluster/join' ||
    pathname === '/v1/nodes/register' ||
    pathname === '/v1/edge/join' ||
    /^\/v1\/nodes\/[^/]+\/heartbeat$/.test(pathname)
  );
}

/** Creates the `(req, res) => void` listener used by the HTTP server. */
export function createHttpHandler(options: HttpHandlerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const { ctx, router, fallback, surface = 'main' } = options;

  const buildContext = (req: IncomingMessage, res: ServerResponse, url: URL, requestId: string): RequestContext => {
    const ip = resolveClientIp({
      headers: req.headers as Record<string, string | string[] | undefined>,
      remoteAddress: req.socket.remoteAddress,
      trustProxy: ctx.env.trustProxy,
    });
    // The client-supplied country header is untrusted by default: only the
    // explicit opt-in (AGIL_GEO_HEADER_ALLOW=1) enables it; production must
    // derive the country from ipapi or the trusted edge.
    const headerCountry = ctx.env.geoHeaderAllow
      ? countryFromHeaders(req.headers as Record<string, string | string[] | undefined>)
      : undefined;
    const host = requestHost(req.headers, ctx.env.trustProxy);
    const hostRecord = ctx.domains.resolveHost(host);
    const base: AppContext = ctx;
    const request: RequestContext = {
      ...base,
      req,
      res,
      method: req.method ?? 'GET',
      path: url.pathname,
      url,
      query: url.searchParams,
      params: {},
      headers: req.headers,
      host,
      hostTenantId: hostRecord?.tenantId ?? null,
      ip,
      ipHash: hashIp(ip, ctx.env.ipSalt),
      headerCountry,
      requestId,
      async json<T>(): Promise<T> {
        const text = (await readBody(req, JSON_BODY_LIMIT, 'payload_too_large')).toString('utf8').trim();
        if (!text) return {} as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new HttpError(400, 'validation_failed', 'Malformed JSON body');
        }
      },
      async jsonSchema<T>(schema: ZodSchema<T>): Promise<T> {
        const body = await request.json();
        const result = schema.safeParse(body);
        if (!result.success) {
          throw new HttpError(400, 'validation_failed', zodErrorMessage(result.error), result.error.issues);
        }
        return result.data;
      },
      raw(limitBytes: number, code = 'file_too_large'): Promise<Buffer> {
        return readBody(req, Math.min(Math.max(1, limitBytes), MAX_BODY_HARD_LIMIT), code);
      },
      send(status: number, body: unknown, headers: Record<string, string> = {}): void {
        sendJson(res, status, body, headers);
      },
      sendRaw(status: number, data: Buffer, headers: Record<string, string> = {}): void {
        sendBuffer(res, status, data, headers);
      },
      sendError(status: number, code: string, message: string, details?: unknown): void {
        const body: ApiErrorBody = details === undefined ? { error: { code, message } } : { error: { code, message, details } };
        sendJson(res, status, body);
      },
    };
    return request;
  };

  return (req: IncomingMessage, res: ServerResponse): void => {
    const requestId = typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].trim().length > 0
      ? req.headers['x-request-id'].trim().slice(0, 128)
      : randomUUID();
    res.setHeader('x-request-id', requestId);

    let url: URL;
    try {
      const rawHost = typeof req.headers.host === 'string' ? req.headers.host.trim() : '';
      // An invalid Host must not turn every request into a 400: fall back to a
      // local base and let tenant resolution use the default tenant.
      const urlBase = hostFromHeader(rawHost) ? rawHost : 'localhost';
      url = new URL(req.url ?? '/', `http://${urlBase}`);
    } catch {
      applySecurityHeaders(req, res, ctx.env, new URL('http://localhost/'), null);
      sendJson(res, 400, { error: { code: 'validation_failed', message: 'Invalid request URL' } });
      return;
    }

    const policyConfig = policyTenant(ctx, url, req.headers);
    applySecurityHeaders(req, res, ctx.env, url, policyConfig);
    applyCors(res, typeof req.headers.origin === 'string' ? req.headers.origin : undefined, policyConfig, url.pathname.startsWith('/v1/admin'));

    if ((req.method ?? 'GET').toUpperCase() === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const request = buildContext(req, res, url, requestId);

    // ---- surface gating (docs / admin API exposure, §24 / docs/api-exposure.md)
    const docsSurfaceAvailable = ctx.env.docsEnabled && (surface === 'docs' || ctx.env.docsPort === 0);
    if (isDocsPath(url.pathname)) {
      const allowed = docsSurfaceAvailable && isIpAllowed(request.ip, ctx.env.docsAllowIps);
      if (!allowed) {
        // Disabled docs are indistinguishable from unknown paths (no surface leak).
        request.sendError(404, 'not_found', 'Not found');
        return;
      }
      const decision = ctx.services.limiters.docs.check(`docs:${request.ipHash}`);
      if (!decision.allowed) {
        request.sendError(429, 'rate_limited', 'Too many documentation requests');
        return;
      }
    } else if (surface === 'docs') {
      // The docs port serves documentation only.
      request.sendError(404, 'not_found', 'Not found');
      return;
    } else if (isAdminPath(url.pathname)) {
      if (!ctx.env.adminApiEnabled) {
        request.sendError(404, 'not_found', 'Not found');
        return;
      }
      if (!isIpAllowed(request.ip, ctx.env.adminAllowIps)) {
        request.sendError(403, 'forbidden', 'Admin API is not available from this network');
        return;
      }
    } else if (isEnrollmentPath(url.pathname) && !isIpAllowed(request.ip, ctx.env.enrollAllowIps)) {
      // The enrollment surface has its own optional allowlist; it is not
      // controlled by AGIL_ADMIN_* because nodes never hold an admin key.
      request.sendError(403, 'forbidden', 'Enrollment API is not available from this network');
      return;
    }

    const fail = (error: unknown): void => {
      const mapped = toApiError(error);
      // Client mistakes and expected degradation paths must not pollute error logs
      // (monitoring alerting is based on ERROR lines).
      const expectedCodes = new Set([
        'assistant_local_only',
        'knowledge_not_configured',
        'identity_not_configured',
        'stt_not_configured',
        'liveness_not_configured',
        'provider_failed',
        'provider_unsupported',
        'provider_disabled',
        'rate_limited',
        'validation_failed',
        'feature_disabled',
        'password_required',
        'password_invalid',
        'geo_blocked',
        'room_locked',
        'room_full',
        'not_found',
        'forbidden',
        'unauthorized',
      ]);
      if (mapped.status >= 500 && !expectedCodes.has(mapped.code)) {
        ctx.logger.error(`request failed: ${req.method} ${redactPhoneLikePath(url.pathname)}`, {
          requestId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      } else if (mapped.status >= 500 || mapped.status === 429) {
        ctx.logger.warn(`request degraded: ${req.method} ${redactPhoneLikePath(url.pathname)}`, {
          requestId,
          status: mapped.status,
          code: mapped.code,
          message: mapped.message,
        });
      }
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, mapped.status, {
        error: { code: mapped.code, message: mapped.message, ...(mapped.details !== undefined ? { details: mapped.details } : {}) },
      });
    };

    void (async () => {
      try {
        const handled = await router.handle(request);
        if (handled) return;
        if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) {
          request.sendError(404, 'not_found', `No route for ${req.method} ${url.pathname}`);
          return;
        }
        if (fallback && (await fallback(request))) return;
        request.sendError(404, 'not_found', 'Not found');
      } catch (error) {
        fail(error);
      }
    })();
  };
}

/* ------------------------------------------------------------------ */
/* Response helpers                                                    */
/* ------------------------------------------------------------------ */

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.writableEnded) return;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', String(payload.length));
  res.setHeader('cache-control', 'no-store');
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(payload);
}

export function sendBuffer(res: ServerResponse, status: number, data: Buffer, headers: Record<string, string> = {}): void {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('content-length', String(data.length));
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(data);
}

/* ------------------------------------------------------------------ */
/* Misc helpers                                                        */
/* ------------------------------------------------------------------ */

/** Parses an integer query parameter with clamping; malformed -> fallback. */
export function intQuery(query: URLSearchParams, name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = query.get(name);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Audit append that must never break a request. */
export function safeAudit(
  logger: Logger,
  audit: { append(entry: Omit<AuditEntry, 'id' | 'ts'> & { ip?: string }): AuditEntry },
  entry: Omit<AuditEntry, 'id' | 'ts'> & { ip?: string },
): void {
  try {
    audit.append(entry);
  } catch (error) {
    logger.warn('audit append failed', { error: error instanceof Error ? error.message : String(error) });
  }
}
