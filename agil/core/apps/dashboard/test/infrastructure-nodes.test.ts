/**
 * Connected-nodes helpers for the Infrastructure screen (QA: node metrics).
 *
 * The protocol field `node.metrics` is optional: a node that has not sent a
 * heartbeat snapshot yet must render «нет данных» instead of a zero, and the
 * same goes for partial snapshots. These tests pin that behaviour, the fleet
 * counters, the display order, and the exact one-time registration command the
 * dashboard shows after issuing a node key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeModuleAction, NodeModuleCatalogEntry } from '@agil/protocol';
import {
  MODULE_HEALTH_META,
  MODULE_STATUS_META,
  NO_NODE_DATA,
  NODE_REGISTER_CLI,
  availableCatalogEntries,
  buildCoreJoinCommand,
  buildNodeRegisterCommand,
  emptyMetrics,
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
  shellQuote,
  slugifyNodeId,
  sortNodesForDisplay,
  summarizeNodes,
} from '../src/screens/infrastructure-nodes.js';

test('missing node.metrics is reported as «нет данных», never as zero', () => {
  for (const source of [{}, { metrics: null }, { metrics: undefined }]) {
    const metrics = readNodeMetrics(source);
    assert.deepEqual(metrics, emptyMetrics());
    assert.equal(formatPercent(metrics.cpuPercent), NO_NODE_DATA);
    assert.equal(formatLoad1(metrics.load1), NO_NODE_DATA);
    assert.equal(formatBandwidth(metrics.bandwidthMbps), NO_NODE_DATA);
    assert.equal(formatUptimeMetric(metrics.uptimeSec), NO_NODE_DATA);
    assert.equal(formatCount(metrics.activeRooms), NO_NODE_DATA);
    assert.equal(nodeVersionLabel({ version: '' }, metrics), NO_NODE_DATA);
    assert.match(metricsTooltip('CPU', NO_NODE_DATA), /node\.metrics/);
  }
  // A registration version is still shown when live metrics are absent.
  assert.equal(nodeVersionLabel({ version: '1.4.2' }, emptyMetrics()), '1.4.2');
});

test('partial metrics: valid values kept, invalid/out-of-range values ignored, counts truncated', () => {
  const metrics = readNodeMetrics({
    metrics: {
      cpuPercent: 140,
      memoryPercent: 42.5,
      load1: 1.234,
      activeRooms: 3.9,
      participants: -1,
      bandwidthMbps: 120.5,
      uptimeSec: Number.NaN,
      version: '  1.4.2-agent ',
      reportedAt: 1_700_000_000_000,
    },
  });
  assert.equal(metrics.available, true);
  assert.equal(metrics.cpuPercent, null);
  assert.equal(metrics.memoryPercent, 42.5);
  assert.equal(metrics.load1, 1.234);
  assert.equal(metrics.activeRooms, 3);
  assert.equal(metrics.participants, null);
  assert.equal(metrics.bandwidthMbps, 120.5);
  assert.equal(metrics.uptimeSec, null);
  assert.equal(metrics.version, '1.4.2-agent');
  assert.equal(metrics.reportedAt, 1_700_000_000_000);
  assert.equal(nodeVersionLabel({ version: '1.0.0' }, metrics), '1.4.2-agent');
});

test('metrics-only snapshot with no measured value stays "not available"', () => {
  const metrics = readNodeMetrics({ metrics: { reportedAt: 42 } });
  assert.equal(metrics.available, false);
  assert.equal(metrics.reportedAt, 42);
});

test('fleet summary counts online/offline/draining/disabled and sums only reported metrics', () => {
  const summary = summarizeNodes([
    { status: 'online', metrics: { cpuPercent: 40, memoryPercent: 50, activeRooms: 2, participants: 10, bandwidthMbps: 100 } },
    { status: 'online' },
    { status: 'offline', metrics: { cpuPercent: 80, memoryPercent: 30, activeRooms: 1, participants: 5, bandwidthMbps: 50 } },
    { status: 'draining' },
    { status: 'disabled' },
  ]);
  assert.equal(summary.total, 5);
  assert.equal(summary.online, 2);
  assert.equal(summary.offline, 1);
  assert.equal(summary.draining, 1);
  assert.equal(summary.disabled, 1);
  assert.equal(summary.reporting, 2);
  assert.equal(summary.activeRooms, 3);
  assert.equal(summary.participants, 15);
  assert.equal(summary.bandwidthMbps, 150);
  assert.equal(summary.cpuPercentAvg, 60);
  assert.equal(summary.memoryPercentAvg, 40);
});

test('fleet summary keeps aggregates null when no node reported metrics', () => {
  const summary = summarizeNodes([{ status: 'offline' }, { status: 'disabled' }]);
  assert.equal(summary.total, 2);
  assert.equal(summary.reporting, 0);
  assert.equal(summary.activeRooms, null);
  assert.equal(summary.participants, null);
  assert.equal(summary.bandwidthMbps, null);
  assert.equal(summary.cpuPercentAvg, null);
  assert.equal(summary.memoryPercentAvg, null);
});

test('node cards sort online first, then draining/offline/disabled, alphabetically inside a group', () => {
  const sorted = sortNodesForDisplay([
    { id: 'd', status: 'disabled' as const },
    { id: 'o2', name: 'beta', status: 'offline' as const },
    { id: 'n2', name: 'zeta', status: 'online' as const },
    { id: 'dr', status: 'draining' as const },
    { id: 'o1', name: 'Alpha', status: 'offline' as const },
    { id: 'n1', name: 'alpha', status: 'online' as const },
  ]);
  assert.deepEqual(
    sorted.map((node) => node.id),
    ['n1', 'n2', 'dr', 'o1', 'o2', 'd'],
  );
});

test('meter helpers clamp width to 0..100 and never show an unknown as healthy', () => {
  assert.equal(meterWidth(42), 42);
  assert.equal(meterWidth(0), 0);
  assert.equal(meterWidth(140), 100);
  assert.equal(meterWidth(-5), 0);
  assert.equal(meterWidth(null), 0);
  assert.equal(meterTone(null), 'unknown');
  assert.equal(meterTone(42), 'ok');
  assert.equal(meterTone(70), 'warn');
  assert.equal(meterTone(95), 'hot');
});

test('node registration command is exact, quoted and copy-pasteable', () => {
  const command = buildNodeRegisterCommand({
    token: 'agil_enr_abc123',
    role: 'sfu',
    serverUrl: 'https://core.example',
    name: 'Edge SFU',
    features: ['sfu', 'egress', 'sfu'],
  });
  assert.equal(
    command,
    "AGIL_NODE_TOKEN='agil_enr_abc123' AGIL_CORE_URL='https://core.example' \\\n" +
      `  node ${NODE_REGISTER_CLI} nodes register --role sfu --id 'edge-sfu' --name 'Edge SFU' --features 'sfu,egress'`,
  );

  // No name/features: the CLI defaults the id and the node reports its own features.
  assert.equal(
    buildNodeRegisterCommand({ token: 'tok', role: 'turn', serverUrl: 'http://127.0.0.1:8787' }),
    "AGIL_NODE_TOKEN='tok' AGIL_CORE_URL='http://127.0.0.1:8787' \\\n" +
      `  node ${NODE_REGISTER_CLI} nodes register --role turn`,
  );

  // A Cyrillic-only name cannot become a URL-safe id but is still passed along.
  const cyrillic = buildNodeRegisterCommand({
    token: 'tok',
    role: 'all',
    serverUrl: 'http://core',
    name: 'Узел Москва',
  });
  assert.match(cyrillic, /--name 'Узел Москва'/);
  assert.doesNotMatch(cyrillic, /--id/);

  // Operator input is single-quote-escaped, so it cannot break out of the shell.
  assert.match(
    buildNodeRegisterCommand({ token: 'tok', role: 'sfu', serverUrl: 'http://core', name: "Edge's" }),
    /--name 'Edge'\\''s'/,
  );
});

test('slugify and shell quoting', () => {
  assert.equal(slugifyNodeId('Edge SFU 01'), 'edge-sfu-01');
  assert.equal(slugifyNodeId('  --Edge__SFU--  '), 'edge__sfu');
  assert.equal(slugifyNodeId('Узел'), '');
  assert.equal(slugifyNodeId('a'.repeat(100)).length, 64);
  assert.equal(shellQuote('a b'), "'a b'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test('standby Core join command stays exact', () => {
  assert.equal(
    buildCoreJoinCommand({ token: 'agil_enr_core', serverUrl: 'http://127.0.0.1:8787/' }),
    "curl -X POST 'http://127.0.0.1:8787/v1/cluster/join' \\\n" +
      "  -H 'content-type: application/json' \\\n" +
      `  -d '{"token":"agil_enr_core","nodeId":"standby-1"}'`,
  );
});

test('configured capacity is displayed separately from live load', () => {
  assert.equal(formatConfiguredCapacity({ maxRooms: 5, maxParticipants: 300, bandwidthMbps: 500 }), 'комнат: 5 · участников: 300 · канал: 500 Мбит/с');
  assert.equal(formatConfiguredCapacity({ maxRooms: 0, maxParticipants: 0, bandwidthMbps: 0 }), 'не задана');
  assert.equal(formatConfiguredCapacity(null), NO_NODE_DATA);
});

/* ------------------------------------------------------------------ */
/* Per-node modules («Модули» panel, docs/api/cluster.md §10)         */
/* ------------------------------------------------------------------ */

const moduleFixture = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'egress',
  kind: 'egress',
  name: 'Egress streaming worker',
  version: '0.1.0',
  image: 'agil/node-egress:0.1.0',
  status: 'running',
  health: 'healthy',
  ports: [],
  updatedAt: 1_700_000_000_000,
  ...overrides,
});

const catalogEntryFixture = (id: NodeModuleAction | string, actions: NodeModuleAction[]): NodeModuleCatalogEntry =>
  ({
    id,
    kind: id,
    name: `Module ${id}`,
    description: '',
    image: `agil/node-${id}:0.1.0`,
    repository: `agil/node-${id}`,
    ports: [],
    env: [],
    actions,
  }) as unknown as NodeModuleCatalogEntry;

test('never-reported node.modules stays "not reported" and is not an empty inventory', () => {
  for (const source of [undefined, null, {}, { modules: null }, { modules: undefined }]) {
    const view = readNodeModules(source);
    assert.equal(view.reported, false);
    assert.equal(view.total, 0);
    assert.equal(view.running, 0);
    assert.deepEqual(view.modules, []);
    assert.equal(moduleSummaryLabel(view), 'модули не сообщены');
  }
  // `[]` honestly means "reported: no add-ons installed" — different state.
  const empty = readNodeModules({ modules: [] });
  assert.equal(empty.reported, true);
  assert.equal(empty.total, 0);
  assert.equal(moduleSummaryLabel(empty), 'модули не установлены');
  // Garbage in the field is not an inventory either.
  assert.equal(readNodeModules({ modules: 'nope' as unknown as [] }).reported, false);
});

test('module inventory is read defensively: counts, dedupe, invalid entries dropped', () => {
  const view = readNodeModules({
    modules: [
      moduleFixture({ id: 'egress', updatedAt: 100 }),
      moduleFixture({ id: 'stt', status: 'error', health: 'degraded', updatedAt: 200 }),
      moduleFixture({ id: 'recorder', status: 'installing', health: 'unhealthy', ports: [8090, 70_000, 0], updatedAt: 'bad' }),
      moduleFixture({ id: 'turn', status: 'stopped', ports: [3478, 5349], updatedAt: 300 }),
      moduleFixture({ id: 'sip', status: 'unknown', health: 'unknown', updatedAt: 50 }),
      moduleFixture({ id: 'gpu', kind: 'compute', image: 'example/gpu:1', updatedAt: 180 }),
      // Invalid id / kind / status / missing image are dropped.
      moduleFixture({ id: 'bad id' }),
      moduleFixture({ id: 'earnings', kind: 'bad kind' }),
      moduleFixture({ status: 'paused' }),
      moduleFixture({ image: '' }),
      // Duplicate ids keep the last report.
      moduleFixture({ id: 'stt', status: 'stopped', updatedAt: 400 }),
    ],
  });
  assert.equal(view.reported, true);
  assert.equal(view.total, 6);
  assert.deepEqual(
    view.modules.map((module) => module.id),
    ['egress', 'stt', 'recorder', 'turn', 'sip', 'gpu'],
  );
  assert.equal(view.running, 2);
  assert.equal(view.modules.find((module) => module.id === 'gpu')?.kind, 'compute');
  assert.equal(view.installing, 1);
  assert.equal(view.errors, 0);
  assert.equal(view.unhealthy, 1);
  assert.equal(view.lastUpdatedAt, 400);
  const stt = view.modules.find((module) => module.id === 'stt');
  assert.equal(stt?.status, 'stopped');
  const recorder = view.modules.find((module) => module.id === 'recorder');
  assert.deepEqual(recorder?.ports, [8090]);
  assert.equal(recorder?.updatedAt, null);
  assert.equal(view.modules.find((module) => module.id === 'sip')?.health, 'unknown');
});

test('module summary running count and reported-field labels', () => {
  const view = readNodeModules({
    modules: [moduleFixture({ id: 'egress' }), moduleFixture({ id: 'stt', status: 'stopped' })],
  });
  assert.equal(moduleSummaryLabel(view), '1 из 2 запущено');
  assert.equal(moduleVersionLabel(''), 'не указана');
  assert.equal(moduleVersionLabel(' 1.2.3 '), '1.2.3');
  assert.equal(modulePortsLabel([8090, 8091]), '8090, 8091');
  assert.equal(modulePortsLabel([]), 'не опубликованы');
  assert.equal(modulePortsLabel([0, 70_000]), 'не опубликованы');
  const now = 1_700_000_000_000;
  assert.equal(moduleUpdatedAtLabel(now - 120_000, now), '2 мин назад');
  assert.equal(moduleUpdatedAtLabel(null), 'время обновления не сообщено');
});

test('module status/health labels and tones are explicit', () => {
  assert.equal(MODULE_STATUS_META.running.tone, 'success');
  assert.equal(MODULE_STATUS_META.error.tone, 'danger');
  assert.equal(MODULE_STATUS_META.installing.tone, 'info');
  assert.equal(MODULE_STATUS_META.stopped.tone, 'neutral');
  assert.equal(MODULE_HEALTH_META.degraded.tone, 'warning');
  assert.equal(MODULE_HEALTH_META.unhealthy.tone, 'danger');
  assert.equal(MODULE_HEALTH_META.unknown.tone, 'neutral');
});

test('module actions follow catalog + reported status and are blocked by pending commands', () => {
  const all: NodeModuleAction[] = ['start', 'stop', 'restart', 'install', 'remove'];
  // Not installed → install only.
  assert.deepEqual(moduleActionsFor({ status: null, catalogActions: all }), ['install']);
  assert.deepEqual(moduleActionsFor({ status: null, catalogActions: ['start'] }), []);
  // Running → stop + restart + remove (no start).
  assert.deepEqual(moduleActionsFor({ status: 'running', catalogActions: all }), ['stop', 'restart', 'remove']);
  // Stopped/error/unknown → start + restart + remove.
  assert.deepEqual(moduleActionsFor({ status: 'stopped', catalogActions: all }), ['start', 'restart', 'remove']);
  assert.deepEqual(moduleActionsFor({ status: 'error', catalogActions: all }), ['start', 'restart', 'remove']);
  assert.deepEqual(moduleActionsFor({ status: 'unknown', catalogActions: all }), ['start', 'restart', 'remove']);
  // Installing → remove only (no second start/stop/restart while it is in flight).
  assert.deepEqual(moduleActionsFor({ status: 'installing', catalogActions: all }), ['remove']);
  // Catalog restricts the set; unknown runtime values are ignored.
  assert.deepEqual(moduleActionsFor({ status: 'running', catalogActions: ['start', 'stop'] }), ['stop']);
  // Any queued command blocks new actions (the Core rejects duplicates anyway).
  assert.deepEqual(
    moduleActionsFor({ status: 'running', catalogActions: all, pendingActions: ['restart'] }),
    [],
  );
  assert.equal(isDestructiveModuleAction('remove'), true);
  assert.equal(isDestructiveModuleAction('restart'), false);
  assert.equal(moduleActionLabel('restart'), 'Перезапустить');
});

test('pending commands are matched per module and labelled', () => {
  const commands = [
    { moduleId: 'egress', action: 'install' },
    { moduleId: 'stt', action: 'start' },
    { moduleId: 'egress', action: 'install' },
    { moduleId: 'egress', action: 'bogus' },
  ];
  assert.deepEqual(modulePendingActions(commands, 'egress'), ['install']);
  assert.deepEqual(modulePendingActions(commands, 'stt'), ['start']);
  assert.deepEqual(modulePendingActions(commands, 'turn'), []);
  assert.deepEqual(modulePendingActions(undefined, 'egress'), []);
  assert.equal(modulePendingLabel(['install', 'restart']), 'в очереди: установка, перезапуск');
  assert.equal(modulePendingLabel([]), '');
});

test('env hints expose names only — values and secrets never reach the UI model', () => {
  const hints = moduleEnvHints({
    env: [
      {
        name: 'AGIL_EGRESS_TOKEN',
        required: true,
        secret: true,
        description: 'Join credential',
        value: 'super-secret-value',
      },
      { name: 'lowercase-invalid', value: 'x' },
      { name: 'AGIL_EGRESS_CORE_URL', description: ' Core URL ' },
    ],
  });
  assert.deepEqual(hints, [
    { name: 'AGIL_EGRESS_TOKEN', required: true, secret: true, description: 'Join credential' },
    { name: 'AGIL_EGRESS_CORE_URL', required: false, secret: false, description: 'Core URL' },
  ]);
  assert.equal(JSON.stringify(hints).includes('super-secret-value'), false);
  assert.equal(moduleEnvHints(undefined).length, 0);
});

test('catalog lookup separates installed from installable modules', () => {
  const catalog = [
    catalogEntryFixture('egress', ['start', 'stop', 'restart', 'install', 'remove']),
    catalogEntryFixture('stt', ['start', 'stop', 'restart', 'install', 'remove']),
    catalogEntryFixture('turn', ['start', 'stop', 'restart', 'install', 'remove']),
    catalogEntryFixture('recorder', ['start', 'stop', 'remove']),
  ];
  assert.equal(moduleCatalogEntry(catalog, 'stt')?.id, 'stt');
  assert.equal(moduleCatalogEntry(catalog, 'recorder')?.id, 'recorder');
  assert.equal(moduleCatalogEntry(catalog, 'gpu'), null);
  assert.deepEqual(
    availableCatalogEntries(catalog, ['egress', 'stt']).map((entry) => entry.id),
    ['turn'],
  );
  assert.deepEqual(availableCatalogEntries(catalog, []).length, 3);
});
