/**
 * Application shell: sidebar navigation, topbar (tenant, server status, theme
 * switch, logout) and the routed content container. Responsive: collapses to
 * an icon rail on desktop and becomes an off-canvas drawer on mobile.
 */
import type { ServerStatus } from '../context.js';
import { h, listen } from '../dom.js';
import { languageLabel, languageSwitchTitle, t, toggleLocale, type MessageKey } from '../i18n.js';
import { icon, type IconName } from '../icons.js';
import { publicLinks, docsRoute } from '../links.js';
import { readStorage, writeStorage } from '../storage.js';
import type { ThemeController, ThemeMode } from '../theme.js';
import { button } from './controls.js';
import { createToastRegion } from './toast.js';

const SIDEBAR_STORAGE_KEY = 'agil_dashboard_sidebar';

export interface NavItem {
  id: string;
  labelKey: MessageKey;
  iconName: IconName;
  path: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'overview', labelKey: 'nav.overview', iconName: 'overview', path: '/overview' },
  { id: 'rooms', labelKey: 'nav.rooms', iconName: 'rooms', path: '/rooms' },
  { id: 'security', labelKey: 'nav.security', iconName: 'security', path: '/security' },
  { id: 'audit', labelKey: 'nav.audit', iconName: 'audit', path: '/audit' },
  { id: 'access', labelKey: 'nav.access', iconName: 'key', path: '/access' },
  { id: 'integrations', labelKey: 'nav.integrations', iconName: 'link', path: '/integrations' },
  { id: 'docs', labelKey: 'nav.docs', iconName: 'file', path: '/docs' },
  { id: 'wiki', labelKey: 'nav.wiki', iconName: 'book', path: '/wiki' },
  { id: 'organizations', labelKey: 'nav.organizations', iconName: 'globe', path: '/organizations' },
  { id: 'knowledge', labelKey: 'nav.knowledge', iconName: 'book', path: '/knowledge' },
  { id: 'recordings', labelKey: 'nav.recordings', iconName: 'recordings', path: '/recordings' },
  { id: 'infrastructure', labelKey: 'nav.infrastructure', iconName: 'server', path: '/infrastructure' },
  { id: 'settings', labelKey: 'nav.settings', iconName: 'settings', path: '/settings' },
];

export interface LayoutOptions {
  theme: ThemeController;
  tenantId: string;
  serverUrl: string;
  platformMode?: boolean;
  onLogout: () => void;
}

export interface LayoutHandle {
  root: HTMLElement;
  content: HTMLElement;
  assistantTriggers: readonly HTMLButtonElement[];
  setTitle: (title: string, subtitle?: string) => void;
  setActive: (routeId: string) => void;
  setServerStatus: (status: ServerStatus, detail?: string) => void;
  setTenant: (tenantId: string) => void;
  setServerUrl: (serverUrl: string) => void;
  setPlatformMode: (enabled: boolean) => void;
  destroy: () => void;
}

const THEME_MODES: ReadonlyArray<{ mode: ThemeMode; labelKey: MessageKey; iconName: IconName }> = [
  { mode: 'auto', labelKey: 'theme.auto', iconName: 'monitor' },
  { mode: 'light', labelKey: 'theme.light', iconName: 'sun' },
  { mode: 'dark', labelKey: 'theme.dark', iconName: 'moon' },
];

const STATUS_KEYS: Record<ServerStatus, MessageKey> = {
  online: 'status.online',
  offline: 'status.offline',
  checking: 'status.checking',
};

function statusLabel(status: ServerStatus): string {
  return t(STATUS_KEYS[status]);
}

export function createLayout(options: LayoutOptions): LayoutHandle {
  const cleanups: Array<() => void> = [];
  const mobileQuery = window.matchMedia('(max-width: 960px)');
  const collapsedStored = readStorage(SIDEBAR_STORAGE_KEY) === 'collapsed';

  const root = h('div', { class: 'app' });
  if (collapsedStored && !mobileQuery.matches) root.classList.add('is-collapsed');

  /* ------------------------------ sidebar ------------------------------ */

  const brand = h(
    'div',
    { class: 'brand' },
    h('img', {
      class: 'brand-mark',
      attrs: {
        src: `${import.meta.env.BASE_URL}branding/agil-icon-256.png`,
        alt: '',
        width: 36,
        height: 36,
        decoding: 'async',
      },
    }),
    h(
      'span',
      { class: 'brand-text' },
      h('span', { class: 'brand-name', text: 'AgilFrame' }),
      h('span', { class: 'brand-sub', text: t('app.brandSub') }),
    ),
  );

  const nav = h('nav', {
    class: 'sidebar-nav',
    attrs: { 'aria-label': t('nav.label') },
  });
  const navLinks = new Map<string, HTMLAnchorElement>();
  for (const item of NAV_ITEMS) {
    const link = h('a', {
      class: 'nav-link',
      attrs: { href: `#${item.path}`, title: t(item.labelKey) },
    });
    link.dataset.route = item.id;
    if (item.id === 'organizations') link.hidden = true;
    link.append(
      h('span', { class: 'nav-icon' }, icon(item.iconName, 20)),
      h('span', { class: 'nav-label', text: t(item.labelKey) }),
    );
    link.addEventListener('click', () => closeDrawer());
    nav.appendChild(link);
    navLinks.set(item.id, link);
  }

  const links = publicLinks(options.serverUrl);
  const demoLink = h('a', {
    class: 'footer-link',
    attrs: { href: links.demo, target: '_blank', rel: 'noopener noreferrer', title: t('footer.demoTitle') },
  });
  const editorLink = h('a', {
    class: 'footer-link',
    attrs: { href: links.editor, target: '_blank', rel: 'noopener noreferrer', title: t('footer.editorTitle') },
  });

  const explorerLink = h('a', {
    class: 'footer-link',
    attrs: {
      href: links.apiDocs,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: t('footer.explorerTitle'),
    },
  });
  const openapiLink = h('a', {
    class: 'footer-link',
    attrs: {
      href: links.openapi,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: t('footer.openapiTitle'),
    },
  });
  const apiGuideLink = h('a', {
    class: 'footer-link',
    attrs: { href: docsRoute('api-guide.md'), title: t('footer.guideTitle') },
  });
  const apiMdLink = h('a', {
    class: 'footer-link',
    attrs: { href: docsRoute('api.md'), title: t('footer.apiTitle') },
  });
  const auditLink = h('a', {
    class: 'footer-link',
    attrs: { href: docsRoute('security-audit.md'), title: t('footer.securityAuditTitle') },
  });
  for (const [link, iconName, key] of [
    [demoLink, 'external', 'footer.demo'],
    [editorLink, 'external', 'footer.editor'],
    [explorerLink, 'code', 'footer.explorer'],
    [openapiLink, 'file', 'footer.openapi'],
    [apiGuideLink, 'book', 'footer.guide'],
    [apiMdLink, 'file', 'footer.api'],
    [auditLink, 'security', 'footer.securityAudit'],
  ] as Array<[HTMLAnchorElement, IconName, MessageKey]>) {
    link.append(h('span', { class: 'nav-icon' }, icon(iconName, 15)), h('span', { class: 'footer-label', text: t(key) }));
  }

  const sidebarAssistant = button(t('app.assistant'), {
    variant: 'subtle',
    className: 'sidebar-assistant',
    icon: 'chat',
    onClick: () => {
      closeDrawer();
      assistantButton.focus({ preventScroll: true });
      window.dispatchEvent(new CustomEvent('agil-open-assistant'));
    },
  });
  const sidebar = h(
    'aside',
    { class: 'sidebar', attrs: { id: 'dashboard-sidebar' } },
    brand,
    h('div', { class: 'nav-section-label', text: t('app.sections') }),
    nav,
    sidebarAssistant,
    h(
      'div',
      { class: 'sidebar-footer' },
      h('div', { class: 'nav-section-label', text: t('app.docsAndDemo') }),
      demoLink,
      editorLink,
      explorerLink,
      openapiLink,
      apiGuideLink,
      apiMdLink,
      auditLink,
      h('span', { class: 'version', text: t('app.version') }),
    ),
  );

  /* ------------------------------ topbar ------------------------------- */

  const pageTitle = h('h1', { class: 'page-title', text: t('nav.overview') });
  const pageSubtitle = h('p', { class: 'page-subtitle', text: '' });
  const titles = h('div', { class: 'topbar-titles' }, pageTitle, pageSubtitle);

  const statusDot = h('span', { class: 'status-dot', attrs: { 'aria-hidden': 'true' } });
  const statusText = h('span', { class: 'status-text', text: statusLabel('checking') });
  const serverStatus = h('span', {
    class: 'server-status status-checking',
    attrs: { role: 'status', 'aria-live': 'polite', title: t('status.serverTitle') },
  });
  serverStatus.append(statusDot, statusText);

  const tenantStrong = h('strong', { text: options.tenantId });
  const tenantChip = h(
    'span',
    { class: 'tenant-chip', attrs: { title: t('app.tenantTitle') } },
    h('span', { text: t('app.tenant') }),
    tenantStrong,
  );

  const themeSwitch = h('div', {
    class: 'theme-switch',
    attrs: { role: 'group', 'aria-label': t('theme.group') },
  });
  const themeButtons = new Map<ThemeMode, HTMLButtonElement>();
  for (const item of THEME_MODES) {
    const label = t(item.labelKey);
    const node = h('button', {
      class: 'theme-option',
      attrs: { type: 'button', title: label, 'aria-label': label, 'aria-pressed': 'false' },
      on: { click: () => options.theme.setMode(item.mode) },
    });
    node.appendChild(icon(item.iconName, 20));
    themeSwitch.appendChild(node);
    themeButtons.set(item.mode, node);
  }
  const mobileThemeButton = button(undefined, {
    variant: 'subtle',
    className: 'theme-cycle',
    title: t('theme.group'),
    ariaLabel: t('theme.group'),
    onClick: () => {
      const index = THEME_MODES.findIndex((item) => item.mode === options.theme.getMode());
      options.theme.setMode(THEME_MODES[(index + 1) % THEME_MODES.length]!.mode);
    },
  });

  const syncTheme = (): void => {
    const active = options.theme.getMode();
    for (const [mode, node] of themeButtons) node.setAttribute('aria-pressed', mode === active ? 'true' : 'false');
    const current = (THEME_MODES.find((item) => item.mode === active) ?? THEME_MODES[0])!;
    mobileThemeButton.replaceChildren(icon(current.iconName, 20));
    mobileThemeButton.title = `${t('theme.group')}: ${t(current.labelKey)}`;
    mobileThemeButton.setAttribute('aria-label', `${t('theme.group')}: ${t(current.labelKey)}`);
  };
  syncTheme();
  cleanups.push(options.theme.onChange(syncTheme));

  const menuButton = button(undefined, {
    variant: 'subtle',
    className: 'menu-btn',
    icon: 'menu',
    title: t('app.menu'),
    onClick: () => toggleSidebar(),
  });
  menuButton.setAttribute('aria-controls', sidebar.id);

  const logoutButton = button(undefined, {
    variant: 'subtle',
    icon: 'logout',
    title: t('app.logout'),
    onClick: () => options.onLogout(),
  });

  const languageButton = button(languageLabel(), {
    variant: 'subtle',
    size: 'sm',
    className: 'lang-btn',
    title: languageSwitchTitle(),
    ariaLabel: languageSwitchTitle(),
    onClick: () => toggleLocale(),
  });

  const platformSwitch = h('div', { class: 'platform-switch', attrs: { role: 'group', 'aria-label': t('app.platformMode') } });
  platformSwitch.hidden = true;
  const platformBtn = button(t('app.platform'), {
    variant: 'subtle',
    size: 'sm',
    onClick: () => {
      if (window.location.hash !== '#/organizations') window.location.hash = '#/organizations';
    },
  });
  const orgBtn = button(t('app.organization'), {
    variant: 'ghost',
    size: 'sm',
    onClick: () => {
      if (window.location.hash !== '#/overview') window.location.hash = '#/overview';
    },
  });
  platformSwitch.append(platformBtn, orgBtn);

  const assistantButton = button(undefined, {
    variant: 'subtle',
    className: 'topbar-assistant',
    icon: 'chat',
    title: t('app.assistant'),
    onClick: () => window.dispatchEvent(new CustomEvent('agil-open-assistant')),
  });

  const topbar = h(
    'header',
    { class: 'topbar' },
    menuButton,
    titles,
    h('div', { class: 'topbar-actions' }, assistantButton, platformSwitch, serverStatus, tenantChip, languageButton, themeSwitch, mobileThemeButton, logoutButton),
  );

  const content = h('main', { class: 'content', attrs: { id: 'dashboard-view', tabindex: '-1' } });

  // Bypass block (WCAG 2.4.1). The panel uses a hash router, so the link must
  // not change `location.hash` — move focus to <main> directly instead.
  const skipLink = h('a', {
    class: 'skip-link',
    text: t('app.skip'),
    attrs: { href: '#dashboard-view' },
    on: {
      click: (event: Event) => {
        event.preventDefault();
        content.focus();
      },
    },
  });

  const scrim = h('button', {
    class: 'scrim',
    attrs: { type: 'button', 'aria-label': t('app.menu') },
    on: { click: () => closeDrawer() },
  });

  root.append(skipLink, scrim, sidebar, h('div', { class: 'main' }, topbar, content, createToastRegion()));

  /* --------------------------- responsive ------------------------------ */

  let drawerReturnFocus: HTMLElement | null = null;
  sidebar.inert = mobileQuery.matches;
  const syncMenuExpanded = (): void => {
    const expanded = mobileQuery.matches
      ? root.classList.contains('is-drawer-open')
      : !root.classList.contains('is-collapsed');
    menuButton.setAttribute('aria-expanded', String(expanded));
  };
  syncMenuExpanded();

  const closeDrawer = (returnFocus = false): void => {
    root.classList.remove('is-drawer-open');
    syncMenuExpanded();
    sidebar.inert = mobileQuery.matches;
    if (returnFocus) {
      (drawerReturnFocus ?? menuButton).focus({ preventScroll: true });
    }
    drawerReturnFocus = null;
  };

  function toggleSidebar(): void {
    if (mobileQuery.matches) {
      const open = root.classList.toggle('is-drawer-open');
      syncMenuExpanded();
      if (open) {
        sidebar.inert = false;
        drawerReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : menuButton;
        navLinks.values().next().value?.focus({ preventScroll: true });
      } else {
        closeDrawer(true);
      }
      return;
    }
    const collapsed = root.classList.toggle('is-collapsed');
    syncMenuExpanded();
    writeStorage(SIDEBAR_STORAGE_KEY, collapsed ? 'collapsed' : 'expanded');
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.target instanceof Element && event.target.closest('.mascot-panel')) return;
    if (event.key === 'Escape' && root.classList.contains('is-drawer-open')) {
      closeDrawer(true);
      return;
    }
    // WCAG 2.4.3: keep Tab inside the mobile drawer while it is open.
    if (event.key !== 'Tab' || !root.classList.contains('is-drawer-open')) return;
    const focusable = [...sidebar.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(
      (element) => element.offsetParent !== null,
    );
    if (focusable.length === 0) return;
    const current = focusable.findIndex((element) => element === document.activeElement);
    const next = current === -1
      ? (event.shiftKey ? focusable.length - 1 : 0)
      : (current + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
    event.preventDefault();
    focusable[next]?.focus();
  };
  cleanups.push(listen(document, 'keydown', (event) => onKeyDown(event as KeyboardEvent)));

  const onMediaChange = (): void => {
    if (mobileQuery.matches) {
      root.classList.remove('is-collapsed');
      closeDrawer();
    } else {
      root.classList.remove('is-drawer-open');
      sidebar.inert = false;
      root.classList.toggle('is-collapsed', readStorage(SIDEBAR_STORAGE_KEY) === 'collapsed');
      syncMenuExpanded();
    }
  };
  if (typeof mobileQuery.addEventListener === 'function') {
    mobileQuery.addEventListener('change', onMediaChange);
    cleanups.push(() => mobileQuery.removeEventListener('change', onMediaChange));
  }

  /* ------------------------------ API -------------------------------- */

  const setTitle = (title: string, subtitle?: string): void => {
    pageTitle.textContent = title;
    pageSubtitle.textContent = subtitle ?? '';
    pageSubtitle.hidden = !subtitle;
    document.title = `${title} · AgilFrame`;
  };

  const setPlatformMode = (enabled: boolean): void => {
    platformSwitch.hidden = !enabled;
    const organizations = navLinks.get('organizations');
    if (organizations) organizations.hidden = !enabled;
    if (!enabled && window.location.hash.startsWith('#/organizations')) window.location.hash = '#/overview';
    const inPlatform = enabled && window.location.hash.startsWith('#/organizations');
    platformBtn.className = `btn btn-sm ${inPlatform ? 'btn-subtle is-active' : 'btn-ghost'}`;
    orgBtn.className = `btn btn-sm ${inPlatform ? 'btn-ghost' : 'btn-subtle is-active'}`;
  };

  const setActive = (routeId: string): void => {
    const activeId = routeId === 'room' ? 'rooms' : routeId;
    for (const [id, link] of navLinks) {
      const isActive = id === activeId;
      link.classList.toggle('is-active', isActive);
      if (isActive) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    if (!platformSwitch.hidden) {
      const inPlatform = routeId === 'organizations';
      platformBtn.className = `btn btn-sm ${inPlatform ? 'btn-subtle is-active' : 'btn-ghost'}`;
      orgBtn.className = `btn btn-sm ${inPlatform ? 'btn-ghost' : 'btn-subtle is-active'}`;
    }
  };

  const setServerStatus = (status: ServerStatus, detail?: string): void => {
    const label = statusLabel(status);
    serverStatus.className = `server-status status-${status}`;
    statusText.textContent = label;
    serverStatus.title = detail ?? label;
    serverStatus.setAttribute(
      'aria-label',
      detail ? t(status === 'online' ? 'status.onlineDetail' : status === 'offline' ? 'status.offlineDetail' : 'status.checking', { detail }) : label,
    );
  };

  const setTenant = (tenantId: string): void => {
    tenantStrong.textContent = tenantId;
  };

  const setServerUrl = (serverUrl: string): void => {
    const next = publicLinks(serverUrl);
    demoLink.href = next.demo;
    editorLink.href = next.editor;
    explorerLink.href = next.apiDocs;
    openapiLink.href = next.openapi;
    apiGuideLink.href = docsRoute('api-guide.md');
    apiMdLink.href = docsRoute('api.md');
    auditLink.href = docsRoute('security-audit.md');
  };

  const destroy = (): void => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
    root.remove();
  };

  setPlatformMode(options.platformMode === true);
  return { root, content, assistantTriggers: [assistantButton, sidebarAssistant], setTitle, setActive, setServerStatus, setTenant, setServerUrl, setPlatformMode, destroy };
}
