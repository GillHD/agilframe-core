/**
 * Preview iframe: the centre column of the editor.
 *
 * The preview needs a REAL room: `embed.html?room=preview` produced
 * "Room not found" as soon as the admin tried to join. The editor now creates a
 * throwaway room through the public API before mounting the iframe:
 *
 *   POST {serverUrl}/v1/rooms { tenantId, name: 'Превью редактора' }
 *   → room.id + short-lived token (+ expiresAt)
 *   → iframe src `/embed.html?room=<id>&token=<token>&tenant=<tenantId>`
 *
 * The token is kept only inside the same-origin iframe URL (never in the visible
 * UI, logs or the "open in a new tab" URL). The session is cached per
 * server+tenant, refreshed when the token is about to expire and re-created when
 * the tenant/server changes. When anonymous room creation is disabled
 * (401/403/404/network) the iframe falls back to
 * `?room=preview&tenant=…&previewMode=1` and the editor injects a guard into the
 * same-origin iframe: join buttons are disabled and a banner explains
 * «Это превью темы; чтобы проверить звонок, создайте комнату».
 *
 * postMessage contract (§7) is unchanged:
 *   parent → iframe: {type:'agil:config'}, {type:'agil:scheme'}
 *   iframe → parent: {type:'agil:ready'}, {type:'agil:event'}, {type:'agil:state'}
 */
import { tenantConfigSchema, type TenantConfig, type ThemeScheme } from '@agil/protocol';
import { themeForScheme } from './theme-scheme.js';
import { button, debounce, el, icon, isRecord } from './dom';
import { normalizeServerUrl } from './api';
import { currentLocale, tr } from './i18n';

const DEV_PREVIEW_URL = 'http://localhost:5173/embed.html';
const CONFIG_DEBOUNCE_MS = 150;
const READY_TIMEOUT_MS = 3200;
const ROOM_NAME = 'Предпросмотр из редактора';
const ROOM_CREATE_TIMEOUT_MS = 8000;
const ROOM_MAX_TTL_MS = 25 * 60 * 1000;
const ROOM_REFRESH_MARGIN_MS = 60 * 1000;
const PREVIEW_FALLBACK_ROOM = 'preview';
/**
 * Preview room handoff, scoped to one browser tab. Persisting the room lets a
 * reload / back-navigation reuse it instead of creating another orphan on every
 * editor load (QA round 15 P2-1). The token is short-lived and stays in the
 * same-origin iframe URL; only the id/token/expiry pair lives here.
 */
const ROOM_SESSION_KEY = 'agil.editor.preview.room.v1';

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

/** Base embed.html URL (configured dev/demo URL or same-origin production URL). */
function previewBase(): string {
  const configured = import.meta.env.VITE_PREVIEW_URL;
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim();
  const { hostname, origin } = window.location;
  return import.meta.env.DEV && isLocalHostname(hostname) ? DEV_PREVIEW_URL : new URL('/embed.html', origin).toString();
}

/** Backward-compatible helper: fallback URL without a created room (previewMode). */
export function resolvePreviewUrl(tenantId = 'demo'): string {
  try {
    const target = new URL(previewBase(), window.location.href);
    target.searchParams.set('room', PREVIEW_FALLBACK_ROOM);
    target.searchParams.set('tenant', tenantId.trim() || 'demo');
    target.searchParams.set('previewMode', '1');
    return target.toString();
  } catch {
    return previewBase();
  }
}

export type PreviewStatusKind = 'connecting' | 'ready' | 'offline';

/** The test participant count and layout override stay local to the preview. */
type SimLayout = TenantConfig['layout']['mode'];
type SimLayoutOverride = Exclude<SimLayout, 'sidebar'>;
type SimControls = 'bar' | 'island' | 'minimal';

interface SimSettings {
  count: number;
  layoutOverride: SimLayoutOverride | null;
  controls: SimControls;
}

const SIM_DEFAULTS: SimSettings = { count: 2, layoutOverride: null, controls: 'island' };
const SIM_KEY_PREFIX = 'agil.editor.sim.v1.';
const SIM_MIN = 1;
const SIM_MAX = 50;
const SIM_ACK_TIMEOUT_MS = 1500;
const SIM_DEBOUNCE_MS = 250;

/**
 * The widget collapses `controlsStyle: 'bar'` to the island below 640 px. A
 * phone/tablet preview stage cannot be that wide, so the "bar" design mode
 * renders the iframe at this logical width and scales it down into the stage.
 * The widget then draws its real bar — the preview never fakes one (QA P2).
 */
const WIDE_BAR_PREVIEW_WIDTH = 700;
const NARROW_CONTROLS_MAX_WIDTH = 640;

function clampSimCount(value: number): number {
  if (!Number.isFinite(value)) return SIM_DEFAULTS.count;
  return Math.min(SIM_MAX, Math.max(SIM_MIN, Math.round(value)));
}

function simStorageKey(tenant: string): string {
  return `${SIM_KEY_PREFIX}${(tenant || 'demo').trim() || 'demo'}`;
}

function loadSimSettings(tenant: string): SimSettings {
  try {
    const raw = window.localStorage.getItem(simStorageKey(tenant));
    if (!raw) return { ...SIM_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<SimSettings> & { layout?: unknown };
    // Older settings always stored 'grid', even when no one chose it. Keep
    // explicitly selected spotlight previews while migrating the default.
    const override = parsed.layoutOverride ?? (parsed.layout === 'spotlight' ? 'spotlight' : null);
    const layoutOverride = override === 'grid' || override === 'spotlight' ? override : null;
    const controls: SimControls = parsed.controls === 'island' || parsed.controls === 'minimal' ? parsed.controls : 'bar';
    return { count: clampSimCount(typeof parsed.count === 'number' ? parsed.count : SIM_DEFAULTS.count), layoutOverride, controls };
  } catch {
    return { ...SIM_DEFAULTS };
  }
}

function saveSimSettings(tenant: string, settings: SimSettings): void {
  try {
    window.localStorage.setItem(simStorageKey(tenant), JSON.stringify(settings));
  } catch {
    /* localStorage may be unavailable */
  }
}

const SIM_LAYOUT_LABELS: Record<SimLayout, string> = { grid: 'Сетка', spotlight: 'Говорящий', sidebar: 'С боковой панелью (sidebar)' };

type HeaderDensity = 'full' | 'compact' | 'hidden';
type VideoFit = 'contain' | 'cover';

interface LayoutPrefs {
  header: HeaderDensity;
  videoFit: VideoFit;
  immersiveVideo: boolean;
}

export interface PreviewOptions {
  stage: HTMLElement;
  overlay: HTMLElement;
  actions: HTMLElement;
  status: HTMLElement;
  log: HTMLElement;
  focusSettings?(): void;
  getScheme(): ThemeScheme;
  setScheme(scheme: ThemeScheme): void;
  /** Tenant used for the preview room. */
  getTenantId(): string;
  /** Server base for the public `POST /v1/rooms` call (same-origin on prod). */
  getServerUrl(): string;
  /** Current layout knobs for the test-scenario panel (header/videoFit/immersive). */
  getLayoutPrefs(): LayoutPrefs;
  /** Applies layout knobs to the editor config → immediate postMessage to preview. */
  setLayoutPrefs(patch: Partial<LayoutPrefs>): void;
  /** Persists the controls style (bar/island/minimal) in layout.controlsStyle. */
  setControlsStyle(style: SimControls): void;
  flushDraft(): void;
}

export interface PreviewController {
  readonly url: string;
  readonly frame: HTMLIFrameElement;
  pushConfig(config: TenantConfig): void;
  reload(): void;
  openInNewTab(): void;
  destroy(): void;
}

interface RoomSession {
  key: string;
  server: string;
  tenant: string;
  roomId: string;
  token?: string;
  expiresAt: number;
  fallback: boolean;
  createdAt: number;
}

function withCacheBust(url: string): string {
  try {
    const next = new URL(url, window.location.href);
    next.searchParams.set('_r', Date.now().toString(36));
    return next.toString();
  } catch {
    return url;
  }
}

/** Restores the preview room created by this tab (survives reloads). */
function readPersistedRoom(): RoomSession | null {
  try {
    const raw = window.sessionStorage.getItem(ROOM_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RoomSession>;
    if (
      typeof parsed.key !== 'string' ||
      typeof parsed.server !== 'string' ||
      typeof parsed.tenant !== 'string' ||
      typeof parsed.roomId !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      !Number.isFinite(parsed.expiresAt)
    ) {
      return null;
    }
    return {
      key: parsed.key,
      server: parsed.server,
      tenant: parsed.tenant,
      roomId: parsed.roomId,
      ...(typeof parsed.token === 'string' && parsed.token ? { token: parsed.token } : {}),
      expiresAt: parsed.expiresAt,
      fallback: false,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function persistRoom(session: RoomSession): void {
  if (session.fallback) return;
  try {
    window.sessionStorage.setItem(
      ROOM_SESSION_KEY,
      JSON.stringify({
        key: session.key,
        server: session.server,
        tenant: session.tenant,
        roomId: session.roomId,
        // Deliberately no token: a reload mints a fresh one through /join.
        expiresAt: session.expiresAt,
        createdAt: session.createdAt,
      }),
    );
  } catch {
    /* sessionStorage may be unavailable (private mode/quota) — room still works. */
  }
}

function readRoomSession(payload: unknown): { roomId: string; token?: string; expiresAt?: number } | null {
  if (!isRecord(payload) || !isRecord(payload.room)) return null;
  const roomId = payload.room.id;
  if (typeof roomId !== 'string' || roomId.length === 0) return null;
  const token = typeof payload.token === 'string' && payload.token.length > 0 ? payload.token : undefined;
  const expiresAt = typeof payload.expiresAt === 'number' && Number.isFinite(payload.expiresAt) ? payload.expiresAt : undefined;
  return { roomId, token, ...(expiresAt ? { expiresAt } : {}) };
}

export function createPreview(options: PreviewOptions): PreviewController {
  let session: RoomSession | null = readPersistedRoom();
  let pendingSession: Promise<RoomSession> | null = null;
  let currentUrl = '';
  const frame = document.createElement('iframe');
  frame.className = 'preview-frame';
  frame.dataset.testid = 'preview-iframe';
  const previewTitle = tr('Предпросмотр панели AgilFrame');
  frame.title = previewTitle;
  frame.setAttribute(
    'allow',
    'camera; microphone; display-capture; autoplay; clipboard-write; fullscreen',
  );
  frame.referrerPolicy = 'no-referrer';
  options.stage.append(frame);

  let latestConfig: TenantConfig | null = null;
  let ready = false;
  let lastScheme: ThemeScheme | null = null;
  let readyTimer: number | undefined;
  let refreshTimer: number | undefined;
  let previewModeDoc: Document | null = null;
  let shortcutDoc: Document | null = null;
  let previewModeObserver: MutationObserver | null = null;
  let sim: SimSettings = loadSimSettings(options.getTenantId());
  let simTenant = options.getTenantId();
  let simSupported: boolean | null = null;
  let simRequestId = 0;
  let simAckTimer: number | undefined;
  let simSendTimer: number | undefined;
  const logLines: string[] = [];

  const setStatus = (kind: PreviewStatusKind, message: string): void => {
    options.status.dataset.kind = kind;
    options.status.textContent = message;
    options.overlay.hidden = kind !== 'offline';
  };

  const log = (line: string): void => {
    // Never log the iframe URL: it carries the short-lived join token.
    logLines.push(line);
    while (logLines.length > 4) logLines.shift();
    options.log.textContent = logLines.join('\n');
    options.log.hidden = false;
  };

  const overlayCard = el('div', 'offline-card');
  overlayCard.append(icon('alert', 'icon icon-warning'));
  overlayCard.append(el('strong', 'offline-title', tr('Предпросмотр недоступен — JSON и экспорт работают')));
  overlayCard.append(
    el(
      'p',
      'field-hint',
      tr('Файл embed.html не отвечает. При разработке запустите npm run dev (демо на порту 5173). В рабочей версии проверьте, что сервер отдаёт /embed.html с того же адреса, ') +
        tr('или задайте VITE_PREVIEW_URL при сборке. Остальное работает: JSON, импорт и экспорт доступны.'),
    ),
  );
  const retry = button(tr('Перезагрузить предпросмотр'), 'btn btn-primary', 'refresh');
  retry.addEventListener('click', () => reload());
  overlayCard.append(retry);
  options.overlay.replaceChildren(overlayCard);

  const schemeSelect = el('select', 'input input-select scheme-select');
  schemeSelect.setAttribute('aria-label', tr('Схема темы предпросмотра'));
  const schemeLabels: Record<string, string> = {
    light: tr('Светлая (light)'),
    dark: tr('Тёмная (dark)'),
    auto: tr('Как в системе (auto)'),
  };
  for (const scheme of ['light', 'dark', 'auto'] as const) {
    const option = el('option');
    option.value = scheme;
    option.textContent = schemeLabels[scheme] ?? scheme;
    schemeSelect.append(option);
  }
  schemeSelect.value = options.getScheme();
  schemeSelect.addEventListener('change', () => {
    const value = schemeSelect.value;
    if (value === 'light' || value === 'dark' || value === 'auto') options.setScheme(value);
  });

  const openButton = button(tr('Новая вкладка'), 'btn btn-small', 'external');
  openButton.dataset.testid = 'preview-new-tab';
  const reloadButton = button(tr('Обновить'), 'btn btn-small', 'refresh');
  openButton.addEventListener('click', () => openInNewTab());
  reloadButton.addEventListener('click', () => reload());
  const toolbar = el('div', 'preview-actions-inner');
  toolbar.append(schemeSelect, openButton, reloadButton);
  const settings = options.focusSettings ? button(tr('К настройкам'), 'btn btn-small') : null;
  if (settings && options.focusSettings) {
    settings.dataset.testid = 'preview-return-settings';
    settings.addEventListener('click', options.focusSettings);
    toolbar.append(settings);
  }
  options.actions.append(toolbar);

  /* ---------------- Test-scenario panel (design-only simulation) ---------------- */
  const simPanel = document.createElement('details');
  simPanel.className = 'sim-panel';
  simPanel.dataset.testid = 'sim-panel';
  const simSummary = el('summary', 'sim-summary');
  const simSummaryTitle = el('span', 'sim-summary-title', tr('Тест-сценарий'));
  const simSummaryState = el('span', 'sim-summary-state');
  simSummary.append(simSummaryTitle, simSummaryState);
  const simBody = el('div', 'sim-body');
  const countRow = el('label', 'sim-row');
  countRow.append(el('span', 'sim-label', tr('Участники')));
  const countNumber = el('input', 'sim-number') as HTMLInputElement;
  countNumber.type = 'number';
  countNumber.min = String(SIM_MIN);
  countNumber.max = String(SIM_MAX);
  countNumber.step = '1';
  countNumber.dataset.testid = 'sim-count';
  countNumber.setAttribute('aria-label', tr('Количество тестовых участников'));
  const countRange = el('input', 'sim-range') as HTMLInputElement;
  countRange.type = 'range';
  countRange.min = String(SIM_MIN);
  countRange.max = String(SIM_MAX);
  countRange.step = '1';
  countRange.setAttribute('aria-label', tr('Количество тестовых участников (ползунок)'));
  countRow.append(countNumber, countRange);

  const layoutRow = el('label', 'sim-row');
  layoutRow.append(el('span', 'sim-label', tr('Раскладка')));
  const layoutSelect = el('select', 'sim-select') as HTMLSelectElement;
  layoutSelect.dataset.testid = 'sim-layout';
  const draftLayoutOption = el('option', '', tr('Как в черновике'));
  draftLayoutOption.value = 'draft';
  layoutSelect.append(draftLayoutOption);
  for (const layout of ['grid', 'spotlight'] as const) {
    const option = el('option', '', tr(SIM_LAYOUT_LABELS[layout]));
    option.value = layout;
    layoutSelect.append(option);
  }
  layoutRow.append(layoutSelect);

  const controlsRow = el('label', 'sim-row');
  controlsRow.append(el('span', 'sim-label', tr('Панель звонка')));
  const controlsSelect = el('select', 'sim-select') as HTMLSelectElement;
  controlsSelect.dataset.testid = 'sim-controls';
  for (const controls of ['bar', 'island', 'minimal'] as const) {
    const option = el('option', '', { bar: tr('На всю ширину'), island: tr('Плавающая'), minimal: tr('Минимальная') }[controls]);
    option.value = controls;
    controlsSelect.append(option);
  }
  controlsRow.append(controlsSelect);

  const headerRow = el('label', 'sim-row');
  headerRow.append(el('span', 'sim-label', tr('Шапка')));
  const headerSelect = el('select', 'sim-select') as HTMLSelectElement;
  headerSelect.dataset.testid = 'sim-header';
  for (const header of ['full', 'compact', 'hidden'] as const) {
    const option = el('option', '', { full: tr('Полная'), compact: tr('Компактная'), hidden: tr('Скрытая') }[header]);
    option.value = header;
    headerSelect.append(option);
  }
  headerRow.append(headerSelect);

  const fitRow = el('label', 'sim-row');
  fitRow.append(el('span', 'sim-label', tr('Заполнение видео')));
  const fitSelect = el('select', 'sim-select') as HTMLSelectElement;
  fitSelect.dataset.testid = 'sim-video-fit';
  for (const fit of ['contain', 'cover'] as const) {
    const option = el('option', '', fit === 'contain' ? tr('Весь кадр') : tr('Заполнить плитку'));
    option.value = fit;
    fitSelect.append(option);
  }
  fitRow.append(fitSelect);

  const immersiveRow = el('label', 'sim-toggle');
  const immersiveInput = el('input', 'sim-checkbox') as HTMLInputElement;
  immersiveInput.type = 'checkbox';
  immersiveInput.dataset.testid = 'sim-immersive';
  immersiveInput.setAttribute('aria-label', tr('Видео на весь интерфейс (immersive)'));
  immersiveRow.append(immersiveInput, el('span', '', tr('Видео на весь интерфейс (immersive)')));

  const simActions = el('div', 'sim-actions');
  const simApply = button(tr('Применить'), 'btn btn-primary btn-small', 'check');
  simApply.dataset.testid = 'sim-apply';
  const simReset = button(tr('Сбросить'), 'btn btn-small', 'refresh');
  simReset.dataset.testid = 'sim-reset';
  const simStatus = el('span', 'sim-status');
  simStatus.dataset.testid = 'sim-status';
  simActions.append(simApply, simReset, simStatus);
  simBody.append(countRow, layoutRow, controlsRow, headerRow, fitRow, immersiveRow, simActions);
  simPanel.append(simSummary, simBody);
  options.actions.append(simPanel);

  const caption = el('div', 'preview-caption');
  caption.dataset.testid = 'preview-caption';
  caption.hidden = true;
  options.stage.after(caption);

  const clearReadyTimer = (): void => {
    if (readyTimer !== undefined) {
      window.clearTimeout(readyTimer);
      readyTimer = undefined;
    }
  };

  const clearRefreshTimer = (): void => {
    if (refreshTimer !== undefined) {
      window.clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
  };

  const sessionKey = (): { server: string; tenant: string; key: string } => {
    const server = normalizeServerUrl(options.getServerUrl());
    const tenant = options.getTenantId().trim() || 'demo';
    return { server, tenant, key: `${server}|${tenant}` };
  };

  const isExpired = (candidate: RoomSession): boolean => {
    if (candidate.fallback) return false;
    return Date.now() > candidate.expiresAt - ROOM_REFRESH_MARGIN_MS;
  };

  const matches = (candidate: RoomSession | null, key: string): candidate is RoomSession =>
    Boolean(candidate && candidate.key === key);

  async function createRoomSession(server: string, tenant: string, key: string): Promise<RoomSession> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), ROOM_CREATE_TIMEOUT_MS);
    try {
      const response = await fetch(`${server}/v1/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: tenant, name: tr(ROOM_NAME) }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`room create failed (${response.status})`);
      const parsed = readRoomSession(await response.json());
      if (!parsed) throw new Error('room create returned an unexpected payload');
      return {
        key,
        server,
        tenant,
        roomId: parsed.roomId,
        ...(parsed.token ? { token: parsed.token } : {}),
        expiresAt: parsed.expiresAt ?? Date.now() + ROOM_MAX_TTL_MS,
        fallback: false,
        createdAt: Date.now(),
      };
    } finally {
      window.clearTimeout(timer);
    }
  }

  /**
   * Mints a fresh token for an existing preview room. Used when the cached
   * token nears expiry: reusing the room avoids creating another orphan.
   * Returns `null` when the room is gone/locked, so the caller creates a new one.
   */
  async function refreshRoomToken(current: RoomSession): Promise<RoomSession | null> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), ROOM_CREATE_TIMEOUT_MS);
    try {
      const response = await fetch(`${current.server}/v1/rooms/${encodeURIComponent(current.roomId)}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: tr('Редактор'), locale: currentLocale() }),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const payload = await response.json();
      const token = isRecord(payload) && typeof payload.token === 'string' ? payload.token : '';
      if (!token) return null;
      const expiresAt =
        isRecord(payload) && typeof payload.expiresAt === 'number' && Number.isFinite(payload.expiresAt)
          ? payload.expiresAt
          : Date.now() + ROOM_MAX_TTL_MS;
      return { ...current, token, expiresAt };
    } catch {
      return null;
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function ensureSession(): Promise<RoomSession> {
    const { server, tenant, key } = sessionKey();
    const now = Date.now();
    if (matches(session, key)) {
      if (session.fallback) return session;
      // A persisted session has the room id only (no token on disk): mint a
      // fresh token via /join instead of creating another room.
      if (!isExpired(session) && session.token) return session;
      setStatus('connecting', tr('Обновляем доступ к комнате предпросмотра…'));
      const refreshed = await refreshRoomToken(session);
      if (refreshed && matches(refreshed, key)) {
        session = refreshed;
        persistRoom(session);
        scheduleRefresh(session);
        log(tr('Комната для предпросмотра переиспользована — выдан новый токен.'));
        return session;
      }
    }
    // Concurrent mounts must share one room: never issue two POST /v1/rooms.
    if (pendingSession) {
      const pending = await pendingSession.catch(() => null);
      if (pending && pending.key === key) return pending;
    }
    setStatus('connecting', tr('Готовим комнату для предпросмотра…'));
    pendingSession = (async (): Promise<RoomSession> => {
      try {
        const created = await createRoomSession(server, tenant, key);
        session = created;
        persistRoom(created);
        log(tr('Комната для предпросмотра создана — войти в звонок можно.'));
      } catch {
        session = {
          key,
          server,
          tenant,
          roomId: PREVIEW_FALLBACK_ROOM,
          expiresAt: now + ROOM_MAX_TTL_MS,
          fallback: true,
          createdAt: now,
        };
        log(tr('Демо-режим предпросмотра: комнату создать не удалось, вход в звонок отключён.'));
      }
      scheduleRefresh(session);
      return session;
    })();
    try {
      return await pendingSession;
    } finally {
      pendingSession = null;
    }
  }

  function scheduleRefresh(current: RoomSession): void {
    clearRefreshTimer();
    if (current.fallback) return;
    const delay = Math.max(30_000, current.expiresAt - Date.now() - ROOM_REFRESH_MARGIN_MS);
    refreshTimer = window.setTimeout(() => {
      if (!frame.isConnected) return;
      void mount();
    }, delay);
  }

  function buildUrl(current: RoomSession): string {
    const target = new URL(previewBase(), window.location.href);
    target.searchParams.set('room', current.roomId);
    target.searchParams.set('tenant', current.tenant);
    target.searchParams.set('lang', currentLocale());
    // `preview=1` enables the widget's design-only participant simulation.
    target.searchParams.set('preview', '1');
    if (current.fallback) target.searchParams.set('previewMode', '1');
    else if (current.token && target.origin === window.location.origin) {
      target.searchParams.set('server', current.server);
      target.searchParams.set('token', current.token);
    }
    return target.toString();
  }

  let mountRevision = 0;

  async function mount(): Promise<void> {
    const revision = ++mountRevision;
    clearReadyTimer();
    if (simAckTimer !== undefined) window.clearTimeout(simAckTimer);
    if (simSendTimer !== undefined) window.clearTimeout(simSendTimer);
    simSupported = null;
    delete simPanel.dataset.simRequest;
    ready = false;
    lastScheme = null;
    updateCaption();
    setStatus('connecting', tr('Подключаем предпросмотр…'));
    frame.src = 'about:blank';
    let current: RoomSession;
    try {
      current = await ensureSession();
    } catch {
      current = {
        key: sessionKey().key,
        server: sessionKey().server,
        tenant: sessionKey().tenant,
        roomId: PREVIEW_FALLBACK_ROOM,
        expiresAt: Date.now() + ROOM_MAX_TTL_MS,
        fallback: true,
        createdAt: Date.now(),
      };
      session = current;
    }
    if (revision !== mountRevision || current.key !== sessionKey().key) return;
    currentUrl = withCacheBust(buildUrl(current));
    frame.src = currentUrl;
    scheduleReadyCheck(current);
  }

  const scheduleReadyCheck = (current: RoomSession): void => {
    clearReadyTimer();
    readyTimer = window.setTimeout(() => {
      if (ready) return;
      setStatus('offline', tr('Предпросмотр не отвечает'));
      log(tr('Встроенное окно не ответило за 3,2 с.'));
      if (current.fallback) log(tr('Демо-режим предпросмотра: комната не создана, вход в звонок заблокирован.'));
    }, READY_TIMEOUT_MS);
  };

  /** Disables join in the same-origin fallback iframe and explains previewMode. */
  function applyPreviewModeGuard(): void {
    if (!session?.fallback) return;
    let doc: Document;
    try {
      doc = frame.contentDocument ?? (frame.contentWindow?.document as Document);
    } catch {
      log(tr('Предпросмотр открыт с другого адреса: проверка рисков недоступна.'));
      return;
    }
    if (!doc || !doc.body) return;
    if (previewModeDoc === doc) return;
    previewModeObserver?.disconnect();
    previewModeDoc = doc;
    const style = doc.createElement('style');
    style.id = 'agil-preview-mode-style';
    style.textContent = `
      #agil-preview-mode-note {
        position: sticky; top: 0; z-index: 2147483647;
        padding: 10px 14px; margin: 0;
        background: #fef3c7; color: #78350f;
        border-bottom: 1px solid #f59e0b;
        font: 500 12px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      }
      #agil-preview-mode-note strong { font-weight: 700; }
      [data-agil-preview-join] { opacity: .55 !important; cursor: not-allowed !important; }
    `;
    doc.head.append(style);
    const note = doc.createElement('div');
    note.id = 'agil-preview-mode-note';
    const title = doc.createElement('strong');
    title.textContent = tr('Предпросмотр темы.');
    note.append(title, ' ', tr('Комната не создана, поэтому вход в звонок отключён. Чтобы проверить звонок, создайте комнату в панели или разрешите анонимные комнаты на сервере.'));
    doc.body.prepend(note);
    // NB: elements inside the iframe belong to another realm, so instanceof checks
    // against the parent's HTMLElement/Element always fail — use nodeType/tagName.
    const isElement = (node: unknown): node is Element => Boolean(node && typeof node === 'object' && (node as Node).nodeType === 1);
    const isJoinButton = (node: Element | null): boolean => {
      if (!node || !isElement(node)) return false;
      const text = ((node.textContent ?? '') as string).trim();
      return /войти|в звонок|только слушать|join|listen only/i.test(text);
    };
    const disableJoins = (): void => {
      for (const candidate of doc.querySelectorAll('button, [role="button"], a')) {
        if (!isJoinButton(candidate)) continue;
        candidate.setAttribute('data-agil-preview-join', '1');
        if (candidate.tagName.toLowerCase() === 'button') (candidate as HTMLButtonElement).disabled = true;
      }
    };
    disableJoins();
    doc.addEventListener(
      'click',
      (event) => {
        const target = isElement(event.target) ? (event.target as Element).closest('button, [role="button"], a') : null;
        if (isJoinButton(target)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
    doc.addEventListener(
      'submit',
      (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
    previewModeObserver = new MutationObserver(() => disableJoins());
    previewModeObserver.observe(doc.body, { childList: true, subtree: true });
    log(tr('Демо-режим: вход в звонок отключён — комната не создана.'));
  }

  const pushConfigNow = debounce(() => {
    if (!latestConfig || !ready) return;
    post({ type: 'agil:config', config: latestConfig, replace: true });
    // Config updates restore the organization layout; reapply the test scenario.
    sendSimulation();
  }, CONFIG_DEBOUNCE_MS);

  function setSimStatus(text: string, tone: 'info' | 'success' | 'error'): void {
    simStatus.textContent = text;
    simStatus.dataset.tone = tone;
  }

  function effectiveSimLayout(): SimLayout {
    return sim.layoutOverride ?? latestConfig?.layout.mode ?? 'grid';
  }

  function simSummaryText(): string {
    return `${sim.count} · ${tr(SIM_LAYOUT_LABELS[effectiveSimLayout()])}`;
  }

  function updateCaption(): void {
    caption.dataset.count = String(sim.count);
    caption.dataset.layout = effectiveSimLayout();
    caption.dataset.controls = sim.controls;
    caption.hidden = !ready;
    if (!ready) return;
    const scale = options.stage.dataset.previewScale;
    const participants = tr('Тестовые участники: {count} (дизайн-превью)', { count: sim.count });
    const viewport = scale ? tr('логическая ширина {width}px, масштаб {scale}%', { width: WIDE_BAR_PREVIEW_WIDTH, scale }) : '';
    caption.textContent = viewport ? `${participants} · ${viewport}` : participants;
  }

  function syncLayoutControls(): void {
    const prefs = options.getLayoutPrefs();
    headerSelect.value = prefs.header;
    fitSelect.value = prefs.videoFit;
    immersiveInput.checked = prefs.immersiveVideo;
    simPanel.dataset.header = prefs.header;
    simPanel.dataset.videoFit = prefs.videoFit;
    simPanel.dataset.immersive = String(prefs.immersiveVideo);
  }

  /**
   * Wide logical viewport for the design-only "bar" mode on narrow stages.
   * Cleared for island/minimal and for stages that can already exceed 640 px,
   * so the normal responsive widget is untouched outside this preview.
   */
  function syncPreviewViewport(): void {
    const stageWidth = options.stage.clientWidth;
    const stageHeight = options.stage.clientHeight;
    const scaleDown =
      sim.controls === 'bar' && stageWidth > 0 && stageWidth <= NARROW_CONTROLS_MAX_WIDTH && stageHeight > 0;
    if (!scaleDown) {
      frame.style.width = '';
      frame.style.height = '';
      frame.style.transform = '';
      delete options.stage.dataset.previewScale;
      return;
    }
    const scale = stageWidth / WIDE_BAR_PREVIEW_WIDTH;
    frame.style.width = `${WIDE_BAR_PREVIEW_WIDTH}px`;
    // Keep the scaled frame tall enough to fill the stage vertically.
    frame.style.height = `${Math.ceil(stageHeight / scale)}px`;
    frame.style.transform = `scale(${scale})`;
    frame.style.transformOrigin = 'top left';
    options.stage.dataset.previewScale = String(Math.round(scale * 100));
  }

  function syncSimUi(): void {
    syncLayoutControls();
    countNumber.value = String(sim.count);
    countRange.value = String(sim.count);
    layoutSelect.value = sim.layoutOverride ?? 'draft';
    controlsSelect.value = sim.controls;
    simSummaryState.textContent = simSummaryText();
    simPanel.dataset.count = String(sim.count);
    simPanel.dataset.layout = effectiveSimLayout();
    simPanel.dataset.controls = sim.controls;
    syncPreviewViewport();
    updateCaption();
  }

  function persistSim(): void {
    saveSimSettings(simTenant, sim);
  }

  function sendSimulation(): void {
    if (!ready) return;
    simSupported = null;
    simRequestId += 1;
    const requestId = `sim-${Date.now().toString(36)}-${simRequestId}`;
    post({
      type: 'agil:simulate-participants',
      count: sim.count,
      layout: effectiveSimLayout(),
      controls: sim.controls,
      requestId,
    });
    simPanel.dataset.simRequest = requestId;
    setSimStatus(tr('отправлено, ждём подтверждение…'), 'info');
    updateCaption();
    if (simAckTimer !== undefined) window.clearTimeout(simAckTimer);
    simAckTimer = window.setTimeout(() => {
      if (simSupported !== null) return;
      simSupported = false;
      simPanel.dataset.supported = 'false';
      setSimStatus(tr('сервер/виджет не поддерживает симуляцию'), 'error');
      log(tr('Виджет не подтвердил сценарий за 1,5 с.'));
    }, SIM_ACK_TIMEOUT_MS);
  }

  function commitSim(action: 'change' | 'apply' | 'reset'): void {
    if (simAckTimer !== undefined) window.clearTimeout(simAckTimer);
    delete simPanel.dataset.simRequest;
    persistSim();
    syncSimUi();
    if (action === 'reset') {
      setSimStatus(tr('значения по умолчанию'), 'info');
    }
    if (simSendTimer !== undefined) window.clearTimeout(simSendTimer);
    if (action === 'apply' || action === 'reset') {
      sendSimulation();
    } else {
      simSendTimer = window.setTimeout(() => sendSimulation(), SIM_DEBOUNCE_MS);
    }
  }

  const onViewportResize = (): void => {
    syncPreviewViewport();
    updateCaption();
  };
  const previewResizeObserver =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onViewportResize) : null;
  previewResizeObserver?.observe(options.stage);
  window.addEventListener('resize', onViewportResize);

  countRange.addEventListener('input', () => {
    sim.count = clampSimCount(Number(countRange.value));
    commitSim('change');
  });
  countNumber.addEventListener('change', () => {
    sim.count = clampSimCount(Number(countNumber.value));
    commitSim('change');
  });
  layoutSelect.addEventListener('change', () => {
    const layout = layoutSelect.value;
    sim.layoutOverride = layout === 'grid' || layout === 'spotlight' ? layout : null;
    commitSim('change');
  });
  controlsSelect.addEventListener('change', () => {
    sim.controls = controlsSelect.value === 'minimal' ? 'minimal' : controlsSelect.value === 'island' ? 'island' : 'bar';
    options.setControlsStyle(sim.controls);
    commitSim('change');
  });
  headerSelect.addEventListener('change', () => {
    options.setLayoutPrefs({ header: headerSelect.value as HeaderDensity });
    syncLayoutControls();
    setSimStatus(tr('шапка: {value}', { value: headerSelect.selectedOptions[0]?.textContent ?? headerSelect.value }), 'info');
  });
  fitSelect.addEventListener('change', () => {
    options.setLayoutPrefs({ videoFit: fitSelect.value as VideoFit });
    syncLayoutControls();
    setSimStatus(tr('заполнение видео: {value}', { value: fitSelect.selectedOptions[0]?.textContent ?? fitSelect.value }), 'info');
  });
  immersiveInput.addEventListener('change', () => {
    options.setLayoutPrefs({ immersiveVideo: immersiveInput.checked });
    syncLayoutControls();
    setSimStatus(immersiveInput.checked ? tr('immersive включён') : tr('immersive выключен'), 'info');
  });

  simApply.addEventListener('click', () => commitSim('apply'));
  simReset.addEventListener('click', () => {
    sim = { ...SIM_DEFAULTS, controls: sim.controls };
    commitSim('reset');
  });
  syncSimUi();

  function handleSimulationMessage(data: Record<string, unknown>): boolean {
    if (data.type !== 'agil:simulate-participants-ack') return false;
    if (!simPanel.dataset.simRequest || data.requestId !== simPanel.dataset.simRequest) return true;
    if (simAckTimer !== undefined) window.clearTimeout(simAckTimer);
    const ok = data.ok !== false;
    simSupported = ok;
    simPanel.dataset.supported = ok ? 'true' : 'false';
    if (ok) {
      setSimStatus(tr('подтверждено виджетом'), 'success');
      log(tr('Виджет применил сценарий ({count} участн., {layout}).', {
        count: sim.count,
        layout: tr(SIM_LAYOUT_LABELS[effectiveSimLayout()]),
      }));
      updateCaption();
    } else {
      const reason = typeof data.reason === 'string' ? data.reason : 'unsupported';
      setSimStatus(tr('виджет отклонил: {reason}', { reason }), 'error');
      log(tr('виджет отклонил: {reason}', { reason }));
    }
    return true;
  }

  const post = (payload: unknown): void => {
    try {
      frame.contentWindow?.postMessage(payload, window.location.origin);
    } catch {
      /* iframe may be cross-origin in dev */
    }
  };

  const sendAll = (): void => {
    if (!latestConfig) return;
    lastScheme = latestConfig.theme.scheme;
    post({ type: 'agil:scheme', scheme: lastScheme });
    post({ type: 'agil:config', config: latestConfig, replace: true });
  };

  const onPreviewKey = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowUp' || !event.altKey || event.ctrlKey || event.shiftKey || event.metaKey || !options.focusSettings) return;
    event.preventDefault();
    event.stopPropagation();
    options.focusSettings();
  };

  const onLoad = (): void => {
    log(tr('Окно предпросмотра загружено.'));
    shortcutDoc?.removeEventListener('keydown', onPreviewKey, true);
    shortcutDoc = options.focusSettings ? frame.contentDocument : null;
    shortcutDoc?.addEventListener('keydown', onPreviewKey, true);
    if (settings && shortcutDoc) {
      settings.title = tr('Вернуться к настройкам (Alt+↑ в окне звонка)');
      settings.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp');
      frame.title = `${previewTitle}. ${settings.title}`;
    } else if (settings) {
      settings.removeAttribute('title');
      settings.removeAttribute('aria-keyshortcuts');
      frame.title = previewTitle;
    }
    applyPreviewModeGuard();
    if (ready) sendAll();
  };

  function reload(): void {
    if (session?.fallback) session = null;
    ready = false;
    clearReadyTimer();
    log(tr('Предпросмотр перезагружается…'));
    void mount();
  }

  function openInNewTab(): void {
    options.flushDraft();
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'preview');
    url.searchParams.set('lang', currentLocale());
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  frame.addEventListener('load', onLoad);
  window.addEventListener('message', handleMessage);

  function handleMessage(event: MessageEvent): void {
    if (event.source !== frame.contentWindow || event.origin !== window.location.origin) return;
    const data = event.data as unknown;
    if (!isRecord(data) || typeof data.type !== 'string') return;
    if (handleSimulationMessage(data)) return;
    if (data.type === 'agil:ready') {
      ready = true;
      clearReadyTimer();
      setStatus('ready', tr('Предпросмотр подключён.'));
      log(tr('Виджет сообщил о готовности.'));
      applyPreviewModeGuard();
      sendAll();
      sendSimulation();
      return;
    }
    if (data.type === 'agil:event') {
      const name = typeof data.event === 'string' ? data.event : 'event';
      log(`event: ${name}`);
    }
  }

  const controller: PreviewController = {
    get url() {
      return currentUrl;
    },
    frame,
    pushConfig: (config) => {
      const parsed = tenantConfigSchema.safeParse(config);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const detail = issue
          ? `${issue.path.join('.') || tr('(корень)')}: ${issue.message}`
          : tr('причина неизвестна');
        log(tr('Конфигурация не проходит проверку ({issue}): предпросмотр не обновлён.', { issue: detail }));
        return;
      }
      const valid = parsed.data;
      const normalized: TenantConfig = { ...valid, theme: themeForScheme(valid.theme, valid.theme.scheme) };
      const previousMode = latestConfig?.layout.mode;
      latestConfig = normalized;
      syncLayoutControls();
      const tenantNow = options.getTenantId();
      const tenantChanged = tenantNow !== simTenant;
      const modeChanged = previousMode !== normalized.layout.mode;
      if (tenantChanged) {
        simTenant = tenantNow;
        sim = loadSimSettings(tenantNow);
      } else if (previousMode && modeChanged) {
        // Apply explicit form changes and restored layout values immediately.
        sim.layoutOverride = null;
        persistSim();
      }
      if (normalized.layout.controlsStyle !== sim.controls) {
        sim.controls = normalized.layout.controlsStyle;
        commitSim('change');
      } else if (tenantChanged || modeChanged) {
        syncSimUi();
      }
      const { key } = sessionKey();
      if (!session || session.key !== key) {
        // Tenant/server changed: create a fresh room and remount.
        log(tr('Организация или адрес сервера изменились: пересоздаю комнату для предпросмотра.'));
        void mount();
        return;
      }
      if (normalized.theme.scheme !== lastScheme) {
        lastScheme = normalized.theme.scheme;
        post({ type: 'agil:scheme', scheme: lastScheme });
      }
      if (schemeSelect.value !== normalized.theme.scheme) schemeSelect.value = normalized.theme.scheme;
      pushConfigNow();
    },
    reload,
    openInNewTab,
    destroy: () => {
      mountRevision += 1;
      clearReadyTimer();
      clearRefreshTimer();
      previewModeObserver?.disconnect();
      shortcutDoc?.removeEventListener('keydown', onPreviewKey, true);
      previewResizeObserver?.disconnect();
      window.removeEventListener('resize', onViewportResize);
      if (simAckTimer !== undefined) window.clearTimeout(simAckTimer);
      if (simSendTimer !== undefined) window.clearTimeout(simSendTimer);
      window.removeEventListener('message', handleMessage);
      frame.remove();
      caption.remove();
      options.actions.replaceChildren();
    },
  };

  void mount();
  return controller;
}
