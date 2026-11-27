/**
 * Integrations (§19): identity federation, allowed embed origins, iframe
 * postMessage switch and signed webhooks with test deliveries.
 */
import type {
  ClusterStatusResponse,
  GroupRoleMapping,
  IdentityConfig,
  IntegrationsConfig,
  NodeSummary,
  ProviderSlot,
  ProviderSlotName,
  ProviderStatus,
  ScaleConfig,
  ScaleNode,
  ScaleStatusResponse,
  TenantConfig,
  TenantConfigPatch,
  TurnServerConfig,
  WebhookDeliveryRecord,
  WebhookEndpointConfig,
  WebhookEventType,
} from '@agil/protocol';
import { webhookEventTypes } from '@agil/protocol';
import type { ScreenFactory } from '../context.js';
import { h, setButtonLoading, append } from '../dom.js';
import { t } from '../i18n.js';
import { tableSearch } from '../ui/table-search.js';
import { describeError } from '../errors.js';
import { formatDateTime } from '../format.js';
import { icon } from '../icons.js';
import { publicLinks, docsRoute } from '../links.js';
import { badge } from '../ui/badge.js';
import { card, kvGrid } from '../ui/card.js';
import { copyButton } from '../ui/copy-button.js';
import {
  button,
  checkboxField,
  field,
  formGrid,
  selectInput,
  textareaInput,
  textInput,
} from '../ui/controls.js';
import { emptyState } from '../ui/empty-state.js';
import { guardedSave } from '../ui/guard.js';
import { loadingPanel, skeletonTable } from '../ui/skeleton.js';
import { dataTable } from '../ui/table.js';
import { alert, errorState, offlinePanel, pageHeader, refreshButton, toastError } from './common.js';

const EVENT_LABELS: Record<string, string> = {
  'room.created': 'room.created',
  'room.closed': 'room.closed',
  'participant.joined': 'participant.joined',
  'participant.left': 'participant.left',
  'chat.message': 'chat.message',
  'file.shared': 'file.shared',
  'recording.ready': 'recording.ready',
  'transcript.ready': 'transcript.ready',
  'analysis.ready': 'analysis.ready',
  'knowledge.answer': 'knowledge.answer',
  'compliance.finding': 'compliance.finding',
  'security.event': 'security.event',
};

type ClaimKey = 'userIdClaim' | 'nameClaim' | 'roleClaim' | 'permissionsClaim' | 'verifiedClaim';

const CLAIM_FIELDS: ReadonlyArray<{ key: ClaimKey; label: string; hint?: string }> = [
  { key: 'userIdClaim', label: 'Пользователь (userId claim)', hint: 'по умолчанию: sub' },
  { key: 'nameClaim', label: 'Имя (name claim)', hint: 'по умолчанию: name' },
  { key: 'roleClaim', label: 'Роль (role claim)', hint: 'по умолчанию: role' },
  { key: 'permissionsClaim', label: 'Права (permissions claim)', hint: 'по умолчанию: permissions' },
  { key: 'verifiedClaim', label: 'Подтверждение личности (verified claim)', hint: 'по умолчанию: verified' },
];

/* ------------------------- capability providers ------------------------ */

const PROVIDER_SLOTS: readonly ProviderSlotName[] = [
  'chat',
  'files',
  'stt',
  'notifications',
  'recording',
  'backgrounds',
];

const PROVIDER_LABELS: Record<ProviderSlotName, { label: string; hint: string }> = {
  chat: {
    label: 'Чат',
    hint: 'Транспорт и хранение сообщений. Что рисует виджет — отдельно в session.chat.ui.',
  },
  files: { label: 'Файлы', hint: 'Хранилище файлов: локальное .data/files или S3/DMS/ECM компании.' },
  stt: { label: 'Распознавание речи (STT)', hint: 'Браузер или серверный Whisper либо внешний сервис компании.' },
  notifications: { label: 'Уведомления', hint: 'Исходящие события: встроенные события интерфейса или email, бот, SIEM компании.' },
  recording: { label: 'Запись', hint: 'Запись звонка: MediaRecorder и локальное хранилище либо внешний сервис записи компании.' },
  backgrounds: { label: 'Виртуальные фоны', hint: 'Библиотека фонов: session.virtualBackgrounds или CDN компании.' },
};

const PROVIDER_MODES = [
  { value: 'builtin', label: 'Встроенное, работает автономно (builtin)' },
  { value: 'external', label: 'Внешняя система компании (external)' },
  { value: 'disabled', label: 'Выключено (disabled)' },
];

const PROVIDER_FALLBACKS = [
  { value: 'builtin', label: 'Встроенный резервный режим (builtin)' },
  { value: 'fail', label: 'Сообщить об ошибке, код 502 (fail)' },
];

const MEDIA_MODE_LABELS: Record<string, string> = {
  mesh: 'прямой (mesh)',
  sfu: 'через сервер (SFU)',
  broadcast: 'трансляция (broadcast)',
};

const LB_STRATEGY_LABELS: Record<string, string> = {
  'round-robin': 'по очереди (round-robin)',
  'least-rooms': 'где меньше комнат (least-rooms)',
  geo: 'ближе по региону (geo)',
  weighted: 'с учётом веса (weighted)',
};

/** Server sends scale limitations in English (admin API); show them in Russian. */
const SCALE_LIMITATIONS_RU: Record<string, string> = {
  'cluster: Redis pub/sub broadcast, room ownership/lease and sticky redirect are not implemented (single-node MVP)':
    'Кластер: обмен между серверами через Redis, закрепление комнат за сервером и перенаправление участников пока не реализованы — работает один сервер.',
  'sfu: LiveKit/mediasoup media plane integration is not implemented; rooms still use mesh':
    'SFU: подключение медиасервера LiveKit или mediasoup пока не реализовано; звонки идут напрямую (mesh).',
  'webinar: broadcast mode is config/UI-gated only (no receive-only media enforcement)':
    'Вебинар: режим трансляции включается настройкой, но технически зрители пока не ограничены от отправки видео.',
  'streaming: RTMP/HLS egress and CDN delivery are not implemented':
    'Трансляция: вывод в RTMP/HLS и доставка через CDN пока не реализованы.',
  'streaming: room RTMP/HLS output requires a separate Egress worker; WHEP playback requires a configured WebRTC endpoint':
    'Трансляция комнаты в RTMP или HLS требует отдельного Egress. Для просмотра через WebRTC укажите адрес WHEP.',
  'turn: pool is advertised to clients; allocation health is not probed automatically':
    'TURN: список серверов передаётся клиентам, но автоматическая проверка их доступности не выполняется.',
};

function limitationLabel(text: string): string {
  return SCALE_LIMITATIONS_RU[text] ?? text;
}

function modeBadge(mode: ProviderStatus['mode']): HTMLElement {
  const tone = mode === 'builtin' ? 'success' : mode === 'external' ? 'info' : 'neutral';
  const label = mode === 'builtin' ? 'встроенный (builtin)' : mode === 'external' ? 'внешний (external)' : 'отключён (disabled)';
  return badge(label, tone, { dot: true });
}

function newWebhook(): WebhookEndpointConfig {
  return {
    id: `wh-${crypto.randomUUID().slice(0, 8)}`,
    url: '',
    events: ['security.event'],
    secretEnv: 'AGIL_WEBHOOK_SECRET',
    enabled: true,
    retries: 2,
    timeoutMs: 5000,
    description: '',
  };
}

export const integrationsScreen: ScreenFactory = (ctx) => {
  const root = h('div', { class: 'page' });
  const body = h('div', { class: 'stack' });
  let destroyed = false;
  let config: TenantConfig | null = null;
  let identity: IdentityConfig | null = null;
  let allowedOrigins: string[] = [];
  let embedPostMessage = true;
  let webhooks: WebhookEndpointConfig[] = [];
  let savedWebhooks = new Map<string, string>();
  let deliveries: WebhookDeliveryRecord[] = [];
  let webhooksError: unknown = null;
  let providersStatus: ProviderStatus[] = [];
  let providersDraft: TenantConfig['providers'] | null = null;
  let providersError: unknown = null;
  let providersEditing = false;
  let scaleStatus: ScaleStatusResponse | null = null;
  let clusterStatus: ClusterStatusResponse | null = null;
  let scaleError: unknown = null;
  let scaleDraft: ScaleConfig | null = null;
  let scaleEditing = false;
  let identityError: unknown = null;
  const saveIdentityButton = button('Сохранить', { variant: 'primary', icon: 'check' });
  saveIdentityButton.disabled = true;

  const loadWebhooks = (items: WebhookEndpointConfig[]): void => {
    webhooks = structuredClone(items);
    savedWebhooks = new Map(items.map((item) => [item.id, JSON.stringify(item)]));
  };

  root.appendChild(
    pageHeader({
      eyebrow: `Организация ${ctx.tenantId}`,
      title: 'Интеграции',
      subtitle: 'Вход по токенам и OIDC, разрешённые адреса для встраивания, подписанные вебхуки и события.',
      actions: [refreshButton(() => load())],
    }),
  );
  root.appendChild(body);

  const links = publicLinks(ctx.credentials.serverUrl);

  /* --------------------------- identity form -------------------------- */

  const renderIdentityCard = (): HTMLElement => {
    if (!identity || identityError !== null) {
      return card({
        title: 'Вход и разрешённые адреса',
        body: [
          errorState(identityError ?? new Error('Настройки недоступны'), () => void load()),
          h('p', { class: 'notice', text: 'Настройки входа доступны через GET /v1/tenants/:tenantId/config.' }),
        ],
      });
    }
    const draft = identity;
    const originsTextarea = textareaInput({
      value: allowedOrigins.join('\n'),
      rows: 3,
      placeholder: 'https://app.example.com\nhttps://*.example.com',
      ariaLabel: 'Разрешённые адреса (origin)',
      onInput: (value) => {
        allowedOrigins = value
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
      },
    });
    const save = (): void => {
      void (async () => {
        setButtonLoading(saveIdentityButton, true);
        try {
          const patch: TenantConfigPatch = {
            integrations: {
              identity: { ...draft },
              allowedOrigins,
              embedPostMessage,
            },
          };
          const result = await guardedSave('integrations', patch, 'сохранить вход и разрешённые адреса', async () =>
            ctx.api.patchConfig(ctx.tenantId, patch),
          );
          if (!result.allowed) return;
          config = result.value ?? config;
          ctx.toast('Настройки интеграций сохранены', 'success');        } catch (error) {
          toastError(ctx, error);
        } finally {
          setButtonLoading(saveIdentityButton, false);
        }
      })();
    };
    saveIdentityButton.addEventListener('click', save);

    const form = h(
      'div',
      { class: 'stack' },
      alert(
        'info',
        'Два режима входа',
        'token — компания выпускает наши HS256-токены через POST /v1/tokens и передаёт права (permissions). oidc — сервер проверяет identity JWT по JWKS (join), а панель входит по authorization code + PKCE («Войти через SSO»). Для oidc нужны issuer, clientId, JWKS и endpoint и/или OIDC discovery; секрет клиента хранится в переменной окружения.',
      ),
      formGrid(
        field('Режим входа (identity)', selectInput(
          [
            { value: 'token', label: 'Токены AGIL Calls, HS256 (token)' },
            { value: 'oidc', label: 'Внешний IdP, OIDC (oidc)' },
          ],
          {
            value: draft.mode,
            onChange: (value) => {
              draft.mode = value as IdentityConfig['mode'];
            },
          },
        )),
        field(
          'Издатель токена (issuer)',
          textInput({
            value: draft.issuer,
            placeholder: 'https://sso.example.com/realms/corp',
            onInput: (value) => {
              draft.issuer = value.trim();
            },
          }),
        ),
        field(
          'Получатель токена (audience)',
          textInput({
            value: draft.audience,
            placeholder: 'agil-calls',
            onInput: (value) => {
              draft.audience = value.trim();
            },
          }),
        ),
        field(
          'Адрес ключей JWKS (jwksUrl)',
          textInput({
            value: draft.jwksUrl,
            placeholder: 'https://sso.example.com/.../certs',
            onInput: (value) => {
              draft.jwksUrl = value.trim();
            },
          }),
        ),
      ),
      h('div', { class: 'section-title', text: 'OIDC: вход в панель (authorization code + PKCE)' }),
      formGrid(
        checkboxField({
          label: 'OIDC discovery из issuer (/.well-known/openid-configuration)',
          description: 'Сервер сам загрузит authorization/token/JWKS/end_session endpoints. Явно заполненные поля ниже имеют приоритет.',
          checked: draft.discovery ?? false,
          onChange: (checked) => {
            draft.discovery = checked;
          },
        }),
        field(
          'Discovery URL (необязательно)',
          textInput({
            value: draft.discoveryUrl ?? '',
            placeholder: 'https://sso.example.com/realms/corp/.well-known/openid-configuration',
            onInput: (value) => {
              draft.discoveryUrl = value.trim();
            },
          }),
          { hint: 'Пусто — стандартный путь от issuer. Заполнение включает discovery.' },
        ),
        field(
          'Authorization endpoint',
          textInput({
            value: draft.authorizationEndpoint,
            placeholder: 'https://sso.example.com/.../auth',
            onInput: (value) => {
              draft.authorizationEndpoint = value.trim();
            },
          }),
          { hint: 'Куда браузер уходит за входом (только mode=oidc).' },
        ),
        field(
          'Token endpoint',
          textInput({
            value: draft.tokenEndpoint,
            placeholder: 'https://sso.example.com/.../token',
            onInput: (value) => {
              draft.tokenEndpoint = value.trim();
            },
          }),
          { hint: 'Серверный обмен кода на id_token; вызывается с секретом клиента.' },
        ),
        field(
          'Client ID',
          textInput({
            value: draft.clientId,
            placeholder: 'agil-dashboard',
            onInput: (value) => {
              draft.clientId = value.trim();
            },
          }),
        ),
        field(
          'Секрет клиента: имя env-переменной',
          textInput({
            value: draft.clientSecretEnv,
            placeholder: 'AGIL_OIDC_CLIENT_SECRET_DEMO_KEYCLOAK',
            onInput: (value) => {
              draft.clientSecretEnv = value.trim();
            },
          }),
          { hint: 'Не секрет, а имя переменной окружения сервера. Имя должно быть привязано к тенанту: AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME> или запись в AGIL_OIDC_TENANT_SECRETS; иначе запрос отклоняется.' },
        ),
        field(
          'Redirect URI',
          textInput({
            value: draft.redirectUri,
            placeholder: 'https://calls.example.com/v1/auth/oidc/callback',
            onInput: (value) => {
              draft.redirectUri = value.trim();
            },
          }),
          { hint: 'Пусто — <адрес сервера>/v1/auth/oidc/callback. Должен совпадать с настройкой в IdP.' },
        ),
        field(
          'Scopes',
          textInput({
            value: draft.scopes.join(' '),
            placeholder: 'openid profile email',
            onInput: (value) => {
              draft.scopes = value
                .split(/[\s,]+/)
                .map((scope) => scope.trim())
                .filter(Boolean);
            },
          }),
          { hint: 'openid добавляется всегда. Пусто — только openid.' },
        ),
        field(
          'Token endpoint auth method',
          selectInput(
            [
              { value: 'client_secret_post', label: 'client_secret_post (секрет в теле)' },
              { value: 'client_secret_basic', label: 'client_secret_basic (HTTP Basic)' },
            ],
            {
              value: draft.tokenEndpointAuthMethod ?? 'client_secret_post',
              onChange: (value) => {
                draft.tokenEndpointAuthMethod = value as IdentityConfig['tokenEndpointAuthMethod'];
              },
            },
          ),
          { hint: 'Способ аутентификации клиента на token endpoint (RFC 6749 §2.3.1). Секрет в конфиге не хранится.' },
        ),
        field(
          'Response mode',
          selectInput(
            [
              { value: 'query', label: 'query (по умолчанию)' },
              { value: 'form_post', label: 'form_post (кросс-сайтовый POST от IdP)' },
            ],
            {
              value: draft.responseMode ?? 'query',
              onChange: (value) => {
                draft.responseMode = value as IdentityConfig['responseMode'];
              },
            },
          ),
          { hint: 'form_post требует HTTPS и привязки cookie SameSite=None; callback принимает POST на /v1/auth/oidc/callback.' },
        ),
        field(
          'End session endpoint (RP-initiated logout)',
          textInput({
            value: draft.endSessionEndpoint ?? '',
            placeholder: 'https://sso.example.com/.../logout',
            onInput: (value) => {
              draft.endSessionEndpoint = value.trim();
            },
          }),
          { hint: 'Пусто — из OIDC discovery. Без него панель отзывает только локальную сессию.' },
        ),
        field(
          'Post logout redirect URI',
          textInput({
            value: draft.postLogoutRedirectUri ?? '',
            placeholder: 'https://calls.example.com/v1/auth/oidc/logout/callback',
            onInput: (value) => {
              draft.postLogoutRedirectUri = value.trim();
            },
          }),
          { hint: 'Пусто — <адрес сервера>/v1/auth/oidc/logout/callback (сервер проверит state). Должен быть зарегистрирован в IdP.' },
        ),
      ),
      h('div', { class: 'section-title', text: 'Соответствие полям токена (claims)' }),
      formGrid(
        ...CLAIM_FIELDS.map((claim) =>
          field(
            claim.label,
            textInput({
              value: draft[claim.key],
              onInput: (value) => {
                draft[claim.key] = value.trim();
              },
            }),
            claim.hint ? { hint: claim.hint } : {},
          ),
        ),
      ),
      h('div', { class: 'section-title', text: 'Политика доступа: allowlist, группы и привязка к организации' }),
      h(
        'p',
        { class: 'notice' },
        'Проверки применяются и к входу в панель, и к verified join. Пустые allowlist-поля выключают соответствующее ограничение. При непустом groupRoleMap роли берутся только из групп IdP (нет совпадения — guest), а roleClaim игнорируется.',
      ),
      formGrid(
        field(
          'Email claim',
          textInput({
            value: draft.emailClaim ?? 'email',
            placeholder: 'email',
            onInput: (value) => {
              draft.emailClaim = value.trim() || 'email';
            },
          }),
          { hint: 'Claim с email для allowlist. По умолчанию email.' },
        ),
        field(
          'Email verified claim',
          textInput({
            value: draft.emailVerifiedClaim ?? 'email_verified',
            placeholder: 'email_verified',
            onInput: (value) => {
              draft.emailVerifiedClaim = value.trim() || 'email_verified';
            },
          }),
          { hint: 'OIDC email_verified; явный false всегда запрещает вход.' },
        ),
        field(
          'Groups claim',
          textInput({
            value: draft.groupsClaim ?? 'groups',
            placeholder: 'groups',
            onInput: (value) => {
              draft.groupsClaim = value.trim() || 'groups';
            },
          }),
          { hint: 'Массив групп или строка через пробел/запятую.' },
        ),
        field(
          'Tenant claim',
          textInput({
            value: draft.tenantClaim ?? '',
            placeholder: 'tenant (пусто — проверка выключена)',
            onInput: (value) => {
              draft.tenantClaim = value.trim();
            },
          }),
          { hint: 'Claim должен совпадать с id организации — защита от cross-tenant replay.' },
        ),
        field(
          'Максимальный возраст токена, сек',
          textInput({
            type: 'number',
            value: String(draft.maxTokenAgeSec ?? 0),
            min: 0,
            max: 604800,
            onChange: (value) => {
              draft.maxTokenAgeSec = Math.min(604800, Math.max(0, Number(value) || 0));
            },
          }),
          { hint: 'Ограничивает exp − iat. 0 — без ограничения.' },
        ),
        field(
          'Допустимый clock skew, сек',
          textInput({
            type: 'number',
            value: String(draft.clockSkewSec ?? 60),
            min: 0,
            max: 300,
            onChange: (value) => {
              draft.clockSkewSec = Math.min(300, Math.max(0, Number(value) || 0));
            },
          }),
          { hint: 'Запас на расхождение часов для exp/nbf/iat (0…300).' },
        ),
      ),
      field(
        'Разрешённые email (по одному на строку)',
        textareaInput({
          value: (draft.allowedEmails ?? []).join('\n'),
          rows: 3,
          placeholder: 'ceo@example.com\nsecurity@example.com',
          ariaLabel: 'Разрешённые email',
          onInput: (value) => {
            draft.allowedEmails = value
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean);
          },
        }),
        { hint: 'Точное совпадение без учёта регистра. Пусто — без ограничения по адресам.' },
      ),
      field(
        'Разрешённые домены email (по одному на строку)',
        textareaInput({
          value: (draft.allowedEmailDomains ?? []).join('\n'),
          rows: 3,
          placeholder: 'example.com\n*.example.com',
          ariaLabel: 'Разрешённые домены email',
          onInput: (value) => {
            draft.allowedEmailDomains = value
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean);
          },
        }),
        { hint: 'example.com — только этот домен; *.example.com — только поддомены. Ошибка в списке запрещает вход (fail closed).' },
      ),
      field(
        'Группы для входа в панель (по одной на строку)',
        textareaInput({
          value: (draft.dashboardAdminGroups ?? []).join('\n'),
          rows: 2,
          placeholder: 'agil-dashboard-admins',
          ariaLabel: 'Группы администраторов панели',
          onInput: (value) => {
            draft.dashboardAdminGroups = value
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean);
          },
        }),
        { hint: 'Пусто — любой пользователь, которого IdP аутентифицировал для клиента, получает tenant admin (ограничивайте в IdP).' },
      ),
      field(
        'Группа → роль (по строке group=role)',
        textareaInput({
          value: (draft.groupRoleMap ?? []).map((rule) => `${rule.group}=${rule.role}`).join('\n'),
          rows: 3,
          placeholder: 'agil-hosts=host\nagil-moderators=moderator',
          ariaLabel: 'Сопоставление групп и ролей',
          onInput: (value) => {
            const parsed: GroupRoleMapping[] = [];
            for (const line of value.split('\n')) {
              const [groupPart, rolePart] = line.split('=');
              const group = (groupPart ?? '').trim();
              const role = (rolePart ?? '').trim().toLowerCase();
              if (!group || (role !== 'host' && role !== 'moderator' && role !== 'guest')) continue;
              parsed.push({ group, role });
            }
            draft.groupRoleMap = parsed;
          },
        }),
        { hint: 'Роли: host | moderator | guest. При нескольких совпадениях побеждает старшая роль.' },
      ),
      checkboxField({
        label: 'Требовать подтверждённый email (email_verified=true)',
        description: 'Если claim отсутствует или равен false — вход отклоняется (identity_not_allowed).',
        checked: Boolean(draft.requireEmailVerified),
        onChange: (checked) => {
          draft.requireEmailVerified = checked;
        },
      }),
      field('Разрешённые адреса для встраивания (origin)', originsTextarea, {
        hint: 'По одному на строку. Используется для CSP frame-ancestors и проверки postMessage. Пусто — только тот же адрес (same-origin).',
      }),
      checkboxField({
        label: 'Разрешить postMessage из iframe',
        description: 'Страница компании может управлять виджетом через agil:action и agil:config.',
        checked: embedPostMessage,
        onChange: (checked) => {
          embedPostMessage = checked;
        },
      }),
      h('div', { class: 'actions' }, saveIdentityButton),
    );

    return card({
      title: 'Вход и разрешённые адреса',
      subtitle: 'ограничения входа и список доверенных адресов',
      subtitleTitle: 'PATCH /v1/tenants/:id/config → integrations',
      body: form,
    });
  };

  /* ----------------------------- webhooks ----------------------------- */

  const renderWebhooks = (): HTMLElement => {
    const host = h('div', { class: 'stack' });
    const listHost = h('div', { class: 'stack' });
    const saveWebhooksButton = button('Сохранить вебхуки', { variant: 'primary', icon: 'check' });
    saveWebhooksButton.disabled = webhooksError !== null;
    const addWebhookButton = button('Добавить вебхук', {
      variant: 'ghost',
      icon: 'plus',
      disabled: webhooksError !== null,
      onClick: () => {
        webhooks.push(newWebhook());
        renderList();
      },
    });

    const renderList = (): void => {
      listHost.replaceChildren();
      if (webhooks.length === 0) {
        listHost.appendChild(
          emptyState({
            title: 'Вебхуков нет',
            message: 'Добавьте адрес сервиса (endpoint), чтобы получать подписанные события (room.created, analysis.ready, security.event…).',
            iconName: 'link',
            compact: true,
          }),
        );
        return;
      }
      webhooks.forEach((hook, index) => {
        const urlInput = textInput({
          value: hook.url,
          placeholder: 'https://example.com/webhooks/agil',
          onInput: (value) => {
            hook.url = value.trim();
            updateRow();
          },
        });
        const secretEnvInput = textInput({
          value: hook.secretEnv,
          onInput: (value) => {
            hook.secretEnv = value.trim();
            updateRow();
          },
        });
        const retriesInput = textInput({
          type: 'number',
          value: String(hook.retries),
          min: 0,
          max: 10,
          onChange: (value) => {
            hook.retries = Math.min(10, Math.max(0, Number(value) || 0));
            updateRow();
          },
        });
        const timeoutInput = textInput({
          type: 'number',
          value: String(hook.timeoutMs),
          min: 500,
          max: 30000,
          onChange: (value) => {
            hook.timeoutMs = Math.min(30000, Math.max(500, Number(value) || 5000));
            updateRow();
          },
        });
        const descriptionInput = textInput({
          value: hook.description ?? '',
          placeholder: 'Назначение (необязательно)',
          onInput: (value) => {
            hook.description = value;
            updateRow();
          },
        });
        const eventsHost = h('div', { class: 'chips' });
        for (const event of webhookEventTypes) {
          const checked = hook.events.includes(event);
          const input = h('input', { attrs: { type: 'checkbox', 'aria-label': EVENT_LABELS[event] ?? event } });
          input.checked = checked;
          input.addEventListener('change', () => {
            const set = new Set(hook.events);
            if (input.checked) set.add(event as WebhookEventType);
            else set.delete(event as WebhookEventType);
            hook.events = [...set];
            updateRow();
          });
          eventsHost.appendChild(
            h('label', { class: 'checkbox-row', attrs: { style: 'padding:2px 6px;border:1px solid var(--agil-color-divider);border-radius:var(--agil-radius-pill)' } }, input, h('span', { class: 'small mono', text: EVENT_LABELS[event] ?? event })),
          );
        }
        const testStatus = h('span', { class: 'notice', attrs: { role: 'status' } });
        const urlSummary = h('span', { class: 'cell-title' });
        const eventsSummary = h('span', { class: 'cell-sub' });
        const enabledSummary = h('span');
        const isSaved = () => savedWebhooks.get(hook.id) === JSON.stringify(hook);
        let testing = false;
        const testButton = button('Тест', {
          variant: 'ghost',
          size: 'sm',
          icon: 'play',
          onClick: () => {
            void (async () => {
              if (testing || !isSaved()) return;
              testing = true;
              setButtonLoading(testButton, true);
              testStatus.textContent = 'Отправляем тестовое событие…';
              try {
                const result = await ctx.api.testWebhook(hook.id);
                testStatus.textContent =
                  result.status === 'delivered'
                    ? `доставлено${result.statusCode ? ` · HTTP ${result.statusCode}` : ''}`
                    : `ошибка: ${result.error ?? 'не доставлено'}`;
                testStatus.className = result.status === 'delivered' ? 'notice text-success' : 'notice text-danger';
                ctx.toast(result.status === 'delivered' ? 'Вебхук доставлен' : 'Вебхук не доставлен', result.status === 'delivered' ? 'success' : 'error');
                await refreshDeliveries();
              } catch (error) {
                const info = describeError(error);
                testStatus.textContent = `${info.title}: ${info.message}`;
                testStatus.className = 'notice text-danger';
              } finally {
                testing = false;
                setButtonLoading(testButton, false);
                if (!isSaved()) updateRow();
              }
            })();
          },
        });
        const updateRow = (): void => {
          urlSummary.textContent = hook.url || 'Адрес не задан';
          eventsSummary.textContent = `Событий: ${hook.events.length}`;
          enabledSummary.replaceChildren(hook.enabled ? badge('вкл', 'success') : badge('выкл', 'neutral'));
          if (testing) return;
          testButton.disabled = !isSaved();
          testStatus.className = 'notice';
          testStatus.textContent = testButton.disabled ? 'Сохраните изменения перед тестом.' : '';
        };
        updateRow();
        const row = h(
          'details',
          { class: 'excerpt', attrs: { open: '' } },
          h(
            'summary',
            { class: 'row' },
            h('span', { class: 'mono cell-sub', text: hook.id }),
            urlSummary,
            enabledSummary,
            h('span', { class: 'spacer' }),
            eventsSummary,
          ),
          h(
            'div',
            { class: 'stack', attrs: { style: 'margin-top:10px' } },
            formGrid(
              field('URL', urlInput, { className: 'field-span-2' }),
              field('Секрет: переменная окружения (secretEnv)', secretEnvInput, { hint: 'Ключ HMAC задаётся на сервере; API не хранит секрет.' }),
              field('Повторы (retries)', retriesInput),
              field('Ожидание ответа, мс', timeoutInput),
              field('Описание', descriptionInput),
            ),
            h(
              'div',
              { class: 'row' },
              checkboxField({
                label: 'Включён',
                checked: hook.enabled,
                onChange: (checked) => {
                  hook.enabled = checked;
                  updateRow();
                },
              }),
              h('span', { class: 'spacer' }),
              testButton,
              button(undefined, {
                variant: 'danger-ghost',
                size: 'sm',
                icon: 'trash',
                title: 'Удалить вебхук',
                onClick: () => {
                  webhooks.splice(index, 1);
                  renderList();
                },
              }),
            ),
            testStatus,
            h('div', { class: 'section-title', text: 'События' }),
            eventsHost,
          ),
        );
        listHost.appendChild(row);
      });
    };
    renderList();

    const save = (): void => {
      void (async () => {
        const invalid = webhooks.find((hook) => !hook.url || hook.events.length === 0);
        if (invalid) {
          ctx.toast('У каждого вебхука нужны URL и хотя бы одно событие', 'warning');
          return;
        }
        setButtonLoading(saveWebhooksButton, true);
        listHost.inert = true;
        addWebhookButton.disabled = true;
        try {
          const next = webhooks.map((hook) => ({ ...hook, events: [...hook.events] }));
          const result = await guardedSave('webhook', next, 'сохранить вебхуки и их события', async () =>
            ctx.api.updateWebhooks(next),
          );
          if (!result.allowed || !result.value) return;
          const response = result.value;
          loadWebhooks(response.webhooks);
          deliveries = response.recentDeliveries;
          renderList();
          renderDeliveries();
          ctx.toast('Вебхуки сохранены', 'success');
        } catch (error) {
          toastError(ctx, error);
        } finally {
          listHost.inert = false;
          addWebhookButton.disabled = false;
          setButtonLoading(saveWebhooksButton, false);
        }
      })();
    };
    saveWebhooksButton.addEventListener('click', save);

    append(
      host,
      alert(
        'info',
        'Подпись и повторы',
        'HMAC-SHA256 подписывает метку времени из x-agil-timestamp, точку и исходное тело запроса. Подпись передаётся в x-agil-signature. Секрет берётся из переменной окружения, указанной в secretEnv.',
      ),
      webhooksError !== null
        ? h('div', { class: 'stack' }, errorState(webhooksError, () => void load()), h('p', { class: 'notice', text: 'Проверьте, что сервер поддерживает вебхуки (это новая возможность сервера).' }))
        : null,
      listHost,
      h(
        'div',
        { class: 'actions' },
        addWebhookButton,
        saveWebhooksButton,
      ),
    );
    return card({ title: 'Вебхуки', subtitle: 'Полная замена списка: прежние адреса удаляются.', body: host });
  };

  /* ---------------------------- deliveries ---------------------------- */

  let deliveriesHost: HTMLElement | null = null;
  const deliveryStatus = { delivered: 'доставлено', failed: 'ошибка', retrying: 'ожидает' };
  const deliverySearch = tableSearch(t('table.searchDeliveries'), t('table.searchDeliveriesHint'), () => renderDeliveries());
  const renderDeliveries = (): void => {
    if (!deliveriesHost) return;
    const visible = deliveries.filter((row) => deliverySearch.matches(
      row.endpointId, row.type, row.status, deliveryStatus[row.status], row.statusCode, row.lastError,
    ));
    deliverySearch.setCount(visible.length, deliveries.length);
    deliveriesHost.replaceChildren(
      dataTable<WebhookDeliveryRecord>({
        columns: [
          { key: 'ts', header: 'Время', render: (row) => formatDateTime(row.ts) },
          { key: 'endpoint', header: 'Адрес сервиса', render: (row) => h('span', { class: 'mono small', text: row.endpointId }) },
          { key: 'type', header: 'Событие', render: (row) => h('span', { class: 'mono small', text: row.type }) },
          {
            key: 'status',
            header: 'Статус',
            render: (row) => {
              const label = deliveryStatus[row.status];
              return badge(label, row.status === 'delivered' ? 'success' : row.status === 'failed' ? 'danger' : 'warning', { dot: true, title: `status: ${row.status}` });
            },
          },
          { key: 'attempts', header: 'Попытки', render: (row) => String(row.attempts) },
          { key: 'code', header: 'HTTP', render: (row) => (row.statusCode ? String(row.statusCode) : '—') },
          { key: 'error', header: 'Ошибка', render: (row) => row.lastError ?? '—' },
        ],
        rows: visible,
        empty: deliverySearch.active ? emptyState({ title: t('table.noMatches'), compact: true })
          : emptyState({ title: 'Доставок пока не было', message: 'Отправьте тест или дождитесь события.', iconName: 'activity', compact: true }),
      }),
    );
  };

  const refreshDeliveries = async (): Promise<void> => {
    try {
      const response = await ctx.api.webhooks();
      deliveries = response.recentDeliveries;
      renderDeliveries();
    } catch {
      /* non-fatal: deliveries are a debug view */
    }
  };

  /* ------------------------- capability providers ----------------------- */

  const providersBody = h('div', { class: 'stack' });

  const statusFor = (slot: ProviderSlotName): ProviderStatus | null =>
    providersStatus.find((item) => item.slot === slot) ?? null;

  const renderProviderStatus = (slot: ProviderSlotName): HTMLElement => {
    const status = statusFor(slot);
    const meta = PROVIDER_LABELS[slot];
    const row = h('div', { class: 'excerpt' });
    const head = h('div', { class: 'row' });
    head.append(h('span', { class: 'section-title', text: meta.label }), h('span', { class: 'mono small', text: slot }));
    if (status) {
      append(
        head,
        modeBadge(status.mode),
        status.mode === 'external' && status.providerName
          ? badge(status.providerName, 'neutral', { title: `Имя внешнего сервиса (providerName): ${status.providerName}` })
          : null,
        badge(status.configured ? 'настроен' : 'не настроен', status.configured ? 'success' : 'warning', {
          title: 'Настроен ли слот в настройках организации',
        }),
        badge(status.available ? 'доступен' : 'недоступен', status.available ? 'success' : 'warning', {
          title: 'Есть ли ключ в переменной окружения и адрес сервиса',
        }),
        badge(`при сбое: ${status.fallback === 'fail' ? 'сообщить об ошибке' : 'встроенный резервный режим'}`, status.fallback === 'fail' ? 'warning' : 'neutral', {
          title:
            status.fallback === 'builtin'
              ? 'При ошибке внешнего сервиса используется встроенный'
              : 'При ошибке внешнего сервиса запрос завершится кодом 502',
        }),
      );
    } else {
      head.appendChild(badge('нет статуса', 'warning'));
    }
    row.appendChild(head);
    row.appendChild(h('p', { class: 'feed-message', text: meta.hint }));
    if (status?.note) row.appendChild(h('p', { class: 'notice', text: status.note }));

    const resultHost = h('span', { class: 'notice', text: '' });
    const testButton = button('Проверить', { variant: 'ghost', size: 'sm', icon: 'play' });
    testButton.addEventListener('click', () => {
      void (async () => {
        setButtonLoading(testButton, true);
        resultHost.textContent = 'Проверяем внешний сервис…';
        resultHost.className = 'notice';
        try {
          const result = await ctx.api.testProvider(slot);
          resultHost.textContent = `${result.ok ? 'Успешно' : 'Ошибка'} · ${result.latencyMs} мс${
            result.providerName ? ` · ${result.providerName}` : ''
          }${result.detail ? ` · ${result.detail}` : ''}`;
          resultHost.className = result.ok ? 'notice text-success' : 'notice text-danger';
          ctx.toast(
            result.ok ? `Внешний сервис «${PROVIDER_LABELS[slot].label}»: проверка пройдена` : `Внешний сервис «${PROVIDER_LABELS[slot].label}»: проверка не пройдена`,
            result.ok ? 'success' : 'error',
          );
        } catch (error) {
          const info = describeError(error);
          if (info.offline) ctx.setServerStatus('offline');
          resultHost.textContent = `${info.title}: ${info.message}`;
          resultHost.className = 'notice text-danger';
        } finally {
          setButtonLoading(testButton, false);
        }
      })();
    });
    row.appendChild(h('div', { class: 'row', attrs: { style: 'align-items:flex-start' } }, testButton, resultHost));
    return row;
  };

  const renderProviderEditor = (slot: ProviderSlotName, draft: TenantConfig['providers']): HTMLElement => {
    const slotDraft: ProviderSlot = draft[slot];
    const modeBadgeHost = h('span');
    const syncModeBadge = (): void => {
      modeBadgeHost.replaceChildren(modeBadge(slotDraft.mode));
    };
    syncModeBadge();

    const nameInput = textInput({
      value: slotDraft.providerName,
      placeholder: 'corp-messenger',
      onInput: (value) => {
        slotDraft.providerName = value.trim();
      },
    });
    const endpointInput = textInput({
      value: slotDraft.endpoint,
      placeholder: 'https://example.com/agil/chat',
      disabled: slotDraft.mode !== 'external',
      onInput: (value) => {
        slotDraft.endpoint = value.trim();
      },
    });
    const apiKeyEnvInput = textInput({
      value: slotDraft.apiKeyEnv,
      placeholder: 'AGIL_CHAT_PROVIDER_KEY',
      onInput: (value) => {
        slotDraft.apiKeyEnv = value.trim();
      },
    });
    const timeoutInput = textInput({
      type: 'number',
      value: String(slotDraft.timeoutMs),
      min: 200,
      max: 30000,
      onChange: (value) => {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          slotDraft.timeoutMs = Math.min(30000, Math.max(200, Math.round(parsed)));
        }
      },
    });
    const modeSelect = selectInput(PROVIDER_MODES, {
      value: slotDraft.mode,
      onChange: (value) => {
        slotDraft.mode = value as ProviderSlot['mode'];
        endpointInput.disabled = value !== 'external';
        syncModeBadge();
      },
    });
    const fallbackSelect = selectInput(PROVIDER_FALLBACKS, {
      value: slotDraft.fallback,
      onChange: (value) => {
        slotDraft.fallback = value as ProviderSlot['fallback'];
      },
    });

    const details = h('details', { class: 'excerpt' });
    details.appendChild(
      h(
        'summary',
        { class: 'row' },
        h('span', { class: 'section-title', text: PROVIDER_LABELS[slot].label }),
        h('span', { class: 'mono small', text: slot }),
        modeBadgeHost,
        h('span', { class: 'spacer' }),
        h('span', { class: 'cell-sub', text: slotDraft.mode === 'external' ? slotDraft.providerName || 'external' : slotDraft.mode }),
      ),
    );
    details.appendChild(
      h(
        'div',
        { class: 'stack', attrs: { style: 'margin-top:10px' } },
        formGrid(
          field('Режим (mode)', modeSelect),
          field('Название (providerName)', nameInput, { hint: 'Имя для интерфейса и аудита.' }),
          field('Адрес сервиса (endpoint)', endpointInput, { hint: 'Только HTTPS; локальные адреса запрещены проверкой сервера.' }),
          field('Переменная с ключом (apiKeyEnv)', apiKeyEnvInput, { hint: 'Имя переменной окружения с HMAC/API-ключом; сам ключ не хранится.' }),
          field('Ожидание ответа (timeoutMs)', timeoutInput),
          field('Поведение при сбое', fallbackSelect),
        ),
        h('p', {
          class: 'notice',
          text: 'Дополнительные параметры сервиса сохраняются как есть; новые ключи задаются через PUT /v1/admin/providers или MCP.',
        }),
      ),
    );
    return details;
  };

  const renderProvidersEditor = (draft: TenantConfig['providers']): HTMLElement => {
    const editor = h('div', { class: 'stack' });
    editor.appendChild(h('div', { class: 'section-title', text: 'Редактирование провайдеров' }));
    editor.appendChild(h('p', { class: 'notice', text: 'Формат API: PUT /v1/admin/providers. Меняйте JSON только если понимаете схему.' }));
    for (const slot of PROVIDER_SLOTS) editor.appendChild(renderProviderEditor(slot, draft));
    const save = button('Сохранить внешние сервисы', { variant: 'primary', icon: 'check' });
    save.addEventListener('click', () => {
      void (async () => {
        for (const slot of PROVIDER_SLOTS) {
          const item = draft[slot];
          if (item.mode === 'external' && !item.endpoint.trim()) {
            ctx.toast('Для внешнего сервиса нужен адрес (endpoint)', 'warning');
            return;
          }
        }
        setButtonLoading(save, true);
        try {
          const result = await guardedSave('providers', draft, 'сохранить внешние сервисы', async () =>
            ctx.api.updateProviders(draft),
          );
          if (!result.allowed || !result.value) return;
          const response = result.value;
          providersStatus = response.providers;
          providersError = null;
          ctx.toast('Внешние сервисы сохранены', 'success');
          renderProvidersBody();
        } catch (error) {
          toastError(ctx, error);
        } finally {
          setButtonLoading(save, false);
        }
      })();
    });
    editor.appendChild(h('div', { class: 'actions' }, save));
    return editor;
  };

  const renderProvidersBody = (): void => {
    providersBody.replaceChildren();
    if (providersError !== null && providersStatus.length === 0) {
      providersBody.appendChild(errorState(providersError, () => void load()));
      return;
    }
    providersBody.appendChild(
      alert(
        'info',
        'По умолчанию всё встроено и работает автономно',
        'Встроенные (builtin) — штатные механизмы AGIL Calls: чат по WebSocket, локальные файлы и запись, распознавание речи в браузере, уведомления в интерфейсе, фоны из настроек. Внешние (external) — система компании: сервер вызывает адрес сервиса с подписью HMAC, а резервный режим решает, что делать при ошибке. Отключённые (disabled) — возможность выключена для организации.',
      ),
    );
    const statusStack = h('div', { class: 'stack' });
    for (const slot of PROVIDER_SLOTS) statusStack.appendChild(renderProviderStatus(slot));
    providersBody.appendChild(statusStack);
    if (providersEditing) {
      if (providersDraft) providersBody.appendChild(renderProvidersEditor(providersDraft));
      else providersBody.appendChild(alert('warning', 'Редактор недоступен', 'Настройки организации не загружены — обновите страницу.'));
    }
    if (providersError !== null && providersStatus.length > 0) {
      providersBody.appendChild(
        alert('warning', 'Статусы внешних сервисов не загрузились', describeError(providersError).message),
      );
    }
  };

  const providersCard = (): HTMLElement => {
    const editButton = button('Редактировать', { variant: 'ghost', size: 'sm', icon: 'settings' });
    const syncEditButton = (): void => {
      editButton.replaceChildren(
        icon(providersEditing ? 'x' : 'settings', 14),
        h('span', { text: providersEditing ? 'Скрыть редактор' : 'Редактировать' }),
      );
    };
    syncEditButton();
    editButton.addEventListener('click', () => {
      providersEditing = !providersEditing;
      syncEditButton();
      renderProvidersBody();
    });
    const docs = h(
      'a',
      {
        class: 'btn btn-subtle btn-sm',
        attrs: { href: links.extensibility, target: '_blank', rel: 'noopener noreferrer', title: 'docs/extensibility.md' },
      },
      'docs/extensibility.md',
    );
    return card({
      title: 'Внешние сервисы',
      subtitle: 'Шесть возможностей: встроенная, внешняя или отключённая.',
      actions: [editButton, docs],
      body: providersBody,
    });
  };

  /* ------------------- scaling / multi-node / SFU (§24) ---------------- */

  const scaleBody = h('div', { class: 'stack' });
  const scaleOverview = h('div', { class: 'stack' });

  const MEDIA_MODES = [
    { value: 'mesh', label: 'Прямое соединение P2P (mesh, до 8 участников)' },
    { value: 'sfu', label: 'Через SFU (один сервер пересылки)' },
    { value: 'broadcast', label: 'Трансляция (broadcast, вебинар)' },
  ];

  const mediaTone = (mode: string): 'success' | 'info' | 'warning' =>
    mode === 'mesh' ? 'success' : mode === 'sfu' ? 'info' : 'warning';

  const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

  const scaleNumberField = (
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (value: number) => void,
    hint?: string,
  ): HTMLElement => {
    const input = textInput({
      type: 'number',
      value: String(value),
      min,
      max,
      onChange: (raw) => {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) onChange(Math.min(max, Math.max(min, Math.round(parsed))));
      },
    });
    return field(label, input, hint ? { hint } : {});
  };

  const turnTestControl = (id: string, enabled: boolean): HTMLElement => {
    const host = h('span', { class: 'notice', attrs: { role: 'status' } });
    const test = button(t('turn.test.label'), { variant: 'ghost', size: 'sm', icon: 'play', disabled: !enabled });
    if (!enabled) test.title = t('turn.test.saveFirst');
    test.addEventListener('click', () => {
      void (async () => {
        setButtonLoading(test, true);
        host.textContent = t('turn.test.pending');
        host.className = 'notice';
        try {
          const result = await ctx.api.testTurnServer(id);
          host.textContent = [
            t(result.ok ? 'turn.test.ok' : 'turn.test.failed'),
            result.latencyMs !== undefined ? t('turn.test.latency', { duration: result.latencyMs }) : undefined,
            result.detail,
          ].filter(Boolean).join(' · ');
          host.className = result.ok ? 'notice text-success' : 'notice text-danger';
          ctx.toast(t(result.ok ? 'turn.test.successToast' : 'turn.test.failureToast', { id }), result.ok ? 'success' : 'error');
        } catch (error) {
          const info = describeError(error);
          if (info.offline) ctx.setServerStatus('offline');
          host.textContent = `${info.title}: ${info.message}`;
          host.className = 'notice text-danger';
        } finally {
          setButtonLoading(test, false);
        }
      })();
    });
    return h('div', { class: 'row', attrs: { style: 'gap:8px;align-items:flex-start' } }, test, host);
  };

  const renderScaleStatus = (): HTMLElement[] => {
    if (!scaleStatus) {
      return [errorState(scaleError ?? new Error('Не удалось загрузить настройки масштабирования. Проверьте, что сервер запущен, и повторите.'), () => void load())];
    }
    const status = scaleStatus;
    const config = status.config;
    const cluster: ClusterStatusResponse = clusterStatus ?? {
      nodeId: status.cluster.nodeId,
      nodes: status.cluster.nodes,
      strategy: status.cluster.strategy,
      redisConfigured: status.cluster.redisConfigured,
      stickySessions: status.cluster.stickySessions,
      multiNodeActive: false,
    };
    const limitations =
      status.limitations.length > 0
        ? status.limitations.map(limitationLabel)
        : ['Кластер, SFU и трансляция в этой версии не реализованы: настройки принимаются и влияют на ICE и лимиты, автоматическое управление — в планах.'];
    const fragments: HTMLElement[] = [
      alert('warning', 'Ограничения масштабирования', limitations.join(' · ')),
    ];
    const profileParticipants = status.sfuCapacity?.participants;
    if (status.mediaMode !== 'mesh' && profileParticipants !== undefined && config.maxParticipants > profileParticipants) {
      fragments.push(
        alert(
          'warning',
          'Лимит комнат больше ёмкости профиля SFU',
          `scale.maxParticipants = ${config.maxParticipants}, а профиль ${status.sfuProfile ?? status.sfuCapacity?.profile ?? 'standard'} рассчитан на ${profileParticipants} участников. ` +
            `Новые комнаты будут ограничены ${status.effectiveMaxParticipants ?? profileParticipants} участниками; поднимите профиль/ноду или уменьшите scale.maxParticipants.`,
        ),
      );
    }
    fragments.push(
      h(
        'div',
        { class: 'chips' },
        badge(`Режим связи: ${MEDIA_MODE_LABELS[status.mediaMode] ?? status.mediaMode}`, mediaTone(status.mediaMode), { dot: true }),
        badge(`Участников: ${config.maxParticipants}`, 'neutral', { title: 'scale.maxParticipants по умолчанию' }),
        badge(
          `Ёмкость профиля: ${status.sfuProfile ?? 'standard'} · ${profileParticipants ?? '—'}`,
          config.maxParticipants > (profileParticipants ?? Number.POSITIVE_INFINITY) && status.mediaMode !== 'mesh' ? 'warning' : 'info',
          { title: 'Профиль ёмкости SFU определяет эффективный лимит комнаты' },
        ),
        badge(`Эффективный лимит: ${status.effectiveMaxParticipants ?? '—'}`, 'neutral', { title: 'min(room, scale, profile, sfu.maxParticipants)' }),
        badge(`SFU: ${status.sfuConfigured ? 'настроен' : 'не настроен'}`, status.sfuConfigured ? 'success' : 'warning'),
        badge(`Вебинар: ${status.webinarEnabled ? 'вкл' : 'выкл'}`, status.webinarEnabled ? 'info' : 'neutral'),
        badge(`Трансляция: ${status.streamingProvider === 'none' ? 'не настроена' : status.streamingProvider}`, status.streamingProvider !== 'none' ? 'info' : 'neutral'),
        config.streaming.enabled
          ? badge(`Просмотр: ${config.streaming.playbackProtocol === 'whep' ? 'WebRTC (WHEP)' : 'HLS'}`, 'info')
          : null,
        badge(
          `Несколько серверов: ${cluster.multiNodeActive ? 'да' : 'нет'}`,
          cluster.multiNodeActive ? 'success' : 'warning',
          { title: 'Версия работает на одном сервере; статус кластера справочный' },
        ),
      ),
    );
    fragments.push(
      kvGrid([
        { label: 'ID сервера (nodeId)', value: cluster.nodeId || '—' },
        { label: 'Узлов в реестре', value: String(cluster.nodes.length) },
        { label: 'Стратегия балансировки', value: (LB_STRATEGY_LABELS[cluster.strategy] ?? cluster.strategy) || '—' },
        { label: 'Redis', value: cluster.redisConfigured ? 'настроен' : 'один сервер' },
        { label: 'Привязка к серверу (sticky sessions)', value: cluster.stickySessions ? 'да' : 'нет' },
        { label: 'Предел видеопотоков (maxVideoSubscriptions)', value: String(config.maxVideoSubscriptions) },
        { label: 'Профиль ёмкости SFU', value: `${status.sfuProfile ?? 'standard'} (${profileParticipants ?? '—'} участников)` },
        { label: 'Эффективный лимит участников', value: String(status.effectiveMaxParticipants ?? '—') },
      ]),
    );

    if (cluster.nodes.length > 0) {
      fragments.push(
        h('div', { class: 'section-title', text: 'Серверы сигналинга' }),
        dataTable({
          columns: [
            { key: 'id', header: 'Узел', render: (node) => h('span', { class: 'mono small', text: node.id }) },
            { key: 'url', header: 'Адрес', render: (node) => h('span', { class: 'mono small', text: node.url || '—' }) },
            { key: 'region', header: 'Регион', render: (node) => node.region || '—' },
            { key: 'weight', header: 'Вес', align: 'right' as const, render: (node) => String(node.weight) },
            {
              key: 'healthy',
              header: 'Состояние',
              render: (node) =>
                node.healthy === true
                  ? badge('работает', 'success', { dot: true })
                  : node.healthy === false
                    ? badge('не работает', 'danger', { dot: true })
                    : badge('неизвестно', 'neutral'),
            },
          ],
          rows: cluster.nodes,
          empty: emptyState({ title: 'Серверы не зарегистрированы', message: 'В режиме одного сервера список пуст.', compact: true }),
        }),
      );
    }

    fragments.push(h('div', { class: 'section-title', text: t('turn.pool.title') }));
    if (status.turn.length === 0) {
      fragments.push(
        emptyState({
          title: t('turn.pool.empty'),
          message: t('turn.pool.emptyHint'),
          iconName: 'server',
          compact: true,
        }),
      );
    } else {
      fragments.push(
        dataTable({
          columns: [
            { key: 'id', header: t('turn.pool.id'), render: (turn) => h('div', { class: 'cell-stack' },
              h('span', { class: 'mono small', text: turn.id }),
              turn.automatic ? h('span', { class: 'cell-sub', text: t('turn.node.automatic') }) : null) },
            {
              key: 'urls',
              header: t('turn.pool.urls'),
              render: (turn) => h('div', { class: 'cell-stack' }, ...turn.urls.map((url) => h('span', { class: 'cell-sub', text: url }))),
            },
            { key: 'region', header: t('turn.pool.region'), render: (turn) => turn.region || '—' },
            {
              key: 'node',
              header: t('turn.node.label'),
              render: (turn) => turn.nodeId
                ? h(
                  'div',
                  { class: 'cell-stack' },
                  h('span', { class: 'mono small', text: turn.nodeId }),
                  turn.nodeAvailable === true
                    ? badge(t('turn.node.ready'), 'success')
                    : turn.nodeAvailable === false
                      ? badge(t('turn.node.excluded'), 'warning')
                      : badge(t('turn.node.unknown'), 'neutral'),
                  turn.nodeState && turn.nodeState !== 'ready'
                    ? h('span', { class: 'cell-sub', text: t(`turn.node.${turn.nodeState}`) })
                    : null,
                )
                : '—',
            },
            { key: 'weight', header: t('turn.pool.weight'), align: 'right' as const, render: (turn) => String(turn.weight) },
            {
              key: 'creds',
              header: t('turn.pool.credentials'),
              render: (turn) => turn.credentialMode === 'rest'
                ? h('div', { class: 'chips' },
                  badge(t('turn.auth.rest'), 'neutral'),
                  badge(t(turn.credentialConfigured ? 'turn.auth.signingReady' : 'turn.auth.signingMissing'),
                    turn.credentialConfigured ? 'success' : 'warning'))
                :
                h(
                  'div',
                  { class: 'chips' },
                  badge(t(turn.usernameConfigured ? 'turn.auth.usernameReady' : 'turn.auth.usernameMissing'), turn.usernameConfigured ? 'success' : 'warning'),
                  badge(t(turn.credentialConfigured ? 'turn.auth.passwordReady' : 'turn.auth.passwordMissing'), turn.credentialConfigured ? 'success' : 'warning', { title: t('turn.auth.passwordHint') }),
                ),
            },
            { key: 'test', header: t('turn.test.header'), render: (turn) => turn.automatic ? '—' : turnTestControl(turn.id, true) },
          ],
          rows: status.turn,
          className: 'table-cards turn-pool-table',
        }),
      );
    }
    return fragments;
  };

  const collectScaleErrors = (draft: ScaleConfig): string[] => {
    const errors: string[] = [];
    const isHttp = (value: string): boolean => !value || /^https?:\/\//i.test(value);
    const isWs = (value: string): boolean => !value || /^wss?:\/\//i.test(value);
    const isRedis = (value: string): boolean => !value || /^rediss?:\/\//i.test(value);
    const isTurn = (value: string): boolean => /^turns?:/i.test(value);
    if (draft.signaling.redisUrl && !isRedis(draft.signaling.redisUrl)) errors.push('Адрес Redis (redisUrl): ожидается redis:// или rediss://.');
    for (const [index, node] of draft.signaling.nodes.entries()) {
      if (!node.id.trim()) errors.push(`Узел №${index + 1}: укажите идентификатор.`);
      if (node.url && !isHttp(node.url)) errors.push(`Узел ${node.id || index + 1}: адрес должен начинаться с http(s)://.`);
    }
    if (draft.sfu.url && !isWs(draft.sfu.url)) errors.push('Адрес SFU (sfu.url): ожидается ws:// или wss://.');
    if (draft.sfu.apiKeyEnv && !ENV_NAME.test(draft.sfu.apiKeyEnv)) errors.push('Ключ SFU (sfu.apiKeyEnv): только имя переменной окружения.');
    if (draft.sfu.apiSecretEnv && !ENV_NAME.test(draft.sfu.apiSecretEnv)) errors.push('Секрет SFU (sfu.apiSecretEnv): только имя переменной окружения.');
    for (const [index, turn] of draft.turn.entries()) {
      if (!turn.id.trim()) errors.push(`TURN №${index + 1}: укажите идентификатор.`);
      if (turn.urls.length === 0) errors.push(`TURN ${turn.id || index + 1}: нужен хотя бы один адрес.`);
      for (const url of turn.urls) {
        if (!isTurn(url)) errors.push(`TURN ${turn.id || index + 1}: адрес должен начинаться с turn: или turns:.`);
      }
      if (turn.credentialEnv && !ENV_NAME.test(turn.credentialEnv)) errors.push(`TURN ${turn.id || index + 1}: credentialEnv — только имя переменной окружения.`);
    }
    if (draft.streaming.enabled) {
      if (draft.streaming.provider === 'rtmp' && draft.streaming.rtmpUrl && !/^rtmps?:\/\//i.test(draft.streaming.rtmpUrl)) {
        errors.push('Адрес RTMP (streaming.rtmpUrl): ожидается rtmp:// или rtmps://.');
      }
      if (draft.streaming.hlsUrl && !isHttp(draft.streaming.hlsUrl)) errors.push('Адрес HLS (streaming.hlsUrl): ожидается http(s)://.');
      if (draft.streaming.whepUrl && !isHttp(draft.streaming.whepUrl)) errors.push('Для адреса WHEP укажите http:// или https://.');
      if (draft.streaming.playbackProtocol === 'whep' && !draft.streaming.whepUrl) errors.push('Укажите адрес WHEP для просмотра через WebRTC.');
    }
    if (draft.cdn.enabled && draft.cdn.baseUrl && !isHttp(draft.cdn.baseUrl)) errors.push('Базовый адрес CDN (cdn.baseUrl): ожидается http(s)://.');
    return errors;
  };

  const renderScaleEditor = (draft: ScaleConfig): HTMLElement => {
    const root = h('div', { class: 'stack' });
    const validationHost = h('div', { attrs: { 'aria-live': 'polite' } });
    const nodesHost = h('div', { class: 'stack' });
    const turnHost = h('div', { class: 'stack' });
    let turnNodes: NodeSummary[] = [];
    const nodeStatus = h('div', { class: 'muted small', attrs: { role: 'status' } });
    const tlsHint = (endpoint: NodeSummary['turnEndpoint']) => {
      if (!endpoint?.tlsPort) return '';
      const { tlsPort: port, tlsHostname: host } = endpoint;
      return host ? t('turn.node.reportedTlsReady', { host, port }) : t('turn.node.reportedTlsHint', { port });
    };
    const nodeChoice = selectInput([], { id: 'turn-reported-node', onChange: (value) => {
      addReportedRelay.disabled = !value;
      nodeStatus.textContent = tlsHint(turnNodes.find(({ id }) => id === value)?.turnEndpoint);
    } });
    const renderTurnNodes = () => {
      const listed = new Set(draft.turn.map((turn) => turn.nodeId));
      nodeChoice.replaceChildren(h('option', { attrs: { value: '' }, text: t('turn.node.pickPlaceholder') }));
      for (const node of turnNodes) {
        if (!node.turnEndpoint || listed.has(node.id)) continue;
        const { ip, port } = node.turnEndpoint;
        nodeChoice.append(h('option', { attrs: { value: node.id }, text: `${node.id} · ${ip}:${port}` }));
      }
      nodeChoice.disabled = nodeChoice.options.length < 2;
      addReportedRelay.disabled = true;
    };
    const addReportedRelay = button(t('turn.node.addReported'), {
      variant: 'ghost',
      onClick: () => {
        const node = turnNodes.find(({ id }) => id === nodeChoice.value);
        const endpoint = node?.turnEndpoint;
        if (!node || !endpoint || draft.turn.some((turn) => turn.nodeId === node.id)) return;
        let id = node.id;
        for (let i = 1; draft.turn.some((turn) => turn.id === id); i += 1) id = `turn-${i}`;
        const address = `turn:${endpoint.ip}:${endpoint.port}`;
        const urls = [address, `${address}?transport=tcp`];
        if (endpoint.tlsHostname && endpoint.tlsPort) {
          urls.push(`turns:${endpoint.tlsHostname}:${endpoint.tlsPort}?transport=tcp`);
        }
        draft.turn.push({ id, nodeId: node.id, urls,
          credentialMode: endpoint.credentialMode ?? 'static', username: '', credentialEnv: '', region: node.region, weight: 100 });
        nodeStatus.textContent = [t('turn.node.addedReported'), tlsHint(endpoint)].filter(Boolean).join(' ');
        renderTurn();
        turnHost.querySelector<HTMLTextAreaElement>('.excerpt:last-child textarea')?.focus();
      },
    });
    const loadTurnNodes = button(t('turn.node.loadReported'), {
      variant: 'ghost',
      onClick: async () => {
        setButtonLoading(loadTurnNodes, true);
        nodeStatus.textContent = '';
        try {
          turnNodes = (await ctx.api.nodes({ status: 'online' })).filter((node) => node.turnReady && node.turnEndpoint);
          renderTurnNodes();
          if (nodeChoice.disabled) nodeStatus.textContent = t('turn.node.noReported');
        } catch {
          turnNodes = [];
          renderTurnNodes();
          nodeStatus.textContent = t('turn.node.reportedError');
        } finally {
          setButtonLoading(loadTurnNodes, false);
        }
      },
    });

    const renderNodes = (): void => {
      nodesHost.replaceChildren();
      if (draft.signaling.nodes.length === 0) {
        nodesHost.appendChild(h('p', { class: 'notice', text: 'Список узлов пуст: работает один сервер.' }));
        return;
      }
      draft.signaling.nodes.forEach((node, index) => {
        const idInput = textInput({
          value: node.id,
          placeholder: 'node-1',
          onInput: (value) => {
            node.id = value.trim();
          },
        });
        const urlInput = textInput({
          value: node.url,
          placeholder: 'https://calls-1.example',
          onInput: (value) => {
            node.url = value.trim();
          },
        });
        const regionInput = textInput({
          value: node.region,
          placeholder: 'ru-msk',
          onInput: (value) => {
            node.region = value.trim();
          },
        });
        const weightInput = textInput({
          type: 'number',
          value: String(node.weight),
          min: 1,
          max: 100,
          onChange: (value) => {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) node.weight = Math.min(100, Math.max(1, Math.round(parsed)));
          },
        });
        nodesHost.appendChild(
          h(
            'div',
            { class: 'rule-row', attrs: { style: 'grid-template-columns:1fr 1.5fr .8fr 80px auto' } },
            idInput,
            urlInput,
            regionInput,
            weightInput,
            button(undefined, {
              variant: 'danger-ghost',
              size: 'sm',
              icon: 'trash',
              title: 'Удалить узел',
              onClick: () => {
                draft.signaling.nodes.splice(index, 1);
                renderNodes();
              },
            }),
          ),
        );
      });
    };

    const renderTurn = (): void => {
      renderTurnNodes();
      turnHost.replaceChildren();
      if (draft.turn.length === 0) {
        turnHost.appendChild(h('p', { class: 'notice', text: 'TURN-серверы не добавлены — используется только STUN.' }));
        return;
      }
      draft.turn.forEach((turn, index) => {
        const urlsArea = textareaInput({
          value: turn.urls.join('\n'),
          rows: 2,
          placeholder: 'turn:turn-msk.example:3478?transport=udp\nturns:turn-msk.example:5349',
          ariaLabel: t('turn.urls.label', { index: index + 1 }),
          onInput: (value) => {
            turn.urls = value
              .split(/\n+/)
              .map((item) => item.trim())
              .filter(Boolean);
          },
        });
        const idInput = textInput({
          value: turn.id,
          placeholder: 'turn-msk',
          onInput: (value) => {
            turn.id = value.trim();
          },
        });
        const usernameInput = textInput({
          value: turn.username,
          placeholder: 'agil',
          onInput: (value) => {
            turn.username = value.trim();
          },
        });
        const nodeInput = textInput({
          value: turn.nodeId ?? '',
          placeholder: 'turn-edge-1',
          onInput: (value) => {
            const nodeId = value.trim();
            if (nodeId) turn.nodeId = nodeId;
            else delete turn.nodeId;
          },
        });
        const credentialInput = textInput({
          value: turn.credentialEnv,
          placeholder: 'AGIL_TURN_MSK_SECRET',
          onInput: (value) => {
            turn.credentialEnv = value.trim();
          },
        });
        const updateStaticInputs = () => {
          usernameInput.disabled = turn.credentialMode === 'rest';
          credentialInput.disabled = turn.credentialMode === 'rest';
        };
        const credentialMode = selectInput([
          { value: 'static', label: t('turn.auth.static') },
          { value: 'rest', label: t('turn.auth.rest') },
        ], {
          value: turn.credentialMode ?? 'static',
          onChange(value) {
            turn.credentialMode = value === 'rest' ? 'rest' : 'static';
            updateStaticInputs();
          },
        });
        updateStaticInputs();
        const regionInput = textInput({
          value: turn.region,
          placeholder: 'ru-msk',
          onInput: (value) => {
            turn.region = value.trim();
          },
        });
        const weightInput = textInput({
          type: 'number',
          value: String(turn.weight),
          min: 1,
          max: 100,
          onChange: (value) => {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) turn.weight = Math.min(100, Math.max(1, Math.round(parsed)));
          },
        });
        turnHost.appendChild(
          h(
            'div',
            { class: 'excerpt' },
            h(
              'div',
              { class: 'row' },
              h('span', { class: 'section-title', text: `TURN ${index + 1}` }),
              h('span', { class: 'mono small', text: turn.id || '—' }),
              h('span', { class: 'spacer' }),
              button(undefined, {
                variant: 'danger-ghost',
                size: 'sm',
                icon: 'trash',
                title: 'Удалить TURN-сервер',
                onClick: () => {
                  draft.turn.splice(index, 1);
                  renderTurn();
                },
              }),
            ),
            formGrid(
              field('ID (id)', idInput),
              field('ID узла (необязательно)', nodeInput, { hint: t('turn.node.linkHint') }),
              field('Адреса (urls, по одному на строку)', urlsArea, { className: 'field-span-2', hint: 'turn: / turns:; можно несколько адресов на один сервер.' }),
              field(t('turn.auth.mode'), credentialMode, { className: 'field-span-2', hint: t('turn.auth.restHint') }),
              field('Логин (username)', usernameInput),
              field('Ключ: переменная окружения (credentialEnv)', credentialInput, { hint: t('turn.node.credentialEnvHint') }),
              field('Регион (region)', regionInput),
              field('Вес (weight)', weightInput),
            ),
            turnTestControl(turn.id, false),
          ),
        );
      });
    };

    const modeSelect = selectInput(MEDIA_MODES, {
      value: draft.mediaMode,
      onChange: (value) => {
        draft.mediaMode = value as ScaleConfig['mediaMode'];
      },
    });
    const sfuProviderSelect = selectInput(
      [
        { value: 'livekit', label: 'LiveKit (livekit)' },
        { value: 'mediasoup', label: 'mediasoup (mediasoup)' },
        { value: 'external', label: 'Свой сервис (external)' },
      ],
      {
        value: draft.sfu.provider,
        onChange: (value) => {
          draft.sfu.provider = value as ScaleConfig['sfu']['provider'];
        },
      },
    );
    const lbStrategySelect = selectInput(
      [
        { value: 'round-robin', label: 'По кругу (round-robin)' },
        { value: 'least-rooms', label: 'Меньше комнат (least-rooms)' },
        { value: 'geo', label: 'По географии (geo)' },
        { value: 'weighted', label: 'По весу (weighted)' },
      ],
      {
        value: draft.loadBalancer.strategy,
        onChange: (value) => {
          draft.loadBalancer.strategy = value as ScaleConfig['loadBalancer']['strategy'];
        },
      },
    );
    const webinarChatSelect = selectInput(
      [
        { value: 'moderated', label: 'Через модерацию (moderated)' },
        { value: 'open', label: 'Свободный чат (open)' },
      ],
      {
        value: draft.webinar.chatMode,
        onChange: (value) => {
          draft.webinar.chatMode = value as ScaleConfig['webinar']['chatMode'];
        },
      },
    );
    const streamingProviderSelect = selectInput(
      [
        { value: 'none', label: 'Не используется (none)' },
        { value: 'rtmp', label: 'RTMP (rtmp)' },
        { value: 'hls', label: 'HLS (hls)' },
        { value: 'webrtc', label: 'WebRTC (webrtc)' },
      ],
      {
        value: draft.streaming.provider,
        onChange: (value) => {
          draft.streaming.provider = value as ScaleConfig['streaming']['provider'];
        },
      },
    );
    const latencySelect = selectInput(
      [
        { value: 'low', label: 'Низкая задержка (low)' },
        { value: 'standard', label: 'Стандартная (standard)' },
      ],
      {
        value: draft.streaming.latencyMode,
        onChange: (value) => {
          draft.streaming.latencyMode = value as ScaleConfig['streaming']['latencyMode'];
        },
      },
    );

    const save = button(t('scale.save'), { variant: 'primary', icon: 'check' });
    save.addEventListener('click', () => {
      void (async () => {
        const errors = collectScaleErrors(draft);
        if (errors.length > 0) {
          validationHost.replaceChildren(alert('danger', 'Проверьте поля', errors.join(' · ')));
          return;
        }
        validationHost.replaceChildren();
        setButtonLoading(save, true);
        try {
          const result = await guardedSave('scale', draft, 'сохранить масштабирование и режим связи', async () =>
            ctx.api.updateScale(draft),
          );
          if (!result.allowed || !result.value) return;
          const response = result.value;
          scaleStatus = response;
          scaleError = null;
          scaleDraft = structuredClone(response.config);
          try {
            clusterStatus = await ctx.api.clusterStatus();
          } catch {
            /* cluster status is advisory */
          }
          ctx.toast('Настройки масштабирования сохранены', 'success');
          renderScaleBody();
        } catch (error) {
          toastError(ctx, error);
          validationHost.replaceChildren(errorState(error, () => void load()));
        } finally {
          setButtonLoading(save, false);
        }
      })();
    });

    root.append(
      h('div', { class: 'section-title', text: 'Медиа и лимиты' }),
      formGrid(
        field('Режим связи (mediaMode)', modeSelect, { hint: 'Прямое соединение (mesh) — для небольших комнат; SFU и трансляция — при наличии инфраструктуры.' }),
        scaleNumberField('Максимум участников (maxParticipants)', draft.maxParticipants, 2, 50000, (value) => {
          draft.maxParticipants = value;
        }),
        scaleNumberField('Максимум видеопотоков (maxVideoSubscriptions)', draft.maxVideoSubscriptions, 1, 1000, (value) => {
          draft.maxVideoSubscriptions = value;
        }),
      ),
      h('div', { class: 'section-title', text: 'Несколько серверов (сигналинг)' }),
      formGrid(
        field('ID сервера (nodeId)', textInput({
          value: draft.signaling.nodeId,
          onInput: (value) => {
            draft.signaling.nodeId = value.trim();
          },
        })),
        field('Адрес Redis (redisUrl)', textInput({
          value: draft.signaling.redisUrl,
          placeholder: 'redis://redis:6379',
          onInput: (value) => {
            draft.signaling.redisUrl = value.trim();
          },
        }), { hint: 'Пусто — один сервер. redis:// или rediss://.' }),
        field('Канал обмена (pubsubChannel)', textInput({
          value: draft.signaling.pubsubChannel,
          onInput: (value) => {
            draft.signaling.pubsubChannel = value.trim();
          },
        })),
      ),
      checkboxField({
        label: 'Привязка участника к серверу (signaling.stickySessions)',
        description: 'Участник комнаты всегда направляется на один и тот же сервер.',
        checked: draft.signaling.stickySessions,
        onChange: (checked) => {
          draft.signaling.stickySessions = checked;
        },
      }),
      h('div', { class: 'section-title', text: 'Реестр узлов' }),
      nodesHost,
      button('Добавить узел', {
        variant: 'ghost',
        size: 'sm',
        icon: 'plus',
        onClick: () => {
          draft.signaling.nodes.push({ id: `node-${draft.signaling.nodes.length + 1}`, url: '', region: '', weight: 100 });
          renderNodes();
        },
      }),
      h('div', { class: 'section-title', text: 'SFU (сервер, который пересылает видео участникам)' }),
      formGrid(
        field('Сервис (provider)', sfuProviderSelect),
        field('Адрес (url)', textInput({
          value: draft.sfu.url,
          placeholder: 'wss://sfu.example',
          onInput: (value) => {
            draft.sfu.url = value.trim();
          },
        }), { hint: 'ws:// или wss://.' }),
        field('Ключ: переменная окружения (apiKeyEnv)', textInput({
          value: draft.sfu.apiKeyEnv,
          onInput: (value) => {
            draft.sfu.apiKeyEnv = value.trim();
          },
        }), { hint: 'Имя переменной окружения.' }),
        field('Секрет: переменная окружения (apiSecretEnv)', textInput({
          value: draft.sfu.apiSecretEnv,
          onInput: (value) => {
            draft.sfu.apiSecretEnv = value.trim();
          },
        }), { hint: 'Имя переменной окружения.' }),
        field('Регион (region)', textInput({
          value: draft.sfu.region,
          onInput: (value) => {
            draft.sfu.region = value.trim();
          },
        })),
        scaleNumberField('Максимум участников (maxParticipants)', draft.sfu.maxParticipants, 2, 50000, (value) => {
          draft.sfu.maxParticipants = value;
        }),
      ),
      h('div', { class: 'section-title', text: 'TURN-пул' }),
      formGrid(field(t('turn.node.pickLabel'), nodeChoice, { hint: t('turn.node.pickHint') })),
      h('div', { class: 'actions' }, loadTurnNodes, addReportedRelay),
      nodeStatus,
      turnHost,
      button('Добавить TURN-сервер', {
        variant: 'ghost',
        size: 'sm',
        icon: 'plus',
        onClick: () => {
          draft.turn.push({
            id: `turn-${draft.turn.length + 1}`,
            urls: [],
            username: '',
            credentialEnv: '',
            region: '',
            weight: 100,
          });
          renderTurn();
        },
      }),
      h('div', { class: 'section-title', text: 'Балансировка нагрузки' }),
      formGrid(
        field('Стратегия (strategy)', lbStrategySelect),
        field('Путь проверки (healthPath)', textInput({
          value: draft.loadBalancer.healthPath,
          onInput: (value) => {
            draft.loadBalancer.healthPath = value.trim();
          },
        })),
        field('Cookie привязки (stickyCookie)', textInput({
          value: draft.loadBalancer.stickyCookie,
          onInput: (value) => {
            draft.loadBalancer.stickyCookie = value.trim();
          },
        })),
      ),
      h('div', { class: 'section-title', text: 'Вебинар (трансляция)' }),
      h(
        'div',
        { class: 'checkbox-grid' },
        checkboxField({
          label: 'Вебинар включён (webinar.enabled)',
          checked: draft.webinar.enabled,
          onChange: (checked) => {
            draft.webinar.enabled = checked;
          },
        }),
        checkboxField({
          label: 'Публикуют только организатор и модератор (hostOnlyPublish)',
          description: 'Зрители только смотрят и слушают.',
          checked: draft.webinar.hostOnlyPublish,
          onChange: (checked) => {
            draft.webinar.hostOnlyPublish = checked;
          },
        }),
        checkboxField({
          label: 'Реакции (reactions)',
          checked: draft.webinar.reactions,
          onChange: (checked) => {
            draft.webinar.reactions = checked;
          },
        }),
        checkboxField({
          label: 'Очередь поднятых рук (raiseHandQueue)',
          checked: draft.webinar.raiseHandQueue,
          onChange: (checked) => {
            draft.webinar.raiseHandQueue = checked;
          },
        }),
      ),
      formGrid(
        scaleNumberField('Лимит зрителей (viewerLimit)', draft.webinar.viewerLimit, 2, 50000, (value) => {
          draft.webinar.viewerLimit = value;
        }),
        field('Режим чата (chatMode)', webinarChatSelect),
      ),
      h('div', { class: 'section-title', text: 'Трансляция' }),
      checkboxField({
        label: 'Трансляция включена (streaming.enabled)',
        checked: draft.streaming.enabled,
        onChange: (checked) => {
          draft.streaming.enabled = checked;
        },
      }),
      formGrid(
        field('Провайдер трансляции', streamingProviderSelect),
        field('Протокол для зрителей', selectInput([
          { value: 'hls', label: 'HLS' },
          { value: 'whep', label: 'WebRTC (WHEP)' },
        ], {
          value: draft.streaming.playbackProtocol,
          onChange: (value) => { draft.streaming.playbackProtocol = value === 'whep' ? 'whep' : 'hls'; },
        }), { hint: 'HLS подходит для просмотра через CDN. WebRTC сокращает задержку, если Edge публикует WHEP.' }),
        field('Адрес RTMP (rtmpUrl)', textInput({
          value: draft.streaming.rtmpUrl,
          placeholder: 'rtmp://live.youtube.com/app/key',
          onInput: (value) => {
            draft.streaming.rtmpUrl = value.trim();
          },
        })),
        field('Адрес HLS (hlsUrl)', textInput({
          value: draft.streaming.hlsUrl,
          placeholder: 'https://cdn.example/hls/stream.m3u8',
          onInput: (value) => {
            draft.streaming.hlsUrl = value.trim();
          },
        })),
        field('Задержка (latencyMode)', latencySelect),
        field('Адрес WHEP', textInput({
          type: 'url',
          value: draft.streaming.whepUrl,
          placeholder: 'https://edge.example/live/whep',
          onInput: (value) => { draft.streaming.whepUrl = value.trim(); },
        }), { hint: 'Укажите адрес просмотра на Edge. RTP-источник и преобразование дорожек настраиваются на медианоде.' }),
      ),
      h('div', { class: 'section-title', text: 'CDN (сеть доставки файлов)' }),
      checkboxField({
        label: 'CDN включён (cdn.enabled)',
        checked: draft.cdn.enabled,
        onChange: (checked) => {
          draft.cdn.enabled = checked;
        },
      }),
      formGrid(
        field('Базовый адрес (baseUrl)', textInput({
          value: draft.cdn.baseUrl,
          placeholder: 'https://cdn.example',
          onInput: (value) => {
            draft.cdn.baseUrl = value.trim();
          },
        })),
        field('Сервис (provider)', textInput({
          value: draft.cdn.provider,
          placeholder: 'cloudflare / akamai',
          onInput: (value) => {
            draft.cdn.provider = value.trim();
          },
        })),
      ),
      alert(
        'info',
        'Что уже работает, а что в планах',
        'Настройки принимаются и проверяются, влияют на список ICE-серверов в welcome.iceServers и лимиты комнат. Автоматическое управление кластером, SFU и выводом записи — отдельный этап (docs/backlog.md, B1–B6).',
      ),
      validationHost,
      h('div', { class: 'actions' }, save),
    );
    renderNodes();
    renderTurn();
    return root;
  };

  const renderScaleOverview = (): void => {
    if (scaleError !== null && !scaleStatus) {
      scaleOverview.replaceChildren(errorState(scaleError, () => void load()));
      return;
    }
    if (!scaleStatus) {
      scaleOverview.replaceChildren(loadingPanel('Загружаем масштабирование…'));
      return;
    }
    scaleOverview.replaceChildren(...renderScaleStatus());
    if (scaleError !== null) {
      scaleOverview.appendChild(alert('warning', 'Часть статусов не загрузилась', describeError(scaleError).message));
    }
  };

  const renderScaleBody = (): void => {
    renderScaleOverview();
    scaleBody.replaceChildren(scaleOverview);
    if (!scaleStatus) return;
    if (scaleEditing) {
      if (scaleDraft) scaleBody.appendChild(renderScaleEditor(scaleDraft));
      else scaleBody.appendChild(alert('warning', 'Редактор недоступен', 'Настройки масштабирования не загружены — обновите страницу.'));
    }
  };

  const scalingCard = (): HTMLElement => {
    const editButton = button(t('scale.edit'), { variant: 'ghost', size: 'sm', icon: 'settings' });
    const syncEditButton = (): void => {
      editButton.replaceChildren(
        icon(scaleEditing ? 'x' : 'settings', 14),
        h('span', { text: t(scaleEditing ? 'scale.hideEditor' : 'scale.edit') }),
      );
    };
    syncEditButton();
    editButton.addEventListener('click', () => {
      scaleEditing = !scaleEditing;
      syncEditButton();
      renderScaleBody();
    });
    const refresh = button(undefined, { variant: 'subtle', size: 'sm', icon: 'refresh', title: t('turn.status.refresh') });
    refresh.addEventListener('click', () => {
      void (async () => {
        const previous = scaleStatus;
        setButtonLoading(refresh, true);
        try {
          const latest = await ctx.api.scale();
          if (destroyed || scaleStatus !== previous) return;
          scaleStatus = latest;
          scaleError = null;
          if (!scaleDraft) {
            scaleDraft = structuredClone(latest.config);
            renderScaleBody();
          } else {
            renderScaleOverview();
          }
          ctx.toast(t('turn.status.refreshed'), 'success');
        } catch (error) {
          if (!destroyed) toastError(ctx, error);
        } finally {
          setButtonLoading(refresh, false);
        }
      })();
    });
    const docs = h(
      'a',
      { class: 'btn btn-subtle btn-sm', attrs: { href: links.scaling, target: '_blank', rel: 'noopener noreferrer', title: 'docs/scaling.md' } },
      'docs/scaling.md',
    );
    const backlog = h(
      'a',
      { class: 'btn btn-subtle btn-sm', attrs: { href: links.backlog, target: '_blank', rel: 'noopener noreferrer', title: 'docs/backlog.md' } },
      'docs/backlog.md',
    );
    return card({
      title: 'Масштабирование',
      subtitle: 'режим связи · кластер · TURN-пул · SFU · вебинар · трансляция',
      actions: [editButton, refresh, docs, backlog],
      body: scaleBody,
    });
  };

  /* --------------------------- docs / links --------------------------- */

  const renderDocsCard = (): HTMLElement => {
    const linkRow = (label: string, url: string, docName?: string): HTMLElement => {
      const row = h('div', { class: 'link-row' });
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
        h(
          'a',
          { class: 'btn btn-subtle btn-sm', attrs: { href: url, target: '_blank', rel: 'noopener noreferrer', title: `Открыть raw-файл ${label}` } },
          icon('external', 16),
        ),
      );
      return row;
    };
    return card({
      title: 'Документация API',
      subtitle: 'Спецификация OpenAPI 3.1 и документация API доступны офлайн',
      body: h(
        'div',
        { class: 'stack' },
        field('Документация API (руководство, поиск, curl)', linkRow('/docs', links.apiDocs)),
        field('Спецификация OpenAPI (для Swagger, Postman и генерации кода)', linkRow('/openapi.json', links.openapi)),
        alert(
          'info',
          'Спецификация OpenAPI — для инструментов',
          'Спецификация OpenAPI нужна Swagger, Postman и генераторам кода. Людям — документация API с руководством, поиском, примерами curl и кодами ошибок. Руководство интегратора и справочник API — текстовые документы.',
        ),
        field(
          'Аудит безопасности и конфиденциальности',
          linkRow('docs/security-audit.md', links.securityAudit, 'security-audit.md'),
        ),
        field('Расширения и внешние сервисы', linkRow('docs/extensibility.md', links.extensibility, 'extensibility.md')),
        field('Интеграция с мессенджером', linkRow('docs/messenger.md', links.messenger, 'messenger.md')),
      field('Масштабирование и несколько серверов', linkRow('docs/scaling.md', links.scaling, 'scaling.md')),
      field('План развития', linkRow('docs/backlog.md', links.backlog, 'backlog.md')),
      field('Руководство интегратора (простыми словами)', linkRow('docs/api-guide.md', links.apiGuide, 'api-guide.md')),
      field('Справочник API', linkRow('docs/api.md', links.apiMd, 'api.md')),
      field('Контракт монорепо', linkRow('docs/contract.md', links.contract, 'contract.md')),
        alert(
          'warning',
          'Встраивание и CSP',
          'Сервер добавляет защитные заголовки и может запретить встраивание (Content-Security-Policy frame-ancestors или X-Frame-Options). Панель открывайте с того же адреса (origin), а внешние сайты добавьте в «Разрешённые адреса». Если iframe не загрузился — проверьте CSP в инструментах разработчика (DevTools → Network → Docs).',
        ),
      ),
    });
  };

  /* ------------------------------- page ------------------------------- */

  const renderSipCard = (): HTMLElement => {
    const statusHost = h('div', { attrs: { 'aria-live': 'polite' } });
    let loading = false;
    const refreshStatus = async (): Promise<void> => {
      if (loading || destroyed) return;
      loading = true;
      statusHost.setAttribute('aria-busy', 'true');
      statusHost.replaceChildren(h('p', { class: 'notice', text: t('sip.status.loading') }));
      try {
        const status = await ctx.api.sipStatus();
        if (destroyed) return;
        const setup = !status.configured ? 'sip.status.missing'
          : status.enabled ? 'sip.status.configured' : 'sip.status.disabled';
        const rows = [
          { label: t('sip.status.connection'), value: badge(t(setup), status.enabled ? 'neutral' : 'warning') },
          { label: t('sip.status.trunk'), value: badge(t(status.trunkConfigured ? 'sip.status.configured' : 'sip.status.missing'),
            status.trunkConfigured ? 'neutral' : 'warning') },
          ...(status.nodeAvailable === undefined ? [] : [{
            label: t('sip.status.node'),
            value: badge(t(status.nodeAvailable ? 'sip.status.available' : 'sip.status.unavailable'),
              status.nodeAvailable ? 'success' : 'danger'),
          }]),
          { label: t('sip.status.active'), value: h('span', { text: String(status.active) }) },
        ];
        statusHost.replaceChildren(kvGrid(rows));
      } catch {
        if (!destroyed) statusHost.replaceChildren(alert('warning', t('sip.status.failed')));
      } finally {
        loading = false;
        statusHost.removeAttribute('aria-busy');
      }
    };
    const result = card({
      title: t('sip.status.title'),
      className: 'sip-status-card',
      body: statusHost,
      actions: [refreshButton(refreshStatus, t('sip.status.refresh'))],
    });
    void refreshStatus();
    return result;
  };

  const renderPage = (): void => {
    const restoreSearchFocus = document.activeElement === deliverySearch.input;
    saveIdentityButton.disabled = false;
    const webhooksCard = renderWebhooks();
    const deliveriesBody = h('div');
    deliveriesHost = deliveriesBody;
    renderDeliveries();
    const rootStack = h(
      'div',
      { class: 'stack' },
      renderIdentityCard(),
      providersCard(),
      scalingCard(),
      renderSipCard(),
      webhooksCard,
      card({
        title: 'Последние доставки',
        subtitle: 'Последние попытки доставки уведомлений на ваш сервер.',
        body: [deliverySearch.el, deliveriesBody],
        flush: true,
        actions: [refreshButton(() => refreshDeliveries(), 'Обновить')],
      }),
      renderDocsCard(),
    );
    body.replaceChildren(rootStack);
    if (restoreSearchFocus) deliverySearch.input.focus({ preventScroll: true });
    renderProvidersBody();
    renderScaleBody();
  };

  let loadPromise: Promise<void> | null = null;
  const load = async (): Promise<void> => {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      body.replaceChildren(loadingPanel('Загружаем интеграции…'), skeletonTable(3, 4));
      const [configResult, webhooksResult, providersResult, scaleResult, clusterResult] = await Promise.allSettled([
        ctx.api.getConfig(ctx.tenantId),
        ctx.api.webhooks(),
        ctx.api.providers(),
        ctx.api.scale(),
        ctx.api.clusterStatus(),
      ]);
      if (destroyed) return;
      if (configResult.status === 'rejected') {
        const info = describeError(configResult.reason);
        if (info.offline) ctx.setServerStatus('offline');
        const fragments: HTMLElement[] = [errorState(configResult.reason, () => void load())];
        if (info.offline) fragments.push(offlinePanel(() => void load()));
        body.replaceChildren(...fragments);
        return;
      }
      ctx.setServerStatus('online');
      config = configResult.value;
      const integrations: IntegrationsConfig = config.integrations;
      identity = structuredClone(integrations.identity);
      allowedOrigins = [...integrations.allowedOrigins];
      embedPostMessage = integrations.embedPostMessage;
      identityError = null;
      if (webhooksResult.status === 'fulfilled') {
        loadWebhooks(webhooksResult.value.webhooks);
        deliveries = webhooksResult.value.recentDeliveries;
        webhooksError = null;
      } else {
        loadWebhooks([]);
        deliveries = [];
        webhooksError = webhooksResult.reason;
      }
      providersDraft = structuredClone(config.providers);
      if (providersResult.status === 'fulfilled') {
        providersStatus = providersResult.value.providers;
        providersError = null;
      } else {
        providersStatus = [];
        providersError = providersResult.reason;
      }
      if (scaleResult.status === 'fulfilled') {
        scaleStatus = scaleResult.value;
        scaleDraft = structuredClone(scaleResult.value.config);
        scaleError = null;
      } else {
        scaleStatus = null;
        scaleDraft = null;
        scaleError = scaleResult.reason;
      }
      clusterStatus = clusterResult.status === 'fulfilled' ? clusterResult.value : null;
      renderPage();
    })().finally(() => {
      loadPromise = null;
    });
    return loadPromise;
  };

  void load();
  return { el: root, destroy: () => { destroyed = true; } };
};
