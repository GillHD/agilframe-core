/**
 * Infrastructure: cluster identity, enrollment keys/tokens and the connected
 * node registry (docs/api/cluster.md).
 *
 * Behaviour: the leader Core holds a Redis lease (or runs standalone) and is the
 * only Core that accepts mutations; standby Cores are read-only (409 not_leader)
 * and take over when the lease expires (docs/ha-leader.md). SFU/TURN/STUN/
 * all-in-one Nodes redeem enrollment tokens and appear here with their live
 * heartbeat metrics. Tokens are shown exactly once (the server keeps only a
 * hash), nodes can be drained/disabled and their features/capacity edited.
 *
 * The «Подключённые ноды» section is the operational view: online/offline
 * counters, aggregate load and one card per node with CPU/RAM meters and the
 * optional `node.metrics` snapshot (a node that has not reported yet shows
 * «нет данных», never a zero). Issuing a node key is the primary action and the
 * one-time reveal contains the exact `AGIL_NODE_TOKEN=… node … nodes register`
 * command with copy buttons. The list refreshes every 15 s without overlapping
 * requests and pauses while the tab is hidden.
 */
import {
  customNodeModuleActions, isComposeProvisionedNodeModuleImage, isNodeModuleAutoStartAction, isOperatorManagedNodeModule, nodeCapacityInputSchema, nodeFeaturesSchema,
  nodeModuleKindSchema, nodeModuleKinds, nodeTemplateResourceDefaults, NODE_MODULE_COMMAND_TTL_SEC,
} from '@agil/protocol';
import type {
  ClusterStatusResponse,
  EnrollmentTokenCreateRequest,
  EnrollmentTokenCreatedResponse,
  EnrollmentTokenStatus,
  EnrollmentTokenSummary,
  NodeModuleAction,
  NodeCustomModuleTemplate,
  NodeModuleLogWindows,
  NodeModuleAvailability,
  NodeModuleCatalogEntry,
  NodeModuleCommand,
  NodeModuleFailure,
  NodeRole,
  NodeStatus,
  NodeSummary,
  NodeUpdateRequest,
} from '@agil/protocol';
import { ApiError } from '../api.js';
import type { AppContext, ScreenFactory } from '../context.js';
import { h, uid } from '../dom.js';
import { describeError } from '../errors.js';
import { formatDateTime, formatNumber, relativeTime } from '../format.js';
import { icon, type IconName } from '../icons.js';
import { copyText } from '../ui/copy-button.js';
import { badge, type BadgeTone } from '../ui/badge.js';
import { card, kpiCard } from '../ui/card.js';
import { button, checkboxField, field, formGrid, selectInput, textInput } from '../ui/controls.js';
import { locale, t } from '../i18n.js';
import { tableSearch } from '../ui/table-search.js';
import { confirmDialog } from '../ui/confirm-dialog.js';
import { emptyState } from '../ui/empty-state.js';
import { openModal } from '../ui/modal.js';
import { loadingPanel } from '../ui/skeleton.js';
import { dataTable } from '../ui/table.js';
import { alert, errorState, pageHeader, parseList, refreshButton, toastError } from './common.js';
import { openModuleTemplateDraft } from './infrastructure-template.js';
import {
  MODULE_HEALTH_META,
  MODULE_STATUS_META,
  NO_NODE_DATA,
  NODES_REFRESH_INTERVAL_MS,
  availableCatalogEntries,
  buildCoreJoinCommand,
  buildNodeRegisterCommand,
  formatBandwidth,
  formatConfiguredCapacity,
  formatCount,
  formatLoad1,
  formatPercent,
  formatUptimeMetric,
  isDestructiveModuleAction,
  meterTone,
  meterWidth,
  metricsTooltip,
  moduleActionLabel,
  moduleActionsFor,
  moduleCatalogEntry,
  moduleEnvDescription,
  moduleEnvHints,
  modulePendingActions,
  modulePendingLabel,
  modulePortsLabel,
  moduleSummaryLabel,
  moduleUpdatedAtLabel,
  moduleVersionLabel,
  nodeVersionLabel,
  readNodeMetrics,
  readNodeModules,
  sortNodesForDisplay,
  summarizeNodes,
  type NodeModuleView,
} from './infrastructure-nodes.js';

interface ModuleActionOptions {
  moduleName: string;
  targetContainerId?: string;
  expectedImage?: string;
  applyProfile?: boolean;
}

const NODE_ROLE_LABELS: Record<NodeRole, string> = {
  sfu: 'SFU (медиа)',
  turn: 'TURN (ретранслятор)',
  stun: 'STUN (обнаружение)',
  all: 'Всё-в-одном (all)',
};

const NODE_ROLE_BADGES: Record<NodeRole, { label: string; tone: BadgeTone }> = {
  sfu: { label: 'SFU', tone: 'primary' },
  turn: { label: 'TURN', tone: 'info' },
  stun: { label: 'STUN', tone: 'neutral' },
  all: { label: 'ALL', tone: 'success' },
};

const NODE_ROLE_VALUES: readonly NodeRole[] = ['sfu', 'turn', 'stun', 'all'];

const NODE_STATUS_TONES: Record<NodeStatus, BadgeTone> = {
  online: 'success', offline: 'danger', draining: 'warning', disabled: 'neutral',
};

const TOKEN_STATUS: Record<EnrollmentTokenStatus, { label: string; tone: BadgeTone }> = {
  active: { label: 'активен', tone: 'success' },
  used: { label: 'использован', tone: 'neutral' },
  expired: { label: 'истёк', tone: 'warning' },
  revoked: { label: 'отозван', tone: 'danger' },
};

const TOKEN_KIND_LABELS: Record<'core' | 'node', string> = {
  core: 'резервный Core',
  node: 'узел',
};

const FLEET_TILES: readonly NodeStatus[] = ['online', 'offline', 'draining', 'disabled'];

/** Russian presentation of the protocol limitation strings (kept in sync with @agil/protocol). */
const LIMITATION_RU: Record<string, string> = {
  'core: rooms/presence are in-process and tenant config + the node registry are local files — none of it is replicated to a standby; after failover rooms created on the old leader are lost (docs/ha-leader.md)':
    'Core: комнаты/presence живут в памяти, конфиг организации и реестр узлов — локальные файлы; на standby ничего не реплицируется. После failover комнаты старого лидера теряются (docs/ha-leader.md).',
  'core: Redis is used for the leader lease (and its heartbeat) only — room state replication, pub/sub fan-out and sticky routing are not implemented':
    'Core: Redis используется только для аренды лидера и её heartbeat — репликации состояния комнат, pub/sub и sticky routing пока нет.',
  'core: tenant configuration and the node registry need separate synchronization between instances (docs/ha-leader.md)':
    'Конфигурации организаций и реестр узлов требуют отдельной синхронизации между экземплярами Core.',
  'core: Redis supports leader election and optional shared room snapshots. Live connections reconnect after failover':
    'Redis участвует в выборе лидера и может хранить общие снимки комнат. При смене лидера клиенты переподключаются.',
  'node: the Core stores the registry; it does not route rooms/media to nodes, nor probe their endpoint/healthPath yet':
    'Узел: Core ведёт только реестр — комнаты и медиа на узлы не назначаются, endpoint/healthPath не проверяются.',
  'node: drain marks a node for a scheduler that does not exist yet; disable blocks heartbeat only':
    'Узел: drain — только метка для будущего планировщика; disable лишь запрещает heartbeat.',
  'node: direct LiveKit ingress uses operator-configured URLs. Advertised endpoint and healthPath are informational':
    'Прямой вход LiveKit использует адреса из настроек Core. Поля endpoint и healthPath в реестре справочные.',
  'node: maintenance excludes a node from new room assignments. Disabling also rejects its heartbeats':
    'Режим обслуживания исключает узел из назначения новых комнат. Отключение также блокирует heartbeat.',
  'tokens: enrollment is tenant-scoped; a standby rejects token issuance/revocation with 409 not_leader until it acquires the lease':
    'Токены: enrollment привязан к организации; standby отвечает 409 not_leader на выдачу/отзыв токенов, пока не получит аренду лидера.',
};

const NODE_MEDIA_SERVICES = ['sfu', 'turn'] as const;

function nodeMediaStatuses(node: NodeSummary) {
  if (node.status !== 'online') return [];
  return NODE_MEDIA_SERVICES.filter((service) => node.role === service || node.features.includes(service))
    .map((service) => {
      const ready = service === 'sfu' ? node.sfuReady : node.turnReady;
      const status = ready === undefined ? 'unreported' : ready ? 'ready' : 'unavailable';
      const tone: BadgeTone = status === 'ready' ? 'success' : status === 'unavailable' ? 'warning' : 'neutral';
      return { label: t(`infra.node.${service}.${status}`), tone, hint: t(`infra.node.${service}.hint`) };
    });
}

function featureList(features: readonly string[]): HTMLElement {
  if (features.length === 0) return h('span', { class: 'cell-sub', text: '—' });
  const text = features.join(', ');
  return h('span', { class: 'cell-sub mono', text, title: text });
}

/** «через 12 мин» / «истёк» for token expiry (relativeTime labels the past only). */
function expiryLabel(expiresAt: number, now = Date.now()): string {
  const diffSec = Math.round((expiresAt - now) / 1000);
  if (diffSec <= 0) return 'истёк';
  if (diffSec < 60) return `через ${diffSec} с`;
  const minutes = Math.floor(diffSec / 60);
  if (minutes < 60) return `через ${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `через ${hours} ч`;
  return `через ${Math.floor(hours / 24)} дн`;
}

/** Role options valid for a token kind (Core tokens are standby-only). */
function tokenRoleOptions(kind: 'core' | 'node'): Array<{ value: string; label: string }> {
  if (kind === 'core') return [{ value: 'standby', label: 'standby — резервный Core' }];
  return NODE_ROLE_VALUES.map((role) => ({ value: role, label: `${role} — ${NODE_ROLE_LABELS[role]}` }));
}

/** Role of a just-created node enrollment, narrowed back to a node role. */
function enrollmentNodeRole(role: string): NodeRole {
  return (NODE_ROLE_VALUES as readonly string[]).includes(role) ? (role as NodeRole) : 'all';
}

export const infrastructureScreen: ScreenFactory = (ctx) => {
  const root = h('div', { class: 'page infra-page' });
  const body = h('div', { class: 'stack' });
  const summary = h('div', { class: 'kpi-grid' });
  let tokens: EnrollmentTokenSummary[] = [];
  let nodes: NodeSummary[] = [];
  let status: ClusterStatusResponse | null = null;
  let loading = true;
  let unsupported = false;
  let error: unknown = null;
  let destroyed = false;
  let timer: number | null = null;
  /** Guards against overlapping requests (manual refresh + 15 s tick + focus). */
  let inFlight = false;
  const canManage = (): boolean => !ctx.platform && !unsupported && error === null && status?.cluster?.role !== 'standby';

  const issueNodeKey = (size: 'sm' | 'md' = 'md', variant: 'primary' | 'ghost' = 'primary'): HTMLButtonElement =>
    button('Выдать ключ узла', {
      variant,
      size,
      icon: 'key',
      disabled: !canManage(),
      onClick: () => openIssueToken('node'),
    });
  const issueNodeKeyHeader = issueNodeKey('md', 'primary');

  root.appendChild(
    pageHeader({
      eyebrow: 'Кластер',
      title: 'Инфраструктура',
      subtitle:
        'Подключённые ноды с живыми метриками, одноразовые ключи узлов и токены резервных Core. Ключ показывается один раз — сервер хранит только его хэш.',
      actions: [refreshButton(() => load()), issueNodeKeyHeader],
    }),
  );
  root.appendChild(summary);
  root.appendChild(body);

  /* ------------------------------------------------------------------ */
  /* One-time token/key reveal                                          */
  /* ------------------------------------------------------------------ */

  const copyAction = (label: string, value: string, successMessage: string, variant: 'primary' | 'ghost' = 'ghost'): HTMLButtonElement => {
    const control = button(label, { variant, size: 'sm', icon: 'copy' });
    control.addEventListener('click', () => {
      void copyText(value).then((ok) => ctx.toast(ok ? successMessage : 'Не удалось скопировать — выделите и скопируйте вручную.', ok ? 'success' : 'error'));
    });
    return control;
  };

  const showTokenOnce = (result: EnrollmentTokenCreatedResponse, options: { name?: string } = {}): void => {
    let handle: { close: () => void } | null = null;
    const enrollment = result.enrollment;
    const serverUrl = ctx.credentials.serverUrl;
    const isNode = enrollment.kind === 'node';
    const cli = isNode
      ? buildNodeRegisterCommand({
          token: result.token,
          role: enrollmentNodeRole(enrollment.role),
          serverUrl,
          name: options.name ?? enrollment.label,
          features: enrollment.features,
        })
      : buildCoreJoinCommand({ token: result.token, serverUrl });
    const copyToken = copyAction('Скопировать ключ', result.token, 'Ключ скопирован', 'primary');
    const copyCli = copyAction('Скопировать команду', cli, 'Команда скопирована');
    handle = openModal({
      title: isNode ? 'Ключ узла создан' : 'Токен подключения создан',
      size: 'md',
      body: h(
        'div',
        { class: 'stack' },
        alert(
          'warning',
          isNode ? 'Ключ показывается один раз' : 'Токен показывается один раз',
          'Сервер хранит только хэш. Скопируйте значение сейчас и сохраните в secret store (не в репозитории). Позже посмотреть его нельзя — только отозвать.',
        ),
        h(
          'div',
          { class: 'field' },
          h('span', {
            class: 'field-label',
            text: isNode
              ? `Ключ узла (${NODE_ROLE_BADGES[enrollmentNodeRole(enrollment.role)].label})`
              : `Токен (${TOKEN_KIND_LABELS[enrollment.kind]} / ${enrollment.role})`,
          }),
          h('code', { class: 'org-key', text: result.token }),
        ),
        h(
          'div',
          { class: 'chips' },
          badge(`использований: ${enrollment.remainingUses} / ${enrollment.uses}`, 'neutral'),
          badge(`до ${formatDateTime(enrollment.expiresAt)}`, 'neutral'),
          enrollment.features.length > 0 ? badge(`features: ${enrollment.features.join(', ')}`, 'neutral') : null,
          options.name ? badge(`имя: ${options.name}`, 'neutral') : null,
        ),
        h('div', { class: 'actions' }, copyToken),
        h('div', { class: 'section-title', text: isNode ? 'Команда подключения узла' : 'Команда подключения резервного Core' }),
        h('p', {
          class: 'cell-sub',
          text: isNode
            ? 'Скопируйте команду целиком и выполните на машине узла. Она задаёт одноразовый ключ через AGIL_NODE_TOKEN и регистрирует узел в этом кластере.'
            : 'Скопируйте команду целиком и выполните на машине резервного Core.',
        }),
        h('div', { class: 'code-block infra-command' }, h('pre', { class: 'mono', text: cli })),
        h('div', { class: 'actions' }, copyCli),
        isNode
          ? h(
              'div',
              { class: 'infra-reveal-note' },
              h('p', {
                class: 'cell-sub',
                text: 'CLI вернёт ключ ноды (nk_…) — сохраните его на узле как AGIL_NODE_KEY. Дальше узел сам присылает heartbeat и метрики, а карточка появится в разделе «Подключённые ноды».',
              }),
              h('p', {
                class: 'cell-sub',
                text: 'Ключ нельзя восстановить: при потере отзовите токен и выдайте новый. Планировщик комнат пока не использует ёмкость узлов.',
              }),
            )
          : null,
      ),
      footer: [button('Готово', { variant: 'ghost', onClick: () => handle?.close() })],
      onClose: () => {
        void load();
      },
    });
  };

  /* ------------------------------------------------------------------ */
  /* Issue node key / Core token                                        */
  /* ------------------------------------------------------------------ */

  const openIssueToken = (kind: 'node' | 'core'): void => {
    if (!canManage()) return;
    let handle: { close: () => void } | null = null;
    const roleSelect = selectInput(tokenRoleOptions(kind), { value: kind === 'core' ? 'standby' : 'sfu', ariaLabel: 'Роль узла' });
    const nameInput = textInput({ placeholder: 'edge-1', ariaLabel: 'Имя узла' });
    nameInput.maxLength = 80;
    const featuresInput = textInput({ placeholder: 'sfu, egress', ariaLabel: 'Разрешённые features (через запятую)' });
    const ttlInput = textInput({ value: '60', type: 'number', min: 1, max: 43200, ariaLabel: 'Срок жизни, минуты' });
    const usesInput = textInput({ value: '1', type: 'number', min: 1, max: 100, ariaLabel: 'Сколько раз можно использовать' });
    const statusLine = h('div', { attrs: { 'aria-live': 'polite' } });

    const submit = button(kind === 'node' ? 'Выдать ключ' : 'Создать токен', {
      variant: 'primary',
      icon: 'key',
    });
    submit.addEventListener('click', () => {
      void (async () => {
        const ttlMinutes = Number(ttlInput.value);
        const uses = Number(usesInput.value);
        const name = kind === 'node' ? nameInput.value.trim() : '';
        if (!Number.isFinite(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 43200) {
          statusLine.replaceChildren(alert('danger', 'Проверьте срок жизни', 'От 1 минуты до 30 суток (43200 минут).'));
          return;
        }
        if (!Number.isFinite(uses) || uses < 1 || uses > 100 || Math.trunc(uses) !== uses) {
          statusLine.replaceChildren(alert('danger', 'Проверьте число использований', 'Целое число от 1 до 100; 1 — одноразовый ключ.'));
          return;
        }
        if (name.length > 80) {
          statusLine.replaceChildren(alert('danger', 'Слишком длинное имя', 'Не больше 80 символов.'));
          return;
        }
        const features = kind === 'node' ? parseList(featuresInput.value) : [];
        const request: EnrollmentTokenCreateRequest = {
          kind,
          role: (roleSelect.value || (kind === 'core' ? 'standby' : 'all')) as EnrollmentTokenCreateRequest['role'],
          ttlSec: Math.round(ttlMinutes * 60),
          uses: Math.trunc(uses),
          ...(features.length > 0 ? { features } : {}),
          ...(name ? { label: name } : {}),
        };
        submit.disabled = true;
        statusLine.replaceChildren();
        try {
          const result = await ctx.api.createClusterToken(request);
          handle?.close();
          ctx.toast(kind === 'node' ? 'Ключ узла создан' : 'Токен создан', 'success');
          showTokenOnce(result, { name });
        } catch (err) {
          const info = describeError(err);
          statusLine.replaceChildren(alert('danger', info.title, [info.message, info.hint].filter(Boolean).join(' ')));
        } finally {
          submit.disabled = false;
        }
      })();
    });

    handle = openModal({
      title: kind === 'node' ? 'Выдать ключ узла' : 'Новый токен резервного Core',
      size: 'md',
      body: h(
        'div',
        { class: 'stack' },
        alert(
          'info',
          kind === 'node' ? 'Одноразовый ключ регистрации' : 'Одноразовый токен',
          kind === 'node'
            ? 'Ключ привязан к вашей организации и роли узла. Узел обменяет его на постоянный ключ; после использования токен перестаёт работать. Отозвать можно в любой момент в таблице ниже.'
            : 'Токен привязан к вашей организации. Резервный Core обменяет его на подключение к кластеру; после использования он перестаёт работать.',
        ),
        kind === 'node'
          ? formGrid(
              field('Роль узла', roleSelect, { hint: 'SFU/TURN/STUN или всё-в-одном. Роль ограничивает features узла.' }),
              field('Имя узла', nameInput, { hint: 'Необязательно: попадёт в метку ключа и команду регистрации (--name).' }),
            )
          : null,
        kind === 'node'
          ? field('Разрешённые features', featuresInput, {
              hint: 'Через запятую. Пусто — узел сам сообщает свои features (администратор панели может их изменить).',
            })
          : null,
        formGrid(
          field('Использований', usesInput, { hint: '1 — одноразовый (рекомендуется).' }),
          field('Срок жизни, минут', ttlInput, { hint: 'По умолчанию 60 минут; максимум 30 суток.' }),
        ),
        statusLine,
      ),
      footer: [button('Отмена', { variant: 'ghost', onClick: () => handle?.close() }), submit],
    });
    window.setTimeout(() => (kind === 'node' ? nameInput : ttlInput).focus(), 0);
  };

  /* ------------------------------------------------------------------ */
  /* Node actions                                                       */
  /* ------------------------------------------------------------------ */

  const editNode = (node: NodeSummary): void => {
    let handle: { close: () => void } | null = null;
    const nameInput = textInput({ name: 'name', value: node.name, placeholder: 'Edge SFU' });
    const roleSelect = selectInput(
      NODE_ROLE_VALUES.map((role) => ({ value: role, label: t(`infra.edit.role.${role}`) })),
      { value: node.role },
    );
    const featuresInput = textInput({ name: 'features', value: node.features.join(', '), placeholder: 'sfu, egress', spellcheck: false });
    const regionInput = textInput({ value: node.region, placeholder: 'ru-msk' });
    const maxRoomsInput = textInput({ name: 'maxRooms', value: String(node.capacity.maxRooms), type: 'number', min: 0, step: 1 });
    const maxParticipantsInput = textInput({ value: String(node.capacity.maxParticipants), type: 'number', min: 0, step: 1 });
    const maxBandwidthInput = textInput({ value: String(node.capacity.bandwidthMbps), type: 'number', min: 0, step: 1 });
    const moduleEnabled: NonNullable<NodeUpdateRequest['moduleEnabled']> = {};
    const modulePolicy = nodeModuleKinds.map((moduleId) => {
      const initial = !(node.disabledModules?.includes(moduleId));
      const control = checkboxField({
        label: t(`infra.module.name.${moduleId}`), checked: initial,
        onChange: (checked) => {
          if (checked === initial) delete moduleEnabled[moduleId];
          else moduleEnabled[moduleId] = checked;
        },
      });
      control.dataset.modulePolicy = moduleId;
      return control;
    });
    const statusLine = h('div', { attrs: { 'aria-live': 'polite' } });
    const save = button(t('infra.edit.save'), { variant: 'primary', icon: 'check' });
    save.addEventListener('click', () => {
      void (async () => {
        const maxRooms = Number(maxRoomsInput.value || 0);
        const maxParticipants = Number(maxParticipantsInput.value || 0);
        const maxBandwidth = Number(maxBandwidthInput.value || 0);
        const capacity = nodeCapacityInputSchema.safeParse({ maxRooms, maxParticipants, bandwidthMbps: maxBandwidth });
        if (!capacity.success || [maxRoomsInput, maxParticipantsInput, maxBandwidthInput].some((input) => input.validity.badInput)) {
          statusLine.replaceChildren(alert('danger', t('infra.edit.capacityError'), t('infra.edit.capacityErrorHint')));
          return;
        }
        const features = parseList(featuresInput.value);
        if (!nodeFeaturesSchema.safeParse(features).success) {
          statusLine.replaceChildren(alert('danger', t('infra.edit.featuresError'), t('infra.edit.featuresHint')));
          featuresInput.focus();
          return;
        }
        const name = nameInput.value.trim();
        const role = roleSelect.value as NodeRole;
        const region = regionInput.value.trim();
        const patch: NodeUpdateRequest = {};
        if (name !== node.name) patch.name = name;
        if (role !== node.role) patch.role = role;
        if (region !== node.region) patch.region = region;
        if (features.length !== node.features.length || features.some((feature, index) => feature !== node.features[index])) patch.features = features;
        if (Object.keys(moduleEnabled).length) patch.moduleEnabled = { ...moduleEnabled };
        const changedCapacity: NonNullable<NodeUpdateRequest['capacity']> = {};
        if (maxRooms !== node.capacity.maxRooms) changedCapacity.maxRooms = maxRooms;
        if (maxParticipants !== node.capacity.maxParticipants) changedCapacity.maxParticipants = maxParticipants;
        if (maxBandwidth !== node.capacity.bandwidthMbps) changedCapacity.bandwidthMbps = maxBandwidth;
        if (Object.keys(changedCapacity).length > 0) patch.capacity = changedCapacity;
        if (Object.keys(patch).length === 0) {
          handle?.close();
          return;
        }
        save.disabled = true;
        try {
          await ctx.api.updateNode(node.id, patch);
          ctx.toast(t('infra.edit.updated', { node: node.id }), 'success');
          handle?.close();
          await load();
        } catch (err) {
          const info = describeError(err);
          statusLine.replaceChildren(alert('danger', info.title, [info.message, info.hint].filter(Boolean).join(' ')));
        } finally {
          save.disabled = false;
        }
      })();
    });
    handle = openModal({
      title: t('infra.edit.title', { node: node.id }),
      size: 'md',
      body: h(
        'div',
        { class: 'stack' },
        alert(
          'info',
          t('infra.edit.heading'),
          t('infra.edit.intro'),
        ),
        formGrid(
          field(t('infra.edit.name'), nameInput), field(t('infra.edit.role'), roleSelect), field(t('infra.edit.region'), regionInput),
          field(t('infra.edit.features'), featuresInput, { hint: t('infra.edit.featuresHint') }),
        ),
        formGrid(
          field(t('infra.edit.rooms'), maxRoomsInput, { hint: t('infra.edit.capacityHint') }),
          field(t('infra.edit.participants'), maxParticipantsInput, { hint: t('infra.edit.capacityHint') }),
          field(t('infra.edit.bandwidth'), maxBandwidthInput, { hint: t('infra.edit.capacityHint') }),
        ),
        h('div', { class: 'stack', attrs: { role: 'group', 'aria-label': t('infra.edit.modulePolicy') } },
          h('strong', { text: t('infra.edit.modulePolicy') }),
          h('p', { class: 'muted small', text: t('infra.edit.modulePolicyHint') }), formGrid(...modulePolicy)),
        statusLine,
      ),
      footer: [button(t('common.cancel'), { variant: 'ghost', onClick: () => handle?.close() }), save],
    });
  };

  const toggleDrain = async (node: NodeSummary): Promise<void> => {
    try {
      await ctx.api.drainNode(node.id, !node.drain);
      ctx.toast(t(node.drain ? 'infra.node.resumed' : 'infra.node.inMaintenance', { node: node.id }), 'success');
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'sfu_drain_in_progress') {
        ctx.toast(t('infra.node.sfuDrainInProgress'), 'error');
        return;
      }
      toastError(ctx, err);
    }
  };

  const toggleDisabled = async (node: NodeSummary): Promise<void> => {
    if (node.enabled) {
      const confirmed = await confirmDialog({
        title: t('infra.node.disableTitle'),
        message: t('infra.node.disableBody', { node: node.id }),
        confirmLabel: t('infra.node.disable'),
        danger: true,
      });
      if (!confirmed) return;
    }
    try {
      const updated = await ctx.api.disableNode(node.id, node.enabled);
      ctx.toast(t(updated.enabled ? 'infra.node.enabled' : 'infra.node.disabled', { node: node.id }), 'success');
      await load();
    } catch (err) {
      toastError(ctx, err);
    }
  };

  const removeNode = async (node: NodeSummary): Promise<void> => {
    const confirmed = await confirmDialog({
      title: t('infra.node.deleteTitle'),
      message: t('infra.node.deleteBody', { node: node.id }),
      confirmLabel: t('infra.node.delete'),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await ctx.api.deleteNode(node.id);
      ctx.toast(t('infra.node.deleted', { node: node.id }), 'success');
      await load();
    } catch (err) {
      toastError(ctx, err);
    }
  };

  const revokeToken = async (token: EnrollmentTokenSummary): Promise<void> => {
    const confirmed = await confirmDialog({
      title: 'Отозвать токен?',
      message: `Токен ${token.id} (${TOKEN_KIND_LABELS[token.kind]}, ${token.role}) сразу перестанет работать. Действие необратимо.`,
      confirmLabel: 'Отозвать',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await ctx.api.revokeClusterToken(token.id);
      ctx.toast('Токен отозван', 'success');
      await load();
    } catch (err) {
      toastError(ctx, err);
    }
  };

  /* ------------------------------------------------------------------ */
  /* Connected nodes: cards, meters and fleet overview                  */
  /* ------------------------------------------------------------------ */

  /** Compact CPU/RAM meter with a percent label and a native tooltip. */
  const displayMetric = (value: string): string => value === NO_NODE_DATA ? t('infra.node.metrics.noValue') : value;

  const nodeMeter = (label: string, value: number | null, hint: string): HTMLElement => {
    const formatted = formatPercent(value);
    const text = displayMetric(formatted);
    const tone = meterTone(value);
    const width = meterWidth(value);
    const title = metricsTooltip(label, formatted, hint);
    const track = h('div', {
      class: `infra-meter-track is-${tone}`,
      attrs: {
        role: 'progressbar',
        'aria-label': `${label}: ${text}`,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': value === null ? null : Math.round(width),
        'aria-valuetext': text,
        title,
      },
    });
    track.appendChild(h('span', { class: `infra-meter-fill is-${tone}`, attrs: { style: `width:${width}%` } }));
    return h(
      'div',
      { class: 'infra-meter' },
      h(
        'div',
        { class: 'infra-meter-head' },
        h('span', { class: 'infra-meter-label', text: label }),
        h('span', { class: 'infra-meter-value', text }),
      ),
      track,
    );
  };

  const nodeStat = (label: string, value: string, title: string): HTMLElement =>
    h(
      'div',
      { class: 'infra-stat' },
      h('dt', { class: 'infra-stat-label', text: label }),
      h('dd', {
        class: `infra-stat-value${value === NO_NODE_DATA ? ' is-muted' : ''}`,
        text: displayMetric(value),
        title,
      }),
    );

  /* ------------------------------------------------------------------ */
  /* Per-node modules: expandable «Модули» panel (docs/api/cluster.md §10) */
  /* ------------------------------------------------------------------ */

  /** Command TTL from the protocol (delivered once, dropped if not acked). */
  const moduleCommandMinutes = Math.max(1, Math.round(NODE_MODULE_COMMAND_TTL_SEC / 60));

  const MODULE_ACTION_ICONS: Record<NodeModuleAction, IconName> = {
    install: 'download',
    start: 'play',
    stop: 'x',
    restart: 'refresh',
    remove: 'trash',
    'enable-autostart': 'play',
    'disable-autostart': 'x',
  };

  interface NodeModuleState {
    status: 'loading' | 'ready' | 'error' | 'unsupported';
    /** Last inventory returned for this node (`GET .../modules`, sanitized). */
    modules: NodeModuleView[];
    templates?: NodeCustomModuleTemplate[];
    logWindows?: NodeModuleLogWindows;
    /** Commands queued but not delivered yet (pending badge; no optimistic status). */
    pending: NodeModuleCommand[];
    inFlight: NodeModuleCommand[];
    availability?: NodeModuleAvailability;
    inventoryStale?: boolean;
    inventoryRequest?: number;
    failures: NodeModuleFailure[];
    loadedAt: number | null;
    error: unknown;
  }

  interface NodeModuleCatalogState {
    status: 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';
    entries: NodeModuleCatalogEntry[];
    actions: NodeModuleAction[];
    error: unknown;
  }

  /** Expansion survives the 15 s re-render; module data is cached per node. */
  const expandedNodeIds = new Set<string>();
  const moduleStates = new Map<string, NodeModuleState>();
  const mountedModulePanels = new Map<string, HTMLElement>();
  const moduleLoads = new Map<string, Promise<void>>();
  let inventoryRequest = 0;
  let nodeListInventoryRequest = 0;
  const busyModuleActions = new Set<string>();
  let moduleCatalog: NodeModuleCatalogState = { status: 'idle', entries: [], actions: [], error: null };
  let moduleCatalogLoad: Promise<void> | null = null;

  const moduleBusyKey = (nodeId: string, moduleId: string): string => `${nodeId}:${moduleId}`;

  /** Queued action hint for buttons and banners (offline ≠ disabled). */
  const moduleActionNote = (node: NodeSummary): string =>
    node.status === 'offline'
      ? t('infra.module.offlineQueue', { minutes: moduleCommandMinutes })
      : t('infra.module.nextHeartbeat');

  // A module request started before the node list may return an older Docker state.
  const moduleInventory = (node: NodeSummary) => {
    const state = moduleStates.get(node.id);
    return state && (state.inventoryRequest ?? 0) > nodeListInventoryRequest ? state
      : { modules: node.modules, availability: node.moduleAvailability, inventoryStale: node.inventoryStale };
  };

  const moduleToggleText = (node: NodeSummary): string => {
    const inventory = moduleInventory(node);
    const { availability, inventoryStale } = inventory;
    if (availability === 'disabled') return t('infra.module.disabled');
    if (availability === 'unavailable') return t('infra.module.dockerUnavailable');
    if (inventoryStale) return t('infra.module.lastInventory');
    return moduleSummaryLabel(readNodeModules(inventory));
  };

  /** Why module actions are unavailable, or `null`. */
  const moduleActionDisabledReason = (node: NodeSummary, moduleId?: string): string | null => {
    if (!canManage()) {
      return status?.cluster?.role === 'standby'
        ? t('infra.module.standby')
        : t('infra.module.noPermission');
    }
    if (node.status === 'disabled') return t('infra.module.nodeDisabledHint');
    if (node.disabledModules?.some((id) => id === moduleId)) return t('infra.module.policyDisabledHint');
    const { availability } = moduleInventory(node);
    if (availability === 'disabled') return t('infra.module.disabled');
    if (availability === 'unavailable') return t('infra.module.dockerUnavailable');
    return null;
  };

  const moduleErrorDetail = (error: unknown): string | undefined => {
    if (!(error instanceof ApiError)) return undefined;
    if (error.offline) return t('infra.module.errorOffline');
    switch (error.code) {
      case 'not_leader': return t('infra.module.standby');
      case 'node_disabled': return t('infra.module.nodeDisabledHint');
      case 'module_disabled': return t('infra.module.policyDisabledHint');
      case 'node_modules_unavailable': return t('infra.module.disabled');
      case 'module_compose_read_only': return t('infra.module.composeManage');
      case 'module_target_changed': return t('infra.module.targetChanged');
      case 'module_autostart_unavailable': return t('infra.module.errorAutoStart');
      case 'module_command_pending': return t('infra.module.errorPending');
      case 'module_queue_full': return t('infra.module.errorQueueFull');
      default: return error.status > 0 ? t('infra.module.errorHttp', { status: error.status }) : undefined;
    }
  };

  const moduleFocusKey = (panel: HTMLElement): string | undefined => {
    const active = panel.ownerDocument.activeElement;
    if (active === panel) return '';
    if (!(active instanceof HTMLElement) || !panel.contains(active)) return undefined;
    return active.dataset.moduleFocus ?? active.dataset.moduleAction ?? '';
  };

  const restoreModuleFocus = (panel: HTMLElement, key: string): void => {
    const controls = [...panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const sameControl = controls.find((control) => (control.dataset.moduleFocus ?? control.dataset.moduleAction) === key);
    const refresh = key === 'retry' ? controls.find((control) => control.dataset.moduleFocus === 'refresh') : undefined;
    (sameControl ?? refresh ?? panel).focus({ preventScroll: true });
  };

  /** Re-renders one mounted panel in place (keeps expansion without a full reload). */
  const updateModulePanel = (nodeId: string): void => {
    const panel = mountedModulePanels.get(nodeId);
    if (!panel || !expandedNodeIds.has(nodeId) || destroyed) return;
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    const focusKey = moduleFocusKey(panel);
    panel.replaceChildren(...modulesPanelContent(node));
    const toggleCount = panel.closest('.infra-node')?.querySelector('.infra-modules-toggle-count');
    if (toggleCount) toggleCount.textContent = moduleToggleText(node);
    if (focusKey !== undefined) restoreModuleFocus(panel, focusKey);
  };

  const refreshMountedModulePanels = (): void => {
    for (const nodeId of [...mountedModulePanels.keys()]) updateModulePanel(nodeId);
  };

  /** `GET /v1/admin/nodes/:nodeId/modules` — inventory and active commands. */
  const loadNodeModules = (nodeId: string): Promise<void> => {
    const inFlight = moduleLoads.get(nodeId);
    if (inFlight) return inFlight;
    const request = ++inventoryRequest;
    const previous = moduleStates.get(nodeId) ?? null;
    moduleStates.set(nodeId, {
      status: 'loading',
      modules: previous?.modules ?? [],
      templates: previous?.templates,
      pending: previous?.pending ?? [],
      inFlight: previous?.inFlight ?? [],
      availability: previous?.availability,
      inventoryStale: previous?.inventoryStale,
      inventoryRequest: previous?.inventoryRequest,
      failures: previous?.failures ?? [],
      loadedAt: previous?.loadedAt ?? null,
      error: null,
    });
    updateModulePanel(nodeId);
    const promise = (async () => {
      try {
        const response = await ctx.api.nodeModules(nodeId);
        if (destroyed) return;
        moduleStates.set(nodeId, {
          status: 'ready',
          modules: readNodeModules({ modules: response.modules }).modules,
          templates: response.moduleTemplates,
          logWindows: response.logWindows,
          pending: response.pendingCommands,
          inFlight: response.inFlightCommands ?? [],
          availability: response.moduleAvailability,
          inventoryStale: response.inventoryStale,
          inventoryRequest: request,
          failures: response.failures ?? [],
          loadedAt: Date.now(),
          error: null,
        });
      } catch (err) {
        if (destroyed) return;
        const unsupported = err instanceof ApiError && [404, 405, 501].includes(err.status);
        moduleStates.set(nodeId, {
          status: unsupported ? 'unsupported' : 'error',
          modules: previous?.modules ?? [],
          templates: previous?.templates,
          pending: previous?.pending ?? [],
          inFlight: previous?.inFlight ?? [],
          availability: previous?.availability,
          inventoryStale: previous?.inventoryStale,
          inventoryRequest: previous?.inventoryRequest,
          failures: previous?.failures ?? [],
          loadedAt: previous?.loadedAt ?? null,
          error: err,
        });
        if (err instanceof ApiError && err.offline) ctx.setServerStatus('offline');
      } finally {
        moduleLoads.delete(nodeId);
        if (!destroyed) updateModulePanel(nodeId);
      }
    })();
    moduleLoads.set(nodeId, promise);
    return promise;
  };

  /** `GET /v1/admin/node-modules/catalog` — allowlist labels/images/env hints. */
  const loadModuleCatalog = (options: { force?: boolean } = {}): Promise<void> => {
    if (moduleCatalogLoad) return moduleCatalogLoad;
    if (!options.force && (moduleCatalog.status === 'ready' || moduleCatalog.status === 'unsupported')) {
      return Promise.resolve();
    }
    moduleCatalog = { ...moduleCatalog, status: 'loading', error: null };
    refreshMountedModulePanels();
    const promise = (async () => {
      try {
        const response = await ctx.api.nodeModuleCatalog();
        if (destroyed) return;
        moduleCatalog = { status: 'ready', entries: response.catalog, actions: response.actions, error: null };
      } catch (err) {
        if (destroyed) return;
        moduleCatalog = {
          status: err instanceof ApiError && [404, 405, 501].includes(err.status) ? 'unsupported' : 'error',
          entries: [],
          actions: [],
          error: err,
        };
        if (err instanceof ApiError && err.offline) ctx.setServerStatus('offline');
      } finally {
        moduleCatalogLoad = null;
        if (!destroyed) refreshMountedModulePanels();
      }
    })();
    moduleCatalogLoad = promise;
    return promise;
  };

  /**
   * Queues one allowlisted action. Destructive actions are confirmed first.
   * The response command is shown as pending immediately; the module status is
   * never changed optimistically — only the node's next heartbeat does that.
   */
  const actionLabel = (moduleId: string, action: NodeModuleAction, options?: ModuleActionOptions): string => {
    if (action === 'install' && options?.targetContainerId && options.expectedImage) {
      return t(options.applyProfile ? 'infra.module.applyProfile' : 'infra.module.replaceTemplate');
    }
    if (moduleId === 'sfu' && action === 'stop') return t('infra.module.sfuStop');
    if (moduleId === 'sfu' && action === 'restart') return t('infra.module.sfuRestart');
    return moduleActionLabel(action);
  };

  const queueModuleAction = async (
    node: NodeSummary,
    moduleId: string,
    action: NodeModuleAction,
    options: ModuleActionOptions,
  ): Promise<void> => {
    const { moduleName, targetContainerId, expectedImage, applyProfile } = options;
    const replacesTemplate = action === 'install' && !!targetContainerId && !!expectedImage;
    const interruptsIngress = moduleId === 'ingress' && (action === 'stop' || action === 'restart');
    const drainsSfu = moduleId === 'sfu' && (action === 'stop' || action === 'restart');
    const restartsSfu = drainsSfu && action === 'restart';
    const label = actionLabel(moduleId, action, options);
    const key = moduleBusyKey(node.id, moduleId);
    if (busyModuleActions.has(key)) return;
    if (isDestructiveModuleAction(action) || replacesTemplate || interruptsIngress || drainsSfu) {
      const removalMessage = targetContainerId ? 'infra.module.removeTemplateBody'
        : moduleId === 'recorder' ? 'infra.module.removeRecorderBody'
          : 'infra.module.removeBody';
      const confirmed = await confirmDialog({
        title: t(drainsSfu ? (restartsSfu ? 'infra.module.sfuRestartTitle' : 'infra.module.sfuStopTitle') :
          interruptsIngress ? 'infra.module.ingressInterruptTitle' :
          replacesTemplate ? (applyProfile ? 'infra.module.applyProfileTitle' : 'infra.module.replaceTemplateTitle') :
            'infra.module.removeTitle', { module: moduleName }),
        message: drainsSfu ? t(restartsSfu ? 'infra.module.sfuRestartBody' : 'infra.module.sfuStopBody') :
          interruptsIngress ? t('infra.module.ingressInterruptBody') :
          replacesTemplate ? applyProfile ? t('infra.module.applyProfileBody') :
            t('infra.module.replaceTemplateBody', { digest: expectedImage.slice(-12) }) :
          t(removalMessage, { node: node.name || node.id }),
        confirmLabel: label,
        danger: !replacesTemplate,
      });
      // A heartbeat may have refreshed the card while the modal was open.
      if (document.activeElement === document.body) {
        const panel = mountedModulePanels.get(node.id);
        const replacement = panel?.querySelector<HTMLButtonElement>(`[data-module-action="${moduleId}:${action}"]:enabled`);
        (replacement ?? panel)?.focus({ preventScroll: true });
      }
      if (!confirmed) return;
    }
    busyModuleActions.add(key);
    updateModulePanel(node.id);
    try {
      const command = await ctx.api.queueNodeModuleAction(node.id, moduleId, action, targetContainerId, expectedImage);
      ctx.toast(t('infra.module.queuedToast', { action: label }), 'success');
      const state: NodeModuleState =
        moduleStates.get(node.id) ?? {
          status: 'ready',
          modules: readNodeModules(node).modules,
          pending: [],
          inFlight: [],
          failures: [],
          loadedAt: null,
          error: null,
        };
      state.pending = [...state.pending.filter((pending) => pending.id !== command.id), command];
      state.status = 'ready';
      state.error = null;
      moduleStates.set(node.id, state);
      updateModulePanel(node.id);
      await Promise.all([load({ silent: true }), loadNodeModules(node.id)]);
    } catch (err) {
      if (err instanceof ApiError && err.offline) ctx.setServerStatus('offline');
      ctx.toast(moduleErrorDetail(err) ?? t('infra.module.errorCommand'), 'error');
      if (err instanceof ApiError && err.status === 409) {
        void loadNodeModules(node.id);
        if (err.code === 'module_disabled') void load({ silent: true });
      }
      if (err instanceof ApiError && err.code === 'node_disabled') void load({ silent: true });
    } finally {
      busyModuleActions.delete(key);
      if (!destroyed) updateModulePanel(node.id);
    }
  };

  /** Env **hints** only: names/descriptions, never a value or secret. */
  const moduleEnvDetails = (entry: NodeModuleCatalogEntry | null): HTMLElement | null => {
    const hints = moduleEnvHints(entry);
    if (hints.length === 0) return null;
    return h(
      'details',
      { class: 'infra-module-env' },
      h('summary', { class: 'infra-module-env-summary', text: t('infra.module.envSummary', { count: formatNumber(hints.length) }) }),
      h(
        'ul',
        { class: 'infra-module-env-list' },
        ...hints.map((hint) => {
          const description = moduleEnvDescription(hint.name, hint.description);
          return h(
            'li',
            { class: 'infra-module-env-item' },
            h('code', { class: 'mono small', text: hint.name }),
            hint.required ? badge(t('infra.module.envRequired'), 'info') : null,
            hint.secret
              ? badge(t('infra.module.envSecret'), 'warning', {
                  title: t('infra.module.envSecretHint'),
                })
              : null,
            description ? h('span', { class: 'cell-sub', text: description }) : null,
          );
        }),
      ),
      h('p', {
        class: 'infra-module-env-note',
        text: t('infra.module.envHint'),
      }),
    );
  };

  /** Long Docker reference: wraps instead of widening the card. */
  const moduleImageRow = (image: string): HTMLElement =>
    h(
      'p',
      { class: 'infra-module-image' },
      h('span', { class: 'cell-sub', text: `${t('infra.module.image')} ` }),
      h('code', { class: 'mono small', text: image, title: image }),
    );

  const moduleActionButton = (
    node: NodeSummary,
    moduleId: string,
    action: NodeModuleAction,
    options: ModuleActionOptions,
  ): HTMLButtonElement => {
    const disabledReason = moduleActionDisabledReason(node, moduleId);
    const busy = busyModuleActions.has(moduleBusyKey(node.id, moduleId));
    const destructive = isDestructiveModuleAction(action);
    const label = actionLabel(moduleId, action, options);
    const control = button(label, {
      variant: destructive ? 'danger-ghost' : action === 'stop' ? 'ghost' : 'subtle',
      size: 'sm',
      icon: MODULE_ACTION_ICONS[action],
      ariaLabel: t('infra.module.actionTarget', { action: label, module: options.moduleName }),
      title: disabledReason ?? `${t('infra.module.actionTarget', { action: label, module: options.moduleName })}. ${moduleActionNote(node)}`,
      disabled: disabledReason !== null || busy,
      onClick: () => void queueModuleAction(node, moduleId, action, options),
    });
    // Lets the in-place pending-state refresh keep keyboard focus on the action.
    control.dataset['moduleAction'] = `${moduleId}:${action}`;
    control.dataset['moduleId'] = moduleId;
    return control;
  };

  const moduleCommandBadges = (node: NodeSummary, moduleId: string, applyProfile = false): HTMLElement[] => {
    const state = moduleStates.get(node.id);
    const waiting = modulePendingActions(state?.pending, moduleId);
    const delivered = modulePendingActions(state?.inFlight, moduleId);
    const badges: HTMLElement[] = [];
    if (waiting.length > 0) {
      const label = applyProfile && waiting.includes('install')
        ? t('infra.module.pending', { actions: t('infra.module.applyProfileStatus').toLocaleLowerCase() }) : modulePendingLabel(waiting);
      badges.push(badge(label, 'info', { dot: true, title: moduleActionNote(node) }));
    }
    if (delivered.length > 0) {
      const actions = delivered.map((action) => t(applyProfile && action === 'install'
        ? 'infra.module.applyProfileStatus' : `infra.module.action.${action}`)).join(', ');
      badges.push(badge(`${t('infra.module.awaitingResult')} · ${actions}`, 'info', { dot: true }));
    }
    return badges;
  };

  /** One installed module: status/health badges, reported fields, actions, env hints. */
  const moduleItem = (node: NodeSummary, module: NodeModuleView, historical: boolean): HTMLElement => {
    const statusMeta = MODULE_STATUS_META[module.status];
    const healthMeta = MODULE_HEALTH_META[module.health];
    const catalogId = nodeModuleKindSchema.safeParse(module.id).data;
    const moduleName = catalogId ? t(`infra.module.name.${catalogId}`) : module.name;
    const entry = catalogId && moduleCatalog.status === 'ready' ? moduleCatalogEntry(moduleCatalog.entries, catalogId) : null;
    const operatorManaged = isOperatorManagedNodeModule(module.id);
    const composeReadOnly = isComposeProvisionedNodeModuleImage(module.id, module.image);
    const legacyWorker = entry && isComposeProvisionedNodeModuleImage(module.id, entry.image) && !composeReadOnly;
    const externalSfu = module.id === 'sfu';
    const sfuRequest = externalSfu && !historical && module.status === 'running' ? module.sfuDrainState : undefined;
    const sfuStopRequested = sfuRequest === 'requested';
    const sfuRestartRequested = sfuRequest === 'restart_requested';
    const canTarget = externalSfu ? node.status === 'draining' && node.features.includes('sfu') :
      node.status === 'online' && (!operatorManaged || !node.drain);
    const targetContainerId = (!catalogId || operatorManaged) && !historical && canTarget
      ? module.lifecycleContainerId : undefined;
    const availableActions = entry?.actions ?? (targetContainerId
      ? [...customNodeModuleActions, ...(module.templateRemovable ? ['remove' as const] : [])]
      : []);
    const applicableActions = composeReadOnly ? [] : externalSfu
      ? targetContainerId && entry ? entry.actions.filter((action) =>
          (action === 'start' && (module.status === 'stopped' || module.status === 'error')) ||
          ((action === 'stop' || action === 'restart') && module.status === 'running' && module.sfuDrainState === 'available')) : []
      : operatorManaged && !targetContainerId ? [] : availableActions;
    const applyProfile = !historical && moduleStates.get(node.id)?.templates?.some((template) =>
      template.id === module.id && template.image === module.image && template.profileChanged === true &&
      template.cached && template.installable && !template.blockedReason);
    const commandBadges = moduleCommandBadges(node, module.id, applyProfile);
    const logWindow = historical ? undefined : moduleStates.get(node.id)?.logWindows?.find(({ moduleId }) => moduleId === module.id);
    const actions =
      applicableActions.length > 0 && commandBadges.length === 0
        ? moduleActionsFor({
            status: module.status,
            autoStart: module.autoStart,
            catalogActions: applicableActions,
          })
        : [];
    const noCatalog = !catalogId || (moduleCatalog.status === 'ready' && entry === null);
    const actionNodes: HTMLElement[] =
      commandBadges.length > 0
        ? []
        : actions.length > 0
          ? actions.map((action) => moduleActionButton(node, module.id, action, { moduleName, targetContainerId }))
          : [
              h('span', {
                class: 'cell-sub',
                text: composeReadOnly ? t('infra.module.composeManage') : externalSfu ? t(sfuRestartRequested ? 'infra.module.sfuRestartWaiting' :
                  sfuStopRequested ? 'infra.module.sfuStopWaiting' : module.lifecycleContainerId ?
                  (canTarget && module.status === 'running' ? 'infra.module.sfuStopUnavailable' : 'infra.module.sfuMaintenance') :
                  'infra.module.sfuApproval') :
                  operatorManaged && !module.lifecycleContainerId ? t('infra.module.ingressApproval') :
                  noCatalog && !targetContainerId ? t('infra.module.outsideCatalog') : t('infra.module.noActions'),
              }),
            ];
    return h(
      'article',
      { class: `infra-module is-${module.status}${historical ? ' is-historical' : ''}`, dataset: { moduleId: module.id } },
      h(
        'header',
        { class: 'infra-module-head' },
        h(
          'div',
          { class: 'infra-module-title' },
          h('h5', { class: 'infra-module-name', text: moduleName }),
          h(
            'span',
            { class: 'infra-module-sub' },
            badge(module.id.toUpperCase(), 'neutral', { title: t('infra.module.idKind', { id: module.id, kind: module.kind }) }),
            h('span', { class: 'mono small', text: moduleVersionLabel(module.version) }),
          ),
        ),
        h(
          'div',
          { class: 'infra-module-badges' },
          catalogId && node.disabledModules?.includes(catalogId) ? badge(t('infra.module.policyDisabled'), 'warning') : null,
          badge(t(statusMeta.labelKey), historical ? 'neutral' : statusMeta.tone, {
            dot: true,
            title: historical ? t('infra.module.lastInventory') : t('infra.module.status', { status: module.status }),
          }),
          badge(t(healthMeta.labelKey), historical ? 'neutral' : healthMeta.tone),
          sfuStopRequested ? badge(t('infra.module.sfuStopRequested'), 'warning') : null,
          sfuRestartRequested ? badge(t('infra.module.sfuRestartRequested'), 'warning') : null,
          ...commandBadges,
          noCatalog
            ? badge(t(targetContainerId ? 'infra.module.customLifecycleBadge' : 'infra.module.outsideCatalogBadge'), 'warning', {
                title: t(targetContainerId ? 'infra.module.customLifecycle' : 'infra.module.outsideCatalog'),
              })
            : null,
        ),
      ),
      h(
        'dl',
        { class: 'infra-module-meta' },
        h(
          'div',
          { class: 'infra-module-field' },
          h('dt', { text: t('infra.module.version') }),
          h('dd', { text: moduleVersionLabel(module.version) }),
        ),
        h(
          'div',
          { class: 'infra-module-field' },
          h('dt', { text: t('infra.module.updated') }),
          h('dd', {
            text: moduleUpdatedAtLabel(module.updatedAt),
            title: module.updatedAt === null ? t('infra.module.unknownUpdate') : formatDateTime(module.updatedAt),
          }),
        ),
        h(
          'div',
          { class: 'infra-module-field' },
          h('dt', { text: t('infra.module.ports') }),
          h('dd', { text: modulePortsLabel(module.ports) }),
        ),
        h(
          'div',
          { class: 'infra-module-field' },
          h('dt', { text: t('infra.module.type') }),
          h('dd', { class: 'mono small', text: module.kind }),
        ),
        composeReadOnly ? null : h(
          'div',
          { class: 'infra-module-field' },
          h('dt', { text: t('infra.module.autoStart') }),
          h('dd', {
            text: module.autoStart === undefined ? t('infra.module.noData') : module.autoStart ? t('infra.module.enabled') : t('infra.module.off'),
            title: module.autoStart === undefined
              ? t('infra.module.autoStartUnknown')
              : t('infra.module.autoStartHint'),
          }),
        ),
      ),
      moduleImageRow(module.image),
      module.id === 'recorder' ? h('p', { class: 'infra-module-description', text: t('infra.module.description.recorder') }) : null,
      operatorManaged ? h('p', { class: 'infra-module-description', text: t(externalSfu ? 'infra.module.description.sfu' : 'infra.module.description.ingress') }) : null,
      moduleFailure(node.id, module.id, applyProfile) ?? (module.lastError
        ? h('p', { class: 'infra-module-error', attrs: { role: 'status' } }, t('infra.module.lastError', { error: module.lastError }))
        : null),
      legacyWorker ? null : moduleEnvDetails(entry),
      h('div', { class: 'infra-module-actions' }, ...actionNodes),
      logWindow ? h('details', { class: 'infra-module-log-window' },
        h('summary', { text: t('infra.module.logs'), attrs: { title: t('infra.module.logsHint') } }),
        logWindow.status === 'unavailable' || !logWindow.events.length
          ? h('p', { class: 'cell-sub', text: t(logWindow.status === 'unavailable' ? 'infra.module.logsUnavailable' : 'infra.module.logsEmpty') })
          : h('ul', {}, ...logWindow.events.map(({ time, level, stream }) => h('li', { text: t('infra.module.logEvent', {
            time: formatDateTime(time),
            level: t(`infra.module.logLevel.${level}`),
            stream,
          }) }))),
      ) : null,
    );
  };

  const moduleFailure = (nodeId: string, moduleId: string, applyProfile = false): HTMLElement | null => {
    const failure = moduleStates.get(nodeId)?.failures.find((item) => item.moduleId === moduleId);
    if (!failure) return null;
    const detail = failure.reason === 'delivery_expired' ? t('infra.module.deliveryExpired')
      : failure.reason === 'result_expired' ? t('infra.module.resultExpired')
        : failure.reason === 'target_changed' ? t('infra.module.targetChanged') : failure.error;
    return h(
      'p',
      { class: 'infra-module-error', attrs: { role: 'status' } },
      `${t(failure.reason && failure.reason !== 'target_changed' ? 'infra.module.commandExpired' : 'infra.module.failed')} · ${t(
        applyProfile && failure.action === 'install' ? 'infra.module.applyProfileStatus' : `infra.module.action.${failure.action}`)}${detail ? `: ${detail}` : ''}`,
    );
  };

  /** One catalog entry that is not installed yet (install uses the catalog image). */
  const catalogModuleItem = (node: NodeSummary, entry: NodeModuleCatalogEntry): HTMLElement => {
    const commandBadges = moduleCommandBadges(node, entry.id);
    const disabledReason = moduleActionDisabledReason(node, entry.id);
    const moduleName = t(`infra.module.name.${entry.id}`);
    const install = moduleActionButton(node, entry.id, 'install', { moduleName });
    if (commandBadges.length > 0) install.disabled = true;
    return h(
      'article',
      { class: 'infra-module infra-module-catalog', dataset: { moduleId: entry.id } },
      h(
        'header',
        { class: 'infra-module-head' },
        h(
          'div',
          { class: 'infra-module-title' },
          h('h5', { class: 'infra-module-name', text: moduleName }),
          h(
            'span',
            { class: 'infra-module-sub' },
            badge(entry.id.toUpperCase(), 'neutral', { title: t('infra.module.id', { id: entry.id }) }),
            badge(t('infra.module.notInstalled'), 'neutral'),
          ),
        ),
        commandBadges.length > 0
          ? h('div', { class: 'infra-module-badges' }, ...commandBadges)
          : null,
      ),
      h('p', { class: 'infra-module-description', text: t(`infra.module.description.${entry.id}`) }),
      moduleFailure(node.id, entry.id),
      h(
        'dl',
        { class: 'infra-module-meta' },
        h(
          'div',
          { class: 'infra-module-field' },
          h('dt', { text: t('infra.module.catalogPorts') }),
          h('dd', { text: modulePortsLabel(entry.ports) }),
        ),
        h(
          'div',
          { class: 'infra-module-field' },
          h('dt', { text: t('infra.module.actions') }),
          h('dd', { text: entry.actions.filter((action) => !isNodeModuleAutoStartAction(action)).map((action) => moduleActionLabel(action).toLowerCase()).join(', ') }),
        ),
      ),
      moduleImageRow(entry.image),
      moduleEnvDetails(entry),
      h(
        'div',
        { class: 'infra-module-actions' },
        commandBadges.length === 0 ? h('span', {
          class: 'cell-sub',
          text: disabledReason ?? `${t('infra.module.installHint')} ${moduleActionNote(node)}`,
        }) : null,
        install,
      ),
    );
  };

  /** Panel content for one node: states, inventory, catalog installs, env note. */
  const modulesPanelContent = (node: NodeSummary): HTMLElement[] => {
    const state = moduleStates.get(node.id) ?? null;
    const loading = state?.status === 'loading';
    const snapshot = moduleInventory(node);
    const inventory = readNodeModules(snapshot);
    const { modules } = inventory;
    const { availability, inventoryStale: stale } = snapshot;
    const reported = stale === true || availability === 'available' || node.modules !== undefined || modules.length > 0;
    const inaccessible = availability === 'disabled' || availability === 'unavailable';
    const historical = inaccessible || stale === true || node.status === 'offline' || node.status === 'disabled';
    const catalogReady = moduleCatalog.status === 'ready';
    const content: HTMLElement[] = [];
    const refresh = button(undefined, {
      variant: 'subtle',
      size: 'sm',
      icon: 'refresh',
      title: t('infra.module.refresh'),
      onClick: () => {
        if (!moduleLoads.has(node.id)) void loadNodeModules(node.id);
      },
    });
    refresh.dataset.moduleFocus = 'refresh';
    refresh.setAttribute('aria-disabled', String(loading));

    content.push(
      h(
        'div',
        { class: 'infra-modules-head' },
        h(
          'div',
          { class: 'infra-modules-heading' },
          h('h4', { class: 'infra-modules-title', text: t('infra.module.title') }),
          h('p', {
            class: 'infra-modules-note',
            text: t('infra.module.intro'),
          }),
        ),
        h(
          'div',
          { class: 'infra-modules-head-actions' },
          refresh,
        ),
      ),
    );
    if (reported) content.push(h(
        'div',
        { class: 'infra-modules-chips' },
        historical ? badge(t('infra.module.lastInventory'), 'neutral') : null,
        badge(t('infra.module.total', { count: formatNumber(inventory.total) }), 'neutral'),
        badge(t('infra.module.running', { count: formatNumber(inventory.running) }), !historical && inventory.running > 0 ? 'success' : 'neutral', {
          dot: true,
        }),
        inventory.errors > 0 ? badge(t('infra.module.errors', { count: formatNumber(inventory.errors) }), 'danger') : null,
        inventory.installing > 0 ? badge(t('infra.module.installing', { count: formatNumber(inventory.installing) }), 'info') : null,
        inventory.unhealthy > 0 ? badge(t('infra.module.healthIssues', { count: formatNumber(inventory.unhealthy) }), 'warning') : null,
        !historical && state?.loadedAt !== null && state?.loadedAt !== undefined
          ? h('span', { class: 'cell-sub', text: t('infra.module.refreshed', { time: relativeTime(state.loadedAt) }) })
          : null,
    ));

    if (loading && modules.length === 0) content.push(loadingPanel(t('infra.module.loading')));
    if (state?.status === 'unsupported') {
      content.push(
        alert(
          'warning',
          t('infra.module.inventoryUnsupported'),
          t('infra.module.inventoryUnsupportedHint'),
        ),
      );
    } else if (state?.status === 'error') {
      const retry = button(t('common.retry'), {
        variant: 'ghost',
        size: 'sm',
        icon: 'refresh',
        onClick: () => void loadNodeModules(node.id),
      });
      retry.dataset.moduleFocus = 'retry';
      content.push(
        alert(
          'danger',
          t('infra.module.loadError'),
          moduleErrorDetail(state.error),
          retry,
        ),
      );
    }
    if (!canManage()) {
      content.push(
        alert(
          'info',
          t('infra.module.readOnly'),
          status?.cluster?.role === 'standby'
            ? t('infra.module.standby')
            : t('infra.module.noPermission'),
        ),
      );
    } else if (node.status === 'disabled') {
      content.push(
        alert(
          'warning',
          t('infra.module.nodeDisabled'),
          t('infra.module.nodeDisabledHint'),
        ),
      );
    } else if (node.status === 'offline') {
      content.push(
        alert(
          'warning',
          t('infra.module.nodeOffline'),
          t('infra.module.lastHeartbeat', { time: node.lastSeenAt === null ? t('infra.module.never') : relativeTime(node.lastSeenAt) })
            + (inaccessible ? '' : ` ${t('infra.module.queueExpires', { minutes: moduleCommandMinutes })}`),
        ),
      );
    }
    if (inaccessible) {
      content.push(alert(
        'warning',
        t(availability === 'disabled' ? 'infra.module.disabled' : 'infra.module.dockerUnavailable'),
        t(availability === 'disabled' ? 'infra.module.enableAgent' : 'infra.module.recoverDocker'),
      ));
    }
    if (moduleCatalog.status === 'unsupported') {
      content.push(
        alert(
          'warning',
          t('infra.module.catalogUnavailable'),
          t('infra.module.catalogUnsupportedHint'),
        ),
      );
    } else if (moduleCatalog.status === 'error') {
      content.push(
        alert(
          'danger',
          t('infra.module.catalogError'),
          [moduleErrorDetail(moduleCatalog.error), t('infra.module.catalogErrorHint')].filter(Boolean).join(' '),
          button(t('common.retry'), {
            variant: 'ghost',
            size: 'sm',
            icon: 'refresh',
            onClick: () => void loadModuleCatalog({ force: true }),
          }),
        ),
      );
    }

    if (canManage()) {
      const prepare = button(t('infra.module.draft.open'), {
        variant: 'subtle', size: 'sm',
        onClick: () => openModuleTemplateDraft(ctx, node.id, { reservedIds: new Set([
          ...modules.map(({ id }) => id), ...(state?.templates ?? []).map(({ id }) => id),
        ]) }, () => {
          const panel = mountedModulePanels.get(node.id);
          if (!prepare.isConnected && panel?.isConnected) restoreModuleFocus(panel, 'template-draft');
        }),
      });
      prepare.dataset.moduleFocus = 'template-draft';
      content.push(h('div', { class: 'infra-module-actions' }, prepare));
    }

    if (loading && modules.length === 0) return content;

    if (!reported) {
      if (inaccessible) return content;
      content.push(
        emptyState({
          title: t('infra.module.notReported'),
          message:
            t('infra.module.notReportedHint'),
          iconName: 'server',
          compact: true,
        }),
      );
      content.push(
        h('p', {
          class: 'infra-modules-note',
          text: t('infra.module.envHint'),
        }),
      );
      return content;
    }

    if (modules.length === 0 && !inaccessible) {
      content.push(
        emptyState({
          title: t('infra.module.empty'),
          message:
            t('infra.module.emptyHint'),
          iconName: 'server',
          compact: true,
        }),
      );
    } else if (modules.length > 0) {
      content.push(h('div', { class: 'infra-modules-list' }, ...modules.map((module) => moduleItem(node, module, historical))));
    }

    if (state?.templates?.length) {
      content.push(h('div', { class: 'section-title', text: t('infra.module.templates') }));
      content.push(h('div', { class: 'infra-modules-list infra-module-templates' }, ...state.templates.map((template) => {
        const { id, image, cached, installable, blockedReason, resources, storage, profileChanged, privatePorts } = template;
        const limits = resources ?? nodeTemplateResourceDefaults;
        const current = modules.find((module) => module.id === id);
        const applyProfile = !historical && current?.image === image && profileChanged === true &&
          cached && installable === true && !blockedReason;
        const commandBadges = moduleCommandBadges(node, id, applyProfile);
        const targetContainerId = current?.templateRemovable && current.status === 'running' && (current.image !== image || applyProfile)
          ? current.lifecycleContainerId : undefined;
        const canInstall = installable && cached && !blockedReason && !historical && node.status === 'online' && !node.drain &&
          (!current || targetContainerId);
        const review = canManage() && !historical ? button(t('infra.module.review.open'), {
          size: 'sm', variant: 'subtle',
          onClick: () => openModuleTemplateDraft(ctx, node.id, { template }, () => {
            const panel = mountedModulePanels.get(node.id);
            if (!review?.isConnected && panel?.isConnected) restoreModuleFocus(panel, `template-review:${id}`);
          }),
        }) : null;
        if (review) review.dataset.moduleFocus = `template-review:${id}`;
        return h('article', { class: 'infra-module', dataset: { templateId: id } },
          h('header', { class: 'infra-module-head' },
            h('h5', { class: 'infra-module-name', text: id }),
            badge(historical ? t('infra.module.lastInventory') : blockedReason
              ? t(`infra.module.templateBlocked.${blockedReason}`)
              : t(cached ? 'infra.module.templateCached' : 'infra.module.templateMissing'),
            cached && !historical && !blockedReason ? 'success' : 'neutral'),
          ),
          moduleImageRow(image),
          applyProfile ? h('p', { class: 'cell-sub', text: t('infra.module.profileChanged') }) : null,
          storage ? h('p', { class: 'cell-sub', text: t('infra.module.templateStorage') }) : null,
          privatePorts ? h('p', { class: 'cell-sub', text: t('infra.module.templatePrivatePorts', {
            ports: privatePorts.map(({ port, protocol }) => `${port}/${protocol.toUpperCase()}`).join(', '),
          }) }) : null,
          resources || installable ? h('p', { class: 'cell-sub', text: t('infra.module.templateResources', {
            cpu: formatNumber(limits.cpuMillicores / 1000),
            memory: formatNumber(limits.memoryMiB),
            processes: formatNumber(limits.pidsLimit),
          }) }) : null,
          ...(commandBadges.length > 0 ? commandBadges : canInstall ? [
            moduleActionButton(node, id, 'install', { moduleName: id, expectedImage: image, targetContainerId, applyProfile }),
            h('p', { class: 'cell-sub', text: t(storage ? 'infra.module.templateNoNetwork' : 'infra.module.templateIsolation') }),
          ] : []),
          review,
          moduleFailure(node.id, id, applyProfile),
        );
      })));
    }
    const available = catalogReady ? availableCatalogEntries(moduleCatalog.entries, modules.map((module) => module.id)) : [];
    if (available.length > 0) {
      content.push(h('div', { class: 'section-title', text: inaccessible ? t('infra.module.catalog') : t('infra.module.available') }));
      content.push(
        h('div', { class: 'infra-modules-list' }, ...available.map((entry) => catalogModuleItem(node, entry))),
      );
    } else if (catalogReady && moduleCatalog.entries.length > 0) {
      content.push(h('p', { class: 'infra-modules-note', text: t('infra.module.catalogComplete') }));
    } else if (!catalogReady && moduleCatalog.status !== 'error' && moduleCatalog.status !== 'unsupported') {
      content.push(loadingPanel(t('infra.module.catalogLoading')));
    }

    for (const id of ['ingress', 'sfu', 'egress', 'sip'] as const) {
      const entry = catalogReady ? moduleCatalogEntry(moduleCatalog.entries, id) : null;
      if (!entry || entry.actions.includes('install') || modules.some((module) => module.id === id)) continue;
      if (id === 'sfu' && (!['sfu', 'all'].includes(node.role) || !node.features.includes('sfu'))) continue;
      content.push(h('article', { class: 'infra-module infra-module-manual', dataset: { moduleId: id } },
        h('h5', { class: 'infra-module-name', text: t(`infra.module.name.${id}`) }),
        h('p', { class: 'infra-module-description', text: t(`infra.module.description.${id}`) }),
        id === 'egress' || id === 'sip' ? h('div', { class: 'stack' },
          h('p', { class: 'cell-sub', text: t('infra.module.composeProvision') }),
          moduleImageRow(entry.image),
          moduleEnvDetails(entry),
        ) : null,
      ));
    }
    content.push(
      h('p', {
        class: 'infra-modules-note',
        text: t('infra.module.envHint'),
      }),
    );
    return content;
  };

  const nodeCard = (node: NodeSummary): HTMLElement => {
    const metrics = readNodeMetrics(node);
    const headingId = uid('infra-node');
    const stateLabel = t(`infra.node.status.${node.status}`);
    const mediaStatuses = nodeMediaStatuses(node);
    const metricsAge = metrics.reportedAt === null ? null : relativeTime(metrics.reportedAt);
    const reportedHint = metricsAge ? t('infra.node.metrics.receivedWithAge', { age: metricsAge }) : '';
    const heartbeatAt = node.lastSeenAt === null ? null : formatDateTime(node.lastSeenAt);
    const heartbeatLabel = node.lastSeenAt === null ? '—' : relativeTime(node.lastSeenAt);
    const metric = (name: 'load' | 'rooms' | 'participants' | 'traffic' | 'uptime', value: string): HTMLElement => {
      const label = t(`infra.node.metrics.${name}`);
      return nodeStat(label, value, metricsTooltip(label, value, reportedHint));
    };
    const capacity = formatConfiguredCapacity(node.capacity);
    const version = nodeVersionLabel(node, metrics);
    const features = node.features.join(', ');
    const expanded = expandedNodeIds.has(node.id);
    const modulesPanelId = uid('infra-modules');
    // Count on the collapsed card comes from node.modules already in the list
    // response; the expanded panel additionally polls GET .../modules.
    const modulesToggle = h(
      'button',
      {
        class: 'infra-modules-toggle',
        attrs: {
          type: 'button',
          'aria-expanded': expanded ? 'true' : 'false',
          'aria-controls': modulesPanelId,
          title: expanded ? t('infra.module.close') : t('infra.module.open'),
        },
      },
      h('span', { class: 'infra-modules-toggle-icon', attrs: { 'aria-hidden': 'true' } }, icon('chevron-right', 16)),
      h('span', { class: 'infra-modules-toggle-label', text: t('infra.module.title') }),
      h('span', { class: 'infra-modules-toggle-count', text: moduleToggleText(node) }),
    );
    const modulesPanel = h('div', {
      class: 'infra-modules',
      attrs: {
        id: modulesPanelId,
        role: 'region',
        'aria-label': t('infra.module.region', { node: node.name || node.id }),
        tabindex: '-1',
        hidden: !expanded,
      },
    });
    if (expanded) {
      modulesPanel.append(...modulesPanelContent(node));
      mountedModulePanels.set(node.id, modulesPanel);
    }
    modulesToggle.addEventListener('click', () => {
      const open = !expandedNodeIds.has(node.id);
      if (open) {
        expandedNodeIds.add(node.id);
        mountedModulePanels.set(node.id, modulesPanel);
        modulesToggle.setAttribute('aria-expanded', 'true');
        modulesToggle.title = t('infra.module.close');
        modulesPanel.hidden = false;
        cardNode.classList.add('is-expanded');
        modulesPanel.replaceChildren(...modulesPanelContent(node));
        void loadModuleCatalog();
        void loadNodeModules(node.id);
      } else {
        expandedNodeIds.delete(node.id);
        mountedModulePanels.delete(node.id);
        modulesToggle.setAttribute('aria-expanded', 'false');
        modulesToggle.title = t('infra.module.open');
        modulesPanel.hidden = true;
        cardNode.classList.remove('is-expanded');
      }
    });

    const cardNode = h(
      'article',
      {
        class: `infra-node infra-node-${node.status}${expanded ? ' is-expanded' : ''}`,
        dataset: { key: node.id },
        attrs: { 'aria-labelledby': headingId },
      },
      h(
        'header',
        { class: 'infra-node-head' },
        h(
          'div',
          { class: 'infra-node-identity' },
          h('span', { class: `infra-node-dot is-${node.status}`, attrs: { 'aria-hidden': 'true' } }),
          h(
            'div',
            { class: 'infra-node-title' },
            h('h3', { class: 'infra-node-name', text: node.name || node.id, attrs: { id: headingId }, title: `Узел ${node.id}` }),
            // When the node registered without a name the heading already shows
            // the id, so the mono id line would just repeat it.
            node.name ? h('span', { class: 'infra-node-id mono', text: node.id, title: `ID узла: ${node.id}` }) : null,
          ),
        ),
        h(
          'div',
          { class: 'infra-node-badges' },
          badge(NODE_ROLE_BADGES[node.role].label, NODE_ROLE_BADGES[node.role].tone, { title: NODE_ROLE_LABELS[node.role] }),
          badge(stateLabel, NODE_STATUS_TONES[node.status], { dot: true, title: t('infra.node.statusHint', { status: stateLabel }) }),
          ...mediaStatuses.map(({ label, tone, hint }) => badge(label, tone, { title: hint })),
          h('span', { class: 'infra-node-region', text: node.region || t('infra.node.metrics.regionUnknown') }),
        ),
      ),
      h('div', { class: 'infra-node-meters' }, nodeMeter('CPU', metrics.cpuPercent, reportedHint), nodeMeter('RAM', metrics.memoryPercent, reportedHint)),
      h(
        'dl',
        { class: 'infra-node-stats' },
        metric('load', formatLoad1(metrics.load1)),
        metric('rooms', formatCount(metrics.activeRooms)),
        metric('participants', formatCount(metrics.participants)),
        metric('traffic', formatBandwidth(metrics.bandwidthMbps)),
        metric('uptime', formatUptimeMetric(metrics.uptimeSec)),
        nodeStat(
          t('infra.node.metrics.heartbeat'),
          heartbeatLabel,
          heartbeatAt ?? t('infra.node.metrics.heartbeatPending'),
        ),
        nodeStat(t('infra.node.metrics.region'), node.region || '—', node.region || t('infra.node.metrics.regionUnknown')),
        nodeStat(t('infra.node.metrics.version'), version, displayMetric(version)),
        nodeStat(t('infra.node.metrics.capacity'), capacity, t('infra.node.metrics.declaredCapacity')),
      ),
      h(
        'p',
        { class: `infra-node-note${metrics.available ? '' : ' is-muted'}` },
        metrics.available
          ? metricsAge
            ? `${t('infra.node.metrics.receivedWithAge', { age: metricsAge })}${metrics.reportedAt !== null ? ` (${formatDateTime(metrics.reportedAt)})` : ''}`
            : t('infra.node.metrics.received')
          : t('infra.node.metrics.notReceived'),
      ),
      features
        ? h('p', { class: 'infra-node-note' }, h('span', { class: 'cell-sub', text: `features: ${features}` }))
        : null,
      modulesToggle,
      h(
        'footer',
        { class: 'infra-node-actions' },
        button(undefined, {
          variant: 'subtle',
          size: 'sm',
          icon: 'settings',
          title: t('infra.edit.action'),
          disabled: !canManage(),
          onClick: () => editNode(node),
        }),
        button(t(node.drain ? 'infra.node.resume' : 'infra.node.maintenance'), {
          variant: 'ghost',
          size: 'sm',
          icon: 'activity',
          title: t(node.drain ? 'infra.node.resumeAction' : 'infra.node.maintenanceAction'),
          disabled: !canManage(),
          onClick: () => void toggleDrain(node),
        }),
        button(t(node.enabled ? 'infra.node.disable' : 'infra.node.enable'), {
          variant: node.enabled ? 'danger-ghost' : 'ghost',
          size: 'sm',
          icon: node.enabled ? 'lock' : 'unlock',
          title: t(node.enabled ? 'infra.node.disableAction' : 'infra.node.enableAction'),
          disabled: !canManage(),
          onClick: () => void toggleDisabled(node),
        }),
        button(undefined, {
          variant: 'danger-ghost',
          size: 'sm',
          icon: 'trash',
          title: t('infra.node.deleteAction'),
          disabled: !canManage(),
          onClick: () => void removeNode(node),
        }),
      ),
      modulesPanel,
    );
    return cardNode;
  };

  const fleetTile = (key: 'online' | 'offline' | 'draining' | 'disabled', label: string, tone: string, count: number, total: number): HTMLElement =>
    h(
      'div',
      { class: `infra-count is-${tone}`, title: `${label}: ${count} из ${total}` },
      h('span', { class: 'infra-count-value', text: formatNumber(count) }),
      h(
        'span',
        { class: 'infra-count-label' },
        h('span', { class: `infra-count-dot is-${tone}`, attrs: { 'aria-hidden': 'true' } }),
        h('span', { text: label }),
      ),
    );

  const aggregateTile = (label: string, value: string, title: string): HTMLElement =>
    h(
      'div',
      { class: 'infra-aggregate', title },
      h('span', { class: 'infra-aggregate-label', text: label }),
      h('span', { class: `infra-aggregate-value${value === NO_NODE_DATA ? ' is-muted' : ''}`, text: displayMetric(value) }),
    );

  const fleetOverview = (nodeList: readonly NodeSummary[]): HTMLElement => {
    const fleet = summarizeNodes(nodeList);
    const total = fleet.total;
    const noMetricsHint = t('infra.node.metrics.fleetMissing');
    const totalHint = t('infra.node.metrics.fleetTotal');
    const averageHint = t('infra.node.metrics.fleetAverage');
    const segments = total === 0
      ? []
      : FLEET_TILES.filter((key) => fleet[key] > 0).map((key) =>
          h('span', {
            class: `infra-fleet-segment is-${NODE_STATUS_TONES[key]}`,
            attrs: {
              style: `width:${((fleet[key] / total) * 100).toFixed(2)}%`,
              title: `${t(`infra.node.status.${key}`)} ${fleet[key]}`,
            },
          }),
        );
    const distributionLabel = FLEET_TILES.map((key) => `${t(`infra.node.status.${key}`)} ${formatNumber(fleet[key])}`).join(', ');
    return h(
      'div',
      { class: 'infra-fleet' },
      h('div', { class: 'infra-fleet-counts' }, ...FLEET_TILES.map((key) => fleetTile(key, t(`infra.node.status.${key}`), NODE_STATUS_TONES[key], fleet[key], total))),
      h(
        'div',
        { class: 'infra-fleet-bar', attrs: { role: 'img', 'aria-label': distributionLabel, title: distributionLabel } },
        ...segments,
      ),
      h(
        'div',
        { class: 'infra-fleet-aggregates' },
        aggregateTile(
          t('infra.node.metrics.rooms'),
          formatCount(fleet.activeRooms),
          fleet.activeRooms === null ? noMetricsHint : totalHint,
        ),
        aggregateTile(
          t('infra.node.metrics.participants'),
          formatCount(fleet.participants),
          fleet.participants === null ? noMetricsHint : totalHint,
        ),
        aggregateTile(
          t('infra.node.metrics.traffic'),
          formatBandwidth(fleet.bandwidthMbps),
          fleet.bandwidthMbps === null ? noMetricsHint : totalHint,
        ),
        aggregateTile(
          t('infra.node.metrics.avgCpu'),
          formatPercent(fleet.cpuPercentAvg),
          fleet.cpuPercentAvg === null ? noMetricsHint : averageHint,
        ),
        aggregateTile(
          t('infra.node.metrics.avgRam'),
          formatPercent(fleet.memoryPercentAvg),
          fleet.memoryPercentAvg === null ? noMetricsHint : averageHint,
        ),
        aggregateTile(t('infra.node.metrics.reporting'), `${formatNumber(fleet.reporting)} / ${formatNumber(total)}`, t('infra.node.metrics.fleetReporting')),
      ),
    );
  };

  const nodesEmptyState = (): HTMLElement => {
    const empty = emptyState({
      title: 'Подключённых нод пока нет',
      message:
        'Нода подключается одноразовым ключом: выдайте ключ, выполните команду на машине ноды, и после первого heartbeat она появится здесь с метриками.',
      iconName: 'server',
    });
    empty.appendChild(
      h(
        'ol',
        { class: 'infra-onboarding' },
        h('li', {}, 'Нажмите «Выдать ключ узла» и выберите роль, имя и срок действия.'),
        h('li', {}, 'Скопируйте готовую команду — токен показывается один раз.'),
        h('li', {}, 'Выполните команду на машине узла: агент зарегистрируется и начнёт присылать heartbeat и метрики.'),
        h('li', {}, 'Не храните токен в git — только в secret store; после подключения ключ можно отозвать в таблице ниже.'),
      ),
    );
    empty.appendChild(h('div', { class: 'empty-actions' }, issueNodeKey('md', 'primary')));
    return empty;
  };

  const nodesHost = h('div');
  const nodesSearch = tableSearch(t('table.searchNodes'), t('table.searchNodesHint'), () => renderNodeResults());
  const renderNodeResults = (): void => {
    mountedModulePanels.clear();
    const visible = sortNodesForDisplay(nodes.filter((node) => {
      return nodesSearch.matches(node.id, node.name, node.role, NODE_ROLE_LABELS[node.role], node.status,
        t(`infra.node.status.${node.status}`), node.region, ...node.features, ...nodeMediaStatuses(node).map(({ label }) => label));
    }));
    nodesSearch.setCount(visible.length, nodes.length);
    nodesHost.replaceChildren(visible.length === 0 ? emptyState({ title: t('table.noMatches'), compact: true })
      : h('div', { class: 'infra-node-grid' }, ...visible.map((node) => nodeCard(node))));
  };

  const nodesCard = (): HTMLElement => {
    const ordered = sortNodesForDisplay(nodes);
    renderNodeResults();
    return card({
      className: 'infra-nodes-card',
      title: 'Подключённые ноды',
      subtitle:
        'SFU / TURN / STUN / всё-в-одном: статус, живые метрики с heartbeat и заявленная ёмкость. Разверните «Модули» на карточке узла, чтобы увидеть Docker add-on пакеты и действия из allowlist Core. Автообновление каждые 15 с; во фоновой вкладке запросы приостановлены.',
      actions: [issueNodeKey('sm', 'primary')],
      body:
        ordered.length === 0
          ? nodesEmptyState()
          : [
              fleetOverview(ordered),
              nodesSearch.el,
              nodesHost,
            ],
    });
  };

  /* ------------------------------------------------------------------ */
  /* Rendering                                                          */
  /* ------------------------------------------------------------------ */

  const renderSummary = (): void => {
    const cluster = status?.cluster;
    const fleet = summarizeNodes(nodes);
    const activeTokens = tokens.filter((token) => token.status === 'active').length;
    summary.replaceChildren(
      kpiCard({
        label: 'Кластер',
        value: cluster ? (cluster.role === 'leader' ? 'leader' : 'standby') : '—',
        hint: cluster ? `${cluster.id} · v${cluster.version}` : 'Сервер не сообщает идентификатор кластера',
        iconName: 'server',
        tone: cluster?.role === 'leader' ? 'success' : 'info',
      }),
      kpiCard({
        label: 'Ноды онлайн',
        value: formatNumber(fleet.online),
        hint: `из ${formatNumber(fleet.total)} · оффлайн ${formatNumber(fleet.offline)} · drain ${formatNumber(fleet.draining)} · выкл ${formatNumber(fleet.disabled)}`,
        iconName: 'cpu',
        tone: fleet.online > 0 ? 'success' : fleet.total > 0 ? 'warning' : 'default',
      }),
      kpiCard({
        label: 'Участники на нодах',
        value: formatCount(fleet.participants),
        hint:
          fleet.activeRooms === null
            ? `метрики не поступали · нод с метриками ${formatNumber(fleet.reporting)} из ${formatNumber(fleet.total)}`
            : `комнат: ${formatCount(fleet.activeRooms)} · метрики: ${formatNumber(fleet.reporting)} / ${formatNumber(fleet.total)}`,
        iconName: 'activity',
        tone: fleet.participants !== null ? 'info' : 'default',
      }),
      kpiCard({
        label: 'Резервные Core',
        value: status?.counts ? formatNumber(status.counts.standbys) : '—',
        hint: status?.lease?.mode === 'redis' ? 'Резервные Core используют аренду в Redis' : 'Подключение резервных Core',
        iconName: 'globe',
      }),
      kpiCard({
        label: 'Активные ключи',
        value: formatNumber(activeTokens),
        hint: tokens.length > 0 ? `всего ${tokens.length}` : 'ключей пока нет',
        iconName: 'key',
        tone: activeTokens > 0 ? 'info' : 'default',
      }),
    );
  };

  const clusterCard = (): HTMLElement => {
    const cluster = status?.cluster;
    if (!cluster) {
      return card({
        title: 'Кластер',
        subtitle: 'Идентификатор и роль этого Core',
        body: alert(
          'warning',
          'Сервер не поддерживает реестр кластера',
          'Обновите сервер до версии с /v1/admin/cluster/tokens и /v1/admin/nodes. Панель покажет данные после обновления — менять её не нужно.',
        ),
      });
    }
    const limitations = status?.limitations ?? [];
    const standbys = status?.standbys ?? [];
    const leader = status?.leader;
    const lease = status?.lease;
    const ha = status?.ha;
    const failover = status?.failover;
    const leaseTtlSec =
      lease?.ttlRemainingMs !== null && lease?.ttlRemainingMs !== undefined
        ? Math.max(0, Math.round(lease.ttlRemainingMs / 1000))
        : null;
    return card({
      title: 'Кластер',
      subtitle:
        lease?.mode === 'redis'
          ? 'Лидер удерживает аренду в Redis и принимает изменения. Резервный Core может стать лидером после истечения аренды.'
          : lease?.mode === 'standalone'
            ? 'Режим Core без аренды в Redis'
            : 'Роль и состояние этого Core',
      body: h(
        'div',
        { class: 'stack infra-cluster' },
        failover?.detected
          ? alert(
              'warning',
              failover.previousLeaderId
                ? `Failover: лидерство перешло от ${failover.previousLeaderId}`
                : 'Failover: этот Core перехватил лидерство',
              failover.message,
            )
          : null,
        h(
          'div',
          { class: 'kv-grid' },
          h('div', { class: 'kv' }, h('div', { class: 'kv-label', text: 'ID кластера' }), h('div', { class: 'kv-value mono', text: cluster.id })),
          h(
            'div',
            { class: 'kv' },
            h('div', { class: 'kv-label', text: 'Роль' }),
            h('div', { class: 'kv-value' }, badge(cluster.role, cluster.role === 'leader' ? 'success' : 'info', { dot: true })),
          ),
          h('div', { class: 'kv' }, h('div', { class: 'kv-label', text: 'Версия' }), h('div', { class: 'kv-value mono', text: cluster.version })),
          h('div', { class: 'kv' }, h('div', { class: 'kv-label', text: 'Сервер (nodeId)' }), h('div', { class: 'kv-value mono', text: status?.nodeId ?? ha?.nodeId ?? '—' })),
          h(
            'div',
            { class: 'kv' },
            h('div', { class: 'kv-label', text: 'Лидер' }),
            h(
              'div',
              { class: 'kv-value mono' },
              leader?.id ?? '—',
              leader?.self ? h('span', { class: 'cell-sub', text: ' (этот Core)' }) : null,
            ),
          ),
          h(
            'div',
            { class: 'kv' },
            h('div', { class: 'kv-label', text: 'Источник лидерства' }),
            h(
              'div',
              { class: 'kv-value' },
              lease ? badge(lease.mode === 'redis' ? 'Redis lease' : 'standalone', lease.mode === 'redis' ? 'info' : 'neutral', { dot: true }) : '—',
            ),
          ),
          h(
            'div',
            { class: 'kv' },
            h('div', { class: 'kv-label', text: 'Аренда лидера' }),
            h(
              'div',
              { class: 'kv-value' },
              lease?.held ? badge('удерживается', 'success', { dot: true }) : badge('не удерживается', 'warning', { dot: true }),
            ),
          ),
          h(
            'div',
            { class: 'kv' },
            h('div', { class: 'kv-label', text: 'TTL аренды' }),
            h('div', {
              class: 'kv-value mono',
              text:
                lease?.mode === 'standalone'
                  ? 'без TTL (single Core)'
                  : leaseTtlSec !== null
                    ? `${leaseTtlSec} с из ${Math.round((lease?.ttlMs ?? 0) / 1000)} с`
                    : '—',
            }),
          ),
          h(
            'div',
            { class: 'kv' },
            h('div', { class: 'kv-label', text: 'Дедлайн (validUntil)' }),
            h('div', { class: 'kv-value mono', text: lease?.validUntil ? formatDateTime(lease.validUntil) : '—' }),
          ),
          h(
            'div',
            { class: 'kv' },
            h('div', { class: 'kv-label', text: 'Redis' }),
            h('div', {
              class: 'kv-value',
              text:
                lease?.mode === 'standalone'
                  ? 'не используется'
                  : lease?.redisConnected
                    ? 'подключён'
                    : 'нет связи — изменения остановятся по дедлайну',
            }),
          ),
          h(
            'div',
            { class: 'kv' },
            h('div', { class: 'kv-label', text: 'Heartbeat лидера' }),
            h('div', { class: 'kv-value', text: leader?.heartbeatAt ? relativeTime(leader.heartbeatAt) : '—' }),
          ),
          h(
            'div',
            { class: 'kv' },
            h('div', { class: 'kv-label', text: 'Registry lock' }),
            h('div', { class: 'kv-value', text: ha?.registryLockHeld ? 'удерживается лидером' : 'не удерживается' }),
          ),
        ),
        lease?.reason ? h('div', { class: 'cell-sub' }, h('span', { class: 'mono small', text: lease.reason })) : null,
        ha
          ? h(
              'div',
              { class: 'cell-sub' },
              h('span', {
                text:
                  `Репликация состояния: комнаты — ${ha.roomStateReplicated ? 'да' : 'нет'}, конфиг организации — ` +
                  `${ha.tenantConfigReplicated ? 'да' : 'нет'}, реестр узлов — ${ha.nodeRegistryReplicated ? 'да' : 'нет'} ` +
                  `(хранилище: ${ha.stateStore}).`,
              }),
            )
          : null,
        standbys.length > 0
          ? h(
              'div',
              {},
              h('div', { class: 'section-title', text: 'Резервные Core в реестре' }),
              dataTable({
                columns: [
                  { key: 'id', header: 'ID', render: (standby) => h('span', { class: 'mono small', text: standby.id }) },
                  { key: 'version', header: 'Версия', render: (standby) => standby.version || '—' },
                  { key: 'region', header: 'Регион', render: (standby) => standby.region || '—' },
                  { key: 'registeredAt', header: 'Подключён', render: (standby) => formatDateTime(standby.registeredAt) },
                  {
                    key: 'lastSeenAt',
                    header: 'Активность',
                    render: (standby) =>
                      standby.lastSeenAt
                        ? relativeTime(standby.lastSeenAt)
                        : h('span', { class: 'cell-sub', text: 'нет heartbeat' }),
                  },
                ],
                rows: standbys,
                className: 'table-cards table-compact',
                empty: emptyState({ title: 'Резервных Core нет', message: 'Подключите standby токеном типа core.', compact: true }),
              }),
            )
          : null,
        limitations.length > 0
          ? h(
              'div',
              {},
              h('div', { class: 'section-title', text: 'Ограничения текущего этапа' }),
              h('ul', { class: 'infra-limitations' }, ...limitations.map((limitation) =>
                h('li', { text: locale === 'ru' ? LIMITATION_RU[limitation] ?? limitation : limitation }))),
            )
          : null,
      ),
    });
  };

  const tokensCard = (): HTMLElement =>
    card({
      title: 'Ключи и токены подключения',
      subtitle: 'Одноразовые ключи узлов и токены резервных Core: сервер хранит только хэш, поэтому значение показывается один раз',
      actions: [
        button('Токен Core', { variant: 'ghost', size: 'sm', icon: 'server', disabled: !canManage(), onClick: () => openIssueToken('core') }),
        issueNodeKey('sm', 'primary'),
      ],
      body: dataTable<EnrollmentTokenSummary>({
        columns: [
          {
            key: 'id',
            header: 'Токен',
            render: (token) =>
              h(
                'div',
                { class: 'cell-stack' },
                h('span', { class: 'mono small', text: token.id }),
                h('span', { class: 'cell-sub', text: token.label || '—' }),
                h('span', {
                  class: 'cell-sub',
                  text: token.createdBy,
                  title: `Создан: ${formatDateTime(token.createdAt)}`,
                }),
              ),
          },
          {
            key: 'kind',
            header: 'Тип',
            render: (token) =>
              h(
                'span',
                { class: 'cell-stack' },
                badge(token.kind === 'core' ? 'core' : 'node', token.kind === 'core' ? 'info' : 'primary'),
                h('span', { class: 'cell-sub', text: token.role }),
              ),
          },
          { key: 'features', header: 'Features', render: (token) => featureList(token.features) },
          { key: 'uses', header: 'Использований', render: (token) => `${token.remainingUses} / ${token.uses}` },
          {
            key: 'expiresAt',
            header: 'Истекает',
            render: (token) =>
              h(
                'span',
                { class: 'cell-stack' },
                h('span', { text: formatDateTime(token.expiresAt) }),
                h('span', { class: 'cell-sub', text: expiryLabel(token.expiresAt) }),
              ),
          },
          {
            key: 'status',
            header: 'Статус',
            render: (token) => badge(TOKEN_STATUS[token.status].label, TOKEN_STATUS[token.status].tone, { dot: true }),
          },
          {
            key: 'actions',
            header: 'Действия',
            align: 'right',
            render: (token) =>
              h(
                'div',
                { class: 'cell-actions' },
                button(undefined, {
                  variant: 'danger-ghost',
                  size: 'sm',
                  icon: 'trash',
                  title: 'Отозвать токен',
                  disabled: !canManage() || token.status === 'revoked',
                  onClick: () => void revokeToken(token),
                }),
              ),
          },
        ],
        rows: tokens,
        className: 'table-cards table-compact',
        rowKey: (token) => token.id,
        empty: emptyState({
          title: 'Ключей пока нет',
          message:
            'Выдайте ключ узла, когда разворачиваете SFU/TURN/STUN или узел «всё-в-одном», либо токен Core для резервного сервера. Значение показывается один раз и сразу попадает в реестр.',
          iconName: 'key',
          action: button('Выдать ключ узла', { variant: 'primary', icon: 'key', disabled: !canManage(), onClick: () => openIssueToken('node') }),
        }),
      }),
    });

  const render = (): void => {
    issueNodeKeyHeader.disabled = loading || !canManage();
    // The body is rebuilt below; panels are re-registered by nodeCard for the
    // still-expanded nodes, so drop the stale references first.
    mountedModulePanels.clear();
    if (ctx.platform) {
      summary.replaceChildren();
      body.replaceChildren(
        emptyState({
          title: 'Инфраструктура доступна ключу организации',
          message:
            'Реестр кластера и ключи привязаны к организации. Войдите ключом организации (x-api-key) или сессией администратора — платформенный ключ этот раздел не открывает.',
          iconName: 'lock',
        }),
      );
      return;
    }
    if (loading && tokens.length === 0 && nodes.length === 0 && !status) {
      summary.replaceChildren();
      body.replaceChildren(loadingPanel('Загружаем инфраструктуру…'));
      return;
    }
    if (error !== null) {
      summary.replaceChildren();
      body.replaceChildren(errorState(error, () => void load()));
      return;
    }
    if (unsupported) {
      summary.replaceChildren();
      body.replaceChildren(
        alert(
          'warning',
          'Сервер не поддерживает реестр кластера',
          'Обновите сервер до версии с /v1/admin/cluster/tokens и /v1/admin/nodes. Панель покажет ключи и ноды после обновления — менять её не нужно.',
        ),
      );
      return;
    }
    const restoreSearchFocus = document.activeElement === nodesSearch.input;
    const focusedPanel = document.activeElement?.closest<HTMLElement>('.infra-modules');
    const focusedNodeId = focusedPanel?.closest<HTMLElement>('.infra-node')?.dataset.key;
    const focusKey = focusedPanel ? moduleFocusKey(focusedPanel) : undefined;
    renderSummary();
    body.replaceChildren(
      ...(status?.cluster?.role === 'standby' ? [alert('info', 'Резервный Core', 'Реестр открыт для чтения. Чтобы изменить его, откройте панель лидера.')] : []),
      clusterCard(),
      nodesCard(),
      tokensCard(),
    );
    if (restoreSearchFocus && nodesSearch.input.isConnected) nodesSearch.input.focus({ preventScroll: true });
    if (focusedNodeId && focusKey !== undefined) {
      const panel = mountedModulePanels.get(focusedNodeId);
      if (panel) restoreModuleFocus(panel, focusKey);
      else if (nodesSearch.input.isConnected) nodesSearch.input.focus({ preventScroll: true });
    }
  };

  const load = async (options: { silent?: boolean } = {}): Promise<void> => {
    if (destroyed || ctx.platform) {
      render();
      return;
    }
    // Never overlap requests: the 15 s tick and the manual refresh share one slot.
    if (inFlight) return;
    inFlight = true;
    const request = ++inventoryRequest;
    if (!options.silent) loading = true;
    try {
      const [tokenList, nodeList, cluster] = await Promise.all([
        ctx.api.clusterTokens(),
        ctx.api.nodes(),
        ctx.api.clusterStatus().catch(() => null),
      ]);
      if (destroyed) return;
      tokens = tokenList;
      nodes = nodeList;
      nodeListInventoryRequest = request;
      status = cluster;
      unsupported = false;
      error = null;
      ctx.setServerStatus('online');
      // Drop expansion/cache for nodes that left the registry, then poll the
      // inventory of every expanded node (docs/api/cluster.md §10.2 step 5).
      const liveNodeIds = new Set(nodes.map((node) => node.id));
      for (const nodeId of [...expandedNodeIds]) {
        if (liveNodeIds.has(nodeId)) continue;
        expandedNodeIds.delete(nodeId);
        moduleStates.delete(nodeId);
        mountedModulePanels.delete(nodeId);
      }
      if (expandedNodeIds.size > 0) {
        void loadModuleCatalog();
        for (const nodeId of expandedNodeIds) void loadNodeModules(nodeId);
      }
    } catch (err) {
      if (destroyed) return;
      const info = describeError(err);
      if (err instanceof ApiError && [404, 405, 501].includes(err.status)) {
        unsupported = true;
        error = null;
      } else {
        error = err;
        if (info.offline) ctx.setServerStatus('offline');
      }
    } finally {
      inFlight = false;
      loading = false;
      if (!destroyed) render();
    }
  };

  /** Background refresh: skipped while the tab is hidden (docs: pause in background). */
  const tick = (): void => {
    if (document.hidden) return;
    void load({ silent: true });
  };
  const onVisibilityChange = (): void => {
    if (!document.hidden) void load({ silent: true });
  };

  void load();
  timer = window.setInterval(tick, NODES_REFRESH_INTERVAL_MS);
  document.addEventListener('visibilitychange', onVisibilityChange);

  return {
    el: root,
    destroy: () => {
      destroyed = true;
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      mountedModulePanels.clear();
      moduleLoads.clear();
    },
  };
};
