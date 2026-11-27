/**
 * External URL policy (SSRF baseline).
 *
 * Accepts only `http(s)` URLs and — in production mode (`NODE_ENV=production`
 * or `AGIL_TRUST_PROXY=1`) — only public HTTPS hosts. Private / loopback /
 * link-local / metadata hostnames are rejected; URLs with embedded credentials
 * are always rejected.
 *
 * Hostname/IP-literal checks only: no DNS resolution, so DNS-rebinding is not
 * covered here (run behind an egress proxy).
 */
import { isIP } from 'node:net';
import { isAllowedOidcClientSecretEnv, isOidcClientSecretEnvBoundToTenant, type TenantConfig, type TenantConfigPatch } from '@agil/protocol';
import type { Env } from './env.js';
import { HttpError } from './http.js';
import { validateTenantSecretEnvRefs } from './secret-env.js';

export interface UrlPolicyOptions {
  /** Production mode: HTTPS only and public hosts only. */
  secure: boolean;
}

export type UrlValidation = { ok: true; url: URL } | { ok: false; reason: string };

const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata',
  'instance-data',
]);

type HostClass = 'loopback' | 'private' | 'public';

function classifyIpv4(host: string): HostClass {
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return 'public';
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return 'loopback';
  if (a === 0 || a === 10 || a === 169) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && (b === 168 || (b === 0 && (parts[2] === 0 || parts[2] === 2)))) return 'private';
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && parts[2] === 100))) return 'private';
  if (a === 203 && b === 0 && parts[2] === 113) return 'private';
  if (a >= 224) return 'private'; // multicast / reserved
  return 'public';
}

function classifyHost(hostname: string): HostClass {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === 'localhost.localdomain' || host === 'ip6-localhost' || host.endsWith('.localhost')) {
    return 'loopback';
  }
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.local') || host.endsWith('.internal')) return 'private';

  const version = isIP(host);
  if (version === 4) return classifyIpv4(host);
  if (version === 6) {
    const normalized = host.toLowerCase();
    if (normalized === '::1' || normalized === '::') return 'loopback';
    if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return 'private'; // unique local fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(normalized)) return 'private'; // link-local fe80::/10
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized);
    if (mapped?.[1]) return classifyIpv4(mapped[1]);
    return 'public';
  }
  return 'public';
}

/** True when the server runs in "production-secure" mode. */
export function isSecureMode(env: Pick<Env, 'trustProxy'>): boolean {
  return (process.env.NODE_ENV ?? '').toLowerCase() === 'production' || env.trustProxy;
}

/** Validates one external endpoint URL. Never throws. */
export function validateExternalUrl(raw: string, options: UrlPolicyOptions): UrlValidation {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, reason: 'URL is empty' };
  if (value.length > 2048) return { ok: false, reason: 'URL is too long' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'URL is malformed' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `Unsupported URL scheme: ${url.protocol}` };
  }
  if (url.username || url.password) return { ok: false, reason: 'URL must not contain credentials' };
  const hostClass = classifyHost(url.hostname);
  if (options.secure) {
    if (url.protocol !== 'https:') return { ok: false, reason: 'HTTPS is required in production mode' };
    if (hostClass !== 'public') return { ok: false, reason: 'Private/loopback hosts are not allowed in production mode' };
  } else if (hostClass === 'private') {
    // Dev mode still blocks RFC1918/link-local/metadata addresses (SSRF baseline);
    // loopback stays available so local webhook receivers can be tested.
    return { ok: false, reason: 'Private network hosts are not allowed' };
  }
  return { ok: true, url };
}

/** Throws 400 `validation_failed` for a bad external URL. */
export function assertExternalUrl(raw: string, options: UrlPolicyOptions, field = 'url'): URL {
  const result = validateExternalUrl(raw, options);
  if (!result.ok) throw new HttpError(400, 'validation_failed', `Invalid ${field}: ${result.reason}`, [{ path: field, message: result.reason }]);
  return result.url;
}

export interface NetworkEndpointOptions {
  /** Production mode: TLS-only protocols and public hosts. */
  secure: boolean;
  /** Accepted URL protocols, e.g. `['https:', 'http:']` or `['wss:', 'ws:']`. */
  schemes: readonly string[];
  /** Apply the SSRF host policy (server-called endpoints only). */
  applyHostPolicy: boolean;
}

/**
 * Validates one server-configured network endpoint. This is the shared policy
 * used by `PUT /v1/admin/scale` and by tenant-config writes (PATCH/PUT), so a
 * tenant admin cannot bypass the SIP SSRF/TLS checks.
 */
export function validateNetworkEndpoint(raw: string, options: NetworkEndpointOptions): UrlValidation {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, reason: 'URL is empty' };
  if (value.length > 2048) return { ok: false, reason: 'URL is too long' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'URL is malformed' };
  }
  if (url.username || url.password) return { ok: false, reason: 'URL must not contain credentials' };
  if (!options.schemes.includes(url.protocol)) {
    return { ok: false, reason: `Unsupported scheme ${url.protocol}; expected ${options.schemes.join(', ')}` };
  }
  const tls = url.protocol === 'https:' || url.protocol === 'wss:' || url.protocol === 'turns:' || url.protocol === 'rtmps:';
  if (options.secure && !tls) {
    return { ok: false, reason: 'TLS is required in production mode (https/wss/turns/rtmps)' };
  }
  if (!options.applyHostPolicy) return { ok: true, url };
  // Reuse the SSRF host policy on an HTTPS representation of the endpoint.
  const probe = `https://${url.hostname}${url.port ? `:${url.port}` : ''}/`;
  return validateExternalUrl(probe, { secure: options.secure });
}

/** The SIP gateway fields that are subject to the outbound URL policy. */
export interface SipEndpointConfig {
  httpUrl?: string;
  wsUrl?: string;
}

/**
 * Validates `scale.sip.httpUrl`/`wsUrl` with the shared policy. Used for full
 * tenant/admin configs and for per-room `configOverrides`, which do not pass
 * through `TenantStore`.
 */
export function validateSipEndpoints(
  sip: SipEndpointConfig | undefined | null,
  options: UrlPolicyOptions,
): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  if (!sip || typeof sip !== 'object') return issues;
  const check = (raw: unknown, path: string, schemes: readonly string[], applyHostPolicy: boolean): void => {
    if (typeof raw !== 'string' || !raw.trim()) return;
    const result = validateNetworkEndpoint(raw, { ...options, schemes, applyHostPolicy });
    if (!result.ok) issues.push({ path, message: result.reason });
  };
  // httpUrl is called by this server, so the SSRF host policy applies. wsUrl is
  // advertised to clients (a private/corporate SFU is legitimate); TLS is still
  // required in secure mode.
  check(sip.httpUrl, 'scale.sip.httpUrl', ['https:', 'http:'], true);
  check(sip.wsUrl, 'scale.sip.wsUrl', ['https:', 'wss:', 'http:', 'ws:'], false);
  return issues;
}

/** Validates every outbound endpoint stored in a tenant config. */
export function validateConfigEndpoints(
  config: TenantConfig,
  options: UrlPolicyOptions,
  /** Tenant-bound OIDC secret names (`AGIL_OIDC_TENANT_SECRETS`); omit in unit tests. */
  oidc?: Pick<Env, 'oidcTenantSecrets'>,
): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  const check = (raw: string, path: string, optional = true): void => {
    if (!raw || !raw.trim()) {
      if (!optional) issues.push({ path, message: 'URL is required' });
      return;
    }
    const result = validateExternalUrl(raw, options);
    if (!result.ok) issues.push({ path, message: result.reason });
  };
  check(config.session.aiAgent.endpoint, 'session.aiAgent.endpoint');
  check(config.session.knowledgeAgent.endpoint, 'session.knowledgeAgent.endpoint');
  config.integrations.webhooks.forEach((webhook, index) => {
    check(webhook.url, `integrations.webhooks.${index}.url`, false);
  });
  check(config.integrations.siem.url, 'integrations.siem.url');
  // OIDC endpoints are outbound server calls during the SSO code exchange; the
  // redirect URI is browser-facing and validated separately by the flow.
  check(config.integrations.identity.authorizationEndpoint, 'integrations.identity.authorizationEndpoint');
  check(config.integrations.identity.tokenEndpoint, 'integrations.identity.tokenEndpoint');
  check(config.integrations.identity.jwksUrl, 'integrations.identity.jwksUrl');
  // Optional discovery metadata URL and RP-initiated logout endpoint are also
  // fetched/redirected by the server and must satisfy the same outbound policy.
  check(config.integrations.identity.discoveryUrl, 'integrations.identity.discoveryUrl');
  check(config.integrations.identity.endSessionEndpoint, 'integrations.identity.endSessionEndpoint');
  // A tenant may only name a server-owned env var for the OIDC client secret
  // (`process.env` is otherwise an arbitrary-secret read primitive), and the
  // name must be bound to this tenant so `demo` cannot select
  // `AGIL_OIDC_CLIENT_SECRET_ACME_*` and exfiltrate acme's secret.
  const clientSecretEnv = config.integrations.identity.clientSecretEnv;
  if (!isAllowedOidcClientSecretEnv(clientSecretEnv)) {
    issues.push({
      path: 'integrations.identity.clientSecretEnv',
      message:
        'clientSecretEnv must be empty or a name in the AGIL_OIDC_CLIENT_SECRET[_*] namespace bound to this tenant',
    });
  } else if (
    !isOidcClientSecretEnvBoundToTenant(
      clientSecretEnv,
      config.tenantId,
      oidc?.oidcTenantSecrets ?? {},
    )
  ) {
    issues.push({
      path: 'integrations.identity.clientSecretEnv',
      message:
        'clientSecretEnv must be bound to this tenant: AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME> or an AGIL_OIDC_TENANT_SECRETS entry',
    });
  }
  // SIP gateway URLs: same policy as PUT /v1/admin/scale and room overrides.
  issues.push(...validateSipEndpoints(config.scale?.sip, options));
  // Tenant config may only *name* server-owned env vars for every secret
  // reference (AI/knowledge/in-call agents, providers, webhooks, SIEM, SFU,
  // TURN); `process.env[name]` is otherwise an arbitrary-secret read primitive.
  issues.push(...validateTenantSecretEnvRefs(config));
  return issues;
}

/** Throws 400 with all endpoint issues when any outbound URL is unsafe. */
export function assertConfigEndpoints(config: TenantConfig, env: Env): void {
  const issues = validateConfigEndpoints(config, { secure: isSecureMode(env) }, env);
  if (issues.length > 0) {
    throw new HttpError(400, 'validation_failed', 'Invalid external endpoint configuration', issues);
  }
}

/**
 * Validates per-room `configOverrides` before the room (and its effective
 * config) exists. Room overrides bypass `TenantStore`, so an unsafe
 * `scale.sip.httpUrl` — from a tenant admin or an anonymous client when
 * `AGIL_ALLOW_ANONYMOUS=1` — must not reach a private/loopback/metadata host.
 */
export function assertConfigOverrideEndpoints(overrides: TenantConfigPatch | undefined, env: Env): void {
  const issues = [
    ...validateSipEndpoints(overrides?.scale?.sip, { secure: isSecureMode(env) }),
    // Room overrides also carry secret references (session agents, scale);
    // apply the same allowlist so an override write cannot bypass it.
    ...validateTenantSecretEnvRefs(overrides),
  ];
  if (issues.length > 0) {
    throw new HttpError(400, 'validation_failed', 'Invalid external endpoint configuration', issues);
  }
}

/** Plain config warning used for env-level URLs (AGIL_INTEGRITY_URL). */
export function checkEnvExternalUrl(env: Env, raw: string, name: string): string | null {
  const result = validateExternalUrl(raw, { secure: isSecureMode(env) });
  return result.ok ? null : `${name}: ${result.reason}`;
}
