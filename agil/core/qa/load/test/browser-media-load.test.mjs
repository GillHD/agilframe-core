/**
 * Regression tests for the browser media load harness.
 *
 * Covers argument parsing/validation, the no-browser/no-network --dry-run
 * path, plan math (200 users, browser sharding, synthetic WS overlap), secret
 * redaction, and the JSON+Markdown report writer. No real browser, API or
 * deployment is used here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_BASE_URL,
  MAX_BROWSER_USERS,
  UsageError,
  buildPlan,
  parseArgs,
  parseDuration,
  redactSecrets,
  renderSummaryMarkdown,
  splitPages,
  writeReports,
} from '../browser-media-load.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const SCRIPT = path.join(ROOT, 'agil', 'core', 'qa', 'load', 'browser-media-load.mjs');

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, AGIL_ADMIN_KEY: '', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function fakeReport() {
  return {
    tool: 'browser-media-load',
    version: 1,
    generatedAt: '2026-11-17T07:00:00.000Z',
    runId: '2026-11-17T07-00-00-000Z',
    target: 'https://pilot.example',
    config: {
      users: 50,
      durationSec: 60,
      concurrency: 10,
      browsers: 1,
      tenant: 'demo',
      theme: 'light',
      headless: true,
      joinTimeoutSec: 180,
      pollMs: 2000,
      maxErrors: 0,
      keepRoom: false,
      syntheticWsUsers: 200,
      wsHoldSec: 360,
      chromePath: 'C:\\Chrome\\chrome.exe',
      outDir: 'reports',
    },
    room: { id: 'room-TEST', maxParticipants: 60, maxParticipantsRequested: 60, deleted: true, kept: false },
    health: {},
    tokens: { requested: 50, issued: 50, failed: 0, latencyMs: { min: 100, avg: 150, p95: 180, max: 200 } },
    browser: {
      processes: 1,
      pagesLaunched: 50,
      pagesJoined: 50,
      expectedTilesPerPage: 2,
      stabilizedMs: 35_000,
      elapsedMs: 95_000,
      tiles: { min: 36, max: 37, avg: 36.5, total: 1825 },
      videos: { min: 2, max: 2, avg: 2, total: 100 },
      playing: { min: 2, max: 2, avg: 2, total: 100, pagesWithPlaying: 50, pagesWithTwoPlaying: 50 },
      remotePlaying: { min: 1, max: 1, avg: 1, total: 50, pagesWithRemotePlaying: 50 },
      errorCount: 0,
      pageErrors: 0,
      consoleErrors: 0,
      errors: [],
      pages: [],
      timeline: [],
      steady: [],
      final: null,
    },
    syntheticWs: {
      users: 200,
      exitCode: 0,
      ok: true,
      reportPath: 'reports/synthetic-ws-200.json',
      summary: {
        sockets: { welcome: 200, errors: [] },
        presence: [{ phase: 'joined', welcome: 200 }, { phase: 'steady', welcome: 200 }],
      },
      stderrTail: '',
    },
    combined: { browserPages: 50, syntheticWsUsers: 200, totalSessions: 250, concurrent: true },
    cleanup: { roomDeletion: { attempted: true, status: 200, deleted: true, verified: true } },
    verdict: { ok: true, reasons: [] },
    fatalError: null,
  };
}

test('defaults match the validated 50-browser profile', () => {
  const config = parseArgs([], {});
  assert.equal(config.users, 50);
  assert.equal(config.durationSec, 60);
  assert.equal(config.concurrency, 10);
  assert.equal(config.browsers, 1);
  assert.equal(config.syntheticWs, 0);
  assert.equal(config.dryRun, false);
  assert.equal(config.baseUrl, DEFAULT_BASE_URL);
  assert.equal(config.theme, 'light');
  assert.equal(config.maxErrors, 0);
});

test('parses the 200-user + 200-WS + 4-browser dry-run shape', () => {
  const config = parseArgs(
    ['--users=200', '--duration=2m', '--concurrency=8', '--browsers=4', '--synthetic-ws', '--dry-run', '--poll-ms=1000'],
    {},
  );
  assert.equal(config.users, 200);
  assert.equal(config.durationSec, 120);
  assert.equal(config.concurrency, 8);
  assert.equal(config.browsers, 4);
  assert.equal(config.syntheticWs, 200);
  assert.equal(config.dryRun, true);
  assert.equal(config.pollMs, 1000);
});

test('supports space-separated values and bare/empty --synthetic-ws', () => {
  assert.equal(parseArgs(['--users', '25', '--duration', '90s'], {}).users, 25);
  assert.equal(parseArgs(['--users', '25', '--duration', '90s'], {}).durationSec, 90);
  assert.equal(parseArgs(['--synthetic-ws'], {}).syntheticWs, 200);
  assert.equal(parseArgs(['--synthetic-ws', '200'], {}).syntheticWs, 200);
  assert.equal(parseArgs(['--synthetic-ws', '--dry-run'], {}).syntheticWs, 200);
  assert.equal(parseArgs(['--synthetic-ws=0'], {}).syntheticWs, 0);
});

test('duration parser accepts seconds/minutes/hours and rejects garbage', () => {
  assert.equal(parseDuration('60'), 60);
  assert.equal(parseDuration('30s'), 30);
  assert.equal(parseDuration('2m'), 120);
  assert.equal(parseDuration('1.5h'), 5400);
  assert.equal(parseDuration('0'), 0);
  assert.throws(() => parseDuration('5x'), UsageError);
  assert.throws(() => parseDuration('-1'), UsageError);
});

test('rejects invalid user counts, browsers and unknown flags', () => {
  for (const args of [
    ['--users=0'],
    ['--users=201'],
    [`--users=${MAX_BROWSER_USERS + 1}`],
    ['--users=abc'],
    ['--users=-1'],
    ['--users'],
    ['--users=2', '--browsers=3'],
    ['--concurrency=0'],
    ['--duration=5x'],
    ['--theme=blue'],
    ['--base=https://pilot.example/path'],
    ['--base=ftp://pilot.example'],
    ['--max-errors=-1'],
    ['--nope=1'],
    ['positional'],
  ]) {
    assert.throws(() => parseArgs(args, {}), UsageError, `expected UsageError for ${args.join(' ')}`);
  }
  assert.throws(() => parseArgs(['--users=10', '--synthetic-ws', '--ws-hold=1s'], {}), UsageError);
});

test('--base overrides an invalid BASE_URL environment value', () => {
  const config = parseArgs(['--base=https://pilot.example/'], { BASE_URL: 'not a url' });
  assert.equal(config.baseUrl, 'https://pilot.example');
});

test('plan shards 200 pages across 4 Chrome processes and combines WS sessions', () => {
  const config = parseArgs(
    ['--users=200', '--browsers=4', '--synthetic-ws=50', '--duration=60s', '--dry-run'],
    {},
  );
  const plan = buildPlan(config, { env: { AGIL_ADMIN_KEY: 'canary' } });
  assert.deepEqual(plan.plan.browser.pagesPerBrowser, [50, 50, 50, 50]);
  assert.equal(plan.plan.browser.pages, 200);
  assert.equal(plan.plan.combinedSessions, 250);
  assert.equal(plan.plan.syntheticWs.users, 50);
  assert.equal(plan.plan.syntheticWs.stdinStop, true);
  assert.ok(plan.plan.syntheticWs.argv.includes('--stdin-stop'));
  assert.ok(plan.plan.syntheticWs.argv.includes('--out=' + plan.plan.syntheticWs.reportPath));
  assert.equal(plan.plan.willLaunchBrowser, false);
  assert.equal(plan.plan.willCreateRoom, false);
  assert.equal(plan.plan.willDeleteRoom, false);
});

test('plan combines 50 browser pages with 200 synthetic WS participants', () => {
  const config = parseArgs(['--users=50', '--synthetic-ws=200', '--dry-run'], {});
  const plan = buildPlan(config, { env: { AGIL_ADMIN_KEY: 'canary' } });
  assert.equal(plan.plan.browser.pages, 50);
  assert.equal(plan.plan.browser.processes, 1);
  assert.equal(plan.plan.syntheticWs.users, 200);
  assert.equal(plan.plan.combinedSessions, 250);
});

test('plan warns for 200 pages in one browser and does not leak secrets', () => {
  const config = parseArgs(['--users=200', '--dry-run'], {});
  const plan = buildPlan(config, { env: { AGIL_ADMIN_KEY: 'QA_ADMIN_CANARY_123456' } });
  const serialized = JSON.stringify(plan);
  assert.ok(plan.warnings.some((warning) => /50-context/.test(warning)));
  assert.ok(!serialized.includes('QA_ADMIN_CANARY_123456'));
});

test('--dry-run prints a JSON plan without a key, browser, network or output dir', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'media-load-dry-'));
  const out = path.join(root, 'does-not-exist');
  try {
    const result = runCli(['--dry-run', '--users=200', '--browsers=4', '--synthetic-ws=50', `--out=${out}`]);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.plan.browser.pages, 200);
    assert.equal(plan.plan.browser.processes, 4);
    assert.deepEqual(plan.plan.browser.pagesPerBrowser, [50, 50, 50, 50]);
    assert.equal(plan.plan.syntheticWs.users, 50);
    assert.equal(plan.plan.combinedSessions, 250);
    assert.equal(plan.plan.willLaunchBrowser, false);
    assert.ok(!existsSync(out), 'dry-run must not create the report directory');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--dry-run never prints AGIL_ADMIN_KEY', () => {
  const canary = 'QA_ADMIN_CANARY_987654';
  const result = runCli(['--dry-run', '--users=50'], { AGIL_ADMIN_KEY: canary });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(canary), 'admin key leaked to stdout');
  assert.ok(!result.stderr.includes(canary), 'admin key leaked to stderr');
});

test('--help exits 0 and documents the main flags', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--users=N/);
  assert.match(result.stdout, /--synthetic-ws/);
  assert.match(result.stdout, /--dry-run/);
});

test('invalid CLI arguments exit 2 with a readable message', () => {
  const result = runCli(['--users=201']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--users must be between 1 and 200/);
  assert.doesNotMatch(result.stderr, /\n\s+at /, 'usage errors must not print a stack trace');
});

test('redacts token query params, bearer tokens and known secrets', () => {
  const text = redactSecrets(
    'https://pilot/embed.html?room=r1&token=SECRET_TOKEN_123&theme=light x-api-key: ADMIN_KEY_123 Authorization: Bearer BEARER_123',
    ['SECRET_TOKEN_123', 'ADMIN_KEY_123', 'BEARER_123'],
  );
  assert.ok(!text.includes('SECRET_TOKEN_123'));
  assert.ok(!text.includes('ADMIN_KEY_123'));
  assert.ok(!text.includes('BEARER_123'));
  assert.match(text, /token=\[redacted\]/);
});

test('splitPages distributes remainders deterministically', () => {
  assert.deepEqual(splitPages(50, 1), [50]);
  assert.deepEqual(splitPages(200, 4), [50, 50, 50, 50]);
  assert.deepEqual(splitPages(10, 3), [4, 3, 3]);
});

test('Markdown summary reports remote playback separately from the local preview', () => {
  const report = fakeReport();
  report.browser.mediaStages = { sfuConnected: 47, sfuExpected: 50, rtcMeasured: 46, sendingVideo: 44, receivingVideo: 42, decodingVideo: 39 };
  const markdown = renderSummaryMarkdown(report);
  assert.match(markdown, /50\/50/);
  assert.match(markdown, /Pages with a playing remote video \| 50\/50/);
  assert.match(markdown, /remote playback is counted separately from the local preview/i);
  assert.match(markdown, /SFU connected \| 47\/50/);
  assert.match(markdown, /Pages with RTC stats \| 46\/50/);
  assert.match(markdown, /video RTP sent \/ received \/ decoded \| 44 \/ 42 \/ 39/);
  assert.match(markdown, /Synthetic WebSocket phase/);
  assert.match(markdown, /200\/200/);
});

test('browser-only summary omits the synthetic WS section', () => {
  const report = fakeReport();
  report.config.syntheticWsUsers = 0;
  report.syntheticWs = null;
  report.combined = { browserPages: 50, syntheticWsUsers: 0, totalSessions: 50, concurrent: false };
  const markdown = renderSummaryMarkdown(report);
  assert.doesNotMatch(markdown, /Synthetic WebSocket phase/);
  assert.doesNotMatch(markdown, /Synthetic WebSocket participants/);
  assert.match(markdown, /observed counts depend on the gallery layout/i);
});

test('encoded LiveKit join payloads are omitted from diagnostic text', () => {
  assert.equal(redactSecrets('ws://localhost/rtc?join_request=ENCODED&version=1'),
    'ws://localhost/rtc?join_request=[redacted]&version=1');
});

test('report writer creates JSON and Markdown files without tokens', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'media-load-report-'));
  try {
    const report = fakeReport();
    const files = writeReports(report, { outDir: root });
    assert.ok(existsSync(files.json));
    assert.ok(existsSync(files.markdown));
    const json = readFileSync(files.json, 'utf8');
    const saved = JSON.parse(json);
    assert.equal(saved.verdict.ok, true);
    assert.equal(saved.room.id, 'room-TEST');
    assert.ok(!json.includes('SECRET_TOKEN'));
    assert.match(readFileSync(files.markdown, 'utf8'), /Verdict: \*\*PASS\*\*/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
