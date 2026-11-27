/**
 * Login screen: server URL + API key, "Проверить подключение" via
 * GET /v1/admin/overview, and «Войти через SSO» (OIDC authorization code).
 * Works offline: shows exact start instructions.
 */
import { DEFAULT_API_KEY, normalizeBaseUrl } from '../api.js';
import {
  STORAGE_SERVER_URL,
  getPlatformHint,
  getPrefilledApiKey,
  getServerUrl,
  getTenantId,
  isLocalDevHost,
  setPlatformHint,
  testConnection,
  validateServerUrl,
  type StoredCredentials,
} from '../auth.js';
import { h, setButtonLoading } from '../dom.js';
import { describeError } from '../errors.js';
import { currentOrigin } from '../format.js';
import { languageLabel, languageSwitchTitle, t, toggleLocale } from '../i18n.js';
import { icon } from '../icons.js';
import { publicLinks } from '../links.js';
import { requestAuthorizationUrl, ssoErrorInfo, ssoStartErrorInfo } from '../sso.js';
import { writeStorage } from '../storage.js';
import type { ThemeController, ThemeMode } from '../theme.js';
import { button, checkboxField, field, textInput } from '../ui/controls.js';
import { alert, offlinePanel } from './common.js';

export interface LoginOptions {
  theme: ThemeController;
  /** Error from the automatic connection probe (e.g. server offline). */
  initialError?: unknown;
  /** The stored session was in platform-key mode (affects the 401/403 text). */
  platformHint?: boolean;
  /** Stable code from `#sso_error=` (bad state, IdP failure, expired session). */
  ssoError?: string;
  wikiPlatform?: { serverUrl: string; onCancel: () => void };
  onSuccess: (credentials: StoredCredentials) => void;
}

export function renderLogin(options: LoginOptions): { el: HTMLElement; destroy: () => void } {
  // `<main>` gives the login page the missing landmark (WCAG 1.3.1/2.4.1) and
  // the heading id names it for assistive technology.
  const page = h('main', { class: 'auth-page', attrs: { 'aria-labelledby': 'auth-title' } });
  const localDev = isLocalDevHost();
  document.title = t('login.title');

  /* ------------------------- theme switch (top-right) ------------------------ */
  const modes: ReadonlyArray<{ mode: ThemeMode; label: string; iconName: 'monitor' | 'sun' | 'moon' }> = [
    { mode: 'auto', label: t('theme.auto'), iconName: 'monitor' },
    { mode: 'light', label: t('theme.light'), iconName: 'sun' },
    { mode: 'dark', label: t('theme.dark'), iconName: 'moon' },
  ];
  const themeSwitch = h('div', { class: 'theme-switch', attrs: { role: 'group', 'aria-label': t('theme.group') } });
  const themeButtons = new Map<ThemeMode, HTMLButtonElement>();
  for (const item of modes) {
    const node = h('button', {
      class: 'theme-option',
      attrs: { type: 'button', title: item.label, 'aria-label': item.label, 'aria-pressed': 'false' },
      on: { click: () => options.theme.setMode(item.mode) },
    });
    node.appendChild(icon(item.iconName, 15));
    themeSwitch.appendChild(node);
    themeButtons.set(item.mode, node);
  }
  const syncTheme = (): void => {
    for (const [mode, node] of themeButtons) {
      node.setAttribute('aria-pressed', mode === options.theme.getMode() ? 'true' : 'false');
    }
  };
  syncTheme();
  const stopTheme = options.theme.onChange(syncTheme);
  page.appendChild(h('div', { class: 'auth-theme' }, themeSwitch));

  /* --------------------------------- card ---------------------------------- */
  const card = h('div', { class: 'auth-card' });
  card.append(
    h(
      'div',
      { class: 'auth-brand' },
      h('img', {
        class: 'brand-mark',
        attrs: {
          src: `${import.meta.env.BASE_URL}branding/agil-icon-256.png`,
          alt: '',
          width: 46,
          height: 46,
          decoding: 'async',
        },
      }),
      h(
        'div',
        {},
        h('h1', { class: 'auth-title', text: t(options.wikiPlatform ? 'wiki.platformSignIn' : 'login.title'), attrs: { id: 'auth-title' } }),
        h('p', { class: 'auth-sub', text: t(options.wikiPlatform ? 'wiki.platformHint' : 'login.subtitle') }),
      ),
    ),
  );

  // Alerts sit at the top of the card: probe failures and #sso_error= results
  // must be visible without scrolling past the whole form.
  const alertBox = h('div', { attrs: { 'aria-live': 'polite', id: 'login-alert' } });
  card.appendChild(alertBox);

  const serverInput = textInput({
    value: options.wikiPlatform?.serverUrl ?? getServerUrl(),
    type: 'url',
    autocomplete: 'url',
    spellcheck: false,
    placeholder: localDev ? t('login.serverPlaceholder') : t('login.serverPlaceholderProd'),
  });
  serverInput.id = 'login-server-url';
  serverInput.required = true;
  serverInput.readOnly = Boolean(options.wikiPlatform);
  serverInput.setAttribute('aria-required', 'true');

  const keyInput = textInput({
    value: options.wikiPlatform ? '' : getPrefilledApiKey(),
    type: 'password',
    autocomplete: 'off',
    spellcheck: false,
    placeholder: localDev ? t('login.keyPlaceholder') : t('login.keyPlaceholderProd'),
  });
  keyInput.id = 'login-api-key';
  keyInput.required = true;
  keyInput.setAttribute('aria-required', 'true');

  const devKeyWarning = h('span', {
    class: 'field-error',
    attrs: { hidden: '', role: 'status' },
    text: t('login.devKeyWarning'),
  });
  const syncDevKeyWarning = (): void => {
    if (!localDev && keyInput.value.trim() === DEFAULT_API_KEY) devKeyWarning.removeAttribute('hidden');
    else devKeyWarning.setAttribute('hidden', '');
  };
  keyInput.addEventListener('input', syncDevKeyWarning);

  const revealKey = button(undefined, {
    variant: 'ghost',
    icon: 'eye',
    title: t('login.keyShow'),
    onClick: () => {
      const reveal = keyInput.type === 'password';
      keyInput.type = reveal ? 'text' : 'password';
      revealKey.replaceChildren(icon(reveal ? 'eye-off' : 'eye', 16));
      revealKey.title = reveal ? t('login.keyHide') : t('login.keyShow');
      revealKey.setAttribute('aria-label', revealKey.title);
    },
  });

  const submit = button(t(options.wikiPlatform ? 'wiki.signIn' : 'login.submit'), { variant: 'primary', type: 'submit', icon: 'check' });
  let cancelled = false;
  let checking = false;
  let checkingSso = false;
  const actions = h('div', { class: 'actions' }, submit);
  const cancelWikiLogin = (): void => {
    cancelled = true;
    keyInput.value = '';
    options.wikiPlatform?.onCancel();
  };
  const cancelOnEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
    event.preventDefault();
    cancelWikiLogin();
  };
  if (options.wikiPlatform) {
    actions.append(button(t('wiki.back'), { onClick: cancelWikiLogin }));
    window.addEventListener('keydown', cancelOnEscape);
  }

  const form = h('form', { class: 'auth-form', attrs: { novalidate: true } });
  const keyLabel = t(options.wikiPlatform ? 'wiki.platformKey' : 'login.keyLabel');
  const keyField = h('div', { class: 'field' },
    h('label', { class: 'field-label', attrs: { for: keyInput.id }, text: `${keyLabel} *` }),
    h('div', { class: 'key-row' }, keyInput, revealKey),
    h('span', { class: 'field-hint', text: localDev ? t('login.keyHintLocal') : t('login.keyHint') }),
  );
  keyField.appendChild(devKeyWarning);
  syncDevKeyWarning();
  const platformInput = checkboxField({
    label: t('login.platformLabel'),
    description: t('login.platformDescription'),
    checked: getPlatformHint(),
  });
  const platformCheckbox = platformInput.querySelector('input[type="checkbox"]');
  form.append(
    field(t('login.serverLabel'), serverInput, {
      hint: localDev ? t('login.serverHintLocal') : t('login.serverHint'),
      required: true,
    }),
    keyField,
    h(
      'div',
      { class: 'auth-hint' },
      icon('lock', 16),
      h('span', { text: t('login.privacy') }),
    ),
    actions,
  );
  if (!options.wikiPlatform) keyField.after(platformInput);
  card.appendChild(form);

  /* ------------------------------ SSO (OIDC) ------------------------------ */
  // Kept outside the <form>: the SSO button performs a full-page redirect to the
  // corporate IdP and must never submit the API-key form.
  const tenantInput = textInput({
    value: getTenantId(),
    autocomplete: 'off',
    spellcheck: false,
    placeholder: 'demo',
  });
  tenantInput.id = 'login-sso-tenant';
  const ssoButton = button(t('login.ssoButton'), { variant: 'ghost', icon: 'shield-check' });
  ssoButton.id = 'login-sso-button';
  const setCredentialsPending = (pending: boolean): void => {
    // Keep the displayed credentials in sync with the request until it finishes.
    serverInput.readOnly = pending || Boolean(options.wikiPlatform);
    keyInput.readOnly = pending;
    tenantInput.readOnly = pending;
    if (platformCheckbox instanceof HTMLInputElement) platformCheckbox.disabled = pending;
  };
  const ssoStatus = h('div', { attrs: { id: 'login-sso-status', 'aria-live': 'polite' } });
  const ssoBlock = h(
    'div',
    { class: 'sso-block' },
    h('div', { class: 'auth-divider', attrs: { role: 'separator' } }, h('span', { text: t('login.ssoDivider') })),
    h('p', { class: 'sso-lead', text: t('login.ssoLead') }),
    h(
      'div',
      { class: 'sso-row' },
      field(t('login.tenantLabel'), tenantInput, {
        hint: t('login.tenantHint'),
      }),
      h('div', { class: 'sso-actions' }, ssoButton),
    ),
    ssoStatus,
    h(
      'div',
      { class: 'auth-hint' },
      icon('key', 16),
      h('span', { text: t('login.ssoHint') }),
    ),
  );
  if (!options.wikiPlatform) card.appendChild(ssoBlock);

  const links = publicLinks(serverInput.value);
  card.appendChild(
    h(
      'div',
      { class: 'auth-footer' },
      h('a', { attrs: { href: links.demo, target: '_blank', rel: 'noopener noreferrer' }, text: t('login.footerDemo') }),
      h('a', { attrs: { href: links.editor, target: '_blank', rel: 'noopener noreferrer' }, text: t('login.footerEditor') }),
      h('a', { attrs: { href: links.apiDocs, target: '_blank', rel: 'noopener noreferrer' }, text: t('login.footerDocs') }),
      h('span', { class: 'spacer' }),
      button(languageLabel(), {
        variant: 'ghost',
        size: 'sm',
        className: 'lang-btn auth-lang',
        title: languageSwitchTitle(),
        ariaLabel: languageSwitchTitle(),
        onClick: () => toggleLocale(),
      }),
      h('span', { text: `API: ${currentOrigin()}` }),
    ),
  );

  page.appendChild(card);

  /* ------------------------------- actions --------------------------------- */
  const markInvalid = (input: HTMLElement): void => {
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', 'login-alert');
  };
  const clearInvalid = (): void => {
    for (const input of [serverInput, keyInput]) {
      input.removeAttribute('aria-invalid');
      if (input.getAttribute('aria-describedby') === 'login-alert') input.removeAttribute('aria-describedby');
    }
  };
  const showAlert = (kind: 'info' | 'danger', title: string, message?: string): void => {
    alertBox.replaceChildren(alert(kind, title, message));
  };
  const clearAlert = (): void => {
    alertBox.replaceChildren();
    ssoStatus.replaceChildren();
    clearInvalid();
  };

  /** Shows an SSO failure as a prominent, accessible alert (never tokens/URLs). */
  const showSsoFailure = (info: { title: string; message: string; hint?: string }, target = alertBox): void => {
    target.replaceChildren(alert('danger', info.title, [info.message, info.hint].filter(Boolean).join(' ')));
  };

  const runSso = async (): Promise<void> => {
    if (cancelled || checking || checkingSso) return;
    clearAlert();
    const urlError = validateServerUrl(serverInput.value);
    if (urlError) {
      markInvalid(serverInput);
      showAlert('danger', t('login.error.serverTitle'), urlError);
      serverInput.focus();
      return;
    }
    const normalized = normalizeBaseUrl(serverInput.value);
    serverInput.value = normalized;
    // The callback lands on a fresh page load: remember the server now so the
    // new page talks to the same AGIL Calls instance.
    writeStorage(STORAGE_SERVER_URL, normalized);
    checkingSso = true;
    setCredentialsPending(true);
    submit.disabled = true;
    setButtonLoading(ssoButton, true);
    try {
      const authorizationUrl = await requestAuthorizationUrl({
        serverUrl: normalized,
        tenantId: tenantInput.value,
      });
      if (cancelled) return;
      // Full-page navigation to the corporate IdP; the token comes back in the
      // URL fragment of `returnTo` and is stripped by main.ts on load.
      window.location.assign(authorizationUrl);
    } catch (error) {
      if (cancelled) return;
      checkingSso = false;
      setCredentialsPending(false);
      submit.disabled = false;
      setButtonLoading(ssoButton, false);
      showSsoFailure(
        ssoStartErrorInfo(error as { code?: string; status?: number; message?: string }),
        ssoStatus,
      );
      ssoStatus.scrollIntoView({ block: 'nearest' });
    }
  };

  ssoButton.addEventListener('click', () => {
    void runSso();
  });

  const runCheck = async (): Promise<void> => {
    if (cancelled || checking || checkingSso) return;
    clearAlert();
    const urlError = validateServerUrl(serverInput.value);
    if (urlError) {
      markInvalid(serverInput);
      showAlert('danger', t('login.error.serverTitle'), urlError);
      serverInput.focus();
      return;
    }
    const normalized = normalizeBaseUrl(serverInput.value);
    serverInput.value = normalized;

    const apiKey = keyInput.value.trim();
    keyInput.value = apiKey;
    syncDevKeyWarning();
    if (!apiKey) {
      markInvalid(keyInput);
      showAlert('danger', t('login.error.keyTitle'), t('login.error.keyEmpty'));
      keyInput.focus();
      return;
    }
    if (!localDev && apiKey === DEFAULT_API_KEY) {
      markInvalid(keyInput);
      showAlert('danger', t('login.error.demoKeyTitle'), t('login.error.demoKey'));
      keyInput.focus();
      return;
    }
    checking = true;
    setCredentialsPending(true);
    ssoButton.disabled = true;
    setButtonLoading(submit, true);
    const platformMode = Boolean(options.wikiPlatform || (platformCheckbox instanceof HTMLInputElement && platformCheckbox.checked));
    const result = await testConnection(normalized, apiKey, undefined, platformMode);
    if (cancelled) return;
    checking = false;
    setCredentialsPending(false);
    ssoButton.disabled = false;
    setButtonLoading(submit, false);

    if (result.ok && (result.overview || result.platform)) {
      setPlatformHint(platformMode);
      options.onSuccess({
        serverUrl: normalized,
        apiKey,
        tenantId: result.overview?.tenantId ?? 'platform',
      });
      return;
    }

    const info = describeError(result.error, { platform: platformMode });
    if (info.offline) {
      alertBox.replaceChildren(
        alert('danger', info.title, `${info.message} ${info.hint ?? ''}`.trim()),
        offlinePanel(() => {
          void runCheck();
        }),
      );
      return;
    }
    showAlert('danger', info.title, [info.message, info.hint].filter(Boolean).join(' '));
    if (info.unauthorized) {
      markInvalid(keyInput);
      keyInput.focus();
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void runCheck();
  });

  let initialFocus = options.wikiPlatform ? keyInput : serverInput;

  if (options.ssoError) {
    // Returned from the IdP callback with `#sso_error=…`: explain the failure
    // and let the user retry via the SSO button above.
    showSsoFailure(ssoErrorInfo(options.ssoError));
  } else if (options.initialError !== undefined) {
    const info = describeError(options.initialError, { platform: options.platformHint ?? getPlatformHint() });
    if (info.offline) {
      alertBox.replaceChildren(
        alert('danger', info.title, `${info.message} ${info.hint ?? ''}`.trim()),
        offlinePanel(() => {
          void runCheck();
        }),
      );
    } else {
      alertBox.replaceChildren(alert('danger', info.title, [info.message, info.hint].filter(Boolean).join(' ')));
      if (info.unauthorized) {
        markInvalid(keyInput);
        initialFocus = keyInput;
      }
    }
  }

  const focusTimer = window.setTimeout(() => initialFocus.focus(), 0);
  return { el: page, destroy: () => {
    cancelled = true;
    keyInput.value = '';
    if (options.wikiPlatform) window.removeEventListener('keydown', cancelOnEscape);
    stopTheme();
    window.clearTimeout(focusTimer);
  } };
}
