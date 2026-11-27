/**
 * Dashboard SSO helpers (OIDC authorization-code login).
 *
 * The server redirects back to the dashboard with the admin session in the URL
 * **fragment** (`#sso_token=…`), which browsers never send to a server and
 * which we strip from the address bar before the first render. The token is
 * written to sessionStorage only, never into the DOM and never into logs.
 *
 * Error redirects carry a stable code (`#sso_error=…`); `ssoErrorInfo()` maps it
 * to Russian copy. Nothing in this module trusts the URL beyond those two keys.
 */
import { getTenantId } from './auth.js';
import { AdminApi, normalizeBaseUrl } from './api.js';

export const SSO_TOKEN_PARAM = 'sso_token';
export const SSO_ERROR_PARAM = 'sso_error';
/** Landing route after a successful login / after stripping the fragment. */
export const SSO_LANDING_HASH = '#/overview';
/** Defensive bounds: a session JWT is ~4–8 KB; error codes stay small/strict. */
const MAX_SSO_TOKEN_LENGTH = 16_384;
const SSO_ERROR_CODE_RE = /^[a-z0-9_]{1,64}$/;

export interface SsoFragment {
  token?: string;
  error?: string;
}

/**
 * Reads `#sso_token=` / `#sso_error=` from the current URL. Returns null for
 * ordinary router hashes (`#/rooms`), so normal navigation is untouched.
 */
export function readSsoFragment(): SsoFragment | null {
  const hash = window.location.hash;
  if (hash.length < 2 || !hash.startsWith('#sso_')) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(hash.slice(1));
  } catch {
    return null;
  }
  const rawToken = params.get(SSO_TOKEN_PARAM) ?? '';
  const rawError = (params.get(SSO_ERROR_PARAM) ?? '').trim().toLowerCase();
  // Reject anything outside the two expected keys' shape: never trust the URL.
  if (rawToken.length > MAX_SSO_TOKEN_LENGTH) return null;
  const token = rawToken.trim();
  const error = SSO_ERROR_CODE_RE.test(rawError) ? rawError : '';
  if (!token && !error) return null;
  return {
    ...(token ? { token } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * Parses the SSO fragment and immediately rewrites the address bar so the token
 * does not linger in history/URLs (state/PKCE is single-use anyway). A malformed
 * or oversized `#sso_*` fragment is stripped too — it is never rendered, but it
 * must not stay in the URL either.
 */
export function consumeSsoFragment(): SsoFragment | null {
  const fragment = readSsoFragment();
  // Ordinary router hashes (`#/rooms`) are navigation, not SSO data: do not
  // touch them. Any `#sso_*` hash is consumed/stripped even when readSsoFragment
  // rejected its content (oversized token, invalid error code).
  if (!fragment && !window.location.hash.startsWith('#sso_')) return null;
  try {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${SSO_LANDING_HASH}`);
  } catch {
    /* history is unavailable (sandboxed iframe) — hash fallback below */
    window.location.hash = SSO_LANDING_HASH;
  }
  return fragment;
}

/** URL the IdP sends the browser back to: the dashboard page without a hash. */
export function ssoReturnTo(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

/** Only http(s) authorization URLs are followed (never `javascript:`/`data:`). */
export function isSafeAuthorizationUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export interface SsoErrorInfo {
  title: string;
  message: string;
  hint?: string;
}

const SSO_ERRORS: Record<string, SsoErrorInfo> = {
  state_invalid: {
    title: 'Ссылка входа недействительна',
    message: 'Состояние входа (state) не найдено: ссылка уже использована или открыта в другом браузере.',
    hint: 'Начните вход заново кнопкой «Войти через SSO». Окно входа живёт 10 минут и срабатывает один раз.',
  },
  state_expired: {
    title: 'Время входа истекло',
    message: 'С момента начала входа прошло больше 10 минут, поэтому состояние входа удалено.',
    hint: 'Повторите вход через SSO — это займёт несколько секунд.',
  },
  access_denied: {
    title: 'Провайдер входа отклонил запрос',
    message: 'IdP вернул access_denied: вход отменён или у учётной записи нет доступа к приложению.',
    hint: 'Проверьте доступ к приложению в корпоративном IdP или попробуйте снова.',
  },
  idp_error: {
    title: 'Провайдер входа недоступен',
    message: 'Не удалось обменять код входа на токен: IdP вернул ошибку или не ответил вовремя.',
    hint: 'Повторите вход. Если ошибка повторяется — проверьте authorizationEndpoint/tokenEndpoint и секрет клиента на сервере.',
  },
  invalid_identity_token: {
    title: 'Токен входа не прошёл проверку',
    message: 'id_token отклонён: неверная подпись, издатель, аудитория, nonce или срок действия.',
    hint: 'Проверьте issuer/audience/clientId и часы на сервере IdP; затем войдите заново.',
  },
  identity_not_verified: {
    title: 'Учётная запись не подтверждена',
    message: 'Корпоративный IdP пометил учётную запись как неподтверждённую (verifiedClaim=false).',
    hint: 'Обратитесь к администратору IdP, чтобы подтвердить учётную запись.',
  },
  identity_not_allowed: {
    title: 'Учётная запись не имеет доступа',
    message:
      'Email или группа входа не входят в разрешённый список организации: проверьте allowedEmailDomains, allowedEmails и dashboardAdminGroups.',
    hint: 'Обратитесь к администратору организации: он добавит ваш домен/адрес или группу в настройках входа.',
  },
  tenant_mismatch: {
    title: 'Токен выдан для другой организации',
    message: 'id_token относится к другому tenant: сервер отклонил вход, чтобы исключить повтор токена между организациями.',
    hint: 'Проверьте issuer/audience/clientId организации и claim tenantClaim в настройках входа.',
  },
  identity_not_configured: {
    title: 'SSO не настроен',
    message: 'Для организации не заданы параметры OIDC или отсутствует секрет клиента в переменной окружения.',
    hint: 'Администратор указывает authorizationEndpoint, tokenEndpoint, clientId, clientSecretEnv и jwksUrl в разделе «Интеграции».',
  },
  validation_failed: {
    title: 'Сервер отклонил вход',
    message: 'Параметры входа не прошли проверку (например, адрес возврата не входит в доверенные).',
    hint: 'Проверьте адрес панели в «Настройках» и список allowedOrigins организации.',
  },
  session_expired: {
    title: 'SSO-сессия истекла',
    message: 'Срок действия сессии истёк или сервер её не принял (сессии короткоживущие).',
    hint: 'Войдите снова через SSO.',
  },
};

/** Friendly copy for a `#sso_error=` code (unknown codes fall back to IdP error). */
export function ssoErrorInfo(code: string | undefined): SsoErrorInfo {
  if (!code || !SSO_ERROR_CODE_RE.test(code)) return SSO_ERRORS.idp_error as SsoErrorInfo;
  return SSO_ERRORS[code] ?? {
    title: 'Вход через SSO не выполнен',
    message: 'Сервер не завершил вход через SSO. Токен и код входа в адресную строку не попадают.',
    hint: 'Повторите вход через SSO или войдите по API-ключу.',
  };
}

/** Maps an `ApiError` from the SSO start call to the same copy model. */
export function ssoStartErrorInfo(error: { code?: string; status?: number; message?: string }): SsoErrorInfo {
  if (error.code === 'offline' || error.code === 'timeout') {
    return {
      title: 'Сервер недоступен',
      message: error.message ?? 'Не удалось связаться с сервером AgilFrame.',
      hint: 'Проверьте адрес сервера и запущен ли он.',
    };
  }
  if (error.code === 'identity_not_configured' || error.status === 501) {
    return SSO_ERRORS.identity_not_configured as SsoErrorInfo;
  }
  return {
    title: 'Не удалось начать вход через SSO',
    message: error.message ?? 'Сервер отклонил запрос входа.',
    hint: 'Проверьте адрес сервера и настройки OIDC организации.',
  };
}

export interface StartSsoInput {
  serverUrl: string;
  tenantId?: string;
}

/**
 * Asks the server for an authorization URL. The caller redirects the browser;
 * this function never navigates by itself and never returns the token.
 */
export async function requestAuthorizationUrl(input: StartSsoInput): Promise<string> {
  const baseUrl = normalizeBaseUrl(input.serverUrl);
  const tenantId = (input.tenantId ?? getTenantId()).trim();
  const api = new AdminApi({ baseUrl });
  const response = await api.oidcStart(tenantId, ssoReturnTo());
  if (!isSafeAuthorizationUrl(response.authorizationUrl)) {
    throw new Error('Сервер вернул некорректный адрес входа (ожидался http(s)).');
  }
  return response.authorizationUrl;
}

/**
 * Asks the server for the IdP RP-initiated logout URL. Returns `null` when the
 * tenant has no `end_session_endpoint` (501), the server is unreachable, or the
 * response URL is not http(s) — the caller always keeps the local logout, so a
 * failure here only means the corporate IdP session is not ended.
 */
export async function requestLogoutUrl(input: StartSsoInput): Promise<string | null> {
  const baseUrl = normalizeBaseUrl(input.serverUrl);
  const tenantId = (input.tenantId ?? getTenantId()).trim();
  const api = new AdminApi({ baseUrl });
  try {
    const response = await api.oidcLogoutStart(tenantId, ssoReturnTo());
    return isSafeAuthorizationUrl(response.logoutUrl) ? response.logoutUrl : null;
  } catch {
    // Not configured / offline / transient IdP error: local logout is enough.
    return null;
  }
}
