#!/usr/bin/env node
/**
 * Reusable browser media load harness (puppeteer-core + Chrome fake media).
 *
 * Based on the working `.tmp/browser-load.mjs` 50-browser run: one room, one
 * admin-issued token per page, N headless pages joining `/embed.html`, then
 * per-page tile/video/playing/error snapshots and a JSON + Markdown report.
 *
 *   AGIL_ADMIN_KEY=... BASE_URL=https://pilot.example \
 *     node agil/core/qa/load/browser-media-load.mjs --users=50 --duration=60s
 *
 *   # no browser / no network / no admin key needed:
 *   node agil/core/qa/load/browser-media-load.mjs --dry-run --users=200
 *
 *   # 200 synthetic WS + 50 browser pages in one run:
 *   node agil/core/qa/load/browser-media-load.mjs --users=50 --duration=60s --synthetic-ws=200
 *
 * Safety: run only against a dedicated pilot host (see
 * `agil/core/docs/load-200-media.md`). The harness never writes tokens or the
 * admin key to stdout/stderr or report files.
 *
 * Exit codes: 0 pass, 1 verification failed, 2 usage error, 3 runtime/setup error.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repository root (agil/core/qa/load -> four levels up). */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
export const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'agil', 'core', 'qa', 'load', 'reports');
export const DEFAULT_WS_SCRIPT = path.join(REPO_ROOT, 'agil', 'core', 'qa', 'backend', 'load-ws.mjs');
export const DEFAULT_BASE_URL = 'http://localhost:8787';
/** The server caps group rooms at 200 seats (see large-rooms.md). */
export const MAX_BROWSER_USERS = 200;
export const MAX_SYNTHETIC_WS = 1000;
export const REPORT_VERSION = 2;

const VIEWPORT = { width: 1280, height: 720 };
const MAX_RECORDED_ERRORS = 100;
const MAX_SAMPLE_ROWS = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** CLI/validation error; main() maps it to exit code 2. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 2;
  }
}

export const USAGE = `Usage:
  node agil/core/qa/load/browser-media-load.mjs --users=50 --duration=60s [options]
  node agil/core/qa/load/browser-media-load.mjs --users=50 --duration=60s --synthetic-ws=200
  node agil/core/qa/load/browser-media-load.mjs --dry-run --users=200

Browser media load (puppeteer-core + fake camera/mic). One room per browser
phase, one admin token per page, all pages join /embed.html.

Options:
  --users=N             browser pages to launch and join (default 50, max ${MAX_BROWSER_USERS})
  --duration=D          steady-state window after join: 60, 90s, 2m, 1h (default 60s)
  --concurrency=N       pages joining at the same time (default min(10, users))
  --browsers=N          Chrome processes; pages are split evenly (default 1)
  --synthetic-ws[=N]    also run N (default 200) synthetic WebSocket participants
  --ws-script=PATH      WS load script (default agil/core/qa/backend/load-ws.mjs)
  --ws-hold=D           safety cap for the WS phase, stopped gracefully at the end
                        of the browser steady window (default join-timeout + duration + 120s)
  --join-timeout=D      max wait for all pages to join (default 180s)
  --poll-ms=N           readiness/steady poll interval in ms (default 2000)
  --rtc-stats           sample browser RTP counters and decoded video frames
  --camera-file=PATH    local Y4M fixture for the synthetic camera
  --base=URL            target origin (default $BASE_URL or ${DEFAULT_BASE_URL})
  --tenant=ID           tenant id (default demo)
  --theme=light|dark|auto  embed theme (default light)
  --chrome=PATH         Chrome/Edge binary (default $CHROME_PATH or an OS candidate)
  --headed              show Chrome windows (debug only)
  --out=DIR             report directory (default agil/core/qa/load/reports)
  --max-errors=N        tolerated page/console errors (default 0)
  --keep-room           keep the room after the run (debug only)
  --dry-run             validate and print the plan; no network, token or browser
  --quiet               suppress progress lines
  --help, -h            print this help

Environment:
  BASE_URL              target origin, e.g. https://pilot.example
  AGIL_ADMIN_KEY        admin API key (required for a real run)
  CHROME_PATH           Chrome/Edge binary

Exit codes: 0 pass, 1 verification failed, 2 usage error, 3 runtime/setup error.
Reports go to <out>/browser-media-<N>u-<timestamp>.json and .md (gitignored).
`;

function isEntrypoint() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const script = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? script.toLowerCase() === self.toLowerCase() : script === self;
}

/** Redacts known secret values and token-ish query/header fields. */
export function redactSecrets(input, secrets = []) {
  let text = typeof input === 'string' ? input : String(input ?? '');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    text = text.split(secret).join('[redacted]');
  }
  text = text.replace(/([?&#](?:token|identity_token|id_token|access_token|api_key|apikey|join_request)=)[^&#\s"'<>]*/gi, '$1[redacted]');
  text = text.replace(/(x-api-key\s*[:=]\s*)[^\s,;"']+/gi, '$1[redacted]');
  text = text.replace(/(authorization\s*:\s*bearer\s+)[^\s,;"']+/gi, '$1[redacted]');
  return text;
}

/** Parses `60`, `90s`, `2m`, `1h` (and `500ms`) into whole seconds. */
export function parseDuration(raw, label = '--duration') {
  const text = String(raw).trim();
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(text);
  if (!match) throw new UsageError(`${label} must be a duration like 60, 90s, 2m or 1h, got "${raw}".`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  const seconds = unit === 'ms' ? amount / 1000 : unit === 'm' ? amount * 60 : unit === 'h' ? amount * 3600 : amount;
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86_400) {
    throw new UsageError(`${label} must be between 0 and 24h, got "${raw}".`);
  }
  return Math.round(seconds);
}

function parseInteger(raw, label, min, max) {
  const text = String(raw).trim();
  if (!/^[+-]?\d+$/.test(text)) throw new UsageError(`${label} must be an integer, got "${raw}".`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new UsageError(`${label} must be between ${min} and ${max}, got ${raw}.`);
  }
  return value;
}

function normalizeBaseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new UsageError(`--base must be an absolute http(s) URL, got "${raw}".`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`--base must use http or https, got "${raw}".`);
  }
  if (url.username || url.password) throw new UsageError('--base must not contain credentials.');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new UsageError('--base must be an origin without a path, query or hash.');
  }
  return url.origin;
}

/** Pure argument parser (no network, no filesystem side effects). */
export function parseArgs(argv = [], env = process.env) {
  const config = {
    help: false,
    users: 50,
    durationSec: 60,
    concurrency: null,
    browsers: 1,
    syntheticWs: 0,
    wsScript: DEFAULT_WS_SCRIPT,
    wsHoldSec: null,
    joinTimeoutSec: 180,
    pollMs: 2000,
    baseUrl: env.BASE_URL ? String(env.BASE_URL).trim() : DEFAULT_BASE_URL,
    tenant: 'demo',
    theme: 'light',
    chromePath: env.CHROME_PATH ? path.resolve(env.CHROME_PATH) : '',
    rtcStats: false,
    cameraFile: '',
    headed: false,
    outDir: DEFAULT_OUT_DIR,
    keepRoom: false,
    dryRun: false,
    quiet: false,
    maxErrors: 0,
    runId: '',
  };
  const list = Array.from(argv);
  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (token === '-h' || token === '--help') {
      config.help = true;
      continue;
    }
    if (!token.startsWith('--')) {
      throw new UsageError(`Unexpected argument "${token}". Options start with --.`);
    }
    const eq = token.indexOf('=');
    const name = token.slice(2, eq === -1 ? token.length : eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const hasInline = inline !== undefined;
    const readValue = () => {
      if (hasInline) {
        if (inline === '') throw new UsageError(`--${name} requires a value.`);
        return inline;
      }
      const next = list[i + 1];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`--${name} requires a value.`);
      i += 1;
      return next;
    };
    const readBoolean = () => {
      if (!hasInline) return true;
      if (/^(true|1|yes|on)$/i.test(inline)) return true;
      if (/^(false|0|no|off)$/i.test(inline)) return false;
      throw new UsageError(`--${name} expects true or false, got "${inline}".`);
    };
    switch (name) {
      case 'users':
        config.users = parseInteger(readValue(), '--users', 1, MAX_BROWSER_USERS);
        break;
      case 'duration':
        config.durationSec = parseDuration(readValue(), '--duration');
        break;
      case 'concurrency':
        config.concurrency = parseInteger(readValue(), '--concurrency', 1, 256);
        break;
      case 'browsers':
        config.browsers = parseInteger(readValue(), '--browsers', 1, MAX_BROWSER_USERS);
        break;
      case 'synthetic-ws': {
        let raw;
        if (hasInline) raw = inline;
        else {
          const next = list[i + 1];
          if (next !== undefined && /^\d+$/.test(next)) {
            raw = next;
            i += 1;
          }
        }
        config.syntheticWs = raw === undefined || raw === ''
          ? 200
          : parseInteger(raw, '--synthetic-ws', 0, MAX_SYNTHETIC_WS);
        break;
      }
      case 'ws-script':
        config.wsScript = path.resolve(readValue());
        break;
      case 'ws-hold':
        config.wsHoldSec = parseDuration(readValue(), '--ws-hold');
        break;
      case 'join-timeout':
        config.joinTimeoutSec = parseDuration(readValue(), '--join-timeout');
        break;
      case 'poll-ms':
        config.pollMs = parseInteger(readValue(), '--poll-ms', 250, 60_000);
        break;
      case 'base':
      case 'base-url':
        config.baseUrl = normalizeBaseUrl(readValue());
        break;
      case 'tenant': {
        const tenant = readValue().trim();
        if (!tenant || tenant.length > 64) throw new UsageError('--tenant must be 1..64 characters.');
        config.tenant = tenant;
        break;
      }
      case 'theme': {
        const theme = readValue().toLowerCase();
        if (!['light', 'dark', 'auto'].includes(theme)) {
          throw new UsageError('--theme must be light, dark or auto.');
        }
        config.theme = theme;
        break;
      }
      case 'chrome':
        config.chromePath = path.resolve(readValue());
        break;
      case 'rtc-stats':
        config.rtcStats = readBoolean();
        break;
      case 'camera-file':
        config.cameraFile = path.resolve(readValue());
        break;
      case 'headed':
        config.headed = readBoolean();
        break;
      case 'out':
        config.outDir = path.resolve(readValue());
        break;
      case 'max-errors':
        config.maxErrors = parseInteger(readValue(), '--max-errors', 0, 100_000);
        break;
      case 'keep-room':
        config.keepRoom = readBoolean();
        break;
      case 'dry-run':
        config.dryRun = readBoolean();
        break;
      case 'quiet':
        config.quiet = readBoolean();
        break;
      default:
        throw new UsageError(`Unknown option --${name}. Run with --help for usage.`);
    }
  }

  if (!config.help) {
    config.baseUrl = normalizeBaseUrl(config.baseUrl);
    if (config.concurrency === null) config.concurrency = Math.min(10, config.users);
    if (config.concurrency < 1) throw new UsageError('--concurrency must be at least 1.');
    if (config.browsers > config.users) {
      throw new UsageError(`--browsers (${config.browsers}) cannot exceed --users (${config.users}).`);
    }
    if (config.joinTimeoutSec < 5) throw new UsageError('--join-timeout must be at least 5s.');
    if (config.syntheticWs > 0 && config.wsHoldSec !== null && config.wsHoldSec < 5) {
      throw new UsageError('--ws-hold must be at least 5s when set.');
    }
  }
  return config;
}

function windowsCandidates(env) {
  const roots = [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.LOCALAPPDATA,
  ].filter(Boolean);
  const relative = [
    'Google\\Chrome\\Application\\chrome.exe',
    'Google\\Chrome Beta\\Application\\chrome.exe',
    'Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return roots.flatMap((root) => relative.map((suffix) => path.join(root, suffix)));
}

/** Returns an existing Chrome/Edge binary path, or '' when none is found. */
export function detectChromePath(env = process.env) {
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        ...windowsCandidates(env),
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/snap/bin/chromium',
        ];
  return candidates.find((candidate) => existsSync(candidate)) ?? '';
}

/** Splits `users` across browser processes as evenly as possible. */
export function splitPages(users, browsers) {
  const base = Math.floor(users / browsers);
  const remainder = users % browsers;
  return Array.from({ length: browsers }, (_, index) => base + (index < remainder ? 1 : 0));
}

export function makeRunId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function wsReportPath(config) {
  return path.join(config.outDir, `synthetic-ws-${config.syntheticWs}-${config.runId}.json`);
}

function browserChromeArgs(cameraFile) {
  return [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    ...(cameraFile ? [`--use-file-for-fake-video-capture=${cameraFile}`] : []),
    '--autoplay-policy=no-user-gesture-required',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
  ];
}

/** Pure run plan used by --dry-run and by the real run for setup checks. */
export function buildPlan(config, { env = process.env } = {}) {
  const runId = config.runId || makeRunId();
  const chrome = config.chromePath || detectChromePath(env);
  const syntheticWs = config.syntheticWs > 0
    ? {
        users: config.syntheticWs,
        script: config.wsScript,
        scriptExists: existsSync(config.wsScript),
        stdinStop: true,
        holdSec: config.wsHoldSec ?? Math.max(300, config.joinTimeoutSec + config.durationSec + 120),
        reportPath: wsReportPath({ ...config, runId }),
        argv: [
          config.wsScript,
          `--users=${config.syntheticWs}`,
          `--duration=${Math.max(1, config.durationSec)}`,
          '--stdin-stop',
          `--hold=${config.wsHoldSec ?? Math.max(300, config.joinTimeoutSec + config.durationSec + 120)}`,
          `--out=${wsReportPath({ ...config, runId })}`,
        ],
      }
    : null;
  const warnings = [];
  if (config.users > 50 && config.browsers === 1) {
    warnings.push(`${config.users} pages in one Chrome process is beyond the validated 50-context profile; use --browsers=4 for 200.`);
  }
  if (config.browsers > 1 && config.users / config.browsers > 60) {
    warnings.push(`~${Math.ceil(config.users / config.browsers)} pages per Chrome process; the validated profile is <=50.`);
  }
  if (!chrome) {
    warnings.push('Chrome/Edge binary not found; set --chrome or CHROME_PATH before a real run.');
  } else if (!existsSync(chrome)) {
    warnings.push(`Chrome/Edge binary does not exist: ${chrome}`);
  }
  if (!env.AGIL_ADMIN_KEY) warnings.push('AGIL_ADMIN_KEY is not set; required for a real run.');
  if (config.syntheticWs > 0) {
    warnings.push('Combined run issues up to users + synthetic-ws tokens: keep AGIL_ADMIN_RATE_LIMIT_PER_MIN >= 600.');
  }
  if (config.keepRoom) {
    warnings.push('--keep-room is set: the room will NOT be deleted after the run.');
  }
  return {
    dryRun: config.dryRun,
    generatedAt: new Date().toISOString(),
    runId,
    target: config.baseUrl,
    plan: {
      room: {
        name: `QA media load ${config.users} users`,
        maxParticipantsRequested: config.users + 10,
        note: 'The server clamps group rooms to 200 seats (large-rooms.md).',
      },
      tokensToIssue: config.users,
      browser: {
        processes: config.browsers,
        pages: config.users,
        pagesPerBrowser: splitPages(config.users, config.browsers),
        headless: !config.headed,
        rtcStats: config.rtcStats,
        cameraFile: config.cameraFile || null,
        chrome: { path: chrome || null, exists: Boolean(chrome && existsSync(chrome)) },
      },
      syntheticWs,
      combinedSessions: config.users + config.syntheticWs,
      steadyWindowSec: config.durationSec,
      joinTimeoutSec: config.joinTimeoutSec,
      willCreateRoom: !config.dryRun,
      willLaunchBrowser: !config.dryRun,
      willDeleteRoom: !config.dryRun && !config.keepRoom,
    },
    warnings,
  };
}

function buildEmbedUrl(config, roomId, token, slot) {
  const params = new URLSearchParams({
    room: roomId,
    tenant: config.tenant,
    token,
    name: `Browser ${slot}`,
    theme: config.theme,
  });
  return `${config.baseUrl}/embed.html?${params.toString()}`;
}

function log(config, message) {
  if (!config.quiet) process.stderr.write(`[browser-media-load] ${message}\n`);
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function api(ctx, pathname, { method = 'GET', body, timeoutMs = 20_000, retries = 3 } = {}) {
  const url = `${ctx.config.baseUrl}${pathname}`;
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(ctx.apiKey ? { 'x-api-key': ctx.apiKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* keep text */
      }
      if ((response.status === 429 || response.status === 503) && attempt < retries) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 2000;
        log(ctx.config, `HTTP ${response.status} from ${pathname}; retrying in ${Math.min(delay, 15_000)}ms`);
        await sleep(Math.min(delay, 15_000));
        continue;
      }
      return { status: response.status, body: parsed, text };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`${method} ${pathname} timed out after ${timeoutMs}ms`);
      }
      if (attempt < retries) {
        log(ctx.config, `${method} ${pathname} failed (${redactSecrets(error.message, ctx.secrets)}); retrying`);
        await sleep((attempt + 1) * 2000);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function responseDetail(response) {
  const text = typeof response.text === 'string' ? response.text : '';
  return `${response.status} ${text.slice(0, 300)}`;
}

async function healthSnapshot(ctx) {
  try {
    const response = await api(ctx, '/v1/health', { timeoutMs: 8000, retries: 1 });
    return {
      status: response.status,
      rooms: typeof response.body === 'object' && response.body ? response.body.rooms : undefined,
      uptimeSec: typeof response.body === 'object' && response.body ? response.body.uptimeSec : undefined,
    };
  } catch (error) {
    return { error: redactSecrets(error.message, ctx.secrets) };
  }
}

function createReport(config, plan) {
  return {
    tool: 'browser-media-load',
    version: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    runId: config.runId || plan.runId,
    target: config.baseUrl,
    config: {
      users: config.users,
      durationSec: config.durationSec,
      concurrency: config.concurrency,
      browsers: config.browsers,
      tenant: config.tenant,
      theme: config.theme,
      headless: !config.headed,
      joinTimeoutSec: config.joinTimeoutSec,
      pollMs: config.pollMs,
      rtcStats: config.rtcStats,
      cameraFixture: config.cameraFile ? path.basename(config.cameraFile) : null,
      maxErrors: config.maxErrors,
      keepRoom: config.keepRoom,
      syntheticWsUsers: config.syntheticWs,
      wsHoldSec: plan.plan.syntheticWs?.holdSec ?? null,
      chromePath: plan.plan.browser.chrome.path,
      outDir: config.outDir,
    },
    room: null,
    health: {},
    tokens: { requested: config.users, issued: 0, failed: 0, latencyMs: null },
    browser: {
      processes: config.browsers,
      pagesLaunched: 0,
      pagesJoined: 0,
      expectedTilesPerPage: Math.min(2, config.users),
      stabilizedMs: null,
      elapsedMs: null,
      tiles: null,
      videos: null,
      playing: null,
      errorCount: 0,
      pageErrors: 0,
      consoleErrors: 0,
      errors: [],
      pages: [],
      timeline: [],
      steady: [],
      final: null,
    },
    syntheticWs: null,
    combined: {
      browserPages: config.users,
      syntheticWsUsers: config.syntheticWs,
      totalSessions: config.users + config.syntheticWs,
      concurrent: config.syntheticWs > 0,
    },
    cleanup: {},
    verdict: { ok: false, reasons: [] },
    fatalError: null,
  };
}

function recordError(ctx, entry, message) {
  const safe = redactSecrets(message, ctx.secrets).slice(0, 500);
  ctx.errorCount += 1;
  if (entry) entry.errors += 1;
  if (ctx.report.browser.errors.length < MAX_RECORDED_ERRORS) {
    ctx.report.browser.errors.push(safe);
  }
}

async function createRoom(ctx) {
  const name = `QA media load ${ctx.config.users} ${new Date().toISOString()}`;
  const response = await api(ctx, '/v1/admin/rooms', {
    method: 'POST',
    body: { name, maxParticipants: ctx.config.users + 10 },
    timeoutMs: 20_000,
  });
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`create room failed: ${responseDetail(response)}`);
  }
  const room = response.body?.room;
  if (!room?.id) throw new Error('create room failed: response has no room.id');
  ctx.roomId = room.id;
  ctx.report.room = {
    id: room.id,
    name: room.name ?? name,
    maxParticipants: room.maxParticipants,
    maxParticipantsRequested: ctx.config.users + 10,
    createdAt: room.createdAt ?? null,
    deleted: false,
    kept: false,
  };
  log(ctx.config, `room ${room.id} created (maxParticipants=${room.maxParticipants}, requested=${ctx.config.users + 10})`);
  return room;
}

async function issueTokens(ctx) {
  const tokens = [];
  const latencies = [];
  ctx.tokenLatencies = latencies;
  for (let index = 0; index < ctx.config.users; index += 1) {
    const started = Date.now();
    let response;
    try {
      response = await api(ctx, '/v1/tokens', {
        method: 'POST',
        body: {
          tenantId: ctx.config.tenant,
          roomId: ctx.roomId,
          participant: { name: `Browser ${index + 1}`, role: 'guest' },
        },
        timeoutMs: 20_000,
      });
    } catch (error) {
      ctx.report.tokens.failed += 1;
      throw new Error(`token ${index + 1}/${ctx.config.users} failed: ${redactSecrets(error.message, ctx.secrets)}`);
    }
    latencies.push(Date.now() - started);
    if (response.status !== 200 && response.status !== 201) {
      ctx.report.tokens.failed += 1;
      throw new Error(`token ${index + 1}/${ctx.config.users} failed: ${responseDetail(response)}`);
    }
    if (!response.body?.token) {
      ctx.report.tokens.failed += 1;
      throw new Error(`token ${index + 1}/${ctx.config.users} failed: response has no token`);
    }
    tokens.push(response.body.token);
    ctx.secrets.push(response.body.token);
    ctx.report.tokens.issued = tokens.length;
    if ((index + 1) % 25 === 0 || index + 1 === ctx.config.users) {
      log(ctx.config, `tokens ${tokens.length}/${ctx.config.users}`);
    }
  }
  ctx.report.tokens.latencyMs = summarizeNumbers(latencies);
  return tokens;
}

function summarizeNumbers(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    min: sorted[0],
    avg: Math.round(sum / values.length),
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted[sorted.length - 1],
  };
}

async function launchBrowsers(ctx) {
  const plan = ctx.plan;
  const chromePath = plan.plan.browser.chrome.path;
  if (!chromePath || !existsSync(chromePath)) {
    throw new Error(`Chrome/Edge binary not found${chromePath ? ` at ${chromePath}` : ''}; set --chrome or CHROME_PATH.`);
  }
  let puppeteer;
  try {
    puppeteer = (await import('puppeteer-core')).default;
  } catch (error) {
    throw new Error(`puppeteer-core is not installed: ${redactSecrets(error.message, ctx.secrets)}`);
  }
  if (ctx.config.cameraFile && !existsSync(ctx.config.cameraFile)) throw new Error('Synthetic camera file does not exist.');
  const args = browserChromeArgs(ctx.config.cameraFile);
  ctx.browsers = [];
  for (let index = 0; index < ctx.config.browsers; index += 1) {
    const browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: !ctx.config.headed,
      args,
      defaultViewport: VIEWPORT,
      protocolTimeout: 300_000,
    });
    ctx.browsers.push(browser);
    log(ctx.config, `browser ${index + 1}/${ctx.config.browsers} launched`);
  }
  return ctx.browsers;
}

async function pageSnapshot() {
  const root = document.querySelector('[data-agil-root]');
  const tiles = document.querySelectorAll('[data-agil-tile]');
  const videos = Array.from(document.querySelectorAll('video'));
  const playing = videos.filter((video) => !video.paused && video.readyState >= 2 && video.videoWidth > 0);
  const mediaBadge = root?.querySelector('.agil-media-mode');
  let rtc = null;
  if (window.qaLoadPeers) {
    const peers = [...window.qaLoadPeers].filter((peer) => peer.connectionState !== 'closed');
    const reports = await Promise.allSettled(peers.map((peer) => peer.getStats()));
    rtc = { connectedPeers: peers.filter((peer) => peer.connectionState === 'connected').length,
      reports: reports.filter((report) => report.status === 'fulfilled').length,
      outboundVideoPackets: 0, inboundVideoPackets: 0, decodedVideoFrames: 0 };
    for (const report of reports) {
      if (report.status !== 'fulfilled') continue;
      for (const stat of report.value.values()) {
        if ((stat.kind ?? stat.mediaType) !== 'video') continue;
        if (stat.type === 'outbound-rtp') rtc.outboundVideoPackets += stat.packetsSent ?? 0;
        if (stat.type === 'inbound-rtp') {
          rtc.inboundVideoPackets += stat.packetsReceived ?? 0;
          rtc.decodedVideoFrames += stat.framesDecoded ?? 0;
        }
      }
    }
  }
  let frames = 0;
  for (const video of videos) {
    try {
      frames += video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    } catch {
      /* not all engines expose it */
    }
  }
  return {
    state: root?.getAttribute('data-state') ?? null,
    connection: root?.getAttribute('data-agil-connection') ?? null,
    mediaMode: mediaBadge?.getAttribute('data-mode') ?? null,
    sfuStatus: mediaBadge?.getAttribute('data-status') ?? null,
    rtc,
    tiles: tiles.length,
    selfTiles: document.querySelectorAll('[data-agil-tile][data-self="true"]').length,
    remoteTiles: document.querySelectorAll('[data-agil-tile][data-self="false"]').length,
    videos: videos.length,
    playing: playing.length,
    remotePlaying: playing.filter((video) => video.closest('[data-agil-tile][data-self="false"]')).length,
    paused: videos.filter((video) => video.paused).length,
    audio: document.querySelectorAll('audio').length,
    frames,
    maxWidth: videos.reduce((max, video) => Math.max(max, video.videoWidth || 0), 0),
    maxHeight: videos.reduce((max, video) => Math.max(max, video.videoHeight || 0), 0),
  };
}

async function joinPage(ctx, slot, token) {
  const browser = ctx.browsers[slot.browserIndex];
  const page = await browser.newPage();
  const entry = {
    index: slot.index,
    browser: slot.browserIndex,
    page,
    launched: true,
    joined: false,
    joinedAtMs: null,
    errors: 0,
    last: null,
    evalErrorReported: false,
  };
  ctx.pages.push(entry);
  ctx.report.browser.pagesLaunched = ctx.pages.length;
  page.on('pageerror', (error) => {
    ctx.report.browser.pageErrors += 1;
    recordError(ctx, entry, `page ${entry.index + 1} pageerror: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    ctx.report.browser.consoleErrors += 1;
    recordError(ctx, entry, `page ${entry.index + 1} console: ${message.text()}`);
  });
  page.on('crash', () => {
    ctx.report.browser.pageErrors += 1;
    recordError(ctx, entry, `page ${entry.index + 1}: renderer crashed`);
  });
  await page.setViewport(VIEWPORT);
  if (ctx.config.rtcStats) await page.evaluateOnNewDocument(() => {
    window.qaLoadPeers = new Set();
    const PeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends PeerConnection {
      constructor(...args) {
        super(...args);
        window.qaLoadPeers.add(this);
      }
      close() {
        window.qaLoadPeers.delete(this);
        return super.close();
      }
    };
  });
  try {
    await page.goto(buildEmbedUrl(ctx.config, ctx.roomId, token, entry.index + 1), {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
  } catch (error) {
    ctx.report.browser.pageErrors += 1;
    recordError(ctx, entry, `page ${entry.index + 1} navigation: ${error.message}`);
    try {
      await page.close();
    } catch {
      /* ignore */
    }
    entry.page = null;
  }
  return entry;
}

async function joinAllPages(ctx, tokens) {
  // Round-robin so concurrent workers spread across all browser processes
  // instead of filling browser 1 first; the per-browser totals still match
  // splitPages().
  const slots = Array.from({ length: ctx.config.users }, (_, index) => ({
    index,
    browserIndex: index % ctx.config.browsers,
  }));
  let cursor = 0;
  const workerCount = Math.min(ctx.config.concurrency, slots.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const next = cursor;
      cursor += 1;
      if (next >= slots.length) return;
      const slot = slots[next];
      try {
        await joinPage(ctx, slot, tokens[slot.index]);
        if ((next + 1) % 10 === 0 || next + 1 === slots.length) {
          log(ctx.config, `pages opened ${next + 1}/${slots.length}`);
        }
      } catch (error) {
        ctx.report.browser.pageErrors += 1;
        ctx.report.browser.errors.push(
          redactSecrets(`page ${slot.index + 1} launch failed: ${error.message}`, ctx.secrets).slice(0, 500),
        );
        ctx.errorCount += 1;
      }
    }
  });
  await Promise.all(workers);
  ctx.pages.sort((a, b) => a.index - b.index);
  ctx.report.browser.pagesLaunched = ctx.pages.length;
  log(ctx.config, `pages launched ${ctx.pages.length}/${ctx.config.users}`);
}

async function snapshotEntry(ctx, entry) {
  if (!entry.page) return { index: entry.index, missing: true };
  try {
    const snapshot = await withTimeout(entry.page.evaluate(pageSnapshot), 15_000, `page ${entry.index + 1} snapshot`);
    return { index: entry.index, ...snapshot };
  } catch (error) {
    if (!entry.evalErrorReported) {
      entry.evalErrorReported = true;
      ctx.report.browser.pageErrors += 1;
      recordError(ctx, entry, `page ${entry.index + 1} snapshot: ${error.message}`);
    }
    return { index: entry.index, error: true };
  }
}

async function snapshotAll(ctx) {
  const snapshots = new Array(ctx.pages.length);
  const batchSize = 25;
  for (let start = 0; start < ctx.pages.length; start += batchSize) {
    const batch = ctx.pages.slice(start, start + batchSize);
    await Promise.all(
      batch.map(async (entry, offset) => {
        snapshots[start + offset] = await snapshotEntry(ctx, entry);
      }),
    );
  }
  return snapshots;
}

function snapshotReady(ctx, snapshot) {
  if (!snapshot || snapshot.missing || snapshot.error) return false;
  return snapshot.tiles >= ctx.report.browser.expectedTilesPerPage || snapshot.state === 'joined';
}

function applySnapshots(ctx, snapshots) {
  const byIndex = new Map(snapshots.map((snapshot) => [snapshot.index, snapshot]));
  for (const entry of ctx.pages) {
    const snapshot = byIndex.get(entry.index);
    if (!snapshot) continue;
    entry.last = snapshot;
    if (!entry.joined && snapshotReady(ctx, snapshot)) {
      entry.joined = true;
      entry.joinedAtMs = Date.now() - ctx.startedAt;
    }
  }
  ctx.report.browser.pagesJoined = ctx.pages.filter((entry) => entry.joined).length;
}

function mediaStages(snapshots) {
  const measured = snapshots.filter((snapshot) => snapshot.rtc?.reports > 0);
  return {
    sfuConnected: snapshots.filter((snapshot) => snapshot.sfuStatus === 'connected').length,
    sfuExpected: snapshots.filter((snapshot) => snapshot.mediaMode === 'sfu' || snapshot.mediaMode === 'broadcast').length,
    ...(snapshots.some((snapshot) => snapshot.rtc) ? { rtcMeasured: measured.length,
      sendingVideo: measured.filter((snapshot) => snapshot.rtc.outboundVideoPackets > 0).length,
      receivingVideo: measured.filter((snapshot) => snapshot.rtc.inboundVideoPackets > 0).length,
      decodingVideo: measured.filter((snapshot) => snapshot.rtc.decodedVideoFrames > 0).length } : {}),
  };
}

function aggregateSnapshots(ctx, snapshots) {
  const usable = snapshots.filter((snapshot) => !snapshot.missing && !snapshot.error);
  const tiles = usable.map((snapshot) => snapshot.tiles);
  const playing = usable.map((snapshot) => snapshot.playing);
  return {
    pages: snapshots.length,
    reporting: usable.length,
    joined: usable.filter((snapshot) => snapshotReady(ctx, snapshot)).length,
    tilesMin: tiles.length ? Math.min(...tiles) : -1,
    tilesMax: tiles.length ? Math.max(...tiles) : -1,
    videosTotal: usable.reduce((total, snapshot) => total + snapshot.videos, 0),
    playingMin: playing.length ? Math.min(...playing) : -1,
    playingMax: playing.length ? Math.max(...playing) : -1,
    playingTotal: playing.reduce((total, value) => total + value, 0),
    playingPages: playing.filter((value) => value > 0).length,
    remotePlayingPages: usable.filter((snapshot) => snapshot.remotePlaying > 0).length,
    mediaStages: mediaStages(usable),
    errors: ctx.errorCount,
  };
}

async function waitForJoin(ctx) {
  const started = Date.now();
  const deadline = started + ctx.config.joinTimeoutSec * 1000;
  let lastLog = -5000;
  let joined = 0;
  if (!ctx.pages.some((entry) => entry.page)) {
    log(ctx.config, 'no page could be opened; skipping the join wait');
  } else {
    while (true) {
      const snapshots = await snapshotAll(ctx);
      applySnapshots(ctx, snapshots);
      joined = ctx.report.browser.pagesJoined;
      const elapsed = Date.now() - started;
      ctx.report.browser.timeline.push({ elapsedMs: elapsed, ...aggregateSnapshots(ctx, snapshots) });
      if (ctx.report.browser.timeline.length > 120) ctx.report.browser.timeline.splice(1, 1);
      if (elapsed - lastLog >= 5000) {
        lastLog = elapsed;
        log(ctx.config, `joined ${joined}/${ctx.config.users} (${Math.round(elapsed / 1000)}s)`);
      }
      if (joined >= ctx.config.users || Date.now() >= deadline) break;
      await sleep(Math.min(ctx.config.pollMs, Math.max(250, deadline - Date.now())));
    }
  }
  ctx.report.browser.stabilizedMs = joined >= ctx.config.users ? Date.now() - started : null;
  if (joined < ctx.config.users) {
    log(ctx.config, `join timeout: ${joined}/${ctx.config.users} pages ready after ${Math.round((Date.now() - started) / 1000)}s`);
  } else {
    log(ctx.config, `all ${ctx.config.users} pages joined in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
}

async function steadyPhase(ctx) {
  const durationMs = ctx.config.durationSec * 1000;
  const steadyStarted = Date.now();
  const samples = ctx.report.browser.steady;
  if (durationMs <= 0) {
    const snapshots = await snapshotAll(ctx);
    applySnapshots(ctx, snapshots);
    samples.push({ elapsedMs: 0, ...aggregateSnapshots(ctx, snapshots) });
    return;
  }
  while (true) {
    const elapsed = Date.now() - steadyStarted;
    if (elapsed >= durationMs) break;
    await sleep(Math.min(ctx.config.pollMs, durationMs - elapsed));
    const snapshots = await snapshotAll(ctx);
    applySnapshots(ctx, snapshots);
    samples.push({ elapsedMs: Date.now() - steadyStarted, ...aggregateSnapshots(ctx, snapshots) });
    if (samples.length > MAX_SAMPLE_ROWS) samples.splice(1, 1);
  }
  log(
    ctx.config,
    `steady ${ctx.config.durationSec}s: ${ctx.report.browser.pagesJoined}/${ctx.config.users} joined, ` +
      `playing pages ${samples.at(-1)?.playingPages ?? 0}`,
  );
}

function pageReport(entry) {
  const last = entry.last ?? {};
  return {
    index: entry.index + 1,
    browser: entry.browser + 1,
    launched: Boolean(entry.launched),
    joined: Boolean(entry.joined),
    joinedAtMs: entry.joinedAtMs,
    state: last.state ?? null,
    connection: last.connection ?? null,
    mediaMode: last.mediaMode ?? null,
    sfuStatus: last.sfuStatus ?? null,
    rtc: last.rtc ?? null,
    tiles: last.tiles ?? -1,
    videos: last.videos ?? -1,
    playing: last.playing ?? -1,
    remotePlaying: last.remotePlaying ?? -1,
    paused: last.paused ?? -1,
    audio: last.audio ?? -1,
    frames: last.frames ?? -1,
    errors: entry.errors,
  };
}

function numericStats(values) {
  if (!values.length) return { min: -1, max: -1, avg: -1, total: 0 };
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(2)),
    total: values.reduce((total, value) => total + value, 0),
  };
}

async function closeBrowsers(ctx) {
  if (ctx.closed) return;
  ctx.closed = true;
  for (const entry of ctx.pages) {
    if (!entry.page) continue;
    try {
      await withTimeout(entry.page.close(), 10_000, `page ${entry.index + 1} close`);
    } catch {
      /* ignore */
    }
    entry.page = null;
  }
  for (const browser of ctx.browsers) {
    try {
      await withTimeout(browser.close(), 20_000, 'browser close');
    } catch {
      try {
        browser.process()?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
  ctx.browsers = [];
}

function parseJsonObject(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function startSyntheticWs(ctx) {
  const plan = ctx.plan.plan.syntheticWs;
  const child = spawn(process.execPath, plan.argv, {
    cwd: REPO_ROOT,
    env: { ...process.env, BASE_URL: ctx.config.baseUrl, AGIL_ADMIN_KEY: ctx.apiKey },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const state = {
    users: plan.users,
    child,
    stdout: '',
    stderr: '',
    exitCode: null,
    spawnError: null,
    reportPath: plan.reportPath,
    summary: null,
    ok: false,
    stopped: false,
  };
  child.stdout.on('data', (chunk) => {
    if (state.stdout.length < 262_144) state.stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    if (state.stderr.length < 262_144) state.stderr += chunk.toString();
  });
  child.on('exit', (code) => {
    state.exitCode = code;
  });
  child.on('error', (error) => {
    state.spawnError = redactSecrets(error.message, ctx.secrets);
  });
  ctx.ws = state;
  log(ctx.config, `synthetic WS ${state.users} users started (pid ${child.pid ?? '?'})`);
  return state;
}

async function stopSyntheticWs(ctx) {
  const ws = ctx.ws;
  if (!ws || ws.stopped) return;
  ws.stopped = true;
  if (ws.child.exitCode === null) {
    try {
      ws.child.stdin.write('close\n');
      ws.child.stdin.end();
    } catch {
      /* already gone */
    }
    let exited = await waitForExit(ws.child, 30_000);
    if (!exited) {
      try {
        ws.child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      exited = await waitForExit(ws.child, 10_000);
    }
    if (!exited) {
      try {
        ws.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      await waitForExit(ws.child, 5000);
    }
  }
  let summary = parseJsonObject(ws.stdout);
  if (!summary && existsSync(ws.reportPath)) {
    try {
      summary = JSON.parse(readFileSync(ws.reportPath, 'utf8'));
    } catch {
      summary = null;
    }
  }
  const welcome = summary?.sockets?.welcome ?? null;
  const wsErrors = Array.isArray(summary?.sockets?.errors) ? summary.sockets.errors : [];
  ws.summary = summary;
  ws.ok = !ws.spawnError && ws.exitCode === 0 && welcome === ws.users && wsErrors.length === 0;
  ctx.report.syntheticWs = {
    users: ws.users,
    exitCode: ws.exitCode,
    ok: ws.ok,
    reportPath: existsSync(ws.reportPath) ? ws.reportPath : null,
    summary,
    stderrTail: ws.stderr
      ? redactSecrets(ws.stderr.trim().slice(-2000), ctx.secrets)
      : '',
  };
  log(ctx.config, `synthetic WS finished: exit=${ws.exitCode}, welcome=${welcome}/${ws.users}, errors=${wsErrors.length}`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

async function cleanupRoom(ctx) {
  if (ctx.roomCleaned) return ctx.report.cleanup.roomDeletion ?? null;
  ctx.roomCleaned = true;
  if (!ctx.roomId) {
    ctx.report.cleanup.roomDeletion = { attempted: false };
    return null;
  }
  if (ctx.config.keepRoom) {
    ctx.report.room.kept = true;
    ctx.report.cleanup.roomDeletion = { attempted: false, kept: true, roomId: ctx.roomId };
    log(ctx.config, `room ${ctx.roomId} kept (--keep-room)`);
    return null;
  }
  try {
    const response = await api(ctx, `/v1/admin/rooms/${encodeURIComponent(ctx.roomId)}`, {
      method: 'DELETE',
      timeoutMs: 15_000,
      retries: 2,
    });
    const deleted = response.status === 200 || response.status === 204 || response.status === 404;
    let verified = response.status === 404;
    if (deleted && !verified) {
      const check = await api(ctx, `/v1/admin/rooms/${encodeURIComponent(ctx.roomId)}`, {
        timeoutMs: 10_000,
        retries: 1,
      });
      verified = check.status === 404;
    }
    ctx.report.room.deleted = deleted;
    ctx.report.cleanup.roomDeletion = { attempted: true, status: response.status, deleted, verified };
    log(ctx.config, `room ${ctx.roomId} deleted=${deleted} verified=${verified}`);
  } catch (error) {
    ctx.report.cleanup.roomDeletion = {
      attempted: true,
      deleted: false,
      verified: false,
      error: redactSecrets(error.message, ctx.secrets),
    };
    log(ctx.config, `room cleanup failed: ${redactSecrets(error.message, ctx.secrets)}`);
  }
  return ctx.report.cleanup.roomDeletion;
}

function finalizeReport(ctx, fatalError) {
  const report = ctx.report;
  const config = ctx.config;
  const pages = ctx.pages.map(pageReport);
  report.browser.pages = pages;
  const finalSnapshots = pages.filter((page) => page.launched && page.tiles >= 0);
  const tiles = finalSnapshots.map((page) => page.tiles);
  const videos = finalSnapshots.map((page) => page.videos);
  const playing = finalSnapshots.map((page) => page.playing);
  report.browser.tiles = numericStats(tiles);
  report.browser.videos = numericStats(videos);
  report.browser.playing = {
    ...numericStats(playing),
    pagesWithPlaying: playing.filter((value) => value > 0).length,
    pagesWithTwoPlaying: playing.filter((value) => value >= 2).length,
  };
  const remote = finalSnapshots.map((page) => page.remotePlaying);
  report.browser.remotePlaying = {
    ...numericStats(remote),
    pagesWithRemotePlaying: remote.filter((value) => value > 0).length,
  };
  report.browser.mediaModes = Object.fromEntries(['mesh', 'sfu', 'broadcast'].map((mode) =>
    [mode, finalSnapshots.filter((page) => page.mediaMode === mode).length]));
  report.browser.mediaStages = mediaStages(finalSnapshots);
  report.browser.final = report.browser.steady.at(-1) ?? null;
  report.browser.pagesJoined = pages.filter((page) => page.joined).length;
  report.browser.pagesLaunched = pages.filter((page) => page.launched).length;
  report.browser.elapsedMs = Date.now() - ctx.startedAt;
  report.tokens.latencyMs = summarizeNumbers(ctx.tokenLatencies ?? []);
  report.tokens.issued = ctx.tokensIssued ?? report.tokens.issued;
  report.browser.errorCount = ctx.errorCount;
  if (fatalError) {
    report.fatalError = {
      name: fatalError.name ?? 'Error',
      message: redactSecrets(fatalError.message ?? String(fatalError), ctx.secrets).slice(0, 1000),
    };
  }

  const reasons = [];
  if (fatalError) reasons.push(`fatal: ${report.fatalError.message}`);
  if (!fatalError) {
    if (report.tokens.issued !== config.users) {
      reasons.push(`tokens issued ${report.tokens.issued}/${config.users}`);
    }
    if (report.browser.pagesLaunched !== config.users) {
      reasons.push(`pages launched ${report.browser.pagesLaunched}/${config.users}`);
    }
    if (report.browser.pagesJoined !== config.users) {
      reasons.push(`pages joined ${report.browser.pagesJoined}/${config.users}`);
    }
    if ((report.browser.playing?.pagesWithPlaying ?? 0) !== config.users) {
      reasons.push(`pages with playing video ${report.browser.playing?.pagesWithPlaying ?? 0}/${config.users}`);
    }
    if (config.users > 1 && report.browser.remotePlaying.pagesWithRemotePlaying !== config.users) {
      reasons.push(`pages with playing remote video ${report.browser.remotePlaying.pagesWithRemotePlaying}/${config.users}`);
    }
    if (ctx.errorCount > config.maxErrors) {
      reasons.push(`page/console errors ${ctx.errorCount} > --max-errors=${config.maxErrors}`);
    }
    if (config.syntheticWs > 0 && !report.syntheticWs?.ok) {
      reasons.push('synthetic WS phase failed');
    }
    const deletion = report.cleanup.roomDeletion;
    if (deletion?.attempted && !deletion.deleted) {
      reasons.push('room was not deleted');
    }
  }
  report.verdict = { ok: reasons.length === 0, reasons };
  return report;
}

function formatSeconds(seconds) {
  if (seconds === null || seconds === undefined) return 'n/a';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** Markdown summary; also written next to the JSON report. */
export function renderSummaryMarkdown(report) {
  const verdict = report.verdict?.ok ? 'PASS' : 'FAIL';
  const lines = [];
  lines.push(`# Browser media load — ${report.config.users} browser pages`);
  lines.push('');
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Target: ${report.target}`);
  lines.push(`- Room: ${report.room?.id ?? 'not created'} (maxParticipants=${report.room?.maxParticipants ?? 'n/a'})`);
  lines.push(`- Steady window: ${formatSeconds(report.config.durationSec)}; browsers: ${report.config.browsers}; concurrency: ${report.config.concurrency}`);
  if (report.config.syntheticWsUsers > 0) {
    lines.push(`- Synthetic WS: ${report.config.syntheticWsUsers} participants (combined ${report.combined.totalSessions} sessions)`);
  }
  lines.push(`- Verdict: **${verdict}**${report.verdict?.reasons?.length ? ` — ${report.verdict.reasons.join('; ')}` : ''}`);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Tokens issued | ${report.tokens.issued}/${report.tokens.requested} |`);
  lines.push(`| Pages launched | ${report.browser.pagesLaunched}/${report.config.users} |`);
  lines.push(`| Pages joined | ${report.browser.pagesJoined}/${report.config.users} |`);
  lines.push(`| Tiles per page min/max/avg | ${report.browser.tiles?.min ?? -1} / ${report.browser.tiles?.max ?? -1} / ${report.browser.tiles?.avg ?? -1} |`);
  lines.push(`| Videos per page min/max/avg | ${report.browser.videos?.min ?? -1} / ${report.browser.videos?.max ?? -1} / ${report.browser.videos?.avg ?? -1} |`);
  lines.push(`| Playing videos per page min/max | ${report.browser.playing?.min ?? -1} / ${report.browser.playing?.max ?? -1} |`);
  lines.push(`| Pages with a playing video | ${report.browser.playing?.pagesWithPlaying ?? 0}/${report.config.users} |`);
  lines.push(`| Pages with 2+ playing videos | ${report.browser.playing?.pagesWithTwoPlaying ?? 0}/${report.config.users} |`);
  lines.push(`| Pages with a playing remote video | ${report.browser.remotePlaying ? `${report.browser.remotePlaying.pagesWithRemotePlaying}/${report.config.users}` : 'not measured'} |`);
  if (report.browser.mediaModes) {
    const modes = Object.entries(report.browser.mediaModes).map(([mode, count]) => `${mode}: ${count}`);
    lines.push(`| Media modes | ${modes.join(', ')} |`);
  }
  const stages = report.browser.mediaStages;
  if (stages?.sfuExpected) lines.push(`| SFU connected | ${stages.sfuConnected}/${stages.sfuExpected} |`);
  if (stages?.rtcMeasured !== undefined) {
    lines.push(`| Pages with RTC stats | ${stages.rtcMeasured}/${report.config.users} |`);
    lines.push(`| Pages with video RTP sent / received / decoded | ${stages.sendingVideo} / ${stages.receivingVideo} / ${stages.decodingVideo} |`);
  }
  lines.push(`| Page/console errors | ${report.browser.errorCount} |`);
  lines.push(`| Stabilization | ${report.browser.stabilizedMs === null ? 'join timeout' : `${(report.browser.stabilizedMs / 1000).toFixed(1)}s`} |`);
  lines.push(`| Room deleted | ${report.cleanup.roomDeletion?.deleted ? `yes (verified=${report.cleanup.roomDeletion.verified})` : report.config.keepRoom ? 'no (--keep-room)' : 'no'} |`);
  lines.push('');
  if (report.syntheticWs) {
    lines.push('## Synthetic WebSocket phase');
    lines.push('');
    const ws = report.syntheticWs.summary ?? {};
    lines.push('| Metric | Value |');
    lines.push('|---|---|');
    lines.push(`| Users | ${report.syntheticWs.users} |`);
    lines.push(`| Welcome | ${ws.sockets?.welcome ?? 'n/a'}/${report.syntheticWs.users} |`);
    lines.push(`| Socket errors | ${(ws.sockets?.errors ?? []).length} |`);
    lines.push(`| Presence joined/steady | ${(ws.presence ?? []).map((row) => row.welcome).join(' / ') || 'n/a'} |`);
    lines.push(`| Exit code | ${report.syntheticWs.exitCode} |`);
    lines.push('');
  }
  if (report.fatalError) {
    lines.push('## Fatal error');
    lines.push('');
    lines.push('```');
    lines.push(report.fatalError.message);
    lines.push('```');
    lines.push('');
  }
  lines.push('## Interpretation');
  lines.push('');
  lines.push('- Remote playback is counted separately from the local preview. In a multi-user run, the final sample must show a playing remote video on every page to pass.');
  lines.push('- The observed counts depend on the gallery layout and media subscription budget. These measurements cover the streams playing in the sampled view.');
  if (report.config.syntheticWsUsers > 0) {
    lines.push('- Synthetic WebSocket participants prove signaling/presence only; they carry no audio or video.');
  }
  lines.push(`- Reports: \`${report.reportFiles?.json ?? 'n/a'}\`, \`${report.reportFiles?.markdown ?? 'n/a'}\``);
  lines.push('');
  return lines.join('\n');
}

async function run(config, env) {
  const apiKey = env.AGIL_ADMIN_KEY || '';
  if (!apiKey) {
    process.stderr.write('[browser-media-load] AGIL_ADMIN_KEY is required for a real run (use --dry-run to validate without it).\n');
    return 3;
  }
  config.runId = config.runId || makeRunId();
  const plan = buildPlan(config, { env });
  for (const warning of plan.warnings) log(config, `warning: ${warning}`);
  if (config.syntheticWs > 0 && !plan.plan.syntheticWs?.scriptExists) {
    process.stderr.write(`[browser-media-load] WS load script not found: ${config.wsScript}\n`);
    return 3;
  }
  if (!plan.plan.browser.chrome.path || !plan.plan.browser.chrome.exists) {
    process.stderr.write(
      `[browser-media-load] Chrome/Edge binary not found${plan.plan.browser.chrome.path ? `: ${plan.plan.browser.chrome.path}` : ''}; set --chrome or CHROME_PATH.\n`,
    );
    return 3;
  }
  const report = createReport(config, plan);
  const ctx = {
    config,
    apiKey,
    plan,
    report,
    secrets: [],
    startedAt: Date.now(),
    roomId: null,
    roomCleaned: false,
    closed: false,
    pages: [],
    browsers: [],
    ws: null,
    errorCount: 0,
    tokenLatencies: [],
  };
  ctx.secrets.push(apiKey);
  let fatalError = null;
  try {
    mkdirSync(config.outDir, { recursive: true });
    report.health.before = await healthSnapshot(ctx);
    await createRoom(ctx);
    const tokens = await issueTokens(ctx);
    ctx.tokensIssued = tokens.length;
    if (config.syntheticWs > 0) startSyntheticWs(ctx);
    await launchBrowsers(ctx);
    await joinAllPages(ctx, tokens);
    await waitForJoin(ctx);
    if (ctx.pages.some((entry) => entry.page)) {
      await steadyPhase(ctx);
    } else {
      log(config, 'no page to sample; skipping the steady window');
    }
    report.health.during = await healthSnapshot(ctx);
    await stopSyntheticWs(ctx);
    await closeBrowsers(ctx);
    report.health.after = await healthSnapshot(ctx);
    await cleanupRoom(ctx);
  } catch (error) {
    fatalError = error;
    log(config, `fatal: ${redactSecrets(error.message, ctx.secrets)}`);
  } finally {
    try {
      await stopSyntheticWs(ctx);
    } catch (error) {
      log(config, `WS cleanup failed: ${redactSecrets(error.message, ctx.secrets)}`);
    }
    try {
      await closeBrowsers(ctx);
    } catch (error) {
      log(config, `browser cleanup failed: ${redactSecrets(error.message, ctx.secrets)}`);
    }
    try {
      await cleanupRoom(ctx);
    } catch (error) {
      log(config, `room cleanup failed: ${redactSecrets(error.message, ctx.secrets)}`);
    }
  }
  finalizeReport(ctx, fatalError);
  writeReports(report, config);
  printSummary(report, config);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.verdict.ok ? 0 : fatalError ? 3 : 1;
}

/** Writes `<out>/browser-media-<N>u-<runId>.json` and `.md`; returns both paths. */
export function writeReports(report, config) {
  mkdirSync(config.outDir, { recursive: true });
  const base = path.join(config.outDir, `browser-media-${report.config.users}u-${report.runId}`);
  report.reportFiles = { json: `${base}.json`, markdown: `${base}.md` };
  writeFileSync(report.reportFiles.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(report.reportFiles.markdown, `${renderSummaryMarkdown(report)}\n`, 'utf8');
  return report.reportFiles;
}

function printSummary(report, config) {
  if (config.quiet) return;
  const videoPages = config.users > 1
    ? `${report.browser.remotePlaying?.pagesWithRemotePlaying ?? 0}/${config.users} with playing remote video`
    : `${report.browser.playing?.pagesWithPlaying ?? 0}/${config.users} with playing video`;
  process.stderr.write(
    `[browser-media-load] ${report.verdict.ok ? 'PASS' : 'FAIL'}: ` +
      `${report.browser.pagesJoined}/${config.users} joined, ` +
      `${videoPages}, ` +
      `${report.browser.errorCount} errors, room deleted=${report.cleanup.roomDeletion?.deleted ?? false}\n`,
  );
  if (report.reportFiles) {
    process.stderr.write(`[browser-media-load] report: ${report.reportFiles.json}\n`);
    process.stderr.write(`[browser-media-load] summary: ${report.reportFiles.markdown}\n`);
  }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let config;
  try {
    config = parseArgs(argv, env);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`[browser-media-load] ${error.message}\n`);
      process.stderr.write('Run with --help for usage.\n');
      return 2;
    }
    throw error;
  }
  if (config.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (config.dryRun) {
    const plan = buildPlan(config, { env });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    if (!config.quiet) {
      const pages = plan.plan.browser.pagesPerBrowser.join('+');
      process.stderr.write(
        `[browser-media-load] dry run: ${plan.plan.browser.pages} pages across ${plan.plan.browser.processes} browser(s) [${pages}], ` +
          `room maxParticipants=${plan.plan.room.maxParticipantsRequested}, ` +
          `syntheticWs=${plan.plan.syntheticWs?.users ?? 0}; no browser, token or network call issued.\n`,
      );
      for (const warning of plan.warnings) process.stderr.write(`[browser-media-load] warning: ${warning}\n`);
    }
    return 0;
  }
  return run(config, env);
}

if (isEntrypoint()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`[browser-media-load] unexpected failure: ${error?.message ?? error}\n`);
      process.exitCode = 3;
    });
}
