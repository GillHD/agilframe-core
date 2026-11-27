/** Room & limits section: room defaults, tenant-wide limits and a test-room helper. */
import { limitsSchema, roomContextSchema, roomDefaultsSchema } from '@agil/protocol';
import { button, copyText, el, readStorage, writeStorage } from '../dom';
import { card, fieldShell, renderSchema, type FieldCtx, type Sync } from '../fields';
import type { SectionDefinition } from './types';
import { tr } from '../i18n';

const ROOM_LABELS: Record<string, string> = {
  name: 'Имя комнаты',
  welcomeMessage: 'Приветствие',
  waitingMessage: 'Сообщение в зале ожидания',
  soundOnJoinLeave: 'Звук входа/выхода',
};

const ROOM_HINTS: Record<string, string> = {
  name: 'До 120 символов. Показывается в шапке, если включено «Показывать имя комнаты».',
  welcomeMessage: 'До 500 символов, показывается при входе.',
  waitingMessage: 'До 500 символов, показывается в зале ожидания.',
};

const LIMITS_LABELS: Record<string, string> = {
  maxParticipants: 'Макс. участников',
  maxDurationMin: 'Макс. длительность, минут',
  maxVideoSubscriptions: 'Макс. видеоподписок',
  galleryVideoBudget: 'Видео в галерее',
};

const LIMITS_HINTS: Record<string, string> = {
  maxParticipants: 'От 2 до 50 000 мест по умолчанию. Масштабирование, профиль SFU и тариф могут уменьшить лимит.',
  maxDurationMin: 'От 1 до 1440 минут (сутки).',
  maxVideoSubscriptions: 'Верхняя граница видеоподписок на участника. Используется меньший лимит из разделов «Комната» и «Масштабирование».',
  galleryVideoBudget: 'Фиксированное число удалённых видео. Пустое поле использует настройку масштабирования или бюджет профиля.',
};

/* ------------------------------------------------------------------ */
/* Test-room helper (messenger context; not part of TenantConfig)      */
/* ------------------------------------------------------------------ */

const TEST_ROOM_KEY = 'agil.editor.testRoom';
type TestRoomMode = '' | 'direct' | 'group';
type TestRoomTransport = '' | 'p2p' | 'sfu';

interface TestRoomState {
  mode: TestRoomMode;
  transport: TestRoomTransport;
  messenger: string;
  conversationId: string;
  directPeerId: string;
  title: string;
}

const EMPTY_TEST_ROOM: TestRoomState = {
  mode: '',
  transport: '',
  messenger: '',
  conversationId: '',
  directPeerId: '',
  title: '',
};

function loadTestRoom(): TestRoomState {
  try {
    const raw = readStorage(TEST_ROOM_KEY);
    if (!raw) return { ...EMPTY_TEST_ROOM };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY_TEST_ROOM };
    const record = parsed as Record<string, unknown>;
    const mode =
      record.mode === 'direct' || record.mode === 'group' || record.mode === '' ? record.mode : '';
    const transport = mode === 'direct' && (record.transport === 'p2p' || record.transport === 'sfu') ? record.transport : '';
    const text = (key: keyof typeof roomContextSchema.shape): string => {
      const value = record[key];
      return typeof value === 'string' ? value.slice(0, roomContextSchema.shape[key].unwrap().maxLength ?? undefined) : '';
    };
    return {
      mode,
      transport,
      messenger: text('messenger'),
      conversationId: text('conversationId'),
      directPeerId: text('directPeerId'),
      title: text('title'),
    };
  } catch {
    return { ...EMPTY_TEST_ROOM };
  }
}

function saveTestRoom(state: TestRoomState): void {
  writeStorage(TEST_ROOM_KEY, JSON.stringify(state));
}

/** Builds the POST /v1/admin/rooms body from the test-room fields + config. */
function buildCreateRoomRequest(ctx: FieldCtx, state: TestRoomState): Record<string, unknown> {
  const config = ctx.config();
  const body: Record<string, unknown> = {
    tenantId: config.tenantId,
    name: state.title.trim() || config.room.name || tr('Звонок'),
    maxParticipants: state.mode === 'direct' ? 2 : config.limits.maxParticipants,
  };
  if (state.mode) body.mode = state.mode;
  // transport is direct-only; P2P forces mesh + 2 seats, SFU keeps the current
  // effective plane. Group rooms never send it (docs/p2p.md).
  if (state.mode === 'direct' && state.transport) body.transport = state.transport;
  const context: Record<string, string> = {};
  if (state.messenger.trim()) context.messenger = state.messenger.trim();
  if (state.conversationId.trim()) context.conversationId = state.conversationId.trim();
  if (state.mode === 'direct' && state.directPeerId.trim()) context.directPeerId = state.directPeerId.trim();
  if (state.title.trim()) context.title = state.title.trim();
  if (Object.keys(context).length > 0) body.context = context;
  return body;
}

function testRoomCard(ctx: FieldCtx, parent: HTMLElement): Sync {
  const state = loadTestRoom();
  const testCard = card('Тестовая комната (контекст мессенджера)', {
    hint: 'Не входит в конфигурацию организации: реальные комнаты создаются через API (POST /v1/admin/rooms). direct — личный звонок один на один из чата мессенджера (не больше двух участников); group — групповая беседа. Для direct можно выбрать P2P (напрямую, 2 места) или SFU (docs/p2p.md, docs/messenger.md).',
  });

  const modeShell = fieldShell('Режим комнаты', {
    hint: 'direct — личный звонок один на один из мессенджера; group — групповая беседа; пусто — обычная комната.',
  });
  const modeSelect = el('select', 'input input-select');
  modeSelect.setAttribute('aria-label', tr('Режим тестовой комнаты'));
  for (const [value, label] of [
    ['', 'не задан'],
    ['direct', 'Личный звонок (direct, 1:1, 2 участника)'],
    ['group', 'Групповая беседа (group)'],
  ] as const) {
    const option = el('option');
    option.value = value;
    option.textContent = tr(label);
    modeSelect.append(option);
  }
  modeSelect.value = state.mode;
  modeShell.body.append(modeSelect);
  testCard.body.append(modeShell.root);

  const transportShell = fieldShell('Режим связи (direct)', {
    hint: 'P2P — напрямую между браузерами, ровно 2 места, без серверного медиа; серверная запись/трансляция вернёт 409. SFU — через сервер (текущий режим). Пусто — как настроено в организации. Только для direct; для group поле отключено.',
  });
  const transportSelect = el('select', 'input input-select');
  transportSelect.setAttribute('aria-label', tr('Режим связи тестовой комнаты'));
  for (const [value, label] of [
    ['', 'не задан (как в организации)'],
    ['sfu', 'SFU (через сервер)'],
    ['p2p', 'P2P (напрямую, 2 места)'],
  ] as const) {
    const option = el('option');
    option.value = value;
    option.textContent = tr(label);
    transportSelect.append(option);
  }
  transportSelect.value = state.transport;
  transportSelect.disabled = state.mode !== 'direct';
  transportShell.body.append(transportSelect);
  testCard.body.append(transportShell.root);

  const textFields: Array<{
    key: 'messenger' | 'conversationId' | 'directPeerId' | 'title';
    title: string;
    hint: string;
    placeholder: string;
  }> = [
    {
      key: 'messenger',
      title: 'Мессенджер',
      hint: 'Свободная строка: telegram | slack | teams | matrix | corp-messenger.',
      placeholder: 'corp-messenger',
    },
    {
      key: 'conversationId',
      title: 'Идентификатор беседы',
      hint: 'Одна беседа — одна комната (по договорённости с сервером мессенджера).',
      placeholder: 'dm-42',
    },
    {
      key: 'directPeerId',
      title: 'Идентификатор собеседника (direct)',
      hint: 'Необязательно: участник на другой стороне личного звонка.',
      placeholder: 'user-7',
    },
    {
      key: 'title',
      title: 'Заголовок звонка',
      hint: 'Показывается в карточке звонка; пусто — имя комнаты из конфигурации.',
      placeholder: 'Звонок с Анной',
    },
  ];
  const inputs = new Map<(typeof textFields)[number]['key'], HTMLInputElement>();
  for (const field of textFields) {
    const shell = fieldShell(field.title, { hint: field.hint });
    const input = el('input', 'input input-text');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    const maxLength = roomContextSchema.shape[field.key].unwrap().maxLength;
    if (maxLength !== null) input.maxLength = maxLength;
    input.placeholder = tr(field.placeholder);
    input.value = state[field.key];
    input.setAttribute('aria-label', tr(field.title));
    shell.body.append(input);
    testCard.body.append(shell.root);
    inputs.set(field.key, input);
  }
  const directPeer = inputs.get('directPeerId')!;
  directPeer.disabled = state.mode !== 'direct';

  const requestShell = fieldShell('Запрос в API', {
    hint: 'POST /v1/admin/rooms с x-api-key; тело запроса, которое создаст такую комнату.',
  });
  const requestArea = el('textarea', 'input input-textarea');
  requestArea.rows = 8;
  requestArea.readOnly = true;
  requestArea.spellcheck = false;
  requestArea.setAttribute('aria-label', tr('JSON-запрос POST /v1/admin/rooms'));
  const copyRow = el('div', 'button-row');
  const copyButton = button(tr('Копировать запрос'), 'btn btn-small', 'copy');
  copyButton.dataset.testid = 'copy-test-room';
  copyButton.addEventListener('click', async () => {
    const copied = await copyText(requestArea.value);
    ctx.toast(tr(copied ? 'JSON-запрос скопирован' : 'Не удалось скопировать'), copied ? 'success' : 'error');
  });
  copyRow.append(copyButton);
  requestShell.body.append(requestArea, copyRow);
  testCard.body.append(requestShell.root);

  // Test token: custom role (`roleId`) support (docs/api-guide.md §3).
  const tokenShell = fieldShell('Тестовый токен (roleId)', {
    hint: 'Запрос POST /v1/tokens с ключом x-api-key. roleId выдаёт участнику права своей роли (customRoles из раздела «Доступы»). Без roleId используется встроенная роль участника.',
  });
  const roomId = el('input', 'input input-text');
  roomId.type = 'text';
  roomId.maxLength = 64;
  roomId.autocomplete = 'off';
  roomId.spellcheck = false;
  roomId.placeholder = '<roomId>';
  roomId.setAttribute('aria-label', tr('Идентификатор комнаты для токена'));
  const roomIdField = fieldShell('Идентификатор комнаты для токена');
  roomIdField.body.append(roomId);
  tokenShell.body.append(roomIdField.root);
  const roleRow = el('div', 'inline-row');
  roleRow.append(el('span', 'field-label', tr('Своя роль (roleId):')));
  const roleSelect = el('select', 'input input-select');
  roleSelect.setAttribute('aria-label', tr('roleId для тестового токена'));
  const emptyOption = el('option');
  emptyOption.value = '';
  emptyOption.textContent = tr('без своей роли (встроенная)');
  roleRow.append(roleSelect);
  const tokenArea = el('textarea', 'input input-textarea');
  tokenArea.rows = 8;
  tokenArea.readOnly = true;
  tokenArea.spellcheck = false;
  tokenArea.setAttribute('aria-label', tr('JSON-запрос POST /v1/tokens'));
  const tokenCopyRow = el('div', 'button-row');
  const tokenCopy = button(tr('Копировать запрос токена'), 'btn btn-small', 'copy');
  tokenCopy.dataset.testid = 'copy-test-room-token';
  tokenCopy.addEventListener('click', async () => {
    const copied = await copyText(tokenArea.value);
    ctx.toast(tr(copied ? 'Запрос токена скопирован' : 'Не удалось скопировать'), copied ? 'success' : 'error');
  });
  tokenCopyRow.append(tokenCopy);
  tokenShell.body.append(roleRow, tokenArea, tokenCopyRow);
  testCard.body.append(tokenShell.root);
  parent.append(testCard.root);

  let previousRoles: ReturnType<typeof readCustomRoles> | undefined;
  const refresh = (): void => {
    const roles = readCustomRoles(ctx);
    if (roles !== previousRoles) {
      const selected = roleSelect.value;
      roleSelect.replaceChildren(emptyOption, ...roles.map((role) => {
        const option = el('option');
        option.value = role.id;
        option.textContent = `${role.id} — ${role.name}`;
        return option;
      }));
      roleSelect.value = roles.some((role) => role.id === selected) ? selected : '';
      previousRoles = roles;
    }
    requestArea.value = JSON.stringify(buildCreateRoomRequest(ctx, state), null, 2);
    tokenArea.value = JSON.stringify(buildTokenRequest(ctx, roleSelect.value, roomId.value.trim()), null, 2);
  };

  const onChange = (): void => {
    state.mode = modeSelect.value === 'direct' || modeSelect.value === 'group' ? modeSelect.value : '';
    state.transport =
      transportSelect.value === 'p2p' || transportSelect.value === 'sfu' ? transportSelect.value : '';
    transportSelect.disabled = state.mode !== 'direct';
    directPeer.disabled = state.mode !== 'direct';
    if (state.mode !== 'direct') {
      state.transport = '';
      transportSelect.value = '';
    }
    for (const [key, input] of inputs) state[key] = input.value;
    saveTestRoom(state);
    refresh();
  };

  modeSelect.addEventListener('change', onChange);
  transportSelect.addEventListener('change', onChange);
  roleSelect.addEventListener('change', refresh);
  roomId.addEventListener('input', refresh);
  for (const input of inputs.values()) input.addEventListener('input', onChange);
  refresh();
  return refresh;
}

/** Company-defined roles from the policy (for the test-token roleId select). */
function readCustomRoles(ctx: FieldCtx) {
  return ctx.config().security.accessPolicy.customRoles;
}

/** Builds the POST /v1/tokens body for the test token with an optional roleId. */
function buildTokenRequest(ctx: FieldCtx, roleId: string, roomId: string): Record<string, unknown> {
  const config = ctx.config();
  const role = readCustomRoles(ctx).find((entry) => entry.id === roleId);
  const baseRole = role?.baseRole === 'host' || role?.baseRole === 'moderator' ? role.baseRole : 'guest';
  return {
    tenantId: config.tenantId,
    roomId: roomId || '<roomId>',
    participant: {
      name: tr('Гость'),
      role: baseRole,
      ...(role ? { roleId: role.id } : {}),
    },
  };
}

export const roomSection: SectionDefinition = {
  id: 'room',
  title: 'Комната',
  icon: 'door',
  description:
    'Значения комнаты по умолчанию, лимиты и тестовая комната с параметрами мессенджера (mode и context). Оформление — в разделе «Бренд».',
  render(ctx, root) {
    const syncs: Sync[] = [];

    const roomCard = card('Комната по умолчанию', {
      hint: 'Применяется к новым комнатам организации, если при создании не указано другое.',
    });
    const roomFields = renderSchema(roomDefaultsSchema, 'room', ctx, {
      labels: ROOM_LABELS,
      hints: ROOM_HINTS,
      multiline: ['welcomeMessage', 'waitingMessage'],
    });
    roomCard.body.append(roomFields.node);
    root.append(roomCard.root);
    syncs.push(...roomFields.syncs);

    const limitsCard = card('Лимиты');
    const limitFields = renderSchema(limitsSchema, 'limits', ctx, {
      labels: LIMITS_LABELS,
      hints: LIMITS_HINTS,
    });
    limitsCard.body.append(limitFields.node);
    root.append(limitsCard.root);
    syncs.push(...limitFields.syncs);

    syncs.push(testRoomCard(ctx, root));

    return syncs;
  },
};
