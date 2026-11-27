import './styles.css';
import { DEFAULT_SERVER_URL, isLocalHostname, loadServerSettings, loadTenantConfig, saveServerSettings, setEditorSession, SETTINGS_KEYS } from './api';
import { applyStaticI18n, tr } from './i18n';
import { loadEditorTheme, watchSystemEditorTheme } from './state';

const root = document.documentElement;
root.dataset.theme = loadEditorTheme();
const stopWatchingTheme = watchSystemEditorTheme((theme) => { root.dataset.theme = theme; });
applyStaticI18n();

const access = document.querySelector<HTMLElement>('#editor-access')!;
const form = document.querySelector<HTMLFormElement>('#editor-access-form')!;
const server = document.querySelector<HTMLInputElement>('#editor-access-server')!;
const key = document.querySelector<HTMLInputElement>('#editor-access-key')!;
const error = document.querySelector<HTMLElement>('#editor-access-error')!;
const submit = document.querySelector<HTMLButtonElement>('#editor-access-submit')!;
const saved = loadServerSettings('demo');
server.value = saved.serverUrl === DEFAULT_SERVER_URL && !import.meta.env.DEV ? location.origin : saved.serverUrl;

function savedCredentialMatches(): boolean {
  try {
    const verifiedOrigin = sessionStorage.getItem(SETTINGS_KEYS.sessionServer);
    return serverOrigin(server.value) === (verifiedOrigin ? serverOrigin(verifiedOrigin) : location.origin);
  } catch {
    return false;
  }
}

function serverOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHostname(url.hostname)))) {
    throw new Error(tr('Укажите адрес HTTPS сервера.'));
  }
  return url.origin;
}

async function unlock(value: string, apiKey: string): Promise<void> {
  const serverUrl = serverOrigin(value);
  const response = await fetch(`${serverUrl}/v1/admin/overview`, {
    headers: { 'x-api-key': apiKey },
    credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  if (response.status === 401 || response.status === 403) throw new Error(tr('Ключ организации не принят.'));
  if (!response.ok) throw new Error(tr('Не удалось проверить доступ к редактору.'));
  const data: { tenantId?: unknown } = await response.json();
  if (typeof data.tenantId !== 'string' || !data.tenantId) {
    throw new Error(tr('Не удалось проверить доступ к редактору.'));
  }
  const settings = { serverUrl, tenantId: data.tenantId, apiKey };
  setEditorSession(settings, await loadTenantConfig(settings));
  await import('./main');
  stopWatchingTheme();
  root.removeAttribute('data-editor-locked');
  access.hidden = true;
  key.value = '';
}

function showError(cause: unknown): void {
  error.textContent = cause instanceof TypeError || !(cause instanceof Error)
    ? tr('Не удалось проверить доступ к редактору.') : cause.message;
  error.hidden = false;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (submit.disabled || !key.value.trim()) return;
  submit.disabled = true;
  error.hidden = true;
  void unlock(server.value.trim(), key.value.trim()).catch((cause: unknown) => {
    showError(cause);
    key.focus();
  }).finally(() => { submit.disabled = false; });
});

document.querySelector('#editor-sign-out')?.addEventListener('click', () => {
  saveServerSettings({ ...loadServerSettings('demo'), apiKey: '' });
  location.reload();
});

if (saved.apiKey && savedCredentialMatches()) {
  void unlock(server.value, saved.apiKey).catch((cause: unknown) => {
    saveServerSettings({ ...saved, apiKey: '' });
    showError(cause);
    form.hidden = false;
    key.focus();
  });
} else {
  form.hidden = false;
  key.focus();
}
