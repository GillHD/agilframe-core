// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Dashboard bootstrap: theme, auth gate, hash router and the app shell.
 *
 * Route map (#/...): overview, rooms, rooms/:id, security, audit, access,
 * integrations, knowledge, recordings, settings.
 */
import './styles.css';
import { AdminApi, ApiError, normalizeBaseUrl } from './api.js';
import {
  clearCredentials,
  clearSsoToken,
  getPlatformHint,
  getPrefilledApiKey,
  getServerUrl,
  getSsoToken,
  getTenantId,
  hasStoredSession,
  loadCredentials,
  saveCredentials,
  saveSsoSession,
  setPlatformHint,
  type StoredCredentials,
} from './auth.js';
import type { AppContext, RouteDefinition, ScreenInstance } from './context.js';
import { describeError } from './errors.js';
import { formatUptime } from './format.js';
import { h } from './dom.js';
import { t } from './i18n.js';
import { HashRouter, type RouteMatch } from './router.js';
import { ThemeController } from './theme.js';
import { button } from './ui/controls.js';
import { emptyState } from './ui/empty-state.js';
import { createLayout, type LayoutHandle } from './ui/layout.js';
import { toast } from './ui/toast.js';
import { initMascot, type MascotController } from './ui/mascot.js';
import { errorState, pageHeader } from './screens/common.js';
import { consumeSsoFragment, requestLogoutUrl } from './sso.js';
import { renderLogin } from './screens/login.js';
import { overviewScreen } from './screens/overview.js';
import { roomsScreen } from './screens/rooms.js';
import { roomScreen } from './screens/room.js';
import { securityScreen } from './screens/security.js';
import { auditScreen } from './screens/audit.js';
import { accessScreen } from './screens/access.js';
import { integrationsScreen } from './screens/integrations.js';
import { docsScreen } from './screens/docs.js';
import { wikiScreen } from './screens/wiki.js';
import { organizationsScreen } from './screens/organizations.js';
import { knowledgeScreen } from './screens/knowledge.js';
import { recordingsScreen } from './screens/recordings.js';
import { infrastructureScreen } from './screens/infrastructure.js';
import { settingsScreen } from './screens/settings.js';

const ROUTES: readonly RouteDefinition[] = [
  { id: 'overview', path: '/overview', title: t('nav.overview'), screen: overviewScreen },
  { id: 'rooms', path: '/rooms', title: t('nav.rooms'), screen: roomsScreen },
  { id: 'room', path: '/rooms/:id', title: t('nav.room'), screen: roomScreen },
  { id: 'security', path: '/security', title: t('nav.security'), screen: securityScreen },
  { id: 'audit', path: '/audit', title: t('nav.audit'), screen: auditScreen },
  { id: 'access', path: '/access', title: t('nav.access'), screen: accessScreen },
  { id: 'integrations', path: '/integrations', title: t('nav.integrations'), screen: integrationsScreen },
  { id: 'docs', path: '/docs', title: t('nav.docs'), screen: docsScreen },
  { id: 'wiki', path: '/wiki', title: t('nav.wiki'), screen: wikiScreen },
  { id: 'organizations', path: '/organizations', title: t('nav.organizations'), screen: organizationsScreen },
  { id: 'knowledge', path: '/knowledge', title: t('nav.knowledgeFull'), screen: knowledgeScreen },
  { id: 'recordings', path: '/recordings', title: t('nav.recordings'), screen: recordingsScreen },
  { id: 'infrastructure', path: '/infrastructure', title: t('nav.infrastructure'), screen: infrastructureScreen },
  { id: 'settings', path: '/settings', title: t('nav.settingsFull'), screen: settingsScreen },
];

class DashboardApp {
  private readonly root: HTMLElement;
  private readonly theme = new ThemeController();
  private credentials: StoredCredentials;
  private api: AdminApi;
  private layout: LayoutHandle | null = null;
  private mascot: MascotController | null = null;
  private platformMode = false;
  /** The current platform session was just verified — skip the duplicate probe. */
  private platformVerified = false;
  private router: HashRouter | null = null;
  private screen: ScreenInstance | null = null;
  private disposeLogin: (() => void) | null = null;
  private lastMatch: RouteMatch | null = null;
  private statusTimer: number | null = null;
  private documentDrafts: AppContext['documentDrafts'] = new Map();
  private readonly context: AppContext;

  private readonly onOnline = (): void => {
    if (this.layout) void this.probeStatus();
  };
  private readonly onOffline = (): void => {
    this.layout?.setServerStatus('offline', 'Браузер потерял сеть');
  };
  private readonly onVisibility = (): void => {
    if (!document.hidden && this.layout) void this.probeStatus();
  };
  private readonly onDocumentDraftUnload = (event: BeforeUnloadEvent): void => {
    event.preventDefault();
    event.returnValue = true;
  };

  constructor(root: HTMLElement) {
    this.root = root;
    const ssoToken = getSsoToken();
    const stored = loadCredentials();
    this.credentials = stored ?? {
      serverUrl: getServerUrl(),
      // An SSO session must never be mixed with the demo key: the Bearer header
      // wins in AdminApi, but the settings screen would show a misleading key.
      apiKey: ssoToken ? '' : getPrefilledApiKey(),
      tenantId: getTenantId(),
      ...(ssoToken ? { ssoToken } : {}),
    };
    this.api = new AdminApi({
      baseUrl: this.credentials.serverUrl,
      apiKey: this.credentials.apiKey,
      ...(ssoToken ? { sessionToken: ssoToken } : {}),
    });
    const app = this;
    this.context = {
      get api() {
        return app.api;
      },
      get credentials() {
        return app.credentials;
      },
      get tenantId() {
        return app.credentials.tenantId;
      },
      get platform() {
        return app.platformMode;
      },
      get documentDrafts() {
        return app.documentDrafts;
      },
      documentDraftsChanged: () => app.updateDocumentUnloadGuard(),
      setPlatformMode: (enabled) => {
        app.platformMode = enabled;
        app.layout?.setPlatformMode(enabled);
      },
      theme: this.theme,
      navigate: (path) => {
        if (app.router) app.router.navigate(path);
        else window.location.hash = `#${path.startsWith('/') ? path : `/${path}`}`;
      },
      toast: (message, kind) => toast(message, kind),
      setServerStatus: (status, detail) => app.layout?.setServerStatus(status, detail),
      setPageTitle: (title, subtitle) => app.layout?.setTitle(title, subtitle),
      saveConnection: (input) => app.saveConnection(input),
      reload: () => app.renderRoute(app.lastMatch),
      openWikiPlatformLogin: () => app.renderLogin(undefined, true, undefined, {
        serverUrl: app.credentials.serverUrl,
        onCancel: () => app.enterApp({ focusContent: true }),
      }),
      logout: () => app.logout(),
    };
  }

  async start(): Promise<void> {
    this.theme.apply();
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    document.addEventListener('visibilitychange', this.onVisibility);

    // SSO callback: the OIDC login flow redirects to `…#sso_token=…`. Consume the
    // fragment *before* anything renders, store the token and clean the URL so
    // it never reaches the DOM, history or a Referer header.
    const fragment = consumeSsoFragment();
    if (fragment?.token) {
      const serverUrl = getServerUrl();
      const sessionApi = new AdminApi({ baseUrl: serverUrl, sessionToken: fragment.token });
      try {
        const overview = await sessionApi.overview();
        saveSsoSession(fragment.token);
        this.credentials = { serverUrl, apiKey: '', tenantId: overview.tenantId, ssoToken: fragment.token };
        this.api = sessionApi;
        saveCredentials(this.credentials);
        this.platformVerified = false;
        setPlatformHint(false);
        this.enterApp();
      } catch (error) {
        clearSsoToken();
        const expired = error instanceof ApiError && (error.unauthorized || error.status === 401);
        this.renderLogin(undefined, false, expired ? 'session_expired' : undefined);
      }
      return;
    }
    if (fragment?.error) {
      this.renderLogin(undefined, false, fragment.error);
      return;
    }
    if (!hasStoredSession()) {
      this.renderLogin();
      return;
    }
    const ssoSession = Boolean(this.credentials.ssoToken);
    // A platform session must never touch tenant-scoped `/v1/admin/overview`:
    // the platform key is rejected there with 403. Validate it against
    // `/v1/admin/tenants`. SSO sessions are always tenant-scoped.
    if (!ssoSession && getPlatformHint()) {
      try {
        const tenants = await this.api.tenants();
        if (tenants.platform) {
          this.platformMode = true;
          this.platformVerified = true;
          this.credentials.tenantId = 'platform';
          this.enterApp();
          return;
        }
        // The key is a tenant key: drop the stale platform hint and continue
        // with the ordinary tenant bootstrap below.
        setPlatformHint(false);
      } catch (error) {
        if (error instanceof ApiError && [404, 405, 501].includes(error.status)) {
          // Older server without the SaaS endpoint: keep the explicit platform
          // mode so the organizations screen can show its fallback notice.
          this.platformMode = true;
          this.platformVerified = true;
          this.enterApp();
          return;
        }
        this.renderLogin(error, true);
        return;
      }
    }
    try {
      const overview = await this.api.overview();
      this.credentials.tenantId = overview.tenantId;
      saveCredentials(this.credentials);
      this.enterApp();
    } catch (error) {
      // An expired/revoked SSO session must not strand the user on a login form
      // that still claims to be signed in.
      if (ssoSession && error instanceof ApiError && (error.unauthorized || error.status === 401)) {
        clearSsoToken();
        this.credentials = { ...this.credentials, apiKey: '', ssoToken: undefined };
        this.api = new AdminApi({ baseUrl: this.credentials.serverUrl });
        this.renderLogin(undefined, false, 'session_expired');
        return;
      }
      this.renderLogin(error);
    }
  }

  private renderLogin(initialError?: unknown, platformHint = false, ssoError?: string, wikiPlatform?: { serverUrl: string; onCancel: () => void }): void {
    this.teardown();
    const login = renderLogin({
      theme: this.theme,
      initialError,
      platformHint,
      ssoError,
      wikiPlatform,
      onSuccess: (credentials) => this.handleLogin(credentials, { focusContent: Boolean(wikiPlatform) }),
    });
    this.disposeLogin = login.destroy;
    this.root.replaceChildren(login.el);
  }

  private handleLogin(credentials: StoredCredentials, options: { focusContent?: boolean }): void {
    this.revokeSsoSession();
    this.resetDocumentDrafts();
    this.credentials = {
      serverUrl: normalizeBaseUrl(credentials.serverUrl),
      apiKey: credentials.apiKey,
      tenantId: credentials.tenantId,
    };
    clearSsoToken();
    saveCredentials(this.credentials);
    this.api = new AdminApi({ baseUrl: this.credentials.serverUrl, apiKey: this.credentials.apiKey });
    // The login screen already probed /v1/admin/tenants in platform mode.
    this.platformVerified = getPlatformHint();
    this.enterApp(options);
  }

  private enterApp({ focusContent = false } = {}): void {
    this.teardown();
    // Platform mode is API-key-only: an SSO session is always tenant-scoped.
    this.platformMode = !this.credentials.ssoToken && getPlatformHint();
    this.layout = createLayout({
      theme: this.theme,
      tenantId: this.credentials.tenantId,
      serverUrl: this.credentials.serverUrl,
      platformMode: this.platformMode,
      onLogout: () => this.logout(),
    });
    this.root.appendChild(this.layout.root);
    this.mascot = initMascot(this.context, this.layout.root, this.layout.assistantTriggers);
    this.layout.setServerStatus('checking');
    const initialRoute = window.location.hash.split('?')[0];
    const redirectPlatform = this.platformMode && initialRoute !== '#/docs' && initialRoute !== '#/wiki' && initialRoute !== '#/organizations';
    this.router = new HashRouter([...ROUTES], (match) => this.renderRoute(match));
    this.router.start(redirectPlatform ? '/organizations' : undefined);
    if (focusContent) this.layout.content.focus({ preventScroll: true });
    void this.probeStatus();
    if (this.platformVerified) {
      this.platformVerified = false;
      this.layout.setPlatformMode(true);
    } else {
      void this.detectPlatformMode();
    }
    this.statusTimer = window.setInterval(() => {
      void this.probeStatus();
    }, 30_000);
  }

  private async detectPlatformMode(): Promise<void> {
    // SSO sessions are tenant admin sessions: never probe platform endpoints.
    if (this.credentials.ssoToken) {
      this.platformMode = false;
      this.layout?.setPlatformMode(false);
      return;
    }
    // Never probe a platform-only endpoint for an ordinary tenant key: no hint →
    // no request, no 403 noise in DevTools. Platform owners explicitly opt in on
    // the login screen (or a previous platform session set the hint).
    if (!getPlatformHint()) {
      this.platformMode = false;
      this.layout?.setPlatformMode(false);
      return;
    }
    try {
      const response = await this.api.tenants();
      this.platformMode = response.platform;
      setPlatformHint(response.platform);
      this.layout?.setPlatformMode(response.platform);
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404, 405, 501].includes(error.status)) {
        // Backend may not expose /v1/admin/tenants yet. The explicit login hint
        // lets a platform owner use the Organizations fallback screen.
        this.platformMode = getPlatformHint();
        this.layout?.setPlatformMode(this.platformMode);
      }
    }
  }

  private renderRoute(match: RouteMatch | null): void {
    this.lastMatch = match;
    if (!this.layout) return;
    this.screen?.destroy?.();
    this.screen = null;
    this.layout.content.replaceChildren();
    this.layout.setActive(match?.route.id ?? 'notfound');
    this.layout.setTitle(match?.route.title ?? t('nav.notFound'));
    this.layout.content.scrollTo({ top: 0, behavior: 'auto' });
    if (!match) {
      this.layout.content.appendChild(this.renderNotFound());
      return;
    }
    try {
      const instance = match.route.screen(this.context, match.params);
      this.screen = instance;
      this.layout.content.appendChild(instance.el);
    } catch (error) {
      this.layout.content.appendChild(errorState(error, () => this.renderRoute(match)));
    }
  }

  private renderNotFound(): HTMLElement {
    const page = h('div', { class: 'page' });
    page.appendChild(
      pageHeader({
        title: t('common.notFoundTitle'),
        subtitle: t('common.notFoundSubtitle', { hash: window.location.hash || '#/overview' }),
      }),
    );
    page.appendChild(
      emptyState({
        title: t('common.notFoundTitle'),
        message: t('common.notFoundMessage'),
        iconName: 'info',
        action: button(t('common.goOverview'), {
          variant: 'primary',
          icon: 'overview',
          onClick: () => this.context.navigate('/overview'),
        }),
      }),
    );
    return page;
  }

  private async probeStatus(): Promise<void> {
    if (!this.layout) return;
    try {
      const health = await this.api.health();
      this.layout.setServerStatus(
        'online',
        `${health.name} ${health.version} · время работы ${formatUptime(health.uptimeSec)} · комнат на сервере ${health.rooms}`,
      );
    } catch (error) {
      const info = describeError(error);
      this.layout.setServerStatus(
        'offline',
        info.offline
          ? 'Сервер не отвечает — запустите npm run dev (порт 8787) или проверьте адрес в настройках'
          : `${info.title}: ${info.message}`,
      );
    }
  }

  private async saveConnection(input: { serverUrl: string; apiKey: string }): Promise<void> {
    if (!input.apiKey.trim()) throw new Error('API-ключ не заполнен. Вставьте ключ, который выдал сервер.');
    const api = new AdminApi({ baseUrl: normalizeBaseUrl(input.serverUrl), apiKey: input.apiKey });
    const overview = await api.overview();
    if (api.baseUrl !== this.credentials.serverUrl || input.apiKey !== this.credentials.apiKey || this.credentials.ssoToken) {
      this.resetDocumentDrafts();
    }
    // Switching to an API key ends the SSO session: revoke server-side first.
    this.revokeSsoSession();
    clearSsoToken();
    this.credentials = {
      serverUrl: api.baseUrl,
      apiKey: input.apiKey,
      tenantId: overview.tenantId,
    };
    this.api = api;
    saveCredentials(this.credentials);
    this.platformMode = getPlatformHint();
    this.layout?.setPlatformMode(this.platformMode);
    this.layout?.setTenant(this.credentials.tenantId);
    this.layout?.setServerUrl(this.credentials.serverUrl);
    this.layout?.setServerStatus('online', `Организация ${this.credentials.tenantId}`);
    void this.mascot?.refreshBranding();
  }

  /**
   * Best-effort server-side revocation of the current SSO session. Local logout
   * always proceeds (the request is fired before the credentials are cleared and
   * failures are ignored): the token is short-lived and this page never reloads.
   */
  private revokeSsoSession(): void {
    const token = this.credentials.ssoToken;
    if (!token) return;
    const api = new AdminApi({ baseUrl: this.credentials.serverUrl, sessionToken: token, timeoutMs: 3000 });
    void api.oidcLogout().catch(() => {
      /* offline/expired: the local token is dropped anyway */
    });
  }

  private updateDocumentUnloadGuard(): void {
    if (this.documentDrafts.size > 0) window.addEventListener('beforeunload', this.onDocumentDraftUnload);
    else window.removeEventListener('beforeunload', this.onDocumentDraftUnload);
  }

  private resetDocumentDrafts(): void {
    this.documentDrafts = new Map();
    this.updateDocumentUnloadGuard();
  }

  private logout(): void {
    // Revoke server-side, then drop the API key, the SSO session and the tenant.
    const ssoToken = this.credentials.ssoToken;
    const serverUrl = this.credentials.serverUrl;
    const tenantId = this.credentials.tenantId;
    this.revokeSsoSession();
    this.resetDocumentDrafts();
    clearCredentials();
    this.credentials = { serverUrl: this.credentials.serverUrl, apiKey: '', tenantId: getTenantId() };
    this.api = new AdminApi({ baseUrl: this.credentials.serverUrl });
    this.renderLogin();
    // RP-initiated logout: when the tenant configures an IdP
    // `end_session_endpoint`, also end the corporate IdP session (fragment-free
    // navigation; the local logout above is already complete if this fails).
    if (ssoToken) void this.navigateToIdpLogout(serverUrl, tenantId);
  }

  /**
   * Opt-in RP-initiated logout. The server builds the IdP `end_session_endpoint`
   * URL (`client_id` + registered `post_logout_redirect_uri` + single-use
   * `state`); 501/offline means the tenant has no RP logout and the dashboard
   * stays on the local login screen.
   */
  private async navigateToIdpLogout(serverUrl: string, tenantId: string): Promise<void> {
    try {
      const logoutUrl = await requestLogoutUrl({ serverUrl, tenantId });
      if (logoutUrl) window.location.assign(logoutUrl);
    } catch {
      /* local logout already done; never block it on the IdP */
    }
  }

  private teardown(): void {
    this.disposeLogin?.();
    this.disposeLogin = null;
    if (this.statusTimer !== null) {
      window.clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    this.screen?.destroy?.();
    this.screen = null;
    this.router?.stop();
    this.router = null;
    this.mascot?.destroy();
    this.mascot = null;
    this.layout?.destroy();
    this.layout = null;
    this.lastMatch = null;
    this.root.replaceChildren();
  }
}

const mount = document.getElementById('app');
if (!mount) {
  const fallback = document.createElement('div');
  fallback.textContent = 'Не найден контейнер #app — проверьте index.html панели AgilFrame.';
  document.body.appendChild(fallback);
} else {
  const app = new DashboardApp(mount);
  app.start().catch((error: unknown) => {
    const info = describeError(error);
    mount.replaceChildren(
      errorState(error, () => window.location.reload()),
      h('p', { class: 'notice', text: `${info.title}: ${info.message}` }),
    );
  });
}
