// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Editor entry point: wires the three columns together.
 *
 * Left  — section navigation + zod-driven settings.
 * Centre— debounced iframe preview with the §7 postMessage contract.
 * Right — JSON, embed snippet, save-to-tenant, import, reset.
 */
import { DEFAULT_SERVER_URL, getEditorConfig, loadServerSettings, normalizeServerUrl, SETTINGS_KEYS } from './api';
import { el, formatClock, icon, readStorage, toast } from './dom';
import { applyStaticI18n, currentLocale, languageLabel, languageSwitchTitle, toggleLocale, tr } from './i18n';
import { themeForScheme } from './theme-scheme.js';
import type { FieldCtx, Sync } from './fields';
import { initMobileCards } from './fields';
import { mountInspector } from './inspector';
import { createPreview } from './preview';
import { createMascot } from './mascot';
import { sections, type SectionId } from './sections';
import { findInvalidProviderEndpoint } from './sections/providers';
import { createEditorStore, loadEditorTheme, saveEditorTheme, watchSystemEditorTheme, type EditorTheme } from './state';

function mustGet<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Editor markup is missing #${id}`);
  return node as T;
}

const fieldsRoot = mustGet<HTMLDivElement>('fields');
const navRoot = mustGet<HTMLElement>('section-nav');
const sectionsToggle = mustGet<HTMLButtonElement>('editor-sections-toggle');
const activeSectionLabel = mustGet<HTMLSpanElement>('editor-active-section');
const docsToggle = mustGet<HTMLButtonElement>('editor-docs-toggle');
const docsNav = mustGet<HTMLElement>('editor-docs-links');
const stage = mustGet<HTMLDivElement>('preview-stage');
const overlay = mustGet<HTMLDivElement>('preview-overlay');
const actionsRoot = mustGet<HTMLDivElement>('preview-actions');
const statusEl = mustGet<HTMLSpanElement>('preview-status');
const logEl = mustGet<HTMLDivElement>('preview-log');
const draftEl = mustGet<HTMLSpanElement>('draft-status');
const tenantPill = mustGet<HTMLSpanElement>('tenant-pill');
const themeButton = mustGet<HTMLButtonElement>('theme-toggle');
const langButton = mustGet<HTMLButtonElement>('lang-toggle');
const inspectorRoot = mustGet<HTMLDivElement>('inspector');

// Static header/nav labels (ru source strings in `data-i18n*` attributes).
applyStaticI18n();
langButton.textContent = languageLabel();
langButton.setAttribute('aria-label', languageSwitchTitle());
langButton.title = languageSwitchTitle();
langButton.addEventListener('click', () => toggleLocale());
const docsLink = document.getElementById('docs-link') as HTMLAnchorElement | null;
const openapiLink = document.getElementById('openapi-link') as HTMLAnchorElement | null;
const apiGuideLink = document.getElementById('api-guide-link') as HTMLAnchorElement | null;
const apiMdLink = document.getElementById('api-md-link') as HTMLAnchorElement | null;

const published = getEditorConfig();
const store = createEditorStore({ tenantId: published.config.tenantId, initialConfig: published.config, initialBase: published.base });
const previewOnly = new URLSearchParams(window.location.search).get('view') === 'preview';
if (previewOnly) {
  document.documentElement.dataset.editorView = 'preview';
}

/* ------------------------------------------------------------------ */
/* Editor UI theme (independent from the tenant theme)                 */
/* ------------------------------------------------------------------ */

let editorTheme: EditorTheme = loadEditorTheme();

function applyEditorTheme(): void {
  document.documentElement.dataset.theme = editorTheme;
  const title =
    currentLocale() === 'en'
      ? `Editor theme: ${editorTheme === 'dark' ? 'dark' : 'light'} — switch to ${editorTheme === 'dark' ? 'light' : 'dark'}`
      : `Тема редактора: ${editorTheme === 'dark' ? 'тёмная' : 'светлая'} — переключить на ${editorTheme === 'dark' ? 'светлую' : 'тёмную'}`;
  themeButton.replaceChildren(icon(editorTheme === 'dark' ? 'sun' : 'moon'));
  themeButton.title = title;
  themeButton.setAttribute('aria-label', title);
  themeButton.setAttribute('aria-pressed', editorTheme === 'dark' ? 'true' : 'false');
}

applyEditorTheme();
const stopWatchingTheme = watchSystemEditorTheme((theme) => {
  editorTheme = theme;
  applyEditorTheme();
});

themeButton.addEventListener('click', () => {
  stopWatchingTheme();
  editorTheme = editorTheme === 'dark' ? 'light' : 'dark';
  saveEditorTheme(editorTheme);
  applyEditorTheme();
});

/* ------------------------------------------------------------------ */
/* Navigation + section rendering                                     */
/* ------------------------------------------------------------------ */

let activeId: SectionId = 'brand';
let bindings: Sync[] = [];
const navButtons = new Map<SectionId, HTMLButtonElement>();
const mobileNavigation = window.matchMedia('(max-width: 720px)');

function setDisclosure(toggle: HTMLButtonElement, panel: HTMLElement, expanded: boolean): void {
  toggle.setAttribute('aria-expanded', String(expanded));
  panel.classList.toggle('is-expanded', expanded);
}

for (const [toggle, panel] of [[sectionsToggle, navRoot], [docsToggle, docsNav]] as const) {
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    setDisclosure(sectionsToggle, navRoot, false);
    setDisclosure(docsToggle, docsNav, false);
    setDisclosure(toggle, panel, !expanded);
  });
  document.addEventListener('pointerdown', (event) => {
    if (event.target instanceof Node && !panel.contains(event.target) && !toggle.contains(event.target)) {
      setDisclosure(toggle, panel, false);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || toggle.getAttribute('aria-expanded') !== 'true') return;
    event.preventDefault();
    setDisclosure(toggle, panel, false);
    toggle.focus();
  });
  mobileNavigation.addEventListener('change', () => setDisclosure(toggle, panel, false));
}
docsNav.addEventListener('click', (event) => {
  if (!(event.target instanceof Element) || !event.target.closest('a[href]') || !mobileNavigation.matches) return;
  setDisclosure(docsToggle, docsNav, false);
  docsToggle.focus();
});

for (const section of sections) {
  const button = el('button', 'nav-item');
  button.type = 'button';
  button.dataset.testid = `nav-${section.id}`;
  button.title = section.title;
  button.setAttribute('aria-label', section.title);
  button.append(icon(section.icon), el('span', 'nav-label', section.title));
  button.addEventListener('click', (event) => {
    selectSection(section.id);
    if (mobileNavigation.matches) setDisclosure(sectionsToggle, navRoot, false);
    if (event.detail === 0) focusSettings();
    else if (mobileNavigation.matches) sectionsToggle.focus();
  });
  navButtons.set(section.id, button);
  navRoot.append(button);
}

const ctx: FieldCtx = {
  get: (path) => store.get(path),
  invalidText: new Map(),
  set: (path, value) => {
    store.set(path, value);
  },
  config: () => store.getConfig(),
  refresh: () => renderSection(false),
  toast,
};

function selectSection(id: SectionId): void {
  if (id === activeId) return;
  activeId = id;
  const section = sections.find((candidate) => candidate.id === id);
  mascot.setSection(id, section?.title ?? id);
  updateNav();
  renderSection(true);
}

function updateNav(): void {
  for (const [id, button] of navButtons) {
    const active = id === activeId;
    button.classList.toggle('is-active', active);
    if (active) {
      button.setAttribute('aria-current', 'page');
      activeSectionLabel.textContent = button.textContent;
    } else button.removeAttribute('aria-current');
  }
}

function focusSettings(): void {
  (fieldsRoot.querySelector<HTMLElement>('.section-title') ?? fieldsRoot).focus();
}

function renderSection(resetScroll: boolean): void {
  const section = sections.find((candidate) => candidate.id === activeId) ?? sections[0];
  if (!section) return;
  const previousScroll = fieldsRoot.scrollTop;
  const expanded = resetScroll ? undefined : new Set(
    [...fieldsRoot.querySelectorAll('.section-body .card')]
      .flatMap((card, index) => card.classList.contains('is-collapsed') ? [] : [index]),
  );
  fieldsRoot.replaceChildren();

  const header = el('header', 'section-header');
  const title = el('h1', 'section-title', section.title);
  title.tabIndex = -1;
  header.append(title);
  header.append(el('p', 'section-desc', section.description));

  const body = el('div', 'section-body');
  fieldsRoot.append(header, body);

  bindings = section.render(ctx, body);
  for (const binding of bindings) binding();
  initMobileCards(body, expanded);
  fieldsRoot.scrollTop = resetScroll ? 0 : previousScroll;
}

/* ------------------------------------------------------------------ */
/* Header status                                                      */
/* ------------------------------------------------------------------ */

function updateDraftStatus(override?: string): void {
  if (override) {
    draftEl.textContent = override;
    return;
  }
  const savedAt = store.getDraftSavedAt();
  if (savedAt > 0) {
    draftEl.textContent = `${tr('черновик')} · ${formatClock(savedAt)}`;
    draftEl.title =
      currentLocale() === 'en'
        ? `Local draft saved at ${formatClock(savedAt)}`
        : `Локальный черновик сохранён в ${formatClock(savedAt)}`;
  } else {
    draftEl.textContent = tr('черновик пуст');
    draftEl.title =
      currentLocale() === 'en'
        ? 'Changes are saved automatically in this browser'
        : 'Изменения автоматически сохраняются в этом браузере';
  }
}

function updateTenantPill(): void {
  const config = store.getConfig();
  const schemeLabels: Record<string, string> = {
    light: tr('светлая'),
    dark: tr('тёмная'),
    auto: tr('как в системе'),
  };
  tenantPill.textContent = `${currentLocale() === 'en' ? 'organization:' : 'организация:'} ${config.tenantId}`;
  tenantPill.title = `Версия конфигурации ${config.configVersion} · тема: ${schemeLabels[config.theme.scheme] ?? config.theme.scheme}`;
}

/**
 * Base URL for the API documentation links.
 *
 * On localhost we keep the dev server (`http://localhost:8787` by default).
 * In production the editor is served by the AGIL server itself, so when no
 * explicit non-local server URL is configured we link the docs on the same
 * origin instead of a hard-coded localhost (F-07).
 */
function docsBaseUrl(): string {
  const settings = loadServerSettings(store.getConfig().tenantId);
  const { hostname, origin } = window.location;
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  if (isLocal) return normalizeServerUrl(settings.serverUrl);
  const stored = (readStorage(SETTINGS_KEYS.serverUrl) ?? '').trim();
  const configured = stored || DEFAULT_SERVER_URL;
  const pointsToLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(configured);
  return !stored || pointsToLocal ? origin : normalizeServerUrl(configured);
}

/** Header links to the server's API explorer, OpenAPI spec and docs. */
function updateApiLinks(): void {
  const base = docsBaseUrl();
  if (docsLink) {
    docsLink.href = `${base}/docs`;
    docsLink.title = `Документация API сервера: ${base}/docs`;
  }
  if (openapiLink) {
    openapiLink.href = `${base}/openapi.json`;
    openapiLink.title = `Спецификация OpenAPI (JSON, версия 3.1) — машиночитаемое описание API для Swagger и Postman: ${base}/openapi.json`;
  }
  if (apiGuideLink) {
    apiGuideLink.href = `${base}/docs/api-guide.md`;
    apiGuideLink.title = `Руководство интегратора по API: ${base}/docs/api-guide.md`;
  }
  if (apiMdLink) {
    apiMdLink.href = `${base}/docs/api.md`;
    apiMdLink.title = `Справочник HTTP API: ${base}/docs/api.md`;
  }
}

/* ------------------------------------------------------------------ */
/* Inspector + preview                                                */
/* ------------------------------------------------------------------ */

// «Аги» mascot: floating helper with per-section roles + guard before PATCH.
const mascot = createMascot({
  getConfig: () => store.getConfig(),
  getSection: () => {
    const section = sections.find((candidate) => candidate.id === activeId);
    return { id: activeId, title: section?.title ?? activeId };
  },
  notify: (message, tone) => toast(message, tone ?? 'info'),
});

const inspector = mountInspector(inspectorRoot, {
  getConfig: () => store.getConfig(),
  getBase: store.getBase,
  setBase: store.setBase,
  applyImported: (config) => {
    ctx.invalidText.clear();
    store.replace(config);
  },
  resetConfig: () => {
    ctx.invalidText.clear();
    store.reset();
  },
  checkDraftFields: () => {
    const invalidOptions = ctx.invalidText.keys().next().value;
    const path = invalidOptions ?? findInvalidProviderEndpoint(store.getConfig().providers);
    if (path === undefined) return undefined;
    selectSection('providers');
    const attribute = invalidOptions === undefined ? 'data-field-path' : 'data-provider-options';
    const field = fieldsRoot.querySelector<HTMLElement>(`[${attribute}="${CSS.escape(path)}"]`);
    field?.closest('.card.is-collapsed')?.querySelector<HTMLButtonElement>('[data-card-toggle]')?.click();
    field?.focus();
    return invalidOptions === undefined
      ? tr('Исправьте адрес внешнего сервиса.')
      : tr('Исправьте JSON в настройках внешнего сервиса.');
  },
  notify: (message, tone) => toast(message, tone ?? 'info'),
  beforeSave: (settings, config) => mascot.confirmSave(settings, config),
});

const preview = createPreview({
  stage,
  overlay,
  actions: actionsRoot,
  status: statusEl,
  log: logEl,
  focusSettings: previewOnly ? undefined : focusSettings,
  getScheme: () => store.getConfig().theme.scheme,
  setScheme: (scheme) => store.set('theme.scheme', scheme),
  getTenantId: () => loadServerSettings(store.getConfig().tenantId).tenantId,
  getServerUrl: () => docsBaseUrl(),
  getLayoutPrefs: () => ({
    header: store.getConfig().layout.header,
    videoFit: store.getConfig().layout.videoFit,
    immersiveVideo: store.getConfig().layout.immersiveVideo,
  }),
  setLayoutPrefs: (patch) => {
    store.update('layout', (previous) => ({ ...(previous as Record<string, unknown>), ...patch }));
  },
  setControlsStyle: (style) => store.set('layout.controlsStyle', style),
  flushDraft: () => store.flushDraft(),
});

// Switching only `theme.scheme` keeps the previous palette's colour tokens (dark
// palette + light scheme = white text on a light background). Rebuild the palette
// once per scheme change so the preview/export/save stay readable.
let normalizedScheme: string = store.getConfig().theme.scheme;
let normalizingScheme = false;

store.subscribe(() => {
  const config = store.getConfig();
  if (!normalizingScheme && config.theme.scheme !== 'auto' && config.theme.scheme !== normalizedScheme) {
    normalizedScheme = config.theme.scheme;
    const normalized = themeForScheme(config.theme, config.theme.scheme);
    if (JSON.stringify(normalized) !== JSON.stringify(config.theme)) {
      normalizingScheme = true;
      try {
        store.set('theme', normalized);
      } finally {
        normalizingScheme = false;
      }
      return;
    }
  } else if (config.theme.scheme === 'auto') {
    normalizedScheme = 'auto';
  }
  for (const binding of bindings) binding();
  inspector.sync(config);
  mascot.sync(config);
  preview.pushConfig(config);
  updateTenantPill();
  updateApiLinks();
  updateDraftStatus(tr('сохраняем черновик…'));
});

store.onDraftSaved(() => {
  updateDraftStatus();
});

window.addEventListener('pagehide', () => {
  store.flushDraft();
});

/* ------------------------------------------------------------------ */
/* Initial paint                                                      */
/* ------------------------------------------------------------------ */

document.title = previewOnly
  ? tr('Предпросмотр звонка')
  : currentLocale() === 'en' ? 'AgilFrame — visual panel editor' : 'AgilFrame — визуальный редактор панели';
updateNav();
updateTenantPill();
updateApiLinks();
updateDraftStatus();
renderSection(true);
inspector.sync(store.getConfig());
preview.pushConfig(store.getConfig());


// Re-apply responsive card defaults when moving between phone/desktop widths.
window.matchMedia('(max-width: 900px)').addEventListener('change', () => {
  const body = document.querySelector('.section-body');
  if (body instanceof HTMLElement) initMobileCards(body);
});
