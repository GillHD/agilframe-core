/**
 * REST client for explicitly loading and saving an organization's settings.
 */
import { tenantConfigSchema, type TenantConfig } from '@agil/protocol';
import { isRecord, readStorage, writeStorage } from './dom';
import { tr } from './i18n';

export function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

/**
 * Default API base for the editor.
 *
 * In production the editor is served by the AGIL server itself, so the current
 * origin is the only correct default — a hard-coded localhost URL breaks save
 * and emits an unusable embed snippet (QA P1). On a local dev host the API
 * still lives on port 8787.
 */
export function defaultServerUrl(
  locationLike: { hostname: string; origin: string } | null | undefined = typeof window !== 'undefined'
    ? window.location
    : null,
): string {
  if (!locationLike) return 'http://localhost:8787';
  return isLocalHostname(locationLike.hostname) ? 'http://localhost:8787' : locationLike.origin;
}

export const DEFAULT_SERVER_URL = defaultServerUrl();
let activeSession: ServerSettings | null = null;
let publishedConfig: PublishedConfig | null = null;

export function setEditorSession(settings: ServerSettings, config: PublishedConfig): void {
  activeSession = settings;
  publishedConfig = config;
  saveServerSettings(settings);
}

export function getEditorConfig(): PublishedConfig {
  if (!publishedConfig) throw new Error('Editor session has not been verified');
  return publishedConfig;
}

export const SETTINGS_KEYS = {
  serverUrl: 'agil.editor.serverUrl',
  tenantId: 'agil.editor.tenantId',
  apiKey: 'agil.editor.apiKey',
  sessionServer: 'agil.editor.sessionServer',
} as const;

export interface ServerSettings {
  serverUrl: string;
  tenantId: string;
  apiKey: string;
}

export interface ConfigBase {
  serverUrl: string;
  tenantId: string;
  etag: string;
}

interface PublishedConfig {
  config: TenantConfig;
  base: ConfigBase;
}

export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return defaultServerUrl();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

export function loadServerSettings(fallbackTenantId: string): ServerSettings {
  const storedUrl = readStorage(SETTINGS_KEYS.serverUrl);
  const storedTenant = readStorage(SETTINGS_KEYS.tenantId);
  let storedKey: string | null = null;
  try {
    const legacy = readStorage(SETTINGS_KEYS.apiKey);
    storedKey = window.sessionStorage.getItem(SETTINGS_KEYS.apiKey) ?? legacy;
    if (legacy && storedKey) {
      window.sessionStorage.setItem(SETTINGS_KEYS.apiKey, storedKey);
      window.localStorage.removeItem(SETTINGS_KEYS.apiKey);
    }
  } catch {
    // Connecting still works with a freshly entered key.
  }
  const currentLocation = typeof window !== 'undefined' ? window.location : null;
  const localHost = currentLocation ? isLocalHostname(currentLocation.hostname) : true;
  const storedIsLocal = Boolean(
    storedUrl && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(storedUrl),
  );
  return {
    serverUrl:
      storedUrl && storedUrl.trim() && (localHost || !storedIsLocal)
        ? storedUrl
        : defaultServerUrl(currentLocation),
    tenantId: storedTenant && storedTenant.trim() ? storedTenant : fallbackTenantId,
    apiKey: storedKey?.trim() || activeSession?.apiKey || '',
  };
}

export function saveServerSettings(settings: ServerSettings): void {
  writeStorage(SETTINGS_KEYS.serverUrl, settings.serverUrl);
  writeStorage(SETTINGS_KEYS.tenantId, settings.tenantId);
  try {
    window.localStorage.removeItem(SETTINGS_KEYS.apiKey);
    if (settings.apiKey) {
      window.sessionStorage.setItem(SETTINGS_KEYS.apiKey, settings.apiKey);
      window.sessionStorage.setItem(SETTINGS_KEYS.sessionServer, settings.serverUrl);
    } else {
      window.sessionStorage.removeItem(SETTINGS_KEYS.apiKey);
      window.sessionStorage.removeItem(SETTINGS_KEYS.sessionServer);
    }
  } catch {
    // Connecting still works with a freshly entered key.
  }
}

export function buildEmbedSnippet(settings: ServerSettings, scheme: string): string {
  const serverUrl = normalizeServerUrl(settings.serverUrl);
  const tenantId = settings.tenantId.trim() || 'demo';
  return [
    `<script src="${serverUrl}/sdk/agilframe.js"></script>`,
    '<script>',
    `  AgilFrame.mount('#agil-call', { room: 'demo-room', serverUrl: '${serverUrl}', tenantId: '${tenantId}', theme: { scheme: '${scheme}' } });`,
    '</script>',
  ].join('\n');
}

export type SaveResult =
  | { ok: true; etag: string; status: number }
  | { ok: false; message: string; hint?: string; code?: string; status?: number };

interface ApiErrorPayload {
  code: string;
  message: string;
}

function readJsonSafe(response: Response): Promise<unknown> {
  return response
    .text()
    .then((text) => {
      if (!text) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    })
    .catch(() => null);
}

function extractEtag(payload: unknown): string | undefined {
  if (isRecord(payload) && typeof payload.etag === 'string' && payload.etag.length > 0) {
    return payload.etag;
  }
  return undefined;
}

function extractError(payload: unknown): ApiErrorPayload | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  const { code, message } = payload.error;
  if (typeof code !== 'string') return null;
  return { code, message: typeof message === 'string' ? message : code };
}

function hintForStatus(status: number): string {
  if (status === 400) return tr('Сервер отклонил значения: проверьте поля конфигурации.');
  if (status === 401) return tr('Проверьте API-ключ (для разработки — dev-key).');
  if (status === 403) return tr('Ключ не принадлежит этой организации.');
  if (status === 404) return tr('Организация или адрес не найдены — проверьте идентификатор организации (tenantId) и адрес сервера.');
  if (status >= 500) return tr('Ошибка на стороне сервера, попробуйте позже.');
  return tr('Проверьте адрес сервера, идентификатор организации (tenantId) и API-ключ.');
}

const CONFIG_TIMEOUT_MS = 8000;

export async function loadTenantConfig(settings: Pick<ServerSettings, 'serverUrl' | 'tenantId'>): Promise<PublishedConfig> {
  const serverUrl = normalizeServerUrl(settings.serverUrl);
  const tenantId = settings.tenantId.trim();
  if (!tenantId) throw new Error(tr('Укажите идентификатор организации.'));
  const response = await fetch(`${serverUrl}/v1/tenants/${encodeURIComponent(tenantId)}/config`, {
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(hintForStatus(response.status));
  const payload = await readJsonSafe(response);
  const result = tenantConfigSchema.safeParse(isRecord(payload) ? payload.config : null);
  if (!result.success || result.data.tenantId !== tenantId) {
    throw new Error(tr('Сервер вернул неподходящую конфигурацию. Проверьте адрес и идентификатор организации.'));
  }
  const etag = extractEtag(payload);
  if (!etag) throw new Error(tr('Сервер не вернул версию настроек. Обновите Core.'));
  return { config: result.data, base: { serverUrl, tenantId, etag } };
}

/**
 * Tenant-config payload for `PATCH /v1/tenants/:id/config`.
 *
 * `branding.customDomain` is deliberately removed: the raw config endpoint
 * cannot run the DNS-ownership check (TXT token, 409 conflict), so the editor
 * must never move a domain. Domains are managed via
 * `PUT/POST/DELETE /v1/admin/domain` (see `sections/brand.ts` for the operator
 * hint). Other branding fields are forwarded unchanged, and the caller's config
 * object is not mutated.
 */
export function buildTenantPayload(config: TenantConfig, tenantId: string): Record<string, unknown> {
  const { customDomain: _customDomain, ...branding } = config.branding;
  return { ...config, tenantId, branding };
}

export async function saveTenantConfig(
  config: TenantConfig,
  settings: ServerSettings,
  baseEtag: string,
): Promise<SaveResult> {
  const serverUrl = normalizeServerUrl(settings.serverUrl);
  const tenantId = settings.tenantId.trim();
  if (!tenantId) {
    return {
      ok: false,
      message: tr('Не указан идентификатор организации (tenantId).'),
      hint: tr('Заполните поле «Идентификатор организации» справа.'),
    };
  }
  const url = `${serverUrl}/v1/tenants/${encodeURIComponent(tenantId)}/config`;
  const body = JSON.stringify({ editorDraft: buildTenantPayload(config, tenantId), baseEtag });
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey.trim(),
      },
      body,
      signal: controller.signal,
    });
    const payload = await readJsonSafe(response);
    if (response.ok) {
      if (!isRecord(payload) || payload.editorDraftPublished !== true) {
        return {
          ok: false,
          status: response.status,
          message: tr('Этот сервер не поддерживает публикацию черновика редактора. Обновите Core.'),
        };
      }
      const etag = extractEtag(payload) ?? response.headers.get('etag') ?? '—';
      return { ok: true, etag, status: response.status };
    }
    const apiError = extractError(payload);
    if (response.status === 409 && apiError?.code === 'config_conflict') {
      return {
        ok: false,
        status: response.status,
        message: tr('Настройки организации уже изменились. Скачайте черновик, загрузите актуальные настройки и перенесите нужные изменения.'),
      };
    }
    return {
      ok: false,
      status: response.status,
      code: apiError?.code,
      message: apiError?.message ?? tr('Сервер ответил {status} {statusText}', { status: response.status, statusText: response.statusText }).trim(),
      hint: hintForStatus(response.status),
    };
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    const local = typeof window !== 'undefined' && isLocalHostname(window.location.hostname);
    return {
      ok: false,
      message: aborted ? tr('Сервер не ответил за 8 секунд.') : tr('Сервер недоступен.'),
      hint: local
        ? tr('Запустите сервер на localhost:8787 (npm run dev) или измените адрес сервера.')
        : tr('Проверьте, что API доступен на текущем домене (тот же origin), и повторите сохранение.'),
    };
  } finally {
    window.clearTimeout(timer);
  }
}
