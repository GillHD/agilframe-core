/**
 * «Agil» — the editor's mascot assistant (v2).
 *
 * Same behaviour as the dashboard mascot: floating draggable helper (animated
 * WebP pack), chat panel with per-section auto role, collapsible options, chat
 * sessions in localStorage (drawer with search/rename/delete), memory fragments
 * of other chats and a guard before saving the tenant config.
 *
 * Local mode: without the assistant/guard endpoints (or API key) everything
 * degrades to deterministic rules; the panel shows «встроенные подсказки».
 */
import { defaultConfig, type DashboardAssistantResponse, type DashboardAssistantRole, type GuardAssessResponse, type GuardFinding, type GuardRisk, type TenantConfig } from '@agil/protocol';
import { currentLocale, tr } from './i18n';
import { el, icon, readStorage, writeStorage } from './dom';
import { loadServerSettings, normalizeServerUrl, type ServerSettings } from './api';
import './mascot.css';

export type MascotExpression = 'wave' | 'thinking' | 'thumbsup' | 'alert' | 'angry' | 'celebrate';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
  local?: boolean;
}

interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

interface ChatStore {
  version: 2;
  currentId: string;
  sessions: ChatSession[];
}

export interface MascotDeps {
  getConfig(): TenantConfig;
  getSection(): { id: string; title: string };
  notify(message: string, tone?: 'info' | 'success' | 'error'): void;
}

export interface MascotHandle {
  sync(config: TenantConfig): void;
  setSection(id: string, title: string): void;
  /** Guard before saving: resolves true when save may proceed. */
  confirmSave(settings: ServerSettings, config: TenantConfig): Promise<boolean>;
  destroy(): void;
}

const ROLES: ReadonlyArray<{ id: DashboardAssistantRole; label: string }> = [
  { id: 'assistant', label: 'Помощник по панели' },
  { id: 'config-guardian', label: 'Проверка настроек' },
  { id: 'security-reviewer', label: 'Проверка безопасности' },
  { id: 'onboarding', label: 'Первые шаги' },
  { id: 'api-helper', label: 'Помощник по API' },
  { id: 'scaling-advisor', label: 'Советник по масштабированию' },
  { id: 'roles-admin', label: 'Администратор ролей' },
];

const SECTION_ROLES: Record<string, DashboardAssistantRole> = {
  brand: 'config-guardian',
  theme: 'config-guardian',
  layout: 'config-guardian',
  features: 'config-guardian',
  media: 'config-guardian',
  fallback: 'config-guardian',
  access: 'roles-admin',
  security: 'security-reviewer',
  integrations: 'api-helper',
  sso: 'security-reviewer',
  providers: 'api-helper',
  scaling: 'scaling-advisor',
  ai: 'config-guardian',
  knowledge: 'config-guardian',
  'in-call': 'config-guardian',
  assistant: 'config-guardian',
  room: 'onboarding',
  session: 'onboarding',
};

const STARTERS: Record<DashboardAssistantRole, string[]> = {
  assistant: ['С чего начать настройку?', 'Где сохранить изменения?', 'Что здесь самое рискованное?'],
  'config-guardian': ['Что изменится при выключении записи?', 'Какие настройки самые рискованные?', 'Проверь мою тему'],
  'security-reviewer': ['Проверь настройки безопасности', 'Что значит строгий режим доступов?', 'Где включить E2EE?'],
  onboarding: ['Как создать комнату?', 'Как пригласить участника?', 'Как выдать токен?'],
  'api-helper': ['Как вызвать /v1/tokens?', 'Где спецификация OpenAPI?', 'Как работает x-api-key?'],
  'scaling-advisor': ['Когда переходить на SFU?', 'Что такое TURN-пул?', 'Как включить несколько серверов?'],
  'roles-admin': ['Чем baseRole отличается от функций?', 'Как выдать свою роль?', 'Почему нельзя удалить host?'],
};

const SUGGESTIONS: Record<DashboardAssistantRole, string[]> = {
  assistant: ['С чего начать?', 'Проверить риски сохранения', 'Как выдать доступ?'],
  'config-guardian': ['Проверить контраст темы', 'Что сломает выключение записи?', 'Сравнить с пресетом'],
  'security-reviewer': ['Проверить доступы', 'Включить E2EE?', 'Что писать в аудит?'],
  onboarding: ['Создать первую комнату', 'Ссылка-приглашение', 'Тестовый токен'],
  'api-helper': ['POST /v1/tokens', 'GET /openapi.json', 'Пример кода для встраивания'],
  'scaling-advisor': ['Сколько узлов нужно?', 'Настроить TURN', 'Когда включать SFU?'],
  'roles-admin': ['Создать роль оператора', 'Проверить лимит ролей', 'Выдать токен с ролью'],
};

const LEGACY_MASCOT_NAME = 'Аги';
const DEFAULT_MASCOT_NAME = 'Agil';
const LEGACY_HISTORY_KEY = 'agil.editor.mascot.history.v1';
const CHATS_KEY = 'agil.editor.mascot.chats.v2';
const POS_KEY = 'agil.editor.mascot.pos.v1';
const ROLE_KEY = 'agil.editor.mascot.role.v1';
const CHAT_TITLE_DEFAULT = 'Новый чат';
const CHAT_TITLE_MAX = 56;
const HISTORY_LIMIT = 40;

export const EXPRESSIONS: ReadonlyArray<MascotExpression> = ['wave', 'thinking', 'thumbsup', 'alert', 'angry', 'celebrate'];

interface MascotBranding {
  enabled: boolean;
  name: string;
  customUrl: string;
  expressions: Partial<Record<MascotExpression, string>>;
}

function readBranding(config: TenantConfig): MascotBranding {
  const branding = config.branding;
  const rawName = (branding.mascotName ?? '').trim();
  return {
    enabled: branding.mascotEnabled !== false,
    // Migration: old configs used «Аги» as the default name before the Agil rename.
    name: rawName === '' || rawName === LEGACY_MASCOT_NAME ? DEFAULT_MASCOT_NAME : rawName,
    customUrl: (branding.mascotUrl ?? '').trim(),
    expressions: (branding.mascotExpressions ?? {}) as Partial<Record<MascotExpression, string>>,
  };
}

function readPos(): { x: number; y: number } | null {
  const raw = readStorage(POS_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as { x?: unknown; y?: unknown };
    return typeof candidate.x === 'number' && typeof candidate.y === 'number' ? { x: candidate.x, y: candidate.y } : null;
  } catch {
    return null;
  }
}

function sessionTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length === 0 ? CHAT_TITLE_DEFAULT : clean.slice(0, CHAT_TITLE_MAX);
}

function normalizeMessage(candidate: unknown): ChatMessage | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const item = candidate as { role?: unknown; content?: unknown; ts?: unknown; local?: unknown };
  if ((item.role !== 'user' && item.role !== 'assistant') || typeof item.content !== 'string') return null;
  return {
    role: item.role,
    content: item.content,
    ts: typeof item.ts === 'number' ? item.ts : Date.now(),
    ...(item.local === true ? { local: true } : {}),
  };
}

function loadChatStore(): ChatStore {
  const raw = readStorage(CHATS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ChatStore>;
      const sessions = Array.isArray(parsed.sessions)
        ? parsed.sessions
            .filter((session): session is ChatSession => Boolean(session && typeof session.id === 'string' && Array.isArray(session.messages)))
            .map((session) => ({
              id: session.id,
              title: typeof session.title === 'string' && session.title.trim() ? session.title.slice(0, 80) : CHAT_TITLE_DEFAULT,
              messages: session.messages.map(normalizeMessage).filter((message): message is ChatMessage => message !== null).slice(-HISTORY_LIMIT),
              createdAt: typeof session.createdAt === 'number' ? session.createdAt : Date.now(),
              updatedAt: typeof session.updatedAt === 'number' ? session.updatedAt : Date.now(),
            }))
        : [];
      if (sessions.length > 0) {
        const currentId = sessions.some((session) => session.id === parsed.currentId) ? (parsed.currentId as string) : sessions[0]!.id;
        return { version: 2, currentId, sessions };
      }
    } catch {
      /* fall through to legacy migration */
    }
  }
  // Migrate the old single-history format (v1) into the first session.
  let legacy: ChatMessage[] = [];
  const legacyRaw = readStorage(LEGACY_HISTORY_KEY);
  if (legacyRaw) {
    try {
      const parsed: unknown = JSON.parse(legacyRaw);
      if (Array.isArray(parsed)) legacy = parsed.map(normalizeMessage).filter((message): message is ChatMessage => message !== null);
    } catch {
      legacy = [];
    }
  }
  const id = `chat-${Date.now().toString(36)}`;
  const firstUser = legacy.find((message) => message.role === 'user');
  const session: ChatSession = {
    id,
    title: firstUser ? sessionTitle(firstUser.content) : CHAT_TITLE_DEFAULT,
    messages: legacy.slice(-HISTORY_LIMIT),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return { version: 2, currentId: id, sessions: [session] };
}

function saveChatStore(store: ChatStore): void {
  writeStorage(CHATS_KEY, JSON.stringify(store));
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

async function postJson<T>(settings: ServerSettings, path: string, body: unknown, timeoutMs = 12000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalizeServerUrl(settings.serverUrl)}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(settings.apiKey.trim() ? { 'x-api-key': settings.apiKey.trim() } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new HttpError(response.status);
    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timer);
  }
}

function localRisk(tone: GuardRisk, finding: Omit<GuardFinding, 'severity' | 'requiresConfirmation'> & { severity?: GuardFinding['severity']; confirm?: boolean }): GuardFinding {
  return {
    id: finding.id,
    severity: finding.severity ?? (tone === 'critical' || tone === 'high' ? 'critical' : 'warn'),
    title: finding.title,
    description: finding.description,
    impact: finding.impact,
    affected: finding.affected,
    requiresConfirmation: finding.confirm ?? false,
  };
}

/** Conservative offline guard when `/v1/admin/guard/assess` is not available. */
function localAssessConfig(config: TenantConfig): GuardAssessResponse {
  const baseline = defaultConfig({ tenantId: config.tenantId });
  const findings: GuardFinding[] = [];
  const push = (finding: GuardFinding): void => {
    findings.push(finding);
  };
  const disabled = (Object.keys(config.features) as Array<keyof TenantConfig['features']>).filter(
    (key) => baseline.features[key] === true && config.features[key] === false,
  );
  if (disabled.length > 0) {
    push(
      localRisk('high', {
        id: 'local-features-off',
        title: 'Отключены функции у всех участников',
        description: tr('Выключено: {features}.', { features: disabled.join(', ') }),
        impact: 'Участники потеряют эти возможности; на активные звонки изменение применится при следующем подключении.',
        affected: ['все роли', 'новые токены'],
        confirm: true,
      }),
    );
  }
  const access = config.security.accessPolicy;
  if (access.mode === 'strict' || access.deniedFeatures.length > 0) {
    push(
      localRisk('medium', {
        id: 'local-access-restrictive',
        title: 'Ограничены права доступа',
        description: access.deniedFeatures.length > 0
          ? tr('Режим {mode}, запрещено функций: {count}.', { mode: access.mode, count: access.deniedFeatures.length })
          : tr('Режим {mode}.', { mode: access.mode }),
        impact: 'Часть участников может получить меньше прав, чем ожидает; проверьте матрицу ролей и токены.',
        affected: ['все роли', 'выданные токены'],
      }),
    );
  }
  const externalProviders = Object.values(config.providers).filter(
    (provider) => provider && typeof provider === 'object' && (provider as { mode?: unknown }).mode === 'external',
  ).length;
  if (externalProviders > 0) {
    push(
      localRisk('medium', {
        id: 'local-providers-external',
        title: 'Внешние сервисы включены',
        description: tr('Внешних сервисов: {count}.', { count: externalProviders }),
        impact: 'Данные звонков будут уходить в сторонние системы; проверьте договоры и ключи в переменных окружения.',
        affected: ['участники', 'данные звонков'],
      }),
    );
  }
  if (config.integrations.webhooks.some((hook) => /^http:\/\//i.test(hook.url))) {
    push(
      localRisk('high', {
        id: 'local-webhook-http',
        title: 'Вебхук без HTTPS',
        description: 'Найден вебхук с http:// — данные могут быть перехвачены.',
        impact: 'События комнаты (включая потенциально чувствительные) уйдут по незашифрованному каналу.',
        affected: ['интеграции', 'аудит'],
        confirm: true,
      }),
    );
  }
  if (config.branding.mascotEnabled === false) {
    push(
      localRisk('low', {
        id: 'local-mascot-disabled',
        title: 'Помощник «Agil» выключен',
        description: 'Помощник и подсказки о рисках скрыты у всех администраторов.',
        impact: 'Администраторы теряют быстрые подсказки; проверка рисков при сохранении продолжит работать.',
        affected: ['администраторы'],
      }),
    );
  }
  const requiresConfirmation = findings.some((finding) => finding.requiresConfirmation);
  const worst = findings.some((finding) => finding.severity === 'critical')
    ? 'high'
    : findings.some((finding) => finding.severity === 'warn')
      ? 'medium'
      : 'low';
  return {
    risk: worst,
    requiresConfirmation,
    summary: requiresConfirmation ? 'Есть изменения, которые стоит подтвердить.' : 'Критических рисков не найдено.',
    message: requiresConfirmation
      ? 'Проверьте, что это действительно нужно. Сохранение изменит поведение для участников.'
      : 'Можно сохранять.',
    findings,
    recommendations: requiresConfirmation
      ? ['Проверьте, что изменение не затрагивает активные звонки.', 'Скачайте JSON конфигурации как резервную копию.', 'Покажите изменение коллеге, если сомневаетесь.']
      : ['Проверка выполнена на месте — серверная проверка рисков недоступна.'],
  };
}

function localReply(role: DashboardAssistantRole, question: string): string {
  const text = question.toLowerCase();
  if (text.includes('сохран') || text.includes('save')) {
    return 'Изменения сохраняются в организации кнопкой «Сохранить в организации» в закреплённой панели справа. Перед отправкой редактор проверяет риски: если риск высокий, появится подтверждение. Экспорт JSON и черновик работают без сервера.';
  }
  if (text.includes('токен') || text.includes('доступ') || text.includes('role')) {
    return 'Доступ участнику выдаётся токеном, а не паролем комнаты. Роль выбирается в разделе «Доступы»: встроенные организатор, модератор и гость (host, moderator, guest) или своя роль (до 30) с набором функций. Токен создаётся запросом POST /v1/tokens с roleId.';
  }
  if (text.includes('запис')) {
    return 'Запись управляется полями features.recording и session.recording. Перед выключением проверьте, что запись не требуется политикой и что вебхуки и журнал аудита не зависят от файлов записи — проверка рисков покажет последствия.';
  }
  if (text.includes('безопас') || text.includes('security') || text.includes('e2ee')) {
    return 'В разделе «Безопасность» есть сквозное шифрование (E2EE), гео-политика, проверка подлинности при входе, привязка сессии и журнал аудита. Включайте по одному изменению и проверяйте звонком; ключи и секреты сервер хранит только как имена переменных окружения.';
  }
  if (text.includes('api') || text.includes('openapi')) {
    return 'Документация API: /docs (описание методов), /openapi.json (спецификация OpenAPI 3.1), /docs/api-guide.md (руководство интегратора). Ключ передаётся в заголовке x-api-key; в редакторе он задаётся в блоке сохранения.';
  }
  if (role === 'scaling-advisor') {
    return 'Масштабирование: начните с прямого соединения (mesh) для небольших комнат, затем переходите на SFU. Для нескольких серверов нужны Redis, закрепление участника за сервером и пул TURN-серверов с именем переменной окружения для пароля (credentialEnv). Проверьте лимиты нагрузки и режим трансляции для вебинаров.';
  }
  if (role === 'roles-admin') {
    return 'Свои роли хранятся в security.accessPolicy.customRoles (до 30): id, name, baseRole, features, canModerate, color. Итоговые права: права из токена → персональные права → своя роль → строгий режим → права роли по умолчанию, затем глобальные запреты (deniedFeatures) и пересечение с включёнными функциями (features.*).';
  }
  if (role === 'onboarding') {
    return 'Начните с «Комната»: создайте комнату, скопируйте ссылку для входа или выпустите тестовый токен. Затем настройте бренд и тему — предпросмотр обновится сразу; сохраните кнопкой «Сохранить в организации».';
  }
  return 'Я — Agil, помощник редактора. Подскажу по теме, доступам, безопасности, интеграциям и сохранению конфигурации. Сейчас внешний ИИ недоступен, поэтому отвечаю встроенными подсказками. Откройте нужный раздел слева — роль подстроится автоматически.';
}

function localSuggestions(role: DashboardAssistantRole): string[] {
  return SUGGESTIONS[role] ?? SUGGESTIONS.assistant;
}

function sectionRole(id: string): DashboardAssistantRole {
  return SECTION_ROLES[id] ?? 'assistant';
}

function roleLabel(role: DashboardAssistantRole): string {
  return ROLES.find((entry) => entry.id === role)?.label ?? role;
}

export function createMascot(deps: MascotDeps): MascotHandle {
  const state = {
    config: deps.getConfig(),
    sectionId: deps.getSection().id,
    sectionTitle: deps.getSection().title,
    role: sectionRole(deps.getSection().id),
    manualRole: false,
    open: false,
    historyView: false,
    historySearch: '',
    localMode: false,
    busy: false,
    chatStore: loadChatStore(),
    branding: readBranding(deps.getConfig()),
    pos: readPos(),
  };
  const storedRole = readStorage(ROLE_KEY) as DashboardAssistantRole | null;
  if (storedRole && ROLES.some((entry) => entry.id === storedRole)) {
    state.role = storedRole;
    state.manualRole = true;
  }

  const currentSession = (): ChatSession => {
    let session = state.chatStore.sessions.find((item) => item.id === state.chatStore.currentId);
    if (!session) {
      session = {
        id: `chat-${Date.now().toString(36)}`,
        title: CHAT_TITLE_DEFAULT,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      state.chatStore.sessions.unshift(session);
      state.chatStore.currentId = session.id;
    }
    return session;
  };
  const messages = (): ChatMessage[] => currentSession().messages;

  const persistChat = (): void => {
    const session = currentSession();
    session.messages = session.messages.slice(-HISTORY_LIMIT);
    session.updatedAt = Date.now();
    state.chatStore.currentId = session.id;
    saveChatStore(state.chatStore);
  };

  const root = el('div', 'mascot-root');
  root.dataset.testid = 'mascot-root';
  root.dataset.role = state.role;
  root.dataset.section = state.sectionId;

  const fab = el('button', 'mascot-fab');
  fab.type = 'button';
  fab.dataset.testid = 'mascot-fab';
  fab.setAttribute('aria-label', `${state.branding.name} — ассистент редактора`);
  fab.setAttribute('aria-expanded', 'false');
  const fabImage = el('span', 'mascot-fab-image');
  const fabDot = el('span', 'mascot-fab-dot');
  fab.append(fabImage, fabDot);

  const panel = el('section', 'mascot-panel');
  panel.dataset.testid = 'mascot-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Ассистент редактора');

  /* Header: compact; history/new chat/close as the same gestures as dashboard. */
  const header = el('header', 'mascot-header');
  const headerImage = el('span', 'mascot-header-image');
  const headerText = el('div', 'mascot-header-text');
  const nameEl = el('strong', 'mascot-name', state.branding.name);
  const subtitleEl = el('span', 'mascot-subtitle');
  headerText.append(nameEl, subtitleEl);
  const headerActions = el('div', 'mascot-head-actions');
  const historyButton = el('button', 'mascot-icon-btn', 'История');
  historyButton.type = 'button';
  historyButton.dataset.testid = 'mascot-history-toggle';
  historyButton.title = 'История чатов';
  const newChatButton = el('button', 'mascot-icon-btn', 'Новый чат');
  newChatButton.type = 'button';
  newChatButton.dataset.testid = 'mascot-new-chat';
  newChatButton.title = 'Новый чат';
  const closeButton = el('button', 'mascot-close', '×');
  closeButton.type = 'button';
  closeButton.dataset.testid = 'mascot-close';
  closeButton.setAttribute('aria-label', 'Свернуть помощника');
  headerActions.append(historyButton, newChatButton, closeButton);
  const localBadge = el('span', 'mascot-local-badge', 'встроенные подсказки');
  localBadge.dataset.testid = 'mascot-local';
  localBadge.hidden = true;
  header.append(headerImage, headerText, localBadge, headerActions);

  const body = el('div', 'mascot-body');

  /** Collapsible settings/examples: never eats half the panel after first message. */
  const options = document.createElement('details');
  options.className = 'mascot-options';
  options.dataset.testid = 'mascot-options';
  const optionsSummary = el('summary', 'mascot-options-summary');
  const optionsSummaryText = el('span', 'mascot-options-title', 'Настройки помощника и примеры');
  const optionsRoleHint = el('span', 'mascot-options-role');
  optionsSummary.append(optionsSummaryText, optionsRoleHint);
  const optionsBody = el('div', 'mascot-options-body');
  const roleRow = el('label', 'mascot-role-row');
  roleRow.append(el('span', 'mascot-role-label', 'Роль'));
  const roleSelect = el('select', 'mascot-role-select');
  roleSelect.dataset.testid = 'mascot-role';
  for (const role of ROLES) {
    const option = el('option', '', role.label);
    option.value = role.id;
    roleSelect.append(option);
  }
  roleSelect.value = state.role;
  roleRow.append(roleSelect);
  const startersHost = el('div', 'mascot-chips mascot-starters');
  optionsBody.append(roleRow, startersHost);
  options.append(optionsSummary, optionsBody);

  /** History drawer (sessions list). */
  const historyDrawer = el('div', 'mascot-history');
  historyDrawer.dataset.testid = 'mascot-history';
  historyDrawer.hidden = true;
  const historyTools = el('div', 'mascot-history-tools');
  const historySearchInput = el('input', 'mascot-history-search') as HTMLInputElement;
  historySearchInput.type = 'search';
  historySearchInput.placeholder = 'Поиск по чатам…';
  historySearchInput.setAttribute('aria-label', 'Поиск по истории чатов');
  historySearchInput.dataset.testid = 'mascot-history-search';
  const historyNewButton = el('button', 'mascot-btn mascot-btn-primary', 'Новый чат');
  historyNewButton.type = 'button';
  historyNewButton.dataset.testid = 'mascot-history-new';
  historyTools.append(historySearchInput, historyNewButton);
  const historyList = el('div', 'mascot-history-list');
  historyList.dataset.testid = 'mascot-history-list';
  historyDrawer.append(historyTools, historyList);

  const messagesHost = el('div', 'mascot-messages');
  messagesHost.dataset.testid = 'mascot-messages';
  messagesHost.setAttribute('role', 'log');
  messagesHost.setAttribute('aria-live', 'polite');

  const suggestionsHost = el('div', 'mascot-chips mascot-suggestions');
  suggestionsHost.dataset.testid = 'mascot-suggestions';

  body.append(options, historyDrawer, messagesHost, suggestionsHost);

  const composer = el('form', 'mascot-composer');
  const input = el('textarea', 'mascot-input') as HTMLTextAreaElement;
  input.rows = 2;
  input.maxLength = 2000;
  input.placeholder = 'Спросите про настройку, доступы, риски…';
  input.setAttribute('aria-label', 'Вопрос помощнику');
  input.dataset.testid = 'mascot-input';
  const sendButton = el('button', 'mascot-send', 'Спросить');
  sendButton.type = 'submit';
  sendButton.dataset.testid = 'mascot-send';
  composer.append(input, sendButton);

  const footer = el('footer', 'mascot-footer');
  const docsBase = (): string => {
    const settings = loadServerSettings(state.config.tenantId);
    return normalizeServerUrl(settings.serverUrl);
  };
  const docsLink = el('a', 'mascot-link', 'Документация API');
  docsLink.target = '_blank';
  docsLink.rel = 'noopener noreferrer';
  const guideLink = el('a', 'mascot-link', 'Руководство интегратора');
  guideLink.target = '_blank';
  guideLink.rel = 'noopener noreferrer';
  const mdLink = el('a', 'mascot-link', 'Справочник API');
  mdLink.target = '_blank';
  mdLink.rel = 'noopener noreferrer';
  footer.append(docsLink, guideLink, mdLink);

  panel.append(header, body, composer, footer);

  /* ---------------- Guard dialog ---------------- */
  const guardOverlay = el('div', 'mascot-guard-overlay');
  guardOverlay.dataset.testid = 'mascot-guard';
  guardOverlay.hidden = true;
  guardOverlay.setAttribute('role', 'dialog');
  guardOverlay.setAttribute('aria-modal', 'true');
  guardOverlay.setAttribute('aria-label', tr('Подтверждение критического изменения'));
  const guardCard = el('div', 'mascot-guard-card');
  const guardHead = el('div', 'mascot-guard-head');
  const guardImage = el('span', 'mascot-guard-image');
  const guardHeadText = el('div', 'mascot-guard-head-text');
  const guardTitle = el('h2', 'mascot-guard-title', tr('Проверка рисков'));
  const guardChips = el('div', 'mascot-chips');
  const guardMessage = el('p', 'mascot-guard-message');
  guardHeadText.append(guardTitle, guardChips, guardMessage);
  guardHead.append(guardImage, guardHeadText);
  const guardFindings = el('div', 'mascot-guard-findings');
  const guardRecommendations = el('div', 'mascot-guard-recommendations');
  const guardAck = el('label', 'mascot-guard-ack');
  const ackInput = document.createElement('input');
  ackInput.type = 'checkbox';
  ackInput.dataset.testid = 'mascot-guard-ack';
  guardAck.append(ackInput, el('span', '', tr('Я понимаю последствия')));
  const guardActions = el('div', 'mascot-guard-actions');
  const cancelButton = el('button', 'mascot-btn mascot-btn-ghost', tr('Отмена'));
  cancelButton.type = 'button';
  cancelButton.dataset.testid = 'mascot-guard-cancel';
  const confirmButton = el('button', 'mascot-btn mascot-btn-danger', tr('Всё равно сохранить'));
  confirmButton.type = 'button';
  confirmButton.disabled = true;
  confirmButton.dataset.testid = 'mascot-guard-confirm';
  guardActions.append(cancelButton, confirmButton);
  guardCard.append(guardHead, guardFindings, guardRecommendations, guardAck, guardActions);
  guardOverlay.append(guardCard);

  root.append(fab, panel, guardOverlay);
  document.body.append(root);

  /* ------------------------------------------------------------------ */
  /* Mascot images                                                      */
  /* ------------------------------------------------------------------ */

  function sourceList(expression: MascotExpression): string[] {
    const branding = state.branding;
    const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
    const origin = window.location.origin;
    const custom = branding.expressions[expression] ?? branding.customUrl;
    if (custom && custom.trim()) return [custom.trim()];
    return [
      `${origin}/branding/mascot/animated/mascot-${expression}.webp`,
      `${base}/branding/mascot/animated/mascot-${expression}.webp`,
      `${origin}/branding/mascot/mascot-${expression}.png`,
      `${base}/branding/mascot/mascot-${expression}.png`,
    ];
  }

  function paintImage(host: HTMLElement, expression: MascotExpression, size: number, avatar = false): void {
    host.replaceChildren();
    const sources = sourceList(expression);
    const fallback = el('span', 'mascot-initials', state.branding.name.slice(0, 2) || 'Ag');
    fallback.hidden = true;
    const img = el('img', 'mascot-img');
    img.alt = '';
    img.width = size;
    img.height = size;
    img.decoding = 'async';
    let index = 0;
    const next = (): void => {
      if (index >= sources.length) {
        img.hidden = true;
        fallback.hidden = false;
        return;
      }
      img.src = sources[index] ?? '';
      index += 1;
    };
    img.addEventListener('error', next);
    host.append(img, fallback);
    if (avatar) host.classList.add('is-avatar');
    next();
  }

  function expressionFor(expression: MascotExpression): void {
    paintImage(fabImage, expression, 58);
    paintImage(headerImage, expression, 34, true);
  }

  function setExpression(expression: MascotExpression): void {
    root.dataset.expression = expression;
    expressionFor(expression);
  }

  /* ------------------------------------------------------------------ */
  /* Chat sessions                                                      */
  /* ------------------------------------------------------------------ */

  function renderMessages(): void {
    messagesHost.replaceChildren();
    for (const message of messages()) {
      const bubble = el('div', `mascot-message is-${message.role}`);
      bubble.dataset.testid = `mascot-message-${message.role}`;
      bubble.append(el('span', 'mascot-message-text', message.content));
      if (message.local) bubble.append(el('span', 'mascot-message-tag', 'встроенный ответ'));
      messagesHost.append(bubble);
    }
    messagesHost.scrollTop = messagesHost.scrollHeight;
  }

  function renderStarters(): void {
    startersHost.replaceChildren();
    for (const starter of STARTERS[state.role] ?? STARTERS.assistant) {
      const chip = el('button', 'mascot-chip', starter);
      chip.type = 'button';
      chip.addEventListener('click', () => void ask(starter));
      startersHost.append(chip);
    }
  }

  function renderSuggestions(): void {
    suggestionsHost.replaceChildren();
    const show = messages().length === 0 && !state.historyView;
    suggestionsHost.hidden = !show;
    if (!show) return;
    for (const suggestion of localSuggestions(state.role)) {
      const chip = el('button', 'mascot-chip', suggestion);
      chip.type = 'button';
      chip.addEventListener('click', () => void ask(suggestion));
      suggestionsHost.append(chip);
    }
  }

  function formatDate(ts: number): string {
    try {
      const date = new Date(ts);
      const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(date);
      const today = new Date();
      const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
      const sameDay = (left: Date, right: Date): boolean =>
        left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
      if (sameDay(date, today)) return `Сегодня, ${time}`;
      if (sameDay(date, yesterday)) return `Вчера, ${time}`;
      return `${new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' }).format(date)}, ${time}`;
    } catch {
      return '';
    }
  }

  function renderHistoryList(): void {
    historyList.replaceChildren();
    const query = state.historySearch.trim().toLowerCase();
    const sessions = state.chatStore.sessions
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((session) => {
        if (!query) return true;
        return session.title.toLowerCase().includes(query) || session.messages.some((message) => message.content.toLowerCase().includes(query));
      });
    if (sessions.length === 0) {
      historyList.append(el('p', 'mascot-history-empty', 'Чатов не найдено.'));
      return;
    }
    for (const session of sessions) {
      const row = el('div', `mascot-chat-row${session.id === state.chatStore.currentId ? ' is-current' : ''}`);
      row.dataset.testid = 'mascot-chat-row';
      const openButton = el('button', 'mascot-chat-open', session.title);
      openButton.type = 'button';
      openButton.dataset.testid = 'mascot-chat-open';
      openButton.title = session.title;
      openButton.addEventListener('click', () => openSession(session.id));
      const date = el('span', 'mascot-chat-date', formatDate(session.updatedAt));
      const actions = el('span', 'mascot-chat-actions');
      const rename = el('button', 'mascot-chat-action');
      rename.type = 'button';
      rename.title = 'Переименовать чат';
      rename.setAttribute('aria-label', 'Переименовать чат');
      rename.append(icon('edit'));
      rename.dataset.testid = 'mascot-chat-rename';
      rename.addEventListener('click', () => renameSession(session));
      const remove = el('button', 'mascot-chat-action');
      remove.type = 'button';
      remove.title = 'Удалить чат';
      remove.setAttribute('aria-label', 'Удалить чат');
      remove.append(icon('trash'));
      remove.dataset.testid = 'mascot-chat-delete';
      remove.addEventListener('click', () => deleteSession(session));
      actions.append(rename, remove);
      row.append(openButton, date, actions);
      historyList.append(row);
    }
  }

  function renderHistory(): void {
    historyDrawer.hidden = !state.historyView;
    if (state.historyView) {
      historySearchInput.value = state.historySearch;
      renderHistoryList();
    }
  }

  function renderPanel(): void {
    nameEl.textContent = state.branding.name;
    fab.setAttribute('aria-label', `${state.branding.name} — ассистент редактора`);
    subtitleEl.textContent = `${roleLabel(state.role)} · раздел «${state.sectionTitle}»`;
    optionsRoleHint.textContent = roleLabel(state.role);
    roleSelect.value = state.role;
    root.dataset.role = state.role;
    root.dataset.section = state.sectionId;
    localBadge.hidden = !state.localMode;
    // Options/examples collapse after the first message; suggestions only in an empty chat.
    options.open = messages().length === 0 && !state.historyView;
    messagesHost.hidden = state.historyView;
    renderMessages();
    renderStarters();
    renderSuggestions();
    renderHistory();
    renderFooter();
  }

  function renderFooter(): void {
    const base = docsBase();
    docsLink.href = `${base}/docs`;
    guideLink.href = `${base}/docs/api-guide.md`;
    mdLink.href = `${base}/docs/api.md`;
    docsLink.title = `Документация API: ${base}/docs`;
    guideLink.title = `Руководство интегратора: ${base}/docs/api-guide.md`;
    mdLink.title = `Справочник API: ${base}/docs/api.md`;
  }

  function currentTitle(): string {
    return currentSession().title;
  }

  function openPanel(): void {
    state.open = true;
    panel.hidden = false;
    // FAB disappears while the panel is open (same gesture as the dashboard bubble).
    fab.classList.add('is-panel-open');
    fab.setAttribute('aria-expanded', 'true');
    renderPanel();
    window.setTimeout(() => input.focus(), 50);
  }

  function closePanel(): void {
    state.open = false;
    state.historyView = false;
    panel.hidden = true;
    fab.classList.remove('is-panel-open');
    fab.setAttribute('aria-expanded', 'false');
    setExpression('wave');
  }

  function togglePanel(): void {
    if (state.open) closePanel();
    else openPanel();
  }

  function newChat(): void {
    persistChat();
    const session: ChatSession = {
      id: `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title: CHAT_TITLE_DEFAULT,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    state.chatStore.sessions.unshift(session);
    state.chatStore.currentId = session.id;
    state.historyView = false;
    state.localMode = false;
    saveChatStore(state.chatStore);
    renderPanel();
    input.focus();
  }

  function openSession(id: string): void {
    const session = state.chatStore.sessions.find((item) => item.id === id);
    if (!session) return;
    persistChat();
    state.chatStore.currentId = session.id;
    state.historyView = false;
    saveChatStore(state.chatStore);
    renderPanel();
  }

  function renameSession(session: ChatSession): void {
    const next = window.prompt('Название чата', session.title);
    if (next === null) return;
    const title = next.trim().slice(0, 80);
    if (!title) return;
    session.title = title;
    session.updatedAt = Date.now();
    saveChatStore(state.chatStore);
    renderHistoryList();
  }

  function deleteSession(session: ChatSession): void {
    if (!window.confirm(`Удалить чат «${session.title}»?`)) return;
    state.chatStore.sessions = state.chatStore.sessions.filter((item) => item.id !== session.id);
    if (state.chatStore.sessions.length === 0) {
      const fresh: ChatSession = {
        id: `chat-${Date.now().toString(36)}`,
        title: CHAT_TITLE_DEFAULT,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      state.chatStore.sessions.push(fresh);
      state.chatStore.currentId = fresh.id;
    } else if (state.chatStore.currentId === session.id) {
      state.chatStore.currentId = state.chatStore.sessions[0]!.id;
    }
    saveChatStore(state.chatStore);
    renderPanel();
  }

  /* ------------------------------------------------------------------ */
  /* Chat                                                               */
  /* ------------------------------------------------------------------ */

  function addMessage(role: 'user' | 'assistant', content: string, local = false): void {
    const session = currentSession();
    session.messages.push({ role, content, ts: Date.now(), ...(local ? { local: true } : {}) });
    session.messages = session.messages.slice(-HISTORY_LIMIT);
    session.updatedAt = Date.now();
    if (role === 'user' && session.title === CHAT_TITLE_DEFAULT) {
      session.title = sessionTitle(content);
    }
    saveChatStore(state.chatStore);
    renderPanel();
  }

  /** Relevant fragments from *other* chats, ≤ 2000 chars (backend memory contract). */
  function buildMemory(query: string): string | undefined {
    const tokens = new Set(
      query
        .toLowerCase()
        .replace(/[^a-zа-я0-9ё\s-]/gi, ' ')
        .split(/\s+/)
        .filter((word) => word.length >= 3 && !['что', 'как', 'где', 'это', 'для', 'или', 'мне', 'нас', 'вас', 'если', 'при', 'чем', 'так', 'все', 'the', 'and'].includes(word)),
    );
    if (tokens.size === 0) return undefined;
    // Light stemming: Russian questions use inflected forms ("записью" vs "запись"),
    // so match by a 4+ character stem instead of the whole word.
    const stems = [...tokens].map((token) => (token.length >= 5 ? token.slice(0, Math.max(4, token.length - 2)) : token));
    const currentId = currentSession().id;
    const ranked = state.chatStore.sessions
      .filter((session) => session.id !== currentId)
      .map((session) => {
        let score = 0;
        const relevant: ChatMessage[] = [];
        for (const message of session.messages.slice(-12)) {
          const lower = message.content.toLowerCase();
          let hits = 0;
          for (const stem of stems) if (lower.includes(stem)) hits += 1;
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
    if (ranked.length === 0) return undefined;
    const parts: string[] = ['Прошлые беседы (memory, не придумывай факты, которых здесь нет):'];
    for (const item of ranked) {
      parts.push(`Чат «${item.session.title}» (${formatDate(item.session.updatedAt)}):`);
      for (const message of item.relevant) parts.push(`${message.role === 'user' ? 'Пользователь' : 'Помощник'}: ${message.content.slice(0, 500)}`);
    }
    return parts.join('\n').slice(0, 2000);
  }

  async function ask(question: string): Promise<void> {
    const text = question.trim();
    if (!text || state.busy) return;
    input.value = '';
    state.busy = true;
    sendButton.disabled = true;
    setExpression('thinking');
    const memory = buildMemory(text);
    addMessage('user', text);
    const settings = loadServerSettings(state.config.tenantId);
    const history = messages().slice(-20).map((message) => ({ role: message.role, content: message.content }));
    const context = {
      screen: state.sectionId,
      tenantId: state.config.tenantId,
      currentConfig: state.config,
      chatId: currentSession().id,
      ...(memory ? { memory } : {}),
    };
    try {
      if (!settings.apiKey.trim()) throw new HttpError(401);
      const response = await postJson<DashboardAssistantResponse>(settings, '/v1/admin/assistant', {
        messages: history,
        role: state.role,
        context,
      });
      if (!response || typeof response.reply !== 'string' || response.reply.trim().length === 0) throw new HttpError(502);
      state.localMode = Boolean(response.fallback);
      addMessage('assistant', response.reply, Boolean(response.fallback));
      setExpression(response.fallback ? 'wave' : 'thumbsup');
    } catch {
      state.localMode = true;
      addMessage('assistant', localReply(state.role, text), true);
      setExpression('wave');
    } finally {
      state.busy = false;
      sendButton.disabled = false;
      renderPanel();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Guard                                                              */
  /* ------------------------------------------------------------------ */

  async function assessConfig(settings: ServerSettings, config: TenantConfig): Promise<{ assessment: GuardAssessResponse; local: boolean }> {
    try {
      if (!settings.apiKey.trim()) throw new HttpError(401);
      const assessment = await postJson<GuardAssessResponse>(settings, '/v1/admin/guard/assess', {
        kind: 'config',
        locale: currentLocale(),
        editorDraft: true,
        next: config,
        intent: tr('Сохранение конфигурации из редактора (раздел «{section}»)', { section: state.sectionTitle }),
      });
      if (!assessment || typeof assessment.requiresConfirmation !== 'boolean' || typeof assessment.risk !== 'string') {
        throw new HttpError(502);
      }
      return { assessment, local: false };
    } catch {
      return { assessment: localAssessConfig(config), local: true };
    }
  }

  function openGuard(assessment: GuardAssessResponse, local: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const localize = local ? tr : (text: string) => text;
      const expression: MascotExpression = assessment.risk === 'critical' || assessment.risk === 'high' ? 'angry' : 'alert';
      setExpression(expression);
      paintImage(guardImage, expression, 72);
      guardTitle.textContent = localize(assessment.summary);
      guardMessage.textContent = localize(assessment.message);
      guardChips.replaceChildren();
      guardChips.append(
        el('span', `mascot-badge is-${assessment.risk}`, tr('риск: {level}', {
          level: tr(({ low: 'низкий', medium: 'средний', high: 'высокий', critical: 'критический' })[assessment.risk]),
        })),
        el('span', 'mascot-badge', tr(local ? 'проверка без сервера' : 'проверка на сервере')),
      );
      guardFindings.replaceChildren();
      for (const finding of assessment.findings) {
        const block = el('div', `mascot-finding is-${finding.severity}`);
        block.append(el('strong', 'mascot-finding-title', localize(finding.title)));
        block.append(el('p', 'mascot-finding-desc', localize(finding.description)));
        block.append(el('p', 'mascot-finding-impact', tr('Влияние: {detail}', { detail: localize(finding.impact) })));
        if (finding.affected.length > 0) {
          const chips = el('div', 'mascot-chips');
          for (const item of finding.affected) chips.append(el('span', 'mascot-badge', localize(item)));
          block.append(chips);
        }
        guardFindings.append(block);
      }
      guardRecommendations.replaceChildren();
      if (assessment.recommendations.length > 0) {
        guardRecommendations.append(el('div', 'mascot-section-title', tr('Что советую')));
        const list = el('ul', 'mascot-recommendations');
        for (const item of assessment.recommendations) list.append(el('li', '', localize(item)));
        guardRecommendations.append(list);
      }
      ackInput.checked = false;
      confirmButton.disabled = true;
      guardOverlay.hidden = false;
      guardOverlay.dataset.risk = assessment.risk;
      const finish = (allowed: boolean): void => {
        guardOverlay.hidden = true;
        ackInput.removeEventListener('change', onAck);
        cancelButton.removeEventListener('click', onCancel);
        confirmButton.removeEventListener('click', onConfirm);
        document.removeEventListener('keydown', onKey);
        setExpression(allowed ? 'thumbsup' : 'wave');
        resolve(allowed);
      };
      const onAck = (): void => {
        confirmButton.disabled = !ackInput.checked;
      };
      const onCancel = (): void => finish(false);
      const onConfirm = (): void => {
        if (!ackInput.checked) return;
        finish(true);
      };
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
      };
      ackInput.addEventListener('change', onAck);
      cancelButton.addEventListener('click', onCancel);
      confirmButton.addEventListener('click', onConfirm);
      document.addEventListener('keydown', onKey);
      ackInput.focus();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Branding / section sync                                            */
  /* ------------------------------------------------------------------ */

  function sync(config: TenantConfig): void {
    state.config = config;
    const previous = state.branding;
    state.branding = readBranding(config);
    root.hidden = !state.branding.enabled;
    if (!state.branding.enabled && state.open) closePanel();
    nameEl.textContent = state.branding.name;
    fab.setAttribute('aria-label', `${state.branding.name} — ассистент редактора`);
    if (JSON.stringify(previous) !== JSON.stringify(state.branding)) {
      expressionFor((root.dataset.expression as MascotExpression) ?? 'wave');
    }
    renderFooter();
  }

  function setSection(id: string, title: string): void {
    if (state.sectionId === id) return;
    state.sectionId = id;
    state.sectionTitle = title;
    state.role = sectionRole(id);
    state.manualRole = false;
    writeStorage(ROLE_KEY, state.role);
    root.dataset.section = id;
    root.dataset.role = state.role;
    setExpression('wave');
    if (state.open) renderPanel();
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                             */
  /* ------------------------------------------------------------------ */

  let dragState: { pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null = null;

  function clampPosition(x: number, y: number): { x: number; y: number } {
    return {
      x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - fab.offsetWidth - 8)),
      y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - fab.offsetHeight - 8)),
    };
  }

  function applyPosition(): void {
    if (!state.pos) {
      fab.style.removeProperty('left');
      fab.style.removeProperty('top');
      return;
    }
    const clamped = clampPosition(state.pos.x, state.pos.y);
    fab.style.left = `${clamped.x}px`;
    fab.style.top = `${clamped.y}px`;
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
  }

  fab.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const rect = fab.getBoundingClientRect();
    dragState = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: rect.left, originY: rect.top, moved: false };
    fab.setPointerCapture(event.pointerId);
  });

  fab.addEventListener('pointermove', (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    if (Math.abs(dx) + Math.abs(dy) > 6) dragState.moved = true;
    if (!dragState.moved) return;
    state.pos = clampPosition(dragState.originX + dx, dragState.originY + dy);
    fab.style.left = `${state.pos.x}px`;
    fab.style.top = `${state.pos.y}px`;
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
  });

  const endDrag = (event: PointerEvent): void => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const moved = dragState.moved;
    dragState = null;
    try {
      fab.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
    if (moved) writeStorage(POS_KEY, JSON.stringify(state.pos));
    else togglePanel();
  };
  fab.addEventListener('pointerup', endDrag);
  fab.addEventListener('click', (event) => {
    if (event.detail === 0) togglePanel();
  });
  fab.addEventListener('pointercancel', () => {
    dragState = null;
  });

  closeButton.addEventListener('click', closePanel);
  historyButton.addEventListener('click', () => {
    state.historyView = !state.historyView;
    renderPanel();
    if (state.historyView) window.setTimeout(() => historySearchInput.focus(), 50);
  });
  newChatButton.addEventListener('click', newChat);
  historyNewButton.addEventListener('click', newChat);
  historySearchInput.addEventListener('input', () => {
    state.historySearch = historySearchInput.value;
    renderHistoryList();
  });
  roleSelect.addEventListener('change', () => {
    const next = roleSelect.value as DashboardAssistantRole;
    if (!ROLES.some((role) => role.id === next)) return;
    state.role = next;
    state.manualRole = true;
    writeStorage(ROLE_KEY, next);
    root.dataset.role = next;
    renderPanel();
  });
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    void ask(input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void ask(input.value);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.open && guardOverlay.hidden) {
      event.preventDefault();
      closePanel();
    }
  });

  window.addEventListener('resize', applyPosition);

  expressionFor('wave');
  applyPosition();
  root.hidden = !state.branding.enabled;
  renderPanel();
  currentTitle();

  return {
    sync,
    setSection,
    confirmSave: async (settings: ServerSettings, config: TenantConfig): Promise<boolean> => {
      state.busy = true;
      setExpression('thinking');
      const { assessment, local } = await assessConfig(settings, config);
      state.busy = false;
      state.localMode = state.localMode || local;
      if (!assessment.requiresConfirmation) {
        setExpression(assessment.risk === 'low' ? 'thumbsup' : 'wave');
        return true;
      }
      const allowed = await openGuard(assessment, local);
      if (!allowed) deps.notify(tr('Сохранение отменено: изменение не подтверждено.'), 'error');
      return allowed;
    },
    destroy: () => {
      window.removeEventListener('resize', applyPosition);
      root.remove();
    },
  };
}
