/**
 * `agil-cli.mjs nodes heartbeat` metrics tests.
 *
 * Spawns the real CLI against a tiny fake Core, so the test covers argument
 * parsing, the collection hook and the exact JSON body Core receives. Fake
 * `/proc` values are covered by `node-metrics`-module tests (`test/node-metrics.test.mjs`);
 * here the point is the heartbeat contract and `--no-metrics` opt-out.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const CLI = path.resolve(fileURLToPath(new URL('../agil-cli.mjs', import.meta.url)));
const NODE_KEY = 'nk_cli_metrics_test_key_0123456789';

function startFakeCore() {
  const heartbeats = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = { __invalid: raw };
      }
      const status = req.url === '/v1/nodes/cli-node/heartbeat' ? 200 : 404;
      if (status === 200) heartbeats.push({ headers: req.headers, body });
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          status === 200
            ? {
                node: { id: 'cli-node', status: body.status ?? 'online' },
                drain: false,
                heartbeatIntervalSec: 30,
                serverTime: Date.now(),
              }
            : { error: { code: 'not_found', message: 'no route' } },
        ),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        heartbeats,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function runCli(args, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI did not exit within ${timeoutMs} ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    timer.unref?.();
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('nodes heartbeat: attaches best-effort host metrics by default', async () => {
  const fake = await startFakeCore();
  try {
    const result = await runCli(['nodes', 'heartbeat', '--id', 'cli-node', '--key', NODE_KEY, '--core', fake.url, '--json']);
    assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(fake.heartbeats.length, 1);
    const { headers, body } = fake.heartbeats[0];
    assert.equal(headers['x-node-token'], NODE_KEY);
    // The CLI only sends `status` when explicitly reporting offline; online is
    // the server default, so the body may omit it.
    assert.ok(!('status' in body) || body.status === 'online');
    assert.ok(body.metrics, 'heartbeat body must contain metrics');
    assert.equal(typeof body.metrics.reportedAt, 'number');
    assert.equal(body.metrics.version, '0.1.0');
    assert.equal(typeof body.metrics.uptimeSec, 'number');
    assert.ok(!('activeRooms' in body.metrics), 'room stats are not local to the CLI');
    assert.ok(!('participants' in body.metrics));
    // The node key authenticates the request; it must never be echoed into metrics.
    assert.ok(!JSON.stringify(body.metrics).includes(NODE_KEY));
    if (body.metrics.cpuPercent !== undefined) {
      assert.ok(body.metrics.cpuPercent >= 0 && body.metrics.cpuPercent <= 100);
    }
  } finally {
    await fake.close();
  }
});

test('nodes heartbeat --no-metrics: keeps the legacy body without a metrics object', async () => {
  const fake = await startFakeCore();
  try {
    const result = await runCli([
      'nodes', 'heartbeat', '--id', 'cli-node', '--key', NODE_KEY, '--core', fake.url, '--no-metrics', '--json',
    ]);
    assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(fake.heartbeats.length, 1);
    assert.ok(!('metrics' in fake.heartbeats[0].body), '--no-metrics must omit the object entirely');
    assert.ok(!('status' in fake.heartbeats[0].body) || fake.heartbeats[0].body.status === 'online');
  } finally {
    await fake.close();
  }
});
