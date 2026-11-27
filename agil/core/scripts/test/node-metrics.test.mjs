/**
 * CLI metrics-module tests.
 *
 * `agil/core/scripts/lib/node-metrics.mjs` is the copy used by
 * `agil-cli.mjs nodes heartbeat` (the `agil/core/scripts` directory is the part
 * shipped in the production image). It mirrors the node-agent collector; these
 * tests pin the fake-/proc behaviour of this copy so it cannot silently drift.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createMetricsCollector, normalizeNodeMetrics, parseNetDev, parseProcStat } from '../lib/node-metrics.mjs';

const LIB_MODULE = fileURLToPath(new URL('../lib/node-metrics.mjs', import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(LIB_MODULE), '..', '..', '..', '..');

function fakeProc(files) {
  return async (name) => {
    const key = name.replace(/\\/g, '/');
    if (!Object.prototype.hasOwnProperty.call(files, key)) {
      const error = new Error(`ENOENT: /proc/${key}`);
      error.code = 'ENOENT';
      throw error;
    }
    return files[key];
  };
}

test('CLI metrics copy: /proc/stat delta and /proc/net/dev delta', async () => {
  assert.deepEqual(parseProcStat('cpu  50 0 50 400\n'), { total: 500, idle: 400 });
  assert.deepEqual(parseNetDev(' lo: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\n eth0: 10 1 0 0 0 0 0 0 20 1 0 0 0 0 0 0\n'), { bytes: 30 });

  let clock = 5_000;
  const files = {
    stat: 'cpu  100 0 100 800\n',
    meminfo: 'MemTotal: 1000 kB\nMemAvailable: 250 kB\n',
    loadavg: '0.5 0.4 0.3 1/1 1\n',
    uptime: '100.0 0\n',
    'net/dev': ' eth0: 0 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0\n',
  };
  const collector = createMetricsCollector({
    version: '0.1.0',
    now: () => clock,
    readProcFile: fakeProc(files),
    platform: 'linux',
  });
  const first = await collector.collect();
  assert.equal(first.cpuPercent, undefined, 'first sample has no CPU baseline');
  assert.equal(first.memoryPercent, 75);

  clock = 6_000;
  files.stat = 'cpu  200 0 200 1600\n'; // +1000 total, +800 idle -> 20 %
  files['net/dev'] = ' eth0: 250000 1 0 0 0 0 0 0 250000 1 0 0 0 0 0 0\n'; // +500 000 B/s
  const second = await collector.collect();
  assert.equal(second.cpuPercent, 20);
  assert.equal(second.bandwidthMbps, 4);
});

test('CLI metrics copy stays byte-identical to the node-agent collector copies', async () => {
  const [cliCopy, referenceCopy, imageCopy] = await Promise.all([
    readFile(LIB_MODULE, 'utf8'),
    readFile(path.join(REPO_ROOT, 'agil', 'infra', 'node-agent', 'metrics.mjs'), 'utf8'),
    readFile(path.join(REPO_ROOT, 'agil', 'core', 'nodes', 'all-in-one', 'agent', 'metrics.mjs'), 'utf8'),
  ]);
  // Each build context is self-contained (core image, node-agent image, node
  // image), so the collector is duplicated on purpose. This test makes drift
  // between the copies a test failure instead of a runtime surprise.
  assert.equal(cliCopy, imageCopy, 'CLI copy differs from agil/core/nodes/all-in-one/agent/metrics.mjs');
  assert.equal(referenceCopy, imageCopy, 'reference-agent copy differs from the all-in-one copy');
});

test('CLI metrics copy: normalize keeps the heartbeat contract shape', () => {
  assert.deepEqual(
    normalizeNodeMetrics({
      cpuPercent: 12.5,
      memoryPercent: 43,
      load1: 0.42,
      activeRooms: 3,
      participants: 17,
      bandwidthMbps: 12.5,
      uptimeSec: 86400,
      version: '0.1.0',
      reportedAt: 1_732_230_000_000,
      extra: 'dropped',
    }),
    {
      cpuPercent: 12.5,
      memoryPercent: 43,
      load1: 0.42,
      bandwidthMbps: 12.5,
      activeRooms: 3,
      participants: 17,
      uptimeSec: 86400,
      version: '0.1.0',
      reportedAt: 1_732_230_000_000,
    },
  );
  assert.equal(normalizeNodeMetrics({ cpuPercent: Number.POSITIVE_INFINITY }), undefined);
});
