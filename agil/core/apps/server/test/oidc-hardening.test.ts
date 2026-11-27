/**
 * OIDC verified-join hardening: hermetic JWKS with rotation, cache/cooldown,
 * negative caching, weak-key rejection, and the access policy (email/domain
 * allowlist, group→role map, tenant binding, fail-closed issuer/audience).
 *
 * No network: the JWKS is an in-process HTTP server on 127.0.0.1.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { startTestServer, type TestServer } from './helpers.js';
import { clearOidcJwksCache, oidcJwksDiagnostics } from '../src/oidc.js';
import { signAdminSession, verifyAdminSession } from '../src/admin-session.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const ISSUER = 'https://sso.example';
const AUDIENCE = 'agil-calls';

interface TestKey {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function makeKey(kid: string, modulusLength = 2048): TestKey {
  const pair = generateKeyPairSync('rsa', { modulusLength });
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { ...(pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: 'RS256', use: 'sig' },
  };
}

let key1: TestKey;
let key2: TestKey;
let activeKeys: TestKey[] = [];
let jwksRequests = 0;
let jwksMode: 'ok' | 'error' | 'empty' = 'ok';
let jwksCacheControl = '';
let jwksServer: Server;
let jwksUrl = '';
let ts: TestServer;

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

function signToken(payload: Record<string, unknown>, key: TestKey, header: Record<string, unknown> = {}): string {
  const headerObject = { alg: 'RS256', typ: 'JWT', kid: key.kid, ...header };
  const signingInput = `${encode(headerObject)}.${encode(payload)}`;
  return `${signingInput}.${cryptoSign('sha256', Buffer.from(signingInput), key.privateKey).toString('base64url')}`;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'user-1',
    name: 'Иван Петров',
    role: 'guest',
    email: 'user@example.test',
    email_verified: true,
    verified: true,
    iat: now,
    nbf: now - 5,
    exp: now + 300,
    ...overrides,
  };
}

const BASE_IDENTITY = {
  mode: 'oidc' as const,
  issuer: ISSUER,
  audience: AUDIENCE,
  jwksUrl: '',
  userIdClaim: 'sub',
  nameClaim: 'name',
  roleClaim: 'role',
  permissionsClaim: 'permissions',
  verifiedClaim: 'verified',
  authorizationEndpoint: '',
  tokenEndpoint: '',
  clientId: '',
  clientSecretEnv: '',
  redirectUri: '',
  scopes: [] as string[],
  emailClaim: 'email',
  emailVerifiedClaim: 'email_verified',
  requireEmailVerified: false,
  allowedEmails: [] as string[],
  allowedEmailDomains: [] as string[],
  groupsClaim: 'groups',
  groupRoleMap: [] as Array<{ group: string; role: string }>,
  dashboardAdminGroups: [] as string[],
  tenantClaim: '',
  maxTokenAgeSec: 0,
  clockSkewSec: 60,
};

async function configureIdentity(overrides: Record<string, unknown> = {}): Promise<void> {
  const response = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: {
      integrations: { identity: { ...BASE_IDENTITY, jwksUrl, ...overrides } },
      security: { requireVerifiedIdentity: false },
    },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

/** Calls POST /v1/auth/oidc/verify (rate-limiter cleared: many cases per minute). */
async function verify(payloadOrToken: Record<string, unknown> | string, key: TestKey = key1) {
  ts.server.services.limiters.join.clear();
  const identityToken = typeof payloadOrToken === 'string' ? payloadOrToken : signToken(payloadOrToken, key);
  return ts.api('POST', '/v1/auth/oidc/verify', { body: { tenantId: 'demo', identityToken } });
}

before(async () => {
  key1 = makeKey('join-key-1');
  key2 = makeKey('join-key-2');
  activeKeys = [key1];
  jwksServer = createServer((_req, res) => {
    jwksRequests += 1;
    if (jwksMode === 'error') {
      res.statusCode = 500;
      res.end('boom');
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (jwksCacheControl) res.setHeader('cache-control', jwksCacheControl);
    res.end(JSON.stringify({ keys: jwksMode === 'empty' ? [] : activeKeys.map((key) => key.jwk) }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', () => resolve()));
  const port = (jwksServer.address() as { port: number }).port;
  jwksUrl = `http://127.0.0.1:${port}/jwks.json`;
  ts = await startTestServer();
  await configureIdentity();
});

after(async () => {
  clearOidcJwksCache();
  await ts.close();
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
});

beforeEach(() => {
  clearOidcJwksCache();
  jwksMode = 'ok';
  jwksCacheControl = '';
  activeKeys = [key1];
  jwksRequests = 0;
  ts.server.services.limiters.join.clear();
});

test('JWKS cache: valid tokens reuse the cache; a rotated kid triggers exactly one refetch; cooldown stops kid floods', async () => {
  assert.equal((await verify(claims())).status, 200);
  assert.equal(jwksRequests, 1, 'first verification fetched JWKS');

  assert.equal((await verify(claims())).status, 200);
  assert.equal(jwksRequests, 1, 'second verification used the cache');

  // Rotation: the IdP publishes a new key under a new kid.
  activeKeys = [key1, key2];
  const rotated = await verify(claims({ sub: 'user-2' }), key2);
  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
  assert.equal(rotated.body.userId, 'user-2');
  assert.equal(jwksRequests, 2, 'unknown kid forced one refetch');

  // A third unknown kid immediately after the refresh is not another IdP fetch.
  const key3 = makeKey('join-key-3');
  activeKeys = [key1, key2, key3];
  const flooded = await verify(claims({ sub: 'user-3' }), key3);
  assert.equal(flooded.status, 401, 'unknown kid after cooldown window is rejected');
  assert.equal(jwksRequests, 2, 'forced refresh is rate-limited (no unbounded fetch amplification)');

  // Diagnostics expose counts/keys but never tokens.
  const diagnostic = oidcJwksDiagnostics().find((entry) => entry.url === jwksUrl);
  assert.ok(diagnostic);
  assert.equal(diagnostic.fetchCount, 2);
  assert.equal(diagnostic.keys, 2);
});

test('JWKS failure: verification fails closed and repeated calls are negative-cached', async () => {
  jwksMode = 'error';
  const first = await verify(claims());
  assert.equal(first.status, 503);
  assert.equal(first.body.error.code, 'identity_not_configured');
  assert.equal(jwksRequests, 1);

  const second = await verify(claims());
  assert.equal(second.status, 503);
  assert.equal(jwksRequests, 1, 'failure backoff prevents hammering an unavailable IdP');

  jwksMode = 'empty';
  clearOidcJwksCache();
  const empty = await verify(claims());
  assert.equal(empty.status, 503);
  assert.match(String(empty.body.error.message), /ключ/i);

  jwksMode = 'ok';
  clearOidcJwksCache();
  assert.equal((await verify(claims())).status, 200);
});

test('JWKS Cache-Control: no-store bypasses the default 10-minute TTL (P3)', async () => {
  jwksCacheControl = 'no-store';
  try {
    assert.equal((await verify(claims())).status, 200);
    assert.equal(jwksRequests, 1);
    assert.equal((await verify(claims())).status, 200);
    assert.equal(jwksRequests, 2, 'no-store forces a refetch instead of the default TTL');
  } finally {
    jwksCacheControl = '';
  }

  // Control: without the header the cache is used again.
  clearOidcJwksCache();
  jwksRequests = 0;
  assert.equal((await verify(claims())).status, 200);
  assert.equal((await verify(claims())).status, 200);
  assert.equal(jwksRequests, 1, 'default caching still applies');
});

test('weak RSA keys, alg none/HS256, access-token typ and wrong kid are rejected', async () => {
  assert.equal((await verify(claims())).status, 200);

  const weak = makeKey('weak-key', 1024);
  activeKeys = [weak];
  clearOidcJwksCache();
  const weakResult = await verify(claims(), weak);
  assert.equal(weakResult.status, 401, 'RSA < 2048 bits is ignored');
  assert.equal(weakResult.body.error.code, 'invalid_identity_token');

  activeKeys = [key1];
  clearOidcJwksCache();
  const headerNone = `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims())}.`;
  assert.equal((await verify(headerNone)).status, 401);

  const hs256 = signToken(claims(), key1, { alg: 'HS256' });
  assert.equal((await verify(hs256)).status, 401);

  const accessTokenTyp = signToken(claims(), key1, { typ: 'at+jwt' });
  assert.equal((await verify(accessTokenTyp)).status, 401);

  const wrongKid = signToken(claims(), key1, { kid: 'unknown-kid' });
  assert.equal((await verify(wrongKid)).status, 401);
});

test('claim edge cases: exp/nbf/iat types, future iat, azp and non-object payloads', async () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await verify(claims({ exp: String(now + 300) }))).status, 401, 'exp must be a number');
  assert.equal((await verify(claims({ nbf: now + 600 }))).status, 401, 'nbf in the future');
  assert.equal((await verify(claims({ nbf: 'soon' }))).status, 401, 'nbf must be a number');
  assert.equal((await verify(claims({ iat: now + 600 }))).status, 401, 'iat in the future');
  assert.equal((await verify(claims({ aud: ['agil-calls', 'other'] }))).status, 401, 'multi-aud needs azp');
  assert.equal((await verify(claims({ aud: ['agil-calls', 'other'], azp: 'other' }))).status, 401, 'untrusted azp');
  assert.equal(
    (await verify(claims({ aud: ['agil-calls', 'other'], azp: 'agil-calls' }))).status,
    200,
    'trusted azp accepted',
  );
  assert.equal((await verify(claims({ iss: 'https://evil.example' }))).status, 401);
  assert.equal((await verify(claims({ aud: 'another-client' }))).status, 401);

  // Payload that is not a JSON object.
  const arrayPayload = `${encode({ alg: 'RS256', typ: 'JWT', kid: key1.kid })}.${encode([1, 2, 3])}.sig`;
  assert.equal((await verify(arrayPayload)).status, 401);
});

test('issuer/audience are mandatory for mode oidc (no fail-open configuration)', async () => {
  await configureIdentity({ issuer: '' });
  try {
    const missingIssuer = await verify(claims());
    assert.equal(missingIssuer.status, 501);
    assert.equal(missingIssuer.body.error.code, 'identity_not_configured');
  } finally {
    await configureIdentity();
  }

  await configureIdentity({ audience: '' });
  try {
    const missingAudience = await verify(claims());
    assert.equal(missingAudience.status, 501);
  } finally {
    await configureIdentity();
  }
});

test('email/domain allowlist and verified email are enforced on verified joins', async () => {
  // No allowlist / requireEmailVerified: an explicit `email_verified:false`
  // still denies (P3 doc/behavior parity).
  assert.equal((await verify(claims({ email_verified: false }))).status, 403, 'explicit false without policy');
  assert.equal((await verify(claims({ email_verified: 'false' }))).status, 403, 'string false without policy');
  assert.equal((await verify(claims({ email_verified: 0 }))).status, 403, 'numeric false without policy');
  assert.equal((await verify(claims({ email_verified: true }))).status, 200, 'verified email without policy');

  await configureIdentity({
    allowedEmailDomains: ['example.test', '*.corp.example'],
    allowedEmails: ['ceo@other.test'],
  });
  try {
    assert.equal((await verify(claims())).status, 200, 'exact domain');
    assert.equal((await verify(claims({ email: 'USER@EXAMPLE.TEST' }))).status, 200, 'case-insensitive');
    assert.equal((await verify(claims({ email: 'user@team.corp.example' }))).status, 200, 'subdomain wildcard');
    assert.equal((await verify(claims({ email: 'ceo@other.test' }))).status, 200, 'exact email');
    assert.equal((await verify(claims({ email: 'user@sub.example.test' }))).status, 403, 'plain domain is exact');
    assert.equal((await verify(claims({ email: 'user@corp.example' }))).status, 403, 'wildcard excludes the apex');
    const denied = await verify(claims({ email: 'user@evil.test' }));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'identity_not_allowed');
    assert.ok(!JSON.stringify(denied.body).includes('user@evil.test'), 'denied email is not echoed');
    assert.equal((await verify(claims({ email: undefined }))).status, 403, 'missing email denied');
    assert.equal((await verify(claims({ email_verified: false }))).status, 403, 'unverified email denied');
    assert.equal((await verify(claims({ email_verified: 'false' }))).status, 403, 'string false is honored');
  } finally {
    await configureIdentity();
  }

  await configureIdentity({ requireEmailVerified: true });
  try {
    assert.equal((await verify(claims({ email_verified: undefined }))).status, 403);
    assert.equal((await verify(claims({ email_verified: true }))).status, 200);
  } finally {
    await configureIdentity();
  }

  await configureIdentity({ allowedEmailDomains: ['not a domain'] });
  try {
    assert.equal((await verify(claims())).status, 403, 'malformed allowlist fails closed');
  } finally {
    await configureIdentity();
  }
});

test('group→role mapping is authoritative and supports arrays and space-delimited strings', async () => {
  await configureIdentity({
    groupsClaim: 'groups',
    groupRoleMap: [
      { group: 'agil-hosts', role: 'host' },
      { group: 'agil-mods', role: 'moderator' },
    ],
    permissionsClaim: 'permissions',
  });
  try {
    assert.equal((await verify(claims({ groups: ['agil-mods'] }))).body.role, 'moderator');
    assert.equal((await verify(claims({ groups: ['agil-hosts', 'agil-mods'] }))).body.role, 'host', 'highest wins');
    assert.equal((await verify(claims({ groups: ['other'] }))).body.role, 'guest', 'unmapped group → guest');
    assert.equal(
      (await verify(claims({ groups: undefined, role: 'host' }))).body.role,
      'guest',
      'group mapping wins over roleClaim (no privilege via an unmapped claim)',
    );
    assert.equal((await verify(claims({ groups: 'agil-mods,agil-ops' }))).body.role, 'moderator', 'string groups');
    const withPermissions = await verify(claims({ groups: ['agil-mods'], permissions: ['chat', 'screenShare', 'nope'] }));
    assert.deepEqual(withPermissions.body.permissions, ['chat', 'screenShare']);
  } finally {
    await configureIdentity();
  }
});

test('tenant claim binds verified joins to the tenant id', async () => {
  await configureIdentity({ tenantClaim: 'tenant' });
  try {
    assert.equal((await verify(claims({ tenant: 'demo' }))).status, 200);
    const cross = await verify(claims({ tenant: 'acme' }));
    assert.equal(cross.status, 403);
    assert.equal(cross.body.error.code, 'tenant_mismatch');
    assert.equal((await verify(claims())).status, 403, 'missing tenant claim denied');
  } finally {
    await configureIdentity();
  }
});

test('a verified join uses the mapped role and permissions from the signed token', async () => {
  await configureIdentity({
    groupsClaim: 'groups',
    groupRoleMap: [{ group: 'agil-hosts', role: 'host' }],
    allowedEmailDomains: ['example.test'],
  });
  try {
    const room = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'OIDC policy join' } });
    assert.equal(room.status, 200);
    const token = signToken(claims({ groups: ['agil-hosts'], permissions: ['chat'] }), key1);
    ts.server.services.limiters.join.clear();
    const joined = await ts.api('POST', `/v1/rooms/${room.body.room.id}/join`, { body: { identityToken: token } });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.equal(joined.body.participant.role, 'host');
    assert.equal(joined.body.participant.name, 'Иван Петров');
    assert.deepEqual(joined.body.permissions, ['chat']);
  } finally {
    await configureIdentity();
  }
});

test('admin session verification rejects non-finite exp/iat (P3)', () => {
  const env = ts.server.env;
  const issued = signAdminSession(env, { sub: 'admin-1', name: 'Админ', tenantId: 'demo' });
  assert.equal(verifyAdminSession(env, issued.token).valid, true, 'a normal session verifies');

  /** Re-signs the token after replacing one numeric claim with a raw JSON literal. */
  const withRawClaim = (token: string, claim: 'exp' | 'iat', literal: string): string => {
    const [header, payload] = token.split('.') as [string, string, string];
    const text = Buffer.from(payload, 'base64url').toString('utf8');
    const replaced = text.replace(new RegExp(`"${claim}":-?\\d+`), `"${claim}":${literal}`);
    assert.notEqual(replaced, text, `claim ${claim} present in payload`);
    const encoded = Buffer.from(replaced, 'utf8').toString('base64url');
    const key = createHmac('sha256', env.tokenSecret).update('agil-admin-session-v1').digest();
    const reSigned = createHmac('sha256', key).update(`${header}.${encoded}`).digest('base64url');
    return `${header}.${encoded}.${reSigned}`;
  };

  // `1e999` parses to Infinity; `-1e999` to -Infinity. Both used to slip past
  // the old `typeof === 'number'` check (never-expiring / timeless sessions).
  for (const [claim, literal] of [
    ['exp', '1e999'],
    ['iat', '-1e999'],
  ] as const) {
    const result = verifyAdminSession(env, withRawClaim(issued.token, claim, literal));
    assert.equal(result.valid, false, `${claim} must be finite`);
    if (!result.valid) assert.equal(result.error, 'bad_claims');
  }
});
