/**
 * Short-lived dashboard (admin) session JWTs issued by the OIDC login flow.
 *
 * - HS256 with a key **derived** from `AGIL_TOKEN_SECRET` and a purpose label, so
 *   a room/participant token can never be replayed as an admin session (and the
 *   raw secret is never reused directly as the MAC key);
 * - the claim set is explicit (`kind:'admin_session'`, `role:'admin'`,
 *   `tenantId`); `verifyAdminSession` accepts nothing else;
 * - the token carries no permissions: the server re-reads tenant config on every
 *   request, exactly like the `x-api-key` path;
 * - sessions expire (15 min by default, `AGIL_ADMIN_SESSION_TTL_SEC`) and logout
 *   revokes the token's `jti` in a bounded in-memory deny-list. Revocation is
 *   process-local (like OIDC state): multi-node deployments need sticky sessions
 *   or logout routed to every node.
 *
 * The token string is never logged: callers put it only into the URL fragment of
 * the post-login redirect, which browsers never send to a server.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Env } from './env.js';

const PURPOSE = 'agil-admin-session-v1';
const CLOCK_TOLERANCE_SEC = 5;
/** Upper bound of revoked session ids kept in memory. */
const MAX_REVOCATIONS = 50_000;

/** `jti` -> session `exp` (seconds). Entries are pruned once the token expires. */
const revocations = new Map<string, number>();

function pruneRevocations(now: number): void {
  for (const [jti, exp] of revocations) {
    if (exp + CLOCK_TOLERANCE_SEC < now) revocations.delete(jti);
  }
  // Defensive cap: drop the oldest insertions if a logout flood outruns expiry.
  while (revocations.size > MAX_REVOCATIONS) {
    const oldest = revocations.keys().next().value;
    if (typeof oldest !== 'string') break;
    revocations.delete(oldest);
  }
}

/** Revokes a session until its signed `exp` (idempotent). */
export function revokeAdminSession(claims: Pick<AdminSessionClaims, 'jti' | 'exp'>, now = Math.floor(Date.now() / 1000)): void {
  pruneRevocations(now);
  if (!claims.jti || !Number.isFinite(claims.exp)) return;
  revocations.set(claims.jti, claims.exp);
}

/** True when a valid-looking session id was revoked and has not expired yet. */
export function isAdminSessionRevoked(jti: string, now = Math.floor(Date.now() / 1000)): boolean {
  const exp = revocations.get(jti);
  if (exp === undefined) return false;
  if (exp + CLOCK_TOLERANCE_SEC < now) {
    revocations.delete(jti);
    return false;
  }
  return true;
}

/** Clears the deny-list (tests). */
export function resetAdminSessionRevocationsForTests(): void {
  revocations.clear();
}

/** Number of revoked sessions currently remembered (diagnostics/tests). */
export function revokedAdminSessionCount(): number {
  return revocations.size;
}

export interface AdminSessionClaims {
  /** Always `admin_session`; anything else is rejected. */
  kind: 'admin_session';
  /** IdP subject (`sub`) of the signed-in administrator. */
  sub: string;
  /** Display name from the IdP (UI only, capped). */
  name: string;
  /** Always `admin` — dashboard sessions are tenant-scoped admin sessions. */
  role: 'admin';
  tenantId: string;
  iat: number;
  exp: number;
  /** Session id (diagnostics; not exposed to the browser UI). */
  jti: string;
}

export interface IssuedAdminSession {
  token: string;
  expiresAt: number;
  claims: AdminSessionClaims;
}

export type VerifyAdminSessionResult =
  | { valid: true; claims: AdminSessionClaims }
  | { valid: false; error: string };

function deriveKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(PURPOSE).digest();
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function sign(signingInput: string, key: Buffer): string {
  return base64Url(createHmac('sha256', key).update(signingInput).digest());
}

/** Issues a tenant admin session for a verified IdP identity. */
export function signAdminSession(
  env: Pick<Env, 'tokenSecret' | 'adminSessionTtlSec'>,
  input: { sub: string; name: string; tenantId: string; ttlSec?: number; now?: number },
): IssuedAdminSession {
  if (!env.tokenSecret) throw new Error('AGIL token secret is required for admin sessions');
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const ttlSec = Math.max(60, Math.trunc(input.ttlSec ?? env.adminSessionTtlSec));
  const claims: AdminSessionClaims = {
    kind: 'admin_session',
    sub: input.sub.slice(0, 200),
    name: input.name.slice(0, 120),
    role: 'admin',
    tenantId: input.tenantId,
    iat: now,
    exp: now + ttlSec,
    jti: randomUUID(),
  };
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify(claims));
  const signature = sign(`${header}.${payload}`, deriveKey(env.tokenSecret));
  return { token: `${header}.${payload}.${signature}`, expiresAt: (now + ttlSec) * 1000, claims };
}

/** Verifies a raw session token; never throws. */
export function verifyAdminSession(
  env: Pick<Env, 'tokenSecret'>,
  token: string | null | undefined,
  now = Math.floor(Date.now() / 1000),
): VerifyAdminSessionResult {
  if (!token || typeof token !== 'string') return { valid: false, error: 'missing_token' };
  if (!env.tokenSecret) return { valid: false, error: 'missing_secret' };
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, error: 'malformed_token' };
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  let header: { alg?: unknown; typ?: unknown };
  let claims: Partial<AdminSessionClaims> & Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as typeof header;
    claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as typeof claims;
  } catch {
    return { valid: false, error: 'malformed_payload' };
  }
  if (header?.alg !== 'HS256') return { valid: false, error: 'unsupported_alg' };

  const expected = Buffer.from(sign(`${encodedHeader}.${encodedPayload}`, deriveKey(env.tokenSecret)), 'base64url');
  let actual: Buffer;
  try {
    actual = Buffer.from(encodedSignature, 'base64url');
  } catch {
    return { valid: false, error: 'malformed_signature' };
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { valid: false, error: 'bad_signature' };
  }

  if (
    claims.kind !== 'admin_session' ||
    claims.role !== 'admin' ||
    typeof claims.sub !== 'string' ||
    claims.sub.length === 0 ||
    typeof claims.tenantId !== 'string' ||
    claims.tenantId.length === 0 ||
    typeof claims.name !== 'string' ||
    typeof claims.jti !== 'string' ||
    typeof claims.iat !== 'number' ||
    !Number.isFinite(claims.iat) ||
    typeof claims.exp !== 'number' ||
    !Number.isFinite(claims.exp)
  ) {
    return { valid: false, error: 'bad_claims' };
  }
  if (claims.exp + CLOCK_TOLERANCE_SEC < now) return { valid: false, error: 'expired' };
  if (claims.iat - CLOCK_TOLERANCE_SEC > now) return { valid: false, error: 'not_yet_valid' };
  if (isAdminSessionRevoked(claims.jti, now)) return { valid: false, error: 'revoked' };
  return { valid: true, claims: claims as AdminSessionClaims };
}
