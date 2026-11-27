/**
 * Dashboard SSO (OIDC authorization code + PKCE): local mock IdP with
 * authorization/token/JWKS endpoints, full happy path, state/PKCE/nonce/audience
 * failures, tenant isolation, Bearer admin sessions and token-leak checks.
 *
 * Nothing here touches the network: the mock IdP is an in-process HTTP server on
 * 127.0.0.1 and the AGIL server runs on an ephemeral port.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { defaultConfig } from '@agil/protocol';
import { createLogger } from '../src/logger.js';
import { parseOidcTenantSecrets } from '../src/env.js';
import { exchangeOidcCode, resolveOidcReturnTo } from '../src/oidc-flow.js';
import { startTestServer, type TestServer } from './helpers.js';
import { startMockIdp, type MockIdp, type MockIdpOptions } from './oidc-idp.fixture.js';

const DEMO_KEY = { 'x-api-key': 'dev-key' };
const ACME_KEY = { 'x-api-key': 'acme-key' };
const CLIENT_ID = 'agil-dashboard';
/**
 * Per-tenant client secrets. `AGIL_OIDC_CLIENT_SECRET_*` names are tenant-bound
 * (P2), so demo and acme must have different names and values here.
 */
const DEMO_SECRET = 'test-oidc-client-secret';
const ACME_SECRET = 'test-acme-oidc-client-secret';
const DEMO_A_SECRET = 'demo-a-oidc-client-secret';
const ACME_B_SECRET = 'acme-b-oidc-client-secret';
const MAPPED_A_SECRET = 'mapped-demo-a-oidc-client-secret';
const MAPPED_B_SECRET = 'mapped-acme-b-oidc-client-secret';
const LEGACY_SECRET = 'legacy-unbound-oidc-secret';
// P2 collision matrix: one distinct env name/secret per colliding tenant id.
const COLLIDE_DASH_ENV = 'AGIL_OIDC_CLIENT_SECRET_COLLIDE_DASH';
const COLLIDE_UNDERSCORE_ENV = 'AGIL_OIDC_CLIENT_SECRET_COLLIDE_UNDERSCORE';
const COLLIDE_DOT_ENV = 'AGIL_OIDC_CLIENT_SECRET_COLLIDE_DOT';
const COLLIDE_UPPER_ENV = 'AGIL_OIDC_CLIENT_SECRET_COLLIDE_UPPER';
const COLLIDE_DEMO_ENV = 'AGIL_OIDC_CLIENT_SECRET_COLLIDE_DEMO';
const COLLIDE_DEMO_UPPER_ENV = 'AGIL_OIDC_CLIENT_SECRET_COLLIDE_DEMO_UPPER';
const COLLIDE_SECRETS = {
  [COLLIDE_DASH_ENV]: 'collide-a-b-secret',
  [COLLIDE_UNDERSCORE_ENV]: 'collide-a_b-secret',
  [COLLIDE_DOT_ENV]: 'collide-a.b-secret',
  [COLLIDE_UPPER_ENV]: 'collide-A_B-secret',
  [COLLIDE_DEMO_ENV]: 'collide-demo-secret',
  [COLLIDE_DEMO_UPPER_ENV]: 'collide-DEMO-secret',
};
const VALID_CLIENT_SECRETS = new Set([
  DEMO_SECRET,
  ACME_SECRET,
  DEMO_A_SECRET,
  ACME_B_SECRET,
  MAPPED_A_SECRET,
  MAPPED_B_SECRET,
  ...Object.values(COLLIDE_SECRETS),
]);
// Tenant-bound names (`AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME>`).
const SECRET_ENV = 'AGIL_OIDC_CLIENT_SECRET_DEMO_TEST';
const ACME_SECRET_ENV = 'AGIL_OIDC_CLIENT_SECRET_ACME_TEST';
const DEMO_A_ENV = 'AGIL_OIDC_CLIENT_SECRET_DEMO_A';
const ACME_B_ENV = 'AGIL_OIDC_CLIENT_SECRET_ACME_B';
// Unbound names that only `AGIL_OIDC_TENANT_SECRETS` can bind to a tenant.
const MAP_A_ENV = 'AGIL_OIDC_CLIENT_SECRET_A';
const MAP_B_ENV = 'AGIL_OIDC_CLIENT_SECRET_B';
// Legacy/unbound names: allowlisted but not tenant-bound, so they must be
// rejected unless `AGIL_OIDC_TENANT_SECRETS` maps them to the tenant.
const LEGACY_SECRET_ENV = 'AGIL_OIDC_CLIENT_SECRET_TEST';
const GLOBAL_SECRET_ENV = 'AGIL_OIDC_CLIENT_SECRET';
const ISSUER = 'https://sso.example';

function identityPatch(redirectUri: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    integrations: {
      identity: {
        mode: 'oidc',
        issuer: ISSUER,
        audience: 'agil-calls',
        jwksUrl: `${idp.url}/jwks.json`,
        userIdClaim: 'sub',
        nameClaim: 'name',
        roleClaim: 'role',
        permissionsClaim: 'permissions',
        verifiedClaim: 'verified',
        authorizationEndpoint: `${idp.url}/authorize`,
        tokenEndpoint: `${idp.url}/token`,
        clientId: CLIENT_ID,
        clientSecretEnv: SECRET_ENV,
        redirectUri,
        scopes: ['profile', 'email'],
        ...overrides,
      },
    },
  };
}

let idp: MockIdp;
let ts: TestServer;
let logLines: string[] = [];
/**
 * Browser-cookie jar for the SSO binding cookie (keyed by state). Node's fetch
 * does not persist cookies, so the test client resends them explicitly.
 */
const bindingCookies = new Map<string, string>();
/** Raw `Set-Cookie` of the last /start (attribute assertions). */
let lastStartSetCookie: string | null = null;

/** `Set-Cookie` value → `name=value` request Cookie header (attributes dropped). */
function cookiePair(setCookie: string | null): string | undefined {
  if (!setCookie) return undefined;
  const pair = setCookie.split(';')[0]?.trim();
  return pair && pair.includes('=') ? pair : undefined;
}

async function configureTenant(
  server: TestServer,
  key: Record<string, string>,
  tenantId: string,
  redirectUri: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const patched = await server.api('PATCH', `/v1/tenants/${tenantId}/config`, {
    headers: key,
    body: identityPatch(redirectUri, overrides),
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
}

/** Explicit defaults for policy fields so PATCH does not leak state between tests. */
const POLICY_DEFAULTS = {
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

async function resetIdentityPolicy(): Promise<void> {
  await configureTenant(ts, DEMO_KEY, 'demo', `${ts.base}/v1/auth/oidc/callback`, POLICY_DEFAULTS);
}

/** Runs /start and returns the parsed authorization URL (and remembers its binding cookie). */
async function start(
  server: TestServer,
  tenantId = 'demo',
  returnTo = '/dashboard/',
  headers: Record<string, string> = {},
): Promise<URL> {
  // The shared SSO limiter is 30 req/min per IP; this suite intentionally runs
  // many flows, so clear it between helper calls (the limiter itself is covered
  // by other suites).
  server.server.services.limiters.oidc.clear();
  const response = await server.api(
    'GET',
    `/v1/auth/oidc/start?tenantId=${encodeURIComponent(tenantId)}&returnTo=${encodeURIComponent(returnTo)}`,
    { headers },
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const { authorizationUrl } = response.body as { authorizationUrl: string };
  const url = new URL(authorizationUrl);
  const state = url.searchParams.get('state') ?? '';
  lastStartSetCookie = response.headers.get('set-cookie');
  const cookie = cookiePair(lastStartSetCookie);
  if (state && cookie) bindingCookies.set(state, cookie);
  return url;
}

/** Visits the mock authorization endpoint and returns the callback URL. */
async function authorize(authorizationUrl: URL): Promise<URL> {
  const response = await fetch(authorizationUrl, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const location = response.headers.get('location');
  assert.ok(location, 'mock IdP must redirect back');
  return new URL(location);
}

async function callback(
  server: TestServer,
  callbackUrl: URL,
  options: { cookie?: string | null } = {},
): Promise<URL> {
  server.server.services.limiters.oidc.clear();
  const state = callbackUrl.searchParams.get('state') ?? '';
  const cookie = options.cookie === undefined ? bindingCookies.get(state) : options.cookie ?? undefined;
  const response = await fetch(`${server.base}/v1/auth/oidc/callback${callbackUrl.search}`, {
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  });
  assert.equal(response.status, 302, 'callback always redirects (token or error fragment)');
  // The single-use binding cookie is always cleared.
  assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/);
  const location = response.headers.get('location');
  assert.ok(location, 'callback must set Location');
  return new URL(location);
}

function tokenFrom(location: URL): string {
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
  const token = fragment.get('sso_token');
  assert.ok(token, `expected #sso_token in ${location.href.replace(/#.*/, '#…')}`);
  return token;
}

function errorCode(location: URL): string | null {
  return new URLSearchParams(location.hash.replace(/^#/, '')).get('sso_error');
}

function decodePayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  return JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Full login helper: start → IdP → callback → session token. */
async function login(server: TestServer, tenantId = 'demo'): Promise<{ token: string; location: URL; authorizationUrl: URL }> {
  const authorizationUrl = await start(server, tenantId);
  const callbackUrl = await authorize(authorizationUrl);
  const location = await callback(server, callbackUrl);
  return { token: tokenFrom(location), location, authorizationUrl };
}

before(async () => {
  process.env[SECRET_ENV] = DEMO_SECRET;
  process.env[ACME_SECRET_ENV] = ACME_SECRET;
  process.env[DEMO_A_ENV] = DEMO_A_SECRET;
  process.env[ACME_B_ENV] = ACME_B_SECRET;
  process.env[LEGACY_SECRET_ENV] = LEGACY_SECRET;
  process.env[GLOBAL_SECRET_ENV] = LEGACY_SECRET;
  idp = await startMockIdp({ clientId: CLIENT_ID, issuer: ISSUER, clientSecrets: VALID_CLIENT_SECRETS });
  const logger = createLogger({ sink: (line) => logLines.push(line) });
  ts = await startTestServer({ logger });
  await configureTenant(ts, DEMO_KEY, 'demo', `${ts.base}/v1/auth/oidc/callback`);
  await configureTenant(ts, ACME_KEY, 'acme', `${ts.base}/v1/auth/oidc/callback`, {
    clientSecretEnv: ACME_SECRET_ENV,
  });
});

after(async () => {
  for (const name of [SECRET_ENV, ACME_SECRET_ENV, DEMO_A_ENV, ACME_B_ENV, LEGACY_SECRET_ENV, GLOBAL_SECRET_ENV]) {
    delete process.env[name];
  }
  delete process.env.AGIL_OIDC_TENANT_SECRETS;
  await ts.close();
  await new Promise<void>((resolve) => idp.server.close(() => resolve()));
});

test('full flow: start builds a PKCE authorization URL; callback mints an admin session', async () => {
  idp.options = {};
  const authorizationUrl = await start(ts, 'demo', '/dashboard/');
  assert.equal(authorizationUrl.searchParams.get('response_type'), 'code');
  assert.equal(authorizationUrl.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(authorizationUrl.searchParams.get('redirect_uri'), `${ts.base}/v1/auth/oidc/callback`);
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  const challenge = authorizationUrl.searchParams.get('code_challenge') ?? '';
  assert.match(challenge, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(authorizationUrl.searchParams.get('state') ?? '', /^[A-Za-z0-9_-]{32,}$/);
  assert.match(authorizationUrl.searchParams.get('nonce') ?? '', /^[A-Za-z0-9_-]{32,}$/);
  const scope = (authorizationUrl.searchParams.get('scope') ?? '').split(' ');
  assert.equal(scope[0], 'openid', 'openid is always requested first');
  assert.ok(scope.includes('profile') && scope.includes('email'), 'configured scopes are forwarded');

  const callbackUrl = await authorize(authorizationUrl);
  assert.ok(callbackUrl.searchParams.get('code'), 'authorization code returned');
  // PKCE proof: the mock IdP recomputed S256(code_verifier) and it matched.
  const location = await callback(ts, callbackUrl);
  assert.equal(location.search, '', 'no token in the query string');
  const token = tokenFrom(location);
  assert.equal(location.origin + location.pathname, 'http://127.0.0.1:1/dashboard/');

  const claims = decodePayload(token);
  assert.equal(claims.kind, 'admin_session');
  assert.equal(claims.role, 'admin');
  assert.equal(claims.tenantId, 'demo');
  assert.equal(claims.sub, 'admin-user-1');
  assert.equal(claims.name, 'Иван Администратор');
  const { exp, iat } = claims as { exp: number; iat: number };
  assert.ok(exp - iat > 0 && exp - iat <= 60 * 60, 'session is short-lived');
  assert.ok(!token.includes('code_verifier'));

  const overview = await ts.api('GET', '/v1/admin/overview', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(overview.status, 200, JSON.stringify(overview.body));
  assert.equal(overview.body.tenantId, 'demo');

  const security = await ts.api('GET', '/v1/admin/security', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(security.status, 200);

  // The session may edit its own tenant config through the public admin route.
  const patched = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: { authorization: `Bearer ${token}` },
    body: { features: { chat: true } },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));

  const health = await ts.api('GET', '/v1/health');
  assert.equal(health.status, 200);
});

test('state is single-use and required; stale/garbage state renders #sso_error', async () => {
  idp.options = {};
  const authorizationUrl = await start(ts);
  const callbackUrl = await authorize(authorizationUrl);
  assert.ok(tokenFrom(await callback(ts, callbackUrl)));

  const replay = await callback(ts, callbackUrl);
  assert.equal(errorCode(replay), 'state_invalid');
  assert.equal(new URLSearchParams(replay.hash.replace(/^#/, '')).get('sso_token'), null);

  const garbage = await callback(ts, new URL(`${ts.base}/v1/auth/oidc/callback?code=x&state=${randomBytes(24).toString('base64url')}`));
  assert.equal(errorCode(garbage), 'state_invalid');

  const missing = await callback(ts, new URL(`${ts.base}/v1/auth/oidc/callback`));
  assert.equal(errorCode(missing), 'state_invalid');
});

test('PKCE mismatch: IdP rejects the code_verifier → #sso_error=idp_error', async () => {
  idp.options = { breakPkce: true };
  try {
    const authorizationUrl = await start(ts);
    const callbackUrl = await authorize(authorizationUrl);
    const location = await callback(ts, callbackUrl);
    assert.equal(errorCode(location), 'idp_error');
    assert.equal(new URLSearchParams(location.hash.replace(/^#/, '')).get('sso_token'), null);
    assert.equal(idp.tokenCount > 0, true, 'code was exchanged (and rejected)');
  } finally {
    idp.options = {};
  }
});

test('nonce and audience are verified; a tampered id_token is rejected', async () => {
  idp.options = { nonce: 'replayed-nonce' };
  const nonceFlow = await start(ts);
  const nonceCallback = await callback(ts, await authorize(nonceFlow));
  assert.equal(errorCode(nonceCallback), 'invalid_identity_token');

  idp.options = { audience: 'another-client' };
  const audienceFlow = await start(ts);
  const audienceCallback = await callback(ts, await authorize(audienceFlow));
  assert.equal(errorCode(audienceCallback), 'invalid_identity_token');
  idp.options = {};

  // The API audience (integrations.identity.audience) is accepted too.
  idp.options = { audience: 'agil-calls' };
  const apiAudienceFlow = await start(ts);
  const apiAudienceCallback = await callback(ts, await authorize(apiAudienceFlow));
  assert.ok(tokenFrom(apiAudienceCallback), 'aud = configured audience is accepted');
  idp.options = {};
});

test('IdP failures and a missing id_token fail closed', async () => {
  idp.options = { tokenStatus: 500 };
  const errorFlow = await start(ts);
  assert.equal(errorCode(await callback(ts, await authorize(errorFlow))), 'idp_error');

  idp.options = { omitIdToken: true };
  const noTokenFlow = await start(ts);
  assert.equal(errorCode(await callback(ts, await authorize(noTokenFlow))), 'idp_error');
  idp.options = {};
});

test('start is 501 for tenants without OIDC and 400 for an untrusted returnTo', async () => {
  const notConfigured = await ts.api('GET', '/v1/auth/oidc/start?tenantId=plain');
  assert.equal(notConfigured.status, 501);
  assert.equal(notConfigured.body.error.code, 'identity_not_configured');

  const evil = await ts.api('GET', `/v1/auth/oidc/start?tenantId=demo&returnTo=${encodeURIComponent('https://evil.example/steal')}`);
  assert.equal(evil.status, 400);
  assert.equal(evil.body.error.code, 'validation_failed');

  const protocolRelative = await ts.api('GET', `/v1/auth/oidc/start?tenantId=demo&returnTo=${encodeURIComponent('//evil.example')}`);
  assert.equal(protocolRelative.status, 400);
});

test('P0: returnTo can never resolve outside the public origin (backslash/control bypass)', async () => {
  idp.options = {};
  const rejected = [
    ['/\\evil.example', 'single backslash after a slash'],
    ['/\\/evil.example', 'backslash + slash'],
    ['\\\\evil.example', 'leading backslashes'],
    ['http:\\\\evil.example', 'backslash absolute URL'],
    ['//evil.example', 'protocol-relative'],
    ['///evil.example', 'triple slash'],
    ['/\tevil.example', 'tab control character'],
    ['/\r\nLocation: https://evil.example', 'CRLF'],
    ['/\u0000evil.example', 'NUL'],
    ['https://evil.example/steal', 'absolute foreign origin'],
    ['https://user:pass@127.0.0.1:1/dashboard/', 'credentials'],
    ['http://127.0.0.1:1@evil.example/', 'userinfo that parses as another host'],
  ];
  for (const [candidate, label] of rejected) {
    const response = await ts.api(
      'GET',
      `/v1/auth/oidc/start?tenantId=demo&returnTo=${encodeURIComponent(candidate as string)}`,
    );
    assert.equal(response.status, 400, `${label}: expected 400, got ${response.status} ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error.code, 'validation_failed', label);
    assert.equal(response.body.authorizationUrl, undefined, `${label}: no authorization URL is minted`);
  }

  // Exactly the QA proof: `returnTo=%2F%5Cevil.example` (single-decoded to `/\evil.example`).
  const qaProof = await ts.api('GET', '/v1/auth/oidc/start?tenantId=demo&returnTo=%2F%5Cevil.example');
  assert.equal(qaProof.status, 400, JSON.stringify(qaProof.body));
  assert.equal(qaProof.body.error.code, 'validation_failed');

  // Same-origin relative and absolute targets stay accepted.
  const relative = await ts.api(
    'GET',
    `/v1/auth/oidc/start?tenantId=demo&returnTo=${encodeURIComponent('/dashboard/rooms')}`,
  );
  assert.equal(relative.status, 200, JSON.stringify(relative.body));
  const absolute = await ts.api(
    'GET',
    `/v1/auth/oidc/start?tenantId=demo&returnTo=${encodeURIComponent('http://127.0.0.1:1/dashboard/')}`,
  );
  assert.equal(absolute.status, 200, JSON.stringify(absolute.body));
  const fragment = await ts.api(
    'GET',
    `/v1/auth/oidc/start?tenantId=demo&returnTo=${encodeURIComponent('/dashboard/?x=1#stale')}`,
  );
  assert.equal(fragment.status, 200, 'query is kept, hash is stripped');

  // The QA probe used an https public origin; the guard compares origins, so
  // the same backslash payload is rejected there too.
  const httpsEnv = { ...ts.server.env, publicOrigin: 'https://calls.example.com' };
  const httpsConfig = defaultConfig({ tenantId: 'demo' });
  assert.throws(
    () => resolveOidcReturnTo(httpsEnv, httpsConfig, '/\\evil.example'),
    (error: unknown) => (error as { code?: string }).code === 'validation_failed',
  );
  assert.throws(
    () => resolveOidcReturnTo(httpsEnv, httpsConfig, '/\\/evil.example'),
    (error: unknown) => (error as { code?: string }).code === 'validation_failed',
  );
  assert.equal(
    resolveOidcReturnTo(httpsEnv, httpsConfig, '/dashboard/'),
    'https://calls.example.com/dashboard/',
    'same-origin relative path is still accepted',
  );
});

test('P1: clientSecretEnv is restricted to the server-owned allowlist', async () => {
  // (a) Config write rejects a tenant-selected arbitrary env var.
  const rejected = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: DEMO_KEY,
    body: identityPatch(`${ts.base}/v1/auth/oidc/callback`, { clientSecretEnv: 'AGIL_TOKEN_SECRET' }),
  });
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error.code, 'validation_failed');
  const unchanged = await ts.api('GET', '/v1/tenants/demo/config', { headers: DEMO_KEY });
  assert.equal(unchanged.body.config.integrations.identity.clientSecretEnv, SECRET_ENV, 'rejected write did not persist');

  // (b) Exchange-time defence: even a hand-written/legacy config that names
  // another env var must not read it or call the token endpoint.
  const legacy = defaultConfig({ tenantId: 'demo' });
  legacy.integrations.identity = {
    ...legacy.integrations.identity,
    mode: 'oidc',
    issuer: ISSUER,
    audience: 'agil-calls',
    jwksUrl: `${idp.url}/jwks.json`,
    authorizationEndpoint: `${idp.url}/authorize`,
    tokenEndpoint: `${idp.url}/token`,
    clientId: CLIENT_ID,
    clientSecretEnv: 'AGIL_TOKEN_SECRET',
  };
  const saved = process.env.AGIL_TOKEN_SECRET;
  process.env.AGIL_TOKEN_SECRET = 'server-only-token-secret-value';
  const before = idp.tokenCount;
  try {
    await assert.rejects(
      () => exchangeOidcCode(ts.server.env, legacy, { verifier: 'legacy-verifier' } as never, 'code'),
      (error: unknown) => (error as { code?: string }).code === 'validation_failed',
      'a non-allowlisted clientSecretEnv must fail closed',
    );
    assert.equal(idp.tokenCount, before, 'token endpoint was never called');
  } finally {
    if (saved === undefined) delete process.env.AGIL_TOKEN_SECRET;
    else process.env.AGIL_TOKEN_SECRET = saved;
  }

  // (c) An allowlisted name that was not present at startup fails closed.
  await configureTenant(ts, DEMO_KEY, 'demo', `${ts.base}/v1/auth/oidc/callback`, {
    clientSecretEnv: 'AGIL_OIDC_CLIENT_SECRET_DEMO_NOT_SET_AT_START',
  });
  try {
    const flow = await start(ts);
    assert.equal(errorCode(await callback(ts, await authorize(flow))), 'identity_not_configured');
  } finally {
    await configureTenant(ts, DEMO_KEY, 'demo', `${ts.base}/v1/auth/oidc/callback`, { clientSecretEnv: SECRET_ENV });
  }

  // (d) The valid flow sends exactly the allowlisted secret, nothing else.
  idp.options = {};
  const authorizationUrl = await start(ts);
  const location = await callback(ts, await authorize(authorizationUrl));
  assert.ok(tokenFrom(location));
  assert.equal(idp.lastTokenRequest?.get('client_secret'), DEMO_SECRET);
});

test('P2: clientSecretEnv names are bound to the tenant (no cross-tenant secret selection)', async () => {
  idp.options = {};

  // demo may select its own `..._DEMO_*` secret and the exchange sends it.
  await configureTenant(ts, DEMO_KEY, 'demo', `${ts.base}/v1/auth/oidc/callback`, {
    clientSecretEnv: DEMO_A_ENV,
  });
  try {
    const flow = await start(ts, 'demo');
    assert.ok(tokenFrom(await callback(ts, await authorize(flow))), 'demo login with demo_A succeeds');
    assert.equal(idp.lastTokenRequest?.get('client_secret'), DEMO_A_SECRET, 'demo sends its own secret');
  } finally {
    await configureTenant(ts, DEMO_KEY, 'demo', `${ts.base}/v1/auth/oidc/callback`, { clientSecretEnv: SECRET_ENV });
  }

  // demo cannot write acme's `..._ACME_*` name to its config.
  const crossTenantWrite = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: DEMO_KEY,
    body: identityPatch(`${ts.base}/v1/auth/oidc/callback`, { clientSecretEnv: ACME_B_ENV }),
  });
  assert.equal(crossTenantWrite.status, 400, JSON.stringify(crossTenantWrite.body));
  assert.equal(crossTenantWrite.body.error.code, 'validation_failed');
  const details = crossTenantWrite.body.error.details as Array<{ path: string }> | undefined;
  assert.ok(
    details?.some((issue) => issue.path === 'integrations.identity.clientSecretEnv'),
    `cross-tenant binding issue not reported: ${JSON.stringify(details)}`,
  );
  const demoConfig = await ts.api('GET', '/v1/tenants/demo/config', { headers: DEMO_KEY });
  assert.equal(
    demoConfig.body.config.integrations.identity.clientSecretEnv,
    SECRET_ENV,
    'rejected cross-tenant write did not persist',
  );

  // Exchange-time defence: a hand-written demo config naming acme's secret is
  // rejected before the token endpoint is called (the env value exists).
  assert.equal(process.env[ACME_B_ENV], ACME_B_SECRET, 'acme secret is present in the env snapshot');
  const crossTenantConfig = defaultConfig({ tenantId: 'demo' });
  crossTenantConfig.integrations.identity = {
    ...crossTenantConfig.integrations.identity,
    mode: 'oidc',
    issuer: ISSUER,
    audience: 'agil-calls',
    jwksUrl: `${idp.url}/jwks.json`,
    authorizationEndpoint: `${idp.url}/authorize`,
    tokenEndpoint: `${idp.url}/token`,
    clientId: CLIENT_ID,
    clientSecretEnv: ACME_B_ENV,
  };
  const crossMark = idp.tokenCount;
  await assert.rejects(
    () => exchangeOidcCode(ts.server.env, crossTenantConfig, { verifier: 'cross-tenant-verifier' } as never, 'code'),
    (error: unknown) => (error as { code?: string }).code === 'validation_failed',
    'a cross-tenant clientSecretEnv must fail closed',
  );
  assert.equal(idp.tokenCount, crossMark, 'token endpoint was never called for the cross-tenant config');

  // acme may select its own `..._ACME_*` secret.
  await configureTenant(ts, ACME_KEY, 'acme', `${ts.base}/v1/auth/oidc/callback`, {
    clientSecretEnv: ACME_B_ENV,
  });
  try {
    const acmeFlow = await start(ts, 'acme');
    const location = await callback(ts, await authorize(acmeFlow));
    assert.ok(tokenFrom(location), 'acme login with acme_B succeeds');
    assert.equal(idp.lastTokenRequest?.get('client_secret'), ACME_B_SECRET, 'acme sends its own secret');
    assert.equal(decodePayload(tokenFrom(location)).tenantId, 'acme');
  } finally {
    await configureTenant(ts, ACME_KEY, 'acme', `${ts.base}/v1/auth/oidc/callback`, {
      clientSecretEnv: ACME_SECRET_ENV,
    });
  }

  // Unbound legacy names (no tenant segment, no explicit map) are rejected at
  // write and at exchange, and never reach the token endpoint.
  const legacyMark = idp.tokenCount;
  for (const legacyName of [LEGACY_SECRET_ENV, GLOBAL_SECRET_ENV]) {
    const legacyWrite = await ts.api('PATCH', '/v1/tenants/demo/config', {
      headers: DEMO_KEY,
      body: identityPatch(`${ts.base}/v1/auth/oidc/callback`, { clientSecretEnv: legacyName }),
    });
    assert.equal(legacyWrite.status, 400, `${legacyName}: ${JSON.stringify(legacyWrite.body)}`);
    assert.equal(legacyWrite.body.error.code, 'validation_failed');

    const legacyConfig = structuredClone(crossTenantConfig);
    legacyConfig.integrations.identity.clientSecretEnv = legacyName;
    await assert.rejects(
      () => exchangeOidcCode(ts.server.env, legacyConfig, { verifier: 'legacy-unbound' } as never, 'code'),
      (error: unknown) => (error as { code?: string }).code === 'validation_failed',
      `${legacyName} must be rejected at exchange`,
    );
  }
  assert.equal(idp.tokenCount, legacyMark, 'no rejected config reached the token endpoint');

  // /start reads the same tenant binding: a hand-written cross-tenant config
  // fails closed before an authorization URL is minted.
  const savedDemo = structuredClone(ts.server.tenants.getConfig('demo'));
  ts.server.tenants.setConfig('demo', structuredClone(crossTenantConfig));
  try {
    const startRejected = await ts.api(
      'GET',
      `/v1/auth/oidc/start?tenantId=demo&returnTo=${encodeURIComponent('/dashboard/')}`,
    );
    assert.equal(startRejected.status, 400, JSON.stringify(startRejected.body));
    assert.equal(startRejected.body.error.code, 'validation_failed');
    assert.equal(startRejected.body.authorizationUrl, undefined, 'no authorization URL for a cross-tenant name');
  } finally {
    ts.server.tenants.setConfig('demo', savedDemo);
  }
});

test('P2: AGIL_OIDC_TENANT_SECRETS binds unbound names: demo_A 200, demo_B 400, acme_B 200', async () => {
  const previousMap = process.env.AGIL_OIDC_TENANT_SECRETS;
  process.env.AGIL_OIDC_TENANT_SECRETS = `demo=${MAP_A_ENV},acme=${MAP_B_ENV}`;
  const mapped = await startTestServer({
    oidcClientSecrets: { [MAP_A_ENV]: MAPPED_A_SECRET, [MAP_B_ENV]: MAPPED_B_SECRET },
  });
  try {
    // demo may select its mapped `_A` name and the exchange sends that value.
    await configureTenant(mapped, DEMO_KEY, 'demo', `${mapped.base}/v1/auth/oidc/callback`, {
      clientSecretEnv: MAP_A_ENV,
    });
    const flow = await start(mapped, 'demo');
    const location = await callback(mapped, await authorize(flow));
    assert.ok(tokenFrom(location), 'mapped demo login succeeds');
    assert.equal(idp.lastTokenRequest?.get('client_secret'), MAPPED_A_SECRET);

    // demo cannot select acme's mapped `_B` name.
    const demoB = await mapped.api('PATCH', '/v1/tenants/demo/config', {
      headers: DEMO_KEY,
      body: identityPatch(`${mapped.base}/v1/auth/oidc/callback`, { clientSecretEnv: MAP_B_ENV }),
    });
    assert.equal(demoB.status, 400, JSON.stringify(demoB.body));
    assert.equal(demoB.body.error.code, 'validation_failed');

    // acme may select its mapped `_B` name (same name demo was denied).
    await configureTenant(mapped, ACME_KEY, 'acme', `${mapped.base}/v1/auth/oidc/callback`, {
      clientSecretEnv: MAP_B_ENV,
    });
    const acmeFlow = await start(mapped, 'acme');
    const acmeLocation = await callback(mapped, await authorize(acmeFlow));
    const acmeToken = tokenFrom(acmeLocation);
    assert.equal(decodePayload(acmeToken).tenantId, 'acme');
    assert.equal(idp.lastTokenRequest?.get('client_secret'), MAPPED_B_SECRET);
  } finally {
    if (previousMap === undefined) delete process.env.AGIL_OIDC_TENANT_SECRETS;
    else process.env.AGIL_OIDC_TENANT_SECRETS = previousMap;
    await mapped.close();
  }
});

test("P2: colliding tenant ids cannot select another tenant's explicitly mapped secret", async () => {
  idp.options = {};
  // a-b / a_b / a.b / A_B would all normalise to A_B under the old lossy
  // comparison; demo/DEMO would both normalise to DEMO. Each tenant must be
  // able to use only its own exact map entry.
  const matrix = [
    { tenant: 'a-b', key: 'collide-dash-key', env: COLLIDE_DASH_ENV },
    { tenant: 'a_b', key: 'collide-underscore-key', env: COLLIDE_UNDERSCORE_ENV },
    { tenant: 'a.b', key: 'collide-dot-key', env: COLLIDE_DOT_ENV },
    { tenant: 'A_B', key: 'collide-upper-key', env: COLLIDE_UPPER_ENV },
    { tenant: 'demo', key: 'collide-demo-key', env: COLLIDE_DEMO_ENV },
    { tenant: 'DEMO', key: 'collide-demo-upper-key', env: COLLIDE_DEMO_UPPER_ENV },
  ];
  const mapString = matrix.map(({ tenant, env }) => `${tenant}=${env}`).join(',');
  const parsedMap = parseOidcTenantSecrets(mapString);
  assert.deepEqual(
    parsedMap,
    Object.fromEntries(matrix.map(({ tenant, env }) => [tenant, env])),
    'the explicit map preserves exact tenant keys',
  );
  const colliding = await startTestServer({
    apiKeys: Object.fromEntries(matrix.map(({ tenant, key }) => [key, tenant])),
    oidcClientSecrets: COLLIDE_SECRETS,
    oidcTenantSecrets: parsedMap,
  });
  try {
    // Every colliding tenant can use its own mapped name end-to-end…
    for (let index = 0; index < matrix.length; index += 1) {
      const own = matrix[index] as (typeof matrix)[number];
      const peer = matrix[(index + 1) % matrix.length] as (typeof matrix)[number];
      await configureTenant(colliding, { 'x-api-key': own.key }, own.tenant, `${colliding.base}/v1/auth/oidc/callback`, {
        clientSecretEnv: own.env,
      });
      const flow = await start(colliding, own.tenant);
      const token = tokenFrom(await callback(colliding, await authorize(flow)));
      assert.equal(decodePayload(token).tenantId, own.tenant);
      assert.equal(
        idp.lastTokenRequest?.get('client_secret'),
        COLLIDE_SECRETS[own.env],
        `${own.tenant} sends its own explicitly mapped secret`,
      );

      // …but selecting the peer's mapped name is rejected at write time.
      const crossWrite = await colliding.api('PATCH', `/v1/tenants/${own.tenant}/config`, {
        headers: { 'x-api-key': own.key },
        body: identityPatch(`${colliding.base}/v1/auth/oidc/callback`, { clientSecretEnv: peer.env }),
      });
      assert.equal(
        crossWrite.status,
        400,
        `${own.tenant} selecting ${peer.tenant}'s env: ${JSON.stringify(crossWrite.body)}`,
      );
      assert.equal(crossWrite.body.error.code, 'validation_failed');
    }

    // Exchange-time defence for the original a-b -> a_b bypass: a hand-written
    // config must fail before the token endpoint is called.
    const crossConfig = defaultConfig({ tenantId: 'a_b' });
    crossConfig.integrations.identity = {
      ...crossConfig.integrations.identity,
      mode: 'oidc',
      issuer: ISSUER,
      audience: 'agil-calls',
      jwksUrl: `${idp.url}/jwks.json`,
      authorizationEndpoint: `${idp.url}/authorize`,
      tokenEndpoint: `${idp.url}/token`,
      clientId: CLIENT_ID,
      clientSecretEnv: COLLIDE_DASH_ENV,
    };
    const tokenMark = idp.tokenCount;
    await assert.rejects(
      () => exchangeOidcCode(colliding.server.env, crossConfig, { verifier: 'cross-collision' } as never, 'code'),
      (error: unknown) => (error as { code?: string }).code === 'validation_failed',
      'a colliding tenant must not select the mapped secret of a-b',
    );
    assert.equal(idp.tokenCount, tokenMark, 'token endpoint was never called for the colliding exchange');

    // Case-only collision: the convention belongs to canonical lower-case
    // `demo`; tenant `DEMO` must use an exact map entry instead.
    const demoConvention = 'AGIL_OIDC_CLIENT_SECRET_DEMO_CONVENTION';
    const upperConvention = await colliding.api('PATCH', '/v1/tenants/DEMO/config', {
      headers: { 'x-api-key': 'collide-demo-upper-key' },
      body: identityPatch(`${colliding.base}/v1/auth/oidc/callback`, { clientSecretEnv: demoConvention }),
    });
    assert.equal(upperConvention.status, 400, JSON.stringify(upperConvention.body));
    assert.equal(upperConvention.body.error.code, 'validation_failed');
    const lowerConvention = await colliding.api('PATCH', '/v1/tenants/demo/config', {
      headers: { 'x-api-key': 'collide-demo-key' },
      body: identityPatch(`${colliding.base}/v1/auth/oidc/callback`, { clientSecretEnv: demoConvention }),
    });
    assert.equal(lowerConvention.status, 200, JSON.stringify(lowerConvention.body));
  } finally {
    await colliding.close();
  }
});

test('P2: a duplicate tenant key in AGIL_OIDC_TENANT_SECRETS fails closed at startup', async () => {
  // The parser disables the whole map; nothing mapped remains selectable.
  const parsed = parseOidcTenantSecrets(`a-b=${COLLIDE_DASH_ENV},a-b=${COLLIDE_UNDERSCORE_ENV}`);
  assert.deepEqual(parsed, {});
  const duplicateMap = await startTestServer({
    apiKeys: { 'duplicate-key': 'a-b' },
    oidcClientSecrets: COLLIDE_SECRETS,
    oidcTenantSecrets: parsed,
  });
  try {
    const patch = await duplicateMap.api('PATCH', '/v1/tenants/a-b/config', {
      headers: { 'x-api-key': 'duplicate-key' },
      body: identityPatch(`${duplicateMap.base}/v1/auth/oidc/callback`, {
        clientSecretEnv: COLLIDE_DASH_ENV,
      }),
    });
    assert.equal(patch.status, 400, JSON.stringify(patch.body));
    assert.equal(patch.body.error.code, 'validation_failed');
  } finally {
    await duplicateMap.close();
  }
});

test('P3: start binding compares the full origin (scheme + host + port), not just host', async () => {
  idp.options = {};
  await start(ts, 'demo', '/dashboard/', { origin: 'https://127.0.0.1:1' });
  assert.equal(lastStartSetCookie, null, 'https origin with the same host is cross-origin for http public origin');
  await start(ts, 'demo', '/dashboard/', { origin: 'http://127.0.0.1:1' });
  assert.match(lastStartSetCookie ?? '', /agil_oidc_binding=/, 'full origin match keeps the binding cookie');
});

test('tenant isolation: a session for acme cannot touch demo; platform routes stay key-only', async () => {
  idp.options = {};
  const { token } = await login(ts, 'acme');
  const acme = await ts.api('GET', '/v1/admin/overview', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(acme.status, 200);
  assert.equal(acme.body.tenantId, 'acme');

  const crossTenant = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: { authorization: `Bearer ${token}` },
    body: { features: { chat: true } },
  });
  assert.equal(crossTenant.status, 403);

  const platform = await ts.api('GET', '/v1/admin/tenants', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(platform.status, 403, 'SSO sessions never authenticate the platform surface');

  const tampered = `${token.slice(0, -2)}${token.endsWith('aa') ? 'bb' : 'aa'}`;
  const rejected = await ts.api('GET', '/v1/admin/overview', { headers: { authorization: `Bearer ${tampered}` } });
  assert.equal(rejected.status, 401);

  const asKey = await ts.api('GET', '/v1/admin/overview', { headers: { 'x-api-key': token } });
  assert.equal(asKey.status, 401, 'a session token is not an API key');
});

test('a join token is not an admin session', async () => {
  const room = await ts.api('POST', '/v1/admin/rooms', { headers: DEMO_KEY, body: { name: 'SSO join token' } });
  const joined = await ts.api('POST', `/v1/rooms/${room.body.room.id}/join`, { body: { name: 'Guest' } });
  assert.equal(joined.status, 200);
  const denied = await ts.api('GET', '/v1/admin/overview', {
    headers: { authorization: `Bearer ${joined.body.token}` },
  });
  assert.equal(denied.status, 401);
});

test('no token leaks: response bodies, audit log and server log lines stay token-free', async () => {
  idp.options = {};
  const authorizationUrl = await start(ts);
  const callbackUrl = await authorize(authorizationUrl);
  const code = callbackUrl.searchParams.get('code') ?? '';
  const location = await callback(ts, callbackUrl);
  const token = tokenFrom(location);
  const idToken = idp.lastIdToken ?? '';
  assert.ok(code && idToken, 'mock IdP issued a code and id_token');
  assert.equal(location.search, '', 'token never travels in the query string');
  assert.ok(location.hash.startsWith('#sso_token='), 'token is delivered in the fragment');
  assert.ok(!location.pathname.includes(token));
  assert.ok(!location.search.includes(token));

  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(audit.status, 200);
  assert.ok(
    JSON.stringify(audit.body).includes('Dashboard SSO login'),
    `login is audited without the token: ${JSON.stringify(audit.body).slice(0, 600)}`,
  );
  assert.ok(!JSON.stringify(audit.body).includes(token), 'session token is not in the audit');
  assert.ok(!JSON.stringify(audit.body).includes(token.split('.')[2] ?? 'x'), 'signature is not in the audit');

  const joined = JSON.stringify(logLines);
  assert.ok(!joined.includes(token), 'session token is never logged');
  assert.ok(!joined.includes(token.split('.')[2] ?? 'x'), 'signature is never logged');
  assert.ok(!joined.includes(DEMO_SECRET), 'client secret is never logged');
  assert.ok(!joined.includes(idToken), 'id_token is never logged');
  assert.ok(!joined.includes(code), 'authorization code is never logged');
  assert.ok(!JSON.stringify(audit.body).includes(idToken), 'id_token is not in the audit');
  assert.ok(!JSON.stringify(audit.body).includes(code), 'authorization code is not in the audit');
});

test('expired state reports #sso_error=state_expired', async () => {
  const short = await startTestServer({ logger: createLogger({ quiet: true }), oidcStateTtlSec: 1 });
  try {
    await configureTenant(short, DEMO_KEY, 'demo', `${short.base}/v1/auth/oidc/callback`);
    const authorizationUrl = await start(short, 'demo', '/dashboard/rooms');
    const callbackUrl = await authorize(authorizationUrl);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const location = await callback(short, callbackUrl);
    assert.equal(errorCode(location), 'state_expired');
    assert.equal(location.pathname, '/dashboard/rooms', 'expired state still returns to the tenant dashboard');
  } finally {
    await short.close();
  }
});

/** Complete flow with the given IdP behaviour → `#sso_error` code (null = success). */
async function flowError(options: MockIdpOptions): Promise<string | null> {
  idp.options = options;
  try {
    const location = await callback(ts, await authorize(await start(ts)));
    return errorCode(location);
  } finally {
    idp.options = {};
  }
}

test('state is bound to an HttpOnly browser cookie; a callback without it burns the state', async () => {
  idp.options = {};
  const authorizationUrl = await start(ts);
  const state = authorizationUrl.searchParams.get('state') ?? '';
  assert.match(lastStartSetCookie ?? '', /agil_oidc_binding=[A-Za-z0-9_-]{32,}/, 'binding cookie is set');
  assert.match(lastStartSetCookie ?? '', /; HttpOnly/);
  assert.match(lastStartSetCookie ?? '', /; SameSite=Lax/);
  assert.match(lastStartSetCookie ?? '', /; Path=\/v1\/auth\/oidc/);
  assert.match(lastStartSetCookie ?? '', /; Max-Age=\d+/);
  assert.ok(bindingCookies.has(state), 'cookie stored for the state');

  const callbackUrl = await authorize(authorizationUrl);
  const withoutCookie = await callback(ts, callbackUrl, { cookie: null });
  assert.equal(errorCode(withoutCookie), 'state_invalid', 'login-CSRF: no binding cookie → rejected');
  assert.equal(new URLSearchParams(withoutCookie.hash.replace(/^#/, '')).get('sso_token'), null);

  // The failed attempt consumed the state: even the right cookie cannot replay it.
  const replay = await callback(ts, callbackUrl);
  assert.equal(errorCode(replay), 'state_invalid', 'state was burned by the failed binding');

  const fresh = await start(ts);
  assert.ok(tokenFrom(await callback(ts, await authorize(fresh))), 'a fresh browser-bound flow succeeds');
});

test('cross-origin dashboard start omits binding (documented) and still requires state', async () => {
  idp.options = {};
  const authorizationUrl = await start(ts, 'demo', '/dashboard/', { origin: 'https://dashboard.example' });
  assert.equal(lastStartSetCookie, null, 'cross-origin Set-Cookie would not be stored by the browser');
  const location = await callback(ts, await authorize(authorizationUrl), { cookie: null });
  assert.ok(tokenFrom(location), 'state/nonce/PKCE still protect this flow');
});

test('id_token failures: iss, exp, nbf, iat, typ and azp map to #sso_error', async () => {
  const cases: Array<{ options: MockIdpOptions; label: string }> = [
    { options: { issuer: 'https://evil.example' }, label: 'wrong issuer' },
    { options: { expOffset: -600 }, label: 'expired' },
    { options: { nbfOffset: 600 }, label: 'not yet valid' },
    { options: { iatOffset: 600 }, label: 'iat in the future' },
    { options: { typ: 'at+jwt' }, label: 'access-token typ' },
    { options: { audience: 'another-client' }, label: 'wrong audience' },
    { options: { audience: ['agil-calls', 'other'], azp: 'other' }, label: 'wrong azp' },
    { options: { audience: ['agil-calls', 'other'] }, label: 'multi-aud without azp' },
  ];
  for (const item of cases) {
    assert.equal(await flowError(item.options), 'invalid_identity_token', item.label);
  }

  // Multi-audience is accepted when azp names an audience we trust.
  idp.options = { audience: ['agil-calls', 'other'], azp: 'agil-calls' };
  try {
    assert.ok(tokenFrom(await callback(ts, await authorize(await start(ts)))), 'valid azp accepted');
  } finally {
    idp.options = {};
  }

  // The dashboard treats an explicit false (boolean or string) as a denial and
  // an absent claim as "no opinion".
  assert.equal(await flowError({ verified: 'false' }), 'identity_not_verified');
  assert.equal(await flowError({ omitVerified: true }), null);
});

test('clock skew and maxTokenAgeSec are applied to exp/nbf/iat', async () => {
  // Default 60 s skew: a token that expired 30 s ago is still accepted.
  idp.options = { expOffset: -30 };
  try {
    assert.ok(tokenFrom(await callback(ts, await authorize(await start(ts)))), 'default clock skew accepts 30 s lag');
  } finally {
    idp.options = {};
  }

  await configureTenant(ts, DEMO_KEY, 'demo', `${ts.base}/v1/auth/oidc/callback`, { clockSkewSec: 0 });
  try {
    assert.equal(await flowError({ expOffset: -30 }), 'invalid_identity_token', 'skew=0 rejects 30 s lag');
    assert.ok((await flowError({ expOffset: 30 })) === null, 'skew=0 accepts a token valid 30 s ahead');
  } finally {
    await resetIdentityPolicy();
  }

  await configureTenant(ts, DEMO_KEY, 'demo', `${ts.base}/v1/auth/oidc/callback`, { maxTokenAgeSec: 600 });
  try {
    assert.equal(await flowError({ iatOffset: -1200 }), 'invalid_identity_token', 'token older than max age rejected');
    assert.equal(await flowError({ iatOffset: -300 }), null, 'token within max age accepted');
    assert.equal(await flowError({ omitIat: true }), 'invalid_identity_token', 'missing iat rejected when max age is set');
  } finally {
    await resetIdentityPolicy();
  }
});

test('email/domain allowlist and email_verified are enforced for dashboard login', async () => {
  // An explicit `email_verified:false` denies even with no allowlist configured
  // (P3: the early "no policy" return must not skip it).
  idp.options = {};
  assert.equal(await flowError({ emailVerified: false }), 'identity_not_allowed', 'explicit false without allowlist');
  assert.equal(await flowError({ emailVerified: 'false' }), 'identity_not_allowed', 'string false without allowlist');

  await configureTenant(ts, DEMO_KEY, 'demo', `${ts.base}/v1/auth/oidc/callback`, {
    allowedEmailDomains: ['example.test', '*.corp.example'],
    allowedEmails: ['ceo@other.test'],
  });
  try {
    idp.options = {};
    assert.ok(tokenFrom(await callback(ts, await authorize(await start(ts)))), 'exact domain allowed');
    assert.equal(await flowError({ email: 'USER@EXAMPLE.TEST' }), null, 'allowlist is case-insensitive');
    assert.equal(await flowError({ email: 'admin@team.corp.example' }), null, '*. wildcard allows a subdomain');
    assert.equal(await flowError({ email: 'ceo@other.test' }), null, 'exact allowed email');
    assert.equal(await flowError({ email: 'admin@sub.example.test' }), 'identity_not_allowed', 'plain domain is exact');
    assert.equal(await flowError({ email: 'admin@corp.example' }), 'identity_not_allowed', 'wildcard does not match the bare domain');
    assert.equal(await flowError({ email: 'someone@evil.test' }), 'identity_not_allowed', 'outside allowlist');
    assert.equal(await flowError({ emailVerified: false }), 'identity_not_allowed', 'explicit false always denies');
    assert.equal(await flowError({ omitEmail: true }), 'identity_not_allowed', 'missing email denies');
  } finally {
    idp.options = {};
    await resetIdentityPolicy();
  }

  await configureTenant(ts, DEMO_KEY, 'demo', `${ts.base}/v1/auth/oidc/callback`, { requireEmailVerified: true });
  try {
    assert.equal(await flowError({ omitEmail: true }), 'identity_not_allowed', 'verified email required');
    assert.equal(await flowError({ emailVerified: true }), null, 'verified email accepted');
  } finally {
    await resetIdentityPolicy();
  }
});

test('tenantClaim binds the id_token to the configured tenant', async () => {
  await configureTenant(ts, DEMO_KEY, 'demo', `${ts.base}/v1/auth/oidc/callback`, { tenantClaim: 'tenant' });
  try {
    assert.equal(await flowError({ tenant: 'demo' }), null, 'matching tenant claim accepted');
    assert.equal(await flowError({ tenant: 'acme' }), 'tenant_mismatch', 'cross-tenant replay rejected');
    assert.equal(await flowError({}), 'tenant_mismatch', 'missing tenant claim rejected');
  } finally {
    await resetIdentityPolicy();
  }
});

test('dashboardAdminGroups restricts dashboard login to IdP groups', async () => {
  await configureTenant(ts, DEMO_KEY, 'demo', `${ts.base}/v1/auth/oidc/callback`, {
    dashboardAdminGroups: ['agil-dashboard-admins'],
  });
  try {
    assert.equal(await flowError({ groups: ['agil-dashboard-admins'] }), null, 'admin group accepted');
    assert.equal(await flowError({ groups: ['other-group'] }), 'identity_not_allowed', 'other group rejected');
    assert.equal(await flowError({}), 'identity_not_allowed', 'missing groups rejected');
  } finally {
    await resetIdentityPolicy();
  }
});

test('logout revokes only the current session, is idempotent and audited without tokens', async () => {
  idp.options = {};
  const first = await login(ts);
  const second = await login(ts);
  const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

  assert.equal((await ts.api('GET', '/v1/admin/overview', { headers: auth(first.token) })).status, 200);
  const revoked = await ts.api('POST', '/v1/auth/oidc/logout', { headers: auth(first.token) });
  assert.equal(revoked.status, 204);
  assert.equal((await ts.api('GET', '/v1/admin/overview', { headers: auth(first.token) })).status, 401, 'revoked token');
  assert.equal((await ts.api('GET', '/v1/admin/overview', { headers: auth(second.token) })).status, 200, 'other session survives');

  // Idempotent and no token oracle.
  assert.equal((await ts.api('POST', '/v1/auth/oidc/logout', { headers: auth(first.token) })).status, 204);
  assert.equal((await ts.api('POST', '/v1/auth/oidc/logout')).status, 204);
  assert.equal((await ts.api('POST', '/v1/auth/oidc/logout', { headers: auth('garbage.token.value') })).status, 204);

  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: auth(second.token) });
  assert.equal(audit.status, 200);
  const auditText = JSON.stringify(audit.body);
  assert.ok(auditText.includes('Dashboard SSO logout'), 'logout is audited');
  assert.ok(!auditText.includes(first.token), 'revoked token is not in the audit');
  assert.ok(!auditText.includes(second.token), 'live token is not in the audit');

  const logs = JSON.stringify(logLines);
  assert.ok(!logs.includes(first.token), 'token is never logged');
  assert.ok(!logs.includes(first.token.split('.')[2] ?? 'x'), 'signature is never logged');
});
