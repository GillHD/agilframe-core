/**
 * Shared dialogs: create a test room, show invite/join links, issue an invite.
 * Used by Overview, Rooms and Room detail screens.
 */
import type { CreateRoomRequest, CreateRoomResponse, RoomContext, RoomMode } from '@agil/protocol';
import type { AppContext } from '../context.js';
import { h } from '../dom.js';
import { describeError } from '../errors.js';
import { formatDateTime } from '../format.js';
import { icon } from '../icons.js';
import { demoJoinUrl } from '../links.js';
import { badge } from '../ui/badge.js';
import { codeBlock } from '../ui/code-block.js';
import { button, field, formGrid, selectInput, textInput } from '../ui/controls.js';
import { copyButton } from '../ui/copy-button.js';
import { confirmDialog } from '../ui/confirm-dialog.js';
import { openModal, type ModalHandle } from '../ui/modal.js';
import { alert } from './common.js';

const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%*';

export function confirmRoomLockChange(locked: boolean): Promise<boolean> {
  return confirmDialog(locked
    ? {
        title: 'Закрыть комнату?',
        message: 'Вход в комнату будет закрыт. Подключённые участники останутся в звонке. Ссылка снова заработает после открытия комнаты.',
        confirmLabel: 'Закрыть комнату',
        danger: true,
      }
    : {
        title: 'Открыть комнату?',
        message: 'Участники снова смогут войти по той же ссылке. Действующие правила доступа продолжат работать.',
        confirmLabel: 'Открыть комнату',
      });
}

export function generatePassword(length = 14): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  let result = '';
  for (let index = 0; index < length; index += 1) {
    const byte = bytes[index] ?? 0;
    result += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length] ?? 'x';
  }
  return result;
}

export interface RoomLinksDialogOptions {
  title?: string;
  roomId: string;
  joinUrl: string;
  embedUrl: string;
  token?: string;
  expiresAt?: number;
  passwordProtected?: boolean;
  /** Password just created/set — shown exactly once in this dialog. */
  password?: string;
  permissions?: readonly string[];
  roomMode?: RoomMode;
  mediaMode?: 'mesh' | 'sfu' | 'broadcast';
  context?: RoomContext;
  onClose?: () => void;
}

/** Shows join/embed URLs (and an optional token) with copy buttons. */
export function showRoomLinksDialog(ctx: AppContext, options: RoomLinksDialogOptions): void {
  let handle: ModalHandle | null = null;
  const body = h('div', { class: 'stack' });

  const summary = h('div', { class: 'row' });
  summary.appendChild(badge(`Комната ${options.roomId}`, 'primary'));
  if (options.roomMode) {
    summary.appendChild(badge(options.roomMode === 'direct' ? '1:1' : 'группа', options.roomMode === 'direct' ? 'info' : 'neutral'));
  }
  if (options.mediaMode) {
    const mediaLabel =
      options.mediaMode === 'mesh'
        ? options.roomMode === 'direct'
          ? 'P2P (напрямую, без серверного медиа)'
          : 'прямое соединение (mesh)'
        : options.mediaMode === 'sfu'
          ? 'через сервер (SFU)'
          : 'трансляция (broadcast)';
    summary.appendChild(
      badge(`Режим связи: ${mediaLabel}`, options.mediaMode === 'mesh' ? 'success' : options.mediaMode === 'sfu' ? 'info' : 'warning', {
        title:
          options.mediaMode === 'mesh' && options.roomMode === 'direct'
            ? 'P2P: браузеры соединяются напрямую, медиа не проходит через сервер; в комнате 2 места (docs/p2p.md)'
            : 'Эффективный режим связи комнаты (RoomInfo.mediaMode)',
      }),
    );
  }
  if (options.context?.messenger) summary.appendChild(badge(options.context.messenger, 'neutral', { title: 'messenger' }));
  if (options.context?.title) summary.appendChild(badge(options.context.title, 'neutral', { title: 'context.title' }));
  if (options.passwordProtected) summary.appendChild(badge('Пароль', 'warning', { dot: true }));
  if (options.token) summary.appendChild(badge('Токен доступа', 'info', { dot: true }));
  body.appendChild(summary);
  if (options.password) {
    const passwordCode = h('code', { class: 'password-once', text: options.password });
    body.appendChild(
      h(
        'div',
        { class: 'password-once-box' },
        h('div', { class: 'row' }, h('span', { class: 'field-label', text: 'Пароль комнаты' }), badge('показан один раз', 'danger')),
        passwordCode,
        h('div', { class: 'actions' }, copyButton(options.password, { label: 'Скопировать пароль', title: 'Скопировать пароль' })),
        alert(
          'warning',
          'Сохраните пароль сейчас — позже его нельзя посмотреть',
          'Сервер хранит только scrypt-хэш и не возвращает пароль. Без пароля участники не смогут войти в комнату; админ сможет сменить пароль в карточке комнаты.',
        ),
      ),
    );
    const inviteWithPassword = `${options.joinUrl}${options.joinUrl.includes('?') ? '&' : '?'}password=${encodeURIComponent(options.password)}`;
    body.appendChild(
      h(
        'div',
        { class: 'actions' },
        copyButton(inviteWithPassword, {
          label: 'Копировать приглашение с паролем',
          title: 'Ссылка для входа с паролем — не публикуйте в открытых каналах',
        }),
        h('span', { class: 'notice', text: 'Пароль в ссылке — для доверенного канала; лучше передать его отдельно.' }),
      ),
    );
  } else if (options.passwordProtected) {
    body.appendChild(
      alert(
        'danger',
        'Комната защищена паролем, но сервер не вернул пароль',
        'Пароль мог быть задан автоматически/ранее и не хранится в открытом виде. Откройте карточку комнаты и смените пароль — старый показывать нельзя.',
      ),
    );
  }
  if (options.context && (options.context.conversationId || options.context.directPeerId)) {
    body.appendChild(
      h('p', {
        class: 'notice',
        text: [
          options.context.conversationId ? `conversationId: ${options.context.conversationId}` : '',
          options.context.directPeerId ? `directPeerId: ${options.context.directPeerId}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      }),
    );
  }

  const joinRow = h('div', { class: 'link-row' });
  joinRow.append(
    h('span', { class: 'link-value', text: options.joinUrl, attrs: { title: options.joinUrl } }),
    copyButton(options.joinUrl, { title: 'Скопировать ссылку для входа' }),
  );
  const embedRow = h('div', { class: 'link-row' });
  embedRow.append(
    h('span', { class: 'link-value', text: options.embedUrl, attrs: { title: options.embedUrl } }),
    copyButton(options.embedUrl, { title: 'Скопировать ссылку для встраивания' }),
  );
  body.append(
    h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Ссылка для входа' }), joinRow),
    h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Ссылка для встраивания' }), embedRow),
  );

  if (options.token) {
    body.appendChild(
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label', text: 'Токен' }),
        codeBlock(options.token, { title: 'JWT' }),
      ),
    );
    body.appendChild(
      alert(
        'warning',
        'Токен — это доступ к комнате',
        'Не публикуйте его в открытых каналах. Срок действия ограничен — по истечении выдайте новое приглашение.',
      ),
    );
    if (options.expiresAt) {
      body.appendChild(h('p', { class: 'notice', text: `Действует до: ${formatDateTime(options.expiresAt)}` }));
    }
  }
  if (options.permissions && options.permissions.length > 0) {
    body.appendChild(
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label', text: `Права (${options.permissions.length})` }),
        h('div', { class: 'chips' }, ...options.permissions.slice(0, 24).map((key) => badge(key, 'neutral'))),
      ),
    );
  }

  const demoLink = h(
    'a',
    {
      class: 'btn btn-primary',
      attrs: {
        href: demoJoinUrl(ctx.credentials.serverUrl, options.roomId, options.token, ctx.tenantId),
        target: '_blank',
        rel: 'noopener noreferrer',
      },
    },
    icon('play', 16),
    h('span', { text: 'Открыть демо' }),
  );

  handle = openModal({
    title: options.title ?? 'Комната создана',
    size: 'md',
    body,
    footer: [button('Закрыть', { variant: 'ghost', onClick: () => handle?.close() }), demoLink],
    onClose: options.onClose,
  });
}

export interface CreateRoomDialogOptions {
  onCreated?: (response: CreateRoomResponse) => void;
}

/** Create-room form → POST /v1/admin/rooms → links dialog. */
export function openCreateRoomDialog(ctx: AppContext, options: CreateRoomDialogOptions = {}): void {
  let handle: ModalHandle | null = null;

  const nameInput = textInput({ value: 'Тестовая комната', placeholder: 'Название комнаты' });
  const roomIdInput = textInput({ placeholder: 'Пусто — сервер создаст ID', ariaLabel: 'ID комнаты (необязательно) — оставьте пустым, сервер создаст идентификатор' });
  roomIdInput.spellcheck = false;
  const passwordInput = textInput({ placeholder: 'Без пароля' });
  passwordInput.autocomplete = 'new-password';
  const maxInput = textInput({ type: 'number', value: '12', min: 2, max: 50000 });
  const scaleInfoHost = h('div', { class: 'notice', text: 'Запрашиваем режим связи…' });
  const ttlSelect = selectInput(
    [
      { value: '0', label: 'Хранить всегда' },
      { value: '3600', label: '1 час после выхода' },
      { value: '86400', label: '24 часа' },
    ],
    { value: '0' },
  );

  /* ------------------------ messenger context ------------------------- */
  const modeSelect = selectInput(
    [
      { value: 'group', label: 'Групповой звонок' },
      { value: 'direct', label: 'Один на один (1:1)' },
    ],
    {
      value: 'group',
      onChange: (value) => {
        const direct = value === 'direct';
        maxInput.disabled = direct;
        directPeerInput.disabled = !direct;
        transportSelect.disabled = !direct;
        if (direct) maxInput.value = '2';
        else transportSelect.value = 'sfu';
        updateTransportNote();
      },
    },
  );
  /**
   * P2P is a direct-only transport. SFU is the default/current behaviour, so it
   * is intentionally sent only when the operator explicitly picks it.
   */
  const transportSelect = selectInput(
    [
      { value: 'sfu', label: 'SFU — через сервер (текущий режим)' },
      { value: 'p2p', label: 'P2P — напрямую, 2 места' },
    ],
    {
      value: 'sfu',
      onChange: () => updateTransportNote(),
    },
  );
  transportSelect.disabled = true;
  const transportNote = h('div', { attrs: { 'aria-live': 'polite' } });
  const updateTransportNote = (): void => {
    const p2p = modeSelect.value === 'direct' && transportSelect.value === 'p2p';
    if (p2p) maxInput.value = '2';
    transportNote.replaceChildren(
      ...(p2p
        ? [
            alert(
              'warning',
              'P2P: только два участника и никакого серверного медиа',
              'Браузеры соединяются напрямую: медиа не проходит через сервер, участники видят IP-адреса друг друга, а для сложных сетей используется TURN. ' +
                'Серверная запись (egress), RTMP/HLS-трансляция и вебинары требуют SFU — сервер вернёт 409. ' +
                'Локальная запись в браузере и чат продолжают работать. Для 3+ участников выберите SFU (docs/p2p.md).',
            ),
          ]
        : []),
    );
  };
  const messengerInput = textInput({ placeholder: 'corp-messenger / telegram / teams' });
  const conversationInput = textInput({ placeholder: 'dm-42 / channel-9' });
  const directPeerInput = textInput({ placeholder: 'user-7', disabled: true });
  const contextTitleInput = textInput({ placeholder: 'Звонок с Анной' });

  const contextDetails = h('details', { class: 'card', attrs: { style: 'padding: 12px' } });
  contextDetails.appendChild(
    h('summary', { class: 'section-title', text: 'Контекст мессенджера (необязательно)' }),
  );
  contextDetails.appendChild(
    h(
      'div',
      { class: 'stack', attrs: { style: 'margin-top: 10px' } },
      formGrid(
        field('Мессенджер (messenger)', messengerInput, { hint: 'Свободный идентификатор: telegram, slack, teams, corp-messenger.' }),
        field('Беседа (conversationId)', conversationInput, { hint: 'Беседа или канал, к которому привязан звонок.' }),
        field('Собеседник (directPeerId)', directPeerInput, { hint: 'Для звонка «один на один» (direct): id собеседника в вашей системе.' }),
        field('Заголовок (context.title)', contextTitleInput, { hint: 'Заголовок карточки звонка в мессенджере.' }),
      ),
      h('p', {
        class: 'notice',
        text: 'Контекст возвращается в данных комнаты (создание, вход, приветствие, панель управления) и уходит в уведомление room.created — см. docs/messenger.md.',
      }),
    ),
  );

  const generated = button('Сгенерировать', {
    variant: 'ghost',
    size: 'sm',
    icon: 'key',
    onClick: () => {
      passwordInput.value = generatePassword();
      passwordInput.type = 'text';
    },
  });

  const alertBox = h('div', { attrs: { 'aria-live': 'polite' } });
  const capacityNote = h('div', { attrs: { 'aria-live': 'polite' } });
  let capacityLimit: { profile: string; participants: number } | null = null;
  const updateCapacityNote = (): void => {
    const requested = Number(maxInput.value);
    if (modeSelect.value === 'direct' || !capacityLimit || !Number.isFinite(requested) || requested <= capacityLimit.participants) {
      capacityNote.replaceChildren();
      return;
    }
    capacityNote.replaceChildren(
      alert(
        'warning',
        'Лимит выше ёмкости профиля SFU',
        `Профиль ${capacityLimit.profile} рассчитан на ${capacityLimit.participants} участников: комната будет создана с лимитом ${capacityLimit.participants}, ` +
          `а не ${requested}. Поднимите профиль/ноду (docs/large-rooms.md) или уменьшите число участников.`,
      ),
    );
  };
  const form = h(
    'div',
    { class: 'stack', attrs: { role: 'form', 'aria-label': 'Создание комнаты' } },
    formGrid(
      field('Название', nameInput),
      field('ID комнаты (необязательно)', roomIdInput, { hint: 'Латиница, цифры, дефисы.' }),
      field('Пароль (необязательно)', h('div', { class: 'key-row' }, passwordInput, generated), {
        hint: 'Покажем пароль один раз в окне после создания; сервер хранит только scrypt-хэш.',
      }),
      field('Максимум участников', maxInput, { hint: 'До 50 000; фактический предел задают профиль ёмкости SFU, сервер и тариф.' }),
      field('Срок хранения после выхода (TTL)', ttlSelect),
      field('Тип звонка', modeSelect, {
        hint: '«Один на один» (direct) — звонок из чата мессенджера, не больше 2 участников; «Групповой» (group) — обычный групповой звонок.',
      }),
      field('Режим связи', transportSelect, {
        hint: 'Только для «Один на один». SFU — через сервер (текущий режим, нужен для записи/трансляции). P2P — напрямую между браузерами, ровно 2 места.',
      }),
      field('Режим связи комнаты (из масштабирования)', scaleInfoHost, {
        hint: 'Без явного выбора (SFU) комната наследует режим организации (GET /v1/admin/scale); P2P всегда mesh и 2 места.',
      }),
    ),
    contextDetails,
    transportNote,
    capacityNote,
    alertBox,
    alert(
      'info',
      'Что произойдёт',
      'Сервер создаст комнату и выдаст ссылки для входа и встраивания, а на демо-сервере — токен доступа. После создания откроется окно с приглашением.',
    ),
  );

  const submit = button('Создать комнату', { variant: 'primary', icon: 'plus' });

  const runCreate = async (): Promise<void> => {
    if (submit.disabled) return;
    const name = nameInput.value.trim();
    if (!name || name.length > 120) {
      alertBox.replaceChildren(!name
        ? alert('danger', 'Нужно название', 'Укажите имя комнаты.')
        : alert('danger', 'Слишком длинное название', 'Название должно содержать до 120 символов.'));
      nameInput.focus();
      return;
    }
    const maxParsed = Number(maxInput.value);
    const mode: RoomMode = modeSelect.value === 'direct' ? 'direct' : 'group';
    const maxParticipants = mode === 'direct' ? 2 : maxParsed;
    if (mode !== 'direct' && (!Number.isInteger(maxParsed) || maxParsed < 2 || maxParsed > 50000)) {
      alertBox.replaceChildren(alert('danger', 'Проверьте лимит', 'Введите целое число от 2 до 50 000. Фактический предел зависит от настроек сервера.'));
      maxInput.focus();
      return;
    }
    const request: CreateRoomRequest = {
      tenantId: ctx.tenantId,
      name,
      mode,
      maxParticipants,
      ttlSec: Number(ttlSelect.value),
    };
    // `transport` is direct-only. "SFU" is the current/default path; send it
    // explicitly so the intent is visible in audit/webhooks.
    if (mode === 'direct') request.transport = transportSelect.value === 'p2p' ? 'p2p' : 'sfu';
    const context: RoomContext = {};
    const messenger = messengerInput.value.trim();
    const conversationId = conversationInput.value.trim();
    const directPeerId = directPeerInput.value.trim();
    const contextTitle = contextTitleInput.value.trim();
    if (messenger) context.messenger = messenger;
    if (conversationId) context.conversationId = conversationId;
    if (directPeerId) context.directPeerId = directPeerId;
    if (contextTitle) context.title = contextTitle;
    if (Object.keys(context).length > 0) request.context = context;
    const roomId = roomIdInput.value.trim();
    if (roomId) request.roomId = roomId;
    if (passwordInput.value) request.password = passwordInput.value;

    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    alertBox.replaceChildren();
    try {
      const response = await ctx.api.createRoom(request);
      ctx.setServerStatus('online');
      ctx.toast(`Комната «${response.room.name}» создана`, 'success');
      handle?.close();
      options.onCreated?.(response);
      showRoomLinksDialog(ctx, {
        title: `Комната «${response.room.name}» создана`,
        roomId: response.room.id,
        joinUrl: response.joinUrl,
        embedUrl: response.embedUrl,
        token: response.token,
        expiresAt: response.expiresAt,
        passwordProtected: response.passwordProtected,
        password: request.password,
        roomMode: response.room.mode,
        mediaMode: response.room.mediaMode,
        context: response.room.context,
      });
    } catch (error) {
      const info = describeError(error);
      alertBox.replaceChildren(alert('danger', info.title, [info.message, info.hint].filter(Boolean).join(' ')));
      if (info.offline) ctx.setServerStatus('offline');
    } finally {
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
    }
  };

  submit.addEventListener('click', () => {
    void runCreate();
  });
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      void runCreate();
    }
  });
  maxInput.addEventListener('input', updateCapacityNote);
  modeSelect.addEventListener('change', updateCapacityNote);

  handle = openModal({
    title: 'Создать комнату',
    size: 'md',
    body: form,
    footer: [button('Отмена', { variant: 'ghost', onClick: () => handle?.close() }), submit],
  });

  void (async () => {
    try {
      const scale = await ctx.api.scale();
      const mediaMode = scale.mediaMode;
      const mediaLabel = mediaMode === 'mesh' ? 'прямое соединение' : mediaMode === 'sfu' ? 'через SFU' : 'трансляция';
      const profileParticipants = scale.sfuCapacity?.participants ?? scale.effectiveMaxParticipants;
      if (profileParticipants !== undefined && mediaMode !== 'mesh') {
        capacityLimit = {
          profile: scale.sfuProfile ?? scale.sfuCapacity?.profile ?? 'standard',
          participants: profileParticipants,
        };
      }
      scaleInfoHost.replaceChildren(
        badge(mediaLabel, mediaMode === 'mesh' ? 'success' : mediaMode === 'sfu' ? 'info' : 'warning', { dot: true, title: `Эффективный режим связи: ${mediaMode}` }),
        h('span', {
          text: ` режим связи организации · участников по умолчанию: ${scale.config.maxParticipants}${
            profileParticipants !== undefined ? ` · ёмкость профиля: ${profileParticipants}` : ''
          }`,
        }),
      );
      if (Number(maxInput.value) === 12) {
        maxInput.value = String(Math.min(50000, Math.max(2, scale.config.maxParticipants)));
      }
      updateCapacityNote();
    } catch {
      scaleInfoHost.textContent = 'Не удалось получить настройки масштабирования (/v1/admin/scale) — комната будет создана с режимом связи сервера.';
    }
  })();
}

export interface InviteDialogOptions {
  roomId: string;
  roomName?: string;
  onCreated?: () => void;
}

/** Invite link (short-lived token) form → POST /v1/admin/rooms/:id/invites. */
export function openInviteDialog(ctx: AppContext, options: InviteDialogOptions): void {
  let handle: ModalHandle | null = null;

  const ttlSelect = selectInput(
    [
      { value: '3600', label: '1 час' },
      { value: '86400', label: '24 часа' },
      { value: '604800', label: '7 дней' },
    ],
    { value: '86400' },
  );
  const roleSelect = selectInput(
    [
      { value: 'guest', label: 'Гость' },
      { value: 'moderator', label: 'Модератор' },
      { value: 'host', label: 'Организатор' },
    ],
    { value: 'guest' },
  );
  const alertBox = h('div', { attrs: { 'aria-live': 'polite' } });

  const submit = button('Создать приглашение', { variant: 'primary', icon: 'link' });
  const run = async (): Promise<void> => {
    submit.disabled = true;
    alertBox.replaceChildren();
    try {
      const invite = await ctx.api.createInvite(options.roomId, {
        ttlSec: Number(ttlSelect.value),
        role: roleSelect.value as 'guest' | 'moderator' | 'host',
      });
      handle?.close();
      options.onCreated?.();
      showRoomLinksDialog(ctx, {
        title: 'Приглашение создано',
        roomId: invite.roomId,
        joinUrl: invite.joinUrl,
        embedUrl: invite.embedUrl,
        token: invite.token,
        expiresAt: invite.expiresAt,
        passwordProtected: invite.passwordProtected,
      });
    } catch (error) {
      const info = describeError(error);
      alertBox.replaceChildren(alert('danger', info.title, [info.message, info.hint].filter(Boolean).join(' ')));
      if (info.offline) ctx.setServerStatus('offline');
    } finally {
      submit.disabled = false;
    }
  };
  submit.addEventListener('click', () => {
    void run();
  });

  const body = h(
    'div',
    { class: 'stack' },
    h('p', {
      class: 'muted',
      text: `Комната «${options.roomName ?? options.roomId}». Приглашение содержит токен с ограниченным сроком действия.`,
    }),
    formGrid(field('Срок действия', ttlSelect), field('Роль участника', roleSelect)),
    alertBox,
  );

  handle = openModal({
    title: 'Пригласительная ссылка',
    size: 'sm',
    body,
    footer: [button('Отмена', { variant: 'ghost', onClick: () => handle?.close() }), submit],
  });
}
