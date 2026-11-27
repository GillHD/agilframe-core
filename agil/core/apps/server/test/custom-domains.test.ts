/**
 * P2 custom domains: Host -> tenant resolution, DNS verification, isolation,
 * fallback to the default tenant and the on-demand TLS approval hook.
 *
 * DNS is always faked: no test performs a real lookup and no production DNS is
 * touched. Static artifacts are a throwaway directory so the suite does not
 * depend on `npm run build`.
 *
 * Ownership policy under test (docs/pilot/domain-tls-evidence.md §8.1):
 * - first verification requires the TXT token; a CNAME alone stays pending;
 * - CNAME alone keeps an already verified domain verified (re-check);
 * - a domain whose TXT *and* CNAME are gone is revoked (fail-closed).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openWs, startTestServer, waitForClose, type TestServer } from './helpers.js';
import {
  DomainConflictError,
  DomainRegistry,
  hostFromHeader,
  parseDomain,
  type DomainDnsResolver,
} from '../src/domains.js';
import { hstsHeaderValue, requestHost } from '../src/http.js';
import { loadEnv } from '../src/env.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const ACME = { 'x-api-key': 'acme-key' };

class FakeDns implements DomainDnsResolver {
  readonly txt = new Map<string, string[]>();
  readonly cname = new Map<string, string>();

  async resolveTxt(name: string): Promise<string[][]> {
    const value = this.txt.get(name);
    if (value === undefined) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return [value];
  }

  async resolveCname(name: string): Promise<string[]> {
    const value = this.cname.get(name);
    if (value === undefined) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return [value];
  }
}

let ts: TestServer;
let staticDir: string;
let widgetDir: string;
let dns: FakeDns;

/** On-demand TLS is secret-gated by default (docs/pilot/domain-tls.md §4B). */
const ASK_SECRET = 'main-ask-secret';
const ASK = { 'x-agil-domain-ask-secret': ASK_SECRET };

before(async () => {
  dns = new FakeDns();
  staticDir = mkdtempSync(path.join(tmpdir(), 'agil-domain-static-'));
  writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>host landing</title><div id="host-marker">ok</div>');
  writeFileSync(path.join(staticDir, 'embed.html'), '<!doctype html><title>host embed</title><div id="embed-marker">ok</div>');
  widgetDir = mkdtempSync(path.join(tmpdir(), 'agil-domain-widget-'));
  writeFileSync(path.join(widgetDir, 'agil-calls-widget.js'), 'export const mountWidget = () => {}; // AGIL widget');
  ts = await startTestServer({
    staticDir,
    widgetDir,
    domainResolver: dns,
    domainTarget: 'calls.example.com',
    domainAskSecret: ASK_SECRET,
    // HSTS is only emitted behind a trusted proxy, like production.
    trustProxy: true,
  });
});

after(async () => {
  await ts.close();
  rmSync(staticDir, { recursive: true, force: true });
  rmSync(widgetDir, { recursive: true, force: true });
});

test('host parser and domain validator reject unsafe input', () => {
  assert.equal(hostFromHeader('Meet.Acme.COM:8443'), 'meet.acme.com');
  assert.equal(hostFromHeader('meet.acme.com.'), 'meet.acme.com');
  // FQDN + port (order matters: the root dot follows the port).
  assert.equal(hostFromHeader('meet.acme.com.:443'), 'meet.acme.com');
  assert.equal(hostFromHeader('[::1]:8787'), '::1');
  assert.equal(hostFromHeader(''), '');
  assert.equal(hostFromHeader('bad host'), '');
  assert.equal(hostFromHeader('bad_host.example'), '');
  assert.equal(hostFromHeader('..'), '');
  // A comma is malformed in `Host`, but `X-Forwarded-Host` may be a list.
  assert.equal(hostFromHeader('a.example.com, b.example.com'), '');
  assert.equal(hostFromHeader('a.example.com, b.example.com', { list: true }), 'a.example.com');

  for (const invalid of ['https://meet.example.com', 'meet example.com', 'localhost', '192.168.1.1', 'meet.example.com/path', '*.example.com', 'meet.example.com:443']) {
    assert.equal(parseDomain(invalid).ok, false, `expected invalid: ${invalid}`);
  }
  assert.deepEqual(parseDomain(' Meet.Example.COM. '), { ok: true, domain: 'meet.example.com' });
  assert.deepEqual(parseDomain(''), { ok: true, domain: '' });
  // IDN is punycode-only; the error must tell the operator what to do.
  const idn = parseDomain('пример.рф');
  assert.equal(idn.ok, false);
  if (!idn.ok) assert.match(idn.reason, /punycode/);
  assert.deepEqual(parseDomain('xn--e1afmkfd.xn--p1ai'), { ok: true, domain: 'xn--e1afmkfd.xn--p1ai' });
});

test('proxied host resolution uses X-Forwarded-Host, including comma-separated lists', () => {
  // Trusted proxy: the forwarded host wins over a rewritten `Host`.
  assert.equal(
    requestHost({ 'x-forwarded-host': 'Meet.Example.COM.:443, edge.local:8443', host: '127.0.0.1:8787' }, true),
    'meet.example.com',
  );
  // Malformed forwarded value falls back to the raw Host.
  assert.equal(requestHost({ 'x-forwarded-host': 'bad host', host: 'acme.example.com' }, true), 'acme.example.com');
  // Untrusted: X-Forwarded-Host is ignored entirely.
  assert.equal(
    requestHost({ 'x-forwarded-host': 'attacker.example.net', host: 'meet.example.com' }, false),
    'meet.example.com',
  );
});

test('unknown host falls back to the default tenant; pending domain does not resolve', async () => {
  const unknown = await ts.api('GET', '/v1/host', { host: 'nobody.example.net' });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.resolved, 'default');
  assert.equal(unknown.body.tenantId, 'demo');
  assert.equal(unknown.body.customDomain, '');
  assert.equal(unknown.body.verified, false);
  assert.equal(unknown.body.branding.productName, 'AgilFrame');

  const set = await ts.api('PUT', '/v1/admin/domain', { headers: ADMIN, body: { domain: 'Meet.Example.COM.' } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.domain, 'meet.example.com');
  assert.equal(set.body.status, 'pending');
  assert.equal(set.body.verified, false);
  assert.match(set.body.verification.token, /^[a-f0-9]{32}$/);
  assert.equal(set.body.verification.txt.name, '_agil-calls.meet.example.com');
  assert.equal(set.body.verification.txt.value, `agil-verify=${set.body.verification.token}`);
  assert.equal(set.body.verification.cname.value, 'calls.example.com');
  assert.equal(set.body.dnsInstructions.type, 'CNAME');
  assert.equal(set.body.dnsInstructions.name, 'meet.example.com');
  // The operator hint must say TXT is mandatory for the first verification.
  assert.match(String(set.body.docsHint), /TXT/i);
  assert.match(String(set.body.docsHint), /обязательн/i);

  // The config API sees the same domain; host resolution stays on default until verified.
  assert.equal((await ts.api('GET', '/v1/tenants/demo/config')).body.config.branding.customDomain, 'meet.example.com');
  const pendingHost = await ts.api('GET', '/v1/host', { host: 'meet.example.com' });
  assert.equal(pendingHost.body.resolved, 'default');
  assert.equal(pendingHost.body.tenantId, 'demo');

  // Verification without the DNS record is a 200 pending result with a hint.
  const failed = await ts.api('POST', '/v1/admin/domain/verify', { headers: ADMIN });
  assert.equal(failed.status, 200, JSON.stringify(failed.body));
  assert.equal(failed.body.status, 'pending');
  assert.equal(failed.body.verified, false);
  assert.ok(String(failed.body.verification.lastError).includes('DNS verification failed'));
  assert.match(String(failed.body.verification.lastError), /mandatory for the first verification/);
});

test('first verification: TXT proves ownership; CNAME-only is rejected', async () => {
  // A CNAME pointing at the platform is public information: it must NOT verify
  // a domain that was never proven by its TXT token.
  dns.cname.set('meet.example.com', 'calls.example.com.');
  const cnameOnly = await ts.api('POST', '/v1/admin/domain/verify', { headers: ADMIN });
  assert.equal(cnameOnly.status, 200, JSON.stringify(cnameOnly.body));
  assert.equal(cnameOnly.body.verified, false, 'CNAME-only must not prove ownership');
  assert.equal(cnameOnly.body.status, 'pending');
  assert.equal(cnameOnly.body.verification.method, 'txt');
  assert.match(String(cnameOnly.body.verification.lastError), /mandatory for the first verification/);
  // The pending domain still falls back to the default tenant.
  assert.equal((await ts.api('GET', '/v1/host', { host: 'meet.example.com' })).body.resolved, 'default');

  const current = await ts.api('GET', '/v1/admin/domain', { headers: ADMIN });
  const token = current.body.verification.token as string;
  await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { branding: { productName: 'Meet Demo', organizationName: 'Demo LLC' } },
  });
  dns.txt.set('_agil-calls.meet.example.com', [`agil-verify=${token}`]);
  const verified = await ts.api('POST', '/v1/admin/domain/verify', { headers: ADMIN });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  assert.equal(verified.body.status, 'verified');
  assert.equal(verified.body.verified, true);
  assert.equal(verified.body.verification.method, 'txt');
  assert.equal(typeof verified.body.verification.verifiedAt, 'number');
  assert.equal(verified.body.verification.lastError, undefined);

  const host = await ts.api('GET', '/v1/host', { host: 'meet.example.com:443' });
  assert.equal(host.body.resolved, 'domain');
  assert.equal(host.body.tenantId, 'demo');
  assert.equal(host.body.customDomain, 'meet.example.com');
  assert.equal(host.body.verified, true);
  assert.equal(host.body.branding.productName, 'Meet Demo');

  // Same app/API is served on the custom Host: /embed.html, /widget and /v1/*
  // all stay on one origin (the widget's loader is fetched relatively).
  const embed = await ts.api('GET', '/embed.html', { host: 'meet.example.com' });
  assert.equal(embed.status, 200);
  assert.ok(embed.text.includes('embed-marker'));
  assert.ok(embed.headers.get('content-type')?.includes('text/html'));
  const widgetAsset = await ts.api('GET', '/widget/agil-calls-widget.js', { host: 'meet.example.com' });
  assert.equal(widgetAsset.status, 200);
  assert.ok(widgetAsset.headers.get('content-type')?.includes('javascript'));
  assert.ok(widgetAsset.text.includes('mountWidget'));
  assert.equal((await ts.api('GET', '/v1/health', { host: 'meet.example.com' })).status, 200);

  const audit = await ts.api('GET', '/v1/admin/audit?limit=50&type=domain.verified', { headers: ADMIN });
  assert.equal(audit.status, 200);
  assert.ok(audit.body.entries.length >= 1);
});

test('HSTS: includeSubDomains for the platform host only, omitted on customer hosts', async () => {
  const platform = await ts.api('GET', '/v1/host');
  assert.equal(platform.headers.get('strict-transport-security'), 'max-age=15552000; includeSubDomains');
  const customer = await ts.api('GET', '/v1/host', { host: 'meet.example.com' });
  assert.equal(customer.headers.get('strict-transport-security'), 'max-age=15552000');

  // Pure configuration matrix (no second server needed).
  const env = ts.server.env;
  assert.equal(hstsHeaderValue(env, 'meet.example.com'), 'max-age=15552000');
  assert.equal(hstsHeaderValue(env, '127.0.0.1'), 'max-age=15552000; includeSubDomains');
  assert.equal(
    hstsHeaderValue({ ...env, hstsIncludeSubDomainsCustom: true }, 'meet.example.com'),
    'max-age=15552000; includeSubDomains',
  );
  assert.equal(hstsHeaderValue({ ...env, hstsIncludeSubDomains: false }, '127.0.0.1'), 'max-age=15552000');
  assert.equal(hstsHeaderValue({ ...env, hstsMaxAgeSec: 3600 }, 'meet.example.com'), 'max-age=3600');
  assert.equal(hstsHeaderValue({ ...env, hstsMaxAgeSec: 0 }, '127.0.0.1'), '');
});

test('tenant isolation: second domain needs its own TXT; CNAME re-check keeps it verified', async () => {
  const acmeSet = await ts.api('PUT', '/v1/admin/domain', { headers: ACME, body: { domain: 'acme.example.com' } });
  assert.equal(acmeSet.status, 200, JSON.stringify(acmeSet.body));
  assert.equal(acmeSet.body.status, 'pending');
  assert.equal((await ts.api('GET', '/v1/tenants/acme/config')).body.config.branding.customDomain, 'acme.example.com');
  assert.equal((await ts.api('GET', '/v1/tenants/demo/config')).body.config.branding.customDomain, 'meet.example.com');

  const acmeToken = acmeSet.body.verification.token as string;
  // Another tenant's token cannot verify this domain: the token is per domain.
  dns.txt.set('_agil-calls.acme.example.com', ['agil-verify=deadbeefdeadbeefdeadbeefdeadbeef']);
  const wrongTxt = await ts.api('POST', '/v1/admin/domain/verify', { headers: ACME });
  assert.equal(wrongTxt.body.verified, false);
  assert.equal((await ts.api('GET', '/v1/host', { host: 'acme.example.com' })).body.resolved, 'default');

  dns.txt.set('_agil-calls.acme.example.com', [`agil-verify=${acmeToken}`]);
  // A CNAME alone no longer verifies a first-time domain (checked above for demo).
  dns.cname.set('acme.example.com', 'calls.example.com.');
  const acmeVerify = await ts.api('POST', '/v1/admin/domain/verify', { headers: ACME });
  assert.equal(acmeVerify.status, 200, JSON.stringify(acmeVerify.body));
  assert.equal(acmeVerify.body.verified, true);
  assert.equal(acmeVerify.body.verification.method, 'txt');

  await ts.api('PATCH', '/v1/tenants/acme/config', {
    headers: ACME,
    body: { branding: { productName: 'ACME Meet' }, integrations: { allowedOrigins: ['https://portal.acme.example'] } },
  });

  const acmeHost = await ts.api('GET', '/v1/host', { host: 'acme.example.com' });
  assert.equal(acmeHost.body.resolved, 'domain');
  assert.equal(acmeHost.body.tenantId, 'acme');
  assert.equal(acmeHost.body.branding.productName, 'ACME Meet');

  const demoHost = await ts.api('GET', '/v1/host', { host: 'meet.example.com' });
  assert.equal(demoHost.body.tenantId, 'demo');

  // CNAME-only is allowed for a domain that is already verified: drop the TXT
  // record and re-check — routing stays, ownership was proven earlier.
  dns.txt.delete('_agil-calls.acme.example.com');
  const cnameRecheck = await ts.api('POST', '/v1/admin/domain/verify', { headers: ACME });
  assert.equal(cnameRecheck.body.verified, true, 'CNAME re-check of a verified domain');
  assert.equal(cnameRecheck.body.status, 'verified');
  assert.equal(cnameRecheck.body.verification.method, 'txt');

  // Both records gone -> fail-closed (host stops resolving).
  dns.cname.delete('acme.example.com');
  const revoked = await ts.api('POST', '/v1/admin/domain/verify', { headers: ACME });
  assert.equal(revoked.body.verified, false);
  assert.equal(revoked.body.status, 'pending');
  assert.equal((await ts.api('GET', '/v1/host', { host: 'acme.example.com' })).body.tenantId, 'demo');

  // Restore acme for the remaining tests (TXT + CNAME, the full setup).
  dns.txt.set('_agil-calls.acme.example.com', [`agil-verify=${acmeToken}`]);
  dns.cname.set('acme.example.com', 'calls.example.com.');
  assert.equal((await ts.api('POST', '/v1/admin/domain/verify', { headers: ACME })).body.verified, true);

  // Host-based CORS/frame policy: each tenant's origin allowlist applies only
  // on its own Host (the demo tenant is deliberately given a different origin).
  await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { integrations: { allowedOrigins: ['https://portal.meet.example'] } },
  });
  const acmeEmbed = await ts.api('GET', '/embed.html', {
    host: 'acme.example.com',
    headers: { origin: 'https://portal.acme.example' },
  });
  assert.equal(acmeEmbed.status, 200);
  assert.equal(acmeEmbed.headers.get('access-control-allow-origin'), 'https://portal.acme.example');
  assert.ok(acmeEmbed.headers.get('content-security-policy')?.includes('https://portal.acme.example'));
  const demoEmbed = await ts.api('GET', '/embed.html', {
    host: 'meet.example.com',
    headers: { origin: 'https://portal.acme.example' },
  });
  assert.equal(demoEmbed.headers.get('access-control-allow-origin'), null);

  // The API surface follows the same host-scoped CORS policy as the embed.
  const acmeHostApi = await ts.api('GET', '/v1/host', {
    host: 'acme.example.com',
    headers: { origin: 'https://portal.acme.example' },
  });
  assert.equal(acmeHostApi.headers.get('access-control-allow-origin'), 'https://portal.acme.example');
  const demoHostApi = await ts.api('GET', '/v1/host', {
    host: 'meet.example.com',
    headers: { origin: 'https://portal.acme.example' },
  });
  assert.equal(demoHostApi.headers.get('access-control-allow-origin'), null);

  // Anonymous room creation through a custom domain belongs to that tenant and
  // its links stay on the same origin.
  const created = await ts.api('POST', '/v1/rooms', { host: 'acme.example.com', body: { name: 'ACME sync' } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.room.tenantId, 'acme');
  assert.ok(String(created.body.joinUrl).startsWith('https://acme.example.com/?'));
  assert.ok(String(created.body.embedUrl).startsWith('https://acme.example.com/embed.html?'));

  const sharedHostEmbed = await ts.api('GET', `/embed.html?room=${created.body.room.id}&tenant=acme`, {
    host: 'meet.example.com',
  });
  assert.equal(sharedHostEmbed.headers.get('content-security-policy'), "frame-ancestors 'self' https://portal.acme.example");
  assert.equal(sharedHostEmbed.headers.get('referrer-policy'), 'no-referrer');

  // One domain cannot be stolen by another tenant.
  const conflict = await ts.api('PUT', '/v1/admin/domain', { headers: ADMIN, body: { domain: 'acme.example.com' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'domain_conflict');
});

test('WebSocket Origin: public origin + tenant allowlist + custom domain; null/evil rejected', async () => {
  const created = await ts.api('POST', '/v1/rooms', { host: 'meet.example.com', body: { name: 'WS origin room' } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const roomId = created.body.room.id as string;

  const tokenFor = async (): Promise<string> => {
    const issued = await ts.api('POST', '/v1/tokens', {
      headers: ADMIN,
      body: { tenantId: 'demo', roomId, participant: { name: 'WS origin' } },
    });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    return issued.body.token as string;
  };
  const wsUrl = (token: string): string => `${ts.wsUrl}?token=${encodeURIComponent(token)}`;
  const expectRejected = async (url: string, origin: string | undefined, why: string): Promise<void> => {
    const client = await openWs(url, undefined, origin === undefined ? {} : { origin });
    const error = await client.waitFor((message) => message.type === 'error');
    assert.equal(error.code, 'unauthorized', why);
    assert.equal(await waitForClose(client), 1008, why);
  };

  // Allowed: the tenant's verified custom domain (the page that opened the app).
  const customDomainClient = await openWs(wsUrl(await tokenFor()), undefined, { origin: 'https://meet.example.com' });
  await customDomainClient.waitFor((message) => message.type === 'welcome');
  await customDomainClient.close();

  // Allowed: an origin explicitly listed in the tenant's integrations allowlist.
  const allowedClient = await openWs(wsUrl(await tokenFor()), undefined, { origin: 'https://portal.meet.example' });
  await allowedClient.waitFor((message) => message.type === 'welcome');
  await allowedClient.close();

  // Allowed: AGIL_PUBLIC_ORIGIN (test server publicOrigin).
  const publicClient = await openWs(wsUrl(await tokenFor()), undefined, { origin: 'http://127.0.0.1:1' });
  await publicClient.waitFor((message) => message.type === 'welcome');
  await publicClient.close();

  // Allowed: non-browser SDK with a valid token and no Origin at all.
  const sdkClient = await openWs(wsUrl(await tokenFor()));
  await sdkClient.waitFor((message) => message.type === 'welcome');
  await sdkClient.close();

  // Rejected: a foreign origin, an opaque `null` origin, and another tenant's
  // allowlisted origin (tenant isolation).
  await expectRejected(wsUrl(await tokenFor()), 'https://evil.example', 'foreign origin');
  await expectRejected(wsUrl(await tokenFor()), 'null', 'opaque origin');
  await expectRejected(wsUrl(await tokenFor()), 'https://portal.acme.example', 'another tenant origin');

  // Anonymous WS joins are a browser flow: they need an allowed Origin.
  const anonymousUrl = `${ts.wsUrl}?room=${encodeURIComponent(roomId)}&tenant=demo&name=Guest`;
  const anonymous = await openWs(anonymousUrl, undefined, { origin: 'https://meet.example.com' });
  await anonymous.waitFor((message) => message.type === 'welcome');
  await anonymous.close();
  await expectRejected(anonymousUrl, 'https://evil.example', 'anonymous foreign origin');
  await expectRejected(anonymousUrl, undefined, 'anonymous without Origin');
});

test('generic config PATCH cannot steal a domain or drop the existing host mapping', async () => {
  // The editor saves `branding.customDomain` through PATCH /v1/tenants/:id/config,
  // which bypasses the 409 check in PUT /v1/admin/domain. The registry listener
  // swallows the conflict, so the important invariants are: no takeover, and the
  // admin GET still reports the domain that actually routes traffic.
  const bypass = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { branding: { customDomain: 'acme.example.com' } },
  });
  assert.equal(bypass.status, 200, JSON.stringify(bypass.body));

  const demoDomain = await ts.api('GET', '/v1/admin/domain', { headers: ADMIN });
  assert.equal(demoDomain.status, 200);
  assert.equal(demoDomain.body.domain, 'meet.example.com', 'existing mapping must stay visible');
  assert.equal(demoDomain.body.status, 'verified');
  assert.equal(demoDomain.body.verified, true);

  // Routing is unchanged: each verified host still resolves to its own tenant.
  assert.equal((await ts.api('GET', '/v1/host', { host: 'meet.example.com' })).body.tenantId, 'demo');
  assert.equal((await ts.api('GET', '/v1/host', { host: 'acme.example.com' })).body.tenantId, 'acme');
  const ask = await ts.api('GET', '/v1/domain/ask?domain=acme.example.com', { headers: ASK });
  assert.equal(ask.status, 200);
  assert.equal(ask.body.domain, 'acme.example.com');
  assert.equal('tenantId' in ask.body, false, 'the proxy hook must not disclose the tenant');

  // Restore the demo config for the tests that follow.
  const restored = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { branding: { customDomain: 'meet.example.com' } },
  });
  assert.equal(restored.status, 200);
});

test('invalid host and unverified hosts fall back to the default tenant', async () => {
  for (const host of ['bad host', 'bad_host.example', '..', 'unknown.example.org']) {
    const response = await ts.api('GET', '/v1/host', { host });
    assert.equal(response.status, 200, `host ${host}`);
    assert.equal(response.body.resolved, 'default', `host ${host}`);
    assert.equal(response.body.tenantId, 'demo', `host ${host}`);
  }
  // A wrong token never verifies. Both records must be gone to revoke an
  // already verified domain: the CNAME alone keeps it verified (re-check).
  dns.txt.set('_agil-calls.meet.example.com', ['agil-verify=deadbeef']);
  assert.equal((await ts.api('POST', '/v1/admin/domain', { headers: ADMIN })).body.verified, true);
  dns.cname.delete('meet.example.com');
  const failed = await ts.api('POST', '/v1/admin/domain', { headers: ADMIN });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.status, 'pending');
  assert.equal(failed.body.verified, false);
  const revoked = await ts.api('GET', '/v1/host', { host: 'meet.example.com' });
  assert.equal(revoked.body.resolved, 'default');
  assert.equal(revoked.body.tenantId, 'demo');
});

test('on-demand TLS approval: only verified domains are allowed and tenantId is not leaked', async () => {
  const ok = await ts.api('GET', '/v1/domain/ask?domain=acme.example.com', { headers: ASK });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { allowed: true, domain: 'acme.example.com' });
  assert.equal(ok.text.includes('tenantId'), false);

  assert.equal((await ts.api('GET', '/v1/domain/ask?domain=unknown.example.org', { headers: ASK })).status, 404);
  assert.equal((await ts.api('GET', '/v1/domain/ask?domain=not-a-domain', { headers: ASK })).status, 400);
  assert.equal((await ts.api('GET', '/v1/domain/ask', { headers: ASK })).status, 400);
});

test('published OpenAPI: domain ask requires no tenantId', async () => {
  const spec = await ts.api('GET', '/openapi.json');
  assert.equal(spec.status, 200);
  const schema = spec.body.components.schemas.DomainAskResponse as { required: string[] };
  assert.deepEqual(schema.required, ['allowed', 'domain']);
  assert.equal(schema.required.includes('tenantId'), false);
});

test('on-demand TLS ask: proxy allowlist uses the TCP peer and fails closed', async () => {
  // The allowlist names the proxy socket, never the client behind it. A spoofed
  // X-Forwarded-For that contains an allowed address must NOT pass.
  const deniedDns = new FakeDns();
  const denied = await startTestServer({
    domainResolver: deniedDns,
    domainTarget: 'calls.example.com',
    trustProxy: true,
    domainAskSecret: 'deny-secret',
    domainAskAllowIps: ['10.9.8.7'],
  });
  const broken = await startTestServer({
    // Programmatic overrides bypass env parsing; the handler must still fail
    // closed when a non-empty allowlist contains no valid CIDR. `trustProxy`
    // is on so an external `X-Forwarded-For` cannot be mistaken for "this is
    // the proxy": the gate must stay 403 for an external client as well.
    trustProxy: true,
    domainAskSecret: 'broken-secret',
    domainAskAllowIps: ['typo', '172.17.0.1/33'],
  });
  const DENY_ASK = { 'x-agil-domain-ask-secret': 'deny-secret' };
  const BROKEN_ASK = { 'x-agil-domain-ask-secret': 'broken-secret' };
  try {
    const set = await denied.api('PUT', '/v1/admin/domain', { headers: ADMIN, body: { domain: 'deny.example.com' } });
    deniedDns.txt.set('_agil-calls.deny.example.com', [`agil-verify=${set.body.verification.token}`]);
    assert.equal((await denied.api('POST', '/v1/admin/domain/verify', { headers: ADMIN })).body.verified, true);

    const outside = await denied.api('GET', '/v1/domain/ask?domain=deny.example.com', { headers: DENY_ASK });
    assert.equal(outside.status, 403, 'socket 127.0.0.1 is not in the 10.9.8.7 allowlist');
    const spoofed = await denied.api('GET', '/v1/domain/ask?domain=deny.example.com', {
      headers: { ...DENY_ASK, 'x-forwarded-for': '127.0.0.1' },
    });
    assert.equal(spoofed.status, 403, 'X-Forwarded-For must not satisfy the proxy ACL');
    // Prepend form: a client-supplied first hop (allowed) ahead of the real
    // client IP must still not satisfy the ACL — the socket peer is 127.0.0.1,
    // which is outside the 10.9.8.7 allowlist.
    const prepended = await denied.api('GET', '/v1/domain/ask?domain=deny.example.com', {
      headers: { ...DENY_ASK, 'x-forwarded-for': '127.0.0.1, 203.0.113.7' },
    });
    assert.equal(prepended.status, 403, 'the first X-Forwarded-For hop must not satisfy the proxy ACL');

    const misconfigured = await broken.api('GET', '/v1/domain/ask?domain=anything.example.com', {
      headers: BROKEN_ASK,
    });
    assert.equal(misconfigured.status, 403, 'an all-invalid allowlist must not fail open');
    assert.equal(misconfigured.body.error.code, 'forbidden');

    // Retest P1: an invalid allowlist must reject an external client too — with
    // `AGIL_TRUST_PROXY=1` a client-supplied external XFF must not turn the
    // gate into a 200/404 oracle.
    const misconfiguredExternal = await broken.api('GET', '/v1/domain/ask?domain=anything.example.com', {
      headers: { ...BROKEN_ASK, 'x-forwarded-for': '203.0.113.7' },
    });
    assert.equal(misconfiguredExternal.status, 403, 'invalid allowlist + external client must be 403');
    assert.equal(misconfiguredExternal.body.error.code, 'forbidden');

    // A broken env value is rejected at startup, not silently turned into "*".
    const previous = process.env.AGIL_DOMAIN_ASK_ALLOW_IPS;
    process.env.AGIL_DOMAIN_ASK_ALLOW_IPS = 'not-a-cidr';
    try {
      assert.throws(() => loadEnv(), /no valid IP\/CIDR entries/);
    } finally {
      if (previous === undefined) delete process.env.AGIL_DOMAIN_ASK_ALLOW_IPS;
      else process.env.AGIL_DOMAIN_ASK_ALLOW_IPS = previous;
    }
  } finally {
    await denied.close();
    await broken.close();
  }
});

test('on-demand TLS ask: external request via the proxy cannot pass; secret is mandatory', async () => {
  // Production shape: Caddy forwards *every* path (including /v1/domain/ask) to
  // 127.0.0.1:8787, so the proxy's own ask and an external request share the
  // same TCP peer. Only the Host (Caddy preserves the public Host for proxied
  // requests) and the mandatory secret distinguish them.
  const proxyDns = new FakeDns();
  const proxy = await startTestServer({
    domainResolver: proxyDns,
    domainTarget: 'calls.example.com',
    trustProxy: true,
    domainAskAllowIps: ['127.0.0.1'],
    domainAskSecret: 'proxy-secret',
    domainAskRateLimitPerMin: 100,
  });
  const unsetDns = new FakeDns();
  const unset = await startTestServer({
    domainResolver: unsetDns,
    domainTarget: 'calls.example.com',
    domainAskAllowIps: ['127.0.0.1'],
    // Default: no secret -> the gate is disabled, never public.
  });
  try {
    const set = await proxy.api('PUT', '/v1/admin/domain', { headers: ADMIN, body: { domain: 'proxy.example.com' } });
    proxyDns.txt.set('_agil-calls.proxy.example.com', [`agil-verify=${set.body.verification.token}`]);
    assert.equal((await proxy.api('POST', '/v1/admin/domain/verify', { headers: ADMIN })).body.verified, true);

    // External via Caddy: peer is Caddy (127.0.0.1, allowed), Host is public.
    const externalNoSecret = await proxy.api('GET', '/v1/domain/ask?domain=proxy.example.com', {
      host: 'calls.example.com',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    assert.equal(externalNoSecret.status, 403, 'public Host is not the proxy host');
    const externalGuessedSecret = await proxy.api('GET', '/v1/domain/ask?domain=proxy.example.com&key=guess', {
      host: 'calls.example.com',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    assert.equal(externalGuessedSecret.status, 403);
    // Even a leaked correct secret is useless on the public Host (Host gate).
    const externalWithSecret = await proxy.api('GET', '/v1/domain/ask?domain=proxy.example.com', {
      host: 'calls.example.com',
      headers: { 'x-agil-domain-ask-secret': 'proxy-secret', 'x-forwarded-for': '203.0.113.7' },
    });
    assert.equal(externalWithSecret.status, 403, 'the public site block must not reach the gate');

    // Caddy's own ask: Host is the loopback ask URL; correct secret -> 200.
    const proxyAsk = await proxy.api('GET', '/v1/domain/ask?domain=proxy.example.com', {
      headers: { 'x-agil-domain-ask-secret': 'proxy-secret' },
    });
    assert.equal(proxyAsk.status, 200);
    assert.deepEqual(proxyAsk.body, { allowed: true, domain: 'proxy.example.com' });
    assert.equal('tenantId' in proxyAsk.body, false);

    // No secret configured -> fail closed, even for the proxy host and any key.
    const unsetSet = await unset.api('PUT', '/v1/admin/domain', { headers: ADMIN, body: { domain: 'unset.example.com' } });
    unsetDns.txt.set('_agil-calls.unset.example.com', [`agil-verify=${unsetSet.body.verification.token}`]);
    assert.equal((await unset.api('POST', '/v1/admin/domain/verify', { headers: ADMIN })).body.verified, true);
    assert.equal((await unset.api('GET', '/v1/domain/ask?domain=unset.example.com')).status, 403);
    assert.equal((await unset.api('GET', '/v1/domain/ask?domain=unset.example.com&key=anything')).status, 403);
  } finally {
    await proxy.close();
    await unset.close();
  }
});

test('on-demand TLS ask: failed secrets use a client bucket, not the proxy bucket', async () => {
  const proxyDns = new FakeDns();
  const proxy = await startTestServer({
    domainResolver: proxyDns,
    domainTarget: 'calls.example.com',
    domainAskAllowIps: ['127.0.0.1'],
    domainAskSecret: 'ask-secret-123',
    domainAskRateLimitPerMin: 2,
  });
  try {
    const set = await proxy.api('PUT', '/v1/admin/domain', { headers: ADMIN, body: { domain: 'ask.example.com' } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const token = set.body.verification.token as string;
    proxyDns.txt.set('_agil-calls.ask.example.com', [`agil-verify=${token}`]);
    assert.equal((await proxy.api('POST', '/v1/admin/domain/verify', { headers: ADMIN })).body.verified, true);

    // Wrong-secret attempts are bounded on a separate per-client bucket...
    assert.equal((await proxy.api('GET', '/v1/domain/ask?domain=ask.example.com')).status, 403);
    assert.equal(
      (await proxy.api('GET', '/v1/domain/ask?domain=ask.example.com', {
        headers: { 'x-agil-domain-ask-secret': 'wrong' },
      })).status,
      403,
    );
    const guessLimited = await proxy.api('GET', '/v1/domain/ask?domain=ask.example.com&key=wrong');
    assert.equal(guessLimited.status, 429, 'failed secret attempts are rate-limited');
    assert.ok(Number(guessLimited.headers.get('retry-after')) >= 1);

    // ...so the proxy's authenticated bucket is untouched: its first two asks
    // succeed even after the external flood above (DoS regression).
    const viaHeader = await proxy.api('GET', '/v1/domain/ask?domain=ask.example.com', {
      headers: { 'x-agil-domain-ask-secret': 'ask-secret-123', 'x-forwarded-for': '203.0.113.7' },
    });
    assert.equal(viaHeader.status, 200, 'failed guesses must not consume the proxy bucket');
    assert.deepEqual(viaHeader.body, { allowed: true, domain: 'ask.example.com' });
    assert.equal(viaHeader.body.tenantId, undefined);

    // Query secret is the Caddy-friendly form (`ask ...?key=...`).
    assert.equal((await proxy.api('GET', '/v1/domain/ask?domain=ask.example.com&key=ask-secret-123')).status, 200);

    // Third authenticated call in the window hits the per-peer limit.
    const limited = await proxy.api('GET', '/v1/domain/ask?domain=ask.example.com&key=ask-secret-123');
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'rate_limited');
  } finally {
    await proxy.close();
  }
});

test('verify returns 400 (not 500) for a hand-edited invalid customDomain', async () => {
  // The generic config endpoint only caps the length, so `branding.customDomain`
  // can hold a URL. Verification must reject it as a client error and the admin
  // GET must stay a normal "no domain" response.
  const set = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { branding: { customDomain: 'https://legacy.example.com' } },
  });
  assert.equal(set.status, 200, JSON.stringify(set.body));

  const verify = await ts.api('POST', '/v1/admin/domain/verify', { headers: ADMIN });
  assert.equal(verify.status, 400, JSON.stringify(verify.body));
  assert.equal(verify.body.error.code, 'validation_failed');
  assert.match(String(verify.body.error.message), /bare host|scheme|punycode/i);

  const current = await ts.api('GET', '/v1/admin/domain', { headers: ADMIN });
  assert.equal(current.status, 200);
  assert.equal(current.body.status, 'none');
  assert.equal(current.body.domain, '');
});

test('registry persists verified mapping/token and enforces one domain per tenant', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agil-domains-unit-'));
  const file = path.join(dir, 'domains.json');
  const fake = new FakeDns();
  try {
    const first = new DomainRegistry({ file, publicHost: 'calls.example.com', resolver: fake });
    const record = first.assign('demo', 'unit.example.com');
    assert.match(record.token, /^[a-f0-9]{32}$/);
    assert.equal(first.assign('demo', 'unit.example.com').token, record.token, 'token is stable for the same domain');
    assert.throws(() => first.assign('acme', 'unit.example.com'), DomainConflictError);

    // CNAME alone cannot prove ownership on the first verification.
    fake.cname.set('unit.example.com', 'calls.example.com.');
    const cnameOnly = await first.verify('demo');
    assert.equal(cnameOnly.verified, false);
    assert.match(String(cnameOnly.record.lastError), /mandatory for the first verification/);

    fake.txt.set('_agil-calls.unit.example.com', [`agil-verify=${record.token}`]);
    const verified = await first.verify('demo');
    assert.equal(verified.verified, true);
    assert.equal(verified.record.method, 'txt');
    assert.equal(first.resolveHost('unit.example.com')?.tenantId, 'demo');
    assert.equal(first.resolveHost('unit.example.com:8443')?.tenantId, 'demo');

    // CNAME-only keeps an already verified domain verified (re-check).
    fake.txt.delete('_agil-calls.unit.example.com');
    assert.equal((await first.verify('demo')).verified, true);
    // Both records gone -> pending (fail-closed).
    fake.cname.delete('unit.example.com');
    assert.equal((await first.verify('demo')).verified, false);
    // Restore TXT for the persistence checks below.
    fake.txt.set('_agil-calls.unit.example.com', [`agil-verify=${record.token}`]);
    assert.equal((await first.verify('demo')).verified, true);

    // A new registry instance loads the persisted mapping and token.
    const second = new DomainRegistry({ file, publicHost: 'calls.example.com', resolver: fake });
    assert.equal(second.resolveHost('unit.example.com')?.tenantId, 'demo');
    assert.equal(second.getForTenant('demo')?.token, record.token);
    assert.equal(second.getForTenant('demo')?.status, 'verified');

    const renamed = second.assign('demo', 'next.example.com');
    assert.notEqual(renamed.token, record.token);
    assert.equal(second.resolveHost('unit.example.com'), null);
    assert.equal(second.getForTenant('demo')?.domain, 'next.example.com');
    assert.equal(second.remove('demo'), true);
    assert.equal(second.getForTenant('demo'), null);
    assert.equal(second.remove('demo'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy verified record without verifiedAt survives a CNAME-only recheck', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agil-domains-legacy-'));
  const file = path.join(dir, 'domains.json');
  const fake = new FakeDns();
  try {
    // Older/hand-edited registries may carry status:"verified" without the
    // verifiedAt timestamp. Status is the proof of a previous successful check.
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        domains: {
          'legacy.example.com': {
            domain: 'legacy.example.com',
            tenantId: 'demo',
            status: 'verified',
            token: 'a'.repeat(32),
            method: 'txt',
            createdAt: 1,
          },
        },
      }),
    );
    const registry = new DomainRegistry({ file, publicHost: 'calls.example.com', resolver: fake });
    assert.equal(registry.resolveHost('legacy.example.com')?.tenantId, 'demo');
    fake.cname.set('legacy.example.com', 'calls.example.com.');
    const recheck = await registry.verify('demo');
    assert.equal(recheck.verified, true);
    assert.equal(recheck.record.status, 'verified');
    assert.equal(typeof recheck.record.verifiedAt, 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('advertised CNAME target is normalised (scheme/port/case/trailing dot)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agil-domains-target-'));
  const fake = new FakeDns();
  try {
    // Operators paste a full origin, an FQDN and sometimes a port. All three
    // must resolve to the same advertised target, otherwise CNAME verification
    // (which compares against the DNS answer) can never match.
    const registry = new DomainRegistry({
      file: path.join(dir, 'a.json'),
      publicHost: 'https://Calls.Example.COM.:443',
      resolver: fake,
    });
    assert.equal(registry.publicHost, 'calls.example.com');
    const record = registry.assign('demo', 'target.example.com');
    assert.equal(registry.instructions(record).cname.value, 'calls.example.com');
    assert.equal(registry.instructions(record).cname.name, 'target.example.com');

    // A CNAME-only first verification proves routing, not ownership: it stays
    // pending until the mandatory TXT token is published.
    fake.cname.set('target.example.com', 'Calls.Example.COM.');
    const rejected = await registry.verify('demo');
    assert.equal(rejected.verified, false);
    assert.equal(rejected.record.status, 'pending');
    assert.equal(rejected.expectedCname, 'calls.example.com');
    assert.equal(registry.resolveHost('TARGET.example.com.'), null);

    // TXT + CNAME passes and reports the TXT ownership method.
    fake.txt.set('_agil-calls.target.example.com', [record.token]);
    const verified = await registry.verify('demo');
    assert.equal(verified.verified, true);
    assert.equal(verified.record.method, 'txt');
    assert.equal(registry.resolveHost('TARGET.example.com.')?.tenantId, 'demo');

    // A value that is not a host name falls back to the documented default.
    const fallback = new DomainRegistry({
      file: path.join(dir, 'b.json'),
      publicHost: 'not a host',
      resolver: fake,
    });
    assert.equal(fallback.publicHost, 'calls.example.com');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
