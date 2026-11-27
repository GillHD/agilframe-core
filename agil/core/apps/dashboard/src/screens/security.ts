/**
 * Security: tenant security config (passwords/lobby/geo/media integrity/session
 * binding), the corporate AI agent (§13) and a security overview + audit feed.
 *
 * Saves with PATCH /v1/tenants/:tenantId/config and PUT /v1/admin/ai-agent.
 */
import type {
  AiAgentConfig,
  AiAgentSettingsResponse,
  AuditEntry,
  CompliancePolicyRule,
  SecurityOverview,
  TenantConfig,
  TenantConfigPatch,
  IdentityConfig,
} from '@agil/protocol';
import { DEFAULT_INTEGRATIONS } from '@agil/protocol';
import type { ScreenFactory } from '../context.js';
import { ApiError } from '../api.js';
import type { MediaProcessingStatus, SiemEventConfig, SiemStatus } from '../api.js';
import { h, setButtonLoading } from '../dom.js';
import { describeError } from '../errors.js';
import { countryLabel, formatDateTime, formatNumber } from '../format.js';
import { t } from '../i18n.js';
import { icon } from '../icons.js';
import { badge } from '../ui/badge.js';
import { barList, card } from '../ui/card.js';
import {
  button,
  checkboxField,
  field,
  formGrid,
  formSection,
  rangeField,
  selectInput,
  textareaInput,
  textInput,
} from '../ui/controls.js';
import { emptyState } from '../ui/empty-state.js';
import { guardedSave } from '../ui/guard.js';
import { loadingPanel, skeletonTable } from '../ui/skeleton.js';
import { toast } from '../ui/toast.js';
import { auditEntryRow, auditTypeLabel, SECURITY_AUDIT_TYPES } from '../ui/audit-entry.js';
import {
  alert,
  errorState,
  offlinePanel,
  pageHeader,
  refreshButton,
  toastError,
} from './common.js';
import { AV_SECTION_TITLE, LIVENESS_SECTION_TITLE, buildLivenessAvPatch } from './security-config.js';

const AI_MODES = [
  { value: 'local', label: 'Только локальные правила (local)' },
  { value: 'external', label: 'Внешний ИИ-сервис компании (external)' },
  { value: 'hybrid', label: 'Локальные правила и внешний сервис (hybrid)' },
];

const RULE_TYPES = [
  { value: 'phrase', label: 'Фраза (phrase)' },
  { value: 'regex', label: 'Регулярное выражение (regex)' },
  { value: 'pii', label: 'Персональные данные (pii)' },
  { value: 'external', label: 'Внешний сервис (external)' },
];

const RULE_SEVERITIES = [
  { value: 'info', label: 'Информация (info)' },
  { value: 'warn', label: 'Предупреждение (warn)' },
  { value: 'critical', label: 'Критично (critical)' },
];

const RULE_ACTIONS = [
  { value: 'flag', label: 'Отметить (flag)' },
  { value: 'warn', label: 'Предупредить (warn)' },
  { value: 'mute', label: 'Заглушить (mute)' },
  { value: 'block', label: 'Заблокировать (block)' },
];

const AUDIT_SEVERITIES = [
  { value: 'all', label: 'Все уровни' },
  { value: 'critical', label: 'Критично (critical)' },
  { value: 'warn', label: 'Предупреждение (warn)' },
  { value: 'info', label: 'Информация (info)' },
];

const SIEM_EVENTS = [
  { id: 'room.created', label: 'Создание комнаты' },
  { id: 'join.denied', label: 'Отказ при входе' },
  { id: 'password.failed', label: 'Неверный пароль' },
  { id: 'config.updated', label: 'Изменение конфигурации' },
  { id: 'admin.action', label: 'Действия администратора' },
  { id: 'access.updated', label: 'Изменение доступов' },
  { id: 'integrity.flagged', label: 'Подозрение на подмену медиа' },
  { id: 'webhook.failed', label: 'Ошибка вебхука' },
];

const DEFAULT_SIEM: SiemEventConfig = {
  enabled: false,
  url: '',
  format: 'json',
  secretEnv: 'AGIL_SIEM_SECRET',
  events: ['join.denied', 'password.failed', 'config.updated', 'admin.action'],
};

interface CountryDraft {
  raw: string;
  invalid: string[];
}

function parseCountryDraft(raw: string): CountryDraft {
  const tokens = raw
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const invalid = tokens.filter((token) => !/^[A-Za-z]{2}$/.test(token));
  return { raw, invalid };
}

function formatCountryText(codes: readonly string[]): string {
  return codes.join(', ');
}

function hasCorporateIdentityConfiguration(identity: IdentityConfig): boolean {
  return identity.mode === 'oidc' && Boolean(identity.issuer.trim() && identity.audience.trim() &&
    (identity.jwksUrl.trim() || identity.discovery || identity.discoveryUrl?.trim()));
}

export const securityScreen: ScreenFactory = (ctx) => {
  const root = h('div', { class: 'page' });
  const body = h('div', { class: 'stack' });
  let destroyed = false;
  let config: TenantConfig | null = null;
  let securityOverview: SecurityOverview | null = null;
  let auditEntries: AuditEntry[] = [];
  let aiSettings: AiAgentSettingsResponse | null = null;
  let aiDraft: AiAgentConfig | null = null;
  let aiRules: CompliancePolicyRule[] = [];
  let aiError: unknown = null;
  let mediaStatus: MediaProcessingStatus | null = null;
  let mediaStatusError: unknown = null;
  let identityDraft: IdentityConfig | null = null;
  let siemDraft: SiemEventConfig | null = null;
  let siemStatus: SiemStatus | null = null;
  let siemStatusError: unknown = null;
  let siemEnabledSaved = false;
  let auditType = 'all';
  let auditSeverity = 'all';

  const saveButton = button(t('security.save'), { variant: 'primary', icon: 'check' });
  saveButton.disabled = true;
  const aiSaveButton = button(t('security.saveAi'), { variant: 'primary', icon: 'check' });
  aiSaveButton.disabled = true;

  root.appendChild(
    pageHeader({
      eyebrow: `${t('app.tenant')} ${ctx.tenantId}`,
      title: t('security.title'),
      subtitle: t('security.subtitle'),
      actions: [refreshButton(() => load()), saveButton],
    }),
  );
  root.appendChild(body);

  /* ----------------------------- helpers ------------------------------ */

  const numberSetting = (
    label: string,
    value: number,
    range: { min: number; max: number; hint?: string },
    onChange: (value: number) => void,
  ): HTMLElement => {
    const input = textInput({ type: 'number', value: String(value), min: range.min, max: range.max });
    input.addEventListener('change', () => {
      const parsed = Number(input.value);
      if (!Number.isFinite(parsed)) {
        input.value = String(value);
        return;
      }
      const clamped = Math.min(range.max, Math.max(range.min, Math.round(parsed)));
      input.value = String(clamped);
      onChange(clamped);
    });
    return field(label, input, range.hint ? { hint: range.hint } : {});
  };

  const toggle = (label: string, description: string, checked: boolean, onChange: (value: boolean) => void): HTMLElement =>
    checkboxField({ label, description, checked, onChange });

  /* ---------------------------- AI agent ------------------------------ */

  const renderAiBadges = (statusHost: HTMLElement): void => {
    const endpointConfigured = aiSettings?.endpointConfigured ?? false;
    const apiKeyConfigured = aiSettings?.apiKeyConfigured ?? false;
    statusHost.replaceChildren(
      badge(endpointConfigured ? 'Адрес сервиса задан' : 'Адрес сервиса не задан', endpointConfigured ? 'success' : 'warning', { dot: true }),
      badge(apiKeyConfigured ? 'Ключ в переменной окружения найден' : 'Ключ не найден', apiKeyConfigured ? 'success' : 'warning', { dot: true }),
      badge('Ключи не хранятся на сервере', 'neutral'),
    );
  };

  const renderRules = (host: HTMLElement): void => {
    host.replaceChildren();
    if (aiRules.length === 0) {
      host.appendChild(
        h('p', { class: 'notice', text: 'Правил нет. Локальные правила для персональных данных и фраз из текста политики всё равно применяются.' }),
      );
      return;
    }
    for (const [index, rule] of aiRules.entries()) {
      const enabled = checkboxField({
        label: 'вкл',
        checked: rule.enabled,
        onChange: (checked) => {
          rule.enabled = checked;
        },
      });
      enabled.classList.add('rule-enabled');
      const nameInput = textInput({ value: rule.name, ariaLabel: `Название правила ${index + 1}` });
      nameInput.addEventListener('input', () => {
        rule.name = nameInput.value;
      });
      const typeSelect = selectInput(RULE_TYPES, { value: rule.type, ariaLabel: 'Тип правила' });
      typeSelect.addEventListener('change', () => {
        rule.type = typeSelect.value as CompliancePolicyRule['type'];
      });
      const patternInput = textInput({ value: rule.pattern, ariaLabel: 'Фраза или регулярное выражение', spellcheck: false });
      patternInput.addEventListener('input', () => {
        rule.pattern = patternInput.value;
      });
      const severitySelect = selectInput(RULE_SEVERITIES, { value: rule.severity, ariaLabel: 'Уровень' });
      severitySelect.addEventListener('change', () => {
        rule.severity = severitySelect.value as CompliancePolicyRule['severity'];
      });
      const actionSelect = selectInput(RULE_ACTIONS, { value: rule.action, ariaLabel: 'Действие' });
      actionSelect.addEventListener('change', () => {
        rule.action = actionSelect.value as CompliancePolicyRule['action'];
      });
      const remove = button(undefined, {
        variant: 'danger-ghost',
        size: 'sm',
        icon: 'trash',
        title: 'Удалить правило',
        onClick: () => {
          aiRules.splice(index, 1);
          renderRules(host);
        },
      });
      host.appendChild(
        h('div', { class: 'rule-row' }, enabled, nameInput, typeSelect, patternInput, severitySelect, actionSelect, remove),
      );
    }
  };

  const addRule = (): void => {
    const id = `rule-${crypto.randomUUID().slice(0, 8)}`;
    aiRules.push({
      id,
      name: `Правило ${aiRules.length + 1}`,
      type: 'phrase',
      pattern: '',
      severity: 'warn',
      action: 'flag',
      enabled: true,
    });
  };

  const renderAiSection = (): HTMLElement => {
    if (aiError !== null || !aiDraft) {
      return card({
        title: t('security.aiAgent'),
        body: [
          errorState(aiError ?? new Error('Настройки ИИ-агента недоступны'), () => void load()),
          h('p', { class: 'notice', text: 'Проверьте, что сервер поддерживает настройки ИИ-агента (GET /v1/admin/ai-agent), и повторите.' }),
        ],
      });
    }
    const statusHost = h('div', { class: 'chips' });
    renderAiBadges(statusHost);
    const rulesHost = h('div', { class: 'rules-editor' });
    renderRules(rulesHost);
    const saveAi = (): void => {
      void (async () => {
        if (!aiDraft) return;
        setButtonLoading(aiSaveButton, true);
        try {
          const next = {
            ...aiDraft,
            policyRules: aiRules.map((rule) => ({ ...rule })),
          };
          const result = await guardedSave('config', next, 'сохранить настройки ИИ-агента', async () =>
            ctx.api.updateAiAgent(next),
          );
          if (!result.allowed || !result.value) return;
          const response = result.value;
          aiSettings = response;
          aiDraft = structuredClone(response.config);
          aiRules = structuredClone(response.config.policyRules);
          renderAiBadges(statusHost);
          renderRules(rulesHost);
          ctx.toast('Настройки ИИ-агента сохранены', 'success');
        } catch (error) {
          toastError(ctx, error);
        } finally {
          setButtonLoading(aiSaveButton, false);
        }
      })();
    };
    const saveButtonLocal = button('Сохранить ИИ-агента', { variant: 'primary', icon: 'check', onClick: saveAi });
    aiSaveButton.addEventListener('click', saveAi);

    const bodyStack = h(
      'div',
      { class: 'stack' },
      statusHost,
      alert(
        'info',
        'Секреты не передаются через API',
        'В настройках хранится только имя переменной окружения (apiKeyEnv). Ключ ИИ-агента задаётся на сервере и никогда не попадает в браузер.',
      ),
      formGrid(
        field('Режим', selectInput(AI_MODES, {
          value: aiDraft.mode,
          onChange: (value) => {
            if (aiDraft) aiDraft.mode = value as AiAgentConfig['mode'];
          },
        })),
        field(
          'Адрес сервиса (endpoint)',
          textInput({
            value: aiDraft.endpoint,
            placeholder: 'https://ai.example.com/analyze',
            onInput: (value) => {
              if (aiDraft) aiDraft.endpoint = value.trim();
            },
          }),
          { hint: 'Адрес HTTPS сервиса ИИ вашей компании.' },
        ),
        field(
          'Имя переменной окружения с ключом',
          textInput({
            value: aiDraft.apiKeyEnv,
            onInput: (value) => {
              if (aiDraft) aiDraft.apiKeyEnv = value.trim();
            },
          }),
        ),
        numberSetting('Ожидание ответа, мс', aiDraft.timeoutMs, { min: 500, max: 30000 }, (value) => {
          if (aiDraft) aiDraft.timeoutMs = value;
        }),
        numberSetting('Размер пакета фрагментов', aiDraft.batchSize, { min: 1, max: 200 }, (value) => {
          if (aiDraft) aiDraft.batchSize = value;
        }),
        numberSetting('Хранить результаты, мин', aiDraft.retentionMin, { min: 1, max: 10080 }, (value) => {
          if (aiDraft) aiDraft.retentionMin = value;
        }),
      ),
      h(
        'div',
        { class: 'checkbox-grid' },
        toggle('ИИ-агент включён', 'Без внешнего адреса работают локальные правила проверки.', aiDraft.enabled, (checked) => {
          if (aiDraft) aiDraft.enabled = checked;
        }),
        toggle('Отправлять расшифровку', 'Фрагменты расшифровки уходят в ИИ-сервис компании.', aiDraft.sendTranscripts, (checked) => {
          if (aiDraft) aiDraft.sendTranscripts = checked;
        }),
        toggle('Отправлять чат', 'Сообщения чата уходят на анализ пакетами.', aiDraft.sendChat, (checked) => {
          if (aiDraft) aiDraft.sendChat = checked;
        }),
        toggle('Уведомлять модераторов', 'Замечания в звонке видят организатор и модераторы с правом проверки соответствия.', aiDraft.notifyModerators, (checked) => {
          if (aiDraft) aiDraft.notifyModerators = checked;
        }),
      ),
      field(
        'Текст политики (policyText)',
        textareaInput({
          value: aiDraft.policyText,
          rows: 4,
          placeholder: 'Корпоративная политика: что считать нарушением…',
          onInput: (value) => {
            if (aiDraft) aiDraft.policyText = value;
          },
        }),
        { hint: 'Передаётся ИИ-агенту как описание политики; не является секретом.' },
      ),
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'section-title', text: 'Правила проверки соответствия' }),
        h('span', { class: 'spacer' }),
        button('Добавить правило', {
          variant: 'ghost',
          size: 'sm',
          icon: 'plus',
          onClick: () => {
            addRule();
            renderRules(rulesHost);
          },
        }),
      ),
      rulesHost,
      h('div', { class: 'actions' }, saveButtonLocal),
    );

    return card({ title: t('security.aiAgent'), subtitle: t('security.aiAgentHint'), body: bodyStack });
  };

  /* ------------------------- security overview ------------------------- */

  const renderSecurityOverview = (): HTMLElement => {
    if (!securityOverview) {
      return card({
        title: t('security.summary'),
        body: emptyState({
          title: t('security.noData'),
          message: 'Сводка безопасности недоступна. Проверьте, что сервер запущен, и повторите.',
          iconName: 'security',
          compact: true,
        }),
      });
    }
    const overview = securityOverview;
    const countries = Object.entries(overview.countries)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([code, count]) => ({ label: countryLabel(code), value: count }));
    return card({
      title: t('security.summary'),
      subtitle: `события за 24 ч · организация ${overview.tenantId}`,
      body: h(
        'div',
        { class: 'stack' },
        h(
          'div',
          { class: 'grid grid-2' },
          statTile('Отказы при входе', formatNumber(overview.failedJoins24h), overview.failedJoins24h > 0 ? 'danger' : 'info'),
          statTile('Гео-блокировки', formatNumber(overview.blockedJoins24h), overview.blockedJoins24h > 0 ? 'warning' : 'info'),
          statTile(
            'Подозрительные участники',
            formatNumber(overview.suspiciousParticipants),
            overview.suspiciousParticipants > 0 ? 'warning' : 'info',
          ),
          statTile('События в ленте', formatNumber(overview.events.length), 'info'),
        ),
        h('div', { class: 'section-title', text: 'Страны' }),
        barList(countries, 'Нет гео-данных'),
        h(
          'div',
          { class: 'actions' },
          h('a', { class: 'btn btn-subtle btn-sm', attrs: { href: '#/audit' } }, 'Весь аудит'),
          h('a', { class: 'btn btn-subtle btn-sm', attrs: { href: '#/access' } }, 'Доступы и токены'),
        ),
      ),
    });
  };

  const statTile = (label: string, value: string, tone: 'danger' | 'warning' | 'info'): HTMLElement => {
    return h(
      'div',
      { class: `kpi tone-${tone}`, attrs: { style: 'padding:12px' } },
      h('div', { class: 'kpi-label', text: label }),
      h('div', { class: 'kpi-value', attrs: { style: 'font-size:22px' }, text: value }),
    );
  };

  /* ----------------------------- audit feed ---------------------------- */

  let auditFeedHost: HTMLElement | null = null;
  const auditTypeSelect = h('select', { class: 'select', attrs: { 'aria-label': 'Тип события' } });
  auditTypeSelect.appendChild(h('option', { text: 'Безопасность: все', attrs: { value: 'all' } }));
  for (const type of SECURITY_AUDIT_TYPES) {
    auditTypeSelect.appendChild(h('option', { text: auditTypeLabel(type), attrs: { value: type } }));
  }
  auditTypeSelect.addEventListener('change', () => {
    auditType = auditTypeSelect.value;
    void loadAuditFeed();
  });
  const auditSeveritySelect = selectInput(AUDIT_SEVERITIES, { value: 'all' });
  auditSeveritySelect.addEventListener('change', () => {
    auditSeverity = auditSeveritySelect.value;
    void loadAuditFeed();
  });

  const renderAuditFeed = (): void => {
    if (!auditFeedHost) return;
    auditFeedHost.replaceChildren();
    if (auditEntries.length === 0) {
      auditFeedHost.appendChild(
        emptyState({
          title: 'Событий нет',
          message: 'Журнал пуст или фильтры ничего не нашли. Сбросьте фильтры, чтобы увидеть все события.',
          iconName: 'audit',
          compact: true,
        }),
      );
      return;
    }
    const feed = h('div', { class: 'feed' });
    for (const entry of auditEntries.slice(0, 30)) feed.appendChild(auditEntryRow(entry));
    auditFeedHost.appendChild(feed);
  };

  const loadAuditFeed = async (): Promise<void> => {
    if (!auditFeedHost) return;
    auditFeedHost.replaceChildren(loadingPanel('Загружаем аудит…'));
    try {
      const response = await ctx.api.audit({
        limit: 40,
        type: auditType === 'all' ? undefined : auditType,
        severity: auditSeverity === 'all' ? undefined : auditSeverity,
      });
      auditEntries = response.entries;
      renderAuditFeed();
    } catch (error) {
      auditFeedHost.replaceChildren(errorState(error, () => void loadAuditFeed()));
    }
  };

  const renderCorporateLoginCard = (): HTMLElement => {
    if (!config) return h('div');
    const identity = identityDraft ?? config.integrations.identity;
    identityDraft = identity;
    const modeSelect = selectInput(
      [
        { value: 'token', label: 'Токены организации (token)' },
        { value: 'oidc', label: 'OIDC / корпоративный IdP (oidc)' },
      ],
      {
        value: identity.mode,
        onChange: (value) => {
          identity.mode = value as IdentityConfig['mode'];
          identityDraft = identity;
        },
      },
    );
    const issuerInput = textInput({ value: identity.issuer, placeholder: 'https://sso.example.com/realms/corp' });
    const audienceInput = textInput({ value: identity.audience, placeholder: 'agil-calls' });
    const jwksInput = textInput({ value: identity.jwksUrl, placeholder: 'https://sso.example.com/realms/corp/certs' });
    issuerInput.addEventListener('input', () => { identity.issuer = issuerInput.value.trim(); });
    audienceInput.addEventListener('input', () => { identity.audience = audienceInput.value.trim(); });
    jwksInput.addEventListener('input', () => { identity.jwksUrl = jwksInput.value.trim(); });
    const verifiedInput = h('input', { attrs: { type: 'checkbox' } });
    verifiedInput.checked = Boolean(config.security.requireVerifiedIdentity);
    const configured = hasCorporateIdentityConfiguration(identity);
    const save = button('Сохранить корпоративный вход', { variant: 'primary', icon: 'check' });
    const statusHost = h('div', { attrs: { 'aria-live': 'polite' } });
    const saveIdentity = (): void => {
      void (async () => {
        if (!config) return;
        const next = { ...identity };
        const requireVerified = verifiedInput.checked;
        statusHost.replaceChildren();
        if (requireVerified && !hasCorporateIdentityConfiguration(next)) {
          statusHost.append(alert('warning', t('security.identityNotConfigured'), t('security.identityConfigureFirst')));
          return;
        }
        setButtonLoading(save, true);
        const patch = {
          integrations: { identity: next },
          security: { requireVerifiedIdentity: requireVerified },
        } as unknown as TenantConfigPatch;
        try {
          if (requireVerified && !config.security.requireVerifiedIdentity) {
            const result = await guardedSave('config', patch, t('security.requireIdentity'), async () =>
              ctx.api.patchConfig(ctx.tenantId, patch),
            );
            if (!result.allowed) return;
            config = result.value ?? config;
          } else {
            config = await ctx.api.patchConfig(ctx.tenantId, patch);
          }
          if (config) {
            config.integrations.identity = next;
            config.security.requireVerifiedIdentity = requireVerified;
          }
          identityDraft = next;
          ctx.toast('Корпоративный вход сохранён', 'success');
          renderPage();
        } catch (error) {
          toastError(ctx, error);
        } finally {
          setButtonLoading(save, false);
        }
      })();
    };
    save.addEventListener('click', saveIdentity);

    const scimToken = textInput({ type: 'password', autocomplete: 'off', placeholder: 'SCIM bearer token (не сохраняется)' });
    const scimStatus = h('div', { attrs: { 'aria-live': 'polite' } });
    const scimButton = button('Проверить SCIM', { variant: 'subtle', icon: 'activity' });
    scimButton.addEventListener('click', () => {
      void (async () => {
        const token = scimToken.value.trim();
        if (!token) {
          scimStatus.replaceChildren(alert('danger', 'Введите SCIM-токен', 'Токен задаётся на сервере в AGIL_SCIM_TOKEN.'));
          return;
        }
        setButtonLoading(scimButton, true);
        scimStatus.replaceChildren(h('p', { class: 'notice', text: 'Проверяем SCIM…' }));
        try {
          const result = await ctx.api.checkScim(token, ctx.tenantId);
          if (result.ok) {
            scimStatus.replaceChildren(alert('success', 'SCIM отвечает', `ServiceProviderConfig получен (HTTP ${result.status}). Токен не сохранён.`));
          } else {
            scimStatus.replaceChildren(alert('danger', `SCIM вернул HTTP ${result.status}`, 'Проверьте AGIL_SCIM_TOKEN на сервере и x-tenant-id. Токен не сохранён.'));
          }
        } catch (error) {
          scimStatus.replaceChildren(alert('danger', 'SCIM недоступен', [describeError(error).message, describeError(error).hint].filter(Boolean).join(' ')));
        } finally {
          setButtonLoading(scimButton, false);
        }
      })();
    });

    return card({
      title: t('security.sso'),
      subtitle: t('security.ssoHint'),
      body: h(
        'div',
        { class: 'stack' },
        h(
          'div',
          { class: 'actions' },
          badge(configured ? 'OIDC настроен' : 'OIDC не настроен', configured ? 'success' : 'neutral', { dot: true }),
          badge(identity.mode === 'oidc' ? 'режим OIDC' : 'режим токенов', identity.mode === 'oidc' ? 'info' : 'neutral'),
          badge(config.security.requireVerifiedIdentity ? 'проверка личности обязательна' : 'проверка личности не обязательна', config.security.requireVerifiedIdentity ? 'success' : 'neutral'),
          badge(
            (identity.allowedEmailDomains ?? []).length + (identity.allowedEmails ?? []).length > 0
              ? 'email-allowlist включён'
              : 'email-allowlist выключен',
            (identity.allowedEmailDomains ?? []).length + (identity.allowedEmails ?? []).length > 0 ? 'info' : 'neutral',
          ),
          badge(
            (identity.groupRoleMap ?? []).length > 0
              ? `роли из групп: ${(identity.groupRoleMap ?? []).length}`
              : 'роли из roleClaim',
            (identity.groupRoleMap ?? []).length > 0 ? 'info' : 'neutral',
          ),
          ...((identity.dashboardAdminGroups ?? []).length > 0
            ? [badge(`панель: ${(identity.dashboardAdminGroups ?? []).length} групп(ы)`, 'success')]
            : []),
        ),
        h(
          'p',
          { class: 'notice' },
          'OIDC: внешний IdP (Keycloak/Okta/ADFS) выпускает токены, AGIL проверяет подпись по JWKS и сопоставляет claims. Режим token — компания выпускает наши токены сама.',
        ),
        formGrid(
          field('Режим identity', modeSelect),
          field('Issuer', issuerInput),
          field('Audience', audienceInput),
          field('JWKS URL', jwksInput),
        ),
        h(
          'label',
          { class: 'checkbox-row' },
          verifiedInput,
          h(
            'span',
            { class: 'checkbox-text' },
            h('span', { class: 'checkbox-title', text: t('security.requireIdentity') }),
            h('span', { class: 'checkbox-desc', text: t('security.requireIdentityHint') }),
          ),
        ),
        statusHost,
        h('div', { class: 'actions' }, save),
        h('div', { class: 'section-title', text: 'SCIM 2.0' }),
        h(
          'p',
          { class: 'notice' },
          'SCIM-токен задаётся только на сервере (AGIL_SCIM_TOKEN) и здесь не сохраняется. Панель может проверить ServiceProviderConfig с введённым токеном и x-tenant-id.',
        ),
        formGrid(field('SCIM bearer token', scimToken)),
        h('div', { class: 'actions' }, scimButton),
        scimStatus,
      ),
    });
  };

  /**
   * 501/404/405 from `/v1/admin/siem/*` means the server build does not expose
   * the capability yet — not a bad URL/secret. Say so honestly and keep the
   * save path available; never fake a successful delivery (QA P2).
   */
  const siemCapabilityStatus = (error: unknown): number | null => {
    if (!(error instanceof ApiError)) return null;
    return error.status === 501 || error.status === 404 || error.status === 405 ? error.status : null;
  };

  const renderSiemCard = (): HTMLElement => {
    if (!config) return h('div');
    const draft = siemDraft ?? structuredClone(DEFAULT_SIEM);
    siemDraft = draft;
    const enabledInput = h('input', { attrs: { type: 'checkbox' } });
    enabledInput.checked = draft.enabled;
    const urlInput = textInput({ value: draft.url, placeholder: 'https://siem.example.com/events' });
    const formatSelect = selectInput(
      [
        { value: 'json', label: 'JSON' },
        { value: 'cef', label: 'CEF' },
      ],
      {
        value: draft.format,
        onChange: (value) => { draft.format = value as SiemEventConfig['format']; },
      },
    );
    const secretInput = textInput({ value: draft.secretEnv, placeholder: 'AGIL_SIEM_SECRET' });
    const eventsHost = h('div', { class: 'checkbox-grid' });
    for (const event of SIEM_EVENTS) {
      const checkbox = h('input', { attrs: { type: 'checkbox' } });
      checkbox.checked = draft.events.includes(event.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          if (!draft.events.includes(event.id)) draft.events.push(event.id);
        } else {
          draft.events = draft.events.filter((id) => id !== event.id);
        }
      });
      eventsHost.appendChild(
        h('label', { class: 'checkbox-row' }, checkbox, h('span', { class: 'checkbox-text' }, h('span', { class: 'checkbox-title', text: event.label }), h('span', { class: 'checkbox-desc', text: event.id }))),
      );
    }
    const statusHost = h('div', { class: 'stack' });
    const renderStatus = (): void => {
      statusHost.replaceChildren();
      if (siemStatusError) {
        const unsupported = siemCapabilityStatus(siemStatusError);
        statusHost.appendChild(
          unsupported !== null
            ? alert(
                'warning',
                'Статус SIEM не поддерживается сервером',
                `Сервер ответил HTTP ${unsupported}: endpoint статуса SIEM ещё не реализован в этой сборке. Настройки можно сохранить — статус и тест появятся после обновления сервера.`,
              )
            : alert('warning', 'Статус SIEM недоступен', 'GET /v1/admin/siem/status пока не отвечает. Настройки можно сохранить; статус и тест включатся после обновления сервера.'),
        );
      } else if (siemStatus) {
        statusHost.appendChild(
          h(
            'div',
            { class: 'actions' },
            badge(siemStatus.configured ? 'SIEM настроен' : 'SIEM не настроен', siemStatus.configured ? 'success' : 'neutral', { dot: true }),
            badge(siemStatus.enabled ? 'экспорт включён' : 'экспорт выключен', siemStatus.enabled ? 'success' : 'neutral'),
            siemStatus.lastDelivery ? badge(siemStatus.lastDelivery.ok ? 'последняя доставка успешна' : 'ошибка доставки', siemStatus.lastDelivery.ok ? 'success' : 'danger') : null,
            siemStatus.format ? badge(`формат ${siemStatus.format}`, 'info') : null,
          ),
        );
        const detail = siemStatus.lastError ?? siemStatus.detail;
        if (detail) statusHost.appendChild(h('p', { class: 'notice', text: detail }));
      } else {
        statusHost.appendChild(h('p', { class: 'notice', text: 'Загружаем статус SIEM…' }));
      }
    };
    renderStatus();
    const readSiemStatus = async (): Promise<void> => {
      try {
        siemStatus = await ctx.api.siemStatus();
        siemStatusError = null;
      } catch (error) {
        siemStatus = null;
        siemStatusError = error;
      }
    };
    const testHost = h('div', { attrs: { 'aria-live': 'polite' } });
    const testButton = button('Проверить доставку', { variant: 'subtle', icon: 'activity' });
    testButton.addEventListener('click', () => {
      void (async () => {
        setButtonLoading(testButton, true);
        testHost.replaceChildren(h('p', { class: 'notice', text: 'Отправляем тестовое событие…' }));
        try {
          const result = await ctx.api.siemTest();
          if (result.ok) {
            testHost.replaceChildren(alert('success', 'Тестовая доставка успешна', `Задержка ${result.latencyMs ?? '—'} мс${result.statusCode ? `, HTTP ${result.statusCode}` : ''}`));
          } else {
            testHost.replaceChildren(alert('danger', 'Тестовая доставка не удалась', result.error ?? result.detail ?? 'Проверьте URL и SIEM-секрет в env.'));
          }
          await readSiemStatus();
          renderStatus();
        } catch (error) {
          if (error instanceof ApiError && error.code === 'siem_not_configured') {
            testHost.replaceChildren(alert('warning', 'SIEM не настроен', 'Включите экспорт, укажите URL приёмника и сохраните настройки перед проверкой доставки.'));
            return;
          }
          const unsupported = siemCapabilityStatus(error);
          if (unsupported !== null) {
            testHost.replaceChildren(
              alert(
                'warning',
                'Тест доставки не поддерживается сервером',
                `Сервер ответил HTTP ${unsupported}: тестовая доставка SIEM ещё не реализована в этой сборке. Это ограничение возможностей сервера, а не ошибка URL или секрета. Сохранить настройки SIEM можно — тест заработает после обновления сервера.`,
              ),
            );
            return;
          }
          const info = describeError(error);
          testHost.replaceChildren(alert('danger', 'SIEM недоступен', [info.message, info.hint].filter(Boolean).join(' ')));
        } finally {
          setButtonLoading(testButton, false);
        }
      })();
    });
    const save = button('Сохранить SIEM', { variant: 'primary', icon: 'check' });
    save.addEventListener('click', () => {
      void (async () => {
        if (!config) return;
        if (enabledInput.checked) {
          if (!/^https?:\/\//i.test(draft.url)) {
            testHost.replaceChildren(alert('danger', 'Нужен URL', 'Укажите http(s) URL приёмника SIEM.'));
            return;
          }
          if (!draft.secretEnv.trim()) {
            testHost.replaceChildren(alert('danger', 'Нужно имя env', 'Секрет хранится только в переменной окружения сервера.'));
            return;
          }
          if (draft.events.length === 0) {
            testHost.replaceChildren(alert('danger', 'Выберите события', 'Нужно хотя бы одно событие для экспорта.'));
            return;
          }
        } else {
          draft.url = urlInput.value.trim();
          draft.secretEnv = secretInput.value.trim();
        }
        setButtonLoading(save, true);
        const patch = { integrations: { siem: { ...draft } } } as unknown as TenantConfigPatch;
        try {
          if (draft.enabled && !siemEnabledSaved) {
            const result = await guardedSave('config', patch, 'включить экспорт событий в SIEM', async () =>
              ctx.api.patchConfig(ctx.tenantId, patch),
            );
            if (!result.allowed) return;
            config = result.value ?? config;
          } else {
            config = await ctx.api.patchConfig(ctx.tenantId, patch);
          }
          siemEnabledSaved = draft.enabled;
          siemDraft = { ...draft };
          ctx.toast('Настройки SIEM сохранены', 'success');
          await readSiemStatus();
          renderStatus();
        } catch (error) {
          toastError(ctx, error);
        } finally {
          setButtonLoading(save, false);
        }
      })();
    });
    enabledInput.addEventListener('change', () => {
      draft.enabled = enabledInput.checked;
    });
    urlInput.addEventListener('input', () => { draft.url = urlInput.value.trim(); });
    secretInput.addEventListener('input', () => { draft.secretEnv = secretInput.value.trim(); });
    return card({
      title: t('security.siem'),
      subtitle: t('security.siemHint'),
      body: h(
        'div',
        { class: 'stack' },
        alert('info', t('security.siemDeliveryFailure'), t('security.siemDeliveryFailureHint')),
        h('label', { class: 'checkbox-row' }, enabledInput, h('span', { class: 'checkbox-text' }, h('span', { class: 'checkbox-title', text: t('security.siemEnable') }), h('span', { class: 'checkbox-desc', text: t('security.siemEnableHint') }))),
        formGrid(
          field('URL приёмника', urlInput, { hint: 'События отправляются POST-запросом на этот адрес.' }),
          field('Формат', formatSelect),
          field('Имя env с секретом', secretInput, { hint: 'Например AGIL_SIEM_SECRET; само значение задаётся на сервере.' }),
        ),
        h('div', { class: 'section-title', text: 'События' }),
        eventsHost,
        statusHost,
        h('div', { class: 'actions' }, save, testButton),
        h('p', { class: 'notice', text: t('security.siemTestHint') }),
        testHost,
      ),
    });
  };

  const renderE2eeCard = (): HTMLElement => {
    if (!config) return h('div');
    const enabledInput = h('input', { attrs: { type: 'checkbox' } });
    enabledInput.checked = Boolean(config.security.e2ee);
    const statusHost = h('div', { class: 'stack' });
    if (mediaStatusError) {
      statusHost.appendChild(
        alert(
          'warning',
          'Статус E2EE недоступен',
          'Сервер ещё не отдаёт e2eeConfigured/e2eeActive в /v1/admin/media/processing. Настройка сохранится; статус появится после обновления сервера.',
        ),
      );
    } else if (mediaStatus) {
      statusHost.appendChild(
        h(
          'div',
          { class: 'actions' },
          badge(mediaStatus.e2eeConfigured ? 'E2EE настроен' : 'E2EE не настроен', mediaStatus.e2eeConfigured ? 'success' : 'neutral', { dot: true }),
          badge(mediaStatus.e2eeActive ? 'Политика E2EE включена' : 'Политика E2EE не действует', mediaStatus.e2eeActive ? 'neutral' : 'warning'),
          badge(mediaStatus.serverProcessingActive ? 'Политика разрешает обработку на сервере' : 'Политика обработки на клиентах', mediaStatus.serverProcessingActive ? 'warning' : 'neutral'),
        ),
      );
      statusHost.appendChild(h('p', { class: 'notice', text: 'Эта проверка относится к настройкам Core. Состояние шифрования медиа отображается в подключённом клиенте.' }));
    } else {
      statusHost.appendChild(h('p', { class: 'notice', text: 'Загружаем статус E2EE…' }));
    }
    const save = button('Сохранить E2EE', { variant: 'primary', icon: 'check' });
    save.addEventListener('click', () => {
      void (async () => {
        if (!config) return;
        setButtonLoading(save, true);
        const enabled = enabledInput.checked;
        const patch = { security: { e2ee: enabled }, media: { e2ee: enabled } } as unknown as TenantConfigPatch;
        try {
          if (enabled) {
            const result = await guardedSave('config', patch, 'включить сквозное шифрование (E2EE)', async () =>
              ctx.api.patchConfig(ctx.tenantId, patch),
            );
            if (!result.allowed) return;
            config = result.value ?? config;
          } else {
            config = await ctx.api.patchConfig(ctx.tenantId, patch);
          }
          if (config) config.security.e2ee = enabled;
          ctx.toast(enabled ? 'E2EE включён' : 'E2EE выключен', 'success');
          try {
            mediaStatus = await ctx.api.mediaProcessing();
            mediaStatusError = null;
          } catch (error) {
            mediaStatus = null;
            mediaStatusError = error;
          }
          renderPage();
        } catch (error) {
          toastError(ctx, error);
        } finally {
          setButtonLoading(save, false);
        }
      })();
    });
    return card({
      title: t('security.e2ee'),
      subtitle: t('security.e2eeHint'),
      body: h(
        'div',
        { class: 'stack' },
        alert(
          'warning',
          'Ограничения E2EE',
          'При включённом E2EE серверная запись, STT и egress недоступны; чат по WebSocket не покрыт E2EE. Запись возможна только на устройстве участника, если это поддерживает клиент.',
        ),
        h(
          'label',
          { class: 'checkbox-row' },
          enabledInput,
          h(
            'span',
            { class: 'checkbox-text' },
            h('span', { class: 'checkbox-title', text: 'Включить сквозное шифрование медиа' }),
            h('span', { class: 'checkbox-desc', text: 'Включается только по подтверждению; серверная обработка и egress должны быть выключены.' }),
          ),
        ),
        statusHost,
        h('div', { class: 'actions' }, save),
      ),
    });
  };

  const auditCard = (): HTMLElement => {    const feed = h('div', { class: 'stack audit-feed' });
    auditFeedHost = feed;
    return card({
      title: t('security.audit'),
      subtitle: t('security.auditHint'),
      body: h(
        'div',
        { class: 'stack' },
        h('div', { class: 'filters' }, field('Тип', auditTypeSelect), field('Уровень', auditSeveritySelect)),
        feed,
      ),
    });
  };

  /* --------------------------- config form ----------------------------- */

  const renderConfigForm = (): HTMLElement => {
    if (!config) return h('div');
    const draft = { ...config.security };
    const antiAbuseMode = selectInput([
      { value: '', label: t('security.publicAbuseInherit') },
      { value: 'off', label: t('security.publicAbuseOff') },
      { value: 'observe', label: t('security.publicAbuseObserve') },
      { value: 'enforce', label: t('security.publicAbuseEnforce') },
    ], { value: draft.publicAbuseMode ?? '', ariaLabel: t('security.publicAbuseLabel') });
    const allowedInput = textInput({
      value: formatCountryText(draft.geo.allowedCountries),
      placeholder: 'RU, KZ, BY',
    });
    const blockedInput = textInput({
      value: formatCountryText(draft.geo.blockedCountries),
      placeholder: 'US, GB',
    });
    const geoAlert = h('div', { attrs: { 'aria-live': 'polite' } });
    const identityPolicyNotice = h('div', { attrs: { 'aria-live': 'polite' } });

    const passwords = formSection(
      'Пароли и вход',
      'Пароль комнаты хранится только как хэш (scrypt); лимит попыток защищает от подбора.',
      toggle('Требовать пароль для комнат', 'Применяется к новым комнатам организации.', draft.passwordRequired, (checked) => {
        draft.passwordRequired = checked;
      }),
      formGrid(
        numberSetting('Макс. неудачных попыток', draft.maxFailedJoinAttempts, { min: 1, max: 50 }, (value) => {
          draft.maxFailedJoinAttempts = value;
        }),
        numberSetting('Блокировка после, сек', draft.lockoutSec, { min: 0, max: 86400, hint: '0 — без блокировки' }, (value) => {
          draft.lockoutSec = value;
        }),
      ),
      h(
        'div',
        { class: 'checkbox-grid' },
        toggle('Зал ожидания', 'Участники ждут допуска модератора.', draft.waitingRoom, (checked) => {
          draft.waitingRoom = checked;
        }),
        toggle('Комнаты закрыты по умолчанию', 'Новые комнаты создаются с запретом входа.', draft.lockRoom, (checked) => {
          draft.lockRoom = checked;
        }),
        toggle('Модератор входит первым', 'Гости не могут зайти раньше организатора.', draft.moderatorJoinFirst, (checked) => {
          draft.moderatorJoinFirst = checked;
        }),
        toggle(t('security.requireIdentity'), t('security.requireIdentityHint'), draft.requireVerifiedIdentity, (checked) => {
          draft.requireVerifiedIdentity = checked;
        }),
      ),
      identityPolicyNotice,
      field(t('security.publicAbuseLabel'), antiAbuseMode, { hint: t('security.publicAbuseHint') }),
    );

    const geo = formSection(
      'Гео-политика и локация',
      'Пустой список разрешённых стран значит «разрешены все». GPS запрашивается только с согласия участника.',
      toggle('Гео-фильтрация включена', 'Проверка страны при входе; отказ по гео-политике попадает в аудит.', draft.geo.enabled, (checked) => {
        draft.geo.enabled = checked;
      }),
      formGrid(
        field('Разрешённые страны (ISO-2)', allowedInput, { hint: 'Через запятую. Пусто — разрешены все.' }),
        field('Заблокированные страны (ISO-2)', blockedInput, { hint: 'Приоритетнее разрешённых.' }),
      ),
      h(
        'div',
        { class: 'checkbox-grid' },
        toggle('Блокировать VPN/прокси', 'Оценка по IP: подозрение на VPN — отказ или отметка.', draft.geo.blockVpn, (checked) => {
          draft.geo.blockVpn = checked;
        }),
        toggle('Запрашивать GPS (браузер)', 'Участник увидит системный запрос геолокации.', draft.geo.gpsEnabled, (checked) => {
          draft.geo.gpsEnabled = checked;
        }),
        toggle('Требовать явное согласие', 'Без согласия GPS не собирается — местоположение определяется только приблизительно по IP.', draft.geo.requireConsent, (checked) => {
          draft.geo.requireConsent = checked;
        }),
      ),
      alert(
        'info',
        'Персональные данные и 152-ФЗ',
        'Согласие на геолокацию фиксируется отдельно; отказ не блокирует звонок. В панели показываются только страна/город, источник (IP/GPS) и признак VPN — точные координаты не отображаются и не хранятся в интерфейсе.',
      ),
      geoAlert,
    );

    const integrity = formSection(
      'Проверка подлинности медиа',
      'Браузер проверяет признаки синтетического видео. Результат даёт ориентир для модерации и может ошибаться.',
      toggle('Проверка подлинности включена', 'Участники получают результат проверки подлинности.', draft.mediaIntegrity.enabled, (checked) => {
        draft.mediaIntegrity.enabled = checked;
      }),
      h(
        'div',
        { class: 'checkbox-grid' },
        toggle('Проверка подлинности (liveness)', 'При входе участника просят повернуть голову или моргнуть.', draft.mediaIntegrity.livenessChallenge, (checked) => {
          draft.mediaIntegrity.livenessChallenge = checked;
        }),
        toggle('Локальные проверки', 'Анализ частоты кадров и признаков синтетического видео.', draft.mediaIntegrity.frameHeuristics, (checked) => {
          draft.mediaIntegrity.frameHeuristics = checked;
        }),
        toggle('Автозаглушение при высоком риске', 'Применяется к участнику с высокой оценкой риска.', draft.mediaIntegrity.autoMuteOnHighRisk, (checked) => {
          draft.mediaIntegrity.autoMuteOnHighRisk = checked;
        }),
      ),
      formGrid(
        rangeField({
          label: 'Порог риска',
          min: 0,
          max: 1,
          step: 0.05,
          value: draft.mediaIntegrity.flagThreshold,
          format: (value) => `${Math.round(value * 100)}%`,
          onChange: (value) => {
            draft.mediaIntegrity.flagThreshold = value;
          },
          hint: 'При достижении порога участник получает отметку «Подозрительно».',
        }),
      ),
    );

    const liveness = formSection(
      LIVENESS_SECTION_TITLE,
      'Сервер выдаёт случайное задание (моргнуть / повернуть голову), браузер проверяет его локально и присылает только сигналы. Видео не покидает устройство; вердикт советующий, не сертифицированный.',
      toggle('Серверный челлендж включён', 'Виджет запрашивает задание на входе; без настроенного движка сервер отвечает 501.', draft.liveness.enabled, (checked) => {
        draft.liveness.enabled = checked;
      }),
      formGrid(
        field(
          'Политика при ошибке движка',
          selectInput(
            [
              { value: 'fail-open', label: 'Не обвинять (fail-open)' },
              { value: 'fail-closed', label: 'Считать проверку непройденной (fail-closed)' },
            ],
            {
              value: draft.liveness.onEngineError,
              onChange: (value) => {
                draft.liveness.onEngineError = value === 'fail-closed' ? 'fail-closed' : 'fail-open';
              },
            },
          ),
          { hint: 'fail-open: таймаут/сбой детектора = «неизвестно», участник не обвиняется.' },
        ),
      ),
      alert(
        'info',
        'Честные ограничения',
        'Сигналы формирует браузер: их можно подделать, а запись можно воспроизвести. Это не KYC и не юридическое доказательство; подробности — docs/liveness-av.md.',
      ),
    );

    const avScan = formSection(
      AV_SECTION_TITLE,
      'ClamAV (clamd) и/или YARA сканируют файлы из чата. Работает только если движок настроен на сервере (AGIL_CLAMAV_*, AGIL_YARA_RULES); иначе файлы сохраняются без скана.',
      toggle('Проверка загрузок включена', 'Заражённый файл не отдаётся: копия удаляется и попадает в карантин (GET /v1/admin/quarantine).', draft.avScan.enabled, (checked) => {
        draft.avScan.enabled = checked;
      }),
      formGrid(
        field(
          'Режим',
          selectInput(
            [
              { value: 'async', label: 'Асинхронно: ответ сразу, карантин после' },
              { value: 'sync', label: 'Синхронно: блокировать загрузку' },
            ],
            {
              value: draft.avScan.mode,
              onChange: (value) => {
                draft.avScan.mode = value === 'sync' ? 'sync' : 'async';
              },
            },
          ),
          { hint: 'В async ссылка на файл может работать до окончания скана; после карантина — 403.' },
        ),
        field(
          'При ошибке сканера',
          selectInput(
            [
              { value: 'fail-open', label: 'Оставить файл (fail-open)' },
              { value: 'fail-closed', label: 'В карантин и отклонить (fail-closed)' },
            ],
            {
              value: draft.avScan.onScanError,
              onChange: (value) => {
                draft.avScan.onScanError = value === 'fail-closed' ? 'fail-closed' : 'fail-open';
              },
            },
          ),
          { hint: 'fail-open оставляет файл непроверенным (но это видно в аудите). В sync fail-closed отвечает 503.' },
        ),
        field(
          'Максимум для скана, МБ',
          textInput({
            value: String(draft.avScan.maxScanMb),
            type: 'number',
            min: '1',
            max: '100',
            step: '1',
            onInput: (value) => {
              const parsed = Number.parseInt(value, 10);
              if (Number.isFinite(parsed)) draft.avScan.maxScanMb = Math.max(1, Math.min(100, parsed));
            },
          }),
          { hint: 'Большие файлы не отправляются в демон и помечаются «skipped» (1..100).' },
        ),
      ),
    );

    const saveConfig = (): void => {
      void (async () => {
        if (!config) return;
        identityPolicyNotice.replaceChildren();
        if (draft.requireVerifiedIdentity && !config.security.requireVerifiedIdentity &&
          !hasCorporateIdentityConfiguration(config.integrations.identity)) {
          identityPolicyNotice.append(alert('warning', t('security.identityNotConfigured'), t('security.identityConfigureFirst')));
          return;
        }
        const allowed = parseCountryDraft(allowedInput.value);
        const blocked = parseCountryDraft(blockedInput.value);
        if (allowed.invalid.length > 0 || blocked.invalid.length > 0) {
          geoAlert.replaceChildren(
            alert(
              'danger',
              'Проверьте ISO-2 коды стран',
              `Некорректные значения: ${[...allowed.invalid, ...blocked.invalid].join(', ')}. Нужен формат RU, KZ.`,
            ),
          );
          return;
        }
        geoAlert.replaceChildren();
        setButtonLoading(saveButton, true);
        const patch: TenantConfigPatch = {
          security: {
            passwordRequired: draft.passwordRequired,
            maxFailedJoinAttempts: draft.maxFailedJoinAttempts,
            lockoutSec: draft.lockoutSec,
            waitingRoom: draft.waitingRoom,
            lockRoom: draft.lockRoom,
            moderatorJoinFirst: draft.moderatorJoinFirst,
            requireVerifiedIdentity: draft.requireVerifiedIdentity,
            ...(antiAbuseMode.value !== (config.security.publicAbuseMode ?? '') ? {
              publicAbuseMode: antiAbuseMode.value === '' ? null : antiAbuseMode.value as TenantConfig['security']['publicAbuseMode'],
            } : {}),
            e2ee: draft.e2ee,
            geo: {
              enabled: draft.geo.enabled,
              allowedCountries: parseCountryListFromRaw(allowed.raw),
              blockedCountries: parseCountryListFromRaw(blocked.raw),
              blockVpn: draft.geo.blockVpn,
              gpsEnabled: draft.geo.gpsEnabled,
              requireConsent: draft.geo.requireConsent,
            },
            mediaIntegrity: {
              enabled: draft.mediaIntegrity.enabled,
              livenessChallenge: draft.mediaIntegrity.livenessChallenge,
              frameHeuristics: draft.mediaIntegrity.frameHeuristics,
              flagThreshold: draft.mediaIntegrity.flagThreshold,
              autoMuteOnHighRisk: draft.mediaIntegrity.autoMuteOnHighRisk,
            },
            // Objects with a schema-level `.default()` are not deep-partial in the
            // config patch schema: send every field of both blocks (see
            // security-config.ts, covered by the dashboard payload test).
            ...buildLivenessAvPatch(draft),
          },
        };
        try {
          const result = await guardedSave('config', patch, 'сохранить настройки безопасности организации', async () =>
            ctx.api.patchConfig(ctx.tenantId, patch),
          );
          if (!result.allowed) return;
          config = result.value ?? config;
          ctx.toast('Настройки безопасности сохранены', 'success');
        } catch (error) {
          toastError(ctx, error);
          window.setTimeout(() => {
            geoAlert.replaceChildren(errorState(error, () => saveConfig()));
          }, 0);
        } finally {
          setButtonLoading(saveButton, false);
        }
      })();
    };
    saveButton.onclick = saveConfig;

    return h('div', { class: 'stack' }, passwords, geo, integrity, liveness, avScan);
  };

  /* ------------------------------- page ------------------------------- */

  const renderPage = (): void => {
    saveButton.disabled = false;
    const left = h('div', { class: 'stack' });
    left.appendChild(renderCorporateLoginCard());
    left.appendChild(renderSiemCard());
    left.appendChild(renderE2eeCard());
    left.appendChild(renderConfigForm());
    left.appendChild(renderAiSection());
    auditFeedHost = null;
    const right = h('div', { class: 'stack' }, renderSecurityOverview(), auditCard());
    body.replaceChildren(h('div', { class: 'split' }, left, right));
    if (auditFeedHost) {
      renderAuditFeed();
      if (auditEntries.length === 0) void loadAuditFeed();
    }
  };

  let loadPromise: Promise<void> | null = null;
  const load = async (): Promise<void> => {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      body.replaceChildren(loadingPanel('Загружаем настройки безопасности…'), skeletonTable(4, 4));
      const [configResult, securityResult, auditResult, aiResult, mediaResult, siemResult] = await Promise.allSettled([
        ctx.api.getConfig(ctx.tenantId),
        ctx.api.security(),
        ctx.api.audit({ limit: 40 }),
        ctx.api.aiAgentSettings(),
        ctx.api.mediaProcessing(),
        ctx.api.siemStatus(),
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
      config = configResult.value;
      ctx.setServerStatus('online');
      identityDraft = structuredClone(config.integrations?.identity ?? DEFAULT_INTEGRATIONS.identity);
      siemDraft = structuredClone((config.integrations as unknown as { siem?: SiemEventConfig } | undefined)?.siem ?? DEFAULT_SIEM);
      siemEnabledSaved = Boolean(siemDraft.enabled);
      siemStatus = siemResult.status === 'fulfilled' ? siemResult.value : null;
      siemStatusError = siemResult.status === 'rejected' ? siemResult.reason : null;
      mediaStatus = mediaResult.status === 'fulfilled' ? mediaResult.value : null;
      mediaStatusError = mediaResult.status === 'rejected' ? mediaResult.reason : null;
      securityOverview = securityResult.status === 'fulfilled' ? securityResult.value : null;
      auditEntries = auditResult.status === 'fulfilled' ? auditResult.value.entries : [];
      aiError = null;
      if (aiResult.status === 'fulfilled') {
        aiSettings = aiResult.value;
        aiDraft = structuredClone(aiResult.value.config);
        aiRules = structuredClone(aiResult.value.config.policyRules);
      } else {
        aiSettings = null;
        aiError = aiResult.reason;
        aiDraft = structuredClone(config.session.aiAgent);
        aiRules = structuredClone(config.session.aiAgent.policyRules);
      }
      renderPage();
    })().finally(() => {
      loadPromise = null;
    });
    return loadPromise;
  };

  void load();
  return { el: root, destroy: () => { destroyed = true; } };
};

function parseCountryListFromRaw(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((token) => token.trim().toUpperCase())
        .filter((token) => /^[A-Z]{2}$/.test(token)),
    ),
  ];
}
