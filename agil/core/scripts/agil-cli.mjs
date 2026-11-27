#!/usr/bin/env node
/**
 * AgilFrame operator CLI (Core/Node enrollment + registry).
 *
 * No dependencies and no build step: uses the global `fetch` (Node >= 20), so it
 * runs from the repository checkout *and* from the production `agil-calls` image
 * (`node agil/core/scripts/agil-cli.mjs ...`).
 *
 *   token create --kind node --role sfu [--features sfu,egress] [--ttl 3600] [--uses 1] [--label edge-sfu]
 *   token list | token revoke <id>
 *   nodes list [--role sfu] [--status online]
 *   nodes register --token <token> [--id node-1] [--role sfu] [--features sfu] [--endpoint https://sfu-1:7880]
 *   nodes heartbeat --id node-1 [--key nk_...] [--capacity '{"maxParticipants":500}'] [--no-metrics]
 *   nodes rotate-key <nodeId> [--ttl 2592000]
 *   cluster status
 *
 * Global flags: --core <url> | AGIL_CORE_URL, --api-key <key> | AGIL_API_KEY, --json.
 * Node enrollment env: AGIL_NODE_TOKEN, AGIL_NODE_KEY, AGIL_NODE_ID, AGIL_NODE_NAME,
 * AGIL_NODE_ROLE, AGIL_NODE_FEATURES, AGIL_NODE_CAPACITY, AGIL_NODE_ENDPOINT, AGIL_NODE_REGION.
 *
 * `nodes heartbeat` attaches best-effort host stats under `metrics` (cpuPercent,
 * memoryPercent, load1, uptimeSec, version, reportedAt; bandwidthMbps and
 * activeRooms/participants only when measurable locally). Collection failures
 * never block the heartbeat; pass `--no-metrics` to omit the object entirely.
 *
 * Secrets (enrollment token / node key / API key) are never written to stderr or
 * to a log file; a one-time token/key is printed exactly once to stdout.
 */
import process from 'node:process';

import { createMetricsCollector, normalizeNodeMetrics } from './lib/node-metrics.mjs';

/** Software version reported in heartbeat `metrics.version`. */
const CLI_VERSION = '0.1.0';
/** One-shot CLI: time between the two /proc samples used for the CPU delta. */
const METRICS_SAMPLE_MS = 250;
/** Fallback uptime baseline when `/proc/uptime` is unavailable (non-Linux hosts). */
const PROCESS_STARTED_AT = Date.now();

const HELP = `AgilFrame CLI — cluster enrollment & node registry

Usage:
  agil-cli.mjs token create --kind <core|node> [--role <role>] [--features a,b]
                            [--ttl 3600] [--uses 1] [--label text]
  agil-cli.mjs token list
  agil-cli.mjs token revoke <tokenId>
  agil-cli.mjs nodes list [--role sfu|turn|stun|all] [--status online|offline|draining|disabled]
  agil-cli.mjs nodes register --token <enrollment token> [--role sfu|turn|stun|all]
                            [--id node-1] [--name "Edge SFU"] [--features sfu,egress]
                            [--endpoint https://sfu-1:7880] [--region ru-msk]
                            [--capacity '{"maxRooms":5,"maxParticipants":300}']
                            [--ttl <node-key seconds>]
  agil-cli.mjs nodes heartbeat --id <nodeId> [--key nk_...] [--capacity '{...}']
                            [--no-metrics]
  agil-cli.mjs nodes rotate-key <nodeId> [--ttl <node-key seconds>]
  agil-cli.mjs cluster status

Global:
  --core <url>      Core base URL (default: AGIL_CORE_URL or http://127.0.0.1:8787)
  --api-key <key>   Tenant admin key (default: AGIL_API_KEY)
  --json            Print the raw JSON response
  -h, --help        This help

Node heartbeat metrics:
  A heartbeat carries best-effort host stats under "metrics": cpuPercent,
  memoryPercent, load1, uptimeSec, version and reportedAt. bandwidthMbps and
  activeRooms/participants are included only when measurable locally (never
  faked). Collection errors never fail the heartbeat. Use --no-metrics to omit
  the metrics object entirely (e.g. when the CLI runs on a monitoring host).

Examples:
  AGIL_API_KEY=dev-key node agil/core/scripts/agil-cli.mjs token create --kind node --role sfu --features sfu,egress
  AGIL_NODE_TOKEN=agil_enr_... node agil/core/scripts/agil-cli.mjs nodes register --role sfu --id edge-1 --endpoint https://sfu-1.example:7880
  AGIL_NODE_KEY=nk_... node agil/core/scripts/agil-cli.mjs nodes heartbeat --id edge-1
`;

const ADMIN_PATHS = {
  tokens: '/v1/admin/cluster/tokens',
  token: (id) => `/v1/admin/cluster/tokens/${encodeURIComponent(id)}`,
  nodes: '/v1/admin/nodes',
  node: (id) => `/v1/admin/nodes/${encodeURIComponent(id)}`,
  rotateKey: (id) => `/v1/admin/nodes/${encodeURIComponent(id)}/rotate-key`,
  status: '/v1/admin/cluster/status',
};

function fail(message, code = 1) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

function usage(message) {
  if (message) process.stderr.write(`error: ${message}\n\n`);
  process.stderr.write(HELP);
  process.exit(2);
}

/** Minimal `--flag value` / `--flag=value` / `-h` parser (no dependencies). */
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      flags.help = 'true';
      continue;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const withoutPrefix = arg.slice(2);
    const equals = withoutPrefix.indexOf('=');
    if (equals >= 0) {
      flags[withoutPrefix.slice(0, equals)] = withoutPrefix.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[withoutPrefix] = 'true';
      continue;
    }
    flags[withoutPrefix] = next;
    index += 1;
  }
  return { positionals, flags };
}

function coreUrl(flags) {
  const raw = (flags.core ?? process.env.AGIL_CORE_URL ?? 'http://127.0.0.1:8787').trim();
  if (!raw) return 'http://127.0.0.1:8787';
  return raw.replace(/\/+$/, '');
}

function apiKey(flags) {
  const key = (flags['api-key'] ?? process.env.AGIL_API_KEY ?? '').trim();
  if (!key) usage('missing --api-key (or AGIL_API_KEY)');
  return key;
}

async function call(flags, method, path, { body, nodeToken, anonymous } = {}) {
  const url = `${coreUrl(flags)}${path}`;
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (nodeToken) headers['x-node-token'] = nodeToken;
  else if (!anonymous) headers['x-api-key'] = apiKey(flags);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    fail(`cannot reach ${coreUrl(flags)} (${error instanceof Error ? error.message : String(error)})`);
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const code = parsed?.error?.code ?? `http_${response.status}`;
    const message = parsed?.error?.message ?? text.slice(0, 300);
    fail(`${code}: ${message}`);
  }
  return parsed;
}

function splitList(value) {
  if (!value || value === 'true') return undefined;
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

function parseJsonFlag(flags, name) {
  const raw = flags[name] ?? process.env.AGIL_NODE_CAPACITY;
  if (!raw || raw === 'true') return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    usage(`--${name} must be a JSON object, e.g. '{"maxRooms":5}'`);
  }
}

function parsePositiveInt(value, name, fallback) {
  if (value === undefined || value === 'true') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) usage(`--${name} must be a positive number`);
  return Math.trunc(parsed);
}

function printTable(rows, columns) {
  if (rows.length === 0) {
    process.stdout.write('(empty)\n');
    return;
  }
  const widths = columns.map((column) =>
    Math.max(column.header.length, ...rows.map((row) => String(column.value(row) ?? '').length)),
  );
  const line = (values) => values.map((value, index) => String(value ?? '').padEnd(widths[index])).join('  ');
  process.stdout.write(`${line(columns.map((column) => column.header))}\n`);
  process.stdout.write(`${widths.map((width) => '-'.repeat(width)).join('  ')}\n`);
  for (const row of rows) process.stdout.write(`${line(columns.map((column) => column.value(row)))}\n`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Collect the host stats a node heartbeat may carry.
 *
 * The CLI is a one-shot process, so there is no previous `/proc` sample from an
 * earlier run: take two samples a short moment apart to get a real CPU delta.
 * NIC bandwidth is intentionally not sampled here — a ~250 ms window would be
 * noise, not a heartbeat-interval rate, so the field is omitted (never faked).
 * Any failure returns `undefined`; the heartbeat is still sent without metrics.
 */
async function collectHeartbeatMetrics() {
  try {
    const collector = createMetricsCollector({
      version: CLI_VERSION,
      processStartedAt: PROCESS_STARTED_AT,
      collectNetwork: false,
    });
    const first = await collector.collect();
    await sleep(METRICS_SAMPLE_MS);
    const second = await collector.collect();
    return normalizeNodeMetrics({ ...first, ...second });
  } catch {
    return undefined;
  }
}

function tokenStatusLabel(token) {
  return token.status;
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

async function tokenCreate(flags) {
  const kind = flags.kind;
  if (kind !== 'core' && kind !== 'node') usage('token create --kind <core|node> is required');
  const body = { kind };
  if (flags.role) body.role = flags.role;
  const features = splitList(flags.features);
  if (features) body.features = features;
  if (flags.ttl !== undefined) body.ttlSec = parsePositiveInt(flags.ttl, 'ttl');
  if (flags.uses !== undefined) body.uses = parsePositiveInt(flags.uses, 'uses');
  if (flags.label && flags.label !== 'true') body.label = flags.label;
  const created = await call(flags, 'POST', ADMIN_PATHS.tokens, { body });
  if (flags.json === 'true') {
    printJson(created);
    return;
  }
  process.stdout.write(`Enrollment token (${created.enrollment.kind}/${created.enrollment.role}) — shown once:\n`);
  process.stdout.write(`${created.token}\n\n`);
  process.stdout.write(`id:         ${created.enrollment.id}\n`);
  process.stdout.write(`uses:       ${created.enrollment.uses}\n`);
  process.stdout.write(`expiresAt:  ${new Date(created.enrollment.expiresAt).toISOString()}\n`);
  process.stdout.write(`features:   ${created.enrollment.features.join(', ') || '—'}\n`);
  process.stdout.write('\nStore it as a secret (CI/secret store), never in a repository.\n');
}

async function tokenList(flags) {
  const data = await call(flags, 'GET', ADMIN_PATHS.tokens);
  if (flags.json === 'true') {
    printJson(data);
    return;
  }
  printTable(data.tokens, [
    { header: 'ID', value: (token) => token.id },
    { header: 'KIND', value: (token) => token.kind },
    { header: 'ROLE', value: (token) => token.role },
    { header: 'FEATURES', value: (token) => token.features.join(',') || '—' },
    { header: 'STATUS', value: tokenStatusLabel },
    { header: 'USES', value: (token) => `${token.remainingUses}/${token.uses}` },
    { header: 'EXPIRES', value: (token) => new Date(token.expiresAt).toISOString() },
    { header: 'CREATED BY', value: (token) => token.createdBy },
    { header: 'LABEL', value: (token) => token.label || '—' },
  ]);
}

async function tokenRevoke(flags, positionals) {
  const id = positionals[2] ?? flags.id;
  if (!id || id === 'true') usage('token revoke <tokenId> is required');
  const result = await call(flags, 'DELETE', ADMIN_PATHS.token(id));
  if (flags.json === 'true') {
    printJson(result);
    return;
  }
  process.stdout.write(`Token ${result.id} revoked.\n`);
}

async function nodesList(flags) {
  const query = new URLSearchParams();
  if (flags.role && flags.role !== 'true') query.set('role', flags.role);
  if (flags.status && flags.status !== 'true') query.set('status', flags.status);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const data = await call(flags, 'GET', `${ADMIN_PATHS.nodes}${suffix}`);
  if (flags.json === 'true') {
    printJson(data);
    return;
  }
  printTable(data.nodes, [
    { header: 'ID', value: (node) => node.id },
    { header: 'NAME', value: (node) => node.name || '—' },
    { header: 'ROLE', value: (node) => node.role },
    { header: 'STATUS', value: (node) => node.status },
    { header: 'FEATURES', value: (node) => node.features.join(',') || '—' },
    {
      header: 'CAPACITY',
      value: (node) => `rooms=${node.capacity.maxRooms} participants=${node.capacity.maxParticipants}`,
    },
    { header: 'DRAIN', value: (node) => (node.drain ? 'yes' : 'no') },
    { header: 'LAST SEEN', value: (node) => (node.lastSeenAt ? new Date(node.lastSeenAt).toISOString() : '—') },
  ]);
}

async function nodesRegister(flags) {
  const token = (flags.token ?? process.env.AGIL_NODE_TOKEN ?? '').trim();
  if (!token) usage('nodes register requires --token (or AGIL_NODE_TOKEN)');
  const role = (flags.role ?? process.env.AGIL_NODE_ROLE ?? 'all').trim();
  const body = { token, role };
  const nodeId = (flags.id ?? process.env.AGIL_NODE_ID ?? '').trim();
  if (nodeId) body.nodeId = nodeId;
  const name = (flags.name ?? process.env.AGIL_NODE_NAME ?? '').trim();
  if (name) body.name = name;
  const features = splitList(flags.features ?? process.env.AGIL_NODE_FEATURES);
  if (features) body.features = features;
  const capacity = parseJsonFlag(flags, 'capacity');
  if (capacity) body.capacity = capacity;
  const endpoint = (flags.endpoint ?? process.env.AGIL_NODE_ENDPOINT ?? '').trim();
  if (endpoint) body.endpoint = endpoint;
  const region = (flags.region ?? process.env.AGIL_NODE_REGION ?? '').trim();
  if (region) body.region = region;
  const version = (flags.version ?? '').trim();
  if (version) body.version = version;
  if (flags.ttl !== undefined && flags.ttl !== 'true') body.keyTtlSec = parsePositiveInt(flags.ttl, 'ttl');
  const result = await call(flags, 'POST', '/v1/nodes/register', { body, anonymous: true });
  if (flags.json === 'true') {
    printJson(result);
    return;
  }
  process.stdout.write(`Node registered: ${result.node.id} (${result.node.role}, ${result.node.status})\n`);
  process.stdout.write(`cluster: ${result.cluster.id} (${result.cluster.role}, v${result.cluster.version})\n`);
  process.stdout.write(`heartbeat every ${result.heartbeatIntervalSec}s; endpoint ${result.node.endpoint || '—'}\n`);
  if (result.keyExpiresAt) {
    process.stdout.write(`node key expires: ${new Date(result.keyExpiresAt).toISOString()}\n`);
  }
  process.stdout.write(`\nNode key shown once — store it as a secret:\n${result.nodeKey}\n`);
}

async function nodesHeartbeat(flags) {
  const id = (flags.id ?? process.env.AGIL_NODE_ID ?? '').trim();
  if (!id) usage('nodes heartbeat requires --id (or AGIL_NODE_ID)');
  const key = (flags.key ?? process.env.AGIL_NODE_KEY ?? '').trim();
  if (!key) usage('nodes heartbeat requires --key (or AGIL_NODE_KEY)');
  const body = {};
  const capacity = parseJsonFlag(flags, 'capacity');
  if (capacity) body.capacity = capacity;
  if (flags.status === 'offline') body.status = 'offline';
  // Metrics are on by default (the CLI normally runs on the node itself); an
  // explicit --no-metrics / --metrics=false keeps the old body for hosts where
  // local stats are meaningless.
  const metricsDisabled = flags['no-metrics'] === 'true' || flags.metrics === 'false' || flags.metrics === 'off';
  if (!metricsDisabled) {
    const metrics = await collectHeartbeatMetrics();
    if (metrics) body.metrics = metrics;
  }
  const result = await call(flags, 'POST', `/v1/nodes/${encodeURIComponent(id)}/heartbeat`, { body, nodeToken: key });
  if (flags.json === 'true') {
    printJson(result);
    return;
  }
  process.stdout.write(
    `Heartbeat ok: ${result.node.id} (${result.node.status}${result.drain ? ', draining' : ''}) at ${new Date(result.serverTime).toISOString()}\n`,
  );
}

async function nodesRotateKey(flags, positionals) {
  const id = positionals[2] ?? flags.id;
  if (!id || id === 'true') usage('nodes rotate-key <nodeId> is required');
  const body = {};
  if (flags.ttl !== undefined && flags.ttl !== 'true') body.keyTtlSec = parsePositiveInt(flags.ttl, 'ttl');
  const result = await call(flags, 'POST', ADMIN_PATHS.rotateKey(id), { body });
  if (flags.json === 'true') {
    printJson(result);
    return;
  }
  process.stdout.write(`Node key rotated: ${result.node.id} (shown once; the old key no longer works)\n`);
  if (result.keyExpiresAt) {
    process.stdout.write(`expiresAt: ${new Date(result.keyExpiresAt).toISOString()}\n`);
  }
  process.stdout.write(`${result.nodeKey}\n`);
}

async function clusterStatus(flags) {
  const status = await call(flags, 'GET', ADMIN_PATHS.status);
  if (flags.json === 'true') {
    printJson(status);
    return;
  }
  process.stdout.write(`Cluster: ${status.cluster?.id ?? '—'} (${status.cluster?.role ?? '—'}, v${status.cluster?.version ?? '—'})\n`);
  if (status.leader) {
    const heartbeat = status.leader.heartbeatAt ? ` · heartbeat ${new Date(status.leader.heartbeatAt).toISOString()}` : '';
    const self = status.leader.self ? ' (this Core)' : '';
    process.stdout.write(`Leader: ${status.leader.id ?? '—'}${self}${heartbeat}\n`);
  }
  if (status.lease) {
    const lease = status.lease;
    const ttl =
      lease.ttlRemainingMs === null || lease.ttlRemainingMs === undefined
        ? '—'
        : `${Math.round(lease.ttlRemainingMs / 1000)}s / ${Math.round((lease.ttlMs ?? 0) / 1000)}s`;
    const validUntil = lease.validUntil ? ` · validUntil ${new Date(lease.validUntil).toISOString()}` : '';
    process.stdout.write(
      `Lease: ${lease.mode} · held=${lease.held} · ttl ${ttl} · redis ${lease.redisConnected ? 'up' : 'down'} · renewFailures ${lease.renewalFailures}${validUntil}\n`,
    );
    process.stdout.write(`  reason: ${lease.reason}\n`);
  }
  if (status.failover?.detected) {
    const at = status.failover.changedAt ? new Date(status.failover.changedAt).toISOString() : '—';
    process.stdout.write(`Failover: from ${status.failover.previousLeaderId ?? '—'} at ${at}\n`);
    process.stdout.write(`  ${status.failover.message}\n`);
  }
  if (status.counts) {
    process.stdout.write(
      `Nodes: ${status.counts.nodes} (online ${status.counts.online}, draining ${status.counts.draining}, disabled ${status.counts.disabled}, offline ${status.counts.offline}) · standbys ${status.counts.standbys}\n`,
    );
  }
  process.stdout.write(`Legacy nodeId: ${status.nodeId} · multiNodeActive: ${status.multiNodeActive}\n`);
  if (Array.isArray(status.limitations) && status.limitations.length > 0) {
    process.stdout.write('\nLimitations:\n');
    for (const limitation of status.limitations) process.stdout.write(`  - ${limitation}\n`);
  }
}

/* ------------------------------------------------------------------ */
/* Entry                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  if (flags.help === 'true' || positionals.length === 0) {
    process.stdout.write(HELP);
    return;
  }
  const [group, command] = positionals;
  if (group === 'token') {
    if (command === 'create') return tokenCreate(flags);
    if (command === 'list') return tokenList(flags);
    if (command === 'revoke') return tokenRevoke(flags, positionals);
    usage(`unknown token command: ${command ?? '(none)'}`);
  }
  if (group === 'nodes') {
    if (command === 'list') return nodesList(flags);
    if (command === 'register') return nodesRegister(flags);
    if (command === 'heartbeat') return nodesHeartbeat(flags);
    if (command === 'rotate-key') return nodesRotateKey(flags, positionals);
    usage(`unknown nodes command: ${command ?? '(none)'}`);
  }
  if (group === 'cluster' && command === 'status') return clusterStatus(flags);
  usage(`unknown command: ${positionals.join(' ')}`);
}

main().catch((error) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
