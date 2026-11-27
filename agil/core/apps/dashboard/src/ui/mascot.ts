/**
 * Dashboard mascot «Agil»: floating draggable helper, assistant panel, chat with
 * the admin assistant endpoint (local fallback when the server has no DeepSeek
 * key/route), role picker, starters, suggestions, safe operational notices and
 * branding from `tenant.config.branding`.
 */
import type {
  DashboardAssistantMessage,
  DashboardAssistantRequest,
  DashboardAssistantResponse,
  DashboardAssistantRole,
  GuardAssessResponse,
  TenantConfig,
  TenantConfigPatch,
  ThemePatch,
} from '@agil/protocol';
import { auditTheme, bestTextColor, contrastRatio, themePresets } from '@agil/protocol';
import type { AppContext } from '../context.js';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { publicLinks, docsRoute } from '../links.js';
import { renderMarkdown } from '../screens/docs.js';
import { badge } from './badge.js';
import { guardedSave } from './guard.js';
import { button, field, selectInput, textInput, textareaInput } from './controls.js';
import { confirmDialog } from './confirm-dialog.js';
import { emptyState } from './empty-state.js';
import { openModal } from './modal.js';

export type MascotExpression = 'wave' | 'celebrate' | 'angry' | 'thumbsup' | 'thinking' | 'alert';

export interface MascotBranding {
  name: string;
  enabled: boolean;
  /** Custom idle image (branding.mascotUrl); when set it replaces bundled defaults. */
  url: string;
  expressions: Partial<Record<MascotExpression, string>>;
  /** Static PNG fallbacks for bundled WebP animations. */
  staticExpressions: Partial<Record<MascotExpression, string>>;
  avatarExpressions: Partial<Record<MascotExpression, string>>;
}

export const MASCOT_EXPRESSIONS: ReadonlyArray<{ id: MascotExpression; label: string }> = [
  { id: 'wave', label: 'Приветствие' },
  { id: 'thinking', label: 'Размышляет' },
  { id: 'thumbsup', label: 'Успех' },
  { id: 'celebrate', label: 'Радость' },
  { id: 'alert', label: 'Предупреждение' },
  { id: 'angry', label: 'Критическое изменение' },
];

export const ASSISTANT_ROLES: ReadonlyArray<{ id: DashboardAssistantRole; label: string }> = [
  { id: 'assistant', label: 'Помощник по панели' },
  { id: 'config-guardian', label: 'Проверка настроек' },
  { id: 'security-reviewer', label: 'Проверка безопасности' },
  { id: 'onboarding', label: 'Первые шаги' },
  { id: 'api-helper', label: 'Помощник по API' },
  { id: 'scaling-advisor', label: 'Советник по масштабированию' },
  { id: 'roles-admin', label: 'Администратор ролей' },
];

const ROLE_STARTERS: Record<DashboardAssistantRole, string[]> = {
  assistant: ['С чего начать?', 'Как выдать доступ участнику?', 'Что я заметил?'],
  'config-guardian': ['Что изменится при выключении записи?', 'Какие настройки самые рискованные?'],
  'security-reviewer': ['Проверь мои настройки безопасности', 'Что значит событие geo.blocked?'],
  onboarding: ['Создай первую комнату', 'Как пригласить участника?', 'Как выдать токен?'],
  'api-helper': ['Как вызвать /v1/tokens?', 'Где спецификация OpenAPI?', 'Как работает ключ x-api-key?'],
  'scaling-advisor': ['Когда переходить на SFU?', 'Что такое TURN-пул?', 'Как включить несколько серверов?'],
  'roles-admin': ['Чем базовая роль (baseRole) отличается от функций?', 'Как выдать свою роль?', 'Почему нельзя удалить роль организатора (host)?'],
};

/** Screen context → assistant role; manual choice overrides until the next navigation. */
export function roleForRoute(hash: string): DashboardAssistantRole {
  const raw = (hash || '').replace(/^#/, '').split('?')[0]?.replace(/\/+$/, '') ?? '';
  const path = raw || '/overview';
  if (/^\/rooms\/[^/]+/.test(path)) return 'assistant';
  if (path === '/rooms') return 'onboarding';
  if (path === '/security' || path === '/audit') return 'security-reviewer';
  if (path === '/access') return 'roles-admin';
  if (path === '/integrations') return /scale|scaling/i.test(hash) ? 'scaling-advisor' : 'api-helper';
  if (path === '/knowledge') return 'config-guardian';
  if (path === '/recordings') return 'assistant';
  if (path === '/settings') return 'config-guardian';
  if (path === '/docs') return 'api-helper';
  if (path === '/overview' || !path) return 'onboarding';
  return 'assistant';
}

function roleLabelFor(role: DashboardAssistantRole): string {
  return ASSISTANT_ROLES.find((item) => item.id === role)?.label ?? role;
}

const HISTORY_KEY = 'agil_dashboard_assistant_history_v1';
const ROLE_KEY = 'agil_dashboard_assistant_role_v1';
const POS_KEY = 'agil_dashboard_mascot_pos_v1';
const PANEL_ID = 'dashboard-assistant-panel';
const HISTORY_LIMIT = 40;
const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;

interface ScreenshotAnalysis {
  scene: 'light' | 'dark';
  brightness: number;
  dominantColors: string[];
  summary: string;
  variant: number;
  colors: Record<string, string>;
  suggestedTheme: ThemePatch;
  layoutRecommendation: { header: 'compact'; immersiveVideo: true } | null;
}

interface ScreenshotContext {
  dominantColors: string[];
  brightness: number;
  scene: 'light' | 'dark';
  suggestedTheme: ThemePatch;
  layoutRecommendation: ScreenshotAnalysis['layoutRecommendation'];
}

interface MascotMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

interface ChatSession {
  id: string;
  title: string;
  messages: MascotMessage[];
  createdAt: number;
  updatedAt: number;
}

interface ChatStore {
  version: 2;
  currentId: string;
  sessions: ChatSession[];
}

const CHATS_KEY = 'agil_dashboard_assistant_chats_v2';
const CHAT_TITLE_DEFAULT = 'Новый чат';
const CHAT_TITLE_MAX = 56;

function sessionTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > CHAT_TITLE_MAX ? `${clean.slice(0, CHAT_TITLE_MAX - 1)}…` : clean || CHAT_TITLE_DEFAULT;
}

/** History timestamp: «Сегодня/Вчера, 14:20», otherwise «12.11, 14:20». */
function chatDateLabel(ts: number): string {
  const date = new Date(ts);
  const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(date);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const sameDay = (left: Date, right: Date): boolean =>
    left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
  if (sameDay(date, today)) return `Сегодня, ${time}`;
  if (sameDay(date, yesterday)) return `Вчера, ${time}`;
  return `${new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' }).format(date)}, ${time}`;
}

function loadChatStore(): ChatStore {
  try {
    const raw = window.localStorage.getItem(CHATS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ChatStore>;
      const sessions = Array.isArray(parsed.sessions)
        ? parsed.sessions
            .filter((session): session is ChatSession => Boolean(session && typeof session.id === 'string' && Array.isArray(session.messages)))
            .map((session) => ({
              ...session,
              title: session.title || CHAT_TITLE_DEFAULT,
              messages: session.messages.filter(
                (message): message is MascotMessage =>
                  Boolean(message && typeof message.content === 'string' && (message.role === 'user' || message.role === 'assistant')),
              ),
            }))
        : [];
      if (sessions.length > 0) {
        const currentId = sessions.some((session) => session.id === parsed.currentId) ? (parsed.currentId as string) : sessions[0]!.id;
        return { version: 2, currentId, sessions };
      }
    }
  } catch {
    /* fall through to migration */
  }
  // Migrate the old single-history format into the first session.
  const old = safeParseHistory();
  const session: ChatSession = {
    id: `chat-${Date.now().toString(36)}`,
    title: old.find((message) => message.role === 'user') ? sessionTitle(old.find((message) => message.role === 'user')!.content) : CHAT_TITLE_DEFAULT,
    messages: old,
    createdAt: old[0]?.ts ?? Date.now(),
    updatedAt: old.at(-1)?.ts ?? Date.now(),
  };
  return { version: 2, currentId: session.id, sessions: [session] };
}

function saveChatStore(store: ChatStore): void {
  try {
    window.localStorage.setItem(CHATS_KEY, JSON.stringify(store));
  } catch {
    /* ignore quota */
  }
}

interface MascotNotice {
  tone: 'warning' | 'danger' | 'info';
  title: string;
  detail: string;
}

function safeParseHistory(): MascotMessage[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is MascotMessage => item && typeof item.content === 'string' && (item.role === 'user' || item.role === 'assistant'))
      .slice(-HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function safePos(): { x: number; y: number } | null {
  try {
    const raw = window.localStorage.getItem(POS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

function assetBase(ctx: AppContext): string {
  return ctx.credentials.serverUrl.replace(/\/+$/, '');
}

/** Bundled asset pack (served from the dashboard bundle; server root may override). */
export function bundledMascot(ctx: AppContext): MascotBranding {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
  const animated = (name: MascotExpression): string => `${base}/branding/mascot/animated/mascot-${name}.webp`;
  const staticPng = (name: MascotExpression): string => `${base}/branding/mascot/mascot-${name}.png`;
  const avatar = (name: MascotExpression): string => `${base}/branding/mascot/animated/avatar-${name}.webp`;
  const expressions = {} as Record<MascotExpression, string>;
  const statics = {} as Record<MascotExpression, string>;
  const avatars = {} as Record<MascotExpression, string>;
  for (const { id } of MASCOT_EXPRESSIONS) {
    expressions[id] = animated(id);
    statics[id] = staticPng(id);
    avatars[id] = avatar(id);
  }
  return { name: 'Agil', enabled: true, url: '', expressions, staticExpressions: statics, avatarExpressions: avatars };
}

/** Applies tenant branding on top of the bundled defaults (defensive: old configs). */
export function brandingFromConfig(ctx: AppContext, config: TenantConfig | null): MascotBranding {
  const bundled = bundledMascot(ctx);
  const branding = config?.branding as
    | (Partial<TenantConfig['branding']> & { mascotExpressions?: Record<string, string> })
    | undefined;
  if (!branding) return bundled;
  const expressions: Partial<Record<MascotExpression, string>> = { ...bundled.expressions };
  const customExpressions = branding.mascotExpressions ?? {};
  for (const { id } of MASCOT_EXPRESSIONS) {
    const value = customExpressions[id];
    if (typeof value === 'string' && value.trim()) expressions[id] = value.trim();
  }
  const customUrl = (branding.mascotUrl ?? '').trim();
  if (customUrl) {
    // Custom URL is the fallback for every expression unless an expression pack overrides it.
    for (const { id } of MASCOT_EXPRESSIONS) {
      if (!(id in customExpressions)) expressions[id] = customUrl;
    }
  }
  const rawName = (branding.mascotName ?? '').trim();
  // Old default «Аги» is migrated to the product name «Agil»; custom names are kept.
  const name = !rawName || rawName === 'Аги' ? 'Agil' : rawName.slice(0, 40);
  return {
    name,
    enabled: branding.mascotEnabled !== false,
    url: customUrl,
    expressions,
    staticExpressions: bundled.staticExpressions,
    avatarExpressions: bundled.avatarExpressions,
  };
}

export interface MascotImageOptions {
  expression?: MascotExpression;
  size?: number;
  className?: string;
  avatar?: boolean;
}

/** Creates an animated mascot image with PNG fallback and an inline emoji fallback. */
export function mascotImage(branding: MascotBranding, options: MascotImageOptions = {}): HTMLElement {
  const expression = options.expression ?? 'wave';
  const source =
    (options.avatar ? branding.avatarExpressions[expression] : undefined) ??
    branding.expressions[expression] ??
    branding.expressions.wave ??
    '';
  const staticSource = branding.staticExpressions[expression] ?? branding.staticExpressions.wave ?? '';
  const wrap = h('span', {
    class: `mascot-image${options.className ? ` ${options.className}` : ''}`,
    attrs: {
      style: `--mascot-size:${options.size ?? 64}px`,
      'aria-hidden': 'true',
    },
  });
  const fallback = h('span', { class: 'mascot-fallback', text: branding.name.slice(0, 2) || 'А' });
  const img = h('img', {
    class: 'mascot-img',
    attrs: { alt: '', width: options.size ?? 64, height: options.size ?? 64, decoding: 'async', loading: 'eager' },
  });
  let usedStatic = false;
  img.addEventListener('error', () => {
    if (!usedStatic && staticSource && (img.getAttribute('src') ?? '') !== staticSource) {
      usedStatic = true;
      img.src = staticSource;
      return;
    }
    img.hidden = true;
    fallback.hidden = false;
  });
  if (source) img.src = source;
  else img.hidden = true;
  fallback.hidden = Boolean(source);
  wrap.append(img, fallback);
  return wrap;
}

function localAnswer(role: DashboardAssistantRole, question: string): string {
  const text = question.toLowerCase();
  if (text.includes('токен') || text.includes('доступ') || text.includes('role')) {
    return [
      'Коротко: доступ участнику выдаётся токеном, а не паролем комнаты.',
      '1) Откройте «Доступы» → «Выдать токен».',
      '2) Выберите комнату, имя и роль (организатор, модератор или гость) либо свою роль по её коду (roleId).',
      '3) Срок действия и права можно сузить. Токен — это доступ к комнате, не публикуйте его.',
      'Встроенные роли (host, moderator, guest) удалить нельзя. Их права по умолчанию меняются в матрице доступов (roleDefaults).',
    ].join('\n');
  }
  if (text.includes('комнат') || text.includes('созда')) {
    return [
      'Создание комнаты: «Комнаты» → «Создать комнату» (или кнопка на «Обзоре»).',
      'После создания сервер покажет ссылку для входа, ссылку для встраивания и токен. Ссылку можно скопировать из таблицы.',
      'Приглашение, блокировка и отключение участника — в строке комнаты и на странице комнаты. Удаление необратимо.',
      'Если это тестовая комната — удалите её после проверки, чтобы не засорять список комнат организации.',
    ].join('\n');
  }
  if (text.includes('безопас') || text.includes('парол') || text.includes('geo') || text.includes('запись')) {
    return [
      'Безопасность: «Безопасность» → пароли, зал ожидания, гео-политика, проверка подлинности медиа, привязка сессии.',
      'Перед сохранением критического изменения панель попросит подтвердить его и покажет риск.',
      'Для записей особенно важны функция записи и зал ожидания; проверьте матрицу доступов.',
    ].join('\n');
  }
  if (text.includes('масштаб') || text.includes('sfu') || text.includes('turn') || text.includes('нод')) {
    return [
      'Масштабирование: «Интеграции» → «Масштабирование»: режим связи (mediaMode), лимиты, TURN-пул, несколько серверов.',
      'Прямое соединение (mesh) подходит для небольших комнат, SFU — для больших вебинаров и комнат. TURN-пул нужен для сложных сетей.',
      'Перед сменой режима связи проверьте лимиты и текущую нагрузку; панель предупредит о рисках.',
    ].join('\n');
  }
  if (text.includes('вебхук') || text.includes('webhook')) {
    return [
      'Вебхуки (уведомления на ваш сервер): «Интеграции» → «Вебхуки». Добавьте адрес сервиса (endpoint), выберите события и сохраните.',
      'Кнопка «Тест» проверяет доставку; при ошибке панель покажет её, но не раскроет секреты.',
      'Не отправляйте токены и ключи в теле вебхука.',
    ].join('\n');
  }
  if (text.includes('ошибк') || text.includes('429') || text.includes('401')) {
    return [
      '429 — сервер ограничил частоту запросов: панель переходит на редкие повторные запросы, подождите и повторите.',
      '401 — API-ключ или сессия недействительны: проверьте «Настройки → Подключение» и ключ организации.',
      'Не публикуйте ключ в чатах и на скриншотах; демо-ключ «dev-key» работает только на localhost.',
    ].join('\n');
  }
  const byRole: Record<DashboardAssistantRole, string> = {
    assistant: 'Я помощник панели и подскажу по экранам. Внешний ИИ сейчас недоступен, поэтому отвечаю встроенными подсказками.',
    'config-guardian': 'Проверка рисков идёт на месте: рискованные изменения потребуют подтверждения. Подключите серверную проверку, чтобы видеть замечания подробно.',
    'security-reviewer': 'Проверьте пароли, гео-фильтрацию, зал ожидания, запись и матрицу доступов. Я подскажу по каждому пункту.',
    onboarding: 'Начните с «Обзор»: создайте комнату, пригласите участника и выдайте токен с нужной ролью.',
    'api-helper': 'API использует ключ в заголовке x-api-key и адреса /v1/admin/*. Спецификация — /openapi.json, руководство — docs/api-guide.md.',
    'scaling-advisor': 'Для роста начните с показателей, затем TURN-пул, SFU и несколько серверов; см. docs/scaling.md.',
    'roles-admin': 'Роль — это набор функций. Базовая роль (baseRole) — техническая. Свои роли выдаются токеном с кодом роли (roleId).',
  };
  return byRole[role];
}

function localSuggestions(role: DashboardAssistantRole): string[] {
  return ROLE_STARTERS[role].slice(1).concat('Открыть руководство интегратора');
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
  return `#${[r, g, b].map((value) => clamp(value).toString(16).padStart(2, '0')).join('')}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace('#', '');
  const full = normalized.length === 3 ? normalized.split('').map((part) => part + part).join('') : normalized;
  return {
    r: Number.parseInt(full.slice(0, 2), 16) || 0,
    g: Number.parseInt(full.slice(2, 4), 16) || 0,
    b: Number.parseInt(full.slice(4, 6), 16) || 0,
  };
}

function mixColor(a: string, b: string, amount: number): string {
  const first = hexToRgb(a);
  const second = hexToRgb(b);
  return rgbToHex(first.r + (second.r - first.r) * amount, first.g + (second.g - first.g) * amount, first.b + (second.b - first.b) * amount);
}

function colorLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channels = [r, g, b].map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function saturation(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const delta = max - min;
  if (delta === 0) return 0;
  const lightness = (max + min) / 2;
  return lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
}

function readableText(background: string, preferred?: string): string {
  const candidates = [preferred, '#0f172a', '#f8fafc', '#000000', '#ffffff'].filter((value): value is string => Boolean(value));
  let best = candidates[0] ?? '#0f172a';
  let bestRatio = 0;
  for (const candidate of candidates) {
    try {
      const ratio = contrastRatio(candidate, background);
      if (ratio > bestRatio) {
        best = candidate;
        bestRatio = ratio;
      }
    } catch {
      /* ignore invalid candidate */
    }
  }
  return best;
}

function ensureReadableText(background: string, preferred: string, minimum = 4.5): string {
  let candidate = readableText(background, preferred);
  for (let step = 0; step < 8; step += 1) {
    try {
      if (contrastRatio(candidate, background) >= minimum) return candidate;
    } catch {
      /* ignore */
    }
    candidate = mixColor(candidate, background, 0.08);
  }
  return readableText(background);
}

function colorDistance(a: string, b: string): number {
  const first = hexToRgb(a);
  const second = hexToRgb(b);
  return Math.abs(first.r - second.r) + Math.abs(first.g - second.g) + Math.abs(first.b - second.b);
}

/**
 * Local screenshot analysis, 64×64 canvas only. Nothing leaves the browser.
 * Returns dominant colors plus a conservative theme patch with AA contrast.
 */
export function analyzeScreenshotPixels(data: Uint8ClampedArray, width: number, height: number): ScreenshotAnalysis {
  const counts = new Map<string, number>();
  const borderCounts = new Map<string, number>();
  let totalLuminance = 0;
  let topTrivial = 0;
  let topContent = 0;
  const pixel = (x: number, y: number): { r: number; g: number; b: number } => {
    const offset = (y * width + x) * 4;
    return { r: data[offset] ?? 0, g: data[offset + 1] ?? 0, b: data[offset + 2] ?? 0 };
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const { r, g, b } = pixel(x, y);
      const hex = rgbToHex(Math.round(r / 24) * 24, Math.round(g / 24) * 24, Math.round(b / 24) * 24);
      counts.set(hex, (counts.get(hex) ?? 0) + 1);
      totalLuminance += colorLuminance(hex);
      if (x < 6 || x >= width - 6 || y < 6 || y >= height - 6) {
        borderCounts.set(hex, (borderCounts.get(hex) ?? 0) + 1);
      }
      if (y < Math.max(4, Math.floor(height * 0.22))) {
        const { r: br, g: bg, b: bb } = pixel(Math.floor(width / 2), Math.min(height - 1, 2));
        const background = rgbToHex(br, bg, bb);
        const distance = colorDistance(hex, background);
        if (distance < 45) topTrivial += 1;
        else topContent += 1;
      }
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const dominantColors = sorted.slice(0, 8).map(([hex]) => hex);
  const borderSorted = [...borderCounts.entries()].sort((a, b) => b[1] - a[1]);
  const background = borderSorted[0]?.[0] ?? dominantColors[0] ?? '#f3f6fb';
  const brightness = totalLuminance / Math.max(1, width * height);
  const scene: 'light' | 'dark' = brightness < 0.42 ? 'dark' : 'light';
  const base = structuredClone(themePresets[scene]);
  const surface = mixColor(background, scene === 'dark' ? '#ffffff' : '#000000', 0.05);
  const surfaceElevated = mixColor(background, scene === 'dark' ? '#ffffff' : '#000000', 0.09);
  const text = bestTextColor(background, ['#0f172a', '#f8fafc', '#ffffff', '#000000']);
  const textSecondary = ensureReadableText(background, mixColor(text, background, 0.22));
  const textMuted = ensureReadableText(background, mixColor(text, background, 0.35), 4.5);
  const colorCandidates = sorted
    .filter(([hex, count]) => count >= width * height * 0.004 && colorDistance(hex, background) > 60)
    .map(([hex, count]) => ({ hex, count, sat: saturation(hex) }))
    .filter((item) => item.sat > 0.22)
    .sort((a, b) => b.sat - a.sat || b.count - a.count);
  const primary = colorCandidates[0]?.hex ?? base.colors.primary;
  const accent = colorCandidates[1]?.hex ?? mixColor(primary, scene === 'dark' ? '#22d3ee' : '#0d9488', 0.55);
  const onPrimary = readableText(primary);
  const onAccent = readableText(accent);
  const border = mixColor(background, text, 0.2);
  const divider = mixColor(background, text, 0.1);
  const colors: Record<string, string> = {
    primary,
    primaryHover: mixColor(primary, onPrimary, 0.18),
    primaryActive: mixColor(primary, onPrimary, 0.3),
    onPrimary,
    accent,
    onAccent,
    background,
    backgroundAlt: mixColor(background, surface, 0.6),
    surface,
    surfaceElevated,
    tileBg: mixColor(background, scene === 'dark' ? '#000000' : '#0f172a', 0.55),
    tileBorder: border,
    text,
    textSecondary,
    textMuted,
    onSurface: text,
    border,
    divider,
    controlBg: surface,
    controlHover: surfaceElevated,
    controlActive: mixColor(surface, text, 0.12),
    controlText: text,
    chatIncomingBg: surfaceElevated,
    chatIncomingText: text,
    chatOutgoingBg: mixColor(primary, background, 0.72),
    chatOutgoingText: readableText(mixColor(primary, background, 0.72)),
    focusRing: `${primary}99`,
  };
  const theme = { ...base, scheme: scene, colors: { ...base.colors, ...colors } };
  // Best-effort AA audit; adjust the text tokens if a candidate is too close.
  for (const issue of auditTheme(theme)) {
    if (issue.code === 'text-on-background') colors.text = readableText(background, colors.text ?? readableText(background));
    if (issue.code === 'text-secondary-on-background') colors.textSecondary = ensureReadableText(background, colors.textSecondary ?? readableText(background));
    if (issue.code === 'on-primary') colors.onPrimary = readableText(primary);
    if (issue.code === 'control-text') colors.controlText = readableText(colors.controlBg ?? background, colors.controlText ?? text);
  }
  const recommended = topTrivial / Math.max(1, topTrivial + topContent) > 0.78 && scene === 'light';
  const suggestedTheme: ThemePatch = {
    scheme: scene,
    colors: {
      primary: colors.primary,
      primaryHover: colors.primaryHover,
      primaryActive: colors.primaryActive,
      onPrimary: colors.onPrimary,
      accent: colors.accent,
      onAccent: colors.onAccent,
      background: colors.background,
      backgroundAlt: colors.backgroundAlt,
      surface: colors.surface,
      surfaceElevated: colors.surfaceElevated,
      text: colors.text,
      textSecondary: colors.textSecondary,
      textMuted: colors.textMuted,
      onSurface: colors.onSurface,
      border: colors.border,
      divider: colors.divider,
      controlBg: colors.controlBg,
      controlText: colors.controlText,
      chatIncomingBg: colors.chatIncomingBg,
      chatIncomingText: colors.chatIncomingText,
      chatOutgoingBg: colors.chatOutgoingBg,
      chatOutgoingText: colors.chatOutgoingText,
    },
  };
  return {
    scene,
    brightness: Math.round(brightness * 1000) / 1000,
    dominantColors,
    variant: 0,
    colors,
    suggestedTheme,
    layoutRecommendation: recommended ? { header: 'compact', immersiveVideo: true } : null,
    summary: `Похоже на ${scene === 'dark' ? 'тёмную' : 'светлую'} тему: фон ${background}, основной ${primary}, акцент ${accent}.`,
  };
}

function alternateScreenshotAnalysis(analysis: ScreenshotAnalysis): ScreenshotAnalysis {
  const base = themePresets[analysis.scene];
  const primary = analysis.colors.accent ?? base.colors.primary;
  const accent = analysis.colors.primary ?? base.colors.accent;
  const colors = {
    ...analysis.colors,
    primary,
    accent,
    onPrimary: readableText(primary),
    onAccent: readableText(accent),
    primaryHover: mixColor(primary, readableText(primary), 0.18),
    primaryActive: mixColor(primary, readableText(primary), 0.3),
    background: mixColor(analysis.colors.background ?? base.colors.background, analysis.scene === 'dark' ? '#ffffff' : '#000000', 0.04),
    surface: mixColor(analysis.colors.surface ?? base.colors.surface, analysis.scene === 'dark' ? '#ffffff' : '#000000', 0.04),
    surfaceElevated: mixColor(analysis.colors.surfaceElevated ?? base.colors.surfaceElevated, analysis.scene === 'dark' ? '#ffffff' : '#000000', 0.07),
  };
  return {
    ...analysis,
    variant: analysis.variant + 1,
    colors,
    suggestedTheme: { ...analysis.suggestedTheme, colors: { ...analysis.suggestedTheme.colors, ...colors } },
    summary: `Другой вариант: основной ${primary}, акцент ${accent}, фон ${colors.background}.`,
  };
}

export class MascotController {
  private readonly ctx: AppContext;
  private readonly root: HTMLElement;
  private readonly mount: HTMLElement;
  private branding: MascotBranding;
  private expression: MascotExpression = 'wave';
  private panel: HTMLElement | null = null;
  private backdrop: HTMLElement | null = null;
  private readonly dock = window.matchMedia('(min-width: 1280px)');
  private returnFocus: HTMLElement | null = null;
  private open = false;
  private dragging = false;
  private moved = false;
  private dragStart = { x: 0, y: 0, left: 0, top: 0 };
  private readonly cleanups: Array<() => void> = [];
  private chatStore: ChatStore = loadChatStore();
  private history: MascotMessage[] = [];
  private historyView = false;
  private historySearch = '';
  private showSuggestions = true;
  private role: DashboardAssistantRole = 'assistant';
  private manualRole = false;
  private suggestions: string[] = ROLE_STARTERS.assistant;
  private notices: MascotNotice[] = [];
  private sending = false;
  private localMode = false;
  private localReason = '';
  private retryQuestion = '';
  private lastUserQuestion = '';
  private lastMetaIntent = false;
  private expandedMessages = new Set<string>();
  private screenshot: ScreenshotAnalysis | null = null;
  private screenshotBusy = false;
  private pendingScreenshotContext: ScreenshotContext | null = null;
  private panelHosts: {
    messages?: HTMLElement;
    suggestions?: HTMLElement;
    notices?: HTMLElement;
    typing?: HTMLElement;
    roleSelect?: HTMLSelectElement;
    starters?: HTMLElement;
    settings?: HTMLDetailsElement;
    historyList?: HTMLElement;
    input?: HTMLTextAreaElement;
    send?: HTMLButtonElement;
    localBadge?: HTMLElement;
  } = {};

  constructor(ctx: AppContext, mount: HTMLElement, private readonly triggers: readonly HTMLButtonElement[]) {
    this.ctx = ctx;
    this.mount = mount;
    this.branding = bundledMascot(ctx);
    const storedRole = window.localStorage.getItem(ROLE_KEY) as DashboardAssistantRole | null;
    if (storedRole && ASSISTANT_ROLES.some((role) => role.id === storedRole)) this.role = storedRole;
    const current = this.chatStore.sessions.find((session) => session.id === this.chatStore.currentId) ?? this.chatStore.sessions[0];
    this.history = current ? current.messages.slice() : [];
    this.showSuggestions = this.history.length === 0;
    this.root = h('div', { class: 'mascot-root' });
    mount.appendChild(this.root);
    this.renderBubble();
    this.syncTriggers();
    this.attachListeners();
    this.syncRoleForRoute();
    void this.refreshBranding();
    this.loadNotices();
  }

  private currentSession(): ChatSession {
    let session = this.chatStore.sessions.find((item) => item.id === this.chatStore.currentId);
    if (!session) {
      session = {
        id: `chat-${Date.now().toString(36)}`,
        title: CHAT_TITLE_DEFAULT,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.chatStore.sessions.unshift(session);
      this.chatStore.currentId = session.id;
    }
    return session;
  }

  private persistChat(): void {
    const session = this.currentSession();
    session.messages = this.history.slice();
    session.updatedAt = Date.now();
    session.title = session.title || CHAT_TITLE_DEFAULT;
    this.chatStore.currentId = session.id;
    saveChatStore(this.chatStore);
  }

  private syncRoleForRoute(): void {
    const next = roleForRoute(window.location.hash);
    this.setRole(next, false);
  }

  private setRole(role: DashboardAssistantRole, manual: boolean): void {
    this.role = role;
    this.manualRole = manual;
    this.suggestions = ROLE_STARTERS[role];
    try {
      window.localStorage.setItem(ROLE_KEY, role);
    } catch {
      /* ignore */
    }
    if (this.panelHosts.roleSelect) {
      this.panelHosts.roleSelect.value = role;
      this.renderStarters();
      this.renderSuggestions();
    }
    this.updateRoleHint();
  }

  private updateRoleHint(): void {
    const chip = this.panel?.querySelector('.mascot-role-chip span');
    if (chip) chip.textContent = roleLabelFor(this.role);
    const settingsRole = this.panel?.querySelector('.mascot-settings-role');
    if (settingsRole) settingsRole.textContent = roleLabelFor(this.role);
    if (this.bubble) {
      this.bubble.title = `${this.label} — ${roleLabelFor(this.role)}`;
      this.bubble.setAttribute('aria-label', `Открыть ассистента ${this.label}, роль: ${roleLabelFor(this.role)}`);
    }
  }

  private get label(): string {
    return this.branding.name;
  }

  private renderBubble(): void {
    const bubble = h('button', {
      class: 'mascot-fab',
      attrs: {
        type: 'button',
        title: `${this.label} — ассистент панели`,
        'aria-label': `Открыть ассистента ${this.label}`,
        'aria-expanded': this.open ? 'true' : 'false',
        'aria-controls': PANEL_ID,
      },
    });
    bubble.appendChild(mascotImage(this.branding, { expression: this.expression, size: 48 }));
    bubble.hidden = this.open;
    bubble.addEventListener('pointerdown', (event) => this.onPointerDown(event, bubble));
    bubble.addEventListener('click', () => {
      if (this.moved) {
        this.moved = false;
        return;
      }
      this.togglePanel();
    });
    if (this.bubble) this.bubble.replaceWith(bubble);
    else this.root.prepend(bubble);
    this.bubble = bubble;
    const pos = safePos();
    if (pos) this.applyPosition(pos.x, pos.y, bubble);
  }

  private bubble: HTMLButtonElement | null = null;

  private applyPosition(x: number, y: number, bubble = this.bubble): void {
    if (!bubble) return;
    const maxX = Math.max(8, window.innerWidth - bubble.offsetWidth - 8);
    const maxY = Math.max(8, window.innerHeight - bubble.offsetHeight - 8);
    const left = Math.min(maxX, Math.max(8, x));
    const top = Math.min(maxY, Math.max(8, y));
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
    bubble.style.right = 'auto';
    bubble.style.bottom = 'auto';
  }

  private onPointerDown(event: PointerEvent, bubble: HTMLButtonElement): void {
    if (event.button !== 0) return;
    const rect = bubble.getBoundingClientRect();
    this.dragging = true;
    this.moved = false;
    this.dragStart = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    bubble.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      if (!this.dragging) return;
      const dx = moveEvent.clientX - this.dragStart.x;
      const dy = moveEvent.clientY - this.dragStart.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) this.moved = true;
      this.applyPosition(this.dragStart.left + dx, this.dragStart.top + dy, bubble);
    };
    const up = (): void => {
      this.dragging = false;
      bubble.releasePointerCapture?.(event.pointerId);
      bubble.removeEventListener('pointermove', move);
      bubble.removeEventListener('pointerup', up);
      bubble.removeEventListener('pointercancel', up);
      if (this.moved) {
        const rectNow = bubble.getBoundingClientRect();
        try {
          window.localStorage.setItem(POS_KEY, JSON.stringify({ x: rectNow.left, y: rectNow.top }));
        } catch {
          /* ignore */
        }
      }
    };
    bubble.addEventListener('pointermove', move);
    bubble.addEventListener('pointerup', up);
    bubble.addEventListener('pointercancel', up);
    event.preventDefault();
  }

  private attachListeners(): void {
    const onResize = (): void => {
      const pos = safePos();
      if (pos && this.bubble) this.applyPosition(pos.x, pos.y);
    };
    window.addEventListener('resize', onResize);
    this.cleanups.push(() => window.removeEventListener('resize', onResize));
    const onDockChange = (): void => this.syncPanelPresentation();
    this.dock.addEventListener('change', onDockChange);
    this.cleanups.push(() => this.dock.removeEventListener('change', onDockChange));

    const onOpenAssistant = (): void => this.openPanel();
    window.addEventListener('agil-open-assistant', onOpenAssistant);
    this.cleanups.push(() => window.removeEventListener('agil-open-assistant', onOpenAssistant));

    const onWarning = (event: Event): void => {
      const detail = (event as CustomEvent<{ status?: number; code?: string }>).detail ?? {};
      if (detail.status === 429) {
        this.addNotice({
          tone: 'warning',
          title: 'Сервер ограничил частоту запросов (429)',
          detail: 'Панель переходит на мягкое обновление. Повторите действие через минуту.',
        });
      } else if (detail.status === 401) {
        this.addNotice({
          tone: 'danger',
          title: 'Ключ или сессия недействительны (401)',
          detail: 'Проверьте API-ключ организации в разделе «Настройки → Подключение».',
        });
      }
    };
    window.addEventListener('agil-api-warning', onWarning);
    this.cleanups.push(() => window.removeEventListener('agil-api-warning', onWarning));
    const onConfig = (): void => {
      void this.refreshBranding();
    };
    window.addEventListener('agil-config-updated', onConfig);
    this.cleanups.push(() => window.removeEventListener('agil-config-updated', onConfig));

    const onRouteChange = (): void => {
      this.manualRole = false;
      this.syncRoleForRoute();
    };
    window.addEventListener('hashchange', onRouteChange);
    this.cleanups.push(() => window.removeEventListener('hashchange', onRouteChange));
  }

  async refreshBranding(): Promise<void> {
    if (this.ctx.platform) {
      // The platform key is not a tenant credential: `/v1/tenants/<id>/config`
      // would answer 403 and spam the console with a handled error.
      this.branding = bundledMascot(this.ctx);
    } else {
      try {
        const config = await this.ctx.api.getConfig(this.ctx.tenantId);
        this.branding = brandingFromConfig(this.ctx, config);
      } catch {
        this.branding = bundledMascot(this.ctx);
      }
    }
    if (!this.branding.enabled) {
      this.root.hidden = true;
      this.closePanel();
      this.syncTriggers();
      return;
    }
    this.root.hidden = false;
    this.renderBubble();
    this.syncTriggers();
    if (this.open) this.renderPanel();
  }

  getBranding(): MascotBranding {
    return this.branding;
  }

  setExpression(expression: MascotExpression, resetAfterMs = 3200): void {
    this.expression = expression;
    if (this.bubble) {
      this.bubble.replaceChildren(mascotImage(this.branding, { expression, size: 48 }));
    }
    if (this.panel) {
      const headImage = this.panel.querySelector('.mascot-head .mascot-image');
      const next = mascotImage(this.branding, { expression, size: 48, avatar: true });
      if (headImage) headImage.replaceWith(next);
    }
    if (resetAfterMs > 0 && (expression === 'celebrate' || expression === 'thumbsup' || expression === 'alert' || expression === 'angry')) {
      window.setTimeout(() => {
        if (this.expression === expression) this.setExpression('wave', 0);
      }, resetAfterMs);
    }
  }

  addNotice(notice: MascotNotice): void {
    this.notices = [notice, ...this.notices.filter((item) => item.title !== notice.title)].slice(0, 6);
    if (this.open) this.renderNotices();
  }

  recordRisk(assessment: GuardAssessResponse): void {
    const severity = assessment.risk === 'critical' || assessment.risk === 'high' ? 'danger' : 'warning';
    this.addNotice({
      tone: severity,
      title: `Проверка рисков: ${assessment.summary || assessment.message || 'рискованное изменение'}`,
      detail: assessment.findings.map((finding) => finding.title).join(' · ') || 'Изменение подтверждено вручную.',
    });
    this.setExpression(assessment.risk === 'critical' || assessment.risk === 'high' ? 'angry' : 'alert');
  }

  private async loadNotices(): Promise<void> {
    if (this.ctx.platform) return;
    try {
      const audit = await this.ctx.api.audit({ limit: 5, types: 'security,webhook,guard,room' });
      for (const entry of audit.entries) {
        const type = entry.type ?? 'event';
        const risky = /failed|blocked|denied|kick|delete|lock|critical|webhook/i.test(type);
        if (!risky) continue;
        this.addNotice({
          tone: /failed|critical|denied|blocked/i.test(type) ? 'danger' : 'warning',
          title: `Аудит: ${type}`,
          detail: entry.roomId ? `Комната ${entry.roomId.slice(0, 8)}… · ${entry.message ?? 'событие'} ` : (entry.message ?? 'событие'),
        });
      }
    } catch {
      /* notices are optional; never block the panel */
    }
    if (this.open) this.renderNotices();
  }

  private togglePanel(): void {
    if (this.open) this.closePanel();
    else this.openPanel();
  }

  openPanel(): void {
    if (this.open || !this.branding.enabled) return;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.open = true;
    this.renderPanel();
    if (this.panel && !this.backdrop) {
      this.backdrop = h('button', {
        class: 'mascot-backdrop',
        attrs: { type: 'button', 'aria-label': 'Закрыть ассистента Agil' },
        on: { click: () => this.closePanel() },
      });
      this.root.insertBefore(this.backdrop, this.panel);
    }
    this.syncPanelPresentation();
    if (this.bubble) this.bubble.hidden = true;
    this.mount.classList.add('is-mascot-docked');
    this.bubble?.setAttribute('aria-expanded', 'true');
    this.syncTriggers();
    requestAnimationFrame(() => this.panelHosts.input?.focus());
    this.loadNotices();
  }

  closePanel(): void {
    if (!this.open) return;
    this.open = false;
    this.panel?.remove();
    this.panel = null;
    this.backdrop?.remove();
    this.backdrop = null;
    this.mount.classList.remove('is-mascot-docked');
    this.panelHosts = {};
    if (this.bubble) this.bubble.hidden = false;
    this.bubble?.setAttribute('aria-expanded', 'false');
    this.syncTriggers();
    const focusTarget = this.returnFocus?.isConnected && this.returnFocus.checkVisibility()
      ? this.returnFocus
      : this.triggers.find((trigger) => trigger.checkVisibility()) ?? this.bubble;
    focusTarget?.focus();
    this.returnFocus = null;
  }

  private syncTriggers(): void {
    for (const trigger of this.triggers) {
      trigger.hidden = !this.branding.enabled;
      trigger.setAttribute('aria-controls', PANEL_ID);
      trigger.setAttribute('aria-expanded', String(this.open));
    }
  }

  private syncPanelPresentation(): void {
    if (!this.panel) return;
    const modal = !this.dock.matches;
    this.panel.setAttribute('role', modal ? 'dialog' : 'complementary');
    if (modal) this.panel.setAttribute('aria-modal', 'true');
    else this.panel.removeAttribute('aria-modal');
    if (this.backdrop) this.backdrop.hidden = !modal;
  }

  private renderPanel(): void {
    if (!this.open) return;
    const links = publicLinks(this.ctx.credentials.serverUrl);
    const roleSelect = selectInput(
      ASSISTANT_ROLES.map((role) => ({ value: role.id, label: role.label })),
      {
        value: this.role,
        onChange: (value) => {
          this.setRole(value as DashboardAssistantRole, true);
        },
      },
    );
    const messages = h('div', { class: 'mascot-messages', attrs: { role: 'log', 'aria-live': 'polite' } });
    const notices = h('div', { class: 'mascot-notices' });
    const suggestions = h('div', { class: 'mascot-suggestions' });
    const starters = h('div', { class: 'mascot-starters' });
    const typing = h('div', { class: 'mascot-typing', attrs: { hidden: true } });
    const input = textareaInput({ rows: 2, placeholder: 'Спросите про панель, доступы, безопасность…', ariaLabel: 'Вопрос помощнику' });
    input.maxLength = 2000;
    const screenshotInput = h('input', {
      class: 'mascot-file-input',
      attrs: { type: 'file', accept: 'image/png,image/jpeg,image/webp' },
    });
    screenshotInput.hidden = true;
    const attach = button(undefined, {
      variant: 'subtle',
      size: 'sm',
      icon: 'image',
      title: 'Прикрепить скриншот (анализ локально, без отправки на сервер)',
      onClick: () => screenshotInput.click(),
    });
    attach.disabled = this.screenshotBusy;
    screenshotInput.addEventListener('change', () => {
      const file = screenshotInput.files?.[0];
      if (file) void this.handleScreenshotFile(file);
      screenshotInput.value = '';
    });
    const send = button(undefined, { variant: 'primary', size: 'sm', icon: 'send', title: 'Отправить', onClick: () => void this.send(input, send) });
    const localBadge = badge('встроенные подсказки', 'warning', { title: 'Внешний ИИ недоступен — отвечаю встроенными подсказками.' });
    localBadge.hidden = !this.localMode;
    const docs = h(
      'div',
      { class: 'mascot-docs' },
      h('a', { class: 'mascot-doc-link', attrs: { href: docsRoute('api-guide.md'), target: '_blank', rel: 'noopener noreferrer' } }, icon('file', 16), 'Руководство интегратора'),
      h('a', { class: 'mascot-doc-link', attrs: { href: docsRoute('api.md'), target: '_blank', rel: 'noopener noreferrer' } }, icon('file', 16), 'Справочник API'),
      h('a', { class: 'mascot-doc-link', attrs: { href: docsRoute('contract.md'), target: '_blank', rel: 'noopener noreferrer' } }, icon('security', 16), 'Контракт монорепо'),
    );
    const roleChip = h(
      'button',
      {
        class: 'mascot-role-chip',
        attrs: { type: 'button', title: 'Открыть настройки помощника и выбор роли' },
        on: {
          click: () => {
            const details = this.panel?.querySelector<HTMLDetailsElement>('.mascot-settings');
            if (details) {
              details.open = true;
              details.scrollIntoView({ block: 'nearest' });
            }
          },
        },
      },
      icon('key', 16),
      h('span', { text: roleLabelFor(this.role) }),
    );
    const settings = h(
      'details',
      { class: 'mascot-settings' },
      h(
        'summary',
        {},
        icon('settings', 16),
        h('span', { text: 'Ассистент Agil: настройки' }),
        h('span', { class: 'mascot-settings-role', text: roleLabelFor(this.role) }),
      ),
      h(
        'div',
        { class: 'mascot-settings-body' },
        field('Роль ассистента (подбирается по разделу)', roleSelect),
        h('div', { class: 'section-title', text: 'Примеры вопросов' }),
        starters,
        h('p', {
          class: 'notice',
          text: 'Помню прошлые чаты в этом браузере и нахожу в них нужную тему. Если совпадений нет, ничего не придумываю.',
        }),
        h('button', {
          class: 'mascot-notice-toggle',
          attrs: { type: 'button' },
          text: 'Что я заметил',
          on: { click: () => this.loadNotices() },
        }),
      ),
    );
    const header = h(
      'header',
      { class: 'mascot-head' },
      mascotImage(this.branding, { expression: this.expression, size: 40, avatar: true }),
      h(
        'div',
        { class: 'mascot-head-text' },
        h('div', { class: 'mascot-name-row' }, h('strong', { class: 'mascot-name', text: this.label }), localBadge),
        h('div', { class: 'mascot-head-meta' }, roleChip),
      ),
      h(
        'div',
        { class: 'mascot-head-actions' },
        button(undefined, {
          variant: 'subtle',
          size: 'sm',
          icon: 'audit',
          title: 'История чатов',
          onClick: () => {
            this.persistChat();
            this.historyView = true;
            this.renderPanel();
          },
        }),
        button(undefined, {
          variant: 'subtle',
          size: 'sm',
          icon: 'plus',
          title: 'Новый чат',
          onClick: () => this.newChat(),
        }),
        button(undefined, { variant: 'subtle', size: 'sm', icon: 'x', title: 'Закрыть помощника', onClick: () => this.closePanel() }),
      ),
    );

    const body = h('div', { class: 'mascot-body' });
    if (this.historyView) {
      const searchInput = textInput({ placeholder: 'Поиск по истории чатов…', type: 'search', ariaLabel: 'Поиск по истории' });
      searchInput.value = this.historySearch;
      searchInput.addEventListener('input', () => {
        this.historySearch = searchInput.value;
        this.renderHistoryList();
      });
      body.appendChild(
        h(
          'div',
          { class: 'mascot-history' },
          h(
            'div',
            { class: 'mascot-history-tools' },
            button(undefined, {
              variant: 'subtle',
              size: 'sm',
              icon: 'chevron-left',
              title: 'Вернуться к чату',
              onClick: () => {
                this.historyView = false;
                this.renderPanel();
              },
            }),
            searchInput,
            button('Новый чат', { variant: 'primary', size: 'sm', icon: 'plus', onClick: () => this.newChat() }),
          ),
          h('div', { class: 'mascot-history-list' }),
        ),
      );
    } else {
    const preview = this.renderScreenshotPreview();
    const composer = h(
      'div',
      { class: 'mascot-composer' },
      input,
      h('div', { class: 'mascot-composer-actions' }, attach, send, h('span', { class: 'mascot-hint', text: 'Enter — отправить · Shift+Enter — новая строка' })),
      screenshotInput,
    );
    body.append(settings, notices, h(
      'div',
      { class: 'mascot-scroll' },
      messages,
      h(
        'div',
        { class: 'mascot-jump' },
        button('К началу', { variant: 'subtle', size: 'sm', onClick: () => this.scrollMessagesToTop() }),
        button('↓ Новый ответ', { variant: 'subtle', size: 'sm', onClick: () => this.scrollToLastAnswer() }),
      ),
      typing,
      suggestions,
    ), ...(preview ? [preview] : []), composer, docs);
    }
    const panel = h(
      'section',
      { class: 'mascot-panel', attrs: { id: PANEL_ID, 'aria-label': `${this.label} — ассистент панели` } },
      header,
      body,
    );
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closePanel();
        return;
      }
      if (event.key === 'Tab' && !this.dock.matches) {
        const focusable = Array.from(
          panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary'),
        ).filter((element) => element.checkVisibility());
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
      if (event.key === 'Enter' && !event.shiftKey && event.target === input) {
        event.preventDefault();
        void this.send(input, send);
      }
    });
    this.panel?.remove();
    this.panel = panel;
    this.root.appendChild(panel);
    this.syncPanelPresentation();
    this.panelHosts = { messages, suggestions, notices, typing, roleSelect, starters, input, send, localBadge, settings, historyList: body.querySelector<HTMLElement>('.mascot-history-list') ?? undefined };
    this.renderMessages();
    this.renderNotices();
    this.renderStarters();
    this.renderSuggestions();
    this.renderTyping();
    if (this.historyView) this.renderHistoryList();
    if (this.panelHosts.historyList && this.historyView) {
      requestAnimationFrame(() => panel.querySelector<HTMLInputElement>('.mascot-history-tools input')?.focus());
    } else {
      requestAnimationFrame(() => input.focus());
    }
  }

  private newChat(): void {
    if (this.history.length > 0) this.persistChat();
    const session: ChatSession = {
      id: `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title: CHAT_TITLE_DEFAULT,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.chatStore.sessions.unshift(session);
    this.chatStore.currentId = session.id;
    this.history = [];
    this.historyView = false;
    this.showSuggestions = true;
    this.suggestions = ROLE_STARTERS[this.role];
    saveChatStore(this.chatStore);
    this.renderPanel();
  }

  private openSession(id: string): void {
    const session = this.chatStore.sessions.find((item) => item.id === id);
    if (!session) return;
    this.persistChat();
    this.chatStore.currentId = session.id;
    this.history = session.messages.slice();
    this.historyView = false;
    this.showSuggestions = false;
    saveChatStore(this.chatStore);
    this.renderPanel();
  }

  private renderHistoryList(): void {
    const host = this.panelHosts.historyList;
    if (!host) return;
    host.replaceChildren();
    const query = this.historySearch.trim().toLowerCase();
    const sessions = this.chatStore.sessions
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((session) => {
        if (!query) return true;
        return (
          session.title.toLowerCase().includes(query) ||
          session.messages.some((message) => message.content.toLowerCase().includes(query))
        );
      });
    if (sessions.length === 0) {
      host.appendChild(emptyState({ title: 'Чатов не найдено', message: 'Измените поиск или создайте новый чат.', compact: true }));
      return;
    }
    for (const session of sessions) {
      const current = session.id === this.chatStore.currentId;
      const row = h('div', { class: `mascot-chat-row${current ? ' is-current' : ''}` });
      row.appendChild(
        button(session.title, {
          variant: current ? 'subtle' : 'ghost',
          size: 'sm',
          className: 'mascot-chat-open',
          onClick: () => this.openSession(session.id),
        }),
      );
      row.appendChild(h('span', { class: 'mascot-chat-date', text: chatDateLabel(session.updatedAt) }));
      row.appendChild(
        h(
          'span',
          { class: 'mascot-chat-actions' },
          button('', { variant: 'subtle', size: 'sm', icon: 'settings', title: 'Переименовать чат', onClick: () => this.renameSession(session) }),
          button('', { variant: 'subtle', size: 'sm', icon: 'trash', title: 'Удалить чат', onClick: () => void this.deleteSession(session) }),
        ),
      );
      host.appendChild(row);
    }
  }

  private renameSession(session: ChatSession): void {
    let handle: { close: () => void } | null = null;
    const input = textInput({ value: session.title, placeholder: 'Название чата' });
    const save = button('Сохранить', {
      variant: 'primary',
      onClick: () => {
        const title = input.value.trim().slice(0, 80) || CHAT_TITLE_DEFAULT;
        session.title = title;
        saveChatStore(this.chatStore);
        handle?.close();
        this.renderHistoryList();
      },
    });
    handle = openModal({
      title: 'Переименовать чат',
      size: 'sm',
      body: field('Название', input),
      footer: [button('Отмена', { variant: 'ghost', onClick: () => handle?.close() }), save],
    });
    input.focus();
  }

  private async deleteSession(session: ChatSession): Promise<void> {
    const confirmed = await confirmDialog({
      title: 'Удалить чат?',
      message: `«${session.title}» и его сообщения будут удалены из истории этого браузера.`,
      confirmLabel: 'Удалить',
      danger: true,
    });
    if (!confirmed) return;
    this.chatStore.sessions = this.chatStore.sessions.filter((item) => item.id !== session.id);
    if (this.chatStore.currentId === session.id) {
      const next = this.chatStore.sessions[0];
      if (next) {
        this.chatStore.currentId = next.id;
        this.history = next.messages.slice();
      } else {
        this.newChat();
        return;
      }
    }
    saveChatStore(this.chatStore);
    this.renderPanel();
  }

  private buildMemory(query: string): { memory?: string; meta: boolean } {
    const meta = /обсуждали|о\s*ч[её]м\s+говорили|напомни\s+темы|прошл(ые|ых)\s+чат|что\s+мы\s+обсуждали|темы\s+(бесед|чатов)/i.test(query);
    const others = this.chatStore.sessions
      .filter((session) => session.id !== this.currentSession().id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 3);
    if (meta) {
      if (others.length === 0) return { meta };
      const parts = ['Прошлые беседы (memory, не придумывай факты, которых здесь нет):'];
      for (const session of others) {
        const lastUser = session.messages.filter((message) => message.role === 'user').at(-1);
        parts.push(`Чат «${session.title}» (${new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' }).format(new Date(session.updatedAt))}): ${(lastUser?.content ?? 'без вопросов').slice(0, 200)}`);
      }
      return { memory: parts.join('\n').slice(0, 2000), meta };
    }
    const tokens = new Set(
      query
        .toLowerCase()
        .replace(/[^a-zа-я0-9ё\s-]/gi, ' ')
        .split(/\s+/)
        .filter((word) => word.length >= 3 && !['что', 'как', 'где', 'это', 'для', 'или', 'мне', 'нас', 'вас', 'если', 'при', 'чем', 'так', 'все', 'the', 'and'].includes(word)),
    );
    if (tokens.size === 0) return { meta };
    const ranked = this.chatStore.sessions
      .filter((session) => session.id !== this.currentSession().id)
      .map((session) => {
        let score = 0;
        const relevant: MascotMessage[] = [];
        for (const message of session.messages.slice(-12)) {
          const lower = message.content.toLowerCase();
          let hits = 0;
          for (const token of tokens) if (lower.includes(token)) hits += 1;
          if (hits > 0) {
            score += hits;
            relevant.push(message);
          }
        }
        return { session, score, relevant: relevant.slice(-3) };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    if (ranked.length === 0) return { meta };
    const parts: string[] = ['Прошлые беседы (memory, не придумывай факты, которых здесь нет):'];
    for (const item of ranked) {
      parts.push(`Чат «${item.session.title}» (${new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' }).format(new Date(item.session.updatedAt))}):`);
      for (const message of item.relevant) parts.push(`${message.role === 'user' ? 'Пользователь' : 'Помощник'}: ${message.content.slice(0, 500)}`);
    }
    return { memory: parts.join('\n').slice(0, 2000), meta };
  }

  private localMetaAnswer(): string {
    const others = this.chatStore.sessions
      .filter((session) => session.id !== this.currentSession().id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5);
    if (others.length === 0) {
      return 'Других чатов в этом браузере пока нет. Начните новую беседу — её тема появится здесь.';
    }
    const topics = others
      .map((session) => {
        const lastUser = session.messages.filter((message) => message.role === 'user').at(-1);
        return `- «${session.title}»: ${(lastUser?.content ?? 'без вопроса').slice(0, 160)}`;
      })
      .join('\n');
    return `Вот темы прошлых бесед в этом браузере:\n${topics}`;
  }

  private renderScreenshotPreview(): HTMLElement | null {
    const analysis = this.screenshot;
    if (!analysis) return null;
    const swatches = h('div', { class: 'mascot-shot-swatches' });
    for (const [name, color] of [
      ['primary', analysis.colors.primary],
      ['accent', analysis.colors.accent],
      ['background', analysis.colors.background],
      ['surface', analysis.colors.surface],
      ['text', analysis.colors.text],
    ] as Array<[string, string | undefined]>) {
      if (!color) continue;
      const swatch = h('span', { class: 'mascot-shot-swatch', attrs: { title: `${name} ${color}` } });
      swatch.style.background = color;
      swatches.appendChild(h('span', { class: 'mascot-shot-swatch-wrap' }, swatch, h('span', { text: color })));
    }
    const actions = h(
      'div',
      { class: 'mascot-shot-actions' },
      button('Применить тему', { variant: 'primary', size: 'sm', icon: 'check', onClick: () => void this.applyScreenshotTheme() }),
      button('Другой вариант', { variant: 'subtle', size: 'sm', icon: 'refresh', onClick: () => {
        this.screenshot = alternateScreenshotAnalysis(analysis);
        this.renderPanel();
      } }),
      button('Отмена', { variant: 'ghost', size: 'sm', onClick: () => {
        this.screenshot = null;
        this.renderPanel();
      } }),
    );
    if (analysis.layoutRecommendation) {
      actions.appendChild(
        button('Применить compact-шапку', {
          variant: 'subtle',
          size: 'sm',
          icon: 'monitor',
          title: 'Рекомендация: на скриншоте много пустого места сверху',
          onClick: () => void this.applyScreenshotLayout(analysis.layoutRecommendation!),
        }),
      );
    }
    return h(
      'div',
      { class: 'mascot-shot-preview', attrs: { role: 'status', 'aria-live': 'polite' } },
      h(
        'div',
        { class: 'mascot-shot-head' },
        mascotImage(this.branding, { expression: 'thinking', size: 34, avatar: true }),
        h('div', { class: 'cell-stack' }, h('strong', { text: 'Анализ скриншота' }), h('span', { class: 'notice', text: `${analysis.scene === 'dark' ? 'Тёмная' : 'Светлая'} сцена · яркость ${Math.round(analysis.brightness * 100)}%` })),
        badge('локально', 'success'),
      ),
      h('p', { class: 'mascot-shot-summary', text: analysis.summary }),
      swatches,
      analysis.layoutRecommendation
        ? h('p', { class: 'mascot-shot-layout', text: 'Рекомендация: на скриншоте много пустого места сверху — можно включить compact-шапку и immersive-видео (только по подтверждению).' })
        : null,
      h('p', { class: 'mascot-shot-privacy', text: 'Скриншот не отправлялся на сервер: анализ выполнен локально в canvas 64×64. Применяются цвета/тема и рекомендации, а не полная перестройка интерфейса по картинке.' }),
      actions,
    );
  }

  private async handleScreenshotFile(file: File): Promise<void> {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      this.ctx.toast('Нужен PNG, JPEG или WebP', 'error');
      return;
    }
    if (file.size > SCREENSHOT_MAX_BYTES) {
      this.ctx.toast('Скриншот больше 5 МБ', 'error');
      return;
    }
    this.screenshotBusy = true;
    this.renderPanel();
    try {
      const image = await this.loadScreenshotImage(file);
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Canvas недоступен в этом браузере');
      context.drawImage(image, 0, 0, 64, 64);
      const pixels = context.getImageData(0, 0, 64, 64).data;
      this.screenshot = analyzeScreenshotPixels(pixels, 64, 64);
      this.screenshotBusy = false;
      this.renderPanel();
      this.pendingScreenshotContext = {
        dominantColors: this.screenshot.dominantColors,
        brightness: this.screenshot.brightness,
        scene: this.screenshot.scene,
        suggestedTheme: this.screenshot.suggestedTheme,
        layoutRecommendation: this.screenshot.layoutRecommendation,
      };
      void this.sendScreenshotExplanation();
    } catch (error) {
      this.screenshotBusy = false;
      this.ctx.toast(error instanceof Error ? error.message : 'Не удалось прочитать изображение', 'error');
      this.renderPanel();
    }
  }

  private loadScreenshotImage(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Не удалось открыть изображение'));
      };
      image.src = url;
    });
  }

  private async sendScreenshotExplanation(): Promise<void> {
    await this.sendText('Прикрепил скриншот. Что ты понял по интерфейсу и какую тему предлагаешь?');
  }

  private async applyScreenshotTheme(): Promise<void> {
    const analysis = this.screenshot;
    if (!analysis) return;
    try {
      const result = await guardedSave('config', { theme: analysis.suggestedTheme }, 'применить тему, подобранную по скриншоту', async () =>
        this.ctx.api.patchConfig(this.ctx.tenantId, { theme: analysis.suggestedTheme } as TenantConfigPatch),
      );
      if (!result.allowed) return;
      this.screenshot = null;
      this.renderPanel();
      window.dispatchEvent(new CustomEvent('agil-dashboard-config-updated'));
      this.ctx.toast('Тема из скриншота применена к организации', 'success');
    } catch (error) {
      this.ctx.toast(error instanceof Error ? error.message : 'Не удалось применить тему', 'error');
    }
  }

  private async applyScreenshotLayout(layout: { header: 'compact'; immersiveVideo: true }): Promise<void> {
    try {
      const result = await guardedSave('config', { layout }, 'применить compact-шапку и immersive-видео по скриншоту', async () =>
        this.ctx.api.patchConfig(this.ctx.tenantId, { layout } as TenantConfigPatch),
      );
      if (!result.allowed) return;
      this.ctx.toast('Layout-рекомендация применена', 'success');
    } catch (error) {
      this.ctx.toast(error instanceof Error ? error.message : 'Не удалось применить layout', 'error');
    }
  }

  private localScreenshotAnswer(): string {
    const analysis = this.screenshot;
    if (!analysis) return 'Скриншот проанализирован локально, но данные недоступны.';
    return `Локальный анализ скриншота: ${analysis.scene === 'dark' ? 'тёмная' : 'светлая'} сцена, яркость ${Math.round(analysis.brightness * 100)}%, фон ${analysis.colors.background}, основной ${analysis.colors.primary}, акцент ${analysis.colors.accent}. Я могу применить эту тему; DeepSeek недоступен, поэтому объяснение локальное.`;
  }

  private renderMessages(): void {
    const host = this.panelHosts.messages;
    if (!host) return;
    host.replaceChildren();
    if (this.history.length === 0) {
      host.appendChild(
        h(
          'div',
          { class: 'mascot-empty' },
          h('p', { text: `Привет! Я ${this.label}. Помогу с панелью, правами и безопасностью.` }),
          h('p', { class: 'notice', text: 'Ответы оформляю разметкой Markdown. Если внешний ИИ недоступен, отвечаю встроенными подсказками.' }),
        ),
      );
      return;
    }
    const messages = this.history.slice(-20);
    for (const [index, message] of messages.entries()) {
      const key = `${message.ts}-${index}`;
      const bubble = h('div', { class: 'mascot-message-bubble' });
      if (message.role === 'assistant') {
        bubble.appendChild(renderMarkdown(message.content));
      } else {
        bubble.textContent = message.content;
      }
      const long = message.role === 'assistant' && (message.content.length > 900 || message.content.split('\n').length > 12);
      if (long) {
        bubble.classList.add('is-collapsible');
        if (!this.expandedMessages.has(key)) bubble.classList.add('is-collapsed');
        const toggle = button(this.expandedMessages.has(key) ? 'Свернуть' : 'Показать полностью', {
          variant: 'subtle',
          size: 'sm',
          onClick: () => {
            if (this.expandedMessages.has(key)) this.expandedMessages.delete(key);
            else this.expandedMessages.add(key);
            this.renderMessages();
            this.scrollToLastAnswer();
          },
        });
        toggle.classList.add('mascot-collapse-toggle');
        const wrap = h('div', { class: 'mascot-answer-wrap' }, bubble, toggle);
        host.appendChild(
          h(
            'div',
            { class: `mascot-message is-${message.role}` },
            h('span', { class: 'mascot-message-role', text: message.role === 'user' ? 'Вы' : this.label }),
            wrap,
          ),
        );
      } else {
        host.appendChild(
          h(
            'div',
            { class: `mascot-message is-${message.role}` },
            h('span', { class: 'mascot-message-role', text: message.role === 'user' ? 'Вы' : this.label }),
            bubble,
          ),
        );
      }
    }
    if (this.localMode) {
      const banner = h(
        'div',
        { class: 'mascot-fallback-banner', attrs: { role: 'status', 'aria-live': 'polite' } },
        h('strong', { text: 'Внешний ИИ недоступен — отвечаю встроенными подсказками.' }),
        this.localReason ? h('span', { text: this.localReason }) : null,
        button('Повторить', {
          variant: 'ghost',
          size: 'sm',
          icon: 'refresh',
          onClick: () => {
            const question = this.retryQuestion || this.lastUserQuestion;
            if (question) void this.sendText(question);
          },
        }),
      );
      host.appendChild(banner);
    }
  }

  private scrollToLastAnswer(): void {
    const host = this.panelHosts.messages;
    if (!host) return;
    const answers = host.querySelectorAll('.mascot-message.is-assistant');
    const last = answers[answers.length - 1];
    if (!(last instanceof HTMLElement)) return;
    const hostRect = host.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    host.scrollTop = Math.max(0, host.scrollTop + lastRect.top - hostRect.top - 8);
  }

  private scrollMessagesToTop(): void {
    this.panelHosts.messages?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  private renderNotices(): void {
    const host = this.panelHosts.notices;
    if (!host) return;
    host.replaceChildren();
    const interactiveWarnings = this.notices.filter((notice) => notice.tone !== 'info').slice(0, 4);
    if (interactiveWarnings.length === 0) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    host.appendChild(h('div', { class: 'section-title', text: 'Что я заметил' }));
    for (const notice of interactiveWarnings) {
      host.appendChild(
        h(
          'div',
          { class: `mascot-notice is-${notice.tone}` },
          h('strong', { text: notice.title }),
          h('span', { text: notice.detail }),
        ),
      );
    }
  }

  private renderStarters(): void {
    const host = this.panelHosts.starters;
    if (!host) return;
    host.replaceChildren();
    const starters = ROLE_STARTERS[this.role].slice(0, 3);
    for (const starter of starters) {
      host.appendChild(
        button(starter, {
          variant: 'subtle',
          size: 'sm',
          onClick: () => {
            if (!this.panelHosts.input) return;
            this.panelHosts.input.value = starter;
            this.panelHosts.input.focus();
          },
        }),
      );
    }
  }

  private renderSuggestions(): void {
    const host = this.panelHosts.suggestions;
    if (!host || this.sending) return;
    host.hidden = !(this.showSuggestions || this.history.length === 0);
    host.replaceChildren();
    if (host.hidden) return;
    for (const suggestion of this.suggestions.slice(0, 4)) {
      host.appendChild(
        h(
          'button',
          {
            class: 'mascot-suggestion',
            attrs: { type: 'button' },
            text: suggestion,
            on: { click: () => void this.sendText(suggestion) },
          },
        ),
      );
    }
  }

  private renderTyping(): void {
    const host = this.panelHosts.typing;
    if (!host) return;
    host.hidden = !this.sending;
    if (this.sending) {
      host.replaceChildren(mascotImage(this.branding, { expression: 'thinking', size: 24 }), h('span', { text: `${this.label} думает…` }));
    }
  }

  private updateLocalBadge(): void {
    if (this.panelHosts.localBadge) this.panelHosts.localBadge.hidden = !this.localMode;
  }

  private addMessage(role: 'user' | 'assistant', content: string): void {
    const session = this.currentSession();
    if (role === 'user' && (!session.title || session.title === CHAT_TITLE_DEFAULT)) {
      session.title = sessionTitle(content);
    }
    this.history.push({ role, content, ts: Date.now() });
    this.history = this.history.slice(-200);
    session.messages = this.history.slice();
    session.updatedAt = Date.now();
    saveChatStore(this.chatStore);
    this.renderMessages();
    if (role === 'assistant') {
      requestAnimationFrame(() => this.scrollToLastAnswer());
    } else {
      requestAnimationFrame(() => {
        const host = this.panelHosts.messages;
        if (host) host.scrollTop = host.scrollHeight;
      });
      const details = this.panel?.querySelector<HTMLDetailsElement>('.mascot-settings');
      if (details) details.open = false;
    }
  }

  private async send(input: HTMLTextAreaElement, sendButton: HTMLButtonElement): Promise<void> {
    const text = input.value.trim();
    if (!text || this.sending) return;
    input.value = '';
    await this.sendText(text, sendButton);
  }

  private async sendText(text: string, sendButton?: HTMLButtonElement): Promise<void> {
    if (this.sending || !text.trim()) return;
    this.sending = true;
    this.showSuggestions = false;
    if (sendButton) sendButton.disabled = true;
    this.lastUserQuestion = text.trim();
    const { memory, meta } = this.buildMemory(text);
    this.lastMetaIntent = meta;
    const screenshotContext = this.pendingScreenshotContext;
    this.pendingScreenshotContext = null;
    this.addMessage('user', text.trim());
    this.setExpression('thinking', 0);
    this.renderTyping();
    this.renderSuggestions();
    const messages: DashboardAssistantMessage[] = this.history
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .slice(-12)
      .map((message) => ({ role: message.role, content: message.content }));
    try {
      if (meta && !memory) {
        this.addMessage('assistant', this.localMetaAnswer());
        this.localMode = false;
        this.localReason = '';
        this.showSuggestions = true;
        this.suggestions = localSuggestions(this.role);
        return;
      }
      const request = {
        messages,
        role: this.role,
        context: {
          screen: window.location.hash.replace(/^#/, '') || '/overview',
          tenantId: this.ctx.tenantId,
          chatId: this.currentSession().id,
          ...(memory ? { memory } : {}),
          ...(screenshotContext ? { screenshot: screenshotContext } : {}),
        },
      } as DashboardAssistantRequest;
      const response: DashboardAssistantResponse = await this.ctx.api.assistant(request);
      this.localMode = Boolean(response.fallback);
      if (this.localMode) {
        this.localReason = 'Сервер ответил встроенными подсказками: внешний ИИ недоступен.';
        this.retryQuestion = text.trim();
      } else {
        this.localReason = '';
        this.retryQuestion = '';
      }
      this.addMessage('assistant', response.reply || 'Готово.');
      this.suggestions = Array.isArray(response.suggestions) && response.suggestions.length > 0 ? response.suggestions : localSuggestions(this.role);
      this.showSuggestions = true;
      if (response.risk) {
        this.recordRisk(response.risk);
      } else {
        this.setExpression('thumbsup');
      }
    } catch (error) {
      const answer = screenshotContext
        ? this.localScreenshotAnswer()
        : this.lastMetaIntent
          ? this.localMetaAnswer()
          : localAnswer(this.role, text);
      this.localMode = true;
      this.localReason = error instanceof Error ? error.message : 'Сетевая ошибка запроса.';
      this.retryQuestion = text.trim();
      this.addMessage('assistant', answer);
      this.showSuggestions = true;
      this.suggestions = localSuggestions(this.role);
      if (error instanceof Error && /401|unauthorized|forbidden/.test(error.message)) {
        this.addNotice({ tone: 'danger', title: 'Ключ или сессия недействительны', detail: 'Проверьте API-ключ в настройках подключения.' });
      } else {
        this.addNotice({
          tone: 'info',
          title: 'Встроенные подсказки',
          detail: 'Внешний ИИ недоступен — отвечаю встроенными подсказками. Данные не отправлялись.',
        });
      }
    } finally {
      this.sending = false;
      if (sendButton) sendButton.disabled = false;
      this.renderTyping();
      this.updateLocalBadge();
      this.renderSuggestions();
      if (this.expression === 'thinking') this.setExpression('wave');
      window.setTimeout(() => this.setExpression('wave', 0), 2400);
    }
  }

  destroy(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
    this.closePanel();
    this.root.remove();
  }
}

let controller: MascotController | null = null;
let guardContext: AppContext | null = null;

export function initMascot(ctx: AppContext, mount: HTMLElement, triggers: readonly HTMLButtonElement[]): MascotController {
  guardContext = ctx;
  controller?.destroy();
  controller = new MascotController(ctx, mount, triggers);
  return controller;
}

export function getMascot(): MascotController | null {
  return controller;
}

/** Used by the guard dialog: it must work even before the mascot is initialized. */
export function getGuardContext(): AppContext | null {
  return guardContext;
}

export function currentMascotBranding(ctx: AppContext): MascotBranding {
  return controller ? controller.getBranding() : bundledMascot(ctx);
}

export function animateMascot(expression: MascotExpression, resetAfterMs = 3200): void {
  controller?.setExpression(expression, resetAfterMs);
}

export function notifyGuardRisk(assessment: GuardAssessResponse): void {
  controller?.recordRisk(assessment);
}

export function localAssistantAnswer(role: DashboardAssistantRole, question: string): string {
  return localAnswer(role, question);
}

export function localAssistantSuggestions(role: DashboardAssistantRole): string[] {
  return localSuggestions(role);
}
