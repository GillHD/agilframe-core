/**
 * Per-node modules (Docker add-on packages) — Core side.
 *
 * Covers the documented contract (docs/api/cluster.md §10):
 * - admin allowlist catalog (tenant admin only, no secrets);
 * - queueing allowlisted actions (never a dashboard image), duplicate/queue-cap
 *   rejection, tenant scoping and standby (`409 not_leader`) gating;
 * - heartbeat delivery exactly once, ack handling, TTL expiry, offline beats;
 * - module snapshot sanitization (catalog image guard and custom inventory),
 *   `NodeSummary.modules` presence semantics and restart persistence;
 * - audit + no secret leakage.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  NODE_MODULE_COMMAND_TTL_MS,
  NODE_OFFLINE_AFTER_SEC,
  nodeModuleActions,
} from '@agil/protocol';
import { startTestServer, type TestServer } from './helpers.js';
import { storedModuleCommands } from '../src/node-modules.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const ACME = { 'x-api-key': 'acme-key' };
const PLATFORM = { 'x-api-key': 'platform-test-key' };
const EGRESS_IMAGE = 'agil/node-egress:0.1.0';
const TURN_IMAGE = 'coturn/coturn:4.6';

let ts: TestServer;

before(async () => {
  ts = await startTestServer({ platformKey: 'platform-test-key' });
});

after(async () => {
  await ts.close();
});

interface RegisteredNode {
  nodeKey: string;
  node: any;
}

/** Mints a one-time node token and registers a node on `server`. */
async function createNode(
  nodeId: string,
  extra: Record<string, unknown> = {},
  server: TestServer = ts,
): Promise<RegisteredNode> {
  const token = await server.api('POST', '/v1/admin/cluster/tokens', {
    headers: ADMIN,
    body: { kind: 'node', role: 'sfu' },
  });
  assert.equal(token.status, 201, token.text);
  const registration = await server.api('POST', '/v1/nodes/register', {
    body: { token: token.body.token, role: 'sfu', nodeId, ...extra },
  });
  assert.equal(registration.status, 201, registration.text);
  return { nodeKey: registration.body.nodeKey as string, node: registration.body.node };
}

function heartbeat(
  nodeId: string,
  key: string,
  body: Record<string, unknown> = {},
  server: TestServer = ts,
) {
  return server.api('POST', `/v1/nodes/${encodeURIComponent(nodeId)}/heartbeat`, {
    headers: { 'x-node-token': key },
    body,
  });
}

function queueAction(
  nodeId: string,
  moduleId: string,
  body: Record<string, unknown>,
  server: TestServer = ts,
) {
  return server.api('POST', `/v1/admin/nodes/${encodeURIComponent(nodeId)}/modules/${encodeURIComponent(moduleId)}/actions`, {
    headers: ADMIN,
    body,
  });
}

function report(overrides: Record<string, unknown> = {}) {
  return { id: 'egress', image: EGRESS_IMAGE, status: 'running', ...overrides };
}

function adminNode(server: TestServer, nodeId: string): any {
  return server.api('GET', '/v1/admin/nodes', { headers: ADMIN }).then((response) => {
    assert.equal(response.status, 200, response.text);
    return response.body.nodes.find((node: { id: string }) => node.id === nodeId);
  });
}

test('available modules reflect fresh inventory and confirmed lifecycle without replacing configured features', async () => {
  const nodeId = 'mod-available';
  const { nodeKey, node } = await createNode(nodeId, { features: ['sfu', 'egress'] });
  assert.deepEqual(node.availableModules, []);

  const running = report({ health: 'healthy' });
  const relay = { id: 'turn', image: TURN_IMAGE, status: 'running', health: 'unhealthy' };
  const inventory = [running, relay, report({ id: 'stt', image: 'agil/node-stt:0.1.0', status: 'running', health: 'degraded' })];
  const ready = await heartbeat(nodeId, nodeKey, { modules: inventory });
  assert.equal(ready.status, 200, ready.text);
  assert.deepEqual(ready.body.node.availableModules, ['egress']);
  assert.equal(ts.server.cluster.turnNodeState('demo', nodeId), 'turn_unhealthy');

  const stop = await queueAction(nodeId, 'egress', { action: 'stop' });
  assert.equal(stop.status, 201, stop.text);
  const delivered = await heartbeat(nodeId, nodeKey, { modules: inventory });
  assert.deepEqual(delivered.body.node.availableModules, ['egress']);
  assert.equal(delivered.body.moduleCommands[0]?.id, stop.body.command.id);
  const stopped = await heartbeat(nodeId, nodeKey, {
    moduleResults: [{ commandId: stop.body.command.id, status: 'stopped', ok: true }],
  });
  assert.deepEqual(stopped.body.node.availableModules, []);
  assert.deepEqual(stopped.body.node.features, ['sfu', 'egress']);

  const healthyRelay = { ...relay, health: 'healthy' };
  const restored = await heartbeat(nodeId, nodeKey, { modules: [healthyRelay] });
  assert.deepEqual(restored.body.node.availableModules, ['turn']);
  assert.equal(ts.server.cluster.turnNodeState('demo', nodeId), 'ready');
  const drain = await ts.api('POST', `/v1/admin/nodes/${nodeId}/drain`, { headers: ADMIN, body: { drain: true } });
  assert.equal(drain.status, 200, drain.text);
  assert.deepEqual((await adminNode(ts, nodeId)).availableModules, []);
  assert.equal(ts.server.cluster.turnNodeState('demo', nodeId), 'node_draining');
  const undrain = await ts.api('POST', `/v1/admin/nodes/${nodeId}/drain`, { headers: ADMIN, body: { drain: false } });
  assert.equal(undrain.status, 200, undrain.text);
  assert.deepEqual((await adminNode(ts, nodeId)).availableModules, ['turn']);

  for (const moduleAvailability of ['unavailable', 'disabled']) {
    const blocked = await heartbeat(nodeId, nodeKey, { moduleAvailability });
    assert.deepEqual(blocked.body.node.availableModules, []);
    assert.equal(blocked.body.node.modules[0].id, 'turn');
    assert.deepEqual((await heartbeat(nodeId, nodeKey)).body.node.availableModules, []);
    assert.deepEqual((await heartbeat(nodeId, nodeKey, { modules: [healthyRelay] })).body.node.availableModules, ['turn']);
  }

  const futureHeartbeat = ts.server.cluster.heartbeat({
    nodeId, rawKey: nodeKey, body: {}, now: Date.now() + NODE_OFFLINE_AFTER_SEC * 1000 + 1,
  });
  assert.equal(futureHeartbeat.node.status, 'online');
  assert.deepEqual(futureHeartbeat.node.availableModules, []);
  assert.equal(futureHeartbeat.node.modules?.[0]?.id, 'turn');
});

test('a restart acknowledgement cannot reuse the previous TURN health report', async () => {
  const nodeId = 'mod-restart-readiness';
  const { nodeKey } = await createNode(nodeId);
  const turn = { id: 'turn', image: TURN_IMAGE, status: 'running', health: 'healthy' };
  const egress = report({ health: 'healthy' });
  assert.deepEqual((await heartbeat(nodeId, nodeKey, { modules: [turn, egress] })).body.node.availableModules, ['egress', 'turn']);
  const queued = await queueAction(nodeId, 'turn', { action: 'restart' });
  assert.equal(queued.status, 201, queued.text);
  assert.deepEqual((await heartbeat(nodeId, nodeKey)).body.moduleCommands, [queued.body.command]);

  const acknowledged = await heartbeat(nodeId, nodeKey, {
    moduleResults: [{ commandId: queued.body.command.id, ok: true, status: 'running' }],
  });
  assert.equal(acknowledged.status, 200, acknowledged.text);
  assert.deepEqual(acknowledged.body.node.availableModules, ['egress']);
  assert.equal(ts.server.cluster.turnNodeState('demo', nodeId), 'turn_unhealthy');
  assert.deepEqual((await heartbeat(nodeId, nodeKey)).body.node.availableModules, ['egress']);
  assert.deepEqual((await heartbeat(nodeId, nodeKey, { modules: [{ ...turn, health: 'degraded' }, egress] })).body.node.availableModules, ['egress']);
  assert.deepEqual((await heartbeat(nodeId, nodeKey, { modules: [turn, egress] })).body.node.availableModules, ['egress', 'turn']);
  assert.equal(ts.server.cluster.turnNodeState('demo', nodeId), 'ready');
});

test('disabling one Docker module persists, cancels its queued commands and waits for fresh inventory when enabled', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'agil-module-policy-'));
  let core = await startTestServer({ dataDir });
  const nodeId = 'mod-policy';
  const nodePath = `/v1/admin/nodes/${nodeId}`;
  const turn = { id: 'turn', image: TURN_IMAGE, status: 'running', health: 'healthy' };
  const inventory = [turn, report({ health: 'healthy' })];
  try {
    const { nodeKey } = await createNode(nodeId, {}, core);
    const beat = (body: Record<string, unknown> = {}) => heartbeat(nodeId, nodeKey, body, core);
    const patch = (moduleEnabled: Record<string, boolean>, headers = ADMIN) => core.api('PATCH', nodePath, { headers, body: { moduleEnabled } });
    const ready = await beat({ modules: inventory });
    assert.deepEqual(ready.body.node.availableModules, ['egress', 'turn']);
    const delivered = (await queueAction(nodeId, 'egress', { action: 'start' }, core)).body.command;
    assert.deepEqual((await beat()).body.moduleCommands, [delivered]);
    const waiting = await queueAction(nodeId, 'turn', { action: 'restart' }, core);
    assert.equal(waiting.status, 201, waiting.text);
    assert.equal((await patch({ turn: false }, ACME)).status, 404);
    assert.equal((await patch({ unknown: false })).status, 400);
    const disabled = await patch({ turn: false });
    assert.equal(disabled.status, 200, disabled.text);
    assert.deepEqual(disabled.body.node.disabledModules, ['turn']);
    assert.deepEqual(disabled.body.node.availableModules, ['egress']);
    assert.equal(core.server.cluster.turnNodeState('demo', nodeId), 'module_disabled');
    const blocked = await queueAction(nodeId, 'turn', { action: 'restart' }, core);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'module_disabled');
    const ack = await beat({ modules: inventory, moduleResults: [{ commandId: delivered.id, status: 'running', ok: true }] });
    assert.deepEqual(ack.body.moduleCommands, []);
    assert.deepEqual(ack.body.node.availableModules, ['egress']);
    const audit = await core.api('GET', `/v1/admin/audit?type=admin.action&q=${nodeId}`, { headers: ADMIN });
    const change = audit.body.entries.find(({ details }: { details: { kind: string } }) => details.kind === 'cluster.node.updated');
    assert.deepEqual(change.details.disabledModulesBefore, []);
    assert.deepEqual(change.details.disabledModulesAfter, ['turn']);

    await core.close();
    core = await startTestServer({ dataDir });
    assert.deepEqual((await beat({ modules: inventory })).body.node.disabledModules, ['turn']);
    const restored = await patch({ turn: true });
    assert.equal(restored.status, 200, restored.text);
    assert.deepEqual(restored.body.node.availableModules, ['egress']);
    assert.deepEqual((await beat()).body.moduleCommands, []);
    assert.deepEqual((await beat({ modules: inventory })).body.node.availableModules, ['egress', 'turn']);
    assert.equal(core.server.cluster.turnNodeState('demo', nodeId), 'ready');
  } finally {
    await core.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

test('catalog: tenant-admin only, allowlisted ids/images/ports/env hints, no secret values', async () => {
  const anonymous = await ts.api('GET', '/v1/admin/node-modules/catalog');
  assert.equal(anonymous.status, 401);
  assert.equal((await ts.api('GET', '/v1/admin/node-modules/catalog', { headers: PLATFORM })).status, 403);

  const response = await ts.api('GET', '/v1/admin/node-modules/catalog', { headers: ADMIN });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.body.actions, [...nodeModuleActions]);
  const catalog = response.body.catalog as Array<Record<string, any>>;
  assert.deepEqual(
    catalog.map((entry) => entry.id),
    ['egress', 'stt', 'recorder', 'turn', 'sip', 'ingress', 'sfu'],
  );
  const previousSttToken = catalog.find((entry) => entry.id === 'stt')?.env.find(
    (hint: { name: string }) => hint.name === 'AGIL_STT_PREVIOUS_TOKEN',
  );
  assert.equal(previousSttToken?.required, false);
  assert.equal(previousSttToken?.secret, true);
  for (const entry of catalog) {
    assert.equal(entry.kind, entry.id);
    assert.equal(entry.repository, entry.image.replace(/:[^/:]+$/, ''));
    const expectedActions = entry.id === 'sfu' ? ['start', 'stop', 'restart'] : entry.id === 'ingress'
      ? ['start', 'stop', 'restart']
      : nodeModuleActions.filter((action) => !['recorder', 'egress', 'sip'].includes(entry.id) || action !== 'install');
    assert.deepEqual(entry.actions, expectedActions);
    assert.ok(Array.isArray(entry.ports) && Array.isArray(entry.env));
    for (const port of entry.ports) assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535);
    for (const hint of entry.env) {
      // Hints are metadata only: a variable name, flags and a description.
      assert.deepEqual(Object.keys(hint).sort(), ['description', 'name', 'required', 'secret']);
      assert.match(hint.name, /^[A-Z][A-Z0-9_]*$/);
      assert.equal(typeof hint.required, 'boolean');
      assert.equal(typeof hint.secret, 'boolean');
      assert.ok(!('value' in hint));
    }
  }
  // The catalog never echoes node credentials; it is static allowlist metadata.
  assert.ok(!response.text.includes('nk_'));
  assert.ok(!response.text.includes('keyHash'));
});

/* ------------------------------------------------------------------ */
/* Queueing commands                                                   */
/* ------------------------------------------------------------------ */

test('Recorder is manageable for existing containers but cannot be newly installed', async () => {
  const nodeId = 'mod-legacy-recorder';
  const { nodeKey } = await createNode(nodeId);
  const image = 'agil/node-recorder:0.1.0';
  const install = await queueAction(nodeId, 'recorder', { action: 'install' });
  assert.equal(install.status, 400, install.text);
  const report = await heartbeat(nodeId, nodeKey, { modules: [{ id: 'recorder', image, status: 'running' }] });
  assert.equal(report.body.node.modules[0].id, 'recorder');
  const stop = await queueAction(nodeId, 'recorder', { action: 'stop' });
  assert.equal(stop.status, 201, stop.text);
  assert.deepEqual((await heartbeat(nodeId, nodeKey)).body.moduleCommands, [stop.body.command]);

  const createdAt = Date.now();
  const oldInstall = { id: 'nmc_0000000000000001', moduleId: 'recorder', action: 'install', image,
    createdAt, expiresAt: createdAt + NODE_MODULE_COMMAND_TTL_MS };
  assert.deepEqual(storedModuleCommands([{ ...oldInstall, deliveredAt: null }], createdAt), []);
  assert.equal(storedModuleCommands([{ ...oldInstall, deliveredAt: createdAt }], createdAt).length, 1);
});

test('queue: 201 with a server-shaped command; install image comes only from the catalog', async () => {
  await createNode('mod-queue');
  const start = await queueAction('mod-queue', 'egress', { action: 'start' });
  assert.equal(start.status, 201, start.text);
  const command = start.body.command;
  assert.match(command.id, /^nmc_[0-9a-f]{16}$/);
  assert.equal(command.moduleId, 'egress');
  assert.equal(command.action, 'start');
  assert.equal(command.image, undefined, 'non-install commands carry no image');
  assert.equal(command.deliveredAt, undefined, 'the internal delivery marker is never exposed');
  assert.ok(Number.isInteger(command.createdAt));
  assert.equal(command.expiresAt, command.createdAt + NODE_MODULE_COMMAND_TTL_MS);

  // A dashboard-supplied image is impossible by contract: the field is stripped.
  const install = await queueAction('mod-queue', 'stt', {
    action: 'install',
    image: 'evil/backdoor:1',
    command: 'rm -rf /',
  });
  assert.equal(install.status, 201, install.text);
  assert.equal(install.body.command.action, 'install');
  assert.equal(install.body.command.image, 'agil/node-stt:0.1.0');

  // Unknown module id is a 404; unknown/missing action is a 400.
  const unknownModule = await queueAction('mod-queue', 'gpu', { action: 'start' });
  assert.equal(unknownModule.status, 404);
  assert.equal(unknownModule.body.error.code, 'not_found');
  const unknownAction = await queueAction('mod-queue', 'egress', { action: 'upgrade' });
  assert.equal(unknownAction.status, 400);
  assert.equal(unknownAction.body.error.code, 'validation_failed');
  assert.equal((await queueAction('mod-queue', 'egress', {})).status, 400);

  const modules = await ts.api('GET', '/v1/admin/nodes/mod-queue/modules', { headers: ADMIN });
  assert.equal(modules.status, 200, modules.text);
  assert.deepEqual(modules.body.modules, [], 'a registered node has not reported modules yet');
  assert.deepEqual(
    modules.body.pendingCommands.map((pending: { action: string; moduleId: string }) => `${pending.moduleId}:${pending.action}`).sort(),
    ['egress:start', 'stt:install'],
  );

  // The queued command is audited as an admin action, without secrets.
  const audit = await ts.api('GET', '/v1/admin/audit?limit=200', { headers: ADMIN });
  const queued = audit.body.entries.find(
    (entry: { details?: { kind?: string; commandId?: string } }) =>
      entry.details?.kind === 'cluster.node.module.command' && entry.details.commandId === command.id,
  );
  assert.ok(queued, 'module command audit entry is present');
  assert.equal(queued.details.action, 'start');
});

test('queue: duplicate pending action 409 and tenant/platform scoping', async () => {
  await createNode('mod-full');
  assert.equal((await queueAction('mod-full', 'egress', { action: 'start' })).status, 201);
  const duplicate = await queueAction('mod-full', 'egress', { action: 'start' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'module_command_pending');
  assert.match(duplicate.body.error.message, /already queued/i);

  // Tenant scoping: another tenant sees neither the node nor its commands.
  await createNode('mod-scope');
  const foreignAction = await ts.api(
    'POST',
    '/v1/admin/nodes/mod-scope/modules/egress/actions',
    { headers: ACME, body: { action: 'start' } },
  );
  assert.equal(foreignAction.status, 404, 'a foreign-tenant node is not found');
  assert.equal((await ts.api('GET', '/v1/admin/nodes/mod-scope/modules', { headers: ACME })).status, 404);
  const unknownNode = await ts.api('GET', '/v1/admin/nodes/does-not-exist/modules', { headers: ADMIN });
  assert.equal(unknownNode.status, 404);
  // Platform key is rejected on the module surface like on every tenant admin path.
  assert.equal(
    (await ts.api('GET', '/v1/admin/nodes/mod-scope/modules', { headers: PLATFORM })).status,
    403,
  );
  assert.equal(
    (await ts.api('POST', '/v1/admin/nodes/mod-scope/modules/egress/actions', {
      headers: PLATFORM,
      body: { action: 'start' },
    })).status,
    403,
  );
});

test('concurrent lifecycle requests wait for the active module command', async () => {
  const nodeId = 'mod-conflict';
  const { nodeKey } = await createNode(nodeId);
  const responses = await Promise.all([
    queueAction(nodeId, 'egress', { action: 'start' }),
    queueAction(nodeId, 'egress', { action: 'stop' }),
  ]);
  assert.deepEqual(responses.map(({ status }) => status).sort(), [201, 409]);
  const accepted = responses.find(({ status }) => status === 201)!.body.command;
  assert.equal(responses.find(({ status }) => status === 409)!.body.error.details.commandId, accepted.id);

  const other = await queueAction(nodeId, 'stt', { action: 'start' });
  assert.equal(other.status, 201, other.text);
  const delivered = await heartbeat(nodeId, nodeKey, {});
  assert.deepEqual(delivered.body.moduleCommands, [accepted, other.body.command]);
  const inFlight = await queueAction(nodeId, 'egress', { action: 'restart' });
  assert.equal(inFlight.status, 409);
  assert.equal(inFlight.body.error.details.commandId, accepted.id);

  const ack = await heartbeat(nodeId, nodeKey, {
    moduleResults: [{ commandId: accepted.id, ok: true, status: accepted.action === 'start' ? 'running' : 'stopped' }],
  });
  assert.equal(ack.status, 200, ack.text);
  assert.equal((await queueAction(nodeId, 'egress', { action: 'restart' })).status, 201);
});

/* ------------------------------------------------------------------ */
/* Delivery / acknowledgement                                          */
/* ------------------------------------------------------------------ */

test('auto-start requires node support, serializes actions and reflects only reported policy', async () => {
  const nodeId = 'module-autostart';
  const { nodeKey } = await createNode(nodeId);
  const queue = (action: string) => queueAction(nodeId, 'egress', { action });
  const beat = (modules: ReturnType<typeof report>[]) => heartbeat(nodeId, nodeKey, { modules });
  assert.equal((await queue('disable-autostart')).body.error.code, 'module_autostart_unavailable');
  assert.equal((await beat([report({ autoStart: true })])).status, 200);
  const queued = await queue('disable-autostart');
  assert.equal(queued.status, 201, queued.text);
  assert.equal((await queue('enable-autostart')).body.error.code, 'module_command_pending');
  assert.equal((await queue('restart')).body.error.code, 'module_command_pending');
  assert.deepEqual((await beat([report()])).body.moduleCommands, [], 'legacy agents do not receive the command');
  const delivered = await beat([report({ autoStart: true })]);
  assert.deepEqual(delivered.body.moduleCommands, [queued.body.command]);
  assert.equal(delivered.body.node.modules[0].autoStart, true);
  const ack = await heartbeat(nodeId, nodeKey, {
    modules: [report({ autoStart: false })],
    moduleResults: [{ commandId: queued.body.command.id, ok: true, status: 'running' }],
  });
  assert.equal(ack.body.node.modules[0].autoStart, false);
  assert.equal(ack.body.node.modules[0].status, 'running');
  assert.equal((await adminNode(ts, nodeId)).modules[0].autoStart, false);
  assert.equal((await queue('enable-autostart')).status, 201);
});

test('heartbeat delivers a command exactly once and an ack updates the reported module state', async () => {
  const { nodeKey } = await createNode('mod-deliver');
  const startedAt = Date.now();

  // First report: the inventory snapshot is stored and returned on the node.
  const snapshot = await heartbeat('mod-deliver', nodeKey, {
    modules: [report({ health: 'healthy', version: '0.1.0', ports: [] })],
  });
  assert.equal(snapshot.status, 200, snapshot.text);
  assert.deepEqual(snapshot.body.moduleCommands, [], 'nothing is queued yet');
  assert.equal(snapshot.body.node.modules.length, 1);
  assert.equal(snapshot.body.node.modules[0].status, 'running');
  const reportedAt = snapshot.body.node.modules[0].updatedAt;
  assert.ok(reportedAt >= startedAt && reportedAt <= Date.now());

  const queued = await queueAction('mod-deliver', 'egress', { action: 'stop' });
  assert.equal(queued.status, 201, queued.text);
  const commandId = queued.body.command.id as string;

  // Delivered once: the next heartbeat gets it, the one after gets nothing.
  const delivered = await heartbeat('mod-deliver', nodeKey);
  assert.equal(delivered.status, 200, delivered.text);
  assert.equal(delivered.body.moduleCommands.length, 1);
  assert.equal(delivered.body.moduleCommands[0].id, commandId);
  assert.deepEqual(delivered.body.moduleCommands[0], queued.body.command);
  assert.equal(delivered.body.node.modules[0].status, 'running', 'no optimistic/fake status change');
  const modulePath = '/v1/admin/nodes/mod-deliver/modules';
  const waiting = await ts.api('GET', modulePath, { headers: ADMIN });
  assert.deepEqual(waiting.body.pendingCommands, []);
  assert.deepEqual(waiting.body.inFlightCommands, [queued.body.command]);
  assert.equal(waiting.body.modules[0].status, 'running');
  const duplicate = await queueAction('mod-deliver', 'egress', { action: 'stop' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'module_command_pending');
  assert.match(duplicate.body.error.message, /awaiting a result/);

  const repeat = await heartbeat('mod-deliver', nodeKey);
  assert.equal(repeat.status, 200, repeat.text);
  assert.deepEqual(repeat.body.moduleCommands, [], 'a delivered command is not repeated');

  // Ack (plus an unknown command id that must be ignored): status + error mirror
  // what the node reported, and the ack is audited without the node error text.
  const acked = await heartbeat('mod-deliver', nodeKey, {
    moduleResults: [
      { commandId, ok: true, status: 'stopped' },
      { commandId: 'nmc_ffffffffffffffff', ok: false, status: 'error', error: 'unknown command' },
    ],
  });
  assert.equal(acked.status, 200, acked.text);
  assert.equal(acked.body.node.modules[0].status, 'stopped');
  assert.equal(acked.body.node.modules[0].lastError, undefined);

  const modules = await ts.api('GET', modulePath, { headers: ADMIN });
  assert.deepEqual(modules.body.modules[0].status, 'stopped');
  assert.deepEqual(modules.body.pendingCommands, []);
  assert.deepEqual(modules.body.inFlightCommands, []);

  const audit = await ts.api('GET', '/v1/admin/audit?limit=200', { headers: ADMIN });
  const resultEntry = audit.body.entries.find(
    (entry: { details?: { kind?: string; commandId?: string } }) =>
      entry.details?.kind === 'cluster.node.module.result' && entry.details.commandId === commandId,
  );
  assert.ok(resultEntry, 'the acknowledgement is audited');
  assert.equal(resultEntry.details.ok, true);
  assert.equal(resultEntry.details.status, 'stopped');
  assert.ok(!audit.text.includes('unknown command'), 'node error text is not copied into the audit log');
  assert.ok(!audit.text.includes(nodeKey), 'the node key never reaches the audit log');
});

/* ------------------------------------------------------------------ */
/* Module snapshot sanitization                                        */
/* ------------------------------------------------------------------ */

test('module availability prevents actions and holds queued work until Docker recovers', async () => {
  const nodeId = 'mod-docker-availability';
  const { nodeKey } = await createNode(nodeId);
  const modulePath = `/v1/admin/nodes/${nodeId}/modules`;
  const snapshot = await heartbeat(nodeId, nodeKey, { moduleAvailability: 'available', modules: [report()] });
  assert.equal(snapshot.body.node.moduleAvailability, 'available');
  const queued = await queueAction(nodeId, 'egress', { action: 'stop' });
  assert.equal(queued.status, 201);

  for (const availability of ['unavailable', 'disabled'] as const) {
    const beat = await heartbeat(nodeId, nodeKey, { moduleAvailability: availability });
    assert.equal(beat.status, 200);
    assert.equal(beat.body.node.moduleAvailability, availability);
    assert.deepEqual(beat.body.moduleCommands, []);
    const inventory = await ts.api('GET', modulePath, { headers: ADMIN });
    assert.equal(inventory.body.moduleAvailability, availability);
    assert.equal(inventory.body.modules[0].status, 'running', 'last known inventory is kept');
    assert.deepEqual(inventory.body.pendingCommands, [queued.body.command]);
    const keepBlocked = await heartbeat(nodeId, nodeKey);
    assert.equal(keepBlocked.body.node.moduleAvailability, availability);
    assert.deepEqual(keepBlocked.body.moduleCommands, []);
    const blocked = await queueAction(nodeId, 'turn', { action: 'install' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'node_modules_unavailable');
  }
  const recovered = await heartbeat(nodeId, nodeKey, { moduleAvailability: 'available', modules: [report()] });
  assert.deepEqual(recovered.body.moduleCommands, [queued.body.command]);
  const legacy = await heartbeat(nodeId, nodeKey, {});
  assert.equal(legacy.body.node.moduleAvailability, undefined, 'old online agents may still omit availability');
});

test('an administratively disabled node cannot queue module actions or offer media capabilities', async () => {
  const nodeId = 'mod-node-disabled';
  const { nodeKey } = await createNode(nodeId, { features: ['egress', 'turn'] });
  const nodePath = `/v1/admin/nodes/${nodeId}`;
  const modules = [report(), { id: 'turn', image: TURN_IMAGE, status: 'running', health: 'healthy' }];
  const ready = await heartbeat(nodeId, nodeKey, { modules });
  assert.deepEqual(ready.body.node.availableModules, ['egress', 'turn']);

  const sent = await queueAction(nodeId, 'egress', { action: 'restart' });
  assert.equal(sent.status, 201, sent.text);
  assert.deepEqual((await heartbeat(nodeId, nodeKey, { modules })).body.moduleCommands, [sent.body.command]);
  const pending = await queueAction(nodeId, 'turn', { action: 'remove' });
  assert.equal(pending.status, 201, pending.text);

  const disabled = await ts.api('POST', `${nodePath}/disable`, { headers: ADMIN, body: { disabled: true } });
  assert.equal(disabled.status, 200, disabled.text);
  assert.deepEqual(disabled.body.node.availableModules, []);
  assert.equal(ts.server.cluster.turnNodeState('demo', nodeId), 'node_disabled');
  assert.equal((await heartbeat(nodeId, nodeKey, { modules })).status, 403);
  const blocked = await queueAction(nodeId, 'egress', { action: 'stop' });
  assert.equal(blocked.status, 409, blocked.text);
  assert.equal(blocked.body.error.code, 'node_disabled');
  const inventory = await ts.api('GET', `${nodePath}/modules`, { headers: ADMIN });
  assert.equal(inventory.status, 200, inventory.text);
  assert.deepEqual(inventory.body.pendingCommands, []);
  assert.deepEqual(inventory.body.inFlightCommands, [sent.body.command]);

  const enabled = await ts.api('POST', `${nodePath}/disable`, { headers: ADMIN, body: { disabled: false } });
  assert.equal(enabled.status, 200, enabled.text);
  assert.deepEqual(enabled.body.node.availableModules, []);
  const recovered = await heartbeat(nodeId, nodeKey, {
    modules,
    moduleResults: [{ commandId: sent.body.command.id, status: 'running', ok: true }],
  });
  assert.deepEqual(recovered.body.moduleCommands, []);
  assert.deepEqual(recovered.body.node.availableModules, ['egress', 'turn']);
  const recoveredInventory = await ts.api('GET', `${nodePath}/modules`, { headers: ADMIN });
  assert.deepEqual(recoveredInventory.body.inFlightCommands, []);
  assert.equal(ts.server.cluster.turnNodeState('demo', nodeId), 'ready');
  assert.equal((await queueAction(nodeId, 'egress', { action: 'stop' })).status, 201);
});

test('Compose Egress and SIP report health, cancel pending commands, and keep legacy controls', async () => {
  const node = 'mod-compose-workers';
  const { nodeKey } = await createNode(node, { features: ['sfu', 'egress', 'sip'] });
  for (const [id, official, old] of [
    ['egress', 'docker.io/livekit/egress:v1.15.0', EGRESS_IMAGE],
    ['sip', 'livekit/sip:v1.24', 'agil/node-sip:0.1.0'],
  ] as const) {
    const legacy = { id, image: old, status: 'running', health: 'healthy', autoStart: true };
    const composed = { ...legacy, image: official, lifecycleContainerId: 'e'.repeat(64) };
    assert.equal((await queueAction(node, id, { action: 'install' })).status, 400);
    assert.equal((await heartbeat(node, nodeKey, { modules: [legacy] })).status, 200);
    const queued = await queueAction(node, id, { action: 'restart' });
    assert.equal(queued.status, 201, queued.text);
    const update = await heartbeat(node, nodeKey, { modules: [composed, legacy] });
    assert.equal(update.status, 200, update.text);
    assert.deepEqual(update.body.moduleCommands, []);
    assert.equal(update.body.node.modules[0].image, official);
    assert.equal(update.body.node.modules[0].autoStart, undefined);
    assert.equal(update.body.node.modules[0].lifecycleContainerId, undefined);
    for (const action of ['start', 'stop', 'restart', 'remove', 'enable-autostart', 'disable-autostart']) {
      const blocked = await queueAction(node, id, { action });
      assert.equal(blocked.status, 409, blocked.text);
      assert.equal(blocked.body.error.code, 'module_compose_read_only');
    }
    assert.equal((await heartbeat(node, nodeKey, { modules: [legacy] })).status, 200);
    const resumed = await queueAction(node, id, { action: 'stop' });
    assert.equal(resumed.status, 201, resumed.text);
    assert.deepEqual((await heartbeat(node, nodeKey)).body.moduleCommands, [resumed.body.command]);
    await heartbeat(node, nodeKey, { moduleResults: [{ commandId: resumed.body.command.id, ok: true, status: 'stopped' }] });
  }
});

test('operator-provisioned Ingress only accepts exact scoped lifecycle commands', async () => {
  const node = 'mod-ingress';
  const targetContainerId = 'a'.repeat(64);
  const { nodeKey } = await createNode(node);
  const image = 'docker.io/livekit/ingress:v1.6.0';
  const module = { id: 'ingress', image, status: 'running', health: 'healthy' };
  const report = (scoped: boolean) => heartbeat(node, nodeKey, {
    modules: [{ ...module, ...(scoped ? { lifecycleContainerId: targetContainerId } : {}) }],
  });
  const booted = await report(false);
  assert.equal(booted.status, 200, booted.text);
  assert.equal(booted.body.node.modules[0].lifecycleContainerId, undefined);
  assert.equal((await queueAction(node, 'ingress', { action: 'stop', targetContainerId })).status, 409);
  assert.equal((await report(true)).body.node.modules[0].lifecycleContainerId, targetContainerId);
  for (const action of ['install', 'remove', 'enable-autostart', 'disable-autostart']) {
    assert.equal((await queueAction(node, 'ingress', { action, targetContainerId })).status, 400);
  }
  assert.equal((await queueAction(node, 'ingress', { action: 'restart' })).status, 409);
  const foreign = await ts.api('POST', `/v1/admin/nodes/${node}/modules/ingress/actions`, {
    headers: ACME, body: { action: 'restart', targetContainerId },
  });
  assert.equal(foreign.status, 404);
  const queued = await queueAction(node, 'ingress', { action: 'stop', targetContainerId, env: { INGRESS_CONFIG_BODY: 'fixture' } });
  assert.equal(queued.status, 201, queued.text);
  assert.equal(queued.body.command.targetContainerId, targetContainerId);
  assert.equal(queued.body.command.env, undefined);
  assert.deepEqual((await heartbeat(node, nodeKey)).body.moduleCommands, []);
  assert.deepEqual((await report(false)).body.moduleCommands, []);
  await report(true);
  const retry = await queueAction(node, 'ingress', { action: 'stop', targetContainerId });
  assert.equal(retry.status, 201, retry.text);
  assert.deepEqual((await report(true)).body.moduleCommands, [retry.body.command]);
  assert.deepEqual(storedModuleCommands([{ ...retry.body.command, deliveredAt: null }], Date.now()),
    [{ ...retry.body.command, deliveredAt: null }]);
});

test('external SFU start requires maintenance and a current stopped Compose target', async () => {
  const node = 'mod-external-sfu';
  const { nodeKey } = await createNode(node, { features: ['sfu'] });
  const targetContainerId = 'a'.repeat(64);
  const report = (status = 'stopped', target = targetContainerId) => heartbeat(node, nodeKey, { modules: [{
    id: 'sfu', image: 'docker.io/livekit/livekit-server:v1.13.11', status, lifecycleContainerId: target,
  }] });
  const drain = async (enabled: boolean) => {
    const response = await ts.api('POST', `/v1/admin/nodes/${node}/drain`, { headers: ADMIN, body: { drain: enabled } });
    assert.equal(response.status, 200, response.text);
  };
  const run = (action = 'start', target = targetContainerId) => queueAction(node, 'sfu', { action, targetContainerId: target });
  assert.equal((await report()).status, 200);
  assert.equal((await run()).status, 409);
  await drain(true);
  assert.equal((await run('stop')).status, 409);
  assert.equal((await run('restart')).status, 409);
  for (const action of ['remove', 'install']) assert.equal((await run(action)).status, 400);
  assert.equal((await run('start', 'b'.repeat(64))).status, 409);
  const revoked = await run();
  assert.equal(revoked.status, 201, revoked.text);
  assert.deepEqual((await heartbeat(node, nodeKey)).body.moduleCommands, []);
  await drain(false);
  await drain(true);
  assert.deepEqual((await report()).body.moduleCommands, []);
  const queued = await run();
  assert.equal(queued.status, 201, queued.text);
  assert.deepEqual((await report('running')).body.moduleCommands, []);
  assert.equal((await run()).status, 409);
  await report();
  const ready = await run();
  assert.equal(ready.status, 201, ready.text);
  assert.deepEqual((await report()).body.moduleCommands, [ready.body.command]);
  await drain(false);
  assert.equal((await heartbeat(node, nodeKey, { sfuReady: true })).body.node.sfuReady, true);
  assert.equal(ts.server.cluster.updateNode('demo', node, { moduleEnabled: { sfu: false } }).sfuReady, false);
  assert.equal((await heartbeat(node, nodeKey, { sfuReady: true })).body.node.sfuReady, false);
  assert.equal(ts.server.cluster.updateNode('demo', node, { moduleEnabled: { sfu: true } }).sfuReady, false);
  assert.equal((await heartbeat(node, nodeKey, { sfuReady: true })).body.node.sfuReady, true);
});

test('external SFU graceful stop is maintenance-scoped and holds it until confirmed exit', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'agil-sfu-stop-'));
  const node = 'mod-graceful-sfu';
  const targetContainerId = 'a'.repeat(64);
  let server = await startTestServer({ dataDir });
  try {
    const { nodeKey } = await createNode(node, { features: ['sfu'] }, server);
    const run = (action: string) => queueAction(node, 'sfu', { action, targetContainerId }, server);
    const drain = (enabled: boolean) => server.api('POST', `/v1/admin/nodes/${node}/drain`, {
      headers: ADMIN, body: { drain: enabled },
    });
    const module = { id: 'sfu', image: 'livekit/livekit-server:v1.13.11', lifecycleContainerId: targetContainerId };
    const available = { ...module, status: 'running', sfuDrainState: 'available' };
    const requested = { ...available, sfuDrainState: 'requested' };
    const report = (modules: unknown[], body: Record<string, unknown> = {}) => heartbeat(node, nodeKey, {
      modules, sfuReady: true, ...body,
    }, server);
    assert.equal((await report([available])).status, 200);
    assert.equal((await run('stop')).status, 409);
    assert.equal((await drain(true)).status, 200);
    await report([{ ...available, sfuDrainState: undefined }]);
    assert.equal((await run('stop')).status, 409);
    await report([available]);
    assert.equal((await queueAction(node, 'sfu', { action: 'stop', targetContainerId: 'b'.repeat(64) }, server)).status, 409);
    const revokedBeforeDelivery = await run('stop');
    assert.equal(revokedBeforeDelivery.status, 201, revokedBeforeDelivery.text);
    assert.deepEqual((await report([available, available])).body.moduleCommands, []);
    await report([available]);
    const beforeExit = await run('stop');
    assert.equal(beforeExit.status, 201, beforeExit.text);
    assert.equal((await drain(false)).status, 200);
    assert.equal((await drain(true)).status, 200);
    assert.deepEqual((await report([available])).body.moduleCommands, []);
    const queued = await run('stop');
    assert.equal(queued.status, 201, queued.text);
    const delivered = await report([available]);
    assert.deepEqual(delivered.body.moduleCommands, [queued.body.command]);
    assert.equal(delivered.body.node.sfuReady, false);
    assert.equal(delivered.body.node.modules[0].sfuDrainState, 'requested');
    assert.equal(server.server.cluster.listNodeModules('demo', node).modules[0]?.sfuDrainState, 'requested');
    assert.equal((await drain(false)).status, 409);
    await server.close();
    server = await startTestServer({ dataDir });
    assert.equal((await drain(false)).status, 409, 'persist before delivering the signal');
    const inProgress = await report([requested], { moduleResults: [{ commandId: queued.body.command.id, ok: true, status: 'running' }] });
    assert.equal(inProgress.body.node.modules[0].sfuDrainState, 'requested');
    assert.equal(inProgress.body.node.sfuReady, false);
    assert.equal((await run('stop')).status, 409);
    assert.deepEqual((await report([])).body.moduleCommands, []);
    assert.equal((await drain(false)).status, 409, 'missing inventory cannot prove exit');
    const stopped = await report([{ ...module, status: 'stopped' }], { sfuReady: false });
    assert.equal(stopped.body.node.modules[0].sfuDrainState, undefined);
    assert.equal((await run('start')).status, 201);
    assert.equal((await drain(false)).status, 200);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('external SFU restart starts only the same confirmed stopped container and waits for fresh readiness', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'agil-sfu-restart-'));
  const node = 'mod-restart-external-sfu';
  const targetContainerId = 'a'.repeat(64);
  const otherContainerId = 'b'.repeat(64);
  let server = await startTestServer({ dataDir });
  try {
    const { nodeKey } = await createNode(node, { features: ['sfu'] }, server);
    const drain = (enabled: boolean) => server.api('POST', `/v1/admin/nodes/${node}/drain`, {
      headers: ADMIN, body: { drain: enabled },
    });
    const stopped = { id: 'sfu', image: 'livekit/livekit-server:v1.13.11', lifecycleContainerId: targetContainerId, status: 'stopped' };
    const available = { ...stopped, status: 'running', sfuDrainState: 'available' };
    const report = (modules: unknown[], body: Record<string, unknown> = {}) => heartbeat(node, nodeKey, {
      modules, sfuReady: false, ...body,
    }, server);
    const run = () => queueAction(node, 'sfu', { action: 'restart', targetContainerId }, server);
    await report([available], { sfuReady: true });
    assert.equal((await run()).status, 409);
    assert.equal((await drain(true)).status, 200);

    const restart = await run();
    assert.equal(restart.status, 201, restart.text);
    const delivered = await report([available]);
    assert.deepEqual(delivered.body.moduleCommands, [restart.body.command]);
    assert.equal(delivered.body.node.modules[0].sfuDrainState, 'restart_requested');
    const acknowledged = await report([{ ...available, sfuDrainState: 'requested' }], {
      moduleResults: [{ commandId: restart.body.command.id, ok: true, status: 'running' }],
    });
    assert.deepEqual(acknowledged.body.moduleCommands, []);
    assert.equal((await drain(false)).status, 409);
    await server.close();
    server = await startTestServer({ dataDir });
    assert.deepEqual((await report([{ ...stopped, lifecycleContainerId: otherContainerId }])).body.moduleCommands, []);
    assert.deepEqual((await report([stopped], { status: 'offline' })).body.moduleCommands, []);
    const observed = await report([stopped]);
    assert.equal(observed.status, 200, observed.text);
    const [start] = observed.body.moduleCommands;
    assert.equal(start.action, 'start');
    assert.equal(start.targetContainerId, targetContainerId);
    const audit = await server.api('GET', '/v1/admin/audit?limit=200', { headers: ADMIN });
    assert.ok(audit.body.entries.some((entry: { details?: { commandId?: string; source?: string } }) =>
      entry.details?.commandId === start.id && entry.details?.source === 'graceful_sfu_restart'));
    assert.deepEqual((await report([stopped])).body.moduleCommands, []);
    assert.equal((await drain(false)).status, 409);
    const running = await report([available], {
      moduleResults: [{ commandId: start.id, ok: true, status: 'running' }],
    });
    assert.equal(running.body.node.modules[0].sfuDrainState, 'restart_requested');
    assert.equal((await drain(false)).status, 409);
    assert.deepEqual((await report([available], { sfuReady: true })).body.moduleCommands, []);
    assert.equal((await drain(false)).status, 200);

    assert.equal((await drain(true)).status, 200);
    const retry = await run();
    assert.equal(retry.status, 201, retry.text);
    await report([available]);
    const startAttempt = await report([stopped], {
      moduleResults: [{ commandId: retry.body.command.id, ok: true, status: 'stopped' }],
    });
    const [failedStart] = startAttempt.body.moduleCommands;
    assert.equal(failedStart.action, 'start');
    const failed = await report([stopped], {
      moduleResults: [{ commandId: failedStart.id, ok: false, status: 'stopped', error: 'Docker start failed' }],
    });
    assert.deepEqual(failed.body.moduleCommands, []);
    assert.deepEqual((await report([stopped])).body.moduleCommands, []);
    assert.equal(failed.body.node.drain, true);
    assert.equal((await queueAction(node, 'sfu', { action: 'start', targetContainerId }, server)).status, 201);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('normalized module logs are tenant-scoped, bounded to current inventory and ephemeral', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'agil-module-logs-'));
  const node = 'mod-log-window';
  const route = `/v1/admin/nodes/${node}/modules`;
  const event = { time: 123456789, level: 'warn', stream: 'stderr' };
  let server = await startTestServer({ dataDir, platformKey: 'platform-test-key' });
  try {
    const { nodeKey } = await createNode(node, {}, server);
    const module = { id: 'qa-log-owner', image: 'qa/worker:1', status: 'running' };
    const logs = { status: 'ready', events: [{ ...event, message: 'fixture-should-remain-local' }] };
    const scoped = await heartbeat(node, nodeKey, { modules: [{ ...module, logs }] }, server);
    assert.equal(scoped.status, 200, scoped.text);
    assert.equal(scoped.body.node.modules[0].logs, undefined);
    const view = () => server.api('GET', route, { headers: ADMIN });
    const response = await view();
    assert.deepEqual(response.body.logWindows, [{ moduleId: module.id, status: 'ready', events: [event] }]);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await server.api('GET', route, { headers: ACME })).status, 404);
    assert.equal((await server.api('GET', route, { headers: PLATFORM })).status, 403);
    const disk = readFileSync(path.join(dataDir, 'cluster', 'cluster.json'), 'utf8');
    assert.ok(!disk.includes('123456789') && !disk.includes('fixture-should-remain-local'));
    assert.equal(server.server.cluster.listNodeModules('demo', node, Date.now() + NODE_OFFLINE_AFTER_SEC * 1000).logWindows, undefined);
    await heartbeat(node, nodeKey, { modules: [{ ...module, logs }, module] }, server);
    assert.equal((await view()).body.logWindows, undefined);
    await heartbeat(node, nodeKey, { modules: [{ ...module, logs }] }, server);
    await server.close();
    server = await startTestServer({ dataDir });
    assert.equal((await view()).body.logWindows, undefined);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('modules snapshot: custom ids stay read-only; catalog image guards and empty inventory remain intact', async () => {
  const { nodeKey } = await createNode('mod-snapshot');

  // Absent until the first report: no fabricated empty inventory.
  assert.equal('modules' in (await adminNode(ts, 'mod-snapshot')), false);

  const first = await heartbeat('mod-snapshot', nodeKey, {
    modules: [
      { id: 'egress', image: EGRESS_IMAGE, status: 'running', name: 'My egress', version: '1.2.3', health: 'healthy', ports: [9000] },
      // A custom module can use a catalog classification but gains no provider capability.
      { id: 'gpu', kind: 'egress', image: 'agil/node-gpu:1.0', status: 'running' },
      // Not the allowlisted repository: dropped.
      { id: 'recorder', image: 'evil/recorder:1.0', status: 'running' },
      // Omitted name/version/health/ports/updatedAt are filled honestly.
      { id: 'turn', image: TURN_IMAGE, status: 'stopped' },
    ],
  });
  assert.equal(first.status, 200, first.text);
  const modules = first.body.node.modules as Array<Record<string, any>>;
  assert.deepEqual(modules.map((module) => module.id), ['egress', 'turn', 'gpu'], 'catalog entries first');
  assert.equal(modules[0]!.name, 'My egress');
  assert.equal(modules[0]!.version, '1.2.3');
  assert.deepEqual(modules[0]!.ports, [9000]);
  assert.ok(modules[0]!.updatedAt >= 0);
  assert.equal(modules[1]!.name, 'TURN/STUN relay', 'catalog display name fallback');
  assert.equal(modules[1]!.version, '');
  assert.equal(modules[1]!.health, 'unknown');
  assert.deepEqual(modules[1]!.ports, []);
  assert.ok(modules[1]!.updatedAt >= 0);
  assert.equal(modules[2]!.name, 'gpu');
  assert.equal(modules[2]!.kind, 'egress');
  assert.deepEqual(first.body.node.availableModules, ['egress']);
  assert.equal((await queueAction('mod-snapshot', 'gpu', { action: 'stop' })).body.error.code, 'module_target_changed');
  assert.equal((await queueAction('mod-snapshot', 'gpu', { action: 'install' })).status, 400);

  // NodeSummary in the list carries the same inventory.
  const listed = await adminNode(ts, 'mod-snapshot');
  assert.deepEqual(listed.modules.map((module: { id: string }) => module.id), ['egress', 'turn', 'gpu']);
  const customOnly = await heartbeat('mod-snapshot', nodeKey, { modules: [{ id: 'gpu', kind: 'turn', image: 'redis:7', status: 'running' }] });
  assert.deepEqual(customOnly.body.node.availableModules, []);
  assert.equal(ts.server.cluster.turnNodeState('demo', 'mod-snapshot'), 'turn_not_installed');

  // An invalid status is a validation error (the whole beat is rejected, so a
  // typo never silently corrupts the inventory).
  const invalid = await heartbeat('mod-snapshot', nodeKey, {
    modules: [{ id: 'egress', image: EGRESS_IMAGE, status: 'paused' }],
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'validation_failed');

  // An explicit empty snapshot is an honest report, not "never reported".
  const empty = await heartbeat('mod-snapshot', nodeKey, { modules: [] });
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual(empty.body.node.modules, []);
  assert.equal('modules' in (await adminNode(ts, 'mod-snapshot')), true);

  // Old agents omit `modules`: the last honest snapshot is preserved.
  const oldStyle = await heartbeat('mod-snapshot', nodeKey, { capacity: { maxRooms: 3 } });
  assert.equal(oldStyle.status, 200, oldStyle.text);
  assert.deepEqual(oldStyle.body.node.modules, []);
});

test('custom lifecycle binds the request, delivery and result to the reported container', async () => {
  const node = 'mod-custom-lifecycle';
  const { nodeKey } = await createNode(node);
  const firstId = 'a'.repeat(64);
  const secondId = 'b'.repeat(64);
  const inventory = (lifecycleContainerId: string) => ({
    modules: [{ id: 'cache', image: 'redis:7', kind: 'turn', status: 'running', lifecycleContainerId }],
  });
  await heartbeat(node, nodeKey, inventory(firstId));
  assert.equal((await queueAction(node, 'cache', { action: 'stop', targetContainerId: secondId })).status, 409);
  assert.equal((await queueAction(node, 'cache', { action: 'remove', targetContainerId: firstId })).status, 400);
  const queued = await queueAction(node, 'cache', { action: 'stop', targetContainerId: firstId });
  assert.equal(queued.status, 201, queued.text);
  assert.equal(queued.body.command.targetContainerId, firstId);
  assert.deepEqual(storedModuleCommands([{ ...queued.body.command, deliveredAt: null }], Date.now()),
    [{ ...queued.body.command, deliveredAt: null }]);
  assert.deepEqual((await heartbeat(node, nodeKey)).body.moduleCommands, [], 'liveness alone cannot deliver the command');
  const replaced = await heartbeat(node, nodeKey, inventory(secondId));
  assert.deepEqual(replaced.body.moduleCommands, []);
  assert.deepEqual(replaced.body.node.availableModules, []);
  assert.equal(ts.server.cluster.turnNodeState('demo', node), 'turn_not_installed');
  const view = await ts.api('GET', `/v1/admin/nodes/${node}/modules`, { headers: ADMIN });
  assert.deepEqual(view.body.failures, [{ moduleId: 'cache', action: 'stop', reason: 'target_changed' }]);

  const retry = await queueAction(node, 'cache', { action: 'restart', targetContainerId: secondId });
  const delivery = await heartbeat(node, nodeKey, inventory(secondId));
  assert.deepEqual(delivery.body.moduleCommands, [retry.body.command]);
  await heartbeat(node, nodeKey, inventory(firstId));
  const result = await heartbeat(node, nodeKey, {
    moduleResults: [{ commandId: retry.body.command.id, ok: true, status: 'stopped' }],
  });
  assert.equal(result.body.node.modules[0].lifecycleContainerId, firstId);
  assert.equal(result.body.node.modules[0].status, 'running', 'the replacement keeps its own state');
  const duplicate = await heartbeat(node, nodeKey, { modules: [...inventory(firstId).modules, ...inventory(secondId).modules] });
  assert.equal(duplicate.body.node.modules[0].lifecycleContainerId, undefined);
});

/* ------------------------------------------------------------------ */
/* TTL / offline delivery (store-level time control)                   */
/* ------------------------------------------------------------------ */

test('local module templates stay scoped to the node and cannot be installed', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'agil-node-templates-'));
  const node = 'mod-local-template';
  const endpoint = `/v1/admin/nodes/${node}/modules`;
  const template = { id: 'qa-cache', image: 'registry.example/qa/cache@sha256:' + 'a'.repeat(64), cached: true, storage: 'read_only',
    privatePorts: [{ port: 8080, protocol: 'tcp' }],
    resources: { cpuMillicores: 750, memoryMiB: 384, pidsLimit: 48 } };
  const options = { dataDir, heartbeatRateLimitPerMin: 100 };
  let server = await startTestServer(options);
  try {
    const { nodeKey } = await createNode(node, {}, server);
    const completed = await heartbeat(node, nodeKey, { modules: [], moduleTemplates: [template] }, server);
    assert.equal(completed.status, 200, completed.text);
    assert.deepEqual(completed.body.node.availableModules, []);

    const view = () => server.api('GET', endpoint, { headers: ADMIN });
    assert.deepEqual((await view()).body.moduleTemplates, [template]);
    assert.equal((await server.api('GET', endpoint, { headers: ACME })).status, 404);
    assert.equal((await queueAction(node, template.id, { action: 'install' }, server)).status, 404);
    for (const changed of [
      { ...template, image: 'registry.example/qa/cache:latest' },
      { ...template, env: { FIXTURE: 'hidden-value' } },
      { ...template, envRefs: ['QA_LOCAL_SECRET'] },
      { ...template, commandArgs: ['qa-node-private-command'] },
      { ...template, storageVolume: 'qa-private-volume' },
      { ...template, storage: 'read_write' },
      { ...template, networkId: 'b'.repeat(64) },
      { ...template, privatePorts: [{ port: 8080, protocol: 'tcp', hostPort: 8080 }] },
      { ...template, privatePorts: [...template.privatePorts, ...template.privatePorts] },
      { ...template, resources: { ...template.resources, memoryMiB: 8193 } },
      { ...template, resources: { ...template.resources, extra: true } },
    ]) {
      const invalid = await heartbeat(node, nodeKey, { modules: [], moduleTemplates: [changed] }, server);
      assert.equal(invalid.status, 400, invalid.text);
    }
    for (const blockedReason of ['environment_unavailable', 'storage_unavailable', 'network_unavailable']) {
      const blocked = { ...template, blockedReason };
      assert.equal((await heartbeat(node, nodeKey, { modules: [], moduleTemplates: [blocked] }, server)).status, 200);
      assert.deepEqual((await view()).body.moduleTemplates, [blocked]);
      assert.equal((await queueAction(node, template.id, { action: 'install', expectedImage: template.image }, server)).status, 409);
    }
    assert.equal((await heartbeat(node, nodeKey, { modules: [], moduleTemplates: [template] }, server)).status, 200);
    await heartbeat(node, nodeKey, { moduleAvailability: 'unavailable' }, server);
    assert.deepEqual((await view()).body.moduleTemplates, [template]);
    await server.close();
    server = await startTestServer(options);
    assert.deepEqual((await view()).body.moduleTemplates, [template]);
    assert.equal((await heartbeat(node, nodeKey, { modules: [], moduleTemplates: [] }, server)).status, 200);
    assert.deepEqual((await view()).body.moduleTemplates, []);
    await heartbeat(node, nodeKey, { modules: [], moduleTemplates: [template] }, server);
    await heartbeat(node, nodeKey, { modules: [] }, server);
    assert.equal((await view()).body.moduleTemplates, undefined);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('same-image template changes require fresh approval and an eligible exact running target', async () => {
  const server = await startTestServer();
  const node = 'mod-same-image-template';
  const moduleId = 'qa-same-image';
  const image = `registry.example/qa/worker@sha256:${'a'.repeat(64)}`;
  const targetContainerId = 'b'.repeat(64);
  try {
    const { nodeKey } = await createNode(node, {}, server);
    const inventory = [{ id: moduleId, image, status: 'running', lifecycleContainerId: targetContainerId, templateRemovable: true }];
    const template = { id: moduleId, image, cached: true, installable: true };
    const beat = (changed: boolean) => heartbeat(node, nodeKey, {
      modules: inventory, moduleTemplates: [{ ...template, ...(changed ? { profileChanged: true } : {}) }],
    }, server);
    const apply = (target = targetContainerId) => queueAction(node, moduleId, {
      action: 'install', targetContainerId: target, expectedImage: image,
    }, server);
    assert.equal((await beat(false)).status, 200);
    assert.equal((await apply()).status, 409);
    await beat(true);
    assert.equal((await apply('c'.repeat(64))).status, 409);
    assert.equal((await apply()).status, 201);
    assert.deepEqual((await beat(false)).body.moduleCommands, []);
    await beat(true);
    const accepted = await apply();
    assert.equal(accepted.status, 201, accepted.text);
    assert.deepEqual((await beat(true)).body.moduleCommands, [accepted.body.command]);
  } finally {
    await server.close();
  }
});

test('approved custom installs are pinned to a fresh node inventory and survive restart', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'agil-template-install-'));
  const node = 'mod-template-install';
  const template = { id: 'qa-cache', image: 'registry.example/qa/cache@sha256:' + 'a'.repeat(64), cached: true, installable: true };
  const changed = { ...template, image: template.image.replace(/a{64}$/, 'b'.repeat(64)) };
  const options = { dataDir, heartbeatRateLimitPerMin: 100 };
  let server = await startTestServer(options);
  try {
    const { nodeKey } = await createNode(node, {}, server);
    const reportTemplate = (entry: Record<string, unknown> = template) => ({ modules: [], moduleTemplates: [entry] });
    assert.equal((await heartbeat(node, nodeKey, reportTemplate(), server)).status, 200);
    const request = (expectedImage = template.image, extra = {}) =>
      queueAction(node, template.id, { action: 'install', expectedImage, ...extra }, server);
    assert.equal((await request(changed.image)).status, 409);
    const queued = await request(template.image, { env: { SECRET: 'fixture' }, image: changed.image, commandArgs: ['qa-caller-command'] });
    assert.equal(queued.status, 201, queued.text);
    assert.equal(queued.body.command.image, template.image);
    assert.equal(queued.body.command.env, undefined);
    assert.equal(queued.body.command.commandArgs, undefined);
    assert.deepEqual((await heartbeat(node, nodeKey, {}, server)).body.moduleCommands, []);
    await server.close();
    server = await startTestServer(options);
    assert.deepEqual((await heartbeat(node, nodeKey, reportTemplate(changed), server)).body.moduleCommands, []);
    const view = await server.api('GET', `/v1/admin/nodes/${node}/modules`, { headers: ADMIN });
    assert.deepEqual(view.body.failures, [{ moduleId: template.id, action: 'install', reason: 'target_changed' }]);
    const replacement = await request(changed.image);
    assert.equal(replacement.status, 201, replacement.text);
    const missingImage = { ...changed, cached: false, installable: undefined, blockedReason: 'image_not_cached' };
    const blocked = await heartbeat(node, nodeKey, reportTemplate(missingImage), server);
    assert.deepEqual(blocked.body.moduleCommands, []);
    assert.equal(blocked.body.node.status, 'online');
    assert.equal((await request(changed.image)).status, 409);
    await heartbeat(node, nodeKey, reportTemplate(changed), server);
    const recovered = await request(changed.image);
    assert.equal(recovered.status, 201, recovered.text);
    const beat = await heartbeat(node, nodeKey, reportTemplate(changed), server);
    assert.deepEqual(beat.body.moduleCommands, [recovered.body.command]);
    const containerId = 'c'.repeat(64);
    const installed = { id: template.id, image: 'sha256:' + 'c'.repeat(64), status: 'running', lifecycleContainerId: containerId, templateRemovable: true };
    const completed = await heartbeat(node, nodeKey, {
      modules: [installed],
      moduleTemplates: [changed],
      moduleResults: [{ commandId: recovered.body.command.id, ok: true, status: 'running' }],
    }, server);
    assert.equal(completed.status, 200, completed.text);
    assert.deepEqual(completed.body.node.availableModules, []);
    assert.equal((await request(changed.image)).status, 409);
    const updatedTemplate = { ...changed, image: changed.image.replace(/b{64}$/, 'd'.repeat(64)) };
    await heartbeat(node, nodeKey, { modules: [installed], moduleTemplates: [updatedTemplate] }, server);
    const replace = (target: string) => request(updatedTemplate.image, { targetContainerId: target });
    assert.equal((await replace('e'.repeat(64))).status, 409);
    const update = await replace(containerId);
    assert.equal(update.status, 201, update.text);
    assert.equal(update.body.command.targetContainerId, containerId);
    assert.equal(update.body.command.image, updatedTemplate.image);
    assert.deepEqual((await heartbeat(node, nodeKey, {}, server)).body.moduleCommands, []);
    const updateDelivery = await heartbeat(node, nodeKey, { modules: [installed], moduleTemplates: [updatedTemplate] }, server);
    assert.deepEqual(updateDelivery.body.moduleCommands, [update.body.command]);
    await heartbeat(node, nodeKey, {
      modules: [installed],
      moduleResults: [{ commandId: update.body.command.id, ok: false, status: 'unknown', error: 'compensated' }],
    }, server);
    const remove = (targetContainerId = containerId) => queueAction(node, template.id, { action: 'remove', targetContainerId }, server);
    assert.equal((await remove('d'.repeat(64))).status, 409);
    const queuedRemove = await remove();
    assert.equal(queuedRemove.status, 201, queuedRemove.text);
    const { templateRemovable: _approval, ...withoutApproval } = installed;
    assert.deepEqual((await heartbeat(node, nodeKey, { modules: [withoutApproval] }, server)).body.moduleCommands, []);
    assert.equal((await remove()).status, 400);
    assert.equal((await heartbeat(node, nodeKey, { modules: [installed] }, server)).status, 200);
    const retried = await remove();
    assert.equal(retried.status, 201, retried.text);
    assert.deepEqual((await heartbeat(node, nodeKey, { modules: [installed] }, server)).body.moduleCommands, [retried.body.command]);
    const removed = await heartbeat(node, nodeKey, {
      modules: [],
      moduleResults: [{ commandId: retried.body.command.id, ok: true, status: 'unknown' }],
    }, server);
    assert.deepEqual(removed.body.node.modules, []);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('queue TTL: commands expire, late acks are ignored, offline beats do not deliver', async () => {
  const { nodeKey } = await createNode('mod-ttl');
  const cluster = ts.server.cluster;
  const t0 = Date.now();

  // 1. Not delivered after the TTL.
  const expired = cluster.queueModuleCommand({
    tenantId: 'demo',
    nodeId: 'mod-ttl',
    moduleId: 'egress',
    action: 'start',
    now: t0,
  });
  const lateBeat = cluster.heartbeat({ rawKey: nodeKey, nodeId: 'mod-ttl', body: {}, now: t0 + NODE_MODULE_COMMAND_TTL_MS + 1 });
  assert.deepEqual(lateBeat.moduleCommands, [], 'an expired command is never delivered');
  assert.deepEqual(cluster.listNodeModules('demo', 'mod-ttl').pendingCommands, []);
  assert.deepEqual(cluster.listNodeModules('demo', 'mod-ttl').failures, [
    { moduleId: 'egress', action: 'start', reason: 'delivery_expired' },
  ]);
  assert.equal(expired.expiresAt, t0 + NODE_MODULE_COMMAND_TTL_MS);

  // 2. Delivered in time, but an acknowledgement after expiry is ignored.
  const install = cluster.queueModuleCommand({
    tenantId: 'demo',
    nodeId: 'mod-ttl',
    moduleId: 'stt',
    action: 'install',
    now: t0,
  });
  const onTime = cluster.heartbeat({
    rawKey: nodeKey,
    nodeId: 'mod-ttl',
    body: {},
    now: t0 + NODE_MODULE_COMMAND_TTL_MS - 1_000,
  });
  assert.deepEqual(onTime.moduleCommands.map((command) => command.id), [install.id]);

  const awaiting = cluster.listNodeModules('demo', 'mod-ttl', t0 + NODE_MODULE_COMMAND_TTL_MS - 1);
  assert.deepEqual(awaiting.inFlightCommands.map((command) => command.id), [install.id]);
  const expiredView = cluster.listNodeModules('demo', 'mod-ttl', t0 + NODE_MODULE_COMMAND_TTL_MS);
  assert.deepEqual(expiredView.inFlightCommands, [], 'an expired command stops blocking controls before another heartbeat');
  assert.deepEqual(expiredView.failures.find((failure) => failure.moduleId === 'stt'),
    { moduleId: 'stt', action: 'install', reason: 'result_expired' });
  assert.equal(awaiting.failures.some((failure) => failure.moduleId === 'stt'), false, 'reading a later view does not mutate the queue');

  const tooLate = cluster.heartbeat({
    rawKey: nodeKey,
    nodeId: 'mod-ttl',
    body: { moduleResults: [{ commandId: install.id, ok: true, status: 'running' }] },
    now: t0 + NODE_MODULE_COMMAND_TTL_MS + 1,
  });
  assert.deepEqual(tooLate.acknowledgedModuleResults, [], 'a late ack for an expired command is ignored');
  assert.deepEqual(tooLate.moduleCommands, []);
  assert.deepEqual(cluster.listNodeModules('demo', 'mod-ttl').failures.find((failure) => failure.moduleId === 'stt'),
    { moduleId: 'stt', action: 'install', reason: 'result_expired' });

  // 3. A graceful offline heartbeat does not start work; the command waits for
  //    the next online beat within its TTL.
  const stop = cluster.queueModuleCommand({
    tenantId: 'demo',
    nodeId: 'mod-ttl',
    moduleId: 'turn',
    action: 'stop',
    now: t0 + 1_000,
  });
  const offline = cluster.heartbeat({
    rawKey: nodeKey,
    nodeId: 'mod-ttl',
    body: { status: 'offline' },
    now: t0 + 1_001,
  });
  assert.deepEqual(offline.moduleCommands, []);
  assert.deepEqual(cluster.listNodeModules('demo', 'mod-ttl').pendingCommands.map((command) => command.id), [stop.id]);
  const online = cluster.heartbeat({ rawKey: nodeKey, nodeId: 'mod-ttl', body: {}, now: t0 + 2_000 });
  assert.deepEqual(online.moduleCommands.map((command) => command.id), [stop.id]);
});

/* ------------------------------------------------------------------ */
/* Standby Core                                                        */
/* ------------------------------------------------------------------ */

test('standby: catalog stays readable, queueing an action returns 409 not_leader', async () => {
  const standby = await startTestServer({ clusterRole: 'standby' });
  try {
    const catalog = await standby.api('GET', '/v1/admin/node-modules/catalog', { headers: ADMIN });
    assert.equal(catalog.status, 200, 'read-only catalog works on a standby');

    const action = await standby.api('POST', '/v1/admin/nodes/any-node/modules/egress/actions', {
      headers: ADMIN,
      body: { action: 'restart' },
    });
    assert.equal(action.status, 409);
    assert.equal(action.body.error.code, 'not_leader');

    // The read path is open (node lookup is 404, not 409: no leader gate on reads).
    const modules = await standby.api('GET', '/v1/admin/nodes/any-node/modules', { headers: ADMIN });
    assert.equal(modules.status, 404);
  } finally {
    await standby.close();
  }
});

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

test('restart: module inventory, failed installs and the delivered/pending command queue are durable', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'agil-node-modules-'));
  try {
    const first = await startTestServer({ dataDir });
    const { nodeKey } = await createNode('mod-restart', {}, first);
    assert.equal(
      (await heartbeat('mod-restart', nodeKey, { modules: [report()] }, first)).status,
      200,
    );
    const failedInstall = await queueAction('mod-restart', 'turn', { action: 'install' }, first);
    assert.equal(failedInstall.status, 201);
    const installId = failedInstall.body.command.id;
    assert.equal((await heartbeat('mod-restart', nodeKey, {}, first)).body.moduleCommands[0].id, installId);
    assert.equal((await heartbeat('mod-restart', nodeKey, {
      modules: [report(), { id: 'custom-cache', kind: 'cache', image: 'redis:7', status: 'running' }],
      moduleResults: [{ commandId: installId, ok: false, status: 'error', error: 'Registry unavailable' }],
    }, first)).status, 200);
    assert.equal((await queueAction('mod-restart', 'egress', { action: 'restart' }, first)).status, 201);
    await first.close();

    // The queue and the inventory are in the registry file, not only in memory.
    const state = JSON.parse(
      readFileSync(path.join(dataDir, 'cluster', 'cluster.json'), 'utf8'),
    ) as { nodes: Array<{ id: string; modules?: Array<{ id: string }>; moduleCommands?: Array<{ moduleId: string; deliveredAt: unknown }> }> };
    const storedNode = state.nodes.find((node) => node.id === 'mod-restart');
    assert.deepEqual(storedNode?.modules?.map((module) => module.id), ['egress', 'custom-cache']);
    assert.equal(storedNode?.moduleCommands?.length, 1);
    assert.equal(storedNode?.moduleCommands?.[0]?.deliveredAt, null);

    // Restart: the inventory is still there and the pending command is delivered.
    const second = await startTestServer({ dataDir });
    try {
      const persisted = await adminNode(second, 'mod-restart');
      assert.deepEqual(persisted.modules.map(({ id, kind }: { id: string; kind: string }) => [id, kind]),
        [['egress', 'egress'], ['custom-cache', 'cache']]);
      assert.deepEqual(persisted.availableModules, ['egress']);
      const delivered = await heartbeat('mod-restart', nodeKey, {}, second);
      assert.equal(delivered.status, 200, delivered.text);
      assert.equal(delivered.body.moduleCommands.length, 1);
      assert.equal(delivered.body.moduleCommands[0].action, 'restart');
    } finally {
      await second.close();
    }

    // Restart again: the command was delivered once, so it is not repeated.
    const third = await startTestServer({ dataDir });
    let stoppedCommandId: string;
    try {
      const repeat = await heartbeat('mod-restart', nodeKey, {}, third);
      assert.equal(repeat.status, 200, repeat.text);
      assert.deepEqual(repeat.body.moduleCommands, []);
      // The module inventory survives too.
      assert.deepEqual((await adminNode(third, 'mod-restart')).modules[0].id, 'egress');
      const modulePath = '/v1/admin/nodes/mod-restart/modules';
      const inventory = await third.api('GET', modulePath, { headers: ADMIN });
      assert.deepEqual(inventory.body.failures, [{ moduleId: 'turn', action: 'install', error: 'Registry unavailable' }]);
      assert.equal(inventory.body.modules.some((module: { id: string }) => module.id === 'turn'), false);
      const successfulInstall = await queueAction('mod-restart', 'turn', { action: 'install' }, third);
      assert.equal(successfulInstall.status, 201);
      const retryId = successfulInstall.body.command.id;
      assert.equal((await heartbeat('mod-restart', nodeKey, {}, third)).body.moduleCommands[0].id, retryId);
      assert.equal((await heartbeat('mod-restart', nodeKey, {
        modules: [report(), { id: 'turn', image: TURN_IMAGE, status: 'running' }],
        moduleResults: [{ commandId: retryId, ok: true, status: 'running' }],
      }, third)).status, 200);
      const recovered = await third.api('GET', modulePath, { headers: ADMIN });
      assert.deepEqual(recovered.body.failures, []);
      assert.equal(recovered.body.modules.find((module: { id: string }) => module.id === 'turn').status, 'running');
      const stopping = await queueAction('mod-restart', 'turn', { action: 'stop' }, third);
      assert.equal(stopping.status, 201);
      stoppedCommandId = stopping.body.command.id;
      assert.equal((await heartbeat('mod-restart', nodeKey, {}, third)).body.moduleCommands[0].id, stoppedCommandId);
    } finally {
      await third.close();
    }

    // Simulate the time passing while the Core is down using its disposable registry file.
    const registryPath = path.join(dataDir, 'cluster', 'cluster.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as { nodes: Array<{ id: string;
      moduleCommands: Array<{ id: string; createdAt: number; expiresAt: number; deliveredAt: number | null }>; }> };
    const expired = registry.nodes.find((node) => node.id === 'mod-restart')?.moduleCommands.find((command) => command.id === stoppedCommandId);
    assert.ok(expired);
    expired.createdAt = Date.now() - NODE_MODULE_COMMAND_TTL_MS - 1000;
    expired.deliveredAt = expired.createdAt + 1;
    expired.expiresAt = expired.createdAt + NODE_MODULE_COMMAND_TTL_MS;
    writeFileSync(registryPath, JSON.stringify(registry), 'utf8');

    const fourth = await startTestServer({ dataDir });
    try {
      const inventory = await fourth.api('GET', '/v1/admin/nodes/mod-restart/modules', { headers: ADMIN });
      assert.equal(inventory.status, 200);
      assert.equal(inventory.body.inFlightCommands.some((command: { id: string }) => command.id === stoppedCommandId), false);
      assert.deepEqual(inventory.body.failures, [{ moduleId: 'turn', action: 'stop', reason: 'result_expired' }]);
      assert.equal(inventory.body.modules.find((module: { id: string }) => module.id === 'turn').status, 'running');
    } finally {
      await fourth.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Secret hygiene                                                      */
/* ------------------------------------------------------------------ */

test('no secret leakage: command/queue/registry payloads never contain a node key', async () => {
  const { nodeKey } = await createNode('mod-secret');
  const queued = await queueAction('mod-secret', 'turn', { action: 'install' });
  assert.equal(queued.status, 201, queued.text);
  assert.ok(!queued.text.includes(nodeKey));

  const modules = await ts.api('GET', '/v1/admin/nodes/mod-secret/modules', { headers: ADMIN });
  assert.ok(!modules.text.includes(nodeKey));
  assert.ok(!modules.text.includes('keyHash'));

  const state = readFileSync(path.join(ts.dataDir, 'cluster', 'cluster.json'), 'utf8');
  assert.ok(!state.includes(nodeKey), 'the registry file stores only the node key hash');
  const parsed = JSON.parse(state) as { nodes: Array<{ id: string; keyHash: string; moduleCommands?: unknown[] }> };
  const stored = parsed.nodes.find((node) => node.id === 'mod-secret');
  assert.match(stored?.keyHash ?? '', /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(stored?.moduleCommands));
});
