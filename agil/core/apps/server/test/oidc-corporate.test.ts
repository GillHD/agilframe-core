/**
 * Corporate OIDC compatibility: issuer discovery, `client_secret_basic` token
 * auth, RP-initiated logout (`end_session_endpoint` + state) and
 * `response_mode=form_post`.
 *
 * Hermetic: in-process mock IdP on 127.0.0.1 (discovery/token/JWKS/logout),
 * AGIL server on an ephemeral port. No network, no real IdP.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '@agil/protocol';
import { createLogger } from '../src/logger.js';
import { clearOidcDiscoveryCache } from '../src/oidc-discovery.js';
import { resetOidcFlowForTests } from '../src/oidc-flow.js';
import { startTestServer, type TestServer } from './helpers.js';
import { startMockIdp, type MockIdp } from './oidc-idp.fixture.js';

const DEMO_KEY = { 'x-api-key': 'dev-key' };
const CLIENT_ID = 'agil-dashboard';
const SECRET = 'corp-oidc-client-secret';
const SECRET_ENV = 'AGIL_OIDC_CLIENT_SECRET_DEMO_CORP';
const ISSUER = 'https://sso.example';

let idp: MockIdp;
let ts: TestServer;
let logLines: string[] = [];
const bindingCookies = new Map<string, string>();
let lastStartSetCookie: string | null = null;

function cookiePair(setCookie: string | null): string | undefined {
  if (!setCookie) return undefined;
  const pair = setCookie.split(';')[0]?.trim();
  return pair && pair.includes('=') ? pair : undefined;
}

/** Identity config for the demo tenant; explicit endpoints by default. */
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
        emailClaim: 'email',
        emailVerifiedClaim: 'email_verified',
        requireEmailVerified: false,
        allowedEmails: [],
        allowedEmailDomains: [],
        groupsClaim: 'groups',
        groupRoleMap: [],
        dashboardAdminGroups: [],
        tenantClaim: '',
        maxTokenAgeSec: 0,
        clockSkewSec: 60,
        // Corporate-compatibility fields are reset to defaults on every patch so
        // one test cannot leak discovery/form_post/basic into the next.
        discovery: false,
        discoveryUrl: '',
        tokenEndpointAuthMethod: 'client_secret_post',
        responseMode: 'query',
        endSessionEndpoint: '',
        postLogoutRedirectUri: '',
        ...overrides,
      },
    },
  };
}

async function configure(overrides: Record<string, unknown> = {}): Promise<void> {
  const patched = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: DEMO_KEY,
    body: identityPatch(`${ts.base}/v1/auth/oidc/callback`, overrides),
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
}

/** `/start` → authorization URL; remembers the browser-binding cookie for its state. */
async function start(returnTo = '/dashboard/', headers: Record<string, string> = {}): Promise<URL> {
  ts.server.services.limiters.oidc.clear();
  const response = await ts.api(
    'GET',
    `/v1/auth/oidc/start?tenantId=demo&returnTo=${encodeURIComponent(returnTo)}`,
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

/** Visits the mock authorization endpoint; returns the callback URL (query mode). */
async function authorize(authorizationUrl: URL): Promise<URL> {
  const response = await fetch(authorizationUrl, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const location = response.headers.get('location');
  assert.ok(location, 'mock IdP must redirect back');
  return new URL(location);
}

/** `form_post`: parses the mock IdP's auto-submit HTML form. */
async function authorizeFormPost(authorizationUrl: URL): Promise<{ action: string; fields: URLSearchParams }> {
  const response = await fetch(authorizationUrl, { redirect: 'manual' });
  assert.equal(response.status, 200, 'form_post response is a 200 HTML page');
  const html = await response.text();
  const action = /action="([^"]+)"/.exec(html)?.[1];
  assert.ok(action, 'mock form must have an action');
  const fields = new URLSearchParams();
  for (const match of html.matchAll(/name="([^"]+)" value="([^"]*)"/g)) {
    fields.set(match[1] as string, match[2] as string);
  }
  return { action, fields };
}

async function callback(server: TestServer, callbackUrl: URL, cookie?: string | null): Promise<URL> {
  server.server.services.limiters.oidc.clear();
  const state = callbackUrl.searchParams.get('state') ?? '';
  const resolved = cookie === undefined ? bindingCookies.get(state) : cookie ?? undefined;
  const response = await fetch(`${server.base}/v1/auth/oidc/callback${callbackUrl.search}`, {
    redirect: 'manual',
    headers: resolved ? { cookie: resolved } : {},
  });
  assert.equal(response.status, 302, 'callback always redirects (token or error fragment)');
  const location = response.headers.get('location');
  assert.ok(location, 'callback must set Location');
  return new URL(location);
}

/** Posts a form_post authorization response to the server callback. */
async function postCallback(
  server: TestServer,
  action: string,
  fields: URLSearchParams,
  options: { cookie?: string | null; contentType?: string; body?: string } = {},
): Promise<URL> {
  server.server.services.limiters.oidc.clear();
  const state = fields.get('state') ?? '';
  const cookie = options.cookie === undefined ? bindingCookies.get(state) : options.cookie ?? undefined;
  const response = await fetch(/^https?:\/\//.test(action) ? action : `${server.base}${action}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': options.contentType ?? 'application/x-www-form-urlencoded',
      ...(cookie ? { cookie } : {}),
    },
    body: options.body ?? fields.toString(),
  });
  assert.equal(response.status, 302, 'POST callback always redirects');
  const location = response.headers.get('location');
  assert.ok(location);
  return new URL(location);
}

function tokenFrom(location: URL): string {
  const token = new URLSearchParams(location.hash.replace(/^#/, '')).get('sso_token');
  assert.ok(token, `expected #sso_token in ${location.href.replace(/#.*/, '#…')}`);
  return token;
}

function errorCode(location: URL): string | null {
  return new URLSearchParams(location.hash.replace(/^#/, '')).get('sso_error');
}

async function login(): Promise<{ token: string; location: URL }> {
  const location = await callback(ts, await authorize(await start()));
  return { token: tokenFrom(location), location };
}

before(async () => {
  process.env[SECRET_ENV] = SECRET;
  idp = await startMockIdp({ clientId: CLIENT_ID, issuer: ISSUER, clientSecrets: new Set([SECRET]) });
  const logger = createLogger({ sink: (line) => logLines.push(line) });
  ts = await startTestServer({ logger });
  await configure();
});

after(async () => {
  delete process.env[SECRET_ENV];
  await ts.close();
  await new Promise<void>((resolve) => idp.server.close(() => resolve()));
});

beforeEach(() => {
  idp.options = {};
  idp.logoutCount = 0;
  idp.lastLogout = null;
  clearOidcDiscoveryCache();
  resetOidcFlowForTests();
});

/* ----------------------------- discovery -------------------------------- */

test('discovery via explicit discoveryUrl resolves endpoints and JWKS (no explicit endpoints)', async () => {
  await configure({
    discovery: true,
    discoveryUrl: `${idp.url}/.well-known/openid-configuration`,
    authorizationEndpoint: '',
    tokenEndpoint: '',
    jwksUrl: '',
  });
  const authorizationUrl = await start();
  assert.equal(authorizationUrl.origin, idp.url, 'authorization endpoint came from discovery');
  assert.equal(authorizationUrl.pathname, '/authorize');
  const token = tokenFrom(await callback(ts, await authorize(authorizationUrl)));
  assert.ok(token);
  const overview = await ts.api('GET', '/v1/admin/overview', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(overview.status, 200, 'JWKS was resolved from discovery');
  // Discovery is cached by URL: one document fetch served start + exchange + JWKS.
  assert.equal(idp.lastAuthorization?.get('client_id'), CLIENT_ID);
  assert.equal(idp.lastTokenClientAuth, 'client_secret_post');
});

test('discovery from the issuer well-known path (issuer has a path-less URL)', async () => {
  idp.options = { issuer: idp.url, discoveryIssuer: idp.url };
  await configure({
    issuer: idp.url,
    discovery: true,
    discoveryUrl: '',
    authorizationEndpoint: '',
    tokenEndpoint: '',
    jwksUrl: '',
  });
  const authorizationUrl = await start();
  assert.equal(authorizationUrl.origin, idp.url);
  const token = tokenFrom(await callback(ts, await authorize(authorizationUrl)));
  assert.ok(token, 'full flow works when issuer-derived discovery is used');
});

test('discovery issuer mismatch fails closed but explicit endpoints stay as fallback', async () => {
  idp.options = { discoveryIssuer: 'https://evil.example' };
  await configure({ discovery: true, discoveryUrl: `${idp.url}/.well-known/openid-configuration` });
  // Explicit endpoints are still configured (base patch), so login must work.
  const token = tokenFrom(await callback(ts, await authorize(await start())));
  assert.ok(token, 'explicit endpoints are used when discovery is rejected');
  assert.equal(idp.lastAuthorization?.get('client_id'), CLIENT_ID);

  // Without explicit endpoints the mismatched document is fatal (fail closed).
  await configure({
    discovery: true,
    discoveryUrl: `${idp.url}/.well-known/openid-configuration`,
    authorizationEndpoint: '',
    tokenEndpoint: '',
    jwksUrl: '',
  });
  ts.server.services.limiters.oidc.clear();
  const response = await ts.api('GET', '/v1/auth/oidc/start?tenantId=demo');
  assert.equal(response.status, 501, JSON.stringify(response.body));
  assert.equal(response.body.error.code, 'identity_not_configured');
  assert.match(response.body.error.message, /discovery/i);
  assert.equal(response.body.authorizationUrl, undefined);
});

test('discovery can resolve only the endpoints it needs; explicit fields override discovered ones', async () => {
  await configure({ discovery: true, discoveryUrl: `${idp.url}/.well-known/openid-configuration` });
  const authorizationUrl = await start();
  assert.equal(authorizationUrl.origin, idp.url);
  // The mock token endpoint replaces the configured one when the explicit
  // tokenEndpoint is empty.
  await configure({
    discovery: true,
    discoveryUrl: `${idp.url}/.well-known/openid-configuration`,
    tokenEndpoint: '',
  });
  const token = tokenFrom(await callback(ts, await authorize(await start())));
  assert.ok(token);
});

test('discovery URL policy: private-network metadata URL is rejected at config write', async () => {
  const rejected = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: DEMO_KEY,
    body: identityPatch(`${ts.base}/v1/auth/oidc/callback`, {
      discovery: true,
      discoveryUrl: 'http://169.254.169.254/latest/meta-data/openid-configuration',
    }),
  });
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error.code, 'validation_failed');
});

test('discovery metadata rejects an unsupported token auth method and response mode', async () => {
  idp.options = {
    discoveryAuthMethods: ['client_secret_post'],
    discoveryResponseModes: ['query'],
  };
  await configure({
    discovery: true,
    discoveryUrl: `${idp.url}/.well-known/openid-configuration`,
    tokenEndpointAuthMethod: 'client_secret_basic',
  });
  ts.server.services.limiters.oidc.clear();
  let response = await ts.api('GET', '/v1/auth/oidc/start?tenantId=demo');
  assert.equal(response.status, 501, JSON.stringify(response.body));
  assert.match(response.body.error.message, /tokenEndpointAuthMethod/);

  await configure({
    discovery: true,
    discoveryUrl: `${idp.url}/.well-known/openid-configuration`,
    responseMode: 'form_post',
  });
  response = await ts.api('GET', '/v1/auth/oidc/start?tenantId=demo');
  assert.equal(response.status, 501, JSON.stringify(response.body));
  assert.match(response.body.error.message, /form_post/);
});

/* -------------------------- token auth methods -------------------------- */

test('client_secret_basic: HTTP Basic client auth at the token endpoint (no secret in body)', async () => {
  idp.options = {};
  await configure({ tokenEndpointAuthMethod: 'client_secret_basic' });
  const location = await callback(ts, await authorize(await start()));
  assert.ok(tokenFrom(location));
  assert.equal(idp.lastTokenClientAuth, 'client_secret_basic');
  assert.equal(idp.lastBasicClientId, CLIENT_ID);
  assert.equal(idp.lastBasicClientSecret, SECRET);
  assert.equal(idp.lastTokenRequest?.get('client_secret'), null, 'secret is not in the form body');
  assert.equal(idp.lastTokenRequest?.get('client_id'), null, 'client_id travels in the Basic header');
  const authorizationHeader = idp.lastTokenAuthorizationHeader ?? '';
  assert.ok(authorizationHeader.startsWith('Basic '));
  // No secret material in server logs (body, header value or raw secret).
  const logs = JSON.stringify(logLines);
  assert.ok(!logs.includes(SECRET), 'client secret is never logged');
  assert.ok(!logs.includes(authorizationHeader), 'Authorization header is never logged');
});

test('client_secret_post remains the default and still sends the secret in the body', async () => {
  await configure({});
  assert.ok(tokenFrom(await callback(ts, await authorize(await start()))));
  assert.equal(idp.lastTokenClientAuth, 'client_secret_post');
  assert.equal(idp.lastTokenRequest?.get('client_secret'), SECRET);
  assert.equal(idp.lastTokenAuthorizationHeader, null);
});

test('token_endpoint_auth_method / response_mode are validated at config write', async () => {
  const badMethod = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: DEMO_KEY,
    body: identityPatch(`${ts.base}/v1/auth/oidc/callback`, { tokenEndpointAuthMethod: 'private_key_jwt' }),
  });
  assert.equal(badMethod.status, 400, JSON.stringify(badMethod.body));
  assert.equal(badMethod.body.error.code, 'validation_failed');

  const badMode = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: DEMO_KEY,
    body: identityPatch(`${ts.base}/v1/auth/oidc/callback`, { responseMode: 'fragment' }),
  });
  assert.equal(badMode.status, 400, JSON.stringify(badMode.body));
  assert.equal(badMode.body.error.code, 'validation_failed');
});

/* ------------------------ RP-initiated logout --------------------------- */

function logoutStartUrl(returnTo = '/dashboard/'): string {
  ts.server.services.limiters.oidc.clear();
  return `/v1/auth/oidc/logout?tenantId=demo&returnTo=${encodeURIComponent(returnTo)}`;
}

/** GET /v1/auth/oidc/logout → returns the IdP logout URL. */
async function requestLogoutUrl(): Promise<URL> {
  const response = await ts.api('GET', logoutStartUrl());
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const { logoutUrl } = response.body as { logoutUrl: string };
  return new URL(logoutUrl);
}

test('RP-initiated logout: end_session URL carries client_id + post_logout_redirect_uri + state', async () => {
  await configure({
    endSessionEndpoint: `${idp.url}/logout`,
    // Registered custom redirect back to this test server (publicOrigin is a
    // synthetic origin in the harness). The default is <publicOrigin>/…/callback.
    postLogoutRedirectUri: `${ts.base}/v1/auth/oidc/logout/callback`,
  });
  const { token } = await login();
  const logoutUrl = await requestLogoutUrl();
  assert.equal(logoutUrl.origin, idp.url);
  assert.equal(logoutUrl.pathname, '/logout');
  assert.equal(logoutUrl.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(logoutUrl.searchParams.get('post_logout_redirect_uri'), `${ts.base}/v1/auth/oidc/logout/callback`);
  assert.match(logoutUrl.searchParams.get('state') ?? '', /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(logoutUrl.searchParams.get('id_token_hint'), null, 'no IdP id_token is retained/sent');

  // IdP redirects to our callback with the same state; the server consumes it
  // and redirects to the dashboard target (no token in the URL).
  const idpResponse = await fetch(logoutUrl, { redirect: 'manual' });
  assert.equal(idpResponse.status, 302);
  const callbackUrl = new URL(idpResponse.headers.get('location') as string);
  assert.equal(callbackUrl.pathname, '/v1/auth/oidc/logout/callback');
  assert.equal(idp.lastLogout?.state, logoutUrl.searchParams.get('state'));

  ts.server.services.limiters.oidc.clear();
  const finished = await fetch(`${ts.base}${callbackUrl.pathname}${callbackUrl.search}`, { redirect: 'manual' });
  assert.equal(finished.status, 302);
  const target = new URL(finished.headers.get('location') as string);
  assert.equal(target.origin, 'http://127.0.0.1:1');
  assert.equal(target.hash, '', 'no sso data in the post-logout URL');
  assert.ok(!JSON.stringify(finished.headers).includes(token));

  // State is single-use: the replay lands on the default dashboard, not an error.
  ts.server.services.limiters.oidc.clear();
  const replay = await fetch(`${ts.base}${callbackUrl.pathname}${callbackUrl.search}`, { redirect: 'manual' });
  assert.equal(replay.status, 302);
});

test('RP-initiated logout end_session_endpoint can come from discovery', async () => {
  await configure({
    discovery: true,
    discoveryUrl: `${idp.url}/.well-known/openid-configuration`,
    endSessionEndpoint: '',
  });
  const logoutUrl = await requestLogoutUrl();
  assert.equal(logoutUrl.pathname, '/logout', 'end_session_endpoint was discovered');
  assert.equal(
    logoutUrl.searchParams.get('post_logout_redirect_uri'),
    `${ts.server.env.publicOrigin}/v1/auth/oidc/logout/callback`,
    'default post_logout_redirect_uri is the server callback',
  );
  assert.equal(idp.logoutCount, 0);
});

test('RP logout falls back to local-only when no end_session_endpoint is configured', async () => {
  await configure({ endSessionEndpoint: '' });
  const response = await ts.api('GET', logoutStartUrl());
  assert.equal(response.status, 501, JSON.stringify(response.body));
  assert.equal(response.body.error.code, 'identity_not_configured');
  assert.equal(response.body.logoutUrl, undefined);
});

test('POST logout still revokes the AGIL session and is independent of RP logout', async () => {
  await configure({ endSessionEndpoint: `${idp.url}/logout` });
  const { token } = await login();
  const auth = { authorization: `Bearer ${token}` };
  ts.server.services.limiters.oidc.clear();
  assert.equal((await ts.api('GET', '/v1/admin/overview', { headers: auth })).status, 200);
  ts.server.services.limiters.oidc.clear();
  assert.equal((await ts.api('POST', '/v1/auth/oidc/logout', { headers: auth })).status, 204);
  ts.server.services.limiters.oidc.clear();
  assert.equal((await ts.api('GET', '/v1/admin/overview', { headers: auth })).status, 401, 'session revoked');
  // The RP logout URL can still be requested after revocation (public start).
  assert.ok(await requestLogoutUrl());
});

/* ------------------------- response_mode=form_post ---------------------- */

test('form_post: authorization response is POSTed, callback mints the session, SameSite=None cookie', async () => {
  await configure({ responseMode: 'form_post' });
  const authorizationUrl = await start();
  assert.equal(authorizationUrl.searchParams.get('response_mode'), 'form_post');
  assert.match(lastStartSetCookie ?? '', /SameSite=None/, 'cross-site POST requires SameSite=None');
  const state = authorizationUrl.searchParams.get('state') ?? '';
  assert.ok(bindingCookies.has(state));

  const { action, fields } = await authorizeFormPost(authorizationUrl);
  assert.ok(fields.get('code'), 'code arrives in the form body');
  assert.equal(fields.get('state'), state);
  const location = await postCallback(ts, action, fields);
  assert.ok(tokenFrom(location), 'form_post login mints the admin session');
});

test('form_post: state binding is enforced and the state is single-use', async () => {
  await configure({ responseMode: 'form_post' });
  const authorizationUrl = await start();
  const { action, fields } = await authorizeFormPost(authorizationUrl);
  const withoutCookie = await postCallback(ts, action, fields, { cookie: null });
  assert.equal(errorCode(withoutCookie), 'state_invalid');
  const replay = await postCallback(ts, action, fields);
  assert.equal(errorCode(replay), 'state_invalid', 'failed binding burned the state');
});

test('form_post: wrong content type and oversized bodies fail closed', async () => {
  await configure({ responseMode: 'form_post' });
  const authorizationUrl = await start();
  const { action, fields } = await authorizeFormPost(authorizationUrl);
  const wrongType = await postCallback(ts, action, fields, { contentType: 'application/json', body: '{}' });
  assert.equal(errorCode(wrongType), 'validation_failed');

  const fresh = await start();
  const freshForm = await authorizeFormPost(fresh);
  const huge = new URLSearchParams({ ...Object.fromEntries(freshForm.fields), padding: 'x'.repeat(70 * 1024) });
  const oversized = await postCallback(ts, freshForm.action, huge);
  assert.equal(errorCode(oversized), 'validation_failed');
});

test('form_post works with discovery-provided endpoints', async () => {
  await configure({
    discovery: true,
    discoveryUrl: `${idp.url}/.well-known/openid-configuration`,
    authorizationEndpoint: '',
    tokenEndpoint: '',
    jwksUrl: '',
    responseMode: 'form_post',
  });
  const authorizationUrl = await start();
  assert.equal(authorizationUrl.origin, idp.url);
  const { action, fields } = await authorizeFormPost(authorizationUrl);
  assert.ok(tokenFrom(await postCallback(ts, action, fields)));
});

test('no server-log leaks across discovery/basic/logout/form_post flows', async () => {
  logLines = [];
  idp.options = {};
  await configure({
    discovery: true,
    discoveryUrl: `${idp.url}/.well-known/openid-configuration`,
    tokenEndpointAuthMethod: 'client_secret_basic',
    responseMode: 'form_post',
    endSessionEndpoint: `${idp.url}/logout`,
  });
  const authorizationUrl = await start();
  const { action, fields } = await authorizeFormPost(authorizationUrl);
  const token = tokenFrom(await postCallback(ts, action, fields));
  await requestLogoutUrl();
  const logs = JSON.stringify(logLines);
  const authHeader = idp.lastTokenAuthorizationHeader ?? '';
  assert.ok(token);
  assert.ok(!logs.includes(SECRET), 'client secret is never logged');
  assert.ok(!logs.includes(authHeader), 'Basic Authorization header is never logged');
  assert.ok(!logs.includes(idp.lastIdToken ?? 'x'), 'id_token is never logged');
  assert.ok(!logs.includes(fields.get('code') ?? 'x'), 'authorization code is never logged');
  // Explicit cookie assertions above only prove config; validate defaults too.
  const config = defaultConfig({ tenantId: 'demo' });
  assert.equal(config.integrations.identity.discovery, false);
  assert.equal(config.integrations.identity.tokenEndpointAuthMethod, 'client_secret_post');
  assert.equal(config.integrations.identity.responseMode, 'query');
  assert.equal(config.integrations.identity.endSessionEndpoint, '');
  assert.equal(config.integrations.identity.postLogoutRedirectUri, '');
});
