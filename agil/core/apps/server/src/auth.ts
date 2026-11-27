/**
 * Authentication & authorisation helpers shared by the REST handlers.
 *
 * Four credentials, each accepted only on its own surface:
 *  - `x-api-key`    — tenant admin key (config, admin API, room creation);
 *  - join token     — HS256 JWT from `/join` (or an invite), used by the WS and
 *                     by the participant file/recording/STT APIs;
 *  - signed URL     — `?sig=&exp=` HMAC produced by @agil/security stores;
 *  - admin session  — HS256 JWT from the dashboard OIDC login, accepted by
 *                     *tenant* admin endpoints only, never by the platform
 *                     surface or the WS.
 *
 * Tenant-scoped checks compare the credential's tenant with the resource tenant
 * and answer 403 (never leaks whether the other tenant's room exists).
 */
import type { IncomingHttpHeaders } from 'node:http';
import {
  isFeatureAllowed,
  resolveAccess,
  resolveKnowledgeAgentAccess,
  type AccessResolution,
  type FeatureKey,
  type KnowledgeAgentAccess,
  type Role,
  type TenantConfig,
} from '@agil/protocol';
import { signToken, verifyToken, type TokenClaims } from '@agil/protocol/token';
import { hashIp, headerValue, resolveClientIp, countryFromHeaders, type HeaderMap } from '@agil/security';
import type { Env } from './env.js';
import { resolveTenantApiKey } from './api-keys.js';
import { verifyAdminSession, type AdminSessionClaims } from './admin-session.js';
import { HttpError } from './http.js';

export type { TokenClaims };

export interface IssuedToken {
  token: string;
  expiresAt: number;
}

export interface IssueTokenInput {
  participantId: string;
  name: string;
  role: Role;
  tenantId: string;
  roomId: string;
  ttlSec?: number;
  /** Pin an exact feature list (token issuer decides). Empty/undefined = role defaults. */
  permissions?: FeatureKey[];
  /** Company-defined custom role id (resolved server-side on join/WS). */
  roleId?: string;
}

/* ------------------------------------------------------------------ */
/* Effective permissions (protocol §18)                                */
/* ------------------------------------------------------------------ */

export interface AccessInput {
  config: TenantConfig;
  role: Role;
  userId?: string;
  tokenPermissions?: FeatureKey[];
  /** Company-defined custom role id (features replace role defaults). */
  roleId?: string;
}

function accessContext(input: AccessInput): {
  config: TenantConfig;
  role: Role;
  userId?: string;
  tokenPermissions?: FeatureKey[];
  roleId?: string;
} {
  return {
    config: input.config,
    role: input.role,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.tokenPermissions && input.tokenPermissions.length > 0
      ? { tokenPermissions: input.tokenPermissions }
      : {}),
    ...(input.roleId ? { roleId: input.roleId } : {}),
  };
}

/** Effective feature permissions for one participant (role + overrides + token + custom role). */
export function accessOf(input: AccessInput): AccessResolution {
  return resolveAccess(accessContext(input));
}

/** Convenience predicate used for server-side enforcement. */
export function canUseFeature(input: AccessInput, feature: FeatureKey): boolean {
  return isFeatureAllowed(accessContext(input), feature);
}

/** Knowledge-agent access decision (enabled + role + permission + endpoint). */
export function knowledgeAccessOf(input: AccessInput): KnowledgeAgentAccess {
  return resolveKnowledgeAgentAccess(accessContext(input));
}

/** Throws 403 `forbidden` when the participant is not allowed to use a feature. */
export function assertFeature(input: AccessInput, feature: FeatureKey, message?: string): void {
  if (!canUseFeature(input, feature)) {
    throw new HttpError(403, 'forbidden', message ?? `Feature is not allowed for this participant: ${feature}`);
  }
}

/** Token-pinned permissions from verified claims. */
export function claimsPermissions(claims: TokenClaims | null | undefined): FeatureKey[] | undefined {
  if (!claims || !Array.isArray(claims.permissions) || claims.permissions.length === 0) return undefined;
  return claims.permissions;
}

/** Reads a header from Node's `req.headers` (case-insensitive via @agil/security). */
export function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  return headerValue(headers as HeaderMap, name);
}

/** `authorization: Bearer <jwt>` -> raw token, or null. */
export function bearerToken(headers: IncomingHttpHeaders): string | null {
  const authorization = header(headers, 'authorization');
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || null;
}

/** True when the request carries the platform-owner key (SaaS tenant management). */
export function isPlatformKey(env: Env, headers: IncomingHttpHeaders): boolean {
  const key = header(headers, 'x-api-key');
  return Boolean(key && env.platformKey && key === env.platformKey);
}

/** Resolves the tenant id for the request's `x-api-key`, or null. */
export function apiKeyTenant(env: Env, headers: IncomingHttpHeaders): string | null {
  const key = header(headers, 'x-api-key');
  return key ? resolveTenantApiKey(env, key) : null;
}

/**
 * Verified dashboard SSO session (`Authorization: Bearer <admin session>`), or
 * null. Sessions are tenant-scoped only: they never authenticate the platform
 * surface.
 */
export function adminSession(env: Env, headers: IncomingHttpHeaders): AdminSessionClaims | null {
  const token = bearerToken(headers);
  if (!token) return null;
  const result = verifyAdminSession(env, token);
  return result.valid ? result.claims : null;
}

export type AdminCredential =
  | { via: 'api-key'; tenantId: string }
  | { via: 'admin-session'; tenantId: string; session: AdminSessionClaims };

/**
 * Any credential accepted by tenant-scoped admin endpoints: `x-api-key`
 * (preferred when present) or an SSO-issued admin session Bearer token.
 */
export function adminCredential(env: Env, headers: IncomingHttpHeaders): AdminCredential | null {
  const keyTenant = apiKeyTenant(env, headers);
  if (keyTenant) return { via: 'api-key', tenantId: keyTenant };
  const session = adminSession(env, headers);
  if (session) return { via: 'admin-session', tenantId: session.tenantId, session };
  return null;
}

type TenantAuthContext = {
  env: Env;
  headers: IncomingHttpHeaders;
  tenants?: { isRetired(tenantId: string): boolean };
};

/**
 * Requires a valid tenant credential — `x-api-key` or an SSO admin session —
 * and returns its tenant id; throws 401 `unauthorized` otherwise.
 */
export function requireApiKeyTenant(ctx: TenantAuthContext): string {
  const credential = adminCredential(ctx.env, ctx.headers);
  if (credential && ctx.tenants?.isRetired(credential.tenantId)) {
    throw new HttpError(401, 'unauthorized', 'Tenant is no longer active');
  }
  if (credential) return credential.tenantId;
  const key = header(ctx.headers, 'x-api-key');
  if (key && ctx.env.platformKey && key === ctx.env.platformKey) {
    throw new HttpError(403, 'forbidden', 'Platform key cannot access tenant-scoped endpoints');
  }
  if (bearerToken(ctx.headers)) {
    throw new HttpError(401, 'unauthorized', 'Missing or invalid admin session token');
  }
  throw new HttpError(401, 'unauthorized', 'Missing or invalid x-api-key');
}

/**
 * Requires the platform key (`AGIL_PLATFORM_KEY`); tenant keys and SSO sessions
 * get 403 (platform management is never delegated to a tenant session).
 */
export function requirePlatformKey(ctx: { env: Env; headers: IncomingHttpHeaders }): true {
  const key = header(ctx.headers, 'x-api-key');
  if (!key) {
    if (adminSession(ctx.env, ctx.headers)) {
      throw new HttpError(403, 'forbidden', 'Platform key is required for tenant management');
    }
    throw new HttpError(401, 'unauthorized', 'Missing x-api-key');
  }
  if (isPlatformKey(ctx.env, ctx.headers)) return true;
  if (apiKeyTenant(ctx.env, ctx.headers)) {
    throw new HttpError(403, 'forbidden', 'Platform key is required for tenant management');
  }
  throw new HttpError(401, 'unauthorized', 'Invalid x-api-key');
}

/** Platform key or the tenant's own credential; otherwise 403/401. */
export function assertTenantAdminAccess(ctx: TenantAuthContext, tenantId: string): void {
  if (isPlatformKey(ctx.env, ctx.headers)) return;
  if (requireApiKeyTenant(ctx) !== tenantId) {
    throw new HttpError(403, 'forbidden', 'Credential does not belong to this tenant');
  }
}

/** Throws 403 `forbidden` when the admin key belongs to a different tenant. */
export function requireTenantMatch(keyTenantId: string, tenantId: string): void {
  if (keyTenantId !== tenantId) throw new HttpError(403, 'forbidden', 'API key does not belong to this tenant');
}

export interface RequestLike {
  env: Env;
  headers: IncomingHttpHeaders;
  ip: string;
  ipHash: string;
  headerCountry?: string;
}

/** Client IP + pseudonym + trusted country for one request. */
export function clientIdentity(input: {
  env: Env;
  headers: IncomingHttpHeaders;
  remoteAddress?: string;
}): { ip: string; ipHash: string; headerCountry?: string } {
  const headers = input.headers as HeaderMap;
  const ip = resolveClientIp({ headers, remoteAddress: input.remoteAddress, trustProxy: input.env.trustProxy });
  const headerCountry = input.env.trustProxy ? countryFromHeaders(headers) : undefined;
  return { ip, ipHash: hashIp(ip, input.env.ipSalt), headerCountry };
}

/** Issues a room access token (HS256, `AGIL_TOKEN_SECRET`). */
export function issueToken(env: Env, input: IssueTokenInput): IssuedToken {
  const ttlSec = Math.max(60, Math.trunc(input.ttlSec ?? env.tokenTtlSec));
  const permissions =
    Array.isArray(input.permissions) && input.permissions.length > 0 ? [...new Set(input.permissions)] : undefined;
  const token = signToken(
    {
      sub: input.participantId,
      name: input.name,
      role: input.role,
      tenantId: input.tenantId,
      roomId: input.roomId,
      ...(input.roleId ? { roleId: input.roleId } : {}),
      ...(permissions ? { permissions } : {}),
    },
    env.tokenSecret,
    { ttlSec },
  );
  const expiresAt = Date.now() + ttlSec * 1000;
  return { token, expiresAt };
}

/** Custom role id from verified claims (never trusts non-string values). */
export function claimsRoleId(claims: TokenClaims | null | undefined): string | undefined {
  const value = (claims as { roleId?: unknown } | null | undefined)?.roleId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Verifies a raw token; returns claims or null (never throws). */
export function verifyAuthToken(env: Env, token: string | null | undefined): TokenClaims | null {
  if (!token) return null;
  const result = verifyToken(token, env.tokenSecret);
  return result.valid ? result.claims : null;
}

/** Requires a valid Bearer join token; throws 401 `unauthorized`. */
export function requireJoinToken(env: Env, headers: IncomingHttpHeaders): TokenClaims {
  const claims = verifyAuthToken(env, bearerToken(headers));
  if (!claims) throw new HttpError(401, 'unauthorized', 'Missing or invalid access token');
  return claims;
}

/** Builds `joinUrl`/`embedUrl` for a room, optionally with a token. */
export function buildRoomLinks(
  env: Env,
  input: { roomId: string; tenantId: string; token?: string },
  origin?: string,
): { joinUrl: string; embedUrl: string } {
  const base = (origin || env.publicOrigin).replace(/\/+$/, '');
  const params = new URLSearchParams({ room: input.roomId });
  params.set('tenant', input.tenantId);
  if (input.token) params.set('token', input.token);
  const query = params.toString();
  return {
    joinUrl: `${base}/?${query}`,
    embedUrl: `${base}/embed.html?${query}`,
  };
}

/** Parses `?sig=&exp=` (returns null when absent/invalid; stores answer 403). */
export function signatureParams(url: URL): { sig: string | null; exp: number | null } {
  const sig = url.searchParams.get('sig');
  const rawExp = url.searchParams.get('exp');
  const exp = rawExp && /^\d+$/.test(rawExp) ? Number(rawExp) : null;
  return { sig: sig && sig.length <= 512 ? sig : null, exp };
}

/** Throws 429 `rate_limited` (with Retry-After header) when a limiter rejects. */
export function assertRateLimit(
  decision: { allowed: boolean; retryAfterMs: number },
  ctx: { res: { setHeader(name: string, value: string): void } },
  message = 'Too many requests',
): void {
  if (decision.allowed) return;
  ctx.res.setHeader('retry-after', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
  throw new HttpError(429, 'rate_limited', message);
}

/** Domain error for a join denial that still needs an HTTP shape. */
export function forbidden(message: string): HttpError {
  return new HttpError(403, 'forbidden', message);
}
