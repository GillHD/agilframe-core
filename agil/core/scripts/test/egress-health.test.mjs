/**
 * Regression tests for scripts/egress-health.mjs.
 *
 * Covers the P1-5 secret leak (Redis URL password in normal and --json
 * output), the P3-1 --dry-run flag, P2-5 `--redis-ca` PEM reading, P2-6
 * `null` from `lk egress list`, and generic (non-echoing) CLI errors.
 *
 * The `lk` fixture is a tiny extensionless Node script executed as
 * `node egress list ...`: health is invoked with `--lk=node` and a temporary
 * working directory. This works on Windows and POSIX without a real lk binary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCRIPT = path.join(ROOT, 'agil', 'core', 'scripts', 'egress-health.mjs');
const SKIP = ['--skip-redis', '--skip-app', '--skip-config', '--skip-out'];

function run(args, { env = {}, cwd = ROOT } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function makeLkFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'egress-health-lk-'));
  writeFileSync(
    path.join(dir, 'egress'),
    [
      "const args = process.argv.slice(2);",
      "if (args.includes('--version')) { console.log('fake-lk 1.0'); process.exit(0); }",
      "process.stdout.write(process.env.FAKE_LK_OUTPUT ?? 'null');",
      "if (process.env.FAKE_LK_ERR) process.stderr.write(process.env.FAKE_LK_ERR);",
      'process.exit(Number(process.env.FAKE_LK_EXIT || 0));',
      '',
    ].join('\n'),
    'utf8',
  );
  return dir;
}

test('--json and normal output never contain a Redis URL password (P1-5)', () => {
  const canary = 'QA_REDIS_CANARY_123456';
  const args = [`--redis=rediss://:${canary}@127.0.0.1:1`, ...SKIP];
  const normal = run(args);
  const json = run([...args, '--json']);

  for (const result of [normal, json]) {
    assert.ok(!result.stdout.includes(canary), 'canary leaked to stdout');
    assert.ok(!result.stderr.includes(canary), 'canary leaked to stderr');
  }
  assert.match(normal.stdout, /Redis:\s+rediss:\/\/127\.0\.0\.1:1 \(TLS\)/);
  const summary = JSON.parse(json.stdout);
  assert.equal(summary.redis, 'rediss://127.0.0.1:1 (TLS)');
  assert.equal(summary.ok, false, 'closed port is expected to fail the Redis check');
});

test('environment secret canaries never reach stdout/stderr or --json', () => {
  const canaries = {
    EGRESS_SMOKE_TOKEN: 'QA_TOKEN_CANARY_123456',
    LIVEKIT_API_SECRET: 'QA_LIVEKIT_SECRET_CANARY_123456',
    AGIL_ADMIN_KEY: 'QA_ADMIN_CANARY_123456',
    EGRESS_S3_SECRET_KEY: 'QA_S3_SECRET_CANARY_123456',
    AGIL_APP_URL: 'https://user:QA_APP_CANARY_123456@example.test/app',
    AGIL_EGRESS_URL: 'https://user:QA_SFU_CANARY_123456@sfu.example.test',
  };
  const args = [
    '--redis=127.0.0.1:1',
    '--kind=rtmp',
    '--rtmp-url=rtmp://live.example/app/QA_RTMP_CANARY_123456',
    '--json',
    ...SKIP,
  ];
  const result = run(args, { env: canaries });
  for (const canary of [...Object.values(canaries), 'QA_RTMP_CANARY_123456']) {
    assert.ok(!result.stdout.includes(canary), `canary leaked to stdout: ${canary}`);
    assert.ok(!result.stderr.includes(canary), `canary leaked to stderr: ${canary}`);
  }
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, false, 'the closed Redis port fails the read-only check');
  assert.ok(!JSON.stringify(summary).includes('QA_'), 'no QA_* canary in JSON');
});

test('--dry-run overrides --run and is accepted (P3-1)', () => {
  const result = run(['--run', '--dry-run', '--redis=127.0.0.1:1', ...SKIP]);
  assert.match(result.stdout, /Mode:\s+health, smoke dry-run \(--dry-run\)/);
  assert.doesNotMatch(result.stdout, /unknown flag/);
});

test('--kind is validated in dry-run before building a plan (P3-2)', () => {
  const result = run(['--dry-run', '--kind=bogus', '--redis=127.0.0.1:1', ...SKIP]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /unsupported --kind=bogus/);
  assert.doesNotMatch(result.stdout, /\[PLAN\]/);
});

test('--redis-ca reads a PEM path and reports a clean error when unreadable (P2-5)', () => {
  const missing = path.join(tmpdir(), 'qa-missing-ca-do-not-create.pem');
  const args = ['--redis=rediss://127.0.0.1:1', '--skip-lk', '--skip-app', '--skip-config', '--skip-out'];
  const result = run([...args, `--redis-ca=${missing}`]);
  assert.match(result.stdout, /cannot read --redis-ca PEM file \(path redacted/);
  assert.ok(!result.stdout.includes(missing), 'CA path was echoed');

  const dir = mkdtempSync(path.join(tmpdir(), 'egress-health-ca-'));
  try {
    const pem = path.join(dir, 'ca.pem');
    writeFileSync(pem, '-----BEGIN CERTIFICATE-----\nQA_NOT_A_REAL_CERT\n-----END CERTIFICATE-----\n', 'utf8');
    const withPem = run([...args, `--redis-ca=${pem}`]);
    assert.doesNotMatch(withPem.stdout, /cannot read --redis-ca PEM file/);
    assert.match(withPem.stdout, /ECONNREFUSED|Redis connect timed out/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lk egress list: explicit null is empty only without a no-worker error (P2-6)', () => {
  const cwd = makeLkFixture();
  const env = {
    LIVEKIT_API_KEY: 'lk-key',
    LIVEKIT_API_SECRET: 'lk-secret',
    FAKE_LK_OUTPUT: 'null',
    FAKE_LK_ERR: 'no response from egress service',
  };
  const args = ['--lk=node', '--url=https://sfu.example', '--json', ...SKIP];
  try {
    const failed = run(args, { cwd, env });
    const failedSummary = JSON.parse(failed.stdout);
    assert.equal(failedSummary.ok, false);
    assert.ok(failedSummary.failures.some((entry) => entry.includes('no worker is subscribed')));

    const empty = run(args, { cwd, env: { ...env, FAKE_LK_ERR: '' } });
    const emptySummary = JSON.parse(empty.stdout);
    assert.equal(emptySummary.ok, true, JSON.stringify(emptySummary));
    assert.ok(emptySummary.checks.some((entry) => entry.name === 'lk egress list' && entry.status === 'PASS'));

    const list = run(args, { cwd, env: { ...env, FAKE_LK_OUTPUT: '[]', FAKE_LK_ERR: '' } });
    assert.equal(JSON.parse(list.stdout).ok, true);

    const garbage = run(args, { cwd, env: { ...env, FAKE_LK_OUTPUT: 'not-json', FAKE_LK_ERR: '' } });
    const garbageSummary = JSON.parse(garbage.stdout);
    assert.equal(garbageSummary.ok, true);
    assert.ok(garbageSummary.warnings.some((entry) => entry.includes('not JSON')));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('unknown flags are rejected without echoing their value (P3-3)', () => {
  const result = run(['--QA_SECRET_CANARY_123456=value', ...SKIP]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown flag/);
  assert.ok(!result.stderr.includes('QA_SECRET_CANARY'));
});
