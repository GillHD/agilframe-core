/**
 * Connected-nodes view model for the Infrastructure screen.
 *
 * The Core returns `node.metrics` as an optional live snapshot reported on
 * heartbeat (docs/api/cluster.md §3.2). A node that registered but has not sent
 * a heartbeat yet has no `metrics` at all, and a node may report only some
 * fields. The helpers below therefore never invent zeros: a missing value is
 * rendered as «нет данных» by the screen, while this module keeps the raw
 * optional numbers and the fleet aggregation straight.
 *
 * They are pure (no DOM) so they can be covered by the dashboard test run.
 */
import type {
  NodeModuleAction,
  NodeModuleCatalogEntry,
  NodeModuleHealth,
  NodeModuleStatus,
  NodeRole,
  NodeStatus,
} from '@agil/protocol';
import { nodeModuleActions, nodeModuleContainerIdSchema, nodeModuleIdSchema } from '@agil/protocol';
import type { BadgeTone } from '../ui/badge.js';
import { formatNumber, formatUptime, relativeTime } from '../format.js';
import { isEnglish, t, type MessageKey } from '../i18n.js';

const moduleEnvHintsRu = new Map([
  ['AGIL_EGRESS_CORE_URL', 'Базовый URL Core, к которому подключается модуль'],
  ['AGIL_EGRESS_TOKEN', 'Временный токен для подключения, хранится на узле'],
  ['AGIL_EGRESS_WORKER_ID', 'Постоянный идентификатор службы в журнале'],
  ['EGRESS_CONFIG_BODY', 'Конфигурация LiveKit, Redis и хранилища результатов на узле'],
  ['LIVEKIT_API_KEY', 'Ключ API LiveKit, заданный на узле'],
  ['LIVEKIT_API_SECRET', 'Секрет API LiveKit, хранится на узле'],
  ['STT_MODEL_DIR', 'Каталог готовой модели на хосте Docker, подключается только для чтения'],
  ['AGIL_STT_TOKEN', 'Токен API распознавания, хранится на узле'],
  ['AGIL_STT_PREVIOUS_TOKEN', 'Предыдущий токен API распознавания, действует во время ротации и хранится на узле'],
  ['STT_LISTEN_IP', 'IP привязки порта Docker. По умолчанию 127.0.0.1'],
  ['STT_IMAGE_SOURCE', 'pull для скачивания образа или local для готового образа на узле'],
  ['STT_DOCKER_NETWORK', 'Существующая приватная сеть Docker для Core и STT'],
  ['AGIL_RECORDINGS_DIR', 'Каталог записей. По умолчанию /data'],
  ['AGIL_S3_BUCKET', 'Имя бакета S3 для записей'],
  ['AGIL_S3_SECRET_KEY', 'Секретный ключ хранилища, остаётся на узле'],
  ['TURN_REALM', 'Область аутентификации TURN, например calls.example'],
  ['TURN_STATIC_AUTH_SECRET', 'Общий секрет для выдачи временных данных TURN'],
  ['TURN_EXTERNAL_IP', 'Публичный IP реле, если узел находится за NAT'],
  ['AGIL_SIP_TRUNK_HOST', 'Имя хоста SIP-транка'],
  ['AGIL_SIP_TRUNK_SECRET', 'Секрет SIP-транка, хранится на узле'],
  ['AGIL_SIP_TRANSPORT', 'Транспорт SIP. Допустимые значения udp, tcp и tls. По умолчанию udp'],
  ['AGIL_NODE_SIP_CONFIG_DIR', 'Каталог узла с sip.yaml. Compose подключает его только для чтения'],
  ['AGIL_NODE_SIP_CA_FILE', 'Путь к доверенному сертификату CA внутри контейнера'],
]);

export function moduleEnvDescription(name: string, description: string): string {
  return isEnglish() ? description : moduleEnvHintsRu.get(name) ?? description;
}

/** Auto-refresh cadence of the infrastructure screen (docs: no overlap). */
export const NODES_REFRESH_INTERVAL_MS = 15_000;

/** Fallback shown wherever a metric was not reported. */
export const NO_NODE_DATA = 'нет данных';

/** CLI entry-point used by the generated node-enrollment command. */
export const NODE_REGISTER_CLI = 'agil/core/scripts/agil-cli.mjs';

/** CPU/RAM utilisation levels at which a meter changes tone. */
export const METER_WARN_PERCENT = 70;
export const METER_HOT_PERCENT = 90;

/** Structural shape of the optional protocol `NodeMetrics` snapshot. */
export interface NodeMetricsLike {
  cpuPercent?: number | null;
  memoryPercent?: number | null;
  load1?: number | null;
  activeRooms?: number | null;
  participants?: number | null;
  bandwidthMbps?: number | null;
  uptimeSec?: number | null;
  version?: string | null;
  reportedAt?: number | null;
}

/** Anything that may carry a metrics snapshot (a `NodeSummary` fits). */
export interface NodeMetricsSource {
  metrics?: NodeMetricsLike | null;
}

/** Normalised metrics used by the cards; `null` means «not reported». */
export interface NodeMetricsView {
  /** At least one measured value is present (reportedAt alone does not count). */
  available: boolean;
  cpuPercent: number | null;
  memoryPercent: number | null;
  load1: number | null;
  activeRooms: number | null;
  participants: number | null;
  bandwidthMbps: number | null;
  uptimeSec: number | null;
  version: string | null;
  reportedAt: number | null;
}

export type MeterTone = 'ok' | 'warn' | 'hot' | 'unknown';

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Out-of-range percentages are ignored instead of showing a wrong number. */
function percentValue(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 && number <= 100 ? number : null;
}

/** Counters/rates are non-negative; negative or non-finite values are ignored. */
function nonNegativeValue(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

/** Room/participant counters are integers in the protocol. */
function countValue(value: unknown): number | null {
  const number = nonNegativeValue(value);
  return number === null ? null : Math.trunc(number);
}

function versionValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 32) : null;
}

function timestampValue(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

export function emptyMetrics(): NodeMetricsView {
  return {
    available: false,
    cpuPercent: null,
    memoryPercent: null,
    load1: null,
    activeRooms: null,
    participants: null,
    bandwidthMbps: null,
    uptimeSec: null,
    version: null,
    reportedAt: null,
  };
}

/**
 * Reads the optional `node.metrics` snapshot defensively.
 *
 * The screen must keep working when the server predates metrics or when a node
 * reported garbage: unknown fields are ignored, percentages are clamped, and
 * missing values stay `null` (rendered as «нет данных»).
 */
export function readNodeMetrics(source: NodeMetricsSource | null | undefined): NodeMetricsView {
  const raw = source?.metrics;
  if (!raw || typeof raw !== 'object') return emptyMetrics();
  const view: NodeMetricsView = {
    available: false,
    cpuPercent: percentValue(raw.cpuPercent),
    memoryPercent: percentValue(raw.memoryPercent),
    load1: nonNegativeValue(raw.load1),
    activeRooms: countValue(raw.activeRooms),
    participants: countValue(raw.participants),
    bandwidthMbps: nonNegativeValue(raw.bandwidthMbps),
    uptimeSec: countValue(raw.uptimeSec),
    version: versionValue(raw.version),
    reportedAt: timestampValue(raw.reportedAt),
  };
  view.available =
    view.cpuPercent !== null ||
    view.memoryPercent !== null ||
    view.load1 !== null ||
    view.activeRooms !== null ||
    view.participants !== null ||
    view.bandwidthMbps !== null ||
    view.uptimeSec !== null ||
    view.version !== null;
  return view;
}

/** Width of a meter fill in percent (0 when the value is unknown). */
export function meterWidth(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Tone of a CPU/RAM meter (unknown stays neutral instead of looking healthy). */
export function meterTone(value: number | null): MeterTone {
  if (value === null || !Number.isFinite(value)) return 'unknown';
  if (value >= METER_HOT_PERCENT) return 'hot';
  if (value >= METER_WARN_PERCENT) return 'warn';
  return 'ok';
}

function metricNumber(value: number, digits: number, fixed = false): string {
  return value.toLocaleString(isEnglish() ? 'en-US' : 'ru-RU', {
    minimumFractionDigits: fixed ? digits : 0,
    maximumFractionDigits: digits,
  });
}

/** «42 %» / «нет данных». */
export function formatPercent(value: number | null): string {
  return value === null ? NO_NODE_DATA : `${metricNumber(value, 1)}%`;
}

/** «1,25» / «нет данных». */
export function formatLoad1(value: number | null): string {
  return value === null ? NO_NODE_DATA : metricNumber(value, 2, true);
}

/** «120,5 Мбит/с» / «нет данных». */
export function formatBandwidth(value: number | null): string {
  return value === null ? NO_NODE_DATA : t('infra.node.metrics.mbps', { value: metricNumber(value, 1) });
}

/** «3 ч 12 мин» / «нет данных». */
export function formatUptimeMetric(value: number | null): string {
  return value === null ? NO_NODE_DATA : formatUptime(value);
}

/** «1 234» / «нет данных». */
export function formatCount(value: number | null): string {
  return value === null ? NO_NODE_DATA : formatNumber(value);
}

/** Live metrics version wins over the version recorded at registration. */
export function nodeVersionLabel(node: { version?: string | null }, metrics: NodeMetricsView): string {
  const reported = metrics.version;
  if (reported) return reported;
  const registered = typeof node.version === 'string' ? node.version.trim() : '';
  return registered || NO_NODE_DATA;
}

/** Configured (declared) capacity, separate from live load. */
export function formatConfiguredCapacity(capacity: {
  maxRooms?: number | null;
  maxParticipants?: number | null;
  bandwidthMbps?: number | null;
} | null | undefined): string {
  if (!capacity) return NO_NODE_DATA;
  const parts: string[] = [];
  if (capacity.maxRooms && capacity.maxRooms > 0) parts.push(t('infra.node.metrics.capacityRooms', { value: formatNumber(capacity.maxRooms) }));
  if (capacity.maxParticipants && capacity.maxParticipants > 0) parts.push(t('infra.node.metrics.capacityParticipants', { value: formatNumber(capacity.maxParticipants) }));
  if (capacity.bandwidthMbps && capacity.bandwidthMbps > 0) parts.push(t('infra.node.metrics.capacityBandwidth', { value: metricNumber(capacity.bandwidthMbps, 1) }));
  return parts.length > 0 ? parts.join(' · ') : t('infra.node.metrics.capacityUnset');
}

export interface NodeFleetSummary {
  total: number;
  online: number;
  offline: number;
  draining: number;
  disabled: number;
  /** Nodes that reported at least one live metric. */
  reporting: number;
  /** Sums/averages over the nodes that reported the value; null = nobody did. */
  activeRooms: number | null;
  participants: number | null;
  bandwidthMbps: number | null;
  cpuPercentAvg: number | null;
  memoryPercentAvg: number | null;
}

export interface NodeFleetInput {
  status: NodeStatus;
  metrics?: NodeMetricsLike | null;
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  return Math.round((sum / values.length) * 10) / 10;
}

/**
 * Fleet counters and sums behind the online/offline strip and the aggregate
 * tiles. Missing metrics produce `null` aggregates (rendered «нет данных»)
 * rather than a misleading zero.
 */
export function summarizeNodes(nodes: readonly NodeFleetInput[]): NodeFleetSummary {
  const summary: NodeFleetSummary = {
    total: nodes.length,
    online: 0,
    offline: 0,
    draining: 0,
    disabled: 0,
    reporting: 0,
    activeRooms: null,
    participants: null,
    bandwidthMbps: null,
    cpuPercentAvg: null,
    memoryPercentAvg: null,
  };
  const rooms: number[] = [];
  const participants: number[] = [];
  const bandwidth: number[] = [];
  const cpu: number[] = [];
  const memory: number[] = [];
  for (const node of nodes) {
    if (node.status === 'online') summary.online += 1;
    else if (node.status === 'offline') summary.offline += 1;
    else if (node.status === 'draining') summary.draining += 1;
    else summary.disabled += 1;
    const metrics = readNodeMetrics(node);
    if (metrics.available) summary.reporting += 1;
    if (metrics.activeRooms !== null) rooms.push(metrics.activeRooms);
    if (metrics.participants !== null) participants.push(metrics.participants);
    if (metrics.bandwidthMbps !== null) bandwidth.push(metrics.bandwidthMbps);
    if (metrics.cpuPercent !== null) cpu.push(metrics.cpuPercent);
    if (metrics.memoryPercent !== null) memory.push(metrics.memoryPercent);
  }
  summary.activeRooms = rooms.length > 0 ? rooms.reduce((total, value) => total + value, 0) : null;
  summary.participants = participants.length > 0 ? participants.reduce((total, value) => total + value, 0) : null;
  summary.bandwidthMbps = bandwidth.length > 0 ? bandwidth.reduce((total, value) => total + value, 0) : null;
  summary.cpuPercentAvg = average(cpu);
  summary.memoryPercentAvg = average(memory);
  return summary;
}

const STATUS_PRIORITY: Record<NodeStatus, number> = { online: 0, draining: 1, offline: 2, disabled: 3 };

/** Online nodes first, then draining/offline/disabled; name or id inside a group. */
export function sortNodesForDisplay<T extends { status: NodeStatus; id: string; name?: string | null }>(
  nodes: readonly T[],
): T[] {
  return [...nodes].sort((left, right) => {
    const byStatus = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];
    if (byStatus !== 0) return byStatus;
    const leftLabel = (left.name || left.id).toLocaleLowerCase('ru-RU');
    const rightLabel = (right.name || right.id).toLocaleLowerCase('ru-RU');
    return leftLabel.localeCompare(rightLabel, 'ru-RU');
  });
}

/**
 * Shell-safe single-quoted value. Enrollment tokens are `agil_enr_…` and never
 * contain quotes, but names/labels are operator input: never interpolate them raw.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Node id derived from the chosen display name (protocol: URL-safe, ≤64 chars). */
export function slugifyNodeId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 64)
    .replace(/[^a-z0-9]+$/, '');
  return slug;
}

export interface NodeRegisterCommandInput {
  token: string;
  role: NodeRole;
  serverUrl: string;
  /** Optional display name; also becomes `--id` (URL-safe slug) and `--name`. */
  name?: string;
  features?: readonly string[];
}

/**
 * Exact, copy-pasteable node registration command shown after issuing a key:
 *
 *   AGIL_NODE_TOKEN='…' AGIL_CORE_URL='…' \
 *     node agil/core/scripts/agil-cli.mjs nodes register --role sfu --id edge-1 --name 'Edge 1'
 */
export function buildNodeRegisterCommand(input: NodeRegisterCommandInput): string {
  const role = input.role;
  const name = (input.name ?? '').trim().slice(0, 80);
  const nodeId = name ? slugifyNodeId(name) : '';
  const features = [
    ...new Set(
      (input.features ?? [])
        .map((feature) => feature.trim())
        .filter((feature) => feature.length > 0),
    ),
  ];
  const flags: string[] = [`--role ${role}`];
  // `--id` is derived from the name but stays optional: a name that slugifies to
  // nothing (e.g. Cyrillic-only) still travels as `--name` only.
  if (nodeId) flags.push(`--id ${shellQuote(nodeId)}`);
  if (name) flags.push(`--name ${shellQuote(name)}`);
  if (features.length > 0) flags.push(`--features ${shellQuote(features.join(','))}`);
  const env = `AGIL_NODE_TOKEN=${shellQuote(input.token.trim())} AGIL_CORE_URL=${shellQuote(input.serverUrl.trim())}`;
  return `${env} \\\n  node ${NODE_REGISTER_CLI} nodes register ${flags.join(' ')}`;
}

/** Standby Core join example (kept in the same one-time reveal for core tokens). */
export function buildCoreJoinCommand(input: { token: string; serverUrl: string }): string {
  const url = `${input.serverUrl.trim().replace(/\/+$/, '')}/v1/cluster/join`;
  return `curl -X POST ${shellQuote(url)} \\\n  -H 'content-type: application/json' \\\n  -d ${shellQuote(`{"token":"${input.token}","nodeId":"standby-1"}`)}`;
}

/** Tooltip for a metrics value: states the measured value or why it is absent. */
export function metricsTooltip(label: string, value: string, hint?: string): string {
  if (value === NO_NODE_DATA) {
    return `${label}: ${t('infra.node.metrics.valueMissing')}`;
  }
  return hint ? `${label}: ${value} — ${hint}` : `${label}: ${value}`;
}

/* ------------------------------------------------------------------ */
/* Per-node modules (Docker add-on packages, docs/api/cluster.md §10)  */
/* ------------------------------------------------------------------ */

/** Accepted presentation values, including reports from older nodes. */
const NODE_MODULE_STATUSES: readonly NodeModuleStatus[] = ['running', 'stopped', 'error', 'installing', 'unknown'];
const NODE_MODULE_HEALTHS: readonly NodeModuleHealth[] = ['healthy', 'degraded', 'unhealthy', 'unknown'];

export const MODULE_STATUS_META: Record<NodeModuleStatus, { labelKey: MessageKey; tone: BadgeTone }> = {
  running: { labelKey: 'infra.module.status.running', tone: 'success' },
  stopped: { labelKey: 'infra.module.status.stopped', tone: 'neutral' },
  error: { labelKey: 'infra.module.status.error', tone: 'danger' },
  installing: { labelKey: 'infra.module.status.installing', tone: 'info' },
  unknown: { labelKey: 'infra.module.status.unknown', tone: 'neutral' },
};

export const MODULE_HEALTH_META: Record<NodeModuleHealth, { labelKey: MessageKey; tone: BadgeTone }> = {
  healthy: { labelKey: 'infra.module.health.healthy', tone: 'success' },
  degraded: { labelKey: 'infra.module.health.degraded', tone: 'warning' },
  unhealthy: { labelKey: 'infra.module.health.unhealthy', tone: 'danger' },
  unknown: { labelKey: 'infra.module.health.unknown', tone: 'neutral' },
};

/**
 * Normalised module inventory entry. The Core already sanitizes the heartbeat
 * snapshot; the panel still reads it defensively (`version`, `updatedAt` and
 * `lastError` may be missing from an older agent) and never invents a value.
 */
export interface NodeModuleView {
  id: string;
  kind: string;
  name: string;
  /** `''` = version not reported. */
  version: string;
  image: string;
  status: NodeModuleStatus;
  health: NodeModuleHealth;
  autoStart?: boolean;
  lifecycleContainerId?: string;
  sfuDrainState?: 'available' | 'requested' | 'restart_requested';
  templateRemovable?: boolean;
  ports: number[];
  /** Epoch ms of the last state update; `null` = not reported. */
  updatedAt: number | null;
  lastError: string | null;
}

/** Anything that may carry a module inventory (a `NodeSummary` fits). */
export interface NodeModulesSource {
  /** Raw `node.modules`; `undefined`/`null` = never reported. Read defensively. */
  modules?: readonly unknown[] | null;
}

export interface NodeModulesView {
  /** True when `node.modules` is present at all (`[]` = reported: none installed). */
  reported: boolean;
  modules: NodeModuleView[];
  total: number;
  running: number;
  installing: number;
  errors: number;
  unhealthy: number;
  /** Newest `updatedAt` across installed modules; `null` when nobody sent one. */
  lastUpdatedAt: number | null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null;
}

function isKnownModuleStatus(value: string): value is NodeModuleStatus {
  return (NODE_MODULE_STATUSES as readonly string[]).includes(value);
}

function isKnownModuleHealth(value: string): value is NodeModuleHealth {
  return (NODE_MODULE_HEALTHS as readonly string[]).includes(value);
}

function isKnownModuleAction(value: string): value is NodeModuleAction {
  return (nodeModuleActions as readonly string[]).includes(value);
}

function emptyNodeModules(): NodeModulesView {
  return {
    reported: false,
    modules: [],
    total: 0,
    running: 0,
    installing: 0,
    errors: 0,
    unhealthy: 0,
    lastUpdatedAt: null,
  };
}

function readModuleEntry(value: unknown): NodeModuleView | null {
  const raw = recordValue(value);
  if (!raw) return null;
  const id = nodeModuleIdSchema.safeParse(raw['id']).data;
  if (!id) return null;
  const kind = nodeModuleIdSchema.safeParse(raw['kind'] ?? id).data;
  if (!kind) return null;
  const status = textValue(raw['status']);
  if (!status || !isKnownModuleStatus(status)) return null;
  const health = textValue(raw['health']) ?? 'unknown';
  if (!isKnownModuleHealth(health)) return null;
  const image = textValue(raw['image']);
  if (!image) return null;
  const name = textValue(raw['name']) ?? id;
  const version = textValue(raw['version']) ?? '';
  const ports: number[] = [];
  if (Array.isArray(raw['ports'])) {
    for (const port of raw['ports']) {
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) continue;
      if (ports.length >= 8) break;
      ports.push(port);
    }
  }
  const lastError = textValue(raw['lastError']);
  const lifecycleContainerId = nodeModuleContainerIdSchema.safeParse(raw['lifecycleContainerId']).data;
  const sfuDrainState = raw['sfuDrainState'];
  return {
    id,
    kind,
    name: name.slice(0, 80),
    version: version.slice(0, 32),
    image: image.slice(0, 200),
    status,
    health,
    ...(typeof raw['autoStart'] === 'boolean' ? { autoStart: raw['autoStart'] } : {}),
    ...(lifecycleContainerId ? { lifecycleContainerId } : {}),
    ...(id === 'sfu' && (sfuDrainState === 'available' || sfuDrainState === 'requested' || sfuDrainState === 'restart_requested')
      ? { sfuDrainState } : {}),
    ...(lifecycleContainerId && raw['templateRemovable'] === true ? { templateRemovable: true } : {}),
    ports,
    updatedAt: timestampValue(raw['updatedAt']),
    lastError: lastError ? lastError.slice(0, 300) : null,
  };
}

/**
 * Reads the optional `node.modules` inventory defensively.
 *
 * Absence (`undefined`/`null`) honestly means "the node has not reported yet"
 * and is different from `[]` ("reported: no add-ons installed"). Invalid
 * entries are dropped, duplicate ids keep the last report, and no field is
 * zero-filled.
 */
export function readNodeModules(source: NodeModulesSource | null | undefined): NodeModulesView {
  const raw = source?.modules;
  if (!Array.isArray(raw)) return emptyNodeModules();
  const byId = new Map<string, NodeModuleView>();
  for (const item of raw) {
    const module = readModuleEntry(item);
    if (module) byId.set(module.id, module);
  }
  const modules = [...byId.values()];
  let running = 0;
  let installing = 0;
  let errors = 0;
  let unhealthy = 0;
  let lastUpdatedAt: number | null = null;
  for (const module of modules) {
    if (module.status === 'running') running += 1;
    if (module.status === 'installing') installing += 1;
    if (module.status === 'error') errors += 1;
    if (module.health === 'unhealthy') unhealthy += 1;
    if (module.updatedAt !== null && (lastUpdatedAt === null || module.updatedAt > lastUpdatedAt)) {
      lastUpdatedAt = module.updatedAt;
    }
  }
  return { reported: true, modules, total: modules.length, running, installing, errors, unhealthy, lastUpdatedAt };
}

/** «3 из 5 запущено» / «модули не установлены» / «модули не сообщены». */
export function moduleSummaryLabel(view: NodeModulesView): string {
  if (!view.reported) return t('infra.module.summaryUnknown');
  if (view.total === 0) return t('infra.module.summaryEmpty');
  return t('infra.module.summaryRunning', { running: formatNumber(view.running), total: formatNumber(view.total) });
}

/** «Обновлён: 3 мин назад» / «время обновления не сообщено». */
export function moduleUpdatedAtLabel(updatedAt: number | null, now = Date.now()): string {
  return updatedAt === null ? t('infra.module.updateUnknown') : relativeTime(updatedAt, now);
}

/** Trimmed reported version or an explicit «не указана». */
export function moduleVersionLabel(version: string | null | undefined): string {
  const trimmed = typeof version === 'string' ? version.trim().slice(0, 32) : '';
  return trimmed || t('infra.module.versionUnknown');
}

/** «8090, 8091» / «не опубликованы» (informational, as reported by the node). */
export function modulePortsLabel(ports: readonly number[] | null | undefined): string {
  const values = (ports ?? []).filter(
    (port) => typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65_535,
  );
  return values.length > 0 ? values.join(', ') : t('infra.module.portsUnknown');
}

export function moduleActionLabel(action: NodeModuleAction): string {
  return t(`infra.module.verb.${action}`);
}

/** Only `remove` destroys state; it is the action that needs confirmation. */
export function isDestructiveModuleAction(action: NodeModuleAction): boolean {
  return action === 'remove';
}

/** «в очереди: установка, запуск» / `''` when nothing is queued for the module. */
export function modulePendingLabel(actions: readonly NodeModuleAction[]): string {
  return actions.length > 0
    ? t('infra.module.pending', { actions: actions.map((action) => t(`infra.module.action.${action}`).toLocaleLowerCase()).join(', ') })
    : '';
}

export interface ModuleActionContext {
  /** `null` = the module is not installed on this node yet. */
  status: NodeModuleStatus | null;
  autoStart?: boolean;
  /** Actions the Core catalog supports for this module id. */
  catalogActions: readonly NodeModuleAction[];
  /** Commands already queued (not delivered yet) for this module. */
  pendingActions?: readonly NodeModuleAction[];
}

/**
 * Buttons to show for one module.
 *
 * - not installed → only `install`;
 * - a queued command blocks further actions (the Core rejects a duplicate and a
 *   second queued action would make the resulting state ambiguous);
 * - `start` is offered for stopped/error/unknown, `stop` only while running,
 *   `restart` unless installing, `remove` whenever installed;
 * - every action must be allowed by the Core catalog.
 */
export function moduleActionsFor(input: ModuleActionContext): NodeModuleAction[] {
  const allowed = input.catalogActions.filter(isKnownModuleAction);
  const pending = (input.pendingActions ?? []).filter(isKnownModuleAction);
  if (pending.length > 0) return [];
  if (input.status === null) return allowed.includes('install') ? ['install'] : [];
  const actions: NodeModuleAction[] = [];
  const status = input.status;
  if ((status === 'stopped' || status === 'error' || status === 'unknown') && allowed.includes('start')) {
    actions.push('start');
  }
  if (status === 'running' && allowed.includes('stop')) actions.push('stop');
  if (status !== 'installing' && allowed.includes('restart')) actions.push('restart');
  if (input.autoStart !== undefined && status !== 'installing') {
    const action = input.autoStart ? 'disable-autostart' : 'enable-autostart';
    if (allowed.includes(action)) actions.push(action);
  }
  if (allowed.includes('remove')) actions.push('remove');
  return actions;
}

/** Distinct valid actions in a command list for one module id. */
export function modulePendingActions(
  commands: readonly { moduleId: string; action: string }[] | null | undefined,
  moduleId: string,
): NodeModuleAction[] {
  const actions: NodeModuleAction[] = [];
  for (const command of commands ?? []) {
    if (!command || command.moduleId !== moduleId) continue;
    const action = command.action;
    if (!isKnownModuleAction(action) || actions.includes(action)) continue;
    actions.push(action);
  }
  return actions;
}

/** One env hint as the panel may show it: name + description, never a value. */
export interface ModuleEnvHintView {
  name: string;
  required: boolean;
  secret: boolean;
  description: string;
}

/**
 * Env **hints** only. Any `value`/`secretValue` property a (buggy or future)
 * payload might carry is deliberately dropped here: values and secrets never
 * leave the node, so the dashboard can never render them.
 */
export function moduleEnvHints(
  entry: { env?: readonly unknown[] } | null | undefined,
): ModuleEnvHintView[] {
  const raw = entry?.env;
  if (!Array.isArray(raw)) return [];
  const hints: ModuleEnvHintView[] = [];
  for (const item of raw) {
    const hint = recordValue(item);
    if (!hint) continue;
    const name = textValue(hint['name']);
    if (!name || !/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) continue;
    if (hints.length >= 16) break;
    hints.push({
      name,
      required: hint['required'] === true,
      secret: hint['secret'] === true,
      description: textValue(hint['description'])?.slice(0, 200) ?? '',
    });
  }
  return hints;
}

/** Catalog entry for a reported module id; `null` when the server has no such label. */
export function moduleCatalogEntry(
  catalog: readonly NodeModuleCatalogEntry[],
  moduleId: string,
): NodeModuleCatalogEntry | null {
  return catalog.find((entry) => entry.id === moduleId) ?? null;
}

/** Catalog modules that are not installed on the node (offered as `install`). */
export function availableCatalogEntries(
  catalog: readonly NodeModuleCatalogEntry[],
  installedIds: readonly string[],
): NodeModuleCatalogEntry[] {
  const installed = new Set(installedIds);
  return catalog.filter((entry) => !installed.has(entry.id) && entry.actions.includes('install'));
}
