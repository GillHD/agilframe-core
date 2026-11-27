/**
 * Credentials storage + connection check for the login screen.
 *
 * Keys (localStorage):
 *   agil_server_url — admin/public API base;
 *   agil_api_key    — tenant API key (`dev-key` by default on a dev server);
 *   agil_sso_token  — short-lived admin session JWT from the OIDC login
 *                     (sent as `Authorization: Bearer`, never rendered);
 *   agil_tenant_id  — tenant resolved from GET /v1/admin/overview.
 *
 * Secrets never leave this module except into an `AdminApi`/form value and are
 * never logged.
 */
import type { AdminOverview } from '@agil/protocol';
import { AdminApi, API_TIMEOUT_MS, DEFAULT_API_KEY, normalizeBaseUrl } from './api.js';
import { currentOrigin } from './format.js';
import { t } from './i18n.js';
import { readCredential, readStorage, removeStorage, storeCredential, writeStorage } from './storage.js';

export function validateServerUrl(value: string): string | null {
  const trimmed = value.trim();
  const example = isLocalDevHost() ? 'http://localhost:8787' : 'https://calls.example.com';
  if (!trimmed) return t('login.validate.emptyServer', { example });
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return t('login.validate.protocol');
    if (url.username || url.password || url.search || url.hash) return t('login.validate.serverParts');
    return null;
  } catch {
    return t('login.validate.invalidServer', { example });
  }
}

export const STORAGE_SERVER_URL = 'agil_server_url';
export const STORAGE_API_KEY = 'agil_api_key';
export const STORAGE_SSO_TOKEN = 'agil_sso_token';
export const STORAGE_TENANT_ID = 'agil_tenant_id';
export const STORAGE_PLATFORM_HINT = 'agil_platform_mode';
export const DEFAULT_TENANT_ID = 'demo';

export interface StoredCredentials {
  serverUrl: string;
  apiKey: string;
  tenantId: string;
  /** SSO-issued admin session (Bearer); mutually exclusive with `apiKey` in practice. */
  ssoToken?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs: number;
  overview?: AdminOverview;
  /** True for a platform-key session (checked against /v1/admin/tenants). */
  platform?: boolean;
  error?: unknown;
}

export function getServerUrl(): string {
  const stored = readStorage(STORAGE_SERVER_URL);
  return stored && stored.trim() ? normalizeBaseUrl(stored) : currentOrigin();
}

export function getStoredApiKey(): string | null {
  const stored = readCredential(STORAGE_API_KEY);
  return stored && stored.trim() ? stored : null;
}

/** SSO admin session token (Bearer), or null. Never rendered into the DOM. */
export function getSsoToken(): string | null {
  const stored = readCredential(STORAGE_SSO_TOKEN);
  return stored && stored.trim() ? stored : null;
}

export function isSsoSession(): boolean {
  return getSsoToken() !== null;
}

/** Stores the SSO session token after the server has accepted it. */
export function saveSsoSession(token: string): void {
  if (token.trim()) storeCredential(STORAGE_SSO_TOKEN, token.trim());
}

export function clearSsoToken(): void {
  storeCredential(STORAGE_SSO_TOKEN, '');
}

/** True when any credential (API key or SSO session) is stored. */
export function hasStoredSession(): boolean {
  return getStoredApiKey() !== null || getSsoToken() !== null;
}

export function getTenantId(): string {
  const stored = readStorage(STORAGE_TENANT_ID);
  return stored && stored.trim() ? stored : DEFAULT_TENANT_ID;
}

/** Explicit platform-key marker from login (needed while /v1/admin/tenants is 404). */
export function getPlatformHint(): boolean {
  return readStorage(STORAGE_PLATFORM_HINT) === '1';
}

export function setPlatformHint(enabled: boolean): void {
  if (enabled) writeStorage(STORAGE_PLATFORM_HINT, '1');
  else removeStorage(STORAGE_PLATFORM_HINT);
}

/**
 * True only for local development hosts. Production must never pre-fill
 * `dev-key`: a browser autocompleting/keeping it leads to `dev-key<key>` and 401.
 */
export function isLocalDevHost(): boolean {
  try {
    const host = window.location.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

/**
 * Pre-fills the login form: a stored key wins (it is the user's own), but the
 * demo `dev-key` is offered only on localhost/127.0.0.1. On production the field
 * stays empty (placeholder is only a hint).
 */
export function getPrefilledApiKey(): string {
  const stored = getStoredApiKey();
  if (stored) {
    // Never resurrect the local demo key on a production host.
    if (!isLocalDevHost() && stored.trim() === DEFAULT_API_KEY) return '';
    return stored;
  }
  return isLocalDevHost() ? DEFAULT_API_KEY : '';
}

/** Full stored credentials, or null when neither a key nor an SSO session exists. */
export function loadCredentials(): StoredCredentials | null {
  const apiKey = getStoredApiKey();
  const ssoToken = getSsoToken();
  if (!apiKey && !ssoToken) return null;
  return {
    serverUrl: getServerUrl(),
    apiKey: apiKey ?? '',
    tenantId: getTenantId(),
    ...(ssoToken ? { ssoToken } : {}),
  };
}

export function saveCredentials(credentials: StoredCredentials): void {
  writeStorage(STORAGE_SERVER_URL, normalizeBaseUrl(credentials.serverUrl));
  storeCredential(STORAGE_API_KEY, credentials.apiKey.trim());
  writeStorage(STORAGE_TENANT_ID, credentials.tenantId);
  storeCredential(STORAGE_SSO_TOKEN, credentials.ssoToken?.trim() ?? '');
}

/** Logout: forget the key, the SSO session and the tenant; keep the server URL. */
export function clearCredentials(): void {
  storeCredential(STORAGE_API_KEY, '');
  storeCredential(STORAGE_SSO_TOKEN, '');
  removeStorage(STORAGE_TENANT_ID);
  removeStorage(STORAGE_PLATFORM_HINT);
}

/** "Сбросить настройки" in the settings screen. */
export function resetAllSettings(): void {
  removeStorage(STORAGE_SERVER_URL);
  storeCredential(STORAGE_API_KEY, '');
  storeCredential(STORAGE_SSO_TOKEN, '');
  removeStorage(STORAGE_TENANT_ID);
  removeStorage(STORAGE_PLATFORM_HINT);
}

/** Checks credentials with GET /v1/admin/overview — never throws. */
export async function testConnection(
  serverUrl: string,
  apiKey: string,
  timeoutMs = API_TIMEOUT_MS,
  platformMode = false,
): Promise<TestConnectionResult> {
  const startedAt = Date.now();
  const api = new AdminApi({ baseUrl: serverUrl, apiKey, timeoutMs });
  try {
    if (platformMode) {
      const tenants = await api.tenants();
      if (!tenants.platform) {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: new Error('Ключ принят, но он не является платформенным. Включите обычный режим и войдите как организация.'),
        };
      }
      return { ok: true, platform: true, latencyMs: Date.now() - startedAt };
    }
    const overview = await api.overview();
    return { ok: true, overview, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error, latencyMs: Date.now() - startedAt };
  }
}
