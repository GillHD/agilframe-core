/**
 * Settings / Embed: connection credentials, embed snippet generator, public
 * endpoints, API docs/MCP pointers and a full settings reset.
 */
import { publicPaths, tenantConfigSchema, type FeatureKey } from '@agil/protocol';
import { DEFAULT_MEDIA_PROCESSING } from '@agil/protocol';
import type { AdminRoomSummary, TenantConfig, TenantConfigPatch } from '@agil/protocol';
import type { ScreenFactory } from '../context.js';
import { getServerUrl, isLocalDevHost, resetAllSettings, getPrefilledApiKey, validateServerUrl } from '../auth.js';
import { h, setButtonLoading, append } from '../dom.js';
import { describeError } from '../errors.js';
import { formatTime } from '../format.js';
import { featureLabel } from '../features.js';
import { t } from '../i18n.js';
import { icon } from '../icons.js';
import { publicLinks, docsRoute } from '../links.js';
import { normalizeBaseUrl } from '../api.js';
import { ApiError, type MediaProcessingStatus, type SttStatus } from '../api.js';
import { badge } from '../ui/badge.js';
import { card, kvGrid } from '../ui/card.js';
import { codeBlock } from '../ui/code-block.js';
import { button, checkboxField, field, formGrid, selectInput, textInput } from '../ui/controls.js';
import { confirmDialog } from '../ui/confirm-dialog.js';
import { copyButton } from '../ui/copy-button.js';
import { emptyState } from '../ui/empty-state.js';
import { guardedSave } from '../ui/guard.js';
import { MASCOT_EXPRESSIONS, bundledMascot } from '../ui/mascot.js';
import { loadingPanel } from '../ui/skeleton.js';
import { toast } from '../ui/toast.js';
import { alert, errorState, offlinePanel, pageHeader, toastError } from './common.js';

const EMBED_FEATURES: readonly FeatureKey[] = [
  'chat',
  'screenShare',
  'recording',
  'captions',
  'backgroundBlur',
  'waitingRoom',
  'aiCompliance',
  'knowledgeAgent',
  'meetingNotes',
];

const SCHEMES = [
  { value: 'auto', label: 'Как в системе (auto)' },
  { value: 'light', label: 'Светлая (light)' },
  { value: 'dark', label: 'Тёмная (dark)' },
];

const ROLES = [
  { value: 'guest', label: 'Гость' },
  { value: 'moderator', label: 'Модератор' },
  { value: 'host', label: 'Организатор' },
];

function changedFields<T extends object>(before: T, after: T): Partial<T> {
  return Object.fromEntries(
    (Object.keys(after) as Array<keyof T>).filter((key) => !Object.is(before[key], after[key])).map((key) => [key, after[key]]),
  ) as Partial<T>;
}

export const settingsScreen: ScreenFactory = (ctx) => {
  const root = h('div', { class: 'page' });
  const body = h('div', { class: 'stack' });
  let destroyed = false;
  let rooms: AdminRoomSummary[] = [];
  let roomsError: unknown = null;
  let config: TenantConfig | null = null;
  let configError: unknown = null;
  let behaviorDraft: TenantConfig | null = null;
  let mediaDraft: TenantConfig['mediaProcessing'] | null = null;
  let mediaStatus: MediaProcessingStatus | null = null;
  let mediaStatusError: unknown = null;
  let sttStatus: SttStatus | null = null;
  let sttStatusError: unknown = null;
  const localDev = isLocalDevHost();

  /* -------------------------- connection form -------------------------- */
  const serverInput = textInput({ value: getServerUrl(), type: 'url', spellcheck: false });
  const keyInput = textInput({ value: ctx.credentials.apiKey || getPrefilledApiKey(), type: 'password', autocomplete: 'off' });
  const revealKey = button(undefined, {
    variant: 'ghost',
    icon: 'eye',
    title: 'Показать ключ',
    onClick: () => {
      const reveal = keyInput.type === 'password';
      keyInput.type = reveal ? 'text' : 'password';
      revealKey.replaceChildren(icon(reveal ? 'eye-off' : 'eye', 16));
      const label = reveal ? 'Скрыть ключ' : 'Показать ключ';
      revealKey.title = label;
      revealKey.setAttribute('aria-label', label);
    },
  });
  const saveConnectionButton = button('Сохранить и проверить', { variant: 'primary', icon: 'check' });
  const connectionStatus = h('div', { attrs: { 'aria-live': 'polite', id: 'settings-connection-status' } });
  const markConnectionInvalid = (input: HTMLInputElement, invalid: boolean): void => {
    if (invalid) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', 'settings-connection-status');
    } else {
      input.removeAttribute('aria-invalid');
      if (input.getAttribute('aria-describedby') === 'settings-connection-status') input.removeAttribute('aria-describedby');
    }
  };
  // SSO sessions are short-lived and tenant-scoped; the API key stays available
  // as the long-lived alternative (and the only way to use a platform key).
  const ssoNotice = ctx.credentials.ssoToken
    ? alert(
        'info',
        'Вы вошли через SSO',
        'Панель использует короткоживущую SSO-сессию администратора (Bearer). Чтобы вернуться к доступу по API-ключу, введите ключ ниже — SSO-сессия будет завершена.',
      )
    : null;

  const connectionCard = card({
    title: t('settings.connection'),
    subtitle: t('settings.connectionHint'),
    body: h(
      'div',
      { class: 'stack' },
      ssoNotice,
      formGrid(
        field('Адрес сервера', serverInput, {
          hint: localDev ? 'Например, http://localhost:8787.' : 'Например, https://calls.example.com — адрес вашего сервера AGIL Calls.',
        }),
        field('API-ключ', h('div', { class: 'key-row' }, keyInput, revealKey), {
          hint: ctx.credentials.ssoToken
            ? 'Необязательно, пока действует SSO-сессия. Ключ организации выдаёт администратор.'
            : localDev
              ? 'Демо-сервер принимает dev-key. Ключ не пишется в логи и не покидает ваш сервер.'
              : 'Ключ организации выдаёт администратор. Ключ не пишется в логи и не покидает ваш сервер.',
        }),
      ),
      h(
        'div',
        { class: 'actions' },
        saveConnectionButton,
        h('span', { class: 'spacer' }),
        h('span', { class: 'notice', text: `Организация: ${ctx.tenantId}` }),
      ),
      connectionStatus,
    ),
  });

  saveConnectionButton.addEventListener('click', () => {
    void (async () => {
      const apiKey = keyInput.value.trim();
      const urlError = validateServerUrl(serverInput.value);
      markConnectionInvalid(serverInput, Boolean(urlError));
      if (urlError) {
        connectionStatus.replaceChildren(alert('danger', 'Проверьте адрес сервера', urlError));
        serverInput.focus();
        return;
      }
      const serverUrl = normalizeBaseUrl(serverInput.value);
      if (!apiKey) {
        markConnectionInvalid(keyInput, true);
        connectionStatus.replaceChildren(alert('danger', 'Нужен API-ключ', 'Введите ключ и повторите.'));
        keyInput.focus();
        return;
      }
      markConnectionInvalid(keyInput, false);
      const changed = serverUrl !== ctx.credentials.serverUrl || apiKey !== ctx.credentials.apiKey || Boolean(ctx.credentials.ssoToken);
      setButtonLoading(saveConnectionButton, true);
      connectionStatus.replaceChildren();
      try {
        await ctx.saveConnection({ serverUrl, apiKey });
        if (destroyed) return;
        if (changed) {
          ctx.toast('Подключение работает', 'success');
          ctx.reload();
          return;
        }
        serverInput.value = ctx.credentials.serverUrl;
        connectionStatus.replaceChildren(
          alert('success', 'Подключение работает', `Организация «${ctx.tenantId}», сервер ${ctx.credentials.serverUrl}.`),
        );
      } catch (error) {
        const info = describeError(error);
        const unauthorized = error instanceof ApiError && (error.unauthorized || error.status === 401 || error.status === 403);
        if (unauthorized) {
          markConnectionInvalid(keyInput, true);
          keyInput.focus();
        }
        connectionStatus.replaceChildren(alert('danger', info.title, [info.message, info.hint].filter(Boolean).join(' ')));
      } finally {
        setButtonLoading(saveConnectionButton, false);
      }
    })();
  });

  /* --------------------------- embed generator -------------------------- */
  let roomId = '';
  let token = '';
  let tokenDraftRevision = 0;
  let scheme = 'auto';
  let tokenName = 'Гость';
  let tokenRole = 'guest';
  let embedChat: 'server' | 'builtin' | 'external' | 'hidden' = 'server';
  let embedChrome: 'server' | 'full' | 'compact' | 'none' = 'server';
  let embedResume = false;
  const selectedFeatures = new Set<FeatureKey>(['chat', 'screenShare']);

  const roomSelect = h('select', { class: 'select', attrs: { 'aria-label': 'Комната для встраивания' } });
  const tokenInput = h('textarea', { class: 'textarea', attrs: { rows: '2', placeholder: 'Токен доступа (JWT) — можно сгенерировать кнопкой ниже' } });
  tokenInput.value = '';
  const nameInput = textInput({
    value: tokenName,
    onInput: (value) => {
      tokenName = value;
      tokenDraftRevision++;
    },
  });
  const roleSelect = selectInput(ROLES, {
    value: tokenRole,
    onChange: (value) => {
      tokenRole = value;
      tokenDraftRevision++;
    },
  });
  const schemeSelect = selectInput(SCHEMES, {
    value: scheme,
    onChange: (value) => {
      scheme = value;
      renderSnippets();
    },
  });
  const embedChatSelect = selectInput(
    [
      { value: 'server', label: 'Как в организации' },
      { value: 'builtin', label: 'Встроенный чат (builtin)' },
      { value: 'external', label: 'Чат компании (external)' },
      { value: 'hidden', label: 'Без чата (hidden)' },
    ],
    {
      value: 'server',
      onChange: (value) => {
        embedChat = value as typeof embedChat;
        renderSnippets();
      },
    },
  );
  const embedChromeSelect = selectInput(
    [
      { value: 'server', label: 'Как в организации' },
      { value: 'full', label: 'Полный интерфейс (full)' },
      { value: 'compact', label: 'Компактная панель (compact)' },
      { value: 'none', label: 'Без шапки и фона (none)' },
    ],
    {
      value: 'server',
      onChange: (value) => {
        embedChrome = value as typeof embedChrome;
        renderSnippets();
      },
    },
  );

  const snippetsHost = h('div', { class: 'stack' });
  const previewHost = h('div', { class: 'stack' });
  let cancelPreview = (): void => {};
  const behaviorHost = h('div');
  const mediaHost = h('div');
  const sttHost = h('div', { attrs: { 'data-stt-status': '', 'aria-live': 'polite' } });
  const brandingHost = h('div');

  const currentRoom = (): string => roomSelect.value || roomId;

  const buildSdkSnippet = (): string => {
    const serverUrl = ctx.credentials.serverUrl;
    const lines = [
      `<script src="${serverUrl}/sdk/agilframe.js"></script>`,
      `<div id="agil-call" style="height: 600px"></div>`,
      `<script>`,
      `  AgilFrame.mount('#agil-call', {`,
      `    serverUrl: ${JSON.stringify(serverUrl)},`,
      `    room: ${JSON.stringify(currentRoom() || 'test-room')},`,
    ];
    if (token.trim()) lines.push(`    token: ${JSON.stringify(token.trim())},`);
    lines.push(`    tenantId: ${JSON.stringify(ctx.tenantId)},`);
    lines.push(`    theme: { scheme: ${JSON.stringify(scheme)} },`);
    const configParts: string[] = [];
    if (selectedFeatures.size > 0) {
      configParts.push(`      features: {`);
      for (const key of selectedFeatures) configParts.push(`        ${key}: true,`);
      configParts.push(`      },`);
    }
    if (embedChat !== 'server') configParts.push(`      session: { chat: { ui: ${JSON.stringify(embedChat)} } },`);
    const layout = [
      ...(embedChrome === 'server' ? [] : [`chrome: ${JSON.stringify(embedChrome)}`]),
      ...(embedResume ? ['persistAcrossPages: true'] : []),
    ];
    if (layout.length) configParts.push(`      layout: { ${layout.join(', ')} },`);
    if (configParts.length > 0) {
      lines.push(`    config: {`, ...configParts, `    },`);
    }
    if (embedResume) lines.push(`    resume: true,`);
    lines.push(`  });`, `</script>`);
    return lines.join('\n');
  };

  const buildIframeUrl = (): string => {
    const serverUrl = ctx.credentials.serverUrl;
    const params = new URLSearchParams();
    params.set('server', serverUrl);
    params.set('room', currentRoom() || 'test-room');
    if (token.trim()) params.set('token', token.trim());
    params.set('tenant', ctx.tenantId);
    params.set('theme', scheme);
    params.set('lang', 'ru');
    if (embedChat !== 'server') params.set('chat', embedChat);
    if (embedChrome !== 'server') params.set('layout', embedChrome);
    if (embedResume) params.set('resume', '1');
    return `${serverUrl}/embed.html?${params.toString()}`;
  };

  const buildIframeSnippet = (): string => {
    return [
      `<iframe`,
      `  src="${buildIframeUrl()}"`,
      `  width="100%" height="640"`,
      `  style="border: 0; border-radius: 12px"`,
      `  allow="camera; microphone; display-capture"`,
      `  title="AGIL Calls"`,
      `></iframe>`,
    ].join('\n');
  };

  const renderSnippets = (): void => {
    snippetsHost.replaceChildren(
      codeBlock(buildSdkSnippet(), { title: 'SDK · agil-calls.js' }),
      codeBlock(buildIframeSnippet(), { title: 'iframe · embed.html' }),
    );
  };

  const updateRoomOptions = (): void => {
    roomSelect.replaceChildren();
    if (rooms.length === 0) {
      roomSelect.appendChild(h('option', { text: 'Нет комнат — создайте в разделе «Комнаты»', attrs: { value: '' } }));
      roomSelect.disabled = true;
      return;
    }
    roomSelect.disabled = false;
    for (const room of rooms) {
      const name = room.room.name || room.room.id;
      const shortName = name.length > 24 ? `${name.slice(0, 23)}…` : name;
      roomSelect.appendChild(
        h('option', {
          text: `${shortName} · ${room.room.id.slice(0, 6)}`,
          attrs: { value: room.room.id, title: `${name} · ${room.room.id}` },
        }),
      );
    }
    roomId = rooms[0]?.room.id ?? '';
    roomSelect.value = roomId;
    const first = rooms[0];
    roomSelect.title = first ? `${first.room.name || first.room.id} · ${first.room.id}` : '';
  };
  roomSelect.addEventListener('change', () => {
    tokenDraftRevision++;
    roomId = roomSelect.value;
    token = '';
    tokenInput.value = '';
    cancelPreview();
    previewHost.replaceChildren();
    const selected = rooms.find((room) => room.room.id === roomId);
    roomSelect.title = selected ? `${selected.room.name || selected.room.id} · ${selected.room.id}` : '';
    renderSnippets();
  });
  tokenInput.addEventListener('input', () => {
    tokenDraftRevision++;
    token = tokenInput.value;
    renderSnippets();
  });

  const generateToken = button('Сгенерировать токен', {
    variant: 'ghost',
    size: 'sm',
    icon: 'key',
    onClick: () => {
      void (async () => {
        const targetRoom = currentRoom();
        if (!targetRoom) {
          ctx.toast('Сначала создайте комнату', 'warning');
          return;
        }
        if (!tokenName.trim()) {
          ctx.toast('Укажите имя участника', 'warning');
          return;
        }
        const draftRevision = tokenDraftRevision;
        const isCurrent = () => !destroyed && draftRevision === tokenDraftRevision && targetRoom === currentRoom();
        setButtonLoading(generateToken, true);
        try {
          const response = await ctx.api.createToken({
            tenantId: ctx.tenantId,
            roomId: targetRoom,
            participant: { name: tokenName.trim(), role: tokenRole as 'guest' | 'moderator' | 'host' },
            ttlSec: 3600,
          });
          if (!isCurrent()) return;
          token = response.token;
          tokenInput.value = response.token;
          renderSnippets();
          ctx.toast('Токен сгенерирован (1 час)', 'success');
        } catch (error) {
          if (isCurrent()) toastError(ctx, error);
        } finally {
          setButtonLoading(generateToken, false);
        }
      })();
    },
  });

  const featuresHost = h('div', { class: 'checkbox-grid' });
  for (const key of EMBED_FEATURES) {
    const featureNode = checkboxField({
      label: featureLabel(key),
      checked: selectedFeatures.has(key),
      onChange: (checked) => {
        if (checked) selectedFeatures.add(key);
        else selectedFeatures.delete(key);
        renderSnippets();
      },
    });
    featureNode.title = `features.${key}`;
    featuresHost.appendChild(featureNode);
  }

  const checkIframe = button('Проверить iframe', {
    variant: 'ghost',
    size: 'sm',
    icon: 'play',
    onClick: () => {
      if (!currentRoom()) {
        ctx.toast('Сначала выберите комнату', 'warning');
        return;
      }
      const src = buildIframeUrl();
      cancelPreview();
      const status = h('div', { attrs: { 'aria-live': 'polite' } });
      const frame = h('iframe', {
        attrs: {
          src,
          title: 'Предпросмотр встраивания',
          style: 'width:100%;height:420px;border:1px solid var(--agil-color-border);border-radius:var(--agil-radius-md);background:var(--agil-color-background-alt)',
          allow: 'camera; microphone; display-capture',
        },
      });
      const events = new AbortController();
      const origin = new URL(frame.src).origin;
      const timeout = window.setTimeout(() => {
        status.replaceChildren(
          alert(
            'warning',
            'iframe не загрузился',
            'Возможные причины: сервер запрещает встраивание (CSP frame-ancestors или X-Frame-Options), неверный адрес или сервер недоступен. Панель должна открываться с того же адреса (origin); внешние сайты добавьте в «Интеграции → Разрешённые origin».',
          ),
        );
      }, 10000);
      cancelPreview = () => {
        events.abort();
        window.clearTimeout(timeout);
      };
      window.addEventListener('message', (event) => {
        if (event.source !== frame.contentWindow || event.origin !== origin) return;
        if (event.data?.type !== 'agil:ready') return;
        cancelPreview();
        status.replaceChildren(alert('success', 'Виджет готов', 'Проверьте вход в комнату в окне ниже.'));
      }, { signal: events.signal });
      previewHost.replaceChildren(status, frame);
    },
  });

  const embedCard = card({
    title: t('settings.embed'),
    subtitle: t('settings.embedHint'),
    body: h(
      'div',
      { class: 'stack' },
      roomsError !== null
        ? alert('warning', 'Список комнат недоступен', 'Проверьте, что сервер запущен. Комнату можно будет выбрать после загрузки списка.')
        : null,
      formGrid(
        field('Комната', roomSelect),
        field('Схема темы', schemeSelect),
        field('Имя для токена', nameInput),
        field('Роль токена', roleSelect),
        field('Чат во встраивании', embedChatSelect, { hint: 'Встроенный чат — наш, внешний — чат компании, без чата — чат скрыт.' }),
        field('Оформление окна', embedChromeSelect, { hint: 'Без шапки и фона — окно вписывается в страницу компании.' }),
      ),
      h('div', { class: 'row' }, generateToken, h('span', { class: 'notice', text: 'Токен действует 1 час. Для рабочего сервера выпускайте его на своём сервере.' })),
      field('Токен (вставьте вручную или сгенерируйте)', tokenInput),
      checkboxField({
        label: 'Восстанавливать звонок после перехода по страницам (resume)',
        description: 'Добавляет resume:true / ?resume=1 — звонок восстанавливается после перехода по страницам (layout.persistAcrossPages).',
        checked: embedResume,
        onChange: (checked) => {
          embedResume = checked;
          renderSnippets();
        },
      }),
      h('p', { class: 'notice', text: 'Тема берётся с сервера; схема только переключает светлую, тёмную и системную. chat/layout/resume передаются в код как подсказки, полный конфиг приходит с сервера.' }),
      h('div', { class: 'section-title', text: 'Функции звонка в коде SDK (config.features)' }),
      featuresHost,
      snippetsHost,
      h('div', { class: 'section-title', text: 'Предпросмотр' }),
      h('div', { class: 'actions' }, checkIframe),
      previewHost,
      alert(
        'warning',
        'CSP и iframe',
        'Сервер добавляет защитные заголовки и может запретить встраивание (CSP frame-ancestors). Для внешних сайтов добавьте их origin в «Интеграции». Для локальной проверки откройте демо-страницу по тому же адресу (origin).',
      ),
    ),
  });

  /* ------------------- embedding behavior / chat modes ------------------ */

  const renderBehaviorCard = (): HTMLElement => {
    if (configError !== null) {
      return errorState(configError, () => void loadData());
    }
    if (!behaviorDraft) {
      return loadingPanel('Загружаем настройки организации…');
    }
    const draft = behaviorDraft;
    const chat = draft.session.chat;
    const layout = draft.layout;
    let savedChat = { ...chat };
    let savedLayout = { ...layout, minimized: { ...layout.minimized } };

    const providerInput = textInput({
      value: chat.externalProviderName,
      placeholder: 'corp-messenger',
      disabled: chat.ui !== 'external',
      onInput: (value) => {
        chat.externalProviderName = value.trim();
      },
    });
    const chatUiSelect = selectInput(
      [
        { value: 'builtin', label: 'Встроенный чат AGIL Calls (builtin)' },
        { value: 'external', label: 'Внешний чат компании (external)' },
        { value: 'hidden', label: 'Без чата (hidden)' },
      ],
      {
        value: chat.ui,
        onChange: (value) => {
          chat.ui = value as typeof chat.ui;
          providerInput.disabled = value !== 'external';
        },
      },
    );
    const chromeSelect = selectInput(
      [
        { value: 'full', label: 'Полный интерфейс: шапка и фон (full)' },
        { value: 'compact', label: 'Компактная панель (compact)' },
        { value: 'none', label: 'Только видео и кнопки (none)' },
      ],
      {
        value: layout.chrome,
        onChange: (value) => {
          layout.chrome = value as typeof layout.chrome;
        },
      },
    );
    const minimizeModeSelect = selectInput(
      [
        { value: 'bar', label: 'Плавающая панель (bar)' },
        { value: 'bubble', label: 'Кружок (bubble)' },
      ],
      {
        value: layout.minimized.mode,
        onChange: (value) => {
          layout.minimized.mode = value as typeof layout.minimized.mode;
        },
      },
    );
    const minimizePositionSelect = selectInput(
      [
        { value: 'bottom-right', label: 'справа снизу' },
        { value: 'bottom-left', label: 'слева снизу' },
        { value: 'top-right', label: 'справа сверху' },
        { value: 'top-left', label: 'слева сверху' },
      ],
      {
        value: layout.minimized.position,
        onChange: (value) => {
          layout.minimized.position = value as typeof layout.minimized.position;
        },
      },
    );

    const saveBehavior = button('Сохранить встраивание', { variant: 'primary', icon: 'check' });
    const save = (): void => {
      void (async () => {
        const nextChat = { ...chat };
        const nextLayout = { ...layout, minimized: { ...layout.minimized } };
        const { api, tenantId } = ctx;
        setButtonLoading(saveBehavior, true);
        try {
          const patch: TenantConfigPatch = {
            session: { chat: changedFields(savedChat, nextChat) },
            layout: {
              ...changedFields(savedLayout, nextLayout),
              minimized: changedFields(savedLayout.minimized, nextLayout.minimized),
            },
          };
          const result = await guardedSave('config', patch, 'сохранить встраивание и поведение звонка', async () =>
            api.patchConfig(tenantId, patch),
          );
          if (!result.allowed) return;
          if (destroyed) return;
          savedChat = nextChat;
          savedLayout = nextLayout;
          config = result.value ?? config;
          window.dispatchEvent(new CustomEvent('agil-config-updated'));
          ctx.toast('Настройки встраивания сохранены', 'success');
        } catch (error) {
          toastError(ctx, error);
        } finally {
          setButtonLoading(saveBehavior, false);
        }
      })();
    };
    saveBehavior.addEventListener('click', save);

    return h(
      'div',
      { class: 'stack' },
      alert(
        'info',
        'Варианты чата в звонке',
        'Внешний чат (external): виджет не рисует чат, сообщения уходят на сайт компании, а панель показывает историю и позволяет отправлять системные сообщения через API. Без чата (hidden): чат полностью выключен — компания использует свой мессенджер рядом со звонком.',
      ),
      formGrid(
        field('Чат (session.chat.ui)', chatUiSelect),
        field('Имя внешнего сервиса (externalProviderName)', providerInput, { hint: 'Название внешнего сервиса для документации и интерфейса.' }),
        field('Оформление окна (layout.chrome)', chromeSelect, { hint: 'Без шапки и фона — окно вписывается в страницу компании.' }),
      ),
      h(
        'div',
        { class: 'checkbox-grid' },
        checkboxField({
          label: 'Внедрение сообщений со страницы (allowHostInjection)',
          description: 'Страница компании может добавлять сообщения в чат звонка (postMessage/SDK).',
          checked: chat.allowHostInjection,
          onChange: (checked) => {
            chat.allowHostInjection = checked;
          },
        }),
        checkboxField({
          label: 'Системные сообщения (allowSystemMessages)',
          description: 'Разрешить системные сообщения от сервиса компании (бот, CRM).',
          checked: chat.allowSystemMessages,
          onChange: (checked) => {
            chat.allowSystemMessages = checked;
          },
        }),
      ),
      h('div', { class: 'section-title', text: 'Мини-окно звонка' }),
      h('p', {
        class: 'notice',
        text: '«Свернуть звонок»: плавающая панель или кружок поверх приложения компании; звук и звонок продолжаются, развернуть можно кликом. В Chrome дополнительно доступен режим «картинка в картинке» (Document PiP).',
      }),
      checkboxField({
        label: 'Сворачивать в мини-окно (minimized.enabled)',
        description: 'Разрешить сворачивание в мини-окно.',
        checked: layout.minimized.enabled,
        onChange: (checked) => {
          layout.minimized.enabled = checked;
        },
      }),
      formGrid(field('Вид мини-окна (minimized.mode)', minimizeModeSelect), field('Положение мини-окна (minimized.position)', minimizePositionSelect)),
      h(
        'div',
        { class: 'checkbox-grid' },
        checkboxField({
          label: 'Своё видео в мини-окне (minimized.showSelfView)',
          description: 'Показывать своё видео в мини-окне.',
          checked: layout.minimized.showSelfView,
          onChange: (checked) => {
            layout.minimized.showSelfView = checked;
          },
        }),
        checkboxField({
          label: 'Кнопки управления в мини-окне (minimized.keepControls)',
          description: 'Оставить микрофон, камеру и завершение звонка в мини-окне.',
          checked: layout.minimized.keepControls,
          onChange: (checked) => {
            layout.minimized.keepControls = checked;
          },
        }),
      ),
      h('div', { class: 'section-title', text: 'Навигация по страницам' }),
      h(
        'div',
        { class: 'checkbox-grid' },
        checkboxField({
          label: 'Восстанавливать звонок после перехода (layout.persistAcrossPages)',
          description: 'resume()/mount({resume:true}) поднимает звонок после перехода по страницам или перезагрузки.',
          checked: layout.persistAcrossPages,
          onChange: (checked) => {
            layout.persistAcrossPages = checked;
          },
        }),
        checkboxField({
          label: 'Наследовать стили страницы (layout.inheritHostStyles)',
          description: 'Наследовать шрифты и цвета страницы компании, где не заданы свои токены.',
          checked: layout.inheritHostStyles,
          onChange: (checked) => {
            layout.inheritHostStyles = checked;
          },
        }),
      ),
      h('div', { class: 'actions' }, saveBehavior),
    );
  };

  const behaviorCard = card({
    title: t('settings.behavior'),
    subtitle: t('settings.behaviorHint'),
    subtitleTitle: 'session.chat · layout.chrome · minimized · persistAcrossPages',
    body: behaviorHost,
  });

  /* ------------------------- media processing -------------------------- */

  const renderMediaCard = (): HTMLElement => {
    if (configError !== null) return errorState(configError, () => void loadData());
    if (!mediaDraft) return loadingPanel('Загружаем настройки обработки медиа…');
    const draft = mediaDraft;
    const modeSelect = selectInput(
      [
        { value: 'client-only', label: 'На устройстве пользователя (рекомендуется)' },
        { value: 'server-assisted', label: 'Серверная (экспериментально)' },
      ],
      {
        value: draft.mode,
        onChange: (value) => {
          draft.mode = value as TenantConfig['mediaProcessing']['mode'];
          updateMediaControls();
        },
      },
    );
    const serverDisabled = draft.mode !== 'server-assisted';
    const videoField = checkboxField({
      label: 'Серверное видео (video)',
      description: 'Декодирование/обработка видео на сервере. Требует CPU/GPU и увеличивает задержку.',
      checked: draft.video,
      disabled: serverDisabled,
      onChange: (checked) => { draft.video = checked; },
    });
    const audioField = checkboxField({
      label: 'Серверное аудио (audio)',
      description: 'Микширование/обработка звука на сервере. Требует CPU; при перегрузке качество падает.',
      checked: draft.audio,
      disabled: serverDisabled,
      onChange: (checked) => { draft.audio = checked; },
    });
    const egressField = checkboxField({
      label: 'Egress / облачная запись (egress)',
      description: 'Отдельный worker записи и стриминга. Влияет на стоимость и надёжность.',
      checked: draft.egress,
      disabled: serverDisabled,
      onChange: (checked) => { draft.egress = checked; },
    });
    const transcodeField = checkboxField({
      label: 'Транскодирование (transcoding)',
      description: 'Перекодирование кодеков/разрешений. По умолчанию выключено: SFU только пересылает медиа.',
      checked: draft.transcoding,
      disabled: serverDisabled,
      onChange: (checked) => { draft.transcoding = checked; },
    });
    const providerSelect = selectInput(
      [
        { value: 'none', label: 'Без внешнего провайдера (none)' },
        { value: 'livekit-egress', label: 'LiveKit Egress (livekit-egress)' },
        { value: 'external', label: 'Внешний провайдер (external)' },
      ],
      {
        value: draft.provider,
        onChange: (value) => { draft.provider = value as TenantConfig['mediaProcessing']['provider']; },
      },
    );
    const egressNode = textInput({
      value: draft.egressNodeId ?? '',
      spellcheck: false,
    });
    egressNode.maxLength = 64;
    const serverControls = [
      ...[videoField, audioField, egressField, transcodeField].map((field) => field.querySelector('input')!),
      providerSelect,
    ];
    const updateMediaControls = (saving = false): void => {
      modeSelect.disabled = saving;
      egressNode.disabled = saving;
      for (const control of serverControls) control.disabled = saving || draft.mode !== 'server-assisted';
    };
    updateMediaControls();
    const statusHost = h('div', { class: 'stack' });
    const renderStatus = (): void => {
      statusHost.replaceChildren();
      if (mediaStatusError !== null) {
        if (mediaStatusError instanceof ApiError && [404, 405, 501].includes(mediaStatusError.status)) {
          statusHost.appendChild(alert('warning', 'Статус серверной обработки появится после обновления сервера', 'GET /v1/admin/media/processing пока недоступен. Конфигурация mediaProcessing сохраняется; бейджи включатся после деплоя.'));
        } else {
          statusHost.appendChild(alert('warning', 'Не удалось получить статус медиа-сервера', describeError(mediaStatusError).message));
        }
      } else if (mediaStatus) {
        statusHost.appendChild(
          h(
            'div',
            { class: 'actions' },
            badge(mediaStatus.serverProcessingActive ? 'Политика разрешает серверную обработку' : 'Обработка на устройствах', mediaStatus.serverProcessingActive ? 'warning' : 'success', { dot: true }),
            badge(mediaStatus.sfuForwardingOnly ? 'SFU пересылает медиа' : 'Медиа передаётся между участниками', 'neutral'),
            badge(mediaStatus.egressConfigured ? 'Провайдер Egress указан в политике' : 'Провайдер Egress не указан в политике', 'neutral'),
            badge(mediaStatus.misconfigured ? 'Конфигурация с ошибкой' : 'Конфигурация корректна', mediaStatus.misconfigured ? 'danger' : 'success'),
          ),
        );
      } else {
        statusHost.appendChild(h('p', { class: 'notice', text: 'Загружаем статус серверной обработки…' }));
      }
    };
    renderStatus();
    const saveMedia = button('Сохранить обработку медиа', { variant: 'primary', icon: 'check' });
    saveMedia.addEventListener('click', () => {
      void (async () => {
        setButtonLoading(saveMedia, true);
        updateMediaControls(true);
        const next = { ...draft, egressNodeId: egressNode.value.trim() };
        const { api, tenantId } = ctx;
        const risky = next.mode === 'server-assisted' || next.video || next.audio || next.egress || next.transcoding;
        try {
          if (risky) {
            const result = await guardedSave('config', { mediaProcessing: next }, `включить серверную обработку медиа (${next.mode})`, async () =>
              api.patchConfig(tenantId, { mediaProcessing: next }),
            );
            if (!result.allowed) return;
            config = result.value ?? config;
          } else {
            config = await api.patchConfig(tenantId, { mediaProcessing: next });
          }
          if (destroyed) return;
          draft.egressNodeId = next.egressNodeId;
          ctx.toast('Настройки обработки медиа сохранены', 'success');
          window.dispatchEvent(new CustomEvent('agil-config-updated'));
          try {
            mediaStatus = await api.mediaProcessing();
            mediaStatusError = null;
          } catch (error) {
            mediaStatusError = error;
          }
          if (!destroyed) renderStatus();
        } catch (error) {
          toastError(ctx, error);
        } finally {
          setButtonLoading(saveMedia, false);
          updateMediaControls();
        }
      })();
    });
    return h(
      'div',
      { class: 'stack' },
      alert('info', 'Медиа обрабатывается на клиентах', 'По умолчанию видео и аудио обрабатываются на устройствах участников; сервер/SFU только пересылает поток. Серверная обработка (egress, транскодирование, декодирование) — экспериментальная опция: ей нужны CPU/GPU, она влияет на стоимость, задержку и надёжность.'),
      formGrid(field('Режим обработки (mediaProcessing.mode)', modeSelect)),
      h('div', { class: 'checkbox-grid' }, videoField, audioField, egressField, transcodeField),
      field('Провайдер обработки (mediaProcessing.provider)', providerSelect),
      field(t('settings.egressNode'), egressNode, { hint: t('settings.egressNodeHint') }),
      h('p', { class: 'notice', text: 'В режиме обработки на устройствах видео и звук передаются между участниками напрямую или через SFU. Параметры ниже описывают политику организации. Доступность воркера записи проверяется в разделе «Записи».' }),
      statusHost,
      h('div', { class: 'actions' }, saveMedia),
    );
  };

  const mediaCard = card({
    title: t('settings.media'),
    subtitle: t('settings.mediaHint'),
    subtitleTitle: 'mediaProcessing · client-only по умолчанию · egress/transcoding выключены',
    body: mediaHost,
  });

  /* ----------------------- STT / translation status -------------------- */

  const renderSttCard = (): HTMLElement => {
    if (sttStatusError !== null) {
      if (sttStatusError instanceof ApiError && [404, 405, 501].includes(sttStatusError.status)) {
        return alert(
          'warning',
          t('settings.sttUnsupported'),
          t('settings.sttUnsupportedHint'),
        );
      }
      return alert('warning', t('settings.sttLoadError'), t('settings.sttRetryHint'));
    }
    if (!sttStatus) return h('p', { class: 'notice', text: t('settings.sttLoading') });
    const status = sttStatus;
    const provider = status.stt.provider;
    const sttReady = status.stt.configured && status.stt.available !== false && status.stt.nodeAvailable !== false;
    const sttLabel = provider === 'none' || provider === 'browser'
      ? t(`settings.sttProvider.${provider}`)
      : t(`settings.sttProvider.${provider}.${sttReady ? 'available' : 'unavailable'}`);
    const sttTone = provider === 'local' ? (sttReady ? 'success' : 'warning')
      : provider === 'remote' ? (sttReady ? 'info' : 'warning') : 'neutral';
    const rows = h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'actions' },
        badge(sttLabel, sttTone, { dot: true }),
        status.stt.ffmpeg === false ? badge('ffmpeg нет: только WAV', 'warning') : null,
        badge(
          `Перевод: ${status.translation.configured ? 'готов' : 'не готов'}`,
          status.translation.configured ? 'success' : 'neutral',
          { dot: true },
        ),
        badge(`Приватность: ${status.privacyMode === 'local' ? 'local-only' : 'standard'}`, status.privacyMode === 'local' ? 'warning' : 'neutral'),
        badge(
          `Consent: ${status.consent.required ? 'обязателен' : 'не требуется'}`,
          status.consent.required ? 'warning' : 'success',
        ),
      ),
      status.stt.engine ? h('p', { class: 'notice', text: `STT: ${status.stt.engine}${status.stt.model ? ` · ${status.stt.model}` : ''}` }) : null,
      status.stt.nodeAvailable === false
        ? alert('warning', t('settings.sttNodeUnavailable'), t('settings.sttNodeUnavailableHint'))
        : null,
      status.stt.reason
        ? alert(
            status.stt.available === false ? 'warning' : 'info',
            status.stt.available === false ? 'STT недоступен' : 'STT: ограничение',
            status.stt.reason,
          )
        : null,
      status.translation.engine
        ? h('p', { class: 'notice', text: `Перевод: ${status.translation.engine}${status.translation.model ? ` · ${status.translation.model}` : ''}` })
        : null,
      status.translation.reason ? alert('warning', 'Перевод недоступен', status.translation.reason) : null,
      status.translation.nonCommercial
        ? alert('warning', 'NLLB-200 больше не поддерживается', 'Установите локальную пару OPUS-MT и обновите настройки Core.')
        : null,
      h('p', {
        class: 'notice',
        text: `Retention: ${status.consent.retentionSec > 0 ? `${status.consent.retentionSec} с` : 'до конца жизни комнаты'} · перевод использует локальные файлы · загрузка весов STT управляется AGIL_STT_ALLOW_DOWNLOAD`,
      }),
      h('ul', { class: 'notice' }, ...status.caveats.map((caveat) => h('li', { text: caveat }))),
    );
    return rows;
  };

  const refreshStt = button(t('settings.refreshStt'), {
    icon: 'refresh',
    onClick: () => void loadStt(),
  });
  async function loadStt(): Promise<void> {
    if (refreshStt.getAttribute('aria-disabled') === 'true') return;
    refreshStt.setAttribute('aria-disabled', 'true');
    sttHost.setAttribute('aria-busy', 'true');
    try {
      sttStatus = await ctx.api.sttStatus();
      sttStatusError = null;
    } catch (error) {
      sttStatus = null;
      sttStatusError = error;
    } finally {
      if (!destroyed) {
        sttHost.replaceChildren(renderSttCard());
        sttHost.removeAttribute('aria-busy');
        refreshStt.removeAttribute('aria-disabled');
      }
    }
  }
  const sttCard = card({
    title: t('settings.sttTitle'),
    subtitle: t('settings.sttSubtitle'),
    subtitleTitle: 'GET /v1/admin/stt · без ключей и абсолютных путей',
    actions: [refreshStt],
    body: sttHost,
  });

  /* ----------------------------- mascot / brand ------------------------ */

  const renderBrandingCard = (): HTMLElement => {
    if (configError !== null) return errorState(configError, () => void loadData());
    if (!config) return loadingPanel('Загружаем оформление организации…');
    const branding = config.branding;
    const bundled = bundledMascot(ctx);
    const presetOptions = [
      { value: '', label: 'Все анимации (по умолчанию)' },
      ...MASCOT_EXPRESSIONS.map((expression) => ({
        value: bundled.expressions[expression.id] ?? '',
        label: `${expression.label} · ${expression.id}.webp`,
      })),
    ];
    const enabledInput = h('input', { attrs: { type: 'checkbox' } });
    enabledInput.checked = branding.mascotEnabled !== false;
    const storedName = branding.mascotName?.trim() ?? '';
    // The old default «Аги» is the product name «Agil» since the rename.
    const displayName = !storedName || storedName === 'Аги' ? bundled.name : storedName;
    const nameInput = textInput({ value: displayName, placeholder: 'Agil' });
    nameInput.maxLength = 40;
    const presetSelect = selectInput(presetOptions, { value: '' });
    const expressions = branding.mascotExpressions ?? {};
    const customUrlInput = textInput({ value: branding.mascotUrl ?? '', placeholder: 'https://cdn.example.com/mascot.webp' });
    const previewImg = h('img', { class: 'mascot-brand-preview', attrs: { alt: 'Предпросмотр помощника' } });
    const previewFallback = h('span', { class: 'mascot-brand-fallback', text: 'Нет изображения — покажем аватар' });
    const previewWrap = h('div', { class: 'mascot-brand-preview-wrap' }, previewImg, previewFallback);
    const previewName = h('span', { class: 'notice', text: `Имя в панели: ${displayName}` });
    const saveButton = button('Сохранить помощника', { variant: 'primary', icon: 'check' });
    const statusHost = h('div', { attrs: { 'aria-live': 'polite' } });

    const currentSource = (): string => {
      if (customUrlInput.value.trim()) return customUrlInput.value.trim();
      if (presetSelect.value) return presetSelect.value;
      return expressions.wave ?? bundled.expressions.wave ?? '';
    };
    const refreshPreview = (): void => {
      const source = currentSource();
      previewFallback.hidden = Boolean(source);
      previewImg.hidden = !source;
      if (source) previewImg.src = source;
      previewName.textContent = `Имя в панели: ${nameInput.value.trim() || bundled.name}`;
    };
    presetSelect.addEventListener('change', () => {
      if (presetSelect.value) customUrlInput.value = '';
      refreshPreview();
    });
    customUrlInput.addEventListener('input', () => {
      if (customUrlInput.value.trim()) presetSelect.value = '';
      refreshPreview();
    });
    nameInput.addEventListener('input', refreshPreview);
    previewImg.addEventListener('error', () => {
      previewImg.hidden = true;
      previewFallback.hidden = false;
    });
    refreshPreview();

    saveButton.addEventListener('click', () => {
      void (async () => {
        const source = currentSource();
        if (source && !/^(https?:\/\/|\/)/i.test(source)) {
          statusHost.replaceChildren(alert('danger', 'Некорректный URL', 'Нужен http(s)-URL или абсолютный путь /branding/...'));
          return;
        }
        const custom = customUrlInput.value.trim();
        const nextExpressions = custom ? (branding.mascotExpressions ?? {}) : source ? { ...expressions, wave: source } : { ...expressions };
        const patch: TenantConfigPatch = {
          branding: {
            mascotEnabled: enabledInput.checked,
            mascotName: !nameInput.value.trim() || nameInput.value.trim() === 'Аги' ? bundled.name : nameInput.value.trim(),
            mascotUrl: custom,
            mascotExpressions: nextExpressions,
          },
        };
        setButtonLoading(saveButton, true);
        statusHost.replaceChildren();
        try {
          const result = await guardedSave('config', patch, enabledInput.checked ? 'сменить помощника Agil' : 'выключить помощника Agil', async () =>
            ctx.api.patchConfig(ctx.tenantId, patch),
          );
          if (!result.allowed) return;
          config = result.value ?? config;
          window.dispatchEvent(new CustomEvent('agil-config-updated'));
          ctx.toast('Ассистент Agil сохранён', 'success');
          brandingHost.replaceChildren(renderBrandingCard());
        } catch (error) {
          const info = describeError(error);
          statusHost.replaceChildren(alert('danger', info.title, [info.message, info.hint].filter(Boolean).join(' ')));
        } finally {
          setButtonLoading(saveButton, false);
        }
      })();
    });

    return h(
      'div',
      { class: 'stack' },
      alert(
        'info',
        'Agil можно переодеть',
        'Доступные анимации: приветствие, радость, предупреждение, успех, размышление, критическое изменение. Показывайте своего помощника по ссылке или выберите встроенный вариант; имя и включение хранятся в оформлении организации.',
      ),
      h(
        'div',
        { class: 'mascot-brand-preview-row' },
        previewWrap,
        h(
          'div',
          { class: 'cell-stack' },
          h('strong', { text: displayName }),
          previewName,
          h('span', { class: 'notice', text: 'Анимация WebP · при отсутствии файла панель покажет статичный PNG/аватар.' }),
        ),
      ),
      h(
        'label',
        { class: 'checkbox-row' },
        enabledInput,
        h(
          'span',
          { class: 'checkbox-text' },
          h('span', { class: 'checkbox-title', text: 'Показывать помощника в панели' }),
          h('span', { class: 'checkbox-desc', text: 'Плавающая кнопка справа снизу; на мобильном — компактный аватар.' }),
        ),
      ),
      formGrid(
        field('Имя помощника', nameInput, { hint: 'Например, Agil. Отображается в панели и чате.' }),
        field('Встроенный вариант (приветствие)', presetSelect, { hint: 'Меняет приветственную анимацию; остальные состояния остаются из комплекта.' }),
      ),
      field('Свой URL изображения', customUrlInput, {
        hint: 'http(s)-URL или /branding/mascot/animated/....webp. Пусто — встроенный комплект.',
      }),
      h('div', { class: 'actions' }, saveButton),
      statusHost,
    );
  };

  const brandingCard = card({
    title: t('settings.branding'),
    subtitle: t('settings.brandingHint'),
    subtitleTitle: 'branding.mascotEnabled · mascotName · mascotUrl · mascotExpressions',
    body: brandingHost,
  });

  /* --------------------------- public endpoints ------------------------ */

  const endpointRows = (): HTMLElement => {
    const base = normalizeBaseUrl(serverInput.value || ctx.credentials.serverUrl);
    const baseUrl = `${base}${publicPaths.health}`;
    const rows = [
      { method: 'GET', label: 'Состояние сервера', url: baseUrl },
      { method: 'GET', label: 'Публичные STUN-серверы', url: `${base}${publicPaths.ice}` },
      { method: 'GET', label: 'Настройки организации', url: `${base}${publicPaths.roomConfig(ctx.tenantId)}` },
      { method: 'POST', label: 'Вход в комнату', url: `${base}${publicPaths.join(':roomId')}` },
      { method: 'GET', label: 'WebSocket', url: `${base.replace(/^http/, 'ws')}${publicPaths.ws}` },
    ];
    const stack = h('div', { class: 'stack' });
    for (const row of rows) {
      const linkRow = h('div', { class: 'link-row is-wrap' });
      linkRow.append(
        badge(row.method, row.method === 'GET' ? 'info' : 'primary'),
        h('span', { class: 'link-value', text: row.url, attrs: { title: row.url } }),
        copyButton(row.url, { title: `Скопировать ${row.label}`, successMessage: `${row.label}: URL скопирован` }),
      );
      stack.appendChild(linkRow);
    }
    return stack;
  };
  const endpointsHost = h('div');
  const refreshEndpoints = (): void => {
    endpointsHost.replaceChildren(endpointRows());
  };

  /* ----------------------------- docs / MCP ---------------------------- */

  const mcpHost = (() => {
    const links = publicLinks(ctx.credentials.serverUrl);
    const mcpConfig = JSON.stringify(
      {
        mcpServers: {
          'agil-calls': {
            command: 'node',
            args: ['agil/core/packages/mcp/dist/index.js'],
            env: {
              AGIL_SERVER_URL: ctx.credentials.serverUrl,
              AGIL_API_KEY: localDev ? 'dev-key' : '<ключ организации>',
              AGIL_TENANT_ID: ctx.tenantId,
            },
          },
        },
      },
      null,
      2,
    );
    const docRow = (label: string, url: string, docName?: string): HTMLElement => {
      const row = h('div', { class: 'link-row is-wrap' });
      append(
        row,
        h('span', { class: 'link-value', text: url, attrs: { title: url } }),
        copyButton(url, { title: `Скопировать ${label}` }),
        docName
          ? h(
              'a',
              { class: 'btn btn-subtle btn-sm', attrs: { href: docsRoute(docName), title: `Открыть «${label}» в панели` } },
              icon('book', 16),
              h('span', { text: 'Открыть' }),
            )
          : null,
        h('a', { class: 'btn btn-subtle btn-sm', attrs: { href: url, target: '_blank', rel: 'noopener noreferrer', title: `Открыть raw-файл ${label}` } }, icon('external', 16)),
      );
      return row;
    };
    return h(
      'div',
      { class: 'stack' },
      field('Документация API', docRow('/docs', links.apiDocs)),
      field('Спецификация OpenAPI 3.1', docRow('/openapi.json', links.openapi)),
      field('Аудит безопасности и конфиденциальности', docRow('docs/security-audit.md', links.securityAudit, 'security-audit.md')),
      field('Расширения и внешние сервисы', docRow('docs/extensibility.md', links.extensibility, 'extensibility.md')),
      field('Интеграция с мессенджером', docRow('docs/messenger.md', links.messenger, 'messenger.md')),
      field('Масштабирование и несколько серверов', docRow('docs/scaling.md', links.scaling, 'scaling.md')),
      field('План развития', docRow('docs/backlog.md', links.backlog, 'backlog.md')),
      field('Руководство интегратора (простыми словами)', docRow('docs/api-guide.md', links.apiGuide, 'api-guide.md')),
      field('Справочник API', docRow('docs/api.md', links.apiMd, 'api.md')),
      field('Контракт монорепо', docRow('docs/contract.md', links.contract, 'contract.md')),
      h('p', { class: 'notice', text: 'MCP-сервер: документация — docs/mcp.md в репозитории. Инструменты: agil_get_config, agil_create_room, agil_create_token, agil_get_embed_snippet, agil_get_openapi и др.' }),
      alert(
        'info',
        'Спецификация OpenAPI — для инструментов',
        'Спецификация OpenAPI нужна Swagger, Postman и генераторам кода. Людям — документация API (руководство, поиск, curl, коды ошибок). Руководство интегратора и справочник API — текстовые документы.',
      ),
      codeBlock(mcpConfig, { title: 'MCP · конфигурация stdio' }),
    );
  })();

  const docsCard = card({
    title: t('settings.api'),
    subtitle: t('settings.apiHint'),
    body: mcpHost,
  });

  const backupStatus = h('p', { class: 'muted', attrs: { role: 'status' } });
  const backupFile = h('input', { attrs: { type: 'file', accept: '.json,application/json', hidden: '' } });
  const exportConfig = button(t('settings.exportConfig'), { onClick: () => void downloadConfig() });
  const importConfig = button(t('settings.importConfig'), { onClick: () => backupFile.click() });
  const backupCard = card({
    title: t('settings.configBackup'),
    subtitle: t('settings.configBackupHint'),
    body: h('div', { class: 'stack' }, h('div', { class: 'actions' }, exportConfig, importConfig), backupFile, backupStatus),
  });

  async function downloadConfig(): Promise<void> {
    exportConfig.disabled = true;
    backupStatus.textContent = '';
    try {
      const latest = await ctx.api.getConfig(ctx.tenantId);
      if (destroyed) return;
      const { customDomain: _customDomain, ...branding } = latest.branding;
      const url = URL.createObjectURL(new Blob([JSON.stringify({ ...latest, branding }, null, 2)], { type: 'application/json' }));
      const link = h('a', { attrs: { href: url, download: `agil-${ctx.tenantId}-settings.json` } });
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      if (!destroyed) backupStatus.textContent = describeError(cause).message;
    } finally {
      exportConfig.disabled = false;
    }
  }

  backupFile.addEventListener('change', () => {
    const file = backupFile.files?.[0];
    backupFile.value = '';
    if (file && !importConfig.disabled) void restoreConfig(file);
  });

  async function restoreConfig(file: File): Promise<void> {
    importConfig.disabled = true;
    backupStatus.textContent = '';
    try {
      if (file.size > 1024 * 1024) throw new Error(t('settings.configFileTooLarge'));
      const value: unknown = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
      // A portable backup deliberately omits the domain managed by its own workflow.
      const parsed = tenantConfigSchema.safeParse(value);
      if (!parsed.success) throw new Error(t('settings.configFileInvalid'));
      const next = parsed.data;
      if (next.tenantId !== ctx.tenantId) throw new Error(t('settings.configWrongTenant'));
      const current = await ctx.api.getConfig(ctx.tenantId);
      if (destroyed) return;
      const confirmed = await confirmDialog({
        title: t('settings.configRestoreTitle'),
        message: t('settings.configRestoreHint', { tenant: ctx.tenantId, file: file.name }),
        confirmLabel: t('settings.configRestore'),
      });
      if (!confirmed || destroyed) return;
      const result = await guardedSave('config', next, t('settings.configRestore'), async () => {
        if (destroyed) throw new Error(t('settings.configFileInvalid'));
        return ctx.api.restoreConfig(next);
      }, { current });
      if (!result.allowed || destroyed) return;
      await loadData();
      if (destroyed) return;
      window.dispatchEvent(new CustomEvent('agil-config-updated'));
      backupStatus.textContent = t('settings.configRestored');
      ctx.toast(t('settings.configRestored'), 'success');
    } catch (cause) {
      if (!destroyed) backupStatus.textContent = cause instanceof SyntaxError
        ? t('settings.configFileInvalid') : describeError(cause).message;
    } finally {
      importConfig.disabled = false;
    }
  }

  /* ---------------------------- danger zone ---------------------------- */

  const resetCard = card({
    title: t('settings.reset'),
    subtitle: t('settings.resetHint'),
    body: h(
      'div',
      { class: 'stack' },
      alert('warning', 'Необратимо для этого браузера', 'Комнаты, политики и записи на сервере не затрагиваются. После сброса откроется экран входа.'),
      h(
        'div',
        { class: 'actions' },
        button('Сбросить настройки', {
          variant: 'danger',
          icon: 'trash',
          onClick: () => {
            void (async () => {
              const confirmed = await confirmDialog({
                title: 'Сбросить настройки панели?',
                message: 'Будут удалены сохранённые адрес сервера, API-ключ и организация. Придётся войти заново.',
                confirmLabel: 'Сбросить',
                danger: true,
              });
              if (!confirmed) return;
              resetAllSettings();
              ctx.toast('Настройки сброшены', 'success');
              ctx.logout();
            })();
          },
        }),
      ),
    ),
  });

  /* ------------------------------- render ------------------------------ */

  const loadData = async (): Promise<void> => {
    const [roomsResult, configResult, mediaResult] = await Promise.allSettled([
      ctx.api.rooms(),
      ctx.api.getConfig(ctx.tenantId),
      ctx.api.mediaProcessing(),
      loadStt(),
    ]);
    if (destroyed) return;
    if (roomsResult.status === 'fulfilled') {
      rooms = roomsResult.value;
      roomsError = null;
      ctx.setServerStatus('online');
    } else {
      rooms = [];
      roomsError = roomsResult.reason;
      const info = describeError(roomsResult.reason);
      if (info.offline) ctx.setServerStatus('offline');
    }
    if (configResult.status === 'fulfilled') {
      config = configResult.value;
      behaviorDraft = structuredClone(configResult.value);
      mediaDraft = structuredClone(configResult.value.mediaProcessing ?? DEFAULT_MEDIA_PROCESSING);
      configError = null;
      ctx.setServerStatus('online');
    } else {
      config = null;
      behaviorDraft = null;
      mediaDraft = null;
      configError = configResult.reason;
    }
    if (mediaResult.status === 'fulfilled') {
      mediaStatus = mediaResult.value;
      mediaStatusError = null;
    } else {
      mediaStatus = null;
      mediaStatusError = mediaResult.reason;
    }
    updateRoomOptions();
    renderSnippets();
    behaviorHost.replaceChildren(renderBehaviorCard());
    mediaHost.replaceChildren(renderMediaCard());
    brandingHost.replaceChildren(renderBrandingCard());
  };

  const renderPage = (): void => {
    behaviorHost.replaceChildren(loadingPanel('Загружаем настройки организации…'));
    mediaHost.replaceChildren(loadingPanel('Загружаем настройки обработки медиа…'));
    sttHost.replaceChildren(loadingPanel(t('settings.sttLoading')));
    brandingHost.replaceChildren(loadingPanel('Загружаем оформление организации…'));
    body.replaceChildren(
      h(
        'div',
        { class: 'split' },
        h('div', { class: 'stack' }, connectionCard, embedCard, behaviorCard, mediaCard, sttCard),
        h(
          'div',
          { class: 'stack' },
          brandingCard,
          backupCard,
          card({
            title: t('settings.publicUrls'),
            subtitle: t('settings.publicUrlsHint'),
            actions: [copyButton(() => endpointRows().textContent ?? '', { label: 'Копировать всё' })],
            body: endpointsHost,
          }),
          docsCard,
          resetCard,
        ),
      ),
    );
    setupMobileCards();
    refreshEndpoints();
    renderSnippets();
    void loadData();
  };

  const setupMobileCards = (): void => {
    if (window.innerWidth > 960) return;
    const cards = Array.from(body.querySelectorAll<HTMLElement>('.card'));
    for (const [index, item] of cards.entries()) {
      if (item.querySelector('.card-collapse-toggle')) continue;
      const head = item.querySelector('.card-head');
      if (!head) continue;
      const toggle = button('Свернуть', { variant: 'ghost', size: 'sm' });
      toggle.classList.add('card-collapse-toggle');
      toggle.addEventListener('click', () => {
        const collapsed = item.classList.toggle('is-collapsed');
        toggle.textContent = collapsed ? 'Развернуть' : 'Свернуть';
      });
      head.appendChild(toggle);
      if (index > 0) {
        item.classList.add('is-collapsed');
        toggle.textContent = 'Развернуть';
      }
    }
  };

  root.appendChild(
    pageHeader({
      eyebrow: `${t('app.tenant')} ${ctx.tenantId}`,
      title: t('settings.title'),
      subtitle: t('settings.subtitle'),
      actions: [
        button(t('settings.check'), {
          variant: 'ghost',
          icon: 'activity',
          onClick: () => {
            void (async () => {
              try {
                const health = await ctx.api.health();
                ctx.setServerStatus('online');
                ctx.toast(`${health.name} ${health.version} · время работы ${Math.round(health.uptimeSec)} с`, 'success');
              } catch (error) {
                toastError(ctx, error);
              }
            })();
          },
        }),
      ],
    }),
  );
  root.appendChild(body);
  renderPage();

  return {
    el: root,
    destroy: () => {
      destroyed = true;
      cancelPreview();
    },
  };
};
